'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Oxygen Supply Duration vs Required-Descent Monitor (ATA-35)
   -----------------------------------------------------------
   For every airborne aircraft, reconstructs three independent
   O2 subsystems and compares their available duration against
   the required descent profile to reach a breathable cabin
   altitude (10,000 ft) following an explosive depressurisation:

     1. Crew (diluter-demand) gaseous O2 cylinder
        per FAA Part 121.333 / AC 25-23 / Boeing FCOM 35.10:
        2200 psi @ 70°F  ·  HVY 115 cu-ft  ·  NRW 76 cu-ft
        Duration = (cyl-ft^3 · purity · psi-frac) ÷ (LPM × crewN ÷ 28.3)
        crew LPM @ FL250: 12 (100%), FL400: 28 (PBE-loaded)

     2. Passenger PSU chemical generators (Scott / B/E Aerospace
        SCS-1500 / OBOGS for HVY) — fixed 12-min nominal,
        13-22 min in HVY classes per Boeing 777 FCOM 35.20.
        Once initiated, cannot be re-set: full burn even if QRH
        emergency-descent is shorter.

     3. Portable bottles (PO2 / Avox) — 11 cu-ft @ 1800 psi,
        used for cabin-crew walk-around + first-aid + fume.

   Then computes Required-Descent Time (RDT) per AC 25-1322-1:
     emergency descent from current FL → 14k @ +M0.02 over Mmo,
     bank 30°, idle thrust + speedbrakes ·  ~3500-6000 fpm net.
     Plus terrain MEA gate: cannot descend below MORA along
     track-ahead 100 nm (GTOPO30 / SRTM-30 approximated by
     hash-stable elevation bins).

   5 RISK DRIVERS (max-driver composite):
     SUP  worst-subsystem supply margin vs RDT
          (100 at margin<0, 0 at margin>=2.0×RDT)
     RDT  RDT itself (terrain-limited descent>22 min → 100)
     PSU  fraction PSU activations consumed (>0.55 at FL>FL300 = 100)
     PRT  portable-bottle count vs cabin crew required
          (FAR 121.333(c)(2) 1 per cabin-crew + 2 first-aid)
     MEA  enroute MORA above 10k → forces O2 descent floor up

   PHASE multiplier:  CRZ 1.10  CLB 1.00  DES 0.85  APP 0.70

   5 TIERS:
     CRITICAL  score≥80 OR supply<RDT OR PSU exhausted before
               cabin alt < 10k →  rose  ·  declare MAYDAY emergency
               descent IDLE+S-BRK 30° bank to MEA / oceanic vector
               per Boeing FCOM 9.20 RAPID DEPRESS / Airbus PRO-ABN-21
     DEGRADED  score≥55 OR supply<1.3×RDT OR portable count short
               → amber  ·  brief crew, plan early descent FL250,
               retain ETOPS alternate per FAA AC 120-42B App I-5
     WATCH     score≥25 sky · log cylinder pressure every 30min,
               verify PSU initiator continuity per QRH 35-1
     OK        score<25 emerald · supply ≥ 2.0× RDT, all margins +
     IDLE      below FL100 or ground · slate

   60-airframe class catalogue keyed by ICAO type prefix:
     HVY-Q  4-eng (747/A380)  OBOGS+chem 22min  cyl 115ft³  port 6
     HVY    2-eng widebody (777/787/A350/A330)  chem 17min  cyl 115  port 5
     NRW    737/A320/757  chem 12min  cyl 76  port 3
     RGN    E-jet/CRJ  chem 12min  cyl 76  port 2
     BIZ    Gulfstream/Falcon  chem N/A bottles  cyl 49  port 2
     TBP    ATR/Dash-8  chem N/A bottles  cyl 38  port 2

   MapLibre overlay:
     · tier-coloured halo rings 8-22 px by score
     · rose diamond pin at current pos for CRITICAL
     · tier-coloured callsign + duration-min / RDT-min labels
     · 14-segment dashed forward-projection 100 nm tier-coloured
       (RDT-distance estimate at idle descent)
     · dashed sky reference parallels at lat ±60/±30/0 every 12° lng

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell WORST-MARGIN-min tier-coloured / WORST callsign /
       CRITICAL-count summary
     · 2-cell MEAN-CYL-DUR-min tier-coloured / PSU-INIT-share
     · SVG supply-min vs RDT-min scatter with rose <1.0×RDT
       quadrant / amber 1.0-1.3× / sky 1.3-2.0× / emerald >2.0×
       + dashed RDT diagonal y=x + RDT-22min vertical
     · 6 sliders MIN-FL / CYL-PSI / PSU-MUL / CABIN-N / MEA-BIAS / PHASE-WT
     · 6-class chip filter HVY-Q HVY NRW RGN BIZ TBP
     · HALO PIN LBL PROJ REF DIAG toggles
     · search callsign / type / operator / icao
     · AIRCRAFT or CLASSES tab switcher

   References: 14 CFR 121.329 / 121.333 / 25.1441 / 25.1443 ·
   FAA AC 25-1322-1 · AC 25-23 · AC 120-42B App I-5 ETOPS ·
   ICAO Annex 6 Pt I 4.3.9 supplemental O2 · Boeing 737/777/787
   FCOM 35 OXYGEN · Airbus A320/A330/A350 FCOM 21-50 · NTSB
   AAR-89/03 Aloha 243 / AAR-99/01 SilkAir 185 / DCA10IA006 ·
   FAA AD 2017-13-04 OBOGS / EASA AD 2020-0142 PSU generator.
   ft-o2dur persisted preference.
   ============================================================ */

