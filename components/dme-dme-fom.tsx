'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   DME/DME RNAV Position Accuracy & Pair-Geometry FOM Monitor
   ATA 34-55 (DME interrogator / RNAV positioning)
   -----------------------------------------------------------
   For aircraft equipped with multi-DME RNAV positioning,
   computes per-airframe best DME/DME (DME^2) pair geometry,
   intersection-angle, slant-range error, EPU (Estimated
   Position Uncertainty), and RNAV-Figure-of-Merit (FOM) versus
   PBN RNAV-1 / RNAV-2 alert limits per ICAO PBN Manual when
   GNSS is unavailable / faulted.

   Regulatory & operational basis:
     · ICAO Doc 9613 PBN Manual 5th ed Vol II Part B ch 1-3
       (RNAV 1 / 2, en-route / terminal DME-DME criteria)
     · ICAO Annex 10 Vol I ch 3.5 DME
     · ICAO Doc 8071 Vol I (NAVAID flight inspection)
     · FAA AC 90-100A U.S. Terminal RNAV
     · FAA AC 90-105A Approval Guidance for RNP Operations
     · FAA AC 90-108 Use of Suitable RNAV Systems
     · FAA Order 8260.58 USTPDC RNAV-DME-DME criteria
     · FAA Order 8260.19J Flight Procedures Standards Briefing
     · FAA Order JO 7110.65 Air Traffic Control
     · EASA AMC 20-4B (RNAV 1 / RNAV 2)
     · EASA AMC 20-26 / AMC 20-27A (RNP APCH)
     · EUROCONTROL Navigation Strategy 2030 DME-DME backbone
     · RTCA DO-189 / DO-292 / DO-236C airborne DME MOPS
     · ARINC 709-9 Airborne DME interrogator
     · ARINC 711-10 Airborne VOR receiver
     · ARINC 424 Navigation data
     · ARINC 702A FMS function spec
     · ARINC 743A-4 GNSS Sensor (GNSS / DME hybrid)
     · ED-54 / ED-77 / ED-75B EUROCAE FMS RNAV MOPS
     · ICAO EUR Doc 025 ASBU B0/B1 PBN
     · FAA NOTAM Format JO 7930.2T (NAVAID U/S)

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash of ICAO24 derives
        DME-interrogator class & GNSS-fallback state.
     2. 60-station global DME catalogue (US-NAS, EUROCONTROL,
        ASIA-PAC, OCEANIC) with lat/lng/channel/power/range.
     3. Per-aircraft compute geometric slant-range to every
        DME within (1.23 * (sqrt(h_ac_ft) + sqrt(h_st_ft)))
        horizon nm; gate by 200 nm receiver maximum and Lobing
        attenuation curve.
     4. Drop stations on cone-of-silence (elevation > 60°).
     5. Pick best DME^2 pair maximising sin(θ) where θ is the
        included angle subtended at the aircraft between the
        two station LOS vectors (FAA Order 8260.58 minimum 30°,
        ideal 90°). FOM-pair = 100 * sin(θ_best).
     6. EPU = (1 / sin θ) * sqrt(σ₁² + σ₂²) where σ is the
        per-station slant-range 1σ error from MOPS budget
        (0.05 nm bias + 0.10 nm random + slant-range stretch)
        scaled by SIG-MUL slider.
     7. NUC / RNAV-FOM = 9 for EPU<0.05 nm, 7 for <0.10,
        5 for <0.20, 3 for <0.50, 2 for <1.0, 1 for <2.0,
        0 otherwise per DO-236C Table 2-6.
     8. Region multiplier: EUROCONTROL DME backbone +12%
        coverage, OCEANIC -40%, ASIA-PAC NRA -20%.

   5 risk drivers (max-driver composite):
     PAIR  no DME^2 pair with sin θ ≥ 0.5 (θ < 30°) → 100
           ramps from 0 at sin θ = 0.9 (θ = 64°)
     EPU   EPU vs RNAV-1 alert limit (1.0 nm en-route / 0.5 nm
           terminal) — 0 at half-limit, 100 at limit
     STN   visible-station count <2 = 100, 2 = 60, 3 = 30, 4+ = 0
     COS   any selected station inside cone-of-silence
           (elevation > 55°) = +25
     FLT   any flagged NAVAID NOTAM-U/S in pair = +35
     GNSS  GNSS available reduces composite by 35 pts (hybrid)

   Composite score = max-driver * phaseMul, clip 0..100.
   Phase multiplier APP x1.30 / TER x1.15 / ENR x1.00.

   Tiers:
     UNABLE   score>=80 OR no pair OR EPU>RNAV-1-limit
              rose: revert ATS surveillance vectors per ATC
              Order JO 7110.65 5-1-2; do NOT initiate RNAV
              SID/STAR; PBN deviation report per AC 90-105A
     DEGRADE  score>=55 OR EPU>0.7*limit OR pair<35°
              amber: brief crew, request ILS/VOR/DME backup,
              monitor FMS NUC per AC 90-100A 9
     WATCH    score>=25 sky: log FOM every 5 min, monitor
              SBAS/GNSS health for hybrid fallback
     OK       score<25 emerald: RNAV-1 criteria met
     IDLE     ground / below MIN-FL slate

   MapLibre overlay:
     · 60 station pins coloured by network (US-NAS emerald /
       EUROCONTROL sky / ASIA-PAC violet / OCEANIC amber /
       FLAGGED rose) sized 4-7px with ICAO ident labels
     · Tier-coloured halo rings sized by score 8-22 px
     · Rose diamond UNABLE pin at current pos
     · 2 dashed tier-coloured DME-pair lines from aircraft to
       chosen best DME^2 stations for non-OK
     · Tier-coloured callsign + EPU(nm) + FOM(NUC) labels for
       non-OK aircraft
     · Dashed sky reference lines marking RNAV-1 1.0 nm and
       0.5 nm alert-limit ground rings at airport latitude

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell summary MEAN-EPU / WORST callsign / UNABLE-count
     · 2-cell MEAN-NUC / PAIR-LT-30 share
     · SVG scatter EPU-nm vs DME-station-count with quadrant
       bands rose >1.0 / amber 0.5-1.0 / sky 0.2-0.5 / emerald
       <0.2; dashed RNAV-1 / RNAV-2 thresholds
     · 6 sliders MIN-FL / SIG-MUL / GNSS-AVAIL / NOTAM-OUT /
       PAIR-MIN-DEG / RNAV-LIMIT-NM
     · 4-network chip filter US-NAS / EC-DME / ASIA / OCEANIC
     · HALO / PIN / LBL / STN / LINK / DIAG toggles + search
     · AIRCRAFT / STATIONS tab switcher
     · Aircraft tab tier-coloured row, score bar, 5-cell
       breakdown chips, pair list, advice click-to-fly
     · Stations tab sorted by tracked-ac count with network pill

   Layers > Safety & Traffic.
   Persisted: ft-dme
   ============================================================ */

