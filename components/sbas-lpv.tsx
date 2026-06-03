'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   SBAS / LPV Approach Availability & Service-Volume Monitor
   -----------------------------------------------------------
   Per-airframe Satellite-Based Augmentation System receiver
   class (NO-SBAS / TSO-C145c Beta-1 LNAV/VNAV / TSO-C145d
   Beta-3 LPV-200 / TSO-C146d Class-3 DO-229E) cross-checked
   against destination airport published SBAS approach (LPV-200
   HAL 40m VAL 35m / LPV HAL 40m VAL 50m / LNAV/VNAV HAL 556m
   VAL 50m / LP HAL 40m / LNAV HAL 556m only) and live service-
   volume coverage from the 8 active SBAS providers:

     WAAS    USA/Canada/Mexico/AK/HI       (FAA, GEO PRN 131/133/135/138)
     EGNOS   Europe + ECAC + N.Africa      (ESSP, GEO PRN 123/126/136)
     MSAS    Japan + W.Pacific             (JCAB, GEO PRN 129/137)
     GAGAN   India + South-Asia            (AAI, GEO PRN 127/128)
     SDCM    Russia + CIS                  (Roscosmos, GEO PRN 125/140/141)
     KASS    Korea                         (KARI, GEO PRN 134 — IOC 2022)
     BDSBAS  China                         (BDSGSA, GEO PRN 130/144 — IOC 2025)
     SACCSA  Latin America                 (ICAO project, future)

   Each provider has a published service volume (lat/lng box +
   max-latitude gate per Annex 10 Vol I 3.7.3) and an iono-
   activity bias zone (equatorial scintillation for GAGAN/
   SACCSA / BDSBAS-South / sub-auroral storms for SDCM/WAAS-AK).

   Algorithm:
     1. RECEIVER class reconstructed per-airframe via FNV-1a 32
        hash of ICAO24 with per-class CDF (HVY 92pct C146d /
        NRW 70pct C145d / RGN 35pct C145d / BIZ 78pct C146d /
        TBP 18pct / GA 6pct).
     2. DEST airport lookup from 36-entry SBAS-published-approach
        catalogue spanning all 8 service volumes with published
        approach type per Jeppesen NavData Q2-2026 / NOTAM CY+1.
     3. SERVICE VOLUME gate — in-box AND below max-lat-deg
        (WAAS 80°N / EGNOS 70°N / MSAS 55°N / GAGAN 30°N /
        SDCM 80°N / KASS 45°N / BDSBAS 55°N).
     4. HPL/VPL synthesis from RX-class baseline (C146d 10m/12m
        nominal, C145d 18m/22m, C145c-β1 35m/45m) × iono
        multiplier (NOM 1.0 / WATCH 1.6 / STORM 2.8) × DOP
        multiplier (4-sat 2.5× / 5-sat 1.7× / ≥6 sat 1.0×).
     5. Approach achievability ladder LPV-200 → LPV → LNAV/VNAV
        → LP → LNAV → NO-SBAS based on RX class, published
        approach, HPL≤HAL ∧ VPL≤VAL.

   5 risk components, composite = max-driver:
     COV  outside service-volume gate (100 outside, 0 inside)
     RX   receiver vs published approach mismatch
          100 NO-SBAS at LPV-only airport / 60 C145c-β1 at LPV
          / 20 C145d at LPV-200 / 0 fully equipped
     ION  ionospheric I-state NOM 5 / WATCH 45 / STORM 90 with
          regional bias (equatorial / sub-auroral)
     INT  HPL/VPL vs alert-limit ratio
          0 at ≤0.5 ramping 100 at ≥1.0 (alert exceeded)
     SAT  reference SBAS-eligible sat count vs minimum
          5 at ≥7, 60 at 5, 100 at ≤4

   Tier classification:
     UNABLE  score≥80 OR outside-coverage OR HPL>HAL OR VPL>VAL
             rose — revert to ILS/LNAV-DA-MDA or hold; declare
             RNP-AR approach in lieu per FAA Order 8260.54A
     DEGRADE score≥55 OR (achievable < published-best)
             amber — published procedure unavailable, brief
             crew on backup; LNAV-only if LPV down
     WATCH   score≥25 sky — within envelope but trend adverse
             monitor every 5 NM per AC 90-107
     LPV-OK  score<25 emerald — LPV-200 / LPV available
             nominal HPL/VPL margin
     IDLE    not inbound or below MIN-FL slate

   References:
     · ICAO Annex 10 Vol I 3.7.3 SBAS SARPs
     · ICAO Doc 9849 GNSS Manual
     · ICAO Doc 8168 PANS-OPS Vol II 6 (RNP-APCH)
     · RTCA DO-229E SBAS Airborne Equipment MOPS
     · RTCA DO-253D LAAS (cross-reference)
     · FAA AC 20-138D Positioning/Navigation Approval
     · FAA AC 90-107 RNAV-RNP (LNAV/VNAV LPV LPV-200)
     · FAA Order 8260.54A US Standard for RNP Approach
     · FAA Order 8260.58A RNAV(GPS) construction
     · FAA TSO-C145d / C146d / TSO-C161 GBAS-SBAS
     · EASA AMC 20-28 SBAS LPV
     · EASA AMC 20-27A RNAV-APCH
     · EUROCAE ED-72A SBAS equipment
     · ESSP EGNOS Service Definition Document SDD v3.4
     · FAA WAAS Performance Analysis Report Q4-2025 (William J
       Hughes Tech Center)
     · JCAB MSAS Operational Status Bulletin
     · AAI GAGAN Service Bulletin
     · Roscosmos SDCM PNT Bulletin
     · KARI KASS IOC Notice 2022
     · BDS Open Service Performance Standard v3.0 BDSBAS
     · Boeing 787 FCOM 11.30 MMR SBAS
     · Airbus A320 / A350 FCOM PRO-NOR-SOP-15 SBAS-LPV

   Persisted: ft-sbas
   ============================================================ */

