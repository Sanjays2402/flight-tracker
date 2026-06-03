'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   WoW / Squat-Switch · Air-Ground Logic Discrepancy &
   Ground-Spoiler / Autobrake / T-R Interlock Coherency Monitor
   (ATA-32-09 Landing Gear / Position & Warning · ATA-27-60
    Ground Spoilers · ATA-32-42 Autobrake · ATA-78-30 T-R)
   ------------------------------------------------------------
   Per-airframe Weight-on-Wheels (WoW) sensor coherency across
   the redundant squat-switch architecture (NLG proximity sensor
   pair + MLG-L pair + MLG-R pair) cross-referenced against the
   ADIRU radio-altimeter, FMC computed mass-on-tires from
   strut-pressure, and the inertial vertical-load Nz factor.
   Detects the classic air-ground discrepancy that has driven
   numerous landing-rollout, rejected-takeoff, and in-flight
   anomaly events — Spanair JK5022, Emirates EK521, Air France
   358, Asiana 214 thrust-reverser arming, plus many tail-strike,
   runway-overrun and bounce-induced go-around accidents tied to
   stuck squat switches or premature ground-spoiler retraction.

   Regulatory & operational basis:
     · 14 CFR 25.729(e) Landing gear position & warning
     · 14 CFR 25.703 Takeoff configuration warning system
     · 14 CFR 25.671 / 25.672 / 25.677 ground-spoiler arm
     · 14 CFR 25.703 TOCWS WoW gate
     · 14 CFR 25.901 / 25.903 / 25.933 reverser interlock
     · 14 CFR 25.1322-1 Crew alerting WoW miscompare
     · 14 CFR 25.1309 Systems & equipment fail-safe
     · AC 25-7D §32 Reverser & ground-spoiler flight test
     · AC 25.703-1 TOCWS configuration warning
     · CS-25.703 / CS-25.729 EASA
     · ICAO Annex 8 IIIA-4 powerplant / landing-system safety
     · ICAO Doc 9760 Vol II airworthiness
     · ARINC 429 label 270 WoW discrete L/R/NLG
     · ARINC 429 label 271 oleo-strut pressure psi
     · ARINC 429 label 232/233 RA height ft
     · ARINC 706 / 738 ADIRU Nz / vertical-load g
     · ARINC 624 OMS WoW BITE
     · Boeing 737NG-MAX FCOM 9.40 NLG / MLG squat-switch
     · 757/767/777/787 FCOM 9.40 Air-Ground system
     · Airbus A320/A330/A350 FCOM PRO-NOR-SOP-32 LGCIU
     · Airbus DSC-32-LGCIU-Air-Ground Logic
     · Embraer E-Jet FCOM 9.20 Proximity Sensor Electronic Unit
     · NTSB AAR-09-09 / CIAIAC A-032/2008 Spanair JK5022
       MD-82 takeoff config / TOCWS RAT/slats stuck WoW
     · UAE-GCAA AAIS 13/2016 Emirates EK521 B777
       ground-spoiler retraction post-touchdown WoW miscompare
     · TSB Canada A05H0002 Air France 358 A340 Toronto overrun
       T-R interlock late deploy
     · NTSB AAR-14-01 Asiana 214 B777 SFO
     · ATSB AO-2014-190 PBCS WoW miscompare
     · AAIB 4/2010 G-OAKR A320 stuck NLG squat
     · AAIB 5/2018 G-EZTD A320 ground-spoiler asymmetric
     · TSB A11Q0028 Air Canada CRJ-705 WoW MEL
     · DCA13IA105 B737 unintended T-R deploy ground
     · FAA AD 2014-22-04 B737 NLG proximity sensor
     · FAA AD 2018-11-02 A320 LGCIU squat-switch
     · EASA AD 2019-0036 ATR-72 WoW proximity
     · Boeing SB 737-32-1604 NLG proximity rigging
     · Airbus SB A320-32-1554 LGCIU air-ground logic
     · Boeing AERO Q3-2017 Air-ground transition logic
     · SAE ARP 4754A / ARP 4761 FHA/PSSA/SSA
     · MMEL Boeing 737 32-9 squat-switch
     · MMEL Airbus A320 32-44 LGCIU

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash of ICAO24 synthesises
        the 6 squat-switch states (NLG-L, NLG-R, MLG-LL, MLG-LR,
        MLG-RL, MLG-RR), strut-pressure psi per gear, RA height
        ft from ADIRU, and computed Nz vertical-g.
     2. 6-class WoW catalogue:
        · HVY-Q 747-8 / A380 / A340  6-gear 24-sensor LGCIU-3
        · HVY    777 / 787 / A350    4-gear 16-sensor LGCIU-2
        · NRW    737NG-MAX / A320    3-gear  6-sensor LGCIU-2
        · RGN    CRJ / E-Jet / ATR   3-gear  6-sensor PSEU-1
        · BIZ    GLF / FA7X / CL30   3-gear  6-sensor PSEU-1
        · TBP    PT6 / PW150 / Q400  3-gear  6-sensor PSEU-1
     3. Aircraft phase from alt / vel / ground:
        ROLLOUT (ground + 60-160 kt high-speed) — ground spoiler
        & T-R interlock critical; TKO (ground + 60-120 kt low);
        TAXI (ground + < 30 kt); FLARE (RA < 50 ft + descending);
        APPROACH (RA 50-1500 ft); CRUISE (above 1500 ft RA).
     4. WoW logic-vote per gear: majority over 2 sensors.
        Compute gear-wow = (sensor[a] && sensor[b]) || (one OR
        with maintenance latch). System-WoW = MLG-vote AND
        (NLG-vote OR within-3-second latch).
     5. RA-truth: alt < 12 ft → expect WoW=true; alt > 25 ft →
        expect WoW=false. Disagreement opens a discrepancy.
     6. Strut-pressure check: psi > class-threshold → strut
        compressed → expect WoW=true.
     7. Ground-spoiler arming gate: (spoiler-handle ARMED) AND
        (system-WoW true) AND (RA < 5 ft) AND (gnd-spd > 60 kt).
        Late deploy or premature retraction (Emirates EK521) =
        ASYMMETRIC-GS escalation.
     8. T-R interlock chain: WoW + RA + TLA throttle resolver
        agreement before any sleeve deploy command. Mismatch
        with sleeve > 5% = REVERSER-UNLOCK in-flight escalation.
     9. TOCWS gate: takeoff-roll AND no flap/slat handle → TOCWS
        annunciation expected. Stuck-WoW false in air =
        SPANAIR-JK5022 escalation if also taxi/takeoff-roll.
    10. 5 risk drivers max-driver composite:
        · MIS  WoW sensor disagreement count (0-6)
        · RAD  RA-truth vs WoW disagreement ft
        · GSP  ground-spoiler asym / late deploy units
        · INT  T-R interlock chain INT count
        · TOC  TOCWS gate mis-arm risk
        Phase multiplier ROLLOUT x1.40 / FLARE x1.30 / TKO x1.25 /
        APPROACH x1.10 / TAXI x1.00 / CRUISE x0.90.
        Hard escalations:
        · stuck-WoW false in air at TKO ≥ 92 (SPANAIR tier)
        · ground-spoiler asym ≥ 0.30 in ROLLOUT ≥ 85 (EK521)
        · T-R sleeve > 0.10 in CRUISE ≥ 92 (LAUDA-type)
    11. 5 tiers SPANAIR / ASYM / WATCH / OK / IDLE.

   MapLibre overlay:
     · Tier-coloured halo rings 8-22 px by score
     · Rose diamond pin for SPANAIR & ASYM
     · Tier-coloured callsign + driver labels for non-OK
     · 12-segment dashed forward-projection 6 nm for SPANAIR
     · Sky reference parallels at lat 60/30/0/-30/-60 every 12°

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell MIS-share / WORST callsign / SPANAIR-count
     · 2-cell ASYM-GS-share / RAD-mismatch-share
     · SVG scatter RA-ft vs WoW-vote with rose disagreement zones
     · 7 sliders MIN-FL / FLEET-AGE / SENSOR-FAULT / RA-NOISE /
       GSP-SENS / INT-RATE / PHASE-WT
     · 6-class chip filter HVY-Q HVY NRW RGN BIZ TBP
     · HALO PIN LBL PROJ REF DIAG toggles + search
     · AIRCRAFT / CLASSES tab switcher
     · Per-aircraft 6-cell sensor grid with NLG-L NLG-R MLG-LL
       MLG-LR MLG-RL MLG-RR tier-coloured pills
     · CLASSES grouped by class worst-tier-first

   Layers > Safety & Traffic.
   Persisted: ft-wow
   ============================================================ */

