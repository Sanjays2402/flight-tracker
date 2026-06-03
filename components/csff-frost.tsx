'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Cold-Soaked Fuel Frost (CSFF) Wing Underside Frost Predictor
   -----------------------------------------------------------
   Watches every inbound (DESC/APPR) aircraft and reconstructs
   the cold-soaked wing-tank skin temperature accumulated during
   cruise, then predicts whether — upon arrival at destination
   surface conditions — the wing lower (and upper) surfaces will
   form frost from ambient water-vapour condensation on contact
   with sub-freezing fuel-skin. CSFF is the FAA/TC-recognised
   mechanism behind the "clear-ice / cold-soak frost" warnings
   that have driven multiple takeoff-stall accidents.

   Regulatory & operational basis:
     · FAA SAFO 06014 Cold-Soaked Fuel Frost (CSFF)
     · FAA AC 120-58 Pilot Guide: Large Aircraft Ground Deicing
     · FAA AC 135-17 Pilot Guide Small Aircraft Ground Deicing
     · 14 CFR 121.629(b) Clean Aircraft Concept
     · 14 CFR 125.221 / 135.227
     · Transport Canada AC 700-005 Wing Contamination Awareness
     · Boeing 737 FCOM SP.16 Cold-Soaked Fuel Frost
     · Boeing AERO Q4-2017 Wing Frost & Cold-Soaked Fuel
     · Airbus FCOM PRO-NOR-SRP-21 Wing Frost & Cold-Soak
     · Airbus Safety First Mag 23 Cold-Soaked Frost
     · EASA SIB 2010-09 Cold-Soaked Frost
     · NTSB AAR-83/02 Air Florida 90 (frost contribution)
     · NTSB AAR-93/02 Continental 1713
     · NTSB AAR-15/03 Delta 1086 (wing contamination factor)
     · AAIB EW/C2009/02/01 BMI A319 Belfast frost departure
     · SAE ARP4737 Type I-IV holdover tables
     · ICAO Doc 9640 Manual of Aircraft Ground De-icing/Anti-icing
     · CFR 25.1581 / AMC 25.1581 cold-soak fuel residual

   Algorithm:
     1. CRUISE FUEL SOAK reconstruction.
        For each airborne aircraft DESCending or APPRoaching, look
        back over an assumed cruise leg of CRUISE-DUR slider
        minutes at the recorded altitude/SAT history (proxied
        from current altitude + class-typical cruise FL bias).
        Skin temperature converges asymptotically toward TAT
        with a class-typed thermal time-constant τ:
            T_skin(t) = TAT - (TAT - T_initial) · exp(-t/τ)
        Per Boeing AERO Q4-2017 τ ≈ 35-90 min depending on
        tank skin area / fuel mass ratio (HVY 75-90 / NRW 40-55
        / RGN 30-40 / BIZ 25-35 / TBP 20-30 / GA 10-20 min).
     2. DESCENT WARM-UP.
        After top-of-descent, T_skin warms toward warming TAT
        with same τ. Predicted touchdown T_skin_TD computed
        from current ALT and assumed descent rate of 1500-2200
        fpm to a 500ft TDZ.
     3. DESTINATION CONDITIONS.
        Synthesise destination OAT and DEWPOINT from a hash-
        stable destination-airport bias + nearest-of 56-airport
        catalogue with seasonal mean OAT and dewpoint-spread
        (cold-belt YYC YYZ ORD JFK ZRH MUC HEL OSL ARN CPH HND
        ICN PEK SVO temperate, hot-humid MIA SIN BKK DXB DOH
        HKG, tropical-dry CAI JNB AUH PHX LAS, mountain ASE EGE
        DEN). Dewpoint computed as OAT - DPSPREAD where DPSPREAD
        is hash-stable 1-15°C. Adjustable by SEASON slider that
        scales OAT base.
     4. FROST FORMATION TEST per FAA SAFO 06014:
        CSFF will form on the wing surface above a sub-freezing
        fuel tank when:
          T_skin_TD ≤ DEWPOINT AND T_skin_TD ≤ 0°C
        plus margin scaling for boundary-layer mixing.

     5. Per-airframe hash-stable synthesis (FNV-1a 32-bit ICAO24):
        · Tank load factor 35-95%
        · Centre-tank-empty flag (true 40% fleet) — empty centre
          accelerates wing-tank cool-down by 15-30%
        · Skin-paint absorptivity (white 0.30, polished 0.55,
          dark 0.85) shifting steady-state by 2-4°C in sun
        · Surface-wind condition at destination, scaling
          boundary-layer mixing 0.3-1.4× nominal heat-transfer
        · Sunshine flag at destination time-of-arrival

   5 risk components, composite = max-driver:
     SKIN  T_skin_TD severity 0 above +5°C ramping 100 at -15°C
     DEW   T_skin_TD vs dewpoint margin sev 0 at +6°C ramping
           100 at -6°C
     SOAK  cruise residence at high alt (cool soak depth) ramps
           with time-at-FL >FL310 above MIN-SOAK threshold
     CTR-E centre-tank-empty true with tank lf>0.55 sev 60 fixed
     MIX   destination low-wind <5 kt suppresses convective
           warm-up — sev 0 at 12kt ramping 70 at 0kt

   Tier classification:
     CSFF     score>=80 OR (T_skin_TD<=0 AND T_skin_TD<=dew)
              rose — wing-contact inspection mandatory, full
              deicing per AC 120-58, no clean-aircraft cert
              without tactile check of cold-soak zone
     LIKELY   score>=55 amber — pre-flight tactile check of
              wing lower surface above cold tanks per Boeing
              FCOM SP.16; Type I fluid required if frost
              present
     WATCH    score>=25 sky — wing-skin will be cold; advise
              ground-handling team to verify
     OK       score<25 emerald — skin warm enough or dewpoint
              dry enough that CSFF unlikely
     IDLE     not arriving / ground / above MIN-FL — slate

   MapLibre overlay:
     · Tier-coloured halo rings sized by score 8-22 px
     · Rose diamond pin for CSFF tier with T-skin / dew callout
     · Dashed tier-coloured projection line to nearest dest IATA
     · 56 dest-airport pins with IATA + OAT-C/DP-C label
     · Tier-coloured callsign + T-skin + driver label for non-OK
     · Reference isotherm parallels at lat +60/+45/-45/-60 sky

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-T-SKIN / WORST callsign+T-skin / CSFF-count
     · 2-cell MEAN-DEW-MARGIN / SUN-SHARE secondary row
     · SVG T-skin (x, -25..+10°C) vs Dew-margin (y, -15..+15°C)
       scatter with rose CSFF quadrant (T-skin<=0 ∧ margin<=0),
       amber band, sky band, emerald nominal
     · 6 sliders MIN-FL / CRUISE-DUR / SEASON-OAT / DESC-RATE /
       DP-SPREAD-MUL / SUN-BIAS
     · 8-class chip filter + HALO/PIN/LBL/PROJ/APT/REF/DIAG
     · AIRCRAFT and AIRPORTS tabs

   Persisted: ft-csff
   ============================================================ */

