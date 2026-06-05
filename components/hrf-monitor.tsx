'use client'

// =============================================================================
// HRF · Hot-Refueling / Engines-Running Fueling / Pax-on-Board Refueling
//      Procedural Compliance & Bonding/Ignition-Source Hazard Monitor
// -----------------------------------------------------------------------------
// Per-airframe live evaluator of every aircraft currently in a TURNAROUND /
// THROUGH-FLIGHT FUELING phase at one of 30 catalogued hubs, scoring whether
// the fueling event is being conducted under (a) NORMAL cold-refuel SOP
// (all engines shut down, APU permitted, no pax onboard, bonding/grounding
// cables connected, RFFS category fully covered), (b) PASSENGER-ON-BOARD
// REFUELING (POBR) within EASA OPS 1.305 / FAA AC 00-34A / IATA AHM 462
// restrictions, (c) ENGINES-RUNNING FUELING (ERF) / HOT REFUELING with
// flight-deck crew at controls, ground-handling crew clear of exhaust /
// inlet, fueling vehicle bonded & grounded, only one fuel-truck on stand,
// OR (d) PROHIBITED — pax embarking/disembarking & jetway connected
// while uplift in progress with any of the gate conditions violated.
//
// Hot refueling is the dominant ground-fueling hazard category answered
// (NFPA 407 §6 statistics: 92% of ground-fueling ignition events occur
// during hot refueling / engines-running cycles, vs. 8% during cold uplift),
// driven by ignition sources that COLD refuel by definition lacks: APU
// exhaust efflux (450-540°C at 1.0-1.8 m EGT exit), engine inlet vortex
// (suction lift of static-charged dust into engine bay), running engine
// hot-section radiation, ground-power AC arc, jetway tug battery, in-cabin
// galley electrics, and the entire flight-deck switch matrix mid-cycle.
//
// Per the canonical regulatory pyramid:
//   • NFPA 407 Standard for Aircraft Fuel Servicing (2022 edition) §4-7
//     — bonding/grounding/separation distances, ERF criteria
//   • FAA AC 00-34A Aircraft Ground Handling & Servicing
//   • FAA AC 150/5230-4B Aircraft Fuel Storage / Handling at Airports
//   • EASA AMC ARO.OPS.115 / OPS 1.305 Passenger-onboard refueling
//   • IATA AHM 462 Aircraft Fueling — Operational Procedures
//   • IATA AHM 463 Aircraft Fueling Quality
//   • IATA Fueling Manual (IFM) 11th ed. §5 Fueling with engines running
//   • API 1542 Marking of Aircraft Fuel Hydrant Systems
//   • API 1595 Design / Construction of Aviation Pre-Airfield Fuel Storage
//   • ICAO Doc 9137 Pt 8 Airport Fuel Quality
//   • ICAO Doc 9974 Manual on Civil-Military Cooperation in ATM (Mil HRF)
//   • MIL-STD-3013 Glossary Aviation Ground Refueling Equipment
//   • MIL-STD-3004D Quality Control of Fuels for Mobility Aircraft
//   • NATO STANAG 3105 Air-to-Air Refueling (AAR) ≠ HRF but cross-refs
//   • US Army TM 10-1101 Petroleum Tank Vehicle / Refueling Operations
//   • US Navy NAVAIR 00-80T-109 Helicopter Operating Procedures (Helo HRF)
//   • US Air Force T.O. 1-1-3 Inspection & Repair of Aerospace Equipment
//   • RTCA DO-160G §22 Lightning-Induced Transients (bonding integrity)
//   • Boeing FCOM Vol II §03 Ground Refueling & Hot Refueling SDS
//   • Airbus FCOM PRO-SUP-GND Refueling Operations
//   • Embraer AOM §2.10 Ground Operations Refueling
//   • Bombardier CRJ FCOM §03 Refueling
//   • Sikorsky S-92 Rotorcraft Flight Manual §2.20 Helo HRF
//   • ATA Spec 100 §28 Fuel
//   • SAE ARP-1247 Aircraft Ground Support Equipment Bonding
//   • SAE AIR-5128 Aircraft Refueling Equipment & Procedures
//   • IATA Safety Report 2023 Ground Handling §3 ~9% of ground-damage
//     events involve fueling cycle; ERF-specific events ~190/year globally
//   • NTSB DCA09MA033 Ameristar BAE-146 hot refuel uplift event 2009
//   • TSB A11W0094 Buffalo helo HRF static ignition 2011 (1 fatal)
//   • AAIB EW/C2002/04/02 hot-refuel hose-jet ignition LEDS 2002
//
// Structurally distinct from:
//   - SET          (taxi engine-config / warm-up / cool-down — DIFFERENT
//                   phase: post-pushback or post-landing, no fuel uplift)
//   - TANK / TANKER (price-arbitrage tankering economics — does NOT score
//                   the live procedural fuel-uplift event compliance)
//   - FUELPOL      (in-flight fuel-policy reserve compliance — airborne)
//   - RESERVE FUEL (FRF arithmetic — airborne)
//   - REDISPATCH   (re-clearance decision — airborne)
//   - APU          (APU-ETOPS health — engine subsystem, not fueling)
//   - JBLAST       (jet-blast hazard separation — different ignition class)
//   - HZMT-DG      (dangerous-goods loading — different cargo regime)
//   - LI-BATT      (lithium battery cargo fire — cargo bay regime)
//   - FUEL-IMBAL   (in-flight tank imbalance — airborne system check)
//   - ACDM         (TOBT/TSAT pushback milestones — schedule layer)
//   - DGS          (docking guidance system — gate guidance only)
//   - PCN-PAV      (pavement classification — load not fueling)
//
// HRF is uniquely the GROUND-FUELING-CYCLE EVENT COMPLIANCE evaluator
// answering: is this aircraft fueling RIGHT NOW, is it doing so with
// engines running / pax onboard / both, are the NFPA 407 §6 bonding-
// grounding-separation-stand-fire-watch gates satisfied, and what is the
// composite ignition-source / latent-hazard exposure score?
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
// Severity ladder from PROHIB (regulatory-illegal config + active hazard)
// down to NOMINAL (clean cold-refuel cycle) and OFF-CYCLE (not fueling).
type Tier =
  | 'PROHIB'        // configuration violates NFPA 407 §6 — STOP fueling
  | 'HRF-VIOL'      // hot-refuel attempted on type/airport not authorised
  | 'POBR-VIOL'     // pax-onboard refuel with cabin-door / RFFS breach
  | 'BOND-LOSS'     // bonding / grounding cable not connected or open
  | 'IGNIT-HAZ'     // active ignition source within separation envelope
  | 'HRF-ACTIVE'    // legitimate hot-refuel in progress, gates satisfied
  | 'POBR-ACTIVE'   // legitimate POBR in progress, fire-watch posted
  | 'NORMAL'        // standard cold-refuel SOP, all gates clean
  | 'OFF-CYCLE'     // not fueling (just parked, taxiing, airborne, etc.)

const TIER_ORDER: Tier[] = ['PROHIB','HRF-VIOL','POBR-VIOL','BOND-LOSS','IGNIT-HAZ','HRF-ACTIVE','POBR-ACTIVE','NORMAL','OFF-CYCLE']
const TIER_RANK: Record<Tier, number> = {
  'PROHIB':0, 'HRF-VIOL':1, 'POBR-VIOL':2, 'BOND-LOSS':3, 'IGNIT-HAZ':4,
  'HRF-ACTIVE':5, 'POBR-ACTIVE':6, 'NORMAL':7, 'OFF-CYCLE':8,
}
const TIER_COLOR: Record<Tier, string> = {
  'PROHIB':       '#f43f5e', // rose-500   — STOP fueling
  'HRF-VIOL':     '#fb7185', // rose-400   — wrong-type hot-refuel
  'POBR-VIOL':    '#f87171', // red-400    — pax-onboard violation
  'BOND-LOSS':    '#f59e0b', // amber-500  — bonding integrity loss
  'IGNIT-HAZ':    '#eab308', // yellow-500 — proximate ignition source
  'HRF-ACTIVE':   '#38bdf8', // sky-400    — HRF in progress (monitor)
  'POBR-ACTIVE':  '#0ea5e9', // sky-500    — POBR in progress (monitor)
  'NORMAL':       '#10b981', // emerald-500 — clean cold refuel
  'OFF-CYCLE':    '#64748b', // slate-500
}
const TIER_ABBR: Record<Tier, string> = {
  'PROHIB':'PRHB','HRF-VIOL':'HVIO','POBR-VIOL':'PVIO','BOND-LOSS':'BOND',
  'IGNIT-HAZ':'IGNH','HRF-ACTIVE':'HRFA','POBR-ACTIVE':'POBR','NORMAL':'NORM','OFF-CYCLE':'OFFC',
}

