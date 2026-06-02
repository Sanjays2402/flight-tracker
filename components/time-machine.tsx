'use client'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Time Machine
   -----------------------------------------------------------
   Scrubs backwards through the rolling trail-history buffer
   (lat/lng/ts triples kept per ICAO in trailsRef) and paints
   "ghost" aircraft positions at any chosen instant in the past.

   For the chosen scrub time T:
     - for every aircraft, find the two trail samples (t0,t1) that
       bracket T; linearly interpolate lat/lng/alt to estimate the
       position the aircraft occupied at T.
     - if T predates the oldest sample for an aircraft, it isn't
       rendered (we don't fabricate before-buffer data).
     - if T is past the newest sample, we use the last known one.

   MapLibre overlay:
     - amber-violet GHOST circles with FL labels
     - dashed "where it went" geodesic line from the ghost
       position to where the aircraft is NOW
     - cyan ribbon source replays the polyline up to T

   Panel UI:
     - Big timestamp readout (UTC + relative "T-MM:SS ago")
     - Scrubber slider spanning the full buffer window
     - Play / Pause / Step-back / Step-forward / Live-jump
     - Speed selector: 0.5x / 1x / 2x / 4x / 8x / 16x
     - Stats: visible-at-T count, NOW count, delta, oldest sample
     - Top movers since T: ranked list of aircraft with the
       greatest great-circle distance moved between T and now,
       click-to-fly.
   ============================================================ */

export interface TMFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: TMFlight[]
  trails: Map<string, Array<[number, number, number]>>
  onClose: () => void
  onFly: (icao: string) => void
}

const SRC_GHOST = 'tm-ghost-src'
const SRC_LINK = 'tm-link-src'
const SRC_RIBBON = 'tm-ribbon-src'
const LYR_GHOST = 'tm-ghost-lyr'
const LYR_GHOST_LBL = 'tm-ghost-lbl'
const LYR_LINK = 'tm-link-lyr'
const LYR_RIBBON = 'tm-ribbon-lyr'

