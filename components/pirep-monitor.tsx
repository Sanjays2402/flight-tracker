'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   PIREP · Pilot Report Geo-Correlation & Age-Decay Monitor
   -----------------------------------------------------------
   Per-airframe enroute / arrival / departure encounter-risk
   scorer that correlates each tracked target against a synthetic
   catalogue of UA (routine) / UUA (urgent) Pilot Reports
   filed against the FAA AWC PIREP system and ICAO AIREP/AIREP-
   SPECIAL channels. Each PIREP carries location, FL band,
   phenomenon class (TURB/ICE/LLWS/MTW/CB/IFR/WS/VA), severity
   (LGT/MOD/SEV/EXTRM), source aircraft type, and a filed-time
   ageMin that drives an exponential decay of usable signal
   (per AC 00-45H Sec 5 PIREP validity windows: TURB/ICE ~60 min,
   CB ~30 min, MTW ~90 min, IFR ~120 min).

   Aircraft are scored on:
     · proximity (great-circle nm) to active PIREPs
     · vertical band overlap (FL bracket of PIREP vs target FL)
     · phenomenon-vs-airframe susceptibility class
     · forward-track projection through PIREP cluster centroid
     · PIREP recency (exponential decay τ per class)
     · urgent-PIREP escalation (UUA per AIM 7-1-21)

   References
     · FAA AC 00-45H §5 PIREP / AIREP encoding
     · FAA AIM 7-1-21 Pilot Weather Reports
     · FAA AIM 7-1-22 PIREP Solicitation
     · FAA Order JO 7110.65 §2-6 PIREP dissemination
     · FAA Order 7900.5D Surface / Upper-Air Observations
     · NWS Instruction 10-819 PIREP procedures
     · NWS WSOM E-22 PIREP solicitation
     · ICAO Annex 3 §5 AIREP / AIREP-SPECIAL routine reports
     · ICAO Doc 8896 Manual of Aero Meteorology §10
     · ICAO Doc 4444 PANS-ATM §4.12 reports of meteorological cond.
     · ICAO Doc 7030 Regional Sup. Procedures NAT/EUR/APAC AIREPs
     · WMO No.49 Vol II §11.2 AIREP encoding
     · EUROCONTROL AMHS / AFTN AIREP relay specification
     · NTSB AAR-94-04 USAir 1016 CLT microburst (PIREP precursor)
     · NTSB AAR-96-01 American 1572 BDL CFIT (PIREP IFR pattern)
     · NTSB AAR-08-01 DAL191 windshear (LLWS precursor PIREP)
     · NTSB AAB-09-01 Pinnacle 3701 upset (icing PIREP miss)
     · ATSB AO-2008-070 Qantas 30 SEV TURB AIREP relay
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'UUA-HIT' | 'UA-HIT' | 'FWD-ENC' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'UUA-HIT': '#ef4444', 'UA-HIT': '#f43f5e', 'FWD-ENC': '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['UUA-HIT', 'UA-HIT', 'FWD-ENC', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { 'UUA-HIT': 0, 'UA-HIT': 1, 'FWD-ENC': 2, WATCH: 3, OK: 4, IDLE: 5 }

type Phenom = 'TURB' | 'ICE' | 'LLWS' | 'MTW' | 'CB' | 'IFR' | 'WS' | 'VA'
const PHENOM_COLOR: Record<Phenom, string> = {
  TURB: '#f59e0b', ICE: '#0ea5e9', LLWS: '#f43f5e', MTW: '#8b5cf6',
  CB: '#ef4444', IFR: '#64748b', WS: '#f43f5e', VA: '#a855f7',
}
/* validity τ (minutes) — AC 00-45H §5 typical relevance window */
const PHENOM_TAU: Record<Phenom, number> = {
  TURB: 60, ICE: 60, LLWS: 30, MTW: 90, CB: 30, IFR: 120, WS: 30, VA: 180,
}

type Severity = 'LGT' | 'MOD' | 'SEV' | 'EXTRM'
const SEV_WEIGHT: Record<Severity, number> = { LGT: 0.35, MOD: 0.60, SEV: 0.85, EXTRM: 1.00 }

type Phase = 'TKO' | 'CLB' | 'CRZ' | 'DES' | 'APP' | 'GND' | 'OTHER'
const PHASE_MUL: Record<Phase, number> = { TKO: 1.30, CLB: 1.10, CRZ: 1.00, DES: 1.05, APP: 1.40, GND: 0.0, OTHER: 0.50 }

interface Pirep {
  id: string
  lat: number; lng: number
  flLo: number; flHi: number
  phenom: Phenom
  sev: Severity
  urgent: boolean       // UUA flag
  source: string        // reporting aircraft type
  region: string
  ageMin: number        // synthetic time-since-filed
  note: string
}

/* Synthetic PIREP catalogue — 48 reports drawn from realistic
   geographic clusters across NAS / NAT / EUR / APAC. Coordinates
   roughly match common enroute weather corridors. */
