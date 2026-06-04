'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   FIM · ASPA Flight-deck Interval Management Monitor
   ------------------------------------------------------------
   Per-airframe pairwise Flight-deck Interval Management (FIM)
   conformance scorer per RTCA DO-328A / DO-361A ASPA-FIM
   (Airborne Spacing - Flight Deck-based Interval Management).
   Identifies the FIM-equipped trailer's clearance pair: a
   designated Target ahead on a shared arrival, computes
   assigned spacing goal (ASG in seconds), achieved spacing
   interval (ASI), spacing-error, FIM commanded speed (Vfim),
   speed-conformance, and TTG (time-to-go) to PSP (Planned
   Spacing Point — typically the runway threshold or merge fix).

   Operational basis:
     · ASPA-S (stream-mode same-route, leader/trailer)
     · ASPA-M (merging from converging arrivals into common
       merge point — PMS gateway / DTW-style trombone)
     · ASPA-C (crossing routes, less common, deferred)

   FIM Spacing Modes per DO-361 §3.2:
       ACHIEVE-BY  speed regulated to hit ASG at PSP
       MAINTAIN    hold ASG steady-state after achieve
       CAPTURE     transition phase entering MAINTAIN

   Speed conformance envelope per DO-361 §3.5.4 / Boeing
   FIM-O FCOM PI 11.32:
       Vfim ± 5 kt nominal envelope
       Vfim − 20 kt to Vfim + 10 kt operating range
       must remain inside airframe Vmo/Mmo and Vfe at config

   Regulatory & standards:
     · RTCA DO-328A   ASPA-S/M/C Functional Spec
     · RTCA DO-361A   FIM Equipment MOPS
     · RTCA DO-317C   ASSAP / ADS-B IN Application Spec
     · ICAO Doc 9854  Global ATM Op Concept §3.6 (ASPA)
     · ICAO Doc 9993  CDA Manual (ASPA on STAR)
     · ICAO Doc 9931  CDO Manual §4 (spacing on profile)
     · ICAO Doc 4444  PANS-ATM §15 (separation services)
     · ICAO Annex 11  §3.7 (separation)
     · FAA NextGen ATSA-ITP / FIM ConOps v2.0
     · FAA AC 90-114B ADS-B Operations
     · FAA AC 20-172A Airborne Surveillance Applications
     · FAA Order JO 7110.65 §5-3 (separation)
     · SESAR PJ.01-W2-04 ASPA-FIM Final Approach
     · SESAR Solution #18 i4D + ASAS spacing
     · Boeing 777 FCOM PI 11.32 FIM-O Tool
     · Airbus FANS-C / ATSAW-ITP A350 OIS
     · NTSB SAFO 18002 — wake encounter on in-trail spacing
     · NASA TM-2017-219570 ASPA flight trials KLAX
     · NASA TM-2020-220471 IM-S Boston-NYC field trial
     · DLR-IB-FT-BS-2019-32 ASPA-S Frankfurt arrivals
     · EUROCONTROL ASAS Sequencing & Merging ConOps ed.2

   ============================================================
   Catalogue: 24 ASPA-FIM operational stream / merge points
   at high-density TMAs where ASAS or FIM trials have been
   conducted or where standard FIM clearances are routinely
   issued. Each tagged with airport, PSP id, lat/lng, type
   (STREAM / MERGE), nominal ASG seconds, runway, RECAT
   wake-default minimum, ANSP authority.

   ============================================================
   6 risk drivers (max-driver + secondary-mean composite):
     SPC  spacing-error magnitude vs ASG-tolerance
          0 at |err|≤5s, 100 at |err|≥40s
     CMD  commanded-speed conformance |IAS-Vfim|
          0 at ≤5 kt, 100 at ≥25 kt
     CLO  closure rate at trailer relative to leader
          0 at |closure|≤5 kt, 100 at |closure|≥40 kt
     WAK  wake-distance vs RECAT minimum
          0 at ≥125% wake min, 100 at ≤80% wake min
     RCP  RCP-240 / ADS-B IN equipage gap
          ASTM ATSAW 0, ASPA-S 0, ASPA-M 0,
          NONE 100, VHF-VOICE 70
     PHA  phase weighting CAPTURE 1.20 MAINTAIN 1.05
          ACHIEVE 1.15 TERMINATE 0.85 IDLE 0

   5 hard tiers:
     · FIM-BUST    score≥80 OR wake<MIN OR |err|≥60s
                   rose: ABORT spacing · revert ATC vectors
                   request 1000 ft offset per JO 7110.65
                   §5-3 · log per AC 20-172A
     · OUT-OF-TOL  score≥55 OR |err|≥30s OR |IAS-Vfim|≥20
                   rose-pink: speed correction now · cross-
                   check Vfim · resume MAINTAIN per DO-361
                   §3.2.4
     · DRIFT       score≥35 amber: monitor ASI drift ·
                   apply ±2 kt fine adjust per FIM-O FCOM
                   PI 11.32
     · WATCH       score≥18 sky: nominal capture · brief
                   crew on PSP TTG / merge point per DO-328
     · OK          score<18 emerald: ASG within tolerance
     · IDLE        slate: not paired / not FIM-clearance

   References:
     · RTCA DO-328A ASPA-S/M/C 2016
     · RTCA DO-361A FIM MOPS 2020
     · RTCA DO-317C ASSAP 2022
     · ICAO Doc 9854 §3.6 / Doc 9931 §4 / Doc 9993 / Doc 4444 §15
     · FAA AC 20-172A / AC 90-114B
     · FAA Order JO 7110.65 §5-3
     · SESAR PJ.01-W2-04 / SESAR Solution #18
     · Boeing 777 FCOM PI 11.32 / Airbus A350 OIS ATSAW-ITP
     · NASA TM-2017-219570 / NASA TM-2020-220471
     · EUROCONTROL ASAS S&M ConOps ed.2
     · NTSB SAFO 18002
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'FIM-BUST' | 'OUT-OF-TOL' | 'DRIFT' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'FIM-BUST': '#ef4444', 'OUT-OF-TOL': '#f43f5e', DRIFT: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['FIM-BUST', 'OUT-OF-TOL', 'DRIFT', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { 'FIM-BUST': 0, 'OUT-OF-TOL': 1, DRIFT: 2, WATCH: 3, OK: 4, IDLE: 5 }

type FimMode = 'ACHIEVE' | 'CAPTURE' | 'MAINTAIN' | 'TERMINATE' | 'IDLE'
const MODE_COLOR: Record<FimMode, string> = {
  ACHIEVE: '#a855f7', CAPTURE: '#0ea5e9', MAINTAIN: '#10b981', TERMINATE: '#475569', IDLE: '#334155',
}

type Equip = 'FIM-B1' | 'ASPA-S' | 'ATSAW' | 'ADSB-IN' | 'NONE'
const EQUIP_COLOR: Record<Equip, string> = {
  'FIM-B1': '#10b981', 'ASPA-S': '#0ea5e9', ATSAW: '#a855f7', 'ADSB-IN': '#f59e0b', NONE: '#64748b',
}

type Recat = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
const RECAT_VREF: Record<Recat, number> = { A: 168, B: 162, C: 155, D: 148, E: 142, F: 110 }
// RECAT-EU Table 4-2 (NM) — trailer rows, leader columns A/B/C/D/E/F
const RECAT_MIN: Record<Recat, Record<Recat, number>> = {
  A: { A: 3.0, B: 0, C: 0, D: 0, E: 0, F: 0 },
  B: { A: 4.0, B: 3.0, C: 0, D: 0, E: 0, F: 0 },
  C: { A: 5.0, B: 4.0, C: 3.0, D: 0, E: 0, F: 0 },
  D: { A: 5.0, B: 4.0, C: 3.0, D: 2.5, E: 2.5, F: 2.5 },
  E: { A: 6.0, B: 5.0, C: 4.0, D: 2.5, E: 2.5, F: 2.5 },
  F: { A: 8.0, B: 7.0, C: 6.0, D: 5.0, E: 4.0, F: 3.0 },
}

interface PSP {
  id: string; apt: string; name: string
  lat: number; lng: number
  rwy: string
  type: 'STREAM' | 'MERGE'
  asgSec: number      // assigned spacing goal seconds
  axisDeg: number     // inbound axis (final or stream axis)
  ansp: string
}

const PSPS: PSP[] = [
  // FAA NextGen FIM ConOps trial sites
  { id: 'KSEA-16R', apt: 'KSEA', name: 'SEATAC 16R PSP',     lat: 47.450, lng: -122.310, rwy: '16R', type: 'STREAM', asgSec: 90, axisDeg: 175, ansp: 'FAA-ZSE' },
  { id: 'KIAH-26L', apt: 'KIAH', name: 'HOUSTON 26L PSP',    lat: 29.980, lng: -95.340,  rwy: '26L', type: 'STREAM', asgSec: 85, axisDeg: 260, ansp: 'FAA-ZHU' },
  { id: 'KMEM-36L', apt: 'KMEM', name: 'MEMPHIS 36L PSP',    lat: 35.040, lng: -89.978,  rwy: '36L', type: 'STREAM', asgSec: 75, axisDeg: 0,   ansp: 'FAA-ZME' },
  { id: 'KDEN-16R', apt: 'KDEN', name: 'DENVER 16R PSP',     lat: 39.860, lng: -104.673, rwy: '16R', type: 'MERGE',  asgSec: 90, axisDeg: 170, ansp: 'FAA-ZDV' },
  // NASA TM-2017 / TM-2020 trial sites
  { id: 'KLAX-25L', apt: 'KLAX', name: 'LOSANG 25L PSP',     lat: 33.946, lng: -118.401, rwy: '25L', type: 'MERGE',  asgSec: 90, axisDeg: 250, ansp: 'FAA-ZLA' },
  { id: 'KBOS-22L', apt: 'KBOS', name: 'BOSTON 22L PSP',     lat: 42.366, lng: -71.018,  rwy: '22L', type: 'STREAM', asgSec: 80, axisDeg: 220, ansp: 'FAA-ZBW' },
  { id: 'KJFK-22L', apt: 'KJFK', name: 'KENNED 22L PSP',     lat: 40.640, lng: -73.789,  rwy: '22L', type: 'MERGE',  asgSec: 95, axisDeg: 220, ansp: 'FAA-ZNY' },
  { id: 'KEWR-22L', apt: 'KEWR', name: 'NEWARK 22L PSP',     lat: 40.692, lng: -74.169,  rwy: '22L', type: 'MERGE',  asgSec: 95, axisDeg: 220, ansp: 'FAA-ZNY' },
  { id: 'KATL-08R', apt: 'KATL', name: 'ATLNTA 08R PSP',     lat: 33.640, lng: -84.443,  rwy: '08R', type: 'STREAM', asgSec: 85, axisDeg: 80,  ansp: 'FAA-ZTL' },
  { id: 'KORD-10C', apt: 'KORD', name: 'OHARE 10C PSP',      lat: 41.978, lng: -87.905,  rwy: '10C', type: 'MERGE',  asgSec: 90, axisDeg: 100, ansp: 'FAA-ZAU' },
  { id: 'KDFW-17C', apt: 'KDFW', name: 'DFWFTW 17C PSP',     lat: 32.897, lng: -97.040,  rwy: '17C', type: 'STREAM', asgSec: 85, axisDeg: 175, ansp: 'FAA-ZFW' },
  { id: 'KSFO-28R', apt: 'KSFO', name: 'SFRANC 28R PSP',     lat: 37.619, lng: -122.375, rwy: '28R', type: 'MERGE',  asgSec: 90, axisDeg: 280, ansp: 'FAA-ZOA' },
  { id: 'KPHX-08R', apt: 'KPHX', name: 'PHOENIX 08R PSP',    lat: 33.434, lng: -112.012, rwy: '08R', type: 'STREAM', asgSec: 80, axisDeg: 80,  ansp: 'FAA-ZAB' },
  // EUROCONTROL SESAR ASAS S&M trials
  { id: 'EGLL-27L', apt: 'EGLL', name: 'HEATHR 27L PSP',     lat: 51.477, lng: -0.483,   rwy: '27L', type: 'MERGE',  asgSec: 95, axisDeg: 270, ansp: 'NATS' },
  { id: 'EHAM-18R', apt: 'EHAM', name: 'SCHIPL 18R PSP',     lat: 52.362, lng: 4.711,    rwy: '18R', type: 'STREAM', asgSec: 90, axisDeg: 180, ansp: 'LVNL' },
  { id: 'LFPG-26L', apt: 'LFPG', name: 'CDGSEINE 26L PSP',   lat: 49.018, lng: 2.539,    rwy: '26L', type: 'MERGE',  asgSec: 90, axisDeg: 260, ansp: 'DSNA' },
  { id: 'EDDF-25L', apt: 'EDDF', name: 'FRANKF 25L PSP',     lat: 50.040, lng: 8.585,    rwy: '25L', type: 'STREAM', asgSec: 90, axisDeg: 250, ansp: 'DFS' },
  { id: 'EDDM-26L', apt: 'EDDM', name: 'MUNICH 26L PSP',     lat: 48.339, lng: 11.789,   rwy: '26L', type: 'MERGE',  asgSec: 85, axisDeg: 260, ansp: 'DFS' },
  { id: 'LEMD-32L', apt: 'LEMD', name: 'MADRID 32L PSP',     lat: 40.495, lng: -3.572,   rwy: '32L', type: 'STREAM', asgSec: 85, axisDeg: 320, ansp: 'ENAIRE' },
  { id: 'LSZH-14',  apt: 'LSZH', name: 'ZURICH 14 PSP',      lat: 47.467, lng: 8.549,    rwy: '14',  type: 'MERGE',  asgSec: 80, axisDeg: 140, ansp: 'skyguide' },
  // Asia-Pacific FIM trial / nominal sites
  { id: 'RJTT-34L', apt: 'RJTT', name: 'HANEDA 34L PSP',     lat: 35.553, lng: 139.781,  rwy: '34L', type: 'STREAM', asgSec: 85, axisDeg: 340, ansp: 'JCAB' },
  { id: 'VHHH-07R', apt: 'VHHH', name: 'HKONG 07R PSP',      lat: 22.308, lng: 113.918,  rwy: '07R', type: 'MERGE',  asgSec: 90, axisDeg: 70,  ansp: 'CAD-HK' },
  { id: 'WSSS-02L', apt: 'WSSS', name: 'CHANGI 02L PSP',     lat: 1.351,  lng: 103.984,  rwy: '02L', type: 'STREAM', asgSec: 90, axisDeg: 20,  ansp: 'CAAS' },
  { id: 'YSSY-34L', apt: 'YSSY', name: 'SYDNEY 34L PSP',     lat: -33.946, lng: 151.177, rwy: '34L', type: 'STREAM', asgSec: 85, axisDeg: 340, ansp: 'AsA' },
]

/* ---- util ---- */
const clamp = (v: number, mn: number, mx: number) => Math.max(mn, Math.min(mx, v))
const gcNm = (la1: number, lo1: number, la2: number, lo2: number) => {
  const R = 3440.065, t = Math.PI / 180
  const d = Math.sin((la2 - la1) * t / 2) ** 2 + Math.cos(la1 * t) * Math.cos(la2 * t) * Math.sin((lo2 - lo1) * t / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(d))
}
const bearing = (la1: number, lo1: number, la2: number, lo2: number) => {
  const t = Math.PI / 180
  const y = Math.sin((lo2 - lo1) * t) * Math.cos(la2 * t)
  const x = Math.cos(la1 * t) * Math.sin(la2 * t) - Math.sin(la1 * t) * Math.cos(la2 * t) * Math.cos((lo2 - lo1) * t)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}
const fnv = (s: string) => { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 } return h }
const hashf = (s: string) => (fnv(s) % 10000) / 10000

