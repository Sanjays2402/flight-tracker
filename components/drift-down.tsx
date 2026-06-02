'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS, type AirportPin } from './airports'

/* ============================================================
   Drift-Down / Engine-Out Reach Atlas
   -----------------------------------------------------------
   Multi-engine OEI (One-Engine-Inoperative) drift-down trajectory
   and divert-airport reachability monitor.

   When a twin/quad jet loses an engine at cruise the remaining
   engine(s) cannot sustain the original FL; the aircraft drifts
   down to its single-engine ceiling (a function of weight and
   ISA-DEV) while continuing forward at OEI-LRC. This panel
   computes, for every airborne aircraft above MIN-FL:

   1) Class-tuned OEI ceiling (HVY 770 17.0kft / NRW 320 22.5kft /
      RGN 250 16.0kft / BIZ 800 25.0kft / TBP 16.0 / FTR 35.0kft)
      adjusted by ISA-DEV slider (-1000ft per +10C above ISA).
   2) Drift-down vertical speed (HVY -380 / NRW -500 / RGN -450
      / BIZ -600 / TBP -350 / FTR -1500 fpm class default,
      scaled by VS-MULT slider 60-140 percent).
   3) OEI ground speed: typical class GS minus a class OEI-penalty
      (HVY -65 / NRW -45 / RGN -30 / BIZ -55 / TBP -25 / FTR -80 kt
      scaled by GS-MULT slider 60-140 percent).
   4) Time-to-ceiling = (currentAlt - ceilingFt) / |VS|
      Distance-covered-during-drift = oeiGs * timeMin/60 nm
      Drift-down endpoint waypoint projected along current track.
   5) Cruise reach radius from drift-endpoint:
      cruiseHrs = ENDURANCE slider hours
      reachNm = oeiGs * cruiseHrs
   6) Effective total reach circle = drift-distance + reachNm
      centered at current position, but we sample the more
      accurate dog-leg footprint (drift-endpoint + cruise-circle)
      to flag the nearest qualifying divert airport.
   7) Divert search: scan AIRPORTS within total reach radius,
      pick nearest acceptable field (LARGE only, distance from
      drift-endpoint must be <= reachNm). Tie-break on raw
      distance from current position.

   Tier classification (per aircraft):
     SAFE    >= 3 divert candidates in reach emerald
     OK      2 candidates in reach            sky
     MARGINAL 1 candidate in reach            amber
     CRITICAL 0 candidates in reach           rose

   "Candidates in reach" = airports within reachable footprint
   from drift-endpoint. Helicopters / GA single-engine class
   are skipped because OEI semantics don't apply.

   MapLibre overlay:
     - Tier-coloured halo ring around aircraft sized by tier
       severity (CRITICAL biggest)
     - Dashed amber drift-down line aircraft -> drift endpoint
     - Tier-coloured reach circle drawn as polygon at endpoint
       (16-segment regular polygon at reachNm radius)
     - Diamond marker at drift endpoint
     - Violet pin at chosen primary divert (nearest)
     - Labels callsign + ceiling-kft + tier + count

   Side panel:
     - 4-tier counter strip click-to-filter
     - 3-cell MEAN-CEIL-kft / WORST-COUNT / CRIT-COUNT summary
     - SVG drift-down profile diagram (x = elapsed-min 0-30,
       y = alt kft, one curve per class colour-coded showing
       drift trajectory from FL360 to its class ceiling)
     - 6 sliders MIN-FL / MAX-FL / ISA-DEV / VS-MULT / GS-MULT /
       ENDURANCE-HRS in 2-column grid
     - 7-class chip filter row
     - HALO / DRIFT / REACH / PIN / LBL toggles
     - Search callsign / type / operator / icao / IATA
     - AIRCRAFT tab sorted tier-worst-first then ceiling asc with
       tier color stripe, callsign + type + class + tier pills,
       ceil-kft + drift-min + drift-nm + oei-gs line, tier-
       coloured reach-count progress bar 0-6, primary-divert
       IATA + dist-nm + total-reach-nm line, operator + secondary
       divert footer, click-to-fly per row.

   Registered under Layers > Safety & Traffic category.
   ft-drift persisted preference.
   ============================================================ */

export interface DriftFlight {
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
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: DriftFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'SAFE' | 'OK' | 'MARGINAL' | 'CRITICAL'
const TIER_COLOR: Record<Tier, string> = {
  SAFE: '#10b981',
  OK: '#0ea5e9',
  MARGINAL: '#f59e0b',
  CRITICAL: '#ef4444',
}
const TIER_ORDER: Tier[] = ['CRITICAL', 'MARGINAL', 'OK', 'SAFE']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', fighter: 'FTR',
}

