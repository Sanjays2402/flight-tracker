'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Tripwire / Virtual Gate
   -----------------------------------------------------------
   The user clicks the map twice to drop a two-point "tripwire"
   line segment (a virtual gate). For every airborne aircraft we
   forward-project the current great-circle ground vector and
   solve analytically for the time-to-crossing of the segment.

   For each predicted crossing we compute:
     - tCross (seconds until the aircraft body crosses the line)
     - the lat/lng of the crossing point on the segment
     - which side it crosses from (LEFT/RIGHT of the gate's
       directional vector) and a NET-IN / NET-OUT classification
     - the altitude/FL the aircraft will be at when it crosses
       (using current vertical rate)
     - the angle the aircraft track makes with the gate normal
       (90° = head-on through the wire, 0° = grazing parallel)

   MapLibre overlay paints:
     - the tripwire as a thick amber segment with endpoint pins
     - directional chevron arrows ON the wire showing IN-direction
     - dashed forecast tracks for each crossing aircraft, ending
       with a marker at the predicted crossing point, colored by
       direction (cyan = INBOUND, rose = OUTBOUND)
     - labels: "CSN T-MM:SS FL###" at each crossing dot

   Side panel: tunable horizon (1-30min), min-FL filter, side
   filter (IN/OUT/ALL), search box, totals counter strip (in/out
   over horizon), ranked list sorted by T-cross with click-to-fly.

   Useful as: virtual ATC handoff line, runway threshold gate,
   border crossing detector, airshow display line, photographer
   "shoot when it crosses here" planner.
   ============================================================ */

