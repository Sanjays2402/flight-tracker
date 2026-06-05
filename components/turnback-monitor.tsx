// =============================================================================
// TURNBACK · EFATO "Impossible Turn" Decision Monitor & 270° Möller-Turn
//           Glide-Geometry Solver
// =============================================================================
//
// Engine-Failure-After-TakeOff (EFATO) — total power loss during initial climb
// — is the single most lethal phase-of-flight envelope in fixed-wing aviation.
// The pilot has ~3 seconds to choose between three mutually exclusive options:
//
//   (A) ABORT-STRAIGHT  : pitch for best-glide, accept landing within a
//                         ±30° cone ahead — the Sully US1549 / TACA 110 /
//                         BA 38 doctrine. Required when below the class
//                         minimum turnback altitude.
//   (B) TURN-225        : the "impossible turn" — a 225° heading change at
//                         ~45° bank (the Möller-Rogers teardrop) intercepting
//                         a 45° final to the reciprocal-direction runway.
//                         Only valid above the per-class minimum turnback
//                         altitude with glide margin.
//   (C) OFF-AIRPORT 45° : 30-60° heading change to off-airport open terrain
//                         when (B) is marginal but (A) terrain is unsuitable.
//
// Choosing (B) without altitude budget kills via stall-spin in the base-to-
// final intercept. Choosing (A) when (B) was clearly available is merely an
// off-airport accident (often survivable). The asymmetry is why AOPA ASI,
// NTSB SR-72-7 and FAA AC 61-83G default to "land straight ahead" unless the
// pilot has briefed, practised and verified the turnback envelope.
//
// REGULATORY: FAA AC 61-83G / FAA-H-8083-3B §16 / FAA-H-8083-25C §3 /
//   14 CFR §91.3(b) / AC 90-66B / AOPA ASI Engine-Out 180 / Boeing FCOM
//   Vol-II §03 / Airbus FCOM ABN-EMER / ICAO Annex 6 Part I §4.4.
// PHYSICS: Möller (1982) Soaring Mag / Rogers AIAA-95-3768 The Possible
//   Impossible Turn / Brandt-Gilliland (2014) / Cox AOPA Pilot 2011 flight
//   test / Lewis NTSB SR-72-7 stall-spin baseline.
// PRECEDENTS: Pinnacle 3701 AAR-07-01 / BA 38 AAIB 1/2010 / TACA 110
//   AAR-89-04 / US1549 AAR-10-03 / AOPA ASI 2016-22 GA fatalities database.
// DISTINCT FROM: EOSID (partial-power), EDR (cruise decompression), GASA
//   (approach), RTO (ground V<V1), SID-CLIMB (normal-ops), ROW-ROP (landing),
//   EMAS, RAAS, LVTO, TOPMS (pre-V1), STBR (approach). TURNBACK is uniquely
//   scoped to TOTAL-POWER-LOSS during the INITIAL-CLIMB envelope (gear-up to
//   ~3000 ft AGL, within ~5 NM of departure airport, vertical rate > 0).
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

// ---- Flight shape (matches flight-map.tsx) ------------------------------
interface F {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  vertRate: number
  track: number
  ground?: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: F[]
  onClose: () => void
  onFly: (icao: string) => void
}

// ---- Tier definitions ---------------------------------------------------
type Tier =
  | 'ABORT-STR'    // below class min-turnback-alt — MUST land straight ahead
  | 'WATCH-GAP'    // above floor but glide margin <10% — turnback marginal
  | 'TURN-225'     // 270° Möller teardrop fits within glide cone, briefed
  | 'OFF-AIRPORT'  // 45° divert preferred (straight-ahead terrain unsuitable)
  | 'ABOVE-FLOOR'  // 1500–3000 ft AGL, turnback feasible but EOSID preferred
  | 'SAFE-MARGIN'  // >3000 ft AGL, normal departure climb, EFATO non-critical
  | 'N-A'          // not in initial-climb phase

const TIER_ORDER: Tier[] = ['ABORT-STR','WATCH-GAP','TURN-225','OFF-AIRPORT','ABOVE-FLOOR','SAFE-MARGIN','N-A']
const TIER_RANK: Record<Tier, number> = {
  'ABORT-STR':0, 'WATCH-GAP':1, 'TURN-225':2, 'OFF-AIRPORT':3,
  'ABOVE-FLOOR':4, 'SAFE-MARGIN':5, 'N-A':6,
}
const TIER_COLOR: Record<Tier, string> = {
  'ABORT-STR':   '#f43f5e', // rose-500   — bound to straight-glide
  'WATCH-GAP':   '#f59e0b', // amber-500  — marginal turnback
  'TURN-225':    '#fb7185', // rose-400   — committed 270° teardrop (still hazardous)
  'OFF-AIRPORT': '#eab308', // yellow-500 — divert to terrain
  'ABOVE-FLOOR': '#0ea5e9', // sky-500    — turnback feasible w/ margin
  'SAFE-MARGIN': '#10b981', // emerald-500 — out of impossible-turn window
  'N-A':         '#64748b', // slate-500
}
const TIER_ABBR: Record<Tier, string> = {
  'ABORT-STR':'STR','WATCH-GAP':'GAP','TURN-225':'T225','OFF-AIRPORT':'OFF',
  'ABOVE-FLOOR':'AFL','SAFE-MARGIN':'SAFE','N-A':'N/A',
}

// ---- Aircraft-type → TURNBACK class ------------------------------------
// Per Rogers AIAA-95-3768 closed form + Cox AOPA flight-test corrections +
// Brandt-Gilliland 2014 empirical envelope.  Each class carries best-glide
// L/D, best-glide speed (KIAS), idealised min-turnback-alt AGL (zero-wind,
// SL, dry, briefed pilot), and a class-policy posture (CIVIL transports
// universally posture toward STRAIGHT-ONLY; GA singles toward briefed
// TURNBACK; helicopters use autorotation, not turnback).
interface TbkClass {
  id: string
  label: string
  category: 'GA-SEP'|'GA-MEP'|'LIGHT-TP'|'REG-TP'|'REG-JET'|'NB-JET'|'WB-JET'|'HEAVY'|'BIZ-JET'|'HELO'
  ldGlide: number            // best-glide L/D ratio clean
  bestGlideKias: number      // best-glide speed at MLW
  minTurnbackAglFt: number   // ideal-pilot min turnback altitude AGL (zero wind)
  policy: 'STRAIGHT-ONLY'|'TURNBACK-BRIEFED'|'AUTOROTATE'|'EOSID-PREF'
  stallVsKt: number          // 1g clean stall (kts) — used for 45°-bank load margin
}

const TBK_CLASS: TbkClass[] = [
  { id:'C172',   label:'C172/PA28 piston single',     category:'GA-SEP',   ldGlide:9,   bestGlideKias:65,  minTurnbackAglFt:700,  policy:'TURNBACK-BRIEFED', stallVsKt:48 },
  { id:'SR22',   label:'SR22/M20 high-perf single',   category:'GA-SEP',   ldGlide:10,  bestGlideKias:88,  minTurnbackAglFt:900,  policy:'TURNBACK-BRIEFED', stallVsKt:62 },
  { id:'BE58',   label:'BE58/PA34 piston twin',       category:'GA-MEP',   ldGlide:9,   bestGlideKias:105, minTurnbackAglFt:1200, policy:'TURNBACK-BRIEFED', stallVsKt:75 },
  { id:'TBM9',   label:'TBM/PC12 light turboprop',    category:'LIGHT-TP', ldGlide:11,  bestGlideKias:125, minTurnbackAglFt:1500, policy:'TURNBACK-BRIEFED', stallVsKt:75 },
  { id:'CJ4',    label:'CJ/PC24/Phenom biz-jet',      category:'BIZ-JET',  ldGlide:13,  bestGlideKias:160, minTurnbackAglFt:2000, policy:'EOSID-PREF',       stallVsKt:90 },
  { id:'AT72',   label:'ATR72/DH8D regional turboprop',category:'REG-TP',  ldGlide:13,  bestGlideKias:160, minTurnbackAglFt:1800, policy:'EOSID-PREF',       stallVsKt:90 },
  { id:'CRJ9',   label:'CRJ/E170/E190 regional jet',  category:'REG-JET',  ldGlide:15,  bestGlideKias:200, minTurnbackAglFt:2500, policy:'STRAIGHT-ONLY',    stallVsKt:115 },
  { id:'B738',   label:'B737/A320 narrowbody',        category:'NB-JET',   ldGlide:17,  bestGlideKias:220, minTurnbackAglFt:3000, policy:'STRAIGHT-ONLY',    stallVsKt:130 },
  { id:'B772',   label:'B777/A330/B787/A350 widebody',category:'WB-JET',   ldGlide:19,  bestGlideKias:250, minTurnbackAglFt:3500, policy:'STRAIGHT-ONLY',    stallVsKt:145 },
  { id:'B744',   label:'B747/A380/B748 heavy',        category:'HEAVY',    ldGlide:17,  bestGlideKias:265, minTurnbackAglFt:4000, policy:'STRAIGHT-ONLY',    stallVsKt:155 },
  { id:'EC35',   label:'EC135/AW139/S76 helicopter',  category:'HELO',     ldGlide:4,   bestGlideKias:80,  minTurnbackAglFt:500,  policy:'AUTOROTATE',       stallVsKt:0  },
]

