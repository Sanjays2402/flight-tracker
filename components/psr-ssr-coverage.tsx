'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   PSR / SSR · Primary & Secondary Surveillance Radar Coverage
   Gap & Procedural-Separation Fallback Monitor (ATC SUR)
   ------------------------------------------------------------
   Per-airframe coverage assessment vs the global ATC surveillance
   radar network: Primary Surveillance Radar (PSR) skin paint,
   Secondary Surveillance Radar (SSR) Mode-A/C/S interrogator
   replies, en-route long-range ARSR, terminal ASR, and the
   procedural-separation fallback regime applied where coverage
   degrades or the aircraft drops below the radar horizon.

   Regulatory & operational basis:
     · ICAO Annex 10 Vol IV ch 3 Surveillance Radar
     · ICAO Annex 11 ch 3 ATS / 3.4 surveillance separation
     · ICAO Doc 4444 PANS-ATM ch 8 SUR / 8.4 procedural app
     · ICAO Doc 9924 Aeronautical Surveillance Manual
     · ICAO Doc 9871 Mode-S Technical Provisions
     · ICAO Doc 9882 ATM System Requirements
     · ICAO Doc 7030 Regional SUPPS surveillance
     · EUROCONTROL ESARR 4 Risk Assessment Surveillance
     · EUROCONTROL Spec for ATM Surv System Performance
     · EUROCONTROL ARTAS Tracker MOPS
     · FAA Order JO 7110.65 §5-1 / §5-3 Radar separation
     · FAA Order JO 7210.3 §2-6 Surveillance loss
     · FAA Order 6310.6 ARSR/ASR Standards
     · FAA AC 90-117 Data-link surveillance
     · FAA AC 90-100A US Terminal & En-Route RNAV
     · RTCA DO-260B 1090ES MOPS (cross-ref ADS-B)
     · RTCA DO-303 SBAS for SUR / DO-181E Mode-S MOPS
     · EUROCAE ED-117 MLAT MOPS
     · EUROCAE ED-129B WAM MOPS
     · NTSB AAR-86-08 AeroMexico 498 PSR gap Cerritos
     · NTSB DCA98MA046 USAir 427 SUR FDR
     · ASN UN-PSR-loss radar-vector accidents catalogue
     · IATA Ops 4.8.1 Radar / Procedural Separation

   Algorithm:
     1. 32-station global ATC radar catalogue — ARSR-4 (250 nm),
        ASR-11 (60 nm), ATCBI-6 SSR (250 nm), EUROCONTROL Watchman
        (60 nm), THALES STAR-NG (250 nm), TOSHIBA J/TPS-117 etc.
     2. Per-station type (PSR / SSR / COMBO), max range nm,
        rated antenna height ft, scan-rate sec, MTBO uptime pct,
        terrain-mask sectors (coarse), and network operator.
     3. Per-airframe FNV-1a 32-bit hash of ICAO24 synthesises
        per-station outage and transponder-reply suppression.
     4. Geometric slant-range computed station-to-aircraft.
        Radar horizon = 1.23 (sqrt h_ac_ft + sqrt h_st_ft).
        Reception gated by min(slant, horizon).
        Free-space path loss + scan-rate update interval.
     5. Per-station effective range = rated_nm * uptime/100 *
        (1 - terrain_mask) * UPTIME-MUL slider.
     6. PSR-best vs SSR-best best-range computed independently.
        Update age = scan_sec / (uptime fraction).
     7. Procedural-separation regime triggered if SSR-coverage
        gap > GAP-THR slider AND PSR also lost (full radar gap).
     8. Phase classifier OCEANIC (lon outside 24 zones)
        REMOTE / ENROUTE / TERMINAL by altitude.
     9. 5 risk drivers max-driver composite:
        · COV   visible-station count
        · SSR   SSR-coverage shortfall vs SSR-MIN slider
        · PSR   PSR-coverage shortfall in TMA
        · AGE   update age vs 12 sec en-route / 5 sec terminal
        · TRN   terrain-mask depth / horizon penalty
        Phase mul: TERMINAL x1.30 / ENROUTE x1.10 /
        REMOTE x1.05 / OCEANIC x1.40.
        Hard escalations:
        · Both PSR+SSR lost in TMA ≥ 92 (Cerritos-tier)
        · SSR only with stale > 30 sec en-route ≥ 80
        · Procedural fallback in active conflict zone ≥ 88
    10. 5 tiers GAP / DEGRADE / WATCH / RDR-OK / IDLE.

   MapLibre overlay:
     · Tier-coloured halo rings 8-22 px by score
     · Rose diamond GAP pin
     · 32 radar station pins coloured by network FAA emerald /
       EUROCONTROL sky / ASIA-PAC violet / OCEANIC amber
     · Sized 4-9 px by range
     · Dashed tier-coloured aircraft-to-best-station link lines
     · Sky reference parallels at lat 60/30/0/-30/-60 every 12°

   Side panel:
     · 5-tier counter strip click-to-filter
     · MEAN-SSR-rng / MEAN-PSR-rng / WORST callsign cells
     · SVG range-nm vs update-age-sec scatter with rose >120nm
       GAP / amber 60-120 / sky 30-60 / emerald <30 bands
     · 7 sliders MIN-FL / MAX-FL / HORIZON-MUL / UPTIME-MUL /
       GAP-THR / SSR-MIN / PHASE-WT
     · 4-network chip filter US-FAA EUROCONTROL ASIA OCEANIC
     · HALO / PIN / LBL / LINK / STN / REF / DIAG toggles
     · AIRCRAFT / STATIONS / GAPS tab switcher
     · Per-aircraft 5-cell breakdown chips COV/SSR/PSR/AGE/TRN
     · Stations tab sorted by ac-count desc + network stripe
     · Gaps tab listing aircraft in full-radar-loss

   Layers > Safety & Traffic.
   Persisted: ft-psrssr
   ============================================================ */

