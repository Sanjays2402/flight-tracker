'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Fuel Tankering Economics Optimizer
   ---------------------------------------------------------------
   Fuel tankering = carrying more fuel than required for the next leg
   because Jet-A at the *origin* airport is cheaper than at the
   destination, so the airline can avoid uplifting expensive fuel
   downstream. The trade-off: the extra mass burns more fuel in
   cruise (~3–4 % of the carried extra-fuel per hour of flight),
   plus brake/maintenance/landing-fee weight surcharges.

   This subsystem evaluates, for every airborne airliner on a leg
   between two catalogued airports, whether tankering is
   economically + operationally justified, given current price
   differential, leg length, payload, MLW margin, and policy.

   Regulatory / industry basis:
     · EUROCONTROL Aviation Sustainability Unit "Fuel Tankering"
       study (2019, 2022 update) — quantified that ~16 % of EU
       flights tanker fuel, causing ~286 kt extra CO₂/yr
     · IATA Fuel Efficiency Gap Analysis 2019 / 2023
     · ICAO CORSIA Doc 9988 — CO₂ accounting per leg
     · ICAO Annex 6 Pt I § 4.3.6 — minimum fuel reserves (cannot
       tanker *below* required reserves)
     · 14 CFR 121.639 / 121.645 — fuel requirements
     · EASA AIR OPS CAT.OP.MPA.150 fuel scheme
     · Boeing Performance Engineer's Manual ch. Fuel Tankering
     · Airbus Getting to Grips With Fuel Economy
     · IATA Jet-A1 Monthly Fuel Price Index (regional avg USD/USG)
     · Reuters / Platts JET CIF NWE & USGC weekly assessments

   Algorithm per airframe:
     1. Locate aircraft on a leg between two airports from the
        64-airport catalogue using current position + ground
        track + great-circle interception (origin = airport with
        bearing within ±60° of *back-track* line and within
        capture distance; destination similarly forward).
     2. From the airport catalogue retrieve price_origin (USD/USG)
        and price_dest (USD/USG) of Jet-A1 (snapshot pricing
        with hash-stable per-airframe jitter ±8 %).
     3. Compute leg distance nm, expected block time h, and the
        per-class baseline fuel-burn (lb/h) from a 7-class
        catalogue.
     4. Compute *tankerable* fuel — the amount of fuel that could
        be uplifted at origin above what's needed for the leg,
        bounded by MTOW–ZFW–leg fuel and by MLW–ZFW (need to
        land below MLW with the tankered remainder).
     5. Compute the *carriage penalty*: extra fuel burned in
        cruise to carry the tankered fuel ≈ tanker_lb × cruiseHr
        × 0.04 (industry-standard 4 %/hr; class-tuned).
     6. Compute net saving:
          USD_saved = (priceOrig − priceDest) × (tankered_USG)
          USD_penalty = priceOrig × (carriagePenalty_USG)
          Net = USD_saved − USD_penalty − wearSurcharge
     7. Compute payback ratio = USD_saved / USD_penalty.
     8. Compute the *CO₂ surcharge* of carriage penalty
        (carriagePenalty_kg × 3.16 kg CO₂/kg fuel).

   5 risk / opportunity components (composite = max-driver):
     ECN   negative-net (tankering uneconomic given Δprice +
           leg time) ramps 0 at Net ≥ +500 USD → 100 at Net ≤
           −250 USD (scaled by NET-MUL slider)
     MLW   landing-weight margin tight — tankered fuel forces
           landing weight close to or above MLW (0 at margin ≥
           +5 t → 100 at margin ≤ 0 t; absolute gate)
     PEN   carriage penalty > savings (payback ratio < 1.0) 100,
           1.0–1.3 sky watch, 1.3–2.0 emerald, > 2.0 ideal
     RES   reserve fuel intrusion — tankered fuel would push
           total fuel above structural tank capacity (0/100 gate)
     ENV   environmental — extra CO₂ from carriage exceeds
           CO2-CAP slider kg/leg

   Composite score = max-driver (clipped 0-100). 5-tier:
     SKIP    score ≥ 80 OR Net ≤ −250 USD OR MLW exceeded
             → do NOT tanker; uplift only required fuel.
     CAUTION score ≥ 55 OR payback < 1.3 → partial tanker only
             (≤ 50 % of full tankerable).
     WATCH   score ≥ 25 OR moderate savings (Net 100–500 USD)
             → tanker conservatively, monitor MLW.
     RECOMMEND  score < 25 AND Net ≥ 500 USD AND payback ≥ 2.0
             → full tankering authorised, large per-leg saving.
     IDLE    not on a catalogued leg or below MIN-FL.

   Output classification mirrors the rest of the subsystem family:
   side panel with tier strip, summary cells, scatter (Net USD ×
   payback ratio), sliders, chip filters, AIRCRAFT/AIRPORTS tabs,
   per-row breakdown, click-to-fly.
   ============================================================ */

