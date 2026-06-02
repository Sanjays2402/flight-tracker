'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Cosmic Radiation Dose Monitor
   -----------------------------------------------------------
   Real aviation safety concern: galactic cosmic radiation
   (GCR) exposure increases sharply with altitude and toward
   the magnetic poles where Earth's magnetic shielding is
   weakest. FAA monitors crew dose (AC 120-61B); EU treats
   crew >6 mSv/yr as occupationally exposed (Directive
   2013/59/Euratom). This panel estimates the instantaneous
   ambient dose-equivalent rate (uSv/h) for every airborne
   aircraft using a CARI-7-inspired closed-form model and
   integrates per-aircraft accumulated dose across the
   session.

   Model (simplified, calibrated to NAIRAS / CARI-7 outputs
   for solar-minimum, W = 500 MV heliocentric potential):

     1. Geomagnetic latitude (approx dipole):
        lambda_m = asin( sin(lat) * sin(lat_p)
                       + cos(lat) * cos(lat_p) * cos(lon - lon_p) )
        with pole at (80.65 N, -72.68 W) (IGRF-13 epoch 2020)

     2. Vertical cutoff rigidity (Stoermer):
        Rc(GV) = 14.5 * cos^4(lambda_m)
        modulated by user-tunable solar W (300-1500 MV);
        higher W reduces low-energy primaries reaching atmosphere.

     3. Altitude term — Pfotzer maximum at ~60kft then plateau.
        Effective atmospheric depth (g/cm^2) = 1033 * exp(-h_km / 7.64)
        Dose rate base = D0 * exp(-(depth - 200) / 130)
        capped at 12 uSv/h (Pfotzer ceiling).

     4. Latitude/rigidity multiplier:
        k_lat = 0.18 + 0.82 * 1/(1 + (Rc/Rc_ref)^2.4)
        with Rc_ref = 4 GV; high-lat (Rc->0) -> 1.0,
        equatorial (Rc->15) -> 0.18.

     5. Solar modulation multiplier:
        k_sol = 1.0 - 0.30 * (W - 500) / 1000
        clamped 0.5..1.4. Solar max suppresses GCR.

     6. Final dose rate uSv/h = D0 * alt_term * k_lat * k_sol
        with D0 = 11.0 uSv/h reference.

   Tiers (uSv/h):
     ELEVATED >= 7   (polar high-FL, ALARA flag)
     HIGH     >= 4   (typical NAT polar route cruise)
     MODERATE >= 1.5 (typical mid-lat cruise)
     LOW      <  1.5

   Cumulative dose: per-icao integral via tick delta time
   (uSv = rate * dt_hours). Survives re-mounts via useRef.

   MapLibre overlay:
     - tier-colored aircraft halo rings (radius scales with rate)
     - dashed iso-rigidity bands (60N/45N/30N + mirrored south)
       to visualise the dominant latitude driver
     - callsign + rate uSv/h labels

   Side panel:
     - 4-tier counter strip (click-to-filter)
     - SOLAR W slider (heliocentric potential 300-1500 MV)
       with Solar-MAX / typical / MIN preset chips
     - MIN-FL slider (skip <FL100 noise)
     - HALOS / BANDS / LBL toggles
     - search box (callsign / icao / type / operator)
     - 3-cell summary (FLEET MAX uSv/h / FLEET AVG / TRACKED N)
     - ranked aircraft list sorted by rate desc, with tier
       stripe, rate / FL / lambda / Rc readout, accumulated
       dose since first observed, click-to-fly
   ============================================================ */

export interface CdFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: CdFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'ELEVATED' | 'HIGH' | 'MODERATE' | 'LOW'
const TIER_COLOR: Record<Tier, string> = {
  ELEVATED: '#f43f5e',
  HIGH: '#f59e0b',
  MODERATE: '#eab308',
  LOW: '#38bdf8',
}
const TIER_ORDER: Tier[] = ['ELEVATED', 'HIGH', 'MODERATE', 'LOW']

const SRC_HALO = 'cd-halo-src'
const LYR_HALO = 'cd-halo-lyr'
const SRC_BAND = 'cd-band-src'
const LYR_BAND = 'cd-band-lyr'
const SRC_LBL = 'cd-lbl-src'
const LYR_LBL = 'cd-lbl-lyr'

// IGRF-13 (2020) north magnetic dip pole
const MAG_POLE_LAT = 80.65
const MAG_POLE_LON = -72.68

