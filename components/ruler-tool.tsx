'use client'
import { useEffect, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Great-Circle Ruler — multi-waypoint geodesic measurement tool.
   Click on the map to drop waypoints. Each leg is drawn as a true
   great-circle arc (densified along the geodesic). Side panel
   lists per-leg distance + initial bearing, total distance, and
   approximate flight-time estimates at common airliner speeds.
   ============================================================ */

interface Pt { lng: number; lat: number }

const R_NM = 3440.065        // Earth radius (nautical miles)
const NM_TO_KM = 1.852
const NM_TO_MI = 1.15078

function toRad(d: number) { return d * Math.PI / 180 }
function toDeg(r: number) { return r * 180 / Math.PI }

// Haversine distance, nm
function distNm(a: Pt, b: Pt): number {
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat)
  const dφ = toRad(b.lat - a.lat), dλ = toRad(b.lng - a.lng)
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(s)))
}

// Initial bearing, degrees
function bearingDeg(a: Pt, b: Pt): number {
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat)
  const dλ = toRad(b.lng - a.lng)
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

// Intermediate point along great circle at fraction f [0..1]
function interp(a: Pt, b: Pt, f: number): Pt {
  const φ1 = toRad(a.lat), λ1 = toRad(a.lng)
  const φ2 = toRad(b.lat), λ2 = toRad(b.lng)
  const d = distNm(a, b) / R_NM
  if (d < 1e-9) return { lng: a.lng, lat: a.lat }
  const A = Math.sin((1 - f) * d) / Math.sin(d)
  const B = Math.sin(f * d) / Math.sin(d)
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2)
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2)
  const z = A * Math.sin(φ1) + B * Math.sin(φ2)
  const φ = Math.atan2(z, Math.sqrt(x * x + y * y))
  const λ = Math.atan2(y, x)
  return { lng: toDeg(λ), lat: toDeg(φ) }
}

// Densify a leg into N+1 sample points along the great circle.
// Handles antimeridian by splitting into separate line segments.
function densifyLeg(a: Pt, b: Pt, steps = 96): number[][][] {
  const pts: number[][] = []
  for (let i = 0; i <= steps; i++) {
    const p = interp(a, b, i / steps)
    pts.push([p.lng, p.lat])
  }
  // Split at antimeridian crossings
  const segs: number[][][] = []
  let cur: number[][] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1], next = pts[i]
    if (Math.abs(next[0] - prev[0]) > 180) {
      segs.push(cur)
      cur = [next]
    } else {
      cur.push(next)
    }
  }
  segs.push(cur)
  return segs
}

const SRC_LINE = 'gc-ruler-line'
const SRC_PTS = 'gc-ruler-pts'
const LYR_LINE_HALO = 'gc-ruler-line-halo'
const LYR_LINE = 'gc-ruler-line-main'
const LYR_PTS = 'gc-ruler-pts-circ'
const LYR_LBL = 'gc-ruler-pts-lbl'

