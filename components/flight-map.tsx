'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { AIRPORTS, AirportPin } from './airports'

/* ============================================================
   Flight Tracker — MapLibre GL v5 edition (3D-capable).
   Data: adsb.lol (positions, routes, airports), planespotters.net (photos),
         RainViewer (weather radar), built-in day/night terminator.
   ============================================================ */

interface AcRaw {
  hex: string
  type?: string
  flight?: string
  r?: string
  t?: string
  desc?: string
  ownOp?: string
  alt_baro?: number | 'ground'
  alt_geom?: number
  gs?: number
  ias?: number
  tas?: number
  mach?: number
  track?: number
  baro_rate?: number
  geom_rate?: number
  nav_altitude_mcp?: number
  wd?: number
  ws?: number
  oat?: number
  squawk?: string
  category?: string
  lat: number
  lon: number
  emergency?: string
  dbFlags?: number
}
interface Flight {
  icao: string
  callsign: string
  registration: string
  type: string
  operator: string
  lng: number
  lat: number
  altitudeFt: number
  ground: boolean
  velocityKts: number
  ias: number
  mach: number
  vertRate: number
  navAlt: number
  windDir: number
  windKts: number
  oat: number
  track: number
  squawk: string
  category: string
  emergency: boolean
  dataSource: string
  military: boolean
}
interface Airport {
  icao: string; iata: string; name: string; location: string; lat: number; lon: number; countryiso2: string
}
interface Route {
  airports?: Airport[]
  airline?: string
}

const REFRESH_MS = 8_000
const TRAIL_MAX = 60

/* category codes from ADS-B */
const CAT_LABEL: Record<string, string> = {
  A1: 'Light', A2: 'Small', A3: 'Large', A4: 'High-vortex', A5: 'Heavy',
  A6: 'High-perf', A7: 'Rotorcraft', B1: 'Glider', B2: 'Balloon', B4: 'UAV',
  B6: 'UAV', B7: 'Spacecraft',
}

/* ---------- Plane icon palette (drawn into canvas, addImage'd) ---------- */
const ICON_COLORS = ['#64748b','#f43f5e','#f97316','#facc15','#22d3ee','#38bdf8','#a78bfa','#fbbf24']
const PLANE_PATH = 'M21 16v-2l-8-5V3.5a1.5 1.5 0 1 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z'
function iconKey(color: string, heli: boolean, selected: boolean) {
  return `pl-${heli ? 'h' : 'p'}-${selected ? 's' : 'n'}-${color.replace('#', '')}`
}
function drawIcon(color: string, heli: boolean, selected: boolean): ImageData {
  const pixelRatio = 2
  const sizeCss = selected ? 32 : 26
  const size = sizeCss * pixelRatio
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, size, size)
  if (heli) {
    ctx.translate(size / 2, size / 2)
    ctx.fillStyle = color
    ctx.strokeStyle = '#0f172a'
    ctx.lineWidth = 1.4 * pixelRatio
    ctx.beginPath(); ctx.arc(0, 0, size * 0.16, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    ctx.strokeStyle = color
    ctx.lineWidth = 1.8 * pixelRatio
    ctx.beginPath(); ctx.moveTo(-size * 0.42, 0); ctx.lineTo(size * 0.42, 0); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, -size * 0.42); ctx.lineTo(0, size * 0.42); ctx.stroke()
  } else {
    const k = size / 24
    ctx.translate(size / 2, size / 2)
    ctx.scale(k, k)
    ctx.translate(-12, -12)
    const p = new Path2D(PLANE_PATH)
    ctx.fillStyle = color
    ctx.strokeStyle = '#0f172a'
    ctx.lineWidth = 0.8
    ctx.lineJoin = 'round'
    ctx.fill(p); ctx.stroke(p)
  }
  return ctx.getImageData(0, 0, size, size)
}