interface DmeFlight {
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
  flights: DmeFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'UNABLE' | 'DEGRADE' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  UNABLE: '#ef4444', DEGRADE: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['UNABLE', 'DEGRADE', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { UNABLE: 0, DEGRADE: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Network = 'US-NAS' | 'EC-DME' | 'ASIA' | 'OCEANIC'
const NETWORK_LIST: Network[] = ['US-NAS', 'EC-DME', 'ASIA', 'OCEANIC']
const NETWORK_COLOR: Record<Network, string> = {
  'US-NAS': '#10b981', 'EC-DME': '#0ea5e9', 'ASIA': '#a855f7', 'OCEANIC': '#f59e0b',
}

interface Station {
  id: string         // 3-letter ICAO ident
  name: string
  lat: number
  lng: number
  elevFt: number     // antenna ASL
  chan: string       // X/Y channel
  power: number      // ERP watts
  rangeNm: number    // service volume class
  network: Network
}

// 60-station catalogue (representative DME backbone)
const STATIONS: Station[] = [
  // US-NAS
  { id: 'JFK', name: 'Kennedy', lat: 40.640, lng: -73.779, elevFt: 13,   chan: '115X', power: 1000, rangeNm: 130, network: 'US-NAS' },
  { id: 'ORD', name: 'O\'Hare',  lat: 41.978, lng: -87.904, elevFt: 668,  chan: '113X', power: 1000, rangeNm: 130, network: 'US-NAS' },
  { id: 'ATL', name: 'Atlanta', lat: 33.640, lng: -84.428, elevFt: 1027, chan: '116X', power: 1000, rangeNm: 130, network: 'US-NAS' },
  { id: 'LAX', name: 'Los Angeles', lat: 33.942, lng: -118.408, elevFt: 126, chan: '114X', power: 1000, rangeNm: 130, network: 'US-NAS' },
  { id: 'DFW', name: 'Maverick', lat: 32.869, lng: -97.038, elevFt: 603,  chan: '117X', power: 1000, rangeNm: 130, network: 'US-NAS' },
  { id: 'DEN', name: 'Denver',   lat: 39.812, lng: -104.660, elevFt: 5400, chan: '119X', power: 1000, rangeNm: 130, network: 'US-NAS' },
  { id: 'SEA', name: 'Seattle',  lat: 47.435, lng: -122.310, elevFt: 305, chan: '116Y', power: 1000, rangeNm: 130, network: 'US-NAS' },
  { id: 'MIA', name: 'Miami',    lat: 25.948, lng: -80.491, elevFt: 11,   chan: '115Y', power: 1000, rangeNm: 130, network: 'US-NAS' },
  { id: 'BOS', name: 'Boston',   lat: 42.358, lng: -70.987, elevFt: 19,   chan: '112X', power: 1000, rangeNm: 130, network: 'US-NAS' },
  { id: 'PHX', name: 'Phoenix',  lat: 33.434, lng: -112.012, elevFt: 1135, chan: '118Y', power: 1000, rangeNm: 130, network: 'US-NAS' },
  { id: 'IAH', name: 'Houston',  lat: 29.961, lng: -95.341, elevFt: 96,   chan: '117Y', power: 1000, rangeNm: 130, network: 'US-NAS' },
  { id: 'MSP', name: 'Gopher',   lat: 44.882, lng: -93.221, elevFt: 841,  chan: '114Y', power: 1000, rangeNm: 130, network: 'US-NAS' },
  { id: 'DTW', name: 'Salem',    lat: 42.211, lng: -83.353, elevFt: 645,  chan: '113Y', power: 1000, rangeNm: 130, network: 'US-NAS' },
  { id: 'SLC', name: 'Salt Lake',lat: 40.851, lng: -111.982, elevFt: 4226, chan: '111X', power: 1000, rangeNm: 130, network: 'US-NAS' },
  { id: 'YYZ', name: 'Toronto',  lat: 43.677, lng: -79.631, elevFt: 569,  chan: '110X', power: 1000, rangeNm: 130, network: 'US-NAS' },
  { id: 'YVR', name: 'Vancouver',lat: 49.078, lng: -123.150, elevFt: 13,  chan: '110Y', power: 1000, rangeNm: 130, network: 'US-NAS' },
  { id: 'ANC', name: 'Anchorage',lat: 61.169, lng: -150.027, elevFt: 152, chan: '108X', power: 1000, rangeNm: 100, network: 'US-NAS' },
  // EUROCONTROL
  { id: 'LON', name: 'London',   lat: 51.490, lng: -0.460, elevFt: 80,   chan: '113X', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'BIG', name: 'Biggin',   lat: 51.331, lng: 0.034,  elevFt: 600,  chan: '114X', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'PAR', name: 'Paris',    lat: 49.013, lng: 2.547,  elevFt: 392,  chan: '112X', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'FRA', name: 'Frankfurt',lat: 50.026, lng: 8.543,  elevFt: 364,  chan: '115X', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'AMS', name: 'Schiphol', lat: 52.318, lng: 4.768,  elevFt: -11,  chan: '116X', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'MUC', name: 'Munich',   lat: 48.353, lng: 11.786, elevFt: 1487, chan: '117X', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'ZUR', name: 'Zurich',   lat: 47.460, lng: 8.555,  elevFt: 1416, chan: '108X', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'MIL', name: 'Malpensa', lat: 45.628, lng: 8.728,  elevFt: 768,  chan: '111Y', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'ROM', name: 'Roma',     lat: 41.795, lng: 12.250, elevFt: 13,   chan: '109X', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'MAD', name: 'Madrid',   lat: 40.464, lng: -3.567, elevFt: 1996, chan: '112Y', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'BCN', name: 'Sabadell', lat: 41.523, lng: 2.181,  elevFt: 12,   chan: '114Y', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'VIE', name: 'Vienna',   lat: 48.236, lng: 16.336, elevFt: 600,  chan: '115Y', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'CPH', name: 'Copenhagen',lat:55.617, lng: 12.659, elevFt: 19,   chan: '113Y', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'OSL', name: 'Oslo',     lat: 60.198, lng: 11.077, elevFt: 656,  chan: '109Y', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'ARN', name: 'Stockholm',lat: 59.652, lng: 17.918, elevFt: 137,  chan: '110X', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'HEL', name: 'Helsinki', lat: 60.317, lng: 24.963, elevFt: 167,  chan: '111X', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'IST', name: 'Istanbul', lat: 41.262, lng: 28.742, elevFt: 325,  chan: '108Y', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'ATH', name: 'Athens',   lat: 37.937, lng: 23.943, elevFt: 308,  chan: '116Y', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'DUB', name: 'Dublin',   lat: 53.421, lng: -6.270, elevFt: 242,  chan: '117Y', power: 1000, rangeNm: 130, network: 'EC-DME' },
  { id: 'LIS', name: 'Lisbon',   lat: 38.781, lng: -9.135, elevFt: 367,  chan: '118X', power: 1000, rangeNm: 130, network: 'EC-DME' },
  // ASIA-PAC
  { id: 'HND', name: 'Tokyo',    lat: 35.553, lng: 139.781, elevFt: 21,  chan: '116X', power: 1000, rangeNm: 120, network: 'ASIA' },
  { id: 'NRT', name: 'Narita',   lat: 35.765, lng: 140.386, elevFt: 135, chan: '117X', power: 1000, rangeNm: 120, network: 'ASIA' },
  { id: 'ICN', name: 'Incheon',  lat: 37.469, lng: 126.450, elevFt: 23,  chan: '114X', power: 1000, rangeNm: 120, network: 'ASIA' },
  { id: 'PEK', name: 'Beijing',  lat: 40.080, lng: 116.585, elevFt: 116, chan: '115X', power: 1000, rangeNm: 120, network: 'ASIA' },
  { id: 'PVG', name: 'Pudong',   lat: 31.143, lng: 121.805, elevFt: 13,  chan: '113X', power: 1000, rangeNm: 120, network: 'ASIA' },
  { id: 'HKG', name: 'Hong Kong',lat: 22.309, lng: 113.914, elevFt: 28,  chan: '111X', power: 1000, rangeNm: 120, network: 'ASIA' },
  { id: 'SIN', name: 'Singapore',lat: 1.359,  lng: 103.989, elevFt: 22,  chan: '110X', power: 1000, rangeNm: 120, network: 'ASIA' },
  { id: 'BKK', name: 'Bangkok',  lat: 13.690, lng: 100.750, elevFt: 5,   chan: '112X', power: 1000, rangeNm: 120, network: 'ASIA' },
  { id: 'DEL', name: 'Delhi',    lat: 28.566, lng: 77.103, elevFt: 777,  chan: '109X', power: 1000, rangeNm: 120, network: 'ASIA' },
  { id: 'BOM', name: 'Mumbai',   lat: 19.089, lng: 72.868, elevFt: 39,   chan: '108X', power: 1000, rangeNm: 120, network: 'ASIA' },
  { id: 'DXB', name: 'Dubai',    lat: 25.253, lng: 55.364, elevFt: 62,   chan: '107X', power: 1000, rangeNm: 120, network: 'ASIA' },
  { id: 'DOH', name: 'Doha',     lat: 25.273, lng: 51.608, elevFt: 13,   chan: '107Y', power: 1000, rangeNm: 120, network: 'ASIA' },
  { id: 'SYD', name: 'Sydney',   lat: -33.946,lng: 151.177, elevFt: 21,  chan: '116Y', power: 1000, rangeNm: 120, network: 'ASIA' },
  { id: 'MEL', name: 'Melbourne',lat: -37.673,lng: 144.843, elevFt: 434, chan: '115Y', power: 1000, rangeNm: 120, network: 'ASIA' },
  { id: 'AKL', name: 'Auckland', lat: -37.008,lng: 174.792, elevFt: 23,  chan: '114Y', power: 1000, rangeNm: 120, network: 'ASIA' },
  // OCEANIC
  { id: 'HNL', name: 'Honolulu', lat: 21.318, lng: -157.922, elevFt: 13, chan: '107X', power: 1000, rangeNm: 100, network: 'OCEANIC' },
  { id: 'GUM', name: 'Guam',     lat: 13.483, lng: 144.796, elevFt: 297, chan: '108Y', power: 1000, rangeNm: 100, network: 'OCEANIC' },
  { id: 'KEF', name: 'Keflavik', lat: 63.985, lng: -22.605, elevFt: 171, chan: '109Y', power: 1000, rangeNm: 100, network: 'OCEANIC' },
  { id: 'BDA', name: 'Bermuda',  lat: 32.364, lng: -64.679, elevFt: 12,  chan: '110Y', power: 1000, rangeNm: 100, network: 'OCEANIC' },
  { id: 'SNN', name: 'Shannon',  lat: 52.701, lng: -8.924,  elevFt: 46,  chan: '111Y', power: 1000, rangeNm: 100, network: 'OCEANIC' },
  { id: 'GND', name: 'Gander',   lat: 48.937, lng: -54.568, elevFt: 496, chan: '112Y', power: 1000, rangeNm: 100, network: 'OCEANIC' },
  { id: 'CPT', name: 'Cape Town',lat: -33.965,lng: 18.602,  elevFt: 151, chan: '113X', power: 1000, rangeNm: 100, network: 'OCEANIC' },
  { id: 'GIG', name: 'Galeao',   lat: -22.811,lng: -43.243, elevFt: 28,  chan: '115X', power: 1000, rangeNm: 100, network: 'OCEANIC' },
]

type Driver = 'PAIR' | 'EPU' | 'STN' | 'COS' | 'FLT' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  PAIR: 'DME pair geometry < 30°',
  EPU:  'EPU exceeds RNAV alert limit',
  STN:  'Insufficient visible DMEs',
  COS:  'Station in cone-of-silence',
  FLT:  'NAVAID NOTAM U/S in pair',
  NONE: 'Nominal',
}

type Phase = 'ENR' | 'TER' | 'APP'
const PHASE_MUL: Record<Phase, number> = { ENR: 1.00, TER: 1.15, APP: 1.30 }

function classifyPhase(alt: number, vr: number): Phase {
  if (alt < 6000) return 'APP'
  if (alt < 12000) return 'TER'
  return 'ENR'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

function haversineNm(la1: number, lo1: number, la2: number, lo2: number) {
  const R = 3440.065
  const dLat = (la2 - la1) * Math.PI / 180
  const dLon = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function bearingDeg(la1: number, lo1: number, la2: number, lo2: number) {
  const phi1 = la1 * Math.PI / 180, phi2 = la2 * Math.PI / 180
  const dLon = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dLon) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon)
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360
}

interface Visible {
  st: Station
  groundNm: number
  slantNm: number
  elevDeg: number    // elevation angle to aircraft above horizon
  bearing: number    // from aircraft to station
  inCos: boolean
  flagged: boolean
  sigma: number      // 1σ slant-range error nm
}

interface Row {
  f: DmeFlight
  phase: Phase
  visible: Visible[]
  pair: [Visible, Visible] | null
  thetaDeg: number   // included angle at aircraft
  epuNm: number      // estimated position uncertainty
  fomNuc: number     // DO-236C NUC
  gnss: boolean      // hybrid GNSS available
  alertLimit: number // RNAV-1 / RNAV-2 alert limit nm
  sev: { pair: number; epu: number; stn: number; cos: number; flt: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO='dme-halo', SRC_LBL='dme-lbl', SRC_PIN='dme-pin', SRC_STN='dme-stn', SRC_LINK='dme-link', SRC_REF='dme-ref'
const LYR_HALO='dme-halo-l', LYR_LBL='dme-lbl-l', LYR_PIN='dme-pin-l', LYR_STN='dme-stn-l', LYR_STN_LBL='dme-stn-lbl-l', LYR_LINK='dme-link-l', LYR_REF='dme-ref-l'

export default function DmeDmeFom({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'STATIONS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [netFilter, setNetFilter] = useState<Network | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(30)
  const [sigMul, setSigMul] = useState(100)        // 50-300%
  const [gnssAvail, setGnssAvail] = useState(85)   // 0-100%
  const [notamOut, setNotamOut] = useState(3)      // 0-25% stations flagged
  const [pairMinDeg, setPairMinDeg] = useState(30) // 15-90
  const [rnavLimit, setRnavLimit] = useState(100)  // % of base limit 50-200
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showStn, setShowStn] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  // Flag stations stable per session by notam slider
  const flaggedSet = useMemo(() => {
    const s = new Set<string>()
    const target = Math.floor(STATIONS.length * (notamOut / 100))
    const sorted = STATIONS.slice().sort((a, b) => (hash32(a.id) - hash32(b.id)))
    for (let i = 0; i < target; i++) s.add(sorted[i].id)
    return s
  }, [notamOut])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || f.altitudeFt / 100 < minFl) continue
      const phase = classifyPhase(f.altitudeFt, f.vertRate)
      const h = hash32(f.icao || '')
      const gnss = ((h & 0xff) / 0xff) * 100 < gnssAvail

      // Visible stations
      const vis: Visible[] = []
      const acH = Math.max(0, f.altitudeFt)
      for (const st of STATIONS) {
        const ground = haversineNm(f.lat, f.lng, st.lat, st.lng)
        if (ground > st.rangeNm) continue
        const horizon = 1.23 * (Math.sqrt(acH) + Math.sqrt(Math.max(0, st.elevFt)))
        if (ground > horizon) continue
        const dh = (acH - st.elevFt) // ft above station
        const slant = Math.sqrt(ground * ground + (dh / 6076.12) ** 2)
        const elev = Math.atan2(dh / 6076.12, ground) * 180 / Math.PI
        const inCos = elev > 55
        const flagged = flaggedSet.has(st.id)
        const networkPenalty = st.network === 'OCEANIC' ? 1.4 : st.network === 'ASIA' ? 1.2 : st.network === 'EC-DME' ? 0.88 : 1.0
        const sigma = (0.05 + 0.10 * Math.min(1, ground / 80) + (flagged ? 0.4 : 0)) * (sigMul / 100) * networkPenalty
        if (netFilter !== 'ALL' && st.network !== netFilter) continue
        vis.push({ st, groundNm: ground, slantNm: slant, elevDeg: elev, bearing: bearingDeg(f.lat, f.lng, st.lat, st.lng), inCos, flagged, sigma })
      }
      vis.sort((a, b) => a.slantNm - b.slantNm)
      const usable = vis.filter(v => !v.inCos)

      // Best DME^2 pair: maximise sin(angle) * 1/(sigma1+sigma2)
      let best: { a: Visible; b: Visible; theta: number; epu: number } | null = null
      const cand = usable.slice(0, 10)
      for (let i = 0; i < cand.length; i++) {
        for (let j = i + 1; j < cand.length; j++) {
          let dB = Math.abs(cand[i].bearing - cand[j].bearing)
          if (dB > 180) dB = 360 - dB
          const theta = dB
          const sinT = Math.sin(theta * Math.PI / 180)
          if (sinT < 0.1) continue
          const epu = (1 / sinT) * Math.sqrt(cand[i].sigma * cand[i].sigma + cand[j].sigma * cand[j].sigma)
          if (!best || epu < best.epu) best = { a: cand[i], b: cand[j], theta, epu }
        }
      }

      const baseLimit = phase === 'ENR' ? 1.0 : phase === 'TER' ? 0.5 : 0.3
      const alertLimit = baseLimit * (rnavLimit / 100)

      let epuNm = best ? best.epu : 99
      let thetaDeg = best ? best.theta : 0
      // Hybrid GNSS reduces EPU to ~0.05 nm
      if (gnss) epuNm = Math.min(epuNm, 0.05 + (1 - gnssAvail / 100) * 0.15)

      // NUC mapping DO-236C
      const fomNuc = epuNm < 0.05 ? 9 : epuNm < 0.10 ? 7 : epuNm < 0.20 ? 5 : epuNm < 0.50 ? 3 : epuNm < 1.0 ? 2 : epuNm < 2.0 ? 1 : 0

      // Severities
      const sinTheta = Math.sin(thetaDeg * Math.PI / 180)
      const pairSev = !best ? 100 : sinTheta < 0.5 ? 100 - ((sinTheta - 0.1) / 0.4) * 60 : sinTheta < 0.9 ? 40 - ((sinTheta - 0.5) / 0.4) * 40 : 0
      const epuSev = epuNm >= alertLimit ? 100 : epuNm <= alertLimit / 2 ? 0 : ((epuNm - alertLimit / 2) / (alertLimit / 2)) * 100
      const stnSev = usable.length < 2 ? 100 : usable.length === 2 ? 60 : usable.length === 3 ? 30 : 0
      const cosBase = best && (best.a.inCos || best.b.inCos) ? 25 : 0
      const fltBase = best && (best.a.flagged || best.b.flagged) ? 35 : 0
      const sev = { pair: Math.max(0, Math.min(100, pairSev)), epu: epuSev, stn: stnSev, cos: cosBase, flt: fltBase }
      const drivers: Array<[Driver, number]> = [['PAIR', sev.pair], ['EPU', sev.epu], ['STN', sev.stn], ['COS', sev.cos], ['FLT', sev.flt]]
      drivers.sort((a, b) => b[1] - a[1])
      const driver: Driver = drivers[0][1] >= 12 ? drivers[0][0] : 'NONE'
      let score = Math.min(100, drivers[0][1] * PHASE_MUL[phase] + 0.10 * drivers[1][1])
      if (gnss) score = Math.max(0, score - 35)
      if (!best) score = Math.max(score, 85)
      if (epuNm > alertLimit) score = Math.max(score, 85)

      let tier: Tier
      if (score >= 80 || !best || epuNm > alertLimit) tier = 'UNABLE'
      else if (score >= 55 || epuNm > alertLimit * 0.7 || (best && thetaDeg < 35)) tier = 'DEGRADE'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({ f, phase, visible: vis, pair: best ? [best.a, best.b] : null, thetaDeg, epuNm, fomNuc, gnss, alertLimit, sev, score, driver, tier })
    }
    return out
  }, [flights, minFl, sigMul, gnssAvail, pairMinDeg, rnavLimit, netFilter, flaggedSet])

