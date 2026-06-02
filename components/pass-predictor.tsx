'use client'
import { useEffect, useMemo, useState } from 'react'
import { solarPosition } from './terminator-layer'

/* ============================================================
   Pass Predictor Panel
   -----------------------------------------------------------
   For an observer location (map center or browser geolocation),
   forward-projects every airborne aircraft along its current
   ground vector + vertical rate to find the closest point of
   approach (CPA) overhead within a configurable look-ahead window.

   For each predicted pass we compute:
     - time to CPA (s)
     - slant range and ground range (nm)
     - elevation angle above local horizon (deg)
     - azimuth from observer to plane at CPA (deg)
     - sun azimuth/altitude (from solar math) at CPA time
     - relative sun bearing => front-lit / side-lit / back-lit
     - photo score: combines elevation, slant range, sun-relative
       lighting and sun-above-horizon bonus.

   Passes are ranked by photo score then time. Click a row to fly
   the map to that aircraft. Pure SVG sky-dome viz (no MapLibre
   layers needed) showing pass tracks across the hemisphere.
   ============================================================ */

export interface PassFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  vertRate: number
  ground: boolean
}

interface Props {
  flights: PassFlight[]
  centerLat: number
  centerLng: number
  onClose: () => void
  onFly: (icao: string) => void
}

interface Pass {
  flight: PassFlight
  tCpaSec: number
  slantNm: number
  groundNm: number
  elevationDeg: number
  azimuthDeg: number
  sunAzDeg: number
  sunAltDeg: number
  relSunDeg: number  // -180..180, 0 = sun behind observer
  lighting: 'FRONT' | 'SIDE' | 'BACK' | 'NIGHT'
  score: number
}

const NM_PER_DEG_LAT = 60
function nmBetween(lat1: number, lng1: number, lat2: number, lng2: number): { dN: number; dE: number; nm: number; brg: number } {
  const dLat = lat2 - lat1
  const dLng = lng2 - lng1
  const dN = dLat * NM_PER_DEG_LAT
  const dE = dLng * NM_PER_DEG_LAT * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180)
  const nm = Math.sqrt(dN * dN + dE * dE)
  let brg = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360
  return { dN, dE, nm, brg }
}
function fmtCompass(deg: number): string {
  const d = ((deg % 360) + 360) % 360
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
  return dirs[Math.round(d / 22.5) % 16]
}

// approximate sun elevation/azimuth from subsolar lat/lng (good enough for photo-light estimation)
function sunHorizon(obsLat: number, obsLng: number, subLat: number, subLng: number): { altDeg: number; azDeg: number } {
  const phi = obsLat * Math.PI / 180
  const dec = subLat * Math.PI / 180
  let H = (subLng - obsLng) * Math.PI / 180  // hour angle (radians), positive when sun is east of obs
  // normalize to -pi..pi
  while (H > Math.PI) H -= 2 * Math.PI
  while (H < -Math.PI) H += 2 * Math.PI
  // standard formulas (note: H here is "longitude of sun east of obs", so we use sin(H), cos(H) directly with sign)
  const sinAlt = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)
  const altRad = Math.asin(Math.max(-1, Math.min(1, sinAlt)))
  const cosAlt = Math.cos(altRad)
  let azRad = 0
  if (cosAlt > 1e-6) {
    const sinAz = -Math.cos(dec) * Math.sin(H) / cosAlt
    const cosAz = (Math.sin(dec) - Math.sin(altRad) * Math.sin(phi)) / (cosAlt * Math.cos(phi))
    azRad = Math.atan2(sinAz, cosAz)
  }
  return { altDeg: altRad * 180 / Math.PI, azDeg: ((azRad * 180 / Math.PI) + 360) % 360 }
}

function classifyLight(relSunDeg: number, sunAlt: number): Pass['lighting'] {
  if (sunAlt < -2) return 'NIGHT'
  const a = Math.abs(((relSunDeg + 540) % 360) - 180)  // distance from "sun behind us" (0=ideal front-lit)
  if (a < 60) return 'FRONT'
  if (a < 120) return 'SIDE'
  return 'BACK'
}

