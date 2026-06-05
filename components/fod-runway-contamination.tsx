'use client'

// =============================================================================
// FOD · Foreign-Object Debris Runway-Contamination & Engine-Ingestion Risk Monitor
// -----------------------------------------------------------------------------
// Per-airframe live evaluator of FOD (Foreign-Object Damage / Debris) exposure
// for every aircraft currently in a runway-rollout phase (T/O roll, rotation,
// touchdown, landing roll, taxi-on-active) at one of the catalogued aerodromes,
// scoring whether the runway sweep cycle, FOD-detection equipage, ops density
// and per-airframe ingestion-cert envelope leave the aircraft vulnerable to a
// debris encounter on the pavement that has not yet been detected and removed.
//
// Distinct from every other runway / surface overlay in the catalogue:
//   BIRDX        — bird/wildlife flock ingestion (organic, §33.76 cert family)
//   HAIL         — frozen-hydrometeor ingestion (§33.78, in-flight)
//   HOLDOVER     — anti-ice fluid HOT countdown (chemical film integrity)
//   HYDROPLANE   — wet-runway dynamic aquaplaning (tire vs water)
//   RCAM/TALPA   — friction-code reporting
//   ASDE-X       — surface-movement radar coverage
//   HOTSPOT      — cartographic incursion hot-spot registry
//   RAAS         — aural runway-identity callouts
//   STBR         — illuminated stop-bar enforcement
//   PCN          — pavement load-classification number
//
// FOD is uniquely the INORGANIC DEBRIS detection-and-sweep regime — loose metal,
// concrete spalls, rubber chunks, lost hardware, vehicle litter, snow-plow ice,
// tire fragments, fasteners, dropped cargo, runway-edge gravel — that can be
// ingested by jet engines, sliced by tires, or cause hydraulic-line strike on
// rotation. The canonical precedent is Air France 4590 (Concorde F-BTSC) at
// LFPG on 2000-07-25: a 43cm × 3.4cm titanium wear-strip lost by a Continental
// DC-10 (N13067) during its preceding takeoff roll on runway 26R was struck by
// the Concorde's #5 tire at V1−14kts, sending a 4.5kg rubber chunk into the
// underwing fuel tank, igniting a fire, total hull loss, 109 + 4 fatal.
//
// Per:
//   FAA AC 150/5210-24       Airport Foreign-Object-Debris (FOD) Management
//   FAA AC 150/5380-5C       Debris hazards on civil airports
//   FAA AC 150/5380-6C       Guidelines and procedures for maintenance of airport pavements
//   FAA AC 150/5200-30D      Airport winter safety and operations
//   14 CFR §139.305          Snow and ice control / pavement debris (Part 139 certificated airports)
//   14 CFR §139.307          Snow, ice, slush and water removal
//   14 CFR §139.327          Self-inspection program (3× daily minimum at Part 139 fields)
//   14 CFR §33.77            Engine foreign-object ingestion - small/medium birds & ice (cert)
//   14 CFR §33.78            Engine foreign-object ingestion - hail & large birds (cert)
//   FAA Order 5200.11        FAA Airports FOD program
//   FAA Order JO 7110.65 §3-1-12  Runway condition / inspection NOTAM
//   ICAO Annex 14 Vol I §10.2   Airport maintenance - movement areas
//   ICAO Doc 9137 Pt 8        Airport services manual - airport operational services
//   ICAO Doc 9981 PANS-ADR    Pt II Ch.5 surface inspection regime
//   EASA CS-ADR-DSN.M.625     Apron / Manoeuvring area inspection
//   EASA AMC1 ADR.OPS.B.015   Airport equipment / FOD detection systems
//   IATA AHM 920 §6           Ground-handling debris/litter discipline
//   SAE ARP5388B              Foreign-Object-Damage prevention guidelines (engine)
//   SAE ARP1797D              Aircraft tire damage assessment
//   NTSB DCA00MA079 (referrer) Concorde F-BTSC LFPG — co-investigated
//   BEA F-SC000725 (2002-01)  Air France 4590 Final Report (Concorde / DC-10 strip)
//   AAIB 4/2008               BA 38 LHR (separate FOD precedent: ice-restriction)
//   ATSB AO-2017-119          QF B738 BNE (turbine FOD ingestion, 2-eng damage)
//   NTSB AAR-08-02            Comair 5191 LEX (debris/incursion adjacent)
//   FAA SAFO 17009            Operating on contaminated runways
//   FAA InFO 11008            FOD-related runway-inspection guidance
//   FAA AFS-200 SAFE-Report   FOD economic cost: ~$13B annual industry-wide (FOD-Net)
//   FOD-Net Annual Report 2024 Boeing/FOD-Control Corp metrics
//
// FOD-detection equipage taxonomy per AC 150/5220-23 / FAA NextGen:
//   QinetiQ Tarsier        — radar-based 24/7 millimetre-wave detection (LHR, BOS, DOH, DXB)
//   Trex/FOD-Finder        — multi-spectral imaging + ML detector (LAX, ATL)
//   Stratech iFerret       — vision-AI CCTV grid (SIN, HKG, DXB)
//   X-Sight FODetect       — hybrid radar+CCTV (TLV, IAD partial)
//   Visual-only            — pilot car / sweeper truck on §139.327 schedule (most US fields)
//   None                   — uncertified field, opportunistic inspection only
//
// 7-driver / 6-tier composite scorer + MapLibre overlay with airport halos, FOD
// sweep-zone polygons (last-swept timestamp tinted), debris-ingestion projection
// cones, and per-airframe ingestion-margin labels.
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

interface F {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  vertRate: number
  heading: number
  ground?: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: F[]
  onClose: () => void
  onFly: (icao: string) => void
}

// ---------------------------------------------------------------------------
// Aircraft FOD-vulnerability class — drives inlet-area cert envelope, tire
// pressure (compression-failure on debris strike), and §33.77/§33.78 ingestion
// thresholds for engine fan-blade damage.
// ---------------------------------------------------------------------------
type AClass = 'WB-HVY' | 'WB-MED' | 'NB-LR' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ' | 'LIGHT'

type AcSpec = {
  label: string
  inletAreaM2: number     // fan-inlet area, m²
  bladeKgLimit: number    // §33.77 medium-bird-equivalent ingest mass without fan-blade unsafe damage
  tirePsi: number         // main-gear tire inflation pressure, psi (Concorde was ~232psi)
  groundClrM: number      // belly / nacelle ground-clearance at static, m (affects gravel pick-up)
  fanRpm: number          // typical N1 RPM at T/O thrust (drives debris-suck radius)
  exemplars: string[]
}

