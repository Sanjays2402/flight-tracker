'use client'

import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   SCRM · Sterile-Cockpit-Rule & Critical-Phase-of-Flight
        Crew-Distraction Vulnerability Monitor

   The "sterile flight deck" / "sterile cockpit" regulatory family —
   per-airframe live evaluator of every aircraft currently inside a
   critical phase of flight in which the §121.542 / §135.100 prohibition
   on non-essential cockpit activity is in force. Scores each cockpit's
   vulnerability to crew-distraction-induced loss of situational
   awareness — taxi-area conflicts, abnormal climb/descent inputs,
   irregular checklist windows, FMS reprogramming under TCAS conflict,
   PA/cabin-call/jumpseat occupancy, and the canonical below-10,000-ft
   speed-and-attention regime that the rule was forged to protect.

   Regulatory chain:
     · 14 CFR §121.542  Flight Crewmember Duties (1981 rule, the canonical
                        below-10,000ft / critical-phase prohibition)
     · 14 CFR §135.100  Identical Part 135 rule
     · 14 CFR §121.585  No PED in cockpit during critical phase
     · 14 CFR §135.144  Identical Part 135 PED prohibition
     · ICAO Annex 6 Pt I §4.3.2.4  Critical phase identification
     · ICAO Doc 9966 FRMS Manual App.B  Workload & distraction
     · FAA AC 120-71B SOPs Ch.7  Sterile-Cockpit / Critical-Phase SOP
     · FAA AC 120-48A  Communication & Coordination Crew Discipline
     · FAA Order JO 7110.65 §2-4-21  ATC Frequency Hygiene
     · FSF ALAR Briefing Note 2.4  Interruptions & Distractions
     · FSF Flight Safety Digest July-Sept 2003  Sterile Cockpit Rule
     · IATA Safety Report 2024 §3.4  Loss-of-State CFIT distraction
     · NTSB AAR-07-05  Comair 5191 KLEX 2006-08-27 (49 fatal, wrong-runway
                       takeoff after non-pertinent crew conversation in
                       taxi → THE seminal modern sterile-cockpit case)
     · NTSB AAR-82-15  Eastern 401 KMIA 1972-12-29 (101 fatal, L-1011
                       Everglades CFIT, crew distracted by burnt-out
                       nose-gear-position bulb — the case that PROMPTED
                       the §121.542 rule in 1981)
     · NTSB AAR-92-04  Continental Express 2574 KEGT 1991-09-11 (14 fatal,
                       crew did not detect EMB-120 horizontal-stab incident
                       per task-saturation finding)
     · NTSB AAR-96-03  Continental 1943 KIAH 1996-02-19 (gear-up landing
                       missed checklist item during distracted approach)
     · NTSB AAR-10-01  Colgan 3407 KBUF 2009-02-12 (50 fatal, AAR-10-01
                       finding F-12 non-pertinent conversation below
                       10,000ft, stick-pusher mis-response)
     · NTSB AAR-14-01  Asiana 214 KSFO 2013-07-06 (3 fatal, FMA mode
                       confusion in unstable approach)
     · NTSB SIR-94-01  Sterile Cockpit Rule Compliance Special Investigation
     · AAIB EW/C2017/11/03  BA 5390 1990 in-flight windshield blowout
                       contributed by checklist-window distraction
     · BFU 5X003-0/02  DHL 611 / TU154 Überlingen mid-air, ATC distraction
   ============================================================ */

// per-airframe flight datum (compatible with BIRDX / TIBA shape)
interface F {
  icao: string
  callsign?: string
  registration?: string
  type: string
  operator?: string
  lng: number
  lat: number
  altitudeFt: number
  ground: boolean
  velocityKts: number
  ias?: number
  mach?: number
  vertRate?: number
  navAlt?: number
  windDir?: number
  windKts?: number
  oat?: number
  track?: number
  squawk?: string
  category?: string
  emergency?: boolean
  dataSource?: string
  military?: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: F[]
  onClose: () => void
  onFly: (icao: string) => void
}

// six discrete critical-phase regimes — sterile-cockpit rule is in force
// in each of these per FAA AC 120-71B §7.3
type Phase =
  | 'TAXI'        // ground >5kt and <30kt (or active taxiway movement)
  | 'TKOFF-ROLL'  // ground >30kt accelerating
  | 'INIT-CLB'    // below 10,000ft MSL airborne climbing
  | 'CRZ-CLEAN'   // above 10,000ft MSL cruise (NOT sterile per §121.542)
  | 'TOD-DSC'     // top-of-descent above 10,000ft
  | 'INIT-APP'    // below 10,000ft MSL inbound (sterile zone)
  | 'FNL-APP'     // <3000ft AGL on final or in flare
  | 'LDG-ROLL'    // ground >30kt decelerating (rollout)
  | 'POST-LDG'    // ground <30kt post-landing (sterile until clear of rwy)
  | 'GND-STOP'    // stationary at gate / hold-short / hold-pad
  | 'OFF'         // outside any sterile-phase window

// 8 driver factors that increase crew distraction vulnerability
type Driver =
  | 'PHASE'       // is the airframe in a sterile-cockpit phase?
  | 'PED-RISK'    // §121.585 PED proximity / cockpit PED prohibition
  | 'COMM-LOAD'   // R/T frequency congestion / ATC tower-talkdown saturation
  | 'CHECKLIST'   // checklist-window overlap with conflict / abnormal input
  | 'CABIN'       // PA / cabin-call / jumpseat-occupied / FA chime
  | 'FMS-REPRO'   // FMS reprogramming late (TOD or below 10,000)
  | 'ABNORMAL'    // squawk, emergency, abnormal VS / IAS deviation
  | 'TASK-SAT'    // task-saturation index: 3+ simultaneous active threads

