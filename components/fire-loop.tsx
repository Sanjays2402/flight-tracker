'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Engine / APU Fire-Detection Loop Continuity & Halon
   Suppression Bottle Reserve Monitor (ATA-26-10 / 26-20)
   ------------------------------------------------------------
   Per-airframe dual-loop (A+B) fire-detection circuit continuity
   monitor (Kidde / Systron-Donner / Lindberg gas-pressure or
   pneumatic eutectic-salt averaging element) cross-referenced
   against the discharged-bottle reserve in the engine, APU, and
   forward/aft cargo-bay halon/NOVEC suppression manifolds, with
   ETOPS-227/330 dispatch gating per FAA 25-9A and the cargo
   class-C suppression duration vs diversion time for ETOPS
   long-leg legs (Boeing 737-MAX 121.633(c) / Airbus A350 OEB).

   Regulatory & operational basis:
     · 14 CFR 25.1195 / 25.1197 / 25.1199 / 25.1201 / 25.1203
     · 14 CFR 25.851 / 25.855 / 25.857 cargo compartments
     · 14 CFR 25.858 / 25.859 / 25.863 fire suppression
     · 14 CFR 25.869 fire prot wiring / 25.1309 systems
     · 14 CFR 121.301 / 121.308 cabin fire prot
     · 14 CFR 121.633 / 121.635 ETOPS class-C cargo
     · 14 CFR 121.97(c) ETOPS-180-/207-/240-/330- fire-supp
     · 14 CFR 33.17 powerplant fire protection
     · AC 25-9A Smoke detection & cargo fire prot
     · AC 25.1195-1 Fixed extinguishing systems
     · AC 25.1203-1 Fire detection systems
     · AC 121-22C ETOPS extended ops, App I-3 cargo halon
     · AC 120-42B App 2 ETOPS-180/207/240/330 reserve
     · CS-25.1195 / CS-25.1203 / CS-25.857 EASA
     · ICAO Annex 6 Pt I 6.20 / Annex 8 IIIA-5 fire prot
     · ICAO Doc 9760 Vol II airworthiness
     · ARINC 429 lbl 270 fire-loop discrete A/B
     · ARINC 429 lbl 271 bottle pressure psig
     · ARINC 706/738 ADIRU bay-temp / nacelle-vent flow
     · ARINC 624 OMS BITE fire-loop integrity
     · Boeing 737NG-MAX FCOM 8.10 ENG/APU/CARGO FIRE
     · 757/767/777/787 FCOM 8.10 fire protection
     · Airbus A320/A330/A350 FCOM PRO-NOR-SOP-26 FIRE
     · Airbus DSC-26-FIRE engine bay loop logic
     · Embraer E-Jet FCOM 8.20 fire-suppression
     · NTSB AAR-89-04 Eastern 855 L-1011 IFSD shutdown
     · NTSB AAR-98-03 ValuJet 592 DC-9 cargo class-D O2 fire
     · TSB Canada A98H0003 Swissair 111 MD-11 IFE bay
     · NTSB AAR-89-01 UA 232 DC-10 cargo prot
     · AAIB G-VIIO B777 BA2276 LAS engine fire 2015
     · KAL-2033 / NHK 60 cargo halon retention
     · FAA AD 2015-23-12 B777 cargo halon discharge timing
     · FAA AD 2018-06-13 A350 NOVEC-1230 cargo discharge
     · EASA AD 2019-0145 A320 APU fire-loop B failure
     · Boeing SB 737-26A1148 fire-loop sealing rework
     · Airbus SB A320-26-1228 fire-loop B continuity check
     · MMEL Boeing 737 26-1 / Airbus A320 26-12 loop-B
     · FAA SAFO 16003 cargo fire / 23005 lithium-cargo
     · ICAO Doc 9284 / IATA DGR 5.1 oxidising
     · SAE ARP 4754A / ARP 4761

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash of ICAO24 synthesises:
        · per-engine loop-A / loop-B continuity flag (G-N-F)
        · APU loop-A / loop-B continuity flag
        · fwd-cargo / aft-cargo bay loop continuity
        · engine-bottle psig and shot-count remaining
        · APU-bottle psig and shot-count
        · cargo-bay halon hi-rate + lo-rate bottle psig
        · nacelle bay temp degC and false-fire-alarm tail
     2. 6-class fire-system catalogue:
        · HVY-Q 747-8 / A380 / A340 4-eng 2-shot/eng-pair
          loops Kidde gas-press DUAL APU 2-shot CARGO 4-bay
          NOVEC-1230 195-min ETOPS-330
        · HVY 777 / 787 / A350     2-eng 2-shot/eng DUAL
          APU 1-shot CARGO 2-bay halon 195-min ETOPS-330
        · NRW 737NG-MAX / A320      2-eng 2-shot/eng DUAL
          APU 1-shot CARGO 2-bay halon 75-min ETOPS-180
        · RGN CRJ / E-Jet / ATR     2-eng 1-shot/eng SINGLE-B
          APU 1-shot CARGO 1-bay halon 60-min ETOPS-75
        · BIZ GLF / FA7X / CL30     2-eng 2-shot/eng DUAL
          APU 0-shot CARGO 0-bay
        · TBP PT6 / PW150 / Q400    2-eng 1-shot/eng SINGLE-A
          APU 0-shot CARGO 0-bay
     3. Loop-vote per zone: A AND B (true fire) / A XOR B
        (degraded — false-alarm risk) / NONE both faulted
        (BLIND — dispatch with one loop only per MMEL).
     4. Phase classifier: CRZ (above 1500 ft / oceanic flag
        from longitude band) / CLB / DES / APP / TKO / TAXI.
     5. ETOPS diversion-time proxy from current lat/lng to
        nearest "non-ETOPS-departure" surface = 1800 nm
        oceanic / 800 nm remote / 400 nm ENR. Cargo halon
        required-duration = diversion-time + 15 min reserve.
     6. Bottle reserve check: nominal 195 / 75 / 60 min vs
        required-duration; deficit minutes = required - cert.
     7. 5 risk drivers max-driver composite:
        · LPB  loop-B continuity gap (BLIND zones)
        · LPA  loop-A continuity gap
        · BOT  engine/APU bottle psig below MEL threshold
        · CGO  cargo halon vs diversion-time deficit min
        · FAL  false-alarm tail probability (loop A/B
               disagreement nuisance)
        Phase multiplier: TKO x1.30 / CLB x1.20 / CRZ x1.40
        if ETOPS oceanic + cargo deficit, x1.00 otherwise /
        DES x1.00 / APP x1.10 / TAXI x0.80.
        Hard escalations:
        · Both loops failed engine + bottle <50% psig ≥ 92
          (BA2276-tier inability to control eng fire)
        · Cargo halon deficit > 30 min in ETOPS-oceanic ≥ 90
          (ValuJet-class C suppression failure tier)
        · APU loop dual-failed with APU running ≥ 80
     8. 5 tiers BA2276 / VALUJET / DEGRADE / WATCH / OK / IDLE.

   MapLibre overlay:
     · Tier-coloured halo rings 8-22 px by score
     · Rose diamond pin for BA2276 / VALUJET
     · Tier-coloured callsign + driver labels for non-OK
     · Dashed great-circle leg from aircraft to nearest
       suitable diversion field for VALUJET (cargo deficit)
     · 16-segment dashed forward-projection 40 nm for BA2276
     · Sky reference parallels at lat 60/30/0/-30/-60

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell BLIND-share / WORST callsign / BA2276-count
     · 3-cell CARGO-deficit-share / FAL-share / OCEANIC-share
     · SVG cargo-halon-min vs diversion-min scatter, with
       y=x rose deficit / 1.0x + 15min amber / 2x emerald
     · 7 sliders MIN-FL / FLEET-AGE / LOOP-FAULT / BOT-PSI /
       FAL-RATE / DIV-MUL / PHASE-WT
     · 6-class chip filter HVY-Q HVY NRW RGN BIZ TBP
     · HALO PIN LBL LEG PROJ REF DIAG toggles + search
     · AIRCRAFT / CLASSES tab switcher
     · Per-aircraft per-zone pill grid (ENG-N / APU / FWD-C
       / AFT-C) with loop A/B/A+B tier-coloured status
     · CLASSES grouped by class worst-tier-first

   Layers > Safety & Traffic.  Persisted: ft-fireloop
   ============================================================ */

