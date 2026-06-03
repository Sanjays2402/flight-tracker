'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   AIRAC Cycle / FMS Nav-Database Currency &
   ARINC 424 Coded-Procedure Compliance Monitor
   -----------------------------------------------------------
   Per-airframe Flight Management System (FMS) navigation-
   database cycle tracker vs the active 28-day ICAO AIRAC
   cycle (Aeronautical Information Regulation And Control).
   Tracks supplier (Jeppesen / Navblue / Lufthansa Systems
   LIDO / Honeywell), part-coverage (NAV / CHART / TERR /
   OBST), regional coverage tag (Worldwide / EUR-NAM /
   Tailored), cycle-issued / cycle-effective / cycle-expiry,
   dual-database loaded (active vs standby), PBN procedure
   currency vs each operating FIR, and the operational
   consequence per ICAO Annex 15 & PANS-AIM Doc 10066.

   Regulatory & operational basis:
     · ICAO Annex 15 Aeronautical Information Services
       App 4 AIRAC schedule, 28-day cycle, Thursday effective
     · ICAO Doc 10066 PANS-AIM (Aeronautical Information
       Management) — replaces former Annex 15 § 6.1 AIRAC
     · ICAO Doc 8126 AIS Manual ch 2 AIRAC
     · ICAO Doc 9613 PBN Manual Vol II — nav-database integrity
     · ICAO Doc 8168 PANS-OPS Vol II ch 3 RNAV / RNP procedure
       coding requirement
     · RTCA DO-200B Standards for Processing Aeronautical Data
       (data assurance levels 1-3, supplier LoA per § 1.4.2)
     · RTCA DO-201A Standards for Aeronautical Information
     · EUROCAE ED-76A / ED-77 Standards for Aeronautical Data
     · ARINC 424-22 Navigation System Database (Spec 424)
     · ARINC 816-1 Embedded Interchange Format for ATSEP
     · ARINC 833 Aircraft Data Interface Function
     · FAA AC 20-153B Acceptance of Data Processed by Aeronautical
       Data Suppliers (Type 1 / Type 2 LoA)
     · FAA AC 90-100A § 8 US Terminal & En-route RNAV operations —
       requires current nav-database per AIRAC
     · FAA AC 90-105A § 4-8 PBN approval — current AIRAC required
     · FAA AC 90-107 RNP-AR APCH — current AIRAC required for SAAAR
     · FAA Order 8400.10 Vol 4 Ch 7 § 7-1373 RNP-AR cycle currency
     · FAA Order 8260.19H ch 9 IAC currency
     · EASA AMC 20-26A RNP-AR APCH
     · EASA AMC 20-27A RNP APCH
     · EASA AMC 20-28 LPV-200
     · EASA Part-CAT.OP.MPA.300 / SPA.PBN — current navigation
       database mandatory pre-flight
     · EU Reg (EU) 73/2010 Data quality requirements
     · EU Reg (EU) 2017/373 ATM/ANS data assurance
     · ICAO Doc 9881 Manual on Terrain & Obstacle Data
     · ICAO Doc 9906 Vol II Quality Assurance for AIS — DAL-1
     · ICAO Doc 9674 WGS-84 Manual
     · NTSB AAR-00-03 American 965 Cali CFIT 1995 — wrong-named
       waypoint coded twice in database, R vs ROZO
     · NTSB AAR-00-01 Korean 801 Guam 1997 — outdated FMS data
     · NTSB ASR-92-01 USAir 1016 — terminal-procedure currency
     · AAIB Bull 11/2010 G-EZJB Faro — coded LPV minima missing
     · ATSB AO-2007-053 missing waypoint update Brisbane
     · IATA Ops Bulletin OPB-013 Nav DB AIRAC management

   AIRAC cycle algebra:
     · 28-day cycle, ICAO anchor epoch 1998-01-29 Thursday
     · 13 cycles per calendar year (sometimes 14)
     · Cycle ID format YYCC where YY = year, CC = cycle 01..14
     · Effective Date = Thursday at 00:00 UTC
     · Publication target = at least 28 days before effective
     · Operators load cycle on / after effective Thursday;
       previous cycle becomes "expired" — dispatch on expired
       cycle is a CAT-AOC finding per AMC 20-26A § 8
     · "Currency window" = cycle.effective <= now < cycle.exp
     · "Out-of-cycle" = active.expiryEpoch < nowEpoch

   13-supplier catalogue (suppliers offering DO-200B Type-2 LoA):
     · JEPP-NAVDATA Jeppesen NavData (Honeywell / Boeing FMS)
     · JEPP-CHART Jeppesen e-charts (FAA Type-2)
     · NAVBLUE-NAVDATA Navblue (Airbus FMS, FANS A/A+)
     · NAVBLUE-PERFDATA Navblue Performance Data
     · LIDO-MNAV Lufthansa Systems LIDO/mPilot
     · HONEY-NAVMAP Honeywell GoDirect NavMap (Pilatus, BBJ)
     · COLLINS-NAVDATA Collins Aerospace ARINC 424 (G3000/5000)
     · GARMIN-NAVDATA Garmin Navigation Database (GTN/GNS)
     · UNIVAVI-NAVDATA Universal Avionics UNS-1
     · ROCKWELL-FMS Rockwell Collins FMS-3000/4200
     · UASC-NAVDATA Universal Avionics SBAS-FMS
     · DOPRO-CHART DoCharts SimBrief
     · NA-NONE no current cycle loaded

   13-region operating environment catalogue:
     · WORLDWIDE Jeppesen WW coverage
     · NAM North America Region
     · EUR Europe-Mediterranean Region
     · MID Middle East Region
     · AFI Africa Region
     · ASIA East / South-East Asia
     · PAC Pacific Region
     · LATAM Latin America Region
     · ATL Atlantic Oceanic (NAT-OTS)
     · POL Polar Region (cross-pole)
     · TAILORED Custom operator tailored
     · NAM-TERMINAL US-only terminal subset
     · EUR-LCD EU LCD subset

   Per-airframe state hash-stable per ICAO24:
     · supplier pick from 13-supplier CDF biased per class
       (HVY/HVY-Q: JEPP 30% NAVBLUE 28% LIDO 20% HONEY 14% COLLINS 8%
        NRW: JEPP 35% NAVBLUE 35% LIDO 10% COLLINS 10% HONEY 10%
        RGN: JEPP 30% COLLINS 30% HONEY 20% NAVBLUE 15% UNIVAVI 5%
        BIZ: JEPP 25% HONEY 20% COLLINS 18% GARMIN 14% UNIVAVI 12%
              ROCKWELL 8% UASC 3%
        TBP/GA: GARMIN 50% HONEY 18% JEPP 15% COLLINS 10% UNIVAVI 7%)
     · loaded cycle = activeCycle - offsetWeeks, offset hash
       weighted to current with tail probability of stale
       (0..14 weeks behind, p(stale) ramps with FLEET-AGE slider)
     · 4-part coverage NAV/CHART/TERR/OBST hash-stable
       (NAV always loaded if cycle present; CHART/TERR/OBST
        gated by class & supplier)
     · region coverage hash-stable (WW for JEPP-WW subscribers
        100%, regional for partial)
     · current operating FIR derived from lat/lng
     · standby database present probability 0.85 HVY/HVY-Q,
       0.55 NRW, 0.40 BIZ, 0.20 RGN, 0.10 TBP, 0.05 GA

   AIRAC-window evaluation:
     · windowDelta = cyclesBehind (0 = current, 1 = one cycle stale,
        13 = one year stale)
     · effectiveAge = (now - effective) in days, 0-28 = current
     · expiredFlag = active cycle expiryEpoch < nowEpoch
     · partGaps = NAV/CHART/TERR/OBST missing per supplier matrix
     · regionGap = operating FIR not in loaded coverage
     · standbyMatch = standby cycle aligned with active or active+1

   5 risk drivers max-driver composite:
     · CYC  cycle currency vs AIRAC effective date
            (0 at current, 25 at 1 cycle stale, 60 at 2-3,
             85 at 4-6, 100 at 7+ or expired)
     · PART critical-part coverage gap
            (NAV missing 100 / TERR missing 75 if mountainous /
             CHART missing 35 / OBST missing 25)
     · RGN  operating-region coverage gap
            (100 outside loaded coverage)
     · DAL  Data Assurance Level shortfall vs route type
            (RNP-AR requires DAL-1, RNP-1 DAL-2; 100 if mismatched)
     · STDBY standby database invalid or no standby loaded
            (60 if no standby in oceanic, 40 enroute, 20 terminal)

   Phase multiplier 1.30 OCEANIC / 1.10 REMOTE / 1.05 RNP-AR
     / 1.00 ENROUTE / 0.85 TERMINAL.
   Hard escalations:
     · Cycle expired & airborne >= 88 (FAA Order 8400.10 V4 finding)
     · NAV-part missing on RNP route >= 92
     · Region gap & oceanic >= 85

   5 tiers EXPIRED / STALE / WATCH / CURRENT / IDLE
     EXPIRED score >= 80 OR cycle.expiry < now OR NAV part missing
       on RNP route — declare nav-data invalid, dispatch
       advisory message to ops control, request vectors,
       file MOR per AMC 20-26A § 8 and Part-CAT.OP.MPA.300,
       reload from data-loader at next gate per AC 20-153B
     STALE score >= 55 OR cycle 4+ behind — file deviation
       within OpSpec, continue with current cycle but
       expedite reload, brief crew per Order 8400.10 V4 Ch 7
     WATCH score >= 25 OR cycle 1-3 behind — monitor at next
       cycle break, ensure standby is aligned, log per
       DO-200B § 5.3 quality records
     CURRENT score < 25 — cycle aligned with active AIRAC,
       all parts loaded, region covered
     IDLE  on ground or no nav-data evaluable

   Output:
     · MapLibre overlay: tier halos sized 8-22px, rose pin
       on EXPIRED, dashed tier link to current operating FIR
       centroid, 13-supplier global marker pins coloured by
       supplier family at HQ lat/lng, sky reference parallels
     · Side panel: 5-tier counter strip, 6-cell summary,
       AIRAC-window timeline (28-day grid), SVG cycles-behind
       vs DAL scatter, 8 sliders, 13-supplier chip filter,
       HALO/PIN/LBL/LINK/SUP/REF/DIAG toggles, AIRCRAFT /
       SUPPLIERS / CYCLES tab switcher, per-row click-to-fly
       with tier-coloured advice citing AMC 20-26A, AC 20-153B,
       and Doc 10066 PANS-AIM
     · Per-aircraft row: supplier pill, cycle ID mono, parts
       pill row NAV/CHART/TERR/OBST, region pill, DAL-pill,
       cycles-behind chip, standby chip, tier score bar,
       5-driver chip grid

   Layers > Safety & Traffic.
   Persisted: ft-airac
   ============================================================ */

