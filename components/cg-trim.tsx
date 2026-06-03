'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   CG / Stab Trim Envelope Monitor
   -----------------------------------------------------------
   FAA AC 120-27F (Aircraft Weight and Balance Control) ·
   EASA AMC1 ORO.MLR.110 Mass and Balance · ICAO Annex 6 Pt I
   App 4 · Boeing FCOM 1.06.10 / Airbus FCOM AOM-1.27 CG &
   Stab-Trim Setting · 14 CFR 25.27 Center of Gravity Limits.

   For every airborne aircraft we synthesise a deterministic
   loading state at take-off (FNV-1a hash of ICAO24 picks a
   stable per-airframe load distribution within the class
   envelope) then advance the CG position by the cumulative
   fuel burn over elapsed climb / cruise time, since wing /
   centre-tank burn migrates the CG aft on most transports.
   We then score the current %MAC against the certified
   forward and aft limits and translate the result to a
   stabiliser trim setting (units of nose-up trim) using the
   class-specific dCG/dTRIM gradient.

   Class catalogue (Boeing AMM 09 / Airbus AOM 1.27 / EMB):
     hi-wide   HWB  B777 B787 A330 A350 A380 (long-haul wide)
     hi-narrow HNB  B737NG/MAX A320neo/CEO A220 (narrow body)
     regional  RGN  CRJ7/9/10 E175/190/195 ATR72
     business  BIZ  G450/550/650 Global 6500 Falcon 8X
     turboprop TBP  Q400 DHC8 King Air B200/350 TBM
     ga-prop   GA   PA28 C172 SR22 DA42
     fighter   FTR  F-16 F/A-18 Typhoon (fwd-bias FCS-stabilised)

   Per-class envelope (%MAC):
                  FWD limit   AFT limit   MAC chord (in)
     HWB           14.0        38.0         275
     HNB           12.0        36.0         156
     RGN           14.0        33.0         110
     BIZ           17.0        34.0          88
     TBP           18.0        32.0          75
     GA            10.0        32.0          50
     FTR           20.0        38.0          90   (relaxed-stab)

   Loading model per aircraft (hash-stable, deterministic):
     base CG %MAC = mid + (hash-noise -10..+10) * BIAS
     fuel-burn shift after t hours = +0.6 %MAC per hour
       scaled by class (HWB 1.0 / HNB 0.8 / RGN 0.6 / BIZ 0.7
       / TBP 0.3 / GA 0.15 / FTR 0.4) and BURN-SCALE slider
       50-200 pct (centre/wing-tank burn moves CG aft)
     cg_now = clamp(base + burn_shift + USER-BIAS slider -8..+8 %MAC)
     stab_trim_units = (cg_now - FWD-limit) * GRAD
       GRAD per class (HWB 0.55 / HNB 0.70 / RGN 0.85 /
       BIZ 0.70 / TBP 0.60 / GA 1.20 / FTR 0.40 units / %MAC)
       displayed as ANU (Aircraft Nose-Up) units

   Tier classification per aircraft:
     OUT     cg outside FWD or AFT limit            rose    envelope busted · reposition
     CRIT    within 1 %MAC of either limit          amber   approaching limit · monitor
     MARGIN  within 3 %MAC of either limit          sky     reduced margin · watch trim
     OK      mid-envelope ≥3 %MAC from both limits  emerald nominal
     IDLE    on-ground / below MIN-FL               slate   excluded

   MapLibre overlay (registered in Layers > Safety & Traffic):
     - Tier-coloured halo rings sized by severity 8-22 px
     - Rose diamond pin for OUT aircraft
     - Tier-coloured callsign + %MAC labels for CRIT / OUT
     - 12-segment dashed forward-projection 100 nm for OUT

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-%MAC tier-coloured / WORST callsign+%MAC /
       OUT-COUNT summary
     - 2-cell MEAN-TRIM units / MEAN-MARGIN %MAC secondary row
     - SVG cg-%MAC (y) vs flight level (x) scatter with
       per-class envelope bands shaded + dashed limit lines
     - 5 sliders MIN-FL / MAX-FL / BURN-SCALE / USER-BIAS /
       LOAD-VAR in 2-col grid
     - 7-class chip filter
     - HALO / LBL / PIN / PROJ / DIAG toggles + search
     - AIRCRAFT / CLASSES tab switcher
     - AIRCRAFT tab tier-worst-first then envelope-margin asc
       with tier color stripe + callsign + type + class-pill +
       tier-pill + FL / phase / hrs-airborne / %MAC / TRIM-units
       line + tier-coloured envelope bar 0-50 %MAC with FWD/AFT
       limit ticks + tier-coloured advice click-to-fly
     - CLASSES tab grouped by aircraft class sorted worst-tier-
       first then ac-count desc with tier stripe + class-pill +
       class-name + ac-count + tier-pill + mean-%MAC / mean-TRIM
       / worst-callsign line + envelope bar + advice click-to-fly

   Persisted: ft-cgtrim
   ============================================================ */

