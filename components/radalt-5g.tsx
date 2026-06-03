'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   5G C-Band Radio-Altimeter Interference & AMOC Compliance
   -----------------------------------------------------------
   FAA Airworthiness Directive AD 2021-23-12 (transport-category
   airplanes) · FAA AD 2023-10-02 (revised AMOC framework) ·
   FAA SAFO 21007 / SAFO 22002 · FAA Special Airworthiness
   Information Bulletin SAIB AIR-21-18 · FCC 19-3 Auction 107
   C-Band 3.7-3.98 GHz reallocation · RTCA SC-239 / DO-401
   Radio Altimeter Interference Tolerance MOPS · ITU-R M.2059
   protection criterion 4.2-4.4 GHz aeronautical radionavigation
   service · ICAO Annex 10 Vol I §3.1.6 radio-altimeter spectrum
   protection · ARINC 707 / ARINC 552 radio-altimeter spec ·
   EASA SIB 2022-02R3 5G interference with radio altimeters ·
   Boeing MOM-MOM-22-0220-01B / Airbus OIT 999.0148/22 5G C-Band
   advisory · CAST Approach-Sequencer 5G-NOTAM coordination.

   This monitor maintains a catalogue of 36 deployed 5G C-Band
   tower clusters near 36 major airports (US/EU/JP/KR) modelled
   as geometric bounding circles {lat, lng, radius-nm, EIRP-dBm,
   band-block, deployment-state, AMOC-required, carrier}.

   For every airborne or approaching aircraft inside the capture
   window we compute:
     SIGNED-EXP-NM    positive inside cluster, negative outside
     AGL-FT           altitude above field elev (radalt regime)
     PHASE            ARR / DEP / CRUISE
     AMOC-STATE       per-airframe FNV-1a 32-bit hash of ICAO24
                      yields hash-stable retrofit / AMOC filed
                      probability per airframe class (HVY 0.92,
                      NRW 0.78, RGN 0.45, BIZ 0.55, TBP 0.20,
                      GA 0.05, FTR 0.85)
     PSD-DBM-MHZ      reconstructed interference power-spectral
                      density via free-space path loss + tower
                      EIRP - 20*log10(4π·d/λ) at 3.98 GHz
     ITU-MARGIN-DB    margin to ITU-R M.2059 -109 dBm/MHz
                      protection criterion

   Six risk components, composite max-driver:
     EXP-SEV      cluster proximity: 50 at boundary ramping to
                  100 at +5 nm inside, 0 outside MARGIN slider
     AGL-SEV      AGL-band severity: radalt safety-critical
                  regime is < 2500 ft AGL per AD 2021-23-12;
                  100 at AGL ≤ 50 ft (Cat II/III autoland flare)
                  ramping to 0 at AGL ≥ 2500 ft
     PSD-SEV      ITU-R M.2059 margin: 100 if margin ≤ 0 dB,
                  ramping to 0 at margin ≥ 20 dB
     AMOC-SEV    (1 - amocProb) × 100 (lack of approved AMOC)
     PHASE-SEV   ARR with autoland armed worst (100), DEP CAT-III
                 80, ARR non-precision 60, CRUISE 20
     CARRIER-SEV per-carrier deployment-block severity scaled
                 by CARR-MUL slider (Verizon 3.7-3.8 GHz higher
                 risk to radalt 4.2-4.4 GHz guard 100 MHz,
                 AT&T 3.7-3.8 GHz, T-Mobile 3.45-3.55 GHz
                 lower-band lower risk, DT 3.4-3.8 GHz EU,
                 KDDI/SK 3.6-4.1 GHz APAC)

   Composite score = max-driver with dominant labelling
   (EXP / AGL / PSD / AMC / PHS / CAR).

   Tiers (5):
     AUTOLAND   AGL ≤ 200 ft AND inside cluster AND no AMOC
                OR score ≥ 80                              rose
     APCH-DEG   score 55-80 approach degraded              amber
     WATCH      score 25-55 within buffer                  sky
     OK         score < 25 nominal                         emerald
     IDLE       no exposure within capture                 slate

   MapLibre overlay (registered Layers > Safety & Traffic):
     - Tier-coloured halo rings sized by score 8-22 px
     - Amber 36-segment dashed circle for each cluster
       boundary (slate when no exposure)
     - Rose diamond pin at cluster intercept point for
       AUTOLAND tier aircraft
     - Tier-coloured callsign + cluster + driver labels
       for APCH-DEG / AUTOLAND
     - Dashed sky 12-seg forward projection 60 nm

   Side panel:
     - 4-tier counter strip click-to-filter
     - 3-cell MEAN-EXP / WORST / AUTOLAND-count
     - 2-cell ACTIVE-CLUSTERS / AMOC-COV %
     - SVG signed-exp-nm vs AGL-ft scatter with rose
       inside-band, amber radalt-critical band <2500 ft,
       dashed cluster vertical and AGL horizontal,
       aircraft as tier-coloured dots
     - 6 sliders MIN-FL / MARGIN / AGL-CRIT / AMOC-MUL /
       PSD-THR / CARR-MUL
     - 6-carrier chip filter VZW/ATT/TMO/DT/KDDI/SK
     - HALO/CIRC/LBL/PIN/PROJ/DIAG toggles + search
     - AIRCRAFT / CLUSTERS tab switcher
     - AIRCRAFT tier-worst-first then score desc with
       score bar (sky-25/amber-55/rose-80 ticks)
     - CLUSTERS grouped by tower, mean-score bar

   Persisted: ft-radalt5g
   ============================================================ */

