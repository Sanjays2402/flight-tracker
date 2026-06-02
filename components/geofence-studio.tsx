'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Geofence Studio
   -----------------------------------------------------------
   Multi-polygon zone monitor. The user can draw any number of
   named, colored polygonal "zones" on the map (click to drop
   vertices, double-click or hit FINISH to close), and Geofence
   Studio continuously classifies every airborne aircraft as
   INSIDE or OUTSIDE each zone using a ray-casting point-in-
   polygon test in a local-tangent ENU plane.

   It maintains per-aircraft / per-zone state across ticks so
   that ENTRY and EXIT transitions emit timestamped events into
   a rolling activity log, with dwell-time accounting for any
   aircraft currently inside. The side panel has three modes:

     * ZONES — manage zones: rename, recolor, mute, fly-to,
       delete; per-zone live stats (inside count, mean FL,
       mean GS, top operator, area km^2).
     * INSIDE — flat list of every aircraft currently inside
       ANY non-muted zone, with zone-color stripe, dwell time,
       callsign / type / operator / FL / kt / track.
     * EVENTS — rolling log of ENTRY / EXIT events (with their
       UTC timestamp, zone, callsign, type, FL, kt).

   Altitude filter (FL slider) and a "min dwell" slider keep
   the inside-list focused on persistent intruders.

   Useful as: airshow box monitor, restricted-airspace alerter,
   noise-abatement zone tripwire, custom TMA / airport-overlay,
   weather-avoidance area validator, ATC sector handoff zone.
   ============================================================ */

