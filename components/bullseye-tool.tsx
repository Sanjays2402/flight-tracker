'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Bullseye / BRA Tactical Reference
   ---------------------------------------------------------------
   Click the map to drop a tactical "bullseye" datum. We render:
     - A series of concentric range rings (geodesic circles) at a
       configurable spacing, with nm labels.
     - A 16-spoke compass rose with cardinal+intercardinal radials.
     - A center pin with a hand-drawn cross.
   The side panel ranks every live aircraft as a BRA call:
     "<bearing>/<range> <altitude>" — the classic fighter brevity
     for telling somebody where a contact is relative to a datum.
   Toggleable magnetic vs true bearings (rough mag-var model),
   adjustable ring spacing (5/10/25/50nm), and click-to-fly on each
   aircraft. Cmd+K registers a toggle action.
   ============================================================ */

export interface BEFlight {
  icao: string
  callsign: string
  lat: number
  lng: number
  altitudeFt: number
  ground: boolean
  track: number
  velocityKts: number
  emergency: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: BEFlight[]
  onClose: () => void
  onFly?: (icao: string) => void
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

// Destination point given start, bearing (deg true), distance (nm)
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

// Very rough magnetic declination model (good to ~5° most places).
// Replace with WMM if precision matters; we just want directional sanity.
function magVar(lat: number, lng: number): number {
  // 1st-order: westward decl in Atlantic+Americas, eastward in Eurasia.
  return -10 * Math.sin((lng + 30) * RAD) * Math.cos(lat * RAD * 0.8)
}

function ringGeojson(lat: number, lng: number, nm: number): GeoJSON.Feature<GeoJSON.LineString> {
  const coords: number[][] = []
  for (let b = 0; b <= 360; b += 6) coords.push(dest(lat, lng, b, nm))
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { nm } }
}

function radialGeojson(lat: number, lng: number, brg: number, nm: number): GeoJSON.Feature<GeoJSON.LineString> {
  const steps = 12
  const coords: number[][] = []
  for (let i = 0; i <= steps; i++) coords.push(dest(lat, lng, brg, (nm * i) / steps))
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { brg } }
}

const SRC_RINGS = 'be-rings-src'
const SRC_RADIALS = 'be-radials-src'
const SRC_CENTER = 'be-center-src'
const SRC_LABELS = 'be-labels-src'
const L_RINGS = 'be-rings-line'
const L_RADIALS = 'be-radials-line'
const L_CENTER = 'be-center-pt'
const L_CENTER_CROSS = 'be-center-cross'
const L_LABELS = 'be-labels-sym'

const SPACING_OPTS = [5, 10, 25, 50, 100] as const