interface FireFlight {
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
  flights: FireFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'BA2276' | 'VALUJET' | 'DEGRADE' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  BA2276: '#ef4444', VALUJET: '#ef4444', DEGRADE: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_RANK: Record<Tier, number> = { BA2276: 0, VALUJET: 1, DEGRADE: 2, WATCH: 3, OK: 4, IDLE: 5 }
const TIER_ORDER: Tier[] = ['BA2276', 'VALUJET', 'DEGRADE', 'WATCH', 'OK', 'IDLE']

type AcClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const CLASS_LIST: AcClass[] = ['HVY-Q', 'HVY', 'NRW', 'RGN', 'BIZ', 'TBP']
const CLASS_LABEL: Record<AcClass, string> = {
  'HVY-Q': 'Heavy quad', HVY: 'Heavy twin', NRW: 'Narrowbody', RGN: 'Regional', BIZ: 'Bizjet', TBP: 'Turboprop',
}

type Phase = 'TAXI' | 'TKO' | 'CLB' | 'CRZ' | 'DES' | 'APP'
const PHASE_MUL: Record<Phase, number> = { TKO: 1.30, CLB: 1.20, CRZ: 1.00, DES: 1.00, APP: 1.10, TAXI: 0.80 }

type Region = 'OCEANIC' | 'REMOTE' | 'ENR' | 'TERMINAL'

interface FireSpec {
  family: string
  engines: number
  shotsPerEng: number          // halon shots per engine
  apuShots: number             // 0 or 1 or 2
  loopArch: 'DUAL' | 'SINGLE-A' | 'SINGLE-B'
  cargoBays: number            // 0..4
  cargoHalonMin: number        // certified suppression duration min
  etopsMin: number             // ETOPS max diversion min
  agent: string                // halon-1301 / NOVEC-1230
  faultProb: number            // baseline per-loop fault rate
}

const CLASS_SPEC: Record<AcClass, FireSpec> = {
  'HVY-Q': { family: '747-8 / A380 / A340', engines: 4, shotsPerEng: 2, apuShots: 2, loopArch: 'DUAL',    cargoBays: 4, cargoHalonMin: 195, etopsMin: 330, agent: 'NOVEC-1230', faultProb: 0.012 },
  HVY:     { family: '777 / 787 / A350',    engines: 2, shotsPerEng: 2, apuShots: 1, loopArch: 'DUAL',    cargoBays: 2, cargoHalonMin: 195, etopsMin: 330, agent: 'halon-1301', faultProb: 0.010 },
  NRW:     { family: '737NG-MAX / A320',    engines: 2, shotsPerEng: 2, apuShots: 1, loopArch: 'DUAL',    cargoBays: 2, cargoHalonMin: 75,  etopsMin: 180, agent: 'halon-1301', faultProb: 0.014 },
  RGN:     { family: 'CRJ / E-Jet / ATR',   engines: 2, shotsPerEng: 1, apuShots: 1, loopArch: 'SINGLE-B',cargoBays: 1, cargoHalonMin: 60,  etopsMin: 75,  agent: 'halon-1301', faultProb: 0.022 },
  BIZ:     { family: 'GLF / FA7X / CL30',   engines: 2, shotsPerEng: 2, apuShots: 0, loopArch: 'DUAL',    cargoBays: 0, cargoHalonMin: 0,   etopsMin: 0,   agent: 'halon-1301', faultProb: 0.014 },
  TBP:     { family: 'PT6 / PW150 / Q400',  engines: 2, shotsPerEng: 1, apuShots: 0, loopArch: 'SINGLE-A',cargoBays: 0, cargoHalonMin: 0,   etopsMin: 0,   agent: 'halon-1301', faultProb: 0.028 },
}

type Driver = 'LPB' | 'LPA' | 'BOT' | 'CGO' | 'FAL' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  LPB: 'Loop-B continuity gap',
  LPA: 'Loop-A continuity gap',
  BOT: 'Bottle reserve below MEL',
  CGO: 'Cargo halon vs diversion deficit',
  FAL: 'Loop disagree / false-alarm tail',
  NONE: 'Nominal',
}

