'use client'
import { useEffect, useRef, useState } from 'react'

/* Synthetic Primary Flight Display (PFD) for the selected aircraft.
   Glass-cockpit style: airspeed tape (left), attitude indicator (centre),
   altitude tape + VSI (right), heading tape + compass rose (bottom).
   Bank angle and pitch are *derived* from ADS-B track history + FPA. */

export interface CockpitFlight {
  icao: string
  callsign: string
  registration: string
  type: string
  altitudeFt: number
  velocityKts: number
  ias: number
  mach: number
  vertRate: number
  navAlt: number
  windDir: number
  windKts: number
  oat: number
  track: number
  squawk: string
  ground: boolean
}

interface Props {
  flight: CockpitFlight
  trail?: Array<{ lat: number; lng: number; alt: number; t: number; track?: number }>
  onClose: () => void
}

/* --- helpers --- */
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)) }
function angDiff(a: number, b: number) {
  let d = ((a - b + 540) % 360) - 180
  return d
}

export default function CockpitHUD({ flight, trail, onClose }: Props) {
  // derive bank from rate of heading change over last ~6s of trail
  const [bank, setBank] = useState(0)
  const [pitch, setPitch] = useState(0)
  const lastRef = useRef<{ track: number; t: number } | null>(null)

  useEffect(() => {
    // bank from trail (preferred) — turn rate * stand-rate-turn approximation
    let turnRateDegSec = 0
    if (trail && trail.length >= 3) {
      const recent = trail.slice(-6)
      const first = recent[0]; const last = recent[recent.length - 1]
      const dt = Math.max(1, (last.t - first.t) / 1000)
      const t0 = first.track ?? flight.track
      const t1 = last.track ?? flight.track
      turnRateDegSec = angDiff(t1, t0) / dt
    } else if (lastRef.current) {
      const dt = Math.max(0.5, (Date.now() - lastRef.current.t) / 1000)
      turnRateDegSec = angDiff(flight.track, lastRef.current.track) / dt
    }
    lastRef.current = { track: flight.track, t: Date.now() }
    // coordinated turn: tan(bank) = (turnRate_rad/s * TAS_m/s) / g
    const tasMs = Math.max(40, flight.velocityKts * 0.5144)
    const omega = turnRateDegSec * Math.PI / 180
    const bankRad = Math.atan2(omega * tasMs, 9.81)
    const bankDeg = clamp(bankRad * 180 / Math.PI, -45, 45)
    setBank(prev => prev * 0.5 + bankDeg * 0.5)
    // pitch from flight path angle (vertical rate vs ground speed)
    const gsFpm = Math.max(50, flight.velocityKts) * 101.27 // kts→fpm horiz
    const fpa = Math.atan2(flight.vertRate, gsFpm) * 180 / Math.PI
    setPitch(clamp(fpa, -15, 25))
  }, [flight.track, flight.vertRate, flight.velocityKts, trail])

  const W = 760, H = 460
  const cx = W / 2, cy = 200
  const adR = 150 // attitude radius
  const pitchPx = pitch * 6 // px per degree

  // --- airspeed tape: 40 kt window
  const ias = flight.ias > 0 ? flight.ias : flight.velocityKts
  const spdMarks: number[] = []
  for (let v = Math.floor(ias / 10) * 10 - 40; v <= Math.floor(ias / 10) * 10 + 40; v += 10) {
    if (v >= 0) spdMarks.push(v)
  }

  // --- altitude tape: 1000ft window
  const alt = flight.altitudeFt
  const altMarks: number[] = []
  for (let a = Math.floor(alt / 100) * 100 - 500; a <= Math.floor(alt / 100) * 100 + 500; a += 100) altMarks.push(a)

  // --- heading tape: ±45° window
  const hdg = flight.track
  const hdgMarks: number[] = []
  for (let h = -50; h <= 50; h += 5) {
    const v = ((hdg + h) % 360 + 360) % 360
    hdgMarks.push(v)
  }

  const navBugDelta = flight.navAlt > 0 ? flight.navAlt - alt : 0

  return (
    <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-40 w-[96vw] max-w-[780px]">
      <div className="bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800/80 bg-slate-900/60">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-slate-400 font-mono">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-slate-200 font-semibold">PFD</span>
            <span>·</span>
            <span className="text-sky-300">{flight.callsign || flight.icao.toUpperCase()}</span>
            <span className="text-slate-500">{flight.registration} {flight.type}</span>
            {flight.squawk && flight.squawk !== '0000' && <span className="text-amber-300">SQ {flight.squawk}</span>}
          </div>
          <button onClick={onClose}
            className="text-slate-500 hover:text-slate-200 text-xs px-2 py-0.5 rounded border border-slate-800 hover:border-slate-600">
            CLOSE
          </button>
        </div>

        <svg viewBox={`0 0 ${W} ${H}`} className="w-full block bg-black">
          {/* === ATTITUDE INDICATOR (centre) === */}
          <defs>
            <clipPath id="adi-clip"><circle cx={cx} cy={cy} r={adR} /></clipPath>
            <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#1e40af" /><stop offset="1" stopColor="#3b82f6" />
            </linearGradient>
            <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#78350f" /><stop offset="1" stopColor="#451a03" />
            </linearGradient>
          </defs>

          <g clipPath="url(#adi-clip)">
            <g transform={`rotate(${-bank} ${cx} ${cy})`}>
              {/* sky / ground halves, shifted by pitch */}
              <rect x={cx - 400} y={cy - 400 + pitchPx} width={800} height={400} fill="url(#sky)" />
              <rect x={cx - 400} y={cy + pitchPx} width={800} height={400} fill="url(#ground)" />
              <line x1={cx - 400} y1={cy + pitchPx} x2={cx + 400} y2={cy + pitchPx} stroke="#fef3c7" strokeWidth={2} />
              {/* pitch ladder */}
              {[-20, -15, -10, -5, 5, 10, 15, 20].map(p => {
                const y = cy + pitchPx - p * 6
                const w = Math.abs(p) % 10 === 0 ? 70 : 36
                return (
                  <g key={p}>
                    <line x1={cx - w} y1={y} x2={cx + w} y2={y} stroke="#f8fafc" strokeWidth={1.2} />
                    {Math.abs(p) % 10 === 0 && (
                      <>
                        <text x={cx - w - 6} y={y + 3} textAnchor="end" fontSize={10} fill="#f8fafc" fontFamily="monospace">{Math.abs(p)}</text>
                        <text x={cx + w + 6} y={y + 3} fontSize={10} fill="#f8fafc" fontFamily="monospace">{Math.abs(p)}</text>
                      </>
                    )}
                  </g>
                )
              })}
            </g>
          </g>

          {/* bank arc + ticks */}
          <g>
            <circle cx={cx} cy={cy} r={adR} fill="none" stroke="#334155" strokeWidth={2} />
            {[-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60].map(a => {
              const rad = (a - 90) * Math.PI / 180
              const r1 = adR, r2 = adR - (Math.abs(a) % 30 === 0 ? 12 : 6)
              return (
                <line key={a}
                  x1={cx + Math.cos(rad) * r1} y1={cy + Math.sin(rad) * r1}
                  x2={cx + Math.cos(rad) * r2} y2={cy + Math.sin(rad) * r2}
                  stroke="#f8fafc" strokeWidth={Math.abs(a) % 30 === 0 ? 2 : 1} />
              )
            })}
            {/* bank pointer (sky pointer) */}
            <g transform={`rotate(${-bank} ${cx} ${cy})`}>
              <polygon points={`${cx},${cy - adR + 2} ${cx - 7},${cy - adR + 14} ${cx + 7},${cy - adR + 14}`} fill="#fde047" stroke="#0f172a" strokeWidth={0.8} />
            </g>
            {/* fixed centre aircraft symbol */}
            <g stroke="#fde047" strokeWidth={3} fill="none" strokeLinecap="round">
              <line x1={cx - 55} y1={cy} x2={cx - 18} y2={cy} />
              <line x1={cx - 18} y1={cy} x2={cx - 18} y2={cy + 8} />
              <line x1={cx + 18} y1={cy} x2={cx + 55} y2={cy} />
              <line x1={cx + 18} y1={cy} x2={cx + 18} y2={cy + 8} />
              <circle cx={cx} cy={cy} r={3} fill="#fde047" />
            </g>
            <text x={cx} y={cy + adR + 18} textAnchor="middle" fontSize={11} fill="#94a3b8" fontFamily="monospace">
              BANK {bank >= 0 ? 'R' : 'L'} {Math.abs(bank).toFixed(0)}° · PITCH {pitch >= 0 ? '+' : ''}{pitch.toFixed(1)}°
            </text>
          </g>

          {/* === AIRSPEED TAPE (left) === */}
          <g>
            <rect x={50} y={cy - 110} width={70} height={220} fill="#0b1220" stroke="#334155" />
            <clipPath id="spd-clip"><rect x={50} y={cy - 110} width={70} height={220} /></clipPath>
            <g clipPath="url(#spd-clip)">
              {spdMarks.map(v => {
                const y = cy + (ias - v) * 4
                return (
                  <g key={v}>
                    <line x1={110} y1={y} x2={120} y2={y} stroke="#cbd5e1" />
                    <text x={104} y={y + 3} textAnchor="end" fontSize={11} fill="#e2e8f0" fontFamily="monospace">{v}</text>
                  </g>
                )
              })}
            </g>
            {/* current readout box */}
            <rect x={42} y={cy - 14} width={86} height={28} fill="#000" stroke="#fde047" strokeWidth={1.5} />
            <text x={85} y={cy + 5} textAnchor="middle" fontSize={18} fill="#fde047" fontFamily="monospace" fontWeight="bold">{Math.round(ias)}</text>
            <text x={85} y={cy - 118} textAnchor="middle" fontSize={10} fill="#94a3b8" fontFamily="monospace">IAS kt</text>
            <text x={85} y={cy + 128} textAnchor="middle" fontSize={11} fill="#22d3ee" fontFamily="monospace">M {flight.mach > 0 ? flight.mach.toFixed(3) : '—'}</text>
            <text x={85} y={cy + 144} textAnchor="middle" fontSize={10} fill="#64748b" fontFamily="monospace">GS {Math.round(flight.velocityKts)}</text>
          </g>

          {/* === ALTITUDE TAPE (right) === */}
          <g>
            <rect x={W - 120} y={cy - 110} width={70} height={220} fill="#0b1220" stroke="#334155" />
            <clipPath id="alt-clip"><rect x={W - 120} y={cy - 110} width={70} height={220} /></clipPath>
            <g clipPath="url(#alt-clip)">
              {altMarks.map(a => {
                const y = cy + (alt - a) * 0.4
                return (
                  <g key={a}>
                    <line x1={W - 120} y1={y} x2={W - 110} y2={y} stroke="#cbd5e1" />
                    <text x={W - 106} y={y + 3} fontSize={11} fill="#e2e8f0" fontFamily="monospace">{a}</text>
                  </g>
                )
              })}
              {/* MCP selected altitude bug */}
              {flight.navAlt > 0 && Math.abs(navBugDelta) * 0.4 < 110 && (
                <polygon points={`${W - 120},${cy - navBugDelta * 0.4 - 6} ${W - 112},${cy - navBugDelta * 0.4} ${W - 120},${cy - navBugDelta * 0.4 + 6}`} fill="#a78bfa" />
              )}
            </g>
            <rect x={W - 128} y={cy - 14} width={86} height={28} fill="#000" stroke="#fde047" strokeWidth={1.5} />
            <text x={W - 85} y={cy + 5} textAnchor="middle" fontSize={18} fill="#fde047" fontFamily="monospace" fontWeight="bold">{Math.round(alt)}</text>
            <text x={W - 85} y={cy - 118} textAnchor="middle" fontSize={10} fill="#94a3b8" fontFamily="monospace">ALT ft</text>
            <text x={W - 85} y={cy + 128} textAnchor="middle" fontSize={11} fill="#a78bfa" fontFamily="monospace">
              {flight.navAlt > 0 ? `SEL ${flight.navAlt}` : 'SEL —'}
            </text>
            <text x={W - 85} y={cy + 144} textAnchor="middle" fontSize={10} fill="#64748b" fontFamily="monospace">
              OAT {flight.oat !== undefined && flight.oat !== 0 ? `${flight.oat.toFixed(0)}°C` : '—'}
            </text>
          </g>

          {/* === VSI (far right strip) === */}
          <g>
            <rect x={W - 46} y={cy - 110} width={30} height={220} fill="#0b1220" stroke="#334155" />
            <line x1={W - 46} y1={cy} x2={W - 16} y2={cy} stroke="#475569" />
            {[1000, 2000, 4000].map(v => {
              const y = cy - clamp(v, -6000, 6000) * (90 / 6000)
              const y2 = cy + clamp(v, -6000, 6000) * (90 / 6000)
              return (
                <g key={v}>
                  <line x1={W - 42} y1={y} x2={W - 36} y2={y} stroke="#cbd5e1" />
                  <line x1={W - 42} y1={y2} x2={W - 36} y2={y2} stroke="#cbd5e1" />
                  <text x={W - 30} y={y + 3} fontSize={8} fill="#94a3b8" fontFamily="monospace">{v/1000}</text>
                  <text x={W - 30} y={y2 + 3} fontSize={8} fill="#94a3b8" fontFamily="monospace">{v/1000}</text>
                </g>
              )
            })}
            {(() => {
              const v = clamp(flight.vertRate, -6000, 6000)
              const yPtr = cy - v * (90 / 6000)
              return <polygon points={`${W - 46},${yPtr - 5} ${W - 30},${yPtr} ${W - 46},${yPtr + 5}`} fill="#34d399" />
            })()}
            <text x={W - 31} y={cy - 118} textAnchor="middle" fontSize={9} fill="#94a3b8" fontFamily="monospace">VSI</text>
            <text x={W - 31} y={cy + 128} textAnchor="middle" fontSize={10} fill="#34d399" fontFamily="monospace">
              {flight.vertRate >= 0 ? '+' : ''}{Math.round(flight.vertRate)}
            </text>
          </g>

          {/* === HEADING TAPE (bottom) === */}
          <g>
            <rect x={50} y={H - 80} width={W - 100} height={50} fill="#0b1220" stroke="#334155" />
            <clipPath id="hdg-clip"><rect x={50} y={H - 80} width={W - 100} height={50} /></clipPath>
            <g clipPath="url(#hdg-clip)">
              {hdgMarks.map((v, i) => {
                const off = i * 5 - 50
                const x = cx + off * 6
                const isMajor = v % 30 === 0
                const isMid = v % 10 === 0
                return (
                  <g key={i}>
                    <line x1={x} y1={H - 80} x2={x} y2={H - 80 + (isMajor ? 14 : isMid ? 10 : 6)} stroke="#cbd5e1" />
                    {isMajor && (
                      <text x={x} y={H - 50} textAnchor="middle" fontSize={12} fill="#e2e8f0" fontFamily="monospace">
                        {v === 0 ? 'N' : v === 90 ? 'E' : v === 180 ? 'S' : v === 270 ? 'W' : (v / 10).toFixed(0).padStart(2, '0')}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
            {/* current heading box */}
            <polygon points={`${cx - 8},${H - 82} ${cx + 8},${H - 82} ${cx},${H - 72}`} fill="#fde047" />
            <rect x={cx - 28} y={H - 30} width={56} height={22} fill="#000" stroke="#fde047" strokeWidth={1.5} />
            <text x={cx} y={H - 14} textAnchor="middle" fontSize={14} fill="#fde047" fontFamily="monospace" fontWeight="bold">
              {Math.round(hdg).toString().padStart(3, '0')}°
            </text>
            <text x={62} y={H - 12} fontSize={10} fill="#94a3b8" fontFamily="monospace">HDG</text>
            <text x={W - 62} y={H - 12} textAnchor="end" fontSize={10} fill="#94a3b8" fontFamily="monospace">
              WIND {flight.windKts > 0 ? `${Math.round(flight.windDir).toString().padStart(3,'0')}/${Math.round(flight.windKts).toString().padStart(2,'0')}` : '—'}
            </text>
          </g>

          {/* === Wind arrow (top-left of ADI) === */}
          {flight.windKts > 0 && (() => {
            const relWind = ((flight.windDir - hdg) + 360) % 360
            const wx = 200, wy = 90, wr = 20
            const rad = (relWind - 90) * Math.PI / 180
            return (
              <g>
                <circle cx={wx} cy={wy} r={wr} fill="#0b1220" stroke="#334155" />
                <line x1={wx} y1={wy} x2={wx + Math.cos(rad) * wr * 0.85} y2={wy + Math.sin(rad) * wr * 0.85}
                  stroke="#22d3ee" strokeWidth={2} markerEnd="" />
                <polygon
                  points={`${wx + Math.cos(rad) * wr * 0.85 - 3},${wy + Math.sin(rad) * wr * 0.85 - 3} ${wx + Math.cos(rad) * wr},${wy + Math.sin(rad) * wr} ${wx + Math.cos(rad) * wr * 0.85 + 3},${wy + Math.sin(rad) * wr * 0.85 + 3}`}
                  fill="#22d3ee" />
                <text x={wx} y={wy + wr + 12} textAnchor="middle" fontSize={9} fill="#22d3ee" fontFamily="monospace">
                  {Math.round(flight.windKts)} kt
                </text>
              </g>
            )
          })()}

          {/* === Mode bar across top === */}
          <g>
            <rect x={50} y={20} width={W - 100} height={22} fill="#0b1220" stroke="#334155" />
            <text x={62} y={36} fontSize={11} fontFamily="monospace" fill="#34d399">
              {flight.ground ? 'GND' : flight.vertRate > 200 ? 'CLB' : flight.vertRate < -200 ? 'DES' : 'CRZ'}
            </text>
            <text x={140} y={36} fontSize={11} fontFamily="monospace" fill="#a78bfa">
              {flight.navAlt > 0 ? `ALT ${flight.navAlt}` : 'ALT ---'}
            </text>
            <text x={260} y={36} fontSize={11} fontFamily="monospace" fill="#22d3ee">
              {flight.mach > 0.5 ? `MACH ${flight.mach.toFixed(3)}` : `SPD ${Math.round(ias)}`}
            </text>
            <text x={380} y={36} fontSize={11} fontFamily="monospace" fill="#fde047">
              HDG {Math.round(hdg).toString().padStart(3, '0')}°
            </text>
            <text x={W - 62} y={36} textAnchor="end" fontSize={11} fontFamily="monospace" fill={flight.squawk === '7700' || flight.squawk === '7600' || flight.squawk === '7500' ? '#f43f5e' : '#64748b'}>
              XPDR {flight.squawk || '----'}
            </text>
          </g>
        </svg>
      </div>
    </div>
  )
}
