'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Energy Profile Monitor
   -----------------------------------------------------------
   Specific-energy state monitor for every airborne aircraft.

   Total Specific Energy Height (ft) is a single scalar that
   captures BOTH altitude and kinetic energy:
       Es = h + V_TAS^2 / (2g)
   with V_TAS in ft/s and g = 32.174 ft/s^2. It says how high
   the aircraft *would* be if it traded all its kinetic energy
   for altitude. Pilots fly Es, not h.

   Specific Excess Power (Ps, also "TE rate") in ft/min:
       Ps = dh/dt + (V/g) * dV/dt
   We don't have dV/dt directly from ADS-B, so we approximate
   Ps ≈ vertRate (fpm) + windAccel correction = vertRate when
   speed steady. Vertical rate alone underestimates true Ps
   during accelerate-while-climb, but is correct to first order.

   Phase classification (no FMS, derived from kinematics):
     CLIMB     vertRate >  +400 fpm
     DESCENT   vertRate <  -400 fpm
     CRUISE    |vertRate| <= 400 fpm  AND  altFt >= 18000
     LEVEL-LO  |vertRate| <= 400 fpm  AND  altFt <  18000

   Per-class ICAO climb-gradient targets (ft/nm = percent*60.76):
     HVY 2.4% ~ 146 ft/nm
     NRW 3.0% ~ 182
     RGN 3.5% ~ 213
     BIZ 4.0% ~ 243
     TBP 2.8% ~ 170
     GA  5.0% ~ 304
     FTR 8.0% ~ 486
     HEL 3.5% ~ 213
   Target descent profile = 3.0° = 5.24% = 318 ft/nm.

   For each aircraft we compute:
     - V_TAS (kts) from velocity (GS) corrected by altitude via
       TAS/GS proxy from ISA density ratio (cheap and good)
     - kineticH_ft = V_TAS_fps^2 / (2g)
     - Es_ft = altFt + kineticH_ft
     - actualGrad_ftPerNm = (vertRate/60) * 60 / V_TAS = vertRate / V_TAS
       (vertRate is fpm, V_TAS is nm per hour, so the conversion
       collapses to actualGrad = vertRate / V_TAS_kts * 60 ft/nm)
     - target gradient by phase + class
     - deltaGrad = actualGrad - targetGrad (signed)
     - excess Ps (ft/min) = vertRate + V_TAS_fpm * (Vtas/Vref - 1) * 0.1
       (small term: rewards aircraft that are above optimum speed)

   Energy classification (4 tiers):
     LOW-ENERGY   Es deficit vs reference >= 6000 ft   (rose)
                  → too slow AND too low for phase
     STABLE       within ±2500 ft of reference, phase ok   (sky)
     HOT-HIGH     Es excess >= +6000 ft above reference (amber)
                  → high+fast, hard to slow down before TOD
     RECOVERING   Ps positive but Es below reference   (yellow)
                  → catching up

   Reference Es by phase:
     CLIMB:    Es_ref = targetGradFtNm * distance flown so far
                       since departure (we don't know it; use
                       cruiseAlt 35000 + V_ref^2/(2g) as ceiling)
     CRUISE:   Es_ref = altFt + Vref^2/(2g)   (Vref class-tuned)
     DESCENT:  Es_ref = altFt + 250kt^2/(2g)  (250 KIAS below
                       FL100 / .80M cruise descent)
     LEVEL-LO: Es_ref = altFt + 250kt^2/(2g) (terminal speed cap)

   Sub-models also surface:
     - Speed delta (V_TAS - V_ref) in kt
     - Altitude delta vs optimum cruise band (FL280-FL420)
     - "Trade space": how many ft of altitude this aircraft
       *could* climb if it traded all kinetic energy down to
       Mach 0.50 (cruise-relevant) = (V_TAS^2 - V_min^2)/(2g)

   MapLibre overlay paints tier-coloured halo ring on every
   airborne aircraft scaled to |delta Es| magnitude, dashed
   tier-coloured vertical arrow (3-vertex line from current
   position pointing up for HOT or down for LOW by trade-ft),
   callsign + Es-kft + tier labels.

   Side panel: 4-tier counter strip click-to-filter, 3-cell
   FLEET-MEAN-Es / WORST-HOT / WORST-LOW summary, SVG Es-vs-
   altitude scatter (x-axis altFt 0-50k, y-axis Es 0-60k, sky
   identity diagonal, dashed reference band, aircraft as tier
   dots), V-REF / OPT-FL / MIN-FL / TRADE-K sliders, OVL/HALO/
   ARROW/LBL toggles, callsign/type/operator search, AIRCRAFT
   tab sorted tier-worst-first then |deltaEs| desc with tier
   color stripe + callsign+type+phase-pill + altFL+Vtas+Es-kft
   line + delta-Es bar centered on zero with tier ticks +
   actualGrad/targetGrad/Ps footer, click-to-fly per row.
   ============================================================ */

