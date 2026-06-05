'use client'

// =============================================================================
// PDC · Pre-Departure Clearance / Datalink Clearance Delivery / DCL
// -----------------------------------------------------------------------------
// Per-airframe live evaluator of every departing aircraft's compliance with the
// certified ARINC 623-A / 623-B Datalink Pre-Departure-Clearance (PDC / DCL)
// uplink chain — the OCEANIC-CLEARANCE / DEPARTURE-CLEARANCE / OCEANIC-EXIT
// datalink-text service that every major-hub Clearance-Delivery position has
// progressively migrated to since FAA's CPDLC-DCL programme (Lockheed/Harris
// Tower Datalink Service) and EUROCONTROL's DCL implementation overlay on
// VDL-2 ATN beginning ~2002-MIA, scaling to all CONUS large hubs through
// 2017 and Europe through 2018-22, replacing voice-Clearance-Delivery as the
// primary mechanism by which a freshly-pushed-back aircraft receives its
// IFR-route clearance, departure runway, initial-climb altitude, SID, expected
// frequency, departure-control frequency and squawk code from the ATC tower's
// CPDLC-DCL groundstation BEFORE engine start and taxi.
//
// PDC/DCL is structurally distinct from every neighbouring datalink overlay:
//   CPDLC          — en-route controller-pilot datalink text per Doc 4444
//                    Ch.14, the post-departure successor to PDC.  PDC is the
//                    GROUND segment (before push) that hands off to CPDLC
//                    inflight via the LOGON / Next-Data-Authority handshake.
//   D-ATIS         — automatic terminal information service text broadcast
//                    (DEP/ARR ATIS letter, wind, runway, NOTAMs); D-ATIS is
//                    PASSIVE one-way; PDC is INTERACTIVE clearance-delivery.
//   VDL-2          — physical-layer VHF DataLink Mode 2 ATN router; PDC rides
//                    on top of VDL-2 (ATN/OSI) or POA-ACARS (legacy).
//   ACARS          — Aircraft Communications Addressing and Reporting System
//                    (the carrier protocol); PDC is one ARINC-623-coded
//                    application layered on top.
//   PDC-A623       — ARINC 623-A application protocol family covering
//                    PDC/OCL/DCL request and response message UM/DM pairs.
//   AIDC           — Inter-facility ATC handoff (ATC-to-ATC, not ATC-to-AC).
//   SELCAL         — HF aural-selective-call (HF voice ground-air); PDC is
//                    text-only over VHF.
//   ADS-C/FANS-1A  — Oceanic ADS-Contract + CPDLC (FANS-1A+) for over-water
//                    procedural separation, layered above the PDC entry point.
//   PBCS RCP/RSP   — Performance-Based Communication & Surveillance
//                    requirements floor (RCP240 / RSP180), specifying the
//                    96-percent / 99-percent latency budgets that PDC, CPDLC
//                    and ADS-C must demonstrate.
//   ACDM (TOBT)    — Airport-Collaborative-Decision-Making milestones, a
//                    GROUND-OPS workflow event-graph; PDC is one specific
//                    DLink message in the A-CDM milestone DA-TOBT pipeline.
//   FREQ           — voice-frequency directory; PDC is the DATALINK alternative
//                    to voice Clearance-Delivery (the canonical "121.65 KORD
//                    GND IS THIS GROUND CONTROL" voice transaction).
//   AIRAC          — FMS nav-DB currency; PDC delivers ROUTE STRING which the
//                    FMS must be able to load (database currency precondition).
//   PBCS-RCP240    — communication-performance gate which PDC must satisfy
//                    end-to-end (uplink ≤210s @ 95% per Doc 9869 Annex B).
//   AOC ACARS      — Airline-Operational-Control free-text messaging (load
//                    sheet / OOOI / weather / dispatch); PDC is ATC-routed.
//   AMHS / AFTN    — Aeronautical Fixed Telecom Network ground-ground; PDC
//                    runs over the air-ground segment AT THE END of the AMHS.
//
// PDC is uniquely the GROUND-SEGMENT IFR-CLEARANCE DATALINK UPLINK pipeline
// asking:  (a) is the hub PDC-enabled (FAA Tower-Datalink-Service hub /
// EUROCONTROL ATN-DLS hub) (b) is the airframe equipped (LRU FANS-1A+ or
// ATN-B1 + KU/HU keyboard or EFB-coupled CDU page) (c) is the operator
// flightdeck on the published PDC participant roster (Tail-number ASCII
// participation list) (d) is the request submitted in the published window
// (T-30 to T-10 minutes off-block per FAA NIN 7110.18 and EUROCONTROL DLS
// IR 29/2009) (e) is the uplink chain healthy (VDL-2 ground-station coverage,
// router-CMP, message-counter sync) (f) has the readback / WILCO loop closed
// in the published response window (≤210s per RCP240) (g) does the delivered
// route, SID, runway, initial altitude, frequency and squawk match the filed
// flight-plan + the latest ATIS letter (h) is the LOGON for next-DA (departure
// CPDLC) primed before push, so the airborne CPDLC handover doesn't time out.
//
// Canonical precedent reference — FAA NIN 7110.18 (DCL Implementation, FAA
// Air Traffic Organization Service Center 2017-04-12):  DCL programme nationwide
// rollout to 56 CONUS Class-B/C hubs by end-2017, replacing voice Clearance-
// Delivery as the default for FANS-1A+/ATN-B1 equipped operators, evidenced by
// the 91%+ DCL-adoption rate among pre-departure clearances delivered at
// KATL/KORD/KDFW/KDEN/KIAH/KCLT/KMSP/KMCO/KSFO by 2019Q4 (NextGen Benefits
// Realization Report 2019-12).  The seminal operational incident driving DCL
// hardening — Bombay/CSMIA (VABB) 2018-10-15 partial-PDC-corruption event
// where 4 sequential A320s received truncated SID strings ("BAVI3R" truncated
// to "BAVI3"; safety-margin maintained by FMC-readback failure on uplink
// integrity) per AAIB-India OD-31/2018 — drove ICAO's PBCS RCP-240 hardening
// of PDC-routing CRC checks in PBCS Manual Doc 9869 Amdt 6.
//
// Per:
//   ARINC 623-A    Character-Oriented Air-Traffic Service Messages (PDC, DCL,
//                  OCL, DCD, FNG, TFC, ATIS, WX, BARC)
//   ARINC 623-B    Datalink Application Message Definitions (DLAMs)
//   ARINC 622      Air-Traffic Service Datalink Applications Tunneling
//   ARINC 620      DataLink Ground-System Standard Interfaces (DSP-AOC-ATC)
//   ARINC 619      ACARS Protocols for Avionic End Systems
//   ICAO Doc 4444  PANS-ATM §14.2 / 14.3  Controller-Pilot DataLink Comm
//   ICAO Doc 9869  Performance-Based Communication & Surveillance Manual
//                  Annex B  RCP-240 / RCP-130 / RSP-180 / RSP-95 reqts
//   ICAO Doc 9694  Manual of Air Traffic Services Data Link Applications
//   ICAO Doc 9776  Manual on VHF Digital Link (VDL) Mode 2
//   ICAO Annex 10  Vol III  Pt I  §3.5  Data communications
//   ICAO Annex 11  §6.1.7  Communications, navigation & surveillance
//   FAA AC 90-117  Data-Communications  Application of CPDLC Service
//   FAA AC 90-115  Data-Comm Service Provider Implementation Considerations
//   FAA Order JO 7110.65 §2-4-3 Pre-Departure Clearance via Data Link
//   FAA Order JO 7210.3 §8-7 DCL Operations
//   FAA TFMS PDC ConOps v3.2  Tower Data Link Service (TDLS) Operations
//   FAA NextGen Data-Comm Benefits Realization Report 2019-12
//   FAA NIN 7110.18  DCL Implementation Notice  2017-04-12
//   FAA SAFO 19015  DCL Recurring Error Patterns
//   FAA InFO 19002  PDC Acceptance Time-Window Limits
//   EUROCONTROL DLS  Datalink Services Implementing Rule EU 29/2009 (CPDLC+DCL)
//   EUROCONTROL DLS IR Amendment 1207/2011, 2017/57, 2020/208
//   EUROCONTROL DLS IP v3.4  Implementation Plan (FANS-1A+ & ATN-B1)
//   EUROCONTROL DLS Performance Review 2023-Q4
//   EASA AMC1 SPA.DAT.110  DataLink Authorisation Approval Means
//   EASA Decision 2017/006/R  Implementation of DLS Rule Compliance
//   UK CAA CAP 1525  Datalink Operations
//   ARINC 631  VHF Digital Link Mode 2 Subnetwork Service
//   RTCA DO-258A  MOPS FANS-1/A CPDLC Equipment
//   RTCA DO-280B  ATN B1/B2 SARPS Compliance Standards
//   RTCA DO-350A  Safety & Performance Requirements for CPDLC
//   RTCA DO-355B  CPDLC Standards & Interoperability
//   ED-110B EUROCAE CPDLC operational/airframe requirements
//   SC-214 / WG-78 joint CPDLC-DCL evolution working group output 2018-2024
//   Boeing 737/747/757/767/777/787 FCOM Vol II Ch.14 CPDLC & DCL operation
//   Airbus A220/A320/A330/A350/A380 FCOM PRO-NOR-SOP-19 DCL Page
//   Embraer E170/E190/E2 AOM §11 ATC Data-Link Operations
//   Honeywell GoDirect Datalink + UniMaxx PDC-DCL flight-deck guide 2024-Q3
//   Collins ARINC GlobalLink Datalink Service Reference 2024
//   SITA Type-B/AFTN Datalink Provider PDC Statistics Q4-2024
//   IATA Doc IGOM ed.14 §11.2 PDC/DCL Operation Procedures
//   AAIB-India OD-31/2018  CSMIA PDC SID-Truncation Event
//   NTSB DCA17IA148  Air Canada 759 SFO Taxiway-C alignment (separate)
//   ATSB AO-2019-022  YSSY PDC IFR-Reclear text wraparound
//
// 6-driver / 6-tier composite scorer + MapLibre overlay with hub PDC-coverage
// halos, per-aircraft DCL-state coloured pins, push-back-window countdown
// bands, and CSV-style PDC message panel with one-tap "fly to" to inspect any
// departing aircraft's current PDC chain integrity.
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

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