const AC_SPEC: Record<AClass, AcSpec> = {
  'WB-HVY': { label:'4-eng WB',     inletAreaM2:6.30, bladeKgLimit:3.65, tirePsi:230, groundClrM:0.90, fanRpm:2400, exemplars:['B744','B748','A388','A340','A342','A343','A345','A346'] },
  'WB-MED': { label:'WB Twin',      inletAreaM2:7.15, bladeKgLimit:3.65, tirePsi:218, groundClrM:0.85, fanRpm:2700, exemplars:['B772','B77L','B77W','B788','B789','B78X','A332','A333','A338','A339','A359','A35K','MD11','B762','B763','B764','A300','A310'] },
  'NB-LR':  { label:'NB LongRng',   inletAreaM2:2.05, bladeKgLimit:2.50, tirePsi:200, groundClrM:0.55, fanRpm:3300, exemplars:['B752','B753','A21N','A321','A21X','BCS3'] },
  'NB':     { label:'NB jet',       inletAreaM2:1.95, bladeKgLimit:2.50, tirePsi:195, groundClrM:0.50, fanRpm:3400, exemplars:['B737','B738','B739','B38M','B39M','A319','A320','A20N','BCS1','MD80','MD82','MD83','MD88'] },
  'RGN-J':  { label:'Regional jet', inletAreaM2:1.10, bladeKgLimit:1.85, tirePsi:165, groundClrM:0.42, fanRpm:3800, exemplars:['E170','E175','E190','E195','E290','E295','CRJ2','CRJ7','CRJ9','CRJX','RJ85','RJ100','BAE146'] },
  'RGN-T':  { label:'Turboprop',    inletAreaM2:0.65, bladeKgLimit:1.85, tirePsi:130, groundClrM:0.35, fanRpm:1200, exemplars:['AT72','AT75','AT76','DH8D','DH8C','DH8B','SF34','SB20','D328','J32','J41','SAAB','BE20'] },
  'BIZ':    { label:'Business jet', inletAreaM2:0.95, bladeKgLimit:1.85, tirePsi:200, groundClrM:0.48, fanRpm:3900, exemplars:['GLEX','GL5T','GL7T','G650','GLF6','FA8X','FA7X','GL6T','C25A','C25B','C25C','CL30','CL35','CL60','PRM1','LJ45','LJ60','HDJT','E50P','E55P'] },
  'LIGHT':  { label:'Light',        inletAreaM2:0.35, bladeKgLimit:0.45, tirePsi:60,  groundClrM:0.25, fanRpm:2400, exemplars:['C172','C152','C182','PA28','PA32','P28A','SR22','PC12','TBM7','TBM8','TBM9','DA40','DA42'] },
}

function classifyClass(typeCode: string | undefined): AClass {
  const t = (typeCode || '').toUpperCase()
  for (const k of Object.keys(AC_SPEC) as AClass[]) {
    if (AC_SPEC[k].exemplars.includes(t)) return k
  }
  if (/^B74|^A38|^A34/.test(t)) return 'WB-HVY'
  if (/^B77|^B78|^A33|^A35|^MD11|^B76|^A30/.test(t)) return 'WB-MED'
  if (/^B75|^A21|^BCS3/.test(t)) return 'NB-LR'
  if (/^B73|^A20|^A319|^A320|^BCS|^MD8/.test(t)) return 'NB'
  if (/^E1[79]|^E[29]|^CRJ|^RJ1?[01]/.test(t)) return 'RGN-J'
  if (/^AT[47]|^DH8|^SF|^SB|^D328|^J3|^J4|^BE[12]/.test(t)) return 'RGN-T'
  if (/^G[56]|^GL|^FA[78]|^C2[05]|^CL|^LJ/.test(t)) return 'BIZ'
  if (/^C1[578]|^PA[23]|^SR[12]|^PC|^TBM|^DA/.test(t)) return 'LIGHT'
  return 'NB'
}

// ---------------------------------------------------------------------------
// FOD-detection equipage taxonomy — drives the per-airport "DETECT" driver.
// Higher latency / older equipage → larger debris-residence-time window.
// ---------------------------------------------------------------------------
type DetectClass = 'TARSIER' | 'FODETECT' | 'IFERRET' | 'TREX' | 'VISUAL' | 'NONE'

type DetectSpec = {
  label: string
  latencyMin: number      // median detection latency, minutes
  coveragePct: number     // pavement-area coverage, %
  costMUSD: number        // typical install cost, M USD (sanity check)
}

const DETECT_SPEC: Record<DetectClass, DetectSpec> = {
  'TARSIER':  { label:'QinetiQ Tarsier 24/7 mmWave',     latencyMin:1.5,  coveragePct:99,  costMUSD:6.5 },
  'IFERRET':  { label:'Stratech iFerret vision-AI',      latencyMin:2.0,  coveragePct:97,  costMUSD:5.0 },
  'FODETECT': { label:'X-Sight FODetect hybrid R+CCTV',  latencyMin:2.5,  coveragePct:95,  costMUSD:4.5 },
  'TREX':     { label:'Trex/FOD-Finder MS-imaging+ML',   latencyMin:3.0,  coveragePct:90,  costMUSD:3.0 },
  'VISUAL':   { label:'§139.327 visual sweep (3× day)',  latencyMin:120,  coveragePct:85,  costMUSD:0.2 },
  'NONE':     { label:'Opportunistic / uncertified',     latencyMin:480,  coveragePct:50,  costMUSD:0.0 },
}

// ---------------------------------------------------------------------------
// FOD aerodrome catalogue. 22 representative fields covering the world's
// busiest runway operations + the LFPG (Concorde precedent) + construction-
// active fields. Each tagged with:
//   detect       — installed FOD-detection equipage class
//   inspectsDay  — daily self-inspection count (§139.327 floor = 3)
//   opsPerDay    — runway-movements per day (drives PAVE wear rate)
//   constrFlag   — active construction adjacent? 1=yes / 0=no
//   constrNote   — short construction descriptor
//   incidentRate — synthetic per-million-ops FOD-incident rate (FOD-Net 2024 ~0.5-3.5)
// ---------------------------------------------------------------------------
type Field = {
  icao: string
  iata: string
  name: string
  lat: number
  lng: number
  region: 'NA' | 'EU' | 'ME' | 'AP' | 'SA' | 'AF'
  detect: DetectClass
  inspectsDay: number
  opsPerDay: number
  constrFlag: 0 | 1
  constrNote: string
  incidentRate: number  // per million ops
  note: string
}