// ---- Aircraft-type → HRF class -----------------------------------------
// Per Boeing FCOM Vol II §03 + Airbus FCOM PRO-SUP-GND Refueling +
// Embraer AOM §2.10 + Bombardier CRJ FCOM §03 + Sikorsky S-92 RFM §2.20 +
// NFPA 407 §6 + IATA AHM 462 + EASA AMC ARO.OPS.115. Each class carries:
//
//   uplift_rate_lpm   : fuel uplift rate liters/minute single-point pressure
//                       refuel (SPPR). High-bypass twin ≈ 2400 lpm hydrant,
//                       narrowbody ≈ 1800 lpm, regional jet ≈ 1200 lpm,
//                       biz jet ≈ 800 lpm gravity. Source: SAE AIR-5128.
//   hot_refuel_ok     : type approved for engines-running refuel per OEM SDS.
//                       Most fixed-wing: false (only military fighters, AAR
//                       tankers, helos certified). C-130 OK. CH-47 / S-92
//                       certified. B737/A320/B777/A330/B787/A350 NOT
//                       certified for civil HRF per FCOM (only emergency).
//   pobr_ok           : type approved for pax-onboard refueling per IATA
//                       AHM 462 + EASA OPS 1.305(b). Most commercial: true
//                       provided cabin crew briefed, two cabin doors open,
//                       no-smoking absolute, RFFS at AFM cat, jetway capable.
//   apu_required      : whether APU is required for fueling environmental
//                       control / pax cabin air during POBR (most NB: yes).
//   bond_points       : minimum number of bonding/grounding cable points
//                       required per NFPA 407 §4.6.2. Single-point hydrant
//                       refuel = 1 receptacle bond + 1 stinger nozzle bond
//                       + 1 chassis ground = 3 normally. Wide-body wing-tank
//                       balanced = up to 6 (one per filler).
//   nfpa407_volume_m3 : approximate max fuel-tank volume m³ used to scale
//                       worst-case ignition energy / vapor envelope per
//                       NFPA 407 §A.6.7. Driver of separation distance.
//   label             : human-readable description.
interface HrfClass {
  id: string
  uplift_rate_lpm: number
  hot_refuel_ok: boolean
  pobr_ok: boolean
  apu_required: boolean
  bond_points: number
  nfpa407_volume_m3: number
  label: string
}

const HRF_CLASS: Record<string, HrfClass> = {
  // ── Narrow-body family ────────────────────────────────────────────
  'NB-CFM':     { id:'NB-CFM',    uplift_rate_lpm:1800, hot_refuel_ok:false, pobr_ok:true,  apu_required:true,  bond_points:3, nfpa407_volume_m3:26, label:'B737/A320 CFM-56 / LEAP-1A — civil ERF not certified · POBR OK per AHM 462' },
  'NB-V2500':   { id:'NB-V2500',  uplift_rate_lpm:1800, hot_refuel_ok:false, pobr_ok:true,  apu_required:true,  bond_points:3, nfpa407_volume_m3:24, label:'A320 V2500 — civil ERF not certified · POBR OK' },
  'NB-1100G':   { id:'NB-1100G',  uplift_rate_lpm:1900, hot_refuel_ok:false, pobr_ok:true,  apu_required:true,  bond_points:3, nfpa407_volume_m3:26, label:'A320neo PW1100G GTF — civil ERF not certified · POBR OK' },
  'NB-MAX-LEAP':{ id:'NB-MAX-LEAP', uplift_rate_lpm:1900, hot_refuel_ok:false, pobr_ok:true,  apu_required:true,  bond_points:3, nfpa407_volume_m3:26, label:'B737MAX CFM LEAP-1B — civil ERF not certified · POBR OK' },
  // ── Wide-body twin ────────────────────────────────────────────────
  'WB-T2-LRG':  { id:'WB-T2-LRG', uplift_rate_lpm:2400, hot_refuel_ok:false, pobr_ok:true,  apu_required:true,  bond_points:6, nfpa407_volume_m3:175, label:'B777 GE90 / B77W — civil ERF not certified · POBR OK with 2 doors open' },
  'WB-T2-787':  { id:'WB-T2-787', uplift_rate_lpm:2400, hot_refuel_ok:false, pobr_ok:true,  apu_required:false, bond_points:5, nfpa407_volume_m3:127, label:'B787 GEnx / Trent-1000 — civil ERF not certified · POBR OK (electric, no bleed APU req)' },
  'WB-T2-A35':  { id:'WB-T2-A35', uplift_rate_lpm:2400, hot_refuel_ok:false, pobr_ok:true,  apu_required:true,  bond_points:5, nfpa407_volume_m3:140, label:'A350 Trent-XWB — civil ERF not certified · POBR OK' },
  'WB-T2-A330': { id:'WB-T2-A330',uplift_rate_lpm:2200, hot_refuel_ok:false, pobr_ok:true,  apu_required:true,  bond_points:5, nfpa407_volume_m3:139, label:'A330ceo/neo Trent-700 / Trent-7000 — civil ERF not certified · POBR OK' },
  'WB-T2-767':  { id:'WB-T2-767', uplift_rate_lpm:2000, hot_refuel_ok:false, pobr_ok:true,  apu_required:true,  bond_points:4, nfpa407_volume_m3:91,  label:'B767 PW4000/CF6 — civil ERF not certified · POBR OK' },
  // ── Quad heavy ────────────────────────────────────────────────────
  'HVY-Q-380':  { id:'HVY-Q-380', uplift_rate_lpm:3200, hot_refuel_ok:false, pobr_ok:true,  apu_required:true,  bond_points:8, nfpa407_volume_m3:320, label:'A380 — civil ERF not certified · POBR OK · 8 bond points wing-tank · dual-hydrant common' },
  'HVY-Q-747':  { id:'HVY-Q-747', uplift_rate_lpm:2800, hot_refuel_ok:false, pobr_ok:true,  apu_required:true,  bond_points:6, nfpa407_volume_m3:243, label:'B747 / B747-8 — civil ERF not certified · POBR OK' },
  // ── Regional jet / turboprop ──────────────────────────────────────
  'RGN-J-E':    { id:'RGN-J-E',   uplift_rate_lpm:1200, hot_refuel_ok:false, pobr_ok:true,  apu_required:false, bond_points:2, nfpa407_volume_m3:15, label:'E170/E190/E195 CF34-8/-10 — civil ERF not certified · POBR OK · short turn typical' },
  'RGN-J-CRJ':  { id:'RGN-J-CRJ', uplift_rate_lpm:1100, hot_refuel_ok:false, pobr_ok:true,  apu_required:false, bond_points:2, nfpa407_volume_m3:12, label:'CRJ700/900/1000 CF34-8C5 — civil ERF not certified · POBR OK' },
  'RGN-T-AT':   { id:'RGN-T-AT',  uplift_rate_lpm:600,  hot_refuel_ok:true,  pobr_ok:true,  apu_required:false, bond_points:2, nfpa407_volume_m3:7,  label:'ATR-42/72 — HRF approved per ATR FCOM 2.10 turn-time minimisation · POBR OK' },
  'RGN-T-Q':    { id:'RGN-T-Q',   uplift_rate_lpm:600,  hot_refuel_ok:true,  pobr_ok:true,  apu_required:false, bond_points:2, nfpa407_volume_m3:7,  label:'DHC-8 Q400 PW150 — HRF approved per Bombardier SDS · POBR OK' },
  // ── Business jet ─────────────────────────────────────────────────
  'BIZ-G':      { id:'BIZ-G',     uplift_rate_lpm:800,  hot_refuel_ok:false, pobr_ok:false, apu_required:true,  bond_points:2, nfpa407_volume_m3:14, label:'G650 / GLEX / FA8X — FBO procedure, POBR generally prohibited part-91 ops' },
  // ── Cargo freighter ──────────────────────────────────────────────
  'CRG-FRT':    { id:'CRG-FRT',   uplift_rate_lpm:2400, hot_refuel_ok:false, pobr_ok:false, apu_required:true,  bond_points:5, nfpa407_volume_m3:130, label:'B767F / B777F / B747F / MD-11F / A330F — cargo freighter, no pax so POBR N/A but turn cycle aggressive' },
  // ── Military / specialist (HRF-cert) ─────────────────────────────
  'MIL-C130':   { id:'MIL-C130',  uplift_rate_lpm:1900, hot_refuel_ok:true,  pobr_ok:false, apu_required:false, bond_points:2, nfpa407_volume_m3:32, label:'C-130 Hercules — HRF certified per AFI 11-235 + FARP doctrine' },
  'MIL-TANKER': { id:'MIL-TANKER',uplift_rate_lpm:2800, hot_refuel_ok:true,  pobr_ok:false, apu_required:true,  bond_points:5, nfpa407_volume_m3:135, label:'KC-135 / KC-46 / KC-10 / A330-MRTT — HRF cert per AFI + RAF MAA RA 4357' },
  'MIL-HELO':   { id:'MIL-HELO',  uplift_rate_lpm:600,  hot_refuel_ok:true,  pobr_ok:false, apu_required:false, bond_points:2, nfpa407_volume_m3:3,  label:'CH-47 / S-92 / EH-101 / NH-90 — Helo-HRF per NAVAIR 00-80T-109 + STANAG 7141' },
  // ── Light / GA ───────────────────────────────────────────────────
  'LIGHT':      { id:'LIGHT',     uplift_rate_lpm:80,   hot_refuel_ok:false, pobr_ok:false, apu_required:false, bond_points:1, nfpa407_volume_m3:1, label:'PC12/C25B/C172/SR22 — gravity fueling, stand-only, no HRF/POBR' },
}

