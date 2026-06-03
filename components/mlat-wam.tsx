'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   MLAT / WAM (Wide-Area Multilateration) TDoA Surveillance
   Coverage & Geometric-Dilution-of-Precision Monitor
   ---------------------------------------------------------------
   Reconstructs per-airframe Mode-S / 1090 ES squitter time-of-
   arrival multilateration solution geometry from a synthesised
   ground-sensor reference network, scoring per-aircraft against
   the ICAO Annex 10 surveillance performance categories and the
   EUROCONTROL / FAA WAM service-level specifications.

   Regulatory & standards basis:
     · ICAO Annex 10 Vol IV § 3.1.2  Surveillance Radar / SSR
     · ICAO Annex 10 Vol IV § 3.1.3  Mode-S extended squitter
     · ICAO Doc 9924  Aeronautical Surveillance Manual (ASM)
       Ch 7 Multilateration / WAM / Hyperbolic positioning
     · ICAO Doc 9871  Tech provisions for Mode-S svcs and ES
     · ICAO Doc 4444 PANS-ATM 8.5  Separation in ADS-B / WAM
     · ICAO Doc 8071 Vol III  Manual on testing of surv systems
     · RTCA DO-260B / DO-282B  1090 MHz ES / UAT (ADS-B)
     · RTCA DO-365B  MOPS for detect-and-avoid
     · EUROCAE ED-129B  WAM technical specification
     · EUROCAE ED-117A  MOPS for MLAT systems
     · EUROCAE ED-142  Technical specification for MLAT
     · FAA Spec FAA-E-2716A  Surveillance & Broadcast Services
     · FAA AC 90-114B  ADS-B Operations
     · FAA Order JO 7110.65 ch 5  Radar separation
     · EUROCONTROL WAM Specification Ed 1.0 (2014)
     · EUROCONTROL WAM Guidance Material  WAM-GM Ed 2.0
     · NUC (Navigation Uncertainty Category) DO-260 § 2.2.3.2.7.2
     · NIC / NAC_p / NAC_v / SIL / SDA per DO-260B Table 2-72
     · Asterix CAT-021 / CAT-019 / CAT-020 EUROCONTROL spec
     · ICAO Annex 11 § 3.7.3.4  ATS surveillance min separation
     · Honeywell / Saab Sensis / Era / Thales WAM ground products
     · NTSB AAB-09/01  GP1908 ADS-B loss reversion to MLAT
     · ATSB AO-2012-066  PenAir 3296 surveillance gap N Pacific
     · FAA InFO 14010  WAM/ADS-B surveillance combined ops
     · FAA SAFO 20003  Mode-S address integrity

   Algorithm:
     1. Curated 48-station ground-sensor reference network across
        the US/Europe/AsPac MLAT/WAM service volumes (FAA SBS,
        EUROCONTROL WAM-NRA, Aireon ground supplement, Saab Sensis
        deployments). Each station carries lat/lng/elev-ft and
        nominal antenna-gain dBi + RF-floor dBm + TDoA-clock-jitter
        ns + service-availability fraction (per ED-142).
     2. Per aircraft above MIN-FL slider, find all visible stations
        within radio-horizon (D_nm ≈ 1.23 × (√h_apt_ft + √h_ac_ft)).
        A station counts as "tracking" if:
          - geometric LOS clear (no terrain modelled — use horizon)
          - received power above -98 dBm reference (signal-budget
            link with free-space-loss = 32.45 + 20·log(MHz) +
            20·log(d_km))
          - station availability ≥ AVAIL-MIN slider
     3. For ≥4 tracking stations, compute the geometric dilution
        of precision (GDOP) of the TDoA hyperbolic positioning
        solution by linearising about the aircraft position and
        forming H = ∂(c·Δt)/∂(x,y,z), then computing
        GDOP = √trace((HᵀH)⁻¹). Decompose to HDOP / VDOP / TDOP.
        Position-error 1-σ_pos ≈ HDOP × c × σ_τ where σ_τ is the
        combined receiver-clock TDoA jitter (default 15 ns ⇒ 4.5 m
        single-edge, integrated across N stations).
     4. NUC equivalent per DO-260 Table 2-72:
          NUC 0  unknown                         RC > 18.5 km
          NUC 1  position error < 18.5 km        EPU < 18.5 km
          NUC 2  < 7.4 km                        EPU < 7.4 km
          NUC 3  < 3.7 km                        EPU < 3.7 km
          NUC 4  < 1.85 km / NACp 6              EPU < 1.85 km
          NUC 5  < 0.93 km / NACp 7              EPU < 0.93 km
          NUC 6  < 555 m   / NACp 8              EPU < 555 m
          NUC 7  < 185 m   / NACp 9              EPU < 185 m
          NUC 8  < 92.6 m  / NACp 10             EPU < 92.6 m
          NUC 9  < 27.8 m  / NACp 11             EPU < 27.8 m
     5. NUC ≥ 5 (HDOP ≤ 2.5) required for 5-NM radar-equivalent
        separation per ICAO Doc 4444 § 8.5 / FAA JO 7110.65 § 5-5-4.

   5 risk components (composite = max-driver):
     STN  station-count vs spec.minStations 4 (no solve <4) /
          tracking-count: 100 if <4 stations 80 if =4 60 if =5
          ramp to 0 at ≥8
     GDP  GDOP value 0 at ≤1.5 / 25 at 2.5 / 50 at 3.5 / 75 at 5
          / 100 at ≥7  (per ED-129B § 4.3 PDOP target ≤3)
     VDP  VDOP (elevation dilution) 0 at ≤2 / 100 at ≥10
     LAT  surveillance latency vs spec.target-1s (NUC age) 0 at
          ≤1 s ramp 100 at ≥8 s per ED-117A § 3.1.5
     NUC  effective NUC vs required-NUC-for-5NM-sep (5) per
          7110.65 5-5-4. 100 at NUC ≤2 0 at NUC ≥7
     INTEGR  Mode-S address integrity & SIL/SDA per DO-260B
          composite weight + 25 if dup-ICAO24 flag

   Classifies 5 tiers:
     OUTAGE  score≥80 OR stations<4 OR NUC≤2 rose: NO MLAT
       SOLUTION — ATC reverts to procedural separation per
       ICAO Doc 4444 ch 6 / JO 7110.65 § 8-3
     DEGRADED  score≥55 amber: 5-NM radar-equivalent suspended
       reduce to 10-NM longitudinal pending NUC recovery
     WATCH  score≥25 sky: monitor geometry HDOP marginal —
       additional reports requested every 4 s per ED-129B
     OK  score<25 emerald: 3/5 NM separation envelope nominal
     IDLE  below MIN-FL or ground slate

   MapLibre overlay: tier-coloured halo rings sized 8-22 px by
   score / rose diamond pin for OUTAGE + 48 station pins with
   tier-coloured halos sized by tracking-aircraft-count / dashed
   yellow lines from aircraft to top-4 contributing stations
   when geometry diagram on / tier-coloured callsign+NUC+HDOP
   labels for non-OK aircraft.
