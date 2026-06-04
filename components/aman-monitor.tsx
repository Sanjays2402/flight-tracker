'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   AMAN / E-AMAN · Arrival Manager extended-horizon sequencer
   ------------------------------------------------------------
   EUROCONTROL AMAN Operational Concept (PJ.01-08 XMAN) /
   EUROCONTROL Extended-AMAN ConOps ed.1.4 (2019) /
   SESAR PJ.01-W2 "EAMAN/DMAN integration" /
   ICAO Doc 9971 Manual on Collaborative ATM Pt II Ch 6 /
   ICAO Doc 4444 PANS-ATM §8 ATC service / §6 separation /
   FAA Order JO 7110.65 §5-8 (sequencing) §5-9 (vectors) /
   FAA TBFM (Time-Based Flow Management) STA / FrzH / MIT /
   FAA Order JO 7110.117 TBFM/IDAC/EDC procedures /
   FAA TFDM-AMS Surface Metering interop /
   EUROCONTROL Network Operations Plan 2024-2028 ch.4 /
   CAP 1862 NATS XMAN cross-border arrival mgmt /
   IATA Ground Operations Manual IGOM 2.2 arrival flow /
   NATS Heathrow AMAN Implementation Report 2021.

   AMAN is the arrival-side counterpart of A-CDM/DMAN. It builds
   a runway-locked sequence ~120-200 NM (or ~30-45 min ETO) from
   touchdown, computing per-aircraft Estimated Time of Arrival
   (ETA), Scheduled Time of Arrival (STA), and the required
   ATC delay (ETA - STA = absolute speed reduction or vector
   delay needed) so that wake-separated runway gaps are met.
   E-AMAN (Extended-AMAN) extends the horizon to 350-500 NM
   so that cross-FIR ANSPs can apply speed control / step-down
   delays earlier — reducing low-altitude holding (fuel + noise)
   per EUROCONTROL ConOps ed.1.4 §3.

   This monitor takes the airborne flight list, identifies
   descending arrivals within E-AMAN horizon of a 32-airport
   catalogue (EGLL EGKK EHAM EDDF LFPG LSZH LIRF LEMD LOWW EBBR
   LKPR EKCH ESSA EFHK EDDM LEBL EGCC LGAV plus KATL KORD KJFK
   KLAX KSFO KDFW KSEA KBOS CYYZ RJTT RJAA VHHH WSSS YSSY OMDB)
   each tagged with active runway, RECAT-EU wake category mix,
   nominal final-approach gap seconds, AMAN horizon NM, freeze
   horizon NM, E-AMAN cross-FIR flag, and ATC delay-absorption
   tier (HIGH / MED / LOW).

   ETA computed from groundspeed + great-circle distance + a
   nominal descent profile (3deg-equivalent). Each airport's
   sequence is built by sorting arrivals by ETA, then computing
   required STA gaps from the active wake-pair matrix (RECAT-EU
   ed.3 / FAA 6 CAT). DELAY = STA - ETA (positive = must absorb).

   6 risk drivers (max-driver composite):
     · DLY absolute delay (>10 min late = high cost-of-delay)
     · CMP "compression" — required deceleration to hit STA
     · STK low-altitude holding probability (delay near runway)
     · WAK wake-pair compatibility on final approach
     · FRZ inside freeze-horizon and sequence still unstable
     · XFR cross-FIR coordination penalty (E-AMAN not engaged)

   6 hard tiers:
     · HOLD-LATE  delay > 14 min inside freeze horizon (low-alt hold)
     · SLOT-MISS  STA missed by > 90s after freeze (runway gap lost)
     · COMPRESS   speed reduction > 0.06 M required to hit STA
     · WAKE-TIGHT next pair on final is HEAVY→LIGHT short gap
     · WATCH      delay > 4 min, inside horizon
     · NOMINAL    sequenced, no action / IDLE outside horizon
============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'HOLD-LATE' | 'SLOT-MISS' | 'COMPRESS' | 'WAKE-TIGHT' | 'WATCH' | 'NOMINAL' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'HOLD-LATE': '#ef4444', 'SLOT-MISS': '#f43f5e', COMPRESS: '#f59e0b',
  'WAKE-TIGHT': '#f59e0b', WATCH: '#0ea5e9', NOMINAL: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['HOLD-LATE', 'SLOT-MISS', 'COMPRESS', 'WAKE-TIGHT', 'WATCH', 'NOMINAL']
const TIER_RANK: Record<Tier, number> = { 'HOLD-LATE': 0, 'SLOT-MISS': 1, COMPRESS: 2, 'WAKE-TIGHT': 3, WATCH: 4, NOMINAL: 5, IDLE: 6 }

/* RECAT-EU ed.3 wake categories (A=SUP B=HEAVY-HI C=HEAVY-LO D=UPPER-MED E=LOWER-MED F=LIGHT) */
type Wake = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
const WAKE_COLOR: Record<Wake, string> = { A: '#a855f7', B: '#ec4899', C: '#f43f5e', D: '#0ea5e9', E: '#22d3ee', F: '#10b981' }

/* RECAT-EU final-approach minimum spacing seconds (leader-follower) */
/* Source: EUROCONTROL RECAT-EU ed.3 §4.2 table 4.1 (typical at 160 kt IAS) */
const WAKE_SEC: Record<Wake, Record<Wake, number>> = {
  A: { A: 90, B: 100, C: 120, D: 140, E: 160, F: 180 },
  B: { A: 80,  B: 90,  C: 100, D: 130, E: 150, F: 170 },
  C: { A: 80,  B: 80,  C: 90,  D: 110, E: 130, F: 160 },
  D: { A: 70,  B: 70,  C: 80,  D: 90,  E: 100, F: 130 },
  E: { A: 70,  B: 70,  C: 70,  D: 80,  E: 90,  F: 110 },
  F: { A: 70,  B: 70,  C: 70,  D: 70,  E: 80,  F: 90  },
}

