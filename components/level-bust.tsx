'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Level Bust Predictor  (EUROCONTROL Level Bust Action Plan +
   FAA ALoFT - "Approaching Level Off Tool" passive monitor)
   -----------------------------------------------------------
   A level bust is defined by ICAO Doc 4444 / EUROCONTROL LBAP as
   an unauthorised vertical deviation of >=300ft from a Cleared
   Flight Level (CFL) inside RVSM, or >=200ft outside RVSM. They
   account for ~7% of all reported airprox events in EUR airspace
   (EUROCONTROL Voluntary ATM Incident Reporting 2024). The cause
   matrix is published in EUR LBAP Ed.4:
     - high vertical speed late into capture        ~38%
     - mishearing or partial readback of CFL        ~22%
     - SOP confusion (FL/altitude, QNH/STD)         ~14%
     - altimeter / FCU mis-set                       ~9%
     - distraction during level change              ~17%

   ALoFT (FAA AC 91-79A) recommends decelerating VS to:
       <=  1500 fpm with 2000 ft to go
       <=  1000 fpm with 1000 ft to go
       <=   500 fpm with  500 ft to go
   This tool runs that envelope passively against every climbing
   or descending aircraft.

   Heuristic for the unknown Cleared Flight Level:
   ATC clearances in IFR typically end on standard stop levels.
   We snap to the nearest "common stop" at or beyond current alt
   in the direction of climb/descent, picking from:
     transition altitudes:   3000 4000 5000 6000 7000 8000 9000
                             10000 11000 12000 14000 15000 17000
                             19000 (US TA=18000)
     RVSM/upper:             FL200 220 240 260 280 290 310 330
                             350 370 390 410
   If aircraft is already inside +/-150ft of a 1000ft multiple
   and |VS|<200fpm we mark it LEVEL (no CFL prediction useful).

   Per aircraft computes:
     - altDiff (ft, signed toward CFL)
     - tToLevel (s) = |altDiff| / max(60, |VS_fps|)
     - distToLevel (nm) = tToLevel/3600 * GS
     - captureLead (ft) = (|VS|^2) / (2 * decel_fpm_per_sec * 60)
       using class decel proxy: HVY 180 / NRW 220 / RGN 260 /
       BIZ 260 / TBP 200 / GA 160 / FTR 400 fpm/sec, scaled by
       CAPTURE-MULT slider 60-160%.
     - predicted overshoot (ft) = max(0, captureLead - |altDiff|)
     - ALoFT envelope test: thresholdFpm at this altDiff:
         altDiff<=500   -> 500   fpm
         altDiff<=1000  -> 1000  fpm
         altDiff<=2000  -> 1500  fpm
         altDiff<=3000  -> 2200  fpm
         else           -> 3500  fpm
       envelope excess (fpm) = max(0, |VS| - threshold)
     - intent flag if VS direction disagrees with CFL direction
       (e.g. assigned-level inference picked wrong stop)

   4 tiers:
     BUST    overshoot >=300ft (RVSM) or >=200ft (below FL290)
     ALERT   envelope excess >=300 fpm AND |altDiff|<=2000
     WATCH   envelope excess  >0      OR |VS|>=2500 close-in
     OK      within envelope, within capture lead

   MapLibre overlay:
     - tier-coloured halo on each aircraft sized by predicted
       overshoot ft / 60 (clamped 7..22 px)
     - dashed sky line from aircraft along track at length =
       distToLevel nm (where the predicted level-off happens)
     - amber chevron pin at predicted level-off point for ALERT+
     - tier-coloured callsign + signed VS + CFL pill labels

   Side panel:
     - 5-tier counter strip (BUST/ALERT/WATCH/OK + LEVEL bucket)
     - 3-cell summary: BUST-COUNT / MEAN-OVERSHOOT / WORST-AC
     - 2-cell secondary: ENV-EXCESS-AC / HEAVY-VS-COUNT
     - SVG envelope diagram: x=altDiff 0..3000ft, y=VS 0..4000fpm,
       ALoFT step envelope drawn as a polyline (500/1000/1500/2200
       /3500), every aircraft plotted as tier-coloured dot
     - 5 sliders MIN-FL 0-400 / MAX-FL 50-450 / CAPTURE-MULT
       60-160% / WATCH-VS 1800-3000 fpm / BUST-FT 200-500
     - 7-class chip filter + HALO/PROJ/PIN/LBL/DIAG toggles +
       search + AIRCRAFT/LEVELS tabs
     - AIRCRAFT row: tier stripe, callsign/type/class/tier,
       FL-cur -> FL-pred line, signed VS bar -3000..+3000 fpm
       with ALoFT-threshold tick, envelope-excess+overshoot line,
       capture-lead+to-go nm, advice (ATC report / reduce VS /
       monitor capture / nominal)
     - LEVELS tab grouped by predicted CFL, sorted worst-tier
       first then count desc; click-to-fly to first AC on level
   ============================================================ */

