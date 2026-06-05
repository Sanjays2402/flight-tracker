'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* BIRDX · Bird-Strike & Wildlife-Ingestion Engine-Damage Risk Monitor.
   Per 14 CFR §33.76 / §33.77 Bird-Ingestion Cert · §25.571 §25.775
   Radome & Windshield · AC 33.76-1 §6 Med/Large-bird Test · AC 150/
   5200-32B Wildlife Hazard Mgmt §3 §5 / AC 150/5200-33C Hazard
   Wildlife Attractants §2 / ICAO Annex 14 Vol I §9.4 Wildlife / Doc
   9137 Pt III Wildlife Ctrl & Reduction Manual §2 §4 §6 / EASA CS-25
   App.D Bird Ingestion / FAA Wildlife Strike DB 2024 Report 1990-
   2023 (273,769 strikes, $957M annual loss) / NTSB AAR-10-03 US
   Airways 1549 KLGA Hudson 2009 Canada Goose dual-CFM56-5B4/P stall
   / AAR-13-01 Bek Air Q400 SCAT 2015 raptor / AAIB Ryanair FR4102
   B738 Ciampino 2008-11-10 starling flock approach / TC SA AAA
   AC2003-A Calgary B738 2004 / DGAC F-WTSS 1976 Concorde flock /
   Boeing FCOM ENG.SUPP.FIRE / Airbus FCOM PRO-ABN-70 BIRD-STRIKE.
   Distinct from CAST (top-accident category taxonomy), HAIL (frozen-
   precip engine ingest), FOD (loose-debris runway sweep), NVPM
   (emissions PM), VOLCANIC-ASH (silicate engine erosion), MELT
   (gross-weight inversion), DEEPSTL (post-stall pitch authority). */

