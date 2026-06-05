// STBR · Stop-Bar Enforcement & Linate-Mode Runway Incursion Monitor
//
// What this is
// ------------
// Per-airframe live evaluator of every ground-traffic aircraft's compliance with
// ICAO Annex 14 Vol I §5.3.19 illuminated red STOP-BAR enforcement at runway-holding
// positions, taxiway-intersection holds, and entry-point hold-short lines, under
// the Low-Visibility-Procedure (LVP) regime triggered when RVR ≤550 m or ceiling
// ≤200 ft per ICAO Doc 9476 SMGCS Manual + Doc 9830 A-SMGCS Manual + Annex 14 Vol I
// §5.3.19 §5.3.20 §5.3.21 + ICAO Cir 301 Stopbar / Centreline Lights Operations.
//
// This is the canonical Linate-mode runway-incursion evaluator — the SAS 686
// MD-87 / Cessna XHE D-IEVX collision at LIML 2001-10-08 (118 fatal, ANSV final
// report 2004-01-20) where the Cessna crew, under RVR ≤200 m, taxied across an
// extinguished stop-bar at intersection R5 (no SMGCS, no surface-movement-radar,
// no red-bar illumination at low-vis hold) onto active runway 36L and entered
// the takeoff-roll path of the departing MD-87. The accident triggered ICAO Doc
// 9476 SMGCS upgrade, mandatory stop-bar lighting at all instrument-runway
// holding positions where RVR ≤550 m operations are permitted, ASDE-X / A-SMGCS
// Level 2+ surface-movement-radar deployment, and pilot training in stop-bar
// recognition (FAA AC 120-74B §5, EASA AMC1 ADR.OPS.B.045 §4).
//
// Operational background
// ----------------------
// A stop-bar is a row of unidirectional red lights embedded in the taxiway
// pavement at a runway-holding position, illuminated red when ATC has NOT
// cleared the aircraft to cross/enter. When ATC issues a clearance, the
// red bar EXTINGUISHES and the green taxiway-centreline lights illuminate
// past the bar — this is the LIT-GREEN-CL transition. The CARDINAL RULE
// per FAA AC 120-57B §4 / EASA AMC1 ADR.OPS.B.045 / Eurocontrol HRR Hbk:
//
//   NEVER cross an illuminated red stop-bar. NEVER. Even with a verbal
//   clearance — if the bar is still red, query ATC, do not cross.
//
// Mandatory deployment regime (ICAO Annex 14 Vol I §5.3.19):
//   - Required at ALL runway-holding positions on instrument runways
//   - Required when RVR ≤550 m operations are planned/expected
//   - Should be available at intermediate holding positions on routes to
//     instrument runways during LVP
//   - Switchable INDIVIDUALLY by ATC per holding position
//   - When stop bar is illuminated, taxiway-centreline lights between the
//     bar and the runway must be EXTINGUISHED (the "stop-bar-enforced lead-off
//     interlock" per Annex 14 §5.3.19.3)
//   - When stop bar is extinguished, the lead-off green centreline lights
//     ILLUMINATE — visual confirmation of clearance to cross
//
// Phase classification per FAA AC 120-74B §4 + Eurocontrol EAPPRI ed.3.0 §3:
//   GROUND-TAXI    on-ground, GS 5-35 kt, not on runway
//   APPROACH-HOLD  GS 0-5 kt, holding short of runway, in stop-bar zone
//   PRE-LINEUP     accelerating past hold-short toward lineup (3-15 kt)
//   LINEUP         on runway, 0-15 kt, alignment phase
//   ROLL-INIT      on runway, 15-60 kt, takeoff roll initiated
//   ROLL-HIGH      on runway, 60+ kt, V1 region
//   LANDED         on runway, GS 30-100 kt, decelerating
//   RWY-VACATE     exiting runway via high-speed turnoff, 15-40 kt
//   GATE           on apron, GS <5 kt or stationary
//
// Tier system (6 tiers + OFF):
//   INCURSION ≥85   crossed/within an active illuminated stop-bar without
//                   explicit ATC clearance — Cat-A runway incursion per FAA
//                   ASRS / EASA Annex II SMS Class-A (immediate brake to stop,
//                   transmit position to ATC, await pushback per AIM 4-3-20)
//                   rose tier — Linate-mode
//   CRITICAL ≥65    inside SAFETY-AREA approach of an armed stop-bar in
//                   LVP-active with no clearance trail, ROD/GS suggests
//                   intent-to-cross — Cat-B incursion potential
//                   rose-pink tier — immediate-action brief
//   ARMED-ZONE ≥45  in stop-bar STAND-BY zone (within 75m of armed bar) under
//                   LVP-active condition, taxi-clearance pending — Cat-C
//                   monitor for compliance
//                   amber tier — advisory
//   ELEVATED ≥22    in low-vis-procedure-active environment at LVP airport,
//                   not yet in bar-zone but moving on surface — Cat-D
//                   sky tier — situational awareness
//   COMPLIANT <22   normal taxi operations, bar-compliant or non-LVP
//                   emerald tier
//   OFF             airborne / non-ground / outside catalogue airports
//                   slate tier
//
// Drivers (8):
//   BARSTATE       red/extinguished state of nearest stop-bar (proxy synth)
//   DISTANCE       metres from aircraft to nearest stop-bar centroid
//   CLEARANCE      ATC-clearance state (proxy from taxi-time-since-RVR-onset)
//   GS-INTENT      GS×Δheading product — taxi-intent vector toward bar
//   PHASE          phase-of-flight in low-vis-procedure context
//   RVR-LVP        RVR-band low-vis-procedure activation level
//   SMGCS-LEVEL    A-SMGCS Level (1=PSR/MLAT only, 2=routing, 3=guidance,
//                  4=automated conflict) at this airport
//   HOTSPOT        proximity to published runway-incursion hotspot per
//                  ICAO Annex 14 §10.1.4 + Jeppesen 10-9A
//
// 18-airport STBR catalogue with per-airport stopbar topology, A-SMGCS level,
// LVP-frequency band, hotspot registry, and runway entry-point inventory.
// Catalogue compiled from: ICAO LRRS Linate report 2004 / EASA SIB 2018-14
// runway-incursion warning / Eurocontrol EAPPRI ed.3.0 + ed.4.0 / FAA Order
// JO 7110.65 §3-7 / NTSB SIR-86/01 / NLR-CR-2018-301 ASDE-X Effectiveness /
// CAP 791 UK CAA Runway-Incursion Action Plan / DGAC France Linate-precedent
// reform / Jeppesen Airport Diagram 10-9A Hot-Spot Registry 2024 / FAA AC
// 120-74B Flight-Crew Procedures during Taxi Ops / EASA AMC1 ADR.OPS.B.045
// Apron / FCOM FCTM Ground-ops Ch.4 / ICAO Cir 301 Stopbar Operations.
//
// Active AD/SB regime
// -------------------
//   - EASA SIB 2018-14 Runway Incursions Stop-Bar Compliance — current
//   - FAA SAFO 18002 Runway Incursion Prevention LVP Crews
//   - Eurocontrol Action Plan for Prevention of Runway Incursions ed.4.0
//     2025 (revised post-EAPPRI)
//   - ICAO Annex 14 Vol I 8th ed (2018) §5.3.19 §5.3.20 stop-bar/centreline
//   - ICAO Doc 9870 §4 Manual on Prevention of Runway Incursions
//   - NTSB Safety Recommendation A-15-25 to A-15-29 hot-spot signage

'use client'

import React, { useEffect, useMemo, useState } from 'react'
import maplibregl from 'maplibre-gl'

type Tier = 'INCURSION' | 'CRITICAL' | 'ARMED-ZONE' | 'ELEVATED' | 'COMPLIANT' | 'OFF'

const TIER_COLOR: Record<Tier, string> = {
  'INCURSION': '#f43f5e',
  'CRITICAL': '#fb7185',
  'ARMED-ZONE': '#f59e0b',
  'ELEVATED': '#0ea5e9',
  'COMPLIANT': '#10b981',
  'OFF': '#475569',
}

