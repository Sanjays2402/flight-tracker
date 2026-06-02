'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Shadow Caster
   -----------------------------------------------------------
   For every airborne aircraft, computes the geographic point
   where its sun-cast shadow lands on the ground (or sea), plus
   the great-circle distance from the aircraft's nadir to that
   shadow point.

   Geometry:
     * Sun altitude/azimuth at the aircraft's lat/lng & current
       UTC instant (NOAA simplified model).
     * Horizontal shadow offset along the *anti-solar* azimuth:
         offsetNm = altFt / (6076.12 * tan(altSun))
       (clamped when sun is near horizon).
     * Shadow direction = (sunAz + 180) mod 360.
     * Shadow length scales with airframe class wingspan, drawn
       as a tapered ellipse stretched along the aircraft's track
       (long axis = wingspan-scaled in km), rotated to that track,
       and projected onto the ground.
   No shadows when sun is below horizon (NIGHT) or above 88deg
   (sun straight overhead, shadow degenerate).

   MapLibre overlay:
     * Soft black ground-shadow polygons at the ground point.
     * Dashed grey "shadow line" connecting aircraft nadir dot to
       its shadow centroid (visual tether).
     * Optional callsign+offset labels at each shadow.

   Side panel: counters by lighting state, sun altitude readout,
   per-aircraft list ranked by offset (longest shadow = lowest
   sun + highest altitude), search, toggles, click-to-fly.
   ============================================================ */

export interface ShFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  track: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: ShFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Light = 'DAY' | 'GOLDEN' | 'TWILIGHT' | 'NIGHT'

const LIGHT_COLOR: Record<Light, string> = {
  DAY: '#fbbf24',
  GOLDEN: '#f97316',
  TWILIGHT: '#a78bfa',
  NIGHT: '#475569',
}

const SRC_SHAD = 'sh-shad-src'
const LYR_SHAD = 'sh-shad-lyr'
const SRC_LINE = 'sh-line-src'
const LYR_LINE = 'sh-line-lyr'
const SRC_LBL = 'sh-lbl-src'
const LYR_LBL = 'sh-lbl-lyr'

const toRad = (d: number) => (d * Math.PI) / 180
const toDeg = (r: number) => (r * 180) / Math.PI

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
  const lst = (gmst * 15 + lng) % 360
  const ha = toRad(((lst - toDeg(ra)) + 540) % 360 - 180)
  const phi = toRad(lat)
  const alt = Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha))
  const az = Math.atan2(-Math.sin(ha), Math.tan(decl) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha))
  return { altDeg: toDeg(alt), azDeg: (toDeg(az) + 360) % 360 }
}

function destPoint(lat: number, lng: number, brgDeg: number, distNm: number): [number, number] {
  const R = 3440.065
  const br = toRad(brgDeg)
  const d = distNm / R
  const phi1 = toRad(lat), lam1 = toRad(lng)
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(br))
  const lam2 = lam1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(phi1), Math.cos(d) - Math.sin(phi1) * Math.sin(phi2))
  return [(toDeg(lam2) + 540) % 360 - 180, toDeg(phi2)]
}

function classifyLight(sunAltDeg: number): Light {
  if (sunAltDeg < -0.5) return 'NIGHT'
  if (sunAltDeg < 6) return 'TWILIGHT'
  if (sunAltDeg < 12) return 'GOLDEN'
  return 'DAY'
}

// rough wingspan in meters by airframe class via type prefix
function wingspanM(t?: string): number {
  if (!t) return 35
  const x = t.toUpperCase()
  if (/^A38|^B74|^B77|^A35|^A34|^B78|^MD11|^IL96|^AN12|^AN22|^AN24|^B75/.test(x)) return 65
  if (/^A33|^A32|^B73|^B76|^MD8|^MD9|^E19|^E29|^A22/.test(x)) return 35
  if (/^E13|^E14|^E15|^E17|^CRJ|^DH8|^AT4|^AT7|^E45|^E50/.test(x)) return 25
  if (/^GLF|^GLEX|^CL|^FA|^F2|^F7|^F9|^HDJ|^C25|^C56|^C68/.test(x)) return 20
  if (/^C12|^BE|^PA|^C72|^C82|^TBM|^PC|^DA/.test(x)) return 13
  if (/^EC|^AS|^B06|^R44|^R66|^H1|^S6|^S7|^UH/.test(x)) return 12
  return 30
}

