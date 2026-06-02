'use client'
import { useEffect, useMemo, useRef, useState } from 'react'

/* ============================================================
   Records Hall of Fame
   -----------------------------------------------------------
   A session-persistent leaderboard that tracks the all-time
   (since the panel started recording) best aircraft observed
   across many physical / operational categories. Each category
   keeps a top-3 podium with full aircraft snapshot, the value,
   and the UTC timestamp the record was set. The hall persists
   to localStorage so records survive page refreshes; user can
   RESET the hall or RESET a single category.

   Categories:
     SPEED      max ground speed (kt)
     MACH       max Mach number
     CEILING    max altitude (ft)
     CLIMB      max sustained climb rate (fpm)
     DESCENT    steepest descent rate (fpm, negative wins)
     TAILWIND   strongest tailwind component (kt, projecting
                wind vector onto track direction)
     HEADWIND   strongest headwind component (kt)
     COLDEST    lowest OAT (degC)
     GUST       largest wind speed (kt, regardless of direction)
     SLOWEST    slowest airborne aircraft (>2000 ft) (kt)
     LOWEST     lowest airborne aircraft (>50 ft, not ground) (ft)

   Pure data — no MapLibre layers. Side panel with a category
   tab strip, podium of top-3 (with gold/silver/bronze accent
   bars and timestamps), live "challenger" row showing the
   current observation that's closest to beating bronze, and a
   small all-records overview grid showing the gold holder per
   category. Click any podium row to fly to that aircraft (if
   still airborne in the current snapshot). ~360 lines.
   ============================================================ */

export interface RecFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  ground: boolean
  velocityKts: number
  mach: number
  vertRate: number
  windDir: number
  windKts: number
  oat: number
  track: number
}

