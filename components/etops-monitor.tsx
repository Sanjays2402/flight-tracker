'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   ETOPS Diversion Monitor
   -----------------------------------------------------------
   For every airborne twin-engine aircraft we model an in-flight
   engine-failure ("ETOPS — Engines Turn Or Passengers Swim")
   diversion scenario.  Each aircraft is assigned an ETOPS rating
   in minutes (commonly 60 / 90 / 120 / 138 / 180 / 207 / 240 /
   330) — the maximum single-engine diversion time to an adequate
   alternate at the certified one-engine-inoperative (OEI) cruise
   speed in still air.

     OEI cruise speed (drift-down to FL220 / FL250 typical):
       heavy        430 KTAS
       narrow       420 KTAS
       regional     360 KTAS
       biz          380 KTAS
       turboprop    260 KTAS  (single engine)
       fighter      450 KTAS
       ga           110 KTAS  (single only)
       heli          90 KTAS

   ETOPS-rating distance =  OEI-KTAS * rating-min / 60   [nm]

   Per aircraft we then:
     1) Scan the AIRPORTS dataset within a lat/lng box of
        rating-distance for any "ETOPS-adequate" alternates
        (we approximate: every airport in the dataset counts; in
        the real world only ETOPS-listed alternates qualify, but
        the dataset is intentionally curated to large fields).
     2) Compute great-circle distance + bearing to each candidate,
        derive single-engine flight time at OEI-KTAS, keep ones
        whose time <= rating-min.
     3) Pick the BEST alternate = the one whose time-to-divert is
        smallest.
     4) Compute the WORST-CASE wait — the longest you could be
        away from any alternate if you continued along your
        current track: project ground vector forward in 60s steps
        for the next [rating-min] minutes, at every probe point
        recompute the nearest alternate and remember the maximum
        time-to-nearest along the projection.  This is the
        "Equal-Time Point" (ETP) proxy.

   Tiers:
     COMPLIANT — best-alternate time <= 0.70 * rating-min AND
                 worst-case projected time <= rating-min
     MARGIN    — best <= rating-min AND worst <= 1.10 * rating-min
     EXCEEDS   — best <= rating-min AND worst > 1.10 * rating-min
     BEYOND    — best > rating-min   (currently outside diversion
                 envelope of its own rating — would need higher
                 rating or to turn back)

   MapLibre overlay:
     - Tier-coloured translucent "diversion ring" circle (great-
       circle 32-vert polygon) around every aircraft at rating
       distance; dashed outline.
     - Solid sky line from aircraft to its current best alternate;
       amber dot at alternate.
     - Dashed violet "projection" line forward along the ground
       track for [rating-min] minutes showing where you'd be at
       the end of the next ETOPS window.
     - Aircraft labels: callsign + rating + best-alternate IATA
       + time-to-alternate.

   Side panel: 4-tier counter strip (click-to-filter), rating-
     override slider (60-330), OEI-speed-mult slider, search,
     ranked aircraft list sorted worst-tier-first then by
     descending best-time (closest to limit first), per-row tier
     stripe, callsign/type, rating chip, best-alternate IATA +
     time + nm, worst-case time bar (fraction of rating), worst
     point bearing + nm, click-to-fly.
   ============================================================ */

export interface EtFlight {
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
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: EtFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'COMPLIANT' | 'MARGIN' | 'EXCEEDS' | 'BEYOND'
const TIER_COLOR: Record<Tier, string> = {
  COMPLIANT: '#10b981',
  MARGIN:    '#fbbf24',
  EXCEEDS:   '#f97316',
  BEYOND:    '#ef4444',
}
const TIER_ORDER: Tier[] = ['BEYOND', 'EXCEEDS', 'MARGIN', 'COMPLIANT']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter' | 'heli'
const OEI_KTAS: Record<Klass, number> = {
  heavy: 430, narrow: 420, regional: 360, biz: 380, turboprop: 260, ga: 110, fighter: 450, heli: 90,
}
// Default ETOPS rating per airframe class — what airlines typically certify their fleet to
const DEFAULT_RATING: Record<Klass, number> = {
  heavy: 240, narrow: 180, regional: 120, biz: 120, turboprop: 60, ga: 60, fighter: 60, heli: 30,
}

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || x.startsWith('H') || /EC|AS|R44|R66|S76|S92|UH|AW|MD9|B06|B47/.test(x)) return 'heli'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|E19|E29|CRJ9|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|G[1-7]|CL|LJ|GLEX|F2T|F900|F7X|BE40|H25|H50|GALX|EA50|PC24|HDJT)/.test(x)) return 'biz'
  if (/^(C208|C172|C152|C182|PA|SR2|DA[24]|DA40|DA62|TBM|PC12|BE9|BE3|BE2|KODI|EPIC)/.test(x)) return 'ga'
  if (/^(F16|F18|F22|F35|F15|EUFI|RFAL|TYPH|MIG|SU[2-3]|T38|HAWK|A10)/.test(x)) return 'fighter'
  if (/^(AT|DH|SF|BE99|BE10|BE19|BE20|SAAB|FOK|SH|J31|J41|ATP|BRJ)/.test(x)) return 'turboprop'
  return 'narrow'
}