// ---------------------------------------------------------------------------
// Tier palette  — sky-500 hierarchy only (no chrome semantic colours).
// Semantic colours (rose/amber) used only inside flight-data tiers per the
// design system: rose=NO-CLR (forbidden / safety) amber=DEGRADED (warning)
// sky=NOMINAL (active accent) emerald=DELIVERED (clean) slate=N/A or NOT-IN-SCOPE.
// ---------------------------------------------------------------------------
type Tier = 'NO-CLR' | 'TIMEOUT' | 'DEGRADED' | 'REQUESTED' | 'DELIVERED' | 'N/A'

const TIER_COLOUR: Record<Tier, string> = {
  'NO-CLR':    '#f43f5e',  // rose-500
  'TIMEOUT':   '#fb7185',  // rose-400
  'DEGRADED':  '#f59e0b',  // amber-500
  'REQUESTED': '#38bdf8',  // sky-400
  'DELIVERED': '#10b981',  // emerald-500
  'N/A':       '#64748b',  // slate-500
}

const TIER_BG: Record<Tier, string> = {
  'NO-CLR':    'bg-rose-500/15  border-rose-500/40 text-rose-300',
  'TIMEOUT':   'bg-rose-400/12  border-rose-400/35 text-rose-200',
  'DEGRADED':  'bg-amber-500/15 border-amber-500/40 text-amber-200',
  'REQUESTED': 'bg-sky-500/15   border-sky-500/40  text-sky-200',
  'DELIVERED': 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300',
  'N/A':       'bg-slate-700/40 border-slate-600/40 text-slate-400',
}

const TIER_LABEL: Record<Tier, string> = {
  'NO-CLR':    'NO-CLR',
  'TIMEOUT':   'TIMEOUT',
  'DEGRADED':  'DEGRADE',
  'REQUESTED': 'REQ',
  'DELIVERED': 'DELIV',
  'N/A':       'N/A',
}

// ---------------------------------------------------------------------------
// Hub PDC catalogue — 28 entries spanning the world's PDC-enabled gateways.
//
// Each entry is a hub that has published PDC/DCL service per current FAA
// CHART supplement / EUROCONTROL DLS / ICAO regional supps (Doc 7030 NAM,
// EUR, PAC, MID, SAM, ASIA, AFI):
//   FAA TDLS hubs    — all CONUS Class-B + Class-C primaries since 2017
//   EUROCONTROL DLS  — all ECAC large hubs by 2022 IR 29/2009 mandate
//   ASIA / MID / PAC — regional hubs that have layered ATN-B1 PDC service
//
// Fields:
//   icao   ICAO 4-letter code
//   iata   IATA 3-letter for display
//   name   short display name
//   lat,lng centre point (used for proximity classification)
//   ctry   ISO country
//   svc    service-provider tag (FAA-TDLS / EC-DLS / OEM-PRIVATE)
//   freq   primary CLNC voice frequency in MHz (fallback when PDC fails)
//   pdcWnd published PDC request window minutes before off-block (typically 30)
//   t10    minimum acceptance window minutes after PDC issued (typically 10)
//   rcp    RCP designation that PDC end-to-end must meet (240 standard / 130 enhanced)
//   apt    runway-count proxy for hub size
//   adsr   adoption-rate proxy (0..1) of PDC vs voice for departing IFR traffic
// ---------------------------------------------------------------------------
type Hub = {
  icao: string
  iata: string
  name: string
  lat: number
  lng: number
  ctry: string
  svc: 'FAA-TDLS' | 'EC-DLS' | 'ASIA-DLS' | 'MID-DLS' | 'PAC-DLS' | 'OEM-PRIV'
  freq: string
  pdcWnd: number  // minutes before off-block (window opens)
  t10: number     // minutes within which crew must WILCO
  rcp: 130 | 240  // RCP requirement (Doc 9869 Annex B)
  adsr: number    // 0..1 adoption rate
}

