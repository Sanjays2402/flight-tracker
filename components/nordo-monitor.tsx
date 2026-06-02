'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   NORDO / Lost-Comm Monitor
   -----------------------------------------------------------
   Detects radio-failure / two-way-communications-failure (NORDO,
   "No Radio") candidates from the live ADS-B picture using only
   passive signals — squawk code, transponder behaviour, lateral
   deviation from the projected flight-plan track, and altitude
   discipline relative to expected cruise — then projects the
   FAR 91.185 / ICAO Doc 4444 §15.3 lost-comm contingency
   routing every NORDO candidate must follow so a controller
   can pre-clear airspace ahead.

   For every airborne aircraft above MIN-FL the monitor scores
   four independent NORDO indicators:

   1) SQ-7600  squawk = 7600 is the ICAO worldwide universal
      radio-failure code. Hard +0.80 to score. (Squawk 7700 is
      general emergency — separate channel, ignored here unless
      the WX/COMM-FAIL indicator suggests it's a comms failure
      escalated.)
   2) SQ-STALE squawk code unchanged AND track unchanged for >
      tunable STALE-MIN slider (default 8min) while VS|<200fpm,
      consistent with a crew who set autopilot, lost comms, and
      continued the last assigned route per FAR 91.185(c)(1)(i)
      assigned-route rule. +0.30.
   3) TRACK-DRIFT current track delta vs straight-line bearing
      to the in-track best-destination > DRIFT-DEG slider
      (default 12deg) AND no recent heading change (proxy:
      vertRate ~ 0). Indicates the airframe is still flying a
      pre-loaded FMS leg the controller has cleared off of.
      +0.25.
   4) ALT-OFF current altitude differs from class-typical cruise
      FL by > ALT-OFF-FT slider (default 4000ft) while VS is
      level. The flight is "on the wrong altitude" — possibly
      because the assigned step-climb was never received. +0.25.
   Composite SCORE in 0..1. Classified into 4 tiers:
     NORDO    score >= 0.80 rose    (active radio failure)
     SUSPECT  score >= 0.45 amber   (treat as NORDO probable)
     WATCH    score >= 0.20 sky     (monitor: anomalous behaviour)
     OK       score <  0.20 emerald (normal two-way comms)

   For every NORDO/SUSPECT/WATCH aircraft the monitor synthesises
   the FAR 91.185(c) lost-comm contingency routing:

     ROUTE:  per (c)(1) -- Assigned > Vectored > Expected > Filed
       since we have no flight-plan source we use ASSIGNED proxy
       (the current ground track projected forward) which is the
       statistically most common controller-cleared route in the
       last vector. Holds the great-circle until intercepting the
       best-destination airport.

     ALTITUDE: per (c)(2) -- highest of Assigned / MEA along the
       route / Expected. We synthesise MEA from terrain-free
       sectors as max(currentAlt, classMin) where classMin is the
       class IFR minimum, and ASSIGNED = currentAlt, EXPECTED =
       class cruise FL. Reports the controlling rule of the three.

     ETA-DEST: distance / GS

     LEAVE-CLEARANCE-LIMIT TIME: per (c)(3) for non-radar IFR --
       at clearance-limit fix (treated as destination IAF) the
       crew commences descent / approach at EFC or, if no EFC,
       at ETA. We report the EFC = ETA - 5min as the time the
       crew is required to leave the holding pattern.

   MapLibre overlay paints:
     - Tier-coloured halo ring around aircraft sized by score
       (8-22px)
     - Dashed tier-coloured FAR 91.185 projected route line from
       aircraft along ground track to best-destination with
       diamond ICAO marker
     - Tier-coloured aircraft labels callsign + tier + SCORE%
     - Per active NORDO/SUSPECT aircraft, an amber 30nm "no-fly
       buffer" circle for traffic separation guidance (24-vertex
       polygon)

   Side panel:
     - 4-tier counter strip click-to-filter
     - 3-cell NORDO-COUNT / MEAN-SCORE / WORST-CALLSIGN summary
     - SVG SCORE-vs-AGE diagram (x-axis SQ-STALE age minutes
       0..60, y-axis composite score 0..1, threshold horizontals
       rose 0.80, amber 0.45, sky 0.20 with right-anchored labels,
       every aircraft plotted as tier-coloured dot)
     - 5 sliders: MIN-FL, STALE-MIN, DRIFT-DEG, ALT-OFF-FT,
       MAX-FL in 2-column grid
     - 7-class chip filter (heavy/narrow/regional/biz/turboprop
       /ga/fighter)
     - HALO/PROJ/LBL/DIAG/BUFFER toggle row
     - Search callsign/type/operator/icao/squawk
     - Ranked list sorted tier-worst-first then score desc with
       tier color stripe, callsign+type+class-pill+tier-pill,
       FL/GS/squawk/age line, tier-coloured score progress bar
       0-100% with rose/amber/sky threshold ticks at 20/45/80,
       drift-deg/alt-off-ft footer, FAR 91.185 ROUTE/ALT/TIME
       advice triple footer tier-coloured, operator+destination
       footer (click-to-fly)

   Registered under Layers > Safety & Traffic category.
   ft-nordo persisted preference.
   ============================================================ */

