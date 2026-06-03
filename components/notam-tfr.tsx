'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   NOTAM / TFR Active-Restriction Compliance Monitor
   -----------------------------------------------------------
   ICAO Annex 15 §5 NOTAM (Notice to Airmen) procedure ·
   FAA JO 7930.2R "Notices to Air Missions" · 14 CFR 91.137
   Temporary Flight Restrictions in the vicinity of disaster
   areas · 14 CFR 91.138 TFR in national disaster areas
   Hawaii · 14 CFR 91.141 Presidential and other parties ·
   14 CFR 91.143 Space-flight operations · 14 CFR 91.145
   Aerial demonstrations and major sporting events · 14 CFR
   99 Security Control of Air Traffic · 14 CFR 73 Special Use
   Airspace (Restricted / Prohibited / MOA / Warning) ·
   FAA AC 91-63D Temporary Flight Restrictions · EUROCONTROL
   AIS Manual Pt 4 §4 NOTAM coding · ICAO Doc 8126 AIS
   Manual · FAA Order JO 7400.10M Special Use Airspace.

   This monitor maintains a catalogue of 32 active NOTAM-class
   restrictions (Presidential TFRs / Stadium TFRs / Space-launch
   TFRs / GPS-test areas / VIP TFRs / Prohibited areas / Active
   MOAs / Warning areas / Disaster TFRs) modelled as geometric
   bounding circles {lat, lng, radius-nm, alt-band-FL, type,
   authority, NOTAM-ID, expiry-UTC, description}.

   For every airborne aircraft within the catalogue capture
   window we compute:
     SIGNED-PROX-NM   positive inside boundary, negative outside
                      via great-circle haversine
     ALT-DELTA-FL     +ve when above ceiling, -ve when below
                      floor, 0 when inside vertical envelope
     AUTH-STATE       per-airframe FNV-1a 32-bit hash of ICAO24
                      yields hash-stable filed-waiver probability
                      per type (PRES 0.05 · STAD 0.15 · SPACE 0.40
                      · GPS-TEST 0.85 · VIP 0.10 · PROH 0.02 ·
                      MOA 0.55 · WARN 0.75 · DSTR 0.35)
     TIME-WIN-MIN     synthesised hash-stable "minutes until
                      expiry" 5-360 min, drives time-decay weight
     ETA-MIN          minutes to boundary at present GS+track

   Five risk components, composite max-driver:
     PROX-SEV       inside boundary OR within MARGIN-NM slider
                    severity 50 at boundary ramping to 100 at
                    +20nm inside, ramping out to 0 at margin edge
     ALT-SEV        |alt-delta| against band: 0 if inside band,
                    severity (1 - |Δ|/4)*100 if within 4 FL
                    (vertical buffer) else 100 if inside lateral
     AUTH-SEV       (1 - authProb)*100 (lack of filed waiver)
     TIME-SEV       active-time factor: tighter window → higher
                    severity, clipped 0-100
     TYPE-SEV       per-type base severity (PRES 100 · PROH 100 ·
                    SPACE 90 · STAD 80 · VIP 75 · DSTR 70 ·
                    GPS-TEST 35 · MOA 45 · WARN 55) scaled by
                    TYPE-WEIGHT slider 50-150%

   Composite score = max-driver with dominant labelling
   (PRX / ALT / AUT / TIM / TYP).

   Tiers (5):
     INCURSION  inside boundary AND inside altitude band AND no
                authorisation OR score ≥ 80                rose
     CLOSE      score 55-80 closing the boundary           amber
     WATCH      score 25-55 within buffer                  sky
     OK         score < 25 nominal                         emerald
     IDLE       no active restriction within capture       slate

   MapLibre overlay (registered Layers > Safety & Traffic):
     - Tier-coloured halo rings sized by score 8-22 px
     - Amber 36-segment dashed circle for each TFR boundary
     - Rose diamond pin at boundary intercept for INCURSION
     - Tier-coloured callsign + NOTAM-ID + driver labels
       for CLOSE / INCURSION
     - Dashed sky 12-seg projection forward 60 nm for CLOSE

   Side panel:
     - 4-tier counter strip click-to-filter (no IDLE chip)
     - 3-cell MEAN-PROX tier-coloured / WORST cs+notam /
       INCURSION-count
     - 2-cell ACTIVE-TFR count / WAIVER-COVERAGE %
     - SVG signed-prox-nm vs ETA-min scatter with rose-shaded
       inside-band right of x=0, sky-shaded MARGIN buffer band,
       dashed boundary vertical at x=0, ETA-MIN horizontal,
       every aircraft as tier-coloured dot
     - 6 sliders MIN-FL / MARGIN-NM / ETA-MIN / WAIVER-MUL /
       TYPE-WEIGHT in 2-col grid + ALT-BUFFER-FL full-width
     - 9-type chip filter PRES/STAD/SPACE/GPS/VIP/PROH/MOA/
       WARN/DSTR
     - HALO/CIRC/LBL/PIN/PROJ/DIAG toggles + search
     - AIRCRAFT / AREAS tab switcher
     - AIRCRAFT tier-worst-first then severity desc, score bar
       0-100 with sky-25/amber-55/rose-80 ticks
     - AREAS grouped by NOTAM, mean-score bar with tier strip

   Persisted: ft-notam
   ============================================================ */