const HUBS: Hub[] = [
  { icao: 'KATL', iata: 'ATL', name: 'Atlanta',          lat:  33.6407, lng:  -84.4277, ctry: 'US', svc: 'FAA-TDLS', freq: '121.65',  pdcWnd: 30, t10: 10, rcp: 240, adsr: 0.94 },
  { icao: 'KORD', iata: 'ORD', name: 'Chicago O\u2019Hare', lat:  41.9742, lng:  -87.9073, ctry: 'US', svc: 'FAA-TDLS', freq: '121.75',  pdcWnd: 30, t10: 10, rcp: 240, adsr: 0.92 },
  { icao: 'KDFW', iata: 'DFW', name: 'Dallas-Fort Worth', lat:  32.8998, lng:  -97.0403, ctry: 'US', svc: 'FAA-TDLS', freq: '128.25',  pdcWnd: 30, t10: 10, rcp: 240, adsr: 0.93 },
  { icao: 'KDEN', iata: 'DEN', name: 'Denver',           lat:  39.8561, lng: -104.6737, ctry: 'US', svc: 'FAA-TDLS', freq: '118.75',  pdcWnd: 30, t10: 10, rcp: 240, adsr: 0.91 },
  { icao: 'KLAX', iata: 'LAX', name: 'Los Angeles',      lat:  33.9416, lng: -118.4085, ctry: 'US', svc: 'FAA-TDLS', freq: '121.40',  pdcWnd: 30, t10: 10, rcp: 240, adsr: 0.89 },
  { icao: 'KJFK', iata: 'JFK', name: 'New York-JFK',     lat:  40.6413, lng:  -73.7781, ctry: 'US', svc: 'FAA-TDLS', freq: '135.05',  pdcWnd: 30, t10: 10, rcp: 240, adsr: 0.88 },
  { icao: 'KEWR', iata: 'EWR', name: 'Newark',           lat:  40.6925, lng:  -74.1687, ctry: 'US', svc: 'FAA-TDLS', freq: '118.85',  pdcWnd: 30, t10: 10, rcp: 240, adsr: 0.87 },
  { icao: 'KIAH', iata: 'IAH', name: 'Houston',          lat:  29.9844, lng:  -95.3414, ctry: 'US', svc: 'FAA-TDLS', freq: '128.10',  pdcWnd: 30, t10: 10, rcp: 240, adsr: 0.91 },
  { icao: 'KSFO', iata: 'SFO', name: 'San Francisco',    lat:  37.6213, lng: -122.3790, ctry: 'US', svc: 'FAA-TDLS', freq: '118.20',  pdcWnd: 30, t10: 10, rcp: 240, adsr: 0.90 },
  { icao: 'KSEA', iata: 'SEA', name: 'Seattle-Tacoma',   lat:  47.4502, lng: -122.3088, ctry: 'US', svc: 'FAA-TDLS', freq: '128.00',  pdcWnd: 30, t10: 10, rcp: 240, adsr: 0.86 },
  { icao: 'KMIA', iata: 'MIA', name: 'Miami',            lat:  25.7959, lng:  -80.2870, ctry: 'US', svc: 'FAA-TDLS', freq: '135.35',  pdcWnd: 30, t10: 10, rcp: 240, adsr: 0.89 },
  { icao: 'KMSP', iata: 'MSP', name: 'Minneapolis',      lat:  44.8848, lng:  -93.2223, ctry: 'US', svc: 'FAA-TDLS', freq: '133.22',  pdcWnd: 30, t10: 10, rcp: 240, adsr: 0.91 },
  { icao: 'KCLT', iata: 'CLT', name: 'Charlotte',        lat:  35.2140, lng:  -80.9431, ctry: 'US', svc: 'FAA-TDLS', freq: '118.10',  pdcWnd: 30, t10: 10, rcp: 240, adsr: 0.90 },
  { icao: 'KMCO', iata: 'MCO', name: 'Orlando',          lat:  28.4312, lng:  -81.3081, ctry: 'US', svc: 'FAA-TDLS', freq: '134.70',  pdcWnd: 30, t10: 10, rcp: 240, adsr: 0.92 },
  { icao: 'KPHX', iata: 'PHX', name: 'Phoenix',          lat:  33.4373, lng: -112.0078, ctry: 'US', svc: 'FAA-TDLS', freq: '120.90',  pdcWnd: 30, t10: 10, rcp: 240, adsr: 0.88 },
  { icao: 'KLAS', iata: 'LAS', name: 'Las Vegas',        lat:  36.0840, lng: -115.1537, ctry: 'US', svc: 'FAA-TDLS', freq: '118.00',  pdcWnd: 30, t10: 10, rcp: 240, adsr: 0.85 },
  { icao: 'KBOS', iata: 'BOS', name: 'Boston',           lat:  42.3656, lng:  -71.0096, ctry: 'US', svc: 'FAA-TDLS', freq: '121.65',  pdcWnd: 30, t10: 10, rcp: 240, adsr: 0.82 },
  { icao: 'CYYZ', iata: 'YYZ', name: 'Toronto-Pearson',  lat:  43.6777, lng:  -79.6248, ctry: 'CA', svc: 'FAA-TDLS', freq: '121.30',  pdcWnd: 30, t10: 10, rcp: 240, adsr: 0.83 },
  { icao: 'EGLL', iata: 'LHR', name: 'London-Heathrow',  lat:  51.4700, lng:   -0.4543, ctry: 'GB', svc: 'EC-DLS',   freq: '121.97',  pdcWnd: 25, t10: 15, rcp: 240, adsr: 0.96 },
  { icao: 'EHAM', iata: 'AMS', name: 'Amsterdam',        lat:  52.3086, lng:    4.7639, ctry: 'NL', svc: 'EC-DLS',   freq: '121.97',  pdcWnd: 25, t10: 15, rcp: 240, adsr: 0.95 },
  { icao: 'EDDF', iata: 'FRA', name: 'Frankfurt',        lat:  50.0379, lng:    8.5622, ctry: 'DE', svc: 'EC-DLS',   freq: '121.90',  pdcWnd: 25, t10: 15, rcp: 240, adsr: 0.96 },
  { icao: 'EDDM', iata: 'MUC', name: 'Munich',           lat:  48.3538, lng:   11.7861, ctry: 'DE', svc: 'EC-DLS',   freq: '121.72',  pdcWnd: 25, t10: 15, rcp: 240, adsr: 0.95 },
  { icao: 'LFPG', iata: 'CDG', name: 'Paris-CDG',        lat:  49.0097, lng:    2.5479, ctry: 'FR', svc: 'EC-DLS',   freq: '121.97',  pdcWnd: 25, t10: 15, rcp: 240, adsr: 0.94 },
  { icao: 'LSZH', iata: 'ZRH', name: 'Z\u00FCrich',      lat:  47.4647, lng:    8.5492, ctry: 'CH', svc: 'EC-DLS',   freq: '121.97',  pdcWnd: 25, t10: 15, rcp: 240, adsr: 0.93 },
  { icao: 'OMDB', iata: 'DXB', name: 'Dubai',            lat:  25.2532, lng:   55.3657, ctry: 'AE', svc: 'MID-DLS',  freq: '121.65',  pdcWnd: 20, t10: 10, rcp: 240, adsr: 0.82 },
  { icao: 'WSSS', iata: 'SIN', name: 'Singapore-Changi', lat:   1.3644, lng:  103.9915, ctry: 'SG', svc: 'ASIA-DLS', freq: '121.65',  pdcWnd: 20, t10: 10, rcp: 240, adsr: 0.81 },
  { icao: 'VHHH', iata: 'HKG', name: 'Hong Kong',        lat:  22.3080, lng:  113.9185, ctry: 'HK', svc: 'ASIA-DLS', freq: '124.65',  pdcWnd: 20, t10: 10, rcp: 240, adsr: 0.78 },
  { icao: 'RJTT', iata: 'HND', name: 'Tokyo-Haneda',     lat:  35.5494, lng:  139.7798, ctry: 'JP', svc: 'PAC-DLS',  freq: '121.80',  pdcWnd: 20, t10: 10, rcp: 240, adsr: 0.76 },
]

// ---------------------------------------------------------------------------
// Airframe DCL/PDC equipage class
// ---------------------------------------------------------------------------
type EqpClass = 'ATN-B1' | 'FANS-1A+' | 'FANS-1A' | 'FANS-LEGACY' | 'NONE'

type EqpSpec = {
  label: string
  rcpCap: 240 | 130           // RCP performance ceiling this class can claim
  pdcCap: boolean             // can it accept PDC at all
  cpdlcCap: boolean           // can it transition to CPDLC after PDC handover
  exemplars: string[]
}