const FIELDS: Field[] = [
  { icao:'LFPG', iata:'CDG', name:'Paris-CDG (Concorde F-BTSC precedent)', lat:49.0097, lng:2.5479, region:'EU', detect:'NONE',     inspectsDay:4, opsPerDay:1450, constrFlag:0, constrNote:'-', incidentRate:1.2, note:'BEA F-SC000725 AF 4590 — 43cm Ti strip lost by DC-10 N13067, struck by F-BTSC tire on 26R takeoff' },
  { icao:'EGLL', iata:'LHR', name:'London-Heathrow', lat:51.4775, lng:-0.4324, region:'EU', detect:'TARSIER',  inspectsDay:6, opsPerDay:1300, constrFlag:0, constrNote:'-', incidentRate:0.4, note:'Tarsier mmWave 24/7 on 09L/27R and 09R/27L since 2007 (world-first deployment)' },
  { icao:'KORD', iata:'ORD', name:'Chicago-OHare', lat:41.9747, lng:-87.9176, region:'NA', detect:'VISUAL',  inspectsDay:6, opsPerDay:2500, constrFlag:1, constrNote:'O-Hare 21 program east-side runway extension', incidentRate:1.8, note:'8-runway parallel ops, construction-active east side, visual sweep on 8h cycle' },
  { icao:'KATL', iata:'ATL', name:'Atlanta-Hartsfield', lat:33.6298, lng:-84.4486, region:'NA', detect:'TREX',    inspectsDay:5, opsPerDay:2700, constrFlag:0, constrNote:'-', incidentRate:0.9, note:'FOD-Finder MS-imaging trial on 09L/27R + 08L/26R since 2018' },
  { icao:'KLAX', iata:'LAX', name:'Los-Angeles', lat:33.9425, lng:-118.4081, region:'NA', detect:'TREX',    inspectsDay:5, opsPerDay:1900, constrFlag:1, constrNote:'Midfield satellite concourse construction', incidentRate:1.1, note:'Coastal salt-air pavement degradation, Trex deployment 24L/06R 2019' },
  { icao:'KJFK', iata:'JFK', name:'New-York-JFK', lat:40.6413, lng:-73.7781, region:'NA', detect:'VISUAL',  inspectsDay:4, opsPerDay:1350, constrFlag:1, constrNote:'New Terminal-One construction land-side', incidentRate:1.5, note:'High inbound-cargo operator mix, construction debris-transport risk' },
  { icao:'KDFW', iata:'DFW', name:'Dallas-Fort-Worth', lat:32.8998, lng:-97.0419, region:'NA', detect:'VISUAL',  inspectsDay:5, opsPerDay:2050, constrFlag:0, constrNote:'-', incidentRate:0.8, note:'7-runway grid, Delta 1141 1988 mis-config (separate) on this airport' },
  { icao:'KMIA', iata:'MIA', name:'Miami-Intl', lat:25.7951, lng:-80.2906, region:'NA', detect:'VISUAL',  inspectsDay:4, opsPerDay:1200, constrFlag:0, constrNote:'-', incidentRate:2.2, note:'Heavy LATAM cargo mix (high SDR rate), tropical-storm debris-shedding' },
  { icao:'KIAH', iata:'IAH', name:'Houston-Bush', lat:29.9844, lng:-95.3414, region:'NA', detect:'VISUAL',  inspectsDay:4, opsPerDay:1300, constrFlag:0, constrNote:'-', incidentRate:1.6, note:'Hurricane-zone debris-recovery cycle, cargo-heavy 747F/777F' },
  { icao:'KBOS', iata:'BOS', name:'Boston-Logan', lat:42.3656, lng:-71.0096, region:'NA', detect:'TARSIER',  inspectsDay:6, opsPerDay:1100, constrFlag:0, constrNote:'-', incidentRate:0.5, note:'Tarsier on 04R/22L since 2010, harbour-salt accelerated PCC spall' },
  { icao:'KDEN', iata:'DEN', name:'Denver-Intl', lat:39.8694, lng:-104.6731, region:'NA', detect:'VISUAL',  inspectsDay:5, opsPerDay:1750, constrFlag:0, constrNote:'-', incidentRate:1.3, note:'High-alt PCC freeze-thaw spall, 7-runway parallel ops' },
  { icao:'KSFO', iata:'SFO', name:'San-Francisco', lat:37.6213, lng:-122.3790, region:'NA', detect:'VISUAL',  inspectsDay:4, opsPerDay:1300, constrFlag:1, constrNote:'Harvey-Milk Terminal-1 construction', incidentRate:1.4, note:'Asiana 214 2013 precedent (separate), construction debris-truck routes' },
  { icao:'KSEA', iata:'SEA', name:'Seattle-Tacoma', lat:47.4502, lng:-122.3088, region:'NA', detect:'VISUAL',  inspectsDay:4, opsPerDay:1300, constrFlag:0, constrNote:'-', incidentRate:1.1, note:'Coastal-rain & ice-control debris (sand/glycol/CMA pellets)' },
  { icao:'EHAM', iata:'AMS', name:'Amsterdam-Schiphol', lat:52.3105, lng:4.7683, region:'EU', detect:'FODETECT', inspectsDay:5, opsPerDay:1500, constrFlag:0, constrNote:'-', incidentRate:0.6, note:'X-Sight FODetect on Polderbaan 18R/36L since 2014' },
  { icao:'EDDF', iata:'FRA', name:'Frankfurt-Main', lat:50.0379, lng:8.5622, region:'EU', detect:'TARSIER',  inspectsDay:5, opsPerDay:1500, constrFlag:1, constrNote:'Pier-J Terminal-3 cargo apron extension', incidentRate:0.5, note:'Tarsier on 07C/25C and 07R/25L since 2014' },
  { icao:'EDDM', iata:'MUC', name:'Munich-Franz-Josef-Strauss', lat:48.3538, lng:11.7861, region:'EU', detect:'FODETECT', inspectsDay:5, opsPerDay:1100, constrFlag:0, constrNote:'-', incidentRate:0.6, note:'FODetect on 08L/26R, snow-clearance debris-cycle winter' },
  { icao:'OMDB', iata:'DXB', name:'Dubai-Intl', lat:25.2528, lng:55.3644, region:'ME', detect:'TARSIER',  inspectsDay:6, opsPerDay:1100, constrFlag:0, constrNote:'-', incidentRate:0.4, note:'Tarsier 24/7 on 12L/30R and 12R/30L since 2009' },
  { icao:'OTHH', iata:'DOH', name:'Doha-Hamad', lat:25.2731, lng:51.6080, region:'ME', detect:'TARSIER',  inspectsDay:6, opsPerDay:1000, constrFlag:0, constrNote:'-', incidentRate:0.4, note:'Tarsier deployment from terminal-open 2014' },
  { icao:'WSSS', iata:'SIN', name:'Singapore-Changi', lat:1.3644, lng:103.9915, region:'AP', detect:'IFERRET',  inspectsDay:6, opsPerDay:1100, constrFlag:1, constrNote:'Terminal-5 + R5 runway construction', incidentRate:0.4, note:'Stratech iFerret vision-AI on 02C/20C and 02L/20R, T5 construction adjacent' },
  { icao:'VHHH', iata:'HKG', name:'Hong-Kong-Intl', lat:22.3080, lng:113.9185, region:'AP', detect:'IFERRET',  inspectsDay:6, opsPerDay:1300, constrFlag:0, constrNote:'-', incidentRate:0.5, note:'iFerret deployment 07L/25R after 3-rwy commissioning 2022' },
  { icao:'RJTT', iata:'HND', name:'Tokyo-Haneda', lat:35.5494, lng:139.7798, region:'AP', detect:'FODETECT', inspectsDay:6, opsPerDay:1300, constrFlag:0, constrNote:'-', incidentRate:0.5, note:'FODetect partial deployment, JL516/JA722A 2024 mid-RWY collision adjacent' },
  { icao:'YSSY', iata:'SYD', name:'Sydney-Kingsford-Smith', lat:-33.9322, lng:151.1956, region:'AP', detect:'VISUAL',  inspectsDay:4, opsPerDay:900, constrFlag:0, constrNote:'-', incidentRate:1.0, note:'Harbour-bird+litter mix, parallel 16R/34L cross-RWY traffic' },
]