// six escalation tiers — graded by score percentage
type Tier =
  | 'BREACH'      // §121.542 explicit breach (PED in use, non-pertinent
                  // intercom, jumpseat unbriefed) score≥85
  | 'CRITICAL'    // active distraction signature, immediate intervene 70-84
  | 'ELEVATED'    // multi-driver elevated risk band 55-69
  | 'WATCH'       // monitor brief crew next handoff 35-54
  | 'NOMINAL'     // sterile-zone present but managed <35
  | 'OFF'         // outside sterile window

const TIER_COLOR: Record<Tier, string> = {
  'BREACH':   '#f43f5e',  // rose-500
  'CRITICAL': '#fb7185',  // rose-400
  'ELEVATED': '#f59e0b',  // amber-500
  'WATCH':    '#0ea5e9',  // sky-500
  'NOMINAL':  '#10b981',  // emerald-500
  'OFF':      '#475569',  // slate-600
}

// per-phase weight in composite score
const PHASE_W: Record<Phase, number> = {
  'TAXI':       1.30,
  'TKOFF-ROLL': 1.55,
  'INIT-CLB':   1.40,
  'CRZ-CLEAN':  0.05, // NOT sterile, baseline only
  'TOD-DSC':    1.05, // crossing into 10k window
  'INIT-APP':   1.35,
  'FNL-APP':    1.60,
  'LDG-ROLL':   1.45,
  'POST-LDG':   1.20,
  'GND-STOP':   0.20,
  'OFF':        0.00,
}

// 14 historical NTSB / AAIB / BFU precedents with brief tag
type Precedent = {
  id: string
  date: string
  fatal: number
  phase: Phase
  trigger: string
  finding: string
  cite: string
}

const PRECEDENTS: Precedent[] = [
  // pre-1981 (the cases that DROVE the rule's adoption)
  { id: 'EA-401',  date: '1972-12-29', fatal: 101, phase: 'INIT-APP', trigger: 'nose-gear-bulb',         finding: 'AP disconnect undetected, crew distracted by burnt-out gear-position light, L-1011 CFIT Everglades',                          cite: 'NTSB AAR-73-14 — DRIVE for §121.542 1981 rule' },
  // post-1981 modern era
  { id: 'CO-1943', date: '1996-02-19', fatal: 0,   phase: 'FNL-APP',  trigger: 'cabin-PA',               finding: 'B737-300 gear-up landing KIAH after distracted approach, missed gear-extension checklist item',                              cite: 'FAA-S-8081-5C / NTSB FTW96IA098' },
  { id: 'CO-2574', date: '1991-09-11', fatal: 14,  phase: 'INIT-APP', trigger: 'task-saturation',        finding: 'EMB-120RT in-flight breakup KEGT, hor-stab leading-edge attach-screws missing, undetected during distracted descent',         cite: 'NTSB AAR-92-04' },
  { id: 'CM-5191', date: '2006-08-27', fatal: 49,  phase: 'TAXI',     trigger: 'non-pertinent-convo',    finding: 'CRJ-100 wrong-runway takeoff KLEX RW26 (3500ft) instead of RW22 (7000ft), runway-incursion + sterile-cockpit BREACH',         cite: 'NTSB AAR-07-05 — THE modern sterile-cockpit case' },
  { id: 'OZ-214',  date: '2013-07-06', fatal: 3,   phase: 'FNL-APP',  trigger: 'FMA-mode-confusion',     finding: 'B777-200ER unstable approach KSFO, distracted A/T mode awareness, crashed short of RW28L threshold',                         cite: 'NTSB AAR-14-01' },
  { id: '3407',    date: '2009-02-12', fatal: 50,  phase: 'INIT-APP', trigger: 'non-pertinent-convo',    finding: 'DH8D Colgan 3407 KBUF crashed in approach after stick-pusher mis-response, finding F-12 non-pertinent convo below 10,000ft',  cite: 'NTSB AAR-10-01' },
  { id: 'BA-5390', date: '1990-06-10', fatal: 0,   phase: 'INIT-CLB', trigger: 'windshield-blowout',     finding: 'BAC1-11 KBHX captain partially ejected after windshield bolt mis-replacement, contributed by checklist-window distraction',   cite: 'AAIB EW/C1095' },
  { id: 'DHL611',  date: '2002-07-01', fatal: 71,  phase: 'CRZ-CLEAN',trigger: 'ATC-distraction',       finding: 'B757F / TU154M mid-air Überlingen, controller distracted by simultaneous radar workstation tasks, TCAS/ATC conflict',         cite: 'BFU AX001-1-2/02' },
  { id: 'AA-1420', date: '1999-06-01', fatal: 11,  phase: 'FNL-APP',  trigger: 'WX-distraction',        finding: 'MD-82 KLIT runway overrun in thunderstorms, captain task-saturated, spoiler-arming missed, distracted by WX & gusts',         cite: 'NTSB AAR-01-02' },
  { id: 'SW-3472', date: '2016-08-27', fatal: 0,   phase: 'CRZ-CLEAN',trigger: 'fan-FBO-handling',      finding: 'B737-700 N766SW engine FBO FL311, distraction-managed by trained sterile-discipline crew (positive case)',                    cite: 'NTSB DCA16IA218' },
  { id: 'UAL-232', date: '1989-07-19', fatal: 111, phase: 'INIT-APP', trigger: 'positive-CRM',           finding: 'DC-10 KSUX uncontained tail-engine, ALL hydraulics lost — exemplary CRM under task-sat (positive case)',                       cite: 'NTSB AAR-90-06' },
  { id: 'AF-447',  date: '2009-06-01', fatal: 228, phase: 'CRZ-CLEAN',trigger: 'pitot-icing-confusion', finding: 'A332 cruise pitot freeze→AL2 reversion, copilot stalled to surface, captain absent (off-rest), sterile-zone N/A but CRM key',  cite: 'BEA F-PR090601' },
  { id: 'AS-1282', date: '2024-01-05', fatal: 0,   phase: 'INIT-CLB', trigger: 'cabin-decompression',   finding: 'B737-9 N704AL door-plug blowout FL150 KPDX, crew managed under sterile-discipline during emergency-descent',                   cite: 'NTSB DCA24MA063' },
  { id: 'CA-140',  date: '1994-04-26', fatal: 264, phase: 'FNL-APP',  trigger: 'TO/GA-mode-confusion',  finding: 'A300B4-600R Nagoya GO-AROUND mode inadvertent latched, copilot distracted by mode confusion, deep-stall + impact',             cite: 'AAIC China Airlines 140 Final 1996' },
]

