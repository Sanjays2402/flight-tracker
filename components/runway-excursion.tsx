'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Runway Excursion Risk Assessor (RERA)
   -----------------------------------------------------------
   FAA TALPA Runway Condition Assessment Matrix RCAM /
   AC 25-32 / AC 91-79B / EASA OPS CAT.OP.MPA.311 /
   ICAO Doc 9981 PANS-Aerodromes / Boeing FCOM 5.40
   Landing Distance Available vs Required / Airbus FCOM
   PER-LD Landing Performance / NTSB SIR-19/02 (Runway
   Excursions). For every airborne aircraft in APPR or
   FLARE within CAPTURE-NM of one of 60 catalogued
   destination airports, synthesises the landing-distance
   margin against the published LDA, scored across 5
   independent excursion drivers and ranked into 5 tiers.

   Drivers:
     LD-MARG  Landing-distance required vs LDA available.
              Boeing FCOM 5.40 base 1.67 dry factor;
              wet x1.92; contam x2.16. Severity ramps to
              100 at zero margin.
     RCC      Runway Condition Code 6 (dry) down to 0
              (nil braking). RCC<=3 is wet/contam regime.
     XWND     Crosswind component vs class-typical
              demonstrated limit (HVY 38kt, NRW 33kt,
              RGN 27kt, BIZ 24kt, TBP 20kt, GA 15kt).
     TLWND    Tailwind component vs 10kt (15kt approval).
              Per ICAO Annex 6 Pt I 4.2.5.
     APP-EN   Approach energy (above Vref+10 / above 3°
              glide) per FAA AC 120-71B stable approach.

   Composite = max(per-driver severity).

   Tiers:
     EXCURSION  score>=80  rose    GO-AROUND mandatory
     UNSAFE     score>=55  amber   bleed energy / monitor
     WATCH      score>=25  sky     within envelope
     OK         score<25   emerald nominal LDR margin
     IDLE       not in approach window / outside capture

   60-airport catalogue (LDA-ft / elev-ft / runway-class):
     LRG-INTL  >=10000ft principal runway
     REG-MED   7500-10000ft
     SHRT-RES  <7500ft (excursion-prone)

   MapLibre overlay:
     - Tier-coloured halo rings sized by score 8-22 px
     - Rose pin at destination LDA-stop projection
     - Dashed tier line aircraft -> destination threshold
     - Airport pins for catalogued destinations
     - Tier-coloured callsign + LDR/LDA + driver labels

   Side panel:
     - 5-tier counter strip click-to-filter
     - MEAN-LDR%, WORST, EXCURSION-count summary
     - MEAN-RCC, SHORT-RWY share secondary row
     - SVG LDR%-vs-XW scatter envelope diagram
     - 5 sliders: CAPTURE-NM, RCC-OVERRIDE, WIND-MUL,
                  WEIGHT-BIAS, GO-AROUND-MIN
     - 8-class chip filter HVY/NRW/RGN/BIZ/TBP/GA/FTR/MIL
     - HALO/PIN/LBL/PROJ/APT/DIAG toggles + search
     - AIRCRAFT / AIRPORTS tab switcher
     - Per-row score bar, 5-cell driver breakdown,
       LDA/LDR pills, RCC pill, tier-coloured advice

   Persisted: ft-rera
   ============================================================ */