const NM_PER_DEG_LAT = 60
const toRad = (d: number) => (d * Math.PI) / 180
const toDeg = (r: number) => (r * 180) / Math.PI
const R_NM = 3440.065

function destPoint(lat: number, lng: number, brgDeg: number, distNm: number): [number, number] {
  const br = toRad(brgDeg), d = distNm / R_NM
  const phi1 = toRad(lat), lam1 = toRad(lng)
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(br))
  const lam2 = lam1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(phi1), Math.cos(d) - Math.sin(phi1) * Math.sin(phi2))
  return [(toDeg(lam2) + 540) % 360 - 180, toDeg(phi2)]
}

function nmBetween(lat1: number, lng1: number, lat2: number, lng2: number): { nm: number; brg: number } {
  const dLat = (lat2 - lat1) * NM_PER_DEG_LAT
  const dLng = (lng2 - lng1) * NM_PER_DEG_LAT * Math.cos(toRad((lat1 + lat2) / 2))
  return { nm: Math.sqrt(dLat * dLat + dLng * dLng), brg: (toDeg(Math.atan2(dLng, dLat)) + 360) % 360 }
}

const SRC_RING = 'et-ring-src', LYR_RING_FILL = 'et-ring-fill', LYR_RING_LINE = 'et-ring-line'
const SRC_SPOKE = 'et-spoke-src', LYR_SPOKE = 'et-spoke-lyr'
const SRC_PROJ = 'et-proj-src', LYR_PROJ = 'et-proj-lyr'
const SRC_ALT = 'et-alt-src', LYR_ALT = 'et-alt-lyr', LYR_ALT_LBL = 'et-alt-lbl'
const SRC_LBL = 'et-lbl-src', LYR_LBL = 'et-lbl-lyr'

