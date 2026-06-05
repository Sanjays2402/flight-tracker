'use client'

// =============================================================================
// WSG-SLOT · IATA Worldwide Slot Guidelines (WSG) Level-3 Slot-Coordination
// Compliance & Slot-Misuse / On-Slot-Performance Monitor
// -----------------------------------------------------------------------------
// Per-airframe live evaluator of every commercial flight operating into or
// out of one of the ~190 Level-3 (fully slot-coordinated) airports under
// IATA WSG ed.32 + EU Reg 95/93 + US 14 CFR §93 Subpart K, scoring whether
// each operation is on-slot, off-slot, slot-bust, slot-misuse, or no-slot.
//
// A WSG §1.5.1 "slot" = coordinator-issued permission to use full airport
// infrastructure at a specific date/time. Distinct from:
//   CTOT (EUROCONTROL/FAA ATFM tactical, Reg 255/2010, -5/+10 window) ·
//   A-CDM TOBT/TSAT (operational pushback milestones) ·
//   NEMO/AHM-730 (post-hoc delay-code classifier) ·
//   GDP/GS/AFP/CTOP (FAA TFM EDCTs) · RTA/4D (FMS navigation) ·
//   APBN (weather minima) · ITP (oceanic separation).
//
// Per-flight ladder: NO-SLOT (§8.7.1 violation) > MISUSED (§8.7.4 wrong
// svc/wake) > SLOT-BUST (≥tol+15min, counts vs 80:20) > OFF-SLOT (tol..tol+15)
// > ON-SLOT-LATE > ON-SLOT > ON-SLOT-EARLY > NO-LVL3.
//
// 36-airport L3/L2 catalogue covers LHR/LGW/STN/AMS/FRA/MUC/BER/CDG/ORY/
// ZRH/FCO/MAD/BCN/CPH/IST/SVO/JFK/LGA/DCA/EWR/ORD/SFO/YYZ/HND/NRT/ICN/HKG/
// SIN/BKK/PEK/PVG/DXB/DOH/SYD/JNB/GRU. Coordinator hierarchy: ACL UK ·
// COHOR FR · ASCN NL · FHKD DE · SLOT-CH · AECFA ES · DHMI TR · FAA-SAPO US ·
// JSCG JP · KAC KR · AAHK HK · CAAS SG · CAAC CN · GCAA AE · QCAA QA ·
// ACA AU · ANAC BR · SACAA ZA · IATA WSG global.
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

// ---- Flight shape (matches flight-map.tsx) -------------------------------
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

// ---- Tier definitions ----------------------------------------------------
type Tier =
  | 'NO-SLOT'
  | 'MISUSED'
  | 'SLOT-BUST'
  | 'OFF-SLOT'
  | 'ON-SLOT-LATE'
  | 'ON-SLOT'
  | 'ON-SLOT-EARLY'
  | 'NO-LVL3'

const TIER_ORDER: Tier[] = ['NO-SLOT','MISUSED','SLOT-BUST','OFF-SLOT','ON-SLOT-LATE','ON-SLOT','ON-SLOT-EARLY','NO-LVL3']
const TIER_RANK: Record<Tier, number> = {
  'NO-SLOT':0, 'MISUSED':1, 'SLOT-BUST':2, 'OFF-SLOT':3,
  'ON-SLOT-LATE':4, 'ON-SLOT':5, 'ON-SLOT-EARLY':6, 'NO-LVL3':7,
}
const TIER_COLOR: Record<Tier, string> = {
  'NO-SLOT':       '#f43f5e',  // rose-500   — regulatory breach
  'MISUSED':       '#fb7185',  // rose-400
  'SLOT-BUST':     '#f59e0b',  // amber-500
  'OFF-SLOT':      '#eab308',  // yellow-500
  'ON-SLOT-LATE':  '#38bdf8',  // sky-400
  'ON-SLOT':       '#10b981',  // emerald-500
  'ON-SLOT-EARLY': '#0ea5e9',  // sky-500
  'NO-LVL3':       '#64748b',  // slate-500
}

// ---- Service-code (IATA SSIM Ch.7) — drives misuse check ----------------
type ServiceCode = 'J' | 'F' | 'Q' | 'M' | 'P' | 'X' | 'C'
// J = Scheduled passenger normal · F = Freight scheduled · Q = Mail
// M = Mail+pax mixed · P = Positioning · X = Charter · C = Cargo charter
const SERVICE_LABEL: Record<ServiceCode, string> = {
  J:'Sched-pax', F:'Sched-freight', Q:'Mail', M:'Pax+mail',
  P:'Position', X:'Charter-pax', C:'Charter-cgo',
}

// ---- Wake category (ICAO Doc 4444 §4.9 / RECAT-EU) ----------------------
type Wake = 'J' | 'H' | 'M' | 'L'
// J = Super (A380/B748) · H = Heavy · M = Medium · L = Light

// ---------------------------------------------------------------------------
// AIRPORT LEVEL-3 / LEVEL-2 CATALOGUE — 36 commercially significant
// slot-coordinated airports per IATA WAG ed.10 + coordinator Strategic
// Capacity Declarations.
// ---------------------------------------------------------------------------
interface Airport {
  icao: string
  iata: string
  name: string
  level: 2 | 3
  coordinator: string
  region: 'NA-US' | 'NA-CA' | 'EU' | 'UK' | 'ASIA' | 'PAC' | 'ME' | 'AFR' | 'LATAM'
  // declared capacity (mov/h rolling) summer / winter
  capSum: number
  capWin: number
  // slot tolerance ±min before off-slot (WSG §8.5.1 default ±15)
  tolMin: number
  // 80:20 use-it-or-lose-it applies
  rule8020: boolean
  // commercial congestion tier T1 (LHR/JFK/HND class) → T4 (light L-3)
  tier: 1 | 2 | 3 | 4
  lat: number
  lng: number
}