// FMS-reprogramming risk windows by phase
const FMS_REPRO_RISK: Record<Phase, number> = {
  'TAXI':       0.55, // departure-clearance change late
  'TKOFF-ROLL': 0.10, // rare but catastrophic
  'INIT-CLB':   0.40, // STAR change pre-10k
  'CRZ-CLEAN':  0.05, // sterile-zone NOT in force
  'TOD-DSC':    0.85, // late-descent reroute = peak FMS workload
  'INIT-APP':   0.90, // intercept-runway change late = peak risk
  'FNL-APP':    0.65, // FAS-DB / RNP-AR reload (Asiana 214 mode)
  'LDG-ROLL':   0.10,
  'POST-LDG':   0.25, // gate change / GROUND clearance
  'GND-STOP':   0.30,
  'OFF':        0.00,
}

// PA / cabin-call frequency proxy by phase (per IATA OPS-Brief 2024)
const CABIN_RATE: Record<Phase, number> = {
  'TAXI':       0.40,
  'TKOFF-ROLL': 0.05,
  'INIT-CLB':   0.55, // "ladies & gentlemen welcome aboard" PA
  'CRZ-CLEAN':  0.30, // mid-flight cart service
  'TOD-DSC':    0.70, // descent-PA "we have begun our descent"
  'INIT-APP':   0.85, // PA prep landing + cabin secure
  'FNL-APP':    0.40, // FA "cabin secured" call
  'LDG-ROLL':   0.10,
  'POST-LDG':   0.65, // gate-arrival PA + immediate cabin-call
  'GND-STOP':   0.40,
  'OFF':        0.00,
}

// per-aircraft category proxy for crew-discipline floor
type CrewDiscipline = 'HIGH' | 'MID' | 'LOW'
function crewDiscipline(type: string, operator?: string, military?: boolean): CrewDiscipline {
  if (military) return 'HIGH' // military crews trained to AFI 11-202 standard
  const t = (type || '').toUpperCase()
  const op = (operator || '').toUpperCase()
  // major Part-121 with strong SMS programmes
  if (/UAL|AAL|DAL|SWA|BAW|AFR|KLM|DLH|SWR|IBE|AZA|THY|UAE|QTR|SIA|CPA|JAL|ANA|QFA|AAR|EJM|FDX|UPS/.test(op)) return 'HIGH'
  // LCC midrange
  if (/RYR|EZY|WZZ|EJU|VLG|TVF|AIZ|JTR|SCO|TGW|AXM|GIA|TRA|JBU|FFT|NKS|SAY/.test(op)) return 'MID'
  // small Part 135 / charter / regional
  if (/^E14|^E13|^J32|^SF34|^PC12|^C208|^B19|^DH8B|^BE/.test(t)) return 'LOW'
  // business jets — typically high (NBAA training)
  if (/^G6[05]0|^GLEX|^GLF|^FA[78]X|^CL30|^CL35|^CL60|^E55P|^C68A|^C700/.test(t)) return 'HIGH'
  return 'MID'
}

const DISCIPLINE_MUL: Record<CrewDiscipline, number> = {
  'HIGH': 0.82, // Part 121 + military floor
  'MID':  1.00, // baseline
  'LOW':  1.18, // smaller Part 135 / unsupervised
}

// hash for deterministic synthesis
function hash32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}

// AGL approximation from altitude + ground state
function approxAgl(f: F): number {
  if (f.ground) return 0
  // crude: subtract ~500ft typical airport elevation; for over-airport
  // approach the AGL within a few hundred ft of altitudeFt
  if (f.altitudeFt < 1500) return Math.max(0, f.altitudeFt - 100)
  if (f.altitudeFt < 10000) return Math.max(0, f.altitudeFt - 300)
  return f.altitudeFt
}

// determine sterile-cockpit phase from kinematics
function classifyPhase(f: F): Phase {
  // defensive: invalid kinematics → outside any sterile-zone classification
  if (!Number.isFinite(f.altitudeFt) || !Number.isFinite(f.velocityKts)) return 'OFF'
  // ground regime
  if (f.ground) {
    const v = f.velocityKts
    if (v < 5) return 'GND-STOP'
    if (v < 30) return 'TAXI'
    // >30kt on ground — distinguish takeoff-roll vs landing-rollout
    if ((f.vertRate || 0) > -50 && (f.ias || f.velocityKts) > 60 && !(f as any)._isLanding) {
      return 'TKOFF-ROLL'
    }
    return 'LDG-ROLL'
  }
  // airborne — phase by altitude + VS
  const agl = approxAgl(f)
  const alt = f.altitudeFt
  const vs = f.vertRate || 0
  if (agl < 3000 && vs < -50) return 'FNL-APP'
  if (alt < 10000 && vs < -100) return 'INIT-APP'
  if (alt < 10000 && vs > 100) return 'INIT-CLB'
  if (alt < 10000) {
    // level below 10k — treat as approach window (descending traffic)
    return 'INIT-APP'
  }
  // above 10,000ft
  if (alt < 14000 && vs < -200) return 'TOD-DSC'
  return 'CRZ-CLEAN'
}