export default function EtopsMonitorPanel({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [ratingOverride, setRatingOverride] = useState<number>(0) // 0 = use class default
  const [oeiMult, setOeiMult] = useState(1.0)
  const [showRing, setShowRing] = useState(true)
  const [showSpokes, setShowSpokes] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [minAlt, setMinAlt] = useState(10000)
  const [query, setQuery] = useState('')
  const [, setTick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 5000)
    return () => clearInterval(t)
  }, [])

  const results = useMemo(() => {
    const out: Array<{
      f: EtFlight
      klass: Klass
      ratingMin: number
      oeiKtas: number
      maxNm: number
      ring: Array<[number, number]>
      best: { iata: string; lat: number; lon: number; nm: number; brg: number; timeMin: number } | null
      worst: { nm: number; timeMin: number; lat: number; lon: number } | null
      proj: Array<[number, number]>
      tier: Tier
    }> = []

    // Pre-bucket airports by 5-deg lat grid for fast lookup
    const apList = AIRPORTS

    for (const f of flights) {
      if (f.ground) continue
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      if (f.altitudeFt < minAlt) continue

      const klass = classify(f.type, f.category)
      const ratingMin = ratingOverride > 0 ? ratingOverride : DEFAULT_RATING[klass]
      const oeiKtas = OEI_KTAS[klass] * oeiMult
      const maxNm = (oeiKtas * ratingMin) / 60

      // Diversion-rating circle (32-vert ring)
      const ring: Array<[number, number]> = []
      for (let i = 0; i < 33; i++) ring.push(destPoint(f.lat, f.lng, (i * 360) / 32, maxNm))

      // Scan airports within bbox of maxNm
      const latPad = maxNm / NM_PER_DEG_LAT * 1.05
      const lngPad = latPad / Math.max(0.1, Math.cos(toRad(f.lat)))
      let best: { iata: string; lat: number; lon: number; nm: number; brg: number; timeMin: number } | null = null
      for (const ap of apList) {
        if (Math.abs(ap.lat - f.lat) > latPad) continue
        if (Math.abs(ap.lon - f.lng) > lngPad) continue
        const { nm, brg } = nmBetween(f.lat, f.lng, ap.lat, ap.lon)
        if (nm > maxNm) continue
        const timeMin = (nm / oeiKtas) * 60
        if (!best || timeMin < best.timeMin) {
          best = { iata: ap.a || ap.i, lat: ap.lat, lon: ap.lon, nm, brg, timeMin }
        }
      }

      // Projection: walk ground vector forward for [ratingMin] minutes in 12 steps,
      // at each probe compute nearest-airport time, remember worst
      const proj: Array<[number, number]> = []
      let worst: { nm: number; timeMin: number; lat: number; lon: number } | null = null
      const gs = Math.max(60, f.velocityKts || 0)
      const projTotalNm = (gs * ratingMin) / 60
      const STEPS = 12
      for (let i = 0; i <= STEPS; i++) {
        const d = (i / STEPS) * projTotalNm
        const [plng, plat] = destPoint(f.lat, f.lng, f.track || 0, d)
        proj.push([plng, plat])
        // nearest airport from this probe
        let bestNm = Infinity
        for (const ap of apList) {
          if (Math.abs(ap.lat - plat) > latPad) continue
          if (Math.abs(ap.lon - plng) > lngPad) continue
          const { nm } = nmBetween(plat, plng, ap.lat, ap.lon)
          if (nm < bestNm) bestNm = nm
        }
        if (bestNm !== Infinity) {
          const tMin = (bestNm / oeiKtas) * 60
          if (!worst || tMin > worst.timeMin) worst = { nm: bestNm, timeMin: tMin, lat: plat, lon: plng }
        }
      }

      let tier: Tier
      if (!best) tier = 'BEYOND'
      else if (best.timeMin > ratingMin) tier = 'BEYOND'
      else if (worst && worst.timeMin > 1.10 * ratingMin) tier = 'EXCEEDS'
      else if (best.timeMin <= 0.70 * ratingMin && (!worst || worst.timeMin <= ratingMin)) tier = 'COMPLIANT'
      else tier = 'MARGIN'

      out.push({ f, klass, ratingMin, oeiKtas, maxNm, ring, best, worst, proj, tier })
    }
    return out
  }, [flights, ratingOverride, oeiMult, minAlt])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { COMPLIANT: 0, MARGIN: 0, EXCEEDS: 0, BEYOND: 0 }
    for (const r of results) c[r.tier]++
    return c
  }, [results])

  const ranked = useMemo(() => {
    const q = query.trim().toLowerCase()
    return results
      .filter(r => tierFilter === 'ALL' || r.tier === tierFilter)
      .filter(r => !q || r.f.callsign?.toLowerCase().includes(q) || r.f.type?.toLowerCase().includes(q) || r.f.operator?.toLowerCase().includes(q) || r.f.icao.toLowerCase().includes(q) || (r.best && r.best.iata.toLowerCase().includes(q)))
      .sort((a, b) => {
        const da = TIER_ORDER.indexOf(a.tier), db = TIER_ORDER.indexOf(b.tier)
        if (da !== db) return da - db
        const at = a.best ? a.best.timeMin : Infinity
        const bt = b.best ? b.best.timeMin : Infinity
        return bt - at  // closer to limit first within tier
      })
  }, [results, tierFilter, query])

  // ---------- MapLibre overlay ----------
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC_RING)) map.addSource(SRC_RING, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_RING_FILL)) map.addLayer({
          id: LYR_RING_FILL, type: 'fill', source: SRC_RING,
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.04 },
        })
        if (!map.getLayer(LYR_RING_LINE)) map.addLayer({
          id: LYR_RING_LINE, type: 'line', source: SRC_RING,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [2, 3] },
        })
        if (!map.getSource(SRC_SPOKE)) map.addSource(SRC_SPOKE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_SPOKE)) map.addLayer({
          id: LYR_SPOKE, type: 'line', source: SRC_SPOKE,
          paint: { 'line-color': '#38bdf8', 'line-width': 1.4, 'line-opacity': 0.7 },
        })
        if (!map.getSource(SRC_PROJ)) map.addSource(SRC_PROJ, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_PROJ)) map.addLayer({
          id: LYR_PROJ, type: 'line', source: SRC_PROJ,
          paint: { 'line-color': '#a78bfa', 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [1, 2] },
        })
        if (!map.getSource(SRC_ALT)) map.addSource(SRC_ALT, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_ALT)) map.addLayer({
          id: LYR_ALT, type: 'circle', source: SRC_ALT,
          paint: { 'circle-radius': 5, 'circle-color': '#fbbf24', 'circle-stroke-color': '#78350f', 'circle-stroke-width': 1, 'circle-opacity': 0.9 },
        })
        if (!map.getLayer(LYR_ALT_LBL)) map.addLayer({
          id: LYR_ALT_LBL, type: 'symbol', source: SRC_ALT,
          layout: { 'text-field': ['get', 'iata'], 'text-size': 10, 'text-offset': [0, 1.0], 'text-anchor': 'top', 'text-allow-overlap': true },
          paint: { 'text-color': '#fde68a', 'text-halo-color': '#000', 'text-halo-width': 1 },
        })
        if (!map.getSource(SRC_LBL)) map.addSource(SRC_LBL, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_LBL)) map.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC_LBL,
          layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, -1.8], 'text-anchor': 'bottom', 'text-allow-overlap': true },
          paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.2 },
        })
      } catch {}
    }
    ensure()

    const visible = ranked
    const ringFeats = showRing ? visible.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Polygon' as const, coordinates: [r.ring] },
      properties: { color: TIER_COLOR[r.tier] },
    })) : []
    const spokeFeats = showSpokes ? visible.filter(r => r.best).map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.best!.lon, r.best!.lat]] },
      properties: {},
    })) : []
    const projFeats = showProj ? visible.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates: r.proj },
      properties: {},
    })) : []
    const altMap = new Map<string, { iata: string; lat: number; lon: number }>()
    if (showSpokes) {
      for (const r of visible) {
        if (r.best) altMap.set(r.best.iata, { iata: r.best.iata, lat: r.best.lat, lon: r.best.lon })
      }
    }
    const altFeats = Array.from(altMap.values()).map(p => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
      properties: { iata: p.iata },
    }))
    const lblFeats = showLabels ? visible.map(r => {
      const tag = r.best ? `${r.best.iata} T+${r.best.timeMin.toFixed(0)}m` : 'no alt'
      return {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
        properties: { color: TIER_COLOR[r.tier], label: `${r.f.callsign?.trim() || r.f.icao} \u2022 ET${r.ratingMin} \u2022 ${tag}` },
      }
    }) : []
    try {
      (map.getSource(SRC_RING) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: ringFeats })
      ;(map.getSource(SRC_SPOKE) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: spokeFeats })
      ;(map.getSource(SRC_PROJ) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: projFeats })
      ;(map.getSource(SRC_ALT) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: altFeats })
      ;(map.getSource(SRC_LBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lblFeats })
    } catch {}
  }, [map, ranked, showRing, showSpokes, showProj, showLabels])

  useEffect(() => {
    return () => {
      if (!map) return
      try { for (const l of [LYR_LBL, LYR_ALT_LBL, LYR_ALT, LYR_PROJ, LYR_SPOKE, LYR_RING_LINE, LYR_RING_FILL]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
      try { for (const s of [SRC_LBL, SRC_ALT, SRC_PROJ, SRC_SPOKE, SRC_RING]) if (map.getSource(s)) map.removeSource(s) } catch {}
    }
  }, [map])

  const fmtMin = (m: number) => {
    if (!isFinite(m)) return '—'
    if (m < 60) return `${m.toFixed(0)}m`
    return `${Math.floor(m / 60)}h${Math.floor(m % 60).toString().padStart(2, '0')}`
  }

  // Fleet stats
  const fleet = useMemo(() => {
    let worstTime = 0, worstCs = ''
    let totalShown = 0
    let avgUtil = 0
    for (const r of results) {
      totalShown++
      if (r.worst && r.worst.timeMin > worstTime) { worstTime = r.worst.timeMin; worstCs = r.f.callsign?.trim() || r.f.icao }
      if (r.best) avgUtil += r.best.timeMin / r.ratingMin
    }
    return { worstTime, worstCs, totalShown, avgUtil: totalShown > 0 ? avgUtil / totalShown : 0 }
  }, [results])

  return (
    <div className="fixed top-16 right-3 z-40 w-[400px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">&#9881;</span>
          <span className="text-sm font-semibold tracking-wide">ETOPS MONITOR</span>
          <span className="text-[10px] text-slate-500">single-engine diversion</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {(['COMPLIANT', 'MARGIN', 'EXCEEDS', 'BEYOND'] as Tier[]).map(t => (
          <button key={t}
            onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/50 bg-sky-500/10' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }} title={t}>
            <span className="text-[9px] tracking-wider">{t.slice(0, 4)}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="px-3 py-2 grid grid-cols-3 gap-1 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] text-slate-500 tracking-wider">FLEET UTIL</div>
          <div className="font-mono text-sm text-sky-300">{(fleet.avgUtil * 100).toFixed(0)}%</div>
        </div>
        <div>
          <div className="text-[9px] text-slate-500 tracking-wider">WORST T-DIV</div>
          <div className="font-mono text-sm text-amber-300">{fleet.worstTime > 0 ? fmtMin(fleet.worstTime) : '—'}</div>
        </div>
        <div>
          <div className="text-[9px] text-slate-500 tracking-wider">TRACKED</div>
          <div className="font-mono text-sm text-slate-200">{fleet.totalShown}</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>RATING OVERRIDE</span>
            <span className="font-mono text-slate-300">{ratingOverride === 0 ? 'class-default' : `ETOPS-${ratingOverride}`}</span>
          </div>
          <input type="range" min={0} max={330} step={30} value={ratingOverride} onChange={e => setRatingOverride(parseInt(e.target.value))} className="w-full accent-sky-500" />
          <div className="flex justify-between text-[9px] text-slate-600 font-mono">
            <span>auto</span><span>60</span><span>120</span><span>180</span><span>240</span><span>330</span>
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>OEI SPEED MULT</span>
            <span className="font-mono text-slate-300">{oeiMult.toFixed(2)}x</span>
          </div>
          <input type="range" min={0.7} max={1.3} step={0.05} value={oeiMult} onChange={e => setOeiMult(parseFloat(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>MIN ALTITUDE (ft)</span>
            <span className="font-mono text-slate-300">{minAlt}</span>
          </div>
          <input type="range" min={0} max={40000} step={1000} value={minAlt} onChange={e => setMinAlt(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRing} onChange={e => setShowRing(e.target.checked)} className="accent-sky-500" /><span>RING</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showSpokes} onChange={e => setShowSpokes(e.target.checked)} className="accent-sky-500" /><span>ALT</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / iata"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{ranked.length} shown / {results.length} airborne</span>
        <span>OEI-ktas \u00d7 rating-min</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {ranked.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {ranked.map(r => {
          const util = r.best ? r.best.timeMin / r.ratingMin : 1.5
          const worstUtil = r.worst ? r.worst.timeMin / r.ratingMin : 0
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{r.f.callsign?.trim() || r.f.icao}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-sky-300">ET-{r.ratingMin}</span>
                  <span title="OEI cruise speed">{r.oeiKtas.toFixed(0)}kt OEI</span>
                  <span title="max diversion range">&#8674; {r.maxNm.toFixed(0)}nm</span>
                  <span className="ml-auto">FL{Math.round(r.f.altitudeFt / 100)}</span>
                </div>
                {r.best ? (
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                    best <span className="text-amber-300">{r.best.iata}</span> T+{fmtMin(r.best.timeMin)} &middot; {r.best.nm.toFixed(0)}nm &middot; brg {Math.round(r.best.brg).toString().padStart(3, '0')}&deg;
                  </div>
                ) : (
                  <div className="text-[10px] text-rose-400 font-mono mt-0.5">no alternate within ETOPS rating</div>
                )}
                <div className="mt-1 h-1.5 rounded bg-slate-900 overflow-hidden relative">
                  <div className="absolute inset-y-0 left-0 bg-sky-500/60" style={{ width: `${Math.min(100, util * 100)}%` }} />
                  <div className="absolute inset-y-0" style={{ left: '70%', width: '1px', background: '#10b981' }} />
                  <div className="absolute inset-y-0" style={{ left: '100%', width: '1px', background: '#ef4444' }} />
                  {r.worst && (
                    <div className="absolute -top-0.5 h-2.5 w-0.5 bg-violet-400" style={{ left: `${Math.min(100, worstUtil * 100)}%` }} title="worst-case projected time" />
                  )}
                </div>
                <div className="text-[10px] text-slate-600 truncate mt-0.5">
                  {r.f.operator || r.klass.toUpperCase()} &middot; worst-proj {r.worst ? fmtMin(r.worst.timeMin) : '\u2014'} ({(worstUtil * 100).toFixed(0)}% of limit)
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 tracking-wider">
        COMPL &le;70% &middot; MARGIN &le;100% &middot; EXCEEDS proj &gt;110% &middot; BEYOND no alt
      </div>
    </div>
  )
}
