'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Sun Glare Predictor
   -----------------------------------------------------------
   For every airborne aircraft, computes the sun's apparent
   position in the *pilot's* reference frame:
     * clock position (12 = directly ahead along track, 3 = right
       wing, 6 = directly behind, 9 = left wing)
     * elevation above the local horizon (deg)
     * relative azimuth offset from nose (deg, -180..180)
   Then classifies glare severity:
     SEVERE  - sun within +/-30deg of nose and elevation <15deg
     HIGH    - sun within +/-45deg of nose, elevation <25deg
     MODERATE- sun anywhere in front hemisphere, elevation <40deg
     SIDE    - sun off the wing (±60..±120 of nose), elev <30deg
     SAFE    - sun behind, above 40deg, or below horizon
   MapLibre overlay paints colored halos and a sun-ray arrow from
   each aircraft pointing toward the sun's azimuth, length scaled
   by inverse elevation (low sun = longer ray).
   ============================================================ */

export interface SgFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: SgFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Severity = 'SEVERE' | 'HIGH' | 'MODERATE' | 'SIDE' | 'SAFE'

const SEV_COLOR: Record<Severity, string> = {
  SEVERE: '#ef4444',
  HIGH: '#f97316',
  MODERATE: '#fbbf24',
  SIDE: '#a78bfa',
  SAFE: '#10b981',
}
const SEV_ORDER: Severity[] = ['SEVERE', 'HIGH', 'MODERATE', 'SIDE', 'SAFE']

const SRC_HALO = 'sg-halo-src'
const LYR_HALO = 'sg-halo-lyr'
const SRC_RAY = 'sg-ray-src'
const LYR_RAY = 'sg-ray-lyr'
const SRC_LBL = 'sg-lbl-src'
const LYR_LBL = 'sg-lbl-lyr'

const toRad = (d: number) => (d * Math.PI) / 180
const toDeg = (r: number) => (r * 180) / Math.PI

// Sun horizontal coords (az from north CW, alt above horizon) at lat/lng/time.
function sunAltAz(date: Date, lat: number, lng: number) {
  const jd = date.getTime() / 86400000 + 2440587.5
  const n = jd - 2451545.0
  const L = (280.460 + 0.9856474 * n) % 360
  const g = toRad((357.528 + 0.9856003 * n) % 360)
  const lambda = toRad(L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g))
  const epsilon = toRad(23.439 - 0.0000004 * n)
  const decl = Math.asin(Math.sin(epsilon) * Math.sin(lambda))
  const ra = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda))
  const gmst = ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24
  const lst = (gmst * 15 + lng) % 360 // deg
  const ha = toRad(((lst - toDeg(ra)) + 540) % 360 - 180)
  const phi = toRad(lat)
  const alt = Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha))
  const az = Math.atan2(-Math.sin(ha), Math.tan(decl) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha))
  return { altDeg: toDeg(alt), azDeg: (toDeg(az) + 360) % 360 }
}

function destPoint(lat: number, lng: number, brgDeg: number, distNm: number) {
  // Great-circle destination given start, bearing, distance.
  const R = 3440.065 // earth radius in nm
  const br = toRad(brgDeg)
  const d = distNm / R
  const phi1 = toRad(lat), lam1 = toRad(lng)
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(br))
  const lam2 = lam1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(phi1), Math.cos(d) - Math.sin(phi1) * Math.sin(phi2))
  return [(toDeg(lam2) + 540) % 360 - 180, toDeg(phi2)] as [number, number]
}

function classify(relDeg: number, altDeg: number): Severity {
  if (altDeg < -1) return 'SAFE'
  const a = Math.abs(relDeg)
  if (a <= 30 && altDeg < 15) return 'SEVERE'
  if (a <= 45 && altDeg < 25) return 'HIGH'
  if (a <= 90 && altDeg < 40) return 'MODERATE'
  if (a > 60 && a < 120 && altDeg < 30) return 'SIDE'
  return 'SAFE'
}

function clockPos(relDeg: number) {
  // relDeg: -180..180, 0 = ahead. Convert to 12-hour clock.
  const c = ((relDeg + 360) % 360) / 30
  const h = Math.round(c) % 12
  return h === 0 ? 12 : h
}

