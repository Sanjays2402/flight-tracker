'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Runway Excursion / Hydroplaning Risk Monitor (REX-HYD)
   -----------------------------------------------------------
   ICAO Doc 9981 PANS-Aerodromes / ICAO Annex 14 Vol I Att A /
   FAA AC 91-79B Mitigating Runway Overrun / TALPA ARC RCAM
   matrix / EASA SIB 2018-13 Wet/Contaminated runway operations /
   NASA TN D-2056 Horne dynamic-hydroplaning velocity Vp = 9 * √P
   for any arriving aircraft within capture range of the
   nearest IATA destination airport in front of its track.

   Synthesises per-arrival landing performance:
     - Estimated landing weight from class MLW minus 4 %·hr proxy
       (long-haul descend at low weight, short-haul near MLW)
     - VREF kt = class-VrefRef * √(weight/MLW) (rule-of-thumb)
     - Ground-speed at threshold = VREF + 0.5·tailwindKt + halfRwyWind
     - Tire-pressure P (psi) per class, deterministic FNV-1a 32-bit
       hash of ICAO24 picks ±10 % within band
     - Dynamic hydroplaning Vp = 9*√P kt (Horne 1965 / NASA TN
       D-2056) — speeds above Vp on a flooded runway lose all
       wheel braking
     - Reverted-rubber Vp ≈ 0.7 * Vp_dynamic in case of locked
       wheel skid (NASA TR R-365)
     - Friction μ from TALPA RCAM 6→0 code (CODE-6 dry / 5 wet /
       4 slush ≤3mm / 3 standing-water / 2 flooded / 1 ice / 0
       glare-ice) scaled by RCAM slider 0–6
     - Crosswind component from METAR-proxy wind 10–25 kt
       deflected by runway heading hash (proxy 0–360)
     - Required landing distance LDR = (VrefKt²/μ/g) ft scaled
       by SAFETY 1.15 std + 0.15 wet uplift per FAA AC 91-79B
     - LDA (landing distance available) per airport class
       (LARGE 11000 ft / MED 8000 / REGIONAL 6000 / SMALL 4000)

   Risk components (max-driver compositing 0-100):
     HYDRO     GS at threshold vs Vp (severity = (GS-Vp+5)/Vp*150)
     LDR-MARG  LDR vs LDA gap (severity = (LDR-LDA)/LDA*100+50
               when LDR > LDA*0.85)
     RCAM-FRIC RCAM code 3 or worse + wet GS = sev scaled
     XWIND     Crosswind vs class limit (HVY 38 / NRW 33 / RGN
               25 / BIZ 28 / TBP 22 / GA 17 / FTR 30 kt) ramp
     TAILWIND  Tailwind > 10 kt FAA AC 91-79B severity ramp

   Composite score = max(per-factor severity).

   Tier classification:
     ABORT  score>=80  rose   go-around / divert recommended
     HIGH   score>=55  amber  reconfigure flap / longer runway
     WATCH  score>=25  sky    monitor brake action reports
     OK     score<25   emerald nominal landing
     IDLE   no-dest    slate  no inferrable destination

   MapLibre overlay:
     - Tier-coloured halo rings sized by score 8-22 px
     - Dashed tier-coloured projection line aircraft to destination
     - Diamond marker at destination IATA for ABORT/HIGH
     - Tier-coloured callsign+IATA+score labels for non-OK

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-SCORE / WORST callsign / ABORT count
     - 2-cell MEAN-Vp / MEAN-MARGIN secondary row
     - SVG GS-vs-Vp scatter with tier bands
     - 5 sliders RCAM 0-6 / SAFETY 1.0-1.6 / WIND 0-40 / TAIL-BIAS
       -15..+15 / CAPTURE 60-600 nm
     - 7-class chip filter + HALO/PROJ/PIN/LBL/DIAG toggles
     - AIRCRAFT / AIRPORTS tab switcher

   Registered in Layers > Routes & Flow. Persisted: ft-rexhyd
   ============================================================ */

export interface RexFlight {
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
  flights: RexFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'WATCH' | 'HIGH' | 'ABORT' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981', WATCH: '#0ea5e9', HIGH: '#f59e0b', ABORT: '#ef4444', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['ABORT', 'HIGH', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { ABORT: 0, HIGH: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Driver = 'HYDRO' | 'LDR' | 'RCAM' | 'XWIND' | 'TAIL' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  HYDRO: 'Dynamic hydroplaning',
  LDR: 'Landing distance margin',
  RCAM: 'Runway friction code',
  XWIND: 'Crosswind component',
  TAIL: 'Tailwind component',
  NONE: 'Nominal',
}

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}
const TIRE_PSI: Record<Klass, number> = { heavy: 210, narrow: 195, regional: 145, biz: 165, turboprop: 110, ga: 55, fighter: 250 }
const VREF_KT: Record<Klass, number> = { heavy: 145, narrow: 138, regional: 120, biz: 125, turboprop: 100, ga: 65, fighter: 135 }
const XWIND_LIM: Record<Klass, number> = { heavy: 38, narrow: 33, regional: 25, biz: 28, turboprop: 22, ga: 17, fighter: 30 }

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'ga'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CRJ9|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS)/.test(x)) return 'fighter'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'turboprop'
  return 'narrow'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