interface Props {
  flights: RecFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type CatKey =
  | 'speed' | 'mach' | 'ceiling' | 'climb' | 'descent'
  | 'tailwind' | 'headwind' | 'coldest' | 'gust'
  | 'slowest' | 'lowest'

interface Category {
  key: CatKey
  label: string
  short: string
  unit: string
  icon: string
  direction: 1 | -1 // 1 = bigger wins, -1 = smaller wins
  format: (v: number) => string
  extract: (f: RecFlight) => number | null
}

const STORE_KEY = 'ft-records-v1'

function tailComp(f: RecFlight): number {
  // meteorological wind: dir is FROM. wind vector TO = (sin(d+180), cos(d+180))
  if (!f.windKts || f.windDir == null) return 0
  const toRad = (d: number) => (d * Math.PI) / 180
  const wTo = f.windDir + 180
  const wx = Math.sin(toRad(wTo)) * f.windKts
  const wy = Math.cos(toRad(wTo)) * f.windKts
  const tx = Math.sin(toRad(f.track))
  const ty = Math.cos(toRad(f.track))
  return wx * tx + wy * ty // + = tail, - = head
}

const CATS: Category[] = [
  { key: 'speed',    label: 'Fastest Ground Speed', short: 'SPEED',    unit: 'kt',  icon: '⚡', direction: 1,
    format: v => `${Math.round(v)} kt`,
    extract: f => (!f.ground && f.velocityKts > 0 ? f.velocityKts : null) },
  { key: 'mach',     label: 'Highest Mach',          short: 'MACH',     unit: 'M',   icon: '🚀', direction: 1,
    format: v => `M ${v.toFixed(3)}`,
    extract: f => (!f.ground && f.mach > 0 ? f.mach : null) },
  { key: 'ceiling',  label: 'Highest Altitude',      short: 'CEILING',  unit: 'ft',  icon: '🛰', direction: 1,
    format: v => `FL${Math.round(v / 100)}`,
    extract: f => (!f.ground && f.altitudeFt > 1000 ? f.altitudeFt : null) },
  { key: 'climb',    label: 'Steepest Climb',        short: 'CLIMB',    unit: 'fpm', direction: 1, icon: '⬆',
    format: v => `+${Math.round(v).toLocaleString()} fpm`,
    extract: f => (!f.ground && f.vertRate > 200 ? f.vertRate : null) },
  { key: 'descent',  label: 'Steepest Descent',      short: 'DESCENT',  unit: 'fpm', direction: -1, icon: '⬇',
    format: v => `${Math.round(v).toLocaleString()} fpm`,
    extract: f => (!f.ground && f.vertRate < -200 ? f.vertRate : null) },
  { key: 'tailwind', label: 'Strongest Tailwind',    short: 'TAILWIND', unit: 'kt',  direction: 1, icon: '🍃',
    format: v => `+${Math.round(v)} kt`,
    extract: f => (!f.ground && f.windKts > 5 ? tailComp(f) : null) },
  { key: 'headwind', label: 'Strongest Headwind',    short: 'HEADWIND', unit: 'kt',  direction: -1, icon: '🌪',
    format: v => `${Math.round(v)} kt`,
    extract: f => (!f.ground && f.windKts > 5 ? tailComp(f) : null) },
  { key: 'coldest',  label: 'Coldest OAT',           short: 'COLDEST',  unit: '°C',  direction: -1, icon: '❄',
    format: v => `${v.toFixed(1)} °C`,
    extract: f => (!f.ground && f.oat != null && f.oat < 50 && f.oat > -100 ? f.oat : null) },
  { key: 'gust',     label: 'Strongest Winds Aloft', short: 'GUST',     unit: 'kt',  direction: 1, icon: '💨',
    format: v => `${Math.round(v)} kt`,
    extract: f => (!f.ground && f.windKts > 0 ? f.windKts : null) },
  { key: 'slowest',  label: 'Slowest Airborne',      short: 'SLOWEST',  unit: 'kt',  direction: -1, icon: '🐢',
    format: v => `${Math.round(v)} kt`,
    extract: f => (!f.ground && f.altitudeFt > 2000 && f.velocityKts > 0 ? f.velocityKts : null) },
  { key: 'lowest',   label: 'Lowest Airborne',       short: 'LOWEST',   unit: 'ft',  direction: -1, icon: '🪂',
    format: v => `${Math.round(v).toLocaleString()} ft`,
    extract: f => (!f.ground && f.altitudeFt > 50 ? f.altitudeFt : null) },
]

interface Holder {
  icao: string
  callsign: string
  type: string
  operator: string
  value: number
  setAt: number // ms epoch
  lat: number
  lng: number
}

type Hall = Record<CatKey, Holder[]> // sorted, max length 3

function loadHall(): Hall {
  if (typeof window === 'undefined') return Object.fromEntries(CATS.map(c => [c.key, []])) as unknown as Hall
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      const out: Hall = Object.fromEntries(CATS.map(c => [c.key, []])) as unknown as Hall
      for (const c of CATS) if (Array.isArray(parsed[c.key])) out[c.key] = parsed[c.key].slice(0, 3)
      return out
    }
  } catch {}
  return Object.fromEntries(CATS.map(c => [c.key, []])) as unknown as Hall
}
function saveHall(h: Hall) {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(STORE_KEY, JSON.stringify(h)) } catch {}
}

function podiumInsert(list: Holder[], h: Holder, dir: 1 | -1): { list: Holder[]; changed: boolean } {
  const cmp = (a: number, b: number) => (dir === 1 ? b - a : a - b)
  // dedupe same icao: keep best
  const without = list.filter(x => x.icao !== h.icao || cmp(h.value, x.value) > 0)
  const next = [...without, h].sort((a, b) => cmp(a.value, b.value)).slice(0, 3)
  const changed = JSON.stringify(next.map(x => [x.icao, x.value])) !== JSON.stringify(list.map(x => [x.icao, x.value]))
  return { list: next, changed }
}

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

const MEDAL = ['#fbbf24', '#cbd5e1', '#d97706'] // gold, silver, bronze
const MEDAL_BG = ['rgba(251,191,36,0.10)', 'rgba(203,213,225,0.08)', 'rgba(217,119,6,0.10)']