function classifyType(type: string|undefined, category: string|undefined): TbkClass {
  const t = (type || '').toUpperCase().trim()
  const c = (category || '').toUpperCase().trim()
  if (c.includes('HELI') || t.startsWith('EC') || t.startsWith('AS3') || t.startsWith('AW1') || t.includes('S76') || t.includes('S92') || t.includes('B06') || t.includes('R44')) return TBK_CLASS[10]
  if (t.startsWith('A38') || t.startsWith('B74') || t.startsWith('B77F') || t.includes('A124') || t.includes('A225')) return TBK_CLASS[9]
  if (t.startsWith('B77') || t.startsWith('A33') || t.startsWith('A34') || t.startsWith('A35') || t.startsWith('B78') || t.startsWith('B76') || t.startsWith('A30') || t.startsWith('A31') || t.startsWith('MD11') || t.startsWith('IL96')) return TBK_CLASS[8]
  if (t.startsWith('B73') || t.startsWith('A31') || t.startsWith('A32') || t.startsWith('A22') || t.startsWith('A21') || t.startsWith('A20') || t.startsWith('B71') || t.startsWith('B72') || t.startsWith('MD8') || t.startsWith('MD9') || t.includes('TU20') || t.includes('IL62')) return TBK_CLASS[7]
  if (t.startsWith('CRJ') || t.startsWith('E17') || t.startsWith('E19') || t.startsWith('E14') || t.startsWith('E13') || t.startsWith('E75') || t.startsWith('E55') || t.startsWith('SU95') || t.startsWith('B46') || t.startsWith('RJ1')) return TBK_CLASS[6]
  if (t.startsWith('AT4') || t.startsWith('AT7') || t.startsWith('DH8') || t.startsWith('SF34') || t.startsWith('SF50') || t.startsWith('SB20') || t.startsWith('JS41') || t.startsWith('BE20') || t.startsWith('BE9')) return TBK_CLASS[5]
  if (t.startsWith('C25') || t.startsWith('C56') || t.startsWith('C68') || t.startsWith('LJ') || t.startsWith('PC24') || t.startsWith('GLEX') || t.startsWith('GLF') || t.startsWith('CL30') || t.startsWith('CL35') || t.startsWith('CL60') || t.startsWith('PH3') || t.startsWith('E50P') || t.startsWith('E55P')) return TBK_CLASS[4]
  if (t.startsWith('TBM') || t.startsWith('PC12') || t.startsWith('PC6') || t.startsWith('P46T') || t.startsWith('CC19')) return TBK_CLASS[3]
  if (t.startsWith('BE58') || t.startsWith('BE55') || t.startsWith('PA34') || t.startsWith('PA31') || t.startsWith('C310') || t.startsWith('C402') || t.startsWith('C404') || t.startsWith('C414')) return TBK_CLASS[2]
  if (t.startsWith('SR2') || t.startsWith('M20') || t.startsWith('BE36') || t.startsWith('BE33') || t.startsWith('C20') || t.startsWith('C21') || t.startsWith('PA32')) return TBK_CLASS[1]
  if (t.startsWith('C17') || t.startsWith('C15') || t.startsWith('C18') || t.startsWith('PA28') || t.startsWith('DA40') || t.startsWith('DA20') || t.startsWith('AA5') || t.startsWith('GR') || t.startsWith('TECN') || t.startsWith('CTSW') || t.startsWith('P28')) return TBK_CLASS[0]
  // Fallback by category
  if (c.includes('HEAVY')) return TBK_CLASS[9]
  if (c.includes('LARGE') || c.includes('B5')) return TBK_CLASS[7]
  if (c.includes('SMALL') || c.includes('B1') || c.includes('B2')) return TBK_CLASS[0]
  return TBK_CLASS[7] // default narrowbody
}

// ---- Airport + primary runway catalogue --------------------------------
// 32 hubs / busy GA fields with primary runway QFU magnetic, length feet,
// field elevation (used for AGL conversion).  Threshold position is the
// airport reference point as a coarse proxy (~1 NM error tolerable for the
// 5 NM scope envelope).  Runway pair is symbol-only (turnback flies the
// reciprocal QFU+180).
interface AirportTbk {
  icao: string
  iata: string
  name: string
  region: 'NA-US'|'NA-CA'|'EU'|'UK'|'ASIA'|'PAC'|'ME'|'LATAM'
  elevFt: number
  primaryRwyQfu: number      // climb-out runway magnetic heading
  rwyLengthFt: number
  terrain: 'BENIGN'|'URBAN'|'WATER'|'MOUNTAIN'|'MIXED'  // straight-ahead character
  lat: number
  lng: number
}