interface Aero {
  icao: string; iata: string; name: string; lat: number; lng: number
  size: 'L' | 'M' | 'R' | 'S'
}
const LDA_FT: Record<Aero['size'], number> = { L: 11000, M: 8000, R: 6000, S: 4000 }
const SIZE_LABEL: Record<Aero['size'], string> = { L: 'LARGE', M: 'MED', R: 'REGIONAL', S: 'SMALL' }

// Curated 60 airports — mix of sizes, global
const AERO: Aero[] = [
  { icao:'KATL', iata:'ATL', name:'Atlanta', lat:33.64, lng:-84.43, size:'L' },
  { icao:'KORD', iata:'ORD', name:'Chicago O\u2019Hare', lat:41.98, lng:-87.91, size:'L' },
  { icao:'KDFW', iata:'DFW', name:'Dallas/Ft Worth', lat:32.90, lng:-97.04, size:'L' },
  { icao:'KLAX', iata:'LAX', name:'Los Angeles', lat:33.94, lng:-118.41, size:'L' },
  { icao:'KJFK', iata:'JFK', name:'New York JFK', lat:40.64, lng:-73.78, size:'L' },
  { icao:'KLGA', iata:'LGA', name:'New York LGA', lat:40.78, lng:-73.87, size:'R' },
  { icao:'KSFO', iata:'SFO', name:'San Francisco', lat:37.62, lng:-122.38, size:'L' },
  { icao:'KSEA', iata:'SEA', name:'Seattle', lat:47.45, lng:-122.31, size:'L' },
  { icao:'KMIA', iata:'MIA', name:'Miami', lat:25.79, lng:-80.29, size:'L' },
  { icao:'KBOS', iata:'BOS', name:'Boston', lat:42.36, lng:-71.01, size:'M' },
  { icao:'KDEN', iata:'DEN', name:'Denver', lat:39.86, lng:-104.67, size:'L' },
  { icao:'KIAD', iata:'IAD', name:'Washington Dulles', lat:38.94, lng:-77.46, size:'L' },
  { icao:'KSAN', iata:'SAN', name:'San Diego', lat:32.73, lng:-117.19, size:'R' },
  { icao:'KMDW', iata:'MDW', name:'Chicago Midway', lat:41.79, lng:-87.75, size:'R' },
  { icao:'KASE', iata:'ASE', name:'Aspen', lat:39.22, lng:-106.87, size:'S' },
  { icao:'KTEB', iata:'TEB', name:'Teterboro', lat:40.85, lng:-74.06, size:'R' },
  { icao:'CYYZ', iata:'YYZ', name:'Toronto', lat:43.68, lng:-79.63, size:'L' },
  { icao:'CYVR', iata:'YVR', name:'Vancouver', lat:49.19, lng:-123.18, size:'L' },
  { icao:'CYUL', iata:'YUL', name:'Montreal', lat:45.47, lng:-73.74, size:'M' },
  { icao:'MMMX', iata:'MEX', name:'Mexico City', lat:19.44, lng:-99.07, size:'L' },
  { icao:'SBGR', iata:'GRU', name:'Sao Paulo', lat:-23.43, lng:-46.47, size:'L' },
  { icao:'SAEZ', iata:'EZE', name:'Buenos Aires', lat:-34.82, lng:-58.54, size:'L' },
  { icao:'SKBO', iata:'BOG', name:'Bogota', lat:4.70, lng:-74.14, size:'M' },
  { icao:'SPJC', iata:'LIM', name:'Lima', lat:-12.02, lng:-77.11, size:'M' },
  { icao:'EGLL', iata:'LHR', name:'London Heathrow', lat:51.47, lng:-0.46, size:'L' },
  { icao:'EGKK', iata:'LGW', name:'London Gatwick', lat:51.15, lng:-0.19, size:'M' },
  { icao:'EGCC', iata:'MAN', name:'Manchester', lat:53.35, lng:-2.27, size:'M' },
  { icao:'EGPH', iata:'EDI', name:'Edinburgh', lat:55.95, lng:-3.37, size:'M' },
  { icao:'LFPG', iata:'CDG', name:'Paris CDG', lat:49.01, lng:2.55, size:'L' },
  { icao:'LFPO', iata:'ORY', name:'Paris Orly', lat:48.72, lng:2.36, size:'M' },
  { icao:'EDDF', iata:'FRA', name:'Frankfurt', lat:50.03, lng:8.56, size:'L' },
  { icao:'EDDM', iata:'MUC', name:'Munich', lat:48.35, lng:11.78, size:'L' },
  { icao:'EHAM', iata:'AMS', name:'Amsterdam', lat:52.31, lng:4.76, size:'L' },
  { icao:'LSZH', iata:'ZRH', name:'Zurich', lat:47.46, lng:8.55, size:'M' },
  { icao:'LEMD', iata:'MAD', name:'Madrid', lat:40.49, lng:-3.57, size:'L' },
  { icao:'LEBL', iata:'BCN', name:'Barcelona', lat:41.30, lng:2.08, size:'L' },
  { icao:'LIRF', iata:'FCO', name:'Rome FCO', lat:41.80, lng:12.25, size:'L' },
  { icao:'LTFM', iata:'IST', name:'Istanbul', lat:41.26, lng:28.74, size:'L' },
  { icao:'BIKF', iata:'KEF', name:'Keflavik', lat:63.99, lng:-22.61, size:'M' },
  { icao:'ENGM', iata:'OSL', name:'Oslo', lat:60.19, lng:11.10, size:'M' },
  { icao:'ESSA', iata:'ARN', name:'Stockholm', lat:59.65, lng:17.94, size:'M' },
  { icao:'EFHK', iata:'HEL', name:'Helsinki', lat:60.32, lng:24.96, size:'M' },
  { icao:'UUEE', iata:'SVO', name:'Moscow SVO', lat:55.97, lng:37.41, size:'L' },
  { icao:'OMDB', iata:'DXB', name:'Dubai', lat:25.25, lng:55.36, size:'L' },
  { icao:'OTHH', iata:'DOH', name:'Doha', lat:25.27, lng:51.61, size:'L' },
  { icao:'OEJN', iata:'JED', name:'Jeddah', lat:21.68, lng:39.15, size:'L' },
  { icao:'HAAB', iata:'ADD', name:'Addis Ababa', lat:8.98, lng:38.80, size:'M' },
  { icao:'FAOR', iata:'JNB', name:'Johannesburg', lat:-26.13, lng:28.24, size:'L' },
  { icao:'HKJK', iata:'NBO', name:'Nairobi', lat:-1.32, lng:36.93, size:'M' },
  { icao:'VIDP', iata:'DEL', name:'Delhi', lat:28.55, lng:77.10, size:'L' },
  { icao:'VABB', iata:'BOM', name:'Mumbai', lat:19.09, lng:72.87, size:'L' },
  { icao:'VHHH', iata:'HKG', name:'Hong Kong', lat:22.31, lng:113.92, size:'L' },
  { icao:'ZSPD', iata:'PVG', name:'Shanghai PVG', lat:31.14, lng:121.81, size:'L' },
  { icao:'ZBAA', iata:'PEK', name:'Beijing', lat:40.08, lng:116.59, size:'L' },
  { icao:'RJAA', iata:'NRT', name:'Tokyo Narita', lat:35.77, lng:140.39, size:'L' },
  { icao:'RJTT', iata:'HND', name:'Tokyo Haneda', lat:35.55, lng:139.78, size:'L' },
  { icao:'RKSI', iata:'ICN', name:'Seoul Incheon', lat:37.46, lng:126.44, size:'L' },
  { icao:'WSSS', iata:'SIN', name:'Singapore', lat:1.36, lng:103.99, size:'L' },
  { icao:'VTBS', iata:'BKK', name:'Bangkok', lat:13.69, lng:100.75, size:'L' },
  { icao:'YSSY', iata:'SYD', name:'Sydney', lat:-33.94, lng:151.18, size:'L' },
  { icao:'YMML', iata:'MEL', name:'Melbourne', lat:-37.67, lng:144.84, size:'L' },
  { icao:'NZAA', iata:'AKL', name:'Auckland', lat:-37.01, lng:174.79, size:'M' },
  { icao:'PANC', iata:'ANC', name:'Anchorage', lat:61.17, lng:-149.99, size:'L' },
  { icao:'PHNL', iata:'HNL', name:'Honolulu', lat:21.32, lng:-157.92, size:'M' },
]

function greatCircleNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 3440.065
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dφ = (la2 - la1) * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dλ = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

// nearest airport ahead of track within ±60° and within capture nm
function inferDest(f: RexFlight, capture: number): { a: Aero; distNm: number; brg: number } | null {
  let best: Aero | null = null; let bestD = Infinity; let bestB = 0
  for (const a of AERO) {
    const d = greatCircleNm(f.lat, f.lng, a.lat, a.lng)
    if (d > capture) continue
    const b = bearingDeg(f.lat, f.lng, a.lat, a.lng)
    let diff = Math.abs(((b - f.track + 540) % 360) - 180)
    if (diff > 60) continue
    if (d < bestD) { bestD = d; best = a; bestB = b }
  }
  return best ? { a: best, distNm: bestD, brg: bestB } : null
}

interface Row {
  f: RexFlight
  klass: Klass
  flCur: number
  dest: Aero
  distNm: number
  // landing perf
  vrefKt: number
  gsThrKt: number
  tirePsi: number
  vpKt: number
  vpRevKt: number
  rcam: number
  mu: number
  windKt: number
  windDir: number
  rwyHdg: number
  xwindKt: number
  tailKt: number
  ldaFt: number
  ldrFt: number
  // factor severities
  hydroSev: number
  ldrSev: number
  rcamSev: number
  xwindSev: number
  tailSev: number
  // composite
  score: number
  tier: Tier
  driver: Driver
}