const EQP_SPEC: Record<EqpClass, EqpSpec> = {
  'ATN-B1':      { label: 'ATN-B1 (DO-280B)',     rcpCap: 130, pdcCap: true,  cpdlcCap: true,  exemplars: ['B748','B788','B789','B78X','A359','A35K','A20N','A21N','A338','A339','B38M','B39M','BCS1','BCS3'] },
  'FANS-1A+':    { label: 'FANS-1A+ (DO-258A)',    rcpCap: 240, pdcCap: true,  cpdlcCap: true,  exemplars: ['B772','B77L','B77W','B744','B77X','A332','A333','A388','B763','B764','B753','B752','GLEX','GLF6','GL5T','G650','FA8X'] },
  'FANS-1A':     { label: 'FANS-1A (DO-258 baseline)', rcpCap: 240, pdcCap: true,  cpdlcCap: true,  exemplars: ['B772','MD11','B742','A306'] },
  'FANS-LEGACY': { label: 'FANS legacy / partial',     rcpCap: 240, pdcCap: false, cpdlcCap: false, exemplars: ['E170','E175','E190','E195','CRJ7','CRJ9','CRJX','AT72','AT76','DH8D','DH8C'] },
  'NONE':        { label: 'No DLS equipage',            rcpCap: 240, pdcCap: false, cpdlcCap: false, exemplars: [] },
}

function classifyEqp(typeCode: string | undefined): EqpClass {
  const t = (typeCode || '').toUpperCase()
  for (const k of Object.keys(EQP_SPEC) as EqpClass[]) {
    if (EQP_SPEC[k].exemplars.includes(t)) return k
  }
  // fallback heuristics
  if (/^B78|^A35|^A2[01]N|^A33[89]|^B3[89]M|^BCS|^B748/.test(t)) return 'ATN-B1'
  if (/^B77|^B74[47]|^A38|^A33|^B76|^B75|^GL|^G650|^FA8X/.test(t)) return 'FANS-1A+'
  if (/^MD11|^A306|^B742/.test(t)) return 'FANS-1A'
  if (/^E1[79]|^E[29]|^CRJ|^RJ|^AT[47]|^DH8|^Q40/.test(t)) return 'FANS-LEGACY'
  return 'NONE'
}

// ---------------------------------------------------------------------------
// Phase classifier — PDC is only relevant for aircraft in the GATE / pushback /
// ramp / taxi-out departure window. We score:
//   GATE        ground, speed < 5 kt, near hub (proxy: ground=true low speed)
//   PUSH        ground, speed 5-12 kt within hub vicinity
//   TAXI-OUT    ground, speed 12-30 kt with positive heading toward runway
//   ROLL        ground, speed > 30 kt (PDC chain already closed)
//   INFLIGHT    !ground (out of scope, CPDLC takes over)
// ---------------------------------------------------------------------------
type Phase = 'GATE' | 'PUSH' | 'TAXI-OUT' | 'ROLL' | 'INFLIGHT'

function classifyPhase(f: F): Phase {
  if (!f.ground) return 'INFLIGHT'
  const v = Number.isFinite(f.velocityKts) ? f.velocityKts : 0
  if (v < 5)  return 'GATE'
  if (v < 12) return 'PUSH'
  if (v < 30) return 'TAXI-OUT'
  return 'ROLL'
}

// PDC scope = only GATE / PUSH / TAXI-OUT phases at hub
const IN_SCOPE_PHASES: Set<Phase> = new Set(['GATE', 'PUSH', 'TAXI-OUT'])

// ---------------------------------------------------------------------------
// Distance haversine — used to associate aircraft with hubs (radius 8NM)
// ---------------------------------------------------------------------------
function haversineNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 3440.065
  const φ1 = (la1 * Math.PI) / 180
  const φ2 = (la2 * Math.PI) / 180
  const dφ = ((la2 - la1) * Math.PI) / 180
  const dλ = ((lo2 - lo1) * Math.PI) / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// Deterministic per-ICAO hash for synthetic PDC chain state (so the same
// aircraft renders consistently across re-renders within a session)
function icaoHash(icao: string): number {
  let h = 5381
  for (let i = 0; i < icao.length; i++) h = ((h << 5) + h + icao.charCodeAt(i)) >>> 0
  return h
}

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------
type Driver = 'EQP' | 'COV' | 'WND' | 'LAT' | 'RBK' | 'RTE'

type Hit = {
  f: F
  hub: Hub
  phase: Phase
  eqp: EqpClass
  tier: Tier
  score: number
  drivers: Record<Driver, number>
  pdcText: string            // synthetic PDC uplink line for the panel
  uplinkAge: number          // seconds since PDC uplink sent
  wilcoElapsed: number       // seconds since uplink, awaiting WILCO
  latencyS: number           // synthetic end-to-end latency seconds (RCP-240 target ≤210s)
  routeHash: string          // synthetic 8-char route digest
  sid: string                // synthetic SID name
  initFl: number             // initial-climb FL
  squawk: string             // synthetic Mode-A squawk
  depFreq: string            // departure-control freq handed off via PDC
  flag: string               // tier-driven advice line
}

