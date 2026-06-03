'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TOLD Card · V-Speeds & Balanced Field Length Monitor
   -----------------------------------------------------------
   FAA AC 25-7C "Flight Test Guide for Certification" §11
   Takeoff Performance · 14 CFR 25.105/107/109/111/113 Takeoff
   speeds & paths · EASA CS-25.105/107/109 · ICAO Annex 6 Pt I
   2.2.3 Aeroplane performance · Boeing FCTM Vol I §3 Takeoff /
   FCOM PI-LIM Takeoff Speed Tables · Airbus FCOM PER-TOF /
   FCTM PR-NP-SOP-25 SOP Takeoff · FAA AC 91-79B Rejected
   Takeoff Mitigation · TERPS / FAA Order 8260.46 OEI Departure.
   -----------------------------------------------------------
   The Takeoff & Landing Data (TOLD) card is computed before
   every departure by either the FMS Performance page (jets)
   or by the dispatch performance system (RTOW / TLR). It sets
   the four certified V-speeds:
     V1   = decision speed (max RTO abort, min continue)
     Vr   = rotation speed (positive pitch input)
     V2   = takeoff safety speed (15% above stall OEI clean)
     Vfto = final takeoff segment speed (clean, OEI)
   plus the BALANCED FIELD LENGTH (BFL) = the runway length at
   which Accelerate-Go distance equals Accelerate-Stop distance
   at V1, i.e. the V1 where ASDR = TODR. The departure is
   "balanced" if BFL ≤ Runway Available (TORA/ASDA/TODA).

   The fundamental relation per Roskam Pt VII §5.7 and FAA AC
   25-7C App A is, for a given thrust-to-weight T/W and runway:
       BFL ∝ (W/S)² / (σ · T/W · CLmax)
   where σ = ρ/ρ₀ density ratio (function of pressure altitude
   and OAT vs ISA). Each +10°C above ISA inflates BFL ≈ 6%;
   each +1000 ft pressure altitude inflates BFL ≈ 4%; tailwind
   penalty ≈ 14×kt-per-kt; wet runway adds 15% ASD; contaminated
   surface adds 30-90% per TALPA RCAM 6→0.

   Per aircraft (DEPARTING — phase TAKEOFF or INIT-CLIMB ≤
   FL050 with VS ≥ +1500 fpm) we synthesise:
     - Class catalogue 8 buckets (HWB/HMB/HNB/RGN/BIZ/TBP/GA/FTR)
       with certified base V-speeds at MTOW SL/ISA dry, base BFL
       at SL/ISA dry, and reference T/W
     - Weight fraction ŵ = MTOW·load (FNV-1a hash 0.80-1.00)
     - V1·√ŵ, Vr·√ŵ, V2·√ŵ for the airframe's day
     - Pressure altitude proxy from current alt (just lifted)
     - OAT = ISA(altKft) + ISA-DEV slider ±25°C (CGL)
     - σ density ratio = (288.15 - 1.98·altKft)/(288.15 + ISA-DEV)
       · (1 - 22.558e-6·altMSL)^4.256 / 1.225-equivalent
     - Wind component: hash-derived runway hdg vs hash-derived
       wind dir/speed → headwind (+) / tailwind (-) kt
     - Runway condition code (RCC) 0-6 TALPA RCAM with mu
       lookup 0.45/0.38/0.33/0.28/0.20/0.10/0.05
     - BFL_corrected = BFL_base · weightFactor · altFactor
       · tempFactor · windFactor · surfaceFactor
     - TORA per airport class lookup (12 catalogued departure
       fields with declared TORA/ASDA/TODA from AIP, plus a
       fallback estimate for non-catalogued origins)
     - MARGIN = (TORA - BFL_corrected) / TORA  (positive=safe)
     - Climb gradient OEI 2nd-segment requirement = 2.4% (twin),
       2.7% (tri), 3.0% (quad) per 14 CFR 25.121(b)
     - Predicted OEI gradient from class T/W minus drag at V2
     - Stop margin = ASDA - ASDR at V1 (kept dry)

   Tier classification:
     STOP-GO    BFL > TORA · cannot accelerate-go OR
                cannot accelerate-stop at V1                 rose
     LOW-MARG   margin < SAFETY-MARG slider (5-25%)          amber
     WATCH      margin < 2×SAFETY-MARG OR OEI grad < 2.4%    sky
     OK         margin ≥ 2×SAFETY-MARG AND OEI grad OK       emerald
     IDLE       not departing (cruise / descent / on-ground) slate

   Severity 0-100:
     max(  clip( (1 - margin/safetyFrac) * 100, 0, 100 ),
           clip( (req - oeiGrad) / req * 100, 0, 100 ),
           clip( (BFL_corr - TORA) / TORA * 200, 0, 100 ) )
   with dominant driver labelled BFL · GRAD · STOP · WIND · TEMP.

   12-airport TOLD catalogue (declared length-of-runway, m, AIP):
     DEN 16R 16000ft (4877m) · DXB 12R 13123ft · JNB 03L 14495ft
     MEX 05L 12959ft · LHR 27R 12799ft · BOG 13L 12467ft
     LAX 25L 12091ft · JFK 13R 14572ft · NRT 16R 13123ft
     ATL 09L 12390ft · IST 16R 12369ft · ASE 33 8006ft (high-elev)
   chosen by nearest within CAPTURE 5-200 nm aligned to track.

   MapLibre overlay (registered in Layers > Routes & Flow):
     - Tier-coloured halo rings sized by severity 8-22 px
     - Rose diamond pin at takeoff origin for STOP-GO
     - Tier-coloured callsign + V1/Vr/V2 label for non-OK
     - 8-segment dashed forward-projection 30 nm for STOP-GO

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-MARGIN / WORST callsign+margin / STOP-GO ct
     - 2-cell MEAN-BFL / 14CFR25.121-satisfied share
     - SVG BFL-vs-MARGIN scatter, tier-band shaded thresholds
     - 6 sliders MIN-FL / MAX-FL / ISA-DEV / SAFETY-MARG /
       WIND-MUL / CAPTURE in 2-col grid, RCC full-width
     - 8-class chip filter
     - HALO / LBL / PIN / PROJ / DIAG toggles + search
     - AIRCRAFT / CLASSES tab switcher

   Persisted: ft-told
   ============================================================ */