const TIER_RANK: Record<Tier, number> = {
  'INCURSION': 0, 'CRITICAL': 1, 'ARMED-ZONE': 2, 'ELEVATED': 3, 'COMPLIANT': 4, 'OFF': 5,
}
const TIER_ORDER: Tier[] = ['INCURSION', 'CRITICAL', 'ARMED-ZONE', 'ELEVATED', 'COMPLIANT']

const TIER_ADVICE: Record<Tier, string> = {
  'INCURSION': 'STOP IMMEDIATELY — brakes-to-hold position. Transmit position+intent to ATC. CAT-A runway incursion per FAA ASRS Class-A. Linate-mode hazard.',
  'CRITICAL': 'HOLD-SHORT — verify stop-bar STATE before any forward movement. Query ATC for explicit cross-clearance. CAT-B incursion potential.',
  'ARMED-ZONE': 'Inside armed stop-bar standby zone. Confirm taxi-clearance covers next holding position. Stop unless bar-extinguished + green CL lit.',
  'ELEVATED': 'LVP-active environment. Maintain continuous lookout for stop-bars. Verbal readback of any taxi instruction. AIM 4-3-20 §4-3-23.',
  'COMPLIANT': 'Normal taxi. Bar-state nominal. SMGCS guidance valid. Continue per ATC clearance.',
  'OFF': '—',
}

// === Phase classifier
type Phase = 'GROUND-TAXI' | 'APPROACH-HOLD' | 'PRE-LINEUP' | 'LINEUP' | 'ROLL-INIT' | 'ROLL-HIGH' | 'LANDED' | 'RWY-VACATE' | 'GATE' | 'AIR'

const PHASE_LABEL: Record<Phase, string> = {
  'GROUND-TAXI': 'Taxi',
  'APPROACH-HOLD': 'Hold-Short',
  'PRE-LINEUP': 'Pre-Lineup',
  'LINEUP': 'Lineup',
  'ROLL-INIT': 'Roll-Init',
  'ROLL-HIGH': 'Roll-High',
  'LANDED': 'Landed',
  'RWY-VACATE': 'Vacate',
  'GATE': 'Gate',
  'AIR': 'Airborne',
}

// === Airport stopbar topology catalogue ===
// Per-airport: ICAO + IATA + name + centroid lat/lng + 4-9 runway-end stopbars
// + 1-4 hotspots + A-SMGCS level + LVP frequency band (0-3, higher = more LVP days/yr)
interface StopBar {
  id: string             // e.g. "27L-A1"
  rwy: string            // runway designator
  lat: number
  lng: number
  hdg: number            // bearing INTO the runway from this stop-bar (deg true)
  taxiway: string        // taxiway letter
}

interface HotSpot {
  id: string             // e.g. "HS-2"
  lat: number
  lng: number
  note: string
}

interface STBRApt {
  icao: string
  iata: string
  name: string
  lat: number
  lng: number
  smgcs: 1 | 2 | 3 | 4   // A-SMGCS level per ICAO Doc 9830
  lvpBand: 0 | 1 | 2 | 3 // 0=rare 1=occasional 2=frequent 3=chronic (per CODA LVP-days/yr)
  bars: StopBar[]
  hotspots: HotSpot[]
  precedent?: string     // canonical-accident or known-mode reference
}