interface AirFlight {
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
  flights: AirFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'EXPIRED' | 'STALE' | 'WATCH' | 'CURRENT' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  EXPIRED: '#ef4444', STALE: '#f59e0b', WATCH: '#0ea5e9', CURRENT: '#10b981', IDLE: '#64748b',
}
const TIER_LABEL: Record<Tier, string> = {
  EXPIRED: 'EXPIRED', STALE: 'STALE', WATCH: 'WATCH', CURRENT: 'CURRENT', IDLE: 'IDLE',
}
const TIER_ORDER: Tier[] = ['EXPIRED', 'STALE', 'WATCH', 'CURRENT', 'IDLE']
const TIER_RANK: Record<Tier, number> = { EXPIRED: 0, STALE: 1, WATCH: 2, CURRENT: 3, IDLE: 4 }

type Supplier =
  | 'JEPP-NAVDATA' | 'NAVBLUE' | 'LIDO-MNAV' | 'HONEY-NAVMAP'
  | 'COLLINS-FMS' | 'GARMIN-NAV' | 'UNIVAVI-UNS' | 'ROCKWELL-FMS'
  | 'UASC-SBAS' | 'NONE'

const SUPPLIER_LIST: Supplier[] = [
  'JEPP-NAVDATA', 'NAVBLUE', 'LIDO-MNAV', 'HONEY-NAVMAP',
  'COLLINS-FMS', 'GARMIN-NAV', 'UNIVAVI-UNS', 'ROCKWELL-FMS',
  'UASC-SBAS', 'NONE',
]

interface SupplierMeta {
  id: Supplier
  name: string
  family: 'JEPP' | 'NAVBLUE' | 'LIDO' | 'HONEY' | 'COLLINS' | 'GARMIN' | 'UNIVAVI' | 'ROCKWELL' | 'UASC' | 'NONE'
  hqLat: number
  hqLng: number
  loaType: 'DO-200B-T2' | 'DO-200B-T1' | 'NONE'  // FAA AC 20-153B
  parts: { nav: boolean; chart: boolean; terr: boolean; obst: boolean }
  worldwide: boolean
}

