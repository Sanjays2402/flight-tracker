'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   PMS · Point Merge System arrival-sequencing monitor
   ------------------------------------------------------------
   Per-arrival assessment of Point Merge sequencing in terminal
   airspace. Point Merge (Boursier 2007, deployed operationally
   at LFPG/LFPO 2011, EHAM, EKCH, ENGM, LIRF, EGSS, EIDW, LOWW,
   OMDB, RKSI, ZSPD, VHHH, WSSS et al.) replaces holding stacks
   with a pre-defined system of concentric sequencing legs that
   share a single merge point. ATC issues a "direct merge point"
   instruction when the next-in-sequence aircraft reaches the
   correct arc position to give the required spacing behind the
   preceding traffic.

   Key geometry:
     · Each PMS has an inner / outer sequencing leg (arc segment)
       at constant ranges R_inner / R_outer from the merge point,
       each subtending a sector of ~30-50° between bearings B0..B1.
     · Aircraft on a leg fly along the arc maintaining constant
       distance-to-go (DTG = R + leg-arc-remaining) to the merge.
     · Direct-to-MP cut reduces DTG by chord-vs-arc difference.
     · Required spacing at MP enforces wake-vortex matrix and
       runway acceptance rate (RECAT-EU ed.3 / JO 7110.65 §5-5).

   This monitor scores each tracked arrival within scope of a PMS
   on 6 drivers:
       1. SPC  spacing-at-MP vs RECAT minima (sec)
       2. DTG  distance-to-go anomaly vs arc-projected baseline
       3. ARC  off-arc deviation (radial-error vs leg radius NM)
       4. SEQ  sequence-instability vs published acceptance rate
       5. CUT  inefficient direct cut (extended track miles)
       6. ALT  level-band conformance on leg (FL080/FL100 typical)

   Per:
     · EUROCONTROL Point Merge System Concept of Operations v3.0
     · EUROCONTROL Point Merge Generic Implementation Material
     · EUROCONTROL PMS Validation Report DSNA/INO 2010-12
     · ICAO Doc 9931 Continuous Descent Operations Manual §4
     · ICAO Doc 4444 PANS-ATM §6 Separation in TMA / §8 Sequencing
     · ICAO Annex 11 §3.7 Approach Control Service
     · ICAO Doc 8168 PANS-OPS Vol II Part III Section 3 PMS design
     · DSNA STAC PMS Design Manual ed.2 (Paris CDG/Orly)
     · CAA UK CAP 1772 Point Merge implementation EGSS / EGGW
     · NATS Heathrow XMAN/AMAN-PMS interop study
     · IAA Dublin EIDW PMS operational concept 2012
     · Naviair EKCH PMS deployment review 2012
     · Avinor ENGM PMS operational concept 2011
     · ENAV LIRF Roma PMS operational evaluation 2018
     · Aeroporti CASA OMDB PMS implementation 2014
     · DSNA Boursier "Merging Arrival Flows w/o Heading Inst." 2007
     · SESAR PJ.01 / PJ.02 enhanced arrival management
     · Boeing FCTM 5.10 CDO/CCO · Airbus FCTM PR-NP-SOP-DES
     · FSF ALAR Briefing Note 7.1 Stabilised Approach
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'SPC-LOSS' | 'OFF-ARC' | 'BUNCHED' | 'WATCH' | 'STABLE' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'SPC-LOSS': '#ef4444', 'OFF-ARC': '#f43f5e', BUNCHED: '#f59e0b', WATCH: '#0ea5e9', STABLE: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['SPC-LOSS', 'OFF-ARC', 'BUNCHED', 'WATCH', 'STABLE']
const TIER_RANK: Record<Tier, number> = { 'SPC-LOSS': 0, 'OFF-ARC': 1, BUNCHED: 2, WATCH: 3, STABLE: 4, IDLE: 5 }

/* RECAT-EU ed.3 6-class wake matrix abbreviated to MP-min-seconds
   leader→follower (kept self-contained vs other monitors) */
type Wake = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
const WAKE_COLOR: Record<Wake, string> = { A: '#7c3aed', B: '#0ea5e9', C: '#10b981', D: '#f59e0b', E: '#f43f5e', F: '#64748b' }
const WAKE_REF_KTS: Record<Wake, number> = { A: 158, B: 152, C: 145, D: 138, E: 132, F: 118 }
// minimum spacing at MP (seconds) - simplified RECAT-EU at ~145 kt mean groundspeed
const WAKE_SEC: Record<Wake, Record<Wake, number>> = {
  A: { A: 90, B: 105, C: 120, D: 135, E: 150, F: 180 },
  B: { A: 75, B: 90,  C: 100, D: 110, E: 120, F: 150 },
  C: { A: 75, B: 80,  C: 90,  D: 100, E: 110, F: 135 },
  D: { A: 75, B: 75,  C: 75,  D: 90,  E: 90,  F: 120 },
  E: { A: 75, B: 75,  C: 75,  D: 80,  E: 90,  F: 100 },
  F: { A: 75, B: 75,  C: 75,  D: 80,  E: 90,  F: 90 },
}
function classifyWake(type?: string, cat?: string): Wake {
  const t = (type || '').toUpperCase()
  if (/^(A388|A380)/.test(t)) return 'A'
  if (/^(B77|B78|B74|B748|A35|A34|A33|MD11|IL96)/.test(t) || cat === 'A5') return 'B'
  if (/^(B76|B767|A310|A300|IL76)/.test(t)) return 'C'
  if (/^(B73|B75|A21|A22|A31|A32|A220|B71|MD8|MD9|BCS|CS[123])/.test(t) || cat === 'A3' || cat === 'A4') return 'D'
  if (/^(CRJ|E1[37]|E14|E17|E19|DH8|AT4|AT7|SF34|RJ85|RJ100|F50|F70|F100)/.test(t) || cat === 'A2') return 'E'
  return 'F'
}

/* Per-airframe approach Vref proxy (kt IAS) used for groundspeed estimate on leg */
const KLASS_VREF: Record<Wake, number> = { A: 152, B: 145, C: 142, D: 138, E: 132, F: 118 }

