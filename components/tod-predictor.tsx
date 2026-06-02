'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   Top-of-Descent (TOD) Predictor
   -----------------------------------------------------------
   For every cruising aircraft, picks the most-likely destination
   airport from those lying within a forward track cone, then
   computes the Top-of-Descent point (where a standard 3° / -1500fpm
   profile from current FL must begin to make a flat arrival).

   For each candidate we compute:
     - bearing/range from aircraft to airport
     - off-track angle vs current heading
     - distance from TOD: range - (altFt / sin(3°)) in nm
     - time to TOD at current GS
     - destination ETA

   Cone scoring: closer airports with smaller off-track angles
   and altitudes consistent with a sensible descent profile win.

   Renders MapLibre overlays:
     - dashed cyan geodesic from aircraft to predicted destination
     - solid amber dot at TOD position with "TOD T-MM:SS" label
     - destination pin with IATA
   Side panel: ranked list with click-to-fly.
   ============================================================ */

export interface TodFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
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
  flights: TodFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

const R_NM = 3440.065
const RAD = Math.PI / 180
const DEG = 180 / Math.PI

function distNm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const φ1 = lat1 * RAD, φ2 = lat2 * RAD
  const dφ = (lat2 - lat1) * RAD
  const dλ = (lng2 - lng1) * RAD
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(s)))
}
function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number) {
  const φ1 = lat1 * RAD, φ2 = lat2 * RAD
  const dλ = (lng2 - lng1) * RAD
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * DEG + 360) % 360
}
function dest(lat: number, lng: number, brg: number, nm: number): [number, number] {
  const d = nm / R_NM
  const φ1 = lat * RAD, λ1 = lng * RAD, θ = brg * RAD
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(d) * Math.cos(φ1),
                             Math.cos(d) - Math.sin(φ1) * Math.sin(φ2))
  let lng2 = λ2 * DEG
  lng2 = ((lng2 + 540) % 360) - 180
  return [lng2, φ2 * DEG]
}
function geodesic(lat1: number, lng1: number, lat2: number, lng2: number, n = 40): number[][] {
  const out: number[][] = []
  const φ1 = lat1 * RAD, λ1 = lng1 * RAD
  const φ2 = lat2 * RAD, λ2 = lng2 * RAD
  const dφ = φ2 - φ1, dλ = λ2 - λ1
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  const δ = 2 * Math.asin(Math.min(1, Math.sqrt(a)))
  if (δ < 1e-9) return [[lng1, lat1], [lng2, lat2]]
  for (let i = 0; i <= n; i++) {
    const f = i / n
    const A = Math.sin((1 - f) * δ) / Math.sin(δ)
    const B = Math.sin(f * δ) / Math.sin(δ)
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2)
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2)
    const z = A * Math.sin(φ1) + B * Math.sin(φ2)
    const φ = Math.atan2(z, Math.sqrt(x * x + y * y))
    const λ = Math.atan2(y, x)
    out.push([((λ * DEG + 540) % 360) - 180, φ * DEG])
  }
  return out
}

interface Hit {
  flight: TodFlight
  apIcao: string
  apIata: string
  apName: string
  apCity: string
  apLat: number
  apLon: number
  rangeNm: number
  bearing: number
  offTrack: number
  todNm: number          // distance ahead where TOD point sits
  distToTodNm: number    // range - todNm  (>=0 means cruising, <0 means already past TOD / descending)
  tToTodSec: number      // at current GS
  etaSec: number         // to destination
  todLat: number
  todLng: number
  score: number
  status: 'CRUISE' | 'TOD-SOON' | 'DESCENDING' | 'APPROACH'
}

const SRC_TRK = 'tod-trk-src'
const LYR_TRK = 'tod-trk-lyr'
const SRC_TOD = 'tod-pt-src'
const LYR_TOD = 'tod-pt-lyr'
const LYR_TOD_LBL = 'tod-pt-lbl'
const SRC_AP  = 'tod-ap-src'
const LYR_AP  = 'tod-ap-lyr'
const LYR_AP_LBL = 'tod-ap-lbl'

const DESCENT_DEG = 3   // standard 3° glide
const TOD_RATIO = 1 / Math.tan(DESCENT_DEG * RAD)  // nm per nm of altitude => ~19.08 nm per 1nm alt
// altitudeFt / 6076.12 -> alt nm; TOD nm = alt_nm * TOD_RATIO  (~3nm per 1000ft)

function fmtT(s: number) {
  if (!isFinite(s)) return '—'
  if (s < 0) return 'PAST'
  const m = Math.floor(s / 60), ss = Math.floor(s % 60)
  return `${m}:${String(ss).padStart(2, '0')}`
}

