'use client'
/**
 * Speed × Altitude Scatter — phase-space diagram of all live traffic.
 * Each aircraft becomes a dot at (groundspeed_kt, altitude_ft). Background
 * shows the canonical operating envelopes (taxi / climb-out / approach /
 * cruise / supersonic) so you can spot anomalies (slow + high = trouble).
 *
 * Hover a dot → callsign tooltip. Click → select + flyTo on the main map.
 * Brush a rectangle to filter visually (highlight + side list). Toggle log-X.
 */
import { useMemo, useRef, useState, useEffect } from 'react'

export interface ScatterFlight {
  icao: string
  callsign: string
  type: string
  operator: string
  altitudeFt: number
  velocityKts: number
  mach: number
  vsFpm: number
  lat: number
  lng: number
  ground: boolean
  emergency: boolean
  category: string
}

interface Props {
  flights: ScatterFlight[]
  onClose: () => void
  onSelect: (f: ScatterFlight) => void
}

const W = 520
const H = 360
const PAD_L = 44
const PAD_R = 12
const PAD_T = 14
const PAD_B = 32
const PW = W - PAD_L - PAD_R
const PH = H - PAD_T - PAD_B

const MAX_ALT = 55000
const MAX_SPD = 700

// Altitude color ramp (matches main map ethos: low=teal, mid=yellow, high=violet).
function altColor(ft: number): string {
  if (ft < 1000) return '#94a3b8'
  if (ft < 10000) return '#22d3ee'
  if (ft < 20000) return '#34d399'
  if (ft < 30000) return '#facc15'
  if (ft < 40000) return '#fb923c'
  return '#a78bfa'
}

function xScale(v: number, logX: boolean): number {
  if (logX) {
    const lo = Math.log10(20), hi = Math.log10(MAX_SPD)
    const lv = Math.log10(Math.max(20, v))
    return PAD_L + ((lv - lo) / (hi - lo)) * PW
  }
  return PAD_L + (Math.min(v, MAX_SPD) / MAX_SPD) * PW
}
function yScale(ft: number): number {
  return PAD_T + PH - (Math.min(Math.max(ft, 0), MAX_ALT) / MAX_ALT) * PH
}

interface Zone { x: number; y: number; w: number; h: number; label: string; fill: string }
function envelopeZones(logX: boolean): Zone[] {
  // Approximate operating envelopes in (kt, ft) space.
  const z = (s1: number, s2: number, a1: number, a2: number, label: string, fill: string): Zone => {
    const x1 = xScale(s1, logX), x2 = xScale(s2, logX)
    const y1 = yScale(a2), y2 = yScale(a1)
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, label, fill }
  }
  return [
    z(0, 60, 0, 200, 'TAXI', 'rgba(148,163,184,0.10)'),
    z(60, 220, 0, 5000, 'TAKEOFF/LAND', 'rgba(34,211,238,0.10)'),
    z(120, 280, 1000, 12000, 'APPROACH', 'rgba(52,211,153,0.10)'),
    z(220, 320, 12000, 25000, 'CLIMB/DESC', 'rgba(250,204,21,0.10)'),
    z(380, 540, 28000, 45000, 'CRUISE', 'rgba(167,139,250,0.14)'),
    z(540, MAX_SPD, 35000, 55000, 'SUPERSONIC', 'rgba(244,114,182,0.16)'),
  ]
}

interface BrushRect { x0: number; y0: number; x1: number; y1: number }