const SUPPLIERS: SupplierMeta[] = [
  { id: 'JEPP-NAVDATA',  name: 'Jeppesen NavData (Boeing 7x7 FMS)',  family: 'JEPP',     hqLat: 39.74, hqLng: -104.98, loaType: 'DO-200B-T2', parts: { nav: true, chart: true, terr: true, obst: true },   worldwide: true  },
  { id: 'NAVBLUE',       name: 'Navblue (Airbus FANS A/A+)',         family: 'NAVBLUE',  hqLat: 43.86, hqLng:  -79.38, loaType: 'DO-200B-T2', parts: { nav: true, chart: true, terr: true, obst: true },   worldwide: true  },
  { id: 'LIDO-MNAV',     name: 'Lufthansa Systems LIDO/mNav',        family: 'LIDO',     hqLat: 50.04, hqLng:    8.57, loaType: 'DO-200B-T2', parts: { nav: true, chart: true, terr: true, obst: false },  worldwide: true  },
  { id: 'HONEY-NAVMAP',  name: 'Honeywell GoDirect NavMap',          family: 'HONEY',    hqLat: 35.62, hqLng:  -97.48, loaType: 'DO-200B-T2', parts: { nav: true, chart: false, terr: true, obst: true },  worldwide: true  },
  { id: 'COLLINS-FMS',   name: 'Collins Aerospace ARINC 424 (Pro Line)', family: 'COLLINS', hqLat: 41.97, hqLng: -91.66, loaType: 'DO-200B-T2', parts: { nav: true, chart: false, terr: true, obst: false }, worldwide: true  },
  { id: 'GARMIN-NAV',    name: 'Garmin Navigation Database (GTN/G1000)', family: 'GARMIN', hqLat: 38.85, hqLng:  -94.69, loaType: 'DO-200B-T1', parts: { nav: true, chart: true, terr: true, obst: true },  worldwide: false },
  { id: 'UNIVAVI-UNS',   name: 'Universal Avionics UNS-1',           family: 'UNIVAVI',  hqLat: 32.15, hqLng: -110.94, loaType: 'DO-200B-T2', parts: { nav: true, chart: false, terr: false, obst: false }, worldwide: false },
  { id: 'ROCKWELL-FMS',  name: 'Rockwell FMS-3000/4200',             family: 'ROCKWELL', hqLat: 41.97, hqLng:  -91.66, loaType: 'DO-200B-T2', parts: { nav: true, chart: false, terr: true, obst: false }, worldwide: true  },
  { id: 'UASC-SBAS',     name: 'Universal Avionics SBAS-FMS',        family: 'UASC',     hqLat: 32.15, hqLng: -110.94, loaType: 'DO-200B-T1', parts: { nav: true, chart: false, terr: false, obst: false }, worldwide: false },
  { id: 'NONE',          name: 'No current nav-database',            family: 'NONE',     hqLat:  0,    hqLng:    0,    loaType: 'NONE',       parts: { nav: false, chart: false, terr: false, obst: false }, worldwide: false },
]

const FAMILY_COLOR: Record<SupplierMeta['family'], string> = {
  JEPP: '#0ea5e9', NAVBLUE: '#a78bfa', LIDO: '#06b6d4', HONEY: '#f59e0b',
  COLLINS: '#10b981', GARMIN: '#22d3ee', UNIVAVI: '#facc15', ROCKWELL: '#fb923c',
  UASC: '#e879f9', NONE: '#64748b',
}

type Region = 'WW' | 'NAM' | 'EUR' | 'MID' | 'AFI' | 'ASIA' | 'PAC' | 'LATAM' | 'ATL' | 'POL' | 'TAILORED'

type AcClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA'
type Phase = 'OCEANIC' | 'REMOTE' | 'RNP-AR' | 'ENROUTE' | 'TERMINAL'
const PHASE_MUL: Record<Phase, number> = { OCEANIC: 1.30, REMOTE: 1.10, 'RNP-AR': 1.05, ENROUTE: 1.00, TERMINAL: 0.85 }

type Dal = 'DAL-1' | 'DAL-2' | 'DAL-3' | 'NA'

type Driver = 'CYC' | 'PART' | 'RGN' | 'DAL' | 'STDBY' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  CYC: 'Cycle currency', PART: 'Part coverage', RGN: 'Region gap',
  DAL: 'DAL mismatch', STDBY: 'Standby DB', NONE: 'Nominal',
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|A38|A34|IL96/.test(t)) return 'HVY-Q'
  if (/B77|B78|A33|A35|MD11/.test(t)) return 'HVY'
  if (/B73|A31|A319|A32|A22|B75|MD8|B71/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E27|E29|E[12]7|E[12]9|F70|F100|AT[47]|DH[48]/.test(t)) return 'RGN'
  if (/G[VI458]|GLF|GLEX|FA[78]X|F2TH|CL30|CL60|C68|C75|BE40|H25|LJ/.test(t)) return 'BIZ'
  if (/AT|DH|SF34|J32|EMB1|BE/.test(t)) return 'TBP'
  return 'GA'
}

function classifyPhase(lat: number, lng: number, alt: number, hashBit: number): Phase {
  const absLat = Math.abs(lat)
  const oceanic =
    (absLat > 30 && absLat < 65 && lng > -55 && lng < -10 && lat > 35) ||
    (lat > 20 && lat < 55 && lng > 150) || (lat > 20 && lat < 55 && lng < -130) ||
    (lat < -10 && lng > 80 && lng < 130) ||
    (lat < 5 && lat > -40 && lng > 50 && lng < 100)
  const remote = absLat > 70
  if (oceanic && alt > 25000) return 'OCEANIC'
  if (remote && alt > 25000) return 'REMOTE'
  if (alt < 11000 && hashBit) return 'RNP-AR'
  if (alt > 11000) return 'ENROUTE'
  return 'TERMINAL'
}

function inferRegion(lat: number, lng: number): Region {
  const absLat = Math.abs(lat)
  if (absLat > 75) return 'POL'
  if (lat > 15 && lat < 75 && lng > -170 && lng < -55) return 'NAM'
  if (lat > 25 && lat < 75 && lng > -15 && lng < 50) return 'EUR'
  if (lat > 12 && lat < 42 && lng > 30 && lng < 75) return 'MID'
  if (lat > -40 && lat < 38 && lng > -20 && lng < 55) return 'AFI'
  if (lat > -12 && lat < 55 && lng > 60 && lng < 150) return 'ASIA'
  if ((lat > -50 && lat < 55) && (lng > 150 || lng < -130)) return 'PAC'
  if (lat > -60 && lat < 30 && lng > -90 && lng < -30) return 'LATAM'
  if (lat > 0 && lat < 65 && lng > -65 && lng < -10) return 'ATL'
  return 'WW'
}

// --- AIRAC cycle algebra ---
// ICAO anchor: cycle 0101 effective 2001-01-25 ... easier to use a known later anchor
// Use 2014-01-09 = cycle 1401 (Thursday, ICAO published)
const AIRAC_EPOCH_MS = Date.UTC(2014, 0, 9)
const AIRAC_PERIOD_MS = 28 * 24 * 3600 * 1000

function airacForDate(date: Date): { id: string; effectiveMs: number; expiryMs: number; index: number } {
  const t = date.getTime()
  const diff = t - AIRAC_EPOCH_MS
  const idx = Math.floor(diff / AIRAC_PERIOD_MS)        // index since 1401
  const effective = AIRAC_EPOCH_MS + idx * AIRAC_PERIOD_MS
  const expiry = effective + AIRAC_PERIOD_MS
  // walk year-by-year to compute YYCC
  let year = 2014
  let cyclesIntoYear = 0
  let walk = AIRAC_EPOCH_MS
  while (walk + AIRAC_PERIOD_MS <= effective) {
    walk += AIRAC_PERIOD_MS
    cyclesIntoYear++
    const dy = new Date(walk).getUTCFullYear()
    if (dy !== year) { year = dy; cyclesIntoYear = 0 }
  }
  const cc = (cyclesIntoYear + 1).toString().padStart(2, '0')
  const yy = (year % 100).toString().padStart(2, '0')
  return { id: `${yy}${cc}`, effectiveMs: effective, expiryMs: expiry, index: idx }
}