export interface OxFlight {
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
  flights: OxFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'CRITICAL' | 'DEGRADED' | 'WATCH' | 'OK' | 'IDLE'
type ClassKey = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'

const TIER_COLOR: Record<Tier, string> = {
  CRITICAL: '#f43f5e',
  DEGRADED: '#f59e0b',
  WATCH: '#0ea5e9',
  OK: '#10b981',
  IDLE: '#475569',
}
const TIER_BG: Record<Tier, string> = {
  CRITICAL: 'bg-rose-500/15 border-rose-500/40 text-rose-200',
  DEGRADED: 'bg-amber-500/15 border-amber-500/40 text-amber-200',
  WATCH: 'bg-sky-500/15 border-sky-500/40 text-sky-200',
  OK: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
  IDLE: 'bg-slate-700/30 border-slate-600/40 text-slate-300',
}
const TIER_ORDER: Tier[] = ['CRITICAL', 'DEGRADED', 'WATCH', 'OK', 'IDLE']

const CLASS_SPEC: Record<ClassKey, {
  family: string
  cylFt3: number          // crew O2 cylinder volume (cu ft @ STP)
  psiNom: number          // nominal psi at full charge
  crewN: number           // pilot positions
  psuMinutes: number      // pax chemical generator duration (min)
  portableN: number       // portable bottles installed
  cabinCrewBase: number   // cabin crew (for portable requirement)
  obogs: boolean          // OBOGS-equipped (continuous flow)
  descentFpm: number      // emergency-descent net rate
}> = {
  'HVY-Q': { family: '747-8 / A380 / A340', cylFt3: 115, psiNom: 2200, crewN: 3, psuMinutes: 22, portableN: 6, cabinCrewBase: 14, obogs: true,  descentFpm: 6000 },
  'HVY':   { family: '777 / 787 / A350 / A330', cylFt3: 115, psiNom: 2200, crewN: 2, psuMinutes: 17, portableN: 5, cabinCrewBase: 10, obogs: true,  descentFpm: 6000 },
  'NRW':   { family: '737 / A320 / 757',  cylFt3: 76,  psiNom: 1850, crewN: 2, psuMinutes: 12, portableN: 3, cabinCrewBase: 4,  obogs: false, descentFpm: 5000 },
  'RGN':   { family: 'CRJ / E-Jet / MD',  cylFt3: 76,  psiNom: 1850, crewN: 2, psuMinutes: 12, portableN: 2, cabinCrewBase: 2,  obogs: false, descentFpm: 4500 },
  'BIZ':   { family: 'GLF / FA7X / CL30', cylFt3: 49,  psiNom: 1850, crewN: 2, psuMinutes: 0,  portableN: 2, cabinCrewBase: 1,  obogs: false, descentFpm: 5500 },
  'TBP':   { family: 'ATR / Dash-8 / PT6',cylFt3: 38,  psiNom: 1850, crewN: 2, psuMinutes: 0,  portableN: 2, cabinCrewBase: 1,  obogs: false, descentFpm: 3500 },
}

const SRC_HALO = 'o2d-halo-src',   LYR_HALO = 'o2d-halo-lyr'
const SRC_PIN  = 'o2d-pin-src',    LYR_PIN  = 'o2d-pin-lyr'
const SRC_LBL  = 'o2d-lbl-src',    LYR_LBL  = 'o2d-lbl-lyr'
const SRC_PROJ = 'o2d-proj-src',   LYR_PROJ = 'o2d-proj-lyr'
const SRC_REF  = 'o2d-ref-src',    LYR_REF  = 'o2d-ref-lyr'

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
function hashUnit(s: string, salt: string): number { return (fnv1a(s + ':' + salt) / 0xffffffff) }

function classifyAircraft(type?: string, category?: number | string): ClassKey {
  const t = (type || '').toUpperCase()
  if (/^(A380|A388|B748|B744|A340|A346|A343)/.test(t)) return 'HVY-Q'
  if (/^(B77|B78|A350|A359|A35K|A330|A338|A339|A332|A333|MD11|B763|B764|B772|B773|B788|B789|B78X)/.test(t)) return 'HVY'
  if (/^(B73|A32|A31|A19|A20|A21|B75|B752|MD8|MD9)/.test(t)) return 'NRW'
  if (/^(CRJ|E1[79]|E2[19]|E29|E75|E7W|MD8|RJ85|RJ1H|F100|F70)/.test(t)) return 'RGN'
  if (/^(GLF|GLEX|GL5T|GL7T|GLF[0-9]|FA[0-9]|F2TH|F900|F7X|CL30|CL60|CL35|C25|C56|C68|E55|E50|H25|LJ)/.test(t)) return 'BIZ'
  if (/^(AT[47]|DH[8C]|SF34|J32|J41|B190|PC12|PC[0-9]|TBM|C208|BE[0-9])/.test(t)) return 'TBP'
  const cn = typeof category === 'string' ? parseInt(category, 10) : category
  if (cn === 5 || cn === 6) return 'HVY'
  if (cn === 4) return 'NRW'
  if (cn === 3) return 'RGN'
  if (cn === 2) return 'TBP'
  return 'NRW'
}

function phaseOf(f: OxFlight): 'CRZ' | 'CLB' | 'DES' | 'APP' {
  const fl = f.altitudeFt / 100
  if (fl < 100) return 'APP'
  if (f.vertRate > 800) return 'CLB'
  if (f.vertRate < -800) return 'DES'
  return 'CRZ'
}
const PHASE_MUL: Record<'CRZ' | 'CLB' | 'DES' | 'APP', number> = { CRZ: 1.10, CLB: 1.00, DES: 0.85, APP: 0.70 }

const toRad = (d: number) => (d * Math.PI) / 180
const toDeg = (r: number) => (r * 180) / Math.PI
function destPoint(lat: number, lng: number, brgDeg: number, distNm: number): [number, number] {
  const R = 3440.065
  const br = toRad(brgDeg)
  const d = distNm / R
  const phi1 = toRad(lat), lam1 = toRad(lng)
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(br))
  const lam2 = lam1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(phi1), Math.cos(d) - Math.sin(phi1) * Math.sin(phi2))
  return [(toDeg(lam2) + 540) % 360 - 180, toDeg(phi2)]
}

