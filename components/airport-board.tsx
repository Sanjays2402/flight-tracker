'use client'
import { useEffect, useMemo, useState } from 'react'
import { AIRPORTS, type AirportPin } from './airports'

interface F {
  icao: string
  callsign: string
  registration: string
  type: string
  operator: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  vertRate: number
  track: number
  ground: boolean
  emergency: boolean
}

interface Props {
  flights: F[]
  centerLat: number
  centerLng: number
  onClose: () => void
  onFly: (icao: string) => void
  onFlyAirport: (a: AirportPin) => void
}

const R_NM = 3440.065
function rad(d:number){return d*Math.PI/180}
function nmBetween(la1:number,lo1:number,la2:number,lo2:number){
  const φ1=rad(la1),φ2=rad(la2),dφ=rad(la2-la1),dλ=rad(lo2-lo1)
  const a=Math.sin(dφ/2)**2+Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2*R_NM*Math.asin(Math.min(1,Math.sqrt(a)))
}
function bearing(la1:number,lo1:number,la2:number,lo2:number){
  const φ1=rad(la1),φ2=rad(la2),dλ=rad(lo2-lo1)
  const y=Math.sin(dλ)*Math.cos(φ2)
  const x=Math.cos(φ1)*Math.sin(φ2)-Math.sin(φ1)*Math.cos(φ2)*Math.cos(dλ)
  return ((Math.atan2(y,x)*180/Math.PI)+360)%360
}
function fmtClock(d:Date){
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

// Split-flap style character cell
function Flap({ ch, color = 'text-amber-300' }: { ch: string; color?: string }) {
  return (
    <span className={`inline-flex items-center justify-center w-[14px] h-[20px] bg-black/70 border border-amber-900/40 rounded-[2px] font-mono text-[13px] ${color} mr-[1px] shadow-inner`}>
      {ch || ' '}
    </span>
  )
}
function FlapText({ s, w, color }: { s: string; w: number; color?: string }) {
  const padded = (s || '').toUpperCase().slice(0, w).padEnd(w, ' ')
  return <span className="inline-flex">{[...padded].map((c, i) => <Flap key={i} ch={c} color={color} />)}</span>
}

export default function AirportBoard(props: Props) {
  const { flights, centerLat, centerLng } = props
  const [now, setNow] = useState(() => new Date())
  const [tab, setTab] = useState<'arr' | 'dep'>('arr')
  const [radiusNm, setRadiusNm] = useState<number>(80)
  const [apOverride, setApOverride] = useState<AirportPin | null>(null)

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  // Find nearest major airport to current map center
  const airport: AirportPin | null = useMemo(() => {
    if (apOverride) return apOverride
    let best: AirportPin | null = null
    let bestD = Infinity
    for (const a of AIRPORTS) {
      const d = nmBetween(centerLat, centerLng, a.lat, a.lon)
      if (d < bestD) { bestD = d; best = a }
    }
    return best
  }, [centerLat, centerLng, apOverride])

  // Nearby airport alternatives (closest 6)
  const alts = useMemo(() => {
    return [...AIRPORTS]
      .map(a => ({ a, d: nmBetween(centerLat, centerLng, a.lat, a.lon) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, 6)
  }, [centerLat, centerLng])

  const rows = useMemo(() => {
    if (!airport) return [] as any[]
    const out: Array<{
      f: F; dNm: number; brgToAp: number; brgPlane: number; closing: boolean;
      etaMin: number | null; status: string; statusColor: string;
    }> = []
    for (const f of flights) {
      if (f.ground) continue
      const d = nmBetween(f.lat, f.lng, airport.lat, airport.lon)
      if (d > radiusNm) continue
      const brgToAp = bearing(f.lat, f.lng, airport.lat, airport.lon)
      // angle between aircraft track and bearing-to-airport
      let diff = Math.abs(((f.track - brgToAp + 540) % 360) - 180)
      const closing = diff < 60   // pointing toward airport
      const leaving = diff > 120  // pointing away

      const isArr = closing && f.vertRate < 200
      const isDep = leaving && (f.vertRate > 200 || f.altitudeFt < 12000)
      if (tab === 'arr' && !isArr) continue
      if (tab === 'dep' && !isDep) continue

      // ETA: distance / closure speed (groundspeed * cos(angle))
      const closureKts = Math.max(40, f.velocityKts * Math.cos(rad(diff)))
      const etaMin = closing ? (d / closureKts) * 60 : null

      let status = 'ENROUTE', statusColor = 'text-amber-300'
      if (tab === 'arr') {
        if (f.altitudeFt < 3000) { status = 'FINAL'; statusColor = 'text-emerald-300' }
        else if (f.altitudeFt < 8000) { status = 'APPROACH'; statusColor = 'text-cyan-300' }
        else if (f.vertRate < -500) { status = 'DESCENT'; statusColor = 'text-amber-300' }
        else { status = 'ENROUTE'; statusColor = 'text-amber-300' }
      } else {
        if (f.altitudeFt < 3000) { status = 'DEPARTED'; statusColor = 'text-emerald-300' }
        else if (f.vertRate > 1000) { status = 'CLIMB'; statusColor = 'text-cyan-300' }
        else { status = 'ENROUTE'; statusColor = 'text-amber-300' }
      }
      if (f.emergency) { status = 'EMERG'; statusColor = 'text-rose-400' }

      out.push({ f, dNm: d, brgToAp, brgPlane: f.track, closing, etaMin, status, statusColor })
    }
    if (tab === 'arr') out.sort((a, b) => (a.etaMin ?? 999) - (b.etaMin ?? 999))
    else out.sort((a, b) => a.dNm - b.dNm)
    return out.slice(0, 40)
  }, [flights, airport, radiusNm, tab])

  if (!airport) return null

  const apTitle = airport.n ? `${airport.a} · ${airport.n}` : airport.a

  return (
    <div className="absolute top-20 right-4 z-30 w-[26rem] max-h-[calc(100vh-7rem)] bg-slate-950/95 backdrop-blur-xl border border-amber-900/30 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
      {/* Departure-board header */}
      <div className="px-4 py-3 border-b border-amber-900/30 bg-gradient-to-b from-amber-950/30 to-transparent">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-amber-500/80 font-semibold">Airport Board</div>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span className="font-mono text-2xl font-bold text-amber-300 tracking-wider">{airport.a}</span>
              <span className="text-[10px] text-slate-500 font-mono">{airport.i}</span>
            </div>
            <div className="text-[11px] text-slate-400 truncate" title={apTitle}>{airport.m}</div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <button onClick={props.onClose} className="text-slate-500 hover:text-slate-100 text-lg leading-none">✕</button>
            <button onClick={() => airport && props.onFlyAirport(airport)}
              className="text-[10px] uppercase tracking-widest text-amber-300 hover:text-amber-100 border border-amber-900/40 rounded px-1.5 py-0.5">
              FLY TO
            </button>
          </div>
        </div>

        {/* Big flap clock */}
        <div className="mt-2 flex items-center gap-2">
          <FlapText s={fmtClock(now)} w={5} />
          <span className="text-[9px] uppercase tracking-widest text-slate-500 font-mono">LOCAL · {rows.length} TRAFFIC</span>
        </div>

        {/* tabs */}
        <div className="mt-2 flex items-center gap-1">
          <button onClick={() => setTab('arr')}
            className={`flex-1 text-[11px] font-mono uppercase tracking-widest py-1.5 rounded ${tab === 'arr' ? 'bg-amber-500/20 text-amber-200 border border-amber-700/50' : 'text-slate-500 border border-slate-800 hover:text-slate-300'}`}>
            ↓ Arrivals
          </button>
          <button onClick={() => setTab('dep')}
            className={`flex-1 text-[11px] font-mono uppercase tracking-widest py-1.5 rounded ${tab === 'dep' ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-700/50' : 'text-slate-500 border border-slate-800 hover:text-slate-300'}`}>
            ↑ Departures
          </button>
        </div>
      </div>

      {/* Airport selector + radius */}
      <div className="px-4 py-2 border-b border-slate-800 flex items-center gap-2">
        <select
          value={airport.i}
          onChange={e => { const a = alts.find(x => x.a.i === e.target.value); if (a) setApOverride(a.a) }}
          className="flex-1 bg-slate-900 border border-slate-800 text-[11px] font-mono text-slate-300 rounded px-1.5 py-1 outline-none"
        >
          {alts.map(({ a, d }) => (
            <option key={a.i} value={a.i}>{a.a} · {a.m} · {Math.round(d)}nm</option>
          ))}
        </select>
        <label className="text-[10px] text-slate-500 font-mono flex items-center gap-1">
          R
          <input type="number" min={20} max={300} step={10} value={radiusNm}
            onChange={e => setRadiusNm(Math.max(20, Math.min(300, Number(e.target.value) || 80)))}
            className="w-12 bg-slate-900 border border-slate-800 rounded px-1 py-0.5 text-amber-300 text-right" />
          <span>nm</span>
        </label>
      </div>

      {/* Column headers */}
      <div className="px-4 py-1.5 border-b border-slate-800 grid grid-cols-12 gap-1 text-[9px] uppercase tracking-widest text-slate-500 font-mono">
        <div className="col-span-3">Flight</div>
        <div className="col-span-3">Type/Op</div>
        <div className="col-span-2 text-right">{tab === 'arr' ? 'ETA' : 'Dist'}</div>
        <div className="col-span-2 text-right">FL</div>
        <div className="col-span-2 text-right">Status</div>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-slate-900/60">
        {rows.length === 0 && (
          <div className="px-4 py-12 text-center text-xs text-slate-500">
            No {tab === 'arr' ? 'inbound' : 'outbound'} traffic detected<br />
            <span className="text-slate-600">within {radiusNm}nm of {airport.a}.</span>
          </div>
        )}
        {rows.map(r => {
          const cs = (r.f.callsign || r.f.icao).toUpperCase()
          const eta = r.etaMin == null ? '—' : (r.etaMin < 1 ? 'NOW' : r.etaMin < 60 ? `${Math.round(r.etaMin)}m` : `${Math.floor(r.etaMin / 60)}h${String(Math.round(r.etaMin % 60)).padStart(2, '0')}`)
          return (
            <button key={r.f.icao} onClick={() => props.onFly(r.f.icao)}
              className="w-full text-left px-4 py-2 hover:bg-amber-950/15 transition grid grid-cols-12 gap-1 items-center">
              <div className="col-span-3 min-w-0">
                <FlapText s={cs.slice(0, 7)} w={7} />
              </div>
              <div className="col-span-3 min-w-0">
                <div className="font-mono text-[10px] text-slate-300 truncate">{r.f.type || '—'}</div>
                <div className="text-[9px] text-slate-500 truncate">{r.f.operator || r.f.registration || '—'}</div>
              </div>
              <div className="col-span-2 text-right">
                {tab === 'arr'
                  ? <FlapText s={eta} w={5} color="text-emerald-300" />
                  : <FlapText s={`${Math.round(r.dNm)}NM`} w={5} color="text-cyan-300" />}
              </div>
              <div className="col-span-2 text-right">
                <span className="font-mono text-[11px] text-slate-200">FL{String(Math.round(r.f.altitudeFt / 100)).padStart(3, '0')}</span>
                <div className="text-[9px] font-mono text-slate-500">
                  {r.f.vertRate > 100 ? '↑' : r.f.vertRate < -100 ? '↓' : '·'} {Math.abs(Math.round(r.f.vertRate))}
                </div>
              </div>
              <div className="col-span-2 text-right">
                <span className={`font-mono text-[10px] uppercase tracking-wider ${r.statusColor}`}>{r.status}</span>
                <div className="text-[9px] font-mono text-slate-500">{Math.round(r.f.velocityKts)}kt</div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-4 py-1.5 border-t border-slate-800 bg-slate-950 text-[9px] uppercase tracking-widest text-slate-600 font-mono flex items-center justify-between">
        <span>HEURISTIC · LIVE ADS-B</span>
        <span className="text-amber-500/60">● {fmtClock(now)}</span>
      </div>
    </div>
  )
}
