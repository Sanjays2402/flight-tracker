'use client'
import { useMemo } from 'react'

interface MiniFlight {
  icao: string
  callsign: string
  registration: string
  type: string
  operator: string
  lng: number
  lat: number
  altitudeFt: number
  track: number
  velocityKts: number
  ground: boolean
}

export interface FormationMember {
  icao: string
  callsign: string
  type: string
  operator: string
  lat: number
  lng: number
  altitudeFt: number
  track: number
  velocityKts: number
}

export interface Formation {
  id: string
  members: FormationMember[]
  leader: FormationMember          // most forward along avg track
  centerLat: number
  centerLng: number
  avgTrack: number
  avgAltFt: number
  avgSpeedKts: number
  spreadNm: number                 // max pairwise distance
  altSpreadFt: number
  trackSpreadDeg: number
  speedSpreadKts: number
  classification: 'tight' | 'loose' | 'echelon' | 'trail'
  militaryHint: boolean
}

const R_NM = 3440.065

function distNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = (lat1 * Math.PI) / 180, φ2 = (lat2 * Math.PI) / 180
  const dφ = ((lat2 - lat1) * Math.PI) / 180
  const dλ = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.sqrt(a))
}

function angDiff(a: number, b: number): number {
  let d = ((a - b) % 360 + 540) % 360 - 180
  return Math.abs(d)
}

// Vector mean of bearings
function meanBearing(deg: number[]): number {
  let sx = 0, sy = 0
  for (const d of deg) { const r = (d * Math.PI) / 180; sx += Math.cos(r); sy += Math.sin(r) }
  const a = Math.atan2(sy / deg.length, sx / deg.length) * 180 / Math.PI
  return (a + 360) % 360
}

const MIL_OPS = /AIR FORCE|NAVY|ARMY|MARINE|MILITARY|COAST GUARD|ROYAL AIR|RAF|USAF|USN|NATO|LUFTWAFFE/i
const MIL_CALL = /^(RCH|SHELL|TEXACO|EAGLE|REACH|SCALP|PAT|DUKE|CHAOS|VIPER|HOG|TREND|RAIDR|RAY|FORGE|NIGHT|GRIM|HAVOC|BAT|REDEYE|MAKO|SPAR|CONVOY|GULF|ROMA|EVAC|MAGMA|VADER|VENOM|HUSKY|JAKE|KING|HOMER|EVAC|EAGL|PILOT|PYTHON)/i

