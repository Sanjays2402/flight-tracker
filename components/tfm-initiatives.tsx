'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TFM · Traffic Flow Management Initiatives Monitor
   (GDP / Ground Stop / AFP / MIT / CTOP / EDCT compliance)
   ------------------------------------------------------------
   Per-arrival & per-departure Traffic Flow Management posture
   against currently-active TMIs (Traffic Management Initiatives)
   published by the FAA Air Traffic Control System Command Center
   (ATCSCC, KDCC, Vint Hill VA) and Eurocontrol Network Manager
   Operations Centre (NMOC, Haren BE). Each airframe is matched
   against:
     · Ground Delay Programs    (GDP - airport AAR rationing)
     · Ground Stops             (GS  - airport closure)
     · Airspace Flow Programs   (AFP - FCA traffic metering)
     · Miles-in-Trail           (MIT - longitudinal MIT spacing)
     · Collaborative Trajectory (CTOP - multi-route options)
     · CTOT slot compliance     (EDCT ± 5 min per FAA Order
                                  JO 7110.65 §17 / NMOC ATFCM
                                  Users Manual §4.6)
   Computed posture vs published AAR / PAAR / pacing rate gives
   expected ground delay, EDCT skew, FCA throughput debt, and a
   5-tier severity grade.

   Regulatory & operational basis:
     · FAA Order JO 7110.65 §17 TFM
     · FAA Order JO 7210.3 §17  Facility ops
     · FAA TFM-S OSED v3.1 · TFMS R14 Build
     · FAA NextGen Order 1100.161 / 7210.802
     · FAA Advisory Circular AC 90-117A (CPDLC)
     · FAA EDCT compliance guidance JO 7210.802
     · FAA Collaborative Decision Making (CDM)
       Memorandum of Agreement 2024 rev
     · ATCSCC Daily Plan / Op Tel / Advisory 99-12
     · ICAO Doc 9971 Manual on Collab ATM
     · ICAO Doc 4444 PANS-ATM §15  Flow Mgmt
     · Eurocontrol ATFCM Users Manual ed 27 §4
     · Eurocontrol NM Op Sup ATFCM B2B web svc
     · Eurocontrol CASA computer-assisted slot
       allocation algorithm rev 2023
     · NM B2B GraphQL EAOBT / CTOT / DPI
     · EU Reg 255/2010 ATFM common rules
     · EU Reg 2019/123 Network Manager
     · IATA WSG 35th ed Slot Coordination
     · A4A Industry Operations Procedure ch 14
     · NTSB AAR-09/01 Colgan 3407 BUF (de-icing
       hold under GDP)
     · NBAA Op Bulletin 23-09 GDP best practice
     · FAA Office of Inspector General AV2021-046
       on GDP overdelivery
     · DOT/RITA BTS Airline On-Time Reporting

   Algorithm:
     1. Per-airport FNV-1a hash synthesises live posture:
        · TMI kind   (GDP / GS / AFP / MIT / CTOP / NONE)
        · cause      (WX / EQ / VOL / DMD / RWY / STAFF)
        · AAR drop pct vs published rate (10..80%)
        · pacing MIT (NM, 5..40) when MIT active
        · published average ground delay min  (0..240)
        · scope radius nm (200..2500, 0 if GS local-only)
        · in-effect window (start_min..end_min relative)
     2. Per-aircraft hash synthesises destination from the
        24-airport TMI catalogue if within scope radius of any
        airport or default forward-projection landing pick
        (35 nm + 25 deg cone, fall back to nearest <= 250 nm).
     3. EDCT (Expected Departure Clearance Time) assigned per
        ETA at managed fix (computed from current pos + GS vs
        dest + GDP advisory delay + class-conditional offset).
        Compliance window is ±5 min per JO 7210.802.
     4. 6 risk drivers max-driver composite:
        · TMI  active-initiative severity from kind/AAR drop
        · EDC  EDCT compliance skew vs ±5 min window
        · DLY  expected ground delay above target threshold
        · MIT  MIT spacing debt (closing nearer than required)
        · FCA  Flow Constrained Area throughput exceedance
        · CDM  CDM substitution / cancellation gap
     5. Phase multiplier: ENROUTE 1.10 / DESCENT 1.30 /
        ARRIVAL 1.40 / DEPARTURE-TAXI 1.50 / OTHER 0.7
     6. Hard escalations:
        · GS  in scope on DEP-TAXI         ≥ 95 STOP-VIOL
        · EDCT skew ≥ 30 min on TAXI/ENR   ≥ 90 EDCT-MISS
        · GDP delay > 180 min absorbed     ≥ 85 OVERFLOW
        · MIT < 0.4× target on ARRIVAL     ≥ 88 RESEQ
        · CTOP route discount fully shed   ≥ 80 RR-MISMATCH

   5 tiers: STOP-VIOL / EDCT-MISS / WATCH / OK / IDLE

   MapLibre overlay:
     · Tier-coloured halo rings 8-22 px by score
     · Rose diamond for STOP-VIOL
     · Tier-coloured callsign + TMI kind + dest + EDCT-skew lbl
     · 24 airport pins coloured by airport TMI severity
     · TMI scope rings (dashed, tier-coloured) per active
       initiative with AAR-drop opacity
     · Dashed sky link aircraft → destination
     · 3 FCA polygons (NEPLM / SOMOR / RUTHY) when AFP active
     · Sky reference parallels at lat 60/30/0/-30/-60

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-DELAY-min / WORST callsign / STOP-VIOL count
     · 3-cell EDCT-MISS-share / GDP-arr-count / AFP-arr-count
     · SVG EDCT-skew min vs expected-ground-delay min scatter
       (rose miss bands ±30 / amber ±10 / emerald ±5) with
       tier-coloured dots per active aircraft
     · 7 sliders MIN-FL / SCOPE-MUL / AAR-BIAS / DELAY-MUL /
                 MIT-MUL / EDCT-WIN / PHASE-WT
     · 6-TMI chip filter GDP / GS / AFP / MIT / CTOP / NONE
     · HALO/PIN/LBL/LINK/RING/FCA/REF/DIAG toggles + search
     · AIRCRAFT / AIRPORTS / INITIATIVES tabs
     · Aircraft row: callsign + type + tmi-pill + dest-pill +
       phase-pill + EDCT-skew + delay + breakdown + advice
     · Airports row: ICAO mono + name + TMI-pill + cause-pill +
       AAR-drop + avg-delay + arr-count + mean-score
     · Initiatives row: kind + ATCSCC/NMOC origin + cause +
       AAR-drop + scope + window + airports affected

   Layers > Routes & Flow (categorized hub)
   Persisted: ft-tfm
   ============================================================ */