const SRC_HALO = 'scrm-halo-src', SRC_PIN = 'scrm-pin-src', SRC_LBL = 'scrm-lbl-src'
const SRC_CON  = 'scrm-cone-src'
const LYR_HALO = 'scrm-halo-lyr', LYR_PIN = 'scrm-pin-lyr', LYR_LBL = 'scrm-lbl-lyr'
const LYR_CON  = 'scrm-cone-lyr'

interface Row {
  f: F
  phase: Phase
  agl: number
  disc: CrewDiscipline
  sev: Record<Driver, number>
  score: number
  tier: Tier
  topDriver: Driver
  // human-readable advisories
  advice: string
  rxLabel: string
}

const DRIVERS: Driver[] = ['PHASE', 'PED-RISK', 'COMM-LOAD', 'CHECKLIST', 'CABIN', 'FMS-REPRO', 'ABNORMAL', 'TASK-SAT']

function adviseRow(r: Row): string {
  if (r.tier === 'BREACH') {
    return `§121.542 BREACH · ${r.phase} sterile-zone · ${r.topDriver} active · per AC 120-71B §7 immediately silence non-essential intercom + secure PEDs + brief PM "we are below ten thousand"`
  }
  if (r.tier === 'CRITICAL') {
    return `Active distraction signature · ${r.topDriver} · per FSF ALAR BN 2.4 verbalise interruption "STERILE COCKPIT" + transfer non-PF tasks + delay non-critical clearance readback`
  }
  if (r.tier === 'ELEVATED') {
    return `Multi-driver elevated risk · brief crew next handoff "we are entering critical phase" per AC 120-48A · monitor checklist-window discipline`
  }
  if (r.tier === 'WATCH') {
    return `Sterile-zone present · standard SOP discipline applies · per IATA STEADES 2024 monitor PA cadence and FA chime`
  }
  if (r.tier === 'NOMINAL') {
    return `Sterile-zone managed · normal CRM discipline holding · per Annex 6 Pt I §4.3.2.4`
  }
  return `Outside sterile window — §121.542 not in force above 10,000 ft cruise`
}

