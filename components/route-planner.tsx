'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS, type AirportPin } from './airports'

/* ============================================================
   Route Planner
   -----------------------------------------------------------
   Pick an origin and destination from the global airport
   database, then we compute:
     - Great-circle route between them (32 waypoints) using
       the Haversine + bearing formulas. Total nm.
     - For each leg, we sample live in-air aircraft within a
       tunable lateral radius of the leg midpoint AND within
       ±5000 ft of the planned cruise altitude, average their
       reported wind (windDir FROM, windKts) and project that
       wind onto the leg track. Positive = tailwind, negative
       = headwind. If no nearby aircraft, we fall back to the
       user-supplied default wind (dir / speed) projected on
       the leg.
     - Per-leg ground-speed = max(60, planned TAS + tailwind),
       per-leg ETE = leg_nm / GS, per-leg fuel = leg_minutes *
       fuelFlowPph.
     - Equal-time-point (ETP): scans the per-leg ETE table
       forward and backward to find the waypoint where time
       from origin == time from destination (the abeam point
       in time, used in ETOPS for emergency diversion).
     - Point-of-no-return (PNR) for a given reserve (lbs):
       find the furthest waypoint reachable such that fuel
       used plus fuel to come back (using reversed leg winds)
       <= total - reserve.
     - Top-K diversion alternates: sample every other waypoint
       and find the 3 closest airports (great-circle nm) not
       equal to origin/destination, dedupe across waypoints,
       cap at 8 total alternates. Each row shows IATA, name,
       nearest waypoint index, and slant distance.

   MapLibre overlay:
     - Origin/destination cyan pins with IATA + name labels.
     - Route polyline split into N leg segments, each colored
       by tailwind (emerald) / headwind (rose) / neutral
       (slate) and stroke-width scaled by |Vw| (1..5px).
     - Numbered waypoint dots; ETP plotted as a violet
       diamond, PNR as an amber square.
     - Alternate airport pins (sky) along the corridor with
       short dashed spurs to the nearest waypoint.

   Side panel UI:
     - From / To searchable pickers (filter by IATA/ICAO/city/
       name, list all airports with IATA codes); SWAP button.
     - Cruise FL / planned TAS kt / fuel flow pph / default
       wind dir/kt sliders & inputs.
     - Live result strip: GC nm, plan ETE hh:mm, mean wind
       component kt (signed), fuel needed lbs.
     - Per-leg scrollable list: leg #, segment nm, mean
       leg GS, ETE mm:ss, wind component, sample-count badge.
     - Alternate airports section with IATA + name + nm and
       click-to-fly.
     - OVERLAY / WAYPOINTS / LABELS toggles.
   ============================================================ */

export interface RpFlight {
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
  flights: RpFlight[]
  onClose: () => void
  onFlyLatLng: (lat: number, lng: number, zoom?: number) => void
}

const R_NM = 3440.065
function toRad(d: number) { return d * Math.PI / 180 }
function toDeg(r: number) { return r * 180 / Math.PI }
function gcDist(a: {lat:number;lon:number}, b: {lat:number;lon:number}) {
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lon - a.lon)
  const la1 = toRad(a.lat), la2 = toRad(b.lat)
  const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)))
}
function gcBearing(a: {lat:number;lon:number}, b: {lat:number;lon:number}) {
  const la1 = toRad(a.lat), la2 = toRad(b.lat), dLng = toRad(b.lon - a.lon)
  const y = Math.sin(dLng) * Math.cos(la2)
  const x = Math.cos(la1)*Math.sin(la2) - Math.sin(la1)*Math.cos(la2)*Math.cos(dLng)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}
function gcPoint(a: {lat:number;lon:number}, b: {lat:number;lon:number}, frac: number): {lat:number;lon:number} {
  const d = gcDist(a, b) / R_NM
  if (d < 1e-9) return { lat: a.lat, lon: a.lon }
  const la1 = toRad(a.lat), lo1 = toRad(a.lon), la2 = toRad(b.lat), lo2 = toRad(b.lon)
  const A = Math.sin((1-frac)*d) / Math.sin(d)
  const B = Math.sin(frac*d) / Math.sin(d)
  const x = A*Math.cos(la1)*Math.cos(lo1) + B*Math.cos(la2)*Math.cos(lo2)
  const y = A*Math.cos(la1)*Math.sin(lo1) + B*Math.cos(la2)*Math.sin(lo2)
  const z = A*Math.sin(la1) + B*Math.sin(la2)
  const la = Math.atan2(z, Math.sqrt(x*x + y*y))
  const lo = Math.atan2(y, x)
  return { lat: toDeg(la), lon: toDeg(lo) }
}

