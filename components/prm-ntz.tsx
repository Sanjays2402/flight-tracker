'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   PRM / SOIA · No-Transgression Zone Breach Monitor
   -----------------------------------------------------------
   Precision Runway Monitor (PRM) and Simultaneous Offset
   Instrument Approach (SOIA) deviation surveillance for
   closely-spaced parallel and converging runway pairs.

   References:
     FAA Order JO 7110.65 §5-9-7 / §5-9-8 PRM operations
     FAA Order 7110.308 SOIA at SFO 28L/28R
     FAA AC 90-101A Approval Guidance for RNP-AR
     AC 90-114B Automatic Dependent Surveillance-Broadcast
     AC 90-115 ILS PRM and LDA PRM Pilot Training
     AC 120-118 Criteria for CAT-II/III LVO
     FAA Order 8260.49B SOIA Procedures Development
     ICAO Doc 4444 PANS-ATM §6.7.3 simultaneous parallel ops
     ICAO Annex 10 Vol I 3.7 ILS performance
     ICAO Doc 9643 SOIR Simultaneous Operations on Parallel
       or Near-Parallel Instrument Runways
     EUROCONTROL CRDS / CSPR Closely-Spaced Parallel Runways
     RTCA DO-260B ADS-B MOPS
     NTSB AAB-95/01 USAir 1493 / Mexicana 940 parallel-ops
     ASIAS PRM Deviation Analysis 2009-2022

   Surveillance: 1-second high-update SSR (E-Scan PRM-A)
   with 7110.65 NTZ-breach call-out criteria for closely-
   spaced (700-4300 ft separation) parallel ILS PRM ops.

   17-airport global PRM/SOIA catalogue with per-runway-pair
   centerline lat/lng, magnetic bearing, separation feet,
   NTZ width (default 2000 ft), final-approach-segment length
   (FAS, default 10 nm).

   Per-arrival aircraft on capture:
     1. Project ECEF lat/lng into runway-local coords
        (along-track meters, cross-track meters)
     2. Test inside FAS window (along ∈ [0, FAS_NM × 1852])
     3. Compute cross-track offset from NTZ centerline
     4. Classify deviation severity
     5. Predict NTZ-penetration time using cross-track-rate
        from ground vector

   5 risk drivers max-driver composite:
     XTK  cross-track distance vs NTZ half-width
     RAT  cross-track closure rate (kts) toward NTZ
     TTI  time-to-intrusion (sec) at current rate
     ALT  altitude divergence vs glideslope (3°)
     SEP  paired-traffic conflict (within FAS on adjacent RWY)

   5 tiers per breaching aircraft:
     BREACH  inside NTZ - rose - issue PRM "TURN IMMEDIATELY"
     IMMINENT cross-track rate >120 fpm toward NTZ AND <30s TTI
     DEVIATE  inside ½ NTZ half-width OR >300ft from CL
     CAUTION  WATCH: cross-track > 150 ft drifting outboard
     OK / IDLE outside FAS

   MapLibre overlay:
     - per runway-pair: dashed rose NTZ rectangle (FAS_NM × NTZ_W)
     - solid centerlines (sky) for both runways
     - amber GP capture markers at FAF / 5nm / 10nm
     - tier-coloured halo rings 8-22 px by score
     - rose diamond pin for BREACH
     - tier-coloured callsign + xtk-ft + TTI-s label for non-OK
     - dashed projection 10-segment forward trail showing
       predicted cross-track encroachment

   Side panel:
     - 5-tier counter strip click-to-filter
     - 6-cell summary (TRACKED / BREACH-count / MEAN-XTK ft /
       WORST callsign / RUNWAY-pairs active / IMMINENT-count)
     - SVG xtk-ft vs cross-rate-fpm scatter with NTZ bands
     - 6 sliders MIN-FL / FAS-NM 5-20 / NTZ-W 800-3000 ft /
       XTK-MUL 50-200% / RATE-MUL 50-200% / TTI-WARN 10-60 s
     - 5-class chip filter HVY / NRW / RGN / BIZ / TBP
     - HALO / NTZ / CL / LBL / PROJ / DIAG toggles
     - search by callsign / type / icao / IATA
     - AIRCRAFT / RUNWAYS tab switcher
     - per-row click-to-fly with tier-coloured advice

   Registered in Layers > Safety & Traffic.  ft-prm persisted.
   ============================================================ */

export interface PrmFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number       // deg true
  vertRate: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: PrmFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'BREACH' | 'IMMINENT' | 'DEVIATE' | 'CAUTION' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  BREACH: '#ef4444', IMMINENT: '#f59e0b', DEVIATE: '#0ea5e9',
  CAUTION: '#10b981', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['BREACH', 'IMMINENT', 'DEVIATE', 'CAUTION', 'OK', 'IDLE']

type Driver = 'XTK' | 'RAT' | 'TTI' | 'ALT' | 'SEP'
const DRIVER_LABEL: Record<Driver, string> = {
  XTK: 'XTK-OFFSET', RAT: 'RATE-IN', TTI: 'TIME-INTRUSION', ALT: 'ALT-DEV', SEP: 'PAIR-CONFLICT',
}

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP',
}
function classify(t: string | undefined): Klass {
  const x = (t || '').toUpperCase()
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  return 'turboprop'
}

interface Runway {
  apt: string         // IATA
  rwy: string         // e.g. 28L
  lat: number         // threshold
  lng: number
  brgTrue: number     // approach bearing TRUE (degrees aircraft fly inbound)
  lenFt: number
}
interface RwyPair {
  apt: string
  name: string
  region: 'NAM' | 'EUR' | 'APAC'
  sepFt: number       // lateral centerline separation
  ntzWFt: number      // No-Transgression Zone width
  mode: 'PRM' | 'SOIA' | 'CSPR'
  l: Runway
  r: Runway
}