export interface TwFlight {
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
  flights: TwFlight[]
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

/* Local-tangent ENU projection — fine for sub-300nm spans. */
function makeENU(lat0: number, lng0: number) {
  const cosLat = Math.cos(lat0 * RAD)
  return {
    fwd: (lat: number, lng: number) => {
      const dx = ((lng - lng0 + 540) % 360 - 180) * 60 * cosLat
      const dy = (lat - lat0) * 60
      return [dx, dy] as [number, number]
    },
    inv: (x: number, y: number) => {
      const lat = lat0 + y / 60
      const lng = lng0 + x / (60 * cosLat)
      return [lng, lat] as [number, number]
    }
  }
}

interface Crossing {
  flight: TwFlight
  tSec: number
  crossLat: number
  crossLng: number
  side: 'IN' | 'OUT'      // direction relative to gate normal
  crossAlt: number         // ft
  angleDeg: number         // 0..90 (vs gate normal: 90 = head-on)
  alongFrac: number        // 0..1 along the segment (A->B)
  rangeNm: number          // distance from aircraft to crossing point
}

const SRC_WIRE = 'tw-wire-src'
const LYR_WIRE = 'tw-wire-lyr'
const LYR_WIRE_OUT = 'tw-wire-out-lyr'
const SRC_ENDS = 'tw-ends-src'
const LYR_ENDS = 'tw-ends-lyr'
const LYR_ENDS_LBL = 'tw-ends-lbl'
const SRC_TRK = 'tw-trk-src'
const LYR_TRK = 'tw-trk-lyr'
const SRC_PTS = 'tw-pts-src'
const LYR_PTS = 'tw-pts-lyr'
const LYR_PTS_LBL = 'tw-pts-lbl'
const SRC_ARR = 'tw-arr-src'
const LYR_ARR = 'tw-arr-lyr'

function fmtT(s: number) {
  if (!isFinite(s) || s < 0) return '—'
  const m = Math.floor(s / 60), ss = Math.floor(s % 60)
  return `${m}:${String(ss).padStart(2, '0')}`
}

export default function Tripwire({ map, flights, onClose, onFly }: Props) {
  const [a, setA] = useState<{ lat: number; lng: number } | null>(null)
  const [b, setB] = useState<{ lat: number; lng: number } | null>(null)
  const [placing, setPlacing] = useState<'A' | 'B' | null>('A')
  const [horizonMin, setHorizonMin] = useState<number>(10)
  const [minFL, setMinFL] = useState<number>(0)
  const [sideFilter, setSideFilter] = useState<'ALL' | 'IN' | 'OUT'>('ALL')
  const [query, setQuery] = useState<string>('')
  const [showOverlay, setShowOverlay] = useState<boolean>(true)
  const installedRef = useRef<boolean>(false)
  const clickRef = useRef<((e: maplibregl.MapMouseEvent) => void) | null>(null)

  /* Install MapLibre sources/layers once. */
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        const empty = { type: 'FeatureCollection' as const, features: [] }
        if (!map.getSource(SRC_WIRE)) map.addSource(SRC_WIRE, { type: 'geojson', data: empty })
        if (!map.getSource(SRC_ENDS)) map.addSource(SRC_ENDS, { type: 'geojson', data: empty })
        if (!map.getSource(SRC_TRK)) map.addSource(SRC_TRK, { type: 'geojson', data: empty })
        if (!map.getSource(SRC_PTS)) map.addSource(SRC_PTS, { type: 'geojson', data: empty })
        if (!map.getSource(SRC_ARR)) map.addSource(SRC_ARR, { type: 'geojson', data: empty })
        if (!map.getLayer(LYR_WIRE_OUT)) map.addLayer({
          id: LYR_WIRE_OUT, type: 'line', source: SRC_WIRE,
          paint: { 'line-color': '#0f172a', 'line-opacity': 0.9, 'line-width': 7 }
        })
        if (!map.getLayer(LYR_WIRE)) map.addLayer({
          id: LYR_WIRE, type: 'line', source: SRC_WIRE,
          paint: { 'line-color': '#fbbf24', 'line-opacity': 0.95, 'line-width': 3 }
        })
        if (!map.getLayer(LYR_ARR)) map.addLayer({
          id: LYR_ARR, type: 'symbol', source: SRC_ARR,
          layout: {
            'text-field': '►',
            'text-size': 14,
            'text-rotate': ['get', 'rot'],
            'text-rotation-alignment': 'map',
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: { 'text-color': '#fbbf24', 'text-halo-color': '#0f172a', 'text-halo-width': 1.5 }
        })
        if (!map.getLayer(LYR_ENDS)) map.addLayer({
          id: LYR_ENDS, type: 'circle', source: SRC_ENDS,
          paint: {
            'circle-radius': 6, 'circle-color': '#fbbf24',
            'circle-stroke-color': '#0f172a', 'circle-stroke-width': 2
          }
        })
        if (!map.getLayer(LYR_ENDS_LBL)) {
          try {
            map.addLayer({
              id: LYR_ENDS_LBL, type: 'symbol', source: SRC_ENDS,
              layout: {
                'text-field': ['get', 'label'],
                'text-size': 11,
                'text-font': ['Noto Sans Regular'],
                'text-offset': [0, -1.2],
                'text-allow-overlap': true,
              },
              paint: { 'text-color': '#fde68a', 'text-halo-color': '#0f172a', 'text-halo-width': 1.2 }
            })
          } catch {}
        }
        if (!map.getLayer(LYR_TRK)) map.addLayer({
          id: LYR_TRK, type: 'line', source: SRC_TRK,
          paint: {
            'line-color': ['get', 'color'],
            'line-opacity': 0.85,
            'line-width': 1.6,
            'line-dasharray': [2, 2],
          }
        })
        if (!map.getLayer(LYR_PTS)) map.addLayer({
          id: LYR_PTS, type: 'circle', source: SRC_PTS,
          paint: {
            'circle-radius': 5,
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#0f172a', 'circle-stroke-width': 1.5
          }
        })
        if (!map.getLayer(LYR_PTS_LBL)) {
          try {
            map.addLayer({
              id: LYR_PTS_LBL, type: 'symbol', source: SRC_PTS,
              layout: {
                'text-field': ['get', 'label'],
                'text-size': 10,
                'text-font': ['Noto Sans Regular'],
                'text-offset': [0, -1.0],
                'text-allow-overlap': true,
              },
              paint: { 'text-color': '#e2e8f0', 'text-halo-color': '#0f172a', 'text-halo-width': 1.2 }
            })
          } catch {}
        }
        installedRef.current = true
      } catch {}
    }
    ensure()
    if (!installedRef.current) map.once('load', ensure)
    return () => {
      try {
        for (const l of [LYR_PTS_LBL, LYR_PTS, LYR_TRK, LYR_ENDS_LBL, LYR_ENDS, LYR_ARR, LYR_WIRE, LYR_WIRE_OUT]) {
          if (map.getLayer(l)) map.removeLayer(l)
        }
        for (const s of [SRC_PTS, SRC_TRK, SRC_ENDS, SRC_ARR, SRC_WIRE]) {
          if (map.getSource(s)) map.removeSource(s)
        }
      } catch {}
    }
  }, [map])

  /* Click-to-place handler — toggles A/B placement as user clicks. */
  useEffect(() => {
    if (!map || !placing) return
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const p = { lat: e.lngLat.lat, lng: e.lngLat.lng }
      if (placing === 'A') {
        setA(p); setB(null); setPlacing('B')
      } else {
        setB(p); setPlacing(null)
      }
    }
    clickRef.current = onClick
    map.on('click', onClick)
    map.getCanvas().style.cursor = 'crosshair'
    return () => {
      try {
        if (clickRef.current) map.off('click', clickRef.current)
        map.getCanvas().style.cursor = ''
      } catch {}
    }
  }, [map, placing])

  /* Compute crossings analytically in a local tangent plane. */
  const crossings: Crossing[] = useMemo(() => {
    if (!a || !b) return []
    const horizonSec = horizonMin * 60
    const proj = makeENU((a.lat + b.lat) / 2, (a.lng + b.lng) / 2)
    const [ax, ay] = proj.fwd(a.lat, a.lng)
    const [bx, by] = proj.fwd(b.lat, b.lng)
    const segDx = bx - ax, segDy = by - ay
    const segLen2 = segDx * segDx + segDy * segDy
    if (segLen2 < 1e-6) return []
    // Gate normal: rotate segment +90° (left-of-direction is "IN" by convention).
    const nx = -segDy, ny = segDx
    const out: Crossing[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      if (f.altitudeFt < minFL * 100) continue
      const gs = f.velocityKts || 0
      if (gs < 30) continue
      const [px, py] = proj.fwd(f.lat, f.lng)
      // Velocity in nm/sec; bearing 0=N=+y, 90=E=+x
      const vNm = gs / 3600
      const trkRad = f.track * RAD
      const vx = vNm * Math.sin(trkRad)
      const vy = vNm * Math.cos(trkRad)
      // Solve (P + t*V - A) × (B - A) = 0  =>  scalar cross == 0
      // cross( (P-A) + tV , D ) = 0  =>  t = (D × (A-P)) / (D × V)
      const dxA = ax - px, dyA = ay - py
      const denom = segDx * vy - segDy * vx
      if (Math.abs(denom) < 1e-9) continue
      const t = (segDx * dyA - segDy * dxA) / denom
      if (!isFinite(t) || t <= 0 || t > horizonSec) continue
      // Position at t
      const cx = px + t * vx, cy = py + t * vy
      // Along-segment fraction
      const u = ((cx - ax) * segDx + (cy - ay) * segDy) / segLen2
      if (u < 0 || u > 1) continue
      // Side: sign of (V · n) — positive means flying along +n direction = "IN"
      const dot = vx * nx + vy * ny
      const side: 'IN' | 'OUT' = dot >= 0 ? 'IN' : 'OUT'
      // Angle vs normal (head-on = 90°)
      const speed = Math.sqrt(vx * vx + vy * vy)
      const nMag = Math.sqrt(nx * nx + ny * ny)
      const cosA = Math.abs(dot) / (speed * nMag + 1e-12)
      const angle = Math.acos(Math.max(0, Math.min(1, cosA))) * DEG // 0=head-on, 90=parallel
      const headOn = 90 - angle
      const [cLng, cLat] = proj.inv(cx, cy)
      const crossAlt = Math.max(0, f.altitudeFt + (f.vertRate || 0) * (t / 60))
      const rng = Math.sqrt((cx - px) ** 2 + (cy - py) ** 2)
      out.push({
        flight: f,
        tSec: t,
        crossLat: cLat, crossLng: cLng,
        side, crossAlt,
        angleDeg: headOn,
        alongFrac: u,
        rangeNm: rng,
      })
    }
    return out
  }, [a, b, flights, horizonMin, minFL])

  /* Apply user filters for list + map rendering. */
  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return crossings
      .filter(c => sideFilter === 'ALL' || c.side === sideFilter)
      .filter(c => !q
        || c.flight.callsign.toUpperCase().includes(q)
        || c.flight.icao.toUpperCase().includes(q)
        || (c.flight.type || '').toUpperCase().includes(q)
        || (c.flight.operator || '').toUpperCase().includes(q))
      .sort((x, y) => x.tSec - y.tSec)
  }, [crossings, sideFilter, query])

  const inCount = crossings.filter(c => c.side === 'IN').length
  const outCount = crossings.filter(c => c.side === 'OUT').length

  /* Push geometry to MapLibre sources. */
  useEffect(() => {
    if (!map) return
    try {
      // Wire
      if (a && b) {
        ;(map.getSource(SRC_WIRE) as maplibregl.GeoJSONSource | undefined)?.setData({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature', properties: {},
            geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], [b.lng, b.lat]] }
          }]
        })
        const brgAB = bearingDeg(a.lat, a.lng, b.lat, b.lng)
        const segNm = distNm(a.lat, a.lng, b.lat, b.lng)
        // Direction-arrow features along the wire (chevrons point along A->B,
        // i.e. "IN" is the LEFT side of travel = rotated -90 from segment heading).
        const arrowFeats: GeoJSON.Feature[] = []
        const arrowCount = Math.max(2, Math.min(8, Math.round(segNm / 10)))
        for (let i = 1; i <= arrowCount; i++) {
          const frac = i / (arrowCount + 1)
          const [lng, lat] = dest(a.lat, a.lng, brgAB, segNm * frac)
          arrowFeats.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lng, lat] },
            properties: { rot: (brgAB - 90 + 360) % 360 } // point INTO the IN-side
          })
        }
        ;(map.getSource(SRC_ARR) as maplibregl.GeoJSONSource | undefined)?.setData({
          type: 'FeatureCollection', features: arrowFeats
        })
        ;(map.getSource(SRC_ENDS) as maplibregl.GeoJSONSource | undefined)?.setData({
          type: 'FeatureCollection',
          features: [
            { type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng, a.lat] }, properties: { label: 'A' } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [b.lng, b.lat] }, properties: { label: 'B' } },
          ]
        })
      } else {
        const empty = { type: 'FeatureCollection' as const, features: [] }
        ;(map.getSource(SRC_WIRE) as maplibregl.GeoJSONSource | undefined)?.setData(empty)
        ;(map.getSource(SRC_ARR) as maplibregl.GeoJSONSource | undefined)?.setData(empty)
        ;(map.getSource(SRC_ENDS) as maplibregl.GeoJSONSource | undefined)?.setData(
          a ? { type: 'FeatureCollection',
                features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng, a.lat] }, properties: { label: 'A' } }] }
            : empty
        )
      }

      const trkFeats: GeoJSON.Feature[] = []
      const ptFeats: GeoJSON.Feature[] = []
      if (showOverlay) {
        for (const c of filtered) {
          const color = c.side === 'IN' ? '#22d3ee' : '#fb7185'
          trkFeats.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[c.flight.lng, c.flight.lat], [c.crossLng, c.crossLat]] },
            properties: { color }
          })
          ptFeats.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [c.crossLng, c.crossLat] },
            properties: {
              color,
              label: `${c.flight.callsign || c.flight.icao}  T-${fmtT(c.tSec)}  FL${Math.round(c.crossAlt / 100).toString().padStart(3, '0')}`
            }
          })
        }
      }
      ;(map.getSource(SRC_TRK) as maplibregl.GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection', features: trkFeats
      })
      ;(map.getSource(SRC_PTS) as maplibregl.GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection', features: ptFeats
      })
    } catch {}
  }, [map, a, b, filtered, showOverlay])

  const wireBrg = (a && b) ? bearingDeg(a.lat, a.lng, b.lat, b.lng) : null
  const wireLen = (a && b) ? distNm(a.lat, a.lng, b.lat, b.lng) : null

  return (
    <div className="pointer-events-auto absolute top-3 right-3 z-30 w-[360px] max-h-[88vh] overflow-hidden rounded-2xl border border-amber-500/30 bg-slate-950/85 backdrop-blur shadow-2xl flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-amber-300 font-semibold tracking-wide text-sm">TRIPWIRE</span>
          <span className="text-[10px] text-slate-400 uppercase">virtual gate</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-xs px-2 py-0.5 rounded hover:bg-slate-800">close</button>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 grid grid-cols-3 gap-1 text-center text-[11px]">
        <button onClick={() => setSideFilter('ALL')}
          className={`rounded px-1 py-1 ${sideFilter==='ALL' ? 'bg-amber-500/20 text-amber-200' : 'bg-slate-900 text-slate-300 hover:bg-slate-800'}`}>
          ALL <span className="text-slate-100 font-semibold">{crossings.length}</span>
        </button>
        <button onClick={() => setSideFilter('IN')}
          className={`rounded px-1 py-1 ${sideFilter==='IN' ? 'bg-cyan-500/25 text-cyan-200' : 'bg-slate-900 text-slate-300 hover:bg-slate-800'}`}>
          IN <span className="text-cyan-200 font-semibold">{inCount}</span>
        </button>
        <button onClick={() => setSideFilter('OUT')}
          className={`rounded px-1 py-1 ${sideFilter==='OUT' ? 'bg-rose-500/25 text-rose-200' : 'bg-slate-900 text-slate-300 hover:bg-slate-800'}`}>
          OUT <span className="text-rose-200 font-semibold">{outCount}</span>
        </button>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setA(null); setB(null); setPlacing('A') }}
            className="text-[11px] px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 font-medium">
            {placing === 'A' ? 'click map: A' : placing === 'B' ? 'click map: B' : 'reset'}
          </button>
          <label className="flex items-center gap-1 text-[11px] text-slate-300 cursor-pointer">
            <input type="checkbox" checked={showOverlay} onChange={e => setShowOverlay(e.target.checked)} className="accent-amber-400" />
            overlay
          </label>
          <span className="ml-auto text-[10px] text-slate-400 tabular-nums">
            {wireLen != null && wireBrg != null
              ? `${wireLen.toFixed(1)}nm @ ${wireBrg.toFixed(0)}°`
              : 'no gate'}
          </span>
        </div>
        <div className="text-[10px] text-slate-400 leading-tight">
          IN-side = LEFT of A→B. Chevrons on the wire point into IN.
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
            <span>horizon</span><span className="text-slate-200 tabular-nums">{horizonMin}min</span>
          </div>
          <input type="range" min={1} max={30} step={1} value={horizonMin}
            onChange={e => setHorizonMin(parseInt(e.target.value, 10))}
            className="w-full accent-amber-400" />
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
            <span>min FL</span><span className="text-slate-200 tabular-nums">FL{String(minFL).padStart(3,'0')}</span>
          </div>
          <input type="range" min={0} max={450} step={10} value={minFL}
            onChange={e => setMinFL(parseInt(e.target.value, 10))}
            className="w-full accent-amber-400" />
        </div>
        <input
          type="text" value={query} onChange={e => setQuery(e.target.value)}
          placeholder="search callsign / type / operator"
          className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-500 outline-none focus:border-amber-500/60"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {!a || !b ? (
          <div className="text-center text-[11px] text-slate-400 py-10 px-4">
            {placing === 'A' && 'Click anywhere on the map to drop point A.'}
            {placing === 'B' && 'Now click again to drop point B and close the gate.'}
            {!placing && 'Hit RESET to drop a new gate.'}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-[11px] text-slate-500 py-10 px-4">
            No aircraft predicted to cross within {horizonMin}min.
          </div>
        ) : (
          <ul className="divide-y divide-slate-800/70">
            {filtered.slice(0, 80).map((c) => {
              const color = c.side === 'IN' ? '#22d3ee' : '#fb7185'
              return (
                <li
                  key={c.flight.icao}
                  onClick={() => onFly(c.flight.icao)}
                  className="px-3 py-2 hover:bg-slate-900/70 cursor-pointer">
                  <div className="flex items-start gap-2">
                    <div className="w-1 self-stretch rounded" style={{ background: color }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[12px] font-semibold text-slate-100 truncate">{c.flight.callsign || c.flight.icao}</span>
                        <span className="text-[10px] uppercase font-medium" style={{ color }}>{c.side}</span>
                        <span className="ml-auto text-[11px] font-mono tabular-nums text-amber-200">T-{fmtT(c.tSec)}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-slate-400 mt-0.5">
                        <span className="truncate">{c.flight.type || '—'}{c.flight.operator ? ` · ${c.flight.operator}` : ''}</span>
                      </div>
                      <div className="flex items-center gap-3 text-[10px] text-slate-300 tabular-nums mt-0.5">
                        <span>FL{Math.round(c.crossAlt / 100).toString().padStart(3, '0')}</span>
                        <span>{c.rangeNm.toFixed(1)}nm</span>
                        <span>∠{c.angleDeg.toFixed(0)}°</span>
                        <span className="text-slate-500">{(c.alongFrac * 100).toFixed(0)}%</span>
                      </div>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