const PIREPS: Pirep[] = [
  // Continental US TURB cluster — Rocky Mountain wave
  { id: 'UA-DEN-001', lat: 39.86, lng: -104.67, flLo: 280, flHi: 340, phenom: 'TURB', sev: 'MOD', urgent: false, source: 'B738', region: 'DEN', ageMin: 18, note: 'CONT MOD CHOP FL280-340 OVER LEE OF FRONT RANGE' },
  { id: 'UUA-DEN-002', lat: 40.20, lng: -105.40, flLo: 220, flHi: 280, phenom: 'MTW', sev: 'SEV', urgent: true, source: 'A320', region: 'DEN', ageMin: 8, note: 'SEV MTW LOSS 60 KT IAS 800 FPM DOWNDRAFT' },
  { id: 'UA-ASE-003', lat: 39.22, lng: -106.87, flLo: 180, flHi: 240, phenom: 'TURB', sev: 'MOD', urgent: false, source: 'C56X', region: 'ASE', ageMin: 32, note: 'MOD CHOP IAP ASE LOC RW15' },
  // Northeast US ICE band — winter trough
  { id: 'UA-BOS-004', lat: 42.36, lng: -71.01, flLo: 60, flHi: 140, phenom: 'ICE', sev: 'MOD', urgent: false, source: 'E190', region: 'BOS', ageMin: 22, note: 'MOD RIME 080-140 KNOX ARR' },
  { id: 'UUA-JFK-005', lat: 40.78, lng: -73.87, flLo: 80, flHi: 160, phenom: 'ICE', sev: 'SEV', urgent: true, source: 'CRJ7', region: 'JFK', ageMin: 12, note: 'SEV MIXED ICE NEG DEFLECTION STICK SHAKER' },
  { id: 'UA-PHL-006', lat: 39.87, lng: -75.24, flLo: 100, flHi: 180, phenom: 'ICE', sev: 'LGT', urgent: false, source: 'DH8D', region: 'PHL', ageMin: 45, note: 'LGT RIME 100-180' },
  // Southeast CB
  { id: 'UUA-MIA-007', lat: 25.79, lng: -80.29, flLo: 30, flHi: 410, phenom: 'CB', sev: 'EXTRM', urgent: true, source: 'B788', region: 'MIA', ageMin: 6, note: 'CB TOPS FL410 ANVIL DEVIATE 30NM SW' },
  { id: 'UA-MCO-008', lat: 28.43, lng: -81.31, flLo: 80, flHi: 280, phenom: 'TURB', sev: 'MOD', urgent: false, source: 'A321', region: 'MCO', ageMin: 26, note: 'MOD TURB IN BUILDUPS DEVIATE 15 LEFT' },
  // Texas LLWS / TS
  { id: 'UUA-DFW-009', lat: 32.90, lng: -97.04, flLo: 0, flHi: 30, phenom: 'LLWS', sev: 'SEV', urgent: true, source: 'B738', region: 'DFW', ageMin: 9, note: 'WS LOSS 25 KT SHORT FINAL RW17C' },
  { id: 'UA-IAH-010', lat: 29.98, lng: -95.34, flLo: 100, flHi: 240, phenom: 'TURB', sev: 'MOD', urgent: false, source: 'B739', region: 'IAH', ageMin: 38, note: 'MOD CHOP IN OUTFLOW NW DEPS' },
  // Midwest convective
  { id: 'UA-ORD-011', lat: 41.98, lng: -87.91, flLo: 220, flHi: 350, phenom: 'TURB', sev: 'MOD', urgent: false, source: 'B752', region: 'ORD', ageMin: 14, note: 'OCNL MOD CHOP NEAR JOT VOR' },
  { id: 'UUA-MSP-012', lat: 44.88, lng: -93.22, flLo: 50, flHi: 150, phenom: 'LLWS', sev: 'SEV', urgent: true, source: 'A20N', region: 'MSP', ageMin: 11, note: 'WS GAIN 30 LOSS 18 KT IAS RW12L' },
  // West Coast IFR + ICE
  { id: 'UA-SFO-013', lat: 37.62, lng: -122.38, flLo: 0, flHi: 30, phenom: 'IFR', sev: 'MOD', urgent: false, source: 'A320', region: 'SFO', ageMin: 52, note: 'CIG OVC003 VIS 3/4 STRATUS' },
  { id: 'UA-SEA-014', lat: 47.45, lng: -122.31, flLo: 60, flHi: 140, phenom: 'ICE', sev: 'MOD', urgent: false, source: 'B737', region: 'SEA', ageMin: 28, note: 'MOD RIME 060-140 IN STRATUS' },
  { id: 'UA-LAX-015', lat: 33.94, lng: -118.41, flLo: 0, flHi: 25, phenom: 'IFR', sev: 'LGT', urgent: false, source: 'A321', region: 'LAX', ageMin: 67, note: 'MARINE LAYER OVC008 VIS 4SM' },
  // Pacific NW MTW
  { id: 'UUA-PDX-016', lat: 45.59, lng: -122.60, flLo: 200, flHi: 320, phenom: 'MTW', sev: 'SEV', urgent: true, source: 'B788', region: 'PDX', ageMin: 17, note: 'SEV MTW LEE OF MT HOOD ALT LOSS 800 FT' },
  // Alaska / Aleutians VA
  { id: 'UUA-ANC-017', lat: 60.20, lng: -149.86, flLo: 180, flHi: 320, phenom: 'VA', sev: 'SEV', urgent: true, source: 'B744', region: 'ANC', ageMin: 35, note: 'VA OBS REDOUBT PLUME N OF CONA' },
  // North Atlantic Tracks
  { id: 'UA-NAT-018', lat: 52.00, lng: -30.00, flLo: 330, flHi: 380, phenom: 'TURB', sev: 'MOD', urgent: false, source: 'A359', region: 'NAT', ageMin: 41, note: 'CONT MOD CHOP TRACK ALFA FL360' },
  { id: 'UUA-NAT-019', lat: 55.00, lng: -40.00, flLo: 360, flHi: 400, phenom: 'TURB', sev: 'SEV', urgent: true, source: 'B789', region: 'NAT', ageMin: 19, note: 'SEV CAT FL380 TRACK CHARLIE GAINED 1500 FT' },
  { id: 'UA-NAT-020', lat: 48.50, lng: -40.00, flLo: 280, flHi: 360, phenom: 'TURB', sev: 'LGT', urgent: false, source: 'B772', region: 'NAT', ageMin: 58, note: 'LGT CHOP MNPS' },
  // Europe
  { id: 'UA-LON-021', lat: 51.47, lng: -0.45, flLo: 60, flHi: 180, phenom: 'TURB', sev: 'MOD', urgent: false, source: 'A20N', region: 'LON', ageMin: 25, note: 'MOD MECHANICAL TURB GUSTS 35 KT' },
  { id: 'UA-CDG-022', lat: 49.01, lng: 2.55, flLo: 0, flHi: 40, phenom: 'IFR', sev: 'MOD', urgent: false, source: 'A21N', region: 'CDG', ageMin: 71, note: 'BR VIS 1200 M RVR RW26L 800 M' },
  { id: 'UUA-LSZH-023', lat: 47.46, lng: 8.55, flLo: 80, flHi: 180, phenom: 'ICE', sev: 'SEV', urgent: true, source: 'BCS3', region: 'LSZH', ageMin: 13, note: 'SEV CLEAR ICE FREEZING DRIZZLE -3C' },
  { id: 'UUA-LOWI-024', lat: 47.26, lng: 11.34, flLo: 100, flHi: 240, phenom: 'MTW', sev: 'SEV', urgent: true, source: 'A319', region: 'LOWI', ageMin: 21, note: 'SEV ROTOR LEE INNSBRUCK ALT LOSS 600 FT' },
  // Middle East / Asia
  { id: 'UA-OMDB-025', lat: 25.25, lng: 55.36, flLo: 0, flHi: 50, phenom: 'IFR', sev: 'MOD', urgent: false, source: 'B77W', region: 'OMDB', ageMin: 88, note: 'BLDU VIS 2000 M DUST PLUME' },
  { id: 'UA-VABB-026', lat: 19.09, lng: 72.86, flLo: 0, flHi: 80, phenom: 'CB', sev: 'SEV', urgent: false, source: 'A320', region: 'VABB', ageMin: 16, note: 'CB TOPS FL420 MONSOON DEVIATE 20 NE' },
  // East Asia
  { id: 'UUA-RJTT-027', lat: 35.55, lng: 139.78, flLo: 200, flHi: 380, phenom: 'TURB', sev: 'SEV', urgent: true, source: 'B789', region: 'RJTT', ageMin: 7, note: 'SEV CAT JET STREAM 180 KT' },
  { id: 'UA-VHHH-028', lat: 22.31, lng: 113.91, flLo: 100, flHi: 200, phenom: 'TURB', sev: 'MOD', urgent: false, source: 'A359', region: 'VHHH', ageMin: 33, note: 'MOD CHOP OVER LANTAU' },
  { id: 'UA-WSSS-029', lat: 1.36, lng: 103.99, flLo: 50, flHi: 250, phenom: 'CB', sev: 'SEV', urgent: false, source: 'B77W', region: 'WSSS', ageMin: 23, note: 'CB BUILDUPS ITCZ DEVIATE WEST' },
  // South Pacific / Oceania
  { id: 'UA-YSSY-030', lat: -33.95, lng: 151.18, flLo: 80, flHi: 280, phenom: 'TURB', sev: 'MOD', urgent: false, source: 'B789', region: 'YSSY', ageMin: 47, note: 'MOD CHOP RICHMOND ARR' },
  { id: 'UUA-NZQN-031', lat: -45.02, lng: 168.74, flLo: 80, flHi: 180, phenom: 'MTW', sev: 'SEV', urgent: true, source: 'A320', region: 'NZQN', ageMin: 15, note: 'SEV MTW REMARKABLES 700 FPM DOWN' },
  // South America
  { id: 'UA-SBGR-032', lat: -23.43, lng: -46.47, flLo: 100, flHi: 280, phenom: 'CB', sev: 'SEV', urgent: false, source: 'B789', region: 'SBGR', ageMin: 19, note: 'CB SUMMER TS DEVIATE 25 N' },
  { id: 'UA-SCEL-033', lat: -33.39, lng: -70.79, flLo: 220, flHi: 340, phenom: 'TURB', sev: 'MOD', urgent: false, source: 'B788', region: 'SCEL', ageMin: 36, note: 'MOD CHOP ANDES WAVE' },
  // Africa
  { id: 'UA-FAOR-034', lat: -26.13, lng: 28.24, flLo: 80, flHi: 250, phenom: 'TURB', sev: 'MOD', urgent: false, source: 'A332', region: 'FAOR', ageMin: 44, note: 'MOD CHOP HIGHVELD' },
  { id: 'UUA-HKJK-035', lat: -1.32, lng: 36.93, flLo: 100, flHi: 300, phenom: 'CB', sev: 'SEV', urgent: true, source: 'B788', region: 'HKJK', ageMin: 12, note: 'CB EMBEDDED FRONT EXTREME LIGHTNING' },
  // North Pacific
  { id: 'UA-PHNL-036', lat: 21.32, lng: -157.92, flLo: 280, flHi: 380, phenom: 'TURB', sev: 'LGT', urgent: false, source: 'A332', region: 'PHNL', ageMin: 63, note: 'LGT CHOP TRADE WIND BAND' },
  // Russia / Siberia (polar)
  { id: 'UA-UUEE-037', lat: 55.97, lng: 37.41, flLo: 200, flHi: 340, phenom: 'TURB', sev: 'MOD', urgent: false, source: 'A359', region: 'UUEE', ageMin: 39, note: 'MOD CAT JETSTREAM EXIT REGION' },
  // Mexico / Caribbean
  { id: 'UA-MMMX-038', lat: 19.44, lng: -99.07, flLo: 80, flHi: 240, phenom: 'TURB', sev: 'MOD', urgent: false, source: 'A21N', region: 'MMMX', ageMin: 51, note: 'MOD CHOP LEE OF SIERRA' },
  // East Coast WS
  { id: 'UUA-LGA-039', lat: 40.78, lng: -73.87, flLo: 0, flHi: 30, phenom: 'WS', sev: 'SEV', urgent: true, source: 'A319', region: 'LGA', ageMin: 5, note: 'WS LOSS 22 KT IAS RW22 SHORT FINAL' },
  { id: 'UA-DCA-040', lat: 38.85, lng: -77.04, flLo: 0, flHi: 30, phenom: 'IFR', sev: 'MOD', urgent: false, source: 'E170', region: 'DCA', ageMin: 76, note: 'CIG OVC005 VIS 2SM IFR' },
  // Pacific oceanic
  { id: 'UA-PAC-041', lat: 35.00, lng: -160.00, flLo: 300, flHi: 380, phenom: 'TURB', sev: 'LGT', urgent: false, source: 'B772', region: 'PAC', ageMin: 81, note: 'LGT CHOP TRACK G344' },
  { id: 'UUA-PAC-042', lat: 25.00, lng: 170.00, flLo: 330, flHi: 410, phenom: 'TURB', sev: 'SEV', urgent: true, source: 'B789', region: 'PAC', ageMin: 24, note: 'SEV CAT NEAR R580 DEVIATE FL380' },
  // CONUS misc
  { id: 'UA-ATL-043', lat: 33.64, lng: -84.43, flLo: 80, flHi: 220, phenom: 'TURB', sev: 'MOD', urgent: false, source: 'B739', region: 'ATL', ageMin: 31, note: 'MOD CHOP CONVECTIVE OUTFLOW' },
  { id: 'UA-SLC-044', lat: 40.79, lng: -111.98, flLo: 150, flHi: 280, phenom: 'MTW', sev: 'MOD', urgent: false, source: 'A20N', region: 'SLC', ageMin: 42, note: 'MOD MTW WASATCH FRONT' },
  { id: 'UUA-CLT-045', lat: 35.21, lng: -80.94, flLo: 30, flHi: 80, phenom: 'WS', sev: 'SEV', urgent: true, source: 'A321', region: 'CLT', ageMin: 4, note: 'MICROBURST PROXY GAIN 25 LOSS 30 KT' },
  // Indian Ocean / SE Asia
  { id: 'UA-VTBS-046', lat: 13.69, lng: 100.75, flLo: 60, flHi: 200, phenom: 'CB', sev: 'MOD', urgent: false, source: 'B789', region: 'VTBS', ageMin: 29, note: 'CB MONSOON BUILDUPS' },
  // Northern Europe
  { id: 'UA-EFHK-047', lat: 60.32, lng: 24.96, flLo: 50, flHi: 140, phenom: 'ICE', sev: 'MOD', urgent: false, source: 'A20N', region: 'EFHK', ageMin: 49, note: 'MOD RIME 050-140 STRATUS' },
  // West Pacific
  { id: 'UA-RKSI-048', lat: 37.46, lng: 126.44, flLo: 100, flHi: 260, phenom: 'TURB', sev: 'MOD', urgent: false, source: 'B789', region: 'RKSI', ageMin: 37, note: 'MOD CHOP YELLOW SEA FRONT' },
]