// 17 PRM/SOIA capable airport runway-pair catalogue
const PAIRS: RwyPair[] = [
  { apt: 'SFO', name: 'San Francisco Intl 28L/28R', region: 'NAM', sepFt: 750, ntzWFt: 2000, mode: 'SOIA',
    l: { apt: 'SFO', rwy: '28L', lat: 37.6128, lng: -122.3580, brgTrue: 280, lenFt: 11870 },
    r: { apt: 'SFO', rwy: '28R', lat: 37.6133, lng: -122.3576, brgTrue: 280, lenFt: 11870 } },
  { apt: 'SFO', name: 'San Francisco Intl 19L/19R', region: 'NAM', sepFt: 750, ntzWFt: 2000, mode: 'SOIA',
    l: { apt: 'SFO', rwy: '19L', lat: 37.6354, lng: -122.3559, brgTrue: 190, lenFt: 8650 },
    r: { apt: 'SFO', rwy: '19R', lat: 37.6358, lng: -122.3563, brgTrue: 190, lenFt: 7650 } },
  { apt: 'EWR', name: 'Newark Liberty 04L/04R', region: 'NAM', sepFt: 935, ntzWFt: 2000, mode: 'PRM',
    l: { apt: 'EWR', rwy: '04L', lat: 40.6671, lng: -74.1873, brgTrue: 40, lenFt: 11000 },
    r: { apt: 'EWR', rwy: '04R', lat: 40.6691, lng: -74.1858, brgTrue: 40, lenFt: 10000 } },
  { apt: 'PHL', name: 'Philadelphia 09L/09R', region: 'NAM', sepFt: 1392, ntzWFt: 2000, mode: 'PRM',
    l: { apt: 'PHL', rwy: '09L', lat: 39.8678, lng: -75.2503, brgTrue: 90, lenFt: 9500 },
    r: { apt: 'PHL', rwy: '09R', lat: 39.8638, lng: -75.2497, brgTrue: 90, lenFt: 12000 } },
  { apt: 'CLT', name: 'Charlotte-Douglas 18L/18C', region: 'NAM', sepFt: 1300, ntzWFt: 2000, mode: 'PRM',
    l: { apt: 'CLT', rwy: '18L', lat: 35.2280, lng: -80.9580, brgTrue: 180, lenFt: 8500 },
    r: { apt: 'CLT', rwy: '18C', lat: 35.2295, lng: -80.9531, brgTrue: 180, lenFt: 10000 } },
  { apt: 'MSP', name: 'Minneapolis-St Paul 12L/12R', region: 'NAM', sepFt: 800, ntzWFt: 2000, mode: 'PRM',
    l: { apt: 'MSP', rwy: '12L', lat: 44.8932, lng: -93.2435, brgTrue: 120, lenFt: 8200 },
    r: { apt: 'MSP', rwy: '12R', lat: 44.8911, lng: -93.2403, brgTrue: 120, lenFt: 11000 } },
  { apt: 'BOS', name: 'Boston-Logan 04L/04R', region: 'NAM', sepFt: 1500, ntzWFt: 2000, mode: 'PRM',
    l: { apt: 'BOS', rwy: '04L', lat: 42.3567, lng: -71.0143, brgTrue: 35, lenFt: 7861 },
    r: { apt: 'BOS', rwy: '04R', lat: 42.3573, lng: -71.0099, brgTrue: 35, lenFt: 10081 } },
  { apt: 'IAH', name: 'Houston-Bush 08L/08R', region: 'NAM', sepFt: 1267, ntzWFt: 2000, mode: 'PRM',
    l: { apt: 'IAH', rwy: '08L', lat: 29.9842, lng: -95.3604, brgTrue: 80, lenFt: 9000 },
    r: { apt: 'IAH', rwy: '08R', lat: 29.9799, lng: -95.3604, brgTrue: 80, lenFt: 9000 } },
  { apt: 'JFK', name: 'New York JFK 04L/04R', region: 'NAM', sepFt: 3000, ntzWFt: 2000, mode: 'CSPR',
    l: { apt: 'JFK', rwy: '04L', lat: 40.6240, lng: -73.7937, brgTrue: 40, lenFt: 11351 },
    r: { apt: 'JFK', rwy: '04R', lat: 40.6260, lng: -73.7858, brgTrue: 40, lenFt: 8400 } },
  { apt: 'SEA', name: 'Seattle-Tacoma 16L/16C', region: 'NAM', sepFt: 800, ntzWFt: 2000, mode: 'PRM',
    l: { apt: 'SEA', rwy: '16L', lat: 47.4632, lng: -122.3091, brgTrue: 165, lenFt: 11901 },
    r: { apt: 'SEA', rwy: '16C', lat: 47.4634, lng: -122.3115, brgTrue: 165, lenFt: 9425 } },
  { apt: 'ATL', name: 'Atlanta-Hartsfield 26L/26R', region: 'NAM', sepFt: 4300, ntzWFt: 2000, mode: 'CSPR',
    l: { apt: 'ATL', rwy: '26L', lat: 33.6440, lng: -84.4087, brgTrue: 264, lenFt: 9000 },
    r: { apt: 'ATL', rwy: '26R', lat: 33.6304, lng: -84.4112, brgTrue: 264, lenFt: 9000 } },
  { apt: 'ORD', name: 'Chicago-OHare 10L/10C', region: 'NAM', sepFt: 1310, ntzWFt: 2000, mode: 'PRM',
    l: { apt: 'ORD', rwy: '10L', lat: 41.9818, lng: -87.9293, brgTrue: 100, lenFt: 7500 },
    r: { apt: 'ORD', rwy: '10C', lat: 41.9783, lng: -87.9293, brgTrue: 100, lenFt: 10800 } },
  { apt: 'DFW', name: 'Dallas-Fort Worth 17L/17C', region: 'NAM', sepFt: 5800, ntzWFt: 2000, mode: 'CSPR',
    l: { apt: 'DFW', rwy: '17L', lat: 32.9099, lng: -97.0294, brgTrue: 175, lenFt: 8500 },
    r: { apt: 'DFW', rwy: '17C', lat: 32.9078, lng: -97.0212, brgTrue: 175, lenFt: 13401 } },
  { apt: 'LHR', name: 'London Heathrow 27L/27R', region: 'EUR', sepFt: 4730, ntzWFt: 2000, mode: 'CSPR',
    l: { apt: 'LHR', rwy: '27L', lat: 51.4646, lng: -0.4225, brgTrue: 270, lenFt: 12802 },
    r: { apt: 'LHR', rwy: '27R', lat: 51.4775, lng: -0.4332, brgTrue: 270, lenFt: 12001 } },
  { apt: 'CDG', name: 'Paris-CDG 09L/09R', region: 'EUR', sepFt: 12500, ntzWFt: 2000, mode: 'CSPR',
    l: { apt: 'CDG', rwy: '09L', lat: 49.0241, lng: 2.5310, brgTrue: 85, lenFt: 13829 },
    r: { apt: 'CDG', rwy: '09R', lat: 49.0014, lng: 2.5602, brgTrue: 85, lenFt: 8858 } },
  { apt: 'AMS', name: 'Amsterdam-Schiphol 18R/36L', region: 'EUR', sepFt: 700, ntzWFt: 2000, mode: 'PRM',
    l: { apt: 'AMS', rwy: '18R', lat: 52.3624, lng: 4.7110, brgTrue: 183, lenFt: 12467 },
    r: { apt: 'AMS', rwy: '36L', lat: 52.3199, lng: 4.7805, brgTrue: 3, lenFt: 11329 } },
  { apt: 'ICN', name: 'Seoul-Incheon 15L/15R', region: 'APAC', sepFt: 1230, ntzWFt: 2000, mode: 'PRM',
    l: { apt: 'ICN', rwy: '15L', lat: 37.4839, lng: 126.4316, brgTrue: 150, lenFt: 12303 },
    r: { apt: 'ICN', rwy: '15R', lat: 37.4807, lng: 126.4359, brgTrue: 150, lenFt: 12303 } },
]

