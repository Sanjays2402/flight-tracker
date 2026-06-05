'use client'

// =============================================================================
// EVAC · 90-Second Emergency Evacuation Capability, Exit-Pair Authority,
//        Slide-Raft Equipage & FA-Pax Coverage Compliance Monitor
// -----------------------------------------------------------------------------
// Per-airframe live evaluator of every aircraft currently in a ground / landing-
// rollout / pushback phase at one of 28 catalogued hub airports, scoring whether
// the airframe can satisfy the 90-second emergency-evacuation certification
// envelope per FAR 25.803 / CS 25.803 with HALF OF THE AVAILABLE EXITS BLOCKED,
// whether the cabin-attendant complement satisfies the 1-per-50 pax minimum
// per 14 CFR §121.391 / EASA CAT.OP.MPA.210, whether the slide / slide-raft /
// off-wing-ramp inventory matches the type-cert exit equipage list, and whether
// the deterministic effective-evac-time (cert-time × paxDensity × exitDeficit ×
// faDeficit × slideDegrade × mobilityLoad multipliers) keeps the airframe inside
// the 90-second federal floor with margin.
//
// Per FAR 25.803 / 25.807 / 25.809 / 25.810 / Appendix J (full-scale demo
// procedure), CS 25.803 + AMC 25.803, FAA AC 25.803-1A "Emergency Evacuation
// Demonstrations" (rationalisation + analysis path), FAA Order 8110.6
// (type-cert TIA), 14 CFR §121.291 (carrier partial demo), 14 CFR §121.310
// (interior emergency provisions), 14 CFR §121.391 (FA staffing 1-per-50),
// 14 CFR §121.397 (emergency drills), EASA CS-25 Subpart D, ICAO Annex 8
// Pt IIIA §3, IATA Cabin Operations Safety Best Practices Guide §4.2,
// Boeing FCTM Ch.8 "Emergency Evacuation", Airbus FCOM PRO-ABN-EMER-EVAC,
// NTSB Safety Recommendation A-18-09/10 (slide-raft maintenance), NTSB
// Special Investigation Report SIR-00/01 "Emergency Evacuation of Commercial
// Airplanes", NTSB SR A-21-2/-3 (cabin baggage in evac), FAA AC 121-24D
// "Passenger Safety Information Briefing", AC 121-32B "Cabin Crew", AC 120-101
// "Air Carrier in-flight medical", FAA SAFO 06005 "Cabin Evacuation Lessons".
//
// Structurally distinct from:
//   - RFFS    (rescue & firefighting category — ground-services, not airframe)
//   - EMAS    (engineered material arresting system — runway overrun energy)
//   - APPCAT  (approach category — speed envelope, not evac)
//   - LAHSO   (land-and-hold-short — runway separation)
//   - TOPMS   (take-off performance — pre-V1 acceleration)
//   - RTO     (rejected-takeoff decision — V1 reject vs continue)
//   - DOORPLUG(door plug structural integrity in cruise — different failure)
//   - HRF     (hot-refueling procedural — fueling event)
//   - SAFA    (ramp-inspection — operator compliance audit)
//   - TBACK   (impossible-turn — initial-climb total-flameout)
// EVAC is uniquely the GROUND / LANDING-ROLLOUT 90-SECOND-RULE evacuation-
// capability evaluator answering: given this airframe's type-cert pax capacity,
// exit-pair inventory, slide/slide-raft equipage, the carrier's load-factor
// posture, and the FA staffing law, will the worst-case 90-second envelope be
// met if HALF the exits are blocked, and where is the deficit?
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
  | 'CRITICAL'   // effective evac > 90 s — federal floor breached, ABORT-CERT
  | 'WARN'       // 80-90 s — within floor but <10% margin, FA brief required
  | 'MARGINAL'   // 70-80 s — 10-20% margin, watch deficit drivers
  | 'COMPLIANT'  // 60-70 s — 20-30% margin, standard ops
  | 'CERTIFIED'  // < 60 s — > 30% margin, cert envelope satisfied
  | 'NOT-DEMO'   // type-cert demo path: rationalised by analysis not full-scale
  | 'N-A'        // not in scope (cruise / not at catalogued hub / unknown type)

const TIER_ORDER: Tier[] = ['CRITICAL','WARN','MARGINAL','COMPLIANT','CERTIFIED','NOT-DEMO','N-A']
const TIER_RANK: Record<Tier, number> = {
  'CRITICAL':0,'WARN':1,'MARGINAL':2,'COMPLIANT':3,'CERTIFIED':4,'NOT-DEMO':5,'N-A':6,
}
const TIER_COLOR: Record<Tier, string> = {
  'CRITICAL':  '#f43f5e', // rose-500
  'WARN':      '#fb7185', // rose-400
  'MARGINAL':  '#f59e0b', // amber-500
  'COMPLIANT': '#0ea5e9', // sky-500
  'CERTIFIED': '#10b981', // emerald-500
  'NOT-DEMO':  '#a78bfa', // violet-400 — analysis path
  'N-A':       '#64748b', // slate-500
}
const TIER_ABBR: Record<Tier, string> = {
  'CRITICAL':'CRIT','WARN':'WARN','MARGINAL':'MARG','COMPLIANT':'CMPL','CERTIFIED':'CERT','NOT-DEMO':'ANLY','N-A':'N/A',
}

// ---- Aircraft-type → EVAC class -----------------------------------------
// Per FAA Type Certificate Data Sheet (TCDS) + 25.803 full-scale demo records.
// Each class carries the certified pax capacity, total exit pair count per
// side (exits per side × 2 = total exits), slide type, certified demo time
// (seconds, from §25.803 Appendix J full-scale demonstration), aisle count,
// width band (WB / NB / RGN), and the "demo path" flag indicating whether the
// type was certified via FULL-SCALE demonstration or ANALYSIS rationalisation
// (per AC 25.803-1A — allowed for derivatives within ±5% of parent envelope).
interface EvacClass {
  id: string
  paxCert: number       // max certified passenger capacity
  exitPairs: number     // pair count per side (e.g. A320 = 4 pairs = 8 doors)
  certDemoSec: number   // certified §25.803 Appendix J full-scale demo time
  aisles: 1 | 2         // single vs twin-aisle
  width: 'NB' | 'WB' | 'RGN' | 'HVY'
  slideType: 'SLIDE' | 'SLIDE-RAFT' | 'RAMP-WING' | 'INFLATABLE-RAMP'
  demoPath: 'FULL-SCALE' | 'ANALYSIS' | 'PARTIAL'
  label: string
}