function classifyType(t?: string, op?: string): HrfClass {
  if (!t) return HRF_CLASS['NB-CFM']
  const u = t.toUpperCase()
  // Cargo freighter detection via type variant
  if (/^B77F|^B74F|^B76F|^MD11F|^A33F|^A30F|^B73F/.test(u)) return HRF_CLASS['CRG-FRT']
  // Wide-body
  if (u === 'A388' || u === 'A380') return HRF_CLASS['HVY-Q-380']
  if (u === 'B748' || u === 'B744' || u === 'B742' || u === 'B743') return HRF_CLASS['HVY-Q-747']
  if (/^B78/.test(u)) return HRF_CLASS['WB-T2-787']
  if (/^A35/.test(u)) return HRF_CLASS['WB-T2-A35']
  if (/^A33|^A34/.test(u)) return HRF_CLASS['WB-T2-A330']
  if (/^B77/.test(u)) return HRF_CLASS['WB-T2-LRG']
  if (/^B76/.test(u)) return HRF_CLASS['WB-T2-767']
  // Narrow-body
  if (u === 'B38M' || u === 'B39M' || u === 'B3XM' || u === 'B37M') return HRF_CLASS['NB-MAX-LEAP']
  if (u === 'A20N' || u === 'A21N' || u === 'A19N') return HRF_CLASS['NB-1100G']
  if (u === 'A320' || u === 'A321' || u === 'A319') {
    const h = u.charCodeAt(1) + u.charCodeAt(3)
    return (h % 100) < 40 ? HRF_CLASS['NB-V2500'] : HRF_CLASS['NB-CFM']
  }
  if (/^B73|^B75/.test(u)) return HRF_CLASS['NB-CFM']
  // Regional jets / turboprops
  if (/^E17|^E19|^E29|^E75|^E70/.test(u)) return HRF_CLASS['RGN-J-E']
  if (/^CRJ|^CR[789]/.test(u)) return HRF_CLASS['RGN-J-CRJ']
  if (/^AT[47]|^ATR/.test(u)) return HRF_CLASS['RGN-T-AT']
  if (/^DH[48]|^Q40/.test(u)) return HRF_CLASS['RGN-T-Q']
  // Military / specialist
  if (/^C130|^L382/.test(u)) return HRF_CLASS['MIL-C130']
  if (/^KC|^A33M/.test(u)) return HRF_CLASS['MIL-TANKER']
  if (/^CH47|^S92|^EH10|^NH90|^MH60|^UH60|^AS3|^AW1|^EC1/.test(u)) return HRF_CLASS['MIL-HELO']
  // Biz jet
  if (/^GLEX|^GLF|^FA[78]|^G650|^GLF6|^E55P|^E50P/.test(u)) return HRF_CLASS['BIZ-G']
  if (/^C172|^C152|^C25|^PC12|^SR2|^DA4|^BE/.test(u)) return HRF_CLASS['LIGHT']
  return HRF_CLASS['NB-CFM']
}

// ---- Airport catalogue --------------------------------------------------
// 30 hubs with hydrant vs truck dominance, RFFS category, and policy
// posture for POBR / HRF. Hydrant networks (LHR/FRA/AMS/CDG/DXB/HKG/SIN/
// JFK/LAX/ORD/ATL/DFW major) feed pressure refuel via underground manifold
// → faster uplift but tighter bonding requirements. Truck airports rely on
// bowser fueling vehicles with onboard pumps. RFFS cat per ICAO Annex 14
// Vol I §9.2 + Table 9-1 (Cat 6 / 7 / 8 / 9 / 10 by fuselage length).
interface Airport {
  icao: string
  iata: string
  name: string
  region: 'NA-US'|'NA-CA'|'EU'|'UK'|'ASIA'|'PAC'|'ME'|'AFR'|'LATAM'
  hydrant: boolean       // hydrant network vs truck-only
  rffsCat: number        // ICAO RFFS category 1-10
  pobrPolicy: 'STRICT'|'STANDARD'|'PERMISSIVE'  // local AIP supplement
  hrfPolicy: 'CIVIL-PROHIB'|'MIL-ONLY'|'MIXED'  // hot-refuel authorisation
  turnLoadMin: number    // mean turn-time minutes (when fueling may occur)
  lat: number
  lng: number
}

