'use client'
/**
 * Squawk Monitor — live transponder-code intelligence panel.
 *
 * Classifies every aircraft's Mode-A squawk into a meaning bucket using a
 * comprehensive ruleset (ICAO/FAA/UK CAA conventions). Shows:
 *  - Big counter grid by category (Emergency, Special Ops, IFR Conspicuity,
 *    VFR, Military / NORDO, ADS-B Test, Center-assigned, Unassigned).
 *  - Sorted "hot list" — codes with the most aircraft, with descriptions.
 *  - Drill-in: click a category or code → filtered list with click-to-fly.
 *  - Free-text search (code or callsign).
 *  - Flashes briefly on new 7500/7600/7700 hits.
 *
 * Pure SVG/HTML, no extra deps. Read-only: never mutates squawks.
 */
import { useMemo, useState, useEffect, useRef } from 'react'

export interface SqFlight {
  icao: string
  callsign: string
  type: string
  operator: string
  squawk: string
  altitudeFt: number
  velocityKts: number
  lat: number
  lng: number
  ground: boolean
  emergency: boolean
  military?: boolean
}

interface Props {
  flights: SqFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type CatKey = 'EMERG' | 'SPECIAL' | 'IFR' | 'VFR' | 'MIL' | 'TEST' | 'CENTER' | 'NONE'

interface CatDef { key: CatKey; label: string; desc: string; color: string; ring: string }

const CATS: Record<CatKey, CatDef> = {
  EMERG:   { key: 'EMERG',   label: 'EMERGENCY',     desc: '7500 hijack · 7600 radio fail · 7700 general',     color: 'text-rose-400',    ring: 'border-rose-500/60 bg-rose-500/10' },
  SPECIAL: { key: 'SPECIAL', label: 'SPECIAL OPS',   desc: 'SAR · law enforcement · FAA / military intercept',  color: 'text-amber-400',   ring: 'border-amber-500/50 bg-amber-500/10' },
  MIL:     { key: 'MIL',     label: 'MIL / NORDO',   desc: 'Military discrete blocks · 4000 NORDO',             color: 'text-orange-400',  ring: 'border-orange-500/50 bg-orange-500/10' },
  IFR:     { key: 'IFR',     label: 'IFR CONSPICUITY', desc: '2000 enroute · 1000 ADS-B · 0000 reserved',       color: 'text-sky-400',     ring: 'border-sky-500/50 bg-sky-500/10' },
  VFR:     { key: 'VFR',     label: 'VFR',           desc: '1200 US/CA · 7000 ICAO · 1400 glider',              color: 'text-emerald-400', ring: 'border-emerald-500/50 bg-emerald-500/10' },
  CENTER:  { key: 'CENTER',  label: 'CENTER',        desc: 'Discrete codes assigned by ATC',                    color: 'text-violet-400',  ring: 'border-violet-500/50 bg-violet-500/10' },
  TEST:    { key: 'TEST',    label: 'TEST',          desc: '7777 mil intercept · transponder test bench',       color: 'text-fuchsia-400', ring: 'border-fuchsia-500/50 bg-fuchsia-500/10' },
  NONE:    { key: 'NONE',    label: 'NO CODE',       desc: 'Squawk missing or unset',                           color: 'text-slate-400',   ring: 'border-slate-700 bg-slate-800/30' },
}

const KNOWN: Record<string, { cat: CatKey; desc: string }> = {
  '7500': { cat: 'EMERG',   desc: 'Hijack / unlawful interference' },
  '7600': { cat: 'EMERG',   desc: 'Radio communications failure' },
  '7700': { cat: 'EMERG',   desc: 'General emergency' },
  '7777': { cat: 'TEST',    desc: 'Military intercept (no civilian use)' },
  '1200': { cat: 'VFR',     desc: 'VFR (US / Canada)' },
  '7000': { cat: 'VFR',     desc: 'VFR conspicuity (ICAO / Europe)' },
  '1400': { cat: 'VFR',     desc: 'VFR glider (US)' },
  '1202': { cat: 'VFR',     desc: 'VFR glider (US)' },
  '1255': { cat: 'SPECIAL', desc: 'Firefighting aircraft (US)' },
  '1276': { cat: 'SPECIAL', desc: 'ADIZ penetration' },
  '1277': { cat: 'SPECIAL', desc: 'SAR aircraft (US)' },
  '4400': { cat: 'SPECIAL', desc: 'SR-71 / U-2 / pressure-suit ops' },
  '7001': { cat: 'MIL',     desc: 'Military low-level / training (UK)' },
  '7004': { cat: 'MIL',     desc: 'Aerobatic display (UK)' },
  '7400': { cat: 'SPECIAL', desc: 'UAS lost-link' },
  '4000': { cat: 'MIL',     desc: 'VFR military / NORDO' },
  '2000': { cat: 'IFR',     desc: 'IFR entering domestic from oceanic' },
  '1000': { cat: 'IFR',     desc: 'IFR ADS-B (Europe enroute)' },
  '0000': { cat: 'IFR',     desc: 'Reserved / unassigned' },
}

function classify(sq: string, isMil: boolean): { cat: CatKey; desc: string } {
  if (!sq || sq === '0000') {
    if (sq === '0000') return { cat: 'IFR', desc: 'Reserved / unassigned' }
    return { cat: 'NONE', desc: 'No squawk reported' }
  }
  if (KNOWN[sq]) return KNOWN[sq]
  // Block-based heuristics
  if (isMil) return { cat: 'MIL', desc: 'Military discrete code' }
  if (/^4[0-7]\d{2}$/.test(sq) && (sq >= '4400' && sq <= '4477')) return { cat: 'MIL', desc: 'US military discrete block' }
  if (/^5[0-3]\d{2}$/.test(sq)) return { cat: 'MIL', desc: 'US military discrete block' }
  if (/^6[14]\d{2}$/.test(sq)) return { cat: 'MIL', desc: 'US military discrete block' }
  if (sq.startsWith('77') && sq !== '7700') return { cat: 'SPECIAL', desc: 'Reserved 77xx block' }
  return { cat: 'CENTER', desc: 'ATC-assigned discrete code' }
}

export default function SquawkMonitor({ flights, onClose, onFly }: Props) {
  const [activeCat, setActiveCat] = useState<CatKey | null>(null)
  const [activeCode, setActiveCode] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [flash, setFlash] = useState(false)
  const lastEmergRef = useRef<Set<string>>(new Set())

  const tagged = useMemo(() => flights.map(f => {
    const c = classify(f.squawk || '', !!f.military)
    return { f, cat: c.cat, desc: c.desc }
  }), [flights])

  // Flash on new emergency
  useEffect(() => {
    const cur = new Set(tagged.filter(t => t.cat === 'EMERG').map(t => t.f.icao + ':' + t.f.squawk))
    let isNew = false
    cur.forEach(k => { if (!lastEmergRef.current.has(k)) isNew = true })
    if (isNew) {
      setFlash(true)
      const id = setTimeout(() => setFlash(false), 1800)
      lastEmergRef.current = cur
      return () => clearTimeout(id)
    }
    lastEmergRef.current = cur
  }, [tagged])

  const catCounts = useMemo(() => {
    const m: Record<CatKey, number> = { EMERG:0, SPECIAL:0, IFR:0, VFR:0, MIL:0, TEST:0, CENTER:0, NONE:0 }
    for (const t of tagged) m[t.cat]++
    return m
  }, [tagged])

  const codeCounts = useMemo(() => {
    const m = new Map<string, { code: string; count: number; cat: CatKey; desc: string }>()
    for (const t of tagged) {
      const code = t.f.squawk || '----'
      const e = m.get(code)
      if (e) e.count++
      else m.set(code, { code, count: 1, cat: t.cat, desc: t.desc })
    }
    return [...m.values()].sort((a, b) => b.count - a.count)
  }, [tagged])

  const filtered = useMemo(() => {
    let list = tagged
    if (activeCat) list = list.filter(t => t.cat === activeCat)
    if (activeCode) list = list.filter(t => (t.f.squawk || '----') === activeCode)
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      list = list.filter(t => (t.f.squawk || '').includes(s) || (t.f.callsign || '').toLowerCase().includes(s) || t.f.icao.toLowerCase().includes(s))
    }
    return list.sort((a, b) => {
      if (a.cat === 'EMERG' && b.cat !== 'EMERG') return -1
      if (b.cat === 'EMERG' && a.cat !== 'EMERG') return 1
      return (a.f.callsign || a.f.icao).localeCompare(b.f.callsign || b.f.icao)
    })
  }, [tagged, activeCat, activeCode, q])

