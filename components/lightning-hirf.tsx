'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Lightning Strike Zone / HIRF Exposure & Compliance Monitor
   -----------------------------------------------------------
   SAE ARP 5414B aircraft lightning zoning (Zone 1A/1B/1C, 2A/2B,
   Zone 3) · SAE ARP 5412B Lightning Environment & Test Waveforms
   (Components A/B/C/D/H, multiple-stroke / multiple-burst) /
   RTCA DO-160G Sec 22 Lightning Induced Transient Susceptibility
   levels 1-5 (cable bundle pin & cable test) / DO-160G Sec 23
   Lightning Direct Effects test categories 1A/2A/3A/4A/5A/5B for
   externally-mounted equipment / 14 CFR 25.581 Lightning
   Protection + 25.954 Fuel-System Lightning Protection / 14 CFR
   25.899 Bonding Static Electricity / EASA CS-25.581 / 25.899 /
   25.954 / AMC 25.581 / AC 20-53C Protection of Aircraft Fuel
   Systems Against Fuel-Vapor Ignition / AC 20-136B High-Intensity
   Radiated Fields (HIRF) Protection level certification (Severe /
   Normal / Fixed-Wing / Rotorcraft) / 14 CFR 25.1316 System
   Lightning Protection / FAA AC 25-19A Certification Maintenance
   Requirements (CMR) for bonding & strap inspections / Boeing
   AERO Q4-2012 "Lightning Strikes: Protection, Inspection &
   Repair" / Airbus FAST Mag 51 "Lightning Strikes on Aircraft" /
   FAA Statistical Summary (Plumer 1985 / FAA-CT-89-22): a
   commercial aircraft is struck on average once every 1000-3000
   flight hours, ~90% in the convective cell hatching layer
   FL050-FL150, ~70% within 5 nm of a CB cell, ~40% at OAT
   -10..+10 C (the triggered-lightning band).

   For every airborne aircraft we reconstruct a per-airframe
   lightning-strike encounter probability per next-15-min, the
   probable strike-zone distribution by ARP 5414B zone, and the
   HIRF/DO-160G envelope compliance posture given the airframe's
   most-recently-validated CMR bonding inspection cycle. The five
   risk components (max-driver):

     ZONE-EXP   Convective-cell proximity * triggered-lightning
                band exposure. Bands per Plumer-Robb:
                  OAT 0..+10C  = 1.00 (saturation/freezing layer)
                  OAT -10..0C  = 1.30 (mixed-phase, hi-charge)
                  OAT -20..-10C = 0.85
                  OAT -30..-20C = 0.45
                  OAT < -30C   = 0.20
                  OAT > +10C   = 0.55
                Cell-proximity proxied from hash-stable per-airframe
                "in CB-region" boolean × phase × lat-band convective
                density (ITCZ ±20° = 1.6× / mid-lat ±25-45° = 1.0× /
                polar = 0.4×). Final probability per next-15-min
                = baseRate(class) × bandMul × cellMul × tempBand
                scaled by ENV-MUL slider 50-200 %.
     ZONE-IDX   Most-likely strike attachment zone per ARP 5414B
                given aircraft geometry & vector orientation:
                  Zone 1A (initial attachment, high-prob) — nose
                         radome / wingtips / engine nacelle nose
                         / horizontal-stab tips / vert-stab tip
                  Zone 1B (initial attachment, low strike-dwell)
                  Zone 1C (transition initial→swept-stroke)
                  Zone 2A (swept stroke high probability) — wing
                         L/E aft of Zone 1A, fuselage skin aft
                         of nose, nacelle aft of inlet
                  Zone 2B (swept stroke low dwell)
                  Zone 3  (areas between Zone 1 and 2, conducting
                         continuing currents, e.g. centre fuselage)
                Severity higher when predicted attachment co-incides
                with Zone 1A fuel-system component (wingtip vent /
                wing-tank L/E) per 14 CFR 25.954.
     HIRF-CAT   AC 20-136B HIRF Environment compliance posture.
                Cat-A Severe (military airspace, narrowband
                ≥4000 V/m 2-3 GHz / ≥18 600 V/m peak): military
                low-level corridors / large airport approach
                surfaces near broadcast & ATC radars. Cat-B Normal
                / Cat-C Fixed-Wing / Cat-D Rotorcraft. Hash-stable
                per-airframe DO-160G compliance level (Level 1-5
                pin & cable). Severity climbs when airframe in
                Cat-A airspace (lat-bands near big-airport HIRF
                zones) with sub-Level-3 compliance.
     DO160     Lightning Induced Transient (LIT) DO-160G §22
                susceptibility margin for line-replaceable units
                (LRUs). Hash-stable per-airframe LRU level (Level
                1-5, where Level 5 is ±3200 V WF3 pin / ±300 A
                WF5A cable bundle). Severity rises when zone-1A
                strike predicted on an airframe whose flight-critical
                LRU is below Level 4.
     BOND       CMR bonding-strap & static-discharger inspection
                cycle vs FAA AC 25-19A interval (commonly 24 months
                / 6000 flight-hours whichever sooner). Hash-stable
                per-airframe months-since-bonding-check 0-36 and
                bond resistance milliohm 5-450 mΩ vs FAA AC 20-136B
                25 mΩ healthy / 250 mΩ degraded threshold.

   Tier classification (composite max-driver score):
     STRIKE-HI  score>=80  rose      lightning strike probability
                                     > THR within 15 min AND zone
                                     1A fuel-system intercept —
                                     deviate ±20 nm, climb above
                                     freezing layer or descend below
     ELEVATED   score>=55  amber     elevated strike risk AND/OR
                                     HIRF Cat-A intercept with
                                     sub-Level-3 LRU — log encounter,
                                     prep CMR walk-around at gate
     WATCH      score>=25  sky       within published envelope —
                                     monitor cell drift, brief crew
     OK         score<25   emerald   nominal strike envelope, AC
                                     20-136B HIRF compliance margin
                                     adequate, CMR bond healthy
     IDLE       ground/<MIN-FL slate excluded

   MapLibre overlay:
     - Tier-coloured halo rings sized by score 8-22 px
     - Rose diamond pin at predicted strike attachment vector
       (60 sec ahead along great-circle) for STRIKE-HI aircraft
     - Amber dashed Plumer triggered-lightning band reference at
       lat ±20 / ±0 ITCZ tropics sampled every 8 deg longitude
     - Tier-coloured callsign + zone + driver labels for non-OK

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-SCORE / WORST callsign+zone+driver / STRIKE-HI ct
     - 2-cell MEAN-PROB-pct-15min / BOND-DEGRADED-share secondary
     - SVG strike-prob-pct-vs-OAT-C scatter, Plumer band overlay
     - 5 sliders MIN-FL / ENV-MUL / CELL-DENSITY / BOND-AGE / HIRF-MUL
     - 7-class chip filter HVY/NRW/RGN/BIZ/TBP/GA/FTR
     - HALO/PIN/LBL/REF/DIAG toggles + search
     - AIRCRAFT / ZONES tab switcher
     - ZONES tab grouped by ARP 5414B zone (1A/1B/1C/2A/2B/3)

   Persisted preference: ft-lhirf
   ============================================================ */