export interface ShadowHit {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  track: number
  sunAltDeg: number
  sunAzDeg: number
  shadowAzDeg: number
  offsetNm: number
  shadowLat: number
  shadowLng: number
  light: Light
  wingspan: number
}

function computeHits(flights: ShFlight[], now: Date): ShadowHit[] {
  const out: ShadowHit[] = []
  for (const f of flights) {
    if (f.ground) continue
    if (!Number.isFinite(f.altitudeFt) || f.altitudeFt < 200) continue
    const sun = sunAltAz(now, f.lat, f.lng)
    const light = classifyLight(sun.altDeg)
    if (light === 'NIGHT') continue
    if (sun.altDeg > 88) continue
    const tan = Math.tan(toRad(Math.max(sun.altDeg, 0.5)))
    const offsetNm = Math.min(60, f.altitudeFt / (6076.12 * tan))
    const shadowAz = (sun.azDeg + 180) % 360
    const [slng, slat] = destPoint(f.lat, f.lng, shadowAz, offsetNm)
    out.push({
      icao: f.icao,
      callsign: f.callsign,
      type: f.type,
      operator: f.operator,
      lat: f.lat,
      lng: f.lng,
      altitudeFt: f.altitudeFt,
      track: f.track,
      sunAltDeg: sun.altDeg,
      sunAzDeg: sun.azDeg,
      shadowAzDeg: shadowAz,
      offsetNm,
      shadowLat: slat,
      shadowLng: slng,
      light,
      wingspan: wingspanM(f.type),
    })
  }
  return out
}

// Build an ellipse polygon (40 vertices) centered on (lat,lng), with semi-axis
// `a` km along track-bearing and `b` km cross-track. Approximates ground shadow.
function ellipsePoly(lat: number, lng: number, bearingDeg: number, aKm: number, bKm: number): [number, number][] {
  const ring: [number, number][] = []
  const aNm = aKm / 1.852
  const bNm = bKm / 1.852
  for (let i = 0; i <= 40; i++) {
    const th = (i / 40) * Math.PI * 2
    const x = aNm * Math.cos(th)
    const y = bNm * Math.sin(th)
    // rotate by bearing (clockwise from north): new bearing & distance from center
    const dist = Math.hypot(x, y)
    const angle = (toDeg(Math.atan2(y, x)) + 360) % 360
    const brg = (bearingDeg + angle) % 360
    ring.push(destPoint(lat, lng, brg, dist))
  }
  return ring
}

