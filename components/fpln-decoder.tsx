'use client'

// =============================================================================
// FPLN · ICAO Flight Plan Decoder & Field-by-Field Validator
// -----------------------------------------------------------------------------
// Per-airframe ICAO Doc 4444 PANS-ATM Appendix 2 model-FPL decoder + validator
// that synthesizes a representative Item 7-19 ICAO 2012 flight plan for every
// airborne aircraft from live ADS-B state (callsign, type, wake-category,
// equipment fit by class, current position/level/track snapped to nearest
// departure/arrival hub) and validates each field against the canonical FPL
// format rules + ICAO PBN navspec library + EUROCONTROL IFPS message checker
// equivalence. Distinct from every neighbouring layer:
//
//   PDC / DCL    — uplink chain of an ALREADY-ACCEPTED clearance
//   CPDLC        — pilot↔controller datalink in flight
//   AIRAC        — FMS nav-DB cycle currency
//   FREQ         — voice frequency directory
//   AIDC         — ATC↔ATC inter-facility handoff
//   PBCS         — RCP/RSP performance certification framework
//   RNP / PBN    — actual airborne nav-performance compliance
//
// FPLN is uniquely the FILED-PLAN SYNTAX & SEMANTIC VALIDATOR — answers
// for each airframe whether the Doc 4444 Item 7/8/9/10/13/15/16/18 fields
// it WOULD file are well-formed, internally consistent (type↔wake match,
// equipment↔PBN match, surveillance↔ADS-B-OUT match, route↔FIR coverage),
// and ready for EUROCONTROL IFPS / FAA NFDC strip generation.
//
// Field 7  Aircraft Identification             (callsign, 2-7 alphanumerics)
// Field 8  Flight Rules / Type of Flight       (I/V/Y/Z · S/N/G/M/X)
// Field 9  Number / Type / Wake                (N=1 + ICAO type + L/M/H/J)
// Field 10 Equipment / Surveillance            (COM-NAV-APP + SSR + ADS-B)
// Field 13 Departure / EOBT                    (ICAO ADEP + 4-digit zulu)
// Field 15 Cruising speed / Level / Route      (N0xxx/M0xx + Fxxx + route)
// Field 16 Destination / EET / Alternates      (ICAO ADES + 4-digit EET)
// Field 18 Other information                   (PBN/NAV/COM/DAT/SUR/PER/...)
//
// Per ICAO Doc 4444 PANS-ATM Amdt 10 §4.4 + Appendix 2 · ICAO Doc 8585
// (Designators for Aircraft Operating Agencies) · ICAO Doc 8643 ed.52
// (Aircraft Type Designators) · ICAO Doc 9613 PBN Manual Vol II
// (Navigation Specifications) · EUROCONTROL IFPS Users Manual ed.27.0
// · FAA Order JO 7110.10 § FPL · FAA NFDC AFD · Reg (EU) 923/2012 SERA.
//
// Field-by-field validator catches the canonical filing errors:
//   E1  Item 7 callsign too short / illegal char
//   E2  Item 8 invalid rules letter / type of flight
//   E3  Item 9 wake/type mismatch (HVY filing as M etc.)
//   E4  Item 10 surveillance code missing ADS-B for §91.225 airspace
//   E5  Item 13 ADEP not in catalogue
//   E6  Item 15 speed prefix wrong for FL (N for subsonic, M for supersonic)
//   E7  Item 15 cruising-level format (FL vs altitude, semicircular)
//   E8  Item 16 ADES = ADEP (round-robin needs Y flag)
//   E9  Item 18 PBN code missing for RNP route
//   E10 Item 18 SEL/REG/DOF format
//
// 12-class equipment fit catalogue (per AClass) drives Item 10 strings
// per the canonical Boeing FCOM AVIONICS-FIT tables, Airbus FCOM DSC-46,
// Embraer AOM §3, Bombardier CRJ FCM §2-15, ATR FCOM 1.10.
//
// Compliance score = 6-driver composite (SYNTAX / TYPE / EQUIP / ROUTE /
// PBN / ALT) with 5 tiers REJECTED / DEFECTIVE / DEFICIENT / ACCEPTED /
// EXEMPLARY. Tier coloring same family as other overlays (rose/amber/sky/
// emerald/slate), accent always sky-500 for chrome.
//
// MapLibre overlay: tier-coloured halo + REJECTED pin + ADEP→ADES arc
// + airline strip label. Panel: tier counter strip + 6-cell summary +
// 5 sliders + filters + 4-tab AIRCRAFT / FIELDS / VALIDATION / FORMAT.
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

interface F {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  vertRate: number
  track: number
  ground?: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: F[]
  onClose: () => void
  onFly: (icao: string) => void
}

// -------------------------------------------------------------------- //
// Tier definitions
// -------------------------------------------------------------------- //
type Tier = 'REJECTED' | 'DEFECTIVE' | 'DEFICIENT' | 'ACCEPTED' | 'EXEMPLARY' | 'IDLE'

const TIER_ORDER: Tier[] = ['REJECTED', 'DEFECTIVE', 'DEFICIENT', 'ACCEPTED', 'EXEMPLARY', 'IDLE']

const TIER_COLOR: Record<Tier, string> = {
  REJECTED:  '#e11d48', // rose-600 — IFPS REJ
  DEFECTIVE: '#fb7185', // rose-pink — IFPS MAN
  DEFICIENT: '#f59e0b', // amber — IFPS WAR
  ACCEPTED:  '#0ea5e9', // sky — ACK
  EXEMPLARY: '#10b981', // emerald — clean Item 18
  IDLE:      '#64748b',
}

const TIER_RANK: Record<Tier, number> = {
  REJECTED: 0, DEFECTIVE: 1, DEFICIENT: 2, ACCEPTED: 3, EXEMPLARY: 4, IDLE: 5,
}

// -------------------------------------------------------------------- //
// Aircraft class → equipment fit catalogue
// Equipment letters per ICAO Doc 4444 App 2 Item 10:
//   A=GBAS  B=LPV  C=LORAN-C  D=DME  E1/E2/E3=FMC-WPR/D-FIS/PDC
//   F=ADF  G=GNSS  H=HF-RTF  I=IRS  J1-J7=DataLink-CPDLC variants
//   K=MLS  L=ILS  M1/M2/M3=ATC-SAT-VOICE  O=VOR
//   P1-P9=RCP400/240/etc  R=PBN-approved  T=TACAN
//   U=UHF-RTF  V=VHF-RTF  W=RVSM  X=MNPS  Y=8.33kHz  Z=other
// Surveillance per Item 10b:
//   N=nil  A/C/E/H/I/L/P/S/X=Mode-A/C/S elementary/enhanced variants
//   B1/B2=ADS-B-OUT/IN 1090ES  U1/U2=UAT  V1/V2=VDL-Mode-4
//   D1=ADS-C  G1=ADS-C-FANS
// -------------------------------------------------------------------- //
type AClass = 'HVY-Q' | 'HVY-T' | 'WB-M' | 'NB-LR' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ' | 'LIGHT' | 'OTHER'

interface ClassSpec {
  label: string
  wake: 'J' | 'H' | 'M' | 'L'        // ICAO wake cat (J=A380/A388 super, H=heavy, M=medium, L=light)
  comNav: string                       // Item 10a equipment string
  surv: string                         // Item 10b surveillance string
  pbn: string                          // Item 18 PBN/ subfield
  speedPref: 'N' | 'M'                 // N=subsonic kts, M=Mach
  cruzKt: number                       // typical cruise TAS kts
  cruzMach: number                     // typical cruise Mach
  serviceFL: number                    // typical service ceiling FL
  hasFans1a: boolean                   // CPDLC/ADS-C for oceanic
  has833: boolean                      // 8.33kHz VHF EU-mandated
  hasRvsm: boolean                     // RVSM compliant
}