// 18-airport STBR catalogue. Coordinates approximate per Jeppesen 10-9 / AIP charts.
// "bars" are runway-holding-position stopbar centroid offsets from runway end.
const APTS: STBRApt[] = [
  {
    icao:'LIML', iata:'LIN', name:'Milan Linate', lat:45.4458, lng:9.2763, smgcs:3, lvpBand:3,
    bars:[
      { id:'36L-R5', rwy:'36L', lat:45.4475, lng:9.2768, hdg:0,   taxiway:'R5' },
      { id:'36L-R6', rwy:'36L', lat:45.4495, lng:9.2767, hdg:0,   taxiway:'R6' },
      { id:'18R-R1', rwy:'18R', lat:45.4438, lng:9.2768, hdg:180, taxiway:'R1' },
    ],
    hotspots:[
      { id:'HS-1', lat:45.4475, lng:9.2768, note:'R5/R6 — Linate 2001 precedent — fog-day taxi confusion' },
    ],
    precedent:'SAS 686 MD-87 / Cessna XHE D-IEVX 2001-10-08 — 118 fatal — ANSV 2004 final',
  },
  {
    icao:'EGLL', iata:'LHR', name:'London Heathrow', lat:51.4706, lng:-0.4615, smgcs:4, lvpBand:3,
    bars:[
      { id:'27L-A1',  rwy:'27L', lat:51.4769, lng:-0.4324, hdg:270, taxiway:'A1' },
      { id:'27L-A10', rwy:'27L', lat:51.4744, lng:-0.4587, hdg:270, taxiway:'A10' },
      { id:'09R-S4',  rwy:'09R', lat:51.4775, lng:-0.4858, hdg:90,  taxiway:'S4' },
      { id:'09R-S2',  rwy:'09R', lat:51.4762, lng:-0.4664, hdg:90,  taxiway:'S2' },
      { id:'27R-A4',  rwy:'27R', lat:51.4647, lng:-0.4329, hdg:270, taxiway:'A4' },
      { id:'27R-A14', rwy:'27R', lat:51.4626, lng:-0.4517, hdg:270, taxiway:'A14' },
    ],
    hotspots:[
      { id:'HS-A', lat:51.4750, lng:-0.4500, note:'Block-50 hold A6 — readback confusion' },
      { id:'HS-B', lat:51.4636, lng:-0.4400, note:'B/27R intersection — congestion peak hour' },
    ],
    precedent:'BA 0238 holding short 27L night/LVP — AAIB Bull 4/2019 advisory',
  },
  {
    icao:'EHAM', iata:'AMS', name:'Amsterdam Schiphol', lat:52.3086, lng:4.7639, smgcs:4, lvpBand:3,
    bars:[
      { id:'18R-N5', rwy:'18R', lat:52.3636, lng:4.7117, hdg:180, taxiway:'N5' },
      { id:'18R-N6', rwy:'18R', lat:52.3608, lng:4.7124, hdg:180, taxiway:'N6' },
      { id:'36L-N1', rwy:'36L', lat:52.2944, lng:4.7290, hdg:0,   taxiway:'N1' },
      { id:'06-A3',  rwy:'06',  lat:52.3047, lng:4.7775, hdg:60,  taxiway:'A3' },
      { id:'24-A12', rwy:'24',  lat:52.3158, lng:4.7475, hdg:240, taxiway:'A12' },
    ],
    hotspots:[
      { id:'HS-1', lat:52.3068, lng:4.7732, note:'N4/N5 cross — Tenerife-style fog risk' },
    ],
  },
  {
    icao:'EDDF', iata:'FRA', name:'Frankfurt Main', lat:50.0264, lng:8.5431, smgcs:4, lvpBand:3,
    bars:[
      { id:'25C-N3',  rwy:'25C', lat:50.0405, lng:8.5840, hdg:250, taxiway:'N3' },
      { id:'25R-N12', rwy:'25R', lat:50.0257, lng:8.6068, hdg:250, taxiway:'N12' },
      { id:'07L-S5',  rwy:'07L', lat:50.0392, lng:8.5188, hdg:70,  taxiway:'S5' },
      { id:'07C-L3',  rwy:'07C', lat:50.0294, lng:8.5188, hdg:70,  taxiway:'L3' },
      { id:'18-NL2',  rwy:'18',  lat:50.0410, lng:8.5301, hdg:180, taxiway:'NL2' },
    ],
    hotspots:[
      { id:'HS-S', lat:50.0408, lng:8.5832, note:'N1/N3 cross-runway 25C/18 conflict' },
    ],
  },
  {
    icao:'LFPG', iata:'CDG', name:'Paris Charles de Gaulle', lat:49.0097, lng:2.5479, smgcs:4, lvpBand:3,
    bars:[
      { id:'08L-W6',  rwy:'08L', lat:49.0227, lng:2.5325, hdg:80,  taxiway:'W6' },
      { id:'26R-W14', rwy:'26R', lat:49.0263, lng:2.5826, hdg:260, taxiway:'W14' },
      { id:'09R-T8',  rwy:'09R', lat:49.0006, lng:2.5388, hdg:90,  taxiway:'T8' },
      { id:'27L-S1',  rwy:'27L', lat:49.0026, lng:2.5814, hdg:270, taxiway:'S1' },
    ],
    hotspots:[
      { id:'HS-1', lat:49.0090, lng:2.5500, note:'08L/26R cross-flow Sat AM rush' },
    ],
  },
  {
    icao:'KORD', iata:'ORD', name:'Chicago O\'Hare', lat:41.9742, lng:-87.9073, smgcs:4, lvpBand:2,
    bars:[
      { id:'10L-H6',  rwy:'10L', lat:41.9909, lng:-87.9358, hdg:100, taxiway:'H6' },
      { id:'28R-A4',  rwy:'28R', lat:41.9874, lng:-87.8865, hdg:280, taxiway:'A4' },
      { id:'09R-T10', rwy:'09R', lat:41.9655, lng:-87.9305, hdg:90,  taxiway:'T10' },
      { id:'27L-T2',  rwy:'27L', lat:41.9648, lng:-87.8767, hdg:270, taxiway:'T2' },
      { id:'10C-Y',   rwy:'10C', lat:41.9758, lng:-87.9322, hdg:100, taxiway:'Y' },
      { id:'04R-K7',  rwy:'04R', lat:41.9685, lng:-87.8910, hdg:40,  taxiway:'K7' },
    ],
    hotspots:[
      { id:'HS-1', lat:41.9756, lng:-87.9120, note:'F/H/T concourse-feed cross — Comair-LEX-class' },
      { id:'HS-2', lat:41.9810, lng:-87.9080, note:'10L/H6 readback — peak-hour' },
    ],
  },
  {
    icao:'KJFK', iata:'JFK', name:'New York JFK', lat:40.6398, lng:-73.7789, smgcs:4, lvpBand:2,
    bars:[
      { id:'04L-A',   rwy:'04L', lat:40.6203, lng:-73.7848, hdg:40,  taxiway:'A' },
      { id:'22R-KK',  rwy:'22R', lat:40.6452, lng:-73.7670, hdg:220, taxiway:'KK' },
      { id:'13L-B',   rwy:'13L', lat:40.6520, lng:-73.7900, hdg:130, taxiway:'B' },
      { id:'31R-K',   rwy:'31R', lat:40.6336, lng:-73.7568, hdg:310, taxiway:'K' },
      { id:'13R-J',   rwy:'13R', lat:40.6440, lng:-73.8002, hdg:130, taxiway:'J' },
    ],
    hotspots:[
      { id:'HS-1', lat:40.6390, lng:-73.7800, note:'Z/B/AA — peak-hr taxi-out queue' },
    ],
    precedent:'Multiple Cat-D events 2015-2023 — Port Authority safety-bulletin',
  },
  {
    icao:'KATL', iata:'ATL', name:'Atlanta Hartsfield-Jackson', lat:33.6367, lng:-84.4281, smgcs:4, lvpBand:2,
    bars:[
      { id:'08L-D9',  rwy:'08L', lat:33.6483, lng:-84.4396, hdg:80,  taxiway:'D9' },
      { id:'26R-V',   rwy:'26R', lat:33.6444, lng:-84.4111, hdg:260, taxiway:'V' },
      { id:'09L-D',   rwy:'09L', lat:33.6293, lng:-84.4396, hdg:90,  taxiway:'D' },
      { id:'27R-N',   rwy:'27R', lat:33.6354, lng:-84.4063, hdg:270, taxiway:'N' },
      { id:'09R-J7',  rwy:'09R', lat:33.6228, lng:-84.4421, hdg:90,  taxiway:'J7' },
      { id:'10-K',    rwy:'10',  lat:33.6188, lng:-84.4148, hdg:100, taxiway:'K' },
    ],
    hotspots:[
      { id:'HS-1', lat:33.6360, lng:-84.4280, note:'L-cross Concourse-T — 5-rwy parallel ops complexity' },
    ],
  },
  {
    icao:'KLAX', iata:'LAX', name:'Los Angeles LAX', lat:33.9425, lng:-118.4081, smgcs:3, lvpBand:1,
    bars:[
      { id:'25L-T',   rwy:'25L', lat:33.9485, lng:-118.4286, hdg:250, taxiway:'T' },
      { id:'25R-AA',  rwy:'25R', lat:33.9509, lng:-118.4263, hdg:250, taxiway:'AA' },
      { id:'24L-D',   rwy:'24L', lat:33.9354, lng:-118.4030, hdg:240, taxiway:'D' },
      { id:'24R-AA1', rwy:'24R', lat:33.9374, lng:-118.4039, hdg:240, taxiway:'AA1' },
    ],
    hotspots:[
      { id:'HS-7', lat:33.9477, lng:-118.4131, note:'Hot-Spot 7 — 25L/AA — multiple Cat-A near misses 2014/2017' },
    ],
    precedent:'AMX 489 vs SkyWest 5417 LAX 2014 — NTSB DCA14IA083',
  },
  {
    icao:'KSFO', iata:'SFO', name:'San Francisco SFO', lat:37.6189, lng:-122.3750, smgcs:4, lvpBand:2,
    bars:[
      { id:'28R-G',   rwy:'28R', lat:37.6203, lng:-122.3920, hdg:280, taxiway:'G' },
      { id:'28L-D',   rwy:'28L', lat:37.6260, lng:-122.3892, hdg:280, taxiway:'D' },
      { id:'10R-A',   rwy:'10R', lat:37.6263, lng:-122.3637, hdg:100, taxiway:'A' },
      { id:'10L-S',   rwy:'10L', lat:37.6196, lng:-122.3621, hdg:100, taxiway:'S' },
      { id:'01R-T',   rwy:'01R', lat:37.6126, lng:-122.3853, hdg:10,  taxiway:'T' },
    ],
    hotspots:[
      { id:'HS-A', lat:37.6233, lng:-122.3760, note:'28L/28R Twy-A cross — Asiana 214 area' },
      { id:'HS-B', lat:37.6189, lng:-122.3680, note:'Air-Canada 759 hot-spot 2017 near-collision Twy-C' },
    ],
    precedent:'AC 759 SFO 2017-07-07 — landed on Twy-C with 4 aircraft on it — NTSB AAR-18-01',
  },
  {
    icao:'KBOS', iata:'BOS', name:'Boston Logan', lat:42.3656, lng:-71.0096, smgcs:3, lvpBand:2,
    bars:[
      { id:'04R-N',   rwy:'04R', lat:42.3525, lng:-71.0153, hdg:40,  taxiway:'N' },
      { id:'22L-K',   rwy:'22L', lat:42.3782, lng:-71.0030, hdg:220, taxiway:'K' },
      { id:'33L-M',   rwy:'33L', lat:42.3589, lng:-71.0249, hdg:330, taxiway:'M' },
      { id:'15R-D',   rwy:'15R', lat:42.3691, lng:-71.0152, hdg:150, taxiway:'D' },
    ],
    hotspots:[
      { id:'HS-1', lat:42.3656, lng:-71.0096, note:'04R/22L cross-pattern complexity' },
    ],
  },
  {
    icao:'EDDM', iata:'MUC', name:'Munich Franz Josef Strauss', lat:48.3538, lng:11.7861, smgcs:4, lvpBand:3,
    bars:[
      { id:'08R-N20', rwy:'08R', lat:48.3361, lng:11.7448, hdg:80,  taxiway:'N20' },
      { id:'26L-L4',  rwy:'26L', lat:48.3417, lng:11.8133, hdg:260, taxiway:'L4' },
      { id:'08L-A8',  rwy:'08L', lat:48.3660, lng:11.7517, hdg:80,  taxiway:'A8' },
      { id:'26R-A19', rwy:'26R', lat:48.3735, lng:11.8200, hdg:260, taxiway:'A19' },
    ],
    hotspots:[
      { id:'HS-1', lat:48.3537, lng:11.7860, note:'Cross-runway N/L transition during LVP' },
    ],
  },
  {
    icao:'LSZH', iata:'ZRH', name:'Zurich Kloten', lat:47.4582, lng:8.5555, smgcs:4, lvpBand:3,
    bars:[
      { id:'14-E2',   rwy:'14',  lat:47.4831, lng:8.5527, hdg:140, taxiway:'E2' },
      { id:'32-B7',   rwy:'32',  lat:47.4458, lng:8.5410, hdg:320, taxiway:'B7' },
      { id:'16-D',    rwy:'16',  lat:47.4750, lng:8.5618, hdg:160, taxiway:'D' },
      { id:'28-C',    rwy:'28',  lat:47.4615, lng:8.5375, hdg:280, taxiway:'C' },
    ],
    hotspots:[
      { id:'HS-1', lat:47.4582, lng:8.5555, note:'14/16/28 triple-cross — Alpine fog season Oct-Mar' },
    ],
  },
  {
    icao:'EGKK', iata:'LGW', name:'London Gatwick', lat:51.1481, lng:-0.1903, smgcs:3, lvpBand:3,
    bars:[
      { id:'26L-A1',  rwy:'26L', lat:51.1542, lng:-0.1727, hdg:260, taxiway:'A1' },
      { id:'08R-J3',  rwy:'08R', lat:51.1485, lng:-0.2148, hdg:80,  taxiway:'J3' },
      { id:'26L-A4',  rwy:'26L', lat:51.1528, lng:-0.1875, hdg:260, taxiway:'A4' },
    ],
    hotspots:[
      { id:'HS-A', lat:51.1486, lng:-0.1900, note:'A4/J cross — winter LVP daily fog' },
    ],
  },
  {
    icao:'CYYZ', iata:'YYZ', name:'Toronto Pearson', lat:43.6772, lng:-79.6306, smgcs:3, lvpBand:2,
    bars:[
      { id:'05-D1',   rwy:'05',  lat:43.6620, lng:-79.6360, hdg:50,  taxiway:'D1' },
      { id:'23-Q4',   rwy:'23',  lat:43.6890, lng:-79.6213, hdg:230, taxiway:'Q4' },
      { id:'06L-H',   rwy:'06L', lat:43.6712, lng:-79.6500, hdg:60,  taxiway:'H' },
      { id:'24R-D5',  rwy:'24R', lat:43.6826, lng:-79.6068, hdg:240, taxiway:'D5' },
    ],
    hotspots:[
      { id:'HS-1', lat:43.6772, lng:-79.6306, note:'Q-line / 06L crossover — winter ops' },
    ],
  },
  {
    icao:'OMDB', iata:'DXB', name:'Dubai International', lat:25.2528, lng:55.3644, smgcs:4, lvpBand:1,
    bars:[
      { id:'30L-A3',  rwy:'30L', lat:25.2562, lng:55.3812, hdg:300, taxiway:'A3' },
      { id:'12R-N8',  rwy:'12R', lat:25.2492, lng:55.3477, hdg:120, taxiway:'N8' },
      { id:'30R-G7',  rwy:'30R', lat:25.2615, lng:55.3743, hdg:300, taxiway:'G7' },
      { id:'12L-M',   rwy:'12L', lat:25.2541, lng:55.3408, hdg:120, taxiway:'M' },
    ],
    hotspots:[
      { id:'HS-1', lat:25.2528, lng:55.3644, note:'30L/30R taxi-cross — high traffic density' },
    ],
  },
  {
    icao:'RJTT', iata:'HND', name:'Tokyo Haneda', lat:35.5500, lng:139.7800, smgcs:4, lvpBand:2,
    bars:[
      { id:'34R-C5',  rwy:'34R', lat:35.5390, lng:139.7843, hdg:340, taxiway:'C5' },
      { id:'16L-A',   rwy:'16L', lat:35.5612, lng:139.7757, hdg:160, taxiway:'A' },
      { id:'05-N',    rwy:'05',  lat:35.5470, lng:139.7723, hdg:50,  taxiway:'N' },
      { id:'23-W',    rwy:'23',  lat:35.5642, lng:139.7967, hdg:230, taxiway:'W' },
    ],
    hotspots:[
      { id:'HS-1', lat:35.5500, lng:139.7800, note:'C5/A — JAL 516 / Coast Guard MA722 2024-01-02 — 5 fatal' },
    ],
    precedent:'JAL 516 A350 vs JCG MA722 DHC-8 HND 2024-01-02 — JTSB AI2025 ongoing',
  },
  {
    icao:'VHHH', iata:'HKG', name:'Hong Kong International', lat:22.3081, lng:113.9152, smgcs:4, lvpBand:1,
    bars:[
      { id:'07R-A3',  rwy:'07R', lat:22.3142, lng:113.9015, hdg:70,  taxiway:'A3' },
      { id:'25L-A14', rwy:'25L', lat:22.3091, lng:113.9303, hdg:250, taxiway:'A14' },
      { id:'07L-V1',  rwy:'07L', lat:22.2997, lng:113.9015, hdg:70,  taxiway:'V1' },
      { id:'25R-V8',  rwy:'25R', lat:22.3043, lng:113.9290, hdg:250, taxiway:'V8' },
    ],
    hotspots:[
      { id:'HS-1', lat:22.3081, lng:113.9152, note:'07R/V cross — peak-hour parallel-rwy ops' },
    ],
  },
]

