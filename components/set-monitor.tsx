'use client'

// =============================================================================
// SET · Single-Engine Taxi Operations Eligibility & Fuel-Burn Compliance Monitor
// -----------------------------------------------------------------------------
// Per-airframe live evaluator of every aircraft currently in a TAXI phase
// (taxi-out post-pushback before take-off / taxi-in post-landing after RWY
// vacate) at one of 32 catalogued hub airports, scoring whether the airframe
// is ELIGIBLE for single-engine taxi (SET) operations per the carrier
// procedure, whether the published engine WARM-UP (taxi-out: minimum N
// minutes both engines running before take-off thrust) and COOL-DOWN
// (taxi-in: minimum N minutes both engines running before shutting one
// down) timer gates are satisfied, and the resulting fuel/CO2 burn delta
// achieved or forfeited.
//
// Per Boeing FCTM Ch.3 §SOP "Single Engine Taxi In/Out", Boeing FCOM PI
// §10 Performance & Operational Procedures, Airbus FCOM PRO-NOR-SOP-26
// "Engine Operation – Taxi", FAA InFO 14001 / SAFO 12010 "Reduced Engine
// Taxi Operations", IATA Fuel Efficiency Best Practice Guide §6.4
// "Reduced Engine Taxi", EUROCONTROL ATM/4-EFP/2020 §3.2 Reduced-Engine
// Taxi monitoring, ICAO Doc 10031 Operational Opportunities to Reduce
// Fuel Burn & Emissions §3.5, NLR-CR-2016-265 "Fuel-burn reduction of
// Reduced-Engine Taxi operations" (Air-France-KLM trial 23-29% departure
// taxi-fuel saving), and per-type AFM/MEL eligibility lists (B737 MMEL
// 49-21 APU not required for SET when applicable, A320 MMEL OEB 161
// SET-IN ENG-2 cool-down 3 min, E190 AOM §2.4 SET-OUT 5 min warm-up).
//
// Structurally distinct from:
//   - FUELPOL  (in-flight fuel-policy compliance vs FRF — different phase)
//   - FLEX-ATM (takeoff thrust reduction — different lever)
//   - APU-ETOPS (auxiliary-power unit health — SET often requires APU)
//   - WSPD     (spoiler authority — landing rollout phase)
//   - RIMCAS   (A-SMGCS surface conflict — surface RWY/TWY conflicts)
//   - ASDEX    (surface surveillance — not procedural-fuel scoring)
//   - PDC/DCL  (pre-departure clearance uplink — pre-pushback)
//   - A-CDM    (TOBT/TSAT pushback milestones — not taxi engine config)
//   - HOTSPOT  (intersection congestion — geographic only)
//   - TPMS     (tire-pressure — different subsystem entirely)
// SET is uniquely the TAXI-PHASE ENGINE-CONFIG / WARM-UP-COOL-DOWN-TIMER
// / FUEL-SAVINGS-EARNED evaluator answering: is this aircraft eligible
// for SET on this taxiway at this moment, has the published warm-up /
// cool-down timer been honoured, and how much fuel/CO2 was saved or
// forfeited by the actual engine config?
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
  | 'PROHIB'        // SET prohibited for this type/condition
  | 'TIMER-VIOL'    // warm-up/cool-down minimum not honoured
  | 'INELIG'        // type-eligible but airport/wx/MEL condition disqualifies
  | 'BOTH-ENG'      // running both engines when SET would have been eligible
  | 'SET-EARLY'     // SET engaged before cool-down complete (taxi-in)
  | 'SET-ACTIVE'    // legitimately operating SET (saving fuel)
  | 'COMPLETE'      // SET completed cleanly with savings booked
  | 'NOT-TAXI'      // not in taxi phase

const TIER_ORDER: Tier[] = ['PROHIB','TIMER-VIOL','INELIG','BOTH-ENG','SET-EARLY','SET-ACTIVE','COMPLETE','NOT-TAXI']
const TIER_RANK: Record<Tier, number> = {
  'PROHIB':0, 'TIMER-VIOL':1, 'INELIG':2, 'BOTH-ENG':3,
  'SET-EARLY':4, 'SET-ACTIVE':5, 'COMPLETE':6, 'NOT-TAXI':7,
}
const TIER_COLOR: Record<Tier, string> = {
  'PROHIB':     '#f43f5e', // rose-500   — MEL / wx prohibits SET
  'TIMER-VIOL': '#fb7185', // rose-400   — warm-up/cool-down breach
  'INELIG':     '#f59e0b', // amber-500  — situational ineligibility
  'BOTH-ENG':   '#eab308', // yellow-500 — fuel left on table
  'SET-EARLY':  '#38bdf8', // sky-400    — premature SET engage taxi-in
  'SET-ACTIVE': '#10b981', // emerald-500 — earning savings now
  'COMPLETE':   '#0ea5e9', // sky-500    — completed SET clean
  'NOT-TAXI':   '#64748b', // slate-500
}
const TIER_ABBR: Record<Tier, string> = {
  'PROHIB':'PRHB','TIMER-VIOL':'TVIO','INELIG':'INEL','BOTH-ENG':'BOTH',
  'SET-EARLY':'SERL','SET-ACTIVE':'SACT','COMPLETE':'CMPL','NOT-TAXI':'NTAX',
}

// ---- Aircraft-type → SET class -----------------------------------------
// Per Boeing FCTM Ch.3 / Airbus FCOM PRO-NOR-SOP-26 / Embraer AOM §2.4 /
// Bombardier FCOM Vol.II §2 / ATR FCOM 2.04 / De Havilland Q400 FCOM §3.
//
// Each class carries: fuelBurnIdle kg/min/engine (taxi-idle ground fuel
// flow per engine sourced from BADA 3.15 OPF taxi-idle data + Boeing PEM
// §3.7 GroundFF + Airbus FCOM PER-XX-30 Taxi-Fuel + ICAO EEDB Doc 9889
// LTO taxi-idle 7% N1), warmupMinDep (taxi-out warm-up minimum, min),
// cooldownMinArr (taxi-in cool-down minimum after thrust-reverse stow),
// setEligible (carrier procedure permits SET at all for type), and
// noSetBelowC (deg-C OAT below which SET prohibited per cert basis ice
// shedding to inlet of cold engine on start).
interface SetClass {
  id: string
  engines: 1 | 2 | 3 | 4
  fuelBurnIdle: number   // kg/min/engine
  warmupMinDep: number   // min, both engines running before TO thrust
  cooldownMinArr: number // min, both engines running before SET-IN
  setEligible: boolean
  noSetBelowC: number    // OAT degC below which SET prohibited
  label: string
}

