'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   RWSL · Runway Status Lights surface-movement conflict monitor
   ------------------------------------------------------------
   Per-airframe surface-movement conflict scorer for the FAA
   Runway Status Light System (RWSL) — a fully automated, sensor-
   driven (ASDE-X/ASSC/STARS) airport surface conflict-alerting
   light system that directly illuminates pavement-embedded
   red lights warning pilots and vehicle operators of unsafe
   runway entry or take-off conditions, independent of ATC
   instructions and procedures.

   Three light subsystems modelled here:

     · REL  Runway Entrance Lights — embedded in every taxiway
            centreline crossing a runway. Illuminate red when a
            high-speed arrival or departure is on or about to
            reach the runway, warning crossing traffic to STOP.
            Per FAA Order 6850.2B App F, JO 7110.65 §3-1-12.

     · THL  Takeoff Hold Lights — embedded in the runway
            centreline of the departure end (within 1500 ft of
            threshold). Illuminate red ahead of an aircraft in
            take-off position when the runway is occupied by
            another arrival or runway-crossing traffic. Per FAA
            AC 150/5340-30J ch 14.5, JO 6850.2B App G.

     · RIL  Runway Intersection Lights — embedded across the
            intersecting runway at every active runway-runway
            intersection. Illuminate red ahead of a take-off
            roll when traffic is on or about to cross the
            intersecting runway. Per FAA RWSL ConOps ed.4.

   Catalogue covers 23 FAA-certified RWSL airports operational
   per FAA RWSL Site Implementation Plan (KATL/KBOS/KBWI/KCLT/
   KDCA/KDFW/KDTW/KEWR/KFLL/KIAD/KJFK/KLAS/KLAX/KLGA/KMCO/KMDW/
   KMSP/KORD/KPHL/KPHX/KSAN/KSEA/KSFO) plus modelled extensions
   for NRC-Canada RWSL trial CYYZ and JCAB RJTT/RJBB ASSC-RWSL.

   Each airport has a list of monitored runways with thresholds,
   QFU magnetic bearing, length-ft, intersecting-runway list,
   plus tower-cab REL/THL/RIL count per FAA RWSL site as-built.

   Per-airframe analysis:
     · Map each tracked target onto its runway via along-track /
       cross-track decomposition from threshold along QFU axis.
     · Classify phase: ARRIVAL (airborne <1500AGL within 4nm),
       TOUCHDOWN (on RWY <60kt), ROLL (on RWY >60kt), TAKEOFF
       (on RWY >100kt accelerating), HOLDING-SHORT (on taxiway
       within 60ft of edge), CROSSING (transiting RWY 90°),
       TAXI (other ground), AIRBORNE-DEP (off RWY climbing).
     · Detect REL trigger: any RWY occupant (TOUCHDOWN/ROLL/
       TAKEOFF) or imminent arrival (ARRIVAL within 30s) plus
       any traffic HOLDING-SHORT → REL illuminates → conflict.
     · Detect THL trigger: target in TAKEOFF position (within
       1500ft of departure threshold, <60kt) plus second
       target on same RWY downfield → THL illuminates.
     · Detect RIL trigger: target on TAKEOFF roll plus second
       target on intersecting RWY (occupant or imminent arr).

   6 risk drivers (max-driver composite, 0-100):
     · REL  REL-triggered traffic in conflict (occupant + holder)
     · THL  THL-triggered (departure roll-out + downfield ac)
     · RIL  RIL-triggered (departure + crossing-rwy traffic)
     · GEO  geometry: range to threshold / runway centreline
     · SPD  closure rate weight (HOLD vs TAKEOFF differential)
     · PHA  phase-criticality (TAKEOFF/TOUCHDOWN x1.4)

   5 tiers:
     · STOP      score ≥80 OR THL/RIL active rose ABORT/STOP
     · HOLD-PAD  score ≥55 OR REL active rose-pink HOLD SHORT
     · CAUTION   score ≥35 amber monitor RWSL state
     · ADVISORY  score ≥18 sky tower briefing recommended
     · CLEAR     emerald no RWSL trigger / IDLE slate

   References:
     · FAA AC 150/5340-30J ch 14 RWSL Installation
     · FAA Order JO 7110.65AA §3-1-12 Runway Status Lights
     · FAA Order 6850.2B Maintenance of Airport Lighting
     · FAA RWSL Concept of Operations Edition 4.0 (2018)
     · FAA RWSL Site Implementation Plan Rev-G (2021)
     · FAA Engineering Brief 88 RWSL
     · FAA AIM 2-1-6 Surface Movement Guidance Lighting
     · ICAO Annex 14 Vol I §5.3.23 Stop-Bar / RWSL hooks
     · ICAO Doc 9476 Manual of SMGCS §6 Stop-Bar
     · ICAO Doc 9830 A-SMGCS ch 5 Conflict Alerting
     · ICAO Doc 4444 PANS-ATM §7.4 Runway operations
     · EUROCONTROL Runway Safety Action Plan ed.2 2024
     · NATS Heathrow Runway Incursion Mitigation 2021
     · NRC-Canada CYYZ RWSL Trial Report 2019
     · JCAB ASSC-RWSL RJTT operational report 2022
     · NTSB AAR-91-08 USAir 1493 LAX 32L (RWSL motivator)
     · NTSB AAR-08-02 Comair 5191 LEX (wrong runway)
     · NTSB DCA17IA148 Air Canada AC759 SFO 28R taxiway
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'STOP' | 'HOLD-PAD' | 'CAUTION' | 'ADVISORY' | 'CLEAR' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  STOP: '#ef4444', 'HOLD-PAD': '#f43f5e', CAUTION: '#f59e0b', ADVISORY: '#0ea5e9', CLEAR: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['STOP', 'HOLD-PAD', 'CAUTION', 'ADVISORY', 'CLEAR']
const TIER_RANK: Record<Tier, number> = { STOP: 0, 'HOLD-PAD': 1, CAUTION: 2, ADVISORY: 3, CLEAR: 4, IDLE: 5 }

type Phase = 'TAKEOFF' | 'ROLL' | 'TOUCHDOWN' | 'ARRIVAL' | 'HOLDING-SHORT' | 'CROSSING' | 'TAXI' | 'AIRBORNE-DEP' | 'IDLE'
const PHASE_COLOR: Record<Phase, string> = {
  TAKEOFF: '#ef4444', ROLL: '#f43f5e', TOUCHDOWN: '#f59e0b', ARRIVAL: '#0ea5e9',
  'HOLDING-SHORT': '#a855f7', CROSSING: '#ec4899', TAXI: '#64748b', 'AIRBORNE-DEP': '#10b981', IDLE: '#475569',
}