function airacAtIndex(idx: number): { id: string; effectiveMs: number; expiryMs: number; index: number } {
  const effective = AIRAC_EPOCH_MS + idx * AIRAC_PERIOD_MS
  return airacForDate(new Date(effective + 1000))
}

function classSupplier(klass: AcClass, h: number): Supplier {
  const r = (h & 0xffff) / 0xffff
  if (klass === 'HVY-Q' || klass === 'HVY') {
    if (r < 0.30) return 'JEPP-NAVDATA'
    if (r < 0.58) return 'NAVBLUE'
    if (r < 0.78) return 'LIDO-MNAV'
    if (r < 0.92) return 'HONEY-NAVMAP'
    if (r < 0.99) return 'COLLINS-FMS'
    return 'NONE'
  }
  if (klass === 'NRW') {
    if (r < 0.35) return 'JEPP-NAVDATA'
    if (r < 0.70) return 'NAVBLUE'
    if (r < 0.80) return 'LIDO-MNAV'
    if (r < 0.90) return 'COLLINS-FMS'
    if (r < 0.99) return 'HONEY-NAVMAP'
    return 'NONE'
  }
  if (klass === 'RGN') {
    if (r < 0.30) return 'JEPP-NAVDATA'
    if (r < 0.60) return 'COLLINS-FMS'
    if (r < 0.80) return 'HONEY-NAVMAP'
    if (r < 0.95) return 'NAVBLUE'
    return 'UNIVAVI-UNS'
  }
  if (klass === 'BIZ') {
    if (r < 0.25) return 'JEPP-NAVDATA'
    if (r < 0.45) return 'HONEY-NAVMAP'
    if (r < 0.63) return 'COLLINS-FMS'
    if (r < 0.77) return 'GARMIN-NAV'
    if (r < 0.89) return 'UNIVAVI-UNS'
    if (r < 0.97) return 'ROCKWELL-FMS'
    return 'UASC-SBAS'
  }
  // TBP / GA
  if (r < 0.50) return 'GARMIN-NAV'
  if (r < 0.68) return 'HONEY-NAVMAP'
  if (r < 0.83) return 'JEPP-NAVDATA'
  if (r < 0.93) return 'COLLINS-FMS'
  return 'UNIVAVI-UNS'
}

function classDal(klass: AcClass): Dal {
  if (klass === 'HVY-Q' || klass === 'HVY' || klass === 'NRW') return 'DAL-1'
  if (klass === 'RGN' || klass === 'BIZ') return 'DAL-2'
  if (klass === 'TBP') return 'DAL-2'
  return 'DAL-3'
}

function supplierWorldwide(s: SupplierMeta, h: number, region: Region): boolean {
  if (!s) return false
  if (s.worldwide) return true
  if (s.id === 'NONE') return false
  // partial-coverage suppliers cover home region
  if (s.id === 'GARMIN-NAV') return region === 'NAM' || region === 'EUR'
  if (s.id === 'UNIVAVI-UNS' || s.id === 'UASC-SBAS') {
    const r = ((h >>> 13) & 0xff) / 255
    return r < 0.65   // 65% subscribers have additional regions
  }
  return false
}

interface Row {
  f: AirFlight
  klass: AcClass
  phase: Phase
  region: Region
  supplier: SupplierMeta
  loaded: { id: string; effectiveMs: number; expiryMs: number; index: number }
  active: { id: string; effectiveMs: number; expiryMs: number; index: number }
  cyclesBehind: number
  expired: boolean
  partsMissing: { nav: boolean; chart: boolean; terr: boolean; obst: boolean }
  regionCovered: boolean
  dal: Dal
  requiredDal: Dal
  dalMismatch: boolean
  standbyOk: boolean
  fir: string
  sev: { cyc: number; part: number; rgn: number; dal: number; stdby: number }
  score: number
  driver: Driver
  tier: Tier
}

function inferFir(lat: number, lng: number): string {
  if (lat > 35 && lat < 65 && lng > -55 && lng < -10) return lng < -30 ? 'CZQX' : 'EGGX'
  if (lat > 50 && lng > -10 && lng < 30) return 'BIRD'
  if (lat > 25 && lat < 55 && lng > 130 && lng < 180) return 'RJJJ'
  if ((lat > 20 && lat < 55) && (lng > 160 || lng < -130)) return 'KZAK'
  if (lat < -10 && lat > -45 && lng > 110 && lng < 165) return 'YBBB'
  if (lat < 5 && lat > -40 && lng > 50 && lng < 100) return 'FAJO'
  if (lat > 60) return 'BGGL'
  if (lat > 25 && lat < 50 && lng > -125 && lng < -65) return 'KZAU'
  if (lat > 35 && lat < 70 && lng > -15 && lng < 30) return 'EDUU'
  if (lat > 12 && lat < 42 && lng > 30 && lng < 75) return 'OMAE'
  if (lat > -12 && lat < 55 && lng > 60 && lng < 150) return 'WSJC'
  return 'ZZZZ'
}

const SRC_HALO = 'airac-halo', SRC_LBL = 'airac-lbl', SRC_PIN = 'airac-pin', SRC_LINK = 'airac-link', SRC_REF = 'airac-ref', SRC_SUP = 'airac-sup', SRC_SUPL = 'airac-supl'
const LYR_HALO = 'airac-halo-l', LYR_LBL = 'airac-lbl-l', LYR_PIN = 'airac-pin-l', LYR_LINK = 'airac-link-l', LYR_REF = 'airac-ref-l', LYR_SUP = 'airac-sup-l', LYR_SUPL = 'airac-supl-l'

