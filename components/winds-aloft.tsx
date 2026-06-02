'use client'
import { useMemo, useState } from 'react'

interface F {
  icao: string
  callsign: string
  altitudeFt: number
  ground: boolean
  windDir: number
  windKts: number
  oat: number
  lat: number
  lng: number
}

interface Props {
  flights: F[]
  onClose: () => void
  onFly?: (icao: string) => void
}

// FL bands (ft)
const BANDS: Array<[number, number, string]> = [
  [0,     5000,   'SFC-050'],
  [5000,  10000,  'FL050-100'],
  [10000, 15000,  'FL100-150'],
  [15000, 20000,  'FL150-200'],
  [20000, 25000,  'FL200-250'],
  [25000, 30000,  'FL250-300'],
  [30000, 34000,  'FL300-340'],
  [34000, 38000,  'FL340-380'],
  [38000, 42000,  'FL380-420'],
  [42000, 60000,  'FL420+'],
]

// Average a set of wind vectors (deg/kts) properly
function avgWind(samples: Array<{ d: number; k: number }>): { d: number; k: number } {
  if (!samples.length) return { d: 0, k: 0 }
  let u = 0, v = 0
  for (const s of samples) {
    // wind FROM dir → vector points TO opposite
    const rad = (s.d * Math.PI) / 180
    u += s.k * Math.sin(rad)
    v += s.k * Math.cos(rad)
  }
  u /= samples.length; v /= samples.length
  const k = Math.sqrt(u * u + v * v)
  let d = (Math.atan2(u, v) * 180) / Math.PI
  if (d < 0) d += 360
  return { d, k }
}

// Render a wind barb SVG (meteorological convention, FROM direction)
function Barb({ dirDeg, kts, size = 56 }: { dirDeg: number; kts: number; size?: number }) {
  const cx = size / 2, cy = size / 2
  const len = size * 0.42
  // Shaft points downwind (toward where wind is going)
  const toRad = ((dirDeg + 180) * Math.PI) / 180
  const x2 = cx + Math.sin(toRad) * len
  const y2 = cy - Math.cos(toRad) * len
  // Barb side perpendicular (left side of shaft tip from wind direction)
  const perpRad = ((dirDeg + 90) * Math.PI) / 180
  const barbLen = size * 0.22
  let remaining = Math.round(kts / 5) * 5
  const flags: Array<{ kind: 'flag' | 'full' | 'half'; pos: number }> = []
  let pos = 0
  while (remaining >= 50) { flags.push({ kind: 'flag', pos }); remaining -= 50; pos++ }
  while (remaining >= 10) { flags.push({ kind: 'full', pos }); remaining -= 10; pos++ }
  if (remaining >= 5)     { flags.push({ kind: 'half', pos }); pos++ }
  // Barbs are drawn from the tail end (opposite of shaft tip = upwind end)
  // shaft tip = downwind end, so tail = (cx,cy) - direction
  const tailRad = (dirDeg * Math.PI) / 180
  const tx = cx + Math.sin(tailRad) * len
  const ty = cy - Math.cos(tailRad) * len
  const step = (len / Math.max(1, flags.length + 1)) * 0.6
  const px = Math.sin(perpRad), py = -Math.cos(perpRad)
  const dx = (cx - tx) / len, dy = (cy - ty) / len // unit vec from tail toward center
  const elems: React.ReactNode[] = []
  flags.forEach((f, i) => {
    const baseX = tx + dx * step * (i + 0.5)
    const baseY = ty + dy * step * (i + 0.5)
    if (f.kind === 'flag') {
      const tipX = baseX + dx * step + px * barbLen
      const tipY = baseY + dy * step + py * barbLen
      const nextX = baseX + dx * step
      const nextY = baseY + dy * step
      elems.push(<polygon key={i} points={`${baseX},${baseY} ${tipX},${tipY} ${nextX},${nextY}`} fill="#7dd3fc" />)
    } else {
      const L = f.kind === 'full' ? barbLen : barbLen * 0.55
      const tipX = baseX + px * L
      const tipY = baseY + py * L
      elems.push(<line key={i} x1={baseX} y1={baseY} x2={tipX} y2={tipY} stroke="#7dd3fc" strokeWidth={1.5} />)
    }
  })
  if (kts < 3) {
    return (
      <svg width={size} height={size}>
        <circle cx={cx} cy={cy} r={size * 0.18} fill="none" stroke="#7dd3fc" strokeWidth={1.5} />
        <circle cx={cx} cy={cy} r={size * 0.32} fill="none" stroke="#7dd3fc" strokeWidth={0.8} opacity={0.5} />
      </svg>
    )
  }
  return (
    <svg width={size} height={size}>
      <line x1={tx} y1={ty} x2={x2} y2={y2} stroke="#7dd3fc" strokeWidth={1.8} />
      <circle cx={x2} cy={y2} r={2} fill="#7dd3fc" />
      {elems}
    </svg>
  )
}

