'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   OPTIMUM-ALTITUDE / SPECIFIC-RANGE / TROPOPAUSE CRUISE ADVISOR
   -----------------------------------------------------------
   Per-airframe enroute monitor evaluating the delta between
   the aircraft's current cruise flight-level and the OEM
   optimum altitude OPT-FL for current gross-weight & ISA
   deviation, the specific-air-range penalty pct from flying
   off-optimum, the tropopause height vs aircraft FL (engine
   thrust falls sharply above tropopause), and the next
   recommended step-climb / step-descent per OFP block
   conventions (RVSM ±2000 / ±1000 ft).

   References
     · ICAO Annex 6 Pt I §4.3.5 fuel planning
     · ICAO Doc 7488 Standard Atmosphere (ISA)
     · ICAO Doc 9613 PBN Manual §4 Optimum FL
     · FAA AC 91-70B Oceanic & International §4 cruise FL
     · FAA AC 120-103A flight planning §5 step-climb policy
     · FAA Order JO 7110.65 §8-1 oceanic vertical separation
     · RVSM AC 91-85 / EASA AMC 20-26 vertical FL spacing
     · IATA Fuel Efficiency Best Practice ed.4 §2.4 step-climb
     · Boeing AERO Q4-2007 Optimum Altitude
     · Boeing FCOM PI ch 1 Cruise Performance
     · Airbus FCOM PER-CRZ-MAX / PER-CRZ-OPT
     · Airbus Getting-to-Grips-With Fuel Economy §3.2
     · Embraer AOM 4.10 cruise performance
     · NBAA Op Bull #11 step-climb best practice
     · NOAA ARL global tropopause analyses (250 hPa proxy)
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'STEP-NOW' | 'OFF-OPT' | 'WATCH' | 'OPT' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'STEP-NOW': '#ef4444', 'OFF-OPT': '#f59e0b', WATCH: '#0ea5e9', OPT: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['STEP-NOW', 'OFF-OPT', 'WATCH', 'OPT']
const TIER_RANK: Record<Tier, number> = { 'STEP-NOW': 0, 'OFF-OPT': 1, WATCH: 2, OPT: 3, IDLE: 4 }

type Phase = 'CRZ-HI' | 'CRZ-LO' | 'CLB' | 'DES' | 'OTHER'
const PHASE_MUL: Record<Phase, number> = { 'CRZ-HI': 1.40, 'CRZ-LO': 1.25, CLB: 0.60, DES: 0.55, OTHER: 0.30 }

type AcClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
interface ClassSpec {
  family: string
  /* OPT-FL at MTOW (ISA, FL units) */
  optAtMtow: number
  /* OPT-FL at OEW (light) */
  optAtLight: number
  /* MAX-FL hard cert ceiling */
  maxFl: number
  /* SAR penalty per 1000 ft below OPT (pct per kft) */
  sarBelowPctKft: number
  /* SAR penalty per 1000 ft above OPT (pct per kft, sharper near coffin-corner) */
  sarAbovePctKft: number
  /* typical step size ft */
  stepFt: number
  /* nominal cruise Mach */
  mach: number
}
const CLASS_SPEC: Record<AcClass, ClassSpec> = {
  'HVY-Q': { family: '747-8 / A380',                optAtMtow: 310, optAtLight: 410, maxFl: 430, sarBelowPctKft: 0.9, sarAbovePctKft: 1.8, stepFt: 2000, mach: 0.85 },
  'HVY':   { family: '777 / 787 / A350 / A330',     optAtMtow: 330, optAtLight: 430, maxFl: 430, sarBelowPctKft: 1.0, sarAbovePctKft: 2.0, stepFt: 2000, mach: 0.84 },
  'NRW':   { family: '737 / A320 / 757 / A321XLR',  optAtMtow: 350, optAtLight: 410, maxFl: 410, sarBelowPctKft: 1.1, sarAbovePctKft: 2.3, stepFt: 2000, mach: 0.78 },
  'RGN':   { family: 'CRJ / E-Jet / regional',      optAtMtow: 330, optAtLight: 410, maxFl: 410, sarBelowPctKft: 1.2, sarAbovePctKft: 2.6, stepFt: 2000, mach: 0.74 },
  'BIZ':   { family: 'GLF / G650 / FA7X / CL30',    optAtMtow: 410, optAtLight: 510, maxFl: 510, sarBelowPctKft: 0.8, sarAbovePctKft: 1.5, stepFt: 2000, mach: 0.85 },
  'TBP':   { family: 'ATR / Q400 / turboprop',      optAtMtow: 200, optAtLight: 250, maxFl: 270, sarBelowPctKft: 1.6, sarAbovePctKft: 3.0, stepFt: 1000, mach: 0.55 },
}
const FAMILY_CLASS: Array<[RegExp, AcClass]> = [
  [/^(B748|A388|A38)/i, 'HVY-Q'],
  [/^(B77|77[0-9]|B78|78[0-9]|A33|A35|A340|A30)/i, 'HVY'],
  [/^(B73|73[0-9]|A31|A32|MAX|B75|75[0-9])/i, 'NRW'],
  [/^(CRJ|E1[79][05]|E190|E195|RJ1H|DH8|AT[47])/i, 'RGN'],
  [/^(GLF|G[VI]|G[56]|GLEX|FA[57]X|CL[36]0|LJ[34567])/i, 'BIZ'],
  [/^(AT[47]|DH8|DHC|SF[35]|BE20)/i, 'TBP'],
]
function classify(t?: string): AcClass {
  const s = (t || '').toUpperCase().trim()
  for (const [re, c] of FAMILY_CLASS) if (re.test(s)) return c
  return 'NRW'
}