interface F {
  icao: string
  callsign: string
  registration: string
  type: string
  operator: string
  lng: number
  lat: number
  altitudeFt: number
  ground: boolean
  velocityKts: number
  ias: number
  mach: number
  vertRate: number
  navAlt: number
  windDir: number
  windKts: number
  oat: number
  track: number
  squawk: string
  category: string
  emergency: boolean
  dataSource: string
  military: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: F[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'CRIT-DMG' | 'HIGH-DMG' | 'DAMAGE' | 'WATCH' | 'NOMINAL' | 'OFF'
type Phase = 'CLB-INI' | 'CLB' | 'CRZ' | 'DSC' | 'APP-INT' | 'APP-FNL' | 'TXY' | 'OFF'
type Driver = 'PHASE' | 'AGL' | 'FLYWAY' | 'SEASON' | 'DIEL' | 'AIRPORT' | 'MASS' | 'CERT'

const TIER_COLOR: Record<Tier, string> = {
  'CRIT-DMG':  '#f43f5e',
  'HIGH-DMG':  '#fb7185',
  'DAMAGE':    '#f59e0b',
  'WATCH':     '#0ea5e9',
  'NOMINAL':   '#10b981',
  'OFF':       '#475569',
}

const PHASE_W: Record<Phase, number> = {
  'CLB-INI': 1.45,   // post-rotation through 1500ft AGL — Hudson 1549 mode
  'CLB':     1.18,   // 1500-10000ft AGL — initial climb
  'CRZ':     0.45,   // bird-strike <1% above FL100
  'DSC':     0.80,
  'APP-INT': 1.25,   // 3000-1500ft AGL
  'APP-FNL': 1.40,   // <1500ft AGL — Ryanair FR4102 mode
  'TXY':     0.55,
  'OFF':     0.00,
}

// 8 North American & global migratory flyways per USFWS / Wetlands International
// + USFWS bird-collision strike-density studies + Boere Waterbird Pop 2007
type Flyway = {
  id: string
  name: string
  // bbox approximation (lat/lng)
  bbox: [number, number, number, number] // [latMin, lngMin, latMax, lngMax]
  // peak migration months (1-12). 0 = year-round transient
  peakMonths: number[]
  // dominant species mass class — informs §33.76 cert envelope
  dominantMass: 'SMALL' | 'MED' | 'LARGE' | 'MIXED'  // <85g / 85g-1.15kg / 1.15-3.65kg / mixed
  // peak density (relative 0..1)
  peak: number
  // citation
  cite: string
}

const FLYWAYS: Flyway[] = [
  // North America (4 USFWS flyways)
  { id: 'ATL-NA',  name: 'Atlantic Flyway (NA)',        bbox: [25,-80,52,-60],   peakMonths: [3,4,5,9,10,11], dominantMass: 'LARGE',  peak: 0.92, cite: 'USFWS Atlantic Flyway Council 2024 / NAWMP 2018' },
  { id: 'MIS-NA',  name: 'Mississippi Flyway (NA)',     bbox: [25,-100,52,-80],  peakMonths: [3,4,5,9,10,11], dominantMass: 'LARGE',  peak: 1.00, cite: 'USFWS Mississippi Flyway Council 2024 / Wing-band recoveries' },
  { id: 'CEN-NA',  name: 'Central Flyway (NA)',         bbox: [25,-115,52,-100], peakMonths: [3,4,9,10,11],   dominantMass: 'MIXED',  peak: 0.85, cite: 'USFWS Central Flyway Council 2024 / Lincoln band-recovery' },
  { id: 'PAC-NA',  name: 'Pacific Flyway (NA)',         bbox: [25,-130,52,-115], peakMonths: [3,4,9,10,11],   dominantMass: 'LARGE',  peak: 0.88, cite: 'USFWS Pacific Flyway Council 2024 / Klamath Basin staging' },
  // Eurasia / Africa
  { id: 'EAA-EU',  name: 'East-Atlantic Flyway',        bbox: [-35,-25,71,15],   peakMonths: [3,4,9,10,11],   dominantMass: 'MIXED',  peak: 0.90, cite: 'AEWA / Wetlands Intl Boere 2007 / Birdlife Intl Spec 2024' },
  { id: 'MED-EU',  name: 'Black Sea / Mediterranean',   bbox: [10,-10,55,40],    peakMonths: [3,4,5,8,9,10],  dominantMass: 'LARGE',  peak: 0.93, cite: 'EURING / AEWA / Birdlife Mediterranean Spec 2024' },
  { id: 'WAS-AS',  name: 'West Asian / E. African',     bbox: [-35,35,60,75],    peakMonths: [3,4,9,10],      dominantMass: 'MIXED',  peak: 0.78, cite: 'AEWA / Wetlands Intl Asia 2024 / Black Sea route' },
  { id: 'CAS-AS',  name: 'Central Asian Flyway',        bbox: [0,55,85,100],     peakMonths: [3,4,9,10],      dominantMass: 'MIXED',  peak: 0.75, cite: 'CMS CAF Action Plan 2008 / BNHS India' },
  { id: 'EAA-PAC', name: 'East Asian-Australasian',     bbox: [-50,100,71,170],  peakMonths: [3,4,9,10,11],   dominantMass: 'MIXED',  peak: 0.95, cite: 'EAAFP Partnership 2024 / Yellow Sea staging' },
  { id: 'PAC-AM',  name: 'Pacific Americas',            bbox: [-55,-90,15,-70],  peakMonths: [9,10,3,4],      dominantMass: 'SMALL',  peak: 0.62, cite: 'WHSRN / Pacific Coast shorebird census 2024' },
  { id: 'ATL-AM',  name: 'Atlantic Americas',           bbox: [-55,-70,15,-30],  peakMonths: [9,10,3,4],      dominantMass: 'SMALL',  peak: 0.60, cite: 'WHSRN / Atlantic Coast 2024' },
  { id: 'AUS-NZ',  name: 'Australasian Local',          bbox: [-50,110,-10,180], peakMonths: [0],             dominantMass: 'MIXED',  peak: 0.55, cite: 'BirdLife Australia Atlas / NZ DOC' },
]

// 8-class engine ingestion certification catalogue per §33.76 / CS-E 800
// med-bird (1.15 kg) / large-bird (1.85 / 2.50 / 3.65 kg) ingest at 200 kts
type EngClass = {
  id: string
  label: string
  // §33.76 medium-flock + single large-bird mass envelope (kg)
  medCert: number
  lrgCert: number
  // engine model exemplars
  exemplars: string
  // §33.77 small flock fan-blade containment proxy (0..1)
  containment: number
  // certification family
  cite: string
}

const ENG_CLASSES: EngClass[] = [
  { id: 'CFM56',     label: 'CFM56 (NB legacy)',           medCert: 0.70, lrgCert: 1.85, exemplars: 'B737NG/A320ceo',                   containment: 0.86, cite: '14 CFR §33.76(c) Amdt.33-23 / CFM Type Cert E26NE' },
  { id: 'V2500',     label: 'V2500 (NB legacy)',           medCert: 0.70, lrgCert: 1.85, exemplars: 'A320ceo',                          containment: 0.84, cite: 'IAE V2500 Type Cert / §33.76 amdt-23' },
  { id: 'LEAP-1A',   label: 'LEAP-1A/1B (NB neo)',         medCert: 0.85, lrgCert: 2.50, exemplars: 'A320neo/B737MAX',                  containment: 0.92, cite: '14 CFR §33.76(c) Amdt.33-26 / CFM TC E00088EN' },
  { id: 'PW1100G',   label: 'PW1100G GTF (NB neo)',        medCert: 0.85, lrgCert: 2.50, exemplars: 'A320neo/A220',                     containment: 0.90, cite: '§33.76 amdt-26 / PW TC E00087EN' },
  { id: 'GEnx',      label: 'GEnx-1B / Trent 1000 (WB-M)', medCert: 1.15, lrgCert: 2.75, exemplars: 'B787/A330neo',                     containment: 0.94, cite: '§33.76 amdt-26 / GE TC E00078EN' },
  { id: 'Trent-XWB', label: 'Trent XWB (WB-LH)',           medCert: 1.15, lrgCert: 3.65, exemplars: 'A350-900/1000',                    containment: 0.95, cite: '§33.76(d) lrg-bird 3.65kg / EASA E.111' },
  { id: 'GE9X',      label: 'GE9X (Ultra-WB)',             medCert: 1.15, lrgCert: 3.65, exemplars: 'B777X',                            containment: 0.96, cite: '§33.76(d) / GE TC E00094EN' },
  { id: 'PW127',     label: 'PW127 / PT6 (turboprop)',     medCert: 0.45, lrgCert: 1.15, exemplars: 'AT72/Q400/DH8',                    containment: 0.55, cite: '§33.77 fan-blade / TP Indu Std SAE ARP1542' },
]

// 22-airport wildlife-hazard catalogue ranked by FAA Strike DB strike count
// + airport WHMP (Wildlife Hazard Management Plan) status per AC 150/5200-32B
type AirportH = {
  iata: string
  icao: string
  lat: number
  lng: number
  // strike-rate index 0..1 normalised to top in FAA DB
  rate: number
  // WHMP plan maturity 0..1 (1 = full FAR 139.337 plan + biologist)
  whmp: number
  // species hazard profile
  spec: 'WATERFOWL' | 'RAPTOR' | 'GULL' | 'PASSERINE' | 'MIXED'
  cite: string
}

const AIRPORTS_H: AirportH[] = [
  // North America — highest strike counts FAA DB 1990-2023
  { iata: 'JFK',  icao: 'KJFK', lat: 40.6398, lng: -73.7789, rate: 0.96, whmp: 0.95, spec: 'WATERFOWL', cite: 'FAA WSD #1 Jamaica Bay NWR adj / PANYNJ Goose Cull' },
  { iata: 'LGA',  icao: 'KLGA', lat: 40.7769, lng: -73.8740, rate: 0.92, whmp: 0.94, spec: 'WATERFOWL', cite: 'US 1549 Hudson 2009 NTSB AAR-10-03 / EBB Jamaica Bay' },
  { iata: 'EWR',  icao: 'KEWR', lat: 40.6925, lng: -74.1687, rate: 0.88, whmp: 0.92, spec: 'WATERFOWL', cite: 'NJ Meadowlands wetland adj / FAA WSD top-5' },
  { iata: 'ORD',  icao: 'KORD', lat: 41.9742, lng: -87.9073, rate: 0.85, whmp: 0.93, spec: 'GULL',      cite: 'Lake MI gull-roost / WHMP USDA Wildlife Services' },
  { iata: 'DEN',  icao: 'KDEN', lat: 39.8561, lng: -104.6737,rate: 0.74, whmp: 0.88, spec: 'RAPTOR',    cite: 'Rocky-Mtn buteo + prairie waterfowl / FAA WSD top-15' },
  { iata: 'SLC',  icao: 'KSLC', lat: 40.7884, lng: -111.9778,rate: 0.78, whmp: 0.90, spec: 'WATERFOWL', cite: 'GSL avian fly-zone / WHMP USDA WS' },
  { iata: 'SFO',  icao: 'KSFO', lat: 37.6213, lng: -122.3790,rate: 0.72, whmp: 0.87, spec: 'GULL',      cite: 'SF Bay NWR adj / USDA WS WHMP' },
  { iata: 'BOS',  icao: 'KBOS', lat: 42.3656, lng: -71.0096, rate: 0.81, whmp: 0.91, spec: 'WATERFOWL', cite: 'Logan Massport Goose / Eastman 1960 Lockheed Electra L188 PIB' },
  { iata: 'MIA',  icao: 'KMIA', lat: 25.7959, lng: -80.2870, rate: 0.69, whmp: 0.85, spec: 'MIXED',     cite: 'Everglades wading-bird / FAA WSD top-20' },
  { iata: 'LAX',  icao: 'KLAX', lat: 33.9416, lng: -118.4085,rate: 0.68, whmp: 0.86, spec: 'GULL',      cite: 'Ballona wetland adj / WHMP USDA WS' },
  { iata: 'DFW',  icao: 'KDFW', lat: 32.8998, lng: -97.0403, rate: 0.65, whmp: 0.84, spec: 'PASSERINE', cite: 'Central Flyway transit / WHMP USDA WS' },
  { iata: 'ATL',  icao: 'KATL', lat: 33.6407, lng: -84.4277, rate: 0.62, whmp: 0.84, spec: 'PASSERINE', cite: 'Southeast Atlantic Flyway / WHMP USDA WS' },
  // Europe — EASA Reg.139/2014 wildlife hazard programmes
  { iata: 'LHR',  icao: 'EGLL', lat: 51.4700, lng: -0.4543,  rate: 0.83, whmp: 0.96, spec: 'WATERFOWL', cite: 'CAA CAP 772 / Heathrow Wildlife Hazard Mgmt 2024' },
  { iata: 'CDG',  icao: 'LFPG', lat: 49.0097, lng:  2.5479,  rate: 0.79, whmp: 0.93, spec: 'WATERFOWL', cite: 'DSAC PERIL falconry / DGAC Wildlife Hazard' },
  { iata: 'AMS',  icao: 'EHAM', lat: 52.3105, lng:  4.7683,  rate: 0.86, whmp: 0.95, spec: 'WATERFOWL', cite: 'Turkish 1951 KLM 738 2009 NLD AAR / KLM AAA' },
  { iata: 'FRA',  icao: 'EDDF', lat: 50.0379, lng:  8.5622,  rate: 0.71, whmp: 0.92, spec: 'PASSERINE', cite: 'BFU Wildlife Hazard / Fraport WHMP' },
  { iata: 'CIA',  icao: 'LIRA', lat: 41.7994, lng: 12.5949,  rate: 0.94, whmp: 0.78, spec: 'PASSERINE', cite: 'Ryanair FR4102 starling 2008-11-10 ANSV / Ciampino starling roost' },
  { iata: 'MAD',  icao: 'LEMD', lat: 40.4720, lng: -3.5610,  rate: 0.68, whmp: 0.89, spec: 'MIXED',     cite: 'AESA Wildlife / AENA WHMP / Iberian peninsula route' },
  // Asia / Pacific
  { iata: 'NRT',  icao: 'RJAA', lat: 35.7720, lng: 140.3929, rate: 0.66, whmp: 0.88, spec: 'WATERFOWL', cite: 'JCAB Wildlife / EAAFP Yellow-Sea staging' },
  { iata: 'HND',  icao: 'RJTT', lat: 35.5494, lng: 139.7798, rate: 0.74, whmp: 0.90, spec: 'GULL',      cite: 'JCAB Wildlife / Tokyo Bay landfill gull-roost' },
  { iata: 'PEK',  icao: 'ZBAA', lat: 40.0801, lng: 116.5846, rate: 0.72, whmp: 0.76, spec: 'PASSERINE', cite: 'CAAC Wildlife Hazard / 09.04.2020 PEK incident' },
  { iata: 'SYD',  icao: 'YSSY', lat: -33.9461,lng: 151.1772, rate: 0.61, whmp: 0.87, spec: 'GULL',      cite: 'CASA MOS 139 §10.16 / Sydney Airport WHMP' },
]

// hash for deterministic synthesis
function hash32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}

// great-circle distance NM
function gcDistNm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = Math.PI / 180
  const dLat = (b.lat - a.lat) * toRad
  const dLng = (b.lng - a.lng) * toRad
  const la1 = a.lat * toRad, la2 = b.lat * toRad
  const x = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2
  return 2 * 3440 * Math.asin(Math.min(1, Math.sqrt(x)))
}

