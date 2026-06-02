'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { Delaunay } from 'd3-delaunay'

/* ============================================================
   Voronoi Territory
   -----------------------------------------------------------
   Partitions visible airspace into per-aircraft Voronoi cells.
   Each cell = the set of points closer to that aircraft than to
   any other. Renders as colored polygons on the map, computes
   per-cell area in km^2 (the aircraft's "territory"), nearest-
   neighbor distance, and ranks aircraft by isolation (most-
   alone-in-the-sky) and crowdedness (smallest cell).

   Cells are clipped to the current map bounds for stability and
   computed in equirectangular projection scaled by cos(lat0) so
   areas are reasonable at mid-latitudes.

   Side panel shows:
     * Stat strip (cells, mean/median area, total covered km^2)
     * 3 mode tabs: ISOLATED (largest cells) / CROWDED (smallest
       cells) / NEIGHBORS (sorted by nearest-neighbor distance)
     * Per-row stripe in cell color, callsign/type/operator,
       area / nearest-NM / FL / kt readout, click-to-fly.

   Sliders: min FL filter, ground toggle, cell fill opacity,
   show edges, color mode (rainbow / by-altitude / by-area).
   ============================================================ */

export interface VtFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: VtFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

const SRC_FILL = 'vt-fill-src'
const LYR_FILL = 'vt-fill-lyr'
const LYR_LINE = 'vt-line-lyr'
const SRC_PTS = 'vt-pts-src'
const LYR_PTS = 'vt-pts-lyr'

const R_NM_PER_DEG = 60
const NM_PER_KM = 0.539957

function hsl(h: number, s = 70, l = 55) { return `hsl(${h}, ${s}%, ${l}%)` }
function altHsl(altFt: number) {
  if (altFt <= 0) return '#94a3b8'
  const t = Math.min(1, altFt / 45000)
  // cyan -> violet -> rose
  const h = 200 - 180 * t
  return hsl(h, 75, 55)
}
function areaHsl(t: number) {
  // small (crowded) = rose, large (isolated) = emerald
  const h = 0 + 140 * Math.max(0, Math.min(1, t))
  return hsl(h, 75, 55)
}

function haversineNM(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 3440.065
  const RAD = Math.PI / 180
  const dLat = (bLat - aLat) * RAD
  const dLng = (bLng - aLng) * RAD
  const la1 = aLat * RAD, la2 = bLat * RAD
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

function polygonAreaKm2(pts: Array<[number, number]>, lat0: number) {
  // pts in [lng, lat] degrees, equirectangular about lat0
  const kmPerDegLat = 111.32
  const kmPerDegLng = 111.32 * Math.cos(lat0 * Math.PI / 180)
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    s += (x1 * kmPerDegLng) * (y2 * kmPerDegLat) - (x2 * kmPerDegLng) * (y1 * kmPerDegLat)
  }
  return Math.abs(s) / 2
}

