'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   Reachability Atlas
   -----------------------------------------------------------
   For the SELECTED aircraft, computes a kinematic reachable
   set (Dubins-car-style) at 4 time horizons (default 5/15/
   30/60 min) given current ground speed and a turn radius
   derived from a configurable maximum bank angle:
       R_nm = V^2 / (g * tan(bank)) -> converted to nm.
   For each bearing θ around the aircraft we compute the
   minimum turn-time required to reorient onto θ:
       t_turn(θ) = R * |Δθ| / V
   leaving t_fwd = max(0, T - t_turn). The reachable radius
   in bearing θ is then V * t_fwd, producing a teardrop/
   limacon that fills out to a full disk once T exceeds the
   π·R/V "U-turn" time.

   We render 4 nested polygons on MapLibre (innermost = sooner)
   with tier-colored fill, plus stroke and per-tier labels at
   the polygon "tip". The side panel ranks every airport inside
   any horizon by reachable-time, with per-row tier stripe,
   ETA, range, off-track angle and click-to-fly.
   ============================================================ */

export interface ReachFlight {
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
  flights: ReachFlight[]
  selectedIcao: string | null
  onClose: () => void
  onFlyAirport: (lat: number, lng: number) => void
}

const R_NM = 3440.065
const RAD = Math.PI / 180
const DEG = 180 / Math.PI
const G_NMPS2 = 9.80665 / 1852  // m/s^2 -> nm/s^2

function distNm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const φ1 = lat1 * RAD, φ2 = lat2 * RAD
  const dφ = (lat2 - lat1) * RAD
  const dλ = (lng2 - lng1) * RAD
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(s)))
}
function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number) {
  const φ1 = lat1 * RAD, φ2 = lat2 * RAD
  const dλ = (lng2 - lng1) * RAD
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * DEG + 360) % 360
}
function dest(lat: number, lng: number, brg: number, nm: number): [number, number] {
  const d = nm / R_NM
  const φ1 = lat * RAD, λ1 = lng * RAD, θ = brg * RAD
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(d) * Math.cos(φ1),
                             Math.cos(d) - Math.sin(φ1) * Math.sin(φ2))
  let lng2 = λ2 * DEG
  lng2 = ((lng2 + 540) % 360) - 180
  return [lng2, φ2 * DEG]
}

function fmtT(s: number) {
  if (!isFinite(s) || s < 0) return '—'
  const m = Math.floor(s / 60), ss = Math.floor(s % 60)
  return `${m}:${String(ss).padStart(2, '0')}`
}

/* MapLibre layer IDs (in z-order: outermost fill first, innermost last) */
const TIERS = [
  { id: 0, min: 60, label: '60m', fill: '#7c3aed', stroke: '#a78bfa', opacity: 0.10 },
  { id: 1, min: 30, label: '30m', fill: '#0891b2', stroke: '#22d3ee', opacity: 0.13 },
  { id: 2, min: 15, label: '15m', fill: '#16a34a', stroke: '#4ade80', opacity: 0.16 },
  { id: 3, min: 5,  label: '5m',  fill: '#f59e0b', stroke: '#fbbf24', opacity: 0.20 },
]

const SRC_FILL = (i: number) => `ra-fill-src-${i}`
const LYR_FILL = (i: number) => `ra-fill-lyr-${i}`
const LYR_LINE = (i: number) => `ra-line-lyr-${i}`
const SRC_LABEL = 'ra-label-src'
const LYR_LABEL = 'ra-label-lyr'

interface ReachHit {
  iata: string; icao: string; name: string; city: string
  lat: number; lng: number
  rangeNm: number
  offTrackDeg: number
  tierIdx: number          // smallest tier (= soonest)
  reachSec: number         // total time to reach (turn + straight)
}

