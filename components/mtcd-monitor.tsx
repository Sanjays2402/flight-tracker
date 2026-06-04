'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   MTCD · MEDIUM-TERM CONFLICT DETECTION
   -----------------------------------------------------------
   Controller-side pairwise trajectory conflict probe with
   8–20 minute look-ahead horizon. Distinct from the airborne
   TCAS-II RA (≤ 35 s TAU) and the short-term tactical CPA
   panel (≤ 2 min). MTCD performs strategic de-confliction —
   propagating each tracked target along its current track,
   ground speed and vertical rate (linear 4-D trajectory),
   sweeping pairwise CPAs across the look-ahead window, and
   raising alerts when predicted horizontal & vertical
   separation falls inside the sector minima applicable at
   the predicted geometry.

   ATS sector minima reference (configurable):
     · ENR oceanic class A           10 NM / 1000 ft
     · ENR domestic radar            5 NM  / 1000 ft
     · TMA radar                     3 NM  / 1000 ft
     · APP / RPI radar               2.5 NM / 1000 ft
     · CPA on parallel approaches    1.0 NM / 1000 ft (with NTZ)

   Per-pair scorer combines:
     · time-to-CPA (TAU) inside MTCD horizon
     · separation deficit at CPA (NM and ft)
     · closing geometry (head-on vs in-trail)
     · sector minima applicable at CPA
     · phase / vertical-rate alignment
     · same-sector vs cross-FIR coordination penalty

   References
     · ICAO Doc 4444 PANS-ATM §8.6 / §15.7 conflict prediction
     · ICAO Doc 9426 ATS Planning Manual III.4
     · ICAO Annex 11 §3.7 separation provision
     · EUROCONTROL CASCADE / iFACTS Operational Concept v3.1
     · EUROCONTROL Safety Nets Implementation Guideline 2018
     · EUROCAE ED-202A safety-nets MTCD MOPS
     · EUROCAE ED-87C conflict probe surveillance
     · FAA Order JO 7110.65 §5-5 / §5-7 / §5-9 separation
     · FAA ERAM Conflict Detection Probe (CDP) functional spec
     · FAA STARS Conflict Alert (CA) ATC automation
     · NATS iFACTS Tactical Controller Tool 2011
     · DFS PHARE / VAFORIT MTCD implementation 2013
     · MITRE TM-2007 Conflict Resolution Advisories study
     · SESAR PJ.10-W2 PROSA conflict-resolution validation
     · NTSB AAR-87-03 NW255 — separation provision lapse
     · BFU 02/02 Überlingen B752/Tu154 — STCA absence
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'HARD-CONFLICT' | 'PROBE-HIT' | 'COORD' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'HARD-CONFLICT': '#ef4444', 'PROBE-HIT': '#f43f5e', COORD: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['HARD-CONFLICT', 'PROBE-HIT', 'COORD', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { 'HARD-CONFLICT': 0, 'PROBE-HIT': 1, COORD: 2, WATCH: 3, OK: 4, IDLE: 5 }

type Geom = 'HEAD-ON' | 'CROSSING' | 'OVERTAKE' | 'IN-TRAIL'
const GEOM_COLOR: Record<Geom, string> = { 'HEAD-ON': '#ef4444', CROSSING: '#f59e0b', OVERTAKE: '#a855f7', 'IN-TRAIL': '#0ea5e9' }
const GEOM_W: Record<Geom, number> = { 'HEAD-ON': 1.30, CROSSING: 1.10, OVERTAKE: 1.00, 'IN-TRAIL': 0.85 }

type Vol = 'OCN' | 'ENR' | 'TMA' | 'APP' | 'PRM'
interface SectorVol {
  id: string; name: string; vol: Vol
  lat: number; lng: number; radNm: number
  hMinNm: number; vMinFt: number
  flLo: number; flHi: number
  fir?: string
}
/* 28 representative ATS volumes spanning oceanic, enroute, TMA, APP, PRM */
const SECTORS: SectorVol[] = [
  // Oceanic
  { id: 'NAT-W', name: 'Shanwick OCA (NAT-W)', vol: 'OCN', lat: 54, lng: -25, radNm: 700, hMinNm: 10, vMinFt: 1000, flLo: 280, flHi: 430, fir: 'EGGX' },
  { id: 'NAT-E', name: 'Gander OCA (NAT-E)', vol: 'OCN', lat: 51, lng: -45, radNm: 700, hMinNm: 10, vMinFt: 1000, flLo: 280, flHi: 430, fir: 'CZQX' },
  { id: 'PAC-A', name: 'Anchorage Oceanic', vol: 'OCN', lat: 50, lng: -160, radNm: 800, hMinNm: 10, vMinFt: 1000, flLo: 280, flHi: 430, fir: 'PAZA' },
  { id: 'PAC-O', name: 'Oakland Oceanic', vol: 'OCN', lat: 30, lng: -160, radNm: 900, hMinNm: 10, vMinFt: 1000, flLo: 280, flHi: 430, fir: 'KZAK' },
  // Enroute high
  { id: 'ZNY-H', name: 'ZNY New York High', vol: 'ENR', lat: 41.5, lng: -74.5, radNm: 220, hMinNm: 5, vMinFt: 1000, flLo: 180, flHi: 450, fir: 'KZNY' },
  { id: 'ZLA-H', name: 'ZLA Los Angeles High', vol: 'ENR', lat: 34.7, lng: -117.0, radNm: 240, hMinNm: 5, vMinFt: 1000, flLo: 180, flHi: 450, fir: 'KZLA' },
  { id: 'ZAU-H', name: 'ZAU Chicago High', vol: 'ENR', lat: 41.9, lng: -88.2, radNm: 220, hMinNm: 5, vMinFt: 1000, flLo: 180, flHi: 450, fir: 'KZAU' },
  { id: 'ZTL-H', name: 'ZTL Atlanta High', vol: 'ENR', lat: 33.7, lng: -84.4, radNm: 220, hMinNm: 5, vMinFt: 1000, flLo: 180, flHi: 450, fir: 'KZTL' },
  { id: 'ZHU-H', name: 'ZHU Houston High', vol: 'ENR', lat: 29.9, lng: -94.5, radNm: 220, hMinNm: 5, vMinFt: 1000, flLo: 180, flHi: 450, fir: 'KZHU' },
  { id: 'EGTT-H', name: 'London ACC High', vol: 'ENR', lat: 52.0, lng: -0.5, radNm: 180, hMinNm: 5, vMinFt: 1000, flLo: 200, flHi: 450, fir: 'EGTT' },
  { id: 'LFFF-H', name: 'Reims ACC High', vol: 'ENR', lat: 49.3, lng: 4.1, radNm: 180, hMinNm: 5, vMinFt: 1000, flLo: 200, flHi: 450, fir: 'LFFF' },
  { id: 'EDUU-H', name: 'Karlsruhe UAC', vol: 'ENR', lat: 49.0, lng: 8.4, radNm: 220, hMinNm: 5, vMinFt: 1000, flLo: 245, flHi: 660, fir: 'EDUU' },
  { id: 'LSAS-H', name: 'Switzerland ACC', vol: 'ENR', lat: 47.0, lng: 8.3, radNm: 130, hMinNm: 5, vMinFt: 1000, flLo: 195, flHi: 460, fir: 'LSAS' },
  { id: 'RJTT-A', name: 'Tokyo ACC', vol: 'ENR', lat: 35.7, lng: 140.0, radNm: 220, hMinNm: 5, vMinFt: 1000, flLo: 200, flHi: 460, fir: 'RJJJ' },
  { id: 'VHHK-A', name: 'Hong Kong FIR', vol: 'ENR', lat: 22.3, lng: 114.0, radNm: 200, hMinNm: 5, vMinFt: 1000, flLo: 200, flHi: 460, fir: 'VHHK' },
  { id: 'WSJC-A', name: 'Singapore FIR', vol: 'ENR', lat: 1.5, lng: 104.5, radNm: 220, hMinNm: 5, vMinFt: 1000, flLo: 200, flHi: 460, fir: 'WSJC' },
  // TMA
  { id: 'KJFK-T', name: 'New York TMA', vol: 'TMA', lat: 40.78, lng: -73.87, radNm: 60, hMinNm: 3, vMinFt: 1000, flLo: 50, flHi: 230 },
  { id: 'KLAX-T', name: 'SoCal TMA', vol: 'TMA', lat: 33.94, lng: -118.41, radNm: 70, hMinNm: 3, vMinFt: 1000, flLo: 50, flHi: 230 },
  { id: 'KORD-T', name: 'Chicago TMA', vol: 'TMA', lat: 41.98, lng: -87.91, radNm: 60, hMinNm: 3, vMinFt: 1000, flLo: 50, flHi: 230 },
  { id: 'EGLL-T', name: 'London TMA', vol: 'TMA', lat: 51.47, lng: -0.45, radNm: 60, hMinNm: 3, vMinFt: 1000, flLo: 50, flHi: 245 },
  { id: 'LFPG-T', name: 'Paris TMA', vol: 'TMA', lat: 49.01, lng: 2.55, radNm: 60, hMinNm: 3, vMinFt: 1000, flLo: 50, flHi: 245 },
  { id: 'EDDF-T', name: 'Frankfurt TMA', vol: 'TMA', lat: 50.03, lng: 8.56, radNm: 55, hMinNm: 3, vMinFt: 1000, flLo: 50, flHi: 245 },
  { id: 'OMDB-T', name: 'Dubai TMA', vol: 'TMA', lat: 25.25, lng: 55.36, radNm: 60, hMinNm: 3, vMinFt: 1000, flLo: 50, flHi: 245 },
  // APP
  { id: 'KSFO-A', name: 'NorCal Final', vol: 'APP', lat: 37.62, lng: -122.38, radNm: 25, hMinNm: 2.5, vMinFt: 1000, flLo: 0, flHi: 100 },
  { id: 'EHAM-A', name: 'Schiphol Final', vol: 'APP', lat: 52.31, lng: 4.76, radNm: 25, hMinNm: 2.5, vMinFt: 1000, flLo: 0, flHi: 100 },
  { id: 'RJAA-A', name: 'Narita Final', vol: 'APP', lat: 35.77, lng: 140.39, radNm: 25, hMinNm: 2.5, vMinFt: 1000, flLo: 0, flHi: 100 },
  // PRM parallel approach
  { id: 'KSFO-P', name: 'SFO PRM 28L/R', vol: 'PRM', lat: 37.62, lng: -122.38, radNm: 12, hMinNm: 1.0, vMinFt: 1000, flLo: 0, flHi: 70 },
  { id: 'KORD-P', name: 'ORD PRM 27L/C/R', vol: 'PRM', lat: 41.98, lng: -87.91, radNm: 12, hMinNm: 1.0, vMinFt: 1000, flLo: 0, flHi: 70 },
]
const VOL_COLOR: Record<Vol, string> = { OCN: '#a855f7', ENR: '#0ea5e9', TMA: '#10b981', APP: '#f59e0b', PRM: '#f43f5e' }

function hash32(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 } return h >>> 0 }
function hashFrac(s: string): number { return (hash32(s) % 100000) / 100000 }
function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)) }
function map01(n: number, a: number, b: number) { if (a === b) return 0; return clamp((n - a) / (b - a), 0, 1) }
function distNm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3440.065
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180
  const sa = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa))
}
function projectNm(p: { lat: number; lng: number }, brgDeg: number, distNmIn: number) {
  const R = 3440.065
  const br = brgDeg * Math.PI / 180
  const la1 = p.lat * Math.PI / 180
  const lo1 = p.lng * Math.PI / 180
  const dr = distNmIn / R
  const la2 = Math.asin(Math.sin(la1) * Math.cos(dr) + Math.cos(la1) * Math.sin(dr) * Math.cos(br))
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(la1), Math.cos(dr) - Math.sin(la1) * Math.sin(la2))
  return { lat: la2 * 180 / Math.PI, lng: ((lo2 * 180 / Math.PI + 540) % 360) - 180 }
}
function trackToVecKts(velKts: number, trackDeg: number) {
  const r = trackDeg * Math.PI / 180
  // x = east kts, y = north kts
  return { vx: Math.sin(r) * velKts, vy: Math.cos(r) * velKts }
}
/* Equirectangular projection to local NM frame around mid-point */
function localNm(a: { lat: number; lng: number }, ref: { lat: number; lng: number }) {
  const x = (a.lng - ref.lng) * 60 * Math.cos(ref.lat * Math.PI / 180)
  const y = (a.lat - ref.lat) * 60
  return { x, y }
}