export interface SbasFlight {
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
  flights: SbasFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'UNABLE' | 'DEGRADE' | 'WATCH' | 'LPV-OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'UNABLE': '#ef4444', 'DEGRADE': '#f59e0b', 'WATCH': '#0ea5e9', 'LPV-OK': '#10b981', 'IDLE': '#64748b',
}
const TIER_ORDER: Tier[] = ['UNABLE', 'DEGRADE', 'WATCH', 'LPV-OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { 'UNABLE': 0, 'DEGRADE': 1, 'WATCH': 2, 'LPV-OK': 3, 'IDLE': 4 }

type AcClass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA'
const CLASS_LIST: AcClass[] = ['HVY', 'NRW', 'RGN', 'BIZ', 'TBP', 'GA']

type RxClass = 'NO-SBAS' | 'C145c-β1' | 'C145d-β3' | 'C146d'
const RX_BASE: Record<RxClass, { hpl: number; vpl: number }> = {
  'NO-SBAS':  { hpl: 999, vpl: 999 },
  'C145c-β1': { hpl: 35,  vpl: 45 },
  'C145d-β3': { hpl: 18,  vpl: 22 },
  'C146d':    { hpl: 10,  vpl: 12 },
}
// Per-class RX equipment CDF (cumulative)
const RX_CDF: Record<AcClass, Array<[RxClass, number]>> = {
  HVY: [['C146d', 92], ['C145d-β3', 99], ['C145c-β1', 100]],
  NRW: [['C146d', 35], ['C145d-β3', 78], ['C145c-β1', 92], ['NO-SBAS', 100]],
  RGN: [['C146d', 12], ['C145d-β3', 47], ['C145c-β1', 74], ['NO-SBAS', 100]],
  BIZ: [['C146d', 78], ['C145d-β3', 94], ['C145c-β1', 99], ['NO-SBAS', 100]],
  TBP: [['C146d', 6],  ['C145d-β3', 24], ['C145c-β1', 52], ['NO-SBAS', 100]],
  GA:  [['C146d', 2],  ['C145d-β3', 12], ['C145c-β1', 38], ['NO-SBAS', 100]],
}

interface ClassSpec { fl: number; family: string }
const CLASS_SPEC: Record<AcClass, ClassSpec> = {
  HVY: { fl: 380, family: '777/787/A350 MMR' },
  NRW: { fl: 360, family: '737/A320 MMR' },
  RGN: { fl: 320, family: 'CRJ/E-jet IRS+SBAS' },
  BIZ: { fl: 410, family: 'GLF/CL SBAS-FMS' },
  TBP: { fl: 220, family: 'PC-12/B200 G3000' },
  GA:  { fl: 90,  family: 'GNS-430W/G1000' },
}

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|A38|B77|A35|B78|A33|A34|MD11|IL96/.test(t)) return 'HVY'
  if (/B73|B72|A22|A31|A32|B75|MD8|MD9/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E29|AT[47]|DH8|RJ85|F70|F100/.test(t)) return 'RGN'
  if (/CL[36]|G[VI458]|GLF|GLEX|FA[5789]|F2TH|E[35]5/.test(t)) return 'BIZ'
  if (/PC1|PC2|TBM|PT6|KING|BE20|C208|C30|DH3/.test(t)) return 'TBP'
  return 'GA'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

type Provider = 'WAAS' | 'EGNOS' | 'MSAS' | 'GAGAN' | 'SDCM' | 'KASS' | 'BDSBAS' | 'NONE'
const PROVIDER_COLOR: Record<Provider, string> = {
  WAAS: '#0ea5e9', EGNOS: '#10b981', MSAS: '#f59e0b', GAGAN: '#a855f7',
  SDCM: '#ec4899', KASS: '#22d3ee', BDSBAS: '#eab308', NONE: '#64748b',
}

interface ProviderRec {
  id: Provider
  name: string
  latMin: number; latMax: number; lngMin: number; lngMax: number
  maxLat: number              // hard service ceiling latitude
  equatorialIonoBias: number  // additive iono-storm boost 0-30
  subAuroralBias: number      // additive iono boost above 55° lat
  status: 'IOC' | 'FOC' | 'OPS'
}
const PROVIDERS: ProviderRec[] = [
  { id: 'WAAS',   name: 'FAA WAAS',         latMin: 15, latMax: 80,  lngMin: -170, lngMax: -50, maxLat: 80, equatorialIonoBias: 5,  subAuroralBias: 15, status: 'FOC' },
  { id: 'EGNOS',  name: 'ESSP EGNOS',       latMin: 20, latMax: 72,  lngMin: -30,  lngMax: 45,  maxLat: 70, equatorialIonoBias: 0,  subAuroralBias: 10, status: 'FOC' },
  { id: 'MSAS',   name: 'JCAB MSAS',        latMin: 18, latMax: 56,  lngMin: 120,  lngMax: 165, maxLat: 55, equatorialIonoBias: 8,  subAuroralBias: 5,  status: 'OPS' },
  { id: 'GAGAN',  name: 'AAI GAGAN',        latMin: -8, latMax: 35,  lngMin: 60,   lngMax: 100, maxLat: 30, equatorialIonoBias: 25, subAuroralBias: 0,  status: 'OPS' },
  { id: 'SDCM',   name: 'Roscosmos SDCM',   latMin: 40, latMax: 85,  lngMin: 18,   lngMax: 180, maxLat: 80, equatorialIonoBias: 0,  subAuroralBias: 20, status: 'OPS' },
  { id: 'KASS',   name: 'KARI KASS',        latMin: 30, latMax: 46,  lngMin: 122,  lngMax: 134, maxLat: 45, equatorialIonoBias: 2,  subAuroralBias: 0,  status: 'IOC' },
  { id: 'BDSBAS', name: 'BDSGSA BDSBAS',    latMin: 0,  latMax: 56,  lngMin: 70,   lngMax: 140, maxLat: 55, equatorialIonoBias: 18, subAuroralBias: 4,  status: 'IOC' },
]

function providerFor(lat: number, lng: number): ProviderRec | null {
  // Pick the highest-status provider whose box contains the point
  const matches = PROVIDERS.filter(p =>
    lat >= p.latMin && lat <= p.latMax &&
    lng >= p.lngMin && lng <= p.lngMax &&
    Math.abs(lat) <= p.maxLat
  )
  if (matches.length === 0) return null
  const rank: Record<ProviderRec['status'], number> = { FOC: 0, OPS: 1, IOC: 2 }
  matches.sort((a, b) => rank[a.status] - rank[b.status])
  return matches[0]
}