/* ----- RWSL airport catalogue ----- */
interface Rwy {
  id: string                  // e.g. '04R/22L'
  thr: { lat: number; lng: number } // primary-end threshold
  qfu: number                 // magnetic bearing primary direction
  lenFt: number
  intersects: string[]        // intersecting runway IDs at this airport
  rels: number                // installed REL fixtures (taxiway intersections)
  thls: boolean               // THL installed at primary end
  rils: boolean               // RIL installed at intersections
}
interface RwslApt {
  icao: string; iata?: string; name: string; country: string
  runways: Rwy[]
}
const APTS: RwslApt[] = [
  { icao: 'KATL', iata: 'ATL', name: 'Atlanta-Hartsfield', country: 'US', runways: [
    { id: '08L/26R', thr: { lat: 33.6457, lng: -84.4474 }, qfu: 87, lenFt: 9000,  intersects: [],            rels: 8,  thls: true, rils: false },
    { id: '08R/26L', thr: { lat: 33.6300, lng: -84.4513 }, qfu: 87, lenFt: 11890, intersects: [],            rels: 9,  thls: true, rils: false },
    { id: '09L/27R', thr: { lat: 33.6404, lng: -84.4255 }, qfu: 87, lenFt: 9000,  intersects: [],            rels: 7,  thls: true, rils: false },
    { id: '10/28',   thr: { lat: 33.6249, lng: -84.4140 }, qfu: 96, lenFt: 9000,  intersects: [],            rels: 8,  thls: true, rils: false },
  ] },
  { icao: 'KBOS', iata: 'BOS', name: 'Boston-Logan', country: 'US', runways: [
    { id: '04L/22R', thr: { lat: 42.3568, lng: -71.0123 }, qfu: 40,  lenFt: 7861, intersects: ['09/27','15R/33L','14/32'], rels: 6, thls: true, rils: true },
    { id: '04R/22L', thr: { lat: 42.3550, lng: -71.0049 }, qfu: 40,  lenFt: 10081,intersects: ['09/27','15R/33L','14/32'], rels: 7, thls: true, rils: true },
    { id: '09/27',   thr: { lat: 42.3635, lng: -71.0210 }, qfu: 88,  lenFt: 7000, intersects: ['04L/22R','04R/22L'], rels: 5, thls: true, rils: true },
    { id: '15R/33L', thr: { lat: 42.3699, lng: -71.0118 }, qfu: 149, lenFt: 10005,intersects: ['04L/22R','04R/22L','09/27'], rels: 6, thls: true, rils: true },
  ] },
  { icao: 'KBWI', iata: 'BWI', name: 'Baltimore', country: 'US', runways: [
    { id: '10/28',   thr: { lat: 39.1779, lng: -76.6917 }, qfu: 96,  lenFt: 10520, intersects: ['15R/33L'], rels: 5, thls: true, rils: true },
    { id: '15R/33L', thr: { lat: 39.1855, lng: -76.6814 }, qfu: 152, lenFt: 9501,  intersects: ['10/28'],   rels: 6, thls: true, rils: true },
  ] },
  { icao: 'KCLT', iata: 'CLT', name: 'Charlotte', country: 'US', runways: [
    { id: '18C/36C', thr: { lat: 35.2369, lng: -80.9485 }, qfu: 180, lenFt: 10000, intersects: ['05/23'], rels: 7, thls: true, rils: true },
    { id: '18L/36R', thr: { lat: 35.2358, lng: -80.9590 }, qfu: 180, lenFt: 9000,  intersects: [],        rels: 5, thls: true, rils: false },
    { id: '18R/36L', thr: { lat: 35.2402, lng: -80.9374 }, qfu: 180, lenFt: 8675,  intersects: [],        rels: 6, thls: true, rils: false },
  ] },
  { icao: 'KDCA', iata: 'DCA', name: 'Washington-Reagan', country: 'US', runways: [
    { id: '01/19',   thr: { lat: 38.8453, lng: -77.0405 }, qfu: 14,  lenFt: 7169, intersects: ['15/33'], rels: 5, thls: true, rils: true },
    { id: '15/33',   thr: { lat: 38.8580, lng: -77.0392 }, qfu: 152, lenFt: 5204, intersects: ['01/19'], rels: 4, thls: true, rils: true },
  ] },
  { icao: 'KDFW', iata: 'DFW', name: 'Dallas-Fort Worth', country: 'US', runways: [
    { id: '17C/35C', thr: { lat: 32.9123, lng: -97.0303 }, qfu: 175, lenFt: 13401, intersects: [], rels: 8, thls: true, rils: false },
    { id: '17L/35R', thr: { lat: 32.9143, lng: -97.0006 }, qfu: 175, lenFt: 8500,  intersects: [], rels: 6, thls: true, rils: false },
    { id: '17R/35L', thr: { lat: 32.9234, lng: -97.0444 }, qfu: 175, lenFt: 13401, intersects: [], rels: 8, thls: true, rils: false },
    { id: '18L/36R', thr: { lat: 32.9013, lng: -97.0162 }, qfu: 184, lenFt: 13401, intersects: [], rels: 8, thls: true, rils: false },
    { id: '18R/36L', thr: { lat: 32.9131, lng: -97.0521 }, qfu: 184, lenFt: 13401, intersects: [], rels: 8, thls: true, rils: false },
  ] },
  { icao: 'KDTW', iata: 'DTW', name: 'Detroit', country: 'US', runways: [
    { id: '04L/22R', thr: { lat: 42.2046, lng: -83.3470 }, qfu: 41,  lenFt: 12000, intersects: ['09L/27R','09R/27L'], rels: 6, thls: true, rils: true },
    { id: '04R/22L', thr: { lat: 42.2102, lng: -83.3208 }, qfu: 41,  lenFt: 10000, intersects: ['09L/27R','09R/27L'], rels: 6, thls: true, rils: true },
    { id: '09L/27R', thr: { lat: 42.2278, lng: -83.3582 }, qfu: 87,  lenFt: 8500,  intersects: ['04L/22R','04R/22L'], rels: 5, thls: true, rils: true },
  ] },
  { icao: 'KEWR', iata: 'EWR', name: 'Newark', country: 'US', runways: [
    { id: '04L/22R', thr: { lat: 40.6789, lng: -74.1834 }, qfu: 40, lenFt: 11000, intersects: ['11/29'], rels: 6, thls: true, rils: true },
    { id: '04R/22L', thr: { lat: 40.6796, lng: -74.1701 }, qfu: 40, lenFt: 10000, intersects: ['11/29'], rels: 6, thls: true, rils: true },
    { id: '11/29',   thr: { lat: 40.7000, lng: -74.1810 }, qfu: 109, lenFt: 6800, intersects: ['04L/22R','04R/22L'], rels: 5, thls: true, rils: true },
  ] },
  { icao: 'KFLL', iata: 'FLL', name: 'Fort Lauderdale', country: 'US', runways: [
    { id: '10L/28R', thr: { lat: 26.0743, lng: -80.1717 }, qfu: 91, lenFt: 9000, intersects: [], rels: 5, thls: true, rils: false },
    { id: '10R/28L', thr: { lat: 26.0625, lng: -80.1681 }, qfu: 91, lenFt: 8000, intersects: [], rels: 5, thls: true, rils: false },
  ] },
  { icao: 'KIAD', iata: 'IAD', name: 'Washington-Dulles', country: 'US', runways: [
    { id: '01R/19L', thr: { lat: 38.9290, lng: -77.4488 }, qfu: 12, lenFt: 11500, intersects: ['12/30'], rels: 6, thls: true, rils: true },
    { id: '01C/19C', thr: { lat: 38.9275, lng: -77.4670 }, qfu: 12, lenFt: 11500, intersects: ['12/30'], rels: 6, thls: true, rils: true },
    { id: '01L/19R', thr: { lat: 38.9303, lng: -77.4779 }, qfu: 12, lenFt: 9400,  intersects: [],        rels: 5, thls: true, rils: false },
    { id: '12/30',   thr: { lat: 38.9472, lng: -77.4660 }, qfu: 122, lenFt: 10501, intersects: ['01R/19L','01C/19C'], rels: 6, thls: true, rils: true },
  ] },
  { icao: 'KJFK', iata: 'JFK', name: 'New York-JFK', country: 'US', runways: [
    { id: '04L/22R', thr: { lat: 40.6224, lng: -73.7836 }, qfu: 40, lenFt: 12079, intersects: ['13L/31R','13R/31L'], rels: 7, thls: true, rils: true },
    { id: '04R/22L', thr: { lat: 40.6260, lng: -73.7704 }, qfu: 40, lenFt: 8400,  intersects: ['13L/31R','13R/31L'], rels: 6, thls: true, rils: true },
    { id: '13L/31R', thr: { lat: 40.6531, lng: -73.7918 }, qfu: 124, lenFt: 10000, intersects: ['04L/22R','04R/22L'], rels: 6, thls: true, rils: true },
    { id: '13R/31L', thr: { lat: 40.6463, lng: -73.7821 }, qfu: 124, lenFt: 14572, intersects: ['04L/22R','04R/22L'], rels: 8, thls: true, rils: true },
  ] },
  { icao: 'KLAS', iata: 'LAS', name: 'Las Vegas-Harry Reid', country: 'US', runways: [
    { id: '01L/19R', thr: { lat: 36.0606, lng: -115.1556 }, qfu: 13, lenFt: 8985, intersects: ['08L/26R'], rels: 5, thls: true, rils: true },
    { id: '01R/19L', thr: { lat: 36.0731, lng: -115.1422 }, qfu: 13, lenFt: 9775, intersects: ['08L/26R','08R/26L'], rels: 6, thls: true, rils: true },
    { id: '08L/26R', thr: { lat: 36.0832, lng: -115.1641 }, qfu: 84, lenFt: 14515, intersects: ['01L/19R','01R/19L'], rels: 7, thls: true, rils: true },
    { id: '08R/26L', thr: { lat: 36.0792, lng: -115.1633 }, qfu: 84, lenFt: 10523, intersects: ['01R/19L'], rels: 6, thls: true, rils: true },
  ] },
  { icao: 'KLAX', iata: 'LAX', name: 'Los Angeles', country: 'US', runways: [
    { id: '06L/24R', thr: { lat: 33.9491, lng: -118.4313 }, qfu: 69, lenFt: 8926, intersects: [], rels: 6, thls: true, rils: false },
    { id: '06R/24L', thr: { lat: 33.9444, lng: -118.4314 }, qfu: 69, lenFt: 10285, intersects: [], rels: 7, thls: true, rils: false },
    { id: '07L/25R', thr: { lat: 33.9367, lng: -118.4192 }, qfu: 69, lenFt: 12091, intersects: [], rels: 8, thls: true, rils: false },
    { id: '07R/25L', thr: { lat: 33.9319, lng: -118.4192 }, qfu: 69, lenFt: 11095, intersects: [], rels: 7, thls: true, rils: false },
  ] },
  { icao: 'KLGA', iata: 'LGA', name: 'New York-LaGuardia', country: 'US', runways: [
    { id: '04/22',   thr: { lat: 40.7700, lng: -73.8881 }, qfu: 31, lenFt: 7003, intersects: ['13/31'], rels: 5, thls: true, rils: true },
    { id: '13/31',   thr: { lat: 40.7807, lng: -73.8916 }, qfu: 134, lenFt: 7001, intersects: ['04/22'], rels: 5, thls: true, rils: true },
  ] },
  { icao: 'KMCO', iata: 'MCO', name: 'Orlando', country: 'US', runways: [
    { id: '17L/35R', thr: { lat: 28.4516, lng: -81.3088 }, qfu: 178, lenFt: 9001, intersects: [], rels: 5, thls: true, rils: false },
    { id: '17R/35L', thr: { lat: 28.4506, lng: -81.3260 }, qfu: 178, lenFt: 12005, intersects: [], rels: 6, thls: true, rils: false },
    { id: '18L/36R', thr: { lat: 28.4361, lng: -81.3023 }, qfu: 184, lenFt: 10000, intersects: [], rels: 5, thls: true, rils: false },
  ] },
  { icao: 'KMDW', iata: 'MDW', name: 'Chicago-Midway', country: 'US', runways: [
    { id: '04L/22R', thr: { lat: 41.7795, lng: -87.7574 }, qfu: 42, lenFt: 5507, intersects: ['13C/31C','13L/31R'], rels: 4, thls: true, rils: true },
    { id: '13C/31C', thr: { lat: 41.7895, lng: -87.7596 }, qfu: 132, lenFt: 6522, intersects: ['04L/22R','04R/22L'], rels: 5, thls: true, rils: true },
  ] },
  { icao: 'KMSP', iata: 'MSP', name: 'Minneapolis-St Paul', country: 'US', runways: [
    { id: '12L/30R', thr: { lat: 44.8763, lng: -93.2199 }, qfu: 122, lenFt: 8200, intersects: ['04/22','17/35'], rels: 6, thls: true, rils: true },
    { id: '12R/30L', thr: { lat: 44.8729, lng: -93.2247 }, qfu: 122, lenFt: 11006, intersects: ['04/22','17/35'], rels: 6, thls: true, rils: true },
    { id: '17/35',   thr: { lat: 44.9023, lng: -93.2192 }, qfu: 174, lenFt: 8000, intersects: ['12L/30R','12R/30L'], rels: 5, thls: true, rils: true },
  ] },
  { icao: 'KORD', iata: 'ORD', name: 'Chicago-OHare', country: 'US', runways: [
    { id: '09L/27R', thr: { lat: 41.9882, lng: -87.9112 }, qfu: 90,  lenFt: 7967, intersects: [], rels: 6, thls: true, rils: false },
    { id: '09R/27L', thr: { lat: 41.9787, lng: -87.9234 }, qfu: 90,  lenFt: 7500, intersects: [], rels: 5, thls: true, rils: false },
    { id: '10L/28R', thr: { lat: 41.9745, lng: -87.9080 }, qfu: 100, lenFt: 13000, intersects: [], rels: 8, thls: true, rils: false },
    { id: '10C/28C', thr: { lat: 41.9810, lng: -87.9080 }, qfu: 100, lenFt: 10800, intersects: [], rels: 7, thls: true, rils: false },
    { id: '10R/28L', thr: { lat: 41.9869, lng: -87.9080 }, qfu: 100, lenFt: 7500, intersects: [], rels: 5, thls: true, rils: false },
  ] },
  { icao: 'KPHL', iata: 'PHL', name: 'Philadelphia', country: 'US', runways: [
    { id: '08/26',   thr: { lat: 39.8784, lng: -75.2581 }, qfu: 89,  lenFt: 5460, intersects: ['09L/27R'], rels: 4, thls: true, rils: true },
    { id: '09L/27R', thr: { lat: 39.8729, lng: -75.2509 }, qfu: 95,  lenFt: 9500, intersects: ['08/26'],   rels: 6, thls: true, rils: true },
    { id: '09R/27L', thr: { lat: 39.8688, lng: -75.2509 }, qfu: 95,  lenFt: 12000, intersects: [],         rels: 7, thls: true, rils: false },
  ] },
  { icao: 'KPHX', iata: 'PHX', name: 'Phoenix-Sky Harbor', country: 'US', runways: [
    { id: '07L/25R', thr: { lat: 33.4373, lng: -112.0218 }, qfu: 76, lenFt: 11489, intersects: [], rels: 7, thls: true, rils: false },
    { id: '07R/25L', thr: { lat: 33.4264, lng: -112.0238 }, qfu: 76, lenFt: 10300, intersects: [], rels: 6, thls: true, rils: false },
    { id: '08/26',   thr: { lat: 33.4316, lng: -112.0103 }, qfu: 79, lenFt: 7800, intersects: [], rels: 5, thls: true, rils: false },
  ] },
  { icao: 'KSAN', iata: 'SAN', name: 'San Diego', country: 'US', runways: [
    { id: '09/27',   thr: { lat: 32.7338, lng: -117.1933 }, qfu: 89, lenFt: 9401, intersects: [], rels: 5, thls: true, rils: false },
  ] },
  { icao: 'KSEA', iata: 'SEA', name: 'Seattle-Tacoma', country: 'US', runways: [
    { id: '16L/34R', thr: { lat: 47.4750, lng: -122.3120 }, qfu: 178, lenFt: 11901, intersects: [], rels: 6, thls: true, rils: false },
    { id: '16C/34C', thr: { lat: 47.4683, lng: -122.3088 }, qfu: 178, lenFt: 9426, intersects: [], rels: 6, thls: true, rils: false },
    { id: '16R/34L', thr: { lat: 47.4647, lng: -122.3210 }, qfu: 178, lenFt: 8500, intersects: [], rels: 5, thls: true, rils: false },
  ] },
  { icao: 'KSFO', iata: 'SFO', name: 'San Francisco', country: 'US', runways: [
    { id: '01L/19R', thr: { lat: 37.6266, lng: -122.3937 }, qfu: 11, lenFt: 7651, intersects: ['10L/28R','10R/28L'], rels: 5, thls: true, rils: true },
    { id: '01R/19L', thr: { lat: 37.6271, lng: -122.3849 }, qfu: 11, lenFt: 8650, intersects: ['10L/28R','10R/28L'], rels: 5, thls: true, rils: true },
    { id: '10L/28R', thr: { lat: 37.6189, lng: -122.3917 }, qfu: 117, lenFt: 11870, intersects: ['01L/19R','01R/19L'], rels: 7, thls: true, rils: true },
    { id: '10R/28L', thr: { lat: 37.6131, lng: -122.3893 }, qfu: 117, lenFt: 11381, intersects: ['01L/19R','01R/19L'], rels: 7, thls: true, rils: true },
  ] },
  { icao: 'CYYZ', iata: 'YYZ', name: 'Toronto-Pearson (NRC RWSL trial)', country: 'CA', runways: [
    { id: '05/23',   thr: { lat: 43.6679, lng: -79.6395 }, qfu: 50,  lenFt: 11120, intersects: ['06L/24R','06R/24L'], rels: 6, thls: true, rils: true },
    { id: '06L/24R', thr: { lat: 43.6791, lng: -79.6428 }, qfu: 67,  lenFt: 9696, intersects: ['05/23','15L/33R'], rels: 6, thls: true, rils: true },
    { id: '15L/33R', thr: { lat: 43.6914, lng: -79.6240 }, qfu: 152, lenFt: 11050, intersects: ['06L/24R','06R/24L'], rels: 6, thls: true, rils: true },
  ] },
  { icao: 'RJTT', iata: 'HND', name: 'Tokyo-Haneda (ASSC-RWSL)', country: 'JP', runways: [
    { id: '16L/34R', thr: { lat: 35.5494, lng: 139.7796 }, qfu: 156, lenFt: 9842, intersects: ['04/22'], rels: 6, thls: true, rils: true },
    { id: '16R/34L', thr: { lat: 35.5666, lng: 139.7798 }, qfu: 156, lenFt: 9842, intersects: [],         rels: 6, thls: true, rils: false },
    { id: '04/22',   thr: { lat: 35.5343, lng: 139.7691 }, qfu: 39,  lenFt: 8202, intersects: ['16L/34R'], rels: 5, thls: true, rils: true },
  ] },
]