============================================================ */

export interface MlatFlight {
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
  flights: MlatFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OUTAGE' | 'DEGRADED' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = { OUTAGE:'#ef4444', DEGRADED:'#f59e0b', WATCH:'#0ea5e9', OK:'#10b981', IDLE:'#64748b' }
const TIER_ORDER: Tier[] = ['OUTAGE','DEGRADED','WATCH','OK','IDLE']
const TIER_RANK: Record<Tier, number> = { OUTAGE:0, DEGRADED:1, WATCH:2, OK:3, IDLE:4 }

interface Station {
  id: string; name: string; lat: number; lng: number; elevFt: number
  gainDbi: number; floorDbm: number; jitterNs: number; availPct: number
  net: 'FAA-SBS' | 'EC-WAM' | 'ASIA' | 'OCEANIC'
}

// 48-station catalogue
const STATIONS: Station[] = [
  // FAA SBS / Saab-Sensis WAM US
  { id:'WAM-JFK', name:'JFK Sensor',       lat:40.640, lng:-73.778, elevFt:13,   gainDbi:8, floorDbm:-100, jitterNs:12, availPct:99.8, net:'FAA-SBS' },
  { id:'WAM-EWR', name:'EWR Sensor',       lat:40.692, lng:-74.169, elevFt:18,   gainDbi:8, floorDbm:-100, jitterNs:12, availPct:99.7, net:'FAA-SBS' },
  { id:'WAM-LGA', name:'LGA Sensor',       lat:40.777, lng:-73.872, elevFt:21,   gainDbi:8, floorDbm:-100, jitterNs:13, availPct:99.6, net:'FAA-SBS' },
  { id:'WAM-PHL', name:'PHL Sensor',       lat:39.872, lng:-75.241, elevFt:36,   gainDbi:8, floorDbm:-100, jitterNs:14, availPct:99.5, net:'FAA-SBS' },
  { id:'WAM-BWI', name:'BWI Sensor',       lat:39.175, lng:-76.668, elevFt:146,  gainDbi:8, floorDbm:-100, jitterNs:14, availPct:99.7, net:'FAA-SBS' },
  { id:'WAM-DCA', name:'DCA Sensor',       lat:38.852, lng:-77.038, elevFt:15,   gainDbi:8, floorDbm:-100, jitterNs:13, availPct:99.6, net:'FAA-SBS' },
  { id:'WAM-IAD', name:'IAD Sensor',       lat:38.944, lng:-77.456, elevFt:313,  gainDbi:8, floorDbm:-100, jitterNs:14, availPct:99.5, net:'FAA-SBS' },
  { id:'WAM-BOS', name:'BOS Sensor',       lat:42.363, lng:-71.006, elevFt:20,   gainDbi:8, floorDbm:-100, jitterNs:13, availPct:99.6, net:'FAA-SBS' },
  { id:'WAM-ORD', name:'ORD Sensor',       lat:41.978, lng:-87.905, elevFt:672,  gainDbi:8, floorDbm:-100, jitterNs:12, availPct:99.8, net:'FAA-SBS' },
  { id:'WAM-MDW', name:'MDW Sensor',       lat:41.785, lng:-87.752, elevFt:620,  gainDbi:8, floorDbm:-100, jitterNs:13, availPct:99.5, net:'FAA-SBS' },
  { id:'WAM-ATL', name:'ATL Sensor',       lat:33.640, lng:-84.428, elevFt:1026, gainDbi:8, floorDbm:-100, jitterNs:12, availPct:99.8, net:'FAA-SBS' },
  { id:'WAM-DFW', name:'DFW Sensor',       lat:32.897, lng:-97.038, elevFt:603,  gainDbi:8, floorDbm:-100, jitterNs:13, availPct:99.7, net:'FAA-SBS' },
  { id:'WAM-IAH', name:'IAH Sensor',       lat:29.984, lng:-95.341, elevFt:97,   gainDbi:8, floorDbm:-100, jitterNs:13, availPct:99.6, net:'FAA-SBS' },
  { id:'WAM-DEN', name:'DEN Sensor',       lat:39.862, lng:-104.673,elevFt:5431, gainDbi:8, floorDbm:-100, jitterNs:14, availPct:99.5, net:'FAA-SBS' },
  { id:'WAM-PHX', name:'PHX Sensor',       lat:33.434, lng:-112.012,elevFt:1135, gainDbi:8, floorDbm:-100, jitterNs:13, availPct:99.6, net:'FAA-SBS' },
  { id:'WAM-LAX', name:'LAX Sensor',       lat:33.942, lng:-118.408,elevFt:125,  gainDbi:8, floorDbm:-100, jitterNs:12, availPct:99.8, net:'FAA-SBS' },
  { id:'WAM-SAN', name:'SAN Sensor',       lat:32.733, lng:-117.190,elevFt:17,   gainDbi:8, floorDbm:-100, jitterNs:14, availPct:99.5, net:'FAA-SBS' },
  { id:'WAM-SFO', name:'SFO Sensor',       lat:37.619, lng:-122.375,elevFt:13,   gainDbi:8, floorDbm:-100, jitterNs:13, availPct:99.7, net:'FAA-SBS' },
  { id:'WAM-SEA', name:'SEA Sensor',       lat:47.450, lng:-122.309,elevFt:433,  gainDbi:8, floorDbm:-100, jitterNs:14, availPct:99.5, net:'FAA-SBS' },
  { id:'WAM-MSP', name:'MSP Sensor',       lat:44.882, lng: -93.222,elevFt:841,  gainDbi:8, floorDbm:-100, jitterNs:13, availPct:99.6, net:'FAA-SBS' },
  { id:'WAM-DTW', name:'DTW Sensor',       lat:42.212, lng: -83.349,elevFt:645,  gainDbi:8, floorDbm:-100, jitterNs:13, availPct:99.6, net:'FAA-SBS' },
  { id:'WAM-MCO', name:'MCO Sensor',       lat:28.429, lng: -81.309,elevFt:96,   gainDbi:8, floorDbm:-100, jitterNs:14, availPct:99.5, net:'FAA-SBS' },
  { id:'WAM-MIA', name:'MIA Sensor',       lat:25.793, lng: -80.290,elevFt:8,    gainDbi:8, floorDbm:-100, jitterNs:13, availPct:99.6, net:'FAA-SBS' },
  { id:'WAM-PIT', name:'PIT Sensor',       lat:40.491, lng: -80.232,elevFt:1203, gainDbi:8, floorDbm:-100, jitterNs:14, availPct:99.5, net:'FAA-SBS' },
  // EUROCONTROL WAM-NRA / EFKA Nordic / EGCC NATS UK
  { id:'WAM-EGLL', name:'LHR Sensor',      lat:51.477, lng:-0.461,  elevFt:83,   gainDbi:9, floorDbm:-102, jitterNs:10, availPct:99.9, net:'EC-WAM' },
  { id:'WAM-EGKK', name:'LGW Sensor',      lat:51.148, lng:-0.190,  elevFt:202,  gainDbi:9, floorDbm:-102, jitterNs:11, availPct:99.8, net:'EC-WAM' },
  { id:'WAM-EHAM', name:'AMS Sensor',      lat:52.308, lng: 4.764,  elevFt:-11,  gainDbi:9, floorDbm:-102, jitterNs:10, availPct:99.9, net:'EC-WAM' },
  { id:'WAM-EDDF', name:'FRA Sensor',      lat:50.033, lng: 8.570,  elevFt:364,  gainDbi:9, floorDbm:-102, jitterNs:10, availPct:99.9, net:'EC-WAM' },
  { id:'WAM-EDDM', name:'MUC Sensor',      lat:48.353, lng:11.786,  elevFt:1487, gainDbi:9, floorDbm:-102, jitterNs:11, availPct:99.8, net:'EC-WAM' },
  { id:'WAM-LFPG', name:'CDG Sensor',      lat:49.013, lng: 2.550,  elevFt:392,  gainDbi:9, floorDbm:-102, jitterNs:10, availPct:99.9, net:'EC-WAM' },
  { id:'WAM-LSZH', name:'ZRH Sensor',      lat:47.464, lng: 8.549,  elevFt:1416, gainDbi:9, floorDbm:-102, jitterNs:11, availPct:99.8, net:'EC-WAM' },
  { id:'WAM-LIRF', name:'FCO Sensor',      lat:41.800, lng:12.239,  elevFt:13,   gainDbi:9, floorDbm:-102, jitterNs:12, availPct:99.7, net:'EC-WAM' },
  { id:'WAM-LEMD', name:'MAD Sensor',      lat:40.494, lng:-3.567,  elevFt:1998, gainDbi:9, floorDbm:-102, jitterNs:11, availPct:99.7, net:'EC-WAM' },
  { id:'WAM-LEBL', name:'BCN Sensor',      lat:41.297, lng: 2.078,  elevFt:12,   gainDbi:9, floorDbm:-102, jitterNs:11, availPct:99.7, net:'EC-WAM' },
  { id:'WAM-EKCH', name:'CPH Sensor',      lat:55.617, lng:12.656,  elevFt:17,   gainDbi:9, floorDbm:-102, jitterNs:11, availPct:99.8, net:'EC-WAM' },
  { id:'WAM-ESSA', name:'ARN Sensor',      lat:59.652, lng:17.918,  elevFt:137,  gainDbi:9, floorDbm:-102, jitterNs:12, availPct:99.6, net:'EC-WAM' },
  { id:'WAM-EFHK', name:'HEL Sensor',      lat:60.317, lng:24.963,  elevFt:179,  gainDbi:9, floorDbm:-102, jitterNs:12, availPct:99.6, net:'EC-WAM' },
  { id:'WAM-ENGM', name:'OSL Sensor',      lat:60.194, lng:11.100,  elevFt:681,  gainDbi:9, floorDbm:-102, jitterNs:13, availPct:99.5, net:'EC-WAM' },
  { id:'WAM-LOWW', name:'VIE Sensor',      lat:48.110, lng:16.570,  elevFt:600,  gainDbi:9, floorDbm:-102, jitterNs:11, availPct:99.7, net:'EC-WAM' },
  { id:'WAM-EPWA', name:'WAW Sensor',      lat:52.166, lng:20.967,  elevFt:362,  gainDbi:8, floorDbm:-100, jitterNs:13, availPct:99.4, net:'EC-WAM' },
  // Asia-Pacific
  { id:'WAM-RJTT', name:'HND Sensor',      lat:35.553, lng:139.781, elevFt:35,   gainDbi:9, floorDbm:-101, jitterNs:11, availPct:99.7, net:'ASIA' },
  { id:'WAM-RJAA', name:'NRT Sensor',      lat:35.764, lng:140.386, elevFt:135,  gainDbi:9, floorDbm:-101, jitterNs:12, availPct:99.6, net:'ASIA' },
  { id:'WAM-VHHH', name:'HKG Sensor',      lat:22.308, lng:113.918, elevFt:28,   gainDbi:9, floorDbm:-101, jitterNs:12, availPct:99.6, net:'ASIA' },
  { id:'WAM-WSSS', name:'SIN Sensor',      lat: 1.357, lng:103.989, elevFt:22,   gainDbi:9, floorDbm:-101, jitterNs:12, availPct:99.6, net:'ASIA' },
  { id:'WAM-YSSY', name:'SYD Sensor',      lat:-33.946,lng:151.177, elevFt:21,   gainDbi:9, floorDbm:-101, jitterNs:13, availPct:99.5, net:'ASIA' },
  { id:'WAM-YMML', name:'MEL Sensor',      lat:-37.673,lng:144.843, elevFt:434,  gainDbi:9, floorDbm:-101, jitterNs:13, availPct:99.5, net:'ASIA' },
  // Oceanic supplements (sparse / availability lower)
  { id:'WAM-PHNL', name:'HNL Sensor',      lat:21.318, lng:-157.922,elevFt:13,   gainDbi:10,floorDbm:-104, jitterNs:18, availPct:98.5, net:'OCEANIC' },
  { id:'WAM-PANC', name:'ANC Sensor',      lat:61.174, lng:-149.996,elevFt:152,  gainDbi:10,floorDbm:-104, jitterNs:18, availPct:98.0, net:'OCEANIC' },
  { id:'WAM-BIKF', name:'KEF Sensor',      lat:63.985, lng:-22.605, elevFt:171,  gainDbi:10,floorDbm:-104, jitterNs:18, availPct:98.2, net:'OCEANIC' },
]

const NETS: Station['net'][] = ['FAA-SBS','EC-WAM','ASIA','OCEANIC']

interface Row {
  f: MlatFlight
  tracking: { st: Station; dNm: number; rxDbm: number }[]
  nStations: number
  hdop: number; vdop: number; gdop: number; tdop: number
  posErrM: number
  nuc: number
  reqNuc: number
  latencyS: number
  intgPenalty: number
  sev: { stn: number; gdp: number; vdp: number; lat: number; nuc: number; intg: number }
  score: number
  driver: 'STN' | 'GDP' | 'VDP' | 'LAT' | 'NUC' | 'INTG' | 'NONE'
  tier: Tier
}

const DRIVER_LABEL: Record<Row['driver'], string> = {
  STN:  'Insufficient stations for hyperbolic TDoA solve',
  GDP:  'Geometric DOP exceeds ED-129B § 4.3 PDOP target',
  VDP:  'Vertical DOP elevated — altitude unreliable',
  LAT:  'Surveillance latency exceeds ED-117A § 3.1.5 spec',
  NUC:  'NUC below 5 — 5-NM radar-equivalent separation denied',
  INTG: 'Mode-S 24-bit address integrity flag raised',
  NONE: 'Nominal',
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

function distNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180
  const dφ = (lat2-lat1) * Math.PI/180, dλ = (lng2-lng1) * Math.PI/180
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// Free-space path loss at 1090 MHz; d in km; returns dB
function fspl1090(dKm: number): number {
  if (dKm <= 0) return 0
  return 32.45 + 20 * Math.log10(1090) + 20 * Math.log10(dKm)
}

// Radio horizon nm for transmitter at h ft to receiver at h2 ft
function horizonNm(hTxFt: number, hRxFt: number): number {
  return 1.23 * (Math.sqrt(Math.max(0, hTxFt)) + Math.sqrt(Math.max(0, hRxFt)))
}

// Compute HDOP/VDOP/TDOP from station geometry around aircraft
// Build H matrix (N×4) for ranges normalised to unit vectors + clock; PDOP from trace((HᵀH)⁻¹)
function computeDops(ac: { lat: number; lng: number; altFt: number }, sts: Station[]): { hdop: number; vdop: number; tdop: number; gdop: number } {
  const N = sts.length
  if (N < 4) return { hdop: 99, vdop: 99, tdop: 99, gdop: 99 }
  // Local ENU around aircraft. 1 deg lat ≈ 60 NM ≈ 111120 m; 1 deg lng ≈ cos(lat) × 111120 m
  const mPerDegLat = 111120
  const mPerDegLng = 111120 * Math.cos(ac.lat * Math.PI/180)
  const acAltM = ac.altFt * 0.3048
  // H rows: [ -(xs-x)/r, -(ys-y)/r, -(zs-z)/r, 1 ]
  const H: number[][] = []
  for (const s of sts) {
    const dx = (s.lng - ac.lng) * mPerDegLng
    const dy = (s.lat - ac.lat) * mPerDegLat
    const dz = (s.elevFt * 0.3048) - acAltM
    const r = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1
    H.push([ -dx/r, -dy/r, -dz/r, 1 ])
  }
  // HtH = Hᵀ H (4×4)
  const HtH: number[][] = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0; for (let k = 0; k < N; k++) s += H[k][i] * H[k][j]; HtH[i][j] = s
  }
  // Invert 4×4 via Gauss-Jordan with partial pivoting
  const M: number[][] = HtH.map((r,i) => [...r, ...(i===0?[1,0,0,0]:i===1?[0,1,0,0]:i===2?[0,0,1,0]:[0,0,0,1])])
  for (let col = 0; col < 4; col++) {
    let piv = col
    for (let r = col+1; r < 4; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    if (Math.abs(M[piv][col]) < 1e-12) return { hdop: 99, vdop: 99, tdop: 99, gdop: 99 }
    if (piv !== col) { const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp }
    const p = M[col][col]; for (let j = 0; j < 8; j++) M[col][j] /= p
    for (let r = 0; r < 4; r++) if (r !== col) {
      const f = M[r][col]; for (let j = 0; j < 8; j++) M[r][j] -= f * M[col][j]
    }
  }
  const dx = M[0][4+0], dy = M[1][4+1], dz = M[2][4+2], dt = M[3][4+3]
  const hdop = Math.sqrt(Math.max(0, dx + dy))
  const vdop = Math.sqrt(Math.max(0, dz))
  const tdop = Math.sqrt(Math.max(0, dt))
  const gdop = Math.sqrt(Math.max(0, dx + dy + dz + dt))
  return { hdop, vdop, tdop, gdop }
}

function nucFromEpu(epuM: number): number {
  if (epuM < 27.8)   return 9
  if (epuM < 92.6)   return 8
  if (epuM < 185)    return 7
  if (epuM < 555)    return 6
  if (epuM < 930)    return 5
  if (epuM < 1850)   return 4
  if (epuM < 3700)   return 3
  if (epuM < 7400)   return 2
  if (epuM < 18500)  return 1
  return 0
}

const SRC_HALO = 'mlat-halo', SRC_LBL = 'mlat-lbl', SRC_PIN = 'mlat-pin'
const SRC_STN = 'mlat-stn', SRC_STNLBL = 'mlat-stnlbl', SRC_RAY = 'mlat-ray'
const LYR_HALO = 'mlat-halo-l', LYR_LBL = 'mlat-lbl-l', LYR_PIN = 'mlat-pin-l'
const LYR_STN = 'mlat-stn-l', LYR_STNLBL = 'mlat-stnlbl-l', LYR_RAY = 'mlat-ray-l'

export default function MlatWam({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'STATIONS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [netFilter, setNetFilter] = useState<Station['net'] | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [reqNucSel, setReqNucSel] = useState(5)
  const [jitterMul, setJitterMul] = useState(100)   // 50-300 %
  const [availMin, setAvailMin] = useState(99)      // 95-100 %
  const [latencyMul, setLatencyMul] = useState(100) // 50-300 %
  const [intgRate, setIntgRate] = useState(2)       // 0-15 % dup-ICAO24 flag rate
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showStn, setShowStn] = useState(true)
  const [showRays, setShowRays] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const activeStations = STATIONS.filter(s => s.availPct >= availMin)
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl) continue
      // Find visible stations
      const tracking: { st: Station; dNm: number; rxDbm: number }[] = []
      for (const s of activeStations) {
        const dNm = distNm(f.lat, f.lng, s.lat, s.lng)
        const horizon = horizonNm(f.altitudeFt, s.elevFt + 20)
        if (dNm > horizon) continue
        const dKm = dNm * 1.852
        const txPwrDbm = 51   // typical Mode-S transponder 125 W ≈ +51 dBm
        const rx = txPwrDbm - fspl1090(dKm) + s.gainDbi
        if (rx < s.floorDbm) continue
        tracking.push({ st: s, dNm, rxDbm: rx })
      }
      tracking.sort((a,b) => b.rxDbm - a.rxDbm)
      const top = tracking.slice(0, 8)
      const nStations = top.length
      let hdop = 99, vdop = 99, gdop = 99, tdop = 99, posErrM = 99999, nuc = 0
      if (nStations >= 4) {
        const dops = computeDops({ lat: f.lat, lng: f.lng, altFt: f.altitudeFt }, top.map(t => t.st))
        hdop = dops.hdop; vdop = dops.vdop; gdop = dops.gdop; tdop = dops.tdop
        // Combined jitter scales as 1/√N
        const jitNs = (15 * (jitterMul / 100)) / Math.sqrt(nStations)
        const sigmaTauS = jitNs * 1e-9
        const cM = 299792458
        const sigmaRangeM = cM * sigmaTauS
        posErrM = hdop * sigmaRangeM * 1.4   // 2D √(σx²+σy²) ≈ HDOP × σ_range
        nuc = nucFromEpu(posErrM)
      } else if (nStations >= 1) {
        nuc = 0; posErrM = 50000
      }
      // Synthesised per-aircraft latency 0.5 - 6 s (1.0 nominal)
      const h = hash32(f.icao || '')
      const latencyS = (0.5 + ((h >>> 7) % 60) / 10) * (latencyMul / 100)
      // Integrity flag — dup ICAO24 or SDA=0
      const intgFlag = ((h >>> 13) % 1000) / 10 < intgRate
      const intgPenalty = intgFlag ? 25 : 0

      const reqNuc = reqNucSel
      // Severity components 0-100
      const stnSev = nStations < 4 ? 100 : nStations === 4 ? 80 : nStations === 5 ? 60 : nStations === 6 ? 35 : nStations === 7 ? 15 : 0
      const gdpSev = gdop >= 99 ? 100 : Math.max(0, Math.min(100, (gdop - 1.5) * (100 / 5.5)))
      const vdpSev = vdop >= 99 ? 100 : Math.max(0, Math.min(100, (vdop - 2) * (100 / 8)))
      const latSev = Math.max(0, Math.min(100, (latencyS - 1) * (100 / 7)))
      const nucSev = nuc >= reqNuc ? 0 : Math.max(0, Math.min(100, (reqNuc - nuc) * 25))
      const intgSev = intgPenalty
      const sev = { stn: stnSev, gdp: gdpSev, vdp: vdpSev, lat: latSev, nuc: nucSev, intg: intgSev }
      // Composite — max-driver
      let maxK: Row['driver'] = 'NONE'; let maxV = 0
      const pairs: [Row['driver'], number][] = [['STN',stnSev],['GDP',gdpSev],['VDP',vdpSev],['LAT',latSev],['NUC',nucSev],['INTG',intgSev]]
      for (const [k,v] of pairs) if (v > maxV) { maxV = v; maxK = k }
      const score = Math.max(0, Math.min(100, maxV))

      let tier: Tier
      if (nStations < 4 || nuc <= 2 || score >= 80) tier = 'OUTAGE'
      else if (score >= 55) tier = 'DEGRADED'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({ f, tracking: top, nStations, hdop, vdop, gdop, tdop, posErrM, nuc, reqNuc, latencyS, intgPenalty, sev, score, driver: maxK, tier })
    }
    return out
  }, [flights, minFl, reqNucSel, jitterMul, availMin, latencyMul, intgRate])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { OUTAGE:0, DEGRADED:0, WATCH:0, OK:0, IDLE:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (netFilter !== 'ALL') {
        if (!r.tracking.some(t => t.st.net === netFilter)) return false
      }
      if (q && !(r.f.callsign || r.f.icao || '').toUpperCase().includes(q)) return false
      return true
    }).sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, netFilter, query])

  const stationLoad = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) for (const t of r.tracking) m.set(t.st.id, (m.get(t.st.id) || 0) + 1)
    return m
  }, [rows])

  // ----- Map layer effects -----
  useEffect(() => {
    if (!map) return
    const m = map
    const ensureSrc = (id: string) => {
      if (!m.getSource(id)) m.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } })
    }
    const ensureLyr = (id: string, src: string, type: 'circle'|'symbol'|'line', paint: any, layout?: any) => {
      if (!m.getLayer(id)) {
        const def: any = { id, type, source: src, paint }
        if (layout) def.layout = layout
        m.addLayer(def)
      }
    }
    ensureSrc(SRC_HALO); ensureSrc(SRC_PIN); ensureSrc(SRC_LBL); ensureSrc(SRC_STN); ensureSrc(SRC_STNLBL); ensureSrc(SRC_RAY)
    ensureLyr(LYR_HALO, SRC_HALO, 'circle', { 'circle-radius':['get','r'], 'circle-color':['get','c'], 'circle-opacity':0.18, 'circle-stroke-color':['get','c'], 'circle-stroke-width':1.5, 'circle-stroke-opacity':0.8 })
    ensureLyr(LYR_PIN,  SRC_PIN,  'circle', { 'circle-radius':6, 'circle-color':'#ef4444', 'circle-stroke-color':'#ffffff', 'circle-stroke-width':1.2 })
    ensureLyr(LYR_LBL,  SRC_LBL,  'symbol', { 'text-color':['get','c'], 'text-halo-color':'#0b1220', 'text-halo-width':1.4 }, { 'text-field':['get','t'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-allow-overlap':true })
    ensureLyr(LYR_STN,  SRC_STN,  'circle', { 'circle-radius':['get','r'], 'circle-color':['get','c'], 'circle-opacity':0.55, 'circle-stroke-color':'#ffffff', 'circle-stroke-width':1 })
    ensureLyr(LYR_STNLBL, SRC_STNLBL,'symbol', { 'text-color':'#cbd5e1', 'text-halo-color':'#0b1220', 'text-halo-width':1.4 }, { 'text-field':['get','t'], 'text-size':9, 'text-offset':[0,1.2], 'text-anchor':'top', 'text-allow-overlap':true })
    ensureLyr(LYR_RAY,  SRC_RAY,  'line',   { 'line-color':['get','c'], 'line-width':1, 'line-opacity':0.45, 'line-dasharray':[2,2] })
    return () => {
      for (const id of [LYR_RAY, LYR_STNLBL, LYR_STN, LYR_LBL, LYR_PIN, LYR_HALO]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_RAY, SRC_STNLBL, SRC_STN, SRC_LBL, SRC_PIN, SRC_HALO]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map])

  useEffect(() => {
    if (!map) return
    const m = map
    const halo: any[] = [], pin: any[] = [], lbl: any[] = []
    const stn: any[] = [], stnLbl: any[] = [], ray: any[] = []

    if (showHalo) for (const r of rows) {
      if (r.tier === 'IDLE') continue
      const radius = 8 + (r.score / 100) * 14
      halo.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ r: radius, c: TIER_COLOR[r.tier] } })
    }
    if (showPin) for (const r of rows) {
      if (r.tier === 'OUTAGE') pin.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{} })
    }
    if (showLabels) for (const r of rows) {
      if (r.tier === 'OK' || r.tier === 'IDLE') continue
      const txt = `${r.f.callsign || r.f.icao} · NUC ${r.nuc} · HDOP ${r.hdop >= 99 ? '—' : r.hdop.toFixed(1)} · ${r.nStations}st`
      lbl.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ t: txt, c: TIER_COLOR[r.tier] } })
    }
    if (showStn) for (const s of STATIONS) {
      const load = stationLoad.get(s.id) || 0
      const r = 4 + Math.min(10, Math.sqrt(load) * 2)
      // colour: dim if availability filtered out
      const dim = s.availPct < availMin
      const c = dim ? '#475569' : (load === 0 ? '#64748b' : load < 3 ? '#0ea5e9' : load < 8 ? '#10b981' : '#f59e0b')
      stn.push({ type:'Feature', geometry:{ type:'Point', coordinates:[s.lng, s.lat] }, properties:{ r, c } })
      stnLbl.push({ type:'Feature', geometry:{ type:'Point', coordinates:[s.lng, s.lat] }, properties:{ t: s.id.replace('WAM-','') } })
    }
    if (showRays) for (const r of rows) {
      if (r.tier === 'IDLE' || r.tier === 'OK') continue
      for (const t of r.tracking.slice(0, 4)) {
        ray.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat], [t.st.lng, t.st.lat]] }, properties:{ c: TIER_COLOR[r.tier] } })
      }
    }

    const set = (id: string, feats: any[]) => { const s: any = m.getSource(id); if (s) s.setData({ type:'FeatureCollection', features: feats }) }
    set(SRC_HALO, halo); set(SRC_PIN, pin); set(SRC_LBL, lbl); set(SRC_STN, stn); set(SRC_STNLBL, stnLbl); set(SRC_RAY, ray)
  }, [map, rows, stationLoad, availMin, showHalo, showPin, showLabels, showStn, showRays])

  // ===== SVG scatter: HDOP vs station-count =====
  const scatter = useMemo(() => {
    const W = 320, H = 160, PAD_L = 30, PAD_R = 10, PAD_T = 8, PAD_B = 22
    const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B
    const xMin = 3, xMax = 10           // station count
    const yMin = 0, yMax = 8            // HDOP
    const xPx = (v: number) => PAD_L + ((v - xMin) / (xMax - xMin)) * innerW
    const yPx = (v: number) => PAD_T + (1 - (v - yMin) / (yMax - yMin)) * innerH
    return { W, H, PAD_L, PAD_R, PAD_T, PAD_B, innerW, innerH, xMin, xMax, yMin, yMax, xPx, yPx }
  }, [])

  const meanHdop = useMemo(() => {
    const valid = rows.filter(r => r.hdop < 50)
    return valid.length ? valid.reduce((s,r) => s + r.hdop, 0) / valid.length : 0
  }, [rows])
  const meanNuc = useMemo(() => {
    return rows.length ? rows.reduce((s,r) => s + r.nuc, 0) / rows.length : 0
  }, [rows])
  const worst = useMemo(() => {
    return rows.slice().sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)[0]
  }, [rows])
  const outageShare = useMemo(() => {
    return rows.length ? counts.OUTAGE / rows.length * 100 : 0
  }, [rows, counts])

  // ===== UI =====
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

  const colorForHdop = (h: number) => h >= 99 ? '#ef4444' : h >= 5 ? '#ef4444' : h >= 3.5 ? '#f59e0b' : h >= 2.5 ? '#0ea5e9' : '#10b981'
  const colorForNuc  = (n: number, req: number) => n < req - 2 ? '#ef4444' : n < req ? '#f59e0b' : n === req ? '#0ea5e9' : '#10b981'

  return (
    <div className="fixed top-14 right-3 w-[420px] max-h-[calc(100vh-72px)] bg-slate-950/95 backdrop-blur-xl border border-slate-800/80 rounded-xl shadow-2xl shadow-black/40 flex flex-col text-slate-200 z-30">
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono uppercase tracking-wider text-sky-400">MLAT · WAM</span>
          <span className="text-[10px] text-slate-500 truncate">TDoA Surveillance / GDOP Monitor</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm leading-none">×</button>
      </header>

      <div className="px-3 py-2 border-b border-slate-800/60 flex flex-wrap gap-1.5">
        {TIER_ORDER.map(tierChip)}
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 grid grid-cols-3 gap-1.5 text-[10px] font-mono">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800/70">
          <div className="text-slate-500 text-[9px]">MEAN HDOP</div>
          <div style={{ color: colorForHdop(meanHdop) }}>{meanHdop ? meanHdop.toFixed(2) : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800/70 col-span-1">
          <div className="text-slate-500 text-[9px]">WORST</div>
          <div className="truncate" style={{ color: worst ? TIER_COLOR[worst.tier] : '#64748b' }}>{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800/70">
          <div className="text-slate-500 text-[9px]">OUTAGE</div>
          <div style={{ color: counts.OUTAGE > 0 ? TIER_COLOR.OUTAGE : '#64748b' }}>{counts.OUTAGE}</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 grid grid-cols-2 gap-1.5 text-[10px] font-mono">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800/70">
          <div className="text-slate-500 text-[9px]">MEAN NUC</div>
          <div style={{ color: colorForNuc(Math.round(meanNuc), reqNucSel) }}>{meanNuc.toFixed(1)} / req {reqNucSel}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800/70">
          <div className="text-slate-500 text-[9px]">OUTAGE SHARE</div>
          <div style={{ color: outageShare >= 25 ? '#ef4444' : outageShare >= 10 ? '#f59e0b' : '#10b981' }}>{outageShare.toFixed(0)} %</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800/60">
          <div className="text-[9px] font-mono uppercase tracking-wider text-slate-500 mb-1">HDOP × stations</div>
          <svg width={scatter.W} height={scatter.H} className="block">
            {/* Bands */}
            <rect x={scatter.PAD_L} y={scatter.yPx(8)} width={scatter.innerW} height={scatter.yPx(5)-scatter.yPx(8)} fill="#ef4444" opacity={0.10}/>
            <rect x={scatter.PAD_L} y={scatter.yPx(5)} width={scatter.innerW} height={scatter.yPx(3.5)-scatter.yPx(5)} fill="#f59e0b" opacity={0.10}/>
            <rect x={scatter.PAD_L} y={scatter.yPx(3.5)} width={scatter.innerW} height={scatter.yPx(2.5)-scatter.yPx(3.5)} fill="#0ea5e9" opacity={0.10}/>
            <rect x={scatter.PAD_L} y={scatter.yPx(2.5)} width={scatter.innerW} height={scatter.yPx(0)-scatter.yPx(2.5)} fill="#10b981" opacity={0.10}/>
            {/* Threshold lines */}
            <line x1={scatter.PAD_L} y1={scatter.yPx(2.5)} x2={scatter.PAD_L+scatter.innerW} y2={scatter.yPx(2.5)} stroke="#0ea5e9" strokeOpacity={0.5} strokeDasharray="3 3"/>
            <line x1={scatter.PAD_L} y1={scatter.yPx(5)}   x2={scatter.PAD_L+scatter.innerW} y2={scatter.yPx(5)}   stroke="#ef4444" strokeOpacity={0.55} strokeDasharray="3 3"/>
            {/* Min-4 station vertical */}
            <line x1={scatter.xPx(4)} y1={scatter.PAD_T} x2={scatter.xPx(4)} y2={scatter.PAD_T+scatter.innerH} stroke="#ef4444" strokeOpacity={0.4} strokeDasharray="2 2"/>
            {/* Ticks */}
            {[3,4,5,6,7,8,9,10].map(v => (
              <g key={v}>
                <line x1={scatter.xPx(v)} y1={scatter.PAD_T+scatter.innerH} x2={scatter.xPx(v)} y2={scatter.PAD_T+scatter.innerH+3} stroke="#475569"/>
                <text x={scatter.xPx(v)} y={scatter.H-6} fontSize={8} fill="#64748b" textAnchor="middle" fontFamily="monospace">{v}</text>
              </g>
            ))}
            {[0,2,3.5,5,8].map(v => (
              <g key={v}>
                <line x1={scatter.PAD_L-3} y1={scatter.yPx(v)} x2={scatter.PAD_L} y2={scatter.yPx(v)} stroke="#475569"/>
                <text x={scatter.PAD_L-5} y={scatter.yPx(v)+3} fontSize={8} fill="#64748b" textAnchor="end" fontFamily="monospace">{v}</text>
              </g>
            ))}
            {/* Points */}
            {rows.map((r,i) => {
              if (r.tier === 'IDLE') return null
              const x = scatter.xPx(Math.min(scatter.xMax, Math.max(scatter.xMin, r.nStations)))
              const y = scatter.yPx(Math.min(scatter.yMax, r.hdop >= 99 ? scatter.yMax : r.hdop))
              return <circle key={i} cx={x} cy={y} r={2.2} fill={TIER_COLOR[r.tier]} opacity={0.85}/>
            })}
            <text x={scatter.PAD_L+scatter.innerW/2} y={scatter.H-1} fontSize={7} fill="#64748b" textAnchor="middle" fontFamily="monospace">stations tracking</text>
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800/60 grid grid-cols-2 gap-2 text-[10px] font-mono">
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-[9px]">MIN FL {minFl}</span>
          <input type="range" min={0} max={400} step={10} value={minFl} onChange={e=>setMinFl(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-[9px]">REQ NUC {reqNucSel}</span>
          <input type="range" min={2} max={9} step={1} value={reqNucSel} onChange={e=>setReqNucSel(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-[9px]">JITTER {jitterMul}%</span>
          <input type="range" min={50} max={300} step={10} value={jitterMul} onChange={e=>setJitterMul(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-[9px]">AVAIL ≥ {availMin}%</span>
          <input type="range" min={95} max={100} step={0.1} value={availMin} onChange={e=>setAvailMin(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-[9px]">LATENCY {latencyMul}%</span>
          <input type="range" min={50} max={300} step={10} value={latencyMul} onChange={e=>setLatencyMul(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500 text-[9px]">INTG-FLAG {intgRate}%</span>
          <input type="range" min={0} max={15} step={1} value={intgRate} onChange={e=>setIntgRate(+e.target.value)} className="accent-sky-500"/>
        </label>
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 flex flex-wrap gap-1">
        {(['ALL', ...NETS] as const).map(n => (
          <button key={n} onClick={() => setNetFilter(n === 'ALL' ? 'ALL' : n as Station['net'])}
            className={`px-1.5 py-0.5 rounded text-[9px] font-mono border ${netFilter === n ? 'border-sky-500/60 bg-sky-500/15 text-sky-200' : 'border-slate-700/70 bg-slate-900/40 text-slate-400 hover:bg-slate-800/60'}`}>
            {n}
          </button>
        ))}
        <span className="flex-1" />
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLabels,setShowLabels],['STN',showStn,setShowStn],['RAY',showRays,setShowRays],['DIAG',showDiag,setShowDiag]] as const).map(([k,v,s]) => (
          <button key={k} onClick={() => s(!v)}
            className={`px-1.5 py-0.5 rounded text-[9px] font-mono border ${v ? 'border-sky-500/60 bg-sky-500/15 text-sky-200' : 'border-slate-700/70 bg-slate-900/40 text-slate-500 hover:bg-slate-800/60'}`}>
            {k}
          </button>
        ))}
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 flex items-center gap-2">
        <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="search callsign / icao"
          className="flex-1 px-2 py-1 rounded bg-slate-900/60 border border-slate-800/80 text-[11px] font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/60"/>
        <div className="flex gap-1">
          {(['AIRCRAFT','STATIONS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-2 py-1 rounded text-[9px] font-mono uppercase border ${tab === t ? 'border-sky-500/60 bg-sky-500/15 text-sky-200' : 'border-slate-700/70 bg-slate-900/40 text-slate-400 hover:bg-slate-800/60'}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="text-[11px] font-mono text-slate-600 text-center py-6">no aircraft match filters</div>
        )}
        {tab === 'AIRCRAFT' && filtered.map((r, i) => (
          <div key={i} onClick={() => onFly(r.f.icao)}
            className="px-2 py-1.5 rounded bg-slate-900/50 border border-slate-800/70 hover:border-sky-500/40 hover:bg-slate-900/80 transition cursor-pointer relative overflow-hidden">
            <span className="absolute left-0 top-0 bottom-0 w-1" style={{ background: TIER_COLOR[r.tier] }}/>
            <div className="pl-2 flex items-center justify-between gap-2 text-[11px] font-mono">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-slate-100">{r.f.callsign || r.f.icao}</span>
                <span className="text-slate-600 text-[9px]">{r.f.type || ''}</span>
                {tierPill(r.tier)}
                <span className="px-1 py-0.5 rounded text-[8px] font-mono bg-slate-800/60 text-slate-400">{r.nStations} st</span>
              </div>
              <span className="text-slate-500 text-[9px]">FL{Math.round(r.f.altitudeFt/100)}</span>
            </div>
            <div className="pl-2 mt-1 flex items-center gap-1">
              <div className="flex-1 h-1.5 rounded bg-slate-800/70 overflow-hidden">
                <div className="h-full" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }}/>
              </div>
              <span className="text-[9px] font-mono text-slate-500 w-7 text-right">{Math.round(r.score)}</span>
            </div>
            <div className="pl-2 mt-1 grid grid-cols-6 gap-1 text-[8px] font-mono">
              <span className="px-1 py-0.5 rounded text-center" style={{ background:'#0b1220', color: r.sev.stn>50?'#ef4444':r.sev.stn>25?'#f59e0b':'#94a3b8', border:`1px solid ${r.sev.stn>50?'#ef444466':'#33415566'}` }}>STN {r.nStations}</span>
              <span className="px-1 py-0.5 rounded text-center" style={{ background:'#0b1220', color: colorForHdop(r.hdop), border:`1px solid ${colorForHdop(r.hdop)}55` }}>HDOP {r.hdop>=99?'—':r.hdop.toFixed(1)}</span>
              <span className="px-1 py-0.5 rounded text-center" style={{ background:'#0b1220', color: r.vdop>=99?'#ef4444':r.vdop>5?'#f59e0b':'#94a3b8', border:`1px solid ${r.vdop>=99?'#ef444455':'#33415566'}` }}>VDOP {r.vdop>=99?'—':r.vdop.toFixed(1)}</span>
              <span className="px-1 py-0.5 rounded text-center" style={{ background:'#0b1220', color: colorForNuc(r.nuc, r.reqNuc), border:`1px solid ${colorForNuc(r.nuc, r.reqNuc)}55` }}>NUC {r.nuc}</span>
              <span className="px-1 py-0.5 rounded text-center" style={{ background:'#0b1220', color: r.latencyS>4?'#ef4444':r.latencyS>2?'#f59e0b':'#94a3b8', border:'1px solid #33415566' }}>{r.latencyS.toFixed(1)}s</span>
              <span className="px-1 py-0.5 rounded text-center" style={{ background:'#0b1220', color: r.intgPenalty>0?'#ef4444':'#94a3b8', border:`1px solid ${r.intgPenalty>0?'#ef444455':'#33415566'}` }}>{r.intgPenalty>0?'INTG!':'INTG·OK'}</span>
            </div>
            <div className="pl-2 mt-1 text-[9px] font-mono text-slate-500 truncate">
              {r.posErrM < 50000 ? `EPU ${r.posErrM<1000?r.posErrM.toFixed(0)+' m':(r.posErrM/1000).toFixed(2)+' km'}` : 'EPU n/a'}
              <span className="mx-1 text-slate-700">·</span>
              GDOP {r.gdop>=99?'—':r.gdop.toFixed(1)}
              <span className="mx-1 text-slate-700">·</span>
              TDOP {r.tdop>=99?'—':r.tdop.toFixed(1)}
            </div>
            <div className="pl-2 mt-0.5 text-[9px] font-mono truncate" style={{ color: TIER_COLOR[r.tier] }}>
              {r.driver === 'STN'  && '› insufficient stations — ATC procedural sep per Doc 4444 ch 6'}
              {r.driver === 'GDP'  && '› GDOP > ED-129B target — request additional reports'}
              {r.driver === 'VDP'  && '› VDOP elevated — Mode-C altitude crosscheck advised'}
              {r.driver === 'LAT'  && '› latency exceeds ED-117A spec — track age elevated'}
              {r.driver === 'NUC'  && '› NUC below 5 — 5-NM radar-equiv sep denied per JO 7110.65 5-5-4'}
              {r.driver === 'INTG' && '› Mode-S 24-bit integrity flag — verify SDA / dup-ICAO24'}
              {r.driver === 'NONE' && '› all surveillance components within spec'}
            </div>
          </div>
        ))}

        {tab === 'STATIONS' && STATIONS.filter(s => netFilter === 'ALL' || s.net === netFilter).map(s => {
          const load = stationLoad.get(s.id) || 0
          const dim = s.availPct < availMin
          const stripeColor = dim ? '#475569' : load === 0 ? '#64748b' : load < 3 ? '#0ea5e9' : load < 8 ? '#10b981' : '#f59e0b'
          return (
            <div key={s.id} className="px-2 py-1.5 rounded bg-slate-900/50 border border-slate-800/70 relative overflow-hidden">
              <span className="absolute left-0 top-0 bottom-0 w-1" style={{ background: stripeColor }}/>
              <div className="pl-2 flex items-center justify-between text-[11px] font-mono">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-slate-100">{s.id.replace('WAM-','')}</span>
                  <span className="text-slate-600 text-[9px] truncate">{s.name}</span>
                  <span className="px-1 py-0.5 rounded text-[8px] bg-slate-800/60 text-slate-400">{s.net}</span>
                </div>
                <span className="text-[9px] font-mono" style={{ color: stripeColor }}>{load} ac</span>
              </div>
              <div className="pl-2 mt-1 grid grid-cols-4 gap-1 text-[8px] font-mono text-slate-500">
                <span>gain {s.gainDbi} dBi</span>
                <span>floor {s.floorDbm} dBm</span>
                <span>σ {s.jitterNs} ns</span>
                <span className={dim ? 'text-rose-400' : 'text-slate-400'}>avail {s.availPct.toFixed(1)}%</span>
              </div>
              <div className="pl-2 mt-1 text-[9px] font-mono text-slate-500 truncate">
                {dim ? '› below AVAIL-MIN — excluded from solve' : `› horizon @ FL350: ${Math.round(horizonNm(35000, s.elevFt))} nm`}
              </div>
            </div>
          )
        })}
      </div>

      <footer className="px-3 py-1.5 border-t border-slate-800/80 text-[9px] font-mono text-slate-600 flex items-center justify-between">
        <span>ED-129B · ED-117A · DO-260B · Doc 9924 · 7110.65 5-5-4</span>
        <span>{rows.length} ac · {STATIONS.length} st</span>
      </footer>
    </div>
  )
}