// Detect formations: clusters of >=2 aircraft moving with matched track/alt/speed within radius.
export function detectFormations(
  flights: MiniFlight[],
  opts: { maxRadiusNm: number; maxAltDiffFt: number; maxTrackDiffDeg: number; maxSpeedDiffKts: number; minMembers: number; includeGround: boolean }
): Formation[] {
  const usable = flights.filter(f => (opts.includeGround || !f.ground) && Number.isFinite(f.lat) && Number.isFinite(f.lng) && Number.isFinite(f.track) && f.velocityKts > 30)
  if (usable.length < opts.minMembers) return []

  // Union-find clustering on pairwise "in-formation" predicate
  const n = usable.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } ; return x }
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }

  // Spatial bucket for O(n) neighbor lookup at this scale
  const cell = Math.max(0.1, opts.maxRadiusNm / 60)  // deg
  const buckets = new Map<string, number[]>()
  const key = (la: number, ln: number) => `${Math.floor(la / cell)},${Math.floor(ln / cell)}`
  usable.forEach((f, i) => {
    const k = key(f.lat, f.lng)
    const arr = buckets.get(k); if (arr) arr.push(i); else buckets.set(k, [i])
  })

  for (let i = 0; i < n; i++) {
    const a = usable[i]
    const bla = Math.floor(a.lat / cell), bln = Math.floor(a.lng / cell)
    for (let dla = -1; dla <= 1; dla++) for (let dln = -1; dln <= 1; dln++) {
      const arr = buckets.get(`${bla + dla},${bln + dln}`); if (!arr) continue
      for (const j of arr) {
        if (j <= i) continue
        const b = usable[j]
        if (Math.abs(a.altitudeFt - b.altitudeFt) > opts.maxAltDiffFt) continue
        if (angDiff(a.track, b.track) > opts.maxTrackDiffDeg) continue
        if (Math.abs(a.velocityKts - b.velocityKts) > opts.maxSpeedDiffKts) continue
        const d = distNm(a.lat, a.lng, b.lat, b.lng)
        if (d > opts.maxRadiusNm) continue
        union(i, j)
      }
    }
  }

  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i); const arr = groups.get(r); if (arr) arr.push(i); else groups.set(r, [i])
  }

  const out: Formation[] = []
  for (const [, idxs] of groups) {
    if (idxs.length < opts.minMembers) continue
    const members: FormationMember[] = idxs.map(i => {
      const f = usable[i]
      return { icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator, lat: f.lat, lng: f.lng, altitudeFt: f.altitudeFt, track: f.track, velocityKts: f.velocityKts }
    })
    const centerLat = members.reduce((s, m) => s + m.lat, 0) / members.length
    const centerLng = members.reduce((s, m) => s + m.lng, 0) / members.length
    const avgTrack = meanBearing(members.map(m => m.track))
    const avgAltFt = members.reduce((s, m) => s + m.altitudeFt, 0) / members.length
    const avgSpeedKts = members.reduce((s, m) => s + m.velocityKts, 0) / members.length

    let spreadNm = 0
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
      const d = distNm(members[i].lat, members[i].lng, members[j].lat, members[j].lng)
      if (d > spreadNm) spreadNm = d
    }
    const alts = members.map(m => m.altitudeFt); const altSpreadFt = Math.max(...alts) - Math.min(...alts)
    const tracks = members.map(m => m.track)
    let trackSpreadDeg = 0
    for (let i = 0; i < tracks.length; i++) for (let j = i + 1; j < tracks.length; j++) {
      const d = angDiff(tracks[i], tracks[j]); if (d > trackSpreadDeg) trackSpreadDeg = d
    }
    const speeds = members.map(m => m.velocityKts); const speedSpreadKts = Math.max(...speeds) - Math.min(...speeds)

    // Leader: projection onto avg track vector from group center, max value wins
    const trRad = (avgTrack * Math.PI) / 180
    const ux = Math.sin(trRad), uy = Math.cos(trRad) // east, north components
    let leader = members[0], leaderScore = -Infinity
    for (const m of members) {
      const dx = (m.lng - centerLng) * Math.cos(centerLat * Math.PI / 180) * 60
      const dy = (m.lat - centerLat) * 60
      const score = dx * ux + dy * uy
      if (score > leaderScore) { leaderScore = score; leader = m }
    }

    // Classification heuristic
    let classification: Formation['classification'] = 'loose'
    // Compute lateral vs along-track spread for shape
    let alongMax = 0, lateralMax = 0
    for (const m of members) {
      const dx = (m.lng - centerLng) * Math.cos(centerLat * Math.PI / 180) * 60
      const dy = (m.lat - centerLat) * 60
      const along = Math.abs(dx * ux + dy * uy)
      const lateral = Math.abs(-dx * uy + dy * ux)
      if (along > alongMax) alongMax = along
      if (lateral > lateralMax) lateralMax = lateral
    }
    if (spreadNm < 1) classification = 'tight'
    else if (alongMax > lateralMax * 2 && members.length >= 2) classification = 'trail'
    else if (lateralMax > alongMax * 1.5) classification = 'echelon'
    else classification = 'loose'

    const militaryHint = members.some(m => MIL_OPS.test(m.operator || '') || MIL_CALL.test(m.callsign || ''))

    const id = members.map(m => m.icao).sort().join('-')
    out.push({ id, members, leader, centerLat, centerLng, avgTrack, avgAltFt, avgSpeedKts, spreadNm, altSpreadFt, trackSpreadDeg, speedSpreadKts, classification, militaryHint })
  }

  // Largest, then tightest
  out.sort((a, b) => b.members.length - a.members.length || a.spreadNm - b.spreadNm)
  return out
}