export interface EnFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  vertRate: number
  mach?: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: EnFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'STABLE' | 'RECOVERING' | 'HOT-HIGH' | 'LOW-ENERGY'
const TIER_COLOR: Record<Tier, string> = {
  STABLE: '#0ea5e9',
  RECOVERING: '#fbbf24',
  'HOT-HIGH': '#f97316',
  'LOW-ENERGY': '#ef4444',
}
const TIER_ORDER: Tier[] = ['LOW-ENERGY', 'HOT-HIGH', 'RECOVERING', 'STABLE']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter' | 'helicopter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR', helicopter: 'HEL',
}
const KLASS_GRAD: Record<Klass, number> = {
  heavy: 146, narrow: 182, regional: 213, biz: 243, turboprop: 170, ga: 304, fighter: 486, helicopter: 213,
}
const KLASS_VREF: Record<Klass, number> = {
  heavy: 480, narrow: 460, regional: 380, biz: 440, turboprop: 280, ga: 130, fighter: 520, helicopter: 130,
}
const KLASS_VMIN: Record<Klass, number> = {
  heavy: 230, narrow: 220, regional: 180, biz: 200, turboprop: 130, ga: 65, fighter: 200, helicopter: 0,
}

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'helicopter'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CRJ9|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS)/.test(x)) return 'fighter'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'ga'
  if (/^(B19|B20|B30|B35|B40|B45|B55|B58|B95|B96|B99|EMB|E11|PA31|PA42|PC9|KODI)/.test(x)) return 'turboprop'
  return 'narrow'
}

type Phase = 'CLIMB' | 'DESCENT' | 'CRUISE' | 'LEVEL-LO'
function phaseOf(altFt: number, vertRate: number): Phase {
  if (vertRate > 400) return 'CLIMB'
  if (vertRate < -400) return 'DESCENT'
  if (altFt >= 18000) return 'CRUISE'
  return 'LEVEL-LO'
}

/* ISA + TAS helpers */
const G_FTS2 = 32.174
const T0K = 288.15
function isaTempK(altFt: number): number {
  if (altFt <= 36089) return T0K - 0.0019812 * altFt
  return 216.65
}
function tasFromGS(gsKts: number, altFt: number): number {
  // Rough but good: TAS ≈ IAS * (1 + 0.02 * altFt/1000) when no wind correction
  // We treat reported velocity as GS≈TAS to first order, then bump for altitude.
  const bump = 1 + 0.02 * Math.max(0, altFt / 1000)
  return Math.max(0, gsKts) * Math.min(1.7, bump)
}
function kineticHeightFt(vTasKts: number): number {
  const vFps = vTasKts * 1.68781
  return (vFps * vFps) / (2 * G_FTS2)
}

interface Row {
  f: EnFlight
  klass: Klass
  phase: Phase
  altFt: number
  vTas: number
  kinH: number
  esFt: number
  esRef: number
  deltaEs: number
  actualGrad: number
  targetGrad: number
  ps: number
  tradeFt: number
  tier: Tier
  reason: string
}

function lsGet<T>(k: string, def: T): T {
  if (typeof window === 'undefined') return def
  try { const v = window.localStorage.getItem(k); return v === null ? def : JSON.parse(v) as T } catch { return def }
}
function lsSet(k: string, v: unknown) {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(k, JSON.stringify(v)) } catch {}
}

