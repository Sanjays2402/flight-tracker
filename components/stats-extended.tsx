'use client'
// [BATCH-C] Extended stats — top operators / types / countries + altitude/speed histograms.
import { useMemo } from 'react'
import { Histogram, TopBars } from './charts/mini-charts'

interface F {
  callsign: string
  type: string
  operator: string
  registration: string
  altitudeFt: number
  velocityKts: number
  ground: boolean
}

function topN(items: string[], n: number): Array<{key:string;count:number}> {
  const map = new Map<string, number>()
  for (const k of items) {
    if (!k) continue
    map.set(k, (map.get(k) || 0) + 1)
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }))
}

// Operator from callsign prefix (3 letters typically), fallback to operator field.
function operatorOf(f: F): string {
  if (f.operator) return f.operator
  const m = (f.callsign || '').match(/^([A-Z]{3})/)
  return m ? m[1] : ''
}

// Country from registration prefix.
const REG_COUNTRY: Array<[RegExp, string]> = [
  [/^N/, 'US'], [/^G-/, 'GB'], [/^D-/, 'DE'], [/^F-/, 'FR'], [/^C-/, 'CA'],
  [/^JA/, 'JP'], [/^VH-/, 'AU'], [/^VT-/, 'IN'], [/^EC-/, 'ES'], [/^EI-/, 'IE'],
  [/^OO-/, 'BE'], [/^PH-/, 'NL'], [/^LN-/, 'NO'], [/^SE-/, 'SE'], [/^A6-/, 'AE'],
  [/^A7-/, 'QA'], [/^B-/, 'CN'], [/^HL/, 'KR'], [/^(PR-|PT-|PP-)/, 'BR'],
  [/^(XA-|XB-|XC-)/, 'MX'], [/^I-/, 'IT'], [/^OE-/, 'AT'], [/^HB-/, 'CH'],
  [/^CC-/, 'CL'], [/^LV-/, 'AR'], [/^ZK-/, 'NZ'], [/^ZS-/, 'ZA'],
]
function countryOf(reg: string): string {
  const r = (reg || '').toUpperCase()
  for (const [re, code] of REG_COUNTRY) if (re.test(r)) return code
  return ''
}

export function StatsExtended({ flights }: { flights: F[] }) {
  const airborne = useMemo(() => flights.filter(f => !f.ground), [flights])

  const topOps = useMemo(() => topN(flights.map(operatorOf), 10), [flights])
  const topTypes = useMemo(() => topN(flights.map(f => f.type).filter(Boolean), 10), [flights])
  const topCountries = useMemo(() => topN(flights.map(f => countryOf(f.registration)).filter(Boolean), 10), [flights])

  const alts = useMemo(() => airborne.map(f => f.altitudeFt).filter(v => v > 0), [airborne])
  const spds = useMemo(() => airborne.map(f => f.velocityKts).filter(v => v > 0), [airborne])

  return (
    <div className="space-y-3 mt-3" data-batch-c-stats="extended">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-sky-400 font-bold mb-1.5">Top operators</div>
        <TopBars items={topOps} color="#38bdf8" />
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-widest text-sky-400 font-bold mb-1.5">Top aircraft types</div>
        <TopBars items={topTypes} color="#a78bfa" />
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-widest text-sky-400 font-bold mb-1.5">Top countries</div>
        <TopBars items={topCountries} color="#fb923c" />
      </div>
      <Histogram values={alts} bins={20} label="Altitude distribution (ft)" color="#38bdf8" formatter={(v)=>`${Math.round(v/1000)}k`} />
      <Histogram values={spds} bins={20} label="Speed distribution (kt)" color="#facc15" />
    </div>
  )
}
