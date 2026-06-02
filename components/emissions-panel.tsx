'use client'
import { useMemo, useState } from 'react'

export type EmFlight = {
  icao: string
  callsign: string
  operator: string
  type: string
  category: string
  altitudeFt: number
  velocityKts: number
  ground: boolean
  military: boolean
}

type Props = {
  flights: EmFlight[]
  onClose: () => void
  onSelect?: (icao: string) => void
}

/* Per-hour fuel burn (kg) by rough class. Values are cruise averages from
   published manufacturer / EUROCONTROL fuel-burn tables. Used for live-snapshot
   estimation only — not flight-planning accurate. */
type Cls = 'heavy_widebody' | 'narrowbody' | 'regional' | 'turboprop' | 'biz' | 'light' | 'heli' | 'unknown'
const CLS_BURN_KGH: Record<Cls, number> = {
  heavy_widebody: 6800,  // 777/787/A350/A330 average cruise
  narrowbody: 2500,      // 737NG/A320 cruise
  regional: 1100,        // E190/CRJ/A220
  turboprop: 450,        // ATR/Q400
  biz: 900,              // mid-size jet avg
  light: 70,             // GA piston
  heli: 220,             // medium twin
  unknown: 1500,
}
const CLS_LABEL: Record<Cls, string> = {
  heavy_widebody: 'Heavy widebody',
  narrowbody: 'Narrowbody jet',
  regional: 'Regional jet',
  turboprop: 'Turboprop',
  biz: 'Business jet',
  light: 'Light/GA',
  heli: 'Helicopter',
  unknown: 'Unknown',
}
const CLS_COLOR: Record<Cls, string> = {
  heavy_widebody: '#e11d48',
  narrowbody: '#f97316',
  regional: '#f59e0b',
  turboprop: '#10b981',
  biz: '#8b5cf6',
  light: '#22d3ee',
  heli: '#a3e635',
  unknown: '#64748b',
}

const HEAVY_RE = /^(B74|B77|B78|B79|A33|A34|A35|A38|IL96|MD11|DC10|B76)/i
const NARROW_RE = /^(B73|B72|A31|A32|A21|A22|MD8|MD9|B71|B70|TU15|TU20)/i
const REGIONAL_RE = /^(E1[79]|E29|E45|CRJ|CR[JN]|RJ[127]|AT[47]|AT5|DH8|DH4)/i
const TURBOPROP_RE = /^(AT[47]|DH8|DH4|SF34|JS3|SB20|C208|PC12|DHC)/i
const BIZ_RE = /^(GLF|GLEX|G[V456]|CL3|CL6|FA[57]|FA20|FA50|FA8|CRJ|H25|LJ[34567]|C[5J]|BE[34]|PRM1|HDJ|GA8)/i
const LIGHT_RE = /^(C1[5678]|C2[02]|PA[23]|SR2|DA[24]|BE2|BE3|BE5|TBM|M20)/i

function classify(f: EmFlight): Cls {
  const cat = f.category || ''
  if (cat === 'A7' || cat === 'B2') return 'heli'
  const t = (f.type || '').toUpperCase()
  if (HEAVY_RE.test(t)) return 'heavy_widebody'
  if (REGIONAL_RE.test(t) && !TURBOPROP_RE.test(t)) return 'regional'
  if (TURBOPROP_RE.test(t)) return 'turboprop'
  if (NARROW_RE.test(t)) return 'narrowbody'
  if (BIZ_RE.test(t)) return 'biz'
  if (LIGHT_RE.test(t)) return 'light'
  // fall back on ADS-B category
  if (cat === 'A5' || cat === 'A4') return 'heavy_widebody'
  if (cat === 'A3') return 'narrowbody'
  if (cat === 'A2') return 'regional'
  if (cat === 'A1') return 'light'
  if (cat === 'A6') return 'biz'
  return 'unknown'
}

/* Adjust burn by phase: climb ~1.4x, descent/idle ~0.55x, ground ~0.05x */
function phaseFactor(f: EmFlight): number {
  if (f.ground) return 0.05
  const alt = f.altitudeFt
  if (alt < 10000) return 1.25
  if (alt < 24000) return 1.10
  if (alt > 36000) return 0.92
  return 1.0
}

const JETA_CO2_PER_KG = 3.16 // kg CO2 per kg jet fuel (incl combustion)
const AVGAS_CO2_PER_KG = 3.10