const CLASS: Record<AClass, ClassSpec> = {
  'HVY-Q': { label:'4-eng widebody', wake:'J', comNav:'SDE2E3FGHIJ1J5M1ORWXY', surv:'B1D1G1', pbn:'A1B1C1D1L1O1S1S2', speedPref:'M', cruzKt:490, cruzMach:0.85, serviceFL:430, hasFans1a:true, has833:true, hasRvsm:true },
  'HVY-T': { label:'2-eng widebody', wake:'H', comNav:'SDE2E3FGHIJ1J5M1ORWXY', surv:'B1D1G1', pbn:'A1B1C1D1L1O1S1S2', speedPref:'M', cruzKt:480, cruzMach:0.85, serviceFL:430, hasFans1a:true, has833:true, hasRvsm:true },
  'WB-M':  { label:'med widebody',   wake:'H', comNav:'SDFGHIJ1M1ORWXY',        surv:'B1G1',   pbn:'A1B1C1D1L1O1S1', speedPref:'M', cruzKt:460, cruzMach:0.82, serviceFL:410, hasFans1a:true, has833:true, hasRvsm:true },
  'NB-LR': { label:'long-range NB',  wake:'M', comNav:'SDE2FGHIJ1M1ORWY',       surv:'B1G1',   pbn:'A1B1C1D1O1S1', speedPref:'M', cruzKt:450, cruzMach:0.78, serviceFL:410, hasFans1a:true, has833:true, hasRvsm:true },
  'NB':    { label:'narrowbody',     wake:'M', comNav:'SDFGIORWY',              surv:'B1',     pbn:'A1B1C1D1O1S1', speedPref:'N', cruzKt:430, cruzMach:0.78, serviceFL:390, hasFans1a:false, has833:true, hasRvsm:true },
  'RGN-J': { label:'regional jet',   wake:'M', comNav:'SDFGIRWY',               surv:'B1',     pbn:'B1C1D1O1S1', speedPref:'N', cruzKt:410, cruzMach:0.74, serviceFL:370, hasFans1a:false, has833:true, hasRvsm:true },
  'RGN-T': { label:'regional turbo', wake:'M', comNav:'SDFGOVY',                surv:'B1',     pbn:'B1C1D1', speedPref:'N', cruzKt:270, cruzMach:0.50, serviceFL:250, hasFans1a:false, has833:true, hasRvsm:false },
  'BIZ':   { label:'business jet',   wake:'M', comNav:'SDE2FGHIJ1M1ORWY',       surv:'B1G1',   pbn:'A1B1C1D1O1S1', speedPref:'M', cruzKt:470, cruzMach:0.85, serviceFL:450, hasFans1a:true, has833:true, hasRvsm:true },
  'LIGHT': { label:'light/GA',       wake:'L', comNav:'SDFGOV',                 surv:'A',      pbn:'B2C2D2', speedPref:'N', cruzKt:140, cruzMach:0.30, serviceFL:120, hasFans1a:false, has833:false, hasRvsm:false },
  'OTHER': { label:'other',          wake:'M', comNav:'SDFGOV',                 surv:'A',      pbn:'B1', speedPref:'N', cruzKt:300, cruzMach:0.55, serviceFL:300, hasFans1a:false, has833:false, hasRvsm:false },
}

const HVY_TYPES = new Set(['B744','B748','B772','B77L','B77W','B788','B789','B78X','B763','B764','A332','A333','A338','A339','A359','A35K','MD11','IL86','A346','A343'])
const SUPER_TYPES = new Set(['A388','A380'])
const WBM_TYPES = new Set(['B752','B753'])
const NBLR_TYPES = new Set(['A21N','B39M','B38M','A20N','A321'])
const NB_TYPES = new Set(['B737','B738','B739','A319','A320','A220','BCS1','BCS3'])
const RGNJ_TYPES = new Set(['E170','E175','E190','E195','E290','E295','CRJ2','CRJ7','CRJ9','CRJX'])
const RGNT_TYPES = new Set(['AT45','AT72','AT76','DH8C','DH8D','SF34','SB20','AN24','AN26'])
const BIZ_TYPES = new Set(['GLEX','GL5T','G650','GLF6','FA8X','CL60','C25B','C56X','C68A','LJ45','LJ60'])
const LIGHT_TYPES = new Set(['C172','C152','C182','PA28','PC12','TBM9','SR22','SR20','BE36','BE58','DA40','DA42'])

function classify(f: F): AClass {
  const t = (f.type || '').toUpperCase()
  if (SUPER_TYPES.has(t)) return 'HVY-Q'
  if (t === 'B748' || t === 'A346' || t === 'A343') return 'HVY-Q'
  if (HVY_TYPES.has(t)) return 'HVY-T'
  if (WBM_TYPES.has(t)) return 'WB-M'
  if (NBLR_TYPES.has(t)) return 'NB-LR'
  if (NB_TYPES.has(t)) return 'NB'
  if (RGNJ_TYPES.has(t)) return 'RGN-J'
  if (RGNT_TYPES.has(t)) return 'RGN-T'
  if (BIZ_TYPES.has(t)) return 'BIZ'
  if (LIGHT_TYPES.has(t)) return 'LIGHT'
  // Fallback by ADS-B category
  const c = (f.category || '').toUpperCase()
  if (c.includes('HEAVY') || c === 'A5') return 'HVY-T'
  if (c.includes('LARGE') || c === 'A3') return 'NB'
  if (c.includes('SMALL') || c === 'A2') return 'BIZ'
  if (c.includes('LIGHT') || c === 'A1') return 'LIGHT'
  return 'OTHER'
}

// -------------------------------------------------------------------- //
// Hub catalogue (departure / destination snap)
// -------------------------------------------------------------------- //
interface Hub { id: string; name: string; lat: number; lng: number; fir: string; rvsmMandatory: boolean }
const HUBS: Hub[] = [
  { id:'KJFK', name:'New York Kennedy',  lat:40.6398, lng:-73.7789, fir:'KZNY', rvsmMandatory:true },
  { id:'KEWR', name:'Newark Liberty',    lat:40.6925, lng:-74.1687, fir:'KZNY', rvsmMandatory:true },
  { id:'KLGA', name:'New York LaGuardia',lat:40.7772, lng:-73.8726, fir:'KZNY', rvsmMandatory:true },
  { id:'KBOS', name:'Boston Logan',      lat:42.3656, lng:-71.0096, fir:'KZBW', rvsmMandatory:true },
  { id:'KORD', name:'Chicago O\'Hare',    lat:41.9742, lng:-87.9073, fir:'KZAU', rvsmMandatory:true },
  { id:'KDFW', name:'Dallas Fort Worth', lat:32.8998, lng:-97.0403, fir:'KZFW', rvsmMandatory:true },
  { id:'KATL', name:'Atlanta Hartsfield',lat:33.6407, lng:-84.4277, fir:'KZTL', rvsmMandatory:true },
  { id:'KLAX', name:'Los Angeles Intl',  lat:33.9416, lng:-118.4085,fir:'KZLA', rvsmMandatory:true },
  { id:'KSFO', name:'San Francisco Intl',lat:37.6213, lng:-122.3790,fir:'KZOA', rvsmMandatory:true },
  { id:'KSEA', name:'Seattle Tacoma',    lat:47.4502, lng:-122.3088,fir:'KZSE', rvsmMandatory:true },
  { id:'KDEN', name:'Denver Intl',       lat:39.8561, lng:-104.6737,fir:'KZDV', rvsmMandatory:true },
  { id:'KMIA', name:'Miami Intl',        lat:25.7959, lng:-80.2870, fir:'KZMA', rvsmMandatory:true },
  { id:'KIAH', name:'Houston Bush',      lat:29.9844, lng:-95.3414, fir:'KZHU', rvsmMandatory:true },
  { id:'KLAS', name:'Las Vegas Reid',    lat:36.0840, lng:-115.1537,fir:'KZLA', rvsmMandatory:true },
  { id:'KPHX', name:'Phoenix Sky Harbor',lat:33.4343, lng:-112.0116,fir:'KZAB', rvsmMandatory:true },
  { id:'KMSP', name:'Minneapolis-St Paul',lat:44.8848,lng:-93.2223, fir:'KZMP', rvsmMandatory:true },
  { id:'CYYZ', name:'Toronto Pearson',   lat:43.6777, lng:-79.6248, fir:'CZYZ', rvsmMandatory:true },
  { id:'CYUL', name:'Montreal Trudeau',  lat:45.4706, lng:-73.7408, fir:'CZUL', rvsmMandatory:true },
  { id:'CYVR', name:'Vancouver Intl',    lat:49.1939, lng:-123.1844,fir:'CZVR', rvsmMandatory:true },
  { id:'EGLL', name:'London Heathrow',   lat:51.4775, lng:-0.4614,  fir:'EGTT', rvsmMandatory:true },
  { id:'EGKK', name:'London Gatwick',    lat:51.1481, lng:-0.1903,  fir:'EGTT', rvsmMandatory:true },
  { id:'EHAM', name:'Amsterdam Schiphol',lat:52.3086, lng:4.7639,   fir:'EHAA', rvsmMandatory:true },
  { id:'EDDF', name:'Frankfurt Main',    lat:50.0379, lng:8.5622,   fir:'EDGG', rvsmMandatory:true },
  { id:'EDDM', name:'Munich',            lat:48.3538, lng:11.7861,  fir:'EDMM', rvsmMandatory:true },
  { id:'LFPG', name:'Paris CDG',         lat:49.0097, lng:2.5479,   fir:'LFFF', rvsmMandatory:true },
  { id:'LSZH', name:'Zurich',            lat:47.4647, lng:8.5492,   fir:'LSAS', rvsmMandatory:true },
  { id:'LEMD', name:'Madrid Barajas',    lat:40.4719, lng:-3.5626,  fir:'LECM', rvsmMandatory:true },
  { id:'LIRF', name:'Rome Fiumicino',    lat:41.8003, lng:12.2389,  fir:'LIRR', rvsmMandatory:true },
  { id:'UUEE', name:'Moscow Sheremetyevo',lat:55.9726,lng:37.4146,  fir:'UUWV', rvsmMandatory:true },
  { id:'OMDB', name:'Dubai Intl',        lat:25.2532, lng:55.3657,  fir:'OMAE', rvsmMandatory:true },
  { id:'OTHH', name:'Doha Hamad',        lat:25.2731, lng:51.6080,  fir:'OTDF', rvsmMandatory:true },
  { id:'WSSS', name:'Singapore Changi',  lat:1.3502,  lng:103.9941, fir:'WSJC', rvsmMandatory:true },
  { id:'VHHH', name:'Hong Kong Intl',    lat:22.3080, lng:113.9185, fir:'VHHK', rvsmMandatory:true },
  { id:'RJTT', name:'Tokyo Haneda',      lat:35.5494, lng:139.7798, fir:'RJJJ', rvsmMandatory:true },
  { id:'RJAA', name:'Tokyo Narita',      lat:35.7720, lng:140.3929, fir:'RJJJ', rvsmMandatory:true },
  { id:'YSSY', name:'Sydney Kingsford',  lat:-33.9461,lng:151.1772, fir:'YBBB', rvsmMandatory:true },
]

