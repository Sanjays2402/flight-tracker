'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   RFFS · Rescue & Fire-Fighting Services Category Compliance Monitor
   ------------------------------------------------------------
   ICAO Annex 14 Vol I §9.2 Rescue & Fire-Fighting
     · Table 9-1 RFFS category by aircraft overall length & fuselage width
     · §9.2.5 minimum usable amounts of extinguishing agents per category
     · §9.2.11-9.2.14 response time ≤3 min anywhere on movement area
     · §9.2.23-9.2.26 manning, vehicles, road-network requirements
   ICAO Doc 9137 Airport Services Manual Pt 1 Rescue & Fire-Fighting
     · §2 RFFS category determination
     · §6 critical area concept Q1/Q2 agent computation
     · §13 remission factor for low movement airports
   ICAO Doc 9981 PANS-Aerodromes Pt I ch 9 RFFS operations
   ICAO Doc 9774 Manual on Certification of Aerodromes §3.3 RFFS
   FAA 14 CFR Part 139.315/.317/.319 Aircraft rescue & fire fighting
     · §139.315 ARFF Index A-E by length & avg daily departures
     · §139.317 vehicle & agent requirements per index
     · §139.319 operational requirements 3 min response 90% of time
   FAA AC 150/5210-6E Aircraft Fire & Rescue Facilities
   FAA AC 150/5210-7E Aircraft Rescue & Fire-Fighting Communications
   FAA AC 150/5220-10E ARFF vehicles
   FAA Order 5200.12C ARFF Index determination
   FAA AC 150/5200-31C Airport Emergency Plan §4 RFFS integration
   EASA CS-ADR-DSN.D.305 RFF category & §D.310 agents
   EASA AMC1 ADR.OPS.B.010 RFFS provision
   EASA AMC1 ADR.OPS.B.015 lower RFFS during reduced ops
   UK CAA CAP 168 Licensing of Aerodromes ch.8 RFFS
   IATA Airport Handling Manual AHM 632 ARFF coordination
   NFPA 403 ARFF Services at Airports 2024
   NFPA 412 Foam Equipment Evaluation
   NFPA 414 Aircraft Rescue & Fire-Fighting Vehicles
   NTSB AAR-04-04 Air Midwest 5481 KCLT ARFF response
   NTSB AAR-08-01 Comair 5191 KLEX ARFF arrival 2:36
   NTSB AAR-14-01 Asiana 214 KSFO post-crash RFFS coordination
   AAIB EW/C2010/05/01 BA38 EGLL post-crash response
   FAA RE&D DOT/FAA/AR-09/56 RFFS performance metrics
   FAA TC-13/57 Critical Area methodology

   This monitor takes:
     1. Arriving aircraft on final approach or landing roll within
        scope of catalogued airports.
     2. Aircraft on the ground in distress (squawk 7700, low fuel,
        gear/hydraulic alerts inferred from vertical-rate anomaly).
     3. Wide-body or out-of-category aircraft attempting to operate
        at airports rated below their required RFFS category.

   A 30-airport global catalogue tagged with published RFFS / ARFF
   category, agents stockpiled, vehicles, and certified geometry.

   Per-arrival scoring matches the airframe's required RFFS category
   (derived from ICAO Annex 14 Table 9-1: length + fuselage width)
   against the airport's published category and computes a downgrade
   risk score with 6 drivers and 6 tiers.

   6 risk drivers (max-driver composite):
     · CAT  category-gap (req-cat minus avail-cat) 0=ok 100=≥3 below
     · AGT  agent-deficit (Q1 water for foam required vs stockpiled)
     · VEH  vehicle count deficit per Part 139 / CS-ADR-DSN.D.310
     · RSP  response-time risk based on aircraft position vs station
     · EMG  emergency-state (squawk 7700/7600/7500, low-fuel descent)
     · WX   visibility / RVR penalty (response harder in low-vis)

   6 hard tiers:
     · GROUND-EMG  squawk 7700 + below RFFS → DECLARE NOW
     · DOWNGRADE   req-cat ≥ avail-cat + 2 → divert per CAP 168 ch.8
     · DEFICIT     agent shortfall vs Q1/Q2 → request mutual-aid
     · MARGINAL    req-cat = avail-cat + 1 → notify ARFF chief
     · ADEQUATE    req-cat ≤ avail-cat → monitor only
     · IDLE        no in-scope arrival
============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  squawk?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'GROUND-EMG' | 'DOWNGRADE' | 'DEFICIT' | 'MARGINAL' | 'ADEQUATE' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'GROUND-EMG': '#ef4444', DOWNGRADE: '#f43f5e', DEFICIT: '#f43f5e',
  MARGINAL: '#f59e0b', ADEQUATE: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['GROUND-EMG', 'DOWNGRADE', 'DEFICIT', 'MARGINAL', 'ADEQUATE', 'IDLE']
const TIER_RANK: Record<Tier, number> = { 'GROUND-EMG': 0, DOWNGRADE: 1, DEFICIT: 2, MARGINAL: 3, ADEQUATE: 4, IDLE: 5 }

/* ICAO Annex 14 Vol I Table 9-1 — RFFS Category by length & fuselage width.
   Cat | overall length (m)        | max fuselage width (m)
    1  | <9                        | 2
    2  | 9-12                      | 2
    3  | 12-18                     | 3
    4  | 18-24                     | 4
    5  | 24-28                     | 4
    6  | 28-39                     | 5
    7  | 39-49                     | 5
    8  | 49-61                     | 7
    9  | 61-76                     | 7
   10  | 76-90                     | 8                                          */