export default function EnergyMonitor({ map, flights, onClose, onFly }: Props) {
  const [vRefAdj, setVRefAdj] = useState<number>(() => lsGet('ft-en-vrefadj', 0))
  const [optFl, setOptFl] = useState<number>(() => lsGet('ft-en-optfl', 360))
  const [minFl, setMinFl] = useState<number>(() => lsGet('ft-en-minfl', 30))
  const [tradeK, setTradeK] = useState<number>(() => lsGet('ft-en-tradek', 100))
  const [showOvl, setShowOvl] = useState<boolean>(() => lsGet('ft-en-ovl', true))
  const [showHalo, setShowHalo] = useState<boolean>(() => lsGet('ft-en-halo', true))
  const [showArrow, setShowArrow] = useState<boolean>(() => lsGet('ft-en-arrow', true))
  const [showLbl, setShowLbl] = useState<boolean>(() => lsGet('ft-en-lbl', true))
  const [tierFilter, setTierFilter] = useState<Tier | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => { lsSet('ft-en-vrefadj', vRefAdj) }, [vRefAdj])
  useEffect(() => { lsSet('ft-en-optfl', optFl) }, [optFl])
  useEffect(() => { lsSet('ft-en-minfl', minFl) }, [minFl])
  useEffect(() => { lsSet('ft-en-tradek', tradeK) }, [tradeK])
  useEffect(() => { lsSet('ft-en-ovl', showOvl) }, [showOvl])
  useEffect(() => { lsSet('ft-en-halo', showHalo) }, [showHalo])
  useEffect(() => { lsSet('ft-en-arrow', showArrow) }, [showArrow])
  useEffect(() => { lsSet('ft-en-lbl', showLbl) }, [showLbl])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const minAlt = minFl * 100
    for (const f of flights) {
      if (f.ground) continue
      if (!Number.isFinite(f.altitudeFt) || f.altitudeFt < minAlt) continue
      if (!Number.isFinite(f.velocityKts) || f.velocityKts < 30) continue
      const klass = classify(f.type, f.category)
      const phase = phaseOf(f.altitudeFt, f.vertRate)
      const altFt = f.altitudeFt
      const vTas = tasFromGS(f.velocityKts, altFt)
      const vRef = Math.max(60, KLASS_VREF[klass] + vRefAdj)
      const vMin = Math.max(40, KLASS_VMIN[klass])
      const kinH = kineticHeightFt(vTas)
      const esFt = altFt + kinH
      let esRef: number
      const optAlt = optFl * 100
      if (phase === 'CRUISE') {
        esRef = altFt + kineticHeightFt(vRef)
      } else if (phase === 'DESCENT') {
        esRef = altFt + kineticHeightFt(Math.min(vRef, 300))
      } else if (phase === 'CLIMB') {
        // Reference Es: optAlt + vRef^2/(2g) — what they're climbing toward
        esRef = Math.max(altFt + kineticHeightFt(vRef), optAlt + kineticHeightFt(vRef) * 0.4)
      } else {
        esRef = altFt + kineticHeightFt(Math.min(vRef, 250))
      }
      const deltaEs = esFt - esRef
      const actualGrad = vTas > 1 ? (f.vertRate / vTas) * 60 : 0
      let targetGrad: number
      if (phase === 'CLIMB') targetGrad = KLASS_GRAD[klass]
      else if (phase === 'DESCENT') targetGrad = -318
      else targetGrad = 0
      const ps = f.vertRate + (vTas - vRef) * 6 // ft/min, small accel-equivalent boost
      const tradeFt = Math.max(0, (vTas * vTas - vMin * vMin) * (1.68781 * 1.68781) / (2 * G_FTS2))
      let tier: Tier
      let reason: string
      if (deltaEs <= -6000) { tier = 'LOW-ENERGY'; reason = 'Es deficit; slow+low for phase' }
      else if (deltaEs >= 6000) { tier = 'HOT-HIGH'; reason = 'Es excess; high+fast' }
      else if (deltaEs < -1500 && ps > 200) { tier = 'RECOVERING'; reason = 'Below ref but climbing' }
      else { tier = 'STABLE'; reason = `Within ${Math.abs(deltaEs/1000).toFixed(1)}k of ref` }
      // Phase override: if climbing AND grad < 60% of target, escalate
      if (phase === 'CLIMB' && actualGrad < targetGrad * 0.6 && tier === 'STABLE') {
        tier = 'RECOVERING'; reason = `Climb gradient ${actualGrad.toFixed(0)} < target ${targetGrad}`
      }
      // Phase override: if descending too steep AND fast, HOT-HIGH
      if (phase === 'DESCENT' && actualGrad < -500 && vTas > vRef + 30 && tier !== 'LOW-ENERGY') {
        tier = 'HOT-HIGH'; reason = `Hot descent ${actualGrad.toFixed(0)}ft/nm at ${vTas.toFixed(0)}kt`
      }
      out.push({ f, klass, phase, altFt, vTas, kinH, esFt, esRef, deltaEs, actualGrad, targetGrad, ps, tradeFt, tier, reason })
    }
    return out
  }, [flights, vRefAdj, optFl, minFl])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { 'STABLE': 0, 'RECOVERING': 0, 'HOT-HIGH': 0, 'LOW-ENERGY': 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])
  const meanEs = rows.length ? rows.reduce((s, r) => s + r.esFt, 0) / rows.length : 0
  const worstHot = rows.filter(r => r.tier === 'HOT-HIGH').sort((a, b) => b.deltaEs - a.deltaEs)[0]
  const worstLow = rows.filter(r => r.tier === 'LOW-ENERGY').sort((a, b) => a.deltaEs - b.deltaEs)[0]

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = tierFilter ? rows.filter(r => r.tier === tierFilter) : rows
    const subset = q ? base.filter(r =>
      (r.f.callsign || '').toLowerCase().includes(q) ||
      (r.f.type || '').toLowerCase().includes(q) ||
      (r.f.operator || '').toLowerCase().includes(q) ||
      (r.f.icao || '').toLowerCase().includes(q)) : base
    return subset.slice().sort((a, b) => {
      const ta = TIER_ORDER.indexOf(a.tier), tb = TIER_ORDER.indexOf(b.tier)
      if (ta !== tb) return ta - tb
      return Math.abs(b.deltaEs) - Math.abs(a.deltaEs)
    }).slice(0, 200)
  }, [rows, tierFilter, query])

  /* Map overlay */
  useEffect(() => {
    if (!map) return
    const m = map
    const SRC_H = 'en-halo-src', LYR_H = 'en-halo-lyr'
    const SRC_A = 'en-arrow-src', LYR_A = 'en-arrow-lyr'
    const SRC_L = 'en-lbl-src', LYR_L = 'en-lbl-lyr'
    const ensure = () => {
      if (!m.getSource(SRC_H)) m.addSource(SRC_H, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as never)
      if (!m.getLayer(LYR_H)) m.addLayer({ id: LYR_H, type: 'circle', source: SRC_H, paint: {
        'circle-radius': ['get', 'r'], 'circle-color': ['get', 'col'], 'circle-opacity': 0.0,
        'circle-stroke-color': ['get', 'col'], 'circle-stroke-width': 1.8, 'circle-stroke-opacity': 0.85,
      } } as never)
      if (!m.getSource(SRC_A)) m.addSource(SRC_A, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as never)
      if (!m.getLayer(LYR_A)) m.addLayer({ id: LYR_A, type: 'line', source: SRC_A, paint: {
        'line-color': ['get', 'col'], 'line-width': 1.8, 'line-opacity': 0.85, 'line-dasharray': [2, 1.5],
      } } as never)
      if (!m.getSource(SRC_L)) m.addSource(SRC_L, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as never)
      if (!m.getLayer(LYR_L)) m.addLayer({ id: LYR_L, type: 'symbol', source: SRC_L, layout: {
        'text-field': ['get', 'lbl'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular','Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'col'], 'text-halo-color': '#0f172a', 'text-halo-width': 1.4 } } as never)
    }
    try { ensure() } catch { setTimeout(() => { try { ensure() } catch {} }, 250) }

    const halo: GeoJSON.Feature[] = []
    const arrow: GeoJSON.Feature[] = []
    const lbl: GeoJSON.Feature[] = []
    if (showOvl) {
      for (const r of rows) {
        const col = TIER_COLOR[r.tier]
        const radius = 6 + Math.min(20, Math.abs(r.deltaEs) / 800)
        if (showHalo) halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { r: radius, col } })
        if (showArrow && r.tier !== 'STABLE') {
          // Vertical arrow approximated as short geodesic step north (HOT) / south (LOW)
          const sign = r.deltaEs > 0 ? 1 : -1
          const dLat = sign * Math.min(0.6, Math.abs(r.deltaEs) / 30000)
          arrow.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.f.lng, r.f.lat + dLat]] }, properties: { col } })
        }
        if (showLbl && r.tier !== 'STABLE') {
          lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {
            lbl: `${r.f.callsign || r.f.icao}  Es${(r.esFt/1000).toFixed(1)}k  ${r.tier}`, col,
          } })
        }
      }
    }
    try {
      ;(m.getSource(SRC_H) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: halo })
      ;(m.getSource(SRC_A) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: arrow })
      ;(m.getSource(SRC_L) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lbl })
    } catch {}
    return () => {
      try {
        for (const id of [LYR_L, LYR_A, LYR_H]) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC_L, SRC_A, SRC_H]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, rows, showOvl, showHalo, showArrow, showLbl])

  /* SVG Es-vs-altitude scatter */
  const svg = useMemo(() => {
    const W = 360, H = 200, padL = 32, padB = 22, padT = 8, padR = 8
    const xMin = 0, xMax = 50000
    const yMin = 0, yMax = 60000
    const xs = (v: number) => padL + ((v - xMin) / (xMax - xMin)) * (W - padL - padR)
    const ys = (v: number) => H - padB - ((v - yMin) / (yMax - yMin)) * (H - padT - padB)
    return { W, H, xs, ys, padL, padB, padT, padR, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-16 right-4 z-40 w-[min(94vw,440px)] max-h-[80vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Energy</div>
          <div className="text-sm font-semibold text-slate-100">Energy Profile Monitor</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-4 gap-1.5">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? null : t)}
            className={`px-2 py-1.5 rounded-md border text-[10px] font-mono ${tierFilter === t ? 'border-sky-500/40 bg-sky-500/15' : 'border-slate-800 bg-slate-900/50'} text-slate-200`}>
            <div className="flex items-center justify-between">
              <span style={{ color: TIER_COLOR[t] }}>●</span>
              <span className="text-slate-300">{counts[t]}</span>
            </div>
            <div className="text-[9px] text-slate-500 mt-0.5">{t}</div>
          </button>
        ))}
      </div>

      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-3 gap-1.5 text-[10px] font-mono">
        <div className="bg-slate-900/50 border border-slate-800 rounded-md px-2 py-1.5">
          <div className="text-slate-500 text-[9px]">FLEET Es</div>
          <div className="text-slate-200">{(meanEs/1000).toFixed(1)}k</div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800 rounded-md px-2 py-1.5">
          <div className="text-slate-500 text-[9px]">WORST HOT</div>
          <div style={{ color: TIER_COLOR['HOT-HIGH'] }}>{worstHot ? `+${(worstHot.deltaEs/1000).toFixed(1)}k` : '—'}</div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800 rounded-md px-2 py-1.5">
          <div className="text-slate-500 text-[9px]">WORST LOW</div>
          <div style={{ color: TIER_COLOR['LOW-ENERGY'] }}>{worstLow ? `${(worstLow.deltaEs/1000).toFixed(1)}k` : '—'}</div>
        </div>
      </div>

      <div className="px-4 py-2 border-b border-slate-900">
        <svg viewBox={`0 0 ${svg.W} ${svg.H}`} className="w-full h-[200px]">
          <rect x={0} y={0} width={svg.W} height={svg.H} fill="#020617" />
          {/* identity */}
          <line x1={svg.xs(0)} y1={svg.ys(0)} x2={svg.xs(50000)} y2={svg.ys(50000)} stroke="#0ea5e9" strokeWidth={1} strokeDasharray="3,3" opacity={0.7} />
          {/* reference band: Es = alt + Vref^2/2g, Vref ~ 460kt = ~12k ft kinetic */}
          <line x1={svg.xs(0)} y1={svg.ys(12000)} x2={svg.xs(50000)} y2={svg.ys(62000)} stroke="#475569" strokeWidth={0.8} strokeDasharray="2,2" opacity={0.6} />
          {/* axes */}
          {[0, 10000, 20000, 30000, 40000, 50000].map(t => (
            <g key={t}>
              <line x1={svg.xs(t)} y1={svg.ys(0)} x2={svg.xs(t)} y2={svg.ys(60000)} stroke="#1e293b" strokeWidth={0.4} />
              <text x={svg.xs(t)} y={svg.H - 6} fill="#475569" fontSize={8} textAnchor="middle">{t/1000}k</text>
            </g>
          ))}
          {[0, 20000, 40000, 60000].map(t => (
            <g key={t}>
              <line x1={svg.xs(0)} y1={svg.ys(t)} x2={svg.xs(50000)} y2={svg.ys(t)} stroke="#1e293b" strokeWidth={0.4} />
              <text x={4} y={svg.ys(t) + 3} fill="#475569" fontSize={8}>{t/1000}k</text>
            </g>
          ))}
          {rows.map((r, i) => (
            <circle key={i} cx={svg.xs(Math.min(50000, r.altFt))} cy={svg.ys(Math.min(60000, r.esFt))} r={2.2}
              fill={TIER_COLOR[r.tier]} opacity={0.85} />
          ))}
          <text x={svg.W - 6} y={svg.padT + 10} fill="#64748b" fontSize={8} textAnchor="end">Es (ft) vs ALT (ft)</text>
        </svg>
      </div>

      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px] font-mono">
        <label className="flex items-center justify-between gap-2">
          <span className="text-slate-500">V-REF±</span>
          <input type="range" min={-40} max={40} value={vRefAdj} onChange={e => setVRefAdj(parseInt(e.target.value))} className="flex-1" />
          <span className="text-slate-300 w-10 text-right">{vRefAdj > 0 ? '+' : ''}{vRefAdj}kt</span>
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-slate-500">OPT-FL</span>
          <input type="range" min={200} max={450} step={10} value={optFl} onChange={e => setOptFl(parseInt(e.target.value))} className="flex-1" />
          <span className="text-slate-300 w-10 text-right">FL{optFl}</span>
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-slate-500">MIN-FL</span>
          <input type="range" min={10} max={300} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="flex-1" />
          <span className="text-slate-300 w-10 text-right">FL{minFl}</span>
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-slate-500">TRADE</span>
          <input type="range" min={20} max={200} step={10} value={tradeK} onChange={e => setTradeK(parseInt(e.target.value))} className="flex-1" />
          <span className="text-slate-300 w-10 text-right">{tradeK}%</span>
        </label>
      </div>

      <div className="px-4 py-2 border-b border-slate-900 flex flex-wrap gap-1.5 text-[10px] font-mono">
        {([['OVL', showOvl, setShowOvl], ['HALO', showHalo, setShowHalo], ['ARROW', showArrow, setShowArrow], ['LBL', showLbl, setShowLbl]] as const).map(([lbl, val, setter]) => (
          <button key={lbl} onClick={() => setter(!val)}
            className={`px-2 py-1 rounded-md border ${val ? 'border-sky-500/40 bg-sky-500/15 text-slate-100' : 'border-slate-800 bg-slate-900/50 text-slate-500'}`}>
            {lbl}
          </button>
        ))}
      </div>

      <div className="px-4 py-2 border-b border-slate-900">
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="callsign / type / operator / icao"
          className="w-full bg-slate-900/60 border border-slate-800 rounded-md px-2 py-1.5 text-[11px] font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50" />
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-4 py-6 text-center text-[11px] font-mono text-slate-500">no aircraft match</div>
        )}
        {filtered.map((r, i) => {
          const col = TIER_COLOR[r.tier]
          const dEsK = r.deltaEs / 1000
          const barCenter = 50
          const barPos = Math.max(2, Math.min(98, 50 + dEsK * 3.5))
          const tradePct = Math.min(100, (r.tradeFt / (tradeK * 100)))
          return (
            <button key={i} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-4 py-2 border-b border-slate-900 hover:bg-slate-900/40 transition-colors flex gap-2">
              <div className="w-1 self-stretch rounded-full" style={{ background: col }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-mono text-slate-100 truncate">
                    {r.f.callsign || r.f.icao} <span className="text-slate-500">· {r.f.type || '—'} · {KLASS_LABEL[r.klass]}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-md border border-slate-800 text-slate-400">{r.phase}</span>
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-md" style={{ borderColor: col, borderWidth: 1, color: col }}>{r.tier}</span>
                  </div>
                </div>
                <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                  FL{Math.round(r.altFt/100)} · {r.vTas.toFixed(0)}kt · Es {(r.esFt/1000).toFixed(1)}k · Δ {dEsK >= 0 ? '+' : ''}{dEsK.toFixed(1)}k
                </div>
                <div className="relative h-1.5 mt-1.5 bg-slate-900 rounded-full overflow-hidden">
                  <div className="absolute top-0 bottom-0" style={{ left: `${barCenter}%`, width: '1px', background: '#475569' }} />
                  <div className="absolute top-0 bottom-0 rounded-full" style={{
                    left: `${Math.min(barCenter, barPos)}%`,
                    width: `${Math.abs(barPos - barCenter)}%`,
                    background: col, opacity: 0.7,
                  }} />
                </div>
                <div className="text-[9px] font-mono text-slate-500 mt-1 flex items-center justify-between gap-2">
                  <span>
                    grad {r.actualGrad.toFixed(0)}/{r.targetGrad}ft·nm · Ps {r.ps >= 0 ? '+' : ''}{r.ps.toFixed(0)}fpm · trade {(r.tradeFt/1000).toFixed(1)}k
                  </span>
                  <span className="text-slate-600 truncate max-w-[40%]">{r.f.operator || ''}</span>
                </div>
                <div className="text-[9px] font-mono text-slate-600 mt-0.5 truncate">{r.reason} · cap {tradePct.toFixed(0)}%</div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