/* ----- geo math ----- */
const R_NM = 3440.065
const FT_PER_NM = 6076.12
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
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
function projectLatLng(la: number, lo: number, brg: number, dnm: number): [number, number] {
  const δ = dnm / R_NM, θ = brg * Math.PI / 180, φ1 = la * Math.PI / 180, λ1 = lo * Math.PI / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return [φ2 * 180 / Math.PI, λ2 * 180 / Math.PI]
}
function angDelta(a: number, b: number): number { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d }

/* runway-local coordinates: along-axis (NM from primary threshold) and cross-axis (NM perpendicular).
   +along = down the runway in QFU direction.
   +cross = right of QFU */
function rwyLocal(rwy: Rwy, lat: number, lng: number): { along: number; cross: number; dNm: number } {
  const dNm = gcNm(rwy.thr.lat, rwy.thr.lng, lat, lng)
  const brg = bearingDeg(rwy.thr.lat, rwy.thr.lng, lat, lng)
  const dθ = ((brg - rwy.qfu) * Math.PI) / 180
  return { along: dNm * Math.cos(dθ), cross: dNm * Math.sin(dθ), dNm }
}

interface Pm {
  f: SFlight
  apt: RwslApt
  rwy: Rwy
  phase: Phase
  alongNm: number
  alongFt: number
  crossFt: number
  trackDeltaDeg: number       // |track − QFU| or |track − reciprocal QFU|
  onRwy: boolean              // |cross| < 75 ft and 0 ≤ along ≤ length
  imminentArr: boolean        // airborne, aligned, <2nm and <1500AGL
  occupantCount: number       // other tracked targets on same runway
  holdersCount: number        // other targets HOLDING-SHORT at this runway
  crossersCount: number       // other targets CROSSING intersecting runway
  relTrig: boolean
  thlTrig: boolean
  rilTrig: boolean
  drivers: { REL: number; THL: number; RIL: number; GEO: number; SPD: number; PHA: number }
  score: number
  tier: Tier
}

