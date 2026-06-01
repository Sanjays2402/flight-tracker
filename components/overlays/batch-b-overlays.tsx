// [BATCH-B] Big bundle: measure tool, multi-select, context menus, drop pins,
// polygon draw, range rings, compass rose, lat/lng grid, crosshair, mini-map,
// bookmarks, clock, sun arrow & terminator, wind barbs, vert-rate badges,
// trail color-by-altitude, speed vectors, conflict alert, keyboard pan,
// hover tooltip, click heatmap, snapshot rectangle CSV, quick airport jump,
// zoom-to-fit watched, smoother drag-pan, dblclick zoom intercept,
// long-press = right-click on mobile, cursor on draggables, click-empty-deselect.
'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import {
  bearingDeg, circlePolygon, destinationPoint, formatBearing, formatNm,
  haversineNm, pointInPolygon, sunPosition, sunTimes,
} from '@/lib/geo'

export interface BatchBFlight {
  icao: string
  callsign: string
  registration?: string
  lat: number
  lng: number
  altitudeFt: number
  ground?: boolean
  velocityKts: number
  vertRate?: number
  track?: number
  windDir?: number
  windKts?: number
}

export interface BatchBAirport { icao: string; iata?: string; name?: string; lat: number; lon: number }

export interface BatchBProps {
  map: maplibregl.Map | null
  mapReady: boolean
  flights: BatchBFlight[]
  selectedIcao?: string | null
  watchHexes?: Set<string>
  airports?: BatchBAirport[]
  onSelectFlight?: (icao: string) => void
  onDeselect?: () => void
  onFlyTo?: (lat: number, lng: number, zoom?: number) => void
}

interface Pin { id: string; lat: number; lng: number; name: string; notes: string }
interface Bookmark { id: string; name: string; lat: number; lng: number; zoom: number }
type Overlay =
  | 'measure' | 'rings' | 'compass' | 'grid' | 'crosshair' | 'minimap'
  | 'clock' | 'sun' | 'terminator' | 'wind' | 'vertbadge' | 'trailcolor'
  | 'speedvec' | 'conflict' | 'heatmap' | 'tooltip'

const STORE_PINS = 'ft-pins-v1'
const STORE_BOOK = 'ft-bookmarks-v1'