export interface RadaltFlight {
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
  flights: RadaltFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'WATCH' | 'APCH-DEG' | 'AUTOLAND' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981',
  WATCH: '#0ea5e9',
  'APCH-DEG': '#f59e0b',
  AUTOLAND: '#fb7185',
  IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['AUTOLAND', 'APCH-DEG', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { AUTOLAND: 0, 'APCH-DEG': 1, WATCH: 2, OK: 3, IDLE: 4 }

type Carrier = 'VZW' | 'ATT' | 'TMO' | 'DT' | 'KDDI' | 'SK'
const CARR_NAME: Record<Carrier, string> = {
  VZW: 'Verizon C-Band 3.7-3.8 GHz',
  ATT: 'AT&T C-Band 3.7-3.8 GHz',
  TMO: 'T-Mobile 3.45-3.55 GHz',
  DT: 'Deutsche Telekom 3.4-3.8 GHz',
  KDDI: 'KDDI/au 3.6-4.1 GHz',
  SK: 'SK Telecom 3.6-4.0 GHz',
}
// Per-carrier guard-band-driven severity (closer to 4.2 GHz radalt floor → worse)
const CARR_SEV: Record<Carrier, number> = { VZW: 95, ATT: 95, TMO: 40, DT: 75, KDDI: 85, SK: 80 }
interface Cluster {
  id: string            // airport code
  name: string          // airport+city
  lat: number
  lng: number            // tower-centroid (use field for proxy)
  fieldElevFt: number
  radiusNm: number      // 5G coverage radius
  eirpDbm: number       // typical max EIRP per sector
  band: string          // freq block
  carrier: Carrier
  amocRequired: boolean // FAA AMOC for this airport
}

// 36-entry catalogue: 28 US (AD 2021-23-12 affected airports) + 8 international
const CLUSTERS: Cluster[] = [
  // US — Tier-1 FAA AMOC-required airports per AD 2021-23-12 / 2023-10-02
  { id: 'KATL', name: 'Atlanta Hartsfield-Jackson', lat: 33.6407, lng: -84.4277, fieldElevFt: 1026, radiusNm: 12, eirpDbm: 72, band: '3.7-3.8 GHz', carrier: 'VZW', amocRequired: true },
  { id: 'KORD', name: 'Chicago O\u2019Hare', lat: 41.9742, lng: -87.9073, fieldElevFt: 672, radiusNm: 15, eirpDbm: 72, band: '3.7-3.8 GHz', carrier: 'VZW', amocRequired: true },
  { id: 'KDFW', name: 'Dallas/Fort Worth', lat: 32.8998, lng: -97.0403, fieldElevFt: 607, radiusNm: 14, eirpDbm: 72, band: '3.7-3.8 GHz', carrier: 'ATT', amocRequired: true },
  { id: 'KDEN', name: 'Denver International', lat: 39.8561, lng: -104.6737, fieldElevFt: 5431, radiusNm: 13, eirpDbm: 70, band: '3.7-3.8 GHz', carrier: 'VZW', amocRequired: true },
  { id: 'KJFK', name: 'New York JFK', lat: 40.6413, lng: -73.7781, fieldElevFt: 13, radiusNm: 11, eirpDbm: 72, band: '3.7-3.8 GHz', carrier: 'VZW', amocRequired: true },
  { id: 'KLAX', name: 'Los Angeles International', lat: 33.9425, lng: -118.4081, fieldElevFt: 125, radiusNm: 12, eirpDbm: 72, band: '3.7-3.8 GHz', carrier: 'ATT', amocRequired: true },
  { id: 'KSFO', name: 'San Francisco International', lat: 37.6213, lng: -122.3790, fieldElevFt: 13, radiusNm: 10, eirpDbm: 72, band: '3.7-3.8 GHz', carrier: 'VZW', amocRequired: true },
  { id: 'KSEA', name: 'Seattle-Tacoma', lat: 47.4502, lng: -122.3088, fieldElevFt: 432, radiusNm: 11, eirpDbm: 70, band: '3.7-3.8 GHz', carrier: 'ATT', amocRequired: true },
  { id: 'KBOS', name: 'Boston Logan', lat: 42.3656, lng: -71.0096, fieldElevFt: 20, radiusNm: 9, eirpDbm: 70, band: '3.7-3.8 GHz', carrier: 'VZW', amocRequired: true },
  { id: 'KEWR', name: 'Newark Liberty', lat: 40.6895, lng: -74.1745, fieldElevFt: 18, radiusNm: 10, eirpDbm: 72, band: '3.7-3.8 GHz', carrier: 'VZW', amocRequired: true },
  { id: 'KIAH', name: 'Houston George Bush', lat: 29.9844, lng: -95.3414, fieldElevFt: 97, radiusNm: 12, eirpDbm: 72, band: '3.7-3.8 GHz', carrier: 'ATT', amocRequired: true },
  { id: 'KPHX', name: 'Phoenix Sky Harbor', lat: 33.4342, lng: -112.0116, fieldElevFt: 1135, radiusNm: 10, eirpDbm: 70, band: '3.7-3.8 GHz', carrier: 'VZW', amocRequired: true },
  { id: 'KMIA', name: 'Miami International', lat: 25.7959, lng: -80.2870, fieldElevFt: 8, radiusNm: 11, eirpDbm: 72, band: '3.7-3.8 GHz', carrier: 'ATT', amocRequired: true },
  { id: 'KMSP', name: 'Minneapolis-St. Paul', lat: 44.8848, lng: -93.2223, fieldElevFt: 841, radiusNm: 10, eirpDbm: 70, band: '3.7-3.8 GHz', carrier: 'VZW', amocRequired: true },
  { id: 'KDTW', name: 'Detroit Metropolitan', lat: 42.2125, lng: -83.3534, fieldElevFt: 645, radiusNm: 10, eirpDbm: 70, band: '3.7-3.8 GHz', carrier: 'VZW', amocRequired: true },
  { id: 'KPHL', name: 'Philadelphia International', lat: 39.8721, lng: -75.2411, fieldElevFt: 36, radiusNm: 9, eirpDbm: 70, band: '3.7-3.8 GHz', carrier: 'VZW', amocRequired: true },
  { id: 'KLGA', name: 'New York LaGuardia', lat: 40.7769, lng: -73.8740, fieldElevFt: 21, radiusNm: 8, eirpDbm: 72, band: '3.7-3.8 GHz', carrier: 'VZW', amocRequired: true },
  { id: 'KBWI', name: 'Baltimore/Washington', lat: 39.1754, lng: -76.6683, fieldElevFt: 146, radiusNm: 9, eirpDbm: 70, band: '3.7-3.8 GHz', carrier: 'ATT', amocRequired: true },
  { id: 'KDCA', name: 'Reagan Washington', lat: 38.8521, lng: -77.0377, fieldElevFt: 15, radiusNm: 7, eirpDbm: 68, band: '3.7-3.8 GHz', carrier: 'VZW', amocRequired: true },
  { id: 'KIAD', name: 'Washington Dulles', lat: 38.9531, lng: -77.4565, fieldElevFt: 312, radiusNm: 11, eirpDbm: 70, band: '3.7-3.8 GHz', carrier: 'VZW', amocRequired: true },
  { id: 'KSAN', name: 'San Diego International', lat: 32.7338, lng: -117.1933, fieldElevFt: 17, radiusNm: 8, eirpDbm: 70, band: '3.7-3.8 GHz', carrier: 'ATT', amocRequired: true },
  { id: 'KSLC', name: 'Salt Lake City', lat: 40.7899, lng: -111.9791, fieldElevFt: 4227, radiusNm: 11, eirpDbm: 70, band: '3.7-3.8 GHz', carrier: 'VZW', amocRequired: true },
  { id: 'KMDW', name: 'Chicago Midway', lat: 41.7868, lng: -87.7522, fieldElevFt: 620, radiusNm: 8, eirpDbm: 68, band: '3.7-3.8 GHz', carrier: 'VZW', amocRequired: true },
  { id: 'KMCO', name: 'Orlando International', lat: 28.4312, lng: -81.3081, fieldElevFt: 96, radiusNm: 10, eirpDbm: 70, band: '3.7-3.8 GHz', carrier: 'ATT', amocRequired: true },
  { id: 'KCLT', name: 'Charlotte Douglas', lat: 35.2140, lng: -80.9431, fieldElevFt: 748, radiusNm: 10, eirpDbm: 70, band: '3.7-3.8 GHz', carrier: 'ATT', amocRequired: true },
  // T-Mobile 3.45 GHz lower-risk (US)
  { id: 'KAUS', name: 'Austin-Bergstrom', lat: 30.1975, lng: -97.6664, fieldElevFt: 542, radiusNm: 9, eirpDbm: 68, band: '3.45-3.55 GHz', carrier: 'TMO', amocRequired: false },
  { id: 'KPDX', name: 'Portland International', lat: 45.5887, lng: -122.5975, fieldElevFt: 31, radiusNm: 9, eirpDbm: 68, band: '3.45-3.55 GHz', carrier: 'TMO', amocRequired: false },
  { id: 'KTPA', name: 'Tampa International', lat: 27.9755, lng: -82.5332, fieldElevFt: 26, radiusNm: 9, eirpDbm: 68, band: '3.45-3.55 GHz', carrier: 'TMO', amocRequired: false },
  // International — EU
  { id: 'EGLL', name: 'London Heathrow', lat: 51.4700, lng: -0.4543, fieldElevFt: 83, radiusNm: 11, eirpDbm: 68, band: '3.4-3.8 GHz', carrier: 'DT', amocRequired: false },
  { id: 'EDDF', name: 'Frankfurt Main', lat: 50.0379, lng: 8.5622, fieldElevFt: 364, radiusNm: 12, eirpDbm: 68, band: '3.4-3.8 GHz', carrier: 'DT', amocRequired: true },
  { id: 'LFPG', name: 'Paris Charles de Gaulle', lat: 49.0097, lng: 2.5479, fieldElevFt: 392, radiusNm: 12, eirpDbm: 68, band: '3.4-3.8 GHz', carrier: 'DT', amocRequired: false },
  { id: 'EHAM', name: 'Amsterdam Schiphol', lat: 52.3105, lng: 4.7683, fieldElevFt: -11, radiusNm: 11, eirpDbm: 68, band: '3.4-3.8 GHz', carrier: 'DT', amocRequired: false },
  { id: 'LEMD', name: 'Madrid Barajas', lat: 40.4719, lng: -3.5626, fieldElevFt: 1998, radiusNm: 11, eirpDbm: 68, band: '3.4-3.8 GHz', carrier: 'DT', amocRequired: false },
  // International — APAC
  { id: 'RJTT', name: 'Tokyo Haneda', lat: 35.5494, lng: 139.7798, fieldElevFt: 35, radiusNm: 10, eirpDbm: 70, band: '3.6-4.1 GHz', carrier: 'KDDI', amocRequired: true },
  { id: 'RJAA', name: 'Tokyo Narita', lat: 35.7647, lng: 140.3863, fieldElevFt: 135, radiusNm: 12, eirpDbm: 70, band: '3.6-4.1 GHz', carrier: 'KDDI', amocRequired: true },
  { id: 'RKSI', name: 'Seoul Incheon', lat: 37.4602, lng: 126.4407, fieldElevFt: 23, radiusNm: 11, eirpDbm: 70, band: '3.6-4.0 GHz', carrier: 'SK', amocRequired: true },
]

function classifyAircraft(t: string | undefined, _cat?: string) {
  const x = (t || '').toUpperCase()
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|MIG|SU)/.test(x)) return 'FTR'
  if (/^(B77|B78|A33|A34|A35|A38|B74)/.test(x)) return 'HVY'
  if (/^(B73|A31|A32|A19|A20|A21|A22|BCS|CS1|CS3)/.test(x)) return 'NRW'
  if (/^(CRJ|E14|E15|E17|E19|E70|E75|AT4|AT5|AT7|DH8|Q40)/.test(x)) return 'RGN'
  if (/^(GLF|GL5|GL7|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'BIZ'
  if (/^(C72|C82|C17|P28|SR2|DA4|DA62|PA|M20|C20)/.test(x)) return 'GA'
  if (/^(ATR|AT4|AT7|DH8|Q40|SF34|J32|SW4)/.test(x)) return 'TBP'
  return 'NRW'
}

// Per-class AMOC retrofit probability (RTCA DO-401 compliant filter installed)
const CLASS_AMOC: Record<string, number> = { HVY: 0.92, NRW: 0.78, RGN: 0.45, BIZ: 0.55, TBP: 0.20, GA: 0.05, FTR: 0.85 }

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

type Driver = 'EXP' | 'AGL' | 'PSD' | 'AMC' | 'PHS' | 'CAR'
const DRIVER_NAME: Record<Driver, string> = {
  EXP: 'Cluster exposure',
  AGL: 'Radalt-critical AGL band',
  PSD: 'ITU-R M.2059 PSD margin',
  AMC: 'AMOC retrofit',
  PHS: 'Phase of flight',
  CAR: 'Carrier band block',
}

type Phase = 'ARR' | 'DEP' | 'CRZ'

interface Row {
  f: RadaltFlight
  klass: string
  cluster: Cluster
  signedExpNm: number
  aglFt: number
  phase: Phase
  amocProb: number
  hasAmoc: boolean
  psdDbm: number          // received PSD in dBm/MHz
  itMarginDb: number      // headroom above ITU-R M.2059 -109 dBm/MHz
  expSev: number
  aglSev: number
  psdSev: number
  amocSev: number
  phaseSev: number
  carSev: number
  score: number
  driver: Driver
  tier: Tier
  boundary: { lat: number, lng: number }
}

const SRC_HALO = 'radalt5g-halo', SRC_LBL = 'radalt5g-lbl', SRC_PIN = 'radalt5g-pin', SRC_PROJ = 'radalt5g-proj', SRC_CIRC = 'radalt5g-circ'
const LYR_HALO = 'radalt5g-halo-l', LYR_LBL = 'radalt5g-lbl-l', LYR_PIN = 'radalt5g-pin-l', LYR_PROJ = 'radalt5g-proj-l', LYR_CIRC = 'radalt5g-circ-l'

function circlePolygon(lat: number, lng: number, rNm: number, segs = 36): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i <= segs; i++) {
    const p = projectPosition(lat, lng, (i / segs) * 360, rNm)
    out.push([p.lng, p.lat])
  }
  return out
}

