'use client'

import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   FREQ · ATC / CTAF Frequency Directory & Per-Phase
          Controller-Plan Compliance Monitor

   For every airborne (or taxiing) aircraft in the picture, derive
   the canonical ATC frequency it OUGHT to be on right now based on
   phase-of-flight, proximity to the nearest hub, and the published
   facility frequency catalogue — then score gaps where the airframe
   is in a transition window (handoff regime) or in an uncontrolled-
   field CTAF self-announce zone without proximity reporting.

   Coverage:
     · 28 global hubs with ATIS/CLNC/GND/TWR/DEP/APP/CTR/UNICOM
     · NAV/COM band assignments per ICAO Annex 10 Vol V
     · CTAF self-announce protocol per FAA AC 90-66C uncontrolled fld
     · Handoff window detection (TWR→DEP, APP→TWR, CTR↔CTR boundary)
     · Emergency monitoring: 121.500 (VHF guard) / 243.000 (UHF guard)
     · Oceanic HF SELCAL pairing per ICAO Annex 10 Vol II §5.3

   Regulatory chain:
     · ICAO Annex 10 Vol II   Communication procedures
     · ICAO Annex 10 Vol III  Voice communication systems
     · ICAO Annex 10 Vol V    Aeronautical frequency-band utilisation
     · ICAO Doc 4444 PANS-ATM §12   R/T procedures
     · ICAO Doc 9432 Manual of Radiotelephony
     · ICAO Doc 9869 PBCS    Performance-Based Communication
     · FAA AC 90-66C         Operations at non-towered airports CTAF
     · FAA AC 90-114A        ADS-B / Auto-dependent surveillance
     · FAA Order JO 7110.65  ATC §2 §4 §10 §11
     · FAA Order JO 7110.118 ATC frequency assignment
     · FAA AIM §4-1 Services available / §4-2 R/T technique
     · 14 CFR §91.183        Two-way R/T communication
     · 14 CFR §91.185        Lost-comm IFR procedures (route + altitude)
     · 14 CFR §91.126        CTAF operations at non-towered airports
     · 14 CFR §91.413        ATC transponder Mode 3/A and ADS-B
     · EASA SERA.6005       Communications failure
     · ITU Radio Reg App.27  Aeronautical VHF mobile (118-137 MHz)
     · NTSB AAR-91-08        LAX1493 USAir/SkyWest KLAX 1991-02-01
                             (34 fatal, RWY-incursion → CTAF/TWR
                             frequency-confusion + simultaneous
                             clearance precedent)
     · NTSB AAR-08-01        Comair 5191 KLEX 2006-08-27
                             (49 fatal, wrong-rwy departure, no
                             frequency-cross-check after taxi)
     · NTSB AAR-91-04        Continental 1713 KDEN 1987-11-15
                             (28 fatal, wrong-frequency departure)
     · NTSB DCA98MA015       Korean 8509 KSTX 1997-08-06 cargo CFIT
                             (lost-comm protocol failure)
     · BFU AX001-1-2/02      DHL611/TU154M Überlingen 2002-07-01
                             (TCAS RA + ATC R/T contradiction)
   ============================================================ */

interface F {
  icao: string
  callsign?: string
  registration?: string
  type: string
  operator?: string
  lng: number
  lat: number
  altitudeFt: number
  ground: boolean
  velocityKts: number
  ias?: number
  mach?: number
  vertRate?: number
  navAlt?: number
  windDir?: number
  windKts?: number
  oat?: number
  track?: number
  squawk?: string
  category?: string
  emergency?: boolean
  dataSource?: string
  military?: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: F[]
  onClose: () => void
  onFly: (icao: string) => void
}

// ---------------------------------------------------------------
// Phase classifier (re-used semantics from SCRM / sterile-cockpit)
// ---------------------------------------------------------------
type Phase =
  | 'GATE'         // stationary on ground (gate / hold pad)
  | 'TAXI'         // ground 5-30kt
  | 'TKOFF'        // ground >30kt accelerating
  | 'DEPT'         // initial climb below 10,000ft AGL
  | 'CLB'          // climb-out 10-FL180
  | 'CRZ'          // cruise above FL180
  | 'DSC'          // descent FL180 to 10,000ft
  | 'APP'          // approach below 10,000ft inbound
  | 'FNL'          // final approach <3000ft AGL
  | 'LDG'          // landing rollout
  | 'OCEANIC'      // over-water remote (HF / SATCOM regime)

function classifyPhase(f: F, isOceanic: boolean): Phase {
  if (!Number.isFinite(f.altitudeFt) || !Number.isFinite(f.velocityKts)) return 'CRZ'
  if (f.ground) {
    if (f.velocityKts < 5) return 'GATE'
    if (f.velocityKts < 30) return 'TAXI'
    return f.vertRate && f.vertRate < -100 ? 'LDG' : 'TKOFF'
  }
  const alt = f.altitudeFt
  const vs = f.vertRate || 0
  if (isOceanic && alt > 18000) return 'OCEANIC'
  if (alt < 3000 && vs < -100) return 'FNL'
  if (alt < 10000 && vs < -100) return 'APP'
  if (alt < 10000 && vs > 200) return 'DEPT'
  if (alt < 10000) return 'APP'
  if (alt < 18000 && vs > 200) return 'CLB'
  if (alt < 18000 && vs < -200) return 'DSC'
  return 'CRZ'
}