function fmt(n: number, unit = '') {
  if (!isFinite(n)) return '—'
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B' + unit
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M' + unit
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k' + unit
  if (n >= 10) return Math.round(n).toLocaleString() + unit
  return n.toFixed(1) + unit
}

export default function EmissionsPanel({ flights, onClose, onSelect }: Props) {
  const [showTons, setShowTons] = useState(true)
  const [groupMode, setGroupMode] = useState<'class' | 'airline'>('class')

  const rows = useMemo(() => {
    return flights.filter(f => !f.military || true).map(f => {
      const cls = classify(f)
      const co2pk = cls === 'light' ? AVGAS_CO2_PER_KG : JETA_CO2_PER_KG
      const burnKgh = CLS_BURN_KGH[cls] * phaseFactor(f)
      const co2Kgh = burnKgh * co2pk
      return { f, cls, burnKgh, co2Kgh }
    })
  }, [flights])

  const totals = useMemo(() => {
    let burn = 0, co2 = 0
    const byCls: Record<string, { count: number; burn: number; co2: number; cls: Cls }> = {}
    const byAir: Record<string, { count: number; burn: number; co2: number }> = {}
    for (const r of rows) {
      burn += r.burnKgh
      co2 += r.co2Kgh
      const k = r.cls
      if (!byCls[k]) byCls[k] = { count: 0, burn: 0, co2: 0, cls: r.cls }
      byCls[k].count++; byCls[k].burn += r.burnKgh; byCls[k].co2 += r.co2Kgh
      const a = (r.f.operator || '—').trim() || '—'
      if (!byAir[a]) byAir[a] = { count: 0, burn: 0, co2: 0 }
      byAir[a].count++; byAir[a].burn += r.burnKgh; byAir[a].co2 += r.co2Kgh
    }
    return { burn, co2, byCls, byAir }
  }, [rows])

  const classList = (Object.entries(totals.byCls) as Array<[string, { count: number; burn: number; co2: number; cls: Cls }]>)
    .sort((a, b) => b[1].co2 - a[1].co2)
  const airlineList = Object.entries(totals.byAir).sort((a, b) => b[1].co2 - a[1].co2).slice(0, 12)

  const topPolluters = [...rows].sort((a, b) => b.co2Kgh - a.co2Kgh).slice(0, 10)

  // human-scale equivalents (per hour)
  const carsOffRoadDaily = totals.co2 / 4.6 // avg passenger car ~4.6 kg CO2/h driving
  const treesYearlyOffset = (totals.co2 * 24 * 365) / 21000 // 1 mature tree ~21 kg/yr

  const div = showTons ? 1000 : 1
  const unit = showTons ? ' t' : ' kg'

  return (
    <div className="absolute top-20 right-3 z-30 w-[400px] max-w-[calc(100vw-1.5rem)] max-h-[calc(100vh-6rem)] overflow-y-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-100">
      <div className="sticky top-0 z-10 bg-slate-950/95 backdrop-blur-xl px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold tracking-wide">Emissions Estimator</div>
          <div className="text-[11px] text-slate-400">{rows.length.toLocaleString()} aircraft in view · live snapshot</div>
        </div>
        <button onClick={onClose} className="w-7 h-7 rounded-md hover:bg-slate-800/70 text-slate-400 hover:text-white flex items-center justify-center text-lg leading-none">×</button>
      </div>

      <div className="px-4 py-3 grid grid-cols-2 gap-2">
        <div className="bg-slate-900/70 border border-slate-800 rounded-lg p-3">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Fuel burn</div>
          <div className="text-xl font-semibold mt-0.5">{fmt(totals.burn / div)}<span className="text-xs text-slate-400">{unit}/h</span></div>
        </div>
        <div className="bg-slate-900/70 border border-slate-800 rounded-lg p-3">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">CO₂ output</div>
          <div className="text-xl font-semibold mt-0.5 text-rose-300">{fmt(totals.co2 / div)}<span className="text-xs text-slate-400">{unit}/h</span></div>
        </div>
      </div>

      <div className="px-4 -mt-1 pb-3 grid grid-cols-2 gap-2 text-[11px]">
        <div className="bg-slate-900/40 border border-slate-800/70 rounded-md px-2.5 py-1.5">
          <span className="text-slate-500">≈</span> <span className="text-slate-200 font-medium">{fmt(carsOffRoadDaily)}</span> <span className="text-slate-500">cars driving right now</span>
        </div>
        <div className="bg-slate-900/40 border border-slate-800/70 rounded-md px-2.5 py-1.5">
          <span className="text-slate-500">≈</span> <span className="text-slate-200 font-medium">{fmt(treesYearlyOffset)}</span> <span className="text-slate-500">trees / yr to offset</span>
        </div>
      </div>

      <div className="px-4 pb-3 flex items-center gap-2 text-[11px]">
        <button onClick={() => setShowTons(v => !v)} className="px-2 py-1 rounded-md border border-slate-700 hover:border-slate-500 text-slate-300">
          Units: {showTons ? 'tonnes' : 'kilograms'}
        </button>
        <div className="flex rounded-md overflow-hidden border border-slate-700">
          <button onClick={() => setGroupMode('class')} className={`px-2 py-1 ${groupMode==='class'?'bg-slate-700 text-white':'text-slate-400 hover:text-slate-200'}`}>By class</button>
          <button onClick={() => setGroupMode('airline')} className={`px-2 py-1 ${groupMode==='airline'?'bg-slate-700 text-white':'text-slate-400 hover:text-slate-200'}`}>By operator</button>
        </div>
      </div>

      {groupMode === 'class' && (
        <div className="px-4 pb-4">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">CO₂ share by class</div>
          <div className="space-y-1.5">
            {classList.map(([k, v]) => {
              const pct = totals.co2 > 0 ? (v.co2 / totals.co2) * 100 : 0
              return (
                <div key={k}>
                  <div className="flex items-center justify-between text-[11px] mb-0.5">
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-sm" style={{ background: CLS_COLOR[v.cls] }} />
                      <span className="text-slate-200">{CLS_LABEL[v.cls]}</span>
                      <span className="text-slate-500">×{v.count}</span>
                    </span>
                    <span className="tabular-nums text-slate-400">{fmt(v.co2/div)}{unit}/h · {pct.toFixed(0)}%</span>
                  </div>
                  <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, background: CLS_COLOR[v.cls] }} />
                  </div>
                </div>
              )
            })}
            {classList.length === 0 && <div className="text-xs text-slate-500">No flights in view.</div>}
          </div>
        </div>
      )}

      {groupMode === 'airline' && (
        <div className="px-4 pb-4">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">Top operators by CO₂</div>
          <div className="space-y-1.5">
            {airlineList.map(([name, v]) => {
              const pct = totals.co2 > 0 ? (v.co2 / totals.co2) * 100 : 0
              return (
                <div key={name}>
                  <div className="flex items-center justify-between text-[11px] mb-0.5">
                    <span className="truncate max-w-[60%] text-slate-200">{name} <span className="text-slate-500">×{v.count}</span></span>
                    <span className="tabular-nums text-slate-400">{fmt(v.co2/div)}{unit}/h · {pct.toFixed(0)}%</span>
                  </div>
                  <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full bg-rose-500/80 rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
            {airlineList.length === 0 && <div className="text-xs text-slate-500">No operator data.</div>}
          </div>
        </div>
      )}

      <div className="px-4 pb-4">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">Top 10 polluters (right now)</div>
        <div className="rounded-lg border border-slate-800 divide-y divide-slate-800/80 overflow-hidden">
          {topPolluters.map(r => (
            <button
              key={r.f.icao}
              onClick={() => onSelect && onSelect(r.f.icao)}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-800/60 flex items-center justify-between text-[11px]"
            >
              <span className="flex items-center gap-2 min-w-0">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: CLS_COLOR[r.cls] }} />
                <span className="font-medium text-slate-100 truncate">{r.f.callsign || r.f.icao.toUpperCase()}</span>
                <span className="text-slate-500 truncate">{r.f.type || '—'}</span>
              </span>
              <span className="tabular-nums text-rose-300 shrink-0">{fmt(r.co2Kgh)} kg/h</span>
            </button>
          ))}
          {topPolluters.length === 0 && <div className="px-3 py-2 text-xs text-slate-500">No flights.</div>}
        </div>
      </div>

      <div className="px-4 pb-4 text-[10px] text-slate-500 leading-relaxed border-t border-slate-800 pt-3">
        Estimates use typical cruise burn per class, scaled by altitude phase. Real per-aircraft burn varies with weight, weather, and engine variant. Useful for relative comparison, not flight planning.
      </div>
    </div>
  )
}