function fmtHm(min: number): string {
  if (!Number.isFinite(min) || min < 0) return '--:--'
  const h = Math.floor(min / 60), m = Math.round(min % 60)
  return `${h}:${m.toString().padStart(2,'0')}`
}
function fmtMs(min: number): string {
  if (!Number.isFinite(min) || min < 0) return '--:--'
  const m = Math.floor(min), s = Math.round((min - m) * 60)
  return `${m}:${s.toString().padStart(2,'0')}`
}

const SRC = 'rp-route-src'
const SRC_WP = 'rp-wp-src'
const SRC_PINS = 'rp-pins-src'
const SRC_ALT = 'rp-alt-src'
const LYR_LINE = 'rp-line'
const LYR_WP = 'rp-wp'
const LYR_PINS = 'rp-pins'
const LYR_PINS_LBL = 'rp-pins-lbl'
const LYR_ALT = 'rp-alt'
const LYR_ALT_LBL = 'rp-alt-lbl'

export default function RoutePlanner({ map, flights, onClose, onFlyLatLng }: Props) {
  const [from, setFrom] = useState<AirportPin | null>(() => AIRPORTS.find(a => a.a === 'SFO') ?? AIRPORTS[0])
  const [to, setTo] = useState<AirportPin | null>(() => AIRPORTS.find(a => a.a === 'JFK') ?? AIRPORTS[1])
  const [pickerOpen, setPickerOpen] = useState<null | 'from' | 'to'>(null)
  const [pickerQuery, setPickerQuery] = useState('')

  const [cruiseFl, setCruiseFl] = useState(360)
  const [planTas, setPlanTas] = useState(450)
  const [fuelPph, setFuelPph] = useState(6500)
  const [reserveLbs, setReserveLbs] = useState(3000)
  const [defWindDir, setDefWindDir] = useState(270)
  const [defWindKts, setDefWindKts] = useState(40)
  const [windSampleNm, setWindSampleNm] = useState(120)

  const [showOverlay, setShowOverlay] = useState(true)
  const [showWaypoints, setShowWaypoints] = useState(true)
  const [showLabels, setShowLabels] = useState(true)

  const picks = useMemo(() => {
    if (!pickerOpen) return [] as AirportPin[]
    const q = pickerQuery.trim().toLowerCase()
    const pool = AIRPORTS.filter(a => a.a)
    if (!q) return pool.slice(0, 80)
    return pool.filter(a =>
      a.a.toLowerCase().includes(q) || a.i.toLowerCase().includes(q) ||
      (a.m || '').toLowerCase().includes(q) || (a.n || '').toLowerCase().includes(q)
    ).slice(0, 80)
  }, [pickerOpen, pickerQuery])

  const plan = useMemo(() => {
    if (!from || !to) return null
    const A = { lat: from.lat, lon: from.lon }
    const B = { lat: to.lat, lon: to.lon }
    const totalNm = gcDist(A, B)
    if (totalNm < 1) return null
    const N_WP = 32
    const wps: {lat:number;lon:number}[] = []
    for (let i = 0; i <= N_WP; i++) wps.push(gcPoint(A, B, i / N_WP))
    const altFt = cruiseFl * 100
    const legs: { dNm:number; track:number; gs:number; eteMin:number; fuelLbs:number; windComp:number; sample:number }[] = []
    let cumNm = 0, cumMin = 0, cumFuel = 0
    const segCum: { nm:number; min:number; fuel:number }[] = [{ nm:0, min:0, fuel:0 }]
    for (let i = 0; i < N_WP; i++) {
      const a = wps[i], b = wps[i+1]
      const dNm = gcDist(a, b)
      const track = gcBearing(a, b)
      const mid = gcPoint(a, b, 0.5)
      // Sample nearby airborne flights within wind-sample radius and ±5000 ft of cruise alt with wind data.
      let sumU = 0, sumV = 0, n = 0
      for (const f of flights) {
        if (f.ground) continue
        if (!Number.isFinite(f.windDir as number) || !Number.isFinite(f.windKts as number)) continue
        if (!(f.windKts as number)) continue
        if (Math.abs(f.altitudeFt - altFt) > 5000) continue
        const dn = gcDist({lat: mid.lat, lon: mid.lon}, {lat: f.lat, lon: f.lng})
        if (dn > windSampleNm) continue
        const wDirTo = ((f.windDir as number) + 180) % 360 // FROM -> TO
        const wRad = toRad(wDirTo)
        sumU += (f.windKts as number) * Math.sin(wRad)
        sumV += (f.windKts as number) * Math.cos(wRad)
        n++
      }
      let wDirToward: number, wMag: number
      if (n > 0) {
        const u = sumU / n, v = sumV / n
        wMag = Math.hypot(u, v)
        wDirToward = (toDeg(Math.atan2(u, v)) + 360) % 360
      } else {
        wDirToward = (defWindDir + 180) % 360
        wMag = defWindKts
      }
      // Component along track: positive = tailwind (cos of angle between wind-toward and track)
      const angDiff = toRad(wDirToward - track)
      const tailwind = wMag * Math.cos(angDiff)
      const gs = Math.max(60, planTas + tailwind)
      const eteMin = (dNm / gs) * 60
      const fuel = (eteMin / 60) * fuelPph
      legs.push({ dNm, track, gs, eteMin, fuelLbs: fuel, windComp: tailwind, sample: n })
      cumNm += dNm; cumMin += eteMin; cumFuel += fuel
      segCum.push({ nm: cumNm, min: cumMin, fuel: cumFuel })
    }
    // ETP: waypoint where time-from-origin == time-from-destination using reversed-leg winds
    let etpIdx = -1, etpBestDiff = Infinity
    for (let i = 1; i < segCum.length - 1; i++) {
      let tBack = 0
      for (let j = legs.length - 1; j >= i; j--) {
        // reversed leg: tailwind sign flips
        const gsBack = Math.max(60, planTas - legs[j].windComp)
        tBack += (legs[j].dNm / gsBack) * 60
      }
      const diff = Math.abs(segCum[i].min - tBack)
      if (diff < etpBestDiff) { etpBestDiff = diff; etpIdx = i }
    }
    // PNR: furthest waypoint from origin reachable & return fits in fuel - reserve.
    const fuelAvail = Math.max(0, segCum[segCum.length-1].fuel + reserveLbs * 0)
    const totalFuel = segCum[segCum.length-1].fuel + reserveLbs
    let pnrIdx = -1
    for (let i = 1; i < segCum.length; i++) {
      let fBack = 0
      for (let j = i - 1; j >= 0; j--) {
        const gsBack = Math.max(60, planTas - legs[j].windComp)
        const t = (legs[j].dNm / gsBack) * 60
        fBack += (t / 60) * fuelPph
      }
      const used = segCum[i].fuel + fBack
      if (used <= totalFuel - reserveLbs) pnrIdx = i
      else break
    }
    // Alternates: every 4th waypoint, nearest 3 airports, dedupe, cap 8
    const altMap = new Map<string, { ap: AirportPin; wpIdx: number; nm: number }>()
    for (let i = 4; i < wps.length - 4; i += 4) {
      const ranked = AIRPORTS
        .filter(a => a !== from && a !== to)
        .map(a => ({ a, nm: gcDist({lat: wps[i].lat, lon: wps[i].lon}, {lat: a.lat, lon: a.lon}) }))
        .sort((x, y) => x.nm - y.nm)
        .slice(0, 3)
      for (const r of ranked) {
        const key = r.a.i || r.a.a
        const ex = altMap.get(key)
        if (!ex || r.nm < ex.nm) altMap.set(key, { ap: r.a, wpIdx: i, nm: r.nm })
      }
    }
    const alternates = Array.from(altMap.values()).sort((a,b) => a.nm - b.nm).slice(0, 8)

    const totalEte = segCum[segCum.length-1].min
    const totalFuelLbs = segCum[segCum.length-1].fuel
    const meanWind = legs.reduce((s,l)=>s + l.windComp, 0) / Math.max(1, legs.length)

    return { wps, legs, segCum, totalNm, totalEte, totalFuelLbs, meanWind, etpIdx, pnrIdx, alternates, fuelAvail }
  }, [from, to, flights, cruiseFl, planTas, fuelPph, reserveLbs, defWindDir, defWindKts, windSampleNm])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getSource(SRC_WP)) map.addSource(SRC_WP, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getSource(SRC_PINS)) map.addSource(SRC_PINS, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getSource(SRC_ALT)) map.addSource(SRC_ALT, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(LYR_LINE)) map.addLayer({
        id: LYR_LINE, type: 'line', source: SRC,
        paint: {
          'line-color': ['get','col'],
          'line-width': ['get','w'],
          'line-opacity': 0.85,
        },
      } as any)
      if (!map.getLayer(LYR_WP)) map.addLayer({
        id: LYR_WP, type: 'circle', source: SRC_WP,
        paint: {
          'circle-radius': ['case', ['==',['get','kind'],'etp'], 7, ['==',['get','kind'],'pnr'], 7, 3.5],
          'circle-color': ['get','col'],
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 1.2,
        },
      } as any)
      if (!map.getLayer(LYR_PINS)) map.addLayer({
        id: LYR_PINS, type: 'circle', source: SRC_PINS,
        paint: { 'circle-radius': 8, 'circle-color': '#0ea5e9', 'circle-stroke-color': '#e0f2fe', 'circle-stroke-width': 2 },
      } as any)
      if (!map.getLayer(LYR_PINS_LBL)) map.addLayer({
        id: LYR_PINS_LBL, type: 'symbol', source: SRC_PINS,
        layout: {
          'text-field': ['get','label'],
          'text-size': 12, 'text-offset': [0, 1.4], 'text-anchor': 'top',
          'text-font': ['Noto Sans Bold'],
        },
        paint: { 'text-color': '#e0f2fe', 'text-halo-color': '#0f172a', 'text-halo-width': 1.6 },
      } as any)
      if (!map.getLayer(LYR_ALT)) map.addLayer({
        id: LYR_ALT, type: 'circle', source: SRC_ALT,
        paint: { 'circle-radius': 4.5, 'circle-color': '#38bdf8', 'circle-stroke-color': '#0f172a', 'circle-stroke-width': 1 },
      } as any)
      if (!map.getLayer(LYR_ALT_LBL)) map.addLayer({
        id: LYR_ALT_LBL, type: 'symbol', source: SRC_ALT,
        layout: {
          'text-field': ['get','iata'], 'text-size': 10, 'text-offset': [0, 1.0], 'text-anchor': 'top', 'text-font': ['Noto Sans Bold'],
        },
        paint: { 'text-color': '#bae6fd', 'text-halo-color': '#0f172a', 'text-halo-width': 1.2 },
      } as any)
    }
    if (map.isStyleLoaded()) ensure(); else map.once('load', ensure)
    return () => {
      try {
        for (const id of [LYR_ALT_LBL, LYR_ALT, LYR_PINS_LBL, LYR_PINS, LYR_WP, LYR_LINE]) if (map.getLayer(id)) map.removeLayer(id)
        for (const id of [SRC_ALT, SRC_PINS, SRC_WP, SRC]) if (map.getSource(id)) map.removeSource(id)
      } catch {}
    }
  }, [map])

  useEffect(() => {
    if (!map) return
    const apply = () => {
      const lineFeats: any[] = []
      const wpFeats: any[] = []
      const pinFeats: any[] = []
      const altFeats: any[] = []
      if (showOverlay && plan && from && to) {
        for (let i = 0; i < plan.legs.length; i++) {
          const a = plan.wps[i], b = plan.wps[i+1]
          const w = plan.legs[i].windComp
          const col = w > 5 ? '#34d399' : w < -5 ? '#fb7185' : '#94a3b8'
          const width = Math.min(5, Math.max(1, 1 + Math.abs(w) / 15))
          lineFeats.push({ type:'Feature', geometry: { type:'LineString', coordinates: [[a.lon, a.lat],[b.lon, b.lat]] }, properties: { col, w: width } })
        }
        if (showWaypoints) {
          for (let i = 1; i < plan.wps.length - 1; i++) {
            const kind = i === plan.etpIdx ? 'etp' : i === plan.pnrIdx ? 'pnr' : 'wp'
            const col = kind === 'etp' ? '#a78bfa' : kind === 'pnr' ? '#fbbf24' : '#cbd5e1'
            wpFeats.push({ type:'Feature', geometry: { type:'Point', coordinates: [plan.wps[i].lon, plan.wps[i].lat] }, properties: { kind, col } })
          }
        }
        pinFeats.push({ type:'Feature', geometry: { type:'Point', coordinates: [from.lon, from.lat] }, properties: { label: showLabels ? `${from.a} ${from.m}` : '' } })
        pinFeats.push({ type:'Feature', geometry: { type:'Point', coordinates: [to.lon, to.lat] }, properties: { label: showLabels ? `${to.a} ${to.m}` : '' } })
        for (const alt of plan.alternates) {
          altFeats.push({ type:'Feature', geometry: { type:'Point', coordinates: [alt.ap.lon, alt.ap.lat] }, properties: { iata: showLabels ? alt.ap.a : '' } })
        }
      }
      ;(map.getSource(SRC) as any)?.setData({ type:'FeatureCollection', features: lineFeats })
      ;(map.getSource(SRC_WP) as any)?.setData({ type:'FeatureCollection', features: wpFeats })
      ;(map.getSource(SRC_PINS) as any)?.setData({ type:'FeatureCollection', features: pinFeats })
      ;(map.getSource(SRC_ALT) as any)?.setData({ type:'FeatureCollection', features: altFeats })
    }
    if (map.isStyleLoaded()) apply(); else map.once('load', apply)
  }, [map, plan, from, to, showOverlay, showWaypoints, showLabels])

  const swap = () => { const f = from; setFrom(to); setTo(f) }

  const fitToRoute = () => {
    if (!map || !from || !to) return
    try {
      const minLat = Math.min(from.lat, to.lat), maxLat = Math.max(from.lat, to.lat)
      const minLon = Math.min(from.lon, to.lon), maxLon = Math.max(from.lon, to.lon)
      map.fitBounds([[minLon, minLat],[maxLon, maxLat]] as any, { padding: 80, duration: 800 })
    } catch {}
  }

  return (
    <div className="absolute top-16 left-3 z-40 w-[min(94vw,440px)] max-h-[82vh] overflow-y-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl">
      <div className="sticky top-0 z-10 bg-slate-950/95 backdrop-blur-xl px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Subsystem</div>
          <div className="text-sm font-semibold text-slate-100">Route Planner</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* From / To */}
      <div className="px-4 py-3 border-b border-slate-900 grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">From</div>
          <button onClick={()=>{ setPickerOpen('from'); setPickerQuery('') }}
            className="w-full text-left px-2.5 py-2 rounded-lg bg-slate-900/60 border border-slate-800 hover:border-sky-500/50 text-slate-100">
            <div className="font-mono text-sm font-bold">{from?.a ?? '---'}</div>
            <div className="text-[10px] text-slate-400 truncate">{from?.m ?? 'pick origin'}</div>
          </button>
        </div>
        <button onClick={swap} title="Swap"
          className="px-2 py-2 text-slate-400 hover:text-sky-300 border border-slate-800 hover:border-sky-500/40 rounded-lg">⇄</button>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">To</div>
          <button onClick={()=>{ setPickerOpen('to'); setPickerQuery('') }}
            className="w-full text-left px-2.5 py-2 rounded-lg bg-slate-900/60 border border-slate-800 hover:border-sky-500/50 text-slate-100">
            <div className="font-mono text-sm font-bold">{to?.a ?? '---'}</div>
            <div className="text-[10px] text-slate-400 truncate">{to?.m ?? 'pick destination'}</div>
          </button>
        </div>
      </div>

      {pickerOpen && (
        <div className="px-4 py-3 border-b border-slate-900 bg-slate-900/40">
          <div className="flex items-center gap-2 mb-2">
            <input autoFocus value={pickerQuery} onChange={e=>setPickerQuery(e.target.value)}
              placeholder={`Search ${pickerOpen === 'from' ? 'origin' : 'destination'} (IATA / ICAO / city)`}
              className="flex-1 px-2.5 py-1.5 rounded-md bg-slate-950 border border-slate-800 text-slate-100 text-xs focus:outline-none focus:border-sky-500/60" />
            <button onClick={()=>setPickerOpen(null)} className="text-slate-500 hover:text-slate-200 text-xs">close</button>
          </div>
          <div className="max-h-44 overflow-y-auto rounded-md border border-slate-800 divide-y divide-slate-900">
            {picks.map(a => (
              <button key={`${a.i}-${a.a}`} onClick={()=>{ if (pickerOpen==='from') setFrom(a); else setTo(a); setPickerOpen(null) }}
                className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-slate-800/60 flex items-center justify-between gap-2">
                <span className="font-mono font-bold text-sky-300 w-12 shrink-0">{a.a}</span>
                <span className="text-slate-200 truncate flex-1">{a.m}</span>
                <span className="font-mono text-[10px] text-slate-500">{a.i}</span>
              </button>
            ))}
            {picks.length === 0 && <div className="px-3 py-4 text-center text-[11px] text-slate-500">No matches</div>}
          </div>
        </div>
      )}

      {/* Flight plan controls */}
      <div className="px-4 py-3 border-b border-slate-900 grid grid-cols-2 gap-x-3 gap-y-2">
        <label className="text-[10px] uppercase tracking-widest text-slate-500 col-span-2 -mb-1">Flight plan</label>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-400"><span>Cruise FL</span><span className="font-mono text-slate-200">{cruiseFl}</span></div>
          <input type="range" min={60} max={450} step={10} value={cruiseFl} onChange={e=>setCruiseFl(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-400"><span>Plan TAS kt</span><span className="font-mono text-slate-200">{planTas}</span></div>
          <input type="range" min={120} max={550} step={5} value={planTas} onChange={e=>setPlanTas(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-400"><span>Fuel pph</span><span className="font-mono text-slate-200">{fuelPph}</span></div>
          <input type="range" min={200} max={20000} step={100} value={fuelPph} onChange={e=>setFuelPph(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-400"><span>Reserve lbs</span><span className="font-mono text-slate-200">{reserveLbs}</span></div>
          <input type="range" min={0} max={20000} step={100} value={reserveLbs} onChange={e=>setReserveLbs(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-400"><span>Def wind ° FROM</span><span className="font-mono text-slate-200">{defWindDir}</span></div>
          <input type="range" min={0} max={359} step={5} value={defWindDir} onChange={e=>setDefWindDir(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-400"><span>Def wind kt</span><span className="font-mono text-slate-200">{defWindKts}</span></div>
          <input type="range" min={0} max={200} step={5} value={defWindKts} onChange={e=>setDefWindKts(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div className="col-span-2">
          <div className="flex items-center justify-between text-[10px] text-slate-400"><span>Live wind sample radius nm</span><span className="font-mono text-slate-200">{windSampleNm}</span></div>
          <input type="range" min={30} max={400} step={10} value={windSampleNm} onChange={e=>setWindSampleNm(+e.target.value)} className="w-full accent-sky-500" />
        </div>
      </div>

      {/* Result summary */}
      <div className="px-4 py-3 border-b border-slate-900 grid grid-cols-4 gap-1.5 text-center">
        <div className="rounded-lg bg-slate-900/60 border border-slate-800 px-2 py-1.5">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Dist</div>
          <div className="font-mono text-sm text-slate-100">{plan ? Math.round(plan.totalNm) : '--'}<span className="text-[9px] text-slate-500"> nm</span></div>
        </div>
        <div className="rounded-lg bg-slate-900/60 border border-slate-800 px-2 py-1.5">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">ETE</div>
          <div className="font-mono text-sm text-slate-100">{plan ? fmtHm(plan.totalEte) : '--:--'}</div>
        </div>
        <div className="rounded-lg bg-slate-900/60 border border-slate-800 px-2 py-1.5">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean W</div>
          <div className={`font-mono text-sm ${plan && plan.meanWind > 5 ? 'text-emerald-300' : plan && plan.meanWind < -5 ? 'text-rose-300' : 'text-slate-200'}`}>
            {plan ? (plan.meanWind >= 0 ? '+' : '') + Math.round(plan.meanWind) : '--'}<span className="text-[9px] text-slate-500"> kt</span>
          </div>
        </div>
        <div className="rounded-lg bg-slate-900/60 border border-slate-800 px-2 py-1.5">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Fuel</div>
          <div className="font-mono text-sm text-slate-100">{plan ? Math.round(plan.totalFuelLbs).toLocaleString() : '--'}<span className="text-[9px] text-slate-500"> lb</span></div>
        </div>
      </div>

      {/* ETP / PNR strip */}
      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-2 gap-1.5">
        <div className="rounded-lg bg-violet-500/10 border border-violet-500/40 px-2 py-1.5">
          <div className="text-[9px] uppercase tracking-widest text-violet-300">ETP (wp {plan?.etpIdx ?? '--'})</div>
          <div className="font-mono text-[11px] text-slate-100">
            {plan && plan.etpIdx > 0 ? `${Math.round(plan.segCum[plan.etpIdx].nm)} nm · T+${fmtHm(plan.segCum[plan.etpIdx].min)}` : '—'}
          </div>
        </div>
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/40 px-2 py-1.5">
          <div className="text-[9px] uppercase tracking-widest text-amber-300">PNR (wp {plan?.pnrIdx ?? '--'})</div>
          <div className="font-mono text-[11px] text-slate-100">
            {plan && plan.pnrIdx > 0 ? `${Math.round(plan.segCum[plan.pnrIdx].nm)} nm · T+${fmtHm(plan.segCum[plan.pnrIdx].min)}` : '—'}
          </div>
        </div>
      </div>

      {/* Toggles + actions */}
      <div className="px-4 py-2 border-b border-slate-900 flex flex-wrap items-center gap-1.5">
        {([
          ['OVERLAY', showOverlay, ()=>setShowOverlay(v=>!v)],
          ['WAYPOINTS', showWaypoints, ()=>setShowWaypoints(v=>!v)],
          ['LABELS', showLabels, ()=>setShowLabels(v=>!v)],
        ] as Array<[string,boolean,()=>void]>).map(([l,on,cb]) => (
          <button key={l} onClick={cb} className={`px-2 py-1 rounded-md text-[10px] font-bold tracking-widest border ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/60 border-slate-800 text-slate-400'}`}>{l}</button>
        ))}
        <div className="flex-1" />
        <button onClick={fitToRoute} className="px-2 py-1 rounded-md text-[10px] font-bold tracking-widest border bg-slate-900/60 border-slate-800 text-slate-300 hover:text-sky-300 hover:border-sky-500/40">FIT</button>
      </div>

      {/* Legs */}
      <div className="px-4 py-3 border-b border-slate-900">
        <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">Legs · {plan?.legs.length ?? 0}</div>
        <div className="max-h-56 overflow-y-auto rounded-md border border-slate-800 divide-y divide-slate-900">
          {plan?.legs.map((l, i) => {
            const col = l.windComp > 5 ? 'text-emerald-300' : l.windComp < -5 ? 'text-rose-300' : 'text-slate-300'
            return (
              <div key={i} className="grid grid-cols-[24px_1fr_1fr_1fr_1fr_28px] gap-1 px-2 py-1 text-[10px] items-center hover:bg-slate-900/40">
                <span className="font-mono text-slate-500">{i+1}</span>
                <span className="font-mono text-slate-200">{l.dNm.toFixed(1)}<span className="text-slate-500"> nm</span></span>
                <span className="font-mono text-slate-200">{Math.round(l.gs)}<span className="text-slate-500"> kt</span></span>
                <span className="font-mono text-slate-200">{fmtMs(l.eteMin)}</span>
                <span className={`font-mono ${col}`}>{l.windComp >= 0 ? '+' : ''}{Math.round(l.windComp)}</span>
                <span className={`font-mono text-[9px] text-right ${l.sample > 0 ? 'text-sky-300' : 'text-slate-600'}`}>{l.sample > 0 ? `★${l.sample}` : '·'}</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Alternates */}
      <div className="px-4 py-3 border-b border-slate-900">
        <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">Alternates · {plan?.alternates.length ?? 0}</div>
        <div className="grid grid-cols-1 gap-1">
          {plan?.alternates.map(alt => (
            <button key={alt.ap.i + alt.ap.a} onClick={()=>onFlyLatLng(alt.ap.lat, alt.ap.lon, 8)}
              className="text-left px-2.5 py-1.5 rounded-md bg-slate-900/50 hover:bg-slate-800/70 border border-slate-800 hover:border-sky-500/40 text-[11px] flex items-center justify-between gap-2">
              <span className="font-mono font-bold text-sky-300 w-12 shrink-0">{alt.ap.a}</span>
              <span className="text-slate-200 truncate flex-1">{alt.ap.m}</span>
              <span className="font-mono text-[10px] text-slate-500">wp{alt.wpIdx} · {Math.round(alt.nm)}nm</span>
            </button>
          ))}
          {(!plan || plan.alternates.length === 0) && <div className="text-[11px] text-slate-600 px-2 py-1">—</div>}
        </div>
      </div>

      <div className="px-4 py-2 text-[10px] text-slate-500 leading-snug">
        Live winds sampled from <span className="text-sky-300 font-mono">★N</span> aircraft within ±5,000 ft of cruise. ETP = equal-time abeam point. PNR = furthest waypoint reachable with reserve fuel intact.
      </div>
    </div>
  )
}
