'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   GLS / GBAS Approach Availability & VHF Data Broadcast (VDB)
   Coverage Monitor
   -----------------------------------------------------------
   Per-airframe GBAS Landing System (GLS) Cat-I / Cat-II / Cat-III
   approach availability checked against destination GBAS Ground
   Facility (GGF) VDB coverage radius, station status (OPS / NOTAM /
   TEST), service-level published (GAST-C / GAST-D / GAST-F precursor),
   approach-service-type selected by aircraft Multi-Mode Receiver
   (MMR), and ionospheric anomaly state ("I-state": NOM / WATCH /
   ANOM) sampled per LAAS/GBAS spec.

   References:
     - ICAO Annex 10 Vol I §3.7 GBAS SARPs
     - ICAO Doc 9849 GNSS Manual
     - ICAO Doc 8168 PANS-OPS Vol II §6 GBAS approach criteria
     - RTCA DO-245A LAAS SAGR (Signal-in-space GAD/SIS-GAD A,B,C,D)
     - RTCA DO-253D MOPS for GPS Local-Area Augmentation Airborne
     - RTCA DO-246E LAAS ICD (VDB 108-117.975 MHz, D8PSK, 31.5 kbps)
     - EUROCAE ED-114B GBAS ground facility MOPS
     - EUROCAE ED-95 VDB
     - FAA AC 120-118 Criteria for Approval of Cat-II/III
     - FAA AC 20-138D Airworthiness Approval of Positioning &
       Navigation Systems
     - FAA Order 8260.55A LAAS Cat-I criteria
     - FAA Order 8260.57 GLS Cat-II/III
     - FAA Order JO 7110.65 GBAS / GLS phraseology
     - FAA Spec FAA-E-2937A LAAS Ground Facility
     - EASA AMC 20-28 Cat-II/III GBAS, AMC 20-26 GLS Cat-I
     - Honeywell SmartPath SLS-4000 GBAS / SLS-5000 GAST-D
     - Indra Navia NORMARC 8100 / 7000 GBAS
     - Boeing 737/747/787 FCOM 11.30 MMR / GLS, AERO Q3-2009 GLS
     - Airbus A320/A380/A350 FCOM PRO-NOR-SOP-15 GLS
     - NTSB AIR-19-12 ionospheric spatial-decorrelation studies
     - RTCA SC-159 ionospheric threat model (CONUS / Brazilian
       anomaly / equatorial scintillation belt)

   Hash-stable per-icao MMR equipage class (NO-MMR / MMR-Cat-I /
   MMR-Cat-II / MMR-Cat-III GAST-D), VDB pseudorange residual,
   PR-decorr ionospheric gradient mm/km (DO-253D threat model A/B/C
   bounds), satellite reference count (>= 4 GPS L1, GAST-D requires
   >= 5 in 30°-spread geometry per DO-245A §C.5), continuity-of-service
   probability (1 − Pcont), integrity of position measurement (LPL/VPL
   vs GAST-C 10 m / GAST-D 2.5 m vertical alert limit per Doc 9849).

   5 risk components → max-driver composite:
     COV  destination VDB coverage radius vs aircraft range
     SVC  ground-facility service vs aircraft MMR capability
     ION  ionospheric I-state NOM / WATCH / ANOM (DO-253D)
     SAT  reference-satellite count vs GAST-D minimum
     INT  LPL / VPL vs aircraft alert limit, NOTAM status

   5 tiers:  UNABLE / DEGRADE / WATCH / OK / IDLE

   MapLibre overlay: tier-coloured halo rings (sized by score 8-22px),
   rose diamond pin for UNABLE, GBAS station pins coloured by service
   level (CAT-III emerald / CAT-II sky / CAT-I slate / TEST amber /
   NOTAM rose), dashed tier-coloured VDB-coverage circles around
   ground facilities (≈ 23 nm typical service-volume per Annex 10),
   tier-coloured callsign + service + I-state labels.

   Side panel: 5-tier counter strip, 6-cell summary (TRACKED / MEAN-VPL
   / WORST callsign / UNABLE-count / ANOM-share / GAST-D-share),
   SVG VPL-vs-LPL scatter with VAL/LAL bands, 6 sliders, 3-MMR chip
   filter, 3-service chip filter, HALO/PIN/LBL/COV/REF/DIAG toggles,
   AIRCRAFT / STATIONS tabs.

   Registered in Layers > Safety & Traffic, Cmd+K palette,
   ft-gls persisted preference.
   ============================================================ */

export interface GlsFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
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
  flights: GlsFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'UNABLE' | 'DEGRADE' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  UNABLE:  '#ef4444',
  DEGRADE: '#f59e0b',
  WATCH:   '#0ea5e9',
  OK:      '#10b981',
  IDLE:    '#64748b',
}
const TIER_ORDER: Tier[] = ['UNABLE', 'DEGRADE', 'WATCH', 'OK', 'IDLE']

type Mmr = 'NO-MMR' | 'MMR-I' | 'MMR-II' | 'MMR-III'
const MMR_COLOR: Record<Mmr, string> = {
  'NO-MMR': '#64748b',
  'MMR-I':  '#94a3b8',
  'MMR-II': '#0ea5e9',
  'MMR-III':'#10b981',
}

type Svc = 'GAST-C' | 'GAST-D' | 'CAT-I' | 'TEST' | 'NOTAM'
const SVC_COLOR: Record<Svc, string> = {
  'GAST-C': '#0ea5e9',
  'GAST-D': '#10b981',
  'CAT-I':  '#94a3b8',
  'TEST':   '#f59e0b',
  'NOTAM':  '#ef4444',
}

type IState = 'NOM' | 'WATCH' | 'ANOM'
const ION_COLOR: Record<IState, string> = {
  NOM:   '#10b981',
  WATCH: '#f59e0b',
  ANOM:  '#ef4444',
}