// === Helpers
function clamp(x: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, x)) }

function distM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const toR = Math.PI / 180
  const dLat = (lat2 - lat1) * toR
  const dLng = (lng2 - lng1) * toR
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*toR) * Math.cos(lat2*toR) * Math.sin(dLng/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}

function distNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return distM(lat1, lng1, lat2, lng2) / 1852
}

function dhash(s: string, salt: number): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < s.length; i++) { h = (h ^ s.charCodeAt(i)) * 16777619 }
  return (h >>> 0) / 0xffffffff
}

// Heading-difference (deg) — circular distance 0..180
function hdgDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

// === Synthesised conditions per airport ===
// RVR proxy = deterministic per-airport per-time-bucket hash → metres
function synthRvr(icao: string, lvpBand: number): { rvr: number; lvpActive: boolean } {
  const t = Math.floor(Date.now() / (5 * 60 * 1000)) // 5-min bucket
  const u = dhash(icao + ':' + t, 11)
  // LVP-band weights LVP-active probability
  const lvpProb = [0.04, 0.10, 0.18, 0.30][lvpBand]
  const lvpActive = u < lvpProb
  // RVR distribution: LVP → 100-550m, normal → 1500-9000m
  const rvr = lvpActive ? clamp(100 + u * 12000, 100, 550) : 1500 + u * 7500
  return { rvr, lvpActive }
}

// Bar-state proxy: under LVP, bars are armed (red) by default; cleared by ATC
// per-runway-end at ~25% probability per 5-min window.
function synthBarState(icao: string, barId: string, lvpActive: boolean): { armed: boolean; clearedAtMs: number | null } {
  if (!lvpActive) return { armed: false, clearedAtMs: null }
  const t = Math.floor(Date.now() / (5 * 60 * 1000))
  const u = dhash(icao + '|' + barId + ':' + t, 13)
  const cleared = u < 0.25
  return { armed: !cleared, clearedAtMs: cleared ? Date.now() - Math.floor(u * 300000) : null }
}

// === Flight interface
interface MFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: MFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

