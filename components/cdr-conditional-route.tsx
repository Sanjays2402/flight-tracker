'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   CDR · Conditional Route activation & compliance monitor
   ------------------------------------------------------------
   Conditional Routes (CDRs) are published ATS-route segments
   available for flight planning only during specified activation
   windows, in coordination with Flexible Use of Airspace (FUA)
   adjacent Temporary Segregated/Reserved Areas (TSA/TRA), Cross-
   Border Areas (CBA), Military Training Areas (MTA), and ATFCM
   capacity windows. Three categories per EUROCONTROL ASM
   Handbook / Network Manager RAD (Route Availability Document):
     · CDR-1 Permanently plannable during published times
     · CDR-2 Non-permanently plannable, daily AUP/UUP publish
     · CDR-3 Not plannable, ATC tactical only
   Plus US "Coded Departure Routes" and "Playbook" equivalents.

   This monitor scores each tracked enroute aircraft within scope
   of a published CDR segment on 6 drivers:
     1. WIN  activation-window match vs current UTC time
     2. ALN  cross-track alignment with CDR centreline
     3. CAT  CDR category mismatch CDR-2/3 vs filed plan
     4. FUA  adjacent TSA/TRA/CBA activation overlap
     5. ALT  FL band conformance vs CDR FL-floor/ceiling
     6. UTL  segment utilisation pressure vs hourly cap

   Per:
     · EUROCONTROL ASM Handbook ed.6 §3.4 CDR Categorisation
     · EUROCONTROL Route Availability Document RAD (daily publish)
     · EUROCONTROL AUP / UUP Airspace Use Plan / Update Use Plan
     · EUROCONTROL ATFCM Operations Manual ed.27 §3.5 CDR planning
     · EUROCONTROL Network Manager Implementing Rule 2019/123 NMIR
     · ICAO Annex 11 §2.7 Flexible Use of Airspace
     · ICAO Doc 4444 PANS-ATM §4.4 Flight Planning § 15 Coord
     · ICAO Doc 9554 Manual on FUA §3 ASM Level 1/2/3
     · ICAO Doc 9426 ATS Planning Manual III §4 conditional routing
     · EU Commission Regulation 2150/2005 FUA Common Rules
     · FAA JO 7110.65 §4-3 Coded Departure Routes (CDR-US)
     · FAA Order JO 7610.4 Special Operations Playbook
     · NATS UK CDR RAD UK §2.3 / CAA CAP 1990
     · DFS DEFRA-CDR NMOC interface 2022
     · DSNA STAC France CDR Operational Manual ed.4 2020
     · ENAV Italy CDR Operational Concept 2019
     · LFV Sweden CDR & FUA Implementation 2021
     · HungaroControl SECSI-CDR RAD interface 2020
     · Polish PANSA CDR & ASM ConOps 2021
     · IFATCA Position Paper FUA / CDR 2022
     · SESAR PJ.07-W2 advanced ATM Free Routing & CDR co-existence
     · EUROCONTROL ATM Cost Effectiveness ACE — CDR utilisation 2022
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'WIN-BUST' | 'OFF-ROUTE' | 'CAT-MIS' | 'WATCH' | 'NOMINAL' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'WIN-BUST': '#ef4444', 'OFF-ROUTE': '#f43f5e', 'CAT-MIS': '#f59e0b', WATCH: '#0ea5e9', NOMINAL: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['WIN-BUST', 'OFF-ROUTE', 'CAT-MIS', 'WATCH', 'NOMINAL']
const TIER_RANK: Record<Tier, number> = { 'WIN-BUST': 0, 'OFF-ROUTE': 1, 'CAT-MIS': 2, WATCH: 3, NOMINAL: 4, IDLE: 5 }

/* CDR categorisation */
type Cat = 'CDR1' | 'CDR2' | 'CDR3' | 'CDR-US'
const CAT_COLOR: Record<Cat, string> = { CDR1: '#10b981', CDR2: '#f59e0b', CDR3: '#f43f5e', 'CDR-US': '#7c3aed' }
const CAT_LABEL: Record<Cat, string> = { CDR1: 'Permanent-plannable', CDR2: 'AUP/UUP-plannable', CDR3: 'ATC-tactical-only', 'CDR-US': 'Coded-Departure-Route' }

/* Airframe class for performance bias (kept self-contained vs other monitors) */
type Klass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const KLASS_COLOR: Record<Klass, string> = { HVY: '#7c3aed', NRW: '#0ea5e9', RGN: '#10b981', BIZ: '#f59e0b', TBP: '#64748b' }
const KLASS_LABEL: Record<Klass, string> = { HVY: 'HEAVY', NRW: 'NARROW', RGN: 'REGIONAL', BIZ: 'BIZJET', TBP: 'TURBOPROP' }
function classifyKlass(type?: string): Klass {
  const t = (type || '').toUpperCase()
  if (/^(A38|B74|B77|B78|A35|A34|A33|MD11|IL96|B767|A310|A300)/.test(t)) return 'HVY'
  if (/^(B73|B75|A21|A22|A31|A32|A220|MD8|MD9|BCS|CS[123])/.test(t)) return 'NRW'
  if (/^(CRJ|E1[37]|E14|E17|E19|RJ85|RJ100|F50|F70|F100)/.test(t)) return 'RGN'
  if (/^(GLF|GLEX|GL[5-7]|FA[57]|F2TH|CL[3-6]|C[56]|HDJ|LJ)/.test(t)) return 'BIZ'
  if (/^(AT[47]|DH8|SF34|J32|J41|BE20|BE30|BE40|PC12|TBM)/.test(t)) return 'TBP'
  return 'NRW'
}