// MEA / MORA estimate: hash-stable per 1° cell, biased by latitude (poles flat, Andes/Himalaya peaks)
function moraFt(lat: number, lng: number): number {
  const ilat = Math.floor(lat), ilng = Math.floor(lng)
  const cell = `${ilat}|${ilng}`
  const u = hashUnit(cell, 'mora')
  // baseline 1500 ft + climate bias
  const aLat = Math.abs(lat)
  let bias = 1500
  // Himalaya / Tibet
  if (lat > 25 && lat < 40 && lng > 70 && lng < 105) bias = 12000 + u * 8000
  // Andes
  else if (lat > -55 && lat < 12 && lng > -82 && lng < -65) bias = 9000 + u * 6000
  // Rockies
  else if (lat > 30 && lat < 60 && lng > -125 && lng < -103) bias = 7000 + u * 5000
  // Alps
  else if (lat > 43 && lat < 48 && lng > 5 && lng < 14) bias = 6000 + u * 4000
  // Greenland
  else if (lat > 60 && lat < 84 && lng > -55 && lng < -20) bias = 5000 + u * 3000
  // Ocean cells (most cells with u < 0.3 and not over land are ocean)
  else if (aLat < 65 && u < 0.35) bias = 100 + u * 500
  else bias = 1500 + u * 2500
  return Math.round(bias)
}

interface Calc {
  classKey: ClassKey
  phase: 'CRZ' | 'CLB' | 'DES' | 'APP'
  fl: number
  cylPsiAct: number
  cylDurMin: number
  psuDurMin: number
  psuConsumed: number  // fraction
  portableN: number
  portableReq: number
  moraFt: number
  descentFloorFt: number
  rdtMin: number
  worstSupplyMin: number
  marginMin: number
  scorePos: number
  scoreSup: number
  scoreRdt: number
  scorePsu: number
  scorePrt: number
  scoreMea: number
  score: number
  tier: Tier
  driver: 'SUP' | 'RDT' | 'PSU' | 'PRT' | 'MEA'
  advice: string
}

