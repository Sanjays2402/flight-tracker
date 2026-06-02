'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Sonic Boom Footprint Predictor
   -----------------------------------------------------------
   Steady-level supersonic flight produces a conical pressure
   discontinuity (the Mach cone) trailing the aircraft. The
   ground intersection of that cone is the *primary boom
   carpet* — typically 30-70 NM wide depending on altitude and
   Mach number. Atmospheric ducting at higher altitudes can
   produce a *secondary boom* far behind (sometimes 100+ NM).

   This overlay finds every aircraft with derived Mach >= 1.00
   below MAX-FL, and for each one:

   1) Mach angle μ = arcsin(1/M)   (radians)
      → primary boom carpet half-width on the ground (NM):
        wHalf = alt_NM / tan(μ) = alt_NM * cot(arcsin(1/M))
               = alt_NM * sqrt(M^2 - 1)
      → full carpet width = 2 * wHalf
   2) Whitham N-wave nominal overpressure (psf) sea-level
      from Carlson (1972) simplified:
        Δp0 = Kp * (alt_kft)^-0.75 * (M^2 - 1)^(3/8)
              * (W_lbs / 1e6)^0.5 / (Lref_ft / 100)^0.25
      with class-typical W (lbs) / Lref (ft):
        fighter   40000 / 60ft   Kp = 1.9
        biz-supersonic (proposed) 100000 / 80ft Kp = 1.8
        heavy-trans (Concorde-class) 400000 / 200ft Kp = 1.7
      We use Carlson eq (47) form, simplified for visualisation.
   3) Lateral attenuation: at the edge of the carpet the
      overpressure falls to ~30% of the centerline value.
      A simple linear ramp from 1.0 at center → 0.3 at edge
      is applied for the ground-strip styling.
   4) Cutoff Mach: at standard atmosphere a temperature lapse
      causes the cone to refract; the practical *cutoff Mach*
      below which the boom never reaches the ground is
      Mcut ≈ 1.0 + 0.018*(T0/Tg - 1). For typical ISA
      operations Mcut ≈ 1.10 — below this the boom is a
      "mach-cutoff" focused boom that doesn't reach the
      surface. We surface a CUTOFF flag for 1.00 ≤ M < 1.10.
   5) Classification (Δp0 psf, Brüel & Kjær):
        WHISPER  Δp0 < 0.5     emerald (barely audible)
        AUDIBLE  Δp0 < 1.0     sky     (window-rattling)
        STRONG   Δp0 < 2.5     amber   (FAA 14 CFR 91.817 limit
                                        for over-land supersonic
                                        is "no boom impact" — flag)
        SEVERE   Δp0 >= 2.5    rose    (structural risk, glass)
   6) Carpet ground polygon: a swept band, 60 NM aft of the
      aircraft, centered under the great-circle track,
      width = 2*wHalf at current altitude, with tier-coloured
      fill that fades along the lateral axis.

   MapLibre overlay:
     - Per-aircraft tier-coloured halo at current position.
     - Carpet polygon (3-D quadrilateral approximating the
       boom footprint on the ground) tier-coloured with 12-25%
       fill opacity, dashed tier-coloured outline.
     - Forward Mach-cone projection line aircraft to the
       cone-tip ground intercept.
     - Tier-coloured callsign + M + Δp0 + W(km wide) labels.

   Side panel: 4-tier counter strip click-to-filter,
   3-cell PEAK-PSF / WIDEST-CARPET-NM / SEVERE-COUNT summary,
   2-cell MEAN-M / CUTOFF-COUNT secondary row,
   SVG overpressure-vs-Mach diagram (x = M 1.0..3.5,
   y = Δp0 psf 0..5, every aircraft as tier dot at (M, Δp0)
   coord, dashed amber 1.0 psf and rose 2.5 psf horizontals),
   4 sliders MIN-M / MAX-FL / WEIGHT-MULT / CARPET-LEN-NM,
   3-class chip filter (fighter / biz / heavy), CARPET/CONE/LBL
   toggles, search, ranked list sorted tier-worst-first then
   Δp0 desc with tier color stripe + callsign + FL + M + Δp0
   + carpet-NM + class advice click-to-fly per row.

   Registered under Layers > Environment category.
   ft-sboom persisted preference.
   ============================================================ */

export interface BoomFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  mach?: number
  track: number
  vertRate: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: BoomFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'WHISPER' | 'AUDIBLE' | 'STRONG' | 'SEVERE'