export default function Radalt5g({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLUSTERS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [carrierFilter, setCarrierFilter] = useState<Carrier | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [marginNm, setMarginNm] = useState(15)
  const [aglCrit, setAglCrit] = useState(2500)
  const [amocMul, setAmocMul] = useState(100)
  const [psdThrDb, setPsdThrDb] = useState(0)   // dB margin threshold
  const [carrMul, setCarrMul] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showCirc, setShowCirc] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const cap = marginNm + 5
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl) continue
      const klass = classifyAircraft(f.type, f.category)
      const h = hash32(f.icao || '')

      let best: Row | null = null
      for (const c of CLUSTERS) {
        if (carrierFilter !== 'ALL' && c.carrier !== carrierFilter) continue
        const distNm = haversineNm(f.lat, f.lng, c.lat, c.lng)
        const signedExpNm = c.radiusNm - distNm
        if (signedExpNm < -cap) continue

        // AGL above field elevation
        const aglFt = Math.max(0, f.altitudeFt - c.fieldElevFt)

        // phase inference
        const vr = f.vertRate || 0
        let phase: Phase
        if (aglFt < 8000 && vr < -200) phase = 'ARR'
        else if (aglFt < 6000 && vr > 200) phase = 'DEP'
        else phase = 'CRZ'

        // AMOC probability — class base × carrier-amoc-required × mul
        const h2 = hash32(f.icao + ':' + c.id)
        const baseProb = (CLASS_AMOC[klass] || 0.5) * (c.amocRequired ? 1 : 0.4)
        const noise = (((h2 % 100) / 100) - 0.5) * 0.25
        const amocProb = Math.max(0, Math.min(1, baseProb + noise)) * (amocMul / 100)
        const hasAmoc = ((h2 >>> 11) % 1000) / 1000 < amocProb

        // PSD reconstruction — free-space path loss at 3.98 GHz
        // λ ≈ 0.0754 m → 20*log10(4π/λ) ≈ 44.4 dB (intrinsic)
        // FSPL_dB = 20*log10(d_m) + 20*log10(f_Hz) - 147.55
        // Use simplified: PSD(dBm/MHz) = EIRP - FSPL + horiz-gain-adj
        const dMeters = Math.max(100, distNm * 1852)
        const fspl = 20 * Math.log10(dMeters) + 20 * Math.log10(3.98e9) - 147.55
        // PSD per MHz from total EIRP across 100 MHz block: -20 dB
        const psdDbm = c.eirpDbm - fspl - 20
        const itMarginDb = psdDbm - (-109) // margin above protection criterion

        // severity components
        let expSev = 0
        if (signedExpNm >= 0) {
          expSev = Math.min(100, 50 + (signedExpNm / 5) * 50)
        } else if (-signedExpNm <= marginNm) {
          expSev = Math.max(0, 50 * (1 - (-signedExpNm) / marginNm))
        }

        // AGL severity — radalt-critical band <2500 ft
        let aglSev = 0
        if (aglFt <= 50) aglSev = 100
        else if (aglFt <= aglCrit) aglSev = Math.max(0, 100 * (1 - (aglFt - 50) / Math.max(1, aglCrit - 50)))

        // PSD severity — margin vs psdThrDb (positive margin = more interference)
        // Above protection floor = bad. score 100 at margin>=20 dB above floor, 0 at margin<=psdThr-20
        const psdSev = Math.max(0, Math.min(100, ((itMarginDb - psdThrDb) + 20) / 40 * 100)) * (signedExpNm >= -marginNm ? 1 : 0)

        const amocSev = (1 - amocProb) * 100

        // phase severity
        const phaseSev = phase === 'ARR' ? (aglFt < 200 ? 100 : aglFt < 1000 ? 80 : 60)
          : phase === 'DEP' ? (aglFt < 1000 ? 80 : 50)
            : 20

        const carSev = CARR_SEV[c.carrier] * (carrMul / 100)

        // composite — exposure-gated
        const exposure = signedExpNm >= 0 || (-signedExpNm) <= marginNm
        const gated = (v: number, m: number) => signedExpNm >= 0 ? v : v * m
        const score = exposure ? Math.max(
          expSev,
          gated(aglSev, 0.7),
          psdSev,
          gated(amocSev, 0.4),
          gated(phaseSev, 0.6),
          gated(carSev, 0.5),
        ) : 0

        const sevs: { d: Driver, v: number }[] = [
          { d: 'EXP', v: expSev },
          { d: 'AGL', v: gated(aglSev, 0.7) },
          { d: 'PSD', v: psdSev },
          { d: 'AMC', v: gated(amocSev, 0.4) },
          { d: 'PHS', v: gated(phaseSev, 0.6) },
          { d: 'CAR', v: gated(carSev, 0.5) },
        ]
        sevs.sort((a, b) => b.v - a.v)
        const driver = sevs[0].d

        let tier: Tier
        if (aglFt <= 200 && signedExpNm >= 0 && !hasAmoc) tier = 'AUTOLAND'
        else if (score >= 80) tier = 'AUTOLAND'
        else if (score >= 55) tier = 'APCH-DEG'
        else if (score >= 25) tier = 'WATCH'
        else if (exposure) tier = 'OK'
        else tier = 'IDLE'

        const brgInbound = bearingDeg(f.lat, f.lng, c.lat, c.lng)
        const boundary = projectPosition(c.lat, c.lng, brgInbound + 180, c.radiusNm)

        const row: Row = {
          f, klass, cluster: c, signedExpNm, aglFt, phase,
          amocProb, hasAmoc, psdDbm, itMarginDb,
          expSev, aglSev, psdSev, amocSev, phaseSev, carSev,
          score, driver, tier, boundary,
        }
        if (!best || score > best.score) best = row
      }
      if (best) out.push(best)
    }
    return out
  }, [flights, minFl, marginNm, aglCrit, amocMul, psdThrDb, carrMul, carrierFilter])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, WATCH: 0, 'APCH-DEG': 0, AUTOLAND: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumExp = 0, n = 0, amoc = 0
    let worstSev = -1, worstCs = '', worstCl = ''
    let auto = 0
    const activeClusters = new Set<string>()
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      n++
      sumExp += r.signedExpNm
      if (r.hasAmoc) amoc++
      if (r.tier === 'AUTOLAND') auto++
      activeClusters.add(r.cluster.id)
      if (r.score > worstSev) {
        worstSev = r.score
        worstCs = (r.f.callsign || r.f.icao).trim()
        worstCl = r.cluster.id
      }
    }
    return {
      meanExp: n ? sumExp / n : 0,
      amocPct: n ? (amoc / n) * 100 : 0,
      worstCs, worstCl, auto,
      active: n,
      activeClusters: activeClusters.size,
    }
  }, [rows])

  const clusterAggs = useMemo(() => {
    const m = new Map<string, { cluster: Cluster; count: number; sumScore: number; worstSev: number; worstCs: string; worstIcao: string; worstTier: Tier; auto: number }>()
    for (const r of rows) {
      let a = m.get(r.cluster.id)
      if (!a) { a = { cluster: r.cluster, count: 0, sumScore: 0, worstSev: -1, worstCs: '', worstIcao: '', worstTier: 'OK', auto: 0 }; m.set(r.cluster.id, a) }
      a.count++
      a.sumScore += r.score
      if (r.tier === 'AUTOLAND') a.auto++
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
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.cluster.id, r.cluster.name, r.cluster.carrier].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, query])

  const filteredClusters = useMemo(() => {
    const q = query.trim().toUpperCase()
    return clusterAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (!q) return true
      return (a.cluster.id + ' ' + a.cluster.name + ' ' + a.cluster.carrier).toUpperCase().includes(q)
    })
  }, [clusterAggs, tierFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const activeClusterIds = new Set<string>()
    for (const r of rows) if (r.tier !== 'IDLE') activeClusterIds.add(r.cluster.id)
    const circFeatures: any[] = []
    if (showCirc) {
      for (const c of CLUSTERS) {
        if (carrierFilter !== 'ALL' && c.carrier !== carrierFilter) continue
        const isActive = activeClusterIds.has(c.id)
        const color = isActive ? '#f59e0b' : '#475569'
        circFeatures.push({
          type: 'Feature' as const,
          properties: { color, id: c.id, name: c.name },
          geometry: { type: 'LineString' as const, coordinates: circlePolygon(c.lat, c.lng, c.radiusNm, 36) },
        })
      }
    }
    const circFc = { type: 'FeatureCollection' as const, features: circFeatures }

    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'APCH-DEG' || r.tier === 'AUTOLAND').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} › ${r.cluster.id} · ${r.driver}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'AUTOLAND').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${r.cluster.id} ◆ AUTOLAND` },
      geometry: { type: 'Point' as const, coordinates: [r.boundary.lng, r.boundary.lat] },
    })) : [] }
    const projFeatures: any[] = []
    if (showProj) {
      for (const r of rows) {
        if (r.tier !== 'APCH-DEG' && r.tier !== 'AUTOLAND') continue
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
  }, [map, rows, showHalo, showCirc, showLabels, showPin, showProj, carrierFilter])

  // Diagram: signed-exp-nm (x, -25..+15) vs AGL-ft (y, 0..5000)
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 30
    const xMin = -25, xMax = 15, yMax = 5000
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">5G C-Band / Radalt</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.active} exp / {summary.activeClusters} clusters</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Exp</div>
          <div className="font-mono text-sm" style={{ color: summary.meanExp > 0 ? '#fb7185' : summary.meanExp > -10 ? '#f59e0b' : '#10b981' }}>{summary.meanExp >= 0 ? '+' : ''}{summary.meanExp.toFixed(1)}<span className="text-[9px] text-slate-500"> nm</span></div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs + ' · ' + summary.worstCl}>
            {summary.worstCs ? `${summary.worstCs}` : '—'}
            {summary.worstCl && <span className="text-slate-500"> · {summary.worstCl}</span>}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Autoland</div>
          <div className="font-mono text-sm" style={{ color: summary.auto > 0 ? '#fb7185' : '#10b981' }}>{summary.auto}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Active Clusters</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.activeClusters}<span className="text-[9px] text-slate-500"> / {CLUSTERS.length}</span></div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">AMOC Cov</div>
          <div className="font-mono text-[11px]" style={{ color: summary.amocPct >= 75 ? '#10b981' : summary.amocPct >= 40 ? '#f59e0b' : '#fb7185' }}>{summary.amocPct.toFixed(0)}<span className="text-[9px] text-slate-500"> %</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            {/* Rose-shaded inside-band right of x=0 */}
            <rect x={diag.xs(0)} y={6} width={diag.xs(diag.xMax) - diag.xs(0)} height={diag.H - diag.PAD - 2} fill="#fb7185" fillOpacity="0.10" />
            {/* Amber radalt-critical band below AGL aglCrit */}
            <rect x={diag.PAD} y={diag.ys(aglCrit)} width={diag.W - diag.PAD - 6} height={(diag.H - diag.PAD - 2) - (diag.ys(aglCrit) - 6)} fill="#f59e0b" fillOpacity="0.08" />
            {/* boundary x=0 */}
            <line x1={diag.xs(0)} x2={diag.xs(0)} y1={6} y2={diag.H - diag.PAD + 4} stroke="#fb7185" strokeWidth="1" strokeDasharray="3 2" />
            {/* AGL-CRIT horizontal */}
            <line x1={diag.PAD} x2={diag.W - 6} y1={diag.ys(aglCrit)} y2={diag.ys(aglCrit)} stroke="#f59e0b" strokeWidth="1" strokeDasharray="3 2" />
            {/* Cat-III floor at 200 ft AGL */}
            <line x1={diag.PAD} x2={diag.W - 6} y1={diag.ys(200)} y2={diag.ys(200)} stroke="#fb7185" strokeWidth="1" strokeDasharray="2 3" />
            {/* Grid */}
            {[-20, -10, 0, 10].map(v => (
              <g key={'gx' + v}>
                <line x1={diag.xs(v)} x2={diag.xs(v)} y1={6} y2={diag.H - diag.PAD + 2} stroke="#1e293b" strokeWidth="0.5" />
                <text x={diag.xs(v)} y={diag.H - diag.PAD + 12} fontSize="8" fill="#64748b" textAnchor="middle">{v >= 0 ? '+' : ''}{v}</text>
              </g>
            ))}
            {[1000, 2500, 4000].map(v => (
              <g key={'gy' + v}>
                <line x1={diag.PAD} x2={diag.W - 6} y1={diag.ys(v)} y2={diag.ys(v)} stroke="#1e293b" strokeWidth="0.5" />
                <text x={4} y={diag.ys(v) + 3} fontSize="8" fill="#64748b">{v}</text>
              </g>
            ))}
            <text x={diag.W - 6} y={diag.H - 4} fontSize="8" fill="#64748b" textAnchor="end">signed-exp nm · AGL ft</text>
            {rows.filter(r => r.tier !== 'IDLE').map((r, i) => (
              <circle key={i} cx={diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, r.signedExpNm)))}
                cy={diag.ys(Math.max(0, Math.min(diag.yMax, r.aglFt)))}
                r={2} fill={TIER_COLOR[r.tier]} fillOpacity="0.85" />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          {([
            ['MIN-FL', minFl, setMinFl, 0, 400, 10, 'FL'],
            ['MARGIN', marginNm, setMarginNm, 0, 50, 1, 'nm'],
            ['AGL-CRIT', aglCrit, setAglCrit, 500, 5000, 100, 'ft'],
            ['AMOC', amocMul, setAmocMul, 50, 150, 5, '%'],
          ] as const).map(([lab, val, set, lo, hi, st, suf]) => (
            <label key={lab} className="text-[10px] text-slate-400 flex items-center gap-1.5">
              <span className="w-14 font-mono text-slate-500">{lab}</span>
              <input type="range" min={lo} max={hi} step={st} value={val} onChange={e => (set as any)(+e.target.value)} className="flex-1 accent-sky-500" />
              <span className="w-12 font-mono text-slate-300 text-right">{val}{suf}</span>
            </label>
          ))}
        </div>
        <label className="text-[10px] text-slate-400 flex items-center gap-1.5">
          <span className="w-14 font-mono text-slate-500">PSD-THR</span>
          <input type="range" min={-20} max={20} step={1} value={psdThrDb} onChange={e => setPsdThrDb(+e.target.value)} className="flex-1 accent-sky-500" />
          <span className="w-12 font-mono text-slate-300 text-right">{psdThrDb}dB</span>
        </label>
        <label className="text-[10px] text-slate-400 flex items-center gap-1.5">
          <span className="w-14 font-mono text-slate-500">CARR-MUL</span>
          <input type="range" min={50} max={150} step={5} value={carrMul} onChange={e => setCarrMul(+e.target.value)} className="flex-1 accent-sky-500" />
          <span className="w-12 font-mono text-slate-300 text-right">{carrMul}%</span>
        </label>
        <div className="flex flex-wrap gap-1">
          {(['ALL', 'VZW', 'ATT', 'TMO', 'DT', 'KDDI', 'SK'] as const).map(k => (
            <button key={k} onClick={() => setCarrierFilter(k as any)}
              className={`px-1.5 py-0.5 text-[9px] rounded border font-mono ${carrierFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-500'}`}>{k}</button>
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
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / airport / carrier"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'CLUSTERS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${summary.active} exposed` : `${filteredClusters.length} clusters`}</span>
        <span>{tab === 'AIRCRAFT' ? 'AGL · exp · driver · tier' : 'cluster · ac · mean · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const barPct = Math.max(0, Math.min(100, r.score))
          const advice = r.tier === 'AUTOLAND'
            ? `inside ${r.cluster.id} ${r.cluster.carrier} · ${r.hasAmoc ? 'AMOC ON FILE' : 'NO AMOC'} · do not use radalt-dependent autoland`
            : r.tier === 'APCH-DEG'
              ? `closing ${r.cluster.id} · phase ${r.phase} · ${r.driver} · brief CAT-I only`
              : r.tier === 'WATCH'
                ? `within ${r.cluster.id} buffer · monitor ${r.driver}`
                : `outside ${r.cluster.id} envelope · nominal`
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{r.cluster.id}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="AGL feet above field elev" style={{ color: r.aglFt <= 200 ? '#fb7185' : r.aglFt <= aglCrit ? '#f59e0b' : '#94a3b8' }}>AGL {r.aglFt.toFixed(0)}</span>
                  <span title="signed exposure (positive = inside cluster)" style={{ color: r.signedExpNm >= 0 ? TIER_COLOR[r.tier] : '#94a3b8' }}>
                    {r.signedExpNm >= 0 ? '+' : ''}{r.signedExpNm.toFixed(1)}nm
                  </span>
                  <span title="phase">{r.phase}</span>
                  <span className="ml-auto" title="ITU-R M.2059 PSD margin (dB above -109 dBm/MHz)" style={{ color: r.itMarginDb > psdThrDb ? '#fb7185' : '#64748b' }}>
                    PSD {r.itMarginDb >= 0 ? '+' : ''}{r.itMarginDb.toFixed(0)}dB
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
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="carrier">{r.cluster.carrier}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="exposure severity">EXP {r.expSev.toFixed(0)}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="AGL severity">AGL {r.aglSev.toFixed(0)}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono" style={{ borderColor: r.hasAmoc ? '#10b98166' : '#fb718566', color: r.hasAmoc ? '#10b981' : '#fb7185', background: (r.hasAmoc ? '#10b981' : '#fb7185') + '14' }} title="AMOC filed">{r.hasAmoc ? 'AMOC' : 'NO-AMC'}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="received PSD">{r.psdDbm.toFixed(0)}dBm</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'CLUSTERS' && filteredClusters.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No clusters match.</div>
        )}
        {tab === 'CLUSTERS' && filteredClusters.map(a => {
          const barPct = Math.max(0, Math.min(100, a.meanScore))
          const advice = a.worstTier === 'AUTOLAND'
            ? `${a.auto} autoland-risk · ${a.cluster.carrier} · file AMOC / CAT-I only`
            : a.worstTier === 'APCH-DEG'
              ? `aircraft on approach · brief radalt-degraded ops`
              : a.worstTier === 'WATCH'
                ? `cluster in buffer · monitor`
                : `cluster envelope nominal`
          return (
            <button key={a.cluster.id} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.cluster.id}</span>
                  <span className="text-slate-500 text-[10px] truncate">{a.cluster.name}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="carrier">{a.cluster.carrier}</span>
                  <span title="band">{a.cluster.band}</span>
                  <span title="radius nm / EIRP dBm">r {a.cluster.radiusNm}nm · {a.cluster.eirpDbm}dBm</span>
                  <span className="ml-auto truncate" title="worst">{a.worstCs || '—'}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="mean composite score 0-100">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${barPct}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500/80" style={{ left: '25%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400/80" style={{ left: '55%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400/80" style={{ left: '80%' }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate" title="amoc / elev">{a.cluster.amocRequired ? 'AMOC-REQ' : 'AMOC-OPT'} · elev {a.cluster.fieldElevFt}ft · AUTO {a.auto}</span>
                  <span className="ml-auto truncate" style={{ color: a.worstTier === 'OK' ? '#64748b' : TIER_COLOR[a.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        FAA AD 2021-23-12 · AD 2023-10-02 · SAIB AIR-21-18 · RTCA DO-401 · ITU-R M.2059 · EASA SIB 2022-02R3 · {CLUSTERS.length} cluster catalogue · {Object.keys(CARR_NAME).length} carriers
      </div>
    </div>
  )
}