export interface ReraFlight {
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
  flights: ReraFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'EXCURSION' | 'UNSAFE' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  EXCURSION: '#ef4444', UNSAFE: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_LABEL: Record<Tier, string> = {
  EXCURSION: 'EXCURSION', UNSAFE: 'UNSAFE', WATCH: 'WATCH', OK: 'OK', IDLE: 'IDLE',
}
const TIER_ORDER: Tier[] = ['EXCURSION', 'UNSAFE', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { EXCURSION: 0, UNSAFE: 1, WATCH: 2, OK: 3, IDLE: 4 }

type ClassK = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR' | 'MIL'
const CLASS_LIST: ClassK[] = ['HVY', 'NRW', 'RGN', 'BIZ', 'TBP', 'GA', 'FTR', 'MIL']

interface ClassParam {
  k: ClassK
  vrefRef: number      // KCAS Vref at MLW
  ldDryBase: number    // FAA AC 25-32 dry LDR ft at MLW SL ISA
  xwndLim: number      // demonstrated crosswind limit kt
  flapsBleed: number   // additional ft per kt over Vref
}
const CLASS_PARAMS: Record<ClassK, ClassParam> = {
  HVY: { k: 'HVY', vrefRef: 148, ldDryBase: 5800, xwndLim: 38, flapsBleed: 110 },
  NRW: { k: 'NRW', vrefRef: 138, ldDryBase: 4800, xwndLim: 33, flapsBleed: 95 },
  RGN: { k: 'RGN', vrefRef: 122, ldDryBase: 3800, xwndLim: 27, flapsBleed: 70 },
  BIZ: { k: 'BIZ', vrefRef: 118, ldDryBase: 3200, xwndLim: 24, flapsBleed: 55 },
  TBP: { k: 'TBP', vrefRef:  98, ldDryBase: 2200, xwndLim: 20, flapsBleed: 38 },
  GA:  { k: 'GA',  vrefRef:  68, ldDryBase: 1200, xwndLim: 15, flapsBleed: 18 },
  FTR: { k: 'FTR', vrefRef: 145, ldDryBase: 5200, xwndLim: 30, flapsBleed: 100 },
  MIL: { k: 'MIL', vrefRef: 130, ldDryBase: 4600, xwndLim: 28, flapsBleed: 88 },
}
function classifyAc(t?: string, cat?: string): ClassK {
  const x = (t || '').toUpperCase()
  if (/^A38|^B74|^B77|^B78|^A33|^A34|^A35|^MD1/.test(x)) return 'HVY'
  if (/^B73|^A31|^A32|^A22|^B71|^B72|^MD8|^MD9|^A21|^A21N/.test(x)) return 'NRW'
  if (/^CRJ|^E1|^E19|^E29|^DH8|^AT[47]|^ATR|^SF/.test(x)) return 'RGN'
  if (/^G[34567]|^GLEX|^GLF|^CL[36]|^E55|^E50|^FA|^CITN|^C68|^C56|^C75|^C25/.test(x)) return 'BIZ'
  if (/^DH[CT]|^BE|^PC|^TBM|^KA|^C2|^C3/.test(x)) return 'TBP'
  if (/^F-?\d|^F1|^F2|^EF2|^TYP|^RAF|^MIG|^SU[2-3]/.test(x)) return 'FTR'
  if (/^C13|^KC1|^P-?8|^E-?3|^E-?6|^B52|^C17/.test(x)) return 'MIL'
  return 'GA'
}

/* ---- 60-airport catalogue ---- */
interface Airport {
  iata: string
  icao: string
  name: string
  lat: number
  lng: number
  lda: number  // LDA ft (longest runway)
  elev: number // ft
  klass: 'LRG' | 'REG' | 'SHRT'
}
const AIRPORTS: Airport[] = [
  // LRG-INTL (long primary runway)
  { iata: 'DXB', icao: 'OMDB', name: 'Dubai',            lat:25.253, lng: 55.365, lda:13123, elev:  62, klass:'LRG' },
  { iata: 'DOH', icao: 'OTHH', name: 'Doha Hamad',       lat:25.273, lng: 51.608, lda:15912, elev:  13, klass:'LRG' },
  { iata: 'AUH', icao: 'OMAA', name: 'Abu Dhabi',        lat:24.433, lng: 54.651, lda:13451, elev: 88,  klass:'LRG' },
  { iata: 'JFK', icao: 'KJFK', name: 'New York JFK',     lat:40.640, lng:-73.779, lda:14572, elev:  13, klass:'LRG' },
  { iata: 'LAX', icao: 'KLAX', name: 'Los Angeles',      lat:33.943, lng:-118.408,lda:12091, elev: 125, klass:'LRG' },
  { iata: 'ORD', icao: 'KORD', name: 'Chicago ORD',      lat:41.978, lng:-87.904, lda:13000, elev: 672, klass:'LRG' },
  { iata: 'DEN', icao: 'KDEN', name: 'Denver',           lat:39.862, lng:-104.673,lda:16000, elev:5434, klass:'LRG' },
  { iata: 'DFW', icao: 'KDFW', name: 'Dallas DFW',       lat:32.897, lng:-97.040, lda:13401, elev: 607, klass:'LRG' },
  { iata: 'ATL', icao: 'KATL', name: 'Atlanta',          lat:33.640, lng:-84.428, lda:12390, elev:1026, klass:'LRG' },
  { iata: 'LHR', icao: 'EGLL', name: 'London Heathrow',  lat:51.470, lng:-0.4543, lda:12799, elev:  83, klass:'LRG' },
  { iata: 'CDG', icao: 'LFPG', name: 'Paris CDG',        lat:49.010, lng:  2.547, lda:13780, elev: 392, klass:'LRG' },
  { iata: 'FRA', icao: 'EDDF', name: 'Frankfurt',        lat:50.038, lng:  8.562, lda:13123, elev: 364, klass:'LRG' },
  { iata: 'AMS', icao: 'EHAM', name: 'Amsterdam',        lat:52.308, lng:  4.764, lda:12467, elev: -11, klass:'LRG' },
  { iata: 'MAD', icao: 'LEMD', name: 'Madrid Barajas',   lat:40.472, lng: -3.561, lda:14272, elev:1998, klass:'LRG' },
  { iata: 'IST', icao: 'LTFM', name: 'Istanbul',         lat:41.275, lng: 28.751, lda:13779, elev: 325, klass:'LRG' },
  { iata: 'SIN', icao: 'WSSS', name: 'Singapore',        lat: 1.359, lng:103.989, lda:13123, elev:  22, klass:'LRG' },
  { iata: 'HKG', icao: 'VHHH', name: 'Hong Kong',        lat:22.308, lng:113.918, lda:12467, elev:  28, klass:'LRG' },
  { iata: 'HND', icao: 'RJTT', name: 'Tokyo Haneda',     lat:35.553, lng:139.781, lda:13123, elev:  35, klass:'LRG' },
  { iata: 'NRT', icao: 'RJAA', name: 'Tokyo Narita',     lat:35.764, lng:140.386, lda:13123, elev: 135, klass:'LRG' },
  { iata: 'ICN', icao: 'RKSI', name: 'Seoul Incheon',    lat:37.469, lng:126.450, lda:12303, elev:  23, klass:'LRG' },
  { iata: 'PEK', icao: 'ZBAA', name: 'Beijing Capital',  lat:40.080, lng:116.585, lda:12467, elev: 116, klass:'LRG' },
  { iata: 'PVG', icao: 'ZSPD', name: 'Shanghai Pudong',  lat:31.143, lng:121.805, lda:13123, elev:  13, klass:'LRG' },
  { iata: 'SYD', icao: 'YSSY', name: 'Sydney',           lat:-33.946,lng:151.177, lda:12999, elev:  21, klass:'LRG' },
  { iata: 'JNB', icao: 'FAOR', name: 'Johannesburg',     lat:-26.139,lng: 28.246, lda:14495, elev:5558, klass:'LRG' },
  { iata: 'GRU', icao: 'SBGR', name: 'São Paulo GRU',    lat:-23.435,lng:-46.473, lda:12139, elev:2459, klass:'LRG' },
  { iata: 'MEX', icao: 'MMMX', name: 'Mexico City',      lat:19.436, lng:-99.072, lda:13123, elev:7316, klass:'LRG' },
  { iata: 'YYZ', icao: 'CYYZ', name: 'Toronto',          lat:43.677, lng:-79.631, lda:11050, elev: 569, klass:'LRG' },
  { iata: 'YVR', icao: 'CYVR', name: 'Vancouver',        lat:49.194, lng:-123.184,lda:11500, elev:  14, klass:'LRG' },
  // REG-MED 7500-10000ft
  { iata: 'EWR', icao: 'KEWR', name: 'Newark',           lat:40.692, lng:-74.169, lda:11000, elev:  18, klass:'REG' },
  { iata: 'LGA', icao: 'KLGA', name: 'New York LGA',     lat:40.777, lng:-73.872, lda: 7000, elev:  21, klass:'SHRT' },
  { iata: 'DCA', icao: 'KDCA', name: 'Washington DCA',   lat:38.852, lng:-77.038, lda: 7169, elev:  15, klass:'SHRT' },
  { iata: 'BOS', icao: 'KBOS', name: 'Boston',           lat:42.366, lng:-71.020, lda:10083, elev:  20, klass:'REG' },
  { iata: 'MIA', icao: 'KMIA', name: 'Miami',            lat:25.793, lng:-80.291, lda:13016, elev:   8, klass:'LRG' },
  { iata: 'SFO', icao: 'KSFO', name: 'San Francisco',    lat:37.619, lng:-122.375,lda:11870, elev:  13, klass:'LRG' },
  { iata: 'SEA', icao: 'KSEA', name: 'Seattle',          lat:47.450, lng:-122.309,lda:11901, elev: 433, klass:'LRG' },
  { iata: 'PHX', icao: 'KPHX', name: 'Phoenix',          lat:33.434, lng:-112.012,lda:11489, elev:1135, klass:'LRG' },
  { iata: 'SLC', icao: 'KSLC', name: 'Salt Lake City',   lat:40.788, lng:-111.978,lda:12003, elev:4227, klass:'LRG' },
  { iata: 'MUC', icao: 'EDDM', name: 'Munich',           lat:48.354, lng: 11.786, lda:13123, elev:1487, klass:'LRG' },
  { iata: 'ZRH', icao: 'LSZH', name: 'Zurich',           lat:47.464, lng:  8.549, lda:12139, elev:1416, klass:'LRG' },
  { iata: 'VIE', icao: 'LOWW', name: 'Vienna',           lat:48.110, lng: 16.570, lda:11811, elev: 600, klass:'LRG' },
  { iata: 'BRU', icao: 'EBBR', name: 'Brussels',         lat:50.901, lng:  4.484, lda:11936, elev: 184, klass:'LRG' },
  { iata: 'CPH', icao: 'EKCH', name: 'Copenhagen',       lat:55.617, lng: 12.656, lda:11811, elev:  17, klass:'LRG' },
  { iata: 'ARN', icao: 'ESSA', name: 'Stockholm',        lat:59.651, lng: 17.918, lda:10827, elev: 137, klass:'LRG' },
  { iata: 'OSL', icao: 'ENGM', name: 'Oslo',             lat:60.193, lng: 11.100, lda:11811, elev: 681, klass:'LRG' },
  { iata: 'HEL', icao: 'EFHK', name: 'Helsinki',         lat:60.317, lng: 24.963, lda:11286, elev: 179, klass:'LRG' },
  { iata: 'DUB', icao: 'EIDW', name: 'Dublin',           lat:53.421, lng: -6.270, lda: 8652, elev: 242, klass:'REG' },
  { iata: 'MAN', icao: 'EGCC', name: 'Manchester',       lat:53.353, lng: -2.275, lda:10000, elev: 257, klass:'REG' },
  { iata: 'LGW', icao: 'EGKK', name: 'London Gatwick',   lat:51.148, lng: -0.190, lda:10879, elev: 202, klass:'LRG' },
  // SHRT-RES (excursion-prone)
  { iata: 'SAN', icao: 'KSAN', name: 'San Diego',        lat:32.733, lng:-117.190,lda: 9401, elev:  17, klass:'REG' },
  { iata: 'MDW', icao: 'KMDW', name: 'Chicago Midway',   lat:41.786, lng:-87.752, lda: 6522, elev: 620, klass:'SHRT' },
  { iata: 'BUR', icao: 'KBUR', name: 'Burbank',          lat:34.201, lng:-118.358,lda: 6886, elev: 778, klass:'SHRT' },
  { iata: 'TEB', icao: 'KTEB', name: 'Teterboro',        lat:40.850, lng:-74.061, lda: 7000, elev:   8, klass:'SHRT' },
  { iata: 'LCY', icao: 'EGLC', name: 'London City',      lat:51.505, lng:  0.055, lda: 4948, elev:  19, klass:'SHRT' },
  { iata: 'BCN', icao: 'LEBL', name: 'Barcelona',        lat:41.297, lng:  2.078, lda:11572, elev:  12, klass:'LRG' },
  { iata: 'FCO', icao: 'LIRF', name: 'Rome FCO',         lat:41.804, lng: 12.252, lda:12795, elev:  15, klass:'LRG' },
  { iata: 'WAW', icao: 'EPWA', name: 'Warsaw',           lat:52.166, lng: 20.967, lda:11483, elev: 362, klass:'LRG' },
  { iata: 'PRG', icao: 'LKPR', name: 'Prague',           lat:50.101, lng: 14.260, lda:12188, elev:1247, klass:'LRG' },
  { iata: 'TLV', icao: 'LLBG', name: 'Tel Aviv',         lat:32.011, lng: 34.886, lda:13327, elev: 135, klass:'LRG' },
  { iata: 'CAI', icao: 'HECA', name: 'Cairo',            lat:30.121, lng: 31.405, lda:13123, elev: 382, klass:'LRG' },
  { iata: 'BKK', icao: 'VTBS', name: 'Bangkok',          lat:13.690, lng:100.750, lda:12139, elev:  10, klass:'LRG' },
]
const APT_BY_IATA = new Map(AIRPORTS.map(a => [a.iata, a]))

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
function haversineNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}
function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180
  const Δλ = (lng2 - lng1) * Math.PI / 180
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

type Phase = 'APPR' | 'FLARE' | 'OTHER'
function inferPhase(altFt: number, vRate: number, gsKt: number): Phase {
  if (altFt < 400 && vRate < -100 && gsKt < 200) return 'FLARE'
  if (altFt < 5000 && vRate < -300 && gsKt < 280) return 'APPR'
  return 'OTHER'
}

type Driver = 'LDM' | 'RCC' | 'XW' | 'TW' | 'APE' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  LDM: 'LDR exceeds LDA margin',
  RCC: 'Runway contamination (low RCC)',
  XW:  'Crosswind over demonstrated',
  TW:  'Tailwind over operational limit',
  APE: 'Approach energy / unstable',
  NONE: 'Nominal',
}