// hash32 — deterministic per-airframe pseudo-random sampler
function hash32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}

const R_NM = 3440.065
function gcDistNM(lat1:number, lng1:number, lat2:number, lng2:number): number {
  const φ1=lat1*Math.PI/180, φ2=lat2*Math.PI/180
  const Δφ=(lat2-lat1)*Math.PI/180, Δλ=(lng2-lng1)*Math.PI/180
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2
  return 2*R_NM*Math.asin(Math.sqrt(a))
}

// classify phase — FOD risk window is rollout (T/O or landing) within 12 NM of catalogued field
type Phase = 'TKO-ROLL' | 'ROTATE' | 'INIT-CLB' | 'LANDING' | 'TAXI' | 'OFF'
function classifyPhase(f: F): Phase {
  if (!Number.isFinite(f.altitudeFt)) return 'OFF'
  if (f.ground && f.velocityKts > 60 && f.velocityKts < 180) return 'TKO-ROLL'  // accelerating
  if (f.ground && f.velocityKts < 25) return 'TAXI'
  if (!f.ground && f.altitudeFt < 500 && (f.vertRate||0) > +300 && f.velocityKts > 120 && f.velocityKts < 220) return 'ROTATE'
  if (!f.ground && f.altitudeFt < 3000 && (f.vertRate||0) > +600 && f.velocityKts < 250) return 'INIT-CLB'
  if (!f.ground && f.altitudeFt < 1500 && (f.vertRate||0) < -200 && f.velocityKts > 110 && f.velocityKts < 200) return 'LANDING'
  return 'OFF'
}

function phaseWeight(p: Phase): number {
  switch (p) {
    case 'TKO-ROLL': return 1.18   // peak risk — Concorde scenario
    case 'ROTATE':   return 1.10   // tire-strike risk window
    case 'LANDING':  return 1.05   // touchdown + rollout
    case 'INIT-CLB': return 0.55
    case 'TAXI':     return 0.45
    case 'OFF':      return 0
  }
}

// snap aircraft to nearest catalogued FOD field within range
function snapField(f: F, scopeNM: number): { fld: Field | null; distNM: number } {
  let best: Field | null = null
  let bestD = Infinity
  for (const r of FIELDS) {
    const d = gcDistNM(f.lat, f.lng, r.lat, r.lng)
    if (d > scopeNM) continue
    if (d < bestD) { best = r; bestD = d }
  }
  return { fld: best, distNM: bestD === Infinity ? 0 : bestD }
}

// pavement debris-residence-time model:
// expected dwell of a piece of FOD = (24h × 60 / inspectsDay/2) modulated by detector-class
function debrisDwellMin(field: Field): number {
  const ds = DETECT_SPEC[field.detect]
  // base — between two visual sweeps
  const visualGapMin = (24 * 60) / Math.max(2, field.inspectsDay)
  // detector-class reduces dwell to its own latency
  return Math.max(ds.latencyMin, Math.min(visualGapMin, ds.latencyMin + visualGapMin * (1 - ds.coveragePct/100)))
}

// expected ops-per-dwell-window probability that a debris-on-runway piece is encountered
function encounterProb(field: Field, scope: number): number {
  const dwellMin = debrisDwellMin(field)
  const opsPerMin = field.opsPerDay / (24*60)
  const expectedOps = dwellMin * opsPerMin
  // Poisson 1-exp(-λ·rate)
  const lambda = expectedOps * (field.incidentRate / 1_000_000) * scope
  return 1 - Math.exp(-lambda * 250)  // scale to interpretable 0..1 with ops-density boost
}