function geomagLatDeg(lat: number, lng: number): number {
  const toR = Math.PI / 180
  const phi = lat * toR, lam = lng * toR
  const phiP = MAG_POLE_LAT * toR, lamP = MAG_POLE_LON * toR
  const sinM = Math.sin(phi) * Math.sin(phiP) + Math.cos(phi) * Math.cos(phiP) * Math.cos(lam - lamP)
  return Math.asin(Math.max(-1, Math.min(1, sinM))) / toR
}

function rigidityGV(geomagLat: number): number {
  const c = Math.cos(geomagLat * Math.PI / 180)
  const c4 = c * c * c * c
  return 14.5 * c4
}

function doseRateUSvH(altFt: number, lat: number, lng: number, solarW: number): {
  rate: number; lambdaM: number; rc: number; altTerm: number; kLat: number; kSol: number
} {
  const lambdaM = geomagLatDeg(lat, lng)
  const rcBase = rigidityGV(lambdaM)
  // Solar modulation slightly shifts effective rigidity
  const rc = rcBase * (1 + 0.04 * (solarW - 500) / 1000)
  const hKm = Math.max(0, altFt) * 0.0003048
  const depth = 1033 * Math.exp(-hKm / 7.64)
  // base falls with depth; cap at Pfotzer ceiling
  const altTerm = Math.min(1.0, Math.exp(-(depth - 200) / 130))
  const rcRef = 4
  const kLat = 0.18 + 0.82 / (1 + Math.pow(rc / rcRef, 2.4))
  const kSol = Math.max(0.5, Math.min(1.4, 1.0 - 0.30 * (solarW - 500) / 1000))
  const rate = 11.0 * altTerm * kLat * kSol
  return { rate, lambdaM, rc, altTerm, kLat, kSol }
}

function tierFor(rate: number): Tier {
  if (rate >= 7) return 'ELEVATED'
  if (rate >= 4) return 'HIGH'
  if (rate >= 1.5) return 'MODERATE'
  return 'LOW'
}

function fmtDose(uSv: number): string {
  if (uSv >= 1000) return `${(uSv / 1000).toFixed(2)}mSv`
  if (uSv >= 10) return `${uSv.toFixed(0)}\u00B5Sv`
  return `${uSv.toFixed(2)}\u00B5Sv`
}

// 32-vertex circle around point (deg) for halo polygon
function circlePoly(lat: number, lng: number, radiusNm: number): [number, number][] {
  const pts: [number, number][] = []
  const R = radiusNm / 60
  for (let i = 0; i <= 32; i++) {
    const a = (i / 32) * 2 * Math.PI
    const dLat = R * Math.cos(a)
    const dLng = R * Math.sin(a) / Math.max(0.1, Math.cos(lat * Math.PI / 180))
    pts.push([lng + dLng, lat + dLat])
  }
  return pts
}

// Iso-geomagnetic-latitude band (closed polygon: a strip of constant lambda_m)
function isoMagBand(lambdaTarget: number): [number, number][] {
  // Walk lng from -180..180 sampling lat where geomagLat == lambdaTarget,
  // bracketed search at 4-deg lng step. Return as a thin closed strip.
  const top: [number, number][] = []
  const bot: [number, number][] = []
  const eps = 1.2 // strip half-width deg
  for (let lng = -180; lng <= 180; lng += 4) {
    // bisection on geographic lat to hit lambdaTarget
    let lo = -89, hi = 89
    let target = lambdaTarget
    // monotonicity isn't strict near pole, but generally lambdaM increases with lat near same lng
    // probe direction
    const fLo = geomagLatDeg(lo, lng) - target
    const fHi = geomagLatDeg(hi, lng) - target
    if (fLo * fHi > 0) continue
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) / 2
      const fm = geomagLatDeg(mid, lng) - target
      if (fLo * fm <= 0) hi = mid; else lo = mid
    }
    const lat = (lo + hi) / 2
    top.push([lng, lat + eps])
    bot.push([lng, lat - eps])
  }
  if (top.length < 4) return []
  return [...top, ...bot.reverse(), top[0]]
}