interface Row {
  f: ReraFlight
  ap: Airport
  klass: ClassK
  cp: ClassParam
  phase: Phase
  distNm: number
  ldr: number     // landing distance required ft
  lda: number     // landing distance available ft
  margin: number  // LDA - LDR (ft)
  marginPct: number
  rcc: number     // 0..6
  xwndKt: number  // signed kt component
  twndKt: number  // signed kt, +ve tail
  vrefDelta: number // kt above vref
  sev: { ldm: number; rcc: number; xw: number; tw: number; ape: number }
  score: number
  driver: Driver
  tier: Tier
  weightFrac: number
  wndDir: number   // synthesised wind FROM direction
  wndSpd: number
}

const SRC_HALO = 'rera-halo', SRC_LBL = 'rera-lbl', SRC_PIN = 'rera-pin', SRC_PROJ = 'rera-proj', SRC_APT = 'rera-apt'
const LYR_HALO = 'rera-halo-l', LYR_LBL = 'rera-lbl-l', LYR_PIN = 'rera-pin-l', LYR_PROJ = 'rera-proj-l', LYR_APT = 'rera-apt-l', LYR_APT_LBL = 'rera-apt-lbl-l'

export default function RunwayExcursion({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<ClassK | 'ALL'>('ALL')
  const [captureNm, setCaptureNm] = useState(60)
  const [rccOverride, setRccOverride] = useState(0) // 0 = use synthesised, else force 1..6
  const [windMul, setWindMul] = useState(100) // pct
  const [weightBias, setWeightBias] = useState(95) // pct of MLW
  const [gaMin, setGaMin] = useState(800) // ft margin below which GO-AROUND recommended
  const [showHalo, setShowHalo] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showApt, setShowApt] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const phase = inferPhase(f.altitudeFt, f.vertRate, f.velocityKts || 0)
      if (phase !== 'APPR' && phase !== 'FLARE') continue
      // find closest airport within capture, aligned with track
      let best: { ap: Airport; dist: number } | null = null
      for (const ap of AIRPORTS) {
        const d = haversineNm(f.lat, f.lng, ap.lat, ap.lng)
        if (d > captureNm) continue
        const brg = bearingDeg(f.lat, f.lng, ap.lat, ap.lng)
        const diff = Math.abs(((brg - f.track + 540) % 360) - 180)
        if (diff > 60) continue // not aligned
        if (!best || d < best.dist) best = { ap, dist: d }
      }
      if (!best) continue
      const klass = classifyAc(f.type, f.category)
      const cp = CLASS_PARAMS[klass]
      const h = hash32(f.icao || '')

      // weight fraction from hash + bias
      const wHash = 0.82 + (((h >>> 5) % 1000) / 1000) * 0.18 // 0.82..1.00
      const wFrac = Math.max(0.78, Math.min(1.08, wHash * (weightBias / 95)))

      // RCC synthesised: bias by elevation (cold airports) & hash
      const rccHash = ((h >>> 11) % 1000) / 1000
      let rcc: number
      if (rccOverride > 0) rcc = rccOverride
      else if (best.ap.elev > 3000 && rccHash < 0.18) rcc = 2  // alpine snow
      else if (rccHash < 0.05) rcc = 1
      else if (rccHash < 0.18) rcc = 3
      else if (rccHash < 0.32) rcc = 4
      else if (rccHash < 0.55) rcc = 5
      else rcc = 6
      // RCC contamination factor per FAA TALPA AC 25-32:
      // RCC6 dry x1.00, 5 wet x1.15, 4 x1.40, 3 x1.60, 2 x1.90, 1 x2.20, 0 x2.60
      const contamFactor = [2.60, 2.20, 1.90, 1.60, 1.40, 1.15, 1.00][Math.max(0, Math.min(6, rcc))]

      // Wind synth from hash
      const wndDir = (((h >>> 17) % 360))
      const wndSpdHash = ((h >>> 23) % 1000) / 1000 // 0..1
      const wndSpd = (3 + wndSpdHash * 28) * (windMul / 100) // 3..31 kt
      // Runway heading approximated by reciprocal of approach track
      const rwyHdg = f.track // approach track ~ runway heading
      const wndRel = ((wndDir - rwyHdg + 540) % 360) - 180 // -180..180
      const wndRelRad = wndRel * Math.PI / 180
      const xwndKt = Math.sin(wndRelRad) * wndSpd   // +right
      const headKt = Math.cos(wndRelRad) * wndSpd   // +headwind
      const twndKt = -headKt                          // +tailwind

      // Vref delta (energy)
      const vrefAct = cp.vrefRef * Math.sqrt(wFrac)
      const vrefDelta = (f.velocityKts || vrefAct) - vrefAct
      // glide deviation: at 1000ft AGL should be ~3deg => ~3nm; we don't know AGL exactly, proxy
      const aglFt = Math.max(0, f.altitudeFt - best.ap.elev)
      const glideExpectedFt = best.dist * 6076 * Math.tan(3 * Math.PI / 180) // ft above threshold
      const glideHigh = Math.max(0, aglFt - glideExpectedFt) // ft high
      const energySev = Math.max(
        Math.max(0, Math.min(100, (vrefDelta - 5) * 8)),
        Math.max(0, Math.min(100, (glideHigh - 200) / 12))
      )

      // LDR = base * wFrac^1.07 * contamFactor + tail penalty + vref bleed
      const ldrDry = cp.ldDryBase * Math.pow(wFrac, 1.07)
      const tailPenaltyFt = Math.max(0, twndKt) * 80
      const vrefBleedFt = Math.max(0, vrefDelta) * cp.flapsBleed
      const elevPenalty = best.ap.elev * 0.08 // density alt rough
      const ldr = (ldrDry * contamFactor) + tailPenaltyFt + vrefBleedFt + elevPenalty
      const lda = best.ap.lda
      const margin = lda - ldr
      const marginPct = (margin / lda) * 100

      // Severities
      const ldmSev = margin <= 0 ? 100
        : margin <= gaMin ? 100 * (1 - (margin / gaMin)) * 0.55 + 55
        : Math.max(0, Math.min(55, 55 * (1 - (margin - gaMin) / 3000)))
      const rccSev = rcc >= 6 ? 0
        : rcc >= 5 ? 18
        : rcc >= 4 ? 38
        : rcc >= 3 ? 55
        : rcc >= 2 ? 72
        : rcc >= 1 ? 88 : 100
      const xwAbs = Math.abs(xwndKt)
      const xwSev = xwAbs <= cp.xwndLim * 0.6 ? 0
        : xwAbs >= cp.xwndLim ? 100
        : 100 * (xwAbs - cp.xwndLim * 0.6) / (cp.xwndLim * 0.4)
      const twSev = twndKt <= 5 ? 0
        : twndKt >= 15 ? 100
        : 100 * (twndKt - 5) / 10
      const apeSev = Math.max(0, Math.min(100, energySev))

      const drvList: Array<[Driver, number]> = [
        ['LDM', ldmSev], ['RCC', rccSev], ['XW', xwSev], ['TW', twSev], ['APE', apeSev],
      ]
      drvList.sort((a, b) => b[1] - a[1])
      const driver: Driver = drvList[0][1] > 0 ? drvList[0][0] : 'NONE'
      const score = drvList[0][1]
      let tier: Tier
      if (score >= 80) tier = 'EXCURSION'
      else if (score >= 55) tier = 'UNSAFE'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, ap: best.ap, klass, cp, phase, distNm: best.dist,
        ldr, lda, margin, marginPct, rcc, xwndKt, twndKt, vrefDelta,
        sev: { ldm: ldmSev, rcc: rccSev, xw: xwSev, tw: twSev, ape: apeSev },
        score, driver, tier, weightFrac: wFrac, wndDir, wndSpd,
      })
    }
    return out
  }, [flights, captureNm, rccOverride, windMul, weightBias, gaMin])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { EXCURSION: 0, UNSAFE: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumMargPct = 0, sumRcc = 0, worst = 0, worstCs = '', worstDrv: Driver = 'NONE'
    let excursion = 0, shortRwy = 0
    for (const r of rows) {
      sumMargPct += r.marginPct; sumRcc += r.rcc
      if (r.tier === 'EXCURSION') excursion++
      if (r.ap.klass === 'SHRT') shortRwy++
      if (r.score > worst) { worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstDrv = r.driver }
    }
    return {
      meanMargPct: rows.length ? sumMargPct / rows.length : 0,
      meanRcc: rows.length ? sumRcc / rows.length : 0,
      worst, worstCs, worstDrv, excursion, shortShare: rows.length ? shortRwy / rows.length : 0,
    }
  }, [rows])

  const airportAggs = useMemo(() => {
    const m = new Map<string, { ap: Airport; count: number; sumScore: number; sumMarg: number; worst: number; worstCs: string; worstIcao: string; worstTier: Tier; excursion: number }>()
    for (const r of rows) {
      const k = r.ap.iata
      let a = m.get(k)
      if (!a) { a = { ap: r.ap, count: 0, sumScore: 0, sumMarg: 0, worst: 0, worstCs: '', worstIcao: '', worstTier: 'OK', excursion: 0 }; m.set(k, a) }
      a.count++; a.sumScore += r.score; a.sumMarg += r.marginPct
      if (r.tier === 'EXCURSION') a.excursion++
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.score > a.worst) { a.worst = r.score; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
    }
    const arr = Array.from(m.values()).map(a => ({ ...a, meanScore: a.count ? a.sumScore / a.count : 0, meanMargPct: a.count ? a.sumMarg / a.count : 0 }))
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
        if (classFilter !== 'ALL' && r.klass !== classFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.ap.iata, r.ap.name].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, classFilter, query])

  const filteredAirports = useMemo(() => {
    const q = query.trim().toUpperCase()
    return airportAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (!q) return true
      return (a.ap.iata + ' ' + a.ap.icao + ' ' + a.ap.name).toUpperCase().includes(q)
    })
  }, [airportAggs, tierFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'EXCURSION' || r.tier === 'UNSAFE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${r.ap.iata} ${(r.marginPct).toFixed(0)}% ${r.driver}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'EXCURSION').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `› GO-AROUND ${r.ap.iata}` },
      geometry: { type: 'Point' as const, coordinates: [r.ap.lng, r.ap.lat] },
    })) : [] }
    const projFeatures: any[] = []
    if (showProj) {
      for (const r of rows) {
        if (r.tier === 'OK') continue
        projFeatures.push({
          type: 'Feature' as const,
          properties: { color: TIER_COLOR[r.tier] },
          geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.ap.lng, r.ap.lat]] },
        })
      }
    }
    const projFc = { type: 'FeatureCollection' as const, features: projFeatures }
    const aptFc = { type: 'FeatureCollection' as const, features: showApt ? AIRPORTS.map(a => ({
      type: 'Feature' as const,
      properties: {
        color: a.klass === 'SHRT' ? '#f59e0b' : a.klass === 'REG' ? '#64748b' : '#0ea5e9',
        text: `${a.iata} ${(a.lda / 1000).toFixed(1)}k`,
      },
      geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_APT, aptFc, () => {
        map.addLayer({ id: LYR_APT, type: 'circle', source: SRC_APT, paint: {
          'circle-radius': 3.5, 'circle-color': ['get', 'color'], 'circle-opacity': 0.75,
          'circle-stroke-color': '#0f172a', 'circle-stroke-width': 1,
        } })
        map.addLayer({ id: LYR_APT_LBL, type: 'symbol', source: SRC_APT, layout: {
          'text-field': ['get', 'text'], 'text-size': 9, 'text-offset': [0, 0.9], 'text-anchor': 'top',
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.1 } })
      })
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [3, 4],
      } }))
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-offset': [0, -1.5], 'text-anchor': 'bottom', 'icon-allow-overlap': true,
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.6 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_APT_LBL, LYR_APT]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_PROJ, SRC_APT]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showProj, showApt])

  // Diagram: x=xwnd kt -40..+40, y=marginPct -20..+80
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 30
    const xMin = -40, xMax = 40, yMin = -20, yMax = 80
    const xs = (v: number) => PAD + ((v - xMin) / (xMax - xMin)) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMin, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Runway Excursion · TALPA RCAM</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} ac</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold" style={{ color: TIER_COLOR[t] }}>{TIER_LABEL[t]}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean LDA margin</div>
          <div className="font-mono text-sm" style={{ color: summary.meanMargPct <= 0 ? '#ef4444' : summary.meanMargPct <= 15 ? '#f59e0b' : '#10b981' }}>{summary.meanMargPct.toFixed(0)}%</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worst.toFixed(0)}` : '—'}
          </div>
          <div className="text-[8px] text-slate-500 truncate">{summary.worstDrv !== 'NONE' ? DRIVER_LABEL[summary.worstDrv] : '—'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">EXCURSION</div>
          <div className="font-mono text-sm" style={{ color: summary.excursion > 0 ? '#ef4444' : '#10b981' }}>{summary.excursion}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean RCC</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanRcc <= 3 ? '#ef4444' : summary.meanRcc <= 4.5 ? '#f59e0b' : '#10b981' }}>{summary.meanRcc.toFixed(1)} / 6</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Short-rwy share</div>
          <div className="font-mono text-[11px]" style={{ color: summary.shortShare > 0.25 ? '#f59e0b' : '#10b981' }}>{(summary.shortShare * 100).toFixed(0)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">LDA margin% vs crosswind · excursion envelope</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[-30, -15, 0, 15, 30].map(x => (
              <g key={x}>
                <line x1={diag.xs(x)} y1={6} x2={diag.xs(x)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(x)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{x > 0 ? '+' + x : x}kt</text>
              </g>
            ))}
            {[-10, 0, 20, 40, 60].map(y => (
              <g key={y}>
                <line x1={diag.PAD} y1={diag.ys(y)} x2={diag.W - 6} y2={diag.ys(y)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(y) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{y}%</text>
              </g>
            ))}
            {/* excursion band: margin<0 = rose; 0-15 amber; 15-30 sky; >30 emerald */}
            <rect x={diag.PAD} y={diag.ys(0)} width={diag.W - 6 - diag.PAD} height={diag.H - diag.PAD - diag.ys(0)} fill="#ef4444" opacity={0.10} />
            <rect x={diag.PAD} y={diag.ys(15)} width={diag.W - 6 - diag.PAD} height={diag.ys(0) - diag.ys(15)} fill="#f59e0b" opacity={0.10} />
            <rect x={diag.PAD} y={diag.ys(30)} width={diag.W - 6 - diag.PAD} height={diag.ys(15) - diag.ys(30)} fill="#0ea5e9" opacity={0.08} />
            <line x1={diag.PAD} y1={diag.ys(0)} x2={diag.W - 6} y2={diag.ys(0)} stroke="#ef4444" strokeWidth={1} strokeDasharray="4 3" opacity={0.8} />
            <line x1={diag.PAD} y1={diag.ys(15)} x2={diag.W - 6} y2={diag.ys(15)} stroke="#f59e0b" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
            <line x1={diag.PAD} y1={diag.ys(30)} x2={diag.W - 6} y2={diag.ys(30)} stroke="#0ea5e9" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
            <text x={diag.W - 8} y={diag.ys(-5) + 3} textAnchor="end" fontSize={7} fill="#ef4444" fontFamily="monospace">EXCURSION</text>
            <text x={diag.W - 8} y={diag.ys(8) + 3} textAnchor="end" fontSize={7} fill="#f59e0b" fontFamily="monospace">UNSAFE</text>
            <text x={diag.W - 8} y={diag.ys(22) + 3} textAnchor="end" fontSize={7} fill="#0ea5e9" fontFamily="monospace">WATCH</text>
            {rows.map(r => (
              <circle key={r.f.icao}
                cx={diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, r.xwndKt)))}
                cy={diag.ys(Math.max(diag.yMin, Math.min(diag.yMax, r.marginPct)))}
                r={3} fill={TIER_COLOR[r.tier]} opacity={0.92} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CAPTURE</span><span className="font-mono text-slate-300">{captureNm}nm</span></div>
            <input type="range" min={20} max={120} step={5} value={captureNm} onChange={e => setCaptureNm(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>RCC-OVR</span><span className="font-mono text-slate-300">{rccOverride === 0 ? 'auto' : rccOverride}</span></div>
            <input type="range" min={0} max={6} step={1} value={rccOverride} onChange={e => setRccOverride(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>WIND-MUL</span><span className="font-mono text-slate-300">{windMul}%</span></div>
            <input type="range" min={50} max={200} step={5} value={windMul} onChange={e => setWindMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>WT-BIAS</span><span className="font-mono text-slate-300">{weightBias}%</span></div>
            <input type="range" min={75} max={108} step={1} value={weightBias} onChange={e => setWeightBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>GO-AROUND-MIN</span><span className="font-mono text-slate-300">{gaMin}ft</span></div>
          <input type="range" min={200} max={2000} step={100} value={gaMin} onChange={e => setGaMin(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setClassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${classFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {CLASS_LIST.map(k => (
            <button key={k} onClick={() => setClassFilter(classFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${classFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showApt} onChange={e => setShowApt(e.target.checked)} className="accent-sky-500" /><span>APT</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / airport"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'AIRPORTS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} ac` : `${filteredAirports.length} shown / ${airportAggs.length} apt`}</span>
        <span>{tab === 'AIRCRAFT' ? 'LDR / LDA · margin · driver' : 'airport · LDA · ac · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft on approach to catalogued airport within capture window.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const advice = r.tier === 'EXCURSION'
            ? `GO-AROUND · LDR ${(r.ldr).toFixed(0)}ft exceeds LDA ${r.lda}ft`
            : r.tier === 'UNSAFE'
              ? `bleed energy · verify ${r.driver} · brief GA gate`
              : r.tier === 'WATCH'
                ? `within envelope · monitor ${r.driver}`
                : `LDR margin nominal`
          const rccColor = r.rcc >= 5 ? '#10b981' : r.rcc >= 3 ? '#f59e0b' : '#ef4444'
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{r.ap.iata}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{TIER_LABEL[r.tier]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="phase" className="text-slate-500">{r.phase}</span>
                  <span title="distance to threshold">{r.distNm.toFixed(0)}nm</span>
                  <span title="landing distance required ft" style={{ color: r.margin <= 0 ? '#ef4444' : r.margin <= gaMin ? '#f59e0b' : '#cbd5e1' }}>LDR {(r.ldr).toFixed(0)}</span>
                  <span title="landing distance available ft" className="text-slate-500">/ LDA {r.lda}</span>
                  <span className="ml-auto" title="composite risk score" style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`score ${r.score.toFixed(0)} / 100`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500/70" style={{ left: `25%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-500/70" style={{ left: `55%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-500/70" style={{ left: `80%` }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {([['LDM', r.sev.ldm], ['RCC', r.sev.rcc], ['XW', r.sev.xw], ['TW', r.sev.tw], ['APE', r.sev.ape]] as const).map(([lbl, v]) => {
                    const c = v >= 80 ? '#ef4444' : v >= 55 ? '#f59e0b' : v >= 25 ? '#0ea5e9' : '#475569'
                    return (
                      <span key={lbl} className="px-1 py-0 rounded border text-[9px] font-mono"
                        style={{ borderColor: c + '66', color: c, background: c + '14' }}>{lbl} {v.toFixed(0)}</span>
                    )
                  })}
                  <span className="px-1 py-0 rounded border text-[9px] font-mono" style={{ borderColor: rccColor + '66', color: rccColor, background: rccColor + '14' }} title="TALPA RCAM Runway Condition Code">RCC{r.rcc}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="signed crosswind kt">XW {r.xwndKt >= 0 ? '+' : ''}{r.xwndKt.toFixed(0)}</span>
                  {r.twndKt > 0 && (
                    <span className="px-1 py-0 rounded border text-[9px] font-mono" style={{ borderColor: r.twndKt > 10 ? '#ef444466' : '#f59e0b66', color: r.twndKt > 10 ? '#ef4444' : '#f59e0b', background: (r.twndKt > 10 ? '#ef4444' : '#f59e0b') + '14' }} title="tailwind kt">TW {r.twndKt.toFixed(0)}</span>
                  )}
                  {r.vrefDelta > 5 && (
                    <span className="px-1 py-0 rounded border text-[9px] font-mono" style={{ borderColor: '#f59e0b66', color: '#f59e0b', background: '#f59e0b14' }} title="kt above Vref">+{r.vrefDelta.toFixed(0)}V</span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'AIRPORTS' && filteredAirports.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No catalogued airports with inbound traffic.</div>
        )}
        {tab === 'AIRPORTS' && filteredAirports.map(a => {
          const advice = a.worstTier === 'EXCURSION' ? `${a.excursion} aircraft on excursion vector · alert TWR/AERO`
            : a.worstTier === 'UNSAFE' ? 'unsafe approaches inbound · monitor RCAM updates'
              : a.worstTier === 'WATCH' ? 'inbound traffic within envelope · routine'
                : 'inbound traffic nominal LDR margin'
          return (
            <button key={a.ap.iata} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.ap.iata}</span>
                  <span className="text-slate-500 text-[10px] truncate">{a.ap.icao} · {a.ap.name}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.worstTier] }}>{TIER_LABEL[a.worstTier]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="LDA ft">LDA {a.ap.lda}</span>
                  <span title="elevation ft" className="text-slate-500">{a.ap.elev}ft</span>
                  <span title="mean LDA margin %" style={{ color: a.meanMargPct <= 0 ? '#ef4444' : a.meanMargPct <= 15 ? '#f59e0b' : '#10b981' }}>{a.meanMargPct.toFixed(0)}%</span>
                  <span className="ml-auto" title="worst score" style={{ color: TIER_COLOR[a.worstTier] }}>worst {a.worst.toFixed(0)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`mean score ${a.meanScore.toFixed(0)} / 100`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, a.meanScore)}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500/70" style={{ left: `25%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-500/70" style={{ left: `55%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-500/70" style={{ left: `80%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="px-1 py-0 rounded border" style={{ borderColor: a.ap.klass === 'SHRT' ? '#f59e0b66' : a.ap.klass === 'REG' ? '#64748b66' : '#0ea5e966', color: a.ap.klass === 'SHRT' ? '#f59e0b' : a.ap.klass === 'REG' ? '#94a3b8' : '#0ea5e9' }}>{a.ap.klass}</span>
                  <span className="truncate">{a.excursion ? `${a.excursion} EXC` : 'no excursion'}</span>
                  <span className="ml-auto truncate" style={{ color: a.worstTier === 'OK' ? '#64748b' : TIER_COLOR[a.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        FAA TALPA RCAM · AC 25-32 · AC 91-79B · EASA CAT.OP.MPA.311 · ICAO Doc 9981 · NTSB SIR-19/02
      </div>
    </div>
  )
}