export interface GfFlight {
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
  flights: GfFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

interface Zone {
  id: string
  name: string
  color: string
  pts: Array<{ lat: number; lng: number }>
  closed: boolean
  muted: boolean
  createdAt: number
}

type EventKind = 'ENTRY' | 'EXIT'
interface GfEvent {
  id: string
  kind: EventKind
  zoneId: string
  zoneName: string
  zoneColor: string
  icao: string
  callsign: string
  type?: string
  operator?: string
  altitudeFt: number
  velocityKts: number
  ts: number
}

const R_NM = 3440.065
const RAD = Math.PI / 180

const PALETTE = [
  '#fbbf24', '#22d3ee', '#a78bfa', '#f472b6',
  '#34d399', '#fb7185', '#60a5fa', '#facc15',
]

const SRC_FILL = 'gf-fill-src'
const LYR_FILL = 'gf-fill-lyr'
const LYR_LINE = 'gf-line-lyr'
const SRC_PEND = 'gf-pend-src'
const LYR_PEND_LINE = 'gf-pend-line-lyr'
const LYR_PEND_PTS = 'gf-pend-pts-lyr'
const SRC_LABEL = 'gf-label-src'
const LYR_LABEL = 'gf-label-lyr'

function uid() { return Math.random().toString(36).slice(2, 10) }

function fmtDwell(s: number) {
  if (!isFinite(s) || s < 0) return '—'
  const m = Math.floor(s / 60), ss = Math.floor(s % 60)
  if (m >= 60) {
    const h = Math.floor(m / 60), mm = m % 60
    return `${h}h${String(mm).padStart(2, '0')}`
  }
  return `${m}:${String(ss).padStart(2, '0')}`
}
function fmtClock(ts: number) {
  const d = new Date(ts)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}Z`
}

/* Local-tangent ENU projection centered at the polygon centroid. */
function makeENU(lat0: number, lng0: number) {
  const cosLat = Math.cos(lat0 * RAD)
  return (lat: number, lng: number): [number, number] => {
    const dx = ((lng - lng0 + 540) % 360 - 180) * 60 * cosLat
    const dy = (lat - lat0) * 60
    return [dx, dy]
  }
}

/* Ray-casting point-in-polygon for closed rings (in any planar coords). */
function pointInPoly(x: number, y: number, ring: Array<[number, number]>) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    const intersect = ((yi > y) !== (yj > y))
      && (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

/* Shoelace area (km^2) using ENU coords in nm -> km. */
function polyAreaKm2(ringNm: Array<[number, number]>) {
  let s = 0
  for (let i = 0, j = ringNm.length - 1; i < ringNm.length; j = i++) {
    s += (ringNm[j][0] + ringNm[i][0]) * (ringNm[j][1] - ringNm[i][1])
  }
  const nm2 = Math.abs(s / 2)
  return nm2 * 3.4299  // 1 nm^2 ≈ 3.4299 km^2
}

function centroid(pts: Array<{ lat: number; lng: number }>) {
  let sx = 0, sy = 0
  for (const p of pts) { sx += p.lng; sy += p.lat }
  return { lat: sy / pts.length, lng: sx / pts.length }
}

export default function GeofenceStudio({ map, flights, onClose, onFly }: Props) {
  const [zones, setZones] = useState<Zone[]>([])
  const [pending, setPending] = useState<Zone | null>(null)
  const [drawMode, setDrawMode] = useState<boolean>(false)
  const [tab, setTab] = useState<'ZONES' | 'INSIDE' | 'EVENTS'>('ZONES')
  const [minFL, setMinFL] = useState<number>(0)
  const [minDwellSec, setMinDwellSec] = useState<number>(0)
  const [query, setQuery] = useState<string>('')
  const [events, setEvents] = useState<GfEvent[]>([])
  const [renaming, setRenaming] = useState<string | null>(null)

  const installedRef = useRef<boolean>(false)
  const clickRef = useRef<((e: maplibregl.MapMouseEvent) => void) | null>(null)
  const dblRef = useRef<(() => void) | null>(null)
  /* insideRef[icao][zoneId] = entry-timestamp (ms) */
  const insideRef = useRef<Map<string, Map<string, number>>>(new Map())

  /* Install MapLibre layers once. */
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        const empty = { type: 'FeatureCollection' as const, features: [] }
        if (!map.getSource(SRC_FILL)) map.addSource(SRC_FILL, { type: 'geojson', data: empty })
        if (!map.getSource(SRC_PEND)) map.addSource(SRC_PEND, { type: 'geojson', data: empty })
        if (!map.getSource(SRC_LABEL)) map.addSource(SRC_LABEL, { type: 'geojson', data: empty })
        if (!map.getLayer(LYR_FILL)) map.addLayer({
          id: LYR_FILL, type: 'fill', source: SRC_FILL,
          paint: {
            'fill-color': ['get', 'color'],
            'fill-opacity': ['case', ['get', 'muted'], 0.04, 0.14],
          }
        })
        if (!map.getLayer(LYR_LINE)) map.addLayer({
          id: LYR_LINE, type: 'line', source: SRC_FILL,
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 2.2,
            'line-opacity': ['case', ['get', 'muted'], 0.35, 0.95],
          }
        })
        if (!map.getLayer(LYR_PEND_LINE)) map.addLayer({
          id: LYR_PEND_LINE, type: 'line', source: SRC_PEND,
          paint: {
            'line-color': '#fbbf24', 'line-width': 1.8,
            'line-dasharray': [2, 2], 'line-opacity': 0.85,
          }
        })
        if (!map.getLayer(LYR_PEND_PTS)) map.addLayer({
          id: LYR_PEND_PTS, type: 'circle', source: SRC_PEND,
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-radius': 5,
            'circle-color': '#fbbf24',
            'circle-stroke-color': '#0f172a',
            'circle-stroke-width': 2,
          }
        })
        if (!map.getLayer(LYR_LABEL)) {
          try {
            map.addLayer({
              id: LYR_LABEL, type: 'symbol', source: SRC_LABEL,
              layout: {
                'text-field': ['get', 'label'],
                'text-size': 11,
                'text-font': ['Noto Sans Regular'],
                'text-allow-overlap': true,
              },
              paint: {
                'text-color': ['get', 'color'],
                'text-halo-color': '#0f172a', 'text-halo-width': 1.4,
              }
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
        for (const l of [LYR_LABEL, LYR_PEND_PTS, LYR_PEND_LINE, LYR_LINE, LYR_FILL]) {
          if (map.getLayer(l)) map.removeLayer(l)
        }
        for (const s of [SRC_LABEL, SRC_PEND, SRC_FILL]) {
          if (map.getSource(s)) map.removeSource(s)
        }
      } catch {}
    }
  }, [map])

  /* Click handlers for draw mode. */
  useEffect(() => {
    if (!map || !drawMode) return
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const p = { lat: e.lngLat.lat, lng: e.lngLat.lng }
      setPending((cur) => {
        if (!cur) {
          const idx = zones.length % PALETTE.length
          return {
            id: uid(),
            name: `Zone ${zones.length + 1}`,
            color: PALETTE[idx],
            pts: [p], closed: false, muted: false,
            createdAt: Date.now(),
          }
        }
        return { ...cur, pts: [...cur.pts, p] }
      })
    }
    const onDbl = () => {
      // Will be handled by the finish flow below via state effect.
      finishDrawing()
    }
    clickRef.current = onClick
    dblRef.current = onDbl
    map.on('click', onClick)
    map.on('dblclick', onDbl)
    map.getCanvas().style.cursor = 'crosshair'
    return () => {
      try {
        if (clickRef.current) map.off('click', clickRef.current)
        if (dblRef.current) map.off('dblclick', dblRef.current)
        map.getCanvas().style.cursor = ''
      } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, drawMode, zones.length])

  function finishDrawing() {
    setPending((cur) => {
      if (!cur || cur.pts.length < 3) return cur
      setZones((zs) => [...zs, { ...cur, closed: true }])
      return null
    })
    setDrawMode(false)
  }
  function cancelDrawing() {
    setPending(null); setDrawMode(false)
  }

  /* Push zone + pending geometry to MapLibre. */
  useEffect(() => {
    if (!map) return
    try {
      const fillFeats: GeoJSON.Feature[] = []
      const labelFeats: GeoJSON.Feature[] = []
      for (const z of zones) {
        if (z.pts.length < 3) continue
        const ring = z.pts.map(p => [p.lng, p.lat] as [number, number])
        ring.push(ring[0])
        fillFeats.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [ring] },
          properties: { color: z.color, muted: !!z.muted, id: z.id }
        })
        const c = centroid(z.pts)
        labelFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
          properties: { label: z.name, color: z.color }
        })
      }
      ;(map.getSource(SRC_FILL) as maplibregl.GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection', features: fillFeats
      })
      ;(map.getSource(SRC_LABEL) as maplibregl.GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection', features: labelFeats
      })

      const pf: GeoJSON.Feature[] = []
      if (pending && pending.pts.length > 0) {
        const coords = pending.pts.map(p => [p.lng, p.lat] as [number, number])
        if (coords.length >= 2) {
          pf.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: coords },
            properties: {}
          })
        }
        for (const p of pending.pts) {
          pf.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
            properties: {}
          })
        }
      }
      ;(map.getSource(SRC_PEND) as maplibregl.GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection', features: pf
      })
    } catch {}
  }, [map, zones, pending])

  /* Per-zone membership map (cached per render). */
  const membership = useMemo(() => {
    const m = new Map<string, { rings: Array<[number, number]>; proj: (lat: number, lng: number) => [number, number]; areaKm2: number }>()
    for (const z of zones) {
      if (z.pts.length < 3) continue
      const c = centroid(z.pts)
      const proj = makeENU(c.lat, c.lng)
      const ring = z.pts.map(p => proj(p.lat, p.lng))
      m.set(z.id, { rings: ring, proj, areaKm2: polyAreaKm2(ring) })
    }
    return m
  }, [zones])

  /* Classify every flight against every zone; detect ENTRY/EXIT. */
  useEffect(() => {
    if (zones.length === 0) return
    const now = Date.now()
    const inside = insideRef.current
    const newEvents: GfEvent[] = []
    const liveIcao = new Set<string>()
    for (const f of flights) {
      if (f.ground) continue
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      liveIcao.add(f.icao)
      let rec = inside.get(f.icao)
      for (const z of zones) {
        const mb = membership.get(z.id)
        if (!mb) continue
        const [x, y] = mb.proj(f.lat, f.lng)
        const isIn = pointInPoly(x, y, mb.rings)
        const wasIn = rec?.has(z.id) ?? false
        if (isIn && !wasIn) {
          if (!rec) { rec = new Map(); inside.set(f.icao, rec) }
          rec.set(z.id, now)
          if (!z.muted) {
            newEvents.push({
              id: uid(), kind: 'ENTRY',
              zoneId: z.id, zoneName: z.name, zoneColor: z.color,
              icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator,
              altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, ts: now,
            })
          }
        } else if (!isIn && wasIn) {
          rec!.delete(z.id)
          if (rec!.size === 0) inside.delete(f.icao)
          if (!z.muted) {
            newEvents.push({
              id: uid(), kind: 'EXIT',
              zoneId: z.id, zoneName: z.name, zoneColor: z.color,
              icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator,
              altitudeFt: f.altitudeFt, velocityKts: f.velocityKts, ts: now,
            })
          }
        }
      }
    }
    /* GC: drop stale icaos no longer in feed. */
    for (const icao of Array.from(inside.keys())) {
      if (!liveIcao.has(icao)) inside.delete(icao)
    }
    if (newEvents.length) {
      setEvents((prev) => [...newEvents, ...prev].slice(0, 200))
    }
  }, [flights, zones, membership])

  /* Per-zone live stats. */
  const zoneStats = useMemo(() => {
    const inside = insideRef.current
    const stat = new Map<string, {
      count: number; meanFL: number; meanKt: number; topOp: string
    }>()
    for (const z of zones) stat.set(z.id, { count: 0, meanFL: 0, meanKt: 0, topOp: '' })
    const opTally = new Map<string, Map<string, number>>()
    for (const [icao, zmap] of inside) {
      const f = flights.find(x => x.icao === icao)
      if (!f) continue
      for (const zid of zmap.keys()) {
        const s = stat.get(zid); if (!s) continue
        s.count++; s.meanFL += f.altitudeFt; s.meanKt += f.velocityKts
        if (f.operator) {
          let t = opTally.get(zid); if (!t) { t = new Map(); opTally.set(zid, t) }
          t.set(f.operator, (t.get(f.operator) || 0) + 1)
        }
      }
    }
    for (const [zid, s] of stat) {
      if (s.count) { s.meanFL = s.meanFL / s.count / 100; s.meanKt = s.meanKt / s.count }
      const t = opTally.get(zid)
      if (t) {
        let best = '', bv = 0
        for (const [k, v] of t) if (v > bv) { bv = v; best = k }
        s.topOp = best
      }
    }
    return stat
  }, [flights, zones, events])

  /* Inside-list (flat across all non-muted zones, with dwell). */
  const insideList = useMemo(() => {
    const inside = insideRef.current
    const now = Date.now()
    const out: Array<{
      f: GfFlight; zoneId: string; zoneName: string; zoneColor: string; dwellSec: number
    }> = []
    const q = query.trim().toUpperCase()
    for (const [icao, zmap] of inside) {
      const f = flights.find(x => x.icao === icao); if (!f) continue
      if (f.altitudeFt < minFL * 100) continue
      for (const [zid, t0] of zmap) {
        const z = zones.find(zz => zz.id === zid); if (!z || z.muted) continue
        const d = (now - t0) / 1000
        if (d < minDwellSec) continue
        if (q) {
          const hay = `${f.callsign} ${f.icao} ${f.type || ''} ${f.operator || ''} ${z.name}`.toUpperCase()
          if (!hay.includes(q)) continue
        }
        out.push({ f, zoneId: zid, zoneName: z.name, zoneColor: z.color, dwellSec: d })
      }
    }
    return out.sort((a, b) => b.dwellSec - a.dwellSec)
  }, [flights, zones, events, query, minFL, minDwellSec])

  const filteredEvents = useMemo(() => {
    const q = query.trim().toUpperCase()
    return events.filter(ev => {
      if (!q) return true
      const hay = `${ev.callsign} ${ev.icao} ${ev.type || ''} ${ev.operator || ''} ${ev.zoneName}`.toUpperCase()
      return hay.includes(q)
    })
  }, [events, query])

  const totalInside = insideList.length
  const totalZones = zones.length
  const mutedCount = zones.filter(z => z.muted).length

  function flyToZone(z: Zone) {
    if (!map || z.pts.length === 0) return
    try {
      const lats = z.pts.map(p => p.lat), lngs = z.pts.map(p => p.lng)
      const sw: [number, number] = [Math.min(...lngs), Math.min(...lats)]
      const ne: [number, number] = [Math.max(...lngs), Math.max(...lats)]
      map.fitBounds([sw, ne], { padding: 80, duration: 700, maxZoom: 11 })
    } catch {}
  }
  function delZone(id: string) {
    setZones(zs => zs.filter(z => z.id !== id))
    insideRef.current.forEach(m => m.delete(id))
  }
  function setZoneField<K extends keyof Zone>(id: string, k: K, v: Zone[K]) {
    setZones(zs => zs.map(z => z.id === id ? { ...z, [k]: v } : z))
  }

  return (
    <div className="pointer-events-auto absolute top-3 right-3 z-30 w-[380px] max-h-[88vh] overflow-hidden rounded-2xl border border-amber-500/30 bg-slate-950/85 backdrop-blur shadow-2xl flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-amber-300 font-semibold tracking-wide text-sm">GEOFENCE STUDIO</span>
          <span className="text-[10px] text-slate-400 uppercase">zones · entries · dwell</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-xs px-2 py-0.5 rounded hover:bg-slate-800">close</button>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 grid grid-cols-3 gap-1 text-center text-[11px]">
        {(['ZONES', 'INSIDE', 'EVENTS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded px-1 py-1 ${tab === t ? 'bg-amber-500/20 text-amber-200' : 'bg-slate-900 text-slate-300 hover:bg-slate-800'}`}>
            {t} <span className="text-slate-100 font-semibold">{t === 'ZONES' ? totalZones : t === 'INSIDE' ? totalInside : events.length}</span>
          </button>
        ))}
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="flex items-center gap-2">
          {!drawMode && !pending && (
            <button onClick={() => setDrawMode(true)}
              className="text-[11px] px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 font-medium">
              + new zone
            </button>
          )}
          {drawMode && (
            <>
              <button onClick={finishDrawing} disabled={!pending || pending.pts.length < 3}
                className="text-[11px] px-2 py-1 rounded bg-emerald-500/25 hover:bg-emerald-500/35 text-emerald-100 font-medium disabled:opacity-40">
                finish ({pending?.pts.length ?? 0})
              </button>
              <button onClick={cancelDrawing}
                className="text-[11px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200">
                cancel
              </button>
            </>
          )}
          <span className="ml-auto text-[10px] text-slate-400">
            {mutedCount > 0 ? `${mutedCount} muted` : 'click map to draw'}
          </span>
        </div>
        {tab !== 'ZONES' && (
          <>
            <div>
              <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                <span>min FL</span><span className="text-slate-200 tabular-nums">FL{String(minFL).padStart(3,'0')}</span>
              </div>
              <input type="range" min={0} max={450} step={10} value={minFL}
                onChange={e => setMinFL(parseInt(e.target.value, 10))}
                className="w-full accent-amber-400" />
            </div>
            {tab === 'INSIDE' && (
              <div>
                <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                  <span>min dwell</span>
                  <span className="text-slate-200 tabular-nums">
                    {minDwellSec === 0 ? 'any' : `${minDwellSec}s`}
                  </span>
                </div>
                <input type="range" min={0} max={300} step={10} value={minDwellSec}
                  onChange={e => setMinDwellSec(parseInt(e.target.value, 10))}
                  className="w-full accent-amber-400" />
              </div>
            )}
            <input
              type="text" value={query} onChange={e => setQuery(e.target.value)}
              placeholder={tab === 'INSIDE' ? 'search callsign / type / zone' : 'search events'}
              className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-500 outline-none focus:border-amber-500/60"
            />
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'ZONES' && (
          zones.length === 0 && !pending ? (
            <div className="text-center text-[11px] text-slate-400 py-10 px-6 leading-relaxed">
              Hit <span className="text-amber-300 font-medium">+ new zone</span>, then click the map to drop vertices. Double-click or hit FINISH to close the polygon.
            </div>
          ) : (
            <ul className="divide-y divide-slate-800/70">
              {zones.map((z) => {
                const s = zoneStats.get(z.id)
                const mb = membership.get(z.id)
                const area = mb ? mb.areaKm2 : 0
                return (
                  <li key={z.id} className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: z.color }} />
                      {renaming === z.id ? (
                        <input
                          autoFocus
                          defaultValue={z.name}
                          onBlur={(e) => { setZoneField(z.id, 'name', e.target.value || z.name); setRenaming(null) }}
                          onKeyDown={(e) => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur() } }}
                          className="flex-1 bg-slate-900 border border-amber-500/40 rounded px-1.5 py-0.5 text-[12px] text-slate-100 outline-none"
                        />
                      ) : (
                        <button onClick={() => setRenaming(z.id)}
                          className="flex-1 text-left text-[12px] font-semibold text-slate-100 truncate hover:text-amber-200">
                          {z.name}
                        </button>
                      )}
                      <span className="text-[10px] text-slate-400 tabular-nums">{z.pts.length}v</span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-[10px] text-slate-400 tabular-nums">
                      <span>inside <span className="text-slate-100 font-semibold">{s?.count ?? 0}</span></span>
                      <span>FL{(s?.meanFL ?? 0).toFixed(0)}</span>
                      <span>{(s?.meanKt ?? 0).toFixed(0)}kt</span>
                      <span>{area.toFixed(area < 100 ? 1 : 0)}km²</span>
                      {s?.topOp && <span className="truncate text-slate-500">{s.topOp}</span>}
                    </div>
                    <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                      <button onClick={() => flyToZone(z)}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200">fly</button>
                      <button onClick={() => setZoneField(z.id, 'muted', !z.muted)}
                        className={`text-[10px] px-1.5 py-0.5 rounded ${z.muted ? 'bg-rose-500/20 text-rose-200' : 'bg-slate-800 text-slate-200 hover:bg-slate-700'}`}>
                        {z.muted ? 'muted' : 'mute'}
                      </button>
                      <div className="flex items-center gap-0.5 ml-1">
                        {PALETTE.map(c => (
                          <button key={c} onClick={() => setZoneField(z.id, 'color', c)}
                            className={`w-3 h-3 rounded-sm border ${z.color === c ? 'border-slate-100' : 'border-slate-700'}`}
                            style={{ background: c }} />
                        ))}
                      </div>
                      <button onClick={() => delZone(z.id)}
                        className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 hover:bg-rose-500/30 text-rose-200">delete</button>
                    </div>
                  </li>
                )
              })}
              {pending && (
                <li className="px-3 py-2 bg-amber-500/5">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-sm animate-pulse" style={{ background: pending.color }} />
                    <span className="flex-1 text-[12px] font-semibold text-amber-200 truncate">{pending.name} (drawing)</span>
                    <span className="text-[10px] text-slate-400 tabular-nums">{pending.pts.length}v</span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-1">
                    {pending.pts.length < 3
                      ? `Need ${3 - pending.pts.length} more vertex${pending.pts.length === 2 ? '' : 'es'}…`
                      : 'Double-click map or hit FINISH to close.'}
                  </div>
                </li>
              )}
            </ul>
          )
        )}

        {tab === 'INSIDE' && (
          insideList.length === 0 ? (
            <div className="text-center text-[11px] text-slate-500 py-10 px-4">
              No aircraft currently inside any active zone.
            </div>
          ) : (
            <ul className="divide-y divide-slate-800/70">
              {insideList.slice(0, 100).map((r, idx) => (
                <li key={`${r.f.icao}-${r.zoneId}-${idx}`}
                  onClick={() => onFly(r.f.icao)}
                  className="px-3 py-2 hover:bg-slate-900/70 cursor-pointer">
                  <div className="flex items-start gap-2">
                    <div className="w-1 self-stretch rounded" style={{ background: r.zoneColor }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[12px] font-semibold text-slate-100 truncate">{r.f.callsign || r.f.icao}</span>
                        <span className="text-[10px] uppercase truncate" style={{ color: r.zoneColor }}>{r.zoneName}</span>
                        <span className="ml-auto text-[11px] font-mono tabular-nums text-amber-200">{fmtDwell(r.dwellSec)}</span>
                      </div>
                      <div className="text-[10px] text-slate-400 mt-0.5 truncate">
                        {r.f.type || '—'}{r.f.operator ? ` · ${r.f.operator}` : ''}
                      </div>
                      <div className="flex items-center gap-3 text-[10px] text-slate-300 tabular-nums mt-0.5">
                        <span>FL{Math.round(r.f.altitudeFt / 100).toString().padStart(3, '0')}</span>
                        <span>{r.f.velocityKts.toFixed(0)}kt</span>
                        <span>{r.f.track.toFixed(0)}°</span>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )
        )}

        {tab === 'EVENTS' && (
          filteredEvents.length === 0 ? (
            <div className="text-center text-[11px] text-slate-500 py-10 px-4">
              {events.length === 0 ? 'No events yet — draw a zone and wait for traffic.' : 'No events match filter.'}
            </div>
          ) : (
            <ul className="divide-y divide-slate-800/70">
              {filteredEvents.slice(0, 200).map((ev) => (
                <li key={ev.id}
                  onClick={() => onFly(ev.icao)}
                  className="px-3 py-1.5 hover:bg-slate-900/70 cursor-pointer">
                  <div className="flex items-start gap-2">
                    <div className="w-1 self-stretch rounded" style={{ background: ev.zoneColor }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className={`text-[10px] uppercase font-semibold ${ev.kind === 'ENTRY' ? 'text-emerald-300' : 'text-rose-300'}`}>{ev.kind}</span>
                        <span className="text-[12px] font-semibold text-slate-100 truncate">{ev.callsign || ev.icao}</span>
                        <span className="ml-auto text-[10px] font-mono tabular-nums text-slate-400">{fmtClock(ev.ts)}</span>
                      </div>
                      <div className="text-[10px] text-slate-400 truncate">
                        <span style={{ color: ev.zoneColor }}>{ev.zoneName}</span>
                        {ev.type ? ` · ${ev.type}` : ''}{ev.operator ? ` · ${ev.operator}` : ''}
                      </div>
                      <div className="flex items-center gap-3 text-[10px] text-slate-300 tabular-nums">
                        <span>FL{Math.round(ev.altitudeFt / 100).toString().padStart(3, '0')}</span>
                        <span>{ev.velocityKts.toFixed(0)}kt</span>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )
        )}
      </div>
    </div>
  )
}