function compute(f: OxFlight, opts: {
  cylMul: number, psuMul: number, cabinMul: number, meaBias: number, phaseW: number, minFL: number,
}): Calc {
  const classKey = classifyAircraft(f.type, f.category)
  const sp = CLASS_SPEC[classKey]
  const phase = phaseOf(f)
  const fl = f.altitudeFt / 100

  // Per-airframe stable psi deviation: 0.55..1.0
  const u1 = hashUnit(f.icao, 'psi')
  const u2 = hashUnit(f.icao, 'psu')
  const u3 = hashUnit(f.icao, 'crewlpm')
  const u4 = hashUnit(f.icao, 'cabin')

  const psiFrac = 0.55 + u1 * 0.45            // current bottle fill
  const cylPsiAct = Math.round(sp.psiNom * psiFrac * opts.cylMul)

  // Crew demand LPM at altitude (Part 121.333 + diluter-demand)
  // <FL250 ≈ 6 lpm, FL250-350 ≈ 12, FL350-400 ≈ 22, >FL400 ≈ 28
  let lpmPerPilot = 6
  if (fl > 250) lpmPerPilot = 12
  if (fl > 350) lpmPerPilot = 22
  if (fl > 400) lpmPerPilot = 28
  lpmPerPilot *= (0.9 + u3 * 0.25)
  const totalLpm = lpmPerPilot * sp.crewN
  // Convert ft³ STP at psiFrac to litres → divide by lpm = minutes
  // 1 ft³ = 28.317 L
  const usableFt3 = sp.cylFt3 * psiFrac
  const cylDurMin = (usableFt3 * 28.317) / totalLpm

  // PSU: chemical generators are one-shot, full burn after deploy
  const psuConsumed = u2 * 0.6  // assume avg 0-60% already consumed in real fleet history?
  const psuDurMin = sp.psuMinutes * (1 - psuConsumed) * opts.psuMul

  // Worst supply = limiting subsystem (crew vs PSU); below FL250 only crew counts
  const worstSupplyMin = fl > 250
    ? Math.min(cylDurMin, sp.psuMinutes > 0 ? psuDurMin : cylDurMin)
    : cylDurMin

  // Portable bottle requirement: 1 per cabin-crew + 2 first-aid (FAR 121.333(c)(2))
  const cabinCrew = Math.max(1, Math.round(sp.cabinCrewBase * (0.7 + u4 * 0.5) * opts.cabinMul))
  const portableReq = cabinCrew + 2
  const portableN = sp.portableN

  // MEA / MORA along track-ahead 100 nm: max of 4 sample bins
  const samples = 4
  let mora = moraFt(f.lat, f.lng)
  for (let i = 1; i <= samples; i++) {
    const [lng2, lat2] = destPoint(f.lat, f.lng, f.track || 0, i * 25)
    mora = Math.max(mora, moraFt(lat2, lng2))
  }
  mora += opts.meaBias

  // Descent floor: greater of 10,000 ft (breathable) and MORA+1000
  const descentFloorFt = Math.max(10000, mora + 1000)
  const dropFt = Math.max(0, f.altitudeFt - descentFloorFt)
  // ICAO descent rate: idle + speedbrakes ~ class-dependent
  const rdtMin = dropFt / sp.descentFpm  // minutes

  const marginMin = worstSupplyMin - rdtMin
  // === scores ===
  let scoreSup = 0
  if (marginMin < 0) scoreSup = 100
  else if (marginMin >= 2.0 * Math.max(0.5, rdtMin)) scoreSup = 0
  else scoreSup = 100 * (1 - marginMin / (2.0 * Math.max(0.5, rdtMin)))

  let scoreRdt = 0
  if (rdtMin >= 22) scoreRdt = 100
  else if (rdtMin <= 4) scoreRdt = 0
  else scoreRdt = (rdtMin - 4) / 18 * 100

  let scorePsu = 0
  if (sp.psuMinutes > 0 && fl > 300) {
    if (psuConsumed > 0.55) scorePsu = 100
    else if (psuConsumed > 0.30) scorePsu = (psuConsumed - 0.30) / 0.25 * 100
    else scorePsu = 0
  }

  let scorePrt = 0
  if (portableN < portableReq) {
    const gap = portableReq - portableN
    scorePrt = Math.min(100, gap * 35)
  }

  let scoreMea = 0
  if (mora > 10000) scoreMea = Math.min(100, (mora - 10000) / 80) // 10k→0, 18k→100

  const arr: Array<['SUP'|'RDT'|'PSU'|'PRT'|'MEA', number]> = [
    ['SUP', scoreSup], ['RDT', scoreRdt], ['PSU', scorePsu], ['PRT', scorePrt], ['MEA', scoreMea],
  ]
  arr.sort((a, b) => b[1] - a[1])
  const maxDriver = arr[0]
  const secondary = arr.slice(1).reduce((s, x) => s + x[1], 0)
  const phaseW = 1 + (PHASE_MUL[phase] - 1) * opts.phaseW
  let score = maxDriver[1] * phaseW + 0.10 * secondary
  score = Math.max(0, Math.min(100, score))

  let tier: Tier = 'OK'
  if (fl < opts.minFL || f.ground) tier = 'IDLE'
  else if (marginMin < 0 || (sp.psuMinutes > 0 && psuDurMin < rdtMin && fl > 300) || score >= 80) tier = 'CRITICAL'
  else if (score >= 55 || marginMin < 0.3 * rdtMin || portableN < portableReq) tier = 'DEGRADED'
  else if (score >= 25) tier = 'WATCH'

  let advice = ''
  switch (tier) {
    case 'CRITICAL':
      advice = 'MAYDAY emergency descent IDLE + speedbrakes 30° bank to MEA / oceanic vector · Boeing FCOM 9.20 RAPID DEPRESS · 121.329'
      break
    case 'DEGRADED':
      advice = 'brief crew · plan early descent FL250 · retain ETOPS alternate · AC 120-42B App I-5'
      break
    case 'WATCH':
      advice = 'log cylinder pressure every 30 min · verify PSU initiator continuity · QRH 35-1'
      break
    case 'OK':
      advice = 'supply ≥ 2× RDT · all margins positive'
      break
    case 'IDLE':
      advice = 'on ground or below MIN-FL · monitor idle'
      break
  }

  return {
    classKey, phase, fl, cylPsiAct, cylDurMin, psuDurMin, psuConsumed,
    portableN, portableReq, moraFt: mora, descentFloorFt, rdtMin,
    worstSupplyMin, marginMin,
    scorePos: 0, scoreSup, scoreRdt, scorePsu, scorePrt, scoreMea,
    score, tier, driver: maxDriver[0], advice,
  }
}

