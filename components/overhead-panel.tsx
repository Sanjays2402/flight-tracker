'use client'
import { useEffect, useMemo, useState } from 'react'

export type OverheadFlight = {
  icao: string
  callsign: string
  operator: string
  type: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  vertRate: number
  ground: boolean
}

type Props = {
  flights: OverheadFlight[]
  onClose: () => void
  onSelect: (icao: string) => void
}

type Computed = OverheadFlight & {
  distNm: number
  bearing: number
  elevDeg: number
  closing: number // negative = approaching
}

const R_EARTH_NM = 3440.065

function toRad(d: number) { return d * Math.PI / 180 }
function toDeg(r: number) { return r * 180 / Math.PI }

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = toRad(lat1), φ2 = toRad(lat2)
  const dφ = toRad(lat2 - lat1), dλ = toRad(lon2 - lon1)
  const a = Math.sin(dφ/2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ/2) ** 2
  return 2 * R_EARTH_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = toRad(lat1), φ2 = toRad(lat2)
  const dλ = toRad(lon2 - lon1)
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}
function compass(deg: number): string {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
  return dirs[Math.round(((deg % 360) / 22.5)) % 16]
}

export default function OverheadPanel({ flights, onClose, onSelect }: Props) {
  const [loc, setLoc] = useState<{lat:number; lng:number} | null>(() => {
    if (typeof window === 'undefined') return null
    try { return JSON.parse(localStorage.getItem('ft-overhead-loc') || 'null') } catch { return null }
  })
  const [geoErr, setGeoErr] = useState<string | null>(null)
  const [geoBusy, setGeoBusy] = useState(false)
  const [radiusNm, setRadiusNm] = useState<number>(() => {
    if (typeof window === 'undefined') return 25
    const v = Number(localStorage.getItem('ft-overhead-r') || '25')
    return Number.isFinite(v) ? v : 25
  })
  const [minElev, setMinElev] = useState<number>(() => {
    if (typeof window === 'undefined') return 0
    const v = Number(localStorage.getItem('ft-overhead-e') || '0')
    return Number.isFinite(v) ? v : 0
  })

  useEffect(() => { try { localStorage.setItem('ft-overhead-r', String(radiusNm)) } catch {} }, [radiusNm])
  useEffect(() => { try { localStorage.setItem('ft-overhead-e', String(minElev)) } catch {} }, [minElev])
  useEffect(() => { if (loc) try { localStorage.setItem('ft-overhead-loc', JSON.stringify(loc)) } catch {} }, [loc])

  const askLocation = () => {
    if (!navigator.geolocation) { setGeoErr('Geolocation not available'); return }
    setGeoBusy(true); setGeoErr(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setGeoBusy(false) },
      (err) => { setGeoErr(err.message || 'Permission denied'); setGeoBusy(false) },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    )
  }

  const computed: Computed[] = useMemo(() => {
    if (!loc) return []
    const out: Computed[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      const d = haversineNm(loc.lat, loc.lng, f.lat, f.lng)
      if (d > radiusNm) continue
      const altNm = (f.altitudeFt || 0) / 6076.12
      const elev = toDeg(Math.atan2(altNm, Math.max(0.001, d)))
      if (elev < minElev) continue
      const bear = bearingDeg(loc.lat, loc.lng, f.lat, f.lng)
      // Closing speed component (signed): negative if approaching observer
      const courseToObs = bearingDeg(f.lat, f.lng, loc.lat, loc.lng)
      const angle = toRad(((f.track - courseToObs) + 540) % 360 - 180)
      const closing = -f.velocityKts * Math.cos(angle) // positive => approaching
      out.push({ ...f, distNm: d, bearing: bear, elevDeg: elev, closing })
    }
    out.sort((a, b) => b.elevDeg - a.elevDeg)
    return out
  }, [flights, loc, radiusNm, minElev])

  return (
    <div className="fixed top-[72px] right-3 z-[55] w-[360px] max-h-[calc(100vh-100px)] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Plane Spotter</div>
          <div className="text-sm font-bold text-slate-100">Overhead Now</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none w-7 h-7 rounded hover:bg-slate-800">×</button>
      </div>

      {!loc ? (
        <div className="p-4 text-center">
          <div className="text-xs text-slate-400 mb-3">Share your location to see what's flying above you with bearing, distance, and look-up angle.</div>
          <button
            onClick={askLocation}
            disabled={geoBusy}
            className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:bg-slate-700 text-white text-xs font-bold uppercase tracking-wider transition">
            {geoBusy ? 'Locating…' : 'Use my location'}
          </button>
          {geoErr && <div className="mt-3 text-[10px] text-rose-400">{geoErr}</div>}
        </div>
      ) : (
        <>
          {/* Compass sky-dome */}
          <div className="p-3 border-b border-slate-800">
            <SkyCompass items={computed} onSelect={onSelect} />
            <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500">
              <span>{loc.lat.toFixed(3)}°, {loc.lng.toFixed(3)}°</span>
              <button onClick={askLocation} className="text-sky-400 hover:underline">refresh</button>
            </div>
          </div>

          <div className="px-3 py-2 border-b border-slate-800 grid grid-cols-2 gap-2">
            <label className="text-[10px] text-slate-400">
              <div className="flex justify-between"><span>RADIUS</span><span className="text-slate-200 font-mono">{radiusNm} nm</span></div>
              <input type="range" min={5} max={100} step={5} value={radiusNm} onChange={(e)=>setRadiusNm(Number(e.target.value))} className="w-full accent-sky-500" />
            </label>
            <label className="text-[10px] text-slate-400">
              <div className="flex justify-between"><span>MIN ELEV</span><span className="text-slate-200 font-mono">{minElev}°</span></div>
              <input type="range" min={0} max={60} step={5} value={minElev} onChange={(e)=>setMinElev(Number(e.target.value))} className="w-full accent-sky-500" />
            </label>
          </div>

          <div className="flex-1 overflow-y-auto">
            {computed.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">Nothing overhead in this filter. Try widening the radius or lowering minimum elevation.</div>
            ) : (
              <ul className="divide-y divide-slate-800/60">
                {computed.slice(0, 50).map(f => (
                  <li key={f.icao}>
                    <button onClick={()=>onSelect(f.icao)} className="w-full text-left px-3 py-2 hover:bg-slate-900 transition">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-mono font-bold text-slate-100 truncate">{f.callsign || f.icao.toUpperCase()}</span>
                            {f.type && <span className="text-[10px] text-slate-500">{f.type}</span>}
                          </div>
                          <div className="text-[10px] text-slate-500 truncate">{f.operator || '—'}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-[11px] font-mono text-amber-400">{compass(f.bearing)} {f.bearing.toFixed(0).padStart(3,'0')}°</div>
                          <div className="text-[10px] text-slate-400 font-mono">{f.distNm.toFixed(1)} nm · {f.elevDeg.toFixed(0)}° up</div>
                        </div>
                      </div>
                      <div className="mt-1 flex items-center gap-3 text-[10px] text-slate-500">
                        <span>FL{Math.round(f.altitudeFt/100).toString().padStart(3,'0')}</span>
                        <span>{f.velocityKts.toFixed(0)} kt</span>
                        <span className={f.closing > 20 ? 'text-emerald-400' : f.closing < -20 ? 'text-slate-500' : 'text-slate-400'}>
                          {f.closing >= 0 ? '↘ approaching' : '↗ departing'} {Math.abs(f.closing).toFixed(0)} kt
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="px-3 py-2 border-t border-slate-800 text-[10px] text-slate-500 flex justify-between">
            <span>{computed.length} aircraft</span>
            <span>look up at the bright dots →</span>
          </div>
        </>
      )}
    </div>
  )
}

function SkyCompass({ items, onSelect }: { items: Computed[]; onSelect: (icao: string) => void }) {
  const size = 220
  const c = size / 2
  // Map elevation 0..90 to radius c..0 (zenith at center)
  const elevToR = (e: number) => c - (Math.min(90, Math.max(0, e)) / 90) * (c - 8)
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" className="block">
      <defs>
        <radialGradient id="skyG" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#0c4a6e" />
          <stop offset="100%" stopColor="#020617" />
        </radialGradient>
      </defs>
      <circle cx={c} cy={c} r={c-1} fill="url(#skyG)" stroke="#1e293b" />
      {/* elev rings: 30, 60 */}
      {[30, 60].map(e => (
        <circle key={e} cx={c} cy={c} r={elevToR(e)} fill="none" stroke="#1e293b" strokeDasharray="2 3" />
      ))}
      {/* cardinal lines */}
      <line x1={c} y1={2} x2={c} y2={size-2} stroke="#1e293b" />
      <line x1={2} y1={c} x2={size-2} y2={c} stroke="#1e293b" />
      {/* cardinals */}
      <text x={c} y={11} textAnchor="middle" fill="#64748b" fontSize="9" fontFamily="monospace">N</text>
      <text x={size-6} y={c+3} textAnchor="end" fill="#64748b" fontSize="9" fontFamily="monospace">E</text>
      <text x={c} y={size-3} textAnchor="middle" fill="#64748b" fontSize="9" fontFamily="monospace">S</text>
      <text x={6} y={c+3} textAnchor="start" fill="#64748b" fontSize="9" fontFamily="monospace">W</text>
      {/* zenith dot */}
      <circle cx={c} cy={c} r={1.5} fill="#475569" />
      {/* plane blips */}
      {items.slice(0, 40).map(f => {
        const r = elevToR(f.elevDeg)
        const θ = toRad(f.bearing - 90) // 0°=N → up; convert: bearing 0 -> -90° (up)
        const x = c + r * Math.cos(θ)
        const y = c + r * Math.sin(θ)
        const color = f.elevDeg > 45 ? '#22d3ee' : f.elevDeg > 20 ? '#38bdf8' : '#818cf8'
        return (
          <g key={f.icao} onClick={()=>onSelect(f.icao)} style={{cursor:'pointer'}}>
            <circle cx={x} cy={y} r={3.5} fill={color} stroke="#0f172a" strokeWidth={0.8}>
              <title>{f.callsign || f.icao} · {f.elevDeg.toFixed(0)}° up · {f.distNm.toFixed(1)} nm</title>
            </circle>
          </g>
        )
      })}
    </svg>
  )
}
