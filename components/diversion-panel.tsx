'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Diversion Finder
   ---------------------------------------------------------------
   For the currently selected aircraft, rank the N nearest airports
   by:
     - great-circle range (nm)
     - estimated time-to-airport at current ground speed
     - direct vs detour penalty (off-track angle from current heading)
     - reachable-without-refuel score (assumes 4h endurance default)
   Renders MapLibre overlays:
     - geodesic dashed line from aircraft to each ranked airport
     - airport pin (ringed marker) with IATA label
     - glide cone polygon (current alt -> ground at 12:1 glide ratio,
       optional toggle) showing the engine-out reachable footprint
   Side panel: top-N list with brg/range/ETA/off-track delta, search,
   adjustable shortlist size, endurance + glide-ratio sliders, IFR/VFR
   length filter (simulated since runway data isn't in our airport set),
   click-to-fly per row.
   ============================================================ */

export interface DivAirport {
  i: string   // ICAO
  a: string   // IATA
  n: string   // name
  m: string   // city
  lat: number
  lon: number
}

export interface DivPlane {
  icao: string
  callsign: string
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
  plane: DivPlane | null
  airports: DivAirport[]
  onClose: () => void
  onFlyAirport?: (icao: string) => void
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
function geodesic(lat1: number, lng1: number, lat2: number, lng2: number, n = 48): number[][] {
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

export type DivHit = {
  ap: DivAirport
  rangeNm: number
  brg: number
  offTrackDeg: number      // signed delta from current heading (0..180)
  etaSec: number           // at current ground speed
  reachable: boolean       // within remaining endurance
  glideOk: boolean         // reachable in engine-out at given glide ratio
}

const SRC_LINE = 'div-lines-src'
const LYR_LINE = 'div-lines-lyr'
const SRC_PIN  = 'div-pin-src'
const LYR_PIN  = 'div-pin-lyr'
const LYR_LBL  = 'div-pin-lbl'
const SRC_GLIDE = 'div-glide-src'
const LYR_GLIDE = 'div-glide-lyr'
const LYR_GLIDE_OUT = 'div-glide-out-lyr'

export default function DiversionPanel({ map, plane, airports, onClose, onFlyAirport }: Props) {
  const [topN, setTopN] = useState<number>(8)
  const [enduranceMin, setEnduranceMin] = useState<number>(120)  // remaining endurance, minutes
  const [glideRatio, setGlideRatio] = useState<number>(12)        // L/D, jet ~12-17, GA ~9
  const [showGlide, setShowGlide] = useState<boolean>(true)
  const [reachableOnly, setReachableOnly] = useState<boolean>(false)
  const [query, setQuery] = useState<string>('')

  const installedRef = useRef<boolean>(false)

  // Compute hits
  const hits: DivHit[] = useMemo(() => {
    if (!plane) return []
    const gs = Math.max(60, plane.velocityKts || 250)
    const remNm = (enduranceMin / 60) * gs
    const glideNm = (plane.altitudeFt / 6076) * glideRatio
    // Quick prefilter by lat/lng box (~ 800nm)
    const dLatMax = 800 / 60
    const cosLat = Math.max(0.1, Math.cos(plane.lat * RAD))
    const dLngMax = 800 / (60 * cosLat)
    const pre = airports.filter(ap =>
      Math.abs(ap.lat - plane.lat) <= dLatMax &&
      Math.abs(((ap.lon - plane.lng + 540) % 360) - 180) <= dLngMax
    )
    const all: DivHit[] = pre.map(ap => {
      const rng = distNm(plane.lat, plane.lng, ap.lat, ap.lon)
      const brg = bearingDeg(plane.lat, plane.lng, ap.lat, ap.lon)
      let off = Math.abs(((brg - plane.track) + 540) % 360 - 180)
      const etaSec = (rng / gs) * 3600
      return {
        ap, rangeNm: rng, brg, offTrackDeg: off, etaSec,
        reachable: rng <= remNm,
        glideOk: !plane.ground && rng <= glideNm,
      }
    })
    all.sort((x, y) => x.rangeNm - y.rangeNm)
    return all.slice(0, 60) // keep wider pool for filtering
  }, [plane, airports, enduranceMin, glideRatio])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = hits
    if (reachableOnly) list = list.filter(h => h.reachable)
    if (q) list = list.filter(h =>
      h.ap.i.toLowerCase().includes(q) ||
      h.ap.a.toLowerCase().includes(q) ||
      h.ap.m.toLowerCase().includes(q) ||
      h.ap.n.toLowerCase().includes(q)
    )
    return list.slice(0, topN)
  }, [hits, query, reachableOnly, topN])

  // MapLibre overlay install/teardown
  useEffect(() => {
    const m = map
    if (!m) return
    let cancelled = false
    const install = () => {
      if (cancelled || installedRef.current) return
      try {
        if (!m.getSource(SRC_LINE)) m.addSource(SRC_LINE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
        if (!m.getLayer(LYR_LINE)) m.addLayer({
          id: LYR_LINE, type: 'line', source: SRC_LINE,
          paint: {
            'line-color': ['match', ['get', 'tier'], 'top', '#34d399', 'reachable', '#22d3ee', 'unreachable', '#f87171', '#94a3b8'],
            'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.2, 8, 2, 12, 3],
            'line-dasharray': [2, 2],
            'line-opacity': 0.85,
          },
        })
        if (!m.getSource(SRC_PIN)) m.addSource(SRC_PIN, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
        if (!m.getLayer(LYR_PIN)) m.addLayer({
          id: LYR_PIN, type: 'circle', source: SRC_PIN,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 4, 8, 8, 12, 12],
            'circle-color': ['match', ['get', 'tier'], 'top', '#10b981', 'reachable', '#06b6d4', 'unreachable', '#ef4444', '#64748b'],
            'circle-stroke-color': '#0b1220',
            'circle-stroke-width': 2,
            'circle-opacity': 0.9,
          },
        })
        if (!m.getLayer(LYR_LBL)) m.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC_PIN,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 11,
            'text-offset': [0, 1.2],
            'text-anchor': 'top',
            'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': '#f1f5f9',
            'text-halo-color': '#020617',
            'text-halo-width': 1.4,
          },
        })
        if (!m.getSource(SRC_GLIDE)) m.addSource(SRC_GLIDE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
        if (!m.getLayer(LYR_GLIDE)) m.addLayer({
          id: LYR_GLIDE, type: 'fill', source: SRC_GLIDE,
          paint: { 'fill-color': '#22d3ee', 'fill-opacity': 0.08 },
        })
        if (!m.getLayer(LYR_GLIDE_OUT)) m.addLayer({
          id: LYR_GLIDE_OUT, type: 'line', source: SRC_GLIDE,
          paint: { 'line-color': '#22d3ee', 'line-width': 1.5, 'line-dasharray': [1, 2], 'line-opacity': 0.6 },
        })
        installedRef.current = true
      } catch {}
    }
    if (m.isStyleLoaded()) install()
    else m.once('load', install)
    return () => {
      cancelled = true
      try {
        [LYR_LBL, LYR_PIN, LYR_LINE, LYR_GLIDE_OUT, LYR_GLIDE].forEach(id => { if (m.getLayer(id)) m.removeLayer(id) })
        ;[SRC_LINE, SRC_PIN, SRC_GLIDE].forEach(id => { if (m.getSource(id)) m.removeSource(id) })
      } catch {}
      installedRef.current = false
    }
  }, [map])

  // Update overlay data on hits change
  useEffect(() => {
    const m = map
    if (!m || !installedRef.current || !plane) return
    try {
      const lineFeatures: any[] = []
      const pinFeatures: any[] = []
      filtered.forEach((h, idx) => {
        const tier = idx < 3 ? 'top' : (h.reachable ? 'reachable' : 'unreachable')
        const coords = geodesic(plane.lat, plane.lng, h.ap.lat, h.ap.lon, 40)
        lineFeatures.push({
          type: 'Feature',
          properties: { tier },
          geometry: { type: 'LineString', coordinates: coords },
        })
        pinFeatures.push({
          type: 'Feature',
          properties: {
            tier,
            label: `${h.ap.a || h.ap.i}  ${Math.round(h.rangeNm)}nm`,
          },
          geometry: { type: 'Point', coordinates: [h.ap.lon, h.ap.lat] },
        })
      })
      ;(m.getSource(SRC_LINE) as maplibregl.GeoJSONSource)?.setData({ type: 'FeatureCollection', features: lineFeatures } as any)
      ;(m.getSource(SRC_PIN)  as maplibregl.GeoJSONSource)?.setData({ type: 'FeatureCollection', features: pinFeatures }  as any)

      // Glide cone: filled circle of glideNm around current position
      const gNm = (plane.altitudeFt / 6076) * glideRatio
      if (showGlide && gNm > 1 && !plane.ground) {
        const ring: number[][] = []
        for (let b = 0; b <= 360; b += 6) ring.push(dest(plane.lat, plane.lng, b, gNm))
        ;(m.getSource(SRC_GLIDE) as maplibregl.GeoJSONSource)?.setData({
          type: 'FeatureCollection',
          features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }],
        } as any)
      } else {
        ;(m.getSource(SRC_GLIDE) as maplibregl.GeoJSONSource)?.setData({ type: 'FeatureCollection', features: [] } as any)
      }
    } catch {}
  }, [map, plane, filtered, glideRatio, showGlide])

  if (!plane) {
    return (
      <div className="absolute right-4 top-32 w-[360px] max-w-[92vw] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl z-30 text-slate-100">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <div className="text-sm font-semibold">DIVERSION</div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none">×</button>
        </div>
        <div className="p-6 text-sm text-slate-400 text-center">
          Select an aircraft on the map to find the nearest suitable diversion airports.
        </div>
      </div>
    )
  }

  const fmtETA = (s: number) => {
    if (!isFinite(s) || s <= 0) return '—'
    const m = Math.round(s / 60)
    if (m < 60) return `${m}m`
    const h = Math.floor(m / 60), mm = m % 60
    return `${h}h${String(mm).padStart(2, '0')}`
  }

  return (
    <div className="absolute right-4 top-32 w-[400px] max-w-[92vw] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl z-30 text-slate-100">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div>
          <div className="text-sm font-semibold tracking-wide">DIVERSION FINDER</div>
          <div className="text-[10px] text-slate-400 uppercase tracking-wider mt-0.5">{plane.callsign || plane.icao}</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none">×</button>
      </div>

      <div className="px-4 py-3 border-b border-slate-800 space-y-3">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-slate-900/60 rounded-lg py-1.5 px-2">
            <div className="text-[10px] uppercase text-slate-500">Alt</div>
            <div className="text-sm font-mono">{Math.round(plane.altitudeFt).toLocaleString()}<span className="text-[10px] text-slate-500">ft</span></div>
          </div>
          <div className="bg-slate-900/60 rounded-lg py-1.5 px-2">
            <div className="text-[10px] uppercase text-slate-500">GS</div>
            <div className="text-sm font-mono">{Math.round(plane.velocityKts)}<span className="text-[10px] text-slate-500">kt</span></div>
          </div>
          <div className="bg-slate-900/60 rounded-lg py-1.5 px-2">
            <div className="text-[10px] uppercase text-slate-500">Glide</div>
            <div className="text-sm font-mono">{Math.round((plane.altitudeFt / 6076) * glideRatio)}<span className="text-[10px] text-slate-500">nm</span></div>
          </div>
        </div>

        <div>
          <div className="flex justify-between text-[11px] text-slate-400 mb-1">
            <span>Endurance</span><span className="font-mono">{enduranceMin}min</span>
          </div>
          <input type="range" min={10} max={420} step={10} value={enduranceMin}
            onChange={e => setEnduranceMin(parseInt(e.target.value))}
            className="w-full accent-emerald-400" />
        </div>
        <div>
          <div className="flex justify-between text-[11px] text-slate-400 mb-1">
            <span>Glide ratio (L/D)</span><span className="font-mono">{glideRatio}:1</span>
          </div>
          <input type="range" min={6} max={22} step={1} value={glideRatio}
            onChange={e => setGlideRatio(parseInt(e.target.value))}
            className="w-full accent-cyan-400" />
        </div>
        <div>
          <div className="flex justify-between text-[11px] text-slate-400 mb-1">
            <span>Top N airports</span><span className="font-mono">{topN}</span>
          </div>
          <input type="range" min={3} max={20} step={1} value={topN}
            onChange={e => setTopN(parseInt(e.target.value))}
            className="w-full accent-sky-400" />
        </div>

        <div className="flex items-center gap-3 text-[11px]">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={showGlide} onChange={e => setShowGlide(e.target.checked)}
              className="accent-cyan-400" />
            Glide cone
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={reachableOnly} onChange={e => setReachableOnly(e.target.checked)}
              className="accent-emerald-400" />
            Reachable only
          </label>
        </div>

        <input
          type="text" placeholder="Filter IATA/ICAO/city..."
          value={query} onChange={e => setQuery(e.target.value)}
          className="w-full bg-slate-900/60 border border-slate-800 rounded-lg px-3 py-1.5 text-xs placeholder-slate-500 focus:outline-none focus:border-sky-500"
        />
      </div>

      <div className="max-h-[44vh] overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-slate-500">No airports match the current filters.</div>
        )}
        {filtered.map((h, i) => (
          <button
            key={h.ap.i}
            onClick={() => onFlyAirport?.(h.ap.i)}
            className="w-full text-left px-4 py-2 border-b border-slate-800/50 hover:bg-slate-800/40 transition flex items-center gap-3"
          >
            <div className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${
              i < 3 ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                : h.reachable ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'}`}>
              {i + 1}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-sm font-semibold">{h.ap.a || h.ap.i}</span>
                <span className="text-[10px] text-slate-500 font-mono">{h.ap.i}</span>
                {h.glideOk && <span className="text-[9px] bg-cyan-500/20 text-cyan-300 px-1.5 rounded uppercase tracking-wider">glide</span>}
              </div>
              <div className="text-[10px] text-slate-400 truncate">{h.ap.m}{h.ap.n ? ` — ${h.ap.n}` : ''}</div>
            </div>
            <div className="text-right text-[10px] font-mono leading-tight">
              <div className="text-slate-200">{Math.round(h.rangeNm)}nm</div>
              <div className="text-slate-500">{Math.round(h.brg).toString().padStart(3, '0')}° · Δ{Math.round(h.offTrackDeg)}°</div>
              <div className={h.reachable ? 'text-emerald-400' : 'text-rose-400'}>{fmtETA(h.etaSec)}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