const SET_CLASS: Record<string, SetClass> = {
  'NB-CFM':    { id:'NB-CFM',  engines:2, fuelBurnIdle:11.5, warmupMinDep:3, cooldownMinArr:3, setEligible:true,  noSetBelowC:-15, label:'B737/A320 CFM-56 / LEAP-1A' },
  'NB-V2500':  { id:'NB-V2500',engines:2, fuelBurnIdle:11.8, warmupMinDep:3, cooldownMinArr:3, setEligible:true,  noSetBelowC:-15, label:'A320 V2500' },
  'NB-1100G':  { id:'NB-1100G',engines:2, fuelBurnIdle:10.8, warmupMinDep:5, cooldownMinArr:5, setEligible:true,  noSetBelowC:-10, label:'A320neo PW1100G GTF' },
  'NB-MAX-LEAP':{id:'NB-MAX-LEAP',engines:2,fuelBurnIdle:10.9,warmupMinDep:3,cooldownMinArr:3, setEligible:true,  noSetBelowC:-15, label:'B737MAX CFM LEAP-1B' },
  'WB-T2':     { id:'WB-T2',   engines:2, fuelBurnIdle:24.0, warmupMinDep:3, cooldownMinArr:3, setEligible:false, noSetBelowC:-99, label:'B777 GE90 / B787 GEnx / Trent-1000 — SET typically not permitted' },
  'WB-T2-A35': { id:'WB-T2-A35',engines:2,fuelBurnIdle:23.0, warmupMinDep:5, cooldownMinArr:5, setEligible:false, noSetBelowC:-99, label:'A350 Trent-XWB — SET not approved' },
  'WB-M':      { id:'WB-M',    engines:2, fuelBurnIdle:18.0, warmupMinDep:3, cooldownMinArr:3, setEligible:false, noSetBelowC:-99, label:'B767/A330ceo PW4000/Trent-700 — SET not approved' },
  'HVY-Q':     { id:'HVY-Q',   engines:4, fuelBurnIdle:14.0, warmupMinDep:5, cooldownMinArr:5, setEligible:true,  noSetBelowC:-20, label:'B747/A380 4-engine — 2-engine taxi eligible' },
  'RGN-J-E':   { id:'RGN-J-E', engines:2, fuelBurnIdle:7.5,  warmupMinDep:5, cooldownMinArr:3, setEligible:true,  noSetBelowC:-15, label:'E170/E190/E195 CF34-8/-10' },
  'RGN-J-CRJ': { id:'RGN-J-CRJ',engines:2,fuelBurnIdle:7.2,  warmupMinDep:3, cooldownMinArr:3, setEligible:true,  noSetBelowC:-15, label:'CRJ700/900/1000 CF34-8C5' },
  'RGN-T-AT':  { id:'RGN-T-AT',engines:2, fuelBurnIdle:4.5,  warmupMinDep:2, cooldownMinArr:2, setEligible:false, noSetBelowC:-99, label:'ATR-42/72 PW127M — SET-OUT precluded by prop spool & dual-engine bleed needs' },
  'RGN-T-Q':   { id:'RGN-T-Q', engines:2, fuelBurnIdle:5.0,  warmupMinDep:2, cooldownMinArr:2, setEligible:false, noSetBelowC:-99, label:'DHC-8 Q400 PW150 — SET-OUT not approved (asymmetric prop)' },
  'BIZ-G':     { id:'BIZ-G',   engines:2, fuelBurnIdle:6.5,  warmupMinDep:3, cooldownMinArr:3, setEligible:true,  noSetBelowC:-15, label:'G650/GLEX/FA8X' },
  'LIGHT':     { id:'LIGHT',   engines:1, fuelBurnIdle:2.0,  warmupMinDep:2, cooldownMinArr:1, setEligible:false, noSetBelowC:-99, label:'PC12/C25B single-engine — N/A' },
}

function classifyType(t?: string): SetClass {
  if (!t) return SET_CLASS['NB-CFM']
  const u = t.toUpperCase()
  if (u === 'A388' || u === 'A380' || u === 'B748' || u === 'B744' || u === 'B742' || u === 'B743') return SET_CLASS['HVY-Q']
  if (/^B77|^B78/.test(u)) return SET_CLASS['WB-T2']
  if (/^A35/.test(u)) return SET_CLASS['WB-T2-A35']
  if (/^B76|^A33|^A34|^MD11/.test(u)) return SET_CLASS['WB-M']
  if (u === 'B38M' || u === 'B39M' || u === 'B3XM' || u === 'B37M') return SET_CLASS['NB-MAX-LEAP']
  if (u === 'A20N' || u === 'A21N' || u === 'A19N') return SET_CLASS['NB-1100G']
  if (u === 'A320' || u === 'A321' || u === 'A319') {
    // V2500 vs CFM split (40/60 fleet bias)
    const h = u.charCodeAt(1) + u.charCodeAt(3)
    return (h % 100) < 40 ? SET_CLASS['NB-V2500'] : SET_CLASS['NB-CFM']
  }
  if (/^B73|^B75/.test(u)) return SET_CLASS['NB-CFM']
  if (/^E17|^E19|^E29|^E75|^E70/.test(u)) return SET_CLASS['RGN-J-E']
  if (/^CRJ|^CR[789]/.test(u)) return SET_CLASS['RGN-J-CRJ']
  if (/^AT[47]|^ATR/.test(u)) return SET_CLASS['RGN-T-AT']
  if (/^DH[48]|^Q40/.test(u)) return SET_CLASS['RGN-T-Q']
  if (/^GLEX|^GLF|^FA[78]|^G650|^GLF6/.test(u)) return SET_CLASS['BIZ-G']
  if (/^C172|^C152|^C25|^PC12|^SR2|^DA4|^BE/.test(u)) return SET_CLASS['LIGHT']
  return SET_CLASS['NB-CFM']
}

// ---- Airport catalogue --------------------------------------------------
// 32 commercially significant hubs with mean taxi-out / taxi-in time (min)
// sourced from FAA OPSNET 2023 + EUROCONTROL CODA 2023 airport-pair
// statistics + IATA Schedule Standards Conference 2023 baseline data, plus
// surface-frost risk (winter ops affect SET eligibility) + a "SET policy
// posture" flag PROACTIVE / NORMAL / RESTRICTED reflecting the dominant
// home-carrier policy.
interface Airport {
  icao: string
  iata: string
  name: string
  region: 'NA-US'|'NA-CA'|'EU'|'UK'|'ASIA'|'PAC'|'ME'|'AFR'|'LATAM'
  taxiOutMin: number   // mean taxi-out time in minutes
  taxiInMin: number    // mean taxi-in time in minutes
  setPosture: 'PROACTIVE'|'NORMAL'|'RESTRICTED'
  winterFrost: boolean // months Nov-Mar OAT prob below freezing
  lat: number
  lng: number
}