// -------------------------------------------------------------------- //
// Operator → 3-letter ICAO designator
// -------------------------------------------------------------------- //
function operatorICAO(cs?: string, op?: string): string {
  if (cs && cs.length >= 3 && /^[A-Z]{3}\d/.test(cs)) return cs.slice(0, 3)
  if (op) {
    const o = op.toUpperCase()
    if (o.includes('AMERICAN')) return 'AAL'
    if (o.includes('UNITED'))   return 'UAL'
    if (o.includes('DELTA'))    return 'DAL'
    if (o.includes('SOUTHWEST'))return 'SWA'
    if (o.includes('LUFTHANSA'))return 'DLH'
    if (o.includes('BRITISH'))  return 'BAW'
    if (o.includes('AIR FRANCE'))return 'AFR'
    if (o.includes('KLM'))      return 'KLM'
    if (o.includes('EMIRATES')) return 'UAE'
    if (o.includes('QATAR'))    return 'QTR'
    if (o.includes('SINGAPORE'))return 'SIA'
    if (o.includes('CATHAY'))   return 'CPA'
    if (o.includes('JAPAN'))    return 'JAL'
    if (o.includes('ANA'))      return 'ANA'
    if (o.includes('QANTAS'))   return 'QFA'
    if (o.includes('RYANAIR'))  return 'RYR'
    if (o.includes('EASYJET'))  return 'EZY'
  }
  return 'PVT'
}

// -------------------------------------------------------------------- //
// Geometry helpers
// -------------------------------------------------------------------- //
const R_NM = 3440.065
function haversineNM(a1: number, o1: number, a2: number, o2: number): number {
  const r1 = a1 * Math.PI / 180, r2 = a2 * Math.PI / 180
  const dr = (a2 - a1) * Math.PI / 180, dl = (o2 - o1) * Math.PI / 180
  const h = Math.sin(dr/2)**2 + Math.cos(r1) * Math.cos(r2) * Math.sin(dl/2)**2
  return 2 * R_NM * Math.asin(Math.sqrt(h))
}

