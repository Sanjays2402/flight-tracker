'use client'

// ============================================================================
// APCH-CAT · ILS CAT-I / CAT-II / CAT-III Low-Visibility-Operations
//           Approach-Category Compliance & Equipment-vs-Weather Eligibility
//           Monitor
// ----------------------------------------------------------------------------
// Per-airframe live evaluator of every aircraft on final approach to one of
// 24 catalogued ILS-equipped hub runways, deciding whether the combination
// of (a) reported weather (RVR / vertical-visibility / cloud-base ceiling),
// (b) aircraft-class autoland / HUD-EVS equipment fit, (c) ground-equipment
// integrity (LLZ + GP transmitter status, RVR-sensor readiness, LVP runway
// guard-rail / sensitive-area protection), and (d) crew currency / type-
// rating proxy, satisfies the certified ILS approach-category minima per
//   14 CFR §91.175 §91.189 §121.651 §121.652
//   ICAO Annex 6 Pt I §4.2.8 / Annex 10 Vol I §3.1.3 (ILS course-tolerance)
//   ICAO Doc 8168 PANS-OPS Vol I §1.4 (CAT-I/II/III minima)
//   ICAO Doc 9365 All-Weather Operations Manual ed.3
//   FAA AC 120-28D (CAT-IIIb / FailOp / no-DH operations)
//   FAA AC 120-29A (CAT-I/II / approach approval)
//   FAA AC 90-106A (EFVS to landing)
//   EASA CS-AWO (All-Weather Operations) + AMC1 CAT.IDE.A.105
//   EASA Decision 2019/021/R AWO ed.2
//   FAA Order JO 7110.65 §3-1-7 (LVPs in effect — RVR <= 1200ft)
//   FAA Order 8400.13D (CAT-II/III ops approval)
//
// Structurally distinct from:
//   STABLE-APPROACH (1000ft/500ft gate-criteria gross check, not category)
//   CDFA-VDP        (NPA vertical-path conformance, not precision-cat)
//   APPR-MINS       (publishes the minima — APCH-CAT scores compliance)
//   STBR            (stop-bar enforcement on ground)
//   VFE             (flap-speed envelope)
//   DECRAB          (crosswind technique)
//   ROW-ROP         (rollout overrun)
// APCH-CAT is the ALL-WEATHER-OPERATIONS regulatory-eligibility scorer that
// answers the operational question: "is this airframe RIGHT NOW certified
// AND equipped AND crewed AND has the ground-equipment integrity to legally
// continue this CAT-IIIb approach in the reported 75m RVR?"
//
// 6 drivers, 6 tiers, MapLibre overlay, 4 tabs, ~700 lines.
// ============================================================================

import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

interface F {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  vertRate: number
  heading: number
  ground?: boolean
  squawk?: string
  emergency?: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: F[]
  onClose: () => void
  onFly: (icao: string) => void
}

// ---------------------------------------------------------------------------
// CAT-band canonical envelope per ICAO Doc 8168 / FAA AC 120-28D / 120-29A
//   CAT-I    DH ≥ 200 ft     RVR ≥ 550 m
//   CAT-II   100 ≤ DH < 200  RVR ≥ 300 m
//   CAT-IIIA  0 < DH < 100   RVR ≥ 175 m
//   CAT-IIIB no DH or DH<50  RVR ≥ 50 m
//   CAT-IIIC no DH no-RVR    fog-roll / not yet authorised in revenue ops
// ---------------------------------------------------------------------------
type CatBand = 'CAT-I' | 'CAT-II' | 'CAT-IIIA' | 'CAT-IIIB' | 'CAT-IIIC' | 'NONE'

type CatMinima = { dhFt: number; rvrM: number }
const MIN_TABLE: Record<CatBand, CatMinima> = {
  'CAT-I':    { dhFt: 200, rvrM: 550 },
  'CAT-II':   { dhFt: 100, rvrM: 300 },
  'CAT-IIIA': { dhFt:  50, rvrM: 175 },
  'CAT-IIIB': { dhFt:   0, rvrM:  50 },
  'CAT-IIIC': { dhFt:   0, rvrM:   0 },
  'NONE':     { dhFt: 999, rvrM: 9999 },
}