export default function CosmicDose({ map, flights, onClose, onFly }: Props) {
  const [solarW, setSolarW] = useState<number>(500)
  const [minFL, setMinFL] = useState<number>(100)
  const [showHalos, setShowHalos] = useState(true)
  const [showBands, setShowBands] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [query, setQuery] = useState('')

  // Per-aircraft accumulated dose (uSv), survives renders
  const cumRef = useState(() => new Map<string, { dose: number; lastTs: number; lastRate: number }>())[0]

  const tick = useState(0)[0] // re-evaluated each render; we don't need extra ticks since parent re-renders on flights

  const results = useMemo(() => {
    const now = Date.now()
    const out: { f: CdFlight; rate: number; tier: Tier; lambdaM: number; rc: number; cumDose: number }[] = []
    for (const f of flights) {
      if (f.ground) continue
      if ((f.altitudeFt / 100) < minFL) continue
      const { rate, lambdaM, rc } = doseRateUSvH(f.altitudeFt, f.lat, f.lng, solarW)
      // integrate
      const prev = cumRef.get(f.icao)
      if (prev) {
        const dt = Math.max(0, Math.min(120, (now - prev.lastTs) / 1000)) // sec, clamp
        const dh = dt / 3600
        const avgRate = (prev.lastRate + rate) / 2
        prev.dose += avgRate * dh
        prev.lastTs = now
        prev.lastRate = rate
      } else {
        cumRef.set(f.icao, { dose: 0, lastTs: now, lastRate: rate })
      }
      const cumDose = cumRef.get(f.icao)!.dose
      out.push({ f, rate, tier: tierFor(rate), lambdaM, rc, cumDose })
    }
    return out
  }, [flights, solarW, minFL, cumRef, tick])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { ELEVATED: 0, HIGH: 0, MODERATE: 0, LOW: 0 }
    for (const r of results) c[r.tier]++
    return c
  }, [results])

  const summary = useMemo(() => {
    if (!results.length) return { max: 0, avg: 0, n: 0 }
    let max = 0, sum = 0
    for (const r of results) { if (r.rate > max) max = r.rate; sum += r.rate }
    return { max, avg: sum / results.length, n: results.length }
  }, [results])

  const ranked = useMemo(() => {
    const q = query.trim().toLowerCase()
    return results
      .filter(r => tierFilter === 'ALL' || r.tier === tierFilter)
      .filter(r => !q || r.f.callsign?.toLowerCase().includes(q) || r.f.type?.toLowerCase().includes(q) || r.f.operator?.toLowerCase().includes(q) || r.f.icao.toLowerCase().includes(q))
      .sort((a, b) => b.rate - a.rate)
  }, [results, tierFilter, query])

  // Pre-compute iso-rigidity bands once per solarW (stable; small set)
  const bandFeats = useMemo(() => {
    if (!showBands) return []
    const targets = [60, 45, 30, -30, -45, -60]
    return targets
      .map(t => ({ t, ring: isoMagBand(t) }))
      .filter(b => b.ring.length > 4)
      .map(b => ({
        type: 'Feature' as const,
        geometry: { type: 'Polygon' as const, coordinates: [b.ring] },
        properties: {
          color: Math.abs(b.t) >= 60 ? '#f43f5e' : Math.abs(b.t) >= 45 ? '#f59e0b' : '#38bdf8',
          opacity: Math.abs(b.t) >= 60 ? 0.10 : Math.abs(b.t) >= 45 ? 0.07 : 0.04,
        },
      }))
  }, [showBands])

  // ---------- MapLibre overlay ----------
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC_BAND)) map.addSource(SRC_BAND, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_BAND)) map.addLayer({
          id: LYR_BAND, type: 'fill', source: SRC_BAND,
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'opacity'] },
        })
        if (!map.getSource(SRC_HALO)) map.addSource(SRC_HALO, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_HALO)) map.addLayer({
          id: LYR_HALO, type: 'line', source: SRC_HALO,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.6, 'line-opacity': 0.75, 'line-dasharray': [1, 1.5] },
        })
        if (!map.getSource(SRC_LBL)) map.addSource(SRC_LBL, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_LBL)) map.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC_LBL,
          layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, -1.6], 'text-anchor': 'bottom', 'text-allow-overlap': true },
          paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.2 },
        })
      } catch {}
    }
    ensure()

    const visible = ranked
    const haloFeats = showHalos ? visible.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Polygon' as const, coordinates: [circlePoly(r.f.lat, r.f.lng, 8 + Math.min(40, r.rate * 4))] },
      properties: { color: TIER_COLOR[r.tier] },
    })) : []
    const lblFeats = showLabels ? visible.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: { color: TIER_COLOR[r.tier], label: `${r.f.callsign?.trim() || r.f.icao} \u2022 ${r.rate.toFixed(1)}\u00B5Sv/h` },
    })) : []
    try {
      (map.getSource(SRC_BAND) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: bandFeats })
      ;(map.getSource(SRC_HALO) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: haloFeats })
      ;(map.getSource(SRC_LBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lblFeats })
    } catch {}
  }, [map, ranked, showHalos, showBands, showLabels, bandFeats])

  useEffect(() => {
    return () => {
      if (!map) return
      try { for (const l of [LYR_LBL, LYR_HALO, LYR_BAND]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
      try { for (const s of [SRC_LBL, SRC_HALO, SRC_BAND]) if (map.getSource(s)) map.removeSource(s) } catch {}
    }
  }, [map])

  const solarPhase = solarW <= 450 ? 'SOLAR-MIN' : solarW >= 900 ? 'SOLAR-MAX' : 'TYPICAL'

  return (
    <div className="fixed top-16 right-3 z-40 w-[400px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">&#9762;</span>
          <span className="text-sm font-semibold tracking-wide">COSMIC DOSE</span>
          <span className="text-[10px] text-slate-500">GCR exposure &micro;Sv/h</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">&times;</button>
      </div>

      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {(['ELEVATED', 'HIGH', 'MODERATE', 'LOW'] as Tier[]).map(t => (
          <button key={t}
            onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/40 bg-sky-500/15' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }} title={t}>
            <span className="text-[9px] tracking-wider">{t.slice(0, 4)}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="px-3 py-2 grid grid-cols-3 gap-1 border-b border-slate-800">
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">FLEET MAX</span>
          <span className="text-sm font-mono text-slate-100">{summary.max.toFixed(1)}</span>
        </div>
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">FLEET AVG</span>
          <span className="text-sm font-mono text-slate-100">{summary.avg.toFixed(2)}</span>
        </div>
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">TRACKED</span>
          <span className="text-sm font-mono text-slate-100">{summary.n}</span>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>SOLAR W (heliocentric pot. MV)</span>
            <span className="font-mono text-slate-300">{solarW} &middot; {solarPhase}</span>
          </div>
          <input type="range" min={300} max={1500} step={25} value={solarW} onChange={e => setSolarW(parseInt(e.target.value))} className="w-full accent-sky-500" />
          <div className="flex items-center gap-1 mt-1">
            {[
              { label: 'MIN', w: 400 },
              { label: 'TYPICAL', w: 650 },
              { label: 'MAX', w: 1200 },
            ].map(p => (
              <button key={p.label} onClick={() => setSolarW(p.w)}
                className={`flex-1 text-[9px] tracking-wider px-1 py-0.5 rounded border ${Math.abs(solarW - p.w) < 30 ? 'border-sky-500/40 bg-sky-500/15 text-slate-100' : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:text-slate-200'}`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>MIN FLIGHT LEVEL</span>
            <span className="font-mono text-slate-300">FL{minFL}</span>
          </div>
          <input type="range" min={0} max={450} step={10} value={minFL} onChange={e => setMinFL(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalos} onChange={e => setShowHalos(e.target.checked)} className="accent-sky-500" /><span>HALOS</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showBands} onChange={e => setShowBands(e.target.checked)} className="accent-sky-500" /><span>BANDS</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/40 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{ranked.length} shown / {results.length} airborne &ge;FL{minFL}</span>
        <span>ICRP H*(10)</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {ranked.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {ranked.map(r => (
          <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
            <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono font-semibold truncate text-slate-100">{r.f.callsign?.trim() || r.f.icao}</span>
                <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                <span className="ml-auto text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.rate.toFixed(1)}&micro;Sv/h</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                <span title="flight level">FL{Math.round(r.f.altitudeFt / 100)}</span>
                <span title="geomagnetic latitude">&lambda;{r.lambdaM >= 0 ? '+' : ''}{r.lambdaM.toFixed(0)}&deg;</span>
                <span title="vertical cutoff rigidity">Rc {r.rc.toFixed(1)}GV</span>
                <span className="ml-auto" title="accumulated dose since first observed">&sum; {fmtDose(r.cumDose)}</span>
              </div>
              <div className="text-[10px] text-slate-600 truncate">{r.f.operator || '\u2014'} &middot; {r.tier}</div>
            </div>
          </button>
        ))}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 tracking-wider">
        ELEV &ge;7 &middot; HIGH &ge;4 &middot; MOD &ge;1.5 &middot; LOW &middot; NAIRAS/CARI-7 approx
      </div>
    </div>
  )
}