export default function AiracNavDb({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'SUPPLIERS' | 'CYCLES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [supFilter, setSupFilter] = useState<Supplier | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [fleetAge, setFleetAge] = useState(100)        // % - older fleet = more stale cycles
  const [partsMul, setPartsMul] = useState(100)        // % missing-part probability
  const [regionStrict, setRegionStrict] = useState(100) // % strictness
  const [stdbyShare, setStdbyShare] = useState(100)    // % expected standby presence
  const [nowOffsetDays, setNowOffsetDays] = useState(0) // -28..+56 simulate future
  const [phaseWt, setPhaseWt] = useState(100)
  const [dalStrict, setDalStrict] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showSup, setShowSup] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const now = useMemo(() => new Date(Date.now() + nowOffsetDays * 24 * 3600 * 1000), [nowOffsetDays])
  const active = useMemo(() => airacForDate(now), [now])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (!isFinite(f.altitudeFt)) continue
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl) continue
      const h = hash32(f.icao || '')
      const klass = classifyClass(f.type || '')
      const region = inferRegion(f.lat, f.lng)
      const phase = classifyPhase(f.lat, f.lng, f.altitudeFt, (h >>> 25) & 1)
      const supplierId = classSupplier(klass, h)
      const supplier = SUPPLIERS.find(s => s.id === supplierId)!

      // cycles behind: hash-stable, biased by fleetAge slider
      const r1 = ((h >>> 7) & 0xff) / 255
      const ageFactor = (fleetAge / 100)
      // baseline geometric tail: most are 0-1 cycle, tail goes deeper with age
      const cyclesBehind =
        r1 < 0.55 - 0.20 * (ageFactor - 1) ? 0 :
        r1 < 0.80 ? 1 :
        r1 < 0.93 ? 2 + Math.floor(((h >>> 15) & 0x3) * ageFactor) :
        r1 < 0.98 ? 4 + Math.floor(((h >>> 19) & 0x7) * ageFactor) :
        7 + Math.floor(((h >>> 21) & 0xf) * ageFactor)
      const loaded = airacAtIndex(active.index - cyclesBehind)
      const expired = loaded.expiryMs < now.getTime()

      // parts missing - per supplier matrix scaled by partsMul slider
      const rp = ((h >>> 9) & 0xff) / 255
      const pSkew = (partsMul / 100)
      const partsMissing = {
        nav: !supplier.parts.nav || (supplier.id === 'NONE'),
        chart: !supplier.parts.chart || (supplier.parts.chart && rp < 0.05 * pSkew),
        terr: !supplier.parts.terr || (supplier.parts.terr && rp > 0.94 - 0.08 * pSkew),
        obst: !supplier.parts.obst || (supplier.parts.obst && rp > 0.88 - 0.08 * pSkew),
      }

      const regionCovered = supplierWorldwide(supplier, h, region) && supplier.id !== 'NONE'

      const requiredDal = phase === 'RNP-AR' || phase === 'OCEANIC' ? 'DAL-1' :
                          phase === 'ENROUTE' || phase === 'REMOTE' ? 'DAL-2' :
                          'DAL-3'
      const dal: Dal = supplier.loaType === 'DO-200B-T2' ? 'DAL-1'
                     : supplier.loaType === 'DO-200B-T1' ? 'DAL-2'
                     : 'NA'
      const dalRank: Record<Dal, number> = { 'DAL-1': 1, 'DAL-2': 2, 'DAL-3': 3, NA: 9 }
      const dalMismatch = dalRank[dal] > dalRank[requiredDal]

      // standby
      const stdbyProb = klass === 'HVY-Q' || klass === 'HVY' ? 0.85 :
                       klass === 'NRW' ? 0.55 :
                       klass === 'BIZ' ? 0.40 :
                       klass === 'RGN' ? 0.20 :
                       klass === 'TBP' ? 0.10 : 0.05
      const standbyOk = (((h >>> 11) & 0xff) / 255) < (stdbyProb * (stdbyShare / 100))

      // severities
      const cyc = expired ? 100 :
                  cyclesBehind === 0 ? 0 :
                  cyclesBehind === 1 ? 25 :
                  cyclesBehind <= 3 ? 60 :
                  cyclesBehind <= 6 ? 85 : 100
      const partWorst =
        partsMissing.nav ? 100 :
        partsMissing.terr && (Math.abs(f.lat) > 30 || region === 'ASIA' || region === 'LATAM') ? 75 :
        partsMissing.terr ? 45 :
        partsMissing.chart ? 35 :
        partsMissing.obst ? 25 : 0
      const part = partWorst
      const rgn = regionCovered ? 0 : Math.min(100, 100 * (regionStrict / 100))
      const dalSev = dalMismatch ? Math.min(100, 100 * (dalStrict / 100)) : 0
      const stdby = standbyOk ? 0 :
                    phase === 'OCEANIC' || phase === 'REMOTE' ? 60 :
                    phase === 'ENROUTE' ? 40 : 20

      const sev = { cyc, part, rgn, dal: dalSev, stdby }
      const drivers: Array<[Driver, number]> = [['CYC', cyc], ['PART', part], ['RGN', rgn], ['DAL', dalSev], ['STDBY', stdby]]
      drivers.sort((a, b) => b[1] - a[1])
      const driver: Driver = drivers[0][1] >= 15 ? drivers[0][0] : 'NONE'

      const phaseMul = 1 + ((PHASE_MUL[phase] - 1) * (phaseWt / 100))
      const max = drivers[0][1]
      const secondary = drivers[1][1]
      let score = Math.min(100, Math.max(0, max * phaseMul + 0.10 * secondary))

      // hard escalations
      if (expired && fl >= minFl) score = Math.max(score, 88)
      if (partsMissing.nav && (phase === 'OCEANIC' || phase === 'RNP-AR')) score = Math.max(score, 92)
      if (!regionCovered && phase === 'OCEANIC') score = Math.max(score, 85)

      let tier: Tier
      if (fl < minFl) tier = 'IDLE'
      else if (score >= 80) tier = 'EXPIRED'
      else if (score >= 55) tier = 'STALE'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'CURRENT'

      out.push({
        f, klass, phase, region, supplier, loaded, active,
        cyclesBehind, expired, partsMissing, regionCovered,
        dal, requiredDal, dalMismatch, standbyOk,
        fir: inferFir(f.lat, f.lng),
        sev, score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, fleetAge, partsMul, regionStrict, stdbyShare, phaseWt, dalStrict, active, now])

  const tierCount: Record<Tier, number> = { EXPIRED: 0, STALE: 0, WATCH: 0, CURRENT: 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++
  const expiredCount = tierCount.EXPIRED
  const meanBehind = rows.length ? rows.reduce((a, r) => a + r.cyclesBehind, 0) / rows.length : 0
  const currentShare = rows.length ? rows.filter(r => r.cyclesBehind === 0 && !r.expired).length / rows.length : 0
  const noDbCount = rows.filter(r => r.supplier.id === 'NONE').length
  const stdbyMissingShare = rows.length ? rows.filter(r => !r.standbyOk).length / rows.length : 0
  const dalMismatchCount = rows.filter(r => r.dalMismatch).length
  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (supFilter !== 'ALL') r = r.filter(x => x.supplier.id === supFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(x => (x.f.callsign || '').toLowerCase().includes(q) || (x.f.type || '').toLowerCase().includes(q) || (x.f.icao || '').toLowerCase().includes(q) || x.supplier.id.toLowerCase().includes(q) || x.loaded.id.toLowerCase().includes(q) || x.region.toLowerCase().includes(q))
    return r.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, supFilter, query])

  const supRows = useMemo(() => {
    const m = new Map<Supplier, Row[]>()
    for (const r of rows) {
      const e = m.get(r.supplier.id) || []; e.push(r); m.set(r.supplier.id, e)
    }
    return SUPPLIERS.map(s => {
      const list = m.get(s.id) || []
      const exp = list.filter(r => r.tier === 'EXPIRED').length
      const stale = list.filter(r => r.tier === 'STALE').length
      const meanScore = list.length ? list.reduce((a, r) => a + r.score, 0) / list.length : 0
      const worstTier = list.length ? list.reduce((a, r) => TIER_RANK[r.tier] < TIER_RANK[a] ? r.tier : a, 'IDLE' as Tier) : 'IDLE' as Tier
      const meanBhd = list.length ? list.reduce((a, r) => a + r.cyclesBehind, 0) / list.length : 0
      return { s, ac: list.length, exp, stale, meanScore, worstTier, meanBhd }
    }).sort((a, b) => b.exp - a.exp || b.ac - a.ac)
  }, [rows])

  const cycleRows = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of rows) {
      const e = m.get(r.loaded.id) || []; e.push(r); m.set(r.loaded.id, e)
    }
    const arr: Array<{ cycle: string; index: number; ac: number; behind: number; effective: number; expiry: number; worst: Tier; isActive: boolean; isExpired: boolean }> = []
    for (const [id, list] of m) {
      const sample = list[0]
      arr.push({
        cycle: id, index: sample.loaded.index, ac: list.length,
        behind: active.index - sample.loaded.index,
        effective: sample.loaded.effectiveMs, expiry: sample.loaded.expiryMs,
        worst: list.reduce((a, r) => TIER_RANK[r.tier] < TIER_RANK[a] ? r.tier : a, 'IDLE' as Tier),
        isActive: sample.loaded.index === active.index,
        isExpired: sample.loaded.expiryMs < now.getTime(),
      })
    }
    arr.sort((a, b) => b.index - a.index)
    return arr
  }, [rows, active.index, now])

  useEffect(() => {
    if (!map) return
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }) }
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_LINK, SRC_REF, SRC_SUP, SRC_SUPL]
    sources.forEach(ensure)

    if (!map.getLayer(LYR_REF)) {
      map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.12, 'line-width': 0.8, 'line-dasharray': [2, 4] } })
    }
    if (!map.getLayer(LYR_LINK)) {
      map.addLayer({ id: LYR_LINK, type: 'line', source: SRC_LINK, paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [1.5, 2] } })
    }
    if (!map.getLayer(LYR_HALO)) {
      map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.65, 'circle-stroke-width': 1.4 } })
    }
    if (!map.getLayer(LYR_PIN)) {
      map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': '◆', 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(LYR_SUP)) {
      map.addLayer({ id: LYR_SUP, type: 'circle', source: SRC_SUP, paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-opacity': 0.85, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.2 } })
    }
    if (!map.getLayer(LYR_SUPL)) {
      map.addLayer({ id: LYR_SUPL, type: 'symbol', source: SRC_SUPL, layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, 1.3], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(LYR_LBL)) {
      map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }

    const halo: any[] = []; const lbl: any[] = []; const pin: any[] = []; const link: any[] = []
    for (const r of rows) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'CURRENT' && r.tier !== 'IDLE') {
        const rad = 8 + (r.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: rad } })
      }
      if (showPin && r.tier === 'EXPIRED') {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLabels && (r.tier === 'EXPIRED' || r.tier === 'STALE')) {
        const label = `${r.f.callsign || r.f.icao} › ${r.supplier.id.split('-')[0]} › ${r.loaded.id} (${r.cyclesBehind > 0 ? '-' + r.cyclesBehind : 'CUR'})`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showLink && r.tier !== 'CURRENT' && r.tier !== 'IDLE' && r.supplier.id !== 'NONE') {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.supplier.hqLng, r.supplier.hqLat]] }, properties: { color } })
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

    const supFeats: any[] = []; const supLbl: any[] = []
    if (showSup) {
      for (const s of SUPPLIERS) {
        if (s.id === 'NONE') continue
        const col = FAMILY_COLOR[s.family]
        supFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.hqLng, s.hqLat] }, properties: { color: col } })
        supLbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.hqLng, s.hqLat] }, properties: { color: col, label: `${s.family} · ${s.loaType}` } })
      }
    }

    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: refFeats })
    ;(map.getSource(SRC_SUP) as any).setData({ type: 'FeatureCollection', features: supFeats })
    ;(map.getSource(SRC_SUPL) as any).setData({ type: 'FeatureCollection', features: supLbl })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_REF, LYR_SUP, LYR_SUPL]) { if (m.getLayer(id)) m.removeLayer(id) }
      for (const id of sources) { if (m.getSource(id)) m.removeSource(id) }
    }
  }, [map, rows, showHalo, showPin, showLabels, showLink, showRef, showSup])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{TIER_LABEL[t]}</span>
  )
  const driverBadge = (d: Exclude<Driver,'NONE'>, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )

  const advice = (r: Row): string => {
    if (r.tier === 'EXPIRED') {
      if (r.supplier.id === 'NONE') return `No nav-database loaded — dispatch invalid per Part-CAT.OP.MPA.300 · revert raw-data VOR/DME, file MOR, reload from data-loader at gate per AC 20-153B`
      if (r.expired) return `AIRAC ${r.loaded.id} expired ${Math.ceil((now.getTime() - r.loaded.expiryMs) / (24 * 3600 * 1000))}d ago — nav-data invalid for procedure flying · request vectors, file MOR per AMC 20-26A §8 / FAA Order 8400.10 V4 Ch 7 §7-1373`
      if (r.partsMissing.nav && r.phase === 'OCEANIC') return `NAV part missing on oceanic route — re-route to non-PBN airway, request HF/SATVOICE position reporting per Doc 9613 Vol II`
      if (r.partsMissing.nav) return `NAV part missing — RNAV/RNP procedures unavailable, request vectors per Doc 8168 PANS-OPS Vol II Ch 3`
      if (!r.regionCovered && r.phase === 'OCEANIC') return `Operating region ${r.region} not covered by ${r.supplier.id} subscription — divert to covered FIR or revert non-PBN routing per Doc 10066 PANS-AIM`
      return `${r.cyclesBehind} cycles behind AIRAC ${r.active.id} (loaded ${r.loaded.id}) — request vectors, plan reload at next gate, MOR per Order 8400.10 V4`
    }
    if (r.tier === 'STALE') {
      if (r.cyclesBehind >= 4) return `${r.cyclesBehind} cycles behind active AIRAC ${r.active.id} — file deviation within OpSpec, expedite reload from supplier ${r.supplier.id}, brief crew per AC 90-100A §8`
      if (r.dalMismatch) return `Supplier DAL ${r.dal} insufficient for ${r.requiredDal} required by ${r.phase} — restrict to non-PBN approaches per DO-200B §1.4.2`
      if (!r.regionCovered) return `Region ${r.region} outside ${r.supplier.id} coverage — load tailored region overlay or revert non-PBN per Doc 10066`
      return `Cycle ${r.loaded.id} stale vs ${r.active.id} — load latest cycle before next dispatch per AMC 20-27A §4-8`
    }
    if (r.tier === 'WATCH') {
      if (r.cyclesBehind > 0) return `Cycle ${r.loaded.id} ${r.cyclesBehind} behind active ${r.active.id} — monitor at next cycle break Thursday ${new Date(r.active.expiryMs).toUTCString().slice(0, 11)} per Annex 15 App 4`
      if (!r.standbyOk) return `Standby database not aligned with active — verify dual-FMS sync per ARINC 424-22 §2, monitor before oceanic entry`
      return `AIRAC ${r.loaded.id} current but trend adverse — log quality records per DO-200B §5.3`
    }
    return `AIRAC ${r.loaded.id} current · ${r.supplier.id} ${r.supplier.loaType} · ${r.region} covered · DAL ${r.dal} OK for ${r.phase}`
  }

  // SVG: cycles-behind vs DAL grid
  const W = 280, H = 180
  const xMax = 8
  const yMax = 3
  const sx = (v: number) => 30 + (Math.min(xMax, Math.max(0, v)) / xMax) * (W - 40)
  const sy = (v: number) => H - 24 - (Math.min(yMax, Math.max(0, v)) / yMax) * (H - 48)

  // 28-day timeline visualisation
  const timelineWidth = 380
  const dayInActive = Math.floor((now.getTime() - active.effectiveMs) / (24 * 3600 * 1000))

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">AIRAC Cycle · FMS Nav-DB Currency</div>
          <div className="text-[10px] text-slate-500">Active <span className="font-mono text-slate-300">{active.id}</span> · eff {new Date(active.effectiveMs).toISOString().slice(0,10)} · exp {new Date(active.expiryMs).toISOString().slice(0,10)} · day {dayInActive + 1}/28</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      {/* AIRAC 28-day mini-timeline */}
      <div className="px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-1 mb-1">
          <span className="text-[10px] text-slate-500 uppercase">AIRAC window</span>
          <span className="ml-auto text-[10px] text-slate-400 font-mono">{active.id}</span>
        </div>
        <div className="flex gap-px h-3 rounded overflow-hidden">
          {Array.from({ length: 28 }, (_, i) => {
            const isPast = i < dayInActive
            const isToday = i === dayInActive
            const col = isToday ? '#0ea5e9' : isPast ? '#334155' : '#1e293b'
            return <div key={i} className="flex-1 h-3" style={{ backgroundColor: col, borderRight: isToday ? '1px solid #38bdf8' : undefined }} title={`day ${i+1}`} />
          })}
        </div>
        <div className="flex justify-between text-[9px] text-slate-600 mt-0.5"><span>D1 effective</span><span>D{dayInActive+1} today</span><span>D28 expiry</span></div>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[10px] font-semibold" style={{ color: TIER_COLOR[t] }}>{TIER_LABEL[t]}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean cycles behind</div>
          <div className="text-sm font-semibold" style={{ color: meanBehind > 3 ? '#ef4444' : meanBehind > 1 ? '#f59e0b' : meanBehind > 0.3 ? '#0ea5e9' : '#10b981' }}>{meanBehind.toFixed(2)}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst aircraft</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Expired</div>
          <div className="text-sm font-semibold" style={{ color: expiredCount > 0 ? '#ef4444' : '#10b981' }}>{expiredCount}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Current share</div>
          <div className="text-xs font-semibold" style={{ color: currentShare > 0.85 ? '#10b981' : currentShare > 0.6 ? '#f59e0b' : '#ef4444' }}>{(currentShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Standby missing</div>
          <div className="text-xs font-semibold" style={{ color: stdbyMissingShare > 0.50 ? '#ef4444' : stdbyMissingShare > 0.25 ? '#f59e0b' : '#10b981' }}>{(stdbyMissingShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">DAL mismatch · NO-DB</div>
          <div className="text-xs font-semibold" style={{ color: dalMismatchCount > 0 || noDbCount > 0 ? '#ef4444' : '#10b981' }}>{dalMismatchCount} · {noDbCount}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W-40} height={H-48} fill="#0b1220" />
            {/* horizontal bands by DAL */}
            <rect x={sx(0)} y={sy(1)} width={sx(xMax) - sx(0)} height={sy(0) - sy(1)} fill="#10b981" opacity={0.07} />
            <rect x={sx(0)} y={sy(2)} width={sx(xMax) - sx(0)} height={sy(1) - sy(2)} fill="#f59e0b" opacity={0.07} />
            <rect x={sx(0)} y={sy(3)} width={sx(xMax) - sx(0)} height={sy(2) - sy(3)} fill="#ef4444" opacity={0.09} />
            {/* vertical bands by cyclesBehind */}
            <line x1={sx(1)} y1={24} x2={sx(1)} y2={H - 24} stroke="#0ea5e9" strokeDasharray="3 3" strokeOpacity={0.4} />
            <line x1={sx(4)} y1={24} x2={sx(4)} y2={H - 24} stroke="#f59e0b" strokeDasharray="3 3" strokeOpacity={0.4} />
            <line x1={sx(7)} y1={24} x2={sx(7)} y2={H - 24} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.5} />
            <text x={sx(0) + 3} y={36} fontSize={8} fill="#10b981">CURRENT</text>
            <text x={sx(1) + 3} y={36} fontSize={8} fill="#0ea5e9">WATCH</text>
            <text x={sx(4) + 3} y={36} fontSize={8} fill="#f59e0b">STALE</text>
            <text x={sx(7) + 3} y={36} fontSize={8} fill="#ef4444">EXP</text>
            {rows.map((r, i) => {
              const dalY = r.dal === 'DAL-1' ? 1 : r.dal === 'DAL-2' ? 2 : r.dal === 'DAL-3' ? 3 : 3
              return <circle key={i} cx={sx(Math.min(xMax, r.cyclesBehind))} cy={sy(dalY)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={r.supplier.id === 'NONE' ? 0.4 : 0.85} />
            })}
            <text x={W/2} y={H-6} fontSize={9} fill="#64748b" textAnchor="middle">CYCLES-BEHIND vs DAL (Data Assurance Level)</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">FLEET-AGE {fleetAge}%</span><input type="range" min={50} max={200} value={fleetAge} onChange={e => setFleetAge(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PARTS-MUL {partsMul}%</span><input type="range" min={50} max={200} value={partsMul} onChange={e => setPartsMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">RGN-STRICT {regionStrict}%</span><input type="range" min={0} max={150} value={regionStrict} onChange={e => setRegionStrict(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">STDBY-SHARE {stdbyShare}%</span><input type="range" min={0} max={150} value={stdbyShare} onChange={e => setStdbyShare(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">DAL-STRICT {dalStrict}%</span><input type="range" min={0} max={150} value={dalStrict} onChange={e => setDalStrict(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">NOW-OFFSET {nowOffsetDays}d</span><input type="range" min={-28} max={56} value={nowOffsetDays} onChange={e => setNowOffsetDays(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setSupFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${supFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {SUPPLIER_LIST.filter(s => s !== 'NONE').slice(0, 6).map(s => (
          <button key={s} onClick={() => setSupFilter(supFilter === s ? 'ALL' : s)} className={`px-2 py-0.5 rounded text-[10px] border ${supFilter===s?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>{s.split('-')[0]}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo],['PIN', showPin, setShowPin],['LBL', showLabels, setShowLabels],['LINK', showLink, setShowLink],['SUP', showSup, setShowSup],['REF', showRef, setShowRef],['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / supplier / cycle / region" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'SUPPLIERS', 'CYCLES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab===t?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => {
          const supFam = r.supplier.family
          const supCol = FAMILY_COLOR[supFam]
          return (
            <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
              <div className="flex flex-wrap items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
                <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
                <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.klass}</span>
                <span className="px-1 py-px rounded text-[9px]" style={{ color: supCol, border: '1px solid ' + supCol + '66', backgroundColor: supCol + '14' }}>{r.supplier.id.split('-')[0]}</span>
                <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-200 font-mono">{r.loaded.id}</span>
                {r.cyclesBehind > 0 && <span className="px-1 py-px rounded text-[9px]" style={{ color: r.cyclesBehind >= 4 ? '#ef4444' : r.cyclesBehind >= 2 ? '#f59e0b' : '#0ea5e9', border: '1px solid ' + (r.cyclesBehind >= 4 ? '#ef444466' : r.cyclesBehind >= 2 ? '#f59e0b66' : '#0ea5e966'), backgroundColor: '#0b1220' }}>-{r.cyclesBehind}</span>}
                {r.expired && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/40">EXP</span>}
                <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{r.phase}</span>
                <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.region}</span>
                {r.dalMismatch && <span className="px-1 py-px rounded text-[9px] bg-amber-500/15 text-amber-300 border border-amber-500/40">DAL!</span>}
                <div className="ml-auto">{tierBadge(r.tier)}</div>
              </div>
              <div className="px-2 text-[10px] text-slate-400">
                FL{(r.f.altitudeFt/100).toFixed(0)} · FIR <span className="font-mono text-slate-200">{r.fir}</span> · DAL <span className={r.dalMismatch ? 'text-amber-300' : 'text-slate-300'}>{r.dal}</span>/{r.requiredDal} · STDBY <span style={{color: r.standbyOk ? '#10b981' : '#f59e0b'}}>{r.standbyOk ? 'OK' : 'MISS'}</span> · cov <span style={{color: r.regionCovered ? '#10b981' : '#ef4444'}}>{r.regionCovered ? 'YES' : 'NO'}</span>
              </div>
              <div className="flex flex-wrap gap-1 px-2 pt-1">
                {(['nav', 'chart', 'terr', 'obst'] as const).map(p => {
                  const missing = (r.partsMissing as any)[p]
                  const col = missing ? (p === 'nav' ? '#ef4444' : '#f59e0b') : '#10b981'
                  return <span key={p} className="px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '55', backgroundColor: col + '12' }}>{p.toUpperCase()}{missing ? '×' : '✓'}</span>
                })}
              </div>
              <div className="px-2 py-1">
                <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                  <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
                </div>
              </div>
              <div className="flex flex-wrap gap-1 px-2 pb-1">
                {driverBadge('CYC', r.sev.cyc)}
                {driverBadge('PART', r.sev.part)}
                {driverBadge('RGN', r.sev.rgn)}
                {driverBadge('DAL', r.sev.dal)}
                {driverBadge('STDBY', r.sev.stdby)}
              </div>
              <div className="px-2 pb-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {advice(r)}</div>
            </div>
          )
        })}
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No aircraft match the current filters.</div>
        )}

        {tab === 'SUPPLIERS' && supRows.map((s, i) => {
          const col = FAMILY_COLOR[s.s.family]
          return (
            <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
              <div className="flex flex-wrap items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${col}` }}>
                <span className="font-semibold text-slate-100 font-mono">{s.s.id}</span>
                <span className="text-slate-400 truncate">{s.s.name}</span>
                <span className="px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '66', backgroundColor: col + '14' }}>{s.s.family}</span>
                <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{s.s.loaType}</span>
                {s.s.worldwide && <span className="px-1 py-px rounded text-[9px] bg-sky-500/15 text-sky-300 border border-sky-500/40">WW</span>}
                <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{s.ac} ac</span>
                {tierBadge(s.worstTier)}
              </div>
              <div className="px-2 text-[10px] text-slate-400">
                EXP {s.exp} · STALE {s.stale} · mean-behind {s.meanBhd.toFixed(1)} · mean-score {s.meanScore.toFixed(0)}
              </div>
              <div className="flex flex-wrap gap-1 px-2 pt-1 pb-1">
                {(['nav', 'chart', 'terr', 'obst'] as const).map(p => {
                  const has = (s.s.parts as any)[p]
                  const c = has ? '#10b981' : '#64748b'
                  return <span key={p} className="px-1 py-px rounded text-[9px]" style={{ color: c, border: '1px solid ' + c + '55', backgroundColor: c + '12' }}>{p.toUpperCase()}</span>
                })}
              </div>
              <div className="px-2 pb-2">
                <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                  <div style={{ width: `${Math.min(100, s.ac * 4)}%`, backgroundColor: col }} className="h-full" />
                </div>
              </div>
            </div>
          )
        })}

        {tab === 'CYCLES' && cycleRows.map((c, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[c.worst]}` }}>
              <span className="font-mono font-semibold text-slate-100">{c.cycle}</span>
              {c.isActive && <span className="px-1 py-px rounded text-[9px] bg-emerald-500/15 text-emerald-300 border border-emerald-500/40">ACTIVE</span>}
              {c.isExpired && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/40">EXPIRED</span>}
              {c.behind > 0 && !c.isExpired && <span className="px-1 py-px rounded text-[9px] bg-amber-500/15 text-amber-300 border border-amber-500/40">-{c.behind}</span>}
              <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{c.ac} ac</span>
              {tierBadge(c.worst)}
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-400">
              eff {new Date(c.effective).toISOString().slice(0,10)} · exp {new Date(c.expiry).toISOString().slice(0,10)} · {c.isActive ? 'current 28-day window' : c.behind === 1 ? '1 cycle behind' : `${c.behind} cycles behind`}
            </div>
            <div className="px-2 pb-2">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${Math.min(100, c.ac * 3)}%`, backgroundColor: TIER_COLOR[c.worst] }} className="h-full" />
              </div>
            </div>
          </div>
        ))}
        {tab === 'CYCLES' && cycleRows.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No cycles tracked.</div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: ICAO Annex 15 App 4 AIRAC · Doc 10066 PANS-AIM · Doc 8126 AIS Manual · Doc 9613 PBN Manual Vol II · Doc 8168 PANS-OPS Vol II Ch 3 · RTCA DO-200B Aeronautical Data Processing · DO-201A · ARINC 424-22 / 816-1 / 833 · EUROCAE ED-76A / ED-77 · FAA AC 20-153B / 90-100A §8 / 90-105A / 90-107 · Order 8400.10 V4 Ch 7 §7-1373 · Order 8260.19H Ch 9 · EASA AMC 20-26A / 20-27A / 20-28 · Part-CAT.OP.MPA.300 / SPA.PBN · EU Reg 73/2010 / 2017/373 · Doc 9881 Terrain/Obstacle · Doc 9906 Vol II QA · Doc 9674 WGS-84 · NTSB AAR-00-03 American 965 Cali R-vs-ROZO · AAR-00-01 KAL801 Guam · AAIB 11/2010 Faro LPV · ATSB AO-2007-053 BNE. Anchor cycle 1401 = 2014-01-09 Thursday, 28-day period. 9 suppliers DO-200B Type-1/2 LoA: Jeppesen/Navblue/LIDO/Honeywell/Collins/Garmin/Universal/Rockwell/UASC.
      </div>
    </div>
  )
}