export interface NordoFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: string
  squawk?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  vertRate: number
  ground: boolean
  emergency?: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: NordoFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'NORDO' | 'SUSPECT' | 'WATCH' | 'OK'
const TIER_COLOR: Record<Tier, string> = {
  NORDO: '#ef4444',
  SUSPECT: '#f59e0b',
  WATCH: '#0ea5e9',
  OK: '#10b981',
}
const TIER_ORDER: Tier[] = ['NORDO', 'SUSPECT', 'WATCH', 'OK']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}

interface ClassSpec {
  cruiseFl: number
  ifrMin: number  // class min IFR altitude in ft (proxy for MEA)
  cruiseGs: number
}
const SPEC: Record<Klass, ClassSpec> = {
  heavy:     { cruiseFl: 370, ifrMin: 25000, cruiseGs: 480 },
  narrow:    { cruiseFl: 360, ifrMin: 22000, cruiseGs: 450 },
  regional:  { cruiseFl: 290, ifrMin: 18000, cruiseGs: 380 },
  biz:       { cruiseFl: 410, ifrMin: 28000, cruiseGs: 460 },
  turboprop: { cruiseFl: 230, ifrMin: 12000, cruiseGs: 280 },
  ga:        { cruiseFl: 100, ifrMin: 6000,  cruiseGs: 130 },
  fighter:   { cruiseFl: 380, ifrMin: 20000, cruiseGs: 520 },
}

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'ga'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CRJ9|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS)/.test(x)) return 'fighter'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'turboprop'
  return 'narrow'
}

const D2R = Math.PI / 180
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)))
}
function gcBearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R, dλ = (lo2 - lo1) * D2R
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return ((Math.atan2(y, x) / D2R) + 360) % 360
}
function headingDelta(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}

// 24-vertex circle for separation buffer
function circlePolygon(lat: number, lng: number, radiusNm: number, n = 24): [number, number][] {
  const coords: [number, number][] = []
  const latR = radiusNm / 60
  for (let i = 0; i <= n; i++) {
    const θ = (i / n) * 2 * Math.PI
    const dLat = latR * Math.cos(θ)
    const dLng = (radiusNm / 60) * Math.sin(θ) / Math.max(0.2, Math.cos(lat * D2R))
    coords.push([lng + dLng, lat + dLat])
  }
  return coords
}

// per-icao stale tracker (module-scope persistence across renders)
interface Trace { sq: string; trk: number; alt: number; t: number }
const TRACE: Map<string, Trace> = new Map()
function ageMin(now: number, t: number): number { return (now - t) / 60000 }

const ALL_AP = AIRPORTS.filter(a => a.a && a.a.length === 3)

interface Row {
  f: NordoFlight
  klass: Klass
  altFt: number
  gs: number
  trk: number
  squawk: string
  ageMin: number      // sq+trk+alt stable for this many minutes
  driftDeg: number    // current track vs bearing-to-destination
  altOffFt: number    // alt diff vs class cruise
  sScore: number      // composite 0..1
  tier: Tier
  destI: string
  destIcao: string
  destName: string
  destLat: number
  destLng: number
  destNm: number
  etaMin: number
  efcMin: number
  routeRule: string   // FAR 91.185(c)(1) source
  altRule: string     // FAR 91.185(c)(2) source
  altCommand: number  // commanded altitude per (c)(2)
  reasons: string[]
}

