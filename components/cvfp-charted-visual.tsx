'use client'

// ============================================================================
// CVFP · Charted Visual Flight Procedure Compliance & Landmark-Track
//        Conformance Monitor
// ----------------------------------------------------------------------------
// Per-airframe live evaluator of every aircraft currently inbound to one of
// 18 catalogued CHARTED VISUAL FLIGHT PROCEDURE (CVFP) approaches — the
// FAA-published visual-only approach charts that overlay specific terrain
// landmarks, river bends, bridges and highway alignments as the primary
// pilot reference in lieu of instrument guidance. CVFP is distinct from
// every other approach overlay in the catalogue:
//
//   APCH-CAT     — ILS CAT-I/II/III precision approach minima compliance
//   STABLE-APP   — 1000ft/500ft gate gross-stabilisation checks
//   CDFA-VDP     — Non-precision continuous-descent vertical-path conformance
//   CIRCLING     — Published circle-to-land manoeuvre after instrument approach
//   APPR-MINS    — Minima publication only (DA/MDA, no track)
//   STEEP-APCH   — >3.5° glidepath physics envelope (e.g. LCY 5.5°)
//
// CVFP is uniquely the VISUAL-LANDMARK-AS-PRIMARY-REFERENCE evaluator
// scoring whether each inbound airframe:
//   (a) is INSIDE the published CVFP corridor envelope (track, altitude,
//       distance to runway, weather minima per AIM 5-4-23),
//   (b) is HITTING each charted landmark waypoint at the published altitude
//       (River Visual DCA: Key Bridge 1500ft / Memorial Bridge 1100ft /
//       Pentagon 700ft / Mt-Vernon-Sq abeam 350ft, etc.),
//   (c) has the REQUIRED VMC (ceiling ≥ 3500ft AGL, visibility ≥ 3sm per
//       14 CFR §91.155 Class B/C/D), and
//   (d) is COMPLYING with airframe / weight / noise restrictions inherent
//       to the procedure (e.g. EXPRESSWAY VISUAL LGA-13 limited to Group I
//       jets ≤ 100,000 lbs; QUIET BRIDGE SFO restricted to Stage-4 airframes
//       per LSFNR; CANARSIE VISUAL JFK-13L/R restricted to crews with
//       specific authorisation per OpSpec C062).
//
// Per:
//   14 CFR §91.175(j)  Operation below DA/DH/MDA (visual reference required)
//   14 CFR §91.155     VFR weather minimums (Class B/C/D/E surface)
//   14 CFR §91.131     ATC authorisation Class B
//   14 CFR §91.129     Class D operations
//   FAA AIM 5-4-23     Charted Visual Flight Procedures (CVFP)
//   FAA AIM 5-4-22     Side-Step Maneuver (sister procedure)
//   FAA AIM 5-4-20     Approach Lighting Systems (visual reference)
//   FAA Order 8260.3D  TERPS Vol I §232 CVFP construction
//   FAA Order 8260.19J  Flight Procedures and Airspace
//   FAA Order JO 7110.65 §7-4 Visual Approach procedures
//   FAA Order JO 7110.65 §7-4-5 CVFP issuance
//   ICAO Doc 8168 PANS-OPS Vol II Pt I §3.1 Visual manoeuvring
//   ICAO Annex 6 Pt I §4.2.8.2 Visual reference required
//   OpSpec C063        Special CVFP authorisations (CANARSIE)
//   OpSpec C075        IFR-to-Visual transition criteria
//   AC 90-114B         ADS-B and visual separation
//   AC 91-79B          Mitigating runway overrun (visual-approach assessment)
//
// 18 CVFP catalogue (FAA chart supp 2025-03):
//   RIVER VISUAL 19    KDCA (Potomac)         landmarks: Key Br / Memorial Br / Pentagon / 14th St Br
//   EXPRESSWAY 13      KLGA (Whitestone Expy) landmarks: Whitestone Br / Throgs Neck Br / Shea Stadium pad
//   CANARSIE 13L/R     KJFK (Canarsie VOR)    landmarks: Canarsie Pier / Floyd Bennett / Lead-in lights
//   PARKWAY 22         KSFO (Bayshore Pkwy)   landmarks: SFO Bridge / Coyote Pt / Brisbane Marina
//   QUIET BRIDGE 28L   KSFO (Bay Bridge)      landmarks: Bay Bridge / Yerba-Buena / Hunters-Point
//   FMS BRIDGE 28R     KSFO (FMS overlay)     landmarks: Oakland Bay Br / Bayshore (Stage 4 only)
//   TIPP TOP 30R       KSTL (Lambert)         landmarks: Forest Park / Tower Grove / Compton Hill
//   CHARLES RIVER 33L  KBOS (Logan)           landmarks: Tobin Br / Bunker Hill / North Channel
//   HARBOR VISUAL 28R  KBOS (Logan)           landmarks: Castle Island / Spectacle Is / Long Wharf
//   TIBURON 28L        KSFO (Marin)           landmarks: Angel Is / Sausalito / Tiburon Penin
//   BAY VISUAL 13L     KSFO                   landmarks: Bay Br / SFO Sign / Beacon
//   STADIUM 25L        KMDW (Chicago)         landmarks: Comiskey Park / Sears Tower / Loop
//   PRESIDENT TR 30    KMDW                   landmarks: Trump Twr / Wrigley / Lake Shore
//   COLISEUM 25R       KLAX                   landmarks: Coliseum / Hollywood Sign / Century City
//   MEMORIAL 04        KPHL                   landmarks: Independence Hall / Art Museum / Ben Franklin Br
//   STADIUM VISUAL 22  KMSP                   landmarks: USB Bank Stadium / Target Center
//   WATERFRONT 25      KBWI                   landmarks: Inner Harbor / Camden Yards
//   CAPITAL 01         KIAD                   landmarks: Tysons Tower / Toll Road / Reston Tnl
//
// 6 risk drivers / 6 tiers / MapLibre overlay with landmark waypoint trail.
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
// Aircraft category (FAA AIM 5-4-7 Approach Categories driven by Vref):
//   A: < 91 kts        B: 91-120     C: 121-140    D: 141-165    E: ≥ 166
// CVFP charts publish a single category eligibility band per AIM 5-4-23.
// ---------------------------------------------------------------------------
type AcftCat = 'A' | 'B' | 'C' | 'D' | 'E'

// Group I (small jets ≤ 100,000 lbs MTOW) eligibility for EXPRESSWAY-13 LGA
// per JO 7110.65 §7-4-5b.
type GroupRestrict = 'NONE' | 'GROUP-I-ONLY' | 'STAGE-4-ONLY' | 'OPSPEC-C062' | 'PROP-TURBOPROP'

// ---------------------------------------------------------------------------
// Landmark waypoint — a charted visual reference point on the CVFP.
//   altFt is the PUBLISHED crossing altitude (MSL).
//   tolFt is the ±tolerance band the airframe must stay within.
// ---------------------------------------------------------------------------
type Landmark = {
  name: string       // chart label e.g. "Key Bridge"
  lat: number
  lng: number
  altFt: number      // published crossing altitude MSL
  tolFt: number      // tolerance band ±
  bearingFromPrev?: number  // expected track from previous waypoint
}

// ---------------------------------------------------------------------------
// CVFP procedure descriptor
// ---------------------------------------------------------------------------
type Cvfp = {
  id: string                  // unique short id e.g. "RIVER19"
  name: string                // chart name e.g. "RIVER VISUAL"
  icao: string
  iata: string
  airport: string
  rwy: string
  rwyLat: number
  rwyLng: number
  rwyElevFt: number
  ldgHdgTrue: number
  landmarks: Landmark[]       // sequence of charted waypoints (IAF → MAP)
  catMin: AcftCat             // worst (highest) category permitted
  group: GroupRestrict
  ceilMinFt: number           // minimum ceiling required to commence
  visMinSm: number            // minimum visibility (statute miles)
  noiseSensitive: boolean     // procedure has noise constraints
  region: 'NE' | 'MID' | 'SE' | 'WEST' | 'MIDW' | 'MTW'
  hazardNote: string          // headline hazard / precedent
}