const LIGHT_COLOR: Record<Pass['lighting'], string> = {
  FRONT: '#22c55e',
  SIDE: '#facc15',
  BACK: '#f97316',
  NIGHT: '#64748b',
}

function computePasses(flights: PassFlight[], obsLat: number, obsLng: number, horizonSec: number, maxSlantNm: number, minElevDeg: number): Pass[] {
  const now = new Date()
  const sun0 = solarPosition(now)
  const out: Pass[] = []
  for (const f of flights) {
    if (f.ground) continue
    if (!isFinite(f.lat) || !isFinite(f.lng)) continue
    if (f.velocityKts <= 0) continue
    // current displacement
    const { dN: dN0, dE: dE0 } = nmBetween(obsLat, obsLng, f.lat, f.lng)
    // velocity in nm/s
    const trkRad = (f.track || 0) * Math.PI / 180
    const vNm = f.velocityKts / 3600
    const vN = vNm * Math.cos(trkRad)
    const vE = vNm * Math.sin(trkRad)
    // CPA in ground plane: minimize |p0 + v*t|^2 => t = -(p0 . v)/(v.v)
    const vDot = vN * vN + vE * vE
    if (vDot < 1e-12) continue
    let tCpa = -(dN0 * vN + dE0 * vE) / vDot
    // if cpa already passed AND well behind, skip; allow small negative window for "just overhead"
    if (tCpa < -30) continue
    if (tCpa > horizonSec) continue
    if (tCpa < 0) tCpa = 0
    const dN = dN0 + vN * tCpa
    const dE = dE0 + vE * tCpa
    const groundNm = Math.sqrt(dN * dN + dE * dE)
    const altFt = Math.max(0, f.altitudeFt + (f.vertRate || 0) * (tCpa / 60))
    const altNm = altFt / 6076.12
    const slantNm = Math.sqrt(groundNm * groundNm + altNm * altNm)
    if (slantNm > maxSlantNm) continue
    const elevRad = Math.atan2(altNm, Math.max(0.001, groundNm))
    const elevDeg = elevRad * 180 / Math.PI
    if (elevDeg < minElevDeg) continue
    const azDeg = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360
    // sun at CPA time (sub-position drifts ~15 deg/hr -> small offset for short horizon, but apply)
    const futureSun = solarPosition(new Date(now.getTime() + tCpa * 1000))
    const sh = sunHorizon(obsLat, obsLng, futureSun.subLat, futureSun.subLng)
    // ideal photo: sun BEHIND observer pointing at plane => plane azimuth - sun azimuth + 180 == 0
    const rel = (((azDeg - sh.azDeg + 180) % 360) + 360) % 360 - 180
    const lighting = classifyLight(rel, sh.altDeg)
    // score
    const elevScore = Math.min(60, elevDeg) / 60      // peaks 60 deg
    const rangeScore = 1 - Math.min(1, slantNm / maxSlantNm)
    const lightScore = lighting === 'FRONT' ? 1 : lighting === 'SIDE' ? 0.55 : lighting === 'BACK' ? 0.2 : 0.1
    const sunBoost = sh.altDeg > 5 ? 1 : sh.altDeg > -2 ? 0.6 : 0.25
    const score = Math.round(100 * (0.35 * elevScore + 0.25 * rangeScore + 0.30 * lightScore + 0.10 * sunBoost))
    out.push({
      flight: f, tCpaSec: tCpa, slantNm, groundNm, elevationDeg: elevDeg, azimuthDeg: azDeg,
      sunAzDeg: sh.azDeg, sunAltDeg: sh.altDeg, relSunDeg: rel, lighting, score,
    })
    void sun0
  }
  out.sort((a, b) => (b.score - a.score) || (a.tCpaSec - b.tCpaSec))
  return out
}

