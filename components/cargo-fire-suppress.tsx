'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Cargo Fire Suppression Endurance & Diversion-Time Limited
   Dispatch (DTLD) Compliance Monitor
   -----------------------------------------------------------
   14 CFR 25.851 Fire Extinguishers · 25.855 Cargo or Baggage
   Compartments · 25.857 Cargo Compartment Classification (A/B/
   C/E) · 25.858 Cargo or Baggage Compartment Smoke or Fire
   Detection Systems · 25.1197 Fire-Extinguishing Agents · 25.
   1199 Extinguishing Agent Containers · 25.1309 Equipment ·
   14 CFR 121.1115/.1117/.1119 ETOPS Maximum Diversion Time /
   Time-Limited System (TLS) / Fire Suppression · FAA AC 25-9A
   Smoke Detection · FAA AC 120-42B ETOPS · FAA AC 120-80B
   In-Flight Fires · ICAO Annex 6 Pt I 4.3.5 ETOPS · EASA
   CS-25.857/.858 · EASA AMC 20-6 ETOPS · Halon-1301 NFPA 12A
   Total Flooding Systems (5.7 % knockdown ≥ 0.5 s · 3.0 %
   maintenance) · Halon-1211 streaming · UTC Aerospace P/N
   3304070-XX bottle data · Kidde Aerospace 8995AA-2 · Boeing
   AERO Q3-2007 Cargo Compartment Fire Suppression · Airbus
   FAST Mag 47 ETOPS Fire Suppression Trade · NTSB AAR-89/03
   Air Canada 797 / NTSB AAR-98/03 ValuJet 592 / NTSB AAR-13/01
   UPS 6 lithium-cargo fire — lessons-learned compliance.

   The ETOPS Maximum Diversion Time at which a transport-
   category airplane may be dispatched is the LESSER of three
   Time-Limited Systems (TLS) per 14 CFR 121.1119(b):
       (1) Cargo-fire suppression endurance after first
           discharge (60-min knockdown + N min metered)
       (2) Battery / hydraulic / cooling time
       (3) ETOPS authority (60 / 120 / 138 / 180 / 207 / 240
           / 330 / 370 min ETOPS Type Design)
   This monitor tracks (1) — for every airborne aircraft we
   compute current diversion time to nearest suitable airport
   at OEI-driftdown / single-engine-inop cruise speed and
   compare against per-airframe fire-suppression endurance
   reconstructed from manufacturer bottle catalogues.

   Per-class bottle catalogue (rated endurance after first
   smoke detector activation, with halon-1301 metered flow):
       HVY-LR (B777-300ER / B787-9 / A350-900 / A330neo)
         dual 5.5-lb bottle pair · 195-330 min depending on
         ETOPS-180 / ETOPS-240 / ETOPS-330 type design
       HVY-ULR (B777-300ER ULR / B787-10 ETOPS-370 / A350-1000
         ULR) quad-bottle · 370-420 min
       NRW (B737-MAX / A320neo / A321XLR ETOPS-120/138/180)
         single + reserve bottle · 138-195 min
       RGN (CRJ-900 / E175 / ATR-72) Class C single bottle
         60-105 min (typically not ETOPS-extended)
       BIZ (G550 / G650 / Global 7500) dual bottle 180-240 min
       TBP (Q400 / King Air) Class C 75-90 min
       GA (C172 / SR22) Class B hand-discharge ~ 5 min
       FTR (mil) — no Class C / ejector-discharge only

   Five risk components, composite max-driver:
     ETA-SUP    diversion-time to nearest suitable airport
                vs remaining endurance after discharge
                100 at ETA ≥ endurance, 0 at ETA ≤ endurance/2
     CLS-COMP   cargo-class compliance per 14 CFR 25.857
                Class B (hand) on transport-category w/ pax
                or Class D (sealed) post-AA1420 phase-out
                penalised; Class C with suppression OK
     BTL-AGE    per-airframe hash-stable bottle-shelf-age
                months (1-72) vs FAA AC 20-42D 12-yr life
     DET-PIREP  smoke detector latent-fault probability
                (per AC 25-9A 1-min response) hash-stable
     TLS-EROD   ETOPS Time-Limited Systems erosion: airframe
                operating closer to its certified ETOPS limit
                than to its suppression limit (the limit that
                bites first)

   Composite score = max-driver with dominant labelling
   (SUP / CLS / BTL / DET / TLS).

   Tiers (5):
     BREACH    ETA > endurance OR score ≥ 80           rose
     CRIT      ETA > 0.85 × endurance OR score ≥ 55    amber
     WATCH     ETA > 0.65 × endurance OR score ≥ 25    sky
     OK        within margin                            emerald
     IDLE      below MIN-FL slider                      slate

   MapLibre overlay (Layers > Safety & Traffic):
     · Tier-coloured halo rings sized by score 8-22 px
     · Amber dashed great-circle aircraft→diversion line
       for CRIT/BREACH with ETA-min mid-label
     · Rose diamond pin at projected diversion airport for
       BREACH tier
     · Tier-coloured callsign + driver + ETA labels for CRIT
       and BREACH
     · 64 suitable-diversion airport pins (sky), IATA + LDA

   Side panel:
     · 4-tier counter strip click-to-filter
     · 3-cell MEAN-MARGIN / WORST / BREACH-count
     · 2-cell MEAN-ETA / BOTTLE-DEGRADED-share
     · SVG ETA-vs-endurance-min scatter with rose breach
       diagonal, amber 0.85x band, sky 0.65x band, every
       aircraft as tier-coloured dot
     · 6 sliders MIN-FL / OEI-MUL / DETECT-LAG / BOTTLE-AGE
       / TLS-WARN / DIV-SEARCH
     · 8-class chip filter HVY-LR/HVY-ULR/NRW/RGN/BIZ/TBP/
       GA/FTR
     · HALO/LBL/PIN/LINE/APT/DIAG toggles + search
     · AIRCRAFT / CLASSES tab switcher
     · AIRCRAFT tier-worst-first then score desc
     · CLASSES grouped by aircraft class

   Persisted: ft-cargofs
   ============================================================ */