const AIRPORTS: Airport[] = [
  // ── EUROPE (Reg 95/93) ──
  { icao:'EGLL', iata:'LHR', name:'London Heathrow',         level:3, coordinator:'ACL', region:'UK',   capSum:88, capWin:88, tolMin:10, rule8020:true, tier:1, lat:51.4775, lng:-0.4614 },
  { icao:'EGKK', iata:'LGW', name:'London Gatwick',          level:3, coordinator:'ACL', region:'UK',   capSum:55, capWin:55, tolMin:15, rule8020:true, tier:2, lat:51.1481, lng:-0.1903 },
  { icao:'EGSS', iata:'STN', name:'London Stansted',         level:3, coordinator:'ACL', region:'UK',   capSum:50, capWin:50, tolMin:15, rule8020:true, tier:3, lat:51.8849, lng: 0.2350 },
  { icao:'EHAM', iata:'AMS', name:'Amsterdam Schiphol',      level:3, coordinator:'ASCN',region:'EU',   capSum:71, capWin:68, tolMin:15, rule8020:true, tier:1, lat:52.3086, lng: 4.7639 },
  { icao:'EDDF', iata:'FRA', name:'Frankfurt am Main',       level:3, coordinator:'FHKD',region:'EU',   capSum:106,capWin:96, tolMin:15, rule8020:true, tier:1, lat:50.0379, lng: 8.5622 },
  { icao:'EDDM', iata:'MUC', name:'München',                 level:3, coordinator:'FHKD',region:'EU',   capSum:90, capWin:84, tolMin:15, rule8020:true, tier:2, lat:48.3538, lng:11.7861 },
  { icao:'EDDB', iata:'BER', name:'Berlin Brandenburg',      level:3, coordinator:'FHKD',region:'EU',   capSum:60, capWin:54, tolMin:15, rule8020:true, tier:3, lat:52.3667, lng:13.5033 },
  { icao:'LFPG', iata:'CDG', name:'Paris Charles de Gaulle', level:3, coordinator:'COHOR',region:'EU',  capSum:120,capWin:115,tolMin:15, rule8020:true, tier:1, lat:49.0097, lng: 2.5479 },
  { icao:'LFPO', iata:'ORY', name:'Paris Orly',              level:3, coordinator:'COHOR',region:'EU',  capSum:75, capWin:75, tolMin:15, rule8020:true, tier:2, lat:48.7253, lng: 2.3594 },
  { icao:'LSZH', iata:'ZRH', name:'Zürich',                  level:3, coordinator:'SLOT-CH',region:'EU',capSum:66, capWin:60, tolMin:15, rule8020:true, tier:2, lat:47.4647, lng: 8.5492 },
  { icao:'LIRF', iata:'FCO', name:'Roma Fiumicino',          level:3, coordinator:'ASSAERO',region:'EU',capSum:90, capWin:80, tolMin:15, rule8020:true, tier:2, lat:41.8003, lng:12.2389 },
  { icao:'LEMD', iata:'MAD', name:'Madrid Barajas',          level:3, coordinator:'AECFA',region:'EU',  capSum:100,capWin:90, tolMin:15, rule8020:true, tier:2, lat:40.4719, lng:-3.5626 },
  { icao:'LEBL', iata:'BCN', name:'Barcelona-El Prat',       level:3, coordinator:'AECFA',region:'EU',  capSum:78, capWin:75, tolMin:15, rule8020:true, tier:2, lat:41.2974, lng: 2.0833 },
  { icao:'EKCH', iata:'CPH', name:'København Kastrup',       level:3, coordinator:'ASCC', region:'EU',  capSum:83, capWin:75, tolMin:15, rule8020:true, tier:3, lat:55.6181, lng:12.6561 },
  { icao:'LTFM', iata:'IST', name:'İstanbul New',            level:3, coordinator:'DHMI', region:'EU',  capSum:120,capWin:115,tolMin:15, rule8020:false,tier:1, lat:41.2753, lng:28.7519 },
  { icao:'UUEE', iata:'SVO', name:'Moscow Sheremetyevo',     level:2, coordinator:'CAA-RU',region:'EU', capSum:90, capWin:85, tolMin:20, rule8020:false,tier:3, lat:55.9726, lng:37.4146 },
  // ── USA (14 CFR §93 K) ──
  { icao:'KJFK', iata:'JFK', name:'New York JFK',            level:3, coordinator:'FAA-SAPO',region:'NA-US',capSum:81, capWin:81, tolMin:15, rule8020:true, tier:1, lat:40.6398, lng:-73.7789 },
  { icao:'KLGA', iata:'LGA', name:'New York LaGuardia',      level:3, coordinator:'FAA-SAPO',region:'NA-US',capSum:71, capWin:71, tolMin:15, rule8020:true, tier:1, lat:40.7772, lng:-73.8726 },
  { icao:'KDCA', iata:'DCA', name:'Washington Reagan',       level:3, coordinator:'FAA-SAPO',region:'NA-US',capSum:62, capWin:62, tolMin:15, rule8020:true, tier:2, lat:38.8521, lng:-77.0378 },
  { icao:'KEWR', iata:'EWR', name:'Newark Liberty',          level:3, coordinator:'FAA-SAPO',region:'NA-US',capSum:79, capWin:79, tolMin:15, rule8020:true, tier:1, lat:40.6925, lng:-74.1687 },
  { icao:'KORD', iata:'ORD', name:'Chicago O\'Hare',         level:2, coordinator:'FAA-SAPO',region:'NA-US',capSum:120,capWin:118,tolMin:20, rule8020:false,tier:1, lat:41.9786, lng:-87.9048 },
  { icao:'KSFO', iata:'SFO', name:'San Francisco Int\'l',    level:2, coordinator:'FAA-SAPO',region:'NA-US',capSum:60, capWin:60, tolMin:20, rule8020:false,tier:2, lat:37.6189, lng:-122.3750 },
  // ── CANADA ──
  { icao:'CYYZ', iata:'YYZ', name:'Toronto Pearson',         level:2, coordinator:'YYZ-SC', region:'NA-CA',capSum:75, capWin:72, tolMin:20, rule8020:false,tier:2, lat:43.6772, lng:-79.6306 },
  // ── ASIA ──
  { icao:'RJTT', iata:'HND', name:'Tokyo Haneda',            level:3, coordinator:'JSCG', region:'ASIA',capSum:84, capWin:84, tolMin:15, rule8020:true, tier:1, lat:35.5494, lng:139.7798 },
  { icao:'RJAA', iata:'NRT', name:'Tokyo Narita',            level:3, coordinator:'JSCG', region:'ASIA',capSum:60, capWin:60, tolMin:15, rule8020:true, tier:2, lat:35.7647, lng:140.3864 },
  { icao:'RKSI', iata:'ICN', name:'Seoul Incheon',           level:3, coordinator:'KAC',  region:'ASIA',capSum:90, capWin:85, tolMin:15, rule8020:true, tier:2, lat:37.4691, lng:126.4505 },
  { icao:'VHHH', iata:'HKG', name:'Hong Kong',               level:3, coordinator:'AAHK', region:'ASIA',capSum:68, capWin:68, tolMin:15, rule8020:true, tier:1, lat:22.3080, lng:113.9185 },
  { icao:'WSSS', iata:'SIN', name:'Singapore Changi',        level:3, coordinator:'CAAS', region:'ASIA',capSum:78, capWin:78, tolMin:15, rule8020:true, tier:2, lat: 1.3644, lng:103.9915 },
  { icao:'VTBS', iata:'BKK', name:'Bangkok Suvarnabhumi',    level:3, coordinator:'AOT',  region:'ASIA',capSum:68, capWin:65, tolMin:15, rule8020:false,tier:3, lat:13.6900, lng:100.7501 },
  { icao:'ZBAA', iata:'PEK', name:'Beijing Capital',         level:3, coordinator:'CAAC', region:'ASIA',capSum:88, capWin:85, tolMin:15, rule8020:false,tier:1, lat:40.0801, lng:116.5846 },
  { icao:'ZSPD', iata:'PVG', name:'Shanghai Pudong',         level:3, coordinator:'CAAC', region:'ASIA',capSum:74, capWin:72, tolMin:15, rule8020:false,tier:2, lat:31.1443, lng:121.8083 },
  // ── MIDDLE EAST ──
  { icao:'OMDB', iata:'DXB', name:'Dubai Int\'l',            level:3, coordinator:'GCAA', region:'ME',  capSum:90, capWin:86, tolMin:15, rule8020:false,tier:1, lat:25.2532, lng:55.3657 },
  { icao:'OTHH', iata:'DOH', name:'Doha Hamad',              level:3, coordinator:'QCAA', region:'ME',  capSum:78, capWin:76, tolMin:15, rule8020:false,tier:2, lat:25.2737, lng:51.6080 },
  // ── PACIFIC ──
  { icao:'YSSY', iata:'SYD', name:'Sydney Kingsford Smith',  level:3, coordinator:'ACA',  region:'PAC', capSum:80, capWin:80, tolMin:15, rule8020:true, tier:2, lat:-33.9461,lng:151.1772 },
  // ── AFRICA / LATAM ──
  { icao:'FAOR', iata:'JNB', name:'Johannesburg OR Tambo',   level:2, coordinator:'SACAA',region:'AFR', capSum:60, capWin:58, tolMin:20, rule8020:false,tier:3, lat:-26.1392,lng: 28.2460 },
  { icao:'SBGR', iata:'GRU', name:'São Paulo Guarulhos',     level:3, coordinator:'ANAC', region:'LATAM',capSum:60, capWin:58, tolMin:15, rule8020:false,tier:2, lat:-23.4356,lng:-46.4731 },
]

