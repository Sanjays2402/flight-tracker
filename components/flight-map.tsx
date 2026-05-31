'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { AIRPORTS, AirportPin } from './airports'

/* ============================================================
   Flight Tracker — competing with FR24
   Data: adsb.lol (positions, routes, airports), planespotters.net (photos),
         RainViewer (weather radar), built-in day/night terminator.
   ============================================================ */

interface AcRaw {
  hex: string
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
  baro_rate?: number   // ft/min
  geom_rate?: number
  nav_altitude_mcp?: number
  wd?: number          // wind dir
  ws?: number          // wind speed (kt)
  oat?: number         // outside air temp °C
  squawk?: string
  category?: string
  lat: number
  lon: number
  emergency?: string
  dbFlags?: number     // bit 0 = military
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
  vertRate: number      // ft/min
  navAlt: number        // autopilot target ft (0 = unknown)
  windDir: number
  windKts: number
  oat: number
  track: number
  squawk: string
  category: string
  emergency: boolean
  military: boolean
}
interface Airport {
  icao: string; iata: string; name: string; location: string; lat: number; lon: number; countryiso2: string
}
interface Route {
  airports?: Airport[]   // [origin, ...via, destination]
  airline?: string
}

const REFRESH_MS = 8_000
const TRAIL_MAX = 60  // last N positions per flight

const UA = 'FlightTracker/2.0 (+https://github.com/Sanjays2402/flight-tracker)'

/* category codes from ADS-B (A0-A7, B0-B7) */
const CAT_LABEL: Record<string, string> = {
  A1: 'Light', A2: 'Small', A3: 'Large', A4: 'High-vortex', A5: 'Heavy',
  A6: 'High-perf', A7: 'Rotorcraft', B1: 'Glider', B2: 'Balloon', B4: 'UAV',
  B6: 'UAV', B7: 'Spacecraft',
}