export default function WindsAloft({ flights, onClose, onFly }: Props) {
  const [unit, setUnit] = useState<'kt' | 'mph' | 'kmh'>('kt')

  const bands = useMemo(() => {
    return BANDS.map(([lo, hi, label]) => {
      const samples: Array<{ d: number; k: number; icao: string; cs: string; oat: number; alt: number }> = []
      for (const f of flights) {
        if (f.ground) continue
        if (f.altitudeFt < lo || f.altitudeFt >= hi) continue
        if (!Number.isFinite(f.windDir) || !Number.isFinite(f.windKts)) continue
        if (f.windKts <= 0 && f.windDir === 0) continue
        samples.push({ d: f.windDir, k: f.windKts, icao: f.icao, cs: f.callsign || f.icao.toUpperCase(), oat: f.oat, alt: f.altitudeFt })
      }
      const w = avgWind(samples.map(s => ({ d: s.d, k: s.k })))
      const oats = samples.map(s => s.oat).filter(o => Number.isFinite(o) && o !== 0)
      const oat = oats.length ? oats.reduce((a, b) => a + b, 0) / oats.length : NaN
      // gust = max sample
      let gust = 0
      for (const s of samples) if (s.k > gust) gust = s.k
      return { lo, hi, label, count: samples.length, dir: w.d, kts: w.k, oat, gust, samples }
    })
  }, [flights])

  const maxKts = Math.max(20, ...bands.map(b => b.kts))
  const totalSamples = bands.reduce((a, b) => a + b.count, 0)

  const fmtSpd = (kts: number) => {
    if (unit === 'kt') return `${Math.round(kts)} kt`
    if (unit === 'mph') return `${Math.round(kts * 1.15078)} mph`
    return `${Math.round(kts * 1.852)} km/h`
  }
  const fmtDir = (d: number) => `${String(Math.round(d) % 360).padStart(3, '0')}°`

  return (
    <div className="absolute top-16 right-4 z-30 w-[420px] max-h-[80vh] flex flex-col rounded-lg border border-zinc-700/70 bg-zinc-900/95 backdrop-blur shadow-2xl text-zinc-100">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-700/70">
        <div className="flex items-center gap-2">
          <span className="text-sky-400 font-mono text-xs tracking-widest">WINDS ALOFT</span>
          <span className="text-[10px] text-zinc-500">{totalSamples} samples</span>
        </div>
        <div className="flex items-center gap-1">
          {(['kt','mph','kmh'] as const).map(u => (
            <button key={u}
              onClick={() => setUnit(u)}
              className={`text-[10px] px-1.5 py-0.5 rounded ${unit === u ? 'bg-sky-500/30 text-sky-200' : 'text-zinc-400 hover:text-zinc-200'}`}>
              {u}
            </button>
          ))}
          <button onClick={onClose} className="ml-1 text-zinc-400 hover:text-zinc-100 text-sm px-1">✕</button>
        </div>
      </div>

      <div className="overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-zinc-900/95 text-[10px] text-zinc-500 uppercase tracking-wider">
            <tr>
              <th className="text-left px-2 py-1">Band</th>
              <th className="text-center px-1 py-1">Barb</th>
              <th className="text-right px-1 py-1">Dir</th>
              <th className="text-right px-1 py-1">Spd</th>
              <th className="text-right px-1 py-1">Gust</th>
              <th className="text-right px-1 py-1">OAT</th>
              <th className="text-right px-2 py-1">N</th>
            </tr>
          </thead>
          <tbody>
            {[...bands].reverse().map(b => {
              const w = maxKts > 0 ? Math.min(100, (b.kts / maxKts) * 100) : 0
              return (
                <tr key={b.label} className="border-t border-zinc-800/70 hover:bg-zinc-800/40">
                  <td className="px-2 py-1 font-mono text-zinc-300">{b.label}</td>
                  <td className="px-1 py-1">
                    {b.count > 0
                      ? <div className="flex justify-center"><Barb dirDeg={b.dir} kts={b.kts} size={44} /></div>
                      : <div className="text-center text-zinc-700">—</div>}
                  </td>
                  <td className="px-1 py-1 text-right font-mono text-zinc-400">{b.count > 0 ? fmtDir(b.dir) : '—'}</td>
                  <td className="px-1 py-1 text-right font-mono text-sky-300">
                    {b.count > 0 ? fmtSpd(b.kts) : '—'}
                    {b.count > 0 && (
                      <div className="mt-0.5 h-0.5 bg-zinc-800 rounded overflow-hidden">
                        <div className="h-full bg-sky-500/70" style={{ width: `${w}%` }} />
                      </div>
                    )}
                  </td>
                  <td className="px-1 py-1 text-right font-mono text-amber-300/80">
                    {b.gust > 0 ? fmtSpd(b.gust) : '—'}
                  </td>
                  <td className="px-1 py-1 text-right font-mono text-zinc-400">
                    {Number.isFinite(b.oat) ? `${Math.round(b.oat)}°C` : '—'}
                  </td>
                  <td className="px-2 py-1 text-right text-zinc-500">{b.count}</td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {/* Sample drilldown for hovered/expanded — show contributors of strongest band */}
        {(() => {
          const top = [...bands].filter(b => b.count > 0).sort((a, b) => b.kts - a.kts)[0]
          if (!top) return null
          return (
            <div className="px-2 py-2 border-t border-zinc-800/70">
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">
                Strongest band · {top.label} · {fmtSpd(top.kts)} from {fmtDir(top.dir)}
              </div>
              <div className="space-y-0.5 max-h-40 overflow-y-auto">
                {top.samples
                  .slice()
                  .sort((a, b) => b.k - a.k)
                  .slice(0, 12)
                  .map(s => (
                    <button key={s.icao}
                      onClick={() => onFly?.(s.icao)}
                      className="w-full text-left flex items-center justify-between text-[11px] px-1.5 py-0.5 rounded hover:bg-zinc-800/60 font-mono">
                      <span className="text-zinc-300">{s.cs}</span>
                      <span className="text-zinc-500">FL{String(Math.round(s.alt / 100)).padStart(3,'0')}</span>
                      <span className="text-sky-300">{fmtDir(s.d)} / {fmtSpd(s.k)}</span>
                    </button>
                  ))}
              </div>
            </div>
          )
        })()}

        <div className="px-2 py-1.5 border-t border-zinc-800/70 text-[10px] text-zinc-500 leading-snug">
          Wind barbs use meteorological convention: shaft points downwind, flag = 50 kt, full barb = 10 kt, half barb = 5 kt. Vectors averaged from on-board ADS-B wind reports (DAP).
        </div>
      </div>
    </div>
  )
}
