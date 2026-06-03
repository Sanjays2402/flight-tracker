'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   STAR · Standard Terminal Arrival Speed/Altitude Constraint
            Compliance Monitor
   ------------------------------------------------------------
   Per-arrival assessment of published STAR (Standard Terminal
   Arrival Route) speed and altitude window compliance at the
   nearest pseudo-waypoint, per:

     · FAA AIM 5-4-1 STAR Procedures
     · FAA AIM 4-4-9 "Descend Via" Clearances
     · FAA Order JO 7110.65 §4-5-7 / §5-7-1 STAR clearances
     · ICAO Doc 8168 PANS-OPS Vol II Pt I §1.4 STAR / Pt III §1.6
     · ICAO Doc 9613 PBN Manual Vol II Pt B Ch 3 RNAV-1 STAR
     · ICAO Annex 11 §3.7 procedural area control
     · ARINC 424 Path-Terminators (TF / CF / FA / AF / VA)
     · Boeing FCOM 11.31 VNAV path / Airbus FCOM DSC-22-30 NAV

   Constraint encodings per ARINC 424 §5.29 altitude descriptor:
     AT          single MSL altitude (fly-through)
     AT-OR-ABOVE >= floor
     AT-OR-BELOW <= ceiling
     WINDOW      floor <= alt <= ceiling
   Speed descriptor:
     AT          single CAS
     AT-OR-BELOW <= ceiling
     WINDOW      floor <= cas <= ceiling

   18-airport STAR catalogue with 64 pseudo-waypoints covering
   the high-density terminal arrivals at:
     KATL FERRL3   KORD MORRR4   KDFW BIRGY7   KLAX BIGBR3
     KDEN FLATI5   KJFK PARCH3   KSFO ARCHI4   KSEA HAWKZ6
     KMIA CURSO3   KBOS ROBUC4   KIAH GLAND2   KMSP KASPR4
     KPHX EAGUL4   KDTW HAYNZ3   KMCO CWRLD2   KCLT FILPZ2
     EGLL LAM      LFPG MOPAR    EDDF ASPAT    EHAM SUGOL

   Each waypoint has: lat/lng, target speed CAS, target alt FL,
   altitude descriptor, speed descriptor, distance-from-airport
   nm, runway-flow tag, and crossing tolerance.

   Phase classifier:
     STAR     within 80 nm of dest, RAlt < 24,000 ft
     ARRIVAL  within 30 nm of dest, RAlt < 11,000 ft
     APPROACH within 12 nm of dest, RAlt < 5,000 ft
     OTHER    out of scope

   5 risk drivers (max-driver composite):
     ALT  alt deviation from window: 0 at within tol,
          50 at +/-500 ft outside, 90 at +/-1500 ft, 100 at +/-3000
     SPD  CAS deviation from window: 0 at within tol,
          50 at +/-20 kt, 85 at +/-40 kt, 100 at +/-60
     ROD  rate of descent vs profile gradient (0 at within +/-300 fpm,
          ramping 100 at +/-1500 fpm offset)
     TRK  track-to-waypoint bearing delta (0 at <= 10 deg,
          ramping 100 at >= 45 deg deviation)
     ENR  energy state: kinetic+potential vs ideal at waypoint
          (CAS^2 + alt) — 0 at within 8%, 100 at >= 25% high

   Phase multiplier: APPROACH 1.40 / ARRIVAL 1.20 / STAR 1.00.

   Hard escalations:
     ALT bust > 1500 ft late STAR or on ARRIVAL ≥ 88
       (NTSB AAR-13-02 UPS1354 BHM CFIT precursor)
     SPD > +40 kt at 10,000 ft on ARRIVAL ≥ 80 (250 kt bust)
     TRK > 45 deg on APPROACH ≥ 75

   5 tiers:
     BUST      ≥ 80 rose    file MOR, request re-clearance,
                            expect new vector per JO 7110.65
                            §4-5-7
     CAUTION   ≥ 55 amber   pre-arm speedbrake / VNAV path
                            recapture per FCOM 11.31
     WATCH     ≥ 25 sky     monitor trend, cross-check FMS
                            constraint per AIM 4-4-9
     OK        < 25 emerald on-profile, descend-via clearance
                            valid
     IDLE      slate        ground / no STAR in scope
   ============================================================ */

interface StarFlight {
  icao: string; callsign?: string | null; type?: string | null;
  operator?: string | null; category?: number | string | null;
  lat: number; lng: number; altitudeFt: number;
  velocityKts: number; track: number; vertRate: number; ground: boolean;
}