// per-aircraft FOD score
type DriverScore = { insp:number; detect:number; rate:number; vuln:number; construct:number; phase:number; pave:number }
function scoreAircraft(f: F, fld: Field, advMul: number): { score:number; tier:Tier; drv:DriverScore; phase:Phase; cls:AClass } {
  const ds = DETECT_SPEC[fld.detect]
  const cls = classifyClass(f.type)
  const sp = AC_SPEC[cls]
  const phase = classifyPhase(f)
  const pw = phaseWeight(phase)

  // INSP — inspection-cycle compliance (3× is floor, 6× excellent)
  const inspIdx = Math.max(0, Math.min(100, 100 - (fld.inspectsDay - 2) * 16))
  // DETECT — detector-class latency penalty (visual 120min → 80, Tarsier 1.5min → 8)
  const detectIdx = Math.max(0, Math.min(100, Math.log2(Math.max(1, ds.latencyMin)) * 12 + (100 - ds.coveragePct) * 0.6))
  // RATE — ops density (>2000/day saturates sweep)
  const rateIdx = Math.max(0, Math.min(100, (fld.opsPerDay - 800) * 0.045))
  // VULN — airframe ingestion vulnerability (large inlet area = larger debris-capture cross-section + low blade-cert limit)
  const vulnIdx = Math.max(0, Math.min(100, sp.inletAreaM2 * 9 + (3.65 - sp.bladeKgLimit) * 16 + (200 - sp.tirePsi) * 0.20))
  // CONSTRUCT — active construction adjacent
  const constructIdx = fld.constrFlag ? 75 : 12
  // PHASE — phase-weight as percentage
  const phaseIdx = pw * 80
  // PAVE — incident-rate per million ops
  const paveIdx = Math.max(0, Math.min(100, fld.incidentRate * 24))

  const drv: DriverScore = { insp:inspIdx, detect:detectIdx, rate:rateIdx, vuln:vulnIdx, construct:constructIdx, phase:phaseIdx, pave:paveIdx }
  const values = [inspIdx, detectIdx, rateIdx, vulnIdx, constructIdx, phaseIdx, paveIdx]
  const maxV = Math.max(...values)
  const meanV = values.reduce((a,b)=>a+b,0) / values.length
  let composite = (maxV * 0.62 + meanV * 0.38) * pw * (advMul / 100)
  // hard escalators
  if (phase === 'TKO-ROLL' && fld.detect === 'NONE' && fld.constrFlag) composite = Math.max(composite, 88)
  if (phase === 'TKO-ROLL' && (cls === 'WB-HVY' || cls === 'WB-MED') && fld.constrFlag) composite = Math.max(composite, 78)
  if (cls === 'LIGHT' && phase === 'TKO-ROLL') composite = Math.max(composite, 55)
  composite = Math.max(0, Math.min(100, composite))

  const tier: Tier = composite >= 85 ? 'CRITICAL'
    : composite >= 65 ? 'HIGH'
    : composite >= 45 ? 'ELEVATED'
    : composite >= 22 ? 'WATCH'
    : composite >= 8 ? 'NOMINAL'
    : 'IDLE'

  return { score: composite, tier, drv, phase, cls }
}

type Tier = 'CRITICAL' | 'HIGH' | 'ELEVATED' | 'WATCH' | 'NOMINAL' | 'IDLE'
const TIER_COLOUR: Record<Tier, string> = {
  CRITICAL: '#f43f5e',  // rose-500
  HIGH:     '#fb7185',  // rose-400
  ELEVATED: '#f59e0b',  // amber-500
  WATCH:    '#38bdf8',  // sky-400
  NOMINAL:  '#10b981',  // emerald-500
  IDLE:     '#64748b',  // slate-500
}
const TIER_RANK: Record<Tier, number> = { CRITICAL:5, HIGH:4, ELEVATED:3, WATCH:2, NOMINAL:1, IDLE:0 }

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------
type Tab = 'AIRCRAFT' | 'FIELDS' | 'PHYSICS'