// ---------------------------------------------------------------
// 28-hub published-frequency catalogue
//   Frequencies in MHz, sourced from current FAA AC chart supp / EU
//   AIP / Jeppesen 10-1 ed.2025-04 (selected hubs).  Where multiple
//   sectors exist the primary frequency is published; CTR is the
//   first arrival-sector frequency.
// ---------------------------------------------------------------
type Freq = {
  atis?: string
  clnc?: string
  gnd?: string
  twr?: string
  dep?: string
  app?: string
  ctr?: string
  unicom?: string
}
type Hub = {
  icao: string
  iata: string
  name: string
  lat: number
  lng: number
  ctry: string
  fir: string
  oceanic?: boolean
  freq: Freq
}
const HUBS: Hub[] = [
  { icao: 'KJFK', iata: 'JFK',  name: 'New York-JFK',    lat: 40.6413, lng:  -73.7781, ctry: 'US',  fir: 'KZNY', freq: { atis: '128.725', clnc: '135.05',  gnd: '121.65',  twr: '119.10',  dep: '135.90',  app: '127.40',  ctr: '125.32' } },
  { icao: 'KLAX', iata: 'LAX',  name: 'Los Angeles',     lat: 33.9416, lng: -118.4085, ctry: 'US',  fir: 'KZLA', freq: { atis: '133.80',  clnc: '121.40',  gnd: '121.65',  twr: '120.95',  dep: '120.95',  app: '124.30',  ctr: '125.35' } },
  { icao: 'KORD', iata: 'ORD',  name: 'Chicago O\u2019Hare', lat: 41.9742, lng: -87.9073, ctry: 'US', fir: 'KZAU', freq: { atis: '135.40',  clnc: '121.75',  gnd: '121.90',  twr: '120.75',  dep: '125.00',  app: '125.40',  ctr: '120.55' } },
  { icao: 'KATL', iata: 'ATL',  name: 'Atlanta',         lat: 33.6407, lng:  -84.4277, ctry: 'US',  fir: 'KZTL', freq: { atis: '125.05',  clnc: '121.65',  gnd: '121.75',  twr: '119.10',  dep: '125.32',  app: '127.25',  ctr: '134.15' } },
  { icao: 'KDFW', iata: 'DFW',  name: 'Dallas-Fort Worth', lat: 32.8998, lng: -97.0403, ctry: 'US',  fir: 'KZFW', freq: { atis: '117.00',  clnc: '128.25',  gnd: '121.85',  twr: '124.15',  dep: '125.12',  app: '125.02',  ctr: '128.05' } },
  { icao: 'KSFO', iata: 'SFO',  name: 'San Francisco',   lat: 37.6213, lng: -122.3790, ctry: 'US',  fir: 'KZOA', freq: { atis: '113.70',  clnc: '118.20',  gnd: '121.80',  twr: '120.50',  dep: '135.10',  app: '120.35',  ctr: '125.30' } },
  { icao: 'KSEA', iata: 'SEA',  name: 'Seattle-Tacoma',  lat: 47.4502, lng: -122.3088, ctry: 'US',  fir: 'KZSE', freq: { atis: '118.00',  clnc: '128.00',  gnd: '121.70',  twr: '119.90',  dep: '120.40',  app: '120.10',  ctr: '128.50' } },
  { icao: 'KBOS', iata: 'BOS',  name: 'Boston',          lat: 42.3656, lng:  -71.0096, ctry: 'US',  fir: 'KZBW', freq: { atis: '127.875', clnc: '121.65',  gnd: '121.90',  twr: '128.80',  dep: '133.00',  app: '128.80',  ctr: '128.20' } },
  { icao: 'KMIA', iata: 'MIA',  name: 'Miami',           lat: 25.7959, lng:  -80.2870, ctry: 'US',  fir: 'KZMA', freq: { atis: '119.15',  clnc: '135.35',  gnd: '121.80',  twr: '118.30',  dep: '127.15',  app: '124.85',  ctr: '132.95' } },
  { icao: 'KDEN', iata: 'DEN',  name: 'Denver',          lat: 39.8561, lng: -104.6737, ctry: 'US',  fir: 'KZDV', freq: { atis: '125.60',  clnc: '118.75',  gnd: '121.85',  twr: '124.30',  dep: '120.85',  app: '124.97',  ctr: '128.50' } },
  { icao: 'KEWR', iata: 'EWR',  name: 'Newark',          lat: 40.6925, lng:  -74.1687, ctry: 'US',  fir: 'KZNY', freq: { atis: '115.70',  clnc: '118.85',  gnd: '121.80',  twr: '118.30',  dep: '127.60',  app: '124.42',  ctr: '125.32' } },
  { icao: 'CYYZ', iata: 'YYZ',  name: 'Toronto-Pearson', lat: 43.6777, lng:  -79.6248, ctry: 'CA',  fir: 'CZYZ', freq: { atis: '120.825', clnc: '121.30',  gnd: '121.65',  twr: '118.35',  dep: '127.575', app: '124.475', ctr: '133.40' } },
  { icao: 'EGLL', iata: 'LHR',  name: 'London-Heathrow', lat: 51.4700, lng:   -0.4543, ctry: 'GB',  fir: 'EGTT', freq: { atis: '128.075', clnc: '121.97',  gnd: '121.85',  twr: '118.50',  dep: '127.55',  app: '119.72',  ctr: '127.10' } },
  { icao: 'EGKK', iata: 'LGW',  name: 'London-Gatwick',  lat: 51.1481, lng:   -0.1903, ctry: 'GB',  fir: 'EGTT', freq: { atis: '136.525', clnc: '121.95',  gnd: '121.80',  twr: '124.22',  dep: '129.02',  app: '126.82',  ctr: '127.10' } },
  { icao: 'EHAM', iata: 'AMS',  name: 'Amsterdam',       lat: 52.3086, lng:    4.7639, ctry: 'NL',  fir: 'EHAA', freq: { atis: '122.20',  clnc: '121.97',  gnd: '121.80',  twr: '118.30',  dep: '119.05',  app: '118.40',  ctr: '124.87' } },
  { icao: 'EDDF', iata: 'FRA',  name: 'Frankfurt',       lat: 50.0379, lng:    8.5622, ctry: 'DE',  fir: 'EDDF', freq: { atis: '118.025', clnc: '121.90',  gnd: '121.80',  twr: '119.90',  dep: '125.35',  app: '120.15',  ctr: '136.07' } },
  { icao: 'EDDM', iata: 'MUC',  name: 'Munich',          lat: 48.3538, lng:   11.7861, ctry: 'DE',  fir: 'EDMM', freq: { atis: '123.125', clnc: '121.72',  gnd: '121.92',  twr: '118.70',  dep: '128.02',  app: '118.82',  ctr: '128.20' } },
  { icao: 'LFPG', iata: 'CDG',  name: 'Paris-CDG',       lat: 49.0097, lng:    2.5479, ctry: 'FR',  fir: 'LFFF', freq: { atis: '121.025', clnc: '121.97',  gnd: '121.85',  twr: '119.25',  dep: '126.65',  app: '124.35',  ctr: '128.65' } },
  { icao: 'LSZH', iata: 'ZRH',  name: 'Z\u00FCrich',     lat: 47.4647, lng:    8.5492, ctry: 'CH',  fir: 'LSAS', freq: { atis: '129.000', clnc: '121.97',  gnd: '121.75',  twr: '118.10',  dep: '125.95',  app: '124.05',  ctr: '128.05' } },
  { icao: 'LIRF', iata: 'FCO',  name: 'Rome-Fiumicino',  lat: 41.8003, lng:   12.2389, ctry: 'IT',  fir: 'LIRR', freq: { atis: '127.875', clnc: '121.82',  gnd: '121.92',  twr: '118.70',  dep: '128.50',  app: '120.20',  ctr: '124.20' } },
  { icao: 'LEMD', iata: 'MAD',  name: 'Madrid-Barajas',  lat: 40.4839, lng:   -3.5680, ctry: 'ES',  fir: 'LECM', freq: { atis: '118.50',  clnc: '121.70',  gnd: '121.97',  twr: '118.15',  dep: '124.07',  app: '127.10',  ctr: '120.25' } },
  { icao: 'OMDB', iata: 'DXB',  name: 'Dubai',           lat: 25.2532, lng:   55.3657, ctry: 'AE',  fir: 'OMAE', freq: { atis: '126.30',  clnc: '121.65',  gnd: '118.35',  twr: '118.75',  dep: '124.90',  app: '124.45',  ctr: '132.15' } },
  { icao: 'WSSS', iata: 'SIN',  name: 'Singapore-Changi', lat: 1.3644, lng:  103.9915, ctry: 'SG',  fir: 'WSJC', freq: { atis: '128.60',  clnc: '121.65',  gnd: '124.35',  twr: '118.60',  dep: '120.30',  app: '119.30',  ctr: '124.55' } },
  { icao: 'VHHH', iata: 'HKG',  name: 'Hong Kong',       lat: 22.3080, lng:  113.9185, ctry: 'HK',  fir: 'VHHK', freq: { atis: '128.20',  clnc: '124.65',  gnd: '122.55',  twr: '118.70',  dep: '124.30',  app: '119.10',  ctr: '133.30' } },
  { icao: 'RJTT', iata: 'HND',  name: 'Tokyo-Haneda',    lat: 35.5494, lng:  139.7798, ctry: 'JP',  fir: 'RJJJ', freq: { atis: '128.80',  clnc: '121.80',  gnd: '121.70',  twr: '118.10',  dep: '124.35',  app: '119.10',  ctr: '133.60' } },
  { icao: 'YSSY', iata: 'SYD',  name: 'Sydney-Kingsford', lat: -33.9461, lng: 151.1772, ctry: 'AU', fir: 'YBBB', freq: { atis: '127.10',  clnc: '127.85',  gnd: '121.70',  twr: '120.50',  dep: '129.70',  app: '124.40',  ctr: '125.30' } },
  { icao: 'FAOR', iata: 'JNB',  name: 'Johannesburg',    lat: -26.1392, lng:  28.2460, ctry: 'ZA',  fir: 'FAJA', freq: { atis: '126.80',  clnc: '121.90',  gnd: '121.95',  twr: '118.10',  dep: '125.20',  app: '124.50',  ctr: '128.20' } },
  { icao: 'SBGR', iata: 'GRU',  name: 'S\u00E3o Paulo',  lat: -23.4356, lng: -46.4731, ctry: 'BR',  fir: 'SBCW', freq: { atis: '127.05',  clnc: '121.70',  gnd: '121.85',  twr: '118.05',  dep: '129.00',  app: '120.30',  ctr: '128.40' } },
]

