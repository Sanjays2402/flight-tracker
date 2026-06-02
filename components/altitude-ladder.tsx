'use client'
import { useMemo, useState } from 'react'

export interface LadderFlight {
  icao: string
  callsign: string
  altitudeFt: number
  ground: boolean
  vertRate: number
  velocityKts: number
  category?: string
  emergency?: boolean
}

interface Props {
  flights: LadderFlight[]
  selectedIcao?: string
  onSelect: (icao: string) => void
  onClose: () => void
}

// Buckets in feet, FL-style. Each band 2000ft from 0 to 50k.
const BAND_FT = 2000
const MAX_FT = 50000

function altColor(ft: number, ground: boolean): string {
  if (ground) return '#6b7280'
  if (ft < 5000) return '#ef4444'
  if (ft < 10000) return '#f97316'
  if (ft < 20000) return '#eab308'
  if (ft < 30000) return '#22c55e'
  if (ft < 40000) return '#06b6d4'
  return '#a78bfa'
}

function vsArrow(v: number): string {
  if (v > 500) return '▲'
  if (v < -500) return '▼'
  return '·'
}

export default function AltitudeLadder({ flights, selectedIcao, onSelect, onClose }: Props) {
  const [hover, setHover] = useState<string | null>(null)
  const [showGround, setShowGround] = useState(false)

  const bands = useMemo(() => {
    const out: { low: number; high: number; planes: LadderFlight[] }[] = []
    for (let f = MAX_FT; f >= 0; f -= BAND_FT) {
      out.push({ low: f, high: f + BAND_FT, planes: [] })
    }
    const ground: LadderFlight[] = []
    for (const fl of flights) {
      if (fl.ground || fl.altitudeFt <= 0) {
        if (showGround) ground.push(fl)
        continue
      }
      const idx = Math.floor((MAX_FT - Math.min(MAX_FT - 1, fl.altitudeFt)) / BAND_FT)
      if (idx >= 0 && idx < out.length) out[idx].planes.push(fl)
    }
    for (const b of out) b.planes.sort((a, b2) => b2.altitudeFt - a.altitudeFt)
    return { bands: out, ground }
  }, [flights, showGround])

  const totalAir = flights.filter(f => !f.ground && f.altitudeFt > 0).length
  const maxInBand = Math.max(1, ...bands.bands.map(b => b.planes.length))

  return (
    <div className="absolute right-4 top-20 z-30 w-[280px] max-h-[calc(100vh-160px)] flex flex-col rounded-xl border border-white/10 bg-zinc-950/95 backdrop-blur shadow-2xl text-white">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold">Altitude Ladder</div>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-zinc-300">{totalAir} airborne</span>
        </div>
        <button onClick={onClose} className="text-zinc-400 hover:text-white text-lg leading-none">×</button>
      </div>

      <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] text-zinc-400 border-b border-white/5">
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={showGround} onChange={e => setShowGround(e.target.checked)} className="accent-sky-500 w-3 h-3" />
          <span>show ground</span>
        </label>
        <span className="ml-auto">FL · 2k ft bands</span>
      </div>

      <div className="overflow-y-auto flex-1 px-2 py-2 text-[11px] font-mono">
        {bands.bands.map(b => {
          if (b.planes.length === 0) {
            // empty band, just thin separator every 10k
            const isMajor = b.low % 10000 === 0
            return (
              <div key={b.low} className={`flex items-center gap-2 h-[14px] ${isMajor ? 'text-zinc-500' : 'text-zinc-700'}`}>
                <div className="w-10 text-right tabular-nums">{isMajor ? `FL${(b.low / 100).toString().padStart(3, '0')}` : ''}</div>
                <div className="flex-1 h-px bg-white/5" />
              </div>
            )
          }
          return (
            <div key={b.low} className="flex items-start gap-2 py-0.5 border-l border-white/10 pl-0">
              <div className="w-10 text-right tabular-nums text-zinc-400 pt-0.5">FL{(b.low / 100).toString().padStart(3, '0')}</div>
              <div className="flex-1 flex flex-wrap gap-0.5">
                {b.planes.slice(0, 24).map(p => {
                  const sel = p.icao === selectedIcao
                  const hov = p.icao === hover
                  const c = altColor(p.altitudeFt, p.ground)
                  return (
                    <button
                      key={p.icao}
                      onClick={() => onSelect(p.icao)}
                      onMouseEnter={() => setHover(p.icao)}
                      onMouseLeave={() => setHover(null)}
                      title={`${p.callsign || p.icao} · ${p.altitudeFt}ft · ${Math.round(p.velocityKts)}kt · VS ${p.vertRate >= 0 ? '+' : ''}${Math.round(p.vertRate)}`}
                      className={`relative flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] leading-none transition ${sel ? 'ring-1 ring-white scale-110' : hov ? 'ring-1 ring-white/40' : ''} ${p.emergency ? 'animate-pulse' : ''}`}
                      style={{ background: c + '33', color: c, border: `1px solid ${c}66` }}
                    >
                      <span>{vsArrow(p.vertRate)}</span>
                      <span className="truncate max-w-[44px]">{(p.callsign || p.icao).trim().slice(0, 6)}</span>
                    </button>
                  )
                })}
                {b.planes.length > 24 && (
                  <span className="text-[9px] text-zinc-500 px-1 py-0.5">+{b.planes.length - 24}</span>
                )}
              </div>
              <div className="w-8 text-right text-zinc-500 tabular-nums pt-0.5">{b.planes.length}</div>
              <div className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: altColor(b.low, false) + '88', width: `${Math.min(100, (b.planes.length / maxInBand) * 100)}%`, opacity: 0.05 }} />
            </div>
          )
        })}
        {showGround && bands.ground.length > 0 && (
          <div className="mt-2 pt-2 border-t border-white/10">
            <div className="text-[10px] text-zinc-500 mb-1">On ground ({bands.ground.length})</div>
            <div className="flex flex-wrap gap-0.5">
              {bands.ground.slice(0, 60).map(p => (
                <button
                  key={p.icao}
                  onClick={() => onSelect(p.icao)}
                  className={`px-1 py-0.5 rounded text-[9px] bg-zinc-700/60 text-zinc-300 hover:bg-zinc-600 ${p.icao === selectedIcao ? 'ring-1 ring-white' : ''}`}
                >
                  {(p.callsign || p.icao).trim().slice(0, 6)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-white/10 text-[9px] text-zinc-500 flex items-center gap-2">
        <span style={{ color: '#ef4444' }}>●</span><span>&lt;5k</span>
        <span style={{ color: '#eab308' }}>●</span><span>&lt;20k</span>
        <span style={{ color: '#22c55e' }}>●</span><span>&lt;30k</span>
        <span style={{ color: '#06b6d4' }}>●</span><span>&lt;40k</span>
        <span style={{ color: '#a78bfa' }}>●</span><span>40k+</span>
      </div>
    </div>
  )
}