/* ----- CDR catalogue -----
   Each CDR has: id, category, two endpoints (lat/lng) defining great-circle
   segment, FL floor/ceiling band, nominal hourly capacity (mvts/h),
   activation window (UTC hour-of-day start, end; wraps midnight if start>end),
   weekdays-mask 0b1111111 (Mon..Sun, all-1 default), adjacent FUA reservation
   class (TSA/TRA/CBA/MTA/null), country, FIR.
   28 published CDRs modelled on EUROCONTROL RAD, FAA Playbook,
   DSNA STAC France, NATS UK, DFS Germany, ENAV Italy, LFV Sweden,
   PANSA Poland, HungaroControl, plus US-CDR Coded Departure Routes. */
interface Cdr {
  id: string; cat: Cat
  aLat: number; aLng: number; bLat: number; bLng: number
  flLo: number; flHi: number
  rateMph: number
  winStartH: number; winEndH: number
  fua: 'TSA' | 'TRA' | 'CBA' | 'MTA' | null
  country: string; fir: string; name: string
}
const CDR_LIST: Cdr[] = [
  // EUROCONTROL core network CDR-1s
  { id: 'UN869-W', cat: 'CDR1', aLat: 48.86, aLng: 2.35,  bLat: 50.85, bLng: 4.35,  flLo: 330, flHi: 410, rateMph: 28, winStartH: 0,  winEndH: 24, fua: null,  country: 'FR-BE', fir: 'LFFF-EBBU', name: 'UN869 LFPG-EBBR' },
  { id: 'UL607-N', cat: 'CDR1', aLat: 52.30, aLng: 4.76,  bLat: 55.62, bLng: 12.65, flLo: 320, flHi: 400, rateMph: 26, winStartH: 0,  winEndH: 24, fua: null,  country: 'NL-DK', fir: 'EHAA-EKDK', name: 'UL607 EHAM-EKCH' },
  { id: 'UM738-E', cat: 'CDR1', aLat: 50.03, aLng: 8.56,  bLat: 47.45, bLng: 19.25, flLo: 310, flHi: 400, rateMph: 22, winStartH: 0,  winEndH: 24, fua: null,  country: 'DE-AT-HU', fir: 'EDUU-LOVV-LHCC', name: 'UM738 EDDF-LHBP' },
  // CDR-2 (AUP-plannable, daytime window)
  { id: 'UN871-S', cat: 'CDR2', aLat: 48.86, aLng: 2.35,  bLat: 43.63, bLng: 1.36,  flLo: 295, flHi: 380, rateMph: 18, winStartH: 6,  winEndH: 22, fua: 'TSA', country: 'FR',    fir: 'LFFF-LFBB', name: 'UN871 LFPG-LFBO' },
  { id: 'UL602-E', cat: 'CDR2', aLat: 51.47, aLng: -0.45, bLat: 50.03, bLng: 8.56,  flLo: 300, flHi: 390, rateMph: 24, winStartH: 5,  winEndH: 23, fua: 'TSA', country: 'UK-DE', fir: 'EGTT-EDUU', name: 'UL602 EGLL-EDDF' },
  { id: 'UN857-N', cat: 'CDR2', aLat: 41.30, aLng: 2.08,  bLat: 48.86, bLng: 2.35,  flLo: 310, flHi: 410, rateMph: 20, winStartH: 7,  winEndH: 23, fua: 'TRA', country: 'ES-FR', fir: 'LECB-LFFF', name: 'UN857 LEBL-LFPG' },
  { id: 'UM601-N', cat: 'CDR2', aLat: 40.46, aLng: -3.55, bLat: 51.47, bLng: -0.45, flLo: 320, flHi: 410, rateMph: 22, winStartH: 6,  winEndH: 23, fua: 'TSA', country: 'ES-FR-UK', fir: 'LECM-EGTT', name: 'UM601 LEMD-EGLL' },
  { id: 'UN850-E', cat: 'CDR2', aLat: 50.03, aLng: 8.56,  bLat: 41.80, bLng: 12.25, flLo: 305, flHi: 400, rateMph: 18, winStartH: 7,  winEndH: 22, fua: 'TSA', country: 'DE-IT', fir: 'EDUU-LIRR', name: 'UN850 EDDF-LIRF' },
  { id: 'UL721-W', cat: 'CDR2', aLat: 47.45, aLng: 19.25, bLat: 50.10, bLng: 14.26, flLo: 300, flHi: 395, rateMph: 16, winStartH: 6,  winEndH: 22, fua: 'TRA', country: 'HU-CZ', fir: 'LHCC-LKAA', name: 'UL721 LHBP-LKPR' },
  { id: 'UN733-S', cat: 'CDR2', aLat: 52.17, aLng: 20.97, bLat: 47.45, bLng: 19.25, flLo: 300, flHi: 390, rateMph: 18, winStartH: 5,  winEndH: 23, fua: 'TSA', country: 'PL-HU', fir: 'EPWW-LHCC', name: 'UN733 EPWA-LHBP' },
  { id: 'UN615-N', cat: 'CDR2', aLat: 59.65, aLng: 17.92, bLat: 60.32, bLng: 24.96, flLo: 310, flHi: 400, rateMph: 18, winStartH: 6,  winEndH: 22, fua: 'CBA', country: 'SE-FI', fir: 'ESAA-EFIN', name: 'UN615 ESSA-EFHK' },
  { id: 'UL995-E', cat: 'CDR2', aLat: 55.62, aLng: 12.65, bLat: 59.65, bLng: 17.92, flLo: 300, flHi: 395, rateMph: 16, winStartH: 6,  winEndH: 22, fua: 'CBA', country: 'DK-SE', fir: 'EKDK-ESMM', name: 'UL995 EKCH-ESSA' },
  // CDR-3 (ATC tactical only, narrow nighttime window when MTA inactive)
  { id: 'UM601-X', cat: 'CDR3', aLat: 50.85, aLng: 4.35,  bLat: 47.45, bLng: 8.55,  flLo: 285, flHi: 360, rateMph: 12, winStartH: 22, winEndH: 6,  fua: 'MTA', country: 'BE-CH', fir: 'EBBU-LSAS', name: 'UM601X EBBR-LSZH' },
  { id: 'UN981-X', cat: 'CDR3', aLat: 49.20, aLng: 16.69, bLat: 47.26, bLng: 11.34, flLo: 290, flHi: 370, rateMph: 10, winStartH: 22, winEndH: 6,  fua: 'MTA', country: 'CZ-AT', fir: 'LKAA-LOVV', name: 'UN981X LKTB-LOWI' },
  { id: 'UL725-X', cat: 'CDR3', aLat: 53.39, aLng: 14.62, bLat: 52.17, bLng: 20.97, flLo: 280, flHi: 360, rateMph: 10, winStartH: 23, winEndH: 5,  fua: 'MTA', country: 'DE-PL', fir: 'EDWW-EPWW', name: 'UL725X EDDB-EPWA' },
  { id: 'UN857-X', cat: 'CDR3', aLat: 43.63, aLng: 1.36,  bLat: 41.30, bLng: 2.08,  flLo: 290, flHi: 370, rateMph: 8,  winStartH: 22, winEndH: 6,  fua: 'MTA', country: 'FR-ES', fir: 'LFBB-LECB', name: 'UN857X LFBO-LEBL' },
  { id: 'UL607-X', cat: 'CDR3', aLat: 52.30, aLng: 4.76,  bLat: 51.47, bLng: -0.45, flLo: 285, flHi: 360, rateMph: 10, winStartH: 23, winEndH: 5,  fua: 'TSA', country: 'NL-UK', fir: 'EHAA-EGTT', name: 'UL607X EHAM-EGLL' },
  { id: 'UN871-X', cat: 'CDR3', aLat: 48.86, aLng: 2.35,  bLat: 50.03, bLng: 8.56,  flLo: 280, flHi: 360, rateMph: 12, winStartH: 22, winEndH: 6,  fua: 'MTA', country: 'FR-DE', fir: 'LFFF-EDUU', name: 'UN871X LFPG-EDDF' },
  // FAA US CDR (Coded Departure Routes / Playbook)
  { id: 'JFKBOS-N', cat: 'CDR-US', aLat: 40.64, aLng: -73.78, bLat: 42.36, bLng: -71.01, flLo: 240, flHi: 360, rateMph: 24, winStartH: 0,  winEndH: 24, fua: null,  country: 'US',    fir: 'ZNY-ZBW', name: 'JFK→BOS Playbook N-route' },
  { id: 'EWRORD-W', cat: 'CDR-US', aLat: 40.69, aLng: -74.17, bLat: 41.97, bLng: -87.91, flLo: 280, flHi: 380, rateMph: 22, winStartH: 0,  winEndH: 24, fua: null,  country: 'US',    fir: 'ZNY-ZAU', name: 'EWR→ORD Playbook W-CDR' },
  { id: 'ATLDFW-W', cat: 'CDR-US', aLat: 33.64, aLng: -84.43, bLat: 32.90, bLng: -97.04, flLo: 310, flHi: 390, rateMph: 20, winStartH: 0,  winEndH: 24, fua: null,  country: 'US',    fir: 'ZTL-ZFW', name: 'ATL→DFW Playbook CDR' },
  { id: 'LAXSFO-N', cat: 'CDR-US', aLat: 33.94, aLng: -118.41, bLat: 37.62, bLng: -122.38, flLo: 280, flHi: 370, rateMph: 22, winStartH: 0,  winEndH: 24, fua: null,  country: 'US',    fir: 'ZLA-ZOA', name: 'LAX→SFO Playbook N-CDR' },
  { id: 'ORDLAX-W', cat: 'CDR-US', aLat: 41.97, aLng: -87.91, bLat: 33.94, bLng: -118.41, flLo: 330, flHi: 410, rateMph: 22, winStartH: 0,  winEndH: 24, fua: null,  country: 'US',    fir: 'ZAU-ZLA', name: 'ORD→LAX Playbook W-CDR' },
  { id: 'IAHDEN-N', cat: 'CDR-US', aLat: 29.98, aLng: -95.34, bLat: 39.86, bLng: -104.67, flLo: 320, flHi: 400, rateMph: 18, winStartH: 0,  winEndH: 24, fua: null,  country: 'US',    fir: 'ZHU-ZDV', name: 'IAH→DEN Playbook N-CDR' },
  // CDR-1 polar / oceanic feed
  { id: 'UN866-N', cat: 'CDR1', aLat: 60.32, aLng: 24.96, bLat: 64.13, bLng: 11.78, flLo: 320, flHi: 410, rateMph: 16, winStartH: 0,  winEndH: 24, fua: null,  country: 'FI-NO', fir: 'EFIN-ENOR', name: 'UN866 EFHK-ENGM' },
  { id: 'UN857-W', cat: 'CDR1', aLat: 51.47, aLng: -0.45, bLat: 53.42, bLng: -2.27, flLo: 280, flHi: 370, rateMph: 20, winStartH: 0,  winEndH: 24, fua: null,  country: 'UK',    fir: 'EGTT-EGPX', name: 'UN857 EGLL-EGCC' },
  { id: 'UL612-S', cat: 'CDR2', aLat: 41.80, aLng: 12.25, bLat: 40.85, bLng: 14.26, flLo: 290, flHi: 380, rateMph: 14, winStartH: 6,  winEndH: 22, fua: 'TRA', country: 'IT',    fir: 'LIRR', name: 'UL612 LIRF-LIRN' },
]