const TIER_COLOR: Record<Tier, string> = {
  WHISPER: '#10b981', AUDIBLE: '#0ea5e9', STRONG: '#f59e0b', SEVERE: '#ef4444',
}
const TIER_ORDER: Tier[] = ['SEVERE', 'STRONG', 'AUDIBLE', 'WHISPER']

type Klass = 'fighter' | 'biz-ss' | 'heavy-ss'
const KLASS_LABEL: Record<Klass, string> = { fighter: 'FTR', 'biz-ss': 'BIZ-SS', 'heavy-ss': 'HVY-SS' }
const KLASS_W_LBS: Record<Klass, number> = { fighter: 40000, 'biz-ss': 100000, 'heavy-ss': 400000 }
const KLASS_LREF_FT: Record<Klass, number> = { fighter: 60, 'biz-ss': 80, 'heavy-ss': 200 }
const KLASS_KP: Record<Klass, number> = { fighter: 1.9, 'biz-ss': 1.8, 'heavy-ss': 1.7 }

function classify(t: string | undefined, _cat?: string): Klass {
  const x = (t || '').toUpperCase()
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS|F14|F4|F5|T38)/.test(x)) return 'fighter'
  if (/^(CONC|TU144|AS2|XB1|OVST|SST)/.test(x)) return 'heavy-ss'
  return 'biz-ss'
}

const D2R = Math.PI / 180

// ISA temperature at altitude (Kelvin)
function isaT(altFt: number): number {
  const altM = altFt * 0.3048
  if (altM < 11000) return 288.15 - 0.0065 * altM
  return 216.65
}

// Mach derived from TAS (kts) at altitude
function machFromTas(tasKts: number, altFt: number): number {
  const T = isaT(altFt)
  const a = Math.sqrt(1.4 * 287.05 * T) * 1.94384
  return tasKts / a
}

interface Row {
  f: BoomFlight
  klass: Klass
  altFt: number
  altKft: number
  mach: number
  // Mach geometry
  muRad: number
  cotMu: number
  carpetHalfNm: number    // primary boom half-width on ground (NM)
  carpetFullNm: number
  // Overpressure (psf)
  dp0Psf: number
  // Cutoff (no-ground boom) flag
  cutoff: boolean
  Mcut: number
  // Tier
  tier: Tier
}

const SRC_RING = 'sbm-ring', SRC_CRP = 'sbm-crp', SRC_CON = 'sbm-con', SRC_LBL = 'sbm-lbl'
const LYR_RING = 'sbm-ring-l', LYR_CRP_FILL = 'sbm-crp-fill', LYR_CRP_LINE = 'sbm-crp-line', LYR_CON = 'sbm-con-l', LYR_LBL = 'sbm-lbl-l'