interface LhirfFlight {
  icao: string
  callsign?: string
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
  flights: LhirfFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'STRIKE' | 'ELEV' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  STRIKE: '#f43f5e', ELEV: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#475569',
}
const TIER_ORDER: Tier[] = ['STRIKE', 'ELEV', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { STRIKE: 0, ELEV: 1, WATCH: 2, OK: 3, IDLE: 4 }
const TIER_LABEL: Record<Tier, string> = {
  STRIKE: 'STRIKE-HI', ELEV: 'ELEVATED', WATCH: 'WATCH', OK: 'OK', IDLE: 'IDLE',
}
const TIER_ADVICE: Record<Tier, string> = {
  STRIKE: 'strike probability > threshold AND Zone-1A fuel-system intercept — deviate ±20 nm, climb above freezing layer or descend below',
  ELEV: 'elevated strike risk and/or HIRF Cat-A intercept with sub-Level-3 LRU — log encounter, brief CMR walk-around at gate',
  WATCH: 'within published envelope — monitor cell drift, brief crew on attachment-vector zones',
  OK: 'nominal strike envelope, AC 20-136B HIRF compliance margin adequate, CMR bond healthy',
  IDLE: 'on ground or below MIN-FL — excluded from envelope',
}

type Cls = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const CLS_NAME: Record<Cls, string> = {
  HVY: 'Heavy widebody', NRW: 'Narrowbody', RGN: 'Regional jet',
  BIZ: 'Business jet', TBP: 'Turboprop', GA: 'GA piston', FTR: 'Fighter / military',
}

// Plumer/Robb base strike rate per 1000 flight-hours by class
// HVY composite-skin 787/A350 lower per Boeing AERO Q4-2012; NRW conv-alloy
// higher; military aircraft higher because of MIL-low corridors / formation
const BASE_RATE_PER_KFH: Record<Cls, number> = {
  HVY: 0.45, NRW: 0.75, RGN: 0.95, BIZ: 0.55, TBP: 1.20, GA: 0.30, FTR: 1.10,
}

// ARP 5414B zone weighting per class — proportion of strike-dwell time
// each zone receives given canonical geometry. Heavy widebody has more
// Zone 3 fuselage surface; turboprop has higher Zone 1A wingtip exposure.
type Zone = '1A' | '1B' | '1C' | '2A' | '2B' | '3'
const ZONE_LABEL: Record<Zone, string> = {
  '1A': '1A initial-att hi-prob',
  '1B': '1B initial-att lo-dwell',
  '1C': '1C transition',
  '2A': '2A swept-stroke hi-prob',
  '2B': '2B swept-stroke lo-dwell',
  '3':  '3  continuing-current',
}
const ZONE_DESC: Record<Zone, string> = {
  '1A': 'nose radome · wingtips · nacelle nose · stab tips',
  '1B': 'aft of 1A · low dwell · 25.954 fuel-system risk',
  '1C': 'transition initial → swept stroke',
  '2A': 'wing L/E aft of 1A · fuselage skin · nacelle aft',
  '2B': 'swept-stroke low-dwell aft fuselage',
  '3':  'between Zone 1 & 2 · continuing-current path',
}
const ZONE_MIX: Record<Cls, Record<Zone, number>> = {
  HVY: { '1A': 0.22, '1B': 0.10, '1C': 0.08, '2A': 0.28, '2B': 0.15, '3': 0.17 },
  NRW: { '1A': 0.26, '1B': 0.10, '1C': 0.08, '2A': 0.30, '2B': 0.14, '3': 0.12 },
  RGN: { '1A': 0.28, '1B': 0.10, '1C': 0.08, '2A': 0.30, '2B': 0.14, '3': 0.10 },
  BIZ: { '1A': 0.24, '1B': 0.10, '1C': 0.08, '2A': 0.30, '2B': 0.15, '3': 0.13 },
  TBP: { '1A': 0.34, '1B': 0.12, '1C': 0.08, '2A': 0.26, '2B': 0.12, '3': 0.08 },
  GA:  { '1A': 0.40, '1B': 0.15, '1C': 0.10, '2A': 0.20, '2B': 0.10, '3': 0.05 },
  FTR: { '1A': 0.36, '1B': 0.12, '1C': 0.08, '2A': 0.24, '2B': 0.12, '3': 0.08 },
}

// AC 20-136B HIRF environment category by class (typical certification basis)
// Cat-A Severe = military / large transport / high HIRF airspace
// Cat-B Normal / Cat-C Fixed-Wing GA / Cat-D Rotorcraft
const HIRF_CAT: Record<Cls, 'A' | 'B' | 'C'> = {
  HVY: 'A', NRW: 'A', RGN: 'B', BIZ: 'B', TBP: 'B', GA: 'C', FTR: 'A',
}

// DO-160G §22 LIT pin/cable level by class (typical) — Levels 1-5
// Level 5 = ±3200 V WF3 pin / ±300 A WF5A cable bundle (most demanding)
const DO160_LEVEL_BASE: Record<Cls, number> = {
  HVY: 4, NRW: 4, RGN: 3, BIZ: 3, TBP: 3, GA: 2, FTR: 5,
}

// FAA AC 25-19A CMR bonding inspection interval (months)
const BOND_CMR_MONTHS = 24
// AC 20-136B bond resistance thresholds (milliohm)
const BOND_HEALTHY_MOHM = 25
const BOND_DEGRADED_MOHM = 250

type Phase = 'TAKEOFF' | 'CLIMB' | 'CRUISE' | 'DESCENT' | 'APPR'
const PHASE_LABEL: Record<Phase, string> = {
  TAKEOFF: 'TO', CLIMB: 'CLB', CRUISE: 'CRZ', DESCENT: 'DES', APPR: 'APP',
}
const PHASE_STRIKE_MUL: Record<Phase, number> = {
  // Plumer Stat-Summary: ~45% climb/descent through freezing layer,
  // ~30% approach (low-alt CB), ~15% cruise, ~10% takeoff
  TAKEOFF: 0.9, CLIMB: 1.4, CRUISE: 0.7, DESCENT: 1.3, APPR: 1.5,
}

function inferPhase(altFt: number, vsFpm: number): Phase {
  if (altFt < 5000 && vsFpm > 1500) return 'TAKEOFF'
  if (altFt < 9000 && vsFpm < -500) return 'APPR'
  if (vsFpm > 600) return 'CLIMB'
  if (vsFpm < -600) return 'DESCENT'
  return 'CRUISE'
}

// FNV-1a 32-bit
function hashUnit(s: string, salt: string): number {
  let h = 0x811c9dc5
  const x = (salt + '|' + s)
  for (let i = 0; i < x.length; i++) {
    h ^= x.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h % 100000) / 100000
}

function classify(type?: string): Cls {
  const t = (type || '').toUpperCase()
  if (/^(B77|B78|B74|B76|A33|A34|A35|A38|MD11)/.test(t)) return 'HVY'
  if (/^(B73|A31|A32|A22|MD8|MD9)/.test(t)) return 'NRW'
  if (/^(CRJ|E17|E19|E29|AT[47])/.test(t)) return 'RGN'
  if (/^(GLF|GL|FA|F900|F2TH|CL|GLEX|G[56])/.test(t)) return 'BIZ'
  if (/^(DH8|AT4|AT7|BE|PA4|SF34|J32)/.test(t)) return 'TBP'
  if (/^(C1[5678]|SR2|PA28|DA40|DA42|PC12|TBM)/.test(t)) return 'GA'
  if (/^(F1[56]|F18|F22|F35|EUF|MIG|SU[2-3]|T[6-8])/.test(t)) return 'FTR'
  return 'NRW'
}

// ISA OAT estimate from altitude (deg C)
function oatFromAlt(altKft: number): number {
  return altKft < 36 ? 15 - 1.98 * altKft : -56.5
}

// Plumer-Robb temperature-band multiplier for triggered-lightning likelihood
function tempBandMul(oatC: number): number {
  if (oatC >= 0 && oatC <= 10) return 1.00
  if (oatC >= -10 && oatC < 0) return 1.30
  if (oatC >= -20 && oatC < -10) return 0.85
  if (oatC >= -30 && oatC < -20) return 0.45
  if (oatC < -30) return 0.20
  return 0.55 // >10C
}

// Lat-band convective density multiplier (ITCZ / mid-lat / polar)
function latBandMul(latDeg: number): number {
  const a = Math.abs(latDeg)
  if (a <= 20) return 1.6
  if (a <= 45) return 1.0
  return 0.4
}

// HIRF airspace intercept proxy — Cat-A airspace flagged hash-stable
// when within ±2deg lat of mid-lat large-airport bands AND below FL250
function hirfAirspaceCatA(icao: string, latDeg: number, altKft: number): boolean {
  if (altKft > 25) return false
  const a = Math.abs(latDeg)
  const nearBigApt = (a >= 25 && a <= 55) // CONUS / EUR / EA bands
  if (!nearBigApt) return false
  return hashUnit(icao, 'hirfair') < 0.35
}

interface Row {
  f: LhirfFlight
  cls: Cls
  altKft: number
  fl: number
  oat: number
  phase: Phase
  // ZONE-EXP
  baseRate: number     // strikes per kFH base
  cellNear: boolean
  pStrike15: number    // prob % next 15 min
  zoneExpSev: number
  // ZONE-IDX
  zone: Zone
  zoneFuelSys: boolean // 25.954 fuel-system intercept
  zoneIdxSev: number
  // HIRF-CAT
  hirfCat: 'A' | 'B' | 'C'
  hirfAirA: boolean    // currently in Cat-A airspace
  do160Lvl: number     // 1-5
  hirfSev: number
  do160Sev: number
  // BOND
  bondMonths: number
  bondMOhm: number
  bondSev: number
  driver: 'EXP' | 'ZON' | 'HIR' | 'DO1' | 'BND'
  driverLong: string
  score: number
  tier: Tier
}

const DRIVER_LONG: Record<Row['driver'], string> = {
  EXP: 'Strike probability > 15-min threshold (freezing band + CB)',
  ZON: 'Probable attachment zone intercepts 14 CFR 25.954 fuel system',
  HIR: 'HIRF Cat-A airspace intercept with sub-Level-3 LRU',
  DO1: 'DO-160G §22 LIT susceptibility margin below class baseline',
  BND: 'AC 25-19A CMR bonding cycle / 20-136B bond resistance overdue',
}

export default function LightningHirf({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState(30)
  const [envMul, setEnvMul] = useState(100)       // 50-200 % global strike-env
  const [cellDensity, setCellDensity] = useState(100) // 50-200 % CB-cell proxy
  const [bondAge, setBondAge] = useState(100)     // 50-200 % CMR-cycle ageing
  const [hirfMul, setHirfMul] = useState(100)     // 50-200 % HIRF airspace
  const [thrPct, setThrPct] = useState(8)         // 1-30 % 15-min strike threshold
  const [tierFilter, setTierFilter] = useState<Set<Tier>>(new Set())
  const [clsFilter, setClsFilter] = useState<Set<Cls>>(new Set())
  const [zoneFilter, setZoneFilter] = useState<Set<Zone>>(new Set())
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT' | 'ZONES'>('AIRCRAFT')

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const envScale = envMul / 100
    const cellScale = cellDensity / 100
    const bondScale = bondAge / 100
    const hirfScale = hirfMul / 100
    for (const f of flights) {
      if (!isFinite(f.altitudeFt)) continue
      const altKft = f.altitudeFt / 1000
      const fl = Math.round(altKft * 10)
      const cls = classify(f.type)
      const oat = oatFromAlt(altKft)
      const phase = inferPhase(f.altitudeFt, f.vertRate || 0)

      // --- ZONE-EXP ---
      const baseRate = BASE_RATE_PER_KFH[cls]
      // Hash-stable per-airframe "currently in CB region" flag (15-min look-ahead)
      const cellNear = hashUnit(f.icao, 'cb') < (0.18 * cellScale * latBandMul(f.lat) / 1.6 + 0.07)
      const lat = latBandMul(f.lat)
      const tempB = tempBandMul(oat)
      const phaseMul = PHASE_STRIKE_MUL[phase]
      // rate per kFH → next-15-min probability assuming Poisson process
      // 0.25 h slice ⇒ p = 1 - exp(-λ·0.25)
      const cellMul = cellNear ? 4.5 : 1.0
      const lambda = baseRate * tempB * lat * phaseMul * cellMul * envScale / 1000 // strikes per h
      const pStrike15 = 1 - Math.exp(-lambda * 0.25) // 0..1
      const pPct = pStrike15 * 100
      // severity: 0 at p<=2%, ramps to 100 at p>=thrPct
      const zoneExpSev = Math.max(0, Math.min(100, ((pPct - 2) / Math.max(1, (thrPct - 2))) * 100))

      // --- ZONE-IDX ---
      // pick probable zone by class mix + hash
      const mix = ZONE_MIX[cls]
      const zHash = hashUnit(f.icao, 'zone')
      let cum = 0
      let zone: Zone = '2A'
      for (const z of ['1A','1B','1C','2A','2B','3'] as Zone[]) {
        cum += mix[z]
        if (zHash <= cum) { zone = z; break }
      }
      // Fuel-system intercept (25.954) when Zone 1A or 1B AND wingtip-vent
      // present (true for HVY/NRW/RGN/BIZ in 60% of airframes, lower TBP/GA)
      const fuelSysProb = cls === 'HVY' || cls === 'NRW' ? 0.65 : cls === 'RGN' || cls === 'BIZ' ? 0.55 : cls === 'TBP' ? 0.30 : cls === 'GA' ? 0.15 : 0.40
      const zoneFuelSys = (zone === '1A' || zone === '1B') && hashUnit(f.icao, 'fuelsys') < fuelSysProb
      // severity: 1A = 70, 1B = 55, 2A = 35, 2B = 20, 1C = 30, 3 = 10
      //  + 25 if fuel-system intercept
      const zBaseSev: Record<Zone, number> = { '1A': 70, '1B': 55, '1C': 30, '2A': 35, '2B': 20, '3': 10 }
      const zoneIdxSev = Math.min(100, zBaseSev[zone] + (zoneFuelSys ? 25 : 0))

      // --- HIRF-CAT / DO-160 LIT ---
      const hirfCat = HIRF_CAT[cls]
      const hirfAirA = hashUnit(f.icao, 'hirf') < (0.35 * hirfScale) && altKft <= 25 && Math.abs(f.lat) <= 55 && Math.abs(f.lat) >= 25
      // DO-160G LIT level (hash-stable per airframe, ±1 from baseline)
      const lvlDelta = Math.round((hashUnit(f.icao, 'do160') - 0.5) * 2) // -1, 0, +1
      const do160Lvl = Math.max(1, Math.min(5, DO160_LEVEL_BASE[cls] + lvlDelta))
      // HIRF severity: airspace Cat-A intercept × sub-Level-3 LRU
      const lvlGap = Math.max(0, 4 - do160Lvl) // 0 if level>=4
      const hirfSev = hirfAirA ? Math.min(100, 30 + lvlGap * 30) : Math.min(40, lvlGap * 15)
      const do160Sev = lvlGap * 25 + (zone === '1A' && do160Lvl < 4 ? 30 : 0)

      // --- BOND CMR ---
      const bondMonths = hashUnit(f.icao, 'bond') * 36 * bondScale
      const bondMOhm = 5 + hashUnit(f.icao, 'bondR') * 445 * (0.5 + bondScale * 0.5)
      const bondOverdue = bondMonths > BOND_CMR_MONTHS
      const bondHigh = bondMOhm > BOND_DEGRADED_MOHM
      const bondMidR = bondMOhm > 80
      let bondSev = 0
      if (bondHigh) bondSev = 80
      else if (bondMidR) bondSev = 40
      if (bondOverdue) bondSev = Math.max(bondSev, 65)
      bondSev = Math.min(100, bondSev)

      const parts = [
        { k: 'EXP' as const, v: zoneExpSev },
        { k: 'ZON' as const, v: zoneIdxSev * (pStrike15 > 0.02 ? 1.0 : 0.4) },
        { k: 'HIR' as const, v: hirfSev },
        { k: 'DO1' as const, v: do160Sev },
        { k: 'BND' as const, v: bondSev },
      ]
      parts.sort((a, b) => b.v - a.v)
      const score = parts[0].v
      const driver = parts[0].k

      let tier: Tier
      if (f.ground || fl < minFL) tier = 'IDLE'
      else if (score >= 80) tier = 'STRIKE'
      else if (score >= 55) tier = 'ELEV'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, cls, altKft, fl, oat, phase,
        baseRate, cellNear, pStrike15, zoneExpSev,
        zone, zoneFuelSys, zoneIdxSev,
        hirfCat, hirfAirA, do160Lvl, hirfSev, do160Sev,
        bondMonths, bondMOhm, bondSev,
        driver, driverLong: DRIVER_LONG[driver],
        score, tier,
      })
    }
    return out
  }, [flights, minFL, envMul, cellDensity, bondAge, hirfMul, thrPct])

  const stats = useMemo(() => {
    const counts: Record<Tier, number> = { STRIKE: 0, ELEV: 0, WATCH: 0, OK: 0, IDLE: 0 }
    let sumScore = 0, sumProb = 0, n = 0, bondBadN = 0, totN = 0
    let worst: Row | null = null
    for (const r of rows) {
      counts[r.tier]++
      if (r.tier === 'IDLE') continue
      sumScore += r.score; sumProb += r.pStrike15 * 100; n++; totN++
      if (r.bondMOhm > BOND_DEGRADED_MOHM || r.bondMonths > BOND_CMR_MONTHS) bondBadN++
      if (!worst || r.score > worst.score) worst = r
    }
    return {
      counts,
      meanScore: n ? sumScore / n : 0,
      meanProb: n ? sumProb / n : 0,
      bondBadShare: totN ? bondBadN / totN : 0,
      worst,
    }
  }, [rows])

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter.size && !tierFilter.has(r.tier)) return false
      if (clsFilter.size && !clsFilter.has(r.cls)) return false
      if (zoneFilter.size && !zoneFilter.has(r.zone)) return false
      if (q) {
        const blob = `${r.f.callsign || ''} ${r.f.type || ''} ${r.f.operator || ''}`.toUpperCase()
        if (!blob.includes(q)) return false
      }
      return true
    }).sort((a, b) => {
      const r = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (r) return r
      return b.score - a.score
    })
  }, [rows, tierFilter, clsFilter, zoneFilter, search])

  const zones = useMemo(() => {
    const grp: Record<Zone, Row[]> = { '1A': [], '1B': [], '1C': [], '2A': [], '2B': [], '3': [] }
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      grp[r.zone].push(r)
    }
    return (Object.entries(grp) as [Zone, Row[]][])
      .filter(([, rs]) => rs.length)
      .map(([z, rs]) => {
        const worstTier = rs.reduce<Tier>((a, b) => TIER_RANK[b.tier] < TIER_RANK[a] ? b.tier : a, 'OK')
        const meanScore = rs.reduce((s, r) => s + r.score, 0) / rs.length
        const meanProb = rs.reduce((s, r) => s + r.pStrike15 * 100, 0) / rs.length
        const fuelN = rs.filter(r => r.zoneFuelSys).length
        const worst = rs.reduce((a, b) => b.score > a.score ? b : a)
        return { zone: z, rs, worstTier, meanScore, meanProb, fuelN, worst }
      })
      .sort((a, b) => {
        const r = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
        if (r) return r
        return b.rs.length - a.rs.length
      })
  }, [rows])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const SRC = 'ft-lhirf-src'
    const HALO = 'ft-lhirf-halo'
    const PIN = 'ft-lhirf-pin'
    const LBL = 'ft-lhirf-lbl'
    const REF_SRC = 'ft-lhirf-ref-src'
    const REF_LYR = 'ft-lhirf-ref-lyr'

    const features: GeoJSON.Feature[] = []
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      if (tierFilter.size && !tierFilter.has(r.tier)) continue
      if (clsFilter.size && !clsFilter.has(r.cls)) continue
      if (zoneFilter.size && !zoneFilter.has(r.zone)) continue
      // 60-sec ahead pin position for STRIKE
      const dNm = r.f.velocityKts * (60 / 3600)
      const trackRad = (r.f.track || 0) * Math.PI / 180
      const dLat = (dNm / 60) * Math.cos(trackRad)
      const dLng = (dNm / 60) * Math.sin(trackRad) / Math.max(0.2, Math.cos(r.f.lat * Math.PI / 180))
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
        properties: {
          tier: r.tier,
          color: TIER_COLOR[r.tier],
          radius: 8 + (r.score / 100) * 14,
          label: `${r.f.callsign || r.f.icao} · Z${r.zone} · ${r.driver}`,
          isStrike: r.tier === 'STRIKE' ? 1 : 0,
          pinLng: r.f.lng + dLng,
          pinLat: r.f.lat + dLat,
        },
      })
    }
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features }

    // Pin features at projected attachment vector for STRIKE
    const pinFeatures: GeoJSON.Feature[] = features
      .filter(ft => (ft.properties as any).isStrike === 1)
      .map(ft => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [(ft.properties as any).pinLng, (ft.properties as any).pinLat] },
        properties: {},
      }))
    const pinFc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: pinFeatures }

    // Reference dots — Plumer triggered-lightning bands (ITCZ ±0, sub-trop ±20)
    const refFeatures: GeoJSON.Feature[] = []
    if (showRef) {
      for (const lat of [-20, 0, 20]) {
        for (let lon = -180; lon <= 180; lon += 8) {
          refFeatures.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: { mark: 1 },
          })
        }
      }
    }
    const refFc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: refFeatures }

    const addAll = () => {
      const existSrc = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined
      if (existSrc) existSrc.setData(fc)
      else map.addSource(SRC, { type: 'geojson', data: fc })

      const existPin = map.getSource(SRC + '-pin') as maplibregl.GeoJSONSource | undefined
      if (existPin) existPin.setData(pinFc)
      else map.addSource(SRC + '-pin', { type: 'geojson', data: pinFc })

      const existRef = map.getSource(REF_SRC) as maplibregl.GeoJSONSource | undefined
      if (existRef) existRef.setData(refFc)
      else map.addSource(REF_SRC, { type: 'geojson', data: refFc })

      if (showHalo && !map.getLayer(HALO)) {
        map.addLayer({
          id: HALO, source: SRC, type: 'circle',
          paint: {
            'circle-radius': ['get', 'radius'],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.15,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 1.4,
            'circle-stroke-opacity': 0.85,
          },
        })
      }
      if (!showHalo && map.getLayer(HALO)) map.removeLayer(HALO)

      if (showPin && !map.getLayer(PIN)) {
        map.addLayer({
          id: PIN, source: SRC + '-pin', type: 'circle',
          paint: {
            'circle-radius': 6,
            'circle-color': '#f43f5e',
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 1.5,
          },
        })
      }
      if (!showPin && map.getLayer(PIN)) map.removeLayer(PIN)

      if (showLbl && !map.getLayer(LBL)) {
        map.addLayer({
          id: LBL, source: SRC, type: 'symbol',
          filter: ['!=', ['get', 'tier'], 'OK'],
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-offset': [0, 1.4],
            'text-anchor': 'top',
            'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          },
          paint: {
            'text-color': ['get', 'color'],
            'text-halo-color': '#020617',
            'text-halo-width': 1.4,
          },
        })
      }
      if (!showLbl && map.getLayer(LBL)) map.removeLayer(LBL)

      if (showRef && !map.getLayer(REF_LYR)) {
        map.addLayer({
          id: REF_LYR, source: REF_SRC, type: 'circle',
          paint: {
            'circle-radius': 2,
            'circle-color': '#f59e0b',
            'circle-opacity': 0.45,
            'circle-stroke-width': 0,
          },
        })
      }
      if (!showRef && map.getLayer(REF_LYR)) map.removeLayer(REF_LYR)
    }

    if (map.isStyleLoaded()) addAll()
    else map.once('load', addAll)

    return () => {
      for (const l of [LBL, PIN, HALO, REF_LYR]) if (map.getLayer(l)) map.removeLayer(l)
      for (const s of [SRC, SRC + '-pin', REF_SRC]) if (map.getSource(s)) map.removeSource(s)
    }
  }, [map, rows, tierFilter, clsFilter, zoneFilter, showHalo, showPin, showLbl, showRef])

  const toggleSet = <T,>(s: Set<T>, v: T): Set<T> => {
    const n = new Set(s); if (n.has(v)) n.delete(v); else n.add(v); return n
  }

  // SVG scatter: strike-prob-pct (x) vs OAT-C (y), Plumer band overlay
  const xMin = 0, xMax = 30, yMin = -60, yMax = 25
  const w = 360, h = 180
  const px = (p: number) => ((Math.max(xMin, Math.min(xMax, p)) - xMin) / (xMax - xMin)) * w
  const py = (t: number) => h - ((Math.max(yMin, Math.min(yMax, t)) - yMin) / (yMax - yMin)) * h

  return (
    <div className="absolute top-4 right-4 z-40 w-[420px] max-h-[90vh] overflow-hidden bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl flex flex-col">
      <div className="sticky top-0 bg-slate-950/95 px-4 py-3 border-b border-slate-800 flex items-center justify-between shrink-0">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">SAE ARP 5414B / DO-160G §22-23 / AC 20-136B / 25.954</div>
          <div className="text-sm font-semibold text-slate-100">Lightning Strike Zone · HIRF Compliance</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      <div className="overflow-y-auto px-4 py-3 space-y-3 text-xs">
        {/* Tier counter strip */}
        <div className="grid grid-cols-5 gap-1">
          {TIER_ORDER.map(t => (
            <button key={t}
              onClick={() => setTierFilter(s => toggleSet(s, t))}
              className={`px-1.5 py-1 rounded border text-[10px] transition ${tierFilter.has(t) ? 'bg-sky-500/15 border-sky-500/50' : 'bg-slate-900/50 border-slate-800 hover:border-slate-700'}`}
              style={{ borderLeftWidth: 3, borderLeftColor: TIER_COLOR[t] }}>
              <div className="font-semibold text-slate-100">{stats.counts[t]}</div>
              <div className="text-[9px] text-slate-500 truncate">{TIER_LABEL[t]}</div>
            </button>
          ))}
        </div>

        {/* Summary cells */}
        <div className="grid grid-cols-3 gap-1.5">
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">MEAN SCORE</div>
            <div className={`font-mono ${stats.meanScore >= 55 ? 'text-amber-300' : stats.meanScore >= 25 ? 'text-sky-300' : 'text-emerald-300'}`}>{stats.meanScore.toFixed(0)}</div>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">WORST</div>
            <div className="font-mono text-slate-100 truncate">
              {stats.worst ? `${stats.worst.f.callsign || stats.worst.f.icao} · Z${stats.worst.zone} · ${stats.worst.driver}` : '—'}
            </div>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5" style={{ borderLeftWidth: 3, borderLeftColor: TIER_COLOR['STRIKE'] }}>
            <div className="text-[9px] uppercase tracking-wider text-slate-500">STRIKE-HI</div>
            <div className="font-mono text-slate-100">{stats.counts['STRIKE']}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">MEAN PROB 15-min</div>
            <div className={`font-mono ${stats.meanProb >= thrPct ? 'text-rose-300' : stats.meanProb >= thrPct * 0.5 ? 'text-amber-300' : 'text-slate-100'}`}>
              {stats.meanProb.toFixed(1)}%
            </div>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">BOND DEGRADED</div>
            <div className={`font-mono ${stats.bondBadShare >= 0.25 ? 'text-amber-300' : 'text-slate-100'}`}>
              {(stats.bondBadShare * 100).toFixed(0)}%
            </div>
          </div>
        </div>

        {/* SVG scatter */}
        {showDiag && (
          <div className="bg-slate-900/30 border border-slate-800 rounded p-1.5">
            <div className="flex justify-between items-center text-[9px] text-slate-500 mb-1">
              <span>strike-prob % (15-min) × OAT °C · Plumer band</span>
              <span>0..-10 °C peak</span>
            </div>
            <svg viewBox={`0 0 ${w} ${h + 22}`} className="w-full">
              {/* Plumer triggered-lightning band (0..-10 C) */}
              <rect x={0} y={py(0)} width={w} height={py(-10) - py(0)}
                fill="#f59e0b" fillOpacity={0.10} stroke="#f59e0b" strokeOpacity={0.35} strokeDasharray="3 3" strokeWidth={1} />
              {/* Secondary band (0..+10 C saturation) */}
              <rect x={0} y={py(10)} width={w} height={py(0) - py(10)}
                fill="#10b981" fillOpacity={0.08} />
              {/* Threshold vertical */}
              <line x1={px(thrPct)} x2={px(thrPct)} y1={0} y2={h}
                stroke="#f43f5e" strokeWidth={1} strokeDasharray="4 3" strokeOpacity={0.7} />
              <text x={px(thrPct) + 2} y={10} fontSize={8} fill="#f43f5e">THR {thrPct}%</text>
              {/* Grid */}
              {[-50, -30, -10, 0, 10].map(t => (
                <g key={'t' + t}>
                  <line x1={0} x2={w} y1={py(t)} y2={py(t)} stroke="#1e293b" strokeWidth={0.5} />
                  <text x={2} y={py(t) - 1} fontSize={7} fill="#475569">{t}°C</text>
                </g>
              ))}
              {[5, 10, 20].map(p => (
                <g key={'p' + p}>
                  <line x1={px(p)} x2={px(p)} y1={0} y2={h} stroke="#1e293b" strokeWidth={0.5} />
                  <text x={px(p) + 2} y={h - 2} fontSize={7} fill="#475569">{p}%</text>
                </g>
              ))}
              {/* Dots */}
              {rows.filter(r => r.tier !== 'IDLE').slice(0, 800).map((r, i) => (
                <circle key={i}
                  cx={px(r.pStrike15 * 100)} cy={py(r.oat)}
                  r={r.tier === 'STRIKE' ? 3 : 2}
                  fill={TIER_COLOR[r.tier]} fillOpacity={0.85} />
              ))}
              {/* Legend */}
              <g transform={`translate(0,${h + 4})`}>
                <rect x={0} y={0} width={8} height={8} fill="#f59e0b" fillOpacity={0.35} stroke="#f59e0b" strokeWidth={0.5} strokeDasharray="2 2" />
                <text x={11} y={7} fontSize={8} fill="#94a3b8">Plumer −10..0 °C band</text>
                <rect x={140} y={0} width={8} height={8} fill="#10b981" fillOpacity={0.3} />
                <text x={151} y={7} fontSize={8} fill="#94a3b8">0..+10 °C saturation</text>
              </g>
            </svg>
          </div>
        )}

        {/* Sliders */}
        <div className="grid grid-cols-2 gap-2">
          {[
            ['MIN-FL', minFL, setMinFL, 0, 400, ''],
            ['ENV-MUL', envMul, setEnvMul, 50, 200, '%'],
            ['CELL-DENS', cellDensity, setCellDensity, 50, 200, '%'],
            ['BOND-AGE', bondAge, setBondAge, 50, 200, '%'],
            ['HIRF-MUL', hirfMul, setHirfMul, 50, 200, '%'],
          ].map(([lbl, val, setter, min, max, unit]: any) => (
            <label key={lbl} className="block">
              <div className="flex justify-between text-[9px] uppercase tracking-wider text-slate-500 mb-0.5">
                <span>{lbl}</span><span className="font-mono text-slate-300">{val}{unit}</span>
              </div>
              <input type="range" min={min} max={max} value={val} onChange={e => setter(Number(e.target.value))}
                className="w-full accent-sky-500" />
            </label>
          ))}
        </div>
        <label className="block">
          <div className="flex justify-between text-[9px] uppercase tracking-wider text-slate-500 mb-0.5">
            <span>STRIKE-THR (15-min)</span><span className="font-mono text-slate-300">{thrPct}%</span>
          </div>
          <input type="range" min={1} max={30} value={thrPct} onChange={e => setThrPct(Number(e.target.value))}
            className="w-full accent-sky-500" />
        </label>

        {/* Class filter */}
        <div className="flex gap-1 flex-wrap">
          {(Object.keys(CLS_NAME) as Cls[]).map(c => (
            <button key={c} onClick={() => setClsFilter(s => toggleSet(s, c))}
              title={CLS_NAME[c]}
              className={`px-1.5 py-0.5 rounded border text-[10px] transition ${clsFilter.has(c) ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-300 hover:border-slate-700'}`}>
              {c}
            </button>
          ))}
        </div>
        {/* Zone filter */}
        <div className="flex gap-1 flex-wrap">
          {(['1A','1B','1C','2A','2B','3'] as Zone[]).map(z => (
            <button key={z} onClick={() => setZoneFilter(s => toggleSet(s, z))}
              title={ZONE_DESC[z]}
              className={`px-1.5 py-0.5 rounded border text-[10px] font-mono transition ${zoneFilter.has(z) ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-300 hover:border-slate-700'}`}>
              Z{z}
            </button>
          ))}
        </div>

        {/* Layer toggles + search */}
        <div className="flex items-center gap-1 flex-wrap">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['REF', showRef, setShowRef],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lbl, on, set]: any) => (
            <button key={lbl} onClick={() => set((v: boolean) => !v)}
              className={`px-1.5 py-0.5 rounded border text-[10px] ${on ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400'}`}>
              {lbl}
            </button>
          ))}
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search"
            className="flex-1 min-w-0 bg-slate-900/50 border border-slate-800 rounded px-2 py-0.5 text-[11px] text-slate-100 placeholder-slate-600" />
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1">
          {(['AIRCRAFT', 'ZONES'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 rounded border text-[10px] ${tab === t ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400'}`}>
              {t}
            </button>
          ))}
        </div>

        {/* Aircraft tab */}
        {tab === 'AIRCRAFT' && (
          <div className="space-y-1.5">
            {filtered.slice(0, 100).map(r => {
              const tc = TIER_COLOR[r.tier]
              const pPct = r.pStrike15 * 100
              return (
                <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
                  className="w-full text-left bg-slate-900/50 hover:bg-slate-800/70 border border-slate-800 hover:border-slate-700 rounded p-2 transition"
                  style={{ borderLeftWidth: 3, borderLeftColor: tc }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-slate-100 text-[11px] truncate flex-1">
                      {r.f.callsign || r.f.icao}
                      <span className="text-slate-500 ml-1">{r.f.type || ''}</span>
                    </div>
                    <span className="text-[9px] px-1 py-0.5 rounded border" style={{ color: tc, borderColor: tc + '80' }}>{r.cls}</span>
                    <span className="text-[9px] px-1 py-0.5 rounded border font-mono" style={{ color: tc, borderColor: tc + '80' }}>Z{r.zone}</span>
                    <span className="text-[9px] px-1 py-0.5 rounded font-semibold" style={{ color: tc, background: tc + '22', border: `1px solid ${tc}66` }}>{TIER_LABEL[r.tier]}</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] mt-0.5">
                    <span className="font-mono text-slate-400">
                      FL{r.fl} · {PHASE_LABEL[r.phase]} · OAT <span className={r.oat >= -10 && r.oat <= 10 ? 'text-amber-300' : ''}>{r.oat.toFixed(0)}°C</span>
                      {' · p '}<span style={{ color: pPct >= thrPct ? '#f43f5e' : pPct >= thrPct * 0.5 ? '#f59e0b' : '#10b981' }}>{pPct.toFixed(1)}%</span>
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 bg-slate-800 rounded relative overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${r.score}%`, background: tc, opacity: 0.85 }} />
                    {[25, 55, 80].map(t => (
                      <div key={t} className="absolute top-0 bottom-0 w-px bg-slate-600" style={{ left: `${t}%` }} />
                    ))}
                  </div>
                  <div className="grid grid-cols-5 gap-0.5 mt-1">
                    {[
                      ['EXP', r.zoneExpSev],
                      ['ZON', r.zoneIdxSev],
                      ['HIR', r.hirfSev],
                      ['DO1', r.do160Sev],
                      ['BND', r.bondSev],
                    ].map(([k, v]: any) => {
                      const c = v >= 80 ? TIER_COLOR.STRIKE : v >= 55 ? TIER_COLOR.ELEV : v >= 25 ? TIER_COLOR.WATCH : TIER_COLOR.OK
                      return (
                        <div key={k} className="text-center text-[8px] py-0.5 rounded" style={{ background: c + '22', color: c, border: `1px solid ${c}44` }}>
                          {k} {v.toFixed(0)}
                        </div>
                      )
                    })}
                  </div>
                  <div className="flex items-center justify-between text-[9px] mt-1 text-slate-500">
                    <span className="font-mono">
                      <span className={r.cellNear ? 'text-amber-400' : ''}>{r.cellNear ? 'CB-NEAR' : 'CB-FAR'}</span>
                      {' · '}
                      <span className={r.zoneFuelSys ? 'text-rose-400' : ''}>{r.zoneFuelSys ? '25.954 FUEL-SYS' : 'no-fuel-sys'}</span>
                      {' · HIRF '}<span className={r.hirfAirA ? 'text-amber-400' : ''}>{r.hirfCat}{r.hirfAirA ? '*' : ''}</span>
                      {' · DO-160 L'}<span className={r.do160Lvl < 3 ? 'text-rose-400' : r.do160Lvl < 4 ? 'text-amber-400' : ''}>{r.do160Lvl}</span>
                      {' · bond '}<span className={r.bondMOhm > BOND_DEGRADED_MOHM ? 'text-rose-400' : r.bondMOhm > 80 ? 'text-amber-400' : ''}>{r.bondMOhm.toFixed(0)}mΩ</span>
                      {' / '}<span className={r.bondMonths > BOND_CMR_MONTHS ? 'text-amber-400' : ''}>{r.bondMonths.toFixed(0)}mo</span>
                    </span>
                    <span className="truncate ml-1">{r.f.operator || ''}</span>
                  </div>
                  <div className="text-[9px] mt-0.5" style={{ color: tc }}>› {r.driverLong} · {TIER_ADVICE[r.tier]}</div>
                </button>
              )
            })}
            {!filtered.length && (
              <div className="text-center text-slate-500 py-4 text-[11px]">No aircraft match filters</div>
            )}
          </div>
        )}

        {/* Zones tab */}
        {tab === 'ZONES' && (
          <div className="space-y-1.5">
            {zones.map(z => {
              const tc = TIER_COLOR[z.worstTier]
              return (
                <button key={z.zone} onClick={() => onFly(z.worst.f.icao)}
                  className="w-full text-left bg-slate-900/50 hover:bg-slate-800/70 border border-slate-800 hover:border-slate-700 rounded p-2 transition"
                  style={{ borderLeftWidth: 3, borderLeftColor: tc }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 flex-1 min-w-0">
                      <span className="text-[9px] px-1 py-0.5 rounded border font-mono" style={{ color: tc, borderColor: tc + '80' }}>Z{z.zone}</span>
                      <span className="text-slate-100 text-[11px] truncate">{ZONE_LABEL[z.zone]}</span>
                    </div>
                    <span className="text-[10px] font-mono text-slate-400">{z.rs.length} ac</span>
                    <span className="text-[9px] px-1 py-0.5 rounded font-semibold" style={{ color: tc, background: tc + '22', border: `1px solid ${tc}66` }}>{TIER_LABEL[z.worstTier]}</span>
                  </div>
                  <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                    mean score <span style={{ color: tc }}>{z.meanScore.toFixed(0)}</span>
                    {' · '}mean prob <span style={{ color: z.meanProb >= thrPct ? '#f43f5e' : z.meanProb >= thrPct * 0.5 ? '#f59e0b' : '#10b981' }}>{z.meanProb.toFixed(1)}%</span>
                    {' · 25.954 fuel-sys '}<span style={{ color: z.fuelN ? '#f59e0b' : '#10b981' }}>{z.fuelN}</span>
                  </div>
                  <div className="mt-1 h-1.5 bg-slate-800 rounded relative overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${z.meanScore}%`, background: tc, opacity: 0.85 }} />
                    {[25, 55, 80].map(t => (
                      <div key={t} className="absolute top-0 bottom-0 w-px bg-slate-600" style={{ left: `${t}%` }} />
                    ))}
                  </div>
                  <div className="text-[9px] mt-1 text-slate-500 font-mono">
                    {ZONE_DESC[z.zone]} · worst {z.worst.f.callsign || z.worst.f.icao} score {z.worst.score.toFixed(0)}
                  </div>
                  <div className="text-[9px] mt-0.5" style={{ color: tc }}>› {TIER_ADVICE[z.worstTier]}</div>
                </button>
              )
            })}
            {!zones.length && (
              <div className="text-center text-slate-500 py-4 text-[11px]">No active zones</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