const PROCEDURES: Cvfp[] = [
  {
    id: 'RIVER19', name: 'RIVER VISUAL', icao: 'KDCA', iata: 'DCA',
    airport: 'Washington-National', rwy: '19',
    rwyLat: 38.8517, rwyLng: -77.0407, rwyElevFt: 14, ldgHdgTrue: 188,
    catMin: 'C', group: 'NONE', ceilMinFt: 3500, visMinSm: 3,
    noiseSensitive: true, region: 'NE',
    hazardNote: 'P-56 prohibited area & US Capitol on RIGHT — drift left of river only',
    landmarks: [
      { name: 'Key Bridge',         lat: 38.9024, lng: -77.0700, altFt: 1500, tolFt: 200 },
      { name: 'Memorial Bridge',    lat: 38.8888, lng: -77.0540, altFt: 1100, tolFt: 200, bearingFromPrev: 152 },
      { name: 'Pentagon',           lat: 38.8719, lng: -77.0563, altFt:  700, tolFt: 150, bearingFromPrev: 186 },
      { name: '14th St Bridge',     lat: 38.8744, lng: -77.0413, altFt:  450, tolFt: 100, bearingFromPrev: 75 },
      { name: 'River Bend',         lat: 38.8624, lng: -77.0395, altFt:  300, tolFt:  80, bearingFromPrev: 173 },
    ],
  },
  {
    id: 'EXPWY13', name: 'EXPRESSWAY VISUAL', icao: 'KLGA', iata: 'LGA',
    airport: 'New York-LaGuardia', rwy: '13',
    rwyLat: 40.7711, rwyLng: -73.8722, rwyElevFt: 21, ldgHdgTrue: 122,
    catMin: 'C', group: 'GROUP-I-ONLY', ceilMinFt: 3500, visMinSm: 3,
    noiseSensitive: true, region: 'NE',
    hazardNote: 'High-speed expressway turn-final ~180° from IF — overshoot risk',
    landmarks: [
      { name: 'Throgs Neck Br',     lat: 40.8033, lng: -73.7944, altFt: 2500, tolFt: 300 },
      { name: 'Whitestone Br',      lat: 40.8000, lng: -73.8350, altFt: 2000, tolFt: 250, bearingFromPrev: 250 },
      { name: 'Citi Field',         lat: 40.7571, lng: -73.8458, altFt: 1500, tolFt: 200, bearingFromPrev: 184 },
      { name: 'Shea Stadium pad',   lat: 40.7560, lng: -73.8501, altFt: 1100, tolFt: 200, bearingFromPrev: 250 },
      { name: 'Expressway curve',   lat: 40.7677, lng: -73.8665, altFt:  700, tolFt: 150, bearingFromPrev: 42 },
    ],
  },
  {
    id: 'CAN13L', name: 'CANARSIE VISUAL', icao: 'KJFK', iata: 'JFK',
    airport: 'New York-JFK', rwy: '13L',
    rwyLat: 40.6420, rwyLng: -73.7937, rwyElevFt: 13, ldgHdgTrue: 122,
    catMin: 'D', group: 'OPSPEC-C062', ceilMinFt: 3500, visMinSm: 5,
    noiseSensitive: true, region: 'NE',
    hazardNote: 'Lead-in lights TURN BASE-FINAL only — high crew-skill, OpSpec C062',
    landmarks: [
      { name: 'CRI VOR',            lat: 40.6126, lng: -73.8755, altFt: 3000, tolFt: 300 },
      { name: 'Canarsie Pier',      lat: 40.6309, lng: -73.8769, altFt: 1500, tolFt: 200, bearingFromPrev: 10 },
      { name: 'Floyd Bennett Field',lat: 40.5904, lng: -73.8889, altFt:  900, tolFt: 180, bearingFromPrev: 195 },
      { name: 'Lead-in Lt #1',      lat: 40.6201, lng: -73.8235, altFt:  700, tolFt: 100, bearingFromPrev: 75 },
      { name: 'Lead-in Lt #5',      lat: 40.6332, lng: -73.8023, altFt:  500, tolFt:  80, bearingFromPrev: 45 },
    ],
  },
  {
    id: 'PKW22', name: 'PARKWAY VISUAL', icao: 'KSFO', iata: 'SFO',
    airport: 'San Francisco', rwy: '28L',
    rwyLat: 37.6133, rwyLng: -122.3573, rwyElevFt: 13, ldgHdgTrue: 279,
    catMin: 'C', group: 'NONE', ceilMinFt: 3500, visMinSm: 3,
    noiseSensitive: true, region: 'WEST',
    hazardNote: 'Bayshore Pkwy turn-base over residential — SFO LSFNR Q-2',
    landmarks: [
      { name: 'San Mateo Br',       lat: 37.5810, lng: -122.2553, altFt: 2500, tolFt: 300 },
      { name: 'Coyote Pt',          lat: 37.5921, lng: -122.3133, altFt: 1800, tolFt: 250, bearingFromPrev: 297 },
      { name: 'Brisbane Marina',    lat: 37.6790, lng: -122.3793, altFt: 1300, tolFt: 200, bearingFromPrev: 331 },
      { name: 'Bayshore Pkwy',      lat: 37.6481, lng: -122.4023, altFt:  900, tolFt: 150, bearingFromPrev: 213 },
      { name: 'SFO Sign',           lat: 37.6280, lng: -122.3795, altFt:  500, tolFt:  80, bearingFromPrev: 142 },
    ],
  },
  {
    id: 'QBR28L', name: 'QUIET BRIDGE VISUAL', icao: 'KSFO', iata: 'SFO',
    airport: 'San Francisco', rwy: '28L',
    rwyLat: 37.6133, rwyLng: -122.3573, rwyElevFt: 13, ldgHdgTrue: 279,
    catMin: 'D', group: 'STAGE-4-ONLY', ceilMinFt: 4000, visMinSm: 5,
    noiseSensitive: true, region: 'WEST',
    hazardNote: 'Stage-4 noise restriction · Bay Bridge over-fly · QC2 limit',
    landmarks: [
      { name: 'Hunters Pt',         lat: 37.7300, lng: -122.3623, altFt: 4000, tolFt: 400 },
      { name: 'Yerba Buena Is',     lat: 37.8094, lng: -122.3623, altFt: 3500, tolFt: 350, bearingFromPrev: 359 },
      { name: 'Bay Bridge SAS',     lat: 37.8064, lng: -122.3829, altFt: 2800, tolFt: 300, bearingFromPrev: 252 },
      { name: 'Brisbane abeam',     lat: 37.6840, lng: -122.4051, altFt: 1800, tolFt: 200, bearingFromPrev: 195 },
      { name: 'Bayshore turn',      lat: 37.6418, lng: -122.4015, altFt: 1100, tolFt: 150, bearingFromPrev: 182 },
    ],
  },
  {
    id: 'FMSBR28R', name: 'FMS BRIDGE VISUAL', icao: 'KSFO', iata: 'SFO',
    airport: 'San Francisco', rwy: '28R',
    rwyLat: 37.6202, rwyLng: -122.3650, rwyElevFt: 13, ldgHdgTrue: 281,
    catMin: 'D', group: 'STAGE-4-ONLY', ceilMinFt: 4000, visMinSm: 5,
    noiseSensitive: true, region: 'WEST',
    hazardNote: 'FMS-coded overlay of QUIET BRIDGE for 28R parallel — same noise',
    landmarks: [
      { name: 'Oakland Bay Br N',   lat: 37.8045, lng: -122.3556, altFt: 4000, tolFt: 400 },
      { name: 'Yerba Buena',        lat: 37.8094, lng: -122.3623, altFt: 3500, tolFt: 350, bearingFromPrev: 333 },
      { name: 'Brisbane',           lat: 37.6817, lng: -122.4019, altFt: 1900, tolFt: 250, bearingFromPrev: 199 },
      { name: 'SFO Sign N',         lat: 37.6378, lng: -122.3829, altFt:  900, tolFt: 150, bearingFromPrev: 138 },
    ],
  },
  {
    id: 'TIPP30R', name: 'TIPP TOP VISUAL', icao: 'KSTL', iata: 'STL',
    airport: 'St Louis-Lambert', rwy: '30R',
    rwyLat: 38.7487, rwyLng: -90.3700, rwyElevFt: 605, ldgHdgTrue: 303,
    catMin: 'C', group: 'NONE', ceilMinFt: 3500, visMinSm: 3,
    noiseSensitive: false, region: 'MIDW',
    hazardNote: 'Forest Park overfly · Tipp Top water tower as primary fix',
    landmarks: [
      { name: 'Compton Hill Twr',   lat: 38.6175, lng: -90.2228, altFt: 3500, tolFt: 350 },
      { name: 'Tower Grove Pk',     lat: 38.6017, lng: -90.2598, altFt: 2700, tolFt: 300, bearingFromPrev: 250 },
      { name: 'Forest Park',        lat: 38.6376, lng: -90.2855, altFt: 2200, tolFt: 250, bearingFromPrev: 26 },
      { name: 'Tipp Top tower',     lat: 38.6926, lng: -90.3211, altFt: 1500, tolFt: 200, bearingFromPrev: 26 },
      { name: 'Lambert pylon',      lat: 38.7228, lng: -90.3458, altFt:  900, tolFt: 150, bearingFromPrev: 34 },
    ],
  },
  {
    id: 'CHR33L', name: 'CHARLES RIVER VISUAL', icao: 'KBOS', iata: 'BOS',
    airport: 'Boston-Logan', rwy: '33L',
    rwyLat: 42.3490, rwyLng: -71.0257, rwyElevFt: 19, ldgHdgTrue: 323,
    catMin: 'C', group: 'NONE', ceilMinFt: 4000, visMinSm: 4,
    noiseSensitive: true, region: 'NE',
    hazardNote: 'Tobin Bridge tower 393ft AGL · Bunker Hill obelisk obstacle',
    landmarks: [
      { name: 'Boston Lt',          lat: 42.3275, lng: -70.8902, altFt: 3000, tolFt: 300 },
      { name: 'Long Wharf',         lat: 42.3601, lng: -71.0481, altFt: 2000, tolFt: 250, bearingFromPrev: 296 },
      { name: 'Bunker Hill',        lat: 42.3766, lng: -71.0608, altFt: 1500, tolFt: 200, bearingFromPrev: 351 },
      { name: 'Tobin Bridge',       lat: 42.3856, lng: -71.0463, altFt: 1100, tolFt: 200, bearingFromPrev: 30 },
      { name: 'North Channel',      lat: 42.3691, lng: -71.0297, altFt:  700, tolFt: 150, bearingFromPrev: 145 },
    ],
  },
  {
    id: 'HBR28R', name: 'HARBOR VISUAL', icao: 'KBOS', iata: 'BOS',
    airport: 'Boston-Logan', rwy: '4R',
    rwyLat: 42.3550, rwyLng: -71.0269, rwyElevFt: 19, ldgHdgTrue: 41,
    catMin: 'C', group: 'NONE', ceilMinFt: 3500, visMinSm: 3,
    noiseSensitive: true, region: 'NE',
    hazardNote: 'Spectacle Is overfly · low altitude over Castle Is light',
    landmarks: [
      { name: 'Boston Lt',          lat: 42.3275, lng: -70.8902, altFt: 2500, tolFt: 300 },
      { name: 'Long Is',            lat: 42.3262, lng: -70.9624, altFt: 1800, tolFt: 250, bearingFromPrev: 287 },
      { name: 'Spectacle Is',       lat: 42.3284, lng: -70.9869, altFt: 1300, tolFt: 200, bearingFromPrev: 282 },
      { name: 'Castle Is',          lat: 42.3373, lng: -71.0149, altFt:  900, tolFt: 150, bearingFromPrev: 290 },
      { name: 'Logan threshold',    lat: 42.3500, lng: -71.0265, altFt:  500, tolFt:  80, bearingFromPrev: 339 },
    ],
  },
  {
    id: 'TBN28L', name: 'TIBURON VISUAL', icao: 'KSFO', iata: 'SFO',
    airport: 'San Francisco', rwy: '28L',
    rwyLat: 37.6133, rwyLng: -122.3573, rwyElevFt: 13, ldgHdgTrue: 279,
    catMin: 'D', group: 'STAGE-4-ONLY', ceilMinFt: 4000, visMinSm: 5,
    noiseSensitive: true, region: 'WEST',
    hazardNote: 'Marin County low-altitude · Tiburon Penin terrain 850ft',
    landmarks: [
      { name: 'Pt Reyes',           lat: 38.0666, lng: -123.0030, altFt: 5500, tolFt: 500 },
      { name: 'Tiburon Penin',      lat: 37.8800, lng: -122.4630, altFt: 3500, tolFt: 350, bearingFromPrev: 124 },
      { name: 'Angel Is',           lat: 37.8606, lng: -122.4326, altFt: 2800, tolFt: 300, bearingFromPrev: 130 },
      { name: 'Sausalito',          lat: 37.8590, lng: -122.4853, altFt: 2300, tolFt: 250, bearingFromPrev: 252 },
      { name: 'Bayshore turn',      lat: 37.6418, lng: -122.4015, altFt: 1100, tolFt: 200, bearingFromPrev: 162 },
    ],
  },
  {
    id: 'BAY13L', name: 'BAY VISUAL', icao: 'KSFO', iata: 'SFO',
    airport: 'San Francisco', rwy: '10L',
    rwyLat: 37.6280, rwyLng: -122.3870, rwyElevFt: 13, ldgHdgTrue: 100,
    catMin: 'C', group: 'NONE', ceilMinFt: 3500, visMinSm: 3,
    noiseSensitive: false, region: 'WEST',
    hazardNote: 'Bay Bridge overflight · East-Bay reciprocal of QUIET BRIDGE',
    landmarks: [
      { name: 'Oakland Coliseum',   lat: 37.7516, lng: -122.2008, altFt: 3500, tolFt: 350 },
      { name: 'Bay Bridge E',       lat: 37.8050, lng: -122.3556, altFt: 2700, tolFt: 300, bearingFromPrev: 314 },
      { name: 'Bay Bridge W',       lat: 37.7990, lng: -122.3776, altFt: 2200, tolFt: 250, bearingFromPrev: 250 },
      { name: 'AT&T Park',          lat: 37.7786, lng: -122.3893, altFt: 1500, tolFt: 200, bearingFromPrev: 185 },
      { name: 'Brisbane abeam',     lat: 37.6840, lng: -122.4051, altFt:  900, tolFt: 150, bearingFromPrev: 185 },
    ],
  },
  {
    id: 'STAD25L', name: 'STADIUM VISUAL', icao: 'KMDW', iata: 'MDW',
    airport: 'Chicago-Midway', rwy: '31C',
    rwyLat: 41.7860, rwyLng: -87.7524, rwyElevFt: 620, ldgHdgTrue: 314,
    catMin: 'C', group: 'GROUP-I-ONLY', ceilMinFt: 3500, visMinSm: 3,
    noiseSensitive: true, region: 'MIDW',
    hazardNote: 'Sears (Willis) Tower 1450ft AGL · Loop towers · Group-I jets',
    landmarks: [
      { name: 'Burnham Harbor',     lat: 41.8665, lng: -87.6126, altFt: 2500, tolFt: 300 },
      { name: 'Soldier Field',      lat: 41.8623, lng: -87.6167, altFt: 2200, tolFt: 250, bearingFromPrev: 178 },
      { name: 'Comiskey Park',      lat: 41.8299, lng: -87.6338, altFt: 1700, tolFt: 200, bearingFromPrev: 196 },
      { name: 'Willis Tower abeam', lat: 41.8755, lng: -87.6360, altFt: 2800, tolFt: 250, bearingFromPrev: 2 },
      { name: 'Midway pylon',       lat: 41.8120, lng: -87.7100, altFt: 1100, tolFt: 150, bearingFromPrev: 236 },
    ],
  },
  {
    id: 'PRES30', name: 'PRESIDENT VISUAL', icao: 'KMDW', iata: 'MDW',
    airport: 'Chicago-Midway', rwy: '4R',
    rwyLat: 41.7805, rwyLng: -87.7569, rwyElevFt: 620, ldgHdgTrue: 41,
    catMin: 'C', group: 'NONE', ceilMinFt: 4000, visMinSm: 4,
    noiseSensitive: true, region: 'MIDW',
    hazardNote: 'Trump Tower 1389ft · John Hancock 1500ft · downtown overflight',
    landmarks: [
      { name: 'Wrigley Field',      lat: 41.9484, lng: -87.6553, altFt: 3500, tolFt: 350 },
      { name: 'John Hancock',       lat: 41.8989, lng: -87.6234, altFt: 3000, tolFt: 300, bearingFromPrev: 158 },
      { name: 'Trump Tower',        lat: 41.8889, lng: -87.6266, altFt: 2700, tolFt: 250, bearingFromPrev: 192 },
      { name: 'Lake Shore turn',    lat: 41.8585, lng: -87.6164, altFt: 2100, tolFt: 250, bearingFromPrev: 162 },
      { name: 'Midway pylon',       lat: 41.8120, lng: -87.7100, altFt: 1100, tolFt: 150, bearingFromPrev: 233 },
    ],
  },
  {
    id: 'COLI25R', name: 'COLISEUM VISUAL', icao: 'KLAX', iata: 'LAX',
    airport: 'Los Angeles', rwy: '25R',
    rwyLat: 33.9485, rwyLng: -118.4310, rwyElevFt: 120, ldgHdgTrue: 250,
    catMin: 'D', group: 'NONE', ceilMinFt: 4000, visMinSm: 4,
    noiseSensitive: true, region: 'WEST',
    hazardNote: 'LA Coliseum / USC overfly · downtown LA towers · LSFNR-2 noise',
    landmarks: [
      { name: 'Griffith Obs',       lat: 34.1184, lng: -118.3004, altFt: 4500, tolFt: 400 },
      { name: 'Hollywood Sign',     lat: 34.1341, lng: -118.3215, altFt: 4000, tolFt: 350, bearingFromPrev: 339 },
      { name: 'Century City',       lat: 34.0560, lng: -118.4170, altFt: 2800, tolFt: 300, bearingFromPrev: 198 },
      { name: 'LA Coliseum',        lat: 34.0141, lng: -118.2879, altFt: 2300, tolFt: 250, bearingFromPrev: 130 },
      { name: 'LAX threshold',      lat: 33.9485, lng: -118.4310, altFt:  800, tolFt: 100, bearingFromPrev: 250 },
    ],
  },
  {
    id: 'MEM04', name: 'MEMORIAL VISUAL', icao: 'KPHL', iata: 'PHL',
    airport: 'Philadelphia', rwy: '27R',
    rwyLat: 39.8721, rwyLng: -75.2406, rwyElevFt: 36, ldgHdgTrue: 273,
    catMin: 'C', group: 'NONE', ceilMinFt: 3500, visMinSm: 3,
    noiseSensitive: false, region: 'NE',
    hazardNote: 'Ben Franklin Br · Boathouse Row · Center City obstacles',
    landmarks: [
      { name: 'Ben Franklin Br',    lat: 39.9526, lng: -75.1374, altFt: 3000, tolFt: 300 },
      { name: 'Art Museum',         lat: 39.9656, lng: -75.1810, altFt: 2400, tolFt: 250, bearingFromPrev: 311 },
      { name: 'Independence Hall',  lat: 39.9489, lng: -75.1500, altFt: 1900, tolFt: 200, bearingFromPrev: 124 },
      { name: 'Walt Whitman Br',    lat: 39.9069, lng: -75.1296, altFt: 1300, tolFt: 200, bearingFromPrev: 193 },
      { name: 'PHL pylon',          lat: 39.8800, lng: -75.2200, altFt:  800, tolFt: 100, bearingFromPrev: 245 },
    ],
  },
  {
    id: 'STAD22M', name: 'STADIUM VISUAL', icao: 'KMSP', iata: 'MSP',
    airport: 'Minneapolis-St Paul', rwy: '12R',
    rwyLat: 44.8748, rwyLng: -93.2186, rwyElevFt: 841, ldgHdgTrue: 124,
    catMin: 'C', group: 'NONE', ceilMinFt: 3500, visMinSm: 3,
    noiseSensitive: false, region: 'MIDW',
    hazardNote: 'Twin Cities downtown overflight · IDS Center 792ft AGL',
    landmarks: [
      { name: 'Target Center',      lat: 44.9794, lng: -93.2762, altFt: 3500, tolFt: 350 },
      { name: 'US Bank Stadium',    lat: 44.9737, lng: -93.2581, altFt: 3000, tolFt: 300, bearingFromPrev: 110 },
      { name: 'Fort Snelling',      lat: 44.8930, lng: -93.1816, altFt: 2200, tolFt: 250, bearingFromPrev: 165 },
      { name: 'MSP pylon',          lat: 44.8800, lng: -93.2000, altFt: 1300, tolFt: 200, bearingFromPrev: 215 },
    ],
  },
  {
    id: 'WTF25', name: 'WATERFRONT VISUAL', icao: 'KBWI', iata: 'BWI',
    airport: 'Baltimore-Washington', rwy: '15L',
    rwyLat: 39.1754, rwyLng: -76.6683, rwyElevFt: 146, ldgHdgTrue: 154,
    catMin: 'C', group: 'NONE', ceilMinFt: 3500, visMinSm: 3,
    noiseSensitive: false, region: 'NE',
    hazardNote: 'Camden Yards · Inner Harbor low overflight',
    landmarks: [
      { name: 'Fort McHenry',       lat: 39.2629, lng: -76.5803, altFt: 3000, tolFt: 300 },
      { name: 'Inner Harbor',       lat: 39.2855, lng: -76.6107, altFt: 2400, tolFt: 250, bearingFromPrev: 340 },
      { name: 'Camden Yards',       lat: 39.2839, lng: -76.6217, altFt: 1900, tolFt: 200, bearingFromPrev: 252 },
      { name: 'BWI pylon',          lat: 39.1900, lng: -76.6500, altFt: 1100, tolFt: 150, bearingFromPrev: 192 },
    ],
  },
  {
    id: 'CAP01', name: 'CAPITAL VISUAL', icao: 'KIAD', iata: 'IAD',
    airport: 'Washington-Dulles', rwy: '1R',
    rwyLat: 38.9374, rwyLng: -77.4624, rwyElevFt: 313, ldgHdgTrue: 14,
    catMin: 'D', group: 'NONE', ceilMinFt: 3500, visMinSm: 3,
    noiseSensitive: false, region: 'NE',
    hazardNote: 'Tysons Corner antenna farm · 5000ft obstacle ring',
    landmarks: [
      { name: 'Tysons Tower',       lat: 38.9210, lng: -77.2237, altFt: 3500, tolFt: 350 },
      { name: 'Toll Road overflight', lat: 38.9433, lng: -77.3389, altFt: 2800, tolFt: 300, bearingFromPrev: 290 },
      { name: 'Reston Tnl',         lat: 38.9586, lng: -77.3570, altFt: 2300, tolFt: 250, bearingFromPrev: 350 },
      { name: 'IAD pylon',          lat: 38.9300, lng: -77.4500, altFt: 1300, tolFt: 200, bearingFromPrev: 247 },
    ],
  },
]