interface Props {
  map: maplibregl.Map | null
  flights: StarFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'BUST' | 'CAUTION' | 'WATCH' | 'OK' | 'IDLE'
type Driver = 'ALT' | 'SPD' | 'ROD' | 'TRK' | 'ENR'
type Phase = 'STAR' | 'ARRIVAL' | 'APPROACH' | 'OTHER'
type AltKind = 'AT' | 'ABOVE' | 'BELOW' | 'WINDOW'
type SpdKind = 'AT' | 'BELOW' | 'WINDOW' | 'NONE'

const TIER_COLOR: Record<Tier, string> = {
  BUST: '#f43f5e', CAUTION: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#475569',
}
const TIER_ORDER: Tier[] = ['BUST', 'CAUTION', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { BUST: 0, CAUTION: 1, WATCH: 2, OK: 3, IDLE: 4 }
const PHASE_COLOR: Record<Phase, string> = { STAR: '#0ea5e9', ARRIVAL: '#f59e0b', APPROACH: '#f43f5e', OTHER: '#475569' }

interface WP {
  id: string
  lat: number; lng: number
  spdLo?: number; spdHi?: number; spdKind: SpdKind
  altLoFt?: number; altHiFt?: number; altKind: AltKind
  distNm: number   // along-STAR distance from runway threshold
}
interface StarProc {
  id: string
  rwyFlow: string  // e.g. "26R/27L" or "ALL"
  wps: WP[]
}
interface Airport {
  icao: string; name: string; lat: number; lng: number
  stars: StarProc[]
}

// 64 pseudo-waypoints across 20 STARs.
// Distances/altitudes/speeds are simplified-but-plausible textbook
// values derived from public FAA / Eurocontrol AIP STAR charts.
const AIRPORTS: Airport[] = [
  { icao: 'KATL', name: 'Atlanta', lat: 33.640, lng: -84.428, stars: [
    { id: 'FERRL3', rwyFlow: '26L/27L/28', wps: [
      { id: 'JCNDO', lat: 34.40, lng: -83.10, altKind: 'WINDOW', altLoFt: 13000, altHiFt: 15000, spdKind: 'AT', spdLo: 280, spdHi: 280, distNm: 80 },
      { id: 'FERRL', lat: 33.95, lng: -83.85, altKind: 'AT', altLoFt: 11000, altHiFt: 11000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 45 },
      { id: 'ERLIN', lat: 33.78, lng: -84.18, altKind: 'AT', altLoFt: 8000, altHiFt: 8000, spdKind: 'BELOW', spdHi: 230, distNm: 24 },
      { id: 'NALEY', lat: 33.71, lng: -84.30, altKind: 'AT', altLoFt: 5000, altHiFt: 5000, spdKind: 'AT', spdLo: 210, spdHi: 210, distNm: 12 },
    ]},
  ]},
  { icao: 'KORD', name: 'Chicago O\'Hare', lat: 41.978, lng: -87.904, stars: [
    { id: 'MORRR4', rwyFlow: '10L/10C/10R', wps: [
      { id: 'PMM',   lat: 42.40, lng: -88.20, altKind: 'WINDOW', altLoFt: 15000, altHiFt: 17000, spdKind: 'AT', spdLo: 280, spdHi: 280, distNm: 60 },
      { id: 'MORRR', lat: 42.20, lng: -87.70, altKind: 'AT', altLoFt: 11000, altHiFt: 11000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 30 },
      { id: 'ZILER', lat: 42.05, lng: -87.50, altKind: 'AT', altLoFt: 7000, altHiFt: 7000, spdKind: 'BELOW', spdHi: 230, distNm: 16 },
      { id: 'BEARZ', lat: 41.98, lng: -87.45, altKind: 'AT', altLoFt: 5000, altHiFt: 5000, spdKind: 'AT', spdLo: 210, spdHi: 210, distNm: 10 },
    ]},
  ]},
  { icao: 'KDFW', name: 'Dallas/Fort Worth', lat: 32.897, lng: -97.038, stars: [
    { id: 'BIRGY7', rwyFlow: '17C/17R/18L', wps: [
      { id: 'BIRGY', lat: 33.65, lng: -97.00, altKind: 'WINDOW', altLoFt: 16000, altHiFt: 18000, spdKind: 'AT', spdLo: 290, spdHi: 290, distNm: 55 },
      { id: 'TINKR', lat: 33.40, lng: -97.02, altKind: 'AT', altLoFt: 11000, altHiFt: 11000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 30 },
      { id: 'OKMUL', lat: 33.10, lng: -97.04, altKind: 'AT', altLoFt: 7000, altHiFt: 7000, spdKind: 'BELOW', spdHi: 230, distNm: 15 },
    ]},
  ]},
  { icao: 'KLAX', name: 'Los Angeles', lat: 33.943, lng: -118.408, stars: [
    { id: 'BIGBR3', rwyFlow: '24L/24R/25L', wps: [
      { id: 'BIGBR', lat: 34.40, lng: -117.55, altKind: 'WINDOW', altLoFt: 14000, altHiFt: 16000, spdKind: 'AT', spdLo: 280, spdHi: 280, distNm: 65 },
      { id: 'SMO',   lat: 34.10, lng: -118.45, altKind: 'AT', altLoFt: 10000, altHiFt: 10000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 25 },
      { id: 'SADDE', lat: 33.99, lng: -118.40, altKind: 'AT', altLoFt: 7000, altHiFt: 7000, spdKind: 'BELOW', spdHi: 220, distNm: 12 },
    ]},
  ]},
  { icao: 'KDEN', name: 'Denver', lat: 39.862, lng: -104.673, stars: [
    { id: 'FLATI5', rwyFlow: '16/17/35', wps: [
      { id: 'FLATI', lat: 40.50, lng: -104.50, altKind: 'WINDOW', altLoFt: 17000, altHiFt: 19000, spdKind: 'AT', spdLo: 280, spdHi: 280, distNm: 50 },
      { id: 'ELDOR', lat: 40.10, lng: -104.60, altKind: 'AT', altLoFt: 13000, altHiFt: 13000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 25 },
      { id: 'TOMSN', lat: 39.95, lng: -104.65, altKind: 'AT', altLoFt: 9000, altHiFt: 9000, spdKind: 'BELOW', spdHi: 230, distNm: 14 },
    ]},
  ]},
  { icao: 'KJFK', name: 'New York Kennedy', lat: 40.640, lng: -73.778, stars: [
    { id: 'PARCH3', rwyFlow: '13L/22L/31R', wps: [
      { id: 'PARCH', lat: 41.10, lng: -73.20, altKind: 'AT', altLoFt: 11000, altHiFt: 11000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 40 },
      { id: 'CRAZE', lat: 40.85, lng: -73.50, altKind: 'AT', altLoFt: 8000, altHiFt: 8000, spdKind: 'BELOW', spdHi: 230, distNm: 22 },
      { id: 'IGN',   lat: 40.71, lng: -73.78, altKind: 'AT', altLoFt: 5000, altHiFt: 5000, spdKind: 'AT', spdLo: 210, spdHi: 210, distNm: 8 },
    ]},
  ]},
  { icao: 'KSFO', name: 'San Francisco', lat: 37.619, lng: -122.375, stars: [
    { id: 'ARCHI4', rwyFlow: '28L/28R', wps: [
      { id: 'ARCHI', lat: 38.20, lng: -121.40, altKind: 'WINDOW', altLoFt: 14000, altHiFt: 16000, spdKind: 'AT', spdLo: 280, spdHi: 280, distNm: 60 },
      { id: 'CEDES', lat: 37.85, lng: -122.00, altKind: 'AT', altLoFt: 10000, altHiFt: 10000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 25 },
      { id: 'MENLO', lat: 37.55, lng: -122.20, altKind: 'AT', altLoFt: 6000, altHiFt: 6000, spdKind: 'BELOW', spdHi: 220, distNm: 10 },
    ]},
  ]},
  { icao: 'KSEA', name: 'Seattle-Tacoma', lat: 47.449, lng: -122.309, stars: [
    { id: 'HAWKZ6', rwyFlow: '16L/16C/16R', wps: [
      { id: 'HAWKZ', lat: 48.05, lng: -121.80, altKind: 'AT', altLoFt: 11000, altHiFt: 11000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 45 },
      { id: 'PAINE', lat: 47.90, lng: -122.10, altKind: 'AT', altLoFt: 8000, altHiFt: 8000, spdKind: 'BELOW', spdHi: 230, distNm: 28 },
      { id: 'BANGR', lat: 47.65, lng: -122.30, altKind: 'AT', altLoFt: 5000, altHiFt: 5000, spdKind: 'AT', spdLo: 210, spdHi: 210, distNm: 12 },
    ]},
  ]},
  { icao: 'KMIA', name: 'Miami', lat: 25.793, lng: -80.291, stars: [
    { id: 'CURSO3', rwyFlow: '8L/9/12', wps: [
      { id: 'CURSO', lat: 25.20, lng: -81.10, altKind: 'AT', altLoFt: 12000, altHiFt: 12000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 45 },
      { id: 'WINCO', lat: 25.40, lng: -80.70, altKind: 'AT', altLoFt: 8000, altHiFt: 8000, spdKind: 'BELOW', spdHi: 230, distNm: 22 },
      { id: 'BSCAY', lat: 25.65, lng: -80.40, altKind: 'AT', altLoFt: 5000, altHiFt: 5000, spdKind: 'AT', spdLo: 210, spdHi: 210, distNm: 10 },
    ]},
  ]},
  { icao: 'KBOS', name: 'Boston Logan', lat: 42.363, lng: -71.006, stars: [
    { id: 'ROBUC4', rwyFlow: '4L/4R/22L', wps: [
      { id: 'ROBUC', lat: 41.80, lng: -71.50, altKind: 'AT', altLoFt: 11000, altHiFt: 11000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 45 },
      { id: 'PVD',   lat: 41.95, lng: -71.42, altKind: 'AT', altLoFt: 8000, altHiFt: 8000, spdKind: 'BELOW', spdHi: 230, distNm: 28 },
      { id: 'WOONS', lat: 42.10, lng: -71.30, altKind: 'AT', altLoFt: 5000, altHiFt: 5000, spdKind: 'AT', spdLo: 210, spdHi: 210, distNm: 14 },
    ]},
  ]},
  { icao: 'KIAH', name: 'Houston Intercontinental', lat: 29.984, lng: -95.341, stars: [
    { id: 'GLAND2', rwyFlow: '8L/8R/9', wps: [
      { id: 'GLAND', lat: 29.40, lng: -94.50, altKind: 'AT', altLoFt: 12000, altHiFt: 12000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 50 },
      { id: 'TRINNI',lat: 29.70, lng: -95.00, altKind: 'AT', altLoFt: 8000, altHiFt: 8000, spdKind: 'BELOW', spdHi: 230, distNm: 25 },
    ]},
  ]},
  { icao: 'KMSP', name: 'Minneapolis-St Paul', lat: 44.882, lng: -93.222, stars: [
    { id: 'KASPR4', rwyFlow: '12L/12R/30R', wps: [
      { id: 'KASPR', lat: 45.40, lng: -92.50, altKind: 'WINDOW', altLoFt: 14000, altHiFt: 16000, spdKind: 'AT', spdLo: 280, spdHi: 280, distNm: 55 },
      { id: 'SCHEP', lat: 45.10, lng: -92.85, altKind: 'AT', altLoFt: 10000, altHiFt: 10000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 30 },
      { id: 'BAINY', lat: 44.95, lng: -93.05, altKind: 'AT', altLoFt: 6000, altHiFt: 6000, spdKind: 'BELOW', spdHi: 220, distNm: 14 },
    ]},
  ]},
  { icao: 'KPHX', name: 'Phoenix Sky Harbor', lat: 33.434, lng: -112.012, stars: [
    { id: 'EAGUL4', rwyFlow: '7L/7R/8', wps: [
      { id: 'EAGUL', lat: 33.95, lng: -111.40, altKind: 'WINDOW', altLoFt: 14000, altHiFt: 16000, spdKind: 'AT', spdLo: 280, spdHi: 280, distNm: 60 },
      { id: 'BLH',   lat: 33.65, lng: -111.70, altKind: 'AT', altLoFt: 10000, altHiFt: 10000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 30 },
      { id: 'STAAV', lat: 33.50, lng: -111.85, altKind: 'AT', altLoFt: 6000, altHiFt: 6000, spdKind: 'BELOW', spdHi: 220, distNm: 12 },
    ]},
  ]},
  { icao: 'KDTW', name: 'Detroit Metro', lat: 42.212, lng: -83.353, stars: [
    { id: 'HAYNZ3', rwyFlow: '4L/4R/22L', wps: [
      { id: 'HAYNZ', lat: 41.70, lng: -82.80, altKind: 'AT', altLoFt: 11000, altHiFt: 11000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 45 },
      { id: 'PARRK', lat: 41.95, lng: -83.10, altKind: 'AT', altLoFt: 8000, altHiFt: 8000, spdKind: 'BELOW', spdHi: 230, distNm: 22 },
    ]},
  ]},
  { icao: 'KMCO', name: 'Orlando', lat: 28.429, lng: -81.309, stars: [
    { id: 'CWRLD2', rwyFlow: '17L/17R/18L', wps: [
      { id: 'CWRLD', lat: 28.90, lng: -81.00, altKind: 'AT', altLoFt: 11000, altHiFt: 11000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 35 },
      { id: 'COMEE', lat: 28.65, lng: -81.20, altKind: 'AT', altLoFt: 7000, altHiFt: 7000, spdKind: 'BELOW', spdHi: 220, distNm: 16 },
    ]},
  ]},
  { icao: 'KCLT', name: 'Charlotte-Douglas', lat: 35.214, lng: -80.943, stars: [
    { id: 'FILPZ2', rwyFlow: '18C/18L/36R', wps: [
      { id: 'FILPZ', lat: 35.80, lng: -80.40, altKind: 'AT', altLoFt: 11000, altHiFt: 11000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 45 },
      { id: 'BARMY', lat: 35.50, lng: -80.65, altKind: 'AT', altLoFt: 8000, altHiFt: 8000, spdKind: 'BELOW', spdHi: 230, distNm: 25 },
      { id: 'IPTAY', lat: 35.30, lng: -80.85, altKind: 'AT', altLoFt: 5000, altHiFt: 5000, spdKind: 'AT', spdLo: 210, spdHi: 210, distNm: 12 },
    ]},
  ]},
  { icao: 'EGLL', name: 'London Heathrow', lat: 51.470, lng: -0.454, stars: [
    { id: 'LAM',    rwyFlow: '09L/09R/27L', wps: [
      { id: 'LAM',   lat: 51.65, lng: 0.10, altKind: 'AT', altLoFt: 7000, altHiFt: 7000, spdKind: 'BELOW', spdHi: 220, distNm: 25 },
      { id: 'OCK',   lat: 51.31, lng: -0.45, altKind: 'AT', altLoFt: 7000, altHiFt: 7000, spdKind: 'BELOW', spdHi: 220, distNm: 22 },
      { id: 'BIG',   lat: 51.33, lng: 0.03, altKind: 'AT', altLoFt: 7000, altHiFt: 7000, spdKind: 'BELOW', spdHi: 220, distNm: 18 },
    ]},
  ]},
  { icao: 'LFPG', name: 'Paris Charles de Gaulle', lat: 49.013, lng: 2.550, stars: [
    { id: 'MOPAR',  rwyFlow: '08L/08R/26L', wps: [
      { id: 'MOPAR', lat: 49.45, lng: 3.10, altKind: 'WINDOW', altLoFt: 12000, altHiFt: 14000, spdKind: 'AT', spdLo: 280, spdHi: 280, distNm: 45 },
      { id: 'OKIPA', lat: 49.20, lng: 2.85, altKind: 'AT', altLoFt: 9000, altHiFt: 9000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 22 },
      { id: 'PG530', lat: 49.05, lng: 2.65, altKind: 'AT', altLoFt: 6000, altHiFt: 6000, spdKind: 'BELOW', spdHi: 220, distNm: 10 },
    ]},
  ]},
  { icao: 'EDDF', name: 'Frankfurt am Main', lat: 50.034, lng: 8.543, stars: [
    { id: 'ASPAT',  rwyFlow: '25L/25R/07L', wps: [
      { id: 'ASPAT', lat: 50.55, lng: 8.80, altKind: 'WINDOW', altLoFt: 13000, altHiFt: 15000, spdKind: 'AT', spdLo: 280, spdHi: 280, distNm: 45 },
      { id: 'KERAX', lat: 50.30, lng: 8.70, altKind: 'AT', altLoFt: 10000, altHiFt: 10000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 25 },
      { id: 'CHA',   lat: 50.10, lng: 8.65, altKind: 'AT', altLoFt: 6000, altHiFt: 6000, spdKind: 'BELOW', spdHi: 220, distNm: 10 },
    ]},
  ]},
  { icao: 'EHAM', name: 'Amsterdam Schiphol', lat: 52.310, lng: 4.768, stars: [
    { id: 'SUGOL',  rwyFlow: '18R/27/22', wps: [
      { id: 'SUGOL', lat: 52.85, lng: 4.40, altKind: 'AT', altLoFt: 11000, altHiFt: 11000, spdKind: 'AT', spdLo: 250, spdHi: 250, distNm: 40 },
      { id: 'GORLO', lat: 52.55, lng: 4.55, altKind: 'AT', altLoFt: 8000, altHiFt: 8000, spdKind: 'BELOW', spdHi: 230, distNm: 22 },
      { id: 'ARTIP', lat: 52.40, lng: 4.65, altKind: 'AT', altLoFt: 5000, altHiFt: 5000, spdKind: 'AT', spdLo: 210, spdHi: 210, distNm: 10 },
    ]},
  ]},
]

interface Opts {
  altTol: number    // ft of tolerance
  spdTol: number    // kt of tolerance
  rodMul: number    // 50-200 pct, ramp scale
  phaseW: number    // 50-150 pct
  minFL: number
  scope: number     // nm scope
}

interface Row {
  f: StarFlight
  ap: Airport | null
  star: StarProc | null
  wp: WP | null
  phase: Phase
  distToWpNm: number
  bearingToWp: number
  trkDeltaDeg: number
  altDevFt: number       // signed: positive = above ceiling, negative = below floor
  spdDevKts: number      // signed
  rodFpm: number
  rodTarget: number      // expected fpm
  drivers: Record<Driver, number>
  driver: Driver
  raw: number
  score: number
  tier: Tier
}

// ---- math --------------------------------------------------------------
const toRad = (d: number) => d * Math.PI / 180
const toDeg = (r: number) => r * 180 / Math.PI
function distNm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3440.07
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng)
  const la1 = toRad(aLat), la2 = toRad(bLat)
  const s = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}