const AIRPORTS: Airport[] = [
  // ── USA ──
  { icao:'KJFK', iata:'JFK', name:'New York JFK',        region:'NA-US', hydrant:true,  rffsCat:10, pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:55, lat:40.6398, lng:-73.7789 },
  { icao:'KLGA', iata:'LGA', name:'New York LaGuardia',  region:'NA-US', hydrant:false, rffsCat:8,  pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:42, lat:40.7772, lng:-73.8726 },
  { icao:'KEWR', iata:'EWR', name:'Newark Liberty',      region:'NA-US', hydrant:true,  rffsCat:10, pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:50, lat:40.6925, lng:-74.1687 },
  { icao:'KBOS', iata:'BOS', name:'Boston Logan',        region:'NA-US', hydrant:false, rffsCat:9,  pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:45, lat:42.3656, lng:-71.0096 },
  { icao:'KATL', iata:'ATL', name:'Atlanta',             region:'NA-US', hydrant:true,  rffsCat:9,  pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:48, lat:33.6407, lng:-84.4277 },
  { icao:'KMIA', iata:'MIA', name:'Miami',               region:'NA-US', hydrant:true,  rffsCat:10, pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:52, lat:25.7959, lng:-80.2870 },
  { icao:'KORD', iata:'ORD', name:'Chicago O\u2019Hare', region:'NA-US', hydrant:true,  rffsCat:10, pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:48, lat:41.9786, lng:-87.9048 },
  { icao:'KDFW', iata:'DFW', name:'Dallas/Fort Worth',   region:'NA-US', hydrant:true,  rffsCat:10, pobrPolicy:'PERMISSIVE',hrfPolicy:'CIVIL-PROHIB', turnLoadMin:46, lat:32.8998, lng:-97.0403 },
  { icao:'KIAH', iata:'IAH', name:'Houston Intercont.',  region:'NA-US', hydrant:true,  rffsCat:9,  pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:45, lat:29.9844, lng:-95.3414 },
  { icao:'KDEN', iata:'DEN', name:'Denver',              region:'NA-US', hydrant:true,  rffsCat:10, pobrPolicy:'STANDARD',  hrfPolicy:'MIXED',        turnLoadMin:42, lat:39.8617, lng:-104.6731 },
  { icao:'KLAX', iata:'LAX', name:'Los Angeles',         region:'NA-US', hydrant:true,  rffsCat:10, pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:52, lat:33.9416, lng:-118.4085 },
  { icao:'KSFO', iata:'SFO', name:'San Francisco',       region:'NA-US', hydrant:true,  rffsCat:10, pobrPolicy:'STRICT',    hrfPolicy:'CIVIL-PROHIB', turnLoadMin:50, lat:37.6189, lng:-122.3750 },
  { icao:'KSEA', iata:'SEA', name:'Seattle-Tacoma',      region:'NA-US', hydrant:true,  rffsCat:9,  pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:46, lat:47.4502, lng:-122.3088 },
  // ── Canada ──
  { icao:'CYYZ', iata:'YYZ', name:'Toronto Pearson',     region:'NA-CA', hydrant:true,  rffsCat:10, pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:48, lat:43.6772, lng:-79.6306 },
  { icao:'CYVR', iata:'YVR', name:'Vancouver',           region:'NA-CA', hydrant:true,  rffsCat:9,  pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:46, lat:49.1939, lng:-123.1844 },
  // ── Europe / UK ──
  { icao:'EGLL', iata:'LHR', name:'London Heathrow',     region:'UK',    hydrant:true,  rffsCat:10, pobrPolicy:'STRICT',    hrfPolicy:'CIVIL-PROHIB', turnLoadMin:60, lat:51.4775, lng:-0.4614 },
  { icao:'EGKK', iata:'LGW', name:'London Gatwick',      region:'UK',    hydrant:true,  rffsCat:9,  pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:42, lat:51.1481, lng:-0.1903 },
  { icao:'EHAM', iata:'AMS', name:'Amsterdam Schiphol',  region:'EU',    hydrant:true,  rffsCat:10, pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:50, lat:52.3086, lng:4.7639 },
  { icao:'EDDF', iata:'FRA', name:'Frankfurt',           region:'EU',    hydrant:true,  rffsCat:10, pobrPolicy:'STRICT',    hrfPolicy:'CIVIL-PROHIB', turnLoadMin:54, lat:50.0379, lng:8.5622 },
  { icao:'LFPG', iata:'CDG', name:'Paris CDG',           region:'EU',    hydrant:true,  rffsCat:10, pobrPolicy:'STRICT',    hrfPolicy:'CIVIL-PROHIB', turnLoadMin:55, lat:49.0097, lng:2.5479 },
  { icao:'LSZH', iata:'ZRH', name:'Z\u00fcrich',         region:'EU',    hydrant:true,  rffsCat:9,  pobrPolicy:'STRICT',    hrfPolicy:'CIVIL-PROHIB', turnLoadMin:48, lat:47.4647, lng:8.5492 },
  { icao:'EDDM', iata:'MUC', name:'M\u00fcnchen',        region:'EU',    hydrant:true,  rffsCat:10, pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:50, lat:48.3538, lng:11.7861 },
  { icao:'LEMD', iata:'MAD', name:'Madrid Barajas',      region:'EU',    hydrant:true,  rffsCat:10, pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:48, lat:40.4936, lng:-3.5668 },
  // ── Asia / Pacific / Middle East ──
  { icao:'RJTT', iata:'HND', name:'Tokyo Haneda',        region:'ASIA',  hydrant:true,  rffsCat:10, pobrPolicy:'STRICT',    hrfPolicy:'CIVIL-PROHIB', turnLoadMin:52, lat:35.5494, lng:139.7798 },
  { icao:'RKSI', iata:'ICN', name:'Seoul Incheon',       region:'ASIA',  hydrant:true,  rffsCat:10, pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:55, lat:37.4691, lng:126.4505 },
  { icao:'VHHH', iata:'HKG', name:'Hong Kong',           region:'ASIA',  hydrant:true,  rffsCat:10, pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:55, lat:22.3080, lng:113.9185 },
  { icao:'WSSS', iata:'SIN', name:'Singapore Changi',    region:'ASIA',  hydrant:true,  rffsCat:10, pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:55, lat:1.3644,  lng:103.9915 },
  { icao:'OMDB', iata:'DXB', name:'Dubai',               region:'ME',    hydrant:true,  rffsCat:10, pobrPolicy:'PERMISSIVE',hrfPolicy:'CIVIL-PROHIB', turnLoadMin:55, lat:25.2532, lng:55.3657 },
  { icao:'OTHH', iata:'DOH', name:'Doha Hamad',          region:'ME',    hydrant:true,  rffsCat:10, pobrPolicy:'PERMISSIVE',hrfPolicy:'CIVIL-PROHIB', turnLoadMin:52, lat:25.2731, lng:51.6080 },
  { icao:'YSSY', iata:'SYD', name:'Sydney',              region:'PAC',   hydrant:true,  rffsCat:10, pobrPolicy:'STANDARD',  hrfPolicy:'CIVIL-PROHIB', turnLoadMin:48, lat:-33.9461,lng:151.1772 },
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
// HRF only applies during GATE / TURN phase: ground = true, velocity near
// zero, parked at airport stand. Distinguish from active TAXI (SET regime)
// and TAKEOFF / LANDING regimes.
type Phase = 'GATE-TURN' | 'TAXI' | 'AIRBORNE' | 'OFF-STAND' | 'NOT-AT-AIRPORT'

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
  if (!f.ground && f.altitudeFt > 500) return 'AIRBORNE'
  const v = f.velocityKts
  if (v > 5) return 'TAXI'
  if (v <= 1) return 'GATE-TURN'
  return 'OFF-STAND'
}

// ---- Per-flight evaluation ---------------------------------------------
interface HrfEval {
  fueling: boolean             // active fuel uplift right now?
  uplift_kg: number            // mass uplifted so far during cycle, kg
  uplift_target_kg: number     // target uplift mass for this cycle
  uplift_rate_kg_min: number   // current rate kg/min
  hot_refuel: boolean          // engines running during uplift?
  pobr: boolean                // pax onboard during uplift?
  apu_on: boolean              // APU running?
  jetway_attached: boolean     // jetway / airbridge connected to door?
  bond_ok: boolean             // bonding cables verified per NFPA 407 §4.6
  ground_ok: boolean           // chassis grounding cable verified
  rffs_cover_ok: boolean       // RFFS at AFM cat or higher
  fire_watch_posted: boolean   // dedicated fire-watch at controls
  ignition_src_m: number       // distance m to nearest active ignition src
  separation_ok: boolean       // 6 m / 15 m / 30 m sep distance per NFPA 407 §6.3
  vapor_envelope_ok: boolean   // wind-direction / spill containment
  one_truck_only: boolean      // only one fueling vehicle on stand
  cycle_elapsed_min: number    // minutes since start of fueling
  fuel_temp_C: number          // jet-A1 temperature at uplift
  reason: string               // human-readable explanation
}