export default function ReachAtlas({ map, flights, selectedIcao, onClose, onFlyAirport }: Props) {
  const [bankDeg, setBankDeg] = useState<number>(25)
  const [enabled, setEnabled] = useState<boolean[]>([true, true, true, true])
  const [query, setQuery] = useState<string>('')
  const [showOverlay, setShowOverlay] = useState<boolean>(true)
  const [sortBy, setSortBy] = useState<'time' | 'range' | 'name'>('time')
  const installedRef = useRef<boolean>(false)

  const flight = useMemo(() =>
    flights.find(f => f.icao === selectedIcao && !f.ground && f.velocityKts > 30) || null,
    [flights, selectedIcao]
  )

  // Turn radius in nm: R = V^2 / (g * tan(bank))
  const turnRadiusNm = useMemo(() => {
    if (!flight) return 0
    const vNmPerSec = flight.velocityKts / 3600
    const tanB = Math.tan(bankDeg * RAD)
    if (tanB < 1e-6) return 1e6
    return (vNmPerSec * vNmPerSec) / (G_NMPS2 * tanB)
  }, [flight, bankDeg])

  /* Build all 4 reachability polygons. We sample 72 bearings (5°). */
  const polys = useMemo(() => {
    if (!flight) return null
    const v = flight.velocityKts / 3600 // nm/s
    const R = turnRadiusNm              // nm
    const SAMPLES = 72
    const out: Array<{ tierIdx: number; min: number; ring: Array<[number, number]>; maxRangeNm: number; maxBrg: number }> = []
    for (let ti = 0; ti < TIERS.length; ti++) {
      const T = TIERS[ti].min * 60
      const ring: Array<[number, number]> = []
      let maxR = 0, maxBrg = flight.track
      for (let i = 0; i < SAMPLES; i++) {
        const brg = (i / SAMPLES) * 360
        let dθ = ((brg - flight.track + 540) % 360) - 180   // -180..180
        const turnSec = (R * Math.abs(dθ) * RAD) / v
        const fwd = Math.max(0, T - turnSec)
        const r = v * fwd
        if (r > maxR) { maxR = r; maxBrg = brg }
        ring.push(dest(flight.lat, flight.lng, brg, r))
      }
      ring.push(ring[0])
      out.push({ tierIdx: ti, min: TIERS[ti].min, ring, maxRangeNm: maxR, maxBrg })
    }
    return out
  }, [flight, turnRadiusNm])

  /* Compute airport hits inside any reachable horizon. */
  const hits = useMemo<ReachHit[]>(() => {
    if (!flight || !polys) return []
    const v = flight.velocityKts / 3600
    const R = turnRadiusNm
    const out: ReachHit[] = []
    // Bounding pre-filter: ignore airports beyond 60min max forward distance.
    const maxNm = (TIERS[0].min * 60) * v
    const cosLatF = Math.cos(flight.lat * RAD)
    const dLatMax = maxNm / 60
    for (const ap of AIRPORTS) {
      const dLat = ap.lat - flight.lat
      if (Math.abs(dLat) > dLatMax) continue
      const dLng = ((ap.lon - flight.lng + 540) % 360) - 180
      if (Math.abs(dLng) * cosLatF * 60 > maxNm) continue
      const r = distNm(flight.lat, flight.lng, ap.lat, ap.lon)
      if (r > maxNm) continue
      const brg = bearingDeg(flight.lat, flight.lng, ap.lat, ap.lon)
      const dθ = ((brg - flight.track + 540) % 360) - 180
      const turnSec = (R * Math.abs(dθ) * RAD) / v
      const fwdSec = r / v
      const reachSec = turnSec + fwdSec
      // Find smallest tier whose horizon covers it
      let tierIdx = -1
      for (let i = TIERS.length - 1; i >= 0; i--) {
        if (reachSec <= TIERS[i].min * 60) { tierIdx = i; break }
      }
      if (tierIdx < 0) continue
      out.push({
        iata: ap.a || ap.i, icao: ap.i, name: ap.n || ap.m, city: ap.m,
        lat: ap.lat, lng: ap.lon, rangeNm: r,
        offTrackDeg: Math.abs(dθ),
        tierIdx, reachSec,
      })
    }
    return out
  }, [flight, polys, turnRadiusNm])

  const filteredHits = useMemo(() => {
    const q = query.trim().toUpperCase()
    let rows = hits.filter(h => enabled[h.tierIdx])
    if (q) rows = rows.filter(h =>
      h.iata.toUpperCase().includes(q) || h.icao.toUpperCase().includes(q) ||
      h.city.toUpperCase().includes(q) || h.name.toUpperCase().includes(q)
    )
    if (sortBy === 'time') rows.sort((a, b) => a.reachSec - b.reachSec)
    else if (sortBy === 'range') rows.sort((a, b) => a.rangeNm - b.rangeNm)
    else rows.sort((a, b) => a.iata.localeCompare(b.iata))
    return rows
  }, [hits, query, enabled, sortBy])

  /* Install MapLibre layers once. */
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        const empty = { type: 'FeatureCollection' as const, features: [] }
        for (let i = 0; i < TIERS.length; i++) {
          if (!map.getSource(SRC_FILL(i))) map.addSource(SRC_FILL(i), { type: 'geojson', data: empty })
          if (!map.getLayer(LYR_FILL(i))) map.addLayer({
            id: LYR_FILL(i), type: 'fill', source: SRC_FILL(i),
            paint: { 'fill-color': TIERS[i].fill, 'fill-opacity': TIERS[i].opacity }
          })
          if (!map.getLayer(LYR_LINE(i))) map.addLayer({
            id: LYR_LINE(i), type: 'line', source: SRC_FILL(i),
            paint: { 'line-color': TIERS[i].stroke, 'line-opacity': 0.85, 'line-width': 1.5, 'line-dasharray': [2, 2] }
          })
        }
        if (!map.getSource(SRC_LABEL)) map.addSource(SRC_LABEL, { type: 'geojson', data: empty })
        if (!map.getLayer(LYR_LABEL)) map.addLayer({
          id: LYR_LABEL, type: 'symbol', source: SRC_LABEL,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 11,
            'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            'text-offset': [0, 0],
          },
          paint: {
            'text-color': ['get', 'color'],
            'text-halo-color': '#0f172a',
            'text-halo-width': 1.6,
          }
        })
        installedRef.current = true
      } catch {}
    }
    if (map.isStyleLoaded()) ensure()
    else map.once('load', ensure)
    return () => {
      try {
        for (let i = 0; i < TIERS.length; i++) {
          if (map.getLayer(LYR_LINE(i))) map.removeLayer(LYR_LINE(i))
          if (map.getLayer(LYR_FILL(i))) map.removeLayer(LYR_FILL(i))
          if (map.getSource(SRC_FILL(i))) map.removeSource(SRC_FILL(i))
        }
        if (map.getLayer(LYR_LABEL)) map.removeLayer(LYR_LABEL)
        if (map.getSource(SRC_LABEL)) map.removeSource(SRC_LABEL)
      } catch {}
      installedRef.current = false
    }
  }, [map])

  /* Push geometry every time inputs change. */
  useEffect(() => {
    if (!map || !installedRef.current) return
    const labelFeats: any[] = []
    for (let i = 0; i < TIERS.length; i++) {
      const src = map.getSource(SRC_FILL(i)) as maplibregl.GeoJSONSource | undefined
      if (!src) continue
      if (!showOverlay || !flight || !polys || !enabled[i]) {
        src.setData({ type: 'FeatureCollection', features: [] })
        continue
      }
      const p = polys[i]
      src.setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [p.ring] },
          properties: {},
        }],
      })
      // Tier label at the tip (max-range bearing)
      const [lng, lat] = dest(flight.lat, flight.lng, p.maxBrg, Math.max(p.maxRangeNm - 2, 0))
      labelFeats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties: { label: `${TIERS[i].label} ${p.maxRangeNm.toFixed(0)}nm`, color: TIERS[i].stroke },
      })
    }
    const labelSrc = map.getSource(SRC_LABEL) as maplibregl.GeoJSONSource | undefined
    if (labelSrc) labelSrc.setData({ type: 'FeatureCollection', features: showOverlay && flight ? labelFeats : [] })
  }, [map, flight, polys, enabled, showOverlay])

  /* Per-tier counters */
  const tierCounts = useMemo(() => {
    const c = [0, 0, 0, 0]
    for (const h of hits) c[h.tierIdx]++
    return c
  }, [hits])

  return (
    <div className="absolute top-14 right-3 z-30 w-[360px] max-h-[calc(100vh-5rem)] flex flex-col rounded-xl border border-slate-700 bg-slate-900/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">REACH</span>
          <span className="text-sm font-semibold">Reachability Atlas</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none px-2">×</button>
      </div>

      {!flight && (
        <div className="px-3 py-6 text-xs text-slate-400 text-center">
          Select an airborne aircraft to compute its kinematic reachable footprint and find every airport it can divert to within 5/15/30/60min.
        </div>
      )}

      {flight && (
        <>
          <div className="px-3 py-2 border-b border-slate-700 text-[11px] font-mono grid grid-cols-3 gap-2">
            <div>
              <div className="text-slate-500 text-[9px]">CALLSIGN</div>
              <div className="text-cyan-300">{flight.callsign || flight.icao}</div>
            </div>
            <div>
              <div className="text-slate-500 text-[9px]">GS / TRK</div>
              <div>{Math.round(flight.velocityKts)}kt / {Math.round(flight.track)}°</div>
            </div>
            <div>
              <div className="text-slate-500 text-[9px]">TURN R</div>
              <div className="text-amber-300">{turnRadiusNm.toFixed(1)}nm</div>
            </div>
          </div>

          <div className="px-3 py-2 border-b border-slate-700">
            <div className="grid grid-cols-4 gap-1.5">
              {TIERS.map((t, i) => (
                <button
                  key={t.id}
                  onClick={() => setEnabled(prev => prev.map((v, idx) => idx === i ? !v : v))}
                  className={`rounded px-1.5 py-1 text-[10px] font-mono border transition ${
                    enabled[i]
                      ? 'border-slate-600 bg-slate-800'
                      : 'border-slate-800 bg-slate-900/50 opacity-50'
                  }`}
                  style={enabled[i] ? { borderColor: t.stroke, color: t.stroke } : {}}
                >
                  <div className="text-[11px] font-bold">{t.label}</div>
                  <div className="text-slate-400">{tierCounts[i]} apt</div>
                </button>
              ))}
            </div>
          </div>

          <div className="px-3 py-2 border-b border-slate-700 space-y-2">
            <label className="block">
              <div className="flex justify-between text-[10px] text-slate-400">
                <span>BANK ANGLE</span><span className="font-mono text-slate-200">{bankDeg}°</span>
              </div>
              <input
                type="range" min={15} max={45} step={1}
                value={bankDeg} onChange={e => setBankDeg(+e.target.value)}
                className="w-full accent-violet-500"
              />
            </label>
            <div className="flex items-center justify-between text-[10px]">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={showOverlay} onChange={e => setShowOverlay(e.target.checked)} />
                <span>Map overlay</span>
              </label>
              <div className="flex items-center gap-1">
                {(['time','range','name'] as const).map(s => (
                  <button
                    key={s}
                    onClick={() => setSortBy(s)}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                      sortBy === s ? 'border-violet-500 bg-violet-500/20 text-violet-200' : 'border-slate-700 text-slate-400'
                    }`}
                  >{s}</button>
                ))}
              </div>
            </div>
            <input
              type="text" placeholder="Filter IATA / city / name"
              value={query} onChange={e => setQuery(e.target.value)}
              className="w-full text-[11px] bg-slate-800 border border-slate-700 rounded px-2 py-1 focus:outline-none focus:border-violet-500"
            />
          </div>

          <div className="flex-1 overflow-y-auto px-2 py-1.5">
            {filteredHits.length === 0 && (
              <div className="text-center text-[11px] text-slate-500 py-6">No airports in selected horizons.</div>
            )}
            {filteredHits.map((h, idx) => {
              const t = TIERS[h.tierIdx]
              return (
                <button
                  key={h.icao + idx}
                  onClick={() => onFlyAirport(h.lat, h.lng)}
                  className="w-full text-left px-2 py-1.5 rounded mb-1 bg-slate-800/60 hover:bg-slate-800 border border-slate-700/70 transition"
                  style={{ borderLeftColor: t.stroke, borderLeftWidth: 3 }}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono font-bold text-[12px] text-slate-100">{h.iata}</span>
                      <span className="text-[10px] text-slate-400 font-mono">{h.icao}</span>
                    </div>
                    <span className="text-[10px] font-mono" style={{ color: t.stroke }}>{t.label}</span>
                  </div>
                  <div className="text-[10px] text-slate-300 truncate">{h.city} {h.name && h.name !== h.city ? `· ${h.name}` : ''}</div>
                  <div className="flex items-center gap-3 text-[10px] font-mono text-slate-400 mt-0.5">
                    <span>ETA <span className="text-cyan-300">{fmtT(h.reachSec)}</span></span>
                    <span>{h.rangeNm.toFixed(0)}nm</span>
                    <span>off {h.offTrackDeg.toFixed(0)}°</span>
                  </div>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