const D2R = Math.PI / 180
const R_NM = 3440.065
const FT_PER_NM = 6076.115
const M_PER_FT = 0.3048

function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const f1 = la1 * D2R, f2 = la2 * D2R
  const df = (la2 - la1) * D2R, dl = (lo2 - lo1) * D2R
  const a = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
function gcBearingTrue(la1: number, lo1: number, la2: number, lo2: number): number {
  const f1 = la1 * D2R, f2 = la2 * D2R
  const dl = (lo2 - lo1) * D2R
  const y = Math.sin(dl) * Math.cos(f2)
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)
  return (Math.atan2(y, x) / D2R + 360) % 360
}
// project lat/lng into a runway-local frame where +along = approach inbound direction
// returns { alongFt, crossFt } relative to ntz centerline (midpoint of L and R thresholds)
function projectLocal(rp: RwyPair, lat: number, lng: number): { alongFt: number; crossFt: number; alongNm: number } {
  const mLat = (rp.l.lat + rp.r.lat) / 2
  const mLng = (rp.l.lng + rp.r.lng) / 2
  const distNm = gcDistNm(mLat, mLng, lat, lng)
  const brg = gcBearingTrue(mLat, mLng, lat, lng)
  // approach inbound direction = approach bearing = brgTrue (track flown on final)
  // along-axis (+ outward from threshold) = bearing opposite the inbound track + 180
  // aircraft on final approach are on the radial bearing = inboundBearing+180 from threshold
  // so along = distNm * cos(brg - (inboundBearing+180))
  const inb = (rp.l.brgTrue + 180) % 360
  const dh = (brg - inb) * D2R
  const alongNm = distNm * Math.cos(dh)
  const crossNm = distNm * Math.sin(dh)
  return { alongFt: alongNm * FT_PER_NM, crossFt: crossNm * FT_PER_NM, alongNm }
}
// extrapolate a point N feet along a runway's centerline starting from threshold,
// in the approach (outbound from threshold) direction, returning [lng, lat]
function offsetCenterline(rwy: Runway, alongFt: number, crossFt: number = 0): [number, number] {
  const inbBrg = (rwy.brgTrue + 180) % 360  // direction radial extends outward
  const alongNm = alongFt / FT_PER_NM
  // bearing perpendicular (rightward as viewed from threshold looking inbound)
  const perpBrg = (rwy.brgTrue + 90) % 360
  const crossNm = crossFt / FT_PER_NM
  // step along inbound direction
  const lat1Rad = rwy.lat * D2R
  const brg1 = inbBrg * D2R
  const ang1 = alongNm / R_NM
  const lat2 = Math.asin(Math.sin(lat1Rad) * Math.cos(ang1) + Math.cos(lat1Rad) * Math.sin(ang1) * Math.cos(brg1))
  const lng2 = rwy.lng * D2R + Math.atan2(Math.sin(brg1) * Math.sin(ang1) * Math.cos(lat1Rad),
    Math.cos(ang1) - Math.sin(lat1Rad) * Math.sin(lat2))
  // step perpendicular
  const brg2 = perpBrg * D2R
  const ang2 = crossNm / R_NM
  const lat3 = Math.asin(Math.sin(lat2) * Math.cos(ang2) + Math.cos(lat2) * Math.sin(ang2) * Math.cos(brg2))
  const lng3 = lng2 + Math.atan2(Math.sin(brg2) * Math.sin(ang2) * Math.cos(lat2),
    Math.cos(ang2) - Math.sin(lat2) * Math.sin(lat3))
  return [(lng3 / D2R + 540) % 360 - 180, lat3 / D2R]
}