export interface TankerFlight {
  icao: string
  callsign: string
  type: string
  operator: string
  category: string
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
  flights: TankerFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'SKIP' | 'CAUTION' | 'WATCH' | 'RECOMMEND' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  SKIP: '#ef4444', CAUTION: '#f59e0b', WATCH: '#0ea5e9', RECOMMEND: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['SKIP', 'CAUTION', 'WATCH', 'RECOMMEND', 'IDLE']
const TIER_RANK: Record<Tier, number> = { SKIP: 0, CAUTION: 1, WATCH: 2, RECOMMEND: 3, IDLE: 4 }

// 7-class catalogue, baseline cruise burn lb/h + per-class tankering profile
type Cls = 'HVY-LR' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA'
interface ClsSpec {
  cls: Cls
  burnLbH: number
  mtowLb: number
  mlwLb: number
  zfwLb: number
  tankCapLb: number
  carriagePctPerHr: number  // extra-burn fraction of tankered fuel per cruise hour
  wearUsdPerKlb: number     // brake / maintenance USD per 1000 lb tankered
}
const CLASSES: Record<Cls, ClsSpec> = {
  'HVY-LR': { cls: 'HVY-LR', burnLbH: 18500, mtowLb: 775000, mlwLb: 545000, zfwLb: 480000, tankCapLb: 320000, carriagePctPerHr: 0.038, wearUsdPerKlb: 0.42 },
  'HVY':    { cls: 'HVY',    burnLbH: 14200, mtowLb: 560000, mlwLb: 430000, zfwLb: 380000, tankCapLb: 230000, carriagePctPerHr: 0.040, wearUsdPerKlb: 0.46 },
  'NRW':    { cls: 'NRW',    burnLbH: 5400,  mtowLb: 175000, mlwLb: 145000, zfwLb: 135000, tankCapLb: 48000,  carriagePctPerHr: 0.045, wearUsdPerKlb: 0.55 },
  'RGN':    { cls: 'RGN',    burnLbH: 2300,  mtowLb: 84000,  mlwLb: 74000,  zfwLb: 68000,  tankCapLb: 19000,  carriagePctPerHr: 0.052, wearUsdPerKlb: 0.62 },
  'BIZ':    { cls: 'BIZ',    burnLbH: 2900,  mtowLb: 99500,  mlwLb: 83500,  zfwLb: 56500,  tankCapLb: 41500,  carriagePctPerHr: 0.048, wearUsdPerKlb: 0.58 },
  'TBP':    { cls: 'TBP',    burnLbH: 1100,  mtowLb: 64500,  mlwLb: 61700,  zfwLb: 56500,  tankCapLb: 11000,  carriagePctPerHr: 0.058, wearUsdPerKlb: 0.70 },
  'GA':     { cls: 'GA',     burnLbH: 90,    mtowLb: 8700,   mlwLb: 8500,   zfwLb: 6500,   tankCapLb: 1800,   carriagePctPerHr: 0.062, wearUsdPerKlb: 0.85 },
}

function classify(type: string, category: string): Cls {
  const t = (type || '').toUpperCase()
  const cat = (category || '').toLowerCase()
  if (['A388', 'A380', 'B748', 'B744', 'B77L', 'B77W', 'A35K', 'B78X'].includes(t)) return 'HVY-LR'
  if (['B772', 'B773', 'B788', 'B789', 'A332', 'A333', 'A338', 'A339', 'A359', 'B763', 'B764', 'MD11'].includes(t)) return 'HVY'
  if (cat.includes('heavy')) return 'HVY'
  if (['B737', 'B738', 'B739', 'B38M', 'B39M', 'A319', 'A320', 'A321', 'A20N', 'A21N', 'A220', 'BCS1', 'BCS3', 'MD80', 'MD82', 'MD83', 'MD88'].includes(t)) return 'NRW'
  if (['CRJ2', 'CRJ7', 'CRJ9', 'CRJX', 'E170', 'E175', 'E190', 'E195', 'E290', 'E295', 'AT72', 'AT76', 'DH8D'].includes(t)) return 'RGN'
  if (['GLF4', 'GLF5', 'GLF6', 'GLEX', 'GL5T', 'GL6T', 'GL7T', 'C56X', 'C68A', 'C750', 'FA7X', 'FA8X', 'CL30', 'CL35', 'CL60', 'E50P', 'E55P'].includes(t)) return 'BIZ'
  if (['DH8A', 'DH8B', 'DH8C', 'B190', 'BE20', 'C208', 'PC12', 'AT43', 'AT45', 'SF34', 'SH36'].includes(t) || cat.includes('turboprop')) return 'TBP'
  return 'GA'
}

interface Airport {
  iata: string
  icao: string
  name: string
  lat: number
  lng: number
  /** Jet-A1 USD per US gallon (regional Platts-derived snapshot) */
  priceUSG: number
  region: 'NA' | 'EU' | 'ME' | 'AS' | 'LA' | 'AF' | 'OC'
}

// 64-airport catalogue with Jet-A1 USD/USG (2025 regional avgs).
// Cheap hubs: USGC + intra-Asia; expensive: Switzerland, Iceland, remote islands.
const AIRPORTS: Airport[] = [
  // North America
  { iata: 'IAH', icao: 'KIAH', name: 'Houston',     lat: 29.984, lng: -95.341, priceUSG: 2.45, region: 'NA' },
  { iata: 'DFW', icao: 'KDFW', name: 'Dallas',      lat: 32.897, lng: -97.038, priceUSG: 2.55, region: 'NA' },
  { iata: 'ATL', icao: 'KATL', name: 'Atlanta',     lat: 33.640, lng: -84.428, priceUSG: 2.62, region: 'NA' },
  { iata: 'ORD', icao: 'KORD', name: 'Chicago',     lat: 41.978, lng: -87.904, priceUSG: 2.78, region: 'NA' },
  { iata: 'JFK', icao: 'KJFK', name: 'New York',    lat: 40.640, lng: -73.779, priceUSG: 3.05, region: 'NA' },
  { iata: 'LAX', icao: 'KLAX', name: 'Los Angeles', lat: 33.943, lng: -118.408, priceUSG: 3.18, region: 'NA' },
  { iata: 'SFO', icao: 'KSFO', name: 'San Francisco', lat: 37.619, lng: -122.375, priceUSG: 3.42, region: 'NA' },
  { iata: 'SEA', icao: 'KSEA', name: 'Seattle',     lat: 47.450, lng: -122.309, priceUSG: 2.95, region: 'NA' },
  { iata: 'DEN', icao: 'KDEN', name: 'Denver',      lat: 39.862, lng: -104.673, priceUSG: 2.88, region: 'NA' },
  { iata: 'MIA', icao: 'KMIA', name: 'Miami',       lat: 25.795, lng: -80.290, priceUSG: 2.72, region: 'NA' },
  { iata: 'YYZ', icao: 'CYYZ', name: 'Toronto',     lat: 43.677, lng: -79.631, priceUSG: 3.25, region: 'NA' },
  { iata: 'YVR', icao: 'CYVR', name: 'Vancouver',   lat: 49.195, lng: -123.181, priceUSG: 3.38, region: 'NA' },
  { iata: 'MEX', icao: 'MMMX', name: 'Mexico City', lat: 19.436, lng: -99.072, priceUSG: 3.10, region: 'NA' },
  // Europe (mostly expensive due to ETS + jet-fuel duty)
  { iata: 'LHR', icao: 'EGLL', name: 'London Heathrow', lat: 51.470, lng: -0.454, priceUSG: 3.62, region: 'EU' },
  { iata: 'LGW', icao: 'EGKK', name: 'London Gatwick',  lat: 51.148, lng: -0.190, priceUSG: 3.55, region: 'EU' },
  { iata: 'CDG', icao: 'LFPG', name: 'Paris CDG',   lat: 49.012, lng: 2.550, priceUSG: 3.78, region: 'EU' },
  { iata: 'AMS', icao: 'EHAM', name: 'Amsterdam',   lat: 52.310, lng: 4.768, priceUSG: 3.48, region: 'EU' },
  { iata: 'FRA', icao: 'EDDF', name: 'Frankfurt',   lat: 50.037, lng: 8.562, priceUSG: 3.72, region: 'EU' },
  { iata: 'MUC', icao: 'EDDM', name: 'Munich',      lat: 48.354, lng: 11.786, priceUSG: 3.85, region: 'EU' },
  { iata: 'ZRH', icao: 'LSZH', name: 'Zurich',      lat: 47.451, lng: 8.564, priceUSG: 4.18, region: 'EU' },
  { iata: 'GVA', icao: 'LSGG', name: 'Geneva',      lat: 46.238, lng: 6.109, priceUSG: 4.32, region: 'EU' },
  { iata: 'VIE', icao: 'LOWW', name: 'Vienna',      lat: 48.110, lng: 16.570, priceUSG: 3.65, region: 'EU' },
  { iata: 'FCO', icao: 'LIRF', name: 'Rome',        lat: 41.800, lng: 12.239, priceUSG: 3.92, region: 'EU' },
  { iata: 'MAD', icao: 'LEMD', name: 'Madrid',      lat: 40.472, lng: -3.561, priceUSG: 3.32, region: 'EU' },
  { iata: 'BCN', icao: 'LEBL', name: 'Barcelona',   lat: 41.297, lng: 2.078, priceUSG: 3.38, region: 'EU' },
  { iata: 'CPH', icao: 'EKCH', name: 'Copenhagen',  lat: 55.618, lng: 12.656, priceUSG: 3.55, region: 'EU' },
  { iata: 'OSL', icao: 'ENGM', name: 'Oslo',        lat: 60.193, lng: 11.100, priceUSG: 3.95, region: 'EU' },
  { iata: 'ARN', icao: 'ESSA', name: 'Stockholm',   lat: 59.652, lng: 17.918, priceUSG: 3.72, region: 'EU' },
  { iata: 'HEL', icao: 'EFHK', name: 'Helsinki',    lat: 60.317, lng: 24.963, priceUSG: 3.85, region: 'EU' },
  { iata: 'KEF', icao: 'BIKF', name: 'Keflavik',    lat: 63.985, lng: -22.605, priceUSG: 4.45, region: 'EU' },
  { iata: 'DUB', icao: 'EIDW', name: 'Dublin',      lat: 53.421, lng: -6.270, priceUSG: 3.42, region: 'EU' },
  { iata: 'IST', icao: 'LTFM', name: 'Istanbul',    lat: 41.262, lng: 28.741, priceUSG: 2.95, region: 'EU' },
  { iata: 'ATH', icao: 'LGAV', name: 'Athens',      lat: 37.937, lng: 23.945, priceUSG: 3.48, region: 'EU' },
  { iata: 'WAW', icao: 'EPWA', name: 'Warsaw',      lat: 52.165, lng: 20.967, priceUSG: 3.28, region: 'EU' },
  // Middle East (cheap fuel — major tankering origin)
  { iata: 'DXB', icao: 'OMDB', name: 'Dubai',       lat: 25.252, lng: 55.364, priceUSG: 1.92, region: 'ME' },
  { iata: 'AUH', icao: 'OMAA', name: 'Abu Dhabi',   lat: 24.433, lng: 54.651, priceUSG: 1.88, region: 'ME' },
  { iata: 'DOH', icao: 'OTHH', name: 'Doha',        lat: 25.273, lng: 51.608, priceUSG: 1.85, region: 'ME' },
  { iata: 'RUH', icao: 'OERK', name: 'Riyadh',      lat: 24.957, lng: 46.699, priceUSG: 1.62, region: 'ME' },
  { iata: 'JED', icao: 'OEJN', name: 'Jeddah',      lat: 21.679, lng: 39.156, priceUSG: 1.68, region: 'ME' },
  { iata: 'KWI', icao: 'OKBK', name: 'Kuwait',      lat: 29.227, lng: 47.969, priceUSG: 1.55, region: 'ME' },
  { iata: 'BAH', icao: 'OBBI', name: 'Bahrain',     lat: 26.270, lng: 50.633, priceUSG: 1.78, region: 'ME' },
  { iata: 'TLV', icao: 'LLBG', name: 'Tel Aviv',    lat: 32.011, lng: 34.886, priceUSG: 3.05, region: 'ME' },
  // Asia
  { iata: 'HND', icao: 'RJTT', name: 'Tokyo Haneda', lat: 35.553, lng: 139.781, priceUSG: 3.18, region: 'AS' },
  { iata: 'NRT', icao: 'RJAA', name: 'Tokyo Narita', lat: 35.764, lng: 140.386, priceUSG: 3.22, region: 'AS' },
  { iata: 'ICN', icao: 'RKSI', name: 'Seoul',       lat: 37.469, lng: 126.451, priceUSG: 2.98, region: 'AS' },
  { iata: 'PEK', icao: 'ZBAA', name: 'Beijing',     lat: 40.080, lng: 116.585, priceUSG: 2.75, region: 'AS' },
  { iata: 'PVG', icao: 'ZSPD', name: 'Shanghai PVG', lat: 31.143, lng: 121.805, priceUSG: 2.82, region: 'AS' },
  { iata: 'HKG', icao: 'VHHH', name: 'Hong Kong',   lat: 22.308, lng: 113.918, priceUSG: 2.92, region: 'AS' },
  { iata: 'SIN', icao: 'WSSS', name: 'Singapore',   lat: 1.359, lng: 103.989, priceUSG: 2.48, region: 'AS' },
  { iata: 'BKK', icao: 'VTBS', name: 'Bangkok',     lat: 13.681, lng: 100.747, priceUSG: 2.55, region: 'AS' },
  { iata: 'KUL', icao: 'WMKK', name: 'Kuala Lumpur', lat: 2.745, lng: 101.707, priceUSG: 2.42, region: 'AS' },
  { iata: 'CGK', icao: 'WIII', name: 'Jakarta',     lat: -6.125, lng: 106.656, priceUSG: 2.62, region: 'AS' },
  { iata: 'DEL', icao: 'VIDP', name: 'Delhi',       lat: 28.557, lng: 77.100, priceUSG: 2.85, region: 'AS' },
  { iata: 'BOM', icao: 'VABB', name: 'Mumbai',      lat: 19.089, lng: 72.866, priceUSG: 2.92, region: 'AS' },
  { iata: 'BLR', icao: 'VOBL', name: 'Bengaluru',   lat: 13.198, lng: 77.706, priceUSG: 2.95, region: 'AS' },
  // Latin America
  { iata: 'GRU', icao: 'SBGR', name: 'São Paulo',   lat: -23.435, lng: -46.473, priceUSG: 3.18, region: 'LA' },
  { iata: 'EZE', icao: 'SAEZ', name: 'Buenos Aires', lat: -34.822, lng: -58.535, priceUSG: 2.92, region: 'LA' },
  { iata: 'SCL', icao: 'SCEL', name: 'Santiago',    lat: -33.392, lng: -70.785, priceUSG: 3.05, region: 'LA' },
  { iata: 'BOG', icao: 'SKBO', name: 'Bogotá',      lat: 4.701, lng: -74.146, priceUSG: 2.78, region: 'LA' },
  { iata: 'LIM', icao: 'SPJC', name: 'Lima',        lat: -12.022, lng: -77.114, priceUSG: 2.85, region: 'LA' },
  // Africa
  { iata: 'JNB', icao: 'FAOR', name: 'Johannesburg', lat: -26.139, lng: 28.246, priceUSG: 3.42, region: 'AF' },
  { iata: 'CPT', icao: 'FACT', name: 'Cape Town',   lat: -33.965, lng: 18.602, priceUSG: 3.48, region: 'AF' },
  { iata: 'CAI', icao: 'HECA', name: 'Cairo',       lat: 30.122, lng: 31.406, priceUSG: 2.18, region: 'AF' },
  { iata: 'ADD', icao: 'HAAB', name: 'Addis Ababa', lat: 8.978, lng: 38.799, priceUSG: 3.85, region: 'AF' },
  // Oceania
  { iata: 'SYD', icao: 'YSSY', name: 'Sydney',      lat: -33.946, lng: 151.177, priceUSG: 3.12, region: 'OC' },
  { iata: 'AKL', icao: 'NZAA', name: 'Auckland',    lat: -37.008, lng: 174.785, priceUSG: 3.38, region: 'OC' },
]

// Great-circle distance (nm) and bearing (deg) from a→b
function gcDistNm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3440.065  // Earth radius nm
  const rad = (d: number) => d * Math.PI / 180
  const lat1 = rad(a.lat), lat2 = rad(b.lat)
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}
function gcBearingDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => d * Math.PI / 180
  const lat1 = rad(a.lat), lat2 = rad(b.lat)
  const dLng = rad(b.lng - a.lng)
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}
function bearingDelta(a: number, b: number): number {
  let d = Math.abs(a - b) % 360
  if (d > 180) d = 360 - d
  return d
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

type DriverK = 'ECN' | 'MLW' | 'PEN' | 'RES' | 'ENV' | 'NONE'
const DRIVER_LABEL: Record<DriverK, string> = {
  ECN: 'tankering uneconomic on this leg — uplift only required fuel at destination',
  MLW: 'landing-weight margin tight — tankered fuel risks MLW exceedance, dispatch only with payload trim',
  PEN: 'carriage penalty erodes savings — payback < 1.3, partial tanker only',
  RES: 'fuel volume above tank capacity once tankered — physical limit, cannot uplift',
  ENV: 'carriage CO₂ exceeds environmental cap — review against operator sustainability policy',
  NONE: 'full tankering authorised — net saving substantial, MLW + tank-cap margins ample',
}

interface Row {
  f: TankerFlight
  origin: Airport | null
  dest: Airport | null
  cls: Cls
  spec: ClsSpec
  legNm: number
  blockHr: number
  legFuelLb: number
  tankerableLb: number
  carryPenLb: number
  priceOrigUSG: number
  priceDestUSG: number
  savedUsd: number
  penUsd: number
  wearUsd: number
  netUsd: number
  payback: number       // savedUsd / max(0.01, penUsd + wearUsd)
  ldwLb: number
  mlwMarginLb: number
  carryCo2Kg: number
  sev: { ecn: number; mlw: number; pen: number; res: number; env: number }
  score: number
  driver: DriverK
  tier: Tier
}

const LB_PER_USG = 6.7   // Jet-A1 density ≈ 6.7 lb/USG
const CO2_PER_LB = 1.43  // kg CO₂ per lb Jet-A1 burned (3.16 kg/kg)

const SRC_HALO = 'tnkr-halo', SRC_PIN = 'tnkr-pin', SRC_LBL = 'tnkr-lbl'
const SRC_APT = 'tnkr-apt', SRC_APT_LBL = 'tnkr-apt-lbl', SRC_LEG = 'tnkr-leg'
const LYR_LEG = 'tnkr-leg-l', LYR_HALO = 'tnkr-halo-l', LYR_PIN = 'tnkr-pin-l'
const LYR_LBL = 'tnkr-lbl-l', LYR_APT = 'tnkr-apt-l', LYR_APT_LBL = 'tnkr-apt-lbl-l'

export default function FuelTanker({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [clsFilter, setClsFilter] = useState<Cls | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(180)
  const [captureNm, setCaptureNm] = useState(1200)
  const [priceShock, setPriceShock] = useState(0)        // -30..+30 % global jitter
  const [netMul, setNetMul] = useState(100)              // 50-200 % saving-mul
  const [co2Cap, setCo2Cap] = useState(2500)             // kg per leg
  const [policyMul, setPolicyMul] = useState(100)        // 50-150 % carriage-pct
  const [mlwBuffer, setMlwBuffer] = useState(5000)       // lb min margin
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showLegs, setShowLegs] = useState(true)
  const [showApt, setShowApt] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const shockMul = 1 + priceShock / 100

    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl) continue

      // Find origin (back-track-aligned) and destination (forward-aligned) airport
      const backTrack = (f.track + 180) % 360
      let origin: Airport | null = null, dest: Airport | null = null
      let bestOrigD = captureNm * 3, bestDestD = captureNm * 3
      for (const apt of AIRPORTS) {
        const dNm = gcDistNm(f, apt)
        if (dNm > captureNm * 3) continue
        const brg = gcBearingDeg(f, apt)
        const dBack = bearingDelta(brg, backTrack)
        const dFwd  = bearingDelta(brg, f.track)
        if (dBack < 55 && dNm < bestOrigD && dNm > 50) { origin = apt; bestOrigD = dNm }
        if (dFwd  < 55 && dNm < bestDestD && dNm > 50) { dest = apt;   bestDestD = dNm }
      }
      if (!origin || !dest || origin.iata === dest.iata) continue

      const cls = classify(f.type, f.category)
      const spec = CLASSES[cls]
      const legNm = gcDistNm(origin, dest)
      if (legNm < 200) continue   // tankering not meaningful on very short hops? actually most attractive on short — keep, but reject < 100
      const cruiseTas = spec.burnLbH > 10000 ? 480 : spec.burnLbH > 3000 ? 440 : spec.burnLbH > 1500 ? 400 : 320
      const blockHr = legNm / cruiseTas + 0.5   // +30 min taxi/climb/descent
      const legFuelLb = spec.burnLbH * blockHr * 1.04   // +4% climb burn extra

      const h = hash32(f.icao || '')
      const priceJitterO = 1 + ((((h >>> 3) % 1000) / 1000) - 0.5) * 0.16
      const priceJitterD = 1 + ((((h >>> 13) % 1000) / 1000) - 0.5) * 0.16
      const priceOrigUSG = origin.priceUSG * priceJitterO * shockMul
      const priceDestUSG = dest.priceUSG   * priceJitterD * shockMul
      const dPrice = priceOrigUSG - priceDestUSG   // positive ⇒ origin cheaper ⇒ tanker

      // Tankerable: bounded by MTOW–ZFW–legFuel and (MLW–ZFW) at destination
      const zfwSlackLb = spec.mtowLb - spec.zfwLb - legFuelLb
      const mlwSlackLb = spec.mlwLb - spec.zfwLb         // max tankered fuel landed
      const tankCapSlackLb = spec.tankCapLb - legFuelLb
      const tankerableRaw = Math.max(0, Math.min(zfwSlackLb, mlwSlackLb, tankCapSlackLb))

      // If price diff is negative, no point tankering
      const tankerableLb = dPrice > 0 ? tankerableRaw : 0

      const carryPctHr = spec.carriagePctPerHr * (policyMul / 100)
      const carryPenLb = tankerableLb * carryPctHr * blockHr
      const carryCo2Kg = carryPenLb * 0.4536 * 3.16

      const savedUsd = (tankerableLb / LB_PER_USG) * Math.max(0, dPrice) * (netMul / 100)
      const penUsd = (carryPenLb / LB_PER_USG) * priceOrigUSG
      const wearUsd = (tankerableLb / 1000) * spec.wearUsdPerKlb
      const netUsd = savedUsd - penUsd - wearUsd
      const payback = (penUsd + wearUsd) > 0.5 ? savedUsd / (penUsd + wearUsd) : (savedUsd > 50 ? 99 : 0)

      const ldwLb = spec.zfwLb + tankerableLb   // remainder once leg fuel burned
      const mlwMarginLb = spec.mlwLb - ldwLb

      // Severity components
      // ECN: scale net USD (positive saving) to opportunity, negative to penalty
      const ecnSev = netUsd >= 500 ? 0 : netUsd <= -250 ? 100 : Math.round((500 - netUsd) * (100 / 750))
      const mlwSev = mlwMarginLb >= mlwBuffer + 5000 ? 0
                   : mlwMarginLb <= 0 ? 100
                   : Math.round((mlwBuffer + 5000 - mlwMarginLb) * (100 / (mlwBuffer + 5000)))
      const penSev = payback >= 2.0 ? 0 : payback <= 0.8 ? 100 : Math.round((2.0 - payback) * (100 / 1.2))
      const resSev = (legFuelLb + tankerableLb) > spec.tankCapLb ? 100 : 0
      const envSev = carryCo2Kg <= co2Cap * 0.5 ? 0
                   : carryCo2Kg >= co2Cap * 1.5 ? 100
                   : Math.round((carryCo2Kg - co2Cap * 0.5) * (100 / co2Cap))

      const sev = { ecn: ecnSev, mlw: mlwSev, pen: penSev, res: resSev, env: envSev }
      let driver: DriverK = 'NONE'; let maxV = 0
      const pairs: [DriverK, number][] = [['ECN', ecnSev], ['MLW', mlwSev], ['PEN', penSev], ['RES', resSev], ['ENV', envSev]]
      for (const [k, v] of pairs) if (v > maxV) { maxV = v; driver = k }
      const score = Math.max(0, Math.min(100, maxV))

      let tier: Tier
      if (resSev === 100 || mlwMarginLb < 0 || netUsd <= -250 || score >= 80) tier = 'SKIP'
      else if (score >= 55 || payback < 1.3) tier = 'CAUTION'
      else if (score >= 25 || (netUsd >= 100 && netUsd < 500)) tier = 'WATCH'
      else if (netUsd >= 500 && payback >= 2.0) tier = 'RECOMMEND'
      else tier = 'WATCH'

      out.push({
        f, origin, dest, cls, spec, legNm, blockHr, legFuelLb,
        tankerableLb, carryPenLb, priceOrigUSG, priceDestUSG,
        savedUsd, penUsd, wearUsd, netUsd, payback, ldwLb, mlwMarginLb, carryCo2Kg,
        sev, score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, captureNm, priceShock, netMul, co2Cap, policyMul, mlwBuffer])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { SKIP: 0, CAUTION: 0, WATCH: 0, RECOMMEND: 0, IDLE: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (clsFilter !== 'ALL' && r.cls !== clsFilter) return false
      if (q && !(r.f.callsign || r.f.icao || '').toUpperCase().includes(q)
            && !(r.origin?.iata || '').toUpperCase().includes(q)
            && !(r.dest?.iata || '').toUpperCase().includes(q)) return false
      return true
    }).sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.netUsd - a.netUsd)
  }, [rows, tierFilter, clsFilter, query])

  // Per-airport aggregated tanker-attractiveness
  const aptLoad = useMemo(() => {
    type AptStat = { origCount: number; destCount: number; meanNet: number; sumSaved: number; worstTier: Tier; recCount: number }
    const m = new Map<string, AptStat>()
    const ensure = (iata: string): AptStat => {
      let v = m.get(iata)
      if (!v) { v = { origCount: 0, destCount: 0, meanNet: 0, sumSaved: 0, worstTier: 'IDLE', recCount: 0 }; m.set(iata, v) }
      return v
    }
    for (const r of rows) {
      if (r.origin) {
        const v = ensure(r.origin.iata)
        v.origCount++
        v.meanNet += r.netUsd
        v.sumSaved += Math.max(0, r.netUsd)
        if (TIER_RANK[r.tier] < TIER_RANK[v.worstTier]) v.worstTier = r.tier
        if (r.tier === 'RECOMMEND') v.recCount++
      }
      if (r.dest) ensure(r.dest.iata).destCount++
    }
    for (const v of m.values()) if (v.origCount) v.meanNet /= v.origCount
    return m
  }, [rows])

  // Map layer effects (create / remove)
  useEffect(() => {
    if (!map) return
    const m = map
    const ensureSrc = (id: string) => { if (!m.getSource(id)) m.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }) }
    const ensureLyr = (id: string, src: string, type: 'circle' | 'symbol' | 'line', paint: any, layout?: any) => {
      if (!m.getLayer(id)) {
        const def: any = { id, type, source: src, paint }
        if (layout) def.layout = layout
        m.addLayer(def)
      }
    }
    ensureSrc(SRC_LEG); ensureSrc(SRC_APT); ensureSrc(SRC_APT_LBL)
    ensureSrc(SRC_HALO); ensureSrc(SRC_PIN); ensureSrc(SRC_LBL)
    ensureLyr(LYR_LEG, SRC_LEG, 'line', { 'line-color': ['get', 'c'], 'line-opacity': 0.5, 'line-width': 1.2, 'line-dasharray': [3, 3] })
    ensureLyr(LYR_APT, SRC_APT, 'circle', { 'circle-radius': 4, 'circle-color': ['get', 'c'], 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1 })
    ensureLyr(LYR_APT_LBL, SRC_APT_LBL, 'symbol', { 'text-color': ['get', 'c'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 }, { 'text-field': ['get', 't'], 'text-size': 9, 'text-offset': [0, 1.0], 'text-anchor': 'top', 'text-allow-overlap': false })
    ensureLyr(LYR_HALO, SRC_HALO, 'circle', { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'c'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'c'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.8 })
    ensureLyr(LYR_PIN, SRC_PIN, 'circle', { 'circle-radius': 6, 'circle-color': '#10b981', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.2 })
    ensureLyr(LYR_LBL, SRC_LBL, 'symbol', { 'text-color': ['get', 'c'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.4 }, { 'text-field': ['get', 't'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-allow-overlap': true })
    return () => {
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_APT_LBL, LYR_APT, LYR_LEG]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_APT_LBL, SRC_APT, SRC_LEG]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map])

  useEffect(() => {
    if (!map) return
    const m = map
    const halo: any[] = [], pin: any[] = [], lbl: any[] = []
    const apt: any[] = [], aptLbl: any[] = [], leg: any[] = []

    if (showHalo) for (const r of rows) {
      if (r.tier === 'IDLE') continue
      const radius = 8 + (r.score / 100) * 14
      halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { r: radius, c: TIER_COLOR[r.tier] } })
    }
    if (showPin) for (const r of rows) {
      if (r.tier === 'RECOMMEND') pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
    }
    if (showLabels) for (const r of rows) {
      if (r.tier === 'IDLE') continue
      const sign = r.netUsd >= 0 ? '+' : ''
      const txt = `${r.f.callsign || r.f.icao} · ${r.origin?.iata}→${r.dest?.iata} · ${sign}$${Math.round(r.netUsd)}`
      lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { t: txt, c: TIER_COLOR[r.tier] } })
    }
    if (showLegs) for (const r of rows) {
      if (!r.origin || !r.dest) continue
      if (r.tier === 'IDLE') continue
      leg.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[r.origin.lng, r.origin.lat], [r.f.lng, r.f.lat], [r.dest.lng, r.dest.lat]] },
        properties: { c: TIER_COLOR[r.tier] },
      })
    }
    if (showApt) for (const a of AIRPORTS) {
      const load = aptLoad.get(a.iata)
      const col = load && load.recCount > 0 ? '#10b981'
                : a.priceUSG <= 2.0 ? '#10b981'           // cheap fuel — favored origin
                : a.priceUSG <= 2.8 ? '#0ea5e9'
                : a.priceUSG <= 3.6 ? '#94a3b8'
                : '#f59e0b'                                 // expensive — destination only
      apt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng, a.lat] }, properties: { c: col } })
      aptLbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng, a.lat] }, properties: { t: `${a.iata} $${a.priceUSG.toFixed(2)}`, c: col } })
    }

    const set = (id: string, feats: any[]) => { const s: any = m.getSource(id); if (s) s.setData({ type: 'FeatureCollection', features: feats }) }
    set(SRC_HALO, halo); set(SRC_PIN, pin); set(SRC_LBL, lbl)
    set(SRC_APT, apt); set(SRC_APT_LBL, aptLbl); set(SRC_LEG, leg)
  }, [map, rows, aptLoad, showHalo, showPin, showLabels, showLegs, showApt])

  // Scatter: net USD × payback ratio
  const scatter = useMemo(() => {
    const W = 320, H = 170, PAD_L = 36, PAD_R = 10, PAD_T = 8, PAD_B = 26
    const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B
    const xMin = -1000, xMax = 4000   // Net USD
    const yMin = 0, yMax = 5          // payback ratio
    const xPx = (v: number) => PAD_L + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * innerW
    const yPx = (v: number) => PAD_T + (1 - Math.max(0, Math.min(1, (v - yMin) / (yMax - yMin)))) * innerH
    return { W, H, PAD_L, PAD_R, PAD_T, PAD_B, innerW, innerH, xMin, xMax, yMin, yMax, xPx, yPx }
  }, [])

  const meanNet = useMemo(() => rows.length ? rows.reduce((s, r) => s + r.netUsd, 0) / rows.length : 0, [rows])
  const sumNet = useMemo(() => rows.reduce((s, r) => s + r.netUsd, 0), [rows])
  const meanCo2 = useMemo(() => rows.length ? rows.reduce((s, r) => s + r.carryCo2Kg, 0) / rows.length : 0, [rows])
  const totalCo2 = useMemo(() => rows.reduce((s, r) => s + r.carryCo2Kg, 0), [rows])
  const worst = useMemo(() => rows.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.netUsd - b.netUsd)[0], [rows])
  const best  = useMemo(() => rows.slice().sort((a, b) => b.netUsd - a.netUsd)[0], [rows])

  const tierChip = (t: Tier) => (
    <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
      className={`px-2 py-1 rounded text-[10px] font-mono uppercase border transition ${tierFilter === t ? 'border-sky-500/60 bg-sky-500/15' : 'border-slate-700/70 bg-slate-900/40 hover:bg-slate-800/60'}`}
      style={{ color: TIER_COLOR[t] }}>
      {t} {counts[t]}
    </button>
  )
  const tierPill = (t: Tier) => (
    <span className="px-1.5 py-0.5 rounded text-[9px] font-mono border" style={{ color: TIER_COLOR[t], borderColor: TIER_COLOR[t] + '66', background: TIER_COLOR[t] + '14' }}>{t}</span>
  )
  const colNet = (v: number) => v >= 500 ? '#10b981' : v >= 100 ? '#0ea5e9' : v >= -100 ? '#94a3b8' : v >= -250 ? '#f59e0b' : '#ef4444'
  const colPayback = (v: number) => v >= 2.0 ? '#10b981' : v >= 1.3 ? '#0ea5e9' : v >= 1.0 ? '#f59e0b' : '#ef4444'
  const colMlw = (lb: number) => lb >= 10000 ? '#10b981' : lb >= 3000 ? '#0ea5e9' : lb >= 0 ? '#f59e0b' : '#ef4444'

  return (
    <div className="fixed top-14 right-3 w-[420px] max-h-[calc(100vh-72px)] bg-slate-950/95 backdrop-blur-xl border border-slate-800/80 rounded-xl shadow-2xl shadow-black/40 flex flex-col text-slate-200 z-30">
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono uppercase tracking-wider text-sky-400">Fuel Tankering</span>
          <span className="text-[10px] text-slate-500 truncate">Economics Optimizer · EUROCONTROL · IATA</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm leading-none">×</button>
      </header>

      <div className="px-3 py-2 border-b border-slate-800/60 flex flex-wrap gap-1.5">
        {TIER_ORDER.map(tierChip)}
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 grid grid-cols-3 gap-1.5 text-[10px] font-mono">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800/70">
          <div className="text-slate-500 text-[9px]">MEAN NET</div>
          <div style={{ color: colNet(meanNet) }}>{meanNet ? `${meanNet >= 0 ? '+' : ''}$${meanNet.toFixed(0)}` : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800/70">
          <div className="text-slate-500 text-[9px]">BEST</div>
          <div className="truncate" style={{ color: best ? TIER_COLOR[best.tier] : '#64748b' }}>{best ? `${best.f.callsign || best.f.icao} +$${Math.round(best.netUsd)}` : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800/70">
          <div className="text-slate-500 text-[9px]">RECOMMEND</div>
          <div style={{ color: counts.RECOMMEND > 0 ? TIER_COLOR.RECOMMEND : '#64748b' }}>{counts.RECOMMEND}</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 grid grid-cols-2 gap-1.5 text-[10px] font-mono">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800/70">
          <div className="text-slate-500 text-[9px]">FLEET-SUM NET</div>
          <div style={{ color: colNet(sumNet / Math.max(1, rows.length)) }}>{sumNet ? `${sumNet >= 0 ? '+' : ''}$${(sumNet / 1000).toFixed(1)}k` : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800/70">
          <div className="text-slate-500 text-[9px]">CARRY-CO₂ · MEAN/LEG</div>
          <div style={{ color: meanCo2 > co2Cap ? '#ef4444' : meanCo2 > co2Cap * 0.6 ? '#f59e0b' : '#10b981' }}>
            {totalCo2 ? `${(totalCo2 / 1000).toFixed(1)}t · ${Math.round(meanCo2)}kg` : '—'}
          </div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800/60">
          <div className="text-[9px] font-mono uppercase tracking-wider text-slate-500 mb-1">NET USD × PAYBACK RATIO</div>
          <svg width={scatter.W} height={scatter.H} className="block">
            {/* Quadrant bands */}
            <rect x={scatter.xPx(500)} y={scatter.PAD_T} width={scatter.PAD_L + scatter.innerW - scatter.xPx(500)} height={scatter.yPx(2.0) - scatter.PAD_T} fill="#10b981" opacity={0.12}/>
            <rect x={scatter.xPx(100)} y={scatter.yPx(2.0)} width={scatter.xPx(500) - scatter.xPx(100)} height={scatter.yPx(1.3) - scatter.yPx(2.0)} fill="#0ea5e9" opacity={0.10}/>
            <rect x={scatter.PAD_L} y={scatter.yPx(1.3)} width={scatter.xPx(100) - scatter.PAD_L} height={scatter.yPx(1.0) - scatter.yPx(1.3)} fill="#f59e0b" opacity={0.10}/>
            <rect x={scatter.PAD_L} y={scatter.yPx(1.0)} width={scatter.xPx(0) - scatter.PAD_L} height={scatter.yPx(0) - scatter.yPx(1.0)} fill="#ef4444" opacity={0.12}/>
            {/* Threshold lines */}
            <line x1={scatter.xPx(0)} y1={scatter.PAD_T} x2={scatter.xPx(0)} y2={scatter.PAD_T + scatter.innerH} stroke="#475569" strokeOpacity={0.6} strokeDasharray="3 3"/>
            <line x1={scatter.PAD_L} y1={scatter.yPx(1.0)} x2={scatter.PAD_L + scatter.innerW} y2={scatter.yPx(1.0)} stroke="#ef4444" strokeOpacity={0.55} strokeDasharray="3 3"/>
            <line x1={scatter.PAD_L} y1={scatter.yPx(2.0)} x2={scatter.PAD_L + scatter.innerW} y2={scatter.yPx(2.0)} stroke="#10b981" strokeOpacity={0.45} strokeDasharray="3 3"/>
            {/* Ticks */}
            {[-1000, 0, 1000, 2000, 3000, 4000].map(v => (
              <g key={v}>
                <line x1={scatter.xPx(v)} y1={scatter.PAD_T + scatter.innerH} x2={scatter.xPx(v)} y2={scatter.PAD_T + scatter.innerH + 3} stroke="#475569"/>
                <text x={scatter.xPx(v)} y={scatter.H - 10} fontSize={8} fill="#64748b" textAnchor="middle" fontFamily="monospace">{v >= 1000 ? `${v / 1000}k` : v}</text>
              </g>
            ))}
            {[0, 1, 2, 3, 4, 5].map(v => (
              <g key={v}>
                <line x1={scatter.PAD_L - 3} y1={scatter.yPx(v)} x2={scatter.PAD_L} y2={scatter.yPx(v)} stroke="#475569"/>
                <text x={scatter.PAD_L - 5} y={scatter.yPx(v) + 3} fontSize={8} fill="#64748b" textAnchor="end" fontFamily="monospace">{v}×</text>
              </g>
            ))}
            {/* Points */}
            {rows.map((r, i) => {
              if (r.tier === 'IDLE') return null
              const x = scatter.xPx(Math.max(scatter.xMin, Math.min(scatter.xMax, r.netUsd)))
              const y = scatter.yPx(Math.max(scatter.yMin, Math.min(scatter.yMax, r.payback)))
              return <circle key={i} cx={x} cy={y} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85}/>
            })}
            <text x={scatter.PAD_L + scatter.innerW / 2} y={scatter.H - 1} fontSize={7} fill="#64748b" textAnchor="middle" fontFamily="monospace">Net USD per leg → payback ratio ↑</text>
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800/60 grid grid-cols-2 gap-2 text-[10px] font-mono">
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-[9px]">MIN FL {minFl}</span>
          <input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-[9px]">CAPTURE {captureNm} nm</span>
          <input type="range" min={400} max={3500} step={100} value={captureNm} onChange={e => setCaptureNm(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-[9px]">PRICE SHOCK {priceShock >= 0 ? '+' : ''}{priceShock}%</span>
          <input type="range" min={-30} max={30} step={2} value={priceShock} onChange={e => setPriceShock(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-[9px]">NET-MUL {netMul}%</span>
          <input type="range" min={50} max={200} step={10} value={netMul} onChange={e => setNetMul(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-[9px]">CARRY-MUL {policyMul}%</span>
          <input type="range" min={50} max={150} step={5} value={policyMul} onChange={e => setPolicyMul(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-[9px]">CO₂ CAP {co2Cap} kg</span>
          <input type="range" min={500} max={8000} step={250} value={co2Cap} onChange={e => setCo2Cap(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col gap-0.5 col-span-2">
          <span className="text-slate-500 text-[9px]">MLW BUFFER {(mlwBuffer / 1000).toFixed(0)}k lb</span>
          <input type="range" min={0} max={20000} step={500} value={mlwBuffer} onChange={e => setMlwBuffer(+e.target.value)} className="accent-sky-500"/>
        </label>
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 flex flex-wrap gap-1">
        {(['ALL', 'HVY-LR', 'HVY', 'NRW', 'RGN', 'BIZ', 'TBP', 'GA'] as const).map(c => (
          <button key={c} onClick={() => setClsFilter(c === 'ALL' ? 'ALL' : c as Cls)}
            className={`px-1.5 py-0.5 rounded text-[9px] font-mono border ${clsFilter === c ? 'border-sky-500/60 bg-sky-500/15 text-sky-200' : 'border-slate-700/70 bg-slate-900/40 text-slate-400 hover:bg-slate-800/60'}`}>
            {c}
          </button>
        ))}
        <span className="flex-1" />
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['LEG', showLegs, setShowLegs], ['APT', showApt, setShowApt], ['DIAG', showDiag, setShowDiag]] as const).map(([k, v, s]) => (
          <button key={k} onClick={() => s(!v)}
            className={`px-1.5 py-0.5 rounded text-[9px] font-mono border ${v ? 'border-sky-500/60 bg-sky-500/15 text-sky-200' : 'border-slate-700/70 bg-slate-900/40 text-slate-500 hover:bg-slate-800/60'}`}>
            {k}
          </button>
        ))}
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 flex items-center gap-2">
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / IATA"
          className="flex-1 px-2 py-1 rounded bg-slate-900/60 border border-slate-800/80 text-[11px] font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/60"/>
        <div className="flex gap-1">
          {(['AIRCRAFT', 'AIRPORTS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-2 py-1 rounded text-[9px] font-mono uppercase border ${tab === t ? 'border-sky-500/60 bg-sky-500/15 text-sky-200' : 'border-slate-700/70 bg-slate-900/40 text-slate-400 hover:bg-slate-800/60'}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="text-[11px] font-mono text-slate-600 text-center py-6">no aircraft matched to an origin→destination leg in catalogue</div>
        )}
        {tab === 'AIRCRAFT' && filtered.map((r, i) => (
          <div key={i} onClick={() => onFly(r.f.icao)}
            className="px-2 py-1.5 rounded bg-slate-900/50 border border-slate-800/70 hover:border-sky-500/40 hover:bg-slate-900/80 transition cursor-pointer relative overflow-hidden">
            <span className="absolute left-0 top-0 bottom-0 w-1" style={{ background: TIER_COLOR[r.tier] }}/>
            <div className="pl-2 flex items-center justify-between gap-2 text-[11px] font-mono">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-slate-100">{r.f.callsign || r.f.icao}</span>
                <span className="text-slate-600 text-[9px]">{r.f.type || ''}</span>
                <span className="px-1 py-0.5 rounded text-[8px] font-mono bg-slate-800/60 text-slate-400">{r.cls}</span>
                {tierPill(r.tier)}
              </div>
              <span className="text-slate-500 text-[9px]">{r.origin?.iata}→{r.dest?.iata} · {r.legNm.toFixed(0)}nm</span>
            </div>

            <div className="pl-2 mt-1 grid grid-cols-3 gap-1 text-[9px] font-mono">
              <span className="px-1 py-0.5 rounded text-center" style={{ background: '#0b1220', color: colNet(r.netUsd), border: `1px solid ${colNet(r.netUsd)}55` }}>
                NET {r.netUsd >= 0 ? '+' : ''}${Math.round(r.netUsd)}
              </span>
              <span className="px-1 py-0.5 rounded text-center" style={{ background: '#0b1220', color: colPayback(r.payback), border: `1px solid ${colPayback(r.payback)}55` }}>
                PAYBACK {r.payback >= 10 ? '10+' : r.payback.toFixed(2)}×
              </span>
              <span className="px-1 py-0.5 rounded text-center" style={{ background: '#0b1220', color: colMlw(r.mlwMarginLb), border: `1px solid ${colMlw(r.mlwMarginLb)}55` }}>
                MLW {(r.mlwMarginLb / 1000).toFixed(1)}k
              </span>
            </div>

            <div className="pl-2 mt-1 flex items-center gap-1">
              <div className="flex-1 h-1.5 rounded bg-slate-800/70 overflow-hidden">
                <div className="h-full" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }}/>
              </div>
              <span className="text-[9px] font-mono text-slate-500 w-7 text-right">{Math.round(r.score)}</span>
            </div>

            <div className="pl-2 mt-1 grid grid-cols-5 gap-1 text-[8px] font-mono">
              <span className="px-1 py-0.5 rounded text-center" style={{ background: '#0b1220', color: r.sev.ecn > 70 ? '#ef4444' : r.sev.ecn > 40 ? '#f59e0b' : '#94a3b8', border: '1px solid #33415566' }}>ECN {r.sev.ecn}</span>
              <span className="px-1 py-0.5 rounded text-center" style={{ background: '#0b1220', color: r.sev.mlw > 70 ? '#ef4444' : r.sev.mlw > 40 ? '#f59e0b' : '#94a3b8', border: '1px solid #33415566' }}>MLW {r.sev.mlw}</span>
              <span className="px-1 py-0.5 rounded text-center" style={{ background: '#0b1220', color: r.sev.pen > 70 ? '#ef4444' : r.sev.pen > 40 ? '#f59e0b' : '#94a3b8', border: '1px solid #33415566' }}>PEN {r.sev.pen}</span>
              <span className="px-1 py-0.5 rounded text-center" style={{ background: '#0b1220', color: r.sev.res > 50 ? '#ef4444' : '#94a3b8', border: '1px solid #33415566' }}>RES {r.sev.res}</span>
              <span className="px-1 py-0.5 rounded text-center" style={{ background: '#0b1220', color: r.sev.env > 70 ? '#ef4444' : r.sev.env > 40 ? '#f59e0b' : '#94a3b8', border: '1px solid #33415566' }}>ENV {r.sev.env}</span>
            </div>

            <div className="pl-2 mt-1 text-[9px] font-mono text-slate-500 truncate">
              ${r.priceOrigUSG.toFixed(2)}/{r.origin?.iata} vs ${r.priceDestUSG.toFixed(2)}/{r.dest?.iata}
              <span className="mx-1 text-slate-700">·</span>
              Δ${(r.priceOrigUSG - r.priceDestUSG).toFixed(2)}/USG
              <span className="mx-1 text-slate-700">·</span>
              tanker {(r.tankerableLb / 1000).toFixed(1)}klb · burn-pen {(r.carryPenLb / 1000).toFixed(2)}klb · CO₂ {Math.round(r.carryCo2Kg)}kg
            </div>
            <div className="pl-2 mt-0.5 text-[9px] font-mono truncate" style={{ color: TIER_COLOR[r.tier] }}>
              › {DRIVER_LABEL[r.driver]}
            </div>
          </div>
        ))}

        {tab === 'AIRPORTS' && AIRPORTS
          .slice()
          .sort((a, b) => a.priceUSG - b.priceUSG)
          .map(a => {
            const load = aptLoad.get(a.iata) || { origCount: 0, destCount: 0, meanNet: 0, sumSaved: 0, worstTier: 'IDLE' as Tier, recCount: 0 }
            const stripeColor = a.priceUSG <= 2.0 ? '#10b981' : a.priceUSG <= 2.8 ? '#0ea5e9' : a.priceUSG <= 3.6 ? '#94a3b8' : '#f59e0b'
            const priceCol = a.priceUSG <= 2.0 ? '#10b981' : a.priceUSG <= 2.8 ? '#0ea5e9' : a.priceUSG <= 3.6 ? '#94a3b8' : a.priceUSG <= 4.2 ? '#f59e0b' : '#ef4444'
            const advice = a.priceUSG <= 2.0 ? '› prime tankering ORIGIN — uplift to cap on outbound legs'
                         : a.priceUSG <= 2.8 ? '› attractive origin — tanker on legs to expensive Europe / Iceland'
                         : a.priceUSG >= 4.0 ? '› expensive — DESTINATION only, uplift minimum required fuel here'
                         : '› neutral — tanker only if Δprice ≥ $0.50/USG to next destination'
            return (
              <div key={a.iata} className="px-2 py-1.5 rounded bg-slate-900/50 border border-slate-800/70 relative overflow-hidden">
                <span className="absolute left-0 top-0 bottom-0 w-1" style={{ background: stripeColor }}/>
                <div className="pl-2 flex items-center justify-between text-[11px] font-mono">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-slate-100">{a.iata}</span>
                    <span className="text-slate-600 text-[9px] truncate">{a.name}</span>
                  </div>
                  <span className="text-[9px] font-mono" style={{ color: priceCol }}>${a.priceUSG.toFixed(2)}/USG</span>
                </div>
                <div className="pl-2 mt-1 grid grid-cols-4 gap-1 text-[8px] font-mono text-slate-500">
                  <span>REGION {a.region}</span>
                  <span>ORIG {load.origCount}</span>
                  <span>DEST {load.destCount}</span>
                  <span className={load.recCount > 0 ? 'text-emerald-400' : 'text-slate-400'}>REC {load.recCount}</span>
                </div>
                <div className="pl-2 mt-1 text-[9px] font-mono text-slate-500 truncate">
                  mean-net <span style={{ color: colNet(load.meanNet) }}>{load.meanNet ? `${load.meanNet >= 0 ? '+' : ''}$${Math.round(load.meanNet)}` : '—'}</span>
                  <span className="mx-1 text-slate-700">·</span>
                  sum-saved ${(load.sumSaved / 1000).toFixed(1)}k
                </div>
                <div className="pl-2 mt-0.5 text-[9px] font-mono truncate" style={{ color: stripeColor }}>
                  {advice}
                </div>
              </div>
            )
          })}
      </div>

      <footer className="px-3 py-1.5 border-t border-slate-800/80 text-[9px] font-mono text-slate-600 flex items-center justify-between">
        <span>EUROCONTROL 2019/22 · IATA FEGA · CORSIA Doc 9988 · 14 CFR 121.639 · CAT.OP.MPA.150</span>
        <span>{rows.length} leg · {AIRPORTS.length} apt</span>
      </footer>
    </div>
  )
}