function inBbox(f: F, b: [number, number, number, number]): boolean {
  if (f.lat < b[0] || f.lat > b[2]) return false
  if (b[1] <= b[3]) return f.lng >= b[1] && f.lng <= b[3]
  return f.lng >= b[1] || f.lng <= b[3]
}

// Classify aircraft to engine class from ICAO type
function pickEngClass(type: string): EngClass {
  const t = (type || '').toUpperCase()
  // Wide-body ultra
  if (/^B77[XW9]|^B779/.test(t)) return ENG_CLASSES.find(e => e.id === 'GE9X')!
  // Wide-body LH
  if (/^A35|^A359|^A35K|^B77L|^B77F|^B772|^B748|^B744/.test(t)) return ENG_CLASSES.find(e => e.id === 'Trent-XWB')!
  // Wide-body medium
  if (/^B78|^A33[0-9]|^A338|^A339|^B763|^B764|^A332/.test(t)) return ENG_CLASSES.find(e => e.id === 'GEnx')!
  // NB neo / MAX / A220
  if (/^A21N|^A20N|^A319N|^B38M|^B39M|^B37M|^B3M[78]|^A220|^BCS[123]/.test(t)) return ENG_CLASSES.find(e => e.id === 'LEAP-1A')!
  // NB ceo
  if (/^A31[89]|^A320|^A321|^B73[5678]|^B73N|^B73G/.test(t)) return ENG_CLASSES.find(e => e.id === 'CFM56')!
  // V2500-specific A320ceo subset
  if (/^A320|^A321/.test(t) && (hash32(type) & 1)) return ENG_CLASSES.find(e => e.id === 'V2500')!
  // Turboprop
  if (/^AT[47][26]|^DH8|^Q40|^SF34|^E12[01]|^J32|^F50|^PC12|^C208|^B19[02]/.test(t)) return ENG_CLASSES.find(e => e.id === 'PW127')!
  // Regional jet — treat as CFM56-class
  if (/^E1[79]0|^E29[05]|^E1[34]5|^CRJ|^E170|^E190|^E195/.test(t)) return ENG_CLASSES.find(e => e.id === 'CFM56')!
  // Business jet — newer GTF-class
  if (/^G6[05]0|^GLEX|^GLF|^FA[78]X|^CL30|^CL35|^CL60|^E55P|^C68A|^C700/.test(t)) return ENG_CLASSES.find(e => e.id === 'PW1100G')!
  // default
  return ENG_CLASSES.find(e => e.id === 'CFM56')!
}

interface Row {
  f: F
  phase: Phase
  agl: number               // AGL feet (synthesised from snap)
  flyway: Flyway | null
  flywayActive: boolean     // are we in peak migration month
  airport: AirportH | null  // nearest hazard airport within 12NM
  distAirportNm: number
  engClass: EngClass
  // bird species proxy
  birdMass: number          // kg representative mass (small/med/large band)
  birdSpecies: 'SMALL' | 'MED' | 'LARGE' | 'XL'
  // certification margin
  certMargin: number        // 1.0 = cert-mass; <1 = below cert (covered); >1 = above cert (damage)
  // diel period (dawn / dusk peak)
  diel: number              // 0..1 score
  sev: Record<Driver, number>
  score: number
  tier: Tier
  topDriver: Driver
}

const SRC_HALO = 'birdx-halo-src', SRC_PIN = 'birdx-pin-src', SRC_LBL = 'birdx-lbl-src'
const SRC_FLY = 'birdx-fly-src', SRC_APT = 'birdx-apt-src'
const LYR_FLY_FILL = 'birdx-fly-fill', LYR_FLY_LINE = 'birdx-fly-line'
const LYR_APT = 'birdx-apt-lyr', LYR_APT_LBL = 'birdx-apt-lbl'
const LYR_HALO = 'birdx-halo-lyr', LYR_PIN = 'birdx-pin-lyr', LYR_LBL = 'birdx-lbl-lyr'

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function advice(r: Row): string {
  if (r.tier === 'CRIT-DMG') return `§33.76 envelope BREACHED · ${r.engClass.id} med-cert ${r.engClass.medCert}kg vs ${r.birdMass.toFixed(2)}kg ${r.birdSpecies} · expect engine damage if struck · brief NO LAND-DAMAGE-INSPECTED per Boeing FCOM ENG.SUPP / Airbus PRO-ABN-70`
  if (r.tier === 'HIGH-DMG') return `Above §33.76 cert envelope · ${r.engClass.id} large-cert ${r.engClass.lrgCert}kg / single ${r.birdMass.toFixed(2)}kg ${r.birdSpecies} · containment ${(r.engClass.containment*100).toFixed(0)}% only · monitor TCAS for flock + lookout`
  if (r.tier === 'DAMAGE') return `Within §33.76 envelope but damage probable · ${r.airport ? r.airport.iata+' WHMP-active' : 'transit flyway'} · arm CONTINUOUS-IGNITION per FCOM SUPP / aural lookout`
  if (r.tier === 'WATCH') return `Elevated flyway-density / dusk activity · brief crew lookout / use landing-lights below 10kAGL FAA AC 91-44 §3`
  if (r.tier === 'NOMINAL') return `Low strike-risk band · normal operations · WHMP per host airport AC 150/5200-32B`
  return 'Outside scoring envelope (cruise / FL>200 / on-stand)'
}