function classifyPhase(f: SFlight, rwy: Rwy, onRwy: boolean, aligned: boolean, alongFt: number, crossFt: number, lenFt: number): Phase {
  if (f.altitudeFt > 2500 && f.velocityKts > 150 && f.vertRate < -100) return 'AIRBORNE-DEP' // outbound
  if (!f.ground && f.altitudeFt < 1500 && aligned && alongFt < 0 && alongFt > -4 * FT_PER_NM) return 'ARRIVAL'
  if (!f.ground) return f.altitudeFt < 4000 ? 'AIRBORNE-DEP' : 'IDLE'
  if (onRwy) {
    if (f.velocityKts >= 100 && aligned) return 'TAKEOFF'
    if (f.velocityKts >= 60) return 'ROLL'
    if (f.velocityKts < 60 && alongFt < 1500 && aligned) return 'TAKEOFF' // staged at threshold
    return 'TOUCHDOWN'
  }
  // off-runway ground
  if (Math.abs(crossFt) < 250 && Math.abs(crossFt) > 75 && alongFt > 0 && alongFt < lenFt && f.velocityKts < 25) return 'HOLDING-SHORT'
  // crossing geometry: track roughly perpendicular to QFU and close to RWY
  if (Math.abs(crossFt) < 200 && f.velocityKts > 10 && f.velocityKts < 60) {
    const td = Math.abs(angDelta(f.track, rwy.qfu) - 90)
    if (td < 30) return 'CROSSING'
  }
  return 'TAXI'
}

