'use client'
import { useEffect, useMemo, useRef, useState } from 'react'

export type RaceFlight = {
  icao: string
  callsign: string
  operator: string
  type: string
  altitudeFt: number
  velocityKts: number
  ground: boolean
  military: boolean
  emergency: boolean
}

type Metric = 'count' | 'airborne' | 'altSum' | 'distSum'
type Group = 'operator' | 'type' | 'country'

const METRIC_LABEL: Record<Metric, string> = {
  count: 'Total aircraft',
  airborne: 'Airborne only',
  altSum: 'Total altitude (kft)',
  distSum: 'Cumulative kt-hours',
}

// Map common callsign prefixes / operator strings to ISO-ish country labels.
// Light-touch only — we keep groups by operator string primarily.
function callsignCountry(cs: string): string {
  if (!cs) return '—'
  const p = cs.slice(0, 3).toUpperCase()
  const M: Record<string, string> = {
    AAL: 'US', UAL: 'US', DAL: 'US', SWA: 'US', JBU: 'US', NKS: 'US', FFT: 'US',
    BAW: 'GB', VIR: 'GB', EZY: 'GB', TOM: 'GB',
    DLH: 'DE', CFG: 'DE', EWG: 'DE',
    AFR: 'FR', TVF: 'FR',
    KLM: 'NL', TRA: 'NL',
    IBE: 'ES', VLG: 'ES', RYR: 'IE',
    AZA: 'IT', ITY: 'IT',
    SAS: 'SE', NAX: 'NO', FIN: 'FI',
    SWR: 'CH', AUA: 'AT',
    QFA: 'AU', QLK: 'AU', VOZ: 'AU',
    ANZ: 'NZ',
    JAL: 'JP', ANA: 'JP',
    KAL: 'KR', AAR: 'KR',
    CCA: 'CN', CES: 'CN', CSN: 'CN', CSC: 'CN',
    CPA: 'HK', HDA: 'HK',
    SIA: 'SG', SLK: 'SG',
    THA: 'TH', AIQ: 'TH',
    MAS: 'MY', AXM: 'MY',
    UAE: 'AE', ETD: 'AE',
    QTR: 'QA', SVA: 'SA',
    ELY: 'IL',
    AMX: 'MX', VOI: 'MX',
    ACA: 'CA', WJA: 'CA', JZA: 'CA',
    TAM: 'BR', GLO: 'BR', AZU: 'BR',
    LAN: 'CL', ARG: 'AR',
    AIC: 'IN', IGO: 'IN', SEJ: 'IN',
  }
  return M[p] || (cs[0]?.match(/[A-Z]/) ? cs[0] : '—')
}

function groupKey(f: RaceFlight, g: Group): string {
  if (g === 'type') return f.type || 'Unknown'
  if (g === 'country') return callsignCountry(f.callsign)
  // operator: fall back to callsign 3-letter prefix
  const op = (f.operator || '').trim()
  if (op) return op
  const cs = (f.callsign || '').trim().toUpperCase()
  return cs ? cs.slice(0, 3) : 'Unknown'
}

type RowState = {
  key: string
  value: number
  rank: number
  prevRank: number
  history: number[]
  delta1m: number
}

