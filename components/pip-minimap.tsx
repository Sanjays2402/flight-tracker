'use client'
import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'

interface PipFlight {
  icao: string
  callsign: string
  lat: number
  lng: number
  track: number
  altitudeFt: number
  ground: boolean
  emergency?: string | boolean
}

interface Props {
  flights: PipFlight[]
  selected: PipFlight | null
  onClose: () => void
  onZoom: () => void
  radiusNm?: number
}

/* Color ramp by altitude (matches main map roughly) */
function altColor(ft: number, ground: boolean): string {
  if (ground) return '#6b7280'
  if (ft < 5000) return '#ef4444'
  if (ft < 15000) return '#f59e0b'
  if (ft < 25000) return '#eab308'
  if (ft < 35000) return '#22c55e'
  if (ft < 45000) return '#3b82f6'
  return '#a855f7'
}

const NM_PER_DEG = 60

export default function PipMinimap({ flights, selected, onClose, onZoom, radiusNm = 80 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const readyRef = useRef(false)
  const [collapsed, setCollapsed] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try {
      const raw = localStorage.getItem('ft-pip-pos')
      if (raw) return JSON.parse(raw)
    } catch {}
    return { x: 16, y: 96 }
  })
  const dragRef = useRef<{ ox: number; oy: number; sx: number; sy: number } | null>(null)
  const [zoom, setZoom] = useState<number>(7)

  // Mount map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const m = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          'pip-base': {
            type: 'raster',
            tiles: [
              'https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png',
              'https://b.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png',
              'https://c.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png',
            ],
            tileSize: 256,
            attribution: '',
          },
        },
        layers: [{ id: 'pip-base', type: 'raster', source: 'pip-base' }],
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      } as any,
      center: selected ? [selected.lng, selected.lat] : [0, 20],
      zoom,
      attributionControl: false,
      interactive: true,
      dragRotate: false,
      pitchWithRotate: false,
      touchZoomRotate: true,
    })
    mapRef.current = m
    m.on('load', () => {
      readyRef.current = true
      m.addSource('pip-traffic', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
      m.addSource('pip-sel', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
      m.addSource('pip-range', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })

      // Range ring (around selected)
      m.addLayer({
        id: 'pip-range-fill',
        type: 'fill',
        source: 'pip-range',
        paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.05 },
      })
      m.addLayer({
        id: 'pip-range-line',
        type: 'line',
        source: 'pip-range',
        paint: { 'line-color': '#38bdf8', 'line-width': 1, 'line-dasharray': [2, 3], 'line-opacity': 0.7 },
      })

      // Traffic dots (triangles via rotated rectangle approximation: use circle for non-selected)
      m.addLayer({
        id: 'pip-traffic-dots',
        type: 'circle',
        source: 'pip-traffic',
        paint: {
          'circle-radius': ['case', ['get', 'ground'], 2.5, 4],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 1,
          'circle-opacity': 0.95,
        },
      })

      // Selected plane chevron
      m.addLayer({
        id: 'pip-sel-halo',
        type: 'circle',
        source: 'pip-sel',
        paint: {
          'circle-radius': 12,
          'circle-color': 'transparent',
          'circle-stroke-color': '#f8fafc',
          'circle-stroke-width': 2,
          'circle-stroke-opacity': 0.9,
        },
      })
      m.addLayer({
        id: 'pip-sel-dot',
        type: 'circle',
        source: 'pip-sel',
        paint: {
          'circle-radius': 6,
          'circle-color': '#f8fafc',
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 1.5,
        },
      })
    })
    m.on('zoomend', () => { try { setZoom(m.getZoom()) } catch {} })
    return () => {
      try { m.remove() } catch {}
      mapRef.current = null
      readyRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Recenter on selected
  useEffect(() => {
    const m = mapRef.current
    if (!m || !readyRef.current || !selected) return
    try { m.easeTo({ center: [selected.lng, selected.lat], duration: 600 }) } catch {}
  }, [selected?.icao, selected?.lat, selected?.lng])

  // Re-fit when radius changes
  useEffect(() => {
    const m = mapRef.current
    if (!m || !readyRef.current || !selected) return
    try {
      const degLat = radiusNm / NM_PER_DEG
      const degLon = radiusNm / (NM_PER_DEG * Math.max(0.2, Math.cos((selected.lat * Math.PI) / 180)))
      m.fitBounds(
        [
          [selected.lng - degLon, selected.lat - degLat],
          [selected.lng + degLon, selected.lat + degLat],
        ],
        { padding: 14, duration: 500, maxZoom: 10 }
      )
    } catch {}
  }, [radiusNm, selected?.icao])

  // Push data updates
  useEffect(() => {
    const m = mapRef.current
    if (!m || !readyRef.current) return
    const sel = selected
    const within: PipFlight[] = []
    if (sel) {
      const degLat = radiusNm / NM_PER_DEG
      const degLon = radiusNm / (NM_PER_DEG * Math.max(0.2, Math.cos((sel.lat * Math.PI) / 180)))
      for (const f of flights) {
        if (f.icao === sel.icao) continue
        if (Math.abs(f.lat - sel.lat) > degLat) continue
        if (Math.abs(f.lng - sel.lng) > degLon) continue
        within.push(f)
      }
    }
    const trafficFC = {
      type: 'FeatureCollection',
      features: within.map(f => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [f.lng, f.lat] },
        properties: {
          color: f.emergency ? '#ef4444' : altColor(f.altitudeFt, f.ground),
          ground: !!f.ground,
        },
      })),
    } as any
    ;(m.getSource('pip-traffic') as maplibregl.GeoJSONSource | undefined)?.setData(trafficFC)

    const selFC = sel
      ? {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [sel.lng, sel.lat] },
              properties: {},
            },
          ],
        }
      : { type: 'FeatureCollection', features: [] }
    ;(m.getSource('pip-sel') as maplibregl.GeoJSONSource | undefined)?.setData(selFC as any)

    // Range ring polygon
    if (sel) {
      const pts: number[][] = []
      const steps = 64
      const degLat = radiusNm / NM_PER_DEG
      const cosL = Math.max(0.05, Math.cos((sel.lat * Math.PI) / 180))
      const degLon = radiusNm / (NM_PER_DEG * cosL)
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2
        pts.push([sel.lng + Math.cos(a) * degLon, sel.lat + Math.sin(a) * degLat])
      }
      const ringFC = {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] }, properties: {} }],
      } as any
      ;(m.getSource('pip-range') as maplibregl.GeoJSONSource | undefined)?.setData(ringFC)
    } else {
      ;(m.getSource('pip-range') as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] } as any)
    }
  }, [flights, selected, radiusNm])

  // Persist position
  useEffect(() => {
    try { localStorage.setItem('ft-pip-pos', JSON.stringify(pos)) } catch {}
  }, [pos])

  // Drag handlers
  function onHeaderMouseDown(e: React.MouseEvent) {
    dragRef.current = { ox: e.clientX, oy: e.clientY, sx: pos.x, sy: pos.y }
    const move = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.ox
      const dy = ev.clientY - dragRef.current.oy
      const nx = Math.max(8, Math.min(window.innerWidth - 100, dragRef.current.sx + dx))
      const ny = Math.max(8, Math.min(window.innerHeight - 60, dragRef.current.sy + dy))
      setPos({ x: nx, y: ny })
    }
    const up = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // Resize map after collapse toggle / position change
  useEffect(() => {
    const m = mapRef.current
    if (!m) return
    const t = setTimeout(() => { try { m.resize() } catch {} }, 50)
    return () => clearTimeout(t)
  }, [collapsed])

  const width = 280
  const height = collapsed ? 36 : 220

  return (
    <div
      className="fixed z-30 select-none"
      style={{ left: pos.x, bottom: pos.y, width, height }}
    >
      <div className="bg-slate-950/95 backdrop-blur-xl border border-slate-700 rounded-xl overflow-hidden shadow-2xl flex flex-col h-full">
        <div
          onMouseDown={onHeaderMouseDown}
          className="cursor-move flex items-center justify-between px-2.5 py-1.5 bg-slate-900/90 border-b border-slate-800"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] uppercase tracking-widest text-sky-400 font-semibold">PiP</span>
            <span className="text-[11px] text-slate-300 truncate font-mono">
              {selected ? (selected.callsign || selected.icao.toUpperCase()) : 'no selection'}
            </span>
            {selected && (
              <span className="text-[10px] text-slate-500 font-mono">{radiusNm}nm</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onZoom}
              title="Jump main map to selected"
              className="text-[10px] text-slate-400 hover:text-sky-300 px-1.5 py-0.5 rounded border border-slate-700 hover:border-sky-700 transition"
            >GO</button>
            <button
              onClick={() => setCollapsed(c => !c)}
              title={collapsed ? 'Expand' : 'Collapse'}
              className="text-slate-400 hover:text-slate-100 w-5 h-5 flex items-center justify-center rounded hover:bg-slate-800 transition"
            >{collapsed ? '▢' : '–'}</button>
            <button
              onClick={onClose}
              title="Close mini-map"
              className="text-slate-400 hover:text-rose-400 w-5 h-5 flex items-center justify-center rounded hover:bg-slate-800 transition"
            >×</button>
          </div>
        </div>
        <div
          ref={containerRef}
          className={collapsed ? 'hidden' : 'flex-1 relative'}
          style={{ minHeight: 0 }}
        />
        {!collapsed && !selected && (
          <div className="absolute inset-x-0 bottom-6 text-center text-[10px] text-slate-500 pointer-events-none">
            select an aircraft to track
          </div>
        )}
      </div>
    </div>
  )
}