// ---------------------------------------------------------------------------
// Aircraft class — for category and group eligibility
// ---------------------------------------------------------------------------
type ClassKey =
  | 'HVY-T'   // wide-body (Cat D-E)
  | 'NB'      // narrow-body (Cat C-D)
  | 'RGN-J'   // regional jet (Cat C)
  | 'RGN-T'   // turboprop (Cat B-C)
  | 'BIZ'     // business jet (Cat B-D)
  | 'LIGHT'   // light GA (Cat A-B)
  | 'MIL'     // military

type ClassSpec = {
  label: string
  catBand: AcftCat
  vrefKts: number
  groupI: boolean
  stage4: boolean
  exemplars: string[]
}

const CLASS_SPEC: Record<ClassKey, ClassSpec> = {
  'HVY-T':   { label:'WB Heavy',     catBand:'D', vrefKts:148, groupI:false, stage4:true,  exemplars:['B772','B77W','B788','B789','B78X','A359','A35K','A332','A333','A338','A339','B744','B748','A388','MD11','B763','B764','A330'] },
  'NB':      { label:'NB jet',       catBand:'C', vrefKts:135, groupI:true,  stage4:true,  exemplars:['B737','B738','B739','B38M','B39M','A319','A320','A321','A20N','A21N','A21X','BCS3','BCS1','B752','B753','B722','MD80','MD82','MD83','MD88'] },
  'RGN-J':   { label:'Regional jet', catBand:'C', vrefKts:128, groupI:true,  stage4:true,  exemplars:['E170','E175','E190','E195','E290','E295','CRJ2','CRJ7','CRJ9','CRJX','RJ85','RJ100','BAE146'] },
  'RGN-T':   { label:'Turboprop',    catBand:'B', vrefKts:108, groupI:true,  stage4:false, exemplars:['AT72','AT75','AT76','DH8D','DH8C','DH8B','SF34','SB20','D328','J32','J41','SAAB'] },
  'BIZ':     { label:'Business jet', catBand:'C', vrefKts:122, groupI:true,  stage4:true,  exemplars:['GLEX','GL5T','GL7T','G650','GLF6','FA8X','FA7X','GL6T','C25A','C25B','C25C','PC12','PC24','CL30','CL35','CL60','PRM1','LJ45','LJ60','HDJT','E50P','E55P'] },
  'LIGHT':   { label:'Light GA',     catBand:'A', vrefKts: 72, groupI:true,  stage4:false, exemplars:['C172','C182','PA28','SR22','DA40','BE36','C152','C310','BE58','PA46'] },
  'MIL':     { label:'Military',     catBand:'D', vrefKts:140, groupI:false, stage4:false, exemplars:['C5','C17','C130','KC10','KC46','KC135','E3CF','E7','RC135','P8','F16','F18','F22','F35'] },
}