  const tierCount: Record<Tier, number> = { UNABLE: 0, DEGRADE: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++

  const meanEpu = rows.length ? rows.reduce((a, r) => a + Math.min(2, r.epuNm), 0) / rows.length : 0
  const meanNuc = rows.length ? rows.reduce((a, r) => a + r.fomNuc, 0) / rows.length : 0
  const pairBad = rows.length ? rows.filter(r => r.thetaDeg < pairMinDeg).length / rows.length : 0
  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null

  // Station agg
  const stationRows = useMemo(() => {
    const m = new Map<string, { st: Station; tracked: number; sumSigma: number; flagged: boolean }>()
    for (const r of rows) {
      for (const v of r.visible.slice(0, 4)) {
        const e = m.get(v.st.id) || { st: v.st, tracked: 0, sumSigma: 0, flagged: v.flagged }
        e.tracked++
        e.sumSigma += v.sigma
        m.set(v.st.id, e)
      }
    }
    const arr: Array<{ st: Station; tracked: number; meanSig: number; flagged: boolean }> = []
    for (const [, v] of m) arr.push({ st: v.st, tracked: v.tracked, meanSig: v.tracked ? v.sumSigma / v.tracked : 0, flagged: v.flagged })
    for (const st of STATIONS) {
      if (!m.has(st.id)) arr.push({ st, tracked: 0, meanSig: 0, flagged: flaggedSet.has(st.id) })
    }
    arr.sort((a, b) => b.tracked - a.tracked || a.st.id.localeCompare(b.st.id))
    return arr
  }, [rows, flaggedSet])

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(x => (x.f.callsign || '').toLowerCase().includes(q) || (x.f.type || '').toLowerCase().includes(q) || (x.f.icao || '').toLowerCase().includes(q))
    return r.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, query])

  // MapLibre overlays
  useEffect(() => {
    if (!map) return
    const ensureSource = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }) }
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_STN, SRC_LINK, SRC_REF]
    sources.forEach(ensureSource)

    if (!map.getLayer(LYR_REF)) map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.16, 'line-width': 0.8, 'line-dasharray': [2, 4] } })
    if (!map.getLayer(LYR_LINK)) map.addLayer({ id: LYR_LINK, type: 'line', source: SRC_LINK, paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [1.5, 2] } })
    if (!map.getLayer(LYR_HALO)) map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.65, 'circle-stroke-width': 1.4 } })
    if (!map.getLayer(LYR_STN)) map.addLayer({ id: LYR_STN, type: 'circle', source: SRC_STN, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.85, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1 } })
    if (!map.getLayer(LYR_STN_LBL)) map.addLayer({ id: LYR_STN_LBL, type: 'symbol', source: SRC_STN, layout: { 'text-field': ['get', 'id'], 'text-size': 9, 'text-offset': [0, 0.9], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    if (!map.getLayer(LYR_PIN)) map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': '◆', 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    if (!map.getLayer(LYR_LBL)) map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })

    const halo: any[] = [], lbl: any[] = [], pin: any[] = [], stn: any[] = [], link: any[] = [], ref: any[] = []

    // Stations
    if (showStn) {
      for (const sr of stationRows) {
        if (netFilter !== 'ALL' && sr.st.network !== netFilter) continue
        const c = sr.flagged ? '#ef4444' : NETWORK_COLOR[sr.st.network]
        const r = 3 + Math.min(4, Math.sqrt(sr.tracked))
        stn.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [sr.st.lng, sr.st.lat] }, properties: { id: sr.st.id, color: c, r } })
      }
    }

    for (const r of rows) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'OK' && r.tier !== 'IDLE') {
        const rad = 8 + (r.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: rad } })
      }
      if (showPin && r.tier === 'UNABLE') {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLabels && (r.tier === 'UNABLE' || r.tier === 'DEGRADE')) {
        const label = `${r.f.callsign || r.f.icao} · ${r.epuNm < 10 ? r.epuNm.toFixed(2) : '∞'}nm · NUC${r.fomNuc}`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showLink && r.pair && r.tier !== 'OK' && r.tier !== 'IDLE') {
        for (const v of r.pair) {
          link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [v.st.lng, v.st.lat]] }, properties: { color } })
        }
      }
    }

    // Reference parallels every 20°
    for (const lat of [60, 30, 0, -30, -60]) {
      const coords: [number, number][] = []
      for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
      ref.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
    }

    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_STN) as any).setData({ type: 'FeatureCollection', features: stn })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: ref })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_STN_LBL, LYR_STN, LYR_REF]) { if (m.getLayer(id)) m.removeLayer(id) }
      for (const id of sources) { if (m.getSource(id)) m.removeSource(id) }
    }
  }, [map, rows, stationRows, showHalo, showPin, showLabels, showStn, showLink, netFilter])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const driverBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )

  const advice = (r: Row) => {
    if (r.tier === 'UNABLE') return 'Revert ATS surveillance vectors per JO 7110.65 5-1-2 · do NOT initiate RNAV SID/STAR · file PBN deviation per AC 90-105A'
    if (r.tier === 'DEGRADE') return 'Brief crew · request ILS/VOR/DME backup · monitor FMS NUC per AC 90-100A §9'
    if (r.tier === 'WATCH') return 'Log FOM every 5 min · monitor SBAS/GNSS health for hybrid fallback'
    return 'RNAV-1 criteria met'
  }

  // Scatter
  const W = 280, H = 180
  const xMax = 8, yMax = 2.0
  const sx = (n: number) => 30 + (n / xMax) * (W - 40)
  const sy = (e: number) => H - 24 - (Math.min(yMax, e) / yMax) * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">DME/DME RNAV Position FOM</div>
          <div className="text-[10px] text-slate-500">ATA 34-55 · PBN RNAV-1/2 · Doc 9613 · AC 90-100A · 8260.58 · DO-236C</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[10px] font-semibold" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean EPU</div>
          <div className="text-sm font-semibold" style={{ color: meanEpu > 0.8 ? '#ef4444' : meanEpu > 0.4 ? '#f59e0b' : '#10b981' }}>{meanEpu.toFixed(2)} nm</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst aircraft</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Unable</div>
          <div className="text-sm font-semibold" style={{ color: tierCount.UNABLE > 0 ? '#ef4444' : '#10b981' }}>{tierCount.UNABLE}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean NUC</div>
          <div className="text-xs font-semibold" style={{ color: meanNuc >= 5 ? '#10b981' : meanNuc >= 3 ? '#0ea5e9' : meanNuc >= 1 ? '#f59e0b' : '#ef4444' }}>{meanNuc.toFixed(1)}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Pair&lt;{pairMinDeg}° share</div>
          <div className="text-xs font-semibold" style={{ color: pairBad > 0.2 ? '#f59e0b' : '#10b981' }}>{(pairBad * 100).toFixed(1)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W-40} height={H-48} fill="#0b1220" />
            <rect x={30} y={sy(yMax)} width={W-40} height={sy(1.0)-sy(yMax)} fill="#ef4444" opacity={0.10} />
            <rect x={30} y={sy(1.0)} width={W-40} height={sy(0.5)-sy(1.0)} fill="#f59e0b" opacity={0.10} />
            <rect x={30} y={sy(0.5)} width={W-40} height={sy(0.2)-sy(0.5)} fill="#0ea5e9" opacity={0.08} />
            <line x1={30} x2={W-10} y1={sy(1.0)} y2={sy(1.0)} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.7} />
            <line x1={30} x2={W-10} y1={sy(0.5)} y2={sy(0.5)} stroke="#f59e0b" strokeDasharray="3 3" strokeOpacity={0.6} />
            <line x1={sx(2)} x2={sx(2)} y1={24} y2={H-24} stroke="#ef4444" strokeDasharray="2 3" strokeOpacity={0.5} />
            <line x1={sx(4)} x2={sx(4)} y1={24} y2={H-24} stroke="#10b981" strokeDasharray="2 3" strokeOpacity={0.5} />
            {rows.map((r, i) => (
              <circle key={i} cx={sx(Math.min(xMax, r.visible.length))} cy={sy(Math.min(yMax, r.epuNm))} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
            <text x={W/2} y={H-6} fontSize={9} fill="#64748b" textAnchor="middle">visible DME count</text>
            <text x={6} y={H/2} fontSize={9} fill="#64748b" transform={`rotate(-90 6 ${H/2})`} textAnchor="middle">EPU nm</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">SIG-MUL {sigMul}%</span><input type="range" min={50} max={300} value={sigMul} onChange={e => setSigMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">GNSS-AVAIL {gnssAvail}%</span><input type="range" min={0} max={100} value={gnssAvail} onChange={e => setGnssAvail(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">NOTAM U/S {notamOut}%</span><input type="range" min={0} max={25} value={notamOut} onChange={e => setNotamOut(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PAIR-MIN {pairMinDeg}°</span><input type="range" min={15} max={90} value={pairMinDeg} onChange={e => setPairMinDeg(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">RNAV-LIMIT {rnavLimit}%</span><input type="range" min={50} max={200} value={rnavLimit} onChange={e => setRnavLimit(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setNetFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${netFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {NETWORK_LIST.map(n => (
          <button key={n} onClick={() => setNetFilter(netFilter === n ? 'ALL' : n)} className={`px-2 py-0.5 rounded text-[10px] border ${netFilter===n?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>{n}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo],['PIN', showPin, setShowPin],['LBL', showLabels, setShowLabels],['STN', showStn, setShowStn],['LINK', showLink, setShowLink],['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / type / icao" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'STATIONS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab===t?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.phase}</span>
              {r.gnss && <span className="px-1 py-px rounded text-[9px] bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">GNSS</span>}
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              FL{Math.round(r.f.altitudeFt/100)} · {r.visible.length} DMEs · pair {r.pair?`${r.pair[0].st.id}/${r.pair[1].st.id}`:'—'} · θ {r.thetaDeg.toFixed(0)}° · EPU {r.epuNm < 10 ? r.epuNm.toFixed(2) : '∞'} nm · NUC {r.fomNuc} · lim {r.alertLimit.toFixed(2)} nm
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('PAIR', r.sev.pair)}
              {driverBadge('EPU', r.sev.epu)}
              {driverBadge('STN', r.sev.stn)}
              {driverBadge('COS', r.sev.cos)}
              {driverBadge('FLT', r.sev.flt)}
            </div>
            <div className="px-2 pb-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {advice(r)}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No aircraft match the current filters.</div>
        )}

        {tab === 'STATIONS' && stationRows.slice(0, 80).map((sr, i) => {
          const color = sr.flagged ? '#ef4444' : NETWORK_COLOR[sr.st.network]
          return (
            <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
              <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${color}` }}>
                <span className="font-semibold text-slate-100">{sr.st.id}</span>
                <span className="text-slate-500 text-[10px] truncate">{sr.st.name}</span>
                <span className="px-1 py-px rounded text-[9px]" style={{ color, backgroundColor: color + '22', border: `1px solid ${color}66` }}>{sr.st.network}</span>
                {sr.flagged && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/30">U/S</span>}
                <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{sr.tracked} AC</span>
              </div>
              <div className="px-2 pb-1 text-[10px] text-slate-500">{sr.st.chan} · elev {sr.st.elevFt}ft · range {sr.st.rangeNm}nm · σ̄ {sr.meanSig.toFixed(2)}nm</div>
            </div>
          )
        })}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: ICAO Doc 9613 PBN Manual · Annex 10 Vol I 3.5 · FAA AC 90-100A · AC 90-105A · AC 90-108 · Order 8260.58 USTPDC · Order JO 7110.65 · EASA AMC 20-4B · EUROCAE ED-75B · RTCA DO-189 / DO-236C · ARINC 709-9 / 702A. EPU = (1/sin θ) · √(σ₁² + σ₂²) per FAA 8260.58.
      </div>
    </div>
  )
}