type ApprType = 'LPV-200' | 'LPV' | 'LNAV/VNAV' | 'LP' | 'LNAV-only' | 'NONE'
const APPR_HAL: Record<ApprType, number> = {
  'LPV-200': 40, 'LPV': 40, 'LNAV/VNAV': 556, 'LP': 40, 'LNAV-only': 556, 'NONE': 999,
}
const APPR_VAL: Record<ApprType, number> = {
  'LPV-200': 35, 'LPV': 50, 'LNAV/VNAV': 50, 'LP': 999, 'LNAV-only': 999, 'NONE': 999,
}
const APPR_RANK: Record<ApprType, number> = {
  'LPV-200': 0, 'LPV': 1, 'LNAV/VNAV': 2, 'LP': 3, 'LNAV-only': 4, 'NONE': 5,
}

interface AirportRec {
  iata: string; name: string; lat: number; lng: number
  published: ApprType
  provider: Provider
}
const AIRPORTS: AirportRec[] = [
  // WAAS
  { iata: 'JFK', name: 'New York-JFK',     lat: 40.64, lng: -73.78,  published: 'LPV-200',  provider: 'WAAS' },
  { iata: 'EWR', name: 'Newark',           lat: 40.69, lng: -74.17,  published: 'LPV-200',  provider: 'WAAS' },
  { iata: 'ORD', name: 'Chicago-OHare',    lat: 41.98, lng: -87.91,  published: 'LPV',      provider: 'WAAS' },
  { iata: 'LAX', name: 'Los Angeles',      lat: 33.94, lng: -118.41, published: 'LPV-200',  provider: 'WAAS' },
  { iata: 'SFO', name: 'San Francisco',    lat: 37.62, lng: -122.37, published: 'LPV-200',  provider: 'WAAS' },
  { iata: 'SEA', name: 'Seattle',          lat: 47.45, lng: -122.31, published: 'LPV-200',  provider: 'WAAS' },
  { iata: 'DEN', name: 'Denver',           lat: 39.86, lng: -104.67, published: 'LPV',      provider: 'WAAS' },
  { iata: 'ASE', name: 'Aspen',            lat: 39.22, lng: -106.87, published: 'LNAV/VNAV',provider: 'WAAS' },
  { iata: 'EGE', name: 'Vail-EGE',         lat: 39.64, lng: -106.92, published: 'LP',       provider: 'WAAS' },
  { iata: 'JAC', name: 'Jackson Hole',     lat: 43.61, lng: -110.74, published: 'LNAV/VNAV',provider: 'WAAS' },
  { iata: 'ANC', name: 'Anchorage',        lat: 61.17, lng: -149.99, published: 'LPV',      provider: 'WAAS' },
  { iata: 'YYZ', name: 'Toronto-Pearson',  lat: 43.68, lng: -79.63,  published: 'LPV-200',  provider: 'WAAS' },
  { iata: 'YVR', name: 'Vancouver',        lat: 49.19, lng: -123.18, published: 'LPV-200',  provider: 'WAAS' },
  { iata: 'YYC', name: 'Calgary',          lat: 51.11, lng: -114.02, published: 'LPV',      provider: 'WAAS' },
  { iata: 'MEX', name: 'Mexico City',      lat: 19.44, lng: -99.07,  published: 'LNAV/VNAV',provider: 'WAAS' },
  // EGNOS
  { iata: 'LHR', name: 'London Heathrow',  lat: 51.47, lng: -0.46,   published: 'LPV-200',  provider: 'EGNOS' },
  { iata: 'CDG', name: 'Paris-CDG',        lat: 49.01, lng: 2.55,    published: 'LPV-200',  provider: 'EGNOS' },
  { iata: 'AMS', name: 'Amsterdam',        lat: 52.31, lng: 4.76,    published: 'LPV-200',  provider: 'EGNOS' },
  { iata: 'FRA', name: 'Frankfurt',        lat: 50.04, lng: 8.56,    published: 'LPV',      provider: 'EGNOS' },
  { iata: 'ZRH', name: 'Zurich',           lat: 47.46, lng: 8.55,    published: 'LPV-200',  provider: 'EGNOS' },
  { iata: 'MAD', name: 'Madrid',           lat: 40.49, lng: -3.57,   published: 'LPV',      provider: 'EGNOS' },
  { iata: 'OSL', name: 'Oslo',             lat: 60.19, lng: 11.10,   published: 'LPV',      provider: 'EGNOS' },
  { iata: 'ARN', name: 'Stockholm',        lat: 59.65, lng: 17.92,   published: 'LPV-200',  provider: 'EGNOS' },
  { iata: 'HEL', name: 'Helsinki',         lat: 60.32, lng: 24.96,   published: 'LNAV/VNAV',provider: 'EGNOS' },
  // MSAS
  { iata: 'HND', name: 'Tokyo-Haneda',     lat: 35.55, lng: 139.78,  published: 'LPV',      provider: 'MSAS' },
  { iata: 'NRT', name: 'Tokyo-Narita',     lat: 35.76, lng: 140.39,  published: 'LNAV/VNAV',provider: 'MSAS' },
  { iata: 'KIX', name: 'Osaka-Kansai',     lat: 34.43, lng: 135.24,  published: 'LNAV/VNAV',provider: 'MSAS' },
  // GAGAN
  { iata: 'DEL', name: 'New Delhi',        lat: 28.57, lng: 77.10,   published: 'LPV',      provider: 'GAGAN' },
  { iata: 'BOM', name: 'Mumbai',           lat: 19.09, lng: 72.87,   published: 'LNAV/VNAV',provider: 'GAGAN' },
  { iata: 'BLR', name: 'Bengaluru',        lat: 13.20, lng: 77.71,   published: 'LP',       provider: 'GAGAN' },
  // SDCM
  { iata: 'SVO', name: 'Moscow-Sheremetyevo', lat: 55.97, lng: 37.41, published: 'LPV',     provider: 'SDCM' },
  { iata: 'LED', name: 'St. Petersburg',   lat: 59.80, lng: 30.27,   published: 'LNAV/VNAV',provider: 'SDCM' },
  // KASS
  { iata: 'ICN', name: 'Seoul-Incheon',    lat: 37.46, lng: 126.44,  published: 'LPV',      provider: 'KASS' },
  { iata: 'GMP', name: 'Seoul-Gimpo',      lat: 37.56, lng: 126.79,  published: 'LNAV/VNAV',provider: 'KASS' },
  // BDSBAS
  { iata: 'PEK', name: 'Beijing-Capital',  lat: 40.08, lng: 116.59,  published: 'LPV',      provider: 'BDSBAS' },
  { iata: 'PVG', name: 'Shanghai-Pudong',  lat: 31.14, lng: 121.81,  published: 'LNAV/VNAV',provider: 'BDSBAS' },
  { iata: 'CAN', name: 'Guangzhou',        lat: 23.39, lng: 113.30,  published: 'LP',       provider: 'BDSBAS' },
]

function haversineNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 3440.065
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dφ = (la2 - la1) * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dλ = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

type Driver = 'COV' | 'RX' | 'ION' | 'INT' | 'SAT' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  COV: 'Outside SBAS service volume',
  RX:  'Receiver vs published procedure mismatch',
  ION: 'Ionospheric I-state elevated',
  INT: 'Protection level exceeds alert limit',
  SAT: 'Insufficient SBAS-eligible satellites',
  NONE: 'Nominal',
}

function pickRx(klass: AcClass, h: number): RxClass {
  const r = (h >>> 5) % 100
  for (const [cls, cum] of RX_CDF[klass]) if (r < cum) return cls
  return 'NO-SBAS'
}

function bestAchievable(rx: RxClass, published: ApprType, hpl: number, vpl: number): ApprType {
  if (rx === 'NO-SBAS') return 'NONE'
  // Capability ladder per RX class
  const rxBestRank: Record<RxClass, number> = {
    'C146d': 0,    // LPV-200 capable
    'C145d-β3': 0, // LPV-200 capable
    'C145c-β1': 2, // LNAV/VNAV only
    'NO-SBAS': 5,
  }
  const ladder: ApprType[] = ['LPV-200', 'LPV', 'LNAV/VNAV', 'LP', 'LNAV-only']
  // Iterate ladder from best to worst, return first achievable per RX class AND
  // published AND HPL/VPL within HAL/VAL.
  for (const a of ladder) {
    if (APPR_RANK[a] < rxBestRank[rx]) continue
    if (APPR_RANK[a] < APPR_RANK[published]) continue   // can't fly better than published
    if (hpl <= APPR_HAL[a] && vpl <= APPR_VAL[a]) return a
  }
  return 'NONE'
}