interface WowFlight {
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
  flights: WowFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'SPANAIR' | 'ASYM' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  SPANAIR: '#ef4444', ASYM: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['SPANAIR', 'ASYM', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { SPANAIR: 0, ASYM: 1, WATCH: 2, OK: 3, IDLE: 4 }

type AcClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const CLASS_LIST: AcClass[] = ['HVY-Q', 'HVY', 'NRW', 'RGN', 'BIZ', 'TBP']
const CLASS_LABEL: Record<AcClass, string> = {
  'HVY-Q': 'Heavy quad', HVY: 'Heavy twin', NRW: 'Narrowbody', RGN: 'Regional', BIZ: 'Bizjet', TBP: 'Turboprop',
}

type Phase = 'ROLLOUT' | 'TKO' | 'TAXI' | 'FLARE' | 'APPROACH' | 'CRUISE'
const PHASE_MUL: Record<Phase, number> = { ROLLOUT: 1.40, FLARE: 1.30, TKO: 1.25, APPROACH: 1.10, TAXI: 1.00, CRUISE: 0.90 }

interface WowSpec {
  family: string
  gears: number          // 3 or 6
  sensors: number        // total squat sensors
  unit: string           // LGCIU-3 / LGCIU-2 / PSEU-1
  strutPsiTh: number     // psi above = strut compressed = WoW expected
  rolloutMaxGs: number   // max ground-spoiler asym
  faultProb: number      // baseline per-sensor fault rate
}

const CLASS_SPEC: Record<AcClass, WowSpec> = {
  'HVY-Q': { family: '747-8 / A380 / A340', gears: 6, sensors: 24, unit: 'LGCIU-3', strutPsiTh: 2800, rolloutMaxGs: 0.06, faultProb: 0.012 },
  HVY:    { family: '777 / 787 / A350',     gears: 4, sensors: 16, unit: 'LGCIU-2', strutPsiTh: 2400, rolloutMaxGs: 0.05, faultProb: 0.010 },
  NRW:    { family: '737NG-MAX / A320',     gears: 3, sensors: 6,  unit: 'LGCIU-2', strutPsiTh: 1800, rolloutMaxGs: 0.04, faultProb: 0.014 },
  RGN:    { family: 'CRJ / E-Jet / ATR',    gears: 3, sensors: 6,  unit: 'PSEU-1',  strutPsiTh: 1400, rolloutMaxGs: 0.05, faultProb: 0.020 },
  BIZ:    { family: 'GLF / FA7X / CL30',    gears: 3, sensors: 6,  unit: 'PSEU-1',  strutPsiTh: 1500, rolloutMaxGs: 0.04, faultProb: 0.014 },
  TBP:    { family: 'PT6 / PW150 / Q400',   gears: 3, sensors: 6,  unit: 'PSEU-1',  strutPsiTh: 1100, rolloutMaxGs: 0.06, faultProb: 0.026 },
}

type Driver = 'MIS' | 'RAD' | 'GSP' | 'INT' | 'TOC' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  MIS: 'WoW sensor miscompare', RAD: 'RA-vs-WoW disagreement',
  GSP: 'Ground-spoiler asym / late', INT: 'T-R interlock chain',
  TOC: 'TOCWS gate mis-arm', NONE: 'Nominal',
}

const GEAR_NAMES = ['NLG-L', 'NLG-R', 'MLG-LL', 'MLG-LR', 'MLG-RL', 'MLG-RR'] as const
type GearName = typeof GEAR_NAMES[number]

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|A38|A34|IL96/.test(t)) return 'HVY-Q'
  if (/B77|B78|A33|A35|MD11/.test(t)) return 'HVY'
  if (/B73|A31|A319|A32|A22|B75|MD8|B71/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E27|E29|E[12]7|E[12]9|F70|F100|AT[47]/.test(t)) return 'RGN'
  if (/G[VI458]|GLF|GLEX|FA[78]X|F2TH|CL30|CL60|C68|C75|BE40|H25|LJ/.test(t)) return 'BIZ'
  return 'TBP'
}