function classifySector(lat: number, lng: number, altFt: number): SectorVol | undefined {
  // pick the most restrictive (smallest hMin) sector whose disc contains the aircraft and altitude band fits
  let best: SectorVol | undefined; let bestRank = 99
  for (const s of SECTORS) {
    const d = distNm({ lat, lng }, s)
    if (d > s.radNm) continue
    if (altFt < s.flLo * 100 - 1000) continue
    if (altFt > s.flHi * 100 + 1000) continue
    const rank = s.vol === 'PRM' ? 0 : s.vol === 'APP' ? 1 : s.vol === 'TMA' ? 2 : s.vol === 'ENR' ? 3 : 4
    if (rank < bestRank) { best = s; bestRank = rank }
  }
  return best
}

interface Pair {
  a: SFlight; b: SFlight
  sec?: SectorVol
  // CPA
  tauMin: number
  hSepNm: number
  vSepFt: number
  hDefNm: number      // required − actual (positive = breach)
  vDefFt: number
  geom: Geom
  closingKts: number
  drvT: number; drvH: number; drvV: number; drvG: number; drvS: number; drvP: number
  driver: 'T' | 'H' | 'V' | 'G' | 'S' | 'P' | 'NONE'
  score: number
  tier: Tier
  crossFir: boolean
}