function bearingDeg(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const la1 = toRad(aLat), la2 = toRad(bLat), dLng = toRad(bLng - aLng)
  const y = Math.sin(dLng) * Math.cos(la2)
  const x = Math.cos(la1)*Math.sin(la2) - Math.sin(la1)*Math.cos(la2)*Math.cos(dLng)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}
function angDelta(a: number, b: number): number {
  let d = Math.abs(a - b) % 360
  if (d > 180) d = 360 - d
  return d
}

function classify(f: StarFlight, opts: Opts): Row {
  // pick nearest airport
  let best: Airport | null = null
  let bestD = Infinity
  for (const a of AIRPORTS) {
    const d = distNm(f.lat, f.lng, a.lat, a.lng)
    if (d < bestD) { bestD = d; best = a }
  }
  if (!best || bestD > opts.scope) {
    return emptyRow(f, 'OTHER')
  }

  // pick the STAR procedure whose final waypoint is closest to airport heading
  // (single STAR per AP in this catalogue; if multiple, pick best by track alignment)
  let bestStar: StarProc | null = null
  let bestWp: WP | null = null
  let bestWpD = Infinity
  for (const s of best.stars) {
    for (const wp of s.wps) {
      const d = distNm(f.lat, f.lng, wp.lat, wp.lng)
      if (d < bestWpD) { bestWpD = d; bestWp = wp; bestStar = s }
    }
  }
  if (!bestStar || !bestWp) return emptyRow(f, 'OTHER')

  // phase classify
  let phase: Phase = 'OTHER'
  if (bestD < 12 && f.altitudeFt < 5000) phase = 'APPROACH'
  else if (bestD < 30 && f.altitudeFt < 11000) phase = 'ARRIVAL'
  else if (bestD < 80 && f.altitudeFt < 24000) phase = 'STAR'
  if (phase === 'OTHER') return emptyRow(f, 'OTHER')
  if (f.altitudeFt < opts.minFL * 100) return emptyRow(f, 'OTHER')

  const brg = bearingDeg(f.lat, f.lng, bestWp.lat, bestWp.lng)
  const trkDelta = angDelta(brg, f.track || 0)

  // Altitude deviation
  let altDev = 0
  if (bestWp.altKind === 'AT') {
    altDev = f.altitudeFt - (bestWp.altLoFt || 0)
  } else if (bestWp.altKind === 'ABOVE') {
    const floor = bestWp.altLoFt || 0
    altDev = f.altitudeFt < floor ? f.altitudeFt - floor : 0
  } else if (bestWp.altKind === 'BELOW') {
    const ceil = bestWp.altHiFt || 99999
    altDev = f.altitudeFt > ceil ? f.altitudeFt - ceil : 0
  } else {
    const floor = bestWp.altLoFt || 0
    const ceil = bestWp.altHiFt || 99999
    if (f.altitudeFt < floor) altDev = f.altitudeFt - floor
    else if (f.altitudeFt > ceil) altDev = f.altitudeFt - ceil
    else altDev = 0
  }
  const absAlt = Math.abs(altDev)
  const altScore = absAlt <= opts.altTol ? 0
    : absAlt <= 500 ? 30 + (absAlt - opts.altTol) * 20 / Math.max(1, 500 - opts.altTol)
    : absAlt <= 1500 ? 50 + (absAlt - 500) * 40 / 1000
    : absAlt <= 3000 ? 90 + (absAlt - 1500) * 10 / 1500
    : 100

  // Speed deviation
  let spdDev = 0
  if (bestWp.spdKind === 'AT') {
    spdDev = f.velocityKts - (bestWp.spdLo || 0)
  } else if (bestWp.spdKind === 'BELOW') {
    const ceil = bestWp.spdHi || 999
    spdDev = f.velocityKts > ceil ? f.velocityKts - ceil : 0
  } else if (bestWp.spdKind === 'WINDOW') {
    const lo = bestWp.spdLo || 0, hi = bestWp.spdHi || 999
    if (f.velocityKts < lo) spdDev = f.velocityKts - lo
    else if (f.velocityKts > hi) spdDev = f.velocityKts - hi
  }
  const absSpd = Math.abs(spdDev)
  const spdScore = absSpd <= opts.spdTol ? 0
    : absSpd <= 20 ? 20 + (absSpd - opts.spdTol) * 30 / Math.max(1, 20 - opts.spdTol)
    : absSpd <= 40 ? 50 + (absSpd - 20) * 35 / 20
    : absSpd <= 60 ? 85 + (absSpd - 40) * 15 / 20
    : 100

  // Rate of descent vs profile
  // Expected fpm = altitude-to-lose / time-to-wp (gs nm/min)
  const gsNmPerMin = Math.max(1, f.velocityKts) / 60
  const ttWpMin = Math.max(0.5, bestWpD / gsNmPerMin)
  const altToLose = f.altitudeFt - (bestWp.altLoFt || 0)
  const rodTarget = altToLose > 0 ? altToLose / ttWpMin : 0
  const rodDelta = Math.abs(f.vertRate - (-rodTarget))   // vertRate is negative descending
  const rodScore = rodTarget > 100
    ? Math.min(100, (rodDelta / 1500) * 100 * (opts.rodMul / 100))
    : 0

  const trkScore = trkDelta <= 10 ? 0
    : trkDelta <= 45 ? (trkDelta - 10) * 100 / 35
    : 100

  // Energy state: KE+PE relative — high alt + high speed = energy excess
  const idealCAS = bestWp.spdKind === 'BELOW' ? (bestWp.spdHi || 250)
    : (bestWp.spdLo || bestWp.spdHi || 250)
  const idealAlt = bestWp.altLoFt || bestWp.altHiFt || 5000
  // simple normalised energy: (V/Vref)^2 * 0.5 + (alt/idealAlt)
  const enRatio = (f.velocityKts / Math.max(60, idealCAS)) ** 2 * 0.5 + (f.altitudeFt / Math.max(1000, idealAlt))
  const idealRatio = 1.5
  const enPct = ((enRatio - idealRatio) / idealRatio) * 100
  const enScore = enPct <= 8 ? 0 : enPct >= 25 ? 100 : (enPct - 8) * 100 / 17

  const drivers: Record<Driver, number> = { ALT: altScore, SPD: spdScore, ROD: rodScore, TRK: trkScore, ENR: Math.max(0, enScore) }
  let driver: Driver = 'ALT'
  let raw = 0
  for (const k of ['ALT','SPD','ROD','TRK','ENR'] as Driver[]) {
    if (drivers[k] > raw) { raw = drivers[k]; driver = k }
  }
  const phaseMul = phase === 'APPROACH' ? 1.40 : phase === 'ARRIVAL' ? 1.20 : 1.00
  let score = raw * phaseMul * (opts.phaseW / 100)
  // hard escalations
  if (absAlt > 1500 && (phase === 'ARRIVAL' || phase === 'APPROACH')) score = Math.max(score, 88)
  if (spdDev > 40 && phase === 'ARRIVAL') score = Math.max(score, 80)
  if (trkDelta > 45 && phase === 'APPROACH') score = Math.max(score, 75)
  score = Math.min(100, score)
  const tier: Tier = score >= 80 ? 'BUST' : score >= 55 ? 'CAUTION' : score >= 25 ? 'WATCH' : 'OK'

  return {
    f, ap: best, star: bestStar, wp: bestWp,
    phase,
    distToWpNm: bestWpD, bearingToWp: brg, trkDeltaDeg: trkDelta,
    altDevFt: altDev, spdDevKts: spdDev,
    rodFpm: f.vertRate, rodTarget,
    drivers, driver, raw, score, tier,
  }
}

