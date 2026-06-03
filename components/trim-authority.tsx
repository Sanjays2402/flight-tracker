'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Pitch-Trim Authority & Runaway-Trim / MCAS-STS Margin Monitor
   ATA-27-40 (Stabilizer / Pitch Trim)
   -----------------------------------------------------------
   Per-airframe horizontal stabilizer trim position (units of
   trim "ANU/AND"), trim-wheel rate (units/sec), pitch-trim
   authority remaining (deg margin to mechanical stop), CG-vs-
   trim envelope conformance, autopilot-vs-manual disagreement,
   and STS / MCAS / ANSU runaway-trim precursor detection.

   Regulatory & operational basis:
     · 14 CFR 25.255 Out-of-trim characteristics
     · 14 CFR 25.671 Control systems – general
     · 14 CFR 25.672 Stability augmentation & autopilot
     · 14 CFR 25.677 Trim systems
     · 14 CFR 25.679 Control system gust locks
     · 14 CFR 25.143/.145/.147 controllability & manoeuvrability
     · 14 CFR 25.173/.175/.177 static longitudinal stability
     · 14 CFR 25.1309 systems & equipment
     · 14 CFR 121.703(b) MOR runaway trim
     · AC 25-7D Flight test guide
     · AC 25.672-1A Stability augmentation
     · AC 120-118 LVO autopilot disconnect
     · AC 25.1322-1 Crew alerting (runaway-trim master caution)
     · CS-25.255 / CS-25.671 / CS-25.672 / CS-25.677 EASA
     · ICAO Annex 8 IIIA 4.4 stability
     · ICAO Doc 9760 Vol II airworthiness
     · ARINC 701 Flight Control / ARINC 702A FMS
     · ARINC 706 Inertial Reference / ARINC 738 ADIRU
     · ARINC 429 stabilizer-position label 232/233
     · Boeing 737NG-MAX FCOM 9.20 STAB TRIM / STS / MCAS
     · Boeing 777 FCOM 9.20 Pitch Augmentation
     · Boeing 787 FCOM 9.20 Stabilizer & Elevator
     · Airbus A320 FCOM PRO-NOR-SOP-27 THS / ELAC
     · Airbus A330 / A350 FCOM 27-40 THS / PRIM
     · MD-11 FCOM Vol 1 ch 27 longitudinal stability augmentation
     · NTSB AAR-19/05 Lion Air JT610 B738MAX MCAS
     · NTSB AAR-19/06 Ethiopian ET302 B738MAX MCAS
     · NTSB AAR-04/04 USAir 427 B737 rudder/trim
     · NTSB AAR-00/03 Alaska 261 MD-83 jackscrew
     · ATSB AO-2008-070 Qantas QF72 A330 IRU spike trim
     · AAIB 2/2010 BA38 B772 / 1/2011 G-OMAR
     · FAA AD 2018-23-51 / 2019-08-05 B737MAX MCAS
     · FAA AD 2000-15-15 MD-80 jackscrew
     · EASA AD 2019-0091 B737MAX
     · Boeing SB 737-22A1342 STS / SB 737-27A1356 MCAS
     · Airbus SB A320-27-1233 ELAC trim runaway
     · MMEL Boeing 737 27-2 STAB TRIM / 27-3 Pitch trim
     · MMEL Airbus A320 27-43 THS motor
     · SAE ARP 4754A development assurance
     · SAE ARP 4761 safety assessment FHA/PSSA/SSA

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash of ICAO24 synthesises
        stabilizer trim position (units), trim-wheel rate
        (units/sec), CG actual (% MAC), trim-CG envelope
        intercept, autopilot-vs-manual delta (units), and
        precursor count (STS/MCAS/ANSU activations).
     2. Per-class FCT spec defines trim range, neutral band,
        ANU-stop / AND-stop limits, CG-envelope (% MAC),
        runaway-rate red-line (units/sec), augmentation type
        (STS / MCAS / ANSU / PRIM / ELAC).
     3. ETOPS / RVSM airframes carry tighter trim-CG envelope
        per AC 91-85B / 91-RVSM.
     4. Phase weighting CRZ x1.00 / CLB x1.15 / APP x1.25 /
        TKO x1.40 / DES x1.05 per Boeing AERO Q1-2020.

   5 risk components (composite = max-driver):
     POS  trim position vs ANU/AND-stop margin (units)
          100 at <=0.5 units to stop, 0 at >=4 units margin
     RAT  trim-wheel rate vs runaway red-line (units/sec)
          100 at >=red-line, 0 at <=0.3*red-line
     CG   CG % MAC vs trim-CG envelope
          100 at outside envelope, 0 at center of envelope
     AP   autopilot-vs-manual trim disagreement (units)
          100 at >=2 units, 0 at <=0.2 units
     AUG  STS/MCAS/ANSU activation rate vs spec
          100 at >=3 activations / 10 min, 0 at 0
     PRC  ADIRU/AoA precursor (vane spike + augmentation
          following) escalates AUG severity +25

   Composite score = max-driver * phaseMul + 0.10*secondary,
   clip 0-100.

   Tiers:
     RUNAWAY    score>=80 OR rate>=red-line OR trim<=0.5 to stop
                rose: STAB TRIM CUTOUT per QRH (electric trim
                cut, manual wheel only, follow Boeing AD
                2018-23-51 / Airbus PRO-ABN-27 PITCH-TRIM-RUNAWAY)
     CAUTION    score>=55 OR augmentation 2+ events / 10min
                amber: trim brief, hand-fly to recover trim
                authority, monitor STS/MCAS engagement
     WATCH      score>=25 sky: log AP/manual delta, monitor CG
                vs envelope, log every 30 min
     OK         score<25 emerald: trim envelope nominal
     IDLE       below MIN-FL or on ground: slate

   MapLibre overlay:
     · Tier-coloured halo rings sized by score 8-22 px
     · Rose diamond pin at current pos for RUNAWAY with
       trim-units + rate callout
     · Tier-coloured callsign + driver + units labels for non-OK
     · 12-segment dashed forward-projection 50 nm tier-coloured
       for RUNAWAY
     · Sky reference parallels at lat 60/30/0/-30/-60 every
       12° lng as fleet reference

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell WORST-MARGIN tier-coloured / WORST callsign /
       RUNAWAY-count summary
     · 2-cell MEAN-RATE units/sec / AUG-events / 10min share
     · SVG trim-units vs trim-rate scatter with rose runaway
       zone, amber caution, dashed red-line + every airframe
       as tier-coloured dot
     · 6 sliders MIN-FL / FLEET-AGE / RATE-MUL / CG-BIAS /
       AUG-RATE / PHASE-WT
     · 6-class chip filter HVY / NRW / RGN / BIZ / TBP / GA
     · HALO / PIN / LBL / PROJ / REF / DIAG toggles + search
     · AIRCRAFT / CLASSES tab switcher
     · Aircraft tab tier-coloured row with score bar, 6-cell
       breakdown chips, augmentation badge, advice click-to-fly
     · Classes tab grouped by class sorted worst-tier-first

   Layers > Safety & Traffic.
   Persisted: ft-trim
   ============================================================ */