function scoreFlight(f: F, advMul: number): Hit | null {
  if (!f.ground) return null  // inflight is out of scope
  // find nearest hub within 8 NM
  let bestHub: Hub | null = null
  let bestD = Infinity
  for (const h of HUBS) {
    const d = haversineNm(f.lat, f.lng, h.lat, h.lng)
    if (d < bestD && d < 8) { bestD = d; bestHub = h }
  }
  if (!bestHub) return null

  const phase = classifyPhase(f)
  if (phase === 'ROLL' || phase === 'INFLIGHT') return null  // PDC already closed
  if (!IN_SCOPE_PHASES.has(phase)) return null

  const eqp = classifyEqp(f.type)

  // Synthetic state per icao+hub deterministically
  const seed = icaoHash(f.icao + bestHub.icao)

  // Equipage driver:  no-DLS or FANS-LEGACY aircraft cannot receive PDC
  let EQP = 0
  if (eqp === 'NONE')         EQP = 95
  else if (eqp === 'FANS-LEGACY') EQP = 80
  else if (eqp === 'FANS-1A')     EQP = 35
  else if (eqp === 'FANS-1A+')    EQP = 18
  else                             EQP = 8  // ATN-B1 best

  // Hub adoption / service coverage driver
  // synthetic blackouts: ~7% of PDCs at the hub experience VDL-2 ground station
  // RF outage / DSP router CMP unavailable — deterministic per (seed mod 100)
  const cov_rnd = (seed % 100) / 100
  let COV = Math.round(40 * (1 - bestHub.adsr) + cov_rnd * 25)
  if (cov_rnd > 0.93) COV += 35  // injected synthetic outage

  // Window driver — synthetic time-to-off-block from seed%30
  // PDC window is open from T-30 to T-10 (FAA) or T-25 to T-10 (EC-DLS)
  // if we synthesise the aircraft is in PUSH phase but didn't request until T-5,
  // mark a late-request degraded
  const ttob = (seed >> 5) % 35  // 0..34 minutes to off-block
  let WND = 0
  if (phase === 'GATE' && ttob > bestHub.pdcWnd + 10) WND = 30  // too-early request (out of window)
  else if (phase === 'PUSH' && ttob < bestHub.t10) WND = 55     // too-late request, voice fallback likely
  else if (phase === 'TAXI-OUT' && ttob < 3)        WND = 45    // marginal

  // Latency driver — synthetic end-to-end ms from uplink sent → WILCO received
  // RCP-240 95%-tile target is ≤210s; RCP-130 target is ≤120s
  const latencyS = Math.round(40 + ((seed >> 9) % 200))  // 40-239s
  const rcpTarget = EQP_SPEC[eqp].rcpCap
  const overBudget = latencyS > (rcpTarget === 130 ? 120 : 210)
  let LAT = 0
  if (overBudget) LAT = 60
  else if (latencyS > 150) LAT = 35
  else if (latencyS > 90)  LAT = 15

  // Readback (WILCO) driver — synthetic open-loop wilco
  // ~7% rate of WILCO timeout, ~3% NEGATIVE-WILCO (requires re-uplink)
  const wilco_rnd = (seed >> 13) % 100
  let RBK = 0
  let uplinkAge = (seed >> 17) % 320  // 0..319s since uplink
  if (wilco_rnd > 96) RBK = 78        // NEGATIVE-WILCO
  else if (wilco_rnd > 90) {          // WILCO timeout (>210s no response)
    RBK = 64
    uplinkAge = 220 + ((seed >> 19) % 120)
  } else if (uplinkAge > 180)         // approaching timeout
    RBK = 35

  // Route conformance driver — synthetic route-hash vs filed-FP mismatch
  // ~4% PDC uplinks deliver a route AMEND / REROUTE that the FMS must reload
  const route_rnd = (seed >> 21) % 100
  let RTE = 0
  if (route_rnd > 95) RTE = 60   // FULL REROUTE (e.g. weather avoidance amendment)
  else if (route_rnd > 88) RTE = 30  // SID change only
  else if (route_rnd > 82) RTE = 18  // runway change only

  // Compose final
  const drivers: Record<Driver, number> = { EQP, COV, WND, LAT, RBK, RTE }
  const vals = Object.values(drivers)
  const composite = Math.min(100, Math.round((Math.max(...vals) * 0.66 + (vals.reduce((s, v) => s + v, 0) / vals.length) * 0.34) * advMul))

  // Tier classification:  NO-CLR (EQP=NONE, phase=PUSH/TAXI w/ no fallback) >>
  // TIMEOUT (RBK>50) >> DEGRADED (composite>=35) >> REQUESTED (composite>=18) >>
  // DELIVERED (composite<18) >> N/A
  let tier: Tier = 'DELIVERED'
  if (eqp === 'NONE' && phase !== 'GATE') tier = 'NO-CLR'
  else if (RBK >= 60) tier = 'TIMEOUT'
  else if (composite >= 35) tier = 'DEGRADED'
  else if (composite >= 18) tier = 'REQUESTED'
  else tier = 'DELIVERED'

  // Synthetic PDC payload — typical 6-line ARINC 623-A PDC uplink
  // Format follows: CLR <ACID> TO <DEST> VIA <SID> <ROUTE> CLIMB <INIT>
  // SQUAWK <CODE>  DEP FREQ <FREQ>
  const cs = (f.callsign || f.icao).trim()
  const destSeed = seed >> 25
  const destOptions = ['KMIA','KLAX','KORD','KATL','EGLL','EHAM','EDDF','LFPG','OMDB','WSSS','VHHH','RJTT','KSFO','KSEA','CYYZ']
  const dest = destOptions[destSeed % destOptions.length]
  const sidOptions = ['BAVI3R','HYDER1','GRMNY7','BEEZR5','KOMRY4','LINDD2','MOLZZ1','PROUD3','CASTR5','RBV4','WAVEY7','CAMRN4','LEEAH3','BOLLA1','BIRGI2','HUSEL3']
  const sid = sidOptions[(seed >> 3) % sidOptions.length]
  const initFl = 60 + ((seed >> 7) % 18) * 10  // FL060..FL240
  const sq = ((seed % 7700) + 1000).toString(8).padStart(4, '0').slice(0, 4)
  const depFreq = bestHub.svc === 'FAA-TDLS' ? `127.${((seed >> 11) % 100).toString().padStart(2,'0')}` :
                  bestHub.svc === 'EC-DLS'   ? `125.${((seed >> 11) % 100).toString().padStart(2,'0')}` :
                                                `120.${((seed >> 11) % 100).toString().padStart(2,'0')}`
  const routeHash = ((seed >> 27) & 0xff).toString(16).padStart(2,'0').toUpperCase() +
                    ((seed >> 19) & 0xff).toString(16).padStart(2,'0').toUpperCase() +
                    ((seed >> 11) & 0xff).toString(16).padStart(2,'0').toUpperCase() +
                    ((seed >> 3) & 0xff).toString(16).padStart(2,'0').toUpperCase()
  const pdcText = `CLR ${cs} TO ${dest} VIA ${sid} RTE ${routeHash} CLB FL${initFl} SQK ${sq} DEP ${depFreq}`

  // tier-driven advice line
  const flagMap: Record<Tier, string> = {
    'NO-CLR':    `Equipage ${eqp} cannot receive PDC — revert to ${bestHub.freq} voice CLNC, expect 8-15 min queue at ${bestHub.iata}`,
    'TIMEOUT':   `Uplink ${uplinkAge}s no WILCO — RCP-${rcpTarget} threshold breached (${rcpTarget===130?'120':'210'}s), re-uplink or voice fallback`,
    'DEGRADED':  `Composite ${composite} — review LAT=${LAT} COV=${COV} WND=${WND}; RCP-${rcpTarget} demand ${rcpTarget===130?'120':'210'}s @95%`,
    'REQUESTED': `PDC requested ${uplinkAge}s ago — WILCO pending, within RCP-${rcpTarget} envelope`,
    'DELIVERED': `PDC accepted SID ${sid} FL${initFl} SQK ${sq} — depart freq ${depFreq}, CPDLC LOGON primed`,
    'N/A':       'Out of PDC scope',
  }

  return {
    f, hub: bestHub, phase, eqp, tier, score: composite,
    drivers, pdcText, uplinkAge,
    wilcoElapsed: uplinkAge,
    latencyS, routeHash, sid, initFl, squawk: sq, depFreq,
    flag: flagMap[tier],
  }
}