interface RfCat { cat: number; q1Lwater: number; q2Lwater: number; foamLpm: number; complement: number; minVehicles: number }
/* Table values per Doc 9137 Pt 1 §2 and Annex 14 §9.2.5 Table 9-2 (Performance Level B foam, water for Q1 and Q2). */
const RFCAT: Record<number, RfCat> = {
  1:  { cat: 1,  q1Lwater:    230, q2Lwater:    0,    foamLpm:  230, complement:  2200, minVehicles: 1 },
  2:  { cat: 2,  q1Lwater:    670, q2Lwater:    0,    foamLpm:  550, complement:  4500, minVehicles: 1 },
  3:  { cat: 3,  q1Lwater:   1200, q2Lwater:    0,    foamLpm:  900, complement:  4500, minVehicles: 1 },
  4:  { cat: 4,  q1Lwater:   2400, q2Lwater:    0,    foamLpm: 1800, complement:  4500, minVehicles: 1 },
  5:  { cat: 5,  q1Lwater:   5400, q2Lwater: 1500,    foamLpm: 3000, complement:  4500, minVehicles: 1 },
  6:  { cat: 6,  q1Lwater:   7900, q2Lwater: 3300,    foamLpm: 4000, complement:  4500, minVehicles: 2 },
  7:  { cat: 7,  q1Lwater:  12100, q2Lwater: 6300,    foamLpm: 5300, complement:  4500, minVehicles: 2 },
  8:  { cat: 8,  q1Lwater:  18200, q2Lwater: 7900,    foamLpm: 7200, complement:  4500, minVehicles: 3 },
  9:  { cat: 9,  q1Lwater:  24300, q2Lwater: 10800,   foamLpm: 9000, complement:  4500, minVehicles: 3 },
  10: { cat: 10, q1Lwater:  32300, q2Lwater: 13500,   foamLpm:11200, complement:  4500, minVehicles: 3 },
}

interface AcDim { type: string; lengthM: number; fuselageM: number; reqCat: number }
/* Synthetic but accurate dimensions for common ICAO airframe codes. */
const AC_DIMS: Record<string, AcDim> = {
  // Cat 3-4
  'C25A': { type: 'C25A', lengthM: 14.4, fuselageM: 1.6, reqCat: 3 },
  'PC12': { type: 'PC12', lengthM: 14.4, fuselageM: 1.7, reqCat: 3 },
  'DH8A': { type: 'DH8A', lengthM: 22.3, fuselageM: 2.7, reqCat: 4 },
  'AT72': { type: 'AT72', lengthM: 27.2, fuselageM: 2.9, reqCat: 5 },
  // Cat 5-6
  'E170': { type: 'E170', lengthM: 29.9, fuselageM: 3.0, reqCat: 6 },
  'E190': { type: 'E190', lengthM: 36.2, fuselageM: 3.0, reqCat: 6 },
  'CRJ9': { type: 'CRJ9', lengthM: 36.4, fuselageM: 2.7, reqCat: 6 },
  'BCS3': { type: 'BCS3', lengthM: 38.7, fuselageM: 3.7, reqCat: 6 },
  // Cat 7
  'A319': { type: 'A319', lengthM: 33.8, fuselageM: 4.0, reqCat: 7 },
  'A320': { type: 'A320', lengthM: 37.6, fuselageM: 4.0, reqCat: 7 },
  'A321': { type: 'A321', lengthM: 44.5, fuselageM: 4.0, reqCat: 7 },
  'B737': { type: 'B737', lengthM: 39.5, fuselageM: 3.8, reqCat: 7 },
  'B738': { type: 'B738', lengthM: 39.5, fuselageM: 3.8, reqCat: 7 },
  'B739': { type: 'B739', lengthM: 42.1, fuselageM: 3.8, reqCat: 7 },
  'B752': { type: 'B752', lengthM: 47.3, fuselageM: 3.8, reqCat: 7 },
  // Cat 8
  'B753': { type: 'B753', lengthM: 54.4, fuselageM: 3.8, reqCat: 8 },
  'B762': { type: 'B762', lengthM: 48.5, fuselageM: 5.0, reqCat: 8 },
  'B763': { type: 'B763', lengthM: 54.9, fuselageM: 5.0, reqCat: 8 },
  'A332': { type: 'A332', lengthM: 58.8, fuselageM: 5.6, reqCat: 8 },
  'A333': { type: 'A333', lengthM: 63.7, fuselageM: 5.6, reqCat: 9 },
  // Cat 9
  'A359': { type: 'A359', lengthM: 66.8, fuselageM: 5.9, reqCat: 9 },
  'A35K': { type: 'A35K', lengthM: 73.8, fuselageM: 5.9, reqCat: 9 },
  'B772': { type: 'B772', lengthM: 63.7, fuselageM: 6.2, reqCat: 9 },
  'B77W': { type: 'B77W', lengthM: 73.9, fuselageM: 6.2, reqCat: 9 },
  'B788': { type: 'B788', lengthM: 56.7, fuselageM: 5.8, reqCat: 8 },
  'B789': { type: 'B789', lengthM: 62.8, fuselageM: 5.8, reqCat: 9 },
  'B78X': { type: 'B78X', lengthM: 68.3, fuselageM: 5.8, reqCat: 9 },
  // Cat 10
  'B744': { type: 'B744', lengthM: 70.7, fuselageM: 6.5, reqCat: 9 },
  'B748': { type: 'B748', lengthM: 76.3, fuselageM: 6.5, reqCat: 10 },
  'A388': { type: 'A388', lengthM: 72.7, fuselageM: 7.1, reqCat: 10 },
  'AN24': { type: 'AN24', lengthM: 23.5, fuselageM: 2.9, reqCat: 4 },
}

function dimsFor(type?: string): AcDim {
  if (!type) return { type: '—', lengthM: 35, fuselageM: 3.5, reqCat: 6 }
  return AC_DIMS[type] || { type, lengthM: 35, fuselageM: 3.5, reqCat: 6 }
}