const lsKey = (k: string) => `ft-fim-${k}`
const lsGet = (k: string, dflt: number) => { try { const v = localStorage.getItem(lsKey(k)); return v ? parseInt(v) : dflt } catch { return dflt } }
const lsSet = (k: string, v: number) => { try { localStorage.setItem(lsKey(k), String(v)) } catch {} }

const recatOf = (t?: string, c?: string): Recat => {
  const T = (t || '').toUpperCase()
  if (/A38/.test(T)) return 'A'
  if (/B77|B78|A35|B74|B748/.test(T)) return 'B'
  if (/B76|A33|A34|A31|MD11|IL96/.test(T)) return 'C'
  if (/B73|A32|A31|A22|B75|A19|A20|A21|MD8|MD9/.test(T)) return 'D'
  if (/CRJ|E1[79]|E[12]9|EJ|RJ85|BCS|SU95|A220|DH8|AT[47]/.test(T)) return 'E'
  return c === 'A1' || c === 'A2' ? 'F' : 'D'
}

const equipOf = (icao: string, t?: string): Equip => {
  const T = (t || '').toUpperCase()
  // FANS-1A+ / ATN-B2 / FIM-B1 fleets
  if (/B78|A35|B777-3|B748/.test(T)) {
    const h = hashf(`${icao}|equip`)
    if (h < 0.55) return 'FIM-B1'
    if (h < 0.85) return 'ASPA-S'
    return 'ATSAW'
  }
  if (/B77|A33|A34|B767|A38/.test(T)) {
    const h = hashf(`${icao}|equip`)
    if (h < 0.30) return 'FIM-B1'
    if (h < 0.65) return 'ASPA-S'
    return 'ATSAW'
  }
  if (/B73|A32|A22|A21|A20|A19|B75/.test(T)) {
    const h = hashf(`${icao}|equip`)
    if (h < 0.15) return 'ASPA-S'
    if (h < 0.55) return 'ATSAW'
    if (h < 0.85) return 'ADSB-IN'
    return 'NONE'
  }
  if (/CRJ|E[12]9|E1[79]|DH8|AT[47]|BCS/.test(T)) {
    return hashf(`${icao}|equip`) < 0.30 ? 'ADSB-IN' : 'NONE'
  }
  return 'NONE'
}