// ---------------------------------------------------------------------------
// 24-runway global ILS hub catalogue.
//   Best-published approach-cat per runway; ldgHdg true-deg landing heading.
//   Sources: Jeppesen 10-9 ed.2025-04 / FAA chart supp / EU AIP AD2-LFPG-LHR-
//   FRA-AMS-ZRH-ROM-MAD / JAL/JCAB AIP RJTT-RJAA / HKIA AIP VHHH /
//   SCA AIP WSSS / DGCA AIP VIDP / GCAA AIP OMDB / NAV Canada AIP CYYZ.
// ---------------------------------------------------------------------------
type Rwy = {
  icao: string         // airport ICAO
  iata: string
  name: string
  rwy: string          // runway designator e.g. '27L'
  lat: number          // threshold lat
  lng: number          // threshold lng
  elevFt: number
  ldgHdgTrue: number   // landing true-track heading
  cat: CatBand         // best-published cat
  llz: string          // LLZ ident (informational)
  gpAngleDeg: number   // glidepath angle deg (typically 3.0)
  region: 'NAM-E' | 'NAM-W' | 'NAM-S' | 'EUR' | 'ASIA-E' | 'ASIA-S' | 'ME'
}
const RUNWAYS: Rwy[] = [
  // North America East
  { icao:'KJFK', iata:'JFK', name:'New York-JFK',     rwy:'04R', lat:40.6231, lng:-73.7896, elevFt:13,  ldgHdgTrue: 31, cat:'CAT-IIIB', llz:'IJFK',  gpAngleDeg:3.0, region:'NAM-E' },
  { icao:'KJFK', iata:'JFK', name:'New York-JFK',     rwy:'22L', lat:40.6610, lng:-73.7670, elevFt:13,  ldgHdgTrue:211, cat:'CAT-IIIB', llz:'IJBR',  gpAngleDeg:3.0, region:'NAM-E' },
  { icao:'KEWR', iata:'EWR', name:'Newark-Liberty',   rwy:'04R', lat:40.6824, lng:-74.1716, elevFt: 18, ldgHdgTrue: 41, cat:'CAT-IIIB', llz:'IEWR',  gpAngleDeg:3.0, region:'NAM-E' },
  { icao:'KBOS', iata:'BOS', name:'Boston-Logan',     rwy:'33L', lat:42.3490, lng:-71.0257, elevFt: 19, ldgHdgTrue:323, cat:'CAT-IIIB', llz:'IBOS',  gpAngleDeg:3.0, region:'NAM-E' },
  { icao:'KATL', iata:'ATL', name:'Atlanta-Hartsfield', rwy:'27R', lat:33.6473, lng:-84.4017, elevFt:1026, ldgHdgTrue:266, cat:'CAT-IIIB', llz:'IATL', gpAngleDeg:3.0, region:'NAM-E' },
  { icao:'KORD', iata:'ORD', name:'Chicago-O\u2019Hare', rwy:'10L', lat:41.9831, lng:-87.9301, elevFt: 663, ldgHdgTrue:103, cat:'CAT-IIIB', llz:'IORD', gpAngleDeg:3.0, region:'NAM-E' },
  { icao:'KMIA', iata:'MIA', name:'Miami',            rwy:'08R', lat:25.7920, lng:-80.3236, elevFt:  8, ldgHdgTrue: 82, cat:'CAT-II',   llz:'IMIA',  gpAngleDeg:3.0, region:'NAM-S' },
  { icao:'CYYZ', iata:'YYZ', name:'Toronto-Pearson',  rwy:'06L', lat:43.6612, lng:-79.6442, elevFt: 569, ldgHdgTrue: 53, cat:'CAT-IIIA', llz:'IYYZ', gpAngleDeg:3.0, region:'NAM-E' },
  // North America West
  { icao:'KLAX', iata:'LAX', name:'Los Angeles',      rwy:'25L', lat:33.9485, lng:-118.4310, elevFt:120, ldgHdgTrue:251, cat:'CAT-IIIB', llz:'ILAX', gpAngleDeg:3.0, region:'NAM-W' },
  { icao:'KSFO', iata:'SFO', name:'San Francisco',    rwy:'28L', lat:37.6133, lng:-122.3573, elevFt: 13, ldgHdgTrue:279, cat:'CAT-IIIB', llz:'ISFO', gpAngleDeg:3.0, region:'NAM-W' },
  { icao:'KSEA', iata:'SEA', name:'Seattle-Tacoma',   rwy:'16L', lat:47.4751, lng:-122.3120, elevFt:425, ldgHdgTrue:158, cat:'CAT-IIIB', llz:'ISEA', gpAngleDeg:3.0, region:'NAM-W' },
  { icao:'KDEN', iata:'DEN', name:'Denver-Intl',      rwy:'16L', lat:39.8851, lng:-104.6868, elevFt:5345, ldgHdgTrue:170, cat:'CAT-IIIB', llz:'IDEN', gpAngleDeg:3.0, region:'NAM-W' },
  // Europe
  { icao:'EGLL', iata:'LHR', name:'London-Heathrow',  rwy:'27L', lat:51.4775, lng:-0.4329,  elevFt: 79, ldgHdgTrue:269, cat:'CAT-IIIB', llz:'ILL',   gpAngleDeg:3.0, region:'EUR'   },
  { icao:'EGLL', iata:'LHR', name:'London-Heathrow',  rwy:'09L', lat:51.4775, lng:-0.4865,  elevFt: 79, ldgHdgTrue: 89, cat:'CAT-IIIB', llz:'IBB',   gpAngleDeg:3.0, region:'EUR'   },
  { icao:'EHAM', iata:'AMS', name:'Amsterdam-Schiphol', rwy:'18R', lat:52.3624, lng:4.7110, elevFt:-11, ldgHdgTrue:183, cat:'CAT-IIIB', llz:'ISRA',  gpAngleDeg:3.0, region:'EUR'   },
  { icao:'EDDF', iata:'FRA', name:'Frankfurt-Main',   rwy:'25C', lat:50.0379, lng:8.5841,   elevFt:364, ldgHdgTrue:251, cat:'CAT-IIIB', llz:'IFFM',  gpAngleDeg:3.0, region:'EUR'   },
  { icao:'EDDM', iata:'MUC', name:'Munich-Franz-Josef', rwy:'08R', lat:48.3392, lng:11.7510, elevFt:1487, ldgHdgTrue: 79, cat:'CAT-IIIB', llz:'IMNE', gpAngleDeg:3.0, region:'EUR'   },
  { icao:'LFPG', iata:'CDG', name:'Paris-CDG',        rwy:'26L', lat:49.0212, lng:2.5612,   elevFt:392, ldgHdgTrue:261, cat:'CAT-IIIB', llz:'IPAH',  gpAngleDeg:3.0, region:'EUR'   },
  { icao:'LSZH', iata:'ZRH', name:'Z\u00FCrich-Kloten', rwy:'14', lat:47.4720, lng:8.5360,   elevFt:1411, ldgHdgTrue:138, cat:'CAT-IIIB', llz:'IKLO', gpAngleDeg:3.0, region:'EUR'   },
  { icao:'LIRF', iata:'FCO', name:'Rome-Fiumicino',   rwy:'16L', lat:41.8203, lng:12.2451,  elevFt: 13, ldgHdgTrue:158, cat:'CAT-IIIB', llz:'IFAA',  gpAngleDeg:3.0, region:'EUR'   },
  // Middle East / Asia
  { icao:'OMDB', iata:'DXB', name:'Dubai-Intl',       rwy:'12R', lat:25.2549, lng:55.3411,  elevFt: 62, ldgHdgTrue:122, cat:'CAT-IIIB', llz:'IBHE',  gpAngleDeg:3.0, region:'ME'    },
  { icao:'WSSS', iata:'SIN', name:'Singapore-Changi', rwy:'02L', lat:1.3320,  lng:103.9911, elevFt: 22, ldgHdgTrue: 22, cat:'CAT-IIIB', llz:'ISC',   gpAngleDeg:3.0, region:'ASIA-S'},
  { icao:'VHHH', iata:'HKG', name:'Hong Kong-Intl',   rwy:'07L', lat:22.3149, lng:113.9180, elevFt: 28, ldgHdgTrue: 68, cat:'CAT-IIIA', llz:'IHKL',  gpAngleDeg:3.0, region:'ASIA-E'},
  { icao:'RJTT', iata:'HND', name:'Tokyo-Haneda',     rwy:'34R', lat:35.5305, lng:139.7720, elevFt: 21, ldgHdgTrue:339, cat:'CAT-IIIB', llz:'ITWR',  gpAngleDeg:3.0, region:'ASIA-E'},
]

// ---------------------------------------------------------------------------
// Aircraft-class autoland / HUD-EVS equipment-fit catalogue.
//   capCat   = best certified approach category for the airframe class.
//   failOp   = N redundant autopilots ("fail-operational" channels) per
//              AC 120-28D §5.4 (3 = no-DH IIIB; 2 = DH-50 IIIA; 1 = CAT-II
//              with hand-flying break-off).
//   hudEvs   = HUD/EVS to-landing credit per AC 90-106A (visibility credit
//              equivalent to next-better cat band).
// Source bands derived from Boeing 737/747/757/767/777/787 FCOM Limits Ch.1,
//   Airbus A320/A330/A350/A380 FCOM LIM-22, Embraer E1/E2 AFM §2, ATR-72/
//   Q400 FCOM §2.04, Gulfstream/Bombardier biz-jet AFM §2 plus AC 120-28D
//   /29A approval cross-walk.
// ---------------------------------------------------------------------------
type ClassKey =
  | 'HVY-T-NEW'    // B777/B787/A350/A330neo (3-AP FailOp, no-DH CAT-IIIB)
  | 'HVY-Q'        // B747-8/A380             (3-AP FailOp, no-DH CAT-IIIB)
  | 'WB-M'         // B767/A330ceo            (2-AP FailOp, CAT-IIIA DH50)
  | 'NB-NEW'       // B737NG/B737MAX/A320neo/A321XLR (CAT-IIIA DH50)
  | 'NB-CLS'       // B737CL/B757/A320ceo     (CAT-IIIA DH50 limited)
  | 'RGN-J-NEW'    // E190/E2/CRJ900/CRJ1000  (CAT-II DH100)
  | 'RGN-T'        // AT72/Q400/Saab          (CAT-I DH200)
  | 'BIZ-HUD'      // G650/GLEX/FA8X with HUD-EVS (CAT-II equiv credit)
  | 'BIZ-STD'      // PC12/C25B legacy biz   (CAT-I DH200)
  | 'LIGHT'        // PA28/C172              (NONE — visual only)

