'use client'
import { useMemo, useState } from 'react'

export type CpaFlight = {
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

export type CpaHit = {
  a: CpaFlight
  b: CpaFlight
  /** seconds from now until closest point of approach */
  ttcSec: number
  /** predicted lateral miss distance at CPA, nm */
  missNm: number
  /** predicted vertical miss at CPA, ft */
  missFt: number
  /** current lateral separation, nm */
  curNm: number
  /** current vertical separation, ft */
  curFt: number
  /** predicted positions at CPA */
  aLat: number; aLng: number
  bLat: number; bLng: number
  midLat: number; midLng: number
  severity: 'imminent' | 'critical' | 'warning' | 'advisory'
  /** unique stable id */
  id: string
}

const R_NM = 3440.065
const FT_PER_NM = 6076.12
const EARTH_M = 6_371_000

// Equirectangular -> local ENU meters around a reference latitude.
// Plenty accurate for CPA windows of a few minutes.
function flatXYm(lat: number, lng: number, refLat: number, refLng: number): [number, number] {
  const toR = Math.PI / 180
  const x = (lng - refLng) * toR * Math.cos(refLat * toR) * EARTH_M
  const y = (lat - refLat) * toR * EARTH_M
  return [x, y]
}
function backToLatLng(x: number, y: number, refLat: number, refLng: number): [number, number] {
  const toR = Math.PI / 180
  const lat = refLat + (y / EARTH_M) / toR
  const lng = refLng + (x / (EARTH_M * Math.cos(refLat * toR))) / toR
  return [lat, lng]
}
function velMs(kts: number, trackDeg: number): [number, number] {
  // x=east, y=north; track=0 -> +y; clockwise.
  const v = kts * 0.514444
  const t = trackDeg * Math.PI / 180
  return [v * Math.sin(t), v * Math.cos(t)]
}

/**
 * Compute closest point of approach (CPA) for two aircraft using straight-line
 * extrapolation of current position + ground vector. CPA solved analytically.
 * Time clamped to [0, horizonSec]. Returns null if both are diverging the whole window.
 */
export function cpaPair(a: CpaFlight, b: CpaFlight, horizonSec: number): CpaHit | null {
  const refLat = (a.lat + b.lat) / 2
  const refLng = (a.lng + b.lng) / 2
  const [ax, ay] = flatXYm(a.lat, a.lng, refLat, refLng)
  const [bx, by] = flatXYm(b.lat, b.lng, refLat, refLng)
  const [avx, avy] = velMs(a.velocityKts, a.track)
  const [bvx, bvy] = velMs(b.velocityKts, b.track)
  const dx = ax - bx, dy = ay - by
  const dvx = avx - bvx, dvy = avy - bvy
  const vv = dvx * dvx + dvy * dvy
  let t = 0
  if (vv > 1e-6) {
    t = -(dx * dvx + dy * dvy) / vv
    if (t < 0) t = 0
    if (t > horizonSec) t = horizonSec
  }
  // positions at CPA
  const ax2 = ax + avx * t, ay2 = ay + avy * t
  const bx2 = bx + bvx * t, by2 = by + bvy * t
  const distM = Math.hypot(ax2 - bx2, ay2 - by2)
  const missNm = distM / 1852
  // altitude crossing
  const altA = a.altitudeFt + (a.vertRate / 60) * t
  const altB = b.altitudeFt + (b.vertRate / 60) * t
  const missFt = Math.abs(altA - altB)
  // current
  const curNm = Math.hypot(dx, dy) / 1852
  const curFt = Math.abs(a.altitudeFt - b.altitudeFt)
  const [aLat, aLng] = backToLatLng(ax2, ay2, refLat, refLng)
  const [bLat, bLng] = backToLatLng(bx2, by2, refLat, refLng)
  const midLat = (aLat + bLat) / 2
  const midLng = (aLng + bLng) / 2
  let severity: CpaHit['severity'] = 'advisory'
  if (missNm < 1 && missFt < 500 && t < 60) severity = 'imminent'
  else if (missNm < 3 && missFt < 1000) severity = 'critical'
  else if (missNm < 5 && missFt < 1500) severity = 'warning'
  const id = a.icao < b.icao ? `${a.icao}|${b.icao}` : `${b.icao}|${a.icao}`
  return { a, b, ttcSec: t, missNm, missFt, curNm, curFt, aLat, aLng, bLat, bLng, midLat, midLng, severity, id }
}

export function detectCpa(
  flights: CpaFlight[],
  opts: { horizonSec: number; maxMissNm: number; maxMissFt: number; includeGround: boolean; ignoreSameOperator: boolean }
): CpaHit[] {
  const eligible = flights.filter(f => (opts.includeGround || !f.ground) && Number.isFinite(f.lat) && Number.isFinite(f.lng) && Number.isFinite(f.track) && f.velocityKts > 30)
  // Spatial pre-filter: bucket by ~1deg cell, only test pairs within +-2 cells (about 120nm at the equator).
  const cells = new Map<string, CpaFlight[]>()
  for (const f of eligible) {
    const cx = Math.floor(f.lng), cy = Math.floor(f.lat)
    const key = `${cx},${cy}`
    let arr = cells.get(key); if (!arr) { arr = []; cells.set(key, arr) }
    arr.push(f)
  }
  const hits: CpaHit[] = []
  const seen = new Set<string>()
  for (const f of eligible) {
    const cx = Math.floor(f.lng), cy = Math.floor(f.lat)
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      const arr = cells.get(`${cx + dx},${cy + dy}`); if (!arr) continue
      for (const g of arr) {
        if (g.icao <= f.icao) continue
        if (opts.ignoreSameOperator && f.operator && g.operator && f.operator === g.operator) continue
        const id = `${f.icao}|${g.icao}`
        if (seen.has(id)) continue
        seen.add(id)
        // quick reject by current altitude difference if both stable
        if (Math.abs(f.altitudeFt - g.altitudeFt) > opts.maxMissFt + 5000) continue
        const hit = cpaPair(f, g, opts.horizonSec)
        if (!hit) continue
        if (hit.missNm > opts.maxMissNm) continue
        if (hit.missFt > opts.maxMissFt) continue
        hits.push(hit)
      }
    }
  }
  // sort by severity then time-to-CPA ascending
  const sevRank = { imminent: 0, critical: 1, warning: 2, advisory: 3 }
  hits.sort((p, q) => {
    const sd = sevRank[p.severity] - sevRank[q.severity]
    if (sd !== 0) return sd
    return p.ttcSec - q.ttcSec
  })
  return hits.slice(0, 80)
}