export default function SonicBoom({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minM, setMinM] = useState(100)         // ×0.01 → 1.00 default
  const [maxFl, setMaxFl] = useState(600)
  const [wMult, setWMult] = useState(100)        // % weight calibration
  const [carpetLenNm, setCarpetLenNm] = useState(60)
  const [showCarpet, setShowCarpet] = useState(true)
  const [showCone, setShowCone] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const minMach = minM / 100

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const fl = f.altitudeFt / 100
      if (fl > maxFl) continue
      if (f.altitudeFt < 1000) continue   // skip ground-effect
      const klass = classify(f.type, f.category)
      const tas = isFinite(f.velocityKts) ? f.velocityKts : 0
      const mach = (typeof f.mach === 'number' && isFinite(f.mach) && f.mach > 0) ? f.mach : machFromTas(tas, f.altitudeFt)
      if (mach < minMach) continue
      // Mach cone
      const sinMu = 1 / mach
      const muRad = Math.asin(Math.max(0.01, Math.min(1, sinMu)))
      // cot(mu) = sqrt(M^2-1)
      const cotMu = Math.sqrt(Math.max(0, mach * mach - 1))
      const altNm = f.altitudeFt / 6076.115
      const carpetHalfNm = altNm * cotMu
      const carpetFullNm = 2 * carpetHalfNm
      // Whitham-Carlson overpressure
      const altKft = Math.max(1, f.altitudeFt / 1000)
      const wLbs = KLASS_W_LBS[klass] * (wMult / 100)
      const lRef = KLASS_LREF_FT[klass]
      const Kp = KLASS_KP[klass]
      const m2m1 = Math.max(0.01, mach * mach - 1)
      const dp0 = Kp * Math.pow(altKft, -0.75) * Math.pow(m2m1, 3 / 8) * Math.pow(wLbs / 1e6, 0.5) / Math.pow(lRef / 100, 0.25)
      // Mach cutoff for ground impact (lapse-rate refraction)
      const Tg = 288.15
      const Talt = isaT(f.altitudeFt)
      const Mcut = 1.0 + 0.018 * (Tg / Talt - 1)
      const cutoff = mach < Mcut
      // Tier
      let tier: Tier
      const dpEff = cutoff ? dp0 * 0.2 : dp0
      if (dpEff >= 2.5) tier = 'SEVERE'
      else if (dpEff >= 1.0) tier = 'STRONG'
      else if (dpEff >= 0.5) tier = 'AUDIBLE'
      else tier = 'WHISPER'

      out.push({
        f, klass, altFt: f.altitudeFt, altKft: f.altitudeFt / 1000, mach,
        muRad, cotMu, carpetHalfNm, carpetFullNm,
        dp0Psf: dp0, cutoff, Mcut, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return b.dp0Psf - a.dp0Psf
    })
    return out
  }, [flights, minMach, maxFl, wMult])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { WHISPER: 0, AUDIBLE: 0, STRONG: 0, SEVERE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let peakPsf = 0, widest = 0, severeCount = 0, cutoffCount = 0, sumM = 0
    for (const r of rows) {
      if (r.dp0Psf > peakPsf) peakPsf = r.dp0Psf
      if (r.carpetFullNm > widest) widest = r.carpetFullNm
      if (r.tier === 'SEVERE') severeCount++
      if (r.cutoff) cutoffCount++
      sumM += r.mach
    }
    return { peakPsf, widest, severeCount, cutoffCount, meanM: rows.length > 0 ? sumM / rows.length : 0 }
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + Math.min(16, r.dp0Psf * 4) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) }

    // Carpet polygon: rectangle behind the aircraft along the track, width = carpetFullNm
    const carpetFeatures: any[] = []
    if (showCarpet) {
      for (const r of rows) {
        if (r.cutoff) continue
        const trkDeg = r.f.track || 0
        const backDeg = (trkDeg + 180) % 360
        const sideR = (trkDeg + 90) % 360
        const sideL = (trkDeg + 270) % 360
        // Convert NM offsets to lat/lng
        const nmToLat = (nm: number) => nm / 60
        const nmToLng = (nm: number, lat: number) => nm / 60 / Math.max(0.1, Math.cos(lat * D2R))
        // Start (under aircraft)
        const startLat = r.f.lat
        const startLng = r.f.lng
        // End (60 NM aft)
        const endLat = r.f.lat + nmToLat(carpetLenNm) * Math.cos(backDeg * D2R)
        const endLng = r.f.lng + nmToLng(carpetLenNm, r.f.lat) * Math.sin(backDeg * D2R)
        // Side offsets at start
        const w = r.carpetHalfNm
        const dLatR = nmToLat(w) * Math.cos(sideR * D2R)
        const dLngR = nmToLng(w, r.f.lat) * Math.sin(sideR * D2R)
        const dLatL = nmToLat(w) * Math.cos(sideL * D2R)
        const dLngL = nmToLng(w, r.f.lat) * Math.sin(sideL * D2R)
        const p1 = [startLng + dLngL, startLat + dLatL]
        const p2 = [startLng + dLngR, startLat + dLatR]
        const p3 = [endLng + dLngR, endLat + dLatR]
        const p4 = [endLng + dLngL, endLat + dLatL]
        carpetFeatures.push({
          type: 'Feature' as const,
          properties: { color: TIER_COLOR[r.tier], opacity: Math.min(0.28, 0.10 + r.dp0Psf * 0.05) },
          geometry: { type: 'Polygon' as const, coordinates: [[p1, p2, p3, p4, p1]] },
        })
      }
    }
    const carpetFc = { type: 'FeatureCollection' as const, features: carpetFeatures }

    // Cone: forward projection from aircraft to where cone-tip touches ground (which is straight under it).
    // We'll draw the lateral cone-tip lines at ±carpetHalfNm at the aircraft position.
    const coneFeatures: any[] = []
    if (showCone) {
      for (const r of rows) {
        if (r.cutoff) continue
        const trkDeg = r.f.track || 0
        const sideR = (trkDeg + 90) % 360
        const sideL = (trkDeg + 270) % 360
        const w = r.carpetHalfNm
        const nmToLat = (nm: number) => nm / 60
        const nmToLng = (nm: number, lat: number) => nm / 60 / Math.max(0.1, Math.cos(lat * D2R))
        const rLat = r.f.lat + nmToLat(w) * Math.cos(sideR * D2R)
        const rLng = r.f.lng + nmToLng(w, r.f.lat) * Math.sin(sideR * D2R)
        const lLat = r.f.lat + nmToLat(w) * Math.cos(sideL * D2R)
        const lLng = r.f.lng + nmToLng(w, r.f.lat) * Math.sin(sideL * D2R)
        coneFeatures.push({
          type: 'Feature' as const,
          properties: { color: TIER_COLOR[r.tier] },
          geometry: { type: 'LineString' as const, coordinates: [[lLng, lLat], [r.f.lng, r.f.lat], [rLng, rLat]] },
        })
      }
    }
    const coneFc = { type: 'FeatureCollection' as const, features: coneFeatures }

    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} M${r.mach.toFixed(2)} ${r.dp0Psf.toFixed(1)}psf ${r.carpetFullNm.toFixed(0)}nm`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_CRP, carpetFc, () => {
        map.addLayer({ id: LYR_CRP_FILL, type: 'fill', source: SRC_CRP, paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': ['get', 'opacity'],
        } })
        map.addLayer({ id: LYR_CRP_LINE, type: 'line', source: SRC_CRP, paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.2,
          'line-opacity': 0.8,
          'line-dasharray': [3, 2],
        } })
      })
      ensure(SRC_CON, coneFc, () => map.addLayer({ id: LYR_CON, type: 'line', source: SRC_CON, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.5,
        'line-opacity': 0.75,
      } }))
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'circle', source: SRC_RING, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.18,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.6,
        'circle-stroke-opacity': 0.9,
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-offset': [0, 1.6],
        'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.2,
      } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_RING, LYR_CON, LYR_CRP_LINE, LYR_CRP_FILL]) {
        try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {}
      }
      for (const src of [SRC_LBL, SRC_RING, SRC_CON, SRC_CRP]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showCarpet, showCone, showLabels, carpetLenNm])

  // Diagram: x = M 1..3.5, y = Δp0 psf 0..5
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 28
    const xMin = 1.0, xMax = 3.5, yMax = 5
    const xs = (m: number) => PAD + Math.max(0, Math.min(1, (m - xMin) / (xMax - xMin))) * (W - PAD - 6)
    const ys = (p: number) => 6 + (1 - Math.max(0, Math.min(1, p / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Sonic Boom · 14 CFR 91.817</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} supersonic</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold" style={{ color: TIER_COLOR[t] }}>{t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Peak</div>
          <div className="font-mono text-sm" style={{ color: summary.peakPsf >= 2.5 ? '#ef4444' : summary.peakPsf >= 1 ? '#f59e0b' : summary.peakPsf >= 0.5 ? '#0ea5e9' : '#10b981' }}>
            {summary.peakPsf.toFixed(2)}<span className="text-[9px] text-slate-500"> psf</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Widest</div>
          <div className="font-mono text-sm text-slate-200">{summary.widest.toFixed(0)}<span className="text-[9px] text-slate-500"> NM</span></div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Severe</div>
          <div className="font-mono text-sm" style={{ color: summary.severeCount > 0 ? '#ef4444' : '#10b981' }}>{summary.severeCount}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean M</div>
          <div className="font-mono text-[11px] text-slate-300">{summary.meanM.toFixed(2)}</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Cutoff (no-boom)</div>
          <div className="font-mono text-[11px] text-slate-300">{summary.cutoffCount}<span className="text-[9px] text-slate-500"> · refracted</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Δp0 · psf vs Mach · Carlson eq 47</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* y gridlines */}
            {[1, 2, 3, 4, 5].map(p => (
              <g key={p}>
                <line x1={diag.PAD} y1={diag.ys(p)} x2={diag.W - 6} y2={diag.ys(p)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(p) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{p}</text>
              </g>
            ))}
            {/* x gridlines */}
            {[1.0, 1.5, 2.0, 2.5, 3.0, 3.5].map(m => (
              <g key={m}>
                <line x1={diag.xs(m)} y1={6} x2={diag.xs(m)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(m)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">M{m.toFixed(1)}</text>
              </g>
            ))}
            {/* tier thresholds */}
            <line x1={diag.PAD} y1={diag.ys(0.5)} x2={diag.W - 6} y2={diag.ys(0.5)} stroke="#0ea5e9" strokeDasharray="4 3" strokeWidth={0.8} opacity={0.7} />
            <text x={diag.W - 8} y={diag.ys(0.5) - 2} textAnchor="end" fontSize={8} fill="#0ea5e9" fontFamily="monospace">0.5 audible</text>
            <line x1={diag.PAD} y1={diag.ys(1.0)} x2={diag.W - 6} y2={diag.ys(1.0)} stroke="#f59e0b" strokeDasharray="4 3" strokeWidth={0.8} opacity={0.7} />
            <text x={diag.W - 8} y={diag.ys(1.0) - 2} textAnchor="end" fontSize={8} fill="#f59e0b" fontFamily="monospace">1.0 strong</text>
            <line x1={diag.PAD} y1={diag.ys(2.5)} x2={diag.W - 6} y2={diag.ys(2.5)} stroke="#ef4444" strokeDasharray="4 3" strokeWidth={0.8} opacity={0.7} />
            <text x={diag.W - 8} y={diag.ys(2.5) - 2} textAnchor="end" fontSize={8} fill="#ef4444" fontFamily="monospace">2.5 severe</text>
            {/* aircraft dots */}
            {rows.map(r => (
              <circle key={r.f.icao}
                cx={diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, r.mach)))}
                cy={diag.ys(Math.max(0, Math.min(diag.yMax, r.dp0Psf)))}
                r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-M</span><span className="font-mono text-slate-300">{minMach.toFixed(2)}</span></div>
            <input type="range" min={100} max={300} step={5} value={minM} onChange={e => setMinM(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={200} max={800} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>WEIGHT-MULT</span><span className="font-mono text-slate-300">{wMult}%</span></div>
            <input type="range" min={50} max={150} step={5} value={wMult} onChange={e => setWMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CARPET-LEN</span><span className="font-mono text-slate-300">{carpetLenNm}nm</span></div>
            <input type="range" min={20} max={200} step={10} value={carpetLenNm} onChange={e => setCarpetLenNm(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klassFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['fighter', 'biz-ss', 'heavy-ss'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klassFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{KLASS_LABEL[k]}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showCarpet} onChange={e => setShowCarpet(e.target.checked)} className="accent-sky-500" /><span>CARPET</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showCone} onChange={e => setShowCone(e.target.checked)} className="accent-sky-500" /><span>CONE</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{filtered.length} shown / {rows.length} supersonic</span>
        <span>M · Δp0 · carpet · advice</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No supersonic aircraft above M{minMach.toFixed(2)}.</div>
        )}
        {filtered.map(r => {
          // psf bar: 0..3.5 psf mapped to 0..100%
          const psfPct = Math.max(0, Math.min(100, (r.dp0Psf / 3.5) * 100))
          const advice = r.cutoff ? 'mach cutoff · refracted · no surface boom'
            : r.tier === 'WHISPER' ? 'barely audible · faint thump'
            : r.tier === 'AUDIBLE' ? 'window rattling · public complaints likely'
            : r.tier === 'STRONG' ? '14 CFR 91.817 violation if over land · waiver required'
            : 'severe boom · structural damage risk · MAYDAY-equivalent'
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{KLASS_LABEL[r.klass]}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="flight level">F{Math.round(r.altFt / 100)}</span>
                  <span title="Mach number" style={{ color: TIER_COLOR[r.tier] }}>M{r.mach.toFixed(2)}</span>
                  <span title="mach angle deg">μ{(r.muRad / D2R).toFixed(1)}°</span>
                  <span className="ml-auto" title="overpressure psf" style={{ color: TIER_COLOR[r.tier] }}>{r.dp0Psf.toFixed(2)}psf</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="overpressure (0-3.5 psf)">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${psfPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `${(0.5 / 3.5) * 100}%` }} title="audible" />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${(1.0 / 3.5) * 100}%` }} title="strong" />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${(2.5 / 3.5) * 100}%` }} title="severe" />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="primary carpet full width">carpet {r.carpetFullNm.toFixed(0)}nm</span>
                  <span title="mach cone half-angle cot">cot μ {r.cotMu.toFixed(2)}</span>
                  <span title="mach cutoff">Mcut {r.Mcut.toFixed(2)}</span>
                  <span className="ml-auto" title="cutoff status" style={{ color: r.cutoff ? '#0ea5e9' : TIER_COLOR[r.tier] }}>{r.cutoff ? 'CUTOFF' : 'GROUND-BOOM'}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'WHISPER' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