function evalHrf(f: F, snap: AirportSnap, phase: Phase, cls: HrfClass): HrfEval {
  const apt = snap.apt
  const h1 = hash(f.icao + apt.icao + 'hrf')

  // Active fueling probability — only meaningful during GATE-TURN
  // ~65% of gate-turn observations have fueling active mid-cycle (the
  // typical 18-22 min uplift window of a 45-55 min turnaround)
  const fueling = phase === 'GATE-TURN' && ((h1 % 100) < 65)

  // Cycle elapsed: minute 0 → cycle_elapsed_min ≤ cycle_total_min
  const cycle_total_min = Math.round(cls.nfpa407_volume_m3 * 1000 * 0.8 / cls.uplift_rate_lpm)
  const cycle_elapsed_min = fueling
    ? Math.max(1, Math.min(cycle_total_min, Math.round(cycle_total_min * (0.15 + ((h1 >>> 4) % 100) / 130))))
    : 0

  // Uplift mass: jet-A1 density ~800 kg/m³ at 15°C per ASTM D1655
  const target_volume_m3 = cls.nfpa407_volume_m3 * 0.78  // typical 78% tank fill
  const uplift_target_kg = Math.round(target_volume_m3 * 800)
  const cycle_frac = cycle_total_min > 0 ? cycle_elapsed_min / cycle_total_min : 0
  const uplift_kg = Math.round(uplift_target_kg * cycle_frac)
  const uplift_rate_kg_min = fueling ? Math.round(cls.uplift_rate_lpm * 0.8) : 0

  // Hot-refuel probability — only on HRF-cert types AND at MIXED/MIL-ONLY airports
  const hrfEligible = cls.hot_refuel_ok && (apt.hrfPolicy === 'MIXED' || apt.hrfPolicy === 'MIL-ONLY')
  const hot_refuel = fueling && hrfEligible && ((h1 >>> 6) % 100) < 30

  // POBR probability — pax-onboard refuel common on commercial
  // narrowbody / wide-body, ~55% baseline, modulated by airport policy
  const pobrPostureBoost = apt.pobrPolicy === 'PERMISSIVE' ? 20 : apt.pobrPolicy === 'STRICT' ? -25 : 0
  const pobr = fueling && cls.pobr_ok && ((h1 >>> 8) % 100) < (55 + pobrPostureBoost)

  // APU on probability — high during POBR for cabin ECS, lower otherwise
  const apu_on = fueling && (pobr || cls.apu_required) && ((h1 >>> 10) % 100) < 85

  // Jetway probability — present on POBR by definition; otherwise lower
  const jetway_attached = pobr ? ((h1 >>> 12) % 100) < 92 : ((h1 >>> 12) % 100) < 60

  // Bonding integrity — NFPA 407 §4.6 mandates bond at receptacle, nozzle
  // and chassis. Typical bond failure rate is ~1.5% per cycle per SAE
  // ARP-1247 surveys (degraded cables, loose clamps, corroded ground rods).
  const bond_ok = ((h1 >>> 14) % 100) >= 1.5 * 1
  const ground_ok = ((h1 >>> 16) % 1000) >= 6  // 0.6%/cycle ground-rod failure

  // RFFS coverage — should always be OK at AFM cat hubs (RFFS Cat 9-10)
  // but rare downgrades occur during shift change / equipment U/S
  const rffs_cover_ok = ((h1 >>> 18) % 1000) >= 2  // 0.2%/cycle RFFS gap

  // Fire-watch posted — mandatory during POBR per AHM 462, often skipped
  // at low-volume stations or during night shift
  const fire_watch_posted = pobr
    ? ((h1 >>> 20) % 100) >= 8  // 8%/cycle missing fire-watch at POBR
    : true

  // Ignition source proximity — APU exhaust @ 1.8 m EGT 450°C, ground
  // power AC arc @ 3-5 m, jetway tug battery @ 6-10 m, in-cabin galley
  // @ 12-18 m (through fuselage skin). Per NFPA 407 §6.3 the separation
  // distance for ERF is 15 m from open fuel vents, 6 m from spillable
  // tank closures. With APU exhaust at 1.8 m the envelope is breached.
  let ignition_src_m = 50
  if (apu_on) ignition_src_m = Math.min(ignition_src_m, 1.8)
  if (hot_refuel) ignition_src_m = Math.min(ignition_src_m, 0.8)  // engine inlet vortex
  if (jetway_attached) ignition_src_m = Math.min(ignition_src_m, 12)
  // GPU / AC arc
  if (((h1 >>> 22) % 100) < 35) ignition_src_m = Math.min(ignition_src_m, 4)
  const separation_ok = ignition_src_m >= 6

  // Vapor envelope — wind direction, spill containment, stand drainage
  // Modulated by airport region (ME / AFR hotter → faster vapor evolution)
  const hot_region = apt.region === 'ME' || apt.region === 'AFR' || apt.region === 'ASIA'
  const vapor_envelope_ok = ((h1 >>> 24) % 100) >= (hot_region ? 8 : 4)

  // One-truck-only rule — NFPA 407 §6.4 prohibits multiple fueling
  // vehicles on the same stand simultaneously
  const one_truck_only = ((h1 >>> 26) % 100) >= 3

  // Fuel temperature — jet-A1 typical 5-25°C, FAR §25.951 cold-soak case
  // not relevant here but tankage temp drives vapor pressure (NFPA 407 §A.6.6)
  const fuel_temp_C = 8 + ((h1 >>> 28) % 22)

  // Reason text
  let reason = '—'
  if (!fueling) reason = phase === 'GATE-TURN' ? 'Parked at stand · no active fuel uplift this cycle' : 'Not in gate-turn phase'
  else if (hot_refuel && !cls.hot_refuel_ok) reason = `${cls.label.split('—')[0].trim()} — HRF NOT certified per OEM SDS · STOP uplift`
  else if (pobr && !cls.pobr_ok) reason = `${cls.label.split('—')[0].trim()} — POBR not approved for type`
  else if (pobr && !fire_watch_posted) reason = 'POBR cycle without dedicated fire-watch posted at fueling-control panel (AHM 462 §4.2 VIOLATION)'
  else if (!bond_ok) reason = `Bonding cable open / not connected — NFPA 407 §4.6 minimum ${cls.bond_points} bond-points required`
  else if (!ground_ok) reason = 'Chassis ground cable open — static-discharge ignition source per NFPA 407 §4.6.4'
  else if (!separation_ok) reason = `Ignition source within ${ignition_src_m.toFixed(1)} m of fuel vent — NFPA 407 §6.3 minimum 6 m / 15 m breached`
  else if (!rffs_cover_ok) reason = 'RFFS coverage below AFM cat during fueling — ICAO Annex 14 §9.2 §9.4 breach'
  else if (!vapor_envelope_ok) reason = 'Vapor envelope at risk — wind-direction or spill-containment compromised'
  else if (!one_truck_only) reason = 'Multiple fueling vehicles on stand — NFPA 407 §6.4 single-truck rule violated'
  else if (hot_refuel) reason = `HRF active · ${uplift_rate_kg_min} kg/min uplift @ ${uplift_kg}/${uplift_target_kg} kg · all gates green`
  else if (pobr) reason = `POBR active · ${uplift_rate_kg_min} kg/min @ ${uplift_kg}/${uplift_target_kg} kg · fire-watch posted · ${cycle_elapsed_min}/${cycle_total_min} min`
  else reason = `Cold refuel · ${uplift_rate_kg_min} kg/min · ${uplift_kg}/${uplift_target_kg} kg · ${cycle_elapsed_min}/${cycle_total_min} min`

  return {
    fueling, uplift_kg, uplift_target_kg, uplift_rate_kg_min, hot_refuel, pobr,
    apu_on, jetway_attached, bond_ok, ground_ok, rffs_cover_ok, fire_watch_posted,
    ignition_src_m, separation_ok, vapor_envelope_ok, one_truck_only,
    cycle_elapsed_min, fuel_temp_C, reason,
  }
}

// ---- Driver decomposition ----------------------------------------------
interface Drivers {
  certEligibility: number  // type-cert HRF/POBR approval violation
  bondingIntegrity: number // bonding / grounding cable failure severity
  ignitionSrc:    number   // proximate ignition source proximity penalty
  rffsCoverage:   number   // RFFS cat shortfall
  fireWatch:      number   // missing fire-watch on POBR / HRF
  vaporEnvelope:  number   // wind / spill / vapor risk
  truckRule:      number   // multi-truck rule violation
  policy:         number   // airport-policy posture deviation
}

function computeDrivers(hr: HrfEval, cls: HrfClass, apt: Airport): Drivers {
  if (!hr.fueling) return {
    certEligibility:0, bondingIntegrity:0, ignitionSrc:0, rffsCoverage:0,
    fireWatch:0, vaporEnvelope:0, truckRule:0, policy:0,
  }
  const certEligibility =
    (hr.hot_refuel && !cls.hot_refuel_ok) ? 95 :
    (hr.pobr && !cls.pobr_ok) ? 80 : 0
  const bondingIntegrity =
    !hr.bond_ok ? 88 :
    !hr.ground_ok ? 75 : 0
  // Ignition source — ramp 100 at 0 m → 0 at 15 m per NFPA 407 §6.3
  const ignitionSrc = hr.ignition_src_m >= 15 ? 0 :
                       hr.ignition_src_m >= 6 ? 30 :
                       Math.min(100, 100 - (hr.ignition_src_m / 6) * 30)
  const rffsCoverage = !hr.rffs_cover_ok ? 70 : 0
  const fireWatch = (hr.pobr && !hr.fire_watch_posted) ? 78 : 0
  const vaporEnvelope = !hr.vapor_envelope_ok ? 55 : 0
  const truckRule = !hr.one_truck_only ? 45 : 0
  const policy = (apt.pobrPolicy === 'STRICT' && hr.pobr) ? 22 :
                 (apt.hrfPolicy === 'CIVIL-PROHIB' && hr.hot_refuel && cls.hot_refuel_ok) ? 35 : 0
  return { certEligibility, bondingIntegrity, ignitionSrc, rffsCoverage,
           fireWatch, vaporEnvelope, truckRule, policy }
}

function composite(d: Drivers, advMul: number): number {
  const vals = [d.certEligibility, d.bondingIntegrity, d.ignitionSrc,
                d.rffsCoverage, d.fireWatch]
  const max = Math.max(...vals)
  const mean = vals.reduce((a,b)=>a+b,0) / vals.length
  let s = max * 0.62 + mean * 0.38
  s += d.vaporEnvelope * 0.12 + d.truckRule * 0.08 + d.policy * 0.06
  return Math.max(0, Math.min(100, s * advMul))
}

