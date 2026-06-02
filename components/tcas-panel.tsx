'use client'
import { useEffect, useMemo, useState } from 'react'

/* ============================================================
   TCAS-style Traffic Display
   ---------------------------------------------------------------
   Round head-up scope centered on the selected aircraft (or map
   center if none). Shows surrounding traffic as relative bearing
   + range, with classic TCAS symbology:
     - Diamond (OTHER)   : > 6nm or > ±1200ft
     - Diamond filled    : PROXIMATE (<6nm and ±1200ft)
     - Solid amber circle: TRAFFIC ADVISORY (TA)
     - Solid red square  : RESOLUTION ADVISORY (RA)
   Each contact shows relative altitude in hundreds of feet
   (+/- prefix), plus a VS arrow if climb/descend > 500fpm.
   Range knob: 5/10/20/40/80nm. Above-only / below-only filters.
   Heading-up vs north-up. Click contact to fly. Self-contained
   SVG; no MapLibre layers, no new deps.
   ============================================================ */

export interface TcasFlight {
  icao: string
  callsign: string
  type: string
  lat: number
  lng: number
  altitudeFt: number
  ground: boolean
  velocityKts: number
  vertRate: number
  track: number
}

interface Props {
  flights: TcasFlight[]
  ownship: TcasFlight | null            // selected aircraft (preferred)
  ownshipFallback: { lat: number; lng: number; altitudeFt: number; track: number } | null
  onClose: () => void
  onFly?: (icao: string) => void
}

const R_NM = 3440.065
const RAD = Math.PI / 180
const DEG = 180 / Math.PI

function distNm(la1: number, lo1: number, la2: number, lo2: number) {
  const φ1 = la1 * RAD, φ2 = la2 * RAD
  const dφ = (la2 - la1) * RAD
  const dλ = (lo2 - lo1) * RAD
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(s)))
}
function bearing(la1: number, lo1: number, la2: number, lo2: number) {
  const φ1 = la1 * RAD, φ2 = la2 * RAD
  const dλ = (lo2 - lo1) * RAD
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * DEG + 360) % 360
}

type Threat = 'RA' | 'TA' | 'PROX' | 'OTHER'

interface Contact {
  f: TcasFlight
  rangeNm: number
  brgTrue: number
  brgRel: number   // relative to ownship heading (heading-up scope)
  relAltFt: number // contact - own
  threat: Threat
}

const RANGES = [5, 10, 20, 40, 80]