function analyse(f: SFlight, allSameApt: Map<string, SFlight[]>, aptScopeFt: number): Pm | null {
  // pick airport within scope
  let bestApt: RwslApt | null = null
  let bestD = Infinity
  for (const a of APTS) {
    // approximate airport centroid as first runway threshold
    const r0 = a.runways[0]
    const d = gcNm(f.lat, f.lng, r0.thr.lat, r0.thr.lng)
    if (d * FT_PER_NM > aptScopeFt + 30000) continue
    if (d < bestD) { bestD = d; bestApt = a }
  }
  if (!bestApt) return null
  if (!f.ground && f.altitudeFt > 2500) return null // out of RWSL relevance

  // pick best runway: airborne → most-aligned/closest threshold; ground → minimum |cross|
  let pickR: Rwy | null = null
  let pickLocal = { along: 0, cross: 0, dNm: 0 }
  let bestPenalty = Infinity
  for (const r of bestApt.runways) {
    // also evaluate reciprocal direction
    for (const recip of [false, true] as const) {
      const qfu = recip ? (r.qfu + 180) % 360 : r.qfu
      const lat = recip ? projectLatLng(r.thr.lat, r.thr.lng, r.qfu, r.lenFt / FT_PER_NM)[0] : r.thr.lat
      const lng = recip ? projectLatLng(r.thr.lat, r.thr.lng, r.qfu, r.lenFt / FT_PER_NM)[1] : r.thr.lng
      const rPseudo: Rwy = { ...r, thr: { lat, lng }, qfu }
      const local = rwyLocal(rPseudo, f.lat, f.lng)
      const alongFt = local.along * FT_PER_NM
      const crossFt = local.cross * FT_PER_NM
      let penalty = Math.abs(crossFt) + Math.max(0, -alongFt) * 0.4
      if (f.ground) {
        if (alongFt < -800 || alongFt > r.lenFt + 800) penalty += 5000
      } else {
        // airborne: bias toward approach direction
        const align = angDelta(f.track, qfu)
        penalty += align * 50
        if (alongFt > 0) penalty += alongFt * 0.1
      }
      if (penalty < bestPenalty) { bestPenalty = penalty; pickR = r; pickLocal = { along: local.along, cross: local.cross, dNm: local.dNm } }
    }
  }
  if (!pickR) return null
  const alongFt = pickLocal.along * FT_PER_NM
  const crossFt = pickLocal.cross * FT_PER_NM
  const trackDelta = Math.min(angDelta(f.track, pickR.qfu), angDelta(f.track, (pickR.qfu + 180) % 360))
  const aligned = trackDelta < 25
  const onRwy = f.ground && Math.abs(crossFt) < 75 && alongFt > -200 && alongFt < pickR.lenFt + 200
  const phase = classifyPhase(f, pickR, onRwy, aligned, alongFt, crossFt, pickR.lenFt)

  // imminent arrival: airborne, aligned, within 2nm of threshold, below 1500AGL
  const imminentArr = !f.ground && f.altitudeFt < 1500 && aligned && pickLocal.dNm < 2.0 && alongFt < 200

  // co-traffic at this airport: count occupants of this runway, holders, crossers on intersecting runways
  const cohort = allSameApt.get(bestApt.icao) || []
  let occ = 0, hold = 0, cross = 0
  for (const o of cohort) {
    if (o.icao === f.icao) continue
    const ol = rwyLocal(pickR, o.lat, o.lng)
    const olAlongFt = ol.along * FT_PER_NM
    const olCrossFt = ol.cross * FT_PER_NM
    const olOn = o.ground && Math.abs(olCrossFt) < 75 && olAlongFt > -200 && olAlongFt < pickR.lenFt + 200
    if (olOn) { occ++; continue }
    if (Math.abs(olCrossFt) < 250 && Math.abs(olCrossFt) > 75 && olAlongFt > 0 && olAlongFt < pickR.lenFt && o.velocityKts < 25 && o.ground) hold++
    // crossing other intersecting runway
    for (const xid of pickR.intersects) {
      const xr = bestApt.runways.find(rr => rr.id === xid)
      if (!xr) continue
      const xl = rwyLocal(xr, o.lat, o.lng)
      const xlA = xl.along * FT_PER_NM, xlC = xl.cross * FT_PER_NM
      const xlOn = o.ground && Math.abs(xlC) < 75 && xlA > -200 && xlA < xr.lenFt + 200
      if (xlOn) cross++
    }
  }

  // trigger logic
  const selfOccupant = phase === 'TAKEOFF' || phase === 'ROLL' || phase === 'TOUCHDOWN'
  const otherImminent = (cohort.some(o => {
    if (o.icao === f.icao) return false
    if (o.ground || o.altitudeFt > 1500) return false
    const ol = rwyLocal(pickR, o.lat, o.lng)
    const align = angDelta(o.track, pickR.qfu)
    const align2 = angDelta(o.track, (pickR.qfu + 180) % 360)
    return ol.dNm < 2 && Math.min(align, align2) < 25
  }))

  // REL: this aircraft HOLDING-SHORT and (occupant on RWY OR imminent arrival on RWY)
  const relTrig = phase === 'HOLDING-SHORT' && (occ > 0 || otherImminent || selfOccupant === false && (occ > 0))
  // THL: this aircraft TAKEOFF position (near threshold, low speed) AND a downfield occupant
  const thlTrig = pickR.thls && phase === 'TAKEOFF' && f.velocityKts < 60 && (occ > 0 || cross > 0 || otherImminent)
  // RIL: this aircraft TAKEOFF/ROLL AND crossers on intersecting runway
  const rilTrig = pickR.rils && (phase === 'TAKEOFF' || phase === 'ROLL') && cross > 0

  // drivers
  const REL = relTrig ? clamp(60 + (occ + hold * 10) * 4, 60, 100) : (phase === 'HOLDING-SHORT' && occ > 0 ? 35 : 0)
  const THL = thlTrig ? clamp(75 + occ * 5 + cross * 4, 75, 100) : 0
  const RIL = rilTrig ? clamp(80 + cross * 6, 80, 100) : 0
  const distToThr = Math.abs(alongFt) / 1500 // normalised
  const GEO = onRwy ? clamp(100 - alongFt / Math.max(1, pickR.lenFt) * 60, 30, 100)
            : phase === 'HOLDING-SHORT' ? clamp(80 - Math.abs(crossFt) * 0.2, 30, 80)
            : phase === 'ARRIVAL' ? clamp(80 - pickLocal.dNm * 25, 0, 80)
            : Math.max(0, 50 - distToThr * 8)
  const SPD = (() => {
    if (phase === 'TAKEOFF') return clamp(50 + Math.max(0, 100 - f.velocityKts) * 0.6, 50, 100)
    if (phase === 'ROLL') return 60
    if (phase === 'TOUCHDOWN') return 40
    if (phase === 'ARRIVAL') return clamp(60 + (f.velocityKts - 130) * 0.4, 40, 100)
    if (phase === 'HOLDING-SHORT') return 30
    if (phase === 'CROSSING') return clamp(40 + f.velocityKts * 0.4, 40, 80)
    return 0
  })()
  const phaseMul = phase === 'TAKEOFF' ? 1.40 : phase === 'TOUCHDOWN' ? 1.35 : phase === 'ROLL' ? 1.25 : phase === 'CROSSING' ? 1.30 : phase === 'HOLDING-SHORT' ? 1.15 : phase === 'ARRIVAL' ? 1.10 : 1.00
  const PHA = clamp((phase === 'IDLE' ? 0 : 30) * phaseMul, 0, 60)
  const drivers = { REL, THL, RIL, GEO, SPD, PHA }
  const maxDrv = Math.max(REL, THL, RIL, GEO, SPD, PHA)
  const secondary = (REL + THL + RIL + GEO + SPD + PHA - maxDrv) / 5
  const rawScore = clamp(maxDrv * phaseMul * 0.85 + secondary * 0.15, 0, 100)

  let tier: Tier
  if (rawScore >= 80 || thlTrig || rilTrig) tier = 'STOP'
  else if (rawScore >= 55 || relTrig) tier = 'HOLD-PAD'
  else if (rawScore >= 35) tier = 'CAUTION'
  else if (rawScore >= 18) tier = 'ADVISORY'
  else tier = 'CLEAR'
  if (phase === 'IDLE') tier = 'IDLE'

  return {
    f, apt: bestApt, rwy: pickR, phase, alongNm: pickLocal.along, alongFt, crossFt,
    trackDeltaDeg: trackDelta, onRwy, imminentArr,
    occupantCount: occ, holdersCount: hold, crossersCount: cross,
    relTrig, thlTrig, rilTrig, drivers, score: rawScore, tier,
  }
}