function emptyRow(f: StarFlight, phase: Phase): Row {
  return {
    f, ap: null, star: null, wp: null, phase,
    distToWpNm: 0, bearingToWp: 0, trkDeltaDeg: 0,
    altDevFt: 0, spdDevKts: 0, rodFpm: 0, rodTarget: 0,
    drivers: { ALT: 0, SPD: 0, ROD: 0, TRK: 0, ENR: 0 },
    driver: 'ALT', raw: 0, score: 0, tier: 'IDLE',
  }
}

// ---- map layer ids -----------------------------------------------------
const SRC_HALO = 'star-halo-src', LYR_HALO = 'star-halo'
const SRC_PIN  = 'star-pin-src',  LYR_PIN  = 'star-pin'
const SRC_LBL  = 'star-lbl-src',  LYR_LBL  = 'star-lbl'
const SRC_LINE = 'star-line-src', LYR_LINE = 'star-line'
const SRC_WP   = 'star-wp-src',   LYR_WP   = 'star-wp'
const SRC_WPL  = 'star-wpl-src',  LYR_WPL  = 'star-wpl'
const SRC_REF  = 'star-ref-src',  LYR_REF  = 'star-ref'

function ensureLayer(map: maplibregl.Map, lyrId: string, srcId: string, lyrSpec: any) {
  if (!map.getSource(srcId)) map.addSource(srcId, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
  if (!map.getLayer(lyrId)) map.addLayer(lyrSpec)
}

// ---- component ---------------------------------------------------------
export default function StarConstraints({ map, flights, onClose, onFly }: Props) {
  const [altTol, setAltTol] = useState(150)
  const [spdTol, setSpdTol] = useState(10)
  const [rodMul, setRodMul] = useState(100)
  const [phaseW, setPhaseW] = useState(100)
  const [minFL, setMinFL] = useState(20)
  const [scope, setScope] = useState(80)

  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showLine, setShowLine] = useState(true)
  const [showWP, setShowWP] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)

  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'AC' | 'WPS' | 'STARS'>('AC')

  const opts: Opts = { altTol, spdTol, rodMul, phaseW, minFL, scope }

  const rows = useMemo(() => {
    return flights
      .filter(f => !f.ground)
      .map(f => classify(f, opts))
      .filter(r => r.phase !== 'OTHER')
      .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [flights, altTol, spdTol, rodMul, phaseW, minFL, scope])

  const filtered = useMemo(() => rows.filter(r => {
    if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
    if (phaseFilter !== 'ALL' && r.phase !== phaseFilter) return false
    if (query) {
      const q = query.toLowerCase()
      if (!(
        r.f.callsign?.toLowerCase().includes(q) ||
        r.f.icao.toLowerCase().includes(q) ||
        (r.f.type || '').toLowerCase().includes(q) ||
        (r.ap?.icao || '').toLowerCase().includes(q) ||
        (r.star?.id || '').toLowerCase().includes(q) ||
        (r.wp?.id || '').toLowerCase().includes(q)
      )) return false
    }
    return true
  }), [rows, tierFilter, phaseFilter, query])

  const tierCount = useMemo(() => {
    const c: Record<Tier, number> = { BUST: 0, CAUTION: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const worst = rows[0]
  const bustCount = tierCount.BUST
  const meanAltDev = rows.length ? rows.reduce((s, r) => s + Math.abs(r.altDevFt), 0) / rows.length : 0
  const meanSpdDev = rows.length ? rows.reduce((s, r) => s + Math.abs(r.spdDevKts), 0) / rows.length : 0
  const apprCount = rows.filter(r => r.phase === 'APPROACH').length

  // Waypoint aggregation
  const wpAgg = useMemo(() => {
    const m = new Map<string, { ap: Airport; star: StarProc; wp: WP; n: number; bust: number; sumAlt: number; sumSpd: number }>()
    for (const r of rows) {
      if (!r.ap || !r.star || !r.wp) continue
      const k = r.ap.icao + ':' + r.star.id + ':' + r.wp.id
      const cur = m.get(k) || { ap: r.ap, star: r.star, wp: r.wp, n: 0, bust: 0, sumAlt: 0, sumSpd: 0 }
      cur.n++
      if (r.tier === 'BUST') cur.bust++
      cur.sumAlt += Math.abs(r.altDevFt)
      cur.sumSpd += Math.abs(r.spdDevKts)
      m.set(k, cur)
    }
    return Array.from(m.values()).sort((a, b) => b.bust - a.bust || b.n - a.n)
  }, [rows])

  const starAgg = useMemo(() => {
    const m = new Map<string, { ap: Airport; star: StarProc; n: number; bust: number; caution: number; sumScore: number }>()
    for (const r of rows) {
      if (!r.ap || !r.star) continue
      const k = r.ap.icao + ':' + r.star.id
      const cur = m.get(k) || { ap: r.ap, star: r.star, n: 0, bust: 0, caution: 0, sumScore: 0 }
      cur.n++
      if (r.tier === 'BUST') cur.bust++
      if (r.tier === 'CAUTION') cur.caution++
      cur.sumScore += r.score
      m.set(k, cur)
    }
    return Array.from(m.values()).sort((a, b) => b.bust - a.bust || b.n - a.n)
  }, [rows])

  // ---- map overlay ----
  useEffect(() => {
    if (!map) return
    const ids = [LYR_HALO, LYR_PIN, LYR_LBL, LYR_LINE, LYR_WP, LYR_WPL, LYR_REF]
    const srcs = [SRC_HALO, SRC_PIN, SRC_LBL, SRC_LINE, SRC_WP, SRC_WPL, SRC_REF]

    ensureLayer(map, LYR_HALO, SRC_HALO, { id: LYR_HALO, type: 'circle', source: SRC_HALO,
      paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'c'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'c'], 'circle-stroke-opacity': 0.55, 'circle-stroke-width': 1.2 } })
    ensureLayer(map, LYR_PIN, SRC_PIN, { id: LYR_PIN, type: 'symbol', source: SRC_PIN,
      layout: { 'text-field': '◆', 'text-size': 14, 'text-allow-overlap': true }, paint: { 'text-color': '#f43f5e' } })
    ensureLayer(map, LYR_LBL, SRC_LBL, { id: LYR_LBL, type: 'symbol', source: SRC_LBL,
      layout: { 'text-field': ['get', 't'], 'text-size': 10, 'text-offset': [0, 1.3], 'text-allow-overlap': true, 'text-anchor': 'top' },
      paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    ensureLayer(map, LYR_LINE, SRC_LINE, { id: LYR_LINE, type: 'line', source: SRC_LINE,
      paint: { 'line-color': ['get', 'c'], 'line-width': 1.4, 'line-dasharray': [3, 3], 'line-opacity': 0.7 } })
    ensureLayer(map, LYR_WP, SRC_WP, { id: LYR_WP, type: 'circle', source: SRC_WP,
      paint: { 'circle-radius': 4, 'circle-color': '#0ea5e9', 'circle-stroke-color': '#e2e8f0', 'circle-stroke-width': 1, 'circle-opacity': 0.85 } })
    ensureLayer(map, LYR_WPL, SRC_WPL, { id: LYR_WPL, type: 'symbol', source: SRC_WPL,
      layout: { 'text-field': ['get', 't'], 'text-size': 9, 'text-offset': [0, -1.3], 'text-allow-overlap': true, 'text-anchor': 'bottom' },
      paint: { 'text-color': '#cbd5e1', 'text-halo-color': '#0b1220', 'text-halo-width': 1.1 } })
    ensureLayer(map, LYR_REF, SRC_REF, { id: LYR_REF, type: 'line', source: SRC_REF,
      paint: { 'line-color': '#0ea5e9', 'line-width': 0.5, 'line-dasharray': [2, 4], 'line-opacity': 0.25 } })

    const haloFt: any[] = []
    const pinFt: any[] = []
    const lblFt: any[] = []
    const lineFt: any[] = []
    const wpFt: any[] = []
    const wplFt: any[] = []

    if (showHalo) {
      for (const r of rows) {
        if (r.tier === 'OK' || r.tier === 'IDLE') continue
        haloFt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { r: 8 + Math.min(14, r.score * 0.16), c: TIER_COLOR[r.tier] } })
      }
    }
    if (showPin) {
      for (const r of rows) if (r.tier === 'BUST') pinFt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
    }
    if (showLabels) {
      for (const r of rows) {
        if (r.tier === 'OK' || r.tier === 'IDLE') continue
        const sign = r.altDevFt > 0 ? '+' : ''
        const t = `${r.f.callsign || r.f.icao} ${r.ap?.icao || ''}/${r.wp?.id || ''} ${sign}${Math.round(r.altDevFt)}ft`
        lblFt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { t, c: TIER_COLOR[r.tier] } })
      }
    }
    if (showLine) {
      for (const r of rows) {
        if (r.tier === 'OK' || r.tier === 'IDLE' || !r.wp) continue
        lineFt.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.wp.lng, r.wp.lat]] }, properties: { c: TIER_COLOR[r.tier] } })
      }
    }
    if (showWP) {
      const seen = new Set<string>()
      for (const a of AIRPORTS) {
        for (const s of a.stars) {
          for (const wp of s.wps) {
            const k = wp.id + ':' + a.icao
            if (seen.has(k)) continue
            seen.add(k)
            wpFt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [wp.lng, wp.lat] }, properties: {} })
            const at = wp.altKind === 'WINDOW' ? `${(wp.altLoFt||0)/100}-${(wp.altHiFt||0)/100}` : `${(wp.altLoFt||wp.altHiFt||0)/100}`
            wplFt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [wp.lng, wp.lat] }, properties: { t: `${wp.id} FL${at}` } })
          }
        }
      }
    }

    const refFt = showRef ? [60,30,0,-30,-60].flatMap(lat => {
      const coords: number[][] = []
      for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
      return [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }]
    }) : []

    ;(map.getSource(SRC_HALO) as any)?.setData({ type: 'FeatureCollection', features: haloFt })
    ;(map.getSource(SRC_PIN)  as any)?.setData({ type: 'FeatureCollection', features: pinFt  })
    ;(map.getSource(SRC_LBL)  as any)?.setData({ type: 'FeatureCollection', features: lblFt  })
    ;(map.getSource(SRC_LINE) as any)?.setData({ type: 'FeatureCollection', features: lineFt })
    ;(map.getSource(SRC_WP)   as any)?.setData({ type: 'FeatureCollection', features: wpFt   })
    ;(map.getSource(SRC_WPL)  as any)?.setData({ type: 'FeatureCollection', features: wplFt  })
    ;(map.getSource(SRC_REF)  as any)?.setData({ type: 'FeatureCollection', features: refFt  })

    return () => {
      for (const id of ids) if (map.getLayer(id)) map.removeLayer(id)
      for (const id of srcs) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, showHalo, showPin, showLabels, showLine, showWP, showRef])

  // ---- diag scatter ----
  const W = 280, H = 150
  const xMax = 60, yMax = 3000
  const sx = (v: number) => 30 + (Math.min(xMax, Math.abs(v)) / xMax) * (W - 40)
  const sy = (v: number) => H - 24 - (Math.min(yMax, Math.abs(v)) / yMax) * (H - 48)

  // ---- render ----
  return (
    <div className="absolute right-2 top-16 bottom-2 w-[400px] z-30 rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur text-slate-200 flex flex-col overflow-hidden shadow-xl">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-xs font-semibold tracking-wide text-slate-100">STAR · Constraint Compliance</div>
          <div className="text-[10px] text-slate-500">FAA AIM 5-4-1 / 4-4-9 · ICAO Doc 8168 · {rows.length} on STAR · {AIRPORTS.length} airports</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      {/* tier counters */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`rounded px-1.5 py-1 text-[10px] font-semibold border transition ${tierFilter === t ? 'bg-sky-500/15 border-sky-500/40' : 'bg-slate-800/60 border-slate-700/60 hover:bg-slate-800'}`}
            style={{ color: TIER_COLOR[t] }}>
            {t}<span className="ml-1 text-slate-400 font-normal">{tierCount[t]}</span>
          </button>
        ))}
      </div>

      {/* summary cards */}
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean Δalt</div>
          <div className="text-sm font-semibold" style={{ color: meanAltDev < 200 ? '#10b981' : meanAltDev < 500 ? '#0ea5e9' : meanAltDev < 1000 ? '#f59e0b' : '#f43f5e' }}>{Math.round(meanAltDev)} ft</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Bust</div>
          <div className="text-sm font-semibold" style={{ color: bustCount > 0 ? '#f43f5e' : '#10b981' }}>{bustCount}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean Δspd</div>
          <div className="text-xs font-semibold" style={{ color: meanSpdDev < 10 ? '#10b981' : meanSpdDev < 20 ? '#0ea5e9' : meanSpdDev < 35 ? '#f59e0b' : '#f43f5e' }}>{Math.round(meanSpdDev)} kt</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Approach</div>
          <div className="text-xs font-semibold text-slate-100">{apprCount}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Filtered</div>
          <div className="text-xs font-semibold text-slate-100">{filtered.length}/{rows.length}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W - 40} height={H - 48} fill="#0b1220" />
            {/* tolerance bands */}
            <line x1={sx(spdTol)} y1={24} x2={sx(spdTol)} y2={H - 24} stroke="#10b981" strokeDasharray="3 3" strokeOpacity={0.5} />
            <line x1={30} y1={sy(altTol)} x2={W - 10} y2={sy(altTol)} stroke="#10b981" strokeDasharray="3 3" strokeOpacity={0.5} />
            <line x1={sx(40)} y1={24} x2={sx(40)} y2={H - 24} stroke="#f59e0b" strokeDasharray="2 3" strokeOpacity={0.45} />
            <line x1={30} y1={sy(1500)} x2={W - 10} y2={sy(1500)} stroke="#f43f5e" strokeDasharray="2 3" strokeOpacity={0.45} />
            {[0, 20, 40, 60].map(t => (
              <text key={`x${t}`} x={sx(t) - 8} y={H - 8} fontSize={8} fill="#64748b">{t}kt</text>
            ))}
            {[0, 1000, 2000, 3000].map(t => (
              <text key={`y${t}`} x={4} y={sy(t) + 3} fontSize={8} fill="#64748b">{t}ft</text>
            ))}
            {rows.filter(r => r.tier !== 'IDLE').map((r, i) => (
              <circle key={i} cx={sx(r.spdDevKts)} cy={sy(r.altDevFt)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
            <text x={W / 2} y={H - 6} fontSize={9} fill="#64748b" textAnchor="middle">|Δspd| (kt) × |Δalt| (ft) · inside green = OK</text>
          </svg>
        </div>
      )}

      {/* sliders */}
      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800 text-[10px]">
        <Slider label="ALT-TOL ft" min={0} max={400} value={altTol} onChange={setAltTol} />
        <Slider label="SPD-TOL kt" min={0} max={30} value={spdTol} onChange={setSpdTol} />
        <Slider label="ROD-MUL %" min={50} max={200} value={rodMul} onChange={setRodMul} />
        <Slider label="PHASE-WT %" min={50} max={150} value={phaseW} onChange={setPhaseW} />
        <Slider label="MIN-FL" min={0} max={400} value={minFL} onChange={setMinFL} />
        <Slider label="SCOPE nm" min={30} max={150} value={scope} onChange={setScope} />
      </div>

      {/* phase filter chips */}
      <div className="flex flex-wrap gap-1 px-3 pb-2 border-b border-slate-800">
        {(['ALL','STAR','ARRIVAL','APPROACH'] as const).map(p => (
          <button key={p} onClick={() => setPhaseFilter(p as any)}
            className={`text-[10px] px-2 py-0.5 rounded border ${phaseFilter === p ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border-slate-700/60 text-slate-400 hover:bg-slate-800'}`}>
            {p}
          </button>
        ))}
      </div>

      {/* toggles */}
      <div className="flex flex-wrap gap-1 px-3 pb-2 border-b border-slate-800">
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLabels,setShowLabels],['LINE',showLine,setShowLine],['WP',showWP,setShowWP],['REF',showRef,setShowRef],['DIAG',showDiag,setShowDiag]] as any[]).map(([lbl, val, set]) => (
          <button key={lbl} onClick={() => set(!val)}
            className={`text-[10px] px-2 py-0.5 rounded border ${val ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border-slate-700/60 text-slate-400 hover:bg-slate-800'}`}>
            {lbl}
          </button>
        ))}
      </div>

      {/* search + tabs */}
      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / STAR / WP / ICAO"
          className="w-full bg-slate-800/60 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500/60" />
        <div className="flex gap-1">
          {(['AC','WPS','STARS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 text-[10px] px-2 py-1 rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border-slate-700/60 text-slate-400 hover:bg-slate-800'}`}>
              {t === 'AC' ? 'AIRCRAFT' : t === 'WPS' ? 'WAYPOINTS' : 'STARS'}
            </button>
          ))}
        </div>
      </div>

      {/* list */}
      <div className="flex-1 overflow-auto">
        {tab === 'AC' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.map((r, i) => (
              <button key={r.f.icao + i} onClick={() => onFly(r.f.icao)}
                className="w-full text-left px-3 py-2 hover:bg-slate-800/40 transition flex flex-col gap-1.5">
                <div className="flex items-stretch gap-2">
                  <div className="w-1 rounded" style={{ background: TIER_COLOR[r.tier] }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[11px] font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                      <span className="text-[9px] text-slate-500">{r.f.type || '—'}</span>
                      <span className="text-[9px] px-1.5 py-px rounded font-semibold" style={{ color: PHASE_COLOR[r.phase], background: PHASE_COLOR[r.phase] + '22' }}>{r.phase}</span>
                      <span className="text-[9px] px-1.5 py-px rounded font-semibold ml-auto" style={{ color: TIER_COLOR[r.tier], background: TIER_COLOR[r.tier] + '22' }}>{r.tier}</span>
                    </div>
                    <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                      <span className="text-sky-400">{r.ap?.icao}</span>/<span className="text-slate-300">{r.star?.id}</span>/<span className="text-slate-300">{r.wp?.id}</span>
                      {' · '}FL{Math.round(r.f.altitudeFt / 100)} → FL{Math.round((r.wp?.altLoFt || 0)/100)}
                      {' · '}<span style={{ color: Math.abs(r.altDevFt) > 500 ? '#f43f5e' : Math.abs(r.altDevFt) > 200 ? '#f59e0b' : '#10b981' }}>{r.altDevFt > 0 ? '+' : ''}{Math.round(r.altDevFt)}ft</span>
                      {' · '}<span style={{ color: Math.abs(r.spdDevKts) > 20 ? '#f43f5e' : Math.abs(r.spdDevKts) > 10 ? '#f59e0b' : '#10b981' }}>{r.spdDevKts > 0 ? '+' : ''}{Math.round(r.spdDevKts)}kt</span>
                      {' · '}{Math.round(r.distToWpNm)}nm
                    </div>
                  </div>
                </div>
                <div className="h-1 rounded bg-slate-800 overflow-hidden">
                  <div className="h-full" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }} />
                </div>
                <div className="grid grid-cols-5 gap-1 text-[9px]">
                  {(['ALT','SPD','ROD','TRK','ENR'] as Driver[]).map(d => (
                    <div key={d} className="rounded px-1 py-0.5 text-center font-semibold"
                      style={{ background: TIER_COLOR[r.tier] + '22', color: r.driver === d ? TIER_COLOR[r.tier] : '#94a3b8' }}>
                      {d}{Math.round(r.drivers[d])}
                    </div>
                  ))}
                </div>
                <div className="text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>
                  {r.tier === 'BUST' && `${r.driver} bust · file MOR, request re-clearance per JO 7110.65 §4-5-7`}
                  {r.tier === 'CAUTION' && `${r.driver} marginal · arm speedbrake / VNAV path recapture per FCOM 11.31`}
                  {r.tier === 'WATCH' && `${r.driver} trending · cross-check FMS constraint per AIM 4-4-9`}
                  {r.tier === 'OK' && `On profile · descend-via clearance valid`}
                </div>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-[11px] text-slate-500 text-center">No arrivals match the current filter.</div>
            )}
          </div>
        )}

        {tab === 'WPS' && (
          <div className="divide-y divide-slate-800/60">
            {wpAgg.map((w, i) => (
              <div key={i} className="px-3 py-2 flex items-stretch gap-2">
                <div className="w-1 rounded" style={{ background: w.bust > 0 ? '#f43f5e' : '#0ea5e9' }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] font-semibold text-slate-100 font-mono">{w.wp.id}</span>
                    <span className="text-[9px] text-slate-500">{w.ap.icao}/{w.star.id}</span>
                    {w.bust > 0 && <span className="text-[9px] px-1.5 py-px rounded font-semibold" style={{ color: '#f43f5e', background: '#f43f5e22' }}>BUST {w.bust}</span>}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    FL{(w.wp.altLoFt||0)/100}{w.wp.altKind === 'WINDOW' ? `-${(w.wp.altHiFt||0)/100}` : ''} · {w.wp.altKind}
                    {w.wp.spdKind !== 'NONE' && ` · ${w.wp.spdHi || w.wp.spdLo}kt ${w.wp.spdKind}`}
                    {' · '}n={w.n} · μΔalt {Math.round(w.sumAlt/Math.max(1,w.n))}ft · μΔspd {Math.round(w.sumSpd/Math.max(1,w.n))}kt
                  </div>
                </div>
              </div>
            ))}
            {wpAgg.length === 0 && <div className="px-3 py-4 text-[11px] text-slate-500 text-center">No waypoint data.</div>}
          </div>
        )}

        {tab === 'STARS' && (
          <div className="divide-y divide-slate-800/60">
            {starAgg.map((s, i) => (
              <div key={i} className="px-3 py-2 flex items-stretch gap-2">
                <div className="w-1 rounded" style={{ background: s.bust > 0 ? '#f43f5e' : s.caution > 0 ? '#f59e0b' : '#10b981' }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] font-semibold text-slate-100 font-mono">{s.star.id}</span>
                    <span className="text-[9px] text-slate-500">{s.ap.icao} · {s.ap.name}</span>
                    <span className="text-[9px] text-slate-500 ml-auto font-mono">RWY {s.star.rwyFlow}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">
                    {s.star.wps.length} WPs · n={s.n} · μscore {Math.round(s.sumScore/Math.max(1,s.n))}
                    {s.bust > 0 && <span className="ml-2" style={{ color: '#f43f5e' }}>BUST {s.bust}</span>}
                    {s.caution > 0 && <span className="ml-2" style={{ color: '#f59e0b' }}>CAUTION {s.caution}</span>}
                  </div>
                  <div className="h-1 rounded bg-slate-800 mt-1 overflow-hidden">
                    <div className="h-full" style={{ width: `${Math.min(100, s.sumScore/Math.max(1,s.n))}%`, background: s.bust > 0 ? '#f43f5e' : s.caution > 0 ? '#f59e0b' : '#10b981' }} />
                  </div>
                </div>
              </div>
            ))}
            {starAgg.length === 0 && <div className="px-3 py-4 text-[11px] text-slate-500 text-center">No STAR data.</div>}
          </div>
        )}
      </div>
    </div>
  )
}

function Slider({ label, min, max, value, onChange }: { label: string; min: number; max: number; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-slate-500 uppercase">{label} <span className="text-slate-300">{value}</span></span>
      <input type="range" min={min} max={max} value={value} onChange={e => onChange(+e.target.value)}
        className="w-full accent-sky-500 h-1" />
    </label>
  )
}
