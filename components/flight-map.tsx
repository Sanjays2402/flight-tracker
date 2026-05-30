'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'

/* ----- ADS-B aggregator (adsb.lol) -----
   Public, free, no auth. Returns ADS-B Exchange format.
   Radial query: /v2/lat/{lat}/lon/{lon}/dist/{nautical_miles, max 250}
   Routed through corsproxy.io because adsb.lol doesn't set CORS headers.
*/
interface AcRaw {
  hex: string
  flight?: string
  r?: string         // registration
  t?: string         // aircraft type code (e.g. B738)
  desc?: string
  ownOp?: string     // operator
  alt_baro?: number | 'ground'
  alt_geom?: number  // feet
  gs?: number        // ground speed, knots
  track?: number
  lat: number
  lon: number
}
interface Flight {
  icao: string
  callsign: string
  registration: string
  type: string
  operator: string
  lng: number
  lat: number
  altitude: number   // meters
  ground: boolean
  velocity: number   // m/s
  track: number
}

const REFRESH_MS = 10_000

export default function FlightMap() {
  const mapEl = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const markersRef = useRef<Map<string, L.Marker>>(new Map())

  const [flights, setFlights] = useState<Flight[]>([])
  const [selected, setSelected] = useState<Flight | null>(null)
  const [status, setStatus] = useState<'loading'|'live'|'error'>('loading')
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'world'|'us'|'eu'|'asia'>('us')

  /* ---- Init map once ---- */
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return
    const map = L.map(mapEl.current, {
      center: [30, 0], zoom: 3, minZoom: 2, maxZoom: 12,
      worldCopyJump: true, zoomControl: true, attributionControl: true,
      preferCanvas: true,
    })
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a> · Flight data © <a href="https://adsb.lol">adsb.lol</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    // Force size recalc after layout settles (fixes blank tiles when container mounts at 0×0)
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

  /* ---- View presets ---- */
  useEffect(() => {
    const m = mapRef.current; if (!m) return
    const presets: Record<typeof view, [L.LatLngExpression, number]> = {
      world: [[30, 0], 3],
      us:    [[40.7, -74.0], 6],  // NYC area — busy
      eu:    [[51.5, -0.1], 6],   // London area
      asia:  [[35.7, 139.7], 6],  // Tokyo area
    }
    m.flyTo(presets[view][0], presets[view][1], { duration: 0.8 })
  }, [view])

  /* ---- Fetch loop ---- */
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    const fetchOnce = async () => {
      try {
        const m = mapRef.current
        // Center + radius based on current map bounds. adsb.lol max radius = 250 nm.
        let lat = 30, lon = 0, distNm = 250
        if (m) {
          const c = m.getCenter()
          lat = c.lat; lon = c.lng
          const b = m.getBounds()
          // approximate radius in nm: take the larger of half-height/half-width
          const halfH = (b.getNorth() - b.getSouth()) / 2 * 60          // 1 deg lat ≈ 60 nm
          const halfW = (b.getEast() - b.getWest()) / 2 * 60 * Math.cos(lat * Math.PI / 180)
          distNm = Math.min(250, Math.max(50, Math.ceil(Math.max(halfH, halfW))))
        }
        const target = `https://api.adsb.lol/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${distNm}`
        const url = `https://corsproxy.io/?${encodeURIComponent(target)}`
        const res = await fetch(url, { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json() as { ac?: AcRaw[] }
        if (cancelled) return
        const KT_TO_MS = 0.514444
        const FT_TO_M = 0.3048
        const parsed: Flight[] = (json.ac ?? [])
          .filter(a => typeof a.lat === 'number' && typeof a.lon === 'number')
          .map(a => {
            const ground = a.alt_baro === 'ground'
            const altFt = ground ? 0 : (typeof a.alt_geom === 'number' ? a.alt_geom : (typeof a.alt_baro === 'number' ? a.alt_baro : 0))
            return {
              icao: a.hex,
              callsign: (a.flight || '').trim() || a.r || a.hex.toUpperCase(),
              registration: a.r || '—',
              type: a.t || a.desc || '—',
              operator: a.ownOp || '—',
              lng: a.lon,
              lat: a.lat,
              altitude: altFt * FT_TO_M,
              ground,
              velocity: (a.gs ?? 0) * KT_TO_MS,
              track: a.track ?? 0,
            }
          })
        setFlights(parsed)
        setStatus('live')
        setLastUpdate(new Date())
      } catch (e) {
        if (!cancelled) setStatus('error')
        console.error('adsb fetch failed:', e)
      } finally {
        if (!cancelled) timer = setTimeout(fetchOnce, REFRESH_MS)
      }
    }

    fetchOnce()
    // Also refetch on map movement
    const m = mapRef.current
    let moveTimer: ReturnType<typeof setTimeout>
    const onMove = () => {
      clearTimeout(moveTimer)
      moveTimer = setTimeout(fetchOnce, 600)
    }
    m?.on('moveend', onMove)
    return () => { cancelled = true; clearTimeout(timer); clearTimeout(moveTimer); m?.off('moveend', onMove) }
  }, [])

  /* ---- Render markers ---- */
  useEffect(() => {
    const layer = layerRef.current; if (!layer) return
    const live = new Set<string>()
    const q = query.toLowerCase()
    const filtered = flights.filter(f => !q || f.callsign.toLowerCase().includes(q) || f.registration.toLowerCase().includes(q) || f.type.toLowerCase().includes(q) || f.operator.toLowerCase().includes(q) || f.icao.includes(q))

    for (const f of filtered) {
      live.add(f.icao)
      const html = planeHtml(f.track, f.ground, selected?.icao === f.icao)
      const icon = L.divIcon({ html, className: '', iconSize: [26, 26], iconAnchor: [13, 13] })
      let marker = markersRef.current.get(f.icao)
      if (!marker) {
        marker = L.marker([f.lat, f.lng], { icon, riseOnHover: true })
          .on('click', () => setSelected(f))
        marker.addTo(layer)
        markersRef.current.set(f.icao, marker)
      } else {
        marker.setLatLng([f.lat, f.lng])
        marker.setIcon(icon)
      }
    }
    // GC removed flights
    for (const [icao, m] of markersRef.current) {
      if (!live.has(icao)) { layer.removeLayer(m); markersRef.current.delete(icao) }
    }
  }, [flights, selected, query])

  const stats = useMemo(() => {
    const total = flights.length
    const airborne = flights.filter(f => !f.ground).length
    const types = new Set(flights.map(f => f.type).filter(t => t && t !== '—')).size
    const air = flights.filter(f => !f.ground)
    const avgAlt = airborne ? Math.round(air.reduce((s,f)=>s+f.altitude,0) / airborne) : 0
    const avgVel = airborne ? Math.round(air.reduce((s,f)=>s+f.velocity,0) / airborne) : 0
    return { total, airborne, types, avgAlt, avgVel }
  }, [flights])

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <div ref={mapEl} className="absolute inset-0 z-0" />

      {/* Top header */}
      <header className="absolute top-0 inset-x-0 z-20 flex items-start justify-between gap-3 p-4 pointer-events-none">
        <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-2xl px-4 py-3 shadow-2xl flex items-center gap-3">
          <PlaneLogo />
          <div>
            <div className="text-base font-bold tracking-tight leading-none">Flight Tracker</div>
            <div className="flex items-center gap-1.5 mt-1 text-[10px] uppercase tracking-widest">
              <span className={`size-1.5 rounded-full ${status==='live'?'bg-emerald-400 live-dot':status==='error'?'bg-rose-500':'bg-amber-400 live-dot'}`} />
              <span className="text-slate-400">
                {status === 'live' ? 'Live' : status === 'error' ? 'Connection error' : 'Loading'}
                {lastUpdate && status==='live' && ` · ${lastUpdate.toLocaleTimeString()}`}
              </span>
            </div>
          </div>
        </div>

        <div className="pointer-events-auto flex items-center gap-2">
          <div className="hidden md:flex bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-2xl p-1 shadow-2xl">
            {(['world','us','eu','asia'] as const).map(v => (
              <button key={v} onClick={()=>setView(v)}
                      className={`px-3 py-1.5 rounded-xl text-xs uppercase tracking-widest font-medium transition ${view===v?'bg-sky-500 text-slate-950':'text-slate-300 hover:bg-slate-800'}`}>
                {v}
              </button>
            ))}
          </div>
          <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-2xl px-3 py-2 shadow-2xl flex items-center gap-2 w-64">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-400 shrink-0"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="m20 20-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            <input value={query} onChange={e=>setQuery(e.target.value)}
                   placeholder="Search callsign, reg, type, op…"
                   className="bg-transparent text-sm placeholder:text-slate-500 outline-none flex-1 text-slate-100" />
            {query && (
              <button onClick={()=>setQuery('')} className="text-slate-500 hover:text-slate-200 text-xs">✕</button>
            )}
          </div>
        </div>
      </header>

      {/* Stats strip */}
      <div className="absolute top-24 md:top-20 left-4 z-20 pointer-events-none">
        <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-2xl p-3 shadow-2xl grid grid-cols-2 md:grid-cols-5 gap-3 w-[min(96vw,640px)]">
          <Stat label="Visible" value={stats.total.toLocaleString()} color="text-sky-400" />
          <Stat label="Airborne" value={stats.airborne.toLocaleString()} color="text-emerald-400" />
          <Stat label="Aircraft types" value={stats.types.toLocaleString()} color="text-amber-400" />
          <Stat label="Avg alt" value={`${(stats.avgAlt/1000).toFixed(1)} km`} color="text-violet-400" />
          <Stat label="Avg speed" value={`${Math.round(stats.avgVel*3.6)} km/h`} color="text-rose-400" />
        </div>
      </div>

      {/* Selected flight panel */}
      {selected && (
        <aside className="absolute right-4 bottom-20 md:bottom-4 z-20 w-[min(94vw,360px)] bg-slate-950/90 backdrop-blur-xl border border-slate-800 rounded-2xl p-5 shadow-2xl">
          <button onClick={()=>setSelected(null)} className="absolute top-3 right-3 size-7 rounded-lg hover:bg-slate-800 flex items-center justify-center text-slate-400 hover:text-slate-100 transition">✕</button>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Selected flight</div>
          <div className="text-2xl font-bold tracking-tight mt-1 font-mono">{selected.callsign}</div>
          <div className="text-xs text-slate-400 mt-1">{selected.registration} · {selected.type} · ICAO {selected.icao.toUpperCase()}</div>
          {selected.operator !== '—' && <div className="text-xs text-slate-500 mt-0.5">{selected.operator}</div>}
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <Field k="Altitude"   v={selected.ground ? 'On ground' : `${(selected.altitude/1000).toFixed(2)} km`} />
            <Field k="Speed"      v={`${Math.round(selected.velocity*3.6)} km/h`} />
            <Field k="Heading"    v={`${Math.round(selected.track)}° ${compass(selected.track)}`} />
            <Field k="Position"   v={`${selected.lat.toFixed(3)}, ${selected.lng.toFixed(3)}`} />
          </div>
          <a href={`https://globe.adsb.lol/?icao=${selected.icao}`}
             target="_blank" rel="noreferrer"
             className="mt-4 block text-center text-xs uppercase tracking-widest bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold rounded-xl py-2.5 transition">
            View on globe.adsb.lol →
          </a>
        </aside>
      )}

      {/* Footer */}
      <footer className="absolute bottom-3 left-4 z-20 pointer-events-none">
        <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-slate-800 rounded-xl px-3 py-1.5 text-[10px] uppercase tracking-widest text-slate-400 shadow-2xl">
          Updates every 10s · Data <a href="https://adsb.lol" target="_blank" rel="noreferrer" className="text-sky-400 hover:text-sky-300">adsb.lol</a>
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
      <div className={`text-lg font-bold tabular-nums leading-tight ${color}`}>{value}</div>
    </div>
  )
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-2.5">
      <div className="text-[9px] uppercase tracking-widest text-slate-500">{k}</div>
      <div className="text-sm font-mono text-slate-100 mt-0.5">{v}</div>
    </div>
  )
}

function compass(deg: number) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
  return dirs[Math.round(((deg % 360) / 22.5)) % 16]
}

function planeHtml(track: number, ground: boolean, selected: boolean) {
  const color = ground ? '#64748b' : selected ? '#fbbf24' : '#38bdf8'
  const glow  = ground ? 'none' : selected ? '0 0 12px rgba(251,191,36,0.85)' : '0 0 10px rgba(56,189,248,0.65)'
  return `
    <div style="width:26px;height:26px;transform:rotate(${track}deg);display:flex;align-items:center;justify-content:center;filter:drop-shadow(${glow});">
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 1 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"
              fill="${color}" stroke="#0f172a" stroke-width="0.6" stroke-linejoin="round"/>
      </svg>
    </div>`
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