function classifyWake(type: string | undefined): Wake {
  const t = (type || '').toUpperCase()
  if (/^(A38[0-9])$/.test(t)) return 'A'
  if (/^(B77[4-9]|B78[7-9]|B747|A35[0-9])$/.test(t)) return 'B'
  if (/^(B77[0-3]|B767|A33[0-9]|A340|MD11)$/.test(t)) return 'C'
  if (/^(B75[0-9]|A32[1-9]|A21N)$/.test(t)) return 'D'
  if (/^(B73[0-9]|B7M[78]|A31[89]|A22[01]|A20N|A19N|BCS[123]|E1[7-9][0-9]|E2[0-9][0-9])$/.test(t)) return 'E'
  return 'F'
}

/* ---- AMAN-equipped arrival airport catalogue (32) ---- */
interface AmanAp {
  icao: string; name: string; lat: number; lng: number
  rwy: string                // active arrival runway
  rwyBearing: number         // QFU magnetic
  horizonNm: number          // AMAN horizon (basic)
  eamanNm: number            // E-AMAN extended horizon
  freezeNm: number           // sequence freeze horizon
  gapSec: number             // nominal final gap (sec)
  flowCap: number            // max landings/hr (declared)
  absorb: 'HIGH' | 'MED' | 'LOW' // ATC speed-control absorption capability
  eaman: boolean             // E-AMAN cross-FIR enabled
}
const APS: AmanAp[] = [
  { icao: 'EGLL', name: 'London Heathrow',       lat: 51.470, lng:  -0.454, rwy: '27L', rwyBearing: 270, horizonNm: 200, eamanNm: 350, freezeNm: 70,  gapSec: 95,  flowCap: 47, absorb: 'HIGH', eaman: true  },
  { icao: 'EGKK', name: 'London Gatwick',        lat: 51.148, lng:  -0.190, rwy: '26L', rwyBearing: 260, horizonNm: 150, eamanNm: 250, freezeNm: 60,  gapSec: 85,  flowCap: 55, absorb: 'HIGH', eaman: true  },
  { icao: 'EHAM', name: 'Amsterdam Schiphol',    lat: 52.309, lng:   4.764, rwy: '18R', rwyBearing: 184, horizonNm: 200, eamanNm: 300, freezeNm: 60,  gapSec: 85,  flowCap: 60, absorb: 'HIGH', eaman: true  },
  { icao: 'EDDF', name: 'Frankfurt',             lat: 50.034, lng:   8.563, rwy: '25C', rwyBearing: 250, horizonNm: 200, eamanNm: 320, freezeNm: 65,  gapSec: 90,  flowCap: 56, absorb: 'HIGH', eaman: true  },
  { icao: 'LFPG', name: 'Paris CDG',             lat: 49.013, lng:   2.550, rwy: '27R', rwyBearing: 270, horizonNm: 180, eamanNm: 300, freezeNm: 60,  gapSec: 90,  flowCap: 58, absorb: 'MED',  eaman: true  },
  { icao: 'LSZH', name: 'Zürich',                lat: 47.464, lng:   8.549, rwy: '14',  rwyBearing: 140, horizonNm: 140, eamanNm: 220, freezeNm: 50,  gapSec: 90,  flowCap: 36, absorb: 'MED',  eaman: true  },
  { icao: 'LIRF', name: 'Rome Fiumicino',        lat: 41.800, lng:  12.239, rwy: '16R', rwyBearing: 158, horizonNm: 150, eamanNm: 240, freezeNm: 50,  gapSec: 95,  flowCap: 44, absorb: 'MED',  eaman: false },
  { icao: 'LEMD', name: 'Madrid Barajas',        lat: 40.493, lng:  -3.567, rwy: '32L', rwyBearing: 320, horizonNm: 160, eamanNm: 260, freezeNm: 55,  gapSec: 90,  flowCap: 50, absorb: 'MED',  eaman: false },
  { icao: 'LOWW', name: 'Vienna',                lat: 48.110, lng:  16.570, rwy: '16',  rwyBearing: 158, horizonNm: 140, eamanNm: 220, freezeNm: 50,  gapSec: 95,  flowCap: 38, absorb: 'MED',  eaman: true  },
  { icao: 'EBBR', name: 'Brussels',              lat: 50.901, lng:   4.484, rwy: '25R', rwyBearing: 250, horizonNm: 130, eamanNm: 200, freezeNm: 45,  gapSec: 95,  flowCap: 36, absorb: 'MED',  eaman: true  },
  { icao: 'LKPR', name: 'Prague',                lat: 50.101, lng:  14.260, rwy: '24',  rwyBearing: 240, horizonNm: 120, eamanNm: 180, freezeNm: 45,  gapSec: 100, flowCap: 26, absorb: 'LOW',  eaman: false },
  { icao: 'EKCH', name: 'Copenhagen Kastrup',    lat: 55.618, lng:  12.656, rwy: '22L', rwyBearing: 220, horizonNm: 140, eamanNm: 220, freezeNm: 50,  gapSec: 95,  flowCap: 38, absorb: 'MED',  eaman: true  },
  { icao: 'ESSA', name: 'Stockholm Arlanda',     lat: 59.652, lng:  17.918, rwy: '19R', rwyBearing: 190, horizonNm: 140, eamanNm: 220, freezeNm: 50,  gapSec: 100, flowCap: 32, absorb: 'MED',  eaman: false },
  { icao: 'EFHK', name: 'Helsinki Vantaa',       lat: 60.317, lng:  24.963, rwy: '22L', rwyBearing: 220, horizonNm: 130, eamanNm: 200, freezeNm: 45,  gapSec: 100, flowCap: 28, absorb: 'LOW',  eaman: false },
  { icao: 'EDDM', name: 'Munich',                lat: 48.354, lng:  11.786, rwy: '26R', rwyBearing: 260, horizonNm: 170, eamanNm: 280, freezeNm: 55,  gapSec: 90,  flowCap: 52, absorb: 'HIGH', eaman: true  },
  { icao: 'LEBL', name: 'Barcelona El Prat',     lat: 41.297, lng:   2.078, rwy: '25R', rwyBearing: 250, horizonNm: 150, eamanNm: 240, freezeNm: 50,  gapSec: 95,  flowCap: 52, absorb: 'MED',  eaman: false },
  { icao: 'EGCC', name: 'Manchester',            lat: 53.354, lng:  -2.275, rwy: '23R', rwyBearing: 230, horizonNm: 130, eamanNm: 200, freezeNm: 45,  gapSec: 100, flowCap: 40, absorb: 'MED',  eaman: true  },
  { icao: 'LGAV', name: 'Athens E. Venizelos',   lat: 37.937, lng:  23.945, rwy: '03L', rwyBearing:  30, horizonNm: 130, eamanNm: 200, freezeNm: 45,  gapSec: 105, flowCap: 30, absorb: 'LOW',  eaman: false },
  { icao: 'KATL', name: 'Atlanta Hartsfield',    lat: 33.640, lng: -84.428, rwy: '27R', rwyBearing: 268, horizonNm: 200, eamanNm: 350, freezeNm: 70,  gapSec: 75,  flowCap: 96, absorb: 'HIGH', eaman: true  },
  { icao: 'KORD', name: 'Chicago O\u02bcHare',   lat: 41.978, lng: -87.904, rwy: '28C', rwyBearing: 280, horizonNm: 200, eamanNm: 350, freezeNm: 70,  gapSec: 80,  flowCap: 90, absorb: 'HIGH', eaman: true  },
  { icao: 'KJFK', name: 'New York JFK',          lat: 40.640, lng: -73.779, rwy: '04R', rwyBearing:  40, horizonNm: 180, eamanNm: 300, freezeNm: 60,  gapSec: 95,  flowCap: 70, absorb: 'MED',  eaman: true  },
  { icao: 'KLAX', name: 'Los Angeles',           lat: 33.943, lng:-118.408, rwy: '24R', rwyBearing: 250, horizonNm: 200, eamanNm: 320, freezeNm: 65,  gapSec: 90,  flowCap: 80, absorb: 'HIGH', eaman: true  },
  { icao: 'KSFO', name: 'San Francisco',         lat: 37.619, lng:-122.375, rwy: '28R', rwyBearing: 284, horizonNm: 180, eamanNm: 280, freezeNm: 60,  gapSec: 100, flowCap: 58, absorb: 'MED',  eaman: true  },
  { icao: 'KDFW', name: 'Dallas/Fort Worth',     lat: 32.897, lng: -97.038, rwy: '17C', rwyBearing: 174, horizonNm: 200, eamanNm: 340, freezeNm: 65,  gapSec: 80,  flowCap: 88, absorb: 'HIGH', eaman: true  },
  { icao: 'KSEA', name: 'Seattle-Tacoma',        lat: 47.450, lng:-122.309, rwy: '16C', rwyBearing: 158, horizonNm: 180, eamanNm: 280, freezeNm: 60,  gapSec: 95,  flowCap: 56, absorb: 'MED',  eaman: true  },
  { icao: 'KBOS', name: 'Boston Logan',          lat: 42.363, lng: -71.006, rwy: '04R', rwyBearing:  40, horizonNm: 170, eamanNm: 270, freezeNm: 55,  gapSec: 95,  flowCap: 60, absorb: 'MED',  eaman: true  },
  { icao: 'CYYZ', name: 'Toronto Pearson',       lat: 43.681, lng: -79.610, rwy: '23',  rwyBearing: 230, horizonNm: 180, eamanNm: 280, freezeNm: 60,  gapSec: 95,  flowCap: 70, absorb: 'MED',  eaman: true  },
  { icao: 'RJTT', name: 'Tokyo Haneda',          lat: 35.553, lng: 139.781, rwy: '34L', rwyBearing: 340, horizonNm: 200, eamanNm: 320, freezeNm: 65,  gapSec: 85,  flowCap: 80, absorb: 'HIGH', eaman: true  },
  { icao: 'RJAA', name: 'Tokyo Narita',          lat: 35.764, lng: 140.386, rwy: '34L', rwyBearing: 340, horizonNm: 180, eamanNm: 280, freezeNm: 60,  gapSec: 95,  flowCap: 56, absorb: 'MED',  eaman: true  },
  { icao: 'VHHH', name: 'Hong Kong',             lat: 22.308, lng: 113.918, rwy: '07R', rwyBearing:  70, horizonNm: 180, eamanNm: 280, freezeNm: 60,  gapSec: 90,  flowCap: 64, absorb: 'HIGH', eaman: true  },
  { icao: 'WSSS', name: 'Singapore Changi',      lat:  1.359, lng: 103.989, rwy: '20C', rwyBearing: 200, horizonNm: 180, eamanNm: 280, freezeNm: 60,  gapSec: 90,  flowCap: 68, absorb: 'HIGH', eaman: true  },
  { icao: 'YSSY', name: 'Sydney Kingsford',      lat:-33.946, lng: 151.177, rwy: '34L', rwyBearing: 340, horizonNm: 150, eamanNm: 240, freezeNm: 55,  gapSec: 95,  flowCap: 44, absorb: 'MED',  eaman: false },
  { icao: 'OMDB', name: 'Dubai',                 lat: 25.253, lng:  55.366, rwy: '12L', rwyBearing: 120, horizonNm: 200, eamanNm: 320, freezeNm: 65,  gapSec: 90,  flowCap: 60, absorb: 'HIGH', eaman: true  },
]