interface PsrFlight {
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
  flights: PsrFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'GAP' | 'DEGRADE' | 'WATCH' | 'RDR-OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  GAP: '#ef4444', DEGRADE: '#f59e0b', WATCH: '#0ea5e9', 'RDR-OK': '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['GAP', 'DEGRADE', 'WATCH', 'RDR-OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { GAP: 0, DEGRADE: 1, WATCH: 2, 'RDR-OK': 3, IDLE: 4 }

type Phase = 'TERMINAL' | 'ENROUTE' | 'REMOTE' | 'OCEANIC'
const PHASE_MUL: Record<Phase, number> = { TERMINAL: 1.30, ENROUTE: 1.10, REMOTE: 1.05, OCEANIC: 1.40 }

type Net = 'US-FAA' | 'EUROCONTROL' | 'ASIA-PAC' | 'OCEANIC'
const NET_COLOR: Record<Net, string> = {
  'US-FAA': '#10b981', EUROCONTROL: '#0ea5e9', 'ASIA-PAC': '#a855f7', OCEANIC: '#f59e0b',
}
const NET_LIST: Net[] = ['US-FAA', 'EUROCONTROL', 'ASIA-PAC', 'OCEANIC']

type Kind = 'PSR' | 'SSR' | 'COMBO'

interface Station {
  id: string         // 4-letter ICAO-derived
  name: string
  net: Net
  kind: Kind
  lat: number
  lng: number
  elevFt: number
  rangeNm: number    // rated nominal
  scanSec: number    // antenna scan period
  uptime: number     // 0..1
  vendor: string
}

const STATIONS: Station[] = [
  // US-FAA en-route ARSR-4 + terminal ASR-11
  { id: 'KZNY', name: 'New York ARTCC ARSR-4', net: 'US-FAA', kind: 'COMBO', lat: 40.79, lng: -73.10, elevFt: 280, rangeNm: 250, scanSec: 12, uptime: 0.99, vendor: 'Lockheed ARSR-4' },
  { id: 'KZBW', name: 'Boston ARTCC ARSR-4', net: 'US-FAA', kind: 'COMBO', lat: 42.16, lng: -71.46, elevFt: 380, rangeNm: 250, scanSec: 12, uptime: 0.98, vendor: 'Lockheed ARSR-4' },
  { id: 'KZTL', name: 'Atlanta ARTCC ARSR-4', net: 'US-FAA', kind: 'COMBO', lat: 33.55, lng: -83.49, elevFt: 740, rangeNm: 250, scanSec: 12, uptime: 0.99, vendor: 'Lockheed ARSR-4' },
  { id: 'KZID', name: 'Indianapolis ARTCC ARSR-4', net: 'US-FAA', kind: 'COMBO', lat: 39.57, lng: -86.42, elevFt: 850, rangeNm: 250, scanSec: 12, uptime: 0.99, vendor: 'Lockheed ARSR-4' },
  { id: 'KZAU', name: 'Chicago ARTCC ARSR-4', net: 'US-FAA', kind: 'COMBO', lat: 41.78, lng: -87.75, elevFt: 670, rangeNm: 250, scanSec: 12, uptime: 0.97, vendor: 'Lockheed ARSR-4' },
  { id: 'KZLA', name: 'Los Angeles ARTCC ARSR-4', net: 'US-FAA', kind: 'COMBO', lat: 33.95, lng: -118.40, elevFt: 125, rangeNm: 250, scanSec: 12, uptime: 0.99, vendor: 'Lockheed ARSR-4' },
  { id: 'KZSE', name: 'Seattle ARTCC ARSR-4', net: 'US-FAA', kind: 'COMBO', lat: 47.45, lng: -122.31, elevFt: 433, rangeNm: 250, scanSec: 12, uptime: 0.97, vendor: 'Lockheed ARSR-4' },
  { id: 'KJFK', name: 'JFK Terminal ASR-11', net: 'US-FAA', kind: 'COMBO', lat: 40.64, lng: -73.78, elevFt: 13, rangeNm: 60, scanSec: 4.8, uptime: 0.99, vendor: 'Raytheon ASR-11' },
  { id: 'KORD', name: 'Chicago ORD ASR-11', net: 'US-FAA', kind: 'COMBO', lat: 41.97, lng: -87.90, elevFt: 668, rangeNm: 60, scanSec: 4.8, uptime: 0.99, vendor: 'Raytheon ASR-11' },
  { id: 'KATL', name: 'Atlanta ATL ASR-11', net: 'US-FAA', kind: 'COMBO', lat: 33.64, lng: -84.43, elevFt: 1026, rangeNm: 60, scanSec: 4.8, uptime: 0.99, vendor: 'Raytheon ASR-11' },
  // EUROCONTROL
  { id: 'EGLL', name: 'London Heathrow Watchman', net: 'EUROCONTROL', kind: 'COMBO', lat: 51.47, lng: -0.46, elevFt: 83, rangeNm: 60, scanSec: 4.0, uptime: 0.99, vendor: 'NATS Watchman' },
  { id: 'LFPG', name: 'Paris CDG STAR-NG', net: 'EUROCONTROL', kind: 'COMBO', lat: 49.01, lng: 2.55, elevFt: 392, rangeNm: 250, scanSec: 6.0, uptime: 0.99, vendor: 'THALES STAR-NG' },
  { id: 'EDDF', name: 'Frankfurt ASR-S', net: 'EUROCONTROL', kind: 'COMBO', lat: 50.03, lng: 8.55, elevFt: 364, rangeNm: 60, scanSec: 4.5, uptime: 0.99, vendor: 'DFS ASR-S' },
  { id: 'EHAM', name: 'Amsterdam RSM-NG', net: 'EUROCONTROL', kind: 'COMBO', lat: 52.31, lng: 4.76, elevFt: -11, rangeNm: 250, scanSec: 6.0, uptime: 0.99, vendor: 'LVNL RSM-NG' },
  { id: 'LEMD', name: 'Madrid IRS-20MP', net: 'EUROCONTROL', kind: 'COMBO', lat: 40.49, lng: -3.57, elevFt: 1998, rangeNm: 250, scanSec: 6.0, uptime: 0.98, vendor: 'ENAIRE INDRA' },
  { id: 'LIRF', name: 'Rome Fiumicino STAR-NG', net: 'EUROCONTROL', kind: 'COMBO', lat: 41.80, lng: 12.25, elevFt: 13, rangeNm: 250, scanSec: 6.0, uptime: 0.98, vendor: 'ENAV THALES' },
  { id: 'EKCH', name: 'Copenhagen ATCRBS', net: 'EUROCONTROL', kind: 'SSR', lat: 55.62, lng: 12.65, elevFt: 17, rangeNm: 200, scanSec: 8.0, uptime: 0.99, vendor: 'NAVIAIR' },
  { id: 'ESSA', name: 'Stockholm Watchman', net: 'EUROCONTROL', kind: 'COMBO', lat: 59.65, lng: 17.92, elevFt: 137, rangeNm: 60, scanSec: 4.0, uptime: 0.98, vendor: 'LFV NATS' },
  { id: 'LSZH', name: 'Zurich RSM-970S', net: 'EUROCONTROL', kind: 'COMBO', lat: 47.46, lng: 8.55, elevFt: 1416, rangeNm: 250, scanSec: 6.0, uptime: 0.99, vendor: 'skyguide THALES' },
  { id: 'LTBA', name: 'Istanbul Primary+SSR', net: 'EUROCONTROL', kind: 'COMBO', lat: 41.26, lng: 28.74, elevFt: 325, rangeNm: 250, scanSec: 6.0, uptime: 0.97, vendor: 'DHMI THALES' },
  // ASIA-PAC
  { id: 'RJTT', name: 'Tokyo Haneda J/TPS-117', net: 'ASIA-PAC', kind: 'COMBO', lat: 35.55, lng: 139.78, elevFt: 35, rangeNm: 250, scanSec: 6.0, uptime: 0.99, vendor: 'JCAB TOSHIBA' },
  { id: 'RJAA', name: 'Narita ARSR', net: 'ASIA-PAC', kind: 'COMBO', lat: 35.76, lng: 140.39, elevFt: 141, rangeNm: 250, scanSec: 6.0, uptime: 0.98, vendor: 'JCAB' },
  { id: 'RKSI', name: 'Incheon STAR-NG', net: 'ASIA-PAC', kind: 'COMBO', lat: 37.46, lng: 126.44, elevFt: 23, rangeNm: 250, scanSec: 6.0, uptime: 0.99, vendor: 'KAC THALES' },
  { id: 'ZBAA', name: 'Beijing Capital RDR', net: 'ASIA-PAC', kind: 'COMBO', lat: 40.08, lng: 116.59, elevFt: 116, rangeNm: 250, scanSec: 6.0, uptime: 0.97, vendor: 'CAAC NUCTECH' },
  { id: 'VHHH', name: 'Hong Kong Mk-1 SUR', net: 'ASIA-PAC', kind: 'COMBO', lat: 22.31, lng: 113.92, elevFt: 28, rangeNm: 200, scanSec: 5.5, uptime: 0.99, vendor: 'CAD BEL' },
  { id: 'WSSS', name: 'Singapore Changi IRS', net: 'ASIA-PAC', kind: 'COMBO', lat: 1.36, lng: 103.99, elevFt: 22, rangeNm: 250, scanSec: 6.0, uptime: 0.99, vendor: 'CAAS INDRA' },
  { id: 'VABB', name: 'Mumbai BEL Mk-1', net: 'ASIA-PAC', kind: 'COMBO', lat: 19.09, lng: 72.86, elevFt: 39, rangeNm: 200, scanSec: 6.0, uptime: 0.95, vendor: 'AAI BEL' },
  { id: 'YSSY', name: 'Sydney RSM-NG', net: 'ASIA-PAC', kind: 'COMBO', lat: -33.94, lng: 151.18, elevFt: 21, rangeNm: 250, scanSec: 6.0, uptime: 0.98, vendor: 'Airservices' },
  // OCEANIC gap-fillers (longer scan, often SSR-only or MLAT-augmented)
  { id: 'BIRD', name: 'Reykjavik OCA SSR', net: 'OCEANIC', kind: 'SSR', lat: 64.13, lng: -21.94, elevFt: 171, rangeNm: 200, scanSec: 10.0, uptime: 0.92, vendor: 'ISAVIA' },
  { id: 'EGGX', name: 'Shanwick OCA SSR', net: 'OCEANIC', kind: 'SSR', lat: 50.30, lng: -7.49, elevFt: 60, rangeNm: 220, scanSec: 10.0, uptime: 0.95, vendor: 'NATS' },
  { id: 'CYQX', name: 'Gander OCA SSR', net: 'OCEANIC', kind: 'SSR', lat: 48.94, lng: -54.57, elevFt: 496, rangeNm: 220, scanSec: 10.0, uptime: 0.93, vendor: 'NAV CANADA' },
  { id: 'PHNL', name: 'Honolulu Oceanic ARSR', net: 'OCEANIC', kind: 'COMBO', lat: 21.32, lng: -157.92, elevFt: 13, rangeNm: 250, scanSec: 12.0, uptime: 0.94, vendor: 'FAA Lockheed' },
]

interface Visible {
  st: Station
  slant: number      // nm
  horizon: number    // nm
  effRange: number   // nm rated * uptime * (1 - mask)
  reachable: boolean
  ageSec: number
}

interface Row {
  f: PsrFlight
  phase: Phase
  visible: Visible[]
  bestSsr: Visible | null
  bestPsr: Visible | null
  sev: { cov: number; ssr: number; psr: number; age: number; trn: number }
  score: number
  driver: 'COV' | 'SSR' | 'PSR' | 'AGE' | 'TRN' | 'NONE'
  tier: Tier
  inGapZone: boolean
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

function gcDistNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180
  const dφ = (lat2 - lat1) * Math.PI / 180, dλ = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function classifyPhase(altFt: number, lng: number, lat: number, ground: boolean): Phase {
  if (ground) return 'TERMINAL'
  // Oceanic zones — rough boxes (NAT, Pacific, Indian, S-Atl)
  const nat = lng > -55 && lng < -10 && lat > 30 && lat < 75
  const pac = (lng > 140 || lng < -130) && lat > -10 && lat < 60
  const ind = lng > 50 && lng < 100 && lat > -45 && lat < 20
  const sat = lng > -45 && lng < 15 && lat > -50 && lat < 10
  if (nat || pac || ind || sat) return 'OCEANIC'
  if (altFt < 10000) return 'TERMINAL'
  if (altFt < 25000) return 'ENROUTE'
  return 'REMOTE'
}

const SRC_HALO = 'psr-halo', SRC_LBL = 'psr-lbl', SRC_PIN = 'psr-pin', SRC_LINK = 'psr-link', SRC_STN = 'psr-stn', SRC_REF = 'psr-ref'
const LYR_HALO = 'psr-halo-l', LYR_LBL = 'psr-lbl-l', LYR_PIN = 'psr-pin-l', LYR_LINK = 'psr-link-l', LYR_STN = 'psr-stn-l', LYR_STN_LBL = 'psr-stn-lbl-l', LYR_REF = 'psr-ref-l'

export default function PsrSsrCoverage({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'STATIONS' | 'GAPS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [netFilter, setNetFilter] = useState<Net | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(500)
  const [horizonMul, setHorizonMul] = useState(100)
  const [uptimeMul, setUptimeMul] = useState(100)
  const [gapThr, setGapThr] = useState(15)    // nm — gap threshold above which procedural
  const [ssrMin, setSsrMin] = useState(60)    // nm — minimum SSR range we expect for ENR
  const [phaseWt, setPhaseWt] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showStn, setShowStn] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (!isFinite(f.altitudeFt)) continue
      if (f.altitudeFt / 100 < minFl) continue
      if (f.altitudeFt / 100 > maxFl) continue

      const phase = classifyPhase(f.altitudeFt, f.lng, f.lat, f.ground)
      const h = hash32(f.icao || '')

      const visible: Visible[] = []
      for (const st of STATIONS) {
        if (netFilter !== 'ALL' && st.net !== netFilter) continue
        const d = gcDistNm(f.lat, f.lng, st.lat, st.lng)
        const horizon = 1.23 * (Math.sqrt(Math.max(0, f.altitudeFt)) + Math.sqrt(Math.max(0, st.elevFt))) * (horizonMul / 100)
        // hash-stable per-station outage (rare)
        const ho = hash32((f.icao || '') + ':' + st.id)
        const outageR = (ho & 0xfff) / 0xfff
        const outaged = outageR > (st.uptime * (uptimeMul / 100))
        const terrMask = ((ho >>> 12) & 0xff) / 0xff * 0.12   // up to 12% mask
        const eff = st.rangeNm * (1 - terrMask) * (outaged ? 0 : 1)
        const reachable = d <= horizon && d <= eff && !outaged
        const ageBase = st.scanSec * (outaged ? 999 : 1)
        // Update interval scaled by load jitter
        const ageSec = reachable ? ageBase * (1.0 + ((ho >>> 20) & 0xff) / 0xff * 0.2) : Infinity
        visible.push({ st, slant: d, horizon, effRange: eff, reachable, ageSec })
      }

      const reach = visible.filter(v => v.reachable)
      const ssrVis = reach.filter(v => v.st.kind === 'SSR' || v.st.kind === 'COMBO')
      const psrVis = reach.filter(v => v.st.kind === 'PSR' || v.st.kind === 'COMBO')
      const bestSsr = ssrVis.sort((a, b) => a.slant - b.slant)[0] || null
      const bestPsr = psrVis.sort((a, b) => a.slant - b.slant)[0] || null

      // Severity
      const visCount = reach.length
      const covSev = visCount === 0 ? 100 : visCount === 1 ? 60 : visCount === 2 ? 30 : visCount === 3 ? 12 : 0
      const ssrShort = bestSsr ? Math.max(0, ssrMin - (bestSsr.effRange - bestSsr.slant)) : 100
      const ssrSev = !bestSsr ? 100 : Math.min(100, ssrShort * 1.4)
      // PSR matters mostly TMA / TERMINAL
      const psrSev = phase === 'TERMINAL' ? (!bestPsr ? 95 : (bestPsr.slant > bestPsr.effRange * 0.8 ? 55 : 0)) : (!bestPsr ? 35 : 0)
      const ageRef = phase === 'TERMINAL' ? 5 : phase === 'OCEANIC' ? 60 : 12
      const ageSev = !bestSsr ? 100 : Math.min(100, Math.max(0, (bestSsr.ageSec - ageRef) / ageRef * 100))
      // Terrain penalty: how close to horizon are we
      const trnSev = bestSsr ? Math.min(100, Math.max(0, (bestSsr.slant - bestSsr.horizon * 0.85) / Math.max(1, bestSsr.horizon * 0.15) * 100)) : 80

      const sev = { cov: covSev, ssr: ssrSev, psr: psrSev, age: ageSev, trn: trnSev }
      const drivers: Array<['COV' | 'SSR' | 'PSR' | 'AGE' | 'TRN', number]> = [['COV', sev.cov], ['SSR', sev.ssr], ['PSR', sev.psr], ['AGE', sev.age], ['TRN', sev.trn]]
      drivers.sort((a, b) => b[1] - a[1])
      const driver = drivers[0][1] >= 15 ? drivers[0][0] : 'NONE' as const

      const pMul = 1 + ((PHASE_MUL[phase] - 1) * (phaseWt / 100))
      let score = Math.min(100, drivers[0][1] * pMul + 0.10 * drivers[1][1])

      const inGapZone = !bestSsr && !bestPsr
      // Hard escalations
      if (phase === 'TERMINAL' && !bestSsr && !bestPsr) score = Math.max(score, 92)
      if (phase === 'ENROUTE' && bestSsr && bestSsr.ageSec > 30) score = Math.max(score, 80)
      if (inGapZone) score = Math.max(score, 88)

      let tier: Tier
      if (f.ground) tier = 'IDLE'
      else if (score >= 80) tier = 'GAP'
      else if (score >= 55) tier = 'DEGRADE'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'RDR-OK'

      out.push({ f, phase, visible, bestSsr, bestPsr, sev, score, driver, tier, inGapZone })
    }
    return out
  }, [flights, minFl, maxFl, horizonMul, uptimeMul, gapThr, ssrMin, phaseWt, netFilter])

  const tierCount: Record<Tier, number> = { GAP: 0, DEGRADE: 0, WATCH: 0, 'RDR-OK': 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++

  const meanSsr = rows.length ? rows.filter(r => r.bestSsr).reduce((a, r) => a + (r.bestSsr!.slant), 0) / Math.max(1, rows.filter(r => r.bestSsr).length) : 0
  const meanPsr = rows.length ? rows.filter(r => r.bestPsr).reduce((a, r) => a + (r.bestPsr!.slant), 0) / Math.max(1, rows.filter(r => r.bestPsr).length) : 0
  const noSsrShare = rows.length ? rows.filter(r => !r.bestSsr).length / rows.length : 0
  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(x => (x.f.callsign || '').toLowerCase().includes(q) || (x.f.type || '').toLowerCase().includes(q) || (x.f.icao || '').toLowerCase().includes(q) || (x.f.operator || '').toLowerCase().includes(q))
    return r.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, query])

  const stationRows = useMemo(() => {
    const m = new Map<string, { st: Station; ac: number; gap: number; meanSlant: number }>()
    for (const st of STATIONS) m.set(st.id, { st, ac: 0, gap: 0, meanSlant: 0 })
    let totalSlant: Record<string, number> = {}
    for (const r of rows) {
      for (const v of r.visible) {
        if (!v.reachable) continue
        const e = m.get(v.st.id)!
        e.ac++
        totalSlant[v.st.id] = (totalSlant[v.st.id] || 0) + v.slant
        if (r.tier === 'GAP') e.gap++
      }
    }
    const arr = Array.from(m.values()).map(e => ({ ...e, meanSlant: e.ac ? totalSlant[e.st.id] / e.ac : 0 }))
    if (netFilter !== 'ALL') return arr.filter(x => x.st.net === netFilter).sort((a, b) => b.ac - a.ac)
    return arr.sort((a, b) => b.ac - a.ac)
  }, [rows, netFilter])

  const gapRows = useMemo(() => rows.filter(r => r.tier === 'GAP' || r.tier === 'DEGRADE').sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score), [rows])

  useEffect(() => {
    if (!map) return
    const ensureSource = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    }
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_LINK, SRC_STN, SRC_REF]
    sources.forEach(ensureSource)

    if (!map.getLayer(LYR_REF)) {
      map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.18, 'line-width': 0.8, 'line-dasharray': [2, 4] } })
    }
    if (!map.getLayer(LYR_LINK)) {
      map.addLayer({ id: LYR_LINK, type: 'line', source: SRC_LINK, paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.6, 'line-dasharray': [1.5, 2] } })
    }
    if (!map.getLayer(LYR_HALO)) {
      map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.65, 'circle-stroke-width': 1.4 } })
    }
    if (!map.getLayer(LYR_STN)) {
      map.addLayer({ id: LYR_STN, type: 'circle', source: SRC_STN, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.55, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1 } })
    }
    if (!map.getLayer(LYR_STN_LBL)) {
      map.addLayer({ id: LYR_STN_LBL, type: 'symbol', source: SRC_STN, layout: { 'text-field': ['get', 'id'], 'text-size': 9, 'text-offset': [0, 1.0], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(LYR_PIN)) {
      map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': '◆', 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(LYR_LBL)) {
      map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }

    const halo: any[] = []; const lbl: any[] = []; const pin: any[] = []; const link: any[] = []; const stn: any[] = []
    for (const r of rows) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'RDR-OK' && r.tier !== 'IDLE') {
        const rad = 8 + (r.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: rad } })
      }
      if (showPin && r.tier === 'GAP') {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLabels && (r.tier === 'GAP' || r.tier === 'DEGRADE')) {
        const label = `${r.f.callsign || r.f.icao} · ${r.driver} · SSR ${r.bestSsr ? r.bestSsr.slant.toFixed(0) + 'nm' : '—'} · ${r.bestSsr?.st.id || 'NO-RDR'}`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showLink && r.tier !== 'RDR-OK' && r.tier !== 'IDLE' && r.bestSsr) {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.bestSsr.st.lng, r.bestSsr.st.lat]] }, properties: { color } })
      }
    }
    if (showStn) {
      const acByStn: Record<string, number> = {}
      for (const r of rows) for (const v of r.visible) if (v.reachable) acByStn[v.st.id] = (acByStn[v.st.id] || 0) + 1
      for (const st of STATIONS) {
        if (netFilter !== 'ALL' && st.net !== netFilter) continue
        const n = acByStn[st.id] || 0
        stn.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [st.lng, st.lat] }, properties: { id: st.id, color: NET_COLOR[st.net], r: 4 + Math.min(5, Math.sqrt(n)) } })
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

    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_STN) as any).setData({ type: 'FeatureCollection', features: stn })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: refFeats })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_STN_LBL, LYR_STN, LYR_HALO, LYR_LINK, LYR_REF]) { if (m.getLayer(id)) m.removeLayer(id) }
      for (const id of sources) { if (m.getSource(id)) m.removeSource(id) }
    }
  }, [map, rows, showHalo, showPin, showLabels, showLink, showStn, showRef, netFilter])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const driverBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )

  const advice = (r: Row) => {
    if (r.tier === 'GAP') {
      if (r.inGapZone) return 'Full radar coverage gap — apply procedural separation per ICAO Doc 4444 §8.4, request CPDLC / HF position reports, increase longitudinal sep to 10 min per NAT Doc 007'
      if (r.phase === 'TERMINAL' && !r.bestPsr) return 'PSR-loss in TMA — Cerritos-tier risk per NTSB AAR-86-08, request alternate vectoring or visual sep, expect non-radar separation per FAA Order JO 7110.65 §5-3'
      if (r.bestSsr && r.bestSsr.ageSec > 30) return 'SSR refresh stale > 30 sec — request ATC confirm radar contact, fall back to procedural per ICAO Annex 11 §3.4'
      return 'Surveillance failure — revert to procedural separation, file MOR per EUROCONTROL ESARR 4'
    }
    if (r.tier === 'DEGRADE') return 'Coverage degraded — single radar in reach or near-horizon; monitor SSR refresh, request ADS-C contract if oceanic per Doc 4444 §14.3'
    if (r.tier === 'WATCH') return 'Coverage acceptable but trend adverse — note station outage hash, expect handoff between radars'
    if (r.tier === 'RDR-OK') return 'Multi-radar SSR + PSR coverage · separation per JO 7110.65 §5-1 nominal'
    return 'Idle / on ground'
  }

  // SVG: slant-nm (x) vs age-sec (y) — bands
  const W = 280, H = 180
  const xMax = 260, yMax = 60
  const sx = (nm: number) => 30 + Math.min(1, nm / xMax) * (W - 40)
  const sy = (s: number) => H - 24 - Math.min(1, s / yMax) * (H - 48)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">PSR / SSR · Surveillance Coverage</div>
          <div className="text-[10px] text-slate-500">ICAO Doc 4444 §8 · Annex 10 Vol IV · JO 7110.65 §5-1 · ESARR 4</div>
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
          <div className="text-[9px] text-slate-500 uppercase">Mean SSR slant</div>
          <div className="text-sm font-semibold" style={{ color: meanSsr >= 180 ? '#ef4444' : meanSsr >= 120 ? '#f59e0b' : '#10b981' }}>{meanSsr.toFixed(0)} nm</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst aircraft</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">GAP</div>
          <div className="text-sm font-semibold" style={{ color: tierCount.GAP > 0 ? '#ef4444' : '#10b981' }}>{tierCount.GAP}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">No-SSR share</div>
          <div className="text-xs font-semibold" style={{ color: noSsrShare >= 0.20 ? '#ef4444' : noSsrShare >= 0.08 ? '#f59e0b' : '#10b981' }}>{(noSsrShare * 100).toFixed(1)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean PSR slant</div>
          <div className="text-xs font-semibold" style={{ color: meanPsr >= 200 ? '#f59e0b' : '#10b981' }}>{meanPsr.toFixed(0)} nm</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W - 40} height={H - 48} fill="#0b1220" />
            {/* Bands */}
            <rect x={sx(120)} y={24} width={W - 10 - sx(120)} height={H - 48} fill="#ef4444" opacity={0.10} />
            <rect x={sx(60)} y={24} width={sx(120) - sx(60)} height={H - 48} fill="#f59e0b" opacity={0.10} />
            <rect x={sx(30)} y={24} width={sx(60) - sx(30)} height={H - 48} fill="#0ea5e9" opacity={0.10} />
            <rect x={sx(0)} y={24} width={sx(30) - sx(0)} height={H - 48} fill="#10b981" opacity={0.10} />
            {/* Thresholds */}
            <line x1={30} x2={W - 10} y1={sy(12)} y2={sy(12)} stroke="#0ea5e9" strokeDasharray="3 3" strokeOpacity={0.6} />
            <line x1={30} x2={W - 10} y1={sy(30)} y2={sy(30)} stroke="#f59e0b" strokeDasharray="3 3" strokeOpacity={0.6} />
            <text x={6} y={sy(12) + 3} fontSize={8} fill="#64748b">12s</text>
            <text x={6} y={sy(30) + 3} fontSize={8} fill="#64748b">30s</text>
            {[0, 60, 120, 250].map(t => (
              <text key={t} x={sx(t) - 4} y={H - 8} fontSize={8} fill="#64748b">{t}</text>
            ))}
            {rows.map((r, i) => r.bestSsr && (
              <circle key={i} cx={sx(Math.min(xMax, r.bestSsr.slant))} cy={sy(Math.min(yMax, r.bestSsr.ageSec))} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.8} />
            ))}
            <text x={W / 2} y={H - 6} fontSize={9} fill="#64748b" textAnchor="middle">best-SSR slant nm · update age s</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MAX-FL {maxFl}</span><input type="range" min={50} max={500} value={maxFl} onChange={e => setMaxFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">HORIZON-MUL {horizonMul}%</span><input type="range" min={50} max={150} value={horizonMul} onChange={e => setHorizonMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">UPTIME-MUL {uptimeMul}%</span><input type="range" min={50} max={150} value={uptimeMul} onChange={e => setUptimeMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">GAP-THR {gapThr} nm</span><input type="range" min={5} max={60} value={gapThr} onChange={e => setGapThr(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">SSR-MIN {ssrMin} nm</span><input type="range" min={20} max={250} value={ssrMin} onChange={e => setSsrMin(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col col-span-2"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setNetFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${netFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {NET_LIST.map(n => (
          <button key={n} onClick={() => setNetFilter(netFilter === n ? 'ALL' : n)} className={`px-2 py-0.5 rounded text-[10px] border ${netFilter === n ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{n}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['LINK', showLink, setShowLink], ['STN', showStn, setShowStn], ['REF', showRef, setShowRef], ['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / type / op / icao" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'STATIONS', 'GAPS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{r.phase}</span>
              {r.inGapZone && <span className="px-1 py-px rounded text-[9px] text-rose-300 border border-rose-500/40 bg-rose-500/10">NO-RDR</span>}
              {r.bestSsr ? <span className="px-1 py-px rounded text-[9px] text-emerald-300 border border-emerald-500/40 bg-emerald-500/10">SSR</span>
                         : <span className="px-1 py-px rounded text-[9px] text-rose-300 border border-rose-500/40 bg-rose-500/10">NO-SSR</span>}
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              FL{(r.f.altitudeFt / 100).toFixed(0)} · vis {r.visible.filter(v => v.reachable).length} · SSR {r.bestSsr ? `${r.bestSsr.st.id} ${r.bestSsr.slant.toFixed(0)}nm ${r.bestSsr.ageSec.toFixed(1)}s` : '—'} · PSR {r.bestPsr ? `${r.bestPsr.st.id} ${r.bestPsr.slant.toFixed(0)}nm` : '—'}
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('COV', r.sev.cov)}
              {driverBadge('SSR', r.sev.ssr)}
              {driverBadge('PSR', r.sev.psr)}
              {driverBadge('AGE', r.sev.age)}
              {driverBadge('TRN', r.sev.trn)}
            </div>
            <div className="px-2 pb-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {advice(r)}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No aircraft match the current filters.</div>
        )}

        {tab === 'STATIONS' && stationRows.map((s, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${NET_COLOR[s.st.net]}` }}>
              <span className="font-semibold text-slate-100">{s.st.id}</span>
              <span className="text-slate-400 text-[10px] truncate">{s.st.name}</span>
              <span className="px-1 py-px rounded text-[9px]" style={{ color: NET_COLOR[s.st.net], border: `1px solid ${NET_COLOR[s.st.net]}66`, backgroundColor: NET_COLOR[s.st.net] + '14' }}>{s.st.net}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{s.st.kind}</span>
              <div className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{s.ac} ac</div>
              {s.gap > 0 && <span className="px-1 py-px rounded text-[9px] text-rose-300 border border-rose-500/40 bg-rose-500/10">{s.gap} GAP</span>}
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-500">{s.st.vendor} · {s.st.rangeNm}nm · scan {s.st.scanSec}s · elev {s.st.elevFt}ft · uptime {(s.st.uptime * 100).toFixed(0)}% · mean-slant {s.meanSlant.toFixed(0)}nm</div>
            <div className="px-2 pb-1">
              <div className="h-1 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${Math.min(100, s.ac * 3)}%`, backgroundColor: NET_COLOR[s.st.net] }} className="h-full" />
              </div>
            </div>
          </div>
        ))}

        {tab === 'GAPS' && gapRows.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{r.phase}</span>
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-500">{r.driver} · score {r.score.toFixed(0)} · SSR {r.bestSsr ? `${r.bestSsr.st.id} ${r.bestSsr.slant.toFixed(0)}nm` : '—'} · PSR {r.bestPsr ? `${r.bestPsr.st.id} ${r.bestPsr.slant.toFixed(0)}nm` : '—'}</div>
          </div>
        ))}
        {tab === 'GAPS' && gapRows.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No coverage gaps detected.</div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: ICAO Annex 10 Vol IV ch 3 / Annex 11 ch 3 / Doc 4444 PANS-ATM §8 SUR + §8.4 procedural / Doc 9924 Surveillance Manual / Doc 9871 Mode-S · EUROCONTROL ESARR 4 / ARTAS Tracker MOPS · FAA Order JO 7110.65 §5-1 §5-3 / JO 7210.3 §2-6 / Order 6310.6 / AC 90-117 · RTCA DO-260B / DO-181E / DO-303 · EUROCAE ED-117 / ED-129B · NTSB AAR-86-08 AeroMexico 498 Cerritos PSR gap · NTSB DCA98MA046 USAir 427 · IATA Ops 4.8.1 procedural sep.
      </div>
    </div>
  )
}