export default function FlightMap() {
  const mapEl = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const planeLayerRef = useRef<L.LayerGroup | null>(null)
  const airportLayerRef = useRef<L.LayerGroup | null>(null)
  const trailLayerRef = useRef<L.LayerGroup | null>(null)
  const routeLayerRef = useRef<L.LayerGroup | null>(null)
  const weatherLayerRef = useRef<L.TileLayer | null>(null)
  const terminatorLayerRef = useRef<L.Polygon | null>(null)
  const markersRef = useRef<Map<string, L.Marker>>(new Map())
  const trailsRef = useRef<Map<string, Array<[number, number, number]>>>(new Map())  // icao -> [lat, lng, ts]
  const routeCacheRef = useRef<Map<string, Route | null>>(new Map())  // callsign -> route
  const photoCacheRef = useRef<Map<string, string | null>>(new Map())  // icao -> photo url

  const [flights, setFlights] = useState<Flight[]>([])
  const [selected, setSelected] = useState<Flight | null>(null)
  const [selectedAirport, setSelectedAirport] = useState<AirportPin | null>(null)
  const [mapZoom, setMapZoom] = useState(4)
  const [mapBounds, setMapBounds] = useState<{n:number,s:number,e:number,w:number} | null>(null)
  const [route, setRoute] = useState<Route | null>(null)
  const [photo, setPhoto] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading'|'live'|'error'>('loading')
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [query, setQuery] = useState('')
  const PREFS_KEY = 'ft-prefs-v1'
  const loadPrefs = (): Record<string, boolean> => {
    if (typeof window === 'undefined') return {}
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') } catch { return {} }
  }
  const prefs = loadPrefs()
  const [showWeather, setShowWeather] = useState(prefs.showWeather ?? false)
  const [showTrails, setShowTrails] = useState(prefs.showTrails ?? true)
  const [showNight, setShowNight] = useState(prefs.showNight ?? true)
  const [showList, setShowList] = useState(prefs.showList ?? false)
  const [showFilters, setShowFilters] = useState(false)
  const [follow, setFollow] = useState(false)
  const [altMin, setAltMin] = useState(0)
  const [altMax, setAltMax] = useState(50000)
  const [onlyMil, setOnlyMil] = useState(false)
  const [onlyEmerg, setOnlyEmerg] = useState(false)
  const [hideGround, setHideGround] = useState(false)
  const [listSort, setListSort] = useState<'callsign'|'alt'|'spd'>('alt')

  /* ---- Init map ---- */
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return

    // Restore from URL
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const lat = parseFloat(params.get('lat') || '40.7')
    const lng = parseFloat(params.get('lng') || '-74')
    const zoom = parseInt(params.get('z') || '6', 10)
    const focusIcao = params.get('icao')

    const map = L.map(mapEl.current, {
      center: [lat, lng], zoom, minZoom: 2, maxZoom: 14,
      worldCopyJump: true, zoomControl: false, attributionControl: true,
      preferCanvas: true,
    })
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> · <a href="https://carto.com/attributions">CARTO</a> · <a href="https://adsb.lol">adsb.lol</a> · <a href="https://www.planespotters.net">planespotters</a> · <a href="https://rainviewer.com">RainViewer</a>',
      subdomains: 'abcd', maxZoom: 19,
    }).addTo(map)
    L.control.zoom({ position: 'bottomright' }).addTo(map)

    trailLayerRef.current = L.layerGroup().addTo(map)
    routeLayerRef.current = L.layerGroup().addTo(map)
    planeLayerRef.current = L.layerGroup().addTo(map)
    airportLayerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map

    // Persist to URL on move + sync bounds/zoom for airport rendering
    const saveUrl = () => {
      const c = map.getCenter()
      const b = map.getBounds()
      const q = new URLSearchParams()
      q.set('lat', c.lat.toFixed(3))
      q.set('lng', c.lng.toFixed(3))
      q.set('z', String(map.getZoom()))
      if (selectedIcaoRef.current) q.set('icao', selectedIcaoRef.current)
      window.history.replaceState(null, '', `#${q.toString()}`)
      setMapZoom(map.getZoom())
      setMapBounds({ n: b.getNorth(), s: b.getSouth(), e: b.getEast(), w: b.getWest() })
    }
    map.on('moveend zoomend', saveUrl)
    saveUrl()  // initial

    // Stash focus icao for first-fetch select
    if (focusIcao) initialFocusRef.current = focusIcao.toLowerCase()

    const fixSize = () => map.invalidateSize()
    requestAnimationFrame(fixSize)
    const t1 = setTimeout(fixSize, 250)
    const t2 = setTimeout(fixSize, 800)
    window.addEventListener('resize', fixSize)
    return () => {
      clearTimeout(t1); clearTimeout(t2)
      window.removeEventListener('resize', fixSize)
      map.remove(); mapRef.current = null
    }
  }, [])

  const selectedIcaoRef = useRef<string | null>(null)
  const initialFocusRef = useRef<string | null>(null)
  useEffect(() => { selectedIcaoRef.current = selected?.icao ?? null
    const q = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    if (selected) q.set('icao', selected.icao); else q.delete('icao')
    window.history.replaceState(null, '', `#${q.toString()}`)
  }, [selected])

  /* ---- Weather radar (RainViewer) ---- */
  useEffect(() => {
    const map = mapRef.current; if (!map) return
    if (showWeather) {
      ;(async () => {
        try {
          const r = await fetch('https://api.rainviewer.com/public/weather-maps.json')
          const j = await r.json() as { host: string; radar: { past: Array<{ time: number; path: string }> } }
          const past = j.radar.past
          const latest = past[past.length - 1]
          const url = `${j.host}${latest.path}/256/{z}/{x}/{y}/2/1_1.png`
          if (weatherLayerRef.current) map.removeLayer(weatherLayerRef.current)
          weatherLayerRef.current = L.tileLayer(url, { opacity: 0.55, zIndex: 200 }).addTo(map)
        } catch (e) { console.error('weather fail', e) }
      })()
    } else if (weatherLayerRef.current) {
      map.removeLayer(weatherLayerRef.current)
      weatherLayerRef.current = null
    }
  }, [showWeather])

  /* ---- Day/Night terminator ---- */
  useEffect(() => {
    const map = mapRef.current; if (!map) return
    const draw = () => {
      if (terminatorLayerRef.current) map.removeLayer(terminatorLayerRef.current)
      if (!showNight) return
      const pts = terminatorPolygon(new Date())
      terminatorLayerRef.current = L.polygon(pts as L.LatLngExpression[], {
        stroke: false, fillColor: '#000010', fillOpacity: 0.35, interactive: false,
      }).addTo(map)
      terminatorLayerRef.current.bringToBack()
    }
    draw()
    const id = setInterval(draw, 5 * 60_000)
    return () => clearInterval(id)
  }, [showNight])

  /* ---- Fetch loop ---- */
  const fetchOnce = useCallback(async () => {
    try {
      const m = mapRef.current
      let lat = 40.7, lon = -74, distNm = 250
      if (m) {
        const c = m.getCenter()
        lat = c.lat; lon = c.lng
        const b = m.getBounds()
        const halfH = (b.getNorth() - b.getSouth()) / 2 * 60
        const halfW = (b.getEast() - b.getWest()) / 2 * 60 * Math.cos(lat * Math.PI / 180)
        distNm = Math.min(250, Math.max(50, Math.ceil(Math.max(halfH, halfW))))
      }
      const target = `https://api.adsb.lol/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${distNm}`
      const url = `https://corsproxy.io/?${encodeURIComponent(target)}`
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { ac?: AcRaw[] }
      const parsed: Flight[] = (json.ac ?? [])
        .filter(a => typeof a.lat === 'number' && typeof a.lon === 'number')
        .map(a => {
          const ground = a.alt_baro === 'ground'
          const altFt = ground ? 0 : (typeof a.alt_geom === 'number' ? a.alt_geom : (typeof a.alt_baro === 'number' ? a.alt_baro : 0))
          const sq = a.squawk || ''
          const emergency = !!a.emergency && a.emergency !== 'none' || sq === '7500' || sq === '7600' || sq === '7700'
          const military = !!(a.desc && /\b(USAF|NAVY|ARMY|MARINE|FORCE|MIL|RAF|JASDF)\b/i.test(a.desc)) ||
                           !!(a.r && /^\d+-\d+/.test(a.r))  // not perfect; will improve via /v2/mil overlay
          return {
            icao: a.hex,
            callsign: (a.flight || '').trim() || a.r || a.hex.toUpperCase(),
            registration: a.r || '—',
            type: a.t || a.desc || '—',
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
      // Update trails
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
      // GC stale trails (not seen in 5 min)
      const seen = new Set(parsed.map(f => f.icao))
      for (const [k, t] of trailsRef.current) {
        const lastTs = t[t.length - 1]?.[2] || 0
        if (!seen.has(k) && now - lastTs > 5 * 60_000) trailsRef.current.delete(k)
      }
      setFlights(parsed)
      setStatus('live')
      setLastUpdate(new Date())

      // First-fetch select-by-icao (URL deep link)
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
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return flights.filter(f => {
      if (hideGround && f.ground) return false
      if (onlyMil && !f.military) return false
      if (onlyEmerg && !f.emergency) return false
      if (!f.ground && (f.altitudeFt < altMin || f.altitudeFt > altMax)) return false
      if (!q) return true
      return f.callsign.toLowerCase().includes(q) || f.registration.toLowerCase().includes(q) ||
             f.type.toLowerCase().includes(q) || f.operator.toLowerCase().includes(q) ||
             f.icao.includes(q) || f.squawk.includes(q)
    })
  }, [flights, query, hideGround, onlyMil, onlyEmerg, altMin, altMax])

  /* ---- Render markers + trails ---- */
  useEffect(() => {
    const layer = planeLayerRef.current; if (!layer) return
    const live = new Set<string>()
    for (const f of filtered) {
      live.add(f.icao)
      const isSel = selected?.icao === f.icao
      const html = planeHtml(f, isSel)
      const icon = L.divIcon({ html, className: '', iconSize: [28, 28], iconAnchor: [14, 14] })
      let marker = markersRef.current.get(f.icao)
      if (!marker) {
        marker = L.marker([f.lat, f.lng], { icon, riseOnHover: true, keyboard: false })
          .on('click', () => setSelected(f))
        marker.addTo(layer)
        markersRef.current.set(f.icao, marker)
      } else {
        marker.setLatLng([f.lat, f.lng])
        marker.setIcon(icon)
      }
    }
    for (const [icao, m] of markersRef.current) {
      if (!live.has(icao)) { layer.removeLayer(m); markersRef.current.delete(icao) }
    }
  }, [filtered, selected])

  // Trails layer
  useEffect(() => {
    const layer = trailLayerRef.current; if (!layer) return
    layer.clearLayers()
    if (!showTrails) return
    // Only draw trails for filtered (visible) flights to keep it light
    for (const f of filtered) {
      const t = trailsRef.current.get(f.icao)
      if (!t || t.length < 2) continue
      const color = altColor(f.altitudeFt)
      const isSel = selected?.icao === f.icao
      L.polyline(t.map(p => [p[0], p[1]] as [number, number]), {
        color, weight: isSel ? 3 : 1.2, opacity: isSel ? 0.95 : 0.55,
        smoothFactor: 1.5, interactive: false,
      }).addTo(layer)
    }
  }, [filtered, selected, showTrails, flights])

  /* ---- Render airport pins (zoom ≥ 5, in viewport) ---- */
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

  useEffect(() => {
    const layer = airportLayerRef.current; if (!layer) return
    layer.clearLayers()
    if (mapZoom < 5) return
    const size = mapZoom < 7 ? 6 : mapZoom < 9 ? 9 : 12
    const fontSize = mapZoom < 7 ? 7 : mapZoom < 9 ? 9 : 11
    for (const ap of visibleAirports) {
      const icon = L.divIcon({
        className: '',
        iconSize: [size, size],
        iconAnchor: [size/2, size/2],
        html: `<div style="
          width:${size}px;height:${size}px;
          border-radius:3px;background:rgba(15,23,42,0.85);
          border:1.5px solid #38bdf8;
          display:flex;align-items:center;justify-content:center;
          font-family:monospace;font-weight:700;font-size:${fontSize}px;
          color:#7dd3fc;line-height:1;cursor:pointer;
          box-shadow:0 0 6px rgba(56,189,248,0.4);
        ">✈</div>`,
      })
      const m = L.marker([ap.lat, ap.lon], { icon, interactive: true, keyboard: false, riseOnHover: true, zIndexOffset: -100 })
        .bindTooltip(`<b>${ap.a}</b> · ${ap.n}<br/><span style="opacity:.6">${ap.m}</span>`, { direction: 'top', offset: [0, -size/2] })
        .on('click', () => { setSelectedAirport(ap); setSelected(null) })
      layer.addLayer(m)
    }
  }, [visibleAirports, mapZoom])

  /* ---- Follow mode ---- */
  useEffect(() => {
    if (!follow || !selected) return
    const f = flights.find(x => x.icao === selected.icao)
    if (f) mapRef.current?.panTo([f.lat, f.lng], { animate: true, duration: 0.4 })
  }, [follow, selected, flights])

  /* ---- Persist UI preferences ---- */
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ showWeather, showTrails, showNight, showList }))
    } catch {}
  }, [showWeather, showTrails, showNight, showList])

  /* ---- Route + photo on selection ---- */
  useEffect(() => {
    setRoute(null); setPhoto(null)
    if (routeLayerRef.current) routeLayerRef.current.clearLayers()
    if (!selected) return
    const flight = selected
    drawRoute(null, flight)  // immediate heading projection while route loads
    // Route via routeset
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
    // Photo via planespotters (fallback to adsbdb's url_photo)
    const ph = photoCacheRef.current.get(flight.icao)
    if (ph !== undefined) setPhoto(ph)
    else {
      ;(async () => {
        try {
          const r = await fetch(`https://api.planespotters.net/pub/photos/hex/${flight.icao}`)
          const j = await r.json() as { photos?: Array<{ thumbnail_large?: { src: string } }> }
          let src = j.photos?.[0]?.thumbnail_large?.src || null
          if (!src) {
            // Try adsbdb fallback
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
  }, [selected])

  const drawRoute = (r: Route | null, flight: Flight) => {
    const layer = routeLayerRef.current; if (!layer) return
    layer.clearLayers()
    // If no route data, project a 10-minute heading line from current position/velocity
    if (!r?.airports?.length) {
      if (!flight.ground && flight.velocityKts > 30) {
        const distNm = (flight.velocityKts / 60) * 10  // 10 min ahead
        const R = 3440.065
        const brg = flight.track * Math.PI/180
        const lat1 = flight.lat * Math.PI/180, lon1 = flight.lng * Math.PI/180
        const dR = distNm / R
        const lat2 = Math.asin(Math.sin(lat1)*Math.cos(dR) + Math.cos(lat1)*Math.sin(dR)*Math.cos(brg))
        const lon2 = lon1 + Math.atan2(Math.sin(brg)*Math.sin(dR)*Math.cos(lat1), Math.cos(dR) - Math.sin(lat1)*Math.sin(lat2))
        L.polyline([[flight.lat, flight.lng], [lat2*180/Math.PI, lon2*180/Math.PI]], {
          color: '#fbbf24', weight: 1.5, dashArray: '4 6', opacity: 0.7, interactive: false,
        }).addTo(layer)
      }
      return
    }
    const aps = r.airports
    const planePos: [number, number] = [flight.lat, flight.lng]
    // Pre-route (origin -> plane), post-route (plane -> dest)
    if (aps.length >= 1) {
      const orig = aps[0]
      L.polyline([[orig.lat, orig.lon], planePos], {
        color: '#64748b', weight: 1.5, dashArray: '6 6', opacity: 0.6, interactive: false,
      }).addTo(layer)
      L.circleMarker([orig.lat, orig.lon], { radius: 5, color: '#10b981', weight: 2, fillOpacity: 0.4 })
        .bindTooltip(`<b>${orig.iata || orig.icao}</b> · ${orig.name}`, { permanent: false, direction: 'top' }).addTo(layer)
    }
    if (aps.length >= 2) {
      const dest = aps[aps.length - 1]
      L.polyline([planePos, [dest.lat, dest.lon]], {
        color: '#38bdf8', weight: 2, opacity: 0.85, interactive: false,
      }).addTo(layer)
      L.circleMarker([dest.lat, dest.lon], { radius: 5, color: '#38bdf8', weight: 2, fillOpacity: 0.5 })
        .bindTooltip(`<b>${dest.iata || dest.icao}</b> · ${dest.name}`, { permanent: false, direction: 'top' }).addTo(layer)
    }
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
      else if (e.key.toLowerCase() === 'l') setShowList(v => !v)
      else if (e.key.toLowerCase() === 'f' && selected) setFollow(v => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

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
      <div ref={mapEl} className="absolute inset-0 z-0" />

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
            <Toggle on={showList} onClick={()=>setShowList(v=>!v)} label="List" hint="L" />
            <Toggle on={showFilters} onClick={()=>setShowFilters(v=>!v)} label="Filter" />
          </div>
          <div className="bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-2xl px-3 py-2 shadow-2xl flex items-center gap-2 w-44 sm:w-60">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-400 shrink-0"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="m20 20-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            <input id="search-input" value={query} onChange={e=>setQuery(e.target.value)}
                   placeholder="Search (press /)"
                   className="bg-transparent text-sm placeholder:text-slate-500 outline-none flex-1 text-slate-100" />
            {query && <button onClick={()=>setQuery('')} className="text-slate-500 hover:text-slate-200 text-xs">✕</button>}
          </div>
        </div>
      </header>

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
            <CheckRow label="Hide on-ground" checked={hideGround} onChange={setHideGround} />
            <CheckRow label="Only military" checked={onlyMil} onChange={setOnlyMil} />
            <CheckRow label="Only emergency squawks (7500/7600/7700)" checked={onlyEmerg} onChange={setOnlyEmerg} />
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
                      onClick={()=>{ setSelected(f); mapRef.current?.panTo([f.lat, f.lng]) }}
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
                <div className="text-2xl font-bold tracking-tight mt-0.5 font-mono">{selected.callsign}</div>
                <div className="text-xs text-slate-400 mt-1">{selected.registration} · {selected.type}</div>
                {selected.operator !== '—' && <div className="text-xs text-slate-500 mt-0.5">{selected.operator}</div>}
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
                return 2*R*Math.asin(Math.sqrt(s))  // nm
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
              <Field k="Altitude"   v={selected.ground ? 'Ground' : `${Math.round(selected.altitudeFt).toLocaleString()} ft`} />
              <Field k="V/Speed"    v={selected.vertRate ? `${selected.vertRate>0?'▲':'▼'} ${Math.abs(Math.round(selected.vertRate)).toLocaleString()} fpm` : '—'}
                     accent={selected.vertRate>200?'text-emerald-400':selected.vertRate<-200?'text-rose-400':undefined} />
              <Field k="Ground Spd" v={`${Math.round(selected.velocityKts)} kt`} />
              <Field k="IAS / Mach" v={selected.ias || selected.mach ? `${selected.ias?Math.round(selected.ias)+' kt':'—'} / ${selected.mach?selected.mach.toFixed(2):'—'}` : '—'} />
              <Field k="Heading"    v={`${Math.round(selected.track)}° ${compass(selected.track)}`} />
              <Field k="Squawk"     v={selected.squawk || '—'} accent={selected.emergency ? 'text-rose-400' : undefined} />
              <Field k="Wind"       v={selected.windKts ? `${Math.round(selected.windDir)}° @ ${Math.round(selected.windKts)} kt` : '—'} />
              <Field k="OAT"        v={Number.isFinite(selected.oat) ? `${Math.round(selected.oat)}°C` : '—'} />
              <Field k="A/P Target" v={selected.navAlt ? `${Math.round(selected.navAlt).toLocaleString()} ft` : '—'} />
              <Field k="ICAO"       v={selected.icao.toUpperCase()} />
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
        // Bearing from airport TO flight
        const bear = (lat1:number,lon1:number,lat2:number,lon2:number) => {
          const toRad=(x:number)=>x*Math.PI/180
          const dLon = toRad(lon2-lon1)
          const y = Math.sin(dLon)*Math.cos(toRad(lat2))
          const x = Math.cos(toRad(lat1))*Math.sin(toRad(lat2)) - Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(dLon)
          return (Math.atan2(y,x)*180/Math.PI + 360) % 360
        }
        const angDiff = (a:number,b:number) => { const d=Math.abs(a-b)%360; return d>180?360-d:d }

        // Derive arrivals (inbound, descending, close) + departures (outbound, climbing, close)
        // Plus known route matches from cache
        const arrivals: {f: Flight; distNm: number; etaMin: number; tag: string}[] = []
        const departures: {f: Flight; distNm: number; tag: string}[] = []
        for (const f of flights) {
          // Cached route match: definitive
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
          // Heuristic: within 80 nm
          const d = hav(f.lat,f.lng,ap.lat,ap.lon)
          if (d > 80 || f.ground) continue
          const bFromAp = bear(ap.lat, ap.lon, f.lat, f.lng)
          // Heading roughly opposite of bearing-from-airport => inbound
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
                  <button key={f.icao} onClick={()=>{ setSelected(f); mapRef.current?.panTo([f.lat,f.lng]) }}
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
                  <button key={f.icao} onClick={()=>{ setSelected(f); mapRef.current?.panTo([f.lat,f.lng]) }}
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

      {/* Footer */}
      <footer className="absolute bottom-3 left-3 md:left-4 z-10 pointer-events-none">
        <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-xl px-2.5 py-1 text-[10px] uppercase tracking-widest text-slate-400 shadow-2xl">
          8s refresh · /=search · esc · t·w·n·l·f
        </div>
      </footer>
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
  // FR24-style altitude ramp
  if (ft <= 0) return '#64748b'
  if (ft < 5000)   return '#f43f5e'  // rose
  if (ft < 15000)  return '#f97316'  // orange
  if (ft < 25000)  return '#facc15'  // yellow
  if (ft < 35000)  return '#22d3ee'  // cyan
  if (ft < 42000)  return '#38bdf8'  // sky
  return '#a78bfa'                   // violet
}
function planeHtml(f: Flight, selected: boolean) {
  const color = f.emergency ? '#f43f5e' : f.ground ? '#64748b' : selected ? '#fbbf24' : altColor(f.altitudeFt)
  const size = selected ? 30 : 24
  const glow = f.emergency ? '0 0 14px rgba(244,63,94,0.9)'
              : selected   ? '0 0 14px rgba(251,191,36,0.9)'
              : `0 0 8px ${color}aa`
  // helicopter (rotorcraft) gets a different shape
  if (f.category === 'A7') {
    return `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;filter:drop-shadow(${glow});">
      <svg viewBox="0 0 24 24" width="${size-4}" height="${size-4}">
        <circle cx="12" cy="12" r="3.5" fill="${color}" stroke="#0f172a" stroke-width="0.8"/>
        <line x1="2" y1="12" x2="22" y2="12" stroke="${color}" stroke-width="1.3"/>
        <line x1="12" y1="2" x2="12" y2="22" stroke="${color}" stroke-width="1.3"/>
      </svg></div>`
  }
  return `
    <div style="width:${size}px;height:${size}px;transform:rotate(${f.track}deg);display:flex;align-items:center;justify-content:center;filter:drop-shadow(${glow});">
      <svg viewBox="0 0 24 24" width="${size-4}" height="${size-4}">
        <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 1 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"
              fill="${color}" stroke="#0f172a" stroke-width="0.7" stroke-linejoin="round"/>
      </svg></div>`
}
function PlaneLogo() {
  return (
    <div className="size-9 rounded-xl bg-gradient-to-br from-sky-400 to-sky-600 flex items-center justify-center shadow-lg shadow-sky-500/30">
      <svg viewBox="0 0 24 24" width="22" height="22" className="-rotate-12">
        <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 1 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" fill="#0f172a"/>
      </svg>
    </div>
  )
}

/* Day/night terminator polygon (simple Spencer formula). */
function terminatorPolygon(date: Date): Array<[number, number]> {
  const julian = date.getTime() / 86400000 + 2440587.5
  const T = (julian - 2451545.0) / 36525
  // Solar declination
  const epsilon = (23.439 - 0.0000004 * (julian - 2451545.0)) * Math.PI / 180
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360
  const M = (357.52911 + T * (35999.05029 - 0.0001537 * T)) * Math.PI / 180
  const C = (1.914602 - T * (0.004817 + 0.000014 * T)) * Math.sin(M)
            + (0.019993 - 0.000101 * T) * Math.sin(2 * M)
            + 0.000289 * Math.sin(3 * M)
  const lambda = (L0 + C) * Math.PI / 180
  const dec = Math.asin(Math.sin(epsilon) * Math.sin(lambda))
  // Greenwich hour angle of sun
  const utHours = date.getUTCHours() + date.getUTCMinutes()/60 + date.getUTCSeconds()/3600
  const gha = (utHours * 15 - 180) * Math.PI / 180
  // For each longitude, compute terminator latitude
  const pts: Array<[number, number]> = []
  for (let lng = -180; lng <= 180; lng += 2) {
    const H = (lng * Math.PI / 180) + gha
    const lat = Math.atan(-Math.cos(H) / Math.tan(dec)) * 180 / Math.PI
    pts.push([lat, lng])
  }
  // Close polygon over the night side. If sun is in N hemisphere (summer), night is southern wrap; else northern.
  const decDeg = dec * 180 / Math.PI
  if (decDeg > 0) {
    pts.push([-90, 180]); pts.push([-90, -180])
  } else {
    pts.push([90, 180]); pts.push([90, -180])
  }
  return pts
}