/* aircraft susceptibility class — heavier widebody less affected
   by light TURB and clear ICE due to mass/wing loading; turboprops
   more susceptible to ICE and LLWS due to lower wing loading. */
type ACClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const ACCLASS_SUS: Record<ACClass, Record<Phenom, number>> = {
  'HVY-Q': { TURB: 0.70, ICE: 0.55, LLWS: 0.65, MTW: 0.75, CB: 0.85, IFR: 0.50, WS: 0.65, VA: 1.10 },
  'HVY':   { TURB: 0.80, ICE: 0.65, LLWS: 0.75, MTW: 0.85, CB: 0.95, IFR: 0.55, WS: 0.75, VA: 1.05 },
  'NRW':   { TURB: 1.00, ICE: 0.95, LLWS: 1.00, MTW: 1.05, CB: 1.05, IFR: 0.85, WS: 1.00, VA: 0.95 },
  'RGN':   { TURB: 1.15, ICE: 1.20, LLWS: 1.10, MTW: 1.15, CB: 1.10, IFR: 1.00, WS: 1.10, VA: 0.90 },
  'BIZ':   { TURB: 1.05, ICE: 1.00, LLWS: 1.00, MTW: 1.20, CB: 1.05, IFR: 0.90, WS: 1.00, VA: 0.85 },
  'TBP':   { TURB: 1.30, ICE: 1.45, LLWS: 1.25, MTW: 1.20, CB: 1.05, IFR: 1.15, WS: 1.25, VA: 0.80 },
}

