'use client'
import { useMemo } from 'react'
import type { Map as MLMap } from 'maplibre-gl'

/* ============================================================
   Density Heatmap — MapLibre-native heatmap overlay of all live
   traffic with selectable weighting (count / altitude / speed /
   emergency), tunable radius/intensity, and a live hotspot
   leaderboard panel that buckets aircraft into geographic cells
   and ranks the busiest neighborhoods on the map. Click a
   hotspot to fly the map there.
   ============================================================ */

export type HeatMode = 'count' | 'alt' | 'speed' | 'emerg'

export interface HeatFlight {
  icao: string
  callsign: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  ground: boolean
  emergency?: string | boolean | null
  military?: boolean
}

const SRC_ID = 'density-heat-src'
const LAYER_ID = 'density-heat-layer'

function weightFor(f: HeatFlight, mode: HeatMode): number {
  switch (mode) {
    case 'count': return 1
    case 'alt':   return Math.max(0.05, Math.min(1, f.altitudeFt / 45000))
    case 'speed': return Math.max(0.05, Math.min(1, f.velocityKts / 600))
    case 'emerg': return f.emergency && f.emergency !== 'none' ? 1 : (f.military ? 0.35 : 0.05)
  }
}

function toGeoJson(flights: HeatFlight[], mode: HeatMode, includeGround: boolean): GeoJSON.FeatureCollection {
  const feats: GeoJSON.Feature[] = []
  for (const f of flights) {
    if (!includeGround && f.ground) continue
    if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
    feats.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [f.lng, f.lat] },
      properties: { w: weightFor(f, mode) },
    })
  }
  return { type: 'FeatureCollection', features: feats }
}

export function installHeat(map: MLMap) {
  if (map.getSource(SRC_ID)) return
  map.addSource(SRC_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  })
  // Place beneath plane icons by inserting before the first symbol layer.
  let before: string | undefined
  try {
    const layers = map.getStyle().layers || []
    for (const l of layers) {
      if (l.type === 'symbol') { before = l.id; break }
    }
  } catch {}
  map.addLayer({
    id: LAYER_ID,
    type: 'heatmap',
    source: SRC_ID,
    layout: { visibility: 'none' },
    paint: {
      'heatmap-weight': ['get', 'w'],
      'heatmap-intensity': [
        'interpolate', ['linear'], ['zoom'],
        0, 0.4, 4, 0.9, 8, 1.6, 12, 2.4,
      ],
      'heatmap-radius': [
        'interpolate', ['linear'], ['zoom'],
        0, 10, 4, 18, 8, 32, 12, 56,
      ],
      'heatmap-opacity': [
        'interpolate', ['linear'], ['zoom'],
        0, 0.85, 9, 0.75, 13, 0.35,
      ],
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0,    'rgba(8,12,40,0)',
        0.15, 'rgba(56,189,248,0.55)',
        0.35, 'rgba(34,211,238,0.75)',
        0.55, 'rgba(132,204,22,0.85)',
        0.75, 'rgba(250,204,21,0.95)',
        0.9,  'rgba(249,115,22,1)',
        1,    'rgba(244,63,94,1)',
      ],
    },
  }, before)
}

export function updateHeat(map: MLMap, flights: HeatFlight[], mode: HeatMode, includeGround: boolean) {
  const src = map.getSource(SRC_ID) as maplibregl.GeoJSONSource | undefined
  if (!src) return
  try { src.setData(toGeoJson(flights, mode, includeGround) as any) } catch {}
}

export function setHeatVisibility(map: MLMap, on: boolean) {
  if (!map.getLayer(LAYER_ID)) return
  map.setLayoutProperty(LAYER_ID, 'visibility', on ? 'visible' : 'none')
}

export function setHeatRadius(map: MLMap, scale: number) {
  if (!map.getLayer(LAYER_ID)) return
  const s = Math.max(0.3, Math.min(3, scale))
  map.setPaintProperty(LAYER_ID, 'heatmap-radius', [
    'interpolate', ['linear'], ['zoom'],
    0, 10 * s, 4, 18 * s, 8, 32 * s, 12, 56 * s,
  ])
}

