'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   Trip Planner
   -----------------------------------------------------------
   Pick an ORIGIN and DESTINATION airport from the master list.
   We compute:
     - True great-circle route, segmented into N legs (default 12)
     - Per-leg distance, true track, and a sampled wind vector
       gathered from live aircraft DAP reports within `sampleRadiusNm`
       of each leg midpoint AND within +/- 4000ft of cruise altitude,
       then vector-averaged (weighted by 1/(1+dist_nm/100)).
     - Headwind / tailwind / crosswind per leg
     - Ground speed = TAS - headwind (no crab GS approx)
     - Cumulative fuel burn from a class-based fuel-flow table
       (heavy/narrow/regional/biz) at cruise.
     - ETA and CO2 (3.16 kg CO2 per kg jet-A).
   Side panel: airport pickers (filter + click), TAS / cruise FL /
   class selectors, per-leg table with HDG / GS / dist / wind / fuel,
   summary header with total dist / time / fuel / CO2.
   MapLibre overlay paints the route as a cyan geodesic line with
   leg waypoints (small dots), origin/destination pins, and per-leg
   barbs colored by headwind sign.
   ============================================================ */

export interface TripFlight {
  icao: string
  lat: number
  lng: number
  altitudeFt: number
  ground: boolean
  windDir?: number
  windKts?: number
}

interface Props {
  map: maplibregl.Map | null
  flights: TripFlight[]
  onClose: () => void
}

const R_NM = 3440.065
const RAD = Math.PI / 180
const DEG = 180 / Math.PI

const FUEL_FLOW: Record<string, { tas: number; ffKgHr: number; label: string }> = {
  heavy:    { tas: 480, ffKgHr: 6800, label: 'Heavy (777/A350)' },
  narrow:   { tas: 450, ffKgHr: 2500, label: 'Narrow (A320/737)' },
  regional: { tas: 420, ffKgHr: 1100, label: 'Regional (E190/CRJ)' },
  biz:      { tas: 460, ffKgHr:  900, label: 'Business (G650/Falcon)' },
}

function gcDistNm(a: [number, number], b: [number, number]) {
  const [lon1, lat1] = a, [lon2, lat2] = b
  const p1 = lat1 * RAD, p2 = lat2 * RAD
  const dp = (lat2 - lat1) * RAD, dl = (lon2 - lon1) * RAD
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(x)))
}
function bearingDeg(a: [number, number], b: [number, number]) {
  const [lon1, lat1] = a, [lon2, lat2] = b
  const p1 = lat1 * RAD, p2 = lat2 * RAD
  const dl = (lon2 - lon1) * RAD
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return (Math.atan2(y, x) * DEG + 360) % 360
}
function gcInterp(a: [number, number], b: [number, number], f: number): [number, number] {
  const [lon1, lat1] = a, [lon2, lat2] = b
  const p1 = lat1 * RAD, p2 = lat2 * RAD
  const l1 = lon1 * RAD, l2 = lon2 * RAD
  const dp = p2 - p1, dl = l2 - l1
  const aa = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  const d = 2 * Math.asin(Math.min(1, Math.sqrt(aa)))
  if (d < 1e-9) return [lon1, lat1]
  const A = Math.sin((1 - f) * d) / Math.sin(d)
  const B = Math.sin(f * d) / Math.sin(d)
  const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2)
  const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2)
  const z = A * Math.sin(p1) + B * Math.sin(p2)
  const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) * DEG
  const lon = Math.atan2(y, x) * DEG
  return [lon, lat]
}