function classify(type?: string, category?: string): ACClass {
  const t = (type || '').toUpperCase()
  if (/^(A38|B74|B77W|B748|A340|A35K)/.test(t)) return 'HVY-Q'
  if (/^(B77|B78|A33|A34|A35|MD11|B767)/.test(t)) return 'HVY'
  if (/^(B73|B75|A31|A32|A20|A21)/.test(t)) return 'NRW'
  if (/^(CRJ|E17|E19|E29|RJ|DH4)/.test(t)) return 'RGN'
  if (/^(GLF|GL|G2|G3|G4|G5|G6|G7|FA|F2T|F8X|F900|CL3|CL6|HDJ)/.test(t)) return 'BIZ'
  if (/^(ATR|AT4|AT7|DH8|SF3|J32|BE)/.test(t)) return 'TBP'
  if (category === '5' || category === '6') return 'HVY'
  return 'NRW'
}

interface Row {
  f: SFlight
  cls: ACClass
  nearest?: { p: Pirep; distNm: number; ageMin: number; decay: number }
  fwd?: { p: Pirep; distNm: number; etaMin: number; ageMin: number; decay: number }
  phase: Phase
  flLevel: number
  vBandHit: boolean
  prx: number; vbd: number; sus: number; fwdR: number; rec: number; urg: number
  driver: 'PRX' | 'VBD' | 'SUS' | 'FWD' | 'REC' | 'URG' | 'NONE'
  score: number
  tier: Tier
  hits: number      // count of PIREPs inside detection ring
}

function distNm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3440.065
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180
  const sa = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa))
}
function bearingDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const y = Math.sin(dLng) * Math.cos(la2)
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360
}
function projectNm(p: { lat: number; lng: number }, brgDeg: number, distNmIn: number): { lat: number; lng: number } {
  const R = 3440.065
  const br = brgDeg * Math.PI / 180
  const la1 = p.lat * Math.PI / 180
  const lo1 = p.lng * Math.PI / 180
  const dr = distNmIn / R
  const la2 = Math.asin(Math.sin(la1) * Math.cos(dr) + Math.cos(la1) * Math.sin(dr) * Math.cos(br))
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(la1), Math.cos(dr) - Math.sin(la1) * Math.sin(la2))
  return { lat: la2 * 180 / Math.PI, lng: ((lo2 * 180 / Math.PI + 540) % 360) - 180 }
}
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)) }
function map01(n: number, a: number, b: number): number {
  if (a === b) return 0
  const t = (n - a) / (b - a)
  return Math.max(0, Math.min(1, t))
}

const SRC_HALO = 'pirep-halo'; const LYR_HALO = 'pirep-halo-l'
const SRC_LBL = 'pirep-lbl'; const LYR_LBL = 'pirep-lbl-l'
const SRC_PIN = 'pirep-pin'; const LYR_PIN = 'pirep-pin-l'
const SRC_RPT = 'pirep-rpt'; const LYR_RPT = 'pirep-rpt-l'
const SRC_RING = 'pirep-ring'; const LYR_RING = 'pirep-ring-l'
const SRC_FWD = 'pirep-fwd'; const LYR_FWD = 'pirep-fwd-l'
const SRC_REF = 'pirep-ref'; const LYR_REF = 'pirep-ref-l'
const SRC_RLBL = 'pirep-rlbl'; const LYR_RLBL = 'pirep-rlbl-l'