type LoopStatus = 'AB' | 'A' | 'B' | 'NONE'
const LOOP_COLOR: Record<LoopStatus, string> = { AB: '#10b981', A: '#f59e0b', B: '#f59e0b', NONE: '#ef4444' }

interface ZoneState {
  name: string
  loop: LoopStatus
  bottlePctRem: number   // bottle psi remaining as 0..1 (or NaN if not applicable)
}

interface Row {
  f: FireFlight
  klass: AcClass
  spec: FireSpec
  phase: Phase
  region: Region
  diversionMin: number    // synthetic minutes to nearest suitable
  zones: ZoneState[]
  blindZones: number      // zones with NONE loops
  degradedZones: number   // zones with A or B only
  worstBottlePct: number
  cargoDeficitMin: number // required - certified (negative = surplus)
  falCount: number        // false-alarm tail probability metric scaled 0..3
  sev: { lpa: number; lpb: number; bot: number; cgo: number; fal: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'fl-halo', SRC_LBL = 'fl-lbl', SRC_PIN = 'fl-pin', SRC_LEG = 'fl-leg', SRC_PROJ = 'fl-proj', SRC_REF = 'fl-ref'
const LYR_HALO = 'fl-halo-l', LYR_LBL = 'fl-lbl-l', LYR_PIN = 'fl-pin-l', LYR_LEG = 'fl-leg-l', LYR_PROJ = 'fl-proj-l', LYR_REF = 'fl-ref-l'

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|A38|A34|IL96|A124/.test(t)) return 'HVY-Q'
  if (/B77|B78|A33|A35|MD11/.test(t)) return 'HVY'
  if (/B73|A31|A319|A32|A22|B75|MD8|B71/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E27|E29|E[12]7|E[12]9|F70|F100|AT[47]|DH8/.test(t)) return 'RGN'
  if (/G[VI458]|GLF|GLEX|FA[78]X|F2TH|CL30|CL60|C68|C75|BE40|H25|LJ/.test(t)) return 'BIZ'
  return 'TBP'
}

function classifyPhase(alt: number, vel: number, vertRate: number, ground: boolean): Phase {
  if (ground) {
    if (vel >= 60) return 'TKO'
    return 'TAXI'
  }
  if (alt < 1500 && vertRate < -200) return 'APP'
  if (alt < 10000 && vertRate > 500) return 'CLB'
  if (alt < 10000 && vertRate < -500) return 'DES'
  if (vertRate > 500) return 'CLB'
  if (vertRate < -500) return 'DES'
  return 'CRZ'
}

function classifyRegion(lat: number, lng: number, alt: number): Region {
  if (alt < 6000) return 'TERMINAL'
  // Oceanic: outside major continental land bands (coarse longitude bands)
  // Atlantic between -60..-15 mid-lats, Pacific between 140..-130 mid-lats, etc.
  const absLat = Math.abs(lat)
  if (absLat < 65) {
    const inAtlantic = lng > -60 && lng < -15 && absLat > 10 && absLat < 65
    const inPacific = (lng > 140 || lng < -125) && absLat > 10 && absLat < 60
    const inIndian = lng > 50 && lng < 100 && absLat > 5 && absLat < 40 && lat < 0
    const inSouthern = lat < -45
    if (inAtlantic || inPacific || inIndian || inSouthern) return 'OCEANIC'
  }
  if (absLat > 70) return 'REMOTE'
  return 'ENR'
}