const AIRPORTS: AirportTbk[] = [
  { icao:'KJFK', iata:'JFK', name:'New York JFK',        region:'NA-US', elevFt:13,   primaryRwyQfu:130, rwyLengthFt:14511, terrain:'WATER',    lat:40.6398, lng:-73.7789 },
  { icao:'KLGA', iata:'LGA', name:'New York LaGuardia',  region:'NA-US', elevFt:21,   primaryRwyQfu:40,  rwyLengthFt:7003,  terrain:'WATER',    lat:40.7772, lng:-73.8726 },
  { icao:'KEWR', iata:'EWR', name:'Newark Liberty',      region:'NA-US', elevFt:18,   primaryRwyQfu:40,  rwyLengthFt:11000, terrain:'URBAN',    lat:40.6925, lng:-74.1687 },
  { icao:'KBOS', iata:'BOS', name:'Boston Logan',        region:'NA-US', elevFt:20,   primaryRwyQfu:40,  rwyLengthFt:10005, terrain:'WATER',    lat:42.3656, lng:-71.0096 },
  { icao:'KATL', iata:'ATL', name:'Atlanta',             region:'NA-US', elevFt:1026, primaryRwyQfu:90,  rwyLengthFt:12390, terrain:'URBAN',    lat:33.6407, lng:-84.4277 },
  { icao:'KMIA', iata:'MIA', name:'Miami',               region:'NA-US', elevFt:8,    primaryRwyQfu:90,  rwyLengthFt:13016, terrain:'URBAN',    lat:25.7959, lng:-80.2870 },
  { icao:'KORD', iata:'ORD', name:'Chicago O\u2019Hare', region:'NA-US', elevFt:672,  primaryRwyQfu:100, rwyLengthFt:13000, terrain:'URBAN',    lat:41.9786, lng:-87.9048 },
  { icao:'KDFW', iata:'DFW', name:'Dallas/Fort Worth',   region:'NA-US', elevFt:607,  primaryRwyQfu:180, rwyLengthFt:13401, terrain:'BENIGN',   lat:32.8998, lng:-97.0403 },
  { icao:'KIAH', iata:'IAH', name:'Houston Intercont.',  region:'NA-US', elevFt:97,   primaryRwyQfu:90,  rwyLengthFt:12001, terrain:'BENIGN',   lat:29.9844, lng:-95.3414 },
  { icao:'KDEN', iata:'DEN', name:'Denver',              region:'NA-US', elevFt:5434, primaryRwyQfu:170, rwyLengthFt:16000, terrain:'BENIGN',   lat:39.8617, lng:-104.6731 },
  { icao:'KLAX', iata:'LAX', name:'Los Angeles',         region:'NA-US', elevFt:125,  primaryRwyQfu:250, rwyLengthFt:12091, terrain:'WATER',    lat:33.9416, lng:-118.4085 },
  { icao:'KSFO', iata:'SFO', name:'San Francisco',       region:'NA-US', elevFt:13,   primaryRwyQfu:280, rwyLengthFt:11870, terrain:'WATER',    lat:37.6189, lng:-122.3750 },
  { icao:'KSEA', iata:'SEA', name:'Seattle-Tacoma',      region:'NA-US', elevFt:433,  primaryRwyQfu:160, rwyLengthFt:11900, terrain:'URBAN',    lat:47.4502, lng:-122.3088 },
  { icao:'KSAN', iata:'SAN', name:'San Diego',           region:'NA-US', elevFt:17,   primaryRwyQfu:270, rwyLengthFt:9401,  terrain:'URBAN',    lat:32.7338, lng:-117.1933 },
  { icao:'KASE', iata:'ASE', name:'Aspen-Pitkin',        region:'NA-US', elevFt:7820, primaryRwyQfu:330, rwyLengthFt:8006,  terrain:'MOUNTAIN', lat:39.2232, lng:-106.8688 },
  { icao:'CYYZ', iata:'YYZ', name:'Toronto Pearson',     region:'NA-CA', elevFt:569,  primaryRwyQfu:50,  rwyLengthFt:11120, terrain:'URBAN',    lat:43.6772, lng:-79.6306 },
  { icao:'CYVR', iata:'YVR', name:'Vancouver',           region:'NA-CA', elevFt:14,   primaryRwyQfu:80,  rwyLengthFt:11500, terrain:'WATER',    lat:49.1939, lng:-123.1844 },
  { icao:'EGLL', iata:'LHR', name:'London Heathrow',     region:'UK',    elevFt:83,   primaryRwyQfu:90,  rwyLengthFt:12802, terrain:'URBAN',    lat:51.4775, lng:-0.4614 },
  { icao:'EGKK', iata:'LGW', name:'London Gatwick',      region:'UK',    elevFt:202,  primaryRwyQfu:80,  rwyLengthFt:10879, terrain:'MIXED',    lat:51.1481, lng:-0.1903 },
  { icao:'EHAM', iata:'AMS', name:'Amsterdam Schiphol',  region:'EU',    elevFt:-11,  primaryRwyQfu:60,  rwyLengthFt:11329, terrain:'BENIGN',   lat:52.3086, lng:4.7639 },
  { icao:'EDDF', iata:'FRA', name:'Frankfurt',           region:'EU',    elevFt:364,  primaryRwyQfu:70,  rwyLengthFt:13123, terrain:'MIXED',    lat:50.0379, lng:8.5622 },
  { icao:'LFPG', iata:'CDG', name:'Paris CDG',           region:'EU',    elevFt:392,  primaryRwyQfu:80,  rwyLengthFt:13829, terrain:'BENIGN',   lat:49.0097, lng:2.5479 },
  { icao:'LSZH', iata:'ZRH', name:'Z\u00fcrich',         region:'EU',    elevFt:1416, primaryRwyQfu:140, rwyLengthFt:12139, terrain:'MOUNTAIN', lat:47.4647, lng:8.5492 },
  { icao:'EDDM', iata:'MUC', name:'M\u00fcnchen',        region:'EU',    elevFt:1487, primaryRwyQfu:80,  rwyLengthFt:13123, terrain:'MIXED',    lat:48.3538, lng:11.7861 },
  { icao:'LEMD', iata:'MAD', name:'Madrid Barajas',      region:'EU',    elevFt:1998, primaryRwyQfu:140, rwyLengthFt:13780, terrain:'BENIGN',   lat:40.4936, lng:-3.5668 },
  { icao:'LIRF', iata:'FCO', name:'Roma Fiumicino',      region:'EU',    elevFt:13,   primaryRwyQfu:160, rwyLengthFt:12795, terrain:'WATER',    lat:41.8003, lng:12.2389 },
  { icao:'RJTT', iata:'HND', name:'Tokyo Haneda',        region:'ASIA',  elevFt:35,   primaryRwyQfu:160, rwyLengthFt:9842,  terrain:'WATER',    lat:35.5494, lng:139.7798 },
  { icao:'RKSI', iata:'ICN', name:'Seoul Incheon',       region:'ASIA',  elevFt:23,   primaryRwyQfu:160, rwyLengthFt:12303, terrain:'WATER',    lat:37.4691, lng:126.4505 },
  { icao:'VHHH', iata:'HKG', name:'Hong Kong',           region:'ASIA',  elevFt:28,   primaryRwyQfu:70,  rwyLengthFt:12467, terrain:'MOUNTAIN', lat:22.3080, lng:113.9185 },
  { icao:'WSSS', iata:'SIN', name:'Singapore Changi',    region:'ASIA',  elevFt:22,   primaryRwyQfu:20,  rwyLengthFt:13123, terrain:'WATER',    lat:1.3644,  lng:103.9915 },
  { icao:'OMDB', iata:'DXB', name:'Dubai',               region:'ME',    elevFt:62,   primaryRwyQfu:120, rwyLengthFt:13123, terrain:'BENIGN',   lat:25.2532, lng:55.3657 },
  { icao:'YSSY', iata:'SYD', name:'Sydney',              region:'PAC',   elevFt:21,   primaryRwyQfu:160, rwyLengthFt:13000, terrain:'WATER',    lat:-33.9461,lng:151.1772 },
]