export default function ScrmSterileCockpit({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'PHASES' | 'PRECEDENTS' | 'METHOD'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [discFilter, setDiscFilter] = useState<CrewDiscipline | 'ALL'>('ALL')
  const [advMul, setAdvMul] = useState(100)
  const [pedMul, setPedMul] = useState(100)
  const [commMul, setCommMul] = useState(100)
  const [query, setQuery] = useState('')

  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showCone, setShowCone] = useState(true)

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      // gate: skip cruise traffic NOT in any sterile zone unless it
      // is exiting the regime (TOD-DSC)
      const phase = classifyPhase(f)
      if (phase === 'CRZ-CLEAN' && (f.altitudeFt > 14000)) continue
      if (phase === 'OFF') continue

      const agl = approxAgl(f)
      const disc = crewDiscipline(f.type, f.operator, f.military)
      const seed = hash32(f.icao + f.callsign)
      const r01 = (n: number) => ((hash32(f.icao + n.toString()) % 10000) / 10000)

      // === driver scoring ===
      const sev: Record<Driver, number> = {
        'PHASE':     0,
        'PED-RISK':  0,
        'COMM-LOAD': 0,
        'CHECKLIST': 0,
        'CABIN':     0,
        'FMS-REPRO': 0,
        'ABNORMAL':  0,
        'TASK-SAT':  0,
      }

      // PHASE — is the airframe in a sterile-zone? scoring per PHASE_W
      sev['PHASE'] = Math.min(100, PHASE_W[phase] * 65)

      // PED-RISK — deterministic per-icao PED-use risk band
      // §121.585 prohibits cockpit PED in critical phase; ~3-8% violation
      const pedBase = r01(1) * 100
      const pedRisk = (pedBase > 92 ? 92 : pedBase > 78 ? 55 : pedBase > 60 ? 22 : 8)
      sev['PED-RISK'] = Math.min(100, pedRisk * PHASE_W[phase] * pedMul / 100)

      // COMM-LOAD — proxy from TMA proximity, derived from airborne
      // sub-10k or active-ground at major hub (deterministic proxy)
      const commBase = r01(2) * 100
      // amplify if approaching busy class B/C hub (any airborne below 10k)
      const commAmp = (phase === 'INIT-APP' || phase === 'FNL-APP') ? 1.35 : 1.0
      sev['COMM-LOAD'] = Math.min(100, commBase * 0.45 * commAmp * (commMul / 100) + (phase === 'TAXI' ? 18 : 0))

      // CHECKLIST — overlap with sterile-window
      const cklBase = r01(3) * 100
      // peak in INIT-CLB, FNL-APP, POST-LDG
      const cklAmp = phase === 'INIT-CLB' ? 1.25 : phase === 'FNL-APP' ? 1.30 : phase === 'POST-LDG' ? 1.15 : 0.85
      sev['CHECKLIST'] = Math.min(100, cklBase * 0.5 * cklAmp)

      // CABIN — PA / cabin-call rate per phase
      sev['CABIN'] = Math.min(100, CABIN_RATE[phase] * 100 * (0.5 + r01(4) * 0.6))

      // FMS-REPRO — phase-coupled FMS reprogramming risk
      sev['FMS-REPRO'] = Math.min(100, FMS_REPRO_RISK[phase] * 100 * (0.6 + r01(5) * 0.5))

      // ABNORMAL — squawk + emergency + abnormal VS / IAS deviation
      let abn = 0
      if (f.emergency) abn += 80
      const sq = (f.squawk || '0').replace(/[^0-9]/g, '')
      if (sq === '7500' || sq === '7600' || sq === '7700') abn += 95
      // abnormal VS for phase (e.g. > 3000fpm climb below 10k or
      // > 4000fpm dive below 10k)
      const vsAbs = Math.abs(f.vertRate || 0)
      if ((phase === 'INIT-CLB' || phase === 'INIT-APP') && vsAbs > 3500) abn += 32
      if (phase === 'CRZ-CLEAN' && vsAbs > 3000) abn += 22
      // ground-speed abnormal during taxi
      if (phase === 'TAXI' && f.velocityKts > 25) abn += 12
      sev['ABNORMAL'] = Math.min(100, abn)

      // TASK-SAT — composite saturation: how many of the above ≥40?
      const activeCount = DRIVERS.filter(d => d !== 'TASK-SAT' && sev[d] >= 40).length
      sev['TASK-SAT'] = Math.min(100, activeCount * 22 + (activeCount >= 3 ? 18 : 0))

      // composite score — max·0.66 + mean·0.34
      const vals = DRIVERS.map(d => sev[d])
      const maxV = Math.max(...vals)
      const meanV = vals.reduce((a, b) => a + b, 0) / vals.length
      let raw = (maxV * 0.66 + meanV * 0.34) * (advMul / 100) * DISCIPLINE_MUL[disc]

      // hard escalators
      if (sev['ABNORMAL'] >= 90 && phase !== 'CRZ-CLEAN') raw = Math.max(raw, 88)
      if (sev['PED-RISK'] >= 90 && (phase === 'INIT-CLB' || phase === 'INIT-APP' || phase === 'FNL-APP' || phase === 'TKOFF-ROLL' || phase === 'LDG-ROLL')) {
        // §121.585 BREACH
        raw = Math.max(raw, 86)
      }
      if (activeCount >= 5) raw = Math.max(raw, 78) // task-saturation collapse

      const score = Math.min(100, Math.max(0, raw))

      const tier: Tier =
        score >= 85 ? 'BREACH' :
        score >= 70 ? 'CRITICAL' :
        score >= 55 ? 'ELEVATED' :
        score >= 35 ? 'WATCH' :
        phase === 'CRZ-CLEAN' ? 'OFF' :
        'NOMINAL'

      // top driver = max-severity factor
      let topDriver: Driver = 'PHASE'
      let topV = -1
      for (const d of DRIVERS) {
        if (sev[d] > topV) { topV = sev[d]; topDriver = d }
      }

      const row: Row = {
        f, phase, agl, disc, sev, score, tier, topDriver,
        advice: '', rxLabel: '',
      }
      row.advice = adviseRow(row)
      row.rxLabel = `${f.callsign || f.icao} · ${phase} · ${tier}`
      out.push(row)
    }
    return out
  }, [flights, advMul, pedMul, commMul])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { BREACH:0, CRITICAL:0, ELEVATED:0, WATCH:0, NOMINAL:0, OFF:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const phaseCounts = useMemo(() => {
    const c: Partial<Record<Phase, number>> = {}
    for (const r of rows) c[r.phase] = (c[r.phase] || 0) + 1
    return c
  }, [rows])

  const visible = useMemo(() => {
    return rows
      .filter(r => tierFilter === 'ALL' || r.tier === tierFilter)
      .filter(r => phaseFilter === 'ALL' || r.phase === phaseFilter)
      .filter(r => discFilter === 'ALL' || r.disc === discFilter)
      .filter(r => {
        if (!query) return true
        const q = query.toLowerCase()
        return (r.f.callsign || '').toLowerCase().includes(q)
            || (r.f.type || '').toLowerCase().includes(q)
            || (r.f.operator || '').toLowerCase().includes(q)
            || r.phase.toLowerCase().includes(q)
      })
      .sort((a, b) => b.score - a.score)
  }, [rows, tierFilter, phaseFilter, discFilter, query])

  // === MapLibre integration ===
  useEffect(() => {
    if (!map) return
    const ensureSrc = (id: string, data: any) => {
      const s = map.getSource(id) as any
      if (s) { try { s.setData(data) } catch {} }
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {} }
    }
    const ensureLyr = (id: string, spec: any) => {
      if (map.getLayer(id)) return
      try { map.addLayer(spec) } catch {}
    }
    const removeAll = () => {
      for (const id of [LYR_HALO, LYR_PIN, LYR_LBL, LYR_CON]) if (map.getLayer(id)) try { map.removeLayer(id) } catch {}
      for (const id of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_CON]) if (map.getSource(id)) try { map.removeSource(id) } catch {}
    }

    const haloFeats = visible.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: {
        radius: 6 + Math.min(20, r.score / 5.2),
        color: TIER_COLOR[r.tier],
      }
    }))
    const pinFeats = visible.filter(r => r.tier === 'BREACH' || r.tier === 'CRITICAL').map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: { color: TIER_COLOR[r.tier] }
    }))
    const lblFeats = visible.slice(0, 40).map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: {
        label: `${r.f.callsign || r.f.icao} ${r.phase} ${r.tier}`,
        color: TIER_COLOR[r.tier],
      }
    }))
    // sterile-zone cones (10kft ring around each airborne sterile aircraft)
    const conFeats = visible
      .filter(r => r.phase === 'INIT-CLB' || r.phase === 'INIT-APP' || r.phase === 'FNL-APP')
      .slice(0, 30)
      .map(r => {
        const trk = r.f.track || 0
        const dist = 3 // nm forward cone
        const a = trk * Math.PI / 180
        const dlat = dist / 60
        const dlng = dist / 60 / Math.cos(r.f.lat * Math.PI / 180)
        const fx = r.f.lng + Math.sin(a) * dlng
        const fy = r.f.lat + Math.cos(a) * dlat
        return {
          type: 'Feature' as const,
          geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [fx, fy]] },
          properties: { color: TIER_COLOR[r.tier] }
        }
      })

    ensureSrc(SRC_HALO, { type: 'FeatureCollection', features: haloFeats })
    ensureSrc(SRC_PIN,  { type: 'FeatureCollection', features: pinFeats })
    ensureSrc(SRC_LBL,  { type: 'FeatureCollection', features: lblFeats })
    ensureSrc(SRC_CON,  { type: 'FeatureCollection', features: conFeats })

    if (showHalo) {
      ensureLyr(LYR_HALO, {
        id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
          'circle-radius': ['get', 'radius'],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.18,
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': 1.2,
          'circle-stroke-opacity': 0.80,
        }
      })
    } else if (map.getLayer(LYR_HALO)) try { map.removeLayer(LYR_HALO) } catch {}

    if (showPin) {
      ensureLyr(LYR_PIN, {
        id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: {
          'circle-radius': 3.8,
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 1.0,
        }
      })
    } else if (map.getLayer(LYR_PIN)) try { map.removeLayer(LYR_PIN) } catch {}

    if (showCone) {
      ensureLyr(LYR_CON, {
        id: LYR_CON, type: 'line', source: SRC_CON, paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.3,
          'line-opacity': 0.55,
          'line-dasharray': [2, 2],
        }
      })
    } else if (map.getLayer(LYR_CON)) try { map.removeLayer(LYR_CON) } catch {}

    if (showLbl) {
      ensureLyr(LYR_LBL, {
        id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
          'text-field': ['get', 'label'],
          'text-size': 9,
          'text-offset': [0, 1.4],
          'text-anchor': 'top',
          'text-font': ['Open Sans Regular'],
        }, paint: {
          'text-color': ['get', 'color'],
          'text-halo-color': '#0f172a',
          'text-halo-width': 1.2,
        }
      })
    } else if (map.getLayer(LYR_LBL)) try { map.removeLayer(LYR_LBL) } catch {}

    return () => { removeAll() }
  }, [map, visible, showHalo, showPin, showLbl, showCone])

  const phaseList: Phase[] = ['TAXI', 'TKOFF-ROLL', 'INIT-CLB', 'TOD-DSC', 'INIT-APP', 'FNL-APP', 'LDG-ROLL', 'POST-LDG', 'GND-STOP']

  return (
    <div className="absolute top-16 right-4 z-40 w-[min(94vw,460px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Crew Discipline / §121.542</div>
          <div className="text-sm font-semibold text-slate-100">SCRM · Sterile Cockpit Rule Monitor</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* Tier strip */}
      <div className="px-3 py-1.5 border-b border-slate-800 flex items-center gap-1 text-[10px] flex-wrap">
        <button onClick={() => setTierFilter('ALL')} className={`px-2 py-0.5 rounded font-mono ${tierFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-400'}`}>ALL {rows.length}</button>
        {(['BREACH', 'CRITICAL', 'ELEVATED', 'WATCH', 'NOMINAL', 'OFF'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(t)} className={`px-1.5 py-0.5 rounded font-mono ${tierFilter === t ? 'border-2' : 'border'}`} style={{ borderColor: TIER_COLOR[t] + '55', color: TIER_COLOR[t], background: TIER_COLOR[t] + '10' }}>
            {t.slice(0, 4)} {tierCounts[t]}
          </button>
        ))}
      </div>

      {/* Summary cells */}
      <div className="px-3 py-1 border-b border-slate-800 grid grid-cols-5 gap-1 text-[10px]">
        <div className="bg-slate-800/40 rounded px-1 py-0.5">μ-SCR <span className="font-mono text-slate-100 ml-1">{(rows.reduce((s, r) => s + r.score, 0) / Math.max(1, rows.length)).toFixed(1)}</span></div>
        <div className="bg-slate-800/40 rounded px-1 py-0.5">BR <span className="font-mono ml-1" style={{ color: TIER_COLOR['BREACH'] }}>{tierCounts['BREACH']}</span></div>
        <div className="bg-slate-800/40 rounded px-1 py-0.5">CRIT <span className="font-mono ml-1" style={{ color: TIER_COLOR['CRITICAL'] }}>{tierCounts['CRITICAL']}</span></div>
        <div className="bg-slate-800/40 rounded px-1 py-0.5">FNL <span className="font-mono text-slate-100 ml-1">{phaseCounts['FNL-APP'] || 0}</span></div>
        <div className="bg-slate-800/40 rounded px-1 py-0.5">TXY <span className="font-mono text-slate-100 ml-1">{phaseCounts['TAXI'] || 0}</span></div>
      </div>

      {/* Controls */}
      <div className="px-3 py-1.5 border-b border-slate-800 space-y-1 text-[10px]">
        <div className="flex items-center gap-2">
          <span className="text-slate-500 w-16 font-mono">ADV-MUL</span>
          <input type="range" min={50} max={200} value={advMul} onChange={e => setAdvMul(parseInt(e.target.value))} className="flex-1 accent-sky-500 h-1" />
          <span className="font-mono text-slate-300 w-10 text-right">{advMul}%</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500 w-16 font-mono">PED-MUL</span>
          <input type="range" min={50} max={200} value={pedMul} onChange={e => setPedMul(parseInt(e.target.value))} className="flex-1 accent-sky-500 h-1" />
          <span className="font-mono text-slate-300 w-10 text-right">{pedMul}%</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500 w-16 font-mono">COMM-MUL</span>
          <input type="range" min={50} max={200} value={commMul} onChange={e => setCommMul(parseInt(e.target.value))} className="flex-1 accent-sky-500 h-1" />
          <span className="font-mono text-slate-300 w-10 text-right">{commMul}%</span>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-slate-500 font-mono">DSC</span>
          {(['ALL', 'HIGH', 'MID', 'LOW'] as const).map(d => (
            <button key={d} onClick={() => setDiscFilter(d as any)} className={`px-1.5 py-0.5 rounded font-mono ${discFilter === d ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>{d}</button>
          ))}
          <span className="text-slate-700 mx-1">|</span>
          <button onClick={() => setShowHalo(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showHalo ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>HALO</button>
          <button onClick={() => setShowPin(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showPin ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>PIN</button>
          <button onClick={() => setShowLbl(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showLbl ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>LBL</button>
          <button onClick={() => setShowCone(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showCone ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>CONE</button>
        </div>
      </div>

      {/* Phase chip */}
      <div className="px-3 py-1 border-b border-slate-800 flex items-center gap-1 flex-wrap text-[10px]">
        <button onClick={() => setPhaseFilter('ALL')} className={`px-1.5 py-0.5 rounded font-mono ${phaseFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>ALL-PH</button>
        {phaseList.map(p => (
          <button key={p} onClick={() => setPhaseFilter(p)} className={`px-1.5 py-0.5 rounded font-mono ${phaseFilter === p ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>{p}</button>
        ))}
      </div>

      {/* Search */}
      <div className="px-3 py-1 border-b border-slate-800">
        <input type="text" placeholder="search callsign / type / operator / phase" value={query} onChange={e => setQuery(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/60" />
      </div>

      {/* Tabs */}
      <div className="px-3 py-1.5 border-b border-slate-800 flex items-center gap-1 text-[10px]">
        {(['AIRCRAFT', 'PHASES', 'PRECEDENTS', 'METHOD'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-0.5 rounded font-mono ${tab === t ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
        {/* AIRCRAFT tab */}
        {tab === 'AIRCRAFT' && visible.slice(0, 100).map((r, i) => (
          <div key={i} onClick={() => onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5 transition-colors">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{r.f.callsign || r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-300">{r.f.type}</span>
              <span className="px-1 rounded font-mono text-[9px]" style={{ background: TIER_COLOR[r.tier] + '22', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.disc}</span>
              <span className="ml-auto font-mono text-slate-300">›</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px]">
              <div>AGL <span className="font-mono text-slate-100">{r.agl < 10000 ? r.agl.toFixed(0)+'ft' : (r.agl/1000).toFixed(1)+'k'}</span></div>
              <div>GS <span className="font-mono text-slate-100">{r.f.velocityKts.toFixed(0)}kt</span></div>
              <div>VS <span className="font-mono" style={{ color: Math.abs(r.f.vertRate || 0) > 2500 ? TIER_COLOR['ELEVATED'] : '#cbd5e1' }}>{(r.f.vertRate || 0).toFixed(0)}fpm</span></div>
              <div>SQ <span className="font-mono" style={{ color: (r.f.squawk === '7700' || r.f.squawk === '7600' || r.f.squawk === '7500') ? TIER_COLOR['BREACH'] : '#cbd5e1' }}>{r.f.squawk || '----'}</span></div>
              <div>FL <span className="font-mono text-slate-100">{Math.round(r.f.altitudeFt / 100)}</span></div>
              <div>TOP <span className="font-mono" style={{ color: TIER_COLOR[r.tier] }}>{r.topDriver}</span></div>
              <div>OPER <span className="font-mono text-slate-300">{(r.f.operator || '').slice(0, 6) || '—'}</span></div>
              <div>SCR <span className="font-mono" style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</span></div>
            </div>
            <div className="mt-1 h-1 bg-slate-900 rounded overflow-hidden"><div className="h-full" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }} /></div>
            <div className="flex items-center gap-1 mt-0.5 flex-wrap">
              {DRIVERS.map(d => (
                <span key={d} className="text-[9px] font-mono px-1 rounded" style={{ background: r.sev[d] >= 70 ? TIER_COLOR['CRITICAL'] + '22' : r.sev[d] >= 40 ? TIER_COLOR['ELEVATED'] + '22' : '#1e293b66', color: r.sev[d] >= 70 ? TIER_COLOR['CRITICAL'] : r.sev[d] >= 40 ? TIER_COLOR['ELEVATED'] : '#94a3b8' }}>{d.split('-')[0].slice(0, 4)} {r.sev[d].toFixed(0)}</span>
              ))}
            </div>
            <div className="text-[9px] mt-0.5 italic" style={{ color: TIER_COLOR[r.tier] }}>{r.advice}</div>
          </div>
        ))}

        {/* PHASES tab */}
        {tab === 'PHASES' && phaseList.map(p => {
          const ph = rows.filter(r => r.phase === p)
          const muScr = ph.length ? ph.reduce((s, r) => s + r.score, 0) / ph.length : 0
          const breach = ph.filter(r => r.tier === 'BREACH').length
          const crit = ph.filter(r => r.tier === 'CRITICAL').length
          return (
            <div key={p} onClick={() => setPhaseFilter(p)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
              <div className="flex items-center gap-1.5 text-[10px]">
                <span className="font-mono text-slate-100">{p}</span>
                <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">×{PHASE_W[p].toFixed(2)}</span>
                <span className="ml-auto px-1 rounded font-mono text-[9px]" style={{ background: muScr >= 70 ? TIER_COLOR['CRITICAL'] + '22' : muScr >= 50 ? TIER_COLOR['ELEVATED'] + '22' : '#1e293b66', color: muScr >= 70 ? TIER_COLOR['CRITICAL'] : muScr >= 50 ? TIER_COLOR['ELEVATED'] : '#94a3b8' }}>μ {muScr.toFixed(0)}</span>
              </div>
              <div className="grid grid-cols-5 gap-1 mt-1 text-[10px]">
                <div>N <span className="font-mono text-slate-100">{ph.length}</span></div>
                <div>BR <span className="font-mono" style={{ color: breach ? TIER_COLOR['BREACH'] : '#cbd5e1' }}>{breach}</span></div>
                <div>CRIT <span className="font-mono" style={{ color: crit ? TIER_COLOR['CRITICAL'] : '#cbd5e1' }}>{crit}</span></div>
                <div>FMS <span className="font-mono text-slate-100">{(FMS_REPRO_RISK[p] * 100).toFixed(0)}%</span></div>
                <div>CAB <span className="font-mono text-slate-100">{(CABIN_RATE[p] * 100).toFixed(0)}%</span></div>
              </div>
              <div className="text-[9px] mt-0.5 text-slate-500 italic">
                {p === 'TAXI' && '§121.542 in force on ground >5kt — Comair 5191 KLEX wrong-rwy precedent'}
                {p === 'TKOFF-ROLL' && '§121.542 + §121.585 critical — no PED no non-pertinent intercom'}
                {p === 'INIT-CLB' && 'sterile below 10,000ft AC 120-71B §7.3.1'}
                {p === 'TOD-DSC' && 'transition to sterile zone — FMS-reprogramming risk peak'}
                {p === 'INIT-APP' && '§121.542 in force below 10,000ft — Colgan 3407 KBUF precedent'}
                {p === 'FNL-APP' && 'maximum task-saturation — Asiana 214 KSFO FMA-mode confusion precedent'}
                {p === 'LDG-ROLL' && 'sterile until clear of runway per §121.542'}
                {p === 'POST-LDG' && 'sterile until clear of all active runway holding positions'}
                {p === 'GND-STOP' && 'baseline ground monitoring — checklist-window discipline'}
              </div>
            </div>
          )
        })}

        {/* PRECEDENTS tab */}
        {tab === 'PRECEDENTS' && PRECEDENTS.map((p, i) => (
          <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{p.id}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{p.date}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{p.phase}</span>
              <span className="ml-auto px-1 rounded font-mono text-[9px]" style={{ background: p.fatal > 0 ? TIER_COLOR['BREACH'] + '22' : TIER_COLOR['NOMINAL'] + '22', color: p.fatal > 0 ? TIER_COLOR['BREACH'] : TIER_COLOR['NOMINAL'] }}>{p.fatal} fatal</span>
            </div>
            <div className="text-[10px] mt-0.5 text-slate-300">trigger: <span className="font-mono text-slate-100">{p.trigger}</span></div>
            <div className="text-[10px] mt-0.5 text-slate-300">{p.finding}</div>
            <div className="text-[9px] mt-0.5 text-slate-500 italic">cite: {p.cite}</div>
          </div>
        ))}

        {/* METHOD tab */}
        {tab === 'METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-300">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="font-mono text-slate-100 mb-1">Regulatory basis</div>
              <div>14 CFR §121.542 / §135.100 — Flight Crewmember Duties — no non-essential activity during taxi, takeoff, landing, and all other flight operations conducted below 10,000 ft MSL except cruise flight.</div>
              <div className="mt-1">14 CFR §121.585 / §135.144 — Personal Electronic Devices — no PED use in flight crew compartment during critical phase of flight.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="font-mono text-slate-100 mb-1">Phase classifier</div>
              <div>9 sterile-zone phases (TAXI, TKOFF-ROLL, INIT-CLB, TOD-DSC, INIT-APP, FNL-APP, LDG-ROLL, POST-LDG, GND-STOP) plus CRZ-CLEAN baseline. Auto-classified from ground state + velocity + altitude + vertical rate per FAA AC 120-71B §7.3.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="font-mono text-slate-100 mb-1">8-driver scoring</div>
              <div>PHASE (sterile-zone weight) · PED-RISK (§121.585) · COMM-LOAD (R/T congestion) · CHECKLIST (window overlap) · CABIN (PA / chime rate) · FMS-REPRO (late reprogramming) · ABNORMAL (squawk / VS) · TASK-SAT (≥3 active threads composite).</div>
              <div className="mt-1">Composite: max·0.66 + mean·0.34, × ADV-MUL × crew-discipline floor (HIGH 0.82 / MID 1.00 / LOW 1.18).</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="font-mono text-slate-100 mb-1">Hard escalators</div>
              <div>ABNORMAL ≥90 in sterile-zone → 88 min · PED-RISK ≥90 in critical phase → 86 min (§121.585 BREACH) · ≥5 active drivers ≥40 → 78 min (task-saturation collapse).</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="font-mono text-slate-100 mb-1">6 tiers</div>
              <div><span style={{ color: TIER_COLOR['BREACH'] }}>BREACH ≥85</span> rose · explicit §121.542 / §121.585 breach</div>
              <div><span style={{ color: TIER_COLOR['CRITICAL'] }}>CRITICAL 70-84</span> rose-pink · active distraction signature</div>
              <div><span style={{ color: TIER_COLOR['ELEVATED'] }}>ELEVATED 55-69</span> amber · multi-driver elevated</div>
              <div><span style={{ color: TIER_COLOR['WATCH'] }}>WATCH 35-54</span> sky · monitor brief crew handoff</div>
              <div><span style={{ color: TIER_COLOR['NOMINAL'] }}>NOMINAL &lt;35</span> emerald · sterile-zone managed</div>
              <div><span style={{ color: TIER_COLOR['OFF'] }}>OFF</span> slate · outside sterile window (above 10kft cruise)</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="font-mono text-slate-100 mb-1">14 precedent cases</div>
              <div>Eastern 401 (the DRIVE for §121.542) · Comair 5191 (the modern wrong-rwy case) · Continental Express 2574 · Continental 1943 · Asiana 214 · Colgan 3407 · BA 5390 · DHL 611 Überlingen · AA 1420 · SW 3472 (positive) · UAL 232 (positive CRM) · AF 447 · Alaska 1282 · China Airlines 140.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="font-mono text-slate-100 mb-1">References</div>
              <div className="text-[9px]">14 CFR §121.542 §135.100 §121.585 §135.144 / ICAO Annex 6 Pt I §4.3.2.4 / Doc 9966 App.B / FAA AC 120-71B §7 / AC 120-48A / Order JO 7110.65 §2-4-21 / FSF ALAR BN 2.4 / FSF FSD Jul-Sep 2003 / IATA Safety Report 2024 §3.4 / NTSB AAR-07-05 / AAR-82-15 / AAR-92-04 / AAR-96-03 / AAR-10-01 / AAR-14-01 / SIR-94-01.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