export function setHeatIntensity(map: MLMap, scale: number) {
  if (!map.getLayer(LAYER_ID)) return
  const s = Math.max(0.3, Math.min(3, scale))
  map.setPaintProperty(LAYER_ID, 'heatmap-intensity', [
    'interpolate', ['linear'], ['zoom'],
    0, 0.4 * s, 4, 0.9 * s, 8, 1.6 * s, 12, 2.4 * s,
  ])
}

export function removeHeat(map: MLMap) {
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID)
  if (map.getSource(SRC_ID)) map.removeSource(SRC_ID)
}

// ---------------- Hotspot leaderboard ----------------

export interface HotCell {
  key: string
  lat: number
  lng: number
  count: number
  avgAltFt: number
  maxAltFt: number
  avgKts: number
  emergencies: number
  military: number
  sample: HeatFlight[]
}

export function computeHotspots(flights: HeatFlight[], cellDeg: number, includeGround: boolean): HotCell[] {
  const grid = new Map<string, HotCell>()
  for (const f of flights) {
    if (!includeGround && f.ground) continue
    if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
    const cy = Math.floor(f.lat / cellDeg)
    const cx = Math.floor(f.lng / cellDeg)
    const key = `${cy}|${cx}`
    let c = grid.get(key)
    if (!c) {
      c = {
        key,
        lat: (cy + 0.5) * cellDeg,
        lng: (cx + 0.5) * cellDeg,
        count: 0, avgAltFt: 0, maxAltFt: 0, avgKts: 0,
        emergencies: 0, military: 0, sample: [],
      }
      grid.set(key, c)
    }
    c.count++
    c.avgAltFt += f.altitudeFt
    c.avgKts   += f.velocityKts
    if (f.altitudeFt > c.maxAltFt) c.maxAltFt = f.altitudeFt
    if (f.emergency && f.emergency !== 'none') c.emergencies++
    if (f.military) c.military++
    if (c.sample.length < 8) c.sample.push(f)
  }
  const out: HotCell[] = []
  for (const c of grid.values()) {
    c.avgAltFt = c.avgAltFt / c.count
    c.avgKts   = c.avgKts   / c.count
    out.push(c)
  }
  out.sort((a, b) => b.count - a.count)
  return out
}

// ---------------- Side panel UI ----------------

interface PanelProps {
  flights: HeatFlight[]
  mode: HeatMode
  setMode: (m: HeatMode) => void
  includeGround: boolean
  setIncludeGround: (b: boolean) => void
  radiusScale: number
  setRadiusScale: (n: number) => void
  intensityScale: number
  setIntensityScale: (n: number) => void
  cellDeg: number
  setCellDeg: (n: number) => void
  onFly: (lat: number, lng: number) => void
  onClose: () => void
}

const MODES: { k: HeatMode; label: string; hint: string }[] = [
  { k: 'count', label: 'Count',     hint: 'aircraft density' },
  { k: 'alt',   label: 'Altitude',  hint: 'weighted by FL' },
  { k: 'speed', label: 'Speed',     hint: 'weighted by GS' },
  { k: 'emerg', label: 'Emerg/Mil', hint: 'special interest' },
]