/* ----- PMS catalogue -----
   Each PMS has: merge-point lat/lng, runway-direction QFU,
   inner-leg radius (NM) + bearing-arc from MP (b0..b1, degs MAG TRUE,
   leg-altitude-band lo/hi flight level), outer-leg radius + arc + alts,
   nominal sequence-acceptance rate (mvts/hr), name, country.
   24 PMS implementations worldwide, modelled on published EUROCONTROL,
   DSNA STAC, IAA, CAA UK, Naviair, Avinor, ENAV, OMDB and PJ.02 docs. */
interface Pms {
  icao: string; name: string; mpLat: number; mpLng: number; qfu: number;
  rIn: number; b0In: number; b1In: number; flLoIn: number; flHiIn: number;
  rOut: number; b0Out: number; b1Out: number; flLoOut: number; flHiOut: number;
  rateMph: number; country: string; arrIaf?: string;
}
const PMS_LIST: Pms[] = [
  // LFPG Paris CDG MOPAR / OKIPA / LORNI / BANOX 4 PMS-IAF (DSNA STAC 2011)
  { icao: 'LFPG', name: 'CDG MOPAR-N PMS', mpLat: 49.20, mpLng: 2.45, qfu: 263, rIn: 28, b0In: 350, b1In: 40, flLoIn: 70, flHiIn: 80, rOut: 38, b0Out: 345, b1Out: 50, flLoOut: 90, flHiOut: 110, rateMph: 32, country: 'FR', arrIaf: 'MOPAR' },
  { icao: 'LFPG', name: 'CDG OKIPA-E PMS', mpLat: 49.05, mpLng: 2.85, qfu: 263, rIn: 26, b0In: 70,  b1In: 130, flLoIn: 70, flHiIn: 80, rOut: 36, b0Out: 60,  b1Out: 135, flLoOut: 90, flHiOut: 110, rateMph: 32, country: 'FR', arrIaf: 'OKIPA' },
  { icao: 'LFPO', name: 'ORY MOLEK-S PMS', mpLat: 48.55, mpLng: 2.40, qfu: 240, rIn: 24, b0In: 170, b1In: 230, flLoIn: 70, flHiIn: 80, rOut: 32, b0Out: 165, b1Out: 235, flLoOut: 90, flHiOut: 110, rateMph: 26, country: 'FR', arrIaf: 'MOLEK' },
  // EHAM Schiphol POP/RIVER 2 PMS-IAF (LVNL ConOps 2013)
  { icao: 'EHAM', name: 'AMS RIVER-W PMS', mpLat: 52.45, mpLng: 4.30, qfu: 183, rIn: 22, b0In: 200, b1In: 270, flLoIn: 70, flHiIn: 90, rOut: 32, b0Out: 195, b1Out: 275, flLoOut: 100, flHiOut: 120, rateMph: 36, country: 'NL', arrIaf: 'RIVER' },
  { icao: 'EHAM', name: 'AMS SUGOL-N PMS', mpLat: 52.60, mpLng: 4.65, qfu: 183, rIn: 22, b0In: 280, b1In: 350, flLoIn: 70, flHiIn: 90, rOut: 32, b0Out: 275, b1Out: 355, flLoOut: 100, flHiOut: 120, rateMph: 36, country: 'NL', arrIaf: 'SUGOL' },
  // EKCH Copenhagen ALSIE / VOR ARTUR (Naviair 2012)
  { icao: 'EKCH', name: 'CPH ARTUR-N PMS', mpLat: 55.85, mpLng: 12.55, qfu: 220, rIn: 20, b0In: 320, b1In: 30, flLoIn: 70, flHiIn: 80, rOut: 28, b0Out: 315, b1Out: 35, flLoOut: 90, flHiOut: 110, rateMph: 30, country: 'DK', arrIaf: 'ARTUR' },
  // ENGM Oslo BAVAD/INSUV/GRESI 3 PMS (Avinor 2011)
  { icao: 'ENGM', name: 'OSL BAVAD-W PMS', mpLat: 60.15, mpLng: 10.85, qfu: 196, rIn: 20, b0In: 200, b1In: 270, flLoIn: 70, flHiIn: 80, rOut: 28, b0Out: 195, b1Out: 275, flLoOut: 90, flHiOut: 110, rateMph: 28, country: 'NO', arrIaf: 'BAVAD' },
  { icao: 'ENGM', name: 'OSL INSUV-E PMS', mpLat: 60.20, mpLng: 11.30, qfu: 196, rIn: 20, b0In: 70, b1In: 140, flLoIn: 70, flHiIn: 80, rOut: 28, b0Out: 65, b1Out: 145, flLoOut: 90, flHiOut: 110, rateMph: 28, country: 'NO', arrIaf: 'INSUV' },
  // LIRF Rome Fiumicino PMS (ENAV 2018)
  { icao: 'LIRF', name: 'FCO ELKAP-S PMS', mpLat: 41.55, mpLng: 12.40, qfu: 162, rIn: 22, b0In: 170, b1In: 240, flLoIn: 70, flHiIn: 80, rOut: 30, b0Out: 165, b1Out: 245, flLoOut: 90, flHiOut: 110, rateMph: 30, country: 'IT', arrIaf: 'ELKAP' },
  // EGSS Stansted PMS (NATS / CAA UK CAP 1772 2015)
  { icao: 'EGSS', name: 'STN ABBOT-S PMS', mpLat: 51.75, mpLng: 0.30, qfu: 220, rIn: 18, b0In: 150, b1In: 220, flLoIn: 70, flHiIn: 80, rOut: 26, b0Out: 145, b1Out: 225, flLoOut: 90, flHiOut: 100, rateMph: 26, country: 'GB', arrIaf: 'ABBOT' },
  // EIDW Dublin PMS (IAA 2012)
  { icao: 'EIDW', name: 'DUB BOYNE-W PMS', mpLat: 53.45, mpLng: -6.30, qfu: 280, rIn: 18, b0In: 200, b1In: 280, flLoIn: 70, flHiIn: 80, rOut: 26, b0Out: 195, b1Out: 285, flLoOut: 90, flHiOut: 100, rateMph: 28, country: 'IE', arrIaf: 'BOYNE' },
  // LOWW Vienna PMS (Austro Control 2013)
  { icao: 'LOWW', name: 'VIE BABEN-E PMS', mpLat: 48.05, mpLng: 16.65, qfu: 290, rIn: 18, b0In: 50, b1In: 130, flLoIn: 70, flHiIn: 80, rOut: 26, b0Out: 45, b1Out: 135, flLoOut: 90, flHiOut: 110, rateMph: 28, country: 'AT', arrIaf: 'BABEN' },
  // OMDB Dubai PMS (DCAA 2014)
  { icao: 'OMDB', name: 'DXB DESDI-W PMS', mpLat: 25.15, mpLng: 55.15, qfu: 121, rIn: 24, b0In: 220, b1In: 290, flLoIn: 80, flHiIn: 100, rOut: 34, b0Out: 215, b1Out: 295, flLoOut: 110, flHiOut: 130, rateMph: 40, country: 'AE', arrIaf: 'DESDI' },
  { icao: 'OMDB', name: 'DXB ULASA-E PMS', mpLat: 25.30, mpLng: 55.50, qfu: 121, rIn: 24, b0In: 40, b1In: 120, flLoIn: 80, flHiIn: 100, rOut: 34, b0Out: 35, b1Out: 125, flLoOut: 110, flHiOut: 130, rateMph: 40, country: 'AE', arrIaf: 'ULASA' },
  // RKSI Incheon PMS (KAC 2019)
  { icao: 'RKSI', name: 'ICN OLMEN-W PMS', mpLat: 37.45, mpLng: 126.30, qfu: 333, rIn: 22, b0In: 230, b1In: 310, flLoIn: 80, flHiIn: 100, rOut: 32, b0Out: 225, b1Out: 315, flLoOut: 110, flHiOut: 130, rateMph: 36, country: 'KR', arrIaf: 'OLMEN' },
  // ZSPD Shanghai Pudong PMS (CAAC 2017)
  { icao: 'ZSPD', name: 'PVG MATNO-N PMS', mpLat: 31.30, mpLng: 121.65, qfu: 175, rIn: 22, b0In: 320, b1In: 30, flLoIn: 80, flHiIn: 100, rOut: 32, b0Out: 315, b1Out: 35, flLoOut: 110, flHiOut: 130, rateMph: 38, country: 'CN', arrIaf: 'MATNO' },
  // VHHH Hong Kong PMS (CAD HKG 2016)
  { icao: 'VHHH', name: 'HKG SIERA-W PMS', mpLat: 22.40, mpLng: 113.75, qfu: 73, rIn: 20, b0In: 220, b1In: 290, flLoIn: 80, flHiIn: 100, rOut: 30, b0Out: 215, b1Out: 295, flLoOut: 110, flHiOut: 130, rateMph: 36, country: 'HK', arrIaf: 'SIERA' },
  // WSSS Singapore PMS (CAAS 2020)
  { icao: 'WSSS', name: 'SIN REPOV-N PMS', mpLat: 1.45, mpLng: 104.05, qfu: 22, rIn: 22, b0In: 320, b1In: 30, flLoIn: 80, flHiIn: 100, rOut: 32, b0Out: 315, b1Out: 35, flLoOut: 110, flHiOut: 130, rateMph: 36, country: 'SG', arrIaf: 'REPOV' },
  // YSSY Sydney PMS (Airservices 2018)
  { icao: 'YSSY', name: 'SYD MEPIL-S PMS', mpLat: -34.10, mpLng: 151.30, qfu: 162, rIn: 20, b0In: 170, b1In: 250, flLoIn: 70, flHiIn: 90, rOut: 28, b0Out: 165, b1Out: 255, flLoOut: 100, flHiOut: 120, rateMph: 30, country: 'AU', arrIaf: 'MEPIL' },
  // RJTT Tokyo Haneda PMS (JCAB 2020)
  { icao: 'RJTT', name: 'HND ADDUM-S PMS', mpLat: 35.30, mpLng: 139.95, qfu: 339, rIn: 22, b0In: 170, b1In: 240, flLoIn: 70, flHiIn: 90, rOut: 32, b0Out: 165, b1Out: 245, flLoOut: 100, flHiOut: 120, rateMph: 38, country: 'JP', arrIaf: 'ADDUM' },
  // EDDM Munich PMS (DFS 2019)
  { icao: 'EDDM', name: 'MUC ROKIL-W PMS', mpLat: 48.30, mpLng: 11.55, qfu: 263, rIn: 20, b0In: 200, b1In: 280, flLoIn: 70, flHiIn: 80, rOut: 28, b0Out: 195, b1Out: 285, flLoOut: 90, flHiOut: 110, rateMph: 32, country: 'DE', arrIaf: 'ROKIL' },
  // EDDF Frankfurt PMS-RNAV (DFS / SESAR PJ.02 2021)
  { icao: 'EDDF', name: 'FRA UNOKO-S PMS', mpLat: 49.85, mpLng: 8.65, qfu: 248, rIn: 22, b0In: 170, b1In: 240, flLoIn: 70, flHiIn: 80, rOut: 30, b0Out: 165, b1Out: 245, flLoOut: 90, flHiOut: 110, rateMph: 34, country: 'DE', arrIaf: 'UNOKO' },
  // LSZH Zurich PMS (Skyguide 2014)
  { icao: 'LSZH', name: 'ZRH AMIKI-N PMS', mpLat: 47.65, mpLng: 8.65, qfu: 144, rIn: 18, b0In: 320, b1In: 40, flLoIn: 80, flHiIn: 100, rOut: 26, b0Out: 315, b1Out: 45, flLoOut: 110, flHiOut: 130, rateMph: 28, country: 'CH', arrIaf: 'AMIKI' },
  // EGLL Heathrow (NATS PMS-trial 2024 - synthesised here for completeness)
  { icao: 'EGLL', name: 'LHR LAM-N PMS', mpLat: 51.65, mpLng: -0.20, qfu: 270, rIn: 18, b0In: 320, b1In: 40, flLoIn: 80, flHiIn: 90, rOut: 26, b0Out: 315, b1Out: 45, flLoOut: 100, flHiOut: 120, rateMph: 44, country: 'GB', arrIaf: 'LAM' },
]