interface Apt { icao: string; name: string; lat: number; lng: number; cat: number; agentL: number; vehicles: number; rvrM: number; country: string }
const AIRPORTS: Apt[] = [
  // ICAO cat 10 — A380 / 748-capable
  { icao: 'EGLL', name: 'London Heathrow',          lat: 51.4775, lng: -0.4614,  cat: 10, agentL: 36000, vehicles: 6, rvrM: 1500, country: 'UK' },
  { icao: 'KJFK', name: 'New York JFK',             lat: 40.6398, lng: -73.7789, cat: 10, agentL: 34000, vehicles: 6, rvrM: 1500, country: 'US' },
  { icao: 'KLAX', name: 'Los Angeles Intl',         lat: 33.9416, lng: -118.4085, cat: 10, agentL: 34000, vehicles: 6, rvrM: 2000, country: 'US' },
  { icao: 'KORD', name: "Chicago O'Hare",           lat: 41.9742, lng: -87.9073, cat: 10, agentL: 34000, vehicles: 6, rvrM: 1200, country: 'US' },
  { icao: 'KATL', name: 'Atlanta Hartsfield',       lat: 33.6407, lng: -84.4277, cat: 10, agentL: 34000, vehicles: 6, rvrM: 1500, country: 'US' },
  { icao: 'KDFW', name: 'Dallas/Fort Worth',        lat: 32.8998, lng: -97.0403, cat: 10, agentL: 33000, vehicles: 6, rvrM: 1800, country: 'US' },
  { icao: 'EHAM', name: 'Amsterdam Schiphol',       lat: 52.3105, lng:  4.7683,  cat: 10, agentL: 35000, vehicles: 6, rvrM: 1500, country: 'NL' },
  { icao: 'EDDF', name: 'Frankfurt Main',           lat: 50.0379, lng:  8.5622,  cat: 10, agentL: 35000, vehicles: 6, rvrM: 1500, country: 'DE' },
  { icao: 'LFPG', name: 'Paris Charles de Gaulle',  lat: 49.0097, lng:  2.5479,  cat: 10, agentL: 35000, vehicles: 6, rvrM: 1500, country: 'FR' },
  { icao: 'OMDB', name: 'Dubai Intl',               lat: 25.2532, lng: 55.3657,  cat: 10, agentL: 38000, vehicles: 7, rvrM: 1200, country: 'AE' },
  { icao: 'WSSS', name: 'Singapore Changi',         lat:  1.3644, lng:103.9915,  cat: 10, agentL: 36000, vehicles: 6, rvrM: 1500, country: 'SG' },
  { icao: 'VHHH', name: 'Hong Kong Intl',           lat: 22.3080, lng:113.9185,  cat: 10, agentL: 36000, vehicles: 6, rvrM: 1500, country: 'HK' },
  { icao: 'RJAA', name: 'Tokyo Narita',             lat: 35.7720, lng:140.3929,  cat: 10, agentL: 35000, vehicles: 6, rvrM: 1500, country: 'JP' },
  { icao: 'YSSY', name: 'Sydney Kingsford-Smith',   lat: -33.9461, lng:151.1772, cat: 10, agentL: 34000, vehicles: 5, rvrM: 1500, country: 'AU' },

  // ICAO cat 9 — 777/A350
  { icao: 'KSFO', name: 'San Francisco Intl',       lat: 37.6188, lng: -122.3754, cat: 9, agentL: 28000, vehicles: 5, rvrM: 800,  country: 'US' },
  { icao: 'KSEA', name: 'Seattle Tacoma',           lat: 47.4502, lng: -122.3088, cat: 9, agentL: 27000, vehicles: 5, rvrM: 1500, country: 'US' },
  { icao: 'KBOS', name: 'Boston Logan',             lat: 42.3656, lng:  -71.0096, cat: 9, agentL: 26000, vehicles: 5, rvrM: 1200, country: 'US' },
  { icao: 'EGKK', name: 'London Gatwick',           lat: 51.1481, lng:  -0.1903, cat: 9, agentL: 26000, vehicles: 5, rvrM: 1500, country: 'UK' },
  { icao: 'EIDW', name: 'Dublin',                   lat: 53.4213, lng:  -6.2701, cat: 9, agentL: 26000, vehicles: 4, rvrM: 1500, country: 'IE' },
  { icao: 'CYYZ', name: 'Toronto Pearson',          lat: 43.6777, lng: -79.6248, cat: 9, agentL: 28000, vehicles: 5, rvrM: 1200, country: 'CA' },

  // ICAO cat 8 — 767/787
  { icao: 'KSAN', name: 'San Diego Intl',           lat: 32.7338, lng: -117.1933, cat: 8, agentL: 19000, vehicles: 4, rvrM: 1500, country: 'US' },
  { icao: 'KMDW', name: 'Chicago Midway',           lat: 41.7868, lng:  -87.7522, cat: 8, agentL: 19000, vehicles: 4, rvrM: 1500, country: 'US' },
  { icao: 'EGSS', name: 'London Stansted',          lat: 51.8849, lng:   0.2350, cat: 8, agentL: 19000, vehicles: 4, rvrM: 1500, country: 'UK' },

  // ICAO cat 7 — 737/A320
  { icao: 'KBUR', name: 'Hollywood Burbank',        lat: 34.2007, lng: -118.3585, cat: 7, agentL: 12500, vehicles: 3, rvrM: 2000, country: 'US' },
  { icao: 'KLGB', name: 'Long Beach',               lat: 33.8177, lng: -118.1516, cat: 7, agentL: 12500, vehicles: 3, rvrM: 1500, country: 'US' },
  { icao: 'KISP', name: 'Long Island MacArthur',    lat: 40.7952, lng:  -73.1002, cat: 7, agentL: 12500, vehicles: 3, rvrM: 1500, country: 'US' },
  { icao: 'EGLC', name: 'London City',              lat: 51.5053, lng:   0.0553, cat: 7, agentL: 13000, vehicles: 3, rvrM:  900, country: 'UK' },

  // ICAO cat 6 — E-Jet / CRJ
  { icao: 'KTEB', name: 'Teterboro',                lat: 40.8501, lng:  -74.0608, cat: 6, agentL:  8000, vehicles: 2, rvrM: 1500, country: 'US' },
  { icao: 'EGGW', name: 'London Luton',             lat: 51.8747, lng:  -0.3683, cat: 6, agentL:  8000, vehicles: 2, rvrM: 1500, country: 'UK' },

  // ICAO cat 4 — turboprop
  { icao: 'EGHI', name: 'Southampton',              lat: 50.9503, lng:  -1.3568, cat: 4, agentL:  2500, vehicles: 1, rvrM: 1500, country: 'UK' },
]

