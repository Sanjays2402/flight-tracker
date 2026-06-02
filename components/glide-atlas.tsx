'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   Engine-Out Glide Atlas
   -----------------------------------------------------------
   For every airborne aircraft we model an engine-out scenario:
     - airframe-class glide ratio (L/D best-glide): heavy 17,
       narrow 16, regional 14, biz 15, turboprop 11, GA 9,
       fighter 8, heli 4 (autorotate)
     - glide range nm = (alt_ft / 6076) * L/D  (no wind)
     - wind correction: project mean wind on each bearing to
       extend downwind / shrink upwind footprint
   We then scan the AIRPORTS dataset for runways within that
   wind-corrected footprint, count reachable airports, classify
   safety tier (SAFE >=3, MARGINAL 1-2, CRITICAL 0 within range
   but airports exist within 1.2x, NONE no airport in 1.2x),
   identify nearest reachable airport with ETA at glide speed.

   MapLibre overlay: tier-colored glide perimeter polygons
   (32-vertex ellipse stretched by wind), dashed spoke lines
   from aircraft to top-3 reachable airports per craft,
   reachable-airport pins (deduped), aircraft labels.

   Side panel: 4-tier counter strip (click-to-filter), GLIDE
   RATIO MULT slider (training/realism), WIND-CORRECT toggle,
   PERIMETER/SPOKES/PINS toggles, AIRBORNE/MIN-ALT slider,
   search, ranked aircraft list with tier stripe, nearest
   reachable IATA + ETA + glide-nm readouts, click-to-fly.
   ============================================================ */

export interface GaFlight {
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
  windDir?: number  // FROM, deg
  windKts?: number
}

interface Props {
  map: maplibregl.Map | null
  flights: GaFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'SAFE' | 'MARGINAL' | 'CRITICAL' | 'NONE'
const TIER_COLOR: Record<Tier, string> = {
  SAFE: '#10b981',
  MARGINAL: '#fbbf24',
  CRITICAL: '#f97316',
  NONE: '#ef4444',
}
const TIER_ORDER: Tier[] = ['NONE', 'CRITICAL', 'MARGINAL', 'SAFE']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter' | 'heli'
const GLIDE_RATIO: Record<Klass, number> = {
  heavy: 17, narrow: 16, regional: 14, biz: 15, turboprop: 11, ga: 9, fighter: 8, heli: 4,
}
const GLIDE_KIAS: Record<Klass, number> = {
  heavy: 220, narrow: 210, regional: 170, biz: 180, turboprop: 120, ga: 75, fighter: 200, heli: 60,
}

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || x.startsWith('H') || /EC|AS|R44|R66|S76|S92|UH|AW|MD9|B06|B47/.test(x)) return 'heli'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CRJ9|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|G[1-7]|CL|CRJ2|LJ|GLEX|F2T|F900|F7X|BE40|H25|H50|GALX|EA50|PC24|HDJT)/.test(x)) return 'biz'
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

const SRC_PERIM = 'ga-perim-src', LYR_PERIM = 'ga-perim-lyr', LYR_PERIM_LINE = 'ga-perim-line'
const SRC_SPOKE = 'ga-spoke-src', LYR_SPOKE = 'ga-spoke-lyr'
const SRC_PIN = 'ga-pin-src', LYR_PIN = 'ga-pin-lyr', LYR_PIN_LBL = 'ga-pin-lbl'
const SRC_LBL = 'ga-lbl-src', LYR_LBL = 'ga-lbl-lyr'