export default function SunGlarePanel({ map, flights, onClose, onFly }: Props) {
  const [now, setNow] = useState(() => new Date())
  const [minSeverity, setMinSeverity] = useState<Severity>('MODERATE')
  const [filter, setFilter] = useState<Severity | 'ALL'>('ALL')
  const [showOverlay, setShowOverlay] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [query, setQuery] = useState('')
  const [airborneOnly, setAirborneOnly] = useState(true)

  // tick once per second so sun position stays current; computed in useMemo
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const results = useMemo(() => {
    const list = flights
      .filter(f => (airborneOnly ? !f.ground : true))
      .filter(f => Number.isFinite(f.lat) && Number.isFinite(f.lng))
      .map(f => {
        const sun = sunAltAz(now, f.lat, f.lng)
        let rel = ((sun.azDeg - (f.track ?? 0)) + 540) % 360 - 180
        const sev = classify(rel, sun.altDeg)
        const clk = clockPos(rel)
        return { ...f, sunAz: sun.azDeg, sunAlt: sun.altDeg, rel, sev, clk }
      })
    return list
  }, [flights, now, airborneOnly])

  const minIdx = SEV_ORDER.indexOf(minSeverity)
  const ranked = useMemo(() => {
    const q = query.trim().toLowerCase()
    return results
      .filter(r => SEV_ORDER.indexOf(r.sev) <= minIdx)
      .filter(r => filter === 'ALL' || r.sev === filter)
      .filter(r => !q || r.callsign?.toLowerCase().includes(q) || r.type?.toLowerCase().includes(q) || r.operator?.toLowerCase().includes(q) || r.icao.toLowerCase().includes(q))
      .sort((a, b) => {
        const da = SEV_ORDER.indexOf(a.sev), db = SEV_ORDER.indexOf(b.sev)
        if (da !== db) return da - db
        return Math.abs(a.rel) - Math.abs(b.rel)
      })
  }, [results, minIdx, filter, query])

  const counts = useMemo(() => {
    const c: Record<Severity, number> = { SEVERE: 0, HIGH: 0, MODERATE: 0, SIDE: 0, SAFE: 0 }
    for (const r of results) c[r.sev]++
    return c
  }, [results])

  // ---------- MapLibre overlay ----------
  useEffect(() => {
    if (!map || !showOverlay) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC_HALO)) map.addSource(SRC_HALO, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_HALO)) map.addLayer({
          id: LYR_HALO, type: 'circle', source: SRC_HALO,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 8, 8, 16, 12, 22],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.32,
            'circle-stroke-width': 2,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-opacity': 0.85,
          },
        })
        if (!map.getSource(SRC_RAY)) map.addSource(SRC_RAY, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_RAY)) map.addLayer({
          id: LYR_RAY, type: 'line', source: SRC_RAY,
          paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.9, 'line-dasharray': [2, 1] },
        })
        if (!map.getSource(SRC_LBL)) map.addSource(SRC_LBL, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_LBL)) map.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC_LBL,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 11,
            'text-offset': [0, -1.6],
            'text-anchor': 'bottom',
            'text-allow-overlap': true,
          },
          paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.2 },
        })
      } catch {}
    }
    ensure()

    const visible = results.filter(r => SEV_ORDER.indexOf(r.sev) <= minIdx)
    const haloFeats = visible.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.lng, r.lat] },
      properties: { color: SEV_COLOR[r.sev] },
    }))
    const rayFeats = visible.map(r => {
      const len = r.sunAlt > 0 ? Math.max(3, Math.min(40, 40 - r.sunAlt * 0.7)) : 5
      const end = destPoint(r.lat, r.lng, r.sunAz, len)
      return {
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: [[r.lng, r.lat], end] },
        properties: { color: SEV_COLOR[r.sev] },
      }
    })
    const lblFeats = showLabels ? visible.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.lng, r.lat] },
      properties: { color: SEV_COLOR[r.sev], label: `${r.callsign?.trim() || r.icao} \u2600 ${r.clk} \u2022 ${r.sunAlt.toFixed(0)}\u00b0` },
    })) : []
    try {
      (map.getSource(SRC_HALO) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: haloFeats })
      ;(map.getSource(SRC_RAY) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: rayFeats })
      ;(map.getSource(SRC_LBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lblFeats })
    } catch {}
  }, [map, results, minIdx, showOverlay, showLabels])

  useEffect(() => {
    return () => {
      if (!map) return
      try { for (const l of [LYR_LBL, LYR_RAY, LYR_HALO]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
      try { for (const s of [SRC_LBL, SRC_RAY, SRC_HALO]) if (map.getSource(s)) map.removeSource(s) } catch {}
    }
  }, [map])

  // hide overlay layers without tearing down sources when toggled off
  useEffect(() => {
    if (!map) return
    const vis = showOverlay ? 'visible' : 'none'
    try { for (const l of [LYR_HALO, LYR_RAY, LYR_LBL]) if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', vis) } catch {}
  }, [map, showOverlay])

  return (
    <div className="fixed top-16 right-3 z-40 w-[360px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-white/10 bg-neutral-950/95 backdrop-blur text-neutral-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-2">
          <span className="text-amber-300">&#9728;</span>
          <span className="text-sm font-semibold tracking-wide">SUN GLARE</span>
          <span className="text-[10px] text-neutral-400">{now.toUTCString().slice(17, 25)} UTC</span>
        </div>
        <button onClick={onClose} className="text-neutral-400 hover:text-white text-lg leading-none">×</button>
      </div>

      <div className="px-3 py-2 grid grid-cols-5 gap-1 border-b border-white/10">
        {SEV_ORDER.map(s => (
          <button
            key={s}
            onClick={() => setFilter(filter === s ? 'ALL' : s)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${filter === s ? 'border-white/40 bg-white/10' : 'border-white/10 bg-black/30'}`}
            style={{ color: SEV_COLOR[s] }}
            title={s}
          >
            <span className="text-[9px] tracking-wider">{s.slice(0, 4)}</span>
            <span className="text-sm font-mono">{counts[s]}</span>
          </button>
        ))}
      </div>

      <div className="px-3 py-2 border-b border-white/10 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <label className="text-[10px] text-neutral-400 tracking-wider">MIN SEV</label>
          <div className="flex gap-1">
            {SEV_ORDER.map(s => (
              <button
                key={s}
                onClick={() => setMinSeverity(s)}
                className={`text-[10px] px-1.5 py-0.5 rounded border ${minSeverity === s ? 'border-white/50 bg-white/15' : 'border-white/10 bg-black/30 hover:border-white/30'}`}
                style={{ color: SEV_COLOR[s] }}
              >{s.slice(0, 4)}</button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={showOverlay} onChange={e => setShowOverlay(e.target.checked)} />
            <span>OVERLAY</span>
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} />
            <span>LABELS</span>
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={airborneOnly} onChange={e => setAirborneOnly(e.target.checked)} />
            <span>AIRBORNE</span>
          </label>
        </div>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="search callsign / type / operator"
          className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-xs placeholder-neutral-600 focus:border-white/30 outline-none"
        />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-neutral-400 border-b border-white/10 flex justify-between">
        <span>{ranked.length} shown / {results.length} tracked</span>
        <span>sun ray dashed toward solar az</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {ranked.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-neutral-500">No aircraft at this severity.</div>
        )}
        {ranked.map(r => (
          <button
            key={r.icao}
            onClick={() => onFly(r.icao)}
            className="w-full text-left px-3 py-2 border-b border-white/5 hover:bg-white/5 flex items-center gap-2"
          >
            <span className="w-1 self-stretch rounded" style={{ background: SEV_COLOR[r.sev] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono font-semibold truncate">{r.callsign?.trim() || r.icao}</span>
                <span className="text-neutral-400 truncate">{r.type || '—'}</span>
                <span className="ml-auto text-[10px] font-semibold" style={{ color: SEV_COLOR[r.sev] }}>{r.sev}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-neutral-400 font-mono mt-0.5">
                <span title="clock position from nose">&#9728; {r.clk} o'clock</span>
                <span title="solar elevation above local horizon">{r.sunAlt > 0 ? `+${r.sunAlt.toFixed(0)}\u00b0` : `${r.sunAlt.toFixed(0)}\u00b0`}</span>
                <span title="relative bearing from nose">{r.rel > 0 ? 'R' : 'L'}{Math.abs(r.rel).toFixed(0)}\u00b0</span>
                <span className="ml-auto">FL{Math.round(r.altitudeFt / 100)}</span>
              </div>
              {r.operator && <div className="text-[10px] text-neutral-500 truncate">{r.operator}</div>}
            </div>
          </button>
        ))}
      </div>

      <div className="px-3 py-1.5 border-t border-white/10 text-[9px] text-neutral-500 tracking-wider">
        12=ahead 3=right wing 6=behind 9=left wing
      </div>
    </div>
  )
}