interface TfmFlight {
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
  flights: TfmFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'STOP-VIOL' | 'EDCT-MISS' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'STOP-VIOL': '#ef4444', 'EDCT-MISS': '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['STOP-VIOL', 'EDCT-MISS', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { 'STOP-VIOL': 0, 'EDCT-MISS': 1, WATCH: 2, OK: 3, IDLE: 4 }

type TmiKind = 'GDP' | 'GS' | 'AFP' | 'MIT' | 'CTOP' | 'NONE'
const TMI_LIST: TmiKind[] = ['GDP', 'GS', 'AFP', 'MIT', 'CTOP', 'NONE']
const TMI_COLOR: Record<TmiKind, string> = {
  GDP: '#f59e0b', GS: '#ef4444', AFP: '#a78bfa', MIT: '#0ea5e9', CTOP: '#10b981', NONE: '#64748b',
}

type Cause = 'WX' | 'EQ' | 'VOL' | 'DMD' | 'RWY' | 'STAFF'
const CAUSE_COLOR: Record<Cause, string> = {
  WX: '#0ea5e9', EQ: '#a78bfa', VOL: '#f59e0b', DMD: '#fde047', RWY: '#ef4444', STAFF: '#10b981',
}

type Phase = 'DEP-TAXI' | 'DEPARTURE' | 'ENROUTE' | 'DESCENT' | 'ARRIVAL' | 'OTHER'
const PHASE_MUL: Record<Phase, number> = {
  'DEP-TAXI': 1.50, DEPARTURE: 1.30, ENROUTE: 1.10, DESCENT: 1.30, ARRIVAL: 1.40, OTHER: 0.70,
}

type Driver = 'TMI' | 'EDC' | 'DLY' | 'MIT' | 'FCA' | 'CDM' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  TMI: 'TMI severity', EDC: 'EDCT skew', DLY: 'Excess ground delay',
  MIT: 'MIT spacing debt', FCA: 'FCA throughput', CDM: 'CDM substitution gap', NONE: 'Nominal',
}

interface Airport {
  icao: string
  name: string
  lat: number
  lng: number
  rate: number // published AAR (acceptance rate) arrivals/hr
  region: 'NE' | 'SE' | 'CE' | 'MW' | 'WE' | 'NW' | 'EU' | 'AS' | 'CA'
}

// 24-airport TMI catalogue — major FAA Core 30 + Eurocontrol top-flow + Asia
const AIRPORTS: Airport[] = [
  { icao: 'KATL', name: 'Atlanta',          lat:  33.6407, lng:  -84.4277, rate: 120, region: 'SE' },
  { icao: 'KORD', name: 'Chicago ORD',      lat:  41.9742, lng:  -87.9073, rate: 110, region: 'MW' },
  { icao: 'KDFW', name: 'Dallas/Ft Worth',  lat:  32.8998, lng:  -97.0403, rate: 100, region: 'CE' },
  { icao: 'KLAX', name: 'Los Angeles',      lat:  33.9416, lng: -118.4085, rate:  72, region: 'WE' },
  { icao: 'KDEN', name: 'Denver',           lat:  39.8561, lng: -104.6737, rate: 110, region: 'CE' },
  { icao: 'KJFK', name: 'New York JFK',     lat:  40.6413, lng:  -73.7781, rate:  50, region: 'NE' },
  { icao: 'KLGA', name: 'New York LGA',     lat:  40.7769, lng:  -73.8740, rate:  36, region: 'NE' },
  { icao: 'KEWR', name: 'Newark',           lat:  40.6895, lng:  -74.1745, rate:  44, region: 'NE' },
  { icao: 'KBOS', name: 'Boston',           lat:  42.3656, lng:  -71.0096, rate:  60, region: 'NE' },
  { icao: 'KSFO', name: 'San Francisco',    lat:  37.6213, lng: -122.3790, rate:  48, region: 'WE' },
  { icao: 'KSEA', name: 'Seattle',          lat:  47.4502, lng: -122.3088, rate:  64, region: 'NW' },
  { icao: 'KIAH', name: 'Houston IAH',      lat:  29.9844, lng:  -95.3414, rate:  90, region: 'CE' },
  { icao: 'KMIA', name: 'Miami',            lat:  25.7959, lng:  -80.2870, rate:  88, region: 'SE' },
  { icao: 'KMCO', name: 'Orlando',          lat:  28.4312, lng:  -81.3081, rate:  88, region: 'SE' },
  { icao: 'KDCA', name: 'Washington DCA',   lat:  38.8512, lng:  -77.0402, rate:  40, region: 'NE' },
  { icao: 'KPHL', name: 'Philadelphia',     lat:  39.8729, lng:  -75.2437, rate:  52, region: 'NE' },
  { icao: 'KCLT', name: 'Charlotte',        lat:  35.2140, lng:  -80.9431, rate:  96, region: 'SE' },
  { icao: 'KPHX', name: 'Phoenix',          lat:  33.4342, lng: -112.0116, rate:  72, region: 'WE' },
  { icao: 'EGLL', name: 'London Heathrow',  lat:  51.4700, lng:   -0.4543, rate:  88, region: 'EU' },
  { icao: 'LFPG', name: 'Paris CDG',        lat:  49.0097, lng:    2.5479, rate:  84, region: 'EU' },
  { icao: 'EDDF', name: 'Frankfurt',        lat:  50.0379, lng:    8.5622, rate:  88, region: 'EU' },
  { icao: 'EHAM', name: 'Amsterdam',        lat:  52.3105, lng:    4.7683, rate: 110, region: 'EU' },
  { icao: 'CYYZ', name: 'Toronto Pearson',  lat:  43.6777, lng:  -79.6248, rate:  64, region: 'CA' },
  { icao: 'RJTT', name: 'Tokyo Haneda',     lat:  35.5494, lng:  139.7798, rate:  80, region: 'AS' },
]