export default function GlideAtlasPanel({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [glideMult, setGlideMult] = useState(1.0)
  const [windCorrect, setWindCorrect] = useState(true)
  const [showPerim, setShowPerim] = useState(true)
  const [showSpokes, setShowSpokes] = useState(true)
  const [showPins, setShowPins] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [minAlt, setMinAlt] = useState(2000)
  const [query, setQuery] = useState('')
  const [, setTick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 4000)
    return () => clearInterval(t)
  }, [])

  const results = useMemo(() => {
    const out: Array<{
      f: GaFlight
      klass: Klass
      maxNm: number
      perimeter: Array<[number, number]>
      reachable: Array<{ i: string; a: string; n: string; m: string; lat: number; lon: number; nm: number; brg: number; etaSec: number }>
      tier: Tier
      nearest: { iata: string; nm: number; etaSec: number; brg: number } | null
    }> = []

    for (const f of flights) {
      if (f.ground) continue
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      if (f.altitudeFt < minAlt) continue

      const klass = classify(f.type, f.category)
      const ld = GLIDE_RATIO[klass]
      const kias = GLIDE_KIAS[klass]
      const baseNm = (f.altitudeFt / 6076) * ld * glideMult
      if (baseNm < 1) continue

      // Build perimeter (32 verts) with wind correction
      const perim: Array<[number, number]> = []
      const wd = f.windDir ?? 0, wk = f.windKts ?? 0
      // Wind-TO direction: where the wind is going
      const windToDeg = (wd + 180) % 360
      // Glide time at glide TAS (approx KIAS at low alt, simplification)
      const glideTAS = kias * (1 + 0.02 * (f.altitudeFt / 1000))  // TAS rises ~2%/1000ft
      const glideTimeSec = (baseNm / glideTAS) * 3600
      for (let i = 0; i < 33; i++) {
        const brg = (i * 360) / 32
        let nm = baseNm
        if (windCorrect && wk > 0) {
          // Component of wind in glide bearing direction (tailwind = +)
          const tail = wk * Math.cos(toRad(brg - windToDeg))
          nm = Math.max(1, baseNm + (tail * glideTimeSec) / 3600)
        }
        perim.push(destPoint(f.lat, f.lng, brg, nm))
      }

      // Scan airports — prefilter by lat box
      const reachable: Array<{ i: string; a: string; n: string; m: string; lat: number; lon: number; nm: number; brg: number; etaSec: number }> = []
      const latPad = baseNm / NM_PER_DEG_LAT * 1.3
      const lngPad = latPad / Math.max(0.1, Math.cos(toRad(f.lat)))
      for (const ap of AIRPORTS) {
        if (Math.abs(ap.lat - f.lat) > latPad) continue
        if (Math.abs(ap.lon - f.lng) > lngPad) continue
        const { nm, brg } = nmBetween(f.lat, f.lng, ap.lat, ap.lon)
        let limit = baseNm
        if (windCorrect && wk > 0) {
          const tail = wk * Math.cos(toRad(brg - windToDeg))
          limit = Math.max(1, baseNm + (tail * glideTimeSec) / 3600)
        }
        if (nm <= limit) {
          const etaSec = (nm / glideTAS) * 3600
          reachable.push({ i: ap.i, a: ap.a, n: ap.n, m: ap.m, lat: ap.lat, lon: ap.lon, nm, brg, etaSec })
        }
      }
      reachable.sort((a, b) => a.nm - b.nm)

      let tier: Tier
      if (reachable.length >= 3) tier = 'SAFE'
      else if (reachable.length >= 1) tier = 'MARGINAL'
      else {
        // any airport within 1.2x?
        let anyClose = false
        for (const ap of AIRPORTS) {
          if (Math.abs(ap.lat - f.lat) > latPad) continue
          if (Math.abs(ap.lon - f.lng) > lngPad) continue
          const { nm } = nmBetween(f.lat, f.lng, ap.lat, ap.lon)
          if (nm <= baseNm * 1.2) { anyClose = true; break }
        }
        tier = anyClose ? 'CRITICAL' : 'NONE'
      }

      const nearest = reachable[0] ? { iata: reachable[0].a || reachable[0].i, nm: reachable[0].nm, etaSec: reachable[0].etaSec, brg: reachable[0].brg } : null
      out.push({ f, klass, maxNm: baseNm, perimeter: perim, reachable, tier, nearest })
    }
    return out
  }, [flights, glideMult, windCorrect, minAlt])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { SAFE: 0, MARGINAL: 0, CRITICAL: 0, NONE: 0 }
    for (const r of results) c[r.tier]++
    return c
  }, [results])

  const ranked = useMemo(() => {
    const q = query.trim().toLowerCase()
    return results
      .filter(r => tierFilter === 'ALL' || r.tier === tierFilter)
      .filter(r => !q || r.f.callsign?.toLowerCase().includes(q) || r.f.type?.toLowerCase().includes(q) || r.f.operator?.toLowerCase().includes(q) || r.f.icao.toLowerCase().includes(q) || (r.nearest && r.nearest.iata.toLowerCase().includes(q)))
      .sort((a, b) => {
        const da = TIER_ORDER.indexOf(a.tier), db = TIER_ORDER.indexOf(b.tier)
        if (da !== db) return da - db
        return (a.reachable.length - b.reachable.length) || (a.f.altitudeFt - b.f.altitudeFt)
      })
  }, [results, tierFilter, query])

  // ---------- MapLibre overlay ----------
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC_PERIM)) map.addSource(SRC_PERIM, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_PERIM)) map.addLayer({
          id: LYR_PERIM, type: 'fill', source: SRC_PERIM,
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.07 },
        })
        if (!map.getLayer(LYR_PERIM_LINE)) map.addLayer({
          id: LYR_PERIM_LINE, type: 'line', source: SRC_PERIM,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.6, 'line-dasharray': [2, 2] },
        })
        if (!map.getSource(SRC_SPOKE)) map.addSource(SRC_SPOKE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_SPOKE)) map.addLayer({
          id: LYR_SPOKE, type: 'line', source: SRC_SPOKE,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.55, 'line-dasharray': [1, 2] },
        })
        if (!map.getSource(SRC_PIN)) map.addSource(SRC_PIN, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_PIN)) map.addLayer({
          id: LYR_PIN, type: 'circle', source: SRC_PIN,
          paint: { 'circle-radius': 4, 'circle-color': '#22d3ee', 'circle-stroke-color': '#0e7490', 'circle-stroke-width': 1, 'circle-opacity': 0.85 },
        })
        if (!map.getLayer(LYR_PIN_LBL)) map.addLayer({
          id: LYR_PIN_LBL, type: 'symbol', source: SRC_PIN,
          layout: { 'text-field': ['get', 'iata'], 'text-size': 10, 'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-allow-overlap': true },
          paint: { 'text-color': '#67e8f9', 'text-halo-color': '#000', 'text-halo-width': 1 },
        })
        if (!map.getSource(SRC_LBL)) map.addSource(SRC_LBL, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_LBL)) map.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC_LBL,
          layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, -1.7], 'text-anchor': 'bottom', 'text-allow-overlap': true },
          paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.2 },
        })
      } catch {}
    }
    ensure()

    const visible = ranked
    const perimFeats = showPerim ? visible.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Polygon' as const, coordinates: [r.perimeter] },
      properties: { color: TIER_COLOR[r.tier] },
    })) : []
    const spokeFeats: any[] = []
    const pinMap = new Map<string, { iata: string; lat: number; lon: number }>()
    if (showSpokes || showPins) {
      for (const r of visible) {
        const top = r.reachable.slice(0, 3)
        for (const ap of top) {
          if (showSpokes) {
            spokeFeats.push({
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [ap.lon, ap.lat]] },
              properties: { color: TIER_COLOR[r.tier] },
            })
          }
          if (showPins) {
            const key = ap.i
            if (!pinMap.has(key)) pinMap.set(key, { iata: ap.a || ap.i, lat: ap.lat, lon: ap.lon })
          }
        }
      }
    }
    const pinFeats = Array.from(pinMap.values()).map(p => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
      properties: { iata: p.iata },
    }))
    const lblFeats = showLabels ? visible.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: { color: TIER_COLOR[r.tier], label: `${r.f.callsign?.trim() || r.f.icao} \u2022 ${r.maxNm.toFixed(0)}nm \u2022 ${r.reachable.length}` },
    })) : []
    try {
      (map.getSource(SRC_PERIM) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: perimFeats })
      ;(map.getSource(SRC_SPOKE) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: spokeFeats })
      ;(map.getSource(SRC_PIN) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: pinFeats })
      ;(map.getSource(SRC_LBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lblFeats })
    } catch {}
  }, [map, ranked, showPerim, showSpokes, showPins, showLabels])

  useEffect(() => {
    return () => {
      if (!map) return
      try { for (const l of [LYR_LBL, LYR_PIN_LBL, LYR_PIN, LYR_SPOKE, LYR_PERIM_LINE, LYR_PERIM]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
      try { for (const s of [SRC_LBL, SRC_PIN, SRC_SPOKE, SRC_PERIM]) if (map.getSource(s)) map.removeSource(s) } catch {}
    }
  }, [map])

  const fmtT = (s: number) => {
    if (!isFinite(s)) return '—'
    const m = Math.floor(s / 60), sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  return (
    <div className="fixed top-16 right-3 z-40 w-[380px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">&#9881;</span>
          <span className="text-sm font-semibold tracking-wide">GLIDE ATLAS</span>
          <span className="text-[10px] text-slate-500">engine-out reach</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {(['SAFE', 'MARGINAL', 'CRITICAL', 'NONE'] as Tier[]).map(t => (
          <button key={t}
            onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/50 bg-sky-500/10' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }} title={t}>
            <span className="text-[9px] tracking-wider">{t.slice(0, 4)}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>GLIDE RATIO MULT</span>
            <span className="font-mono text-slate-300">{glideMult.toFixed(2)}x</span>
          </div>
          <input type="range" min={0.5} max={1.5} step={0.05} value={glideMult} onChange={e => setGlideMult(parseFloat(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>MIN ALTITUDE (ft)</span>
            <span className="font-mono text-slate-300">{minAlt}</span>
          </div>
          <input type="range" min={500} max={20000} step={500} value={minAlt} onChange={e => setMinAlt(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={windCorrect} onChange={e => setWindCorrect(e.target.checked)} className="accent-sky-500" /><span>WIND</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPerim} onChange={e => setShowPerim(e.target.checked)} className="accent-sky-500" /><span>PERIM</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showSpokes} onChange={e => setShowSpokes(e.target.checked)} className="accent-sky-500" /><span>SPOKES</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPins} onChange={e => setShowPins(e.target.checked)} className="accent-sky-500" /><span>PINS</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / iata"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{ranked.length} shown / {results.length} airborne</span>
        <span>L/D × alt(nm) × mult</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {ranked.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {ranked.map(r => (
          <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
            <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono font-semibold truncate">{r.f.callsign?.trim() || r.f.icao}</span>
                <span className="text-slate-500 truncate">{r.f.type || '—'}</span>
                <span className="ml-auto text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                <span title="engine-out glide range nm">&#8674; {r.maxNm.toFixed(0)}nm</span>
                <span title="reachable airports">&#9733; {r.reachable.length} apt</span>
                <span className="ml-auto">FL{Math.round(r.f.altitudeFt / 100)}</span>
              </div>
              {r.nearest ? (
                <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                  nearest <span className="text-sky-300">{r.nearest.iata}</span> {r.nearest.nm.toFixed(0)}nm &middot; T-{fmtT(r.nearest.etaSec)} &middot; brg {Math.round(r.nearest.brg).toString().padStart(3, '0')}&deg;
                </div>
              ) : (
                <div className="text-[10px] text-rose-400 font-mono mt-0.5">no airport within glide</div>
              )}
              <div className="text-[10px] text-slate-600 truncate">{r.f.operator || r.klass.toUpperCase()} &middot; L/D {GLIDE_RATIO[r.klass]}</div>
            </div>
          </button>
        ))}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 tracking-wider">
        SAFE &ge;3 apt &middot; MARGINAL 1-2 &middot; CRITICAL apt in 1.2x &middot; NONE
      </div>
    </div>
  )
}