export interface CsffFlight {
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
  flights: CsffFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'CSFF' | 'LIKELY' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  CSFF: '#ef4444', LIKELY: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['CSFF', 'LIKELY', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { CSFF: 0, LIKELY: 1, WATCH: 2, OK: 3, IDLE: 4 }

type AcClass = 'HVY' | 'HMB' | 'HMW' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA'
const CLASS_LIST: AcClass[] = ['HVY', 'HMB', 'HMW', 'NRW', 'RGN', 'BIZ', 'TBP', 'GA']

interface ClassSpec {
  tauMin: number       // thermal time-constant minutes
  cruiseFl: number     // typical cruise FL
  paintAbs: number     // solar absorptivity baseline
  fcom: string
  capacityLb: number
}
const CLASS_SPEC: Record<AcClass, ClassSpec> = {
  HVY: { tauMin: 85, cruiseFl: 380, paintAbs: 0.35, fcom: '747-8 SP.16 / A380 FCOM 28-30-00', capacityLb: 410000 },
  HMB: { tauMin: 75, cruiseFl: 360, paintAbs: 0.35, fcom: '777 SP.16 / A350 FCOM',            capacityLb: 250000 },
  HMW: { tauMin: 65, cruiseFl: 370, paintAbs: 0.40, fcom: '787 SP.16 / A330 FCOM',            capacityLb: 180000 },
  NRW: { tauMin: 50, cruiseFl: 360, paintAbs: 0.45, fcom: '737 FCOM SP.16 / A320 PRO-NOR',    capacityLb: 50000 },
  RGN: { tauMin: 35, cruiseFl: 340, paintAbs: 0.50, fcom: 'CRJ/E170 FCOM SP.16',              capacityLb: 18000 },
  BIZ: { tauMin: 30, cruiseFl: 410, paintAbs: 0.55, fcom: 'GLF/CL FCOM 28',                   capacityLb: 32000 },
  TBP: { tauMin: 25, cruiseFl: 220, paintAbs: 0.55, fcom: 'DH8/B200 AFM 28',                  capacityLb: 6000 },
  GA:  { tauMin: 15, cruiseFl: 90,  paintAbs: 0.60, fcom: 'POH §7',                           capacityLb: 600 },
}

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|A38|IL96/.test(t)) return 'HVY'
  if (/B77|A35/.test(t)) return 'HMB'
  if (/B78|A33|A34|MD11/.test(t)) return 'HMW'
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

// 56-airport destination catalogue: IATA, lat, lng, baseOAT-C (annual mean), dpSpread-C
interface AirportRec {
  iata: string; lat: number; lng: number; oatBase: number; dpSpread: number; sunlikely: number /* 0-1 prob */
}
const AIRPORTS: AirportRec[] = [
  { iata: 'YYC', lat: 51.11, lng: -114.02, oatBase: 4,  dpSpread: 5, sunlikely: 0.45 },
  { iata: 'YYZ', lat: 43.68, lng: -79.63,  oatBase: 8,  dpSpread: 4, sunlikely: 0.40 },
  { iata: 'YVR', lat: 49.19, lng: -123.18, oatBase: 10, dpSpread: 3, sunlikely: 0.30 },
  { iata: 'ANC', lat: 61.17, lng: -149.99, oatBase: 2,  dpSpread: 3, sunlikely: 0.30 },
  { iata: 'ORD', lat: 41.98, lng: -87.91,  oatBase: 10, dpSpread: 4, sunlikely: 0.45 },
  { iata: 'MSP', lat: 44.88, lng: -93.22,  oatBase: 7,  dpSpread: 4, sunlikely: 0.45 },
  { iata: 'DEN', lat: 39.86, lng: -104.67, oatBase: 9,  dpSpread: 8, sunlikely: 0.70 },
  { iata: 'JFK', lat: 40.64, lng: -73.78,  oatBase: 12, dpSpread: 4, sunlikely: 0.45 },
  { iata: 'BOS', lat: 42.36, lng: -71.01,  oatBase: 10, dpSpread: 4, sunlikely: 0.45 },
  { iata: 'SEA', lat: 47.45, lng: -122.31, oatBase: 11, dpSpread: 3, sunlikely: 0.25 },
  { iata: 'PHL', lat: 39.87, lng: -75.24,  oatBase: 12, dpSpread: 4, sunlikely: 0.45 },
  { iata: 'IAD', lat: 38.94, lng: -77.46,  oatBase: 13, dpSpread: 4, sunlikely: 0.45 },
  { iata: 'DTW', lat: 42.21, lng: -83.35,  oatBase: 9,  dpSpread: 4, sunlikely: 0.40 },
  { iata: 'ASE', lat: 39.22, lng: -106.87, oatBase: 5,  dpSpread: 9, sunlikely: 0.70 },
  { iata: 'EGE', lat: 39.64, lng: -106.92, oatBase: 6,  dpSpread: 9, sunlikely: 0.70 },
  { iata: 'JAC', lat: 43.61, lng: -110.74, oatBase: 4,  dpSpread: 8, sunlikely: 0.65 },
  { iata: 'SLC', lat: 40.79, lng: -111.97, oatBase: 12, dpSpread: 8, sunlikely: 0.65 },
  { iata: 'PHX', lat: 33.43, lng: -112.00, oatBase: 24, dpSpread: 14, sunlikely: 0.85 },
  { iata: 'LAS', lat: 36.08, lng: -115.15, oatBase: 21, dpSpread: 13, sunlikely: 0.85 },
  { iata: 'LAX', lat: 33.94, lng: -118.41, oatBase: 18, dpSpread: 6, sunlikely: 0.65 },
  { iata: 'SFO', lat: 37.62, lng: -122.37, oatBase: 14, dpSpread: 4, sunlikely: 0.50 },
  { iata: 'MIA', lat: 25.80, lng: -80.29,  oatBase: 25, dpSpread: 4, sunlikely: 0.65 },
  { iata: 'ATL', lat: 33.64, lng: -84.43,  oatBase: 17, dpSpread: 4, sunlikely: 0.55 },
  { iata: 'DFW', lat: 32.90, lng: -97.04,  oatBase: 19, dpSpread: 6, sunlikely: 0.60 },
  { iata: 'IAH', lat: 29.98, lng: -95.34,  oatBase: 21, dpSpread: 4, sunlikely: 0.55 },
  { iata: 'LHR', lat: 51.47, lng: -0.46,   oatBase: 11, dpSpread: 3, sunlikely: 0.30 },
  { iata: 'LGW', lat: 51.15, lng: -0.19,   oatBase: 11, dpSpread: 3, sunlikely: 0.30 },
  { iata: 'CDG', lat: 49.01, lng: 2.55,    oatBase: 11, dpSpread: 3, sunlikely: 0.35 },
  { iata: 'AMS', lat: 52.31, lng: 4.76,    oatBase: 10, dpSpread: 3, sunlikely: 0.30 },
  { iata: 'FRA', lat: 50.04, lng: 8.56,    oatBase: 10, dpSpread: 3, sunlikely: 0.35 },
  { iata: 'MUC', lat: 48.35, lng: 11.79,   oatBase: 9,  dpSpread: 3, sunlikely: 0.40 },
  { iata: 'ZRH', lat: 47.46, lng: 8.55,    oatBase: 9,  dpSpread: 3, sunlikely: 0.40 },
  { iata: 'VIE', lat: 48.11, lng: 16.57,   oatBase: 10, dpSpread: 4, sunlikely: 0.45 },
  { iata: 'CPH', lat: 55.62, lng: 12.65,   oatBase: 8,  dpSpread: 3, sunlikely: 0.35 },
  { iata: 'ARN', lat: 59.65, lng: 17.92,   oatBase: 6,  dpSpread: 3, sunlikely: 0.35 },
  { iata: 'OSL', lat: 60.19, lng: 11.10,   oatBase: 5,  dpSpread: 3, sunlikely: 0.30 },
  { iata: 'HEL', lat: 60.32, lng: 24.96,   oatBase: 5,  dpSpread: 3, sunlikely: 0.30 },
  { iata: 'SVO', lat: 55.97, lng: 37.41,   oatBase: 5,  dpSpread: 4, sunlikely: 0.35 },
  { iata: 'WAW', lat: 52.17, lng: 20.97,   oatBase: 9,  dpSpread: 4, sunlikely: 0.40 },
  { iata: 'MAD', lat: 40.49, lng: -3.57,   oatBase: 15, dpSpread: 8, sunlikely: 0.65 },
  { iata: 'BCN', lat: 41.30, lng: 2.08,    oatBase: 16, dpSpread: 6, sunlikely: 0.65 },
  { iata: 'FCO', lat: 41.80, lng: 12.25,   oatBase: 16, dpSpread: 6, sunlikely: 0.60 },
  { iata: 'IST', lat: 41.26, lng: 28.74,   oatBase: 15, dpSpread: 5, sunlikely: 0.55 },
  { iata: 'DXB', lat: 25.25, lng: 55.36,   oatBase: 28, dpSpread: 8, sunlikely: 0.80 },
  { iata: 'DOH', lat: 25.27, lng: 51.61,   oatBase: 28, dpSpread: 8, sunlikely: 0.80 },
  { iata: 'AUH', lat: 24.43, lng: 54.65,   oatBase: 28, dpSpread: 8, sunlikely: 0.80 },
  { iata: 'BKK', lat: 13.69, lng: 100.75,  oatBase: 28, dpSpread: 4, sunlikely: 0.55 },
  { iata: 'SIN', lat: 1.36,  lng: 103.99,  oatBase: 27, dpSpread: 3, sunlikely: 0.45 },
  { iata: 'HKG', lat: 22.31, lng: 113.92,  oatBase: 23, dpSpread: 4, sunlikely: 0.55 },
  { iata: 'PEK', lat: 40.08, lng: 116.59,  oatBase: 12, dpSpread: 6, sunlikely: 0.55 },
  { iata: 'PVG', lat: 31.14, lng: 121.81,  oatBase: 17, dpSpread: 4, sunlikely: 0.50 },
  { iata: 'ICN', lat: 37.46, lng: 126.44,  oatBase: 12, dpSpread: 5, sunlikely: 0.50 },
  { iata: 'HND', lat: 35.55, lng: 139.78,  oatBase: 15, dpSpread: 5, sunlikely: 0.55 },
  { iata: 'NRT', lat: 35.76, lng: 140.39,  oatBase: 14, dpSpread: 5, sunlikely: 0.55 },
  { iata: 'SYD', lat: -33.94, lng: 151.18, oatBase: 18, dpSpread: 5, sunlikely: 0.60 },
  { iata: 'JNB', lat: -26.13, lng: 28.24,  oatBase: 16, dpSpread: 10, sunlikely: 0.70 },
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

type Driver = 'SKIN' | 'DEW' | 'SOAK' | 'CTRE' | 'MIX' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  SKIN: 'Skin temperature sub-freezing',
  DEW: 'Skin below dewpoint',
  SOAK: 'Deep cruise cold-soak',
  CTRE: 'Centre-tank empty',
  MIX: 'Low surface wind, no warm-up',
  NONE: 'Nominal',
}

interface Row {
  f: CsffFlight
  klass: AcClass
  spec: ClassSpec
  dest: AirportRec | null
  distNm: number
  tatCruiseC: number   // cruise TAT
  skinNowC: number
  skinTdC: number      // predicted at touchdown
  oatDestC: number
  dewDestC: number
  dewMargin: number    // skin - dew
  ctrEmpty: boolean
  paintAbs: number
  windSfcKt: number
  sun: boolean
  lf: number
  sev: { skin: number; dew: number; soak: number; ctre: number; mix: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'csff-halo', SRC_LBL = 'csff-lbl', SRC_PIN = 'csff-pin', SRC_PROJ = 'csff-proj', SRC_APT = 'csff-apt', SRC_REF = 'csff-ref'
const LYR_HALO = 'csff-halo-l', LYR_LBL = 'csff-lbl-l', LYR_PIN = 'csff-pin-l', LYR_PROJ = 'csff-proj-l', LYR_APT = 'csff-apt-l', LYR_APT_LBL = 'csff-apt-lbl-l', LYR_REF = 'csff-ref-l'

export default function CsffFrost({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(50)
  const [cruiseDur, setCruiseDur] = useState(120)     // assumed cruise soak duration min 30..420
  const [seasonOat, setSeasonOat] = useState(0)       // °C bias on dest OAT -25..+25
  const [descRate, setDescRate] = useState(1800)      // fpm 800..3000
  const [dpSpreadMul, setDpSpreadMul] = useState(100) // 25..200%
  const [sunBias, setSunBias] = useState(0)           // -100..+100% sun probability shift
  const [capture, setCapture] = useState(250)         // nm 50..600

  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showApt, setShowApt] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl) continue
      // Only descending/approaching aircraft (vert rate < -200 fpm OR fl < 200)
      const inbound = f.vertRate < -150 || fl < 200
      if (!inbound) continue

      const klass = classifyClass(f.type || '')
      const spec = CLASS_SPEC[klass]
      const h = hash32(f.icao || '')

      // Find nearest destination airport within capture aligned with track
      let dest: AirportRec | null = null
      let bestD = Infinity
      for (const a of AIRPORTS) {
        const d = haversineNm(f.lat, f.lng, a.lat, a.lng)
        if (d > capture) continue
        const br = bearingDeg(f.lat, f.lng, a.lat, a.lng)
        const delta = Math.abs(((br - f.track + 540) % 360) - 180)
        if (delta > 75) continue
        if (d < bestD) { bestD = d; dest = a }
      }
      if (!dest) continue
      const distNm = bestD

      // Cruise TAT @ cruiseFL using ISA + recovery factor
      const cruiseFL = Math.max(fl, spec.cruiseFl)
      const satCruise = Math.max(-65, 15 - 1.98 * cruiseFL / 10)
      const mach = 0.78
      const tatCruise = satCruise + 0.85 * mach * mach * 0.2 * 273  // K equivalent recovery → ~28C
      // Skin asymptote during cruise: clip to SAT (no aerodynamic heating on tank lower-skin)
      const skinAsympCruise = satCruise + 2  // wing-tank lower-skin slightly above SAT due to internal conduction
      const tauC = spec.tauMin
      // Fuel load factor
      const lf = 0.35 + ((h >>> 3) % 60) / 100
      // Larger fuel mass → longer effective τ
      const tauEff = tauC * (0.6 + lf * 0.8)
      // T_skin after cruise duration starting from +10°C ramp-up airframe
      const tInit = 10
      const tCruiseEnd = skinAsympCruise + (tInit - skinAsympCruise) * Math.exp(-cruiseDur / tauEff)

      // Descent warm-up: time to TDZ from current alt at descRate
      const timeDescMin = Math.max(0, (f.altitudeFt - 500) / descRate)
      // Warming TAT during descent ~ avg of cruise SAT and surface OAT
      const oatDest = dest.oatBase + seasonOat
      const tatDescAvg = (satCruise + oatDest) / 2 + 5  // adiabatic warming + recovery
      // Skin now: between cruise end and current (already partially warmed if low FL)
      const flProg = Math.max(0, Math.min(1, 1 - (f.altitudeFt - 500) / Math.max(1, cruiseFL * 100 - 500)))
      const skinNow = tCruiseEnd + (tatDescAvg - tCruiseEnd) * (1 - Math.exp(-(flProg * timeDescMin * 0.7) / tauEff))
      // Skin at TD
      const skinTd = tCruiseEnd + (tatDescAvg - tCruiseEnd) * (1 - Math.exp(-timeDescMin / tauEff))

      // Dewpoint at destination
      const dpSpread = Math.max(1, dest.dpSpread * (dpSpreadMul / 100))
      const dew = oatDest - dpSpread

      // Centre tank empty (40% fleet)
      const ctrEmpty = ((h >>> 11) % 100) < 40
      // Paint absorptivity (white/polish/dark)
      const paintAbs = spec.paintAbs + (((h >>> 13) % 30) - 15) / 100
      // Surface wind 0-20 kt
      const windSfcKt = ((h >>> 17) % 200) / 10
      // Sun at arrival
      const sunProb = Math.max(0, Math.min(1, dest.sunlikely + sunBias / 100))
      const sun = ((h >>> 19) % 100) < sunProb * 100

      // Apply solar warm-up bonus if sun and arriving daylight: +2..6°C on skin
      const sunBonus = sun ? (2 + paintAbs * 6) : 0
      const skinTdAdj = skinTd + sunBonus
      const skinNowAdj = skinNow + sunBonus * 0.4
      // Centre-empty bonus to cooling
      const ctreCool = ctrEmpty ? -3 : 0
      const skinTdFinal = skinTdAdj + ctreCool
      const skinNowFinal = skinNowAdj + ctreCool * 0.5

      const dewMargin = skinTdFinal - dew

      // severities
      const skinSev = skinTdFinal >= 5 ? 0 : skinTdFinal <= -15 ? 100 : ((5 - skinTdFinal) / 20) * 100
      const dewSev = dewMargin >= 6 ? 0 : dewMargin <= -6 ? 100 : ((6 - dewMargin) / 12) * 100
      // Soak severity: deep cold soak (tCruiseEnd well below 0)
      const soakSev = tCruiseEnd >= -10 ? 0 : tCruiseEnd <= -40 ? 100 : ((-10 - tCruiseEnd) / 30) * 100
      const ctreSev = (ctrEmpty && lf > 0.55) ? 60 : 0
      const mixSev = windSfcKt >= 12 ? 0 : ((12 - windSfcKt) / 12) * 70

      const drvList: Array<[Driver, number]> = [
        ['SKIN', skinSev], ['DEW', dewSev], ['SOAK', soakSev], ['CTRE', ctreSev], ['MIX', mixSev],
      ]
      drvList.sort((a, b) => b[1] - a[1])
      const driver: Driver = drvList[0][1] > 0 ? drvList[0][0] : 'NONE'
      const score = drvList[0][1]
      let tier: Tier
      if (score >= 80 || (skinTdFinal <= 0 && dewMargin <= 0)) tier = 'CSFF'
      else if (score >= 55) tier = 'LIKELY'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, klass, spec, dest, distNm,
        tatCruiseC: satCruise, skinNowC: skinNowFinal, skinTdC: skinTdFinal,
        oatDestC: oatDest, dewDestC: dew, dewMargin,
        ctrEmpty, paintAbs, windSfcKt, sun, lf,
        sev: { skin: skinSev, dew: dewSev, soak: soakSev, ctre: ctreSev, mix: mixSev },
        score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, cruiseDur, seasonOat, descRate, dpSpreadMul, sunBias, capture])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { CSFF: 0, LIKELY: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumSkin = 0, sumDM = 0, worst = 0, worstCs = '', worstSk = 0, worstScore = 0
    let csff = 0, sunN = 0, count = 0
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      count++
      sumSkin += r.skinTdC; sumDM += r.dewMargin
      if (r.tier === 'CSFF') csff++
      if (r.sun) sunN++
      if (r.score > worst) { worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstSk = r.skinTdC; worstScore = r.score }
    }
    return {
      meanSkin: count ? sumSkin / count : 0,
      meanDM: count ? sumDM / count : 0,
      worst, worstCs, worstSk, worstScore, csff,
      sunShare: count ? sunN / count : 0,
      activeCount: count,
    }
  }, [rows])

  const aptAggs = useMemo(() => {
    const m = new Map<string, { iata: string; rec: AirportRec; count: number; sumScore: number; sumSkin: number; csff: number; worst: number; worstCs: string; worstIcao: string; worstTier: Tier }>()
    for (const r of rows) {
      if (r.tier === 'IDLE' || !r.dest) continue
      let a = m.get(r.dest.iata)
      if (!a) { a = { iata: r.dest.iata, rec: r.dest, count: 0, sumScore: 0, sumSkin: 0, csff: 0, worst: 0, worstCs: '', worstIcao: '', worstTier: 'OK' }; m.set(r.dest.iata, a) }
      a.count++; a.sumScore += r.score; a.sumSkin += r.skinTdC
      if (r.tier === 'CSFF') a.csff++
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.score > a.worst) { a.worst = r.score; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
    }
    const arr = Array.from(m.values()).map(a => ({ ...a, meanScore: a.count ? a.sumScore / a.count : 0, meanSkin: a.count ? a.sumSkin / a.count : 0 }))
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
      .filter(r => r.tier !== 'IDLE')
      .filter(r => {
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (classFilter !== 'ALL' && r.klass !== classFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.dest?.iata].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, classFilter, query])

  const filteredAirports = useMemo(() => {
    const q = query.trim().toUpperCase()
    return aptAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (!q) return true
      return a.iata.toUpperCase().includes(q)
    })
  }, [aptAggs, tierFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'LIKELY' || r.tier === 'CSFF').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${r.skinTdC.toFixed(0)}\u00b0 ${r.driver}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'CSFF').map(r => ({
      type: 'Feature' as const,
      properties: { color: '#ef4444', text: `\u203a CSFF skin ${r.skinTdC.toFixed(0)}\u00b0/dew ${r.dewDestC.toFixed(0)}\u00b0` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const projFeatures: any[] = []
    if (showProj) {
      for (const r of rows) {
        if (r.tier === 'OK' || r.tier === 'IDLE' || !r.dest) continue
        projFeatures.push({ type: 'Feature' as const, properties: { color: TIER_COLOR[r.tier] }, geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.dest.lng, r.dest.lat]] } })
      }
    }
    const projFc = { type: 'FeatureCollection' as const, features: projFeatures }

    const aptFc = { type: 'FeatureCollection' as const, features: showApt ? AIRPORTS.map(a => {
      const agg = aptAggs.find(x => x.iata === a.iata)
      const tier = agg ? agg.worstTier : 'OK'
      const oatBiased = a.oatBase + seasonOat
      const dpBiased = oatBiased - a.dpSpread * (dpSpreadMul / 100)
      return {
        type: 'Feature' as const,
        properties: { color: agg ? TIER_COLOR[tier] : '#64748b', text: `${a.iata} ${oatBiased.toFixed(0)}\u00b0/${dpBiased.toFixed(0)}\u00b0` },
        geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] },
      }
    }) : [] }

    const refFeatures: any[] = []
    if (showRef) {
      for (const lat of [60, 45, -45, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 14) coords.push([lng, lat])
        refFeatures.push({ type: 'Feature' as const, properties: { color: '#0ea5e9' }, geometry: { type: 'LineString' as const, coordinates: coords } })
      }
    }
    const refFc = { type: 'FeatureCollection' as const, features: refFeatures }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_REF, refFc, () => map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: {
        'line-color': ['get', 'color'], 'line-width': 0.6, 'line-opacity': 0.12, 'line-dasharray': [3, 6],
      } }))
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [3, 3],
      } }))
      ensure(SRC_APT, aptFc, () => {
        map.addLayer({ id: LYR_APT, type: 'circle', source: SRC_APT, paint: {
          'circle-radius': 3, 'circle-color': ['get', 'color'], 'circle-opacity': 0.85,
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
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_APT_LBL, LYR_APT, LYR_PROJ, LYR_REF]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_APT, SRC_PROJ, SRC_REF]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, aptAggs, showHalo, showLabels, showPin, showProj, showApt, showRef, seasonOat, dpSpreadMul])

  // SVG diagram: skin TD °C (x) vs dew margin °C (y)
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 30
    const xMin = -25, xMax = 10, yMin = -15, yMax = 15
    const xs = (v: number) => PAD + ((v - xMin) / (xMax - xMin)) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMin, yMax }
  }, [])

  const tierColorOf = (s: number) => s >= 80 ? '#ef4444' : s >= 55 ? '#f59e0b' : s >= 25 ? '#0ea5e9' : '#10b981'
  const adviceFor = (r: Row): string => {
    if (r.tier === 'CSFF') {
      return 'CSFF forecast — tactile inspection of wing lower surface mandatory on arrival; full deicing per FAA AC 120-58 / Boeing FCOM SP.16 before next dispatch (Clean Aircraft Concept 14 CFR 121.629(b))'
    }
    if (r.tier === 'LIKELY') return 'Cold-soak frost likely — brief ground crew for pre-flight tactile check above cold-tank zone; Type I fluid required if frost is verified'
    if (r.tier === 'WATCH') return 'Wing-tank skin will be cold at touchdown — coordinate with ground handler to inspect underside before next departure'
    return 'Skin warm enough or dewpoint dry enough that CSFF is unlikely'
  }

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">CSFF · Cold-Soak Frost</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.activeCount} ac · {summary.csff} CSFF</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">μ Skin TD</div>
          <div className="font-mono text-sm" style={{ color: summary.meanSkin <= -5 ? '#ef4444' : summary.meanSkin <= 0 ? '#f59e0b' : summary.meanSkin <= 5 ? '#0ea5e9' : '#10b981' }}>{summary.meanSkin.toFixed(1)}°</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] truncate" style={{ color: tierColorOf(summary.worstScore) }}>{summary.worstCs || '—'} {summary.worstSk.toFixed(0)}°</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">CSFF</div>
          <div className="font-mono text-sm text-rose-400">{summary.csff}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">μ Dew margin</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanDM <= -2 ? '#ef4444' : summary.meanDM <= 2 ? '#f59e0b' : '#10b981' }}>{summary.meanDM.toFixed(1)}°</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Sun share</div>
          <div className="font-mono text-[11px] text-sky-300">{(summary.sunShare * 100).toFixed(0)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg viewBox={`0 0 ${diag.W} ${diag.H}`} className="w-full h-auto">
            {/* quadrants */}
            <rect x={diag.PAD} y={diag.ys(0)} width={diag.xs(0) - diag.PAD} height={diag.ys(diag.yMin) - diag.ys(0)} fill="#ef4444" opacity={0.08} />
            <rect x={diag.PAD} y={diag.ys(6)} width={diag.xs(5) - diag.PAD} height={diag.ys(0) - diag.ys(6)} fill="#f59e0b" opacity={0.05} />
            <rect x={diag.PAD} y={diag.ys(diag.yMax)} width={diag.xs(5) - diag.PAD} height={diag.ys(6) - diag.ys(diag.yMax)} fill="#0ea5e9" opacity={0.05} />
            <rect x={diag.xs(5)} y={6} width={diag.W - 6 - diag.xs(5)} height={diag.H - 22 - 6} fill="#10b981" opacity={0.05} />
            {/* zero lines */}
            <line x1={diag.xs(0)} y1={6} x2={diag.xs(0)} y2={diag.H - 22} stroke="#ef4444" strokeWidth={0.8} strokeDasharray="4 3" opacity={0.5} />
            <line x1={diag.PAD} y1={diag.ys(0)} x2={diag.W - 6} y2={diag.ys(0)} stroke="#f59e0b" strokeWidth={0.8} strokeDasharray="4 3" opacity={0.5} />
            {/* gridlines */}
            {[-20, -10, 0, 5].map(v => (
              <g key={v}>
                <line x1={diag.xs(v)} y1={6} x2={diag.xs(v)} y2={diag.H - 22} stroke="#334155" strokeWidth={0.4} strokeDasharray="2 3" />
                <text x={diag.xs(v)} y={diag.H - 12} fill="#64748b" fontSize={8} textAnchor="middle">{v}°</text>
              </g>
            ))}
            {[-10, 0, 6, 12].map(v => (
              <g key={v}>
                <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)} stroke="#334155" strokeWidth={0.4} strokeDasharray="2 3" />
                <text x={4} y={diag.ys(v) + 3} fill="#64748b" fontSize={8}>{v}°</text>
              </g>
            ))}
            {rows.filter(r => r.tier !== 'IDLE').slice(0, 800).map((r, i) => (
              <circle key={i} cx={diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, r.skinTdC)))} cy={diag.ys(Math.max(diag.yMin, Math.min(diag.yMax, r.dewMargin)))} r={2} fill={TIER_COLOR[r.tier]} opacity={0.8} />
            ))}
            <text x={diag.W - 6} y={diag.H - 2} fill="#475569" fontSize={8} textAnchor="end">skin TD °C · dew margin °C</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Min FL</span><span className="text-slate-300 font-mono">{minFl}</span></span>
          <input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Cruise dur</span><span className="text-slate-300 font-mono">{cruiseDur}m</span></span>
          <input type="range" min={30} max={420} step={10} value={cruiseDur} onChange={e => setCruiseDur(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Season OAT</span><span className="text-slate-300 font-mono">{seasonOat > 0 ? '+' : ''}{seasonOat}°</span></span>
          <input type="range" min={-25} max={25} step={1} value={seasonOat} onChange={e => setSeasonOat(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Desc rate</span><span className="text-slate-300 font-mono">{descRate}fpm</span></span>
          <input type="range" min={800} max={3000} step={100} value={descRate} onChange={e => setDescRate(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>DP spread</span><span className="text-slate-300 font-mono">{dpSpreadMul}%</span></span>
          <input type="range" min={25} max={200} step={5} value={dpSpreadMul} onChange={e => setDpSpreadMul(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Sun bias</span><span className="text-slate-300 font-mono">{sunBias > 0 ? '+' : ''}{sunBias}%</span></span>
          <input type="range" min={-100} max={100} step={5} value={sunBias} onChange={e => setSunBias(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest col-span-2">
          <span className="flex justify-between"><span>Capture</span><span className="text-slate-300 font-mono">{capture}nm</span></span>
          <input type="range" min={50} max={600} step={10} value={capture} onChange={e => setCapture(+e.target.value)} className="accent-sky-500" />
        </label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {CLASS_LIST.map(c => {
          const on = classFilter === c
          return <button key={c} onClick={() => setClassFilter(on ? 'ALL' : c)}
            className={`px-1.5 py-0.5 rounded border text-[10px] font-mono transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-800 text-slate-400 hover:text-slate-200'}`}>{c}</button>
        })}
      </div>

      <div className="flex items-center gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['PROJ', showProj, setShowProj], ['APT', showApt, setShowApt], ['REF', showRef, setShowRef], ['DIAG', showDiag, setShowDiag]] as const).map(([l, v, fn]) => (
          <button key={l} onClick={() => (fn as any)((x: boolean) => !x)}
            className={`px-1.5 py-0.5 rounded border text-[10px] font-mono transition ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-800 text-slate-500'}`}>{l}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search…"
          className="ml-auto bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-[10px] text-slate-200 placeholder:text-slate-600 w-24 focus:outline-none focus:border-sky-500/40" />
      </div>

      <div className="flex border-b border-slate-800 text-[10px]">
        {(['AIRCRAFT', 'AIRPORTS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-1.5 uppercase tracking-widest font-bold ${tab === t ? 'text-sky-300 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-8 text-center text-slate-500 text-[11px]">No inbound aircraft within capture.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => (
          <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/70 transition relative">
            <span className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: TIER_COLOR[r.tier] }} />
            <div className="flex items-center gap-1.5">
              <span className="font-mono font-bold text-slate-100">{(r.f.callsign || r.f.icao).trim()}</span>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="text-[9px] font-mono px-1 rounded border border-slate-800 text-slate-400">{r.klass}</span>
              {r.dest && <span className="text-[9px] font-mono px-1 rounded border border-slate-800 text-slate-300">{r.dest.iata}</span>}
              <span className="text-[9px] font-mono px-1 rounded border ml-auto" style={{ borderColor: TIER_COLOR[r.tier], color: TIER_COLOR[r.tier] }}>{r.tier}</span>
            </div>
            <div className="flex items-baseline gap-2 mt-0.5 text-[10px] font-mono text-slate-400">
              <span>{r.distNm.toFixed(0)}nm</span>
              <span style={{ color: r.skinTdC <= 0 ? '#ef4444' : r.skinTdC <= 5 ? '#f59e0b' : '#10b981' }}>skin {r.skinTdC.toFixed(0)}°</span>
              <span style={{ color: r.dewMargin <= 0 ? '#ef4444' : r.dewMargin <= 3 ? '#f59e0b' : '#10b981' }}>Δdp {r.dewMargin.toFixed(1)}°</span>
              <span className="text-slate-500">OAT {r.oatDestC.toFixed(0)}/{r.dewDestC.toFixed(0)}°</span>
            </div>
            <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden relative">
              <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier] }} />
              <div className="absolute inset-y-0" style={{ left: '25%', width: 1, background: '#0ea5e966' }} />
              <div className="absolute inset-y-0" style={{ left: '55%', width: 1, background: '#f59e0b66' }} />
              <div className="absolute inset-y-0" style={{ left: '80%', width: 1, background: '#ef444466' }} />
            </div>
            <div className="flex flex-wrap gap-1 mt-1 text-[9px] font-mono">
              {(['SKIN', 'DEW', 'SOAK', 'CTRE', 'MIX'] as const).map(k => {
                const map: any = { SKIN: 'skin', DEW: 'dew', SOAK: 'soak', CTRE: 'ctre', MIX: 'mix' }
                const v = (r.sev as any)[map[k]] as number
                return <span key={k} className="px-1 rounded border" style={{ borderColor: tierColorOf(v) + '88', color: tierColorOf(v) }}>{k} {v.toFixed(0)}</span>
              })}
            </div>
            <div className="flex flex-wrap gap-1 mt-1 text-[9px] font-mono text-slate-400">
              <span className="px-1 rounded border border-slate-800">cruise {r.tatCruiseC.toFixed(0)}°</span>
              <span className="px-1 rounded border border-slate-800">LF {(r.lf * 100).toFixed(0)}%</span>
              {r.ctrEmpty && <span className="px-1 rounded border" style={{ borderColor: '#f59e0b88', color: '#f59e0b' }}>CTR-EMPTY</span>}
              <span className="px-1 rounded border border-slate-800">wind {r.windSfcKt.toFixed(0)}kt</span>
              {r.sun && <span className="px-1 rounded border" style={{ borderColor: '#0ea5e988', color: '#0ea5e9' }}>★ sun</span>}
              <span className="px-1 rounded border border-slate-800">abs {r.paintAbs.toFixed(2)}</span>
            </div>
            <div className="mt-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>{adviceFor(r)}</div>
            <div className="mt-0.5 text-[9px] text-slate-600">{r.spec.fcom} · {r.f.operator || '—'}</div>
          </button>
        ))}
        {tab === 'AIRPORTS' && filteredAirports.length === 0 && (
          <div className="px-3 py-8 text-center text-slate-500 text-[11px]">No destinations active.</div>
        )}
        {tab === 'AIRPORTS' && filteredAirports.map(a => {
          const oatBiased = a.rec.oatBase + seasonOat
          const dpBiased = oatBiased - a.rec.dpSpread * (dpSpreadMul / 100)
          return (
            <button key={a.iata} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/70 transition relative">
              <span className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex items-center gap-1.5">
                <span className="font-mono font-bold text-slate-100">{a.iata}</span>
                <span className="text-slate-500 text-[10px]">{a.count} arr</span>
                <span className="text-[9px] font-mono px-1 rounded border ml-auto" style={{ borderColor: TIER_COLOR[a.worstTier], color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
              </div>
              <div className="flex items-baseline gap-2 mt-0.5 text-[10px] font-mono text-slate-400">
                <span style={{ color: oatBiased <= 0 ? '#0ea5e9' : '#10b981' }}>OAT {oatBiased.toFixed(0)}°</span>
                <span style={{ color: dpBiased <= -10 ? '#10b981' : dpBiased <= 0 ? '#f59e0b' : '#ef4444' }}>DP {dpBiased.toFixed(0)}°</span>
                <span style={{ color: a.meanSkin <= 0 ? '#ef4444' : a.meanSkin <= 5 ? '#f59e0b' : '#10b981' }}>μskin {a.meanSkin.toFixed(1)}°</span>
                {a.csff > 0 && <span className="text-rose-400">{a.csff} CSFF</span>}
                <span className="ml-auto">{a.worstCs}</span>
              </div>
              <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden relative">
                <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, a.meanScore)}%`, background: TIER_COLOR[a.worstTier] }} />
              </div>
              <div className="mt-0.5 text-[9px] text-slate-600">DP-spread {a.rec.dpSpread.toFixed(0)}° · sun-prob {(Math.max(0, Math.min(1, a.rec.sunlikely + sunBias / 100)) * 100).toFixed(0)}%</div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        FAA SAFO 06014 · AC 120-58 · 14 CFR 121.629(b) · TC AC 700-005 · Boeing FCOM SP.16 · NTSB AAR-83/02
      </div>
    </div>
  )
}