export interface NotamFlight {
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
  flights: NotamFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'WATCH' | 'CLOSE' | 'INCURSION' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981',
  WATCH: '#0ea5e9',
  CLOSE: '#f59e0b',
  INCURSION: '#fb7185',
  IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['INCURSION', 'CLOSE', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { INCURSION: 0, CLOSE: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Ntype = 'PRES' | 'STAD' | 'SPACE' | 'GPS' | 'VIP' | 'PROH' | 'MOA' | 'WARN' | 'DSTR'
const NT_NAME: Record<Ntype, string> = {
  PRES: 'Presidential TFR (14 CFR 91.141)',
  STAD: 'Stadium TFR (14 CFR 91.145)',
  SPACE: 'Space-launch TFR (14 CFR 91.143)',
  GPS: 'GPS test / jamming NOTAM',
  VIP: 'VIP / dignitary movement',
  PROH: 'Prohibited Area (14 CFR 73)',
  MOA: 'Military Operating Area active',
  WARN: 'Warning Area (off-shore)',
  DSTR: 'Disaster TFR (14 CFR 91.137/91.138)',
}
const NT_SEV: Record<Ntype, number> = { PRES: 100, PROH: 100, SPACE: 90, STAD: 80, VIP: 75, DSTR: 70, GPS: 35, MOA: 45, WARN: 55 }
const NT_WAIVER_BASE: Record<Ntype, number> = { PRES: 0.05, STAD: 0.15, SPACE: 0.40, GPS: 0.85, VIP: 0.10, PROH: 0.02, MOA: 0.55, WARN: 0.75, DSTR: 0.35 }

interface Notam {
  id: string
  notam: string       // e.g. "FDC 6/3814"
  type: Ntype
  authority: string
  name: string
  lat: number
  lng: number
  radiusNm: number
  floorFl: number     // FL (×100 ft); 0 = surface
  ceilFl: number      // FL; 999 = unlimited
}

// 32-entry catalogue — geographically diverse, plausible coordinates
const NOTAMS: Notam[] = [
  // Presidential TFRs (rotating PRES; sized 30 nm inner / 10 nm core typical)
  { id: 'PRES-WAS', notam: 'FDC 6/3814', type: 'PRES', authority: 'USSS/FAA', name: 'Washington DC SFRA core', lat: 38.895, lng: -77.036, radiusNm: 30, floorFl: 0, ceilFl: 180 },
  { id: 'PRES-WPB', notam: 'FDC 6/4127', type: 'PRES', authority: 'USSS/FAA', name: 'West Palm Beach PRES movement', lat: 26.715, lng: -80.060, radiusNm: 30, floorFl: 0, ceilFl: 180 },
  { id: 'PRES-BED', notam: 'FDC 6/4490', type: 'PRES', authority: 'USSS/FAA', name: 'Bedminster NJ PRES movement', lat: 40.668, lng: -74.638, radiusNm: 30, floorFl: 0, ceilFl: 180 },
  // Prohibited
  { id: 'P-40', notam: 'P-40', type: 'PROH', authority: 'FAA/USAF', name: 'Camp David P-40 prohibited', lat: 39.648, lng: -77.466, radiusNm: 5, floorFl: 0, ceilFl: 180 },
  { id: 'P-56A', notam: 'P-56A', type: 'PROH', authority: 'FAA', name: 'Washington National Mall P-56A', lat: 38.890, lng: -77.030, radiusNm: 1.0, floorFl: 0, ceilFl: 180 },
  { id: 'P-67', notam: 'P-67', type: 'PROH', authority: 'FAA', name: 'Bush Library TX P-67', lat: 31.547, lng: -97.114, radiusNm: 2.5, floorFl: 0, ceilFl: 50 },
  // Space-launch
  { id: 'SPCX-CC', notam: 'FDC 6/1801', type: 'SPACE', authority: 'FAA AST', name: 'KSC/CCSFS launch window', lat: 28.524, lng: -80.604, radiusNm: 35, floorFl: 0, ceilFl: 999 },
  { id: 'SPCX-VAFB', notam: 'FDC 6/1922', type: 'SPACE', authority: 'FAA AST', name: 'Vandenberg launch window', lat: 34.748, lng: -120.534, radiusNm: 30, floorFl: 0, ceilFl: 999 },
  { id: 'SPCX-BOCA', notam: 'FDC 6/2031', type: 'SPACE', authority: 'FAA AST', name: 'Starbase Boca Chica Starship', lat: 25.997, lng: -97.156, radiusNm: 40, floorFl: 0, ceilFl: 999 },
  // GPS jamming / test
  { id: 'GPS-CHLK', notam: 'FDC 6/0091', type: 'GPS', authority: 'USAF NTIA', name: 'China Lake GPS test', lat: 35.683, lng: -117.690, radiusNm: 280, floorFl: 50, ceilFl: 400 },
  { id: 'GPS-WSMR', notam: 'FDC 6/0124', type: 'GPS', authority: 'WSMR/USAF', name: 'White Sands GPS test', lat: 32.380, lng: -106.480, radiusNm: 220, floorFl: 100, ceilFl: 400 },
  { id: 'GPS-NELL', notam: 'FDC 6/0188', type: 'GPS', authority: 'USAF/Nellis', name: 'Nellis GPS interference', lat: 36.236, lng: -115.034, radiusNm: 200, floorFl: 50, ceilFl: 400 },
  { id: 'GPS-EGLN', notam: 'FDC 6/0241', type: 'GPS', authority: 'USAF/Eglin', name: 'Eglin GPS test', lat: 30.483, lng: -86.520, radiusNm: 180, floorFl: 50, ceilFl: 400 },
  // Stadium TFRs
  { id: 'STAD-MET', notam: '1/0497', type: 'STAD', authority: 'FAA 91.145', name: 'MetLife Stadium NFL', lat: 40.813, lng: -74.074, radiusNm: 3, floorFl: 0, ceilFl: 30 },
  { id: 'STAD-SOFI', notam: '1/0502', type: 'STAD', authority: 'FAA 91.145', name: 'SoFi Stadium LA NFL', lat: 33.953, lng: -118.339, radiusNm: 3, floorFl: 0, ceilFl: 30 },
  { id: 'STAD-MBNK', notam: '1/0518', type: 'STAD', authority: 'FAA 91.145', name: 'Mercedes-Benz Atlanta NFL', lat: 33.755, lng: -84.401, radiusNm: 3, floorFl: 0, ceilFl: 30 },
  { id: 'STAD-AT&T', notam: '1/0533', type: 'STAD', authority: 'FAA 91.145', name: 'AT&T Stadium Dallas NFL', lat: 32.748, lng: -97.094, radiusNm: 3, floorFl: 0, ceilFl: 30 },
  { id: 'STAD-LAMB', notam: '1/0541', type: 'STAD', authority: 'FAA 91.145', name: 'Lambeau Field NFL', lat: 44.501, lng: -88.062, radiusNm: 3, floorFl: 0, ceilFl: 30 },
  // VIP / dignitaries
  { id: 'VIP-G7', notam: 'NOTAM-VIP-001', type: 'VIP', authority: 'Host Nation', name: 'G7 leaders summit overlay', lat: 49.500, lng: 11.080, radiusNm: 25, floorFl: 0, ceilFl: 200 },
  { id: 'VIP-UN', notam: 'KZNY VIP', type: 'VIP', authority: 'FAA/USSS', name: 'UNGA week NYC VIP', lat: 40.749, lng: -73.968, radiusNm: 15, floorFl: 0, ceilFl: 60 },
  // Active MOAs
  { id: 'MOA-SHA', notam: 'JO7400.10M', type: 'MOA', authority: 'USAF', name: 'Shaw MOA active', lat: 33.985, lng: -80.473, radiusNm: 45, floorFl: 70, ceilFl: 180 },
  { id: 'MOA-OZK', notam: 'JO7400.10M', type: 'MOA', authority: 'USAF', name: 'Ozark MOA active', lat: 36.85, lng: -93.10, radiusNm: 60, floorFl: 70, ceilFl: 180 },
  { id: 'MOA-SAY', notam: 'JO7400.10M', type: 'MOA', authority: 'USN', name: 'Sealey Lake MT MOA', lat: 47.20, lng: -113.50, radiusNm: 55, floorFl: 100, ceilFl: 290 },
  { id: 'MOA-RES', notam: 'JO7400.10M', type: 'MOA', authority: 'USAF', name: 'Reserve MOA NM', lat: 33.72, lng: -108.76, radiusNm: 80, floorFl: 80, ceilFl: 290 },
  // Warning Areas (off-shore)
  { id: 'W-105', notam: 'W-105', type: 'WARN', authority: 'USAF/USN', name: 'W-105 off VA Capes', lat: 36.50, lng: -74.40, radiusNm: 70, floorFl: 0, ceilFl: 999 },
  { id: 'W-72A', notam: 'W-72A', type: 'WARN', authority: 'USN', name: 'W-72A off New England', lat: 40.10, lng: -68.20, radiusNm: 60, floorFl: 0, ceilFl: 999 },
  { id: 'W-291', notam: 'W-291', type: 'WARN', authority: 'USN', name: 'W-291 off San Diego', lat: 32.30, lng: -118.40, radiusNm: 90, floorFl: 0, ceilFl: 999 },
  // Disaster TFRs (wildfire / chemical incident)
  { id: 'DSTR-FIRE', notam: 'FDC 6/9112', type: 'DSTR', authority: 'NIFC', name: 'Wildfire TFR Sierra Nevada', lat: 38.95, lng: -120.10, radiusNm: 8, floorFl: 0, ceilFl: 105 },
  { id: 'DSTR-HAZ', notam: 'FDC 6/9213', type: 'DSTR', authority: 'EPA/FAA', name: 'HazMat plume TFR OH', lat: 40.85, lng: -80.52, radiusNm: 5, floorFl: 0, ceilFl: 90 },
  // International (EU / Asia)
  { id: 'EU-EBR', notam: 'EBBU-A0421', type: 'MOA', authority: 'BAF', name: 'Belgium EBR EUR MOA', lat: 50.15, lng: 5.10, radiusNm: 35, floorFl: 80, ceilFl: 180 },
  { id: 'EU-LF', notam: 'LFXX-NOT', type: 'MOA', authority: 'AdlA', name: 'France TRA south-east', lat: 43.85, lng: 4.85, radiusNm: 40, floorFl: 100, ceilFl: 290 },
  { id: 'AS-RJTT', notam: 'RJTT-VIP', type: 'VIP', authority: 'JCAB', name: 'Tokyo VIP movement', lat: 35.682, lng: 139.766, radiusNm: 12, floorFl: 0, ceilFl: 50 },
]

function classifyAircraft(t: string | undefined, cat?: string) {
  const x = (t || '').toUpperCase()
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|MIG|SU)/.test(x)) return 'FTR'
  if (/^(B77|B78|A33|A34|A35|A38|B74)/.test(x)) return 'HVY'
  if (/^(B73|A31|A32|A19|A20|A21|A22|BCS|CS1|CS3)/.test(x)) return 'NRW'
  if (/^(CRJ|E14|E15|E17|E19|E70|E75|AT4|AT5|AT7|DH8|Q40)/.test(x)) return 'RGN'
  if (/^(GLF|GL5|GL7|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'BIZ'
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
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const dφ = ((lat2 - lat1) * Math.PI) / 180
  const dλ = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = (lat1 * Math.PI) / 180, φ2 = (lat2 * Math.PI) / 180
  const Δλ = ((lng2 - lng1) * Math.PI) / 180
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) * 180) / Math.PI
}

function projectPosition(lat: number, lng: number, trackDeg: number, distNm: number) {
  const R = 3440.065
  const δ = distNm / R
  const θ = (trackDeg * Math.PI) / 180
  const φ1 = (lat * Math.PI) / 180
  const λ1 = (lng * Math.PI) / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return { lat: (φ2 * 180) / Math.PI, lng: (((λ2 * 180) / Math.PI + 540) % 360) - 180 }
}

type Driver = 'PRX' | 'ALT' | 'AUT' | 'TIM' | 'TYP'
const DRIVER_NAME: Record<Driver, string> = {
  PRX: 'Proximity',
  ALT: 'Altitude band',
  AUT: 'Authorisation',
  TIM: 'Time window',
  TYP: 'Restriction type',
}

interface Row {
  f: NotamFlight
  klass: string
  notam: Notam
  signedProxNm: number    // + inside, − outside
  altDeltaFl: number      // 0 if inside, signed if outside
  altInBand: boolean
  authProb: number
  hasWaiver: boolean
  timeWinMin: number
  etaMin: number          // minutes to boundary along track (positive)
  prxSev: number
  altSev: number
  autSev: number
  timSev: number
  typSev: number
  score: number
  driver: Driver
  tier: Tier
  boundary: { lat: number, lng: number }
}

const SRC_HALO = 'notam-halo', SRC_LBL = 'notam-lbl', SRC_PIN = 'notam-pin', SRC_PROJ = 'notam-proj', SRC_CIRC = 'notam-circ'
const LYR_HALO = 'notam-halo-l', LYR_LBL = 'notam-lbl-l', LYR_PIN = 'notam-pin-l', LYR_PROJ = 'notam-proj-l', LYR_CIRC = 'notam-circ-l'

function circlePolygon(lat: number, lng: number, rNm: number, segs = 36): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i <= segs; i++) {
    const p = projectPosition(lat, lng, (i / segs) * 360, rNm)
    out.push([p.lng, p.lat])
  }
  return out
}