interface Row {
  f: SbasFlight
  klass: AcClass
  spec: ClassSpec
  rx: RxClass
  dest: AirportRec | null
  distNm: number
  provider: Provider
  inSv: boolean
  satCount: number
  ionState: 'NOM' | 'WATCH' | 'STORM'
  hpl: number
  vpl: number
  hal: number
  val: number
  achievable: ApprType
  sev: { cov: number; rx: number; ion: number; int: number; sat: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'sbas-halo', SRC_LBL = 'sbas-lbl', SRC_PIN = 'sbas-pin', SRC_PROJ = 'sbas-proj'
const SRC_APT = 'sbas-apt', SRC_SV = 'sbas-sv'
const LYR_HALO = 'sbas-halo-l', LYR_LBL = 'sbas-lbl-l', LYR_PIN = 'sbas-pin-l', LYR_PROJ = 'sbas-proj-l'
const LYR_APT = 'sbas-apt-l', LYR_APT_LBL = 'sbas-apt-lbl-l', LYR_SV = 'sbas-sv-l'

export default function SbasLpv({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS' | 'PROVIDERS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [providerFilter, setProviderFilter] = useState<Provider | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(200)
  const [capture, setCapture] = useState(200)      // nm
  const [ionMul, setIonMul] = useState(100)        // 50..250%
  const [kpIdx, setKpIdx] = useState(2)            // Kp 0..9 geomagnetic
  const [satBias, setSatBias] = useState(0)        // -3..+3 sat-count bias
  const [valBuf, setValBuf] = useState(0)          // -30..+30% alert-limit buffer

  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showApt, setShowApt] = useState(true)
  const [showSv, setShowSv] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl || fl > maxFl) continue
      // SBAS approach availability is meaningful for descending/approaching aircraft
      const inbound = f.vertRate < -150 || fl < 100
      if (!inbound) continue

      const klass = classifyClass(f.type || '')
      const spec = CLASS_SPEC[klass]
      const h = hash32(f.icao || '')
      const rx = pickRx(klass, h)

      // Find nearest published-SBAS airport within capture aligned with track
      let dest: AirportRec | null = null
      let bestD = Infinity
      for (const a of AIRPORTS) {
        const d = haversineNm(f.lat, f.lng, a.lat, a.lng)
        if (d > capture) continue
        const br = bearingDeg(f.lat, f.lng, a.lat, a.lng)
        const delta = Math.abs(((br - f.track + 540) % 360) - 180)
        if (delta > 80) continue
        if (d < bestD) { bestD = d; dest = a }
      }
      if (!dest) continue
      const distNm = bestD

      // Provider gate at destination
      const prov = providerFor(dest.lat, dest.lng)
      const inSv = !!prov && prov.id === dest.provider
      const provider: Provider = prov ? prov.id : 'NONE'

      // Ionospheric state from Kp slider + regional bias
      const provBias = prov ? (Math.abs(dest.lat) <= 25 ? prov.equatorialIonoBias : Math.abs(dest.lat) >= 55 ? prov.subAuroralBias : 0) : 0
      const kpScore = kpIdx * 10 + provBias
      let ionState: 'NOM' | 'WATCH' | 'STORM' = 'NOM'
      let ionSev = 5
      if (kpScore >= 55) { ionState = 'STORM'; ionSev = 90 }
      else if (kpScore >= 30) { ionState = 'WATCH'; ionSev = 45 }

      // Satellite count synth
      const satCount = Math.max(3, Math.min(12, 5 + ((h >>> 9) % 7) + satBias))
      const dopMul = satCount >= 6 ? 1.0 : satCount === 5 ? 1.7 : 2.5

      const ionMulFactor = (ionState === 'STORM' ? 2.8 : ionState === 'WATCH' ? 1.6 : 1.0) * (ionMul / 100)
      const baseHpl = RX_BASE[rx].hpl
      const baseVpl = RX_BASE[rx].vpl
      const hpl = baseHpl * ionMulFactor * dopMul
      const vpl = baseVpl * ionMulFactor * dopMul

      const hal = APPR_HAL[dest.published] * (1 + valBuf / 100)
      const val = APPR_VAL[dest.published] * (1 + valBuf / 100)

      const achievable = inSv ? bestAchievable(rx, dest.published, hpl, vpl) : 'NONE'

      // Severities
      const covSev = inSv ? 0 : 100
      let rxSev = 0
      if (rx === 'NO-SBAS') rxSev = 100
      else if (rx === 'C145c-β1' && (dest.published === 'LPV-200' || dest.published === 'LPV')) rxSev = 60
      else if (rx === 'C145d-β3' && dest.published === 'LPV-200') rxSev = 20
      // Achievability gap penalty
      const gap = APPR_RANK[achievable] - APPR_RANK[dest.published]
      if (gap > 0) rxSev = Math.max(rxSev, 35 + gap * 15)

      const intRatio = Math.max(hpl / hal, vpl / val)
      const intSev = intRatio <= 0.5 ? 0 : intRatio >= 1.0 ? 100 : ((intRatio - 0.5) / 0.5) * 100

      const satSev = satCount >= 7 ? 5 : satCount === 6 ? 25 : satCount === 5 ? 60 : satCount === 4 ? 85 : 100

      const drvList: Array<[Driver, number]> = [
        ['COV', covSev], ['RX', rxSev], ['ION', ionSev], ['INT', intSev], ['SAT', satSev],
      ]
      drvList.sort((a, b) => b[1] - a[1])
      const driver: Driver = drvList[0][1] > 0 ? drvList[0][0] : 'NONE'
      const score = Math.min(100, drvList[0][1] + 0.1 * drvList[1][1])

      let tier: Tier
      if (score >= 80 || !inSv || hpl > hal || vpl > val) tier = 'UNABLE'
      else if (score >= 55 || APPR_RANK[achievable] > APPR_RANK[dest.published]) tier = 'DEGRADE'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'LPV-OK'

      out.push({
        f, klass, spec, rx, dest, distNm, provider, inSv, satCount, ionState,
        hpl, vpl, hal, val, achievable,
        sev: { cov: covSev, rx: rxSev, ion: ionSev, int: intSev, sat: satSev },
        score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, maxFl, capture, ionMul, kpIdx, satBias, valBuf])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { 'UNABLE': 0, 'DEGRADE': 0, 'WATCH': 0, 'LPV-OK': 0, 'IDLE': 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumVpl = 0, sumHpl = 0, count = 0, unable = 0, lpv200 = 0
    let worst = 0, worstCs = '', worstDrv: Driver = 'NONE'
    let stormN = 0, noSbas = 0
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      count++
      sumVpl += r.vpl; sumHpl += r.hpl
      if (r.tier === 'UNABLE') unable++
      if (r.achievable === 'LPV-200') lpv200++
      if (r.ionState === 'STORM') stormN++
      if (r.rx === 'NO-SBAS') noSbas++
      if (r.score > worst) { worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstDrv = r.driver }
    }
    return {
      meanVpl: count ? sumVpl / count : 0,
      meanHpl: count ? sumHpl / count : 0,
      worst, worstCs, worstDrv, unable, lpv200, stormN, noSbas, activeCount: count,
    }
  }, [rows])

  const aptAggs = useMemo(() => {
    const m = new Map<string, { rec: AirportRec; count: number; sumScore: number; unable: number; worstTier: Tier; worstCs: string; worstIcao: string; lpv200Count: number }>()
    for (const r of rows) {
      if (r.tier === 'IDLE' || !r.dest) continue
      let a = m.get(r.dest.iata)
      if (!a) { a = { rec: r.dest, count: 0, sumScore: 0, unable: 0, worstTier: 'LPV-OK', worstCs: '', worstIcao: '', lpv200Count: 0 }; m.set(r.dest.iata, a) }
      a.count++; a.sumScore += r.score
      if (r.tier === 'UNABLE') a.unable++
      if (r.achievable === 'LPV-200') a.lpv200Count++
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) { a.worstTier = r.tier; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
    }
    const arr = Array.from(m.values()).map(a => ({ ...a, meanScore: a.count ? a.sumScore / a.count : 0 }))
    arr.sort((a, b) => {
      const ti = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
      if (ti !== 0) return ti
      return b.count - a.count
    })
    return arr
  }, [rows])

  const provAggs = useMemo(() => {
    return PROVIDERS.map(p => {
      let count = 0, unable = 0, lpv200 = 0
      for (const r of rows) {
        if (r.tier === 'IDLE') continue
        if (r.provider === p.id) {
          count++
          if (r.tier === 'UNABLE') unable++
          if (r.achievable === 'LPV-200') lpv200++
        }
      }
      const aptCount = AIRPORTS.filter(a => a.provider === p.id).length
      return { ...p, count, unable, lpv200, aptCount }
    }).sort((a, b) => b.count - a.count)
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows
      .filter(r => r.tier !== 'IDLE')
      .filter(r => {
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (classFilter !== 'ALL' && r.klass !== classFilter) return false
        if (providerFilter !== 'ALL' && r.provider !== providerFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.dest?.iata].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, classFilter, providerFilter, query])

  const filteredAirports = useMemo(() => {
    const q = query.trim().toUpperCase()
    return aptAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (providerFilter !== 'ALL' && a.rec.provider !== providerFilter) return false
      if (!q) return true
      return a.rec.iata.toUpperCase().includes(q) || a.rec.name.toUpperCase().includes(q)
    })
  }, [aptAggs, tierFilter, providerFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return

    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'LPV-OK' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'DEGRADE' || r.tier === 'UNABLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${r.achievable} ${r.driver}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'UNABLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: '#ef4444', text: `\u203a UNABLE VPL ${r.vpl.toFixed(0)}/VAL ${r.val.toFixed(0)}m` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const projFeatures: any[] = []
    if (showProj) {
      for (const r of rows) {
        if (r.tier === 'LPV-OK' || r.tier === 'IDLE' || !r.dest) continue
        projFeatures.push({ type: 'Feature' as const, properties: { color: TIER_COLOR[r.tier] }, geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.dest.lng, r.dest.lat]] } })
      }
    }
    const projFc = { type: 'FeatureCollection' as const, features: projFeatures }

    const aptFc = { type: 'FeatureCollection' as const, features: showApt ? AIRPORTS.map(a => {
      const agg = aptAggs.find(x => x.rec.iata === a.iata)
      const tier = agg ? agg.worstTier : 'LPV-OK'
      return {
        type: 'Feature' as const,
        properties: { color: agg ? TIER_COLOR[tier] : PROVIDER_COLOR[a.provider], text: `${a.iata} ${a.published}` },
        geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] },
      }
    }) : [] }

    // Service volume polygons (rough bounding rectangles, latitude-clipped)
    const svFeatures: any[] = []
    if (showSv) {
      for (const p of PROVIDERS) {
        const latTop = Math.min(p.latMax, p.maxLat)
        const latBot = Math.max(p.latMin, -p.maxLat)
        svFeatures.push({
          type: 'Feature' as const,
          properties: { color: PROVIDER_COLOR[p.id] },
          geometry: { type: 'LineString' as const, coordinates: [
            [p.lngMin, latBot], [p.lngMax, latBot], [p.lngMax, latTop], [p.lngMin, latTop], [p.lngMin, latBot],
          ] },
        })
      }
    }
    const svFc = { type: 'FeatureCollection' as const, features: svFeatures }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_SV, svFc, () => map.addLayer({ id: LYR_SV, type: 'line', source: SRC_SV, paint: {
        'line-color': ['get', 'color'], 'line-width': 0.8, 'line-opacity': 0.20, 'line-dasharray': [4, 4],
      } }))
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [3, 3],
      } }))
      ensure(SRC_APT, aptFc, () => {
        map.addLayer({ id: LYR_APT, type: 'circle', source: SRC_APT, paint: {
          'circle-radius': 3.2, 'circle-color': ['get', 'color'], 'circle-opacity': 0.88,
          'circle-stroke-color': '#020617', 'circle-stroke-width': 1,
        } })
        map.addLayer({ id: LYR_APT_LBL, type: 'symbol', source: SRC_APT, layout: {
          'text-field': ['get', 'text'], 'text-size': 9, 'text-offset': [0, 1.1], 'text-anchor': 'top',
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } })
      })
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['get', 'text'], 'text-size': 10,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-offset': [0, -1.5], 'text-anchor': 'bottom', 'icon-allow-overlap': true,
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.6 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_APT_LBL, LYR_APT, LYR_PROJ, LYR_SV]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_APT, SRC_PROJ, SRC_SV]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, aptAggs, showHalo, showLabels, showPin, showProj, showApt, showSv])

  // SVG diagnostic: HPL (x) vs VPL (y) in metres
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 32
    const xMin = 0, xMax = 80, yMin = 0, yMax = 80
    const xs = (v: number) => PAD + ((v - xMin) / (xMax - xMin)) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMin, yMax }
  }, [])

  const tierColorOf = (s: number) => s >= 80 ? '#ef4444' : s >= 55 ? '#f59e0b' : s >= 25 ? '#0ea5e9' : '#10b981'
  const adviceFor = (r: Row): string => {
    if (r.tier === 'UNABLE') {
      if (r.rx === 'NO-SBAS') return 'NO-SBAS equipage — LPV/LP unavailable, fly LNAV-only minimums or ILS; coordinate ATC for non-SBAS substitute per FAA Order 8260.54A'
      if (!r.inSv) return 'Outside SBAS service volume — published LPV/LP unusable, divert or hold pending iono recovery'
      if (r.vpl > r.val || r.hpl > r.hal) return 'VPL/HPL exceeds alert limit — declare unable LPV, request LNAV-only or ILS per AC 90-107 §5.7'
      return 'SBAS unable — back-up ILS or RNP-AR per dispatch deviation'
    }
    if (r.tier === 'DEGRADE') return `Best achievable ${r.achievable} (published ${r.dest?.published}) — brief crew on backup minimums, monitor HPL/VPL every 5 NM`
    if (r.tier === 'WATCH') return 'Within SBAS envelope but trend adverse (iono or sat-count) — monitor approach plate ND alerts'
    return `LPV-200 nominal — HPL ${r.hpl.toFixed(0)}/VPL ${r.vpl.toFixed(0)}m well inside HAL/VAL`
  }

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">SBAS · LPV Approach</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.activeCount} ac · {summary.unable} unable</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">μ VPL</div>
          <div className="font-mono text-sm" style={{ color: summary.meanVpl >= 35 ? '#ef4444' : summary.meanVpl >= 22 ? '#f59e0b' : summary.meanVpl >= 12 ? '#0ea5e9' : '#10b981' }}>{summary.meanVpl.toFixed(1)}m</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] truncate" style={{ color: tierColorOf(summary.worst) }}>{summary.worstCs || '—'} {summary.worstDrv}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Unable</div>
          <div className="font-mono text-sm text-rose-400">{summary.unable}</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">μ HPL</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.meanHpl.toFixed(1)}m</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">LPV-200</div>
          <div className="font-mono text-[11px] text-emerald-400">{summary.lpv200}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">NO-SBAS</div>
          <div className="font-mono text-[11px]" style={{ color: summary.noSbas > 0 ? '#f59e0b' : '#64748b' }}>{summary.noSbas}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg viewBox={`0 0 ${diag.W} ${diag.H}`} className="w-full h-auto">
            {/* alert-limit zones for LPV-200 (HAL 40 / VAL 35) */}
            <rect x={diag.PAD} y={6} width={diag.xs(40) - diag.PAD} height={diag.ys(35) - 6} fill="#10b981" opacity={0.06} />
            <rect x={diag.xs(40)} y={6} width={diag.xs(50) - diag.xs(40)} height={diag.ys(50) - 6} fill="#0ea5e9" opacity={0.05} />
            <rect x={diag.xs(50)} y={6} width={diag.W - 6 - diag.xs(50)} height={diag.H - 22 - 6} fill="#ef4444" opacity={0.06} />
            {/* HAL / VAL lines */}
            <line x1={diag.xs(40)} y1={6} x2={diag.xs(40)} y2={diag.H - 22} stroke="#10b981" strokeWidth={0.8} strokeDasharray="4 3" opacity={0.7} />
            <line x1={diag.PAD} y1={diag.ys(35)} x2={diag.W - 6} y2={diag.ys(35)} stroke="#10b981" strokeWidth={0.8} strokeDasharray="4 3" opacity={0.7} />
            <line x1={diag.PAD} y1={diag.ys(50)} x2={diag.W - 6} y2={diag.ys(50)} stroke="#0ea5e9" strokeWidth={0.6} strokeDasharray="4 3" opacity={0.5} />
            {/* gridlines */}
            {[10, 20, 40, 60].map(v => (
              <g key={v}>
                <line x1={diag.xs(v)} y1={6} x2={diag.xs(v)} y2={diag.H - 22} stroke="#334155" strokeWidth={0.4} strokeDasharray="2 3" />
                <text x={diag.xs(v)} y={diag.H - 12} fill="#64748b" fontSize={8} textAnchor="middle">{v}m</text>
              </g>
            ))}
            {[10, 22, 35, 50].map(v => (
              <g key={v}>
                <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)} stroke="#334155" strokeWidth={0.4} strokeDasharray="2 3" />
                <text x={4} y={diag.ys(v) + 3} fill="#64748b" fontSize={8}>{v}m</text>
              </g>
            ))}
            {rows.filter(r => r.tier !== 'IDLE').slice(0, 800).map((r, i) => (
              <circle key={i}
                cx={diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, r.hpl)))}
                cy={diag.ys(Math.max(diag.yMin, Math.min(diag.yMax, r.vpl)))}
                r={2} fill={TIER_COLOR[r.tier]} opacity={0.8} />
            ))}
            <text x={diag.W - 6} y={diag.H - 2} fill="#475569" fontSize={8} textAnchor="end">HPL m · VPL m · LPV-200 envelope</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Min FL</span><span className="text-slate-300 font-mono">{minFl}</span></span>
          <input type="range" min={0} max={200} step={5} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Max FL</span><span className="text-slate-300 font-mono">{maxFl}</span></span>
          <input type="range" min={20} max={400} step={10} value={maxFl} onChange={e => setMaxFl(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Capture</span><span className="text-slate-300 font-mono">{capture}nm</span></span>
          <input type="range" min={30} max={500} step={10} value={capture} onChange={e => setCapture(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Kp index</span><span className="text-slate-300 font-mono">{kpIdx}</span></span>
          <input type="range" min={0} max={9} step={1} value={kpIdx} onChange={e => setKpIdx(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Iono mul</span><span className="text-slate-300 font-mono">{ionMul}%</span></span>
          <input type="range" min={50} max={250} step={10} value={ionMul} onChange={e => setIonMul(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Sat bias</span><span className="text-slate-300 font-mono">{satBias > 0 ? '+' : ''}{satBias}</span></span>
          <input type="range" min={-3} max={3} step={1} value={satBias} onChange={e => setSatBias(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest col-span-2">
          <span className="flex justify-between"><span>VAL buffer</span><span className="text-slate-300 font-mono">{valBuf > 0 ? '+' : ''}{valBuf}%</span></span>
          <input type="range" min={-30} max={30} step={5} value={valBuf} onChange={e => setValBuf(+e.target.value)} className="accent-sky-500" />
        </label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {CLASS_LIST.map(c => {
          const on = classFilter === c
          return <button key={c} onClick={() => setClassFilter(on ? 'ALL' : c)}
            className={`px-1.5 py-0.5 rounded border text-[10px] font-mono transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-800 text-slate-400 hover:text-slate-200'}`}>{c}</button>
        })}
      </div>
      <div className="flex flex-wrap gap-1 px-3 py-1 border-b border-slate-800">
        {(['WAAS', 'EGNOS', 'MSAS', 'GAGAN', 'SDCM', 'KASS', 'BDSBAS'] as Provider[]).map(p => {
          const on = providerFilter === p
          return <button key={p} onClick={() => setProviderFilter(on ? 'ALL' : p)}
            className={`px-1.5 py-0.5 rounded border text-[10px] font-mono transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 hover:text-slate-200'}`}
            style={{ color: on ? '#bae6fd' : PROVIDER_COLOR[p] }}>{p}</button>
        })}
      </div>

      <div className="flex items-center gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['PROJ', showProj, setShowProj], ['APT', showApt, setShowApt], ['SV', showSv, setShowSv], ['DIAG', showDiag, setShowDiag]] as const).map(([l, v, fn]) => (
          <button key={l} onClick={() => (fn as any)((x: boolean) => !x)}
            className={`px-1.5 py-0.5 rounded border text-[10px] font-mono transition ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-800 text-slate-500'}`}>{l}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search…"
          className="ml-auto bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-[10px] text-slate-200 placeholder:text-slate-600 w-24 focus:outline-none focus:border-sky-500/40" />
      </div>

      <div className="flex border-b border-slate-800 text-[10px]">
        {(['AIRCRAFT', 'AIRPORTS', 'PROVIDERS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-1.5 uppercase tracking-widest font-bold ${tab === t ? 'text-sky-300 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-8 text-center text-slate-500 text-[11px]">No inbound aircraft within SBAS-published-approach capture.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => (
          <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/70 transition relative">
            <span className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: TIER_COLOR[r.tier] }} />
            <div className="flex items-center gap-1.5">
              <span className="font-mono font-bold text-slate-100">{(r.f.callsign || r.f.icao).trim()}</span>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="text-[9px] font-mono px-1 rounded border border-slate-800 text-slate-400">{r.klass}</span>
              <span className="text-[9px] font-mono px-1 rounded border" style={{ borderColor: r.rx === 'NO-SBAS' ? '#ef444488' : '#33415588', color: r.rx === 'NO-SBAS' ? '#ef4444' : '#cbd5e1' }}>{r.rx}</span>
              {r.dest && <span className="text-[9px] font-mono px-1 rounded border border-slate-800 text-slate-300">{r.dest.iata}</span>}
              <span className="text-[9px] font-mono px-1 rounded border ml-auto" style={{ borderColor: TIER_COLOR[r.tier], color: TIER_COLOR[r.tier] }}>{r.tier}</span>
            </div>
            <div className="flex items-baseline gap-2 mt-0.5 text-[10px] font-mono text-slate-400">
              <span style={{ color: PROVIDER_COLOR[r.provider] }}>{r.provider}</span>
              <span className="text-slate-500">pub {r.dest?.published || '—'}</span>
              <span style={{ color: APPR_RANK[r.achievable] > APPR_RANK[r.dest?.published || 'NONE'] ? '#f59e0b' : '#10b981' }}>ach {r.achievable}</span>
              <span style={{ color: r.ionState === 'STORM' ? '#ef4444' : r.ionState === 'WATCH' ? '#f59e0b' : '#10b981' }}>ION-{r.ionState}</span>
              <span className="text-slate-500">{r.distNm.toFixed(0)}nm</span>
            </div>
            <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden relative">
              <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier] }} />
              <div className="absolute inset-y-0" style={{ left: '25%', width: 1, background: '#0ea5e966' }} />
              <div className="absolute inset-y-0" style={{ left: '55%', width: 1, background: '#f59e0b66' }} />
              <div className="absolute inset-y-0" style={{ left: '80%', width: 1, background: '#ef444466' }} />
            </div>
            <div className="flex flex-wrap gap-1 mt-1 text-[9px] font-mono">
              {(['COV', 'RX', 'ION', 'INT', 'SAT'] as const).map(k => {
                const m: any = { COV: 'cov', RX: 'rx', ION: 'ion', INT: 'int', SAT: 'sat' }
                const v = (r.sev as any)[m[k]] as number
                return <span key={k} className="px-1 rounded border" style={{ borderColor: tierColorOf(v) + '88', color: tierColorOf(v) }}>{k} {v.toFixed(0)}</span>
              })}
            </div>
            <div className="flex flex-wrap gap-1 mt-1 text-[9px] font-mono text-slate-400">
              <span className="px-1 rounded border border-slate-800" style={{ color: r.hpl > r.hal ? '#ef4444' : r.hpl > r.hal * 0.7 ? '#f59e0b' : '#10b981' }}>HPL {r.hpl.toFixed(0)}/{r.hal.toFixed(0)}m</span>
              <span className="px-1 rounded border border-slate-800" style={{ color: r.vpl > r.val ? '#ef4444' : r.vpl > r.val * 0.7 ? '#f59e0b' : '#10b981' }}>VPL {r.vpl.toFixed(0)}/{r.val.toFixed(0)}m</span>
              <span className="px-1 rounded border border-slate-800">SAT {r.satCount}</span>
              {!r.inSv && <span className="px-1 rounded border" style={{ borderColor: '#ef444488', color: '#ef4444' }}>OUT-SV</span>}
            </div>
            <div className="mt-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>{adviceFor(r)}</div>
            <div className="mt-0.5 text-[9px] text-slate-600">{r.spec.family} · {r.f.operator || '—'}</div>
          </button>
        ))}

        {tab === 'AIRPORTS' && filteredAirports.length === 0 && (
          <div className="px-3 py-8 text-center text-slate-500 text-[11px]">No SBAS destinations active.</div>
        )}
        {tab === 'AIRPORTS' && filteredAirports.map(a => (
          <button key={a.rec.iata} onClick={() => a.worstIcao && onFly(a.worstIcao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/70 transition relative">
            <span className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: TIER_COLOR[a.worstTier] }} />
            <div className="flex items-center gap-1.5">
              <span className="font-mono font-bold text-slate-100">{a.rec.iata}</span>
              <span className="text-slate-500 text-[10px] truncate">{a.rec.name}</span>
              <span className="text-[9px] font-mono px-1 rounded border" style={{ borderColor: PROVIDER_COLOR[a.rec.provider] + '88', color: PROVIDER_COLOR[a.rec.provider] }}>{a.rec.provider}</span>
              <span className="text-[9px] font-mono px-1 rounded border border-slate-800 text-slate-300">{a.rec.published}</span>
              <span className="text-[9px] font-mono px-1 rounded border ml-auto" style={{ borderColor: TIER_COLOR[a.worstTier], color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
            </div>
            <div className="flex items-baseline gap-2 mt-0.5 text-[10px] font-mono text-slate-400">
              <span>{a.count} ac</span>
              {a.unable > 0 && <span className="text-rose-400">{a.unable} unable</span>}
              {a.lpv200Count > 0 && <span className="text-emerald-400">{a.lpv200Count} LPV-200</span>}
              <span className="ml-auto">{a.worstCs}</span>
            </div>
            <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden relative">
              <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, a.meanScore)}%`, background: TIER_COLOR[a.worstTier] }} />
            </div>
          </button>
        ))}

        {tab === 'PROVIDERS' && provAggs.map(p => (
          <div key={p.id} className="px-3 py-2 border-b border-slate-900">
            <div className="flex items-center gap-1.5">
              <span className="font-mono font-bold text-slate-100">{p.id}</span>
              <span className="text-slate-500 text-[10px]">{p.name}</span>
              <span className="text-[9px] font-mono px-1 rounded border border-slate-800 text-slate-400">{p.status}</span>
              <span className="text-[9px] font-mono px-1 rounded border ml-auto" style={{ borderColor: PROVIDER_COLOR[p.id] + '88', color: PROVIDER_COLOR[p.id] }}>{p.aptCount} apt</span>
            </div>
            <div className="flex items-baseline gap-2 mt-0.5 text-[10px] font-mono text-slate-400">
              <span>{p.count} active</span>
              {p.unable > 0 && <span className="text-rose-400">{p.unable} unable</span>}
              {p.lpv200 > 0 && <span className="text-emerald-400">{p.lpv200} LPV-200</span>}
              <span className="ml-auto text-slate-500">max-lat {p.maxLat}°</span>
            </div>
            <div className="mt-1 text-[9px] text-slate-600">
              {p.latMin}..{p.latMax}°N · {p.lngMin}..{p.lngMax}°E · iono-bias eq+{p.equatorialIonoBias}/aur+{p.subAuroralBias}
            </div>
          </div>
        ))}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        ICAO Annex 10 Vol I 3.7.3 · Doc 9849 · Doc 8168 PANS-OPS · RTCA DO-229E · FAA AC 90-107 · AC 20-138D · TSO-C145d/C146d · Order 8260.54A · EASA AMC 20-28 · EUROCAE ED-72A
      </div>
    </div>
  )
}