/* ----- map layer ids ----- */
const SRC_HALO = 'rwsl-halo', LYR_HALO = 'rwsl-halo'
const SRC_PIN = 'rwsl-pin', LYR_PIN = 'rwsl-pin'
const SRC_LBL = 'rwsl-lbl', LYR_LBL = 'rwsl-lbl'
const SRC_RWY = 'rwsl-rwy', LYR_RWY = 'rwsl-rwy'
const SRC_REL = 'rwsl-rel', LYR_REL = 'rwsl-rel'
const SRC_THL = 'rwsl-thl', LYR_THL = 'rwsl-thl'
const SRC_RIL = 'rwsl-ril', LYR_RIL = 'rwsl-ril'
const SRC_LINK = 'rwsl-link', LYR_LINK = 'rwsl-link'

const lsGet = (k: string, d: any) => { if (typeof window === 'undefined') return d; try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }
const lsSet = (k: string, v: any) => { if (typeof window === 'undefined') return; try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

export default function RwslStatusLights({ map, flights, onClose, onFly }: Props) {
  const [relMul, setRelMul] = useState<number>(() => lsGet('ft-rwsl-rel', 100))
  const [thlMul, setThlMul] = useState<number>(() => lsGet('ft-rwsl-thl', 100))
  const [rilMul, setRilMul] = useState<number>(() => lsGet('ft-rwsl-ril', 100))
  const [phaseWt, setPhaseWt] = useState<number>(() => lsGet('ft-rwsl-pwt', 100))
  const [scopeNm, setScopeNm] = useState<number>(() => lsGet('ft-rwsl-scope', 6))
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS' | 'LIGHTS'>('AIRCRAFT')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showRwy, setShowRwy] = useState(true)
  const [showRel, setShowRel] = useState(true)
  const [showThl, setShowThl] = useState(true)
  const [showRil, setShowRil] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    lsSet('ft-rwsl-rel', relMul); lsSet('ft-rwsl-thl', thlMul); lsSet('ft-rwsl-ril', rilMul)
    lsSet('ft-rwsl-pwt', phaseWt); lsSet('ft-rwsl-scope', scopeNm)
  }, [relMul, thlMul, rilMul, phaseWt, scopeNm])

  const rows = useMemo(() => {
    // pre-bucket flights by airport (cheap distance gate using r0.thr per airport)
    const byApt = new Map<string, SFlight[]>()
    for (const a of APTS) {
      const r0 = a.runways[0]
      const bucket: SFlight[] = []
      for (const f of flights) {
        if (gcNm(f.lat, f.lng, r0.thr.lat, r0.thr.lng) < scopeNm + 1) bucket.push(f)
      }
      if (bucket.length) byApt.set(a.icao, bucket)
    }
    const out: Pm[] = []
    for (const f of flights) {
      const v = analyse(f, byApt, scopeNm * FT_PER_NM); if (!v) continue
      v.drivers.REL = clamp(v.drivers.REL * relMul / 100, 0, 100)
      v.drivers.THL = clamp(v.drivers.THL * thlMul / 100, 0, 100)
      v.drivers.RIL = clamp(v.drivers.RIL * rilMul / 100, 0, 100)
      v.drivers.PHA = clamp(v.drivers.PHA * phaseWt / 100, 0, 100)
      const maxDrv = Math.max(v.drivers.REL, v.drivers.THL, v.drivers.RIL, v.drivers.GEO, v.drivers.SPD, v.drivers.PHA)
      const sec = (v.drivers.REL + v.drivers.THL + v.drivers.RIL + v.drivers.GEO + v.drivers.SPD + v.drivers.PHA - maxDrv) / 5
      v.score = clamp(maxDrv * 0.85 + sec * 0.15, 0, 100)
      if (v.score >= 80 || v.thlTrig || v.rilTrig) v.tier = 'STOP'
      else if (v.score >= 55 || v.relTrig) v.tier = 'HOLD-PAD'
      else if (v.score >= 35) v.tier = 'CAUTION'
      else if (v.score >= 18) v.tier = 'ADVISORY'
      else v.tier = 'CLEAR'
      if (v.phase === 'IDLE') v.tier = 'IDLE'
      out.push(v)
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, relMul, thlMul, rilMul, phaseWt, scopeNm])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(v => {
      if (phaseFilter !== 'ALL' && v.phase !== phaseFilter) return false
      if (tierFilter !== 'ALL' && v.tier !== tierFilter) return false
      if (q) {
        const blob = `${v.f.callsign} ${v.f.icao} ${v.f.type} ${v.apt.icao} ${v.apt.iata} ${v.apt.name} ${v.rwy.id}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [rows, phaseFilter, tierFilter, query])

  const tierCount: Record<Tier, number> = { STOP: 0, 'HOLD-PAD': 0, CAUTION: 0, ADVISORY: 0, CLEAR: 0, IDLE: 0 }
  for (const v of rows) tierCount[v.tier]++
  const stopN = tierCount.STOP
  const holdN = tierCount['HOLD-PAD']
  const relN = rows.filter(v => v.relTrig).length
  const thlN = rows.filter(v => v.thlTrig).length
  const rilN = rows.filter(v => v.rilTrig).length
  const worst = rows[0]
  const meanScore = rows.length ? rows.reduce((s, v) => s + v.score, 0) / rows.length : 0
  const occByApt = new Map<string, number>()
  for (const v of rows) if (v.onRwy) occByApt.set(v.apt.icao, (occByApt.get(v.apt.icao) || 0) + 1)

  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}, before?: string) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any, before)
    }
    ensure(LYR_RWY, 'line', SRC_RWY, { 'line-color': ['get', 'color'], 'line-width': 2.4, 'line-opacity': 0.55 })
    ensure(LYR_REL, 'circle', SRC_REL, { 'circle-radius': 3, 'circle-color': ['get', 'color'], 'circle-stroke-width': 0.6, 'circle-stroke-color': '#0f172a' })
    ensure(LYR_THL, 'circle', SRC_THL, { 'circle-radius': 3.5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 0.8, 'circle-stroke-color': '#0f172a' })
    ensure(LYR_RIL, 'circle', SRC_RIL, { 'circle-radius': 3.5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 0.8, 'circle-stroke-color': '#0f172a' })
    ensure(LYR_LINK, 'line', SRC_LINK, { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.75, 'line-dasharray': [2, 2] })
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.2, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN, 'circle', SRC_PIN, { 'circle-radius': 5.5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_LBL, 'symbol', SRC_LBL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL)) { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }

    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = [], rwy: any[] = [], rel: any[] = [], thl: any[] = [], ril: any[] = []
    const activeApts = new Set<string>()
    for (const v of filtered) activeApts.add(v.apt.icao)

    for (const a of APTS) {
      const isActive = activeApts.has(a.icao)
      if (!showRwy && !showRel && !showThl && !showRil) continue
      for (const r of a.runways) {
        const [endLat, endLng] = projectLatLng(r.thr.lat, r.thr.lng, r.qfu, r.lenFt / FT_PER_NM)
        if (showRwy) {
          rwy.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.thr.lng, r.thr.lat], [endLng, endLat]] }, properties: { color: isActive ? '#0ea5e9' : '#475569' } })
        }
        if (showRel) {
          // sprinkle REL fixtures evenly along runway perpendicular hash points
          for (let i = 1; i <= r.rels; i++) {
            const frac = i / (r.rels + 1)
            const [la, lo] = projectLatLng(r.thr.lat, r.thr.lng, r.qfu, (r.lenFt * frac) / FT_PER_NM)
            const [laL, loL] = projectLatLng(la, lo, (r.qfu + 90) % 360, 0.025)
            const [laR, loR] = projectLatLng(la, lo, (r.qfu + 270) % 360, 0.025)
            const triggered = isActive && rows.some(v => v.apt.icao === a.icao && v.rwy.id === r.id && v.relTrig)
            rel.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [loL, laL] }, properties: { color: triggered ? '#ef4444' : '#475569' } })
            rel.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [loR, laR] }, properties: { color: triggered ? '#ef4444' : '#475569' } })
          }
        }
        if (showThl && r.thls) {
          // THL: two rows of fixtures 500ft / 1000ft / 1500ft from threshold
          for (const dft of [500, 1000, 1500]) {
            const [la, lo] = projectLatLng(r.thr.lat, r.thr.lng, r.qfu, dft / FT_PER_NM)
            const triggered = isActive && rows.some(v => v.apt.icao === a.icao && v.rwy.id === r.id && v.thlTrig)
            thl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lo, la] }, properties: { color: triggered ? '#ef4444' : '#64748b' } })
          }
        }
        if (showRil && r.rils) {
          for (const xid of r.intersects) {
            const xr = a.runways.find(rr => rr.id === xid); if (!xr) continue
            // intersection: midpoint approximation = projection along this runway equal to length of intersecting / 2
            const fracIx = 0.5
            const [la, lo] = projectLatLng(r.thr.lat, r.thr.lng, r.qfu, (r.lenFt * fracIx) / FT_PER_NM)
            const triggered = isActive && rows.some(v => v.apt.icao === a.icao && v.rwy.id === r.id && v.rilTrig)
            ril.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lo, la] }, properties: { color: triggered ? '#ef4444' : '#a855f7' } })
          }
        }
      }
    }

    for (const v of filtered) {
      const c = TIER_COLOR[v.tier]
      if (showHalo) halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { color: c, r: 8 + v.score * 0.14 } })
      if (showPin && (v.tier === 'STOP' || v.tier === 'HOLD-PAD')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { color: c } })
      if (showLbl && v.tier !== 'CLEAR' && v.tier !== 'IDLE') {
        const lab = `${v.f.callsign || v.f.icao} ${v.tier} ${v.apt.iata || v.apt.icao}/${v.rwy.id}`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { label: lab, color: c } })
      }
      if (showLink) {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[v.f.lng, v.f.lat], [v.rwy.thr.lng, v.rwy.thr.lat]] }, properties: { color: c } })
      }
    }
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_RWY) as any).setData({ type: 'FeatureCollection', features: rwy })
    ;(map.getSource(SRC_REL) as any).setData({ type: 'FeatureCollection', features: rel })
    ;(map.getSource(SRC_THL) as any).setData({ type: 'FeatureCollection', features: thl })
    ;(map.getSource(SRC_RIL) as any).setData({ type: 'FeatureCollection', features: ril })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_RIL, LYR_THL, LYR_REL, LYR_RWY]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_LINK, SRC_RIL, SRC_THL, SRC_REL, SRC_RWY]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, rows, showHalo, showPin, showLbl, showLink, showRwy, showRel, showThl, showRil])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const phaseBadge = (p: Phase) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: PHASE_COLOR[p], backgroundColor: PHASE_COLOR[p] + '1a', border: `1px solid ${PHASE_COLOR[p]}66` }}>{p}</span>
  )
  const drvBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const trigBadge = (kind: string, on: boolean) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: on ? '#ef4444' : '#64748b', backgroundColor: on ? '#ef444422' : '#0b1220', border: '1px solid ' + (on ? '#ef444466' : '#33415566') }}>{kind}{on ? ' ›' : ''}</span>
  )
  const advice = (v: Pm) => {
    if (v.thlTrig) return `THL ACTIVE · downfield occupant ${v.occupantCount}, intersection xtra ${v.crossersCount} · HOLD POSITION · do NOT commence takeoff roll · per FAA JO 7110.65 §3-1-12 / AC 150/5340-30J ch 14`
    if (v.rilTrig) return `RIL ACTIVE · crossing-runway traffic ${v.crossersCount} · ABORT roll if commenced or HOLD · per FAA RWSL ConOps ed.4`
    if (v.relTrig) return `REL ACTIVE · holding short with runway occupied (occ ${v.occupantCount} / imm-arr) · DO NOT ENTER · per JO 7110.65 §3-1-12`
    if (v.tier === 'CAUTION') return `CAUTION · phase ${v.phase} cross ${Math.abs(v.crossFt).toFixed(0)}ft · monitor RWSL state per AIM 2-1-6`
    if (v.tier === 'ADVISORY') return `ADVISORY · ${v.phase} on ${v.apt.icao}/${v.rwy.id} · tower briefing recommended`
    return `CLEAR · ${v.phase} no RWSL conflict · per ICAO Doc 9476 SMGCS`
  }

  /* Scatter: |cross-track| ft horizontal vs along-track ft vertical (runway-local) */
  const W = 280, H = 180
  const sx = (n: number) => 32 + clamp(n / 1500, 0, 1) * (W - 42)
  const sy = (n: number) => H - 24 - clamp(n / 12000, 0, 1) * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">RWSL · Runway Status Lights · REL · THL · RIL</div>
          <div className="text-[10px] text-slate-500">FAA AC 150/5340-30J ch 14 · JO 7110.65 §3-1-12 · 6850.2B · RWSL ConOps ed.4 · AIM 2-1-6 · ICAO Doc 9476/9830</div>
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
          <div className="text-[9px] text-slate-500 uppercase">Mean score</div>
          <div className="text-sm font-semibold" style={{ color: meanScore >= 55 ? '#ef4444' : meanScore >= 25 ? '#f59e0b' : '#10b981' }}>{meanScore.toFixed(0)}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">STOP</div>
          <div className="text-sm font-semibold" style={{ color: stopN > 0 ? '#ef4444' : '#10b981' }}>{stopN}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">REL trig</div>
          <div className="text-xs font-semibold" style={{ color: relN > 0 ? '#f43f5e' : '#10b981' }}>{relN}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">THL trig</div>
          <div className="text-xs font-semibold" style={{ color: thlN > 0 ? '#ef4444' : '#10b981' }}>{thlN}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">RIL trig</div>
          <div className="text-xs font-semibold" style={{ color: rilN > 0 ? '#ef4444' : '#10b981' }}>{rilN}</div>
        </div>
      </div>

      {showDiag && rows.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* on-RWY band: cross < 75ft */}
            <rect x={sx(0)} y={0} width={sx(75) - sx(0)} height={H - 24} fill="#ef444425" />
            {/* HOLDING band: 75-250 ft cross */}
            <rect x={sx(75)} y={0} width={sx(250) - sx(75)} height={H - 24} fill="#a855f720" />
            <line x1={sx(75)} y1={0} x2={sx(75)} y2={H - 24} stroke="#ef444466" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(250)} y1={0} x2={sx(250)} y2={H - 24} stroke="#a855f766" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(0)} y1={sy(1500)} x2={W} y2={sy(1500)} stroke="#f59e0b55" strokeWidth={0.4} strokeDasharray="3 3" />
            <text x={W / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="#64748b">|cross-track| ft</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>along-track ft</text>
            {rows.map((v, i) => (
              <circle key={i} cx={sx(Math.abs(v.crossFt))} cy={sy(Math.max(0, v.alongFt))} r={2.4} fill={TIER_COLOR[v.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['REL-MUL', relMul, 50, 200, setRelMul, '%'],
            ['THL-MUL', thlMul, 50, 200, setThlMul, '%'],
            ['RIL-MUL', rilMul, 50, 200, setRilMul, '%'],
            ['PHASE-WT', phaseWt, 50, 150, setPhaseWt, '%'],
            ['SCOPE', scopeNm, 2, 20, setScopeNm, 'nm'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[40px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['TAKEOFF','ROLL','TOUCHDOWN','ARRIVAL','HOLDING-SHORT','CROSSING','TAXI'] as Phase[]).map(p => (
            <button key={p} onClick={() => setPhaseFilter(phaseFilter === p ? 'ALL' : p)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: phaseFilter === p ? PHASE_COLOR[p] + '33' : '#0b1220', borderColor: phaseFilter === p ? PHASE_COLOR[p] : '#1e293b', color: phaseFilter === p ? PHASE_COLOR[p] : '#cbd5e1' }}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['RWY', showRwy, setShowRwy],
            ['REL', showRel, setShowRel],
            ['THL', showThl, setShowThl],
            ['RIL', showRil, setShowRil],
            ['LINK', showLink, setShowLink],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / airport / runway" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'AIRPORTS', 'LIGHTS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'AIRCRAFT' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No tracked targets within RWSL scope</div>}
          {filtered.map((v, idx) => (
            <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(v.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[v.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 truncate">{v.f.callsign || v.f.icao}</span>
                  <span className="text-slate-500 text-[10px] truncate">{v.f.type || '—'}</span>
                  {phaseBadge(v.phase)}
                </div>
                {tierBadge(v.tier)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-sky-300">{v.apt.iata || v.apt.icao}/{v.rwy.id}</span>
                {' · along '}<span className="text-slate-200">{v.alongFt.toFixed(0)}ft</span>
                {' · cross '}<span style={{ color: Math.abs(v.crossFt) < 75 ? '#ef4444' : Math.abs(v.crossFt) < 250 ? '#a855f7' : '#cbd5e1' }}>{v.crossFt.toFixed(0)}ft</span>
                {' · Δtrk '}<span className="text-slate-300">{v.trackDeltaDeg.toFixed(0)}°</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono flex flex-wrap items-center gap-1">
                {trigBadge('REL', v.relTrig)}
                {trigBadge('THL', v.thlTrig)}
                {trigBadge('RIL', v.rilTrig)}
                <span className="text-slate-500">occ {v.occupantCount} · hold {v.holdersCount} · xrun {v.crossersCount}</span>
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${v.score}%`, backgroundColor: TIER_COLOR[v.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {drvBadge('REL', v.drivers.REL)}
                {drvBadge('THL', v.drivers.THL)}
                {drvBadge('RIL', v.drivers.RIL)}
                {drvBadge('GEO', v.drivers.GEO)}
                {drvBadge('SPD', v.drivers.SPD)}
                {drvBadge('PHA', v.drivers.PHA)}
              </div>
              <div className="text-[10px] mt-1.5 italic" style={{ color: TIER_COLOR[v.tier] }}>{advice(v)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'AIRPORTS' && (
        <div className="divide-y divide-slate-800">
          {APTS.slice().sort((a, b) => {
            const ka = rows.filter(r => r.apt.icao === a.icao).length
            const kb = rows.filter(r => r.apt.icao === b.icao).length
            return kb - ka
          }).map(a => {
            const aRows = rows.filter(r => r.apt.icao === a.icao)
            const stp = aRows.filter(r => r.tier === 'STOP').length
            const hld = aRows.filter(r => r.tier === 'HOLD-PAD').length
            const cau = aRows.filter(r => r.tier === 'CAUTION').length
            const ms = aRows.length ? aRows.reduce((s, r) => s + r.score, 0) / aRows.length : 0
            const totalLights = a.runways.reduce((s, r) => s + r.rels + (r.thls ? 3 : 0) + (r.rils ? r.intersects.length : 0), 0)
            return (
              <div key={a.icao} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => { if (aRows[0]) onFly(aRows[0].f.icao) }} style={{ borderLeft: `3px solid ${stp > 0 ? '#ef4444' : hld > 0 ? '#f43f5e' : cau > 0 ? '#f59e0b' : '#10b981'}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-sky-300">{a.icao}</span>
                    <span className="text-slate-200 text-[11px]">{a.name}</span>
                    <span className="text-slate-500 text-[10px]">{a.country}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-300">{a.runways.length} rwy · {totalLights} fix</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  {a.runways.map(r => r.id).join(' · ')}
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  {aRows.length} ac · <span className="text-rose-400">{stp} STOP</span> · <span className="text-rose-300">{hld} HOLD-PAD</span> · <span className="text-amber-400">{cau} CAUTION</span> · occ {occByApt.get(a.icao) || 0}
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 60 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'LIGHTS' && (
        <div className="divide-y divide-slate-800">
          {([
            { id: 'REL', name: 'Runway Entrance Lights', desc: 'Taxiway-centreline embedded reds at every runway crossing. Illuminate when arrival/departure on or imminent for the runway.', ref: 'FAA JO 7110.65 §3-1-12 · AC 150/5340-30J ch 14.5', count: APTS.reduce((s, a) => s + a.runways.reduce((rs, r) => rs + r.rels, 0), 0), trig: relN, color: '#a855f7' },
            { id: 'THL', name: 'Takeoff Hold Lights', desc: 'Runway-centreline embedded reds within 1500 ft of departure threshold. Illuminate when runway downfield is occupied.', ref: 'FAA RWSL ConOps ed.4 · AC 150/5340-30J ch 14.6', count: APTS.reduce((s, a) => s + a.runways.filter(r => r.thls).length * 3, 0), trig: thlN, color: '#ef4444' },
            { id: 'RIL', name: 'Runway Intersection Lights', desc: 'Embedded reds across intersecting runway. Illuminate ahead of takeoff roll if intersecting runway traffic.', ref: 'FAA RWSL ConOps ed.4 · 6850.2B App G', count: APTS.reduce((s, a) => s + a.runways.reduce((rs, r) => rs + (r.rils ? r.intersects.length : 0), 0), 0), trig: rilN, color: '#a855f7' },
          ] as const).map(l => (
            <div key={l.id} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${l.trig > 0 ? '#ef4444' : '#10b981'}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[11px]" style={{ color: l.color }}>{l.id}</span>
                  <span className="text-slate-200 text-[11px]">{l.name}</span>
                </div>
                <span className="text-[10px] font-mono text-slate-300">{l.count} fix · <span style={{ color: l.trig > 0 ? '#ef4444' : '#10b981' }}>{l.trig} trig</span></span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">{l.desc}</div>
              <div className="text-[10px] text-slate-500 mt-0.5 font-mono">{l.ref}</div>
            </div>
          ))}
          <div className="px-3 py-2 text-[10px] text-slate-500">
            RWSL is fully automated — no controller input. Pilots and vehicle operators must STOP whenever red status lights illuminate, regardless of clearance. Per FAA AIM 2-1-6, illuminated REL/THL/RIL constitute an explicit stop-instruction with the same authority as an ATC "HOLD SHORT" or "ABORT".
          </div>
        </div>
      )}
    </div>
  )
}