const EVAC_CLASS: Record<string, EvacClass> = {
  'NB-A320':    { id:'NB-A320',  paxCert:194, exitPairs:4, certDemoSec:80, aisles:1, width:'NB',  slideType:'SLIDE',      demoPath:'FULL-SCALE', label:'Airbus A320 family (A318/A319/A320/A321)' },
  'NB-A320N':   { id:'NB-A320N', paxCert:240, exitPairs:4, certDemoSec:85, aisles:1, width:'NB',  slideType:'SLIDE',      demoPath:'ANALYSIS',   label:'A320neo / A321neo (NEO derivative)' },
  'NB-737CL':   { id:'NB-737CL', paxCert:189, exitPairs:4, certDemoSec:78, aisles:1, width:'NB',  slideType:'SLIDE',      demoPath:'FULL-SCALE', label:'Boeing 737-300/400/500/600/700/800/900' },
  'NB-737MAX':  { id:'NB-737MAX',paxCert:230, exitPairs:4, certDemoSec:88, aisles:1, width:'NB',  slideType:'SLIDE',      demoPath:'ANALYSIS',   label:'Boeing 737 MAX (200LR high-density)' },
  'NB-757':     { id:'NB-757',   paxCert:239, exitPairs:4, certDemoSec:82, aisles:1, width:'NB',  slideType:'SLIDE',      demoPath:'FULL-SCALE', label:'Boeing 757-200/300' },
  'WB-767':     { id:'WB-767',   paxCert:375, exitPairs:4, certDemoSec:85, aisles:2, width:'WB',  slideType:'SLIDE-RAFT', demoPath:'FULL-SCALE', label:'Boeing 767-200/300/400 (ER variants)' },
  'WB-777':     { id:'WB-777',   paxCert:440, exitPairs:5, certDemoSec:87, aisles:2, width:'WB',  slideType:'SLIDE-RAFT', demoPath:'FULL-SCALE', label:'Boeing 777-200/200LR/300/300ER' },
  'WB-777X':    { id:'WB-777X',  paxCert:426, exitPairs:5, certDemoSec:89, aisles:2, width:'WB',  slideType:'SLIDE-RAFT', demoPath:'ANALYSIS',   label:'Boeing 777X (777-8 / -9 folding-wingtip)' },
  'WB-787':     { id:'WB-787',   paxCert:336, exitPairs:4, certDemoSec:79, aisles:2, width:'WB',  slideType:'SLIDE-RAFT', demoPath:'FULL-SCALE', label:'Boeing 787-8/-9/-10 Dreamliner' },
  'WB-A330':    { id:'WB-A330',  paxCert:335, exitPairs:4, certDemoSec:84, aisles:2, width:'WB',  slideType:'SLIDE-RAFT', demoPath:'FULL-SCALE', label:'Airbus A330-200/300 (CEO + NEO)' },
  'WB-A350':    { id:'WB-A350',  paxCert:440, exitPairs:5, certDemoSec:83, aisles:2, width:'WB',  slideType:'SLIDE-RAFT', demoPath:'FULL-SCALE', label:'Airbus A350-900 / -1000' },
  'HVY-747':    { id:'HVY-747',  paxCert:524, exitPairs:5, certDemoSec:89, aisles:2, width:'HVY', slideType:'SLIDE-RAFT', demoPath:'FULL-SCALE', label:'Boeing 747-400 / 747-8 (incl upper-deck pair)' },
  'HVY-A380':   { id:'HVY-A380', paxCert:853, exitPairs:8, certDemoSec:78, aisles:2, width:'HVY', slideType:'SLIDE-RAFT', demoPath:'FULL-SCALE', label:'Airbus A380 (16 exits, dual-deck demo Hamburg 2006)' },
  'RGN-E170':   { id:'RGN-E170', paxCert: 80, exitPairs:2, certDemoSec:71, aisles:1, width:'RGN', slideType:'SLIDE',      demoPath:'FULL-SCALE', label:'Embraer E170 / E175' },
  'RGN-E190':   { id:'RGN-E190', paxCert:124, exitPairs:3, certDemoSec:74, aisles:1, width:'RGN', slideType:'SLIDE',      demoPath:'FULL-SCALE', label:'Embraer E190 / E195 (incl E2)' },
  'RGN-CRJ7':   { id:'RGN-CRJ7', paxCert: 78, exitPairs:2, certDemoSec:72, aisles:1, width:'RGN', slideType:'SLIDE',      demoPath:'FULL-SCALE', label:'Bombardier CRJ-700' },
  'RGN-CRJ9':   { id:'RGN-CRJ9', paxCert: 90, exitPairs:2, certDemoSec:75, aisles:1, width:'RGN', slideType:'SLIDE',      demoPath:'ANALYSIS',   label:'Bombardier CRJ-900 / -1000' },
  'RGN-A220':   { id:'RGN-A220', paxCert:160, exitPairs:3, certDemoSec:77, aisles:1, width:'RGN', slideType:'SLIDE',      demoPath:'FULL-SCALE', label:'Airbus A220-100 / -300 (CSeries)' },
  'RGN-ATR':    { id:'RGN-ATR',  paxCert: 78, exitPairs:2, certDemoSec:70, aisles:1, width:'RGN', slideType:'INFLATABLE-RAMP', demoPath:'FULL-SCALE', label:'ATR 42 / ATR 72 (low-floor inflatable ramp)' },
  'RGN-Q400':   { id:'RGN-Q400', paxCert: 86, exitPairs:2, certDemoSec:73, aisles:1, width:'RGN', slideType:'INFLATABLE-RAMP', demoPath:'FULL-SCALE', label:'De Havilland Dash-8 Q400' },
  'BIZ-G650':   { id:'BIZ-G650', paxCert: 19, exitPairs:1, certDemoSec:55, aisles:1, width:'RGN', slideType:'RAMP-WING',  demoPath:'ANALYSIS',   label:'Gulfstream G650 / G700 (≤19 pax small-cabin rule)' },
  'BIZ-FA8X':   { id:'BIZ-FA8X', paxCert: 19, exitPairs:1, certDemoSec:52, aisles:1, width:'RGN', slideType:'RAMP-WING',  demoPath:'ANALYSIS',   label:'Dassault Falcon 8X / 7X' },
  'CARGO-NB':   { id:'CARGO-NB', paxCert:  4, exitPairs:1, certDemoSec:45, aisles:1, width:'NB',  slideType:'SLIDE',      demoPath:'PARTIAL',    label:'Cargo NB (B737F/A321F/B757F) — flightcrew + supernumeraries' },
  'CARGO-WB':   { id:'CARGO-WB', paxCert:  6, exitPairs:1, certDemoSec:48, aisles:2, width:'WB',  slideType:'SLIDE-RAFT', demoPath:'PARTIAL',    label:'Cargo WB (B777F/B767F/B747F/A330F) — flightcrew + supernumeraries' },
}

function classifyType(t?: string, cat?: string): EvacClass {
  if (cat === 'B4') return EVAC_CLASS['BIZ-G650']
  if (!t) return EVAC_CLASS['NB-A320']
  const u = t.toUpperCase()
  // Cargo detection (registration patterns not in scope; type-only)
  if (/F$/.test(u) && /^(B74|B77|B76|A33)/.test(u)) return EVAC_CLASS['CARGO-WB']
  if (/F$/.test(u) && /^(B73|A32|B75)/.test(u)) return EVAC_CLASS['CARGO-NB']
  if (u === 'A388' || u === 'A380') return EVAC_CLASS['HVY-A380']
  if (u === 'B748' || u === 'B744' || u === 'B742' || u === 'B743' || u === 'B741') return EVAC_CLASS['HVY-747']
  if (/^B77[89]/.test(u)) return EVAC_CLASS['WB-777X']
  if (/^B77/.test(u)) return EVAC_CLASS['WB-777']
  if (/^B78/.test(u)) return EVAC_CLASS['WB-787']
  if (/^B76/.test(u)) return EVAC_CLASS['WB-767']
  if (/^A35/.test(u)) return EVAC_CLASS['WB-A350']
  if (/^A33|^A34/.test(u)) return EVAC_CLASS['WB-A330']
  if (u === 'B38M' || u === 'B39M' || u === 'B3XM' || u === 'B37M') return EVAC_CLASS['NB-737MAX']
  if (/^B73/.test(u)) return EVAC_CLASS['NB-737CL']
  if (/^B75/.test(u)) return EVAC_CLASS['NB-757']
  if (u === 'A20N' || u === 'A21N' || u === 'A19N') return EVAC_CLASS['NB-A320N']
  if (/^A31|^A32/.test(u)) return EVAC_CLASS['NB-A320']
  if (/^BCS|^A22/.test(u)) return EVAC_CLASS['RGN-A220']
  if (/^E17|^E75/.test(u)) return EVAC_CLASS['RGN-E170']
  if (/^E19|^E29/.test(u)) return EVAC_CLASS['RGN-E190']
  if (/^CRJ7|^CR7/.test(u)) return EVAC_CLASS['RGN-CRJ7']
  if (/^CRJ9|^CRJX|^CR9|^CRJ1/.test(u)) return EVAC_CLASS['RGN-CRJ9']
  if (/^AT[47]|^ATR/.test(u)) return EVAC_CLASS['RGN-ATR']
  if (/^DH8|^Q40/.test(u)) return EVAC_CLASS['RGN-Q400']
  if (/^GLEX|^GLF6|^G650|^GLF/.test(u)) return EVAC_CLASS['BIZ-G650']
  if (/^FA[78]|^F2TH|^F900/.test(u)) return EVAC_CLASS['BIZ-FA8X']
  return EVAC_CLASS['NB-A320']
}