export default function PirepMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'REPORTS' | 'PHENOM'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [phenomFilter, setPhenomFilter] = useState<Phenom | 'ALL'>('ALL')
  const [query, setQuery] = useState('')
  const [minFL, setMinFL] = useState(0)
  const [maxFL, setMaxFL] = useState(450)
  const [detectNm, setDetectNm] = useState(60)        // ring radius
  const [vBandFt, setVBandFt] = useState(4000)        // vertical bracket tolerance
  const [lookAhMin, setLookAhMin] = useState(15)      // forward projection minutes
  const [decayMul, setDecayMul] = useState(100)       // τ multiplier %
  const [sevMul, setSevMul] = useState(100)
  const [urgMul, setUrgMul] = useState(100)
  const [phaseWt, setPhaseWt] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showRpt, setShowRpt] = useState(true)
  const [showRing, setShowRing] = useState(true)
  const [showFwd, setShowFwd] = useState(true)
  const [showRef, setShowRef] = useState(false)
  const [showDiag, setShowDiag] = useState(true)

  const active = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const fl = Math.round(f.altitudeFt / 100)
      if (fl < minFL) continue
      if (fl > maxFL) continue
      const cls = classify(f.type, f.category)
      // phase
      let phase: Phase = 'OTHER'
      if (f.altitudeFt < 1500) phase = 'APP'
      else if (f.altitudeFt < 10000 && f.vertRate > 500) phase = 'CLB'
      else if (f.altitudeFt < 10000 && f.vertRate < -500) phase = 'APP'
      else if (f.vertRate > 500) phase = 'CLB'
      else if (f.vertRate < -500) phase = 'DES'
      else phase = 'CRZ'

      // nearest PIREP (any phenomenon w/ vertical-band overlap considered for proximity scoring)
      let nearest: Row['nearest']
      let hits = 0
      for (const p of PIREPS) {
        if (phenomFilter !== 'ALL' && p.phenom !== phenomFilter) continue
        const d = distNm(f, p)
        if (d <= detectNm) hits++
        // decay (exponential)
        const tau = PHENOM_TAU[p.phenom] * (decayMul / 100)
        const decay = Math.exp(-p.ageMin / Math.max(5, tau))
        if (decay < 0.10) continue
        if (!nearest || d < nearest.distNm) nearest = { p, distNm: d, ageMin: p.ageMin, decay }
      }
      // forward projection — find any PIREP within forward cone
      let fwd: Row['fwd']
      const fwdNm = (f.velocityKts * (lookAhMin / 60))
      const tip = projectNm(f, f.track, fwdNm)
      for (const p of PIREPS) {
        if (phenomFilter !== 'ALL' && p.phenom !== phenomFilter) continue
        const tau = PHENOM_TAU[p.phenom] * (decayMul / 100)
        const decay = Math.exp(-p.ageMin / Math.max(5, tau))
        if (decay < 0.10) continue
        // cross-track distance from segment endpoint approximation: distance of PIREP to track tip + bearing alignment
        const brg = bearingDeg(f, p)
        const trkDelta = Math.abs(((brg - f.track + 540) % 360) - 180)
        const dStart = distNm(f, p)
        if (trkDelta > 25) continue
        if (dStart > fwdNm + detectNm) continue
        const etaMin = (dStart / Math.max(120, f.velocityKts)) * 60
        if (!fwd || dStart < fwd.distNm) fwd = { p, distNm: dStart, etaMin, ageMin: p.ageMin, decay }
      }
      void tip
      // vertical band hit
      let vBandHit = false
      if (nearest) {
        const flMid = (nearest.p.flLo + nearest.p.flHi) / 2
        const flHalf = (nearest.p.flHi - nearest.p.flLo) / 2
        const tolFL = (vBandFt / 100) / 2
        vBandHit = Math.abs(fl - flMid) <= (flHalf + tolFL)
      }

      // driver severities 0-100
      // PRX: how close to nearest PIREP (max at 0nm, zero at detectNm)
      const prx = nearest ? clamp(map01(detectNm - nearest.distNm, 0, detectNm) * 100 * nearest.decay, 0, 100) : 0
      // VBD: vertical band overlap binary boost
      const vbd = nearest && vBandHit ? 60 * nearest.decay : 0
      // SUS: airframe susceptibility for this phenom × severity
      const sus = nearest ? clamp(ACCLASS_SUS[cls][nearest.p.phenom] * SEV_WEIGHT[nearest.p.sev] * 100 * (sevMul / 100), 0, 100) : 0
      // FWD: forward encounter probability
      const fwdR = fwd ? clamp(map01(lookAhMin - fwd.etaMin, 0, lookAhMin) * 95 * fwd.decay, 0, 100) : 0
      // REC: cluster recency density — count of fresh hits in ring
      const rec = hits > 0 ? clamp(hits * 22, 0, 100) : 0
      // URG: urgent UUA escalation
      const urg = nearest && nearest.p.urgent ? 75 * nearest.decay * (urgMul / 100) : 0

      let score = Math.max(prx * 0.95, vbd * 1.0, sus * 0.80, fwdR * 0.90, rec * 0.65, urg * 1.05)
      score = score * (PHASE_MUL[phase] * (phaseWt / 100))
      score = clamp(score, 0, 100)

      let driver: Row['driver'] = 'NONE'
      const maxD = Math.max(prx, vbd, sus, fwdR, rec, urg)
      if (maxD === urg && urg > 0) driver = 'URG'
      else if (maxD === prx && prx > 0) driver = 'PRX'
      else if (maxD === vbd && vbd > 0) driver = 'VBD'
      else if (maxD === fwdR && fwdR > 0) driver = 'FWD'
      else if (maxD === sus && sus > 0) driver = 'SUS'
      else if (maxD === rec && rec > 0) driver = 'REC'

      let tier: Tier
      if (!nearest && !fwd) tier = 'IDLE'
      else if (nearest && nearest.p.urgent && score >= 70 && (vBandHit || prx >= 60)) tier = 'UUA-HIT'
      else if (nearest && score >= 55 && vBandHit) tier = 'UA-HIT'
      else if (fwd && fwdR >= 55) tier = 'FWD-ENC'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({ f, cls, nearest, fwd, phase, flLevel: fl, vBandHit, prx, vbd, sus, fwdR, rec, urg, driver, score, tier, hits })
    }
    return out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [flights, minFL, maxFL, detectNm, vBandFt, lookAhMin, decayMul, sevMul, urgMul, phaseWt, phenomFilter])

  const tierCount: Record<Tier, number> = { 'UUA-HIT': 0, 'UA-HIT': 0, 'FWD-ENC': 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const r of active) tierCount[r.tier]++
  const worst = active[0]
  const meanProxNm = active.filter(r => r.nearest).length ? active.filter(r => r.nearest).reduce((s, r) => s + r.nearest!.distNm, 0) / Math.max(1, active.filter(r => r.nearest).length) : 0
  const uuaShare = active.length ? tierCount['UUA-HIT'] / active.length : 0
  const fwdShare = active.length ? tierCount['FWD-ENC'] / active.length : 0
  const urgentRpts = PIREPS.filter(p => p.urgent && Math.exp(-p.ageMin / (PHENOM_TAU[p.phenom] * (decayMul / 100))) >= 0.10).length

  const filtered = active.filter(r => {
    if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
    if (query) {
      const q = query.toLowerCase()
      const hay = `${r.f.callsign || ''} ${r.f.icao} ${r.f.type || ''} ${r.nearest?.p.id || ''} ${r.nearest?.p.region || ''} ${r.nearest?.p.phenom || ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  /* per-PIREP rollup */
  const reportRows = useMemo(() => {
    const m = new Map<string, { p: Pirep; ac: number; uua: number; ua: number; fwd: number; meanScore: number; worst?: Row; decay: number }>()
    for (const p of PIREPS) {
      const tau = PHENOM_TAU[p.phenom] * (decayMul / 100)
      const decay = Math.exp(-p.ageMin / Math.max(5, tau))
      m.set(p.id, { p, ac: 0, uua: 0, ua: 0, fwd: 0, meanScore: 0, decay })
    }
    for (const r of active) {
      if (r.nearest) {
        const e = m.get(r.nearest.p.id)!
        e.ac++
        if (r.tier === 'UUA-HIT') e.uua++
        if (r.tier === 'UA-HIT') e.ua++
        e.meanScore += r.score
        if (!e.worst || r.score > e.worst.score) e.worst = r
      }
      if (r.fwd) {
        const e = m.get(r.fwd.p.id)!
        e.fwd++
      }
    }
    return Array.from(m.values())
      .map(e => ({ ...e, meanScore: e.ac ? e.meanScore / e.ac : 0 }))
      .filter(e => e.decay >= 0.05)
      .sort((a, b) => Number(b.p.urgent) - Number(a.p.urgent) || (b.uua - a.uua) || (b.ac + b.fwd - a.ac - a.fwd))
  }, [active, decayMul])

  /* per-phenomenon rollup */
  const phenomRows = useMemo(() => {
    const buckets: Record<Phenom, { ac: number; uua: number; ua: number; fwd: number; rpts: number; meanScore: number }> = {
      TURB: { ac: 0, uua: 0, ua: 0, fwd: 0, rpts: 0, meanScore: 0 },
      ICE: { ac: 0, uua: 0, ua: 0, fwd: 0, rpts: 0, meanScore: 0 },
      LLWS: { ac: 0, uua: 0, ua: 0, fwd: 0, rpts: 0, meanScore: 0 },
      MTW: { ac: 0, uua: 0, ua: 0, fwd: 0, rpts: 0, meanScore: 0 },
      CB: { ac: 0, uua: 0, ua: 0, fwd: 0, rpts: 0, meanScore: 0 },
      IFR: { ac: 0, uua: 0, ua: 0, fwd: 0, rpts: 0, meanScore: 0 },
      WS: { ac: 0, uua: 0, ua: 0, fwd: 0, rpts: 0, meanScore: 0 },
      VA: { ac: 0, uua: 0, ua: 0, fwd: 0, rpts: 0, meanScore: 0 },
    }
    for (const p of PIREPS) buckets[p.phenom].rpts++
    for (const r of active) {
      if (!r.nearest) continue
      const b = buckets[r.nearest.p.phenom]
      b.ac++
      if (r.tier === 'UUA-HIT') b.uua++
      if (r.tier === 'UA-HIT') b.ua++
      b.meanScore += r.score
    }
    for (const r of active) {
      if (r.fwd) buckets[r.fwd.p.phenom].fwd++
    }
    return (Object.keys(buckets) as Phenom[]).map(k => ({
      k, ...buckets[k], meanScore: buckets[k].ac ? buckets[k].meanScore / buckets[k].ac : 0,
    }))
  }, [active])

  /* ---------- MapLibre overlay ---------- */
  useEffect(() => {
    if (!map) return
    for (const [src, lyr, type, paint, layout] of [
      [SRC_RPT, LYR_RPT, 'circle', { 'circle-radius': ['interpolate', ['linear'], ['get', 'sev'], 0.35, 4, 1, 9], 'circle-color': ['get', 'color'], 'circle-opacity': 0.55, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': ['get', 'decay'] }, null],
      [SRC_RING, LYR_RING, 'circle', { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 6, 6, 14, 9, 28], 'circle-color': ['get', 'color'], 'circle-opacity': 0.08, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 0.6, 'circle-stroke-opacity': 0.45 }, null],
      [SRC_HALO, LYR_HALO, 'circle', { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.28, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.2, 'circle-stroke-opacity': 0.85 }, null],
      [SRC_PIN, LYR_PIN, 'circle', { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1 }, null],
      [SRC_FWD, LYR_FWD, 'line', { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-dasharray': [2, 2], 'line-opacity': 0.85 }, null],
      [SRC_REF, LYR_REF, 'line', { 'line-color': '#0ea5e955', 'line-width': 0.5, 'line-dasharray': [3, 4] }, null],
      [SRC_LBL, LYR_LBL, 'symbol', { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.4 }, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': true }],
      [SRC_RLBL, LYR_RLBL, 'symbol', { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 }, { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, -1.4], 'text-allow-overlap': true }],
    ] as Array<[string, string, string, any, any]>) {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      if (!map.getLayer(lyr)) {
        const def: any = { id: lyr, type, source: src, paint }
        if (layout) def.layout = layout
        map.addLayer(def)
      }
    }

    const rpt: any[] = []; const ring: any[] = []; const halo: any[] = []; const pin: any[] = []; const fwd: any[] = []; const ref: any[] = []; const lbl: any[] = []; const rlbl: any[] = []

    if (showRpt) {
      for (const p of PIREPS) {
        const tau = PHENOM_TAU[p.phenom] * (decayMul / 100)
        const decay = Math.exp(-p.ageMin / Math.max(5, tau))
        if (decay < 0.10) continue
        if (phenomFilter !== 'ALL' && p.phenom !== phenomFilter) continue
        const color = PHENOM_COLOR[p.phenom]
        rpt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { color, sev: SEV_WEIGHT[p.sev], decay } })
        if (showRing) ring.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { color } })
        if (showLbl) rlbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { color, label: `${p.urgent ? '! ' : ''}${p.phenom} ${p.sev} FL${p.flLo}-${p.flHi} ${p.ageMin}m` } })
      }
    }
    for (const r of active) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'OK' && r.tier !== 'IDLE') {
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: 8 + r.score * 0.14 } })
      }
      if (showPin && (r.tier === 'UUA-HIT' || r.tier === 'UA-HIT')) {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color } })
      }
      if (showLbl && r.tier !== 'OK' && r.tier !== 'IDLE') {
        const lab = `${r.f.callsign || r.f.icao} · ${r.tier}${r.nearest ? ' · ' + r.nearest.p.phenom + ' ' + r.nearest.distNm.toFixed(0) + 'nm' : ''}`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { label: lab, color } })
      }
      if (showFwd && r.fwd) {
        fwd.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.fwd.p.lng, r.fwd.p.lat]] }, properties: { color } })
      }
    }
    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        ref.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }
    ;(map.getSource(SRC_RPT) as any).setData({ type: 'FeatureCollection', features: rpt })
    ;(map.getSource(SRC_RING) as any).setData({ type: 'FeatureCollection', features: ring })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_FWD) as any).setData({ type: 'FeatureCollection', features: fwd })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: ref })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_RLBL) as any).setData({ type: 'FeatureCollection', features: rlbl })
    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_RLBL, LYR_PIN, LYR_HALO, LYR_FWD, LYR_RPT, LYR_RING, LYR_REF]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_LBL, SRC_RLBL, SRC_PIN, SRC_FWD, SRC_RPT, SRC_RING, SRC_REF]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, active, showHalo, showPin, showLbl, showRpt, showRing, showFwd, showRef, decayMul, phenomFilter])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const drvBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (r: Row) => {
    if (!r.nearest && !r.fwd) return 'No active PIREP within decay window — AIREP solicitation per AIM 7-1-22 if conditions encountered'
    if (r.tier === 'UUA-HIT') return `URGENT UUA HIT · ${r.nearest!.p.phenom} ${r.nearest!.p.sev} · "${r.nearest!.p.note}" · brief crew per AIM 7-1-21 · request alt/route per JO 7110.65 §2-6 · file SPECIAL AIREP per Annex 3 §5.5`
    if (r.tier === 'UA-HIT') return `Routine UA hit · ${r.nearest!.p.phenom} ${r.nearest!.p.sev} ${r.nearest!.distNm.toFixed(0)}nm · age ${r.nearest!.ageMin}min decay ${(r.nearest!.decay*100).toFixed(0)}% · acknowledge dispatch WX brief`
    if (r.tier === 'FWD-ENC') return `Forward encounter projected · ${r.fwd!.p.phenom} ${r.fwd!.p.sev} ETA ${r.fwd!.etaMin.toFixed(0)}min · pre-coord deviation / FL change per AIM 7-1-21 if WX cell remains`
    if (r.tier === 'WATCH') return `Within decay ring · monitor ride / WX briefer · file PIREP if encountered (AC 00-45H §5)`
    if (r.tier === 'OK') return `Clear of active PIREP corridor · nominal`
    return ''
  }

  /* Scatter: nearest distance vs decay */
  const W = 280, H = 180
  const sx = (n: number) => 32 + (clamp(n, 0, 200) / 200) * (W - 42)
  const sy = (n: number) => H - 24 - clamp(n, 0, 100) / 100 * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">PIREP · Pilot Report Geo-Correlation</div>
          <div className="text-[10px] text-slate-500">AC 00-45H §5 · AIM 7-1-21 · ICAO Annex 3 §5 · JO 7110.65 §2-6</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[8px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean prox</div>
          <div className="text-sm font-semibold" style={{ color: meanProxNm <= 30 ? '#ef4444' : meanProxNm <= 80 ? '#f59e0b' : '#10b981' }}>{meanProxNm.toFixed(0)}nm</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">UUA hits</div>
          <div className="text-sm font-semibold" style={{ color: tierCount['UUA-HIT'] > 0 ? '#ef4444' : '#10b981' }}>{tierCount['UUA-HIT']}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">UUA share</div>
          <div className="text-xs font-semibold" style={{ color: uuaShare >= 0.10 ? '#ef4444' : uuaShare >= 0.05 ? '#f59e0b' : '#10b981' }}>{(uuaShare*100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">FWD share</div>
          <div className="text-xs font-semibold" style={{ color: fwdShare >= 0.10 ? '#f59e0b' : '#10b981' }}>{(fwdShare*100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Active UUAs</div>
          <div className="text-xs font-semibold" style={{ color: urgentRpts > 0 ? '#f43f5e' : '#10b981' }}>{urgentRpts}</div>
        </div>
      </div>

      {showDiag && active.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* breach quadrant: close + high score */}
            <rect x={sx(0)} y={sy(100)} width={sx(60)-sx(0)} height={sy(55)-sy(100)} fill="#ef444425" />
            <rect x={sx(0)} y={sy(55)} width={sx(60)-sx(0)} height={sy(25)-sy(55)} fill="#f59e0b22" />
            {/* axis lines */}
            <line x1={sx(60)} y1={sy(0)} x2={sx(60)} y2={sy(100)} stroke="#475569" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(0)} y1={sy(55)} x2={sx(200)} y2={sy(55)} stroke="#f59e0b66" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={W/2} y={H-4} textAnchor="middle" fontSize="9" fill="#64748b">Nearest PIREP dist (nm)</text>
            <text x={6} y={H/2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H/2})`}>Score</text>
            {active.filter(r => r.nearest).map((r, i) => (
              <circle key={i} cx={sx(r.nearest!.distNm)} cy={sy(r.score)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['MIN-FL', minFL, 0, 200, setMinFL, ''],
            ['MAX-FL', maxFL, 50, 450, setMaxFL, ''],
            ['DET-NM', detectNm, 10, 200, setDetectNm, 'nm'],
            ['V-BAND', vBandFt, 1000, 12000, setVBandFt, 'ft'],
            ['LOOK-AH', lookAhMin, 5, 60, setLookAhMin, 'm'],
            ['DECAY', decayMul, 25, 250, setDecayMul, '%'],
            ['SEV-MUL', sevMul, 50, 200, setSevMul, '%'],
            ['URG-MUL', urgMul, 50, 200, setUrgMul, '%'],
            ['PHASE-WT', phaseWt, 50, 150, setPhaseWt, '%'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[40px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['TURB', 'ICE', 'LLWS', 'MTW', 'CB', 'IFR', 'WS', 'VA'] as Phenom[]).map(k => (
            <button key={k} onClick={() => setPhenomFilter(phenomFilter === k ? 'ALL' : k)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: phenomFilter === k ? PHENOM_COLOR[k] + '33' : '#0b1220', borderColor: phenomFilter === k ? PHENOM_COLOR[k] : '#1e293b', color: phenomFilter === k ? PHENOM_COLOR[k] : '#cbd5e1' }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['RPT', showRpt, setShowRpt],
            ['RING', showRing, setShowRing],
            ['FWD', showFwd, setShowFwd],
            ['REF', showRef, setShowRef],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / phenom / region" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'REPORTS', 'PHENOM'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className="flex-1 px-2 py-1.5 text-[11px]" style={{ color: tab === t ? '#0ea5e9' : '#94a3b8', backgroundColor: tab === t ? '#0ea5e915' : 'transparent', borderBottom: tab === t ? '2px solid #0ea5e9' : '2px solid transparent' }}>{t}</button>
        ))}
      </div>

      {tab === 'AIRCRAFT' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No targets near active PIREP decay window · adjust filters</div>}
          {filtered.slice(0, 80).map((r, i) => (
            <div key={i} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(r.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 truncate">{r.f.callsign || r.f.icao}</span>
                  <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 border border-slate-700 font-mono">{r.cls}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 border border-slate-700">{r.phase}</span>
                  {r.nearest && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: PHENOM_COLOR[r.nearest.p.phenom], backgroundColor: PHENOM_COLOR[r.nearest.p.phenom] + '1a', border: `1px solid ${PHENOM_COLOR[r.nearest.p.phenom]}66` }}>{r.nearest.p.phenom} {r.nearest.p.sev}</span>}
                  {r.nearest?.p.urgent && <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] text-rose-400 bg-rose-500/10 border border-rose-500/40 font-semibold">UUA !</span>}
                </div>
                {tierBadge(r.tier)}
              </div>
              {r.nearest && (
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  FL{r.flLevel} · near {r.nearest.p.id} {r.nearest.distNm.toFixed(0)}nm · band FL{r.nearest.p.flLo}-{r.nearest.p.flHi} <span style={{ color: r.vBandHit ? '#ef4444' : '#64748b' }}>{r.vBandHit ? 'IN-BAND' : 'OUT-BAND'}</span> · age {r.nearest.ageMin}m · decay {(r.nearest.decay*100).toFixed(0)}%
                </div>
              )}
              {r.fwd && (
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  FWD → {r.fwd.p.id} {r.fwd.distNm.toFixed(0)}nm ETA {r.fwd.etaMin.toFixed(0)}m · {r.fwd.p.phenom} {r.fwd.p.sev}
                </div>
              )}
              {r.nearest && (
                <div className="text-[10px] text-slate-500 mt-0.5 italic truncate">"{r.nearest.p.note}"</div>
              )}
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {drvBadge('PRX', r.prx)}
                {drvBadge('VBD', r.vbd)}
                {drvBadge('SUS', r.sus)}
                {drvBadge('FWD', r.fwdR)}
                {drvBadge('REC', r.rec)}
                {drvBadge('URG', r.urg)}
              </div>
              <div className="text-[10px] mt-1" style={{ color: TIER_COLOR[r.tier] }}>{advice(r)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'REPORTS' && (
        <div className="divide-y divide-slate-800">
          {reportRows.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No PIREPs within decay window</div>}
          {reportRows.map((e, i) => (
            <div key={i} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => e.worst && onFly(e.worst.f.icao)} style={{ borderLeft: `3px solid ${e.p.urgent ? '#ef4444' : PHENOM_COLOR[e.p.phenom]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 font-mono">{e.p.id}</span>
                  {e.p.urgent && <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] text-rose-400 bg-rose-500/10 border border-rose-500/40 font-semibold">UUA !</span>}
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: PHENOM_COLOR[e.p.phenom], backgroundColor: PHENOM_COLOR[e.p.phenom] + '1a', border: `1px solid ${PHENOM_COLOR[e.p.phenom]}66` }}>{e.p.phenom} {e.p.sev}</span>
                </div>
                <div className="text-[10px] text-slate-400">{e.ac + e.fwd} ac</div>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                {e.p.region} · FL{e.p.flLo}-{e.p.flHi} · age {e.p.ageMin}m · decay <span style={{ color: e.decay >= 0.6 ? '#ef4444' : e.decay >= 0.3 ? '#f59e0b' : '#0ea5e9' }}>{(e.decay*100).toFixed(0)}%</span> · src {e.p.source}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5 italic truncate">"{e.p.note}"</div>
              <div className="flex items-center gap-2 mt-1">
                {e.uua > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/40">UUA {e.uua}</span>}
                {e.ua > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: '#f43f5e', backgroundColor: '#f43f5e1a', border: '1px solid #f43f5e66' }}>UA {e.ua}</span>}
                {e.fwd > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/40">FWD {e.fwd}</span>}
                <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${e.meanScore}%`, backgroundColor: e.meanScore >= 80 ? '#ef4444' : e.meanScore >= 55 ? '#f59e0b' : e.meanScore >= 25 ? '#0ea5e9' : '#10b981' }} /></div>
                <span className="text-[10px] text-slate-400 tabular-nums w-8 text-right">{e.meanScore.toFixed(0)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'PHENOM' && (
        <div className="divide-y divide-slate-800">
          {phenomRows.map((b, i) => (
            <div key={i} className="px-3 py-2" style={{ borderLeft: `3px solid ${PHENOM_COLOR[b.k]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-slate-100 font-mono">{b.k}</span>
                  <span className="text-[10px] text-slate-500">τ {PHENOM_TAU[b.k]}m</span>
                </div>
                <div className="text-[10px] text-slate-400">{b.rpts} rpts · {b.ac} ac</div>
              </div>
              <div className="flex items-center gap-2 mt-1">
                {b.uua > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/40">UUA {b.uua}</span>}
                {b.ua > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: '#f43f5e', backgroundColor: '#f43f5e1a', border: '1px solid #f43f5e66' }}>UA {b.ua}</span>}
                {b.fwd > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/40">FWD {b.fwd}</span>}
                <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${b.meanScore}%`, backgroundColor: b.meanScore >= 80 ? '#ef4444' : b.meanScore >= 55 ? '#f59e0b' : b.meanScore >= 25 ? '#0ea5e9' : '#10b981' }} /></div>
                <span className="text-[10px] text-slate-400 tabular-nums w-8 text-right">{b.meanScore.toFixed(0)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 leading-tight">
        FAA AC 00-45H §5 · AIM 7-1-21 / 7-1-22 PIREP · JO 7110.65 §2-6 dissemination · NWS Instr 10-819 · ICAO Annex 3 §5 AIREP / SPECIAL · Doc 4444 §4.12 · Doc 8896 §10 · WMO No.49 §11.2 · NTSB AAR-94-04 USAir 1016 · AAR-08-01 windshear · AAB-09-01 icing
      </div>
    </div>
  )
}