const SRC_RING = 'nordo-ring', SRC_PROJ = 'nordo-proj', SRC_DOT = 'nordo-dot'
const SRC_LBL = 'nordo-lbl', SRC_BUF = 'nordo-buf'
const LYR_RING = 'nordo-ring-l', LYR_PROJ = 'nordo-proj-l', LYR_DOT = 'nordo-dot-l'
const LYR_LBL = 'nordo-lbl-l', LYR_BUF_F = 'nordo-buf-fill-l', LYR_BUF_O = 'nordo-buf-out-l'

export default function NordoMonitor({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(50)
  const [maxFl, setMaxFl] = useState(450)
  const [staleMin, setStaleMin] = useState(8)
  const [driftDegThresh, setDriftDegThresh] = useState(12)
  const [altOffThresh, setAltOffThresh] = useState(4000)
  const [showRing, setShowRing] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [showBuffer, setShowBuffer] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const now = Date.now()
    // GC pass for stale trace entries
    if (TRACE.size > 5000) {
      for (const [k, v] of TRACE.entries()) if (now - v.t > 30 * 60000) TRACE.delete(k)
    }
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl || flCur > maxFl) continue
      const klass = classify(f.type, f.category)
      const spec = SPEC[klass]
      const gs = Math.max(60, f.velocityKts || spec.cruiseGs)
      const trk = f.track || 0
      const squawk = (f.squawk || '').trim()
      const vs = f.vertRate || 0

      // stable-trace tracking: if sq+trk+alt all close to last sample, retain timestamp
      const prev = TRACE.get(f.icao)
      let stableSince = now
      if (prev) {
        const sqSame = prev.sq === squawk
        const trkSame = Math.abs(((prev.trk - trk + 540) % 360) - 180) < 3
        const altSame = Math.abs(prev.alt - f.altitudeFt) < 300
        if (sqSame && trkSame && altSame) stableSince = prev.t
      }
      TRACE.set(f.icao, { sq: squawk, trk, alt: f.altitudeFt, t: stableSince })
      const age = ageMin(now, stableSince)

      // Find best destination (in-track airport) for drift calc + 91.185 routing target
      let best: { i: string, icao: string, name: string, lat: number, lng: number, distNm: number, brg: number } | null = null
      for (const ap of ALL_AP) {
        const d = gcDistNm(f.lat, f.lng, ap.lat, ap.lon)
        if (d < 8 || d > 1200) continue
        const br = gcBearingDeg(f.lat, f.lng, ap.lat, ap.lon)
        if (headingDelta(br, trk) > 75) continue
        if (!best || d < best.distNm) best = { i: ap.a, icao: ap.i, name: ap.m || ap.n || ap.a, lat: ap.lat, lng: ap.lon, distNm: d, brg: br }
      }
      // If no in-track destination, still report (route is "continue current track")
      const drift = best ? headingDelta(trk, best.brg) : 0
      const altOff = Math.abs(f.altitudeFt - spec.cruiseFl * 100)

      // Score components
      const reasons: string[] = []
      let s = 0
      if (squawk === '7600') { s += 0.80; reasons.push('SQ 7600') }
      if (age >= staleMin && Math.abs(vs) < 200) { s += 0.30; reasons.push(`stale ${age.toFixed(0)}m`) }
      if (drift > driftDegThresh && Math.abs(vs) < 200 && best) { s += 0.25; reasons.push(`drift ${drift.toFixed(0)}°`) }
      if (altOff > altOffThresh && Math.abs(vs) < 200) { s += 0.25; reasons.push(`alt-off ${(altOff/1000).toFixed(1)}k`) }
      // Cap and squawk-7600 floor
      if (squawk === '7600' && s < 0.80) s = 0.80
      s = Math.max(0, Math.min(1, s))

      let tier: Tier
      if (s >= 0.80) tier = 'NORDO'
      else if (s >= 0.45) tier = 'SUSPECT'
      else if (s >= 0.20) tier = 'WATCH'
      else tier = 'OK'

      // Skip OK from displayed rows for performance — show only ones flagged
      if (tier === 'OK' && squawk !== '7600') continue

      // FAR 91.185 routing
      const destNm = best ? best.distNm : 0
      const etaMin = best ? (destNm / gs) * 60 : 0
      const efcMin = best ? Math.max(0, etaMin - 5) : 0
      const routeRule = best ? 'ASSIGNED (track-hold)' : 'EXPECTED (continue)'
      // c(2) highest-of MEA / Assigned / Expected
      const assigned = f.altitudeFt
      const mea = spec.ifrMin
      const expected = spec.cruiseFl * 100
      const altCommand = Math.max(assigned, mea, expected)
      const altRule = altCommand === assigned ? 'ASSIGNED' : altCommand === mea ? 'MEA' : 'EXPECTED'

      out.push({
        f, klass, altFt: f.altitudeFt, gs, trk, squawk, ageMin: age,
        driftDeg: drift, altOffFt: altOff, sScore: s, tier,
        destI: best ? best.i : '—', destIcao: best ? best.icao : '',
        destName: best ? best.name : '', destLat: best ? best.lat : f.lat, destLng: best ? best.lng : f.lng,
        destNm, etaMin, efcMin, routeRule, altRule, altCommand, reasons,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return b.sScore - a.sScore
    })
    return out
  }, [flights, minFl, maxFl, staleMin, driftDegThresh, altOffThresh])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { NORDO: 0, SUSPECT: 0, WATCH: 0, OK: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let meanScore = 0, worstScore = -1, worstCs = ''
    for (const r of rows) {
      meanScore += r.sScore
      if (r.sScore > worstScore) { worstScore = r.sScore; worstCs = (r.f.callsign || r.f.icao).trim() }
    }
    if (rows.length > 0) meanScore /= rows.length
    if (worstScore < 0) worstScore = 0
    return { total: rows.length, meanScore, worstScore, worstCs, nordoCount: tally.NORDO }
  }, [rows, tally])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.squawk, r.destI, r.destIcao].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + r.sScore * 14 },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier !== 'OK' && r.destIcao).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.destLng, r.destLat]] },
    })) : [] }
    const dotFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier !== 'OK' && r.destIcao).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: r.destI },
      geometry: { type: 'Point' as const, coordinates: [r.destLng, r.destLat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${r.tier} ${(r.sScore * 100).toFixed(0)}%`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const bufFc = { type: 'FeatureCollection' as const, features: showBuffer ? rows.filter(r => r.tier === 'NORDO' || r.tier === 'SUSPECT').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Polygon' as const, coordinates: [circlePolygon(r.f.lat, r.f.lng, 30)] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_BUF, bufFc, () => {
        map.addLayer({ id: LYR_BUF_F, type: 'fill', source: SRC_BUF, paint: {
          'fill-color': ['get', 'color'], 'fill-opacity': 0.06,
        } })
        map.addLayer({ id: LYR_BUF_O, type: 'line', source: SRC_BUF, paint: {
          'line-color': ['get', 'color'], 'line-width': 1.1, 'line-opacity': 0.55, 'line-dasharray': [2, 3],
        } })
      })
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'circle', source: SRC_RING, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.6,
        'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.6, 'line-opacity': 0.75, 'line-dasharray': [3, 2],
      } }))
      ensure(SRC_DOT, dotFc, () => map.addLayer({ id: LYR_DOT, type: 'circle', source: SRC_DOT, paint: {
        'circle-radius': 4.5, 'circle-color': ['get', 'color'],
        'circle-stroke-color': '#020617', 'circle-stroke-width': 1.2,
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: {
        'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2,
      } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_DOT, LYR_PROJ, LYR_RING, LYR_BUF_O, LYR_BUF_F]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_DOT, SRC_PROJ, SRC_RING, SRC_BUF]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showRing, showProj, showLabels, showBuffer])

  const diag = useMemo(() => {
    const W = 360, H = 160, PAD = 24
    const xs = (m: number) => PAD + Math.max(0, Math.min(1, m / 60)) * (W - PAD - 6)
    const ys = (s: number) => 6 + (1 - Math.max(0, Math.min(1, s))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">NORDO / Lost-Comm</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} flagged</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800">
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">NORDO</div>
          <div className="font-mono text-sm" style={{ color: summary.nordoCount > 0 ? '#ef4444' : '#10b981' }}>{summary.nordoCount}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Score</div>
          <div className="font-mono text-sm" style={{ color: summary.meanScore >= 0.80 ? '#ef4444' : summary.meanScore >= 0.45 ? '#f59e0b' : summary.meanScore >= 0.20 ? '#0ea5e9' : '#10b981' }}>
            {(summary.meanScore * 100).toFixed(0)}<span className="text-[9px] text-slate-500">%</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${(summary.worstScore * 100).toFixed(0)}%` : '—'}
          </div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Score vs stable-age · FAR 91.185 candidates</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[{v:0.80,c:'#ef4444',lbl:'NORDO 0.80'},{v:0.45,c:'#f59e0b',lbl:'SUSPECT 0.45'},{v:0.20,c:'#0ea5e9',lbl:'WATCH 0.20'}].map(({v,c,lbl}) => (
              <g key={v}>
                <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)} stroke={c} strokeWidth={1} strokeDasharray="4 2" opacity={0.55} />
                <text x={diag.W - 8} y={diag.ys(v) - 2} textAnchor="end" fontSize={8} fill={c} fontFamily="monospace">{lbl}</text>
              </g>
            ))}
            {[0.25,0.50,0.75,1.0].map(v => (
              <g key={`g${v}`}>
                <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(v) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{(v * 100).toFixed(0)}</text>
              </g>
            ))}
            {[10,20,30,45,60].map(m => (
              <g key={m}>
                <line x1={diag.xs(m)} y1={6} x2={diag.xs(m)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(m)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{m}m</text>
              </g>
            ))}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(Math.min(60, r.ageMin))} cy={diag.ys(r.sScore)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.95} />
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
            <input type="range" min={50} max={500} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>STALE</span><span className="font-mono text-slate-300">{staleMin}min</span></div>
            <input type="range" min={2} max={30} step={1} value={staleMin} onChange={e => setStaleMin(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>DRIFT</span><span className="font-mono text-slate-300">{driftDegThresh}°</span></div>
            <input type="range" min={5} max={45} step={1} value={driftDegThresh} onChange={e => setDriftDegThresh(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div className="col-span-2">
            <div className="flex justify-between text-[10px] text-slate-500"><span>ALT-OFF</span><span className="font-mono text-slate-300">{altOffThresh}ft</span></div>
            <input type="range" min={1000} max={10000} step={500} value={altOffThresh} onChange={e => setAltOffThresh(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klassFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['heavy', 'narrow', 'regional', 'biz', 'turboprop', 'ga', 'fighter'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klassFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{KLASS_LABEL[k]}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRing} onChange={e => setShowRing(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showBuffer} onChange={e => setShowBuffer(e.target.checked)} className="accent-sky-500" /><span>BUFFER</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao / squawk"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{filtered.length} shown / {rows.length} flagged</span>
        <span>FAR 91.185 · ICAO 4444 §15.3</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No NORDO candidates.</div>
        )}
        {filtered.map(r => {
          const sPct = r.sScore * 100
          const advice = r.tier === 'NORDO' ? 'separate · clear airspace · vector traffic away'
            : r.tier === 'SUSPECT' ? 'attempt comms on alt freq · prepare lost-comm plan'
            : 'monitor · verify last clearance'
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
                  <span title="flight level">F{Math.round(r.altFt / 100)}</span>
                  <span title="ground speed">{r.gs.toFixed(0)}kt</span>
                  <span title="squawk" className={r.squawk === '7600' ? 'text-rose-400 font-bold' : ''}>SQ{r.squawk || '----'}</span>
                  <span title="stable age">{r.ageMin.toFixed(0)}m</span>
                  <span className="ml-auto" title="composite NORDO score" style={{ color: TIER_COLOR[r.tier] }}>{sPct.toFixed(0)}%</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="score 0-100%">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${sPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `20%` }} title="watch 20%" />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `45%` }} title="suspect 45%" />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `80%` }} title="NORDO 80%" />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="track drift vs in-track destination">drift {r.driftDeg.toFixed(0)}°</span>
                  <span title="altitude off class cruise">off {(r.altOffFt/1000).toFixed(1)}k</span>
                  <span className="ml-auto truncate">{r.reasons.join(' · ') || 'baseline'}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] font-mono mt-0.5" style={{ color: TIER_COLOR[r.tier] }}>
                  <span title="FAR 91.185(c)(1) route source">RTE {r.routeRule}</span>
                  <span title="FAR 91.185(c)(2) altitude rule">ALT {r.altRule} {Math.round(r.altCommand/100)}</span>
                  <span className="ml-auto" title="EFC = ETA-5min per (c)(3)">EFC {r.efcMin.toFixed(0)}m</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" title="destination">{r.destIcao ? `${r.destIcao} · ${r.destName}` : 'no in-track dest'}</span>
                </div>
                <div className="text-[10px] mt-0.5 truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