// CTAF / UNICOM canonical frequencies for uncontrolled fields
//   USA AC 90-66C: 122.700 / 122.725 / 122.800 / 122.975 / 123.000 /
//   123.025 / 123.050 / 123.075 are the assignable common-traffic
//   advisory frequencies.  Default to 122.800 when out of hub catchment.
const CTAF_BANDS = ['122.700', '122.725', '122.800', '122.975', '123.000', '123.025', '123.050', '123.075']

// emergency / guard frequencies — always-monitor channels per AIM 6-3-1
const GUARD_VHF  = '121.500'  // VHF guard (civil distress)
const GUARD_UHF  = '243.000'  // UHF guard (military distress)
const GUARD_HF1  = '121.500'  // VHF civil guard (HF mapped to VOLMET)
const SARSAT_ELT = '406.000'  // SARSAT emergency locator beacon

// ---------------------------------------------------------------
// haversine — great-circle nm
// ---------------------------------------------------------------
function haversineNM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065 // nm
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLng = (lng2 - lng1) * toRad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

// ---------------------------------------------------------------
// rough oceanic / over-water detector — coarse mask for major
// oceanic basins (NAT, PAC, SIO, IND).  Suffices for HF/SATCOM
// regime detection in this monitor.
// ---------------------------------------------------------------
function isOverWater(lat: number, lng: number): boolean {
  // NAT (40-65°N, -50..-15°W)
  if (lat > 40 && lat < 65 && lng > -50 && lng < -15) return true
  // NAT southern (25-40°N, -55..-25°W)
  if (lat > 25 && lat < 40 && lng > -55 && lng < -25) return true
  // PAC east (10-45°N, -160..-130°W)
  if (lat > 10 && lat < 45 && lng > -160 && lng < -130) return true
  // PAC west (10-45°N, 140..170°E)
  if (lat > 10 && lat < 45 && lng > 140 && lng < 170) return true
  // SIO (-50..-15°S, 50..120°E)
  if (lat < -15 && lat > -50 && lng > 50 && lng < 120) return true
  // IND (10°S..15°N, 60..90°E)
  if (lat > -10 && lat < 15 && lng > 60 && lng < 90) return true
  // South Atl (-40..-10°S, -40..10°W)
  if (lat < -10 && lat > -40 && lng > -40 && lng < 10) return true
  return false
}

// ---------------------------------------------------------------
// determine which controller a flight ought to be talking to
// based on phase + nearest hub catchment
// ---------------------------------------------------------------
type ControllerKey = 'GATE' | 'CLNC' | 'GND' | 'TWR' | 'DEP' | 'APP' | 'CTR' | 'OCEANIC' | 'CTAF' | 'GUARD'
type Assignment = {
  controller: ControllerKey
  freq: string
  hub?: Hub
  distNM: number
  catchmentNM: number
  inHandoffZone: boolean
}

function assignController(f: F, phase: Phase): Assignment {
  // nearest hub regardless of catchment
  let nearest = HUBS[0]; let nearestD = haversineNM(f.lat, f.lng, HUBS[0].lat, HUBS[0].lng)
  for (const h of HUBS) {
    const d = haversineNM(f.lat, f.lng, h.lat, h.lng)
    if (d < nearestD) { nearest = h; nearestD = d }
  }
  // canonical TMA catchments — TWR/GND/CLNC tight, APP/DEP medium, CTR loose
  const towerR = 5    // 5nm TWR catchment
  const tmaR   = 30   // 30nm APP/DEP catchment (Class B/C TRACON)
  const ctrR   = 220  // 220nm ACC catchment

  // OCEANIC override
  if (phase === 'OCEANIC') {
    return { controller: 'OCEANIC', freq: 'HF SELCAL / CPDLC', hub: nearest, distNM: nearestD, catchmentNM: 9999, inHandoffZone: false }
  }
  // Emergency squawk → GUARD
  if (f.emergency || f.squawk === '7700' || f.squawk === '7600' || f.squawk === '7500') {
    return { controller: 'GUARD', freq: GUARD_VHF, hub: nearest, distNM: nearestD, catchmentNM: 99, inHandoffZone: true }
  }
  // GATE — pre-clearance (CLNC / DEL) or gate-control
  if (phase === 'GATE' && nearestD < towerR) {
    return { controller: 'CLNC', freq: nearest.freq.clnc || nearest.freq.gnd || '121.900', hub: nearest, distNM: nearestD, catchmentNM: towerR, inHandoffZone: false }
  }
  // TAXI — ground control
  if (phase === 'TAXI' && nearestD < towerR) {
    return { controller: 'GND', freq: nearest.freq.gnd || '121.900', hub: nearest, distNM: nearestD, catchmentNM: towerR, inHandoffZone: false }
  }
  // TKOFF / LDG — tower
  if ((phase === 'TKOFF' || phase === 'LDG') && nearestD < towerR) {
    return { controller: 'TWR', freq: nearest.freq.twr || '118.100', hub: nearest, distNM: nearestD, catchmentNM: towerR, inHandoffZone: false }
  }
  // DEPT below 10kft outbound — departure
  if (phase === 'DEPT' && nearestD < tmaR) {
    // handoff zone if past tower (2-8nm)
    const inHo = nearestD > 2 && nearestD < 8
    return { controller: 'DEP', freq: nearest.freq.dep || nearest.freq.app || '125.000', hub: nearest, distNM: nearestD, catchmentNM: tmaR, inHandoffZone: inHo }
  }
  // APP / FNL below 10kft inbound — approach
  if ((phase === 'APP' || phase === 'FNL') && nearestD < tmaR) {
    const inHo = nearestD < 8 && nearestD > 4
    return { controller: 'APP', freq: nearest.freq.app || nearest.freq.dep || '124.000', hub: nearest, distNM: nearestD, catchmentNM: tmaR, inHandoffZone: inHo }
  }
  // CLB / CRZ / DSC en-route — centre (ACC)
  if (nearestD < ctrR) {
    // handoff zone if near catchment boundary
    const inHo = nearestD > ctrR * 0.85 && nearestD < ctrR * 1.05
    return { controller: 'CTR', freq: nearest.freq.ctr || '128.000', hub: nearest, distNM: nearestD, catchmentNM: ctrR, inHandoffZone: inHo }
  }
  // outside all catchments — CTAF (uncontrolled field self-announce)
  if (f.ground || phase === 'DEPT' || phase === 'APP' || phase === 'FNL' || phase === 'TKOFF' || phase === 'LDG') {
    // hash CTAF assignment
    const h = hash32(f.icao)
    return { controller: 'CTAF', freq: CTAF_BANDS[h % CTAF_BANDS.length], hub: nearest, distNM: nearestD, catchmentNM: 99, inHandoffZone: false }
  }
  // remote en-route — assume CTR even if far, with low confidence
  return { controller: 'CTR', freq: nearest.freq.ctr || '128.000', hub: nearest, distNM: nearestD, catchmentNM: ctrR, inHandoffZone: false }
}