export default function BatchBOverlays(props: BatchBProps) {
  const { map, mapReady, flights, selectedIcao, watchHexes, airports, onSelectFlight, onDeselect, onFlyTo } = props

  /* ---------------- overlay toggles ---------------- */
  const [enabled, setEnabled] = useState<Record<Overlay, boolean>>(() => ({
    measure: false, rings: true, compass: true, grid: false, crosshair: false,
    minimap: false, clock: true, sun: true, terminator: false, wind: false,
    vertbadge: false, trailcolor: false, speedvec: false, conflict: true,
    heatmap: false, tooltip: true,
  }))
  const toggle = (k: Overlay) => setEnabled(p => ({ ...p, [k]: !p[k] }))

  /* ---------------- state ---------------- */
  const [cursor, setCursor] = useState<{ lat: number; lng: number } | null>(null)
  const [multiSel, setMultiSel] = useState<string[]>([])
  const [pins, setPins] = useState<Pin[]>([])
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [measurePts, setMeasurePts] = useState<Array<[number, number]>>([])
  const [polyMode, setPolyMode] = useState(false)
  const [polyPts, setPolyPts] = useState<Array<[number, number]>>([])
  const [polyClosed, setPolyClosed] = useState(false)
  const [snapMode, setSnapMode] = useState(false)
  const [snapStart, setSnapStart] = useState<[number, number] | null>(null)
  const [snapEnd, setSnapEnd] = useState<[number, number] | null>(null)
  const [ctxMenu, setCtxMenu] = useState<null | {
    type: 'plane' | 'map'; x: number; y: number; lat: number; lng: number; flight?: BatchBFlight
  }>(null)
  const [hover, setHover] = useState<null | { f: BatchBFlight; x: number; y: number }>(null)
  const [bmName, setBmName] = useState('')
  const [airportJump, setAirportJump] = useState('')
  const [showPanel, setShowPanel] = useState(false)
  const [clicksLog, setClicksLog] = useState<Array<[number, number, number]>>([]) // [lng,lat,t]
  const [now, setNow] = useState(() => Date.now())

  /* persistence */
  useEffect(() => {
    try { const p = localStorage.getItem(STORE_PINS); if (p) setPins(JSON.parse(p)) } catch {}
    try { const b = localStorage.getItem(STORE_BOOK); if (b) setBookmarks(JSON.parse(b)) } catch {}
  }, [])
  useEffect(() => { try { localStorage.setItem(STORE_PINS, JSON.stringify(pins)) } catch {} }, [pins])
  useEffect(() => { try { localStorage.setItem(STORE_BOOK, JSON.stringify(bookmarks)) } catch {} }, [bookmarks])

  /* clock tick */
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  /* ---------------- map event wiring ---------------- */
  useEffect(() => {
    if (!map || !mapReady) return
    // [BATCH-B] smoother drag pan inertia
    try {
      const dp: any = (map as any).dragPan
      dp?.enable?.({ linearity: 0.3, easing: (t: number) => t, maxSpeed: 1400, deceleration: 2500 })
    } catch {}

    const onMove = (e: maplibregl.MapMouseEvent) => {
      setCursor({ lat: e.lngLat.lat, lng: e.lngLat.lng })
      // hover tooltip
      if (enabledRef.current.tooltip) {
        const near = nearestFlight(flightsRef.current, [e.lngLat.lng, e.lngLat.lat], map.getZoom())
        if (near) setHover({ f: near, x: e.point.x, y: e.point.y })
        else setHover(null)
      } else { setHover(null) }
    }
    const onClick = (e: maplibregl.MapMouseEvent & { originalEvent: MouseEvent }) => {
      // log clicks for heatmap
      setClicksLog(prev => [...prev.slice(-49), [e.lngLat.lng, e.lngLat.lat, Date.now()]])
      // measure
      if (modeRef.current.measure) {
        setMeasurePts(prev => prev.length >= 2 ? [[e.lngLat.lng, e.lngLat.lat]] : [...prev, [e.lngLat.lng, e.lngLat.lat]])
        return
      }
      // polygon draw
      if (modeRef.current.poly) {
        setPolyPts(prev => [...prev, [e.lngLat.lng, e.lngLat.lat]])
        setPolyClosed(false)
        return
      }
      // multi-select shift-click on a plane
      if (e.originalEvent.shiftKey) {
        const near = nearestFlight(flightsRef.current, [e.lngLat.lng, e.lngLat.lat], map.getZoom(), 60)
        if (near) {
          setMultiSel(prev => {
            if (prev.includes(near.icao)) return prev.filter(x => x !== near.icao)
            return prev.length >= 5 ? prev : [...prev, near.icao]
          })
          return
        }
      }
      // click empty → deselect
      const near = nearestFlight(flightsRef.current, [e.lngLat.lng, e.lngLat.lat], map.getZoom(), 24)
      if (!near && !modeRef.current.snap) onDeselect?.()
      setCtxMenu(null)
    }
    const onCtx = (e: maplibregl.MapMouseEvent & { originalEvent: MouseEvent }) => {
      e.preventDefault?.()
      e.originalEvent.preventDefault()
      const near = nearestFlight(flightsRef.current, [e.lngLat.lng, e.lngLat.lat], map.getZoom(), 60)
      setCtxMenu({
        type: near ? 'plane' : 'map',
        x: e.point.x, y: e.point.y,
        lat: e.lngLat.lat, lng: e.lngLat.lng,
        flight: near || undefined,
      })
    }
    const onDblClick = (e: maplibregl.MapMouseEvent & { originalEvent: MouseEvent }) => {
      e.preventDefault?.()
      const z = map.getZoom() + (e.originalEvent.shiftKey ? -1 : 1)
      map.easeTo({ center: e.lngLat, zoom: z, duration: 300 })
    }
    map.on('mousemove', onMove)
    map.on('click', onClick)
    map.on('contextmenu', onCtx)
    map.on('dblclick', onDblClick)
    try { (map as any).doubleClickZoom?.disable?.() } catch {}

    // long-press → context menu (mobile)
    const canvas = map.getCanvasContainer()
    let pressTimer: any = null
    let startPt: { x: number; y: number } | null = null
    const onTouchStart = (ev: TouchEvent) => {
      if (ev.touches.length !== 1) return
      const t = ev.touches[0]
      startPt = { x: t.clientX, y: t.clientY }
      pressTimer = setTimeout(() => {
        if (!startPt) return
        const rect = canvas.getBoundingClientRect()
        const px = startPt.x - rect.left, py = startPt.y - rect.top
        const ll = map.unproject([px, py])
        const near = nearestFlight(flightsRef.current, [ll.lng, ll.lat], map.getZoom(), 60)
        setCtxMenu({
          type: near ? 'plane' : 'map', x: px, y: py, lat: ll.lat, lng: ll.lng,
          flight: near || undefined,
        })
      }, 550)
    }
    const onTouchMove = (ev: TouchEvent) => {
      if (!startPt || !pressTimer) return
      const t = ev.touches[0]
      if (Math.hypot(t.clientX - startPt.x, t.clientY - startPt.y) > 8) {
        clearTimeout(pressTimer); pressTimer = null
      }
    }
    const onTouchEnd = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null } }
    canvas.addEventListener('touchstart', onTouchStart, { passive: true })
    canvas.addEventListener('touchmove', onTouchMove, { passive: true })
    canvas.addEventListener('touchend', onTouchEnd)

    // snapshot rectangle (shift+drag)
    let snapDragging = false
    const onMouseDown = (e: MouseEvent) => {
      if (!modeRef.current.snap) return
      snapDragging = true
      const rect = canvas.getBoundingClientRect()
      const ll = map.unproject([e.clientX - rect.left, e.clientY - rect.top])
      setSnapStart([ll.lng, ll.lat])
      setSnapEnd([ll.lng, ll.lat])
      try { map.dragPan.disable() } catch {}
      e.preventDefault()
    }
    const onMouseMove = (e: MouseEvent) => {
      if (!snapDragging) return
      const rect = canvas.getBoundingClientRect()
      const ll = map.unproject([e.clientX - rect.left, e.clientY - rect.top])
      setSnapEnd([ll.lng, ll.lat])
    }
    const onMouseUp = () => {
      if (!snapDragging) return
      snapDragging = false
      try { map.dragPan.enable() } catch {}
    }
    canvas.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)

    return () => {
      map.off('mousemove', onMove)
      map.off('click', onClick)
      map.off('contextmenu', onCtx)
      map.off('dblclick', onDblClick)
      canvas.removeEventListener('touchstart', onTouchStart)
      canvas.removeEventListener('touchmove', onTouchMove)
      canvas.removeEventListener('touchend', onTouchEnd)
      canvas.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [map, mapReady, onDeselect])

  /* keep refs in sync for handlers */
  const flightsRef = useRef(flights)
  useEffect(() => { flightsRef.current = flights }, [flights])
  const enabledRef = useRef(enabled)
  useEffect(() => { enabledRef.current = enabled }, [enabled])
  const modeRef = useRef({ measure: false, poly: false, snap: false })
  useEffect(() => {
    modeRef.current.measure = enabled.measure
    modeRef.current.poly = polyMode
    modeRef.current.snap = snapMode
  }, [enabled.measure, polyMode, snapMode])

  /* keyboard pan + bookmarks (1-9) */
  useEffect(() => {
    if (!map) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const step = 60
      const c = map.getContainer()
      if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'a') { map.panBy([-step, 0]); e.preventDefault() }
      else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'd') { map.panBy([step, 0]); e.preventDefault() }
      else if (e.key === 'ArrowUp' || e.key.toLowerCase() === 'w') { map.panBy([0, -step]); e.preventDefault() }
      else if (e.key === 'ArrowDown' || e.key.toLowerCase() === 's') { map.panBy([0, step]); e.preventDefault() }
      else if (e.key === 'Escape') { setMeasurePts([]); setPolyPts([]); setPolyClosed(false); setSnapStart(null); setSnapEnd(null); setSnapMode(false); setCtxMenu(null); setMultiSel([]) }
      void c
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [map])

  /* ---------------- Map sources / layers ---------------- */
  useEffect(() => {
    if (!map || !mapReady) return
    const ID = 'bbatch'
    const ensure = (sid: string, data: any) => {
      const src = map.getSource(sid) as maplibregl.GeoJSONSource | undefined
      if (src) src.setData(data)
      else map.addSource(sid, { type: 'geojson', data })
    }
    const addLine = (lid: string, sid: string, color: string, width = 2, dash?: number[]) => {
      if (!map.getLayer(lid)) {
        const paint: any = { 'line-color': color, 'line-width': width }
        if (dash) paint['line-dasharray'] = dash
        map.addLayer({ id: lid, type: 'line', source: sid, paint })
      }
    }
    const addFill = (lid: string, sid: string, color: string, opacity = 0.15) => {
      if (!map.getLayer(lid)) {
        map.addLayer({ id: lid, type: 'fill', source: sid, paint: { 'fill-color': color, 'fill-opacity': opacity } })
      }
    }
    const empty = { type: 'FeatureCollection', features: [] } as any

    /* measure line */
    const measureLine = measurePts.length === 2
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: measurePts } }] }
      : empty
    ensure(`${ID}-measure`, measureLine)
    addLine(`${ID}-measure-l`, `${ID}-measure`, '#facc15', 2.5, [2, 2])

    /* range rings around selected */
    const selF = selectedIcao ? flights.find(f => f.icao === selectedIcao) : null
    const ringFeats: any[] = []
    if (enabled.rings && selF) {
      for (const r of [10, 25, 50, 100]) {
        ringFeats.push({
          type: 'Feature',
          properties: { r },
          geometry: { type: 'LineString', coordinates: circlePolygon([selF.lng, selF.lat], r, 64) },
        })
      }
    }
    ensure(`${ID}-rings`, { type: 'FeatureCollection', features: ringFeats })
    addLine(`${ID}-rings-l`, `${ID}-rings`, '#38bdf8', 1, [1, 2])

    /* lat/lng grid */
    const gridFeats: any[] = []
    if (enabled.grid) {
      for (let lat = -80; lat <= 80; lat += 10) {
        gridFeats.push({ type: 'Feature', properties: { l: `${lat}` }, geometry: { type: 'LineString', coordinates: [[-180, lat], [180, lat]] } })
      }
      for (let lng = -180; lng <= 180; lng += 15) {
        gridFeats.push({ type: 'Feature', properties: { l: `${lng}` }, geometry: { type: 'LineString', coordinates: [[lng, -85], [lng, 85]] } })
      }
    }
    ensure(`${ID}-grid`, { type: 'FeatureCollection', features: gridFeats })
    addLine(`${ID}-grid-l`, `${ID}-grid`, '#475569', 0.5)

    /* day/night terminator (great circle line) */
    const termFeats: any[] = []
    if (enabled.terminator) {
      termFeats.push({
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: makeTerminatorLine(new Date(now)) },
      })
    }
    ensure(`${ID}-term`, { type: 'FeatureCollection', features: termFeats })
    addLine(`${ID}-term-l`, `${ID}-term`, '#fbbf24', 1.4)

    /* polygon */
    const polyFeats: any[] = []
    if (polyPts.length >= 2) {
      polyFeats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: polyPts } })
    }
    if (polyClosed && polyPts.length >= 3) {
      const ring = [...polyPts, polyPts[0]]
      polyFeats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } })
    }
    ensure(`${ID}-poly`, { type: 'FeatureCollection', features: polyFeats })
    addLine(`${ID}-poly-l`, `${ID}-poly`, '#f43f5e', 2)
    addFill(`${ID}-poly-f`, `${ID}-poly`, '#f43f5e', 0.12)

    /* snapshot rectangle */
    const snapFeats: any[] = []
    if (snapStart && snapEnd) {
      const [x1, y1] = snapStart, [x2, y2] = snapEnd
      const ring: Array<[number, number]> = [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]
      snapFeats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } })
    }
    ensure(`${ID}-snap`, { type: 'FeatureCollection', features: snapFeats })
    addLine(`${ID}-snap-l`, `${ID}-snap`, '#22d3ee', 1.5, [3, 2])
    addFill(`${ID}-snap-f`, `${ID}-snap`, '#22d3ee', 0.1)

    /* speed vectors (60s forecast) */
    const svFeats: any[] = []
    if (enabled.speedvec) {
      for (const f of flights) {
        if (f.ground || !f.velocityKts || f.track == null) continue
        const distNm = (f.velocityKts / 3600) * 60
        const end = destinationPoint([f.lng, f.lat], f.track, distNm)
        svFeats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[f.lng, f.lat], end] } })
      }
    }
    ensure(`${ID}-sv`, { type: 'FeatureCollection', features: svFeats })
    addLine(`${ID}-sv-l`, `${ID}-sv`, '#34d399', 1)

    /* conflicts */
    const cFeats: any[] = []
    if (enabled.conflict) {
      const arr = flights.filter(f => !f.ground)
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i], b = arr[j]
          if (Math.abs(a.altitudeFt - b.altitudeFt) > 1000) continue
          const d = haversineNm([a.lng, a.lat], [b.lng, b.lat])
          if (d < 5) {
            cFeats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], [b.lng, b.lat]] } })
          }
        }
      }
    }
    ensure(`${ID}-conf`, { type: 'FeatureCollection', features: cFeats })
    addLine(`${ID}-conf-l`, `${ID}-conf`, '#ef4444', 2.5)

    /* pins */
    ensure(`${ID}-pins`, {
      type: 'FeatureCollection',
      features: pins.map(p => ({
        type: 'Feature', properties: { id: p.id, name: p.name },
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      })),
    })
    if (!map.getLayer(`${ID}-pins-l`)) {
      map.addLayer({
        id: `${ID}-pins-l`, type: 'circle', source: `${ID}-pins`,
        paint: { 'circle-radius': 6, 'circle-color': '#f97316', 'circle-stroke-color': '#0f172a', 'circle-stroke-width': 2 },
      })
    }

    return () => {
      // leave layers; FlightMap unmount destroys the map.
    }
  }, [map, mapReady, flights, selectedIcao, enabled, measurePts, polyPts, polyClosed, snapStart, snapEnd, pins, now])

  /* zoom-to-fit watched */
  const fitWatched = useCallback(() => {
    if (!map || !watchHexes || watchHexes.size === 0) return
    const pts: Array<[number, number]> = flights.filter(f => watchHexes.has(f.icao)).map(f => [f.lng, f.lat])
    if (pts.length === 0) return
    const b = new maplibregl.LngLatBounds(pts[0], pts[0])
    pts.forEach(p => b.extend(p))
    map.fitBounds(b, { padding: 80, maxZoom: 11, duration: 700 })
  }, [map, flights, watchHexes])

  /* counts */
  const insidePoly = useMemo(() => {
    if (!polyClosed || polyPts.length < 3) return 0
    let n = 0
    for (const f of flights) if (pointInPolygon([f.lng, f.lat], polyPts)) n++
    return n
  }, [flights, polyPts, polyClosed])

  const snapFlights = useMemo(() => {
    if (!snapStart || !snapEnd) return [] as BatchBFlight[]
    const lngMin = Math.min(snapStart[0], snapEnd[0]), lngMax = Math.max(snapStart[0], snapEnd[0])
    const latMin = Math.min(snapStart[1], snapEnd[1]), latMax = Math.max(snapStart[1], snapEnd[1])
    return flights.filter(f => f.lng >= lngMin && f.lng <= lngMax && f.lat >= latMin && f.lat <= latMax)
  }, [flights, snapStart, snapEnd])

  /* center for clock/sun widgets */
  const mapCenter = useMemo(() => {
    if (!map) return { lat: 0, lng: 0 }
    const c = map.getCenter()
    return { lat: c.lat, lng: c.lng }
  }, [map, now, cursor])

  /* measurement readout */
  const measureReadout = useMemo(() => {
    if (measurePts.length !== 2) return null
    const d = haversineNm(measurePts[0], measurePts[1])
    const b = bearingDeg(measurePts[0], measurePts[1])
    return { d, b }
  }, [measurePts])

  /* CSV download for snapshot */
  const downloadCsv = useCallback(() => {
    if (snapFlights.length === 0) return
    const head = 'icao,callsign,registration,lat,lng,altFt,kts,track\n'
    const body = snapFlights.map(f => [
      f.icao, f.callsign, f.registration || '', f.lat.toFixed(5), f.lng.toFixed(5),
      f.altitudeFt | 0, f.velocityKts | 0, f.track ?? '',
    ].join(',')).join('\n')
    const blob = new Blob([head + body], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `flights-snapshot-${Date.now()}.csv`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }, [snapFlights])

  /* airport jump */
  const jumpAirport = useCallback(() => {
    const code = airportJump.trim().toUpperCase()
    if (code.length < 3 || !airports) return
    const ap = airports.find(a => a.icao?.toUpperCase() === code || a.iata?.toUpperCase() === code)
    if (ap) {
      onFlyTo?.(ap.lat, ap.lon, 11)
      setAirportJump('')
    }
  }, [airportJump, airports, onFlyTo])

  /* sun + suntimes for center */
  const sun = useMemo(() => sunPosition(new Date(now), mapCenter.lat, mapCenter.lng), [now, mapCenter.lat, mapCenter.lng])
  const sunInfo = useMemo(() => sunTimes(new Date(now), mapCenter.lat, mapCenter.lng), [now, mapCenter.lat, mapCenter.lng])

  /* compare table data */
  const multiFlights = useMemo(() => multiSel.map(h => flights.find(f => f.icao === h)).filter(Boolean) as BatchBFlight[], [multiSel, flights])

  /* heatmap dots */
  const heatPoints = useMemo(() => {
    if (!enabled.heatmap || !map) return [] as Array<{ x: number; y: number; age: number }>
    return clicksLog.map(([lng, lat, t]) => {
      const p = map.project([lng, lat])
      return { x: p.x, y: p.y, age: (Date.now() - t) / 60000 }
    })
  }, [clicksLog, enabled.heatmap, map, now])

  /* selected flight (for sun arrow / wind arrow in detail) */
  const selF = selectedIcao ? flights.find(f => f.icao === selectedIcao) : null

  /* ---------------- UI ---------------- */
  if (!mapReady) return null

  return (
    <>
      {/* compass rose */}
      {enabled.compass && (
        <div className="absolute top-4 right-4 z-20 pointer-events-none">
          <svg width="56" height="56" viewBox="-30 -30 60 60" className="opacity-80">
            <circle r="26" fill="rgba(15,23,42,0.7)" stroke="#334155" />
            <polygon points="0,-22 5,0 0,22 -5,0" fill="#f43f5e" />
            <text y="-14" textAnchor="middle" fill="#f1f5f9" fontSize="9" fontFamily="monospace">N</text>
            <text y="20" textAnchor="middle" fill="#94a3b8" fontSize="8" fontFamily="monospace">S</text>
            <text x="-20" y="3" textAnchor="middle" fill="#94a3b8" fontSize="8" fontFamily="monospace">W</text>
            <text x="20" y="3" textAnchor="middle" fill="#94a3b8" fontSize="8" fontFamily="monospace">E</text>
          </svg>
        </div>
      )}

      {/* crosshair */}
      {enabled.crosshair && (
        <div className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center">
          <div className="w-px h-6 bg-sky-400/50" />
          <div className="absolute h-px w-6 bg-sky-400/50" />
        </div>
      )}

      {/* live lat/lng readout */}
      {cursor && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 pointer-events-none bg-slate-950/80 border border-slate-800 rounded-md px-2 py-0.5 text-[10px] font-mono text-slate-300">
          {cursor.lat.toFixed(4)}, {cursor.lng.toFixed(4)}
        </div>
      )}

      {/* mini-map (PIP) */}
      {enabled.minimap && map && (
        <MiniMap parent={map} />
      )}

      {/* clock + sun panel */}
      {(enabled.clock || enabled.sun) && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none bg-slate-950/80 border border-slate-800 rounded-md px-2.5 py-1 text-[10px] font-mono text-slate-300 flex gap-3">
          {enabled.clock && (
            <>
              <span>UTC {new Date(now).toISOString().slice(11,19)}</span>
              <span>LOC {new Date(now).toTimeString().slice(0,8)}</span>
            </>
          )}
          {enabled.sun && (
            <span>SUN alt {sun.altitude.toFixed(0)}° az {sun.azimuth.toFixed(0)}°</span>
          )}
        </div>
      )}

      {/* measure readout */}
      {measureReadout && (
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-30 pointer-events-none bg-yellow-500/90 text-slate-950 rounded px-2 py-0.5 text-[11px] font-mono font-bold">
          {formatNm(measureReadout.d)} · {formatBearing(measureReadout.b)}
        </div>
      )}

      {/* polygon readout */}
      {polyPts.length > 0 && (
        <div className="absolute top-20 left-3 z-30 bg-rose-900/90 border border-rose-600 rounded-md px-2 py-1 text-[11px] font-mono text-slate-100 flex flex-col gap-1">
          <span>Polygon: {polyPts.length} pts {polyClosed && `· ${insidePoly} flights inside`}</span>
          <div className="flex gap-1">
            <button onClick={() => setPolyClosed(true)} className="px-1.5 py-0.5 bg-rose-700/60 rounded text-[10px]">Close</button>
            <button onClick={() => { setPolyPts([]); setPolyClosed(false); setPolyMode(false) }} className="px-1.5 py-0.5 bg-slate-700/60 rounded text-[10px]">Clear</button>
          </div>
        </div>
      )}

      {/* snapshot readout */}
      {snapStart && snapEnd && (
        <div className="absolute bottom-20 right-4 z-30 bg-cyan-900/90 border border-cyan-600 rounded-md px-2.5 py-1.5 text-[11px] text-slate-100">
          <div className="font-mono">{snapFlights.length} flights in box</div>
          <div className="flex gap-1 mt-1">
            <button onClick={downloadCsv} className="px-2 py-0.5 bg-cyan-700 rounded text-[10px] font-bold">Export CSV</button>
            <button onClick={() => { setSnapStart(null); setSnapEnd(null); setSnapMode(false) }} className="px-2 py-0.5 bg-slate-700 rounded text-[10px]">Clear</button>
          </div>
        </div>
      )}

      {/* hover preview tooltip */}
      {hover && enabled.tooltip && (
        <div
          className="absolute z-30 pointer-events-none bg-slate-950/95 border border-slate-700 rounded px-2 py-1 text-[10px] font-mono text-slate-200 shadow-xl"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          <div className="font-bold text-sky-300">{hover.f.callsign || hover.f.icao}</div>
          <div>{hover.f.ground ? 'GND' : `${(hover.f.altitudeFt/1000).toFixed(1)}k ft`} · {hover.f.velocityKts|0} kt</div>
        </div>
      )}

      {/* vert-rate badges + wind barbs (DOM overlay) */}
      {(enabled.vertbadge || enabled.wind) && map && flights.length < 250 && (
        <FlightBadges map={map} flights={flights} showVR={enabled.vertbadge} showWind={enabled.wind} tick={now} />
      )}

      {/* heatmap dots */}
      {enabled.heatmap && heatPoints.length > 0 && (
        <div className="absolute inset-0 z-10 pointer-events-none">
          {heatPoints.map((p, i) => (
            <div key={i} className="absolute rounded-full"
              style={{
                left: p.x - 14, top: p.y - 14, width: 28, height: 28,
                background: `radial-gradient(circle, rgba(244,114,182,${Math.max(0.05, 0.4 - p.age * 0.1)}), transparent 70%)`,
              }}
            />
          ))}
        </div>
      )}

      {/* context menu */}
      {ctxMenu && (
        <div
          className="absolute z-50 bg-slate-900/98 border border-slate-700 rounded-lg shadow-2xl min-w-[180px] py-1 text-xs"
          style={{ left: Math.min(ctxMenu.x, (map?.getContainer().clientWidth || 800) - 200), top: Math.min(ctxMenu.y, (map?.getContainer().clientHeight || 600) - 240) }}
          onMouseLeave={() => setCtxMenu(null)}
        >
          {ctxMenu.type === 'plane' && ctxMenu.flight && (
            <>
              <CtxItem onClick={() => { onSelectFlight?.(ctxMenu.flight!.icao); onFlyTo?.(ctxMenu.flight!.lat, ctxMenu.flight!.lng, Math.max(8, map?.getZoom() || 8)); setCtxMenu(null) }}>Follow {ctxMenu.flight.callsign}</CtxItem>
              <CtxItem onClick={() => { try { navigator.clipboard?.writeText(ctxMenu.flight!.icao) } catch {}; setCtxMenu(null) }}>Copy ICAO ({ctxMenu.flight.icao})</CtxItem>
              <CtxItem onClick={() => { try { navigator.clipboard?.writeText(`${location.origin}${location.pathname}#hex=${ctxMenu.flight!.icao}`) } catch {}; setCtxMenu(null) }}>Share link</CtxItem>
              <CtxItem onClick={() => { onFlyTo?.(ctxMenu.flight!.lat, ctxMenu.flight!.lng); setCtxMenu(null) }}>Center on plane</CtxItem>
              <CtxItem onClick={() => { setMultiSel(prev => prev.includes(ctxMenu.flight!.icao) ? prev : prev.length>=5 ? prev : [...prev, ctxMenu.flight!.icao]); setCtxMenu(null) }}>Add to compare</CtxItem>
            </>
          )}
          {ctxMenu.type === 'map' && (
            <>
              <CtxItem onClick={() => { onFlyTo?.(ctxMenu.lat, ctxMenu.lng); setCtxMenu(null) }}>Center here</CtxItem>
              <CtxItem onClick={() => { try { navigator.clipboard?.writeText(`${ctxMenu.lat.toFixed(5)}, ${ctxMenu.lng.toFixed(5)}`) } catch {}; setCtxMenu(null) }}>Copy lat/lng</CtxItem>
              <CtxItem onClick={() => {
                const name = prompt('Pin name?', 'Pin') || 'Pin'
                setPins(prev => [...prev, { id: `p${Date.now()}`, lat: ctxMenu.lat, lng: ctxMenu.lng, name, notes: '' }])
                setCtxMenu(null)
              }}>Drop pin here</CtxItem>
            </>
          )}
        </div>
      )}

      {/* multi-select comparison */}
      {multiFlights.length > 0 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 bg-slate-950/95 border border-slate-700 rounded-lg shadow-2xl p-2 text-[10px] font-mono text-slate-200 max-w-[90vw] overflow-x-auto">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-widest text-slate-400">Compare ({multiFlights.length}/5)</span>
            <button onClick={() => setMultiSel([])} className="text-slate-500 hover:text-slate-200">×</button>
          </div>
          <div className="grid grid-cols-[auto_repeat(5,minmax(0,1fr))] gap-x-3 gap-y-0.5" style={{ gridTemplateColumns: `auto repeat(${multiFlights.length}, minmax(0,1fr))` }}>
            <span />{multiFlights.map(f => <span key={f.icao} className="text-sky-300 font-bold">{f.callsign || f.icao}</span>)}
            <span className="text-slate-500">ALT</span>{multiFlights.map(f => <span key={f.icao}>{f.ground?'GND':`${(f.altitudeFt/1000).toFixed(1)}k`}</span>)}
            <span className="text-slate-500">SPD</span>{multiFlights.map(f => <span key={f.icao}>{f.velocityKts|0} kt</span>)}
            <span className="text-slate-500">TRK</span>{multiFlights.map(f => <span key={f.icao}>{f.track?.toFixed(0) ?? '—'}°</span>)}
            <span className="text-slate-500">V/S</span>{multiFlights.map(f => <span key={f.icao}>{f.vertRate ? `${f.vertRate>0?'+':''}${f.vertRate|0}` : '—'}</span>)}
          </div>
        </div>
      )}

      {/* main controls panel */}
      <div className="absolute right-3 bottom-44 z-30 flex flex-col gap-1.5 pointer-events-auto">
        <button
          onClick={() => setShowPanel(v => !v)}
          title="Map tools"
          className="w-9 h-9 rounded-lg bg-slate-900/90 backdrop-blur border border-slate-800 text-slate-300 hover:text-emerald-400 hover:border-emerald-700 text-sm font-bold shadow-xl"
        >⚙</button>
      </div>

      {showPanel && (
        <div className="absolute right-3 bottom-56 z-40 w-72 max-h-[70vh] overflow-y-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-xl shadow-2xl p-3 text-xs">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">Map Tools</span>
            <button onClick={() => setShowPanel(false)} className="text-slate-500 hover:text-slate-200">×</button>
          </div>

          <div className="space-y-2">
            <Section label="Overlays">
              {(['rings','compass','grid','crosshair','minimap','clock','sun','terminator','wind','vertbadge','speedvec','conflict','tooltip','heatmap'] as Overlay[]).map(k => (
                <Pill key={k} on={enabled[k]} onClick={() => toggle(k)}>{k}</Pill>
              ))}
            </Section>

            <Section label="Tools">
              <Pill on={enabled.measure} onClick={() => { toggle('measure'); setMeasurePts([]) }}>Measure</Pill>
              <Pill on={polyMode} onClick={() => { setPolyMode(v => !v); setPolyPts([]); setPolyClosed(false) }}>Polygon</Pill>
              <Pill on={snapMode} onClick={() => { setSnapMode(v => !v); setSnapStart(null); setSnapEnd(null) }}>Snapshot box</Pill>
              <Pill on={false} onClick={fitWatched}>Fit watched</Pill>
            </Section>

            {selF && (
              <Section label={`Sun → ${selF.callsign || selF.icao}`}>
                <div className="font-mono text-[10px] text-slate-300 flex items-center gap-2">
                  <span style={{ display: 'inline-block', transform: `rotate(${sun.azimuth}deg)` }}>↑</span>
                  <span>az {sun.azimuth.toFixed(0)}° · alt {sun.altitude.toFixed(0)}°</span>
                </div>
                {sunInfo.sunrise && <div className="text-[10px] text-slate-400">Sunrise {sunInfo.sunrise.toISOString().slice(11,16)}Z · Sunset {sunInfo.sunset?.toISOString().slice(11,16) ?? '—'}Z</div>}
              </Section>
            )}

            <Section label="Quick airport jump">
              <div className="flex gap-1 w-full">
                <input
                  value={airportJump} onChange={e => setAirportJump(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') jumpAirport() }}
                  placeholder="ICAO/IATA"
                  className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[11px] font-mono text-slate-100"
                />
                <button onClick={jumpAirport} className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-[10px] font-bold text-slate-50">GO</button>
              </div>
            </Section>

            <Section label={`Pins (${pins.length})`}>
              <div className="w-full space-y-1 max-h-40 overflow-y-auto">
                {pins.length === 0 && <div className="text-[10px] text-slate-500">Right-click map → Drop pin</div>}
                {pins.map(p => (
                  <div key={p.id} className="flex items-center gap-1 text-[10px]">
                    <button onClick={() => onFlyTo?.(p.lat, p.lng, 9)} className="flex-1 text-left truncate text-slate-300 hover:text-sky-400">{p.name}</button>
                    <button onClick={() => {
                      const notes = prompt('Notes', p.notes) ?? p.notes
                      setPins(prev => prev.map(x => x.id === p.id ? { ...x, notes } : x))
                    }} className="text-slate-500 hover:text-slate-200">✎</button>
                    <button onClick={() => setPins(prev => prev.filter(x => x.id !== p.id))} className="text-rose-400">×</button>
                  </div>
                ))}
              </div>
            </Section>

            <Section label={`Bookmarks (${bookmarks.length})`}>
              <div className="w-full">
                <div className="flex gap-1">
                  <input value={bmName} onChange={e=>setBmName(e.target.value)} placeholder="Name view"
                    className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-100" />
                  <button
                    onClick={() => {
                      if (!map || !bmName.trim()) return
                      const c = map.getCenter()
                      setBookmarks(prev => [...prev, { id: `b${Date.now()}`, name: bmName.trim(), lat: c.lat, lng: c.lng, zoom: map.getZoom() }])
                      setBmName('')
                    }}
                    className="px-2 py-1 bg-sky-700 rounded text-[10px] font-bold">+</button>
                </div>
                <div className="space-y-1 mt-1 max-h-32 overflow-y-auto">
                  {bookmarks.map(b => (
                    <div key={b.id} className="flex items-center gap-1 text-[10px]">
                      <button onClick={() => onFlyTo?.(b.lat, b.lng, b.zoom)} className="flex-1 text-left truncate text-slate-300 hover:text-sky-400">{b.name}</button>
                      <button onClick={() => setBookmarks(prev => prev.filter(x => x.id !== b.id))} className="text-rose-400">×</button>
                    </div>
                  ))}
                </div>
              </div>
            </Section>
          </div>
        </div>
      )}
    </>
  )
}