const SRC_HALO = 'rex-halo', SRC_LBL = 'rex-lbl', SRC_PIN = 'rex-pin', SRC_LINE = 'rex-line'
const LYR_HALO = 'rex-halo-l', LYR_LBL = 'rex-lbl-l', LYR_PIN = 'rex-pin-l', LYR_LINE = 'rex-line-l'

export default function RexHyd({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [rcamOverride, setRcamOverride] = useState(3) // 6=dry 5=wet 4=slush 3=standing 2=flooded 1=ice 0=glare
  const [safety, setSafety] = useState(115)            // 1.00x..1.60x
  const [windKtBase, setWindKtBase] = useState(14)
  const [tailBias, setTailBias] = useState(0)          // -15..+15 kt
  const [captureNm, setCaptureNm] = useState(220)
  const [showHalo, setShowHalo] = useState(true)
  const [showLine, setShowLine] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const flCur = (f.altitudeFt || 0) / 100
      // Only descending arrivals — VS < -100 fpm or below FL250
      if (f.vertRate > -100 && flCur > 250) continue
      const dest = inferDest(f, captureNm)
      if (!dest) {
        out.push({
          f, klass: classify(f.type, f.category), flCur,
          dest: { icao:'', iata:'\u2014', name:'No destination', lat:0, lng:0, size:'M' },
          distNm: 0, vrefKt: 0, gsThrKt: 0, tirePsi: 0, vpKt: 0, vpRevKt: 0,
          rcam: rcamOverride, mu: 0, windKt: 0, windDir: 0, rwyHdg: 0, xwindKt: 0, tailKt: 0,
          ldaFt: 0, ldrFt: 0,
          hydroSev: 0, ldrSev: 0, rcamSev: 0, xwindSev: 0, tailSev: 0,
          score: 0, tier: 'IDLE', driver: 'NONE',
        })
        continue
      }
      const klass = classify(f.type, f.category)
      const h = hash32(f.icao)
      const r1 = (h & 0xffff) / 0xffff
      const r2 = ((h >>> 16) & 0xffff) / 0xffff
      const r3 = (((h * 2654435761) >>> 0) & 0xffff) / 0xffff
      const r4 = (((h * 40503) >>> 0) & 0xffff) / 0xffff

      // Landing weight bias from time-since-takeoff proxy via distNm to dest
      // heavies arriving from long-haul = lighter; short-haul narrowbody = near MLW
      const weightFrac = klass === 'heavy'
        ? Math.max(0.78, Math.min(0.98, 0.98 - dest.distNm / 6500))
        : Math.max(0.85, Math.min(1.02, 1.02 - dest.distNm / 1800))
      const vrefKt = VREF_KT[klass] * Math.sqrt(weightFrac)

      // Tire pressure ±10 % per airframe
      const tirePsi = TIRE_PSI[klass] * (0.9 + 0.2 * r1)
      // NASA TN D-2056 Horne dynamic hydroplaning: Vp = 9 * √P (kt, P in psi)
      const vpKt = 9 * Math.sqrt(tirePsi)
      const vpRevKt = vpKt * 0.7

      // Wind synthesized per airport (deterministic by hash + slider)
      const windKt = Math.max(0, windKtBase + (r2 - 0.5) * 10)
      const windDir = (h % 360)
      const rwyHdg = ((h >>> 8) % 36) * 10
      const wDelta = (windDir - rwyHdg + 540) % 360 - 180  // -180..180
      const xwindKt = Math.abs(Math.sin(wDelta * Math.PI / 180)) * windKt
      const tailKt = -Math.cos(wDelta * Math.PI / 180) * windKt + tailBias

      // Ground-speed at threshold ≈ VREF + 0.5*tail (gust + wind contribution)
      const gsThrKt = vrefKt + Math.max(-10, 0.5 * tailKt)

      // RCAM friction map: 6 dry, 5 wet, 4 slush, 3 standing, 2 flooded, 1 ice, 0 glare
      const rcam = rcamOverride
      const muMap = [0.05, 0.10, 0.20, 0.28, 0.33, 0.38, 0.45]
      const mu = muMap[Math.max(0, Math.min(6, rcam))]

      // Required Landing Distance LDR ≈ 0.354 * Vref²(kt) / mu (FAA AC 25-7C unfactored)
      const ldrUnf = 0.354 * vrefKt * vrefKt / Math.max(0.05, mu)
      const ldrFt = ldrUnf * (safety / 100) * (rcam <= 4 ? 1.15 : 1.0)
      const ldaFt = LDA_FT[dest.a.size] * (0.92 + 0.16 * r3)

      // ---- Severity components ----
      // HYDRO: GS over Vp on contaminated surface
      const wetFactor = rcam <= 3 ? 1.0 : rcam === 4 ? 0.6 : rcam === 5 ? 0.35 : 0.0
      const hydroSev = Math.min(100, Math.max(0, ((gsThrKt - vpKt + 5) / vpKt) * 150) * wetFactor + (rcam <= 3 && gsThrKt > vpRevKt ? 12 : 0))

      // LDR-MARG: margin gap
      const marginPct = (ldaFt - ldrFt) / Math.max(1000, ldaFt)
      const ldrSev = marginPct >= 0.15 ? 0 :
        marginPct >= 0 ? (0.15 - marginPct) / 0.15 * 50 :
        50 + Math.min(50, Math.abs(marginPct) * 220)

      // RCAM-FRIC: code 3 or worse base sev
      const rcamSev = rcam >= 5 ? 0 : rcam === 4 ? 18 : rcam === 3 ? 42 : rcam === 2 ? 65 : rcam === 1 ? 85 : 100

      // XWIND: vs class limit
      const xLim = XWIND_LIM[klass] * (rcam <= 3 ? 0.7 : rcam === 4 ? 0.85 : 1.0)
      const xwindSev = Math.min(100, Math.max(0, (xwindKt - xLim * 0.7) / Math.max(5, xLim * 0.3) * 100))

      // TAILWIND: above 10kt limit (FAR 25 max 10kt absent specific cert)
      const tailLim = 10
      const tailSev = Math.min(100, Math.max(0, (tailKt - tailLim * 0.6) / Math.max(2, tailLim * 0.4) * 100))

      const drivers: Array<{ k: Driver; v: number }> = [
        { k: 'HYDRO', v: hydroSev },
        { k: 'LDR', v: ldrSev },
        { k: 'RCAM', v: rcamSev },
        { k: 'XWIND', v: xwindSev },
        { k: 'TAIL', v: tailSev },
      ]
      drivers.sort((a, b) => b.v - a.v)
      const score = drivers[0].v
      const driver: Driver = score < 1 ? 'NONE' : drivers[0].k
      const tier: Tier =
        score >= 80 ? 'ABORT' :
        score >= 55 ? 'HIGH' :
        score >= 25 ? 'WATCH' : 'OK'

      out.push({
        f, klass, flCur,
        dest: dest.a, distNm: dest.distNm,
        vrefKt, gsThrKt, tirePsi, vpKt, vpRevKt,
        rcam, mu, windKt, windDir, rwyHdg, xwindKt, tailKt,
        ldaFt, ldrFt,
        hydroSev, ldrSev, rcamSev, xwindSev, tailSev,
        score, tier, driver,
      })
    }
    return out
  }, [flights, captureNm, rcamOverride, safety, windKtBase, tailBias])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, WATCH: 0, HIGH: 0, ABORT: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    const valid = rows.filter(r => r.tier !== 'IDLE')
    const n = Math.max(1, valid.length)
    const meanScore = valid.reduce((a, b) => a + b.score, 0) / n
    const meanVp = valid.reduce((a, b) => a + b.vpKt, 0) / n
    const meanMargin = valid.reduce((a, b) => a + (b.ldaFt - b.ldrFt), 0) / n
    let worst: Row | null = null
    for (const r of valid) if (!worst || r.score > worst.score) worst = r
    const abort = valid.filter(r => r.tier === 'ABORT').length
    return {
      meanScore, meanVp, meanMargin, abort, totalAc: valid.length,
      worstCs: worst ? (worst.f.callsign || worst.f.icao).trim() : '',
      worstScore: worst ? worst.score : 0,
      worstDriver: worst ? worst.driver : ('NONE' as Driver),
    }
  }, [rows])

  const airportAggs = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      const k = r.dest.icao
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(r)
    }
    const arr = Array.from(m.entries()).map(([icao, list]) => {
      const a = list[0].dest
      const meanScore = list.reduce((s, r) => s + r.score, 0) / list.length
      const worstTier = list.reduce((acc, r) => TIER_RANK[r.tier] < TIER_RANK[acc] ? r.tier : acc, 'OK' as Tier)
      let worstRow = list[0]
      for (const r of list) if (r.score > worstRow.score) worstRow = r
      const abort = list.filter(r => r.tier === 'ABORT').length
      const high = list.filter(r => r.tier === 'HIGH').length
      return { icao, aero: a, list, meanScore, worstTier, worstRow, abort, high }
    })
    arr.sort((a, b) => {
      const ti = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
      if (ti !== 0) return ti
      return b.list.length - a.list.length
    })
    return arr
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows
      .filter(r => {
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.dest.iata, r.dest.icao].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, klassFilter, query])

  // ---- MapLibre layers ----
  useEffect(() => {
    if (!map) return
    const valid = rows.filter(r => r.tier !== 'IDLE')
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? valid.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + Math.min(14, r.score / 7) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? valid.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ›${r.dest.iata} ${r.score.toFixed(0)}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lineRows = valid.filter(r => r.tier !== 'OK')
    const lineFc = { type: 'FeatureCollection' as const, features: showLine ? lineRows.map(r => {
      const pts: [number, number][] = []
      const la1 = r.f.lat * Math.PI / 180, lo1 = r.f.lng * Math.PI / 180
      const la2 = r.dest.lat * Math.PI / 180, lo2 = r.dest.lng * Math.PI / 180
      const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2))
      for (let i = 0; i <= 16; i++) {
        const t = i / 16
        if (d < 1e-6) { pts.push([r.f.lng, r.f.lat]); continue }
        const A = Math.sin((1 - t) * d) / Math.sin(d)
        const B = Math.sin(t * d) / Math.sin(d)
        const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2)
        const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2)
        const z = A * Math.sin(la1) + B * Math.sin(la2)
        const la = Math.atan2(z, Math.sqrt(x * x + y * y)) * 180 / Math.PI
        const lo = Math.atan2(y, x) * 180 / Math.PI
        pts.push([lo, la])
      }
      return {
        type: 'Feature' as const,
        properties: { color: TIER_COLOR[r.tier] },
        geometry: { type: 'LineString' as const, coordinates: pts },
      }
    }) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? valid.filter(r => r.tier === 'ABORT' || r.tier === 'HIGH').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `›${r.dest.iata} ${Math.round(r.distNm)}nm` },
      geometry: { type: 'Point' as const, coordinates: [r.dest.lng, r.dest.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_LINE, lineFc, () => map.addLayer({ id: LYR_LINE, type: 'line', source: SRC_LINE, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.75, 'line-dasharray': [2, 3],
      } }))
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'],
        'circle-opacity': 0.14, 'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-anchor': 'top', 'text-offset': [0, 0.8], 'icon-allow-overlap': true,
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.6 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6],
        'text-anchor': 'top', 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINE]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_LINE]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showLine])

  // Diagram: GS-threshold vs Vp scatter
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 28
    const xMin = 80, xMax = 180, yMax = 100
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * (W - PAD - 6)
    const ys = (s: number) => 6 + (1 - Math.max(0, Math.min(1, s / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMax }
  }, [])

  const rcamLabel = ['GLR-ICE','ICE','FLOOD','STAND-H2O','SLUSH','WET','DRY'][rcamOverride] || 'STAND-H2O'

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Rwy Excursion / Hydroplane</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.filter(r => r.tier !== 'IDLE').length} arr</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Score</div>
          <div className="font-mono text-sm" style={{ color: summary.meanScore >= 55 ? '#f59e0b' : summary.meanScore >= 25 ? '#0ea5e9' : '#10b981' }}>
            {summary.meanScore.toFixed(1)}<span className="text-[9px] text-slate-500"> /100</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstScore.toFixed(0)}` : '\u2014'}
          </div>
          <div className="font-mono text-[9px] text-slate-500 truncate">{summary.worstDriver}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Abort</div>
          <div className="font-mono text-sm" style={{ color: summary.abort > 0 ? '#ef4444' : '#10b981' }}>{summary.abort}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Vp</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.meanVp.toFixed(0)}<span className="text-[9px] text-slate-500"> kt</span></div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean LDA Margin</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanMargin < 1500 ? '#f59e0b' : '#10b981' }}>
            {summary.meanMargin.toFixed(0)}<span className="text-[9px] text-slate-500"> ft</span>
          </div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">GS @ THR vs Vp · {rcamLabel}</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[
              { lo: 0, hi: 25, c: '#10b981' },
              { lo: 25, hi: 55, c: '#0ea5e9' },
              { lo: 55, hi: 80, c: '#f59e0b' },
              { lo: 80, hi: 100, c: '#ef4444' },
            ].map((b, i) => (
              <rect key={i} x={diag.PAD} y={diag.ys(b.hi)} width={diag.W - diag.PAD - 6} height={Math.max(0, diag.ys(b.lo) - diag.ys(b.hi))} fill={b.c} opacity={0.06} />
            ))}
            {[25, 55, 80].map(t => (
              <line key={t} x1={diag.PAD} y1={diag.ys(t)} x2={diag.W - 6} y2={diag.ys(t)} stroke={t === 25 ? '#0ea5e9' : t === 55 ? '#f59e0b' : '#ef4444'} strokeWidth={0.9} strokeDasharray="3 2" opacity={0.75} />
            ))}
            {[100, 120, 140, 160].map(x => (
              <g key={x}>
                <line x1={diag.xs(x)} y1={6} x2={diag.xs(x)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(x)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{x}kt</text>
              </g>
            ))}
            {[25, 50, 75, 100].map(s => (
              <text key={s} x={diag.PAD - 2} y={diag.ys(s) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{s}</text>
            ))}
            {rows.filter(r => r.tier !== 'IDLE').map(r => (
              <g key={r.f.icao}>
                <circle cx={diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, r.gsThrKt)))} cy={diag.ys(Math.min(diag.yMax, r.score))} r={3} fill={TIER_COLOR[r.tier]} opacity={0.95} />
              </g>
            ))}
            {/* Mean Vp vertical reference */}
            <line x1={diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, summary.meanVp)))} y1={6}
                  x2={diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, summary.meanVp)))} y2={diag.H - diag.PAD}
                  stroke="#f59e0b" strokeDasharray="4 2" strokeWidth={1} opacity={0.7} />
            <text x={diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, summary.meanVp)))} y={14} textAnchor="middle"
                  fontSize={8} fill="#f59e0b" fontFamily="monospace">Vp̄</text>
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>RCAM</span><span className="font-mono text-slate-300">{rcamOverride} {rcamLabel}</span></div>
            <input type="range" min={0} max={6} step={1} value={rcamOverride} onChange={e => setRcamOverride(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>SAFETY</span><span className="font-mono text-slate-300">{(safety / 100).toFixed(2)}x</span></div>
            <input type="range" min={100} max={160} step={5} value={safety} onChange={e => setSafety(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>WIND</span><span className="font-mono text-slate-300">{windKtBase}kt</span></div>
            <input type="range" min={0} max={40} step={1} value={windKtBase} onChange={e => setWindKtBase(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>TAIL-BIAS</span><span className="font-mono text-slate-300">{tailBias > 0 ? '+' : ''}{tailBias}kt</span></div>
            <input type="range" min={-15} max={15} step={1} value={tailBias} onChange={e => setTailBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>CAPTURE</span><span className="font-mono text-slate-300">{captureNm}nm</span></div>
          <input type="range" min={60} max={600} step={20} value={captureNm} onChange={e => setCaptureNm(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klassFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['heavy', 'narrow', 'regional', 'biz', 'turboprop', 'ga', 'fighter'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klassFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{KLASS_LABEL[k]}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLine} onChange={e => setShowLine(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
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
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} ac` : `${airportAggs.length} dest airports`}</span>
        <span>{tab === 'AIRCRAFT' ? 'GS · Vp · LDA-LDR · tier' : 'arrivals · worst · mean'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No matching arrivals.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const sevPct = Math.min(100, r.score)
          const marginFt = r.ldaFt - r.ldrFt
          const advice =
            r.tier === 'IDLE' ? 'no inferrable destination' :
            r.tier === 'ABORT' && r.driver === 'HYDRO' ? `GS ${r.gsThrKt.toFixed(0)} > Vp ${r.vpKt.toFixed(0)} on ${rcamLabel} · go-around / divert dry rwy` :
            r.tier === 'ABORT' && r.driver === 'LDR' ? `LDR ${r.ldrFt.toFixed(0)} > LDA ${r.ldaFt.toFixed(0)} · divert longer runway` :
            r.tier === 'ABORT' && r.driver === 'RCAM' ? 'glare-ice or ice surface · suspend ops divert' :
            r.tier === 'ABORT' && r.driver === 'XWIND' ? `xwind ${r.xwindKt.toFixed(0)}kt > limit · request alt runway` :
            r.tier === 'ABORT' && r.driver === 'TAIL' ? `tail ${r.tailKt.toFixed(0)}kt > 10kt · request opposite-direction rwy` :
            r.tier === 'HIGH' && r.driver === 'HYDRO' ? 'reverted-rubber risk · max reverse + max brake auto-arm' :
            r.tier === 'HIGH' && r.driver === 'LDR' ? `LDA margin ${marginFt.toFixed(0)}ft tight · reduce flap CONF FULL` :
            r.tier === 'HIGH' && r.driver === 'RCAM' ? 'standing water/flooded · brief stable-approach + early flare' :
            r.tier === 'HIGH' && r.driver === 'XWIND' ? `xwind ${r.xwindKt.toFixed(0)}kt near limit · crab-and-kick brief crew` :
            r.tier === 'HIGH' && r.driver === 'TAIL' ? `tail ${r.tailKt.toFixed(0)}kt · review LDR uplift +20%` :
            r.tier === 'WATCH' ? `monitor brake-action reports at ${r.dest.iata}` :
            'within stable approach envelope'
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{KLASS_LABEL[r.klass]}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="flight level">F{Math.round(r.flCur)}</span>
                  <span title="GS at threshold" style={{ color: r.gsThrKt > r.vpKt ? TIER_COLOR['HIGH'] : '#94a3b8' }}>GS{r.gsThrKt.toFixed(0)}</span>
                  <span title="Vp dynamic hydroplaning">Vp{r.vpKt.toFixed(0)}</span>
                  <span title="distance to dest">›{r.dest.iata} {Math.round(r.distNm)}nm</span>
                  <span className="ml-auto truncate" title="dominant driver" style={{ color: TIER_COLOR[r.tier] }}>{r.driver}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="composite risk 0-100">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${sevPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: '25%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '55%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '80%' }} />
                </div>
                <div className="grid grid-cols-5 gap-1 mt-1 text-[9px] font-mono">
                  {([
                    { lbl: 'HYD', v: r.hydroSev },
                    { lbl: 'LDR', v: r.ldrSev },
                    { lbl: 'RCM', v: r.rcamSev },
                    { lbl: 'XWD', v: r.xwindSev },
                    { lbl: 'TAL', v: r.tailSev },
                  ] as const).map((b, i) => {
                    const tt: Tier = b.v >= 80 ? 'ABORT' : b.v >= 55 ? 'HIGH' : b.v >= 25 ? 'WATCH' : 'OK'
                    return (
                      <span key={i} className="px-1 py-0 rounded border text-center" style={{ borderColor: TIER_COLOR[tt] + '66', color: TIER_COLOR[tt] }}>{b.lbl} {b.v.toFixed(0)}</span>
                    )
                  })}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="VREF">Vr{r.vrefKt.toFixed(0)}</span>
                  <span title="LDA available">LDA{r.ldaFt.toFixed(0)}</span>
                  <span title="LDR required" style={{ color: marginFt < 1500 ? TIER_COLOR['HIGH'] : '#64748b' }}>LDR{r.ldrFt.toFixed(0)}</span>
                  <span title="xwind kt" style={{ color: r.xwindKt > XWIND_LIM[r.klass] * 0.85 ? TIER_COLOR['HIGH'] : '#64748b' }}>x{r.xwindKt.toFixed(0)}</span>
                  <span title="tailwind kt" style={{ color: r.tailKt > 8 ? TIER_COLOR['HIGH'] : '#64748b' }}>t{r.tailKt > 0 ? '+' : ''}{r.tailKt.toFixed(0)}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' || r.tier === 'IDLE' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'AIRPORTS' && airportAggs.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No active arrival airports.</div>
        )}
        {tab === 'AIRPORTS' && airportAggs.map(z => {
          const pct = Math.min(100, z.meanScore)
          const advice = z.worstTier === 'ABORT' ? 'abort-rate arrivals · review surface friction reports' :
            z.worstTier === 'HIGH' ? 'high risk · advise stable approach + crew brief' :
            z.worstTier === 'WATCH' ? 'within envelope · routine monitoring' :
            'nominal arrival ops'
          return (
            <button key={z.icao} onClick={() => onFly(z.worstRow.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[z.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{z.aero.iata}</span>
                  <span className="text-slate-500 truncate">{z.aero.name}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{z.list.length}arr</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[z.worstTier] }}>{z.worstTier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span style={{ color: TIER_COLOR[z.worstTier] }}>mean {z.meanScore.toFixed(1)}</span>
                  <span>LDA {LDA_FT[z.aero.size]}ft {SIZE_LABEL[z.aero.size]}</span>
                  <span className="ml-auto">A{z.abort} H{z.high}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="airport mean score">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: TIER_COLOR[z.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: '25%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '55%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '80%' }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate">worst {(z.worstRow.f.callsign || z.worstRow.f.icao).trim()} {z.worstRow.score.toFixed(0)}</span>
                  <span className="ml-auto truncate" style={{ color: z.worstTier === 'OK' ? '#64748b' : TIER_COLOR[z.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