export interface LbFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: number | string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  vertRate: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: LbFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'BUST' | 'ALERT' | 'WATCH' | 'OK' | 'LEVEL'
const TIER_COLOR: Record<Tier, string> = {
  BUST: '#f43f5e',
  ALERT: '#f59e0b',
  WATCH: '#38bdf8',
  OK: '#10b981',
  LEVEL: '#64748b',
}
const TIER_ORDER: Tier[] = ['BUST', 'ALERT', 'WATCH', 'OK', 'LEVEL']
const TIER_RANK: Record<Tier, number> = { BUST: 0, ALERT: 1, WATCH: 2, OK: 3, LEVEL: 4 }

type Klass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const KLASS_LABEL: Record<Klass, string> = {
  HVY: 'Heavy', NRW: 'Narrow', RGN: 'Regional', BIZ: 'Biz-jet', TBP: 'Turboprop', GA: 'GA', FTR: 'Fighter',
}
const KLASS_DECEL: Record<Klass, number> = {
  HVY: 180, NRW: 220, RGN: 260, BIZ: 260, TBP: 200, GA: 160, FTR: 400, // fpm/sec
}
function classifyAc(category?: number | string, type?: string): Klass {
  const t = (type || '').toUpperCase()
  if (/F-?(16|18|22|35)|EUFI|RAFL|MIG|SU-?\d|F15|F14/.test(t)) return 'FTR'
  if (/B74|B77|B78|A35|A38|A34|A33|MD11|IL76|A380|B748/.test(t)) return 'HVY'
  if (/B73|A32|A31|A20N|A21N|B38M|B39M|MD8|MD9|A220/.test(t)) return 'NRW'
  if (/E17|E19|E29|CRJ|ATR|DH8|E145|RJ85|B190|SF34/.test(t)) return /ATR|DH8|B190|SF34/.test(t) ? 'TBP' : 'RGN'
  if (/GLF|GLEX|FA[0-9]|C56|C68|C25|C75|LJ|H25|GL5|GL6|EC45/.test(t)) return 'BIZ'
  const cat = typeof category === 'string' ? parseInt(category, 10) : category
  if (cat === 1) return 'TBP'
  if (cat === 2) return 'NRW'
  if (cat === 3) return 'NRW'
  if (cat === 4) return 'HVY'
  if (cat === 5) return 'HVY'
  if (cat === 6) return 'HVY'
  if (cat === 7) return 'BIZ'
  return 'GA'
}

// Cleared-stop catalog (feet AGL/MSL inferred). Low-altitude stops
// are typical SID/STAR clearance targets. High-altitude stops use
// RVSM 1000-ft separation.
const STOPS: number[] = [
  3000, 4000, 5000, 6000, 7000, 8000, 9000,
  10000, 11000, 12000, 14000, 15000, 17000, 19000,
  20000, 22000, 24000, 26000, 28000, 29000, 31000, 33000, 35000, 37000, 39000, 41000,
]

const SRC_HALO = 'lb-halo-src', LYR_HALO = 'lb-halo-lyr'
const SRC_PROJ = 'lb-proj-src', LYR_PROJ = 'lb-proj-lyr'
const SRC_PIN  = 'lb-pin-src',  LYR_PIN  = 'lb-pin-lyr'
const SRC_LBL  = 'lb-lbl-src',  LYR_LBL  = 'lb-lbl-lyr'