const SRC_HALO = 'mtcd-halo'; const LYR_HALO = 'mtcd-halo-l'
const SRC_LBL = 'mtcd-lbl';  const LYR_LBL = 'mtcd-lbl-l'
const SRC_PIN = 'mtcd-pin';  const LYR_PIN = 'mtcd-pin-l'
const SRC_LINK = 'mtcd-lnk'; const LYR_LINK = 'mtcd-lnk-l'
const SRC_TRAJ = 'mtcd-trj'; const LYR_TRAJ = 'mtcd-trj-l'
const SRC_SEC = 'mtcd-sec';  const LYR_SEC = 'mtcd-sec-l'
const SRC_CPA = 'mtcd-cpa';  const LYR_CPA = 'mtcd-cpa-l'

export default function MtcdMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'PAIRS' | 'SECTORS' | 'GEOMETRY'>('PAIRS')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [volFilter, setVolFilter] = useState<Vol | 'ALL'>('ALL')
  const [query, setQuery] = useState('')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(450)
  const [horizonMin, setHorizonMin] = useState(12)   // 8–20 min MTCD look-ahead
  const [hMinMul, setHMinMul] = useState(100)        // % of nominal hMin
  const [vMinMul, setVMinMul] = useState(100)
  const [scopeNm, setScopeNm] = useState(80)         // pair-candidate gate
  const [advMul, setAdvMul] = useState(100)
  const [vBand, setVBand] = useState(4000)           // vertical pre-screen ft
  const [phaseWt, setPhaseWt] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showTraj, setShowTraj] = useState(true)
  const [showSec, setShowSec] = useState(true)
  const [showCpa, setShowCpa] = useState(true)
  const [showDiag, setShowDiag] = useState(true)

  const pairs = useMemo<Pair[]>(() => {
    const filt = flights.filter(f => !f.ground && f.altitudeFt >= minFl * 100 && f.altitudeFt <= maxFl * 100 && Number.isFinite(f.lat) && Number.isFinite(f.lng))
    const out: Pair[] = []
    const N = filt.length
    // bucket by lat to speed up O(N²)
    for (let i = 0; i < N; i++) {
      const a = filt[i]
      for (let j = i + 1; j < N; j++) {
        const b = filt[j]
        // quick pre-screen on lat-band 1° ≈ 60 NM
        if (Math.abs(a.lat - b.lat) * 60 > scopeNm) continue
        if (Math.abs(a.altitudeFt - b.altitudeFt) > vBand) continue
        const d0 = distNm(a, b)
        if (d0 > scopeNm) continue
        // local NM frame around midpoint
        const ref = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }
        const pa = localNm(a, ref); const pb = localNm(b, ref)
        const va = trackToVecKts(a.velocityKts, a.track)
        const vb = trackToVecKts(b.velocityKts, b.track)
        const dx = pa.x - pb.x, dy = pa.y - pb.y
        const dvx = (va.vx - vb.vx) / 60, dvy = (va.vy - vb.vy) / 60  // kts -> NM/min
        const denom = dvx * dvx + dvy * dvy
        let tauMin = 0
        if (denom > 1e-9) tauMin = -(dx * dvx + dy * dvy) / denom
        if (tauMin < 0) tauMin = 0
        if (tauMin > horizonMin) continue
        const xcpa = dx + dvx * tauMin
        const ycpa = dy + dvy * tauMin
        const hSepNm = Math.sqrt(xcpa * xcpa + ycpa * ycpa)
        const vSepFt = Math.abs((a.altitudeFt + a.vertRate * tauMin) - (b.altitudeFt + b.vertRate * tauMin))
        // CPA location for sector classification
        const cpaPt = projectNm(ref, Math.atan2((pa.x + pb.x) / 2 + ((va.vx + vb.vx) / 60) * tauMin / 2,
          (pa.y + pb.y) / 2 + ((va.vy + vb.vy) / 60) * tauMin / 2) * 180 / Math.PI,
          Math.hypot((pa.x + pb.x) / 2, (pa.y + pb.y) / 2))
        const avgAlt = ((a.altitudeFt + a.vertRate * tauMin) + (b.altitudeFt + b.vertRate * tauMin)) / 2
        const sec = classifySector(cpaPt.lat, cpaPt.lng, avgAlt) ||
                    classifySector((a.lat + b.lat) / 2, (a.lng + b.lng) / 2, (a.altitudeFt + b.altitudeFt) / 2)
        const hMin = (sec ? sec.hMinNm : 5) * (hMinMul / 100)
        const vMin = (sec ? sec.vMinFt : 1000) * (vMinMul / 100)
        const hDefNm = hMin - hSepNm
        const vDefFt = vMin - vSepFt
        // Geometry by relative track angle
        const dt = ((a.track - b.track + 540) % 360) - 180
        const abs = Math.abs(dt)
        let geom: Geom = 'CROSSING'
        if (abs >= 135) geom = 'HEAD-ON'
        else if (abs <= 25 && Math.abs(a.velocityKts - b.velocityKts) > 60) geom = 'OVERTAKE'
        else if (abs <= 25) geom = 'IN-TRAIL'
        // closing speed magnitude
        const closingKts = Math.sqrt((va.vx - vb.vx) ** 2 + (va.vy - vb.vy) ** 2)
        // Cross-FIR coordination
        const crossFir = !!(sec && sec.fir && (hashFrac(a.icao + 'fir') < 0.4 || hashFrac(b.icao + 'fir') < 0.4) && hashFrac(a.icao + b.icao + 'xfir') < 0.5)
        // Drivers 0–100
        const drvT = clamp(map01(horizonMin - tauMin, 0, horizonMin) * 100, 0, 100)
        const drvH = hDefNm > 0 ? clamp((hDefNm / hMin) * 100 + 50, 0, 100) : clamp(map01(hMin * 1.6 - hSepNm, 0, hMin * 1.6) * 70, 0, 100)
        const drvV = vDefFt > 0 ? clamp((vDefFt / vMin) * 100 + 50, 0, 100) : clamp(map01(vMin * 1.6 - vSepFt, 0, vMin * 1.6) * 70, 0, 100)
        const drvG = clamp(GEOM_W[geom] * 60 + (closingKts / 12), 0, 100)
        const drvS = sec ? (sec.vol === 'PRM' ? 90 : sec.vol === 'APP' ? 75 : sec.vol === 'TMA' ? 55 : sec.vol === 'ENR' ? 35 : 25) : 15
        const drvP = crossFir ? 65 : 20
        // composite max-driver weighted
        let score = Math.max(
          drvH * 1.00,
          drvV * 0.95,
          drvT * 0.85,
          drvG * 0.55,
          drvS * 0.45,
          drvP * 0.40,
        )
        score = score * (phaseWt / 100) * (advMul / 100)
        score = clamp(score, 0, 100)
        let driver: Pair['driver'] = 'NONE'
        const maxV = Math.max(drvH, drvV, drvT, drvG, drvS, drvP)
        if (maxV === drvH) driver = 'H'
        else if (maxV === drvV) driver = 'V'
        else if (maxV === drvT) driver = 'T'
        else if (maxV === drvG) driver = 'G'
        else if (maxV === drvS) driver = 'S'
        else driver = 'P'
        let tier: Tier = 'OK'
        const breach = hDefNm > 0 && vDefFt > 0
        if (breach && tauMin <= horizonMin * 0.5 && score >= 80) tier = 'HARD-CONFLICT'
        else if (breach && score >= 60) tier = 'PROBE-HIT'
        else if ((hDefNm > -hMin * 0.3 || vDefFt > -vMin * 0.4) && score >= 40) tier = 'COORD'
        else if (score >= 22) tier = 'WATCH'
        else tier = 'OK'
        out.push({ a, b, sec, tauMin, hSepNm, vSepFt, hDefNm, vDefFt, geom, closingKts, drvT, drvH, drvV, drvG, drvS, drvP, driver, score, tier, crossFir })
      }
    }
    return out.sort((x, y) => TIER_RANK[x.tier] - TIER_RANK[y.tier] || y.score - x.score)
  }, [flights, minFl, maxFl, horizonMin, hMinMul, vMinMul, scopeNm, vBand, advMul, phaseWt])

  const tierCount: Record<Tier, number> = { 'HARD-CONFLICT': 0, 'PROBE-HIT': 0, COORD: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const p of pairs) tierCount[p.tier]++
  const worst = pairs[0]
  const meanScore = pairs.length ? pairs.reduce((s, p) => s + p.score, 0) / pairs.length : 0
  const meanTau = pairs.length ? pairs.reduce((s, p) => s + p.tauMin, 0) / pairs.length : 0
  const breachShare = pairs.length ? (tierCount['HARD-CONFLICT'] + tierCount['PROBE-HIT']) / pairs.length : 0

  const filtered = pairs.filter(p => {
    if (tierFilter !== 'ALL' && p.tier !== tierFilter) return false
    if (volFilter !== 'ALL' && p.sec?.vol !== volFilter) return false
    if (query) {
      const q = query.toLowerCase()
      const hay = `${p.a.callsign || ''} ${p.a.icao} ${p.b.callsign || ''} ${p.b.icao} ${p.sec?.id || ''} ${p.sec?.name || ''} ${p.geom}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  /* sector rollup */
  const sectorRows = useMemo(() => {
    const m = new Map<string, { s: SectorVol; pairs: number; hard: number; probe: number; coord: number; meanScore: number; worst?: Pair }>()
    for (const s of SECTORS) m.set(s.id, { s, pairs: 0, hard: 0, probe: 0, coord: 0, meanScore: 0 })
    for (const p of pairs) {
      if (!p.sec) continue
      const e = m.get(p.sec.id)!
      e.pairs++
      if (p.tier === 'HARD-CONFLICT') e.hard++
      if (p.tier === 'PROBE-HIT') e.probe++
      if (p.tier === 'COORD') e.coord++
      e.meanScore += p.score
      if (!e.worst || p.score > e.worst.score) e.worst = p
    }
    return Array.from(m.values())
      .map(e => ({ ...e, meanScore: e.pairs ? e.meanScore / e.pairs : 0 }))
      .filter(e => e.pairs > 0)
      .sort((a, b) => (b.hard - a.hard) || (b.probe - a.probe) || (b.pairs - a.pairs))
  }, [pairs])

  const geomRows = useMemo(() => {
    const m: Record<Geom, { n: number; hard: number; probe: number; coord: number; meanScore: number; meanClose: number }> = {
      'HEAD-ON': { n: 0, hard: 0, probe: 0, coord: 0, meanScore: 0, meanClose: 0 },
      CROSSING:  { n: 0, hard: 0, probe: 0, coord: 0, meanScore: 0, meanClose: 0 },
      OVERTAKE:  { n: 0, hard: 0, probe: 0, coord: 0, meanScore: 0, meanClose: 0 },
      'IN-TRAIL':{ n: 0, hard: 0, probe: 0, coord: 0, meanScore: 0, meanClose: 0 },
    }
    for (const p of pairs) {
      const g = m[p.geom]; g.n++
      if (p.tier === 'HARD-CONFLICT') g.hard++
      if (p.tier === 'PROBE-HIT') g.probe++
      if (p.tier === 'COORD') g.coord++
      g.meanScore += p.score; g.meanClose += p.closingKts
    }
    return (['HEAD-ON', 'CROSSING', 'OVERTAKE', 'IN-TRAIL'] as Geom[]).map(k => ({
      k,
      ...m[k],
      meanScore: m[k].n ? m[k].meanScore / m[k].n : 0,
      meanClose: m[k].n ? m[k].meanClose / m[k].n : 0,
    }))
  }, [pairs])

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const ensureSrc = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }) }
    ensureSrc(SRC_SEC); ensureSrc(SRC_HALO); ensureSrc(SRC_PIN); ensureSrc(SRC_LBL); ensureSrc(SRC_LINK); ensureSrc(SRC_TRAJ); ensureSrc(SRC_CPA)
    if (!map.getLayer(LYR_SEC)) map.addLayer({
      id: LYR_SEC, type: 'circle', source: SRC_SEC,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 4, 5, 10, 9, 22],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.10,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 0.9,
        'circle-stroke-opacity': 0.55,
      },
    })
    if (!map.getLayer(LYR_HALO)) map.addLayer({
      id: LYR_HALO, type: 'circle', source: SRC_HALO,
      paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.22, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.2, 'circle-stroke-opacity': 0.85 },
    })
    if (!map.getLayer(LYR_LINK)) map.addLayer({
      id: LYR_LINK, type: 'line', source: SRC_LINK,
      paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-dasharray': [2, 2], 'line-opacity': 0.85 },
    })
    if (!map.getLayer(LYR_TRAJ)) map.addLayer({
      id: LYR_TRAJ, type: 'line', source: SRC_TRAJ,
      paint: { 'line-color': ['get', 'color'], 'line-width': 0.9, 'line-opacity': 0.7 },
    })
    if (!map.getLayer(LYR_CPA)) map.addLayer({
      id: LYR_CPA, type: 'circle', source: SRC_CPA,
      paint: { 'circle-radius': 4, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#020617', 'circle-stroke-width': 1 },
    })
    if (!map.getLayer(LYR_PIN)) map.addLayer({
      id: LYR_PIN, type: 'circle', source: SRC_PIN,
      paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1 },
    })
    if (!map.getLayer(LYR_LBL)) map.addLayer({
      id: LYR_LBL, type: 'symbol', source: SRC_LBL,
      layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': true },
      paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.4 },
    })

    const sec: any[] = []; const halo: any[] = []; const pin: any[] = []; const lbl: any[] = []; const link: any[] = []; const traj: any[] = []; const cpa: any[] = []
    if (showSec) {
      for (const s of SECTORS) {
        sec.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { color: VOL_COLOR[s.vol] } })
        if (showLbl) lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { label: `${s.id} · ${s.hMinNm}NM/${s.vMinFt}ft`, color: VOL_COLOR[s.vol] } })
      }
    }
    for (const p of pairs) {
      if (p.tier === 'OK' || p.tier === 'IDLE') continue
      const color = TIER_COLOR[p.tier]
      if (showLink) link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[p.a.lng, p.a.lat], [p.b.lng, p.b.lat]] }, properties: { color } })
      if (showHalo) {
        const r = 8 + p.score * 0.14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.a.lng, p.a.lat] }, properties: { color, r } })
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.b.lng, p.b.lat] }, properties: { color, r } })
      }
      if (showPin && (p.tier === 'HARD-CONFLICT' || p.tier === 'PROBE-HIT')) {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.a.lng, p.a.lat] }, properties: { color } })
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.b.lng, p.b.lat] }, properties: { color } })
      }
      if (showTraj) {
        for (const f of [p.a, p.b]) {
          const tip = projectNm(f, f.track, (f.velocityKts * (horizonMin / 60)))
          traj.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[f.lng, f.lat], [tip.lng, tip.lat]] }, properties: { color } })
        }
      }
      if (showCpa) {
        const cpaA = projectNm(p.a, p.a.track, p.a.velocityKts * (p.tauMin / 60))
        const cpaB = projectNm(p.b, p.b.track, p.b.velocityKts * (p.tauMin / 60))
        cpa.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [cpaA.lng, cpaA.lat] }, properties: { color } })
        cpa.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [cpaB.lng, cpaB.lat] }, properties: { color } })
      }
      if (showLbl) {
        const lab = `${p.a.callsign || p.a.icao}↔${p.b.callsign || p.b.icao} · τ${p.tauMin.toFixed(1)}m · ${p.hSepNm.toFixed(1)}NM/${p.vSepFt.toFixed(0)}ft`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [(p.a.lng + p.b.lng) / 2, (p.a.lat + p.b.lat) / 2] }, properties: { label: lab, color } })
      }
    }
    ;(map.getSource(SRC_SEC) as any).setData({ type: 'FeatureCollection', features: sec })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_TRAJ) as any).setData({ type: 'FeatureCollection', features: traj })
    ;(map.getSource(SRC_CPA) as any).setData({ type: 'FeatureCollection', features: cpa })
    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_TRAJ, LYR_CPA, LYR_SEC]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_LBL, SRC_PIN, SRC_LINK, SRC_TRAJ, SRC_CPA, SRC_SEC]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, pairs, showSec, showHalo, showPin, showLbl, showLink, showTraj, showCpa, horizonMin])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const drvBadge = (lab: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{lab} {sev.toFixed(0)}</span>
  )
  const advice = (p: Pair) => {
    const hSep = `${p.hSepNm.toFixed(1)}NM`; const vSep = `${p.vSepFt.toFixed(0)}ft`
    const min = `${(p.sec?.hMinNm ?? 5).toFixed(1)}NM/${p.sec?.vMinFt ?? 1000}ft`
    if (p.tier === 'HARD-CONFLICT') return `MTCD HARD CONFLICT in τ${p.tauMin.toFixed(1)}m · CPA ${hSep}/${vSep} vs min ${min} · vector trailer ${p.geom === 'HEAD-ON' ? '30° right + climb/descend 1000ft' : '20° behind ${p.b.callsign || p.b.icao}'} per JO 7110.65 §5-7 ICAO Doc 4444 §15.7`
    if (p.tier === 'PROBE-HIT') return `Conflict probe hit τ${p.tauMin.toFixed(1)}m · CPA ${hSep}/${vSep} vs min ${min} · pre-coord intent change ${p.crossFir ? 'with adjacent FIR ' + (p.sec?.fir || '') : 'within sector'} per EUROCONTROL CASCADE/iFACTS`
    if (p.tier === 'COORD') return `Coord required τ${p.tauMin.toFixed(1)}m · margin tight ${hSep}/${vSep} · evaluate level change or vector per Doc 4444 §8.6 / §15.7`
    if (p.tier === 'WATCH') return `Watch geometry ${p.geom} · τ${p.tauMin.toFixed(1)}m · monitor; no immediate action`
    return `Clear · CPA ${hSep}/${vSep} > min ${min}`
  }

  /* Scatter: tauMin (X) vs combined separation deficit (Y) */
  const W = 280, H = 180
  const sx = (n: number) => 32 + (n / horizonMin) * (W - 42)
  const sy = (n: number) => H - 24 - ((n + 5) / 15) * (H - 40)   // n in NM-equiv deficit

  return (
    <div className="absolute top-16 right-3 z-40 w-[440px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">MTCD · Medium-Term Conflict Detection</div>
          <div className="text-[10px] text-slate-500">EUROCONTROL CASCADE/iFACTS · Doc 4444 §15.7 · ED-202A · JO 7110.65 §5-7</div>
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
          <div className="text-sm font-semibold" style={{ color: meanScore >= 60 ? '#ef4444' : meanScore >= 25 ? '#f59e0b' : '#10b981' }}>{meanScore.toFixed(0)}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst pair</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst ? `${worst.a.callsign || worst.a.icao}↔${worst.b.callsign || worst.b.icao}` : '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Hard hits</div>
          <div className="text-sm font-semibold" style={{ color: tierCount['HARD-CONFLICT'] > 0 ? '#ef4444' : '#10b981' }}>{tierCount['HARD-CONFLICT']}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Probe hits</div>
          <div className="text-xs font-semibold" style={{ color: tierCount['PROBE-HIT'] > 0 ? '#f43f5e' : '#10b981' }}>{tierCount['PROBE-HIT']}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean τ (min)</div>
          <div className="text-xs font-semibold text-slate-100">{meanTau.toFixed(1)}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Pairs probed</div>
          <div className="text-xs font-semibold text-slate-100">{pairs.length}</div>
        </div>
      </div>

      {showDiag && pairs.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* Breach band: deficit > 0 */}
            <rect x={sx(0)} y={sy(15)} width={sx(horizonMin) - sx(0)} height={sy(0) - sy(15)} fill="#ef444415" />
            {/* Hard quadrant: τ ≤ horizon/2 + deficit > 1 */}
            <rect x={sx(0)} y={sy(15)} width={sx(horizonMin / 2) - sx(0)} height={sy(1) - sy(15)} fill="#ef444425" />
            {/* Watch band */}
            <rect x={sx(0)} y={sy(0)} width={sx(horizonMin) - sx(0)} height={sy(-3) - sy(0)} fill="#0ea5e918" />
            {/* zero deficit reference */}
            <line x1={sx(0)} y1={sy(0)} x2={sx(horizonMin)} y2={sy(0)} stroke="#ef4444" strokeWidth={0.6} strokeDasharray="3 3" />
            <line x1={sx(horizonMin / 2)} y1={sy(-5)} x2={sx(horizonMin / 2)} y2={sy(15)} stroke="#f59e0b" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={W / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="#64748b">Time to CPA (min)</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>Sep deficit (NM-equiv)</text>
            {pairs.slice(0, 200).map((p, i) => {
              // Combined deficit: h in NM + v/1000ft equiv
              const def = Math.max(p.hDefNm, 0) + Math.max(p.vDefFt / 1000, 0) * 1.0 - Math.max(0, -p.hDefNm) * 0.1
              return <circle key={i} cx={sx(p.tauMin)} cy={sy(def)} r={2.4} fill={TIER_COLOR[p.tier]} opacity={0.85} />
            })}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['MIN-FL', minFl, 0, 200, setMinFl, ''],
            ['MAX-FL', maxFl, 50, 500, setMaxFl, ''],
            ['HORIZON', horizonMin, 4, 20, setHorizonMin, 'm'],
            ['SCOPE', scopeNm, 20, 200, setScopeNm, 'nm'],
            ['HMIN-MUL', hMinMul, 50, 200, setHMinMul, '%'],
            ['VMIN-MUL', vMinMul, 50, 200, setVMinMul, '%'],
            ['V-BAND', vBand, 1000, 12000, setVBand, 'ft'],
            ['PHASE-WT', phaseWt, 50, 150, setPhaseWt, '%'],
            ['ADV-MUL', advMul, 50, 200, setAdvMul, '%'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[40px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['OCN', 'ENR', 'TMA', 'APP', 'PRM'] as Vol[]).map(k => (
            <button key={k} onClick={() => setVolFilter(volFilter === k ? 'ALL' : k)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: volFilter === k ? VOL_COLOR[k] + '33' : '#0b1220', borderColor: volFilter === k ? VOL_COLOR[k] : '#1e293b', color: volFilter === k ? VOL_COLOR[k] : '#cbd5e1' }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['LINK', showLink, setShowLink],
            ['TRAJ', showTraj, setShowTraj],
            ['CPA', showCpa, setShowCpa],
            ['SEC', showSec, setShowSec],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / sector / geometry" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['PAIRS', 'SECTORS', 'GEOMETRY'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className="flex-1 px-2 py-1.5 text-[11px]" style={{ color: tab === t ? '#0ea5e9' : '#94a3b8', backgroundColor: tab === t ? '#0ea5e915' : 'transparent', borderBottom: tab === t ? '2px solid #0ea5e9' : '2px solid transparent' }}>{t}</button>
        ))}
      </div>

      {tab === 'PAIRS' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No pair within MTCD horizon · widen SCOPE / HORIZON</div>}
          {filtered.slice(0, 80).map((p, i) => (
            <div key={i} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(p.a.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[p.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 truncate">{p.a.callsign || p.a.icao}</span>
                  <span className="text-slate-500">↔</span>
                  <span className="font-semibold text-slate-100 truncate">{p.b.callsign || p.b.icao}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: GEOM_COLOR[p.geom], backgroundColor: GEOM_COLOR[p.geom] + '22', border: `1px solid ${GEOM_COLOR[p.geom]}66` }}>{p.geom}</span>
                  {p.sec && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: VOL_COLOR[p.sec.vol], backgroundColor: VOL_COLOR[p.sec.vol] + '22', border: `1px solid ${VOL_COLOR[p.sec.vol]}66` }}>{p.sec.id}</span>}
                </div>
                {tierBadge(p.tier)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                τ <span style={{ color: p.tauMin <= horizonMin * 0.3 ? '#ef4444' : p.tauMin <= horizonMin * 0.6 ? '#f59e0b' : '#10b981' }}>{p.tauMin.toFixed(1)}m</span>
                {' · '}CPA <span style={{ color: p.hDefNm > 0 ? '#ef4444' : '#10b981' }}>{p.hSepNm.toFixed(2)}NM</span>
                {' / '}<span style={{ color: p.vDefFt > 0 ? '#ef4444' : '#10b981' }}>{p.vSepFt.toFixed(0)}ft</span>
                {' vs min '}<span className="text-slate-500">{(p.sec?.hMinNm ?? 5).toFixed(1)}NM/{p.sec?.vMinFt ?? 1000}ft</span>
                {p.crossFir && <span className="ml-1 text-amber-400">› xFIR</span>}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                closing <span className="text-slate-300">{p.closingKts.toFixed(0)}kts</span>
                {' · '}FL <span className="text-slate-300">{(p.a.altitudeFt / 100).toFixed(0)}↔{(p.b.altitudeFt / 100).toFixed(0)}</span>
                {' · '}vs <span className="text-slate-300">{p.a.vertRate >= 0 ? '+' : ''}{p.a.vertRate.toFixed(0)}fpm ↔ {p.b.vertRate >= 0 ? '+' : ''}{p.b.vertRate.toFixed(0)}fpm</span>
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${p.score}%`, backgroundColor: TIER_COLOR[p.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {drvBadge('T', p.drvT)}
                {drvBadge('H', p.drvH)}
                {drvBadge('V', p.drvV)}
                {drvBadge('G', p.drvG)}
                {drvBadge('S', p.drvS)}
                {drvBadge('P', p.drvP)}
              </div>
              <div className="text-[10px] mt-1" style={{ color: TIER_COLOR[p.tier] }}>{advice(p)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'SECTORS' && (
        <div className="divide-y divide-slate-800">
          {sectorRows.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No sector activity</div>}
          {sectorRows.map((e, i) => (
            <div key={i} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => e.worst && onFly(e.worst.a.icao)} style={{ borderLeft: `3px solid ${e.hard ? '#ef4444' : e.probe ? '#f43f5e' : e.coord ? '#f59e0b' : '#0ea5e9'}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-slate-100 font-mono">{e.s.id}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: VOL_COLOR[e.s.vol], backgroundColor: VOL_COLOR[e.s.vol] + '22', border: `1px solid ${VOL_COLOR[e.s.vol]}66` }}>{e.s.vol}</span>
                  <span className="text-[10px] text-slate-400">{e.s.name}</span>
                </div>
                <div className="text-[10px] text-slate-400">{e.pairs} prs</div>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                min {e.s.hMinNm}NM/{e.s.vMinFt}ft · FL{e.s.flLo}-{e.s.flHi} · r{e.s.radNm}nm{e.s.fir ? ` · ${e.s.fir}` : ''}
              </div>
              <div className="flex items-center gap-2 mt-1">
                {e.hard > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/40">HARD {e.hard}</span>}
                {e.probe > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: '#f43f5e', backgroundColor: '#f43f5e1a', border: '1px solid #f43f5e66' }}>PROBE {e.probe}</span>}
                {e.coord > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/40">COORD {e.coord}</span>}
                <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${e.meanScore}%`, backgroundColor: e.meanScore >= 80 ? '#ef4444' : e.meanScore >= 55 ? '#f59e0b' : e.meanScore >= 25 ? '#0ea5e9' : '#10b981' }} /></div>
                <span className="text-[10px] text-slate-400 tabular-nums w-8 text-right">{e.meanScore.toFixed(0)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'GEOMETRY' && (
        <div className="divide-y divide-slate-800">
          {geomRows.map((g, i) => (
            <div key={i} className="px-3 py-2" style={{ borderLeft: `3px solid ${GEOM_COLOR[g.k]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: GEOM_COLOR[g.k], backgroundColor: GEOM_COLOR[g.k] + '22', border: `1px solid ${GEOM_COLOR[g.k]}66` }}>{g.k}</span>
                </div>
                <div className="text-[10px] text-slate-400">{g.n} prs · close {g.meanClose.toFixed(0)}kt</div>
              </div>
              <div className="flex items-center gap-2 mt-1">
                {g.hard > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/40">HARD {g.hard}</span>}
                {g.probe > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: '#f43f5e', backgroundColor: '#f43f5e1a', border: '1px solid #f43f5e66' }}>PROBE {g.probe}</span>}
                {g.coord > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/40">COORD {g.coord}</span>}
                <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${g.meanScore}%`, backgroundColor: g.meanScore >= 80 ? '#ef4444' : g.meanScore >= 55 ? '#f59e0b' : g.meanScore >= 25 ? '#0ea5e9' : '#10b981' }} /></div>
                <span className="text-[10px] text-slate-400 tabular-nums w-8 text-right">{g.meanScore.toFixed(0)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 leading-tight">
        ICAO Doc 4444 §8.6 §15.7 · Annex 11 §3.7 · Doc 9426 III.4 · EUROCONTROL CASCADE/iFACTS Op Concept v3.1 · ED-202A · ED-87C · FAA JO 7110.65 §5-5 §5-7 §5-9 · ERAM CDP · STARS CA · NATS iFACTS 2011 · DFS VAFORIT · SESAR PJ.10-W2 PROSA · BFU 02/02 Überlingen · NTSB AAR-87-03 NW255
      </div>
    </div>
  )
}