// === Phase classifier
function classifyPhase(f: MFlight, nearestBarM: number | null): Phase {
  if (!f.ground && f.altitudeFt > 200) return 'AIR'
  const gs = f.velocityKts
  // On runway proxy: very loose — actual surface classification requires PSR/ASDE
  // For our scoring we use GS + position relative to bar.
  if (f.ground) {
    if (gs < 3) return 'GATE'
    if (gs >= 3 && gs < 15) {
      if (nearestBarM !== null && nearestBarM < 80) return 'APPROACH-HOLD'
      return 'GROUND-TAXI'
    }
    if (gs >= 15 && gs < 40) {
      if (nearestBarM !== null && nearestBarM < 50) return 'PRE-LINEUP'
      return 'GROUND-TAXI'
    }
    if (gs >= 40 && gs < 80) return 'ROLL-INIT'
    if (gs >= 80) return 'ROLL-HIGH'
  }
  return 'AIR'
}

// === Row evaluator
interface Row {
  f: MFlight
  apt: STBRApt | null
  bar: StopBar | null
  barDistM: number
  barArmed: boolean
  hotspot: HotSpot | null
  hotspotDistM: number
  phase: Phase
  rvr: number
  lvpActive: boolean
  drivers: { BARSTATE: number; DISTANCE: number; CLEARANCE: number; GS_INTENT: number; PHASE: number; RVR_LVP: number; SMGCS: number; HOTSPOT: number }
  score: number
  tier: Tier
  notes: string[]
}

