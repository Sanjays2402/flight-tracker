'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   ADS-C / FANS-1A Contract & Periodic Position-Report
   Compliance Monitor
   -----------------------------------------------------------
   Per-airframe Automatic Dependent Surveillance-Contract
   (ADS-C) state machine tracker for oceanic / remote /
   procedural airspace. Models the three contract types
   PERIODIC / EVENT / DEMAND, the seven ARINC 622 / RTCA
   DO-258B basic and supplemental ADS groups (Basic, FlightID,
   Predicted-Route, Earth-Reference, Air-Reference, Meteo,
   Intermediate-Projected-Intent), and per-FIR Required
   Surveillance Performance (RSP) class assignment with the
   ICAO Doc 9869 PBCS framework (RSP-180, RSP-240, RSP-400)
   plus the matched Required Communication Performance
   (RCP-240, RCP-400) for CPDLC link health.

   Operational basis:
     · ICAO Annex 6 Pt I Att R PBCS
     · ICAO Doc 4444 PANS-ATM ch 8 / 14 ADS-C
     · ICAO Doc 9869 PBN/PBCS Manual
     · ICAO Doc 10037 GOLD ch 5 ADS-C / ch 6 PBCS
     · ICAO Doc 7030 NAT SUPPS · NAT Doc 007 Ch 8
     · ICAO Doc 4444 14.3 ADS-C contract types
     · FAA Order JO 7110.65 §8-2 oceanic ADS-C
     · AC 90-117 FANS-1/A in Oceanic Airspace
     · EUROCAE ED-100B / ED-122 FANS-1/A
     · RTCA DO-258B FANS-1/A MOPS
     · ARINC 622 FANS Data Link Char-Oriented Protocol
     · ARINC 745 ADS Application Specification
     · ARINC 622 sublayer 5.2 ADS message format
     · CPDLC ATN B1/B2 over VDL Mode 2 / SATCOM
     · NAT OPS Bulletin 2017-002 / 2019-001 PBCS NAT
     · NAT Doc 007 §6 / §7 ADS-C periodic 14-min
     · Pacific Common Track Sys (CPS) FIT 96-2 14 min
     · ASPIRE / SEAPACR / INSPIRE PBCS programs
     · NTSB AAR-19-04 / TSB-A20F0011 ADS-C lost data
     · TSB A99H0001 Swissair 111 NAT comm
     · AAIB Bull 9/2014 G-VINE NAT ADS-C contract drop
     · ATSB AO-2014-190 PBCS RSP-180 violation
     · BEA AF447 oceanic surveillance gap
     · ICAO ASEP 1-2 reduced separation ADS-C/CPDLC
     · IATA OPS 8.7 ADS-C contract management

   ADS-C contract types per Doc 4444 14.3:
     · PERIODIC — fixed-interval position reports
       (NAT 14 min RSP-180, others 27 min)
     · EVENT — triggered at waypoint, level-change,
       lateral-deviation, vertical-rate, time-to-FIR
     · DEMAND — single-shot ground request

   FANS-1/A vs ATN B1/B2:
     · FANS-1/A character-oriented ACARS over Inmarsat
       Aero-H/H+/I + VDL Mode 0/A/2 — RSP-180/RCP-240
       legacy ANSPs (Pacific, Oceania, NAT subset)
     · ATN B1 bit-oriented OSI over VDL Mode 2 — RCP-240
       EUR DLS mandate (Reg EU 29/2009 amended)
     · ATN B2 over IPS / VDL Mode 4 — RCP-130 (emerging)

   ADS-C groups tracked per ARINC 745:
     1. BASIC (lat, lng, alt, time)
     2. FLIGHT-ID (callsign)
     3. PREDICTED-ROUTE (next 2 waypoints)
     4. EARTH-REFERENCE (gnd-track, gnd-speed, V/S)
     5. AIR-REFERENCE (hdg, Mach, vertical rate)
     6. METEO (wind, OAT)
     7. INTERMEDIATE-PROJECTED-INTENT (level changes)

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash → stable FANS
        equipage class (FANS-1/A Inmarsat / FANS-1/A
        Iridium / ATN-B1 VDL / ATN-B2 / NONE) per
        operator and aircraft class probabilities from
        IATA OPS 8.7 fleet survey.
     2. Per-flight contract-state machine: derive last
        PERIODIC report age from hash + slider
        CONTRACT-INT 14-30 min, EVENT report age from
        last waypoint crossing (synthesised from track),
        DEMAND-pending boolean from ground-issued query.
     3. RSP achieved = age vs (1.5 * contract interval)
        ramp per Doc 9869 Annex B PBCS — RSP-180 means
        180 s ETA-accuracy, mapped via interval-180.
     4. RCP achieved = CPDLC round-trip latency
        synthesised from satellite (Inmarsat 1.7-3.5 s)
        vs Iridium (0.8-1.4 s) vs VDL2 (0.4-0.9 s).
     5. Contract drop detection: report-age > drop-thr
        slider triggers PROVIDER-ABORT per Doc 10037
        §5.4.4 "ADS-C connection terminated".
     6. FIR-mandate compliance: in NAT-OTS / Pacific
        CPS / Australian FIR Brisbane, ADS-C+CPDLC
        is mandatory per FAA AC 91-70B Ch 5 §5.5 /
        ATSB AO-2014-190.
     7. 5 risk drivers max-driver composite:
        · AGE  periodic-report age vs interval
        · RCP  CPDLC link latency vs RCP-240
        · DRP  contract drop count past 60min
        · EQP  equipage gap (NONE/FANS-only)
        · MND  in-FIR PBCS mandate non-compliance
     8. Phase-weighted score with oceanic ×1.40,
        remote ×1.20, hard escalation: ADS-C drop in
        oceanic ≥85, NONE-equipage in NAT/Pacific ≥92.

   Output:
     · 5 tiers DROP / DEGRADED / WATCH / ADSC-OK / IDLE
     · MapLibre overlay: tier-coloured halos sized 8-22
       px by score; rose ◆ DROP pin; 18 ANSP ground
       earth station pins coloured by provider (Inmarsat
       sky / Iridium violet / VDL emerald / Polar amber)
       sized 5px with provider IDs + Aero-H type; dashed
       tier-coloured aircraft-to-best-GES link for non-OK;
       dashed sky reference parallels lat ±60/±30/0 every
       12° lng; 7-group freshness ribbon labels for non-OK
     · Side panel: 5-tier counter strip click-to-filter,
       3-cell MEAN-AGE / WORST callsign / DROP-count
       summary, 3-cell PERIODIC-share / RCP-mean /
       NO-FANS-share secondary row, SVG report-age vs
       RCP-latency scatter with 4 RSP bands, 8 sliders
       MIN-FL / CONTRACT-INT / RCP-MUL / DROP-THR /
       SAT-LOAD / GES-OUT / EVENT-PROB / PHASE-WT,
       4-equipage chip filter FANS-INM / FANS-IRI /
       ATN-B1 / NONE, HALO PIN LBL LINK GES REF DIAG
       toggles, search by callsign / type / GES,
       AIRCRAFT / GES / FIRS tab switcher, per-row
       click-to-fly with tier-coloured advice citing
       Doc 10037 GOLD §5 + NAT OPS 2017-002

   Layers > Safety & Traffic.
   Persisted: ft-adsc
   ============================================================ */