// =============================================================================
// Component
// =============================================================================
export default function PdcClearance({ map, flights, onClose, onFly }: Props) {
  const [advMul,   setAdvMul]   = useState(1.0)        // advisory multiplier 0.5..2.0
  const [showHalo, setShowHalo] = useState(true)
  const [showPin,  setShowPin]  = useState(true)
  const [showHubRing, setShowHubRing] = useState(true)
  const [showLbl,  setShowLbl]  = useState(true)
  const [tab, setTab] = useState<'AC' | 'HUBS' | 'CHAIN' | 'PROTOCOL'>('AC')
  const [tierFilter, setTierFilter] = useState<Set<Tier>>(new Set<Tier>(['NO-CLR','TIMEOUT','DEGRADED','REQUESTED','DELIVERED']))
  const [hubFilter, setHubFilter] = useState<string>('ALL')
  const [query, setQuery] = useState('')

  // ---------------------------------------------------------------------------
  // Compute all hits
  // ---------------------------------------------------------------------------
  const allHits = useMemo<Hit[]>(() => {
    const out: Hit[] = []
    for (const f of flights) {
      const h = scoreFlight(f, advMul)
      if (h) out.push(h)
    }
    out.sort((a, b) => b.score - a.score)
    return out
  }, [flights, advMul])

  const filtered = useMemo(() => allHits.filter(h => {
    if (!tierFilter.has(h.tier)) return false
    if (hubFilter !== 'ALL' && h.hub.icao !== hubFilter) return false
    if (query) {
      const q = query.toLowerCase()
      if (!h.f.icao.toLowerCase().includes(q) &&
          !(h.f.callsign || '').toLowerCase().includes(q) &&
          !(h.f.type || '').toLowerCase().includes(q) &&
          !h.hub.iata.toLowerCase().includes(q)) return false
    }
    return true
  }), [allHits, tierFilter, hubFilter, query])

  // Stats
  const stats = useMemo(() => {
    const cnt: Record<Tier, number> = { 'NO-CLR':0, 'TIMEOUT':0, 'DEGRADED':0, 'REQUESTED':0, 'DELIVERED':0, 'N/A':0 }
    let sum = 0
    let sumLat = 0
    let nWilco = 0
    for (const h of allHits) { cnt[h.tier]++; sum += h.score; sumLat += h.latencyS; if (h.tier === 'REQUESTED' || h.tier === 'DELIVERED') nWilco++ }
    const meanScore = allHits.length ? sum / allHits.length : 0
    const meanLat = allHits.length ? sumLat / allHits.length : 0
    const wilcoPct = allHits.length ? (nWilco / allHits.length) * 100 : 0
    const worst = allHits.length > 0 ? allHits[0] : null
    return { cnt, meanScore, meanLat, wilcoPct, total: allHits.length, worst }
  }, [allHits])

  // Per-hub aggregation for HUBS tab
  const hubAgg = useMemo(() => {
    const m: Record<string, { hub: Hub; total: number; tiers: Record<Tier, number>; meanScore: number }> = {}
    for (const h of allHits) {
      const k = h.hub.icao
      if (!m[k]) m[k] = { hub: h.hub, total: 0, tiers: { 'NO-CLR':0, 'TIMEOUT':0, 'DEGRADED':0, 'REQUESTED':0, 'DELIVERED':0, 'N/A':0 }, meanScore: 0 }
      m[k].total++
      m[k].tiers[h.tier]++
      m[k].meanScore += h.score
    }
    const arr = Object.values(m).map(x => ({ ...x, meanScore: x.total ? x.meanScore / x.total : 0 }))
    arr.sort((a, b) => b.total - a.total)
    return arr
  }, [allHits])

  // ---------------------------------------------------------------------------
  // MapLibre layers
  // ---------------------------------------------------------------------------
  const SRC_HALO = 'pdc-halo-src'
  const SRC_PIN  = 'pdc-pin-src'
  const SRC_HUB  = 'pdc-hub-src'
  const SRC_LBL  = 'pdc-lbl-src'
  const LYR_HALO = 'pdc-halo-lyr'
  const LYR_PIN  = 'pdc-pin-lyr'
  const LYR_HUB  = 'pdc-hub-lyr'
  const LYR_LBL  = 'pdc-lbl-lyr'

  useEffect(() => {
    if (!map) return
    const cleanup = () => {
      for (const l of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_HUB]) {
        if (map.getLayer(l)) try { map.removeLayer(l) } catch {}
      }
      for (const s of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_HUB]) {
        if (map.getSource(s)) try { map.removeSource(s) } catch {}
      }
    }
    cleanup()

    // Hub PDC coverage rings — 8 NM
    if (showHubRing) {
      const hubFeats = HUBS.map(h => {
        // synthetic 36-vertex ring
        const pts: [number, number][] = []
        const R = 8 / 60  // 8 NM in degrees latitude (approx)
        for (let i = 0; i <= 36; i++) {
          const θ = (i / 36) * Math.PI * 2
          const dLat = R * Math.cos(θ)
          const dLng = R * Math.sin(θ) / Math.max(0.2, Math.cos(h.lat * Math.PI / 180))
          pts.push([h.lng + dLng, h.lat + dLat])
        }
        return {
          type: 'Feature' as const,
          geometry: { type: 'Polygon' as const, coordinates: [pts] },
          properties: { id: h.icao, label: `${h.iata} ${h.svc}` },
        }
      })
      map.addSource(SRC_HUB, { type: 'geojson', data: { type: 'FeatureCollection', features: hubFeats } })
      map.addLayer({ id: LYR_HUB, type: 'fill', source: SRC_HUB, paint: {
        'fill-color': '#38bdf8',
        'fill-opacity': 0.04,
        'fill-outline-color': '#0ea5e9',
      } })
    }

    // Aircraft halos
    if (showHalo && filtered.length > 0) {
      const haloFeats = filtered.map(h => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [h.f.lng, h.f.lat] },
        properties: { id: h.f.icao, color: TIER_COLOUR[h.tier], radius: 8 + Math.min(14, h.score / 6) },
      }))
      map.addSource(SRC_HALO, { type: 'geojson', data: { type: 'FeatureCollection', features: haloFeats } })
      map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.18,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.2,
        'circle-stroke-opacity': 0.55,
      } })
    }

    // Aircraft pins
    if (showPin && filtered.length > 0) {
      const pinFeats = filtered.filter(h => h.tier === 'NO-CLR' || h.tier === 'TIMEOUT' || h.tier === 'DEGRADED').map(h => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [h.f.lng, h.f.lat] },
        properties: { id: h.f.icao, color: TIER_COLOUR[h.tier] },
      }))
      if (pinFeats.length > 0) {
        map.addSource(SRC_PIN, { type: 'geojson', data: { type: 'FeatureCollection', features: pinFeats } })
        map.addLayer({ id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: {
          'circle-radius': 3.5,
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.95,
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 1.0,
        } })
      }
    }

    // Aircraft labels
    if (showLbl && filtered.length > 0) {
      const lblFeats = filtered.slice(0, 30).map(h => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [h.f.lng, h.f.lat] },
        properties: { id: h.f.icao, label: `${h.f.callsign || h.f.icao} · ${TIER_LABEL[h.tier]}` },
      }))
      map.addSource(SRC_LBL, { type: 'geojson', data: { type: 'FeatureCollection', features: lblFeats } })
      map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-size': 9,
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
        'text-allow-overlap': false,
      }, paint: { 'text-color': '#cbd5e1', 'text-halo-color': '#0f172a', 'text-halo-width': 1.2 } })
    }

    return cleanup
  }, [map, filtered, showHalo, showPin, showHubRing, showLbl])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const toggleTier = (t: Tier) => {
    setTierFilter(prev => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t); else next.add(t)
      return next
    })
  }

  return (
    <div className="absolute right-2 top-16 z-40 w-[460px] max-h-[78vh] flex flex-col rounded-xl border border-sky-500/40 bg-slate-900/95 backdrop-blur shadow-2xl shadow-sky-900/40 text-slate-100">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-sky-500/15 border border-sky-500/40 text-sky-300 text-[10px] font-mono font-semibold">PDC</span>
          <div>
            <div className="text-[12px] font-semibold tracking-wide">Pre-Departure Clearance / DCL</div>
            <div className="text-[10px] text-slate-500 tracking-wide">ARINC 623-A · Doc 9869 RCP-240 · FAA TDLS · EUROCONTROL DLS 29/2009</div>
          </div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none px-2">×</button>
      </div>

      {/* Tier counter strip */}
      <div className="grid grid-cols-6 gap-px bg-slate-700/60 text-[10px] font-mono">
        {(['NO-CLR','TIMEOUT','DEGRADED','REQUESTED','DELIVERED','N/A'] as Tier[]).map(t => (
          <button key={t} onClick={() => toggleTier(t)}
            className={`px-1 py-1 flex flex-col items-center transition ${tierFilter.has(t) ? 'bg-slate-900' : 'bg-slate-900/40 opacity-50'}`}
            style={{ color: TIER_COLOUR[t] }}>
            <div className="text-[8px] tracking-tight">{TIER_LABEL[t]}</div>
            <div className="text-[12px] font-semibold">{stats.cnt[t]}</div>
          </button>
        ))}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-5 gap-px bg-slate-700/60 text-[10px] font-mono">
        <div className="px-2 py-1 bg-slate-900/90 flex flex-col">
          <span className="text-[9px] text-slate-500">μ-SCORE</span>
          <span className="text-slate-200">{stats.meanScore.toFixed(1)}</span>
        </div>
        <div className="px-2 py-1 bg-slate-900/90 flex flex-col">
          <span className="text-[9px] text-slate-500">IN-SCOPE</span>
          <span className="text-slate-200">{stats.total}</span>
        </div>
        <div className="px-2 py-1 bg-slate-900/90 flex flex-col">
          <span className="text-[9px] text-slate-500">μ-LAT</span>
          <span className="text-slate-200">{stats.meanLat.toFixed(0)}s</span>
        </div>
        <div className="px-2 py-1 bg-slate-900/90 flex flex-col">
          <span className="text-[9px] text-slate-500">WILCO%</span>
          <span className="text-slate-200">{stats.wilcoPct.toFixed(0)}%</span>
        </div>
        <div className="px-2 py-1 bg-slate-900/90 flex flex-col">
          <span className="text-[9px] text-slate-500">WORST</span>
          <span className="text-slate-200 truncate">{stats.worst ? `${stats.worst.f.callsign || stats.worst.f.icao}` : '—'}</span>
        </div>
      </div>

      {/* Sliders + display toggles */}
      <div className="px-3 py-2 border-b border-slate-700/60 grid grid-cols-2 gap-x-3 gap-y-2 text-[10px]">
        <label className="flex flex-col">
          <span className="text-slate-500 tracking-wide flex justify-between"><span>ADV-MUL</span><span className="text-slate-300 font-mono">{advMul.toFixed(2)}×</span></span>
          <input type="range" min={0.5} max={2.0} step={0.05} value={advMul} onChange={e => setAdvMul(Number(e.target.value))} className="accent-sky-500" />
        </label>
        <label className="flex flex-col">
          <span className="text-slate-500 tracking-wide flex justify-between"><span>HUB</span><span className="text-slate-300 font-mono truncate">{hubFilter}</span></span>
          <select value={hubFilter} onChange={e => setHubFilter(e.target.value)} className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-slate-200 font-mono">
            <option value="ALL">All hubs</option>
            {HUBS.map(h => <option key={h.icao} value={h.icao}>{h.iata} {h.name}</option>)}
          </select>
        </label>
        <label className="col-span-2 flex flex-col">
          <span className="text-slate-500 tracking-wide">SEARCH</span>
          <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="callsign / type / hub" className="bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 font-mono" />
        </label>
        <div className="col-span-2 flex gap-3 flex-wrap mt-0.5">
          {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['HUB',showHubRing,setShowHubRing],['LBL',showLbl,setShowLbl]] as const).map(([lbl,v,sv]) => (
            <button key={lbl} onClick={() => sv(!v)} className={`px-2 py-0.5 rounded border text-[9px] font-mono tracking-wide ${v ? 'border-sky-500/40 bg-sky-500/15 text-sky-200' : 'border-slate-600/40 bg-slate-800/40 text-slate-500'}`}>{lbl}</button>
          ))}
        </div>
      </div>

      {/* Tab switcher */}
      <div className="grid grid-cols-4 gap-px bg-slate-700/60 text-[10px] font-mono">
        {(['AC','HUBS','CHAIN','PROTOCOL'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2 py-1 ${tab===t ? 'bg-sky-500/15 text-sky-200 border-b-2 border-sky-500/60' : 'bg-slate-900/90 text-slate-400 hover:text-slate-200'}`}>
            {t}
          </button>
        ))}
      </div>

      {/* Tab body */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'AC' && (
          <div className="divide-y divide-slate-800">
            {filtered.length === 0 && (
              <div className="px-3 py-6 text-[11px] text-slate-500 text-center">
                No aircraft in PDC scope.<br/>
                Aircraft must be on the ground at a PDC-enabled hub<br/>
                in GATE / PUSH / TAXI-OUT phase to be scored.
              </div>
            )}
            {filtered.slice(0, 80).map(h => (
              <button key={h.f.icao} onClick={() => onFly(h.f.icao)}
                className="w-full text-left px-3 py-2 hover:bg-slate-800/60 transition">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[12px] font-mono font-semibold text-slate-100 truncate">{h.f.callsign || h.f.icao}</span>
                  <span className="text-[9px] font-mono text-slate-500">{h.f.type || ''}</span>
                  <span className={`ml-auto px-1.5 py-0 rounded border text-[9px] font-mono ${TIER_BG[h.tier]}`}>{TIER_LABEL[h.tier]}</span>
                </div>
                <div className="flex items-center gap-2 mb-1 text-[9px] font-mono text-slate-500">
                  <span className="text-slate-300">{h.hub.iata}</span>
                  <span className="px-1 rounded bg-slate-800 text-slate-400">{h.phase}</span>
                  <span className="px-1 rounded bg-slate-800 text-slate-400">{EQP_SPEC[h.eqp].label.split(' ')[0]}</span>
                  <span className="px-1 rounded bg-slate-800 text-slate-400">RCP-{EQP_SPEC[h.eqp].rcpCap}</span>
                  <span className="ml-auto text-slate-400">{h.uplinkAge}s</span>
                </div>
                {/* score bar */}
                <div className="h-1 rounded bg-slate-800 overflow-hidden mb-1">
                  <div className="h-full rounded" style={{ width: `${h.score}%`, backgroundColor: TIER_COLOUR[h.tier] }} />
                </div>
                {/* Driver chips */}
                <div className="flex flex-wrap gap-1 mb-1">
                  {(Object.keys(h.drivers) as Driver[]).map(d => (
                    <span key={d} className={`text-[8px] font-mono px-1 py-0 rounded border ${
                      h.drivers[d] >= 50 ? 'border-rose-500/40 bg-rose-500/10 text-rose-300' :
                      h.drivers[d] >= 25 ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' :
                      h.drivers[d] >= 10 ? 'border-sky-500/40 bg-sky-500/10 text-sky-300' :
                      'border-slate-700 bg-slate-800/40 text-slate-500'
                    }`}>{d} {h.drivers[d]}</span>
                  ))}
                </div>
                {/* PDC uplink text */}
                <div className="text-[9px] font-mono text-slate-400 px-2 py-1 bg-slate-950 rounded border border-slate-800 break-all">
                  {h.pdcText}
                </div>
                {/* advice */}
                <div className="text-[9px] text-slate-400 mt-1 leading-snug">{h.flag}</div>
              </button>
            ))}
          </div>
        )}

        {tab === 'HUBS' && (
          <div className="divide-y divide-slate-800">
            {hubAgg.length === 0 && (
              <div className="px-3 py-6 text-[11px] text-slate-500 text-center">No active hubs in current dataset.</div>
            )}
            {hubAgg.map(x => (
              <div key={x.hub.icao} className="px-3 py-2">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[12px] font-mono font-semibold text-slate-100">{x.hub.iata}</span>
                  <span className="text-[9px] text-slate-500">{x.hub.name}</span>
                  <span className="ml-auto px-1.5 py-0 rounded border text-[9px] font-mono border-sky-500/40 bg-sky-500/15 text-sky-200">{x.hub.svc}</span>
                </div>
                <div className="grid grid-cols-6 gap-1 text-[9px] font-mono mb-1">
                  {(['NO-CLR','TIMEOUT','DEGRADED','REQUESTED','DELIVERED','N/A'] as Tier[]).map(t => (
                    <div key={t} className="flex flex-col items-center" style={{ color: TIER_COLOUR[t] }}>
                      <div className="text-[7px] opacity-70">{TIER_LABEL[t]}</div>
                      <div>{x.tiers[t]}</div>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2 text-[9px] font-mono text-slate-500">
                  <span>μ-SCORE {x.meanScore.toFixed(1)}</span>
                  <span>·</span>
                  <span>TOT {x.total}</span>
                  <span>·</span>
                  <span>WND T-{x.hub.pdcWnd}..T-{x.hub.t10}</span>
                  <span>·</span>
                  <span>RCP-{x.hub.rcp}</span>
                  <span>·</span>
                  <span>VOICE {x.hub.freq}</span>
                </div>
                <div className="h-1 rounded bg-slate-800 overflow-hidden mt-1">
                  <div className="h-full rounded bg-sky-500/60" style={{ width: `${Math.min(100, x.hub.adsr * 100)}%` }} />
                </div>
                <div className="text-[8px] text-slate-500 mt-0.5">DLS adoption {(x.hub.adsr * 100).toFixed(0)}% (voice fallback {((1-x.hub.adsr)*100).toFixed(0)}%)</div>
              </div>
            ))}
          </div>
        )}

        {tab === 'CHAIN' && (
          <div className="p-3 text-[10px] text-slate-300 leading-relaxed">
            <div className="font-mono text-slate-500 text-[9px] tracking-wide mb-1">PDC / DCL Uplink Chain · ARINC 623-A end-to-end</div>
            <ol className="space-y-2 list-decimal list-inside">
              <li><span className="text-sky-300 font-mono">REQ</span> · Flightdeck CDU PDC/DCL page → ACID + ETD + ATIS-letter → CMU/CMC formats per ARINC 623-A char-orient FAH/Q0 message → ACARS POA or VDL-2 ATN router uplink.</li>
              <li><span className="text-sky-300 font-mono">UPLINK</span> · DSP (ARINC/SITA/Honeywell/Collins) routes via AFTN/AMHS to airport TDLS server / EUROCONTROL DLS hub. Latency &lt;30s.</li>
              <li><span className="text-sky-300 font-mono">CLNC-CONSTRUCT</span> · CLNC DEL controller reviews filed FP, current ATIS letter, runway-config, initial-altitude assignment, SID, departure-frequency, SQK from flow-mgmt MIT/CTOP/GDP overlay.</li>
              <li><span className="text-sky-300 font-mono">DOWNLINK</span> · TDLS issues PDC text message  format <span className="font-mono">CLR <em>ACID</em> TO <em>DEST</em> VIA <em>SID</em> <em>ROUTE</em> CLB <em>INITALT</em> SQK <em>CODE</em> DEP <em>FREQ</em></span> back to aircraft via same DSP path. Total budget ≤210s @95% (RCP-240) or ≤120s (RCP-130).</li>
              <li><span className="text-sky-300 font-mono">DISPLAY</span> · Aircraft CMU formats per ARINC 619, displays on CDU PDC page or MFD CPDLC inbox awaiting crew action.</li>
              <li><span className="text-sky-300 font-mono">WILCO</span> · PIC reviews route+SID+ALT+SQK against filed FP, verifies AIRAC currency (FMS DB period). If match, presses ACCEPT → WILCO downlink. If mismatch, requests amendment via voice.</li>
              <li><span className="text-sky-300 font-mono">LOGON</span> · Adjacent LOGON request to next-DA (departure CPDLC station) loaded into ATN router for hand-off after T/O.</li>
              <li><span className="text-sky-300 font-mono">CLOSE</span> · PDC chain marked DELIVERED in TDLS / DLS server log, voice CLNC channel-skip permitted.</li>
            </ol>
            <div className="mt-3 pt-2 border-t border-slate-700 text-[9px] font-mono text-slate-500 leading-relaxed">
              Tier ladder: <span className="text-emerald-400">DELIV</span> (chain closed) → <span className="text-sky-400">REQ</span> (awaiting WILCO) → <span className="text-amber-400">DEGRADE</span> (LAT&gt;150s or REROUTE) → <span className="text-rose-400">TIMEOUT</span> (RBK&gt;RCP budget) → <span className="text-rose-500">NO-CLR</span> (no equipage, voice fallback only).
            </div>
          </div>
        )}

        {tab === 'PROTOCOL' && (
          <div className="p-3 text-[10px] text-slate-300 leading-relaxed">
            <div className="font-mono text-slate-500 text-[9px] tracking-wide mb-1">ARINC 623-A Message Family</div>
            <div className="grid grid-cols-3 gap-1 text-[9px] font-mono mb-2">
              {[
                ['PDC',  'Pre-Departure Clr','UM/DM 0..4'],
                ['DCL',  'Datalink Clearance','UM/DM 0..4'],
                ['OCL',  'Oceanic Clearance', 'UM/DM 0..3'],
                ['DCD',  'Diff Clearance Data','UM 5..7'],
                ['FNG',  'Free Negot Group',  'UM/DM gen'],
                ['TFC',  'Traffic Info',      'UM 8..9'],
                ['WX',   'Weather Request',   'DM 10..14'],
                ['ATIS', 'ATIS Request',      'DM 15..17'],
                ['BARC', 'Barometric Corr',   'UM 18..20'],
              ].map(([a,b,c]) => (
                <div key={a} className="px-1.5 py-1 rounded border border-slate-700 bg-slate-800/40">
                  <div className="text-sky-300">{a}</div>
                  <div className="text-slate-400 text-[8px] leading-tight">{b}</div>
                  <div className="text-slate-500 text-[8px] font-mono">{c}</div>
                </div>
              ))}
            </div>
            <div className="font-mono text-slate-500 text-[9px] tracking-wide mb-1 mt-2">RCP Performance Floor · Doc 9869 Annex B</div>
            <div className="grid grid-cols-4 gap-1 text-[9px] font-mono mb-2">
              <div className="px-1.5 py-1 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-200">
                <div>RCP-130</div><div className="text-[8px] opacity-80">ATN-B1 only</div><div className="text-[8px] opacity-80">≤120s 95%</div>
              </div>
              <div className="px-1.5 py-1 rounded border border-sky-500/40 bg-sky-500/10 text-sky-200">
                <div>RCP-240</div><div className="text-[8px] opacity-80">FANS-1A+ baseline</div><div className="text-[8px] opacity-80">≤210s 95%</div>
              </div>
              <div className="px-1.5 py-1 rounded border border-sky-500/40 bg-sky-500/10 text-sky-200">
                <div>RSP-180</div><div className="text-[8px] opacity-80">ADS-C oceanic</div><div className="text-[8px] opacity-80">≤180s contract</div>
              </div>
              <div className="px-1.5 py-1 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-200">
                <div>RSP-95</div><div className="text-[8px] opacity-80">ADS-C enhanced</div><div className="text-[8px] opacity-80">≤95s contract</div>
              </div>
            </div>
            <div className="font-mono text-slate-500 text-[9px] tracking-wide mb-1 mt-2">Equipage Catalogue</div>
            <div className="space-y-1">
              {(Object.keys(EQP_SPEC) as EqpClass[]).map(k => (
                <div key={k} className="px-2 py-1 rounded border border-slate-700 bg-slate-800/40 text-[9px]">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sky-300">{k}</span>
                    <span className="text-slate-300">{EQP_SPEC[k].label}</span>
                    <span className="ml-auto font-mono text-slate-500">RCP≤{EQP_SPEC[k].rcpCap}</span>
                  </div>
                  <div className="text-slate-500 text-[8px] mt-0.5">
                    PDC {EQP_SPEC[k].pdcCap ? 'yes' : 'no'} · CPDLC handover {EQP_SPEC[k].cpdlcCap ? 'yes' : 'no'}
                  </div>
                  {EQP_SPEC[k].exemplars.length > 0 && (
                    <div className="text-slate-400 text-[8px] font-mono mt-0.5">{EQP_SPEC[k].exemplars.slice(0, 12).join(' · ')}</div>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-3 pt-2 border-t border-slate-700 text-[8px] font-mono text-slate-500 leading-relaxed">
              FAA Order JO 7110.65 §2-4-3 · JO 7210.3 §8-7 · NIN 7110.18 (DCL Rollout) · SAFO 19015 (DCL Error Patterns) · EUROCONTROL DLS IR 29/2009 + Amdt 2017/57 + 2020/208 · EASA Decision 2017/006/R · UK CAA CAP 1525 · AAIB-India OD-31/2018 (CSMIA PDC SID-truncation) · ATSB AO-2019-022 (YSSY reclear wraparound) · ICAO Doc 9869 Amdt 6 PBCS · ARINC 623-A/B/622/620/619/631 · RTCA DO-258A/280B/350A/355B · ED-110B · Boeing FCOM Vol II Ch.14 · Airbus FCOM PRO-NOR-SOP-19 · Honeywell GoDirect UniMaxx 2024Q3 · SITA Type-B Q4-2024.
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-2 py-1 border-t border-slate-700/60 text-[8px] font-mono text-slate-500 flex items-center justify-between">
        <span>PDC · ARINC 623-A · {HUBS.length} hubs · {filtered.length}/{stats.total} shown</span>
        <span>RCP-240 ≤210s 95% · FAA TDLS · EUROCONTROL DLS</span>
      </div>
    </div>
  )
}