/* ---- math ---- */
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const R_NM = 3440.065
function gcNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dφ = (la2 - la1) * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dλ = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}
function fnv(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}
function hashUnit(s: string, salt: string): number { return (fnv(s + '|' + salt) % 100000) / 100000 }

/* ---- per-flight ETA / sequencing ---- */
interface Sched {
  ap: AmanAp
  distNm: number
  bearingFromAc: number     // direction from aircraft to airport
  inboundCone: boolean      // track within 60deg of bearing-to-airport
  etaMin: number            // raw ETA from groundspeed (no ATC delay)
  staMin: number            // sequence-assigned STA (positive = minutes from now)
  delayMin: number          // STA - ETA
  seqIdx: number            // position in arrival sequence (0 = next to land)
  leaderWake: Wake | null   // wake category of leader in sequence (null if first)
  selfWake: Wake
  reqGapSec: number         // required wake-pair gap to leader
  inHorizon: boolean
  inEAman: boolean          // inside extended horizon (cross-FIR coordination)
  inFreeze: boolean         // inside freeze horizon (no more re-sequencing)
  machReduction: number     // estimated Mach reduction to absorb delay (0-0.15)
  holdProb: number          // 0-1 probability of low-altitude hold
}

/* ---- evaluation ---- */
interface Eval {
  f: SFlight; ap: AmanAp; sch: Sched
  drivers: { DLY: number; CMP: number; STK: number; WAK: number; FRZ: number; XFR: number }
  tier: Tier; score: number; advice: string
}