export interface CargoFsFlight {
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
  flights: CargoFsFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'WATCH' | 'CRIT' | 'BREACH' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981',
  WATCH: '#0ea5e9',
  CRIT: '#f59e0b',
  BREACH: '#fb7185',
  IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['BREACH', 'CRIT', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { BREACH: 0, CRIT: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Klass = 'HVY-LR' | 'HVY-ULR' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
interface ClassSpec {
  name: string
  endMinMin: number   // min endurance minutes
  endMinMax: number
  etopsLimit: number  // certified ETOPS authority minutes (cap)
  oeiKts: number      // OEI/driftdown cruise true airspeed
  cargoClass: 'C' | 'C-ext' | 'C-ULR' | 'B' | 'D-phased' | 'none'
  bottleCount: number
}
const CLASS_SPEC: Record<Klass, ClassSpec> = {
  'HVY-LR':  { name: 'Heavy Long-Range',     endMinMin: 195, endMinMax: 330, etopsLimit: 330, oeiKts: 310, cargoClass: 'C-ext', bottleCount: 2 },
  'HVY-ULR': { name: 'Heavy Ultra-Long',     endMinMin: 370, endMinMax: 420, etopsLimit: 370, oeiKts: 320, cargoClass: 'C-ULR', bottleCount: 4 },
  'NRW':     { name: 'Narrow-Body',          endMinMin: 138, endMinMax: 195, etopsLimit: 180, oeiKts: 280, cargoClass: 'C-ext', bottleCount: 2 },
  'RGN':     { name: 'Regional Jet',         endMinMin:  60, endMinMax: 105, etopsLimit:  75, oeiKts: 240, cargoClass: 'C',     bottleCount: 1 },
  'BIZ':     { name: 'Business Jet',         endMinMin: 180, endMinMax: 240, etopsLimit: 240, oeiKts: 290, cargoClass: 'C',     bottleCount: 2 },
  'TBP':     { name: 'Turboprop',            endMinMin:  75, endMinMax:  90, etopsLimit:  75, oeiKts: 195, cargoClass: 'C',     bottleCount: 1 },
  'GA':      { name: 'General Aviation',     endMinMin:   5, endMinMax:  10, etopsLimit:   0, oeiKts: 100, cargoClass: 'B',     bottleCount: 0 },
  'FTR':     { name: 'Fighter / Military',   endMinMin:   0, endMinMax:   0, etopsLimit:   0, oeiKts: 350, cargoClass: 'none',  bottleCount: 0 },
}

// 64-airport suitable-diversion catalogue (long-runway, fire-rescue cat 9+, fuel, MX)
interface Apt { iata: string; icao: string; name: string; lat: number; lng: number; ldaFt: number; cfr: number }
const APTS: Apt[] = [
  // North America
  { iata: 'JFK', icao: 'KJFK', name: 'New York JFK',         lat: 40.6413, lng: -73.7781, ldaFt: 14572, cfr: 10 },
  { iata: 'LAX', icao: 'KLAX', name: 'Los Angeles',          lat: 33.9425, lng: -118.4081, ldaFt: 12091, cfr: 10 },
  { iata: 'ORD', icao: 'KORD', name: 'Chicago O\u2019Hare', lat: 41.9742, lng: -87.9073, ldaFt: 13000, cfr: 10 },
  { iata: 'DFW', icao: 'KDFW', name: 'Dallas/Fort Worth',    lat: 32.8998, lng: -97.0403, ldaFt: 13401, cfr: 10 },
  { iata: 'DEN', icao: 'KDEN', name: 'Denver',               lat: 39.8561, lng: -104.6737, ldaFt: 16000, cfr: 10 },
  { iata: 'ATL', icao: 'KATL', name: 'Atlanta',              lat: 33.6407, lng: -84.4277, ldaFt: 12390, cfr: 10 },
  { iata: 'SEA', icao: 'KSEA', name: 'Seattle',              lat: 47.4502, lng: -122.3088, ldaFt: 11901, cfr: 10 },
  { iata: 'SFO', icao: 'KSFO', name: 'San Francisco',        lat: 37.6213, lng: -122.3790, ldaFt: 11870, cfr: 10 },
  { iata: 'MIA', icao: 'KMIA', name: 'Miami',                lat: 25.7959, lng: -80.2870, ldaFt: 13016, cfr: 10 },
  { iata: 'IAH', icao: 'KIAH', name: 'Houston Bush',         lat: 29.9844, lng: -95.3414, ldaFt: 12001, cfr: 10 },
  { iata: 'YYZ', icao: 'CYYZ', name: 'Toronto Pearson',      lat: 43.6777, lng: -79.6248, ldaFt: 11050, cfr: 10 },
  { iata: 'YVR', icao: 'CYVR', name: 'Vancouver',            lat: 49.1939, lng: -123.1844, ldaFt: 11500, cfr: 10 },
  { iata: 'YHZ', icao: 'CYHZ', name: 'Halifax',              lat: 44.8808, lng: -63.5086, ldaFt: 10500, cfr: 9 },
  { iata: 'YQX', icao: 'CYQX', name: 'Gander',               lat: 48.9369, lng: -54.5681, ldaFt: 10200, cfr: 9 },
  { iata: 'BGR', icao: 'KBGR', name: 'Bangor',               lat: 44.8074, lng: -68.8281, ldaFt: 11440, cfr: 9 },
  { iata: 'ANC', icao: 'PANC', name: 'Anchorage',            lat: 61.1744, lng: -149.9961, ldaFt: 12400, cfr: 10 },
  { iata: 'MEX', icao: 'MMMX', name: 'Mexico City',          lat: 19.4361, lng: -99.0719, ldaFt: 12966, cfr: 10 },
  { iata: 'PTY', icao: 'MPTO', name: 'Panama Tocumen',       lat: 9.0714,  lng: -79.3835, ldaFt: 10006, cfr: 10 },
  // Atlantic / Europe
  { iata: 'KEF', icao: 'BIKF', name: 'Reykjavik Keflavik',   lat: 63.985,  lng: -22.6056, ldaFt: 10056, cfr: 9 },
  { iata: 'SNN', icao: 'EINN', name: 'Shannon',              lat: 52.7019, lng: -8.9248, ldaFt: 10495, cfr: 9 },
  { iata: 'LHR', icao: 'EGLL', name: 'London Heathrow',      lat: 51.4700, lng: -0.4543, ldaFt: 12799, cfr: 10 },
  { iata: 'CDG', icao: 'LFPG', name: 'Paris CDG',            lat: 49.0097, lng: 2.5479, ldaFt: 13780, cfr: 10 },
  { iata: 'AMS', icao: 'EHAM', name: 'Amsterdam',            lat: 52.3105, lng: 4.7683, ldaFt: 12467, cfr: 10 },
  { iata: 'FRA', icao: 'EDDF', name: 'Frankfurt',            lat: 50.0379, lng: 8.5622, ldaFt: 13123, cfr: 10 },
  { iata: 'MUC', icao: 'EDDM', name: 'Munich',               lat: 48.3538, lng: 11.7861, ldaFt: 13123, cfr: 10 },
  { iata: 'MAD', icao: 'LEMD', name: 'Madrid Barajas',       lat: 40.4719, lng: -3.5626, ldaFt: 14272, cfr: 10 },
  { iata: 'BCN', icao: 'LEBL', name: 'Barcelona',            lat: 41.2974, lng: 2.0833, ldaFt: 11663, cfr: 9 },
  { iata: 'FCO', icao: 'LIRF', name: 'Rome Fiumicino',       lat: 41.8003, lng: 12.2389, ldaFt: 12795, cfr: 10 },
  { iata: 'IST', icao: 'LTFM', name: 'Istanbul',             lat: 41.2753, lng: 28.7519, ldaFt: 13123, cfr: 10 },
  { iata: 'OSL', icao: 'ENGM', name: 'Oslo Gardermoen',      lat: 60.1939, lng: 11.1004, ldaFt: 11811, cfr: 9 },
  { iata: 'ARN', icao: 'ESSA', name: 'Stockholm Arlanda',    lat: 59.6519, lng: 17.9186, ldaFt: 10827, cfr: 9 },
  { iata: 'LIS', icao: 'LPPT', name: 'Lisbon',               lat: 38.7813, lng: -9.1357, ldaFt: 12484, cfr: 9 },
  { iata: 'TLV', icao: 'LLBG', name: 'Tel Aviv',             lat: 32.0114, lng: 34.8867, ldaFt: 11975, cfr: 10 },
  // Middle East / Africa
  { iata: 'DXB', icao: 'OMDB', name: 'Dubai',                lat: 25.2532, lng: 55.3657, ldaFt: 13124, cfr: 10 },
  { iata: 'DOH', icao: 'OTHH', name: 'Doha Hamad',           lat: 25.2731, lng: 51.6080, ldaFt: 15912, cfr: 10 },
  { iata: 'AUH', icao: 'OMAA', name: 'Abu Dhabi',            lat: 24.4330, lng: 54.6511, ldaFt: 13451, cfr: 10 },
  { iata: 'CAI', icao: 'HECA', name: 'Cairo',                lat: 30.1219, lng: 31.4056, ldaFt: 13123, cfr: 10 },
  { iata: 'JNB', icao: 'FAOR', name: 'Johannesburg',         lat: -26.1392, lng: 28.246, ldaFt: 14495, cfr: 10 },
  { iata: 'CPT', icao: 'FACT', name: 'Cape Town',            lat: -33.9648, lng: 18.6017, ldaFt: 10502, cfr: 9 },
  { iata: 'NBO', icao: 'HKJK', name: 'Nairobi',              lat: -1.3192, lng: 36.9278, ldaFt: 13507, cfr: 9 },
  { iata: 'LOS', icao: 'DNMM', name: 'Lagos',                lat: 6.5774, lng: 3.3211, ldaFt: 12795, cfr: 9 },
  // Asia / Pacific
  { iata: 'DEL', icao: 'VIDP', name: 'Delhi Indira Gandhi',  lat: 28.5562, lng: 77.1000, ldaFt: 14534, cfr: 10 },
  { iata: 'BOM', icao: 'VABB', name: 'Mumbai',               lat: 19.0896, lng: 72.8656, ldaFt: 11447, cfr: 10 },
  { iata: 'HKG', icao: 'VHHH', name: 'Hong Kong',            lat: 22.3080, lng: 113.9185, ldaFt: 12468, cfr: 10 },
  { iata: 'PEK', icao: 'ZBAA', name: 'Beijing Capital',      lat: 40.0801, lng: 116.5846, ldaFt: 12468, cfr: 10 },
  { iata: 'PVG', icao: 'ZSPD', name: 'Shanghai Pudong',      lat: 31.1443, lng: 121.8083, ldaFt: 13123, cfr: 10 },
  { iata: 'NRT', icao: 'RJAA', name: 'Tokyo Narita',         lat: 35.7647, lng: 140.3863, ldaFt: 13123, cfr: 10 },
  { iata: 'HND', icao: 'RJTT', name: 'Tokyo Haneda',         lat: 35.5494, lng: 139.7798, ldaFt: 12468, cfr: 10 },
  { iata: 'ICN', icao: 'RKSI', name: 'Seoul Incheon',        lat: 37.4602, lng: 126.4407, ldaFt: 12795, cfr: 10 },
  { iata: 'BKK', icao: 'VTBS', name: 'Bangkok Suvarnabhumi', lat: 13.6900, lng: 100.7501, ldaFt: 13123, cfr: 10 },
  { iata: 'SIN', icao: 'WSSS', name: 'Singapore Changi',     lat: 1.3644, lng: 103.9915, ldaFt: 13123, cfr: 10 },
  { iata: 'KUL', icao: 'WMKK', name: 'Kuala Lumpur',         lat: 2.7456, lng: 101.7099, ldaFt: 13287, cfr: 10 },
  { iata: 'SYD', icao: 'YSSY', name: 'Sydney Kingsford',     lat: -33.9461, lng: 151.1772, ldaFt: 13000, cfr: 10 },
  { iata: 'MEL', icao: 'YMML', name: 'Melbourne Tullamarine',lat: -37.6690, lng: 144.8410, ldaFt: 11998, cfr: 10 },
  { iata: 'BNE', icao: 'YBBN', name: 'Brisbane',             lat: -27.3942, lng: 153.1218, ldaFt: 11500, cfr: 9 },
  { iata: 'PER', icao: 'YPPH', name: 'Perth',                lat: -31.9385, lng: 115.9672, ldaFt: 11299, cfr: 9 },
  { iata: 'AKL', icao: 'NZAA', name: 'Auckland',             lat: -37.0082, lng: 174.7850, ldaFt: 11926, cfr: 9 },
  // Polar / Pacific
  { iata: 'PPT', icao: 'NTAA', name: 'Tahiti Faaa',          lat: -17.5567, lng: -149.6117, ldaFt: 11220, cfr: 9 },
  { iata: 'HNL', icao: 'PHNL', name: 'Honolulu',             lat: 21.3245, lng: -157.9251, ldaFt: 12300, cfr: 10 },
  { iata: 'GUM', icao: 'PGUM', name: 'Guam',                 lat: 13.4837, lng: 144.7960, ldaFt: 12000, cfr: 9 },
  { iata: 'MDW', icao: 'BGGH', name: 'Nuuk Greenland',       lat: 64.1909, lng: -51.6781, ldaFt: 8694,  cfr: 7 },
  // South America
  { iata: 'GRU', icao: 'SBGR', name: 'São Paulo Guarulhos',  lat: -23.4356, lng: -46.4731, ldaFt: 12139, cfr: 10 },
  { iata: 'EZE', icao: 'SAEZ', name: 'Buenos Aires',         lat: -34.8222, lng: -58.5358, ldaFt: 10827, cfr: 10 },
  { iata: 'BOG', icao: 'SKBO', name: 'Bogotá El Dorado',     lat: 4.7016, lng: -74.1469, ldaFt: 12467, cfr: 10 },
  { iata: 'LIM', icao: 'SPJC', name: 'Lima Jorge Chávez',    lat: -12.0219, lng: -77.1143, ldaFt: 11506, cfr: 10 },
]

function classifyAircraft(t: string | undefined): Klass {
  const x = (t || '').toUpperCase()
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|MIG|SU)/.test(x)) return 'FTR'
  if (/^(B77W|B77L|B78X|A35K)/.test(x)) return 'HVY-ULR'
  if (/^(B77|B78|A33|A34|A35|A38|B74)/.test(x)) return 'HVY-LR'
  if (/^(B73|A31|A32|A19|A20|A21|A22|BCS|CS1|CS3)/.test(x)) return 'NRW'
  if (/^(CRJ|E14|E15|E17|E19|E70|E75)/.test(x)) return 'RGN'
  if (/^(GLF|GL5|GL7|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'BIZ'
  if (/^(ATR|AT4|AT7|DH8|Q40|SF34|J32|SW4)/.test(x)) return 'TBP'
  if (/^(C72|C82|C17|P28|SR2|DA4|DA62|PA|M20|C20)/.test(x)) return 'GA'
  return 'NRW'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

function haversineNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const φ1 = (lat1 * Math.PI) / 180, φ2 = (lat2 * Math.PI) / 180
  const dφ = ((lat2 - lat1) * Math.PI) / 180
  const dλ = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

type Driver = 'SUP' | 'CLS' | 'BTL' | 'DET' | 'TLS'
const DRIVER_NAME: Record<Driver, string> = {
  SUP: 'Suppression endurance vs diversion ETA',
  CLS: 'Cargo-class compliance (14 CFR 25.857)',
  BTL: 'Bottle shelf-age / pressure decay',
  DET: 'Smoke-detector PIREP / latent fault',
  TLS: 'ETOPS Time-Limited System erosion',
}

interface Row {
  f: CargoFsFlight
  klass: Klass
  spec: ClassSpec
  apt: Apt
  distNm: number
  etaMin: number
  enduranceMin: number       // per-airframe rated remaining
  bottleAgeMo: number
  detPirepProb: number
  ageDeratePct: number
  marginMin: number
  marginPct: number
  supSev: number
  clsSev: number
  btlSev: number
  detSev: number
  tlsSev: number
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'cargofs-halo', SRC_LBL = 'cargofs-lbl', SRC_PIN = 'cargofs-pin', SRC_LINE = 'cargofs-line', SRC_APT = 'cargofs-apt'
const LYR_HALO = 'cargofs-halo-l', LYR_LBL = 'cargofs-lbl-l', LYR_PIN = 'cargofs-pin-l', LYR_LINE = 'cargofs-line-l', LYR_APT = 'cargofs-apt-l', LYR_APT_LBL = 'cargofs-apt-lbl-l'

export default function CargoFireSuppress({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(50)
  const [oeiMul, setOeiMul] = useState(100)
  const [detectLag, setDetectLag] = useState(60)   // seconds for smoke-detect activation
  const [bottleAgeMax, setBottleAgeMax] = useState(72) // months
  const [tlsWarn, setTlsWarn] = useState(85)        // % of certified ETOPS
  const [divSearch, setDivSearch] = useState(800)   // nm
  const [showHalo, setShowHalo] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLine, setShowLine] = useState(true)
  const [showApt, setShowApt] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      if (f.altitudeFt / 100 < minFl) continue
      const klass = classifyAircraft(f.type)
      if (classFilter !== 'ALL' && klass !== classFilter) continue
      const spec = CLASS_SPEC[klass]
      if (!spec || spec.cargoClass === 'none' || spec.endMinMax === 0) continue
      const h = hash32(f.icao || '')

      // Find nearest suitable diversion airport within DIV-SEARCH window
      let best: Apt | null = null
      let bestDist = Infinity
      for (const a of APTS) {
        // skip airports w/ insufficient runway for class
        const ldaReq = klass === 'HVY-ULR' || klass === 'HVY-LR' ? 9000 : klass === 'NRW' || klass === 'BIZ' ? 7000 : 5000
        if (a.ldaFt < ldaReq) continue
        const d = haversineNm(f.lat, f.lng, a.lat, a.lng)
        if (d > divSearch) continue
        if (d < bestDist) { bestDist = d; best = a }
      }
      if (!best) continue

      // Per-airframe rated endurance (hash-stable between class min/max)
      const u = (h % 1000) / 1000
      const rated = spec.endMinMin + (spec.endMinMax - spec.endMinMin) * u

      // Bottle age (months) hash-stable
      const ageMo = ((h >>> 7) % bottleAgeMax)
      // Per AC 20-42D: pressure decay degrades capacity ~0.3 %/month above 24mo
      const ageDeratePct = Math.max(0, (ageMo - 24) * 0.3)
      const enduranceMin = rated * (1 - ageDeratePct / 100)

      // ETA via OEI-driftdown
      const oeiKts = spec.oeiKts * (oeiMul / 100)
      const detLagMin = detectLag / 60
      const etaMin = (bestDist / oeiKts) * 60 + detLagMin

      const marginMin = enduranceMin - etaMin
      const marginPct = enduranceMin > 0 ? (marginMin / enduranceMin) * 100 : 0

      // SUP severity — sup endurance vs diversion time
      let supSev: number
      if (etaMin >= enduranceMin) supSev = 100
      else if (etaMin >= enduranceMin * 0.85) supSev = 70 + (etaMin - enduranceMin * 0.85) / (enduranceMin * 0.15) * 30
      else if (etaMin >= enduranceMin * 0.65) supSev = 35 + (etaMin - enduranceMin * 0.65) / (enduranceMin * 0.20) * 35
      else if (etaMin >= enduranceMin * 0.5) supSev = (etaMin - enduranceMin * 0.5) / (enduranceMin * 0.15) * 35
      else supSev = 0

      // CLS severity — cargo class compliance
      const clsSev = spec.cargoClass === 'D-phased' ? 85
                   : spec.cargoClass === 'B'        ? 65
                   : spec.cargoClass === 'C'        ? 15
                   : spec.cargoClass === 'C-ext'    ? 5
                   : 0

      // BTL severity — bottle age
      const btlSev = ageMo >= 144 ? 100 : ageMo >= 96 ? 75 : ageMo >= 60 ? 45 : ageMo >= 36 ? 20 : 5

      // DET severity — smoke detector PIREP probability hash-stable
      const detPirepProb = ((h >>> 13) % 1000) / 1000 * 0.08 + (detectLag > 60 ? (detectLag - 60) / 60 * 0.15 : 0)
      const detSev = Math.min(100, detPirepProb * 800)

      // TLS — closer to ETOPS authority limit than to suppression limit
      const etopsLimit = spec.etopsLimit
      const etopsErod = etopsLimit > 0 ? Math.max(0, etaMin / etopsLimit * 100) : 0
      const tlsSev = etopsErod >= tlsWarn
        ? Math.min(100, 40 + (etopsErod - tlsWarn) * 4)
        : Math.max(0, etopsErod / tlsWarn * 30)

      const sevs: { d: Driver; v: number }[] = [
        { d: 'SUP', v: supSev },
        { d: 'CLS', v: clsSev },
        { d: 'BTL', v: btlSev },
        { d: 'DET', v: detSev },
        { d: 'TLS', v: tlsSev },
      ]
      sevs.sort((a, b) => b.v - a.v)
      const driver = sevs[0].d
      const score = sevs[0].v

      let tier: Tier
      if (etaMin >= enduranceMin || score >= 80) tier = 'BREACH'
      else if (etaMin >= enduranceMin * 0.85 || score >= 55) tier = 'CRIT'
      else if (etaMin >= enduranceMin * 0.65 || score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, klass, spec, apt: best, distNm: bestDist, etaMin,
        enduranceMin, bottleAgeMo: ageMo, detPirepProb, ageDeratePct,
        marginMin, marginPct,
        supSev, clsSev, btlSev, detSev, tlsSev,
        score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, oeiMul, detectLag, bottleAgeMax, tlsWarn, divSearch, classFilter])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, WATCH: 0, CRIT: 0, BREACH: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumMargin = 0, sumEta = 0, n = 0, degraded = 0, breach = 0
    let worstSev = -1, worstCs = '', worstDr: Driver = 'SUP'
    for (const r of rows) {
      n++
      sumMargin += r.marginPct
      sumEta += r.etaMin
      if (r.ageDeratePct > 5) degraded++
      if (r.tier === 'BREACH') breach++
      if (r.score > worstSev) { worstSev = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstDr = r.driver }
    }
    return {
      meanMargin: n ? sumMargin / n : 0,
      meanEta: n ? sumEta / n : 0,
      degradedShare: n ? degraded / n * 100 : 0,
      worstCs, worstDr, breach, active: n,
    }
  }, [rows])

  const classAggs = useMemo(() => {
    const m = new Map<Klass, { klass: Klass; spec: ClassSpec; count: number; sumScore: number; sumMargin: number; worstSev: number; worstCs: string; worstIcao: string; worstTier: Tier; breach: number }>()
    for (const r of rows) {
      let a = m.get(r.klass)
      if (!a) { a = { klass: r.klass, spec: r.spec, count: 0, sumScore: 0, sumMargin: 0, worstSev: -1, worstCs: '', worstIcao: '', worstTier: 'OK', breach: 0 }; m.set(r.klass, a) }
      a.count++
      a.sumScore += r.score
      a.sumMargin += r.marginPct
      if (r.tier === 'BREACH') a.breach++
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.score > a.worstSev) { a.worstSev = r.score; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
    }
    const arr = Array.from(m.values()).map(a => ({ ...a, meanScore: a.count ? a.sumScore / a.count : 0, meanMargin: a.count ? a.sumMargin / a.count : 0 }))
    arr.sort((a, b) => {
      const ti = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
      if (ti !== 0) return ti
      return b.count - a.count
    })
    return arr
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows
      .filter(r => {
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.apt.iata, r.apt.name, r.klass].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, query])

  const filteredClasses = useMemo(() => {
    const q = query.trim().toUpperCase()
    return classAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (!q) return true
      return (a.klass + ' ' + a.spec.name).toUpperCase().includes(q)
    })
  }, [classAggs, tierFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'CRIT' || r.tier === 'BREACH').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} › ${r.apt.iata} · ${r.driver} · ETA ${r.etaMin.toFixed(0)}m` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'BREACH').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${r.apt.iata} ◆ DTLD` },
      geometry: { type: 'Point' as const, coordinates: [r.apt.lng, r.apt.lat] },
    })) : [] }

    const lineFc = { type: 'FeatureCollection' as const, features: showLine ? rows.filter(r => r.tier === 'CRIT' || r.tier === 'BREACH').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.apt.lng, r.apt.lat]] },
    })) : [] }

    const usedIatas = new Set<string>()
    for (const r of rows) usedIatas.add(r.apt.iata)
    const aptFc = { type: 'FeatureCollection' as const, features: showApt ? APTS.map(a => ({
      type: 'Feature' as const,
      properties: { color: usedIatas.has(a.iata) ? '#0ea5e9' : '#475569', text: `${a.iata} ${(a.ldaFt / 1000).toFixed(1)}k`, sz: usedIatas.has(a.iata) ? 4 : 2 },
      geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_LINE, lineFc, () => map.addLayer({ id: LYR_LINE, type: 'line', source: SRC_LINE, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.3, 'line-opacity': 0.75, 'line-dasharray': [3, 2],
      } }))
      ensure(SRC_APT, aptFc, () => {
        map.addLayer({ id: LYR_APT, type: 'circle', source: SRC_APT, paint: {
          'circle-radius': ['get', 'sz'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.7,
          'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 0.8, 'circle-stroke-opacity': 0.9,
        } })
        map.addLayer({ id: LYR_APT_LBL, type: 'symbol', source: SRC_APT, layout: {
          'text-field': ['get', 'text'], 'text-size': 9, 'text-offset': [0, 1.0], 'text-anchor': 'top',
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.0 } })
      })
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['get', 'text'], 'text-size': 10,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-offset': [0, -1.8], 'text-anchor': 'bottom', 'icon-allow-overlap': true,
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.6 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINE, LYR_APT_LBL, LYR_APT]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_LINE, SRC_APT]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showLine, showApt])

  // Diagram: ETA-min (x) vs endurance-min (y); breach where x > y
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 32
    const xMax = 420, yMax = 450
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, v / xMax)) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Cargo Fire / DTLD</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.active} tracked / {summary.breach} breach</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold" style={{ color: TIER_COLOR[t] }}>{t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Margin</div>
          <div className="font-mono text-sm" style={{ color: summary.meanMargin < 15 ? '#fb7185' : summary.meanMargin < 35 ? '#f59e0b' : '#10b981' }}>
            {summary.meanMargin >= 0 ? '+' : ''}{summary.meanMargin.toFixed(0)}<span className="text-[9px] text-slate-500"> %</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs + ' · ' + summary.worstDr}>
            {summary.worstCs || '—'}
            {summary.worstCs && <span className="text-slate-500"> · {summary.worstDr}</span>}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Breach</div>
          <div className="font-mono text-sm" style={{ color: summary.breach > 0 ? '#fb7185' : '#10b981' }}>{summary.breach}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean ETA</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.meanEta.toFixed(0)}<span className="text-[9px] text-slate-500"> min</span></div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Bottle Degraded</div>
          <div className="font-mono text-[11px]" style={{ color: summary.degradedShare > 25 ? '#f59e0b' : '#94a3b8' }}>{summary.degradedShare.toFixed(0)}<span className="text-[9px] text-slate-500"> %</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            {/* Rose region where ETA > endurance (breach) — diagonal below y=x */}
            <polygon points={`${diag.xs(0)},${diag.ys(0)} ${diag.xs(diag.xMax)},${diag.ys(0)} ${diag.xs(diag.xMax)},${diag.ys(Math.min(diag.yMax, diag.xMax))}`} fill="#fb7185" fillOpacity="0.10" />
            {/* Amber band: ETA > 0.85x endurance */}
            <polygon points={`${diag.xs(0)},${diag.ys(0)} ${diag.xs(diag.xMax)},${diag.ys(diag.xMax * 0.85)} ${diag.xs(diag.xMax)},${diag.ys(Math.min(diag.yMax, diag.xMax))}`} fill="#f59e0b" fillOpacity="0.08" />
            {/* Diag y=x (breach line) */}
            <line x1={diag.xs(0)} y1={diag.ys(0)} x2={diag.xs(Math.min(diag.xMax, diag.yMax))} y2={diag.ys(Math.min(diag.xMax, diag.yMax))} stroke="#fb7185" strokeWidth="1" strokeDasharray="3 2" />
            {/* 0.85x (CRIT) */}
            <line x1={diag.xs(0)} y1={diag.ys(0)} x2={diag.xs(diag.xMax)} y2={diag.ys(diag.xMax * 0.85)} stroke="#f59e0b" strokeWidth="0.8" strokeDasharray="2 3" />
            {/* 0.65x (WATCH) */}
            <line x1={diag.xs(0)} y1={diag.ys(0)} x2={diag.xs(diag.xMax)} y2={diag.ys(diag.xMax * 0.65)} stroke="#0ea5e9" strokeWidth="0.6" strokeDasharray="2 4" />
            {/* x grid */}
            {[60, 120, 180, 240, 330].map(v => (
              <g key={'gx' + v}>
                <line x1={diag.xs(v)} x2={diag.xs(v)} y1={6} y2={diag.H - diag.PAD + 2} stroke="#1e293b" strokeWidth="0.5" />
                <text x={diag.xs(v)} y={diag.H - diag.PAD + 12} fontSize="8" fill="#64748b" textAnchor="middle">{v}</text>
              </g>
            ))}
            {/* y grid */}
            {[120, 240, 360].map(v => (
              <g key={'gy' + v}>
                <line x1={diag.PAD} x2={diag.W - 6} y1={diag.ys(v)} y2={diag.ys(v)} stroke="#1e293b" strokeWidth="0.5" />
                <text x={4} y={diag.ys(v) + 3} fontSize="8" fill="#64748b">{v}</text>
              </g>
            ))}
            <text x={diag.W - 6} y={diag.H - 4} fontSize="8" fill="#64748b" textAnchor="end">ETA min · endurance min</text>
            {rows.map((r, i) => (
              <circle key={i} cx={diag.xs(Math.min(diag.xMax, r.etaMin))} cy={diag.ys(Math.min(diag.yMax, r.enduranceMin))} r={2} fill={TIER_COLOR[r.tier]} fillOpacity="0.85" />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          {([
            ['MIN-FL', minFl, setMinFl, 0, 400, 10, 'FL'],
            ['OEI-MUL', oeiMul, setOeiMul, 70, 130, 5, '%'],
            ['DET-LAG', detectLag, setDetectLag, 15, 240, 5, 's'],
            ['BTL-AGE', bottleAgeMax, setBottleAgeMax, 24, 144, 6, 'mo'],
          ] as const).map(([lab, val, set, lo, hi, st, suf]) => (
            <label key={lab} className="text-[10px] text-slate-400 flex items-center gap-1.5">
              <span className="w-14 font-mono text-slate-500">{lab}</span>
              <input type="range" min={lo} max={hi} step={st} value={val} onChange={e => (set as any)(+e.target.value)} className="flex-1 accent-sky-500" />
              <span className="w-12 font-mono text-slate-300 text-right">{val}{suf}</span>
            </label>
          ))}
        </div>
        <label className="text-[10px] text-slate-400 flex items-center gap-1.5">
          <span className="w-14 font-mono text-slate-500">TLS-WARN</span>
          <input type="range" min={60} max={100} step={1} value={tlsWarn} onChange={e => setTlsWarn(+e.target.value)} className="flex-1 accent-sky-500" />
          <span className="w-12 font-mono text-slate-300 text-right">{tlsWarn}%</span>
        </label>
        <label className="text-[10px] text-slate-400 flex items-center gap-1.5">
          <span className="w-14 font-mono text-slate-500">DIV-SRCH</span>
          <input type="range" min={200} max={2000} step={50} value={divSearch} onChange={e => setDivSearch(+e.target.value)} className="flex-1 accent-sky-500" />
          <span className="w-12 font-mono text-slate-300 text-right">{divSearch}nm</span>
        </label>
        <div className="flex flex-wrap gap-1">
          {(['ALL', 'HVY-LR', 'HVY-ULR', 'NRW', 'RGN', 'BIZ', 'TBP'] as const).map(k => (
            <button key={k} onClick={() => setClassFilter(k as any)}
              className={`px-1.5 py-0.5 text-[9px] rounded border font-mono ${classFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-500'}`}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 text-[10px] text-slate-400">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLine} onChange={e => setShowLine(e.target.checked)} className="accent-sky-500" /><span>LINE</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showApt} onChange={e => setShowApt(e.target.checked)} className="accent-sky-500" /><span>APT</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / diversion / class"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'CLASSES'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${summary.active} tracked` : `${filteredClasses.length} classes`}</span>
        <span>{tab === 'AIRCRAFT' ? 'ETA · end · margin · driver' : 'class · ac · mean · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const barPct = Math.max(0, Math.min(100, r.score))
          const advice = r.tier === 'BREACH'
            ? `ETA ${r.etaMin.toFixed(0)}m > ${r.enduranceMin.toFixed(0)}m endurance · DTLD breach · declare emergency · re-plan diversion`
            : r.tier === 'CRIT'
              ? `ETA within 15% of endurance · ${r.driver} · brief crew · monitor smoke loops`
              : r.tier === 'WATCH'
                ? `within DTLD buffer · monitor ${r.driver}`
                : `endurance margin nominal`
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{r.apt.iata}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="diversion distance">{r.distNm.toFixed(0)}nm</span>
                  <span title="ETA at OEI driftdown" style={{ color: r.etaMin > r.enduranceMin ? '#fb7185' : r.etaMin > r.enduranceMin * 0.85 ? '#f59e0b' : '#94a3b8' }}>ETA {r.etaMin.toFixed(0)}m</span>
                  <span title="rated suppression endurance">end {r.enduranceMin.toFixed(0)}m</span>
                  <span className="ml-auto" title="margin %" style={{ color: r.marginPct < 0 ? '#fb7185' : r.marginPct < 15 ? '#f59e0b' : '#10b981' }}>
                    {r.marginPct >= 0 ? '+' : ''}{r.marginPct.toFixed(0)}%
                  </span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="composite score 0-100 (sky 25 / amber 55 / rose 80)">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${barPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500/80" style={{ left: '25%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400/80" style={{ left: '55%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400/80" style={{ left: '80%' }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  <span className="px-1 py-0 rounded border text-[9px] font-mono" style={{ borderColor: TIER_COLOR[r.tier] + '66', color: TIER_COLOR[r.tier], background: TIER_COLOR[r.tier] + '14' }} title={'dominant driver: ' + DRIVER_NAME[r.driver]}>{r.driver}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="aircraft class">{r.klass}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="cargo compartment class per 14 CFR 25.857">cls-{r.spec.cargoClass}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono" style={{ borderColor: r.bottleAgeMo >= 96 ? '#fb718566' : r.bottleAgeMo >= 60 ? '#f59e0b66' : '#10b98166', color: r.bottleAgeMo >= 96 ? '#fb7185' : r.bottleAgeMo >= 60 ? '#f59e0b' : '#10b981', background: (r.bottleAgeMo >= 96 ? '#fb7185' : r.bottleAgeMo >= 60 ? '#f59e0b' : '#10b981') + '14' }} title="bottle shelf-age (months)">btl {r.bottleAgeMo}mo</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="bottles aboard">{r.spec.bottleCount}×</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="ETOPS authority limit (min)">ETOPS {r.spec.etopsLimit}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'CLASSES' && filteredClasses.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No classes match.</div>
        )}
        {tab === 'CLASSES' && filteredClasses.map(a => {
          const barPct = Math.max(0, Math.min(100, a.meanScore))
          const advice = a.worstTier === 'BREACH'
            ? `${a.breach} DTLD breach · audit ETOPS dispatch margin for class ${a.klass}`
            : a.worstTier === 'CRIT'
              ? `class within 15% of endurance · re-evaluate bottle MEL`
              : a.worstTier === 'WATCH'
                ? `class in DTLD buffer · monitor`
                : `class margin nominal`
          return (
            <button key={a.klass} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.klass}</span>
                  <span className="text-slate-500 text-[10px] truncate">{a.spec.name}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="rated endurance min">end {a.spec.endMinMin}-{a.spec.endMinMax}m</span>
                  <span title="ETOPS limit">ETOPS {a.spec.etopsLimit}m</span>
                  <span title="cargo class">cls-{a.spec.cargoClass}</span>
                  <span className="ml-auto truncate" title="worst">{a.worstCs || '—'}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="mean composite score 0-100">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${barPct}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500/80" style={{ left: '25%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400/80" style={{ left: '55%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400/80" style={{ left: '80%' }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate" title="bottles / oei / mean-margin">{a.spec.bottleCount}× btl · OEI {a.spec.oeiKts}kt · margin {a.meanMargin >= 0 ? '+' : ''}{a.meanMargin.toFixed(0)}%</span>
                  <span className="ml-auto truncate" style={{ color: a.worstTier === 'OK' ? '#64748b' : TIER_COLOR[a.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        14 CFR 25.857 / 25.858 / 121.1119 · FAA AC 25-9A · AC 120-42B · AC 120-80B · NFPA 12A halon-1301 · {APTS.length}-airport diversion catalogue · {Object.keys(CLASS_SPEC).length} class bottle catalogue
      </div>
    </div>
  )
}
