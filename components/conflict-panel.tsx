'use client'
import { useMemo, useState } from 'react'

export type ConflictFlight = {
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

export type ConflictPair = {
  a: ConflictFlight
  b: ConflictFlight
  lateralNm: number
  verticalFt: number
  closingKts: number
  severity: 'critical' | 'warning' | 'advisory'
  midLat: number
  midLng: number
}

const R_NM = 3440.065
function haversineNm(a: ConflictFlight, b: ConflictFlight): number {
  const toR = Math.PI / 180
  const dLat = (b.lat - a.lat) * toR
  const dLng = (b.lng - a.lng) * toR
  const la1 = a.lat * toR, la2 = b.lat * toR
  const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/* Approx closing speed: project both velocity vectors onto the line connecting them. */
function closingKts(a: ConflictFlight, b: ConflictFlight): number {
  const toR = Math.PI / 180
  // bearing a->b
  const dLng = (b.lng - a.lng) * toR
  const la1 = a.lat * toR, la2 = b.lat * toR
  const y = Math.sin(dLng) * Math.cos(la2)
  const x = Math.cos(la1)*Math.sin(la2) - Math.sin(la1)*Math.cos(la2)*Math.cos(dLng)
  const brgAB = Math.atan2(y, x) / toR // degrees
  // velocity component of A along bearing A->B (positive = moving toward B)
  const compA = a.velocityKts * Math.cos((a.track - brgAB) * toR)
  // velocity component of B along bearing B->A (positive = toward A)
  const brgBA = (brgAB + 180) % 360
  const compB = b.velocityKts * Math.cos((b.track - brgBA) * toR)
  return compA + compB
}

export function detectConflicts(
  flights: ConflictFlight[],
  latNm: number,
  vertFt: number,
  includeGround: boolean,
): ConflictPair[] {
  const pool = flights.filter(f => includeGround || !f.ground)
  // Grid bucket by ~0.5deg for O(n) neighbor lookups
  const grid = new Map<string, ConflictFlight[]>()
  const key = (la: number, lo: number) => `${Math.floor(la*2)},${Math.floor(lo*2)}`
  for (const f of pool) {
    const k = key(f.lat, f.lng)
    const arr = grid.get(k); if (arr) arr.push(f); else grid.set(k, [f])
  }
  const out: ConflictPair[] = []
  const seen = new Set<string>()
  for (const f of pool) {
    const baseLa = Math.floor(f.lat*2), baseLo = Math.floor(f.lng*2)
    for (let dla = -1; dla <= 1; dla++) {
      for (let dlo = -1; dlo <= 1; dlo++) {
        const nbrs = grid.get(`${baseLa+dla},${baseLo+dlo}`)
        if (!nbrs) continue
        for (const g of nbrs) {
          if (f.icao >= g.icao) continue
          const pairKey = `${f.icao}|${g.icao}`
          if (seen.has(pairKey)) continue
          const dv = Math.abs(f.altitudeFt - g.altitudeFt)
          if (dv > vertFt) continue
          const dl = haversineNm(f, g)
          if (dl > latNm) continue
          seen.add(pairKey)
          const cl = closingKts(f, g)
          let severity: ConflictPair['severity'] = 'advisory'
          if (dl < latNm * 0.4 && dv < vertFt * 0.4) severity = 'critical'
          else if (dl < latNm * 0.7 && dv < vertFt * 0.7) severity = 'warning'
          out.push({
            a: f, b: g,
            lateralNm: dl, verticalFt: dv, closingKts: cl,
            severity,
            midLat: (f.lat + g.lat) / 2,
            midLng: (f.lng + g.lng) / 2,
          })
        }
      }
    }
  }
  // Sort: critical first, then by lateral distance ascending
  const sevRank = { critical: 0, warning: 1, advisory: 2 }
  out.sort((x, y) => {
    if (sevRank[x.severity] !== sevRank[y.severity]) return sevRank[x.severity] - sevRank[y.severity]
    return x.lateralNm - y.lateralNm
  })
  return out.slice(0, 200)
}

type Props = {
  pairs: ConflictPair[]
  latNm: number
  vertFt: number
  includeGround: boolean
  onChange: (next: { latNm?: number; vertFt?: number; includeGround?: boolean }) => void
  onSelect?: (icao: string) => void
  onZoomPair?: (p: ConflictPair) => void
  onClose: () => void
}

const SEV_COLOR: Record<ConflictPair['severity'], string> = {
  critical: 'text-rose-400 border-rose-500/40 bg-rose-500/10',
  warning: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
  advisory: 'text-sky-300 border-sky-500/40 bg-sky-500/10',
}

export default function ConflictPanel({ pairs, latNm, vertFt, includeGround, onChange, onSelect, onZoomPair, onClose }: Props) {
  const [tab, setTab] = useState<'all' | 'critical' | 'warning' | 'advisory'>('all')
  const counts = useMemo(() => ({
    all: pairs.length,
    critical: pairs.filter(p => p.severity === 'critical').length,
    warning: pairs.filter(p => p.severity === 'warning').length,
    advisory: pairs.filter(p => p.severity === 'advisory').length,
  }), [pairs])
  const shown = useMemo(() => tab === 'all' ? pairs : pairs.filter(p => p.severity === tab), [pairs, tab])

  return (
    <div className="absolute top-20 right-3 md:right-4 z-30 w-[360px] max-w-[calc(100vw-1.5rem)] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 flex flex-col" style={{ maxHeight: 'calc(100vh - 7rem)' }}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Conflict Detector</div>
          <div className="text-sm font-semibold flex items-center gap-2">
            Proximity scan
            {counts.critical > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40 animate-pulse">{counts.critical} CRIT</span>}
          </div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">×</button>
      </div>

      <div className="px-4 py-3 border-b border-slate-800 grid grid-cols-2 gap-3 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-widest text-slate-500">Lateral · {latNm} nm</span>
          <input type="range" min={1} max={20} step={1} value={latNm}
            onChange={e => onChange({ latNm: Number(e.target.value) })}
            className="accent-sky-500" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-widest text-slate-500">Vertical · {vertFt} ft</span>
          <input type="range" min={500} max={5000} step={500} value={vertFt}
            onChange={e => onChange({ vertFt: Number(e.target.value) })}
            className="accent-sky-500" />
        </label>
        <label className="col-span-2 flex items-center gap-2 text-slate-300">
          <input type="checkbox" checked={includeGround} onChange={e => onChange({ includeGround: e.target.checked })}
            className="accent-sky-500" />
          <span>Include ground traffic</span>
        </label>
      </div>

      <div className="flex gap-1 px-3 pt-2 text-[11px]">
        {(['all', 'critical', 'warning', 'advisory'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 px-2 py-1 rounded-md uppercase tracking-wider border transition ${tab === t ? 'border-sky-500/60 bg-sky-500/15 text-sky-200' : 'border-slate-800 text-slate-400 hover:text-slate-200'}`}>
            {t} <span className="text-slate-500">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {shown.length === 0 && (
          <div className="text-xs text-slate-500 text-center py-8">
            No conflicting pairs in view.<br/>
            <span className="text-slate-600">Widen the thresholds to see advisories.</span>
          </div>
        )}
        {shown.map((p, i) => (
          <div key={`${p.a.icao}-${p.b.icao}-${i}`}
            className={`rounded-lg border p-2 text-[11px] ${SEV_COLOR[p.severity]}`}>
            <div className="flex items-center justify-between">
              <span className="text-[9px] uppercase tracking-widest opacity-80">{p.severity}</span>
              <button onClick={() => onZoomPair?.(p)}
                className="text-[9px] uppercase tracking-widest text-slate-300 hover:text-white border border-slate-700/60 rounded px-1.5 py-0.5">
                Zoom
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-1.5">
              {[p.a, p.b].map((f, idx) => (
                <button key={f.icao} onClick={() => onSelect?.(f.icao)}
                  className="text-left bg-slate-900/60 hover:bg-slate-900 rounded-md p-1.5 border border-slate-800/60">
                  <div className="font-mono font-semibold text-slate-100 truncate">{f.callsign || f.icao.toUpperCase()}</div>
                  <div className="text-slate-400 truncate">{f.operator || f.type || '—'}</div>
                  <div className="text-slate-500 mt-0.5">
                    {Math.round(f.altitudeFt).toLocaleString()} ft · {Math.round(f.velocityKts)} kt
                    {f.vertRate ? <span className={f.vertRate > 0 ? ' text-emerald-400' : ' text-rose-400'}> {f.vertRate > 0 ? '↑' : '↓'}{Math.abs(Math.round(f.vertRate))}</span> : null}
                  </div>
                </button>
              ))}
            </div>
            <div className="mt-1.5 flex justify-between text-slate-300/80">
              <span>Δ lat <b className="text-slate-100">{p.lateralNm.toFixed(1)} nm</b></span>
              <span>Δ alt <b className="text-slate-100">{Math.round(p.verticalFt).toLocaleString()} ft</b></span>
              <span className={p.closingKts > 50 ? 'text-rose-300' : p.closingKts > 0 ? 'text-amber-300' : 'text-emerald-300'}>
                {p.closingKts > 0 ? 'closing' : 'opening'} {Math.abs(Math.round(p.closingKts))} kt
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="px-4 py-2 border-t border-slate-800 text-[10px] text-slate-500">
        Heuristic only · ADS-B sample lag · not for separation use
      </div>
    </div>
  )
}