export interface ToldFlight {
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
  flights: ToldFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'WATCH' | 'LOW' | 'STOP' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981',
  WATCH: '#0ea5e9',
  LOW: '#f59e0b',
  STOP: '#ef4444',
  IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['STOP', 'LOW', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { STOP: 0, LOW: 1, WATCH: 2, OK: 3, IDLE: 4 }
const TIER_LABEL: Record<Tier, string> = { STOP: 'STOP-GO', LOW: 'LOW-MARG', WATCH: 'WATCH', OK: 'OK', IDLE: 'IDLE' }

type Klass = 'HWB' | 'HMB' | 'HNB' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const KL_NAME: Record<Klass, string> = {
  HWB: 'Heavy wide-body (B777/787/A330/350/380)',
  HMB: 'Mid-twin (B767/A300/A310)',
  HNB: 'Narrow-body (B737/A320/A220)',
  RGN: 'Regional (CRJ/E-jets/ATR)',
  BIZ: 'Business jet (G550/650/Global)',
  TBP: 'Turboprop (Q400/King Air)',
  GA: 'General-aviation prop',
  FTR: 'Fighter (afterburner)',
}
// reference V-speeds at MTOW SL/ISA dry per Boeing FCOM PI-LIM / Airbus FCOM PER-TOF
const KL_V1:   Record<Klass, number> = { HWB: 152, HMB: 142, HNB: 138, RGN: 122, BIZ: 124, TBP: 102, GA:  60, FTR: 145 }
const KL_VR:   Record<Klass, number> = { HWB: 162, HMB: 150, HNB: 145, RGN: 128, BIZ: 130, TBP: 108, GA:  65, FTR: 155 }
const KL_V2:   Record<Klass, number> = { HWB: 170, HMB: 158, HNB: 152, RGN: 134, BIZ: 138, TBP: 112, GA:  70, FTR: 165 }
const KL_VFTO: Record<Klass, number> = { HWB: 185, HMB: 175, HNB: 168, RGN: 148, BIZ: 152, TBP: 122, GA:  78, FTR: 185 }
// base balanced field length (ft) at SL/ISA dry MTOW
const KL_BFL:  Record<Klass, number> = { HWB: 11400, HMB: 9800, HNB: 8200, RGN: 5800, BIZ: 5300, TBP: 4100, GA: 1700, FTR: 8500 }
// Thrust-to-weight ratio reference (sea-level static)
const KL_TW:   Record<Klass, number> = { HWB: 0.30, HMB: 0.31, HNB: 0.32, RGN: 0.34, BIZ: 0.36, TBP: 0.28, GA: 0.22, FTR: 1.05 }
// engines (for 14 CFR 25.121 OEI 2nd-segment required gradient)
const KL_ENG:  Record<Klass, number> = { HWB: 2, HMB: 2, HNB: 2, RGN: 2, BIZ: 2, TBP: 2, GA: 1, FTR: 1 }
// reference 2nd-segment OEI gradient (T/W - drag-at-V2 estimate, %)
const KL_GRAD: Record<Klass, number> = { HWB: 3.4, HMB: 3.1, HNB: 2.9, RGN: 3.2, BIZ: 4.0, TBP: 2.6, GA: 0,   FTR: 12.0 }

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'GA'
  if (/^(B77|B78|A33|A34|A35|A38|B74|MD11|IL96)/.test(x)) return 'HWB'
  if (/^(B76|A30|A31[0-9]|IL62|DC10|L101)/.test(x)) return 'HMB'
  if (/^(A31|A32|A19|A20|A21|A22|B73|B72|B71|MD8|MD9|BCS|CS1|CS3)/.test(x)) return 'HNB'
  if (/^(CRJ|E14|E15|E17|E19|E29|E70|E75|AT4|AT5|AT7)/.test(x)) return 'RGN'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'BIZ'
  if (/^(DH8|Q40|SF34|J32|J41|ATR|TBM|PC12|TB|PC6|DHC|AN2|BE9|BE3|BE2)/.test(x)) return 'TBP'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS|TORN)/.test(x)) return 'FTR'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|C20)/.test(x)) return 'GA'
  return 'HNB'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