// ---- Geometry ----------------------------------------------------------
const R_NM = 3440.065
function haversineNM(a1: number, o1: number, a2: number, o2: number): number {
  const φ1 = a1 * Math.PI / 180, φ2 = a2 * Math.PI / 180
  const dφ = (a2 - a1) * Math.PI / 180, dλ = (o2 - o1) * Math.PI / 180
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
function bearingDeg(a1: number, o1: number, a2: number, o2: number): number {
  const φ1 = a1*Math.PI/180, φ2 = a2*Math.PI/180
  const dλ = (o2 - o1) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(dλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}
function destPoint(lat: number, lng: number, brgDeg: number, distNM: number): [number, number] {
  const δ = distNM / R_NM
  const θ = brgDeg * Math.PI / 180
  const φ1 = lat * Math.PI / 180, λ1 = lng * Math.PI / 180
  const φ2 = Math.asin(Math.sin(φ1)*Math.cos(δ) + Math.cos(φ1)*Math.sin(δ)*Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ)*Math.sin(δ)*Math.cos(φ1), Math.cos(δ) - Math.sin(φ1)*Math.sin(φ2))
  return [(λ2 * 180 / Math.PI + 540) % 360 - 180, φ2 * 180 / Math.PI]
}
function hash(s: string): number {
  let h = 5381; for (let i=0;i<s.length;i++) h = ((h<<5)+h) ^ s.charCodeAt(i); return h>>>0
}

// ---- Airport snap ------------------------------------------------------
interface AirportSnap { apt: AirportTbk; distNM: number; alignedDeg: number; trackToApt: number }

function snapAirport(f: F): AirportSnap | null {
  let best: AirportSnap | null = null
  for (const apt of AIRPORTS) {
    const d = haversineNM(f.lat, f.lng, apt.lat, apt.lng)
    if (d > 8) continue
    const brgFromApt = bearingDeg(apt.lat, apt.lng, f.lat, f.lng)
    // Climb-out alignment: track within ±35° of runway QFU and bearing-from-airport within ±35° of QFU
    const trackErr = Math.abs(((f.track - apt.primaryRwyQfu + 540) % 360) - 180)
    const brgErr = Math.abs(((brgFromApt - apt.primaryRwyQfu + 540) % 360) - 180)
    if (trackErr > 60 || brgErr > 60) continue
    if (!best || d < best.distNM) best = { apt, distNM: d, alignedDeg: Math.max(trackErr, brgErr), trackToApt: (brgFromApt + 180) % 360 }
  }
  return best
}

// ---- Phase classification ----------------------------------------------
type Phase = 'INITIAL-CLIMB' | 'CRUISE' | 'APPROACH' | 'GROUND' | 'OTHER'

function classifyPhase(f: F, snap: AirportSnap | null): Phase {
  if (f.ground) return 'GROUND'
  const aglFt = snap ? Math.max(0, f.altitudeFt - snap.apt.elevFt) : f.altitudeFt
  if (!snap) return aglFt > 10000 ? 'CRUISE' : 'OTHER'
  if (aglFt > 5000) return 'CRUISE'
  if (f.vertRate < -200) return 'APPROACH'
  if (aglFt < 50) return 'GROUND'
  if (f.vertRate >= 0 && aglFt <= 5000 && snap.distNM <= 8) return 'INITIAL-CLIMB'
  return 'OTHER'
}

// ---- TURNBACK evaluation (per-airframe physics) ------------------------
interface TbkEval {
  inScope: boolean
  aglFt: number
  glideReachNM: number          // straight-line glide range from current alt
  minTurnbackAglFt: number      // class min adjusted for density-alt + wind
  turnbackFeasible: boolean
  teardropRadiusFt: number      // 45°-bank turn radius at best-glide
  teardropAltLossFt: number     // ideal 225° heading-change alt loss
  rollInRollOutAltFt: number    // reaction + roll-in/out alt penalty (Brandt)
  totalTurnbackAltReqFt: number // full envelope alt req (teardrop+rollouts+reaction)
  marginFt: number              // aglFt - totalTurnbackAltReqFt (negative = abort)
  marginPct: number             // marginFt / totalTurnbackAltReqFt × 100
  reciprocalQfu: number         // QFU of return runway
  bearingToThreshold: number    // bearing from aircraft to opposite threshold
  distToThresholdNM: number
  glideAdequate: boolean        // glideReachNM ≥ distToThresholdNM × 1.1
  reason: string
  windHeadFromDep: number       // synthesized head/tail component on departure (kt)
  densAltFt: number             // synthesized density altitude
  stallAt45BankKt: number       // Vs × sqrt(1/cos(45°)) = Vs × 1.19
  bankLoadMarginKt: number      // bestGlide − stallAt45Bank (positive = safe)
}

function evalTurnback(f: F, cls: TbkClass, snap: AirportSnap | null): TbkEval {
  if (!snap) {
    return {
      inScope:false, aglFt:0, glideReachNM:0, minTurnbackAglFt:cls.minTurnbackAglFt,
      turnbackFeasible:false, teardropRadiusFt:0, teardropAltLossFt:0,
      rollInRollOutAltFt:0, totalTurnbackAltReqFt:0, marginFt:0, marginPct:0,
      reciprocalQfu:0, bearingToThreshold:0, distToThresholdNM:0, glideAdequate:false,
      reason:'Not in initial-climb envelope of any catalogued departure airport.',
      windHeadFromDep:0, densAltFt:0, stallAt45BankKt:0, bankLoadMarginKt:0,
    }
  }
  const aglFt = Math.max(0, f.altitudeFt - snap.apt.elevFt)
  // Synthesized wind component (deterministic from airframe + airport)
  const wseed = hash(f.icao + snap.apt.icao)
  const windHeadFromDep = ((wseed % 21) - 10)            // -10..+10 kt
  const densAltFt = snap.apt.elevFt + ((wseed >> 5) % 1500)  // +0..1500 ft DA on top of elev

  // Class min-turnback-alt, adjusted:
  //   +15 ft / kt tailwind on return (= headwind on dep)
  //   +1% per 1000 ft DA
  const windAdj = Math.max(0, windHeadFromDep) * 15      // headwind dep = tailwind back = penalty
  const daAdj = cls.minTurnbackAglFt * (densAltFt / 100000)
  const minTurnbackAglFt = Math.round(cls.minTurnbackAglFt + windAdj + daAdj)

  // 45° bank turn radius at best-glide speed
  //   r [ft] = (Vtas[fps])² / (g · tan(45°))  with g=32.17 ft/s²
  //   Vtas[fps] ≈ Vkias × 1.688 (ignore TAS correction for initial-climb low-alt)
  const vtasFps = cls.bestGlideKias * 1.688
  const teardropRadiusFt = (vtasFps * vtasFps) / 32.17

  // 225° heading-change alt loss = (225/360) · 2π·r · (1/L_over_D)
  //   = (5π/4) · r / LD
  const teardropAltLossFt = (5 * Math.PI / 4) * teardropRadiusFt / cls.ldGlide

  // Reaction + roll-in (3s @ vert sink) + roll-out (~2s) + 45° intercept extra ~1/8 arc
  //   sink at best-glide ≈ Vtas × sin(arctan(1/LD))
  const sinkFps = vtasFps * Math.sin(Math.atan(1 / cls.ldGlide))
  const reactionAltFt = 3 * sinkFps                    // 3-sec startle (Brandt-Gilliland)
  const rollAltFt = 2 * sinkFps                        // bank-in + bank-out
  const interceptArcAltFt = (Math.PI / 4) * teardropRadiusFt / cls.ldGlide
  const rollInRollOutAltFt = Math.round(reactionAltFt + rollAltFt + interceptArcAltFt)

  const totalTurnbackAltReqFt = Math.round(minTurnbackAglFt) // already incorporates teardrop+reactions empirically per Cox/Rogers
  const marginFt = aglFt - totalTurnbackAltReqFt
  const marginPct = totalTurnbackAltReqFt > 0 ? (marginFt / totalTurnbackAltReqFt) * 100 : 0

  // Glide reach from current AGL: range_NM = aglFt × LD / 6076.115
  const glideReachNM = (aglFt * cls.ldGlide) / 6076.115

  // Reciprocal QFU + bearing/dist to threshold (airport ref as proxy)
  const reciprocalQfu = (snap.apt.primaryRwyQfu + 180) % 360
  const bearingToThreshold = bearingDeg(f.lat, f.lng, snap.apt.lat, snap.apt.lng)
  const distToThresholdNM = snap.distNM
  const glideAdequate = glideReachNM >= distToThresholdNM * 1.1

  // 45° bank stall (load factor 1.41g) → Vs × 1.19
  const stallAt45BankKt = cls.stallVsKt * 1.19
  const bankLoadMarginKt = cls.bestGlideKias - stallAt45BankKt

  const turnbackFeasible = marginFt >= 0 && glideAdequate && cls.policy !== 'STRAIGHT-ONLY' && cls.policy !== 'AUTOROTATE'

  let reason = ''
  if (cls.policy === 'AUTOROTATE') reason = `Rotary-wing — autorotation profile, not impossible-turn. Land within ${(glideReachNM*0.6).toFixed(1)} NM glide cone.`
  else if (aglFt > 3500) reason = `Above ${aglFt.toFixed(0)} ft AGL — out of impossible-turn window, normal EOSID applies.`
  else if (cls.policy === 'STRAIGHT-ONLY') reason = `Transport ${cls.category} — total-flameout doctrine = land straight ahead (Sully/TACA/BA38 precedent). EOSID handles partial-power OEI.`
  else if (marginFt < 0) reason = `Below class min-turnback AGL (${totalTurnbackAltReqFt} ft adj). ABORT-STRAIGHT — land within ±30° cone, glide reach ${glideReachNM.toFixed(1)} NM.`
  else if (marginPct < 10) reason = `Marginal turnback — only ${marginFt.toFixed(0)} ft above floor (${marginPct.toFixed(0)}%). Consider OFF-AIRPORT 45° to ${snap.apt.terrain.toLowerCase()} terrain.`
  else if (!glideAdequate) reason = `Glide reach ${glideReachNM.toFixed(1)} NM insufficient for ${distToThresholdNM.toFixed(1)} NM return — divert to off-airport.`
  else reason = `Turnback feasible — ${marginFt.toFixed(0)} ft margin (${marginPct.toFixed(0)}%), 270° teardrop r=${teardropRadiusFt.toFixed(0)} ft, intercept QFU ${reciprocalQfu.toFixed(0)}°.`

  return {
    inScope:true, aglFt, glideReachNM, minTurnbackAglFt, turnbackFeasible,
    teardropRadiusFt, teardropAltLossFt, rollInRollOutAltFt, totalTurnbackAltReqFt,
    marginFt, marginPct, reciprocalQfu, bearingToThreshold, distToThresholdNM,
    glideAdequate, reason, windHeadFromDep, densAltFt, stallAt45BankKt, bankLoadMarginKt,
  }
}

// ---- Driver decomposition (0-100 hazard contribution) -----------------
interface Drivers {
  aglMargin: number       // closeness to or below class floor
  glideReach: number      // shortfall vs required threshold dist
  windPenalty: number     // headwind dep / tailwind back penalty
  densAlt: number         // density-altitude penalty
  bankLoad: number        // stall margin at 45° bank deficit
  classFactor: number     // category penalty (transport jet ≫ light single)
  terrain: number         // straight-ahead terrain unsuitability
  policyDeviation: number // turnback attempt by STRAIGHT-ONLY class
}

function computeDrivers(e: TbkEval, cls: TbkClass, snap: AirportSnap | null): Drivers {
  if (!e.inScope) return { aglMargin:0, glideReach:0, windPenalty:0, densAlt:0, bankLoad:0, classFactor:0, terrain:0, policyDeviation:0 }
  const aglMargin = e.marginFt < 0 ? 100 : Math.max(0, 80 - e.marginPct * 2)
  const glideReach = e.glideAdequate ? 0 : Math.min(100, ((e.distToThresholdNM - e.glideReachNM) / Math.max(0.1, e.distToThresholdNM)) * 100)
  const windPenalty = Math.min(100, Math.max(0, e.windHeadFromDep * 7))
  const densAlt = Math.min(100, Math.max(0, (e.densAltFt - 1000) / 60))
  const bankLoad = e.bankLoadMarginKt < 5 ? 100 : e.bankLoadMarginKt < 15 ? 60 : e.bankLoadMarginKt < 25 ? 25 : 0
  const classFactor = cls.category === 'HEAVY' ? 95 : cls.category === 'WB-JET' ? 85 : cls.category === 'NB-JET' ? 70 : cls.category === 'REG-JET' ? 55 : cls.category === 'BIZ-JET' ? 40 : cls.category === 'REG-TP' ? 35 : cls.category === 'LIGHT-TP' ? 25 : cls.category === 'GA-MEP' ? 20 : cls.category === 'GA-SEP' ? 10 : 0
  const terrain = snap ? (snap.apt.terrain === 'MOUNTAIN' ? 85 : snap.apt.terrain === 'URBAN' ? 70 : snap.apt.terrain === 'WATER' ? 35 : snap.apt.terrain === 'MIXED' ? 45 : 15) : 0
  const policyDeviation = (cls.policy === 'STRAIGHT-ONLY' && e.aglFt < 1500) ? 80 : (cls.policy === 'AUTOROTATE' ? 0 : 0)
  return { aglMargin, glideReach, windPenalty, densAlt, bankLoad, classFactor, terrain, policyDeviation }
}

function composite(d: Drivers, advMul: number): number {
  const hard = Math.max(d.aglMargin, d.glideReach, d.bankLoad, d.policyDeviation)
  const soft = (d.windPenalty + d.densAlt + d.terrain + d.classFactor) / 4
  return Math.min(100, (hard * 0.65 + soft * 0.35) * advMul)
}

function scoreToTier(score: number, e: TbkEval, cls: TbkClass): Tier {
  if (!e.inScope) return 'N-A'
  if (e.aglFt > 3500) return 'SAFE-MARGIN'
  if (cls.policy === 'AUTOROTATE') return 'ABORT-STR'
  if (cls.policy === 'STRAIGHT-ONLY' && e.aglFt < 1500) return 'ABORT-STR'
  if (e.marginFt < 0) return 'ABORT-STR'
  if (e.marginPct < 10 || !e.glideAdequate) return 'WATCH-GAP'
  if (e.aglFt >= 1500 && e.aglFt <= 3500) return 'ABOVE-FLOOR'
  if (cls.policy === 'EOSID-PREF') return 'OFF-AIRPORT'
  return 'TURN-225'
}

// ---- Row aggregation --------------------------------------------------
interface Row {
  f: F
  cls: TbkClass
  apt: AirportTbk | null
  snap: AirportSnap | null
  ev: TbkEval
  drivers: Drivers
  score: number
  tier: Tier
  phase: Phase
}

export default function TurnbackMonitor({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<string>('ALL')
  const [regionFilter, setRegionFilter] = useState<string>('ALL')
  const [advMul, setAdvMul] = useState<number>(1.0)
  const [shHalo, setShHalo] = useState<boolean>(true)
  const [shPin, setShPin]   = useState<boolean>(true)
  const [shLbl, setShLbl]   = useState<boolean>(true)
  const [shCone, setShCone] = useState<boolean>(true)
  const [shTeardrop, setShTeardrop] = useState<boolean>(true)
  const [shApt, setShApt]   = useState<boolean>(false)
  const [search, setSearch] = useState<string>('')
  const [picked, setPicked] = useState<string|null>(null)
  const [tab, setTab] = useState<'AIRCRAFT'|'AIRPORTS'|'DRIVERS'|'METHOD'>('AIRCRAFT')

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const cls = classifyType(f.type, f.category)
      const snap = snapAirport(f)
      const phase = classifyPhase(f, snap)
      const ev = evalTurnback(f, cls, snap)
      const drivers = computeDrivers(ev, cls, snap)
      const score = composite(drivers, advMul)
      const tier = scoreToTier(score, ev, cls)
      if (tier === 'N-A' && phase !== 'INITIAL-CLIMB') continue
      out.push({ f, cls, apt: snap?.apt ?? null, snap, ev, drivers, score, tier, phase })
    }
    out.sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, advMul])

  // ---- MapLibre overlay layers -----------------------------------------
  useEffect(() => {
    if (!map) return
    const SRC_AC = 'tbk-ac-src'
    const SRC_APT = 'tbk-apt-src'
    const SRC_LINK = 'tbk-link-src'
    const SRC_CONE = 'tbk-cone-src'
    const SRC_TEAR = 'tbk-tear-src'
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any }) }
    ;[SRC_AC, SRC_APT, SRC_LINK, SRC_CONE, SRC_TEAR].forEach(ensure)

    const view = rows.filter(r =>
      (tierFilter === 'ALL' || r.tier === tierFilter) &&
      (classFilter === 'ALL' || r.cls.category === classFilter) &&
      (regionFilter === 'ALL' || (r.apt && r.apt.region === regionFilter))
    )

    const acFeat: any[] = []
    const linkFeat: any[] = []
    const coneFeat: any[] = []
    const tearFeat: any[] = []
    for (const r of view) {
      if (!r.ev.inScope) continue
      acFeat.push({
        type:'Feature',
        geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
        properties:{
          tier: r.tier,
          color: TIER_COLOR[r.tier],
          score: r.score,
          sz: 6 + (r.score/100) * 14,
          label: `${(r.f.callsign||r.f.icao).trim()} ${TIER_ABBR[r.tier]} ${(r.apt?.iata||'')} ${r.ev.aglFt.toFixed(0)}AGL`,
        },
      })
      if (r.apt) {
        linkFeat.push({
          type:'Feature',
          geometry:{ type:'LineString', coordinates:[ [r.f.lng, r.f.lat], [r.apt.lng, r.apt.lat] ] },
          properties:{ color: TIER_COLOR[r.tier] },
        })
      }
      // Forward glide cone: 60° wedge along track at glide reach
      if (shCone && r.ev.glideReachNM > 0.05) {
        const pts: [number, number][] = [[r.f.lng, r.f.lat]]
        for (let a = -30; a <= 30; a += 5) {
          pts.push(destPoint(r.f.lat, r.f.lng, (r.f.track + a + 360) % 360, r.ev.glideReachNM))
        }
        pts.push([r.f.lng, r.f.lat])
        coneFeat.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[pts] }, properties:{ color: TIER_COLOR[r.tier] } })
      }
      // 270° teardrop arc projection (right turn 225° + 45° intercept back)
      if (shTeardrop && r.ev.turnbackFeasible && r.cls.policy !== 'STRAIGHT-ONLY' && r.cls.policy !== 'AUTOROTATE') {
        const rNM = r.ev.teardropRadiusFt / 6076.115
        const trk = r.f.track
        // Right-turn teardrop: center at 90° right of current track, radius rNM
        const [cLng, cLat] = destPoint(r.f.lat, r.f.lng, (trk + 90) % 360, rNM)
        const arc: [number, number][] = []
        // Sweep 225° clockwise starting from current position bearing -90 from center
        const startBrg = (trk - 90 + 360) % 360
        for (let θ = 0; θ <= 225; θ += 10) {
          arc.push(destPoint(cLat, cLng, (startBrg + θ + 360) % 360, rNM))
        }
        tearFeat.push({ type:'Feature', geometry:{ type:'LineString', coordinates: arc }, properties:{ color: TIER_COLOR[r.tier] } })
      }
    }
    const aptFeat = shApt ? AIRPORTS
      .filter(a => regionFilter === 'ALL' || a.region === regionFilter)
      .map(a => ({
        type:'Feature' as const,
        geometry:{ type:'Point' as const, coordinates:[a.lng, a.lat] },
        properties:{
          label: `${a.iata}·${a.terrain.slice(0,3)}·${a.elevFt}ft·R${a.primaryRwyQfu.toString().padStart(3,'0')}`,
          color: a.terrain === 'MOUNTAIN' ? '#f59e0b' : a.terrain === 'WATER' ? '#0ea5e9' : a.terrain === 'URBAN' ? '#94a3b8' : '#10b981',
        },
      })) : []

    ;(map.getSource(SRC_AC) as any).setData({ type:'FeatureCollection', features: (shHalo||shPin||shLbl) ? acFeat : [] })
    ;(map.getSource(SRC_APT) as any).setData({ type:'FeatureCollection', features: aptFeat })
    ;(map.getSource(SRC_LINK) as any).setData({ type:'FeatureCollection', features: (shHalo||shPin) ? linkFeat : [] })
    ;(map.getSource(SRC_CONE) as any).setData({ type:'FeatureCollection', features: coneFeat })
    ;(map.getSource(SRC_TEAR) as any).setData({ type:'FeatureCollection', features: tearFeat })

    if (!map.getLayer('tbk-cone'))
      map.addLayer({ id:'tbk-cone', type:'fill', source:SRC_CONE, paint:{ 'fill-color':['get','color'], 'fill-opacity':0.10, 'fill-outline-color':['get','color'] } })
    if (!map.getLayer('tbk-tear'))
      map.addLayer({ id:'tbk-tear', type:'line', source:SRC_TEAR, paint:{ 'line-color':['get','color'], 'line-width':1.6, 'line-opacity':0.75, 'line-dasharray':[3,2] } })
    if (!map.getLayer('tbk-apt-pin'))
      map.addLayer({ id:'tbk-apt-pin', type:'circle', source:SRC_APT, paint:{ 'circle-radius':5, 'circle-color':['get','color'], 'circle-opacity':0.55, 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('tbk-apt-lbl'))
      map.addLayer({ id:'tbk-apt-lbl', type:'symbol', source:SRC_APT, layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,-1.4], 'text-anchor':'bottom', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#cbd5e1', 'text-halo-color':'#0b0f17', 'text-halo-width':1.0 } })
    if (!map.getLayer('tbk-link'))
      map.addLayer({ id:'tbk-link', type:'line', source:SRC_LINK, paint:{ 'line-color':['get','color'], 'line-width':1.0, 'line-opacity':0.45, 'line-dasharray':[2,2] } })
    if (!map.getLayer('tbk-halo'))
      map.addLayer({ id:'tbk-halo', type:'circle', source:SRC_AC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('tbk-pin'))
      map.addLayer({ id:'tbk-pin', type:'circle', source:SRC_AC, filter:['>=', ['get','score'], 30], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('tbk-lbl'))
      map.addLayer({ id:'tbk-lbl', type:'symbol', source:SRC_AC, filter:['>=', ['get','score'], 20], layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.5], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.3 } })

    return () => {
      for (const id of ['tbk-lbl','tbk-pin','tbk-halo','tbk-link','tbk-apt-lbl','tbk-apt-pin','tbk-tear','tbk-cone']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC_AC, SRC_APT, SRC_LINK, SRC_CONE, SRC_TEAR]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, classFilter, regionFilter, shHalo, shPin, shLbl, shCone, shTeardrop, shApt])

  // ---- Aggregations ----------------------------------------------------
  const visible = rows.filter(r =>
    (tierFilter === 'ALL' || r.tier === tierFilter) &&
    (classFilter === 'ALL' || r.cls.category === classFilter) &&
    (regionFilter === 'ALL' || (r.apt && r.apt.region === regionFilter)) &&
    (!search || (
      (r.f.callsign || r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.apt?.iata || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.apt?.icao || '').toLowerCase().includes(search.toLowerCase()) ||
      r.cls.id.toLowerCase().includes(search.toLowerCase())
    ))
  )
  const counts: Record<Tier, number> = { 'ABORT-STR':0,'WATCH-GAP':0,'TURN-225':0,'OFF-AIRPORT':0,'ABOVE-FLOOR':0,'SAFE-MARGIN':0,'N-A':0 }
  for (const r of rows) counts[r.tier]++
  const inScopeN = rows.filter(r => r.ev.inScope).length
  const aborts = counts['ABORT-STR']
  const turnbacks = counts['TURN-225'] + counts['OFF-AIRPORT']
  const safeN = counts['SAFE-MARGIN'] + counts['ABOVE-FLOOR']

  const aptAgg = useMemo(() => {
    const m = new Map<string, { count: number; abort: number; turn: number; safe: number }>()
    for (const r of rows) {
      if (!r.apt) continue
      const v = m.get(r.apt.icao) || { count:0, abort:0, turn:0, safe:0 }
      v.count++
      if (r.tier === 'ABORT-STR' || r.tier === 'WATCH-GAP') v.abort++
      if (r.tier === 'TURN-225' || r.tier === 'OFF-AIRPORT') v.turn++
      if (r.tier === 'SAFE-MARGIN' || r.tier === 'ABOVE-FLOOR') v.safe++
      m.set(r.apt.icao, v)
    }
    return Array.from(m.entries()).map(([k, v]) => {
      const apt = AIRPORTS.find(a => a.icao === k)!
      return { apt, ...v }
    }).sort((a,b) => b.abort - a.abort || b.count - a.count)
  }, [rows])

  const driverAvg = useMemo(() => {
    const inS = rows.filter(r => r.ev.inScope)
    if (!inS.length) return { aglMargin:0, glideReach:0, windPenalty:0, densAlt:0, bankLoad:0, classFactor:0, terrain:0, policyDeviation:0 }
    const n = inS.length
    return {
      aglMargin:       inS.reduce((a,r)=>a+r.drivers.aglMargin,0)/n,
      glideReach:      inS.reduce((a,r)=>a+r.drivers.glideReach,0)/n,
      windPenalty:     inS.reduce((a,r)=>a+r.drivers.windPenalty,0)/n,
      densAlt:         inS.reduce((a,r)=>a+r.drivers.densAlt,0)/n,
      bankLoad:        inS.reduce((a,r)=>a+r.drivers.bankLoad,0)/n,
      classFactor:     inS.reduce((a,r)=>a+r.drivers.classFactor,0)/n,
      terrain:         inS.reduce((a,r)=>a+r.drivers.terrain,0)/n,
      policyDeviation: inS.reduce((a,r)=>a+r.drivers.policyDeviation,0)/n,
    }
  }, [rows])

  return (
    <div className="fixed top-16 right-3 z-40 w-[500px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">

      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">TURNBACK</span>
          <span className="text-[10px] text-slate-400 truncate">EFATO Impossible-Turn · 270° Möller Teardrop · FAA AC 61-83G · Rogers AIAA</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none ml-2">×</button>
      </div>

      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.slice(0,6).map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className="flex-1 px-1 py-1 rounded text-[9px] font-mono border min-w-0"
            style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:'transparent', color: TIER_COLOR[t] }}>
            <span className="truncate">{TIER_ABBR[t]}</span> {counts[t]}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">SCOPE</div><div className="font-mono text-sky-300">{inScopeN}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">ABORT</div><div className="font-mono" style={{color: aborts>0?'#f43f5e':'#64748b'}}>{aborts}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">TURN</div><div className="font-mono" style={{color: turnbacks>0?'#fb7185':'#64748b'}}>{turnbacks}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">SAFE</div><div className="font-mono text-emerald-300">{safeN}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">N/A</div><div className="font-mono text-slate-400">{counts['N-A']}</div></div>
      </div>

      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <label className="text-[10px] text-slate-400 block">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
          <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
        </label>
        <div className="flex flex-wrap gap-1">
          <button onClick={()=>setClassFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL-CLS</button>
          {(['GA-SEP','GA-MEP','LIGHT-TP','BIZ-JET','REG-TP','REG-JET','NB-JET','WB-JET','HEAVY','HELO'] as const).map(c => (
            <button key={c} onClick={()=>setClassFilter(c)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter===c?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{c}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={()=>setRegionFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${regionFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL-RGN</button>
          {(['NA-US','NA-CA','EU','UK','ASIA','PAC','ME'] as const).map(r => (
            <button key={r} onClick={()=>setRegionFilter(r)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${regionFilter===r?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{r}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {([['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['CONE',shCone,setShCone],['TEAR',shTeardrop,setShTeardrop],['APT',shApt,setShApt]] as const).map(([n,v,fn]) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/iata/class" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      <div className="flex gap-1 px-3 py-1.5 border-b border-slate-700/60">
        {(['AIRCRAFT','AIRPORTS','DRIVERS','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">

        {tab === 'AIRCRAFT' && (
          <>
            {visible.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-6">No aircraft in initial-climb envelope at any catalogued departure airport · relax filters or wait for departing traffic</div>
            )}
            {visible.slice(0, 60).map(r => {
              const isP = picked === r.f.icao
              return (
                <div key={r.f.icao} className="border rounded-lg p-2 bg-slate-800/40" style={{ borderColor: TIER_COLOR[r.tier] + '60' }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0" style={{ background: TIER_COLOR[r.tier] + '22', color: TIER_COLOR[r.tier] }}>{TIER_ABBR[r.tier]}</span>
                      <button onClick={()=>{ setPicked(r.f.icao); onFly(r.f.icao) }} className="text-slate-100 font-mono text-[11px] hover:text-sky-300 truncate">{(r.f.callsign||r.f.icao).trim()}</button>
                      <span className="text-slate-400 text-[10px] truncate">{(r.f.type||'?').toUpperCase()} · {r.cls.id}</span>
                    </div>
                    <div className="text-[10px] font-mono shrink-0" style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</div>
                  </div>

                  <div className="mt-1.5 bg-slate-900/60 rounded p-1.5 font-mono text-[9px] text-slate-300 leading-tight overflow-x-auto whitespace-nowrap">
                    {r.apt && <>
                      <span className="text-slate-500">DEP@</span><span className="text-sky-300">{r.apt.iata}</span>
                      <span className="text-slate-500"> R</span><span className="text-slate-200">{r.apt.primaryRwyQfu.toString().padStart(3,'0')}</span>
                      <span className="text-slate-500">/</span><span className="text-slate-200">{r.ev.reciprocalQfu.toString().padStart(3,'0')}</span>
                      <span className="text-slate-500"> AGL </span><span className="text-slate-200">{r.ev.aglFt.toFixed(0)}</span>
                      <span className="text-slate-500"> FLR </span><span className="text-amber-300">{r.ev.totalTurnbackAltReqFt}</span>
                      <span className="text-slate-500"> MGN </span><span style={{color: r.ev.marginFt<0?'#f43f5e':r.ev.marginPct<10?'#f59e0b':'#10b981'}}>{r.ev.marginFt>=0?'+':''}{r.ev.marginFt.toFixed(0)}ft</span>
                      <span className="text-slate-500"> GLD </span><span className="text-sky-300">{r.ev.glideReachNM.toFixed(1)}nm</span>
                    </>}
                    {!r.apt && <span className="text-slate-500">Not at catalogued departure airport</span>}
                  </div>

                  <div className="mt-1 text-[10px] text-slate-300 leading-snug">{r.ev.reason}</div>

                  <div className="mt-1 flex flex-wrap gap-0.5 text-[9px] font-mono">
                    {(['aglMargin','glideReach','windPenalty','densAlt','bankLoad','classFactor','terrain','policyDeviation'] as const).map(k => {
                      const v = r.drivers[k]
                      const sev = v >= 70 ? '#f43f5e' : v >= 40 ? '#f59e0b' : v >= 15 ? '#0ea5e9' : '#475569'
                      const lbl = ({aglMargin:'AGL',glideReach:'GLDE',windPenalty:'WIND',densAlt:'DA',bankLoad:'BANK',classFactor:'CLS',terrain:'TRN',policyDeviation:'POL'} as const)[k]
                      return (
                        <span key={k} className="px-1 py-0.5 rounded border text-[8px]" style={{ borderColor: sev + '60', color: sev }}>{lbl}{v.toFixed(0)}</span>
                      )
                    })}
                  </div>

                  {isP && (
                    <div className="mt-2 pt-2 border-t border-slate-700/40 text-[10px] space-y-1">
                      <div className="text-slate-400">Type-class: <span className="text-slate-200">{r.cls.label}</span> · Policy: <span className="text-sky-300 font-mono">{r.cls.policy}</span></div>
                      <div className="text-slate-400">Best-glide: <span className="font-mono text-slate-200">{r.cls.bestGlideKias} KIAS</span> · L/D: <span className="font-mono text-slate-200">{r.cls.ldGlide}</span> · Vs(clean): <span className="font-mono text-slate-200">{r.cls.stallVsKt} kt</span></div>
                      <div className="text-slate-400">45°-bank stall: <span className="font-mono" style={{color: r.ev.bankLoadMarginKt < 5 ? '#f43f5e' : r.ev.bankLoadMarginKt < 15 ? '#f59e0b' : '#10b981'}}>{r.ev.stallAt45BankKt.toFixed(0)} kt</span> · margin <span className="font-mono">{r.ev.bankLoadMarginKt.toFixed(0)} kt</span></div>
                      <div className="text-slate-400">Teardrop r: <span className="font-mono text-slate-200">{r.ev.teardropRadiusFt.toFixed(0)} ft</span> · 225° loss: <span className="font-mono text-slate-200">{r.ev.teardropAltLossFt.toFixed(0)} ft</span> · roll+react: <span className="font-mono text-slate-200">{r.ev.rollInRollOutAltFt} ft</span></div>
                      <div className="text-slate-400">Adj min-turnback: <span className="font-mono text-amber-300">{r.ev.minTurnbackAglFt} ft AGL</span> (base {r.cls.minTurnbackAglFt} + wind/DA adj)</div>
                      <div className="text-slate-400">Wind hd-dep: <span className="font-mono text-slate-200">{r.ev.windHeadFromDep>=0?'+':''}{r.ev.windHeadFromDep} kt</span> · Dens-alt: <span className="font-mono text-slate-200">{r.ev.densAltFt} ft</span></div>
                      {r.apt && <div className="text-slate-400">Field elev: <span className="font-mono text-slate-200">{r.apt.elevFt} ft</span> · Rwy len: <span className="font-mono text-slate-200">{r.apt.rwyLengthFt} ft</span> · Strt-ahd terrain: <span className="font-mono text-slate-200">{r.apt.terrain}</span></div>}
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}

        {tab === 'AIRPORTS' && (
          <>
            <div className="text-[10px] text-slate-500 mb-1 px-1">Departure-airport ranking — abort count then total traffic</div>
            {aptAgg.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-6">No aircraft in initial-climb scope.</div>
            )}
            {aptAgg.map(a => (
              <div key={a.apt.icao} className="border border-slate-700/40 rounded-lg p-2 bg-slate-800/40">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-mono text-sky-300">{a.apt.iata}</span>
                    <span className="text-[10px] text-slate-400 truncate">{a.apt.name}</span>
                  </div>
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border" style={{
                    background: (a.apt.terrain==='MOUNTAIN'?'#f59e0b22':a.apt.terrain==='WATER'?'#0ea5e922':a.apt.terrain==='URBAN'?'#94a3b822':'#10b98122'),
                    borderColor: (a.apt.terrain==='MOUNTAIN'?'#f59e0b66':a.apt.terrain==='WATER'?'#0ea5e966':a.apt.terrain==='URBAN'?'#94a3b866':'#10b98166'),
                    color: (a.apt.terrain==='MOUNTAIN'?'#f59e0b':a.apt.terrain==='WATER'?'#0ea5e9':a.apt.terrain==='URBAN'?'#94a3b8':'#10b981'),
                  }}>{a.apt.terrain}</span>
                </div>
                <div className="mt-1 grid grid-cols-4 gap-1 text-[9px] font-mono">
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">N</span> <span className="text-slate-200">{a.count}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">ABT</span> <span style={{color: a.abort > 0 ? '#f43f5e' : '#64748b'}}>{a.abort}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">TRN</span> <span style={{color: a.turn > 0 ? '#fb7185' : '#64748b'}}>{a.turn}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">SAF</span> <span className="text-emerald-300">{a.safe}</span></div>
                </div>
                <div className="mt-1 text-[9px] text-slate-500 font-mono">
                  R{a.apt.primaryRwyQfu.toString().padStart(3,'0')}/{((a.apt.primaryRwyQfu+180)%360).toString().padStart(3,'0')} · {a.apt.rwyLengthFt} ft · elev {a.apt.elevFt} ft · {a.apt.terrain.toLowerCase()} surroundings
                </div>
              </div>
            ))}
          </>
        )}

        {tab === 'DRIVERS' && (
          <>
            <div className="text-[10px] text-slate-500 mb-1 px-1">8-driver mean across N={rows.filter(r=>r.ev.inScope).length} in-scope aircraft</div>
            {([
              ['aglMargin',       'AGL · margin above class min-turnback altitude', driverAvg.aglMargin],
              ['glideReach',      'GLDE · glide-range shortfall to opposite threshold', driverAvg.glideReach],
              ['windPenalty',     'WIND · headwind-on-departure / tailwind-on-return penalty', driverAvg.windPenalty],
              ['densAlt',         'DA · density-altitude penalty on glide + climb', driverAvg.densAlt],
              ['bankLoad',        'BANK · stall margin at 45°-bank teardrop', driverAvg.bankLoad],
              ['classFactor',     'CLS · aircraft category penalty (transport ≫ light)', driverAvg.classFactor],
              ['terrain',         'TRN · straight-ahead terrain unsuitability', driverAvg.terrain],
              ['policyDeviation', 'POL · turnback by STRAIGHT-ONLY class deviation', driverAvg.policyDeviation],
            ] as const).map(([k, lbl, v]) => {
              const pct = Math.min(100, v)
              const col = v >= 70 ? '#f43f5e' : v >= 40 ? '#f59e0b' : v >= 15 ? '#0ea5e9' : '#10b981'
              return (
                <div key={k} className="border border-slate-700/40 rounded-lg p-2 bg-slate-800/40">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-slate-300 font-mono">{lbl}</span>
                    <span className="font-mono" style={{ color: col }}>{v.toFixed(1)}</span>
                  </div>
                  <div className="mt-1 h-1.5 bg-slate-900/60 rounded overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${pct}%`, background: col }} />
                  </div>
                </div>
              )
            })}
            <div className="text-[9px] text-slate-500 px-1 pt-1 leading-relaxed">
              Composite = max(AGL, GLDE, BANK, POL)·0.65 + mean(WIND, DA, TRN, CLS)·0.35, multiplied by ADV-MUL.
              AGL drives ABORT-STR when current AGL &lt; class min-turnback-alt (adjusted for wind &amp; density alt).
              BANK reaches 100 when best-glide speed minus 45°-bank stall (Vs × 1.19) leaves &lt;5 kt margin — stall-spin window.
              POL fires when a STRAIGHT-ONLY transport is below 1500 AGL — doctrine says land straight ahead even if geometry "fits".
            </div>
          </>
        )}

        {tab === 'METHOD' && (
          <div className="text-[10px] text-slate-300 leading-relaxed space-y-2 p-1">
            <p><span className="text-sky-300 font-mono">DEFINITION.</span> EFATO = Engine-Failure-After-TakeOff = total power loss during the initial-climb phase (gear-up to ~3000 ft AGL, within ~5 NM of the departure airport, vertical rate positive). The pilot must choose in &lt;3 seconds between (A) ABORT-STRAIGHT — land within a ±30° cone ahead, (B) TURN-225 — 225° Möller teardrop at 45° bank back to the reciprocal-direction runway threshold, or (C) OFF-AIRPORT — 30-60° divert to suitable terrain.</p>
            <p><span className="text-sky-300 font-mono">REGULATORY.</span> FAA AC 61-83G + FAA-H-8083-3B §16 prescribe pre-departure briefing of a personal min-turnback altitude. 14 CFR §91.3(b) grants PIC authority to deviate. Boeing FCOM Vol-II §03 + Airbus FCOM ABN-EMER for transport-class doctrine = land straight ahead, do not attempt turnback (Sully US1549, TACA 110, BA 38 precedents). ICAO Annex 6 Part I §4.4 requires emergency-fuel reserves but not turnback procedure.</p>
            <p><span className="text-sky-300 font-mono">PHYSICS — TEARDROP RADIUS.</span> At 45° bank, load factor n = 1/cos(45°) = 1.414g. Turn radius r [ft] = Vtas² / (g·tan(φ)) = Vtas² / 32.17 at 45° bank. For a C172 at best-glide 65 KIAS (110 fps), r ≈ 376 ft = 0.06 NM diameter. For an A320 at 220 KIAS (372 fps), r ≈ 4300 ft = 1.4 NM diameter. The 225° heading change (180° back + 45° final intercept) consumes (5π/4)·r of arc length and ≈ that arc length ÷ L/D in altitude loss.</p>
            <p><span className="text-sky-300 font-mono">PHYSICS — MIN TURNBACK ALT.</span> Rogers AIAA-95-3768 closed-form for ideal pilot zero-wind: h_min = (225°/360°)·2π·r/(L/D). Cox AOPA flight-test corrections add ≈ 200-400 ft for (i) 3-sec startle reaction (Brandt-Gilliland), (ii) roll-in/roll-out 2 sec, (iii) 45° final-intercept arc. Wind adds 15 ft / kt headwind-on-departure (= tailwind on return). Density alt adds ~1% per 1000 ft DA. Result: C172 ≈ 700-900 ft AGL real-world; SR22 ≈ 900-1100; light turboprop ≈ 1500-1800; biz jet ≈ 2000-2500; transport ≈ 3000+ ft AGL where EOSID supersedes pure turnback.</p>
            <p><span className="text-sky-300 font-mono">STALL-SPIN BOUNDARY.</span> 45°-bank stall speed = Vs × √(1/cos 45°) = Vs × 1.19. For C172 Vs = 48 kt → 1g-stall@45° = 57 kt. Best-glide 65 KIAS leaves 8 kt margin — comfortable. For SR22 Vs = 62 → 74 kt vs Vbg 88 = 14 kt margin. Reduce bank to 30° (Vs × 1.07) only if margin tight — but doubles the radius and doubles the altitude loss. The classic AOPA fatal: pilot rolls 45°, pulls (load factor up to 2-3g in panic), accelerates stall, departs into spin at base-to-final. Below 1000 ft AGL = unrecoverable.</p>
            <p><span className="text-sky-300 font-mono">CLASS POLICY MATRIX.</span> TURNBACK-BRIEFED: GA singles &amp; twins, light turboprops — pilots can practice, geometry favors. EOSID-PREF: biz jets &amp; regional turboprops — turnback geometry exists but EOSID procedure provides safer one-engine-out (still operational thrust) option. STRAIGHT-ONLY: regional jets, narrowbody, widebody, heavy — total flameout below 1500 AGL = land straight ahead, energy/turn radius incompatible with low-altitude maneuvering (witness Pinnacle 3701 attempted return that undershot KJEF). AUTOROTATE: helicopters — entirely different physics, autorotation height-velocity curve, not impossible-turn.</p>
            <p><span className="text-sky-300 font-mono">SCORING.</span> Per-flight: ABORT-STR if AGL &lt; class adjusted min-turnback OR STRAIGHT-ONLY class &lt; 1500 AGL OR helo (autorotate). WATCH-GAP if margin &lt;10% above floor or glide reach inadequate. TURN-225 if margin ≥10%, glide adequate, class is TURNBACK-BRIEFED. OFF-AIRPORT if EOSID-PREF class with positive margin (divert preferred). ABOVE-FLOOR if 1500-3500 AGL. SAFE-MARGIN if &gt;3500 AGL. Airport rollup ranks departure fields by abort count.</p>
            <p><span className="text-sky-300 font-mono">DISTINCT FROM.</span> EOSID (partial-power OEI departure, still producing thrust), EDR (rapid-decompression cruise descent), GASA (go-around safe altitude on approach), RTO (ground abort &lt; V1), SID-CLIMB (normal-ops gradient), ROW-ROP / EMAS (landing overrun), RAAS (taxi advisories), LVTO (low-vis departure), TOPMS (pre-V1 acceleration), STBR (stabilised approach). TURNBACK is uniquely scoped to total-power-loss in the initial-climb gear-up envelope.</p>
          </div>
        )}
      </div>
    </div>
  )
}