export default function OperatorRace({
  flights,
  onSelectOperator,
  onClose,
}: {
  flights: RaceFlight[]
  onSelectOperator: (group: Group, key: string) => void
  onClose: () => void
}) {
  const [metric, setMetric] = useState<Metric>('count')
  const [group, setGroup] = useState<Group>('operator')
  const [topN, setTopN] = useState(15)
  const [hideUnknown, setHideUnknown] = useState(true)
  const [paused, setPaused] = useState(false)
  const [query, setQuery] = useState('')

  // Persistent state across renders for rank/history/sparklines
  const stateRef = useRef<Map<string, RowState>>(new Map())
  const lastUpdateRef = useRef<number>(0)
  const [, force] = useState(0)

  // Aggregate current snapshot
  const snapshot = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of flights) {
      const k = groupKey(f, group)
      if (hideUnknown && (k === 'Unknown' || k === '—')) continue
      let inc = 0
      switch (metric) {
        case 'count': inc = 1; break
        case 'airborne': inc = f.ground ? 0 : 1; break
        case 'altSum': inc = f.ground ? 0 : Math.max(0, f.altitudeFt) / 1000; break
        case 'distSum': inc = f.ground ? 0 : (f.velocityKts || 0) * (1 / 60) // kt-min per tick = kt/60 hr
      }
      if (inc <= 0 && metric !== 'count') continue
      m.set(k, (m.get(k) || 0) + inc)
    }
    return m
  }, [flights, group, metric, hideUnknown])

  // Update rolling state ~ every render but throttled to 1s
  useEffect(() => {
    if (paused) return
    const now = Date.now()
    if (now - lastUpdateRef.current < 900) return
    lastUpdateRef.current = now
    const s = stateRef.current
    // Build ranking from snapshot
    const sorted = [...snapshot.entries()].sort((a, b) => b[1] - a[1])
    const newKeys = new Set(sorted.map(([k]) => k))
    sorted.forEach(([k, v], i) => {
      const prev = s.get(k)
      const hist = prev ? prev.history.slice(-29) : []
      hist.push(v)
      s.set(k, {
        key: k,
        value: v,
        rank: i + 1,
        prevRank: prev ? prev.rank : i + 1,
        history: hist,
        delta1m: hist.length >= 2 ? v - hist[0] : 0,
      })
    })
    // Drop rows not seen
    for (const k of [...s.keys()]) if (!newKeys.has(k)) s.delete(k)
    force(x => x + 1)
  }, [snapshot, paused])

  const rows = useMemo(() => {
    const all = [...stateRef.current.values()].sort((a, b) => b.value - a.value)
    const q = query.trim().toLowerCase()
    const filtered = q ? all.filter(r => r.key.toLowerCase().includes(q)) : all
    return filtered.slice(0, topN)
  }, [topN, query, lastUpdateRef.current, snapshot])

  const maxValue = rows.length ? rows[0].value : 1
  const total = useMemo(() => [...snapshot.values()].reduce((a, b) => a + b, 0), [snapshot])
  const uniqueGroups = snapshot.size

  function fmt(v: number) {
    if (metric === 'count' || metric === 'airborne') return Math.round(v).toLocaleString()
    if (metric === 'altSum') return v.toFixed(0)
    return v.toFixed(1)
  }

  return (
    <div className="absolute top-20 left-3 md:left-4 z-30 w-[420px] max-w-[calc(100vw-1.5rem)] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 flex flex-col"
      style={{ maxHeight: 'calc(100vh - 7rem)' }}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Operator Race</div>
          <div className="text-sm font-semibold flex items-center gap-2">
            Live leaderboard
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/30">
              {uniqueGroups} groups
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setPaused(p => !p)} title={paused ? 'Resume' : 'Pause'}
            className={`text-[10px] uppercase tracking-widest border rounded-md px-2 py-1 ${paused ? 'border-amber-500/50 text-amber-300 bg-amber-500/10' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
            {paused ? '▶' : '❚❚'}
          </button>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">×</button>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 flex flex-wrap gap-1.5 text-[10px]">
        {(['operator', 'type', 'country'] as Group[]).map(g => (
          <button key={g} onClick={() => setGroup(g)}
            className={`uppercase tracking-widest px-2 py-1 rounded-md border ${group === g ? 'border-violet-500/60 bg-violet-500/15 text-violet-200' : 'border-slate-800 text-slate-400 hover:text-slate-200'}`}>
            {g}
          </button>
        ))}
        <div className="w-px h-5 bg-slate-800 mx-1 self-center" />
        {(['count', 'airborne', 'altSum', 'distSum'] as Metric[]).map(m => (
          <button key={m} onClick={() => setMetric(m)}
            className={`uppercase tracking-widest px-2 py-1 rounded-md border ${metric === m ? 'border-sky-500/60 bg-sky-500/15 text-sky-200' : 'border-slate-800 text-slate-400 hover:text-slate-200'}`}
            title={METRIC_LABEL[m]}>
            {m === 'altSum' ? 'kFT' : m === 'distSum' ? 'KT·H' : m === 'airborne' ? 'AIR' : 'ALL'}
          </button>
        ))}
      </div>

      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2 text-[11px]">
        <input value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Filter…"
          className="flex-1 bg-slate-900/70 border border-slate-800 rounded-md px-2 py-1 outline-none focus:border-violet-500/50 text-slate-200 placeholder:text-slate-600" />
        <label className="flex items-center gap-1 text-slate-400">
          Top
          <select value={topN} onChange={e => setTopN(Number(e.target.value))}
            className="bg-slate-900 border border-slate-800 rounded-md px-1 py-0.5 text-slate-200">
            {[10, 15, 20, 30, 50].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-slate-400 cursor-pointer">
          <input type="checkbox" checked={hideUnknown} onChange={e => setHideUnknown(e.target.checked)} className="accent-violet-500" />
          Hide unk.
        </label>
      </div>

      <div className="px-3 py-1 text-[10px] text-slate-500 flex items-center justify-between">
        <span>{METRIC_LABEL[metric]} · total <b className="text-slate-300">{fmt(total)}</b></span>
        <span>updates every ~1s</span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-1">
        {rows.length === 0 && (
          <div className="text-xs text-slate-500 text-center py-8">No groups match.</div>
        )}
        {rows.map((r, i) => {
          const pct = maxValue > 0 ? (r.value / maxValue) * 100 : 0
          const rankDelta = r.prevRank - r.rank // positive = moved up
          const sparkMin = Math.min(...r.history)
          const sparkMax = Math.max(...r.history)
          const span = Math.max(1e-6, sparkMax - sparkMin)
          const pts = r.history.map((v, idx) => {
            const x = (idx / Math.max(1, r.history.length - 1)) * 60
            const y = 16 - ((v - sparkMin) / span) * 14 - 1
            return `${x.toFixed(1)},${y.toFixed(1)}`
          }).join(' ')
          const hue = 270 - i * 9 // violet → cyan gradient
          return (
            <button key={r.key} onClick={() => onSelectOperator(group, r.key)}
              className="w-full text-left group relative">
              <div className="flex items-center gap-2 text-[11px] mb-0.5">
                <span className="font-mono text-slate-500 w-5 text-right">{i + 1}</span>
                <span className="font-mono font-semibold text-slate-100 truncate flex-1">{r.key}</span>
                {rankDelta !== 0 && (
                  <span className={`text-[9px] font-mono px-1 rounded ${rankDelta > 0 ? 'text-emerald-400 bg-emerald-500/10' : 'text-rose-400 bg-rose-500/10'}`}>
                    {rankDelta > 0 ? '▲' : '▼'}{Math.abs(rankDelta)}
                  </span>
                )}
                <svg width="60" height="16" className="text-slate-500 shrink-0">
                  {r.history.length >= 2 && (
                    <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
                  )}
                </svg>
                <span className="font-mono text-slate-200 tabular-nums w-14 text-right">{fmt(r.value)}</span>
                {r.delta1m !== 0 && r.history.length >= 5 && (
                  <span className={`text-[9px] font-mono w-10 text-right ${r.delta1m > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {r.delta1m > 0 ? '+' : ''}{fmt(r.delta1m)}
                  </span>
                )}
              </div>
              <div className="relative h-3 rounded bg-slate-900/70 overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 transition-[width] duration-700 ease-out"
                  style={{
                    width: `${pct}%`,
                    background: `linear-gradient(90deg, hsl(${hue} 70% 45%), hsl(${hue + 30} 75% 55%))`,
                  }}
                />
                <div className="absolute inset-0 ring-1 ring-inset ring-white/5 rounded pointer-events-none group-hover:ring-white/20" />
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-4 py-2 border-t border-slate-800 text-[10px] text-slate-500 flex justify-between">
        <span>Click a row → filter map</span>
        <span>{paused ? 'paused' : 'live'}</span>
      </div>
    </div>
  )
}
