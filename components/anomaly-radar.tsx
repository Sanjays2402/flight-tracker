'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Anomaly Radar
   -----------------------------------------------------------
   Tick-to-tick state-delta tracker. For every aircraft we keep
   the previous snapshot (pos, alt, track, gs, vs, squawk, ts)
   and on every refresh diff against the new snapshot to detect:

     JUMP    - great-circle distance / dt exceeds 1.5x current GS
               (telemetry hiccup, position fix flip, MLAT glitch)
     SWERVE  - track delta > N deg/sec (sudden turn / evasion)
     SPIKE   - abs vertical-rate change > N fpm/sec (sudden pitch)
     DASH    - ground-speed delta > N kt/sec (rapid accel/decel)
     FLIP    - vertical-rate sign change while > 500 fpm (level-off
               that overshoots into the opposite direction)
     SQUAWK  - transponder code changed; weighted heavier when the
               new code is emergency 7500/7600/7700 or military
     ALT-REV - altitude derivative sign change beyond 200ft band
               (cleared-descent reversed to climb mid-leg)

   Each event is scored 0-100 by magnitude over threshold, tagged
   with a severity (CRITICAL/HIGH/MEDIUM/LOW) and timestamped.
   Side panel shows live counters, severity filter, kind chips,
   tunable thresholds, rolling 250-deep event feed with click-to-fly,
   AND a per-aircraft "hot list" ranked by cumulative score across
   the last N minutes (decayed). MapLibre overlay paints pulsing
   severity-colored rings around aircraft with a recent anomaly.
   ============================================================ */

export interface ArFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  vertRate?: number
  squawk?: string
  ground: boolean
  emergency?: boolean
  military?: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: ArFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Kind = 'JUMP' | 'SWERVE' | 'SPIKE' | 'DASH' | 'FLIP' | 'SQUAWK' | 'ALT-REV'
type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

interface Anomaly {
  id: string
  t: number
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  kind: Kind
  severity: Severity
  score: number    // 0..100
  detail: string   // human-readable magnitude
}

const KIND_COLOR: Record<Kind, string> = {
  JUMP:    '#a78bfa',
  SWERVE:  '#f97316',
  SPIKE:   '#22d3ee',
  DASH:    '#facc15',
  FLIP:    '#ec4899',
  SQUAWK:  '#ef4444',
  'ALT-REV': '#10b981',
}
const KIND_ORDER: Kind[] = ['SQUAWK', 'JUMP', 'SWERVE', 'SPIKE', 'FLIP', 'DASH', 'ALT-REV']

const SEV_COLOR: Record<Severity, string> = {
  CRITICAL: '#ef4444',
  HIGH:     '#f97316',
  MEDIUM:   '#facc15',
  LOW:      '#94a3b8',
}
const SEV_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']

const SRC = 'ar-ring-src'
const LYR_HALO = 'ar-ring-halo'
const LYR_RING = 'ar-ring-ring'
const LYR_LBL = 'ar-ring-lbl'

const toRad = (d: number) => (d * Math.PI) / 180