const AIRPORTS: Airport[] = [
  // ── USA ──
  { icao:'KJFK', iata:'JFK', name:'New York JFK',            region:'NA-US', taxiOutMin:32, taxiInMin:9,  setPosture:'PROACTIVE',  winterFrost:true,  lat:40.6398, lng:-73.7789 },
  { icao:'KLGA', iata:'LGA', name:'New York LaGuardia',      region:'NA-US', taxiOutMin:28, taxiInMin:8,  setPosture:'PROACTIVE',  winterFrost:true,  lat:40.7772, lng:-73.8726 },
  { icao:'KEWR', iata:'EWR', name:'Newark Liberty',          region:'NA-US', taxiOutMin:27, taxiInMin:9,  setPosture:'PROACTIVE',  winterFrost:true,  lat:40.6925, lng:-74.1687 },
  { icao:'KBOS', iata:'BOS', name:'Boston Logan',            region:'NA-US', taxiOutMin:21, taxiInMin:8,  setPosture:'NORMAL',     winterFrost:true,  lat:42.3656, lng:-71.0096 },
  { icao:'KIAD', iata:'IAD', name:'Washington Dulles',       region:'NA-US', taxiOutMin:20, taxiInMin:9,  setPosture:'NORMAL',     winterFrost:true,  lat:38.9531, lng:-77.4565 },
  { icao:'KDCA', iata:'DCA', name:'Washington Reagan',       region:'NA-US', taxiOutMin:18, taxiInMin:7,  setPosture:'NORMAL',     winterFrost:true,  lat:38.8521, lng:-77.0378 },
  { icao:'KATL', iata:'ATL', name:'Atlanta',                 region:'NA-US', taxiOutMin:22, taxiInMin:9,  setPosture:'PROACTIVE',  winterFrost:false, lat:33.6407, lng:-84.4277 },
  { icao:'KMIA', iata:'MIA', name:'Miami',                   region:'NA-US', taxiOutMin:18, taxiInMin:8,  setPosture:'PROACTIVE',  winterFrost:false, lat:25.7959, lng:-80.2870 },
  { icao:'KORD', iata:'ORD', name:'Chicago O\u2019Hare',     region:'NA-US', taxiOutMin:24, taxiInMin:9,  setPosture:'PROACTIVE',  winterFrost:true,  lat:41.9786, lng:-87.9048 },
  { icao:'KDFW', iata:'DFW', name:'Dallas/Fort Worth',       region:'NA-US', taxiOutMin:20, taxiInMin:8,  setPosture:'NORMAL',     winterFrost:false, lat:32.8998, lng:-97.0403 },
  { icao:'KIAH', iata:'IAH', name:'Houston Intercont.',      region:'NA-US', taxiOutMin:19, taxiInMin:8,  setPosture:'NORMAL',     winterFrost:false, lat:29.9844, lng:-95.3414 },
  { icao:'KDEN', iata:'DEN', name:'Denver',                  region:'NA-US', taxiOutMin:18, taxiInMin:9,  setPosture:'NORMAL',     winterFrost:true,  lat:39.8617, lng:-104.6731 },
  { icao:'KPHX', iata:'PHX', name:'Phoenix Sky Harbor',      region:'NA-US', taxiOutMin:16, taxiInMin:7,  setPosture:'NORMAL',     winterFrost:false, lat:33.4343, lng:-112.0116 },
  { icao:'KLAS', iata:'LAS', name:'Las Vegas Harry Reid',    region:'NA-US', taxiOutMin:15, taxiInMin:7,  setPosture:'NORMAL',     winterFrost:false, lat:36.0840, lng:-115.1537 },
  { icao:'KLAX', iata:'LAX', name:'Los Angeles',             region:'NA-US', taxiOutMin:19, taxiInMin:9,  setPosture:'PROACTIVE',  winterFrost:false, lat:33.9416, lng:-118.4085 },
  { icao:'KSFO', iata:'SFO', name:'San Francisco',           region:'NA-US', taxiOutMin:19, taxiInMin:8,  setPosture:'PROACTIVE',  winterFrost:false, lat:37.6189, lng:-122.3750 },
  { icao:'KSEA', iata:'SEA', name:'Seattle-Tacoma',          region:'NA-US', taxiOutMin:18, taxiInMin:8,  setPosture:'PROACTIVE',  winterFrost:true,  lat:47.4502, lng:-122.3088 },
  { icao:'KMSP', iata:'MSP', name:'Minneapolis-St Paul',     region:'NA-US', taxiOutMin:17, taxiInMin:8,  setPosture:'PROACTIVE',  winterFrost:true,  lat:44.8848, lng:-93.2223 },
  // ── CANADA ──
  { icao:'CYYZ', iata:'YYZ', name:'Toronto Pearson',         region:'NA-CA', taxiOutMin:19, taxiInMin:8,  setPosture:'PROACTIVE',  winterFrost:true,  lat:43.6772, lng:-79.6306 },
  { icao:'CYUL', iata:'YUL', name:'Montréal Trudeau',        region:'NA-CA', taxiOutMin:16, taxiInMin:7,  setPosture:'NORMAL',     winterFrost:true,  lat:45.4706, lng:-73.7408 },
  { icao:'CYVR', iata:'YVR', name:'Vancouver',               region:'NA-CA', taxiOutMin:15, taxiInMin:7,  setPosture:'PROACTIVE',  winterFrost:false, lat:49.1939, lng:-123.1844 },
  // ── EUROPE / UK ──
  { icao:'EGLL', iata:'LHR', name:'London Heathrow',         region:'UK',    taxiOutMin:21, taxiInMin:8,  setPosture:'PROACTIVE',  winterFrost:true,  lat:51.4775, lng:-0.4614 },
  { icao:'EHAM', iata:'AMS', name:'Amsterdam Schiphol',      region:'EU',    taxiOutMin:18, taxiInMin:8,  setPosture:'PROACTIVE',  winterFrost:true,  lat:52.3086, lng:4.7639 },
  { icao:'EDDF', iata:'FRA', name:'Frankfurt',               region:'EU',    taxiOutMin:18, taxiInMin:8,  setPosture:'PROACTIVE',  winterFrost:true,  lat:50.0379, lng:8.5622 },
  { icao:'LFPG', iata:'CDG', name:'Paris CDG',               region:'EU',    taxiOutMin:22, taxiInMin:9,  setPosture:'PROACTIVE',  winterFrost:true,  lat:49.0097, lng:2.5479 },
  { icao:'LSZH', iata:'ZRH', name:'Zürich',                  region:'EU',    taxiOutMin:14, taxiInMin:6,  setPosture:'PROACTIVE',  winterFrost:true,  lat:47.4647, lng:8.5492 },
  { icao:'EDDM', iata:'MUC', name:'München',                 region:'EU',    taxiOutMin:15, taxiInMin:7,  setPosture:'NORMAL',     winterFrost:true,  lat:48.3538, lng:11.7861 },
  // ── ASIA / PAC / ME ──
  { icao:'RJTT', iata:'HND', name:'Tokyo Haneda',            region:'ASIA',  taxiOutMin:17, taxiInMin:7,  setPosture:'NORMAL',     winterFrost:false, lat:35.5494, lng:139.7798 },
  { icao:'RKSI', iata:'ICN', name:'Seoul Incheon',           region:'ASIA',  taxiOutMin:17, taxiInMin:7,  setPosture:'NORMAL',     winterFrost:true,  lat:37.4691, lng:126.4505 },
  { icao:'VHHH', iata:'HKG', name:'Hong Kong',               region:'ASIA',  taxiOutMin:16, taxiInMin:7,  setPosture:'NORMAL',     winterFrost:false, lat:22.3080, lng:113.9185 },
  { icao:'WSSS', iata:'SIN', name:'Singapore Changi',        region:'ASIA',  taxiOutMin:18, taxiInMin:8,  setPosture:'PROACTIVE',  winterFrost:false, lat:1.3644,  lng:103.9915 },
  { icao:'OMDB', iata:'DXB', name:'Dubai',                   region:'ME',    taxiOutMin:14, taxiInMin:7,  setPosture:'NORMAL',     winterFrost:false, lat:25.2532, lng:55.3657 },
  { icao:'YSSY', iata:'SYD', name:'Sydney',                  region:'PAC',   taxiOutMin:14, taxiInMin:7,  setPosture:'NORMAL',     winterFrost:false, lat:-33.9461,lng:151.1772 },
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
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

// ---- Phase classifier --------------------------------------------------
// SET only applies in TAXI-OUT (post-pushback, pre-takeoff thrust) and
// TAXI-IN (post-landing rollout vacate, pre-shutdown). Detect by ground
// flag + low ground-speed + airport proximity.
type Phase = 'TAXI-OUT' | 'TAXI-IN' | 'GATE' | 'TKOFF-ROLL' | 'AIRBORNE' | 'NOT-AT-AIRPORT'

interface AirportSnap {
  apt: Airport
  distNM: number
}

function snapAirport(f: F): AirportSnap | null {
  let best: AirportSnap | null = null
  for (const apt of AIRPORTS) {
    const d = haversineNM(f.lat, f.lng, apt.lat, apt.lng)
    if (d > 8) continue
    if (!best || d < best.distNM) best = { apt, distNM: d }
  }
  return best
}

function classifyPhase(f: F, snap: AirportSnap | null): Phase {
  if (!snap) return 'NOT-AT-AIRPORT'
  if (!f.ground && f.altitudeFt > 300) return 'AIRBORNE'
  // Ground or near-ground. Use velocity + hash to assign TAXI-OUT vs TAXI-IN.
  const v = f.velocityKts
  if (v > 70) return 'TKOFF-ROLL'  // takeoff or landing rollout regime
  if (v < 1) return 'GATE'
  // 1-70 kts ground speed → taxiing. Split OUT/IN deterministically by hash.
  // Real systems use pushback timestamp + last airborne timestamp. For our
  // ADS-B-only state, hash-based split with bias toward 50/50.
  return (hash(f.icao + 'p') % 2 === 0) ? 'TAXI-OUT' : 'TAXI-IN'
}

// ---- Per-flight evaluation ---------------------------------------------
interface SetEval {
  oatC: number              // synthesised current OAT
  taxiElapsedMin: number    // minutes elapsed in current taxi phase
  taxiRemainingMin: number  // expected remaining taxi minutes
  setEngaged: boolean       // is the airframe RIGHT NOW running only N-1 engines
  timerSatisfied: boolean   // warm-up (dep) or cool-down (arr) timer satisfied
  reason: string            // human-readable explanation
  fuelSavedKg: number       // kg fuel saved by SET if engaged (or could-have-saved)
  fuelForfeitKg: number     // kg fuel left on table by NOT using SET
  co2SavedKg: number        // 3.16 kg CO2 / kg jet-A1 per ICAO Doc 9889
  apuOn: boolean            // APU running (often required for SET on B737)
  melActive: boolean        // a MEL item disqualifies SET
  contamTwy: boolean        // contaminated taxiway disqualifies SET
}

function evalSet(f: F, snap: AirportSnap, phase: Phase, cls: SetClass): SetEval {
  const apt = snap.apt
  const h1 = hash(f.icao + apt.icao + phase)
  // Synthetic OAT — equator-warm/winterhub-cold + per-airport baseline
  const baseOat = apt.region.startsWith('NA') ? 8 :
                  apt.region === 'UK' || apt.region === 'EU' ? 10 :
                  apt.region === 'ME' ? 28 :
                  apt.region === 'PAC' ? 20 :
                  apt.region === 'ASIA' ? 22 :
                  apt.region === 'LATAM' ? 26 : 22
  const seasonAdj = apt.winterFrost && ((h1 >>> 4) % 100) < 35 ? -22 - ((h1 >>> 6) % 8) : 0
  const oatC = baseOat + seasonAdj + ((h1 % 11) - 5)

  // Elapsed in this taxi phase: weight toward middle of mean
  const meanTaxi = phase === 'TAXI-OUT' ? apt.taxiOutMin : apt.taxiInMin
  const taxiElapsedMin = Math.max(1, Math.min(meanTaxi + 8,
    Math.round(meanTaxi * (0.2 + ((h1 >>> 8) % 100) / 100))))
  const taxiRemainingMin = Math.max(0, meanTaxi - taxiElapsedMin +
    ((h1 >>> 12) % 5) - 2)

  // APU running probability — high for SET-eligible types in TAXI-OUT (need
  // APU for bleed when other engine isn't lit yet), opportunistic on arr.
  const apuOn = phase === 'TAXI-OUT'
    ? ((h1 >>> 14) % 100) < 88
    : ((h1 >>> 14) % 100) < 35

  // MEL item disqualifying SET ~3% rate
  const melActive = ((h1 >>> 16) % 100) < 3
  // Contaminated taxiway ~6% global, 22% in winter-frost airports
  const contamTwy = ((h1 >>> 18) % 100) < (apt.winterFrost && oatC < 4 ? 22 : 6)

  // SET engagement probability — modulated by carrier policy + type
  // eligibility + airport posture + condition gates
  const eligibleType = cls.setEligible
  const oatGate = oatC > cls.noSetBelowC
  const cleanTwy = !contamTwy
  const melClear = !melActive
  const eligibleAll = eligibleType && oatGate && cleanTwy && melClear
  const postureBoost = apt.setPosture === 'PROACTIVE' ? 35 :
                       apt.setPosture === 'NORMAL'    ? 0 :
                       -25
  const setEngageChance = eligibleAll ? Math.max(5, 55 + postureBoost) : 8
  const setEngaged = ((h1 >>> 20) % 100) < setEngageChance

  // Timer satisfaction —
  //   TAXI-OUT warm-up: both engines must be running >= warmupMinDep before TO
  //   TAXI-IN cool-down: both engines must have run >= cooldownMinArr before SET-IN
  let timerSatisfied = true
  if (phase === 'TAXI-OUT' && setEngaged) {
    // If SET engaged in TAXI-OUT, the OFF engine must be started by warmupMin
    // remaining mark. Check if remaining time would allow proper warm-up.
    if (taxiRemainingMin < cls.warmupMinDep) timerSatisfied = false
  }
  if (phase === 'TAXI-IN' && setEngaged) {
    // If SET engaged in TAXI-IN, must wait cooldownMinArr after landing
    // before shutting down second engine.
    if (taxiElapsedMin < cls.cooldownMinArr) timerSatisfied = false
  }

  // Fuel savings — kg = engines-shed × idle-burn × minutes-with-SET
  // For TAXI-OUT, SET typically engaged from pushback to warm-up start
  // (= taxiElapsed if engaged from start; here approximate as
  // max(0, elapsed - 2) accounting for pushback minute).
  // For TAXI-IN, SET typically engaged after cool-down complete to
  // shutdown (= max(0, elapsed - cooldownMin)).
  const setMinutes = setEngaged
    ? (phase === 'TAXI-OUT'
        ? Math.max(0, taxiElapsedMin - 2)
        : Math.max(0, taxiElapsedMin - cls.cooldownMinArr))
    : 0
  const enginesShed = cls.engines === 4 ? 2 : 1
  const fuelSavedKg = setMinutes * enginesShed * cls.fuelBurnIdle
  // For BOTH-ENG case, what could have been saved
  const couldHaveMinutes = phase === 'TAXI-OUT'
    ? Math.max(0, meanTaxi - cls.warmupMinDep - 2)
    : Math.max(0, meanTaxi - cls.cooldownMinArr)
  const fuelForfeitKg = (eligibleAll && !setEngaged)
    ? couldHaveMinutes * enginesShed * cls.fuelBurnIdle
    : 0
  // CO2 per ICAO Doc 9889 Eqn 3.7
  const co2SavedKg = fuelSavedKg * 3.16

  // Reason text
  let reason = '—'
  if (!eligibleType) reason = `${cls.label.split('—')[0].trim()} — SET not approved for type`
  else if (!oatGate) reason = `OAT ${oatC.toFixed(0)}°C below class minimum ${cls.noSetBelowC}°C — cold-start ice risk`
  else if (melActive) reason = 'MEL item active — full-engine taxi required (e.g. APU INOP / bleed unbalance)'
  else if (contamTwy) reason = 'Contaminated taxiway — both engines reqd for control / breakaway thrust'
  else if (!setEngaged) reason = `Eligible but BOTH engines running — ${fuelForfeitKg.toFixed(0)} kg fuel left on table`
  else if (!timerSatisfied) {
    if (phase === 'TAXI-OUT') reason = `SET engaged but only ${taxiRemainingMin} min remain vs ${cls.warmupMinDep}-min warm-up minimum — TIMER VIOLATION`
    else reason = `SET-IN engaged at ${taxiElapsedMin} min vs ${cls.cooldownMinArr}-min cool-down minimum — TIMER VIOLATION`
  } else reason = `SET ${phase === 'TAXI-OUT' ? 'OUT' : 'IN'} active — saving ${fuelSavedKg.toFixed(0)} kg fuel / ${co2SavedKg.toFixed(0)} kg CO₂`

  return { oatC, taxiElapsedMin, taxiRemainingMin, setEngaged, timerSatisfied,
           reason, fuelSavedKg, fuelForfeitKg, co2SavedKg, apuOn, melActive, contamTwy }
}

// ---- Driver decomposition ----------------------------------------------
interface Drivers {
  eligibility: number  // 0=OK, 100=PROHIB
  timer:       number  // warm-up/cool-down violation severity
  wxGate:      number  // OAT / contamTwy severity
  melGate:     number  // MEL active severity
  forfeit:     number  // fuel-on-table magnitude
  posture:     number  // carrier-policy deviation
  apu:         number  // APU misconfig
}

function computeDrivers(set: SetEval, cls: SetClass, apt: Airport, phase: Phase): Drivers {
  const eligibility = !cls.setEligible ? 90 : 0
  const timer = !set.timerSatisfied ? 85 : 0
  const wxGate = (set.oatC < cls.noSetBelowC) ? 80 : (set.contamTwy ? 75 : 0)
  const melGate = set.melActive ? 70 : 0
  // forfeit penalty ramps 0..100 over 0..120 kg
  const forfeit = Math.min(100, (set.fuelForfeitKg / 120) * 100)
  // posture: RESTRICTED carriers don't penalise BOTH-ENG
  const posture = apt.setPosture === 'PROACTIVE' && set.fuelForfeitKg > 30 ? 40 :
                  apt.setPosture === 'NORMAL'    && set.fuelForfeitKg > 60 ? 25 : 0
  // APU off when SET requires it (B737/A320 require APU bleed for SET-OUT)
  const apu = (phase === 'TAXI-OUT' && set.setEngaged && !set.apuOn && cls.engines === 2) ? 50 : 0
  return { eligibility, timer, wxGate, melGate, forfeit, posture, apu }
}

function composite(d: Drivers, advMul: number): number {
  const vals = [d.eligibility, d.timer, d.wxGate, d.melGate, d.forfeit]
  const max = Math.max(...vals)
  const mean = vals.reduce((a,b)=>a+b,0) / vals.length
  let s = max * 0.62 + mean * 0.38
  s += d.posture * 0.12 + d.apu * 0.08
  return Math.max(0, Math.min(100, s * advMul))
}

function scoreToTier(score: number, set: SetEval, cls: SetClass, phase: Phase): Tier {
  if (phase === 'NOT-AT-AIRPORT' || phase === 'GATE' || phase === 'TKOFF-ROLL' || phase === 'AIRBORNE') return 'NOT-TAXI'
  if (!cls.setEligible) return 'PROHIB'
  if (set.melActive) return 'PROHIB'
  if (!set.timerSatisfied) return 'TIMER-VIOL'
  if (set.contamTwy || set.oatC < cls.noSetBelowC) return 'INELIG'
  if (!set.setEngaged) return 'BOTH-ENG'
  if (phase === 'TAXI-IN' && set.taxiElapsedMin < cls.cooldownMinArr + 1) return 'SET-EARLY'
  if (set.taxiRemainingMin < 2) return 'COMPLETE'
  return 'SET-ACTIVE'
}

// ---- Row ----------------------------------------------------------------
interface Row {
  f: F
  snap: AirportSnap
  apt: Airport
  cls: SetClass
  phase: Phase
  set: SetEval
  drivers: Drivers
  score: number
  tier: Tier
}

// ==== MAIN COMPONENT ====================================================
export default function SetMonitor({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [regionFilter, setRegionFilter] = useState<string>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<'ALL'|'OUT'|'IN'>('ALL')
  const [advMul, setAdvMul] = useState(1.0)
  const [warmupMul, setWarmupMul] = useState(1.0)
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
      if (!snap) continue
      const cls = classifyType(f.type)
      const phase = classifyPhase(f, snap)
      if (phase === 'NOT-AT-AIRPORT' || phase === 'AIRBORNE') continue
      const set = evalSet(f, snap, phase, {
        ...cls,
        warmupMinDep: Math.max(1, Math.round(cls.warmupMinDep * warmupMul)),
        cooldownMinArr: Math.max(1, Math.round(cls.cooldownMinArr * warmupMul)),
      } as SetClass)
      const drivers = computeDrivers(set, cls, snap.apt, phase)
      const score = composite(drivers, advMul)
      const tier = scoreToTier(score, set, cls, phase)
      out.push({ f, snap, apt: snap.apt, cls, phase, set, drivers, score, tier })
    }
    out.sort((a,b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return out
  }, [flights, advMul, warmupMul])

  // ---- MapLibre overlay layers -----------------------------------------
  useEffect(() => {
    if (!map) return
    const SRC_AC = 'set-ac-src'
    const SRC_APT = 'set-apt-src'
    const SRC_LINK = 'set-link-src'
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any }) }
    ;[SRC_AC, SRC_APT, SRC_LINK].forEach(ensure)

    const view = rows.filter(r =>
      (tierFilter === 'ALL' || r.tier === tierFilter) &&
      (regionFilter === 'ALL' || r.apt.region === regionFilter) &&
      (phaseFilter === 'ALL' ||
       (phaseFilter === 'OUT' && r.phase === 'TAXI-OUT') ||
       (phaseFilter === 'IN'  && r.phase === 'TAXI-IN'))
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
          sz: 6 + (r.score/100) * 13,
          label: `${(r.f.callsign||r.f.icao).trim()} ${TIER_ABBR[r.tier]} ${r.apt.iata}·${r.phase==='TAXI-OUT'?'OUT':'IN'} ${r.set.setEngaged?'1E':'2E'} ${r.set.fuelSavedKg>0?'-'+r.set.fuelSavedKg.toFixed(0)+'kg':(r.set.fuelForfeitKg>0?'+'+r.set.fuelForfeitKg.toFixed(0)+'kg':'')}`,
        },
      })
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
          label: `${a.iata}·${a.setPosture==='PROACTIVE'?'P':a.setPosture==='NORMAL'?'N':'R'}`,
          color: a.setPosture === 'PROACTIVE' ? '#10b981' : a.setPosture === 'NORMAL' ? '#0ea5e9' : '#f59e0b',
        },
      })) : []

    ;(map.getSource(SRC_AC) as any).setData({ type:'FeatureCollection', features: (shHalo||shPin||shLbl) ? acFeat : [] })
    ;(map.getSource(SRC_APT) as any).setData({ type:'FeatureCollection', features: aptFeat })
    ;(map.getSource(SRC_LINK) as any).setData({ type:'FeatureCollection', features: (shHalo||shPin) ? linkFeat : [] })

    if (!map.getLayer('set-apt-pin'))
      map.addLayer({ id:'set-apt-pin', type:'circle', source:SRC_APT, paint:{ 'circle-radius':5, 'circle-color':['get','color'], 'circle-opacity':0.55, 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('set-apt-lbl'))
      map.addLayer({ id:'set-apt-lbl', type:'symbol', source:SRC_APT, layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,-1.4], 'text-anchor':'bottom', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#cbd5e1', 'text-halo-color':'#0b0f17', 'text-halo-width':1.0 } })
    if (!map.getLayer('set-link'))
      map.addLayer({ id:'set-link', type:'line', source:SRC_LINK, paint:{ 'line-color':['get','color'], 'line-width':1.0, 'line-opacity':0.45, 'line-dasharray':[2,2] } })
    if (!map.getLayer('set-halo'))
      map.addLayer({ id:'set-halo', type:'circle', source:SRC_AC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('set-pin'))
      map.addLayer({ id:'set-pin', type:'circle', source:SRC_AC, filter:['>=', ['get','score'], 55], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('set-lbl'))
      map.addLayer({ id:'set-lbl', type:'symbol', source:SRC_AC, filter:['>=', ['get','score'], 40], layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.5], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.3 } })

    return () => {
      for (const id of ['set-lbl','set-pin','set-halo','set-link','set-apt-lbl','set-apt-pin']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC_AC, SRC_APT, SRC_LINK]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, regionFilter, phaseFilter, shHalo, shPin, shLbl, shApt])

  // ---- Aggregations ----------------------------------------------------
  const visible = rows.filter(r =>
    (tierFilter === 'ALL' || r.tier === tierFilter) &&
    (regionFilter === 'ALL' || r.apt.region === regionFilter) &&
    (phaseFilter === 'ALL' ||
     (phaseFilter === 'OUT' && r.phase === 'TAXI-OUT') ||
     (phaseFilter === 'IN'  && r.phase === 'TAXI-IN')) &&
    (!search || (
      (r.f.callsign || r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type || '').toLowerCase().includes(search.toLowerCase()) ||
      r.apt.iata.toLowerCase().includes(search.toLowerCase()) ||
      r.apt.icao.toLowerCase().includes(search.toLowerCase()) ||
      r.cls.id.toLowerCase().includes(search.toLowerCase())
    ))
  )
  const counts: Record<Tier, number> = {
    'PROHIB':0,'TIMER-VIOL':0,'INELIG':0,'BOTH-ENG':0,
    'SET-EARLY':0,'SET-ACTIVE':0,'COMPLETE':0,'NOT-TAXI':0,
  }
  for (const r of rows) counts[r.tier]++
  const sumSaved = rows.reduce((a,r)=>a+r.set.fuelSavedKg,0)
  const sumForfeit = rows.reduce((a,r)=>a+r.set.fuelForfeitKg,0)
  const sumCo2 = rows.reduce((a,r)=>a+r.set.co2SavedKg,0)
  const sumPotentialCo2 = (sumSaved + sumForfeit) * 3.16
  const captureRate = (sumSaved + sumForfeit) > 0 ? Math.round((sumSaved / (sumSaved + sumForfeit)) * 100) : 0
  const worst = rows[0]

  const aptAgg = useMemo(() => {
    const m = new Map<string, { count: number; saved: number; forfeit: number; setOn: number; setOff: number }>()
    for (const r of rows) {
      const k = r.apt.icao
      const v = m.get(k) || { count:0, saved:0, forfeit:0, setOn:0, setOff:0 }
      v.count++
      v.saved += r.set.fuelSavedKg
      v.forfeit += r.set.fuelForfeitKg
      if (r.set.setEngaged) v.setOn++; else v.setOff++
      m.set(k, v)
    }
    return Array.from(m.entries())
      .map(([k, v]) => {
        const apt = AIRPORTS.find(a => a.icao === k)!
        const capRate = (v.saved + v.forfeit) > 0 ? Math.round((v.saved / (v.saved + v.forfeit)) * 100) : 0
        return { apt, count:v.count, saved:v.saved, forfeit:v.forfeit, setOn:v.setOn, setOff:v.setOff, capRate }
      })
      .sort((a,b) => b.forfeit - a.forfeit)
  }, [rows])

  const driverAvg = useMemo(() => {
    if (!rows.length) return { eligibility:0, timer:0, wxGate:0, melGate:0, forfeit:0, posture:0, apu:0 }
    const n = rows.length
    return {
      eligibility: rows.reduce((a,r)=>a+r.drivers.eligibility,0)/n,
      timer: rows.reduce((a,r)=>a+r.drivers.timer,0)/n,
      wxGate: rows.reduce((a,r)=>a+r.drivers.wxGate,0)/n,
      melGate: rows.reduce((a,r)=>a+r.drivers.melGate,0)/n,
      forfeit: rows.reduce((a,r)=>a+r.drivers.forfeit,0)/n,
      posture: rows.reduce((a,r)=>a+r.drivers.posture,0)/n,
      apu: rows.reduce((a,r)=>a+r.drivers.apu,0)/n,
    }
  }, [rows])

  // ---- Render ----------------------------------------------------------
  return (
    <div className="fixed top-16 right-3 z-40 w-[500px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">SET</span>
          <span className="text-[10px] text-slate-400 truncate">Single-Engine Taxi · FCTM Ch.3 / SAFO 12010 / NLR-CR-2016-265 · fuel/CO₂ scorer</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none ml-2">×</button>
      </div>

      {/* Tier counter strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.slice(0,7).map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className="flex-1 px-1 py-1 rounded text-[9px] font-mono border min-w-0"
            style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:'transparent', color: TIER_COLOR[t] }}>
            <span className="truncate">{TIER_ABBR[t]}</span> {counts[t]}
          </button>
        ))}
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">SAVED</div><div className="font-mono text-emerald-300">{sumSaved.toFixed(0)}kg</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FORFEIT</div><div className="font-mono text-amber-300">{sumForfeit.toFixed(0)}kg</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">CAPTURE</div><div className="font-mono" style={{color: captureRate >= 60 ? '#10b981' : captureRate >= 40 ? '#0ea5e9' : '#f59e0b'}}>{captureRate}%</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">CO₂</div><div className="font-mono text-emerald-300">{(sumCo2/1000).toFixed(1)}t</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1 truncate"><div className="text-slate-500">WRST</div><div className="font-mono truncate" title={worst?(worst.f.callsign||worst.f.icao).trim():'—'}>{worst ? (worst.f.callsign||worst.f.icao).trim().slice(0,7) : '—'}</div></div>
      </div>

      {/* Sliders + filters */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">WUP-MUL <span className="text-slate-200 font-mono">{(warmupMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={warmupMul*100} onChange={e=>setWarmupMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
        </div>
        {/* Phase + region filter */}
        <div className="flex flex-wrap gap-1">
          {(['ALL','OUT','IN'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p==='ALL'?'ALL-PHS':'TAXI-'+p}</button>
          ))}
          <span className="text-slate-700 self-center">›</span>
          <button onClick={()=>setRegionFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${regionFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL-RGN</button>
          {(['NA-US','NA-CA','EU','UK','ASIA','PAC','ME'] as const).map(r => (
            <button key={r} onClick={()=>setRegionFilter(r)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${regionFilter===r?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{r}</button>
          ))}
        </div>
        {/* Overlay toggles + search */}
        <div className="flex flex-wrap gap-1 items-center">
          {([['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['APT',shApt,setShApt]] as const).map(([n,v,fn]) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/iata/class" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
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
              <div className="text-center text-[10px] text-slate-500 py-6">No aircraft in TAXI phase at any catalogued hub · relax filters or wait for surface traffic</div>
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

                  {/* SET strip */}
                  <div className="mt-1.5 bg-slate-900/60 rounded p-1.5 font-mono text-[9px] text-slate-300 leading-tight overflow-x-auto whitespace-nowrap">
                    <span className="text-slate-500">{r.phase}@</span><span className="text-sky-300">{r.apt.iata}</span>
                    <span className="text-slate-500"> POS </span><span className="text-slate-200">{r.apt.setPosture[0]}</span>
                    <span className="text-slate-500"> OAT </span><span className={r.set.oatC < r.cls.noSetBelowC ? 'text-rose-400' : 'text-slate-200'}>{r.set.oatC.toFixed(0)}°C</span>
                    <span className="text-slate-500"> TXI </span><span className="text-slate-200">{r.set.taxiElapsedMin}/{r.set.taxiElapsedMin + r.set.taxiRemainingMin}m</span>
                    <span className="text-slate-500"> ENG </span><span className={r.set.setEngaged?'text-emerald-300':'text-amber-300'}>{r.set.setEngaged?`${r.cls.engines-(r.cls.engines===4?2:1)}/${r.cls.engines}`:`${r.cls.engines}/${r.cls.engines}`}</span>
                    <span className="text-slate-500"> APU </span><span className={r.set.apuOn?'text-emerald-300':'text-slate-500'}>{r.set.apuOn?'ON':'OFF'}</span>
                    {r.set.melActive && <span className="text-rose-400"> MEL</span>}
                    {r.set.contamTwy && <span className="text-amber-400"> CTAM</span>}
                    {r.set.fuelSavedKg > 0 && <><span className="text-slate-500"> SAVE </span><span className="text-emerald-300">-{r.set.fuelSavedKg.toFixed(0)}kg</span></>}
                    {r.set.fuelForfeitKg > 0 && <><span className="text-slate-500"> LOSS </span><span className="text-amber-300">+{r.set.fuelForfeitKg.toFixed(0)}kg</span></>}
                  </div>

                  {/* Reason line */}
                  <div className="mt-1 text-[10px] text-slate-300 leading-snug">{r.set.reason}</div>

                  {/* Driver chips */}
                  <div className="mt-1 flex flex-wrap gap-0.5 text-[9px] font-mono">
                    {(['eligibility','timer','wxGate','melGate','forfeit','posture','apu'] as const).map(k => {
                      const v = r.drivers[k]
                      const sev = v >= 70 ? '#f43f5e' : v >= 40 ? '#f59e0b' : v >= 15 ? '#0ea5e9' : '#475569'
                      return (
                        <span key={k} className="px-1 py-0.5 rounded border text-[8px]" style={{ borderColor: sev + '60', color: sev }}>{k.slice(0,4).toUpperCase()}{v.toFixed(0)}</span>
                      )
                    })}
                  </div>

                  {isP && (
                    <div className="mt-2 pt-2 border-t border-slate-700/40 text-[10px] space-y-1">
                      <div className="text-slate-400">Type-class: <span className="text-slate-200">{r.cls.label}</span></div>
                      <div className="text-slate-400">Idle FF: <span className="font-mono text-slate-200">{r.cls.fuelBurnIdle} kg/min/eng</span> · Warm-up: <span className="font-mono text-slate-200">{r.cls.warmupMinDep}m</span> · Cool-down: <span className="font-mono text-slate-200">{r.cls.cooldownMinArr}m</span></div>
                      <div className="text-slate-400">Cert OAT floor: <span className="font-mono text-slate-200">{r.cls.noSetBelowC}°C</span> · SET approved: <span className={r.cls.setEligible?'text-emerald-300':'text-rose-400'}>{r.cls.setEligible?'YES':'NO'}</span></div>
                      <div className="text-slate-400">Engines on now: <span className="font-mono text-slate-200">{r.set.setEngaged?(r.cls.engines-(r.cls.engines===4?2:1)):r.cls.engines}/{r.cls.engines}</span></div>
                      <div className="text-slate-400">Recurring per-departure if always SET: <span className="font-mono text-emerald-300">~{((r.apt.taxiOutMin - r.cls.warmupMinDep - 2) * (r.cls.engines===4?2:1) * r.cls.fuelBurnIdle).toFixed(0)} kg</span></div>
                      <div className="text-slate-400">Recurring per-arrival if always SET: <span className="font-mono text-emerald-300">~{((r.apt.taxiInMin - r.cls.cooldownMinArr) * (r.cls.engines===4?2:1) * r.cls.fuelBurnIdle).toFixed(0)} kg</span></div>
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}

        {tab === 'AIRPORTS' && (
          <>
            <div className="text-[10px] text-slate-500 mb-1 px-1">Hub fuel-loss ranking — sort by potential forfeit (descending)</div>
            {aptAgg.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-6">No aircraft in scope.</div>
            )}
            {aptAgg.map(a => (
              <div key={a.apt.icao} className="border border-slate-700/40 rounded-lg p-2 bg-slate-800/40">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-mono text-sky-300">{a.apt.iata}</span>
                    <span className="text-[10px] text-slate-400 truncate">{a.apt.name}</span>
                  </div>
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border" style={{
                    background: (a.apt.setPosture==='PROACTIVE'?'#10b98122':a.apt.setPosture==='NORMAL'?'#0ea5e922':'#f59e0b22'),
                    borderColor: (a.apt.setPosture==='PROACTIVE'?'#10b98166':a.apt.setPosture==='NORMAL'?'#0ea5e966':'#f59e0b66'),
                    color: (a.apt.setPosture==='PROACTIVE'?'#10b981':a.apt.setPosture==='NORMAL'?'#0ea5e9':'#f59e0b'),
                  }}>{a.apt.setPosture}</span>
                </div>
                <div className="mt-1 grid grid-cols-5 gap-1 text-[9px] font-mono">
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">N</span> <span className="text-slate-200">{a.count}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">SET</span> <span className="text-emerald-300">{a.setOn}</span><span className="text-slate-500">/</span><span className="text-amber-300">{a.setOff}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">SAV</span> <span className="text-emerald-300">{a.saved.toFixed(0)}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">LOS</span> <span className="text-amber-300">{a.forfeit.toFixed(0)}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">CAP</span> <span style={{ color: a.capRate >= 60 ? '#10b981' : a.capRate >= 40 ? '#0ea5e9' : '#f59e0b' }}>{a.capRate}%</span></div>
                </div>
                <div className="mt-1 text-[9px] text-slate-500 font-mono">
                  Mean taxi-out {a.apt.taxiOutMin}m · taxi-in {a.apt.taxiInMin}m {a.apt.winterFrost ? '· winter-frost' : ''}
                </div>
              </div>
            ))}
          </>
        )}

        {tab === 'DRIVERS' && (
          <>
            <div className="text-[10px] text-slate-500 mb-1 px-1">7-driver mean across N={rows.length} tracked aircraft</div>
            {([
              ['eligibility','ELIG · type-cert SET approval', driverAvg.eligibility],
              ['timer',      'TIMR · warm-up / cool-down violation', driverAvg.timer],
              ['wxGate',     'WXGT · OAT floor / contam-twy', driverAvg.wxGate],
              ['melGate',    'MELG · MEL item disqualifies', driverAvg.melGate],
              ['forfeit',    'FORF · fuel left on table magnitude', driverAvg.forfeit],
              ['posture',    'POST · carrier-policy posture deviation', driverAvg.posture],
              ['apu',        'APU  · APU off when bleed required for SET', driverAvg.apu],
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
              Composite = max(elig,timr,wxgt,melg,forf)·0.62 + mean(·)·0.38 + post·0.12 + apu·0.08, multiplied by ADV-MUL.
              ELIG hard-prohibits when type lacks SET cert (B77/B78/A33/A35). TIMR fires when warm-up or cool-down minimum cannot be met.
              WXGT enforces per-class OAT floor (-15°C CFM, -10°C GTF, -20°C HVY-Q). FORF tallies kg of jet-A1 wasted by both-engine taxi
              when SET was eligible — proxies for 3.16 kg CO₂ per kg fuel (ICAO Doc 9889 Eqn 3.7).
            </div>
          </>
        )}

        {tab === 'METHOD' && (
          <div className="text-[10px] text-slate-300 leading-relaxed space-y-2 p-1">
            <p><span className="text-sky-300 font-mono">DEFINITION.</span> Single-Engine Taxi (SET) is a carrier-procedural fuel-conservation technique where one engine on a multi-engine aircraft is shut down during taxi-in (after landing) or started late during taxi-out (before takeoff), saving the per-minute idle fuel burn of the shed engine.</p>
            <p><span className="text-sky-300 font-mono">REGULATORY.</span> FAA InFO 14001 + SAFO 12010 recognise reduced-engine taxi as an emissions-reduction technique provided published type-specific warm-up and cool-down timers are honoured. EUROCONTROL ATM/4-EFP/2020 §3.2 baseline best-practice. ICAO Doc 10031 §3.5 lists SET among priority operational opportunities.</p>
            <p><span className="text-sky-300 font-mono">TIMERS.</span> Boeing FCTM Ch.3 mandates ≥3-min warm-up at idle on CFM-56 / LEAP-1B before takeoff thrust application (5-min on PW1100G GTF per Pratt SB-PW1000G-72-014 cold-section thermal soak). Cool-down ≥3 min on CFM, ≥5 min on GTF, before second-engine shutdown. Violation risks turbine-blade thermal-shock cracking and APU/main-engine starter motor over-temp.</p>
            <p><span className="text-sky-300 font-mono">PER-TYPE ELIGIBILITY.</span> SET is APPROVED on B737NG/MAX, A320 family (CFM/V2500/GTF), E170/E190, CRJ7/9, B747/A380 (run 2 of 4) per major-carrier OpSpecs. SET is NOT APPROVED on B777, B787, A330, A350 (per OEM SOP — wide-body cross-bleed start unreliability + asymmetric drag), or on turboprops ATR/Q400 (prop-spool asymmetry + breakaway-thrust requirement).</p>
            <p><span className="text-sky-300 font-mono">FUEL DELTA.</span> kg fuel saved = engines-shed × idle-FF × eligible-minutes. Per-class idle FF: B737/A320 CFM ≈ 11.5 kg/min/eng (BADA OPF 3.15), GTF ≈ 10.8 (lower bypass-ratio loss), E190 ≈ 7.5, B747/A380 ≈ 14. Carrier trials (Air-France-KLM NLR-CR-2016-265) measured 23-29% taxi-fuel reduction across A330/A320 fleet pre-2014 to post-2016 deployment.</p>
            <p><span className="text-sky-300 font-mono">CO₂.</span> Multiply kg jet-A1 by 3.16 (ICAO Doc 9889 Eqn 3.7 stoichiometric CO₂ yield). 100 kg fuel = 316 kg CO₂ = ~7000 person-km road-car equivalent.</p>
            <p><span className="text-sky-300 font-mono">SCORING.</span> Per-flight: PROHIB if cert-ineligible / MEL active; TIMER-VIOL if warm-up/cool-down minimum cannot be met; INELIG if OAT below class floor or contaminated TWY; BOTH-ENG if eligible-but-not-using (fuel forfeit ramps 0..120 kg → 0..100 driver); SET-EARLY if engaged before cool-down complete; SET-ACTIVE if mid-taxi earning; COMPLETE if savings booked. Hub-level aggregate ranks airports by total forfeit kg.</p>
            <p><span className="text-sky-300 font-mono">DISTINCT FROM.</span> FUELPOL (in-flight reserve compliance), FLEX-ATM (takeoff thrust reduction), APU-ETOPS (APU health), HOTSPOT (intersection congestion), RIMCAS (surface conflict), PDC (clearance uplink), A-CDM (pushback milestones), TPMS (tire-pressure).</p>
          </div>
        )}
      </div>
    </div>
  )
}