function projAhead(lat: number, lng: number, trackDeg: number, distNm: number): [number, number] {
  const R = 3440.065
  const d = distNm / R
  const θ = trackDeg * Math.PI / 180
  const φ1 = lat * Math.PI / 180, λ1 = lng * Math.PI / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2))
  return [(λ2 * 180 / Math.PI + 540) % 360 - 180, φ2 * 180 / Math.PI]
}

function aloftThresholdFpm(altDiff: number): number {
  const ad = Math.abs(altDiff)
  if (ad <= 500) return 500
  if (ad <= 1000) return 1000
  if (ad <= 2000) return 1500
  if (ad <= 3000) return 2200
  return 3500
}

function inferCFL(currentFt: number, vsFpm: number): { cfl: number | null; level: boolean } {
  const nearestK = Math.round(currentFt / 1000) * 1000
  // already level near a 1000ft step
  if (Math.abs(currentFt - nearestK) <= 150 && Math.abs(vsFpm) < 200) return { cfl: nearestK, level: true }
  if (Math.abs(vsFpm) < 150) return { cfl: nearestK, level: true }
  // climbing
  if (vsFpm > 0) {
    for (const s of STOPS) if (s > currentFt + 200) return { cfl: s, level: false }
    return { cfl: 41000, level: false }
  }
  // descending
  for (let i = STOPS.length - 1; i >= 0; i--) {
    if (STOPS[i] < currentFt - 200) return { cfl: STOPS[i], level: false }
  }
  return { cfl: 3000, level: false }
}

function fmtFL(ft: number): string {
  if (ft >= 18000) return `FL${String(Math.round(ft / 100)).padStart(3, '0')}`
  return `${(ft / 1000).toFixed(0)}k`
}