export default function TcasPanel({ flights, ownship, ownshipFallback, onClose, onFly }: Props) {
  const [rangeNm, setRangeNm] = useState<number>(20)
  const [headingUp, setHeadingUp] = useState(true)
  const [showAbove, setShowAbove] = useState(true)
  const [showBelow, setShowBelow] = useState(true)
  const [hover, setHover] = useState<Contact | null>(null)

  const own = useMemo(() => {
    if (ownship) return { lat: ownship.lat, lng: ownship.lng, altitudeFt: ownship.altitudeFt, track: ownship.track, icao: ownship.icao }
    if (ownshipFallback) return { lat: ownshipFallback.lat, lng: ownshipFallback.lng, altitudeFt: ownshipFallback.altitudeFt, track: ownshipFallback.track, icao: '' }
    return null
  }, [ownship, ownshipFallback])

  const contacts = useMemo<Contact[]>(() => {
    if (!own) return []
    const ownAlt = own.altitudeFt || 0
    const hdg = own.track || 0
    const out: Contact[] = []
    for (const f of flights) {
      if (own.icao && f.icao === own.icao) continue
      const r = distNm(own.lat, own.lng, f.lat, f.lng)
      if (r > rangeNm * 1.05) continue
      const brg = bearing(own.lat, own.lng, f.lat, f.lng)
      const relAlt = (f.altitudeFt || 0) - ownAlt
      if (!showAbove && relAlt > 200) continue
      if (!showBelow && relAlt < -200) continue
      // TCAS-ish classification (tuned for live traffic, not real TA/RA)
      let threat: Threat = 'OTHER'
      const absAlt = Math.abs(relAlt)
      if (r <= 1.5 && absAlt <= 700) threat = 'RA'
      else if (r <= 3 && absAlt <= 1000) threat = 'TA'
      else if (r <= 6 && absAlt <= 1200) threat = 'PROX'
      out.push({
        f, rangeNm: r, brgTrue: brg,
        brgRel: (brg - hdg + 360) % 360,
        relAltFt: relAlt, threat,
      })
    }
    return out.sort((a, b) => threatRank(b.threat) - threatRank(a.threat) || a.rangeNm - b.rangeNm)
  }, [flights, own, rangeNm, showAbove, showBelow])

  // simple flash for RA
  const [flash, setFlash] = useState(false)
  useEffect(() => {
    const ra = contacts.some(c => c.threat === 'RA')
    if (!ra) { setFlash(false); return }
    const t = setInterval(() => setFlash(f => !f), 500)
    return () => clearInterval(t)
  }, [contacts])

  // counts
  const counts = useMemo(() => {
    let ra = 0, ta = 0, pr = 0, ot = 0
    for (const c of contacts) {
      if (c.threat === 'RA') ra++
      else if (c.threat === 'TA') ta++
      else if (c.threat === 'PROX') pr++
      else ot++
    }
    return { ra, ta, pr, ot, total: contacts.length }
  }, [contacts])

  const W = 360, H = 360
  const cx = W / 2, cy = H / 2
  const rPx = Math.min(W, H) / 2 - 14

  function project(brgRel: number, range: number) {
    const r = (range / rangeNm) * rPx
    const θ = (headingUp ? brgRel : brgRel) * RAD
    // up = north (or heading); 0deg → top
    return { x: cx + r * Math.sin(θ), y: cy - r * Math.cos(θ) }
  }

  return (
    <div className="absolute right-2 sm:right-4 top-16 sm:top-20 z-30 bg-slate-950/92 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-100 w-[360px] max-w-[96vw] max-h-[86vh] flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${counts.ra ? (flash ? 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.9)]' : 'bg-rose-700') : counts.ta ? 'bg-amber-400' : 'bg-emerald-400'}`} />
          <div className="text-[11px] font-semibold tracking-wider uppercase text-slate-200">TCAS</div>
          <div className="text-[10px] text-slate-500 font-mono">
            {own ? (ownship ? (ownship.callsign || ownship.icao) : 'CTR') : 'NO OWN'}
          </div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none px-1">✕</button>
      </div>

      {/* counters */}
      <div className="px-3 py-2 grid grid-cols-4 gap-1 text-center border-b border-slate-800/70">
        <Cnt label="RA"   value={counts.ra} color="text-rose-400" />
        <Cnt label="TA"   value={counts.ta} color="text-amber-300" />
        <Cnt label="PROX" value={counts.pr} color="text-cyan-300" />
        <Cnt label="OTHR" value={counts.ot} color="text-slate-300" />
      </div>

      {/* scope */}
      <div className="px-3 py-3 flex flex-col items-center bg-gradient-to-b from-slate-950 to-slate-900/40">
        <svg width={W} height={H} className="rounded-full border border-slate-800 bg-slate-950">
          {/* range rings */}
          {[0.25, 0.5, 0.75, 1.0].map((f, i) => (
            <circle key={i} cx={cx} cy={cy} r={rPx * f} fill="none" stroke={i === 3 ? '#1f2937' : '#111827'} strokeDasharray={i === 3 ? '' : '3 3'} />
          ))}
          {/* compass spokes */}
          {[0, 90, 180, 270].map(a => {
            const p = project(a, rangeNm)
            return <line key={a} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#1f2937" strokeWidth={1} />
          })}
          {/* compass labels */}
          {[['N',0],['E',90],['S',180],['W',270]].map(([lbl, a]) => {
            const p = project(a as number, rangeNm * 1.04)
            return <text key={lbl as string} x={p.x} y={p.y + 3} textAnchor="middle" fontSize={9} fill="#475569" fontFamily="monospace">{lbl as string}</text>
          })}
          {/* range labels */}
          {[0.5, 1.0].map((f, i) => (
            <text key={i} x={cx + 4} y={cy - rPx * f - 2} fontSize={9} fill="#475569" fontFamily="monospace">{Math.round(rangeNm * f)}</text>
          ))}
          {/* ownship */}
          <g transform={`translate(${cx},${cy})`}>
            <polygon points="0,-9 6,7 -6,7" fill="#22d3ee" stroke="#0e7490" strokeWidth={1} />
          </g>
          {/* contacts */}
          {contacts.map(c => {
            const r = Math.min(c.rangeNm, rangeNm)
            const p = project(c.brgRel, r)
            return (
              <ContactGlyph
                key={c.f.icao}
                c={c}
                x={p.x}
                y={p.y}
                flash={flash && c.threat === 'RA'}
                onHover={() => setHover(c)}
                onLeave={() => setHover(h => (h && h.f.icao === c.f.icao ? null : h))}
                onClick={() => onFly && onFly(c.f.icao)}
              />
            )
          })}
          {/* heading-up label */}
          <text x={cx} y={14} textAnchor="middle" fontSize={9} fill="#64748b" fontFamily="monospace">{headingUp ? 'HDG UP' : 'N UP'}</text>
        </svg>

        {/* hover readout */}
        <div className="w-full mt-2 min-h-[36px] px-2 py-1 rounded bg-slate-900/60 border border-slate-800/70 text-[11px] font-mono text-slate-300">
          {hover ? (
            <div className="flex justify-between gap-2">
              <div className="truncate">
                <span className={threatTextColor(hover.threat)}>{hover.threat}</span>{' '}
                <span className="text-slate-100">{hover.f.callsign || hover.f.icao}</span>
                <span className="text-slate-500"> · {hover.f.type || '—'}</span>
              </div>
              <div className="text-slate-400 shrink-0">
                {hover.rangeNm.toFixed(1)}nm · {Math.round(hover.brgTrue).toString().padStart(3,'0')}° · {fmtRelAlt(hover.relAltFt)}
              </div>
            </div>
          ) : (
            <div className="text-slate-500 text-[10px]">Hover a contact. Click to fly to it.</div>
          )}
        </div>
      </div>

      {/* controls */}
      <div className="px-3 pb-2 flex flex-col gap-2 border-b border-slate-800/70">
        <div className="flex items-center gap-1">
          <div className="text-[10px] text-slate-500 mr-1">RNG</div>
          {RANGES.map(r => (
            <button key={r} onClick={() => setRangeNm(r)}
              className={`text-[10px] font-mono px-2 py-0.5 rounded border ${rangeNm===r ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-200' : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'}`}>{r}</button>
          ))}
          <div className="flex-1" />
          <button onClick={() => setHeadingUp(v => !v)} className={`text-[10px] font-mono px-2 py-0.5 rounded border ${headingUp ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-200' : 'bg-slate-900 border-slate-800 text-slate-400'}`}>{headingUp ? 'HDG' : 'NRTH'}</button>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setShowAbove(v => !v)} className={`text-[10px] font-mono px-2 py-0.5 rounded border ${showAbove ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-slate-900 border-slate-800 text-slate-600'}`}>▲ ABOVE</button>
          <button onClick={() => setShowBelow(v => !v)} className={`text-[10px] font-mono px-2 py-0.5 rounded border ${showBelow ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-slate-900 border-slate-800 text-slate-600'}`}>▼ BELOW</button>
          <div className="flex-1 text-right text-[10px] text-slate-500 font-mono">
            {own ? `OWN FL${Math.round((own.altitudeFt||0)/100).toString().padStart(3,'0')}` : '—'}
          </div>
        </div>
      </div>

      {/* threat list */}
      <div className="flex-1 overflow-y-auto">
        {contacts.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-slate-500">No traffic within {rangeNm}nm</div>
        ) : (
          <div className="divide-y divide-slate-800/60">
            {contacts.slice(0, 80).map(c => (
              <button key={c.f.icao}
                onClick={() => onFly && onFly(c.f.icao)}
                onMouseEnter={() => setHover(c)}
                onMouseLeave={() => setHover(h => (h && h.f.icao === c.f.icao ? null : h))}
                className="w-full text-left px-3 py-1.5 hover:bg-slate-900/70 flex items-center gap-2 text-[11px] font-mono">
                <span className={`w-10 shrink-0 text-center rounded px-1 py-0.5 text-[9px] font-bold ${threatBgColor(c.threat)}`}>{c.threat}</span>
                <span className="w-20 truncate text-slate-100">{c.f.callsign || c.f.icao}</span>
                <span className="w-12 text-right text-slate-400">{c.rangeNm.toFixed(1)}nm</span>
                <span className="w-10 text-right text-slate-400">{Math.round(c.brgTrue).toString().padStart(3,'0')}°</span>
                <span className={`w-12 text-right ${c.relAltFt > 0 ? 'text-sky-300' : c.relAltFt < 0 ? 'text-amber-300' : 'text-slate-300'}`}>{fmtRelAlt(c.relAltFt)}</span>
                <span className="w-5 text-right">{vsArrow(c.f.vertRate)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Cnt({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className={`text-base font-bold font-mono ${color}`}>{value}</div>
      <div className="text-[9px] tracking-wider text-slate-500">{label}</div>
    </div>
  )
}

function ContactGlyph({ c, x, y, flash, onHover, onLeave, onClick }: {
  c: Contact; x: number; y: number; flash: boolean
  onHover: () => void; onLeave: () => void; onClick: () => void
}) {
  const rel = c.relAltFt
  const sign = rel > 100 ? '+' : rel < -100 ? '−' : ' '
  const tag = `${sign}${String(Math.round(Math.abs(rel) / 100)).padStart(2, '0')}`
  const vs = c.f.vertRate
  const vsTag = vs >= 500 ? '↑' : vs <= -500 ? '↓' : ''
  const offY = rel >= 0 ? -10 : 14

  let glyph: React.ReactNode = null
  if (c.threat === 'RA') {
    glyph = <rect x={-6} y={-6} width={12} height={12} fill={flash ? '#ef4444' : '#b91c1c'} stroke="#fecaca" strokeWidth={1} />
  } else if (c.threat === 'TA') {
    glyph = <circle r={6.5} fill="#f59e0b" stroke="#fde68a" strokeWidth={1} />
  } else if (c.threat === 'PROX') {
    glyph = <polygon points="0,-7 7,0 0,7 -7,0" fill="#22d3ee" stroke="#a5f3fc" strokeWidth={1} />
  } else {
    glyph = <polygon points="0,-7 7,0 0,7 -7,0" fill="none" stroke="#94a3b8" strokeWidth={1.4} />
  }
  const color = c.threat === 'RA' ? '#fecaca' : c.threat === 'TA' ? '#fde68a' : c.threat === 'PROX' ? '#a5f3fc' : '#cbd5e1'

  return (
    <g transform={`translate(${x},${y})`} style={{ cursor: 'pointer' }}
       onMouseEnter={onHover} onMouseLeave={onLeave} onClick={onClick}>
      {glyph}
      <text x={9} y={offY} fontSize={9} fontFamily="monospace" fill={color}>{tag}{vsTag}</text>
    </g>
  )
}

function threatRank(t: Threat) {
  return t === 'RA' ? 4 : t === 'TA' ? 3 : t === 'PROX' ? 2 : 1
}
function threatTextColor(t: Threat) {
  return t === 'RA' ? 'text-rose-400' : t === 'TA' ? 'text-amber-300' : t === 'PROX' ? 'text-cyan-300' : 'text-slate-400'
}
function threatBgColor(t: Threat) {
  return t === 'RA' ? 'bg-rose-600/30 text-rose-200 border border-rose-600/50'
       : t === 'TA' ? 'bg-amber-500/20 text-amber-200 border border-amber-500/40'
       : t === 'PROX' ? 'bg-cyan-500/15 text-cyan-200 border border-cyan-500/40'
       : 'bg-slate-800 text-slate-400 border border-slate-700'
}
function fmtRelAlt(ft: number) {
  if (Math.abs(ft) < 100) return '  00'
  const s = ft > 0 ? '+' : '−'
  return `${s}${String(Math.round(Math.abs(ft) / 100)).padStart(2, '0')}`
}
function vsArrow(vs: number) {
  if (vs >= 500) return <span className="text-sky-300">↑</span>
  if (vs <= -500) return <span className="text-amber-300">↓</span>
  return <span className="text-slate-600">·</span>
}