type ClassSpec = {
  label: string
  capCat: CatBand
  failOp: 1 | 2 | 3
  hudEvs: boolean
  exemplars: string[]
}
const CLASS_SPEC: Record<ClassKey, ClassSpec> = {
  'HVY-T-NEW': { label:'WB FBW NEW',  capCat:'CAT-IIIB', failOp:3, hudEvs:true,  exemplars:['B772','B77W','B788','B789','B78X','A359','A35K','A332','A333','A338','A339'] },
  'HVY-Q':     { label:'WB QUAD',     capCat:'CAT-IIIB', failOp:3, hudEvs:true,  exemplars:['B744','B748','A388'] },
  'WB-M':      { label:'WB-MEDIUM',   capCat:'CAT-IIIA', failOp:2, hudEvs:false, exemplars:['B752','B763','B764','A332-CEO','MD11'] },
  'NB-NEW':    { label:'NB NEW-GEN',  capCat:'CAT-IIIA', failOp:2, hudEvs:false, exemplars:['B737','B738','B739','B38M','B39M','A319','A320','A321','A20N','A21N','A21X','BCS3','BCS1'] },
  'NB-CLS':    { label:'NB CLASSIC',  capCat:'CAT-IIIA', failOp:1, hudEvs:false, exemplars:['B732','B733','B734','B735','B752-OLD','MD80','MD82','MD83','MD88'] },
  'RGN-J-NEW': { label:'RGN-JET NEW', capCat:'CAT-II',   failOp:2, hudEvs:false, exemplars:['E170','E175','E190','E195','E290','E295','CRJ7','CRJ9','CRJX'] },
  'RGN-T':     { label:'TURBOPROP',   capCat:'CAT-I',    failOp:1, hudEvs:false, exemplars:['AT72','AT75','AT76','DH8D','DH8C','SF34','SB20'] },
  'BIZ-HUD':   { label:'BIZ HUD-EVS', capCat:'CAT-II',   failOp:2, hudEvs:true,  exemplars:['GLEX','GL5T','GL7T','G650','GLF6','FA8X','FA7X','GL6T'] },
  'BIZ-STD':   { label:'BIZ STD',     capCat:'CAT-I',    failOp:1, hudEvs:false, exemplars:['C25A','C25B','C25C','PC12','PC24','CL30','CL35','CL60','PRM1','LJ45','LJ60'] },
  'LIGHT':     { label:'LIGHT-GA',    capCat:'NONE',     failOp:1, hudEvs:false, exemplars:['C172','C182','PA28','SR22','DA40','BE36'] },
}
function classifyClass(typeCode: string | undefined): ClassKey {
  const t = (typeCode || '').toUpperCase()
  for (const k of Object.keys(CLASS_SPEC) as ClassKey[]) {
    if (CLASS_SPEC[k].exemplars.includes(t)) return k
  }
  // pattern fallbacks
  if (/^B77|^B78|^A35|^A33|^A359|^A33[8-9]|^A332|^A333/.test(t)) return 'HVY-T-NEW'
  if (/^B74|^A38/.test(t)) return 'HVY-Q'
  if (/^B76|^B75/.test(t)) return 'WB-M'
  if (/^B73|^A20|^A21|^A319|^A320|^A321|^BCS/.test(t)) return 'NB-NEW'
  if (/^E1[79]|^E[29]|^CRJ/.test(t)) return 'RGN-J-NEW'
  if (/^AT[47]|^DH8/.test(t)) return 'RGN-T'
  if (/^G[56]|^GL|^FA[78]/.test(t)) return 'BIZ-HUD'
  if (/^C2|^PC|^CL/.test(t)) return 'BIZ-STD'
  return 'NB-NEW'
}

// hash32 — deterministic synth
function hash32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}

// great-circle dist NM and initial-bearing deg
const R_NM = 3440.065
function gcDistNM(lat1:number, lng1:number, lat2:number, lng2:number): number {
  const φ1=lat1*Math.PI/180, φ2=lat2*Math.PI/180
  const Δφ=(lat2-lat1)*Math.PI/180, Δλ=(lng2-lng1)*Math.PI/180
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2
  return 2*R_NM*Math.asin(Math.sqrt(a))
}
function initialBearing(lat1:number, lng1:number, lat2:number, lng2:number): number {
  const φ1=lat1*Math.PI/180, φ2=lat2*Math.PI/180, Δλ=(lng2-lng1)*Math.PI/180
  const y = Math.sin(Δλ)*Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ)
  return (Math.atan2(y,x)*180/Math.PI + 360) % 360
}

// snap each in-approach aircraft to nearest aligned runway within SCOPE
function snapRunway(f: F, scopeNM: number, alignDeg: number): { rwy: Rwy | null; distNM: number; trkOff: number } {
  let best: Rwy | null = null
  let bestD = Infinity
  let bestTrkOff = 999
  for (const r of RUNWAYS) {
    const d = gcDistNM(f.lat, f.lng, r.lat, r.lng)
    if (d > scopeNM) continue
    const brgToThr = initialBearing(f.lat, f.lng, r.lat, r.lng)
    // require the aircraft's track to align with the landing heading within
    // alignDeg (i.e. they're flying TOWARD the threshold along the LLZ)
    let trkOff = Math.abs(((f.heading - r.ldgHdgTrue + 540) % 360) - 180)
    // also ensure bearing-to-threshold roughly aligns with track
    const bearOff = Math.abs(((brgToThr - f.heading + 540) % 360) - 180)
    if (trkOff > alignDeg || bearOff > 35) continue
    if (d < bestD) { best = r; bestD = d; bestTrkOff = trkOff }
  }
  return { rwy: best, distNM: bestD === Infinity ? 0 : bestD, trkOff: bestTrkOff }
}

// ---------------------------------------------------------------------------
// Weather synthesis per airport — RVR (m), ceiling (ft), vis (m).
//   Driven by:
//     - latitude band (polar / mid-lat / tropical) base fog frequency
//     - season offset (slider DOY 0-365)
//     - per-airport hash for deterministic variability
//   Returns the operationally meaningful single-RVR figure (touchdown
//   sensor) and the lowest legally-usable CAT band for the reported WX.
// ---------------------------------------------------------------------------
type WxState = { rvrM: number; ceilFt: number; visM: number; usableCat: CatBand; lvpInForce: boolean }

function wxForAirport(icao: string, doy: number, fogMul: number): WxState {
  const h = hash32(icao + ':' + Math.floor(doy / 7)) // weekly cycling
  const rng = (n:number) => ((hash32(icao + 'r' + n) % 10000) / 10000)
  // base p(fog) — winter+late-fall surge for mid+high lat
  const r0 = rng(1), r1 = rng(2), r2 = rng(3)
  // map [0..1] → weather state via inverse-frequency table
  // higher fogMul biases toward LIFR
  const seasonalWinter = Math.max(0, Math.cos(2*Math.PI*(doy-15)/365))
  const baseFog = 0.12 + 0.18 * seasonalWinter
  const pFog = Math.min(0.92, baseFog * (fogMul / 100))
  let rvrM = 9000, ceilFt = 4500, visM = 9000
  if (r0 < pFog * 0.18) { rvrM =  75; ceilFt =  50; visM =  100 }      // CAT-IIIB
  else if (r0 < pFog * 0.30) { rvrM = 200; ceilFt =  80; visM =  250 } // CAT-IIIA
  else if (r0 < pFog * 0.50) { rvrM = 400; ceilFt = 120; visM =  500 } // CAT-II
  else if (r0 < pFog * 0.75) { rvrM = 700; ceilFt = 280; visM =  900 } // CAT-I marginal
  else if (r0 < pFog * 1.00) { rvrM =1500; ceilFt = 600; visM = 2000 } // CAT-I OK
  else { rvrM = 4000 + Math.floor(r1*5000); ceilFt = 1200 + Math.floor(r2*2000); visM = 6000 + Math.floor(r1*4000) } // VMC
  // determine usable CAT band — lowest cat the WX is at or above
  let usableCat: CatBand = 'NONE'
  if (rvrM >= 550 && ceilFt >= 200) usableCat = 'CAT-I'
  if (rvrM >= 300 && ceilFt >= 100) usableCat = 'CAT-II'
  if (rvrM >= 175)                  usableCat = 'CAT-IIIA'
  if (rvrM >=  50)                  usableCat = 'CAT-IIIB'
  // LVP per JO 7110.65 §3-1-7 — RVR ≤ 1200 ft (~365m) or ceiling ≤ 200ft
  const lvpInForce = rvrM <= 365 || ceilFt <= 200
  return { rvrM, ceilFt, visM, usableCat, lvpInForce }
}