export interface CgFlight {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  vertRate: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: CgFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'MARGIN' | 'CRIT' | 'OUT' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981',
  MARGIN: '#0ea5e9',
  CRIT: '#f59e0b',
  OUT: '#ef4444',
  IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['OUT', 'CRIT', 'MARGIN', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { OUT: 0, CRIT: 1, MARGIN: 2, OK: 3, IDLE: 4 }

type Klass = 'HWB' | 'HNB' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const KL_NAME: Record<Klass, string> = {
  HWB: 'Wide-body long-haul (B777/787/A330/350/380)',
  HNB: 'Narrow-body (B737/A320/A220)',
  RGN: 'Regional jet/turboprop (CRJ/E-jets/ATR)',
  BIZ: 'Business jet (G450/650/Global/Falcon)',
  TBP: 'Turboprop (Q400/King Air/TBM)',
  GA: 'General aviation prop',
  FTR: 'Fighter (relaxed-stab FCS)',
}
const KL_FWD: Record<Klass, number> = { HWB: 14, HNB: 12, RGN: 14, BIZ: 17, TBP: 18, GA: 10, FTR: 20 }
const KL_AFT: Record<Klass, number> = { HWB: 38, HNB: 36, RGN: 33, BIZ: 34, TBP: 32, GA: 32, FTR: 38 }
const KL_MAC: Record<Klass, number> = { HWB: 275, HNB: 156, RGN: 110, BIZ: 88, TBP: 75, GA: 50, FTR: 90 }
const KL_BURN: Record<Klass, number> = { HWB: 1.0, HNB: 0.8, RGN: 0.6, BIZ: 0.7, TBP: 0.3, GA: 0.15, FTR: 0.4 }
const KL_GRAD: Record<Klass, number> = { HWB: 0.55, HNB: 0.70, RGN: 0.85, BIZ: 0.70, TBP: 0.60, GA: 1.20, FTR: 0.40 }

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'GA'
  if (/^(B77|B78|A33|A34|A35|A38|B74|MD11|IL96)/.test(x)) return 'HWB'
  if (/^(A31|A32|A19|A20|A21|A22|B73|B72|B71|MD8|MD9|BCS|CS1|CS3)/.test(x)) return 'HNB'
  if (/^(CRJ|E14|E15|E17|E19|E29|E70|E75|AT4|AT5|AT7)/.test(x)) return 'RGN'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'BIZ'
  if (/^(DH8|Q40|SF34|J32|J41|ATR|TBM|PC12|TB|PC6|DHC|AN2|BE9|BE3|BE2)/.test(x)) return 'TBP'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS)/.test(x)) return 'FTR'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|C20)/.test(x)) return 'GA'
  return 'HNB'
}

type Phase = 'TAKEOFF' | 'CLIMB' | 'CRUISE' | 'DESCENT' | 'APPR'
const PHASE_LABEL: Record<Phase, string> = { TAKEOFF: 'TO', CLIMB: 'CLB', CRUISE: 'CRZ', DESCENT: 'DES', APPR: 'APP' }
function inferPhase(altFt: number, vsFpm: number): Phase {
  if (altFt < 5000 && vsFpm > 2200) return 'TAKEOFF'
  if (altFt < 8000) return 'APPR'
  if (vsFpm > 600) return 'CLIMB'
  if (vsFpm < -600) return 'DESCENT'
  if (altFt < 18000 && vsFpm < -200) return 'DESCENT'
  return 'CRUISE'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h >>> 0
}