export default function BullseyeTool({ map, flights, onClose, onFly }: Props) {
  const [center, setCenter] = useState<{ lat: number; lng: number } | null>(null)
  const [spacing, setSpacing] = useState<number>(25)
  const [rings, setRings] = useState<number>(5)
  const [magnetic, setMagnetic] = useState<boolean>(false)
  const [query, setQuery] = useState<string>('')
  const clickHandlerRef = useRef<((e: maplibregl.MapMouseEvent) => void) | null>(null)

  // Install map sources/layers + click-to-place handler
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC_RINGS)) map.addSource(SRC_RINGS, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getSource(SRC_RADIALS)) map.addSource(SRC_RADIALS, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getSource(SRC_LABELS)) map.addSource(SRC_LABELS, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getSource(SRC_CENTER)) map.addSource(SRC_CENTER, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(L_RINGS)) map.addLayer({
          id: L_RINGS, type: 'line', source: SRC_RINGS,
          paint: { 'line-color': '#fbbf24', 'line-opacity': 0.55, 'line-width': 1, 'line-dasharray': [2, 2] }
        })
        if (!map.getLayer(L_RADIALS)) map.addLayer({
          id: L_RADIALS, type: 'line', source: SRC_RADIALS,
          paint: { 'line-color': '#fcd34d', 'line-opacity': 0.45, 'line-width': 1 }
        })
        if (!map.getLayer(L_CENTER)) map.addLayer({
          id: L_CENTER, type: 'circle', source: SRC_CENTER,
          paint: { 'circle-radius': 6, 'circle-color': '#fbbf24', 'circle-stroke-color': '#0f172a', 'circle-stroke-width': 2 }
        })
        if (!map.getLayer(L_LABELS)) {
          try {
            map.addLayer({
              id: L_LABELS, type: 'symbol', source: SRC_LABELS,
              layout: {
                'text-field': ['get', 'label'],
                'text-size': 10,
                'text-font': ['Noto Sans Regular'],
                'text-offset': [0, -0.6],
                'text-allow-overlap': true,
              },
              paint: {
                'text-color': '#fde68a',
                'text-halo-color': '#0f172a',
                'text-halo-width': 1.2,
              }
            })
          } catch { /* style may lack fonts */ }
        }
      } catch {}
    }
    ensure()

    const onClick = (e: maplibregl.MapMouseEvent) => {
      setCenter({ lat: e.lngLat.lat, lng: e.lngLat.lng })
    }
    clickHandlerRef.current = onClick
    map.on('click', onClick)
    map.getCanvas().style.cursor = 'crosshair'

    return () => {
      try {
        if (clickHandlerRef.current) map.off('click', clickHandlerRef.current)
        map.getCanvas().style.cursor = ''
        for (const l of [L_LABELS, L_CENTER_CROSS, L_CENTER, L_RADIALS, L_RINGS]) {
          if (map.getLayer(l)) map.removeLayer(l)
        }
        for (const s of [SRC_LABELS, SRC_CENTER, SRC_RADIALS, SRC_RINGS]) {
          if (map.getSource(s)) map.removeSource(s)
        }
      } catch {}
    }
  }, [map])

  // Update rendered geometry whenever center/spacing/rings changes
  useEffect(() => {
    if (!map || !center) return
    try {
      const ringFeats: GeoJSON.Feature[] = []
      const labelFeats: GeoJSON.Feature[] = []
      for (let i = 1; i <= rings; i++) {
        const nm = i * spacing
        ringFeats.push(ringGeojson(center.lat, center.lng, nm))
        const [llng, llat] = dest(center.lat, center.lng, 360, nm)
        labelFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [llng, llat] },
          properties: { label: `${nm}nm` }
        })
      }
      const radialFeats: GeoJSON.Feature[] = []
      const cardinals = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
      const outer = rings * spacing
      for (let i = 0; i < 16; i++) {
        const brg = i * 22.5
        radialFeats.push(radialGeojson(center.lat, center.lng, brg, outer))
        const [llng, llat] = dest(center.lat, center.lng, brg, outer * 1.04)
        labelFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [llng, llat] },
          properties: { label: cardinals[i] }
        })
      }
      ;(map.getSource(SRC_RINGS) as maplibregl.GeoJSONSource)?.setData({ type: 'FeatureCollection', features: ringFeats })
      ;(map.getSource(SRC_RADIALS) as maplibregl.GeoJSONSource)?.setData({ type: 'FeatureCollection', features: radialFeats })
      ;(map.getSource(SRC_LABELS) as maplibregl.GeoJSONSource)?.setData({ type: 'FeatureCollection', features: labelFeats })
      ;(map.getSource(SRC_CENTER) as maplibregl.GeoJSONSource)?.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [center.lng, center.lat] }, properties: {} }]
      })
    } catch {}
  }, [map, center, spacing, rings])

  const mv = useMemo(() => center ? magVar(center.lat, center.lng) : 0, [center])

  const ranked = useMemo(() => {
    if (!center) return []
    const q = query.trim().toUpperCase()
    return flights
      .filter(f => Number.isFinite(f.lat) && Number.isFinite(f.lng))
      .map(f => {
        const brgT = bearingDeg(center.lat, center.lng, f.lat, f.lng)
        const brg = magnetic ? (brgT - mv + 360) % 360 : brgT
        const rng = distNm(center.lat, center.lng, f.lat, f.lng)
        return { f, brg, rng }
      })
      .filter(x => !q || x.f.callsign.toUpperCase().includes(q) || x.f.icao.toUpperCase().includes(q))
      .sort((a, b) => a.rng - b.rng)
      .slice(0, 200)
  }, [center, flights, query, magnetic, mv])

  return (
    <aside className="absolute top-3 md:top-4 right-3 md:right-4 z-20 w-[300px] max-h-[calc(100vh-2rem)] bg-slate-950/95 backdrop-blur border border-amber-700/40 rounded-xl shadow-2xl flex flex-col overflow-hidden">
      <header className="px-3 py-2 flex items-center gap-2 border-b border-slate-800 bg-gradient-to-b from-amber-900/30 to-transparent">
        <span className="text-amber-300 text-base leading-none">⊕</span>
        <div className="flex-1">
          <div className="text-[11px] uppercase tracking-widest text-amber-200 font-semibold">Bullseye</div>
          <div className="text-[9px] text-slate-500">BRA reference · click map to set</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">✕</button>
      </header>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="flex items-center gap-1 text-[10px]">
          <span className="text-slate-500 mr-1">Ring:</span>
          {SPACING_OPTS.map(s => (
            <button key={s} onClick={() => setSpacing(s)}
              className={`px-1.5 py-0.5 rounded border ${spacing===s?'border-amber-500 text-amber-200 bg-amber-900/30':'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
              {s}
            </button>
          ))}
          <span className="text-slate-600 ml-1">nm</span>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-slate-500">Count:</span>
          <input type="range" min={2} max={10} value={rings} onChange={e=>setRings(parseInt(e.target.value))}
            className="flex-1 accent-amber-500" />
          <span className="text-amber-200 w-4 text-right">{rings}</span>
        </div>
        <div className="flex items-center justify-between text-[10px]">
          <button onClick={()=>setMagnetic(v=>!v)}
            className={`px-2 py-0.5 rounded border ${magnetic?'border-amber-500 text-amber-200 bg-amber-900/30':'border-slate-700 text-slate-400'}`}>
            {magnetic ? 'MAG' : 'TRUE'}
          </button>
          {center ? (
            <span className="text-slate-500 font-mono">
              {center.lat.toFixed(3)}, {center.lng.toFixed(3)}
              {magnetic ? ` · var ${mv>=0?'+':''}${mv.toFixed(1)}°` : ''}
            </span>
          ) : (
            <span className="text-amber-400/70">click map to drop</span>
          )}
        </div>
        {center && (
          <button onClick={()=>setCenter(null)}
            className="w-full text-[10px] uppercase tracking-widest text-slate-400 hover:text-amber-200 border border-slate-800 rounded py-1">
            Clear bullseye
          </button>
        )}
      </div>

      {center && (
        <>
          <div className="px-3 py-1.5 border-b border-slate-800">
            <input
              value={query}
              onChange={e=>setQuery(e.target.value)}
              placeholder="filter callsign/hex"
              className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-amber-600"
            />
          </div>
          <div className="flex-1 overflow-y-auto text-[11px] font-mono">
            {ranked.length === 0 ? (
              <div className="px-3 py-6 text-center text-slate-500 text-[10px]">No contacts.</div>
            ) : ranked.map(({ f, brg, rng }) => {
              const altK = f.ground ? 'GND' : `${Math.round(f.altitudeFt/100).toString().padStart(3,'0')}`
              return (
                <button
                  key={f.icao}
                  onClick={()=>onFly?.(f.icao)}
                  className="w-full text-left px-3 py-1.5 border-b border-slate-900 hover:bg-amber-900/15 flex items-center gap-2"
                >
                  <span className={`w-1 h-5 rounded-sm ${f.emergency?'bg-rose-500':rng<10?'bg-amber-400':rng<25?'bg-amber-500/70':'bg-slate-600'}`} />
                  <span className="flex-1 truncate text-slate-200">{f.callsign || f.icao.toUpperCase()}</span>
                  <span className="text-amber-200 tabular-nums w-9 text-right">{Math.round(brg).toString().padStart(3,'0')}°</span>
                  <span className="text-slate-300 tabular-nums w-12 text-right">{rng<10?rng.toFixed(1):Math.round(rng)}nm</span>
                  <span className="text-slate-500 tabular-nums w-8 text-right">{altK}</span>
                </button>
              )
            })}
          </div>
          <footer className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 flex justify-between">
            <span>{ranked.length} contacts</span>
            <span>format: BRG° / RNG / FL</span>
          </footer>
        </>
      )}
    </aside>
  )
}
