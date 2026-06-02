'use client'
import { useMemo, useState } from 'react'

export interface PhaseFlight {
  icao: string
  callsign: string
  altitudeFt: number
  ground: boolean
  vertRate: number
  velocityKts: number
  category?: string
  emergency?: boolean
}

export type Phase =
  | 'parked'
  | 'taxi'
  | 'takeoff'
  | 'climb'
  | 'cruise'
  | 'descent'
  | 'approach'
  | 'landing'
  | 'unknown'

interface Props {
  flights: PhaseFlight[]
  selectedIcao?: string
  onSelect: (icao: string) => void
  onClose: () => void
}

const PHASE_META: Record<Phase, { label: string; color: string; icon: string; desc: string }> = {
  parked:   { label: 'PARKED',   color: '#475569', icon: 'P',  desc: 'On ground, <5 kt' },
  taxi:     { label: 'TAXI',     color: '#94a3b8', icon: 'T',  desc: 'On ground, 5-40 kt' },
  takeoff:  { label: 'TAKEOFF',  color: '#f97316', icon: '↗', desc: 'Below 1500ft AGL, climbing >1500 fpm' },
  climb:    { label: 'CLIMB',    color: '#eab308', icon: '▲', desc: 'Climbing >500 fpm' },
  cruise:   { label: 'CRUISE',   color: '#22c55e', icon: '►', desc: 'Level ±500 fpm, FL180+' },
  descent:  { label: 'DESCENT',  color: '#06b6d4', icon: '▼', desc: 'Descending >500 fpm' },
  approach: { label: 'APPROACH', color: '#a78bfa', icon: '↘', desc: '<5000ft, descending, >120 kt' },
  landing:  { label: 'LANDING',  color: '#f43f5e', icon: 'L',  desc: '<1500ft, <140 kt, descending' },
  unknown:  { label: 'UNKNOWN',  color: '#334155', icon: '?',  desc: 'Insufficient data' },
}

const PHASES: Phase[] = ['parked','taxi','takeoff','climb','cruise','descent','approach','landing','unknown']

function classify(f: PhaseFlight): Phase {
  const v = f.vertRate || 0
  const gs = f.velocityKts || 0
  const alt = f.altitudeFt || 0
  if (f.ground) {
    if (gs < 5) return 'parked'
    return 'taxi'
  }
  if (alt < 1500 && v > 1500 && gs > 80) return 'takeoff'
  if (alt < 1500 && gs < 160 && v < -200) return 'landing'
  if (alt < 5000 && v < -400 && gs > 120 && gs < 250) return 'approach'
  if (v > 500) return 'climb'
  if (v < -500) return 'descent'
  if (alt > 18000 && v > -500 && v < 500) return 'cruise'
  if (alt > 8000 && v > -300 && v < 300) return 'cruise'
  if (alt > 0 && gs > 60) return 'cruise'
  return 'unknown'
}