export default function LevelBustPredictor({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState(0)
  const [maxFL, setMaxFL] = useState(450)
  const [captMult, setCaptMult] = useState(100)   // %
  const [watchVs, setWatchVs] = useState(2500)    // fpm
  const [bustFt, setBustFt] = useState(300)       // ft overshoot threshold
  const [showHalo, setShowHalo] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [klassFilter, setKlassFilter] = useState<Set<Klass>>(new Set(['HVY','NRW','RGN','BIZ','TBP','GA','FTR']))
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'LEVELS'>('AIRCRAFT')
  const [query, setQuery] = useState('')

  type Row = {
    f: LbFlight
    klass: Klass
    cfl: number | null
    altDiff: number       // signed: cfl - cur (climb +, descent -)
    vsAbs: number
    threshold: number
    envelopeExcess: number  // fpm > threshold
    decelFps: number        // fpm/sec
    captureLead: number     // ft needed for level-off
    overshoot: number       // ft predicted past CFL
    tToLevelSec: number
    distNm: number
    tier: Tier
    intentMismatch: boolean
  }

  const rows = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const fl = Math.round(f.altitudeFt / 100)
      if (fl < minFL || fl > maxFL) continue
      if (!Number.isFinite(f.altitudeFt) || !Number.isFinite(f.velocityKts)) continue
      const klass = classifyAc(f.category, f.type)
      const inf = inferCFL(f.altitudeFt, f.vertRate)
      const vsAbs = Math.abs(f.vertRate)
      const decel = KLASS_DECEL[klass] * (captMult / 100)
      // capture lead: stopping distance for VS at given decel
      // VS in fpm, decel in fpm/sec -> stoppingTime sec = VS/decel
      // distance ft = avgVS * t / 60 ; avgVS = VS/2 -> ft = VS^2/(120*decel)
      const captureLead = vsAbs > 0 ? (vsAbs * vsAbs) / (120 * decel) : 0
      const altDiffRaw = inf.cfl != null ? inf.cfl - f.altitudeFt : 0
      const altDiffAbs = Math.abs(altDiffRaw)
      const threshold = aloftThresholdFpm(altDiffRaw)
      const envExcess = Math.max(0, vsAbs - threshold)
      // direction mismatch: climbing toward a CFL below, or descending toward a CFL above
      const intentMismatch = inf.cfl != null && !inf.level &&
        ((f.vertRate > 100 && altDiffRaw < 0) || (f.vertRate < -100 && altDiffRaw > 0))
      const overshoot = inf.level || inf.cfl == null ? 0 : Math.max(0, captureLead - altDiffAbs)
      const tToLevel = vsAbs > 0 ? (altDiffAbs / vsAbs) * 60 : 9999
      const distNm = Math.max(0, (tToLevel / 3600) * Math.max(0, f.velocityKts))

      let tier: Tier
      if (inf.level || inf.cfl == null) tier = 'LEVEL'
      else if (overshoot >= bustFt || intentMismatch) tier = 'BUST'
      else if (envExcess >= 300 && altDiffAbs <= 2000) tier = 'ALERT'
      else if (envExcess > 0 || (vsAbs >= watchVs && altDiffAbs <= 3000)) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, klass, cfl: inf.cfl, altDiff: altDiffRaw, vsAbs,
        threshold, envelopeExcess: envExcess, decelFps: decel,
        captureLead, overshoot, tToLevelSec: tToLevel, distNm,
        tier, intentMismatch,
      })
    }
    return out
  }, [flights, minFL, maxFL, captMult, watchVs, bustFt])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { BUST: 0, ALERT: 0, WATCH: 0, OK: 0, LEVEL: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const summary = useMemo(() => {
    const transitioning = rows.filter(r => r.tier !== 'LEVEL')
    const overshoots = transitioning.map(r => r.overshoot).filter(v => v > 0)
    const meanOver = overshoots.length ? overshoots.reduce((a, b) => a + b, 0) / overshoots.length : 0
    const worst = [...transitioning].sort((a, b) => b.overshoot - a.overshoot || b.envelopeExcess - a.envelopeExcess)[0]
    const envExcessAc = transitioning.filter(r => r.envelopeExcess > 0).length
    const heavyVs = rows.filter(r => r.vsAbs >= watchVs).length
    return { meanOver, worst, envExcessAc, heavyVs }
  }, [rows, watchVs])

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows
      .filter(r => klassFilter.has(r.klass))
      .filter(r => tierFilter === 'ALL' || r.tier === tierFilter)
      .filter(r => !q || r.f.callsign?.toLowerCase().includes(q) || r.f.type?.toLowerCase().includes(q)
        || r.f.operator?.toLowerCase().includes(q) || r.f.icao.toLowerCase().includes(q))
      .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.overshoot - a.overshoot || b.envelopeExcess - a.envelopeExcess)
  }, [rows, klassFilter, tierFilter, query])

  const levelGroups = useMemo(() => {
    const m = new Map<number, { cfl: number; rows: Row[]; worst: Tier }>()
    for (const r of rows) {
      if (r.cfl == null) continue
      const k = r.cfl
      const ex = m.get(k)
      if (!ex) m.set(k, { cfl: k, rows: [r], worst: r.tier })
      else { ex.rows.push(r); if (TIER_RANK[r.tier] < TIER_RANK[ex.worst]) ex.worst = r.tier }
    }
    return [...m.values()]
      .filter(g => tierFilter === 'ALL' || g.worst === tierFilter || g.rows.some(r => r.tier === tierFilter))
      .sort((a, b) => TIER_RANK[a.worst] - TIER_RANK[b.worst] || b.rows.length - a.rows.length)
  }, [rows, tierFilter])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC_HALO)) map.addSource(SRC_HALO, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_HALO)) map.addLayer({
          id: LYR_HALO, type: 'circle', source: SRC_HALO,
          paint: { 'circle-radius': ['get', 'r'], 'circle-color': 'transparent',
            'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-opacity': 0.85 },
        })
        if (!map.getSource(SRC_PROJ)) map.addSource(SRC_PROJ, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_PROJ)) map.addLayer({
          id: LYR_PROJ, type: 'line', source: SRC_PROJ,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.7, 'line-dasharray': [2, 2] },
        })
        if (!map.getSource(SRC_PIN)) map.addSource(SRC_PIN, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_PIN)) map.addLayer({
          id: LYR_PIN, type: 'circle', source: SRC_PIN,
          paint: { 'circle-radius': 4.5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0f172a', 'circle-stroke-width': 1.2, 'circle-opacity': 0.9 },
        })
        if (!map.getSource(SRC_LBL)) map.addSource(SRC_LBL, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_LBL)) map.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC_LBL,
          layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, -1.4], 'text-anchor': 'bottom', 'text-allow-overlap': true },
          paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.2 },
        })
      } catch {}
    }
    ensure()

    const haloF: any[] = [], projF: any[] = [], pinF: any[] = [], lblF: any[] = []
    for (const r of rows) {
      if (r.tier === 'LEVEL') continue
      const color = TIER_COLOR[r.tier]
      if (showHalo) {
        haloF.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: { color, r: Math.max(7, Math.min(22, 7 + r.overshoot / 60 + r.envelopeExcess / 400)) },
        })
      }
      if (showProj && r.distNm > 0.5 && r.distNm < 200) {
        const [eLng, eLat] = projAhead(r.f.lat, r.f.lng, r.f.track, r.distNm)
        projF.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [eLng, eLat]] },
          properties: { color: r.tier === 'BUST' || r.tier === 'ALERT' ? color : '#38bdf8' },
        })
        if (showPin && (r.tier === 'BUST' || r.tier === 'ALERT')) {
          pinF.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [eLng, eLat] },
            properties: { color },
          })
        }
      }
      if (showLbl && (r.tier === 'BUST' || r.tier === 'ALERT' || r.tier === 'WATCH')) {
        const arrow = r.altDiff > 0 ? '\u2191' : r.altDiff < 0 ? '\u2193' : '\u2014'
        const vsLab = `${r.f.vertRate >= 0 ? '+' : ''}${Math.round(r.f.vertRate)}fpm`
        const cflLab = r.cfl != null ? fmtFL(r.cfl) : '?'
        lblF.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: { color, label: `${r.f.callsign?.trim() || r.f.icao} ${arrow}${cflLab} ${vsLab}` },
        })
      }
    }
    try {
      ;(map.getSource(SRC_HALO) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: haloF })
      ;(map.getSource(SRC_PROJ) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: projF })
      ;(map.getSource(SRC_PIN) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: pinF })
      ;(map.getSource(SRC_LBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lblF })
    } catch {}
  }, [map, rows, showHalo, showProj, showPin, showLbl])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_LBL, LYR_PIN, LYR_PROJ, LYR_HALO]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_LBL, SRC_PIN, SRC_PROJ, SRC_HALO]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  // ---- envelope diagram ----
  const diag = useMemo(() => {
    const W = 380, H = 170, padL = 28, padR = 6, padT = 8, padB = 18
    const xMax = 3000, yMax = 4000
    const x = (v: number) => padL + (Math.min(xMax, Math.max(0, v)) / xMax) * (W - padL - padR)
    const y = (v: number) => H - padB - (Math.min(yMax, Math.max(0, v)) / yMax) * (H - padT - padB)
    // ALoFT envelope step polyline
    const env: [number, number][] = [
      [0, 500], [500, 500], [500, 1000], [1000, 1000], [1000, 1500],
      [2000, 1500], [2000, 2200], [3000, 2200], [3000, 3500],
    ]
    return { W, H, padL, padR, padT, padB, xMax, yMax, x, y, env }
  }, [])

  const toggleKlass = (k: Klass) => setKlassFilter(prev => {
    const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n
  })

  return (
    <div className="fixed top-16 right-3 z-40 w-[420px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">&#8645;</span>
          <span className="text-sm font-semibold tracking-wide">LEVEL BUST PREDICTOR</span>
          <span className="text-[10px] text-slate-500">ALoFT / EUR LBAP</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">&times;</button>
      </div>

      {/* tier strip */}
      <div className="px-3 py-2 grid grid-cols-5 gap-1 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t}
            onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/40 bg-sky-500/15' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }} title={t}>
            <span className="text-[9px] tracking-wider">{t}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      {/* summary 3-cell */}
      <div className="px-3 py-2 grid grid-cols-3 gap-1 border-b border-slate-800">
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">BUST</span>
          <span className="text-sm font-mono" style={{ color: counts.BUST ? TIER_COLOR.BUST : '#cbd5e1' }}>{counts.BUST}</span>
        </div>
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">MEAN-OVERSHOOT</span>
          <span className="text-sm font-mono" style={{ color: summary.meanOver > bustFt ? TIER_COLOR.BUST : summary.meanOver > 100 ? TIER_COLOR.ALERT : '#cbd5e1' }}>{summary.meanOver.toFixed(0)}ft</span>
        </div>
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">WORST</span>
          <span className="text-[11px] font-mono truncate" style={{ color: summary.worst ? TIER_COLOR[summary.worst.tier] : '#cbd5e1' }}>
            {summary.worst ? `${summary.worst.f.callsign?.trim() || summary.worst.f.icao} +${summary.worst.overshoot.toFixed(0)}ft` : '\u2014'}
          </span>
        </div>
      </div>

      {/* secondary 2-cell */}
      <div className="px-3 py-2 grid grid-cols-2 gap-1 border-b border-slate-800">
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">ENV-EXCESS-AC</span>
          <span className="text-sm font-mono" style={{ color: summary.envExcessAc ? TIER_COLOR.ALERT : '#cbd5e1' }}>{summary.envExcessAc}</span>
        </div>
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">HEAVY-VS &ge;{watchVs}fpm</span>
          <span className="text-sm font-mono" style={{ color: summary.heavyVs ? TIER_COLOR.WATCH : '#cbd5e1' }}>{summary.heavyVs}</span>
        </div>
      </div>

      {/* envelope diagram */}
      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider mb-1">
            <span>ALoFT ENVELOPE  |VS| vs ALT-TO-GO</span>
            <span>x: ft   y: fpm</span>
          </div>
          <svg viewBox={`0 0 ${diag.W} ${diag.H}`} className="w-full bg-slate-900/50 rounded">
            {/* axes */}
            {[0, 500, 1000, 1500, 2000, 2500, 3000].map(v => (
              <g key={`vx${v}`}>
                <line x1={diag.x(v)} x2={diag.x(v)} y1={diag.padT} y2={diag.H - diag.padB} stroke="#1e293b" strokeWidth={v === 0 ? 0.6 : 0.3} />
                <text x={diag.x(v)} y={diag.H - 4} fill="#475569" fontSize="7" textAnchor="middle">{v}</text>
              </g>
            ))}
            {[0, 1000, 2000, 3000, 4000].map(v => (
              <g key={`vy${v}`}>
                <line x1={diag.padL} x2={diag.W - diag.padR} y1={diag.y(v)} y2={diag.y(v)} stroke="#1e293b" strokeWidth={v === 0 ? 0.6 : 0.3} />
                <text x={diag.padL - 3} y={diag.y(v) + 3} fill="#475569" fontSize="7" textAnchor="end">{v}</text>
              </g>
            ))}
            {/* envelope polyline */}
            <polyline
              points={diag.env.map(([a, v]) => `${diag.x(a)},${diag.y(v)}`).join(' ')}
              fill="none" stroke="#10b981" strokeWidth={1.2} strokeDasharray="3 2" opacity={0.85} />
            <text x={diag.W - diag.padR - 2} y={diag.y(3500) - 2} fill="#10b981" fontSize="7" textAnchor="end" opacity={0.85}>ALoFT envelope</text>
            {/* aircraft dots */}
            {rows.filter(r => r.tier !== 'LEVEL').map((r, i) => (
              <circle key={i} cx={diag.x(Math.abs(r.altDiff))} cy={diag.y(r.vsAbs)} r={1.8}
                fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
              <span>MIN-FL</span><span className="font-mono text-slate-300">FL{String(minFL).padStart(3, '0')}</span>
            </div>
            <input type="range" min={0} max={400} step={10} value={minFL} onChange={e => setMinFL(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
              <span>MAX-FL</span><span className="font-mono text-slate-300">FL{String(maxFL).padStart(3, '0')}</span>
            </div>
            <input type="range" min={50} max={450} step={10} value={maxFL} onChange={e => setMaxFL(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
              <span>CAPTURE-MULT</span><span className="font-mono text-slate-300">{captMult}%</span>
            </div>
            <input type="range" min={60} max={160} step={5} value={captMult} onChange={e => setCaptMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
              <span>WATCH-VS</span><span className="font-mono text-slate-300">{watchVs}fpm</span>
            </div>
            <input type="range" min={1800} max={3500} step={100} value={watchVs} onChange={e => setWatchVs(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>BUST-OVERSHOOT</span><span className="font-mono text-slate-300">{bustFt}ft</span>
          </div>
          <input type="range" min={200} max={500} step={25} value={bustFt} onChange={e => setBustFt(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap gap-1">
          {(Object.keys(KLASS_LABEL) as Klass[]).map(k => (
            <button key={k} onClick={() => toggleKlass(k)}
              className={`text-[9px] tracking-wider px-1.5 py-0.5 rounded border ${klassFilter.has(k) ? 'border-sky-500/40 bg-sky-500/15 text-slate-100' : 'border-slate-800 bg-slate-900/40 text-slate-500'}`}>
              {k}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLbl} onChange={e => setShowLbl(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/40 outline-none" />
        <div className="flex items-center gap-1">
          {(['AIRCRAFT', 'LEVELS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 text-[10px] tracking-wider px-2 py-1 rounded border ${tab === t ? 'border-sky-500/40 bg-sky-500/15 text-slate-100' : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:text-slate-200'}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <>
            {filteredRows.length === 0 && <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>}
            {filteredRows.map((r, i) => {
              const advice = r.tier === 'BUST'
                ? (r.intentMismatch ? 'wrong-direction \u2014 verify CFL & altimeter (LBAP)' : 'predicted overshoot \u2014 reduce VS immediately')
                : r.tier === 'ALERT' ? 'reduce VS to ALoFT envelope before capture'
                : r.tier === 'WATCH' ? 'monitor VS during level capture'
                : r.tier === 'OK' ? 'nominal capture envelope'
                : 'level, no CFL transition'
              const vsSpan = 3000
              const vsPct = Math.max(0, Math.min(1, (r.f.vertRate + vsSpan) / (2 * vsSpan)))
              return (
                <button key={`${r.f.icao}-${i}`} onClick={() => onFly(r.f.icao)}
                  className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
                  <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-mono font-semibold truncate text-slate-100">{r.f.callsign?.trim() || r.f.icao}</span>
                      <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                      <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded border border-slate-700 text-slate-300">{r.klass}</span>
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border" style={{ color: TIER_COLOR[r.tier], borderColor: TIER_COLOR[r.tier] + '66' }}>{r.tier}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                      <span>{fmtFL(r.f.altitudeFt)}</span>
                      <span className="text-slate-600">{r.altDiff > 0 ? '\u2191' : r.altDiff < 0 ? '\u2193' : '\u2014'}</span>
                      <span className="text-sky-300">{r.cfl != null ? fmtFL(r.cfl) : '?'}</span>
                      <span>{r.distNm.toFixed(1)}nm</span>
                      <span className="ml-auto" style={{ color: TIER_COLOR[r.tier] }}>{r.f.vertRate >= 0 ? '+' : ''}{Math.round(r.f.vertRate)}fpm</span>
                    </div>
                    {/* VS bar -3000..+3000 with threshold tick */}
                    <div className="flex items-center gap-2 text-[10px] mt-0.5">
                      <div className="flex-1 h-1.5 bg-slate-900 rounded overflow-hidden relative">
                        <div className="absolute inset-y-0" style={{ left: '50%', width: 1, background: '#475569' }} />
                        {/* threshold ticks */}
                        <div className="absolute inset-y-0" style={{ left: `${(0.5 + r.threshold / 6000) * 100}%`, width: 1, background: '#10b981', opacity: 0.7 }} />
                        <div className="absolute inset-y-0" style={{ left: `${(0.5 - r.threshold / 6000) * 100}%`, width: 1, background: '#10b981', opacity: 0.7 }} />
                        <div className="absolute inset-y-0" style={{ left: `${vsPct * 100}%`, width: 2, background: TIER_COLOR[r.tier] }} />
                      </div>
                      <span className="font-mono text-slate-500">env{r.threshold}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] font-mono mt-0.5">
                      <span style={{ color: r.envelopeExcess > 0 ? TIER_COLOR.ALERT : '#94a3b8' }}>excess +{r.envelopeExcess.toFixed(0)}fpm</span>
                      <span style={{ color: r.overshoot >= bustFt ? TIER_COLOR.BUST : r.overshoot > 100 ? TIER_COLOR.ALERT : '#94a3b8' }}>overshoot +{r.overshoot.toFixed(0)}ft</span>
                      <span className="ml-auto text-slate-500">lead {r.captureLead.toFixed(0)}ft</span>
                    </div>
                    <div className="text-[10px] text-slate-600 truncate mt-0.5">
                      t-to-lvl {r.tToLevelSec < 600 ? `${Math.round(r.tToLevelSec)}s` : '\u2014'}
                      &middot; decel {r.decelFps.toFixed(0)}fpm/s
                      {r.intentMismatch && <span className="text-rose-400"> &middot; DIR-MISMATCH</span>}
                      &middot; {r.f.operator || '\u2014'}
                    </div>
                    <div className="text-[10px] mt-0.5" style={{ color: TIER_COLOR[r.tier] }}>{advice}</div>
                  </div>
                </button>
              )
            })}
          </>
        )}
        {tab === 'LEVELS' && (
          <>
            {levelGroups.length === 0 && <div className="px-3 py-6 text-center text-xs text-slate-500">No predicted level groups.</div>}
            {levelGroups.map(g => {
              const meanOver = g.rows.reduce((a, r) => a + r.overshoot, 0) / g.rows.length
              const worstRow = [...g.rows].sort((a, b) => b.overshoot - a.overshoot)[0]
              const climbCount = g.rows.filter(r => r.altDiff > 0).length
              const descCount = g.rows.filter(r => r.altDiff < 0).length
              return (
                <button key={g.cfl} onClick={() => worstRow && onFly(worstRow.f.icao)}
                  className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
                  <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[g.worst] }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-mono font-semibold text-sky-300">{fmtFL(g.cfl)}</span>
                      <span className="text-slate-500">{g.rows.length} ac</span>
                      <span className="text-slate-500 text-[10px]">&#8593;{climbCount} &#8595;{descCount}</span>
                      <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded border" style={{ color: TIER_COLOR[g.worst], borderColor: TIER_COLOR[g.worst] + '66' }}>{g.worst}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                      <span>mean overshoot</span>
                      <span style={{ color: meanOver > bustFt ? TIER_COLOR.BUST : meanOver > 100 ? TIER_COLOR.ALERT : '#94a3b8' }}>{meanOver.toFixed(0)}ft</span>
                      <span className="ml-auto">worst {worstRow ? worstRow.f.callsign?.trim() || worstRow.f.icao : '\u2014'}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] mt-0.5">
                      <div className="flex-1 h-1.5 bg-slate-900 rounded overflow-hidden relative">
                        <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, (meanOver / bustFt) * 50)}%`, background: TIER_COLOR[g.worst] }} />
                      </div>
                      <span className="font-mono text-slate-500">{Math.min(100, (meanOver / bustFt) * 50).toFixed(0)}%</span>
                    </div>
                    <div className="text-[10px] text-slate-600 truncate mt-0.5">
                      busts {g.rows.filter(r => r.tier === 'BUST').length} &middot; alerts {g.rows.filter(r => r.tier === 'ALERT').length}
                      &middot; first {g.rows.slice(0, 3).map(r => r.f.callsign?.trim() || r.f.icao).join(' ')}
                    </div>
                  </div>
                </button>
              )
            })}
          </>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 tracking-wider flex justify-between">
        <span>BUST&ge;{bustFt}ft overshoot or dir-mismatch &middot; ALERT env+300fpm</span>
        <span>{rows.length} AC</span>
      </div>
    </div>
  )
}