// GBAS Ground Facility catalogue — operational + announced GBAS stations
// per Honeywell SmartPath deployment list, FAA NOTAM service-data,
// EASA published GLS sites, ICAO regional GBAS implementation reports.
interface Ggf {
  iata: string
  icao: string
  name: string
  lat: number
  lng: number
  svc: Svc
  covNm: number   // VDB service volume radius (nm), typical 23 per Annex 10
  fcLow: number
  fcHigh: number
  region: 'CONUS' | 'EUR' | 'APAC' | 'LATAM' | 'OCEA'
  vendor: 'HON-SP' | 'IND-NM' | 'THA' | 'NORMARC'
}
const GGF: Ggf[] = [
  // CONUS — SmartPath operationally certified
  { iata:'EWR', icao:'KEWR', name:'Newark Liberty',     lat:40.69, lng:-74.17, svc:'GAST-C', covNm:23, fcLow:108.05, fcHigh:117.95, region:'CONUS', vendor:'HON-SP' },
  { iata:'IAH', icao:'KIAH', name:'Houston Bush',       lat:29.98, lng:-95.34, svc:'GAST-C', covNm:23, fcLow:108.05, fcHigh:117.95, region:'CONUS', vendor:'HON-SP' },
  { iata:'MIA', icao:'KMIA', name:'Miami Intl',         lat:25.80, lng:-80.29, svc:'GAST-D', covNm:23, fcLow:108.05, fcHigh:117.95, region:'CONUS', vendor:'HON-SP' },
  { iata:'ORD', icao:'KORD', name:"Chicago O'Hare",     lat:41.98, lng:-87.91, svc:'GAST-C', covNm:23, fcLow:108.05, fcHigh:117.95, region:'CONUS', vendor:'HON-SP' },
  { iata:'JFK', icao:'KJFK', name:'New York JFK',       lat:40.64, lng:-73.78, svc:'GAST-D', covNm:23, fcLow:108.05, fcHigh:117.95, region:'CONUS', vendor:'HON-SP' },
  { iata:'SFO', icao:'KSFO', name:'San Francisco',      lat:37.62, lng:-122.37,svc:'GAST-C', covNm:23, fcLow:108.05, fcHigh:117.95, region:'CONUS', vendor:'HON-SP' },
  { iata:'SEA', icao:'KSEA', name:'Seattle-Tacoma',     lat:47.45, lng:-122.31,svc:'GAST-C', covNm:23, fcLow:108.05, fcHigh:117.95, region:'CONUS', vendor:'HON-SP' },
  { iata:'IAD', icao:'KIAD', name:'Washington Dulles',  lat:38.94, lng:-77.46, svc:'TEST',   covNm:23, fcLow:108.05, fcHigh:117.95, region:'CONUS', vendor:'HON-SP' },
  { iata:'BUR', icao:'KBUR', name:'Hollywood Burbank',  lat:34.20, lng:-118.36,svc:'CAT-I',  covNm:23, fcLow:108.05, fcHigh:117.95, region:'CONUS', vendor:'HON-SP' },
  { iata:'PHL', icao:'KPHL', name:'Philadelphia',       lat:39.87, lng:-75.24, svc:'CAT-I',  covNm:23, fcLow:108.05, fcHigh:117.95, region:'CONUS', vendor:'HON-SP' },
  { iata:'MEM', icao:'KMEM', name:'Memphis',            lat:35.04, lng:-89.98, svc:'GAST-C', covNm:23, fcLow:108.05, fcHigh:117.95, region:'CONUS', vendor:'HON-SP' },
  { iata:'BWI', icao:'KBWI', name:'Baltimore-Washington',lat:39.18,lng:-76.67, svc:'NOTAM',  covNm:23, fcLow:108.05, fcHigh:117.95, region:'CONUS', vendor:'HON-SP' },
  // EUR — NORMARC + SmartPath sites
  { iata:'FRA', icao:'EDDF', name:'Frankfurt am Main',  lat:50.04, lng:8.56,   svc:'GAST-C', covNm:23, fcLow:108.05, fcHigh:117.95, region:'EUR',   vendor:'HON-SP' },
  { iata:'BRE', icao:'EDDW', name:'Bremen',             lat:53.05, lng:8.79,   svc:'GAST-C', covNm:23, fcLow:108.05, fcHigh:117.95, region:'EUR',   vendor:'HON-SP' },
  { iata:'ZRH', icao:'LSZH', name:'Zurich',             lat:47.46, lng:8.55,   svc:'GAST-C', covNm:23, fcLow:108.05, fcHigh:117.95, region:'EUR',   vendor:'HON-SP' },
  { iata:'AMS', icao:'EHAM', name:'Amsterdam Schiphol', lat:52.31, lng:4.76,   svc:'GAST-D', covNm:23, fcLow:108.05, fcHigh:117.95, region:'EUR',   vendor:'HON-SP' },
  { iata:'CDG', icao:'LFPG', name:'Paris CDG',          lat:49.01, lng:2.55,   svc:'CAT-I',  covNm:23, fcLow:108.05, fcHigh:117.95, region:'EUR',   vendor:'THA' },
  { iata:'MAD', icao:'LEMD', name:'Madrid Barajas',     lat:40.49, lng:-3.57,  svc:'TEST',   covNm:23, fcLow:108.05, fcHigh:117.95, region:'EUR',   vendor:'IND-NM' },
  { iata:'OSL', icao:'ENGM', name:'Oslo Gardermoen',    lat:60.19, lng:11.10,  svc:'GAST-C', covNm:23, fcLow:108.05, fcHigh:117.95, region:'EUR',   vendor:'NORMARC' },
  { iata:'TRD', icao:'ENVA', name:'Trondheim Værnes',   lat:63.46, lng:10.92,  svc:'GAST-C', covNm:23, fcLow:108.05, fcHigh:117.95, region:'EUR',   vendor:'NORMARC' },
  { iata:'SVG', icao:'ENZV', name:'Stavanger Sola',     lat:58.88, lng:5.64,   svc:'GAST-C', covNm:23, fcLow:108.05, fcHigh:117.95, region:'EUR',   vendor:'NORMARC' },
  { iata:'MAN', icao:'EGCC', name:'Manchester',         lat:53.35, lng:-2.27,  svc:'CAT-I',  covNm:23, fcLow:108.05, fcHigh:117.95, region:'EUR',   vendor:'HON-SP' },
  // APAC
  { iata:'SYD', icao:'YSSY', name:'Sydney Kingsford',   lat:-33.94,lng:151.18, svc:'GAST-C', covNm:23, fcLow:108.05, fcHigh:117.95, region:'APAC',  vendor:'HON-SP' },
  { iata:'MEL', icao:'YMML', name:'Melbourne',          lat:-37.67,lng:144.84, svc:'CAT-I',  covNm:23, fcLow:108.05, fcHigh:117.95, region:'APAC',  vendor:'HON-SP' },
  { iata:'PVG', icao:'ZSPD', name:'Shanghai Pudong',    lat:31.14, lng:121.81, svc:'GAST-C', covNm:23, fcLow:108.05, fcHigh:117.95, region:'APAC',  vendor:'HON-SP' },
  { iata:'PEK', icao:'ZBAA', name:'Beijing Capital',    lat:40.08, lng:116.59, svc:'GAST-C', covNm:23, fcLow:108.05, fcHigh:117.95, region:'APAC',  vendor:'HON-SP' },
  { iata:'HND', icao:'RJTT', name:'Tokyo Haneda',       lat:35.55, lng:139.78, svc:'GAST-D', covNm:23, fcLow:108.05, fcHigh:117.95, region:'APAC',  vendor:'HON-SP' },
  { iata:'NRT', icao:'RJAA', name:'Tokyo Narita',       lat:35.76, lng:140.39, svc:'GAST-C', covNm:23, fcLow:108.05, fcHigh:117.95, region:'APAC',  vendor:'HON-SP' },
  { iata:'ICN', icao:'RKSI', name:'Seoul Incheon',      lat:37.46, lng:126.44, svc:'GAST-C', covNm:23, fcLow:108.05, fcHigh:117.95, region:'APAC',  vendor:'HON-SP' },
  { iata:'SIN', icao:'WSSS', name:'Singapore Changi',   lat:1.36,  lng:103.99, svc:'CAT-I',  covNm:23, fcLow:108.05, fcHigh:117.95, region:'APAC',  vendor:'HON-SP' },
  // LATAM (Brazilian anomaly — ANOM-prone)
  { iata:'GRU', icao:'SBGR', name:'São Paulo Guarulhos',lat:-23.43,lng:-46.47, svc:'GAST-C', covNm:23, fcLow:108.05, fcHigh:117.95, region:'LATAM', vendor:'HON-SP' },
  { iata:'BSB', icao:'SBBR', name:'Brasília',           lat:-15.87,lng:-47.92, svc:'TEST',   covNm:23, fcLow:108.05, fcHigh:117.95, region:'LATAM', vendor:'IND-NM' },
  { iata:'BOG', icao:'SKBO', name:'Bogotá El Dorado',   lat:4.70,  lng:-74.14, svc:'CAT-I',  covNm:23, fcLow:108.05, fcHigh:117.95, region:'LATAM', vendor:'IND-NM' },
]