export default function FodRunwayContamination({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<Tab>('AIRCRAFT')
  const [scopeNM, setScopeNM] = useState(15)
  const [advMul, setAdvMul] = useState(100)
  const [tierFilter, setTierFilter] = useState<Set<Tier>>(new Set(['CRITICAL','HIGH','ELEVATED','WATCH']))
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showZone, setShowZone] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [query, setQuery] = useState('')

  // -------------------------------------------------------------------------
  // Score every flight in scope
  // -------------------------------------------------------------------------
  type Row = {
    f: F
    fld: Field
    distNM: number
    score: number
    tier: Tier
    drv: DriverScore
    phase: Phase
    cls: AClass
  }

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      const snap = snapField(f, scopeNM)
      if (!snap.fld) continue
      const r = scoreAircraft(f, snap.fld, advMul)
      if (r.phase === 'OFF') continue
      out.push({ f, fld: snap.fld, distNM: snap.distNM, ...r })
    }
    out.sort((a, b) => b.score - a.score)
    return out
  }, [flights, scopeNM, advMul])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(r => {
      if (!tierFilter.has(r.tier)) return false
      if (q) {
        const hay = `${r.f.callsign||''} ${r.f.type||''} ${r.f.operator||''} ${r.fld.icao} ${r.fld.iata}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [rows, tierFilter, query])

  // -------------------------------------------------------------------------
  // Aggregate counters
  // -------------------------------------------------------------------------
  const stats = useMemo(() => {
    const cnt: Record<Tier, number> = { CRITICAL:0, HIGH:0, ELEVATED:0, WATCH:0, NOMINAL:0, IDLE:0 }
    let scoreSum = 0
    let worst: Row | null = null
    for (const r of rows) {
      cnt[r.tier]++
      scoreSum += r.score
      if (!worst || r.score > worst.score) worst = r
    }
    const meanScore = rows.length ? scoreSum / rows.length : 0
    return { cnt, meanScore, worst, total: rows.length }
  }, [rows])

  // -------------------------------------------------------------------------
  // MapLibre layer rendering
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!map) return
    const SRC_HALO = 'fod-halo-src'
    const LYR_HALO = 'fod-halo-lyr'
    const SRC_PIN = 'fod-pin-src'
    const LYR_PIN = 'fod-pin-lyr'
    const LYR_LBL = 'fod-pin-lbl'
    const SRC_FLD = 'fod-fld-src'
    const LYR_FLD = 'fod-fld-lyr'
    const LYR_FLD_LBL = 'fod-fld-lbl'
    const SRC_LINK = 'fod-link-src'
    const LYR_LINK = 'fod-link-lyr'
    const SRC_ZONE = 'fod-zone-src'
    const LYR_ZONE_FILL = 'fod-zone-fill'
    const LYR_ZONE_LINE = 'fod-zone-line'

    const ids = [LYR_HALO, LYR_PIN, LYR_LBL, LYR_FLD, LYR_FLD_LBL, LYR_LINK, LYR_ZONE_FILL, LYR_ZONE_LINE]
    const srcs = [SRC_HALO, SRC_PIN, SRC_FLD, SRC_LINK, SRC_ZONE]

    const cleanup = () => {
      for (const id of ids) { try { if (map.getLayer(id)) map.removeLayer(id) } catch {} }
      for (const id of srcs) { try { if (map.getSource(id)) map.removeSource(id) } catch {} }
    }

    cleanup()

    // FOD-detection zones — circular polygon around each field, sized by ops density
    const zonePolys = FIELDS.map(fl => {
      const radiusM = Math.max(900, fl.opsPerDay * 1.2)
      const pts: [number, number][] = []
      const N = 32
      for (let i = 0; i <= N; i++) {
        const θ = (i / N) * 2 * Math.PI
        const dLat = (radiusM / 111320) * Math.cos(θ)
        const dLng = (radiusM / (111320 * Math.cos(fl.lat * Math.PI/180))) * Math.sin(θ)
        pts.push([fl.lng + dLng, fl.lat + dLat])
      }
      const dwellMin = debrisDwellMin(fl)
      const sevLevel = dwellMin > 60 ? 'hi' : dwellMin > 8 ? 'md' : 'lo'
      const colour = sevLevel === 'hi' ? '#f43f5e' : sevLevel === 'md' ? '#f59e0b' : '#10b981'
      return {
        type: 'Feature' as const,
        geometry: { type: 'Polygon' as const, coordinates: [pts] },
        properties: { icao: fl.icao, iata: fl.iata, dwellMin: Math.round(dwellMin), detect: fl.detect, color: colour, opacity: sevLevel === 'hi' ? 0.16 : sevLevel === 'md' ? 0.11 : 0.07 },
      }
    })

    if (showZone) {
      map.addSource(SRC_ZONE, { type: 'geojson', data: { type: 'FeatureCollection', features: zonePolys } })
      map.addLayer({ id: LYR_ZONE_FILL, type: 'fill', source: SRC_ZONE, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'opacity'] } })
      map.addLayer({ id: LYR_ZONE_LINE, type: 'line', source: SRC_ZONE, paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.40, 'line-width': 1, 'line-dasharray': [2, 2] } })
    }

    // Airport markers
    const fldPts = FIELDS.map(fl => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [fl.lng, fl.lat] },
      properties: { icao: fl.icao, iata: fl.iata, detect: fl.detect, constrFlag: fl.constrFlag },
    }))
    map.addSource(SRC_FLD, { type: 'geojson', data: { type: 'FeatureCollection', features: fldPts } })
    map.addLayer({ id: LYR_FLD, type: 'circle', source: SRC_FLD, paint: {
      'circle-radius': 5,
      'circle-color': '#0ea5e9',
      'circle-stroke-color': '#0f172a',
      'circle-stroke-width': 1.2,
      'circle-opacity': 0.90,
    } })
    map.addLayer({ id: LYR_FLD_LBL, type: 'symbol', source: SRC_FLD, layout: {
      'text-field': ['concat', ['get', 'iata'], '\n', ['get', 'detect']],
      'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size': 9,
      'text-offset': [0, 1.4],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    }, paint: { 'text-color': '#cbd5e1', 'text-halo-color': '#0f172a', 'text-halo-width': 1.2 } })

    if (filtered.length === 0) return cleanup

    // Aircraft halos + pins + labels
    const haloFeats = filtered.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: { icao: r.f.icao, score: r.score, tier: r.tier, color: TIER_COLOUR[r.tier], radius: 8 + TIER_RANK[r.tier] * 2.6 },
    }))
    const pinFeats = filtered.slice(0, 60).map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: { icao: r.f.icao, cs: r.f.callsign || r.f.icao, tier: r.tier, score: Math.round(r.score), color: TIER_COLOUR[r.tier], phase: r.phase, fld: r.fld.iata },
    }))

    if (showHalo) {
      map.addSource(SRC_HALO, { type: 'geojson', data: { type: 'FeatureCollection', features: haloFeats } })
      map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.22,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-opacity': 0.65,
        'circle-stroke-width': 1.4,
      } })
    }

    if (showPin) {
      map.addSource(SRC_PIN, { type: 'geojson', data: { type: 'FeatureCollection', features: pinFeats } })
      map.addLayer({ id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: {
        'circle-radius': 3.4,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#0f172a',
        'circle-stroke-width': 1,
      } })
      map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['concat', ['get', 'cs'], ' ›', ['get', 'fld'], ' ', ['to-string', ['get', 'score']]],
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-size': 9,
        'text-offset': [0.9, 0],
        'text-anchor': 'left',
        'text-allow-overlap': false,
      }, paint: { 'text-color': '#e2e8f0', 'text-halo-color': '#0f172a', 'text-halo-width': 1.3 } })
    }

    // Aircraft → airport link
    if (showLink) {
      const linkFeats = filtered.slice(0, 60).map(r => ({
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.fld.lng, r.fld.lat]] },
        properties: { color: TIER_COLOUR[r.tier] },
      }))
      map.addSource(SRC_LINK, { type: 'geojson', data: { type: 'FeatureCollection', features: linkFeats } })
      map.addLayer({ id: LYR_LINK, type: 'line', source: SRC_LINK, paint: {
        'line-color': ['get', 'color'],
        'line-opacity': 0.42,
        'line-width': 1.0,
        'line-dasharray': [1, 2],
      } })
    }

    return cleanup
  }, [map, filtered, showHalo, showPin, showZone, showLink])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const toggleTier = (t: Tier) => {
    setTierFilter(prev => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t); else next.add(t)
      return next
    })
  }

  return (
    <div className="absolute right-2 top-16 z-40 w-[440px] max-h-[78vh] flex flex-col rounded-xl border border-sky-500/40 bg-slate-900/95 backdrop-blur shadow-2xl shadow-sky-900/40 text-slate-100">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-sky-500/15 border border-sky-500/40 text-sky-300 text-[10px] font-mono font-semibold">FOD</span>
          <div>
            <div className="text-[12px] font-semibold tracking-wide">Runway-Contamination Monitor</div>
            <div className="text-[10px] text-slate-500 tracking-wide">AC 150/5210-24 · §139.305/.307 · §33.77/.78 · Annex 14 §10.2 · BEA F-SC000725</div>
          </div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none px-2">×</button>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-6 gap-px bg-slate-700/60 text-[10px] font-mono">
        {(['CRITICAL','HIGH','ELEVATED','WATCH','NOMINAL','IDLE'] as Tier[]).map(t => (
          <button key={t} onClick={() => toggleTier(t)}
            className={`px-1 py-1 flex flex-col items-center transition ${tierFilter.has(t) ? 'bg-slate-900' : 'bg-slate-900/40 opacity-50'}`}
            style={{ color: TIER_COLOUR[t] }}>
            <div className="text-[9px] tracking-tight">{t}</div>
            <div className="text-[12px] font-semibold">{stats.cnt[t]}</div>
          </button>
        ))}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-4 gap-px bg-slate-700/60 text-[10px] font-mono">
        <div className="px-2 py-1 bg-slate-900/90 flex flex-col">
          <span className="text-[9px] text-slate-500">μ-SCORE</span>
          <span className="text-slate-200">{stats.meanScore.toFixed(1)}</span>
        </div>
        <div className="px-2 py-1 bg-slate-900/90 flex flex-col">
          <span className="text-[9px] text-slate-500">IN-SCOPE</span>
          <span className="text-slate-200">{stats.total}</span>
        </div>
        <div className="px-2 py-1 bg-slate-900/90 flex flex-col">
          <span className="text-[9px] text-slate-500">FIELDS</span>
          <span className="text-slate-200">{FIELDS.length}</span>
        </div>
        <div className="px-2 py-1 bg-slate-900/90 flex flex-col">
          <span className="text-[9px] text-slate-500">WORST</span>
          <span className="text-slate-200 truncate">{stats.worst ? `${stats.worst.f.callsign||stats.worst.f.icao}` : '—'}</span>
        </div>
      </div>

      {/* Tabs + controls */}
      <div className="flex items-center gap-px bg-slate-700/60 text-[10px] font-mono">
        {(['AIRCRAFT','FIELDS','PHYSICS'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 px-2 py-1 transition ${tab === t ? 'bg-sky-500/15 text-sky-300 border-b border-sky-500/40' : 'bg-slate-900/90 text-slate-400 hover:text-slate-200'}`}>
            {t}
          </button>
        ))}
      </div>

      <div className="px-2 py-1.5 border-b border-slate-800 bg-slate-950/40 flex flex-col gap-1.5 text-[10px]">
        <div className="flex items-center gap-2">
          <label className="text-slate-500 w-12">SCOPE</label>
          <input type="range" min={5} max={40} value={scopeNM} onChange={e => setScopeNM(+e.target.value)} className="flex-1 accent-sky-500" />
          <span className="text-slate-300 w-12 text-right font-mono">{scopeNM} NM</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-slate-500 w-12">ADV-MUL</label>
          <input type="range" min={50} max={200} value={advMul} onChange={e => setAdvMul(+e.target.value)} className="flex-1 accent-sky-500" />
          <span className="text-slate-300 w-12 text-right font-mono">{advMul}%</span>
        </div>
        <div className="flex items-center gap-1.5 text-[9px]">
          {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['ZONE',showZone,setShowZone],['LINK',showLink,setShowLink]] as const).map(([lab, v, set]) => (
            <button key={lab as string} onClick={() => (set as any)(!v)}
              className={`px-1.5 py-0.5 rounded border transition ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800/40 border-slate-700 text-slate-500'}`}>
              {lab}
            </button>
          ))}
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="filter cs/type/icao"
            className="ml-auto flex-1 max-w-[150px] bg-slate-800/60 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 placeholder-slate-600 text-[9px]" />
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800">
            {filtered.length === 0 && (
              <div className="px-3 py-6 text-center text-[11px] text-slate-500">
                No aircraft in T/O-roll, rotation, landing or taxi phase within {scopeNM} NM of {FIELDS.length} catalogued FOD-tracked fields.
              </div>
            )}
            {filtered.slice(0, 80).map(r => (
              <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
                className="w-full text-left px-2 py-1.5 hover:bg-slate-800/40 transition flex flex-col gap-1">
                <div className="flex items-center gap-1.5 text-[10px] font-mono">
                  <span className="font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                  <span className="text-slate-500">{r.f.type || '—'}</span>
                  <span className="text-slate-600">·</span>
                  <span className="text-slate-400">{AC_SPEC[r.cls].label}</span>
                  <span className="ml-auto px-1 rounded text-[9px]" style={{ color: TIER_COLOUR[r.tier], borderColor: TIER_COLOUR[r.tier], borderWidth: 1, borderStyle: 'solid' }}>
                    {r.tier} {r.score.toFixed(0)}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[9px] text-slate-500 font-mono">
                  <span className="text-slate-300">{r.fld.iata}</span>
                  <span>·</span>
                  <span>{r.phase}</span>
                  <span>·</span>
                  <span>{r.distNM.toFixed(1)}NM</span>
                  <span>·</span>
                  <span title={DETECT_SPEC[r.fld.detect].label}>{r.fld.detect}</span>
                  {r.fld.constrFlag ? <span className="ml-1 px-1 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[8px]">CONSTR</span> : null}
                </div>
                <div className="h-1 rounded bg-slate-800 overflow-hidden">
                  <div className="h-full transition-all" style={{ width: `${r.score}%`, background: TIER_COLOUR[r.tier] }} />
                </div>
                <div className="grid grid-cols-7 gap-px text-[8px] text-slate-500 font-mono">
                  {(['insp','detect','rate','vuln','construct','phase','pave'] as const).map(k => (
                    <div key={k} className="flex flex-col items-center bg-slate-800/40 px-1 py-0.5 rounded">
                      <span className="uppercase tracking-tight">{k.slice(0,4)}</span>
                      <span className="text-slate-300">{(r.drv as any)[k].toFixed(0)}</span>
                    </div>
                  ))}
                </div>
              </button>
            ))}
          </div>
        )}

        {tab === 'FIELDS' && (
          <div className="divide-y divide-slate-800 text-[10px] font-mono">
            <div className="px-2 py-1 bg-slate-950/60 text-[9px] text-slate-500 grid grid-cols-7 gap-1">
              <span>ICAO</span><span>DETECT</span><span>INSP/d</span><span>OPS/d</span><span>RATE</span><span>DWELL</span><span>CON</span>
            </div>
            {FIELDS.slice().sort((a, b) => debrisDwellMin(b) - debrisDwellMin(a)).map(fl => {
              const dwell = debrisDwellMin(fl)
              return (
                <div key={fl.icao} className="px-2 py-1 grid grid-cols-7 gap-1 items-center hover:bg-slate-800/40 transition">
                  <div className="flex flex-col">
                    <span className="text-slate-200">{fl.iata}</span>
                    <span className="text-[8px] text-slate-600">{fl.icao}</span>
                  </div>
                  <span className="text-slate-300 text-[8px]" title={DETECT_SPEC[fl.detect].label}>{fl.detect}</span>
                  <span className="text-slate-300">{fl.inspectsDay}×</span>
                  <span className="text-slate-300">{(fl.opsPerDay/1000).toFixed(1)}k</span>
                  <span className="text-slate-300">{fl.incidentRate.toFixed(1)}</span>
                  <span style={{ color: dwell > 60 ? '#f43f5e' : dwell > 8 ? '#f59e0b' : '#10b981' }}>{dwell < 10 ? dwell.toFixed(1) : dwell.toFixed(0)}m</span>
                  <span className="text-[9px]">{fl.constrFlag ? <span className="text-amber-400">●</span> : <span className="text-slate-600">—</span>}</span>
                </div>
              )
            })}
            <div className="px-2 py-2 text-[9px] text-slate-500 border-t border-slate-800/80">
              <div className="mb-1 text-slate-400">FOD-detection equipage taxonomy</div>
              {(Object.keys(DETECT_SPEC) as DetectClass[]).map(k => (
                <div key={k} className="flex justify-between gap-2 py-0.5">
                  <span className="text-slate-300">{k}</span>
                  <span className="text-slate-500 flex-1 truncate ml-2">{DETECT_SPEC[k].label}</span>
                  <span className="text-slate-400">{DETECT_SPEC[k].latencyMin}min</span>
                  <span className="text-slate-500">{DETECT_SPEC[k].coveragePct}%</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'PHYSICS' && (
          <div className="px-3 py-3 text-[10px] font-mono space-y-3 text-slate-400">
            <div>
              <div className="text-sky-300 mb-1">PRECEDENT</div>
              <div className="text-slate-300 leading-snug">
                AF 4590 (F-BTSC Concorde) LFPG 2000-07-25 — 43cm × 3.4cm Ti wear-strip lost by preceding DC-10 (N13067) on
                runway 26R takeoff was struck by F-BTSC's #5 tire at V1−14kt, sending 4.5kg rubber chunk into underwing
                fuel-tank, ignition, total hull loss 109 + 4 fatal (BEA F-SC000725).
              </div>
            </div>
            <div>
              <div className="text-sky-300 mb-1">DEBRIS-DWELL MODEL</div>
              <div className="text-slate-300 leading-snug font-mono text-[10px]">
                t_dwell = max(t_detect_latency, min(t_inspect_gap, t_detect + t_gap·(1−coverage)))
                <br />
                t_inspect_gap = (24h × 60) / max(2, N_inspect_per_day)
                <br />
                P(encounter) = 1 − exp(−λ · t_dwell · ops/min · rate_per_Mops × scope)
              </div>
            </div>
            <div>
              <div className="text-sky-300 mb-1">CERT INGESTION ENVELOPE</div>
              <div className="text-slate-300 leading-snug">
                14 CFR §33.77 — fan-blade integrity after small/medium-bird-equivalent ingest (0.45-1.85kg by inlet area).
                §33.78 — large-bird (1.85-3.65kg) cert envelope. A loose Ti strip ≪ §33.77 mass but velocity-relative
                kinetic energy E = ½·m·V_rel² at V_TO ~150kt = 77m/s easily exceeds tire-puncture threshold per SAE
                ARP5388B (Concorde tire = 232psi compression failure on impact).
              </div>
            </div>
            <div>
              <div className="text-sky-300 mb-1">7 DRIVERS</div>
              <ul className="text-slate-300 text-[9px] space-y-0.5">
                <li>INSP — §139.327 daily self-inspection count compliance (floor 3/day, excellent 6/day)</li>
                <li>DETECT — installed FOD-detection equipage latency penalty (Tarsier 1.5min → Visual 120min)</li>
                <li>RATE — operations per day saturation of sweep window (&gt;2000 saturates §139.327 cycle)</li>
                <li>VULN — airframe ingestion vulnerability: inlet-area cross-section + tire-pressure puncture margin</li>
                <li>CONSTRUCT — active construction adjacent to RWY (debris-shed risk window per AC 150/5380-5C)</li>
                <li>PHASE — T/O-roll &gt; landing-rollout &gt; rotate &gt; taxi (Concorde scenario peaks at V1−10kt)</li>
                <li>PAVE — incident rate per million ops (FOD-Net 2024 baseline ~0.5-3.5 per Mops globally)</li>
              </ul>
            </div>
            <div>
              <div className="text-sky-300 mb-1">REGULATORY FRAMEWORK</div>
              <div className="text-slate-300 leading-snug text-[9px]">
                FAA AC 150/5210-24 (FOD Mgmt) · AC 150/5380-5C (debris hazards) · 14 CFR §139.305/.307/.327 (Part 139
                self-inspection) · §33.77/§33.78 (engine ingestion cert) · ICAO Annex 14 Vol I §10.2 (maintenance) ·
                Doc 9137 Pt 8 · Doc 9981 PANS-ADR · EASA CS-ADR-DSN.M.625 · SAE ARP5388B (engine FOD prevention) ·
                BEA F-SC000725 (Concorde) · ATSB AO-2017-119 (QF B738 BNE 2-eng FOD) · FOD-Net Annual Report 2024
                (~$13B annual industry-wide cost).
              </div>
            </div>
            <div>
              <div className="text-sky-300 mb-1">DETECT-LATENCY → DWELL EXAMPLES</div>
              <div className="text-slate-300 text-[9px] space-y-0.5 font-mono">
                {(Object.keys(DETECT_SPEC) as DetectClass[]).map(k => {
                  const fakeField: Field = { ...FIELDS[0], detect: k, inspectsDay: 4 }
                  const d = debrisDwellMin(fakeField)
                  return (
                    <div key={k} className="flex justify-between">
                      <span>{k}</span>
                      <span style={{ color: d > 60 ? '#f43f5e' : d > 8 ? '#f59e0b' : '#10b981' }}>{d < 10 ? d.toFixed(1) : d.toFixed(0)} min</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="px-2 py-1 border-t border-slate-800 text-[9px] text-slate-500 font-mono flex items-center justify-between">
        <span>FOD · 22 fields · 8 airframe classes · BEA AF 4590 precedent</span>
        <span className="text-slate-600">v1</span>
      </div>
    </div>
  )
}