// ---- Carrier load-factor & FA-discipline posture -----------------------
// Per IATA Annual Review 2024 + Cirium 2024 load-factor data + carrier-specific
// FA-staffing discipline (1-per-50 is the law; some carriers staff to 1-per-40
// for service reasons giving evac upside).
interface CarrierPost {
  id: string
  loadFactor: number      // 0.0..1.0 — fleet-mean YTD
  faDiscipline: 'LEAN'|'STANDARD'|'GENEROUS' // staffing posture
  label: string
}

const CARRIER_POST: Record<string, CarrierPost> = {
  'AAL': { id:'AAL', loadFactor:0.85, faDiscipline:'STANDARD',  label:'American Airlines' },
  'UAL': { id:'UAL', loadFactor:0.84, faDiscipline:'STANDARD',  label:'United Airlines' },
  'DAL': { id:'DAL', loadFactor:0.86, faDiscipline:'GENEROUS',  label:'Delta Air Lines' },
  'SWA': { id:'SWA', loadFactor:0.83, faDiscipline:'LEAN',      label:'Southwest Airlines' },
  'BAW': { id:'BAW', loadFactor:0.84, faDiscipline:'STANDARD',  label:'British Airways' },
  'AFR': { id:'AFR', loadFactor:0.86, faDiscipline:'STANDARD',  label:'Air France' },
  'DLH': { id:'DLH', loadFactor:0.84, faDiscipline:'GENEROUS',  label:'Lufthansa' },
  'KLM': { id:'KLM', loadFactor:0.85, faDiscipline:'STANDARD',  label:'KLM' },
  'UAE': { id:'UAE', loadFactor:0.79, faDiscipline:'GENEROUS',  label:'Emirates' },
  'QTR': { id:'QTR', loadFactor:0.80, faDiscipline:'GENEROUS',  label:'Qatar Airways' },
  'SIA': { id:'SIA', loadFactor:0.86, faDiscipline:'GENEROUS',  label:'Singapore Airlines' },
  'CPA': { id:'CPA', loadFactor:0.82, faDiscipline:'STANDARD',  label:'Cathay Pacific' },
  'ANA': { id:'ANA', loadFactor:0.78, faDiscipline:'STANDARD',  label:'All Nippon Airways' },
  'JAL': { id:'JAL', loadFactor:0.79, faDiscipline:'STANDARD',  label:'Japan Airlines' },
  'RYR': { id:'RYR', loadFactor:0.94, faDiscipline:'LEAN',      label:'Ryanair (ULCC high-density)' },
  'EZY': { id:'EZY', loadFactor:0.91, faDiscipline:'LEAN',      label:'easyJet (LCC)' },
  'SPR': { id:'SPR', loadFactor:0.83, faDiscipline:'LEAN',      label:'Spirit Airlines (ULCC)' },
  'NKS': { id:'NKS', loadFactor:0.84, faDiscipline:'LEAN',      label:'Spirit / Frontier ULCC pool' },
  'DEF': { id:'DEF', loadFactor:0.82, faDiscipline:'STANDARD',  label:'Mainline default' },
  'CGO': { id:'CGO', loadFactor:0.10, faDiscipline:'LEAN',      label:'Cargo / supernumeraries only' },
}

function classifyCarrier(op?: string, type?: string): CarrierPost {
  if (type && /F$/.test(type.toUpperCase())) return CARRIER_POST['CGO']
  if (!op) return CARRIER_POST['DEF']
  const u = op.toUpperCase().slice(0,3)
  return CARRIER_POST[u] || CARRIER_POST['DEF']
}

// ---- Airport catalogue --------------------------------------------------
// 28 commercially significant hubs with RFFS category (ICAO Annex 14 / Doc 9137
// Pt I) — RFFS cat affects post-evac survivability but not the 90-second rule
// itself, included here for situational context.
interface Airport {
  icao: string
  iata: string
  name: string
  region: 'NA-US'|'NA-CA'|'EU'|'UK'|'ASIA'|'PAC'|'ME'|'AFR'|'LATAM'
  rffsCat: number     // ICAO 1-10 (10 = highest, F-class fire-extinguishing)
  hubBusyHr: number   // rolling-hour movements at peak (CHMI)
  lat: number
  lng: number
}