interface ClassSpec {
  ceilingFt: number   // single-engine service ceiling at ISA mid-weight
  driftVsFpm: number  // |drift-down vertical speed| at FL300
  oeiGs: number       // OEI LRC ground speed kt
  cruiseFl: number    // typical original cruise FL (for diagram)
}
const SPEC: Record<Klass, ClassSpec> = {
  heavy:     { ceilingFt: 17000, driftVsFpm: 380, oeiGs: 320, cruiseFl: 370 },
  narrow:    { ceilingFt: 22500, driftVsFpm: 500, oeiGs: 280, cruiseFl: 360 },
  regional:  { ceilingFt: 16000, driftVsFpm: 450, oeiGs: 230, cruiseFl: 290 },
  biz:       { ceilingFt: 25000, driftVsFpm: 600, oeiGs: 350, cruiseFl: 410 },
  turboprop: { ceilingFt: 16000, driftVsFpm: 350, oeiGs: 180, cruiseFl: 230 },
  fighter:   { ceilingFt: 35000, driftVsFpm: 1500, oeiGs: 350, cruiseFl: 380 },
}

function classify(t: string | undefined): Klass | null {
  const x = (t || '').toUpperCase()
  // Skip helicopters & single-engine GA — OEI not applicable
  if (/^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return null
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|PA|M20|TB)/.test(x)) return null
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CRJ9|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS)/.test(x)) return 'fighter'
  // F16 = single engine, skip
  if (/^F16/.test(x)) return null
  if (/^(DA62|BE9|BE3|TBM|PC12|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'turboprop'
  return 'narrow' // default for unknown jet-shaped types
}

const D2R = Math.PI / 180, R2D = 180 / Math.PI
const R_NM = 3440.065

function gcDistNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = lat1 * D2R, φ2 = lat2 * D2R
  const dφ = (lat2 - lat1) * D2R
  const dλ = (lng2 - lng1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}

function projectGc(lat: number, lng: number, brgDeg: number, distNm: number): { lat: number, lng: number } {
  const d = distNm / R_NM
  const br = brgDeg * D2R
  const φ1 = lat * D2R, λ1 = lng * D2R
  const sφ2 = Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(br)
  const φ2 = Math.asin(sφ2)
  const y = Math.sin(br) * Math.sin(d) * Math.cos(φ1)
  const x = Math.cos(d) - Math.sin(φ1) * sφ2
  const λ2 = λ1 + Math.atan2(y, x)
  return { lat: φ2 * R2D, lng: ((λ2 * R2D + 540) % 360) - 180 }
}

interface Row {
  f: DriftFlight
  klass: Klass
  altFt: number
  trk: number
  ceilingFt: number
  driftVsFpm: number
  oeiGs: number
  driftMin: number
  driftNm: number
  driftLat: number
  driftLng: number
  reachNm: number
  divertCount: number
  primary: AirportPin | null
  primaryDistNm: number
  secondary: AirportPin | null
  totalReachNm: number
  tier: Tier
}

const SRC_RING = 'drift-ring', SRC_LINE = 'drift-line', SRC_DOT = 'drift-dot'
const SRC_REACH = 'drift-reach', SRC_PIN = 'drift-pin', SRC_LBL = 'drift-lbl'
const LYR_RING = 'drift-ring-l', LYR_LINE = 'drift-line-l', LYR_DOT = 'drift-dot-l'
const LYR_REACH_FILL = 'drift-reach-fill-l', LYR_REACH_LINE = 'drift-reach-line-l'
const LYR_PIN = 'drift-pin-l', LYR_LBL = 'drift-lbl-l'

function ringPolygon(lat: number, lng: number, rNm: number, n = 24): number[][] {
  const out: number[][] = []
  for (let i = 0; i <= n; i++) {
    const brg = (i / n) * 360
    const p = projectGc(lat, lng, brg, rNm)
    out.push([p.lng, p.lat])
  }
  return out
}

export default function DriftDown({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(200)
  const [maxFl, setMaxFl] = useState(500)
  const [isaDev, setIsaDev] = useState(0)
  const [vsMult, setVsMult] = useState(100)
  const [gsMult, setGsMult] = useState(100)
  const [endurance, setEndurance] = useState(2.0)
  const [showRing, setShowRing] = useState(true)
  const [showLine, setShowLine] = useState(true)
  const [showReach, setShowReach] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const vm = Math.max(0.5, vsMult / 100)
    const gm = Math.max(0.5, gsMult / 100)
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl || flCur > maxFl) continue
      const klass = classify(f.type)
      if (!klass) continue
      const spec = SPEC[klass]
      // Ceiling adjusted for ISA-DEV: -1000ft per +10C
      const ceilingFt = Math.max(5000, spec.ceilingFt - (isaDev / 10) * 1000)
      const driftVsFpm = Math.max(50, spec.driftVsFpm * vm)
      const oeiGs = Math.max(60, spec.oeiGs * gm)
      const dropFt = Math.max(0, f.altitudeFt - ceilingFt)
      const driftMin = dropFt / driftVsFpm
      const driftNm = oeiGs * driftMin / 60
      const trk = ((f.track || 0) + 360) % 360
      const driftPt = projectGc(f.lat, f.lng, trk, driftNm)
      const reachNm = oeiGs * Math.max(0.1, endurance)
      const totalReachNm = driftNm + reachNm
      // Divert search around drift endpoint
      const candidates: { ap: AirportPin, d: number }[] = []
      for (const ap of AIRPORTS) {
        const d = gcDistNm(driftPt.lat, driftPt.lng, ap.lat, ap.lon)
        if (d <= reachNm) candidates.push({ ap, d })
      }
      candidates.sort((a, b) => a.d - b.d)
      const primary = candidates[0]?.ap || null
      const primaryDistNm = candidates[0]?.d || 0
      const secondary = candidates[1]?.ap || null
      const count = candidates.length
      let tier: Tier
      if (count >= 3) tier = 'SAFE'
      else if (count === 2) tier = 'OK'
      else if (count === 1) tier = 'MARGINAL'
      else tier = 'CRITICAL'
      out.push({
        f, klass, altFt: f.altitudeFt, trk,
        ceilingFt, driftVsFpm, oeiGs, driftMin, driftNm,
        driftLat: driftPt.lat, driftLng: driftPt.lng,
        reachNm, divertCount: count, primary, primaryDistNm, secondary,
        totalReachNm, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return a.divertCount - b.divertCount
    })
    return out
  }, [flights, minFl, maxFl, isaDev, vsMult, gsMult, endurance])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { SAFE: 0, OK: 0, MARGINAL: 0, CRITICAL: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    const total = rows.length
    let meanCeil = 0, worstCount = Infinity, worstCs = '', critCount = 0
    for (const r of rows) {
      meanCeil += r.ceilingFt
      if (r.divertCount < worstCount) { worstCount = r.divertCount; worstCs = (r.f.callsign || r.f.icao).trim() }
      if (r.tier === 'CRITICAL') critCount++
    }
    if (total > 0) meanCeil /= total
    if (!isFinite(worstCount)) worstCount = 0
    return { total, meanCeil, worstCount, worstCs, critCount }
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.primary?.a, r.primary?.i, r.primary?.n].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + (3 - TIER_ORDER.indexOf(r.tier)) * 3 },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lineFc = { type: 'FeatureCollection' as const, features: showLine ? rows.filter(r => r.driftNm > 0.5).map(r => ({
      type: 'Feature' as const,
      properties: { color: '#f59e0b' },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.driftLng, r.driftLat]] },
    })) : [] }
    const dotFc = { type: 'FeatureCollection' as const, features: showLine ? rows.filter(r => r.driftNm > 0.5).map(r => ({
      type: 'Feature' as const,
      properties: { color: '#f59e0b' },
      geometry: { type: 'Point' as const, coordinates: [r.driftLng, r.driftLat] },
    })) : [] }
    const reachFc = { type: 'FeatureCollection' as const, features: showReach ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Polygon' as const, coordinates: [ringPolygon(r.driftLat, r.driftLng, r.reachNm, 24)] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.primary).map(r => ({
      type: 'Feature' as const,
      properties: { text: r.primary!.a },
      geometry: { type: 'Point' as const, coordinates: [r.primary!.lon, r.primary!.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${(r.ceilingFt / 1000).toFixed(0)}k ${r.tier} ${r.divertCount}`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_REACH, reachFc, () => {
        map.addLayer({ id: LYR_REACH_FILL, type: 'fill', source: SRC_REACH, paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': 0.06,
        } })
        map.addLayer({ id: LYR_REACH_LINE, type: 'line', source: SRC_REACH, paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.2,
          'line-opacity': 0.55,
          'line-dasharray': [2, 3],
        } })
      })
      ensure(SRC_LINE, lineFc, () => map.addLayer({ id: LYR_LINE, type: 'line', source: SRC_LINE, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.4,
        'line-opacity': 0.75,
        'line-dasharray': [3, 2],
      } }))
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'circle', source: SRC_RING, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.6,
        'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_DOT, dotFc, () => map.addLayer({ id: LYR_DOT, type: 'circle', source: SRC_DOT, paint: {
        'circle-radius': 4.5,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#020617',
        'circle-stroke-width': 1.2,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['get', 'text'],
        'text-size': 11,
        'text-offset': [0, 1.4],
        'text-anchor': 'top',
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      }, paint: {
        'text-color': '#a855f7',
        'text-halo-color': '#020617',
        'text-halo-width': 1.4,
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
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_DOT, LYR_RING, LYR_LINE, LYR_REACH_LINE, LYR_REACH_FILL]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_DOT, SRC_RING, SRC_LINE, SRC_REACH]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showRing, showLine, showReach, showPin, showLabels])

  // Diagram: drift-down profile for each class — alt vs elapsed-min
  const diag = useMemo(() => {
    const W = 360, H = 160, PAD = 24
    const xMax = 30   // minutes
    const yMax = 45   // kft
    const xs = (m: number) => PAD + (m / xMax) * (W - PAD - 6)
    const ys = (k: number) => 6 + (1 - Math.max(0, Math.min(yMax, k)) / yMax) * (H - PAD - 8)
    const classes: Klass[] = ['heavy', 'narrow', 'regional', 'biz', 'turboprop', 'fighter']
    const classColor: Record<Klass, string> = {
      heavy: '#8b5cf6', narrow: '#0ea5e9', regional: '#22d3ee',
      biz: '#a855f7', turboprop: '#84cc16', fighter: '#f59e0b',
    }
    return { W, H, PAD, xs, ys, xMax, yMax, classes, classColor }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,420px)] max-h-[80vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Drift-Down OEI</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} multi-engine</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[10px] font-bold" style={{ color: TIER_COLOR[t] }}>{t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Ceil</div>
          <div className="font-mono text-sm text-slate-200">{(summary.meanCeil / 1000).toFixed(1)}<span className="text-[9px] text-slate-500"> kft</span></div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] truncate" style={{ color: summary.worstCount === 0 ? '#ef4444' : summary.worstCount === 1 ? '#f59e0b' : '#10b981' }} title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstCount}` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Critical</div>
          <div className="font-mono text-sm" style={{ color: summary.critCount > 0 ? '#ef4444' : '#10b981' }}>{summary.critCount}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Drift-down profile · ISA{isaDev >= 0 ? '+' : ''}{isaDev}°C · alt kft vs min</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[10, 20, 30, 40].map(k => (
              <g key={k}>
                <line x1={diag.PAD} y1={diag.ys(k)} x2={diag.W - 6} y2={diag.ys(k)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(k) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{k}k</text>
              </g>
            ))}
            {[5, 10, 15, 20, 25].map(m => (
              <g key={m}>
                <line x1={diag.xs(m)} y1={6} x2={diag.xs(m)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(m)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{m}m</text>
              </g>
            ))}
            {/* class drift curves: linear from cruise FL down to adjusted ceiling at driftVs */}
            {diag.classes.map(k => {
              const dim = klassFilter !== 'ALL' && klassFilter !== k
              const spec = SPEC[k]
              const ceil = Math.max(5, (spec.ceilingFt - (isaDev / 10) * 1000) / 1000)
              const start = spec.cruiseFl / 10
              const vs = (spec.driftVsFpm * vsMult / 100) / 1000  // kft/min
              const endMin = vs > 0 ? Math.min(diag.xMax, (start - ceil) / vs) : diag.xMax
              const pts = [`${diag.xs(0)},${diag.ys(start)}`, `${diag.xs(endMin)},${diag.ys(ceil)}`]
              if (endMin < diag.xMax) pts.push(`${diag.xs(diag.xMax)},${diag.ys(ceil)}`)
              return (
                <g key={k}>
                  <polyline points={pts.join(' ')} fill="none" stroke={diag.classColor[k]} strokeWidth={1.2} opacity={dim ? 0.15 : 0.8} />
                  <circle cx={diag.xs(endMin)} cy={diag.ys(ceil)} r={2.2} fill={diag.classColor[k]} opacity={dim ? 0.2 : 0.9} />
                </g>
              )
            })}
            {/* aircraft dots at (driftMin, currentFL) showing where they start */}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(0)} cy={diag.ys(r.altFt / 1000)} r={2.2} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
            <g transform={`translate(${diag.PAD + 4},10)`}>
              {diag.classes.map((k, i) => (
                <g key={k} transform={`translate(${i * 44},0)`}>
                  <rect x={0} y={0} width={6} height={6} fill={diag.classColor[k]} opacity={0.8} />
                  <text x={9} y={6} fontSize={8} fill="#94a3b8" fontFamily="monospace">{KLASS_LABEL[k]}</text>
                </g>
              ))}
            </g>
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={50} max={500} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={100} max={550} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>ISA-DEV</span><span className="font-mono text-slate-300">{isaDev >= 0 ? '+' : ''}{isaDev}°C</span></div>
            <input type="range" min={-30} max={30} step={1} value={isaDev} onChange={e => setIsaDev(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>VS-MULT</span><span className="font-mono text-slate-300">{vsMult}%</span></div>
            <input type="range" min={60} max={140} step={5} value={vsMult} onChange={e => setVsMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>GS-MULT</span><span className="font-mono text-slate-300">{gsMult}%</span></div>
            <input type="range" min={60} max={140} step={5} value={gsMult} onChange={e => setGsMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>ENDURANCE</span><span className="font-mono text-slate-300">{endurance.toFixed(1)}h</span></div>
            <input type="range" min={0.5} max={4} step={0.1} value={endurance} onChange={e => setEndurance(parseFloat(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klassFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['heavy', 'narrow', 'regional', 'biz', 'turboprop', 'fighter'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klassFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{KLASS_LABEL[k]}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRing} onChange={e => setShowRing(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLine} onChange={e => setShowLine(e.target.checked)} className="accent-sky-500" /><span>DRIFT</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showReach} onChange={e => setShowReach(e.target.checked)} className="accent-sky-500" /><span>REACH</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao / IATA"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{filtered.length} shown / {rows.length} tracked</span>
        <span>ceil · drift · divert · reach</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No multi-engine aircraft match.</div>
        )}
        {filtered.map(r => {
          // reach-count bar 0..6
          const cPct = Math.min(100, (r.divertCount / 6) * 100)
          const advice = r.tier === 'CRITICAL' ? 'no divert in reach — declare' :
            r.tier === 'MARGINAL' ? `single option ${r.primary?.a}` :
            r.tier === 'OK' ? `${r.primary?.a} primary` : `${r.primary?.a} / ${r.secondary?.a || '—'}`
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{KLASS_LABEL[r.klass]}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="current FL">F{Math.round(r.altFt / 100)}</span>
                  <span title="OEI service ceiling kft">ceil {(r.ceilingFt / 1000).toFixed(1)}k</span>
                  <span title="drift-down time min">{r.driftMin.toFixed(1)}m</span>
                  <span title="drift-down distance nm">{r.driftNm.toFixed(0)}nm</span>
                  <span className="ml-auto" title="OEI ground speed">{r.oeiGs.toFixed(0)}kt</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="divert candidates in reach (0..6)">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${cPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-px bg-rose-400" style={{ left: `${(1 / 6) * 100}%` }} title="marginal threshold (1)" />
                  <div className="absolute inset-y-0 w-px bg-amber-400" style={{ left: `${(2 / 6) * 100}%` }} title="ok threshold (2)" />
                  <div className="absolute inset-y-0 w-px bg-emerald-400" style={{ left: `${(3 / 6) * 100}%` }} title="safe threshold (3)" />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span style={{ color: TIER_COLOR[r.tier] }} title="divert count">{r.divertCount} divert</span>
                  {r.primary ? (
                    <>
                      <span className="text-violet-300" title="primary divert IATA">{r.primary.a}</span>
                      <span title="primary divert distance from drift endpoint">{r.primaryDistNm.toFixed(0)}nm</span>
                    </>
                  ) : (
                    <span className="text-rose-400">no divert</span>
                  )}
                  <span className="ml-auto" title="total reach (drift + cruise) nm">tot {r.totalReachNm.toFixed(0)}nm</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="cruise reach radius from drift endpoint">rch {r.reachNm.toFixed(0)}nm</span>
                  <span title="drift VS">{r.driftVsFpm.toFixed(0)}fpm</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'SAFE' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" title="primary divert name">{r.primary?.n || '—'}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