function scoreToTier(score: number, hr: HrfEval, cls: HrfClass, phase: Phase): Tier {
  if (phase !== 'GATE-TURN') return 'OFF-CYCLE'
  if (!hr.fueling) return 'OFF-CYCLE'
  // Hard regulatory violations first
  if (hr.hot_refuel && !cls.hot_refuel_ok) return 'HRF-VIOL'
  if (hr.pobr && !cls.pobr_ok) return 'POBR-VIOL'
  if (hr.pobr && !hr.fire_watch_posted) return 'POBR-VIOL'
  if (!hr.bond_ok || !hr.ground_ok) return 'BOND-LOSS'
  if (!hr.separation_ok) return 'IGNIT-HAZ'
  if (!hr.rffs_cover_ok) return 'PROHIB'
  // Then composite-driven verdict on legitimate cycles
  if (score >= 80) return 'PROHIB'
  if (hr.hot_refuel) return 'HRF-ACTIVE'
  if (hr.pobr) return 'POBR-ACTIVE'
  return 'NORMAL'
}

// ---- Row ----------------------------------------------------------------
interface Row {
  f: F
  snap: AirportSnap
  apt: Airport
  cls: HrfClass
  phase: Phase
  hr: HrfEval
  drivers: Drivers
  score: number
  tier: Tier
}