function evalArrival(f: SFlight, sch: Sched, demandMul: number, advMul: number): Eval {
  const DLY = clamp(Math.abs(sch.delayMin) * 7, 0, 100)            // 14 min = 100
  const CMP = clamp(sch.machReduction * 1000, 0, 100)              // 0.10 M = 100
  const STK = clamp(sch.holdProb * 100, 0, 100)
  // Wake compatibility: leader-follower SEC vs nominal gap (>20s extra = 100)
  const wakeExtra = sch.leaderWake ? Math.max(0, sch.reqGapSec - sch.ap.gapSec) : 0
  const WAK = clamp(wakeExtra * 5, 0, 100)
  const FRZ = sch.inFreeze && Math.abs(sch.delayMin) > 2 ? clamp(Math.abs(sch.delayMin) * 12, 0, 100) : 0
  const XFR = (!sch.ap.eaman && sch.distNm > sch.ap.horizonNm && sch.distNm < sch.ap.eamanNm) ? 65 : 0
  const drivers = { DLY, CMP, STK, WAK, FRZ, XFR }
  const arr = [DLY, CMP, STK, WAK, FRZ, XFR].sort((a, b) => b - a)
  let composite = arr[0] * 0.46 + arr[1] * 0.24 + arr[2] * 0.14 + arr[3] * 0.09 + arr[4] * 0.04 + arr[5] * 0.03
  composite *= (demandMul / 100) * (advMul / 100)
  composite = clamp(composite, 0, 100)
  // Hard escalations
  if (sch.inFreeze && sch.delayMin > 14) composite = Math.max(composite, 88)
  if (sch.inFreeze && Math.abs(sch.delayMin) > 1.5) composite = Math.max(composite, 70)
  if (sch.machReduction > 0.06) composite = Math.max(composite, 55)

  let tier: Tier, advice: string
  if (sch.inFreeze && sch.delayMin > 14) {
    tier = 'HOLD-LATE'
    advice = `Inside freeze ${sch.ap.freezeNm}nm with +${sch.delayMin.toFixed(1)} min delay — assign hold (low-alt fuel cost) per JO 7110.65 §5-9-1; revise STA via TBFM/AMAN, brief FCOM 11.31 holding`
  } else if (sch.inFreeze && Math.abs(sch.delayMin) > 1.5) {
    tier = 'SLOT-MISS'
    advice = `STA missed ${sch.delayMin >= 0 ? '+' : ''}${sch.delayMin.toFixed(1)} min inside freeze — runway gap lost; coordinate next-leader handoff per RECAT-EU ed.3 §4.2 / JO 7110.65 §5-5-4`
  } else if (sch.machReduction > 0.06) {
    tier = 'COMPRESS'
    advice = `Mach reduction Δ${sch.machReduction.toFixed(2)} required to hit STA — request cost-index drop or earlier descent per Doc 9971 §6 / EUROCONTROL E-AMAN ConOps ed.1.4 §3.4`
  } else if (sch.leaderWake && sch.reqGapSec - sch.ap.gapSec > 25) {
    tier = 'WAKE-TIGHT'
    advice = `Wake pair ${sch.leaderWake}→${sch.selfWake} requires ${sch.reqGapSec}s (nominal ${sch.ap.gapSec}s, +${sch.reqGapSec - sch.ap.gapSec}s) — expect vector for spacing per RECAT-EU ed.3 / AIM 5-5-4`
  } else if (Math.abs(sch.delayMin) > 4) {
    tier = 'WATCH'
    advice = `Sequence delay ${sch.delayMin >= 0 ? '+' : ''}${sch.delayMin.toFixed(1)} min, dist ${sch.distNm.toFixed(0)} nm — speed control in cruise per AC 90-66B / E-AMAN ConOps ed.1.4`
  } else {
    tier = 'NOMINAL'
    advice = `Sequenced #${sch.seqIdx + 1} to ${sch.ap.icao}/${sch.ap.rwy} · ETA ${sch.etaMin.toFixed(0)} min · STA ${sch.staMin.toFixed(0)} · Δ${sch.delayMin >= 0 ? '+' : ''}${sch.delayMin.toFixed(1)} min nominal`
  }
  return { f, ap: sch.ap, sch, drivers, tier, score: composite, advice }
}

/* ---- map layer ids ---- */
const SRC_HALO = 'aman-halo', LYR_HALO = 'aman-halo'
const SRC_PIN  = 'aman-pin',  LYR_PIN  = 'aman-pin'
const SRC_LBL  = 'aman-lbl',  LYR_LBL  = 'aman-lbl'
const SRC_AP   = 'aman-ap',   LYR_AP   = 'aman-ap'
const SRC_ALBL = 'aman-albl', LYR_ALBL = 'aman-albl'
const SRC_LINK = 'aman-link', LYR_LINK = 'aman-link'
const SRC_HRZ  = 'aman-hrz',  LYR_HRZ  = 'aman-hrz'

