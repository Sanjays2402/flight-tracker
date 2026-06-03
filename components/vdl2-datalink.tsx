'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   VDL-Mode-2 / FANS-1A · Datalink Ground-Station Coverage,
   Handoff & RCP/RSP Performance Monitor
   -----------------------------------------------------------
   Per-airframe scorer of Aeronautical Telecommunications
   Network (ATN/OSI & ATN/IPS) and FANS-1A+ datalink posture
   correlating each tracked target against a synthetic
   catalogue of 38 ARINC GLOBALink VDL-2, SITA AIRCOM, and
   Iridium / Inmarsat-SBB ground stations (GSIF cells).
   Evaluates link availability, channel congestion (DSC vs
   CSC), expected latency vs RCP/RSP allocation, station
   handoff candidate, and Required Communication Performance
   compliance (RCP-240 / RCP-400) and Required Surveillance
   Performance (RSP-180 / RSP-400) per ICAO Doc 9869 PBCS.

   References
     · RTCA DO-281B VDL Mode 2 MOPS
     · EUROCAE ED-92B VDL-2 MOPS
     · ARINC 631-7 VHF Digital Link Mode 2 Protocols
     · ARINC 622-4 ATS Data Link Applications
     · ARINC 620 Datalink Ground System Standard
     · ICAO Doc 9880 Manual on Detailed Technical Specs ATN
     · ICAO Doc 9869 PBCS RCP / RSP
     · ICAO Annex 10 Vol III Pt I §6 VDL Mode 2
     · ICAO Annex 11 §3.3 ATS communications
     · ICAO Doc 4444 PANS-ATM §4.12 / §14 CPDLC
     · FAA AC 20-140C Datalink Communications
     · FAA AC 90-117 Datalink Communications Compliance
     · EASA AMC 20-24 CPDLC operational evaluation
     · CRA 29/2009 EU Data Link Services
     · RTCA DO-258A FANS-1/A Interop Standard
     · ARINC 741 / 781 SATCOM avionics standards
     · NTSB SAFO 13003 datalink congestion advisory
     · EUROCONTROL DLS Implementing Rule (EU) 29/2009
     · ARINC GLOBALink/VHF service description
     · SITA AIRCOM datalink service description
     · Inmarsat Aero / Iridium Certus aero datalink
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'OUT-OF-CONTACT' | 'RCP-BREACH' | 'CONGESTED' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'OUT-OF-CONTACT': '#ef4444', 'RCP-BREACH': '#f43f5e', CONGESTED: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['OUT-OF-CONTACT', 'RCP-BREACH', 'CONGESTED', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { 'OUT-OF-CONTACT': 0, 'RCP-BREACH': 1, CONGESTED: 2, WATCH: 3, OK: 4, IDLE: 5 }

type Bearer = 'VDL2' | 'SBB' | 'IRID' | 'HFDL'
const BEARER_COLOR: Record<Bearer, string> = { VDL2: '#0ea5e9', SBB: '#a855f7', IRID: '#10b981', HFDL: '#f59e0b' }
const BEARER_RANGE_NM: Record<Bearer, number> = { VDL2: 200, SBB: 2400, IRID: 2200, HFDL: 1800 }
/* Nominal one-way transit latency (s) per bearer at light load */
const BEARER_BASE_LAT_S: Record<Bearer, number> = { VDL2: 6, SBB: 9, IRID: 12, HFDL: 35 }
/* Per-bearer expected packet loss baseline (%) */
const BEARER_BASE_LOSS: Record<Bearer, number> = { VDL2: 1.2, SBB: 0.8, IRID: 1.5, HFDL: 4.0 }

interface GroundStation {
  id: string                // GSIF identifier
  network: 'ARINC' | 'SITA' | 'INMARSAT' | 'IRIDIUM' | 'HFDL'
  bearer: Bearer
  name: string
  icao?: string             // colocated airport
  lat: number; lng: number
  freqKhz?: number          // VDL-2 CSC 136.975 or assigned DSC; SATCOM = N/A
  range: number             // NM coverage radius
  congPct: number           // synthetic CSC/DSC congestion %, 0-100
  loadPct: number           // current channel utilisation %
}

/* 38 ground stations spanning ARINC GLOBALink VDL-2, SITA AIRCOM,
   Inmarsat SBB satellite SDU regions, Iridium spot beams, and
   HFDL primary stations per ARINC 635-4 frequency plan. */
const STATIONS: GroundStation[] = [
  // ARINC GLOBALink VDL-2 — CSC 136.975, DSC assigned per ARINC 631-7
  { id: 'KZNY-ARN-1', network: 'ARINC', bearer: 'VDL2', name: 'New York GLOBALink',  icao: 'KJFK', lat: 40.640, lng: -73.779, freqKhz: 136975, range: 180, congPct: 72, loadPct: 68 },
  { id: 'KZAU-ARN-1', network: 'ARINC', bearer: 'VDL2', name: 'Chicago GLOBALink',   icao: 'KORD', lat: 41.974, lng: -87.907, freqKhz: 136900, range: 180, congPct: 55, loadPct: 51 },
  { id: 'KZLA-ARN-1', network: 'ARINC', bearer: 'VDL2', name: 'Los Angeles GLOBALink',icao: 'KLAX', lat: 33.943, lng: -118.408, freqKhz: 136725, range: 180, congPct: 48, loadPct: 44 },
  { id: 'KZHU-ARN-1', network: 'ARINC', bearer: 'VDL2', name: 'Houston GLOBALink',   icao: 'KIAH', lat: 29.984, lng: -95.341, freqKhz: 136725, range: 180, congPct: 41, loadPct: 38 },
  { id: 'KZDV-ARN-1', network: 'ARINC', bearer: 'VDL2', name: 'Denver GLOBALink',    icao: 'KDEN', lat: 39.861, lng: -104.673, freqKhz: 136875, range: 200, congPct: 36, loadPct: 33 },
  { id: 'KZMA-ARN-1', network: 'ARINC', bearer: 'VDL2', name: 'Miami GLOBALink',     icao: 'KMIA', lat: 25.793, lng: -80.290, freqKhz: 136925, range: 180, congPct: 58, loadPct: 53 },
  { id: 'KZBW-ARN-1', network: 'ARINC', bearer: 'VDL2', name: 'Boston GLOBALink',    icao: 'KBOS', lat: 42.362, lng: -71.006, freqKhz: 136775, range: 170, congPct: 49, loadPct: 45 },
  { id: 'KZAB-ARN-1', network: 'ARINC', bearer: 'VDL2', name: 'Albuquerque GLOBALink',icao: 'KABQ', lat: 35.040, lng: -106.609, freqKhz: 136700, range: 220, congPct: 22, loadPct: 19 },
  { id: 'CYYZ-ARN-1', network: 'ARINC', bearer: 'VDL2', name: 'Toronto GLOBALink',   icao: 'CYYZ', lat: 43.677, lng: -79.630, freqKhz: 136850, range: 170, congPct: 44, loadPct: 40 },
  { id: 'PHNL-ARN-1', network: 'ARINC', bearer: 'VDL2', name: 'Honolulu GLOBALink',  icao: 'PHNL', lat: 21.318, lng: -157.922, freqKhz: 136975, range: 160, congPct: 28, loadPct: 26 },
  { id: 'PANC-ARN-1', network: 'ARINC', bearer: 'VDL2', name: 'Anchorage GLOBALink', icao: 'PANC', lat: 61.174, lng: -149.996, freqKhz: 136775, range: 200, congPct: 18, loadPct: 16 },
  // SITA AIRCOM VDL-2 — European backbone
  { id: 'EGLL-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'Heathrow AIRCOM',     icao: 'EGLL', lat: 51.470, lng: -0.454, freqKhz: 136975, range: 180, congPct: 81, loadPct: 76 },
  { id: 'LFPG-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'Paris CDG AIRCOM',    icao: 'LFPG', lat: 49.003, lng: 2.571, freqKhz: 136950, range: 180, congPct: 67, loadPct: 62 },
  { id: 'EDDF-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'Frankfurt AIRCOM',    icao: 'EDDF', lat: 50.033, lng: 8.570, freqKhz: 136725, range: 180, congPct: 79, loadPct: 73 },
  { id: 'EHAM-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'Amsterdam AIRCOM',    icao: 'EHAM', lat: 52.308, lng: 4.764, freqKhz: 136900, range: 180, congPct: 61, loadPct: 56 },
  { id: 'LEMD-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'Madrid AIRCOM',       icao: 'LEMD', lat: 40.493, lng: -3.566, freqKhz: 136825, range: 180, congPct: 43, loadPct: 40 },
  { id: 'LIRF-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'Rome FCO AIRCOM',     icao: 'LIRF', lat: 41.804, lng: 12.250, freqKhz: 136800, range: 180, congPct: 47, loadPct: 43 },
  { id: 'EDDM-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'Munich AIRCOM',       icao: 'EDDM', lat: 48.353, lng: 11.786, freqKhz: 136975, range: 180, congPct: 55, loadPct: 50 },
  { id: 'LSZH-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'Zurich AIRCOM',       icao: 'LSZH', lat: 47.464, lng: 8.549, freqKhz: 136850, range: 160, congPct: 38, loadPct: 35 },
  { id: 'LTBA-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'Istanbul AIRCOM',     icao: 'LTFM', lat: 41.262, lng: 28.741, freqKhz: 136775, range: 200, congPct: 51, loadPct: 47 },
  // Asia-Pacific VDL-2
  { id: 'RJTT-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'Tokyo HND AIRCOM',    icao: 'RJTT', lat: 35.553, lng: 139.781, freqKhz: 136975, range: 180, congPct: 64, loadPct: 58 },
  { id: 'VHHH-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'Hong Kong AIRCOM',    icao: 'VHHH', lat: 22.308, lng: 113.918, freqKhz: 136925, range: 180, congPct: 71, loadPct: 65 },
  { id: 'WSSS-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'Singapore AIRCOM',    icao: 'WSSS', lat: 1.359, lng: 103.989, freqKhz: 136875, range: 200, congPct: 59, loadPct: 54 },
  { id: 'YSSY-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'Sydney AIRCOM',       icao: 'YSSY', lat: -33.946, lng: 151.177, freqKhz: 136900, range: 200, congPct: 32, loadPct: 30 },
  { id: 'OMDB-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'Dubai AIRCOM',        icao: 'OMDB', lat: 25.252, lng: 55.364, freqKhz: 136975, range: 180, congPct: 73, loadPct: 67 },
  { id: 'VABB-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'Mumbai AIRCOM',       icao: 'VABB', lat: 19.089, lng: 72.866, freqKhz: 136725, range: 180, congPct: 56, loadPct: 51 },
  { id: 'RKSI-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'Seoul ICN AIRCOM',    icao: 'RKSI', lat: 37.469, lng: 126.450, freqKhz: 136800, range: 180, congPct: 48, loadPct: 44 },
  // South America VDL-2
  { id: 'SBGR-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'São Paulo AIRCOM',    icao: 'SBGR', lat: -23.435, lng: -46.473, freqKhz: 136975, range: 180, congPct: 39, loadPct: 36 },
  { id: 'SCEL-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'Santiago AIRCOM',     icao: 'SCEL', lat: -33.393, lng: -70.786, freqKhz: 136900, range: 180, congPct: 24, loadPct: 22 },
  // Africa VDL-2
  { id: 'FAOR-SITA',  network: 'SITA',  bearer: 'VDL2', name: 'Johannesburg AIRCOM', icao: 'FAOR', lat: -26.139, lng: 28.246, freqKhz: 136875, range: 200, congPct: 31, loadPct: 28 },
  // Inmarsat SBB SDU regions (POR / IOR / AOR-W / AOR-E)
  { id: 'INM-POR-3F2', network: 'INMARSAT', bearer: 'SBB', name: 'Inmarsat I-4 POR Pacific', lat: 0, lng: -178, range: 2400, congPct: 12, loadPct: 14 },
  { id: 'INM-IOR-3F1', network: 'INMARSAT', bearer: 'SBB', name: 'Inmarsat I-4 IOR Indian',  lat: 0, lng: 64, range: 2400, congPct: 18, loadPct: 19 },
  { id: 'INM-AOR-W',   network: 'INMARSAT', bearer: 'SBB', name: 'Inmarsat AOR-West Atlantic', lat: 0, lng: -54, range: 2400, congPct: 22, loadPct: 24 },
  { id: 'INM-AOR-E',   network: 'INMARSAT', bearer: 'SBB', name: 'Inmarsat AOR-East EUR/AFR', lat: 0, lng: 25, range: 2400, congPct: 28, loadPct: 30 },
  // Iridium Certus aero (truly global LEO — modeled as 2 hemispheres for hand-off display)
  { id: 'IRID-N',      network: 'IRIDIUM',  bearer: 'IRID', name: 'Iridium NEXT Northern',  lat: 45, lng: 0, range: 2200, congPct: 10, loadPct: 12 },
  { id: 'IRID-S',      network: 'IRIDIUM',  bearer: 'IRID', name: 'Iridium NEXT Southern',  lat: -45, lng: 0, range: 2200, congPct: 8, loadPct: 10 },
  // HFDL primary stations per ARINC 635-4
  { id: 'HFDL-RKV',    network: 'HFDL',     bearer: 'HFDL', name: 'Reykjavík HFDL',  lat: 64.130, lng: -21.940, range: 1800, congPct: 18, loadPct: 16 },
  { id: 'HFDL-SCL',    network: 'HFDL',     bearer: 'HFDL', name: 'Santa Cruz HFDL', lat: 19.000, lng: -155.700, range: 1800, congPct: 14, loadPct: 12 },
]

/* Aircraft datalink fitment class:
     ATN-B2  = full FANS-1/A+ + ATN/OSI + ATN/IPS (787, A350, A380)
     FANS    = FANS-1/A+ via VDL/SAT (most B777/B747/B767, A330/340)
     LEGACY  = ACARS only via VDL-2 / SAT (older NB, freighters)
     OOEP    = Out-Of-EuroFANS programme (no CPDLC)              */
type Fit = 'ATN-B2' | 'FANS' | 'LEGACY' | 'OOEP'
const FIT_COLOR: Record<Fit, string> = { 'ATN-B2': '#10b981', FANS: '#0ea5e9', LEGACY: '#f59e0b', OOEP: '#ef4444' }

function classify(type?: string): Fit {
  const t = (type || '').toUpperCase()
  if (/^(A35|A350|A38|A380|B78|B787)/.test(t)) return 'ATN-B2'
  if (/^(B77|B747|B748|B767|A33|A34|MD11)/.test(t)) return 'FANS'
  if (/^(B73|B737|B75|B757|A31|A32|A20|A21|CRJ|E17|E19|EJET|MD80)/.test(t)) return 'LEGACY'
  if (/^(DH8|ATR|AT4|AT7|BE|SF3|J32)/.test(t)) return 'OOEP'
  return 'LEGACY'
}

/* Per-fitment RCP / RSP allocation per Doc 9869 PBCS:
     ATN-B2:  RCP-240 / RSP-180 (oceanic/remote)
     FANS:    RCP-240 / RSP-180
     LEGACY:  RCP-400 / RSP-400
     OOEP:    No PBCS — voice fallback                           */
const FIT_RCP: Record<Fit, number> = { 'ATN-B2': 240, FANS: 240, LEGACY: 400, OOEP: 600 }
const FIT_RSP: Record<Fit, number> = { 'ATN-B2': 180, FANS: 180, LEGACY: 400, OOEP: 600 }

type Phase = 'OCEANIC' | 'ENROUTE' | 'TERMINAL' | 'TAXI' | 'OTHER'
const PHASE_MUL: Record<Phase, number> = { OCEANIC: 1.35, ENROUTE: 1.10, TERMINAL: 1.20, TAXI: 0.70, OTHER: 0.40 }

interface Row {
  f: SFlight
  fit: Fit
  primary?: GroundStation
  secondary?: GroundStation
  distNm: number
  distSecNm: number
  bearer?: Bearer
  expLatS: number
  expLossPct: number
  rcpTarget: number
  rspTarget: number
  phase: Phase
  congestion: number
  handoffETA: number     // minutes to handoff (when primary about to lose contact)
  driver: 'AVL' | 'LAT' | 'CON' | 'BCH' | 'HOF' | 'LOS' | 'NONE'
  avl: number; lat: number; con: number; bch: number; hof: number; los: number
  score: number
  tier: Tier
}

function distNmF(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3440.065
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180
  const sa = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa))
}
function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)) }
function fnv1a(s: string) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0 } return h }

const SRC_HALO = 'vdl-halo'; const LYR_HALO = 'vdl-halo-l'
const SRC_STN = 'vdl-stn'; const LYR_STN = 'vdl-stn-l'
const SRC_RING = 'vdl-ring'; const LYR_RING = 'vdl-ring-l'
const SRC_PRI = 'vdl-pri'; const LYR_PRI = 'vdl-pri-l'
const SRC_HOF = 'vdl-hof'; const LYR_HOF = 'vdl-hof-l'
const SRC_LBL = 'vdl-lbl'; const LYR_LBL = 'vdl-lbl-l'
const SRC_SLBL = 'vdl-slbl'; const LYR_SLBL = 'vdl-slbl-l'
const SRC_PIN = 'vdl-pin'; const LYR_PIN = 'vdl-pin-l'
const SRC_REF = 'vdl-ref'; const LYR_REF = 'vdl-ref-l'

export default function Vdl2Datalink({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'STATIONS' | 'BEARERS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [bearerFilter, setBearerFilter] = useState<Bearer | 'ALL'>('ALL')
  const [query, setQuery] = useState('')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(450)
  const [rngMul, setRngMul] = useState(100)
  const [conMul, setConMul] = useState(100)
  const [latMul, setLatMul] = useState(100)
  const [rcpMul, setRcpMul] = useState(100)
  const [hofWin, setHofWin] = useState(15)
  const [phaseWt, setPhaseWt] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showStn, setShowStn] = useState(true)
  const [showRing, setShowRing] = useState(true)
  const [showPri, setShowPri] = useState(true)
  const [showHof, setShowHof] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showSlbl, setShowSlbl] = useState(true)
  const [showRef, setShowRef] = useState(false)
  const [showDiag, setShowDiag] = useState(true)

  const active = useMemo<Row[]>(() => {
    const out: Row[] = []
    const fl = (a: number) => a / 100
    for (const f of flights) {
      const fit = classify(f.type)
      if (fl(f.altitudeFt) < minFl || fl(f.altitudeFt) > maxFl) continue
      // phase classifier
      let phase: Phase = 'OTHER'
      if (f.ground) phase = 'TAXI'
      else if (f.altitudeFt < 12000) phase = 'TERMINAL'
      else if (f.altitudeFt >= 12000 && f.altitudeFt < 30000) phase = 'ENROUTE'
      else if (f.altitudeFt >= 30000) {
        // oceanic if more than 200 NM from any VDL-2 ground station
        let nearestVhf = Infinity
        for (const s of STATIONS) if (s.bearer === 'VDL2') { const d = distNmF(f, s); if (d < nearestVhf) nearestVhf = d }
        phase = nearestVhf > 220 * (rngMul / 100) ? 'OCEANIC' : 'ENROUTE'
      }

      // Find best primary station — bearer hierarchy: prefer VDL-2 if in range, else SBB/IRID, else HFDL
      let primary: GroundStation | undefined; let primaryD = Infinity
      let secondary: GroundStation | undefined; let secondaryD = Infinity
      const sortedByPref: Bearer[] = ['VDL2', 'SBB', 'IRID', 'HFDL']
      for (const b of sortedByPref) {
        if (bearerFilter !== 'ALL' && b !== bearerFilter) continue
        const ranked: { s: GroundStation; d: number }[] = []
        for (const s of STATIONS) {
          if (s.bearer !== b) continue
          const d = distNmF(f, s)
          const range = BEARER_RANGE_NM[b] * (s.range / BEARER_RANGE_NM[b]) * (rngMul / 100)
          if (d > range) continue
          ranked.push({ s, d })
        }
        ranked.sort((a, b) => a.d - b.d)
        if (ranked.length && !primary) { primary = ranked[0].s; primaryD = ranked[0].d }
        if (ranked.length >= 2 && !secondary) { secondary = ranked[1].s; secondaryD = ranked[1].d }
        if (primary && secondary) break
      }
      // If no secondary same-bearer, take next-bearer best
      if (primary && !secondary) {
        for (const b of sortedByPref) {
          if (b === primary.bearer) continue
          if (bearerFilter !== 'ALL' && b !== bearerFilter) continue
          let bestD = Infinity; let bestS: GroundStation | undefined
          for (const s of STATIONS) {
            if (s.bearer !== b) continue
            const d = distNmF(f, s)
            const range = BEARER_RANGE_NM[b] * (rngMul / 100)
            if (d > range) continue
            if (d < bestD) { bestD = d; bestS = s }
          }
          if (bestS) { secondary = bestS; secondaryD = bestD; break }
        }
      }

      const bearer = primary?.bearer
      const congestion = primary ? clamp(primary.congPct * (conMul / 100), 0, 100) : 0
      // expected latency: base * (1 + cong/100 * 1.2) * (1 + d/range*0.4) * latMul
      const range = bearer ? BEARER_RANGE_NM[bearer] : 200
      const expLatS = primary && bearer
        ? BEARER_BASE_LAT_S[bearer] * (1 + congestion / 100 * 1.2) * (1 + (primaryD / Math.max(50, range)) * 0.4) * (latMul / 100)
        : 999
      const expLossPct = primary && bearer
        ? clamp(BEARER_BASE_LOSS[bearer] * (1 + congestion / 100 * 1.5) + (fnv1a(f.icao + bearer) % 100) / 100 * 2, 0, 25)
        : 100
      const rcpTarget = FIT_RCP[fit] * (rcpMul / 100)
      const rspTarget = FIT_RSP[fit] * (rcpMul / 100)

      // Handoff ETA = (range - distance)/velocityKts*60 if approaching range edge, else infinite
      const handoffETA = primary && f.velocityKts > 60
        ? clamp((range * (rngMul / 100) - primaryD) / f.velocityKts * 60, 0, 999)
        : 999

      // 6 drivers
      const avl = primary ? 0 : 100  // availability
      const lat = primary ? clamp((expLatS - rcpTarget * 0.5) / Math.max(1, rcpTarget * 0.5) * 100, 0, 100) : 100
      const con = primary ? clamp(congestion, 0, 100) : 0
      const bch = (() => {
        // bearer-mismatch: ATN-B2 expects VDL-2 priority, FANS in oceanic expects SBB, OOEP gets 100
        if (fit === 'OOEP') return 100
        if (!primary) return 100
        if (fit === 'ATN-B2' && primary.bearer !== 'VDL2' && phase !== 'OCEANIC') return 60
        if (fit === 'LEGACY' && primary.bearer === 'HFDL') return 75
        return 0
      })()
      const hof = primary && handoffETA <= hofWin ? clamp(100 - (handoffETA / hofWin) * 100, 0, 100) : 0
      const los = primary ? clamp(expLossPct / 10 * 100, 0, 100) : 100

      let score = Math.max(avl * 1.05, lat * 1.10, con * 0.95, bch * 0.85, hof * 0.85, los * 0.95)
      score = score * (PHASE_MUL[phase] * (phaseWt / 100))
      score = clamp(score, 0, 100)

      let driver: Row['driver'] = 'NONE'
      const mx = Math.max(avl, lat, con, bch, hof, los)
      if (mx === avl && avl > 0) driver = 'AVL'
      else if (mx === lat && lat > 0) driver = 'LAT'
      else if (mx === con && con > 0) driver = 'CON'
      else if (mx === bch && bch > 0) driver = 'BCH'
      else if (mx === hof && hof > 0) driver = 'HOF'
      else if (mx === los && los > 0) driver = 'LOS'

      let tier: Tier
      if (!primary && phase !== 'TAXI') tier = 'OUT-OF-CONTACT'
      else if (primary && expLatS > rcpTarget) tier = 'RCP-BREACH'
      else if (score >= 70) tier = 'CONGESTED'
      else if (score >= 30) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, fit,
        primary, secondary,
        distNm: primary ? primaryD : 999,
        distSecNm: secondary ? secondaryD : 999,
        bearer, expLatS, expLossPct, rcpTarget, rspTarget,
        phase, congestion, handoffETA,
        driver, avl, lat, con, bch, hof, los, score, tier,
      })
    }
    return out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [flights, minFl, maxFl, rngMul, conMul, latMul, rcpMul, hofWin, phaseWt, bearerFilter])

  const tierCount: Record<Tier, number> = { 'OUT-OF-CONTACT': 0, 'RCP-BREACH': 0, CONGESTED: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const r of active) tierCount[r.tier]++
  const worst = active[0]
  const linked = active.filter(r => r.primary)
  const meanLat = linked.length ? linked.reduce((s, r) => s + r.expLatS, 0) / linked.length : 0
  const meanCong = linked.length ? linked.reduce((s, r) => s + r.congestion, 0) / linked.length : 0
  const ooc = tierCount['OUT-OF-CONTACT']
  const rcpBreach = tierCount['RCP-BREACH']
  const vdl2Count = active.filter(r => r.bearer === 'VDL2').length
  const satCount = active.filter(r => r.bearer === 'SBB' || r.bearer === 'IRID').length

  const filtered = active.filter(r => {
    if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
    if (query) {
      const q = query.toLowerCase()
      const hay = `${r.f.callsign || ''} ${r.f.icao} ${r.f.type || ''} ${r.primary?.id || ''} ${r.primary?.name || ''} ${r.primary?.icao || ''} ${r.bearer || ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  /* per-station rollup */
  const stationRows = useMemo(() => {
    const m = new Map<string, { s: GroundStation; ac: number; ooc: number; rcp: number; cong: number; meanScore: number; worst?: Row }>()
    for (const s of STATIONS) m.set(s.id, { s, ac: 0, ooc: 0, rcp: 0, cong: 0, meanScore: 0 })
    for (const r of active) {
      if (r.primary) {
        const e = m.get(r.primary.id)!
        e.ac++
        if (r.tier === 'OUT-OF-CONTACT') e.ooc++
        if (r.tier === 'RCP-BREACH') e.rcp++
        if (r.tier === 'CONGESTED') e.cong++
        e.meanScore += r.score
        if (!e.worst || r.score > e.worst.score) e.worst = r
      }
    }
    const out = Array.from(m.values()).map(v => ({ ...v, meanScore: v.ac ? v.meanScore / v.ac : 0 }))
    return out.sort((a, b) => b.rcp - a.rcp || b.ac - a.ac || b.meanScore - a.meanScore)
  }, [active])

  /* per-bearer rollup */
  const bearerRows = useMemo(() => {
    const m = new Map<Bearer, { b: Bearer; stns: number; ac: number; rcp: number; cong: number; meanLat: number; meanScore: number }>()
    for (const b of ['VDL2', 'SBB', 'IRID', 'HFDL'] as Bearer[]) m.set(b, { b, stns: 0, ac: 0, rcp: 0, cong: 0, meanLat: 0, meanScore: 0 })
    for (const s of STATIONS) m.get(s.bearer)!.stns++
    for (const r of active) {
      if (r.bearer) {
        const e = m.get(r.bearer)!
        e.ac++
        e.meanLat += r.expLatS
        e.meanScore += r.score
        if (r.tier === 'RCP-BREACH') e.rcp++
        if (r.tier === 'CONGESTED') e.cong++
      }
    }
    return Array.from(m.values()).map(v => ({ ...v, meanLat: v.ac ? v.meanLat / v.ac : 0, meanScore: v.ac ? v.meanScore / v.ac : 0 }))
  }, [active])

  useEffect(() => {
    if (!map) return
    for (const [src, lyr, type, paint, layout] of ([
      [SRC_REF, LYR_REF, 'line', { 'line-color': '#0ea5e955', 'line-width': 0.5, 'line-dasharray': [3, 4] }, null],
      [SRC_RING, LYR_RING, 'line', { 'line-color': ['get', 'color'], 'line-width': 0.7, 'line-dasharray': [3, 4], 'line-opacity': 0.40 }, null],
      [SRC_PRI, LYR_PRI, 'line', { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.75 }, null],
      [SRC_HOF, LYR_HOF, 'line', { 'line-color': ['get', 'color'], 'line-width': 1.0, 'line-dasharray': [2, 2], 'line-opacity': 0.7 }, null],
      [SRC_STN, LYR_STN, 'circle', { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 3, 6, 7], 'circle-color': ['get', 'color'], 'circle-opacity': 0.85, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 0.8 }, null],
      [SRC_HALO, LYR_HALO, 'circle', { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.28, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.2, 'circle-stroke-opacity': 0.85 }, null],
      [SRC_PIN, LYR_PIN, 'circle', { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1 }, null],
      [SRC_SLBL, LYR_SLBL, 'symbol', { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 }, { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, -1.4], 'text-allow-overlap': true }],
      [SRC_LBL, LYR_LBL, 'symbol', { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.4 }, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': true }],
    ] as Array<[string, string, string, any, any]>)) {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      if (!map.getLayer(lyr)) {
        const def: any = { id: lyr, type, source: src, paint }
        if (layout) def.layout = layout
        map.addLayer(def)
      }
    }
    const stn: any[] = []; const slbl: any[] = []; const ring: any[] = []; const halo: any[] = []; const pin: any[] = []; const pri: any[] = []; const hof: any[] = []; const lbl: any[] = []; const ref: any[] = []

    if (showStn) {
      for (const s of STATIONS) {
        if (bearerFilter !== 'ALL' && s.bearer !== bearerFilter) continue
        const color = BEARER_COLOR[s.bearer]
        stn.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { color } })
        if (showSlbl) slbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { color, label: `${s.id} · ${s.bearer}${s.freqKhz ? ' ' + (s.freqKhz / 1000).toFixed(3) : ''} · ${s.congPct}%` } })
        if (showRing) {
          // approximate range ring as 24-segment circle
          const coords: [number, number][] = []
          const rNm = s.range * (rngMul / 100)
          const R = 3440.065
          const la1 = s.lat * Math.PI / 180
          for (let a = 0; a <= 360; a += 15) {
            const br = a * Math.PI / 180
            const dr = rNm / R
            const la2 = Math.asin(Math.sin(la1) * Math.cos(dr) + Math.cos(la1) * Math.sin(dr) * Math.cos(br))
            const lo1 = s.lng * Math.PI / 180
            const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(la1), Math.cos(dr) - Math.sin(la1) * Math.sin(la2))
            coords.push([((lo2 * 180 / Math.PI + 540) % 360) - 180, la2 * 180 / Math.PI])
          }
          ring.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { color } })
        }
      }
    }
    for (const r of active) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'OK' && r.tier !== 'IDLE') {
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: 8 + r.score * 0.14 } })
      }
      if (r.tier === 'OUT-OF-CONTACT' || r.tier === 'RCP-BREACH') {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color } })
      }
      if (showLbl && r.tier !== 'OK' && r.tier !== 'IDLE') {
        const lab = `${r.f.callsign || r.f.icao} · ${r.tier}${r.bearer ? ' · ' + r.bearer : ''}${r.expLatS < 900 ? ' · ' + r.expLatS.toFixed(0) + 's' : ''}`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { label: lab, color } })
      }
      if (showPri && r.primary && r.tier !== 'OK') {
        pri.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.primary.lng, r.primary.lat]] }, properties: { color } })
      }
      if (showHof && r.secondary && r.handoffETA <= hofWin) {
        hof.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.secondary.lng, r.secondary.lat]] }, properties: { color: '#0ea5e9' } })
      }
    }
    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        ref.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }
    ;(map.getSource(SRC_STN) as any).setData({ type: 'FeatureCollection', features: stn })
    ;(map.getSource(SRC_SLBL) as any).setData({ type: 'FeatureCollection', features: slbl })
    ;(map.getSource(SRC_RING) as any).setData({ type: 'FeatureCollection', features: ring })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_PRI) as any).setData({ type: 'FeatureCollection', features: pri })
    ;(map.getSource(SRC_HOF) as any).setData({ type: 'FeatureCollection', features: hof })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: ref })
    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_SLBL, LYR_PIN, LYR_HALO, LYR_HOF, LYR_PRI, LYR_STN, LYR_RING, LYR_REF]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_LBL, SRC_SLBL, SRC_PIN, SRC_HOF, SRC_PRI, SRC_STN, SRC_RING, SRC_REF]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, active, showHalo, showStn, showRing, showPri, showHof, showLbl, showSlbl, showRef, bearerFilter, rngMul, hofWin])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const drvBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (r: Row) => {
    if (!r.primary) return r.phase === 'OCEANIC' ? 'OUT-OF-CONTACT · oceanic · attempt SATCOM voice IRIDIUM 5G · request HFDL primary frequency per ARINC 635-4 · file ASRS per AC 20-140C' : 'OUT-OF-CONTACT · no datalink ground station in range · attempt VHF 121.5 per JO 7110.65 §10-4-4 lost-comms procedure'
    if (r.tier === 'RCP-BREACH') return `RCP-${r.rcpTarget}/RSP-${r.rspTarget} BREACH · expected latency ${r.expLatS.toFixed(0)}s exceeds allocation · revert to voice via ${r.bearer === 'VDL2' ? 'VHF' : 'SATCOM'} per Doc 9869 PBCS §4.5 · log datalink event per CRA 29/2009`
    if (r.tier === 'CONGESTED') return `${r.primary.network} ${r.bearer} channel congested ${r.congestion.toFixed(0)}% · expect retry delay · monitor secondary ${r.secondary?.id || 'none'} for handoff candidate per ARINC 631 §5.6`
    if (r.tier === 'WATCH') return `Datalink nominal · monitor handoff window ${r.handoffETA < 999 ? r.handoffETA.toFixed(0) + ' min to ' + (r.secondary?.id || '—') : 'no handoff'} per ARINC 631 ground-station selection`
    if (r.tier === 'OK') return `Datalink stable · ${r.bearer} via ${r.primary.id} · latency ${r.expLatS.toFixed(1)}s within RCP-${r.rcpTarget}`
    return ''
  }

  /* Scatter: latency vs congestion */
  const W = 280, H = 180
  const sx = (n: number) => 32 + clamp(n, 0, 60) / 60 * (W - 42)
  const sy = (n: number) => H - 24 - clamp(n, 0, 100) / 100 * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">VDL-2 / FANS-1A · Datalink Monitor</div>
          <div className="text-[10px] text-slate-500">DO-281B · ED-92B · ARINC 631-7 · ICAO Doc 9880/9869 · AC 20-140C</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[8px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean lat</div>
          <div className="text-sm font-semibold" style={{ color: meanLat >= 60 ? '#ef4444' : meanLat >= 30 ? '#f59e0b' : '#10b981' }}>{meanLat.toFixed(1)}s</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">OOC</div>
          <div className="text-sm font-semibold" style={{ color: ooc > 0 ? '#ef4444' : '#10b981' }}>{ooc}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">RCP brk</div>
          <div className="text-xs font-semibold" style={{ color: rcpBreach > 0 ? '#f43f5e' : '#10b981' }}>{rcpBreach}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean cong</div>
          <div className="text-xs font-semibold" style={{ color: meanCong >= 70 ? '#ef4444' : meanCong >= 45 ? '#f59e0b' : '#10b981' }}>{meanCong.toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">VDL/SAT</div>
          <div className="text-xs font-semibold text-sky-400">{vdl2Count}/{satCount}</div>
        </div>
      </div>

      {showDiag && active.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            <rect x={sx(30)} y={sy(100)} width={sx(60) - sx(30)} height={sy(70) - sy(100)} fill="#ef444425" />
            <rect x={sx(15)} y={sy(100)} width={sx(30) - sx(15)} height={sy(45) - sy(100)} fill="#f59e0b22" />
            <line x1={sx(0)} y1={sy(70)} x2={sx(60)} y2={sy(70)} stroke="#475569" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(30)} y1={sy(0)} x2={sx(30)} y2={sy(100)} stroke="#f43f5e66" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={W / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="#64748b">Latency (s)</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>Congestion (%)</text>
            {active.filter(r => r.primary).map((r, i) => (
              <circle key={i} cx={sx(r.expLatS)} cy={sy(r.congestion)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['MIN-FL', minFl, 0, 400, setMinFl, ''],
            ['MAX-FL', maxFl, 50, 500, setMaxFl, ''],
            ['RNG-MUL', rngMul, 50, 200, setRngMul, '%'],
            ['CON-MUL', conMul, 50, 200, setConMul, '%'],
            ['LAT-MUL', latMul, 50, 250, setLatMul, '%'],
            ['RCP-MUL', rcpMul, 50, 200, setRcpMul, '%'],
            ['HOF-WIN', hofWin, 2, 60, setHofWin, 'm'],
            ['PHASE-WT', phaseWt, 50, 150, setPhaseWt, '%'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[40px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['VDL2', 'SBB', 'IRID', 'HFDL'] as Bearer[]).map(k => (
            <button key={k} onClick={() => setBearerFilter(bearerFilter === k ? 'ALL' : k)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: bearerFilter === k ? BEARER_COLOR[k] + '33' : '#0b1220', borderColor: bearerFilter === k ? BEARER_COLOR[k] : '#1e293b', color: bearerFilter === k ? BEARER_COLOR[k] : '#cbd5e1' }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['STN', showStn, setShowStn],
            ['RING', showRing, setShowRing],
            ['PRI', showPri, setShowPri],
            ['HOF', showHof, setShowHof],
            ['LBL', showLbl, setShowLbl],
            ['SLBL', showSlbl, setShowSlbl],
            ['REF', showRef, setShowRef],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / station / bearer" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'STATIONS', 'BEARERS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'AIRCRAFT' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No aircraft match filters</div>}
          {filtered.map(r => (
            <div key={r.f.icao} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(r.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 truncate">{r.f.callsign || r.f.icao}</span>
                  <span className="text-[10px] text-slate-500 font-mono">{r.f.type || '—'}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: FIT_COLOR[r.fit], backgroundColor: FIT_COLOR[r.fit] + '1a', border: `1px solid ${FIT_COLOR[r.fit]}66` }}>{r.fit}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono text-sky-300 bg-sky-500/10 border border-sky-500/40">{r.phase}</span>
                  {r.bearer && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: BEARER_COLOR[r.bearer], backgroundColor: BEARER_COLOR[r.bearer] + '1a', border: `1px solid ${BEARER_COLOR[r.bearer]}66` }}>{r.bearer}</span>}
                </div>
                {tierBadge(r.tier)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                {r.primary ? `${r.primary.id} · ${r.distNm.toFixed(0)}nm · cong ${r.congestion.toFixed(0)}% · ` : 'no station · '}
                <span style={{ color: r.expLatS >= r.rcpTarget ? '#ef4444' : r.expLatS >= r.rcpTarget * 0.7 ? '#f59e0b' : '#10b981' }}>{r.expLatS < 900 ? r.expLatS.toFixed(1) + 's' : '—'}</span>
                {' / RCP-'}<span className="text-slate-300">{r.rcpTarget.toFixed(0)}</span>
                {r.secondary && r.handoffETA <= hofWin && (<span className="text-sky-400"> · HOF {r.handoffETA.toFixed(0)}m → {r.secondary.id}</span>)}
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {drvBadge('AVL', r.avl)}
                {drvBadge('LAT', r.lat)}
                {drvBadge('CON', r.con)}
                {drvBadge('BCH', r.bch)}
                {drvBadge('HOF', r.hof)}
                {drvBadge('LOS', r.los)}
              </div>
              <div className="text-[10px] mt-1" style={{ color: TIER_COLOR[r.tier] }}>{advice(r)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'STATIONS' && (
        <div className="divide-y divide-slate-800">
          {stationRows.map((e, i) => (
            <div key={i} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => e.worst && onFly(e.worst.f.icao)} style={{ borderLeft: `3px solid ${BEARER_COLOR[e.s.bearer]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 font-mono">{e.s.id}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: BEARER_COLOR[e.s.bearer], backgroundColor: BEARER_COLOR[e.s.bearer] + '1a', border: `1px solid ${BEARER_COLOR[e.s.bearer]}66` }}>{e.s.bearer}</span>
                  <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] text-slate-300 bg-slate-800 border border-slate-700 font-mono">{e.s.network}</span>
                </div>
                <div className="text-[10px] text-slate-400">{e.ac} ac</div>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                {e.s.name} · {e.s.freqKhz ? (e.s.freqKhz / 1000).toFixed(3) + ' MHz' : 'SAT'} · range {e.s.range}nm · cong <span style={{ color: e.s.congPct >= 70 ? '#ef4444' : e.s.congPct >= 45 ? '#f59e0b' : '#10b981' }}>{e.s.congPct}%</span> · load {e.s.loadPct}%
              </div>
              <div className="flex items-center gap-2 mt-1">
                {e.ooc > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/40">OOC {e.ooc}</span>}
                {e.rcp > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: '#f43f5e', backgroundColor: '#f43f5e1a', border: '1px solid #f43f5e66' }}>RCP {e.rcp}</span>}
                {e.cong > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/40">CONG {e.cong}</span>}
                <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${e.meanScore}%`, backgroundColor: e.meanScore >= 70 ? '#ef4444' : e.meanScore >= 45 ? '#f59e0b' : e.meanScore >= 25 ? '#0ea5e9' : '#10b981' }} /></div>
                <span className="text-[10px] text-slate-400 tabular-nums w-8 text-right">{e.meanScore.toFixed(0)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'BEARERS' && (
        <div className="divide-y divide-slate-800">
          {bearerRows.map((b, i) => (
            <div key={i} className="px-3 py-2" style={{ borderLeft: `3px solid ${BEARER_COLOR[b.b]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-slate-100 font-mono">{b.b}</span>
                  <span className="text-[10px] text-slate-500">{b.stns} stns</span>
                </div>
                <div className="text-[10px] text-slate-400">{b.ac} ac</div>
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5 font-mono">
                base-lat {BEARER_BASE_LAT_S[b.b]}s · base-loss {BEARER_BASE_LOSS[b.b]}% · range {BEARER_RANGE_NM[b.b]}nm · mean-lat <span style={{ color: b.meanLat >= 60 ? '#ef4444' : b.meanLat >= 30 ? '#f59e0b' : '#10b981' }}>{b.meanLat.toFixed(1)}s</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                {b.rcp > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: '#f43f5e', backgroundColor: '#f43f5e1a', border: '1px solid #f43f5e66' }}>RCP {b.rcp}</span>}
                {b.cong > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/40">CONG {b.cong}</span>}
                <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${b.meanScore}%`, backgroundColor: b.meanScore >= 70 ? '#ef4444' : b.meanScore >= 45 ? '#f59e0b' : b.meanScore >= 25 ? '#0ea5e9' : '#10b981' }} /></div>
                <span className="text-[10px] text-slate-400 tabular-nums w-8 text-right">{b.meanScore.toFixed(0)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 leading-tight">
        RTCA DO-281B · EUROCAE ED-92B · ARINC 631-7 / 622-4 / 620 / 635-4 · ICAO Doc 9880 ATN · Doc 9869 PBCS RCP/RSP · Annex 10 Vol III §6 · Doc 4444 §4.12 / §14 · FAA AC 20-140C / 90-117 · EU 29/2009 DLS · NTSB SAFO 13003
      </div>
    </div>
  )
}