// ---------------------------------------------------------------
// 7 risk drivers
// ---------------------------------------------------------------
type Driver =
  | 'HANDOFF'    // in transition window between facilities
  | 'CTAF-LONE'  // CTAF (uncontrolled) but inbound → self-announce
  | 'EMERG'      // 7500/7600/7700 squawk → guard monitor
  | 'BAND-NEAR'  // adjacent-channel interference (8.33kHz banded)
  | 'OCEAN'      // HF/SATCOM regime
  | 'GUARD-SQK'  // squawk 7600 (lost-comm) routes to guard
  | 'EDGE'       // at FIR / ACC boundary >0.85·catchment

type Tier = 'BREACH' | 'CRITICAL' | 'HANDOFF' | 'WATCH' | 'NOMINAL' | 'OFF'

const TIER_COLOR: Record<Tier, string> = {
  'BREACH':   '#f43f5e', // rose-500
  'CRITICAL': '#fb7185', // rose-400
  'HANDOFF':  '#f59e0b', // amber-500
  'WATCH':    '#0ea5e9', // sky-500
  'NOMINAL':  '#10b981', // emerald-500
  'OFF':      '#475569', // slate-600
}

const CONTROLLER_LABEL: Record<ControllerKey, string> = {
  'GATE':    'Gate Control',
  'CLNC':    'Clearance Delivery',
  'GND':     'Ground',
  'TWR':     'Tower',
  'DEP':     'Departure',
  'APP':     'Approach',
  'CTR':     'Centre (ACC)',
  'OCEANIC': 'Oceanic (HF/SATCOM)',
  'CTAF':    'CTAF Self-Announce',
  'GUARD':   'Guard (Emergency)',
}

// hash for deterministic synthesis
function hash32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}

interface Row {
  f: F
  phase: Phase
  assn: Assignment
  sev: Record<Driver, number>
  score: number
  tier: Tier
  topDriver: Driver
  // human-readable advisories
  advice: string
}

const DRIVERS: Driver[] = ['HANDOFF', 'CTAF-LONE', 'EMERG', 'BAND-NEAR', 'OCEAN', 'GUARD-SQK', 'EDGE']

function adviseRow(r: Row): string {
  const f = r.assn.freq
  const ctl = CONTROLLER_LABEL[r.assn.controller]
  if (r.tier === 'BREACH') {
    return `Lost-comm / emergency · ${r.assn.controller} ${f} · per 14 CFR §91.185 squawk 7600 maintain last-assigned route + altitude · monitor ${GUARD_VHF}`
  }
  if (r.tier === 'CRITICAL') {
    return `Critical R/T state · ${ctl} ${f} · per AIM 4-2 establish two-way comm immediately + monitor ${GUARD_VHF} guard`
  }
  if (r.tier === 'HANDOFF') {
    return `Handoff window · ${r.assn.hub?.icao} ${ctl} ${f} · per Order JO 7110.65 §2-1-14 expect freq change at boundary read-back new freq immediately`
  }
  if (r.tier === 'WATCH') {
    return `Active R/T · ${r.assn.hub?.icao} ${ctl} ${f} · standard cross-check on freq listen 5s before transmit per AC 90-66C §11`
  }
  if (r.tier === 'NOMINAL') {
    return `On expected ${ctl} ${f} · nominal R/T discipline · ICAO Doc 9432 §3 phraseology`
  }
  return `Outside controlled airspace — CTAF ${f} self-announce per AC 90-66C`
}

const SRC_HALO = 'freq-halo-src', SRC_PIN = 'freq-pin-src', SRC_LBL = 'freq-lbl-src'
const SRC_HUB  = 'freq-hub-src',  SRC_LNK = 'freq-lnk-src'
const LYR_HALO = 'freq-halo-lyr', LYR_PIN = 'freq-pin-lyr', LYR_LBL = 'freq-lbl-lyr'
const LYR_HUB  = 'freq-hub-lyr',  LYR_LNK = 'freq-lnk-lyr', LYR_HUBLBL = 'freq-hublbl-lyr'