function nmBetween(lat1: number, lng1: number, lat2: number, lng2: number) {
  // great-circle haversine in nautical miles
  const R = 3440.065
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function sevFromScore(s: number): Severity {
  if (s >= 75) return 'CRITICAL'
  if (s >= 50) return 'HIGH'
  if (s >= 25) return 'MEDIUM'
  return 'LOW'
}

const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700'])
const SPECIAL_SQUAWKS = new Set(['7777', '7400'])

interface Prev {
  t: number
  lat: number
  lng: number
  alt: number
  gs: number
  track: number
  vs: number
  squawk?: string
}

export default function AnomalyRadar({ map, flights, onClose, onFly }: Props) {
  const prevRef = useRef<Map<string, Prev>>(new Map())
  const [events, setEvents] = useState<Anomaly[]>([])
  const [enabledKinds, setEnabledKinds] = useState<Set<Kind>>(new Set(KIND_ORDER))
  const [minSeverity, setMinSeverity] = useState<Severity>('LOW')
  const [query, setQuery] = useState('')
  const [showOverlay, setShowOverlay] = useState(true)
  const [paused, setPaused] = useState(false)
  const [tab, setTab] = useState<'FEED' | 'HOT'>('FEED')
  // tunables
  const [thSwerve, setThSwerve] = useState(8)    // deg/sec
  const [thSpike, setThSpike] = useState(1500)   // fpm/sec
  const [thDash, setThDash] = useState(8)        // kt/sec
  const [thJumpMul, setThJumpMul] = useState(1.5) // x current GS expressed as nm/sec ratio

  // ---------------- diff engine ----------------
  useEffect(() => {
    if (paused) { return }
    const now = Date.now()
    const next = new Map<string, Prev>()
    const newAnomalies: Anomaly[] = []

    for (const f of flights) {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      const cur: Prev = {
        t: now,
        lat: f.lat,
        lng: f.lng,
        alt: f.altitudeFt ?? 0,
        gs: f.velocityKts ?? 0,
        track: f.track ?? 0,
        vs: f.vertRate ?? 0,
        squawk: f.squawk,
      }
      next.set(f.icao, cur)

      const prev = prevRef.current.get(f.icao)
      if (!prev) continue
      const dt = (now - prev.t) / 1000
      if (dt < 0.5 || dt > 60) continue // sane window

      const push = (kind: Kind, score: number, detail: string) => {
        if (!enabledKinds.has(kind)) return
        score = Math.max(0, Math.min(100, Math.round(score)))
        const sev = sevFromScore(score)
        if (SEV_ORDER.indexOf(sev) > SEV_ORDER.indexOf(minSeverity)) return
        newAnomalies.push({
          id: `${f.icao}-${kind}-${now}-${Math.random().toString(36).slice(2, 6)}`,
          t: now, icao: f.icao, callsign: f.callsign, type: f.type, operator: f.operator,
          lat: f.lat, lng: f.lng, kind, severity: sev, score, detail,
        })
      }

      // SQUAWK change
      if (cur.squawk && prev.squawk && cur.squawk !== prev.squawk) {
        const isEmerg = EMERGENCY_SQUAWKS.has(cur.squawk)
        const isSpecial = SPECIAL_SQUAWKS.has(cur.squawk) || (cur.squawk[0] >= '4' && cur.squawk[0] <= '6')
        const score = isEmerg ? 100 : (isSpecial ? 60 : 30)
        push('SQUAWK', score, `${prev.squawk}\u2192${cur.squawk}${isEmerg ? ' EMERG' : ''}`)
      }

      // JUMP: position step exceeds physical plausibility (nm vs GS-derived expected dist)
      const distNm = nmBetween(prev.lat, prev.lng, cur.lat, cur.lng)
      const expected = (Math.max(prev.gs, cur.gs) / 3600) * dt
      if (expected > 0.001) {
        const ratio = distNm / expected
        if (ratio > thJumpMul) {
          const score = Math.min(100, (ratio - thJumpMul) * 40 + 30)
          push('JUMP', score, `${distNm.toFixed(2)}nm in ${dt.toFixed(1)}s (${ratio.toFixed(1)}x)`)
        }
      }

      // SWERVE: track delta per second (handle wrap)
      let dTrack = cur.track - prev.track
      if (dTrack > 180) dTrack -= 360
      if (dTrack < -180) dTrack += 360
      const trackPerSec = Math.abs(dTrack) / dt
      if (trackPerSec > thSwerve && cur.gs > 50) {
        const score = Math.min(100, (trackPerSec - thSwerve) * 8 + 30)
        push('SWERVE', score, `${trackPerSec.toFixed(1)}\u00b0/s (\u0394${Math.round(dTrack)}\u00b0)`)
      }

      // SPIKE: vertical-rate magnitude change per second
      const dVs = Math.abs(cur.vs - prev.vs) / dt
      if (dVs > thSpike) {
        const score = Math.min(100, (dVs - thSpike) / 30 + 30)
        push('SPIKE', score, `\u0394VS ${Math.round(dVs)} fpm/s`)
      }

      // DASH: ground-speed delta per second
      const dGs = Math.abs(cur.gs - prev.gs) / dt
      if (dGs > thDash && !f.ground) {
        const score = Math.min(100, (dGs - thDash) * 5 + 30)
        push('DASH', score, `\u0394GS ${dGs.toFixed(1)} kt/s`)
      }

      // FLIP: VS sign reversal while magnitudes both > 500 fpm
      if (Math.abs(prev.vs) > 500 && Math.abs(cur.vs) > 500 && Math.sign(prev.vs) !== Math.sign(cur.vs)) {
        const mag = Math.min(Math.abs(prev.vs), Math.abs(cur.vs))
        const score = Math.min(100, mag / 25 + 40)
        push('FLIP', score, `${prev.vs > 0 ? 'CLB' : 'DSC'}\u2192${cur.vs > 0 ? 'CLB' : 'DSC'} (${Math.round(mag)}fpm)`)
      }

      // ALT-REV: altitude derivative changes sign by > 200ft
      const dAlt = cur.alt - prev.alt
      if (Math.abs(dAlt) > 200 && prev.vs !== 0 && Math.sign(dAlt) !== Math.sign(prev.vs) && Math.abs(prev.vs) > 300) {
        const score = Math.min(100, Math.abs(dAlt) / 20 + 25)
        push('ALT-REV', score, `was ${prev.vs > 0 ? 'climbing' : 'descending'}, now \u0394${Math.round(dAlt)}ft`)
      }
    }

    prevRef.current = next

    if (newAnomalies.length) {
      setEvents(prev => {
        const merged = [...newAnomalies, ...prev].slice(0, 250)
        return merged
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flights, paused])

  // ---------------- derived: hot list ----------------
  const hotList = useMemo(() => {
    const now = Date.now()
    const window = 5 * 60 * 1000 // 5min decay window
    const byIcao = new Map<string, { icao: string; callsign: string; type?: string; operator?: string; lat: number; lng: number; total: number; lastT: number; lastKind: Kind; count: number }>()
    for (const e of events) {
      const age = now - e.t
      if (age > window) continue
      const decay = 1 - age / window
      const w = e.score * decay
      const cur = byIcao.get(e.icao)
      if (cur) {
        cur.total += w
        cur.count += 1
        if (e.t > cur.lastT) { cur.lastT = e.t; cur.lastKind = e.kind; cur.lat = e.lat; cur.lng = e.lng }
      } else {
        byIcao.set(e.icao, { icao: e.icao, callsign: e.callsign, type: e.type, operator: e.operator, lat: e.lat, lng: e.lng, total: w, lastT: e.t, lastKind: e.kind, count: 1 })
      }
    }
    return [...byIcao.values()].sort((a, b) => b.total - a.total).slice(0, 50)
  }, [events])

  // ---------------- filter for feed ----------------
  const feed = useMemo(() => {
    const q = query.trim().toLowerCase()
    return events.filter(e =>
      enabledKinds.has(e.kind) &&
      SEV_ORDER.indexOf(e.severity) <= SEV_ORDER.indexOf(minSeverity) &&
      (!q || e.callsign?.toLowerCase().includes(q) || e.icao.toLowerCase().includes(q) || e.kind.toLowerCase().includes(q) || (e.type ?? '').toLowerCase().includes(q) || (e.operator ?? '').toLowerCase().includes(q))
    )
  }, [events, enabledKinds, minSeverity, query])

  const counts = useMemo(() => {
    const c: Record<Kind, number> = { JUMP: 0, SWERVE: 0, SPIKE: 0, DASH: 0, FLIP: 0, SQUAWK: 0, 'ALT-REV': 0 }
    const now = Date.now()
    for (const e of events) {
      if (now - e.t > 5 * 60 * 1000) continue
      c[e.kind]++
    }
    return c
  }, [events])

  const sevCounts = useMemo(() => {
    const c: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }
    const now = Date.now()
    for (const e of events) {
      if (now - e.t > 5 * 60 * 1000) continue
      c[e.severity]++
    }
    return c
  }, [events])

  // ---------------- MapLibre overlay ----------------
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_HALO)) map.addLayer({
          id: LYR_HALO, type: 'circle', source: SRC,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['get', 'age'], 0, 26, 1, 14],
            'circle-color': ['get', 'color'],
            'circle-opacity': ['interpolate', ['linear'], ['get', 'age'], 0, 0.35, 1, 0.0],
            'circle-stroke-width': 0,
          },
        })
        if (!map.getLayer(LYR_RING)) map.addLayer({
          id: LYR_RING, type: 'circle', source: SRC,
          paint: {
            'circle-radius': 10,
            'circle-color': 'transparent',
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 2,
            'circle-stroke-opacity': ['interpolate', ['linear'], ['get', 'age'], 0, 1, 1, 0.2],
          },
        })
        if (!map.getLayer(LYR_LBL)) map.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-offset': [0, 1.8],
            'text-anchor': 'top',
            'text-allow-overlap': true,
          },
          paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.2 },
        })
      } catch {}
    }
    ensure()
  }, [map])

  // tick: refresh feature data every 500ms to animate age decay
  useEffect(() => {
    if (!map) return
    const paint = () => {
      const now = Date.now()
      const horizon = 60_000 // ring fades over 60s
      // group by icao -> most recent anomaly within horizon
      const seen = new Map<string, Anomaly>()
      for (const e of events) {
        if (now - e.t > horizon) continue
        const cur = seen.get(e.icao)
        if (!cur || e.t > cur.t) seen.set(e.icao, e)
      }
      const feats = showOverlay ? [...seen.values()].map(e => {
        const age = Math.min(1, (now - e.t) / horizon)
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [e.lng, e.lat] },
          properties: {
            color: KIND_COLOR[e.kind],
            age,
            label: `${e.callsign?.trim() || e.icao} \u00b7 ${e.kind} ${e.score}`,
          },
        }
      }) : []
      try { (map.getSource(SRC) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: feats }) } catch {}
    }
    paint()
    const t = setInterval(paint, 500)
    return () => clearInterval(t)
  }, [map, events, showOverlay])

  useEffect(() => {
    return () => {
      if (!map) return
      try { for (const l of [LYR_LBL, LYR_RING, LYR_HALO]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
      try { if (map.getSource(SRC)) map.removeSource(SRC) } catch {}
    }
  }, [map])

  const toggleKind = (k: Kind) => {
    setEnabledKinds(prev => {
      const n = new Set(prev)
      if (n.has(k)) n.delete(k); else n.add(k)
      return n
    })
  }

  return (
    <div className="fixed top-16 right-3 z-40 w-[380px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-white/10 bg-neutral-950/95 backdrop-blur text-neutral-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-2">
          <span className="text-rose-400">◉</span>
          <span className="text-sm font-semibold tracking-wide">ANOMALY RADAR</span>
          <span className="text-[10px] text-neutral-400">{events.length} buffered</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPaused(p => !p)}
            className={`text-[10px] px-2 py-0.5 rounded border ${paused ? 'border-amber-400 text-amber-300 bg-amber-500/10' : 'border-white/10 text-neutral-300 hover:border-white/30'}`}
          >{paused ? 'PAUSED' : 'LIVE'}</button>
          <button onClick={() => setEvents([])} className="text-[10px] px-2 py-0.5 rounded border border-white/10 text-neutral-300 hover:border-white/30">CLR</button>
          <button onClick={onClose} className="text-neutral-400 hover:text-white text-lg leading-none">×</button>
        </div>
      </div>

      {/* severity counter strip */}
      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-white/10">
        {SEV_ORDER.map(s => (
          <button
            key={s}
            onClick={() => setMinSeverity(s)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${minSeverity === s ? 'border-white/40 bg-white/10' : 'border-white/10 bg-black/30'}`}
            style={{ color: SEV_COLOR[s] }}
            title={`min severity: ${s}`}
          >
            <span className="text-[9px] tracking-wider">{s.slice(0, 4)}</span>
            <span className="text-sm font-mono">{sevCounts[s]}</span>
          </button>
        ))}
      </div>

      {/* kind chips */}
      <div className="px-3 py-2 flex flex-wrap gap-1 border-b border-white/10">
        {KIND_ORDER.map(k => (
          <button
            key={k}
            onClick={() => toggleKind(k)}
            className={`text-[10px] px-2 py-0.5 rounded border ${enabledKinds.has(k) ? 'bg-white/10 border-white/30' : 'bg-black/30 border-white/5 opacity-60'}`}
            style={{ color: KIND_COLOR[k] }}
          >
            {k} <span className="text-neutral-400 font-mono">{counts[k]}</span>
          </button>
        ))}
      </div>

      {/* thresholds */}
      <div className="px-3 py-2 border-b border-white/10 space-y-1.5">
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-neutral-400 w-14">SWERVE</span>
          <input type="range" min={3} max={30} value={thSwerve} onChange={e => setThSwerve(Number(e.target.value))} className="flex-1" />
          <span className="font-mono w-12 text-right">{thSwerve}°/s</span>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-neutral-400 w-14">SPIKE</span>
          <input type="range" min={500} max={6000} step={100} value={thSpike} onChange={e => setThSpike(Number(e.target.value))} className="flex-1" />
          <span className="font-mono w-12 text-right">{thSpike}fpm</span>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-neutral-400 w-14">DASH</span>
          <input type="range" min={3} max={30} value={thDash} onChange={e => setThDash(Number(e.target.value))} className="flex-1" />
          <span className="font-mono w-12 text-right">{thDash}kt/s</span>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-neutral-400 w-14">JUMP</span>
          <input type="range" min={1.2} max={5} step={0.1} value={thJumpMul} onChange={e => setThJumpMul(Number(e.target.value))} className="flex-1" />
          <span className="font-mono w-12 text-right">{thJumpMul.toFixed(1)}x GS</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] pt-1">
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={showOverlay} onChange={e => setShowOverlay(e.target.checked)} />
            <span>MAP RINGS</span>
          </label>
        </div>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="search callsign / icao / kind / type"
          className="w-full text-[11px] bg-black/40 border border-white/10 rounded px-2 py-1 outline-none focus:border-white/30"
        />
      </div>

      {/* tab switch */}
      <div className="px-3 py-1.5 flex gap-1 border-b border-white/10">
        {(['FEED', 'HOT'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 text-[10px] px-2 py-1 rounded border ${tab === t ? 'border-white/40 bg-white/10 text-white' : 'border-white/10 bg-black/30 text-neutral-400 hover:border-white/20'}`}
          >{t === 'FEED' ? `EVENT FEED (${feed.length})` : `HOT LIST (${hotList.length})`}</button>
        ))}
      </div>

      {/* body */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'FEED' ? (
          feed.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] text-neutral-500">No anomalies in buffer. Waiting for telemetry deltas…</div>
          ) : feed.map(e => {
            const ago = Math.max(0, Math.round((Date.now() - e.t) / 1000))
            return (
              <button
                key={e.id}
                onClick={() => onFly(e.icao)}
                className="w-full text-left px-3 py-2 border-b border-white/5 hover:bg-white/5"
                style={{ borderLeft: `3px solid ${KIND_COLOR[e.kind]}` }}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-[10px] px-1.5 rounded" style={{ background: KIND_COLOR[e.kind] + '22', color: KIND_COLOR[e.kind] }}>{e.kind}</span>
                    <span className="text-[11px] font-semibold truncate">{e.callsign?.trim() || e.icao}</span>
                    {e.type && <span className="text-[10px] text-neutral-400 truncate">{e.type}</span>}
                  </div>
                  <span className="text-[10px] font-mono shrink-0" style={{ color: SEV_COLOR[e.severity] }}>{e.score}</span>
                </div>
                <div className="flex items-baseline justify-between gap-2 mt-0.5">
                  <span className="text-[10px] text-neutral-300 truncate">{e.detail}</span>
                  <span className="text-[10px] text-neutral-500 font-mono shrink-0">T-{ago}s</span>
                </div>
              </button>
            )
          })
        ) : (
          hotList.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] text-neutral-500">No active offenders.</div>
          ) : hotList.map((h, i) => {
            const ago = Math.max(0, Math.round((Date.now() - h.lastT) / 1000))
            return (
              <button
                key={h.icao}
                onClick={() => onFly(h.icao)}
                className="w-full text-left px-3 py-2 border-b border-white/5 hover:bg-white/5"
                style={{ borderLeft: `3px solid ${KIND_COLOR[h.lastKind]}` }}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] text-neutral-500 font-mono w-5">#{i + 1}</span>
                    <span className="text-[11px] font-semibold truncate">{h.callsign?.trim() || h.icao}</span>
                    {h.type && <span className="text-[10px] text-neutral-400 truncate">{h.type}</span>}
                  </div>
                  <span className="text-[10px] font-mono text-amber-300 shrink-0">{Math.round(h.total)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-2 mt-0.5">
                  <span className="text-[10px] text-neutral-400 truncate">{h.operator || '—'} · {h.count} event{h.count === 1 ? '' : 's'} · last {h.lastKind}</span>
                  <span className="text-[10px] text-neutral-500 font-mono shrink-0">T-{ago}s</span>
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