interface AdscFlight {
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
  flights: AdscFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'DROP' | 'DEGRADED' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  DROP: '#ef4444', DEGRADED: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_LABEL: Record<Tier, string> = {
  DROP: 'DROP', DEGRADED: 'DEGRADED', WATCH: 'WATCH', OK: 'ADSC-OK', IDLE: 'IDLE',
}
const TIER_ORDER: Tier[] = ['DROP', 'DEGRADED', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { DROP: 0, DEGRADED: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Equip = 'FANS-INM' | 'FANS-IRI' | 'ATN-B1' | 'ATN-B2' | 'NONE'
type AcClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
type Phase = 'OCEANIC' | 'REMOTE' | 'ENROUTE' | 'TERMINAL'
const PHASE_MUL: Record<Phase, number> = { OCEANIC: 1.40, REMOTE: 1.20, ENROUTE: 1.00, TERMINAL: 0.85 }
const CLASS_LIST: AcClass[] = ['HVY-Q', 'HVY', 'NRW', 'RGN', 'BIZ', 'TBP']

type Driver = 'AGE' | 'RCP' | 'DRP' | 'EQP' | 'MND' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  AGE: 'Report age', RCP: 'CPDLC latency', DRP: 'Contract drops',
  EQP: 'Equipage gap', MND: 'PBCS mandate', NONE: 'Nominal',
}

interface GroundStation {
  id: string
  name: string
  lat: number
  lng: number
  provider: 'INMARSAT' | 'IRIDIUM' | 'VDL2' | 'POLAR'
  fir: string
}

// 18 ANSP / GES catalogue
const STATIONS: GroundStation[] = [
  // Inmarsat Aero ground earth stations
  { id: 'GOO', name: 'Goonhilly (Inmarsat-4 AOR-E)', lat: 50.05, lng:  -5.18, provider: 'INMARSAT', fir: 'EGGX' },
  { id: 'BMK', name: 'Burum (Inmarsat-4 EMEA)',      lat: 51.69, lng:   5.99, provider: 'INMARSAT', fir: 'EHAA' },
  { id: 'PAU', name: 'Paumalu (Inmarsat-4 POR)',     lat: 21.67, lng:-158.03, provider: 'INMARSAT', fir: 'KZAK' },
  { id: 'AUS', name: 'Auckland GES (Inmarsat-4)',    lat:-36.85, lng: 174.76, provider: 'INMARSAT', fir: 'NZZO' },
  { id: 'SNT', name: 'Santa Paula (Inmarsat AOR-W)', lat: 34.36, lng:-119.07, provider: 'INMARSAT', fir: 'KZAK' },
  // Iridium NEXT — global pole-to-pole 66-sat constellation, gateway Tempe
  { id: 'TPE', name: 'Tempe Iridium Gateway',        lat: 33.42, lng:-111.94, provider: 'IRIDIUM',  fir: 'KZAB' },
  { id: 'SVB', name: 'Svalbard Iridium NEXT',        lat: 78.23, lng:  15.40, provider: 'IRIDIUM',  fir: 'ENOB' },
  // VDL Mode 2 ARINC / SITA ground stations
  { id: 'ICN', name: 'Incheon VDL2',                 lat: 37.46, lng: 126.44, provider: 'VDL2',     fir: 'RKRR' },
  { id: 'HKG', name: 'Hong Kong VDL2',               lat: 22.31, lng: 113.92, provider: 'VDL2',     fir: 'VHHK' },
  { id: 'CDG', name: 'Paris CDG VDL2',               lat: 49.00, lng:   2.55, provider: 'VDL2',     fir: 'LFFF' },
  { id: 'FRA', name: 'Frankfurt VDL2',               lat: 50.04, lng:   8.56, provider: 'VDL2',     fir: 'EDGG' },
  { id: 'EWR', name: 'Newark VDL2',                  lat: 40.69, lng: -74.17, provider: 'VDL2',     fir: 'KZNY' },
  { id: 'YYZ', name: 'Toronto VDL2',                 lat: 43.68, lng: -79.63, provider: 'VDL2',     fir: 'CZYZ' },
  { id: 'DXB', name: 'Dubai VDL2',                   lat: 25.25, lng:  55.36, provider: 'VDL2',     fir: 'OMAE' },
  { id: 'SIN', name: 'Singapore VDL2',               lat:  1.36, lng: 103.99, provider: 'VDL2',     fir: 'WSJC' },
  // Polar gap-filler stations
  { id: 'ANC', name: 'Anchorage Polar HF/VDL',       lat: 61.17, lng:-150.02, provider: 'POLAR',    fir: 'PAZA' },
  { id: 'REK', name: 'Reykjavik Polar',              lat: 64.13, lng: -21.94, provider: 'POLAR',    fir: 'BIRD' },
  { id: 'MUR', name: 'Murmansk Polar',               lat: 68.78, lng:  32.75, provider: 'POLAR',    fir: 'ULMM' },
]

const PROVIDER_COLOR: Record<GroundStation['provider'], string> = {
  INMARSAT: '#0ea5e9', IRIDIUM: '#a78bfa', VDL2: '#10b981', POLAR: '#f59e0b',
}

const EQUIP_COLOR: Record<Equip, string> = {
  'FANS-INM': '#0ea5e9', 'FANS-IRI': '#a78bfa', 'ATN-B1': '#10b981', 'ATN-B2': '#06b6d4', 'NONE': '#ef4444',
}

function classifyPhase(lat: number, lng: number, alt: number): Phase {
  const absLat = Math.abs(lat)
  const oceanic =
    (absLat > 30 && absLat < 65 && lng > -55 && lng < -10 && lat > 35) ||
    (lat > 20 && lat < 55 && lng > 150) || (lat > 20 && lat < 55 && lng < -130) ||
    (lat < 5 && lat > -25 && lng > -35 && lng < 0) ||
    (lat < -10 && lng > 80 && lng < 130) ||
    (lat < 5 && lat > -40 && lng > 50 && lng < 100)
  const remote = absLat > 70 || (lng > 60 && lng < 120 && lat > 40 && lat < 70)
  if (oceanic && alt > 25000) return 'OCEANIC'
  if (remote && alt > 25000) return 'REMOTE'
  if (alt > 10000) return 'ENROUTE'
  return 'TERMINAL'
}

function inferFir(lat: number, lng: number): string {
  // Coarse FIR / OCA mapping covering PBCS-mandated areas
  if (lat > 35 && lat < 65 && lng > -55 && lng < -10) return lng < -30 ? 'CZQX' : 'EGGX'
  if (lat > 50 && lng > -10 && lng < 30) return 'BIRD'
  if (lat > 25 && lat < 55 && lng > 130 && lng < 180) return 'RJJJ'
  if (lat > 20 && lat < 55 && lng > 160 || (lng < -130 && lat > 20)) return 'KZAK'
  if (lat > 10 && lat < 35 && lng < -130) return 'KZAK'
  if (lat < -10 && lat > -45 && lng > 110 && lng < 165) return 'YBBB'
  if (lat < 5 && lat > -40 && lng > 50 && lng < 100) return 'FAJO'
  if (lat < 5 && lat > -25 && lng > -35 && lng < 10) return 'GOOO'
  if (lat > 60) return 'BGGL'
  return 'ZZZZ'
}

const PBCS_MANDATE_FIRS = new Set(['CZQX', 'EGGX', 'KZAK', 'YBBB', 'NZZO', 'RJJJ', 'BIRD', 'FAJO', 'GOOO', 'BGGL'])

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|A38|A34|IL96/.test(t)) return 'HVY-Q'
  if (/B77|B78|A33|A35|MD11/.test(t)) return 'HVY'
  if (/B73|A31|A319|A32|A22|B75|MD8|B71/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E27|E29|E[12]7|E[12]9|F70|F100|AT[47]|DH[48]/.test(t)) return 'RGN'
  if (/G[VI458]|GLF|GLEX|FA[78]X|F2TH|CL30|CL60|C68|C75|BE40|H25|LJ/.test(t)) return 'BIZ'
  return 'TBP'
}