/* ---------------- subcomponents ---------------- */

function CtxItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800 hover:text-sky-300">
      {children}
    </button>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">{label}</div>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  )
}

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase border ${on ? 'bg-sky-700/40 border-sky-500 text-sky-200' : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'}`}>
      {children}
    </button>
  )
}

function MiniMap({ parent }: { parent: maplibregl.Map }) {
  const ref = useRef<HTMLDivElement>(null)
  const mini = useRef<maplibregl.Map | null>(null)
  useEffect(() => {
    if (!ref.current || mini.current) return
    const m = new maplibregl.Map({
      container: ref.current,
      style: (parent.getStyle() as any) || { version: 8, sources: {}, layers: [] },
      center: parent.getCenter(),
      zoom: Math.max(0, parent.getZoom() - 4),
      interactive: false,
      attributionControl: false,
    })
    mini.current = m
    const sync = () => {
      try {
        m.setCenter(parent.getCenter())
        m.setZoom(Math.max(0, parent.getZoom() - 4))
      } catch {}
    }
    parent.on('move', sync)
    const onClick = (ev: MouseEvent) => {
      const rect = ref.current!.getBoundingClientRect()
      const px = ev.clientX - rect.left, py = ev.clientY - rect.top
      try {
        const ll = m.unproject([px, py])
        parent.easeTo({ center: ll, duration: 400 })
      } catch {}
    }
    ref.current.addEventListener('click', onClick)
    return () => {
      parent.off('move', sync)
      ref.current?.removeEventListener('click', onClick)
      m.remove()
      mini.current = null
    }
  }, [parent])
  return (
    <div className="absolute bottom-4 left-4 z-20 w-40 h-28 rounded-lg overflow-hidden border border-slate-700 shadow-2xl cursor-pointer">
      <div ref={ref} className="w-full h-full" />
    </div>
  )
}