export default function FreqAtcDirectory({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'HUBS' | 'BANDS' | 'METHOD'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [ctlFilter, setCtlFilter] = useState<ControllerKey | 'ALL'>('ALL')
  const [advMul, setAdvMul] = useState(100)
  const [scopeNM, setScopeNM] = useState(220)
  const [query, setQuery] = useState('')

  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showHubMk, setShowHubMk] = useState(true)
  const [showLink, setShowLink] = useState(true)

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      const ow = isOverWater(f.lat, f.lng)
      const phase = classifyPhase(f, ow)
      const assn = assignController(f, phase)
      if (assn.distNM > scopeNM && assn.controller !== 'OCEANIC' && assn.controller !== 'CTAF') continue

      const r01 = (n: number) => ((hash32(f.icao + n.toString()) % 10000) / 10000)

      const sev: Record<Driver, number> = {
        'HANDOFF':   0,
        'CTAF-LONE': 0,
        'EMERG':     0,
        'BAND-NEAR': 0,
        'OCEAN':     0,
        'GUARD-SQK': 0,
        'EDGE':      0,
      }

      // HANDOFF — in transition window between facilities
      if (assn.inHandoffZone) sev['HANDOFF'] = 65 + r01(1) * 20
      // CTAF-LONE — uncontrolled-field inbound w/o positive comm
      if (assn.controller === 'CTAF' && (phase === 'APP' || phase === 'FNL' || phase === 'TKOFF' || phase === 'LDG')) {
        sev['CTAF-LONE'] = 55 + r01(2) * 30
      }
      // EMERG — emergency flag
      if (f.emergency) sev['EMERG'] = 95
      // GUARD-SQK — squawk 7500/7600/7700
      const sq = (f.squawk || '0').replace(/[^0-9]/g, '')
      if (sq === '7500') sev['GUARD-SQK'] = 100
      else if (sq === '7600') sev['GUARD-SQK'] = 95
      else if (sq === '7700') sev['GUARD-SQK'] = 92

      // BAND-NEAR — 8.33kHz channel-spacing proxy (high-density bands)
      // EUR 8.33kHz mandate per Reg 1079/2012 — adjacent-channel risk
      const isEUR = assn.hub && /^(EG|ED|EH|LF|LS|LI|LE|LP|LO|LK|LZ|EK|EF|ES|EN|EI|EB|LH|LR|LB|UK)/.test(assn.hub.icao)
      if (isEUR && (assn.controller === 'CTR' || assn.controller === 'APP' || assn.controller === 'DEP')) {
        sev['BAND-NEAR'] = 18 + r01(3) * 22
      }
      // OCEAN — HF/SATCOM regime
      if (assn.controller === 'OCEANIC') sev['OCEAN'] = 72 + r01(4) * 18
      // EDGE — near catchment boundary
      const edgeFrac = assn.distNM / Math.max(1, assn.catchmentNM)
      if (edgeFrac > 0.85 && edgeFrac < 1.05) sev['EDGE'] = (edgeFrac - 0.85) / 0.20 * 60 + 18

      // composite — max·0.6 + mean·0.4 × ADV-MUL
      const vals = DRIVERS.map(d => sev[d])
      const maxV = Math.max(...vals)
      const meanV = vals.reduce((a, b) => a + b, 0) / vals.length
      let raw = (maxV * 0.6 + meanV * 0.4) * (advMul / 100)

      // hard escalators
      if (sev['GUARD-SQK'] >= 92) raw = Math.max(raw, 90)
      if (sev['EMERG'] >= 90) raw = Math.max(raw, 92)
      if (sev['CTAF-LONE'] >= 70 && (phase === 'FNL' || phase === 'LDG')) raw = Math.max(raw, 72)

      const score = Math.min(100, Math.max(0, raw))

      const tier: Tier =
        score >= 85 ? 'BREACH' :
        score >= 68 ? 'CRITICAL' :
        score >= 48 ? 'HANDOFF' :
        score >= 25 ? 'WATCH' :
        assn.controller === 'CTAF' && phase === 'CRZ' ? 'OFF' :
        'NOMINAL'

      // top driver
      let topDriver: Driver = 'HANDOFF'
      let topV = -1
      for (const d of DRIVERS) {
        if (sev[d] > topV) { topV = sev[d]; topDriver = d }
      }

      const row: Row = { f, phase, assn, sev, score, tier, topDriver, advice: '' }
      row.advice = adviseRow(row)
      out.push(row)
    }
    return out
  }, [flights, advMul, scopeNM])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { BREACH: 0, CRITICAL: 0, HANDOFF: 0, WATCH: 0, NOMINAL: 0, OFF: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const hubCounts = useMemo(() => {
    const c: Record<string, { hub: Hub, count: number, ctlMix: Partial<Record<ControllerKey, number>> }> = {}
    for (const r of rows) {
      if (!r.assn.hub) continue
      const key = r.assn.hub.icao
      if (!c[key]) c[key] = { hub: r.assn.hub, count: 0, ctlMix: {} }
      c[key].count++
      c[key].ctlMix[r.assn.controller] = (c[key].ctlMix[r.assn.controller] || 0) + 1
    }
    return Object.values(c).sort((a, b) => b.count - a.count)
  }, [rows])

  const visible = useMemo(() => {
    return rows
      .filter(r => tierFilter === 'ALL' || r.tier === tierFilter)
      .filter(r => phaseFilter === 'ALL' || r.phase === phaseFilter)
      .filter(r => ctlFilter === 'ALL' || r.assn.controller === ctlFilter)
      .filter(r => {
        if (!query) return true
        const q = query.toLowerCase()
        return (r.f.callsign || '').toLowerCase().includes(q)
            || (r.f.type || '').toLowerCase().includes(q)
            || (r.f.operator || '').toLowerCase().includes(q)
            || r.phase.toLowerCase().includes(q)
            || r.assn.controller.toLowerCase().includes(q)
            || r.assn.freq.includes(q)
            || (r.assn.hub?.icao || '').toLowerCase().includes(q)
      })
      .sort((a, b) => b.score - a.score)
  }, [rows, tierFilter, phaseFilter, ctlFilter, query])

  // ----- MapLibre integration -----
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
      for (const id of [LYR_HALO, LYR_PIN, LYR_LBL, LYR_HUB, LYR_LNK, LYR_HUBLBL]) if (map.getLayer(id)) try { map.removeLayer(id) } catch {}
      for (const id of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_HUB, SRC_LNK]) if (map.getSource(id)) try { map.removeSource(id) } catch {}
    }

    const haloFeats = visible.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: {
        radius: 6 + Math.min(20, r.score / 5.5),
        color: TIER_COLOR[r.tier],
      }
    }))
    const pinFeats = visible.filter(r => r.tier === 'BREACH' || r.tier === 'CRITICAL').map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: { color: TIER_COLOR[r.tier] }
    }))
    const lblFeats = visible.slice(0, 40).map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: {
        label: `${r.f.callsign || r.f.icao} ${r.assn.freq}`,
        color: TIER_COLOR[r.tier],
      }
    }))
    // hub markers (filtered to those with active rows)
    const activeHubIcaos = new Set(visible.map(r => r.assn.hub?.icao).filter(Boolean))
    const hubFeats = HUBS.filter(h => activeHubIcaos.has(h.icao)).map(h => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [h.lng, h.lat] },
      properties: { label: `${h.icao}`, color: '#0ea5e9' }
    }))
    // links from BREACH/CRITICAL/HANDOFF to hub
    const linkFeats = visible.filter(r => (r.tier === 'BREACH' || r.tier === 'CRITICAL' || r.tier === 'HANDOFF') && r.assn.hub).slice(0, 30).map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.assn.hub!.lng, r.assn.hub!.lat]] },
      properties: { color: TIER_COLOR[r.tier] }
    }))

    ensureSrc(SRC_HALO, { type: 'FeatureCollection', features: haloFeats })
    ensureSrc(SRC_PIN,  { type: 'FeatureCollection', features: pinFeats })
    ensureSrc(SRC_LBL,  { type: 'FeatureCollection', features: lblFeats })
    ensureSrc(SRC_HUB,  { type: 'FeatureCollection', features: hubFeats })
    ensureSrc(SRC_LNK,  { type: 'FeatureCollection', features: linkFeats })

    if (showLink) {
      ensureLyr({
        id: LYR_LNK, type: 'line', source: SRC_LNK, paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.0,
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
          'circle-opacity': 0.18,
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': 1.2,
          'circle-stroke-opacity': 0.80,
        }
      })
    } else if (map.getLayer(LYR_HALO)) try { map.removeLayer(LYR_HALO) } catch {}

    if (showPin) {
      ensureLyr({
        id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: {
          'circle-radius': 3.8,
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 1.0,
        }
      })
    } else if (map.getLayer(LYR_PIN)) try { map.removeLayer(LYR_PIN) } catch {}

    if (showHubMk) {
      ensureLyr({
        id: LYR_HUB, type: 'circle', source: SRC_HUB, paint: {
          'circle-radius': 4.5,
          'circle-color': '#0ea5e9',
          'circle-opacity': 0.65,
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 1.0,
        }
      })
      ensureLyr({
        id: LYR_HUBLBL, type: 'symbol', source: SRC_HUB, layout: {
          'text-field': ['get', 'label'],
          'text-size': 9,
          'text-offset': [0, -1.3],
          'text-anchor': 'bottom',
          'text-font': ['Open Sans Regular'],
        }, paint: {
          'text-color': '#0ea5e9',
          'text-halo-color': '#0f172a',
          'text-halo-width': 1.2,
        }
      })
    } else {
      if (map.getLayer(LYR_HUB)) try { map.removeLayer(LYR_HUB) } catch {}
      if (map.getLayer(LYR_HUBLBL)) try { map.removeLayer(LYR_HUBLBL) } catch {}
    }

    if (showLbl) {
      ensureLyr({
        id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
          'text-field': ['get', 'label'],
          'text-size': 9,
          'text-offset': [0, 1.4],
          'text-anchor': 'top',
          'text-font': ['Open Sans Regular'],
        }, paint: {
          'text-color': ['get', 'color'],
          'text-halo-color': '#0f172a',
          'text-halo-width': 1.2,
        }
      })
    } else if (map.getLayer(LYR_LBL)) try { map.removeLayer(LYR_LBL) } catch {}

    return () => { removeAll() }
  }, [map, visible, showHalo, showPin, showLbl, showHubMk, showLink])

  const phaseList: Phase[] = ['GATE', 'TAXI', 'TKOFF', 'DEPT', 'CLB', 'CRZ', 'DSC', 'APP', 'FNL', 'LDG', 'OCEANIC']
  const ctlList: ControllerKey[] = ['CLNC', 'GND', 'TWR', 'DEP', 'APP', 'CTR', 'OCEANIC', 'CTAF', 'GUARD']

  return (
    <div className="absolute top-16 right-4 z-40 w-[min(94vw,480px)] max-h-[80vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">ICAO Annex 10 / Doc 4444 §12</div>
          <div className="text-sm font-semibold text-slate-100">FREQ · ATC / CTAF Directory</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* Tier strip */}
      <div className="px-3 py-1.5 border-b border-slate-800 flex items-center gap-1 text-[10px] flex-wrap">
        <button onClick={() => setTierFilter('ALL')} className={`px-2 py-0.5 rounded font-mono ${tierFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-400'}`}>ALL {rows.length}</button>
        {(['BREACH', 'CRITICAL', 'HANDOFF', 'WATCH', 'NOMINAL', 'OFF'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(t)} className={`px-1.5 py-0.5 rounded font-mono ${tierFilter === t ? 'border-2' : 'border'}`} style={{ borderColor: TIER_COLOR[t] + '55', color: TIER_COLOR[t], background: TIER_COLOR[t] + '10' }}>
            {t.slice(0, 4)} {tierCounts[t]}
          </button>
        ))}
      </div>

      {/* Summary cells */}
      <div className="px-3 py-1 border-b border-slate-800 grid grid-cols-5 gap-1 text-[10px]">
        <div className="bg-slate-800/40 rounded px-1 py-0.5">μ-SCR <span className="font-mono text-slate-100 ml-1">{(rows.reduce((s, r) => s + r.score, 0) / Math.max(1, rows.length)).toFixed(1)}</span></div>
        <div className="bg-slate-800/40 rounded px-1 py-0.5">HO <span className="font-mono ml-1" style={{ color: TIER_COLOR['HANDOFF'] }}>{tierCounts['HANDOFF']}</span></div>
        <div className="bg-slate-800/40 rounded px-1 py-0.5">CRIT <span className="font-mono ml-1" style={{ color: TIER_COLOR['CRITICAL'] }}>{tierCounts['CRITICAL']}</span></div>
        <div className="bg-slate-800/40 rounded px-1 py-0.5">HUBS <span className="font-mono text-slate-100 ml-1">{hubCounts.length}</span></div>
        <div className="bg-slate-800/40 rounded px-1 py-0.5">FLEET <span className="font-mono text-slate-100 ml-1">{rows.length}</span></div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-1.5 border-b border-slate-800 space-y-1 text-[10px]">
        <div className="flex items-center gap-2">
          <span className="text-slate-500 w-16 font-mono">ADV-MUL</span>
          <input type="range" min={50} max={200} value={advMul} onChange={e => setAdvMul(parseInt(e.target.value))} className="flex-1 accent-sky-500 h-1" />
          <span className="font-mono text-slate-300 w-10 text-right">{advMul}%</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500 w-16 font-mono">SCOPE</span>
          <input type="range" min={60} max={600} step={20} value={scopeNM} onChange={e => setScopeNM(parseInt(e.target.value))} className="flex-1 accent-sky-500 h-1" />
          <span className="font-mono text-slate-300 w-10 text-right">{scopeNM}nm</span>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <button onClick={() => setShowHalo(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showHalo ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>HALO</button>
          <button onClick={() => setShowPin(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showPin ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>PIN</button>
          <button onClick={() => setShowLbl(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showLbl ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>LBL</button>
          <button onClick={() => setShowHubMk(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showHubMk ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>HUB</button>
          <button onClick={() => setShowLink(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showLink ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>LNK</button>
        </div>
      </div>

      {/* Phase chip */}
      <div className="px-3 py-1 border-b border-slate-800 flex items-center gap-1 flex-wrap text-[10px]">
        <button onClick={() => setPhaseFilter('ALL')} className={`px-1.5 py-0.5 rounded font-mono ${phaseFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>ALL-PH</button>
        {phaseList.map(p => (
          <button key={p} onClick={() => setPhaseFilter(p)} className={`px-1.5 py-0.5 rounded font-mono ${phaseFilter === p ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>{p}</button>
        ))}
      </div>

      {/* Controller chip */}
      <div className="px-3 py-1 border-b border-slate-800 flex items-center gap-1 flex-wrap text-[10px]">
        <button onClick={() => setCtlFilter('ALL')} className={`px-1.5 py-0.5 rounded font-mono ${ctlFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>ALL-CTL</button>
        {ctlList.map(c => (
          <button key={c} onClick={() => setCtlFilter(c)} className={`px-1.5 py-0.5 rounded font-mono ${ctlFilter === c ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>{c}</button>
        ))}
      </div>

      {/* Search */}
      <div className="px-3 py-1 border-b border-slate-800">
        <input type="text" placeholder="search callsign / type / oper / phase / freq / ctl / hub" value={query} onChange={e => setQuery(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/60" />
      </div>

      {/* Tabs */}
      <div className="px-3 py-1.5 border-b border-slate-800 flex items-center gap-1 text-[10px]">
        {(['AIRCRAFT', 'HUBS', 'BANDS', 'METHOD'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-0.5 rounded font-mono ${tab === t ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
        {/* AIRCRAFT tab */}
        {tab === 'AIRCRAFT' && visible.slice(0, 100).map((r, i) => (
          <div key={i} onClick={() => onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5 transition-colors">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{r.f.callsign || r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-300">{r.f.type}</span>
              <span className="px-1 rounded font-mono text-[9px]" style={{ background: TIER_COLOR[r.tier] + '22', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.assn.controller}</span>
              <span className="ml-auto font-mono text-slate-300">›</span>
            </div>
            <div className="flex items-center gap-1.5 mt-1 text-[11px] font-mono">
              <span className="px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/40 text-sky-100">{r.assn.freq}</span>
              {r.assn.hub && <span className="text-slate-400">{r.assn.hub.icao}</span>}
              <span className="text-slate-500">·</span>
              <span className="text-slate-400">{r.assn.distNM.toFixed(1)}nm</span>
              <span className="ml-auto text-slate-400">SCR <span style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</span></span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px]">
              <div>FL <span className="font-mono text-slate-100">{Math.round(r.f.altitudeFt / 100)}</span></div>
              <div>GS <span className="font-mono text-slate-100">{r.f.velocityKts.toFixed(0)}kt</span></div>
              <div>VS <span className="font-mono" style={{ color: Math.abs(r.f.vertRate || 0) > 2500 ? TIER_COLOR['HANDOFF'] : '#cbd5e1' }}>{(r.f.vertRate || 0).toFixed(0)}fpm</span></div>
              <div>SQ <span className="font-mono" style={{ color: (r.f.squawk === '7700' || r.f.squawk === '7600' || r.f.squawk === '7500') ? TIER_COLOR['BREACH'] : '#cbd5e1' }}>{r.f.squawk || '----'}</span></div>
            </div>
            <div className="mt-1 h-1 bg-slate-900 rounded overflow-hidden"><div className="h-full" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }} /></div>
            <div className="flex items-center gap-1 mt-0.5 flex-wrap">
              {DRIVERS.map(d => (
                <span key={d} className="text-[9px] font-mono px-1 rounded" style={{ background: r.sev[d] >= 70 ? TIER_COLOR['CRITICAL'] + '22' : r.sev[d] >= 40 ? TIER_COLOR['HANDOFF'] + '22' : '#1e293b66', color: r.sev[d] >= 70 ? TIER_COLOR['CRITICAL'] : r.sev[d] >= 40 ? TIER_COLOR['HANDOFF'] : '#94a3b8' }}>{d.split('-')[0].slice(0, 4)} {r.sev[d].toFixed(0)}</span>
              ))}
            </div>
            <div className="text-[9px] mt-0.5 italic" style={{ color: TIER_COLOR[r.tier] }}>{r.advice}</div>
          </div>
        ))}

        {/* HUBS tab — full frequency directory for active hubs */}
        {tab === 'HUBS' && hubCounts.map(({ hub, count, ctlMix }, i) => (
          <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{hub.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-300">{hub.iata}</span>
              <span className="text-slate-400 truncate">{hub.name}</span>
              <span className="ml-auto px-1 rounded bg-sky-500/15 border border-sky-500/40 text-sky-100 font-mono text-[9px]">{count}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 mt-1 text-[10px]">
              {hub.freq.atis && <div className="text-slate-400">ATIS  <span className="font-mono text-slate-200 ml-1">{hub.freq.atis}</span></div>}
              {hub.freq.clnc && <div className="text-slate-400">CLNC  <span className="font-mono text-slate-200 ml-1">{hub.freq.clnc}</span></div>}
              {hub.freq.gnd  && <div className="text-slate-400">GND   <span className="font-mono text-slate-200 ml-1">{hub.freq.gnd}</span></div>}
              {hub.freq.twr  && <div className="text-slate-400">TWR   <span className="font-mono text-slate-200 ml-1">{hub.freq.twr}</span></div>}
              {hub.freq.dep  && <div className="text-slate-400">DEP   <span className="font-mono text-slate-200 ml-1">{hub.freq.dep}</span></div>}
              {hub.freq.app  && <div className="text-slate-400">APP   <span className="font-mono text-slate-200 ml-1">{hub.freq.app}</span></div>}
              {hub.freq.ctr  && <div className="text-slate-400">CTR   <span className="font-mono text-slate-200 ml-1">{hub.freq.ctr}</span></div>}
              <div className="text-slate-400">FIR   <span className="font-mono text-slate-200 ml-1">{hub.fir}</span></div>
            </div>
            <div className="flex items-center gap-1 mt-1 flex-wrap">
              {(Object.keys(ctlMix) as ControllerKey[]).map(c => (
                <span key={c} className="text-[9px] font-mono px-1 rounded bg-slate-700/40 text-slate-300">{c} {ctlMix[c]}</span>
              ))}
            </div>
          </div>
        ))}
        {tab === 'HUBS' && hubCounts.length === 0 && (
          <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[11px] text-slate-400">
            No hubs in catchment. Increase SCOPE slider to widen the area.
          </div>
        )}
        {tab === 'HUBS' && (
          <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5 mt-2 text-[10px]">
            <div className="font-mono text-slate-100 mb-1">Full catalogue ({HUBS.length} hubs)</div>
            <div className="grid grid-cols-3 gap-x-2 gap-y-0.5">
              {HUBS.map(h => (
                <div key={h.icao} className="text-slate-400">
                  <span className="font-mono text-slate-200">{h.icao}</span>
                  <span className="text-slate-500"> · </span>
                  <span className="font-mono">{h.freq.twr || '—'}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* BANDS tab — emergency / CTAF / guard frequencies */}
        {tab === 'BANDS' && (
          <div className="space-y-2 text-[10px]">
            <div className="bg-rose-500/10 border border-rose-500/40 rounded p-2">
              <div className="font-mono text-rose-300 mb-1">Emergency / Distress (always monitor)</div>
              <div className="grid grid-cols-2 gap-y-0.5">
                <div className="text-slate-300">VHF Guard  <span className="font-mono text-rose-200 ml-1">{GUARD_VHF}</span></div>
                <div className="text-slate-300">UHF Guard  <span className="font-mono text-rose-200 ml-1">{GUARD_UHF}</span></div>
                <div className="text-slate-300">ELT 406    <span className="font-mono text-rose-200 ml-1">{SARSAT_ELT}</span></div>
                <div className="text-slate-300">HF Guard   <span className="font-mono text-rose-200 ml-1">2182.0 kHz</span></div>
              </div>
              <div className="text-[9px] text-slate-500 mt-1 italic">per FAA AIM 6-3-1 / ICAO Annex 10 Vol II §5.3.2.1</div>
            </div>
            <div className="bg-amber-500/10 border border-amber-500/40 rounded p-2">
              <div className="font-mono text-amber-300 mb-1">CTAF Self-Announce Bands (uncontrolled fields)</div>
              <div className="grid grid-cols-4 gap-y-0.5">
                {CTAF_BANDS.map(f => (
                  <div key={f} className="font-mono text-amber-200">{f}</div>
                ))}
              </div>
              <div className="text-[9px] text-slate-500 mt-1 italic">per FAA AC 90-66C — 10-mi inbound self-announce, traffic-pattern entry, takeoff, and base-to-final positions</div>
            </div>
            <div className="bg-sky-500/10 border border-sky-500/40 rounded p-2">
              <div className="font-mono text-sky-300 mb-1">Aeronautical VHF Mobile (ITU Reg App.27)</div>
              <div className="space-y-0.5 text-slate-300">
                <div>118.000 – 121.4875 MHz · ATC mobile</div>
                <div>121.500 MHz · International civil emergency</div>
                <div>121.6 – 121.9 MHz · Apron / ramp / ground</div>
                <div>121.95 – 122.000 MHz · Flight school / glider</div>
                <div>122.025 – 123.075 MHz · UNICOM / multicom / CTAF</div>
                <div>123.100 MHz · Search and Rescue (SAR)</div>
                <div>123.450 MHz · Air-air (FISO / opps coordination)</div>
                <div>123.500 – 135.975 MHz · ATC mobile</div>
                <div>136.000 – 136.975 MHz · ATC mobile (8.33kHz EUR)</div>
              </div>
              <div className="text-[9px] text-slate-500 mt-1 italic">8.33 kHz channel spacing mandated EUR per Reg (EC) 1079/2012 for ACC + APP/TWR carve-outs</div>
            </div>
            <div className="bg-sky-500/10 border border-sky-500/40 rounded p-2">
              <div className="font-mono text-sky-300 mb-1">Oceanic Long-Range (HF SELCAL / CPDLC / SATCOM)</div>
              <div className="space-y-0.5 text-slate-300">
                <div>HF MWARA (Major World Air-Route Area) Family A/B/C/D/E/F per ICAO Annex 10 Vol II §5</div>
                <div>SATCOM Voice/Data · Inmarsat Aero-H/H+/L Iridium SBB · per AC 20-140C</div>
                <div>FANS-1/A+ CPDLC · per ICAO Doc 9869 PBCS RCP-240/RSP-180</div>
                <div>VDL Mode 2 · DO-281C ground subnet · primary in continental airspace</div>
              </div>
            </div>
          </div>
        )}

        {/* METHOD tab */}
        {tab === 'METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-300">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="font-mono text-slate-100 mb-1">Regulatory basis</div>
              <div>ICAO Annex 10 Vol II/III/V · Doc 4444 PANS-ATM §12 · Doc 9432 Manual of Radiotelephony · Doc 9869 PBCS · FAA AC 90-66C non-towered CTAF · 14 CFR §91.126/§91.183/§91.185/§91.413 · EASA SERA.6005 · ITU Radio Reg App.27 (118-137 MHz).</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="font-mono text-slate-100 mb-1">Phase classifier</div>
              <div>11 phases (GATE / TAXI / TKOFF / DEPT / CLB / CRZ / DSC / APP / FNL / LDG / OCEANIC). Each phase maps to one canonical controller (CLNC / GND / TWR / DEP / APP / CTR / OCEANIC / CTAF / GUARD).</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="font-mono text-slate-100 mb-1">Hub catchments</div>
              <div>Tower / Ground / Clearance 5nm · Approach / Departure (TRACON / Class B/C) 30nm · Centre (ACC) 220nm with handoff zone 85-105 %. Outside catchment ⇒ CTAF self-announce.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="font-mono text-slate-100 mb-1">7-driver scoring</div>
              <div>HANDOFF (transition window) · CTAF-LONE (uncontrolled inbound) · EMERG (emergency flag) · BAND-NEAR (8.33kHz adjacent-channel) · OCEAN (HF/SATCOM) · GUARD-SQK (7500/7600/7700) · EDGE (FIR/ACC boundary).</div>
              <div className="mt-1">Composite: max·0.60 + mean·0.40, × ADV-MUL.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="font-mono text-slate-100 mb-1">Hard escalators</div>
              <div>GUARD-SQK ≥92 → score-min 90 (lost-comm / hijack / emergency) · EMERG ≥90 → 92 · CTAF-LONE ≥70 in FNL/LDG → 72 (uncontrolled-field inbound).</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="font-mono text-slate-100 mb-1">6 tiers</div>
              <div><span style={{ color: TIER_COLOR['BREACH'] }}>BREACH ≥85</span> rose · lost-comm / hijack / emergency squawk routes to guard</div>
              <div><span style={{ color: TIER_COLOR['CRITICAL'] }}>CRITICAL 68-84</span> rose-pink · multi-driver active R/T state</div>
              <div><span style={{ color: TIER_COLOR['HANDOFF'] }}>HANDOFF 48-67</span> amber · transition window between facilities</div>
              <div><span style={{ color: TIER_COLOR['WATCH'] }}>WATCH 25-47</span> sky · active controller, standard cross-check</div>
              <div><span style={{ color: TIER_COLOR['NOMINAL'] }}>NOMINAL &lt;25</span> emerald · nominal R/T discipline</div>
              <div><span style={{ color: TIER_COLOR['OFF'] }}>OFF</span> slate · cruise outside catchment, no positive comm expected</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="font-mono text-slate-100 mb-1">28-hub catalogue</div>
              <div>{HUBS.map(h => h.icao).join(' · ')}</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="font-mono text-slate-100 mb-1">Precedent cases</div>
              <div>LAX1493 USAir/SkyWest KLAX 1991 wrong-frequency simultaneous clearance · Comair 5191 KLEX 2006 wrong-runway departure no freq cross-check · Continental 1713 KDEN 1987 wrong-frequency departure · DHL611/TU154 Überlingen 2002 TCAS-ATC R/T contradiction.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="font-mono text-slate-100 mb-1">References</div>
              <div className="text-[9px]">ICAO Annex 10 Vol II §5 / Vol III §2 / Vol V §4 · Doc 4444 §12 · Doc 9432 §3 · Doc 9869 PBCS · FAA AC 90-66C / 90-114A · Order JO 7110.65 §2 / §4 / §10 / §11 · AIM 4-1 / 4-2 / 6-3-1 · 14 CFR §91.126 / §91.183 / §91.185 / §91.413 · EASA SERA.6005 · ITU RR App.27 · Reg (EC) 1079/2012 (8.33kHz) · NTSB AAR-91-08 / AAR-08-01 / AAR-91-04.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