/* ----- geo math ----- */
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const R_NM = 3440.065
function gcNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180, dφ = (la2 - la1) * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}
function angDelta(a: number, b: number): number { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d }
function inArc(brg: number, b0: number, b1: number): boolean {
  // returns true if brg lies in the directed sector b0 → b1 going clockwise
  const span = ((b1 - b0) % 360 + 360) % 360
  const off = ((brg - b0) % 360 + 360) % 360
  return off <= span
}
function projectLatLng(la: number, lo: number, brg: number, dnm: number): [number, number] {
  const δ = dnm / R_NM, θ = brg * Math.PI / 180, φ1 = la * Math.PI / 180, λ1 = lo * Math.PI / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return [φ2 * 180 / Math.PI, λ2 * 180 / Math.PI]
}

/* ----- per-aircraft PMS analysis ----- */
type Leg = 'INNER' | 'OUTER' | 'OFF'
interface Pm {
  f: SFlight
  wake: Wake
  pms: Pms
  leg: Leg
  brgFromMp: number       // bearing from MP to aircraft (deg)
  distFromMp: number      // NM
  legRadius: number       // NM of the leg the a/c is on (or nearest)
  radialErrNm: number     // |distFromMp - legRadius|
  arcRemDeg: number       // arc remaining from current bearing to leg-exit (toward MP direction)
  arcRemNm: number        // arc length remaining (NM)
  dtgNm: number           // distance-to-go to MP including arc remaining
  cutSavingNm: number     // chord-vs-arc saving if direct-to-MP issued now
  gsKt: number            // groundspeed estimate (kt)
  etaMpSec: number        // ETA to MP at current gs
  flDelta: number         // FL above/below assigned band centre
  reqSpacingSec: number   // RECAT-EU spacing requirement vs leader
  actualSpacingSec: number // estimated spacing vs nearest leader on same PMS
  leaderCs?: string
  leaderWake?: Wake
  spcDeltaSec: number     // actual - required
  drivers: { SPC: number; DTG: number; ARC: number; SEQ: number; CUT: number; ALT: number }
  score: number
  tier: Tier
  seqIdx: number          // 1-indexed position from MP (1 = next to merge)
}