interface Eval {
  f: SFlight; apt: Apt; dim: AcDim
  distNm: number; phase: 'APP' | 'ROLL' | 'GND' | 'OTHER'
  reqCat: number; gap: number
  agentReqL: number; agentDeficitL: number
  vehiclesReqMin: number; vehiclesAvail: number
  rspSec: number; emerg: boolean; emergKind?: string
  drivers: { CAT: number; AGT: number; VEH: number; RSP: number; EMG: number; WX: number }
  score: number; tier: Tier; advice: string
}

function haversineNm(la1: number, lo1: number, la2: number, lo2: number) {
  const R = 3440.065
  const t1 = la1 * Math.PI / 180, t2 = la2 * Math.PI / 180
  const dt = (la2 - la1) * Math.PI / 180, dl = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dt / 2) ** 2 + Math.cos(t1) * Math.cos(t2) * Math.sin(dl / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)) }

const lsGet = (k: string, d: any) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v) } catch { return d } }
const lsSet = (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

export default function RffsMonitor({ map, flights, onClose, onFly }: Props) {
  const [scopeNm, setScopeNm] = useState<number>(() => lsGet('ft-rffs-scope', 25))
  const [advMul, setAdvMul] = useState<number>(() => lsGet('ft-rffs-adv', 100))
  const [agtMul, setAgtMul] = useState<number>(() => lsGet('ft-rffs-agt', 100))
  const [rspMul, setRspMul] = useState<number>(() => lsGet('ft-rffs-rsp', 100))
  const [minCat, setMinCat] = useState<number>(() => lsGet('ft-rffs-mincat', 3))
  const [maxAlt, setMaxAlt] = useState<number>(() => lsGet('ft-rffs-maxalt', 6000))
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [catFilter, setCatFilter] = useState<number | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS' | 'CATS'>('AIRCRAFT')
  const [query, setQuery] = useState('')
  const [showHalo, setShowHalo] = useState<boolean>(() => lsGet('ft-rffs-halo', true))
  const [showPin, setShowPin] = useState<boolean>(() => lsGet('ft-rffs-pin', true))
  const [showLbl, setShowLbl] = useState<boolean>(() => lsGet('ft-rffs-lbl', true))
  const [showApt, setShowApt] = useState<boolean>(() => lsGet('ft-rffs-apt', true))
  const [showLink, setShowLink] = useState<boolean>(() => lsGet('ft-rffs-link', true))
  const [showDiag, setShowDiag] = useState<boolean>(() => lsGet('ft-rffs-diag', true))

  useEffect(()=>{lsSet('ft-rffs-scope',scopeNm)},[scopeNm])
  useEffect(()=>{lsSet('ft-rffs-adv',advMul)},[advMul])
  useEffect(()=>{lsSet('ft-rffs-agt',agtMul)},[agtMul])
  useEffect(()=>{lsSet('ft-rffs-rsp',rspMul)},[rspMul])
  useEffect(()=>{lsSet('ft-rffs-mincat',minCat)},[minCat])
  useEffect(()=>{lsSet('ft-rffs-maxalt',maxAlt)},[maxAlt])
  useEffect(()=>{lsSet('ft-rffs-halo',showHalo)},[showHalo])
  useEffect(()=>{lsSet('ft-rffs-pin',showPin)},[showPin])
  useEffect(()=>{lsSet('ft-rffs-lbl',showLbl)},[showLbl])
  useEffect(()=>{lsSet('ft-rffs-apt',showApt)},[showApt])
  useEffect(()=>{lsSet('ft-rffs-link',showLink)},[showLink])
  useEffect(()=>{lsSet('ft-rffs-diag',showDiag)},[showDiag])

  const evals = useMemo<Eval[]>(() => {
    const out: Eval[] = []
    for (const f of flights) {
      if (f.altitudeFt > maxAlt && !f.ground) continue
      let best: { apt: Apt; nm: number } | null = null
      for (const apt of AIRPORTS) {
        const nm = haversineNm(f.lat, f.lng, apt.lat, apt.lng)
        if (nm > scopeNm) continue
        if (!best || nm < best.nm) best = { apt, nm }
      }
      if (!best) continue
      const apt = best.apt
      const dim = dimsFor(f.type)
      if (dim.reqCat < minCat) continue

      const phase: Eval['phase'] = f.ground
        ? 'GND'
        : f.altitudeFt < 100 && f.velocityKts > 60 ? 'ROLL'
        : f.altitudeFt < maxAlt && f.vertRate < -200 ? 'APP'
        : 'OTHER'

      // Required RFFS table
      const reqEntry = RFCAT[dim.reqCat]
      const aptEntry = RFCAT[apt.cat]
      const gap = dim.reqCat - apt.cat
      const agentReqL = reqEntry.q1Lwater + reqEntry.q2Lwater
      const agentDeficitL = Math.max(0, agentReqL - apt.agentL)
      const vehiclesReqMin = reqEntry.minVehicles
      const vehiclesDeficit = Math.max(0, vehiclesReqMin - apt.vehicles)

      // Response time proxy: distance from apt centre / 60 km/h vehicle
      // Annex 14 §9.2.11 — ≤3 min anywhere on movement area
      const ftBeyondCenter = best.nm * 6076
      const rspSec = Math.max(60, (ftBeyondCenter / 88) + 60) // 60ft/s = 60mph, +60s mobilization

      // Emergency state detection
      const sq = f.squawk || ''
      let emerg = false; let emergKind: string | undefined
      if (sq === '7700') { emerg = true; emergKind = '7700 GEN-EMG' }
      else if (sq === '7600') { emerg = true; emergKind = '7600 RADIO' }
      else if (sq === '7500') { emerg = true; emergKind = '7500 UNLAWFUL' }
      else if (phase === 'APP' && f.vertRate < -1800) { emerg = true; emergKind = 'STEEP-DES' }

      // Synthetic RVR/visibility (lower is worse)
      const wxRisk = apt.rvrM < 600 ? 80 : apt.rvrM < 1000 ? 55 : apt.rvrM < 1500 ? 25 : 5

      const CAT = gap >= 3 ? 100 : gap >= 2 ? 80 : gap >= 1 ? 55 : 5
      const AGT = clamp((agentDeficitL / Math.max(1, agentReqL)) * 130 * (agtMul / 100), 0, 100)
      const VEH = vehiclesDeficit >= 2 ? 95 : vehiclesDeficit === 1 ? 60 : 5
      const RSP = clamp(((rspSec - 90) / 120) * 100 * (rspMul / 100), 0, 100)
      const EMG = emerg ? (sq === '7700' ? 100 : sq === '7500' ? 95 : sq === '7600' ? 70 : 65) : 0
      const WX = wxRisk

      const drivers = { CAT, AGT, VEH, RSP, EMG, WX }
      const max = Math.max(CAT, AGT, VEH, RSP, EMG, WX)
      const secondary = (CAT + AGT + VEH + RSP + EMG + WX - max) / 5
      let score = (max * 0.78 + secondary * 0.22) * (advMul / 100)

      // Hard escalations
      if (emerg && gap >= 0) score = Math.max(score, 92)
      if (gap >= 2) score = Math.max(score, 80)
      score = clamp(score, 0, 100)

      let tier: Tier = 'IDLE'
      if (phase === 'GND' && emerg && gap >= 0) tier = 'GROUND-EMG'
      else if (gap >= 2) tier = 'DOWNGRADE'
      else if (agentDeficitL > 0 || vehiclesDeficit > 0) tier = 'DEFICIT'
      else if (gap === 1) tier = 'MARGINAL'
      else if (phase === 'APP' || phase === 'ROLL' || phase === 'GND') tier = 'ADEQUATE'
      else tier = 'IDLE'

      let advice = ''
      switch (tier) {
        case 'GROUND-EMG': advice = `Declare emergency now — ARFF rolling, ${emergKind || 'EMG'}, RFFS Cat ${apt.cat} vs req Cat ${dim.reqCat} (Annex 14 §9.2.11 / Part 139.319 / NFPA 403 §6).`; break
        case 'DOWNGRADE':  advice = `RFFS gap ${gap} cat — divert to higher-cat alt per CAP 168 ch.8 / CS-ADR-DSN.D.305 or accept reduced cover per EASA AMC1 ADR.OPS.B.015.`; break
        case 'DEFICIT':    advice = `Agent shortfall ${agentDeficitL.toFixed(0)} L vs Q1+Q2 ${agentReqL} L — mutual-aid per Annex 14 §9.2.6 / Doc 9137 Pt 1 §6 critical-area methodology.`; break
        case 'MARGINAL':   advice = `RFFS marginal — notify ARFF chief, pre-position vehicle per AC 150/5210-6E §4, monitor.`; break
        case 'ADEQUATE':   advice = `RFFS Cat ${apt.cat} ≥ req ${dim.reqCat}, ${apt.agentL} L agent, ${apt.vehicles} veh — nominal per Annex 14 §9.2.5 Table 9-2.`; break
        case 'IDLE':       advice = ''
      }

      out.push({ f, apt, dim, distNm: best.nm, phase, reqCat: dim.reqCat, gap, agentReqL, agentDeficitL, vehiclesReqMin, vehiclesAvail: apt.vehicles, rspSec, emerg, emergKind, drivers, score, tier, advice })
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, scopeNm, advMul, agtMul, rspMul, minCat, maxAlt])

  const filtered = useMemo(() => {
    let r = evals
    if (tierFilter !== 'ALL') r = r.filter(e => e.tier === tierFilter)
    if (catFilter !== 'ALL') r = r.filter(e => e.reqCat === catFilter)
    if (query) { const q = query.toLowerCase(); r = r.filter(e => (e.f.callsign || '').toLowerCase().includes(q) || (e.f.type || '').toLowerCase().includes(q) || e.apt.icao.toLowerCase().includes(q) || e.apt.name.toLowerCase().includes(q)) }
    return r
  }, [evals, tierFilter, catFilter, query])

  const tierCount = useMemo(() => {
    const c: Record<Tier, number> = { 'GROUND-EMG': 0, DOWNGRADE: 0, DEFICIT: 0, MARGINAL: 0, ADEQUATE: 0, IDLE: 0 }
    for (const e of evals) c[e.tier]++
    return c
  }, [evals])
  const meanScore = evals.length ? evals.reduce((s, e) => s + e.score, 0) / evals.length : 0
  const worst = evals[0]
  const groundEmgN = tierCount['GROUND-EMG']
  const downgradeN = tierCount.DOWNGRADE
  const deficitN = tierCount.DEFICIT
  const sumAgentDef = evals.reduce((s, e) => s + e.agentDeficitL, 0)

  /* ── Map layers ─────────────────────────────────────────── */
  useEffect(() => {
    if (!map) return
    const SRC_APT = 'rffs-apt', SRC_LBL = 'rffs-lbl', SRC_HALO = 'rffs-halo', SRC_PIN = 'rffs-pin', SRC_LINK = 'rffs-link', SRC_AL = 'rffs-aptlbl'
    const LYR_APT = 'rffs-apt-l', LYR_LBL = 'rffs-lbl-l', LYR_HALO = 'rffs-halo-l', LYR_PIN = 'rffs-pin-l', LYR_LINK = 'rffs-link-l', LYR_AL = 'rffs-aptlbl-l'
    const ensure = (id: string, kind: 'circle' | 'line' | 'symbol', src: string, paint?: any, layout?: any) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type: kind, source: src, paint: paint || {}, ...(layout ? { layout } : {}) } as any)
    }
    ensure(SRC_APT, 'circle', SRC_APT, { 'circle-radius': ['interpolate', ['linear'], ['get', 'cat'], 4, 4, 10, 12], 'circle-color': ['get', 'color'], 'circle-opacity': 0.6, 'circle-stroke-width': 1.4, 'circle-stroke-color': '#fff' })
    ensure(LYR_AL, 'symbol', SRC_AL, {}, { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, -1.2], 'text-anchor': 'bottom', 'text-font': ['Open Sans Regular'] })
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN, 'circle', SRC_PIN, { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_LINK, 'line', SRC_LINK, { 'line-color': ['get', 'color'], 'line-width': 1.3, 'line-opacity': 0.8, 'line-dasharray': [2, 2] })
    ensure(LYR_LBL, 'symbol', SRC_LBL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL)) { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }
    if (map.getLayer(LYR_AL)) { map.setPaintProperty(LYR_AL, 'text-color', '#7dd3fc'); map.setPaintProperty(LYR_AL, 'text-halo-color', '#020617'); map.setPaintProperty(LYR_AL, 'text-halo-width', 1.4) }

    const aptFeats: any[] = [], aptLbl: any[] = []
    if (showApt) {
      const activeIcao = new Set(evals.map(e => e.apt.icao))
      for (const apt of AIRPORTS) {
        const col = apt.cat >= 9 ? '#10b981' : apt.cat >= 7 ? '#0ea5e9' : apt.cat >= 5 ? '#f59e0b' : '#f43f5e'
        aptFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [apt.lng, apt.lat] }, properties: { color: col, cat: apt.cat } })
        if (activeIcao.has(apt.icao)) aptLbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [apt.lng, apt.lat] }, properties: { label: `${apt.icao}·Cat${apt.cat}` } })
      }
    }
    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = []
    for (const e of filtered) {
      const color = TIER_COLOR[e.tier]
      if (showHalo && e.tier !== 'IDLE' && e.tier !== 'ADEQUATE') halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, r: 8 + e.score * 0.14 } })
      if (showPin && (e.tier === 'GROUND-EMG' || e.tier === 'DOWNGRADE' || e.tier === 'DEFICIT')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color } })
      if (showLbl && e.tier !== 'IDLE' && e.tier !== 'ADEQUATE') {
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, label: `${e.f.callsign || e.f.icao} › ${e.apt.icao} · req Cat${e.reqCat}/avail Cat${e.apt.cat} · ${e.tier}` } })
      }
      if (showLink && e.tier !== 'IDLE' && e.tier !== 'ADEQUATE') {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[e.f.lng, e.f.lat], [e.apt.lng, e.apt.lat]] }, properties: { color } })
      }
    }
    ;(map.getSource(SRC_APT) as any).setData({ type: 'FeatureCollection', features: aptFeats })
    ;(map.getSource(SRC_AL) as any).setData({ type: 'FeatureCollection', features: aptLbl })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_AL, LYR_APT]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_LINK, SRC_AL, SRC_APT]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, evals, showHalo, showPin, showLbl, showApt, showLink])

  const tierBadge = (t: Tier) => <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  const catBadge = (c: number) => { const col = c >= 9 ? '#10b981' : c >= 7 ? '#0ea5e9' : c >= 5 ? '#f59e0b' : '#f43f5e'; return <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: col, backgroundColor: col + '1f', border: `1px solid ${col}55` }}>Cat{c}</span> }
  const phaseBadge = (p: Eval['phase']) => { const col = p === 'GND' ? '#a855f7' : p === 'ROLL' ? '#f43f5e' : p === 'APP' ? '#0ea5e9' : '#64748b'; return <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: col, backgroundColor: col + '1f', border: `1px solid ${col}55` }}>{p}</span> }
  const drvBadge = (k: string, v: number) => { const c = v >= 70 ? '#ef4444' : v >= 40 ? '#f59e0b' : v >= 18 ? '#0ea5e9' : '#10b981'; return <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: c, backgroundColor: c + '1c', border: `1px solid ${c}55` }}>{k}{v.toFixed(0)}</span> }

  // Scatter: req-cat vs gap
  const W = 280, H = 110, padL = 28, padB = 16, padT = 6, padR = 6
  const sx = (v: number) => padL + ((clamp(v, 1, 10) - 1) / 9) * (W - padL - padR)
  const sy = (v: number) => padT + (1 - (clamp(v, -2, 6) - (-2)) / 8) * (H - padT - padB)

  // Per-airport summary
  const aptAgg = useMemo(() => {
    const m: Record<string, { apt: Apt; ac: number; gnd: number; downgrade: number; deficit: number; mean: number; worstReq: number }> = {}
    for (const apt of AIRPORTS) m[apt.icao] = { apt, ac: 0, gnd: 0, downgrade: 0, deficit: 0, mean: 0, worstReq: 0 }
    for (const e of evals) {
      const a = m[e.apt.icao]; a.ac++; a.mean += e.score
      if (e.phase === 'GND') a.gnd++
      if (e.tier === 'DOWNGRADE') a.downgrade++
      if (e.tier === 'DEFICIT') a.deficit++
      if (e.reqCat > a.worstReq) a.worstReq = e.reqCat
    }
    return Object.values(m).filter(a => a.ac > 0).map(a => ({ ...a, mean: a.ac ? a.mean / a.ac : 0 })).sort((a, b) => b.downgrade - a.downgrade || b.ac - a.ac)
  }, [evals])

  return (
    <div className="absolute right-3 top-20 z-40 w-[27rem] max-h-[calc(100vh-6rem)] flex flex-col bg-slate-900/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-sky-500 animate-pulse" />
          <span className="text-[10px] font-bold tracking-widest uppercase text-sky-400">RFFS · ARFF Category Compliance</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm leading-none">×</button>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[7px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean score</div><div className="text-sm font-semibold" style={{ color: meanScore >= 65 ? '#ef4444' : meanScore >= 35 ? '#f59e0b' : '#10b981' }}>{meanScore.toFixed(0)}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Worst</div><div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Ground-EMG</div><div className="text-sm font-semibold" style={{ color: groundEmgN > 0 ? '#ef4444' : '#10b981' }}>{groundEmgN}</div></div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Downgrades</div><div className="text-xs font-semibold" style={{ color: downgradeN > 0 ? '#f43f5e' : '#10b981' }}>{downgradeN}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Agent-def</div><div className="text-xs font-semibold" style={{ color: deficitN > 0 ? '#f43f5e' : '#10b981' }}>{deficitN}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Σ deficit L</div><div className="text-xs font-semibold" style={{ color: sumAgentDef > 0 ? '#f43f5e' : '#10b981' }}>{sumAgentDef > 0 ? (sumAgentDef / 1000).toFixed(1) + 'kL' : '—'}</div></div>
      </div>

      {showDiag && evals.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* breach band: gap >= 2 */}
            <rect x={padL} y={padT} width={W - padL - padR} height={sy(2) - padT} fill="#ef444415" />
            {/* clear band: gap <= 0 */}
            <rect x={padL} y={sy(0)} width={W - padL - padR} height={H - padB - sy(0)} fill="#10b98112" />
            <line x1={padL} y1={sy(0)} x2={W - padR} y2={sy(0)} stroke="#10b98166" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={padL} y1={sy(2)} x2={W - padR} y2={sy(2)} stroke="#ef444466" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={padL} y={H - 3} fill="#475569" fontSize="8">reqCat→</text>
            <text x={W - 30} y={padT + 7} fill="#475569" fontSize="8">gap↑</text>
            {evals.map((e, i) => (
              <circle key={i} cx={sx(e.reqCat)} cy={sy(e.gap)} r={2.4} fill={TIER_COLOR[e.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          <label className="text-[9px] text-slate-400">Scope {scopeNm}NM<input type="range" min={5} max={80} value={scopeNm} onChange={e => setScopeNm(+e.target.value)} className="w-full accent-sky-500" /></label>
          <label className="text-[9px] text-slate-400">Max alt {maxAlt}ft<input type="range" min={500} max={12000} step={500} value={maxAlt} onChange={e => setMaxAlt(+e.target.value)} className="w-full accent-sky-500" /></label>
          <label className="text-[9px] text-slate-400">Adv ×{advMul}%<input type="range" min={50} max={200} value={advMul} onChange={e => setAdvMul(+e.target.value)} className="w-full accent-sky-500" /></label>
          <label className="text-[9px] text-slate-400">Agent ×{agtMul}%<input type="range" min={50} max={200} value={agtMul} onChange={e => setAgtMul(+e.target.value)} className="w-full accent-sky-500" /></label>
          <label className="text-[9px] text-slate-400">Resp ×{rspMul}%<input type="range" min={50} max={200} value={rspMul} onChange={e => setRspMul(+e.target.value)} className="w-full accent-sky-500" /></label>
          <label className="text-[9px] text-slate-400">Min req-Cat {minCat}<input type="range" min={1} max={10} value={minCat} onChange={e => setMinCat(+e.target.value)} className="w-full accent-sky-500" /></label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL', 3, 4, 5, 6, 7, 8, 9, 10] as const).map(c => (
            <button key={String(c)} onClick={() => setCatFilter(c as any)} className="px-1.5 py-0.5 rounded text-[9px] font-mono" style={{ color: catFilter === c ? '#7dd3fc' : '#94a3b8', backgroundColor: catFilter === c ? '#0ea5e933' : '#0b1220', border: '1px solid ' + (catFilter === c ? '#0ea5e9' : '#1e293b') }}>{c === 'ALL' ? 'ALL' : 'Cat' + c}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {[['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLbl, setShowLbl], ['APT', showApt, setShowApt], ['LINK', showLink, setShowLink], ['DIAG', showDiag, setShowDiag]].map(([k, v, fn]: any) => (
            <button key={k} onClick={() => fn((x: boolean) => !x)} className="px-1.5 py-0.5 rounded text-[9px] font-mono" style={{ color: v ? '#7dd3fc' : '#64748b', backgroundColor: v ? '#0ea5e91f' : '#0b1220', border: '1px solid ' + (v ? '#0ea5e966' : '#1e293b') }}>{k}</button>
          ))}
        </div>
        <input type="text" placeholder="Search callsign / type / airport…" value={query} onChange={e => setQuery(e.target.value)} className="w-full px-2 py-1 bg-slate-950 border border-slate-800 rounded text-[10px] text-slate-200 placeholder:text-slate-600" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'AIRPORTS', 'CATS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} className="flex-1 px-2 py-1 rounded text-[10px] font-semibold" style={{ color: tab === t ? '#0ea5e9' : '#94a3b8', backgroundColor: tab === t ? '#0ea5e924' : '#0b1220', border: '1px solid ' + (tab === t ? '#0ea5e966' : '#1e293b') }}>{t}</button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-slate-500">No in-scope arrivals at catalogued airports.</div>}
            {filtered.map((e, i) => (
              <button key={e.f.icao + '/' + e.apt.icao + '/' + i} onClick={() => onFly(e.f.icao)} className="w-full text-left px-3 py-2 hover:bg-slate-800/30 transition" style={{ borderLeft: '3px solid ' + TIER_COLOR[e.tier] }}>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-mono text-[11px] font-semibold text-slate-100 truncate">{e.f.callsign || e.f.icao}</span>
                    <span className="text-[9px] text-slate-500 font-mono truncate">{e.f.type || '—'}</span>
                    {phaseBadge(e.phase)} {catBadge(e.reqCat)} {tierBadge(e.tier)}
                  </div>
                </div>
                <div className="text-[10px] text-slate-400 font-mono flex flex-wrap gap-x-2 gap-y-0.5">
                  <span className="text-sky-300">{e.apt.icao}</span>
                  <span className="text-slate-500 italic truncate max-w-[12rem]">{e.apt.name}</span>
                  {catBadge(e.apt.cat)}
                  <span style={{ color: e.gap >= 2 ? '#f43f5e' : e.gap === 1 ? '#f59e0b' : '#10b981' }}>gap {e.gap >= 0 ? '+' : ''}{e.gap}</span>
                  <span className="text-slate-500">{e.distNm.toFixed(1)}NM</span>
                </div>
                <div className="text-[10px] text-slate-400 font-mono flex flex-wrap gap-x-2 gap-y-0.5 mt-0.5">
                  <span style={{ color: e.agentDeficitL > 0 ? '#f43f5e' : '#10b981' }}>agent {e.apt.agentL}L / req {e.agentReqL}L</span>
                  <span style={{ color: e.apt.vehicles < e.vehiclesReqMin ? '#f43f5e' : '#10b981' }}>veh {e.apt.vehicles}/≥{e.vehiclesReqMin}</span>
                  <span style={{ color: e.rspSec > 180 ? '#f43f5e' : e.rspSec > 120 ? '#f59e0b' : '#10b981' }}>rsp {e.rspSec.toFixed(0)}s</span>
                  {e.emerg && <span className="text-rose-400">⚠ {e.emergKind}</span>}
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                  <div style={{ width: e.score + '%', backgroundColor: TIER_COLOR[e.tier] }} className="h-full" />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {drvBadge('CAT', e.drivers.CAT)} {drvBadge('AGT', e.drivers.AGT)} {drvBadge('VEH', e.drivers.VEH)} {drvBadge('RSP', e.drivers.RSP)} {drvBadge('EMG', e.drivers.EMG)} {drvBadge('WX', e.drivers.WX)}
                </div>
                {e.advice && <div className="mt-1 text-[10px]" style={{ color: TIER_COLOR[e.tier] }}>{e.advice}</div>}
              </button>
            ))}
          </div>
        )}
        {tab === 'AIRPORTS' && (
          <div className="divide-y divide-slate-800/60">
            {aptAgg.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-slate-500">No catalogued airport has in-scope arrivals.</div>}
            {aptAgg.map(a => {
              const col = a.apt.cat >= 9 ? '#10b981' : a.apt.cat >= 7 ? '#0ea5e9' : a.apt.cat >= 5 ? '#f59e0b' : '#f43f5e'
              return (
                <div key={a.apt.icao} className="px-3 py-2" style={{ borderLeft: '3px solid ' + col }}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="font-mono text-[11px] text-sky-300">{a.apt.icao}</span>
                    {catBadge(a.apt.cat)}
                    <span className="text-[9px] text-slate-500 italic truncate">{a.apt.name}</span>
                    <span className="text-[9px] text-slate-500 ml-auto">{a.apt.country}</span>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[10px] text-slate-400 font-mono">
                    <span>{a.apt.agentL}L agent</span>
                    <span>{a.apt.vehicles} veh</span>
                    <span>RVR {a.apt.rvrM}m</span>
                    <span>ac {a.ac}</span>
                    {a.gnd > 0 && <span className="text-violet-300">GND {a.gnd}</span>}
                    {a.downgrade > 0 && <span className="text-rose-400">DGR {a.downgrade}</span>}
                    {a.deficit > 0 && <span className="text-rose-300">DEF {a.deficit}</span>}
                    {a.worstReq > 0 && <span>worst-req {catBadge(a.worstReq)}</span>}
                  </div>
                  <div className="mt-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                    <div style={{ width: a.mean + '%', backgroundColor: a.mean >= 65 ? '#ef4444' : a.mean >= 35 ? '#f59e0b' : a.mean >= 18 ? '#0ea5e9' : '#10b981' }} className="h-full" />
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {tab === 'CATS' && (
          <div className="divide-y divide-slate-800/60">
            {Object.values(RFCAT).map(r => (
              <div key={r.cat} className="px-3 py-2" style={{ borderLeft: '3px solid ' + (r.cat >= 9 ? '#10b981' : r.cat >= 7 ? '#0ea5e9' : r.cat >= 5 ? '#f59e0b' : '#f43f5e') }}>
                <div className="flex items-center gap-1.5 mb-1">
                  {catBadge(r.cat)}
                  <span className="text-[10px] text-slate-300">Annex 14 Tbl 9-1 / Tbl 9-2 · Doc 9137 Pt 1 §2</span>
                </div>
                <div className="flex flex-wrap gap-2 text-[10px] text-slate-400 font-mono">
                  <span>Q1 {r.q1Lwater}L</span>
                  <span>Q2 {r.q2Lwater}L</span>
                  <span>foam {r.foamLpm}L/min</span>
                  <span>compl {r.complement}kg</span>
                  <span>veh ≥{r.minVehicles}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