function fmtTime(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`
  const m = Math.floor(s / 60); const r = Math.round(s - m * 60)
  return `${m}m${r.toString().padStart(2, '0')}s`
}

const SEV_BG: Record<CpaHit['severity'], string> = {
  imminent: 'bg-rose-500/20 border-rose-400/60',
  critical: 'bg-orange-500/15 border-orange-400/50',
  warning: 'bg-amber-500/10 border-amber-400/40',
  advisory: 'bg-sky-500/10 border-sky-400/30',
}
const SEV_DOT: Record<CpaHit['severity'], string> = {
  imminent: 'bg-rose-400',
  critical: 'bg-orange-400',
  warning: 'bg-amber-400',
  advisory: 'bg-sky-400',
}

interface Props {
  hits: CpaHit[]
  horizonSec: number
  maxMissNm: number
  maxMissFt: number
  includeGround: boolean
  ignoreSameOperator: boolean
  onChangeHorizon: (v: number) => void
  onChangeMissNm: (v: number) => void
  onChangeMissFt: (v: number) => void
  onChangeGround: (v: boolean) => void
  onChangeSameOp: (v: boolean) => void
  onSelectPair: (hit: CpaHit) => void
  onSelectIcao: (icao: string) => void
  onClose: () => void
}

export default function CpaPanel(p: Props) {
  const [filter, setFilter] = useState('')
  const counts = useMemo(() => {
    const c = { imminent: 0, critical: 0, warning: 0, advisory: 0 }
    for (const h of p.hits) c[h.severity]++
    return c
  }, [p.hits])
  const filtered = useMemo(() => {
    const q = filter.trim().toUpperCase()
    if (!q) return p.hits
    return p.hits.filter(h =>
      h.a.callsign.toUpperCase().includes(q) || h.b.callsign.toUpperCase().includes(q) ||
      h.a.operator.toUpperCase().includes(q) || h.b.operator.toUpperCase().includes(q) ||
      h.a.type.toUpperCase().includes(q) || h.b.type.toUpperCase().includes(q)
    )
  }, [p.hits, filter])

  return (
    <div className="absolute top-16 right-2 w-[360px] max-h-[80vh] bg-slate-900/95 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl text-white flex flex-col overflow-hidden z-30">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${counts.imminent ? 'bg-rose-400 animate-pulse' : 'bg-emerald-400'}`} />
          <h3 className="text-sm font-semibold tracking-wide">CPA PREDICTOR</h3>
          <span className="text-[10px] text-slate-400">TCAS-style</span>
        </div>
        <button onClick={p.onClose} className="text-slate-400 hover:text-white text-lg leading-none px-1">×</button>
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 text-[10px] border-b border-white/10">
        <div className="bg-rose-500/15 border border-rose-400/40 rounded px-1.5 py-1 text-center">
          <div className="text-rose-300 font-bold text-sm">{counts.imminent}</div>
          <div className="text-rose-200/70">IMMINENT</div>
        </div>
        <div className="bg-orange-500/10 border border-orange-400/30 rounded px-1.5 py-1 text-center">
          <div className="text-orange-300 font-bold text-sm">{counts.critical}</div>
          <div className="text-orange-200/70">CRIT</div>
        </div>
        <div className="bg-amber-500/10 border border-amber-400/30 rounded px-1.5 py-1 text-center">
          <div className="text-amber-300 font-bold text-sm">{counts.warning}</div>
          <div className="text-amber-200/70">WARN</div>
        </div>
        <div className="bg-sky-500/10 border border-sky-400/30 rounded px-1.5 py-1 text-center">
          <div className="text-sky-300 font-bold text-sm">{counts.advisory}</div>
          <div className="text-sky-200/70">ADV</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-white/10 space-y-2 text-[11px]">
        <label className="flex items-center justify-between gap-2">
          <span className="text-slate-300">Horizon</span>
          <span className="text-slate-400 tabular-nums">{Math.round(p.horizonSec / 60)} min</span>
        </label>
        <input type="range" min={60} max={900} step={30} value={p.horizonSec} onChange={e => p.onChangeHorizon(parseInt(e.target.value))} className="w-full accent-rose-400" />
        <label className="flex items-center justify-between gap-2">
          <span className="text-slate-300">Max miss (lateral)</span>
          <span className="text-slate-400 tabular-nums">{p.maxMissNm.toFixed(1)} nm</span>
        </label>
        <input type="range" min={0.5} max={20} step={0.5} value={p.maxMissNm} onChange={e => p.onChangeMissNm(parseFloat(e.target.value))} className="w-full accent-rose-400" />
        <label className="flex items-center justify-between gap-2">
          <span className="text-slate-300">Max miss (vertical)</span>
          <span className="text-slate-400 tabular-nums">{p.maxMissFt} ft</span>
        </label>
        <input type="range" min={200} max={5000} step={100} value={p.maxMissFt} onChange={e => p.onChangeMissFt(parseInt(e.target.value))} className="w-full accent-rose-400" />
        <div className="flex items-center gap-3 pt-1">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={p.includeGround} onChange={e => p.onChangeGround(e.target.checked)} className="accent-rose-400" />
            <span className="text-slate-300">Include ground</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={p.ignoreSameOperator} onChange={e => p.onChangeSameOp(e.target.checked)} className="accent-rose-400" />
            <span className="text-slate-300">Skip same operator</span>
          </label>
        </div>
        <input
          value={filter} onChange={e => setFilter(e.target.value)}
          placeholder="filter callsign / operator / type"
          className="w-full bg-slate-800 border border-white/10 rounded px-2 py-1 text-[11px] text-white placeholder-slate-500"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-slate-500 text-xs">No predicted conflicts in window</div>
        ) : (
          <ul className="divide-y divide-white/5">
            {filtered.map(h => (
              <li key={h.id}>
                <button onClick={() => p.onSelectPair(h)} className={`w-full text-left px-3 py-2 hover:bg-white/5 border-l-2 ${SEV_BG[h.severity]} transition`}>
                  <div className="flex items-center justify-between text-[11px]">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className={`inline-block w-1.5 h-1.5 rounded-full ${SEV_DOT[h.severity]}`} />
                      <span className="font-mono font-semibold truncate">{h.a.callsign || h.a.icao}</span>
                      <span className="text-slate-500">×</span>
                      <span className="font-mono font-semibold truncate">{h.b.callsign || h.b.icao}</span>
                    </div>
                    <span className="text-rose-200 tabular-nums font-semibold">{fmtTime(h.ttcSec)}</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-slate-400 mt-1 tabular-nums">
                    <span>miss <span className="text-white">{h.missNm.toFixed(1)}nm</span> / <span className="text-white">{Math.round(h.missFt)}ft</span></span>
                    <span>now <span className="text-slate-300">{h.curNm.toFixed(1)}nm</span></span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-slate-500 mt-0.5">
                    <button onClick={(e) => { e.stopPropagation(); p.onSelectIcao(h.a.icao) }} className="hover:text-sky-300 truncate">{h.a.type || '—'} · {h.a.operator || '—'}</button>
                    <span>·</span>
                    <button onClick={(e) => { e.stopPropagation(); p.onSelectIcao(h.b.icao) }} className="hover:text-sky-300 truncate">{h.b.type || '—'} · {h.b.operator || '—'}</button>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-white/10 text-[10px] text-slate-500 flex justify-between">
        <span>Straight-line projection · no turn intent</span>
        <span>{p.hits.length} hits</span>
      </div>
    </div>
  )
}