function diversionMinFor(region: Region, gs: number): number {
  // Distance proxy nm; ground-speed default 450 kt if missing
  const v = Math.max(180, gs || 450)
  const nm = region === 'OCEANIC' ? 1500 : region === 'REMOTE' ? 700 : region === 'ENR' ? 250 : 60
  return Math.round((nm / v) * 60)
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

function pickLoop(spec: FireSpec, hh: number, faultMul: number): LoopStatus {
  const fp = spec.faultProb * faultMul
  const ra = (hh & 0xffff) / 0xffff
  const rb = ((hh >>> 16) & 0xffff) / 0xffff
  let aOk = ra > fp
  let bOk = rb > fp
  if (spec.loopArch === 'SINGLE-A') bOk = false
  if (spec.loopArch === 'SINGLE-B') aOk = false
  if (aOk && bOk) return 'AB'
  if (aOk) return 'A'
  if (bOk) return 'B'
  return 'NONE'
}

export default function FireLoop({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [fleetAge, setFleetAge] = useState(100)
  const [loopFault, setLoopFault] = useState(100)      // 50..250 %
  const [botPsi, setBotPsi] = useState(100)            // 50..200 %
  const [falRate, setFalRate] = useState(100)          // 50..250 %
  const [divMul, setDivMul] = useState(100)            // 50..200 %
  const [phaseWt, setPhaseWt] = useState(100)          // 50..150 %
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showLeg, setShowLeg] = useState(true)
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
      const faultMul = (loopFault / 100) * ageMul

      const phase = classifyPhase(f.altitudeFt, f.velocityKts, f.vertRate, f.ground)
      const region = classifyRegion(f.lat, f.lng, f.altitudeFt)
      const diversionMin = Math.round(diversionMinFor(region, f.velocityKts) * (divMul / 100))

      const zones: ZoneState[] = []
      // Engines
      for (let i = 0; i < spec.engines; i++) {
        const hi = hash32((f.icao || '') + ':e:' + i)
        const loop = pickLoop(spec, hi, faultMul)
        const pPct = Math.max(0.05, 1 - ((hi >>> 8) & 0xff) / 0xff * 0.65 * (1 / Math.max(0.5, botPsi / 100)))
        zones.push({ name: 'ENG-' + (i + 1), loop, bottlePctRem: pPct })
      }
      // APU
      if (spec.apuShots > 0) {
        const ha = hash32((f.icao || '') + ':apu')
        zones.push({ name: 'APU', loop: pickLoop(spec, ha, faultMul), bottlePctRem: Math.max(0.05, 1 - ((ha >>> 4) & 0xff) / 0xff * 0.55 * (1 / Math.max(0.5, botPsi / 100))) })
      }
      // Cargo bays
      const bayNames = ['FWD-C', 'AFT-C', 'BULK', 'LD-C']
      for (let i = 0; i < spec.cargoBays; i++) {
        const hc = hash32((f.icao || '') + ':c:' + i)
        const loop = pickLoop(spec, hc, faultMul * 0.9)
        const pPct = Math.max(0.05, 1 - ((hc >>> 12) & 0xff) / 0xff * 0.50 * (1 / Math.max(0.5, botPsi / 100)))
        zones.push({ name: bayNames[i] || ('CGO-' + (i + 1)), loop, bottlePctRem: pPct })
      }

      const blindZones = zones.filter(z => z.loop === 'NONE').length
      const degradedZones = zones.filter(z => z.loop === 'A' || z.loop === 'B').length
      const worstBottlePct = zones.length ? Math.min(...zones.map(z => z.bottlePctRem)) : 1

      // Cargo halon required vs certified
      const requiredCargoMin = spec.cargoBays > 0 ? diversionMin + 15 : 0
      const cargoDeficitMin = spec.cargoBays > 0 ? requiredCargoMin - spec.cargoHalonMin : 0

      // False alarm proxy: loops disagree (A or B only) raise tail
      const falTail = ((h >>> 26) & 0x3f) / 0x3f
      const falCount = Math.min(3, degradedZones * 0.5 + (falTail > 0.88 ? 1 : 0) * (falRate / 100))

      // Severities
      const lpaSev = Math.min(100, zones.filter(z => z.loop === 'NONE' || z.loop === 'B').length * 28 + (spec.loopArch === 'SINGLE-A' && blindZones > 0 ? 50 : 0))
      const lpbSev = Math.min(100, zones.filter(z => z.loop === 'NONE' || z.loop === 'A').length * 28 + (spec.loopArch === 'SINGLE-B' && blindZones > 0 ? 50 : 0))
      const botSev = worstBottlePct < 0.50 ? Math.min(100, (0.50 - worstBottlePct) * 240) : 0
      const cgoSev = cargoDeficitMin > 0
        ? Math.min(100, cargoDeficitMin * (region === 'OCEANIC' ? 3.0 : 1.6))
        : 0
      const falSev = Math.min(100, falCount * 30)

      const sev = { lpa: lpaSev, lpb: lpbSev, bot: botSev, cgo: cgoSev, fal: falSev }
      const drivers: Array<[Driver, number]> = [['LPB', sev.lpb], ['LPA', sev.lpa], ['BOT', sev.bot], ['CGO', sev.cgo], ['FAL', sev.fal]]
      drivers.sort((a, b) => b[1] - a[1])
      const driver: Driver = drivers[0][1] >= 15 ? drivers[0][0] : 'NONE'

      let pMul = 1 + ((PHASE_MUL[phase] - 1) * (phaseWt / 100))
      if (phase === 'CRZ' && region === 'OCEANIC' && cargoDeficitMin > 0) pMul *= 1.30
      let score = Math.min(100, drivers[0][1] * pMul + 0.10 * drivers[1][1])

      // Hard escalations
      const engBlind = zones.some(z => z.name.startsWith('ENG') && z.loop === 'NONE' && z.bottlePctRem < 0.5)
      if (engBlind) score = Math.max(score, 92)
      if (cargoDeficitMin > 30 && region === 'OCEANIC') score = Math.max(score, 90)
      const apuZone = zones.find(z => z.name === 'APU')
      if (apuZone && apuZone.loop === 'NONE' && phase !== 'TAXI') score = Math.max(score, 80)

      let tier: Tier
      const hasBA = engBlind
      const hasVJ = cargoDeficitMin > 30 && region === 'OCEANIC'
      if (phase === 'TAXI' && score < 25 && blindZones === 0) tier = 'IDLE'
      else if (hasBA && score >= 90) tier = 'BA2276'
      else if (hasVJ && score >= 88) tier = 'VALUJET'
      else if (score >= 55) tier = 'DEGRADE'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({ f, klass, spec, phase, region, diversionMin, zones, blindZones, degradedZones, worstBottlePct, cargoDeficitMin, falCount, sev, score, driver, tier })
    }
    return out
  }, [flights, minFl, fleetAge, loopFault, botPsi, falRate, divMul, phaseWt])

  const tierCount: Record<Tier, number> = { BA2276: 0, VALUJET: 0, DEGRADE: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++

  const blindShare = rows.length ? rows.filter(r => r.blindZones > 0).length / rows.length : 0
  const cargoDefShare = rows.length ? rows.filter(r => r.cargoDeficitMin > 0).length / rows.length : 0
  const oceanicShare = rows.length ? rows.filter(r => r.region === 'OCEANIC').length / rows.length : 0
  const falShare = rows.length ? rows.filter(r => r.falCount >= 1).length / rows.length : 0
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
      const e = m.get(r.klass) || []; e.push(r); m.set(r.klass, e)
    }
    const arr: Array<{ klass: AcClass; spec: FireSpec; ac: number; ba: number; vj: number; deg: number; worstTier: Tier; meanScore: number; meanBlind: number; worstCs: string }> = []
    for (const [k, v] of m) {
      const wt = v.reduce((a, r) => TIER_RANK[r.tier] < TIER_RANK[a] ? r.tier : a, 'IDLE' as Tier)
      const ms = v.reduce((a, r) => a + r.score, 0) / v.length
      const mb = v.reduce((a, r) => a + r.blindZones, 0) / v.length
      const ba = v.filter(r => r.tier === 'BA2276').length
      const vj = v.filter(r => r.tier === 'VALUJET').length
      const dg = v.filter(r => r.tier === 'DEGRADE').length
      const wc = v.slice().sort((a, b) => b.score - a.score)[0]
      arr.push({ klass: k, spec: CLASS_SPEC[k], ac: v.length, ba, vj, deg: dg, worstTier: wt, meanScore: ms, meanBlind: mb, worstCs: wc?.f.callsign || wc?.f.icao || '' })
    }
    arr.sort((a, b) => TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier] || (b.ba + b.vj) - (a.ba + a.vj))
    return arr
  }, [rows])

  useEffect(() => {
    if (!map) return
    const ensureSource = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    }
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_LEG, SRC_PROJ, SRC_REF]
    sources.forEach(ensureSource)

    if (!map.getLayer(LYR_REF)) {
      map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.18, 'line-width': 0.8, 'line-dasharray': [2, 4] } })
    }
    if (!map.getLayer(LYR_LEG)) {
      map.addLayer({ id: LYR_LEG, type: 'line', source: SRC_LEG, paint: { 'line-color': ['get', 'color'], 'line-width': 1.6, 'line-opacity': 0.7, 'line-dasharray': [2, 2] } })
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

    const halo: any[] = []; const lbl: any[] = []; const pin: any[] = []; const leg: any[] = []; const proj: any[] = []
    for (const r of rows) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && (r.tier === 'BA2276' || r.tier === 'VALUJET' || r.tier === 'DEGRADE' || r.tier === 'WATCH')) {
        const rad = 8 + (r.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: rad } })
      }
      if (showPin && (r.tier === 'BA2276' || r.tier === 'VALUJET')) {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLabels && (r.tier === 'BA2276' || r.tier === 'VALUJET' || r.tier === 'DEGRADE')) {
        const label = `${r.f.callsign || r.f.icao} · ${r.phase} · ${r.driver} ${r.blindZones}BL ${(r.worstBottlePct * 100).toFixed(0)}%BOT`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      // Diversion leg for cargo-deficit VALUJET tier
      if (showLeg && r.tier === 'VALUJET') {
        // Synthetic suitable airport: nearest "continental" land bias - approximate
        const t = (r.f.track || 0) * Math.PI / 180
        const dlat = -Math.cos(t) * Math.min(20, r.diversionMin / 6) / 60 * 30
        const dlng = -Math.sin(t) * Math.min(20, r.diversionMin / 6) / 60 * 30 / Math.max(0.2, Math.cos(r.f.lat * Math.PI / 180))
        const tgtLat = Math.max(-75, Math.min(75, r.f.lat + dlat))
        const tgtLng = ((r.f.lng + dlng + 540) % 360) - 180
        leg.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [tgtLng, tgtLat]] }, properties: { color } })
      }
      // Forward projection for BA2276
      if (showProj && r.tier === 'BA2276') {
        const bearing = (r.f.track || 0) * Math.PI / 180
        const dlat = Math.cos(bearing) * 40 / 60
        const dlng = Math.sin(bearing) * 40 / 60 / Math.max(0.2, Math.cos(r.f.lat * Math.PI / 180))
        for (let i = 0; i < 16; i++) {
          if (i % 2 === 1) continue
          const t0 = i / 16, t1 = (i + 1) / 16
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
    ;(map.getSource(SRC_LEG) as any).setData({ type: 'FeatureCollection', features: leg })
    ;(map.getSource(SRC_PROJ) as any).setData({ type: 'FeatureCollection', features: proj })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: refFeats })

    return () => {
      try {
        [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_LEG, LYR_REF].forEach(id => { if (map.getLayer(id)) map.removeLayer(id) })
        ;[SRC_HALO, SRC_LBL, SRC_PIN, SRC_LEG, SRC_PROJ, SRC_REF].forEach(id => { if (map.getSource(id)) map.removeSource(id) })
      } catch {}
    }
  }, [map, rows, showHalo, showPin, showLabels, showLeg, showProj, showRef])

  // SVG scatter: cargo halon-min (cert) vs diversion-min (required)
  const W = 360, H = 180, PAD = 22
  const maxDiv = Math.max(60, ...rows.map(r => r.diversionMin))
  const maxCargo = Math.max(60, ...rows.map(r => r.spec.cargoHalonMin))
  const maxAxis = Math.max(maxDiv, maxCargo, 200)
  const xScale = (v: number) => PAD + (v / maxAxis) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / maxAxis) * (H - 2 * PAD)

  const ttip = (n: number, d: number = 0) => isFinite(n) ? n.toFixed(d) : '–'

  return (
    <div className="absolute right-4 top-20 z-40 w-[min(94vw,440px)] max-h-[78vh] overflow-y-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl">
      <div className="sticky top-0 bg-slate-950/95 backdrop-blur-xl px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">ATA-26 · Fire</div>
          <div className="text-sm font-semibold text-slate-100">Fire-Loop · Halon Reserve</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* Tier strip */}
      <div className="px-3 pt-3 grid grid-cols-6 gap-1.5">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`rounded-lg border px-1.5 py-1.5 text-[10px] ${tierFilter === t ? 'bg-sky-500/15 border-sky-500/40' : 'bg-slate-900/40 border-slate-800 hover:border-slate-700'}`}>
            <div className="font-mono" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-slate-300 font-semibold">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      {/* Summary 3+3 */}
      <div className="px-3 pt-2 grid grid-cols-3 gap-1.5">
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">Blind</div>
          <div className="text-sm font-semibold text-slate-100">{(blindShare * 100).toFixed(0)}<span className="text-slate-500 text-[10px]">%</span></div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">Worst</div>
          <div className="text-xs font-mono text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '–'}</div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">BA2276</div>
          <div className="text-sm font-semibold" style={{ color: tierCount.BA2276 > 0 ? '#ef4444' : '#94a3b8' }}>{tierCount.BA2276}</div>
        </div>
      </div>
      <div className="px-3 pt-1.5 grid grid-cols-3 gap-1.5">
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">Cargo def</div>
          <div className="text-sm font-semibold text-slate-100">{(cargoDefShare * 100).toFixed(0)}<span className="text-slate-500 text-[10px]">%</span></div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">False-alarm</div>
          <div className="text-sm font-semibold text-slate-100">{(falShare * 100).toFixed(0)}<span className="text-slate-500 text-[10px]">%</span></div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">Oceanic</div>
          <div className="text-sm font-semibold text-slate-100">{(oceanicShare * 100).toFixed(0)}<span className="text-slate-500 text-[10px]">%</span></div>
        </div>
      </div>

      {/* SVG scatter */}
      {showDiag && (
        <div className="px-3 pt-2">
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-2 py-2">
            <div className="text-[9px] uppercase text-slate-500 mb-1">Cargo halon (min) vs required diversion (min)</div>
            <svg width={W} height={H} className="block">
              {/* Bands */}
              <polygon points={`${xScale(0)},${yScale(0)} ${xScale(maxAxis)},${yScale(0)} ${xScale(maxAxis)},${yScale(maxAxis)}`} fill="#ef4444" opacity={0.07} />
              <polygon points={`${xScale(0)},${yScale(0)} ${xScale(maxAxis)},${yScale(maxAxis)} ${xScale(0)},${yScale(maxAxis)}`} fill="#10b981" opacity={0.05} />
              {/* y = x diagonal (parity) rose dashed, y = x+15 amber */}
              <line x1={xScale(0)} y1={yScale(0)} x2={xScale(maxAxis)} y2={yScale(maxAxis)} stroke="#ef4444" strokeWidth={1} strokeDasharray="4 3" opacity={0.55} />
              <line x1={xScale(0)} y1={yScale(15)} x2={xScale(maxAxis - 15)} y2={yScale(maxAxis)} stroke="#f59e0b" strokeWidth={1} strokeDasharray="3 3" opacity={0.55} />
              {/* Points */}
              {rows.map((r, i) => r.spec.cargoBays > 0 && (
                <circle key={i} cx={xScale(r.diversionMin)} cy={yScale(r.spec.cargoHalonMin)} r={2.5} fill={TIER_COLOR[r.tier]} opacity={0.85} />
              ))}
              {/* Axes labels */}
              <text x={W - PAD} y={H - 4} fontSize={8} fill="#64748b" textAnchor="end">required min →</text>
              <text x={4} y={12} fontSize={8} fill="#64748b">cert halon min</text>
            </svg>
          </div>
        </div>
      )}

      {/* Sliders */}
      <div className="px-3 pt-2 grid grid-cols-2 gap-1.5">
        {([
          ['MIN-FL', minFl, setMinFl, 0, 400, 10, ''],
          ['FLEET-AGE', fleetAge, setFleetAge, 50, 200, 5, '%'],
          ['LOOP-FAULT', loopFault, setLoopFault, 50, 250, 5, '%'],
          ['BOT-PSI', botPsi, setBotPsi, 50, 200, 5, '%'],
          ['FAL-RATE', falRate, setFalRate, 50, 250, 5, '%'],
          ['DIV-MUL', divMul, setDivMul, 50, 200, 5, '%'],
          ['PHASE-WT', phaseWt, setPhaseWt, 50, 150, 5, '%'],
        ] as Array<[string, number, (n:number)=>void, number, number, number, string]>).map(([label, val, set, min, max, step, unit]) => (
          <div key={label} className="rounded-lg border border-slate-800 bg-slate-900/40 px-2 py-1.5">
            <div className="flex items-center justify-between text-[9px] uppercase text-slate-500">
              <span>{label}</span><span className="text-slate-300 font-mono">{val}{unit}</span>
            </div>
            <input type="range" min={min} max={max} step={step} value={val} onChange={e => set(Number(e.target.value))} className="w-full h-1 accent-sky-500" />
          </div>
        ))}
      </div>

      {/* Class chips */}
      <div className="px-3 pt-2 flex flex-wrap gap-1">
        <button onClick={() => setClassFilter('ALL')} className={`text-[10px] font-mono rounded px-1.5 py-0.5 border ${classFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'bg-slate-900/40 border-slate-800 text-slate-400 hover:border-slate-700'}`}>ALL</button>
        {CLASS_LIST.map(c => (
          <button key={c} onClick={() => setClassFilter(classFilter === c ? 'ALL' : c)} className={`text-[10px] font-mono rounded px-1.5 py-0.5 border ${classFilter === c ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'bg-slate-900/40 border-slate-800 text-slate-400 hover:border-slate-700'}`}>{c}</button>
        ))}
      </div>

      {/* Layer toggle chips */}
      <div className="px-3 pt-1.5 flex flex-wrap gap-1">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['LEG', showLeg, setShowLeg], ['PROJ', showProj, setShowProj], ['REF', showRef, setShowRef], ['DIAG', showDiag, setShowDiag]] as Array<[string, boolean, (b:boolean)=>void]>).map(([l, v, s]) => (
          <button key={l} onClick={() => s(!v)} className={`text-[10px] font-mono rounded px-1.5 py-0.5 border ${v ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'bg-slate-900/40 border-slate-800 text-slate-400 hover:border-slate-700'}`}>{l}</button>
        ))}
      </div>

      {/* Search + tabs */}
      <div className="px-3 pt-2">
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / icao …" className="w-full text-xs bg-slate-900/60 border border-slate-800 rounded px-2 py-1.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-sky-500/50" />
      </div>
      <div className="px-3 pt-2 flex gap-1">
        {(['AIRCRAFT', 'CLASSES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`text-[10px] font-mono px-2 py-1 rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'bg-slate-900/40 border-slate-800 text-slate-400 hover:border-slate-700'}`}>{t}</button>
        ))}
      </div>

      {/* Table */}
      <div className="px-3 pt-2 pb-3 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 60).map((r, i) => (
          <div key={i} className="rounded-lg border border-slate-800 bg-slate-900/40 px-2 py-1.5">
            <div className="flex items-stretch gap-2">
              <div className="w-1 rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button onClick={() => onFly(r.f.icao)} className="text-xs font-mono font-semibold text-slate-100 hover:text-sky-400">{r.f.callsign || r.f.icao}</button>
                  <span className="text-[10px] font-mono text-slate-500">{r.f.type || '?'}</span>
                  <span className="text-[9px] font-mono rounded px-1 py-px border border-slate-700 text-slate-400">{r.klass}</span>
                  <span className="text-[9px] font-mono rounded px-1 py-px border border-slate-700 text-slate-400">{r.phase}</span>
                  <span className="text-[9px] font-mono rounded px-1 py-px border border-slate-700 text-slate-400">{r.region}</span>
                  <span className="text-[9px] font-mono rounded px-1 py-px" style={{ background: TIER_COLOR[r.tier] + '25', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                  FL{Math.round(r.f.altitudeFt / 100).toString().padStart(3, '0')} · {r.zones.length}Z · {r.blindZones}BL · {r.degradedZones}DG · BOT-min {(r.worstBottlePct * 100).toFixed(0)}% · DIV {r.diversionMin}m · CGO {r.spec.cargoHalonMin}m {r.cargoDeficitMin > 0 ? `(Δ-${r.cargoDeficitMin}m)` : ''}
                </div>
                {/* Score bar */}
                <div className="h-1 bg-slate-800 rounded mt-1 overflow-hidden">
                  <div className="h-full" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }} />
                </div>
                {/* Breakdown */}
                <div className="flex flex-wrap gap-0.5 mt-1">
                  {(['lpb', 'lpa', 'bot', 'cgo', 'fal'] as const).map(k => {
                    const v = r.sev[k]
                    const c = v >= 80 ? TIER_COLOR.BA2276 : v >= 55 ? TIER_COLOR.DEGRADE : v >= 25 ? TIER_COLOR.WATCH : TIER_COLOR.OK
                    return (
                      <span key={k} className="text-[9px] font-mono rounded px-1 py-px" style={{ background: c + '20', color: c }}>{k.toUpperCase()} {Math.round(v)}</span>
                    )
                  })}
                </div>
                {/* Zone pills */}
                <div className="flex flex-wrap gap-0.5 mt-1">
                  {r.zones.map((z, zi) => (
                    <span key={zi} className="text-[9px] font-mono rounded px-1 py-px" style={{ background: LOOP_COLOR[z.loop] + '22', color: LOOP_COLOR[z.loop] }}>{z.name}·{z.loop}·{(z.bottlePctRem * 100).toFixed(0)}%</span>
                  ))}
                </div>
                <div className="text-[10px] mt-1 cursor-pointer" style={{ color: TIER_COLOR[r.tier] }} onClick={() => onFly(r.f.icao)}>
                  {r.tier === 'BA2276' ? 'ENG FIRE both loops failed + bottle <50%: shut eng / discharge both shots / divert nearest per FCOM 8.10 · BA2276 LAS pattern · log MOR' :
                   r.tier === 'VALUJET' ? `Cargo halon ${r.spec.cargoHalonMin}m short of ${r.diversionMin + 15}m required: revert to nearest non-oceanic alternate / brief CAT-C cargo per AC 25-9A · 14 CFR 121.633` :
                   r.tier === 'DEGRADE' ? 'Single-loop or low-bottle: file MOR / pre-tune divert · MEL 26 limits · brief crew of detection redundancy loss' :
                   r.tier === 'WATCH' ? 'Marginal loop continuity or false-alarm tail: schedule BITE at next A-check per SB' :
                   r.tier === 'OK' ? 'Loops A+B continuous · bottle reserve nominal · ETOPS cargo within cert' : 'Idle / on ground'}
                </div>
              </div>
            </div>
          </div>
        ))}
        {tab === 'CLASSES' && classRows.map((c, i) => (
          <div key={i} className="rounded-lg border border-slate-800 bg-slate-900/40 px-2 py-1.5">
            <div className="flex items-stretch gap-2">
              <div className="w-1 rounded" style={{ background: TIER_COLOR[c.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-mono font-semibold text-slate-100">{c.klass}</span>
                  <span className="text-[10px] text-slate-500">{c.spec.family}</span>
                  <span className="text-[9px] font-mono rounded px-1 py-px border border-slate-700 text-slate-400">{c.spec.loopArch}</span>
                  <span className="text-[9px] font-mono rounded px-1 py-px border border-slate-700 text-slate-400">{c.spec.agent}</span>
                </div>
                <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                  {c.spec.engines}E · {c.spec.shotsPerEng}sh/E · APU{c.spec.apuShots} · cargo {c.spec.cargoBays}bay {c.spec.cargoHalonMin}m · ETOPS-{c.spec.etopsMin} · AC {c.ac} · BA {c.ba} · VJ {c.vj} · DG {c.deg} · meanBL {c.meanBlind.toFixed(1)}
                </div>
                <div className="h-1 bg-slate-800 rounded mt-1 overflow-hidden">
                  <div className="h-full" style={{ width: `${c.meanScore}%`, background: TIER_COLOR[c.worstTier] }} />
                </div>
                <div className="text-[10px] mt-1 text-slate-400">worst: <button onClick={() => { const f = rows.find(r => (r.f.callsign || r.f.icao) === c.worstCs); if (f) onFly(f.f.icao) }} className="font-mono text-sky-400 hover:text-sky-300">{c.worstCs || '–'}</button></div>
              </div>
            </div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && filtered.length === 0 && <div className="text-[10px] text-slate-500 text-center py-3">no aircraft match filters</div>}
      </div>
    </div>
  )
}