export default function VoronoiTerritory({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState<number>(50)
  const [includeGround, setIncludeGround] = useState<boolean>(false)
  const [fillOpacity, setFillOpacity] = useState<number>(0.18)
  const [showEdges, setShowEdges] = useState<boolean>(true)
  const [colorMode, setColorMode] = useState<'rainbow' | 'altitude' | 'area'>('rainbow')
  const [tab, setTab] = useState<'isolated' | 'crowded' | 'neighbors'>('isolated')
  const [tick, setTick] = useState(0)
  const boundsRef = useRef<[number, number, number, number]>([-180, -85, 180, 85])

  // refresh on map move
  useEffect(() => {
    if (!map) return
    const cb = () => {
      try {
        const b = map.getBounds()
        boundsRef.current = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
        setTick(t => t + 1)
      } catch {}
    }
    cb()
    map.on('moveend', cb)
    return () => { try { map.off('moveend', cb) } catch {} }
  }, [map])

  const filtered = useMemo(() => {
    const minAlt = minFL * 100
    return flights.filter(f => {
      if (!includeGround && f.ground) return false
      if (!f.ground && f.altitudeFt < minAlt) return false
      return Number.isFinite(f.lat) && Number.isFinite(f.lng)
    })
  }, [flights, minFL, includeGround])

  const cells = useMemo(() => {
    const [w, s, e, n] = boundsRef.current
    if (filtered.length < 2) return [] as Array<{
      f: VtFlight; ring: Array<[number, number]>; areaKm2: number; idx: number
    }>
    // clip points to slightly inflated bounds to keep cells bounded
    const pad = 5
    const W = w - pad, S = Math.max(-89, s - pad), E = e + pad, N = Math.min(89, n + pad)
    const pts = filtered.map(f => [f.lng, f.lat] as [number, number])
    let del: Delaunay<[number, number]>
    try { del = Delaunay.from(pts) } catch { return [] }
    const vor = del.voronoi([W, S, E, N])
    const lat0 = filtered.reduce((a, f) => a + f.lat, 0) / filtered.length
    const out: Array<{ f: VtFlight; ring: Array<[number, number]>; areaKm2: number; idx: number }> = []
    for (let i = 0; i < filtered.length; i++) {
      const poly = vor.cellPolygon(i)
      if (!poly) continue
      const ring = poly.map(p => [p[0], p[1]] as [number, number])
      const a = polygonAreaKm2(ring, lat0)
      out.push({ f: filtered[i], ring, areaKm2: a, idx: i })
    }
    return out
  }, [filtered, tick])

  const enriched = useMemo(() => {
    if (cells.length < 2) return cells.map(c => ({ ...c, nearestNM: 0, nearestIcao: '' }))
    return cells.map(c => {
      let best = Infinity, bestIcao = ''
      for (const other of cells) {
        if (other.f.icao === c.f.icao) continue
        const d = haversineNM(c.f.lat, c.f.lng, other.f.lat, other.f.lng)
        if (d < best) { best = d; bestIcao = other.f.callsign || other.f.icao }
      }
      return { ...c, nearestNM: best, nearestIcao: bestIcao }
    })
  }, [cells])

  const stats = useMemo(() => {
    if (!enriched.length) return { n: 0, mean: 0, med: 0, total: 0, maxNN: 0 }
    const areas = enriched.map(c => c.areaKm2).sort((a, b) => a - b)
    const total = areas.reduce((a, b) => a + b, 0)
    const med = areas[Math.floor(areas.length / 2)]
    const maxNN = Math.max(...enriched.map(c => c.nearestNM))
    return { n: enriched.length, mean: total / enriched.length, med, total, maxNN }
  }, [enriched])

  const maxArea = useMemo(() => Math.max(1, ...enriched.map(c => c.areaKm2)), [enriched])

  // install / update map layers
  useEffect(() => {
    if (!map) return
    const m = map
    const apply = () => {
      try {
        const fc = {
          type: 'FeatureCollection' as const,
          features: enriched.map(c => {
            const t = Math.min(1, c.areaKm2 / maxArea)
            let color: string
            if (colorMode === 'altitude') color = altHsl(c.f.altitudeFt)
            else if (colorMode === 'area') color = areaHsl(t)
            else color = hsl((c.idx * 47) % 360, 75, 55)
            return {
              type: 'Feature' as const,
              properties: { color, icao: c.f.icao },
              geometry: { type: 'Polygon' as const, coordinates: [c.ring] },
            }
          }),
        }
        const ptsFc = {
          type: 'FeatureCollection' as const,
          features: enriched.map(c => ({
            type: 'Feature' as const,
            properties: { icao: c.f.icao },
            geometry: { type: 'Point' as const, coordinates: [c.f.lng, c.f.lat] },
          })),
        }
        let src = m.getSource(SRC_FILL) as any
        if (!src) {
          m.addSource(SRC_FILL, { type: 'geojson', data: fc as any })
          m.addLayer({
            id: LYR_FILL, type: 'fill', source: SRC_FILL,
            paint: { 'fill-color': ['get', 'color'], 'fill-opacity': fillOpacity },
          })
          m.addLayer({
            id: LYR_LINE, type: 'line', source: SRC_FILL,
            paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': showEdges ? 0.7 : 0 },
          })
        } else {
          src.setData(fc as any)
          if (m.getLayer(LYR_FILL)) m.setPaintProperty(LYR_FILL, 'fill-opacity', fillOpacity)
          if (m.getLayer(LYR_LINE)) m.setPaintProperty(LYR_LINE, 'line-opacity', showEdges ? 0.7 : 0)
        }
        let psrc = m.getSource(SRC_PTS) as any
        if (!psrc) {
          m.addSource(SRC_PTS, { type: 'geojson', data: ptsFc as any })
          m.addLayer({
            id: LYR_PTS, type: 'circle', source: SRC_PTS,
            paint: { 'circle-radius': 2, 'circle-color': '#ffffff', 'circle-opacity': 0.5 },
          })
        } else { psrc.setData(ptsFc as any) }
      } catch {}
    }
    if (!m.isStyleLoaded()) { m.once('styledata', apply); return }
    apply()
  }, [map, enriched, maxArea, colorMode, fillOpacity, showEdges])

  // teardown on close
  useEffect(() => {
    return () => {
      if (!map) return
      try {
        for (const id of [LYR_LINE, LYR_FILL, LYR_PTS]) if (map.getLayer(id)) map.removeLayer(id)
        for (const id of [SRC_FILL, SRC_PTS]) if (map.getSource(id)) map.removeSource(id)
      } catch {}
    }
  }, [map])

  const sorted = useMemo(() => {
    const arr = [...enriched]
    if (tab === 'isolated') arr.sort((a, b) => b.areaKm2 - a.areaKm2)
    else if (tab === 'crowded') arr.sort((a, b) => a.areaKm2 - b.areaKm2)
    else arr.sort((a, b) => b.nearestNM - a.nearestNM)
    return arr.slice(0, 80)
  }, [enriched, tab])

  const fmtKm2 = (k: number) => k >= 10000 ? `${(k / 1000).toFixed(0)}k` : k >= 1000 ? `${(k / 1000).toFixed(1)}k` : k.toFixed(0)

  return (
    <div className="absolute top-20 right-3 z-20 w-[22rem] max-h-[calc(100vh-6rem)] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl flex flex-col text-slate-100 pointer-events-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono px-1.5 py-0.5 bg-cyan-500/20 text-cyan-300 rounded">VORONOI</span>
          <span className="text-sm font-semibold">Territory</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 grid grid-cols-4 gap-1.5 text-center">
        <div><div className="text-[10px] text-slate-500">CELLS</div><div className="font-mono text-sm text-slate-100">{stats.n}</div></div>
        <div><div className="text-[10px] text-slate-500">MEDIAN</div><div className="font-mono text-sm text-cyan-300">{fmtKm2(stats.med)}</div></div>
        <div><div className="text-[10px] text-slate-500">MEAN</div><div className="font-mono text-sm text-violet-300">{fmtKm2(stats.mean)}</div></div>
        <div><div className="text-[10px] text-slate-500">MAX NN</div><div className="font-mono text-sm text-emerald-300">{stats.maxNN.toFixed(0)}nm</div></div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500 w-16">MIN FL</span>
          <input type="range" min={0} max={400} step={5} value={minFL} onChange={e => setMinFL(parseInt(e.target.value))} className="flex-1 accent-cyan-400" />
          <span className="text-[10px] font-mono text-slate-300 w-12 text-right">FL{minFL}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500 w-16">FILL</span>
          <input type="range" min={0} max={60} step={2} value={Math.round(fillOpacity * 100)} onChange={e => setFillOpacity(parseInt(e.target.value) / 100)} className="flex-1 accent-cyan-400" />
          <span className="text-[10px] font-mono text-slate-300 w-12 text-right">{Math.round(fillOpacity * 100)}%</span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button onClick={() => setIncludeGround(v => !v)} className={`text-[10px] px-2 py-1 rounded ${includeGround ? 'bg-slate-700 text-slate-100' : 'bg-slate-900 text-slate-500'}`}>GND</button>
          <button onClick={() => setShowEdges(v => !v)} className={`text-[10px] px-2 py-1 rounded ${showEdges ? 'bg-slate-700 text-slate-100' : 'bg-slate-900 text-slate-500'}`}>EDGES</button>
          <div className="flex gap-0.5 ml-auto">
            {(['rainbow', 'altitude', 'area'] as const).map(m => (
              <button key={m} onClick={() => setColorMode(m)} className={`text-[10px] px-2 py-1 rounded ${colorMode === m ? 'bg-cyan-500/30 text-cyan-200' : 'bg-slate-900 text-slate-500'}`}>{m.toUpperCase()}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 flex gap-1">
        {(['isolated', 'crowded', 'neighbors'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 text-[10px] uppercase tracking-wide px-2 py-1.5 rounded font-semibold ${tab === t ? 'bg-cyan-500/20 text-cyan-200 ring-1 ring-cyan-500/40' : 'bg-slate-900 text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1">
        {sorted.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-slate-500">No cells — need at least 2 aircraft.</div>
        ) : sorted.map((c, i) => {
          const t = Math.min(1, c.areaKm2 / maxArea)
          const color = colorMode === 'altitude' ? altHsl(c.f.altitudeFt) : colorMode === 'area' ? areaHsl(t) : hsl((c.idx * 47) % 360, 75, 55)
          return (
            <button key={c.f.icao} onClick={() => onFly(c.f.icao)} className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <div className="w-1 h-9 rounded-sm shrink-0" style={{ background: color }} />
              <div className="w-5 text-right text-[10px] font-mono text-slate-600">{i + 1}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-xs font-bold text-slate-100 truncate">{c.f.callsign || c.f.icao.toUpperCase()}</span>
                  <span className="text-[10px] text-slate-500 truncate">{c.f.type || ''}</span>
                </div>
                <div className="text-[10px] text-slate-500 truncate">{c.f.operator || '—'} · near {c.nearestIcao || '—'}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="font-mono text-xs text-slate-100">{fmtKm2(c.areaKm2)}<span className="text-[9px] text-slate-500">km²</span></div>
                <div className="font-mono text-[10px] text-slate-400">{c.nearestNM.toFixed(1)}nm · FL{Math.round(c.f.altitudeFt / 100)}</div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