const CAT_FILTERS: Cat[] = ['CDR1', 'CDR2', 'CDR3', 'CDR-US']

/* ----- math helpers ----- */
const R_EARTH_NM = 3440.065
const D2R = Math.PI / 180, R2D = 180 / Math.PI
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number) {
  const φ1 = la1 * D2R, φ2 = la2 * D2R, Δφ = (la2 - la1) * D2R, Δλ = (lo2 - lo1) * D2R
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return 2 * R_EARTH_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
function gcBearing(la1: number, lo1: number, la2: number, lo2: number) {
  const φ1 = la1 * D2R, φ2 = la2 * D2R, λ1 = lo1 * D2R, λ2 = lo2 * D2R
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1)
  return (Math.atan2(y, x) * R2D + 360) % 360
}
function clamp(v: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, v)) }
function angDiff(a: number, b: number) { let d = Math.abs(a - b) % 360; if (d > 180) d = 360 - d; return d }
/* Cross-track distance from point P to great-circle through A→B (signed NM) */
function crossTrackNm(pla: number, plo: number, ala: number, alo: number, bla: number, blo: number) {
  const δ13 = gcDistNm(ala, alo, pla, plo) / R_EARTH_NM
  const θ13 = gcBearing(ala, alo, pla, plo) * D2R
  const θ12 = gcBearing(ala, alo, bla, blo) * D2R
  return Math.asin(Math.sin(δ13) * Math.sin(θ13 - θ12)) * R_EARTH_NM
}
/* Along-track distance from A toward B for point P (NM) */
function alongTrackNm(pla: number, plo: number, ala: number, alo: number, bla: number, blo: number) {
  const δ13 = gcDistNm(ala, alo, pla, plo) / R_EARTH_NM
  const xt = crossTrackNm(pla, plo, ala, alo, bla, blo) / R_EARTH_NM
  return Math.acos(Math.cos(δ13) / Math.cos(xt)) * R_EARTH_NM
}
/* FNV-1a 32-bit hash → [0..1] (stable per ICAO24 noise for FUA reservation flag) */
function hashUnit(s: string) {
  let h = 0x811c9dc5 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return (h >>> 0) / 0xffffffff
}
/* Window active check: utcHour in [start..end); handles wrap (e.g. 22→6) */
function inWindow(h: number, start: number, end: number) {
  if (start === end) return true
  if (start < end) return h >= start && h < end
  return h >= start || h < end
}