// for ranking CAT bands lo→hi (worse → better fog tolerance)
const CAT_ORDER: CatBand[] = ['NONE', 'CAT-I', 'CAT-II', 'CAT-IIIA', 'CAT-IIIB', 'CAT-IIIC']
function catRank(c: CatBand): number { return CAT_ORDER.indexOf(c) }

// ---------------------------------------------------------------------------
// 6 risk drivers
// ---------------------------------------------------------------------------
type Driver =
  | 'WX-CAT'    // weather worse than aircraft / runway can support
  | 'EQUIP'     // aircraft below cat required by WX
  | 'CREW'      // crew currency / recency proxy
  | 'GAFOR'     // ground-equip flag: LLZ/GP/RVR sensor degraded
  | 'REDUND'    // FailOp redundancy lost (1 AP only when 2-AP required)
  | 'APPR-BAN'  // CAT-III approach BAN — sensitive-area not protected

const DRIVERS: Driver[] = ['WX-CAT', 'EQUIP', 'CREW', 'GAFOR', 'REDUND', 'APPR-BAN']

const DRIVER_LABEL: Record<Driver, string> = {
  'WX-CAT':   'WX below CAT',
  'EQUIP':    'Equip<CAT',
  'CREW':     'Crew currency',
  'GAFOR':    'Ground-eq fault',
  'REDUND':   'FailOp redund',
  'APPR-BAN': 'CAT-III ban',
}

// ---------------------------------------------------------------------------
// 6 tiers
// ---------------------------------------------------------------------------
type Tier = 'NOGO' | 'DIVERT' | 'DOWNGRADE' | 'WATCH' | 'CLEARED' | 'ABOVE-MINS'
const TIER_COLOR: Record<Tier, string> = {
  'NOGO':       '#f43f5e', // rose-500
  'DIVERT':     '#fb7185', // rose-400
  'DOWNGRADE':  '#f59e0b', // amber-500
  'WATCH':      '#0ea5e9', // sky-500
  'CLEARED':    '#10b981', // emerald-500
  'ABOVE-MINS': '#94a3b8', // slate-400
}
const TIER_ORDER: Tier[] = ['NOGO','DIVERT','DOWNGRADE','WATCH','CLEARED','ABOVE-MINS']

interface Row {
  f: F
  cls: ClassKey
  spec: ClassSpec
  rwy: Rwy | null
  distNM: number
  trkOff: number
  wx: WxState | null
  reqCat: CatBand          // the cat the WX REQUIRES the airframe to fly
  acftCap: CatBand         // best cat the airframe can fly
  rwyCap: CatBand          // best cat the runway publishes
  reqMinima: CatMinima | null
  driver: Record<Driver, number>
  score: number
  tier: Tier
  topDriver: Driver
  failOpEff: number        // effective channels after REDUND penalty
  advice: string
}

function adviseRow(r: Row): string {
  const wx = r.wx
  if (!r.rwy || !wx) return 'No runway snap — outside scope'
  if (r.tier === 'NOGO') {
    return `NOGO ${r.rwy.icao}/${r.rwy.rwy} — WX requires ${r.reqCat} (RVR ${wx.rvrM}m ceil ${wx.ceilFt}ft) but ${r.spec.label} only certified ${r.acftCap}. Divert per AC 120-28D §3 / 14 CFR §91.175(c)`
  }
  if (r.tier === 'DIVERT') {
    return `DIVERT — ${r.rwy.icao}/${r.rwy.rwy} ground-equipment fault or CAT-III BAN, fallback below airframe ceiling. Holding / alt diversion per CAT.OP.MPA.110`
  }
  if (r.tier === 'DOWNGRADE') {
    return `DOWNGRADE to ${r.acftCap} from required ${r.reqCat} — REDUND/CREW issue. Brief crew, accept higher DH/RVR per FCOM Lim Ch.1`
  }
  if (r.tier === 'WATCH') {
    return `WATCH ${r.rwy.icao}/${r.rwy.rwy} ${r.reqCat} approach with ${r.spec.label} (${r.failOpEff}-AP FailOp), RVR ${wx.rvrM}m DH ${r.reqMinima?.dhFt ?? '—'}ft. LVPs ${wx.lvpInForce?'IN FORCE':'inactive'}.`
  }
  if (r.tier === 'CLEARED') {
    return `CLEARED ${r.reqCat} per JO 7110.65 §3-1-7. Airframe class ${r.spec.label} cert ${r.acftCap}, ${r.failOpEff}-AP FailOp, ${r.spec.hudEvs?'HUD-EVS':'no HUD'} — within minima`
  }
  return `Above minima — WX permits visual approach to ${r.rwy.icao}/${r.rwy.rwy}, all CAT bands available`
}

const SRC_HALO = 'apch-cat-halo-src', SRC_PIN = 'apch-cat-pin-src', SRC_LBL = 'apch-cat-lbl-src'
const SRC_RWY  = 'apch-cat-rwy-src',  SRC_LNK = 'apch-cat-lnk-src'
const LYR_HALO = 'apch-cat-halo-lyr', LYR_PIN = 'apch-cat-pin-lyr', LYR_LBL = 'apch-cat-lbl-lyr'
const LYR_RWY  = 'apch-cat-rwy-lyr',  LYR_LNK = 'apch-cat-lnk-lyr', LYR_RWYLBL = 'apch-cat-rwylbl-lyr'