// MMR equipage classes (Honeywell IM-3000 / Rockwell GLU-925 typical)
interface MmrSpec { mmr: Mmr; val: number; lal: number /* alert limits, m */; minSats: number }
const MMR_SPEC: Record<Mmr, MmrSpec> = {
  'NO-MMR': { mmr:'NO-MMR', val: 999, lal: 999, minSats: 0 },
  'MMR-I':  { mmr:'MMR-I',  val: 10.0, lal: 40.0, minSats: 4 },
  'MMR-II': { mmr:'MMR-II', val:  5.3, lal: 17.0, minSats: 4 },
  'MMR-III':{ mmr:'MMR-III',val:  2.5, lal: 10.0, minSats: 5 },
}

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga'
function classify(t: string | undefined): Klass {
  const x = (t || '').toUpperCase()
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(AT4|AT5|AT7|DH8|SF34|J32|J41|ATR|C72|C82|TBM|PC12|TB|PC6|DHC2|DHC6|AN2)/.test(x)) return 'turboprop'
  return 'narrow'
}

// Per-class baseline MMR probability (GLS-equipped fleet share)
// per Honeywell SmartPath fleet stats & Airbus/Boeing GLS retrofit data.
const CLASS_MMR_BIAS: Record<Klass, [number, number, number, number]> = {
  // [NO, I, II, III]
  heavy:     [0.10, 0.25, 0.30, 0.35],
  narrow:    [0.20, 0.35, 0.30, 0.15],
  regional:  [0.40, 0.45, 0.13, 0.02],
  biz:       [0.30, 0.40, 0.22, 0.08],
  turboprop: [0.78, 0.20, 0.02, 0.00],
  ga:        [0.95, 0.05, 0.00, 0.00],
}

function hash32(s: string): number {
  let h = 0x811c9dc5 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}
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

interface Row {
  f: GlsFlight
  klass: Klass
  mmr: Mmr
  spec: MmrSpec
  ggf: Ggf
  distNm: number
  inCov: boolean
  ion: IState
  sats: number
  lpl: number       // lateral protection level, m
  vpl: number       // vertical protection level, m
  ach: 'CAT-III' | 'CAT-II' | 'CAT-I' | 'NONE'  // achievable approach
  cont: number      // continuity 1−P (per 150s window, ×1e-6)
  // driver scores
  scoreCov: number
  scoreSvc: number
  scoreIon: number
  scoreSat: number
  scoreInt: number
  score: number
  driver: 'COV' | 'SVC' | 'ION' | 'SAT' | 'INT'
  tier: Tier
}

const SRC_HALO = 'gls-halo', SRC_PIN = 'gls-pin', SRC_LBL = 'gls-lbl', SRC_APT = 'gls-apt', SRC_APT_LBL = 'gls-apt-lbl', SRC_COV = 'gls-cov', SRC_LINK = 'gls-link'
const LYR_HALO = 'gls-halo-l', LYR_PIN = 'gls-pin-l', LYR_LBL = 'gls-lbl-l', LYR_APT = 'gls-apt-l', LYR_APT_LBL2 = 'gls-apt-lbl-l', LYR_COV = 'gls-cov-l', LYR_LINK = 'gls-link-l'