type Driver = 'SAR' | 'STP' | 'TRP' | 'BUF' | 'ISA' | 'WND' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  SAR: 'Specific-air-range penalty off OPT',
  STP: 'Step-climb / step-descent overdue',
  TRP: 'Above tropopause — thrust margin eroded',
  BUF: 'Buffet boundary close to FL',
  ISA: 'ISA deviation degrades OPT',
  WND: 'Wind layer worse than next-FL band',
  NONE: 'Cruise nominal',
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

/* Tropopause model: ICAO Doc 7488 standard 36089 ft (FL360) at
   ISA, but real tropopause varies 28-55 kft. Approximation:
   high near equator (~FL550), low near poles (~FL280), with
   seasonal/season bias and per-airframe hash noise. */
function tropopauseFl(lat: number, hashNoise: number, seasonBias: number): number {
  const absLat = Math.abs(lat)
  const base = 540 - (absLat / 90) * 260  // 540 at eq → 280 at pole
  const noise = (hashNoise - 0.5) * 30
  return Math.round(base + seasonBias + noise)
}

/* ISA deviation: temperature offset from standard at FL. */
function isaDevC(lat: number, hashNoise: number, seasonBias: number): number {
  const absLat = Math.abs(lat)
  const polarBias = -(absLat - 30) / 60 * 8  // cold at poles
  return Math.round(polarBias + seasonBias + (hashNoise - 0.5) * 18)
}

/* Specific-air-range penalty pct from being off OPT.
   Convex piecewise: penalty grows linearly below OPT and
   quadratically above (buffet onset). */
function sarPenaltyPct(currentFl: number, optFl: number, spec: ClassSpec): number {
  const dKft = (currentFl - optFl) / 10  // positive = above OPT
  if (Math.abs(dKft) < 0.5) return 0
  if (dKft < 0) return -dKft * spec.sarBelowPctKft
  // above: quadratic-ish, scaled
  return dKft * spec.sarAbovePctKft + (dKft * dKft) * 0.15
}

/* Recommend next step relative to OPT, rounded to RVSM band. */
function recommendStep(currentFl: number, optFl: number, spec: ClassSpec, oddTrack: boolean): { dir: 'UP' | 'DN' | 'NONE'; targetFl: number; deltaFt: number } {
  const dKft = (currentFl - optFl) / 10
  if (Math.abs(dKft) < 1.5) return { dir: 'NONE', targetFl: currentFl, deltaFt: 0 }
  // RVSM odd vs even hemisphere (250E heuristic)
  const stepFl = spec.stepFt / 100
  let target = currentFl + (dKft < 0 ? stepFl : -stepFl)
  // round to nearest RVSM band parity
  const isOdd = oddTrack
  while ((Math.round(target / 10) % 2 === 0) !== !isOdd) target += (dKft < 0 ? 10 : -10)
  if (target > spec.maxFl) target = currentFl
  return { dir: dKft < 0 ? 'UP' : 'DN', targetFl: target, deltaFt: (target - currentFl) * 100 }
}

interface Row {
  f: SFlight; cls: AcClass; spec: ClassSpec; phase: Phase
  fl: number; optFl: number; maxFl: number; tropFl: number
  isaDev: number; togwFrac: number  // 0.7..1.0 (light..MTOW)
  sarPenaltyPct: number
  step: ReturnType<typeof recommendStep>
  windDeltaKt: number  // kt difference vs next FL
  buffetMarginG: number  // 0.0..0.6 g margin
  sev: { sar: number; stp: number; trp: number; buf: number; isa: number; wnd: number }
  score: number; driver: Driver; tier: Tier
}