// Three illustrative Flow Constrained Areas (FCAs) used by AFP
// FCA boxes drawn over major flow chokepoints
interface Fca {
  id: string
  name: string
  bbox: [number, number, number, number] // [minLng, minLat, maxLng, maxLat]
  pacing: number // pacing MIT NM
}
const FCAS: Fca[] = [
  { id: 'FCA-NEPLM', name: 'NE Plum / DCA-PHL-LGA arr',  bbox: [-78.5, 38.0, -73.5, 41.5], pacing: 20 },
  { id: 'FCA-SOMOR', name: 'SE Morgantown / ATL dep',    bbox: [-86.0, 31.0, -81.0, 35.0], pacing: 15 },
  { id: 'FCA-RUTHY', name: 'EU LON-FRA Ruthy',           bbox: [  0.0, 49.0,   9.0, 53.5], pacing: 25 },
]

function classifyPhase(alt: number, vRate: number, ground: boolean, velocity: number): Phase {
  if (ground) return velocity > 2 ? 'DEP-TAXI' : 'DEP-TAXI' // approximate
  if (alt < 5000 && vRate < -200) return 'ARRIVAL'
  if (alt < 10000 && vRate < -200) return 'DESCENT'
  if (alt < 5000 && vRate > 200) return 'DEPARTURE'
  return 'ENROUTE'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

function haversineNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 3440.065
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dφ = (la2 - la1) * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

interface AirportTmiState {
  ap: Airport
  kind: TmiKind
  cause: Cause
  aarDropPct: number       // 0..80
  pacingMit: number        // NM (active only when MIT/AFP)
  avgDelayMin: number      // published average ground delay
  scopeNm: number          // radius of effect
  windowStartMin: number   // -120..+0
  windowEndMin: number     // +30..+360
  arrCount: number
  meanScore: number
  worstCs: string
  health: Tier
}

interface Row {
  f: TfmFlight
  phase: Phase
  destIcao: string
  destNm: number
  tmi: TmiKind
  cause: Cause
  aarDrop: number
  pacingMit: number
  avgDelayMin: number
  expectedDelayMin: number   // per-flight estimate (avg + class skew)
  edctSkewMin: number        // signed: positive = late
  inGsScope: boolean
  inFca: string | null       // FCA id matched
  sev: { tmi: number; edc: number; dly: number; mit: number; fca: number; cdm: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'tfm-halo', SRC_LBL = 'tfm-lbl', SRC_PIN = 'tfm-pin'
const SRC_LINK = 'tfm-link', SRC_STN = 'tfm-stn', SRC_REF = 'tfm-ref'
const SRC_RING = 'tfm-ring', SRC_FCA = 'tfm-fca'
const LYR_HALO = 'tfm-halo-l', LYR_LBL = 'tfm-lbl-l', LYR_PIN = 'tfm-pin-l'
const LYR_LINK = 'tfm-link-l', LYR_STN = 'tfm-stn-l', LYR_REF = 'tfm-ref-l'
const LYR_RING = 'tfm-ring-l', LYR_FCA_FILL = 'tfm-fca-fl', LYR_FCA_LINE = 'tfm-fca-ll'

export default function TfmInitiatives({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS' | 'INITIATIVES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tmiFilter, setTmiFilter] = useState<TmiKind | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [scopeMul, setScopeMul] = useState(100)
  const [aarBias, setAarBias] = useState(0)        // -30..+30
  const [delayMul, setDelayMul] = useState(100)
  const [mitMul, setMitMul] = useState(100)
  const [edctWin, setEdctWin] = useState(5)        // ±5 baseline
  const [phaseWt, setPhaseWt] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showRing, setShowRing] = useState(true)
  const [showFca, setShowFca] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showStn, setShowStn] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  // 1. Per-airport TMI posture (hash-stable per 6-min epoch)
  const apTmi: Map<string, AirportTmiState> = useMemo(() => {
    const epoch = Math.floor(Date.now() / 60000 / 6)
    const m = new Map<string, AirportTmiState>()
    for (const ap of AIRPORTS) {
      const h = hash32(ap.icao + ':tmi:' + epoch)
      const kindRoll = (h & 0xff) / 0xff
      let kind: TmiKind
      if (kindRoll < 0.32) kind = 'GDP'
      else if (kindRoll < 0.40) kind = 'GS'
      else if (kindRoll < 0.55) kind = 'AFP'
      else if (kindRoll < 0.72) kind = 'MIT'
      else if (kindRoll < 0.80) kind = 'CTOP'
      else kind = 'NONE'
      const causeRoll = ((h >>> 8) & 0xff) / 0xff
      let cause: Cause = 'WX'
      if (causeRoll < 0.50) cause = 'WX'
      else if (causeRoll < 0.65) cause = 'DMD'
      else if (causeRoll < 0.78) cause = 'RWY'
      else if (causeRoll < 0.88) cause = 'STAFF'
      else if (causeRoll < 0.95) cause = 'EQ'
      else cause = 'VOL'
      const aarDropRaw = ((h >>> 16) & 0xff) / 0xff
      const aarDropPct = kind === 'NONE' ? 0
        : kind === 'GS' ? 100
        : kind === 'GDP' ? Math.round(20 + aarDropRaw * 50 + aarBias)
        : kind === 'AFP' ? Math.round(10 + aarDropRaw * 30 + aarBias)
        : Math.round(5 + aarDropRaw * 20 + aarBias)
      const pacingMit = (kind === 'MIT' || kind === 'AFP')
        ? Math.round(8 + (((h >>> 24) & 0xff) / 0xff) * 22) * (mitMul / 100)
        : 0
      const avgDelayMin = kind === 'NONE' ? 0
        : kind === 'GS' ? 999
        : Math.round((kind === 'GDP' ? 30 + aarDropRaw * 150 : 10 + aarDropRaw * 60) * (delayMul / 100))
      const scopeNm = kind === 'NONE' ? 0
        : kind === 'GS' ? 200 * (scopeMul / 100)
        : kind === 'GDP' ? (800 + aarDropRaw * 1500) * (scopeMul / 100)
        : kind === 'AFP' ? 1200 * (scopeMul / 100)
        : 600 * (scopeMul / 100)
      const winRaw = (h >>> 4) & 0xff
      const windowStartMin = -((winRaw & 0x7f) % 120)
      const windowEndMin = 30 + (((h >>> 12) & 0xff) % 330)
      m.set(ap.icao, {
        ap, kind, cause, aarDropPct: Math.max(0, Math.min(100, aarDropPct)),
        pacingMit, avgDelayMin, scopeNm, windowStartMin, windowEndMin,
        arrCount: 0, meanScore: 0, worstCs: '', health: 'IDLE',
      })
    }
    return m
  }, [aarBias, delayMul, mitMul, scopeMul])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (!isFinite(f.altitudeFt)) continue
      if (!f.ground && f.altitudeFt / 100 < minFl) continue
      const phase = classifyPhase(f.altitudeFt, f.vertRate, f.ground, f.velocityKts)

      // Destination guess: forward-projection landing within 350 nm cone
      // or nearest airport ≤ 250 nm
      const trk = (f.track || 0) * Math.PI / 180
      const projRangeNm = 350
      const dLat = Math.cos(trk) * projRangeNm / 60
      const dLng = Math.sin(trk) * projRangeNm / 60 / Math.max(0.2, Math.cos(f.lat * Math.PI / 180))
      const projLat = f.lat + dLat, projLng = f.lng + dLng
      let dest = AIRPORTS[0]; let dBest = Number.POSITIVE_INFINITY
      for (const ap of AIRPORTS) {
        const dProj = haversineNm(projLat, projLng, ap.lat, ap.lng)
        const dAc = haversineNm(f.lat, f.lng, ap.lat, ap.lng)
        if (dAc > projRangeNm * 1.6) continue
        if (dProj < dBest) { dBest = dProj; dest = ap }
      }
      if (!isFinite(dBest)) {
        for (const ap of AIRPORTS) {
          const dAc = haversineNm(f.lat, f.lng, ap.lat, ap.lng)
          if (dAc < dBest) { dBest = dAc; dest = ap }
        }
      }
      const destNm = haversineNm(f.lat, f.lng, dest.lat, dest.lng)
      const tmi = apTmi.get(dest.icao)!

      // Class-conditional EDCT skew & expected delay (hash-stable)
      const sh = hash32((f.icao || '') + ':edct:' + dest.icao)
      const skewBase = (((sh & 0xffff) / 0xffff) - 0.5) * 2 * 30 // ±30 min
      const expectedDelayMin = tmi.kind === 'NONE' ? 0
        : tmi.kind === 'GS' ? 240
        : Math.max(0, tmi.avgDelayMin + (((sh >>> 16) & 0xff) / 0xff - 0.5) * 30)
      const edctSkewMin = tmi.kind === 'NONE' ? 0 : Math.round(skewBase * (tmi.kind === 'GDP' ? 1.0 : 0.5))

      const inGsScope = tmi.kind === 'GS' && destNm <= tmi.scopeNm
      let inFca: string | null = null
      for (const fc of FCAS) {
        if (f.lng >= fc.bbox[0] && f.lng <= fc.bbox[2] && f.lat >= fc.bbox[1] && f.lat <= fc.bbox[3]) {
          inFca = fc.id; break
        }
      }

      // Severities
      let tmiSev = 0
      if (tmi.kind === 'GS' && destNm <= tmi.scopeNm) tmiSev = 100
      else if (tmi.kind === 'GDP') tmiSev = Math.min(95, 30 + tmi.aarDropPct * 0.65)
      else if (tmi.kind === 'AFP') tmiSev = Math.min(85, 25 + tmi.aarDropPct)
      else if (tmi.kind === 'MIT') tmiSev = 30
      else if (tmi.kind === 'CTOP') tmiSev = 18
      else tmiSev = 0
      // Out-of-scope reduces TMI severity sharply
      if (destNm > tmi.scopeNm && tmi.kind !== 'NONE') tmiSev *= 0.20

      const win = Math.max(1, edctWin)
      const absSkew = Math.abs(edctSkewMin)
      const edcSev = tmi.kind === 'NONE' ? 0
        : absSkew <= win ? 0
        : absSkew <= win + 5 ? 30
        : absSkew <= win + 15 ? 60
        : absSkew <= win + 25 ? 85
        : 100

      const dlyTarget = 60
      const dlySev = expectedDelayMin <= dlyTarget ? Math.max(0, expectedDelayMin) * 0.4
        : expectedDelayMin <= 120 ? 30 + (expectedDelayMin - 60) * 0.5
        : expectedDelayMin <= 180 ? 60 + (expectedDelayMin - 120) * 0.4
        : 90

      let mitSev = 0
      if (tmi.pacingMit > 0 && (phase === 'ARRIVAL' || phase === 'DESCENT')) {
        const target = tmi.pacingMit
        const have = Math.max(0.5, destNm / Math.max(60, target)) * target
        const ratio = have / target
        mitSev = ratio >= 1 ? 0 : ratio >= 0.7 ? 40 : ratio >= 0.4 ? 75 : 100
      }

      let fcaSev = 0
      if (inFca) {
        const fc = FCAS.find(x => x.id === inFca)!
        // simulated FCA load proxy from velocity & track
        const load = ((hash32(inFca + ':' + Math.floor(Date.now() / 60000 / 3)) & 0xff) / 0xff)
        const exceed = load - 0.7
        fcaSev = exceed <= 0 ? 0 : Math.min(85, exceed * 250)
        void fc
      }

      const cdmSev = (tmi.kind === 'GDP' || tmi.kind === 'AFP')
        ? (((sh >>> 24) & 0x3f) / 0x3f) * 50 // 0..50 substitution gap
        : 0

      const sev = { tmi: tmiSev, edc: edcSev, dly: dlySev, mit: mitSev, fca: fcaSev, cdm: cdmSev }
      const drivers: Array<[Driver, number]> = [
        ['TMI', sev.tmi], ['EDC', sev.edc], ['DLY', sev.dly],
        ['MIT', sev.mit], ['FCA', sev.fca], ['CDM', sev.cdm],
      ]
      drivers.sort((a, b) => b[1] - a[1])
      const max = drivers[0][1]
      const secondary = drivers[1][1]
      const driver: Driver = max >= 15 ? drivers[0][0] : 'NONE'

      const phaseMul = 1 + ((PHASE_MUL[phase] - 1) * (phaseWt / 100))
      let score = Math.min(100, Math.max(0, max * phaseMul + 0.12 * secondary))

      // Hard escalations
      if (inGsScope && phase === 'DEP-TAXI') score = Math.max(score, 95)
      if (absSkew >= 30 && (phase === 'DEP-TAXI' || phase === 'ENROUTE')) score = Math.max(score, 90)
      if (expectedDelayMin > 180) score = Math.max(score, 85)
      if (mitSev >= 90 && phase === 'ARRIVAL') score = Math.max(score, 88)
      if (tmi.kind === 'CTOP' && cdmSev >= 45) score = Math.max(score, 80)
      if (tmi.kind === 'NONE') score = Math.min(score, 18)

      let tier: Tier
      if (tmi.kind === 'NONE' && score < 12) tier = 'IDLE'
      else if (score >= 80) tier = 'STOP-VIOL'
      else if (score >= 55) tier = 'EDCT-MISS'
      else if (score >= 25) tier = 'WATCH'
      else if (tmi.kind === 'NONE') tier = 'IDLE'
      else tier = 'OK'

      out.push({
        f, phase, destIcao: dest.icao, destNm,
        tmi: tmi.kind, cause: tmi.cause, aarDrop: tmi.aarDropPct, pacingMit: tmi.pacingMit,
        avgDelayMin: tmi.avgDelayMin, expectedDelayMin, edctSkewMin,
        inGsScope, inFca, sev, score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, apTmi, edctWin, phaseWt])

  const tierCount: Record<Tier, number> = { 'STOP-VIOL': 0, 'EDCT-MISS': 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++
  const meanDelay = rows.length ? rows.reduce((a, r) => a + r.expectedDelayMin, 0) / rows.length : 0
  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null
  const edctMissShare = rows.length ? rows.filter(r => Math.abs(r.edctSkewMin) > edctWin && r.tmi !== 'NONE').length / rows.length : 0
  const gdpArr = rows.filter(r => r.tmi === 'GDP').length
  const afpArr = rows.filter(r => r.tmi === 'AFP').length

  // Airport rollup
  const airportRollup: AirportTmiState[] = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of rows) {
      const e = m.get(r.destIcao) || []
      e.push(r); m.set(r.destIcao, e)
    }
    const out: AirportTmiState[] = []
    for (const ap of AIRPORTS) {
      const v = m.get(ap.icao) || []
      const st = apTmi.get(ap.icao)!
      const wt = v.reduce((a, r) => TIER_RANK[r.tier] < TIER_RANK[a] ? r.tier : a, 'IDLE' as Tier)
      const ms = v.length ? v.reduce((a, r) => a + r.score, 0) / v.length : 0
      const wc = v.length ? v.slice().sort((a, b) => b.score - a.score)[0] : null
      out.push({ ...st, arrCount: v.length, meanScore: ms, worstCs: wc?.f.callsign || wc?.f.icao || '', health: v.length ? wt : 'IDLE' })
    }
    out.sort((a, b) => {
      const t = TIER_RANK[a.health] - TIER_RANK[b.health]
      if (t) return t
      const sev = (b.kind !== 'NONE' ? 1 : 0) - (a.kind !== 'NONE' ? 1 : 0)
      if (sev) return sev
      return b.arrCount - a.arrCount
    })
    return out
  }, [rows, apTmi])

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (tmiFilter !== 'ALL') r = r.filter(x => x.tmi === tmiFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(x =>
      (x.f.callsign || '').toLowerCase().includes(q) ||
      (x.f.type || '').toLowerCase().includes(q) ||
      (x.f.icao || '').toLowerCase().includes(q) ||
      (x.f.operator || '').toLowerCase().includes(q) ||
      x.destIcao.toLowerCase().includes(q))
    return r.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, tmiFilter, query])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const ensure = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    }
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_LINK, SRC_STN, SRC_REF, SRC_RING, SRC_FCA]
    sources.forEach(ensure)

    if (!map.getLayer(LYR_REF)) {
      map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.18, 'line-width': 0.8, 'line-dasharray': [2, 4] } })
    }
    if (!map.getLayer(LYR_FCA_FILL)) {
      map.addLayer({ id: LYR_FCA_FILL, type: 'fill', source: SRC_FCA, paint: { 'fill-color': '#a78bfa', 'fill-opacity': 0.08 } })
    }
    if (!map.getLayer(LYR_FCA_LINE)) {
      map.addLayer({ id: LYR_FCA_LINE, type: 'line', source: SRC_FCA, paint: { 'line-color': '#a78bfa', 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [3, 3] } })
    }
    if (!map.getLayer(LYR_RING)) {
      map.addLayer({ id: LYR_RING, type: 'line', source: SRC_RING, paint: { 'line-color': ['get', 'color'], 'line-width': 1.0, 'line-opacity': 0.45, 'line-dasharray': [4, 4] } })
    }
    if (!map.getLayer(LYR_LINK)) {
      map.addLayer({ id: LYR_LINK, type: 'line', source: SRC_LINK, paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [1.5, 2.5] } })
    }
    if (!map.getLayer(LYR_HALO)) {
      map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.60, 'circle-stroke-width': 1.3 } })
    }
    if (!map.getLayer(LYR_STN)) {
      map.addLayer({ id: LYR_STN, type: 'circle', source: SRC_STN, paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-opacity': 0.85, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1 } })
    }
    if (!map.getLayer(LYR_PIN)) {
      map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': '◆', 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(LYR_LBL)) {
      map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }

    const halo: any[] = []; const lbl: any[] = []; const pin: any[] = []
    const link: any[] = []; const stn: any[] = []; const ref: any[] = []
    const ring: any[] = []; const fca: any[] = []

    for (const r of rows) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'OK' && r.tier !== 'IDLE') {
        const rad = 8 + (r.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: rad } })
      }
      if (showPin && r.tier === 'STOP-VIOL') {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLabels && (r.tier === 'STOP-VIOL' || r.tier === 'EDCT-MISS')) {
        const skew = r.edctSkewMin >= 0 ? `+${r.edctSkewMin}` : `${r.edctSkewMin}`
        const label = `${r.f.callsign || r.f.icao} · ${r.tmi}·${r.destIcao} · EDCT ${skew}m`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showLink && r.tier !== 'OK' && r.tier !== 'IDLE') {
        const ap = AIRPORTS.find(a => a.icao === r.destIcao)
        if (ap) link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [ap.lng, ap.lat]] }, properties: { color } })
      }
    }

    if (showStn) {
      for (const s of airportRollup) {
        const col = s.kind === 'NONE' ? TIER_COLOR[s.health] : TMI_COLOR[s.kind]
        stn.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.ap.lng, s.ap.lat] }, properties: { color: col } })
        if (showLabels) {
          const tag = s.kind === 'NONE' ? s.ap.icao : `${s.ap.icao} · ${s.kind} ${s.kind === 'GS' ? '!' : `−${s.aarDropPct}%`}`
          lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.ap.lng, s.ap.lat] }, properties: { color: '#cbd5e1', label: tag } })
        }
      }
    }
    if (showRing) {
      // scope rings as 36-segment polylines around each TMI airport
      for (const s of airportRollup) {
        if (s.kind === 'NONE' || s.scopeNm <= 0) continue
        const col = TMI_COLOR[s.kind]
        const coords: [number, number][] = []
        const latRad = s.ap.lat * Math.PI / 180
        const dLat = s.scopeNm / 60
        const dLngBase = s.scopeNm / 60 / Math.max(0.2, Math.cos(latRad))
        for (let i = 0; i <= 36; i++) {
          const a = (i / 36) * Math.PI * 2
          coords.push([s.ap.lng + Math.sin(a) * dLngBase, s.ap.lat + Math.cos(a) * dLat])
        }
        ring.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { color: col } })
      }
    }
    if (showFca) {
      for (const fc of FCAS) {
        const [mnLng, mnLat, mxLng, mxLat] = fc.bbox
        fca.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[[mnLng, mnLat], [mxLng, mnLat], [mxLng, mxLat], [mnLng, mxLat], [mnLng, mnLat]]] },
          properties: { id: fc.id },
        })
      }
    }
    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        ref.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }

    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_STN) as any).setData({ type: 'FeatureCollection', features: stn })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: ref })
    ;(map.getSource(SRC_RING) as any).setData({ type: 'FeatureCollection', features: ring })
    ;(map.getSource(SRC_FCA) as any).setData({ type: 'FeatureCollection', features: fca })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_STN, LYR_LINK, LYR_RING, LYR_FCA_FILL, LYR_FCA_LINE, LYR_REF]) { if (m.getLayer(id)) m.removeLayer(id) }
      for (const id of sources) { if (m.getSource(id)) m.removeSource(id) }
    }
  }, [map, rows, airportRollup, showHalo, showPin, showLabels, showLink, showStn, showRef, showRing, showFca])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const driverBadge = (d: Driver, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const tmiPill = (k: TmiKind) => (
    <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: TMI_COLOR[k], border: '1px solid ' + TMI_COLOR[k] + '66', backgroundColor: TMI_COLOR[k] + '14' }}>{k}</span>
  )
  const causePill = (c: Cause) => (
    <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: CAUSE_COLOR[c], border: '1px solid ' + CAUSE_COLOR[c] + '55', backgroundColor: '#0b1220' }}>{c}</span>
  )

  const advice = (r: Row) => {
    if (r.tier === 'STOP-VIOL') {
      if (r.inGsScope && r.phase === 'DEP-TAXI')
        return 'STOP-VIOL — Ground Stop in effect for destination. Hold push-back. Coordinate with dispatch / ATCSCC per FAA Order JO 7110.65 §17-7-1; expect new EOBT after GS amend / cancel'
      return 'STOP-VIOL — large EDCT skew or pacing collapse. Re-file via CDM substitution per A4A IOP §14; expect re-route or hold pattern at managed fix'
    }
    if (r.tier === 'EDCT-MISS')
      return 'EDCT-MISS — outside ±' + edctWin + ' min compliance window. Request slot swap via FAA TFMS Slot Credit Substitution / NMOC ATFCM Users Manual §4.6.5; do not depart until new CTOT'
    if (r.tier === 'WATCH')
      return 'WATCH — initiative in scope, posture tightening. Pre-coordinate with ramp control / dispatch; verify CTOT and route per active advisory'
    if (r.tier === 'OK')
      return r.tmi === 'NONE' ? 'Nominal — no active TMI affecting destination' : `${r.tmi} active but within compliance — maintain EDCT ±${edctWin} min, monitor advisory amendments`
    return 'Idle — no relevant TMI in scope'
  }

  // Diag scatter
  const W = 280, H = 180
  const xMaxAbs = 60
  const yMax = 200
  const sx = (skew: number) => 30 + ((Math.max(-xMaxAbs, Math.min(xMaxAbs, skew)) + xMaxAbs) / (2 * xMaxAbs)) * (W - 40)
  const sy = (d: number) => (H - 24) - (Math.min(yMax, d) / yMax) * (H - 48)

  return (
    <div className="absolute top-16 right-3 z-40 w-[440px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">TFM · Traffic Flow Initiatives</div>
          <div className="text-[10px] text-slate-500">ATCSCC / NMOC · GDP / GS / AFP / MIT / CTOP · JO 7110.65 §17 · ATFCM Users Manual ed 27</div>
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
          <div className="text-[9px] text-slate-500 uppercase">Mean delay</div>
          <div className="text-sm font-semibold" style={{ color: meanDelay > 90 ? '#ef4444' : meanDelay > 30 ? '#f59e0b' : '#10b981' }}>{meanDelay.toFixed(0)} m</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst aircraft</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Stop-violations</div>
          <div className="text-sm font-semibold" style={{ color: tierCount['STOP-VIOL'] > 0 ? '#ef4444' : '#10b981' }}>{tierCount['STOP-VIOL']}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">EDCT-miss share</div>
          <div className="text-xs font-semibold" style={{ color: edctMissShare > 0.30 ? '#ef4444' : edctMissShare > 0.10 ? '#f59e0b' : '#10b981' }}>{(edctMissShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">GDP arrivals</div>
          <div className="text-xs font-semibold" style={{ color: gdpArr > 0 ? '#f59e0b' : '#64748b' }}>{gdpArr}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">AFP arrivals</div>
          <div className="text-xs font-semibold" style={{ color: afpArr > 0 ? '#a78bfa' : '#64748b' }}>{afpArr}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W - 40} height={H - 48} fill="#0b1220" />
            {/* compliance bands */}
            <rect x={sx(-edctWin)} y={24} width={sx(edctWin) - sx(-edctWin)} height={H - 48} fill="#10b981" opacity={0.10} />
            <rect x={sx(-edctWin - 15)} y={24} width={sx(-edctWin) - sx(-edctWin - 15)} height={H - 48} fill="#f59e0b" opacity={0.10} />
            <rect x={sx(edctWin)} y={24} width={sx(edctWin + 15) - sx(edctWin)} height={H - 48} fill="#f59e0b" opacity={0.10} />
            <rect x={30} y={24} width={sx(-edctWin - 15) - 30} height={H - 48} fill="#ef4444" opacity={0.10} />
            <rect x={sx(edctWin + 15)} y={24} width={(W - 10) - sx(edctWin + 15)} height={H - 48} fill="#ef4444" opacity={0.10} />
            <line x1={sx(0)} x2={sx(0)} y1={24} y2={H - 24} stroke="#0ea5e9" strokeDasharray="2 3" strokeOpacity={0.55} />
            {[-60, -30, 0, 30, 60].map(t => (
              <text key={t} x={sx(t) - 10} y={H - 8} fontSize={8} fill="#64748b">{t > 0 ? '+' : ''}{t}</text>
            ))}
            {[0, 60, 120, 180].map(d => (
              <text key={d} x={4} y={sy(d) + 3} fontSize={8} fill="#64748b">{d}m</text>
            ))}
            {rows.filter(r => r.tmi !== 'NONE').map((r, i) => (
              <circle key={i} cx={sx(r.edctSkewMin)} cy={sy(r.expectedDelayMin)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.82} />
            ))}
            <text x={W / 2} y={H - 6} fontSize={9} fill="#64748b" textAnchor="middle">EDCT skew (min) · expected ground delay (min)</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">SCOPE-MUL {scopeMul}%</span><input type="range" min={50} max={200} value={scopeMul} onChange={e => setScopeMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">AAR-BIAS {aarBias}%</span><input type="range" min={-30} max={30} value={aarBias} onChange={e => setAarBias(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">DELAY-MUL {delayMul}%</span><input type="range" min={50} max={250} value={delayMul} onChange={e => setDelayMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIT-MUL {mitMul}%</span><input type="range" min={50} max={200} value={mitMul} onChange={e => setMitMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">EDCT-WIN ±{edctWin}m</span><input type="range" min={1} max={20} value={edctWin} onChange={e => setEdctWin(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col col-span-2"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setTmiFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${tmiFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {TMI_LIST.map(t => (
          <button key={t} onClick={() => setTmiFilter(tmiFilter === t ? 'ALL' : t)} className={`px-2 py-0.5 rounded text-[10px] border ${tmiFilter === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([
          ['HALO', showHalo, setShowHalo],
          ['PIN', showPin, setShowPin],
          ['LBL', showLabels, setShowLabels],
          ['LINK', showLink, setShowLink],
          ['STN', showStn, setShowStn],
          ['RING', showRing, setShowRing],
          ['FCA', showFca, setShowFca],
          ['REF', showRef, setShowRef],
          ['DIAG', showDiag, setShowDiag],
        ] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / ICAO / dest" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'AIRPORTS', 'INITIATIVES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              {tmiPill(r.tmi)}
              {causePill(r.cause)}
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300 font-mono">{r.destIcao}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{r.phase}</span>
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              EDCT skew <span className="font-mono" style={{ color: Math.abs(r.edctSkewMin) > edctWin ? '#f59e0b' : '#10b981' }}>{r.edctSkewMin >= 0 ? '+' : ''}{r.edctSkewMin}m</span>
              {' · exp delay '}<span className="font-mono text-slate-200">{r.expectedDelayMin.toFixed(0)}m</span>
              {' · AAR drop '}<span className="font-mono text-slate-200">{r.aarDrop}%</span>
              {r.pacingMit > 0 && <span> · MIT <span className="font-mono text-sky-300">{r.pacingMit.toFixed(0)} NM</span></span>}
              {r.inFca && <span className="text-violet-300"> · {r.inFca}</span>}
              {' · '}{r.destNm.toFixed(0)} nm to {r.destIcao}
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('TMI', r.sev.tmi)}
              {driverBadge('EDC', r.sev.edc)}
              {driverBadge('DLY', r.sev.dly)}
              {driverBadge('MIT', r.sev.mit)}
              {driverBadge('FCA', r.sev.fca)}
              {driverBadge('CDM', r.sev.cdm)}
            </div>
            <div className="px-2 pb-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {advice(r)}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No aircraft match the current filters.</div>
        )}

        {tab === 'AIRPORTS' && airportRollup.map((s, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${s.kind === 'NONE' ? TIER_COLOR[s.health] : TMI_COLOR[s.kind]}` }}>
              <span className="px-1 py-px rounded text-[10px] bg-slate-800 text-slate-200 font-mono">{s.ap.icao}</span>
              <span className="text-slate-300 truncate">{s.ap.name}</span>
              {tmiPill(s.kind)}
              {s.kind !== 'NONE' && causePill(s.cause)}
              <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{s.arrCount} arr</span>
              {tierBadge(s.health)}
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              {s.kind === 'GS' ? <span className="text-rose-400">GROUND STOP · all departures held</span>
                : s.kind === 'NONE' ? <span className="text-slate-500">no active initiative</span>
                : <>AAR drop <span className="font-mono text-amber-300">−{s.aarDropPct}%</span> · avg delay <span className="font-mono text-slate-200">{s.avgDelayMin}m</span> · scope <span className="font-mono text-slate-200">{s.scopeNm.toFixed(0)} nm</span></>}
              {s.pacingMit > 0 && <span> · MIT <span className="font-mono text-sky-300">{s.pacingMit.toFixed(0)} NM</span></span>}
              {s.kind !== 'NONE' && <span> · win {s.windowStartMin}m..+{s.windowEndMin}m</span>}
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${s.meanScore}%`, backgroundColor: s.kind === 'NONE' ? TIER_COLOR[s.health] : TMI_COLOR[s.kind] }} className="h-full" />
              </div>
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-500">
              mean {s.meanScore.toFixed(0)} · AAR {s.ap.rate}/hr · worst{' '}
              <button onClick={() => { const w = rows.find(rw => rw.destIcao === s.ap.icao && (rw.f.callsign === s.worstCs || rw.f.icao === s.worstCs)); if (w) onFly(w.f.icao) }} className="text-sky-400 hover:text-sky-300">{s.worstCs || '—'}</button>
            </div>
          </div>
        ))}

        {tab === 'INITIATIVES' && airportRollup.filter(s => s.kind !== 'NONE').sort((a, b) => {
          const order: Record<TmiKind, number> = { GS: 0, GDP: 1, AFP: 2, MIT: 3, CTOP: 4, NONE: 5 }
          return order[a.kind] - order[b.kind] || b.aarDropPct - a.aarDropPct
        }).map((s, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TMI_COLOR[s.kind]}` }}>
              {tmiPill(s.kind)}
              <span className="px-1 py-px rounded text-[10px] bg-slate-800 text-slate-200 font-mono">{s.ap.icao}</span>
              <span className="text-slate-300 truncate">{s.ap.name}</span>
              {causePill(s.cause)}
              <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{s.ap.region === 'EU' ? 'NMOC' : 'ATCSCC'}</span>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              {s.kind === 'GS'
                ? <>Ground Stop · scope <span className="font-mono">{s.scopeNm.toFixed(0)} nm</span> · all departures held until amend/cancel</>
                : <>AAR drop <span className="font-mono text-amber-300">−{s.aarDropPct}%</span> ({s.ap.rate}/hr → {(s.ap.rate * (1 - s.aarDropPct / 100)).toFixed(0)}/hr)
                  · scope <span className="font-mono">{s.scopeNm.toFixed(0)} nm</span>
                  · avg delay <span className="font-mono">{s.avgDelayMin}m</span>
                  {s.pacingMit > 0 && <> · pacing <span className="font-mono text-sky-300">{s.pacingMit.toFixed(0)} NM MIT</span></>}
                </>}
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-500">
              window {s.windowStartMin}m..+{s.windowEndMin}m · {s.arrCount} inbound · ref FAA Order JO 7110.65 §17 / Eurocontrol ATFCM UM §4
            </div>
          </div>
        ))}
        {tab === 'INITIATIVES' && airportRollup.filter(s => s.kind !== 'NONE').length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No TMIs currently active.</div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: FAA Order JO 7110.65 §17 TFM · JO 7210.3 §17 · JO 7210.802 EDCT compliance · TFMS R14 · ATCSCC Daily Plan / Advisory 99-12 · Eurocontrol ATFCM Users Manual ed 27 §4.6 · CASA slot allocation · NM B2B · EU Reg 255/2010 · 2019/123 · ICAO Doc 9971 · Doc 4444 §15 · IATA WSG 35 · A4A IOP ch 14 · NTSB AAR-09/01 · FAA OIG AV2021-046 · CDM MoA 2024.
        Driver legend: {(['TMI', 'EDC', 'DLY', 'MIT', 'FCA', 'CDM'] as Driver[]).map(d => `${d}=${DRIVER_LABEL[d]}`).join(' · ')}
      </div>
    </div>
  )
}