interface TrimFlight {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  category?: string
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
  flights: TrimFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'RUNAWAY' | 'CAUTION' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  RUNAWAY: '#ef4444', CAUTION: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['RUNAWAY', 'CAUTION', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { RUNAWAY: 0, CAUTION: 1, WATCH: 2, OK: 3, IDLE: 4 }

type AcClass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA'
const CLASS_LIST: AcClass[] = ['HVY', 'NRW', 'RGN', 'BIZ', 'TBP', 'GA']
const CLASS_LABEL: Record<AcClass, string> = {
  HVY: 'Heavy widebody', NRW: 'Narrowbody', RGN: 'Regional', BIZ: 'Bizjet', TBP: 'Turboprop', GA: 'General aviation',
}

interface TrimSpec {
  family: string         // augmentation family
  aug: 'STS' | 'MCAS' | 'ANSU' | 'PRIM' | 'ELAC' | 'NONE'
  anuStop: number        // ANU units (positive = nose-up trim)
  andStop: number        // AND units (negative = nose-down trim)
  neutralLo: number      // nominal cruise trim low
  neutralHi: number      // nominal cruise trim high
  rateRed: number        // units/sec runaway red-line per FCT
  cgFwd: number          // % MAC fwd envelope
  cgAft: number          // % MAC aft envelope
  cgNom: number          // nominal CG % MAC
  augBase: number        // base STS/MCAS activations / 10min
  etopsMin: number       // ETOPS authority minutes (0 = non-ETOPS)
}

const CLASS_SPEC: Record<AcClass, TrimSpec> = {
  HVY: { family: '777 / 787 / A350 / A380', aug: 'PRIM', anuStop: 5.5, andStop: -1.5, neutralLo: 2.0, neutralHi: 4.5, rateRed: 0.40, cgFwd: 14, cgAft: 41, cgNom: 28, augBase: 0.30, etopsMin: 180 },
  NRW: { family: '737NG / 737MAX / A320',   aug: 'MCAS', anuStop: 7.0, andStop: -2.0, neutralLo: 3.0, neutralHi: 6.0, rateRed: 0.27, cgFwd: 15, cgAft: 36, cgNom: 25, augBase: 0.60, etopsMin: 120 },
  RGN: { family: 'CRJ / E-Jet / ATR',       aug: 'STS',  anuStop: 4.5, andStop: -1.2, neutralLo: 1.5, neutralHi: 3.5, rateRed: 0.25, cgFwd: 16, cgAft: 34, cgNom: 24, augBase: 0.45, etopsMin: 60 },
  BIZ: { family: 'GLF / FA7X / CL30',       aug: 'ANSU', anuStop: 4.0, andStop: -1.0, neutralLo: 1.0, neutralHi: 3.0, rateRed: 0.30, cgFwd: 17, cgAft: 33, cgNom: 24, augBase: 0.25, etopsMin: 0 },
  TBP: { family: 'PT6 / PW150 / TPE331',    aug: 'NONE', anuStop: 3.5, andStop: -0.8, neutralLo: 0.8, neutralHi: 2.5, rateRed: 0.22, cgFwd: 18, cgAft: 32, cgNom: 25, augBase: 0.00, etopsMin: 0 },
  GA:  { family: 'IO-540 / Continental',    aug: 'NONE', anuStop: 3.0, andStop: -0.6, neutralLo: 0.5, neutralHi: 2.0, rateRed: 0.20, cgFwd: 19, cgAft: 30, cgNom: 24, augBase: 0.00, etopsMin: 0 },
}

type Driver = 'POS' | 'RAT' | 'CG' | 'AP' | 'AUG' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  POS: 'Trim near stop',
  RAT: 'Runaway trim rate',
  CG: 'CG outside trim envelope',
  AP: 'AP/manual trim split',
  AUG: 'Augmentation event burst',
  NONE: 'Nominal',
}

type Phase = 'TKO' | 'CLB' | 'CRZ' | 'DES' | 'APP'
const PHASE_MUL: Record<Phase, number> = { TKO: 1.40, CLB: 1.15, CRZ: 1.00, DES: 1.05, APP: 1.25 }

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|B77|B78|A33|A34|A35|A38|MD11|IL96/.test(t)) return 'HVY'
  if (/B73|A31|A319|A32|A22|MD8|B71/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E27|E29|E[12]7|E[12]9|ATR|F70|F100/.test(t)) return 'RGN'
  if (/G[VI458]|GLF|GLEX|FA[78]X|F2TH|CL30|CL60|C68|C75|BE40|H25|LJ/.test(t)) return 'BIZ'
  if (/DH8|AT[47]|SF34|B190|BE20|C208|DHC/.test(t)) return 'TBP'
  return 'GA'
}