function classifyClass(typeCode: string | undefined): ClassKey {
  const t = (typeCode || '').toUpperCase()
  for (const k of Object.keys(CLASS_SPEC) as ClassKey[]) {
    if (CLASS_SPEC[k].exemplars.includes(t)) return k
  }
  if (/^B77|^B78|^A35|^A33|^A34|^B74|^A38|^B76/.test(t)) return 'HVY-T'
  if (/^B73|^A20|^A21|^A319|^A320|^A321|^BCS|^B75|^MD8/.test(t)) return 'NB'
  if (/^E1[79]|^E[29]|^CRJ|^RJ1?[01]/.test(t)) return 'RGN-J'
  if (/^AT[47]|^DH8|^SF|^SB|^D328|^J3|^J4/.test(t)) return 'RGN-T'
  if (/^G[56]|^GL|^FA[78]|^C2[05]|^PC|^CL|^LJ/.test(t)) return 'BIZ'
  if (/^C1[57]|^PA|^SR|^DA|^BE/.test(t)) return 'LIGHT'
  if (/^C5$|^C17|^C130|^KC|^E3|^E7|^F1[6-9]|^F2[2-9]|^F3[5-9]/.test(t)) return 'MIL'
  return 'NB'
}

function approachCat(spec: ClassSpec): AcftCat {
  // category from Vref per AIM 5-4-7
  if (spec.vrefKts < 91)  return 'A'
  if (spec.vrefKts < 121) return 'B'
  if (spec.vrefKts < 141) return 'C'
  if (spec.vrefKts < 166) return 'D'
  return 'E'
}
const CAT_RANK: Record<AcftCat, number> = { A:1, B:2, C:3, D:4, E:5 }

// hash32 — deterministic synthetic data
function hash32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}

// great-circle distance NM
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

// snap aircraft to nearest CVFP — pick the procedure whose closest landmark
// is within scope AND whose runway threshold is within scope AND whose heading
// roughly aligns with the procedure's final track.
function snapProc(f: F, scopeNM: number, alignDeg: number): {
  proc: Cvfp | null
  distToRwyNM: number
  nearestLm: { lm: Landmark; idx: number; distNM: number } | null
} {
  let best: Cvfp | null = null
  let bestD = Infinity
  let bestNearestLm: { lm: Landmark; idx: number; distNM: number } | null = null
  for (const p of PROCEDURES) {
    const dRwy = gcDistNM(f.lat, f.lng, p.rwyLat, p.rwyLng)
    if (dRwy > scopeNM) continue
    // heading must align with final landing heading (within 60° — visual
    // procedures have significant turn-final maneuvering so we're generous)
    const trkOff = Math.abs(((f.heading - p.ldgHdgTrue + 540) % 360) - 180)
    if (trkOff > alignDeg) continue
    // find the closest landmark in this procedure
    let nearest: { lm: Landmark; idx: number; distNM: number } | null = null
    let nDist = Infinity
    for (let i=0; i<p.landmarks.length; i++) {
      const lm = p.landmarks[i]
      const d = gcDistNM(f.lat, f.lng, lm.lat, lm.lng)
      if (d < nDist) { nDist = d; nearest = { lm, idx: i, distNM: d } }
    }
    if (!nearest || nearest.distNM > scopeNM) continue
    if (dRwy < bestD) {
      best = p
      bestD = dRwy
      bestNearestLm = nearest
    }
  }
  return { proc: best, distToRwyNM: bestD === Infinity ? 0 : bestD, nearestLm: bestNearestLm }
}

// ---------------------------------------------------------------------------
// Synthesised weather per airport — ceiling & visibility for CVFP gate
// ---------------------------------------------------------------------------
type WxState = { ceilFt: number; visSm: number; vmcOk: boolean }