function fansEquip(klass: AcClass, h: number): Equip {
  const r = (h & 0xffff) / 0xffff
  if (klass === 'HVY-Q' || klass === 'HVY') {
    if (r < 0.55) return 'FANS-INM'
    if (r < 0.78) return 'FANS-IRI'
    if (r < 0.96) return 'ATN-B1'
    return 'ATN-B2'
  }
  if (klass === 'NRW') {
    if (r < 0.20) return 'FANS-INM'
    if (r < 0.30) return 'FANS-IRI'
    if (r < 0.85) return 'ATN-B1'
    return 'NONE'
  }
  if (klass === 'BIZ') {
    if (r < 0.45) return 'FANS-INM'
    if (r < 0.78) return 'FANS-IRI'
    if (r < 0.92) return 'ATN-B1'
    return 'NONE'
  }
  if (klass === 'RGN') return r < 0.15 ? 'ATN-B1' : 'NONE'
  return r < 0.05 ? 'ATN-B1' : 'NONE'
}

function rcpBaseSec(eq: Equip, satLoad: number): number {
  // Round-trip CPDLC latency seconds, RCP-240 target end-to-end
  if (eq === 'FANS-INM') return 60 + satLoad * 0.6
  if (eq === 'FANS-IRI') return 28 + satLoad * 0.35
  if (eq === 'ATN-B1') return 18 + satLoad * 0.2
  if (eq === 'ATN-B2') return 12 + satLoad * 0.15
  return 999
}

