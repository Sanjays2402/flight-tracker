'use client'
import { useEffect, useMemo, useState } from 'react'
import type { Map as MLMap } from 'maplibre-gl'

// ---------- solar math (NOAA simplified) ----------
function toRad(d: number) { return (d * Math.PI) / 180 }
function toDeg(r: number) { return (r * 180) / Math.PI }

export type SunPos = {
  date: Date
  julian: number
  declDeg: number  // solar declination
  gmstHr: number   // Greenwich mean sidereal time (hours)
  subLat: number   // subsolar latitude
  subLng: number   // subsolar longitude (-180..180)
  eqOfTimeMin: number
}

export function solarPosition(date: Date = new Date()): SunPos {
  const jd = date.getTime() / 86400000 + 2440587.5
  const n = jd - 2451545.0
  const L = (280.460 + 0.9856474 * n) % 360
  const g = toRad((357.528 + 0.9856003 * n) % 360)
  const lambda = toRad(L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g))
  const epsilon = toRad(23.439 - 0.0000004 * n)
  const decl = Math.asin(Math.sin(epsilon) * Math.sin(lambda))
  const ra = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda))
  // GMST in hours
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24
  const gmstNorm = (gmst + 24) % 24
  // subsolar longitude: where local hour angle of sun is 0
  // HA = GMST*15 - RA(deg) - lng  =>  subLng = -GMST*15 + RA(deg), wrapped
  let subLng = toDeg(ra) - gmstNorm * 15
  while (subLng > 180) subLng -= 360
  while (subLng < -180) subLng += 360
  const eot = 4 * (L - 0.0057183 - toDeg(ra))
  return {
    date,
    julian: jd,
    declDeg: toDeg(decl),
    gmstHr: gmstNorm,
    subLat: toDeg(decl),
    subLng,
    eqOfTimeMin: ((eot + 720) % 1440) - 720,
  }
}

// Build a polygon of the unlit hemisphere for a given altitude offset (deg).
// alt = 0 => terminator (sunset); alt = -6 => civil twilight edge; -12 nautical; -18 astronomical.
function nightPolygon(sun: SunPos, altDeg: number, stepDeg = 2): GeoJSON.Feature<GeoJSON.Polygon> {
  const decl = toRad(sun.declDeg)
  const ring: [number, number][] = []
  // For each longitude, the latitude where solar altitude = altDeg:
  // sin(alt) = sin(lat)*sin(decl) + cos(lat)*cos(decl)*cos(H)
  // H = lng - subLng (hour angle from subsolar point)
  const sinAlt = Math.sin(toRad(altDeg))
  for (let lon = -180; lon <= 180; lon += stepDeg) {
    const H = toRad(lon - sun.subLng)
    // solve: A*sin(lat) + B*cos(lat) = sinAlt, where A=sin(decl), B=cos(decl)*cos(H)
    const A = Math.sin(decl)
    const B = Math.cos(decl) * Math.cos(H)
    const R = Math.hypot(A, B)
    if (R < 1e-9 || Math.abs(sinAlt / R) > 1) {
      // pole-style fallback: pick lat far from subsolar
      ring.push([lon, sun.subLat > 0 ? -89 : 89])
      continue
    }
    const phi = Math.atan2(B, A)
    // two solutions; choose the one on the night side (farther from subsolar lat)
    const lat1 = Math.asin(sinAlt / R) - phi
    const lat2 = Math.PI - Math.asin(sinAlt / R) - phi
    const cand = [lat1, lat2].map(l => {
      // normalize to -pi/2..pi/2
      let x = l
      while (x > Math.PI) x -= 2 * Math.PI
      while (x < -Math.PI) x += 2 * Math.PI
      if (x > Math.PI / 2) x = Math.PI - x
      if (x < -Math.PI / 2) x = -Math.PI - x
      return x
    })
    // night-side: latitude opposite to subsolar latitude
    const pick = sun.subLat >= 0
      ? Math.min(cand[0], cand[1])
      : Math.max(cand[0], cand[1])
    ring.push([lon, toDeg(pick)])
  }
  // close to pole opposite the sun
  const polarLat = sun.subLat >= 0 ? -90 : 90
  ring.push([180, polarLat])
  ring.push([-180, polarLat])
  ring.push(ring[0])
  return {
    type: 'Feature',
    properties: { alt: altDeg },
    geometry: { type: 'Polygon', coordinates: [ring] },
  }
}

const SRC = 'ft-terminator-src'
const SUN_SRC = 'ft-sun-src'
const LAYERS = [
  { id: 'ft-term-astro', alt: -18, color: '#020617', opacity: 0.35 },
  { id: 'ft-term-naut',  alt: -12, color: '#0f172a', opacity: 0.20 },
  { id: 'ft-term-civil', alt: -6,  color: '#1e293b', opacity: 0.18 },
  { id: 'ft-term-night', alt: 0,   color: '#0b1220', opacity: 0.22 },
]