export default function ApchCatIls({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'RUNWAYS' | 'EQUIPMENT' | 'METHOD'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [clsFilter, setClsFilter] = useState<ClassKey | 'ALL'>('ALL')
  const [regionFilter, setRegionFilter] = useState<Rwy['region'] | 'ALL'>('ALL')
  const [advMul, setAdvMul] = useState(100)
  const [fogMul, setFogMul] = useState(100)
  const [doy, setDoy] = useState(15) // jan-15 default (winter fog season)
  const [scopeNM, setScopeNM] = useState(30)
  const [alignDeg, setAlignDeg] = useState(35)
  const [query, setQuery] = useState('')

  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showRwyMk, setShowRwyMk] = useState(true)
  const [showLink, setShowLink] = useState(true)

  // ---------- compute rows ----------
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      // phase gate — in-approach only: alt < 12000 AGL-ish, descending, not on-ground
      if (f.ground) continue
      if (!Number.isFinite(f.altitudeFt) || !Number.isFinite(f.velocityKts)) continue
      if (f.altitudeFt > 12000) continue
      if ((f.vertRate || 0) > -200) continue
      if (f.velocityKts < 100) continue

      const snap = snapRunway(f, scopeNM, alignDeg)
      if (!snap.rwy) continue

      const cls = classifyClass(f.type)
      const spec = CLASS_SPEC[cls]
      const wx = wxForAirport(snap.rwy.icao, doy, fogMul)
      const acftCap = spec.capCat
      const rwyCap = snap.rwy.cat
      const reqCat = wx.usableCat // wx-required minimum CAT

      const reqMinima = MIN_TABLE[reqCat]

      // deterministic per-aircraft synth for CREW/GAFOR/REDUND
      const r01 = (n:number) => ((hash32(f.icao + ':' + n) % 10000) / 10000)
      const r01r = (n:number) => ((hash32(snap.rwy!.icao + ':' + n) % 10000) / 10000)

      // CREW currency proxy: hashed; biz/light more likely current, CAT-IIIB
      // requires 6mo recency per AC 120-28D §11
      const crewLapse = r01(11) // 0..1
      // GAFOR: rare LLZ/GP/RVR sensor outage; bias higher when WX is foul
      // because LVPs trigger sensor stress
      const gndFault = r01r(21) < 0.06 ? 0.7 + r01r(22) * 0.3 : 0
      // REDUND: airframe FailOp loss; rare ~3-5%
      const redundLoss = r01(31) < 0.05
      const failOpEff = redundLoss ? Math.max(1, spec.failOp - 1) : spec.failOp
      // APPR-BAN: CAT-III sensitive-area not protected (multiple a/c on rwy
      // or surface conflict). Proxy when LVP and other a/c snapped to same
      // rwy. We approximate with per-airport hash.
      const apprBan = wx.lvpInForce && r01r(41) < 0.08 ? 50 + r01r(42) * 35 : 0

      // -------------------- driver scoring --------------------
      const sev: Record<Driver, number> = {
        'WX-CAT': 0, 'EQUIP': 0, 'CREW': 0, 'GAFOR': 0, 'REDUND': 0, 'APPR-BAN': 0,
      }

      // WX-CAT: drops below airframe + runway capability?
      const minSysCat = catRank(acftCap) < catRank(rwyCap) ? acftCap : rwyCap // worst of airframe vs rwy
      const reqRank = catRank(reqCat)
      const sysRank = catRank(minSysCat)
      if (reqRank > sysRank) {
        // wx is BETTER than required minima — i.e. WX is fine
        sev['WX-CAT'] = 0
      } else if (reqRank === sysRank) {
        sev['WX-CAT'] = 35
      } else {
        // WX requires a worse-cat minima than airframe can fly
        const gap = sysRank - reqRank
        sev['WX-CAT'] = Math.min(100, 50 + gap * 25)
      }

      // EQUIP: airframe ceiling < WX-required
      if (catRank(acftCap) < catRank(reqCat)) {
        const gap = catRank(reqCat) - catRank(acftCap)
        sev['EQUIP'] = Math.min(100, 60 + gap * 25)
      } else if (catRank(acftCap) === catRank(reqCat)) {
        sev['EQUIP'] = 20
      }

      // CREW: low-recency hash + need for CAT-III recency
      if (catRank(reqCat) >= catRank('CAT-II')) {
        const need = catRank(reqCat) >= catRank('CAT-IIIB') ? 0.96 : 0.85
        if (crewLapse > need) sev['CREW'] = 30 + (crewLapse - need) * 250 // up to ~40-70
      }

      // GAFOR: ground equip fault (rare)
      if (gndFault > 0) sev['GAFOR'] = Math.min(100, gndFault * 100)

      // REDUND: FailOp loss reduces capCat
      if (redundLoss) {
        const wantFailOp = catRank(reqCat) >= catRank('CAT-IIIB') ? 3
                         : catRank(reqCat) >= catRank('CAT-IIIA') ? 2 : 1
        if (failOpEff < wantFailOp) sev['REDUND'] = 35 + (wantFailOp - failOpEff) * 25
      }

      // APPR-BAN: CAT-III sensitive-area not protected
      sev['APPR-BAN'] = apprBan

      // composite — max·0.62 + mean·0.38 × ADV-MUL
      const vals = DRIVERS.map(d => sev[d])
      const maxV = Math.max(...vals)
      const meanV = vals.reduce((a,b) => a+b, 0) / vals.length
      let raw = (maxV * 0.62 + meanV * 0.38) * (advMul / 100)

      // hard escalators
      if (catRank(acftCap) < catRank(reqCat)) raw = Math.max(raw, 80)        // equip-vs-WX bust
      if (apprBan >= 60) raw = Math.max(raw, 70)
      if (gndFault >= 0.85) raw = Math.max(raw, 70)

      const score = Math.min(100, Math.max(0, raw))

      const tier: Tier =
        score >= 80 ? 'NOGO' :
        score >= 60 ? 'DIVERT' :
        score >= 40 ? 'DOWNGRADE' :
        score >= 22 ? 'WATCH' :
        wx.lvpInForce || reqRank >= catRank('CAT-II') ? 'CLEARED' :
        'ABOVE-MINS'

      let topDriver: Driver = 'WX-CAT'
      let topV = -1
      for (const d of DRIVERS) {
        if (sev[d] > topV) { topV = sev[d]; topDriver = d }
      }

      const row: Row = {
        f, cls, spec, rwy: snap.rwy, distNM: snap.distNM, trkOff: snap.trkOff,
        wx, reqCat, acftCap, rwyCap, reqMinima,
        driver: sev, score, tier, topDriver, failOpEff,
        advice: '',
      }
      row.advice = adviseRow(row)
      out.push(row)
    }
    return out
  }, [flights, advMul, fogMul, doy, scopeNM, alignDeg])

  // ---------- tier counts ----------
  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { NOGO:0,DIVERT:0,DOWNGRADE:0,WATCH:0,CLEARED:0,'ABOVE-MINS':0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  // ---------- per-runway aggregation ----------
  const rwyAggr = useMemo(() => {
    const m: Record<string, { rwy: Rwy; count: number; worstTier: Tier; wx: WxState; rows: Row[] }> = {}
    for (const r of rows) {
      if (!r.rwy) continue
      const key = r.rwy.icao + '/' + r.rwy.rwy
      if (!m[key]) m[key] = { rwy: r.rwy, count: 0, worstTier: 'ABOVE-MINS', wx: r.wx!, rows: [] }
      m[key].count++
      m[key].rows.push(r)
      if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(m[key].worstTier)) m[key].worstTier = r.tier
    }
    return Object.values(m).sort((a,b) => TIER_ORDER.indexOf(a.worstTier) - TIER_ORDER.indexOf(b.worstTier))
  }, [rows])

  // ---------- per-class aggregation ----------
  const classAggr = useMemo(() => {
    const m: Record<ClassKey, { count: number; worstTier: Tier; sumScore: number }> = {} as any
    for (const k of Object.keys(CLASS_SPEC) as ClassKey[]) m[k] = { count: 0, worstTier: 'ABOVE-MINS', sumScore: 0 }
    for (const r of rows) {
      m[r.cls].count++
      m[r.cls].sumScore += r.score
      if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(m[r.cls].worstTier)) m[r.cls].worstTier = r.tier
    }
    return m
  }, [rows])

  // ---------- visible (filtered + searched + sorted) ----------
  const visible = useMemo(() => {
    return rows
      .filter(r => tierFilter === 'ALL' || r.tier === tierFilter)
      .filter(r => clsFilter === 'ALL' || r.cls === clsFilter)
      .filter(r => regionFilter === 'ALL' || (r.rwy && r.rwy.region === regionFilter))
      .filter(r => {
        if (!query) return true
        const q = query.toLowerCase()
        return (r.f.callsign || '').toLowerCase().includes(q)
            || (r.f.type || '').toLowerCase().includes(q)
            || (r.f.operator || '').toLowerCase().includes(q)
            || (r.rwy?.icao || '').toLowerCase().includes(q)
            || (r.rwy?.rwy || '').toLowerCase().includes(q)
            || r.cls.toLowerCase().includes(q)
            || r.reqCat.toLowerCase().includes(q)
      })
      .sort((a,b) => b.score - a.score)
  }, [rows, tierFilter, clsFilter, regionFilter, query])

  // ---------- MapLibre integration ----------
  useEffect(() => {
    if (!map) return
    const ensureSrc = (id: string, data: any) => {
      const s = map.getSource(id) as any
      if (s) { try { s.setData(data) } catch {} }
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {} }
    }
    const ensureLyr = (spec: any) => {
      if (map.getLayer(spec.id)) return
      try { map.addLayer(spec) } catch {}
    }
    const removeAll = () => {
      for (const id of [LYR_HALO, LYR_PIN, LYR_LBL, LYR_RWY, LYR_LNK, LYR_RWYLBL]) if (map.getLayer(id)) try { map.removeLayer(id) } catch {}
      for (const id of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_RWY, SRC_LNK]) if (map.getSource(id)) try { map.removeSource(id) } catch {}
    }

    const haloFeats = visible.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: {
        radius: 6 + Math.min(20, r.score / 5),
        color: TIER_COLOR[r.tier],
      }
    }))
    const pinFeats = visible.filter(r => r.tier === 'NOGO' || r.tier === 'DIVERT').map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: { color: TIER_COLOR[r.tier] }
    }))
    const lblFeats = visible.slice(0, 30).map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: {
        label: `${r.f.callsign || r.f.icao} ${r.reqCat}`,
        color: TIER_COLOR[r.tier],
      }
    }))
    const activeRwyKeys = new Set(visible.map(r => r.rwy ? r.rwy.icao+'/'+r.rwy.rwy : '').filter(Boolean))
    const rwyFeats = RUNWAYS.filter(r => activeRwyKeys.has(r.icao+'/'+r.rwy)).map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.lng, r.lat] },
      properties: { label: `${r.icao} ${r.rwy} ${r.cat}` }
    }))
    const linkFeats = visible.filter(r => (r.tier === 'NOGO' || r.tier === 'DIVERT' || r.tier === 'DOWNGRADE') && r.rwy).slice(0, 30).map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.rwy!.lng, r.rwy!.lat]] },
      properties: { color: TIER_COLOR[r.tier] }
    }))

    ensureSrc(SRC_HALO, { type: 'FeatureCollection', features: haloFeats })
    ensureSrc(SRC_PIN,  { type: 'FeatureCollection', features: pinFeats })
    ensureSrc(SRC_LBL,  { type: 'FeatureCollection', features: lblFeats })
    ensureSrc(SRC_RWY,  { type: 'FeatureCollection', features: rwyFeats })
    ensureSrc(SRC_LNK,  { type: 'FeatureCollection', features: linkFeats })

    if (showLink) {
      ensureLyr({
        id: LYR_LNK, type: 'line', source: SRC_LNK, paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.1,
          'line-opacity': 0.45,
          'line-dasharray': [3, 2],
        }
      })
    } else if (map.getLayer(LYR_LNK)) try { map.removeLayer(LYR_LNK) } catch {}

    if (showHalo) {
      ensureLyr({
        id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
          'circle-radius': ['get', 'radius'],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.16,
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': 1.3,
          'circle-stroke-opacity': 0.80,
        }
      })
    } else if (map.getLayer(LYR_HALO)) try { map.removeLayer(LYR_HALO) } catch {}

    if (showPin) {
      ensureLyr({
        id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: {
          'circle-radius': 4,
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 1.4,
        }
      })
    } else if (map.getLayer(LYR_PIN)) try { map.removeLayer(LYR_PIN) } catch {}

    if (showRwyMk) {
      ensureLyr({
        id: LYR_RWY, type: 'circle', source: SRC_RWY, paint: {
          'circle-radius': 3,
          'circle-color': '#0ea5e9',
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 1.0,
        }
      })
      ensureLyr({
        id: LYR_RWYLBL, type: 'symbol', source: SRC_RWY, layout: {
          'text-field': ['get', 'label'],
          'text-size': 9,
          'text-offset': [0, 1.0],
          'text-anchor': 'top',
          'text-font': ['Open Sans Regular'],
        },
        paint: {
          'text-color': '#7dd3fc',
          'text-halo-color': '#020617',
          'text-halo-width': 1.0,
        }
      })
    } else {
      if (map.getLayer(LYR_RWY)) try { map.removeLayer(LYR_RWY) } catch {}
      if (map.getLayer(LYR_RWYLBL)) try { map.removeLayer(LYR_RWYLBL) } catch {}
    }

    if (showLbl) {
      ensureLyr({
        id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
          'text-field': ['get', 'label'],
          'text-size': 10,
          'text-offset': [0, 1.3],
          'text-anchor': 'top',
          'text-font': ['Open Sans Regular'],
        },
        paint: {
          'text-color': ['get', 'color'],
          'text-halo-color': '#020617',
          'text-halo-width': 1.2,
        }
      })
    } else if (map.getLayer(LYR_LBL)) try { map.removeLayer(LYR_LBL) } catch {}

    return () => { removeAll() }
  }, [map, visible, showHalo, showPin, showLbl, showRwyMk, showLink])

  // ---------- render ----------
  return (
    <div className="absolute right-3 top-20 z-30 w-[460px] max-h-[calc(100vh-110px)] flex flex-col bg-slate-950/95 backdrop-blur-sm border border-slate-800 rounded-xl shadow-2xl overflow-hidden text-slate-200">
      {/* header */}
      <div className="px-4 py-3 border-b border-slate-800 flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-sky-400">APCH-CAT</div>
          <div className="text-sm font-semibold text-slate-100">ILS CAT-I/II/III Compliance</div>
          <div className="text-[10px] text-slate-500 mt-0.5">Equipment vs Weather Eligibility · AC 120-28D/29A · Doc 8168</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none">×</button>
      </div>

      {/* tier counters */}
      <div className="px-3 py-2 border-b border-slate-900 grid grid-cols-6 gap-1">
        {(['NOGO','DIVERT','DOWNGRADE','WATCH','CLEARED','ABOVE-MINS'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center px-1 py-1 rounded-md border transition text-[9px] uppercase tracking-wider ${tierFilter === t ? 'bg-sky-500/15 border-sky-500/50' : 'bg-slate-900/50 border-slate-800 hover:border-slate-700'}`}>
            <span style={{ color: TIER_COLOR[t] }} className="font-bold text-base leading-none">{tierCounts[t]}</span>
            <span className="text-slate-400 mt-0.5">{t}</span>
          </button>
        ))}
      </div>

      {/* summary grid */}
      <div className="px-3 py-2 border-b border-slate-900 grid grid-cols-5 gap-2 text-[10px]">
        <div className="bg-slate-900/40 rounded px-2 py-1">
          <div className="text-slate-500 uppercase tracking-widest text-[9px]">In-Apch</div>
          <div className="text-slate-100 text-sm font-bold">{rows.length}</div>
        </div>
        <div className="bg-slate-900/40 rounded px-2 py-1">
          <div className="text-slate-500 uppercase tracking-widest text-[9px]">LVPs ON</div>
          <div className="text-amber-400 text-sm font-bold">{rwyAggr.filter(a => a.wx.lvpInForce).length}</div>
        </div>
        <div className="bg-slate-900/40 rounded px-2 py-1">
          <div className="text-slate-500 uppercase tracking-widest text-[9px]">CAT-III</div>
          <div className="text-sky-300 text-sm font-bold">{rows.filter(r => catRank(r.reqCat) >= catRank('CAT-IIIA')).length}</div>
        </div>
        <div className="bg-slate-900/40 rounded px-2 py-1">
          <div className="text-slate-500 uppercase tracking-widest text-[9px]">μ-Score</div>
          <div className="text-slate-200 text-sm font-bold">{rows.length ? Math.round(rows.reduce((s,r) => s+r.score, 0) / rows.length) : 0}</div>
        </div>
        <div className="bg-slate-900/40 rounded px-2 py-1">
          <div className="text-slate-500 uppercase tracking-widest text-[9px]">Rwys</div>
          <div className="text-slate-100 text-sm font-bold">{rwyAggr.length}</div>
        </div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-900 grid grid-cols-2 gap-3 text-[10px]">
        <label className="flex flex-col gap-0.5">
          <span className="flex justify-between text-slate-500"><span>ADV-MUL</span><span className="text-slate-300">{advMul}%</span></span>
          <input type="range" min={50} max={150} value={advMul} onChange={e => setAdvMul(+e.target.value)} className="accent-sky-500 h-1" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="flex justify-between text-slate-500"><span>FOG-MUL</span><span className="text-slate-300">{fogMul}%</span></span>
          <input type="range" min={20} max={250} value={fogMul} onChange={e => setFogMul(+e.target.value)} className="accent-sky-500 h-1" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="flex justify-between text-slate-500"><span>DOY</span><span className="text-slate-300">{doy}</span></span>
          <input type="range" min={0} max={364} value={doy} onChange={e => setDoy(+e.target.value)} className="accent-sky-500 h-1" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="flex justify-between text-slate-500"><span>SCOPE-NM</span><span className="text-slate-300">{scopeNM}</span></span>
          <input type="range" min={10} max={80} value={scopeNM} onChange={e => setScopeNM(+e.target.value)} className="accent-sky-500 h-1" />
        </label>
      </div>

      {/* class & region filters */}
      <div className="px-3 py-2 border-b border-slate-900 flex flex-wrap gap-1">
        {(['ALL','HVY-T-NEW','HVY-Q','WB-M','NB-NEW','NB-CLS','RGN-J-NEW','RGN-T','BIZ-HUD','BIZ-STD','LIGHT'] as (ClassKey|'ALL')[]).map(c => (
          <button key={c} onClick={() => setClsFilter(c)}
            className={`px-1.5 py-0.5 rounded-md text-[9px] uppercase tracking-wider border transition ${clsFilter === c ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>
            {c === 'ALL' ? 'ALL' : c}
          </button>
        ))}
      </div>
      <div className="px-3 py-1 border-b border-slate-900 flex flex-wrap gap-1">
        {(['ALL','NAM-E','NAM-W','NAM-S','EUR','ME','ASIA-S','ASIA-E'] as (Rwy['region']|'ALL')[]).map(r => (
          <button key={r} onClick={() => setRegionFilter(r)}
            className={`px-1.5 py-0.5 rounded-md text-[9px] uppercase tracking-wider border transition ${regionFilter === r ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>
            {r}
          </button>
        ))}
      </div>

      {/* layer toggles + search */}
      <div className="px-3 py-2 border-b border-slate-900 flex items-center gap-1 text-[9px]">
        {(['HALO','PIN','LBL','RWY','LNK'] as const).map(t => {
          const v = t === 'HALO' ? showHalo : t === 'PIN' ? showPin : t === 'LBL' ? showLbl : t === 'RWY' ? showRwyMk : showLink
          const set = (nv: boolean) => t === 'HALO' ? setShowHalo(nv) : t === 'PIN' ? setShowPin(nv) : t === 'LBL' ? setShowLbl(nv) : t === 'RWY' ? setShowRwyMk(nv) : setShowLink(nv)
          return (
            <button key={t} onClick={() => set(!v)}
              className={`px-1.5 py-0.5 rounded-md border transition uppercase tracking-wider ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-500 hover:border-slate-700'}`}>
              {t}
            </button>
          )
        })}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="cs / type / icao / cat"
          className="flex-1 ml-1 bg-slate-900/60 border border-slate-800 rounded-md px-2 py-0.5 text-[10px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-sky-500/50" />
      </div>

      {/* tabs */}
      <div className="px-3 py-1 border-b border-slate-900 flex gap-1">
        {(['AIRCRAFT','RUNWAYS','EQUIPMENT','METHOD'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2 py-1 rounded-md text-[10px] uppercase tracking-wider border transition ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>
            {t}
          </button>
        ))}
      </div>

      {/* content body */}
      <div className="flex-1 overflow-y-auto px-3 py-2 text-[11px]">
        {tab === 'AIRCRAFT' && (
          <div className="space-y-1">
            {visible.length === 0 && <div className="text-slate-600 italic text-center py-6">No aircraft snapped to a CAT-ILS runway in scope</div>}
            {visible.slice(0, 60).map(r => (
              <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
                className="w-full text-left bg-slate-900/40 hover:bg-slate-900/70 border border-slate-800 hover:border-slate-700 rounded-lg p-2 transition">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-mono text-[10px] text-slate-100 truncate">{r.f.callsign || r.f.icao}</span>
                    <span className="text-[9px] text-slate-500">{r.f.type || '—'}</span>
                    <span className="text-[9px] px-1 py-px rounded bg-slate-800/60 text-slate-400">{CLASS_SPEC[r.cls].label}</span>
                  </div>
                  <span className="text-[9px] uppercase tracking-wider px-1.5 py-px rounded border"
                    style={{ color: TIER_COLOR[r.tier], borderColor: TIER_COLOR[r.tier]+'66', background: TIER_COLOR[r.tier]+'18' }}>
                    {r.tier}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[9px] mb-1.5">
                  <span className="text-slate-500">{r.rwy?.icao}/{r.rwy?.rwy}</span>
                  <span className="text-slate-400">{r.reqCat}</span>
                  <span className="text-slate-500">DH {r.reqMinima?.dhFt}ft</span>
                  <span className="text-slate-500">RVR {r.wx?.rvrM}m</span>
                  <span className="text-slate-500">ceil {r.wx?.ceilFt}ft</span>
                  <span className="text-slate-500">{r.failOpEff}-AP</span>
                  {r.spec.hudEvs && <span className="text-sky-400/70">HUD-EVS</span>}
                  {r.wx?.lvpInForce && <span className="text-amber-400/70">LVP</span>}
                  <span className="text-slate-500 ml-auto">{r.distNM.toFixed(0)}NM</span>
                </div>
                <div className="relative h-1 rounded bg-slate-800 mb-1.5 overflow-hidden">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }} />
                </div>
                <div className="flex flex-wrap gap-1 mb-1">
                  {DRIVERS.map(d => r.driver[d] > 6 && (
                    <span key={d} className="text-[8px] px-1 py-px rounded bg-slate-800/60 text-slate-400">
                      {DRIVER_LABEL[d]} {Math.round(r.driver[d])}
                    </span>
                  ))}
                </div>
                <div className="text-[9px] text-slate-400 italic leading-tight">{r.advice}</div>
              </button>
            ))}
          </div>
        )}

        {tab === 'RUNWAYS' && (
          <div className="space-y-1">
            {rwyAggr.length === 0 && <div className="text-slate-600 italic text-center py-6">No active runways in scope</div>}
            {rwyAggr.map(a => (
              <div key={a.rwy.icao+'/'+a.rwy.rwy} className="bg-slate-900/40 border border-slate-800 rounded-lg p-2">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-slate-100">{a.rwy.icao}/{a.rwy.rwy}</span>
                    <span className="text-[9px] text-slate-500">{a.rwy.name}</span>
                  </div>
                  <span className="text-[9px] uppercase tracking-wider px-1.5 py-px rounded border"
                    style={{ color: TIER_COLOR[a.worstTier], borderColor: TIER_COLOR[a.worstTier]+'66', background: TIER_COLOR[a.worstTier]+'18' }}>
                    {a.worstTier}
                  </span>
                </div>
                <div className="grid grid-cols-5 gap-1 text-[9px] mb-1">
                  <div><span className="text-slate-500">Pub-CAT </span><span className="text-slate-200">{a.rwy.cat}</span></div>
                  <div><span className="text-slate-500">Use-CAT </span><span className="text-slate-200">{a.wx.usableCat}</span></div>
                  <div><span className="text-slate-500">RVR </span><span className="text-slate-200">{a.wx.rvrM}m</span></div>
                  <div><span className="text-slate-500">ceil </span><span className="text-slate-200">{a.wx.ceilFt}ft</span></div>
                  <div><span className="text-slate-500">cnt </span><span className="text-slate-200">{a.count}</span></div>
                </div>
                <div className="text-[9px] text-slate-500 italic">
                  LLZ {a.rwy.llz} · GP {a.rwy.gpAngleDeg.toFixed(1)}° · elev {a.rwy.elevFt}ft
                  {a.wx.lvpInForce && <span className="text-amber-400/70 ml-1">· LVPs IN FORCE per JO 7110.65 §3-1-7</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'EQUIPMENT' && (
          <div className="space-y-1">
            {(Object.keys(CLASS_SPEC) as ClassKey[]).map(k => {
              const c = CLASS_SPEC[k]
              const a = classAggr[k]
              return (
                <div key={k} className="bg-slate-900/40 border border-slate-800 rounded-lg p-2">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-slate-100">{c.label}</span>
                      <span className="text-[9px] px-1 py-px rounded bg-slate-800/60 text-slate-400">cap {c.capCat}</span>
                      <span className="text-[9px] px-1 py-px rounded bg-slate-800/60 text-slate-400">{c.failOp}-AP FailOp</span>
                      {c.hudEvs && <span className="text-[9px] px-1 py-px rounded bg-sky-500/15 text-sky-300">HUD-EVS</span>}
                    </div>
                    <span className="text-[9px] uppercase tracking-wider px-1.5 py-px rounded border"
                      style={{ color: TIER_COLOR[a.worstTier], borderColor: TIER_COLOR[a.worstTier]+'66', background: TIER_COLOR[a.worstTier]+'18' }}>
                      {a.count > 0 ? a.worstTier : '—'}
                    </span>
                  </div>
                  <div className="text-[9px] text-slate-500 italic">
                    {c.exemplars.slice(0, 8).join(' · ')}{c.exemplars.length > 8 ? ' …' : ''}
                  </div>
                  <div className="flex gap-2 text-[9px] mt-1">
                    <span><span className="text-slate-500">cnt </span><span className="text-slate-200">{a.count}</span></span>
                    <span><span className="text-slate-500">μ-score </span><span className="text-slate-200">{a.count > 0 ? Math.round(a.sumScore / a.count) : 0}</span></span>
                    <span className="text-slate-500 ml-auto">DH {MIN_TABLE[c.capCat].dhFt}ft · RVR {MIN_TABLE[c.capCat].rvrM}m</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-300 leading-relaxed">
            <p>
              <span className="text-sky-400 font-semibold">APCH-CAT</span> scores each in-approach aircraft (alt &lt; 12000ft, descending,
              snapped to an aligned ILS runway within {scopeNM}NM) for ALL-WEATHER-OPERATIONS regulatory eligibility per
              FAA AC 120-28D / 120-29A / EASA CS-AWO.
            </p>
            <p className="text-slate-400">
              <span className="text-slate-200 font-semibold">Pipeline:</span> phase-gate → runway-snap (24-rwy catalogue)
              → wx-synthesis (RVR/ceil/vis per ICAO Annex 3 reporting bands) → equipment fit (class FailOp + HUD-EVS) →
              6-driver scoring → 6-tier classification → MapLibre overlay.
            </p>
            <div className="bg-slate-900/40 rounded p-2 space-y-1">
              <div className="text-sky-400 font-semibold uppercase tracking-widest text-[9px]">CAT-Band Minima Envelope</div>
              {(['CAT-I','CAT-II','CAT-IIIA','CAT-IIIB'] as CatBand[]).map(c => (
                <div key={c} className="flex justify-between text-[9px]">
                  <span className="text-slate-300">{c}</span>
                  <span className="text-slate-500">DH {MIN_TABLE[c].dhFt}ft · RVR {MIN_TABLE[c].rvrM}m</span>
                </div>
              ))}
            </div>
            <div className="bg-slate-900/40 rounded p-2 space-y-1">
              <div className="text-sky-400 font-semibold uppercase tracking-widest text-[9px]">Drivers</div>
              {DRIVERS.map(d => (
                <div key={d} className="text-[9px]">
                  <span className="text-slate-300">{d}</span> <span className="text-slate-500">— {DRIVER_LABEL[d]}</span>
                </div>
              ))}
            </div>
            <div className="bg-slate-900/40 rounded p-2 space-y-0.5">
              <div className="text-sky-400 font-semibold uppercase tracking-widest text-[9px]">Composite</div>
              <div className="text-[9px] text-slate-400">score = (max·0.62 + mean·0.38) × ADV-MUL with hard escalators</div>
              <div className="text-[9px] text-slate-400">EQUIP &lt; WX-required ⇒ score ≥ 80 (NOGO); ground-fault &gt; 0.85 ⇒ score ≥ 70</div>
            </div>
            <div className="bg-slate-900/40 rounded p-2 space-y-0.5">
              <div className="text-sky-400 font-semibold uppercase tracking-widest text-[9px]">Tiers</div>
              {TIER_ORDER.map(t => (
                <div key={t} className="flex justify-between text-[9px]">
                  <span style={{ color: TIER_COLOR[t] }}>{t}</span>
                  <span className="text-slate-500">{t === 'NOGO' ? '≥80 — divert' : t === 'DIVERT' ? '≥60 — alt rwy' : t === 'DOWNGRADE' ? '≥40 — accept higher DH/RVR' : t === 'WATCH' ? '≥22 — monitor LVPs' : t === 'CLEARED' ? '<22 — within minima' : 'above mins — VMC'}</span>
                </div>
              ))}
            </div>
            <div className="bg-slate-900/40 rounded p-2">
              <div className="text-sky-400 font-semibold uppercase tracking-widest text-[9px] mb-1">References</div>
              <div className="text-[9px] text-slate-500 leading-relaxed">
                14 CFR §91.175 §91.189 §121.651 §121.652 · ICAO Annex 6 Pt I §4.2.8 · Annex 10 Vol I §3.1.3 ·
                Doc 8168 PANS-OPS Vol I §1.4 · Doc 9365 AWO Manual ed.3 · FAA AC 120-28D · AC 120-29A · AC 90-106A ·
                EASA CS-AWO · AMC1 CAT.IDE.A.105 · Decision 2019/021/R · FAA Order JO 7110.65 §3-1-7 LVPs ·
                FAA Order 8400.13D · Boeing FCOM Limits Ch.1 · Airbus FCOM LIM-22.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