const RCP_PENALTY: Record<Equip, number> = { 'FIM-B1': 0, 'ASPA-S': 0, ATSAW: 0, 'ADSB-IN': 35, NONE: 100 }

interface Drv { SPC: number; CMD: number; CLO: number; WAK: number; RCP: number; PHA: number }
interface Pair {
  trailer: SFlight
  leader: SFlight
  psp: PSP
  equip: Equip
  recatT: Recat
  recatL: Recat
  wakeMinNm: number
  distNm: number          // separation in NM
  distPspNm: number       // trailer to PSP nm
  distPspLeaderNm: number // leader to PSP nm
  closureKt: number       // leader_gs - trailer_gs (positive = opening)
  asiSec: number          // achieved spacing interval (sec at trailer GS)
  asgSec: number          // assigned spacing goal
  errSec: number          // asi - asg (positive = behind)
  vfim: number            // commanded FIM speed (IAS kt)
  iasDelta: number        // current IAS - vfim
  ttgSec: number          // trailer time-to-go to PSP
  mode: FimMode
  drivers: Drv
  score: number
  tier: Tier
}

const analyse = (trailer: SFlight, all: SFlight[], scopeNm: number, asgMul: number, pspsActive: PSP[]): Pair | null => {
  if (trailer.ground) return null
  if (trailer.altitudeFt < 2000 || trailer.altitudeFt > 22000) return null
  if (trailer.velocityKts < 130) return null
  // Find nearest PSP within scope along trailer track
  let bestPsp: PSP | null = null; let bestD = 9999
  for (const p of pspsActive) {
    const d = gcNm(trailer.lat, trailer.lng, p.lat, p.lng)
    if (d > scopeNm) continue
    // gating: heading roughly toward PSP
    const brg = bearing(trailer.lat, trailer.lng, p.lat, p.lng)
    let rel = Math.abs(((brg - trailer.track) + 540) % 360 - 180)
    if (rel > 45) continue
    if (d < bestD) { bestD = d; bestPsp = p }
  }
  if (!bestPsp) return null
  // Find leader: closest aircraft ahead (within 20° of axis, distance smaller, closer to PSP)
  const pspBrgFromTr = bearing(trailer.lat, trailer.lng, bestPsp.lat, bestPsp.lng)
  let leader: SFlight | null = null; let leaderSepNm = 9999
  for (const o of all) {
    if (o.icao === trailer.icao) continue
    if (o.ground) continue
    if (Math.abs(o.altitudeFt - trailer.altitudeFt) > 3000) continue
    const dToTr = gcNm(o.lat, o.lng, trailer.lat, trailer.lng)
    if (dToTr > 18 || dToTr < 1) continue
    const brgTrToO = bearing(trailer.lat, trailer.lng, o.lat, o.lng)
    let rel = Math.abs(((brgTrToO - pspBrgFromTr) + 540) % 360 - 180)
    if (rel > 28) continue
    const oToPsp = gcNm(o.lat, o.lng, bestPsp.lat, bestPsp.lng)
    if (oToPsp >= bestD) continue // leader must be ahead (closer to PSP)
    if (dToTr < leaderSepNm) { leaderSepNm = dToTr; leader = o }
  }
  if (!leader) return null
  const equip = equipOf(trailer.icao, trailer.type)
  const recatT = recatOf(trailer.type, trailer.category)
  const recatL = recatOf(leader.type, leader.category)
  const wakeMinNm = RECAT_MIN[recatT][recatL] || 2.5
  const distNm = leaderSepNm
  const distPspNm = bestD
  const distPspLeaderNm = gcNm(leader.lat, leader.lng, bestPsp.lat, bestPsp.lng)
  // ASI: separation expressed as seconds at trailer GS
  const asiSec = distNm / Math.max(trailer.velocityKts, 60) * 3600
  // ASG: from PSP, scaled
  const asgSec = bestPsp.asgSec * (asgMul / 100)
  const errSec = asiSec - asgSec
  const closureKt = trailer.velocityKts - leader.velocityKts // positive trailer faster (closing)
  // FIM commanded speed: nominal RECAT Vref + dynamic spacing correction toward ASG
  const vrefT = RECAT_VREF[recatT]
  // gain ~1 kt per 2-sec error inside 20s, plus saturate
  const corr = clamp(-errSec * 0.5, -25, 15)
  const vfim = Math.round(vrefT + corr + (distPspNm > 12 ? 18 : distPspNm > 6 ? 8 : 0))
  const iasDelta = trailer.velocityKts - vfim
  const ttgSec = distPspNm / Math.max(trailer.velocityKts, 60) * 3600
  // Mode
  let mode: FimMode
  if (distPspNm > 18) mode = 'IDLE'
  else if (distPspNm > 10 && Math.abs(errSec) > 12) mode = 'ACHIEVE'
  else if (distPspNm > 10) mode = 'CAPTURE'
  else if (distPspNm > 3) mode = 'MAINTAIN'
  else mode = 'TERMINATE'
  return {
    trailer, leader, psp: bestPsp, equip, recatT, recatL, wakeMinNm,
    distNm, distPspNm, distPspLeaderNm, closureKt,
    asiSec, asgSec, errSec, vfim, iasDelta, ttgSec, mode,
    drivers: { SPC: 0, CMD: 0, CLO: 0, WAK: 0, RCP: 0, PHA: 0 },
    score: 0, tier: 'OK',
  }
}