export default function NotamTfr({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AREAS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [typeFilter, setTypeFilter] = useState<Ntype | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [marginNm, setMarginNm] = useState(20)
  const [etaMinFilt, setEtaMinFilt] = useState(15)
  const [altBufFl, setAltBufFl] = useState(20)
  const [waiverMul, setWaiverMul] = useState(100)
  const [typeWeight, setTypeWeight] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showCirc, setShowCirc] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const cap = marginNm + 5 // capture window beyond margin
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl) continue
      const klass = classifyAircraft(f.type, f.category)
      const h = hash32(f.icao || '')

      // pick closest qualifying NOTAM
      let best: Row | null = null
      for (const n of NOTAMS) {
        if (typeFilter !== 'ALL' && n.type !== typeFilter) continue
        const distNm = haversineNm(f.lat, f.lng, n.lat, n.lng)
        const signedProxNm = n.radiusNm - distNm // + inside
        if (signedProxNm < -cap) continue

        // alt band
        const altInBand = flCur >= n.floorFl && flCur <= n.ceilFl
        const altDeltaFl = altInBand ? 0 : (flCur > n.ceilFl ? flCur - n.ceilFl : flCur - n.floorFl)

        // authorisation probability (hash-stable per airframe × per NOTAM)
        const baseProb = NT_WAIVER_BASE[n.type]
        const h2 = hash32(f.icao + ':' + n.id)
        const noise = (((h2 % 100) / 100) - 0.5) * 0.30 // ±0.15
        const authProb = Math.max(0, Math.min(1, baseProb + noise)) * (waiverMul / 100)
        const hasWaiver = ((h2 >>> 11) % 1000) / 1000 < authProb

        // time-window minutes-until-expiry
        const timeWinMin = 5 + ((h2 >>> 17) % 355) // 5-360 min

        // closing rate / ETA to boundary
        const brg = bearingDeg(f.lat, f.lng, n.lat, n.lng)
        const trk = f.track || 0
        const cosTrk = Math.cos(((brg - trk) * Math.PI) / 180)
        const gs = Math.max(60, f.velocityKts || 250) // kts
        const closingKts = gs * cosTrk
        // distance to nearest boundary point: if outside use distNm - radius; if inside, distance to nearest edge = radius - distNm
        const distToBoundaryNm = Math.abs(distNm - n.radiusNm)
        const etaMin = closingKts > 1 && signedProxNm < 0 ? (distToBoundaryNm / closingKts) * 60 : 999

        // severity components
        let prxSev = 0
        if (signedProxNm >= 0) {
          // inside boundary: 50 at edge → 100 at +20 nm
          prxSev = Math.min(100, 50 + (signedProxNm / 20) * 50)
        } else if (-signedProxNm <= marginNm) {
          // within margin buffer outside: 50 at edge → 0 at margin
          prxSev = Math.max(0, 50 * (1 - (-signedProxNm) / marginNm))
        }

        let altSev = 0
        if (altInBand && signedProxNm >= 0) altSev = 100
        else if (!altInBand) {
          const dFl = Math.abs(altDeltaFl)
          altSev = dFl <= altBufFl ? Math.max(0, (1 - dFl / altBufFl) * 80) : 0
        }

        const autSev = (1 - authProb) * 100
        // time-window severity: tighter window → higher; <30 min sev 80, >180 min sev 20
        const timSev = Math.max(0, Math.min(100, 100 - (timeWinMin / 360) * 80))
        const typSev = NT_SEV[n.type] * (typeWeight / 100)

        // composite score: PROX is gate — if outside margin no exposure
        const exposure = signedProxNm >= 0 || (-signedProxNm) <= marginNm
        const score = exposure ? Math.max(prxSev, altSev * (signedProxNm >= 0 ? 1 : 0.5), autSev * (signedProxNm >= 0 ? 1 : 0.3), Math.min(60, timSev * (signedProxNm >= 0 ? 1 : 0.4)), typSev * (signedProxNm >= 0 ? 1 : 0.4)) : 0

        const sevs: { d: Driver, v: number }[] = [
          { d: 'PRX', v: prxSev },
          { d: 'ALT', v: signedProxNm >= 0 ? altSev : altSev * 0.5 },
          { d: 'AUT', v: signedProxNm >= 0 ? autSev : autSev * 0.3 },
          { d: 'TIM', v: signedProxNm >= 0 ? timSev : timSev * 0.4 },
          { d: 'TYP', v: signedProxNm >= 0 ? typSev : typSev * 0.4 },
        ]
        sevs.sort((a, b) => b.v - a.v)
        const driver = sevs[0].d

        let tier: Tier
        if (signedProxNm >= 0 && altInBand && !hasWaiver) tier = 'INCURSION'
        else if (score >= 80) tier = 'INCURSION'
        else if (score >= 55) tier = 'CLOSE'
        else if (score >= 25) tier = 'WATCH'
        else if (exposure) tier = 'OK'
        else tier = 'IDLE'

        // boundary intercept point: from aircraft toward NOTAM center, walk to boundary
        const brgInbound = bearingDeg(f.lat, f.lng, n.lat, n.lng)
        const boundary = projectPosition(n.lat, n.lng, brgInbound + 180, n.radiusNm)

        const row: Row = {
          f, klass, notam: n, signedProxNm, altDeltaFl, altInBand,
          authProb, hasWaiver, timeWinMin, etaMin,
          prxSev, altSev, autSev, timSev, typSev,
          score, driver, tier, boundary,
        }
        if (!best || score > best.score) best = row
      }
      if (best) out.push(best)
    }
    return out
  }, [flights, minFl, marginNm, altBufFl, waiverMul, typeWeight, typeFilter])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, WATCH: 0, CLOSE: 0, INCURSION: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumProx = 0, n = 0, waiver = 0
    let worstSev = -1, worstCs = '', worstNotam = ''
    let inc = 0
    const activeAreas = new Set<string>()
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      n++
      sumProx += r.signedProxNm
      if (r.hasWaiver) waiver++
      if (r.tier === 'INCURSION') inc++
      activeAreas.add(r.notam.id)
      if (r.score > worstSev) {
        worstSev = r.score
        worstCs = (r.f.callsign || r.f.icao).trim()
        worstNotam = r.notam.id
      }
    }
    return {
      meanProx: n ? sumProx / n : 0,
      waiverPct: n ? (waiver / n) * 100 : 0,
      worstCs, worstNotam, inc,
      active: n,
      activeAreas: activeAreas.size,
    }
  }, [rows])

  const areaAggs = useMemo(() => {
    const m = new Map<string, { notam: Notam; count: number; sumScore: number; worstSev: number; worstCs: string; worstIcao: string; worstTier: Tier; inc: number }>()
    for (const r of rows) {
      let a = m.get(r.notam.id)
      if (!a) { a = { notam: r.notam, count: 0, sumScore: 0, worstSev: -1, worstCs: '', worstIcao: '', worstTier: 'OK', inc: 0 }; m.set(r.notam.id, a) }
      a.count++
      a.sumScore += r.score
      if (r.tier === 'INCURSION') a.inc++
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.score > a.worstSev) { a.worstSev = r.score; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
    }
    const arr = Array.from(m.values()).map(a => ({ ...a, meanScore: a.count ? a.sumScore / a.count : 0 }))
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
        if (r.tier === 'IDLE' && tierFilter === 'ALL') return false
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.notam.id, r.notam.notam, r.notam.name].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, query])

  const filteredAreas = useMemo(() => {
    const q = query.trim().toUpperCase()
    return areaAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (!q) return true
      return (a.notam.id + ' ' + a.notam.notam + ' ' + a.notam.name).toUpperCase().includes(q)
    })
  }, [areaAggs, tierFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    // Circle perimeters for active NOTAMs (any area appearing in rows OR all if typeFilter)
    const activeNotamIds = new Set<string>()
    for (const r of rows) if (r.tier !== 'IDLE') activeNotamIds.add(r.notam.id)
    const circFeatures: any[] = []
    if (showCirc) {
      for (const n of NOTAMS) {
        if (typeFilter !== 'ALL' && n.type !== typeFilter) continue
        const isActive = activeNotamIds.has(n.id)
        const color = isActive ? '#f59e0b' : '#475569'
        circFeatures.push({
          type: 'Feature' as const,
          properties: { color, notam: n.notam, name: n.name },
          geometry: { type: 'LineString' as const, coordinates: circlePolygon(n.lat, n.lng, n.radiusNm, 36) },
        })
      }
    }
    const circFc = { type: 'FeatureCollection' as const, features: circFeatures }

    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'CLOSE' || r.tier === 'INCURSION').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} › ${r.notam.id} · ${r.driver}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'INCURSION').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${r.notam.id} ◆ INCURSION` },
      geometry: { type: 'Point' as const, coordinates: [r.boundary.lng, r.boundary.lat] },
    })) : [] }
    const projFeatures: any[] = []
    if (showProj) {
      for (const r of rows) {
        if (r.tier !== 'CLOSE' && r.tier !== 'INCURSION') continue
        const coords: [number, number][] = []
        for (let i = 0; i <= 12; i++) {
          const p = projectPosition(r.f.lat, r.f.lng, r.f.track || 0, (60 * i) / 12)
          coords.push([p.lng, p.lat])
        }
        projFeatures.push({ type: 'Feature' as const, properties: { color: TIER_COLOR[r.tier] }, geometry: { type: 'LineString' as const, coordinates: coords } })
      }
    }
    const projFc = { type: 'FeatureCollection' as const, features: projFeatures }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_CIRC, circFc, () => map.addLayer({ id: LYR_CIRC, type: 'line', source: SRC_CIRC, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.7, 'line-dasharray': [3, 2],
      } }))
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.7, 'line-dasharray': [2, 3],
      } }))
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
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_CIRC]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_PROJ, SRC_CIRC]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showCirc, showLabels, showPin, showProj, typeFilter])

  // Diagram: signed-prox-nm (x, -50..+50) vs ETA-min (y, 0..40)
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 30
    const xMin = -50, xMax = 50, yMax = 40
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">NOTAM / TFR Compliance</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.active} exp / {summary.activeAreas} areas</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Prox</div>
          <div className="font-mono text-sm" style={{ color: summary.meanProx > 0 ? '#fb7185' : summary.meanProx > -10 ? '#f59e0b' : '#10b981' }}>{summary.meanProx >= 0 ? '+' : ''}{summary.meanProx.toFixed(1)}<span className="text-[9px] text-slate-500"> nm</span></div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs + ' · ' + summary.worstNotam}>
            {summary.worstCs ? `${summary.worstCs}` : '—'}
            {summary.worstNotam && <span className="text-slate-500"> · {summary.worstNotam}</span>}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Incursion</div>
          <div className="font-mono text-sm" style={{ color: summary.inc > 0 ? '#fb7185' : '#10b981' }}>{summary.inc}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Active TFR</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.activeAreas}<span className="text-[9px] text-slate-500"> / {NOTAMS.length}</span></div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Waiver Cov</div>
          <div className="font-mono text-[11px]" style={{ color: summary.waiverPct >= 75 ? '#10b981' : summary.waiverPct >= 40 ? '#f59e0b' : '#fb7185' }}>{summary.waiverPct.toFixed(0)}<span className="text-[9px] text-slate-500"> %</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            {/* Rose-shaded inside-band right of x=0 */}
            <rect x={diag.xs(0)} y={6} width={diag.xs(diag.xMax) - diag.xs(0)} height={diag.H - diag.PAD - 2} fill="#fb7185" fillOpacity="0.10" />
            {/* Sky-shaded margin buffer left of x=0 */}
            <rect x={diag.xs(-marginNm)} y={6} width={diag.xs(0) - diag.xs(-marginNm)} height={diag.H - diag.PAD - 2} fill="#0ea5e9" fillOpacity="0.10" />
            {/* boundary x=0 */}
            <line x1={diag.xs(0)} x2={diag.xs(0)} y1={6} y2={diag.H - diag.PAD + 4} stroke="#fb7185" strokeWidth="1" strokeDasharray="3 2" />
            {/* ETA-MIN horizontal */}
            <line x1={diag.PAD} x2={diag.W - 6} y1={diag.ys(etaMinFilt)} y2={diag.ys(etaMinFilt)} stroke="#f59e0b" strokeWidth="1" strokeDasharray="3 2" />
            {/* Grid */}
            {[-40, -20, 0, 20, 40].map(v => (
              <g key={'gx' + v}>
                <line x1={diag.xs(v)} x2={diag.xs(v)} y1={6} y2={diag.H - diag.PAD + 2} stroke="#1e293b" strokeWidth="0.5" />
                <text x={diag.xs(v)} y={diag.H - diag.PAD + 12} fontSize="8" fill="#64748b" textAnchor="middle">{v >= 0 ? '+' : ''}{v}</text>
              </g>
            ))}
            {[10, 20, 30].map(v => (
              <g key={'gy' + v}>
                <line x1={diag.PAD} x2={diag.W - 6} y1={diag.ys(v)} y2={diag.ys(v)} stroke="#1e293b" strokeWidth="0.5" />
                <text x={4} y={diag.ys(v) + 3} fontSize="8" fill="#64748b">{v}m</text>
              </g>
            ))}
            <text x={diag.W - 6} y={diag.H - 4} fontSize="8" fill="#64748b" textAnchor="end">signed-prox nm</text>
            {/* aircraft */}
            {rows.filter(r => r.tier !== 'IDLE').map((r, i) => (
              <circle key={i} cx={diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, r.signedProxNm)))}
                cy={diag.ys(Math.max(0, Math.min(diag.yMax, r.etaMin === 999 ? diag.yMax : r.etaMin)))}
                r={2} fill={TIER_COLOR[r.tier]} fillOpacity="0.85" />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          {([
            ['MIN-FL', minFl, setMinFl, 0, 400, 10, 'FL'],
            ['MARGIN', marginNm, setMarginNm, 0, 100, 1, 'nm'],
            ['ETA-MIN', etaMinFilt, setEtaMinFilt, 2, 40, 1, 'm'],
            ['WAIVER', waiverMul, setWaiverMul, 50, 150, 5, '%'],
          ] as const).map(([lab, val, set, lo, hi, st, suf]) => (
            <label key={lab} className="text-[10px] text-slate-400 flex items-center gap-1.5">
              <span className="w-14 font-mono text-slate-500">{lab}</span>
              <input type="range" min={lo} max={hi} step={st} value={val} onChange={e => (set as any)(+e.target.value)} className="flex-1 accent-sky-500" />
              <span className="w-10 font-mono text-slate-300 text-right">{val}{suf}</span>
            </label>
          ))}
        </div>
        <label className="text-[10px] text-slate-400 flex items-center gap-1.5">
          <span className="w-14 font-mono text-slate-500">TYPE-W</span>
          <input type="range" min={50} max={150} step={5} value={typeWeight} onChange={e => setTypeWeight(+e.target.value)} className="flex-1 accent-sky-500" />
          <span className="w-10 font-mono text-slate-300 text-right">{typeWeight}%</span>
        </label>
        <label className="text-[10px] text-slate-400 flex items-center gap-1.5">
          <span className="w-14 font-mono text-slate-500">ALT-BUF</span>
          <input type="range" min={5} max={50} step={1} value={altBufFl} onChange={e => setAltBufFl(+e.target.value)} className="flex-1 accent-sky-500" />
          <span className="w-10 font-mono text-slate-300 text-right">{altBufFl} FL</span>
        </label>
        <div className="flex flex-wrap gap-1">
          {(['ALL', 'PRES', 'PROH', 'SPACE', 'STAD', 'VIP', 'DSTR', 'GPS', 'MOA', 'WARN'] as const).map(k => (
            <button key={k} onClick={() => setTypeFilter(k as any)}
              className={`px-1.5 py-0.5 text-[9px] rounded border font-mono ${typeFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-500'}`}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 text-[10px] text-slate-400">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showCirc} onChange={e => setShowCirc(e.target.checked)} className="accent-sky-500" /><span>CIRC</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / NOTAM / area"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'AREAS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${summary.active} exposed` : `${filteredAreas.length} areas`}</span>
        <span>{tab === 'AIRCRAFT' ? 'prox · alt · driver · tier' : 'area · ac · mean · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const barPct = Math.max(0, Math.min(100, r.score))
          const advice = r.tier === 'INCURSION'
            ? `inside ${r.notam.id} · ${r.notam.type} · ${r.hasWaiver ? 'WAIVER ON FILE' : 'NO WAIVER'} · contact ${r.notam.authority} now`
            : r.tier === 'CLOSE'
              ? `closing ${r.notam.id} boundary · ETA ${r.etaMin < 99 ? r.etaMin.toFixed(0) + 'm' : '—'} · ${r.driver}`
              : r.tier === 'WATCH'
                ? `within ${r.notam.id} buffer · monitor ${r.driver}`
                : `outside ${r.notam.id} envelope · nominal`
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{r.notam.id}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="flight level">F{Math.round(r.f.altitudeFt / 100)}</span>
                  <span title="signed proximity (positive = inside boundary)" style={{ color: r.signedProxNm >= 0 ? TIER_COLOR[r.tier] : '#94a3b8' }}>
                    {r.signedProxNm >= 0 ? '+' : ''}{r.signedProxNm.toFixed(1)}nm
                  </span>
                  <span title="altitude band">{r.altInBand ? 'IN-BAND' : `${r.altDeltaFl > 0 ? '+' : ''}${r.altDeltaFl.toFixed(0)}FL`}</span>
                  <span className="ml-auto" title="ETA to boundary" style={{ color: r.etaMin < etaMinFilt ? TIER_COLOR[r.tier] : '#64748b' }}>
                    ETA {r.etaMin < 99 ? r.etaMin.toFixed(0) + 'm' : '—'}
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
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="type">{r.notam.type}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="proximity severity">PRX {r.prxSev.toFixed(0)}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="altitude severity">ALT {r.altSev.toFixed(0)}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono" style={{ borderColor: r.hasWaiver ? '#10b98166' : '#fb718566', color: r.hasWaiver ? '#10b981' : '#fb7185', background: (r.hasWaiver ? '#10b981' : '#fb7185') + '14' }} title="waiver filed">{r.hasWaiver ? 'WAIVER' : 'NO-WVR'}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="minutes until expiry">EXP {r.timeWinMin}m</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'AREAS' && filteredAreas.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No areas match.</div>
        )}
        {tab === 'AREAS' && filteredAreas.map(a => {
          const barPct = Math.max(0, Math.min(100, a.meanScore))
          const advice = a.worstTier === 'INCURSION'
            ? `${a.inc} incursion(s) · contact ${a.notam.authority} · QRA risk`
            : a.worstTier === 'CLOSE'
              ? `aircraft closing · brief crews`
              : a.worstTier === 'WATCH'
                ? `area in buffer · monitor`
                : `area envelope nominal`
          return (
            <button key={a.notam.id} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.notam.id}</span>
                  <span className="text-slate-500 text-[10px] truncate">{a.notam.name}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="NOTAM ref">{a.notam.notam}</span>
                  <span title="type">{a.notam.type}</span>
                  <span title="radius / floor / ceiling">r {a.notam.radiusNm}nm · F{a.notam.floorFl}-{a.notam.ceilFl === 999 ? 'UNL' : a.notam.ceilFl}</span>
                  <span className="ml-auto truncate" title="worst">{a.worstCs || '—'}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="mean composite score 0-100">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${barPct}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500/80" style={{ left: '25%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400/80" style={{ left: '55%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400/80" style={{ left: '80%' }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate" title="authority">{a.notam.authority} · INC {a.inc}</span>
                  <span className="ml-auto truncate" style={{ color: a.worstTier === 'OK' ? '#64748b' : TIER_COLOR[a.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        ICAO Annex 15 §5 · FAA JO 7930.2R · 14 CFR 91.137/138/141/143/145 · 14 CFR 99 · 14 CFR 73 · AC 91-63D · {NOTAMS.length} active NOTAMs catalogue
      </div>
    </div>
  )
}