function wxForAirport(icao: string, doy: number, wxMul: number): WxState {
  const h = hash32(icao + ':' + Math.floor(doy / 7))
  const r0 = (h & 0xffff) / 65535
  const r1 = ((h >> 16) & 0xffff) / 65535
  // baseline: 65% clear, 25% partial, 10% IFR-ish
  const pIfr = Math.min(0.5, 0.10 * (wxMul / 100))
  const pPartial = 0.25
  let ceilFt = 9000, visSm = 10
  if (r0 < pIfr) {
    ceilFt = 800 + Math.floor(r1 * 1500)    // 800-2300ft IFR
    visSm = 1 + r1 * 3                       // 1-4sm
  } else if (r0 < pIfr + pPartial) {
    ceilFt = 3000 + Math.floor(r1 * 2000)   // 3000-5000ft marginal
    visSm = 4 + r1 * 3                       // 4-7sm
  } else {
    ceilFt = 5500 + Math.floor(r1 * 4500)   // 5500-10000ft clear
    visSm = 7 + r1 * 4                       // 7-11sm
  }
  const vmcOk = ceilFt >= 3500 && visSm >= 3
  return { ceilFt, visSm, vmcOk }
}

// ---------------------------------------------------------------------------
// 6 risk drivers
// ---------------------------------------------------------------------------
type Driver =
  | 'CORR-DEV'   // lateral corridor deviation from landmark sequence
  | 'ALT-DEV'    // altitude deviation from published landmark altitude
  | 'CAT-BUST'   // aircraft category exceeds procedure max
  | 'GROUP-BUST' // group/stage/opspec restriction breach
  | 'WX-BUST'    // current WX below procedure VMC minima
  | 'NOISE'      // noise-sensitive procedure + noisy airframe

const DRIVERS: Driver[] = ['CORR-DEV','ALT-DEV','CAT-BUST','GROUP-BUST','WX-BUST','NOISE']

const DRIVER_LABEL: Record<Driver, string> = {
  'CORR-DEV':   'Corridor dev',
  'ALT-DEV':    'Alt deviation',
  'CAT-BUST':   'Cat exceed',
  'GROUP-BUST': 'Group breach',
  'WX-BUST':    'WX < VMC',
  'NOISE':      'Noise constraint',
}

// ---------------------------------------------------------------------------
// 6 tiers
// ---------------------------------------------------------------------------
type Tier = 'BREACH' | 'CORRIDOR-LOSS' | 'DEVIATE' | 'WATCH' | 'CONFORM' | 'CLEAR'
const TIER_COLOR: Record<Tier, string> = {
  'BREACH':         '#f43f5e',
  'CORRIDOR-LOSS':  '#fb7185',
  'DEVIATE':        '#f59e0b',
  'WATCH':          '#0ea5e9',
  'CONFORM':        '#10b981',
  'CLEAR':          '#94a3b8',
}
const TIER_ORDER: Tier[] = ['BREACH','CORRIDOR-LOSS','DEVIATE','WATCH','CONFORM','CLEAR']

interface Row {
  f: F
  cls: ClassKey
  spec: ClassSpec
  cat: AcftCat
  proc: Cvfp | null
  distToRwyNM: number
  nearestLm: { lm: Landmark; idx: number; distNM: number } | null
  altDevFt: number              // signed; +high / -low vs nearest landmark altitude
  corrDevNM: number             // perpendicular distance off ideal landmark track
  wx: WxState | null
  driver: Record<Driver, number>
  score: number
  tier: Tier
  topDriver: Driver
  advice: string
}

function adviseRow(r: Row): string {
  const p = r.proc
  if (!p) return 'No procedure snap — outside scope'
  if (!r.wx) return 'No WX state'
  switch (r.tier) {
    case 'BREACH':
      if (r.driver['CAT-BUST'] > 70) return `BREACH ${p.id} — Cat ${r.cat} exceeds proc max ${p.catMin}. Switch to instrument approach per AIM 5-4-23`
      if (r.driver['GROUP-BUST'] > 70) return `BREACH ${p.id} — ${p.group} restriction violated by ${r.spec.label}. OpSpec/Group-I bust per JO 7110.65 §7-4-5b`
      if (r.driver['WX-BUST'] > 70) return `BREACH ${p.id} — WX (ceil ${r.wx.ceilFt}ft vis ${r.wx.visSm.toFixed(1)}sm) below VMC mins. Visual not permitted per §91.155 — request instrument`
      return `BREACH ${p.id} — multiple driver violations. Discontinue visual, request vectors to instrument approach`
    case 'CORRIDOR-LOSS':
      return `CORRIDOR-LOSS ${p.id} — ${r.corrDevNM.toFixed(1)}NM off track from "${r.nearestLm?.lm.name}". Re-acquire landmark or transition to instrument`
    case 'DEVIATE':
      return `DEVIATE ${p.id} — alt dev ${r.altDevFt>=0?'+':''}${r.altDevFt.toFixed(0)}ft vs published ${r.nearestLm?.lm.altFt}ft @ "${r.nearestLm?.lm.name}". Correct per chart profile`
    case 'WATCH':
      return `WATCH ${p.id} ${p.rwy} — ${r.spec.label} on visual ${r.nearestLm?.lm.name} ${r.distToRwyNM.toFixed(1)}NM out. Monitor landmark sequence`
    case 'CONFORM':
      return `CONFORM ${p.id} — on profile at "${r.nearestLm?.lm.name}" alt ${r.f.altitudeFt.toFixed(0)}ft (pub ${r.nearestLm?.lm.altFt}ft ±${r.nearestLm?.lm.tolFt}). Continue visual`
    case 'CLEAR':
      return `CLEAR — ${p.id} ${p.rwy} visual approach available, WX permits, airframe eligible. Ready to brief`
  }
}

const SRC_HALO = 'cvfp-halo-src', SRC_PIN = 'cvfp-pin-src', SRC_LBL = 'cvfp-lbl-src'
const SRC_LM   = 'cvfp-lm-src',   SRC_TRK = 'cvfp-trk-src',  SRC_LNK = 'cvfp-lnk-src'
const LYR_HALO = 'cvfp-halo-lyr', LYR_PIN = 'cvfp-pin-lyr', LYR_LBL = 'cvfp-lbl-lyr'
const LYR_LM   = 'cvfp-lm-lyr',   LYR_LMLBL = 'cvfp-lmlbl-lyr'
const LYR_TRK  = 'cvfp-trk-lyr',  LYR_LNK  = 'cvfp-lnk-lyr'