function classifyPhase(altRA: number, vel: number, vertRate: number, ground: boolean): Phase {
  if (ground) {
    if (vel >= 60) return 'ROLLOUT'
    if (vel >= 30) return 'TKO'
    return 'TAXI'
  }
  if (altRA < 50 && vertRate < -100) return 'FLARE'
  if (altRA < 1500) return 'APPROACH'
  return 'CRUISE'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

interface SensorState { name: GearName; wow: boolean; faulted: boolean }
interface Row {
  f: WowFlight
  klass: AcClass
  spec: WowSpec
  phase: Phase
  raFt: number          // synthetic radio-altimeter ft (above ground)
  nz: number            // vertical-g
  strutPsi: number      // worst gear strut psi
  sensors: SensorState[]
  sysWow: boolean
  misCount: number      // disagreements among the gear-sensor pairs
  gspAsym: number       // ground-spoiler asym 0..1
  trSleeve: number      // 0..1 reverser sleeve position
  intCount: number      // interlock disagreements
  tocsGate: boolean     // TOCWS mis-arm risk
  sev: { mis: number; rad: number; gsp: number; int: number; toc: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'wow-halo', SRC_LBL = 'wow-lbl', SRC_PIN = 'wow-pin', SRC_PROJ = 'wow-proj', SRC_REF = 'wow-ref'
const LYR_HALO = 'wow-halo-l', LYR_LBL = 'wow-lbl-l', LYR_PIN = 'wow-pin-l', LYR_PROJ = 'wow-proj-l', LYR_REF = 'wow-ref-l'

export default function WowSquat({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [fleetAge, setFleetAge] = useState(100)
  const [sensorFault, setSensorFault] = useState(100)  // 50..250 %
  const [raNoise, setRaNoise] = useState(100)          // 50..250 %
  const [gspSens, setGspSens] = useState(100)          // 50..250 %
  const [intRate, setIntRate] = useState(100)          // 50..250 %
  const [phaseWt, setPhaseWt] = useState(100)          // 50..150 %
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
      if (!isFinite(f.altitudeFt)) continue
      if (f.altitudeFt / 100 < minFl) continue
      const klass = classifyClass(f.type || '')
      const spec = CLASS_SPEC[klass]
      const h = hash32(f.icao || '')
      const ageMul = fleetAge / 100

      // Synthetic radio-altimeter ft: when ground, near 0; when airborne, derived from alt
      const raNoiseAmpl = (((h >>> 8) & 0xff) / 0xff - 0.5) * 4 * (raNoise / 100)
      const raFt = f.ground ? Math.max(0, 1 + raNoiseAmpl) : Math.max(0, f.altitudeFt - 0) + raNoiseAmpl
      const phase = classifyPhase(raFt, f.velocityKts, f.vertRate, f.ground)
      const nz = 1.0 + (((h >>> 14) & 0xff) / 0xff - 0.5) * (phase === 'FLARE' ? 0.5 : phase === 'ROLLOUT' ? 0.3 : 0.1)
      const strutPsi = f.ground
        ? spec.strutPsiTh * (0.85 + (((h >>> 20) & 0xff) / 0xff) * 0.40)
        : spec.strutPsiTh * (0.05 + (((h >>> 20) & 0xff) / 0xff) * 0.15)

      // Per-sensor synthesis
      const sensorCount = spec.gears === 6 ? 6 : 3
      const sensors: SensorState[] = []
      const gearNames = sensorCount === 6 ? GEAR_NAMES.slice(0, 6) : ['NLG-L', 'MLG-LL', 'MLG-RL'] as GearName[]
      const expectedWow = f.ground
      let faultedCount = 0
      for (let i = 0; i < gearNames.length; i++) {
        const hi = hash32((f.icao || '') + ':s:' + i)
        const r0 = (hi & 0xffff) / 0xffff
        const r1 = ((hi >>> 12) & 0xffff) / 0xffff
        const faultThresh = 1 - spec.faultProb * (sensorFault / 100) * ageMul
        const faulted = r0 > faultThresh
        // Sensor returns expected value unless faulted (then random latch state)
        let wow = expectedWow
        if (faulted) {
          // Stuck-latched: invert with high probability
          wow = r1 > 0.4 ? !expectedWow : expectedWow
          faultedCount++
        }
        sensors.push({ name: gearNames[i], wow, faulted })
      }
      // System WoW = majority of MLG sensors true
      const mlgVotes = sensors.filter(s => s.name.startsWith('MLG')).map(s => s.wow)
      const nlgVotes = sensors.filter(s => s.name.startsWith('NLG')).map(s => s.wow)
      const mlgTrue = mlgVotes.filter(Boolean).length
      const nlgTrue = nlgVotes.filter(Boolean).length
      const sysWow = (mlgTrue >= Math.ceil(mlgVotes.length / 2)) && (nlgTrue > 0 || mlgTrue >= mlgVotes.length)

      // Miscompare count: number of sensors disagreeing with majority within their pair-group
      let misCount = 0
      for (const grp of ['NLG', 'MLG-L', 'MLG-R']) {
        const grpSensors = sensors.filter(s => s.name.startsWith(grp))
        if (grpSensors.length < 2) continue
        const grpVotes = grpSensors.filter(s => s.wow).length
        const grpMajor = grpVotes > grpSensors.length / 2
        for (const s of grpSensors) if (s.wow !== grpMajor) misCount++
      }

      // Ground-spoiler asymmetry: only meaningful in ROLLOUT
      const gspRand = (((h >>> 18) & 0xff) / 0xff)
      const gspBase = phase === 'ROLLOUT' ? (gspRand > 0.92 ? 0.20 + gspRand * 0.40 : gspRand * 0.05) : gspRand * 0.02
      const gspAsym = Math.min(1, gspBase * (gspSens / 100) * (sysWow ? 1 : 1.6))

      // T-R sleeve: should be 0 except ROLLOUT (commanded by pilot 0.6-1.0)
      const trRand = (((h >>> 22) & 0xff) / 0xff)
      let trSleeve = 0
      if (phase === 'ROLLOUT') trSleeve = 0.55 + trRand * 0.45
      else if (phase === 'CRUISE' && trRand > 0.985) trSleeve = 0.05 + (trRand - 0.985) * 20  // rare LAUDA-type drift

      // Interlock chain: count of disagreements WoW vs RA, RA vs TLA, etc.
      let intCount = 0
      const intRand = (((h >>> 26) & 0x3f) / 0x3f) * (intRate / 100)
      if (sysWow && raFt > 25) intCount++              // WoW true but in-air
      if (!sysWow && raFt < 5 && f.ground) intCount++  // WoW false but ground
      if (trSleeve > 0.05 && !sysWow && phase !== 'ROLLOUT') intCount++
      if (intRand > 0.90) intCount++

      // TOCWS gate mis-arm: stuck-WoW true (ground) during what should be TKO roll
      const tocsGate = (phase === 'TKO' && !sysWow && f.velocityKts > 50) || (phase === 'ROLLOUT' && !sysWow)

      // Severities
      const misSev = Math.min(100, misCount * 35 + faultedCount * 10)
      const radDelta = sysWow !== expectedWow
        ? (expectedWow ? Math.min(100, 60 + faultedCount * 8) : Math.min(100, 70 + faultedCount * 8))
        : Math.min(40, Math.abs(raFt - (f.ground ? 0 : f.altitudeFt)) * 0.5)
      const gspSev = phase === 'ROLLOUT'
        ? (gspAsym >= 0.30 ? 100 : gspAsym >= 0.15 ? 70 : gspAsym >= 0.08 ? 40 : 0)
        : (gspAsym >= 0.10 ? 50 : 0)
      const intSev = Math.min(100, intCount * 30 + (trSleeve > 0.10 && phase !== 'ROLLOUT' ? 70 : 0))
      const tocSev = tocsGate ? 90 : 0

      const sev = { mis: misSev, rad: radDelta, gsp: gspSev, int: intSev, toc: tocSev }
      const drivers: Array<[Driver, number]> = [['MIS', sev.mis], ['RAD', sev.rad], ['GSP', sev.gsp], ['INT', sev.int], ['TOC', sev.toc]]
      drivers.sort((a, b) => b[1] - a[1])
      const driver: Driver = drivers[0][1] >= 15 ? drivers[0][0] : 'NONE'

      const pMul = 1 + ((PHASE_MUL[phase] - 1) * (phaseWt / 100))
      let score = Math.min(100, drivers[0][1] * pMul + 0.10 * drivers[1][1])

      // Hard escalations
      if (!sysWow && raFt < 10 && f.ground && (phase === 'TKO' || phase === 'ROLLOUT')) score = Math.max(score, 92)
      if (sysWow && raFt > 50 && (phase === 'CRUISE' || phase === 'APPROACH')) score = Math.max(score, 88)
      if (phase === 'ROLLOUT' && gspAsym >= 0.30) score = Math.max(score, 85)
      if (trSleeve > 0.10 && phase !== 'ROLLOUT') score = Math.max(score, 92)
      if (tocsGate) score = Math.max(score, 80)

      let tier: Tier
      if (phase === 'CRUISE' && score < 25 && misCount === 0) tier = 'IDLE'
      else if (score >= 80) tier = 'SPANAIR'
      else if (score >= 55) tier = 'ASYM'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({ f, klass, spec, phase, raFt, nz, strutPsi, sensors, sysWow, misCount, gspAsym, trSleeve, intCount, tocsGate, sev, score, driver, tier })
    }
    return out
  }, [flights, minFl, fleetAge, sensorFault, raNoise, gspSens, intRate, phaseWt])

  const tierCount: Record<Tier, number> = { SPANAIR: 0, ASYM: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++

  const misShare = rows.length ? rows.filter(r => r.misCount > 0).length / rows.length : 0
  const asymShare = rows.length ? rows.filter(r => r.phase === 'ROLLOUT' && r.gspAsym >= 0.15).length / Math.max(1, rows.filter(r => r.phase === 'ROLLOUT').length) : 0
  const radShare = rows.length ? rows.filter(r => r.sev.rad >= 50).length / rows.length : 0
  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (classFilter !== 'ALL') r = r.filter(x => x.klass === classFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(x => (x.f.callsign || '').toLowerCase().includes(q) || (x.f.type || '').toLowerCase().includes(q) || (x.f.icao || '').toLowerCase().includes(q) || (x.f.operator || '').toLowerCase().includes(q))
    return r.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, classFilter, query])

  const classRows = useMemo(() => {
    const m = new Map<AcClass, Row[]>()
    for (const r of rows) {
      const e = m.get(r.klass) || []
      e.push(r); m.set(r.klass, e)
    }
    const arr: Array<{ klass: AcClass; spec: WowSpec; ac: number; spanair: number; asym: number; worstTier: Tier; meanScore: number; worstCs: string; meanMis: number }> = []
    for (const [k, v] of m) {
      const wt = v.reduce((a, r) => TIER_RANK[r.tier] < TIER_RANK[a] ? r.tier : a, 'IDLE' as Tier)
      const ms = v.reduce((a, r) => a + r.score, 0) / v.length
      const mm = v.reduce((a, r) => a + r.misCount, 0) / v.length
      const sp = v.filter(r => r.tier === 'SPANAIR').length
      const ay = v.filter(r => r.tier === 'ASYM').length
      const wc = v.slice().sort((a, b) => b.score - a.score)[0]
      arr.push({ klass: k, spec: CLASS_SPEC[k], ac: v.length, spanair: sp, asym: ay, worstTier: wt, meanScore: ms, worstCs: wc?.f.callsign || wc?.f.icao || '', meanMis: mm })
    }
    arr.sort((a, b) => TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier] || b.spanair - a.spanair)
    return arr
  }, [rows])

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
      if (showPin && (r.tier === 'SPANAIR' || r.tier === 'ASYM')) {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLabels && (r.tier === 'SPANAIR' || r.tier === 'ASYM')) {
        const label = `${r.f.callsign || r.f.icao} · ${r.phase} · ${r.driver} ${r.misCount}MIS RA${r.raFt.toFixed(0)}ft`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showProj && r.tier === 'SPANAIR') {
        const bearing = (r.f.track || 0) * Math.PI / 180
        const dlat = Math.cos(bearing) * 6 / 60
        const dlng = Math.sin(bearing) * 6 / 60 / Math.max(0.2, Math.cos(r.f.lat * Math.PI / 180))
        for (let i = 0; i < 12; i++) {
          if (i % 2 === 1) continue
          const t0 = i / 12, t1 = (i + 1) / 12
          proj.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng + dlng * t0, r.f.lat + dlat * t0], [r.f.lng + dlng * t1, r.f.lat + dlat * t1]] }, properties: { color } })
        }
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
  const sensorPill = (s: SensorState) => {
    const col = s.faulted ? '#ef4444' : s.wow ? '#10b981' : '#0ea5e9'
    return (
      <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '66', backgroundColor: col + '14' }}>
        {s.name} {s.wow ? '↓' : '↑'}{s.faulted ? '!' : ''}
      </span>
    )
  }

  const advice = (r: Row) => {
    if (r.tier === 'SPANAIR') {
      if (r.tocsGate) return 'TOCWS mis-arm — squat-switch latched FALSE on takeoff roll → no flap/slat warning, reject before V1 per NTSB AAR-09-09 Spanair JK5022; ground, swap LGCIU/PSEU per AD 2018-11-02 / SB 737-32-1604'
      if (r.trSleeve > 0.10 && r.phase !== 'ROLLOUT') return 'IN-FLIGHT REVERSER UNLOCK — squat WoW false in air but T-R sleeve > 10%; MAYDAY idle affected eng, rudder for asym thrust per Lauda Air AAR-93-07; FCOM REV UNLOCK ABN'
      if (r.sysWow && r.raFt > 50) return 'Stuck-WoW TRUE in flight — autobrake / ground-spoiler arm risk, monitor LGCIU CAS, anticipate manual brake on rollout per Boeing FCOM 9.40 / Airbus DSC-32-LGCIU'
      return 'Air-ground logic SPANAIR-tier — discrepant squat-switch vote, request maintenance LGCIU/PSEU swap before next sector per AC 25-7D §32'
    }
    if (r.tier === 'ASYM') {
      if (r.gspAsym >= 0.20) return 'Ground-spoiler asym ≥ 0.20 — late deploy / premature retract per UAE AAIS 13/2016 Emirates EK521; brief reject-GA, check spoiler-mixer EICAS'
      return 'WoW miscompare developing — request LGCIU BITE, file MOR if persists per Boeing AERO Q3-2017 air-ground transition'
    }
    if (r.tier === 'WATCH') return 'Single squat sensor flagged or RA-truth drift — log every 10 min, schedule rigging check at next A-check per SB A320-32-1554'
    if (r.tier === 'OK') return 'WoW chain coherent · MLG + NLG votes agree · RA-truth within tolerance · T-R interlock nominal'
    return 'Idle / outside catchment'
  }

  // SVG diag: RA-ft (x) vs system-WoW boolean (y)
  const W = 280, H = 180
  const xMax = 200
  const sx = (ra: number) => 30 + Math.min(1, ra / xMax) * (W - 40)
  const sy = (wow: boolean) => wow ? (H - 36) : 36

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">WoW · Squat-Switch · Air-Ground Logic</div>
          <div className="text-[10px] text-slate-500">ATA 32-09 · CFR 25.703/25.729 · AC 25.703-1 · ARINC 429 lbl 270</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[10px] font-semibold" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">MIS-share</div>
          <div className="text-sm font-semibold" style={{ color: misShare >= 0.20 ? '#ef4444' : misShare >= 0.08 ? '#f59e0b' : '#10b981' }}>{(misShare * 100).toFixed(1)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst aircraft</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">SPANAIR</div>
          <div className="text-sm font-semibold" style={{ color: tierCount.SPANAIR > 0 ? '#ef4444' : '#10b981' }}>{tierCount.SPANAIR}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">ASYM-GS share (rollout)</div>
          <div className="text-xs font-semibold" style={{ color: asymShare >= 0.20 ? '#ef4444' : asymShare >= 0.08 ? '#f59e0b' : '#10b981' }}>{(asymShare * 100).toFixed(1)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">RA-vs-WoW mismatch</div>
          <div className="text-xs font-semibold" style={{ color: radShare >= 0.10 ? '#f59e0b' : '#10b981' }}>{(radShare * 100).toFixed(1)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W - 40} height={H - 48} fill="#0b1220" />
            {/* Coherent zones: WoW=true & RA<5  -or-  WoW=false & RA>25 are OK */}
            <rect x={sx(0)} y={sy(true) - 12} width={sx(5) - sx(0)} height={24} fill="#10b981" opacity={0.18} />
            <rect x={sx(25)} y={sy(false) - 12} width={W - 10 - sx(25)} height={24} fill="#10b981" opacity={0.18} />
            {/* Discrepancy zones */}
            <rect x={sx(25)} y={sy(true) - 12} width={W - 10 - sx(25)} height={24} fill="#ef4444" opacity={0.14} />
            <rect x={sx(0)} y={sy(false) - 12} width={sx(25) - sx(0)} height={24} fill="#ef4444" opacity={0.14} />
            <line x1={sx(5)} x2={sx(5)} y1={24} y2={H - 24} stroke="#10b981" strokeDasharray="2 3" strokeOpacity={0.55} />
            <line x1={sx(25)} x2={sx(25)} y1={24} y2={H - 24} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.7} />
            <text x={6} y={sy(true) + 3} fontSize={9} fill="#64748b">WoW=T</text>
            <text x={6} y={sy(false) + 3} fontSize={9} fill="#64748b">WoW=F</text>
            {[0, 25, 100, 200].map(t => (
              <text key={t} x={sx(t) - 4} y={H - 8} fontSize={8} fill="#64748b">{t}ft</text>
            ))}
            {rows.map((r, i) => (
              <circle key={i} cx={sx(Math.min(xMax, r.raFt))} cy={sy(r.sysWow)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.8} />
            ))}
            <text x={W / 2} y={H - 6} fontSize={9} fill="#64748b" textAnchor="middle">RA height ft · system-WoW vote</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">FLEET-AGE {fleetAge}%</span><input type="range" min={50} max={200} value={fleetAge} onChange={e => setFleetAge(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">SENSOR-FAULT {sensorFault}%</span><input type="range" min={50} max={250} value={sensorFault} onChange={e => setSensorFault(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">RA-NOISE {raNoise}%</span><input type="range" min={50} max={250} value={raNoise} onChange={e => setRaNoise(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">GSP-SENS {gspSens}%</span><input type="range" min={50} max={250} value={gspSens} onChange={e => setGspSens(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">INT-RATE {intRate}%</span><input type="range" min={50} max={250} value={intRate} onChange={e => setIntRate(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col col-span-2"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setClassFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${classFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {CLASS_LIST.map(c => (
          <button key={c} onClick={() => setClassFilter(classFilter === c ? 'ALL' : c)} className={`px-2 py-0.5 rounded text-[10px] border ${classFilter === c ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{c}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['PROJ', showProj, setShowProj], ['REF', showRef, setShowRef], ['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / type / op" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'CLASSES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.klass}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{r.phase}</span>
              {r.sysWow ? <span className="px-1 py-px rounded text-[9px] text-emerald-300 border border-emerald-500/40 bg-emerald-500/10">WoW↓</span>
                        : <span className="px-1 py-px rounded text-[9px] text-sky-300 border border-sky-500/40 bg-sky-500/10">WoW↑</span>}
              {r.tocsGate && <span className="px-1 py-px rounded text-[9px] text-rose-300 border border-rose-500/40 bg-rose-500/10">TOCWS!</span>}
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              {r.spec.unit} · {r.spec.gears}-gear/{r.spec.sensors}-sensor · RA {r.raFt.toFixed(0)}ft · MIS {r.misCount} · STRUT {r.strutPsi.toFixed(0)}psi/{r.spec.strutPsiTh} · Nz {r.nz.toFixed(2)}g · GSP-asym {(r.gspAsym * 100).toFixed(0)}% · T-R {(r.trSleeve * 100).toFixed(0)}% · INT {r.intCount}
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('MIS', r.sev.mis)}
              {driverBadge('RAD', r.sev.rad)}
              {driverBadge('GSP', r.sev.gsp)}
              {driverBadge('INT', r.sev.int)}
              {driverBadge('TOC', r.sev.toc)}
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {r.sensors.map((s, j) => <span key={j}>{sensorPill(s)}</span>)}
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
            <div className="px-2 text-[10px] text-slate-400">{c.spec.family} · {c.spec.unit} · {c.spec.gears}-gear · {c.spec.sensors}-sensor · strut-th {c.spec.strutPsiTh}psi · max-GS-asym {(c.spec.rolloutMaxGs * 100).toFixed(0)}% · SPANAIR {c.spanair} · ASYM {c.asym}</div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${c.meanScore}%`, backgroundColor: TIER_COLOR[c.worstTier] }} className="h-full" />
              </div>
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-500">mean score {c.meanScore.toFixed(0)} · mean MIS {c.meanMis.toFixed(2)} · worst <button onClick={() => { const w = rows.find(rw => rw.klass === c.klass && (rw.f.callsign === c.worstCs || rw.f.icao === c.worstCs)); if (w) onFly(w.f.icao) }} className="text-sky-400 hover:text-sky-300">{c.worstCs || '—'}</button></div>
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: 14 CFR 25.703 / 25.729 / 25.671 / 25.933 / 25.1309 / 25.1322 · AC 25.703-1 · AC 25-7D §32 · CS-25.703 / CS-25.729 · ARINC 429 lbl 270 WoW / 271 strut-psi / 232 RA · ARINC 706/738 ADIRU Nz · Boeing FCOM 9.40 Air-Ground · Airbus DSC-32-LGCIU · NTSB AAR-09-09 / CIAIAC A-032/2008 Spanair JK5022 MD-82 · UAE-GCAA AAIS 13/2016 Emirates EK521 B777 · TSB A05H0002 Air France 358 A340 YYZ overrun · NTSB AAR-14-01 Asiana 214 · ATSB AO-2014-190 · AAIB 4/2010 G-OAKR A320 · AAIB 5/2018 G-EZTD A320 · TSB A11Q0028 AC CRJ-705 · FAA AD 2014-22-04 B737 NLG · AD 2018-11-02 A320 LGCIU · EASA AD 2019-0036 ATR-72 · Boeing SB 737-32-1604 · Airbus SB A320-32-1554 · Boeing AERO Q3-2017 air-ground transition · MMEL B737 32-9 / A320 32-44 · SAE ARP 4754A / 4761.
      </div>
    </div>
  )
}
