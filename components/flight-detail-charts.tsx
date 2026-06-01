'use client'
// [BATCH-C] Extended detail panel: mini charts (alt/speed/vrate), ETA, distance progress,
// time aloft, hexdb enrichment.
import { useEffect, useState } from 'react'
import { Sparkline, ProgressBar } from './charts/mini-charts'
import { fetchAircraftInfo, getCachedAircraft, HexDbInfo } from '../lib/aircraft-db'
import { haversineNm } from '../lib/geo-utils'

interface TrailPt { lat: number; lng: number; alt: number; t: number; spd?: number; vrate?: number }

interface Props {
  icao: string
  callsign: string
  trail: Array<[number, number, number]>  // [lng, lat, alt]
  history?: TrailPt[]                      // optional richer history
  altitudeFt: number
  velocityKts: number
  vertRate: number
  origin?: { lat: number; lng: number; iata?: string; name?: string }
  destination?: { lat: number; lng: number; iata?: string; name?: string }
  firstSeen?: number
}

export function FlightDetailCharts({
  icao, callsign, trail, history, altitudeFt, velocityKts, vertRate,
  origin, destination, firstSeen,
}: Props) {
  const [hex, setHex] = useState<HexDbInfo | null | undefined>(() => getCachedAircraft(icao))
  useEffect(() => {
    let cancelled = false
    const cached = getCachedAircraft(icao)
    if (cached !== undefined) { setHex(cached); return }
    setHex(undefined)
    fetchAircraftInfo(icao).then(info => { if (!cancelled) setHex(info) })
    return () => { cancelled = true }
  }, [icao])

  // Series: from history if present, otherwise reconstruct from trail (alt only).
  const altSeries = history && history.length > 1 ? history.map(p => p.alt) : trail.map(t => t[2])
  const spdSeries = history && history.length > 1 ? history.map(p => p.spd ?? 0).filter(v => v > 0) : [velocityKts]
  const vrSeries = history && history.length > 1 ? history.map(p => p.vrate ?? 0) : [vertRate]

  // Distance flown so far (sum of trail segments)
  let flownNm = 0
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1], b = trail[i]
    flownNm += haversineNm(a[1], a[0], b[1], b[0])
  }

  // Route progress + ETA
  let progressPct = 0
  let etaText = '—'
  let remainingNm = 0
  let totalNm = 0
  let etaConfidence: 'high' | 'med' | 'low' = 'low'
  if (origin && destination && trail.length > 0) {
    const last = trail[trail.length - 1]
    totalNm = haversineNm(origin.lat, origin.lng, destination.lat, destination.lng)
    const fromOrig = haversineNm(origin.lat, origin.lng, last[1], last[0])
    remainingNm = haversineNm(last[1], last[0], destination.lat, destination.lng)
    progressPct = totalNm > 0 ? Math.max(0, Math.min(100, (fromOrig / totalNm) * 100)) : 0
    if (velocityKts > 50) {
      const hrs = remainingNm / velocityKts
      const ms = hrs * 3600 * 1000
      const eta = new Date(Date.now() + ms)
      etaText = eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ` (${hrs >= 1 ? `${Math.floor(hrs)}h ${Math.round((hrs%1)*60)}m` : `${Math.round(hrs*60)}m`})`
      etaConfidence = velocityKts > 250 && Math.abs(vertRate) < 1500 ? 'high' : velocityKts > 150 ? 'med' : 'low'
    }
  }

  // Time aloft
  let aloftText = '—'
  if (firstSeen) {
    const ms = Date.now() - firstSeen
    const h = Math.floor(ms / 3600000)
    const m = Math.floor((ms % 3600000) / 60000)
    aloftText = h > 0 ? `${h}h ${m}m` : `${m}m`
  }

  const confColor = etaConfidence === 'high' ? '#10b981' : etaConfidence === 'med' ? '#facc15' : '#64748b'

  return (
    <div className="space-y-2 mt-3" data-batch-c-charts={icao}>
      {/* Mini charts */}
      <div className="grid grid-cols-1 gap-2">
        <Sparkline data={altSeries} label="ALT" unit="ft" color="#38bdf8" fill="#38bdf8" />
        <Sparkline data={spdSeries} label="SPD" unit="kt" color="#facc15" fill="#facc15" />
        <Sparkline data={vrSeries} label="V/S" unit="fpm" color="#10b981" fill="#10b981" baseline={0} />
      </div>

      {/* Route progress */}
      {origin && destination && (
        <div className="space-y-1.5">
          <ProgressBar
            pct={progressPct}
            label={`PROGRESS · ${origin.iata || '?'} → ${destination.iata || '?'}`}
            value={`${Math.round(flownNm)} / ${Math.round(totalNm)} nm`}
            color="#38bdf8"
          />
          <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-2">
            <div className="flex items-baseline justify-between">
              <span className="text-[9px] uppercase tracking-widest text-slate-500">ETA</span>
              <span className="text-[10px] font-mono" style={{ color: confColor }}>
                {etaConfidence} confidence
              </span>
            </div>
            <div className="text-sm font-mono text-slate-100 mt-0.5">{etaText}</div>
            <div className="text-[10px] font-mono text-slate-500 mt-0.5">{Math.round(remainingNm)} nm remaining</div>
          </div>
        </div>
      )}

      {/* Time aloft + flown */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-2">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">TIME ALOFT</div>
          <div className="text-sm font-mono text-slate-100 mt-0.5">{aloftText}</div>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-2">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">DISTANCE</div>
          <div className="text-sm font-mono text-slate-100 mt-0.5">{Math.round(flownNm)} nm</div>
        </div>
      </div>

      {/* hexdb enrichment */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-2">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[9px] uppercase tracking-widest text-slate-500">REGISTRY (hexdb.io)</span>
          {hex === undefined && <span className="text-[9px] font-mono text-slate-600 animate-pulse">loading…</span>}
        </div>
        {hex === null ? (
          <div className="text-[10px] text-slate-600 italic">no record</div>
        ) : hex ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] font-mono">
            {hex.manufacturer && <div><span className="text-slate-500">mfr </span><span className="text-slate-200">{hex.manufacturer}</span></div>}
            {hex.type && <div><span className="text-slate-500">type </span><span className="text-slate-200">{hex.type}</span></div>}
            {hex.owner && <div className="col-span-2"><span className="text-slate-500">owner </span><span className="text-slate-200">{hex.owner}</span></div>}
            {hex.built && <div><span className="text-slate-500">built </span><span className="text-slate-200">{hex.built}</span></div>}
            {hex.registration && <div><span className="text-slate-500">reg </span><span className="text-slate-200">{hex.registration}</span></div>}
          </div>
        ) : (
          <div className="text-[10px] text-slate-600 italic">—</div>
        )}
      </div>
    </div>
  )
}