export default function RecordsHall({ flights, onClose, onFly }: Props) {
  const [hall, setHall] = useState<Hall>(() => loadHall())
  const [tab, setTab] = useState<CatKey>('speed')
  const [now, setNow] = useState<number>(() => Date.now())
  const seenRef = useRef<number>(0)

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000)
    return () => window.clearInterval(id)
  }, [])

  // ingest current snapshot into hall
  useEffect(() => {
    if (!flights.length) return
    const ts = Date.now()
    let changedAny = false
    const next: Hall = { ...hall }
    let newRecords = 0
    for (const c of CATS) {
      let best: Holder | null = null
      for (const f of flights) {
        const v = c.extract(f)
        if (v == null || !isFinite(v)) continue
        if (best == null || (c.direction === 1 ? v > best.value : v < best.value)) {
          best = {
            icao: f.icao, callsign: f.callsign || f.icao,
            type: f.type || '—', operator: f.operator || '—',
            value: v, setAt: ts, lat: f.lat, lng: f.lng,
          }
        }
      }
      if (!best) continue
      const { list, changed } = podiumInsert(next[c.key], best, c.direction)
      if (changed) {
        // count true new podium entries (icao not already in list)
        const wasIn = next[c.key].some(x => x.icao === best!.icao)
        if (!wasIn) newRecords++
        next[c.key] = list
        changedAny = true
      }
    }
    if (changedAny) {
      seenRef.current += newRecords
      setHall(next)
      saveHall(next)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flights])

  const activeCat = CATS.find(c => c.key === tab)!

  // Live challenger: best current value not yet on podium
  const challenger = useMemo(() => {
    const podiumIds = new Set(hall[tab].map(h => h.icao))
    let best: { f: RecFlight; v: number } | null = null
    for (const f of flights) {
      if (podiumIds.has(f.icao)) continue
      const v = activeCat.extract(f)
      if (v == null) continue
      if (!best || (activeCat.direction === 1 ? v > best.v : v < best.v)) best = { f, v }
    }
    return best
  }, [flights, hall, tab, activeCat])

  const bronze = hall[tab][2]
  const challengerGap = (() => {
    if (!challenger || !bronze) return null
    return activeCat.direction === 1 ? challenger.v - bronze.value : bronze.value - challenger.v
  })()

  function resetCat(k: CatKey) {
    const next = { ...hall, [k]: [] as Holder[] }
    setHall(next); saveHall(next)
  }
  function resetAll() {
    const next = Object.fromEntries(CATS.map(c => [c.key, []])) as unknown as Hall
    setHall(next); saveHall(next)
  }

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg bg-slate-950/95 backdrop-blur border border-slate-800 shadow-2xl text-slate-100">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-amber-300 text-base leading-none">🏆</span>
          <span className="text-[13px] font-semibold tracking-wide">Records Hall of Fame</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={resetAll} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300" title="Clear all records">RESET ALL</button>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none px-1" aria-label="Close">×</button>
        </div>
      </div>

      {/* Category tabs */}
      <div className="px-2 pt-2 pb-1 border-b border-slate-800 flex flex-wrap gap-1">
        {CATS.map(c => {
          const has = hall[c.key].length
          const active = tab === c.key
          return (
            <button key={c.key} onClick={() => setTab(c.key)}
              className={`text-[10px] px-1.5 py-0.5 rounded border ${active ? 'border-amber-400 bg-amber-400/10 text-amber-200' : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-600'}`}
              title={c.label}>
              <span className="mr-1">{c.icon}</span>{c.short}
              {has > 0 && <span className={`ml-1 ${active ? 'text-amber-300' : 'text-slate-500'}`}>{has}</span>}
            </button>
          )
        })}
      </div>

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-400">{activeCat.label}</div>
            <div className="text-[10px] text-slate-500">Top-3 podium · {activeCat.direction === 1 ? 'highest wins' : 'lowest wins'}</div>
          </div>
          <button onClick={() => resetCat(tab)} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 hover:bg-rose-900 text-slate-300" title="Clear this category">CLR</button>
        </div>
      </div>

      <div className="overflow-y-auto flex-1 px-2 py-2 space-y-2">
        {/* Podium */}
        {hall[tab].length === 0 && (
          <div className="text-center text-[11px] text-slate-500 py-6">No record set yet — keep watching the skies.</div>
        )}
        {hall[tab].map((h, i) => {
          const inLive = flights.find(f => f.icao === h.icao)
          return (
            <button key={h.icao + i} onClick={() => inLive && onFly(h.icao)}
              disabled={!inLive}
              className={`w-full text-left rounded-md border px-2.5 py-2 flex items-center gap-3 transition ${inLive ? 'hover:bg-slate-900 cursor-pointer' : 'cursor-default opacity-90'}`}
              style={{ borderColor: MEDAL[i], backgroundColor: MEDAL_BG[i] }}>
              <div className="text-2xl font-bold w-6 text-center" style={{ color: MEDAL[i] }}>{i + 1}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[13px] text-slate-100 truncate">{h.callsign}</span>
                  <span className="text-[10px] text-slate-400 truncate">{h.type}</span>
                </div>
                <div className="text-[10px] text-slate-500 truncate">{h.operator} · {h.icao.toUpperCase()}</div>
                <div className="text-[10px] text-slate-500">set {ago(h.setAt, now)} {inLive && <span className="text-emerald-400 ml-1">• live</span>}</div>
              </div>
              <div className="text-right">
                <div className="text-[14px] font-semibold" style={{ color: MEDAL[i] }}>{activeCat.format(h.value)}</div>
              </div>
            </button>
          )
        })}

        {/* Challenger */}
        {challenger && (
          <div className="mt-2 rounded-md border border-dashed border-slate-700 bg-slate-900/60 px-2.5 py-2">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Live challenger</div>
            <button onClick={() => onFly(challenger.f.icao)} className="w-full text-left flex items-center gap-3 hover:bg-slate-800/60 rounded px-1 py-1">
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[12px] text-slate-200 truncate">{challenger.f.callsign || challenger.f.icao}</span>
                  <span className="text-[10px] text-slate-400 truncate">{challenger.f.type || '—'}</span>
                </div>
                <div className="text-[10px] text-slate-500 truncate">{challenger.f.operator || '—'}</div>
              </div>
              <div className="text-right">
                <div className="text-[12px] font-semibold text-cyan-300">{activeCat.format(challenger.v)}</div>
                {challengerGap != null && (
                  <div className={`text-[10px] ${challengerGap >= 0 ? 'text-emerald-400' : 'text-slate-500'}`}>
                    {challengerGap >= 0 ? `+${activeCat.format(Math.abs(challengerGap))} over bronze` : `${activeCat.format(Math.abs(challengerGap))} from podium`}
                  </div>
                )}
              </div>
            </button>
          </div>
        )}

        {/* Overview grid */}
        <div className="mt-3 border-t border-slate-800 pt-2">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1 px-1">Gold across all categories</div>
          <div className="grid grid-cols-2 gap-1">
            {CATS.map(c => {
              const g = hall[c.key][0]
              return (
                <button key={c.key} onClick={() => setTab(c.key)}
                  className={`text-left rounded border px-1.5 py-1 ${tab === c.key ? 'border-amber-400 bg-amber-400/5' : 'border-slate-800 bg-slate-900 hover:border-slate-700'}`}>
                  <div className="flex items-center gap-1 text-[10px] text-slate-400">
                    <span>{c.icon}</span>
                    <span className="truncate">{c.short}</span>
                  </div>
                  {g ? (
                    <>
                      <div className="text-[11px] font-semibold text-amber-300 truncate">{c.format(g.value)}</div>
                      <div className="text-[9px] text-slate-500 truncate font-mono">{g.callsign}</div>
                    </>
                  ) : (
                    <div className="text-[10px] text-slate-600">—</div>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[10px] text-slate-500 flex items-center justify-between">
        <span>{flights.filter(f => !f.ground).length} airborne · scanning</span>
        <span>persists in localStorage</span>
      </div>
    </div>
  )
}