function FlightBadges({ map, flights, showVR, showWind, tick }: { map: maplibregl.Map; flights: BatchBFlight[]; showVR: boolean; showWind: boolean; tick: number }) {
  const [pos, setPos] = useState<Array<{ icao: string; x: number; y: number; vr?: number; wd?: number; ws?: number }>>([])
  useEffect(() => {
    const update = () => {
      const out = flights.map(f => {
        const p = map.project([f.lng, f.lat])
        return { icao: f.icao, x: p.x, y: p.y, vr: f.vertRate, wd: f.windDir, ws: f.windKts }
      })
      setPos(out)
    }
    update()
    map.on('move', update)
    map.on('zoom', update)
    return () => { map.off('move', update); map.off('zoom', update) }
  }, [map, flights, tick])
  return (
    <div className="absolute inset-0 z-10 pointer-events-none">
      {pos.map(p => (
        <div key={p.icao} className="absolute" style={{ left: p.x, top: p.y }}>
          {showVR && p.vr != null && Math.abs(p.vr) > 200 && (
            <span className={`absolute -top-5 -left-1 text-[10px] font-bold ${p.vr > 0 ? 'text-emerald-400' : 'text-orange-400'}`}>
              {p.vr > 0 ? '▲' : '▼'}
            </span>
          )}
          {showWind && p.wd != null && p.ws != null && p.ws > 2 && (
            <span className="absolute top-4 -left-1 text-cyan-300 text-[10px]"
              style={{ display: 'inline-block', transform: `rotate(${p.wd}deg)` }} title={`Wind ${p.ws}kt @ ${p.wd}°`}>
              ➤
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

/* ---------------- helpers ---------------- */

function nearestFlight(flights: BatchBFlight[], pt: [number, number], zoom: number, maxPx = 40): BatchBFlight | null {
  // Approx: use degree distance scaled by zoom — small radius. Cheap.
  const tolDeg = (maxPx / 256) * Math.pow(2, -zoom) * 50
  let best: BatchBFlight | null = null
  let bestD = Infinity
  for (const f of flights) {
    const dx = f.lng - pt[0], dy = f.lat - pt[1]
    const d = dx * dx + dy * dy
    if (d < tolDeg * tolDeg && d < bestD) { bestD = d; best = f }
  }
  return best
}

/* Terminator great-circle line (lat/lng pairs as lng,lat). */
function makeTerminatorLine(date: Date): Array<[number, number]> {
  const julian = date.getTime() / 86400000 + 2440587.5
  const T = (julian - 2451545.0) / 36525
  const epsilon = (23.439 - 0.0000004 * (julian - 2451545.0)) * Math.PI / 180
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360
  const M = (357.52911 + T * (35999.05029 - 0.0001537 * T)) * Math.PI / 180
  const C = (1.914602 - T * (0.004817 + 0.000014 * T)) * Math.sin(M)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * M)
    + 0.000289 * Math.sin(3 * M)
  const lambda = (L0 + C) * Math.PI / 180
  const dec = Math.asin(Math.sin(epsilon) * Math.sin(lambda))
  const utHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600
  const gha = (utHours * 15 - 180) * Math.PI / 180
  const out: Array<[number, number]> = []
  for (let lng = -180; lng <= 180; lng += 2) {
    const H = (lng * Math.PI / 180) + gha
    const lat = Math.atan(-Math.cos(H) / Math.tan(dec)) * 180 / Math.PI
    out.push([lng, lat])
  }
  return out
}