export default function DensityHeatPanel(p: PanelProps) {
  const hot = useMemo(
    () => computeHotspots(p.flights, p.cellDeg, p.includeGround).slice(0, 20),
    [p.flights, p.cellDeg, p.includeGround],
  )
  const total = hot.reduce((a, c) => a + c.count, 0)
  const max = hot[0]?.count || 1

  return (
    <div className="fixed top-20 right-3 md:right-4 z-30 w-[320px] max-h-[calc(100vh-120px)]
                    bg-slate-950/92 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl
                    flex flex-col overflow-hidden text-slate-200">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
          <div className="text-[11px] font-semibold tracking-widest uppercase text-orange-300">
            Density Heat
          </div>
        </div>
        <button onClick={p.onClose}
          className="text-slate-500 hover:text-slate-200 text-lg leading-none px-1">×</button>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-1">
          {MODES.map(m => (
            <button key={m.k} onClick={() => p.setMode(m.k)}
              title={m.hint}
              className={`text-[10px] uppercase tracking-wider px-2 py-1.5 rounded border transition
                ${p.mode === m.k
                  ? 'bg-orange-500/20 border-orange-400/50 text-orange-200'
                  : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200'}`}>
              {m.label}
            </button>
          ))}
        </div>

        <label className="block text-[9px] uppercase tracking-widest text-slate-500">
          Radius ×{p.radiusScale.toFixed(2)}
          <input type="range" min={0.4} max={2.5} step={0.05}
            value={p.radiusScale}
            onChange={e => p.setRadiusScale(Number(e.target.value))}
            className="w-full accent-orange-400" />
        </label>
        <label className="block text-[9px] uppercase tracking-widest text-slate-500">
          Intensity ×{p.intensityScale.toFixed(2)}
          <input type="range" min={0.4} max={2.5} step={0.05}
            value={p.intensityScale}
            onChange={e => p.setIntensityScale(Number(e.target.value))}
            className="w-full accent-orange-400" />
        </label>
        <label className="block text-[9px] uppercase tracking-widest text-slate-500">
          Hotspot cell {p.cellDeg.toFixed(1)}°
          <input type="range" min={0.2} max={5} step={0.1}
            value={p.cellDeg}
            onChange={e => p.setCellDeg(Number(e.target.value))}
            className="w-full accent-orange-400" />
        </label>

        <label className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-slate-400">
          <input type="checkbox" checked={p.includeGround}
            onChange={e => p.setIncludeGround(e.target.checked)}
            className="accent-orange-400" />
          Include ground traffic
        </label>
      </div>

      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800
                      text-[9px] uppercase tracking-widest text-slate-500">
        <span>Top hotspots</span>
        <span>{total} in {hot.length} cells</span>
      </div>

      <div className="overflow-y-auto flex-1 divide-y divide-slate-900/80">
        {hot.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-slate-500">
            No traffic in view.
          </div>
        )}
        {hot.map((c, i) => {
          const pct = (c.count / max) * 100
          return (
            <button key={c.key}
              onClick={() => p.onFly(c.lat, c.lng)}
              className="w-full text-left px-3 py-2 hover:bg-slate-900/70 transition group">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] tabular-nums text-slate-500 w-5">{i + 1}</span>
                <span className="text-[11px] font-mono text-slate-200">
                  {c.lat.toFixed(1)}°, {c.lng.toFixed(1)}°
                </span>
                <span className="ml-auto text-[11px] tabular-nums text-orange-300 font-semibold">
                  {c.count}
                </span>
              </div>
              <div className="h-1 rounded bg-slate-900 overflow-hidden mb-1">
                <div className="h-full bg-gradient-to-r from-cyan-500 via-amber-400 to-rose-500"
                     style={{ width: `${pct}%` }} />
              </div>
              <div className="flex items-center gap-2 text-[9px] uppercase tracking-wider text-slate-500">
                <span>avg FL{Math.round(c.avgAltFt / 100).toString().padStart(3, '0')}</span>
                <span>·</span>
                <span>{Math.round(c.avgKts)}kt</span>
                {c.emergencies > 0 && (
                  <span className="ml-auto text-rose-400">EMRG {c.emergencies}</span>
                )}
                {c.military > 0 && c.emergencies === 0 && (
                  <span className="ml-auto text-amber-400">MIL {c.military}</span>
                )}
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] uppercase tracking-widest
                      text-slate-500 flex items-center justify-between">
        <span>Click cell → fly to</span>
        <span className="text-slate-600">cake</span>
      </div>
    </div>
  )
}