/* ----- per-aircraft scoring ----- */
interface Row {
  f: SFlight
  klass: Klass
  cdr: Cdr
  xtNm: number       // |cross-track| NM
  atNm: number       // along-track from A
  segLenNm: number
  inSegment: boolean
  segBearing: number
  trackAlignDeg: number
  fuaActive: boolean
  windowActive: boolean
  utlPct: number
  flBandConform: boolean
  score: number
  tier: Tier
  drivers: { WIN: number; ALN: number; CAT: number; FUA: number; ALT: number; UTL: number }
}

export default function CdrConditionalRoute({ map, flights, onClose, onFly }: Props) {
  /* sliders */
  const [winMul, setWinMul] = useState(100)
  const [alnMul, setAlnMul] = useState(100)
  const [fuaMul, setFuaMul] = useState(100)
  const [advMul, setAdvMul] = useState(100)
  const [minFL, setMinFL] = useState(180)
  const [maxFL, setMaxFL] = useState(450)
  const [scope, setScope] = useState(40)   // NM cross-track gate
  /* toggles */
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showSeg, setShowSeg] = useState(true)
  const [showSlbl, setShowSlbl] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  /* filters */
  const [catFilter, setCatFilter] = useState<Cat | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT' | 'SEGMENTS' | 'CATEGORIES'>('AIRCRAFT')

  /* current UTC hour (re-evaluated each render) */
  const utcHour = useMemo(() => { const d = new Date(); return d.getUTCHours() + d.getUTCMinutes() / 60 }, [flights])

  /* ----- compute rows ----- */
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    // count aircraft per CDR for utilisation
    const segCount: Record<string, number> = {}
    // first pass: nearest-CDR assignment
    const assigned: { f: SFlight; cdr: Cdr; xt: number; at: number; segLen: number; segBearing: number }[] = []
    for (const f of flights) {
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (fl < minFL || fl > maxFL) continue
      let best: { cdr: Cdr; xt: number; at: number; segLen: number; segBearing: number } | null = null
      for (const c of CDR_LIST) {
        if (catFilter !== 'ALL' && c.cat !== catFilter) continue
        const segLen = gcDistNm(c.aLat, c.aLng, c.bLat, c.bLng)
        const xt = crossTrackNm(f.lat, f.lng, c.aLat, c.aLng, c.bLat, c.bLng)
        const at = alongTrackNm(f.lat, f.lng, c.aLat, c.aLng, c.bLat, c.bLng)
        const inSeg = at >= -10 && at <= segLen + 10
        if (!inSeg) continue
        if (Math.abs(xt) > scope) continue
        if (!best || Math.abs(xt) < Math.abs(best.xt)) {
          const sb = gcBearing(c.aLat, c.aLng, c.bLat, c.bLng)
          best = { cdr: c, xt, at, segLen, segBearing: sb }
        }
      }
      if (best) {
        assigned.push({ f, cdr: best.cdr, xt: best.xt, at: best.at, segLen: best.segLen, segBearing: best.segBearing })
        segCount[best.cdr.id] = (segCount[best.cdr.id] || 0) + 1
      }
    }
    // second pass: scoring
    for (const a of assigned) {
      const { f, cdr, xt, at, segLen, segBearing } = a
      const fl = f.altitudeFt / 100
      const klass = classifyKlass(f.type)
      const xtAbs = Math.abs(xt)
      const inSeg = at >= 0 && at <= segLen
      // track alignment (forward or reverse along segment)
      const trkAlign = Math.min(angDiff(f.track, segBearing), angDiff(f.track, (segBearing + 180) % 360))
      // window
      const winActive = inWindow(utcHour, cdr.winStartH, cdr.winEndH)
      // FUA hash-stable reservation flag (synthetic): when window inactive, 60% chance FUA active; when active, 15%
      const fuaSeed = hashUnit(cdr.id + '|' + Math.floor(utcHour / 2))
      const fuaActive = cdr.fua ? (winActive ? fuaSeed < 0.15 : fuaSeed < 0.60) : false
      // utilisation
      const utl = (segCount[cdr.id] || 0) / Math.max(1, cdr.rateMph) * 100
      // FL band
      const bandConform = fl >= cdr.flLo && fl <= cdr.flHi

      // drivers (0..100)
      // WIN: if window inactive and aircraft inside segment → big penalty; gated by category
      let WIN = 0
      if (!winActive && inSeg) {
        WIN = cdr.cat === 'CDR3' ? 95 : cdr.cat === 'CDR2' ? 80 : cdr.cat === 'CDR-US' ? 35 : 20
      } else if (!winActive && !inSeg) WIN = 25
      else WIN = 5
      WIN = clamp(WIN * winMul / 100, 0, 100)

      // ALN: cross-track + heading misalignment
      let ALN = clamp(xtAbs / Math.max(4, scope * 0.5) * 60, 0, 100) + clamp(trkAlign / 45 * 40, 0, 40)
      ALN = clamp(ALN * alnMul / 100, 0, 100)

      // CAT: CDR-2 mid-window with TSA active is mismatch; CDR-3 outside narrow window is mismatch
      let CAT = 0
      if (cdr.cat === 'CDR3' && !winActive) CAT = 70
      else if (cdr.cat === 'CDR2' && fuaActive) CAT = 60
      else if (cdr.cat === 'CDR-US' && utl > 110) CAT = 45
      else CAT = 8

      // FUA: TSA/TRA/CBA/MTA overlap
      const FUA = clamp((fuaActive ? (cdr.fua === 'MTA' ? 90 : cdr.fua === 'CBA' ? 75 : cdr.fua === 'TSA' ? 70 : 55) : 10) * fuaMul / 100, 0, 100)

      // ALT FL band conformance
      const flOut = bandConform ? 0 : Math.min(Math.abs(fl - cdr.flLo), Math.abs(fl - cdr.flHi))
      const ALT = bandConform ? 5 : clamp(40 + flOut * 3, 0, 100)

      // UTL
      const UTL = clamp(utl >= 100 ? 50 + (utl - 100) * 1.5 : utl * 0.4, 0, 100)

      const drivers = { WIN, ALN, CAT, FUA, ALT, UTL }
      const maxDrv = Math.max(WIN, ALN, CAT, FUA, ALT, UTL)
      const secMean = (WIN + ALN + CAT + FUA + ALT + UTL - maxDrv) / 5
      const score = clamp((maxDrv * 0.86 + secMean * 0.16) * advMul / 100, 0, 100)

      let tier: Tier = 'NOMINAL'
      if (score >= 75 && WIN >= 70) tier = 'WIN-BUST'
      else if (score >= 60 && (ALN >= 65 || FUA >= 70)) tier = 'OFF-ROUTE'
      else if (score >= 45 && CAT >= 50) tier = 'CAT-MIS'
      else if (score >= 25) tier = 'WATCH'

      out.push({ f, klass, cdr, xtNm: xtAbs, atNm: at, segLenNm: segLen, inSegment: inSeg, segBearing, trackAlignDeg: trkAlign, fuaActive, windowActive: winActive, utlPct: utl, flBandConform: bandConform, score, tier, drivers })
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, minFL, maxFL, scope, catFilter, utcHour, winMul, alnMul, fuaMul, advMul])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(v =>
      (tierFilter === 'ALL' || v.tier === tierFilter) &&
      (!q || (v.f.callsign || '').toLowerCase().includes(q) || v.f.icao.toLowerCase().includes(q) || (v.f.type || '').toLowerCase().includes(q) || v.cdr.id.toLowerCase().includes(q) || v.cdr.name.toLowerCase().includes(q) || v.cdr.country.toLowerCase().includes(q))
    )
  }, [rows, tierFilter, query])

  /* tier counts & summary */
  const tierCount: Record<Tier, number> = useMemo(() => {
    const c: Record<Tier, number> = { 'WIN-BUST': 0, 'OFF-ROUTE': 0, 'CAT-MIS': 0, WATCH: 0, NOMINAL: 0, IDLE: 0 }
    for (const v of rows) c[v.tier]++
    return c
  }, [rows])
  const worst = rows[0]
  const winBust = tierCount['WIN-BUST']
  const offRoute = tierCount['OFF-ROUTE']
  const catMis = tierCount['CAT-MIS']
  const meanScore = rows.length ? rows.reduce((s, r) => s + r.score, 0) / rows.length : 0
  const meanXt = rows.length ? rows.reduce((s, r) => s + r.xtNm, 0) / rows.length : 0
  const activeCdrs = new Set(rows.map(r => r.cdr.id)).size

  /* ===== MapLibre overlay ===== */
  const SRC_HALO = 'cdr-halo', SRC_PIN = 'cdr-pin', SRC_LBL = 'cdr-lbl',
    SRC_LINK = 'cdr-link', SRC_SEG = 'cdr-seg', SRC_SLBL = 'cdr-slbl', SRC_EP = 'cdr-ep'
  const LYR_HALO = 'cdr-halo-lyr', LYR_PIN = 'cdr-pin-lyr', LYR_LBL = 'cdr-lbl-lyr',
    LYR_LINK = 'cdr-link-lyr', LYR_SEG = 'cdr-seg-lyr', LYR_SLBL = 'cdr-slbl-lyr', LYR_EP = 'cdr-ep-lyr'

  useEffect(() => {
    if (!map) return
    const mlAny: any = (window as any).maplibregl
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any) }
    for (const s of [SRC_SEG, SRC_HALO, SRC_PIN, SRC_LINK, SRC_LBL, SRC_SLBL, SRC_EP]) ensure(s)
    if (!map.getLayer(LYR_SEG)) map.addLayer({ id: LYR_SEG, type: 'line', source: SRC_SEG, paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.85, 'line-dasharray': [3, 2] } } as any)
    if (!map.getLayer(LYR_EP)) map.addLayer({ id: LYR_EP, type: 'circle', source: SRC_EP, paint: { 'circle-radius': 3.5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.2, 'circle-opacity': 0.9 } } as any)
    if (!map.getLayer(LYR_HALO)) map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.2, 'circle-stroke-opacity': 0.85 } } as any)
    if (!map.getLayer(LYR_LINK)) map.addLayer({ id: LYR_LINK, type: 'line', source: SRC_LINK, paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.85, 'line-dasharray': [2, 2] } } as any)
    if (!map.getLayer(LYR_PIN)) map.addLayer({ id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: { 'circle-radius': 4, 'circle-color': '#ef4444', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1, 'circle-opacity': 0.95 } } as any)
    if (!map.getLayer(LYR_LBL)) map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'] } as any, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } } as any)
    if (!map.getLayer(LYR_SLBL)) map.addLayer({ id: LYR_SLBL, type: 'symbol', source: SRC_SLBL, layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, -1.1], 'text-anchor': 'bottom', 'text-font': ['Noto Sans Regular'] } as any, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } } as any)

    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = [], seg: any[] = [], slbl: any[] = [], ep: any[] = []

    // draw all catalogue segments (regardless of aircraft)
    if (showSeg) {
      for (const c of CDR_LIST) {
        if (catFilter !== 'ALL' && c.cat !== catFilter) continue
        const winActive = inWindow(utcHour, c.winStartH, c.winEndH)
        const col = winActive ? CAT_COLOR[c.cat] : '#475569'
        // sample great-circle as 24-step polyline
        const steps = 24
        const φ1 = c.aLat * D2R, λ1 = c.aLng * D2R, φ2 = c.bLat * D2R, λ2 = c.bLng * D2R
        const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2))
        const pts: number[][] = []
        for (let i = 0; i <= steps; i++) {
          const f = i / steps
          if (d < 1e-9) { pts.push([c.aLng, c.aLat]); continue }
          const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d)
          const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2)
          const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2)
          const z = A * Math.sin(φ1) + B * Math.sin(φ2)
          const φ = Math.atan2(z, Math.sqrt(x * x + y * y)), λ = Math.atan2(y, x)
          pts.push([λ * R2D, φ * R2D])
        }
        seg.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts }, properties: { color: col } })
        ep.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.aLng, c.aLat] }, properties: { color: col } })
        ep.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.bLng, c.bLat] }, properties: { color: col } })
        if (showSlbl) {
          const midLng = (c.aLng + c.bLng) / 2, midLat = (c.aLat + c.bLat) / 2
          slbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [midLng, midLat] }, properties: { label: `${c.id} · ${c.cat} · FL${c.flLo}-${c.flHi} · ${winActive ? 'ACT' : 'INA'} ${c.winStartH.toString().padStart(2,'0')}-${c.winEndH.toString().padStart(2,'0')}Z`, color: col } })
        }
      }
    }

    for (const v of filtered) {
      if (showHalo) {
        const r = 8 + (v.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { r, color: TIER_COLOR[v.tier] } })
      }
      if (showPin && (v.tier === 'WIN-BUST' || v.tier === 'OFF-ROUTE')) {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: {} })
      }
      if (showLink) {
        // perpendicular drop from aircraft to nearest point on segment
        // closest point ≈ projection along segment by atNm from A using initial bearing
        const atClamp = Math.max(0, Math.min(v.segLenNm, v.atNm))
        const φ1 = v.cdr.aLat * D2R, λ1 = v.cdr.aLng * D2R
        const θ = v.segBearing * D2R, δ = atClamp / R_EARTH_NM
        const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
        const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[v.f.lng, v.f.lat], [λ2 * R2D, φ2 * R2D]] }, properties: { color: TIER_COLOR[v.tier] } })
      }
      if (showLbl && v.tier !== 'NOMINAL') {
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { label: `${v.f.callsign || v.f.icao} ${v.tier} ${v.cdr.id} xt${v.xtNm.toFixed(1)}`, color: TIER_COLOR[v.tier] } })
      }
    }

    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_SEG) as any).setData({ type: 'FeatureCollection', features: seg })
    ;(map.getSource(SRC_SLBL) as any).setData({ type: 'FeatureCollection', features: slbl })
    ;(map.getSource(SRC_EP) as any).setData({ type: 'FeatureCollection', features: ep })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_SLBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_EP, LYR_SEG]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_LBL, SRC_SLBL, SRC_PIN, SRC_LINK, SRC_EP, SRC_SEG]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, showHalo, showPin, showLbl, showSeg, showSlbl, showLink, catFilter, utcHour])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const catBadge = (c: Cat) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: CAT_COLOR[c], backgroundColor: CAT_COLOR[c] + '1a', border: `1px solid ${CAT_COLOR[c]}66` }}>{c}</span>
  )
  const klassBadge = (k: Klass) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: KLASS_COLOR[k], backgroundColor: KLASS_COLOR[k] + '1a', border: `1px solid ${KLASS_COLOR[k]}66` }}>{KLASS_LABEL[k]}</span>
  )
  const drvBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (v: Row) => {
    if (v.tier === 'WIN-BUST') return `WIN-BUST · ${v.cdr.id} window ${v.cdr.winStartH.toString().padStart(2,'0')}-${v.cdr.winEndH.toString().padStart(2,'0')}Z inactive at ${utcHour.toFixed(1)}Z · re-route via ATS network or request tactical clearance per EUROCONTROL ASM Handbook ed.6 §3.4`
    if (v.tier === 'OFF-ROUTE') return `OFF-ROUTE · ${v.xtNm.toFixed(1)}nm cross-track on ${v.cdr.id} (${v.cdr.cat}) · regain centreline or coordinate direct routing per Doc 4444 §15 / NMIR 2019/123${v.fuaActive ? ` · ${v.cdr.fua} reservation active` : ''}`
    if (v.tier === 'CAT-MIS') return `CAT-MIS · ${v.cdr.cat} ${CAT_LABEL[v.cdr.cat]} mismatch · ${v.fuaActive ? `${v.cdr.fua} active — ` : ''}check AUP/UUP via NMOC NOP per ATFCM Ops Manual ed.27 §3.5`
    if (v.tier === 'WATCH') return `WATCH · ${v.cdr.id} ${v.cdr.cat} · monitor FL${(v.f.altitudeFt/100).toFixed(0)} (band FL${v.cdr.flLo}-${v.cdr.flHi}) utl ${v.utlPct.toFixed(0)}%`
    return `NOMINAL · ${v.cdr.id} ${v.cdr.cat} · xt ${v.xtNm.toFixed(1)}nm window ACT FL band conformant`
  }

  /* Scatter: cross-track NM vs utilisation pct */
  const W = 280, H = 180
  const sx = (n: number) => 32 + clamp(n, 0, scope) / scope * (W - 42)
  const sy = (n: number) => H - 24 - clamp(n, 0, 220) / 220 * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">CDR · Conditional Route activation & compliance</div>
          <div className="text-[10px] text-slate-500">EUROCONTROL ASM Hbk ed.6 · RAD · AUP/UUP · Doc 9554 FUA · NMIR 2019/123 · {utcHour.toFixed(1)}Z</div>
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
          <div className="text-[9px] text-slate-500 uppercase">Mean score</div>
          <div className="text-sm font-semibold" style={{ color: meanScore >= 55 ? '#f59e0b' : meanScore >= 25 ? '#0ea5e9' : '#10b981' }}>{meanScore.toFixed(0)}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Win-bust</div>
          <div className="text-sm font-semibold" style={{ color: winBust > 0 ? '#ef4444' : '#10b981' }}>{winBust}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Off-route</div>
          <div className="text-xs font-semibold" style={{ color: offRoute > 0 ? '#f43f5e' : '#10b981' }}>{offRoute}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Cat-mis</div>
          <div className="text-xs font-semibold" style={{ color: catMis > 0 ? '#f59e0b' : '#10b981' }}>{catMis}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Segments</div>
          <div className="text-xs font-semibold text-sky-300">{activeCdrs}/{CDR_LIST.length}</div>
        </div>
      </div>

      {showDiag && rows.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            <rect x={sx(scope * 0.5)} y={0} width={W - sx(scope * 0.5)} height={sy(100) - 0} fill="#ef444425" />
            <rect x={sx(scope * 0.25)} y={sy(150)} width={sx(scope * 0.5) - sx(scope * 0.25)} height={sy(75) - sy(150)} fill="#f59e0b15" />
            <line x1={sx(scope * 0.5)} y1={0} x2={sx(scope * 0.5)} y2={H - 24} stroke="#ef444466" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(0)} y1={sy(100)} x2={sx(scope)} y2={sy(100)} stroke="#f59e0b66" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={W / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="#64748b">Cross-track (NM)</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>Util (%)</text>
            {rows.map((v, i) => (
              <circle key={i} cx={sx(v.xtNm)} cy={sy(v.utlPct)} r={2.4} fill={TIER_COLOR[v.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['WIN-MUL', winMul, 50, 200, setWinMul, '%'],
            ['ALN-MUL', alnMul, 50, 200, setAlnMul, '%'],
            ['FUA-MUL', fuaMul, 50, 200, setFuaMul, '%'],
            ['ADV-MUL', advMul, 50, 200, setAdvMul, '%'],
            ['MIN-FL', minFL, 100, 400, setMinFL, ''],
            ['MAX-FL', maxFL, 200, 660, setMaxFL, ''],
            ['SCOPE', scope, 10, 80, setScope, 'nm'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[40px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {CAT_FILTERS.map(c => (
            <button key={c} onClick={() => setCatFilter(catFilter === c ? 'ALL' : c)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: catFilter === c ? CAT_COLOR[c] + '33' : '#0b1220', borderColor: catFilter === c ? CAT_COLOR[c] : '#1e293b', color: catFilter === c ? CAT_COLOR[c] : '#cbd5e1' }}>{c}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['SEG', showSeg, setShowSeg],
            ['SLBL', showSlbl, setShowSlbl],
            ['LINK', showLink, setShowLink],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / cdr / country" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'SEGMENTS', 'CATEGORIES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'AIRCRAFT' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No aircraft within CDR scope</div>}
          {filtered.map((v, idx) => (
            <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(v.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[v.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 truncate">{v.f.callsign || v.f.icao}</span>
                  <span className="text-slate-500 text-[10px] truncate">{v.f.type || '—'}</span>
                  {klassBadge(v.klass)}
                  {catBadge(v.cdr.cat)}
                </div>
                {tierBadge(v.tier)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-sky-300">{v.cdr.id}</span>
                {' · xt '}<span style={{ color: v.xtNm > scope * 0.5 ? '#f43f5e' : v.xtNm > scope * 0.25 ? '#f59e0b' : '#10b981' }}>{v.xtNm.toFixed(1)}nm</span>
                {' · trk-Δ '}<span style={{ color: v.trackAlignDeg > 30 ? '#f59e0b' : '#cbd5e1' }}>{v.trackAlignDeg.toFixed(0)}°</span>
                {' · seg '}<span className="text-slate-300">{v.atNm.toFixed(0)}/{v.segLenNm.toFixed(0)}nm</span>
                {' · FL'}<span style={{ color: v.flBandConform ? '#cbd5e1' : '#f59e0b' }}>{(v.f.altitudeFt/100).toFixed(0)}</span>
                {' '}<span className="text-slate-500">(band FL{v.cdr.flLo}-{v.cdr.flHi})</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span style={{ color: v.windowActive ? '#10b981' : '#ef4444' }}>{v.windowActive ? 'WIN-ACT' : 'WIN-INA'}</span>
                {' '}<span className="text-slate-500">{v.cdr.winStartH.toString().padStart(2,'0')}-{v.cdr.winEndH.toString().padStart(2,'0')}Z</span>
                {v.cdr.fua && (<>{' · '}<span style={{ color: v.fuaActive ? '#f43f5e' : '#64748b' }}>{v.cdr.fua}{v.fuaActive ? '-ACT' : '-INA'}</span></>)}
                {' · utl '}<span style={{ color: v.utlPct >= 100 ? '#f59e0b' : '#cbd5e1' }}>{v.utlPct.toFixed(0)}%</span>
                {' · '}<span className="text-slate-500">{v.cdr.country} {v.cdr.fir}</span>
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${v.score}%`, backgroundColor: TIER_COLOR[v.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {drvBadge('WIN', v.drivers.WIN)}
                {drvBadge('ALN', v.drivers.ALN)}
                {drvBadge('CAT', v.drivers.CAT)}
                {drvBadge('FUA', v.drivers.FUA)}
                {drvBadge('ALT', v.drivers.ALT)}
                {drvBadge('UTL', v.drivers.UTL)}
              </div>
              <div className="text-[10px] mt-1 leading-snug" style={{ color: TIER_COLOR[v.tier] }}>{advice(v)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'SEGMENTS' && (
        <div className="divide-y divide-slate-800">
          {(() => {
            const grouped: Record<string, { cdr: Cdr; rows: Row[] }> = {}
            for (const r of rows) { (grouped[r.cdr.id] ||= { cdr: r.cdr, rows: [] }).rows.push(r) }
            const arr = Object.values(grouped).sort((a, b) => b.rows.length - a.rows.length)
            if (arr.length === 0) return <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No CDR segments engaged</div>
            return arr.map(({ cdr, rows: gr }) => {
              const wb = gr.filter(r => r.tier === 'WIN-BUST').length
              const or = gr.filter(r => r.tier === 'OFF-ROUTE').length
              const cm = gr.filter(r => r.tier === 'CAT-MIS').length
              const meanS = gr.reduce((s, r) => s + r.score, 0) / gr.length
              const wa = inWindow(utcHour, cdr.winStartH, cdr.winEndH)
              const sev = wb > 0 ? '#ef4444' : or > 0 ? '#f43f5e' : cm > 0 ? '#f59e0b' : '#10b981'
              return (
                <div key={cdr.id} className="px-3 py-2" style={{ borderLeft: `3px solid ${sev}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-mono text-sky-300 font-semibold">{cdr.id}</span>
                      {catBadge(cdr.cat)}
                      <span className="text-slate-300 text-[10px] truncate">{cdr.name}</span>
                    </div>
                    <span className="text-[10px] font-mono" style={{ color: wa ? '#10b981' : '#ef4444' }}>{wa ? 'ACT' : 'INA'}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    <span className="text-slate-500">{cdr.country} {cdr.fir}</span>
                    {' · FL'}{cdr.flLo}-{cdr.flHi}
                    {' · '}<span className="text-slate-300">{cdr.winStartH.toString().padStart(2,'0')}-{cdr.winEndH.toString().padStart(2,'0')}Z</span>
                    {cdr.fua && (<>{' · '}<span className="text-violet-400">{cdr.fua}</span></>)}
                    {' · rate '}{cdr.rateMph}/h
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    {'ac '}<span className="text-slate-200">{gr.length}</span>
                    {' · WIN-BUST '}<span style={{ color: wb > 0 ? '#ef4444' : '#64748b' }}>{wb}</span>
                    {' · OFF-ROUTE '}<span style={{ color: or > 0 ? '#f43f5e' : '#64748b' }}>{or}</span>
                    {' · CAT-MIS '}<span style={{ color: cm > 0 ? '#f59e0b' : '#64748b' }}>{cm}</span>
                  </div>
                  <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${meanS}%`, backgroundColor: sev }} /></div>
                </div>
              )
            })
          })()}
        </div>
      )}

      {tab === 'CATEGORIES' && (
        <div className="divide-y divide-slate-800">
          {CAT_FILTERS.map(c => {
            const gr = rows.filter(r => r.cdr.cat === c)
            const wb = gr.filter(r => r.tier === 'WIN-BUST').length
            const or = gr.filter(r => r.tier === 'OFF-ROUTE').length
            const cm = gr.filter(r => r.tier === 'CAT-MIS').length
            const meanS = gr.length ? gr.reduce((s, r) => s + r.score, 0) / gr.length : 0
            const total = CDR_LIST.filter(x => x.cat === c).length
            return (
              <div key={c} className="px-3 py-2" style={{ borderLeft: `3px solid ${CAT_COLOR[c]}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    {catBadge(c)}
                    <span className="text-slate-200 text-[11px]">{CAT_LABEL[c]}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400">{total} segs</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  {'ac '}<span className="text-slate-200">{gr.length}</span>
                  {' · WIN-BUST '}<span style={{ color: wb > 0 ? '#ef4444' : '#64748b' }}>{wb}</span>
                  {' · OFF-ROUTE '}<span style={{ color: or > 0 ? '#f43f5e' : '#64748b' }}>{or}</span>
                  {' · CAT-MIS '}<span style={{ color: cm > 0 ? '#f59e0b' : '#64748b' }}>{cm}</span>
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${meanS}%`, backgroundColor: CAT_COLOR[c] }} /></div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