export default function SpeedAltScatter({ flights, onClose, onSelect }: Props) {
  const [logX, setLogX] = useState(false)
  const [hideGround, setHideGround] = useState(true)
  const [hover, setHover] = useState<{ f: ScatterFlight; x: number; y: number } | null>(null)
  const [brush, setBrush] = useState<BrushRect | null>(null)
  const [brushDrag, setBrushDrag] = useState<{ x: number; y: number } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const pts = useMemo(() => {
    return flights
      .filter(f => !hideGround || !f.ground)
      .filter(f => f.velocityKts > 0 && f.altitudeFt > -500)
      .map(f => ({
        f,
        x: xScale(f.velocityKts, logX),
        y: yScale(f.altitudeFt),
      }))
  }, [flights, logX, hideGround])

  const brushed = useMemo(() => {
    if (!brush) return null
    const x0 = Math.min(brush.x0, brush.x1)
    const x1 = Math.max(brush.x0, brush.x1)
    const y0 = Math.min(brush.y0, brush.y1)
    const y1 = Math.max(brush.y0, brush.y1)
    return pts.filter(p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1).map(p => p.f)
  }, [brush, pts])

  // Stats for current set
  const stats = useMemo(() => {
    if (!pts.length) return { n: 0, mAlt: 0, mSpd: 0, mMach: 0, max: 0 }
    let sa = 0, ss = 0, sm = 0, mx = 0, nm = 0
    for (const p of pts) {
      sa += p.f.altitudeFt
      ss += p.f.velocityKts
      if (p.f.mach > 0) { sm += p.f.mach; nm++ }
      if (p.f.altitudeFt > mx) mx = p.f.altitudeFt
    }
    return {
      n: pts.length,
      mAlt: Math.round(sa / pts.length),
      mSpd: Math.round(ss / pts.length),
      mMach: nm ? sm / nm : 0,
      max: mx,
    }
  }, [pts])

  const altTicks = [0, 10000, 20000, 30000, 40000, 50000]
  const spdTicks = logX ? [20, 50, 100, 200, 400, 700] : [0, 100, 200, 300, 400, 500, 600, 700]
  const zones = useMemo(() => envelopeZones(logX), [logX])

  function svgCoord(e: React.MouseEvent): { x: number; y: number } | null {
    const svg = svgRef.current
    if (!svg) return null
    const r = svg.getBoundingClientRect()
    const sx = W / r.width, sy = H / r.height
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy }
  }

  // Close on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div className="absolute top-20 left-3 md:left-4 z-20 w-[min(96vw,580px)] max-h-[80vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-violet-300 font-semibold">Speed × Altitude</span>
          <span className="text-[10px] text-slate-500">{stats.n} aircraft</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setLogX(v => !v)}
            className={`text-[9px] uppercase tracking-wider px-2 py-1 rounded-md border ${logX ? 'bg-violet-500/20 border-violet-400/40 text-violet-200' : 'bg-slate-900 border-slate-700 text-slate-400'}`}>
            log X
          </button>
          <button onClick={() => setHideGround(v => !v)}
            className={`text-[9px] uppercase tracking-wider px-2 py-1 rounded-md border ${hideGround ? 'bg-slate-900 border-slate-700 text-slate-400' : 'bg-violet-500/20 border-violet-400/40 text-violet-200'}`}>
            +ground
          </button>
          {brush && (
            <button onClick={() => setBrush(null)}
              className="text-[9px] uppercase tracking-wider px-2 py-1 rounded-md bg-slate-900 border border-slate-700 text-slate-400 hover:text-slate-200">
              clear
            </button>
          )}
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm px-1">✕</button>
        </div>
      </div>

      <div className="p-2">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block select-none"
          onMouseDown={(e) => {
            const c = svgCoord(e); if (!c) return
            if (c.x < PAD_L || c.x > W - PAD_R || c.y < PAD_T || c.y > H - PAD_B) return
            setBrushDrag(c); setBrush({ x0: c.x, y0: c.y, x1: c.x, y1: c.y })
          }}
          onMouseMove={(e) => {
            const c = svgCoord(e); if (!c) return
            if (brushDrag) {
              setBrush({ x0: brushDrag.x, y0: brushDrag.y, x1: c.x, y1: c.y })
            }
          }}
          onMouseUp={() => {
            setBrushDrag(null)
            if (brush) {
              const dx = Math.abs(brush.x1 - brush.x0), dy = Math.abs(brush.y1 - brush.y0)
              if (dx < 4 && dy < 4) setBrush(null) // treat as click
            }
          }}
          onMouseLeave={() => { setBrushDrag(null); setHover(null) }}
        >
          {/* Background panel */}
          <rect x={PAD_L} y={PAD_T} width={PW} height={PH} fill="#020617" stroke="#1e293b" />

          {/* Envelope zones */}
          {zones.map(z => (
            <g key={z.label}>
              <rect x={z.x} y={z.y} width={z.w} height={z.h} fill={z.fill} stroke="rgba(255,255,255,0.05)" strokeDasharray="2 3" />
              <text x={z.x + z.w / 2} y={z.y + 11} textAnchor="middle"
                className="fill-slate-500" style={{ fontSize: 8, letterSpacing: 1 }}>{z.label}</text>
            </g>
          ))}

          {/* Grid + Y ticks (alt) */}
          {altTicks.map(t => (
            <g key={`ay-${t}`}>
              <line x1={PAD_L} x2={W - PAD_R} y1={yScale(t)} y2={yScale(t)} stroke="#1e293b" strokeDasharray="2 4" />
              <text x={PAD_L - 6} y={yScale(t) + 3} textAnchor="end" className="fill-slate-500" style={{ fontSize: 9 }}>
                {t === 0 ? '0' : `FL${String(t / 100).padStart(3, '0')}`}
              </text>
            </g>
          ))}
          {/* X ticks (spd) */}
          {spdTicks.map(t => (
            <g key={`ax-${t}`}>
              <line x1={xScale(t, logX)} x2={xScale(t, logX)} y1={PAD_T} y2={H - PAD_B} stroke="#1e293b" strokeDasharray="2 4" />
              <text x={xScale(t, logX)} y={H - PAD_B + 12} textAnchor="middle" className="fill-slate-500" style={{ fontSize: 9 }}>{t}</text>
            </g>
          ))}
          <text x={W / 2} y={H - 4} textAnchor="middle" className="fill-slate-400" style={{ fontSize: 9, letterSpacing: 2 }}>GROUND SPEED (kt)</text>
          <text x={10} y={H / 2} textAnchor="middle" className="fill-slate-400"
            transform={`rotate(-90 10 ${H / 2})`} style={{ fontSize: 9, letterSpacing: 2 }}>ALTITUDE</text>

          {/* Mach 1 reference line (approx 575kt at FL350) — diagonal-ish */}
          <line x1={xScale(575, logX)} y1={yScale(35000)} x2={xScale(660, logX)} y2={yScale(50000)}
            stroke="rgba(244,114,182,0.4)" strokeDasharray="3 3" strokeWidth={1} />

          {/* Points */}
          {pts.map(({ f, x, y }) => {
            const inBrush = brushed ? brushed.includes(f) : true
            const r = f.emergency ? 5 : 3
            const color = f.emergency ? '#f43f5e' : altColor(f.altitudeFt)
            return (
              <circle key={f.icao} cx={x} cy={y} r={r}
                fill={color}
                opacity={inBrush ? 0.95 : 0.18}
                stroke={f.emergency ? '#fff' : 'rgba(0,0,0,0.4)'}
                strokeWidth={f.emergency ? 1 : 0.5}
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHover({ f, x, y })}
                onClick={(e) => { e.stopPropagation(); onSelect(f) }}
              />
            )
          })}

          {/* Brush rect */}
          {brush && (
            <rect
              x={Math.min(brush.x0, brush.x1)} y={Math.min(brush.y0, brush.y1)}
              width={Math.abs(brush.x1 - brush.x0)} height={Math.abs(brush.y1 - brush.y0)}
              fill="rgba(167,139,250,0.08)" stroke="#a78bfa" strokeDasharray="3 3" strokeWidth={1}
              pointerEvents="none"
            />
          )}

          {/* Hover tooltip */}
          {hover && (
            <g pointerEvents="none">
              <line x1={hover.x} y1={hover.y} x2={hover.x} y2={H - PAD_B} stroke="rgba(167,139,250,0.4)" strokeDasharray="2 2" />
              <line x1={PAD_L} y1={hover.y} x2={hover.x} y2={hover.y} stroke="rgba(167,139,250,0.4)" strokeDasharray="2 2" />
              <rect x={hover.x + 8} y={hover.y - 30} width={130} height={28} rx={4}
                fill="rgba(2,6,23,0.95)" stroke="#334155" />
              <text x={hover.x + 14} y={hover.y - 17} className="fill-slate-100" style={{ fontSize: 10, fontWeight: 600 }}>
                {hover.f.callsign || hover.f.icao.toUpperCase()}
              </text>
              <text x={hover.x + 14} y={hover.y - 6} className="fill-slate-400" style={{ fontSize: 9 }}>
                {Math.round(hover.f.velocityKts)}kt · {Math.round(hover.f.altitudeFt).toLocaleString()}ft
                {hover.f.mach > 0 ? ` · M${hover.f.mach.toFixed(2)}` : ''}
              </text>
            </g>
          )}
        </svg>

        {/* Stat strip */}
        <div className="flex items-center justify-between px-1 mt-1 text-[10px]">
          <div className="flex gap-3 text-slate-400">
            <span>μ alt <span className="text-slate-200 font-mono">{stats.mAlt.toLocaleString()}ft</span></span>
            <span>μ spd <span className="text-slate-200 font-mono">{stats.mSpd}kt</span></span>
            {stats.mMach > 0 && <span>μ M <span className="text-slate-200 font-mono">{stats.mMach.toFixed(2)}</span></span>}
            <span>max <span className="text-slate-200 font-mono">{stats.max.toLocaleString()}ft</span></span>
          </div>
          <span className="text-slate-500">drag = brush · click dot = fly</span>
        </div>

        {/* Brushed list */}
        {brushed && brushed.length > 0 && (
          <div className="mt-2 border-t border-slate-800 pt-2 max-h-44 overflow-y-auto">
            <div className="text-[9px] uppercase tracking-wider text-violet-300 mb-1 px-1">{brushed.length} in region</div>
            <div className="space-y-px">
              {brushed.slice(0, 30).map(f => (
                <button key={f.icao} onClick={() => onSelect(f)}
                  className="w-full flex items-center justify-between text-left px-2 py-1 rounded hover:bg-slate-800/70 text-[11px]">
                  <span className="font-mono text-slate-100 truncate w-24">{f.callsign || f.icao.toUpperCase()}</span>
                  <span className="text-slate-500 truncate flex-1 px-2">{f.type || '—'}</span>
                  <span className="text-slate-300 font-mono w-12 text-right">{Math.round(f.velocityKts)}kt</span>
                  <span className="text-slate-400 font-mono w-16 text-right">{Math.round(f.altitudeFt).toLocaleString()}ft</span>
                </button>
              ))}
              {brushed.length > 30 && <div className="text-[9px] text-slate-600 px-2">+{brushed.length - 30} more…</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