export default function TripPlanner({ map, flights, onClose }: Props) {
  const [origin, setOrigin] = useState<string | null>(null)
  const [dest, setDest] = useState<string | null>(null)
  const [activePicker, setActivePicker] = useState<'origin' | 'dest'>('origin')
  const [query, setQuery] = useState('')
  const [legs, setLegs] = useState(12)
  const [cls, setCls] = useState<keyof typeof FUEL_FLOW>('narrow')
  const [cruiseFL, setCruiseFL] = useState(360)
  const [tasOverride, setTasOverride] = useState<number | null>(null)
  const [sampleRadiusNm, setSampleRadiusNm] = useState(250)

  const oAp = useMemo(() => AIRPORTS.find(a => a.i === origin) || null, [origin])
  const dAp = useMemo(() => AIRPORTS.find(a => a.i === dest) || null, [dest])

  const filteredAps = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return AIRPORTS.slice(0, 80)
    return AIRPORTS.filter(a =>
      a.i.toLowerCase().includes(q) ||
      a.a.toLowerCase().includes(q) ||
      a.m.toLowerCase().includes(q) ||
      a.n.toLowerCase().includes(q)
    ).slice(0, 80)
  }, [query])

  const profile = FUEL_FLOW[cls]
  const TAS = tasOverride ?? profile.tas
  const cruiseFt = cruiseFL * 100

  // Wind samplers
  const windSamples = useMemo(() => {
    return flights.filter(f =>
      !f.ground &&
      typeof f.windDir === 'number' && typeof f.windKts === 'number' && f.windKts! >= 0 &&
      Math.abs(f.altitudeFt - cruiseFt) <= 4000
    )
  }, [flights, cruiseFt])

  // Build legs
  const route = useMemo(() => {
    if (!oAp || !dAp) return null
    const A: [number, number] = [oAp.lon, oAp.lat]
    const B: [number, number] = [dAp.lon, dAp.lat]
    const totalNm = gcDistNm(A, B)
    const pts: [number, number][] = []
    for (let i = 0; i <= legs; i++) pts.push(gcInterp(A, B, i / legs))
    const out: Array<{
      idx: number
      from: [number, number]
      to: [number, number]
      mid: [number, number]
      distNm: number
      trackDeg: number
      windDir: number | null
      windKts: number | null
      sampleN: number
      hwKt: number
      xwKt: number
      gsKt: number
      minHr: number
      fuelKg: number
    }> = []
    let cumMin = 0, cumFuel = 0
    for (let i = 0; i < legs; i++) {
      const a = pts[i], b = pts[i + 1]
      const dist = gcDistNm(a, b)
      const trk = bearingDeg(a, b)
      const mid = gcInterp(a, b, 0.5)
      // weighted vector wind avg
      let sx = 0, sy = 0, sw = 0, n = 0
      for (const w of windSamples) {
        const d = gcDistNm(mid, [w.lng, w.lat])
        if (d > sampleRadiusNm) continue
        const wt = 1 / (1 + d / 100)
        const dir = (w.windDir ?? 0) * RAD
        // meteorological wind: dir is FROM. Vector points TO = dir + 180.
        const to = dir + Math.PI
        sx += Math.sin(to) * w.windKts! * wt
        sy += Math.cos(to) * w.windKts! * wt
        sw += wt; n++
      }
      let wDir: number | null = null, wKt: number | null = null
      let hw = 0, xw = 0
      if (n > 0) {
        const vx = sx / sw, vy = sy / sw
        const speed = Math.hypot(vx, vy)
        const toBrg = (Math.atan2(vx, vy) * DEG + 360) % 360
        wDir = (toBrg + 180) % 360
        wKt = speed
        // headwind = -(wind_to component along aircraft track)
        const trkRad = trk * RAD
        const ax = Math.sin(trkRad), ay = Math.cos(trkRad)
        const along = vx * ax + vy * ay         // tailwind positive
        const cross = vx * ay - vy * ax
        hw = -along // headwind positive
        xw = cross
      }
      const gs = Math.max(50, TAS - hw)
      const hr = dist / gs
      const fuel = hr * profile.ffKgHr
      cumMin += hr * 60; cumFuel += fuel
      out.push({ idx: i + 1, from: a, to: b, mid, distNm: dist, trackDeg: trk, windDir: wDir, windKts: wKt, sampleN: n, hwKt: hw, xwKt: xw, gsKt: gs, minHr: hr * 60, fuelKg: fuel })
    }
    return { pts, totalNm, legs: out, totalMin: cumMin, totalFuel: cumFuel, co2Kg: cumFuel * 3.16 }
  }, [oAp, dAp, legs, windSamples, TAS, profile.ffKgHr, sampleRadiusNm])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const SRC = 'ft-trip-src', SRC_PT = 'ft-trip-pt'
    const ensure = () => {
      if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getSource(SRC_PT)) map.addSource(SRC_PT, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer('ft-trip-line')) {
        map.addLayer({ id: 'ft-trip-line', type: 'line', source: SRC,
          filter: ['==', ['get', 'kind'], 'leg'],
          paint: { 'line-color': ['case', ['<', ['get', 'hw'], -5], '#34d399', ['>', ['get', 'hw'], 5], '#f87171', '#22d3ee'], 'line-width': 3, 'line-opacity': 0.9 } } as any)
      }
      if (!map.getLayer('ft-trip-pt')) {
        map.addLayer({ id: 'ft-trip-pt', type: 'circle', source: SRC_PT,
          paint: {
            'circle-radius': ['case', ['==', ['get', 'kind'], 'end'], 7, 3],
            'circle-color': ['case', ['==', ['get', 'kind'], 'orig'], '#22d3ee', ['==', ['get', 'kind'], 'dest'], '#f59e0b', '#ffffff'],
            'circle-stroke-width': 1.5,
            'circle-stroke-color': '#0b1220',
            'circle-opacity': 0.95,
          } } as any)
      }
      if (!map.getLayer('ft-trip-label')) {
        map.addLayer({ id: 'ft-trip-label', type: 'symbol', source: SRC_PT,
          filter: ['==', ['get', 'kind'], 'end'],
          layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-offset': [0, -1.4], 'text-anchor': 'bottom', 'text-font': ['Noto Sans Bold'] },
          paint: { 'text-color': '#e5e7eb', 'text-halo-color': '#0b1220', 'text-halo-width': 1.4 } } as any)
      }
    }
    if (map.isStyleLoaded()) ensure(); else map.once('load', ensure)
    const sLine = map.getSource(SRC) as any
    const sPt = map.getSource(SRC_PT) as any
    if (!route || !sLine || !sPt) {
      sLine?.setData({ type: 'FeatureCollection', features: [] })
      sPt?.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    const legFeats = route.legs.map(L => ({
      type: 'Feature', properties: { kind: 'leg', hw: L.hwKt },
      geometry: { type: 'LineString', coordinates: [L.from, L.to] },
    }))
    sLine.setData({ type: 'FeatureCollection', features: legFeats })
    const ptFeats: any[] = []
    if (oAp) ptFeats.push({ type: 'Feature', properties: { kind: 'orig', label: `${oAp.a} ${oAp.i}` }, geometry: { type: 'Point', coordinates: [oAp.lon, oAp.lat] } })
    if (dAp) ptFeats.push({ type: 'Feature', properties: { kind: 'dest', label: `${dAp.a} ${dAp.i}` }, geometry: { type: 'Point', coordinates: [dAp.lon, dAp.lat] } })
    if (oAp) ptFeats.push({ type: 'Feature', properties: { kind: 'end', label: oAp.a }, geometry: { type: 'Point', coordinates: [oAp.lon, oAp.lat] } })
    if (dAp) ptFeats.push({ type: 'Feature', properties: { kind: 'end', label: dAp.a }, geometry: { type: 'Point', coordinates: [dAp.lon, dAp.lat] } })
    for (let i = 1; i < route.pts.length - 1; i++) ptFeats.push({ type: 'Feature', properties: { kind: 'wpt' }, geometry: { type: 'Point', coordinates: route.pts[i] } })
    sPt.setData({ type: 'FeatureCollection', features: ptFeats })
    return () => { /* keep layers; cleared on close below */ }
  }, [map, route, oAp, dAp])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const m = map
      if (!m) return
      try {
        for (const id of ['ft-trip-line', 'ft-trip-pt', 'ft-trip-label']) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of ['ft-trip-src', 'ft-trip-pt']) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map])

  const fitRoute = () => {
    if (!map || !oAp || !dAp) return
    try {
      const lats = [oAp.lat, dAp.lat], lons = [oAp.lon, dAp.lon]
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 120, duration: 900 })
    } catch {}
  }

  const fmtHM = (m: number) => `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, '0')}`

  return (
    <div className="absolute top-3 right-3 z-30 w-[440px] max-h-[88vh] flex flex-col rounded-xl border border-cyan-500/30 bg-slate-950/95 backdrop-blur text-slate-200 shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 bg-slate-900/80">
        <div className="flex items-center gap-2">
          <div className="text-xs tracking-widest text-cyan-300 font-bold">TRIP PLANNER</div>
          {route && <div className="text-[10px] text-slate-400">{route.totalNm.toFixed(0)}nm</div>}
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none px-2 py-0.5 rounded hover:bg-slate-800">✕</button>
      </div>

      {/* Picker tabs */}
      <div className="px-3 pt-2 flex gap-1">
        <button onClick={() => setActivePicker('origin')} className={`flex-1 text-[11px] px-2 py-1.5 rounded border ${activePicker === 'origin' ? 'border-cyan-400 bg-cyan-500/10 text-cyan-200' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
          ORIGIN {oAp ? `· ${oAp.a}` : ''}
        </button>
        <button onClick={() => setActivePicker('dest')} className={`flex-1 text-[11px] px-2 py-1.5 rounded border ${activePicker === 'dest' ? 'border-amber-400 bg-amber-500/10 text-amber-200' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
          DEST {dAp ? `· ${dAp.a}` : ''}
        </button>
        {(oAp && dAp) && <button onClick={fitRoute} className="text-[11px] px-2 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800">FIT</button>}
        {(oAp || dAp) && <button onClick={() => { setOrigin(null); setDest(null) }} className="text-[11px] px-2 py-1.5 rounded border border-slate-700 text-rose-300 hover:bg-slate-800">CLR</button>}
      </div>

      <div className="px-3 pt-2">
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search IATA / ICAO / city / name" className="w-full text-[11px] bg-slate-900 border border-slate-700 rounded px-2 py-1.5 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500" />
      </div>

      {/* Airport picker list */}
      <div className="px-3 pt-2 overflow-y-auto" style={{ maxHeight: 180 }}>
        <div className="grid grid-cols-1 gap-0.5">
          {filteredAps.map(a => {
            const picked = (activePicker === 'origin' ? origin : dest) === a.i
            return (
              <button key={a.i} onClick={() => {
                if (activePicker === 'origin') { setOrigin(a.i); if (!dest) setActivePicker('dest') }
                else setDest(a.i)
              }} className={`text-left flex items-center gap-2 px-2 py-1 rounded text-[11px] ${picked ? 'bg-cyan-500/15 text-cyan-100' : 'hover:bg-slate-800/70 text-slate-300'}`}>
                <span className="font-mono text-cyan-300 w-9">{a.a}</span>
                <span className="font-mono text-slate-500 w-10">{a.i}</span>
                <span className="text-slate-400 truncate">{a.m}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Aircraft / cruise selectors */}
      <div className="px-3 pt-3 border-t border-slate-800 mt-2">
        <div className="text-[10px] text-slate-500 mb-1">AIRCRAFT CLASS</div>
        <div className="grid grid-cols-2 gap-1">
          {(Object.keys(FUEL_FLOW) as Array<keyof typeof FUEL_FLOW>).map(k => (
            <button key={k} onClick={() => { setCls(k); setTasOverride(null) }} className={`text-[10px] px-2 py-1 rounded border ${cls === k ? 'border-cyan-400 bg-cyan-500/10 text-cyan-200' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>{FUEL_FLOW[k].label}</button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2 mt-2 text-[10px]">
          <label className="flex flex-col gap-0.5">
            <span className="text-slate-500">CRUISE FL</span>
            <input type="number" min={100} max={510} step={10} value={cruiseFL} onChange={e => setCruiseFL(Math.max(100, Math.min(510, +e.target.value || 360)))} className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-slate-200" />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-slate-500">TAS kt</span>
            <input type="number" min={200} max={600} step={10} value={tasOverride ?? profile.tas} onChange={e => setTasOverride(+e.target.value || null)} className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-slate-200" />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-slate-500">LEGS</span>
            <input type="number" min={4} max={32} step={1} value={legs} onChange={e => setLegs(Math.max(4, Math.min(32, +e.target.value || 12)))} className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-slate-200" />
          </label>
        </div>
        <label className="flex items-center gap-2 mt-2 text-[10px] text-slate-400">
          <span>WIND SAMPLE RADIUS</span>
          <input type="range" min={50} max={600} step={25} value={sampleRadiusNm} onChange={e => setSampleRadiusNm(+e.target.value)} className="flex-1 accent-cyan-500" />
          <span className="font-mono text-slate-300 w-12 text-right">{sampleRadiusNm}nm</span>
        </label>
      </div>

      {/* Summary */}
      {route && (
        <div className="px-3 pt-2 grid grid-cols-4 gap-1 text-center">
          {[
            ['DIST', `${route.totalNm.toFixed(0)}nm`, 'text-cyan-300'],
            ['TIME', fmtHM(route.totalMin), 'text-emerald-300'],
            ['FUEL', `${(route.totalFuel / 1000).toFixed(1)}t`, 'text-amber-300'],
            ['CO2', `${(route.co2Kg / 1000).toFixed(1)}t`, 'text-rose-300'],
          ].map(([k, v, c]) => (
            <div key={k as string} className="rounded border border-slate-800 bg-slate-900/60 px-1 py-1">
              <div className="text-[9px] text-slate-500">{k}</div>
              <div className={`text-[12px] font-mono ${c}`}>{v}</div>
            </div>
          ))}
        </div>
      )}

      {/* Legs */}
      {route && (
        <div className="px-3 pt-2 pb-3 overflow-y-auto flex-1">
          <div className="text-[10px] text-slate-500 mb-1 grid grid-cols-12 gap-1 px-1">
            <span>#</span>
            <span className="col-span-2 text-right">DIST</span>
            <span className="col-span-2 text-right">TRK</span>
            <span className="col-span-3 text-right">WIND</span>
            <span className="col-span-2 text-right">GS</span>
            <span className="col-span-2 text-right">FUEL</span>
          </div>
          <div className="flex flex-col gap-0.5">
            {route.legs.map(L => {
              const hwAbs = Math.abs(L.hwKt)
              const hwClass = L.hwKt > 5 ? 'text-rose-300' : L.hwKt < -5 ? 'text-emerald-300' : 'text-slate-300'
              return (
                <div key={L.idx} className="grid grid-cols-12 gap-1 text-[11px] font-mono px-1 py-0.5 rounded hover:bg-slate-900/60">
                  <span className="text-slate-500">{L.idx}</span>
                  <span className="col-span-2 text-right text-slate-300">{L.distNm.toFixed(0)}</span>
                  <span className="col-span-2 text-right text-cyan-200">{Math.round(L.trackDeg).toString().padStart(3, '0')}°</span>
                  <span className="col-span-3 text-right text-slate-400">
                    {L.windDir != null ? `${Math.round(L.windDir).toString().padStart(3, '0')}/${Math.round(L.windKts!)}` : '—'}
                    <span className={`ml-1 ${hwClass}`}>{L.windDir != null ? (L.hwKt > 0 ? `H${Math.round(hwAbs)}` : `T${Math.round(hwAbs)}`) : ''}</span>
                  </span>
                  <span className="col-span-2 text-right text-slate-200">{Math.round(L.gsKt)}</span>
                  <span className="col-span-2 text-right text-amber-300">{Math.round(L.fuelKg)}kg</span>
                </div>
              )
            })}
          </div>
          <div className="mt-2 text-[10px] text-slate-500 text-center">
            wind samples: {windSamples.length} aircraft at FL{cruiseFL}±40 · click ORIGIN then DEST to plan
          </div>
        </div>
      )}

      {!route && (
        <div className="px-3 py-6 text-center text-[11px] text-slate-500">
          pick an origin and destination airport above
        </div>
      )}
    </div>
  )
}
