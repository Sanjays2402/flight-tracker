'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   Approach Sequencer
   -----------------------------------------------------------
   Picks a destination airport (nearest to map center by default,
   or user-selected from a searchable list) and builds a live
   arrival sequence by:
     1. Scanning every airborne aircraft within range R of the
        airport
     2. Filtering those whose ground vector is *closing* on the
        airport (closure component > MIN_CLOSURE kts) and whose
        descent profile is consistent with an arrival (altitude
        below cruise ceiling, optionally descending)
     3. Computing predicted Time-To-Threshold (TTT) using current
        ground speed and a kinematic descent assumption (3deg)
     4. Sorting by TTT to produce the in-trail landing order
     5. Computing per-pair in-trail spacing in nm + minutes and
        flagging separation conflicts (< MIN_SEP nm) vs comfort
        (< COMFORT_SEP nm) vs OK
   Renders on MapLibre:
     - dashed cyan arrivals corridor: extended runway centerline
       (10nm final + 30nm gate) using the dominant inbound bearing
     - amber numbered halo around each sequenced aircraft (1..N)
     - dashed link from each aircraft to the airport
     - conflict pair painted in rose
   Side panel: sequence list with click-to-fly, search, R/min-FL
   sliders, airport picker, IN-TRAIL gap chips.
   ============================================================ */