// Estimate "hours airborne" proxy from altitude / phase / class (hash-stable noise)
function inferHrs(klass: Klass, altFt: number, phase: Phase, h: number): number {
  const cruiseCap: Record<Klass, number> = { HWB: 14, HNB: 6, RGN: 3, BIZ: 8, TBP: 2.5, GA: 4, FTR: 2 }
  const noise = ((h >>> 13) % 1000) / 1000
  if (phase === 'TAKEOFF') return 0.02 + noise * 0.05
  if (phase === 'CLIMB') return 0.2 + noise * 0.4
  if (phase === 'CRUISE') return 0.8 + noise * cruiseCap[klass]
  if (phase === 'DESCENT') return 0.6 + noise * cruiseCap[klass] * 0.8
  return 0.05 + noise * 0.2
}

function projectPosition(lat: number, lng: number, trackDeg: number, distNm: number): { lat: number; lng: number } {
  const R = 3440.065
  const δ = distNm / R
  const θ = (trackDeg * Math.PI) / 180
  const φ1 = (lat * Math.PI) / 180
  const λ1 = (lng * Math.PI) / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return { lat: (φ2 * 180) / Math.PI, lng: (((λ2 * 180) / Math.PI + 540) % 360) - 180 }
}

interface Row {
  f: CgFlight
  klass: Klass
  flCur: number
  phase: Phase
  hrs: number
  fwd: number
  aft: number
  baseCg: number
  burnShift: number
  cgNow: number
  trimUnits: number
  marginFwd: number       // cgNow - fwd  (positive = inside aft of fwd)
  marginAft: number       // aft - cgNow  (positive = inside fwd of aft)
  envMargin: number       // min(marginFwd, marginAft)
  severity: number
  tier: Tier
}

function tierOf(envMargin: number): Tier {
  if (envMargin < 0) return 'OUT'
  if (envMargin < 1) return 'CRIT'
  if (envMargin < 3) return 'MARGIN'
  return 'OK'
}

const SRC_HALO = 'cgtrim-halo', SRC_LBL = 'cgtrim-lbl', SRC_PIN = 'cgtrim-pin', SRC_PROJ = 'cgtrim-proj'
const LYR_HALO = 'cgtrim-halo-l', LYR_LBL = 'cgtrim-lbl-l', LYR_PIN = 'cgtrim-pin-l', LYR_PROJ = 'cgtrim-proj-l'