function ensureLayers(map: maplibregl.Map) {
  if (!map.getSource(SRC_LINE)) {
    map.addSource(SRC_LINE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
  }
  if (!map.getSource(SRC_PTS)) {
    map.addSource(SRC_PTS, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
  }
  if (!map.getLayer(LYR_LINE_HALO)) {
    map.addLayer({
      id: LYR_LINE_HALO, type: 'line', source: SRC_LINE,
      paint: { 'line-color': '#020617', 'line-width': 6, 'line-opacity': 0.6 },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }
  if (!map.getLayer(LYR_LINE)) {
    map.addLayer({
      id: LYR_LINE, type: 'line', source: SRC_LINE,
      paint: { 'line-color': '#fbbf24', 'line-width': 2.5, 'line-dasharray': [2, 1.2] },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }
  if (!map.getLayer(LYR_PTS)) {
    map.addLayer({
      id: LYR_PTS, type: 'circle', source: SRC_PTS,
      paint: {
        'circle-radius': 6,
        'circle-color': '#fbbf24',
        'circle-stroke-color': '#020617',
        'circle-stroke-width': 2,
      },
    })
  }
  if (!map.getLayer(LYR_LBL)) {
    map.addLayer({
      id: LYR_LBL, type: 'symbol', source: SRC_PTS,
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 10,
        'text-offset': [0, -1.4],
        'text-font': ['Noto Sans Bold'],
        'text-allow-overlap': true,
      },
      paint: {
        'text-color': '#fde68a',
        'text-halo-color': '#020617',
        'text-halo-width': 1.5,
      },
    })
  }
}

function removeLayers(map: maplibregl.Map) {
  for (const id of [LYR_LBL, LYR_PTS, LYR_LINE, LYR_LINE_HALO]) {
    if (map.getLayer(id)) try { map.removeLayer(id) } catch {}
  }
  for (const id of [SRC_LINE, SRC_PTS]) {
    if (map.getSource(id)) try { map.removeSource(id) } catch {}
  }
}

export default function RulerTool({ map, onClose }: { map: maplibregl.Map | null; onClose: () => void }) {
  const [pts, setPts] = useState<Pt[]>([])
  const [hover, setHover] = useState<Pt | null>(null)
  const ptsRef = useRef<Pt[]>([])
  ptsRef.current = pts

  // Install layers + click handler
  useEffect(() => {
    if (!map) return
    ensureLayers(map)
    const canvas = map.getCanvas()
    const prevCursor = canvas.style.cursor
    canvas.style.cursor = 'crosshair'

    const onClick = (e: maplibregl.MapMouseEvent) => {
      const ll = e.lngLat
      setPts(p => [...p, { lng: ll.lng, lat: ll.lat }])
    }
    const onMove = (e: maplibregl.MapMouseEvent) => {
      if (ptsRef.current.length === 0) return
      setHover({ lng: e.lngLat.lng, lat: e.lngLat.lat })
    }
    const onDbl = (e: maplibregl.MapMouseEvent) => {
      e.preventDefault()
      setHover(null)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { onClose() }
      else if (ev.key === 'Backspace' || ev.key === 'z') { setPts(p => p.slice(0, -1)) }
      else if (ev.key === 'Enter') { setHover(null) }
    }

    map.on('click', onClick)
    map.on('mousemove', onMove)
    map.on('dblclick', onDbl)
    window.addEventListener('keydown', onKey)
    return () => {
      map.off('click', onClick)
      map.off('mousemove', onMove)
      map.off('dblclick', onDbl)
      window.removeEventListener('keydown', onKey)
      canvas.style.cursor = prevCursor
      removeLayers(map)
    }
  }, [map, onClose])

  // Re-render geometry whenever points / hover change
  useEffect(() => {
    if (!map) return
    const all: Pt[] = hover ? [...pts, hover] : pts
    const lineFeats: any[] = []
    for (let i = 1; i < all.length; i++) {
      const segs = densifyLeg(all[i - 1], all[i], 96)
      for (const seg of segs) {
        lineFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: seg }, properties: { leg: i } })
      }
    }
    const ptFeats = pts.map((p, i) => {
      let label = `${i + 1}`
      if (i > 0) {
        const d = distNm(pts[i - 1], p)
        label = `${i + 1} · ${fmtNm(d)}`
      }
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { label } }
    })
    const src1 = map.getSource(SRC_LINE) as any
    const src2 = map.getSource(SRC_PTS) as any
    if (src1) src1.setData({ type: 'FeatureCollection', features: lineFeats })
    if (src2) src2.setData({ type: 'FeatureCollection', features: ptFeats })
  }, [map, pts, hover])

  // Per-leg + total stats
  const legs = pts.slice(1).map((p, i) => {
    const a = pts[i]
    return { from: i + 1, to: i + 2, nm: distNm(a, p), brg: bearingDeg(a, p) }
  })
  const totalNm = legs.reduce((s, l) => s + l.nm, 0)
  const pendingNm = hover && pts.length > 0 ? distNm(pts[pts.length - 1], hover) : 0

  return (
    <div className="absolute top-20 left-3 md:left-4 z-30 w-[19rem] max-h-[80vh] flex flex-col bg-slate-950/95 backdrop-blur-xl border border-amber-500/40 rounded-2xl shadow-2xl overflow-hidden">
      <header className="px-3 py-2 flex items-center gap-2 border-b border-slate-800 bg-gradient-to-r from-amber-500/10 to-transparent">
        <span className="text-amber-400 text-base leading-none">⟜</span>
        <div className="flex-1">
          <div className="text-xs font-bold uppercase tracking-widest text-amber-200">Great-Circle Ruler</div>
          <div className="text-[10px] text-slate-500">Click map to drop waypoints</div>
        </div>
        <button onClick={() => setPts([])} className="text-[10px] uppercase tracking-widest px-2 py-1 rounded-md bg-slate-800/60 hover:bg-slate-700/70 text-slate-300">Clear</button>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-base leading-none px-1">✕</button>
      </header>

      <div className="px-3 py-2 grid grid-cols-3 gap-2 text-center border-b border-slate-800">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Legs</div>
          <div className="text-sm font-bold font-mono text-slate-100">{legs.length}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Total</div>
          <div className="text-sm font-bold font-mono text-amber-300">{fmtNm(totalNm)}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Cursor</div>
          <div className="text-sm font-bold font-mono text-slate-300">{pendingNm > 0 ? `+${fmtNm(pendingNm)}` : '—'}</div>
        </div>
      </div>

      {totalNm > 0 && (
        <div className="px-3 py-2 grid grid-cols-3 gap-2 text-center border-b border-slate-800 bg-slate-900/40">
          <KM label="km" v={(totalNm * NM_TO_KM).toFixed(0)} />
          <KM label="mi" v={(totalNm * NM_TO_MI).toFixed(0)} />
          <KM label="@ M0.78" v={fmtDuration(totalNm / 450)} />
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {pts.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-slate-500">
            Click the map to start measuring.<br />
            <span className="text-slate-600">Backspace = undo · Esc = exit</span>
          </div>
        )}
        {pts.length === 1 && (
          <div className="px-3 py-4 text-center text-[11px] text-slate-500">
            Point 1 set at <span className="text-slate-300 font-mono">{fmtLL(pts[0])}</span>.<br />
            Click again to draw a leg.
          </div>
        )}
        {legs.length > 0 && (
          <ul className="divide-y divide-slate-900">
            {legs.map((l, i) => (
              <li key={i} className="px-3 py-2 flex items-center gap-2 text-xs hover:bg-slate-900/60">
                <div className="font-mono text-[10px] text-slate-500 w-12 shrink-0">{l.from}→{l.to}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-slate-100 text-xs font-bold">{fmtNm(l.nm)}</div>
                  <div className="text-[10px] text-slate-500">
                    {(l.nm * NM_TO_KM).toFixed(0)} km · {compass(l.brg)} {l.brg.toFixed(0)}°
                  </div>
                </div>
                <button
                  onClick={() => setPts(p => p.filter((_, idx) => idx !== i + 1))}
                  className="text-slate-600 hover:text-rose-400 text-xs"
                  title="Remove waypoint"
                >✕</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="px-3 py-1.5 text-[10px] text-slate-500 border-t border-slate-800 bg-slate-900/40 flex items-center justify-between">
        <span>{pts.length} waypoint{pts.length === 1 ? '' : 's'}</span>
        <span className="font-mono">{hover ? fmtLL(hover) : '—'}</span>
      </footer>
    </div>
  )
}

function KM({ label, v }: { label: string; v: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className="text-xs font-bold font-mono text-slate-200">{v}</div>
    </div>
  )
}

function fmtNm(n: number): string {
  if (n < 10) return `${n.toFixed(1)} nm`
  return `${Math.round(n).toLocaleString()} nm`
}
function fmtLL(p: Pt): string {
  return `${p.lat.toFixed(3)}, ${p.lng.toFixed(3)}`
}
function fmtDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  return `${h}h ${m.toString().padStart(2, '0')}m`
}
function compass(deg: number): string {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
  return dirs[Math.round(((deg % 360) / 22.5)) % 16]
}