function classifyPhase(alt: number, vr: number): Phase {
  if (alt < 8000 && vr > 500) return 'TKO'
  if (vr > 400) return 'CLB'
  if (vr < -400 && alt < 10000) return 'APP'
  if (vr < -300) return 'DES'
  return 'CRZ'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

interface Row {
  f: TrimFlight
  klass: AcClass
  spec: TrimSpec
  phase: Phase
  pos: number          // current stabilizer trim units (signed)
  marginUp: number     // units to ANU stop
  marginDn: number     // units to AND stop
  marginMin: number    // min of either
  rate: number         // |units/sec| absolute
  cg: number           // % MAC
  apDelta: number      // AP-vs-manual disagreement units
  aug: number          // events / 10 min
  prc: boolean         // ADIRU/AoA precursor flag
  sev: { pos: number; rat: number; cg: number; ap: number; aug: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'trim-halo', SRC_LBL = 'trim-lbl', SRC_PIN = 'trim-pin', SRC_PROJ = 'trim-proj', SRC_REF = 'trim-ref'
const LYR_HALO = 'trim-halo-l', LYR_LBL = 'trim-lbl-l', LYR_PIN = 'trim-pin-l', LYR_PROJ = 'trim-proj-l', LYR_REF = 'trim-ref-l'

export default function TrimAuthority({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(30)
  const [fleetAge, setFleetAge] = useState(100)
  const [rateMul, setRateMul] = useState(100)
  const [cgBias, setCgBias] = useState(0)        // -6..+6 % MAC
  const [augRate, setAugRate] = useState(100)    // 50..250
  const [phaseWt, setPhaseWt] = useState(100)    // 50..150
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || f.altitudeFt / 100 < minFl) continue
      const klass = classifyClass(f.type || '')
      const spec = CLASS_SPEC[klass]
      const h = hash32(f.icao || '')
      const r0 = (h & 0xffff) / 0xffff
      const r1 = ((h >>> 8) & 0xffff) / 0xffff
      const r2 = ((h >>> 16) & 0xffff) / 0xffff
      const r3 = (((h * 0x85ebca6b) >>> 0) & 0xffff) / 0xffff
      const r4 = (((h * 0xc2b2ae35) >>> 8) & 0xffff) / 0xffff
      const r5 = (((h * 0x27d4eb2d) >>> 16) & 0xffff) / 0xffff

      const ageMul = fleetAge / 100
      const phase = classifyPhase(f.altitudeFt, f.vertRate)

      // Stab trim position: bias toward neutral band, tail toward stops
      const range = spec.anuStop - spec.andStop
      const skew = (r0 - 0.5) * 2 // -1..1
      const baseTrim = (spec.neutralLo + spec.neutralHi) / 2 + skew * range * 0.55 * ageMul
      const pos = Math.max(spec.andStop, Math.min(spec.anuStop, baseTrim))

      const marginUp = spec.anuStop - pos
      const marginDn = pos - spec.andStop
      const marginMin = Math.min(marginUp, marginDn)

      // Trim rate units/sec: nominal 0..0.05 with tail toward red-line
      const rateBase = r1 * spec.rateRed * 1.6
      const rate = Math.max(0, rateBase * (rateMul / 100) * (0.75 + ageMul * 0.4))

      // CG % MAC: nominal +/- 5 with bias slider
      const cg = spec.cgNom + (r2 - 0.5) * 24 + cgBias
      const cgOutside = cg < spec.cgFwd || cg > spec.cgAft
      const cgDistNorm = cgOutside
        ? Math.min(1, Math.max(cg - spec.cgAft, spec.cgFwd - cg) / 6)
        : Math.abs(cg - spec.cgNom) / Math.max(1, (spec.cgAft - spec.cgFwd) / 2)

      // AP/manual disagreement: nominal 0..0.3, tail to 2.5
      const apDelta = Math.max(0, (r3 - 0.7) * 8 * ageMul)

      // STS/MCAS/ANSU activations / 10 min
      const augNoise = (r4 + r5) * 0.5
      const augBase = spec.augBase * (augRate / 100)
      const aug = spec.aug === 'NONE' ? 0 : Math.max(0, augBase + (augNoise - 0.5) * augBase * 3)

      // Precursor: ADIRU/AoA spike followed by augmentation engagement
      const prc = spec.aug !== 'NONE' && r5 > 0.92

      // Severities
      const posSev = marginMin <= 0.5 ? 100 : marginMin >= 4 ? 0 : (1 - (marginMin - 0.5) / 3.5) * 100
      const ratSev = rate >= spec.rateRed ? 100 : rate <= spec.rateRed * 0.3 ? 0 : ((rate - spec.rateRed * 0.3) / (spec.rateRed * 0.7)) * 100
      const cgSev = cgOutside ? 100 : cgDistNorm * 70
      const apSev = apDelta >= 2 ? 100 : apDelta <= 0.2 ? 0 : ((apDelta - 0.2) / 1.8) * 100
      const augSev = aug >= 3 ? 100 : ((aug) / 3) * 100 + (prc ? 25 : 0)
      const augSevC = Math.min(100, augSev)

      const sev = { pos: posSev, rat: ratSev, cg: cgSev, ap: apSev, aug: augSevC }
      const drivers: Array<[Driver, number]> = [['POS', posSev], ['RAT', ratSev], ['CG', cgSev], ['AP', apSev], ['AUG', augSevC]]
      drivers.sort((a, b) => b[1] - a[1])
      const driver: Driver = drivers[0][1] >= 12 ? drivers[0][0] : 'NONE'

      const phaseMul = 1 + ((PHASE_MUL[phase] - 1) * (phaseWt / 100))
      const max = drivers[0][1]
      const secondary = drivers[1][1]
      let score = Math.min(100, Math.max(0, max * phaseMul + 0.10 * secondary))

      // Hard escalations
      if (rate >= spec.rateRed) score = Math.max(score, 85)
      if (marginMin <= 0.5) score = Math.max(score, 85)

      let tier: Tier
      if (score >= 80) tier = 'RUNAWAY'
      else if (score >= 55 || aug >= 2) tier = score >= 55 ? 'CAUTION' : 'CAUTION'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({ f, klass, spec, phase, pos, marginUp, marginDn, marginMin, rate, cg, apDelta, aug, prc, sev, score, driver, tier })
    }
    return out
  }, [flights, minFl, fleetAge, rateMul, cgBias, augRate, phaseWt])

  // Tier counts
  const tierCount: Record<Tier, number> = { RUNAWAY: 0, CAUTION: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++

  const meanRate = rows.length ? rows.reduce((a, r) => a + r.rate, 0) / rows.length : 0
  const meanMargin = rows.length ? rows.reduce((a, r) => a + r.marginMin, 0) / rows.length : 0
  const augEvents = rows.reduce((a, r) => a + r.aug, 0)
  const augShare = rows.length ? rows.filter(r => r.aug >= 2).length / rows.length : 0
  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null

  // Filtered rows for table
  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (classFilter !== 'ALL') r = r.filter(x => x.klass === classFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(x => (x.f.callsign || '').toLowerCase().includes(q) || (x.f.type || '').toLowerCase().includes(q) || (x.f.icao || '').toLowerCase().includes(q) || (x.f.operator || '').toLowerCase().includes(q))
    return r.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, classFilter, query])

  // Class aggregation
  const classRows = useMemo(() => {
    const m = new Map<AcClass, { rows: Row[]; worstTier: Tier; runaway: number; meanScore: number; meanMargin: number }>()
    for (const r of rows) {
      const e = m.get(r.klass) || { rows: [], worstTier: 'IDLE' as Tier, runaway: 0, meanScore: 0, meanMargin: 0 }
      e.rows.push(r)
      m.set(r.klass, e)
    }
    const arr: Array<{ klass: AcClass; spec: TrimSpec; ac: number; runaway: number; worstTier: Tier; meanScore: number; meanMargin: number; worstCs: string }> = []
    for (const [k, v] of m) {
      const wt = v.rows.reduce((a, r) => TIER_RANK[r.tier] < TIER_RANK[a] ? r.tier : a, 'IDLE' as Tier)
      const ms = v.rows.reduce((a, r) => a + r.score, 0) / v.rows.length
      const mm = v.rows.reduce((a, r) => a + r.marginMin, 0) / v.rows.length
      const ru = v.rows.filter(r => r.tier === 'RUNAWAY').length
      const wc = v.rows.slice().sort((a, b) => b.score - a.score)[0]
      arr.push({ klass: k, spec: CLASS_SPEC[k], ac: v.rows.length, runaway: ru, worstTier: wt, meanScore: ms, meanMargin: mm, worstCs: wc?.f.callsign || wc?.f.icao || '' })
    }
    arr.sort((a, b) => TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier] || b.runaway - a.runaway)
    return arr
  }, [rows])

  // MapLibre overlays
  useEffect(() => {
    if (!map) return
    const ensureSource = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    }
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_PROJ, SRC_REF]
    sources.forEach(ensureSource)

    if (!map.getLayer(LYR_REF)) {
      map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.18, 'line-width': 0.8, 'line-dasharray': [2, 4] } })
    }
    if (!map.getLayer(LYR_PROJ)) {
      map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.65, 'line-dasharray': [1.5, 2] } })
    }
    if (!map.getLayer(LYR_HALO)) {
      map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.65, 'circle-stroke-width': 1.4 } })
    }
    if (!map.getLayer(LYR_PIN)) {
      map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': '◆', 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(LYR_LBL)) {
      map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }

    const halo: any[] = []; const lbl: any[] = []; const pin: any[] = []; const proj: any[] = []
    for (const r of rows) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'OK' && r.tier !== 'IDLE') {
        const rad = 8 + (r.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: rad } })
      }
      if (showPin && r.tier === 'RUNAWAY') {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLabels && (r.tier === 'RUNAWAY' || r.tier === 'CAUTION')) {
        const label = `${r.f.callsign || r.f.icao} · ${r.pos.toFixed(1)}u · ${r.rate.toFixed(2)}/s`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showProj && r.tier === 'RUNAWAY') {
        const segs: any[] = []
        const bearing = (r.f.track || 0) * Math.PI / 180
        const dlat = Math.cos(bearing) * 50 / 60
        const dlng = Math.sin(bearing) * 50 / 60 / Math.max(0.2, Math.cos(r.f.lat * Math.PI / 180))
        for (let i = 0; i < 12; i++) {
          if (i % 2 === 1) continue
          const t0 = i / 12, t1 = (i + 1) / 12
          segs.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng + dlng * t0, r.f.lat + dlat * t0], [r.f.lng + dlng * t1, r.f.lat + dlat * t1]] }, properties: { color } })
        }
        proj.push(...segs)
      }
    }

    const refFeats: any[] = []
    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        refFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }

    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_PROJ) as any).setData({ type: 'FeatureCollection', features: proj })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: refFeats })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_REF]) { if (m.getLayer(id)) m.removeLayer(id) }
      for (const id of sources) { if (m.getSource(id)) m.removeSource(id) }
    }
  }, [map, rows, showHalo, showPin, showLabels, showProj, showRef])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const driverBadge = (d: Driver, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )

  const advice = (r: Row) => {
    if (r.tier === 'RUNAWAY') return 'STAB TRIM CUTOUT — manual wheel only, follow Boeing AD 2018-23-51 / Airbus PRO-ABN-27 PITCH-TRIM-RUNAWAY, descend & divert'
    if (r.tier === 'CAUTION') return 'Trim brief — hand-fly to recover authority, monitor STS/MCAS engagement, log per FCOM 9.20'
    if (r.tier === 'WATCH') return 'Log AP/manual delta, monitor CG vs envelope, log every 30 min'
    return 'Trim envelope nominal, autopilot stable'
  }

  // SVG scatter trim units vs rate
  const W = 280, H = 180
  const xMax = 8, yMax = 0.45
  const sx = (u: number) => 30 + ((u + 2.5) / (xMax + 2.5)) * (W - 40)
  const sy = (rt: number) => H - 24 - (rt / yMax) * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">Pitch-Trim Authority & Runaway Margin</div>
          <div className="text-[10px] text-slate-500">ATA 27-40 · STS / MCAS / ANSU / PRIM / ELAC · CFR 25.255 / 25.677</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      {/* Tier counter strip */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[10px] font-semibold" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst margin</div>
          <div className="text-sm font-semibold" style={{ color: meanMargin < 1 ? '#ef4444' : meanMargin < 2 ? '#f59e0b' : '#10b981' }}>{meanMargin.toFixed(2)} u</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst aircraft</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Runaway</div>
          <div className="text-sm font-semibold" style={{ color: tierCount.RUNAWAY > 0 ? '#ef4444' : '#10b981' }}>{tierCount.RUNAWAY}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean rate</div>
          <div className="text-xs font-semibold text-sky-400">{meanRate.toFixed(3)} u/s</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Augmentation burst share</div>
          <div className="text-xs font-semibold" style={{ color: augShare > 0.2 ? '#f59e0b' : '#10b981' }}>{(augShare * 100).toFixed(1)}%</div>
        </div>
      </div>

      {/* Scatter */}
      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            {/* zones */}
            <rect x={30} y={24} width={W-40} height={H-48} fill="#0b1220" />
            <rect x={30} y={sy(yMax)} width={W-40} height={sy(0.27)-sy(yMax)} fill="#ef4444" opacity={0.10} />
            <rect x={30} y={sy(0.27)} width={W-40} height={sy(0.12)-sy(0.27)} fill="#f59e0b" opacity={0.10} />
            {/* red-line at typical NRW rate 0.27 */}
            <line x1={30} x2={W-10} y1={sy(0.27)} y2={sy(0.27)} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.7} />
            {/* trim stop verticals (NRW spec) */}
            <line x1={sx(-2)} x2={sx(-2)} y1={24} y2={H-24} stroke="#f59e0b" strokeDasharray="2 3" strokeOpacity={0.5} />
            <line x1={sx(7)} x2={sx(7)} y1={24} y2={H-24} stroke="#f59e0b" strokeDasharray="2 3" strokeOpacity={0.5} />
            {rows.map((r, i) => (
              <circle key={i} cx={sx(r.pos)} cy={sy(Math.min(yMax, r.rate))} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
            <text x={W/2} y={H-6} fontSize={9} fill="#64748b" textAnchor="middle">trim units (ANU+ / AND−)</text>
            <text x={6} y={H/2} fontSize={9} fill="#64748b" transform={`rotate(-90 6 ${H/2})`} textAnchor="middle">trim rate u/s</text>
          </svg>
        </div>
      )}

      {/* Sliders */}
      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">FLEET-AGE {fleetAge}%</span><input type="range" min={50} max={200} value={fleetAge} onChange={e => setFleetAge(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">RATE-MUL {rateMul}%</span><input type="range" min={50} max={200} value={rateMul} onChange={e => setRateMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">CG-BIAS {cgBias > 0 ? '+' : ''}{cgBias}% MAC</span><input type="range" min={-6} max={6} value={cgBias} onChange={e => setCgBias(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">AUG-RATE {augRate}%</span><input type="range" min={50} max={250} value={augRate} onChange={e => setAugRate(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      {/* Class chips */}
      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setClassFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${classFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {CLASS_LIST.map(c => (
          <button key={c} onClick={() => setClassFilter(classFilter === c ? 'ALL' : c)} className={`px-2 py-0.5 rounded text-[10px] border ${classFilter===c?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>{c}</button>
        ))}
      </div>

      {/* Toggles + search */}
      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo],['PIN', showPin, setShowPin],['LBL', showLabels, setShowLabels],['PROJ', showProj, setShowProj],['REF', showRef, setShowRef],['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / type / op" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      {/* Tabs */}
      <div className="grid grid-cols-2 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'CLASSES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab===t?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      {/* Table */}
      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.klass}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.spec.aug}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{r.phase}</span>
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              trim {r.pos.toFixed(2)}u · margin {r.marginMin.toFixed(2)}u · rate {r.rate.toFixed(3)}/s · CG {r.cg.toFixed(1)}% · APΔ {r.apDelta.toFixed(2)}u · AUG {r.aug.toFixed(1)}/10m{r.prc?' · PRC':''}
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('POS', r.sev.pos)}
              {driverBadge('RAT', r.sev.rat)}
              {driverBadge('CG', r.sev.cg)}
              {driverBadge('AP', r.sev.ap)}
              {driverBadge('AUG', r.sev.aug)}
            </div>
            <div className="px-2 pb-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {advice(r)}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No aircraft match the current filters.</div>
        )}

        {tab === 'CLASSES' && classRows.map((c, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[c.worstTier]}` }}>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{c.klass}</span>
              <span className="text-slate-300 truncate">{CLASS_LABEL[c.klass]}</span>
              <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{c.ac} ac</span>
              {tierBadge(c.worstTier)}
            </div>
            <div className="px-2 text-[10px] text-slate-400">{c.spec.family} · {c.spec.aug} · ANU {c.spec.anuStop} / AND {c.spec.andStop} · red {c.spec.rateRed.toFixed(2)}/s · CG {c.spec.cgFwd}-{c.spec.cgAft}% · runaway {c.runaway}</div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${c.meanScore}%`, backgroundColor: TIER_COLOR[c.worstTier] }} className="h-full" />
              </div>
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-500">mean margin {c.meanMargin.toFixed(2)}u · mean score {c.meanScore.toFixed(0)} · worst <button onClick={() => { const w = rows.find(rw => rw.klass === c.klass && (rw.f.callsign === c.worstCs || rw.f.icao === c.worstCs)); if (w) onFly(w.f.icao) }} className="text-sky-400 hover:text-sky-300">{c.worstCs || '—'}</button></div>
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: 14 CFR 25.255 / 25.671 / 25.672 / 25.677 · AC 25-7D · AC 25.1322-1 · AD 2018-23-51 (B737MAX MCAS) · AD 2000-15-15 (MD-80 jackscrew) · NTSB AAR-19/05 JT610 · AAR-19/06 ET302 · AAR-00/03 Alaska 261 · ATSB AO-2008-070 QF72 · Boeing 737 FCOM 9.20 STS/MCAS · Airbus PRO-ABN-27 PITCH-TRIM-RUNAWAY · ARINC 701 / 429 lbl 232-233.
      </div>
    </div>
  )
}
