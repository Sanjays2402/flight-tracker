'use client'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { AIRPORTS, AirportPin } from './airports'

export interface CPFlight {
  icao: string
  callsign: string
  registration: string
  type: string
  operator: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  military?: boolean
}

export interface CommandPaletteProps {
  flights: CPFlight[]
  onSelectFlight: (icao: string) => void
  onSelectAirport: (ap: AirportPin) => void
  actions: CPAction[]
}

export interface CPAction {
  id: string
  label: string
  hint?: string
  group: 'View' | 'Layers' | 'Mode' | 'Color' | 'Data' | 'Nav'
  run: () => void
  keywords?: string[]
}

type Row =
  | { kind: 'action'; id: string; label: string; hint?: string; group: string; run: () => void; score: number }
  | { kind: 'flight'; id: string; label: string; sub: string; icao: string; score: number }
  | { kind: 'airport'; id: string; label: string; sub: string; ap: AirportPin; score: number }

function fuzzy(needle: string, hay: string): number {
  if (!needle) return 1
  needle = needle.toLowerCase(); hay = hay.toLowerCase()
  if (hay.includes(needle)) return 100 - (hay.indexOf(needle))
  let h = 0, score = 0, run = 0
  for (let i = 0; i < needle.length; i++) {
    const c = needle[i]
    const idx = hay.indexOf(c, h)
    if (idx === -1) return 0
    run = idx === h ? run + 1 : 0
    score += 1 + run * 2
    h = idx + 1
  }
  return score
}

export default function CommandPalette({ flights, onSelectFlight, onSelectAirport, actions }: CommandPaletteProps) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Open on Cmd/Ctrl + K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(v => !v)
        setQ(''); setIdx(0)
      } else if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30)
  }, [open])

  const rows: Row[] = useMemo(() => {
    const r: Row[] = []
    const needle = q.trim()

    // Actions
    for (const a of actions) {
      const hay = `${a.label} ${a.group} ${(a.keywords || []).join(' ')}`
      const s = fuzzy(needle, hay)
      if (s > 0 || !needle) {
        r.push({ kind: 'action', id: 'a:' + a.id, label: a.label, hint: a.hint, group: a.group, run: a.run, score: s || 1 })
      }
    }

    if (needle) {
      // Flights
      for (const f of flights) {
        const hay = `${f.callsign} ${f.icao} ${f.registration} ${f.type} ${f.operator}`
        const s = fuzzy(needle, hay)
        if (s > 0) {
          r.push({
            kind: 'flight', id: 'f:' + f.icao, icao: f.icao,
            label: `${f.callsign || f.icao} · ${f.type || '—'}`,
            sub: `${f.registration || '—'} · ${f.operator || '—'} · ${Math.round(f.altitudeFt).toLocaleString()} ft · ${Math.round(f.velocityKts)} kt${f.military ? ' · MIL' : ''}`,
            score: s + 5,
          })
        }
      }
      // Airports
      for (const ap of AIRPORTS) {
        const hay = `${ap.a} ${ap.i} ${ap.n} ${ap.m}`
        const s = fuzzy(needle, hay)
        if (s > 0) {
          r.push({
            kind: 'airport', id: 'p:' + ap.i, ap,
            label: `${ap.a}/${ap.i} · ${ap.n || ap.m}`,
            sub: ap.m,
            score: s + 3,
          })
        }
      }
    }

    r.sort((a, b) => b.score - a.score)
    return r.slice(0, 60)
  }, [q, flights, actions])

  useEffect(() => { setIdx(0) }, [q])

  const run = useCallback((row: Row) => {
    if (row.kind === 'action') row.run()
    else if (row.kind === 'flight') onSelectFlight(row.icao)
    else if (row.kind === 'airport') onSelectAirport(row.ap)
    setOpen(false)
  }, [onSelectFlight, onSelectAirport])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(rows.length - 1, i + 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)) }
      else if (e.key === 'Enter') { e.preventDefault(); const r = rows[idx]; if (r) run(r) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, rows, idx, run])

  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-cprow="${idx}"]`)
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [idx])

  if (!open) return null

  // Group display
  let lastGroup = ''
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center pt-[10vh] bg-black/60 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-[640px] max-w-[92vw] rounded-xl border border-slate-700 bg-slate-900/95 shadow-2xl overflow-hidden"
        style={{ boxShadow: '0 30px 80px -20px rgba(0,0,0,0.6)' }}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-slate-400">
            <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search flights, airports, or run a command..."
            className="flex-1 bg-transparent outline-none text-sm text-white placeholder:text-slate-500"
          />
          <span className="text-[10px] text-slate-500 border border-slate-700 rounded px-1.5 py-0.5">ESC</span>
        </div>
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1">
          {rows.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-slate-500">No results for "{q}"</div>
          )}
          {rows.map((r, i) => {
            const groupName = r.kind === 'action' ? r.group : r.kind === 'flight' ? 'Flights' : 'Airports'
            const showHeader = groupName !== lastGroup
            lastGroup = groupName
            const active = i === idx
            return (
              <div key={r.id}>
                {showHeader && (
                  <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-slate-500">{groupName}</div>
                )}
                <div
                  data-cprow={i}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => run(r)}
                  className={`mx-1 px-3 py-2 rounded-md cursor-pointer flex items-center gap-3 ${active ? 'bg-sky-500/20 text-white' : 'text-slate-200 hover:bg-slate-800/60'}`}
                >
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                    r.kind === 'flight' ? 'bg-emerald-500/20 text-emerald-300' :
                    r.kind === 'airport' ? 'bg-violet-500/20 text-violet-300' :
                    'bg-slate-700/60 text-slate-300'
                  }`}>
                    {r.kind === 'flight' ? 'FLT' : r.kind === 'airport' ? 'APT' : 'CMD'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{r.label}</div>
                    {('sub' in r && r.sub) && <div className="text-[11px] text-slate-400 truncate">{r.sub}</div>}
                    {('hint' in r && r.hint) && <div className="text-[11px] text-slate-400 truncate">{r.hint}</div>}
                  </div>
                  {active && (
                    <span className="text-[10px] text-slate-400 border border-slate-700 rounded px-1.5 py-0.5">↵</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <div className="flex items-center justify-between px-4 py-2 border-t border-slate-800 text-[10px] text-slate-500">
          <div className="flex gap-3">
            <span><kbd className="border border-slate-700 rounded px-1">↑</kbd><kbd className="border border-slate-700 rounded px-1 ml-0.5">↓</kbd> navigate</span>
            <span><kbd className="border border-slate-700 rounded px-1">↵</kbd> select</span>
          </div>
          <span>{rows.length} result{rows.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>
  )
}