const SRC_HALO='oa-halo', SRC_LBL='oa-lbl', SRC_PIN='oa-pin', SRC_VEC='oa-vec', SRC_TRP='oa-trp', SRC_REF='oa-ref'
const LYR_HALO=SRC_HALO+'-l', LYR_LBL=SRC_LBL+'-l', LYR_PIN=SRC_PIN+'-l', LYR_VEC=SRC_VEC+'-l', LYR_TRP=SRC_TRP+'-l', LYR_REF=SRC_REF+'-l'

export default function OptAltCruise({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES' | 'BANDS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(180)
  const [seasonBias, setSeasonBias] = useState(0)   // -25..+25 (winter..summer)
  const [isaOffset, setIsaOffset] = useState(0)     // -20..+20 C global bias
  const [weightBias, setWeightBias] = useState(0)   // -20..+20 pct TOGW
  const [optMul, setOptMul] = useState(100)
  const [sarMul, setSarMul] = useState(100)
  const [windDelta, setWindDelta] = useState(0)     // -40..+40 kt
  const [phaseWt, setPhaseWt] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showVec, setShowVec] = useState(true)   // step-vector
  const [showTrp, setShowTrp] = useState(true)   // tropopause band markers
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      if (f.altitudeFt < minFl * 100) continue
      const cls = classify(f.type)
      if (classFilter !== 'ALL' && cls !== classFilter) continue
      const spec = CLASS_SPEC[cls]
      const h = hash32(f.icao || '')
      const u0 = (h & 0xffff) / 0xffff
      const u1 = ((h >>> 16) & 0xffff) / 0xffff
      const u2 = (((h >>> 8) ^ h) & 0xffff) / 0xffff

      const fl = Math.round(f.altitudeFt / 100)
      const tropFl = tropopauseFl(f.lat, u0, seasonBias)
      const isaDev = isaDevC(f.lat, u1, isaOffset) + isaOffset

      // TOGW frac 0.7..1.0 from hash (proxy for fuel burn since takeoff)
      const togwFrac = Math.max(0.65, Math.min(1.0, 0.72 + u2 * 0.30 + weightBias / 100))
      // OPT-FL linear interp from light↔MTOW band by togwFrac
      const optFlBase = spec.optAtLight + (spec.optAtMtow - spec.optAtLight) * togwFrac
      // ISA-dev shift: each +10 C ISA-dev pushes OPT ~1500 ft lower
      const optFlIsa = optFlBase - (isaDev / 10) * 15
      const optFl = Math.round(optFlIsa * (optMul / 100))
      const maxFl = spec.maxFl

      const phase: Phase = Math.abs(f.vertRate) > 800 ? (f.vertRate > 0 ? 'CLB' : 'DES')
        : fl >= 290 ? 'CRZ-HI' : fl >= 180 ? 'CRZ-LO' : 'OTHER'

      const sarPen = sarPenaltyPct(fl, optFl, spec) * (sarMul / 100)

      // tropopause delta (positive = above tropopause)
      const aboveTropKft = (fl - tropFl) / 10

      // step recommendation
      const oddTrack = (f.track >= 0 && f.track < 180)
      const step = recommendStep(fl, optFl, spec, oddTrack)

      // wind-layer delta vs next FL (hash-stable)
      const windDeltaKt = Math.round(windDelta + (u0 - 0.5) * 24)

      // buffet margin g (synthetic): pinch at coffin corner — drops near max-FL above OPT
      let buffetMarginG = 0.45 - Math.max(0, (fl - optFl) / 1000) * 0.10
      if (fl >= maxFl - 5) buffetMarginG -= 0.10
      buffetMarginG = Math.max(0, Math.min(0.6, buffetMarginG))

      // drivers
      let sar = 0
      const absPen = Math.abs(sarPen)
      if (absPen >= 6) sar = 100
      else if (absPen >= 4) sar = 80
      else if (absPen >= 2.5) sar = 55
      else if (absPen >= 1.5) sar = 30
      else if (absPen >= 0.7) sar = 12

      let stp = 0
      if (Math.abs(step.deltaFt) >= 4000) stp = 90
      else if (Math.abs(step.deltaFt) >= 2000) stp = 60
      else if (Math.abs(step.deltaFt) >= 1000) stp = 30

      let trp = 0
      if (aboveTropKft >= 4) trp = 100
      else if (aboveTropKft >= 2) trp = 70
      else if (aboveTropKft >= 0.5) trp = 35
      else if (aboveTropKft >= -1) trp = 10

      let buf = 0
      if (buffetMarginG <= 0.10) buf = 100
      else if (buffetMarginG <= 0.20) buf = 75
      else if (buffetMarginG <= 0.30) buf = 40
      else if (buffetMarginG <= 0.40) buf = 15

      let isa = 0
      const absIsa = Math.abs(isaDev)
      if (absIsa >= 18) isa = 75
      else if (absIsa >= 12) isa = 50
      else if (absIsa >= 7) isa = 25
      else if (absIsa >= 3) isa = 10

      let wnd = 0
      const absWnd = Math.abs(windDeltaKt)
      if (absWnd >= 35) wnd = 70
      else if (absWnd >= 22) wnd = 45
      else if (absWnd >= 12) wnd = 22

      const sev = { sar: Math.round(sar), stp: Math.round(stp), trp: Math.round(trp), buf: Math.round(buf), isa: Math.round(isa), wnd: Math.round(wnd) }
      const sevArr = [
        { d: 'SAR' as Driver, v: sev.sar },
        { d: 'STP' as Driver, v: sev.stp },
        { d: 'TRP' as Driver, v: sev.trp },
        { d: 'BUF' as Driver, v: sev.buf },
        { d: 'ISA' as Driver, v: sev.isa },
        { d: 'WND' as Driver, v: sev.wnd },
      ].sort((a, b) => b.v - a.v)
      const maxDriver = sevArr[0]
      const secondary = sevArr[1].v
      let composite = maxDriver.v * PHASE_MUL[phase] * (phaseWt / 100) + 0.12 * secondary
      // hard escalations
      if (buffetMarginG <= 0.10 && phase === 'CRZ-HI') composite = Math.max(composite, 92)
      if (Math.abs(sarPen) >= 6 && (phase === 'CRZ-HI' || phase === 'CRZ-LO')) composite = Math.max(composite, 82)
      if (aboveTropKft >= 4 && phase !== 'OTHER') composite = Math.max(composite, 78)
      composite = Math.max(0, Math.min(100, composite))

      let tier: Tier
      if (composite >= 80) tier = 'STEP-NOW'
      else if (composite >= 55) tier = 'OFF-OPT'
      else if (composite >= 25) tier = 'WATCH'
      else tier = 'OPT'

      out.push({
        f, cls, spec, phase, fl, optFl, maxFl, tropFl, isaDev, togwFrac,
        sarPenaltyPct: sarPen, step, windDeltaKt, buffetMarginG,
        sev, score: Math.round(composite),
        driver: maxDriver.v > 0 ? maxDriver.d : 'NONE',
        tier,
      })
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, minFl, classFilter, seasonBias, isaOffset, weightBias, optMul, sarMul, windDelta, phaseWt])

  const tierCount = useMemo(() => {
    const c: Record<Tier, number> = { 'STEP-NOW': 0, 'OFF-OPT': 0, WATCH: 0, OPT: 0, IDLE: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const active = rows
  const meanSarPen = active.length ? active.reduce((s, r) => s + Math.abs(r.sarPenaltyPct), 0) / active.length : 0
  const meanDelta = active.length ? active.reduce((s, r) => s + (r.fl - r.optFl), 0) / active.length : 0
  const worst = active[0]
  const aboveTropShare = active.length ? active.filter(r => (r.fl - r.tropFl) >= 5).length / active.length : 0
  const buffetShare = active.length ? active.filter(r => r.buffetMarginG <= 0.20).length / active.length : 0

  const classRows = useMemo(() => {
    const keys: AcClass[] = ['HVY-Q', 'HVY', 'NRW', 'RGN', 'BIZ', 'TBP']
    return keys.map(k => {
      const rs = rows.filter(r => r.cls === k)
      const ac = rs.length
      const stp = rs.filter(r => r.tier === 'STEP-NOW').length
      const off = rs.filter(r => r.tier === 'OFF-OPT').length
      const mean = ac ? rs.reduce((s, r) => s + r.score, 0) / ac : 0
      const meanPen = ac ? rs.reduce((s, r) => s + Math.abs(r.sarPenaltyPct), 0) / ac : 0
      const meanDelta = ac ? rs.reduce((s, r) => s + (r.fl - r.optFl), 0) / ac : 0
      return { k, spec: CLASS_SPEC[k], ac, stp, off, mean, meanPen, meanDelta }
    })
  }, [rows])

  // FL-band histogram (every 20 FL bucket from 180..510)
  const bandRows = useMemo(() => {
    const bands: { lo: number; hi: number; ac: number; stp: number; off: number; meanPen: number }[] = []
    for (let lo = 180; lo < 520; lo += 20) {
      bands.push({ lo, hi: lo + 19, ac: 0, stp: 0, off: 0, meanPen: 0 })
    }
    for (const r of rows) {
      const idx = Math.min(bands.length - 1, Math.max(0, Math.floor((r.fl - 180) / 20)))
      bands[idx].ac++
      if (r.tier === 'STEP-NOW') bands[idx].stp++
      if (r.tier === 'OFF-OPT') bands[idx].off++
      bands[idx].meanPen += Math.abs(r.sarPenaltyPct)
    }
    for (const b of bands) b.meanPen = b.ac ? b.meanPen / b.ac : 0
    return bands.filter(b => b.ac > 0)
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return active.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (!q) return true
      const hay = `${r.f.callsign || ''} ${r.f.type || ''} ${r.f.icao || ''} ${r.f.operator || ''} ${r.cls}`.toLowerCase()
      return hay.includes(q)
    })
  }, [active, tierFilter, query])

  // Map overlay
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      const ensureSrc = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any) }
      ;[SRC_HALO, SRC_LBL, SRC_PIN, SRC_VEC, SRC_TRP, SRC_REF].forEach(ensureSrc)
      if (!map.getLayer(LYR_REF)) map.addLayer({ id: LYR_REF, source: SRC_REF, type: 'line', paint: { 'line-color': '#0ea5e9', 'line-width': 0.3, 'line-opacity': 0.18, 'line-dasharray': [3, 5] } })
      if (!map.getLayer(LYR_VEC)) map.addLayer({ id: LYR_VEC, source: SRC_VEC, type: 'line', paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.7, 'line-dasharray': [2, 3] } })
      if (!map.getLayer(LYR_TRP)) map.addLayer({ id: LYR_TRP, source: SRC_TRP, type: 'circle', paint: { 'circle-radius': 3, 'circle-color': '#0ea5e9', 'circle-opacity': 0.35, 'circle-stroke-width': 0.5, 'circle-stroke-color': '#0ea5e9' } })
      if (!map.getLayer(LYR_HALO)) map.addLayer({ id: LYR_HALO, source: SRC_HALO, type: 'circle', paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.7 } })
      if (!map.getLayer(LYR_PIN)) map.addLayer({ id: LYR_PIN, source: SRC_PIN, type: 'symbol', layout: { 'text-field': ['get', 'g'], 'text-size': 14, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#020617', 'text-halo-width': 1.5 } })
      if (!map.getLayer(LYR_LBL)) map.addLayer({ id: LYR_LBL, source: SRC_LBL, type: 'symbol', layout: { 'text-field': ['get', 'lbl'], 'text-size': 10, 'text-offset': [0, -1.2], 'text-anchor': 'bottom', 'text-allow-overlap': true }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } })
    }
    ensure()
    const halo: any[] = [], lbl: any[] = [], pin: any[] = [], vec: any[] = [], trp: any[] = [], ref: any[] = []
    for (const r of active) {
      const color = TIER_COLOR[r.tier]
      const radius = 8 + (r.score / 100) * 14
      if (showHalo) halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { r: radius, color } })
      if (showPin && r.tier === 'STEP-NOW') {
        const glyph = r.step.dir === 'UP' ? '↑' : r.step.dir === 'DN' ? '↓' : '!'
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { g: glyph } })
      }
      if (showLbl && r.tier !== 'OPT') {
        const arrow = r.step.dir === 'UP' ? '↑' : r.step.dir === 'DN' ? '↓' : '›'
        const tgt = r.step.dir !== 'NONE' ? ` FL${r.step.targetFl}` : ''
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { lbl: `${r.f.callsign || r.f.icao} ${arrow} OPT FL${r.optFl}${tgt} (${r.sarPenaltyPct >= 0 ? '+' : ''}${r.sarPenaltyPct.toFixed(1)}%)`, color } })
      }
      if (showVec && r.step.dir !== 'NONE') {
        // step vector: aircraft → 80nm forward (visual cue of climb/descent)
        const fwd = 80
        const bearRad = (r.f.track || 0) * Math.PI / 180
        const R = 3440.065
        const lat1 = r.f.lat * Math.PI / 180, lon1 = r.f.lng * Math.PI / 180
        const d = fwd / R
        const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearRad))
        const lon2 = lon1 + Math.atan2(Math.sin(bearRad) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2))
        vec.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI]] }, properties: { color } })
      }
    }
    if (showTrp) {
      // sample tropopause altitude at lat -60..60 every 10 every lng 30 for a fleet reference
      for (let lat = -60; lat <= 60; lat += 15) {
        for (let lng = -180; lng <= 180; lng += 30) {
          const tf = tropopauseFl(lat, ((Math.abs(lat) + Math.abs(lng)) % 100) / 100, seasonBias)
          trp.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { tf } })
        }
      }
    }
    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        ref.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_VEC) as any).setData({ type: 'FeatureCollection', features: vec })
    ;(map.getSource(SRC_TRP) as any).setData({ type: 'FeatureCollection', features: trp })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: ref })
    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_VEC, LYR_TRP, LYR_REF]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_LBL, SRC_PIN, SRC_VEC, SRC_TRP, SRC_REF]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, active, showHalo, showPin, showLbl, showVec, showTrp, showRef, seasonBias])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const driverBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (r: Row) => {
    if (r.tier === 'STEP-NOW') {
      if (r.driver === 'BUF') return `Coffin-corner · buffet margin ${(r.buffetMarginG*100).toFixed(0)}cg · descend to FL${r.step.targetFl} per FCOM PI-1 / AC 91-85`
      if (r.driver === 'TRP') return `Above tropopause +${((r.fl-r.tropFl)/10).toFixed(1)}kft · thrust margin eroded · step down to FL${r.step.targetFl} per Boeing AERO Q4-2007`
      const dir = r.step.dir === 'UP' ? 'CLIMB' : 'DESCEND'
      return `${dir} now · request FL${r.step.targetFl} (${r.step.deltaFt >= 0 ? '+' : ''}${r.step.deltaFt}ft) · SAR penalty ${r.sarPenaltyPct >= 0 ? '+' : ''}${r.sarPenaltyPct.toFixed(1)}% off OPT FL${r.optFl} per AC 120-103A §5`
    }
    if (r.tier === 'OFF-OPT') {
      const dir = r.step.dir === 'UP' ? 'climb' : r.step.dir === 'DN' ? 'descend' : 'hold'
      return `Pre-coord ${dir} to FL${r.step.targetFl} · ${r.fl > r.optFl ? '+' : ''}${r.fl - r.optFl}ft off OPT · ${r.sarPenaltyPct >= 0 ? '+' : ''}${r.sarPenaltyPct.toFixed(1)}% SAR penalty · brief next step per Airbus GTGFE §3.2`
    }
    if (r.tier === 'WATCH') return `Monitor cruise · ${r.fl > r.optFl ? '+' : ''}${r.fl - r.optFl}ft off OPT FL${r.optFl} · ISA ${r.isaDev >= 0 ? '+' : ''}${r.isaDev}C · trop FL${r.tropFl}`
    return `OPT cruise · FL${r.fl} vs OPT FL${r.optFl} (${(r.fl-r.optFl >= 0 ? '+' : '')}${r.fl-r.optFl}ft) · SAR penalty ${Math.abs(r.sarPenaltyPct).toFixed(1)}% · buffet ${(r.buffetMarginG*100).toFixed(0)}cg margin`
  }

  // Scatter: delta-FL vs SAR penalty
  const W = 280, H = 180
  const maxDelta = 60  // ±60 FL
  const maxPen = 12
  const sx = (n: number) => 32 + ((Math.max(-maxDelta, Math.min(maxDelta, n)) + maxDelta) / (maxDelta * 2)) * (W - 42)
  const sy = (n: number) => H - 24 - (Math.max(0, Math.min(maxPen, n)) / maxPen) * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">Optimum-Altitude · SAR · Tropopause</div>
          <div className="text-[10px] text-slate-500">AC 120-103A · Boeing AERO Q4-2007 · Airbus GTGFE §3.2 · IATA Fuel BP ed.4</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[9px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean SAR pen</div>
          <div className="text-sm font-semibold" style={{ color: meanSarPen >= 4 ? '#ef4444' : meanSarPen >= 2 ? '#f59e0b' : '#10b981' }}>{meanSarPen.toFixed(1)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean ΔFL</div>
          <div className="text-sm font-semibold" style={{ color: Math.abs(meanDelta) >= 20 ? '#ef4444' : Math.abs(meanDelta) >= 10 ? '#f59e0b' : '#10b981' }}>{meanDelta >= 0 ? '+' : ''}{meanDelta.toFixed(0)}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Above trop</div>
          <div className="text-xs font-semibold" style={{ color: aboveTropShare > 0.25 ? '#ef4444' : aboveTropShare > 0.10 ? '#f59e0b' : '#10b981' }}>{(aboveTropShare*100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Buffet near</div>
          <div className="text-xs font-semibold" style={{ color: buffetShare > 0.15 ? '#ef4444' : buffetShare > 0.05 ? '#f59e0b' : '#10b981' }}>{(buffetShare*100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Tracked</div>
          <div className="text-xs font-semibold text-slate-100">{active.length}</div>
        </div>
      </div>

      {showDiag && active.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* OPT vertical reference line */}
            <line x1={sx(0)} y1={sy(0)} x2={sx(0)} y2={sy(maxPen)} stroke="#10b981" strokeWidth={0.8} strokeDasharray="3 3" />
            {/* SAR penalty band 2% amber */}
            <line x1={sx(-maxDelta)} y1={sy(2)} x2={sx(maxDelta)} y2={sy(2)} stroke="#f59e0b" strokeWidth={0.5} strokeDasharray="2 3" />
            <line x1={sx(-maxDelta)} y1={sy(6)} x2={sx(maxDelta)} y2={sy(6)} stroke="#ef4444" strokeWidth={0.5} strokeDasharray="2 3" />
            {/* ±20 FL markers */}
            <line x1={sx(-20)} y1={sy(0)} x2={sx(-20)} y2={sy(maxPen)} stroke="#1e293b" strokeWidth={0.4} />
            <line x1={sx(20)} y1={sy(0)} x2={sx(20)} y2={sy(maxPen)} stroke="#1e293b" strokeWidth={0.4} />
            <text x={W/2} y={H-4} textAnchor="middle" fontSize="9" fill="#64748b">ΔFL from OPT (FL units)</text>
            <text x={6} y={H/2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H/2})`}>SAR penalty (%)</text>
            {active.map((r, i) => (
              <circle key={i} cx={sx(r.fl - r.optFl)} cy={sy(Math.abs(r.sarPenaltyPct))} r={2.5} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['MIN-FL', minFl, 0, 400, setMinFl, ''],
            ['SEASON', seasonBias, -25, 25, setSeasonBias, ''],
            ['ISA-OFF', isaOffset, -20, 20, setIsaOffset, 'C'],
            ['WGT-BIAS', weightBias, -20, 20, setWeightBias, '%'],
            ['OPT-MUL', optMul, 80, 120, setOptMul, '%'],
            ['SAR-MUL', sarMul, 50, 200, setSarMul, '%'],
            ['WND-DLT', windDelta, -40, 40, setWindDelta, 'kt'],
            ['PHASE-WT', phaseWt, 50, 150, setPhaseWt, '%'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[34px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['HVY-Q','HVY','NRW','RGN','BIZ','TBP'] as AcClass[]).map(k => (
            <button key={k} onClick={() => setClassFilter(classFilter === k ? 'ALL' : k)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: classFilter === k ? '#0ea5e933' : '#0b1220', borderColor: classFilter === k ? '#0ea5e9' : '#1e293b', color: classFilter === k ? '#0ea5e9' : '#cbd5e1' }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['VEC', showVec, setShowVec],
            ['TRP', showTrp, setShowTrp],
            ['REF', showRef, setShowRef],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / icao / class" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'CLASSES', 'BANDS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className="flex-1 px-2 py-1.5 text-[11px]" style={{ color: tab === t ? '#0ea5e9' : '#94a3b8', backgroundColor: tab === t ? '#0ea5e915' : 'transparent', borderBottom: tab === t ? '2px solid #0ea5e9' : '2px solid transparent' }}>{t}</button>
        ))}
      </div>

      {tab === 'AIRCRAFT' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No aircraft in cruise envelope · raise MIN-FL or change filter</div>}
          {filtered.slice(0, 80).map((r, i) => (
            <div key={i} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(r.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 truncate">{r.f.callsign || r.f.icao}</span>
                  <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 border border-slate-700">{r.cls}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 border border-slate-700">{r.phase}</span>
                  {r.step.dir !== 'NONE' && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-sky-400 bg-sky-500/10 border border-sky-500/40 font-mono">{r.step.dir === 'UP' ? '↑' : '↓'} FL{r.step.targetFl}</span>}
                </div>
                {tierBadge(r.tier)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                FL{r.fl} vs OPT FL{r.optFl} <span style={{ color: Math.abs(r.fl - r.optFl) >= 20 ? '#ef4444' : Math.abs(r.fl - r.optFl) >= 10 ? '#f59e0b' : '#10b981' }}>({r.fl - r.optFl >= 0 ? '+' : ''}{r.fl - r.optFl})</span> · trop FL{r.tropFl} · ISA {r.isaDev >= 0 ? '+' : ''}{r.isaDev}C · TOGW {(r.togwFrac*100).toFixed(0)}%
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                SAR pen <span style={{ color: Math.abs(r.sarPenaltyPct) >= 4 ? '#ef4444' : Math.abs(r.sarPenaltyPct) >= 2 ? '#f59e0b' : '#10b981' }}>{r.sarPenaltyPct >= 0 ? '+' : ''}{r.sarPenaltyPct.toFixed(2)}%</span> · buffet <span style={{ color: r.buffetMarginG <= 0.15 ? '#ef4444' : r.buffetMarginG <= 0.25 ? '#f59e0b' : '#10b981' }}>{(r.buffetMarginG*100).toFixed(0)}cg</span> · wind Δ {r.windDeltaKt >= 0 ? '+' : ''}{r.windDeltaKt}kt
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {driverBadge('SAR', r.sev.sar)}
                {driverBadge('STP', r.sev.stp)}
                {driverBadge('TRP', r.sev.trp)}
                {driverBadge('BUF', r.sev.buf)}
                {driverBadge('ISA', r.sev.isa)}
                {driverBadge('WND', r.sev.wnd)}
              </div>
              <div className="text-[10px] mt-1" style={{ color: TIER_COLOR[r.tier] }}>{advice(r)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'CLASSES' && (
        <div className="divide-y divide-slate-800">
          {classRows.map((c, i) => (
            <div key={i} className="px-3 py-2" style={{ borderLeft: `3px solid ${c.stp ? '#ef4444' : c.off ? '#f59e0b' : '#0ea5e9'}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-slate-100 font-mono">{c.k}</span>
                  <span className="text-[10px] text-slate-400">{c.spec.family}</span>
                </div>
                <div className="text-[10px] text-slate-400">{c.ac} ac</div>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">OPT FL{c.spec.optAtMtow}–{c.spec.optAtLight} · MAX FL{c.spec.maxFl} · M{c.spec.mach.toFixed(2)} · step {c.spec.stepFt}ft</div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10px] text-slate-400">mean Δ <span style={{ color: Math.abs(c.meanDelta) >= 20 ? '#ef4444' : Math.abs(c.meanDelta) >= 10 ? '#f59e0b' : '#10b981' }}>{c.meanDelta >= 0 ? '+' : ''}{c.meanDelta.toFixed(0)}</span></span>
                <span className="text-[10px] text-slate-400">SAR <span style={{ color: c.meanPen >= 4 ? '#ef4444' : c.meanPen >= 2 ? '#f59e0b' : '#10b981' }}>{c.meanPen.toFixed(1)}%</span></span>
                {c.stp > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/40">STP {c.stp}</span>}
                {c.off > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/40">OFF {c.off}</span>}
                <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${c.mean}%`, backgroundColor: c.mean >= 80 ? '#ef4444' : c.mean >= 55 ? '#f59e0b' : c.mean >= 25 ? '#0ea5e9' : '#10b981' }} /></div>
                <span className="text-[10px] text-slate-400 tabular-nums w-8 text-right">{c.mean.toFixed(0)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'BANDS' && (
        <div className="divide-y divide-slate-800">
          {bandRows.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No FL bands populated</div>}
          {bandRows.map((b, i) => {
            const sev = b.meanPen
            const color = sev >= 4 ? '#ef4444' : sev >= 2 ? '#f59e0b' : sev >= 1 ? '#0ea5e9' : '#10b981'
            return (
              <div key={i} className="px-3 py-2" style={{ borderLeft: `3px solid ${color}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-slate-100 font-mono">FL{b.lo}–{b.hi}</span>
                  </div>
                  <div className="text-[10px] text-slate-400">{b.ac} ac</div>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[10px] text-slate-400">mean SAR pen <span style={{ color }}>{b.meanPen.toFixed(2)}%</span></span>
                  {b.stp > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/40">STP {b.stp}</span>}
                  {b.off > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/40">OFF {b.off}</span>}
                  <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${Math.min(100, b.ac * 6)}%`, backgroundColor: color }} /></div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 leading-tight">
        AC 91-70B · AC 120-103A · AC 91-85 RVSM · IATA Fuel BP ed.4 §2.4 · Boeing AERO Q4-2007 · FCOM PI-1 · Airbus GTGFE §3.2 · NBAA OP Bull #11 · ICAO Doc 7488 ISA · NOAA ARL tropopause
      </div>
    </div>
  )
}