export default function ShadowCaster({ map, flights, onClose, onFly }: Props) {
  const [now, setNow] = useState(() => new Date())
  const [showShadows, setShowShadows] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showLine, setShowLine] = useState(true)
  const [filter, setFilter] = useState<Light | 'ALL'>('ALL')
  const [query, setQuery] = useState('')
  const [scale, setScale] = useState(8) // visual exaggeration: shadow size = wingspan*scale

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 2000)
    return () => clearInterval(t)
  }, [])

  const hits = useMemo(() => computeHits(flights, now), [flights, now])

  // Map center sun reading (informational)
  const centerSun = useMemo(() => {
    const c = map?.getCenter()
    if (!c) return null
    return sunAltAz(now, c.lat, c.lng)
  }, [now, map])

  const counts = useMemo(() => {
    const c: Record<Light, number> = { DAY: 0, GOLDEN: 0, TWILIGHT: 0, NIGHT: 0 }
    for (const h of hits) c[h.light]++
    return c
  }, [hits])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return hits
      .filter(h => filter === 'ALL' || h.light === filter)
      .filter(h => !q || h.callsign.toLowerCase().includes(q) || (h.type ?? '').toLowerCase().includes(q) || (h.operator ?? '').toLowerCase().includes(q) || h.icao.toLowerCase().includes(q))
      .sort((a, b) => b.offsetNm - a.offsetNm)
  }, [hits, filter, query])

  // Build & repaint MapLibre overlay sources/layers
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      if (!map.getSource(SRC_SHAD)) {
        map.addSource(SRC_SHAD, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({
          id: LYR_SHAD,
          type: 'fill',
          source: SRC_SHAD,
          paint: {
            'fill-color': '#000000',
            'fill-opacity': ['interpolate', ['linear'], ['get', 'opacity'], 0, 0, 1, 0.45],
          },
        })
      }
      if (!map.getSource(SRC_LINE)) {
        map.addSource(SRC_LINE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({
          id: LYR_LINE,
          type: 'line',
          source: SRC_LINE,
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 1.2,
            'line-opacity': 0.6,
            'line-dasharray': [2, 2],
          },
        })
      }
      if (!map.getSource(SRC_LBL)) {
        map.addSource(SRC_LBL, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({
          id: LYR_LBL,
          type: 'symbol',
          source: SRC_LBL,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-offset': [0, 1.1],
            'text-anchor': 'top',
            'text-allow-overlap': true,
          },
          paint: {
            'text-color': '#fbbf24',
            'text-halo-color': '#000',
            'text-halo-width': 1.2,
          },
        })
      }
    }
    try { ensure() } catch {}

    const shadFeats: GeoJSON.Feature[] = []
    const lineFeats: GeoJSON.Feature[] = []
    const lblFeats: GeoJSON.Feature[] = []
    if (showShadows) {
      for (const h of hits) {
        if (filter !== 'ALL' && h.light !== filter) continue
        // shadow ellipse - long axis along aircraft track, scaled by altitude+wingspan
        const aKm = (h.wingspan * scale) / 1000 + h.altitudeFt / 30000 // a tiny extra at altitude
        const bKm = aKm * 0.18
        const ring = ellipsePoly(h.shadowLat, h.shadowLng, h.track, aKm, bKm)
        const opacity = Math.min(1, Math.max(0.25, h.sunAltDeg / 35))
        shadFeats.push({
          type: 'Feature',
          properties: { opacity },
          geometry: { type: 'Polygon', coordinates: [ring] },
        })
        if (showLine) {
          lineFeats.push({
            type: 'Feature',
            properties: { color: LIGHT_COLOR[h.light] },
            geometry: { type: 'LineString', coordinates: [[h.lng, h.lat], [h.shadowLng, h.shadowLat]] },
          })
        }
        if (showLabels) {
          lblFeats.push({
            type: 'Feature',
            properties: { label: `${h.callsign}  ${h.offsetNm.toFixed(1)}nm` },
            geometry: { type: 'Point', coordinates: [h.shadowLng, h.shadowLat] },
          })
        }
      }
    }
    try {
      ;(map.getSource(SRC_SHAD) as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: shadFeats })
      ;(map.getSource(SRC_LINE) as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: lineFeats })
      ;(map.getSource(SRC_LBL) as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: lblFeats })
    } catch {}
  }, [map, hits, showShadows, showLabels, showLine, filter, scale])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (!map) return
      try {
        for (const id of [LYR_LBL, LYR_LINE, LYR_SHAD]) if (map.getLayer(id)) map.removeLayer(id)
        for (const id of [SRC_LBL, SRC_LINE, SRC_SHAD]) if (map.getSource(id)) map.removeSource(id)
      } catch {}
    }
  }, [map])

  const longest = hits.reduce((a, b) => (b.offsetNm > a ? b.offsetNm : a), 0)

  return (
    <div className="absolute right-4 top-20 z-40 w-[360px] max-h-[78vh] overflow-hidden rounded-2xl bg-slate-950/95 backdrop-blur ring-1 ring-amber-500/30 shadow-2xl flex flex-col text-slate-100">
      <div className="px-3 py-2 flex items-center gap-2 border-b border-slate-800">
        <div className="text-xs font-bold tracking-wider text-amber-400">SHADOW CASTER</div>
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={onClose} className="text-[10px] px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700">×</button>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-4 gap-1">
          {(['DAY','GOLDEN','TWILIGHT','NIGHT'] as Light[]).map(l => (
            <button
              key={l}
              onClick={() => setFilter(filter === l ? 'ALL' : l)}
              className={`text-[10px] px-1.5 py-1 rounded border ${filter === l ? 'border-amber-400 bg-amber-500/15' : 'border-slate-700 bg-slate-900 hover:bg-slate-800'}`}
              style={{ color: LIGHT_COLOR[l] }}
            >
              <div className="text-[9px] opacity-70">{l}</div>
              <div className="font-mono font-bold">{counts[l]}</div>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-[10px] text-slate-400">
          {centerSun ? (
            <>
              <span>SUN</span>
              <span className="font-mono text-amber-300">{centerSun.altDeg.toFixed(1)}°</span>
              <span>az</span>
              <span className="font-mono text-amber-300">{centerSun.azDeg.toFixed(0)}°</span>
              <span className="ml-auto">Longest shadow</span>
              <span className="font-mono text-amber-300">{longest.toFixed(1)}nm</span>
            </>
          ) : (
            <span>—</span>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => setShowShadows(s => !s)} className={`text-[10px] px-2 py-1 rounded border ${showShadows ? 'border-amber-400 bg-amber-500/10 text-amber-300' : 'border-slate-700 bg-slate-900 text-slate-400'}`}>SHADOWS</button>
          <button onClick={() => setShowLine(s => !s)} className={`text-[10px] px-2 py-1 rounded border ${showLine ? 'border-amber-400 bg-amber-500/10 text-amber-300' : 'border-slate-700 bg-slate-900 text-slate-400'}`}>TETHER</button>
          <button onClick={() => setShowLabels(s => !s)} className={`text-[10px] px-2 py-1 rounded border ${showLabels ? 'border-amber-400 bg-amber-500/10 text-amber-300' : 'border-slate-700 bg-slate-900 text-slate-400'}`}>LABELS</button>
        </div>

        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-slate-400 w-12">SCALE</span>
          <input type="range" min={2} max={30} step={1} value={scale} onChange={e => setScale(+e.target.value)} className="flex-1 accent-amber-500" />
          <span className="font-mono text-amber-300 w-8 text-right">{scale}x</span>
        </div>

        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="search callsign / type / operator"
          className="w-full text-[11px] bg-slate-900 border border-slate-800 rounded px-2 py-1 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500/60"
        />
      </div>

      <div className="overflow-y-auto flex-1">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-slate-500">
            {hits.length === 0 ? 'No airborne aircraft in daylight' : 'No matches'}
          </div>
        )}
        {filtered.map(h => (
          <button
            key={h.icao}
            onClick={() => onFly(h.icao)}
            className="w-full text-left px-3 py-1.5 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2"
          >
            <div className="w-1 h-8 rounded" style={{ background: LIGHT_COLOR[h.light] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono font-bold text-slate-100">{h.callsign}</span>
                <span className="text-[9px] text-slate-500 truncate">{h.type ?? ''} {h.operator ? `· ${h.operator}` : ''}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-slate-400 font-mono">
                <span className="text-amber-300">{h.offsetNm.toFixed(1)}nm</span>
                <span>sun {h.sunAltDeg.toFixed(0)}°</span>
                <span>FL{Math.round(h.altitudeFt / 100)}</span>
                <span className="ml-auto" style={{ color: LIGHT_COLOR[h.light] }}>{h.light}</span>
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="px-3 py-1.5 text-[9px] text-slate-500 border-t border-slate-800">
        Anti-solar shadow projection — offset = alt / tan(sun-alt). Ellipse scaled by wingspan × scale.
      </div>
    </div>
  )
}