export default function BirdxStrike({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'FLYWAYS' | 'ENGINES' | 'METHOD'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [flywayFilter, setFlywayFilter] = useState<string>('ALL')
  const [engFilter, setEngFilter] = useState<string>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [advMul, setAdvMul] = useState(100)
  const [scopeNm, setScopeNm] = useState(12)         // airport hazard snap
  const [maxFl, setMaxFl] = useState(100)            // bird strike envelope ceiling FL
  const [monthOverride, setMonthOverride] = useState<number | 'AUTO'>('AUTO')
  const [query, setQuery] = useState('')

  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showFly, setShowFly] = useState(true)
  const [showApt, setShowApt] = useState(true)

  // Determine season for phasing
  const nowMonth = useMemo(() => {
    if (monthOverride === 'AUTO') return new Date().getMonth() + 1
    return monthOverride
  }, [monthOverride])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground && !(f.altitudeFt < 50)) continue
      if (!isFinite(f.altitudeFt)) continue

      // Phase classifier — bird-strike scoring envelope is climb/approach <FL100
      const fl = f.altitudeFt / 100
      if (fl > maxFl) continue
      let phase: Phase = 'OFF'
      if (f.ground) phase = 'TXY'
      else if (f.vertRate > 800 && fl < 30) phase = 'CLB-INI'
      else if (f.vertRate > 400 && fl < 100) phase = 'CLB'
      else if (f.vertRate < -600 && fl < 15) phase = 'APP-FNL'
      else if (f.vertRate < -300 && fl < 60) phase = 'APP-INT'
      else if (f.vertRate < -200) phase = 'DSC'
      else if (fl >= 30) phase = 'CRZ'
      else phase = 'CLB'

      // AGL synthesis: assume sea-level ref for water/coast; else 500ft terrain
      // Better: subtract nearest-airport elev once snapped
      const agl = Math.max(0, f.altitudeFt - 200)

      // Flyway placement
      let flyway: Flyway | null = null
      for (const fl_ of FLYWAYS) {
        if (inBbox(f, fl_.bbox)) { flyway = fl_; break }
      }
      const flywayActive = flyway ? (flyway.peakMonths.includes(0) || flyway.peakMonths.includes(nowMonth)) : false

      // Airport hazard snap — nearest within scope
      let airport: AirportH | null = null
      let distNm = Infinity
      for (const a of AIRPORTS_H) {
        const d = gcDistNm({ lat: f.lat, lng: f.lng }, { lat: a.lat, lng: a.lng })
        if (d < distNm) { distNm = d; airport = a }
      }
      if (distNm > scopeNm) airport = null

      // Engine class from ICAO type
      const engClass = pickEngClass(f.type)

      // Bird species from flyway-dominant-mass × seasonal-weight × hash deviation
      const h = hash32(f.icao || f.callsign || 'X')
      const dom = flyway?.dominantMass || 'MIXED'
      // base mass kg
      let baseMass = 0.085 // SMALL passerine
      if (dom === 'MED') baseMass = 0.55
      else if (dom === 'LARGE') baseMass = 2.10
      else baseMass = ((h & 0xff) / 255) < 0.30 ? 2.10 : ((h & 0xff) / 255) < 0.65 ? 0.55 : 0.085
      // hash variability ±40%
      const massVar = 0.60 + ((h >>> 8) & 0xff) / 255 * 0.80
      const birdMass = baseMass * massVar
      const birdSpecies: Row['birdSpecies'] =
        birdMass >= 2.5 ? 'XL' :
        birdMass >= 1.15 ? 'LARGE' :
        birdMass >= 0.085 ? 'MED' : 'SMALL'

      // Certification margin (cert mass / actual mass) — <1 = breach
      const certMass = birdSpecies === 'SMALL' ? engClass.medCert : birdSpecies === 'MED' ? engClass.medCert : engClass.lrgCert
      const certMargin = certMass / Math.max(birdMass, 0.01)

      // Diel period — synthesise dawn/dusk window from longitude → local solar
      // Without real timestamp we use deterministic hash for "minutes past noon local"
      const dielHash = ((h >>> 17) & 0xff) / 255 * 24
      const dielHour = ((dielHash + (f.lng / 15) + 12) % 24)
      const isDawn = dielHour >= 5.0 && dielHour <= 8.0
      const isDusk = dielHour >= 17.0 && dielHour <= 20.0
      const diel = isDawn ? 1.0 : isDusk ? 0.95 : (dielHour >= 8 && dielHour <= 17) ? 0.45 : 0.65

      // 8 risk drivers
      const phaseSev = PHASE_W[phase] * 60 // 0..87 from phase
      // AGL severity — peak <1500ft AGL
      const aglSev = agl < 500 ? 92 :
                     agl < 1500 ? 78 :
                     agl < 3000 ? 60 :
                     agl < 6000 ? 40 :
                     agl < 10000 ? 22 :
                     agl < 15000 ? 12 : 5
      const flywaySev = !flyway ? 8 :
                        !flywayActive ? 22 :
                        flyway.peak >= 0.90 ? 75 :
                        flyway.peak >= 0.75 ? 58 :
                        flyway.peak >= 0.55 ? 35 : 20
      const seasonSev = flywayActive ? 65 : 18
      const dielSev = diel * 70
      const apSev = !airport ? 6 :
                    airport.rate >= 0.90 ? 90 :
                    airport.rate >= 0.80 ? 75 :
                    airport.rate >= 0.65 ? 55 :
                    airport.rate >= 0.50 ? 35 : 20
      // Mass severity — larger bird = higher severity vector
      const massSev = birdSpecies === 'XL' ? 92 :
                      birdSpecies === 'LARGE' ? 75 :
                      birdSpecies === 'MED' ? 45 :
                      18
      // Cert severity — cert breach
      const certSev = certMargin < 0.4 ? 96 :
                      certMargin < 0.65 ? 82 :
                      certMargin < 0.85 ? 60 :
                      certMargin < 1.0 ? 35 :
                      certMargin < 1.4 ? 18 : 6

      const sev: Record<Driver, number> = {
        PHASE: phaseSev,
        AGL: aglSev,
        FLYWAY: flywaySev,
        SEASON: seasonSev,
        DIEL: dielSev,
        AIRPORT: apSev,
        MASS: massSev,
        CERT: certSev,
      }

      // composite max·0.62 + mean·0.38 × adv × phase
      const arr = Object.values(sev)
      const maxV = Math.max(...arr)
      const meanV = arr.reduce((a, b) => a + b, 0) / arr.length
      let composite = (maxV * 0.62 + meanV * 0.38) * (PHASE_W[phase] || 0.6)
      composite = composite * (advMul / 100)

      // hard escalators
      if (certMargin < 0.55 && (phase === 'CLB-INI' || phase === 'APP-FNL')) {
        composite = Math.max(composite, 92) // §33.76 breach + low-AGL critical phase
      }
      if (airport && airport.rate >= 0.90 && flywayActive && (phase === 'CLB-INI' || phase === 'CLB')) {
        composite = Math.max(composite, 85) // KJFK/KLGA/EHAM Hudson-mode
      }
      if (birdSpecies === 'XL' && phase === 'CLB-INI') {
        composite = Math.max(composite, 78) // single XL goose post-rotation
      }

      composite = Math.max(0, Math.min(100, composite))

      const phaseAny: string = phase
      const tier: Tier = phaseAny === 'OFF' || phaseAny === 'CRZ' ? 'OFF' :
                         composite >= 85 ? 'CRIT-DMG' :
                         composite >= 65 ? 'HIGH-DMG' :
                         composite >= 45 ? 'DAMAGE' :
                         composite >= 25 ? 'WATCH' : 'NOMINAL'

      // top driver
      let topDriver: Driver = 'PHASE'
      let topV = -1
      ;(Object.entries(sev) as [Driver, number][]).forEach(([k, v]) => {
        if (v > topV) { topV = v; topDriver = k }
      })

      out.push({
        f, phase, agl, flyway, flywayActive, airport, distAirportNm: distNm,
        engClass, birdMass, birdSpecies, certMargin, diel,
        sev, score: composite, tier, topDriver,
      })
    }
    return out
  }, [flights, nowMonth, scopeNm, maxFl, advMul])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { 'CRIT-DMG': 0, 'HIGH-DMG': 0, 'DAMAGE': 0, 'WATCH': 0, 'NOMINAL': 0, 'OFF': 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (flywayFilter !== 'ALL' && r.flyway?.id !== flywayFilter) return false
      if (engFilter !== 'ALL' && r.engClass.id !== engFilter) return false
      if (phaseFilter !== 'ALL' && r.phase !== phaseFilter) return false
      if (q) {
        const hay = `${r.f.callsign} ${r.f.icao} ${r.f.type} ${r.f.operator} ${r.flyway?.id || ''} ${r.airport?.iata || ''} ${r.engClass.id}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    }).sort((a, b) => b.score - a.score)
  }, [rows, tierFilter, flywayFilter, engFilter, phaseFilter, query])

  // Per-flyway aggregate
  const flyStats = useMemo(() => {
    const m = new Map<string, { f: Flyway; count: number; crit: number; damage: number; muScore: number }>()
    for (const r of rows) {
      if (!r.flyway) continue
      const k = r.flyway.id
      const cur = m.get(k) || { f: r.flyway, count: 0, crit: 0, damage: 0, muScore: 0 }
      cur.count++
      if (r.tier === 'CRIT-DMG' || r.tier === 'HIGH-DMG') cur.crit++
      if (r.tier === 'DAMAGE') cur.damage++
      cur.muScore += r.score
      m.set(k, cur)
    }
    return Array.from(m.values()).map(s => ({ ...s, muScore: s.muScore / Math.max(1, s.count) })).sort((a, b) => b.count - a.count)
  }, [rows])

  // Per-engine class aggregate
  const engStats = useMemo(() => {
    return ENG_CLASSES.map(ec => {
      const inClass = rows.filter(r => r.engClass.id === ec.id)
      const crit = inClass.filter(r => r.tier === 'CRIT-DMG' || r.tier === 'HIGH-DMG').length
      const muMargin = inClass.length ? inClass.reduce((s, r) => s + r.certMargin, 0) / inClass.length : 0
      const muScore = inClass.length ? inClass.reduce((s, r) => s + r.score, 0) / inClass.length : 0
      return { ec, count: inClass.length, crit, muMargin, muScore }
    }).sort((a, b) => b.count - a.count)
  }, [rows])

  // Render to MapLibre
  useEffect(() => {
    if (!map) return

    const ensureSrc = (id: string, data: any) => {
      const s = map.getSource(id) as any
      if (s) { s.setData(data) } else { map.addSource(id, { type: 'geojson', data }) }
    }
    const ensureLyr = (id: string, def: any) => {
      if (!map.getLayer(id)) map.addLayer(def)
    }

    const removeAll = () => {
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_APT_LBL, LYR_APT, LYR_FLY_LINE, LYR_FLY_FILL]) {
        if (map.getLayer(id)) try { map.removeLayer(id) } catch {}
      }
      for (const id of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_FLY, SRC_APT]) {
        if (map.getSource(id)) try { map.removeSource(id) } catch {}
      }
    }

    // flyway polygons
    const flyFc = {
      type: 'FeatureCollection',
      features: FLYWAYS.map(fl => {
        const active = fl.peakMonths.includes(0) || fl.peakMonths.includes(nowMonth)
        const [latMin, lngMin, latMax, lngMax] = fl.bbox
        const coords = [[[lngMin, latMin], [lngMax, latMin], [lngMax, latMax], [lngMin, latMax], [lngMin, latMin]]]
        return {
          type: 'Feature',
          properties: { id: fl.id, name: fl.name, active, peak: fl.peak, dominantMass: fl.dominantMass },
          geometry: { type: 'Polygon', coordinates: coords },
        }
      }),
    }

    // airport hazard markers
    const aptFc = {
      type: 'FeatureCollection',
      features: AIRPORTS_H.map(a => ({
        type: 'Feature',
        properties: { iata: a.iata, icao: a.icao, rate: a.rate, whmp: a.whmp, spec: a.spec, color: a.rate >= 0.85 ? '#f43f5e' : a.rate >= 0.70 ? '#fb7185' : a.rate >= 0.55 ? '#f59e0b' : '#0ea5e9' },
        geometry: { type: 'Point', coordinates: [a.lng, a.lat] },
      })),
    }

    const haloFc = {
      type: 'FeatureCollection',
      features: visible.slice(0, 200).map(r => ({
        type: 'Feature',
        properties: { score: r.score, tier: r.tier, color: TIER_COLOR[r.tier], radius: 6 + (r.score / 100) * 18 },
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
      })),
    }
    const pinFc = {
      type: 'FeatureCollection',
      features: visible.filter(r => r.score >= 65).slice(0, 80).map(r => ({
        type: 'Feature',
        properties: { color: TIER_COLOR[r.tier] },
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
      })),
    }
    const lblFc = {
      type: 'FeatureCollection',
      features: visible.slice(0, 50).map(r => ({
        type: 'Feature',
        properties: {
          label: `${r.f.callsign || r.f.icao}·${r.engClass.id}·${r.birdSpecies}${r.birdMass.toFixed(1)}kg·${r.phase}`,
          color: TIER_COLOR[r.tier],
        },
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
      })),
    }

    ensureSrc(SRC_FLY, flyFc as any)
    ensureSrc(SRC_APT, aptFc as any)
    ensureSrc(SRC_HALO, haloFc as any)
    ensureSrc(SRC_PIN, pinFc as any)
    ensureSrc(SRC_LBL, lblFc as any)

    if (showFly) {
      ensureLyr(LYR_FLY_FILL, { id: LYR_FLY_FILL, type: 'fill', source: SRC_FLY, paint: {
        'fill-color': ['case', ['get', 'active'], '#f43f5e', '#475569'],
        'fill-opacity': ['case', ['get', 'active'], 0.05, 0.02],
      } })
      ensureLyr(LYR_FLY_LINE, { id: LYR_FLY_LINE, type: 'line', source: SRC_FLY, paint: {
        'line-color': ['case', ['get', 'active'], '#f43f5e', '#64748b'],
        'line-width': 1.0,
        'line-opacity': ['case', ['get', 'active'], 0.50, 0.22],
        'line-dasharray': [3, 2],
      } })
    } else {
      for (const id of [LYR_FLY_FILL, LYR_FLY_LINE]) if (map.getLayer(id)) try { map.removeLayer(id) } catch {}
    }

    if (showApt) {
      ensureLyr(LYR_APT, { id: LYR_APT, type: 'circle', source: SRC_APT, paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'rate'], 0.5, 4, 1.0, 10],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.30,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.2,
        'circle-stroke-opacity': 0.85,
      } })
      ensureLyr(LYR_APT_LBL, { id: LYR_APT_LBL, type: 'symbol', source: SRC_APT, layout: {
        'text-field': ['concat', ['get', 'iata'], ' ', ['get', 'spec']],
        'text-size': 9,
        'text-offset': [0, -1.2],
        'text-anchor': 'bottom',
        'text-font': ['Open Sans Regular'],
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#0f172a',
        'text-halo-width': 1.2,
      } })
    } else {
      for (const id of [LYR_APT, LYR_APT_LBL]) if (map.getLayer(id)) try { map.removeLayer(id) } catch {}
    }

    if (showHalo) ensureLyr(LYR_HALO, { id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
      'circle-radius': ['get', 'radius'],
      'circle-color': ['get', 'color'],
      'circle-opacity': 0.18,
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': 1.2,
      'circle-stroke-opacity': 0.85,
    } })
    else if (map.getLayer(LYR_HALO)) try { map.removeLayer(LYR_HALO) } catch {}

    if (showPin) ensureLyr(LYR_PIN, { id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: {
      'circle-radius': 3.5,
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#0f172a',
      'circle-stroke-width': 1.0,
    } })
    else if (map.getLayer(LYR_PIN)) try { map.removeLayer(LYR_PIN) } catch {}

    if (showLbl) ensureLyr(LYR_LBL, { id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
      'text-field': ['get', 'label'],
      'text-size': 9,
      'text-offset': [0, 1.4],
      'text-anchor': 'top',
      'text-font': ['Open Sans Regular'],
    }, paint: {
      'text-color': ['get', 'color'],
      'text-halo-color': '#0f172a',
      'text-halo-width': 1.2,
    } })
    else if (map.getLayer(LYR_LBL)) try { map.removeLayer(LYR_LBL) } catch {}

    return () => { removeAll() }
  }, [map, visible, nowMonth, showHalo, showPin, showLbl, showFly, showApt])

  return (
    <div className="absolute top-16 right-4 z-40 w-[min(94vw,460px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Wildlife Strike / §33.76</div>
          <div className="text-sm font-semibold text-slate-100">BIRDX · Bird-Strike Engine-Damage Monitor</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* Tier strip */}
      <div className="px-3 py-1.5 border-b border-slate-800 flex items-center gap-1 text-[10px]">
        <button onClick={() => setTierFilter('ALL')} className={`px-2 py-0.5 rounded font-mono ${tierFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-400'}`}>ALL {rows.length}</button>
        {(['CRIT-DMG', 'HIGH-DMG', 'DAMAGE', 'WATCH', 'NOMINAL', 'OFF'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(t)} className={`px-1.5 py-0.5 rounded font-mono ${tierFilter === t ? 'border-2' : 'border'}`} style={{ borderColor: TIER_COLOR[t] + '55', color: TIER_COLOR[t], background: TIER_COLOR[t] + '10' }}>
            {t.split('-')[0].slice(0, 3)} {tierCounts[t]}
          </button>
        ))}
      </div>

      {/* Summary cells */}
      <div className="px-3 py-1 border-b border-slate-800 grid grid-cols-5 gap-1 text-[10px]">
        <div className="bg-slate-800/40 rounded px-1 py-0.5">μ-SCR <span className="font-mono text-slate-100 ml-1">{(rows.reduce((s, r) => s + r.score, 0) / Math.max(1, rows.length)).toFixed(1)}</span></div>
        <div className="bg-slate-800/40 rounded px-1 py-0.5">FLY <span className="font-mono text-sky-300 ml-1">{rows.filter(r => r.flyway).length}</span></div>
        <div className="bg-slate-800/40 rounded px-1 py-0.5">MIG <span className="font-mono text-rose-300 ml-1">{rows.filter(r => r.flywayActive).length}</span></div>
        <div className="bg-slate-800/40 rounded px-1 py-0.5">CRIT <span className="font-mono ml-1" style={{ color: TIER_COLOR['CRIT-DMG'] }}>{tierCounts['CRIT-DMG']}</span></div>
        <div className="bg-slate-800/40 rounded px-1 py-0.5">APT <span className="font-mono text-slate-100 ml-1">{rows.filter(r => r.airport).length}</span></div>
      </div>

      {/* Controls */}
      <div className="px-3 py-1.5 border-b border-slate-800 space-y-1 text-[10px]">
        <div className="flex items-center gap-2">
          <span className="text-slate-500 w-16 font-mono">ADV-MUL</span>
          <input type="range" min={50} max={200} value={advMul} onChange={e => setAdvMul(parseInt(e.target.value))} className="flex-1 accent-sky-500 h-1" />
          <span className="font-mono text-slate-300 w-10 text-right">{advMul}%</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500 w-16 font-mono">SCOPE</span>
          <input type="range" min={3} max={40} value={scopeNm} onChange={e => setScopeNm(parseInt(e.target.value))} className="flex-1 accent-sky-500 h-1" />
          <span className="font-mono text-slate-300 w-10 text-right">{scopeNm}NM</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500 w-16 font-mono">MAX-FL</span>
          <input type="range" min={30} max={250} step={5} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="flex-1 accent-sky-500 h-1" />
          <span className="font-mono text-slate-300 w-10 text-right">FL{maxFl}</span>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-slate-500 font-mono">MO</span>
          <button onClick={() => setMonthOverride('AUTO')} className={`px-1.5 py-0.5 rounded font-mono ${monthOverride === 'AUTO' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>AUTO</button>
          {[3, 5, 9, 11].map(m => (
            <button key={m} onClick={() => setMonthOverride(m)} className={`px-1.5 py-0.5 rounded font-mono ${monthOverride === m ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>{MONTH_NAMES[m-1]}</button>
          ))}
          <span className="text-slate-700 mx-1">|</span>
          <button onClick={() => setShowHalo(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showHalo ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>HALO</button>
          <button onClick={() => setShowPin(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showPin ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>PIN</button>
          <button onClick={() => setShowLbl(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showLbl ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>LBL</button>
          <button onClick={() => setShowFly(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showFly ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>FLY</button>
          <button onClick={() => setShowApt(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showApt ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>APT</button>
        </div>
      </div>

      {/* Phase chip */}
      <div className="px-3 py-1 border-b border-slate-800 flex items-center gap-1 flex-wrap text-[10px]">
        <button onClick={() => setPhaseFilter('ALL')} className={`px-1.5 py-0.5 rounded font-mono ${phaseFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>ALL-PH</button>
        {(['CLB-INI', 'CLB', 'DSC', 'APP-INT', 'APP-FNL'] as Phase[]).map(p => (
          <button key={p} onClick={() => setPhaseFilter(p)} className={`px-1.5 py-0.5 rounded font-mono ${phaseFilter === p ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>{p}</button>
        ))}
      </div>

      <div className="px-3 py-1 border-b border-slate-800 flex items-center gap-1 flex-wrap text-[10px]">
        <button onClick={() => setFlywayFilter('ALL')} className={`px-1.5 py-0.5 rounded font-mono ${flywayFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>ALL-FLY</button>
        {FLYWAYS.slice(0, 8).map(fl => (
          <button key={fl.id} onClick={() => setFlywayFilter(fl.id)} className={`px-1.5 py-0.5 rounded font-mono ${flywayFilter === fl.id ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>{fl.id}</button>
        ))}
      </div>

      <div className="px-3 py-1 border-b border-slate-800 flex items-center gap-1 flex-wrap text-[10px]">
        <button onClick={() => setEngFilter('ALL')} className={`px-1.5 py-0.5 rounded font-mono ${engFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>ALL-ENG</button>
        {ENG_CLASSES.map(ec => (
          <button key={ec.id} onClick={() => setEngFilter(ec.id)} className={`px-1.5 py-0.5 rounded font-mono ${engFilter === ec.id ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>{ec.id}</button>
        ))}
      </div>

      <div className="px-3 py-1 border-b border-slate-800">
        <input type="text" placeholder="search callsign / type / operator / flyway / engine / airport" value={query} onChange={e => setQuery(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/60" />
      </div>

      {/* Tabs */}
      <div className="px-3 py-1.5 border-b border-slate-800 flex items-center gap-1 text-[10px]">
        {(['AIRCRAFT', 'FLYWAYS', 'ENGINES', 'METHOD'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-0.5 rounded font-mono ${tab === t ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
        {tab === 'AIRCRAFT' && visible.slice(0, 100).map((r, i) => (
          <div key={i} onClick={() => onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5 transition-colors">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{r.f.callsign || r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-300">{r.f.type}</span>
              <span className="px-1 rounded font-mono text-[9px]" style={{ background: TIER_COLOR[r.tier] + '22', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.engClass.id}</span>
              <span className="ml-auto font-mono text-slate-300">›</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px]">
              <div>AGL <span className="font-mono text-slate-100">{r.agl < 10000 ? r.agl.toFixed(0)+'ft' : (r.agl/1000).toFixed(1)+'k'}</span></div>
              <div>FLY <span className="font-mono" style={{ color: r.flywayActive ? TIER_COLOR['HIGH-DMG'] : '#cbd5e1' }}>{r.flyway?.id || '—'}{r.flywayActive ? '★' : ''}</span></div>
              <div>BIRD <span className="font-mono" style={{ color: r.birdSpecies === 'XL' || r.birdSpecies === 'LARGE' ? TIER_COLOR['HIGH-DMG'] : '#cbd5e1' }}>{r.birdSpecies} {r.birdMass.toFixed(2)}kg</span></div>
              <div>CERT <span className="font-mono" style={{ color: r.certMargin < 0.85 ? TIER_COLOR['CRIT-DMG'] : r.certMargin < 1.0 ? TIER_COLOR['DAMAGE'] : '#10b981' }}>×{r.certMargin.toFixed(2)}</span></div>
              <div>APT <span className="font-mono text-slate-100">{r.airport?.iata || '—'}</span></div>
              <div>WHMP <span className="font-mono text-slate-100">{r.airport ? (r.airport.whmp*100).toFixed(0)+'%' : '—'}</span></div>
              <div>FL <span className="font-mono text-slate-100">{Math.round(r.f.altitudeFt / 100)}</span></div>
              <div>DIEL <span className="font-mono" style={{ color: r.diel >= 0.9 ? TIER_COLOR['DAMAGE'] : '#cbd5e1' }}>{(r.diel*100).toFixed(0)}</span></div>
            </div>
            <div className="mt-1 h-1 bg-slate-900 rounded overflow-hidden"><div className="h-full" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }} /></div>
            <div className="flex items-center gap-1 mt-0.5 flex-wrap">
              {(['PHASE', 'AGL', 'FLYWAY', 'SEASON', 'DIEL', 'AIRPORT', 'MASS', 'CERT'] as Driver[]).map(d => (
                <span key={d} className="text-[9px] font-mono px-1 rounded" style={{ background: r.sev[d] >= 70 ? TIER_COLOR['HIGH-DMG'] + '22' : r.sev[d] >= 40 ? TIER_COLOR['DAMAGE'] + '22' : '#1e293b66', color: r.sev[d] >= 70 ? TIER_COLOR['HIGH-DMG'] : r.sev[d] >= 40 ? TIER_COLOR['DAMAGE'] : '#94a3b8' }}>{d.slice(0, 3)} {r.sev[d].toFixed(0)}</span>
              ))}
            </div>
            <div className="text-[9px] mt-0.5 italic" style={{ color: TIER_COLOR[r.tier] }}>{advice(r)}</div>
          </div>
        ))}

        {tab === 'FLYWAYS' && flyStats.map((s, i) => (
          <div key={i} onClick={() => setFlywayFilter(s.f.id)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{s.f.id}</span>
              <span className="text-slate-400">{s.f.name}</span>
              <span className="px-1 rounded font-mono text-[9px]" style={{ background: (s.f.peakMonths.includes(0) || s.f.peakMonths.includes(nowMonth)) ? '#f43f5e22' : '#47556922', color: (s.f.peakMonths.includes(0) || s.f.peakMonths.includes(nowMonth)) ? '#f43f5e' : '#94a3b8' }}>{(s.f.peakMonths.includes(0) || s.f.peakMonths.includes(nowMonth)) ? 'MIG★' : 'OFF-MIG'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{s.f.dominantMass}</span>
            </div>
            <div className="grid grid-cols-5 gap-1 mt-1 text-[10px]">
              <div>TRFC <span className="font-mono text-slate-100">{s.count}</span></div>
              <div>HI <span className="font-mono" style={{ color: s.crit ? TIER_COLOR['HIGH-DMG'] : '#cbd5e1' }}>{s.crit}</span></div>
              <div>DMG <span className="font-mono" style={{ color: s.damage ? TIER_COLOR['DAMAGE'] : '#cbd5e1' }}>{s.damage}</span></div>
              <div>μ-SCR <span className="font-mono text-slate-100">{s.muScore.toFixed(0)}</span></div>
              <div>PK <span className="font-mono text-slate-100">{(s.f.peak*100).toFixed(0)}%</span></div>
            </div>
            <div className="text-[9px] mt-0.5 text-slate-500">peak months: <span className="font-mono text-slate-300">{s.f.peakMonths.includes(0) ? 'year-round' : s.f.peakMonths.map(m => MONTH_NAMES[m-1]).join(',')}</span></div>
            <div className="text-[9px] mt-0.5 text-slate-500 italic">cite: {s.f.cite}</div>
          </div>
        ))}

        {tab === 'ENGINES' && engStats.map((s, i) => (
          <div key={i} onClick={() => setEngFilter(s.ec.id)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{s.ec.id}</span>
              <span className="text-slate-400">{s.ec.label}</span>
            </div>
            <div className="grid grid-cols-6 gap-1 mt-1 text-[10px]">
              <div>FLEET <span className="font-mono text-slate-100">{s.count}</span></div>
              <div>CRIT <span className="font-mono" style={{ color: s.crit ? TIER_COLOR['HIGH-DMG'] : '#cbd5e1' }}>{s.crit}</span></div>
              <div>μ-MARG <span className="font-mono" style={{ color: s.muMargin < 0.85 ? TIER_COLOR['HIGH-DMG'] : s.muMargin < 1.2 ? TIER_COLOR['DAMAGE'] : '#10b981' }}>×{s.muMargin.toFixed(2)}</span></div>
              <div>MED <span className="font-mono text-slate-100">{s.ec.medCert.toFixed(2)}kg</span></div>
              <div>LRG <span className="font-mono text-slate-100">{s.ec.lrgCert.toFixed(2)}kg</span></div>
              <div>CONT <span className="font-mono text-slate-100">{(s.ec.containment*100).toFixed(0)}%</span></div>
            </div>
            <div className="mt-1 h-1 bg-slate-900 rounded overflow-hidden">
              <div className="h-full" style={{ width: `${s.muScore}%`, background: s.muScore >= 65 ? TIER_COLOR['HIGH-DMG'] : s.muScore >= 40 ? TIER_COLOR['DAMAGE'] : '#10b981' }} />
            </div>
            <div className="text-[9px] mt-0.5 text-slate-500">exemplars: <span className="font-mono text-slate-300">{s.ec.exemplars}</span></div>
            <div className="text-[9px] mt-0.5 text-slate-500 italic">{s.ec.cite}</div>
          </div>
        ))}

        {tab === 'METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-300 leading-relaxed">
            <div>
              <div className="text-sky-300 font-mono mb-1">REGULATORY REGIME</div>
              <div className="text-slate-400">
                Per 14 CFR §33.76 / EASA CS-E 800, turbofan/turbojet engines are certificated against a single-large-bird (1.85, 2.50 or 3.65 kg by inlet-area class) and medium-flock (0.45-1.15 kg) ingestion at 200 kts climb. §33.77 governs small-flock fan-blade containment. §25.571 covers radome / windshield bird-impact. Airports operate Wildlife Hazard Management Plans per FAA AC 150/5200-32B and Part 139.337, with attractant mitigation per AC 150/5200-33C. ICAO equivalents: Annex 14 Vol I §9.4 / Doc 9137 Pt III.
              </div>
            </div>
            <div>
              <div className="text-sky-300 font-mono mb-1">SCORING MODEL</div>
              <div className="text-slate-400">
                8 drivers — PHASE (climb/approach weight, peak CLB-INI 1.45), AGL (peak &lt;1500ft per FAA NWSD, 92% strikes &lt;3000ft AGL), FLYWAY (corridor placement), SEASON (Mar-May / Aug-Nov migration), DIEL (dawn/dusk raptor + waterfowl activity), AIRPORT (FAA Strike DB rate × WHMP maturity), MASS (bird species mass distribution per flyway), CERT (§33.76 cert-mass / actual ratio). Composite max·0.62 + mean·0.38 × phase-weight × ADV.
              </div>
            </div>
            <div>
              <div className="text-sky-300 font-mono mb-1">HARD ESCALATORS</div>
              <div className="text-slate-400">
                • Cert margin &lt;0.55 + CLB-INI/APP-FNL → 92 (§33.76 envelope breach in low-AGL phase)<br />
                • KJFK/KLGA/EHAM rate≥0.90 + MIG-active + CLB → 85 (Hudson-mode)<br />
                • XL goose-class (≥2.5 kg) + CLB-INI → 78 (post-rotation dual-ingest)<br />
                • Containment &lt;70% + LARGE-bird → composite uplift (PW127 / V2500 legacy)
              </div>
            </div>
            <div>
              <div className="text-sky-300 font-mono mb-1">DATA SOURCES</div>
              <div className="text-slate-400">
                FAA Wildlife Strike Database 2024 Report (273,769 strikes 1990-2023, $957M annual loss) · USFWS Atlantic/Mississippi/Central/Pacific Flyway Councils · USDA Wildlife Services WHMP biologist deployments · ICAO IBIS bird-strike reporting · EASA Wildlife Hazard Mgmt EU Reg.139/2014 · CFM/RR/PW/GE/IAE engine type certificate ingestion deltas · AC 33.76-1 §6 medium/large bird test guide · TSO-C151 stick-pusher (parallel cert family).
              </div>
            </div>
            <div>
              <div className="text-sky-300 font-mono mb-1">PRECEDENT ACCIDENT FAMILY</div>
              <div className="text-slate-400">
                • US 1549 KLGA Hudson 2009-01-15 NTSB AAR-10-03 dual-CFM56-5B4/P stall after Canada Goose (≈3.6 kg) ingestion at 2818 ft AGL — the canonical §33.76 large-bird breach precedent. Cert envelope at the time was 1.85 kg single large bird.<br />
                • Ryanair FR4102 LIRA Ciampino 2008-11-10 starling flock during final, dual CFM56 power-loss, hard landing.<br />
                • Eastern 375 KBOS Logan 1960-10-04 Lockheed Electra L188, starling-flock ingestion through all four PT6-class T56 engines on T/O — the seminal cert driver for §33.77.<br />
                • Bek Air SCAT 760 Q400 2019-12-27 reported bird ingestion during T/O roll, overran. Q400 PW150 in PW127 class.<br />
                • Concorde F-WTSS DGAC 1976 flock during cert test, single-engine surge — cert-driver for §33.76 amdt-23.
              </div>
            </div>
            <div>
              <div className="text-sky-300 font-mono mb-1">DISTINCT FROM</div>
              <div className="text-slate-400">
                HAIL (frozen-precip ice impact, separate §33.78 cert family), FOD (loose-debris runway sweep regime), CAST (top-accident category taxonomy), VOLCANIC-ASH (silicate erosion, distinct ingestion mechanism), NVPM (engine emissions), DEEPSTL (post-stall pitch authority), MELT (gross-weight inversion). BIRDX uniquely scores ICAO Annex 14 §9.4 wildlife-strike risk fused with §33.76 cert-envelope margin per airframe-engine-phase-flyway tuple.
              </div>
            </div>
            <div>
              <div className="text-sky-300 font-mono mb-1">REFERENCES</div>
              <div className="text-slate-400">
                14 CFR §33.76 §33.77 §25.571 §25.775 §139.337 · EASA CS-E 800 CS-25 App.D · AC 33.76-1 · AC 150/5200-32B AC 150/5200-33C · AC 91-44 §3 landing-lights · FAA Wildlife Strike Database 2024 Report (Dolbeer/Begier/Wright/Schreckengost/Pfeiffer) · ICAO Annex 14 Vol I §9.4 · Doc 9137 Pt III · IBIS Bird-Strike Info Sys · NTSB AAR-10-03 US 1549 · NTSB AAR-13-01 Bek Air Q400 · AAIB FR4102 LIRA Ciampino 2008 · CFM Type Cert E26NE/E00088EN · GE Type Cert E00078EN/E00094EN · PW Type Cert E00087EN · RR EASA E.111 · USFWS NAWMP 2018 · Wetlands Intl Boere 2007 Waterbird Pop · AEWA / EAAFP Partnership 2024.
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-700/60 text-[9px] text-slate-500 font-mono">
        {visible.length}/{rows.length} visible · {AIRPORTS_H.length} apt-hazard catalogued · month {MONTH_NAMES[nowMonth-1]} · 12 flyways · 8 §33.76 eng-classes
      </div>
    </div>
  )
}