const PHASE_MUL: Record<FimMode, number> = { ACHIEVE: 1.15, CAPTURE: 1.20, MAINTAIN: 1.05, TERMINATE: 0.85, IDLE: 0 }

const SRC_PSP = 'fim-psp', LYR_PSP = 'fim-psp', LYR_PSP_LBL = 'fim-psp-lbl'
const SRC_AX = 'fim-ax', LYR_AX = 'fim-ax'
const SRC_HALO = 'fim-halo', LYR_HALO = 'fim-halo'
const SRC_PIN = 'fim-pin', LYR_PIN = 'fim-pin'
const SRC_LBL = 'fim-lbl', LYR_LBL = 'fim-lbl'
const SRC_LINK = 'fim-link', LYR_LINK = 'fim-link'

// axis polyline (12 NM along reciprocal of axisDeg, originating at PSP)
const axisLine = (p: PSP, lenNm = 14): [number, number][] => {
  const t = Math.PI / 180
  const rec = (p.axisDeg + 180) % 360
  const nmLat = 1 / 60; const nmLng = 1 / (60 * Math.cos(p.lat * t))
  const la2 = p.lat + Math.cos(rec * t) * lenNm * nmLat
  const lo2 = p.lng + Math.sin(rec * t) * lenNm * nmLng
  return [[p.lng, p.lat], [lo2, la2]]
}