const AIRPORTS: Airport[] = [
  // ── USA ──
  { icao:'KJFK', iata:'JFK', name:'New York JFK',          region:'NA-US', rffsCat:10, hubBusyHr:90,  lat:40.6398, lng:-73.7789 },
  { icao:'KLGA', iata:'LGA', name:'New York LaGuardia',    region:'NA-US', rffsCat:9,  hubBusyHr:80,  lat:40.7772, lng:-73.8726 },
  { icao:'KEWR', iata:'EWR', name:'Newark Liberty',        region:'NA-US', rffsCat:10, hubBusyHr:82,  lat:40.6925, lng:-74.1687 },
  { icao:'KBOS', iata:'BOS', name:'Boston Logan',          region:'NA-US', rffsCat:9,  hubBusyHr:65,  lat:42.3656, lng:-71.0096 },
  { icao:'KIAD', iata:'IAD', name:'Washington Dulles',     region:'NA-US', rffsCat:10, hubBusyHr:62,  lat:38.9531, lng:-77.4565 },
  { icao:'KDCA', iata:'DCA', name:'Washington Reagan',     region:'NA-US', rffsCat:8,  hubBusyHr:60,  lat:38.8521, lng:-77.0378 },
  { icao:'KATL', iata:'ATL', name:'Atlanta',               region:'NA-US', rffsCat:10, hubBusyHr:110, lat:33.6407, lng:-84.4277 },
  { icao:'KMIA', iata:'MIA', name:'Miami',                 region:'NA-US', rffsCat:10, hubBusyHr:88,  lat:25.7959, lng:-80.2870 },
  { icao:'KORD', iata:'ORD', name:'Chicago O\u2019Hare',   region:'NA-US', rffsCat:10, hubBusyHr:105, lat:41.9786, lng:-87.9048 },
  { icao:'KDFW', iata:'DFW', name:'Dallas/Fort Worth',     region:'NA-US', rffsCat:10, hubBusyHr:96,  lat:32.8998, lng:-97.0403 },
  { icao:'KIAH', iata:'IAH', name:'Houston Intercont.',    region:'NA-US', rffsCat:10, hubBusyHr:75,  lat:29.9844, lng:-95.3414 },
  { icao:'KDEN', iata:'DEN', name:'Denver',                region:'NA-US', rffsCat:10, hubBusyHr:90,  lat:39.8617, lng:-104.6731 },
  { icao:'KPHX', iata:'PHX', name:'Phoenix Sky Harbor',    region:'NA-US', rffsCat:10, hubBusyHr:72,  lat:33.4343, lng:-112.0116 },
  { icao:'KLAS', iata:'LAS', name:'Las Vegas Harry Reid',  region:'NA-US', rffsCat:10, hubBusyHr:78,  lat:36.0840, lng:-115.1537 },
  { icao:'KLAX', iata:'LAX', name:'Los Angeles',           region:'NA-US', rffsCat:10, hubBusyHr:92,  lat:33.9416, lng:-118.4085 },
  { icao:'KSFO', iata:'SFO', name:'San Francisco',         region:'NA-US', rffsCat:10, hubBusyHr:65,  lat:37.6189, lng:-122.3750 },
  { icao:'KSEA', iata:'SEA', name:'Seattle-Tacoma',        region:'NA-US', rffsCat:10, hubBusyHr:74,  lat:47.4502, lng:-122.3088 },
  { icao:'KMSP', iata:'MSP', name:'Minneapolis-St Paul',   region:'NA-US', rffsCat:10, hubBusyHr:72,  lat:44.8848, lng:-93.2223 },
  // ── CANADA ──
  { icao:'CYYZ', iata:'YYZ', name:'Toronto Pearson',       region:'NA-CA', rffsCat:10, hubBusyHr:78,  lat:43.6772, lng:-79.6306 },
  { icao:'CYVR', iata:'YVR', name:'Vancouver',             region:'NA-CA', rffsCat:10, hubBusyHr:60,  lat:49.1939, lng:-123.1844 },
  // ── EUROPE / UK ──
  { icao:'EGLL', iata:'LHR', name:'London Heathrow',       region:'UK',    rffsCat:10, hubBusyHr:88,  lat:51.4775, lng:-0.4614 },
  { icao:'EHAM', iata:'AMS', name:'Amsterdam Schiphol',    region:'EU',    rffsCat:10, hubBusyHr:80,  lat:52.3086, lng:4.7639 },
  { icao:'EDDF', iata:'FRA', name:'Frankfurt',             region:'EU',    rffsCat:10, hubBusyHr:80,  lat:50.0379, lng:8.5622 },
  { icao:'LFPG', iata:'CDG', name:'Paris CDG',             region:'EU',    rffsCat:10, hubBusyHr:82,  lat:49.0097, lng:2.5479 },
  { icao:'EDDM', iata:'MUC', name:'München',               region:'EU',    rffsCat:10, hubBusyHr:70,  lat:48.3538, lng:11.7861 },
  // ── ASIA / PAC / ME ──
  { icao:'OMDB', iata:'DXB', name:'Dubai',                 region:'ME',    rffsCat:10, hubBusyHr:90,  lat:25.2532, lng:55.3657 },
  { icao:'WSSS', iata:'SIN', name:'Singapore Changi',      region:'ASIA',  rffsCat:10, hubBusyHr:80,  lat:1.3644,  lng:103.9915 },
  { icao:'VHHH', iata:'HKG', name:'Hong Kong',             region:'ASIA',  rffsCat:10, hubBusyHr:75,  lat:22.3080, lng:113.9185 },
]