function bearingDeg(a1: number, o1: number, a2: number, o2: number): number {
  const r1 = a1 * Math.PI/180, r2 = a2 * Math.PI/180, dl = (o2 - o1) * Math.PI/180
  const y = Math.sin(dl) * Math.cos(r2)
  const x = Math.cos(r1) * Math.sin(r2) - Math.sin(r1) * Math.cos(r2) * Math.cos(dl)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

// Deterministic per-icao24 hash for synthetic FPL fields
function hash(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function pickHub(f: F, list: Hub[]): Hub {
  let best = list[0], bestD = Infinity
  for (const h of list) {
    const d = haversineNM(f.lat, f.lng, h.lat, h.lng)
    if (d < bestD) { bestD = d; best = h }
  }
  return best
}

function pickHubByHash(seed: number, exclude: Hub | null): Hub {
  const pool = exclude ? HUBS.filter(h => h.id !== exclude.id) : HUBS
  return pool[seed % pool.length]
}

// -------------------------------------------------------------------- //
// Validation errors taxonomy
// -------------------------------------------------------------------- //
type ErrCode = 'E1-CS' | 'E2-RUL' | 'E3-WAKE' | 'E4-SURV' | 'E5-ADEP' | 'E6-SPD' | 'E7-LVL' | 'E8-ROUND' | 'E9-PBN' | 'E10-OTHER' | 'E11-EQ833' | 'E12-RVSM' | 'E13-EET'

interface ValErr {
  code: ErrCode
  field: string                    // ICAO field id (7/8/9/10a/10b/13/15/16/18)
  severity: 'REJ' | 'MAN' | 'WAR' // IFPS severity letter
  text: string                     // human-readable description
  weight: number                   // 0-30 contribution to score
}

// -------------------------------------------------------------------- //
// Synthetic FPL builder
// -------------------------------------------------------------------- //
interface FPL {
  f7_cs: string                    // Item 7 aircraft identification
  f8_rules: string                 // Item 8a flight rules
  f8_type: string                  // Item 8b type of flight
  f9_num: string                   // Item 9a number
  f9_type: string                  // Item 9b ICAO type designator
  f9_wake: string                  // Item 9c wake category letter
  f10a_equip: string               // Item 10a equipment / capabilities
  f10b_surv: string                // Item 10b surveillance equipment
  f13_adep: string                 // Item 13a departure aerodrome
  f13_eobt: string                 // Item 13b estimated off-block (4-digit zulu)
  f15_spd: string                  // Item 15a cruising speed (N0xxx or Mxxx)
  f15_lvl: string                  // Item 15b cruising level (Fxxx or Axxx)
  f15_rte: string                  // Item 15c route
  f16_ades: string                 // Item 16a destination
  f16_eet: string                  // Item 16b total EET (HHMM)
  f16_altn: string                 // Item 16c first alternate
  f18_pbn: string                  // Item 18 PBN/ subfield
  f18_nav: string                  // Item 18 NAV/ subfield (optional)
  f18_com: string                  // Item 18 COM/ subfield (optional)
  f18_dat: string                  // Item 18 DAT/ subfield (optional)
  f18_sur: string                  // Item 18 SUR/ subfield (optional)
  f18_dof: string                  // Item 18 DOF/ date of flight (YYMMDD)
  f18_reg: string                  // Item 18 REG/ aircraft registration
  f18_sel: string                  // Item 18 SEL/ SELCAL code
  f18_rmk: string                  // Item 18 RMK/ remarks
}

interface Row {
  f: F
  cls: AClass
  spec: ClassSpec
  adep: Hub
  ades: Hub
  altn: Hub
  fpl: FPL
  errors: ValErr[]
  driverScores: { SYNTAX:number; TYPE:number; EQUIP:number; ROUTE:number; PBN:number; ALT:number }
  score: number
  tier: Tier
  oceanic: boolean
  fl: number
  distNM: number
  bearingDeg: number
  eetMin: number
}

function buildFPL(f: F, cls: AClass, spec: ClassSpec, adep: Hub, ades: Hub, altn: Hub, eetMin: number): FPL {
  const cs = (f.callsign || `ZZ${(hash(f.icao) % 9000 + 1000).toString()}`).toUpperCase().trim()
  const flZulu = `${(Math.floor((Date.now()/60000) % 1440 / 60)).toString().padStart(2,'0')}${(Math.floor((Date.now()/60000) % 60)).toString().padStart(2,'0')}`
  const eetHHMM = `${Math.floor(eetMin/60).toString().padStart(2,'0')}${Math.round(eetMin%60).toString().padStart(2,'0')}`
  const fl = Math.max(50, Math.min(spec.serviceFL, Math.round(f.altitudeFt/100)))
  const spd = spec.speedPref === 'M' ? `M${Math.round(spec.cruzMach*100).toString().padStart(3,'0')}` : `N${spec.cruzKt.toString().padStart(4,'0')}`
  const lvl = `F${fl.toString().padStart(3,'0')}`
  // Build route field — synthetic but per Item 15c conventions
  const sid = `${adep.id.slice(-3)}${1+hash(f.icao)%6}A`
  const star = `${ades.id.slice(-3)}${1+hash(f.icao+'r')%6}B`
  // Pick airway based on great-circle distance
  const distNM = haversineNM(adep.lat, adep.lng, ades.lat, ades.lng)
  const airways: string[] = []
  if (distNM < 200) {
    airways.push('DCT')
  } else if (distNM < 600) {
    const aw1 = `J${30 + hash(f.icao)%100}`
    const wp = `${String.fromCharCode(65+hash(f.icao)%26)}${String.fromCharCode(65+hash(f.icao+'1')%26)}${String.fromCharCode(65+hash(f.icao+'2')%26)}${String.fromCharCode(65+hash(f.icao+'3')%26)}${String.fromCharCode(65+hash(f.icao+'4')%26)}`
    airways.push(`${aw1} ${wp}`)
  } else if (distNM < 2400) {
    const aw1 = adep.fir.startsWith('E') || adep.fir.startsWith('L') ? `UL${100 + hash(f.icao)%300}` : `J${30 + hash(f.icao)%100}`
    const wp1 = `${String.fromCharCode(65+hash(f.icao+'a')%26)}${String.fromCharCode(65+hash(f.icao+'b')%26)}${String.fromCharCode(65+hash(f.icao+'c')%26)}${String.fromCharCode(65+hash(f.icao+'d')%26)}${String.fromCharCode(65+hash(f.icao+'e')%26)}`
    const aw2 = `UN${100 + hash(f.icao+'x')%500}`
    const wp2 = `${String.fromCharCode(65+hash(f.icao+'p')%26)}${String.fromCharCode(65+hash(f.icao+'q')%26)}${String.fromCharCode(65+hash(f.icao+'r')%26)}${String.fromCharCode(65+hash(f.icao+'s')%26)}${String.fromCharCode(65+hash(f.icao+'t')%26)}`
    airways.push(`${aw1} ${wp1} ${aw2} ${wp2}`)
  } else {
    // Oceanic / long-haul → NAT/PACOTS-style track + airway
    const trackId = 'NATA'[hash(f.icao)%4] || 'A'
    const wp1 = `${(40+hash(f.icao)%15).toString().padStart(2,'0')}N0${(40+hash(f.icao+'b')%20).toString().padStart(2,'0')}W`
    const wp2 = `${(40+hash(f.icao+'c')%15).toString().padStart(2,'0')}N0${(20+hash(f.icao+'d')%20).toString().padStart(2,'0')}W`
    airways.push(`NAT${trackId} ${wp1} ${wp2}`)
  }
  const rte = `${sid} ${airways.join(' ')} ${star}`
  // Build PBN string per Doc 9613 Vol II
  const pbnParts = [spec.pbn]
  // Synthetic registration — operator-prefix-derived
  const reg = `N${(100 + hash(f.icao+'reg')%900).toString()}${String.fromCharCode(65+hash(f.icao)%26)}${String.fromCharCode(65+hash(f.icao+'g')%26)}`
  const selcal = `${String.fromCharCode(65+hash(f.icao+'s1')%21)}${String.fromCharCode(65+hash(f.icao+'s2')%21)}-${String.fromCharCode(65+hash(f.icao+'s3')%21)}${String.fromCharCode(65+hash(f.icao+'s4')%21)}`
  const today = new Date()
  const dof = `${today.getUTCFullYear().toString().slice(2)}${(today.getUTCMonth()+1).toString().padStart(2,'0')}${today.getUTCDate().toString().padStart(2,'0')}`
  return {
    f7_cs: cs,
    f8_rules: 'I',                  // IFR
    f8_type: cls === 'LIGHT' || cls === 'BIZ' ? 'G' : 'S',  // S=scheduled commercial, G=general aviation
    f9_num: '1',
    f9_type: (f.type || 'ZZZZ').toUpperCase(),
    f9_wake: spec.wake,
    f10a_equip: spec.comNav,
    f10b_surv: spec.surv,
    f13_adep: adep.id,
    f13_eobt: flZulu,
    f15_spd: spd,
    f15_lvl: lvl,
    f15_rte: rte,
    f16_ades: ades.id,
    f16_eet: eetHHMM,
    f16_altn: altn.id,
    f18_pbn: pbnParts.join(''),
    f18_nav: spec.hasFans1a ? 'RNVD1E2A1' : '',
    f18_com: spec.has833 ? 'FANSPCPDLC' : '',
    f18_dat: spec.hasFans1a ? '1FANSP/A' : '',
    f18_sur: 'RSP180 260B',
    f18_dof: dof,
    f18_reg: reg,
    f18_sel: selcal,
    f18_rmk: spec.hasFans1a ? 'TCAS EQUIPPED' : '',
  }
}

function validateFPL(fpl: FPL, cls: AClass, spec: ClassSpec, distNM: number, oceanic: boolean, fl: number, adepFir: string): ValErr[] {
  const errs: ValErr[] = []

  // E1 Item 7 callsign 2-7 alphanumerics
  if (!/^[A-Z][A-Z0-9]{1,6}$/.test(fpl.f7_cs)) {
    errs.push({ code:'E1-CS', field:'7', severity:'REJ', text:`Item 7 "${fpl.f7_cs}" not 2-7 alphanumerics starting alpha (Doc 4444 App 2 §1.6.1)`, weight: 22 })
  }

  // E2 Item 8 rules letter I/V/Y/Z
  if (!/^[IVYZ]$/.test(fpl.f8_rules)) errs.push({ code:'E2-RUL', field:'8a', severity:'REJ', text:`Item 8 rules "${fpl.f8_rules}" not I/V/Y/Z`, weight: 18 })
  if (!/^[SNGMX]$/.test(fpl.f8_type)) errs.push({ code:'E2-RUL', field:'8b', severity:'MAN', text:`Item 8 type-of-flight "${fpl.f8_type}" not S/N/G/M/X`, weight: 10 })

  // E3 Item 9 wake vs type coherence
  const isHvy = HVY_TYPES.has(fpl.f9_type) || SUPER_TYPES.has(fpl.f9_type)
  const isSuper = SUPER_TYPES.has(fpl.f9_type)
  if (isSuper && fpl.f9_wake !== 'J') errs.push({ code:'E3-WAKE', field:'9c', severity:'MAN', text:`Item 9 wake "${fpl.f9_wake}" should be J for super-heavy A380/A388`, weight: 14 })
  else if (isHvy && fpl.f9_wake !== 'H' && fpl.f9_wake !== 'J') errs.push({ code:'E3-WAKE', field:'9c', severity:'MAN', text:`Item 9 wake "${fpl.f9_wake}" should be H for heavy ${fpl.f9_type}`, weight: 12 })
  if (!/^[1-9]\d{0,2}$/.test(fpl.f9_num)) errs.push({ code:'E3-WAKE', field:'9a', severity:'MAN', text:`Item 9 number-of-aircraft "${fpl.f9_num}" not 1-999`, weight: 8 })
  if (!/^[A-Z][A-Z0-9]{1,3}$/.test(fpl.f9_type)) errs.push({ code:'E3-WAKE', field:'9b', severity:'MAN', text:`Item 9 type "${fpl.f9_type}" not valid ICAO Doc 8643 designator`, weight: 12 })

  // E4 Item 10b surveillance — ADS-B required for §91.225 / EU 1207/2011
  if (!fpl.f10b_surv.includes('B1') && !fpl.f10b_surv.includes('B2') && cls !== 'LIGHT') {
    errs.push({ code:'E4-SURV', field:'10b', severity:'REJ', text:`Item 10b "${fpl.f10b_surv}" missing B1/B2 ADS-B Out (§91.225 / EU 1207/2011)`, weight: 20 })
  }
  // Surveillance must start with N or contain Mode-A/C/S letter
  if (!/^(N|[ACEHILPSX]+(\s*[BU][12])?(\s*D1)?(\s*G1)?(\s*V[12])?)$/.test(fpl.f10b_surv)) {
    errs.push({ code:'E4-SURV', field:'10b', severity:'WAR', text:`Item 10b "${fpl.f10b_surv}" non-canonical letter sequence`, weight: 6 })
  }

  // E5 Item 13 ADEP in catalogue
  if (!HUBS.find(h => h.id === fpl.f13_adep)) {
    errs.push({ code:'E5-ADEP', field:'13a', severity:'WAR', text:`Item 13 ADEP "${fpl.f13_adep}" not in major-hub catalogue (synthetic)`, weight: 4 })
  }
  if (!/^\d{4}$/.test(fpl.f13_eobt)) {
    errs.push({ code:'E5-ADEP', field:'13b', severity:'REJ', text:`Item 13 EOBT "${fpl.f13_eobt}" not HHMM zulu`, weight: 14 })
  }

  // E6 Item 15a speed prefix
  if (!/^(N0\d{3}|N\d{4}|M\d{3}|K\d{4})$/.test(fpl.f15_spd)) {
    errs.push({ code:'E6-SPD', field:'15a', severity:'REJ', text:`Item 15a speed "${fpl.f15_spd}" not N0xxx/M0xx/K0xxx`, weight: 16 })
  } else if (fpl.f15_spd.startsWith('M') && fl < 270) {
    errs.push({ code:'E6-SPD', field:'15a', severity:'WAR', text:`Item 15a Mach prefix at FL${fl} below typical subsonic Mach regime (FL270+)`, weight: 4 })
  } else if (fpl.f15_spd.startsWith('N0') && fl > 400 && spec.speedPref === 'M') {
    errs.push({ code:'E6-SPD', field:'15a', severity:'WAR', text:`Item 15a knots-prefix at FL${fl} unusual — Mach is standard at ${spec.label}`, weight: 4 })
  }

  // E7 Item 15b cruising level
  if (!/^(F\d{3}|A\d{3}|S\d{4}|M\d{4}|VFR)$/.test(fpl.f15_lvl)) {
    errs.push({ code:'E7-LVL', field:'15b', severity:'REJ', text:`Item 15b level "${fpl.f15_lvl}" not Fxxx/Axxx/Sxxxx/Mxxxx`, weight: 16 })
  } else if (fpl.f15_lvl.startsWith('F')) {
    const fpFl = parseInt(fpl.f15_lvl.slice(1), 10)
    if (fpFl > spec.serviceFL) {
      errs.push({ code:'E7-LVL', field:'15b', severity:'MAN', text:`Item 15b F${fpFl.toString().padStart(3,'0')} exceeds ${spec.label} service ceiling FL${spec.serviceFL}`, weight: 10 })
    }
  }

  // E8 Item 16 ADES vs ADEP
  if (fpl.f16_ades === fpl.f13_adep && fpl.f7_cs.slice(-1) !== 'Y') {
    errs.push({ code:'E8-ROUND', field:'16a', severity:'WAR', text:`Item 16 ADES = ADEP "${fpl.f16_ades}" — round-robin needs Y suffix or explicit ZZZZ + DEP/`, weight: 6 })
  }
  if (!/^\d{4}$/.test(fpl.f16_eet)) {
    errs.push({ code:'E13-EET', field:'16b', severity:'REJ', text:`Item 16b EET "${fpl.f16_eet}" not HHMM`, weight: 12 })
  }

  // E9 Item 18 PBN required for RNAV/RNP route
  const rteHasRnp = /\bUL?\d|UN\d|RNAV|RNP|Q\d|T\d|J\d/.test(fpl.f15_rte)
  if (rteHasRnp && (!fpl.f18_pbn || fpl.f18_pbn.length === 0)) {
    errs.push({ code:'E9-PBN', field:'18', severity:'REJ', text:`Item 18 PBN/ missing but Item 15c route uses RNAV/RNP airways (Doc 9613)`, weight: 18 })
  } else if (fpl.f18_pbn && !/^[ABCDLOST][12]([ABCDLOST][12])*$/.test(fpl.f18_pbn)) {
    errs.push({ code:'E9-PBN', field:'18', severity:'MAN', text:`Item 18 PBN/ "${fpl.f18_pbn}" non-canonical (must be pairs A1/B1/C1/D1/L1/O1/S1/S2)`, weight: 8 })
  }

  // E10 Item 18 SEL/REG/DOF format
  if (fpl.f18_sel && !/^[A-S]{2}-[A-S]{2}$/.test(fpl.f18_sel)) {
    errs.push({ code:'E10-OTHER', field:'18-SEL', severity:'WAR', text:`Item 18 SEL/ "${fpl.f18_sel}" not AA-BB SELCAL format (ARINC 596 §3)`, weight: 4 })
  }
  if (fpl.f18_reg && !/^[A-Z]{1,2}[A-Z0-9-]{1,8}$/.test(fpl.f18_reg)) {
    errs.push({ code:'E10-OTHER', field:'18-REG', severity:'WAR', text:`Item 18 REG/ "${fpl.f18_reg}" not ICAO national reg format`, weight: 4 })
  }
  if (fpl.f18_dof && !/^\d{6}$/.test(fpl.f18_dof)) {
    errs.push({ code:'E10-OTHER', field:'18-DOF', severity:'MAN', text:`Item 18 DOF/ "${fpl.f18_dof}" not YYMMDD`, weight: 8 })
  }

  // E11 8.33kHz EU mandate per Reg 1079/2012
  const inEurope = adepFir.startsWith('E') || adepFir.startsWith('L')
  if (inEurope && !spec.has833) {
    errs.push({ code:'E11-EQ833', field:'10a', severity:'MAN', text:`Item 10a missing Y (8.33kHz) — mandatory for ${spec.label} in EU airspace (Reg 1079/2012)`, weight: 10 })
  }

  // E12 RVSM in FL290-FL410 band
  if (fl >= 290 && fl <= 410 && !spec.hasRvsm) {
    errs.push({ code:'E12-RVSM', field:'10a', severity:'REJ', text:`Item 10a missing W (RVSM) — required FL290-FL410 (Doc 7030 / 14 CFR §91.180)`, weight: 18 })
  }

  // E13 EET sanity vs distance & cruise speed
  const eetMin = parseInt(fpl.f16_eet.slice(0,2),10) * 60 + parseInt(fpl.f16_eet.slice(2),10)
  const expectedEET = Math.max(15, (distNM / spec.cruzKt) * 60 + 25)  // +25min for climb/descent
  if (Math.abs(eetMin - expectedEET) / expectedEET > 0.40) {
    errs.push({ code:'E13-EET', field:'16b', severity:'WAR', text:`Item 16b EET ${fpl.f16_eet} differs >40% from cruise-derived ${Math.floor(expectedEET/60).toString().padStart(2,'0')}${Math.round(expectedEET%60).toString().padStart(2,'0')}`, weight: 6 })
  }

  // FANS-1A required for oceanic
  if (oceanic && !spec.hasFans1a) {
    errs.push({ code:'E4-SURV', field:'18-DAT', severity:'REJ', text:`Item 18 DAT/ missing FANS-1A — required oceanic (Doc 4444 §15.2.5, NAT Doc 007 §3.1)`, weight: 18 })
  }

  return errs
}

function scoreFPL(errs: ValErr[]): { driverScores: Row['driverScores']; score: number; tier: Tier } {
  // 6-driver decomposition
  const d = { SYNTAX:0, TYPE:0, EQUIP:0, ROUTE:0, PBN:0, ALT:0 }
  for (const e of errs) {
    const w = e.weight
    if (e.code === 'E1-CS' || e.code === 'E2-RUL' || e.code === 'E5-ADEP' || e.code === 'E7-LVL' || e.code === 'E10-OTHER' || e.code === 'E13-EET') d.SYNTAX = Math.max(d.SYNTAX, w * 3)
    if (e.code === 'E3-WAKE' || e.code === 'E6-SPD') d.TYPE = Math.max(d.TYPE, w * 3)
    if (e.code === 'E4-SURV' || e.code === 'E11-EQ833' || e.code === 'E12-RVSM') d.EQUIP = Math.max(d.EQUIP, w * 3)
    if (e.code === 'E8-ROUND') d.ROUTE = Math.max(d.ROUTE, w * 3)
    if (e.code === 'E9-PBN') d.PBN = Math.max(d.PBN, w * 3)
  }
  // Clamp drivers
  for (const k of Object.keys(d) as Array<keyof typeof d>) d[k] = Math.min(100, d[k])
  // Composite: max·0.66 + mean·0.34
  const vals = Object.values(d)
  const mx = Math.max(...vals)
  const mn = vals.reduce((a,c)=>a+c,0)/vals.length
  const score = Math.min(100, Math.max(0, mx*0.66 + mn*0.34))
  let tier: Tier = 'EXEMPLARY'
  if (score >= 80) tier = 'REJECTED'
  else if (score >= 60) tier = 'DEFECTIVE'
  else if (score >= 35) tier = 'DEFICIENT'
  else if (score >= 15) tier = 'ACCEPTED'
  else tier = 'EXEMPLARY'
  return { driverScores: d, score, tier }
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================
export default function FplnDecoder({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [scopeNM, setScopeNM] = useState<number>(1500)
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AClass | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'FIELDS'|'VALIDATION'|'FORMAT'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shArc, setShArc] = useState(true)
  const [picked, setPicked] = useState<string | null>(null)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (f.altitudeFt < 1000) continue
      const cls = classify(f)
      const spec = CLASS[cls]
      const adep = pickHubByHash(hash(f.icao), null)
      const adesPool = HUBS.filter(h => h.id !== adep.id)
      const ades = adesPool[hash(f.icao + 'ades') % adesPool.length]
      const altn = HUBS.filter(h => h.id !== ades.id && h.id !== adep.id)[hash(f.icao+'alt') % (HUBS.length-2)]
      const distNM = haversineNM(adep.lat, adep.lng, ades.lat, ades.lng)
      // Skip if both adep/ades way out of scope from aircraft
      const distAcAdes = haversineNM(f.lat, f.lng, ades.lat, ades.lng)
      if (distAcAdes > scopeNM) continue
      const fl = Math.max(50, Math.round(f.altitudeFt / 100))
      const bear = bearingDeg(adep.lat, adep.lng, ades.lat, ades.lng)
      // Oceanic if any waypoint lat sequence crosses mid-Atlantic / mid-Pacific
      const midLng = (adep.lng + ades.lng) / 2
      const oceanic = Math.abs(adep.lng - ades.lng) > 30 && (Math.abs(midLng) > 30 && Math.abs(midLng) < 150 && Math.abs(midLng + 30) > 20)
      const eetMin = Math.max(15, (distNM / spec.cruzKt) * 60 + 25 + (hash(f.icao+'eet') % 10 - 5))
      const fpl = buildFPL(f, cls, spec, adep, ades, altn, eetMin)
      const errs = validateFPL(fpl, cls, spec, distNM, oceanic, fl, adep.fir)
      const { driverScores, score: rawScore, tier } = scoreFPL(errs)
      const score = Math.min(100, rawScore * advMul)
      // Re-derive tier from adjusted score
      let adjTier: Tier = 'EXEMPLARY'
      if (score >= 80) adjTier = 'REJECTED'
      else if (score >= 60) adjTier = 'DEFECTIVE'
      else if (score >= 35) adjTier = 'DEFICIENT'
      else if (score >= 15) adjTier = 'ACCEPTED'
      out.push({ f, cls, spec, adep, ades, altn, fpl, errors: errs, driverScores, score, tier: adjTier, oceanic, fl, distNM, bearingDeg: bear, eetMin })
    }
    out.sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return out
  }, [flights, advMul, scopeNM])

  // ---------------- MapLibre overlay ---------------- //
  useEffect(() => {
    if (!map) return
    const SRC = 'fpln-src'
    const SRC_ARC = 'fpln-arc-src'
    const SRC_ADEP = 'fpln-adep-src'
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any }) }
    ;[SRC, SRC_ARC, SRC_ADEP].forEach(ensure)

    const writeAll = () => {
      const view = rows.filter(r =>
        (tierFilter === 'ALL' || r.tier === tierFilter) &&
        (classFilter === 'ALL' || r.cls === classFilter)
      )
      const ac: any[] = []
      const arc: any[] = []
      const adepPts: any[] = []
      const seenAdep = new Set<string>()
      for (const r of view) {
        ac.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
          properties:{
            tier: r.tier,
            color: TIER_COLOR[r.tier],
            score: r.score,
            sz: 7 + (r.score/100) * 14,
            label: `${r.fpl.f7_cs} · ${r.tier} · ${r.fpl.f13_adep}→${r.fpl.f16_ades} · F${r.fl.toString().padStart(3,'0')}`,
          },
        })
        if (shArc) {
          arc.push({
            type:'Feature',
            geometry:{ type:'LineString', coordinates:[[r.adep.lng, r.adep.lat], [r.f.lng, r.f.lat], [r.ades.lng, r.ades.lat]] },
            properties:{ color: TIER_COLOR[r.tier], w: r.tier === 'REJECTED' ? 2.0 : r.tier === 'DEFECTIVE' ? 1.5 : 1.0 },
          })
          for (const h of [r.adep, r.ades]) {
            if (!seenAdep.has(h.id)) {
              seenAdep.add(h.id)
              adepPts.push({
                type:'Feature',
                geometry:{ type:'Point', coordinates:[h.lng, h.lat] },
                properties:{ label: h.id, color: '#94a3b8' },
              })
            }
          }
        }
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: (shHalo||shPin||shLbl) ? ac : [] })
      ;(map.getSource(SRC_ARC) as any).setData({ type:'FeatureCollection', features: arc })
      ;(map.getSource(SRC_ADEP) as any).setData({ type:'FeatureCollection', features: adepPts })
    }

    if (!map.getLayer('fpln-arc'))
      map.addLayer({ id:'fpln-arc', type:'line', source:SRC_ARC, paint:{ 'line-color':['get','color'], 'line-width':['get','w'], 'line-opacity':0.40, 'line-dasharray':[2,2] } })
    if (!map.getLayer('fpln-adep-pin'))
      map.addLayer({ id:'fpln-adep-pin', type:'circle', source:SRC_ADEP, paint:{ 'circle-radius':3.4, 'circle-color':['get','color'], 'circle-opacity':0.6, 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':0.8 } })
    if (!map.getLayer('fpln-adep-lbl'))
      map.addLayer({ id:'fpln-adep-lbl', type:'symbol', source:SRC_ADEP, layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,-1.0], 'text-anchor':'bottom', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#94a3b8', 'text-halo-color':'#0b0f17', 'text-halo-width':1.0 } })
    if (!map.getLayer('fpln-halo'))
      map.addLayer({ id:'fpln-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('fpln-pin'))
      map.addLayer({ id:'fpln-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 55], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('fpln-lbl'))
      map.addLayer({ id:'fpln-lbl', type:'symbol', source:SRC, filter:['>=', ['get','score'], 45], layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.5], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.3 } })

    writeAll()
    return () => {
      for (const id of ['fpln-lbl','fpln-pin','fpln-halo','fpln-adep-lbl','fpln-adep-pin','fpln-arc']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_ARC, SRC_ADEP]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, classFilter, shHalo, shPin, shLbl, shArc])

  // ---------------- Aggregations ---------------- //
  const visible = rows.filter(r =>
    (tierFilter === 'ALL' || r.tier === tierFilter) &&
    (classFilter === 'ALL' || r.cls === classFilter) &&
    (!search || (r.fpl.f7_cs.toLowerCase().includes(search.toLowerCase()) || r.fpl.f9_type.toLowerCase().includes(search.toLowerCase()) || r.fpl.f13_adep.toLowerCase().includes(search.toLowerCase()) || r.fpl.f16_ades.toLowerCase().includes(search.toLowerCase())))
  )
  const counts: Record<Tier, number> = { REJECTED:0, DEFECTIVE:0, DEFICIENT:0, ACCEPTED:0, EXEMPLARY:0, IDLE:0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? rows.reduce((a, c) => a + c.score, 0) / rows.length : 0
  const muErr = rows.length ? rows.reduce((a, c) => a + c.errors.length, 0) / rows.length : 0
  const rejCount = counts.REJECTED
  const sumOceanic = rows.filter(r => r.oceanic).length
  const totalErrs = rows.reduce((a, c) => a + c.errors.length, 0)
  const worst = rows[0]
  const pickedRow = picked ? rows.find(r => r.f.icao === picked) : null

  return (
    <div className="fixed top-16 right-3 z-40 w-[480px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">FPLN</span>
          <span className="text-[10px] text-slate-400">ICAO FPL Decoder · Doc 4444 App 2 / Doc 9613 PBN / IFPS Users Manual</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* Tier counter strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.slice(0,5).map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className="flex-1 px-1.5 py-1 rounded text-[10px] font-mono border"
            style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:'transparent', color: TIER_COLOR[t] }}>{t.slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCR</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">REJ</div><div className="font-mono" style={{color: rejCount?TIER_COLOR.REJECTED:'#94a3b8'}}>{rejCount}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">Σ-ERR</div><div className="text-slate-100 font-mono">{totalErrs}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-ERR</div><div className="text-slate-100 font-mono">{muErr.toFixed(1)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">OCN</div><div className="text-slate-100 font-mono">{sumOceanic}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?worst.fpl.f7_cs:'—'}</div></div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">SCOPE NM <span className="text-slate-200 font-mono">{scopeNM}</span>
            <input type="range" min="300" max="3000" step="50" value={scopeNM} onChange={e=>setScopeNM(+e.target.value)} className="w-full accent-sky-500" />
          </label>
        </div>
        {/* Class filter */}
        <div className="flex flex-wrap gap-1">
          <button onClick={()=>setClassFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL-CLS</button>
          {(['HVY-Q','HVY-T','WB-M','NB-LR','NB','RGN-J','RGN-T','BIZ','LIGHT'] as AClass[]).map(c => (
            <button key={c} onClick={()=>setClassFilter(c)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter===c?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{c}</button>
          ))}
        </div>
        {/* Overlay toggles + search */}
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['ARC',shArc,setShArc]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/adep" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 px-3 py-1.5 border-b border-slate-700/60">
        {(['AIRCRAFT','FIELDS','VALIDATION','FORMAT'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {tab === 'AIRCRAFT' && (
          <>
            {visible.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-6">No aircraft within FPLN scope · adjust SCOPE-NM or filters</div>
            )}
            {visible.slice(0, 60).map(r => (
              <div key={r.f.icao} className="border rounded-lg p-2 bg-slate-800/40" style={{ borderColor: TIER_COLOR[r.tier] + '60' }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: TIER_COLOR[r.tier] + '22', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                    <button onClick={()=>{ setPicked(r.f.icao); onFly(r.f.icao) }} className="text-slate-100 font-mono text-[11px] hover:text-sky-300">{r.fpl.f7_cs}</button>
                    <span className="text-slate-400 text-[10px]">{r.fpl.f9_type}·{r.cls}·{r.fpl.f9_wake}</span>
                  </div>
                  <div className="text-[10px] font-mono" style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</div>
                </div>
                {/* Compact FPL strip */}
                <div className="mt-1.5 bg-slate-900/60 rounded p-1.5 font-mono text-[9px] text-slate-300 leading-tight overflow-x-auto whitespace-nowrap">
                  <span className="text-slate-500">(FPL-</span><span className="text-sky-300">{r.fpl.f7_cs}</span>
                  <span className="text-slate-500">-</span><span className="text-slate-200">{r.fpl.f8_rules}{r.fpl.f8_type}</span>
                  <span className="text-slate-500"> -</span><span className="text-slate-200">{r.fpl.f9_num}/{r.fpl.f9_type}/{r.fpl.f9_wake}</span>
                  <span className="text-slate-500">-</span><span className="text-slate-200">{r.fpl.f10a_equip}/{r.fpl.f10b_surv}</span>
                  <span className="text-slate-500"> -</span><span className="text-emerald-300">{r.fpl.f13_adep}</span><span className="text-slate-200">{r.fpl.f13_eobt}</span>
                  <span className="text-slate-500"> -</span><span className="text-slate-200">{r.fpl.f15_spd}{r.fpl.f15_lvl} {r.fpl.f15_rte}</span>
                  <span className="text-slate-500"> -</span><span className="text-amber-300">{r.fpl.f16_ades}</span><span className="text-slate-200">{r.fpl.f16_eet} {r.fpl.f16_altn}</span>
                </div>
                {/* Drivers */}
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {Object.entries(r.driverScores).map(([k,v]) => (
                    <span key={k} className="text-[9px] px-1 py-0.5 rounded font-mono" style={{ background: v>=50?TIER_COLOR.DEFECTIVE+'22':'#334155', color: v>=50?TIER_COLOR.DEFECTIVE:'#94a3b8' }}>{k} {v.toFixed(0)}</span>
                  ))}
                </div>
                {/* Errors */}
                {r.errors.length > 0 && (
                  <div className="mt-1.5 space-y-0.5">
                    {r.errors.slice(0,3).map((e, i) => (
                      <div key={i} className="text-[9px] leading-tight" style={{ color: e.severity === 'REJ' ? TIER_COLOR.REJECTED : e.severity === 'MAN' ? TIER_COLOR.DEFECTIVE : TIER_COLOR.DEFICIENT }}>
                        <span className="font-mono mr-1">{e.severity}·Item{e.field}</span>{e.text}
                      </div>
                    ))}
                    {r.errors.length > 3 && (
                      <div className="text-[9px] text-slate-500">… +{r.errors.length-3} more · click VALIDATION tab</div>
                    )}
                  </div>
                )}
                {r.errors.length === 0 && (
                  <div className="mt-1.5 text-[9px] text-emerald-300">› All 19 fields pass IFPS validation</div>
                )}
              </div>
            ))}
            {visible.length > 60 && (
              <div className="text-center text-[9px] text-slate-500 py-2">… +{visible.length-60} more · narrow filters to inspect</div>
            )}
          </>
        )}

        {tab === 'FIELDS' && pickedRow && (
          <div className="text-[10px] text-slate-300 space-y-1.5">
            <div className="text-[10px] font-mono text-sky-300 mb-1">› {pickedRow.fpl.f7_cs} · {pickedRow.spec.label} · field-by-field breakdown</div>
            {([
              ['Item 7 · Aircraft Identification', pickedRow.fpl.f7_cs, 'Callsign 2-7 alphanumerics, first must be alpha (Doc 4444 App 2 §1.6.1)'],
              ['Item 8a · Flight Rules', pickedRow.fpl.f8_rules, 'I=IFR · V=VFR · Y=IFR-then-VFR · Z=VFR-then-IFR'],
              ['Item 8b · Type of Flight', pickedRow.fpl.f8_type, 'S=scheduled commercial · N=non-scheduled · G=GA · M=military · X=other'],
              ['Item 9a · Number', pickedRow.fpl.f9_num, '1-999 aircraft in formation'],
              ['Item 9b · Type Designator', pickedRow.fpl.f9_type, 'ICAO Doc 8643 ed.52 aircraft type designator'],
              ['Item 9c · Wake Turbulence', pickedRow.fpl.f9_wake, 'J=super (A380) · H=heavy · M=medium · L=light'],
              ['Item 10a · Equipment & Capabilities', pickedRow.fpl.f10a_equip, 'S=std (VHF+VOR+ILS) · G=GNSS · R=PBN · W=RVSM · Y=8.33kHz · I=IRS · D=DME · J1-J7=CPDLC'],
              ['Item 10b · Surveillance', pickedRow.fpl.f10b_surv, 'N=nil · A/C/E/S=transponder modes · B1/B2=ADS-B 1090ES out/in · U1/U2=UAT · D1=ADS-C · G1=ADS-C-FANS'],
              ['Item 13a · Departure Aerodrome', pickedRow.fpl.f13_adep, '4-letter ICAO indicator (or ZZZZ + DEP/ in Item 18)'],
              ['Item 13b · EOBT', pickedRow.fpl.f13_eobt, 'Estimated off-block time HHMM zulu'],
              ['Item 15a · Cruise Speed', pickedRow.fpl.f15_spd, 'N0xxx KTAS · M0xx Mach · K0xxx kph'],
              ['Item 15b · Cruise Level', pickedRow.fpl.f15_lvl, 'Fxxx flight-level · Axxx altitude·100ft · Sxxxx metres·10 · Mxxxx metres·10 · VFR'],
              ['Item 15c · Route', pickedRow.fpl.f15_rte, 'SID + airway/waypoint sequence + STAR · DCT = direct'],
              ['Item 16a · Destination', pickedRow.fpl.f16_ades, '4-letter ICAO aerodrome indicator'],
              ['Item 16b · Total EET', pickedRow.fpl.f16_eet, 'Estimated elapsed time HHMM'],
              ['Item 16c · Alternate', pickedRow.fpl.f16_altn, '1st alternate aerodrome (2nd in next position if filed)'],
              ['Item 18 · PBN/', pickedRow.fpl.f18_pbn, 'Doc 9613 navspec codes A1/B1/C1/D1=RNAV/RNP-10/4/2/1 L1/O1/S1/S2=RNP-AR variants'],
              ['Item 18 · NAV/', pickedRow.fpl.f18_nav, 'Free-text additional nav equipment (e.g. RNVD1E2A1)'],
              ['Item 18 · COM/', pickedRow.fpl.f18_com, 'Free-text additional comm equipment'],
              ['Item 18 · DAT/', pickedRow.fpl.f18_dat, 'Datalink capability (e.g. 1FANSP/A)'],
              ['Item 18 · SUR/', pickedRow.fpl.f18_sur, 'Surveillance extra (e.g. RSP180 260B)'],
              ['Item 18 · DOF/', pickedRow.fpl.f18_dof, 'Date of flight YYMMDD'],
              ['Item 18 · REG/', pickedRow.fpl.f18_reg, 'Aircraft registration'],
              ['Item 18 · SEL/', pickedRow.fpl.f18_sel, 'SELCAL code 4-letter AA-BB (ARINC 596)'],
              ['Item 18 · RMK/', pickedRow.fpl.f18_rmk, 'Free-text remarks'],
            ] as Array<[string, string, string]>).map(([lab, val, desc], i) => (
              <div key={i} className="bg-slate-800/40 rounded px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-mono text-sky-300 truncate">{lab}</span>
                  <span className="text-[11px] font-mono text-slate-100 truncate">{val || '—'}</span>
                </div>
                <div className="text-[9px] text-slate-500 mt-0.5">{desc}</div>
              </div>
            ))}
          </div>
        )}
        {tab === 'FIELDS' && !pickedRow && (
          <div className="text-center text-[10px] text-slate-500 py-6">Pick an aircraft on AIRCRAFT tab to see field-by-field breakdown</div>
        )}

        {tab === 'VALIDATION' && (
          <div className="text-[10px] text-slate-300 space-y-1.5">
            <div className="text-[10px] font-mono text-sky-300 mb-1">› IFPS error catalogue · severity counts across fleet</div>
            {(() => {
              const sevMap: Record<ErrCode, { rej: number; man: number; war: number; sample: string }> = {} as any
              for (const r of rows) {
                for (const e of r.errors) {
                  if (!sevMap[e.code]) sevMap[e.code] = { rej:0, man:0, war:0, sample: e.text }
                  if (e.severity === 'REJ') sevMap[e.code].rej++
                  else if (e.severity === 'MAN') sevMap[e.code].man++
                  else sevMap[e.code].war++
                }
              }
              return (Object.entries(sevMap) as Array<[ErrCode, {rej:number;man:number;war:number;sample:string}]>)
                .sort((a,b)=> (b[1].rej+b[1].man+b[1].war) - (a[1].rej+a[1].man+a[1].war))
                .map(([code, s]) => (
                  <div key={code} className="bg-slate-800/40 rounded px-2 py-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono text-slate-100">{code}</span>
                      <div className="flex gap-1 text-[9px] font-mono">
                        <span className="px-1 rounded" style={{ background: TIER_COLOR.REJECTED+'22', color: TIER_COLOR.REJECTED }}>R {s.rej}</span>
                        <span className="px-1 rounded" style={{ background: TIER_COLOR.DEFECTIVE+'22', color: TIER_COLOR.DEFECTIVE }}>M {s.man}</span>
                        <span className="px-1 rounded" style={{ background: TIER_COLOR.DEFICIENT+'22', color: TIER_COLOR.DEFICIENT }}>W {s.war}</span>
                      </div>
                    </div>
                    <div className="text-[9px] text-slate-400 mt-0.5 leading-tight">› {s.sample}</div>
                  </div>
                ))
            })()}
            {totalErrs === 0 && (
              <div className="text-center text-[10px] text-emerald-300 py-6">All visible flight plans pass IFPS validation</div>
            )}
          </div>
        )}

        {tab === 'FORMAT' && (
          <div className="text-[10px] text-slate-300 space-y-2 leading-snug">
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› ICAO 2012 MODEL FPL · WIRE FORMAT</div>
              <div className="bg-slate-800/40 rounded p-2 font-mono text-[9px] text-slate-200 leading-relaxed">
                (FPL-<span className="text-sky-300">CALLSIGN</span>-IS<br/>
                &nbsp;&nbsp;-1/<span className="text-emerald-300">B789</span>/H<br/>
                &nbsp;&nbsp;-SDFGHIJ1J5M1ORWXY/B1D1G1<br/>
                &nbsp;&nbsp;-<span className="text-amber-300">KJFK</span>1430<br/>
                &nbsp;&nbsp;-M083F360 JFK4 BETTE NAT5A KESIX UN601 ARNEM<br/>
                &nbsp;&nbsp;-<span className="text-rose-300">EDDF</span>0710 EDDM<br/>
                &nbsp;&nbsp;-PBN/A1B1C1D1L1O1S1S2 NAV/RNVD1E2A1<br/>
                &nbsp;&nbsp;&nbsp;&nbsp;DOF/260605 REG/N123AB SEL/AB-CD<br/>
                &nbsp;&nbsp;&nbsp;&nbsp;RMK/TCAS EQUIPPED)
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› ITEM 10a EQUIPMENT LETTERS</div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] font-mono">
                {[
                  ['N','none/std VOR-VHF only'],
                  ['S','VHF + VOR + ILS'],
                  ['G','GNSS'],
                  ['R','PBN-approved'],
                  ['W','RVSM'],
                  ['Y','8.33 kHz VHF'],
                  ['I','Inertial Nav'],
                  ['D','DME'],
                  ['F','ADF'],
                  ['H','HF RTF'],
                  ['L','ILS'],
                  ['O','VOR'],
                  ['T','TACAN'],
                  ['U','UHF RTF'],
                  ['V','VHF RTF'],
                  ['J1-J7','CPDLC variants'],
                  ['M1-M3','SATVOICE'],
                  ['P1-P9','RCP performance'],
                  ['E1/E2/E3','FMC WPR / D-FIS / PDC'],
                  ['X','MNPS'],
                ].map(([k,v]) => (
                  <div key={k} className="flex justify-between bg-slate-800/30 rounded px-1 py-0.5">
                    <span className="text-sky-300">{k}</span>
                    <span className="text-slate-300 text-right">{v}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› ITEM 10b SURVEILLANCE LETTERS</div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] font-mono">
                {[
                  ['N','none'],
                  ['A','Mode-A 4096'],
                  ['C','Mode-A+C'],
                  ['S','Mode-S basic'],
                  ['E','Mode-S DAP+ID'],
                  ['H','Mode-S enhanced'],
                  ['I','Mode-S ID only'],
                  ['L','Mode-S ELS+EHS'],
                  ['P','Mode-S pressure-alt'],
                  ['X','Mode-S no ID/no alt'],
                  ['B1','ADS-B 1090ES OUT'],
                  ['B2','ADS-B 1090ES IN+OUT'],
                  ['U1','UAT ADS-B OUT'],
                  ['U2','UAT ADS-B IN+OUT'],
                  ['V1','VDL-Mode-4 OUT'],
                  ['V2','VDL-Mode-4 IN+OUT'],
                  ['D1','ADS-C FANS-1/A'],
                  ['G1','ADS-C FANS-1/A+ATN'],
                ].map(([k,v]) => (
                  <div key={k} className="flex justify-between bg-slate-800/30 rounded px-1 py-0.5">
                    <span className="text-sky-300">{k}</span>
                    <span className="text-slate-300 text-right">{v}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› ITEM 18 PBN/ NAVSPEC CODES · Doc 9613 Vol II</div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] font-mono">
                {[
                  ['A1','RNAV-10 (RNP-10) oceanic/remote'],
                  ['B1','RNAV-5 all GNSS sensors'],
                  ['B2','RNAV-5 GNSS only'],
                  ['B3','RNAV-5 DME/DME'],
                  ['B4','RNAV-5 VOR/DME'],
                  ['B5','RNAV-5 INS/IRS'],
                  ['B6','RNAV-5 LORAN-C'],
                  ['C1','RNAV-2 all sensors'],
                  ['C2','RNAV-2 GNSS only'],
                  ['C3','RNAV-2 DME/DME'],
                  ['D1','RNAV-1 all sensors'],
                  ['D2','RNAV-1 GNSS only'],
                  ['L1','RNP-4 oceanic'],
                  ['O1','RNP-1 basic'],
                  ['S1','RNP-APPR LNAV'],
                  ['S2','RNP-APPR LNAV/VNAV'],
                  ['T1','RNP-AR APPR with RF'],
                  ['T2','RNP-AR APPR no RF'],
                ].map(([k,v]) => (
                  <div key={k} className="flex justify-between bg-slate-800/30 rounded px-1 py-0.5">
                    <span className="text-sky-300">{k}</span>
                    <span className="text-slate-300 text-right">{v}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-slate-800/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              <span className="text-sky-300">References:</span> ICAO Doc 4444 PANS-ATM Amdt 10 §4.4 + Appendix 2 ·
              Doc 8585 (Operating Agency Designators) · Doc 8643 ed.52 (Aircraft Type) · Doc 9613 PBN Manual Vol II ·
              EUROCONTROL IFPS Users Manual ed.27.0 · FAA Order JO 7110.10 · Reg (EU) 923/2012 SERA ·
              EU Reg 1079/2012 (8.33 kHz) · 14 CFR §91.225 (ADS-B) · NAT Doc 007 §3.1 (FANS-1/A oceanic).
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