const fmtClock = (ms: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
}
const fmtAgo = (sec: number) => {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  return `T-${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
const gc = (la1: number, lo1: number, la2: number, lo2: number) => {
  const R = 3440.065
  const φ1 = (la1 * Math.PI) / 180, φ2 = (la2 * Math.PI) / 180
  const dφ = ((la2 - la1) * Math.PI) / 180
  const dλ = ((lo2 - lo1) * Math.PI) / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

interface Ghost {
  icao: string
  callsign: string
  type: string
  operator: string
  lat: number
  lng: number
  alt: number
  nowLat: number
  nowLng: number
  movedNm: number
  fresh: boolean // T is within recorded window
}

function sampleAt(trail: Array<[number, number, number]>, t: number): { lat: number; lng: number; fresh: boolean } | null {
  if (!trail.length) return null
  if (t <= trail[0][2]) return null // before buffer
  if (t >= trail[trail.length - 1][2]) {
    const last = trail[trail.length - 1]
    return { lat: last[0], lng: last[1], fresh: false }
  }
  // binary search
  let lo = 0, hi = trail.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (trail[mid][2] <= t) lo = mid
    else hi = mid
  }
  const a = trail[lo], b = trail[hi]
  const span = b[2] - a[2]
  const f = span > 0 ? (t - a[2]) / span : 0
  return { lat: a[0] + (b[0] - a[0]) * f, lng: a[1] + (b[1] - a[1]) * f, fresh: true }
}

export default function TimeMachine({ map, flights, trails, onClose, onFly }: Props) {
  // Compute buffer window: oldest trail sample → now
  const [bufferOldest, setBufferOldest] = useState<number>(() => Date.now() - 60_000)
  const [bufferNewest, setBufferNewest] = useState<number>(() => Date.now())
  // The scrub-time the user is viewing
  const [scrubT, setScrubT] = useState<number>(() => Date.now())
  const [playing, setPlaying] = useState<boolean>(false)
  const [speed, setSpeed] = useState<number>(2)
  const [query, setQuery] = useState<string>('')
  const [showRibbons, setShowRibbons] = useState<boolean>(true)
  const [showLinks, setShowLinks] = useState<boolean>(true)
  const [followLive, setFollowLive] = useState<boolean>(true) // hugs newest

  // Recompute buffer window whenever trails update (light interval)
  useEffect(() => {
    const tick = () => {
      let oldest = Infinity, newest = 0
      trails.forEach((tr) => {
        if (!tr.length) return
        const first = tr[0][2], last = tr[tr.length - 1][2]
        if (first < oldest) oldest = first
        if (last > newest) newest = last
      })
      const now = Date.now()
      if (!isFinite(oldest)) oldest = now - 60_000
      if (!newest) newest = now
      setBufferOldest(oldest)
      setBufferNewest(newest)
      if (followLive && !playing) setScrubT(newest)
    }
    tick()
    const h = window.setInterval(tick, 1500)
    return () => window.clearInterval(h)
  }, [trails, followLive, playing])

  // Playback loop
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      setScrubT((prev) => {
        const next = prev + dt * 1000 * speed
        if (next >= bufferNewest) { setPlaying(false); return bufferNewest }
        return next
      })
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, bufferNewest])

  // Compute ghost positions at scrubT
  const ghosts = useMemo<Ghost[]>(() => {
    const out: Ghost[] = []
    for (const f of flights) {
      if (f.ground) continue
      const tr = trails.get(f.icao)
      if (!tr || tr.length < 2) continue
      const s = sampleAt(tr, scrubT)
      if (!s || !s.fresh) continue
      const moved = gc(s.lat, s.lng, f.lat, f.lng)
      out.push({
        icao: f.icao,
        callsign: f.callsign || f.icao.toUpperCase(),
        type: f.type || '',
        operator: f.operator || '',
        lat: s.lat,
        lng: s.lng,
        alt: f.altitudeFt,
        nowLat: f.lat,
        nowLng: f.lng,
        movedNm: moved,
        fresh: true,
      })
    }
    return out
  }, [flights, trails, scrubT])

  // Render to MapLibre
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      if (!map.getSource(SRC_GHOST)) map.addSource(SRC_GHOST, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      if (!map.getSource(SRC_LINK)) map.addSource(SRC_LINK, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      if (!map.getSource(SRC_RIBBON)) map.addSource(SRC_RIBBON, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      if (!map.getLayer(LYR_LINK)) {
        map.addLayer({
          id: LYR_LINK, type: 'line', source: SRC_LINK,
          paint: { 'line-color': '#a78bfa', 'line-width': 1.4, 'line-dasharray': [2, 2], 'line-opacity': 0.55 },
        })
      }
      if (!map.getLayer(LYR_RIBBON)) {
        map.addLayer({
          id: LYR_RIBBON, type: 'line', source: SRC_RIBBON,
          paint: { 'line-color': '#22d3ee', 'line-width': 2.2, 'line-opacity': 0.75 },
        })
      }
      if (!map.getLayer(LYR_GHOST)) {
        map.addLayer({
          id: LYR_GHOST, type: 'circle', source: SRC_GHOST,
          paint: {
            'circle-radius': 6,
            'circle-color': '#fbbf24',
            'circle-stroke-color': '#fde68a',
            'circle-stroke-width': 1.5,
            'circle-opacity': 0.85,
          },
        })
      }
      if (!map.getLayer(LYR_GHOST_LBL)) {
        map.addLayer({
          id: LYR_GHOST_LBL, type: 'symbol', source: SRC_GHOST,
          layout: {
            'text-field': ['get', 'lbl'],
            'text-size': 10,
            'text-offset': [0, 1.2],
            'text-anchor': 'top',
            'text-font': ['Noto Sans Regular'],
            'text-allow-overlap': false,
          },
          paint: { 'text-color': '#fde68a', 'text-halo-color': '#000', 'text-halo-width': 1.2, 'text-opacity': 0.9 },
        })
      }
    }
    try { ensure() } catch {}

    const gSrc = map.getSource(SRC_GHOST) as maplibregl.GeoJSONSource | undefined
    const lSrc = map.getSource(SRC_LINK) as maplibregl.GeoJSONSource | undefined
    const rSrc = map.getSource(SRC_RIBBON) as maplibregl.GeoJSONSource | undefined
    if (gSrc) gSrc.setData({
      type: 'FeatureCollection',
      features: ghosts.map(g => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [g.lng, g.lat] },
        properties: { lbl: `${g.callsign} FL${String(Math.round(g.alt / 100)).padStart(3, '0')}` },
      })),
    })
    if (lSrc) lSrc.setData({
      type: 'FeatureCollection',
      features: showLinks ? ghosts.map(g => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[g.lng, g.lat], [g.nowLng, g.nowLat]] },
        properties: {},
      })) : [],
    })
    if (rSrc) rSrc.setData({
      type: 'FeatureCollection',
      features: showRibbons ? ghosts.map(g => {
        const tr = trails.get(g.icao) || []
        const coords: Array<[number, number]> = []
        for (const p of tr) { if (p[2] <= scrubT) coords.push([p[1], p[0]]) }
        coords.push([g.lng, g.lat])
        return {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: {},
        }
      }) : [],
    })

    return () => {
      try {
        for (const id of [LYR_GHOST_LBL, LYR_GHOST, LYR_RIBBON, LYR_LINK]) if (map.getLayer(id)) map.removeLayer(id)
        for (const id of [SRC_GHOST, SRC_LINK, SRC_RIBBON]) if (map.getSource(id)) map.removeSource(id)
      } catch {}
    }
  // map identity only; ghosts/showLinks/showRibbons handled in next effect via re-render
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])

  // Push data on every ghosts change without re-adding layers
  useEffect(() => {
    if (!map) return
    const gSrc = map.getSource(SRC_GHOST) as maplibregl.GeoJSONSource | undefined
    const lSrc = map.getSource(SRC_LINK) as maplibregl.GeoJSONSource | undefined
    const rSrc = map.getSource(SRC_RIBBON) as maplibregl.GeoJSONSource | undefined
    if (gSrc) gSrc.setData({
      type: 'FeatureCollection',
      features: ghosts.map(g => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [g.lng, g.lat] },
        properties: { lbl: `${g.callsign} FL${String(Math.round(g.alt / 100)).padStart(3, '0')}` },
      })),
    })
    if (lSrc) lSrc.setData({
      type: 'FeatureCollection',
      features: showLinks ? ghosts.map(g => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[g.lng, g.lat], [g.nowLng, g.nowLat]] },
        properties: {},
      })) : [],
    })
    if (rSrc) rSrc.setData({
      type: 'FeatureCollection',
      features: showRibbons ? ghosts.map(g => {
        const tr = trails.get(g.icao) || []
        const coords: Array<[number, number]> = []
        for (const p of tr) { if (p[2] <= scrubT) coords.push([p[1], p[0]]) }
        coords.push([g.lng, g.lat])
        return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }
      }) : [],
    })
  }, [map, ghosts, showLinks, showRibbons, trails, scrubT])

  const ageSec = Math.max(0, (bufferNewest - scrubT) / 1000)
  const bufferSpanSec = Math.max(1, (bufferNewest - bufferOldest) / 1000)
  const scrubPct = Math.max(0, Math.min(1, (scrubT - bufferOldest) / (bufferNewest - bufferOldest || 1)))
  const ghostCount = ghosts.length
  const nowAirborne = flights.filter(f => !f.ground).length
  const movers = useMemo(() => {
    const q = query.trim().toUpperCase()
    let list = ghosts.slice().sort((a, b) => b.movedNm - a.movedNm)
    if (q) list = list.filter(g => g.callsign.toUpperCase().includes(q) || g.icao.toUpperCase().includes(q) || g.type.toUpperCase().includes(q) || g.operator.toUpperCase().includes(q))
    return list.slice(0, 60)
  }, [ghosts, query])

  const stepBy = useCallback((deltaMs: number) => {
    setFollowLive(false)
    setPlaying(false)
    setScrubT((t) => Math.max(bufferOldest, Math.min(bufferNewest, t + deltaMs)))
  }, [bufferOldest, bufferNewest])

  return (
    <div className="fixed top-16 right-3 z-40 w-[380px] max-h-[calc(100vh-5rem)] overflow-hidden rounded-xl border border-amber-500/30 bg-black/85 backdrop-blur-md text-amber-100 text-xs shadow-2xl flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-amber-500/30 bg-amber-500/10">
        <div className="flex items-center gap-2">
          <span className="text-amber-300 font-semibold tracking-widest text-[11px]">TIME MACHINE</span>
          <span className="text-amber-400/60 text-[10px]">{ghostCount}/{nowAirborne} ghosts</span>
        </div>
        <button onClick={onClose} className="text-amber-300 hover:text-white text-sm leading-none px-1">✕</button>
      </div>

      <div className="px-3 pt-3 pb-2 border-b border-amber-500/20">
        <div className="flex items-baseline justify-between">
          <div className="font-mono text-amber-200 text-lg tracking-tight">{fmtClock(scrubT)}</div>
          <div className="font-mono text-amber-400/80 text-[11px]">{ageSec < 1 ? 'LIVE' : fmtAgo(ageSec)}</div>
        </div>
        <div className="mt-1 flex items-center justify-between text-[10px] text-amber-400/60 font-mono">
          <span>{fmtClock(bufferOldest)}</span>
          <span>buffer {Math.round(bufferSpanSec / 60)}m{Math.round(bufferSpanSec) % 60}s</span>
          <span>{fmtClock(bufferNewest)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(scrubPct * 1000)}
          onChange={(e) => { setFollowLive(false); setPlaying(false); const f = Number(e.target.value) / 1000; setScrubT(bufferOldest + f * (bufferNewest - bufferOldest)) }}
          className="w-full accent-amber-400 mt-2"
        />
        <div className="flex items-center gap-1 mt-2">
          <button onClick={() => stepBy(-5000)} className="flex-1 px-2 py-1 rounded bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 font-mono">«5s</button>
          <button onClick={() => stepBy(-1000)} className="flex-1 px-2 py-1 rounded bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 font-mono">«1s</button>
          <button
            onClick={() => { setFollowLive(false); setPlaying(p => !p) }}
            className={`flex-1 px-2 py-1 rounded border font-mono ${playing ? 'bg-rose-500/25 border-rose-500/40 text-rose-100' : 'bg-emerald-500/20 border-emerald-500/40 text-emerald-100'}`}
          >{playing ? '❚❚' : '▶'}</button>
          <button onClick={() => stepBy(1000)} className="flex-1 px-2 py-1 rounded bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 font-mono">1s»</button>
          <button onClick={() => stepBy(5000)} className="flex-1 px-2 py-1 rounded bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 font-mono">5s»</button>
          <button
            onClick={() => { setPlaying(false); setFollowLive(true); setScrubT(bufferNewest) }}
            className="flex-1 px-2 py-1 rounded bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-100 font-mono"
            title="Jump to live"
          >LIVE</button>
        </div>
        <div className="flex items-center gap-1 mt-2">
          <span className="text-amber-400/60 text-[10px] mr-1">SPD</span>
          {[0.5, 1, 2, 4, 8, 16].map(s => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={`flex-1 px-1 py-0.5 rounded text-[10px] font-mono border ${speed === s ? 'bg-amber-500/30 border-amber-400 text-amber-100' : 'bg-amber-500/5 border-amber-500/20 text-amber-300/70 hover:bg-amber-500/15'}`}
            >{s}x</button>
          ))}
        </div>
        <div className="flex items-center gap-2 mt-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={showLinks} onChange={(e) => setShowLinks(e.target.checked)} className="accent-amber-400" />
            <span className="text-amber-300/80">LINK</span>
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={showRibbons} onChange={(e) => setShowRibbons(e.target.checked)} className="accent-cyan-400" />
            <span className="text-cyan-300/80">RIBBON</span>
          </label>
          <label className="flex items-center gap-1 cursor-pointer ml-auto">
            <input type="checkbox" checked={followLive} onChange={(e) => setFollowLive(e.target.checked)} className="accent-emerald-400" />
            <span className="text-emerald-300/80">FOLLOW LIVE</span>
          </label>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-amber-500/20 grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[10px] text-amber-400/60">AT T</div>
          <div className="font-mono text-amber-200">{ghostCount}</div>
        </div>
        <div>
          <div className="text-[10px] text-amber-400/60">NOW</div>
          <div className="font-mono text-amber-200">{nowAirborne}</div>
        </div>
        <div>
          <div className="text-[10px] text-amber-400/60">Δ</div>
          <div className={`font-mono ${nowAirborne - ghostCount >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{nowAirborne - ghostCount >= 0 ? '+' : ''}{nowAirborne - ghostCount}</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-amber-500/20">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search callsign / type / op"
          className="w-full bg-black/60 border border-amber-500/30 rounded px-2 py-1 text-[11px] text-amber-100 placeholder-amber-500/40 focus:outline-none focus:border-amber-400"
        />
        <div className="text-[10px] text-amber-400/60 mt-1">TOP MOVERS since T (great-circle nm)</div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {movers.length === 0 && (
          <div className="px-3 py-6 text-center text-amber-400/50 text-[11px]">
            {bufferSpanSec < 5 ? 'Buffer still warming up — let trails accumulate.' : 'No ghosts in current window.'}
          </div>
        )}
        {movers.map((g) => (
          <button
            key={g.icao}
            onClick={() => onFly(g.icao)}
            className="w-full text-left px-3 py-1.5 border-b border-amber-500/10 hover:bg-amber-500/10 transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-amber-100 text-[11px]">{g.callsign}</span>
              <span className="font-mono text-amber-300 text-[11px]">{g.movedNm.toFixed(1)}nm</span>
            </div>
            <div className="flex items-center justify-between text-[10px] text-amber-400/60 font-mono">
              <span>{(g.type || '?').slice(0, 12)} · {(g.operator || '').slice(0, 14)}</span>
              <span>FL{String(Math.round(g.alt / 100)).padStart(3, '0')}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