export function installTerminator(map: MLMap, sun: SunPos) {
  const fc: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: LAYERS.map(L => nightPolygon(sun, L.alt)),
  }
  const sunFc: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { kind: 'sun' },
      geometry: { type: 'Point', coordinates: [sun.subLng, sun.subLat] },
    }],
  }
  const src = map.getSource(SRC) as any
  if (src) { src.setData(fc) } else {
    map.addSource(SRC, { type: 'geojson', data: fc } as any)
  }
  const ssrc = map.getSource(SUN_SRC) as any
  if (ssrc) { ssrc.setData(sunFc) } else {
    map.addSource(SUN_SRC, { type: 'geojson', data: sunFc } as any)
  }
  // add layers in order; deepest shade first (bottom). Insert below symbol layers if possible.
  const firstSymbol = (() => {
    try { return map.getStyle().layers?.find((l: any) => l.type === 'symbol')?.id } catch { return undefined }
  })()
  for (const L of LAYERS) {
    if (map.getLayer(L.id)) continue
    map.addLayer({
      id: L.id,
      type: 'fill',
      source: SRC,
      filter: ['==', ['get', 'alt'], L.alt],
      paint: {
        'fill-color': L.color,
        'fill-opacity': L.opacity,
        'fill-antialias': true,
      },
    } as any, firstSymbol)
  }
  if (!map.getLayer('ft-sun-glow')) {
    map.addLayer({
      id: 'ft-sun-glow',
      type: 'circle',
      source: SUN_SRC,
      paint: {
        'circle-radius': 24,
        'circle-color': '#fde68a',
        'circle-opacity': 0.25,
        'circle-blur': 1,
      },
    } as any)
    map.addLayer({
      id: 'ft-sun-dot',
      type: 'circle',
      source: SUN_SRC,
      paint: {
        'circle-radius': 6,
        'circle-color': '#facc15',
        'circle-stroke-color': '#fff7ed',
        'circle-stroke-width': 1.5,
      },
    } as any)
  }
}

export function updateTerminator(map: MLMap, sun: SunPos) {
  const fc: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: LAYERS.map(L => nightPolygon(sun, L.alt)),
  }
  const src = map.getSource(SRC) as any
  if (src) src.setData(fc); else installTerminator(map, sun)
  const ssrc = map.getSource(SUN_SRC) as any
  if (ssrc) ssrc.setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [sun.subLng, sun.subLat] } }],
  })
}

export function removeTerminator(map: MLMap) {
  for (const L of LAYERS) { if (map.getLayer(L.id)) map.removeLayer(L.id) }
  for (const id of ['ft-sun-glow', 'ft-sun-dot']) { if (map.getLayer(id)) map.removeLayer(id) }
  if (map.getSource(SRC)) map.removeSource(SRC)
  if (map.getSource(SUN_SRC)) map.removeSource(SUN_SRC)
}

// ---------- side panel ----------
function fmtLat(v: number) { const h = v >= 0 ? 'N' : 'S'; return `${Math.abs(v).toFixed(2)}°${h}` }
function fmtLng(v: number) { const h = v >= 0 ? 'E' : 'W'; return `${Math.abs(v).toFixed(2)}°${h}` }

export function SunPanel({ onClose, onFlyToSun }: { onClose: () => void; onFlyToSun: (lng: number, lat: number) => void }) {
  const [sun, setSun] = useState<SunPos>(() => solarPosition())
  useEffect(() => {
    const t = setInterval(() => setSun(solarPosition()), 30_000)
    return () => clearInterval(t)
  }, [])

  const rows = useMemo(() => {
    const utc = sun.date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
    const season = sun.declDeg > 0 ? 'Northern summer half' : 'Northern winter half'
    return [
      ['Now (UTC)', utc],
      ['Subsolar point', `${fmtLat(sun.subLat)}, ${fmtLng(sun.subLng)}`],
      ['Solar declination', `${sun.declDeg.toFixed(2)}°`],
      ['Equation of time', `${sun.eqOfTimeMin >= 0 ? '+' : ''}${sun.eqOfTimeMin.toFixed(1)} min`],
      ['GMST', `${sun.gmstHr.toFixed(3)} h`],
      ['Tilt regime', season],
    ] as const
  }, [sun])

  return (
    <div className="absolute right-3 top-20 z-30 w-[300px] rounded-2xl border border-white/10 bg-slate-950/85 p-3 text-xs text-slate-100 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-base">☀️</span>
          <span className="font-semibold tracking-wide">SUN &amp; TERMINATOR</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white text-sm leading-none">×</button>
      </div>
      <div className="grid grid-cols-2 gap-y-1 gap-x-2 mb-3">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <div className="text-slate-400">{k}</div>
            <div className="text-slate-100 text-right tabular-nums truncate">{v}</div>
          </div>
        ))}
      </div>
      <div className="mb-2">
        <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Twilight bands shaded</div>
        <div className="flex items-center gap-1.5 text-[10px]">
          <span className="px-1.5 py-0.5 rounded bg-slate-900/80 border border-white/10">Night ≤0°</span>
          <span className="px-1.5 py-0.5 rounded bg-slate-800/80 border border-white/10">Civil −6°</span>
          <span className="px-1.5 py-0.5 rounded bg-slate-700/80 border border-white/10">Nautical −12°</span>
          <span className="px-1.5 py-0.5 rounded bg-slate-600/80 border border-white/10">Astro −18°</span>
        </div>
      </div>
      <button
        onClick={() => onFlyToSun(sun.subLng, sun.subLat)}
        className="w-full rounded-md bg-amber-400/90 hover:bg-amber-300 text-slate-900 font-semibold py-1.5 text-xs"
      >
        Fly to subsolar point
      </button>
      <div className="mt-2 text-[10px] text-slate-500 leading-snug">
        Polygons update every 30s. Useful for guessing golden-hour photo windows along a route or spotting which flights are flying into the night.
      </div>
    </div>
  )
}