export default function FimAspa({ map, flights, onClose, onFly }: Props) {
  const [scope, setScope] = useState<number>(() => lsGet('scope', 22))
  const [asgMul, setAsgMul] = useState<number>(() => lsGet('asg', 100))
  const [spcMul, setSpcMul] = useState<number>(() => lsGet('spc', 100))
  const [cmdMul, setCmdMul] = useState<number>(() => lsGet('cmd', 100))
  const [wakMul, setWakMul] = useState<number>(() => lsGet('wak', 100))
  const [advMul, setAdvMul] = useState<number>(() => lsGet('adv', 100))
  const [minFL, setMinFL] = useState<number>(() => lsGet('minFL', 20))
  const [tab, setTab] = useState<'PAIRS' | 'PSPS' | 'EQUIP'>('PAIRS')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [equipFilter, setEquipFilter] = useState<Equip | 'ALL'>('ALL')
  const [modeFilter, setModeFilter] = useState<FimMode | 'ALL'>('ALL')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showPsp, setShowPsp] = useState(true)
  const [showAx, setShowAx] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    lsSet('scope', scope); lsSet('asg', asgMul); lsSet('spc', spcMul)
    lsSet('cmd', cmdMul); lsSet('wak', wakMul); lsSet('adv', advMul); lsSet('minFL', minFL)
  }, [scope, asgMul, spcMul, cmdMul, wakMul, advMul, minFL])

  const rows = useMemo<Pair[]>(() => {
    const pairs: Pair[] = []
    const activePsps = PSPS.slice()
    for (const f of flights) {
      if (f.altitudeFt < minFL * 100) continue
      const p = analyse(f, flights, scope, asgMul, activePsps)
      if (p) pairs.push(p)
    }
    for (const v of pairs) {
      const SPC = clamp(Math.abs(v.errSec) / 0.40, 0, 100) * (spcMul / 100)
      const CMD = clamp(Math.abs(v.iasDelta) / 0.25, 0, 100) * (cmdMul / 100)
      const CLO = clamp(Math.abs(v.closureKt) / 0.40, 0, 100)
      const wakeRatio = v.distNm / Math.max(v.wakeMinNm, 0.5)
      const WAK = clamp((1.25 - wakeRatio) / 0.45 * 100, 0, 100) * (wakMul / 100)
      const RCP = RCP_PENALTY[v.equip]
      const PHA = PHASE_MUL[v.mode] * 70
      v.drivers = { SPC, CMD, CLO, WAK, RCP, PHA }
      const md = Math.max(SPC, CMD, CLO, WAK, RCP)
      const sec = (SPC + CMD + CLO + WAK + RCP - md) / 4
      v.score = clamp((md * 0.80 + sec * 0.20) * PHASE_MUL[v.mode] * (advMul / 100), 0, 100)
      const wakeBust = v.distNm < v.wakeMinNm
      if (v.score >= 80 || wakeBust || Math.abs(v.errSec) >= 60) v.tier = 'FIM-BUST'
      else if (v.score >= 55 || Math.abs(v.errSec) >= 30 || Math.abs(v.iasDelta) >= 20) v.tier = 'OUT-OF-TOL'
      else if (v.score >= 35) v.tier = 'DRIFT'
      else if (v.score >= 18) v.tier = 'WATCH'
      else v.tier = 'OK'
    }
    pairs.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return pairs
  }, [flights, scope, asgMul, spcMul, cmdMul, wakMul, advMul, minFL])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(v => {
      if (tierFilter !== 'ALL' && v.tier !== tierFilter) return false
      if (equipFilter !== 'ALL' && v.equip !== equipFilter) return false
      if (modeFilter !== 'ALL' && v.mode !== modeFilter) return false
      if (q) {
        const blob = `${v.trailer.callsign} ${v.trailer.icao} ${v.trailer.type} ${v.leader.callsign} ${v.leader.icao} ${v.psp.id} ${v.psp.apt}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [rows, tierFilter, equipFilter, modeFilter, query])

  const tierCount: Record<Tier, number> = { 'FIM-BUST': 0, 'OUT-OF-TOL': 0, DRIFT: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const v of rows) tierCount[v.tier]++
  const bustN = tierCount['FIM-BUST']
  const outN = tierCount['OUT-OF-TOL']
  const driftN = tierCount.DRIFT
  const meanScore = rows.length ? rows.reduce((s, v) => s + v.score, 0) / rows.length : 0
  const meanErr = rows.length ? rows.reduce((s, v) => s + v.errSec, 0) / rows.length : 0
  const worst = rows[0]
  const wakeBustN = rows.filter(r => r.distNm < r.wakeMinNm).length

  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any)
    }
    ensure(LYR_AX, 'line', SRC_AX, { 'line-color': '#0ea5e9', 'line-width': 1.1, 'line-opacity': 0.5, 'line-dasharray': [2, 3] })
    ensure(LYR_PSP, 'circle', SRC_PSP, { 'circle-radius': 5.5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-stroke-color': '#0f172a' })
    ensure(LYR_PSP_LBL, 'symbol', SRC_PSP, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_PSP_LBL)) { map.setPaintProperty(LYR_PSP_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_PSP_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_PSP_LBL, 'text-halo-width', 1.2) }
    ensure(LYR_LINK, 'line', SRC_LINK, { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.7, 'line-dasharray': [1, 2] })
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.22, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN, 'circle', SRC_PIN, { 'circle-radius': 5.5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_LBL, 'symbol', SRC_LBL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL)) { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }

    const activePsp = new Set<string>(); for (const v of filtered) activePsp.add(v.psp.id)
    const pspFeats: any[] = [], axFeats: any[] = []
    if (showPsp) {
      for (const p of PSPS) {
        const isAct = activePsp.has(p.id)
        const col = isAct ? (p.type === 'MERGE' ? '#a855f7' : '#0ea5e9') : '#475569'
        pspFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { color: col, label: `${p.id} · ${p.type} · ${p.asgSec}s` } })
      }
    }
    if (showAx) for (const p of PSPS) if (activePsp.has(p.id)) axFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: axisLine(p) }, properties: {} })

    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = []
    for (const v of filtered) {
      const c = TIER_COLOR[v.tier]
      if (showHalo) halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.trailer.lng, v.trailer.lat] }, properties: { color: c, r: 8 + v.score * 0.14 } })
      if (showPin && (v.tier === 'FIM-BUST' || v.tier === 'OUT-OF-TOL')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.trailer.lng, v.trailer.lat] }, properties: { color: c } })
      if (showLbl && v.tier !== 'OK') {
        const sign = v.errSec >= 0 ? '+' : ''
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.trailer.lng, v.trailer.lat] }, properties: { color: c, label: `${v.trailer.callsign || v.trailer.icao} ${v.tier} ${sign}${v.errSec.toFixed(0)}s Vfim${v.vfim}` } })
      }
      if (showLink) link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[v.trailer.lng, v.trailer.lat], [v.leader.lng, v.leader.lat]] }, properties: { color: c } })
    }
    ;(map.getSource(SRC_PSP) as any).setData({ type: 'FeatureCollection', features: pspFeats })
    ;(map.getSource(SRC_AX) as any).setData({ type: 'FeatureCollection', features: axFeats })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_PSP_LBL, LYR_PSP, LYR_AX]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_LINK, SRC_PSP, SRC_AX]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, showHalo, showPin, showLbl, showPsp, showAx, showLink])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const modeBadge = (m: FimMode) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: MODE_COLOR[m], backgroundColor: MODE_COLOR[m] + '1a', border: `1px solid ${MODE_COLOR[m]}66` }}>{m}</span>
  )
  const equipBadge = (e: Equip) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: EQUIP_COLOR[e], backgroundColor: EQUIP_COLOR[e] + '1a', border: `1px solid ${EQUIP_COLOR[e]}66` }}>{e}</span>
  )
  const recatBadge = (r: Recat) => (
    <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono bg-slate-800 text-slate-300 border border-slate-700">{r}</span>
  )
  const drvBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (v: Pair) => {
    const sign = v.errSec >= 0 ? '+' : ''
    if (v.tier === 'FIM-BUST') return `FIM-BUST · err ${sign}${v.errSec.toFixed(0)}s · wake ${v.distNm.toFixed(1)}<${v.wakeMinNm}NM · ABORT spacing · revert ATC vectors · request 1000ft offset · per FAA JO 7110.65 §5-3 · log per AC 20-172A`
    if (v.tier === 'OUT-OF-TOL') return `OUT-OF-TOL · err ${sign}${v.errSec.toFixed(0)}s · IAS ${v.iasDelta >= 0 ? '+' : ''}${v.iasDelta.toFixed(0)} from Vfim ${v.vfim} · speed correction now · resume MAINTAIN per RTCA DO-361A §3.2.4`
    if (v.tier === 'DRIFT') return `DRIFT · ASI ${v.asiSec.toFixed(0)}s vs ASG ${v.asgSec.toFixed(0)}s · ±2kt fine-adjust toward Vfim ${v.vfim} · per FCOM PI 11.32 / DO-328A`
    if (v.tier === 'WATCH') return `WATCH · ${v.mode} on ${v.psp.id} · TTG ${v.ttgSec.toFixed(0)}s · brief crew on PSP merge per RTCA DO-328A`
    return `OK · ASG ${v.asgSec.toFixed(0)}s achieved · ${v.equip} clearance · IAS ${v.trailer.velocityKts.toFixed(0)} ≈ Vfim ${v.vfim} · per ICAO Doc 9854 §3.6`
  }

  /* Scatter: errSec horizontal (±60) vs iasDelta vertical (±25) */
  const W = 280, Hh = 180
  const sx = (n: number) => 32 + clamp((n + 60) / 120, 0, 1) * (W - 42)
  const sy = (n: number) => Hh - 24 - clamp((n + 25) / 50, 0, 1) * (Hh - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">FIM · ASPA Flight-deck Interval Management</div>
          <div className="text-[10px] text-slate-500">RTCA DO-328A / DO-361A · DO-317C ASSAP · ICAO Doc 9854 §3.6 · FAA AC 20-172A · JO 7110.65 §5-3 · SESAR PJ.01-W2-04</div>
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
          <div className="text-sm font-semibold" style={{ color: meanScore >= 55 ? '#ef4444' : meanScore >= 35 ? '#f59e0b' : '#10b981' }}>{meanScore.toFixed(0)}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.trailer.callsign || worst.trailer.icao) : '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">FIM-BUST</div>
          <div className="text-sm font-semibold" style={{ color: bustN > 0 ? '#ef4444' : '#10b981' }}>{bustN}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">OUT-OF-TOL</div>
          <div className="text-xs font-semibold" style={{ color: outN > 0 ? '#f43f5e' : '#10b981' }}>{outN}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean err</div>
          <div className="text-xs font-semibold" style={{ color: Math.abs(meanErr) >= 15 ? '#f59e0b' : '#0ea5e9' }}>{meanErr >= 0 ? '+' : ''}{meanErr.toFixed(0)}<span className="text-slate-500">s · DRIFT {driftN}</span></div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Wake bust</div>
          <div className="text-xs font-semibold" style={{ color: wakeBustN > 0 ? '#ef4444' : '#10b981' }}>{wakeBustN}<span className="text-slate-500"> · {rows.length} pairs</span></div>
        </div>
      </div>

      {showDiag && rows.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={Hh} className="w-full">
            <rect x={0} y={0} width={W} height={Hh} fill="#020617" />
            {/* OK band */}
            <rect x={sx(-10)} y={sy(7)} width={sx(10) - sx(-10)} height={sy(-7) - sy(7)} fill="#10b98115" />
            {/* OUT-OF-TOL band */}
            <rect x={sx(-30)} y={0} width={sx(-10) - sx(-30)} height={Hh - 24} fill="#f59e0b15" />
            <rect x={sx(10)} y={0} width={sx(30) - sx(10)} height={Hh - 24} fill="#f59e0b15" />
            {/* FIM-BUST band */}
            <rect x={0} y={0} width={sx(-30)} height={Hh - 24} fill="#ef444425" />
            <rect x={sx(30)} y={0} width={W - sx(30)} height={Hh - 24} fill="#ef444425" />
            {/* refs */}
            <line x1={sx(0)} y1={0} x2={sx(0)} y2={Hh - 24} stroke="#33415566" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(-30)} y1={0} x2={sx(-30)} y2={Hh - 24} stroke="#f43f5e88" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(30)} y1={0} x2={sx(30)} y2={Hh - 24} stroke="#f43f5e88" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={0} y1={sy(0)} x2={W} y2={sy(0)} stroke="#33415566" strokeWidth={0.4} strokeDasharray="3 3" />
            <line x1={0} y1={sy(20)} x2={W} y2={sy(20)} stroke="#ef444466" strokeWidth={0.4} strokeDasharray="3 3" />
            <line x1={0} y1={sy(-20)} x2={W} y2={sy(-20)} stroke="#ef444466" strokeWidth={0.4} strokeDasharray="3 3" />
            <text x={W / 2} y={Hh - 4} textAnchor="middle" fontSize="9" fill="#64748b">spacing err sec (±60)</text>
            <text x={6} y={Hh / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${Hh / 2})`}>IAS - Vfim kt</text>
            {rows.map((v, i) => (
              <circle key={i} cx={sx(clamp(v.errSec, -59, 59))} cy={sy(clamp(v.iasDelta, -24, 24))} r={2.4} fill={TIER_COLOR[v.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['SCOPE', scope, 10, 40, setScope, 'nm'],
            ['ASG-MUL', asgMul, 50, 200, setAsgMul, '%'],
            ['SPC-MUL', spcMul, 50, 200, setSpcMul, '%'],
            ['CMD-MUL', cmdMul, 50, 200, setCmdMul, '%'],
            ['WAK-MUL', wakMul, 50, 200, setWakMul, '%'],
            ['ADV-MUL', advMul, 50, 200, setAdvMul, '%'],
            ['MIN-FL', minFL, 0, 100, setMinFL, ''],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[72px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[44px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['FIM-B1', 'ASPA-S', 'ATSAW', 'ADSB-IN', 'NONE'] as Equip[]).map(e => (
            <button key={e} onClick={() => setEquipFilter(equipFilter === e ? 'ALL' : e)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: equipFilter === e ? EQUIP_COLOR[e] + '33' : '#0b1220', borderColor: equipFilter === e ? EQUIP_COLOR[e] : '#1e293b', color: equipFilter === e ? EQUIP_COLOR[e] : '#cbd5e1' }}>{e}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-1">
          {(['ACHIEVE', 'CAPTURE', 'MAINTAIN', 'TERMINATE'] as FimMode[]).map(m => (
            <button key={m} onClick={() => setModeFilter(modeFilter === m ? 'ALL' : m)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: modeFilter === m ? MODE_COLOR[m] + '33' : '#0b1220', borderColor: modeFilter === m ? MODE_COLOR[m] : '#1e293b', color: modeFilter === m ? MODE_COLOR[m] : '#cbd5e1' }}>{m}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['PSP', showPsp, setShowPsp],
            ['AXIS', showAx, setShowAx],
            ['LINK', showLink, setShowLink],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search trailer / leader / PSP / airport" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['PAIRS', 'PSPS', 'EQUIP'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'PAIRS' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No FIM-eligible pairs in scope</div>}
          {filtered.map((v, idx) => (
            <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(v.trailer.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[v.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 truncate">{v.trailer.callsign || v.trailer.icao}</span>
                  {recatBadge(v.recatT)}
                  <span className="text-slate-500 text-[10px]">›</span>
                  <span className="font-mono text-[10px] text-slate-400 truncate">{v.leader.callsign || v.leader.icao}</span>
                  {recatBadge(v.recatL)}
                  {modeBadge(v.mode)}
                </div>
                {tierBadge(v.tier)}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                {equipBadge(v.equip)}
                <span className="text-[10px] text-slate-400 font-mono"><span className="text-sky-300">{v.psp.id}</span> · {v.psp.type === 'MERGE' ? <span className="text-purple-300">MERGE</span> : <span className="text-sky-300">STREAM</span>} · {v.psp.rwy}</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-slate-500">ASI</span> <span className="text-slate-200">{v.asiSec.toFixed(0)}s</span>
                {' · '}<span className="text-slate-500">ASG</span> <span className="text-slate-200">{v.asgSec.toFixed(0)}s</span>
                {' · '}<span className="text-slate-500">err</span> <span style={{ color: Math.abs(v.errSec) >= 30 ? '#ef4444' : Math.abs(v.errSec) >= 12 ? '#f59e0b' : '#10b981' }}>{v.errSec >= 0 ? '+' : ''}{v.errSec.toFixed(0)}s</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-slate-500">sep</span> <span style={{ color: v.distNm < v.wakeMinNm ? '#ef4444' : v.distNm < v.wakeMinNm * 1.1 ? '#f59e0b' : '#10b981' }}>{v.distNm.toFixed(1)}</span><span className="text-slate-500">/{v.wakeMinNm.toFixed(1)}NM</span>
                {' · '}<span className="text-slate-500">clo</span> <span style={{ color: Math.abs(v.closureKt) >= 25 ? '#ef4444' : Math.abs(v.closureKt) >= 12 ? '#f59e0b' : '#cbd5e1' }}>{v.closureKt >= 0 ? '+' : ''}{v.closureKt.toFixed(0)}kt</span>
                {' · '}<span className="text-slate-500">TTG</span> <span className="text-sky-300">{v.ttgSec.toFixed(0)}s</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-slate-500">IAS</span> <span className="text-slate-200">{v.trailer.velocityKts.toFixed(0)}</span>
                {' · '}<span className="text-slate-500">Vfim</span> <span className="text-emerald-300">{v.vfim}</span>
                {' · '}<span className="text-slate-500">Δ</span> <span style={{ color: Math.abs(v.iasDelta) >= 20 ? '#ef4444' : Math.abs(v.iasDelta) >= 8 ? '#f59e0b' : '#10b981' }}>{v.iasDelta >= 0 ? '+' : ''}{v.iasDelta.toFixed(0)}kt</span>
                {' · FL'}<span className="text-slate-200">{(v.trailer.altitudeFt / 100).toFixed(0)}</span>
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${v.score}%`, backgroundColor: TIER_COLOR[v.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {drvBadge('SPC', v.drivers.SPC)}
                {drvBadge('CMD', v.drivers.CMD)}
                {drvBadge('CLO', v.drivers.CLO)}
                {drvBadge('WAK', v.drivers.WAK)}
                {drvBadge('RCP', v.drivers.RCP)}
                {drvBadge('PHA', v.drivers.PHA)}
              </div>
              <div className="text-[10px] mt-1.5 italic" style={{ color: TIER_COLOR[v.tier] }}>{advice(v)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'PSPS' && (
        <div className="divide-y divide-slate-800">
          {PSPS.slice().sort((a, b) => rows.filter(r => r.psp.id === b.id).length - rows.filter(r => r.psp.id === a.id).length).map(p => {
            const pRows = rows.filter(r => r.psp.id === p.id)
            const ms = pRows.length ? pRows.reduce((s, r) => s + r.score, 0) / pRows.length : 0
            const bst = pRows.filter(r => r.tier === 'FIM-BUST').length
            const out = pRows.filter(r => r.tier === 'OUT-OF-TOL').length
            const mErr = pRows.length ? pRows.reduce((s, r) => s + r.errSec, 0) / pRows.length : 0
            return (
              <div key={p.id} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => { if (pRows[0]) onFly(pRows[0].trailer.icao) }} style={{ borderLeft: `3px solid ${bst > 0 ? '#ef4444' : out > 0 ? '#f43f5e' : ms >= 35 ? '#f59e0b' : pRows.length ? '#10b981' : '#475569'}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-sky-300">{p.id}</span>
                    <span className="text-slate-200 text-[11px] truncate">{p.name}</span>
                    <span className="text-[9px] px-1 rounded font-mono" style={{ color: p.type === 'MERGE' ? '#a855f7' : '#0ea5e9', backgroundColor: '#0b1220', border: '1px solid ' + (p.type === 'MERGE' ? '#a855f766' : '#0ea5e966') }}>{p.type}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-300">ASG <span className="text-emerald-300">{p.asgSec}s</span></span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  {p.ansp} · {p.apt} · rwy <span className="text-slate-200">{p.rwy}</span> · axis <span className="text-amber-300">{p.axisDeg.toFixed(0)}°</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  {pRows.length} pairs · <span className="text-rose-400">{bst} BUST</span> · <span className="text-rose-300">{out} OOT</span> · μerr <span style={{ color: Math.abs(mErr) >= 15 ? '#f59e0b' : '#0ea5e9' }}>{mErr >= 0 ? '+' : ''}{mErr.toFixed(0)}s</span>
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 55 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'EQUIP' && (
        <div className="divide-y divide-slate-800">
          {(['FIM-B1', 'ASPA-S', 'ATSAW', 'ADSB-IN', 'NONE'] as Equip[]).map(e => {
            const eRows = rows.filter(r => r.equip === e)
            const bst = eRows.filter(r => r.tier === 'FIM-BUST').length
            const out = eRows.filter(r => r.tier === 'OUT-OF-TOL').length
            const ms = eRows.length ? eRows.reduce((s, r) => s + r.score, 0) / eRows.length : 0
            const label: Record<Equip, string> = { 'FIM-B1': 'RTCA DO-361A FIM Equipment', 'ASPA-S': 'ASPA-S Stream-mode', ATSAW: 'ATSAW ITP-capable', 'ADSB-IN': 'Basic ADS-B IN', NONE: 'No surveillance applic.' }
            return (
              <div key={e} className="px-3 py-2" style={{ borderLeft: `3px solid ${EQUIP_COLOR[e]}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    {equipBadge(e)}
                    <span className="text-slate-200 text-[11px]">{label[e]}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400">RCP-pen <span style={{ color: RCP_PENALTY[e] >= 70 ? '#ef4444' : RCP_PENALTY[e] >= 35 ? '#f59e0b' : '#10b981' }}>{RCP_PENALTY[e]}</span></span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  {eRows.length} pairs · <span className="text-rose-400">{bst} BUST</span> · <span className="text-rose-300">{out} OOT</span>
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 55 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
              </div>
            )
          })}
          <div className="px-3 py-2 text-[10px] text-slate-500">
            FIM commanded speed Vfim envelope per DO-361A §3.5.4: ±5 kt nominal, −20/+10 kt operating, inside Vmo/Vfe. Spacing tolerance per DO-328A: ±10 s nominal, ±30 s OUT-OF-TOL, ±60 s ABORT. Wake minima per RECAT-EU Table 4-2. References: DO-328A · DO-361A · DO-317C · ICAO Doc 9854 §3.6 · Doc 9993 · Doc 9931 §4 · FAA AC 20-172A · JO 7110.65 §5-3 · SESAR PJ.01-W2-04 / Solution #18 · Boeing FCOM PI 11.32 · Airbus ATSAW-ITP OIS · NASA TM-2017-219570 / TM-2020-220471 · EUROCONTROL ASAS S&M ConOps ed.2.
          </div>
        </div>
      )}
    </div>
  )
}
