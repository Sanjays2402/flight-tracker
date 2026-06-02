'use client'
import { useEffect, useRef, useState, useMemo } from 'react'

export type RadarFlight = {
  icao: string
  callsign: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  ground: boolean
  emergency: boolean
  military: boolean
}

type Props = {
  flights: RadarFlight[]
  centerLat: number | null
  centerLng: number | null
  centerLabel: string
  selectedIcao?: string | null
  onSelect: (f: RadarFlight) => void
  onClose: () => void
}

const RANGES_NM = [10, 25, 50, 100, 200, 500] as const

function haversineNm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 3440.065 // nm
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRad = (d: number) => (d * Math.PI) / 180
  const toDeg = (r: number) => (r * 180) / Math.PI
  const dLng = toRad(lng2 - lng1)
  const y = Math.sin(dLng) * Math.cos(toRad(lat2))
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

function altColor(ft: number, ground: boolean) {
  if (ground) return '#64748b'
  if (ft < 5000) return '#22d3ee'
  if (ft < 15000) return '#10b981'
  if (ft < 25000) return '#84cc16'
  if (ft < 35000) return '#facc15'
  if (ft < 45000) return '#f97316'
  return '#f43f5e'
}

export default function TrafficRadar({
  flights,
  centerLat,
  centerLng,
  centerLabel,
  selectedIcao,
  onSelect,
  onClose,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [rangeIdx, setRangeIdx] = useState(2) // 50nm
  const [northUp, setNorthUp] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [hover, setHover] = useState<(RadarFlight & { distNm: number; brg: number; x: number; y: number }) | null>(null)
  const sweepRef = useRef(0)
  const rafRef = useRef<number | null>(null)

  const size = 320
  const cx = size / 2
  const cy = size / 2
  const radius = size / 2 - 14
  const rangeNm = RANGES_NM[rangeIdx]

  // contacts within range
  const contacts = useMemo(() => {
    if (centerLat == null || centerLng == null) return []
    const list: Array<RadarFlight & { distNm: number; brg: number; x: number; y: number }> = []
    for (const f of flights) {
      if (!f || typeof f.lat !== 'number' || typeof f.lng !== 'number') continue
      if (f.lat === centerLat && f.lng === centerLng) continue
      const d = haversineNm(centerLat, centerLng, f.lat, f.lng)
      if (d > rangeNm) continue
      const b = bearingDeg(centerLat, centerLng, f.lat, f.lng)
      const ang = ((northUp ? b : b) - 90) * (Math.PI / 180)
      const r = (d / rangeNm) * radius
      list.push({ ...f, distNm: d, brg: b, x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) })
    }
    list.sort((a, b) => a.distNm - b.distNm)
    return list
  }, [flights, centerLat, centerLng, rangeNm, northUp, cx, cy, radius])

  // sweep animation
  useEffect(() => {
    const loop = () => {
      sweepRef.current = (sweepRef.current + 1.4) % 360
      draw()
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts, hover, selectedIcao, showLabels])

  function draw() {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    if (c.width !== size * dpr) {
      c.width = size * dpr
      c.height = size * dpr
    }
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)

    // background
    const grad = ctx.createRadialGradient(cx, cy, 10, cx, cy, radius)
    grad.addColorStop(0, 'rgba(16, 185, 129, 0.10)')
    grad.addColorStop(1, 'rgba(2, 6, 23, 0.95)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.fill()

    // range rings
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.35)'
    ctx.lineWidth = 1
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath()
      ctx.arc(cx, cy, (radius * i) / 4, 0, Math.PI * 2)
      ctx.stroke()
    }
    // crosshairs
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.25)'
    ctx.beginPath()
    ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy)
    ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius)
    ctx.stroke()

    // bearing labels
    ctx.fillStyle = 'rgba(148, 163, 184, 0.85)'
    ctx.font = '9px ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('N', cx, cy - radius - 6)
    ctx.fillText('S', cx, cy + radius + 6)
    ctx.fillText('E', cx + radius + 8, cy)
    ctx.fillText('W', cx - radius - 8, cy)

    // range labels (on east axis)
    ctx.fillStyle = 'rgba(16, 185, 129, 0.65)'
    ctx.textAlign = 'left'
    for (let i = 1; i <= 4; i++) {
      const r = (radius * i) / 4
      const nm = Math.round((rangeNm * i) / 4)
      ctx.fillText(`${nm}`, cx + r + 2, cy - 6)
    }

    // sweep
    const sweepRad = (sweepRef.current - 90) * (Math.PI / 180)
    let sweepGrad: CanvasGradient | null = null
    try {
      const fn = (ctx as any).createConicGradient
      if (fn) sweepGrad = fn.call(ctx, sweepRad, cx, cy)
    } catch {}
    if (sweepGrad) {
      sweepGrad.addColorStop(0, 'rgba(34, 197, 94, 0.45)')
      sweepGrad.addColorStop(0.08, 'rgba(34, 197, 94, 0.0)')
      sweepGrad.addColorStop(1, 'rgba(34, 197, 94, 0.0)')
      ctx.save()
      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
      ctx.clip()
      ctx.fillStyle = sweepGrad
      ctx.fillRect(0, 0, size, size)
      ctx.restore()
    }
    // sweep line
    ctx.strokeStyle = 'rgba(34, 197, 94, 0.85)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + radius * Math.cos(sweepRad), cy + radius * Math.sin(sweepRad))
    ctx.stroke()

    // center dot (own ship / map center)
    ctx.fillStyle = '#fbbf24'
    ctx.beginPath()
    ctx.arc(cx, cy, 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.4)'
    ctx.beginPath()
    ctx.arc(cx, cy, 7, 0, Math.PI * 2)
    ctx.stroke()

    // contacts
    for (const f of contacts) {
      const isSel = f.icao === selectedIcao
      const isHover = hover?.icao === f.icao
      const color = f.emergency ? '#f43f5e' : altColor(f.altitudeFt, f.ground)
      // heading vector
      const trkRad = ((f.track || 0) - 90) * (Math.PI / 180)
      const vlen = Math.min(14, 2 + (f.velocityKts || 0) / 60)
      ctx.strokeStyle = color
      ctx.globalAlpha = 0.7
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(f.x, f.y)
      ctx.lineTo(f.x + vlen * Math.cos(trkRad), f.y + vlen * Math.sin(trkRad))
      ctx.stroke()
      ctx.globalAlpha = 1

      // blip
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(f.x, f.y, isSel || isHover ? 4 : 2.5, 0, Math.PI * 2)
      ctx.fill()
      if (isSel || isHover) {
        ctx.strokeStyle = isSel ? '#fbbf24' : '#fff'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(f.x, f.y, 7, 0, Math.PI * 2)
        ctx.stroke()
      }
      if (f.emergency) {
        const pulse = 0.5 + 0.5 * Math.sin(sweepRef.current * 0.1)
        ctx.strokeStyle = `rgba(244, 63, 94, ${pulse})`
        ctx.beginPath()
        ctx.arc(f.x, f.y, 9, 0, Math.PI * 2)
        ctx.stroke()
      }

      if (showLabels && (isSel || isHover || f.emergency || f.military)) {
        ctx.fillStyle = '#e2e8f0'
        ctx.font = '9px ui-monospace, monospace'
        ctx.textAlign = 'left'
        const label = `${f.callsign || f.icao.toUpperCase()}`
        const sub = `FL${Math.round(f.altitudeFt / 100)} ${Math.round(f.velocityKts)}kt`
        ctx.fillText(label, f.x + 6, f.y - 2)
        ctx.fillStyle = '#94a3b8'
        ctx.fillText(sub, f.x + 6, f.y + 8)
      }
    }
  }

  function handleMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    let best: typeof contacts[number] | null = null
    let bestD = 12
    for (const c of contacts) {
      const d = Math.hypot(c.x - mx, c.y - my)
      if (d < bestD) { bestD = d; best = c }
    }
    setHover(best)
  }

  function handleClick() {
    if (hover) onSelect(hover)
  }

  const stats = useMemo(() => {
    const air = contacts.filter(c => !c.ground).length
    const emerg = contacts.filter(c => c.emergency).length
    const mil = contacts.filter(c => c.military).length
    const closest = contacts[0]
    return { total: contacts.length, air, emerg, mil, closest }
  }, [contacts])

  return (
    <div className="absolute top-20 right-3 md:right-4 z-20 w-[340px] bg-slate-950/95 backdrop-blur-xl border border-emerald-900/60 rounded-2xl shadow-2xl shadow-emerald-900/30 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 bg-gradient-to-r from-emerald-950/60 to-slate-950">
        <div className="flex items-center gap-2">
          <span className="text-emerald-400 text-sm">◉</span>
          <div>
            <div className="text-[11px] uppercase tracking-widest text-emerald-400 font-mono font-bold">Traffic Radar</div>
            <div className="text-[9px] text-slate-500 font-mono truncate max-w-[200px]">{centerLabel}</div>
          </div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none px-1">×</button>
      </div>

      <div className="px-3 pt-3 pb-1 flex items-center gap-1.5 flex-wrap">
        {RANGES_NM.map((r, i) => (
          <button key={r} onClick={() => setRangeIdx(i)}
            className={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition ${
              i === rangeIdx
                ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
            }`}>
            {r}nm
          </button>
        ))}
        <button onClick={() => setShowLabels(v => !v)}
          className={`ml-auto text-[9px] font-mono px-1.5 py-0.5 rounded border transition ${
            showLabels ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-slate-900 border-slate-800 text-slate-500'
          }`}>
          LBL
        </button>
      </div>

      <div className="px-3 py-2 flex justify-center">
        <canvas
          ref={canvasRef}
          style={{ width: size, height: size, cursor: hover ? 'pointer' : 'crosshair' }}
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
          onClick={handleClick}
        />
      </div>

      <div className="px-3 pb-2 grid grid-cols-4 gap-1 text-center font-mono">
        <div className="bg-slate-900/60 rounded px-1 py-1">
          <div className="text-[8px] text-slate-500 uppercase">Tracks</div>
          <div className="text-emerald-300 text-sm font-bold">{stats.total}</div>
        </div>
        <div className="bg-slate-900/60 rounded px-1 py-1">
          <div className="text-[8px] text-slate-500 uppercase">Air</div>
          <div className="text-sky-300 text-sm font-bold">{stats.air}</div>
        </div>
        <div className="bg-slate-900/60 rounded px-1 py-1">
          <div className="text-[8px] text-slate-500 uppercase">Mil</div>
          <div className="text-orange-300 text-sm font-bold">{stats.mil}</div>
        </div>
        <div className={`rounded px-1 py-1 ${stats.emerg > 0 ? 'bg-rose-950/60' : 'bg-slate-900/60'}`}>
          <div className="text-[8px] text-slate-500 uppercase">Emerg</div>
          <div className={`text-sm font-bold ${stats.emerg > 0 ? 'text-rose-300' : 'text-slate-500'}`}>{stats.emerg}</div>
        </div>
      </div>

      {(hover || stats.closest) && (
        <div className="px-3 pb-3">
          <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-2 text-[10px] font-mono">
            {(() => {
              const c = hover || stats.closest!
              return (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-200 font-bold">{c.callsign || c.icao.toUpperCase()}</span>
                    <span className="text-[8px] text-slate-500 uppercase">{hover ? 'Hover' : 'Closest'}</span>
                  </div>
                  <div className="mt-1 grid grid-cols-3 gap-1 text-slate-400">
                    <div>RNG <span className="text-emerald-300">{c.distNm.toFixed(1)}nm</span></div>
                    <div>BRG <span className="text-sky-300">{Math.round(c.brg).toString().padStart(3,'0')}°</span></div>
                    <div>ALT <span className="text-amber-300">{Math.round(c.altitudeFt).toLocaleString()}ft</span></div>
                  </div>
                  <div className="mt-0.5 grid grid-cols-2 gap-1 text-slate-400">
                    <div>GS <span className="text-slate-200">{Math.round(c.velocityKts)}kt</span></div>
                    <div>HDG <span className="text-slate-200">{Math.round(c.track).toString().padStart(3,'0')}°</span></div>
                  </div>
                </>
              )
            })()}
          </div>
        </div>
      )}
    </div>
  )
}