export default function PhasePanel({ flights, selectedIcao, onSelect, onClose }: Props) {
  const [filter, setFilter] = useState<Set<Phase>>(new Set())
  const [query, setQuery] = useState('')

  const classified = useMemo(() => {
    return flights.map(f => ({ f, phase: classify(f) }))
  }, [flights])

  const counts = useMemo(() => {
    const c: Record<Phase, number> = { parked:0, taxi:0, takeoff:0, climb:0, cruise:0, descent:0, approach:0, landing:0, unknown:0 }
    for (const x of classified) c[x.phase]++
    return c
  }, [classified])

  const total = classified.length || 1
  const airborne = total - counts.parked - counts.taxi
  const q = query.trim().toUpperCase()

  const rows = useMemo(() => {
    const active = filter.size === 0 ? null : filter
    return classified
      .filter(x => !active || active.has(x.phase))
      .filter(x => !q || x.f.callsign.toUpperCase().includes(q) || x.f.icao.toUpperCase().includes(q))
      .sort((a,b) => {
        const pa = PHASES.indexOf(a.phase), pb = PHASES.indexOf(b.phase)
        if (pa !== pb) return pa - pb
        return (b.f.altitudeFt||0) - (a.f.altitudeFt||0)
      })
      .slice(0, 300)
  }, [classified, filter, q])

  // Donut math
  const R = 42, C = 2 * Math.PI * R
  let acc = 0
  const segments = PHASES.map(p => {
    const v = counts[p]
    const frac = v / total
    const len = frac * C
    const seg = { p, len, offset: acc, color: PHASE_META[p].color, v }
    acc += len
    return seg
  })

  const togglePhase = (p: Phase) => {
    const n = new Set(filter)
    if (n.has(p)) n.delete(p); else n.add(p)
    setFilter(n)
  }

  return (
    <div className="absolute top-20 right-3 z-30 w-[340px] max-h-[calc(100vh-110px)] bg-slate-900/95 backdrop-blur border border-slate-700/60 rounded-lg shadow-2xl flex flex-col text-slate-100 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold tracking-widest text-emerald-400">PHASE</span>
          <span className="text-[10px] text-slate-400">{airborne} airborne / {total} total</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white text-sm leading-none px-1" aria-label="Close">×</button>
      </div>

      <div className="flex items-center gap-3 px-3 py-3 border-b border-slate-800">
        <svg width="110" height="110" viewBox="-55 -55 110 110" className="shrink-0">
          <circle r={R} fill="none" stroke="#1e293b" strokeWidth="14" />
          {segments.map((s, i) => s.len > 0 && (
            <circle key={i} r={R} fill="none" stroke={s.color} strokeWidth="14"
              strokeDasharray={`${s.len} ${C - s.len}`}
              strokeDashoffset={-s.offset}
              transform="rotate(-90)" />
          ))}
          <text textAnchor="middle" dy="-2" fill="#e2e8f0" fontSize="14" fontWeight="700">{airborne}</text>
          <text textAnchor="middle" dy="12" fill="#64748b" fontSize="8">AIRBORNE</text>
        </svg>
        <div className="grid grid-cols-2 gap-x-2 gap-y-1 flex-1">
          {PHASES.filter(p => counts[p] > 0).map(p => (
            <div key={p} className="flex items-center gap-1.5 text-[10px]">
              <span className="w-2 h-2 rounded-sm" style={{ background: PHASE_META[p].color }} />
              <span className="text-slate-300 flex-1 truncate">{PHASE_META[p].label}</span>
              <span className="text-slate-400 tabular-nums">{counts[p]}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 flex flex-wrap gap-1">
        {PHASES.map(p => {
          const active = filter.has(p)
          const dim = counts[p] === 0
          return (
            <button
              key={p}
              onClick={() => togglePhase(p)}
              disabled={dim}
              className={`px-1.5 py-0.5 rounded text-[9px] font-mono tracking-wider border transition ${
                active
                  ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-300'
                  : dim
                    ? 'border-slate-800 text-slate-600 cursor-not-allowed'
                    : 'border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500'
              }`}
              title={PHASE_META[p].desc}
            >
              <span className="mr-0.5" style={{ color: active ? PHASE_META[p].color : undefined }}>{PHASE_META[p].icon}</span>
              {PHASE_META[p].label} <span className="opacity-70">{counts[p]}</span>
            </button>
          )
        })}
        {filter.size > 0 && (
          <button onClick={() => setFilter(new Set())} className="px-1.5 py-0.5 rounded text-[9px] text-slate-400 hover:text-rose-300 ml-auto">CLEAR</button>
        )}
      </div>

      <div className="px-3 py-2 border-b border-slate-800">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter callsign / hex…"
          className="w-full bg-slate-950/60 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/60"
        />
      </div>

      <div className="overflow-y-auto flex-1 min-h-0">
        {rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No aircraft match.</div>
        ) : rows.map(({ f, phase }) => {
          const meta = PHASE_META[phase]
          const sel = selectedIcao === f.icao
          return (
            <button
              key={f.icao}
              onClick={() => onSelect(f.icao)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 border-b border-slate-800/60 text-left hover:bg-slate-800/60 ${sel ? 'bg-emerald-500/10' : ''}`}
            >
              <span
                className="w-6 h-6 rounded flex items-center justify-center text-[11px] font-bold shrink-0"
                style={{ background: meta.color + '22', color: meta.color }}
                title={meta.label}
              >{meta.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className={`font-mono text-[11px] truncate ${f.emergency ? 'text-rose-300' : 'text-slate-100'}`}>{f.callsign || f.icao.toUpperCase()}</span>
                  <span className="text-[9px] text-slate-500 tabular-nums">{f.icao.toUpperCase()}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-slate-400 tabular-nums">
                  <span style={{ color: meta.color }} className="font-mono w-14">{meta.label}</span>
                  <span>{f.ground ? 'GND' : 'FL' + String(Math.round(f.altitudeFt/100)).padStart(3,'0')}</span>
                  <span>{Math.round(f.velocityKts||0)}kt</span>
                  <span className={f.vertRate>200?'text-emerald-400':f.vertRate<-200?'text-rose-400':'text-slate-500'}>
                    {f.vertRate ? `${f.vertRate>0?'+':''}${Math.round(f.vertRate)}` : '·'}
                  </span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 flex items-center justify-between">
        <span>Heuristic from alt / VS / GS</span>
        <span>{rows.length === 300 ? '300+ shown' : `${rows.length} shown`}</span>
      </div>
    </div>
  )
}