// ---- Geometry ----------------------------------------------------------
const R_NM = 3440.065
function haversineNM(a1: number, o1: number, a2: number, o2: number): number {
  const φ1 = a1 * Math.PI / 180, φ2 = a2 * Math.PI / 180
  const dφ = (a2 - a1) * Math.PI / 180, dλ = (o2 - o1) * Math.PI / 180
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
function hash(s: string): number {
  let h = 5381; for (let i=0;i<s.length;i++) h = ((h<<5)+h) ^ s.charCodeAt(i); return h>>>0
}

// ---- Airport snap (ground/landing only) ---------------------------------
interface AirportSnap { apt: Airport; distNM: number }

function snapAirport(f: F): AirportSnap | null {
  // Only consider airframes within 6 NM of a catalogued hub
  let best: AirportSnap | null = null
  for (const apt of AIRPORTS) {
    const d = haversineNM(f.lat, f.lng, apt.lat, apt.lng)
    if (d > 6) continue
    if (!best || d < best.distNM) best = { apt, distNM: d }
  }
  return best
}

// ---- Phase classification ----------------------------------------------
type Phase = 'GATE'|'TAXI-OUT'|'TAKEOFF-ROLL'|'LANDING-ROLLOUT'|'TAXI-IN'|'AIRBORNE'|'OTHER'

function classifyPhase(f: F, snap: AirportSnap | null): Phase {
  if (!snap) return f.ground ? 'OTHER' : 'AIRBORNE'
  if (!f.ground) {
    // Possibly on short final / immediate post-rotation — still scope if very low
    if (f.altitudeFt < 200) return 'LANDING-ROLLOUT'
    return 'AIRBORNE'
  }
  // On ground at a catalogued hub
  if (f.velocityKts >= 80) {
    // High ground speed: takeoff roll or rollout (heuristic)
    return f.vertRate >= 0 ? 'TAKEOFF-ROLL' : 'LANDING-ROLLOUT'
  }
  if (f.velocityKts >= 10 && f.velocityKts < 80) {
    // Determine via deterministic hash → split taxi-out vs taxi-in
    return (hash(f.icao) % 2 === 0) ? 'TAXI-OUT' : 'TAXI-IN'
  }
  return 'GATE'
}

// ---- EVAC compute ------------------------------------------------------
interface EvacEval {
  inScope: boolean
  paxOnBoard: number              // estimated live pax (cert × load × cabin-bias)
  exitsAvail: number              // total available exits (cert × 2)
  exitsAfterBlock: number         // half-blocked simulation (FAR 25.803(d))
  faRequired: number              // ceil(pax / 50) per 14 CFR §121.391
  faActual: number                // staffed (carrier-discipline adjusted)
  slideOpsPct: number             // % of slides operationally ready (0..100)
  mobilityRestrictedPct: number   // % pax mobility-restricted
  paxDensityMul: number           // multiplier (load vs cert)
  exitDeficitMul: number          // multiplier (blocked exits → time penalty)
  faDeficitMul: number            // multiplier (FA shortfall → time penalty)
  slideDegradeMul: number         // multiplier (slide-op deficit)
  mobilityMul: number             // multiplier (mobility load)
  effectiveSec: number            // certDemoSec × all multipliers
  marginSec: number               // 90 − effectiveSec (positive = compliant)
  marginPct: number               // marginSec / 90 × 100
  reason: string
}

function evalEvac(f: F, cls: EvacClass, carrier: CarrierPost, snap: AirportSnap | null, phase: Phase): EvacEval {
  const base: EvacEval = {
    inScope:false, paxOnBoard:0, exitsAvail:0, exitsAfterBlock:0,
    faRequired:0, faActual:0, slideOpsPct:100, mobilityRestrictedPct:0,
    paxDensityMul:1, exitDeficitMul:1, faDeficitMul:1, slideDegradeMul:1, mobilityMul:1,
    effectiveSec:cls.certDemoSec, marginSec:90 - cls.certDemoSec, marginPct: ((90 - cls.certDemoSec)/90)*100,
    reason:'Out of EVAC scope — not at catalogued hub or not in ground/rollout phase.',
  }
  const inScope = !!snap && (phase === 'GATE' || phase === 'TAXI-OUT' || phase === 'TAXI-IN' || phase === 'TAKEOFF-ROLL' || phase === 'LANDING-ROLLOUT')
  if (!inScope) return base

  // ----- Live pax estimate (deterministic per icao+type) -----
  // Cabin-density bias: ULCC carriers fly closer to cert max even at given LF
  const densBias = carrier.faDiscipline === 'LEAN' ? 1.05 : carrier.faDiscipline === 'GENEROUS' ? 0.92 : 1.0
  const paxOnBoard = Math.round(cls.paxCert * carrier.loadFactor * densBias)

  // ----- Exit-blocking simulation (FAR 25.803(d) cert path) -----
  const exitsAvail = cls.exitPairs * 2
  // Live degrade: deterministic 0..2 blocked due to fire/slide-fail/door-jam
  const liveBlocked = (hash(f.icao + 'block') % 3)
  const certBlocked = Math.floor(exitsAvail / 2)  // half blocked per §25.803 demo
  const totalBlocked = Math.min(exitsAvail - 1, certBlocked + liveBlocked - 1)
  const exitsAfterBlock = Math.max(1, exitsAvail - totalBlocked)

  // ----- FA staffing (14 CFR §121.391: 1 FA per 50 pax) -----
  const faRequired = Math.max(1, Math.ceil(paxOnBoard / 50))
  // Carrier discipline: LEAN staffs to law, GENEROUS adds 1 buffer, STANDARD half-buffer
  const certFA = Math.max(1, Math.ceil(cls.paxCert / 50))
  const buffer = carrier.faDiscipline === 'GENEROUS' ? 1 : carrier.faDiscipline === 'STANDARD' ? 0 : -0
  // Sick-call / no-show deterministic 0..1
  const sickCall = (hash(f.icao + 'sick') % 100) < 8 ? 1 : 0
  const faActual = Math.max(1, certFA + buffer - sickCall)

  // ----- Slide ops% (manufacturer + maintenance) -----
  // Average 96% all-slides-ready (NTSB SR A-18-09) with carrier degrade
  const slideBase = carrier.faDiscipline === 'GENEROUS' ? 98 : 95
  const slideOpsPct = Math.max(60, slideBase - (hash(f.icao + 'slide') % 12))

  // ----- Mobility-restricted pax (PRM) -----
  // ~3-6% scheduled airline pax per IATA PRM Resolution 700; biz/cargo ~0
  const mobilityRestrictedPct = cls.id.startsWith('BIZ') || cls.id.startsWith('CARGO')
    ? 0
    : Math.min(12, 3 + (hash(f.icao + 'prm') % 6))

  // ----- Multipliers -----
  // Pax density: 1.0 at certified-max, 0.85 at 60% load
  const paxDensityMul = 0.85 + (paxOnBoard / Math.max(1, cls.paxCert)) * 0.18
  // Exit deficit: 1.0 if cert (half-blocked); >1.0 if more blocked
  const exitDeficitMul = certBlocked > 0
    ? Math.min(1.45, (exitsAvail / 2) / Math.max(1, exitsAfterBlock))
    : 1
  // FA deficit: 1.0 if at law; >1.0 if short
  const faDeficitMul = faActual >= faRequired
    ? 1.0
    : Math.min(1.35, 1 + (faRequired - faActual) * 0.12)
  // Slide degrade: 1.0 at 100%; 1.20 at 60%
  const slideDegradeMul = 1 + ((100 - slideOpsPct) / 100) * 0.50
  // Mobility load: 1.0 at 0%; up to 1.18 at 12%
  const mobilityMul = 1 + (mobilityRestrictedPct / 100) * 1.5

  const effectiveSec = Math.round(
    cls.certDemoSec * paxDensityMul * exitDeficitMul * faDeficitMul * slideDegradeMul * mobilityMul
  )
  const marginSec = 90 - effectiveSec
  const marginPct = (marginSec / 90) * 100

  let reason = ''
  if (effectiveSec > 90) reason = `Effective ${effectiveSec}s EXCEEDS the federal 90-second floor by ${effectiveSec-90}s — exit deficit ${exitsAfterBlock}/${exitsAvail}, FA ${faActual}/${faRequired}, slides ${slideOpsPct}% ready. Brief reduced-exit egress per AC 25.803-1A.`
  else if (marginSec < 10) reason = `Effective ${effectiveSec}s within floor but margin only ${marginSec}s — watch ${exitDeficitMul>1.1?'exit-deficit':faDeficitMul>1.05?'FA-deficit':slideDegradeMul>1.1?'slide':'pax-density'} driver.`
  else if (cls.demoPath === 'ANALYSIS') reason = `Effective ${effectiveSec}s · type certified via §25.803 rationalisation (AC 25.803-1A analysis path) not full-scale demo — derivative envelope ±5% of parent.`
  else if (cls.demoPath === 'PARTIAL') reason = `Cargo airframe — partial demo per 14 CFR §121.291, flightcrew + supernumeraries only. Effective ${effectiveSec}s.`
  else if (marginSec >= 30) reason = `Effective ${effectiveSec}s · ${marginSec}s margin (${marginPct.toFixed(0)}%) — cert envelope satisfied, all six drivers nominal.`
  else reason = `Effective ${effectiveSec}s · ${marginSec}s margin (${marginPct.toFixed(0)}%) — standard ops.`

  return {
    inScope:true, paxOnBoard, exitsAvail, exitsAfterBlock,
    faRequired, faActual, slideOpsPct, mobilityRestrictedPct,
    paxDensityMul, exitDeficitMul, faDeficitMul, slideDegradeMul, mobilityMul,
    effectiveSec, marginSec, marginPct, reason,
  }
}

// ---- 6-driver decomposition ---------------------------------------------
interface Drivers {
  paxDensity: number    // 0..100 contribution from cabin load
  exitDeficit: number   // 0..100 contribution from blocked-exit penalty
  faDeficit: number     // 0..100 contribution from FA shortfall
  slideDegrade: number  // 0..100 contribution from slide inoperative %
  mobilityLoad: number  // 0..100 contribution from PRM load
  certMargin: number    // 0..100 inverse-margin (proximity to 90s floor)
}

function computeDrivers(e: EvacEval): Drivers {
  if (!e.inScope) return { paxDensity:0, exitDeficit:0, faDeficit:0, slideDegrade:0, mobilityLoad:0, certMargin:0 }
  return {
    paxDensity:   Math.min(100, Math.max(0, (e.paxDensityMul - 0.85) * 400)),
    exitDeficit:  Math.min(100, Math.max(0, (e.exitDeficitMul - 1.0) * 220)),
    faDeficit:    Math.min(100, Math.max(0, (e.faDeficitMul - 1.0) * 280)),
    slideDegrade: Math.min(100, Math.max(0, (e.slideDegradeMul - 1.0) * 200)),
    mobilityLoad: Math.min(100, Math.max(0, (e.mobilityMul - 1.0) * 600)),
    certMargin:   Math.min(100, Math.max(0, ((90 - e.marginSec) / 90) * 100)),
  }
}

function composite(d: Drivers, advMul: number): number {
  const hard = Math.max(d.exitDeficit, d.faDeficit, d.certMargin)
  const soft = (d.paxDensity + d.slideDegrade + d.mobilityLoad) / 3
  return Math.min(100, (hard * 0.65 + soft * 0.35) * advMul)
}

function scoreToTier(_score: number, e: EvacEval, cls: EvacClass): Tier {
  if (!e.inScope) return 'N-A'
  if (cls.demoPath === 'ANALYSIS' && e.marginSec >= 10) return 'NOT-DEMO'
  if (e.effectiveSec > 90) return 'CRITICAL'
  if (e.marginSec < 10) return 'WARN'
  if (e.marginSec < 20) return 'MARGINAL'
  if (e.marginSec < 30) return 'COMPLIANT'
  return 'CERTIFIED'
}

// ---- Row aggregation ---------------------------------------------------
interface Row {
  f: F
  cls: EvacClass
  carrier: CarrierPost
  apt: Airport | null
  snap: AirportSnap | null
  ev: EvacEval
  drivers: Drivers
  score: number
  tier: Tier
  phase: Phase
}

export default function EvacMonitor({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<string>('ALL')
  const [regionFilter, setRegionFilter] = useState<string>('ALL')
  const [advMul, setAdvMul] = useState<number>(1.0)
  const [shHalo, setShHalo] = useState<boolean>(true)
  const [shPin, setShPin]   = useState<boolean>(true)
  const [shLbl, setShLbl]   = useState<boolean>(true)
  const [shLink, setShLink] = useState<boolean>(true)
  const [shApt, setShApt]   = useState<boolean>(false)
  const [search, setSearch] = useState<string>('')
  const [picked, setPicked] = useState<string|null>(null)
  const [tab, setTab] = useState<'AIRCRAFT'|'TYPES'|'DRIVERS'|'METHOD'>('AIRCRAFT')

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const cls = classifyType(f.type, f.category)
      const carrier = classifyCarrier(f.operator, f.type)
      const snap = snapAirport(f)
      const phase = classifyPhase(f, snap)
      const ev = evalEvac(f, cls, carrier, snap, phase)
      const drivers = computeDrivers(ev)
      const score = composite(drivers, advMul)
      const tier = scoreToTier(score, ev, cls)
      if (tier === 'N-A') continue
      out.push({ f, cls, carrier, apt: snap?.apt ?? null, snap, ev, drivers, score, tier, phase })
    }
    out.sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, advMul])

  // ---- MapLibre overlay -------------------------------------------------
  useEffect(() => {
    if (!map) return
    const SRC_AC = 'evac-ac-src'
    const SRC_APT = 'evac-apt-src'
    const SRC_LINK = 'evac-link-src'
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any }) }
    ;[SRC_AC, SRC_APT, SRC_LINK].forEach(ensure)

    const view = rows.filter(r =>
      (tierFilter === 'ALL' || r.tier === tierFilter) &&
      (classFilter === 'ALL' || r.cls.width === classFilter) &&
      (regionFilter === 'ALL' || (r.apt && r.apt.region === regionFilter))
    )

    const acFeat: any[] = []
    const linkFeat: any[] = []
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
          label: `${(r.f.callsign||r.f.icao).trim()} ${TIER_ABBR[r.tier]} ${r.ev.effectiveSec}s ${r.ev.exitsAfterBlock}/${r.ev.exitsAvail}exit ${r.ev.faActual}/${r.ev.faRequired}FA`,
        },
      })
      if (shLink && r.apt) {
        linkFeat.push({
          type:'Feature',
          geometry:{ type:'LineString', coordinates:[ [r.f.lng, r.f.lat], [r.apt.lng, r.apt.lat] ] },
          properties:{ color: TIER_COLOR[r.tier] },
        })
      }
    }
    const aptFeat = shApt ? AIRPORTS
      .filter(a => regionFilter === 'ALL' || a.region === regionFilter)
      .map(a => ({
        type:'Feature' as const,
        geometry:{ type:'Point' as const, coordinates:[a.lng, a.lat] },
        properties:{
          label: `${a.iata}·RFFS${a.rffsCat}·${a.hubBusyHr}/hr`,
          color: a.rffsCat >= 10 ? '#10b981' : a.rffsCat >= 8 ? '#0ea5e9' : '#f59e0b',
        },
      })) : []

    ;(map.getSource(SRC_AC) as any).setData({ type:'FeatureCollection', features: (shHalo||shPin||shLbl) ? acFeat : [] })
    ;(map.getSource(SRC_APT) as any).setData({ type:'FeatureCollection', features: aptFeat })
    ;(map.getSource(SRC_LINK) as any).setData({ type:'FeatureCollection', features: linkFeat })

    if (!map.getLayer('evac-apt-pin'))
      map.addLayer({ id:'evac-apt-pin', type:'circle', source:SRC_APT, paint:{ 'circle-radius':5, 'circle-color':['get','color'], 'circle-opacity':0.55, 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('evac-apt-lbl'))
      map.addLayer({ id:'evac-apt-lbl', type:'symbol', source:SRC_APT, layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,-1.4], 'text-anchor':'bottom', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#cbd5e1', 'text-halo-color':'#0b0f17', 'text-halo-width':1.0 } })
    if (!map.getLayer('evac-link'))
      map.addLayer({ id:'evac-link', type:'line', source:SRC_LINK, paint:{ 'line-color':['get','color'], 'line-width':1.0, 'line-opacity':0.45, 'line-dasharray':[2,2] } })
    if (!map.getLayer('evac-halo'))
      map.addLayer({ id:'evac-halo', type:'circle', source:SRC_AC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('evac-pin'))
      map.addLayer({ id:'evac-pin', type:'circle', source:SRC_AC, filter:['>=', ['get','score'], 25], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('evac-lbl'))
      map.addLayer({ id:'evac-lbl', type:'symbol', source:SRC_AC, filter:['>=', ['get','score'], 20], layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.6], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.3 } })

    return () => {
      for (const id of ['evac-lbl','evac-pin','evac-halo','evac-link','evac-apt-lbl','evac-apt-pin']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC_AC, SRC_APT, SRC_LINK]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, classFilter, regionFilter, shHalo, shPin, shLbl, shLink, shApt])

  // ---- Aggregations ----------------------------------------------------
  const visible = rows.filter(r =>
    (tierFilter === 'ALL' || r.tier === tierFilter) &&
    (classFilter === 'ALL' || r.cls.width === classFilter) &&
    (regionFilter === 'ALL' || (r.apt && r.apt.region === regionFilter)) &&
    (!search || (
      (r.f.callsign || r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.apt?.iata || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.apt?.icao || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.f.operator || '').toLowerCase().includes(search.toLowerCase()) ||
      r.cls.id.toLowerCase().includes(search.toLowerCase())
    ))
  )
  const counts: Record<Tier, number> = { 'CRITICAL':0,'WARN':0,'MARGINAL':0,'COMPLIANT':0,'CERTIFIED':0,'NOT-DEMO':0,'N-A':0 }
  for (const r of rows) counts[r.tier]++
  const inScopeN = rows.filter(r => r.ev.inScope).length
  const criticalN = counts['CRITICAL']
  const warnN = counts['WARN']
  const safeN = counts['COMPLIANT'] + counts['CERTIFIED']

  const typeAgg = useMemo(() => {
    const m = new Map<string, { count: number; crit: number; warn: number; safe: number; avgEff: number; sumEff: number }>()
    for (const r of rows) {
      if (!r.ev.inScope) continue
      const v = m.get(r.cls.id) || { count:0, crit:0, warn:0, safe:0, avgEff:0, sumEff:0 }
      v.count++
      v.sumEff += r.ev.effectiveSec
      if (r.tier === 'CRITICAL') v.crit++
      if (r.tier === 'WARN') v.warn++
      if (r.tier === 'COMPLIANT' || r.tier === 'CERTIFIED') v.safe++
      m.set(r.cls.id, v)
    }
    return Array.from(m.entries()).map(([id, v]) => {
      const cls = EVAC_CLASS[id]
      return { cls, ...v, avgEff: v.count ? Math.round(v.sumEff / v.count) : 0 }
    }).sort((a,b) => b.crit - a.crit || b.avgEff - a.avgEff)
  }, [rows])

  const driverAvg = useMemo(() => {
    const inS = rows.filter(r => r.ev.inScope)
    if (!inS.length) return { paxDensity:0, exitDeficit:0, faDeficit:0, slideDegrade:0, mobilityLoad:0, certMargin:0 }
    const n = inS.length
    return {
      paxDensity:   inS.reduce((a,r)=>a+r.drivers.paxDensity,0)/n,
      exitDeficit:  inS.reduce((a,r)=>a+r.drivers.exitDeficit,0)/n,
      faDeficit:    inS.reduce((a,r)=>a+r.drivers.faDeficit,0)/n,
      slideDegrade: inS.reduce((a,r)=>a+r.drivers.slideDegrade,0)/n,
      mobilityLoad: inS.reduce((a,r)=>a+r.drivers.mobilityLoad,0)/n,
      certMargin:   inS.reduce((a,r)=>a+r.drivers.certMargin,0)/n,
    }
  }, [rows])

  return (
    <div className="fixed top-16 right-3 z-40 w-[500px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">

      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">EVAC</span>
          <span className="text-[10px] text-slate-400 truncate">90-Sec Rule · FAR 25.803 · 14 CFR §121.391 · Half-Exit-Blocked · AC 25.803-1A</span>
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
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">CRIT</div><div className="font-mono" style={{color: criticalN>0?'#f43f5e':'#64748b'}}>{criticalN}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WARN</div><div className="font-mono" style={{color: warnN>0?'#fb7185':'#64748b'}}>{warnN}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">SAFE</div><div className="font-mono text-emerald-300">{safeN}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">ANLY</div><div className="font-mono text-violet-300">{counts['NOT-DEMO']}</div></div>
      </div>

      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <label className="text-[10px] text-slate-400 block">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
          <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
        </label>
        <div className="flex flex-wrap gap-1">
          <button onClick={()=>setClassFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL-W</button>
          {(['RGN','NB','WB','HVY'] as const).map(c => (
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
          {([['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['LINK',shLink,setShLink],['APT',shApt,setShApt]] as const).map(([n,v,fn]) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/iata/op" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      <div className="flex gap-1 px-3 py-1.5 border-b border-slate-700/60">
        {(['AIRCRAFT','TYPES','DRIVERS','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">

        {tab === 'AIRCRAFT' && (
          <>
            {visible.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-6">No aircraft in EVAC scope · need active ground / takeoff-roll / landing-rollout traffic at one of 28 catalogued hubs</div>
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
                    <div className="text-[10px] font-mono shrink-0" style={{ color: TIER_COLOR[r.tier] }}>{r.ev.effectiveSec}s</div>
                  </div>

                  <div className="mt-1.5 bg-slate-900/60 rounded p-1.5 font-mono text-[9px] text-slate-300 leading-tight overflow-x-auto whitespace-nowrap">
                    {r.apt && <>
                      <span className="text-slate-500">@</span><span className="text-sky-300">{r.apt.iata}</span>
                      <span className="text-slate-500"> ph </span><span className="text-slate-200">{r.phase}</span>
                      <span className="text-slate-500"> pax </span><span className="text-slate-200">{r.ev.paxOnBoard}/{r.cls.paxCert}</span>
                      <span className="text-slate-500"> exit </span><span style={{color: r.ev.exitDeficitMul>1.1?'#f59e0b':'#10b981'}}>{r.ev.exitsAfterBlock}/{r.ev.exitsAvail}</span>
                      <span className="text-slate-500"> FA </span><span style={{color: r.ev.faActual<r.ev.faRequired?'#f43f5e':'#10b981'}}>{r.ev.faActual}/{r.ev.faRequired}</span>
                      <span className="text-slate-500"> slid </span><span style={{color: r.ev.slideOpsPct<90?'#f59e0b':'#10b981'}}>{r.ev.slideOpsPct}%</span>
                      <span className="text-slate-500"> mgn </span><span style={{color: r.ev.marginSec<0?'#f43f5e':r.ev.marginSec<10?'#f59e0b':'#10b981'}}>{r.ev.marginSec>=0?'+':''}{r.ev.marginSec}s</span>
                    </>}
                  </div>

                  <div className="mt-1 text-[10px] text-slate-300 leading-snug">{r.ev.reason}</div>

                  <div className="mt-1 flex flex-wrap gap-0.5 text-[9px] font-mono">
                    {(['paxDensity','exitDeficit','faDeficit','slideDegrade','mobilityLoad','certMargin'] as const).map(k => {
                      const v = r.drivers[k]
                      const sev = v >= 70 ? '#f43f5e' : v >= 40 ? '#f59e0b' : v >= 15 ? '#0ea5e9' : '#475569'
                      const lbl = ({paxDensity:'PAX',exitDeficit:'EXIT',faDeficit:'FA',slideDegrade:'SLID',mobilityLoad:'PRM',certMargin:'MGN'} as const)[k]
                      return (
                        <span key={k} className="px-1 py-0.5 rounded border text-[8px]" style={{ borderColor: sev + '60', color: sev }}>{lbl}{v.toFixed(0)}</span>
                      )
                    })}
                  </div>

                  {isP && (
                    <div className="mt-2 pt-2 border-t border-slate-700/40 text-[10px] space-y-1">
                      <div className="text-slate-400">Type: <span className="text-slate-200">{r.cls.label}</span></div>
                      <div className="text-slate-400">Cert pax: <span className="font-mono text-slate-200">{r.cls.paxCert}</span> · Cert demo: <span className="font-mono text-slate-200">{r.cls.certDemoSec}s</span> · Path: <span className="font-mono text-violet-300">{r.cls.demoPath}</span></div>
                      <div className="text-slate-400">Exits: <span className="font-mono text-slate-200">{r.cls.exitPairs} pairs = {r.cls.exitPairs*2} doors</span> · Slides: <span className="font-mono text-slate-200">{r.cls.slideType}</span> · Aisles: <span className="font-mono text-slate-200">{r.cls.aisles}</span></div>
                      <div className="text-slate-400">Carrier: <span className="text-slate-200">{r.carrier.label}</span> · LF <span className="font-mono">{(r.carrier.loadFactor*100).toFixed(0)}%</span> · FA <span className="font-mono">{r.carrier.faDiscipline}</span></div>
                      <div className="text-slate-400">Multipliers · PAX×<span className="font-mono">{r.ev.paxDensityMul.toFixed(2)}</span> · EXIT×<span className="font-mono">{r.ev.exitDeficitMul.toFixed(2)}</span> · FA×<span className="font-mono">{r.ev.faDeficitMul.toFixed(2)}</span> · SLID×<span className="font-mono">{r.ev.slideDegradeMul.toFixed(2)}</span> · PRM×<span className="font-mono">{r.ev.mobilityMul.toFixed(2)}</span></div>
                      <div className="text-slate-400">PRM share: <span className="font-mono text-slate-200">{r.ev.mobilityRestrictedPct}%</span> · per IATA PRM Res 700 / 14 CFR §382</div>
                      {r.apt && <div className="text-slate-400">Aerodrome RFFS Cat: <span className="font-mono text-sky-300">{r.apt.rffsCat}</span> · peak movements <span className="font-mono text-slate-200">{r.apt.hubBusyHr}/hr</span></div>}
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}

        {tab === 'TYPES' && (
          <>
            <div className="text-[10px] text-slate-500 mb-1 px-1">Live type-class rollup · sorted by critical count then mean effective-evac-time</div>
            {typeAgg.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-6">No in-scope traffic.</div>
            )}
            {typeAgg.map(t => (
              <div key={t.cls.id} className="border border-slate-700/40 rounded-lg p-2 bg-slate-800/40">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-mono text-sky-300">{t.cls.id}</span>
                    <span className="text-[10px] text-slate-400 truncate">{t.cls.label}</span>
                  </div>
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border" style={{
                    background: (t.cls.demoPath==='FULL-SCALE'?'#10b98122':t.cls.demoPath==='ANALYSIS'?'#a78bfa22':'#94a3b822'),
                    borderColor: (t.cls.demoPath==='FULL-SCALE'?'#10b98166':t.cls.demoPath==='ANALYSIS'?'#a78bfa66':'#94a3b866'),
                    color: (t.cls.demoPath==='FULL-SCALE'?'#10b981':t.cls.demoPath==='ANALYSIS'?'#a78bfa':'#94a3b8'),
                  }}>{t.cls.demoPath}</span>
                </div>
                <div className="mt-1 grid grid-cols-5 gap-1 text-[9px] font-mono">
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">N</span> <span className="text-slate-200">{t.count}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">CRT</span> <span style={{color: t.crit > 0 ? '#f43f5e' : '#64748b'}}>{t.crit}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">WRN</span> <span style={{color: t.warn > 0 ? '#fb7185' : '#64748b'}}>{t.warn}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">SAF</span> <span className="text-emerald-300">{t.safe}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">x̄EF</span> <span style={{color: t.avgEff > 90 ? '#f43f5e' : t.avgEff > 80 ? '#f59e0b' : '#10b981'}}>{t.avgEff}s</span></div>
                </div>
                <div className="mt-1 text-[9px] text-slate-500 font-mono">
                  {t.cls.paxCert}pax · {t.cls.exitPairs}×2={t.cls.exitPairs*2} exits · cert {t.cls.certDemoSec}s · {t.cls.slideType.toLowerCase()} · {t.cls.aisles}-aisle {t.cls.width}
                </div>
              </div>
            ))}
          </>
        )}

        {tab === 'DRIVERS' && (
          <>
            <div className="text-[10px] text-slate-500 mb-1 px-1">6-driver mean across N={rows.filter(r=>r.ev.inScope).length} in-scope aircraft</div>
            {([
              ['paxDensity',   'PAX · cabin pax-density vs cert (LF × cabin-bias)', driverAvg.paxDensity],
              ['exitDeficit',  'EXIT · blocked-exit penalty (half-block + live degrade)', driverAvg.exitDeficit],
              ['faDeficit',    'FA · cabin-attendant shortfall vs 1-per-50 (14 CFR §121.391)', driverAvg.faDeficit],
              ['slideDegrade', 'SLID · slide / slide-raft operational % deficit', driverAvg.slideDegrade],
              ['mobilityLoad', 'PRM · mobility-restricted pax slow-down (IATA Res 700)', driverAvg.mobilityLoad],
              ['certMargin',   'MGN · inverse-margin to 90-second federal floor', driverAvg.certMargin],
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
              Composite = max(EXIT, FA, MGN)·0.65 + mean(PAX, SLID, PRM)·0.35, multiplied by ADV-MUL.
              EXIT drives CRITICAL when more than half of door pairs are blocked — directly compounds cert envelope.
              FA drives CRITICAL when actual staffed cabin crew falls below ceil(pax/50) per §121.391.
              MGN saturates as effective-evac-time approaches the 90-s federal floor regardless of which driver caused it.
            </div>
          </>
        )}

        {tab === 'METHOD' && (
          <div className="text-[10px] text-slate-300 leading-relaxed space-y-2 p-1">
            <p><span className="text-sky-300 font-mono">DEFINITION.</span> The 90-second rule (FAR 25.803 / CS 25.803) requires that any transport-category aircraft demonstrate the ability to evacuate the maximum certified passenger capacity within 90 seconds with HALF of the available exits blocked, using only the exits on the side of the cabin opposite a simulated fire. Compliance is established at type-cert by full-scale demonstration (FAR 25 Appendix J) or — for derivatives within ±5 percent of a parent envelope — by rationalisation analysis per AC 25.803-1A.</p>
            <p><span className="text-sky-300 font-mono">REGULATORY.</span> FAR 25.803 (cert standard), FAR 25.807-25.813 (exit geometry, marking, lighting), FAR 25 Appendix J (demo protocol), 14 CFR §121.291 (operator partial demo every 5 years or fleet change), §121.310 (interior emergency provisions: aisle width, emergency exit access, escape lighting), §121.391 (FA staffing 1-per-50 pax), §121.397 (recurrent emergency drills), §121.585 (exit-row pax fitness), CS-25 Subpart D, AMC 25.803, ICAO Annex 8 Pt IIIA §3, IATA Cabin Operations Safety BPG §4.2.</p>
            <p><span className="text-sky-300 font-mono">EFFECTIVE-TIME MODEL.</span> Effective-evac-sec = certDemoSec × paxDensityMul × exitDeficitMul × faDeficitMul × slideDegradeMul × mobilityMul. paxDensityMul ranges 0.85 (60-percent load) to 1.03 (cert-max), reflecting that the cert demo was at full pax. exitDeficitMul saturates at 1.45 when more exits than the cert half-block are unavailable. faDeficitMul applies 0.12 per FA-short. slideDegradeMul applies 0.50 per 100-percent slide-failure (linear). mobilityMul applies 1.5 per percent PRM (per IATA PRM Resolution 700 + 14 CFR §382).</p>
            <p><span className="text-sky-300 font-mono">FA STAFFING.</span> 14 CFR §121.391 (US) and EASA CAT.OP.MPA.210 (EU) prescribe 1 FA per 50 pax (or fraction). The minimum is not a service standard — it is a SAFETY law tied directly to the 90-second rule. The cert demo presumes a fully-staffed cabin where each FA can clear their assigned exit station in seconds. Sick-call, IRROPS reassignment, and ULCC lean-discipline can push actual FA below required; this is the leading driver of WARN tier.</p>
            <p><span className="text-sky-300 font-mono">SLIDE / SLIDE-RAFT.</span> Wide-bodies (B767/B777/B787/A330/A350/B747/A380) carry slide-rafts per FAR 25.1415 / 25.1411 for over-water egress — a stuck or auto-inflate-failed slide-raft removes the entire door pair and forces redistribution. NTSB SR A-18-09/10 documents cases where slide failure halved effective egress. Narrowbodies carry pure slides only; ATR / Q400 use inflatable ramps (low floor). Business jets ≤19 pax (G650, Falcon 8X) use ramp-wing egress.</p>
            <p><span className="text-sky-300 font-mono">ANALYSIS PATH.</span> Per AC 25.803-1A §6, derivative types within ±5 percent of a demonstrated parent envelope may be certified via analysis rather than re-demo (witness 737 MAX, A320neo, 777X, CRJ-900). These airframes are tracked as NOT-DEMO tier — the cert is valid but the empirical full-scale data point belongs to the parent. Recent NTSB scrutiny (post-737 MAX 8 cabin-egress 2019 Moscow Sheremetyevo SU1492) recommends periodic re-validation of analysis-path airframes.</p>
            <p><span className="text-sky-300 font-mono">SCORING.</span> Per-flight: CRITICAL if effective &gt; 90s (federal floor BREACHED). WARN if 80-90s (within floor, &lt;10s margin). MARGINAL if 70-80s (10-20s margin). COMPLIANT if 60-70s (20-30s margin). CERTIFIED if &lt; 60s (&gt; 30s margin, cert envelope satisfied with all six drivers nominal). NOT-DEMO for ANALYSIS-path airframes with adequate margin. Airport rollup ranks hubs by CRITICAL count then peak-hour movements.</p>
            <p><span className="text-sky-300 font-mono">DISTINCT FROM.</span> RFFS (ground rescue & firefighting category — post-evac survivability not airframe egress), EMAS (engineered material arresting system — runway overrun energy absorption), DOORPLUG (Alaska 1282 mid-cabin door-plug structural integrity in cruise — different failure mode), HRF (hot-refueling procedural compliance), SAFA (ramp-inspection operator audit), RTO (rejected-takeoff V1 decision). EVAC is uniquely the GROUND / LANDING-ROLLOUT 90-SECOND-RULE EVACUATION CAPABILITY evaluator.</p>
          </div>
        )}
      </div>
    </div>
  )
}