const lsGet = (k: string, d: any) => { if (typeof window === 'undefined') return d; try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }
const lsSet = (k: string, v: any) => { if (typeof window === 'undefined') return; try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

export default function AmanMonitor({ map, flights, onClose, onFly }: Props) {
  const [demand, setDemand]     = useState<number>(() => lsGet('ft-aman-dem', 100))
  const [absorb, setAbsorb]     = useState<number>(() => lsGet('ft-aman-abs', 100))
  const [advMul, setAdvMul]     = useState<number>(() => lsGet('ft-aman-adv', 100))
  const [hrzMul, setHrzMul]     = useState<number>(() => lsGet('ft-aman-hrz', 100))
  const [minFl, setMinFl]       = useState<number>(() => lsGet('ft-aman-mnfl', 0))
  const [maxFl, setMaxFl]       = useState<number>(() => lsGet('ft-aman-mxfl', 400))
  const [wakeFilter, setWakeFilter] = useState<Wake | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS' | 'WAKE'>('AIRCRAFT')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin]   = useState(true)
  const [showLbl, setShowLbl]   = useState(true)
  const [showAp, setShowAp]     = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showHrz, setShowHrz]   = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    lsSet('ft-aman-dem', demand); lsSet('ft-aman-abs', absorb); lsSet('ft-aman-adv', advMul); lsSet('ft-aman-hrz', hrzMul)
    lsSet('ft-aman-mnfl', minFl); lsSet('ft-aman-mxfl', maxFl)
  }, [demand, absorb, advMul, hrzMul, minFl, maxFl])

  /* ---- Build per-airport arrival sequence ---- */
  const evals = useMemo(() => {
    interface Pre { f: SFlight; ap: AmanAp; distNm: number; etaMin: number; wake: Wake; bearingFromAc: number; inboundCone: boolean }
    const pre: Pre[] = []
    for (const f of flights) {
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl || fl > maxFl) continue
      // descending or cruise (arrivals); skip strong climbers
      if (f.vertRate > 800) continue
      let best: { ap: AmanAp; distNm: number } | null = null
      for (const a of APS) {
        const d = gcNm(f.lat, f.lng, a.lat, a.lng)
        const eamanHorizon = a.eamanNm * (hrzMul / 100)
        if (d > eamanHorizon) continue
        if (!best || d < best.distNm) best = { ap: a, distNm: d }
      }
      if (!best) continue
      // Direction check — must be flying generally toward this airport
      const brg = bearingDeg(f.lat, f.lng, best.ap.lat, best.ap.lng)
      const delta = Math.abs(((f.track - brg + 540) % 360) - 180)
      // delta near 0 = away, delta near 180 = toward (track opposite of bearing-from)
      const inbound = delta > 100
      if (!inbound) continue
      // ETA from groundspeed (account for descent: use 90% of GS as average descent gs)
      const gs = Math.max(120, f.velocityKts) * 0.92
      const etaMin = (best.distNm / gs) * 60
      const wake = classifyWake(f.type)
      pre.push({ f, ap: best.ap, distNm: best.distNm, etaMin, wake, bearingFromAc: brg, inboundCone: inbound })
    }

    // Group per airport, sort by ETA, compute STA per RECAT-EU wake gap, derive delay
    const byAp: Record<string, Pre[]> = {}
    for (const p of pre) (byAp[p.ap.icao] = byAp[p.ap.icao] || []).push(p)

    const out: Eval[] = []
    for (const icao in byAp) {
      const arr = byAp[icao].sort((a, b) => a.etaMin - b.etaMin)
      let staClockSec = 0  // running STA clock in seconds (from "now")
      let prevWake: Wake | null = null
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i]
        const apx = p.ap
        const horizonAct = apx.horizonNm * (hrzMul / 100)
        const eamanAct = apx.eamanNm * (hrzMul / 100)
        const freezeAct = apx.freezeNm * (hrzMul / 100)
        const inHorizon = p.distNm <= horizonAct
        const inEAman = p.distNm <= eamanAct
        const inFreeze = p.distNm <= freezeAct

        // Required gap to predecessor in sequence (sec)
        const reqGapSec = prevWake ? WAKE_SEC[prevWake][p.wake] : apx.gapSec
        // Demand multiplier shrinks effective flow cap, increasing baseline gap
        const flowGap = (3600 / Math.max(20, apx.flowCap)) * (demand / 100)
        const gapEff = Math.max(reqGapSec, flowGap)
        // STA seconds (from now)
        staClockSec = Math.max(p.etaMin * 60, staClockSec + gapEff)
        const staMin = staClockSec / 60
        const delayMin = staMin - p.etaMin
        // Absorption capability scales how much delay can be done via speed
        const absorbCap = (apx.absorb === 'HIGH' ? 8 : apx.absorb === 'MED' ? 5 : 3) * (absorb / 100)
        // Mach reduction estimate (per Doc 9971): each minute of delay over horizonNm ~ 0.01M (rough)
        const machReduction = clamp((Math.max(0, delayMin) / Math.max(20, p.distNm)) * (absorbCap / 5) * 12, 0, 0.20)
        // Hold probability: only meaningful inside horizon and only if delay > absorbCap
        const excess = Math.max(0, delayMin - absorbCap)
        const holdProb = inHorizon ? clamp(excess / 6, 0, 1) : 0

        const sch: Sched = {
          ap: apx, distNm: p.distNm, bearingFromAc: p.bearingFromAc, inboundCone: p.inboundCone,
          etaMin: p.etaMin, staMin, delayMin, seqIdx: i,
          leaderWake: prevWake, selfWake: p.wake, reqGapSec: Math.round(gapEff),
          inHorizon, inEAman, inFreeze, machReduction, holdProb,
        }
        out.push(evalArrival(p.f, sch, demand, advMul))
        prevWake = p.wake
      }
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, minFl, maxFl, hrzMul, demand, absorb, advMul])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return evals.filter(e => {
      if (wakeFilter !== 'ALL' && e.sch.selfWake !== wakeFilter) return false
      if (tierFilter !== 'ALL' && e.tier !== tierFilter) return false
      if (q) {
        const blob = `${e.f.callsign} ${e.f.icao} ${e.f.type} ${e.f.operator} ${e.ap.icao} ${e.ap.name}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [evals, wakeFilter, tierFilter, query])

  const tierCount: Record<Tier, number> = { 'HOLD-LATE': 0, 'SLOT-MISS': 0, COMPRESS: 0, 'WAKE-TIGHT': 0, WATCH: 0, NOMINAL: 0, IDLE: 0 }
  for (const e of evals) tierCount[e.tier]++
  const meanScore = evals.length ? evals.reduce((s, e) => s + e.score, 0) / evals.length : 0
  const worst = evals[0]
  const holdN = evals.filter(e => e.tier === 'HOLD-LATE').length
  const slotN = evals.filter(e => e.tier === 'SLOT-MISS').length
  const meanDelay = evals.length ? evals.reduce((s, e) => s + e.sch.delayMin, 0) / evals.length : 0
  const meanComp = evals.length ? evals.reduce((s, e) => s + e.sch.machReduction, 0) / evals.length : 0

  /* Map layers */
  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any)
    }
    ensure(LYR_HRZ,  'line',   SRC_HRZ,  { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.45, 'line-dasharray': [3, 3] })
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN,  'circle', SRC_PIN,  { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_AP,   'circle', SRC_AP,   { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.55, 'circle-stroke-width': 1, 'circle-stroke-color': '#7dd3fc' })
    ensure(LYR_LINK, 'line',   SRC_LINK, { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.85, 'line-dasharray': [2, 2] })
    ensure(LYR_LBL,  'symbol', SRC_LBL,  {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    ensure(LYR_ALBL, 'symbol', SRC_ALBL, {}, { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, -1.2], 'text-anchor': 'bottom', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL))  { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }
    if (map.getLayer(LYR_ALBL)) { map.setPaintProperty(LYR_ALBL, 'text-color', '#7dd3fc'); map.setPaintProperty(LYR_ALBL, 'text-halo-color', '#020617'); map.setPaintProperty(LYR_ALBL, 'text-halo-width', 1.4) }

    /* Build horizon rings (32-segment polygon per airport) — basic AMAN ring + E-AMAN ring */
    const hrz: any[] = []
    if (showHrz) {
      for (const a of APS) {
        const inN = evals.filter(e => e.ap.icao === a.icao).length
        if (inN === 0) continue
        for (const [rNm, col] of [[a.horizonNm * (hrzMul / 100), '#0ea5e9'], [a.eamanNm * (hrzMul / 100), a.eaman ? '#22d3ee' : '#475569']] as [number, string][]) {
          const coords: number[][] = []
          const latRad = a.lat * Math.PI / 180
          const dLatDeg = rNm / 60
          const dLngDeg = rNm / (60 * Math.cos(latRad))
          for (let k = 0; k <= 32; k++) {
            const t = (k / 32) * Math.PI * 2
            coords.push([a.lng + Math.cos(t) * dLngDeg, a.lat + Math.sin(t) * dLatDeg])
          }
          hrz.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { color: col } })
        }
      }
    }
    const ap: any[] = [], albl: any[] = []
    if (showAp) {
      for (const a of APS) {
        const inA = evals.filter(e => e.ap.icao === a.icao).length
        if (inA === 0) continue
        const flowUtil = inA / Math.max(1, a.flowCap / 8)
        const c = flowUtil >= 1.2 ? '#ef4444' : flowUtil >= 0.7 ? '#f59e0b' : '#0ea5e9'
        ap.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng, a.lat] }, properties: { r: 4 + Math.min(inA, 8) * 0.6, color: c } })
        albl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng, a.lat] }, properties: { label: `${a.icao}·${a.rwy}·${inA}` } })
      }
    }
    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = []
    for (const e of filtered) {
      const color = TIER_COLOR[e.tier]
      if (showHalo && e.tier !== 'IDLE' && e.tier !== 'NOMINAL') halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, r: 8 + e.score * 0.14 } })
      if (showPin && (e.tier === 'HOLD-LATE' || e.tier === 'SLOT-MISS')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color } })
      if (showLbl && e.tier !== 'NOMINAL' && e.tier !== 'IDLE') {
        const tag = `#${e.sch.seqIdx + 1} ${e.sch.delayMin >= 0 ? '+' : ''}${e.sch.delayMin.toFixed(0)}m`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, label: `${e.f.callsign || e.f.icao} › ${e.ap.icao}/${e.ap.rwy} · ${tag} · ${e.tier}` } })
      }
      if (showLink && e.tier !== 'NOMINAL' && e.tier !== 'IDLE') {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[e.f.lng, e.f.lat], [e.ap.lng, e.ap.lat]] }, properties: { color } })
      }
    }
    ;(map.getSource(SRC_HRZ)  as any).setData({ type: 'FeatureCollection', features: hrz })
    ;(map.getSource(SRC_AP)   as any).setData({ type: 'FeatureCollection', features: ap })
    ;(map.getSource(SRC_ALBL) as any).setData({ type: 'FeatureCollection', features: albl })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN)  as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL)  as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_AP, LYR_ALBL, LYR_HRZ]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_LINK, SRC_AP, SRC_ALBL, SRC_HRZ]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, evals, hrzMul, showHalo, showPin, showLbl, showAp, showLink, showHrz])

  const tierBadge = (t: Tier) => <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  const wakeBadge = (w: Wake) => <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: WAKE_COLOR[w], backgroundColor: WAKE_COLOR[w] + '1f', border: `1px solid ${WAKE_COLOR[w]}55` }}>{w}</span>
  const drvBadge = (k: string, v: number) => {
    const c = v >= 70 ? '#ef4444' : v >= 40 ? '#f59e0b' : v >= 18 ? '#0ea5e9' : '#10b981'
    return <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: c, backgroundColor: c + '1c', border: `1px solid ${c}55` }}>{k}{v.toFixed(0)}</span>
  }

  /* Scatter: distance-to-airport (x) vs delay (y) */
  const W = 280, H = 110, padL = 28, padB = 16, padT = 6, padR = 6
  const xMin = 0, xMax = 360, yMin = -4, yMax = 22
  const sx = (v: number) => padL + ((clamp(v, xMin, xMax) - xMin) / (xMax - xMin)) * (W - padL - padR)
  const sy = (v: number) => padT + (1 - (clamp(v, yMin, yMax) - yMin) / (yMax - yMin)) * (H - padT - padB)

  return (
    <div className="absolute right-3 top-20 z-40 w-[26rem] max-h-[calc(100vh-6rem)] flex flex-col bg-slate-900/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-sky-500 animate-pulse" />
          <span className="text-[10px] font-bold tracking-widest uppercase text-sky-400">AMAN / E-AMAN · Arrival Sequencer</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm leading-none">×</button>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[8px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean score</div><div className="text-sm font-semibold" style={{ color: meanScore >= 65 ? '#ef4444' : meanScore >= 35 ? '#f59e0b' : '#10b981' }}>{meanScore.toFixed(0)}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Worst</div><div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Hold-late</div><div className="text-sm font-semibold" style={{ color: holdN > 0 ? '#ef4444' : '#10b981' }}>{holdN}</div></div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Slot-miss</div><div className="text-xs font-semibold" style={{ color: slotN > 0 ? '#f43f5e' : '#10b981' }}>{slotN}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean delay</div><div className="text-xs font-semibold" style={{ color: meanDelay > 6 ? '#f43f5e' : meanDelay > 3 ? '#f59e0b' : '#10b981' }}>{meanDelay >= 0 ? '+' : ''}{meanDelay.toFixed(1)}m</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean ΔM</div><div className="text-xs font-semibold" style={{ color: meanComp > 0.04 ? '#f59e0b' : '#10b981' }}>{meanComp.toFixed(3)}</div></div>
      </div>

      {showDiag && evals.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* freeze zone: 0-80nm horizontal stripe */}
            <rect x={sx(0)} y={padT} width={sx(80) - sx(0)} height={H - padT - padB} fill="#f43f5e10" />
            {/* breach quadrant: inside 80nm + delay > 8 */}
            <rect x={sx(0)} y={padT} width={sx(80) - sx(0)} height={sy(8) - padT} fill="#ef444418" />
            <line x1={padL} y1={sy(0)} x2={W - padR} y2={sy(0)} stroke="#475569" strokeWidth={0.5} />
            <line x1={sx(80)} y1={padT} x2={sx(80)} y2={H - padB} stroke="#f43f5e66" strokeWidth={0.5} strokeDasharray="2 3" />
            <line x1={padL} y1={sy(8)} x2={W - padR} y2={sy(8)} stroke="#f59e0b66" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={W / 2} y={H - 3} textAnchor="middle" fontSize="9" fill="#64748b">Distance-to-runway (nm)</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>Sequence delay (min)</text>
            {evals.map((e, i) => (
              <circle key={i} cx={sx(e.sch.distNm)} cy={sy(e.sch.delayMin)} r={2.4} fill={TIER_COLOR[e.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['DEMAND', demand, 50, 200, setDemand, '%'],
            ['ABSORB', absorb, 50, 200, setAbsorb, '%'],
            ['ADV-MUL', advMul, 50, 200, setAdvMul, '%'],
            ['HORIZON', hrzMul, 50, 200, setHrzMul, '%'],
            ['MIN-FL', minFl, 0, 300, setMinFl, ''],
            ['MAX-FL', maxFl, 50, 500, setMaxFl, ''],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[40px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['A', 'B', 'C', 'D', 'E', 'F'] as Wake[]).map(k => (
            <button key={k} onClick={() => setWakeFilter(wakeFilter === k ? 'ALL' : k)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: wakeFilter === k ? WAKE_COLOR[k] + '33' : '#0b1220', borderColor: wakeFilter === k ? WAKE_COLOR[k] : '#1e293b', color: wakeFilter === k ? WAKE_COLOR[k] : '#cbd5e1' }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['APT', showAp, setShowAp],
            ['LINK', showLink, setShowLink],
            ['HRZ', showHrz, setShowHrz],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, v, setter]: any) => (
            <button key={lab} onClick={() => setter(!v)} className="px-1.5 py-0.5 rounded text-[9px] font-mono border" style={{ backgroundColor: v ? '#0ea5e933' : '#0b1220', borderColor: v ? '#0ea5e9' : '#1e293b', color: v ? '#7dd3fc' : '#64748b' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / type / airport" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'AIRPORTS', 'WAKE'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No arrivals inside AMAN/E-AMAN horizon.</div>}
            {filtered.map((e, idx) => {
              const s = e.sch
              return (
                <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(e.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[e.tier]}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-slate-200 text-[11px] font-semibold truncate">{e.f.callsign || e.f.icao}</span>
                      <span className="text-slate-500 text-[10px] font-mono">{e.f.type || '—'}</span>
                      {wakeBadge(s.selfWake)}
                      <span className="px-1 py-0.5 rounded text-[9px] font-mono text-slate-400 bg-slate-800/60 border border-slate-700">#{s.seqIdx + 1}</span>
                      {s.inFreeze && <span className="px-1 py-0.5 rounded text-[9px] font-mono text-rose-400 bg-rose-500/10 border border-rose-500/40">FRZ</span>}
                      {!s.ap.eaman && s.distNm > s.ap.horizonNm && <span className="px-1 py-0.5 rounded text-[9px] font-mono text-amber-400 bg-amber-500/10 border border-amber-500/40">!XFR</span>}
                    </div>
                    {tierBadge(e.tier)}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    <span className="text-sky-300">{s.ap.icao}/{s.ap.rwy}</span>
                    {' · '}<span className="text-slate-300">{s.distNm.toFixed(0)} nm</span>
                    {' · ETA '}<span className="text-slate-300">{s.etaMin.toFixed(0)}m</span>
                    {' › STA '}<span style={{ color: s.delayMin > 8 ? '#f43f5e' : s.delayMin > 4 ? '#f59e0b' : '#10b981' }}>{s.staMin.toFixed(0)}m</span>
                    {' · Δ'}<span style={{ color: s.delayMin > 8 ? '#f43f5e' : s.delayMin > 4 ? '#f59e0b' : '#10b981' }}>{s.delayMin >= 0 ? '+' : ''}{s.delayMin.toFixed(1)}m</span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    {s.leaderWake ? (<>leader <span style={{ color: WAKE_COLOR[s.leaderWake] }}>{s.leaderWake}</span>›<span style={{ color: WAKE_COLOR[s.selfWake] }}>{s.selfWake}</span>{' gap '}<span style={{ color: s.reqGapSec - s.ap.gapSec > 25 ? '#f59e0b' : '#10b981' }}>{s.reqGapSec}s</span></>) : <span className="text-emerald-400">first in seq</span>}
                    {' · ΔM '}<span style={{ color: s.machReduction > 0.06 ? '#f59e0b' : '#10b981' }}>{s.machReduction.toFixed(3)}</span>
                    {' · hold '}<span style={{ color: s.holdProb > 0.6 ? '#ef4444' : s.holdProb > 0.3 ? '#f59e0b' : '#10b981' }}>{(s.holdProb * 100).toFixed(0)}%</span>
                  </div>
                  <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${e.score}%`, backgroundColor: TIER_COLOR[e.tier] }} /></div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {drvBadge('DLY', e.drivers.DLY)}
                    {drvBadge('CMP', e.drivers.CMP)}
                    {drvBadge('STK', e.drivers.STK)}
                    {drvBadge('WAK', e.drivers.WAK)}
                    {drvBadge('FRZ', e.drivers.FRZ)}
                    {drvBadge('XFR', e.drivers.XFR)}
                  </div>
                  <div className="text-[10px] mt-1.5 italic" style={{ color: TIER_COLOR[e.tier] }}>{e.advice}</div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'AIRPORTS' && (
          <div className="divide-y divide-slate-800">
            {APS.slice().sort((a, b) => {
              const ca = evals.filter(e => e.ap.icao === a.icao).length
              const cb = evals.filter(e => e.ap.icao === b.icao).length
              return cb - ca
            }).map(a => {
              const inA = evals.filter(e => e.ap.icao === a.icao)
              if (inA.length === 0) return null
              const ms = inA.length ? inA.reduce((s, e) => s + e.score, 0) / inA.length : 0
              const meanD = inA.length ? inA.reduce((s, e) => s + e.sch.delayMin, 0) / inA.length : 0
              const hold = inA.filter(e => e.tier === 'HOLD-LATE').length
              const slot = inA.filter(e => e.tier === 'SLOT-MISS').length
              const flowUtil = inA.length / Math.max(1, a.flowCap / 8)
              const c = flowUtil >= 1.2 ? '#ef4444' : flowUtil >= 0.7 ? '#f59e0b' : '#10b981'
              return (
                <div key={a.icao} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${c}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-mono text-sky-300 text-[11px]">{a.icao}/{a.rwy}</span>
                      <span className="px-1 py-0.5 rounded text-[9px] font-mono text-slate-400 bg-slate-800/60 border border-slate-700">{a.absorb}</span>
                      {a.eaman && <span className="px-1 py-0.5 rounded text-[9px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/40">E-AMAN</span>}
                      <span className="text-[10px] text-slate-400 truncate">{a.name}</span>
                    </div>
                    <span className="text-[10px] font-mono" style={{ color: c }}>{inA.length}/{Math.round(a.flowCap / 8)}·hr</span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    cap {a.flowCap}/hr · horiz {a.horizonNm}/{a.eamanNm}nm · frz {a.freezeNm}nm · gap {a.gapSec}s
                    {' · Δμ '}<span style={{ color: meanD > 6 ? '#f43f5e' : meanD > 3 ? '#f59e0b' : '#10b981' }}>{meanD >= 0 ? '+' : ''}{meanD.toFixed(1)}m</span>
                    {hold > 0 && <> · <span className="text-rose-400">{hold} HLD</span></>}
                    {slot > 0 && <> · <span className="text-rose-400">{slot} SLT</span></>}
                  </div>
                  <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 65 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'WAKE' && (
          <div className="divide-y divide-slate-800">
            {(['A', 'B', 'C', 'D', 'E', 'F'] as Wake[]).map(w => {
              const inW = evals.filter(e => e.sch.selfWake === w)
              const ms = inW.length ? inW.reduce((s, e) => s + e.score, 0) / inW.length : 0
              const meanD = inW.length ? inW.reduce((s, e) => s + e.sch.delayMin, 0) / inW.length : 0
              const tight = inW.filter(e => e.tier === 'WAKE-TIGHT').length
              const examples = { A: 'A380', B: 'B777 B787 A350 B747', C: 'B763 A330 A340 MD11', D: 'B757 A321', E: 'B737 A320 A220 BCS E-Jet', F: 'CRJ ATR PC-12 light' }[w]
              return (
                <div key={w} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${WAKE_COLOR[w]}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-mono text-[11px] font-semibold" style={{ color: WAKE_COLOR[w] }}>RECAT-EU {w}</span>
                      <span className="text-[10px] text-slate-400 italic truncate">{examples}</span>
                    </div>
                    <span className="text-[10px] font-mono text-slate-300">{inW.length}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    Δμ <span style={{ color: meanD > 6 ? '#f43f5e' : meanD > 3 ? '#f59e0b' : '#10b981' }}>{meanD >= 0 ? '+' : ''}{meanD.toFixed(1)}m</span>
                    {tight > 0 && <> · <span className="text-amber-400">{tight} WAK</span></>}
                    {' · self-spacing '}<span className="text-slate-300">{WAKE_SEC[w][w]}s</span>
                  </div>
                  <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 65 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        EUROCONTROL E-AMAN ConOps ed.1.4 · SESAR PJ.01-W2 · ICAO Doc 9971 Pt II Ch 6 · Doc 4444 §8 / §6 · FAA JO 7110.65 §5-8 §5-9 · JO 7110.117 TBFM · TFDM-AMS · NOP 2024-28 · CAP 1862 XMAN · RECAT-EU ed.3
      </div>
    </div>
  )
}