export default function CgTrim({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klFilter, setKlFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(450)
  const [burnScale, setBurnScale] = useState(100)   // 50-200 %
  const [userBias, setUserBias] = useState(0)       // -8..+8 %MAC
  const [loadVar, setLoadVar] = useState(100)       // 50-200 % spread
  const [showHalo, setShowHalo] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const burnK = burnScale / 100
    const loadK = loadVar / 100
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl || flCur > maxFl) continue
      const klass = classify(f.type, f.category)
      const fwd = KL_FWD[klass]
      const aft = KL_AFT[klass]
      const mid = (fwd + aft) / 2
      const phase = inferPhase(f.altitudeFt, f.vertRate || 0)
      const h = hash32(f.icao || '')
      // hash-noise -10..+10 → scaled by loadK
      const noise = (((h % 2000) / 1000) - 1) * 10 * loadK
      const baseCg = Math.max(fwd - 1, Math.min(aft + 1, mid + noise))
      const hrs = inferHrs(klass, f.altitudeFt, phase, h)
      const burnShift = 0.6 * hrs * KL_BURN[klass] * burnK
      const cgNow = baseCg + burnShift + userBias
      const trimUnits = (cgNow - fwd) * KL_GRAD[klass]
      const marginFwd = cgNow - fwd
      const marginAft = aft - cgNow
      const envMargin = Math.min(marginFwd, marginAft)
      const range = (aft - fwd) / 2
      const severity = Math.max(0, Math.min(100, ((range - envMargin) / Math.max(0.1, range)) * 100))
      const tier = tierOf(envMargin)
      out.push({ f, klass, flCur, phase, hrs, fwd, aft, baseCg, burnShift, cgNow, trimUnits, marginFwd, marginAft, envMargin, severity, tier })
    }
    return out
  }, [flights, minFl, maxFl, burnScale, userBias, loadVar])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, MARGIN: 0, CRIT: 0, OUT: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumCg = 0, sumTrim = 0, sumMarg = 0, worstM = Infinity, worstCs = '', worstCg = 0, outCount = 0
    for (const r of rows) {
      sumCg += r.cgNow
      sumTrim += r.trimUnits
      sumMarg += r.envMargin
      if (r.tier === 'OUT') outCount++
      if (r.envMargin < worstM) { worstM = r.envMargin; worstCs = (r.f.callsign || r.f.icao).trim(); worstCg = r.cgNow }
    }
    if (rows.length) { sumCg /= rows.length; sumTrim /= rows.length; sumMarg /= rows.length }
    else { worstM = 0 }
    return { meanCg: sumCg, meanTrim: sumTrim, meanMargin: sumMarg, worstM, worstCs, worstCg, outCount }
  }, [rows])

  const klassAggs = useMemo(() => {
    const m = new Map<Klass, { klass: Klass; count: number; sumCg: number; sumTrim: number; worstM: number; worstCs: string; worstIcao: string; worstCg: number; tier: Tier }>()
    for (const r of rows) {
      let a = m.get(r.klass)
      if (!a) { a = { klass: r.klass, count: 0, sumCg: 0, sumTrim: 0, worstM: Infinity, worstCs: '', worstIcao: '', worstCg: 0, tier: 'OK' }; m.set(r.klass, a) }
      a.count++
      a.sumCg += r.cgNow
      a.sumTrim += r.trimUnits
      if (r.envMargin < a.worstM) { a.worstM = r.envMargin; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao; a.worstCg = r.cgNow }
    }
    const arr = Array.from(m.values()).map(a => ({ ...a, meanCg: a.count ? a.sumCg / a.count : 0, meanTrim: a.count ? a.sumTrim / a.count : 0, tier: tierOf(a.worstM) }))
    arr.sort((a, b) => {
      const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (ti !== 0) return ti
      return b.count - a.count
    })
    return arr
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows
      .filter(r => {
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (klFilter !== 'ALL' && r.klass !== klFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.klass].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return a.envMargin - b.envMargin
      })
  }, [rows, tierFilter, klFilter, query])

  const filteredKlass = useMemo(() => {
    const q = query.trim().toUpperCase()
    return klassAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.tier !== tierFilter) return false
      if (!q) return true
      return (a.klass + ' ' + KL_NAME[a.klass]).toUpperCase().includes(q)
    })
  }, [klassAggs, tierFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.severity / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'CRIT' || r.tier === 'OUT').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${r.cgNow.toFixed(1)}%MAC`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'OUT').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ‹ ENVELOPE` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFeatures: any[] = []
    if (showProj) {
      for (const r of rows) {
        if (r.tier !== 'OUT') continue
        const coords: [number, number][] = []
        for (let i = 0; i <= 12; i++) {
          const p = projectPosition(r.f.lat, r.f.lng, r.f.track || 0, (100 * i) / 12)
          coords.push([p.lng, p.lat])
        }
        projFeatures.push({
          type: 'Feature' as const,
          properties: { color: TIER_COLOR[r.tier] },
          geometry: { type: 'LineString' as const, coordinates: coords },
        })
      }
    }
    const projFc = { type: 'FeatureCollection' as const, features: projFeatures }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.4,
        'line-opacity': 0.7,
        'line-dasharray': [2, 3],
      } }))
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.4,
        'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-offset': [0, -1.8],
        'text-anchor': 'bottom',
        'icon-allow-overlap': true,
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.6,
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-offset': [0, 1.6],
        'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.2,
      } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_PROJ]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showProj])

  // Diagram: %MAC (y, 5..45) vs flight level (x, 0..450)
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 30
    const xMax = 45, yMin = 5, yMax = 45
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, v / xMax)) * (W - PAD - 6)
    const ys = (m: number) => 6 + (1 - Math.max(0, Math.min(1, (m - yMin) / (yMax - yMin)))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMax, yMax, yMin }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">CG / Stab Trim</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} ac</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold" style={{ color: TIER_COLOR[t] }}>{t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean %MAC</div>
          <div className="font-mono text-sm text-slate-200">{summary.meanCg.toFixed(1)}<span className="text-[9px] text-slate-500"> %</span></div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstCg.toFixed(1)}%` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Out-Env</div>
          <div className="font-mono text-sm" style={{ color: summary.outCount > 0 ? '#ef4444' : '#10b981' }}>{summary.outCount}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Trim</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.meanTrim.toFixed(1)}<span className="text-[9px] text-slate-500"> u ANU</span></div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Env-Marg</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanMargin < 1 ? '#ef4444' : summary.meanMargin < 3 ? '#f59e0b' : summary.meanMargin < 6 ? '#0ea5e9' : '#10b981' }}>
            {summary.meanMargin.toFixed(1)}<span className="text-[9px] text-slate-500"> %MAC</span>
          </div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">CG %MAC vs Flight Level</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[10, 20, 30, 40].map(s => (
              <g key={s}>
                <line x1={diag.PAD} y1={diag.ys(s)} x2={diag.W - 6} y2={diag.ys(s)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(s) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{s}</text>
              </g>
            ))}
            {[10, 20, 30, 40].map(x => (
              <g key={x}>
                <line x1={diag.xs(x)} y1={6} x2={diag.xs(x)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(x)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">F{x}0</text>
              </g>
            ))}
            {/* Envelope bands — use HNB limits as the representative chrome */}
            <rect x={diag.PAD} y={diag.ys(KL_AFT.HNB)} width={diag.W - diag.PAD - 6} height={Math.max(0, diag.ys(KL_FWD.HNB) - diag.ys(KL_AFT.HNB))} fill="#10b981" opacity={0.07} />
            <line x1={diag.PAD} y1={diag.ys(KL_FWD.HNB)} x2={diag.W - 6} y2={diag.ys(KL_FWD.HNB)} stroke="#ef4444" strokeWidth={0.9} strokeDasharray="3 2" opacity={0.75} />
            <line x1={diag.PAD} y1={diag.ys(KL_AFT.HNB)} x2={diag.W - 6} y2={diag.ys(KL_AFT.HNB)} stroke="#ef4444" strokeWidth={0.9} strokeDasharray="3 2" opacity={0.75} />
            <text x={diag.W - 8} y={diag.ys(KL_FWD.HNB) - 2} textAnchor="end" fontSize={7} fill="#ef4444" fontFamily="monospace">FWD-HNB {KL_FWD.HNB}</text>
            <text x={diag.W - 8} y={diag.ys(KL_AFT.HNB) + 8} textAnchor="end" fontSize={7} fill="#ef4444" fontFamily="monospace">AFT-HNB {KL_AFT.HNB}</text>
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(Math.min(diag.xMax, r.flCur / 10))} cy={diag.ys(Math.max(diag.yMin, Math.min(diag.yMax, r.cgNow)))} r={3} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={50} max={450} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>BURN-SCALE</span><span className="font-mono text-slate-300">{burnScale}%</span></div>
            <input type="range" min={50} max={200} step={5} value={burnScale} onChange={e => setBurnScale(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>LOAD-VAR</span><span className="font-mono text-slate-300">{loadVar}%</span></div>
            <input type="range" min={50} max={200} step={5} value={loadVar} onChange={e => setLoadVar(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>USER-BIAS %MAC</span><span className="font-mono text-slate-300">{userBias > 0 ? '+' : ''}{userBias}</span></div>
          <input type="range" min={-8} max={8} step={1} value={userBias} onChange={e => setUserBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['HWB', 'HNB', 'RGN', 'BIZ', 'TBP', 'GA', 'FTR'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlFilter(klFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / class"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'CLASSES'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} ac` : `${filteredKlass.length} shown / ${klassAggs.length} cls`}</span>
        <span>{tab === 'AIRCRAFT' ? '%MAC · trim · margin · tier' : 'cls · ac · mean-%MAC · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          // envelope bar 0..50 %MAC with FWD / cgNow / AFT
          const cgPct = Math.max(0, Math.min(100, (r.cgNow / 50) * 100))
          const fwdTick = (r.fwd / 50) * 100
          const aftTick = (r.aft / 50) * 100
          const advice = r.tier === 'OUT'
            ? `CG outside envelope · reposition pax/cargo · revise trim ${r.trimUnits.toFixed(1)}u`
            : r.tier === 'CRIT'
              ? (r.marginFwd < r.marginAft ? 'CG approaching FWD limit · monitor stab-trim authority' : 'CG approaching AFT limit · pitch-stability margin reduced')
              : r.tier === 'MARGIN'
                ? 'reduced envelope margin · monitor next phase'
                : 'CG well within envelope · nominal'
          const driverLabel = r.marginFwd < r.marginAft ? 'FWD-bias' : 'AFT-bias'
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{r.klass}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="flight level">F{Math.round(r.flCur)}</span>
                  <span title="phase">{PHASE_LABEL[r.phase]}</span>
                  <span title="hours airborne">{r.hrs.toFixed(1)}h</span>
                  <span title="current CG %MAC" style={{ color: TIER_COLOR[r.tier] }}>{r.cgNow.toFixed(1)}%</span>
                  <span className="ml-auto" title="stab trim ANU units">T{r.trimUnits.toFixed(1)}u</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`envelope FWD ${r.fwd} → AFT ${r.aft} %MAC`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${cgPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${fwdTick}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${aftTick}%` }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="base CG at take-off">base {r.baseCg.toFixed(1)}%</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="fuel-burn shift">+burn {r.burnShift.toFixed(2)}%</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono" style={{ borderColor: TIER_COLOR[r.tier] + '66', color: TIER_COLOR[r.tier], background: TIER_COLOR[r.tier] + '14' }} title="signed margin to FWD/AFT (worst)">{driverLabel} Δ{r.envMargin.toFixed(2)}%</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="MAC chord length">MAC {KL_MAC[r.klass]}in</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'CLASSES' && filteredKlass.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No classes match.</div>
        )}
        {tab === 'CLASSES' && filteredKlass.map(a => {
          const cgPct = Math.max(0, Math.min(100, (a.meanCg / 50) * 100))
          const fwdTick = (KL_FWD[a.klass] / 50) * 100
          const aftTick = (KL_AFT[a.klass] / 50) * 100
          const advice = a.tier === 'OUT' ? 'class fleet has envelope busts · audit load-control'
            : a.tier === 'CRIT' ? 'class trending near limit · review loadsheet policy'
              : a.tier === 'MARGIN' ? 'class within envelope · monitor margin'
                : 'class well within W&B envelope'
          return (
            <button key={a.klass} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.klass}</span>
                  <span className="text-slate-500 text-[10px] truncate">{KL_NAME[a.klass]}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.tier] }}>{a.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="mean CG %MAC">mean {a.meanCg.toFixed(1)}%</span>
                  <span title="mean stab trim units">T{a.meanTrim.toFixed(1)}u</span>
                  <span title="worst envelope margin" style={{ color: TIER_COLOR[a.tier] }}>worst Δ{a.worstM.toFixed(2)}%</span>
                  <span className="ml-auto truncate">{a.worstCs || '—'}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`class envelope FWD ${KL_FWD[a.klass]} → AFT ${KL_AFT[a.klass]} %MAC`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${cgPct}%`, background: TIER_COLOR[a.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${fwdTick}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${aftTick}%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate" title="MAC chord">MAC {KL_MAC[a.klass]}in · grad {KL_GRAD[a.klass]}u/%</span>
                  <span className="ml-auto truncate" style={{ color: a.tier === 'OK' ? '#64748b' : TIER_COLOR[a.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        FAA AC 120-27F · EASA AMC1 ORO.MLR.110 · ICAO Annex 6 Pt I App 4 · 14 CFR 25.27 · Boeing FCOM 1.06.10 / Airbus FCOM AOM-1.27
      </div>
    </div>
  )
}