  const total = tagged.length

  return (
    <div className={`absolute top-20 right-3 md:right-4 z-30 w-[360px] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border ${flash ? 'border-rose-500 shadow-[0_0_30px_rgba(244,63,94,0.5)]' : 'border-slate-800'} rounded-2xl shadow-2xl flex flex-col overflow-hidden transition`}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 bg-slate-900/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-slate-400">Squawk Monitor</span>
          <span className="text-[10px] text-slate-500">· {total} aircraft</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm leading-none px-1.5 py-0.5 rounded hover:bg-slate-800">×</button>
      </div>

      <div className="px-3 pt-2 pb-1">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Filter by code or callsign…"
          className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-slate-600"
        />
      </div>

      <div className="grid grid-cols-2 gap-1.5 px-3 pt-1 pb-2">
        {(Object.keys(CATS) as CatKey[]).map(k => {
          const c = CATS[k]
          const n = catCounts[k]
          const active = activeCat === k
          return (
            <button
              key={k}
              onClick={() => { setActiveCat(active ? null : k); setActiveCode(null) }}
              className={`text-left rounded-lg border px-2 py-1.5 transition ${active ? c.ring + ' ring-1 ring-white/20' : 'border-slate-800 bg-slate-900/40 hover:border-slate-700'}`}
              title={c.desc}
            >
              <div className="flex items-baseline justify-between">
                <span className={`text-[9px] uppercase tracking-widest font-semibold ${c.color}`}>{c.label}</span>
                <span className={`text-sm font-mono ${n > 0 ? c.color : 'text-slate-600'}`}>{n}</span>
              </div>
              <div className="text-[9px] text-slate-500 leading-tight mt-0.5 line-clamp-1">{c.desc}</div>
            </button>
          )
        })}
      </div>

      <div className="px-3 pb-1 flex items-center justify-between">
        <div className="text-[9px] uppercase tracking-widest text-slate-500">Hot Codes</div>
        {(activeCat || activeCode || q) && (
          <button onClick={() => { setActiveCat(null); setActiveCode(null); setQ('') }} className="text-[9px] uppercase tracking-widest text-slate-500 hover:text-slate-300">clear</button>
        )}
      </div>

      <div className="px-3 pb-2 flex flex-wrap gap-1">
        {codeCounts.slice(0, 10).map(c => {
          const cat = CATS[c.cat]
          const active = activeCode === c.code
          return (
            <button
              key={c.code}
              onClick={() => { setActiveCode(active ? null : c.code); setActiveCat(null) }}
              title={c.desc}
              className={`font-mono text-[10px] px-1.5 py-0.5 rounded border transition ${active ? cat.ring + ' ring-1 ring-white/20' : 'border-slate-800 bg-slate-900/40 hover:border-slate-700'} ${cat.color}`}
            >
              {c.code} <span className="text-slate-500">·{c.count}</span>
            </button>
          )
        })}
      </div>

      <div className="border-t border-slate-800 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="text-center text-[11px] text-slate-600 py-6">No aircraft match.</div>
        ) : (
          <ul className="divide-y divide-slate-800/60">
            {filtered.slice(0, 200).map(t => {
              const cat = CATS[t.cat]
              return (
                <li key={t.f.icao}>
                  <button
                    onClick={() => onFly(t.f.icao)}
                    className="w-full text-left px-3 py-1.5 hover:bg-slate-900/60 transition flex items-center gap-2"
                  >
                    <span className={`font-mono text-[11px] w-12 ${cat.color}`}>{t.f.squawk || '----'}</span>
                    <span className="flex-1 min-w-0">
                      <span className="text-[11px] text-slate-200 truncate block">
                        {t.f.callsign || t.f.icao.toUpperCase()}
                        {t.f.type ? <span className="text-slate-500"> · {t.f.type}</span> : null}
                      </span>
                      <span className="text-[9px] text-slate-500 truncate block">{t.desc}</span>
                    </span>
                    <span className="text-[9px] text-slate-500 font-mono shrink-0">
                      {t.f.ground ? 'GND' : `FL${Math.max(0, Math.round(t.f.altitudeFt / 100)).toString().padStart(3,'0')}`}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 flex items-center justify-between bg-slate-900/40">
        <span>{filtered.length} shown · {codeCounts.length} unique codes</span>
        <span className="font-mono">Mode-A</span>
      </div>
    </div>
  )
}