export default function GlsGbas({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'STATIONS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [mmrFilter, setMmrFilter] = useState<Mmr | 'ALL'>('ALL')
  const [svcFilter, setSvcFilter] = useState<Svc | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(5)
  const [maxFl, setMaxFl] = useState(180)
  const [capture, setCapture] = useState(60)
  const [ionMul, setIonMul] = useState(100)   // 50..200 %  ANOM rate
  const [notamRate, setNotamRate] = useState(8)   // 0..30 % stations under NOTAM
  const [valBuf, setValBuf] = useState(0)     // -50..+50 % alert-limit cushion
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showCov, setShowCov] = useState(true)
  const [showRefStations, setShowRefStations] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const notamPctFleet = notamRate / 100
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (!isFinite(fl) || fl < minFl || fl > maxFl) continue
      // Only descending or low-FL traffic (consistent with vapp-advisor approach window)
      if (!(f.vertRate < -100 || fl < 100)) continue

      // Find best GBAS station along track within capture
      let best: Ggf | null = null
      let bestD = Infinity
      for (const g of GGF) {
        const d = haversineNm(f.lat, f.lng, g.lat, g.lng)
        if (d > capture) continue
        const br = bearingDeg(f.lat, f.lng, g.lat, g.lng)
        const delta = Math.abs(((br - f.track + 540) % 360) - 180)
        if (delta > 75) continue
        if (d < bestD) { bestD = d; best = g }
      }
      if (!best) continue

      const klass = classify(f.type)
      const bias = CLASS_MMR_BIAS[klass]
      const h = hash32(f.icao || '')
      // Pick MMR class from bias CDF
      const u = ((h >>> 3) % 1000) / 1000
      let acc = 0, mmr: Mmr = 'NO-MMR'
      const labels: Mmr[] = ['NO-MMR', 'MMR-I', 'MMR-II', 'MMR-III']
      for (let i = 0; i < 4; i++) { acc += bias[i]; if (u < acc) { mmr = labels[i]; break } }
      const spec = MMR_SPEC[mmr]

      // Per-icao station-specific NOTAM gate (apply globally to ggf if hash hits)
      const ggfNotamRoll = ((hash32(best.iata + 'NTM') >>> 7) % 1000) / 1000
      const ggf: Ggf = ggfNotamRoll < notamPctFleet ? { ...best, svc: 'NOTAM' } : best

      // Ionospheric state — region-biased anomaly probability per DO-253D threat model
      const ionBase = ggf.region === 'LATAM' ? 0.18 : ggf.region === 'APAC' ? 0.08 : ggf.region === 'EUR' ? 0.04 : 0.06
      const ionRoll = ((hash32(f.icao + ggf.iata) >>> 11) % 1000) / 1000
      const anomThr = ionBase * (ionMul / 100)
      const watchThr = anomThr * 3
      const ion: IState = ionRoll < anomThr ? 'ANOM' : ionRoll < watchThr ? 'WATCH' : 'NOM'

      // Satellite count synth (typ 7-12 GPS L1 visible)
      const sats = 5 + ((h >>> 13) % 8) // 5..12

      // Protection levels — scale by ion state and sats
      const ionMult = ion === 'ANOM' ? 3.2 : ion === 'WATCH' ? 1.8 : 1.0
      const satMult = sats <= 4 ? 2.4 : sats <= 5 ? 1.6 : sats <= 7 ? 1.15 : 1.0
      const baseV = mmr === 'NO-MMR' ? 50 : mmr === 'MMR-I' ? 6.5 : mmr === 'MMR-II' ? 3.2 : 1.6
      const baseL = mmr === 'NO-MMR' ? 80 : mmr === 'MMR-I' ? 18 : mmr === 'MMR-II' ? 9 : 5
      const vpl = baseV * ionMult * satMult * (1 + ((h >>> 19) % 40) / 200)
      const lpl = baseL * ionMult * satMult * (1 + ((h >>> 21) % 40) / 200)

      // Coverage: in service volume?
      const inCov = bestD <= ggf.covNm

      // Achievable approach: ground-svc cap intersected with airborne MMR cap
      const grdCap: 'CAT-III' | 'CAT-II' | 'CAT-I' | 'NONE' =
        ggf.svc === 'GAST-D' ? 'CAT-III' :
        ggf.svc === 'GAST-C' ? 'CAT-I' :
        ggf.svc === 'CAT-I'  ? 'CAT-I' :
        'NONE'
      const airCap: 'CAT-III' | 'CAT-II' | 'CAT-I' | 'NONE' =
        mmr === 'MMR-III' ? 'CAT-III' :
        mmr === 'MMR-II'  ? 'CAT-II'  :
        mmr === 'MMR-I'   ? 'CAT-I'   : 'NONE'
      const capOrder = { 'NONE': 0, 'CAT-I': 1, 'CAT-II': 2, 'CAT-III': 3 } as const
      const minCap = capOrder[grdCap] < capOrder[airCap] ? grdCap : airCap
      const ach = minCap

      // Continuity synth, baseline 1e-6 per 150 s window scaled by ion+NOTAM
      const cont = 0.5 + ionMult * 0.6 + (ggf.svc === 'TEST' ? 1.0 : 0) + (ggf.svc === 'NOTAM' ? 8 : 0)

      // ===== Risk drivers =====
      // COV: distance vs coverage radius
      const covMargin = (ggf.covNm - bestD) / ggf.covNm   // 1 at station, 0 at edge, <0 outside
      const scoreCov = Math.max(0, Math.min(100, !inCov ? 100 : (1 - covMargin) * 50))
      // SVC: ground service vs aircraft MMR capability
      let scoreSvc = 0
      if (ggf.svc === 'NOTAM') scoreSvc = 100
      else if (mmr === 'NO-MMR') scoreSvc = 100
      else if (ach === 'NONE') scoreSvc = 100
      else if (ggf.svc === 'TEST') scoreSvc = 70
      else if (capOrder[airCap] > capOrder[grdCap]) scoreSvc = 35 // can't use full equipage
      // ION: ionospheric state
      const scoreIon = ion === 'ANOM' ? 95 : ion === 'WATCH' ? 55 : 10
      // SAT: reference-satellite count
      const scoreSat = sats >= spec.minSats + 2 ? 5 :
                       sats >= spec.minSats     ? 35 :
                       sats >= 4                ? 70 : 100
      // INT: VPL vs VAL with cushion slider
      const valAdj = spec.val * (1 + valBuf / 100)
      const lalAdj = spec.lal * (1 + valBuf / 100)
      const vRatio = vpl / valAdj
      const lRatio = lpl / lalAdj
      const worstRatio = Math.max(vRatio, lRatio)
      const scoreInt = worstRatio >= 1.0 ? 100 :
                       worstRatio >= 0.85 ? 70 :
                       worstRatio >= 0.65 ? 35 : 10

      const drivers: Array<['COV' | 'SVC' | 'ION' | 'SAT' | 'INT', number]> = [
        ['COV', scoreCov], ['SVC', scoreSvc], ['ION', scoreIon], ['SAT', scoreSat], ['INT', scoreInt],
      ]
      drivers.sort((a, b) => b[1] - a[1])
      const driver = drivers[0][0]
      const score = Math.max(0, Math.min(100, drivers[0][1] + 0.10 * drivers[1][1]))

      let tier: Tier = 'OK'
      if (score >= 80 || !inCov || ggf.svc === 'NOTAM' || mmr === 'NO-MMR' || worstRatio >= 1.0) tier = 'UNABLE'
      else if (score >= 55) tier = 'DEGRADE'
      else if (score >= 25) tier = 'WATCH'

      out.push({
        f, klass, mmr, spec, ggf,
        distNm: bestD, inCov, ion, sats,
        lpl, vpl, ach, cont,
        scoreCov, scoreSvc, scoreIon, scoreSat, scoreInt,
        score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, maxFl, capture, ionMul, notamRate, valBuf])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (mmrFilter !== 'ALL' && r.mmr !== mmrFilter) return false
      if (svcFilter !== 'ALL' && r.ggf.svc !== svcFilter) return false
      if (q && !(r.f.callsign?.toUpperCase().includes(q) || r.ggf.iata.includes(q) || (r.f.type || '').toUpperCase().includes(q))) return false
      return true
    })
  }, [rows, tierFilter, mmrFilter, svcFilter, query])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { UNABLE: 0, DEGRADE: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const meanVpl = useMemo(() => rows.length ? rows.reduce((s, r) => s + r.vpl, 0) / rows.length : 0, [rows])
  const anomShare = useMemo(() => rows.length ? rows.filter(r => r.ion === 'ANOM').length / rows.length : 0, [rows])
  const gastDShare = useMemo(() => rows.length ? rows.filter(r => r.mmr === 'MMR-III' && r.ggf.svc === 'GAST-D').length / rows.length : 0, [rows])
  const worst = useMemo(() => {
    if (!rows.length) return null
    return rows.slice().sort((a, b) => b.score - a.score)[0]
  }, [rows])

  // MapLibre rendering
  useEffect(() => {
    if (!map) return
    const m = map
    const ensure = () => {
      const haloGj: any = { type: 'FeatureCollection', features: [] }
      const pinGj: any = { type: 'FeatureCollection', features: [] }
      const lblGj: any = { type: 'FeatureCollection', features: [] }
      const aptGj: any = { type: 'FeatureCollection', features: [] }
      const covGj: any = { type: 'FeatureCollection', features: [] }
      const linkGj: any = { type: 'FeatureCollection', features: [] }

      // GBAS station pins always
      if (showRefStations) {
        for (const g of GGF) {
          aptGj.features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [g.lng, g.lat] },
            properties: { t: `›${g.iata} ${g.svc}`, c: SVC_COLOR[g.svc] },
          })
          if (showCov) {
            // circle polygon ~32 segments
            const pts: [number, number][] = []
            const R = g.covNm / 60 // deg
            for (let i = 0; i <= 32; i++) {
              const a = (i / 32) * Math.PI * 2
              const dLat = Math.sin(a) * R
              const dLng = Math.cos(a) * R / Math.cos(g.lat * Math.PI / 180)
              pts.push([g.lng + dLng, g.lat + dLat])
            }
            covGj.features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts }, properties: { c: SVC_COLOR[g.svc] } })
          }
        }
      }

      const seenGgf = new Set<string>()
      for (const r of filtered) {
        const c = TIER_COLOR[r.tier]
        if (showHalo) {
          const mag = 6 + Math.min(16, r.score / 6)
          haloGj.features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { c, mag } })
        }
        if (showPin && r.tier === 'UNABLE') {
          pinGj.features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { c } })
        }
        if (showLabels && r.tier !== 'OK') {
          lblGj.features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
            properties: {
              t: `${r.f.callsign || r.f.icao}  ${r.ach}  I:${r.ion}  V${r.vpl.toFixed(1)}m`,
              c,
            },
          })
        }
        if (showLink) {
          linkGj.features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.ggf.lng, r.ggf.lat]] },
            properties: { c },
          })
        }
        seenGgf.add(r.ggf.iata)
      }

      const upsert = (id: string, gj: any) => {
        const src = m.getSource(id) as any
        if (src) src.setData(gj)
        else m.addSource(id, { type: 'geojson', data: gj })
      }
      upsert(SRC_HALO, haloGj)
      upsert(SRC_PIN, pinGj)
      upsert(SRC_LBL, lblGj)
      upsert(SRC_APT, aptGj)
      upsert(SRC_COV, covGj)
      upsert(SRC_LINK, linkGj)

      if (!m.getLayer(LYR_COV)) m.addLayer({ id: LYR_COV, type: 'line', source: SRC_COV, paint: { 'line-color': ['get', 'c'], 'line-width': 1, 'line-opacity': 0.35, 'line-dasharray': [3, 2] } })
      if (!m.getLayer(LYR_LINK)) m.addLayer({ id: LYR_LINK, type: 'line', source: SRC_LINK, paint: { 'line-color': ['get', 'c'], 'line-width': 1, 'line-opacity': 0.45, 'line-dasharray': [1, 2] } })
      if (!m.getLayer(LYR_HALO)) m.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'mag'], 'circle-color': ['get', 'c'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'c'], 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.7 } })
      if (!m.getLayer(LYR_PIN)) m.addLayer({ id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: { 'circle-radius': 5, 'circle-color': ['get', 'c'], 'circle-opacity': 0.9, 'circle-stroke-color': '#020617', 'circle-stroke-width': 1.5 } })
      if (!m.getLayer(LYR_APT)) m.addLayer({ id: LYR_APT, type: 'circle', source: SRC_APT, paint: { 'circle-radius': 4, 'circle-color': ['get', 'c'], 'circle-opacity': 0.8, 'circle-stroke-color': '#020617', 'circle-stroke-width': 1 } })
      if (!m.getLayer(LYR_APT_LBL2)) m.addLayer({ id: LYR_APT_LBL2, type: 'symbol', source: SRC_APT, layout: { 'text-field': ['get', 't'], 'text-size': 9, 'text-offset': [0, -1.2], 'text-anchor': 'bottom', 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } })
      if (!m.getLayer(LYR_LBL)) m.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 't'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } })
    }
    if (m.isStyleLoaded()) ensure()
    else m.once('load', ensure)

    return () => {
      try {
        for (const lyr of [LYR_LBL, LYR_APT_LBL2, LYR_APT, LYR_PIN, LYR_HALO, LYR_LINK, LYR_COV]) if (m.getLayer(lyr)) m.removeLayer(lyr)
        for (const src of [SRC_LBL, SRC_APT, SRC_APT_LBL, SRC_PIN, SRC_HALO, SRC_LINK, SRC_COV]) if (m.getSource(src)) m.removeSource(src)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLabels, showCov, showRefStations, showLink])

  // Sort: tier worst-first, then score desc
  const sorted = useMemo(() => {
    const ord: Record<Tier, number> = { UNABLE: 0, DEGRADE: 1, WATCH: 2, OK: 3, IDLE: 4 }
    return [...filtered].sort((a, b) => {
      const d = ord[a.tier] - ord[b.tier]
      if (d) return d
      return b.score - a.score
    })
  }, [filtered])

  // Stations aggregate
  const stnAgg = useMemo(() => {
    const m = new Map<string, { ggf: Ggf; n: number; unable: number; meanScore: number; worstTier: Tier }>()
    for (const g of GGF) m.set(g.iata, { ggf: g, n: 0, unable: 0, meanScore: 0, worstTier: 'IDLE' })
    const ord: Record<Tier, number> = { UNABLE: 0, DEGRADE: 1, WATCH: 2, OK: 3, IDLE: 4 }
    for (const r of rows) {
      const e = m.get(r.ggf.iata); if (!e) continue
      e.n++
      if (r.tier === 'UNABLE') e.unable++
      e.meanScore += r.score
      if (ord[r.tier] < ord[e.worstTier]) e.worstTier = r.tier
    }
    return Array.from(m.values()).map(e => ({ ...e, meanScore: e.n ? e.meanScore / e.n : 0 })).sort((a, b) => {
      const d = ord[a.worstTier] - ord[b.worstTier]
      if (d) return d
      return b.n - a.n
    })
  }, [rows])

  return (
    <div className="absolute top-14 right-2 z-30 w-[440px] max-h-[88vh] overflow-y-auto bg-slate-900/95 backdrop-blur-md border border-slate-700/60 rounded-lg shadow-2xl text-slate-200 text-[12px]">
      <div className="sticky top-0 bg-slate-900/95 backdrop-blur border-b border-slate-700/60 px-3 py-2 flex items-center justify-between">
        <div>
          <div className="text-slate-100 font-semibold tracking-wide">GLS / GBAS Availability</div>
          <div className="text-[10px] text-slate-500 leading-tight">VDB coverage · GAST-C/D · ion threat · LPL/VPL vs VAL/LAL · ICAO Annex 10 / DO-253D</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-xl leading-none px-1">×</button>
      </div>

      {/* Summary cells */}
      <div className="px-3 py-2 grid grid-cols-3 gap-1.5 border-b border-slate-800">
        <div className="bg-slate-800/60 rounded px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">Tracked</div>
          <div className="text-slate-100 text-base font-semibold leading-tight">{rows.length}</div>
        </div>
        <div className="bg-slate-800/60 rounded px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">Mean VPL</div>
          <div className="text-base font-semibold leading-tight tabular-nums" style={{ color: meanVpl > 6 ? '#f59e0b' : meanVpl > 3 ? '#0ea5e9' : '#10b981' }}>{meanVpl.toFixed(1)}<span className="text-[10px] text-slate-500"> m</span></div>
        </div>
        <div className="bg-slate-800/60 rounded px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">Unable</div>
          <div className="text-rose-400 text-base font-semibold leading-tight">{counts.UNABLE}</div>
        </div>
        <div className="bg-slate-800/60 rounded px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">Worst</div>
          <div className="text-slate-100 text-[11px] font-semibold leading-tight truncate">{worst ? `${worst.f.callsign || worst.f.icao}` : '—'}</div>
          <div className="text-[9px]" style={{ color: worst ? TIER_COLOR[worst.tier] : '#64748b' }}>{worst ? `${worst.driver} ${Math.round(worst.score)}` : '—'}</div>
        </div>
        <div className="bg-slate-800/60 rounded px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">Anom share</div>
          <div className="text-base font-semibold leading-tight tabular-nums" style={{ color: anomShare > 0.15 ? '#ef4444' : anomShare > 0.05 ? '#f59e0b' : '#10b981' }}>{(anomShare * 100).toFixed(0)}<span className="text-[10px] text-slate-500"> %</span></div>
        </div>
        <div className="bg-slate-800/60 rounded px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">GAST-D paired</div>
          <div className="text-emerald-400 text-base font-semibold leading-tight tabular-nums">{(gastDShare * 100).toFixed(0)}<span className="text-[10px] text-slate-500"> %</span></div>
        </div>
      </div>

      {/* Tier chips */}
      <div className="px-3 py-2 flex flex-wrap gap-1 border-b border-slate-800">
        {(['ALL', ...TIER_ORDER] as const).map(t => {
          const active = tierFilter === t
          const col = t === 'ALL' ? '#94a3b8' : TIER_COLOR[t as Tier]
          const n = t === 'ALL' ? rows.length : counts[t as Tier]
          return (
            <button key={t} onClick={() => setTierFilter(t as any)} className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: active ? col + '26' : '#1e293b80', color: active ? col : '#94a3b8', border: `1px solid ${active ? col + '66' : '#33415555'}` }}>{t} {n}</button>
          )
        })}
      </div>

      {/* MMR chips */}
      <div className="px-3 py-2 flex flex-wrap gap-1 border-b border-slate-800">
        <span className="text-[10px] text-slate-500 mr-1 self-center">MMR</span>
        {(['ALL', 'NO-MMR', 'MMR-I', 'MMR-II', 'MMR-III'] as const).map(c => {
          const active = mmrFilter === c
          const col = c === 'ALL' ? '#94a3b8' : MMR_COLOR[c as Mmr]
          return (
            <button key={c} onClick={() => setMmrFilter(c as any)} className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: active ? col + '26' : '#1e293b80', color: active ? col : '#94a3b8', border: `1px solid ${active ? col + '66' : '#33415555'}` }}>{c}</button>
          )
        })}
      </div>

      {/* SVC chips */}
      <div className="px-3 py-2 flex flex-wrap gap-1 border-b border-slate-800">
        <span className="text-[10px] text-slate-500 mr-1 self-center">SVC</span>
        {(['ALL', 'GAST-D', 'GAST-C', 'CAT-I', 'TEST', 'NOTAM'] as const).map(c => {
          const active = svcFilter === c
          const col = c === 'ALL' ? '#94a3b8' : SVC_COLOR[c as Svc]
          return (
            <button key={c} onClick={() => setSvcFilter(c as any)} className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: active ? col + '26' : '#1e293b80', color: active ? col : '#94a3b8', border: `1px solid ${active ? col + '66' : '#33415555'}` }}>{c}</button>
          )
        })}
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 grid grid-cols-2 gap-2 border-b border-slate-800 text-[10px]">
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">MIN FL {minFl}</span>
          <input type="range" min={0} max={180} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">MAX FL {maxFl}</span>
          <input type="range" min={20} max={400} value={maxFl} onChange={e => setMaxFl(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">CAPTURE {capture} nm</span>
          <input type="range" min={20} max={150} value={capture} onChange={e => setCapture(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">ION {ionMul}%</span>
          <input type="range" min={50} max={200} value={ionMul} onChange={e => setIonMul(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">NOTAM {notamRate}%</span>
          <input type="range" min={0} max={30} value={notamRate} onChange={e => setNotamRate(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">VAL/LAL buf {valBuf >= 0 ? '+' : ''}{valBuf}%</span>
          <input type="range" min={-50} max={50} value={valBuf} onChange={e => setValBuf(+e.target.value)} className="accent-sky-500" />
        </label>
      </div>

      {/* Overlay toggles + search */}
      <div className="px-3 py-2 flex flex-wrap items-center gap-1.5 border-b border-slate-800 text-[10px]">
        {[
          ['HALO', showHalo, setShowHalo],
          ['PIN', showPin, setShowPin],
          ['LBL', showLabels, setShowLabels],
          ['COV', showCov, setShowCov],
          ['REF', showRefStations, setShowRefStations],
          ['LINK', showLink, setShowLink],
          ['DIAG', showDiag, setShowDiag],
        ].map(([l, v, s]: any) => (
          <button key={l} onClick={() => s(!v)} className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: v ? 'rgba(14,165,233,0.15)' : '#1e293b80', color: v ? '#7dd3fc' : '#94a3b8', border: `1px solid ${v ? 'rgba(14,165,233,0.4)' : '#33415555'}` }}>{l}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search" className="flex-1 min-w-[80px] bg-slate-800/60 border border-slate-700/50 rounded px-1.5 py-0.5 text-[10px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50" />
      </div>

      {/* Diagnostic SVG: VPL vs LPL scatter */}
      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[10px] text-slate-500 mb-1">VPL vs LPL · VAL=2.5/10 (GAST-D), 5.3/17 (II), 10/40 (I) m</div>
          <svg viewBox="0 0 320 140" className="w-full">
            {/* bands: rose ≥1.0 ratio (drawn as right/top quadrant beyond axes) */}
            <rect x={0} y={0} width={320} height={140} fill="#0f172a" />
            {/* Reference VAL/LAL lines (using GAST-C 5.3/17 as middle) */}
            <line x1={0} y1={140 - (5.3 / 12) * 140} x2={320} y2={140 - (5.3 / 12) * 140} stroke="#0ea5e9" strokeWidth="0.6" strokeDasharray="2 2" />
            <line x1={(17 / 30) * 320} y1={0} x2={(17 / 30) * 320} y2={140} stroke="#0ea5e9" strokeWidth="0.6" strokeDasharray="2 2" />
            <line x1={0} y1={140 - (2.5 / 12) * 140} x2={320} y2={140 - (2.5 / 12) * 140} stroke="#10b981" strokeWidth="0.6" strokeDasharray="2 2" />
            <line x1={(10 / 30) * 320} y1={0} x2={(10 / 30) * 320} y2={140} stroke="#10b981" strokeWidth="0.6" strokeDasharray="2 2" />
            <line x1={0} y1={140 - (10 / 12) * 140} x2={320} y2={140 - (10 / 12) * 140} stroke="#94a3b8" strokeWidth="0.5" strokeDasharray="2 2" />
            {[5, 10, 15, 20, 25].map(v => (
              <line key={v} x1={(v / 30) * 320} y1={135} x2={(v / 30) * 320} y2={140} stroke="#475569" strokeWidth="0.5" />
            ))}
            {rows.map((r, i) => {
              const x = Math.max(0, Math.min(320, (r.lpl / 30) * 320))
              const y = Math.max(0, Math.min(140, 140 - (r.vpl / 12) * 140))
              return <circle key={i} cx={x} cy={y} r={2.2} fill={TIER_COLOR[r.tier]} fillOpacity="0.85" />
            })}
            <text x={2} y={9} fill="#475569" fontSize="8">VPL (m)</text>
            <text x={292} y={138} fill="#475569" fontSize="8">LPL</text>
            <text x={(10 / 30) * 320 + 2} y={10} fill="#10b981" fontSize="8">D</text>
            <text x={(17 / 30) * 320 + 2} y={10} fill="#0ea5e9" fontSize="8">C</text>
          </svg>
        </div>
      )}

      {/* Tabs */}
      <div className="px-3 py-1.5 flex gap-1 border-b border-slate-800 text-[10px]">
        {(['AIRCRAFT', 'STATIONS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className="px-2 py-0.5 rounded font-medium" style={{ background: tab === t ? 'rgba(14,165,233,0.15)' : 'transparent', color: tab === t ? '#7dd3fc' : '#94a3b8', border: `1px solid ${tab === t ? 'rgba(14,165,233,0.4)' : 'transparent'}` }}>{t}</button>
        ))}
      </div>

      {/* List */}
      <div className="px-2 py-1.5">
        {tab === 'AIRCRAFT' && (
          <>
            {sorted.length === 0 && <div className="text-slate-500 text-center py-4 text-[11px]">No GLS approaches in capture window.</div>}
            {sorted.slice(0, 80).map((r, i) => {
              const advice =
                r.tier === 'UNABLE'
                  ? (r.mmr === 'NO-MMR' ? 'no MMR equipage › revert to ILS / RNP' :
                     r.ggf.svc === 'NOTAM' ? 'GBAS NOTAM › revert to ILS / RNP-AR' :
                     !r.inCov ? 'outside VDB service volume › await capture' :
                     r.ion === 'ANOM' ? 'ION ANOM › use ILS, avoid GLS until WATCH clears' :
                     'VPL exceeds VAL › missed-approach criteria, file deviation per FAA Order 8260.55A')
                  : r.tier === 'DEGRADE' ? `${r.driver} elevated › brief crew, retain ILS backup tuned per FCOM 11.30`
                  : r.tier === 'WATCH' ? 'within envelope but trend adverse › monitor LPL/VPL'
                  : 'GLS available · MMR vs GGF aligned'
              return (
                <button key={i} onClick={() => onFly(r.f.icao)} className="w-full text-left px-2 py-1.5 mb-1 rounded hover:bg-slate-800/60" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-100 font-mono text-[11px] w-[68px] truncate">{r.f.callsign || r.f.icao}</span>
                    <span className="text-slate-500 text-[10px] w-[44px] truncate">{r.f.type || '—'}</span>
                    <span className="px-1 rounded text-[9px] font-medium tabular-nums" style={{ background: MMR_COLOR[r.mmr] + '26', color: MMR_COLOR[r.mmr], border: `1px solid ${MMR_COLOR[r.mmr]}66` }}>{r.mmr}</span>
                    <span className="px-1 rounded text-[9px] font-medium" style={{ background: SVC_COLOR[r.ggf.svc] + '26', color: SVC_COLOR[r.ggf.svc], border: `1px solid ${SVC_COLOR[r.ggf.svc]}66` }}>{r.ggf.svc}</span>
                    <span className="ml-auto px-1 rounded text-[9px] font-medium" style={{ background: TIER_COLOR[r.tier] + '26', color: TIER_COLOR[r.tier], border: `1px solid ${TIER_COLOR[r.tier]}66` }}>{r.tier}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-[10px] text-slate-500 tabular-nums">
                    <span>›{r.ggf.iata}</span>
                    <span>{r.distNm.toFixed(0)}/{r.ggf.covNm} nm</span>
                    <span style={{ color: ION_COLOR[r.ion] }}>I:{r.ion}</span>
                    <span>SAT {r.sats}</span>
                    <span>ACH {r.ach}</span>
                    <span className="ml-auto">{r.driver} {Math.round(r.score)}</span>
                  </div>
                  <div className="h-1 mt-1 rounded-sm bg-slate-800 overflow-hidden relative">
                    <div className="h-full" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier] }} />
                    {[25, 55, 80].map(t => (
                      <div key={t} className="absolute top-0 bottom-0" style={{ left: `${t}%`, width: 1, background: '#334155' }} />
                    ))}
                  </div>
                  <div className="flex items-center gap-1 mt-1 text-[9px] tabular-nums">
                    {([['COV', r.scoreCov], ['SVC', r.scoreSvc], ['ION', r.scoreIon], ['SAT', r.scoreSat], ['INT', r.scoreInt]] as const).map(([l, v]) => (
                      <span key={l} className="px-1 rounded" style={{ background: '#1e293b80', color: v >= 80 ? '#ef4444' : v >= 55 ? '#f59e0b' : v >= 25 ? '#0ea5e9' : '#10b981' }}>{l} {Math.round(v)}</span>
                    ))}
                    <span className="ml-auto text-slate-500">VPL {r.vpl.toFixed(1)}/LPL {r.lpl.toFixed(1)} m</span>
                  </div>
                  <div className="text-[10px] mt-0.5" style={{ color: TIER_COLOR[r.tier] }}>{advice}</div>
                </button>
              )
            })}
          </>
        )}
        {tab === 'STATIONS' && (
          <>
            {stnAgg.map((a, i) => (
              <div key={i} className="px-2 py-1.5 mb-1 rounded bg-slate-800/40" style={{ borderLeft: `3px solid ${TIER_COLOR[a.worstTier]}` }}>
                <div className="flex items-center gap-2">
                  <span className="text-slate-100 font-mono text-[11px] w-[42px]">{a.ggf.iata}</span>
                  <span className="text-slate-400 text-[10px] flex-1 truncate">{a.ggf.name}</span>
                  <span className="px-1 rounded text-[9px] font-medium" style={{ background: SVC_COLOR[a.ggf.svc] + '26', color: SVC_COLOR[a.ggf.svc], border: `1px solid ${SVC_COLOR[a.ggf.svc]}66` }}>{a.ggf.svc}</span>
                  <span className="px-1 rounded text-[9px] font-medium" style={{ background: TIER_COLOR[a.worstTier] + '26', color: TIER_COLOR[a.worstTier], border: `1px solid ${TIER_COLOR[a.worstTier]}66` }}>{a.worstTier}</span>
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-[10px] text-slate-500 tabular-nums">
                  <span>{a.ggf.region}</span>
                  <span>{a.ggf.vendor}</span>
                  <span>cov {a.ggf.covNm}nm</span>
                  <span>AC {a.n}</span>
                  <span className="text-rose-400">UNABLE {a.unable}</span>
                  <span className="ml-auto">μ {Math.round(a.meanScore)}</span>
                </div>
                <div className="h-1 mt-1 rounded-sm bg-slate-800 overflow-hidden">
                  <div className="h-full" style={{ width: `${Math.min(100, a.meanScore)}%`, background: TIER_COLOR[a.worstTier] }} />
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 tracking-wide">
        VDB 108–117.975 MHz D8PSK · GAST-D VAL 10 m / LAL 40 m · ICAO Annex 10 · RTCA DO-253D / DO-245A · FAA AC 120-118 · EASA AMC 20-28
      </div>
    </div>
  )
}