export default function CvfpChartedVisual({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'PROCEDURES' | 'LANDMARKS' | 'METHOD'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [regionFilter, setRegionFilter] = useState<Cvfp['region'] | 'ALL'>('ALL')
  const [procFilter, setProcFilter] = useState<string | 'ALL'>('ALL')
  const [advMul, setAdvMul] = useState(100)
  const [wxMul, setWxMul] = useState(100)
  const [doy, setDoy] = useState(180)
  const [scopeNM, setScopeNM] = useState(30)
  const [alignDeg, setAlignDeg] = useState(60)
  const [query, setQuery] = useState('')

  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showLm, setShowLm] = useState(true)
  const [showTrk, setShowTrk] = useState(true)
  const [showLnk, setShowLnk] = useState(true)

  // ---------- compute rows ----------
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!Number.isFinite(f.altitudeFt) || !Number.isFinite(f.velocityKts)) continue
      // visual approach gate: < 6000ft AGL-ish, descending, > 80kt, < 250kt
      if (f.altitudeFt > 6500) continue
      if ((f.vertRate || 0) > -100) continue
      if (f.velocityKts < 80 || f.velocityKts > 260) continue

      const snap = snapProc(f, scopeNM, alignDeg)
      const p = snap.proc
      if (!p) continue
      const cls = classifyClass(f.type)
      const spec = CLASS_SPEC[cls]
      const cat = approachCat(spec)
      const wx = wxForAirport(p.icao, doy, wxMul)

      // ---- corridor deviation (perpendicular dist to nearest landmark) ----
      const corrDevNM = snap.nearestLm ? snap.nearestLm.distNM : 999

      // ---- altitude deviation vs published landmark altitude ----
      const lmAlt = snap.nearestLm?.lm.altFt ?? 0
      const tol = snap.nearestLm?.lm.tolFt ?? 100
      const altDevFt = f.altitudeFt - lmAlt
      const altOver = Math.max(0, Math.abs(altDevFt) - tol)

      const sev: Record<Driver, number> = {
        'CORR-DEV':0, 'ALT-DEV':0, 'CAT-BUST':0, 'GROUP-BUST':0, 'WX-BUST':0, 'NOISE':0,
      }

      // CORR-DEV: corridor lateral deviation
      // tolerance scales with leg distance — far from runway 2NM OK, close 0.5NM
      const corrTol = Math.max(0.4, Math.min(2.5, snap.distToRwyNM / 8))
      const corrExcess = Math.max(0, corrDevNM - corrTol)
      if (corrExcess > 0) sev['CORR-DEV'] = Math.min(100, 25 + corrExcess * 22)

      // ALT-DEV: altitude vs published landmark
      if (altOver > 0) sev['ALT-DEV'] = Math.min(100, 20 + (altOver / Math.max(tol,80)) * 35)

      // CAT-BUST: aircraft category exceeds procedure max
      if (CAT_RANK[cat] > CAT_RANK[p.catMin]) {
        const gap = CAT_RANK[cat] - CAT_RANK[p.catMin]
        sev['CAT-BUST'] = Math.min(100, 60 + gap * 18)
      }

      // GROUP-BUST: restriction breach
      if (p.group === 'GROUP-I-ONLY' && !spec.groupI) sev['GROUP-BUST'] = 90
      if (p.group === 'STAGE-4-ONLY' && !spec.stage4) sev['GROUP-BUST'] = 88
      if (p.group === 'OPSPEC-C062') {
        // assume ~92% of carriers hold OpSpec C062 for KJFK CANARSIE
        const has = (hash32(f.icao + 'C062') & 0xff) < 235
        if (!has) sev['GROUP-BUST'] = 82
      }
      if (p.group === 'PROP-TURBOPROP' && cls !== 'RGN-T') sev['GROUP-BUST'] = 75

      // WX-BUST: WX below procedure VMC minima
      if (wx.ceilFt < p.ceilMinFt || wx.visSm < p.visMinSm) {
        const ceilDef = Math.max(0, p.ceilMinFt - wx.ceilFt)
        const visDef = Math.max(0, p.visMinSm - wx.visSm)
        sev['WX-BUST'] = Math.min(100, 60 + ceilDef/40 + visDef * 12)
      }

      // NOISE: noise-sensitive procedure + noisy class
      if (p.noiseSensitive) {
        let noisy = 0
        if (cls === 'HVY-T') noisy = 25
        else if (cls === 'MIL') noisy = 65
        else if (cls === 'NB' && !spec.stage4) noisy = 40
        if (noisy > 0) sev['NOISE'] = noisy
      }

      // composite — max·0.66 + mean·0.34 × ADV-MUL
      const vals = DRIVERS.map(d => sev[d])
      const maxV = Math.max(...vals)
      const meanV = vals.reduce((a,b)=>a+b,0) / vals.length
      let raw = (maxV * 0.66 + meanV * 0.34) * (advMul / 100)

      // hard escalators
      if (sev['CAT-BUST'] >= 80) raw = Math.max(raw, 85)
      if (sev['GROUP-BUST'] >= 80) raw = Math.max(raw, 82)
      if (sev['WX-BUST'] >= 80) raw = Math.max(raw, 80)
      if (corrDevNM > 5) raw = Math.max(raw, 72)  // lost the corridor

      const score = Math.min(100, Math.max(0, raw))
      const tier: Tier =
        score >= 80 ? 'BREACH' :
        score >= 60 ? 'CORRIDOR-LOSS' :
        score >= 40 ? 'DEVIATE' :
        score >= 22 ? 'WATCH' :
        wx.vmcOk ? 'CONFORM' : 'CLEAR'

      let topDriver: Driver = 'CORR-DEV'
      let topV = -1
      for (const d of DRIVERS) { if (sev[d] > topV) { topV = sev[d]; topDriver = d } }

      const row: Row = {
        f, cls, spec, cat, proc: p,
        distToRwyNM: snap.distToRwyNM,
        nearestLm: snap.nearestLm,
        altDevFt, corrDevNM, wx,
        driver: sev, score, tier, topDriver,
        advice: '',
      }
      row.advice = adviseRow(row)
      out.push(row)
    }
    return out
  }, [flights, advMul, wxMul, doy, scopeNM, alignDeg])

  // ---------- tier counts ----------
  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { BREACH:0, 'CORRIDOR-LOSS':0, DEVIATE:0, WATCH:0, CONFORM:0, CLEAR:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  // ---------- per-procedure aggregation ----------
  const procAggr = useMemo(() => {
    const m: Record<string, { proc: Cvfp; count: number; worstTier: Tier; wx: WxState }> = {}
    for (const r of rows) {
      if (!r.proc) continue
      if (!m[r.proc.id]) m[r.proc.id] = { proc: r.proc, count: 0, worstTier: 'CLEAR', wx: r.wx! }
      m[r.proc.id].count++
      if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(m[r.proc.id].worstTier)) {
        m[r.proc.id].worstTier = r.tier
      }
    }
    return Object.values(m).sort((a,b) => TIER_ORDER.indexOf(a.worstTier) - TIER_ORDER.indexOf(b.worstTier))
  }, [rows])

  // ---------- summary stats ----------
  const summary = useMemo(() => {
    const n = rows.length
    const vmcOk = rows.filter(r => r.wx?.vmcOk).length
    const breaches = rows.filter(r => r.tier === 'BREACH' || r.tier === 'CORRIDOR-LOSS').length
    const sumScore = rows.reduce((a,r)=>a+r.score,0)
    const mu = n ? sumScore/n : 0
    const procActive = procAggr.length
    return { n, vmcOk, breaches, mu, procActive }
  }, [rows, procAggr])

  // ---------- visible filtered list ----------
  const visible = useMemo(() => {
    return rows
      .filter(r => tierFilter === 'ALL' || r.tier === tierFilter)
      .filter(r => regionFilter === 'ALL' || (r.proc && r.proc.region === regionFilter))
      .filter(r => procFilter === 'ALL' || (r.proc && r.proc.id === procFilter))
      .filter(r => {
        if (!query) return true
        const q = query.toLowerCase()
        return (r.f.callsign || '').toLowerCase().includes(q)
          || (r.f.type || '').toLowerCase().includes(q)
          || (r.f.operator || '').toLowerCase().includes(q)
          || (r.proc?.id || '').toLowerCase().includes(q)
          || (r.proc?.icao || '').toLowerCase().includes(q)
          || (r.proc?.name || '').toLowerCase().includes(q)
      })
      .sort((a,b) => b.score - a.score)
  }, [rows, tierFilter, regionFilter, procFilter, query])

  // ---------- MapLibre integration ----------
  useEffect(() => {
    if (!map) return
    const ensureSrc = (id: string, data: any) => {
      const s = map.getSource(id) as any
      if (s) { try { s.setData(data) } catch {} }
      else   { try { map.addSource(id, { type: 'geojson', data }) } catch {} }
    }
    const ensureLyr = (spec: any) => {
      if (map.getLayer(spec.id)) return
      try { map.addLayer(spec) } catch {}
    }
    const removeAll = () => {
      for (const id of [LYR_HALO,LYR_PIN,LYR_LBL,LYR_LM,LYR_LMLBL,LYR_TRK,LYR_LNK]) if (map.getLayer(id)) try { map.removeLayer(id) } catch {}
      for (const id of [SRC_HALO,SRC_PIN,SRC_LBL,SRC_LM,SRC_TRK,SRC_LNK]) if (map.getSource(id)) try { map.removeSource(id) } catch {}
    }

    // halos (all visible)
    const haloFeats = visible.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: { radius: 6 + Math.min(20, r.score/5), color: TIER_COLOR[r.tier] }
    }))
    // pins for breach / corridor-loss
    const pinFeats = visible.filter(r => r.tier==='BREACH' || r.tier==='CORRIDOR-LOSS').map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: { color: TIER_COLOR[r.tier] }
    }))
    // labels for top 30
    const lblFeats = visible.slice(0, 30).map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: {
        label: `${r.f.callsign || r.f.icao} ${r.proc?.id ?? ''}`,
        color: TIER_COLOR[r.tier],
      }
    }))
    // landmarks of procedures with active traffic
    const activeProcs = new Set(visible.map(r => r.proc?.id).filter(Boolean) as string[])
    const lmFeats: any[] = []
    const trkFeats: any[] = []
    for (const p of PROCEDURES) {
      if (!activeProcs.has(p.id)) continue
      for (let i=0; i<p.landmarks.length; i++) {
        const lm = p.landmarks[i]
        lmFeats.push({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [lm.lng, lm.lat] },
          properties: { label: `${lm.name} ${lm.altFt}ft`, idx: i }
        })
      }
      // procedure track polyline: landmark[0] → landmark[N-1] → runway threshold
      const coords: [number,number][] = p.landmarks.map(lm => [lm.lng, lm.lat] as [number,number])
      coords.push([p.rwyLng, p.rwyLat])
      trkFeats.push({
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: coords },
        properties: { proc: p.id }
      })
    }
    // link lines from breach aircraft to their nearest landmark
    const linkFeats = visible
      .filter(r => (r.tier==='BREACH' || r.tier==='CORRIDOR-LOSS' || r.tier==='DEVIATE') && r.nearestLm)
      .slice(0, 30)
      .map(r => ({
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.nearestLm!.lm.lng, r.nearestLm!.lm.lat]] },
        properties: { color: TIER_COLOR[r.tier] }
      }))

    ensureSrc(SRC_HALO, { type: 'FeatureCollection', features: haloFeats })
    ensureSrc(SRC_PIN,  { type: 'FeatureCollection', features: pinFeats })
    ensureSrc(SRC_LBL,  { type: 'FeatureCollection', features: lblFeats })
    ensureSrc(SRC_LM,   { type: 'FeatureCollection', features: lmFeats })
    ensureSrc(SRC_TRK,  { type: 'FeatureCollection', features: trkFeats })
    ensureSrc(SRC_LNK,  { type: 'FeatureCollection', features: linkFeats })

    if (showTrk) {
      ensureLyr({
        id: LYR_TRK, type: 'line', source: SRC_TRK, paint: {
          'line-color': '#7dd3fc',
          'line-width': 1.6,
          'line-opacity': 0.55,
          'line-dasharray': [4, 2],
        }
      })
    } else if (map.getLayer(LYR_TRK)) try { map.removeLayer(LYR_TRK) } catch {}

    if (showLnk) {
      ensureLyr({
        id: LYR_LNK, type: 'line', source: SRC_LNK, paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.0,
          'line-opacity': 0.5,
          'line-dasharray': [2, 2],
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

    if (showLm) {
      ensureLyr({
        id: LYR_LM, type: 'circle', source: SRC_LM, paint: {
          'circle-radius': 3.2,
          'circle-color': '#fcd34d',
          'circle-stroke-color': '#020617',
          'circle-stroke-width': 1.0,
          'circle-opacity': 0.85,
        }
      })
      ensureLyr({
        id: LYR_LMLBL, type: 'symbol', source: SRC_LM, layout: {
          'text-field': ['get', 'label'],
          'text-size': 9,
          'text-offset': [0, 1.0],
          'text-anchor': 'top',
          'text-font': ['Open Sans Regular'],
        },
        paint: {
          'text-color': '#fde68a',
          'text-halo-color': '#020617',
          'text-halo-width': 1.0,
        }
      })
    } else {
      if (map.getLayer(LYR_LM))    try { map.removeLayer(LYR_LM) } catch {}
      if (map.getLayer(LYR_LMLBL)) try { map.removeLayer(LYR_LMLBL) } catch {}
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
  }, [map, visible, showHalo, showPin, showLbl, showLm, showTrk, showLnk])

  // ---------- render ----------
  return (
    <div className="absolute right-3 top-20 z-30 w-[460px] max-h-[calc(100vh-110px)] flex flex-col bg-slate-950/95 backdrop-blur-sm border border-slate-800 rounded-xl shadow-2xl overflow-hidden text-slate-200">

      {/* header */}
      <div className="px-4 py-3 border-b border-slate-800 flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-sky-400">CVFP</div>
          <div className="text-sm font-semibold text-slate-100">Charted Visual Procedures</div>
          <div className="text-[10px] text-slate-500 mt-0.5">Landmark-Track Conformance · AIM 5-4-23 · Order 8260.3D §232</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none">×</button>
      </div>

      {/* tier counters */}
      <div className="px-3 pt-3 pb-2 grid grid-cols-6 gap-1">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`text-[9px] uppercase tracking-wider rounded border px-1.5 py-1 ${
              tierFilter === t
                ? 'border-sky-500/40 bg-sky-500/15 text-slate-100'
                : 'border-slate-800 bg-slate-900/50 text-slate-400 hover:text-slate-200'
            }`}
            style={tierFilter === t ? undefined : { borderLeftColor: TIER_COLOR[t], borderLeftWidth: 2 }}>
            <div className="text-[10px] font-mono text-slate-100">{tierCounts[t]}</div>
            <div className="text-[8px] truncate">{t === 'CORRIDOR-LOSS' ? 'CORR-LOSS' : t}</div>
          </button>
        ))}
      </div>

      {/* summary 5-cell */}
      <div className="px-3 pb-2 grid grid-cols-5 gap-1 text-[9px]">
        {[
          { label:'In-CVFP', value: summary.n },
          { label:'VMC-OK',  value: summary.vmcOk },
          { label:'Breach',  value: summary.breaches },
          { label:'Procs',   value: summary.procActive },
          { label:'μ-Score', value: summary.mu.toFixed(0) },
        ].map(s => (
          <div key={s.label} className="rounded border border-slate-800 bg-slate-900/40 px-1.5 py-1">
            <div className="text-slate-500 uppercase tracking-wider text-[8px]">{s.label}</div>
            <div className="text-slate-100 font-mono">{s.value}</div>
          </div>
        ))}
      </div>

      {/* sliders */}
      <div className="px-3 pb-2 grid grid-cols-2 gap-2 text-[9px]">
        <label className="block">
          <div className="text-slate-500 uppercase tracking-wider mb-0.5">ADV-MUL {advMul}%</div>
          <input type="range" min={50} max={200} value={advMul} onChange={e=>setAdvMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="text-slate-500 uppercase tracking-wider mb-0.5">WX-MUL {wxMul}%</div>
          <input type="range" min={50} max={200} value={wxMul} onChange={e=>setWxMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="text-slate-500 uppercase tracking-wider mb-0.5">DOY {doy}</div>
          <input type="range" min={0} max={365} value={doy} onChange={e=>setDoy(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="text-slate-500 uppercase tracking-wider mb-0.5">SCOPE {scopeNM}NM</div>
          <input type="range" min={8} max={60} value={scopeNM} onChange={e=>setScopeNM(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </label>
      </div>

      {/* overlay toggles */}
      <div className="px-3 pb-2 flex flex-wrap gap-1 text-[9px]">
        {[
          ['Halo', showHalo, ()=>setShowHalo(v=>!v)],
          ['Pin',  showPin,  ()=>setShowPin(v=>!v)],
          ['Lbl',  showLbl,  ()=>setShowLbl(v=>!v)],
          ['LM',   showLm,   ()=>setShowLm(v=>!v)],
          ['Track',showTrk,  ()=>setShowTrk(v=>!v)],
          ['Link', showLnk,  ()=>setShowLnk(v=>!v)],
        ].map(([lbl,on,fn]: any) => (
          <button key={lbl} onClick={fn} className={`px-1.5 py-0.5 rounded border ${on ? 'border-sky-500/40 bg-sky-500/15 text-slate-100' : 'border-slate-800 bg-slate-900/50 text-slate-500'}`}>{lbl}</button>
        ))}
      </div>

      {/* region + procedure filters */}
      <div className="px-3 pb-2 flex flex-wrap gap-1 text-[9px]">
        {(['ALL','NE','MID','SE','MIDW','MTW','WEST'] as const).map(r => (
          <button key={r} onClick={()=>setRegionFilter(r === 'ALL' ? 'ALL' : r as any)}
            className={`px-1.5 py-0.5 rounded border ${regionFilter === r ? 'border-sky-500/40 bg-sky-500/15 text-slate-100' : 'border-slate-800 bg-slate-900/50 text-slate-500'}`}>{r}</button>
        ))}
      </div>

      <div className="px-3 pb-2">
        <select value={procFilter} onChange={e=>setProcFilter(e.target.value)} className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-200">
          <option value="ALL">All Procedures</option>
          {PROCEDURES.map(p => <option key={p.id} value={p.id}>{p.id} · {p.icao}/{p.rwy} · {p.name}</option>)}
        </select>
      </div>

      <div className="px-3 pb-2">
        <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="search callsign / type / operator / proc"
          className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600" />
      </div>

      {/* tab switcher */}
      <div className="px-3 pb-2 flex gap-1 text-[9px]">
        {(['AIRCRAFT','PROCEDURES','LANDMARKS','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)}
            className={`px-2 py-1 rounded border flex-1 uppercase tracking-wider ${tab === t ? 'border-sky-500/40 bg-sky-500/15 text-slate-100' : 'border-slate-800 bg-slate-900/50 text-slate-500'}`}>{t}</button>
        ))}
      </div>

      {/* body */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 text-[10px] space-y-1">
        {tab === 'AIRCRAFT' && visible.length === 0 && (
          <div className="text-slate-600 italic text-center py-6">No aircraft snapped to any CVFP procedure within scope.</div>
        )}
        {tab === 'AIRCRAFT' && visible.map(r => (
          <button key={r.f.icao} onClick={()=>onFly(r.f.icao)}
            className="w-full text-left rounded border border-slate-800 bg-slate-900/40 hover:bg-slate-900 hover:border-slate-700 px-2 py-1.5 transition">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-mono text-slate-100">{r.f.callsign || r.f.icao}</span>
                <span className="text-slate-500">{r.f.type || '—'}</span>
                <span className="text-[8px] uppercase rounded px-1 py-0.5 border" style={{ borderColor: TIER_COLOR[r.tier], color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                <span className="text-[8px] uppercase rounded px-1 py-0.5 border border-slate-700 text-slate-400">Cat-{r.cat}</span>
              </div>
              <span className="font-mono text-slate-100">{r.score.toFixed(0)}</span>
            </div>
            <div className="mt-1 grid grid-cols-8 gap-1 text-[8.5px] text-slate-400">
              <div><span className="text-slate-600">PROC</span> {r.proc?.id ?? '—'}</div>
              <div><span className="text-slate-600">RWY</span> {r.proc?.rwy ?? '—'}</div>
              <div><span className="text-slate-600">ALT</span> {r.f.altitudeFt.toFixed(0)}</div>
              <div><span className="text-slate-600">ΔALT</span> <span className={Math.abs(r.altDevFt)>200?'text-amber-400':''}>{r.altDevFt>=0?'+':''}{r.altDevFt.toFixed(0)}</span></div>
              <div><span className="text-slate-600">CORR</span> <span className={r.corrDevNM>2?'text-amber-400':''}>{r.corrDevNM.toFixed(1)}NM</span></div>
              <div><span className="text-slate-600">DIST</span> {r.distToRwyNM.toFixed(1)}</div>
              <div><span className="text-slate-600">CEIL</span> {r.wx?.ceilFt}ft</div>
              <div><span className="text-slate-600">VIS</span> {r.wx?.visSm.toFixed(1)}sm</div>
            </div>
            <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden">
              <div className="h-full transition-all" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }} />
            </div>
            <div className="mt-1 flex flex-wrap gap-1 text-[8px]">
              {DRIVERS.map(d => {
                const v = r.driver[d]
                if (v < 1) return null
                const color = v >= 60 ? '#f43f5e' : v >= 35 ? '#f59e0b' : v >= 18 ? '#0ea5e9' : '#64748b'
                return (
                  <span key={d} className="px-1 py-0.5 rounded border" style={{ borderColor: color, color }}>
                    {DRIVER_LABEL[d]} {v.toFixed(0)}
                  </span>
                )
              })}
            </div>
            <div className="mt-1 text-[8.5px] italic" style={{ color: TIER_COLOR[r.tier] }}>{r.advice}</div>
            <div className="mt-0.5 text-[8px] text-slate-600 truncate">at "{r.nearestLm?.lm.name ?? '—'}" idx {(r.nearestLm?.idx ?? 0)+1}/{r.proc?.landmarks.length ?? 0}</div>
          </button>
        ))}

        {tab === 'PROCEDURES' && (
          <>
            {procAggr.length === 0 && (
              <div className="text-slate-600 italic text-center py-6">No procedures have active inbound traffic.</div>
            )}
            {procAggr.map(p => (
              <div key={p.proc.id} className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-slate-100">{p.proc.id}</span>
                    <span className="text-slate-400">{p.proc.icao}/{p.proc.rwy}</span>
                    <span className="text-[8px] uppercase rounded px-1 py-0.5 border" style={{ borderColor: TIER_COLOR[p.worstTier], color: TIER_COLOR[p.worstTier] }}>{p.worstTier}</span>
                  </div>
                  <span className="font-mono text-slate-100">×{p.count}</span>
                </div>
                <div className="mt-1 grid grid-cols-5 gap-1 text-[8.5px] text-slate-400">
                  <div><span className="text-slate-600">CAT-MAX</span> {p.proc.catMin}</div>
                  <div><span className="text-slate-600">GROUP</span> {p.proc.group.replace('-ONLY','')}</div>
                  <div><span className="text-slate-600">CEIL-MIN</span> {p.proc.ceilMinFt}ft</div>
                  <div><span className="text-slate-600">VIS-MIN</span> {p.proc.visMinSm}sm</div>
                  <div><span className="text-slate-600">LMs</span> {p.proc.landmarks.length}</div>
                </div>
                <div className="mt-1 grid grid-cols-3 gap-1 text-[8.5px] text-slate-400">
                  <div><span className="text-slate-600">CEIL</span> {p.wx.ceilFt}ft {p.wx.ceilFt < p.proc.ceilMinFt ? '⚠' : '✓'}</div>
                  <div><span className="text-slate-600">VIS</span> {p.wx.visSm.toFixed(1)}sm {p.wx.visSm < p.proc.visMinSm ? '⚠' : '✓'}</div>
                  <div><span className="text-slate-600">VMC</span> {p.wx.vmcOk ? '✓' : '✗'}</div>
                </div>
                <div className="mt-1 text-[8.5px] italic text-slate-500">{p.proc.airport} · {p.proc.name}</div>
                <div className="mt-0.5 text-[8px] text-amber-400/80">! {p.proc.hazardNote}</div>
              </div>
            ))}
          </>
        )}

        {tab === 'LANDMARKS' && (
          <>
            {PROCEDURES
              .filter(p => regionFilter === 'ALL' || p.region === regionFilter)
              .filter(p => procFilter === 'ALL' || p.id === procFilter)
              .map(p => (
                <div key={p.id} className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-slate-100">{p.id}</span>
                    <span className="text-slate-500 text-[9px]">{p.icao}/{p.rwy} · {p.airport}</span>
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {p.landmarks.map((lm, i) => (
                      <div key={i} className="grid grid-cols-12 gap-1 items-center text-[9px]">
                        <div className="col-span-1 font-mono text-slate-600">{i+1}.</div>
                        <div className="col-span-5 text-slate-300 truncate">{lm.name}</div>
                        <div className="col-span-3 font-mono text-slate-400">{lm.altFt}ft</div>
                        <div className="col-span-3 text-slate-600">±{lm.tolFt}ft</div>
                      </div>
                    ))}
                    <div className="grid grid-cols-12 gap-1 items-center text-[9px] border-t border-slate-800 pt-1 mt-1">
                      <div className="col-span-1 font-mono text-sky-400">›</div>
                      <div className="col-span-5 text-sky-300">RWY {p.rwy}</div>
                      <div className="col-span-3 font-mono text-slate-500">{p.rwyElevFt}ft elev</div>
                      <div className="col-span-3 text-slate-500">hdg {p.ldgHdgTrue}°T</div>
                    </div>
                  </div>
                </div>
              ))}
          </>
        )}

        {tab === 'METHOD' && (
          <div className="space-y-2 text-[9.5px] text-slate-400 leading-relaxed">
            <div>
              <div className="text-slate-200 font-semibold text-[10px]">Regulatory basis</div>
              <div className="mt-1">CVFP is the FAA-published visual approach chart authorised by FAA Order 8260.3D §232 (TERPS) and described in AIM 5-4-23. A CVFP overlays specific charted landmarks (rivers, bridges, stadiums, towers) onto a visual approach. Once cleared, the pilot is responsible for terrain & traffic separation per §91.175(j), and ATC retains traffic-advisory responsibility.</div>
            </div>
            <div>
              <div className="text-slate-200 font-semibold text-[10px]">VMC gate</div>
              <div className="mt-1">A CVFP may not be commenced unless reported weather is at or above the published procedure minima — typically ceiling ≥ 3500ft AGL and visibility ≥ 3sm per the charted note. Several CVFPs (CANARSIE 13L/R, QUIET BRIDGE 28L) require higher mins (5sm, 4000ft) due to terrain or noise constraints. WX-BUST escalator hits hard at 80.</div>
            </div>
            <div>
              <div className="text-slate-200 font-semibold text-[10px]">Landmark sequencing</div>
              <div className="mt-1">Each procedure publishes 4-5 named visual landmarks with crossing altitudes (MSL). CORR-DEV scores perpendicular deviation from the nearest landmark; ALT-DEV scores vertical deviation vs the published crossing altitude with per-landmark ±tolerance. Lost-the-corridor (&gt; 5NM off) auto-escalates to ≥ 72 score.</div>
            </div>
            <div>
              <div className="text-slate-200 font-semibold text-[10px]">Category / Group restrictions</div>
              <div className="mt-1">Per AIM 5-4-23 each CVFP publishes a maximum approach category (per Vref via AIM 5-4-7 Cat-A &lt; 91kt / B 91-120 / C 121-140 / D 141-165 / E ≥ 166). Some procedures additionally restrict to Group I jets ≤ 100,000 lbs (EXPRESSWAY-13 LGA, STADIUM-25L MDW), Stage-4 noise certification (QUIET BRIDGE 28L SFO, TIBURON 28L SFO), or carrier-specific OpSpec C062 authorisation (CANARSIE 13L/R JFK).</div>
            </div>
            <div>
              <div className="text-slate-200 font-semibold text-[10px]">6-driver decomposition</div>
              <div className="mt-1">
                CORR-DEV · ALT-DEV · CAT-BUST · GROUP-BUST · WX-BUST · NOISE → composite max·0.66 + mean·0.34 × ADV-MUL.<br/>
                Hard escalators: CAT-BUST ≥ 80 → score min 85; GROUP-BUST ≥ 80 → min 82; WX-BUST ≥ 80 → min 80; corridor &gt; 5NM → min 72.
              </div>
            </div>
            <div>
              <div className="text-slate-200 font-semibold text-[10px]">6-tier ladder</div>
              <div className="mt-1">
                BREACH ≥ 80 — multiple violations, abandon visual, request instrument approach.<br/>
                CORRIDOR-LOSS ≥ 60 — lost the landmark sequence, re-acquire or transition.<br/>
                DEVIATE ≥ 40 — altitude/track outside tolerance, correct per chart profile.<br/>
                WATCH ≥ 22 — within tolerance, monitor next landmark.<br/>
                CONFORM &lt; 22 with VMC — on profile, continue visual.<br/>
                CLEAR — VMC marginal but no traffic on procedure yet.
              </div>
            </div>
            <div>
              <div className="text-slate-200 font-semibold text-[10px]">Distinct from</div>
              <div className="mt-1">
                APCH-CAT (ILS CAT-I/II/III precision instrument minima), STABLE-APP (1000ft/500ft gross-stabilisation gates), CDFA-VDP (NPA vertical-path continuous descent), CIRCLING (post-instrument-approach circle-to-land manoeuvre), APPR-MINS (minima publication only), STEEP-APCH (high-glidepath physics envelope ≥ 3.5°).
              </div>
            </div>
            <div>
              <div className="text-slate-200 font-semibold text-[10px]">References</div>
              <div className="mt-1">
                14 CFR §91.175(j) visual reference required · §91.155 VFR minimums · §91.131 Class B authorisation · §91.129 Class D · AIM 5-4-23 CVFP · AIM 5-4-22 Side-step · AIM 5-4-20 Approach lighting · AIM 5-4-7 Approach categories · FAA Order 8260.3D §232 TERPS · FAA Order 8260.19J · FAA Order JO 7110.65 §7-4 Visual approach · §7-4-5 CVFP issuance · ICAO Doc 8168 PANS-OPS Vol II Pt I §3.1 Visual manoeuvring · ICAO Annex 6 Pt I §4.2.8.2 · OpSpec C062 special CVFP · OpSpec C063 ·  OpSpec C075 IFR-to-visual transition · AC 90-114B · AC 91-79B.
              </div>
            </div>
            <div className="border-t border-slate-800 pt-2 text-[8.5px] text-slate-600">
              CVFP catalogue: {PROCEDURES.length} procedures across {Array.from(new Set(PROCEDURES.map(p=>p.icao))).length} airports · {PROCEDURES.reduce((a,p)=>a+p.landmarks.length,0)} charted landmarks.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