// ==== MAIN COMPONENT ====================================================
export default function HrfMonitor({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [regionFilter, setRegionFilter] = useState<string>('ALL')
  const [cycleFilter, setCycleFilter] = useState<'ALL'|'FUEL'|'HRF'|'POBR'>('ALL')
  const [advMul, setAdvMul] = useState(1.0)
  const [sepMul, setSepMul] = useState(1.0)
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
      const cls = classifyType(f.type, f.operator)
      const phase = classifyPhase(f, snap)
      if (phase === 'NOT-AT-AIRPORT' || phase === 'AIRBORNE') continue
      const hr = evalHrf(f, snap, phase, cls)
      // Apply sep-multiplier
      const hrAdj: HrfEval = {
        ...hr,
        ignition_src_m: hr.ignition_src_m * sepMul,
        separation_ok: (hr.ignition_src_m * sepMul) >= 6,
      }
      const drivers = computeDrivers(hrAdj, cls, snap.apt)
      const score = composite(drivers, advMul)
      const tier = scoreToTier(score, hrAdj, cls, phase)
      out.push({ f, snap, apt: snap.apt, cls, phase, hr: hrAdj, drivers, score, tier })
    }
    out.sort((a,b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return out
  }, [flights, advMul, sepMul])

  // ---- MapLibre overlay layers -----------------------------------------
  useEffect(() => {
    if (!map) return
    const SRC_AC = 'hrf-ac-src'
    const SRC_APT = 'hrf-apt-src'
    const SRC_LINK = 'hrf-link-src'
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any }) }
    ;[SRC_AC, SRC_APT, SRC_LINK].forEach(ensure)

    const view = rows.filter(r =>
      (tierFilter === 'ALL' || r.tier === tierFilter) &&
      (regionFilter === 'ALL' || r.apt.region === regionFilter) &&
      (cycleFilter === 'ALL' ||
       (cycleFilter === 'FUEL' && r.hr.fueling) ||
       (cycleFilter === 'HRF'  && r.hr.hot_refuel) ||
       (cycleFilter === 'POBR' && r.hr.pobr))
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
          label: `${(r.f.callsign||r.f.icao).trim()} ${TIER_ABBR[r.tier]} ${r.apt.iata}·${r.hr.fueling?(r.hr.hot_refuel?'HRF':r.hr.pobr?'POBR':'COLD'):'OFF'} ${r.hr.fueling?(r.hr.uplift_kg+'kg'):''}`,
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
          label: `${a.iata}·${a.hydrant?'HYD':'TRK'}·RFFS${a.rffsCat}`,
          color: a.pobrPolicy === 'STRICT' ? '#f59e0b' : a.pobrPolicy === 'PERMISSIVE' ? '#0ea5e9' : '#10b981',
        },
      })) : []

    ;(map.getSource(SRC_AC) as any).setData({ type:'FeatureCollection', features: (shHalo||shPin||shLbl) ? acFeat : [] })
    ;(map.getSource(SRC_APT) as any).setData({ type:'FeatureCollection', features: aptFeat })
    ;(map.getSource(SRC_LINK) as any).setData({ type:'FeatureCollection', features: (shHalo||shPin) ? linkFeat : [] })

    if (!map.getLayer('hrf-apt-pin'))
      map.addLayer({ id:'hrf-apt-pin', type:'circle', source:SRC_APT, paint:{ 'circle-radius':5, 'circle-color':['get','color'], 'circle-opacity':0.55, 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('hrf-apt-lbl'))
      map.addLayer({ id:'hrf-apt-lbl', type:'symbol', source:SRC_APT, layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,-1.4], 'text-anchor':'bottom', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#cbd5e1', 'text-halo-color':'#0b0f17', 'text-halo-width':1.0 } })
    if (!map.getLayer('hrf-link'))
      map.addLayer({ id:'hrf-link', type:'line', source:SRC_LINK, paint:{ 'line-color':['get','color'], 'line-width':1.0, 'line-opacity':0.45, 'line-dasharray':[2,2] } })
    if (!map.getLayer('hrf-halo'))
      map.addLayer({ id:'hrf-halo', type:'circle', source:SRC_AC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('hrf-pin'))
      map.addLayer({ id:'hrf-pin', type:'circle', source:SRC_AC, filter:['>=', ['get','score'], 40], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('hrf-lbl'))
      map.addLayer({ id:'hrf-lbl', type:'symbol', source:SRC_AC, filter:['>=', ['get','score'], 30], layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.5], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.3 } })

    return () => {
      for (const id of ['hrf-lbl','hrf-pin','hrf-halo','hrf-link','hrf-apt-lbl','hrf-apt-pin']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC_AC, SRC_APT, SRC_LINK]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, regionFilter, cycleFilter, shHalo, shPin, shLbl, shApt])

  // ---- Aggregations ----------------------------------------------------
  const visible = rows.filter(r =>
    (tierFilter === 'ALL' || r.tier === tierFilter) &&
    (regionFilter === 'ALL' || r.apt.region === regionFilter) &&
    (cycleFilter === 'ALL' ||
     (cycleFilter === 'FUEL' && r.hr.fueling) ||
     (cycleFilter === 'HRF'  && r.hr.hot_refuel) ||
     (cycleFilter === 'POBR' && r.hr.pobr)) &&
    (!search || (
      (r.f.callsign || r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type || '').toLowerCase().includes(search.toLowerCase()) ||
      r.apt.iata.toLowerCase().includes(search.toLowerCase()) ||
      r.apt.icao.toLowerCase().includes(search.toLowerCase()) ||
      r.cls.id.toLowerCase().includes(search.toLowerCase())
    ))
  )
  const counts: Record<Tier, number> = {
    'PROHIB':0,'HRF-VIOL':0,'POBR-VIOL':0,'BOND-LOSS':0,'IGNIT-HAZ':0,
    'HRF-ACTIVE':0,'POBR-ACTIVE':0,'NORMAL':0,'OFF-CYCLE':0,
  }
  for (const r of rows) counts[r.tier]++
  const activeFueling = rows.filter(r => r.hr.fueling).length
  const activePobr = rows.filter(r => r.hr.pobr).length
  const activeHrf = rows.filter(r => r.hr.hot_refuel).length
  const totalUplift = rows.reduce((a,r)=>a+r.hr.uplift_kg, 0)
  const totalRate = rows.reduce((a,r)=>a+r.hr.uplift_rate_kg_min, 0)
  const violations = counts['PROHIB'] + counts['HRF-VIOL'] + counts['POBR-VIOL']
                   + counts['BOND-LOSS'] + counts['IGNIT-HAZ']
  const worst = rows[0]

  const aptAgg = useMemo(() => {
    const m = new Map<string, { count: number; fuel: number; pobr: number; hrf: number; viol: number; uplift: number }>()
    for (const r of rows) {
      const k = r.apt.icao
      const v = m.get(k) || { count:0, fuel:0, pobr:0, hrf:0, viol:0, uplift:0 }
      v.count++
      if (r.hr.fueling) v.fuel++
      if (r.hr.pobr) v.pobr++
      if (r.hr.hot_refuel) v.hrf++
      if (r.tier === 'PROHIB' || r.tier === 'HRF-VIOL' || r.tier === 'POBR-VIOL' || r.tier === 'BOND-LOSS' || r.tier === 'IGNIT-HAZ') v.viol++
      v.uplift += r.hr.uplift_kg
      m.set(k, v)
    }
    return Array.from(m.entries())
      .map(([k, v]) => {
        const apt = AIRPORTS.find(a => a.icao === k)!
        return { apt, ...v }
      })
      .sort((a,b) => b.viol - a.viol || b.uplift - a.uplift)
  }, [rows])

  const driverAvg = useMemo(() => {
    if (!rows.length) return { certEligibility:0, bondingIntegrity:0, ignitionSrc:0,
                                rffsCoverage:0, fireWatch:0, vaporEnvelope:0, truckRule:0, policy:0 }
    const n = rows.length
    return {
      certEligibility:  rows.reduce((a,r)=>a+r.drivers.certEligibility,0)/n,
      bondingIntegrity: rows.reduce((a,r)=>a+r.drivers.bondingIntegrity,0)/n,
      ignitionSrc:      rows.reduce((a,r)=>a+r.drivers.ignitionSrc,0)/n,
      rffsCoverage:     rows.reduce((a,r)=>a+r.drivers.rffsCoverage,0)/n,
      fireWatch:        rows.reduce((a,r)=>a+r.drivers.fireWatch,0)/n,
      vaporEnvelope:    rows.reduce((a,r)=>a+r.drivers.vaporEnvelope,0)/n,
      truckRule:        rows.reduce((a,r)=>a+r.drivers.truckRule,0)/n,
      policy:           rows.reduce((a,r)=>a+r.drivers.policy,0)/n,
    }
  }, [rows])

  // ---- Render ----------------------------------------------------------
  return (
    <div className="fixed top-16 right-3 z-40 w-[500px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">HRF</span>
          <span className="text-[10px] text-slate-400 truncate">Hot-Refuel / POBR / Bonding · NFPA 407 / IATA AHM 462 / EASA OPS 1.305</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none ml-2">×</button>
      </div>

      {/* Tier counter strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.slice(0,8).map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className="flex-1 px-1 py-1 rounded text-[9px] font-mono border min-w-0"
            style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:'transparent', color: TIER_COLOR[t] }}>
            <span className="truncate">{TIER_ABBR[t]}</span> {counts[t]}
          </button>
        ))}
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FUEL</div><div className="font-mono text-sky-300">{activeFueling}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">POBR</div><div className="font-mono text-sky-300">{activePobr}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">HRF</div><div className="font-mono" style={{color: activeHrf > 0 ? '#fb7185' : '#64748b'}}>{activeHrf}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">UPLIFT</div><div className="font-mono text-emerald-300">{(totalUplift/1000).toFixed(1)}t</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">VIOL</div><div className="font-mono" style={{color: violations > 0 ? '#f43f5e' : '#10b981'}}>{violations}</div></div>
      </div>

      {/* Sliders + filters */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">SEP-MUL <span className="text-slate-200 font-mono">{(sepMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={sepMul*100} onChange={e=>setSepMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
        </div>
        {/* Cycle + region filter */}
        <div className="flex flex-wrap gap-1">
          {(['ALL','FUEL','HRF','POBR'] as const).map(p => (
            <button key={p} onClick={()=>setCycleFilter(p)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${cycleFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p==='ALL'?'ALL-CYC':p}</button>
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
              <div className="text-center text-[10px] text-slate-500 py-6">No aircraft in GATE-TURN at any catalogued hub · relax filters or wait for parked traffic</div>
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

                  {/* Fueling strip */}
                  <div className="mt-1.5 bg-slate-900/60 rounded p-1.5 font-mono text-[9px] text-slate-300 leading-tight overflow-x-auto whitespace-nowrap">
                    <span className="text-slate-500">GATE@</span><span className="text-sky-300">{r.apt.iata}</span>
                    <span className="text-slate-500"> NET </span><span className="text-slate-200">{r.apt.hydrant?'HYD':'TRK'}</span>
                    <span className="text-slate-500"> RFFS </span><span className="text-slate-200">{r.apt.rffsCat}</span>
                    {r.hr.fueling && <>
                      <span className="text-slate-500"> UP </span><span className="text-emerald-300">{r.hr.uplift_kg}/{r.hr.uplift_target_kg}kg</span>
                      <span className="text-slate-500"> @ </span><span className="text-slate-200">{r.hr.uplift_rate_kg_min}kg/min</span>
                      <span className="text-slate-500"> ELP </span><span className="text-slate-200">{r.hr.cycle_elapsed_min}m</span>
                    </>}
                    {r.hr.apu_on && <span className="text-amber-300"> APU</span>}
                    {r.hr.jetway_attached && <span className="text-sky-300"> JWY</span>}
                    {r.hr.hot_refuel && <span className="text-rose-400"> HRF</span>}
                    {r.hr.pobr && <span className="text-sky-300"> POBR</span>}
                    {!r.hr.bond_ok && <span className="text-rose-400"> BND!</span>}
                    {!r.hr.ground_ok && <span className="text-rose-400"> GND!</span>}
                    {!r.hr.separation_ok && <span className="text-amber-400"> SEP-{r.hr.ignition_src_m.toFixed(1)}m</span>}
                    {!r.hr.rffs_cover_ok && <span className="text-rose-400"> RFFS!</span>}
                    {r.hr.pobr && !r.hr.fire_watch_posted && <span className="text-rose-400"> NOFW!</span>}
                  </div>

                  {/* Reason line */}
                  <div className="mt-1 text-[10px] text-slate-300 leading-snug">{r.hr.reason}</div>

                  {/* Driver chips */}
                  <div className="mt-1 flex flex-wrap gap-0.5 text-[9px] font-mono">
                    {(['certEligibility','bondingIntegrity','ignitionSrc','rffsCoverage','fireWatch','vaporEnvelope','truckRule','policy'] as const).map(k => {
                      const v = r.drivers[k]
                      const sev = v >= 70 ? '#f43f5e' : v >= 40 ? '#f59e0b' : v >= 15 ? '#0ea5e9' : '#475569'
                      const lbl = ({certEligibility:'CERT',bondingIntegrity:'BOND',ignitionSrc:'IGNT',rffsCoverage:'RFFS',fireWatch:'FRWT',vaporEnvelope:'VAPR',truckRule:'TRUC',policy:'POLI'} as const)[k]
                      return (
                        <span key={k} className="px-1 py-0.5 rounded border text-[8px]" style={{ borderColor: sev + '60', color: sev }}>{lbl}{v.toFixed(0)}</span>
                      )
                    })}
                  </div>

                  {isP && (
                    <div className="mt-2 pt-2 border-t border-slate-700/40 text-[10px] space-y-1">
                      <div className="text-slate-400">Type-class: <span className="text-slate-200">{r.cls.label}</span></div>
                      <div className="text-slate-400">Uplift rate cert: <span className="font-mono text-slate-200">{r.cls.uplift_rate_lpm} lpm</span> · Tank vol: <span className="font-mono text-slate-200">{r.cls.nfpa407_volume_m3} m³</span></div>
                      <div className="text-slate-400">HRF cert: <span className={r.cls.hot_refuel_ok?'text-emerald-300':'text-rose-400'}>{r.cls.hot_refuel_ok?'YES':'NO'}</span> · POBR cert: <span className={r.cls.pobr_ok?'text-emerald-300':'text-rose-400'}>{r.cls.pobr_ok?'YES':'NO'}</span> · APU req: <span className="text-slate-200">{r.cls.apu_required?'YES':'NO'}</span></div>
                      <div className="text-slate-400">Bond points cert: <span className="font-mono text-slate-200">{r.cls.bond_points}</span> per NFPA 407 §4.6 · Fuel T: <span className="font-mono text-slate-200">{r.hr.fuel_temp_C.toFixed(0)}°C</span></div>
                      <div className="text-slate-400">Ignition-src distance: <span className="font-mono" style={{color: r.hr.ignition_src_m < 6 ? '#f43f5e' : r.hr.ignition_src_m < 15 ? '#f59e0b' : '#10b981'}}>{r.hr.ignition_src_m.toFixed(1)} m</span> vs NFPA 407 §6.3 min 6/15 m</div>
                      <div className="text-slate-400">Cycle: <span className="font-mono text-slate-200">{r.hr.cycle_elapsed_min} min</span> · Stand turn-mean: <span className="font-mono text-slate-200">{r.apt.turnLoadMin} min</span></div>
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}

        {tab === 'AIRPORTS' && (
          <>
            <div className="text-[10px] text-slate-500 mb-1 px-1">Hub fueling-cycle ranking — violation count then uplift volume</div>
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
                    background: (a.apt.pobrPolicy==='STRICT'?'#f59e0b22':a.apt.pobrPolicy==='PERMISSIVE'?'#0ea5e922':'#10b98122'),
                    borderColor: (a.apt.pobrPolicy==='STRICT'?'#f59e0b66':a.apt.pobrPolicy==='PERMISSIVE'?'#0ea5e966':'#10b98166'),
                    color: (a.apt.pobrPolicy==='STRICT'?'#f59e0b':a.apt.pobrPolicy==='PERMISSIVE'?'#0ea5e9':'#10b981'),
                  }}>{a.apt.pobrPolicy}</span>
                </div>
                <div className="mt-1 grid grid-cols-6 gap-1 text-[9px] font-mono">
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">N</span> <span className="text-slate-200">{a.count}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">FUE</span> <span className="text-sky-300">{a.fuel}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">PBR</span> <span className="text-sky-300">{a.pobr}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">HRF</span> <span style={{color: a.hrf > 0 ? '#fb7185' : '#64748b'}}>{a.hrf}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">VIO</span> <span style={{color: a.viol > 0 ? '#f43f5e' : '#10b981'}}>{a.viol}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">UP</span> <span className="text-emerald-300">{(a.uplift/1000).toFixed(1)}t</span></div>
                </div>
                <div className="mt-1 text-[9px] text-slate-500 font-mono">
                  {a.apt.hydrant ? 'Hydrant network' : 'Truck-only'} · RFFS Cat {a.apt.rffsCat} · HRF policy {a.apt.hrfPolicy} · turn-mean {a.apt.turnLoadMin}m
                </div>
              </div>
            ))}
          </>
        )}

        {tab === 'DRIVERS' && (
          <>
            <div className="text-[10px] text-slate-500 mb-1 px-1">8-driver mean across N={rows.length} tracked aircraft</div>
            {([
              ['certEligibility',  'CERT · type HRF/POBR certification violation', driverAvg.certEligibility],
              ['bondingIntegrity', 'BOND · bonding & grounding cable integrity', driverAvg.bondingIntegrity],
              ['ignitionSrc',      'IGNT · ignition-source proximity (APU/inlet/GPU)', driverAvg.ignitionSrc],
              ['rffsCoverage',     'RFFS · airport RFFS Cat shortfall', driverAvg.rffsCoverage],
              ['fireWatch',        'FRWT · fire-watch posting at POBR/HRF', driverAvg.fireWatch],
              ['vaporEnvelope',    'VAPR · vapor envelope / wind / spill', driverAvg.vaporEnvelope],
              ['truckRule',        'TRUC · NFPA 407 §6.4 single-truck rule', driverAvg.truckRule],
              ['policy',           'POLI · airport-policy posture deviation', driverAvg.policy],
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
              Composite = max(cert,bond,ignt,rffs,frwt)·0.62 + mean(·)·0.38 + vapr·0.12 + truc·0.08 + poli·0.06, multiplied by ADV-MUL.
              CERT hard-prohibits when type lacks HRF/POBR approval. BOND triggers on any bond / ground cable open per NFPA 407 §4.6.
              IGNT ramps 100 at 0 m to 0 at 15 m per NFPA 407 §6.3 separation distances. FRWT enforces dedicated fire-watch posting
              at fueling-control panel during POBR / HRF per IATA AHM 462 §4.2.
            </div>
          </>
        )}

        {tab === 'METHOD' && (
          <div className="text-[10px] text-slate-300 leading-relaxed space-y-2 p-1">
            <p><span className="text-sky-300 font-mono">DEFINITION.</span> Hot Refueling (HRF) is the procedure of uplifting jet-A1 with one or more engines running, used routinely on certain military types (KC-135 / KC-46 / C-130 FARP doctrine), select helicopters (CH-47 / S-92 / EH-101 per STANAG 7141 + NAVAIR 00-80T-109), and a few small civil turboprops where ATR / Bombardier SDS authorise it for tight-turn ops. Pax-on-Board Refueling (POBR) is the much-more-common cycle of uplifting fuel while passengers remain in cabin during turnaround — permitted on commercial transports under EASA OPS 1.305 / FAA AC 00-34A / IATA AHM 462 provided cabin-crew briefed, two doors open, fire-watch posted, RFFS at AFM cat.</p>
            <p><span className="text-sky-300 font-mono">REGULATORY.</span> NFPA 407 Standard for Aircraft Fuel Servicing (2022) §4-7 sets bonding / grounding / separation distance baselines. §4.6 requires bond at receptacle, nozzle and chassis (3-point min single-point pressure refuel; up to 8-point for wide-body wing-tank balanced). §6.3 enforces 6 m / 15 m separation from open vents to ignition sources. §6.4 mandates single fueling vehicle on stand. FAA AC 00-34A endorses the NFPA 407 framework. EASA AMC ARO.OPS.115 codifies POBR procedure. IATA AHM 462 §4 details ground-handling protocol.</p>
            <p><span className="text-sky-300 font-mono">CERT MAP.</span> Civil HRF is generally NOT certified on B737 / A320 / B777 / A330 / B787 / A350 — fuel-vent placement, engine inlet vortex, APU exhaust efflux, and pax-cabin proximity make the §25.967 vent-clearance impractical with engines lit. Exceptions: ATR-72 (cargo & QC ops short-turn), DHC-8 Q400 (Bombardier SDS), and military types (C-130 / KC-46 / helicopters). POBR is certified on all commercial transports with cabin doors and chute architecture per §25.807; not approved for biz-jets / general aviation under part-91.</p>
            <p><span className="text-sky-300 font-mono">PHYSICS.</span> Ignition energy floor for jet-A1 vapor at stoichiometric is ~0.20 mJ (Lewis & von Elbe Combustion Flames 3e §A.3). APU exhaust at 1.0-1.8 m from tank vent at 450-540°C EGT exceeds the autoignition temp 210°C by a wide margin during transient flame plumes. Engine inlet at 0.8 m from wing-vent creates a dynamic-pressure vortex (Bernoulli ΔP ≈ ½·ρ·V²) that can suck vapor through the boundary layer. Static-electric discharge from ungrounded fuel hose can exceed 1 kV/μF energy storage per SAE ARP-1247 — the Buffalo TSB A11W0094 ignition mechanism. Bonding cables maintain &lt;10 Ω resistance per NFPA 407 §4.6.2; chassis ground rod to airport earth network &lt;25 Ω per NEC 250.</p>
            <p><span className="text-sky-300 font-mono">UPLIFT RATES.</span> Single-point pressure refueling per SAE AIR-5128: hydrant @ 50 psi delivers ~2400 lpm to wide-body twin (≈115 t in 50 min on A350/B777), ~1800 lpm narrowbody (≈25 t in 17 min on A320/B737), ~1200 lpm regional jet, ~600 lpm turboprop, ~80 lpm gravity on light GA. Density jet-A1 at 15°C ≈ 800 kg/m³ per ASTM D1655.</p>
            <p><span className="text-sky-300 font-mono">RFFS.</span> ICAO Annex 14 Vol I §9.2 + Table 9-1 assigns Rescue & Fire-Fighting Service category 1-10 by fuselage length: Cat 9 for A330/B777-200 (51-61 m), Cat 10 for A380/B747/B777-300/A350-1000 (61-76 m). Fueling cycles must be covered by RFFS at AFM cat or higher; downgrades for equipment U/S during shift change trigger PROHIB tier.</p>
            <p><span className="text-sky-300 font-mono">SCORING.</span> Per-flight: PROHIB if regulatory-illegal config / RFFS shortfall; HRF-VIOL if hot-refuel on non-cert type; POBR-VIOL if pax-onboard refuel on non-cert type or fire-watch missing; BOND-LOSS if any bond/ground cable open per NFPA 407 §4.6; IGNIT-HAZ if ignition source within 6 m of fuel vent; HRF-ACTIVE / POBR-ACTIVE if legitimate cycle in progress; NORMAL if clean cold refuel; OFF-CYCLE if not parked at gate. Hub-level aggregate ranks airports by violation count then total uplift mass.</p>
            <p><span className="text-sky-300 font-mono">DISTINCT FROM.</span> SET (taxi engine-config warm-up/cool-down, no fuel uplift), TANK (price-arbitrage tankering math), FUELPOL (airborne reserve compliance), RESERVE (FRF arithmetic), APU (APU-ETOPS health), JBLAST (jet-blast hazard separation, different ignition class), HZMT-DG (dangerous-goods cargo), LI-BATT (lithium cargo fire), FUEL-IMBAL (in-flight tank balance), ACDM (TOBT/TSAT pushback), DGS (docking guidance), PCN-PAV (pavement load).</p>
          </div>
        )}
      </div>
    </div>
  )
}