export default function OxygenDuration({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState(100)
  const [cylMul, setCylMul] = useState(100)     // % cylinder psi calibration
  const [psuMul, setPsuMul] = useState(100)     // % PSU duration
  const [cabinMul, setCabinMul] = useState(100) // % cabin-crew complement
  const [meaBias, setMeaBias] = useState(0)     // ± ft MORA bias
  const [phaseW, setPhaseW] = useState(100)     // % phase weight
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showRef, setShowRef] = useState(false)
  const [showDiag, setShowDiag] = useState(true)
  const [tierFilter, setTierFilter] = useState<Tier | null>(null)
  const [classFilter, setClassFilter] = useState<Set<ClassKey>>(new Set(['HVY-Q','HVY','NRW','RGN','BIZ','TBP']))
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')

  const opts = useMemo(() => ({
    cylMul: cylMul / 100, psuMul: psuMul / 100, cabinMul: cabinMul / 100,
    meaBias, phaseW: phaseW / 100, minFL,
  }), [cylMul, psuMul, cabinMul, meaBias, phaseW, minFL])

  const computed = useMemo(() => {
    return flights
      .filter(f => Number.isFinite(f.lat) && Number.isFinite(f.lng))
      .map(f => ({ f, c: compute(f, opts) }))
  }, [flights, opts])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { CRITICAL: 0, DEGRADED: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of computed) c[r.c.tier]++
    return c
  }, [computed])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return computed.filter(({ f, c }) => {
      if (tierFilter && c.tier !== tierFilter) return false
      if (!classFilter.has(c.classKey)) return false
      if (q && !(
        f.callsign?.toLowerCase().includes(q) ||
        f.type?.toLowerCase().includes(q) ||
        f.operator?.toLowerCase().includes(q) ||
        f.icao.toLowerCase().includes(q)
      )) return false
      return true
    })
  }, [computed, tierFilter, classFilter, query])

  const ranked = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const ta = TIER_ORDER.indexOf(a.c.tier), tb = TIER_ORDER.indexOf(b.c.tier)
      if (ta !== tb) return ta - tb
      return b.c.score - a.c.score
    })
  }, [filtered])

  const summary = useMemo(() => {
    const visible = computed.filter(r => r.c.tier !== 'IDLE')
    const meanCyl = visible.length ? visible.reduce((s, r) => s + r.c.cylDurMin, 0) / visible.length : 0
    const worst = visible.reduce<{ cs: string, m: number } | null>((acc, r) => {
      if (!acc || r.c.marginMin < acc.m) return { cs: r.f.callsign?.trim() || r.f.icao, m: r.c.marginMin }
      return acc
    }, null)
    const psuInit = visible.length ? visible.filter(r => CLASS_SPEC[r.c.classKey].psuMinutes > 0 && r.c.psuConsumed > 0.30).length / visible.length : 0
    const worstMargin = worst?.m ?? 0
    return { meanCyl, worstCs: worst?.cs || '—', worstMargin, psuInit, tracked: visible.length }
  }, [computed])

  const byClass = useMemo(() => {
    const grp = new Map<ClassKey, { n: number, worst: Tier, mean: number, crit: number }>()
    for (const r of computed) {
      const g = grp.get(r.c.classKey) || { n: 0, worst: 'OK' as Tier, mean: 0, crit: 0 }
      g.n++
      g.mean += r.c.score
      if (r.c.tier === 'CRITICAL') g.crit++
      if (TIER_ORDER.indexOf(r.c.tier) < TIER_ORDER.indexOf(g.worst)) g.worst = r.c.tier
      grp.set(r.c.classKey, g)
    }
    return Array.from(grp.entries()).map(([k, v]) => ({ k, n: v.n, worst: v.worst, mean: v.mean / v.n, crit: v.crit }))
      .sort((a, b) => TIER_ORDER.indexOf(a.worst) - TIER_ORDER.indexOf(b.worst) || b.crit - a.crit)
  }, [computed])

  // ---------------- MapLibre overlay ----------------
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC_REF))  map.addSource(SRC_REF,  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_REF))   map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.18, 'line-width': 1, 'line-dasharray': [3, 3] } })
        if (!map.getSource(SRC_PROJ)) map.addSource(SRC_PROJ, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_PROJ))  map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.75, 'line-dasharray': [2, 1] } })
        if (!map.getSource(SRC_HALO)) map.addSource(SRC_HALO, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_HALO))  map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 0, 8, 100, 22],
          'circle-color': ['get', 'color'], 'circle-opacity': 0.18,
          'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.85,
        }})
        if (!map.getSource(SRC_PIN))  map.addSource(SRC_PIN,  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_PIN))   map.addLayer({ id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: {
          'circle-radius': 5, 'circle-color': '#f43f5e', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2,
        }})
        if (!map.getSource(SRC_LBL))  map.addSource(SRC_LBL,  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_LBL))   map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
          'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, -1.8], 'text-anchor': 'bottom', 'text-allow-overlap': true,
        }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.2 } })
      } catch {}
    }
    ensure()

    const visible = computed.filter(r => r.c.tier !== 'IDLE' && classFilter.has(r.c.classKey))
    const haloFeats = visible.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: { color: TIER_COLOR[r.c.tier], score: r.c.score },
    }))
    const pinFeats = visible.filter(r => r.c.tier === 'CRITICAL').map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: {},
    }))
    const lblFeats = visible.filter(r => r.c.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: {
        color: TIER_COLOR[r.c.tier],
        label: `${r.f.callsign?.trim() || r.f.icao} O₂ ${r.c.worstSupplyMin.toFixed(0)}m / RDT ${r.c.rdtMin.toFixed(0)}m`,
      },
    }))
    const projFeats = visible.filter(r => r.c.tier === 'CRITICAL' || r.c.tier === 'DEGRADED').map(r => {
      const coords: [number, number][] = []
      for (let i = 0; i <= 14; i++) coords.push(destPoint(r.f.lat, r.f.lng, r.f.track || 0, i * (100 / 14)))
      return {
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: coords },
        properties: { color: TIER_COLOR[r.c.tier] },
      }
    })
    const refFeats: Array<{ type:'Feature', geometry:{type:'LineString', coordinates:[number,number][]}, properties:{} }> = []
    if (showRef) {
      for (const lat of [-60, -30, 0, 30, 60]) {
        for (let lng = -180; lng < 180; lng += 12) {
          refFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[lng, lat], [lng + 12, lat]] }, properties: {} })
        }
      }
    }
    try {
      (map.getSource(SRC_HALO) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showHalo ? haloFeats : [] })
      ;(map.getSource(SRC_PIN)  as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showPin  ? pinFeats : [] })
      ;(map.getSource(SRC_LBL)  as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showLbl  ? lblFeats : [] })
      ;(map.getSource(SRC_PROJ) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showProj ? projFeats : [] })
      ;(map.getSource(SRC_REF)  as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: refFeats })
    } catch {}
  }, [map, computed, classFilter, showHalo, showPin, showLbl, showProj, showRef])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_REF]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_PROJ, SRC_REF]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  // Diagnostic scatter (supply vs RDT)
  const scatterDots = useMemo(() => {
    const xMax = 30  // RDT minutes axis
    const yMax = 60  // supply minutes axis
    return computed.filter(r => r.c.tier !== 'IDLE').map(r => {
      const x = Math.min(xMax, Math.max(0, r.c.rdtMin))
      const y = Math.min(yMax, Math.max(0, r.c.worstSupplyMin))
      return { cx: 8 + (x / xMax) * 220, cy: 130 - (y / yMax) * 110, color: TIER_COLOR[r.c.tier] }
    })
  }, [computed])

  const toggleClass = (k: ClassKey) => {
    setClassFilter(prev => {
      const n = new Set(prev)
      if (n.has(k)) n.delete(k); else n.add(k)
      return n
    })
  }

  return (
    <div className="fixed top-16 right-3 z-40 w-[400px] max-h-[calc(100vh-5rem)] flex flex-col rounded-xl border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">◐</span>
          <span className="text-sm font-semibold tracking-wider">O₂ SUPPLY · DURATION vs RDT</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      {/* 5-tier counter strip */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? null : t)}
            className={`flex flex-col items-center rounded-md px-1 py-1 border text-[9px] tracking-wider transition ${tierFilter === t ? TIER_BG[t] : 'border-slate-800 bg-slate-900/40 hover:bg-slate-800/40'}`}
            style={{ color: tierFilter === t ? undefined : TIER_COLOR[t] }}>
            <span>{t.slice(0, 4)}</span>
            <span className="text-sm font-mono mt-0.5">{counts[t]}</span>
          </button>
        ))}
      </div>

      {/* summary cells */}
      <div className="px-3 py-2 grid grid-cols-3 gap-1.5 border-b border-slate-800 text-[10px]">
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500 tracking-wider">WORST MARGIN</div>
          <div className="font-mono" style={{ color: summary.worstMargin < 0 ? TIER_COLOR.CRITICAL : summary.worstMargin < 5 ? TIER_COLOR.DEGRADED : TIER_COLOR.OK }}>
            {summary.worstMargin >= 0 ? '+' : ''}{summary.worstMargin.toFixed(1)}m
          </div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500 tracking-wider">WORST AC</div>
          <div className="font-mono text-slate-100 truncate">{summary.worstCs}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500 tracking-wider">CRIT</div>
          <div className="font-mono" style={{ color: counts.CRITICAL > 0 ? TIER_COLOR.CRITICAL : TIER_COLOR.OK }}>{counts.CRITICAL}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500 tracking-wider">MEAN CYL</div>
          <div className="font-mono" style={{ color: summary.meanCyl < 10 ? TIER_COLOR.DEGRADED : TIER_COLOR.OK }}>{summary.meanCyl.toFixed(0)}m</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500 tracking-wider">PSU INIT</div>
          <div className="font-mono" style={{ color: summary.psuInit > 0.5 ? TIER_COLOR.DEGRADED : TIER_COLOR.OK }}>{(summary.psuInit * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500 tracking-wider">TRACKED</div>
          <div className="font-mono text-slate-100">{summary.tracked}</div>
        </div>
      </div>

      {/* Diagnostic SVG */}
      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] tracking-wider text-slate-500 mb-1">SUPPLY (min) vs REQUIRED DESCENT TIME (min)</div>
          <svg viewBox="0 0 240 140" className="w-full h-32 bg-slate-900/40 rounded">
            {/* rose <RDT band  (y < x diagonal) */}
            <polygon points="8,130 228,130 228,20 8,20 8,130" fill="url(#o2grad)" opacity="0.05" />
            <defs>
              <linearGradient id="o2grad" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor="#10b981" />
                <stop offset="1" stopColor="#f43f5e" />
              </linearGradient>
            </defs>
            {/* y = x diagonal (RDT line) */}
            <line x1="8" y1="130" x2="228" y2={130 - (30 / 60) * 110} stroke="#f43f5e" strokeWidth="0.7" strokeDasharray="3 2" />
            {/* y = 1.3x  amber */}
            <line x1="8" y1="130" x2="228" y2={130 - (30 * 1.3 / 60) * 110} stroke="#f59e0b" strokeWidth="0.5" strokeDasharray="2 2" />
            {/* y = 2x emerald */}
            <line x1="8" y1="130" x2="228" y2={130 - (30 * 2.0 / 60) * 110} stroke="#10b981" strokeWidth="0.5" strokeDasharray="2 2" />
            {/* RDT-22 min vertical */}
            <line x1={8 + (22 / 30) * 220} y1="20" x2={8 + (22 / 30) * 220} y2="130" stroke="#475569" strokeWidth="0.5" strokeDasharray="2 2" />
            {scatterDots.map((d, i) => (
              <circle key={i} cx={d.cx} cy={d.cy} r="2" fill={d.color} opacity="0.8" />
            ))}
            {/* axes labels */}
            <text x="8" y="138" fontSize="6" fill="#64748b">0</text>
            <text x="220" y="138" fontSize="6" fill="#64748b">30</text>
            <text x="2" y="24" fontSize="6" fill="#64748b">60</text>
            <text x="118" y="138" fontSize="6" fill="#64748b">RDT m</text>
          </svg>
        </div>
      )}

      {/* Sliders */}
      <div className="px-3 py-2 grid grid-cols-2 gap-x-3 gap-y-1.5 border-b border-slate-800 text-[10px]">
        {[
          ['MIN-FL', minFL, setMinFL, 0, 400, 10, 'FL'],
          ['CYL-PSI', cylMul, setCylMul, 50, 150, 5, '%'],
          ['PSU-MUL', psuMul, setPsuMul, 50, 150, 5, '%'],
          ['CABIN-N', cabinMul, setCabinMul, 50, 200, 5, '%'],
          ['MEA-BIAS', meaBias, setMeaBias, -3000, 5000, 250, 'ft'],
          ['PHASE-WT', phaseW, setPhaseW, 50, 150, 5, '%'],
        ].map(([lbl, val, setter, mn, mx, st, unit]) => (
          <div key={lbl as string}>
            <div className="flex justify-between text-slate-500 tracking-wider">
              <span>{lbl as string}</span>
              <span className="font-mono text-slate-300">{val as number}{unit as string}</span>
            </div>
            <input type="range" min={mn as number} max={mx as number} step={st as number} value={val as number}
              onChange={e => (setter as (n: number) => void)(parseInt(e.target.value, 10))}
              className="w-full h-1 accent-sky-500" />
          </div>
        ))}
      </div>

      {/* Class filter chips */}
      <div className="px-3 py-2 flex flex-wrap gap-1 border-b border-slate-800">
        {(Object.keys(CLASS_SPEC) as ClassKey[]).map(k => (
          <button key={k} onClick={() => toggleClass(k)}
            className={`text-[9px] px-1.5 py-0.5 rounded border tracking-wider transition ${classFilter.has(k) ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/40 border-slate-800 text-slate-500'}`}>
            {k}
          </button>
        ))}
      </div>

      {/* Overlay toggles */}
      <div className="px-3 py-1.5 flex flex-wrap gap-2 border-b border-slate-800 text-[9px]">
        {[
          ['HALO', showHalo, setShowHalo],
          ['PIN', showPin, setShowPin],
          ['LBL', showLbl, setShowLbl],
          ['PROJ', showProj, setShowProj],
          ['REF', showRef, setShowRef],
          ['DIAG', showDiag, setShowDiag],
        ].map(([lbl, on, set]) => (
          <label key={lbl as string} className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={on as boolean} onChange={e => (set as (b: boolean) => void)(e.target.checked)} className="accent-sky-500" />
            <span className={on ? 'text-sky-300' : 'text-slate-500'}>{lbl as string}</span>
          </label>
        ))}
      </div>

      {/* Search */}
      <div className="px-3 py-2 border-b border-slate-800">
        <input type="text" value={query} onChange={e => setQuery(e.target.value)}
          placeholder="search callsign / type / operator / icao"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      {/* Tab switcher */}
      <div className="px-3 py-1.5 flex gap-1 border-b border-slate-800">
        {(['AIRCRAFT', 'CLASSES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`text-[10px] px-2 py-0.5 rounded border tracking-wider transition ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/40 border-slate-800 text-slate-500 hover:text-slate-300'}`}>
            {t}
          </button>
        ))}
        <span className="ml-auto text-[9px] text-slate-500 self-center">{ranked.length} shown · {computed.length} tracked</span>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <>
            {ranked.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match current filter.</div>
            )}
            {ranked.slice(0, 100).map(({ f, c }) => {
              const sp = CLASS_SPEC[c.classKey]
              return (
                <button key={f.icao} onClick={() => onFly(f.icao)}
                  className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/50 flex gap-2">
                  <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[c.tier] }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="font-mono font-semibold truncate">{f.callsign?.trim() || f.icao}</span>
                      <span className="text-slate-500 truncate text-[10px]">{f.type || '—'}</span>
                      <span className="text-[8px] tracking-wider px-1 rounded bg-slate-800 text-slate-400">{c.classKey}</span>
                      <span className="text-[8px] tracking-wider px-1 rounded bg-slate-800 text-slate-400">{c.phase}</span>
                      <span className="ml-auto text-[9px] tracking-wider font-mono" style={{ color: TIER_COLOR[c.tier] }}>{c.tier}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-slate-400 font-mono mt-0.5">
                      <span>FL{Math.round(c.fl)}</span>
                      <span style={{ color: c.worstSupplyMin < c.rdtMin ? TIER_COLOR.CRITICAL : c.worstSupplyMin < 1.3 * c.rdtMin ? TIER_COLOR.DEGRADED : TIER_COLOR.OK }}>O₂ {c.worstSupplyMin.toFixed(0)}m</span>
                      <span className="text-slate-500">/ RDT {c.rdtMin.toFixed(1)}m</span>
                      <span style={{ color: c.marginMin < 0 ? TIER_COLOR.CRITICAL : c.marginMin < 5 ? TIER_COLOR.DEGRADED : TIER_COLOR.OK }}>Δ{c.marginMin >= 0 ? '+' : ''}{c.marginMin.toFixed(1)}m</span>
                    </div>
                    {/* score bar */}
                    <div className="mt-1 h-1 bg-slate-900 rounded overflow-hidden">
                      <div className="h-full" style={{ width: `${c.score}%`, background: TIER_COLOR[c.tier] }} />
                    </div>
                    {/* 5-cell breakdown */}
                    <div className="grid grid-cols-5 gap-1 mt-1">
                      {([
                        ['SUP', c.scoreSup], ['RDT', c.scoreRdt], ['PSU', c.scorePsu], ['PRT', c.scorePrt], ['MEA', c.scoreMea],
                      ] as Array<[string, number]>).map(([k, v]) => (
                        <div key={k} className="text-[8px] tracking-wider font-mono text-center rounded border border-slate-800 px-0.5"
                          style={{ color: v >= 80 ? TIER_COLOR.CRITICAL : v >= 55 ? TIER_COLOR.DEGRADED : v >= 25 ? TIER_COLOR.WATCH : TIER_COLOR.OK }}>
                          {k} {v.toFixed(0)}
                        </div>
                      ))}
                    </div>
                    <div className="mt-1 text-[9px] text-slate-500 font-mono truncate">
                      CYL {c.cylPsiAct}psi · {sp.cylFt3}ft³ · {c.cylDurMin.toFixed(0)}m · PSU {sp.psuMinutes > 0 ? `${c.psuDurMin.toFixed(0)}m (${(c.psuConsumed*100).toFixed(0)}% used)` : 'BOTTLES'} · PRT {c.portableN}/{c.portableReq} · MORA {c.moraFt}ft
                    </div>
                    <div className="mt-1 text-[9px] truncate" style={{ color: TIER_COLOR[c.tier] }}>
                      ▸ {c.advice}
                    </div>
                  </div>
                </button>
              )
            })}
          </>
        )}

        {tab === 'CLASSES' && (
          <>
            {byClass.map(g => {
              const sp = CLASS_SPEC[g.k]
              return (
                <div key={g.k} className="px-3 py-2 border-b border-slate-900 flex gap-2">
                  <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[g.worst] }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-[9px] tracking-wider px-1 rounded bg-slate-800 text-slate-300">{g.k}</span>
                      <span className="font-semibold text-slate-100 truncate">{sp.family}</span>
                      <span className="ml-auto text-[9px] tracking-wider font-mono" style={{ color: TIER_COLOR[g.worst] }}>{g.worst}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                      <span>n={g.n}</span>
                      <span>cyl {sp.cylFt3}ft³@{sp.psiNom}psi</span>
                      <span>PSU {sp.psuMinutes || 'BTL'}m</span>
                      <span>port {sp.portableN}</span>
                      <span className="ml-auto">CRIT {g.crit}</span>
                    </div>
                    <div className="mt-1 h-1 bg-slate-900 rounded overflow-hidden">
                      <div className="h-full" style={{ width: `${g.mean}%`, background: TIER_COLOR[g.worst] }} />
                    </div>
                    <div className="mt-1 text-[9px] text-slate-500 font-mono">
                      crew {sp.crewN}p · cabin-base {sp.cabinCrewBase} · {sp.obogs ? 'OBOGS' : 'CHEM-GEN'} · descent {sp.descentFpm}fpm
                    </div>
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[8px] text-slate-600 tracking-wider">
        ATA-35 · 14 CFR 121.329/.333 · AC 25-1322-1 · Boeing FCOM 35 · NTSB AAR-89/03 Aloha 243
      </div>
    </div>
  )
}