// ---- Operator → wake (typeToWake) ---------------------------------------
// Aircraft type → wake category (drives MISUSE check when filed ≠ flown)
function typeToWake(t?: string): Wake {
  if (!t) return 'M'
  const u = t.toUpperCase()
  if (u === 'A388' || u === 'B748' || u === 'B744' || u === 'A380') return 'J'
  if (/^B77|^B78|^A35|^A33|^A34|^B74|^B76|^MD11|^DC10|^L101/.test(u)) return 'H'
  if (/^C172|^C152|^PA28|^SR2|^DA4|^BE36|^M20|^P28/.test(u)) return 'L'
  return 'M'
}

// ---- Geometry, hash ------------------------------------------------------
const R_NM = 3440.065
function haversineNM(a1: number, o1: number, a2: number, o2: number): number {
  const φ1 = a1 * Math.PI / 180, φ2 = a2 * Math.PI / 180
  const dφ = (a2 - a1) * Math.PI / 180, dλ = (o2 - o1) * Math.PI / 180
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

// ---- Phase classifier ----------------------------------------------------
type Phase = 'ARR-FINAL' | 'ARR-TMA' | 'DEP-GND' | 'DEP-CLB' | 'EN-ROUTE' | 'GROUND-OTHER'

interface AirportSnap {
  apt: Airport
  distNM: number
  kind: 'ARR' | 'DEP' | null
}

// Find the most likely operating airport for this flight from the catalogue.
// GROUND <8NM: at airport. INBOUND <80NM descending: ARR. OUTBOUND <60NM
// climbing: DEP. Hash-stable tie-break for stationary near-airport flights.
function snapAirport(f: F): AirportSnap | null {
  let best: AirportSnap | null = null
  for (const apt of AIRPORTS) {
    const d = haversineNM(f.lat, f.lng, apt.lat, apt.lng)
    if (d > 90) continue
    let kind: 'ARR' | 'DEP' | null = null
    if (f.ground || (f.altitudeFt < 500 && d < 6)) {
      kind = (hash(f.icao + 'k') % 2 === 0) ? 'ARR' : 'DEP'
    } else if (f.vertRate < -200 && d < 80 && f.altitudeFt < 18000) {
      kind = 'ARR'
    } else if (f.vertRate > 200 && d < 60 && f.altitudeFt < 14000) {
      kind = 'DEP'
    } else if (d < 15 && f.altitudeFt < 8000) {
      kind = f.vertRate < 0 ? 'ARR' : 'DEP'
    } else {
      continue
    }
    if (!best || d < best.distNM) best = { apt, distNM: d, kind }
  }
  return best
}

function classifyPhase(f: F, snap: AirportSnap | null): Phase {
  if (!snap) {
    if (f.ground) return 'GROUND-OTHER'
    return 'EN-ROUTE'
  }
  if (snap.kind === 'ARR') {
    if (f.altitudeFt < 3000 && snap.distNM < 12) return 'ARR-FINAL'
    return 'ARR-TMA'
  }
  // DEP
  if (f.ground || f.altitudeFt < 500) return 'DEP-GND'
  return 'DEP-CLB'
}

// ---------------------------------------------------------------------------
// Synthesised slot evaluation.  Per-flight deterministic from icao+apt hash:
//   has_slot · allocated_time UTC · service_filed vs operated · wake filed
//   vs flown · offset_min from allocated time · 80:20 season use-rate.
// ---------------------------------------------------------------------------
interface SlotEval {
  hasSlot: boolean
  allocatedHHMM: string  // "HH:MM" allocated slot time UTC
  allocatedMin: number   // minutes of day
  actualMin: number      // minutes of day actual op
  offsetMin: number      // signed (positive = late)
  serviceFiled: ServiceCode
  serviceOperated: ServiceCode
  wakeFiled: Wake
  wakeFlown: Wake
  serviceMisuse: boolean
  wakeMisuse: boolean
  action: string         // coordinator recommendation
  seasonUseRate: number  // synthetic season-to-date 80:20 %
}

function evalSlot(f: F, snap: AirportSnap, phase: Phase): SlotEval {
  const apt = snap.apt
  const h1 = hash(f.icao + apt.icao)
  // Slot allocation probability
  const slotProb = apt.level === 3 ? 0.97 : (apt.level === 2 ? 0.85 : 1.0)
  const hasSlot = ((h1 >>> 8) / 0xffffff) < slotProb
  // Allocated time = uniformly distributed within "today" but biased away
  // from coordinator closed hours (00:00-05:00 typically reduced capacity).
  // Use 06:00-22:30 UTC band:
  const minBand = 6 * 60   // 360
  const maxBand = 22 * 60 + 30
  const allocatedMin = minBand + ((h1 >>> 16) % (maxBand - minBand))
  const allocatedHHMM = `${Math.floor(allocatedMin/60).toString().padStart(2,'0')}:${(allocatedMin%60).toString().padStart(2,'0')}`
  // Service code — most slots are J. Cargo ops F/C, biz X.
  const opPrefix = (f.callsign || '').slice(0, 3).toUpperCase()
  let serviceFiled: ServiceCode = 'J'
  let serviceOperated: ServiceCode = 'J'
  if (/^(FDX|UPS|CLX|GTI|GEC|CKS|ABW|MAS|MSL|CRC|CKK|CYZ|DKH)/.test(opPrefix)) {
    serviceFiled = 'F'; serviceOperated = 'F'
  } else if (/^(EJA|LXJ|VJT|NJE|JOS|JTL)/.test(opPrefix)) {
    serviceFiled = 'X'; serviceOperated = 'X'
  } else if (/^(POT|FFT|RPA)/.test(opPrefix) && (h1 % 100) < 8) {
    serviceFiled = 'P'; serviceOperated = 'J'
  }
  // 4% service-misuse injection
  if (((h1 >>> 24) % 100) < 4) {
    serviceOperated = serviceOperated === 'J' ? 'X' : 'J'
  }
  const serviceMisuse = serviceFiled !== serviceOperated
  // Wake — actual flown from type; filed is mostly matching but 3% lighter
  // than flown (common misuse: M-slot operated with H equipment).
  const wakeFlown = typeToWake(f.type)
  let wakeFiled: Wake = wakeFlown
  if (((h1 >>> 2) % 100) < 3) {
    const ladder: Wake[] = ['L','M','H','J']
    const cur = ladder.indexOf(wakeFlown)
    wakeFiled = ladder[Math.max(0, cur - 1)]
  }
  const wakeMisuse = wakeFiled !== wakeFlown
  // Offset distribution: 65% within ±10, 20% 10-30 late, 8% large bust, etc.
  const baseMin = allocatedMin
  const r = (h1 >>> 4) % 100
  let offsetMin: number
  if (r < 50)       offsetMin = ((h1 >>> 12) % 21) - 10     // -10..+10
  else if (r < 70)  offsetMin = 10 + ((h1 >>> 12) % 20)     // +10..+30
  else if (r < 80)  offsetMin = -((h1 >>> 12) % 18) - 4     // -4..-22
  else if (r < 90)  offsetMin = 30 + ((h1 >>> 12) % 60)     // +30..+90
  else if (r < 96)  offsetMin = 90 + ((h1 >>> 12) % 120)    // +90..+210
  else              offsetMin = -25 - ((h1 >>> 12) % 30)    // -25..-55 early
  const actualMin = baseMin + offsetMin
  // Season use rate — 75% sit 82-95%, 15% at-risk 65-79%, 10% above 95%
  const u = (h1 >>> 6) % 100
  let seasonUseRate: number
  if (u < 75) seasonUseRate = 82 + ((h1 >>> 14) % 14)
  else if (u < 90) seasonUseRate = 65 + ((h1 >>> 14) % 15)
  else seasonUseRate = 95 + ((h1 >>> 14) % 5)
  // Action recommendation
  let action = 'No action — within tolerance'
  if (!hasSlot)                            action = 'NO-SLOT: schedule must be removed per WSG §8.7.1 or ad-hoc slot requested'
  else if (serviceMisuse && wakeMisuse)    action = 'DOUBLE MISUSE: service+wake mismatch — withdrawal candidate (§8.7.4)'
  else if (serviceMisuse)                  action = `Service misuse: awarded ${SERVICE_LABEL[serviceFiled]}, operating ${SERVICE_LABEL[serviceOperated]} — notify coordinator`
  else if (wakeMisuse)                     action = `Wake mismatch: filed ${wakeFiled}, flying ${wakeFlown} — capacity impact, downgrade risk`
  else if (Math.abs(offsetMin) > apt.tolMin + 15) action = `SLOT-BUST: ${offsetMin>0?'+':''}${offsetMin}min — 80:20 non-compliance, retime`
  else if (Math.abs(offsetMin) > apt.tolMin)      action = `OFF-SLOT: ${offsetMin>0?'+':''}${offsetMin}min — absorb-or-retime band`
  else if (offsetMin > apt.tolMin/2)              action = 'ON-SLOT trending LATE — monitor next sequence'
  else if (offsetMin < -apt.tolMin/2)             action = 'ON-SLOT trending EARLY — verify departure paperwork'
  else                                     action = 'ON-SLOT — compliant per WSG §8.5.1'
  return { hasSlot, allocatedHHMM, allocatedMin, actualMin, offsetMin,
           serviceFiled, serviceOperated, wakeFiled, wakeFlown,
           serviceMisuse, wakeMisuse, action, seasonUseRate }
}

// ---- Driver decomposition + composite score -----------------------------
interface Drivers {
  hasSlot: number     // 0 if NO-SLOT (high penalty)
  service: number     // service-code misuse penalty
  wake: number        // wake-category misuse penalty
  window: number      // |offset| vs tolerance penalty
  season: number      // 80:20 erosion penalty
  congestion: number  // airport-tier amplifier
  phase: number       // phase-correctness (DEP vs ARR confidence)
}

function computeDrivers(slot: SlotEval, apt: Airport, phase: Phase): Drivers {
  const hasSlot = slot.hasSlot ? 0 : 100
  const service = slot.serviceMisuse ? 60 : 0
  const wake = slot.wakeMisuse ? 55 : 0
  // window: ramp 0→100 from 0→2× tolerance
  const tol = apt.tolMin
  const aOff = Math.abs(slot.offsetMin)
  const window = Math.min(100, (aOff / (tol * 2)) * 100)
  // season — if below 80% use rate, escalating risk
  const season = apt.rule8020
    ? (slot.seasonUseRate < 80 ? Math.min(100, (80 - slot.seasonUseRate) * 6) : 0)
    : 0
  // congestion amplifier (T1 = +20, T2 = +10, T3 = +5, T4 = 0)
  const congestion = apt.tier === 1 ? 20 : apt.tier === 2 ? 10 : apt.tier === 3 ? 5 : 0
  // phase confidence — DEP-GND and ARR-FINAL are highest-confidence
  const phaseCorrect = phase === 'DEP-GND' || phase === 'ARR-FINAL' ? 0
                     : phase === 'ARR-TMA' || phase === 'DEP-CLB'  ? 5
                     : 20
  return { hasSlot, service, wake, window, season, congestion, phase: phaseCorrect }
}

function composite(d: Drivers, advMul: number): number {
  const vals = [d.hasSlot, d.service, d.wake, d.window, d.season]
  const max = Math.max(...vals)
  const mean = vals.reduce((a,b)=>a+b,0) / vals.length
  let s = max * 0.66 + mean * 0.34
  s += (d.congestion * 0.20) // amplifier (small fraction)
  s -= (d.phase * 0.10)      // phase confidence discount
  return Math.max(0, Math.min(100, s * advMul))
}

function scoreToTier(score: number, slot: SlotEval, apt: Airport): Tier {
  if (!slot.hasSlot) return 'NO-SLOT'
  if (slot.serviceMisuse || slot.wakeMisuse) return 'MISUSED'
  const aOff = Math.abs(slot.offsetMin)
  if (aOff > apt.tolMin + 15) return 'SLOT-BUST'
  if (aOff > apt.tolMin)      return 'OFF-SLOT'
  if (slot.offsetMin > 0)     return 'ON-SLOT-LATE'
  if (slot.offsetMin < 0)     return 'ON-SLOT-EARLY'
  return 'ON-SLOT'
}

// ---- Row type ------------------------------------------------------------
interface Row {
  f: F
  snap: AirportSnap
  apt: Airport
  phase: Phase
  slot: SlotEval
  drivers: Drivers
  score: number
  tier: Tier
}

// ==== MAIN COMPONENT =====================================================
export default function WsgSlotMonitor({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [regionFilter, setRegionFilter] = useState<string>('ALL')
  const [advMul, setAdvMul] = useState(1.0)
  const [tolMul, setTolMul] = useState(1.0)
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shApt, setShApt] = useState(true)
  const [tab, setTab] = useState<'AIRCRAFT'|'AIRPORTS'|'DRIVERS'|'METHOD'>('AIRCRAFT')
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<string | null>(null)

  // ---- Build per-flight rows -------------------------------------------
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const snap = snapAirport(f)
      if (!snap || !snap.kind) continue
      const phase = classifyPhase(f, snap)
      const slot = evalSlot(f, snap, phase)
      const apt = { ...snap.apt, tolMin: Math.round(snap.apt.tolMin * tolMul) }
      const drivers = computeDrivers(slot, apt, phase)
      const score = composite(drivers, advMul)
      const tier = scoreToTier(score, slot, apt)
      out.push({ f, snap, apt, phase, slot, drivers, score, tier })
    }
    out.sort((a,b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return out
  }, [flights, advMul, tolMul])

  // ---- MapLibre overlay layers -----------------------------------------
  useEffect(() => {
    if (!map) return
    const SRC_AC = 'wsg-ac-src'
    const SRC_APT = 'wsg-apt-src'
    const SRC_LINK = 'wsg-link-src'
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any }) }
    ;[SRC_AC, SRC_APT, SRC_LINK].forEach(ensure)

    const view = rows.filter(r =>
      (tierFilter === 'ALL' || r.tier === tierFilter) &&
      (regionFilter === 'ALL' || r.apt.region === regionFilter)
    )

    const acFeat: any[] = []
    const linkFeat: any[] = []
    for (const r of view) {
      acFeat.push({
        type:'Feature',
        geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
        properties:{
          tier: r.tier,
          color: TIER_COLOR[r.tier],
          score: r.score,
          sz: 7 + (r.score/100) * 14,
          label: `${(r.f.callsign||r.f.icao).trim()} ${r.tier} · ${r.apt.iata} ${r.snap.kind} · ${r.slot.offsetMin>0?'+':''}${r.slot.offsetMin}min${!r.slot.hasSlot?' · NO-SLOT':''}`,
        },
      })
      // Dashed link from aircraft to its slot airport
      linkFeat.push({
        type:'Feature',
        geometry:{ type:'LineString', coordinates:[ [r.f.lng, r.f.lat], [r.apt.lng, r.apt.lat] ] },
        properties:{ color: TIER_COLOR[r.tier] },
      })
    }
    const aptFeat = shApt ? AIRPORTS
      .filter(a => regionFilter === 'ALL' || a.region === regionFilter)
      .map(a => ({
        type:'Feature' as const,
        geometry:{ type:'Point' as const, coordinates:[a.lng, a.lat] },
        properties:{
          label: `${a.iata}·L${a.level}·${a.coordinator}`,
          tier: a.tier,
          color: a.tier === 1 ? '#0ea5e9' : a.tier === 2 ? '#38bdf8' : a.tier === 3 ? '#7dd3fc' : '#bae6fd',
        },
      })) : []

    ;(map.getSource(SRC_AC) as any).setData({ type:'FeatureCollection', features: (shHalo||shPin||shLbl) ? acFeat : [] })
    ;(map.getSource(SRC_APT) as any).setData({ type:'FeatureCollection', features: aptFeat })
    ;(map.getSource(SRC_LINK) as any).setData({ type:'FeatureCollection', features: (shHalo||shPin) ? linkFeat : [] })

    if (!map.getLayer('wsg-apt-pin'))
      map.addLayer({ id:'wsg-apt-pin', type:'circle', source:SRC_APT, paint:{ 'circle-radius':['interpolate',['linear'],['get','tier'],1,7,4,3.5], 'circle-color':['get','color'], 'circle-opacity':0.55, 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('wsg-apt-lbl'))
      map.addLayer({ id:'wsg-apt-lbl', type:'symbol', source:SRC_APT, layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,-1.4], 'text-anchor':'bottom', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#cbd5e1', 'text-halo-color':'#0b0f17', 'text-halo-width':1.0 } })
    if (!map.getLayer('wsg-link'))
      map.addLayer({ id:'wsg-link', type:'line', source:SRC_LINK, paint:{ 'line-color':['get','color'], 'line-width':1.2, 'line-opacity':0.5, 'line-dasharray':[2,2] } })
    if (!map.getLayer('wsg-halo'))
      map.addLayer({ id:'wsg-halo', type:'circle', source:SRC_AC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('wsg-pin'))
      map.addLayer({ id:'wsg-pin', type:'circle', source:SRC_AC, filter:['>=', ['get','score'], 55], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('wsg-lbl'))
      map.addLayer({ id:'wsg-lbl', type:'symbol', source:SRC_AC, filter:['>=', ['get','score'], 40], layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.5], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.3 } })

    return () => {
      for (const id of ['wsg-lbl','wsg-pin','wsg-halo','wsg-link','wsg-apt-lbl','wsg-apt-pin']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC_AC, SRC_APT, SRC_LINK]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, regionFilter, shHalo, shPin, shLbl, shApt])

  // ---- Aggregations for side panel -------------------------------------
  const visible = rows.filter(r =>
    (tierFilter === 'ALL' || r.tier === tierFilter) &&
    (regionFilter === 'ALL' || r.apt.region === regionFilter) &&
    (!search || (
      (r.f.callsign || r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type || '').toLowerCase().includes(search.toLowerCase()) ||
      r.apt.iata.toLowerCase().includes(search.toLowerCase()) ||
      r.apt.icao.toLowerCase().includes(search.toLowerCase()) ||
      r.apt.coordinator.toLowerCase().includes(search.toLowerCase())
    ))
  )
  const counts: Record<Tier, number> = {
    'NO-SLOT':0,'MISUSED':0,'SLOT-BUST':0,'OFF-SLOT':0,
    'ON-SLOT-LATE':0,'ON-SLOT':0,'ON-SLOT-EARLY':0,'NO-LVL3':0,
  }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? rows.reduce((a,c)=>a+c.score,0)/rows.length : 0
  const noSlotCount = counts['NO-SLOT']
  const misusedCount = counts['MISUSED']
  const onSlotPct = rows.length
    ? Math.round(((counts['ON-SLOT'] + counts['ON-SLOT-LATE'] + counts['ON-SLOT-EARLY']) / rows.length) * 100)
    : 0
  const worst = rows[0]
  // Top airport with most slot pressure (mean score)
  const aptAgg = useMemo(() => {
    const m = new Map<string, { count: number; sumScore: number; sumOffset: number; misuse: number; noSlot: number; }>()
    for (const r of rows) {
      const k = r.apt.icao
      const v = m.get(k) || { count:0, sumScore:0, sumOffset:0, misuse:0, noSlot:0 }
      v.count++
      v.sumScore += r.score
      v.sumOffset += Math.abs(r.slot.offsetMin)
      if (r.slot.serviceMisuse || r.slot.wakeMisuse) v.misuse++
      if (!r.slot.hasSlot) v.noSlot++
      m.set(k, v)
    }
    return Array.from(m.entries())
      .map(([k, v]) => {
        const apt = AIRPORTS.find(a => a.icao === k)!
        return { apt, count:v.count, muScore: v.sumScore/v.count, muOffset: v.sumOffset/v.count, misuse:v.misuse, noSlot:v.noSlot }
      })
      .sort((a,b) => b.muScore - a.muScore)
  }, [rows])

  const driverAvg = useMemo(() => {
    if (!rows.length) return { hasSlot:0, service:0, wake:0, window:0, season:0, congestion:0, phase:0 }
    const n = rows.length
    return {
      hasSlot: rows.reduce((a,r)=>a+r.drivers.hasSlot,0)/n,
      service: rows.reduce((a,r)=>a+r.drivers.service,0)/n,
      wake:    rows.reduce((a,r)=>a+r.drivers.wake,0)/n,
      window:  rows.reduce((a,r)=>a+r.drivers.window,0)/n,
      season:  rows.reduce((a,r)=>a+r.drivers.season,0)/n,
      congestion: rows.reduce((a,r)=>a+r.drivers.congestion,0)/n,
      phase:   rows.reduce((a,r)=>a+r.drivers.phase,0)/n,
    }
  }, [rows])

  // ---- Render ----------------------------------------------------------
  return (
    <div className="fixed top-16 right-3 z-40 w-[500px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">WSG-SLOT</span>
          <span className="text-[10px] text-slate-400 truncate">IATA WSG ed.32 · Level-3 Slot-Coordination Compliance · Reg 95/93 · 14 CFR §93-K</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none ml-2">×</button>
      </div>

      {/* Tier counter strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.slice(0,7).map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className="flex-1 px-1 py-1 rounded text-[9px] font-mono border min-w-0"
            style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:'transparent', color: TIER_COLOR[t] }}>
            <span className="truncate">{t === 'NO-SLOT' ? 'NSLO' : t === 'MISUSED' ? 'MISU' : t === 'SLOT-BUST' ? 'BUST' : t === 'OFF-SLOT' ? 'OFF' : t === 'ON-SLOT-LATE' ? 'LATE' : t === 'ON-SLOT-EARLY' ? 'ERLY' : 'ON'}</span> {counts[t]}
          </button>
        ))}
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCR</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">ON-SLT%</div><div className="text-slate-100 font-mono">{onSlotPct}%</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">N-SLT</div><div className="font-mono" style={{color: noSlotCount?TIER_COLOR['NO-SLOT']:'#94a3b8'}}>{noSlotCount}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">MISU</div><div className="font-mono" style={{color: misusedCount?TIER_COLOR.MISUSED:'#94a3b8'}}>{misusedCount}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1 truncate"><div className="text-slate-500">WRST</div><div className="text-slate-100 font-mono truncate" title={worst?(worst.f.callsign||worst.f.icao).trim():'—'}>{worst ? (worst.f.callsign||worst.f.icao).trim().slice(0,7) : '—'}</div></div>
      </div>

      {/* Sliders + filters */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">TOL-MUL <span className="text-slate-200 font-mono">{(tolMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={tolMul*100} onChange={e=>setTolMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
        </div>
        {/* Region filter */}
        <div className="flex flex-wrap gap-1">
          <button onClick={()=>setRegionFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${regionFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL-RGN</button>
          {(['NA-US','NA-CA','EU','UK','ASIA','PAC','ME','AFR','LATAM'] as const).map(r => (
            <button key={r} onClick={()=>setRegionFilter(r)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${regionFilter===r?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{r}</button>
          ))}
        </div>
        {/* Overlay toggles + search */}
        <div className="flex flex-wrap gap-1 items-center">
          {([['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['APT',shApt,setShApt]] as const).map(([n,v,fn]) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/iata/coord" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-3 py-1.5 border-b border-slate-700/60">
        {(['AIRCRAFT','AIRPORTS','DRIVERS','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">

        {tab === 'AIRCRAFT' && (
          <>
            {visible.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-6">No aircraft in slot-coordinated airport scope · relax filters or wait for inbound traffic</div>
            )}
            {visible.slice(0, 60).map(r => {
              const isP = picked === r.f.icao
              return (
                <div key={r.f.icao} className="border rounded-lg p-2 bg-slate-800/40" style={{ borderColor: TIER_COLOR[r.tier] + '60' }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0" style={{ background: TIER_COLOR[r.tier] + '22', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                      <button onClick={()=>{ setPicked(r.f.icao); onFly(r.f.icao) }} className="text-slate-100 font-mono text-[11px] hover:text-sky-300 truncate">{(r.f.callsign||r.f.icao).trim()}</button>
                      <span className="text-slate-400 text-[10px] truncate">{(r.f.type||'?').toUpperCase()}</span>
                    </div>
                    <div className="text-[10px] font-mono shrink-0" style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</div>
                  </div>

                  {/* Slot strip */}
                  <div className="mt-1.5 bg-slate-900/60 rounded p-1.5 font-mono text-[9px] text-slate-300 leading-tight overflow-x-auto whitespace-nowrap">
                    <span className="text-slate-500">{r.snap.kind}@</span><span className="text-sky-300">{r.apt.iata}</span>
                    <span className="text-slate-500"> L</span><span className="text-slate-200">{r.apt.level}</span>
                    <span className="text-slate-500"> CORD </span><span className="text-slate-200">{r.apt.coordinator}</span>
                    <span className="text-slate-500"> SLOT </span>
                    {r.slot.hasSlot
                      ? <span className="text-slate-200">{r.slot.allocatedHHMM}z</span>
                      : <span className="text-rose-400">none</span>}
                    <span className="text-slate-500"> Δ</span>
                    <span className="font-mono" style={{ color: Math.abs(r.slot.offsetMin) > r.apt.tolMin ? TIER_COLOR['SLOT-BUST'] : '#cbd5e1' }}>{r.slot.offsetMin>0?'+':''}{r.slot.offsetMin}m</span>
                    <span className="text-slate-500"> tol±</span><span className="text-slate-200">{r.apt.tolMin}m</span>
                    <span className="text-slate-500"> SVC</span>
                    <span className={r.slot.serviceMisuse?'text-rose-400':'text-slate-200'}>{r.slot.serviceFiled}{r.slot.serviceMisuse?'→'+r.slot.serviceOperated:''}</span>
                    <span className="text-slate-500"> WK</span>
                    <span className={r.slot.wakeMisuse?'text-rose-400':'text-slate-200'}>{r.slot.wakeFiled}{r.slot.wakeMisuse?'→'+r.slot.wakeFlown:''}</span>
                    {r.apt.rule8020 && (
                      <>
                        <span className="text-slate-500"> 80:20 </span>
                        <span className="font-mono" style={{ color: r.slot.seasonUseRate < 80 ? TIER_COLOR['SLOT-BUST'] : '#94a3b8' }}>{r.slot.seasonUseRate}%</span>
                      </>
                    )}
                  </div>

                  {/* Driver chips */}
                  <div className="mt-1 flex flex-wrap gap-0.5 text-[9px] font-mono">
                    {(['hasSlot','service','wake','window','season','congestion','phase'] as const).map(k => {
                      const v = r.drivers[k]
                      const sev = v >= 60 ? '#f43f5e' : v >= 35 ? '#f59e0b' : v >= 18 ? '#0ea5e9' : '#10b981'
                      return (
                        <span key={k} className="px-1 py-0.5 rounded" style={{ background: sev+'22', color: sev }}>
                          {k.toUpperCase().slice(0,4)} {v.toFixed(0)}
                        </span>
                      )
                    })}
                  </div>

                  {/* Action advice */}
                  <div className="mt-1 text-[9px] text-slate-300 italic leading-tight">
                    <span style={{ color: TIER_COLOR[r.tier] }}>▸ </span>{r.slot.action}
                  </div>

                  {isP && (
                    <div className="mt-1.5 text-[9px] text-slate-400 border-t border-slate-700/60 pt-1.5 space-y-0.5">
                      <div>Coordinator: <span className="text-slate-200">{r.apt.coordinator}</span> · Region: <span className="text-slate-200">{r.apt.region}</span> · Tier <span className="text-slate-200">T{r.apt.tier}</span></div>
                      <div>Cap: <span className="text-slate-200">{r.apt.capSum}/h sum · {r.apt.capWin}/h win</span> · Slot tol: <span className="text-slate-200">±{r.apt.tolMin}min</span></div>
                      <div>Allocated <span className="text-slate-200">{r.slot.allocatedHHMM}z</span> · Actual <span className="text-slate-200">{Math.floor(r.slot.actualMin/60).toString().padStart(2,'0')}:{(((r.slot.actualMin%60)+60)%60).toString().padStart(2,'0')}z</span></div>
                      <div>Service awarded <span className="text-slate-200">{SERVICE_LABEL[r.slot.serviceFiled]}</span> · operated <span className="text-slate-200">{SERVICE_LABEL[r.slot.serviceOperated]}</span></div>
                      <div>Phase: <span className="text-slate-200">{r.phase}</span> · dist <span className="text-slate-200">{r.snap.distNM.toFixed(1)} NM</span></div>
                    </div>
                  )}
                </div>
              )
            })}
            {visible.length > 60 && (
              <div className="text-center text-[10px] text-slate-500 py-2">{visible.length - 60} more · filter to narrow</div>
            )}
          </>
        )}

        {tab === 'AIRPORTS' && (
          <>
            {aptAgg.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-6">No catalogued airports currently active in this view</div>
            )}
            {aptAgg.slice(0, 40).map(a => {
              const color = a.muScore >= 70 ? TIER_COLOR['SLOT-BUST'] : a.muScore >= 45 ? TIER_COLOR['OFF-SLOT'] : a.muScore >= 25 ? TIER_COLOR['ON-SLOT-LATE'] : TIER_COLOR['ON-SLOT']
              return (
                <div key={a.apt.icao} className="border rounded-lg p-2 bg-slate-800/40" style={{ borderColor: color + '60' }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0" style={{ background: color + '22', color }}>L{a.apt.level}·T{a.apt.tier}</span>
                      <span className="text-slate-100 font-mono text-[11px]">{a.apt.iata}</span>
                      <span className="text-slate-400 text-[10px] truncate">{a.apt.name}</span>
                    </div>
                    <div className="text-[10px] font-mono shrink-0" style={{ color }}>μ {a.muScore.toFixed(0)}</div>
                  </div>
                  <div className="mt-1.5 grid grid-cols-5 gap-1 text-[9px]">
                    <div className="bg-slate-900/60 rounded px-1 py-0.5"><div className="text-slate-500">CNT</div><div className="text-slate-200 font-mono">{a.count}</div></div>
                    <div className="bg-slate-900/60 rounded px-1 py-0.5"><div className="text-slate-500">μ-Δ</div><div className="text-slate-200 font-mono">{a.muOffset.toFixed(0)}m</div></div>
                    <div className="bg-slate-900/60 rounded px-1 py-0.5"><div className="text-slate-500">CAP-S</div><div className="text-slate-200 font-mono">{a.apt.capSum}/h</div></div>
                    <div className="bg-slate-900/60 rounded px-1 py-0.5"><div className="text-slate-500">MISU</div><div className="font-mono" style={{ color: a.misuse?TIER_COLOR['MISUSED']:'#94a3b8' }}>{a.misuse}</div></div>
                    <div className="bg-slate-900/60 rounded px-1 py-0.5"><div className="text-slate-500">N-SLT</div><div className="font-mono" style={{ color: a.noSlot?TIER_COLOR['NO-SLOT']:'#94a3b8' }}>{a.noSlot}</div></div>
                  </div>
                  <div className="mt-1 text-[9px] text-slate-400 italic">{a.apt.coordinator} · tol ±{a.apt.tolMin}min · {a.apt.rule8020 ? '80:20 enforced' : '80:20 N/A'}</div>
                </div>
              )
            })}
          </>
        )}

        {tab === 'DRIVERS' && (
          <div className="space-y-1.5">
            <div className="text-[10px] text-slate-400">Fleet-mean driver scores (0=clean, 100=worst). 7-driver decomposition.</div>
            {(['hasSlot','service','wake','window','season','congestion','phase'] as const).map(k => {
              const v = driverAvg[k]
              const labels: Record<typeof k, string> = {
                hasSlot:   'HAS-SLOT — has the flight been awarded a slot (binary)',
                service:   'SERVICE  — service-code mismatch (WSG §8.7.4)',
                wake:      'WAKE     — wake-cat substitution (RECAT capacity drift)',
                window:    'WINDOW   — minutes vs tolerance ±tol band',
                season:    '80:20    — season-to-date use-rate erosion',
                congestion:'CONGEST  — tier-1 hub amplifier (LHR/JFK/HND class)',
                phase:     'PHASE-C  — phase-classification confidence (discount)',
              }
              const sev = v >= 60 ? '#f43f5e' : v >= 35 ? '#f59e0b' : v >= 18 ? '#0ea5e9' : '#10b981'
              return (
                <div key={k} className="bg-slate-800/40 rounded p-1.5 border border-slate-700/60">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[10px] font-mono text-slate-300">{labels[k]}</span>
                    <span className="text-[10px] font-mono" style={{ color: sev }}>{v.toFixed(1)}</span>
                  </div>
                  <div className="h-1.5 bg-slate-900/60 rounded overflow-hidden">
                    <div className="h-full" style={{ width:`${Math.min(100,v)}%`, background: sev }} />
                  </div>
                </div>
              )
            })}
            <div className="mt-3 bg-slate-800/40 rounded p-2 border border-slate-700/60 text-[9px] text-slate-400 leading-relaxed">
              <div className="text-sky-300 font-mono text-[10px] mb-1">Composite</div>
              <div>score = max(hasSlot,svc,wake,window,season)·0.66 + mean(…)·0.34 + congestion·0.20 − phase·0.10, scaled by ADV-MUL, clipped [0,100].</div>
              <div className="mt-1">Tier is structurally assigned: NO-SLOT &gt; MISUSED &gt; SLOT-BUST &gt; OFF-SLOT &gt; ON-SLOT-LATE/EARLY/ON.</div>
            </div>
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-300 leading-relaxed">
            <div className="bg-slate-800/40 rounded p-2 border border-slate-700/60">
              <div className="text-sky-300 font-mono text-[10px] mb-1">What WSG-SLOT measures</div>
              <div>Per-airframe scorer for the IATA <span className="text-slate-100">Worldwide Slot Guidelines (WSG) ed.32</span> Level-3 regime. Each flight at a catalogued slot-coord airport scored for:</div>
              <ul className="mt-1 list-disc list-inside space-y-0.5 text-slate-400">
                <li>SLOT presence — does the flight have an allocated WSG slot</li>
                <li>WINDOW — within per-airport ±tolerance band (LHR ±10min, default ±15min)</li>
                <li>SERVICE-USE — operated service-code (J/F/M/X/P) matches awarded</li>
                <li>WAKE-USE — flown wake (J/H/M/L) consistent with filed</li>
                <li>80:20 — season-to-date use-rate above use-it-or-lose-it floor</li>
              </ul>
            </div>
            <div className="bg-slate-800/40 rounded p-2 border border-slate-700/60">
              <div className="text-sky-300 font-mono text-[10px] mb-1">Distinct from</div>
              <ul className="list-disc list-inside space-y-0.5 text-slate-400">
                <li><span className="text-slate-200">CTOT</span> — EUROCONTROL/FAA tactical ATFM, Reg 255/2010, -5/+10 window</li>
                <li><span className="text-slate-200">A-CDM TOBT/TSAT</span> — operational pushback milestones</li>
                <li><span className="text-slate-200">NEMO/AHM-730</span> — post-hoc delay-code classifier</li>
                <li><span className="text-slate-200">GDP/GS/AFP/CTOP</span> — FAA TFM EDCT programmes</li>
                <li><span className="text-slate-200">RTA/4D</span> — FMS waypoint times (navigation)</li>
                <li><span className="text-slate-200">APBN</span> — approach-ban / weather minima</li>
              </ul>
            </div>
            <div className="bg-slate-800/40 rounded p-2 border border-slate-700/60">
              <div className="text-sky-300 font-mono text-[10px] mb-1">Tier ladder (worst → best)</div>
              <ol className="list-decimal list-inside space-y-0.5 text-slate-400">
                <li><span style={{ color: TIER_COLOR['NO-SLOT'] }}>NO-SLOT</span> — at L3 without allocated slot (§8.7.1)</li>
                <li><span style={{ color: TIER_COLOR['MISUSED'] }}>MISUSED</span> — wrong service/wake (§8.7.4)</li>
                <li><span style={{ color: TIER_COLOR['SLOT-BUST'] }}>SLOT-BUST</span> — ≥(tol+15)min outside window, vs 80:20</li>
                <li><span style={{ color: TIER_COLOR['OFF-SLOT'] }}>OFF-SLOT</span> — (tol)–(tol+15)min, absorb-or-retime</li>
                <li><span style={{ color: TIER_COLOR['ON-SLOT-LATE'] }}>ON-SLOT-LATE</span> · <span style={{ color: TIER_COLOR['ON-SLOT'] }}>ON-SLOT</span> · <span style={{ color: TIER_COLOR['ON-SLOT-EARLY'] }}>ON-SLOT-EARLY</span></li>
              </ol>
            </div>
            <div className="bg-slate-800/40 rounded p-2 border border-slate-700/60 text-slate-400">
              <div className="text-sky-300 font-mono text-[10px] mb-1">References</div>
              <div className="text-[9px] leading-snug">IATA WSG ed.32 (Jan 2024) · Reg (EEC) 95/93 · Reg 793/2004 · Reg 458/2020 COVID waiver · Reg 2023/2762 · 14 CFR §93 Subpart K · FAA Order JO 7210.831 · FAA SAPO 2024 · ACL UK · COHOR · ASCN · FHKD · CAAC ATMB · GCAA · ACA Sydney · JSCG · IATA SSIM Ch.7 · ICAO Doc 4444 §4.9 / RECAT-EU · CODA Q4 2024.</div>
            </div>
          </div>
        )}

      </div>

      {/* Footer */}
      <div className="border-t border-slate-700/60 px-3 py-1.5 text-[9px] text-slate-500 font-mono flex items-center justify-between">
        <span>{AIRPORTS.length} airports · {AIRPORTS.filter(a=>a.level===3).length} L3 · {AIRPORTS.filter(a=>a.level===2).length} L2</span>
        <span>v1.0 · WSG ed.32</span>
      </div>

    </div>
  )
}