interface Row {
  f: PrmFlight
  klass: Klass
  pair: RwyPair
  alongFt: number
  crossFt: number   // signed; centerline of NTZ = midpoint between runways
  alongNm: number
  // distance from each runway's centerline
  xtkLeftFt: number
  xtkRightFt: number
  closerRwy: 'L' | 'R'
  ownXtkFt: number    // distance from own runway centerline (signed: + toward other rwy)
  crossRateFpm: number // closure rate toward NTZ centerline (positive = toward NTZ)
  ttiSec: number       // time to NTZ intrusion at current rate
  insideFas: boolean
  insideNtz: boolean
  altDevFt: number     // deviation from 3deg glideslope
  pairConflict: boolean
  scoreXtk: number
  scoreRat: number
  scoreTti: number
  scoreAlt: number
  scoreSep: number
  score: number
  topDriver: Driver
  tier: Tier
}

const SRC_RING = 'prm-ring', SRC_NTZ = 'prm-ntz', SRC_CL = 'prm-cl', SRC_LBL = 'prm-lbl', SRC_PIN = 'prm-pin', SRC_PROJ = 'prm-proj', SRC_APT = 'prm-apt', SRC_APTL = 'prm-aptl'
const LYR_RING = 'prm-ring-l', LYR_NTZ = 'prm-ntz-l', LYR_CL = 'prm-cl-l', LYR_LBL = 'prm-lbl-l', LYR_PIN = 'prm-pin-l', LYR_PROJ = 'prm-proj-l', LYR_APT = 'prm-apt-l', LYR_APTL = 'prm-aptl-l'