export default function FormationPanel(props: {
  formations: Formation[]
  maxRadiusNm: number
  maxAltDiffFt: number
  maxTrackDiffDeg: number
  maxSpeedDiffKts: number
  minMembers: number
  includeGround: boolean
  onChangeRadius: (v: number) => void
  onChangeAlt: (v: number) => void
  onChangeTrack: (v: number) => void
  onChangeSpeed: (v: number) => void
  onChangeMin: (v: number) => void
  onChangeGround: (v: boolean) => void
  onSelectFormation: (id: string) => void
  onSelectMember: (icao: string) => void
  onClose: () => void
}) {
  const { formations } = props
  const summary = useMemo(() => {
    const planes = formations.reduce((s, f) => s + f.members.length, 0)
    const mil = formations.filter(f => f.militaryHint).length
    const tight = formations.filter(f => f.classification === 'tight').length
    return { groups: formations.length, planes, mil, tight }
  }, [formations])

  const CLASS_COLOR: Record<Formation['classification'], string> = {
    tight: 'text-rose-300 border-rose-500/50',
    echelon: 'text-violet-300 border-violet-500/50',
    trail: 'text-cyan-300 border-cyan-500/50',
    loose: 'text-emerald-300 border-emerald-500/50',
  }

  return (
    <div className="absolute top-20 right-4 z-30 w-96 max-h-[calc(100vh-7rem)] bg-slate-950/92 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between bg-gradient-to-r from-rose-500/10 to-transparent">
        <div>
          <div className="text-xs uppercase tracking-widest text-rose-300 font-semibold">Formation Flights</div>
          <div className="text-[10px] text-slate-500 mt-0.5">Co-altitude, co-heading cluster detector</div>
        </div>
        <button onClick={props.onClose} className="text-slate-500 hover:text-slate-100 text-lg leading-none">✕</button>
      </div>

      <div className="px-4 py-3 border-b border-slate-800 grid grid-cols-4 gap-2 text-center">
        <Stat label="Groups" value={String(summary.groups)} accent="text-rose-300" />
        <Stat label="Planes" value={String(summary.planes)} />
        <Stat label="Mil" value={String(summary.mil)} accent="text-amber-300" />
        <Stat label="Tight" value={String(summary.tight)} />
      </div>

      <div className="px-4 py-3 border-b border-slate-800 space-y-2 text-[11px]">
        <Slider label="Max radius" value={props.maxRadiusNm} min={0.2} max={10} step={0.2} unit=" nm" onChange={props.onChangeRadius} />
        <Slider label="Max alt diff" value={props.maxAltDiffFt} min={100} max={5000} step={100} unit=" ft" onChange={props.onChangeAlt} />
        <Slider label="Max track diff" value={props.maxTrackDiffDeg} min={5} max={60} step={1} unit="°" onChange={props.onChangeTrack} />
        <Slider label="Max speed diff" value={props.maxSpeedDiffKts} min={5} max={100} step={5} unit=" kt" onChange={props.onChangeSpeed} />
        <Slider label="Min members" value={props.minMembers} min={2} max={6} step={1} unit="" onChange={props.onChangeMin} />
        <label className="flex items-center gap-2 text-slate-400 cursor-pointer">
          <input type="checkbox" checked={props.includeGround} onChange={e => props.onChangeGround(e.target.checked)} className="accent-rose-400" />
          <span>Include ground traffic</span>
        </label>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-slate-900">
        {formations.length === 0 && (
          <div className="px-4 py-10 text-center text-xs text-slate-500">
            No formations detected.<br />
            <span className="text-slate-600">Loosen thresholds — true formations are rare.</span>
          </div>
        )}
        {formations.slice(0, 30).map(f => (
          <div key={f.id} className="px-4 py-3 hover:bg-slate-900/40 transition">
            <button onClick={() => props.onSelectFormation(f.id)} className="w-full text-left">
              <div className="flex items-center gap-2">
                <div className={`px-1.5 py-0.5 rounded border text-[10px] uppercase font-semibold ${CLASS_COLOR[f.classification]}`}>{f.classification}</div>
                <div className="text-sm font-bold text-slate-100">{f.members.length} aircraft</div>
                {f.militaryHint && <div className="px-1.5 py-0.5 rounded border border-amber-500/50 text-amber-300 text-[10px] font-semibold">MIL</div>}
                <div className="ml-auto text-[10px] text-slate-500 font-mono">{f.spreadNm.toFixed(2)}nm</div>
              </div>
              <div className="text-[10px] text-slate-400 mt-1 flex gap-3 font-mono">
                <span>HDG {Math.round(f.avgTrack).toString().padStart(3, '0')}°</span>
                <span>FL{Math.round(f.avgAltFt / 100).toString().padStart(3, '0')}</span>
                <span>{Math.round(f.avgSpeedKts)}kt</span>
                <span className="text-slate-600">Δalt {Math.round(f.altSpreadFt)}ft</span>
              </div>
            </button>
            <div className="mt-2 flex flex-wrap gap-1">
              {f.members.map(m => (
                <button
                  key={m.icao}
                  onClick={(e) => { e.stopPropagation(); props.onSelectMember(m.icao) }}
                  className={`px-1.5 py-0.5 text-[10px] font-mono rounded border transition ${m.icao === f.leader.icao ? 'border-rose-500/70 text-rose-200 bg-rose-500/10' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}
                  title={`${m.type || '—'} · ${m.operator || '—'}`}
                >
                  {m.icao === f.leader.icao ? '★ ' : ''}{m.callsign || m.icao}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Stat(props: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-slate-500">{props.label}</div>
      <div className={`text-lg font-bold ${props.accent || 'text-slate-200'}`}>{props.value}</div>
    </div>
  )
}

function Slider(props: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <div className="flex justify-between text-slate-400">
        <span>{props.label}</span>
        <span className="font-mono text-rose-300">{props.value}{props.unit}</span>
      </div>
      <input
        type="range" min={props.min} max={props.max} step={props.step} value={props.value}
        onChange={e => props.onChange(Number(e.target.value))}
        className="w-full accent-rose-400"
      />
    </label>
  )
}