export default function StbrStopbar({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS' | 'BARS' | 'METHOD'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [aptFilter, setAptFilter] = useState<string>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [search, setSearch] = useState('')

  // sliders
  const [advMul, setAdvMul] = useState(1.0)
  const [scopeNm, setScopeNm] = useState(8)         // airport-snap radius NM
  const [barZoneM, setBarZoneM] = useState(150)     // bar standby-zone radius m
  const [lvpForce, setLvpForce] = useState<'AUTO' | 'ON' | 'OFF'>('AUTO')

  // layer toggles
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(false)
  const [shBars, setShBars] = useState(true)
  const [shHs, setShHs] = useState(true)
  const [shZone, setShZone] = useState(true)

  // === per-airframe rows
  const rows = useMemo(() => {
    const out: Row[] = []

    // Pre-resolve airport synthetic states
    const aptCache = new Map<string, { rvr: number; lvpActive: boolean }>()
    for (const a of APTS) {
      const s = synthRvr(a.icao, a.lvpBand)
      const eff = lvpForce === 'ON' ? { rvr: 200, lvpActive: true }
                : lvpForce === 'OFF' ? { rvr: 6000, lvpActive: false }
                : s
      aptCache.set(a.icao, eff)
    }

    for (const f of flights) {
      // Snap to nearest catalogue airport within scope-NM
      let apt: STBRApt | null = null
      let aptDist = Infinity
      for (const a of APTS) {
        const d = distNm(f.lat, f.lng, a.lat, a.lng)
        if (d < scopeNm && d < aptDist) { aptDist = d; apt = a }
      }
      if (!apt) continue

      const cond = aptCache.get(apt.icao)!

      // Find nearest stop-bar
      let bar: StopBar | null = null
      let barDistM = Infinity
      for (const b of apt.bars) {
        const d = distM(f.lat, f.lng, b.lat, b.lng)
        if (d < barDistM) { barDistM = d; bar = b }
      }
      if (!bar) continue

      // Find nearest hotspot
      let hotspot: HotSpot | null = null
      let hotspotDistM = Infinity
      for (const hs of apt.hotspots) {
        const d = distM(f.lat, f.lng, hs.lat, hs.lng)
        if (d < hotspotDistM) { hotspotDistM = d; hotspot = hs }
      }

      // Phase
      const phase = classifyPhase(f, barDistM)
      if (phase === 'AIR' || phase === 'LANDED' || phase === 'RWY-VACATE') {
        // Off-domain: airborne or vacating — push as OFF tier
        out.push({
          f, apt, bar, barDistM, barArmed: false,
          hotspot, hotspotDistM, phase,
          rvr: cond.rvr, lvpActive: cond.lvpActive,
          drivers: { BARSTATE: 0, DISTANCE: 0, CLEARANCE: 0, GS_INTENT: 0, PHASE: 0, RVR_LVP: 0, SMGCS: 0, HOTSPOT: 0 },
          score: 0, tier: 'OFF', notes: [],
        })
        continue
      }

      // Bar-state synthesis (LVP-conditional)
      const barState = synthBarState(apt.icao, bar.id, cond.lvpActive)
      const barArmed = barState.armed

      // === Drivers (0-100)
      // BARSTATE: armed-red bar → high score; cleared/extinguished → low
      let dBAR = 0
      if (barArmed && cond.lvpActive) dBAR = 80
      else if (barArmed && !cond.lvpActive) dBAR = 25 // some bars armed even non-LVP
      else dBAR = 5

      // DISTANCE: proximity to bar — 0..30m extreme, 30..150m standby, >150 normal
      let dDIST = 0
      if (barDistM < 15) dDIST = 95
      else if (barDistM < 40) dDIST = 75
      else if (barDistM < 80) dDIST = 50
      else if (barDistM < 150) dDIST = 28
      else if (barDistM < 400) dDIST = 12
      else dDIST = 3

      // CLEARANCE: proxy — time-since-bar-cleared. Recent clear (<60s ago) → low risk
      let dCLR = 0
      if (barArmed) dCLR = 70
      else if (barState.clearedAtMs && Date.now() - barState.clearedAtMs < 60000) dCLR = 8
      else dCLR = 22

      // GS-INTENT: ground-speed × alignment to bar-hdg (taxi-intent vector toward bar)
      const brgToBar = (Math.atan2(bar.lng - f.lng, bar.lat - f.lat) * 180 / Math.PI + 360) % 360
      const trkAlign = hdgDiff(f.track, brgToBar)
      const intentScalar = f.velocityKts * Math.cos(trkAlign * Math.PI / 180)
      let dGS = 0
      if (intentScalar > 10 && barDistM < 200) dGS = clamp(intentScalar * 4, 0, 90)
      else if (intentScalar > 2 && barDistM < 100) dGS = 45
      else dGS = 8

      // PHASE: incursion-relevant phases
      let dPHASE = 0
      if (phase === 'APPROACH-HOLD') dPHASE = 55
      else if (phase === 'PRE-LINEUP') dPHASE = 35
      else if (phase === 'GROUND-TAXI') dPHASE = 18
      else if (phase === 'LINEUP') dPHASE = 8
      else dPHASE = 4

      // RVR-LVP: LVP active is the multiplier
      let dRVR = 0
      if (cond.lvpActive && cond.rvr < 200) dRVR = 85
      else if (cond.lvpActive && cond.rvr < 350) dRVR = 65
      else if (cond.lvpActive) dRVR = 40
      else dRVR = 8

      // SMGCS: lower-level systems = higher residual risk
      const dSMGCS = [60, 40, 22, 10][apt.smgcs - 1] || 30

      // HOTSPOT proximity
      let dHS = 0
      if (hotspotDistM < 80) dHS = 70
      else if (hotspotDistM < 200) dHS = 40
      else if (hotspotDistM < 400) dHS = 18
      else dHS = 5

      const drivers = {
        BARSTATE: dBAR, DISTANCE: dDIST, CLEARANCE: dCLR, GS_INTENT: dGS,
        PHASE: dPHASE, RVR_LVP: dRVR, SMGCS: dSMGCS, HOTSPOT: dHS,
      }

      // Composite: max·0.62 + mean·0.38 × ADV
      const values = Object.values(drivers)
      const maxD = Math.max(...values)
      const meanD = values.reduce((a, b) => a + b, 0) / values.length
      let score = (maxD * 0.62 + meanD * 0.38) * advMul

      const notes: string[] = []

      // Hard escalators — Linate-mode triggers
      if (barArmed && barDistM < 15 && cond.lvpActive && phase !== 'GATE') {
        score = Math.max(score, 95)
        notes.push(`LINATE-MODE — crossed/inside armed stop-bar ${bar.id} (RVR ${cond.rvr.toFixed(0)}m LVP-active). CAT-A runway incursion per FAA ASRS / EASA SMS Class-A. STOP. Transmit position+intent to TWR per AIM 4-3-20.`)
      } else if (barArmed && barDistM < 40 && cond.lvpActive) {
        score = Math.max(score, 78)
        notes.push(`INCURSION-IMMINENT — within 40m of armed bar ${bar.id} under LVP. Verify clearance before any forward movement. Eurocontrol EAPPRI ed.4.0 §3.`)
      } else if (barArmed && barDistM < 80 && cond.lvpActive && intentScalar > 8) {
        score = Math.max(score, 62)
        notes.push(`HOLD-SHORT GATE — converging on armed bar at ${intentScalar.toFixed(1)}kt closure. Brake / readback bar-state explicitly per FAA AC 120-74B §5.`)
      } else if (hotspotDistM < 100 && cond.lvpActive) {
        score = Math.max(score, 48)
        notes.push(`HOT-SPOT ${hotspot?.id} — ${hotspot?.note}. Heightened lookout per ICAO Annex 14 §10.1.4.`)
      } else if (apt.icao === 'LIML' && cond.lvpActive && phase === 'GROUND-TAXI') {
        score = Math.max(score, 38)
        notes.push(`LIML LVP-active — Linate-precedent reminder. Confirm SMGCS guidance and explicit cross-clearance. ANSV 2004 §5.6.`)
      } else if (apt.icao === 'KSFO' && hotspotDistM < 200) {
        notes.push(`SFO HS-A/B AC-759 zone — verbal verify taxi-route. NTSB AAR-18-01 advisory.`)
      } else if (apt.icao === 'RJTT' && bar.id.startsWith('34R') && cond.lvpActive) {
        notes.push(`HND 34R/C5 — JAL 516 / JCG MA722 2024 precedent. Stop-bar discipline mandatory.`)
      }

      score = clamp(score, 0, 100)

      // Tier mapping
      let tier: Tier
      if (score >= 85) tier = 'INCURSION'
      else if (score >= 65) tier = 'CRITICAL'
      else if (score >= 45) tier = 'ARMED-ZONE'
      else if (score >= 22) tier = 'ELEVATED'
      else tier = 'COMPLIANT'

      out.push({
        f, apt, bar, barDistM, barArmed,
        hotspot, hotspotDistM, phase,
        rvr: cond.rvr, lvpActive: cond.lvpActive,
        drivers, score, tier, notes,
      })
    }

    out.sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return out
  }, [flights, advMul, scopeNm, barZoneM, lvpForce])

  // === MapLibre overlay
  useEffect(() => {
    if (!map) return
    const SRC = 'stbr-src'
    const SRC_BARS = 'stbr-bars-src'
    const SRC_HS = 'stbr-hs-src'
    const SRC_ZONE = 'stbr-zone-src'

    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
    }

    const writeAll = () => {
      ensureSrc(SRC); ensureSrc(SRC_BARS); ensureSrc(SRC_HS); ensureSrc(SRC_ZONE)
      const view = rows.filter(r =>
        (tierFilter === 'ALL' || r.tier === tierFilter) &&
        (aptFilter === 'ALL' || r.apt?.icao === aptFilter) &&
        (phaseFilter === 'ALL' || r.phase === phaseFilter)
      )
      const acFeats: any[] = []
      for (const r of view) {
        if (r.tier === 'OFF') continue
        acFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: {
            tier: r.tier, color: TIER_COLOR[r.tier], score: r.score,
            sz: 6 + (r.score / 100) * 16,
            label: `${r.f.callsign || r.f.icao} · ${r.apt?.iata} · ${r.bar?.id} · ${r.tier} ${r.score.toFixed(0)}`,
          }
        })
      }
      const barFeats: any[] = []
      const zoneFeats: any[] = []
      if (shBars || shZone) {
        const aptShown = new Set<string>()
        for (const r of rows) if (r.apt && r.lvpActive) aptShown.add(r.apt.icao)
        if (aptFilter !== 'ALL') aptShown.add(aptFilter)
        for (const a of APTS) {
          if (!aptShown.has(a.icao)) continue
          const cond = lvpForce === 'ON' || (lvpForce === 'AUTO' && synthRvr(a.icao, a.lvpBand).lvpActive)
          for (const b of a.bars) {
            const st = synthBarState(a.icao, b.id, cond)
            const color = st.armed ? '#f43f5e' : '#10b981'
            barFeats.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [b.lng, b.lat] },
              properties: { label: b.id, color, armed: st.armed }
            })
            if (shZone && st.armed) {
              // Standby zone circle (approx via small polygon)
              const ring = []
              const r0 = barZoneM / 111000
              for (let i = 0; i <= 24; i++) {
                const ang = (i / 24) * 2 * Math.PI
                ring.push([b.lng + Math.cos(ang) * r0 / Math.cos(b.lat * Math.PI / 180), b.lat + Math.sin(ang) * r0])
              }
              zoneFeats.push({
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [ring] },
                properties: { color }
              })
            }
          }
        }
      }
      const hsFeats: any[] = []
      if (shHs) {
        for (const a of APTS) {
          for (const hs of a.hotspots) {
            hsFeats.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [hs.lng, hs.lat] },
              properties: { label: `HOT ${hs.id}`, color: '#f59e0b' }
            })
          }
        }
      }

      ;(map.getSource(SRC) as any).setData({ type: 'FeatureCollection', features: shHalo || shPin || shLbl ? acFeats : [] })
      ;(map.getSource(SRC_BARS) as any).setData({ type: 'FeatureCollection', features: barFeats })
      ;(map.getSource(SRC_HS) as any).setData({ type: 'FeatureCollection', features: hsFeats })
      ;(map.getSource(SRC_ZONE) as any).setData({ type: 'FeatureCollection', features: zoneFeats })
    }

    ensureSrc(SRC); ensureSrc(SRC_BARS); ensureSrc(SRC_HS); ensureSrc(SRC_ZONE)

    if (!map.getLayer('stbr-zone-fill'))
      map.addLayer({ id: 'stbr-zone-fill', type: 'fill', source: SRC_ZONE, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.10 } })
    if (!map.getLayer('stbr-zone-line'))
      map.addLayer({ id: 'stbr-zone-line', type: 'line', source: SRC_ZONE, paint: { 'line-color': ['get', 'color'], 'line-width': 1.0, 'line-opacity': 0.55, 'line-dasharray': [3, 2] } })
    if (!map.getLayer('stbr-halo'))
      map.addLayer({ id: 'stbr-halo', type: 'circle', source: SRC, paint: { 'circle-radius': ['get', 'sz'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.3, 'circle-stroke-opacity': 0.8 } })
    if (!map.getLayer('stbr-pin'))
      map.addLayer({ id: 'stbr-pin', type: 'circle', source: SRC, filter: ['>=', ['get', 'score'], 60], paint: { 'circle-radius': 4.6, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0b0f17', 'circle-stroke-width': 1.2 } })
    if (!map.getLayer('stbr-lbl'))
      map.addLayer({ id: 'stbr-lbl', type: 'symbol', source: SRC, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#e2e8f0', 'text-halo-color': '#0b0f17', 'text-halo-width': 1.2 } })
    if (!map.getLayer('stbr-bars-pin'))
      map.addLayer({ id: 'stbr-bars-pin', type: 'circle', source: SRC_BARS, paint: { 'circle-radius': ['case', ['get', 'armed'], 5.5, 3.5], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0b0f17', 'circle-stroke-width': 1.0 } })
    if (!map.getLayer('stbr-bars-lbl'))
      map.addLayer({ id: 'stbr-bars-lbl', type: 'symbol', source: SRC_BARS, layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b0f17', 'text-halo-width': 1.1 } })
    if (!map.getLayer('stbr-hs-pin'))
      map.addLayer({ id: 'stbr-hs-pin', type: 'circle', source: SRC_HS, paint: { 'circle-radius': 4.8, 'circle-color': '#f59e0b', 'circle-opacity': 0.7, 'circle-stroke-color': '#0b0f17', 'circle-stroke-width': 1.0 } })
    if (!map.getLayer('stbr-hs-lbl'))
      map.addLayer({ id: 'stbr-hs-lbl', type: 'symbol', source: SRC_HS, layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, -1.6], 'text-anchor': 'bottom', 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#f59e0b', 'text-halo-color': '#0b0f17', 'text-halo-width': 1.1 } })

    writeAll()

    return () => {
      for (const id of ['stbr-lbl', 'stbr-pin', 'stbr-halo', 'stbr-bars-lbl', 'stbr-bars-pin', 'stbr-hs-lbl', 'stbr-hs-pin', 'stbr-zone-line', 'stbr-zone-fill']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_BARS, SRC_HS, SRC_ZONE]) {
        if (map.getSource(id)) map.removeSource(id)
      }
    }
  }, [map, rows, tierFilter, aptFilter, phaseFilter, shHalo, shPin, shLbl, shBars, shHs, shZone, lvpForce, barZoneM])

  // === Derived stats
  const visible = rows.filter(r =>
    (tierFilter === 'ALL' || r.tier === tierFilter) &&
    (aptFilter === 'ALL' || r.apt?.icao === aptFilter) &&
    (phaseFilter === 'ALL' || r.phase === phaseFilter) &&
    (!search || (r.f.callsign || r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.apt?.iata || '').toLowerCase().includes(search.toLowerCase()) || (r.bar?.id || '').toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { 'INCURSION': 0, 'CRITICAL': 0, 'ARMED-ZONE': 0, 'ELEVATED': 0, 'COMPLIANT': 0, 'OFF': 0 }
  for (const r of rows) counts[r.tier]++
  const lvpAptCount = APTS.filter(a => (lvpForce === 'ON' || (lvpForce === 'AUTO' && synthRvr(a.icao, a.lvpBand).lvpActive))).length
  const totalBars = APTS.reduce((s, a) => s + a.bars.length, 0)
  const muScore = rows.length ? rows.reduce((a, b) => a + b.score, 0) / rows.length : 0
  const worst = rows[0]

  // Per-airport stats
  const aptStats = APTS.map(a => {
    const rs = rows.filter(r => r.apt?.icao === a.icao)
    const inc = rs.filter(r => r.tier === 'INCURSION').length
    const crit = rs.filter(r => r.tier === 'CRITICAL').length
    const cond = lvpForce === 'ON' ? { rvr: 200, lvpActive: true } : lvpForce === 'OFF' ? { rvr: 6000, lvpActive: false } : synthRvr(a.icao, a.lvpBand)
    return { apt: a, count: rs.length, inc, crit, ...cond }
  }).sort((a, b) => (b.inc + b.crit) - (a.inc + a.crit) || b.count - a.count)

  return (
    <div className="fixed top-16 right-3 z-40 w-[500px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">STBR</span>
          <span className="text-[10px] text-slate-400">Stop-Bar Enforcement · ICAO Annex 14 §5.3.19 · Linate-mode · Doc 9476/9830</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* tier strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={() => setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter === t ? 'border' : 'border border-slate-700/60'}`} style={{ background: `${TIER_COLOR[t]}22`, borderColor: tierFilter === t ? TIER_COLOR[t] : undefined, color: TIER_COLOR[t] }}>{t.split('-')[0].slice(0, 4)} {counts[t]}</button>
        ))}
      </div>

      {/* summary cells */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">LVP-APTS</div><div className="font-mono" style={{ color: lvpAptCount > 3 ? TIER_COLOR['CRITICAL'] : lvpAptCount > 0 ? TIER_COLOR['ARMED-ZONE'] : '#cbd5e1' }}>{lvpAptCount} / {APTS.length}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">BARS</div><div className="text-slate-100 font-mono">{totalBars}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">INCURS</div><div className="font-mono" style={{ color: counts.INCURSION > 0 ? TIER_COLOR['INCURSION'] : '#cbd5e1' }}>{counts.INCURSION}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst && worst.tier !== 'OFF' ? (worst.f.callsign || worst.f.icao) : '—'}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul * 100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul * 100} onChange={e => setAdvMul(+e.target.value / 100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">SCOPE <span className="text-slate-200 font-mono">{scopeNm} NM</span>
            <input type="range" min="2" max="25" value={scopeNm} onChange={e => setScopeNm(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">BAR-ZONE <span className="text-slate-200 font-mono">{barZoneM} m</span>
            <input type="range" min="50" max="500" step="25" value={barZoneM} onChange={e => setBarZoneM(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] text-slate-400">LVP FORCE</span>
            <div className="flex gap-0.5">
              {(['AUTO', 'ON', 'OFF'] as const).map(v => (
                <button key={v} onClick={() => setLvpForce(v)} className={`flex-1 px-1 py-0.5 rounded text-[9px] font-mono ${lvpForce === v ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{v}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setAptFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${aptFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL-APT</button>
          {APTS.map(a => (
            <button key={a.icao} onClick={() => setAptFilter(a.icao)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${aptFilter === a.icao ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{a.iata}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setPhaseFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL-PH</button>
          {(['GROUND-TAXI', 'APPROACH-HOLD', 'PRE-LINEUP', 'LINEUP', 'ROLL-INIT', 'ROLL-HIGH', 'GATE'] as Phase[]).map(p => (
            <button key={p} onClick={() => setPhaseFilter(p)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter === p ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{PHASE_LABEL[p].toUpperCase().slice(0, 4)}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO', shHalo, setShHalo], ['PIN', shPin, setShPin], ['LBL', shLbl, setShLbl], ['BARS', shBars, setShBars], ['HOT', shHs, setShHs], ['ZONE', shZone, setShZone]].map(([n, v, fn]: any) => (
            <button key={n} onClick={() => fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="cs/apt/bar" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT', 'AIRPORTS', 'BARS', 'METHOD'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded ${tab === t ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && visible.filter(r => r.tier !== 'OFF').slice(0, 80).map((r, i) => (
          <div key={i} onClick={() => onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{r.f.callsign || r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type || '—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.apt?.iata}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{PHASE_LABEL[r.phase]}</span>
              {r.barArmed && <span className="px-1 rounded font-mono text-[9px]" style={{ background: '#f43f5e33', color: '#f43f5e' }}>BAR-RED</span>}
              {r.lvpActive && <span className="px-1 rounded font-mono text-[9px]" style={{ background: '#f59e0b33', color: '#f59e0b' }}>LVP</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background: `${TIER_COLOR[r.tier]}33`, color: TIER_COLOR[r.tier] }}>{r.tier.split('-')[0].slice(0, 5)} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>GS <span className="text-slate-100 font-mono">{r.f.velocityKts.toFixed(0)}kt</span></div>
              <div>BAR <span className="font-mono text-slate-100">{r.bar?.id}</span></div>
              <div>DIST <span className="font-mono" style={{ color: r.barDistM < 40 ? TIER_COLOR['INCURSION'] : r.barDistM < 150 ? TIER_COLOR['ARMED-ZONE'] : '#cbd5e1' }}>{r.barDistM < 1500 ? r.barDistM.toFixed(0) + 'm' : (r.barDistM / 1000).toFixed(1) + 'km'}</span></div>
              <div>RVR <span className="font-mono" style={{ color: r.rvr < 200 ? TIER_COLOR['INCURSION'] : r.rvr < 550 ? TIER_COLOR['ARMED-ZONE'] : '#cbd5e1' }}>{r.rvr.toFixed(0)}m</span></div>
            </div>
            {r.hotspot && r.hotspotDistM < 400 && (
              <div className="text-[10px] text-amber-400 mt-0.5">↳ HOT-{r.hotspot.id} · {r.hotspotDistM.toFixed(0)}m · <span className="text-slate-400 italic">{r.hotspot.note}</span></div>
            )}
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier], height: '100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k, v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v as number)}</span>
              ))}
            </div>
            {r.notes.length > 0 && <div className="mt-1 text-[9px]" style={{ color: TIER_COLOR[r.tier] }}>› {r.notes[0]}</div>}
            {r.notes.length === 0 && r.tier !== 'COMPLIANT' && <div className="mt-1 text-[9px] text-slate-500">› {TIER_ADVICE[r.tier]}</div>}
          </div>
        ))}
        {tab === 'AIRCRAFT' && visible.filter(r => r.tier !== 'OFF').length === 0 && (
          <div className="text-[10px] text-slate-500 italic px-2 py-4 text-center">No ground-traffic in stop-bar zone matching filters. Toggle LVP-FORCE: ON to seed test data.</div>
        )}

        {tab === 'AIRPORTS' && aptStats.map((s, i) => (
          <div key={i} onClick={() => setAptFilter(s.apt.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{s.apt.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-300">{s.apt.iata}</span>
              <span className="text-slate-400">{s.apt.name}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">SMGCS-L{s.apt.smgcs}</span>
              <span className="px-1 rounded font-mono text-[9px]" style={{ background: ['#47556922', '#0ea5e922', '#f59e0b22', '#f43f5e22'][s.apt.lvpBand], color: ['#475569', '#0ea5e9', '#f59e0b', '#f43f5e'][s.apt.lvpBand] }}>LVP-{s.apt.lvpBand}</span>
              {s.lvpActive && <span className="px-1 rounded font-mono text-[9px]" style={{ background: '#f59e0b33', color: '#f59e0b' }}>LVP-NOW</span>}
            </div>
            <div className="grid grid-cols-5 gap-1 mt-1 text-[10px]">
              <div>BARS <span className="font-mono text-slate-100">{s.apt.bars.length}</span></div>
              <div>HOT <span className="font-mono text-slate-100">{s.apt.hotspots.length}</span></div>
              <div>TRAFFIC <span className="font-mono text-slate-100">{s.count}</span></div>
              <div>INC <span className="font-mono" style={{ color: s.inc ? TIER_COLOR['INCURSION'] : '#cbd5e1' }}>{s.inc}</span></div>
              <div>RVR <span className="font-mono" style={{ color: s.rvr < 550 ? TIER_COLOR['ARMED-ZONE'] : '#cbd5e1' }}>{s.rvr.toFixed(0)}m</span></div>
            </div>
            {s.apt.precedent && <div className="text-[9px] mt-0.5 text-rose-300 italic">‼ {s.apt.precedent}</div>}
          </div>
        ))}

        {tab === 'BARS' && (
          <div className="space-y-1">
            <div className="text-[9px] text-slate-500 uppercase tracking-widest mb-1">Stop-Bar Topology · {totalBars} bars across {APTS.length} airports</div>
            {APTS.filter(a => aptFilter === 'ALL' || a.icao === aptFilter).map((a, i) => {
              const cond = lvpForce === 'ON' ? { rvr: 200, lvpActive: true } : lvpForce === 'OFF' ? { rvr: 6000, lvpActive: false } : synthRvr(a.icao, a.lvpBand)
              return (
                <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <span className="font-mono text-slate-100">{a.iata}</span>
                    <span className="text-slate-400">{a.name}</span>
                    {cond.lvpActive && <span className="px-1 rounded font-mono text-[9px]" style={{ background: '#f59e0b33', color: '#f59e0b' }}>LVP RVR-{cond.rvr.toFixed(0)}m</span>}
                  </div>
                  <div className="grid grid-cols-3 gap-1 mt-1">
                    {a.bars.map(b => {
                      const st = synthBarState(a.icao, b.id, cond.lvpActive)
                      return (
                        <div key={b.id} className="bg-slate-900/60 rounded px-1.5 py-0.5 text-[9px] flex items-center gap-1">
                          <span className="size-1.5 rounded-full" style={{ background: st.armed ? '#f43f5e' : '#10b981' }} />
                          <span className="font-mono text-slate-200">{b.id}</span>
                          <span className="text-slate-500 ml-auto">{b.hdg.toString().padStart(3, '0')}°</span>
                        </div>
                      )
                    })}
                  </div>
                  {a.hotspots.length > 0 && (
                    <div className="mt-1 text-[9px] text-amber-300">⚠ {a.hotspots.length} hot-spot{a.hotspots.length > 1 ? 's' : ''} · {a.hotspots.map(h => h.id).join(' / ')}</div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-300 leading-relaxed">
            <div>
              <div className="text-sky-300 font-mono mb-1">REGULATORY REGIME</div>
              <div className="text-slate-400">
                Per ICAO Annex 14 Vol I §5.3.19 §5.3.20 §5.3.21, illuminated red stop-bars are MANDATORY at all runway-holding positions on instrument runways when RVR ≤550 m operations are permitted. The interlocked centreline-lights (§5.3.19.3) extinguish past an armed bar and illuminate green only when the bar is extinguished by ATC.
              </div>
            </div>
            <div>
              <div className="text-sky-300 font-mono mb-1">SCORING MODEL</div>
              <div className="text-slate-400">
                8 drivers — BARSTATE (armed-red), DISTANCE (m to nearest bar centroid), CLEARANCE (time-since-clear proxy), GS-INTENT (taxi-intent vector toward bar), PHASE, RVR-LVP (LVP activation level), SMGCS (A-SMGCS Level 1-4 per ICAO Doc 9830), HOTSPOT (proximity to published incursion hotspot). Composite max·0.62 + mean·0.38 × ADV.
              </div>
            </div>
            <div>
              <div className="text-sky-300 font-mono mb-1">HARD ESCALATORS</div>
              <div className="text-slate-400">
                • Crossed/inside armed bar (&lt;15m) + LVP-active + not at gate → 95 (LINATE-MODE Cat-A) <br />
                • Within 40m of armed bar + LVP → 78 (INCURSION-IMMINENT) <br />
                • Within 80m + intent-vector &gt;8kt closure + LVP → 62 (HOLD-SHORT GATE) <br />
                • Within 100m of published hotspot + LVP → 48
              </div>
            </div>
            <div>
              <div className="text-sky-300 font-mono mb-1">CANONICAL PRECEDENTS</div>
              <div className="text-slate-400 space-y-0.5">
                <div>• <span className="text-rose-300 font-mono">LIML 2001-10-08</span> SAS 686 / Cessna XHE — 118 fatal — ANSV 2004 final. The canonical Linate-mode event that drove ICAO Doc 9476 SMGCS upgrade.</div>
                <div>• <span className="text-rose-300 font-mono">KSFO 2017-07-07</span> Air Canada 759 — landed on Twy-C with 4 aircraft on it — NTSB AAR-18-01.</div>
                <div>• <span className="text-rose-300 font-mono">KLEX 2006-08-27</span> Comair 5191 CRJ — wrong runway departure 26 fatal — NTSB AAR-07-05.</div>
                <div>• <span className="text-rose-300 font-mono">KLAX 2014-09-21</span> AMX 489 vs SkyWest 5417 near-collision — NTSB DCA14IA083.</div>
                <div>• <span className="text-rose-300 font-mono">RJTT 2024-01-02</span> JAL 516 A350 vs JCG MA722 DHC-8 — 5 fatal — JTSB ongoing AI2025.</div>
              </div>
            </div>
            <div>
              <div className="text-sky-300 font-mono mb-1">DISTINCT FROM</div>
              <div className="text-slate-400">
                RWSL (REL/THL/RIL runway-status pavement lights — different lighting subsystem), ASDE-X (surface-movement radar coverage map), HOTSPOT (cartographic registry only), RAAS (aural runway-identity callouts), LVTO (departure RVR-minima ladder), LAHSO (land-and-hold-short operations), MSAW (controller-side low-altitude). STBR uniquely scores stop-bar compliance under LVP regime.
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-700/60 text-[9px] text-slate-500 font-mono">
        SCOPE {scopeNm}NM · {visible.length}/{rows.length} visible · {lvpAptCount} LVP-APT
      </div>
    </div>
  )
}