function gcDist(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// 7 ADS-C report groups
const GROUPS = ['BASIC', 'FLT-ID', 'PRED-RT', 'EARTH', 'AIR', 'METEO', 'INTENT'] as const
type Group = typeof GROUPS[number]

interface Row {
  f: AdscFlight
  klass: AcClass
  phase: Phase
  isOceanic: boolean
  fir: string
  mandate: boolean
  equip: Equip
  periodicAgeMin: number
  intervalMin: number
  rcpSec: number
  rspMs: number // achieved RSP
  dropCount: number
  bestGes: GroundStation | null
  groupAges: Record<Group, number> // seconds
  sev: { age: number; rcp: number; drp: number; eqp: number; mnd: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'adsc-halo', SRC_LBL = 'adsc-lbl', SRC_PIN = 'adsc-pin', SRC_LINK = 'adsc-link', SRC_REF = 'adsc-ref', SRC_GES = 'adsc-ges', SRC_GESL = 'adsc-gesl'
const LYR_HALO = 'adsc-halo-l', LYR_LBL = 'adsc-lbl-l', LYR_PIN = 'adsc-pin-l', LYR_LINK = 'adsc-link-l', LYR_REF = 'adsc-ref-l', LYR_GES = 'adsc-ges-l', LYR_GESL = 'adsc-gesl-l'

export default function AdscFans({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'GES' | 'FIRS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [equipFilter, setEquipFilter] = useState<Equip | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(180)
  const [contractInt, setContractInt] = useState(14)   // minutes, NAT default 14
  const [rcpMul, setRcpMul] = useState(100)            // % multiplier
  const [dropThr, setDropThr] = useState(28)           // minutes (2× periodic)
  const [satLoad, setSatLoad] = useState(40)           // 0-100 %
  const [gesOut, setGesOut] = useState(0)              // 0-25 % outage
  const [eventProb, setEventProb] = useState(35)       // 0-100 % event-trigger probability per hour
  const [phaseWt, setPhaseWt] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showGes, setShowGes] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  // GES outage hash-stable
  const gesOutage = useMemo(() => {
    const out = new Set<string>()
    if (gesOut <= 0) return out
    for (const g of STATIONS) {
      const h = hash32(g.id) / 0xffffffff
      if (h * 100 < gesOut) out.add(g.id)
    }
    return out
  }, [gesOut])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (!isFinite(f.altitudeFt)) continue
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl) continue
      const phase = classifyPhase(f.lat, f.lng, f.altitudeFt)
      const klass = classifyClass(f.type || '')
      const h = hash32(f.icao || '')
      const equip = fansEquip(klass, h)
      const fir = inferFir(f.lat, f.lng)
      const mandate = PBCS_MANDATE_FIRS.has(fir)

      // periodic-report age: hash-stable 0..interval*1.4
      const ageFrac = ((h >>> 5) & 0xffff) / 0xffff
      const periodicAgeMin = ageFrac * contractInt * 1.4

      // CPDLC RCP latency
      const rcpSec = rcpBaseSec(equip, satLoad) * (rcpMul / 100)

      // RSP achieved ms (Doc 9869) ≈ contract-int (s) + RCP
      const rspMs = (periodicAgeMin * 60 + rcpSec) * 1000

      // Contract drops past 60 min — hash-stable, escalated by sat-load & polar
      const dropBase = ((h >>> 11) & 0xff) / 255
      let dropCount = 0
      if (equip === 'NONE') dropCount = 0
      else {
        const polarBonus = Math.abs(f.lat) > 75 && equip === 'FANS-INM' ? 1.5 : 0
        const loadBonus = (satLoad / 100) * 0.8
        const exp = dropBase * (1 + loadBonus + polarBonus) * (eventProb / 100) * 3
        dropCount = Math.floor(exp)
      }

      // best GES within range — Inmarsat geostationary visibility |lat|<76, Iridium global, VDL2 within 220 nm
      let bestGes: GroundStation | null = null
      let bestD = Infinity
      for (const g of STATIONS) {
        if (gesOutage.has(g.id)) continue
        if (equip === 'FANS-INM' && g.provider !== 'INMARSAT') continue
        if (equip === 'FANS-IRI' && g.provider !== 'IRIDIUM' && g.provider !== 'POLAR') continue
        if ((equip === 'ATN-B1' || equip === 'ATN-B2') && g.provider !== 'VDL2') continue
        if (equip === 'NONE') continue
        const d = gcDist(f.lat, f.lng, g.lat, g.lng)
        if (g.provider === 'INMARSAT' && Math.abs(f.lat) > 76) continue
        if (g.provider === 'VDL2' && d > 220) continue
        if (d < bestD) { bestD = d; bestGes = g }
      }

      // per-group ages (seconds) — BASIC = periodic, others derived
      const ga: Record<Group, number> = {
        BASIC: periodicAgeMin * 60,
        'FLT-ID': periodicAgeMin * 60,
        'PRED-RT': periodicAgeMin * 60 + (((h >>> 17) & 0xff) / 255) * 30,
        EARTH: periodicAgeMin * 60,
        AIR: periodicAgeMin * 60 + (((h >>> 19) & 0xff) / 255) * 15,
        METEO: periodicAgeMin * 60 + (((h >>> 21) & 0xff) / 255) * 60,
        INTENT: periodicAgeMin * 60 + (((h >>> 23) & 0xff) / 255) * 90,
      }

      // severities
      const ageRatio = periodicAgeMin / contractInt
      const age = ageRatio < 0.8 ? 0 : ageRatio < 1.0 ? 25 : ageRatio < 1.4 ? 55 : ageRatio < 2.0 ? 80 : 100
      const rcpTarget = 240 // s
      const rcpScore = rcpSec < rcpTarget * 0.4 ? 0 :
                       rcpSec < rcpTarget * 0.75 ? 25 :
                       rcpSec < rcpTarget ? 55 :
                       rcpSec < rcpTarget * 1.5 ? 80 : 100
      const drp = dropCount === 0 ? 0 : dropCount === 1 ? 35 : dropCount === 2 ? 65 : 95
      const eqp = equip === 'NONE' ? (mandate ? 100 : 60) :
                  equip === 'FANS-INM' && Math.abs(f.lat) > 76 ? 75 :
                  (equip === 'ATN-B1' || equip === 'ATN-B2') && phase === 'OCEANIC' ? 40 : 0
      const mnd = mandate && (equip === 'NONE' || bestGes === null) ? 95 :
                  mandate && periodicAgeMin > contractInt ? 60 : 0

      const sev = { age, rcp: rcpScore, drp, eqp, mnd }
      const drivers: Array<[Driver, number]> = [['AGE', age], ['RCP', rcpScore], ['DRP', drp], ['EQP', eqp], ['MND', mnd]]
      drivers.sort((a, b) => b[1] - a[1])
      const driver: Driver = drivers[0][1] >= 15 ? drivers[0][0] : 'NONE'
      const phaseMul = 1 + ((PHASE_MUL[phase] - 1) * (phaseWt / 100))
      const max = drivers[0][1]
      const secondary = drivers[1][1]
      let score = Math.min(100, Math.max(0, max * phaseMul + 0.10 * secondary))
      // Hard escalations
      if (mandate && equip === 'NONE') score = Math.max(score, 92)
      if (phase === 'OCEANIC' && periodicAgeMin > dropThr) score = Math.max(score, 85)
      if (dropCount >= 3 && phase === 'OCEANIC') score = Math.max(score, 88)

      let tier: Tier
      if (fl < minFl) tier = 'IDLE'
      else if (score >= 80) tier = 'DROP'
      else if (score >= 55) tier = 'DEGRADED'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, klass, phase, isOceanic: phase === 'OCEANIC' || phase === 'REMOTE',
        fir, mandate, equip, periodicAgeMin, intervalMin: contractInt, rcpSec,
        rspMs, dropCount, bestGes, groupAges: ga,
        sev, score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, contractInt, rcpMul, dropThr, satLoad, gesOutage, eventProb, phaseWt])

  const tierCount: Record<Tier, number> = { DROP: 0, DEGRADED: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++

  const meanAge = rows.length ? rows.reduce((a, r) => a + r.periodicAgeMin, 0) / rows.length : 0
  const dropTotal = rows.filter(r => r.tier === 'DROP').length
  const periodicShare = rows.length ? rows.filter(r => r.periodicAgeMin <= contractInt).length / rows.length : 0
  const meanRcp = rows.length ? rows.filter(r => r.equip !== 'NONE').reduce((a, r) => a + r.rcpSec, 0) / Math.max(1, rows.filter(r => r.equip !== 'NONE').length) : 0
  const noFansShare = rows.length ? rows.filter(r => r.equip === 'NONE').length / rows.length : 0
  const mandateNonComp = rows.filter(r => r.mandate && (r.equip === 'NONE' || r.bestGes === null)).length
  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (equipFilter !== 'ALL') r = r.filter(x => x.equip === equipFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(x => (x.f.callsign || '').toLowerCase().includes(q) || (x.f.type || '').toLowerCase().includes(q) || (x.f.icao || '').toLowerCase().includes(q) || (x.f.operator || '').toLowerCase().includes(q) || x.fir.toLowerCase().includes(q) || (x.bestGes?.id || '').toLowerCase().includes(q))
    return r.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, equipFilter, query])

  const gesRows = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of rows) {
      if (r.bestGes) {
        const e = m.get(r.bestGes.id) || []; e.push(r); m.set(r.bestGes.id, e)
      }
    }
    return STATIONS.map(g => {
      const list = m.get(g.id) || []
      const drop = list.filter(r => r.tier === 'DROP').length
      const meanScore = list.length ? list.reduce((a, r) => a + r.score, 0) / list.length : 0
      const worstTier = list.length ? list.reduce((a, r) => TIER_RANK[r.tier] < TIER_RANK[a] ? r.tier : a, 'IDLE' as Tier) : 'IDLE' as Tier
      return { g, ac: list.length, drop, meanScore, worstTier, outage: gesOutage.has(g.id) }
    }).sort((a, b) => (a.outage === b.outage ? b.ac - a.ac : a.outage ? -1 : 1))
  }, [rows, gesOutage])

  const firRows = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of rows) { const e = m.get(r.fir) || []; e.push(r); m.set(r.fir, e) }
    const arr: Array<{ fir: string; ac: number; mandate: boolean; drop: number; mean: number; worst: Tier; noFans: number }> = []
    for (const [fir, list] of m) {
      arr.push({
        fir, ac: list.length, mandate: PBCS_MANDATE_FIRS.has(fir),
        drop: list.filter(r => r.tier === 'DROP').length,
        mean: list.reduce((a, r) => a + r.score, 0) / list.length,
        worst: list.reduce((a, r) => TIER_RANK[r.tier] < TIER_RANK[a] ? r.tier : a, 'IDLE' as Tier),
        noFans: list.filter(r => r.equip === 'NONE').length,
      })
    }
    arr.sort((a, b) => (Number(b.mandate) - Number(a.mandate)) || b.drop - a.drop || b.ac - a.ac)
    return arr
  }, [rows])

  useEffect(() => {
    if (!map) return
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }) }
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_LINK, SRC_REF, SRC_GES, SRC_GESL]
    sources.forEach(ensure)

    if (!map.getLayer(LYR_REF)) {
      map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.14, 'line-width': 0.8, 'line-dasharray': [2, 4] } })
    }
    if (!map.getLayer(LYR_LINK)) {
      map.addLayer({ id: LYR_LINK, type: 'line', source: SRC_LINK, paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [1.5, 2] } })
    }
    if (!map.getLayer(LYR_HALO)) {
      map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.65, 'circle-stroke-width': 1.4 } })
    }
    if (!map.getLayer(LYR_PIN)) {
      map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': '◆', 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(LYR_GES)) {
      map.addLayer({ id: LYR_GES, type: 'circle', source: SRC_GES, paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-opacity': 0.85, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.2 } })
    }
    if (!map.getLayer(LYR_GESL)) {
      map.addLayer({ id: LYR_GESL, type: 'symbol', source: SRC_GESL, layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, 1.3], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(LYR_LBL)) {
      map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }

    const halo: any[] = []; const lbl: any[] = []; const pin: any[] = []; const link: any[] = []
    for (const r of rows) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'OK' && r.tier !== 'IDLE') {
        const rad = 8 + (r.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: rad } })
      }
      if (showPin && r.tier === 'DROP') {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLabels && (r.tier === 'DROP' || r.tier === 'DEGRADED')) {
        const label = `${r.f.callsign || r.f.icao} › ${r.equip} › AGE ${r.periodicAgeMin.toFixed(1)}m › ${r.bestGes?.id || 'NO-GES'}`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showLink && r.bestGes && r.tier !== 'OK' && r.tier !== 'IDLE') {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.bestGes.lng, r.bestGes.lat]] }, properties: { color } })
      }
    }

    const refFeats: any[] = []
    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        refFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }

    const gesFeats: any[] = []; const gesLbl: any[] = []
    if (showGes) {
      for (const g of STATIONS) {
        const outage = gesOutage.has(g.id)
        const col = outage ? '#ef4444' : PROVIDER_COLOR[g.provider]
        gesFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [g.lng, g.lat] }, properties: { color: col } })
        gesLbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [g.lng, g.lat] }, properties: { color: col, label: `${g.id}${outage ? ' OUT' : ''} · ${g.provider}` } })
      }
    }

    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: refFeats })
    ;(map.getSource(SRC_GES) as any).setData({ type: 'FeatureCollection', features: gesFeats })
    ;(map.getSource(SRC_GESL) as any).setData({ type: 'FeatureCollection', features: gesLbl })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_REF, LYR_GES, LYR_GESL]) { if (m.getLayer(id)) m.removeLayer(id) }
      for (const id of sources) { if (m.getSource(id)) m.removeSource(id) }
    }
  }, [map, rows, showHalo, showPin, showLabels, showLink, showRef, showGes, gesOutage])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{TIER_LABEL[t]}</span>
  )
  const driverBadge = (d: Driver, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const equipPill = (e: Equip) => {
    const col = EQUIP_COLOR[e]
    return <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '66', backgroundColor: col + '14' }}>{e}</span>
  }

  const advice = (r: Row) => {
    if (r.tier === 'DROP') {
      if (r.mandate && r.equip === 'NONE') return `PBCS-mandated FIR ${r.fir} but no FANS/ATN equipage — request lower / reroute non-PBCS track per AC 91-70B Ch 5 §5.5, file MOR for incorrect filing of W or X equipage suffix`
      if (r.dropCount >= 3) return `Contract dropped ${r.dropCount}× past 60min — re-establish ADS-C connection per Doc 10037 GOLD §5.4.4 PROVIDER-ABORT recovery, swap to secondary GES, escalate if persistent`
      if (r.periodicAgeMin > r.intervalMin * 2) return `PERIODIC report ${r.periodicAgeMin.toFixed(1)}m overdue (${r.intervalMin}m interval) — voice position report HF/SATVOICE, request CPDLC restart per NAT Doc 007 §7.4`
      if (r.bestGes === null) return `No GES in view (equip ${r.equip}) — try Iridium polar fallback or revert HF voice per NAT OPS 2017-002`
      return `ADS-C contract failure in ${r.fir} — request HF/SATVOICE backup, log AIREP per Doc 4444 §4.13`
    }
    if (r.tier === 'DEGRADED') return `RSP ${(r.rspMs/1000).toFixed(0)}s degraded vs RSP-180/240 target — pre-position SATVOICE, request reduced periodic interval (10 min) per Doc 9869 Annex B`
    if (r.tier === 'WATCH') return `RCP ${r.rcpSec.toFixed(0)}s nominal but trend adverse — monitor link KPIs, log per Doc 10037 §6.4 daily metrics`
    return `${r.equip} healthy · best GES ${r.bestGes?.id || '—'} · RCP ${r.rcpSec.toFixed(0)}s · contract ${r.intervalMin}m periodic per Doc 4444 14.3`
  }

  const W = 280, H = 180
  const xMax = contractInt * 2.2
  const yMax = 480 // RCP seconds
  const sx = (v: number) => 30 + (Math.min(xMax, Math.max(0, v)) / xMax) * (W - 40)
  const sy = (v: number) => H - 24 - (Math.min(yMax, Math.max(0, v)) / yMax) * (H - 48)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">ADS-C / FANS-1A · Contract Compliance</div>
          <div className="text-[10px] text-slate-500">18 GES · 7 ARINC 745 groups · Doc 10037 GOLD · PBCS RSP-180/RCP-240</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[10px] font-semibold" style={{ color: TIER_COLOR[t] }}>{TIER_LABEL[t]}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean age (min)</div>
          <div className="text-sm font-semibold" style={{ color: meanAge > contractInt ? '#ef4444' : meanAge > contractInt * 0.7 ? '#f59e0b' : '#10b981' }}>{meanAge.toFixed(1)}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst aircraft</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Drops</div>
          <div className="text-sm font-semibold" style={{ color: dropTotal > 0 ? '#ef4444' : '#10b981' }}>{dropTotal}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Periodic share</div>
          <div className="text-xs font-semibold" style={{ color: periodicShare > 0.85 ? '#10b981' : periodicShare > 0.6 ? '#f59e0b' : '#ef4444' }}>{(periodicShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean RCP (s)</div>
          <div className="text-xs font-semibold" style={{ color: meanRcp > 240 ? '#ef4444' : meanRcp > 180 ? '#f59e0b' : '#10b981' }}>{meanRcp.toFixed(0)}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">NONE / PBCS-FAIL</div>
          <div className="text-xs font-semibold" style={{ color: mandateNonComp > 0 ? '#ef4444' : noFansShare > 0.30 ? '#f59e0b' : '#10b981' }}>{(noFansShare * 100).toFixed(0)}% · {mandateNonComp}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W-40} height={H-48} fill="#0b1220" />
            {/* RSP bands (vertical: age) */}
            <rect x={sx(0)} y={24} width={sx(contractInt) - sx(0)} height={H - 48} fill="#10b981" opacity={0.07} />
            <rect x={sx(contractInt)} y={24} width={sx(contractInt*1.5) - sx(contractInt)} height={H - 48} fill="#f59e0b" opacity={0.08} />
            <rect x={sx(contractInt*1.5)} y={24} width={sx(xMax) - sx(contractInt*1.5)} height={H - 48} fill="#ef4444" opacity={0.10} />
            {/* RCP target lines */}
            <line x1={sx(0)} y1={sy(240)} x2={sx(xMax)} y2={sy(240)} stroke="#f59e0b" strokeDasharray="3 3" strokeOpacity={0.55} />
            <text x={W - 8} y={sy(240) - 3} fontSize={8} fill="#f59e0b" textAnchor="end">RCP-240</text>
            <line x1={sx(0)} y1={sy(180)} x2={sx(xMax)} y2={sy(180)} stroke="#10b981" strokeDasharray="3 3" strokeOpacity={0.50} />
            <text x={W - 8} y={sy(180) - 3} fontSize={8} fill="#10b981" textAnchor="end">RSP-180</text>
            <line x1={sx(contractInt)} y1={24} x2={sx(contractInt)} y2={H - 24} stroke="#0ea5e9" strokeDasharray="3 3" strokeOpacity={0.50} />
            <text x={sx(contractInt) + 3} y={36} fontSize={8} fill="#0ea5e9">INT {contractInt}m</text>
            {rows.map((r, i) => (
              <circle key={i} cx={sx(r.periodicAgeMin)} cy={sy(Math.min(yMax, r.rcpSec))} r={2.4} fill={TIER_COLOR[r.tier]} opacity={r.equip === 'NONE' ? 0.35 : 0.85} />
            ))}
            <text x={W/2} y={H-6} fontSize={9} fill="#64748b" textAnchor="middle">PERIODIC-age (min) vs CPDLC-RCP (s)</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">CONTRACT-INT {contractInt}m</span><input type="range" min={5} max={30} value={contractInt} onChange={e => setContractInt(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">RCP-MUL {rcpMul}%</span><input type="range" min={50} max={250} value={rcpMul} onChange={e => setRcpMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">DROP-THR {dropThr}m</span><input type="range" min={10} max={60} value={dropThr} onChange={e => setDropThr(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">SAT-LOAD {satLoad}%</span><input type="range" min={0} max={100} value={satLoad} onChange={e => setSatLoad(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">GES-OUT {gesOut}%</span><input type="range" min={0} max={25} value={gesOut} onChange={e => setGesOut(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">EVENT-PROB {eventProb}%</span><input type="range" min={0} max={100} value={eventProb} onChange={e => setEventProb(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setEquipFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${equipFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {(['FANS-INM','FANS-IRI','ATN-B1','NONE'] as Equip[]).map(e => (
          <button key={e} onClick={() => setEquipFilter(equipFilter === e ? 'ALL' : e)} className={`px-2 py-0.5 rounded text-[10px] border ${equipFilter===e?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>{e}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo],['PIN', showPin, setShowPin],['LBL', showLabels, setShowLabels],['LINK', showLink, setShowLink],['GES', showGes, setShowGes],['REF', showRef, setShowRef],['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / GES / FIR / type" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'GES', 'FIRS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab===t?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex flex-wrap items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.klass}</span>
              {equipPill(r.equip)}
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{r.phase}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-200 font-mono">{r.fir}</span>
              {r.mandate && <span className="px-1 py-px rounded text-[9px] bg-sky-500/15 text-sky-300 border border-sky-500/40">PBCS</span>}
              {r.dropCount > 0 && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/40">DRP×{r.dropCount}</span>}
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              FL{(r.f.altitudeFt/100).toFixed(0)} · AGE <span style={{color: r.periodicAgeMin>r.intervalMin*1.5?'#ef4444':r.periodicAgeMin>r.intervalMin?'#f59e0b':r.periodicAgeMin>r.intervalMin*0.7?'#0ea5e9':'#10b981'}}>{r.periodicAgeMin.toFixed(1)}m</span>/{r.intervalMin}m · RCP <span style={{color: r.rcpSec>240?'#ef4444':r.rcpSec>180?'#f59e0b':'#10b981'}}>{r.rcpSec.toFixed(0)}s</span> · RSP <span className="text-slate-300">{(r.rspMs/1000).toFixed(0)}s</span> · GES <span className="text-slate-200">{r.bestGes?.id || 'NONE'}</span>
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('AGE', r.sev.age)}
              {driverBadge('RCP', r.sev.rcp)}
              {driverBadge('DRP', r.sev.drp)}
              {driverBadge('EQP', r.sev.eqp)}
              {driverBadge('MND', r.sev.mnd)}
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {GROUPS.map(g => {
                const age = r.groupAges[g]
                const col = age > 600 ? '#ef4444' : age > 300 ? '#f59e0b' : age > 60 ? '#0ea5e9' : '#10b981'
                return <span key={g} title={`${g} · ${age.toFixed(0)}s`} className="px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '55', backgroundColor: col + '12' }}>{g}</span>
              })}
            </div>
            <div className="px-2 pb-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {advice(r)}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No aircraft match the current filters.</div>
        )}

        {tab === 'GES' && gesRows.map((s, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${s.outage ? '#ef4444' : PROVIDER_COLOR[s.g.provider]}` }}>
              <span className="font-semibold text-slate-100 font-mono">{s.g.id}</span>
              <span className="text-slate-300 truncate">{s.g.name}</span>
              <span className="px-1 py-px rounded text-[9px]" style={{ color: PROVIDER_COLOR[s.g.provider], border: '1px solid ' + PROVIDER_COLOR[s.g.provider] + '66', backgroundColor: PROVIDER_COLOR[s.g.provider] + '14' }}>{s.g.provider}</span>
              {s.outage && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/40">OUTAGE</span>}
              <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{s.ac} ac</span>
              {tierBadge(s.worstTier)}
            </div>
            <div className="px-2 text-[10px] text-slate-400">{s.g.lat.toFixed(2)}°, {s.g.lng.toFixed(2)}° · FIR {s.g.fir} · {s.drop} DROP · mean {s.meanScore.toFixed(0)}</div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${Math.min(100, s.ac * 3)}%`, backgroundColor: PROVIDER_COLOR[s.g.provider] }} className="h-full" />
              </div>
            </div>
          </div>
        ))}

        {tab === 'FIRS' && firRows.map((f, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[f.worst]}` }}>
              <span className="font-mono font-semibold text-slate-100">{f.fir}</span>
              {f.mandate && <span className="px-1 py-px rounded text-[9px] bg-sky-500/15 text-sky-300 border border-sky-500/40">PBCS-MANDATE</span>}
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{f.ac} ac</span>
              {f.drop > 0 && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/40">DROP×{f.drop}</span>}
              {f.noFans > 0 && <span className="px-1 py-px rounded text-[9px] bg-amber-500/15 text-amber-300 border border-amber-500/40">NO-FANS×{f.noFans}</span>}
              <div className="ml-auto">{tierBadge(f.worst)}</div>
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-500">mean score {f.mean.toFixed(0)} · {f.mandate ? 'RSP-180/RCP-240 required per FAA AC 91-70B / NAT OPS 2017-002' : 'non-PBCS FIR'}</div>
            <div className="px-2 pb-2">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${Math.min(100, f.mean)}%`, backgroundColor: TIER_COLOR[f.worst] }} className="h-full" />
              </div>
            </div>
          </div>
        ))}
        {tab === 'FIRS' && firRows.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No FIRs tracked.</div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: ICAO Annex 6 Pt I Att R PBCS · Doc 4444 PANS-ATM 14.3 ADS-C · Doc 9869 PBCS Manual · Doc 10037 GOLD ch 5/6 · Doc 7030 NAT SUPPS · NAT Doc 007 §6/§7 · FAA AC 91-70B / 90-117 · Order JO 7110.65 §8-2 · ARINC 622 / 745 · RTCA DO-258B FANS-1/A · EUROCAE ED-100B / ED-122 · NAT OPS 2017-002 / 2019-001 PBCS · ASPIRE / SEAPACR / INSPIRE · 18 GES (Inmarsat Goonhilly/Burum/Paumalu/Auckland/Santa Paula · Iridium Tempe/Svalbard · VDL2 ICN/HKG/CDG/FRA/EWR/YYZ/DXB/SIN · Polar ANC/REK/MUR). 7 ARINC 745 groups BASIC/FLT-ID/PRED-RT/EARTH/AIR/METEO/INTENT. 3 contract types PERIODIC/EVENT/DEMAND. RSP-180/240/400 + RCP-240/400 PBCS pairs.
      </div>
    </div>
  )
}