export default function PassPredictor({ flights, centerLat, centerLng, onClose, onFly }: Props) {
  const [useGeo, setUseGeo] = useState(false)
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null)
  const [horizonMin, setHorizonMin] = useState(15)
  const [maxSlantNm, setMaxSlantNm] = useState(40)
  const [minElevDeg, setMinElevDeg] = useState(5)
  const [search, setSearch] = useState('')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!useGeo) return
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      p => setGeo({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => setUseGeo(false),
      { enableHighAccuracy: false, timeout: 5000, maximumAge: 60_000 },
    )
  }, [useGeo])

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 4000)
    return () => clearInterval(id)
  }, [])

  const obsLat = useGeo && geo ? geo.lat : centerLat
  const obsLng = useGeo && geo ? geo.lng : centerLng

  const allPasses = useMemo(
    () => computePasses(flights, obsLat, obsLng, horizonMin * 60, maxSlantNm, minElevDeg),
    [flights, obsLat, obsLng, horizonMin, maxSlantNm, minElevDeg, tick],
  )
  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase()
    if (!q) return allPasses
    return allPasses.filter(p =>
      p.flight.callsign?.toUpperCase().includes(q) ||
      p.flight.icao?.toUpperCase().includes(q) ||
      p.flight.type?.toUpperCase().includes(q) ||
      p.flight.operator?.toUpperCase().includes(q),
    )
  }, [allPasses, search])

  const counts = useMemo(() => {
    const c = { FRONT: 0, SIDE: 0, BACK: 0, NIGHT: 0 } as Record<Pass['lighting'], number>
    for (const p of allPasses) c[p.lighting]++
    return c
  }, [allPasses])

  // sky dome SVG: project elevation/azimuth onto disk (zenith=center, horizon=edge)
  const DOME = 220
  const R = DOME / 2 - 6
  const cx = DOME / 2, cy = DOME / 2
  const proj = (azDeg: number, elDeg: number) => {
    const r = R * (1 - Math.max(0, Math.min(90, elDeg)) / 90)
    const a = (azDeg - 90) * Math.PI / 180  // north up => -90 deg offset
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  }
  const sunNow = solarPosition(new Date())
  const sunHzn = sunHorizon(obsLat, obsLng, sunNow.subLat, sunNow.subLng)

  return (
    <div className="fixed top-20 right-4 z-40 w-[360px] max-h-[80vh] flex flex-col rounded-xl border border-white/10 bg-zinc-950/95 backdrop-blur shadow-2xl text-zinc-100 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-2">
          <span className="text-[10px] tracking-[0.2em] text-cyan-300/80">PASS PREDICTOR</span>
          <span className="text-zinc-500">overhead photo windows</span>
        </div>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 px-1">x</button>
      </div>

      <div className="px-3 py-2 border-b border-white/10 flex flex-col gap-2">
        <div className="flex items-center justify-between text-[10px] text-zinc-400">
          <span>OBS {obsLat.toFixed(3)}, {obsLng.toFixed(3)}</span>
          <button onClick={() => setUseGeo(v => !v)} className={`px-1.5 py-0.5 rounded border ${useGeo ? 'border-cyan-400 text-cyan-300' : 'border-white/15 text-zinc-300'}`}>
            {useGeo ? 'GEO' : 'CENTER'}
          </button>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="w-14 text-zinc-500">HORIZON</span>
          <input type="range" min={2} max={60} value={horizonMin} onChange={e => setHorizonMin(+e.target.value)} className="flex-1 accent-cyan-400" />
          <span className="w-10 text-right tabular-nums">{horizonMin}m</span>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="w-14 text-zinc-500">SLANT</span>
          <input type="range" min={5} max={120} value={maxSlantNm} onChange={e => setMaxSlantNm(+e.target.value)} className="flex-1 accent-cyan-400" />
          <span className="w-10 text-right tabular-nums">{maxSlantNm}nm</span>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="w-14 text-zinc-500">MIN ELEV</span>
          <input type="range" min={0} max={60} value={minElevDeg} onChange={e => setMinElevDeg(+e.target.value)} className="flex-1 accent-cyan-400" />
          <span className="w-10 text-right tabular-nums">{minElevDeg}deg</span>
        </div>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="filter callsign/type/operator..."
          className="w-full bg-zinc-900 border border-white/10 rounded px-2 py-1 text-[11px] placeholder:text-zinc-600 outline-none focus:border-cyan-500"
        />
      </div>

      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-center">
        <svg width={DOME} height={DOME} className="block">
          {/* horizon rings */}
          {[15, 30, 45, 60, 75].map(el => {
            const rr = R * (1 - el / 90)
            return <circle key={el} cx={cx} cy={cy} r={rr} fill="none" stroke="#27272a" strokeWidth={0.5} />
          })}
          <circle cx={cx} cy={cy} r={R} fill="#0a0a0a" stroke="#3f3f46" strokeWidth={1} />
          {/* cardinals */}
          {[['N',0],['E',90],['S',180],['W',270]].map(([lab, a]) => {
            const p = proj(a as number, 0)
            return <text key={lab as string} x={p.x} y={p.y} fill="#71717a" fontSize={9} textAnchor="middle" dy={lab === 'N' ? -2 : lab === 'S' ? 8 : 3}>{lab}</text>
          })}
          {/* sun */}
          {sunHzn.altDeg > -6 && (() => {
            const sp = proj(sunHzn.azDeg, Math.max(0, sunHzn.altDeg))
            return <g>
              <circle cx={sp.x} cy={sp.y} r={6} fill={sunHzn.altDeg > 0 ? '#facc15' : '#f97316'} opacity={0.85} />
              <circle cx={sp.x} cy={sp.y} r={10} fill="none" stroke="#facc15" strokeOpacity={0.3} />
              <text x={sp.x} y={sp.y + 16} fill="#facc15" fontSize={8} textAnchor="middle">SUN</text>
            </g>
          })()}
          {/* passes as track lines from current bearing(elev 0-ish) to CPA */}
          {filtered.slice(0, 30).map(p => {
            const cpa = proj(p.azimuthDeg, p.elevationDeg)
            return <g key={p.flight.icao}>
              <circle cx={cpa.x} cy={cpa.y} r={Math.max(2, Math.min(5, p.score / 20))} fill={LIGHT_COLOR[p.lighting]} opacity={0.9} />
            </g>
          })}
          {/* zenith */}
          <circle cx={cx} cy={cy} r={1.5} fill="#52525b" />
        </svg>
      </div>

      <div className="px-3 py-2 border-b border-white/10 grid grid-cols-4 gap-1 text-[10px]">
        {(['FRONT','SIDE','BACK','NIGHT'] as const).map(k => (
          <div key={k} className="rounded border border-white/10 px-1.5 py-1 text-center bg-zinc-900/60">
            <div className="text-zinc-500">{k}</div>
            <div className="font-mono text-sm" style={{ color: LIGHT_COLOR[k] }}>{counts[k]}</div>
          </div>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-zinc-500 text-[11px]">No predicted passes in window.</div>
        )}
        {filtered.map(p => {
          const f = p.flight
          const mm = Math.floor(p.tCpaSec / 60)
          const ss = Math.floor(p.tCpaSec % 60).toString().padStart(2, '0')
          return (
            <button
              key={f.icao}
              onClick={() => onFly(f.icao)}
              className="w-full text-left px-3 py-2 border-b border-white/5 hover:bg-white/5 flex items-center gap-2"
            >
              <div className="w-1 self-stretch rounded" style={{ background: LIGHT_COLOR[p.lighting] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[11px] text-zinc-100 truncate">{f.callsign || f.icao}</span>
                  <span className="text-[9px] px-1 rounded bg-zinc-800 text-zinc-400">{f.type || '-'}</span>
                  <span className="ml-auto text-[10px] font-mono" style={{ color: LIGHT_COLOR[p.lighting] }}>{p.score}</span>
                </div>
                <div className="text-[10px] text-zinc-500 truncate">{f.operator || ''}</div>
                <div className="flex items-center gap-2 text-[10px] text-zinc-400 mt-0.5 font-mono">
                  <span>T-{mm}:{ss}</span>
                  <span className="text-zinc-600">|</span>
                  <span>{p.elevationDeg.toFixed(0)}deg</span>
                  <span className="text-zinc-600">|</span>
                  <span>{p.slantNm.toFixed(1)}nm</span>
                  <span className="text-zinc-600">|</span>
                  <span>{fmtCompass(p.azimuthDeg)}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-white/10 text-[10px] text-zinc-500 flex items-center justify-between">
        <span>SUN alt {sunHzn.altDeg.toFixed(0)}deg az {fmtCompass(sunHzn.azDeg)}</span>
        <span>{allPasses.length} passes</span>
      </div>
    </div>
  )
}