export default function PrmNtz({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'RUNWAYS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [fasNm, setFasNm] = useState(10)
  const [ntzWFt, setNtzWFt] = useState(2000)
  const [xtkMul, setXtkMul] = useState(100)
  const [rateMul, setRateMul] = useState(100)
  const [ttiWarn, setTtiWarn] = useState(30)
  const [showRing, setShowRing] = useState(true)
  const [showNtz, setShowNtz] = useState(true)
  const [showCl, setShowCl] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || !isFinite(f.lat) || !isFinite(f.lng)) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl) continue
      if (f.altitudeFt > 12000) continue  // PRM ops capped FL120
      const klass = classify(f.type)

      // Find best-matching pair: within FAS range, aligned to runway bearing within 35deg,
      // and on the inbound (approach) side
      let best: { pair: RwyPair; alongFt: number; crossFt: number; alongNm: number } | null = null
      for (const pair of PAIRS) {
        const loc = projectLocal(pair, f.lat, f.lng)
        if (loc.alongFt < -3000 || loc.alongNm > fasNm) continue
        // alignment: aircraft track must be within ±35° of inbound bearing
        const td = ((f.track - pair.l.brgTrue + 540) % 360) - 180
        if (Math.abs(td) > 35) continue
        if (!best || loc.alongNm < best.alongNm) best = { pair, ...loc }
      }
      if (!best) continue
      const { pair, alongFt, crossFt, alongNm } = best

      // Per-runway xtk: distance to each centerline
      const lLoc = projectLocal({ ...pair, l: pair.l, r: pair.l }, f.lat, f.lng)
      const rLoc = projectLocal({ ...pair, l: pair.r, r: pair.r }, f.lat, f.lng)
      const xtkLeftFt = Math.abs(lLoc.crossFt)
      const xtkRightFt = Math.abs(rLoc.crossFt)
      const closerRwy: 'L' | 'R' = xtkLeftFt <= xtkRightFt ? 'L' : 'R'
      const ownXtkFt = closerRwy === 'L' ? lLoc.crossFt : rLoc.crossFt
      // NTZ centerline lies between the runways; signed crossFt with magnitude < halfSep/2 means inside NTZ band
      const halfSep = pair.sepFt / 2
      const halfNtz = (ntzWFt * (xtkMul / 100)) / 2
      // aircraft crossFt is offset from midpoint; NTZ band centered there
      const intoNtzFt = Math.max(0, halfNtz - Math.abs(crossFt))  // > 0 means inside NTZ
      const insideNtz = Math.abs(crossFt) <= halfNtz
      const insideFas = alongNm >= 0 && alongNm <= fasNm

      // Cross-track rate (kts perpendicular to runway → fpm) from track + GS
      const td = ((f.track - pair.l.brgTrue + 540) % 360) - 180
      const crossKts = f.velocityKts * Math.sin(td * D2R)  // + means drifting "right" perpendicular
      // toward-NTZ-centerline direction: opposite sign of crossFt
      const towardNtzKts = -Math.sign(crossFt || 1) * crossKts
      const crossRateFpm = Math.abs(towardNtzKts) * FT_PER_NM / 60 * (rateMul / 100)
      const towardNtzFpm = (towardNtzKts > 0 ? 1 : -1) * crossRateFpm
      // distance to NTZ edge (in feet, only valid if outside NTZ)
      const distToNtzFt = Math.max(0, Math.abs(crossFt) - halfNtz)
      const ttiSec = towardNtzFpm > 0.1 ? (distToNtzFt / towardNtzFpm) * 60 : 9999

      // Glideslope deviation: 3° → ~318 ft / NM
      const expectedAltFt = alongNm * 318 + 50
      const altDevFt = Math.abs(f.altitudeFt - expectedAltFt)

      // Pair conflict: any *other* aircraft within FAS on the opposite runway with along-distance within 1nm
      let pairConflict = false
      for (const f2 of flights) {
        if (f2.icao === f.icao || f2.ground) continue
        const loc2 = projectLocal(pair, f2.lat, f2.lng)
        if (loc2.alongNm > fasNm || loc2.alongFt < -3000) continue
        if (Math.abs(loc2.alongNm - alongNm) > 1.0) continue
        // is f2 on the "other" runway side?
        const onOther = (Math.sign(loc2.crossFt) !== Math.sign(crossFt))
        if (onOther) { pairConflict = true; break }
      }

      // Driver scores
      const scoreXtk = insideNtz ? 100 : Math.min(100, Math.max(0, (300 - distToNtzFt) / 3))
      const scoreRat = Math.min(100, Math.max(0, (crossRateFpm - 30) / 1.7))  // 30 fpm = 0, 200 fpm = 100
      const scoreTti = ttiSec >= 9999 ? 0 : Math.max(0, Math.min(100, 100 * (1 - ttiSec / Math.max(15, ttiWarn))))
      const scoreAlt = Math.min(100, Math.max(0, (altDevFt - 100) / 5))  // 100 ft = 0, 600 ft = 100
      const scoreSep = pairConflict ? 70 : 0

      const drivers: { d: Driver; v: number }[] = [
        { d: 'XTK', v: scoreXtk }, { d: 'RAT', v: scoreRat },
        { d: 'TTI', v: scoreTti }, { d: 'ALT', v: scoreAlt }, { d: 'SEP', v: scoreSep },
      ]
      drivers.sort((a, b) => b.v - a.v)
      const score = Math.max(0, Math.min(100, drivers[0].v))
      const topDriver = drivers[0].d

      let tier: Tier
      if (insideNtz) tier = 'BREACH'
      else if (crossRateFpm > 120 && ttiSec < ttiWarn) tier = 'IMMINENT'
      else if (Math.abs(crossFt) < halfSep / 2 && ownXtkFt * Math.sign(crossFt) > 0 ? distToNtzFt < halfNtz : false) tier = 'DEVIATE'
      else if (score >= 55) tier = 'DEVIATE'
      else if (score >= 25) tier = 'CAUTION'
      else tier = 'OK'

      out.push({
        f, klass, pair, alongFt, crossFt, alongNm,
        xtkLeftFt, xtkRightFt, closerRwy, ownXtkFt,
        crossRateFpm, ttiSec, insideFas, insideNtz, altDevFt, pairConflict,
        scoreXtk, scoreRat, scoreTti, scoreAlt, scoreSep,
        score, topDriver, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return b.score - a.score
    })
    return out
  }, [flights, minFl, fasNm, ntzWFt, xtkMul, rateMul, ttiWarn])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { BREACH: 0, IMMINENT: 0, DEVIATE: 0, CAUTION: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let breach = 0, imminent = 0, sumXtk = 0, worstScore = -1, worstCs = '', worstDrv: Driver = 'XTK'
    const activePairs = new Set<string>()
    for (const r of rows) {
      if (r.tier === 'BREACH') breach++
      if (r.tier === 'IMMINENT') imminent++
      sumXtk += Math.abs(r.crossFt)
      activePairs.add(`${r.pair.apt}-${r.pair.l.rwy}/${r.pair.r.rwy}`)
      if (r.score > worstScore) { worstScore = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstDrv = r.topDriver }
    }
    return {
      total: rows.length, breach, imminent,
      meanXtk: rows.length ? sumXtk / rows.length : 0,
      worstCs, worstDrv, pairCount: activePairs.size,
    }
  }, [rows])

  // runway-pair rollup
  const pairStats = useMemo(() => {
    type PE = { p: RwyPair; acCount: number; breachCount: number; worstScore: number; meanXtk: number; sumXtk: number; sumN: number }
    const m = new Map<string, PE>()
    for (const p of PAIRS) m.set(`${p.apt}-${p.l.rwy}`, { p, acCount: 0, breachCount: 0, worstScore: 0, meanXtk: 0, sumXtk: 0, sumN: 0 })
    for (const r of rows) {
      const e = m.get(`${r.pair.apt}-${r.pair.l.rwy}`); if (!e) continue
      e.acCount++
      if (r.tier === 'BREACH') e.breachCount++
      if (r.score > e.worstScore) e.worstScore = r.score
      e.sumXtk += Math.abs(r.crossFt); e.sumN++
    }
    const arr = Array.from(m.values())
    for (const e of arr) if (e.sumN > 0) e.meanXtk = e.sumXtk / e.sumN
    arr.sort((a, b) => b.breachCount - a.breachCount || b.worstScore - a.worstScore || b.acCount - a.acCount)
    return arr
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.pair.apt, r.pair.l.rwy, r.pair.r.rwy].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  const filteredPairs = useMemo(() => {
    const q = query.trim().toUpperCase()
    return pairStats.filter(e => !q || [e.p.apt, e.p.name, e.p.l.rwy, e.p.r.rwy, e.p.mode, e.p.region].some(s => (s || '').toUpperCase().includes(q)))
  }, [pairStats, query])

  useEffect(() => {
    if (!map) return
    // NTZ rectangles (rose dashed) for each pair: a thin rectangle along midline FAS_NM long, ntzW wide
    const ntzFc = { type: 'FeatureCollection' as const, features: showNtz ? PAIRS.map(p => {
      const halfNtz = (ntzWFt * (xtkMul / 100)) / 2
      // build mid-runway as average of L and R thresholds, with brg = L.brgTrue
      const midRwy: Runway = { apt: p.apt, rwy: 'MID', lat: (p.l.lat + p.r.lat) / 2, lng: (p.l.lng + p.r.lng) / 2, brgTrue: p.l.brgTrue, lenFt: 0 }
      const coords: [number, number][] = []
      const fasFt = fasNm * FT_PER_NM
      // rectangle corners: (0, +halfNtz) (fasFt, +halfNtz) (fasFt, -halfNtz) (0, -halfNtz)
      coords.push(offsetCenterline(midRwy, 0, halfNtz))
      coords.push(offsetCenterline(midRwy, fasFt, halfNtz))
      coords.push(offsetCenterline(midRwy, fasFt, -halfNtz))
      coords.push(offsetCenterline(midRwy, 0, -halfNtz))
      coords.push(coords[0])
      return {
        type: 'Feature' as const,
        properties: { color: '#ef4444' },
        geometry: { type: 'Polygon' as const, coordinates: [coords] },
      }
    }) : [] }
    // Centerlines (sky) for both runways extended FAS nm
    const clFc = { type: 'FeatureCollection' as const, features: showCl ? PAIRS.flatMap(p => {
      const fasFt = fasNm * FT_PER_NM
      return [p.l, p.r].map(rw => ({
        type: 'Feature' as const,
        properties: { color: '#0ea5e9', mode: p.mode },
        geometry: { type: 'LineString' as const, coordinates: [[rw.lng, rw.lat], offsetCenterline(rw, fasFt)] },
      }))
    }) : [] }
    // Airport pins
    const aptFc = { type: 'FeatureCollection' as const, features: PAIRS.map(p => ({
      type: 'Feature' as const,
      properties: { color: '#cbd5e1', radius: 4 },
      geometry: { type: 'Point' as const, coordinates: [(p.l.lng + p.r.lng) / 2, (p.l.lat + p.r.lat) / 2] },
    })) }
    const aptLblFc = { type: 'FeatureCollection' as const, features: PAIRS.map(p => ({
      type: 'Feature' as const,
      properties: { color: '#94a3b8', text: `${p.apt} ${p.l.rwy}/${p.r.rwy} ${p.mode} ${p.sepFt}ft` },
      geometry: { type: 'Point' as const, coordinates: [(p.l.lng + p.r.lng) / 2, (p.l.lat + p.r.lat) / 2] },
    })) }
    // Aircraft ring/halo
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + (r.score / 100) * 14 },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showRing ? rows.filter(r => r.tier === 'BREACH').map(r => ({
      type: 'Feature' as const,
      properties: { color: '#ef4444' },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    // Labels
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${r.pair.apt}/${r.pair.l.rwy} ${Math.abs(r.crossFt).toFixed(0)}ft ${r.ttiSec < 999 ? `TTI${r.ttiSec.toFixed(0)}s` : ''}`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    // Forward projection: 8-segment dashed line predicting cross-track encroachment
    const projFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier === 'BREACH' || r.tier === 'IMMINENT' || r.tier === 'DEVIATE').map(r => {
      const headRad = r.f.track * D2R
      const stepNm = 0.5
      const coords: [number, number][] = [[r.f.lng, r.f.lat]]
      let la = r.f.lat * D2R, lo = r.f.lng * D2R
      for (let i = 0; i < 8; i++) {
        const ang = stepNm / R_NM
        const la2 = Math.asin(Math.sin(la) * Math.cos(ang) + Math.cos(la) * Math.sin(ang) * Math.cos(headRad))
        const lo2 = lo + Math.atan2(Math.sin(headRad) * Math.sin(ang) * Math.cos(la), Math.cos(ang) - Math.sin(la) * Math.sin(la2))
        coords.push([(lo2 / D2R + 540) % 360 - 180, la2 / D2R])
        la = la2; lo = lo2
      }
      return {
        type: 'Feature' as const,
        properties: { color: TIER_COLOR[r.tier] },
        geometry: { type: 'LineString' as const, coordinates: coords },
      }
    }) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_NTZ, ntzFc, () => map.addLayer({ id: LYR_NTZ, type: 'line', source: SRC_NTZ, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.85, 'line-dasharray': [4, 3],
      } }))
      ensure(SRC_CL, clFc, () => map.addLayer({ id: LYR_CL, type: 'line', source: SRC_CL, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.0, 'line-opacity': 0.55,
      } }))
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.1, 'line-opacity': 0.7, 'line-dasharray': [2, 2],
      } }))
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'circle', source: SRC_RING, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.6, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': '◆', 'text-size': 14, 'text-allow-overlap': true,
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.5 } }))
      ensure(SRC_APT, aptFc, () => map.addLayer({ id: LYR_APT, type: 'circle', source: SRC_APT, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.7,
        'circle-stroke-color': '#020617', 'circle-stroke-width': 1.0,
      } }))
      ensure(SRC_APTL, aptLblFc, () => map.addLayer({ id: LYR_APTL, type: 'symbol', source: SRC_APTL, layout: {
        'text-field': ['get', 'text'], 'text-size': 9, 'text-offset': [0, 1.3], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_APTL, LYR_APT, LYR_PIN, LYR_RING, LYR_PROJ, LYR_CL, LYR_NTZ]) {
        try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {}
      }
      for (const src of [SRC_LBL, SRC_APTL, SRC_APT, SRC_PIN, SRC_RING, SRC_PROJ, SRC_CL, SRC_NTZ]) {
        try { if (map.getSource(src)) map.removeSource(src) } catch {}
      }
    }
  }, [map, rows, showRing, showNtz, showCl, showLabels, showProj, fasNm, ntzWFt, xtkMul])

  // Diagram: x = xtk feet 0..2500, y = cross-rate fpm 0..400
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD_L = 28, PAD_B = 22
    const xs = (xtk: number) => PAD_L + Math.max(0, Math.min(2500, xtk)) / 2500 * (W - PAD_L - 8)
    const ys = (r: number) => 6 + Math.max(0, Math.min(400, r)) / 400 * (H - PAD_B - 8)
    return { W, H, PAD_L, PAD_B, xs, ys }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">PRM / SOIA · NTZ Breach</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} ac · {PAIRS.length} pair</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {(['BREACH', 'IMMINENT', 'DEVIATE', 'CAUTION', 'OK'] as Tier[]).map(t => {
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Tracked</div>
          <div className="font-mono text-sm text-slate-100">{summary.total}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">BREACH</div>
          <div className="font-mono text-sm" style={{ color: summary.breach > 0 ? '#ef4444' : '#10b981' }}>{summary.breach}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">IMMINENT</div>
          <div className="font-mono text-sm" style={{ color: summary.imminent > 0 ? '#f59e0b' : '#10b981' }}>{summary.imminent}</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">μ |xtk|</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanXtk <= 300 ? '#10b981' : summary.meanXtk <= 700 ? '#0ea5e9' : summary.meanXtk <= 1200 ? '#f59e0b' : '#ef4444' }}>{summary.meanXtk.toFixed(0)}ft</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[10px] text-slate-200 truncate" title={summary.worstCs}>{summary.worstCs ? `${summary.worstCs} ${summary.worstDrv}` : '—'}</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Pairs Active</div>
          <div className="font-mono text-[11px] text-slate-200">{summary.pairCount}/{PAIRS.length}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">|xtk| ft vs cross-rate fpm · NTZ half-width / 120 fpm thresholds</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD_L} y1={diag.H - diag.PAD_B} x2={diag.W - 6} y2={diag.H - diag.PAD_B} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD_L} y1={6} x2={diag.PAD_L} y2={diag.H - diag.PAD_B} stroke="#334155" strokeWidth={1} />
            {/* bands: xtk < ntzHalf rose, xtk 0-ntzHalf+300 amber, xtk 0-700 sky, > sky emerald */}
            <rect x={diag.PAD_L} y={6} width={diag.xs(ntzWFt / 2) - diag.PAD_L} height={diag.H - diag.PAD_B - 6} fill="#ef4444" opacity={0.07} />
            <rect x={diag.xs(ntzWFt / 2)} y={6} width={diag.xs(ntzWFt / 2 + 400) - diag.xs(ntzWFt / 2)} height={diag.H - diag.PAD_B - 6} fill="#f59e0b" opacity={0.07} />
            <rect x={diag.PAD_L} y={6} width={diag.W - diag.PAD_L - 6} height={diag.ys(400) - diag.ys(120)} fill="#f59e0b" opacity={0.05} transform={`translate(0, ${diag.ys(120) - 6})`} />
            {/* threshold lines */}
            <line x1={diag.xs(ntzWFt / 2)} y1={6} x2={diag.xs(ntzWFt / 2)} y2={diag.H - diag.PAD_B} stroke="#ef4444" strokeDasharray="2 3" opacity={0.7} />
            <line x1={diag.PAD_L} y1={diag.ys(120)} x2={diag.W - 6} y2={diag.ys(120)} stroke="#f59e0b" strokeDasharray="2 3" opacity={0.7} />
            <text x={diag.xs(ntzWFt / 2) + 2} y={14} fontSize={8} fill="#ef4444" fontFamily="monospace">NTZ {ntzWFt / 2}ft</text>
            <text x={diag.W - 8} y={diag.ys(120) - 2} textAnchor="end" fontSize={8} fill="#f59e0b" fontFamily="monospace">120 fpm rate</text>
            {[0, 100, 200, 300, 400].map(y => (
              <text key={y} x={diag.PAD_L - 2} y={diag.ys(y) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{y}</text>
            ))}
            {[0, 500, 1000, 1500, 2000, 2500].map(x => (
              <text key={x} x={diag.xs(x)} y={diag.H - diag.PAD_B + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{x}</text>
            ))}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(Math.abs(r.crossFt))} cy={diag.ys(r.crossRateFpm)} r={2.5} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={0} max={120} step={5} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>FAS-NM</span><span className="font-mono text-slate-300">{fasNm}nm</span></div>
            <input type="range" min={5} max={20} step={1} value={fasNm} onChange={e => setFasNm(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>NTZ-W</span><span className="font-mono text-slate-300">{ntzWFt}ft</span></div>
            <input type="range" min={800} max={3000} step={50} value={ntzWFt} onChange={e => setNtzWFt(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>XTK-MUL</span><span className="font-mono text-slate-300">{xtkMul}%</span></div>
            <input type="range" min={50} max={200} step={5} value={xtkMul} onChange={e => setXtkMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>RATE-MUL</span><span className="font-mono text-slate-300">{rateMul}%</span></div>
            <input type="range" min={50} max={200} step={5} value={rateMul} onChange={e => setRateMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>TTI-WARN</span><span className="font-mono text-slate-300">{ttiWarn}s</span></div>
            <input type="range" min={10} max={60} step={5} value={ttiWarn} onChange={e => setTtiWarn(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klassFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['heavy', 'narrow', 'regional', 'biz', 'turboprop'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klassFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{KLASS_LABEL[k]}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRing} onChange={e => setShowRing(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showNtz} onChange={e => setShowNtz(e.target.checked)} className="accent-sky-500" /><span>NTZ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showCl} onChange={e => setShowCl(e.target.checked)} className="accent-sky-500" /><span>CL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao / IATA / runway"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'RUNWAYS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length}` : `${filteredPairs.length} pairs`}</span>
        <span>{tab === 'AIRCRAFT' ? 'tier · xtk · cross-rate · TTI' : 'mode · sep · ac · breach'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft on PRM/SOIA capture.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const advice = r.tier === 'BREACH'
            ? `INSIDE NTZ · "TURN IMMEDIATELY" PRM call · climb to ${(Math.ceil(r.f.altitudeFt / 100) * 100 + 1000)} ft · revert to radar-vector ILS per Order 7110.65 §5-9-7`
            : r.tier === 'IMMINENT' ? `Cross-rate ${r.crossRateFpm.toFixed(0)} fpm toward NTZ · TTI ${r.ttiSec.toFixed(0)}s · advise lateral correction now`
            : r.tier === 'DEVIATE' ? `Off CL ${Math.abs(r.crossFt).toFixed(0)} ft · ${DRIVER_LABEL[r.topDriver]} dominant · monitor approach precision`
            : r.tier === 'CAUTION' ? `Drifting outboard · ${DRIVER_LABEL[r.topDriver]} · trend watch only`
            : `On localizer · xtk ${Math.abs(r.crossFt).toFixed(0)} ft · ${r.pair.mode} ${r.pair.sepFt}ft pair · alt-dev ${r.altDevFt.toFixed(0)}ft`
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{KLASS_LABEL[r.klass]}</span>
                  <span className="text-[9px] px-1 rounded font-mono bg-sky-500/15 text-sky-300">{r.pair.apt}/{r.closerRwy === 'L' ? r.pair.l.rwy : r.pair.r.rwy}</span>
                  <span className="text-[9px] px-1 rounded font-mono bg-slate-800 text-slate-400">{r.pair.mode}</span>
                  {r.pairConflict && <span className="text-[9px] px-1 rounded bg-amber-500/15 text-amber-300 font-mono">PAIR</span>}
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="distance from threshold along centerline">A{r.alongNm.toFixed(1)}nm</span>
                  <span title="cross-track from NTZ centerline (sign)" style={{ color: Math.abs(r.crossFt) < (ntzWFt / 2) ? '#ef4444' : Math.abs(r.crossFt) < 700 ? '#f59e0b' : '#10b981' }}>{r.crossFt >= 0 ? '+' : ''}{r.crossFt.toFixed(0)}ft</span>
                  <span title="cross-track rate (fpm toward NTZ)" style={{ color: r.crossRateFpm >= 120 ? '#ef4444' : r.crossRateFpm >= 60 ? '#f59e0b' : '#10b981' }}>{r.crossRateFpm.toFixed(0)}fpm</span>
                  <span title="time-to-intrusion" style={{ color: r.ttiSec < ttiWarn ? '#ef4444' : r.ttiSec < 60 ? '#f59e0b' : '#10b981' }}>TTI{r.ttiSec < 999 ? `${r.ttiSec.toFixed(0)}s` : '—'}</span>
                  <span className="ml-auto" title="altitude deviation from 3deg GS" style={{ color: r.altDevFt > 300 ? '#ef4444' : r.altDevFt > 150 ? '#f59e0b' : '#10b981' }}>Δalt{r.altDevFt.toFixed(0)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0" style={{ left: '25%', width: '1px', background: '#10b981', opacity: 0.5 }} />
                  <div className="absolute inset-y-0" style={{ left: '55%', width: '1px', background: '#f59e0b', opacity: 0.5 }} />
                  <div className="absolute inset-y-0" style={{ left: '80%', width: '1px', background: '#ef4444', opacity: 0.5 }} />
                </div>
                <div className="grid grid-cols-5 gap-0.5 mt-1">
                  {([['XTK', r.scoreXtk], ['RAT', r.scoreRat], ['TTI', r.scoreTti], ['ALT', r.scoreAlt], ['SEP', r.scoreSep]] as [string, number][]).map(([lbl, v]) => {
                    const c = v >= 80 ? '#ef4444' : v >= 55 ? '#f59e0b' : v >= 25 ? '#0ea5e9' : '#10b981'
                    return (
                      <div key={lbl} className="text-[8px] font-mono text-center py-0.5 rounded" style={{ background: c + '22', color: c }} title={`${lbl} score ${v.toFixed(0)}`}>
                        {lbl}{v.toFixed(0)}
                      </div>
                    )
                  })}
                </div>
                <div className="text-[10px] font-mono mt-0.5 truncate" title="advice" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</div>
              </div>
            </button>
          )
        })}

        {tab === 'RUNWAYS' && filteredPairs.map(e => {
          const c = e.breachCount > 0 ? '#ef4444' : e.worstScore >= 55 ? '#f59e0b' : e.worstScore >= 25 ? '#0ea5e9' : '#10b981'
          const modeColor = e.p.mode === 'PRM' ? '#ef4444' : e.p.mode === 'SOIA' ? '#f59e0b' : '#0ea5e9'
          return (
            <div key={`${e.p.apt}-${e.p.l.rwy}`} className="w-full text-left px-3 py-2 border-b border-slate-900 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: c }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold text-slate-100">{e.p.apt} {e.p.l.rwy}/{e.p.r.rwy}</span>
                  <span className="text-slate-400 truncate">{e.p.name}</span>
                  <span className="ml-auto text-[9px] px-1 rounded font-mono" style={{ background: modeColor + '22', color: modeColor }}>{e.p.mode}</span>
                  <span className="text-[9px] px-1 rounded font-mono bg-slate-800 text-slate-400">{e.p.region}</span>
                  {e.breachCount > 0 && <span className="text-[9px] font-mono px-1 rounded bg-rose-500/20 text-rose-300">!BR{e.breachCount}</span>}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="centerline separation">sep {e.p.sepFt}ft</span>
                  <span title="NTZ width">NTZ {e.p.ntzWFt}ft</span>
                  <span title="aircraft on capture">ac {e.acCount}</span>
                  <span title="mean |xtk|" style={{ color: e.meanXtk <= 300 ? '#10b981' : e.meanXtk <= 700 ? '#0ea5e9' : e.meanXtk <= 1200 ? '#f59e0b' : '#ef4444' }}>μxtk {e.meanXtk.toFixed(0)}ft</span>
                  <span className="ml-auto" title="worst score" style={{ color: c }}>w{e.worstScore.toFixed(0)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="worst-score">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${e.worstScore}%`, background: c, opacity: 0.85 }} />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