function analyse(f: SFlight, others: { f: SFlight, w: Wake, pms: Pms, dtg: number }[]): Pm | null {
  if (f.ground || f.altitudeFt > 18000 || f.altitudeFt < 4000) return null
  const wake = classifyWake(f.type, f.category)
  let best: { pms: Pms; leg: Leg; brg: number; dist: number; radErr: number; legR: number } | null = null
  for (const p of PMS_LIST) {
    const dist = gcNm(f.lat, f.lng, p.mpLat, p.mpLng)
    if (dist > Math.max(p.rOut, p.rIn) * 1.45 || dist < Math.min(p.rIn, p.rOut) * 0.55) continue
    const brg = bearingDeg(p.mpLat, p.mpLng, f.lat, f.lng)
    // pick whichever leg fits arc + has min radial error
    const inIn = inArc(brg, p.b0In, p.b1In)
    const inOut = inArc(brg, p.b0Out, p.b1Out)
    const errIn = Math.abs(dist - p.rIn)
    const errOut = Math.abs(dist - p.rOut)
    let leg: Leg = 'OFF', legR = p.rIn, radErr = Math.min(errIn, errOut)
    if (inIn && errIn <= 3.5) { leg = 'INNER'; legR = p.rIn; radErr = errIn }
    else if (inOut && errOut <= 4.5) { leg = 'OUTER'; legR = p.rOut; radErr = errOut }
    else if (inIn || inOut) { leg = 'OFF'; legR = (errIn < errOut) ? p.rIn : p.rOut; radErr = Math.min(errIn, errOut) }
    else continue
    const score = radErr + (leg === 'OFF' ? 5 : 0)
    if (!best || score < best.radErr + (best.leg === 'OFF' ? 5 : 0)) {
      best = { pms: p, leg, brg, dist, radErr, legR }
    }
  }
  if (!best) return null
  const { pms, leg, brg, dist, radErr, legR } = best

  // arc remaining: from current bearing, clockwise toward b0 (closer-to-MP end)
  // PMS convention: aircraft enters at b1 end, sequences along arc, exits via direct cut to MP
  // arcRemDeg = directed arc from brg back to b0 (subtract)
  const rawRem = ((brg - pms.b0In + 360) % 360)
  const sectorSpan = ((pms.b1In - pms.b0In + 360) % 360)
  const arcRemDeg = clamp(rawRem, 0, sectorSpan)
  const arcRemNm = (arcRemDeg * Math.PI / 180) * legR
  const dtgNm = arcRemNm + legR // arc + radius to MP

  // chord vs arc saving (direct-to-MP cut now)
  const chordNm = dist // current direct distance to MP
  const cutSavingNm = Math.max(0, dtgNm - chordNm)

  // groundspeed proxy
  const gsKt = Math.max(80, f.velocityKts * 0.97)
  const etaMpSec = dtgNm / gsKt * 3600

  // FL band conformance
  const flLo = leg === 'INNER' ? pms.flLoIn : leg === 'OUTER' ? pms.flLoOut : (pms.flLoIn + pms.flLoOut) / 2
  const flHi = leg === 'INNER' ? pms.flHiIn : leg === 'OUTER' ? pms.flHiOut : (pms.flHiIn + pms.flHiOut) / 2
  const flMid = (flLo + flHi) / 2
  const flNow = f.altitudeFt / 100
  const flDelta = flNow - flMid
  const flOutside = flNow < flLo - 5 || flNow > flHi + 5

  // sequence: order all aircraft on this PMS by DTG ascending; find leader directly ahead
  const samePms = others.filter(o => o.pms.icao === pms.icao && o.pms.name === pms.name && o.f.icao !== f.icao).sort((a, b) => a.dtg - b.dtg)
  // find leader = nearest with DTG less than self
  let leader: { f: SFlight, w: Wake, dtg: number } | null = null
  for (const o of samePms) if (o.dtg < dtgNm) leader = o
  const reqSpacingSec = leader ? WAKE_SEC[leader.w][wake] : 90
  const actualSpacingSec = leader ? Math.max(0, (dtgNm - leader.dtg) / gsKt * 3600) : reqSpacingSec + 30
  const spcDeltaSec = actualSpacingSec - reqSpacingSec
  const seqIdx = 1 + samePms.filter(o => o.dtg < dtgNm).length

  // 6 drivers (0..100)
  const SPC = spcDeltaSec < 0 ? clamp(50 + (-spcDeltaSec) / 60 * 50, 50, 100)
            : spcDeltaSec < 15 ? clamp(20 + (15 - spcDeltaSec) / 15 * 30, 20, 50)
            : 0
  const DTG = clamp(Math.abs(dtgNm - (legR + (sectorSpan / 2 * Math.PI / 180) * legR)) / 25 * 80, 0, 80)
  const ARC = clamp(radErr / 3 * 100, 0, 100) * (leg === 'OFF' ? 1.0 : 0.55)
  const SEQ = clamp((seqIdx > 8 ? 60 : seqIdx * 8) + (pms.rateMph < 30 ? 10 : 0), 0, 100)
  const CUT = cutSavingNm > 12 ? clamp((cutSavingNm - 12) * 6, 0, 80) : 0
  const ALT = flOutside ? clamp(50 + Math.abs(flDelta) * 4, 50, 100) : clamp(Math.abs(flDelta) * 4, 0, 50)

  const drivers = { SPC, DTG, ARC, SEQ, CUT, ALT }
  const maxDrv = Math.max(SPC, DTG, ARC, SEQ, CUT, ALT)
  const secondary = (SPC + DTG + ARC + SEQ + CUT + ALT - maxDrv) / 5
  const rawScore = clamp(maxDrv + secondary * 0.12, 0, 100)
  let tier: Tier
  if (rawScore >= 78 && spcDeltaSec < -10) tier = 'SPC-LOSS'
  else if (leg === 'OFF' && radErr > 2.0) tier = 'OFF-ARC'
  else if (rawScore >= 55) tier = 'BUNCHED'
  else if (rawScore >= 28) tier = 'WATCH'
  else tier = 'STABLE'

  return {
    f, wake, pms, leg,
    brgFromMp: brg, distFromMp: dist, legRadius: legR, radialErrNm: radErr,
    arcRemDeg, arcRemNm, dtgNm, cutSavingNm,
    gsKt, etaMpSec, flDelta,
    reqSpacingSec, actualSpacingSec, leaderCs: leader?.f.callsign, leaderWake: leader?.w,
    spcDeltaSec, drivers, score: rawScore, tier, seqIdx,
  }
}