export default function FlightMap() {
  const mapEl = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const mapReadyRef = useRef(false)
  const [mapReady, setMapReady] = useState(false)

  const trailsRef = useRef<Map<string, Array<[number, number, number]>>>(new Map())
  const routeCacheRef = useRef<Map<string, Route | null>>(new Map())
  const photoCacheRef = useRef<Map<string, string | null>>(new Map())

  const [flights, setFlights] = useState<Flight[]>([])
  const [selected, setSelected] = useState<Flight | null>(null)
  const [selectedAirport, setSelectedAirport] = useState<AirportPin | null>(null)
  const [airportMetar, setAirportMetar] = useState<{rawOb:string; temp:number; dewp:number; wdir:number; wspd:number; visib:string; altim:number; fltCat:string; clouds?:{cover:string;base:number}[]} | null>(null)
  const [mapZoom, setMapZoom] = useState(4)
  const [mapBounds, setMapBounds] = useState<{n:number,s:number,e:number,w:number} | null>(null)
  const [toasts, setToasts] = useState<{id:string; icao:string; cs:string; sq:string; lat:number; lng:number; t:number}[]>([])
  const knownEmergRef = useRef<Set<string>>(new Set())
  const [route, setRoute] = useState<Route | null>(null)
  const [photo, setPhoto] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading'|'live'|'error'>('loading')
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [query, setQuery] = useState('')
  const PREFS_KEY = 'ft-prefs-v1'
  const WATCH_KEY = 'ft-watch-v1'
  const loadPrefs = (): Record<string, boolean> => {
    if (typeof window === 'undefined') return {}
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') } catch { return {} }
  }
  const prefs = loadPrefs()
  const [showWeather, setShowWeather] = useState(prefs.showWeather ?? false)
  const [showTrails, setShowTrails] = useState(prefs.showTrails ?? true)
  const [showNight, setShowNight] = useState(prefs.showNight ?? true)
  const [showList, setShowList] = useState(prefs.showList ?? false)
  const [showHeat, setShowHeat] = useState(prefs.showHeat ?? false)
  const [show3D, setShow3D] = useState<boolean>((prefs as any).show3D ?? false)
  const [chase, setChase] = useState<boolean>(false)
  const chaseRef = useRef(false)
  useEffect(() => { chaseRef.current = chase && !!selectedIcaoRef.current }, [chase])
  const [watchlist, setWatchlist] = useState<string[]>(() => {
    if (typeof window === 'undefined') return []
    try { return JSON.parse(localStorage.getItem(WATCH_KEY) || '[]') } catch { return [] }
  })
  const [showWatch, setShowWatch] = useState(false)
  const [watchInput, setWatchInput] = useState('')
  const [shareCopied, setShareCopied] = useState(false)
  const [compareList, setCompareList] = useState<Flight[]>([])
  const [showCompare, setShowCompare] = useState(false)
  const knownWatchRef = useRef<Set<string>>(new Set())
  const [showFilters, setShowFilters] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [mobileMenu, setMobileMenu] = useState(false)
  const [mobileSearch, setMobileSearch] = useState(false)
  const [welcome, setWelcome] = useState(false)
  const [about, setAbout] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!localStorage.getItem('ft-onboarded')) setWelcome(true)
  }, [])
  const [follow, setFollow] = useState(false)
  const [altMin, setAltMin] = useState(0)
  const [altMax, setAltMax] = useState(50000)
  const [spdMin, setSpdMin] = useState(0)
  const [onlyMil, setOnlyMil] = useState(false)
  const [onlyEmerg, setOnlyEmerg] = useState(false)
  const [hideGround, setHideGround] = useState(false)
  const [airlinePrefix, setAirlinePrefix] = useState('')
  const [listSort, setListSort] = useState<'callsign'|'alt'|'spd'>('alt')
  type Units = { alt: 'ft'|'m'; spd: 'kt'|'mph'|'kmh' }
  const [units, setUnits] = useState<Units>(() => {
    if (typeof window === 'undefined') return { alt: 'ft', spd: 'kt' }
    try { return JSON.parse(localStorage.getItem('ft-units-v1') || '') as Units } catch { return { alt: 'ft', spd: 'kt' } }
  })
  useEffect(() => { try { localStorage.setItem('ft-units-v1', JSON.stringify(units)) } catch {} }, [units])
  const [colorBy, setColorBy] = useState<'alt'|'spd'|'cat'|'mil'>(() => {
    if (typeof window === 'undefined') return 'alt'
    return (localStorage.getItem('ft-colorby-v1') as any) || 'alt'
  })
  useEffect(() => { try { localStorage.setItem('ft-colorby-v1', colorBy) } catch {} }, [colorBy])
  const [mapStyle, setMapStyle] = useState<'dark'|'light'|'sat'>(() => {
    if (typeof window === 'undefined') return 'dark'
    return (localStorage.getItem('ft-mapstyle-v1') as any) || 'dark'
  })
  const [showHelp, setShowHelp] = useState(false)
  const [showStyles, setShowStyles] = useState(false)
  const [audioOn, setAudioOn] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('ft-audio-v1') === '1'
  })
  useEffect(() => { try { localStorage.setItem('ft-audio-v1', audioOn ? '1' : '0') } catch {} }, [audioOn])
  const audioOnRef = useRef(audioOn); useEffect(() => { audioOnRef.current = audioOn }, [audioOn])
  const [userLoc, setUserLoc] = useState<{lat:number; lng:number} | null>(null)
  const [emergLog, setEmergLog] = useState<{icao:string; cs:string; sq:string; lat:number; lng:number; t:number}[]>([])
  const [showEmergLog, setShowEmergLog] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  const selectedIcaoRef = useRef<string | null>(null)
  const initialFocusRef = useRef<string | null>(null)
  const flightsRef = useRef<Flight[]>([])
  useEffect(() => { flightsRef.current = flights }, [flights])

  /* ---- Airport markers cache (MapLibre Markers for tooltip+click ergonomics) ---- */
  const airportMarkersRef = useRef<Map<string, maplibregl.Marker>>(new Map())

  /* ---- Helper: pan/fly using MapLibre semantics ---- */
  const flyToLatLng = useCallback((lat: number, lng: number, zoom?: number) => {
    const m = mapRef.current; if (!m) return
    if (zoom != null) m.flyTo({ center: [lng, lat], zoom })
    else m.flyTo({ center: [lng, lat] })
  }, [])

  /* ---- Init map ---- */
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return

    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const lat = parseFloat(params.get('lat') || '40.7')
    const lng = parseFloat(params.get('lng') || '-74')
    const zoom = parseInt(params.get('z') || '6', 10)
    const focusIcao = params.get('icao')
    if (focusIcao) initialFocusRef.current = focusIcao.toLowerCase()

    const map = new maplibregl.Map({
      container: mapEl.current,
      center: [lng, lat],
      zoom,
      minZoom: 2,
      maxZoom: 16,
      pitch: prefs.show3D ? 60 : 0,
      maxPitch: 75,
      attributionControl: false,
      style: {
        version: 8,
        sources: {
          'carto-dark': {
            type: 'raster',
            tiles: [
              'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
              'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
              'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
              'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
            ],
            tileSize: 256,
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> · <a href="https://carto.com/attributions">CARTO</a> · <a href="https://adsb.lol">adsb.lol</a> · <a href="https://www.planespotters.net">planespotters</a> · <a href="https://rainviewer.com">RainViewer</a> · <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain</a>',
          },
          'terrain-dem': {
            type: 'raster-dem',
            tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
            tileSize: 256,
            encoding: 'terrarium',
            maxzoom: 14,
          },
        },
        layers: [
          { id: 'basemap', type: 'raster', source: 'carto-dark' },
          { id: 'hillshade', type: 'hillshade', source: 'terrain-dem',
            paint: { 'hillshade-shadow-color': '#000010', 'hillshade-highlight-color': '#3b4f7a', 'hillshade-exaggeration': 0.5 },
            layout: { visibility: 'none' } },
        ],
      },
    })

    map.addControl(new maplibregl.AttributionControl({ compact: true }))
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }), 'bottom-right')
    map.dragRotate.enable()
    map.touchZoomRotate.enableRotation()

    mapRef.current = map

    map.on('load', () => {
      // Pre-generate plane icons
      for (const color of ICON_COLORS) {
        for (const heli of [false, true]) {
          for (const sel of [false, true]) {
            const id = iconKey(color, heli, sel)
            if (!map.hasImage(id)) {
              map.addImage(id, drawIcon(color, heli, sel), { pixelRatio: 2 })
            }
          }
        }
      }

      // Sources
      map.addSource('terminator', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('weather', { type: 'raster', tiles: [], tileSize: 256 } as any)
      map.addSource('trails', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('route-points', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('planes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addSource('alt-columns', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })

      // Sky / atmosphere (only renders when pitched)
      try {
        map.setSky({
          'sky-color': '#0b1424',
          'horizon-color': '#1e3a5f',
          'fog-color': '#0b1424',
          'sky-horizon-blend': 0.6,
          'horizon-fog-blend': 0.6,
          'fog-ground-blend': 0.5,
          'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 12, 0],
        } as any)
      } catch {}

      // Day/night fill (above basemap, below everything else)
      map.addLayer({
        id: 'terminator-layer',
        type: 'fill',
        source: 'terminator',
        paint: { 'fill-color': '#000010', 'fill-opacity': 0.35 },
      })

      // Weather raster (initially hidden)
      map.addLayer({
        id: 'weather-layer',
        type: 'raster',
        source: 'weather',
        paint: { 'raster-opacity': 0.55 },
        layout: { visibility: 'none' },
      })

      // Heatmap (driven by planes source, ground filtered out)
      map.addLayer({
        id: 'heat-layer',
        type: 'heatmap',
        source: 'planes',
        filter: ['!=', ['get', 'ground'], true],
        layout: { visibility: 'none' },
        paint: {
          'heatmap-weight': 1,
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1, 9, 3],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 12, 9, 30],
          'heatmap-opacity': 0.7,
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(0,0,0,0)',
            0.2, 'rgba(255,80,40,0.4)',
            0.5, 'rgba(255,180,40,0.6)',
            0.75, 'rgba(120,220,80,0.75)',
            1, 'rgba(80,180,255,0.9)',
          ],
        },
      })

      // Trails
      map.addLayer({
        id: 'trails-layer',
        type: 'line',
        source: 'trails',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['==', ['get', 'sel'], true], 3, 1.2],
          'line-opacity': ['case', ['==', ['get', 'sel'], true], 0.95, 0.55],
        },
      })

      // Routes
      map.addLayer({
        id: 'routes-layer',
        type: 'line',
        source: 'routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['get', 'width'],
          'line-opacity': ['get', 'opacity'],
          'line-dasharray': ['case',
            ['==', ['get', 'dashed'], true], ['literal', [2, 2]],
            ['literal', [1]],
          ],
        },
      })
      map.addLayer({
        id: 'route-points-layer',
        type: 'circle',
        source: 'route-points',
        paint: {
          'circle-radius': 5,
          'circle-color': ['get', 'color'],
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': 2,
          'circle-opacity': 0.45,
        },
      })

      // Planes (symbol) — floats at altitude in 3D mode via symbol-z-elevate
      map.addLayer({
        id: 'planes-layer',
        type: 'symbol',
        source: 'planes',
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-rotate': ['get', 'track'],
          'icon-rotation-alignment': 'map',
          'icon-pitch-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-size': 1,
          'symbol-z-elevate': true,
        } as any,
      })

      // Altitude columns (3D fill-extrusion ground→aircraft, shown only when 3D pitched)
      map.addLayer({
        id: 'alt-columns-layer',
        type: 'fill-extrusion',
        source: 'alt-columns',
        layout: { visibility: 'none' },
        paint: {
          'fill-extrusion-color': ['get', 'color'],
          'fill-extrusion-base': 0,
          'fill-extrusion-height': ['get', 'h'],
          'fill-extrusion-opacity': 0.35,
        },
      })

      // Click handler
      map.on('click', 'planes-layer', (e) => {
        const f0 = e.features?.[0]; if (!f0) return
        const icao = (f0.properties as any).icao as string
        const flt = flightsRef.current.find((x) => x.icao === icao)
        if (flt) { setSelected(flt); setSelectedAirport(null) }
      })
      map.on('mouseenter', 'planes-layer', () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', 'planes-layer', () => { map.getCanvas().style.cursor = '' })

      mapReadyRef.current = true
      setMapReady(true)
    })

    // URL + bounds sync
    const saveUrl = () => {
      const c = map.getCenter()
      const b = map.getBounds()
      const q = new URLSearchParams()
      q.set('lat', c.lat.toFixed(3))
      q.set('lng', c.lng.toFixed(3))
      q.set('z', String(Math.round(map.getZoom())))
      if (selectedIcaoRef.current) q.set('icao', selectedIcaoRef.current)
      window.history.replaceState(null, '', `#${q.toString()}`)
      setMapZoom(map.getZoom())
      setMapBounds({ n: b.getNorth(), s: b.getSouth(), e: b.getEast(), w: b.getWest() })
    }
    map.on('moveend', saveUrl)
    map.on('zoomend', saveUrl)
    map.once('load', saveUrl)

    const fixSize = () => map.resize()
    const t1 = setTimeout(fixSize, 250)
    const t2 = setTimeout(fixSize, 800)
    window.addEventListener('resize', fixSize)
    return () => {
      clearTimeout(t1); clearTimeout(t2)
      window.removeEventListener('resize', fixSize)
      map.remove(); mapRef.current = null
      mapReadyRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    selectedIcaoRef.current = selected?.icao ?? null
    const q = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    if (selected) q.set('icao', selected.icao); else q.delete('icao')
    window.history.replaceState(null, '', `#${q.toString()}`)
    if (typeof document !== 'undefined') {
      document.title = selected ? `${selected.callsign} · ${selected.type} · Flight Tracker` : 'Flight Tracker'
    }
  }, [selected])

  /* ---- 3D pitch + terrain + extrusions toggle ---- */
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    if (show3D) {
      try { m.setTerrain({ source: 'terrain-dem', exaggeration: 1.4 } as any) } catch {}
      if (m.getLayer('hillshade')) m.setLayoutProperty('hillshade', 'visibility', 'visible')
      if (m.getLayer('alt-columns-layer')) m.setLayoutProperty('alt-columns-layer', 'visibility', 'visible')
      m.easeTo({ pitch: 70, bearing: m.getBearing(), duration: 800 })
    } else {
      try { m.setTerrain(null as any) } catch {}
      if (m.getLayer('hillshade')) m.setLayoutProperty('hillshade', 'visibility', 'none')
      if (m.getLayer('alt-columns-layer')) m.setLayoutProperty('alt-columns-layer', 'visibility', 'none')
      m.easeTo({ pitch: 0, duration: 600 })
    }
  }, [show3D, mapReady])

  /* ---- Weather radar (RainViewer) ---- */
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    if (showWeather) {
      ;(async () => {
        try {
          const r = await fetch('https://api.rainviewer.com/public/weather-maps.json')
          const j = await r.json() as { host: string; radar: { past: Array<{ time: number; path: string }> } }
          const past = j.radar.past
          const latest = past[past.length - 1]
          const url = `${j.host}${latest.path}/256/{z}/{x}/{y}/2/1_1.png`
          const src = m.getSource('weather') as any
          // Recreate the source to swap tile URL
          if (m.getLayer('weather-layer')) m.removeLayer('weather-layer')
          if (m.getSource('weather')) m.removeSource('weather')
          m.addSource('weather', { type: 'raster', tiles: [url], tileSize: 256 } as any)
          const before = m.getLayer('terminator-layer') ? 'terminator-layer' : undefined
          m.addLayer({
            id: 'weather-layer', type: 'raster', source: 'weather',
            paint: { 'raster-opacity': 0.55 },
          }, before)
          void src
        } catch (e) { console.error('weather fail', e) }
      })()
    } else {
      if (m.getLayer('weather-layer')) m.setLayoutProperty('weather-layer', 'visibility', 'none')
    }
  }, [showWeather, mapReady])

  /* ---- Day/Night terminator ---- */
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    const apply = () => {
      const src = m.getSource('terminator') as maplibregl.GeoJSONSource | undefined
      if (!src) return
      if (!showNight) { src.setData({ type: 'FeatureCollection', features: [] } as any); return }
      const pts = terminatorPolygon(new Date()).map(([lat, lng]) => [lng, lat])
      const geo: any = {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature', properties: {},
          geometry: { type: 'Polygon', coordinates: [pts] },
        }],
      }
      src.setData(geo)
    }
    apply()
    const id = setInterval(apply, 5 * 60_000)
    return () => clearInterval(id)
  }, [showNight, mapReady])

  /* ---- Airport METAR weather fetch ---- */
  useEffect(() => {
    if (!selectedAirport) { setAirportMetar(null); return }
    const ap = selectedAirport
    setAirportMetar(null)
    let cancelled = false
    ;(async () => {
      try {
        const target = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(ap.i)}&format=json`
        const res = await fetch(`https://corsproxy.io/?${encodeURIComponent(target)}`, { cache: 'no-store' })
        if (!res.ok) return
        const arr = await res.json() as Array<{rawOb:string; temp:number; dewp:number; wdir:number; wspd:number; visib:string; altim:number; fltCat:string; clouds?:{cover:string;base:number}[]}>
        if (cancelled || !arr?.length) return
        setAirportMetar(arr[0])
      } catch { /* swallow */ }
    })()
    return () => { cancelled = true }
  }, [selectedAirport])

  /* ---- Fetch loop ---- */
  const fetchOnce = useCallback(async () => {
    try {
      const m = mapRef.current
      let lat = 40.7, lon = -74, distNm = 250
      const tiles: Array<{lat:number; lon:number; dist:number}> = []
      if (m) {
        const c = m.getCenter()
        lat = c.lat; lon = c.lng
        const b = m.getBounds()
        const halfH = (b.getNorth() - b.getSouth()) / 2 * 60
        const halfW = (b.getEast() - b.getWest()) / 2 * 60 * Math.cos(lat * Math.PI / 180)
        const maxHalf = Math.max(halfH, halfW)
        // adsb.lol caps payload at ~dist=2000nm. If viewport demands more, tile it.
        const CAP = 1800
        if (maxHalf * 1.15 <= CAP) {
          distNm = Math.max(50, Math.ceil(maxHalf * 1.15))
        } else {
          // tile the visible bounds into a grid of ~CAP-sized chunks
          const dLat = (CAP * 2) / 60                         // nm -> deg lat
          const south = b.getSouth(), north = b.getNorth()
          const west  = b.getWest(),  east  = b.getEast()
          for (let la = south; la < north; la += dLat) {
            const midLa = Math.min(north, la + dLat/2)
            const dLon = (CAP * 2) / (60 * Math.cos(midLa * Math.PI / 180))
            for (let lo = west; lo < east; lo += dLon) {
              tiles.push({
                lat: Math.min(north, la + dLat/2),
                lon: Math.min(east, lo + dLon/2),
                dist: CAP,
              })
            }
          }
          // safety: cap to 12 parallel calls
          if (tiles.length > 12) tiles.length = 12
        }
      }

      let raw: AcRaw[] = []
      if (tiles.length) {
        const results = await Promise.all(tiles.map(async t => {
          try {
            const target = `https://api.adsb.lol/v2/lat/${t.lat.toFixed(4)}/lon/${t.lon.toFixed(4)}/dist/${t.dist}`
            const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(target)}`, { cache: 'no-store' })
            if (!r.ok) return [] as AcRaw[]
            const j = await r.json() as { ac?: AcRaw[] }
            return j.ac ?? []
          } catch { return [] as AcRaw[] }
        }))
        const seen = new Set<string>()
        for (const arr of results) for (const a of arr) {
          if (a.hex && !seen.has(a.hex)) { seen.add(a.hex); raw.push(a) }
        }
      } else {
        const target = `https://api.adsb.lol/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${distNm}`
        const res = await fetch(`https://corsproxy.io/?${encodeURIComponent(target)}`, { cache: 'no-store' })
        if (!res.ok) throw new Error(`adsb.lol HTTP ${res.status}`)
        const json = await res.json() as { ac?: AcRaw[] }
        raw = json.ac ?? []
      }
      const parsed: Flight[] = raw
        .filter(a => typeof a.lat === 'number' && typeof a.lon === 'number')
        .map(a => {
          const ground = a.alt_baro === 'ground'
          const altFt = ground ? 0 : (typeof a.alt_geom === 'number' ? a.alt_geom : (typeof a.alt_baro === 'number' ? a.alt_baro : 0))
          const sq = a.squawk || ''
          const emergency = !!a.emergency && a.emergency !== 'none' || sq === '7500' || sq === '7600' || sq === '7700'
          const military = !!(a.desc && /\b(USAF|NAVY|ARMY|MARINE|FORCE|MIL|RAF|JASDF)\b/i.test(a.desc)) ||
                           !!(a.r && /^\d+-\d+/.test(a.r))
          return {
            icao: a.hex,
            callsign: (a.flight || '').trim() || a.r || a.hex.toUpperCase(),
            registration: a.r || '—',
            type: a.t || a.desc || '—',
            dataSource: a.type || 'unknown',
            operator: a.ownOp || '—',
            lng: a.lon, lat: a.lat,
            altitudeFt: altFt, ground,
            velocityKts: a.gs ?? 0,
            ias: a.ias ?? 0,
            mach: a.mach ?? 0,
            vertRate: a.geom_rate ?? a.baro_rate ?? 0,
            navAlt: a.nav_altitude_mcp ?? 0,
            windDir: a.wd ?? 0,
            windKts: a.ws ?? 0,
            oat: typeof a.oat === 'number' ? a.oat : NaN,
            track: a.track ?? 0,
            squawk: sq, category: a.category || '',
            emergency, military: military || !!(a.dbFlags && (a.dbFlags & 1)),
          }
        })
      const now = Date.now()
      for (const f of parsed) {
        const t = trailsRef.current.get(f.icao) || []
        const last = t[t.length - 1]
        if (!last || last[0] !== f.lat || last[1] !== f.lng) {
          t.push([f.lat, f.lng, now])
          if (t.length > TRAIL_MAX) t.shift()
          trailsRef.current.set(f.icao, t)
        }
      }
      const seen = new Set(parsed.map(f => f.icao))
      for (const [k, t] of trailsRef.current) {
        const lastTs = t[t.length - 1]?.[2] || 0
        if (!seen.has(k) && now - lastTs > 5 * 60_000) trailsRef.current.delete(k)
      }
      setFlights(parsed)
      setStatus('live')
      setLastUpdate(new Date())

      if (initialFocusRef.current) {
        const f = parsed.find(x => x.icao.toLowerCase() === initialFocusRef.current)
        if (f) setSelected(f)
        initialFocusRef.current = null
      }
    } catch (e) {
      setStatus('error')
      console.error('adsb fetch failed:', e)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (cancelled) return
      await fetchOnce()
      if (!cancelled) timer = setTimeout(tick, REFRESH_MS)
    }
    tick()
    const m = mapRef.current
    let moveTimer: ReturnType<typeof setTimeout>
    const onMove = () => {
      clearTimeout(moveTimer)
      moveTimer = setTimeout(fetchOnce, 500)
    }
    m?.on('moveend', onMove)
    return () => { cancelled = true; clearTimeout(timer); clearTimeout(moveTimer); m?.off('moveend', onMove) }
  }, [fetchOnce])

  /* ---- Filtered list ---- */
  const watchSet = useMemo(() => new Set(watchlist.map(w => w.toUpperCase())), [watchlist])
  const isWatched = useCallback((f: Flight) => {
    const cs = f.callsign.replace(/\s+/g,'').toUpperCase()
    const reg = f.registration.replace(/\s+/g,'').toUpperCase()
    if (watchSet.has(cs) || watchSet.has(reg) || watchSet.has(f.icao.toUpperCase())) return true
    for (const w of watchSet) if (cs.startsWith(w) && w.length >= 3) return true
    return false
  }, [watchSet])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const ap = airlinePrefix.trim().toUpperCase()
    return flights.filter(f => {
      if (hideGround && f.ground) return false
      if (onlyMil && !f.military) return false
      if (onlyEmerg && !f.emergency) return false
      if (!f.ground && (f.altitudeFt < altMin || f.altitudeFt > altMax)) return false
      if (spdMin > 0 && f.velocityKts < spdMin) return false
      if (ap && !f.callsign.toUpperCase().startsWith(ap)) return false
      if (!q) return true
      return f.callsign.toLowerCase().includes(q) || f.registration.toLowerCase().includes(q) ||
             f.type.toLowerCase().includes(q) || f.operator.toLowerCase().includes(q) ||
             f.icao.includes(q) || f.squawk.includes(q)
    })
  }, [flights, query, hideGround, onlyMil, onlyEmerg, altMin, altMax, spdMin, airlinePrefix])

  /* ---- Render planes (symbol layer) + 60fps dead-reckon interpolation ---- */
  // Snapshot of last-known authoritative positions per icao
  const lastPosRef = useRef<Map<string, { lng:number; lat:number; t:number; track:number; gs:number; ground:boolean; altFt:number; emergency:boolean; isSel:boolean; heli:boolean; color:string }>>(new Map())

  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    const now = performance.now()
    const next = new Map<string, any>()
    for (const f of filtered) {
      const isSel = selected?.icao === f.icao
      const heli = f.category === 'A7'
      const watched = isWatched(f)
      let baseColor: string
      if (colorBy === 'spd') baseColor = speedColor(f.velocityKts)
      else if (colorBy === 'cat') baseColor = catColor(f.category)
      else if (colorBy === 'mil') baseColor = f.military ? '#fb923c' : altColor(f.altitudeFt)
      else baseColor = altColor(f.altitudeFt)
      const color = f.emergency ? '#f43f5e' : f.ground ? '#64748b' : isSel ? '#fbbf24' : watched ? '#22d3ee' : isNotable(f.callsign) ? '#a78bfa' : baseColor
      next.set(f.icao, {
        lng: f.lng, lat: f.lat, t: now,
        track: f.track || 0, gs: f.velocityKts || 0,
        ground: f.ground, altFt: f.altitudeFt, emergency: f.emergency,
        isSel, heli, color,
      })
    }
    lastPosRef.current = next
  }, [filtered, selected, mapReady, colorBy, isWatched])

  // RAF loop: dead-reckon current position from last + velocity*elapsed
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    let raf = 0
    let pulse = 0
    const step = () => {
      pulse += 0.06
      const now = performance.now()
      const src = m.getSource('planes') as maplibregl.GeoJSONSource | undefined
      const colSrc = m.getSource('alt-columns') as maplibregl.GeoJSONSource | undefined
      if (!src) { raf = requestAnimationFrame(step); return }

      const planeFeats: any[] = []
      const colFeats: any[] = []
      lastPosRef.current.forEach((p, icao) => {
        const dt = Math.min((now - p.t) / 1000, 12) // seconds, clamp 12
        // forward project along track at gs knots → degrees
        let lat = p.lat, lng = p.lng
        if (!p.ground && p.gs > 5) {
          const distNm = p.gs * dt / 3600
          const distDeg = distNm / 60
          const rad = (p.track * Math.PI) / 180
          lat = p.lat + Math.cos(rad) * distDeg
          lng = p.lng + (Math.sin(rad) * distDeg) / Math.max(Math.cos(p.lat*Math.PI/180), 0.0001)
        }
        // Pulse emergency icons via icon-size? simpler: bump color brightness via separate layer would be heavy.
        // Keep icon, but for emergency we'll oscillate via altitude column height visualisation instead.
        const altM = (!p.ground && p.altFt > 0) ? p.altFt * 0.3048 : 0
        planeFeats.push({
          type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat, altM] },
          properties: { icao, track: p.track, icon: iconKey(p.color, p.heli, p.isSel), ground: p.ground, altM },
        })
        if (!p.ground && p.altFt > 0) {
          const d = 0.003
          const ring = [
            [lng - d, lat - d], [lng + d, lat - d],
            [lng + d, lat + d], [lng - d, lat + d],
            [lng - d, lat - d],
          ]
          let h = p.altFt * 0.3048
          if (p.emergency) h *= 1 + 0.4 * Math.sin(pulse * 4)
          colFeats.push({
            type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] },
            properties: { icao, color: p.color, h },
          })
        }
      })
      src.setData({ type: 'FeatureCollection', features: planeFeats } as any)
      if (colSrc) colSrc.setData({ type: 'FeatureCollection', features: colFeats } as any)

      // Chase camera: if chaseRef on, fly to selected plane current interpolated pos
      if (chaseRef.current && selectedIcaoRef.current) {
        const p = lastPosRef.current.get(selectedIcaoRef.current)
        if (p) {
          const dt = Math.min((now - p.t) / 1000, 12)
          let lat = p.lat, lng = p.lng
          if (!p.ground && p.gs > 5) {
            const distNm = p.gs * dt / 3600
            const distDeg = distNm / 60
            const rad = (p.track * Math.PI) / 180
            lat = p.lat + Math.cos(rad) * distDeg
            lng = p.lng + (Math.sin(rad) * distDeg) / Math.max(Math.cos(p.lat*Math.PI/180), 0.0001)
          }
          m.jumpTo({ center: [lng, lat], bearing: p.track, pitch: 70, zoom: Math.max(m.getZoom(), 10.5) })
        }
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [mapReady])

  /* ---- Render trails ---- */
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    const src = m.getSource('trails') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    if (!showTrails) { src.setData({ type: 'FeatureCollection', features: [] } as any); return }
    const features: any[] = []
    for (const f of filtered) {
      const t = trailsRef.current.get(f.icao)
      if (!t || t.length < 2) continue
      const color = altColor(f.altitudeFt)
      const isSel = selected?.icao === f.icao
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: t.map(p => [p[1], p[0]]) },
        properties: { color, sel: isSel },
      })
    }
    src.setData({ type: 'FeatureCollection', features } as any)
  }, [filtered, selected, showTrails, flights, mapReady])

  /* ---- Heatmap toggle ---- */
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    if (m.getLayer('heat-layer')) {
      m.setLayoutProperty('heat-layer', 'visibility', showHeat ? 'visible' : 'none')
    }
  }, [showHeat, mapReady])

  /* ---- Visible airports ---- */
  const visibleAirports = useMemo(() => {
    if (!mapBounds || mapZoom < 5) return []
    const { n, s, e, w } = mapBounds
    const wrapW = w < -180 ? w + 360 : w
    const wrapE = e > 180 ? e - 360 : e
    return AIRPORTS.filter(ap =>
      ap.lat >= s && ap.lat <= n &&
      (w <= e ? (ap.lon >= wrapW && ap.lon <= wrapE) : (ap.lon >= wrapW || ap.lon <= wrapE))
    )
  }, [mapBounds, mapZoom])

  /* ---- Airport markers ---- */
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    const live = new Set<string>()
    const size = mapZoom < 7 ? 14 : mapZoom < 9 ? 18 : 22
    const fontSize = mapZoom < 7 ? 7 : mapZoom < 9 ? 9 : 11
    if (mapZoom < 5) {
      for (const [, mk] of airportMarkersRef.current) mk.remove()
      airportMarkersRef.current.clear()
      return
    }
    for (const ap of visibleAirports) {
      live.add(ap.i)
      let mk = airportMarkersRef.current.get(ap.i)
      if (!mk) {
        const el = document.createElement('div')
        el.style.cssText = `width:${size}px;height:${size}px;border-radius:3px;background:rgba(15,23,42,0.85);border:1.5px solid #38bdf8;display:flex;align-items:center;justify-content:center;font-family:monospace;font-weight:700;font-size:${fontSize}px;color:#7dd3fc;line-height:1;cursor:pointer;box-shadow:0 0 6px rgba(56,189,248,0.4);user-select:none;`
        el.textContent = '✈'
        el.title = `${ap.a} · ${ap.n}\n${ap.m}`
        el.addEventListener('click', (ev) => {
          ev.stopPropagation()
          setSelectedAirport(ap); setSelected(null)
        })
        mk = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([ap.lon, ap.lat]).addTo(m)
        airportMarkersRef.current.set(ap.i, mk)
      } else {
        // resize existing element if zoom changed
        const el = mk.getElement()
        el.style.width = `${size}px`; el.style.height = `${size}px`; el.style.fontSize = `${fontSize}px`
      }
    }
    for (const [k, mk] of airportMarkersRef.current) {
      if (!live.has(k)) { mk.remove(); airportMarkersRef.current.delete(k) }
    }
  }, [visibleAirports, mapZoom, mapReady])

  /* ---- Emergency squawk alerting ---- */
  useEffect(() => {
    const fresh: typeof toasts = []
    for (const f of flights) {
      if (!f.emergency || !f.squawk) continue
      if (!['7500','7600','7700'].includes(f.squawk)) continue
      const key = f.icao + ':' + f.squawk
      if (knownEmergRef.current.has(key)) continue
      knownEmergRef.current.add(key)
      fresh.push({ id: key, icao: f.icao, cs: f.callsign || f.icao.toUpperCase(), sq: f.squawk, lat: f.lat, lng: f.lng, t: Date.now() })
    }
    if (fresh.length) {
      setToasts(prev => [...fresh, ...prev].slice(0, 5))
      setEmergLog(prev => [...fresh, ...prev].slice(0, 20))
      if (audioOnRef.current) {
        try {
          const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext
          if (Ctx) {
            const ctx = new Ctx()
            const o = ctx.createOscillator(); const g = ctx.createGain()
            o.connect(g); g.connect(ctx.destination)
            o.frequency.value = 880; o.type = 'sine'
            g.gain.setValueAtTime(0.18, ctx.currentTime)
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45)
            o.start(); o.stop(ctx.currentTime + 0.5)
          }
        } catch {}
      }
      setTimeout(() => {
        setToasts(prev => prev.filter(t => !fresh.find(f => f.id === t.id)))
      }, 12000)
    }
  }, [flights])

  /* ---- Persist watchlist ---- */
  useEffect(() => {
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(watchlist)) } catch {}
  }, [watchlist])

  /* ---- Watchlist detection ---- */
  useEffect(() => {
    if (!watchlist.length) return
    const fresh: typeof toasts = []
    for (const f of flights) {
      const cs = f.callsign.replace(/\s+/g, '').toUpperCase()
      const reg = f.registration.replace(/\s+/g, '').toUpperCase()
      const matched = watchlist.find(w => {
        const ww = w.toUpperCase()
        return cs === ww || reg === ww || cs.startsWith(ww) || f.icao.toLowerCase() === w.toLowerCase()
      })
      if (!matched) continue
      const key = 'watch:' + f.icao
      if (knownWatchRef.current.has(key)) continue
      knownWatchRef.current.add(key)
      fresh.push({ id: key, icao: f.icao, cs: f.callsign || matched, sq: matched, lat: f.lat, lng: f.lng, t: Date.now() })
    }
    if (fresh.length) {
      setToasts(prev => [...fresh, ...prev].slice(0, 5))
      if (audioOnRef.current) {
        try {
          const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext
          if (Ctx) {
            const ctx = new Ctx()
            const o = ctx.createOscillator(); const g = ctx.createGain()
            o.connect(g); g.connect(ctx.destination)
            o.frequency.value = 660; o.type = 'sine'
            g.gain.setValueAtTime(0.12, ctx.currentTime)
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
            o.start(); o.stop(ctx.currentTime + 0.35)
          }
        } catch {}
      }
      setTimeout(() => setToasts(prev => prev.filter(t => !fresh.find(f => f.id === t.id))), 15000)
    }
    const visibleIcaos = new Set(flights.map(f => 'watch:' + f.icao))
    for (const k of Array.from(knownWatchRef.current)) {
      if (k.startsWith('watch:') && !visibleIcaos.has(k)) knownWatchRef.current.delete(k)
    }
  }, [flights, watchlist])

  /* ---- Refresh compare list ---- */
  useEffect(() => {
    if (!compareList.length) return
    setCompareList(prev => prev.map(p => flights.find(f => f.icao === p.icao) || p))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flights])

  /* ---- Follow mode ---- */
  useEffect(() => {
    if (!follow || !selected) return
    const f = flights.find(x => x.icao === selected.icao)
    if (f) mapRef.current?.easeTo({ center: [f.lng, f.lat], duration: 400 })
  }, [follow, selected, flights])

  /* ---- Persist UI prefs ---- */
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ showWeather, showTrails, showNight, showList, showHeat, show3D }))
    } catch {}
  }, [showWeather, showTrails, showNight, showList, showHeat, show3D])

  /* ---- Route + photo on selection ---- */
  useEffect(() => {
    setRoute(null); setPhoto(null)
    clearRouteLayer()
    if (!selected) return
    const flight = selected
    drawRoute(null, flight)
    const cs = flight.callsign.replace(/\s+/g, '')
    if (cs && cs.length >= 3 && cs !== flight.registration && cs !== flight.icao.toUpperCase()) {
      const cached = routeCacheRef.current.get(cs)
      if (cached !== undefined) {
        setRoute(cached); drawRoute(cached, flight)
      } else {
        ;(async () => {
          try {
            const r = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`)
            if (!r.ok) throw new Error(`route HTTP ${r.status}`)
            const j = await r.json() as { response?: { flightroute?: { airline?: { name: string }; origin?: any; destination?: any } } }
            const fr = j?.response?.flightroute
            let route: Route | null = null
            if (fr?.origin && fr?.destination) {
              const toAp = (a: any): Airport => ({
                icao: a.icao_code, iata: a.iata_code, name: a.name,
                location: a.municipality || a.country_name, lat: a.latitude, lon: a.longitude,
                countryiso2: a.country_iso_name,
              })
              route = { airports: [toAp(fr.origin), toAp(fr.destination)], airline: fr.airline?.name }
            }
            routeCacheRef.current.set(cs, route)
            if (selectedIcaoRef.current === flight.icao) { setRoute(route); drawRoute(route, flight) }
          } catch (e) {
            routeCacheRef.current.set(cs, null)
            console.warn('route fail', e)
          }
        })()
      }
    }
    const ph = photoCacheRef.current.get(flight.icao)
    if (ph !== undefined) setPhoto(ph)
    else {
      ;(async () => {
        try {
          const r = await fetch(`https://api.planespotters.net/pub/photos/hex/${flight.icao}`)
          const j = await r.json() as { photos?: Array<{ thumbnail_large?: { src: string } }> }
          let src = j.photos?.[0]?.thumbnail_large?.src || null
          if (!src) {
            try {
              const r2 = await fetch(`https://api.adsbdb.com/v0/aircraft/${flight.icao}`)
              const j2 = await r2.json() as { response?: { aircraft?: { url_photo_thumbnail?: string | null } } }
              src = j2?.response?.aircraft?.url_photo_thumbnail || null
            } catch {}
          }
          photoCacheRef.current.set(flight.icao, src)
          if (selectedIcaoRef.current === flight.icao) setPhoto(src)
        } catch {
          photoCacheRef.current.set(flight.icao, null)
        }
      })()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  const clearRouteLayer = () => {
    const m = mapRef.current; if (!m) return
    const rs = m.getSource('routes') as maplibregl.GeoJSONSource | undefined
    const ps = m.getSource('route-points') as maplibregl.GeoJSONSource | undefined
    rs?.setData({ type: 'FeatureCollection', features: [] } as any)
    ps?.setData({ type: 'FeatureCollection', features: [] } as any)
  }

  const drawRoute = (r: Route | null, flight: Flight) => {
    const m = mapRef.current; if (!m) return
    const rs = m.getSource('routes') as maplibregl.GeoJSONSource | undefined
    const ps = m.getSource('route-points') as maplibregl.GeoJSONSource | undefined
    if (!rs || !ps) return
    const lines: any[] = []
    const points: any[] = []
    if (!r?.airports?.length) {
      if (!flight.ground && flight.velocityKts > 30) {
        const distNm = (flight.velocityKts / 60) * 10
        const R = 3440.065
        const brg = flight.track * Math.PI/180
        const lat1 = flight.lat * Math.PI/180, lon1 = flight.lng * Math.PI/180
        const dR = distNm / R
        const lat2 = Math.asin(Math.sin(lat1)*Math.cos(dR) + Math.cos(lat1)*Math.sin(dR)*Math.cos(brg))
        const lon2 = lon1 + Math.atan2(Math.sin(brg)*Math.sin(dR)*Math.cos(lat1), Math.cos(dR) - Math.sin(lat1)*Math.sin(lat2))
        lines.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[flight.lng, flight.lat], [lon2*180/Math.PI, lat2*180/Math.PI]] },
          properties: { color: '#fbbf24', width: 1.5, opacity: 0.7, dashed: true },
        })
      }
      rs.setData({ type: 'FeatureCollection', features: lines } as any)
      ps.setData({ type: 'FeatureCollection', features: points } as any)
      return
    }
    const aps = r.airports
    const planePos: [number, number] = [flight.lng, flight.lat]
    if (aps.length >= 1) {
      const orig = aps[0]
      lines.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[orig.lon, orig.lat], planePos] },
        properties: { color: '#64748b', width: 1.5, opacity: 0.6, dashed: true },
      })
      points.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [orig.lon, orig.lat] },
        properties: { color: '#10b981' },
      })
    }
    if (aps.length >= 2) {
      const dest = aps[aps.length - 1]
      lines.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [planePos, [dest.lon, dest.lat]] },
        properties: { color: '#38bdf8', width: 2, opacity: 0.85, dashed: false },
      })
      points.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [dest.lon, dest.lat] },
        properties: { color: '#38bdf8' },
      })
    }
    rs.setData({ type: 'FeatureCollection', features: lines } as any)
    ps.setData({ type: 'FeatureCollection', features: points } as any)
  }

  /* ---- Stats ---- */
  const stats = useMemo(() => {
    const total = filtered.length
    const airborne = filtered.filter(f => !f.ground).length
    const air = filtered.filter(f => !f.ground)
    const avgAlt = airborne ? Math.round(air.reduce((s,f)=>s+f.altitudeFt,0) / airborne) : 0
    const avgVel = airborne ? Math.round(air.reduce((s,f)=>s+f.velocityKts,0) / airborne) : 0
    const emerg = filtered.filter(f => f.emergency).length
    return { total, airborne, avgAlt, avgVel, emerg }
  }, [filtered])

  /* ---- Keyboard shortcuts ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === '/') { e.preventDefault(); (document.getElementById('search-input') as HTMLInputElement)?.focus() }
      else if (e.key === 'Escape') { setSelected(null); setSelectedAirport(null); setShowFilters(false) }
      else if (e.key.toLowerCase() === 'w') setShowWeather(v => !v)
      else if (e.key.toLowerCase() === 't') setShowTrails(v => !v)
      else if (e.key.toLowerCase() === 'n') setShowNight(v => !v)
      else if (e.key.toLowerCase() === 'h') setShowHeat(v => !v)
      else if (e.key.toLowerCase() === 'l') setShowList(v => !v)
      else if (e.key.toLowerCase() === 'f' && selected) setFollow(v => !v)
      else if (e.key === '?' || (e.shiftKey && e.key === '/')) { e.preventDefault(); setShowHelp(v => !v) }
      else if (e.key.toLowerCase() === 'm') setShowStyles(v => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  /* ---- Map style switcher ---- */
  useEffect(() => {
    const m = mapRef.current; if (!m || !mapReady) return
    const tileSets: Record<string, string[]> = {
      dark: [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
      ],
      light: [
        'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      ],
      sat: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
    }
    try {
      if (m.getLayer('basemap')) m.removeLayer('basemap')
      if (m.getSource('carto-dark')) m.removeSource('carto-dark')
      m.addSource('carto-dark', { type: 'raster', tiles: tileSets[mapStyle], tileSize: 256 } as any)
      m.addLayer({ id: 'basemap', type: 'raster', source: 'carto-dark' }, m.getLayer('hillshade') ? 'hillshade' : undefined)
      try { localStorage.setItem('ft-mapstyle-v1', mapStyle) } catch {}
    } catch {}
  }, [mapStyle, mapReady])

  /* ---- Sorted list ---- */
  const sortedList = useMemo(() => {
    const copy = [...filtered]
    if (listSort === 'callsign') copy.sort((a, b) => a.callsign.localeCompare(b.callsign))
    else if (listSort === 'alt') copy.sort((a, b) => b.altitudeFt - a.altitudeFt)
    else copy.sort((a, b) => b.velocityKts - a.velocityKts)
    return copy.slice(0, 200)
  }, [filtered, listSort])

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#07090d]">
      <div ref={mapEl} className="absolute inset-0 z-0" style={{ width: '100%', height: '100%' }} />

      {/* Emergency banner */}
      {stats.emerg > 0 && (
        <div className="absolute top-0 inset-x-0 z-30 flex justify-center pointer-events-none pt-2">
          <div className="pointer-events-auto bg-rose-600/95 border border-rose-400 rounded-full px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-white shadow-2xl animate-pulse">
            ⚠ {stats.emerg} emergency squawk{stats.emerg > 1 ? 's' : ''} in view
          </div>
        </div>
      )}

      {/* Top bar */}
      <header className="absolute top-0 inset-x-0 z-20 flex items-start justify-between gap-3 p-3 md:p-4 pointer-events-none">
        <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-2xl px-3 md:px-4 py-2.5 shadow-2xl flex items-center gap-3">
          <PlaneLogo />
          <div>
            <div className="text-sm md:text-base font-bold tracking-tight leading-none">Flight Tracker</div>
            <div className="flex items-center gap-1.5 mt-1 text-[10px] uppercase tracking-widest">
              <span className={`size-1.5 rounded-full ${status==='live'?'bg-emerald-400 live-dot':status==='error'?'bg-rose-500':'bg-amber-400 live-dot'}`} />
              <span className="text-slate-400">
                {status === 'live' ? `Live · ${flights.length} ac` : status === 'error' ? 'Connection error' : 'Loading'}
                {lastUpdate && status==='live' && ` · ${lastUpdate.toLocaleTimeString()}`}
              </span>
            </div>
          </div>
        </div>

        <div className="pointer-events-auto flex items-center gap-2">
          <div className="hidden sm:flex bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-2xl px-2 py-1.5 shadow-2xl items-center gap-1">
            <Toggle on={showTrails} onClick={()=>setShowTrails(v=>!v)} label="Trails" hint="T" />
            <Toggle on={showWeather} onClick={()=>setShowWeather(v=>!v)} label="Weather" hint="W" />
            <Toggle on={showNight} onClick={()=>setShowNight(v=>!v)} label="Night" hint="N" />
            <Toggle on={showHeat} onClick={()=>setShowHeat(v=>!v)} label="Heat" hint="H" />
            <Toggle on={show3D} onClick={()=>setShow3D(v=>!v)} label="3D" />
            <Toggle on={chase} onClick={()=>{ if(!selected){return} setChase(v=>{ const nv=!v; chaseRef.current=nv; if(nv){setShow3D(true)} return nv }) }} label="Chase" />
            <Toggle on={showList} onClick={()=>setShowList(v=>!v)} label="List" hint="L" />
            <Toggle on={showWatch} onClick={()=>setShowWatch(v=>!v)} label={`Watch${watchlist.length?` ${watchlist.length}`:''}`} />
            {compareList.length > 0 && (
              <Toggle on={showCompare} onClick={()=>setShowCompare(v=>!v)} label={`⇄ ${compareList.length}`} />
            )}
            <Toggle on={showFilters} onClick={()=>setShowFilters(v=>!v)} label="Filter" />
            <Toggle on={showStats} onClick={()=>setShowStats(v=>!v)} label="Stats" />
          </div>
          <div className="relative hidden sm:block">
          <div className="bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-2xl px-3 py-2 shadow-2xl items-center gap-2 w-44 sm:w-60 flex">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-400 shrink-0"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="m20 20-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            <input id="search-input" value={query} onChange={e=>{setQuery(e.target.value); setSearchOpen(true)}}
                   onFocus={()=>setSearchOpen(true)} onBlur={()=>setTimeout(()=>setSearchOpen(false), 200)}
                   placeholder="Search (press /)"
                   className="bg-transparent text-sm placeholder:text-slate-500 outline-none flex-1 text-slate-100" />
            {query && <button onClick={()=>setQuery('')} className="text-slate-500 hover:text-slate-200 text-xs">✕</button>}
          </div>
          {searchOpen && query.trim().length >= 1 && (
            <div className="absolute top-full mt-1 right-0 w-64 max-h-72 overflow-y-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-xl shadow-2xl z-30">
              {filtered.slice(0, 12).map(f => (
                <button key={f.icao} onMouseDown={()=>{ setSelected(f); flyToLatLng(f.lat, f.lng, Math.max(mapRef.current?.getZoom() ?? 0, 8)); setSearchOpen(false) }}
                  className="w-full text-left px-3 py-2 hover:bg-slate-800/60 border-b border-slate-900 last:border-0 flex items-center gap-2">
                  <span className="text-xs">{regFlag(f.registration)?.flag || '\u2708'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs font-bold text-slate-100 truncate">{f.callsign}</div>
                    <div className="text-[10px] text-slate-500 truncate">{f.registration} · {f.type}</div>
                  </div>
                  <div className="text-[10px] font-mono" style={{color: altColor(f.altitudeFt)}}>{f.ground?'GND':(f.altitudeFt/1000).toFixed(0)+'k'}</div>
                </button>
              ))}
              {filtered.length === 0 && <div className="px-3 py-4 text-xs text-slate-500 text-center">No matches</div>}
            </div>
          )}
          </div>
          {/* Mobile: search icon */}
          <button onClick={()=>setMobileSearch(v=>!v)} aria-label="Search"
            className="sm:hidden bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-xl size-10 flex items-center justify-center text-slate-300 active:bg-slate-800 shadow-2xl">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="m20 20-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
          {/* Mobile: hamburger */}
          <button onClick={()=>setMobileMenu(v=>!v)} aria-label="Menu"
            className="sm:hidden bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-xl size-10 flex items-center justify-center text-slate-300 active:bg-slate-800 shadow-2xl">
            {mobileMenu ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            )}
          </button>
        </div>
      </header>

      {/* Mobile search bar (slides under header) */}
      {mobileSearch && (
        <div className="sm:hidden absolute top-[64px] left-3 right-3 z-30 pointer-events-auto">
          <div className="bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl px-3 py-2.5 shadow-2xl flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-slate-400 shrink-0"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="m20 20-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            <input autoFocus value={query} onChange={e=>setQuery(e.target.value)} placeholder="Callsign, type, op…"
              className="bg-transparent text-sm placeholder:text-slate-500 outline-none flex-1 text-slate-100" />
            <button onClick={()=>{setQuery(''); setMobileSearch(false)}} className="text-slate-500 text-sm">✕</button>
          </div>
        </div>
      )}

      {/* Mobile menu sheet */}
      {mobileMenu && (
        <div className="sm:hidden absolute inset-x-3 top-[64px] z-30 pointer-events-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl p-3 grid grid-cols-3 gap-2 max-h-[60vh] overflow-y-auto">
          {([
            ['Trails', showTrails, ()=>setShowTrails(v=>!v)],
            ['Weather', showWeather, ()=>setShowWeather(v=>!v)],
            ['Night', showNight, ()=>setShowNight(v=>!v)],
            ['Heat', showHeat, ()=>setShowHeat(v=>!v)],
            ['3D', show3D, ()=>setShow3D(v=>!v)],
            ['Chase', chase, ()=>{ if(!selected) return; setChase(v=>{ const nv=!v; chaseRef.current=nv; if(nv){setShow3D(true)} return nv })}],
            ['List', showList, ()=>setShowList(v=>!v)],
            [`Watch${watchlist.length?` ${watchlist.length}`:''}`, showWatch, ()=>setShowWatch(v=>!v)],
            ['Filter', showFilters, ()=>setShowFilters(v=>!v)],
            ['Stats', showStats, ()=>setShowStats(v=>!v)],
            ...(compareList.length>0 ? [[`⇄ ${compareList.length}`, showCompare, ()=>setShowCompare(v=>!v)] as [string,boolean,()=>void]] : []),
          ] as [string, boolean, ()=>void][]).map(([label,on,fn]) => (
            <button key={label} onClick={()=>{ fn(); }}
              className={`px-2 py-2.5 rounded-xl text-xs font-semibold border transition active:scale-95 ${on?'bg-sky-500 text-slate-950 border-sky-400':'bg-slate-900/80 text-slate-300 border-slate-800'}`}>{label}</button>
          ))}
        </div>
      )}

      {/* Stats strip */}
      <div className="absolute top-[60px] md:top-[68px] left-3 md:left-4 z-20 pointer-events-none">
        <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-2xl p-2.5 md:p-3 shadow-2xl grid grid-cols-2 sm:grid-cols-4 gap-2.5 md:gap-3 w-[min(96vw,520px)]">
          <Stat label="Shown" value={stats.total.toLocaleString()} color="text-sky-400" />
          <Stat label="Airborne" value={stats.airborne.toLocaleString()} color="text-emerald-400" />
          <Stat label="Avg alt" value={`${(stats.avgAlt/1000).toFixed(1)}k ft`} color="text-violet-400" />
          <Stat label="Avg speed" value={`${Math.round(stats.avgVel)} kt`} color="text-rose-400" />
        </div>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="absolute top-[140px] md:top-[150px] left-3 md:left-4 z-20 w-[min(94vw,360px)] bg-slate-950/90 backdrop-blur-xl border border-slate-800 rounded-2xl p-4 shadow-2xl">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs uppercase tracking-widest text-slate-400 font-semibold">Filters</div>
            <button onClick={()=>setShowFilters(false)} className="size-6 rounded-md hover:bg-slate-800 flex items-center justify-center text-slate-400">✕</button>
          </div>
          <div className="space-y-3 text-sm">
            <div>
              <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500 mb-1">
                <span>Altitude (ft)</span><span className="font-mono text-slate-300">{altMin.toLocaleString()} – {altMax.toLocaleString()}</span>
              </div>
              <div className="flex gap-2 items-center">
                <input type="range" min={0} max={50000} step={1000} value={altMin} onChange={e=>setAltMin(Math.min(+e.target.value, altMax-1000))} className="flex-1 accent-sky-500" />
                <input type="range" min={0} max={50000} step={1000} value={altMax} onChange={e=>setAltMax(Math.max(+e.target.value, altMin+1000))} className="flex-1 accent-sky-500" />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500 mb-1">
                <span>Min ground speed (kt)</span><span className="font-mono text-slate-300">{spdMin}</span>
              </div>
              <input type="range" min={0} max={600} step={10} value={spdMin} onChange={e=>setSpdMin(+e.target.value)} className="w-full accent-sky-500" />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">Airline / callsign prefix</div>
              <input value={airlinePrefix} onChange={e=>setAirlinePrefix(e.target.value)} placeholder="e.g. UAL, BAW, SWA"
                className="w-full bg-slate-900/70 border border-slate-800 rounded-lg px-2 py-1 text-xs font-mono uppercase placeholder-slate-600 focus:outline-none focus:border-sky-600" />
            </div>
            <CheckRow label="Hide on-ground" checked={hideGround} onChange={setHideGround} />
            <CheckRow label="Only military" checked={onlyMil} onChange={setOnlyMil} />
            <CheckRow label="Only emergency squawks (7500/7600/7700)" checked={onlyEmerg} onChange={setOnlyEmerg} />
            <div className="pt-2 border-t border-slate-800">
              <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">Color planes by</div>
              <div className="flex gap-1">
                {([['alt','Altitude'],['spd','Speed'],['cat','Category'],['mil','Military']] as const).map(([k,l]) => (
                  <button key={k} onClick={()=>setColorBy(k)}
                    className={`flex-1 px-2 py-1.5 rounded-md text-[10px] uppercase tracking-wider font-semibold border ${colorBy===k?'bg-sky-500 text-slate-950 border-sky-400':'bg-slate-900/70 text-slate-300 border-slate-800'}`}>{l}</button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">Units</div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <div className="text-[9px] text-slate-600 mb-0.5">Altitude</div>
                  <div className="flex gap-1">
                    {(['ft','m'] as const).map(u => (
                      <button key={u} onClick={()=>setUnits(prev=>({...prev, alt:u}))}
                        className={`flex-1 px-2 py-1 rounded text-[10px] font-mono ${units.alt===u?'bg-sky-500 text-slate-950':'bg-slate-900/70 text-slate-300 border border-slate-800'}`}>{u}</button>
                    ))}
                  </div>
                </div>
                <div className="flex-1">
                  <div className="text-[9px] text-slate-600 mb-0.5">Speed</div>
                  <div className="flex gap-1">
                    {(['kt','mph','kmh'] as const).map(u => (
                      <button key={u} onClick={()=>setUnits(prev=>({...prev, spd:u}))}
                        className={`flex-1 px-2 py-1 rounded text-[10px] font-mono ${units.spd===u?'bg-sky-500 text-slate-950':'bg-slate-900/70 text-slate-300 border border-slate-800'}`}>{u}</button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <CheckRow label="Audio chime on emergency / watch alerts" checked={audioOn} onChange={setAudioOn} />
            <div className="pt-2 border-t border-slate-800 flex gap-2">
              <button onClick={()=>{
                if (!navigator.geolocation) return
                navigator.geolocation.getCurrentPosition(p => {
                  const loc = { lat: p.coords.latitude, lng: p.coords.longitude }
                  setUserLoc(loc); flyToLatLng(loc.lat, loc.lng, 9)
                }, () => {}, { enableHighAccuracy: false, timeout: 8000 })
              }} className="flex-1 text-[10px] uppercase tracking-widest bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold rounded-lg py-2">
                {userLoc ? '✓ Located' : 'Use my location'}
              </button>
              <button onClick={()=>{
                const rows = [['callsign','registration','type','operator','icao','lat','lng','alt_ft','speed_kt','track','squawk','ground','emergency']]
                for (const f of filtered) rows.push([f.callsign, f.registration, f.type, f.operator, f.icao, String(f.lat), String(f.lng), String(Math.round(f.altitudeFt)), String(Math.round(f.velocityKts)), String(Math.round(f.track)), f.squawk, String(f.ground), String(f.emergency)])
                const csv = rows.map(r => r.map(c => /[",\n]/.test(c)?`"${c.replace(/"/g,'""')}"`:c).join(',')).join('\n')
                const blob = new Blob([csv], { type: 'text/csv' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a'); a.href = url; a.download = `flights-${Date.now()}.csv`; a.click(); URL.revokeObjectURL(url)
              }} className="flex-1 text-[10px] uppercase tracking-widest bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold rounded-lg py-2">↓ CSV</button>
            </div>
          </div>
        </div>
      )}

      {/* Live list panel */}
      {showList && (
        <aside className="absolute right-3 md:right-4 top-[68px] md:top-[80px] bottom-3 md:bottom-4 z-20 w-[min(94vw,340px)] bg-slate-950/90 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl flex flex-col">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <div className="text-xs uppercase tracking-widest text-slate-400 font-semibold">Live ({sortedList.length})</div>
            <div className="flex gap-1">
              {(['callsign','alt','spd'] as const).map(s => (
                <button key={s} onClick={()=>setListSort(s)}
                  className={`px-2 py-1 rounded text-[10px] uppercase tracking-widest ${listSort===s?'bg-sky-500 text-slate-950':'text-slate-400 hover:bg-slate-800'}`}>{s}</button>
              ))}
              <button onClick={()=>setShowList(false)} className="size-6 ml-1 rounded-md hover:bg-slate-800 flex items-center justify-center text-slate-400">✕</button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {sortedList.map(f => (
              <button key={f.icao}
                      onClick={()=>{ setSelected(f); flyToLatLng(f.lat, f.lng) }}
                      className={`w-full text-left px-4 py-2 border-b border-slate-800/60 hover:bg-slate-800/50 transition flex items-center gap-3 ${selected?.icao===f.icao?'bg-sky-500/10':''}`}>
                <div className={`size-2 rounded-full shrink-0 ${f.emergency?'bg-rose-500':f.ground?'bg-slate-500':'bg-emerald-400'}`} />
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sm font-bold truncate">{f.callsign}</div>
                  <div className="text-[10px] text-slate-500 truncate">{f.type} · {f.registration}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs font-mono tabular-nums" style={{ color: altColor(f.altitudeFt) }}>{f.ground ? 'GND' : `${(f.altitudeFt/1000).toFixed(1)}k`}</div>
                  <div className="text-[10px] text-slate-500 font-mono">{Math.round(f.velocityKts)} kt</div>
                </div>
              </button>
            ))}
            {sortedList.length === 0 && (
              <div className="p-6 text-center text-xs text-slate-500">No aircraft match current filters.</div>
            )}
          </div>
        </aside>
      )}

      {/* Selected flight panel */}
      {selected && (
        <aside className={`absolute z-20 bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden ${showList ? 'left-3 md:left-4' : 'right-3 md:right-4'} bottom-3 md:bottom-4 w-[min(94vw,380px)] max-h-[70vh] overflow-y-auto`}>
          <button onClick={()=>setSelected(null)} className="absolute top-3 right-3 size-7 rounded-lg bg-slate-900/70 hover:bg-slate-800 flex items-center justify-center text-slate-400 hover:text-slate-100 transition z-10">✕</button>
          {photo && (
            <div className="relative h-40 bg-slate-900">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo} alt={selected.callsign} className="w-full h-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-950 to-transparent" />
            </div>
          )}
          <div className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-slate-500">
                  {selected.emergency ? <span className="text-rose-400 font-bold">⚠ Emergency · {selected.squawk}</span> :
                   selected.ground ? 'On ground' : 'In flight'}
                </div>
                <div className="text-2xl font-bold tracking-tight mt-0.5 font-mono flex items-center gap-2">
                  {(() => { const fl = regFlag(selected.registration); return fl ? <span className="text-xl leading-none" title={fl.code}>{fl.flag}</span> : null })()}
                  <span>{selected.callsign}</span>
                  {isNotable(selected.callsign) && <span className="text-[9px] bg-violet-500/20 text-violet-300 border border-violet-500/40 rounded px-1.5 py-0.5 uppercase tracking-wider">Notable</span>}
                  {isWatched(selected) && <span className="text-[9px] bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 rounded px-1.5 py-0.5 uppercase tracking-wider">Watched</span>}
                </div>
                <div className="text-xs text-slate-400 mt-1">{selected.registration} · {selected.type}</div>
                {selected.operator !== '—' && <div className="text-xs text-slate-500 mt-0.5">{selected.operator}</div>}
                {(() => {
                  const ds = selected.dataSource
                  const map: Record<string,{l:string,c:string,t:string}> = {
                    adsb_icao:   {l:'ADS-B',  c:'bg-emerald-500/20 text-emerald-300 border-emerald-500/40', t:'Direct ADS-B w/ ICAO addr (most accurate)'},
                    adsb_other:  {l:'ADS-B?', c:'bg-emerald-500/15 text-emerald-300/80 border-emerald-500/30', t:'ADS-B w/ non-ICAO addr'},
                    adsr_icao:   {l:'ADS-R',  c:'bg-teal-500/20 text-teal-300 border-teal-500/40', t:'ADS-R rebroadcast'},
                    tisb_icao:   {l:'TIS-B',  c:'bg-sky-500/20 text-sky-300 border-sky-500/40', t:'TIS-B (FAA radar relay)'},
                    tisb_other:  {l:'TIS-B?', c:'bg-sky-500/15 text-sky-300/80 border-sky-500/30', t:'TIS-B non-ICAO'},
                    tisb_trackfile: {l:'TIS-B', c:'bg-sky-500/15 text-sky-300/80 border-sky-500/30', t:'TIS-B trackfile'},
                    mlat:        {l:'MLAT',   c:'bg-amber-500/20 text-amber-300 border-amber-500/40', t:'Multilateration (no ADS-B, position triangulated)'},
                    mode_s:      {l:'Mode-S', c:'bg-slate-600/30 text-slate-300 border-slate-500/40', t:'Mode-S only (no position broadcast, limited data)'},
                  }
                  const info = map[ds] || {l: ds.toUpperCase(), c:'bg-slate-700/30 text-slate-300 border-slate-600/40', t: ds}
                  return (
                    <div className="mt-1.5 inline-flex items-center gap-1">
                      <span title={info.t} className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${info.c} uppercase tracking-wider font-mono`}>
                        {info.l}
                      </span>
                    </div>
                  )
                })()}
                {selected.category && CAT_LABEL[selected.category] && (
                  <div className="text-[10px] text-slate-500 mt-0.5 uppercase tracking-widest">{CAT_LABEL[selected.category]}</div>
                )}
              </div>
            </div>

            {route?.airports && route.airports.length >= 2 && (() => {
              const orig = route.airports[0], dest = route.airports[route.airports.length-1]
              const hav = (a:number,b:number,c:number,d:number) => {
                const R=3440.065, toRad=(x:number)=>x*Math.PI/180
                const dLat=toRad(c-a), dLon=toRad(d-b)
                const s=Math.sin(dLat/2)**2 + Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(dLon/2)**2
                return 2*R*Math.asin(Math.sqrt(s))
              }
              const total = hav(orig.lat,orig.lon,dest.lat,dest.lon)
              const remain = hav(selected.lat,selected.lng,dest.lat,dest.lon)
              const flown = Math.max(0, total - remain)
              const progress = total > 0 ? Math.min(1, flown/total) : 0
              const etaMin = selected.velocityKts > 50 ? Math.round(remain / selected.velocityKts * 60) : 0
              const etaText = etaMin > 0 ? (etaMin >= 60 ? `${Math.floor(etaMin/60)}h ${etaMin%60}m` : `${etaMin}m`) : '—'
              return (
                <div className="mt-4 bg-slate-900/60 border border-slate-800 rounded-xl p-3">
                  <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">Route {route.airline && <span className="text-slate-400 normal-case ml-1">· {route.airline}</span>}</div>
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div className="text-center flex-1 min-w-0">
                      <div className="text-xl font-bold font-mono text-emerald-400">{orig.iata || orig.icao}</div>
                      <div className="text-[10px] text-slate-500 truncate">{orig.location}</div>
                    </div>
                    <div className="flex-[2] min-w-0">
                      <div className="relative h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-500 to-sky-400 rounded-full" style={{width:`${progress*100}%`}} />
                        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 text-base" style={{left:`${progress*100}%`}}>✈</div>
                      </div>
                      <div className="flex justify-between text-[10px] text-slate-500 mt-1 font-mono">
                        <span>{Math.round(flown).toLocaleString()} nm</span>
                        <span className="text-amber-400">ETA {etaText}</span>
                        <span>{Math.round(remain).toLocaleString()} nm</span>
                      </div>
                    </div>
                    <div className="text-center flex-1 min-w-0">
                      <div className="text-xl font-bold font-mono text-sky-400">{dest.iata || dest.icao}</div>
                      <div className="text-[10px] text-slate-500 truncate">{dest.location}</div>
                    </div>
                  </div>
                </div>
              )
            })()}

            <div className="mt-4 grid grid-cols-2 gap-2.5 text-sm">
              <Field k="Altitude"   v={selected.ground ? 'Ground' : fmtAlt(selected.altitudeFt, units.alt)} />
              <Field k="V/Speed"    v={selected.vertRate ? `${selected.vertRate>0?'▲':'▼'} ${Math.abs(Math.round(selected.vertRate)).toLocaleString()} fpm` : '—'}
                     accent={selected.vertRate>200?'text-emerald-400':selected.vertRate<-200?'text-rose-400':undefined} />
              <Field k="Ground Spd" v={fmtSpd(selected.velocityKts, units.spd)} />
              <Field k="IAS / Mach" v={selected.ias || selected.mach ? `${selected.ias?fmtSpd(selected.ias, units.spd):'—'} / ${selected.mach?selected.mach.toFixed(2):'—'}` : '—'} />
              <Field k="Heading"    v={`${Math.round(selected.track)}° ${compass(selected.track)}`} />
              <Field k="Squawk"     v={selected.squawk || '—'} accent={selected.emergency ? 'text-rose-400' : undefined} />
              <Field k="Wind"       v={selected.windKts ? `${Math.round(selected.windDir)}° @ ${fmtSpd(selected.windKts, units.spd)}` : '—'} />
              <Field k="OAT"        v={Number.isFinite(selected.oat) ? `${Math.round(selected.oat)}°C` : '—'} />
              <Field k="A/P Target" v={selected.navAlt ? fmtAlt(selected.navAlt, units.alt) : '—'} />
              <Field k="ICAO"       v={selected.icao.toUpperCase()} />
              {userLoc && (() => {
                const R = 3440.065, toRad = (x:number)=>x*Math.PI/180
                const dLat = toRad(selected.lat - userLoc.lat), dLon = toRad(selected.lng - userLoc.lng)
                const s = Math.sin(dLat/2)**2 + Math.cos(toRad(userLoc.lat))*Math.cos(toRad(selected.lat))*Math.sin(dLon/2)**2
                const distNm = 2*R*Math.asin(Math.sqrt(s))
                const y = Math.sin(toRad(selected.lng-userLoc.lng))*Math.cos(toRad(selected.lat))
                const x = Math.cos(toRad(userLoc.lat))*Math.sin(toRad(selected.lat)) - Math.sin(toRad(userLoc.lat))*Math.cos(toRad(selected.lat))*Math.cos(toRad(selected.lng-userLoc.lng))
                const bearing = (Math.atan2(y,x)*180/Math.PI + 360) % 360
                return <Field k="From you" v={`${Math.round(distNm).toLocaleString()} nm · ${Math.round(bearing)}° ${compass(bearing)}`} wide />
              })()}
              <Field k="Position"   v={`${selected.lat.toFixed(3)}, ${selected.lng.toFixed(3)}`} wide />
            </div>

            <div className="mt-4 flex gap-2">
              <button onClick={()=>setFollow(v=>!v)}
                      className={`flex-1 text-center text-xs uppercase tracking-widest font-bold rounded-xl py-2.5 transition ${follow?'bg-amber-500 text-slate-950 hover:bg-amber-400':'bg-slate-800 text-slate-200 hover:bg-slate-700'}`}>
                {follow ? '● Following' : 'Follow (F)'}
              </button>
              <a href={`https://globe.adsb.lol/?icao=${selected.icao}`} target="_blank" rel="noreferrer"
                 className="flex-1 text-center text-xs uppercase tracking-widest bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold rounded-xl py-2.5 transition">
                Globe ↗
              </a>
            </div>

            {!photo && (
              <div className="mt-3 text-[10px] text-slate-600 text-center">Photo via planespotters.net — none on file for this aircraft</div>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => {
                  if (compareList.find(c => c.icao === selected.icao)) {
                    setCompareList(prev => prev.filter(c => c.icao !== selected.icao))
                  } else if (compareList.length < 4) {
                    setCompareList(prev => [...prev, selected])
                    setShowCompare(true)
                  }
                }}
                className={`flex-1 min-w-[60px] text-center text-[10px] uppercase tracking-widest font-bold rounded-xl py-2 transition ${compareList.find(c=>c.icao===selected.icao)?'bg-violet-600 text-white hover:bg-violet-500':'bg-slate-800 text-slate-200 hover:bg-slate-700'}`}>
                {compareList.find(c=>c.icao===selected.icao) ? '✓ COMPARE' : '⇄ COMPARE'}
              </button>
              <button
                onClick={() => {
                  const trail = trailsRef.current.get(selected.icao) || []
                  const coords = trail.map(([la,ln]) => `${ln},${la},${0}`).join(' ')
                  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>${selected.callsign} (${selected.icao.toUpperCase()})</name>
<description>Tracked via sanjays2402.github.io/flight-tracker · ${new Date().toISOString()}</description>
<Style id="t"><LineStyle><color>ff00d4ff</color><width>3</width></LineStyle></Style>
<Placemark><name>Trail</name><styleUrl>#t</styleUrl><LineString><coordinates>${coords}</coordinates></LineString></Placemark>
<Placemark><name>Current</name><Point><coordinates>${selected.lng},${selected.lat},${selected.altitudeFt*0.3048}</coordinates></Point></Placemark>
</Document></kml>`
                  const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url; a.download = `${selected.callsign || selected.icao}.kml`
                  a.click(); URL.revokeObjectURL(url)
                }}
                className="flex-1 text-center text-[10px] uppercase tracking-widest bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold rounded-xl py-2 transition">
                ↓ KML
              </button>
              <button
                onClick={() => {
                  const json = {
                    captured: new Date().toISOString(),
                    aircraft: selected,
                    trail: trailsRef.current.get(selected.icao) || [],
                    route: routeCacheRef.current.get(selected.callsign?.toUpperCase()) || null,
                  }
                  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url; a.download = `${selected.callsign || selected.icao}.json`
                  a.click(); URL.revokeObjectURL(url)
                }}
                className="flex-1 text-center text-[10px] uppercase tracking-widest bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold rounded-xl py-2 transition">
                ↓ JSON
              </button>
              <button
                onClick={async () => {
                  const url = `${location.origin}${location.pathname}#lat=${selected.lat.toFixed(3)}&lng=${selected.lng.toFixed(3)}&z=8&icao=${selected.icao}`
                  try {
                    await navigator.clipboard.writeText(url)
                    setShareCopied(true)
                    setTimeout(()=>setShareCopied(false), 1800)
                  } catch {}
                }}
                className="flex-1 text-center text-[10px] uppercase tracking-widest bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold rounded-xl py-2 transition">
                {shareCopied ? '✓ COPIED' : '↗ SHARE'}
              </button>
            </div>
          </div>
        </aside>
      )}

      {selectedAirport && (() => {
        const ap = selectedAirport
        const hav = (a:number,b:number,c:number,d:number) => {
          const R=3440.065, toRad=(x:number)=>x*Math.PI/180
          const dLat=toRad(c-a), dLon=toRad(d-b)
          const s=Math.sin(dLat/2)**2 + Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(dLon/2)**2
          return 2*R*Math.asin(Math.sqrt(s))
        }
        const bear = (lat1:number,lon1:number,lat2:number,lon2:number) => {
          const toRad=(x:number)=>x*Math.PI/180
          const dLon = toRad(lon2-lon1)
          const y = Math.sin(dLon)*Math.cos(toRad(lat2))
          const x = Math.cos(toRad(lat1))*Math.sin(toRad(lat2)) - Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(dLon)
          return (Math.atan2(y,x)*180/Math.PI + 360) % 360
        }
        const angDiff = (a:number,b:number) => { const d=Math.abs(a-b)%360; return d>180?360-d:d }

        const arrivals: {f: Flight; distNm: number; etaMin: number; tag: string}[] = []
        const departures: {f: Flight; distNm: number; tag: string}[] = []
        for (const f of flights) {
          const cs = f.callsign.replace(/\s+/g, '')
          const cached = routeCacheRef.current.get(cs)
          if (cached?.airports?.length) {
            const orig = cached.airports[0], dest = cached.airports[cached.airports.length-1]
            if (dest.icao === ap.i || dest.iata === ap.a) {
              const d = hav(f.lat,f.lng,ap.lat,ap.lon)
              const eta = f.velocityKts > 50 ? Math.round(d/f.velocityKts*60) : 0
              arrivals.push({f, distNm: d, etaMin: eta, tag: orig.iata || orig.icao})
              continue
            }
            if (orig.icao === ap.i || orig.iata === ap.a) {
              const d = hav(f.lat,f.lng,ap.lat,ap.lon)
              departures.push({f, distNm: d, tag: dest.iata || dest.icao})
              continue
            }
          }
          const d = hav(f.lat,f.lng,ap.lat,ap.lon)
          if (d > 80 || f.ground) continue
          const bFromAp = bear(ap.lat, ap.lon, f.lat, f.lng)
          const inbound = angDiff(f.track, (bFromAp+180)%360) < 50
          const outbound = angDiff(f.track, bFromAp) < 50
          if (inbound && f.vertRate < 200 && f.altitudeFt < 15000) {
            const eta = f.velocityKts > 50 ? Math.round(d/f.velocityKts*60) : 0
            arrivals.push({f, distNm: d, etaMin: eta, tag: '?'})
          } else if (outbound && f.vertRate > 200 && f.altitudeFt < 20000) {
            departures.push({f, distNm: d, tag: '?'})
          }
        }
        arrivals.sort((a,b)=> a.distNm - b.distNm)
        departures.sort((a,b)=> a.distNm - b.distNm)

        return (
          <aside className="absolute top-3 right-3 z-20 w-[95vw] max-w-[340px] max-h-[calc(100vh-100px)] overflow-hidden flex flex-col bg-slate-950/95 backdrop-blur-xl border border-sky-700/60 rounded-2xl shadow-2xl shadow-sky-900/50">
            <button onClick={()=>setSelectedAirport(null)} className="absolute top-3 right-3 size-7 rounded-lg bg-slate-900/70 hover:bg-slate-800 flex items-center justify-center text-slate-400 hover:text-slate-100 transition z-10">✕</button>
            <div className="p-4 pb-2 border-b border-slate-800">
              <div className="text-[10px] uppercase tracking-widest text-sky-400 mb-1">Airport</div>
              <div className="text-2xl font-bold font-mono text-sky-300">{ap.a}</div>
              <div className="text-sm text-slate-300 truncate">{ap.n}</div>
              <div className="text-[11px] text-slate-500 truncate">{ap.m} · {ap.i}</div>
              {airportMetar && (
                <div className="mt-3 pt-3 border-t border-slate-800/80">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[10px] uppercase tracking-widest text-amber-400">METAR · Live wx</div>
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                      airportMetar.fltCat === 'VFR' ? 'bg-emerald-500/15 text-emerald-300' :
                      airportMetar.fltCat === 'MVFR' ? 'bg-sky-500/15 text-sky-300' :
                      airportMetar.fltCat === 'IFR' ? 'bg-amber-500/15 text-amber-300' :
                      'bg-rose-500/15 text-rose-300'
                    }`}>{airportMetar.fltCat || '—'}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                    <div><span className="text-slate-500">Temp</span> <span className="text-slate-200 font-mono">{airportMetar.temp?.toFixed?.(0) ?? '—'}°C</span></div>
                    <div><span className="text-slate-500">Dew</span> <span className="text-slate-200 font-mono">{airportMetar.dewp?.toFixed?.(0) ?? '—'}°C</span></div>
                    <div><span className="text-slate-500">Wind</span> <span className="text-slate-200 font-mono">{airportMetar.wdir ?? '—'}° / {airportMetar.wspd ?? '—'}kt</span></div>
                    <div><span className="text-slate-500">Vis</span> <span className="text-slate-200 font-mono">{airportMetar.visib ?? '—'} sm</span></div>
                    <div className="col-span-2"><span className="text-slate-500">Altim</span> <span className="text-slate-200 font-mono">{airportMetar.altim?.toFixed?.(1) ?? '—'} hPa</span></div>
                  </div>
                  <div className="mt-2 text-[10px] font-mono text-slate-500 break-all leading-relaxed">{airportMetar.rawOb}</div>
                </div>
              )}
            </div>
            <div className="flex border-b border-slate-800 text-[10px] uppercase tracking-widest">
              <div className="flex-1 py-2 text-center text-emerald-400 font-bold border-r border-slate-800">
                ↓ Arrivals <span className="text-slate-500 ml-1">{arrivals.length}</span>
              </div>
              <div className="flex-1 py-2 text-center text-amber-400 font-bold">
                ↑ Departures <span className="text-slate-500 ml-1">{departures.length}</span>
              </div>
            </div>
            <div className="flex flex-1 overflow-hidden">
              <div className="flex-1 overflow-y-auto border-r border-slate-800">
                {arrivals.length === 0 && <div className="p-3 text-[11px] text-slate-500 text-center">None inbound</div>}
                {arrivals.slice(0, 30).map(({f, distNm, etaMin, tag}) => (
                  <button key={f.icao} onClick={()=>{ setSelected(f); flyToLatLng(f.lat,f.lng) }}
                          className="w-full text-left px-2.5 py-1.5 hover:bg-slate-900 border-b border-slate-900 transition">
                    <div className="flex items-baseline justify-between gap-1">
                      <span className="font-mono font-bold text-emerald-300 text-[11px]">{f.callsign}</span>
                      <span className="text-[9px] text-amber-400 font-mono">{etaMin>0?`${etaMin}m`:'—'}</span>
                    </div>
                    <div className="flex items-baseline justify-between text-[9px] text-slate-500 font-mono">
                      <span>{tag!=='?'? `from ${tag}` : 'inbound'}</span>
                      <span>{Math.round(distNm)}nm · {Math.round(f.altitudeFt/1000)}k</span>
                    </div>
                  </button>
                ))}
              </div>
              <div className="flex-1 overflow-y-auto">
                {departures.length === 0 && <div className="p-3 text-[11px] text-slate-500 text-center">None outbound</div>}
                {departures.slice(0, 30).map(({f, distNm, tag}) => (
                  <button key={f.icao} onClick={()=>{ setSelected(f); flyToLatLng(f.lat,f.lng) }}
                          className="w-full text-left px-2.5 py-1.5 hover:bg-slate-900 border-b border-slate-900 transition">
                    <div className="flex items-baseline justify-between gap-1">
                      <span className="font-mono font-bold text-amber-300 text-[11px]">{f.callsign}</span>
                      <span className="text-[9px] text-sky-400 font-mono">▲ {Math.round(f.vertRate)}fpm</span>
                    </div>
                    <div className="flex items-baseline justify-between text-[9px] text-slate-500 font-mono">
                      <span>{tag!=='?'? `to ${tag}` : 'outbound'}</span>
                      <span>{Math.round(distNm)}nm · {Math.round(f.altitudeFt/1000)}k</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
            <div className="text-[9px] text-slate-600 text-center py-1.5 border-t border-slate-800">
              Derived from live ADS-B + cached routes
            </div>
          </aside>
        )
      })()}

      {/* Watchlist panel */}
      {showWatch && (
        <aside className="absolute top-16 right-3 z-20 w-[95vw] max-w-[300px] max-h-[60vh] flex flex-col bg-slate-950/95 backdrop-blur-xl border border-sky-700/60 rounded-2xl shadow-2xl shadow-sky-900/40">
          <div className="p-3 border-b border-slate-800 flex items-baseline justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-sky-400">Watchlist</div>
              <div className="text-xs text-slate-400 mt-0.5">{watchlist.length} entries · ping on contact</div>
            </div>
            <button onClick={()=>setShowWatch(false)} className="text-slate-400 hover:text-slate-100 text-sm">✕</button>
          </div>
          <form onSubmit={e=>{
            e.preventDefault()
            const v = watchInput.trim().toUpperCase()
            if (!v || watchlist.includes(v)) return
            setWatchlist([...watchlist, v])
            setWatchInput('')
          }} className="p-2 border-b border-slate-800">
            <div className="flex gap-2">
              <input value={watchInput} onChange={e=>setWatchInput(e.target.value)}
                     placeholder="Callsign or registration"
                     className="flex-1 bg-slate-900/70 border border-slate-700 rounded-lg px-2 py-1 text-xs font-mono placeholder-slate-600 focus:outline-none focus:border-sky-600" />
              <button type="submit" className="bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold px-3 rounded-lg">+</button>
            </div>
            <div className="text-[9px] text-slate-500 mt-1.5">e.g. UAL123, AAL2401, BAW283, N628TS</div>
          </form>
          <div className="flex-1 overflow-y-auto">
            {watchlist.length === 0 && (
              <div className="p-4 text-center text-[11px] text-slate-500">
                Empty. Add a callsign — you&apos;ll get audio + visual alert next time it broadcasts.
              </div>
            )}
            {watchlist.map(w => {
              const live = flights.find(f => {
                const cs = f.callsign.replace(/\s+/g,'').toUpperCase()
                const reg = f.registration.replace(/\s+/g,'').toUpperCase()
                return cs===w || reg===w || cs.startsWith(w)
              })
              return (
                <div key={w} className="px-3 py-2 border-b border-slate-900 flex items-center justify-between gap-2 hover:bg-slate-900/50">
                  <button onClick={()=>{
                    if (live) { setSelected(live); flyToLatLng(live.lat, live.lng, Math.max(mapRef.current?.getZoom() ?? 0, 7)) }
                  }} className="flex-1 text-left">
                    <div className="font-mono text-sm text-sky-300 font-bold">{w}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">
                      {live ? <span className="text-emerald-400">● LIVE · {Math.round(live.altitudeFt/100)/10}k ft · {Math.round(live.velocityKts)}kt</span> : <span className="text-slate-600">offline</span>}
                    </div>
                  </button>
                  <button onClick={()=>setWatchlist(watchlist.filter(x=>x!==w))}
                          className="text-slate-600 hover:text-rose-400 text-xs">✕</button>
                </div>
              )
            })}
          </div>
        </aside>
      )}

      {/* Compare panel */}
      {showCompare && compareList.length > 0 && (
        <aside className="absolute left-1/2 -translate-x-1/2 bottom-12 z-30 w-[95vw] max-w-[820px] bg-slate-950/95 backdrop-blur-xl border border-violet-700/50 rounded-2xl shadow-2xl shadow-violet-900/30">
          <div className="px-4 py-2 border-b border-slate-800 flex items-baseline justify-between">
            <div className="text-[10px] uppercase tracking-widest text-violet-400">Compare · {compareList.length} aircraft</div>
            <div className="flex items-center gap-3">
              <button onClick={()=>setCompareList([])} className="text-[10px] text-slate-500 hover:text-rose-400 uppercase tracking-wider">Clear</button>
              <button onClick={()=>setShowCompare(false)} className="text-slate-400 hover:text-slate-100 text-sm">✕</button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[9px] uppercase tracking-wider text-slate-500 bg-slate-900/40">
                  <th className="text-left px-3 py-2 font-medium">Metric</th>
                  {compareList.map(f => (
                    <th key={f.icao} className="text-left px-3 py-2 font-medium">
                      <button onClick={()=>{setSelected(f); flyToLatLng(f.lat,f.lng,Math.max(mapRef.current?.getZoom() ?? 0, 7))}}
                              className="hover:text-violet-300">
                        <span className="font-mono text-violet-300 font-bold normal-case tracking-normal text-xs">{f.callsign}</span>
                      </button>
                      <button onClick={()=>setCompareList(prev=>prev.filter(c=>c.icao!==f.icao))}
                              className="ml-1.5 text-slate-600 hover:text-rose-400">✕</button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="font-mono">
                {([
                  ['Type',        (f: Flight) => f.type],
                  ['Registration',(f: Flight) => f.registration],
                  ['Operator',    (f: Flight) => f.operator],
                  ['Altitude',    (f: Flight) => f.ground ? 'Ground' : `${Math.round(f.altitudeFt).toLocaleString()} ft`],
                  ['Speed',       (f: Flight) => `${Math.round(f.velocityKts)} kt`],
                  ['Heading',     (f: Flight) => `${Math.round(f.track)}°`],
                  ['V/Speed',     (f: Flight) => f.vertRate != null ? `${f.vertRate>0?'▲':f.vertRate<0?'▼':'–'} ${Math.abs(Math.round(f.vertRate))} fpm` : '—'],
                  ['IAS',         (f: Flight) => f.ias ? `${Math.round(f.ias)} kt` : '—'],
                  ['Mach',        (f: Flight) => f.mach ? f.mach.toFixed(2) : '—'],
                  ['Wind',        (f: Flight) => (f.windKts && f.windDir!=null && !isNaN(f.windDir)) ? `${Math.round(f.windDir)}° @ ${Math.round(f.windKts)} kt` : '—'],
                  ['OAT',         (f: Flight) => (f.oat!=null && !isNaN(f.oat)) ? `${f.oat}°C` : '—'],
                  ['A/P Target',  (f: Flight) => f.navAlt ? `${Math.round(f.navAlt).toLocaleString()} ft` : '—'],
                  ['Squawk',      (f: Flight) => f.squawk || '—'],
                  ['Source',      (f: Flight) => f.dataSource],
                ] as Array<[string, (f: Flight) => any]>).map(([label, getter]) => (
                  <tr key={label} className="border-t border-slate-900 hover:bg-slate-900/30">
                    <td className="text-[10px] uppercase tracking-widest text-slate-500 px-3 py-1.5 font-sans">{label}</td>
                    {compareList.map(f => (
                      <td key={f.icao} className="px-3 py-1.5 text-slate-200">{String(getter(f))}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </aside>
      )}

      {/* Stats Dashboard */}
      {showStats && (() => {
        // Top operators
        const opCounts = new Map<string, number>()
        for (const f of filtered) { const k = (f.operator||'—').trim(); if(!k||k==='—') continue; opCounts.set(k,(opCounts.get(k)||0)+1) }
        const topOps = [...opCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6)
        // Aircraft type
        const typeCounts = new Map<string, number>()
        for (const f of filtered) { const k = (f.type||'').trim(); if(!k) continue; typeCounts.set(k,(typeCounts.get(k)||0)+1) }
        const topTypes = [...typeCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6)
        // Country (first 3 chars of icao24 hex → country, complex; fallback: registration prefix)
        const countryCounts = new Map<string, number>()
        for (const f of filtered) {
          const r = (f.registration||'').toUpperCase()
          let cc = '—'
          if (r.startsWith('N')) cc='🇺🇸 US'
          else if (r.startsWith('G-')) cc='🇬🇧 UK'
          else if (r.startsWith('D-')) cc='🇩🇪 DE'
          else if (r.startsWith('F-')) cc='🇫🇷 FR'
          else if (r.startsWith('C-')) cc='🇨🇦 CA'
          else if (r.startsWith('JA')) cc='🇯🇵 JP'
          else if (r.startsWith('VH-')) cc='🇦🇺 AU'
          else if (r.startsWith('VT-')) cc='🇮🇳 IN'
          else if (r.startsWith('EC-')) cc='🇪🇸 ES'
          else if (r.startsWith('EI-')) cc='🇮🇪 IE'
          else if (r.startsWith('OO-')) cc='🇧🇪 BE'
          else if (r.startsWith('PH-')) cc='🇳🇱 NL'
          else if (r.startsWith('LN-')) cc='🇳🇴 NO'
          else if (r.startsWith('SE-')) cc='🇸🇪 SE'
          else if (r.startsWith('A6-')) cc='🇦🇪 AE'
          else if (r.startsWith('B-')) cc='🇨🇳 CN'
          else if (r.startsWith('HL')) cc='🇰🇷 KR'
          else if (r.startsWith('PR-')||r.startsWith('PT-')||r.startsWith('PP-')) cc='🇧🇷 BR'
          else if (r.startsWith('XA-')||r.startsWith('XB-')) cc='🇲🇽 MX'
          if (cc!=='—') countryCounts.set(cc,(countryCounts.get(cc)||0)+1)
        }
        const topCountries = [...countryCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6)
        // Altitude buckets
        const bands = [
          { l: 'GND', min:-1, max:1 },
          { l: '<10k', min:1, max:10000 },
          { l: '10-20k', min:10000, max:20000 },
          { l: '20-30k', min:20000, max:30000 },
          { l: '30-40k', min:30000, max:40000 },
          { l: '40k+', min:40000, max:99999 },
        ].map(b=>{
          const n = filtered.filter(f=> b.l==='GND'? f.ground : (!f.ground && f.altitudeFt>=b.min && f.altitudeFt<b.max)).length
          return { ...b, n }
        })
        const maxBand = Math.max(1, ...bands.map(b=>b.n))
        // Busiest airport in view (by proximity to flights within 25 nm)
        const apCounts = new Map<string, {ap: typeof visibleAirports[0], n:number}>()
        for (const f of filtered.filter(x=>!x.ground)) {
          let best: typeof visibleAirports[0] | null = null
          let bestD = 25 // nm
          for (const ap of visibleAirports) {
            const dLat=(f.lat-ap.lat)*60, dLon=(f.lng-ap.lon)*60*Math.cos(ap.lat*Math.PI/180)
            const d = Math.sqrt(dLat*dLat+dLon*dLon)
            if (d<bestD) { bestD=d; best=ap }
          }
          if (best) {
            const k = best.i
            const cur = apCounts.get(k)||{ap:best,n:0}; cur.n++; apCounts.set(k,cur)
          }
        }
        const topAirports = [...apCounts.values()].sort((a,b)=>b.n-a.n).slice(0,5)
        // Avg speed/alt
        const air = filtered.filter(f=>!f.ground)
        const avgAlt = air.length? Math.round(air.reduce((s,f)=>s+f.altitudeFt,0)/air.length):0
        const avgSpd = air.length? Math.round(air.reduce((s,f)=>s+f.velocityKts,0)/air.length):0
        const heavy = filtered.filter(f=>['A5','A6'].includes(f.category||'')).length
        const heli = filtered.filter(f=>f.category==='A7').length
        const mil = filtered.filter(f=>f.military).length

        const Bar = ({label, n, max, color='bg-sky-500'}:{label:string;n:number;max:number;color?:string}) => (
          <div className="flex items-center gap-2 text-[11px]">
            <span className="w-16 shrink-0 text-slate-400 font-mono">{label}</span>
            <div className="flex-1 h-4 bg-slate-900 rounded overflow-hidden relative">
              <div className={`h-full ${color} transition-all`} style={{width:`${Math.max(2,(n/max)*100)}%`}}/>
              <span className="absolute inset-0 flex items-center justify-end pr-1.5 font-mono text-[10px] text-white drop-shadow">{n}</span>
            </div>
          </div>
        )

        return (
          <aside className="absolute z-20 left-3 md:left-4 top-24 md:top-32 w-[min(94vw,360px)] max-h-[calc(100vh-200px)] overflow-y-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl">
            <header className="sticky top-0 bg-slate-950/95 backdrop-blur-xl border-b border-slate-800 px-3 py-2 flex items-center justify-between">
              <h3 className="text-xs uppercase tracking-widest text-slate-300 font-semibold">Live Statistics</h3>
              <button onClick={()=>setShowStats(false)} className="text-slate-500 hover:text-slate-300 text-sm">✕</button>
            </header>
            <div className="p-3 space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-slate-900/60 rounded-lg p-2"><div className="text-[9px] text-slate-500 uppercase tracking-wider">Heavy</div><div className="text-lg font-bold text-violet-400 font-mono">{heavy}</div></div>
                <div className="bg-slate-900/60 rounded-lg p-2"><div className="text-[9px] text-slate-500 uppercase tracking-wider">Heli</div><div className="text-lg font-bold text-emerald-400 font-mono">{heli}</div></div>
                <div className="bg-slate-900/60 rounded-lg p-2"><div className="text-[9px] text-slate-500 uppercase tracking-wider">Military</div><div className="text-lg font-bold text-orange-400 font-mono">{mil}</div></div>
                <div className="bg-slate-900/60 rounded-lg p-2 col-span-1"><div className="text-[9px] text-slate-500 uppercase tracking-wider">Avg Alt</div><div className="text-base font-bold text-sky-400 font-mono">{(avgAlt/1000).toFixed(1)}k</div></div>
                <div className="bg-slate-900/60 rounded-lg p-2 col-span-2"><div className="text-[9px] text-slate-500 uppercase tracking-wider">Avg Speed</div><div className="text-base font-bold text-amber-400 font-mono">{avgSpd} kt</div></div>
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5 font-semibold">Altitude Distribution</div>
                <div className="space-y-1">{bands.map(b=> <Bar key={b.l} label={b.l} n={b.n} max={maxBand} color={b.l==='GND'?'bg-slate-600':b.l.includes('40')?'bg-violet-500':b.l.includes('30')?'bg-fuchsia-500':b.l.includes('20')?'bg-amber-500':b.l.includes('10')?'bg-emerald-500':'bg-sky-500'} />)}</div>
              </div>

              {topOps.length>0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5 font-semibold">Top Operators</div>
                  <div className="space-y-1">{topOps.map(([op,n])=> <Bar key={op} label={op.slice(0,12)} n={n} max={topOps[0][1]} color="bg-cyan-500" />)}</div>
                </div>
              )}

              {topTypes.length>0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5 font-semibold">Top Aircraft Types</div>
                  <div className="space-y-1">{topTypes.map(([t,n])=> <Bar key={t} label={t} n={n} max={topTypes[0][1]} color="bg-rose-500" />)}</div>
                </div>
              )}

              {topAirports.length>0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5 font-semibold">Busiest Airports (≤25 nm)</div>
                  <div className="space-y-1">
                    {topAirports.map(({ap,n})=>(
                      <button key={ap.i} onClick={()=>mapRef.current?.flyTo({center:[ap.lon,ap.lat],zoom:11,duration:1200})}
                        className="w-full flex items-center gap-2 text-[11px] bg-slate-900/60 hover:bg-slate-800 rounded px-2 py-1.5 transition text-left">
                        <span className="font-mono text-amber-400 font-bold w-12 shrink-0">{ap.a||ap.i}</span>
                        <span className="text-slate-400 flex-1 truncate">{ap.m}</span>
                        <span className="font-mono text-white font-bold">{n}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {topCountries.length>0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5 font-semibold">Country (by registration)</div>
                  <div className="flex flex-wrap gap-1">
                    {topCountries.map(([c,n])=>(
                      <span key={c} className="text-[11px] bg-slate-900/80 border border-slate-800 rounded-full px-2 py-0.5 font-mono">{c} <span className="text-slate-400">{n}</span></span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </aside>
        )
      })()}

      {/* Welcome modal (first visit) */}
      {welcome && (
        <div className="fixed inset-0 z-[60] bg-slate-950/80 backdrop-blur-md grid place-items-center p-4 pointer-events-auto" onClick={() => { localStorage.setItem('ft-onboarded','1'); setWelcome(false) }}>
          <div onClick={(e)=>e.stopPropagation()} className="w-full max-w-md bg-gradient-to-b from-slate-900 to-slate-950 border border-slate-800 rounded-3xl shadow-2xl shadow-sky-900/30 overflow-hidden">
            <div className="relative h-32 bg-gradient-to-br from-sky-500 via-indigo-500 to-violet-600 overflow-hidden">
              <div className="absolute inset-0 opacity-30" style={{backgroundImage:'radial-gradient(circle at 20% 30%, rgba(255,255,255,0.4), transparent 40%), radial-gradient(circle at 80% 70%, rgba(255,255,255,0.3), transparent 40%)'}}/>
              <div className="absolute inset-0 grid place-items-center">
                <div className="size-16 rounded-2xl bg-white/15 backdrop-blur-lg grid place-items-center shadow-2xl">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="white"><path d="M5 16 L19 9 L18 12 L13 13 L14 18 L12 19 L11 14 L6 17 Z"/></svg>
                </div>
              </div>
            </div>
            <div className="p-5 space-y-4">
              <div className="text-center space-y-1">
                <h2 className="text-xl font-bold tracking-tight">Welcome to Flight Tracker</h2>
                <p className="text-sm text-slate-400">25,000+ aircraft. Live, free, no signup.</p>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                {[
                  ['Tap a plane', 'Route, altitude, photo'],
                  ['Drag to rotate', 'Tilt the world in 3D'],
                  ['Search', 'Callsign, type, operator'],
                  ['Watchlist', 'Notify on return'],
                ].map(([t, d]) => (
                  <div key={t} className="bg-slate-900/60 border border-slate-800 rounded-xl p-2.5">
                    <div className="font-semibold text-slate-200">{t}</div>
                    <div className="text-slate-500 mt-0.5 leading-tight">{d}</div>
                  </div>
                ))}
              </div>
              <button onClick={()=>{ localStorage.setItem('ft-onboarded','1'); setWelcome(false) }}
                className="w-full bg-sky-500 hover:bg-sky-400 active:scale-[0.98] text-slate-950 font-bold py-3 rounded-xl transition shadow-lg shadow-sky-900/40">
                Start tracking →
              </button>
              <button onClick={()=>{ localStorage.setItem('ft-onboarded','1'); setWelcome(false); setAbout(true) }}
                className="w-full text-xs text-slate-500 hover:text-slate-300 transition py-1">
                Data sources & privacy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* About / Data / Privacy panel */}
      {about && (
        <div className="fixed inset-0 z-[60] bg-slate-950/80 backdrop-blur-md grid place-items-center p-4 pointer-events-auto" onClick={()=>setAbout(false)}>
          <div onClick={(e)=>e.stopPropagation()} className="w-full max-w-lg max-h-[85vh] overflow-y-auto bg-slate-950 border border-slate-800 rounded-3xl shadow-2xl">
            <header className="sticky top-0 bg-slate-950/95 backdrop-blur border-b border-slate-800 px-5 py-3.5 flex items-center justify-between">
              <h3 className="text-base font-bold">About Flight Tracker</h3>
              <button onClick={()=>setAbout(false)} className="size-7 rounded-lg hover:bg-slate-800 grid place-items-center text-slate-400 text-sm">✕</button>
            </header>
            <div className="p-5 space-y-5 text-sm text-slate-300">
              <p>A free, open, real-time view of every aircraft transmitting ADS-B or Mode-S. No accounts, no ads, no tracking, no paid tier.</p>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">Data sources</div>
                <ul className="space-y-1.5 text-[13px]">
                  <li>• <a className="text-sky-400 hover:underline" href="https://adsb.lol" target="_blank" rel="noopener">adsb.lol</a> — aircraft positions, routes, airport DB (community feed, no API key)</li>
                  <li>• <a className="text-sky-400 hover:underline" href="https://aviationweather.gov" target="_blank" rel="noopener">aviationweather.gov</a> — METAR airport weather (NOAA/AWC, no key)</li>
                  <li>• <a className="text-sky-400 hover:underline" href="https://www.planespotters.net" target="_blank" rel="noopener">planespotters.net</a> — aircraft photos</li>
                  <li>• <a className="text-sky-400 hover:underline" href="https://www.rainviewer.com" target="_blank" rel="noopener">RainViewer</a> — weather radar overlay</li>
                  <li>• <a className="text-sky-400 hover:underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> + <a className="text-sky-400 hover:underline" href="https://carto.com/attribution" target="_blank" rel="noopener">CARTO</a> — basemap</li>
                  <li>• <a className="text-sky-400 hover:underline" href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">AWS Terrain Tiles</a> — 3D elevation</li>
                </ul>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">Privacy</div>
                <p className="text-[13px] leading-relaxed">No servers, no logs, no analytics. Your map preferences and watchlist live only in your browser&apos;s local storage. Aircraft data is fetched directly from public ADS-B feeds — nothing flows through us.</p>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">Limitations</div>
                <p className="text-[13px] leading-relaxed">Coverage depends on community ADS-B receivers. Sparse areas (oceans, polar regions, military airspace) may show fewer aircraft. Position data is delayed 5–30 seconds and should never be used for navigation or safety-critical purposes.</p>
              </div>
              <div className="text-[11px] text-slate-500 pt-3 border-t border-slate-800 flex items-center justify-between flex-wrap gap-2">
                <span>Open source · MIT-licensed</span>
                <a href="https://github.com/Sanjays2402/flight-tracker" target="_blank" rel="noopener" className="text-sky-400 hover:underline">View on GitHub →</a>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* About link in bottom-left, only when nothing selected */}
      {!selected && !about && !welcome && (
        <button onClick={()=>setAbout(true)}
          className="absolute bottom-12 right-3 md:right-4 z-10 text-[10px] uppercase tracking-widest text-slate-500 hover:text-slate-300 bg-slate-950/70 backdrop-blur border border-slate-800 rounded-lg px-2 py-1 transition">
          About · Privacy
        </button>
      )}

      {/* Footer keybind hints — only when nothing selected (avoids ticker collision) */}
      {!selected && (
        <footer className="hidden md:block absolute bottom-12 left-3 md:left-4 z-10 pointer-events-none">
          <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-xl px-2.5 py-1 text-[10px] uppercase tracking-widest text-slate-400 shadow-2xl">
            8s refresh · /=search · esc · t·w·n·h·l·f · drag-rotate · select a plane then CHASE
          </div>
        </footer>
      )}

      {/* Live Leaderboard Ticker — scrolling bottom bar */}
      {(() => {
        const air = filtered.filter(f => !f.ground)
        if (air.length === 0) return null
        const fastest = [...air].sort((a,b)=>b.velocityKts-a.velocityKts)[0]
        const highest = [...air].sort((a,b)=>b.altitudeFt-a.altitudeFt)[0]
        const climbing = [...air].filter(f=>f.vertRate>0).sort((a,b)=>b.vertRate-a.vertRate)[0]
        const descending = [...air].filter(f=>f.vertRate<0).sort((a,b)=>a.vertRate-b.vertRate)[0]
        const emerg = filtered.filter(f=>f.emergency)[0]
        const mil = filtered.filter(f=>f.military)[0]
        const items: Array<{icon:string;label:string;value:string;color:string;flight:any}> = []
        if (emerg) items.push({icon:'🚨', label:'EMERGENCY', value:`${emerg.callsign||emerg.icao} sq${emerg.squawk}`, color:'text-rose-400', flight:emerg})
        items.push({icon:'⚡', label:'FASTEST', value:`${fastest.callsign||fastest.icao} ${Math.round(fastest.velocityKts)}kt`, color:'text-amber-400', flight:fastest})
        items.push({icon:'⬆', label:'HIGHEST', value:`${highest.callsign||highest.icao} FL${Math.round(highest.altitudeFt/100)}`, color:'text-violet-400', flight:highest})
        if (climbing) items.push({icon:'🚀', label:'CLIMB', value:`${climbing.callsign||climbing.icao} +${Math.round(climbing.vertRate)}fpm`, color:'text-emerald-400', flight:climbing})
        if (descending) items.push({icon:'⬇', label:'DESCEND', value:`${descending.callsign||descending.icao} ${Math.round(descending.vertRate)}fpm`, color:'text-sky-400', flight:descending})
        if (mil) items.push({icon:'🛡', label:'MIL', value:`${mil.callsign||mil.icao} ${mil.type||''}`, color:'text-orange-400', flight:mil})
        return (
          <div className="absolute bottom-0 left-0 right-0 z-10 pointer-events-none overflow-hidden">
            <div className="bg-gradient-to-t from-slate-950/95 via-slate-950/80 to-transparent pt-2 pb-2 pl-16 pr-3">
              <div className="pointer-events-auto flex items-center gap-1 overflow-x-auto scrollbar-hide">
                <span className="text-[9px] uppercase tracking-widest text-slate-500 font-mono shrink-0 pr-2">LIVE</span>
                {items.map((it, i) => (
                  <button key={i} onClick={()=>{ setSelected(it.flight); setSelectedAirport(null); mapRef.current?.flyTo({center:[it.flight.lng, it.flight.lat], zoom:9, duration:1200}) }}
                    className="shrink-0 flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 rounded-full px-2.5 py-1 text-[10px] font-mono transition group">
                    <span className="text-sm leading-none">{it.icon}</span>
                    <span className="text-slate-500 uppercase tracking-wider">{it.label}</span>
                    <span className={`${it.color} font-bold`}>{it.value}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )
      })()}

      {/* Emergency squawk toasts */}
      {toasts.length > 0 && (
        <div className="absolute bottom-12 left-3 md:left-4 z-40 flex flex-col-reverse gap-2 max-w-[320px]">
          {toasts.map(t => {
            const isWatch = t.id.startsWith('watch:')
            const label = isWatch ? 'WATCH' : t.sq === '7500' ? 'HIJACK' : t.sq === '7600' ? 'COMMS LOST' : 'EMERGENCY'
            const cls = isWatch
              ? 'bg-sky-950/95 border-sky-500 shadow-sky-900/60 hover:bg-sky-900 text-sky-100 border-2'
              : 'bg-rose-950/95 border-rose-500 shadow-rose-900/60 hover:bg-rose-900 animate-pulse border-2'
            const accent = isWatch ? 'text-sky-300' : 'text-rose-300'
            const sub = isWatch ? 'text-sky-200' : 'text-rose-200'
            const dim = isWatch ? 'text-sky-400/70' : 'text-rose-400/70'
            return (
              <button key={t.id}
                onClick={() => {
                  const f = flights.find(x => x.icao === t.icao)
                  if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, Math.max(mapRef.current?.getZoom() ?? 0, 8)) }
                  setToasts(prev => prev.filter(x => x.id !== t.id))
                }}
                className={`text-left backdrop-blur-xl rounded-xl px-3 py-2 shadow-2xl ${cls}`}
                style={isWatch ? {} : { animationDuration: '1.5s' }}>
                <div className="flex items-baseline gap-2">
                  <span className={`${accent} font-bold text-sm`}>{isWatch ? '★' : '⚠'} {label}</span>
                  {!isWatch && <span className={`${sub} font-mono text-xs`}>SQ {t.sq}</span>}
                </div>
                <div className="font-mono text-xs mt-0.5">{t.cs} · {t.icao.toUpperCase()}</div>
                <div className={`text-[9px] mt-0.5 ${dim}`}>Click to track →</div>
              </button>
            )
          })}
        </div>
      )}

      {/* Help / shortcuts modal */}
      {showHelp && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4" onClick={()=>setShowHelp(false)}>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 max-w-md w-full shadow-2xl" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold tracking-widest uppercase text-sky-400">Keyboard Shortcuts</h3>
              <button onClick={()=>setShowHelp(false)} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              {[['/', 'Focus search'],['Esc','Close panel / search'],['L','Toggle list'],['F','Toggle filters'],['W','Watchlist'],['S','Stats'],['T','Trails'],['H','Heat'],['N','Night'],['3','3D view'],['C','Chase cam'],['M','Map style'],['?','This help']].map(([k,d]) => (
                <div key={k} className="contents">
                  <kbd className="font-mono text-slate-300 bg-slate-800 px-1.5 py-0.5 rounded text-[10px] justify-self-start">{k}</kbd>
                  <span className="text-slate-400">{d}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Map style chooser */}
      {showStyles && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4" onClick={()=>setShowStyles(false)}>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 max-w-sm w-full shadow-2xl" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold tracking-widest uppercase text-sky-400">Map Style</h3>
              <button onClick={()=>setShowStyles(false)} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {([['dark','Dark','#0f172a'],['light','Light','#e2e8f0'],['sat','Satellite','#1e3a2b']] as const).map(([k,l,bg]) => (
                <button key={k} onClick={()=>{ setMapStyle(k); setShowStyles(false) }}
                  className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border ${mapStyle===k?'border-sky-400 ring-2 ring-sky-400/30':'border-slate-800'} hover:border-slate-600`}>
                  <div className="w-full h-12 rounded-md" style={{background:bg}} />
                  <span className={`text-[10px] font-bold uppercase tracking-wider ${mapStyle===k?'text-sky-400':'text-slate-300'}`}>{l}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Emergency log drawer */}
      {showEmergLog && (
        <div className="absolute right-3 top-20 z-40 w-72 bg-slate-900/95 backdrop-blur-xl border border-rose-900/60 rounded-xl shadow-2xl">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
            <span className="text-[10px] font-bold tracking-widest uppercase text-rose-400">Recent Emergencies</span>
            <button onClick={()=>setShowEmergLog(false)} className="text-slate-500 hover:text-slate-200 text-sm leading-none">×</button>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {emergLog.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-slate-500">No emergencies this session.</div>
            ) : emergLog.map((e,i) => (
              <button key={`${e.icao}-${e.t}-${i}`} onClick={()=>{
                const f = flightsRef.current.find(x => x.icao === e.icao)
                if (f) { setSelected(f); flyToLatLng(f.lat, f.lng, 9) } else { flyToLatLng(e.lat, e.lng, 9) }
                setShowEmergLog(false)
              }} className="w-full text-left px-3 py-2 border-b border-slate-800/60 hover:bg-rose-950/30">
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-xs text-rose-300 font-bold">{e.cs || e.icao.toUpperCase()}</span>
                  <span className="font-mono text-[10px] text-slate-500">SQ {e.sq}</span>
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">{new Date(e.t).toLocaleTimeString()}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Floating utility buttons (bottom-right) */}
      <div className="absolute bottom-4 right-4 z-30 flex flex-col gap-1.5">
        <button onClick={()=>setShowStyles(true)} title="Map style (m)"
          className="w-9 h-9 rounded-lg bg-slate-900/90 backdrop-blur border border-slate-800 text-slate-300 hover:text-sky-400 hover:border-sky-700 text-sm font-bold shadow-xl">◐</button>
        <button onClick={()=>setShowEmergLog(v=>!v)} title="Recent emergencies"
          className={`relative w-9 h-9 rounded-lg bg-slate-900/90 backdrop-blur border text-sm font-bold shadow-xl ${emergLog.length?'border-rose-700 text-rose-400':'border-slate-800 text-slate-500'}`}>
          ⚠{emergLog.length>0 && <span className="absolute -top-1 -right-1 bg-rose-500 text-slate-950 text-[9px] font-mono rounded-full w-4 h-4 flex items-center justify-center">{emergLog.length}</span>}
        </button>
        <button onClick={()=>setShowHelp(true)} title="Help (?)"
          className="w-9 h-9 rounded-lg bg-slate-900/90 backdrop-blur border border-slate-800 text-slate-300 hover:text-sky-400 hover:border-sky-700 text-sm font-bold shadow-xl">?</button>
      </div>
    </div>
  )
}

/* ---------- helpers ---------- */

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className={`text-base md:text-lg font-bold tabular-nums leading-tight ${color}`}>{value}</div>
    </div>
  )
}
function Field({ k, v, wide, accent }: { k: string; v: string; wide?: boolean; accent?: string }) {
  return (
    <div className={`bg-slate-900/60 border border-slate-800 rounded-lg p-2 ${wide?'col-span-2':''}`}>
      <div className="text-[9px] uppercase tracking-widest text-slate-500">{k}</div>
      <div className={`text-sm font-mono mt-0.5 ${accent || 'text-slate-100'}`}>{v}</div>
    </div>
  )
}
function Toggle({ on, onClick, label, hint }: { on: boolean; onClick: () => void; label: string; hint?: string }) {
  return (
    <button onClick={onClick} title={hint ? `Press ${hint}` : undefined}
      className={`px-2.5 py-1.5 rounded-xl text-[11px] uppercase tracking-widest font-semibold transition ${on?'bg-sky-500 text-slate-950':'text-slate-300 hover:bg-slate-800'}`}>
      {label}
    </button>
  )
}
function CheckRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2.5 cursor-pointer text-slate-300 text-sm">
      <input type="checkbox" checked={checked} onChange={e=>onChange(e.target.checked)} className="accent-sky-500 size-4" />
      {label}
    </label>
  )
}

function compass(deg: number) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
  return dirs[Math.round(((deg % 360) / 22.5)) % 16]
}
function altColor(ft: number): string {
  if (ft <= 0) return '#64748b'
  if (ft < 5000)   return '#f43f5e'
  if (ft < 15000)  return '#f97316'
  if (ft < 25000)  return '#facc15'
  if (ft < 35000)  return '#22d3ee'
  if (ft < 42000)  return '#38bdf8'
  return '#a78bfa'
}
function speedColor(kt: number): string {
  if (kt < 50) return '#64748b'
  if (kt < 150) return '#f43f5e'
  if (kt < 300) return '#f97316'
  if (kt < 450) return '#facc15'
  if (kt < 550) return '#22d3ee'
  return '#a78bfa'
}
function catColor(cat: string): string {
  if (cat === 'A7') return '#10b981'        // heli
  if (cat === 'B1') return '#a78bfa'        // glider
  if (['A5','A6'].includes(cat)) return '#38bdf8' // heavy/highperf
  if (['A1','A2'].includes(cat)) return '#facc15' // light/small
  if (['A3','A4'].includes(cat)) return '#f97316' // large
  return '#94a3b8'
}
const REG_FLAG: Array<[RegExp, string, string]> = [
  [/^N/, 'US', '\u{1F1FA}\u{1F1F8}'],
  [/^G-/, 'GB', '\u{1F1EC}\u{1F1E7}'],
  [/^D-/, 'DE', '\u{1F1E9}\u{1F1EA}'],
  [/^F-/, 'FR', '\u{1F1EB}\u{1F1F7}'],
  [/^C-/, 'CA', '\u{1F1E8}\u{1F1E6}'],
  [/^JA/, 'JP', '\u{1F1EF}\u{1F1F5}'],
  [/^VH-/, 'AU', '\u{1F1E6}\u{1F1FA}'],
  [/^VT-/, 'IN', '\u{1F1EE}\u{1F1F3}'],
  [/^EC-/, 'ES', '\u{1F1EA}\u{1F1F8}'],
  [/^EI-/, 'IE', '\u{1F1EE}\u{1F1EA}'],
  [/^OO-/, 'BE', '\u{1F1E7}\u{1F1EA}'],
  [/^PH-/, 'NL', '\u{1F1F3}\u{1F1F1}'],
  [/^LN-/, 'NO', '\u{1F1F3}\u{1F1F4}'],
  [/^SE-/, 'SE', '\u{1F1F8}\u{1F1EA}'],
  [/^A6-/, 'AE', '\u{1F1E6}\u{1F1EA}'],
  [/^A7-/, 'QA', '\u{1F1F6}\u{1F1E6}'],
  [/^B-/, 'CN', '\u{1F1E8}\u{1F1F3}'],
  [/^HL/, 'KR', '\u{1F1F0}\u{1F1F7}'],
  [/^(PR-|PT-|PP-)/, 'BR', '\u{1F1E7}\u{1F1F7}'],
  [/^(XA-|XB-|XC-)/, 'MX', '\u{1F1F2}\u{1F1FD}'],
  [/^(I-|I)/, 'IT', '\u{1F1EE}\u{1F1F9}'],
  [/^(OE-)/, 'AT', '\u{1F1E6}\u{1F1F9}'],
  [/^(HB-)/, 'CH', '\u{1F1E8}\u{1F1ED}'],
  [/^(CC-)/, 'CL', '\u{1F1E8}\u{1F1F1}'],
  [/^(LV-)/, 'AR', '\u{1F1E6}\u{1F1F7}'],
  [/^(ZK-)/, 'NZ', '\u{1F1F3}\u{1F1FF}'],
  [/^(ZS-)/, 'ZA', '\u{1F1FF}\u{1F1E6}'],
]
function regFlag(reg: string): { flag: string; code: string } | null {
  const r = (reg || '').toUpperCase()
  for (const [re, code, flag] of REG_FLAG) if (re.test(r)) return { flag, code }
  return null
}
function fmtAlt(ft: number, u: 'ft'|'m'): string {
  if (u === 'm') return `${Math.round(ft * 0.3048).toLocaleString()} m`
  return `${Math.round(ft).toLocaleString()} ft`
}
function fmtSpd(kt: number, u: 'kt'|'mph'|'kmh'): string {
  if (u === 'mph') return `${Math.round(kt * 1.15078)} mph`
  if (u === 'kmh') return `${Math.round(kt * 1.852)} km/h`
  return `${Math.round(kt)} kt`
}
const NOTABLE_RE = /^(AF1|AIRFORCE1|FORCE0?1|SAM\d+|SPAR\d+|RCH\d+|JANET\d*|VENUS\d+|GAF\d+|BLKHWK\d*|MUSTER\d*)$/i
function isNotable(cs: string): boolean { return NOTABLE_RE.test((cs || '').replace(/\s+/g, '')) }

function PlaneLogo() {
  return (
    <div className="size-9 rounded-xl bg-gradient-to-br from-sky-400 to-sky-600 flex items-center justify-center shadow-lg shadow-sky-500/30">
      <svg viewBox="0 0 24 24" width="22" height="22" className="-rotate-12">
        <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 1 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" fill="#0f172a"/>
      </svg>
    </div>
  )
}

/* Day/night terminator polygon (simple Spencer formula). Returns [lat,lng]. */
function terminatorPolygon(date: Date): Array<[number, number]> {
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
  const utHours = date.getUTCHours() + date.getUTCMinutes()/60 + date.getUTCSeconds()/3600
  const gha = (utHours * 15 - 180) * Math.PI / 180
  const pts: Array<[number, number]> = []
  for (let lng = -180; lng <= 180; lng += 2) {
    const H = (lng * Math.PI / 180) + gha
    const lat = Math.atan(-Math.cos(H) / Math.tan(dec)) * 180 / Math.PI
    pts.push([lat, lng])
  }
  const decDeg = dec * 180 / Math.PI
  if (decDeg > 0) {
    pts.push([-90, 180]); pts.push([-90, -180])
  } else {
    pts.push([90, 180]); pts.push([90, -180])
  }
  return pts
}