export interface SeqFlight {
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
  flights: SeqFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

const R_NM = 3440.065
const RAD = Math.PI / 180
const DEG = 180 / Math.PI

function distNm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const φ1 = lat1 * RAD, φ2 = lat2 * RAD
  const dφ = (lat2 - lat1) * RAD
  const dλ = (lng2 - lng1) * RAD
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(s)))
}
function bearing(lat1: number, lng1: number, lat2: number, lng2: number) {
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
function geodesic(lat1: number, lng1: number, lat2: number, lng2: number, n = 24): number[][] {
  const out: number[][] = []
  for (let i = 0; i <= n; i++) {
    const f = i / n
    const b = bearing(lat1, lng1, lat2, lng2)
    const d = distNm(lat1, lng1, lat2, lng2)
    const [lo, la] = dest(lat1, lng1, b, d * f)
    out.push([lo, la])
  }
  return out
}
function fmtMMSS(s: number) {
  if (!isFinite(s) || s < 0) return '--:--'
  const m = Math.floor(s / 60), ss = Math.floor(s % 60)
  return `${m}:${ss.toString().padStart(2, '0')}`
}

type Arrival = {
  f: SeqFlight
  rangeNm: number
  bearingFromAp: number      // bearing from airport to aircraft (inbound radial source)
  brgToAp: number            // bearing from aircraft to airport
  closureKts: number
  ttsSec: number             // time-to-threshold seconds
  seq: number
  prevGapNm: number          // in-trail gap to plane ahead, nm
  prevGapSec: number
  status: 'ok' | 'comfort' | 'conflict' | 'lead'
}

const SRC = 'apr-seq-src'
const SRC_LINK = 'apr-seq-link-src'
const SRC_AP = 'apr-seq-ap-src'
const LYR_HALO = 'apr-seq-halo'
const LYR_NUM = 'apr-seq-num'
const LYR_LINK = 'apr-seq-link'
const LYR_RWY = 'apr-seq-rwy'
const LYR_AP = 'apr-seq-ap'
const LYR_AP_LBL = 'apr-seq-ap-lbl'

export default function ApproachSequencer({ map, flights, onClose, onFly }: Props) {
  const [airportI, setAirportI] = useState<string>(() => { try { return localStorage.getItem('ft-aprseq-ap') || '' } catch { return '' } })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQ, setPickerQ] = useState('')
  const [rangeNm, setRangeNm] = useState(80)
  const [minClosure, setMinClosure] = useState(50)
  const [descendingOnly, setDescendingOnly] = useState(true)
  const [search, setSearch] = useState('')
  const [showOverlay, setShowOverlay] = useState(true)

  // resolve airport: explicit, else nearest to map center
  const center = useMemo(() => {
    try { const c = map?.getCenter(); return c ? { lat: c.lat, lng: c.lng } : { lat: 40, lng: -95 } } catch { return { lat: 40, lng: -95 } }
  }, [map, flights])

  const airport = useMemo(() => {
    if (airportI) {
      const a = AIRPORTS.find(x => x.i === airportI)
      if (a) return a
    }
    let best = AIRPORTS[0], bd = Infinity
    for (const a of AIRPORTS) {
      const d = distNm(center.lat, center.lng, a.lat, a.lon)
      if (d < bd) { bd = d; best = a }
    }
    return best
  }, [airportI, center.lat, center.lng])

  useEffect(() => { try { localStorage.setItem('ft-aprseq-ap', airportI) } catch {} }, [airportI])

  // build arrivals
  const arrivals = useMemo<Arrival[]>(() => {
    if (!airport) return []
    const cands: Arrival[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (f.altitudeFt > 41000) continue
      if (descendingOnly && f.vertRate > 200 && f.altitudeFt > 6000) continue
      const r = distNm(f.lat, f.lng, airport.lat, airport.lon)
      if (r > rangeNm) continue
      const brgToAp = bearing(f.lat, f.lng, airport.lat, airport.lon)
      // closure = component of velocity vector along bearing-to-airport
      const dHead = ((brgToAp - f.track + 540) % 360) - 180
      const closure = f.velocityKts * Math.cos(dHead * RAD)
      if (closure < minClosure) continue
      // time-to-threshold: range / closure (hours -> s), add small slow-down factor inside 15nm
      const slow = r < 15 ? 0.55 : r < 30 ? 0.75 : 1.0
      const effGs = Math.max(120, closure * slow)
      const ttsSec = (r / effGs) * 3600
      cands.push({
        f, rangeNm: r,
        bearingFromAp: bearing(airport.lat, airport.lon, f.lat, f.lng),
        brgToAp,
        closureKts: closure,
        ttsSec,
        seq: 0, prevGapNm: 0, prevGapSec: 0, status: 'lead',
      })
    }
    cands.sort((a, b) => a.ttsSec - b.ttsSec)
    for (let i = 0; i < cands.length; i++) {
      cands[i].seq = i + 1
      if (i === 0) { cands[i].status = 'lead'; cands[i].prevGapNm = 0; cands[i].prevGapSec = 0 }
      else {
        const prev = cands[i - 1]
        const gapNm = cands[i].rangeNm - prev.rangeNm
        const gapSec = cands[i].ttsSec - prev.ttsSec
        cands[i].prevGapNm = gapNm
        cands[i].prevGapSec = gapSec
        cands[i].status = gapNm < 2.5 ? 'conflict' : gapNm < 5 ? 'comfort' : 'ok'
      }
    }
    return cands
  }, [flights, airport, rangeNm, minClosure, descendingOnly])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return arrivals
    return arrivals.filter(a =>
      a.f.callsign.toLowerCase().includes(q) ||
      (a.f.type || '').toLowerCase().includes(q) ||
      (a.f.operator || '').toLowerCase().includes(q) ||
      a.f.icao.toLowerCase().includes(q)
    )
  }, [arrivals, search])

  // dominant inbound radial (mean bearingFromAp weighted by inverse range)
  const dominantRadial = useMemo(() => {
    if (!arrivals.length) return null
    let sx = 0, sy = 0, sw = 0
    for (const a of arrivals.slice(0, 8)) {
      const w = 1 / Math.max(2, a.rangeNm)
      sx += Math.sin(a.bearingFromAp * RAD) * w
      sy += Math.cos(a.bearingFromAp * RAD) * w
      sw += w
    }
    if (sw === 0) return null
    return (Math.atan2(sx / sw, sy / sw) * DEG + 360) % 360
  }, [arrivals])

  const counts = useMemo(() => ({
    total: arrivals.length,
    conflict: arrivals.filter(a => a.status === 'conflict').length,
    comfort: arrivals.filter(a => a.status === 'comfort').length,
    ok: arrivals.filter(a => a.status === 'ok').length,
  }), [arrivals])

  // map overlays
  useEffect(() => {
    if (!map) return
    const m = map as any
    const remove = () => {
      for (const id of [LYR_HALO, LYR_NUM, LYR_LINK, LYR_RWY, LYR_AP, LYR_AP_LBL]) { try { if (m.getLayer(id)) m.removeLayer(id) } catch {} }
      for (const id of [SRC, SRC_LINK, SRC_AP, 'apr-seq-rwy-src']) { try { if (m.getSource(id)) m.removeSource(id) } catch {} }
    }
    if (!showOverlay || !airport) { remove(); return }

    // halos+numbers
    const haloFC = { type: 'FeatureCollection', features: arrivals.map(a => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [a.f.lng, a.f.lat] },
      properties: {
        seq: `${a.seq}`,
        color: a.status === 'conflict' ? '#f43f5e' : a.status === 'comfort' ? '#fbbf24' : '#22d3ee',
        label: `#${a.seq}  ${a.f.callsign}  T-${fmtMMSS(a.ttsSec)}`,
      },
    })) } as any
    const linkFC = { type: 'FeatureCollection', features: arrivals.map(a => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: geodesic(a.f.lat, a.f.lng, airport.lat, airport.lon, 16) },
      properties: { color: a.status === 'conflict' ? '#f43f5e' : '#67e8f9' },
    })) } as any
    const apFC = { type: 'FeatureCollection', features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [airport.lon, airport.lat] },
      properties: { iata: airport.a || airport.i },
    }] } as any
    // extended centerline along dominant radial (out 40nm) + reciprocal (10nm final)
    let rwyFC: any = { type: 'FeatureCollection', features: [] }
    if (dominantRadial != null) {
      const out = dest(airport.lat, airport.lon, dominantRadial, 40)
      const fin = dest(airport.lat, airport.lon, (dominantRadial + 180) % 360, 10)
      rwyFC.features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[fin[0], fin[1]], [airport.lon, airport.lat], [out[0], out[1]]] },
        properties: {},
      })
    }

    const upsert = (id: string, data: any) => {
      const s = m.getSource(id)
      if (s) s.setData(data)
      else m.addSource(id, { type: 'geojson', data })
    }
    upsert(SRC, haloFC)
    upsert(SRC_LINK, linkFC)
    upsert(SRC_AP, apFC)
    upsert('apr-seq-rwy-src', rwyFC)

    if (!m.getLayer(LYR_RWY)) m.addLayer({ id: LYR_RWY, type: 'line', source: 'apr-seq-rwy-src', paint: { 'line-color': '#a5f3fc', 'line-width': 1.5, 'line-dasharray': [3, 3], 'line-opacity': 0.7 } })
    if (!m.getLayer(LYR_LINK)) m.addLayer({ id: LYR_LINK, type: 'line', source: SRC_LINK, paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-dasharray': [2, 2], 'line-opacity': 0.55 } })
    if (!m.getLayer(LYR_HALO)) m.addLayer({ id: LYR_HALO, type: 'circle', source: SRC, paint: { 'circle-radius': 18, 'circle-color': ['get', 'color'], 'circle-opacity': 0.15, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2, 'circle-stroke-opacity': 0.9 } })
    if (!m.getLayer(LYR_NUM)) m.addLayer({ id: LYR_NUM, type: 'symbol', source: SRC, layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'], 'text-allow-overlap': false }, paint: { 'text-color': '#f1f5f9', 'text-halo-color': '#0b1220', 'text-halo-width': 1.4 } })
    if (!m.getLayer(LYR_AP)) m.addLayer({ id: LYR_AP, type: 'circle', source: SRC_AP, paint: { 'circle-radius': 6, 'circle-color': '#a78bfa', 'circle-stroke-color': '#ede9fe', 'circle-stroke-width': 1.5 } })
    if (!m.getLayer(LYR_AP_LBL)) m.addLayer({ id: LYR_AP_LBL, type: 'symbol', source: SRC_AP, layout: { 'text-field': ['get', 'iata'], 'text-size': 12, 'text-offset': [0, -1.4], 'text-anchor': 'bottom', 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'] }, paint: { 'text-color': '#ede9fe', 'text-halo-color': '#1e1b4b', 'text-halo-width': 1.4 } })

    return () => { remove() }
  }, [map, arrivals, showOverlay, airport, dominantRadial])

  const airportLabel = airport ? `${airport.a || airport.i} — ${airport.m}` : '—'

  const picks = useMemo(() => {
    const q = pickerQ.trim().toLowerCase()
    const base = q ? AIRPORTS.filter(a => a.a.toLowerCase().includes(q) || a.i.toLowerCase().includes(q) || a.m.toLowerCase().includes(q)) : AIRPORTS.slice().sort((a, b) => distNm(center.lat, center.lng, a.lat, a.lon) - distNm(center.lat, center.lng, b.lat, b.lon))
    return base.slice(0, 80)
  }, [pickerQ, center.lat, center.lng])

  return (
    <div className="absolute top-2 right-2 z-30 w-[380px] max-h-[88vh] overflow-hidden bg-slate-900/95 border border-slate-700 rounded-lg shadow-2xl flex flex-col text-slate-100 backdrop-blur-md">
      <div className="px-3 py-2 border-b border-slate-700 flex items-center justify-between bg-gradient-to-r from-cyan-900/40 to-violet-900/40">
        <div>
          <div className="text-xs uppercase tracking-wider text-cyan-300/80">Approach Sequencer</div>
          <div className="text-sm font-semibold">{airportLabel}</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-rose-400 text-lg leading-none">×</button>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-1.5 flex-wrap">
        <button onClick={() => setPickerOpen(v => !v)} className="px-2 py-1 text-[10px] bg-slate-800 hover:bg-slate-700 rounded border border-slate-700 uppercase tracking-wide">{pickerOpen ? 'Close' : 'Airport'}</button>
        <button onClick={() => setAirportI('')} className="px-2 py-1 text-[10px] bg-slate-800 hover:bg-slate-700 rounded border border-slate-700 uppercase tracking-wide">Nearest</button>
        <label className="ml-auto flex items-center gap-1 text-[10px] cursor-pointer"><input type="checkbox" checked={showOverlay} onChange={e => setShowOverlay(e.target.checked)} className="accent-cyan-400" />OVL</label>
        <label className="flex items-center gap-1 text-[10px] cursor-pointer"><input type="checkbox" checked={descendingOnly} onChange={e => setDescendingOnly(e.target.checked)} className="accent-cyan-400" />DESC</label>
      </div>

      {pickerOpen && (
        <div className="px-3 py-2 border-b border-slate-800 max-h-48 overflow-y-auto bg-slate-950/60">
          <input value={pickerQ} onChange={e => setPickerQ(e.target.value)} placeholder="IATA / ICAO / city" className="w-full px-2 py-1 mb-1 text-xs bg-slate-900 border border-slate-700 rounded outline-none focus:border-cyan-500" />
          {picks.map(a => (
            <button key={a.i} onClick={() => { setAirportI(a.i); setPickerOpen(false) }} className="w-full text-left px-2 py-1 text-[11px] hover:bg-slate-800 rounded flex items-center justify-between">
              <span><span className="font-mono text-cyan-300">{a.a || a.i}</span> <span className="text-slate-300">{a.m}</span></span>
              <span className="text-[9px] text-slate-500">{distNm(center.lat, center.lng, a.lat, a.lon).toFixed(0)}nm</span>
            </button>
          ))}
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 grid grid-cols-4 gap-1.5">
        {[
          { k: 'total', label: 'SEQ', v: counts.total, color: 'text-cyan-300' },
          { k: 'lead', label: 'LEAD', v: arrivals[0]?.f.callsign?.slice(0, 6) || '—', color: 'text-violet-300' },
          { k: 'comf', label: 'TIGHT', v: counts.comfort, color: 'text-amber-300' },
          { k: 'conf', label: 'CONF', v: counts.conflict, color: 'text-rose-400' },
        ].map(c => (
          <div key={c.k} className="px-1.5 py-1 bg-slate-800/60 rounded border border-slate-700/60 text-center">
            <div className="text-[9px] text-slate-500 uppercase tracking-wide">{c.label}</div>
            <div className={`text-sm font-bold ${c.color}`}>{c.v}</div>
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-1.5">
        <label className="block text-[10px] text-slate-400">RANGE <span className="text-cyan-300 font-mono">{rangeNm}nm</span>
          <input type="range" min={20} max={250} value={rangeNm} onChange={e => setRangeNm(+e.target.value)} className="w-full accent-cyan-400 h-1" />
        </label>
        <label className="block text-[10px] text-slate-400">MIN CLOSURE <span className="text-cyan-300 font-mono">{minClosure}kt</span>
          <input type="range" min={0} max={300} step={10} value={minClosure} onChange={e => setMinClosure(+e.target.value)} className="w-full accent-cyan-400 h-1" />
        </label>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="callsign / type / operator" className="w-full px-2 py-1 text-xs bg-slate-800 border border-slate-700 rounded outline-none focus:border-cyan-500" />
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-slate-500">No arrivals detected within {rangeNm}nm</div>}
        {filtered.map(a => {
          const stripe = a.status === 'conflict' ? 'bg-rose-500' : a.status === 'comfort' ? 'bg-amber-400' : a.status === 'lead' ? 'bg-violet-400' : 'bg-cyan-400'
          return (
            <button key={a.f.icao} onClick={() => onFly(a.f.icao)} className="w-full text-left px-3 py-2 border-b border-slate-800/60 hover:bg-slate-800/50 flex items-stretch gap-2">
              <div className={`w-1 rounded-sm ${stripe}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-slate-400 w-5">#{a.seq}</span>
                  <span className="text-sm font-semibold text-slate-100 truncate">{a.f.callsign || a.f.icao}</span>
                  <span className="text-[10px] text-slate-500 font-mono">{a.f.type || ''}</span>
                  {a.status === 'conflict' && <span className="ml-auto text-[9px] px-1 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40">CONFLICT</span>}
                  {a.status === 'comfort' && <span className="ml-auto text-[9px] px-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">TIGHT</span>}
                  {a.status === 'lead' && <span className="ml-auto text-[9px] px-1 rounded bg-violet-500/20 text-violet-300 border border-violet-500/40">LEAD</span>}
                </div>
                <div className="text-[10px] text-slate-400 truncate">{a.f.operator || '—'}</div>
                <div className="text-[10px] font-mono text-slate-300 flex gap-3 mt-0.5">
                  <span>T-<span className="text-cyan-300">{fmtMMSS(a.ttsSec)}</span></span>
                  <span><span className="text-slate-500">RNG</span> {a.rangeNm.toFixed(1)}nm</span>
                  <span><span className="text-slate-500">FL</span>{Math.round(a.f.altitudeFt / 100).toString().padStart(3, '0')}</span>
                  <span><span className="text-slate-500">GS</span> {Math.round(a.f.velocityKts)}</span>
                </div>
                {a.seq > 1 && (
                  <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                    <span className="text-slate-500">in-trail</span> {a.prevGapNm.toFixed(1)}nm / {fmtMMSS(a.prevGapSec)}
                  </div>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