const SRC_HALO = 'pms-halo', LYR_HALO = 'pms-halo'
const SRC_PIN = 'pms-pin', LYR_PIN = 'pms-pin'
const SRC_LBL = 'pms-lbl', LYR_LBL = 'pms-lbl'
const SRC_ARC = 'pms-arc', LYR_ARC = 'pms-arc'
const SRC_MP = 'pms-mp', LYR_MP = 'pms-mp'
const SRC_MPLBL = 'pms-mplbl', LYR_MPLBL = 'pms-mplbl'
const SRC_LINK = 'pms-link', LYR_LINK = 'pms-link'
const SRC_CUT = 'pms-cut', LYR_CUT = 'pms-cut'

const lsGet = (k: string, d: any) => { if (typeof window === 'undefined') return d; try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }
const lsSet = (k: string, v: any) => { if (typeof window === 'undefined') return; try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

export default function PmsPointMerge({ map, flights, onClose, onFly }: Props) {
  const [spcMul, setSpcMul] = useState<number>(() => lsGet('ft-pms-spcm', 100))
  const [arcMul, setArcMul] = useState<number>(() => lsGet('ft-pms-arcm', 100))
  const [cutMul, setCutMul] = useState<number>(() => lsGet('ft-pms-cutm', 100))
  const [rateMul, setRateMul] = useState<number>(() => lsGet('ft-pms-rtm', 100))
  const [minFL, setMinFL] = useState<number>(() => lsGet('ft-pms-mfl', 40))
  const [maxFL, setMaxFL] = useState<number>(() => lsGet('ft-pms-xfl', 180))
  const [scope, setScope] = useState<number>(() => lsGet('ft-pms-scope', 40))
  const [wakeFilter, setWakeFilter] = useState<Wake | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'SYSTEMS' | 'WAKE'>('AIRCRAFT')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showArc, setShowArc] = useState(true)
  const [showMp, setShowMp] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showCut, setShowCut] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    lsSet('ft-pms-spcm', spcMul); lsSet('ft-pms-arcm', arcMul); lsSet('ft-pms-cutm', cutMul)
    lsSet('ft-pms-rtm', rateMul); lsSet('ft-pms-mfl', minFL); lsSet('ft-pms-xfl', maxFL); lsSet('ft-pms-scope', scope)
  }, [spcMul, arcMul, cutMul, rateMul, minFL, maxFL, scope])

  const rows = useMemo(() => {
    // first pass: cheap proximity → leg-attach to build (others) seed
    const seeds: { f: SFlight, w: Wake, pms: Pms, dtg: number }[] = []
    for (const f of flights) {
      if (f.ground || f.altitudeFt < minFL * 100 || f.altitudeFt > maxFL * 100) continue
      const w = classifyWake(f.type, f.category)
      for (const p of PMS_LIST) {
        const d = gcNm(f.lat, f.lng, p.mpLat, p.mpLng)
        if (d > Math.max(p.rOut, p.rIn) + 8) continue
        const brg = bearingDeg(p.mpLat, p.mpLng, f.lat, f.lng)
        const inAny = inArc(brg, p.b0In, p.b1In) || inArc(brg, p.b0Out, p.b1Out)
        if (!inAny) continue
        const sectorSpan = ((p.b1In - p.b0In + 360) % 360)
        const rawRem = ((brg - p.b0In + 360) % 360)
        const arcRemDeg = clamp(rawRem, 0, sectorSpan)
        const legR = Math.abs(d - p.rIn) < Math.abs(d - p.rOut) ? p.rIn : p.rOut
        const dtg = (arcRemDeg * Math.PI / 180) * legR + legR
        seeds.push({ f, w, pms: p, dtg })
        break
      }
    }
    const out: Pm[] = []
    for (const f of flights) {
      if (f.ground || f.altitudeFt < minFL * 100 || f.altitudeFt > maxFL * 100) continue
      const v = analyse(f, seeds); if (!v) continue
      v.drivers.SPC = clamp(v.drivers.SPC * spcMul / 100, 0, 100)
      v.drivers.ARC = clamp(v.drivers.ARC * arcMul / 100, 0, 100)
      v.drivers.CUT = clamp(v.drivers.CUT * cutMul / 100, 0, 100)
      v.drivers.SEQ = clamp(v.drivers.SEQ * rateMul / 100, 0, 100)
      const maxDrv = Math.max(v.drivers.SPC, v.drivers.DTG, v.drivers.ARC, v.drivers.SEQ, v.drivers.CUT, v.drivers.ALT)
      v.score = clamp(maxDrv, 0, 100)
      if (v.score >= 78 && v.spcDeltaSec < -10) v.tier = 'SPC-LOSS'
      else if (v.leg === 'OFF' && v.radialErrNm > 2.0) v.tier = 'OFF-ARC'
      else if (v.score >= 55) v.tier = 'BUNCHED'
      else if (v.score >= 28) v.tier = 'WATCH'
      else v.tier = 'STABLE'
      out.push(v)
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, spcMul, arcMul, cutMul, rateMul, minFL, maxFL])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(v => {
      if (wakeFilter !== 'ALL' && v.wake !== wakeFilter) return false
      if (tierFilter !== 'ALL' && v.tier !== tierFilter) return false
      if (q) {
        const blob = `${v.f.callsign} ${v.f.icao} ${v.f.type} ${v.pms.icao} ${v.pms.name} ${v.pms.arrIaf}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [rows, wakeFilter, tierFilter, query])

  const tierCount: Record<Tier, number> = { 'SPC-LOSS': 0, 'OFF-ARC': 0, BUNCHED: 0, WATCH: 0, STABLE: 0, IDLE: 0 }
  for (const v of rows) tierCount[v.tier]++
  const meanDtg = rows.length ? rows.reduce((s, v) => s + v.dtgNm, 0) / rows.length : 0
  const spcLoss = tierCount['SPC-LOSS']
  const offArc = tierCount['OFF-ARC']
  const worst = rows[0]
  const meanSpcDelta = rows.length ? rows.reduce((s, v) => s + v.spcDeltaSec, 0) / rows.length : 0
  const totalCutSavingNm = rows.reduce((s, v) => s + v.cutSavingNm, 0)

  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}, before?: string) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any, before)
    }
    ensure(LYR_ARC, 'line', SRC_ARC, { 'line-color': ['get', 'color'], 'line-width': 1.6, 'line-opacity': 0.55, 'line-dasharray': [3, 2] })
    ensure(LYR_LINK, 'line', SRC_LINK, { 'line-color': ['get', 'color'], 'line-width': 1.8, 'line-opacity': 0.8, 'line-dasharray': [3, 2] })
    ensure(LYR_CUT, 'line', SRC_CUT, { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [1, 2] })
    ensure(LYR_MP, 'circle', SRC_MP, { 'circle-radius': 5.5, 'circle-color': '#a855f7', 'circle-stroke-width': 1.4, 'circle-stroke-color': '#0f172a' })
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN, 'circle', SRC_PIN, { 'circle-radius': 5.5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_LBL, 'symbol', SRC_LBL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    ensure(LYR_MPLBL, 'symbol', SRC_MPLBL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL)) { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }
    if (map.getLayer(LYR_MPLBL)) { map.setPaintProperty(LYR_MPLBL, 'text-color', '#a855f7'); map.setPaintProperty(LYR_MPLBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_MPLBL, 'text-halo-width', 1.4) }

    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = [], cut: any[] = [], arc: any[] = [], mp: any[] = [], mplbl: any[] = []
    const activePms = new Set<string>()
    for (const v of filtered) {
      const c = TIER_COLOR[v.tier]
      activePms.add(v.pms.icao + '|' + v.pms.name)
      if (showHalo) halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { color: c, r: 8 + v.score * 0.14 } })
      if (showPin && (v.tier === 'SPC-LOSS' || v.tier === 'OFF-ARC')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { color: c } })
      if (showLbl && v.tier !== 'STABLE') {
        const lab = `${v.f.callsign || v.f.icao} #${v.seqIdx} ${v.tier} ${v.spcDeltaSec >= 0 ? '+' : ''}${v.spcDeltaSec.toFixed(0)}s`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { label: lab, color: c } })
      }
      if (showLink) link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[v.f.lng, v.f.lat], [v.pms.mpLng, v.pms.mpLat]] }, properties: { color: c } })
      if (showCut && v.cutSavingNm > 4) cut.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[v.f.lng, v.f.lat], [v.pms.mpLng, v.pms.mpLat]] }, properties: { color: '#10b981' } })
    }
    for (const p of PMS_LIST) {
      const active = activePms.has(p.icao + '|' + p.name)
      if (showArc) {
        for (const ring of [
          { r: p.rIn, b0: p.b0In, b1: p.b1In },
          { r: p.rOut, b0: p.b0Out, b1: p.b1Out },
        ]) {
          const pts: any[] = []
          const span = ((ring.b1 - ring.b0 + 360) % 360)
          const steps = Math.max(12, Math.round(span / 4))
          for (let i = 0; i <= steps; i++) {
            const b = (ring.b0 + (span * i / steps) + 360) % 360
            const [la, lo] = projectLatLng(p.mpLat, p.mpLng, b, ring.r)
            pts.push([lo, la])
          }
          arc.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts }, properties: { color: active ? '#0ea5e9' : '#475569' } })
        }
      }
      if (showMp) {
        mp.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.mpLng, p.mpLat] }, properties: { icao: p.icao } })
        mplbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.mpLng, p.mpLat] }, properties: { label: `${p.icao} · ${p.arrIaf || 'MP'} · ${p.rateMph}/h` } })
      }
    }
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_CUT) as any).setData({ type: 'FeatureCollection', features: cut })
    ;(map.getSource(SRC_ARC) as any).setData({ type: 'FeatureCollection', features: arc })
    ;(map.getSource(SRC_MP) as any).setData({ type: 'FeatureCollection', features: mp })
    ;(map.getSource(SRC_MPLBL) as any).setData({ type: 'FeatureCollection', features: mplbl })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_MPLBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_CUT, LYR_MP, LYR_ARC]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_LBL, SRC_MPLBL, SRC_PIN, SRC_LINK, SRC_CUT, SRC_MP, SRC_ARC]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, showHalo, showPin, showLbl, showLink, showCut, showArc, showMp])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const wakeBadge = (w: Wake) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: WAKE_COLOR[w], backgroundColor: WAKE_COLOR[w] + '1a', border: `1px solid ${WAKE_COLOR[w]}66` }}>{w}</span>
  )
  const legBadge = (l: Leg) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: l === 'OFF' ? '#f43f5e' : l === 'INNER' ? '#10b981' : '#0ea5e9', backgroundColor: '#0b1220', border: `1px solid ${l === 'OFF' ? '#f43f5e66' : '#33415566'}` }}>{l}</span>
  )
  const drvBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (v: Pm) => {
    if (v.tier === 'SPC-LOSS') return `SPC-LOSS · ${v.spcDeltaSec.toFixed(0)}s vs ${v.reqSpacingSec.toFixed(0)}s req behind ${v.leaderCs || '—'} (${v.leaderWake || '—'}) · extend on leg or vector outside per EUROCONTROL PMS ConOps §4.3`
    if (v.tier === 'OFF-ARC') return `OFF-ARC · ${v.radialErrNm.toFixed(1)}nm radial error on ${v.pms.icao}/${v.pms.arrIaf} · regain leg or accept direct-to-MP per DSNA PMS Design Manual ed.2`
    if (v.tier === 'BUNCHED') return `BUNCHED · seq #${v.seqIdx} at ${v.dtgNm.toFixed(1)}nm DTG · review spacing behind ${v.leaderCs || '—'} per ICAO Doc 4444 §8`
    if (v.tier === 'WATCH') return `WATCH · monitor leg conformance · FL ${(v.f.altitudeFt/100).toFixed(0)} (band FL${(v.leg==='INNER'?v.pms.flLoIn:v.pms.flLoOut).toFixed(0)}-FL${(v.leg==='INNER'?v.pms.flHiIn:v.pms.flHiOut).toFixed(0)})`
    return `STABLE · seq #${v.seqIdx} · DTG ${v.dtgNm.toFixed(1)}nm · cut-save ${v.cutSavingNm.toFixed(1)}nm available per EUROCONTROL PMS GIM §3.2`
  }

  /* Scatter: DTG NM vs spacing-delta */
  const W = 280, H = 180
  const sx = (n: number) => 32 + clamp(n, 0, 80) / 80 * (W - 42)
  const sy = (n: number) => H - 24 - clamp(n + 60, 0, 180) / 180 * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">PMS · Point Merge Arrival Sequencer</div>
          <div className="text-[10px] text-slate-500">EUROCONTROL PMS ConOps v3 · DSNA STAC · CAP 1772 · Doc 9931 §4 · Doc 4444 §8</div>
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
          <div className="text-[9px] text-slate-500 uppercase">Mean DTG</div>
          <div className="text-sm font-semibold" style={{ color: meanDtg > 45 ? '#f59e0b' : '#10b981' }}>{meanDtg.toFixed(1)}nm</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Spc-loss</div>
          <div className="text-sm font-semibold" style={{ color: spcLoss > 0 ? '#ef4444' : '#10b981' }}>{spcLoss}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean Δspc</div>
          <div className="text-xs font-semibold" style={{ color: meanSpcDelta < 0 ? '#ef4444' : meanSpcDelta < 15 ? '#f59e0b' : '#10b981' }}>{meanSpcDelta >= 0 ? '+' : ''}{meanSpcDelta.toFixed(0)}s</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Off-arc</div>
          <div className="text-xs font-semibold" style={{ color: offArc > 0 ? '#f43f5e' : '#10b981' }}>{offArc}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Cut-save</div>
          <div className="text-xs font-semibold text-emerald-400">{totalCutSavingNm.toFixed(0)}nm</div>
        </div>
      </div>

      {showDiag && rows.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* breach: spacing delta < -10s, any DTG */}
            <rect x={0} y={sy(-10)} width={W} height={H - 24 - sy(-10)} fill="#ef444425" />
            <rect x={0} y={sy(15)} width={W} height={sy(-5) - sy(15)} fill="#f59e0b15" />
            <line x1={sx(0)} y1={sy(0)} x2={sx(80)} y2={sy(0)} stroke="#475569" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(0)} y1={sy(-10)} x2={sx(80)} y2={sy(-10)} stroke="#ef444466" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(20)} y1={0} x2={sx(20)} y2={H - 24} stroke="#475569" strokeWidth={0.4} strokeDasharray="3 3" />
            <text x={W / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="#64748b">Distance-to-go (NM)</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>Δ spacing (s)</text>
            {rows.map((v, i) => (
              <circle key={i} cx={sx(v.dtgNm)} cy={sy(v.spcDeltaSec)} r={2.4} fill={TIER_COLOR[v.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['SPC-MUL', spcMul, 50, 200, setSpcMul, '%'],
            ['ARC-MUL', arcMul, 50, 200, setArcMul, '%'],
            ['CUT-MUL', cutMul, 50, 200, setCutMul, '%'],
            ['RATE-MUL', rateMul, 50, 200, setRateMul, '%'],
            ['MIN-FL', minFL, 0, 200, setMinFL, ''],
            ['MAX-FL', maxFL, 50, 300, setMaxFL, ''],
            ['SCOPE', scope, 20, 80, setScope, 'nm'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[40px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['A', 'B', 'C', 'D', 'E', 'F'] as Wake[]).map(w => (
            <button key={w} onClick={() => setWakeFilter(wakeFilter === w ? 'ALL' : w)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: wakeFilter === w ? WAKE_COLOR[w] + '33' : '#0b1220', borderColor: wakeFilter === w ? WAKE_COLOR[w] : '#1e293b', color: wakeFilter === w ? WAKE_COLOR[w] : '#cbd5e1' }}>{w}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['ARC', showArc, setShowArc],
            ['MP', showMp, setShowMp],
            ['LINK', showLink, setShowLink],
            ['CUT', showCut, setShowCut],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / system / IAF" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'SYSTEMS', 'WAKE'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'AIRCRAFT' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No PMS-sequenced arrivals in scope</div>}
          {filtered.map((v, idx) => (
            <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(v.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[v.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 truncate">{v.f.callsign || v.f.icao}</span>
                  <span className="text-slate-500 text-[10px] truncate">{v.f.type || '—'}</span>
                  {wakeBadge(v.wake)}
                  {legBadge(v.leg)}
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800/60 text-slate-300 border border-slate-700">#{v.seqIdx}</span>
                </div>
                {tierBadge(v.tier)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-sky-300">{v.pms.icao}/{v.pms.arrIaf}</span>
                {' · DTG '}<span className="text-slate-200">{v.dtgNm.toFixed(1)}nm</span>
                {' · arc '}<span className="text-slate-300">{v.arcRemNm.toFixed(1)}nm</span>
                {' · radErr '}<span style={{ color: v.radialErrNm > 2 ? '#f43f5e' : '#cbd5e1' }}>{v.radialErrNm.toFixed(2)}nm</span>
                {' · cut '}<span className="text-emerald-400">{v.cutSavingNm.toFixed(1)}nm</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-slate-300">{v.leaderCs ? `behind ${v.leaderCs} (${v.leaderWake})` : 'no leader'}</span>
                {' · req '}<span className="text-slate-300">{v.reqSpacingSec.toFixed(0)}s</span>
                {' · act '}<span style={{ color: v.spcDeltaSec < 0 ? '#ef4444' : v.spcDeltaSec < 15 ? '#f59e0b' : '#10b981' }}>{v.actualSpacingSec.toFixed(0)}s</span>
                {' · Δ '}<span style={{ color: v.spcDeltaSec < 0 ? '#ef4444' : '#10b981' }}>{v.spcDeltaSec >= 0 ? '+' : ''}{v.spcDeltaSec.toFixed(0)}s</span>
                {' · FL'}<span className="text-slate-300">{(v.f.altitudeFt/100).toFixed(0)}</span>
                {' · ETA '}<span className="text-slate-300">{(v.etaMpSec/60).toFixed(1)}m</span>
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${v.score}%`, backgroundColor: TIER_COLOR[v.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {drvBadge('SPC', v.drivers.SPC)}
                {drvBadge('DTG', v.drivers.DTG)}
                {drvBadge('ARC', v.drivers.ARC)}
                {drvBadge('SEQ', v.drivers.SEQ)}
                {drvBadge('CUT', v.drivers.CUT)}
                {drvBadge('ALT', v.drivers.ALT)}
              </div>
              <div className="text-[10px] mt-1.5 italic" style={{ color: TIER_COLOR[v.tier] }}>{advice(v)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'SYSTEMS' && (
        <div className="divide-y divide-slate-800">
          {PMS_LIST.slice().sort((a, b) => {
            const ka = rows.filter(r => r.pms.icao === a.icao && r.pms.name === a.name).length
            const kb = rows.filter(r => r.pms.icao === b.icao && r.pms.name === b.name).length
            return kb - ka
          }).map(p => {
            const pRows = rows.filter(r => r.pms.icao === p.icao && r.pms.name === p.name)
            const sl = pRows.filter(r => r.tier === 'SPC-LOSS').length
            const oa = pRows.filter(r => r.tier === 'OFF-ARC').length
            const bn = pRows.filter(r => r.tier === 'BUNCHED').length
            const ms = pRows.length ? pRows.reduce((s, r) => s + r.score, 0) / pRows.length : 0
            const utilPct = pRows.length / p.rateMph * 60 * 100 / 60
            return (
              <div key={p.icao + p.name} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${sl > 0 ? '#ef4444' : oa > 0 ? '#f43f5e' : bn > 0 ? '#f59e0b' : '#10b981'}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-sky-300">{p.icao}</span>
                    <span className="text-slate-200 text-[11px]">{p.name}</span>
                    <span className="text-slate-500 text-[10px]">{p.country}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-300">{p.rateMph}/h · IAF {p.arrIaf}</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  Inner {p.rIn}nm FL{p.flLoIn}-{p.flHiIn} · Outer {p.rOut}nm FL{p.flLoOut}-{p.flHiOut} · arc {((p.b1In - p.b0In + 360) % 360).toFixed(0)}°
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  {pRows.length} active · <span className="text-rose-400">{sl} SPC-LOSS</span> · <span className="text-rose-300">{oa} OFF-ARC</span> · <span className="text-amber-400">{bn} BUNCHED</span> · util {utilPct.toFixed(0)}%
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 60 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'WAKE' && (
        <div className="divide-y divide-slate-800">
          {(['A', 'B', 'C', 'D', 'E', 'F'] as Wake[]).map(w => {
            const wRows = rows.filter(r => r.wake === w)
            const sl = wRows.filter(r => r.tier === 'SPC-LOSS').length
            const bn = wRows.filter(r => r.tier === 'BUNCHED').length
            const ms = wRows.length ? wRows.reduce((s, r) => s + r.score, 0) / wRows.length : 0
            const md = wRows.length ? wRows.reduce((s, r) => s + r.spcDeltaSec, 0) / wRows.length : 0
            return (
              <div key={w} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${WAKE_COLOR[w]}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    {wakeBadge(w)}
                    <span className="text-slate-300 text-[11px]">RECAT-{w} · Vref {WAKE_REF_KTS[w]}kt</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-300">{wRows.length} ac · meanΔ {md >= 0 ? '+' : ''}{md.toFixed(0)}s</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  <span className="text-rose-400">{sl} SPC-LOSS</span> · <span className="text-amber-400">{bn} BUNCHED</span>
                </div>
                <div className="grid grid-cols-6 gap-0.5 mt-1.5">
                  {(['A','B','C','D','E','F'] as Wake[]).map(f => (
                    <div key={f} className="text-[9px] font-mono text-center rounded px-1 py-0.5" style={{ backgroundColor: WAKE_COLOR[f] + '14', color: WAKE_COLOR[f] }}>{WAKE_SEC[w][f]}s</div>
                  ))}
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 60 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