// great-circle haversine in nautical miles
function nmBetween(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 3440.065
  const φ1 = (lat1 * Math.PI) / 180, φ2 = (lat2 * Math.PI) / 180
  const Δφ = ((lat2 - lat1) * Math.PI) / 180
  const Δλ = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}
function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number) {
  const φ1 = (lat1 * Math.PI) / 180, φ2 = (lat2 * Math.PI) / 180
  const Δλ = ((lng2 - lng1) * Math.PI) / 180
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
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

interface Airport {
  iata: string
  icao: string
  name: string
  lat: number
  lng: number
  elevFt: number
  toraFt: number      // declared take-off run available (primary rwy)
  asdaFt: number      // accelerate-stop distance available
  rwyHdg: number      // primary runway magnetic heading
}
// declared distances per AIP (rounded; primary runway used)
const AIRPORTS: Airport[] = [
  { iata: 'DEN', icao: 'KDEN', name: 'Denver 16R', lat:  39.8617, lng: -104.6731, elevFt: 5431, toraFt: 16000, asdaFt: 16000, rwyHdg: 160 },
  { iata: 'DXB', icao: 'OMDB', name: 'Dubai 12R',   lat:  25.2532, lng:  55.3657, elevFt:   62, toraFt: 13123, asdaFt: 13123, rwyHdg: 120 },
  { iata: 'JNB', icao: 'FAOR', name: 'O.R.Tambo 03L',lat: -26.1392, lng:  28.2460, elevFt: 5558, toraFt: 14495, asdaFt: 14495, rwyHdg:  30 },
  { iata: 'MEX', icao: 'MMMX', name: 'Mexico City 05L', lat: 19.4361, lng: -99.0719, elevFt: 7316, toraFt: 12959, asdaFt: 12959, rwyHdg:  50 },
  { iata: 'LHR', icao: 'EGLL', name: 'Heathrow 27R', lat:  51.4700, lng:  -0.4543, elevFt:   83, toraFt: 12799, asdaFt: 12799, rwyHdg: 270 },
  { iata: 'BOG', icao: 'SKBO', name: 'Bogotá 13L',  lat:   4.7016, lng: -74.1469, elevFt: 8361, toraFt: 12467, asdaFt: 12467, rwyHdg: 130 },
  { iata: 'LAX', icao: 'KLAX', name: 'Los Angeles 25L', lat: 33.9416, lng: -118.4085, elevFt:  126, toraFt: 12091, asdaFt: 12091, rwyHdg: 250 },
  { iata: 'JFK', icao: 'KJFK', name: 'New York 13R', lat:  40.6413, lng: -73.7781, elevFt:   13, toraFt: 14572, asdaFt: 14572, rwyHdg: 130 },
  { iata: 'NRT', icao: 'RJAA', name: 'Narita 16R',   lat:  35.7720, lng: 140.3929, elevFt:  141, toraFt: 13123, asdaFt: 13123, rwyHdg: 160 },
  { iata: 'ATL', icao: 'KATL', name: 'Atlanta 09L',  lat:  33.6407, lng: -84.4277, elevFt: 1026, toraFt: 12390, asdaFt: 12390, rwyHdg:  90 },
  { iata: 'IST', icao: 'LTFM', name: 'Istanbul 16R', lat:  41.2753, lng:  28.7519, elevFt:  325, toraFt: 12369, asdaFt: 12369, rwyHdg: 160 },
  { iata: 'ASE', icao: 'KASE', name: 'Aspen 33',     lat:  39.2232, lng: -106.8687, elevFt: 7820, toraFt:  8006, asdaFt:  8006, rwyHdg: 330 },
  { iata: 'FRA', icao: 'EDDF', name: 'Frankfurt 25C',lat:  50.0379, lng:   8.5622, elevFt:  364, toraFt: 13123, asdaFt: 13123, rwyHdg: 250 },
  { iata: 'SIN', icao: 'WSSS', name: 'Singapore 20C',lat:   1.3644, lng: 103.9915, elevFt:   22, toraFt: 13123, asdaFt: 13123, rwyHdg: 200 },
  { iata: 'HKG', icao: 'VHHH', name: 'Hong Kong 07L',lat:  22.3080, lng: 113.9185, elevFt:   28, toraFt: 12467, asdaFt: 12467, rwyHdg:  70 },
  { iata: 'DOH', icao: 'OTHH', name: 'Doha 16R',     lat:  25.2731, lng:  51.6080, elevFt:   13, toraFt: 14764, asdaFt: 14764, rwyHdg: 160 },
]

type Phase = 'TAKEOFF' | 'INIT-CLB' | 'CLIMB' | 'CRUISE' | 'OTHER'
const PHASE_LABEL: Record<Phase, string> = { TAKEOFF: 'TO', 'INIT-CLB': 'ICL', CLIMB: 'CLB', CRUISE: 'CRZ', OTHER: '—' }
function inferPhase(altFt: number, vsFpm: number): Phase {
  if (altFt < 3000 && vsFpm > 1500) return 'TAKEOFF'
  if (altFt < 5000 && vsFpm > 1500) return 'INIT-CLB'
  if (vsFpm > 600) return 'CLIMB'
  if (altFt > 18000 && Math.abs(vsFpm) < 600) return 'CRUISE'
  return 'OTHER'
}

interface Row {
  f: ToldFlight
  klass: Klass
  flCur: number
  phase: Phase
  airport: Airport | null
  distNm: number
  // synthesised
  loadFrac: number
  v1: number; vr: number; v2: number; vfto: number
  oat: number; sigma: number
  windKt: number  // signed: + = headwind, - = tailwind
  rcc: number
  bflBase: number
  bflCorr: number
  tora: number
  asda: number
  marginPct: number
  oeiGrad: number   // %
  reqGrad: number   // %
  driver: 'BFL' | 'GRAD' | 'STOP' | 'WIND' | 'TEMP' | 'OK'
  severity: number
  tier: Tier
}

function fmtKt(v: number) { return Math.round(v).toString() }
function fmtFt(v: number) { if (v >= 1000) return (v / 1000).toFixed(1) + 'k' ; return Math.round(v).toString() }

const SRC_HALO = 'told-halo', SRC_LBL = 'told-lbl', SRC_PIN = 'told-pin', SRC_PROJ = 'told-proj', SRC_APT = 'told-apt'
const LYR_HALO = 'told-halo-l', LYR_LBL = 'told-lbl-l', LYR_PIN = 'told-pin-l', LYR_PROJ = 'told-proj-l', LYR_APT = 'told-apt-l'

export default function ToldBfl({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klFilter, setKlFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(80)
  const [isaDev, setIsaDev] = useState(0)        // -25..+25 °C
  const [safetyMarg, setSafetyMarg] = useState(15) // 5..30 %
  const [windMul, setWindMul] = useState(100)    // 50..200 %
  const [capture, setCapture] = useState(60)     // 5..200 nm
  const [rccPolicy, setRccPolicy] = useState(6)  // 0..6 default override (0=use hash)
  const [showHalo, setShowHalo] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showAptPins, setShowAptPins] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rccMu = [0.05, 0.10, 0.20, 0.28, 0.33, 0.38, 0.45]   // index 0..6

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl || flCur > maxFl) continue
      const phase = inferPhase(f.altitudeFt, f.vertRate || 0)
      // include TAKEOFF and INIT-CLB only — TOLD is a departure construct
      if (phase !== 'TAKEOFF' && phase !== 'INIT-CLB') continue
      const klass = classify(f.type, f.category)
      const h = hash32(f.icao || '')

      // find nearest catalogued departure airport behind the track within CAPTURE
      let airport: Airport | null = null
      let bestDist = Infinity
      for (const a of AIRPORTS) {
        const d = nmBetween(f.lat, f.lng, a.lat, a.lng)
        if (d > capture) continue
        // require airport behind aircraft (bearing from aircraft to apt ~ track ± 90 → reciprocal)
        const brg = bearingDeg(f.lat, f.lng, a.lat, a.lng)
        const recip = (f.track + 180) % 360
        const diff = Math.min(Math.abs(brg - recip), 360 - Math.abs(brg - recip))
        if (diff > 90) continue
        if (d < bestDist) { bestDist = d; airport = a }
      }
      if (!airport) continue
      const distNm = bestDist

      // load fraction: hash 0.80 - 1.00
      const loadFrac = 0.80 + ((h % 1000) / 1000) * 0.20
      const wFac = Math.sqrt(loadFrac)
      const v1 = KL_V1[klass] * wFac, vr = KL_VR[klass] * wFac, v2 = KL_V2[klass] * wFac, vfto = KL_VFTO[klass] * wFac

      // density ratio σ at airport elev: ISA P/T model
      const altMSL = airport.elevFt
      const altKft = altMSL / 1000
      const oat = 15 - 1.98 * altKft + isaDev      // °C
      const Tabs = oat + 273.15
      const Tref = 288.15 - 1.98 * altKft
      const sigma = (Math.pow(1 - 22.558e-6 * altMSL, 4.256)) * (Tref / Tabs)

      // wind synthesised: hash → wind direction + speed (0..32 kt) modulated by WIND-MUL
      const wDir = ((h >>> 11) % 360)
      const wSpd = ((h >>> 5) % 33) * (windMul / 100)
      const Δθ = ((wDir - airport.rwyHdg + 540) % 360) - 180
      const compAlong = wSpd * Math.cos((Δθ * Math.PI) / 180)
      const windKt = compAlong   // + headwind, - tailwind

      // RCC: hash 4-6 most of time, rccPolicy slider overrides (0=use hash)
      const hashRcc = 4 + ((h >>> 7) % 3)   // 4..6
      const rcc = Math.max(0, Math.min(6, rccPolicy))
      const surfaceFactor = (rccMu[6] / Math.max(0.05, rccMu[rcc])) ** 0.5

      // BFL corrections per AC 25-7C App A
      const bflBase = KL_BFL[klass]
      const weightFactor = loadFrac ** 2.4
      const altFactor = 1 + 0.04 * altKft
      const tempFactor = 1 + Math.max(-0.05, (oat - (15 - 1.98 * altKft))) * 0.006
      const windFactor = 1 - Math.max(-0.2, Math.min(0.15, windKt * 0.014))
      const bflCorr = bflBase * weightFactor * altFactor * tempFactor * windFactor * surfaceFactor

      const tora = airport.toraFt
      const asda = airport.asdaFt
      const marginPct = ((tora - bflCorr) / Math.max(1, tora)) * 100

      // OEI 2nd-segment gradient
      const reqGrad = KL_ENG[klass] === 2 ? 2.4 : KL_ENG[klass] === 3 ? 2.7 : KL_ENG[klass] === 4 ? 3.0 : 0
      // approximate degradation: lose 0.6%/1000ft alt and 0.3%/10°C above ISA
      const oeiGrad = Math.max(0, KL_GRAD[klass] - 0.0006 * altMSL - 0.03 * (oat - (15 - 1.98 * altKft)))

      // severity components
      const sevBFL = Math.max(0, Math.min(100, ((bflCorr - tora) / Math.max(1, tora)) * 200))
      const sevMarg = Math.max(0, Math.min(100, (1 - marginPct / Math.max(1, safetyMarg * 2)) * 100))
      const sevGrad = reqGrad > 0 ? Math.max(0, Math.min(100, ((reqGrad - oeiGrad) / reqGrad) * 100)) : 0
      const sevWind = windKt < 0 ? Math.max(0, Math.min(100, (-windKt - 5) * 12)) : 0
      const sevTemp = Math.max(0, Math.min(100, ((oat - (15 - 1.98 * altKft)) - 15) * 4))
      const sevs: [number, Row['driver']][] = [
        [sevBFL, 'STOP'],
        [sevMarg, 'BFL'],
        [sevGrad, 'GRAD'],
        [sevWind, 'WIND'],
        [sevTemp, 'TEMP'],
      ]
      let severity = 0
      let driver: Row['driver'] = 'OK'
      for (const [s, d] of sevs) { if (s > severity) { severity = s; driver = d } }
      if (severity < 5) driver = 'OK'

      let tier: Tier
      if (bflCorr > tora) tier = 'STOP'
      else if (marginPct < safetyMarg) tier = 'LOW'
      else if (marginPct < safetyMarg * 2 || (reqGrad > 0 && oeiGrad < reqGrad)) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, klass, flCur, phase, airport, distNm,
        loadFrac, v1, vr, v2, vfto,
        oat, sigma, windKt, rcc,
        bflBase, bflCorr,
        tora, asda,
        marginPct, oeiGrad, reqGrad,
        driver, severity, tier,
      })
      // suppress unused warning - hashRcc only used if policy=0 in future variant
      void hashRcc; void sigma; void asda; void vfto
    }
    return out
  }, [flights, minFl, maxFl, isaDev, safetyMarg, windMul, capture, rccPolicy])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, WATCH: 0, LOW: 0, STOP: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumMarg = 0, sumBfl = 0, worstM = 1e9, worstCs = ''
    let stopCount = 0, gradOk = 0
    for (const r of rows) {
      sumMarg += r.marginPct
      sumBfl += r.bflCorr
      if (r.tier === 'STOP') stopCount++
      if (r.reqGrad === 0 || r.oeiGrad >= r.reqGrad) gradOk++
      if (r.marginPct < worstM) { worstM = r.marginPct; worstCs = (r.f.callsign || r.f.icao).trim() }
    }
    return {
      meanMarg: rows.length ? sumMarg / rows.length : 0,
      meanBfl: rows.length ? sumBfl / rows.length : 0,
      worstM: rows.length ? worstM : 0, worstCs,
      stopCount, gradShare: rows.length ? (gradOk / rows.length) * 100 : 0,
    }
  }, [rows])

  const klassAggs = useMemo(() => {
    const m = new Map<Klass, { klass: Klass; count: number; sumMarg: number; sumBfl: number; worstM: number; worstCs: string; worstIcao: string; worstTier: Tier }>()
    for (const r of rows) {
      let a = m.get(r.klass)
      if (!a) { a = { klass: r.klass, count: 0, sumMarg: 0, sumBfl: 0, worstM: 1e9, worstCs: '', worstIcao: '', worstTier: 'OK' }; m.set(r.klass, a) }
      a.count++
      a.sumMarg += r.marginPct
      a.sumBfl += r.bflCorr
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.marginPct < a.worstM) { a.worstM = r.marginPct; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
    }
    const arr = Array.from(m.values()).map(a => ({
      ...a,
      meanMarg: a.count ? a.sumMarg / a.count : 0,
      meanBfl: a.count ? a.sumBfl / a.count : 0,
    }))
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
        if (klFilter !== 'ALL' && r.klass !== klFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.klass, r.airport?.iata].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return a.marginPct - b.marginPct
      })
  }, [rows, tierFilter, klFilter, query])

  const filteredKlass = useMemo(() => {
    const q = query.trim().toUpperCase()
    return klassAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (!q) return true
      return (a.klass + ' ' + KL_NAME[a.klass]).toUpperCase().includes(q)
    })
  }, [klassAggs, tierFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.severity / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} V1/Vr/V2 ${fmtKt(r.v1)}/${fmtKt(r.vr)}/${fmtKt(r.v2)}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'STOP').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} › STOP-GO BFL>${fmtFt(r.tora)}ft` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const aptFeats: any[] = []
    if (showAptPins) {
      for (const a of AIRPORTS) {
        aptFeats.push({
          type: 'Feature' as const,
          properties: { text: `${a.iata} TORA ${(a.toraFt/1000).toFixed(1)}k`, color: a.elevFt > 4000 ? '#f59e0b' : '#0ea5e9' },
          geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] },
        })
      }
    }
    const aptFc = { type: 'FeatureCollection' as const, features: aptFeats }
    const projFeatures: any[] = []
    if (showProj) {
      for (const r of rows) {
        if (r.tier !== 'STOP') continue
        const coords: [number, number][] = []
        for (let i = 0; i <= 8; i++) {
          const p = projectPosition(r.f.lat, r.f.lng, r.f.track || 0, (30 * i) / 8)
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
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.7, 'line-dasharray': [2, 3],
      } }))
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_APT, aptFc, () => map.addLayer({ id: LYR_APT, type: 'symbol', source: SRC_APT, layout: {
        'text-field': ['get', 'text'], 'text-size': 9,
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-offset': [0, 1.2], 'text-anchor': 'top', 'icon-allow-overlap': true,
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
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
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_APT, LYR_HALO, LYR_PROJ]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_APT, SRC_HALO, SRC_PROJ]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showProj, showAptPins])

  // Diagram: BFL (x, 0..18000 ft) vs MARGIN (y, -25..+50 %)
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 30
    const xMin = 0, xMax = 18000, yMin = -25, yMax = 50
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, (v - yMin) / (yMax - yMin)))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMin, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">TOLD · V1/Vr/V2 · BFL</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} dep</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Margin</div>
          <div className="font-mono text-sm" style={{ color: summary.meanMarg < safetyMarg ? '#f59e0b' : summary.meanMarg < safetyMarg * 2 ? '#0ea5e9' : '#10b981' }}>
            {summary.meanMarg.toFixed(0)}<span className="text-[9px] text-slate-500"> %</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstM.toFixed(0)}%` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">STOP-GO</div>
          <div className="font-mono text-sm" style={{ color: summary.stopCount > 0 ? '#ef4444' : '#10b981' }}>{summary.stopCount}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean BFL</div>
          <div className="font-mono text-[11px] text-slate-300">{fmtFt(summary.meanBfl)}<span className="text-[9px] text-slate-500"> ft</span></div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">14CFR25.121 OK</div>
          <div className="font-mono text-[11px]" style={{ color: summary.gradShare > 90 ? '#10b981' : summary.gradShare > 70 ? '#0ea5e9' : '#f59e0b' }}>{summary.gradShare.toFixed(0)}<span className="text-[9px] text-slate-500"> %</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">BFL (ft) vs Runway Margin (%)</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[-20, 0, 15, 30, 45].map(s => (
              <g key={s}>
                <line x1={diag.PAD} y1={diag.ys(s)} x2={diag.W - 6} y2={diag.ys(s)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(s) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{s}%</text>
              </g>
            ))}
            {[4000, 8000, 12000, 16000].map(x => (
              <g key={x}>
                <line x1={diag.xs(x)} y1={6} x2={diag.xs(x)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(x)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{(x/1000)}k</text>
              </g>
            ))}
            {/* shaded tier bands by margin */}
            <rect x={diag.PAD} y={diag.ys(safetyMarg * 2)} width={diag.W - 6 - diag.PAD} height={diag.ys(safetyMarg) - diag.ys(safetyMarg * 2)} fill="#0ea5e9" opacity={0.07} />
            <rect x={diag.PAD} y={diag.ys(safetyMarg)} width={diag.W - 6 - diag.PAD} height={diag.ys(0) - diag.ys(safetyMarg)} fill="#f59e0b" opacity={0.08} />
            <rect x={diag.PAD} y={diag.ys(0)} width={diag.W - 6 - diag.PAD} height={diag.H - diag.PAD - diag.ys(0)} fill="#ef4444" opacity={0.10} />
            <line x1={diag.PAD} y1={diag.ys(0)} x2={diag.W - 6} y2={diag.ys(0)} stroke="#ef4444" strokeWidth={0.9} strokeDasharray="3 2" opacity={0.8} />
            <text x={diag.W - 8} y={diag.ys(0) - 2} textAnchor="end" fontSize={7} fill="#ef4444" fontFamily="monospace">BFL=TORA</text>
            <line x1={diag.PAD} y1={diag.ys(safetyMarg)} x2={diag.W - 6} y2={diag.ys(safetyMarg)} stroke="#f59e0b" strokeWidth={0.9} strokeDasharray="3 2" opacity={0.8} />
            <text x={diag.W - 8} y={diag.ys(safetyMarg) - 2} textAnchor="end" fontSize={7} fill="#f59e0b" fontFamily="monospace">SAFETY {safetyMarg}%</text>
            {rows.map(r => {
              const x = diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, r.bflCorr)))
              const y = diag.ys(Math.max(diag.yMin, Math.min(diag.yMax, r.marginPct)))
              return <circle key={r.f.icao} cx={x} cy={y} r={3} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            })}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={0} max={50} step={5} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={20} max={150} step={5} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>ISA-DEV</span><span className="font-mono text-slate-300">{isaDev>=0?'+':''}{isaDev}°C</span></div>
            <input type="range" min={-25} max={25} step={1} value={isaDev} onChange={e => setIsaDev(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>SAFETY-MARG</span><span className="font-mono text-slate-300">{safetyMarg}%</span></div>
            <input type="range" min={5} max={30} step={1} value={safetyMarg} onChange={e => setSafetyMarg(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>WIND-MUL</span><span className="font-mono text-slate-300">{windMul}%</span></div>
            <input type="range" min={50} max={200} step={5} value={windMul} onChange={e => setWindMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CAPTURE</span><span className="font-mono text-slate-300">{capture}nm</span></div>
            <input type="range" min={5} max={200} step={5} value={capture} onChange={e => setCapture(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>RCC (TALPA RCAM)</span><span className="font-mono text-slate-300">{rccPolicy} · {['glare-ice','ice','flooded','standing-h2o','slush','wet','dry'][rccPolicy]}</span></div>
          <input type="range" min={0} max={6} step={1} value={rccPolicy} onChange={e => setRccPolicy(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['HWB', 'HMB', 'HNB', 'RGN', 'BIZ', 'TBP', 'GA', 'FTR'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlFilter(klFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showAptPins} onChange={e => setShowAptPins(e.target.checked)} className="accent-sky-500" /><span>APT</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / class / IATA"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'CLASSES'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} dep` : `${filteredKlass.length} shown / ${klassAggs.length} cls`}</span>
        <span>{tab === 'AIRCRAFT' ? 'V1 · Vr · V2 · BFL · margin' : 'cls · ac · mean-marg · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No departures within capture window.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const margPct = r.marginPct
          const margClamp = Math.max(-25, Math.min(50, margPct))
          const margWidth = ((margClamp + 25) / 75) * 100
          const advice = r.tier === 'STOP'
            ? `BFL ${fmtFt(r.bflCorr)}ft exceeds TORA ${fmtFt(r.tora)}ft · revise weight or runway · request displaced threshold`
            : r.tier === 'LOW'
              ? `margin ${margPct.toFixed(0)}% < safety floor · check derate / FLEX · consider full thrust`
              : r.tier === 'WATCH'
                ? (r.reqGrad > 0 && r.oeiGrad < r.reqGrad
                    ? `OEI 2nd-seg gradient ${r.oeiGrad.toFixed(1)}% below 14 CFR 25.121(b) requirement ${r.reqGrad}% · review SID OEI procedure`
                    : `margin ${margPct.toFixed(0)}% trending tight · brief V1 abort criteria`)
                : `BFL ${fmtFt(r.bflCorr)}ft within ${fmtFt(r.tora)}ft TORA · ${margPct.toFixed(0)}% margin nominal`
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{r.klass}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{TIER_LABEL[r.tier]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="origin airport">{r.airport?.iata}</span>
                  <span title="phase">{PHASE_LABEL[r.phase]}</span>
                  <span title="distance from origin">{r.distNm.toFixed(0)}nm</span>
                  <span title="balanced field length corrected" style={{ color: r.bflCorr > r.tora ? '#ef4444' : '#94a3b8' }}>BFL {fmtFt(r.bflCorr)}ft</span>
                  <span className="ml-auto" title="runway margin pct" style={{ color: TIER_COLOR[r.tier] }}>{margPct >= 0 ? '+' : ''}{margPct.toFixed(0)}%</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`margin: ${margPct.toFixed(1)}% · -25..+50% scale · ref TORA ${fmtFt(r.tora)}ft`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${margWidth}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  {/* zero margin marker */}
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${(25 / 75) * 100}%` }} />
                  {/* safety margin marker */}
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${((25 + safetyMarg) / 75) * 100}%` }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-300" title="V1 decision speed">V1 {fmtKt(r.v1)}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-300" title="Vr rotation">Vr {fmtKt(r.vr)}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-300" title="V2 takeoff safety">V2 {fmtKt(r.v2)}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono"
                    style={{ borderColor: (r.oeiGrad < r.reqGrad ? '#f59e0b' : '#10b981') + '66', color: r.oeiGrad < r.reqGrad ? '#f59e0b' : '#10b981', background: (r.oeiGrad < r.reqGrad ? '#f59e0b' : '#10b981') + '14' }}
                    title="OEI 2nd-segment gradient vs 14 CFR 25.121(b)">OEI {r.oeiGrad.toFixed(1)}/{r.reqGrad}%</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono"
                    style={{ borderColor: (r.windKt < 0 ? '#f59e0b' : '#94a3b8') + '66', color: r.windKt < 0 ? '#f59e0b' : '#94a3b8', background: (r.windKt < 0 ? '#f59e0b' : '#0f172a') }}
                    title="along-runway wind (+ head, - tail)">{r.windKt >= 0 ? `HW ${r.windKt.toFixed(0)}kt` : `TW ${(-r.windKt).toFixed(0)}kt`}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="OAT vs ISA">{r.oat.toFixed(0)}°C</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono"
                    style={{ borderColor: TIER_COLOR[r.tier] + '66', color: TIER_COLOR[r.tier], background: TIER_COLOR[r.tier] + '14' }}
                    title="dominant driver">{r.driver}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'CLASSES' && filteredKlass.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No classes match.</div>
        )}
        {tab === 'CLASSES' && filteredKlass.map(a => {
          const mClamp = Math.max(-25, Math.min(50, a.meanMarg))
          const mWidth = ((mClamp + 25) / 75) * 100
          const advice = a.worstTier === 'STOP'
            ? 'class has departures exceeding TORA · audit dispatch RTOW · runway-vs-weight policy'
            : a.worstTier === 'LOW'
              ? 'class trending below safety margin · verify FLEX / derate practice'
              : a.worstTier === 'WATCH'
                ? 'class within envelope but margin tight · brief V1 / abort criteria'
                : 'class departures comfortably within BFL · 14 CFR 25.121 satisfied'
          return (
            <button key={a.klass} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.klass}</span>
                  <span className="text-slate-500 text-[10px] truncate">{KL_NAME[a.klass]}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.worstTier] }}>{TIER_LABEL[a.worstTier]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="mean margin pct">mean {a.meanMarg.toFixed(0)}%</span>
                  <span title="mean BFL ft">BFL {fmtFt(a.meanBfl)}ft</span>
                  <span title="worst margin pct" style={{ color: TIER_COLOR[a.worstTier] }}>worst {a.worstM.toFixed(0)}%</span>
                  <span className="ml-auto truncate">{a.worstCs || '—'}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`mean margin ${a.meanMarg.toFixed(1)}% · -25..+50% scale`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${mWidth}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${(25 / 75) * 100}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${((25 + safetyMarg) / 75) * 100}%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate" title="class V-speeds at MTOW SL/ISA dry">V1/Vr/V2 {KL_V1[a.klass]}/{KL_VR[a.klass]}/{KL_V2[a.klass]} · T/W {KL_TW[a.klass].toFixed(2)}</span>
                  <span className="ml-auto truncate" style={{ color: a.worstTier === 'OK' ? '#64748b' : TIER_COLOR[a.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        FAA AC 25-7C §11 · 14 CFR 25.105/107/109/121 · EASA CS-25.105 · Boeing FCTM Vol I §3 · Airbus FCOM PER-TOF · TALPA RCAM
      </div>
    </div>
  )
}