export default function TodPredictor({ map, flights, onClose, onFly }: Props) {
  const [coneDeg, setConeDeg] = useState<number>(20)
  const [maxRangeNm, setMaxRangeNm] = useState<number>(400)
  const [minAlt, setMinAlt] = useState<number>(15000)
  const [showOverlay, setShowOverlay] = useState<boolean>(true)
  const [query, setQuery] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'CRUISE' | 'TOD-SOON' | 'DESCENDING' | 'APPROACH'>('ALL')
  const installedRef = useRef<boolean>(false)

  const hits: Hit[] = useMemo(() => {
    const out: Hit[] = []
    const aps = AIRPORTS
    for (const f of flights) {
      if (f.ground || f.altitudeFt < minAlt) continue
      const gs = Math.max(80, f.velocityKts || 250)
      const altNm = f.altitudeFt / 6076.12
      const todNm = altNm * TOD_RATIO
      // Forward-cone prefilter box
      const dLatMax = maxRangeNm / 60
      const cosLat = Math.max(0.1, Math.cos(f.lat * RAD))
      const dLngMax = maxRangeNm / (60 * cosLat)
      let best: Hit | null = null
      for (const ap of aps) {
        if (Math.abs(ap.lat - f.lat) > dLatMax) continue
        if (Math.abs(((ap.lon - f.lng + 540) % 360) - 180) > dLngMax) continue
        const rng = distNm(f.lat, f.lng, ap.lat, ap.lon)
        if (rng > maxRangeNm || rng < 5) continue
        const brg = bearingDeg(f.lat, f.lng, ap.lat, ap.lon)
        const off = Math.abs(((brg - f.track) + 540) % 360 - 180)
        if (off > coneDeg) continue
        // Plausibility: range must accommodate at least 60% of descent profile
        if (rng < todNm * 0.4) continue
        const distToTod = rng - todNm
        const tTod = (distToTod / gs) * 3600
        const eta = (rng / gs) * 3600
        // Score: prefer small off-track, plausible TOD timing (positive but not huge),
        // closer airports rank above farther.
        const onTrackScore = (coneDeg - off) / coneDeg // 0..1
        const rngScore = Math.max(0, 1 - rng / maxRangeNm)
        const profileScore = distToTod >= 0
          ? Math.max(0, 1 - distToTod / Math.max(40, todNm)) // peak near TOD
          : Math.max(0, 1 + distToTod / Math.max(40, todNm)) // smaller penalty past TOD
        const score = 100 * (0.55 * onTrackScore + 0.25 * rngScore + 0.20 * profileScore)
        let status: Hit['status']
        if (distToTod > 5) status = 'CRUISE'
        else if (distToTod > -5) status = 'TOD-SOON'
        else if (rng > todNm * 0.25) status = 'DESCENDING'
        else status = 'APPROACH'
        // TOD point sits along bearing at todNm from aircraft (clamped to airport range)
        const tPos = dest(f.lat, f.lng, brg, Math.max(0, Math.min(rng, todNm)))
        const h: Hit = {
          flight: f,
          apIcao: ap.i, apIata: ap.a, apName: ap.n, apCity: ap.m,
          apLat: ap.lat, apLon: ap.lon,
          rangeNm: rng, bearing: brg, offTrack: off,
          todNm, distToTodNm: distToTod, tToTodSec: tTod, etaSec: eta,
          todLat: tPos[1], todLng: tPos[0],
          score, status,
        }
        if (!best || h.score > best.score) best = h
      }
      if (best) out.push(best)
    }
    out.sort((a, b) => a.tToTodSec - b.tToTodSec)
    return out
  }, [flights, coneDeg, maxRangeNm, minAlt])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return hits.filter(h => {
      if (statusFilter !== 'ALL' && h.status !== statusFilter) return false
      if (q && ![h.flight.callsign, h.flight.icao, h.flight.type || '', h.flight.operator || '',
                 h.apIata, h.apIcao, h.apCity, h.apName].some(s => s.toLowerCase().includes(q))) return false
      return true
    })
  }, [hits, query, statusFilter])

  const counts = useMemo(() => {
    const c = { CRUISE: 0, 'TOD-SOON': 0, DESCENDING: 0, APPROACH: 0 } as Record<string, number>
    hits.forEach(h => { c[h.status]++ })
    return c
  }, [hits])

  // overlay install
  useEffect(() => {
    const m = map
    if (!m) return
    let cancelled = false
    const install = () => {
      if (cancelled || installedRef.current) return
      try {
        if (!m.getSource(SRC_TRK)) m.addSource(SRC_TRK, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
        if (!m.getLayer(LYR_TRK)) m.addLayer({
          id: LYR_TRK, type: 'line', source: SRC_TRK,
          paint: {
            'line-color': ['match', ['get', 'status'],
              'CRUISE', '#22d3ee',
              'TOD-SOON', '#fbbf24',
              'DESCENDING', '#fb923c',
              'APPROACH', '#f472b6',
              '#94a3b8'],
            'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1, 8, 1.8, 12, 2.6],
            'line-dasharray': [2, 2],
            'line-opacity': 0.75,
          },
        })
        if (!m.getSource(SRC_TOD)) m.addSource(SRC_TOD, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
        if (!m.getLayer(LYR_TOD)) m.addLayer({
          id: LYR_TOD, type: 'circle', source: SRC_TOD,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3.5, 8, 6, 12, 9],
            'circle-color': ['match', ['get', 'status'],
              'TOD-SOON', '#fbbf24',
              'CRUISE', '#22d3ee',
              'DESCENDING', '#fb923c',
              'APPROACH', '#f472b6',
              '#94a3b8'],
            'circle-stroke-color': '#0b1220',
            'circle-stroke-width': 1.5,
            'circle-opacity': 0.95,
          },
        })
        if (!m.getLayer(LYR_TOD_LBL)) m.addLayer({
          id: LYR_TOD_LBL, type: 'symbol', source: SRC_TOD,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-offset': [0, -1.2],
            'text-anchor': 'bottom',
            'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': '#fde68a',
            'text-halo-color': '#020617',
            'text-halo-width': 1.4,
          },
        })
        if (!m.getSource(SRC_AP)) m.addSource(SRC_AP, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
        if (!m.getLayer(LYR_AP)) m.addLayer({
          id: LYR_AP, type: 'circle', source: SRC_AP,
          paint: {
            'circle-radius': 5,
            'circle-color': '#a78bfa',
            'circle-stroke-color': '#0b1220',
            'circle-stroke-width': 2,
            'circle-opacity': 0.9,
          },
        })
        if (!m.getLayer(LYR_AP_LBL)) m.addLayer({
          id: LYR_AP_LBL, type: 'symbol', source: SRC_AP,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-offset': [0, 1.1],
            'text-anchor': 'top',
            'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': '#ddd6fe',
            'text-halo-color': '#020617',
            'text-halo-width': 1.3,
          },
        })
        installedRef.current = true
      } catch {}
    }
    if (m.isStyleLoaded()) install()
    else m.once('load', install)
    return () => {
      cancelled = true
      try {
        [LYR_AP_LBL, LYR_AP, LYR_TOD_LBL, LYR_TOD, LYR_TRK].forEach(id => { if (m.getLayer(id)) m.removeLayer(id) })
        ;[SRC_AP, SRC_TOD, SRC_TRK].forEach(id => { if (m.getSource(id)) m.removeSource(id) })
      } catch {}
      installedRef.current = false
    }
  }, [map])

  // overlay data
  useEffect(() => {
    const m = map
    if (!m || !installedRef.current) return
    try {
      if (!showOverlay) {
        ;(m.getSource(SRC_TRK) as maplibregl.GeoJSONSource)?.setData({ type: 'FeatureCollection', features: [] } as any)
        ;(m.getSource(SRC_TOD) as maplibregl.GeoJSONSource)?.setData({ type: 'FeatureCollection', features: [] } as any)
        ;(m.getSource(SRC_AP)  as maplibregl.GeoJSONSource)?.setData({ type: 'FeatureCollection', features: [] } as any)
        return
      }
      const trkFs: any[] = []
      const todFs: any[] = []
      const apFs: any[] = []
      const apSeen = new Set<string>()
      for (const h of filtered.slice(0, 80)) {
        const coords = geodesic(h.flight.lat, h.flight.lng, h.apLat, h.apLon, 36)
        trkFs.push({ type: 'Feature', properties: { status: h.status }, geometry: { type: 'LineString', coordinates: coords } })
        if (h.distToTodNm > -5) {
          todFs.push({
            type: 'Feature',
            properties: { status: h.status, label: `TOD ${h.flight.callsign || h.flight.icao} T-${fmtT(h.tToTodSec)}` },
            geometry: { type: 'Point', coordinates: [h.todLng, h.todLat] },
          })
        }
        if (!apSeen.has(h.apIcao)) {
          apSeen.add(h.apIcao)
          apFs.push({
            type: 'Feature',
            properties: { label: h.apIata || h.apIcao },
            geometry: { type: 'Point', coordinates: [h.apLon, h.apLat] },
          })
        }
      }
      ;(m.getSource(SRC_TRK) as maplibregl.GeoJSONSource)?.setData({ type: 'FeatureCollection', features: trkFs } as any)
      ;(m.getSource(SRC_TOD) as maplibregl.GeoJSONSource)?.setData({ type: 'FeatureCollection', features: todFs } as any)
      ;(m.getSource(SRC_AP)  as maplibregl.GeoJSONSource)?.setData({ type: 'FeatureCollection', features: apFs  } as any)
    } catch {}
  }, [map, filtered, showOverlay])

  const STAT_COLORS: Record<string, string> = {
    CRUISE: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
    'TOD-SOON': 'bg-amber-500/20 text-amber-300 border-amber-500/40',
    DESCENDING: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
    APPROACH: 'bg-pink-500/20 text-pink-300 border-pink-500/40',
  }

  return (
    <div className="absolute right-4 top-32 w-[420px] max-w-[92vw] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl z-30 text-slate-100">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div>
          <div className="text-sm font-semibold tracking-wide">TOP-OF-DESCENT</div>
          <div className="text-[10px] text-slate-400 uppercase tracking-wider mt-0.5">{hits.length} cruisers · 3° profile</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none">×</button>
      </div>

      <div className="px-4 py-3 border-b border-slate-800 space-y-3">
        <div className="grid grid-cols-4 gap-1.5 text-center text-[10px]">
          {(['CRUISE', 'TOD-SOON', 'DESCENDING', 'APPROACH'] as const).map(k => (
            <button
              key={k}
              onClick={() => setStatusFilter(statusFilter === k ? 'ALL' : k)}
              className={`rounded-md py-1.5 px-1 border transition ${
                statusFilter === k ? STAT_COLORS[k] : 'bg-slate-900/40 text-slate-400 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div className="font-mono text-sm leading-none">{counts[k] || 0}</div>
              <div className="uppercase tracking-wider mt-0.5 text-[9px]">{k}</div>
            </button>
          ))}
        </div>

        <div>
          <div className="flex justify-between text-[11px] text-slate-400 mb-1">
            <span>Forward cone</span><span className="font-mono">±{coneDeg}°</span>
          </div>
          <input type="range" min={5} max={60} step={1} value={coneDeg}
            onChange={e => setConeDeg(parseInt(e.target.value))} className="w-full accent-cyan-400" />
        </div>
        <div>
          <div className="flex justify-between text-[11px] text-slate-400 mb-1">
            <span>Max range</span><span className="font-mono">{maxRangeNm}nm</span>
          </div>
          <input type="range" min={50} max={800} step={25} value={maxRangeNm}
            onChange={e => setMaxRangeNm(parseInt(e.target.value))} className="w-full accent-amber-400" />
        </div>
        <div>
          <div className="flex justify-between text-[11px] text-slate-400 mb-1">
            <span>Min altitude</span><span className="font-mono">{(minAlt / 1000).toFixed(0)}k ft</span>
          </div>
          <input type="range" min={5000} max={40000} step={1000} value={minAlt}
            onChange={e => setMinAlt(parseInt(e.target.value))} className="w-full accent-pink-400" />
        </div>

        <div className="flex items-center gap-3 text-[11px]">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={showOverlay} onChange={e => setShowOverlay(e.target.checked)}
              className="accent-cyan-400" />
            Map overlay
          </label>
        </div>

        <input
          type="text" placeholder="Filter callsign / type / airport..."
          value={query} onChange={e => setQuery(e.target.value)}
          className="w-full bg-slate-900/60 border border-slate-800 rounded-lg px-3 py-1.5 text-xs placeholder-slate-500 focus:outline-none focus:border-cyan-500"
        />
      </div>

      <div className="max-h-[44vh] overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-slate-500">No predicted descents match the current filters.</div>
        )}
        {filtered.slice(0, 100).map(h => (
          <button
            key={h.flight.icao}
            onClick={() => onFly(h.flight.icao)}
            className="w-full text-left px-4 py-2 border-b border-slate-800/50 hover:bg-slate-800/40 transition flex items-center gap-3"
          >
            <div className={`shrink-0 w-[68px] rounded-md text-center py-1 border text-[9px] uppercase tracking-wider font-bold ${STAT_COLORS[h.status]}`}>
              {h.status}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-sm font-semibold">{h.flight.callsign || h.flight.icao}</span>
                <span className="text-[10px] text-slate-500 font-mono">{h.flight.type || '—'}</span>
                <span className="text-[10px] text-violet-300 font-mono">→ {h.apIata || h.apIcao}</span>
              </div>
              <div className="text-[10px] text-slate-400 truncate">
                {h.apCity}{h.apName ? ` · ${h.apName}` : ''} · Δ{Math.round(h.offTrack)}°
              </div>
            </div>
            <div className="text-right text-[10px] font-mono leading-tight">
              <div className="text-amber-300">T-{fmtT(h.tToTodSec)}</div>
              <div className="text-slate-300">{Math.round(h.rangeNm)}nm</div>
              <div className="text-slate-500">FL{Math.round(h.flight.altitudeFt / 100).toString().padStart(3, '0')}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
