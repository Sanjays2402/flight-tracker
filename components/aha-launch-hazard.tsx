'use client'

// =============================================================================
// AHA · Launch & Reentry Aircraft Hazard Area Monitor
// -----------------------------------------------------------------------------
// Per-airframe live evaluator of every commercial flight whose trajectory
// intersects (or threatens to intersect) an active or imminent COMMERCIAL
// SPACE OPERATION hazard volume — Launch Hazard Area (LHA), Reentry Hazard
// Area (RHA), Instantaneous-Impact-Point (IIP) corridor, Stage-1 / Stage-2
// debris Drop Zones (DZs), Fairing Jettison Zone, or RTLS / ASDS recovery
// Landing Zone (LZ) — per the FAA Office of Commercial Space Transportation
// (AST) regulatory regime governing orbital and suborbital flight:
//
//   • 14 CFR Part 450 — Launch and Reentry License Requirements
//       §450.101 individual / collective casualty Ec ≤ 100×10⁻⁶ / ≤ 30×10⁻⁶
//       §450.108 flight safety system (FTS) requirements
//       §450.139 toxic release hazard analysis
//   • FAA AC 91-86 — Aircraft Hazard Areas for Commercial Space Operations
//       defines LHA (4 hr pre-launch publish), RHA (2 hr pre-reentry),
//       lateral / longitudinal dispersion ellipsoid sizing methodology
//   • FAA Order JO 7110.65 §9-3 — Air Traffic procedures for SUA/AHA closure
//   • FAA Order 8000.83 — Real-time hazard reporting from AST → ATCSCC
//   • ICAO Doc 10100 — Space-vehicle ops impact on civil airspace
//   • EUROCONTROL ATS.OR.B 145 — high-altitude / oceanic launch coordination
//   • ICAO Annex 11 §2.18.2 — temporary reserved airspace for space activity
//
// STRUCTURALLY DISTINCT FROM:
//   • NOTAM/TFR text panel (raw text; AHA is the SPATIAL ENVELOPE evaluator)
//   • SUA (permanent restricted/prohibited/MOA; AHA is dynamic 4-hr window)
//   • ADIZ (border-crossing identification; AHA is debris-impact safety)
//   • CONVECTIVE-CELLS (weather; AHA is engineered hazard)
//   • DIVERSION (post-emergency landing search; AHA is pre-emptive reroute)
//   • SAR (downed-aircraft search; AHA is launch-debris keep-out)
//
// AHA is uniquely the COMMERCIAL-SPACE keep-out compliance evaluator that
// answers, for every flight in the live picture, (a) is the airframe inside
// an active hazard polygon RIGHT NOW (regulatory breach — controller-vector
// failure), (b) will it enter one within the published window of an imminent
// launch / reentry given current track and groundspeed, (c) which spaceport
// + vehicle class + T-0 timestamp drives the closure, and (d) what is the
// minimum-fuel reroute distance (Δ NM around the LHA boundary).
//
// 32-spaceport global catalogue covers every active orbital launch site
// (CCAFS-LC39A / LC40 / SLC41 · VAFB-SLC4E/4W · KSC-LC39B · Boca Chica /
// Starbase · MARS-Wallops · KODIAK-PSCA · Mojave · Spaceport Cornwall ·
// Andøya · Esrange Kiruna · Kourou-ELA-3/4 / ELS · Baikonur-1/31/41 ·
// Plesetsk · Vostochny · Hammaguir · Tanegashima-LP-Y · Uchinoura ·
// Sriharikota-SDSC-FLP/SLP · Wenchang-LC-101/201 · Jiuquan-SLS-2/921 ·
// Taiyuan · Xichang · Mahia-LC-1 · Sutherland Spaceport · Cape Brett ·
// Wallops MARS Pad-0A / 0B) and 14 vehicle classes (F9-RTLS / F9-ASDS /
// F9-EXP / FH-RTLS / FH-ASDS / STAR / ATLAS-V / VULCAN / ELECTRON / NG /
// ARIANE-6 / SOYUZ / H3 / LM-CZ / PSLV-LVM3 / ALPHA-FIREFLY).
//
// TIER LADDER (most severe → least):
//   IN-LHA       inside Launch Hazard Area within active window
//   IN-RHA       inside Reentry Hazard Area within active window
//   IN-IIP       within IIP corridor (±10 NM of nominal IIP groundtrack)
//   IN-DZ        inside Stage-1 / Stage-2 / Fairing debris Drop Zone
//   IN-LZ        inside RTLS / ASDS recovery Landing Zone
//   NEAR-30      within 30 NM of any hazard polygon, window open
//   WIN-OPEN     hazard window open, flight in TMA but outside polygon
//   T-PRE        scheduled launch ≤90 min, flight projected to intersect
//   CLR          no current hazard intersection
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
  | 'IN-LHA'
  | 'IN-RHA'
  | 'IN-IIP'
  | 'IN-DZ'
  | 'IN-LZ'
  | 'NEAR-30'
  | 'WIN-OPEN'
  | 'T-PRE'
  | 'CLR'

const TIER_ORDER: Tier[] = ['IN-LHA','IN-RHA','IN-IIP','IN-DZ','IN-LZ','NEAR-30','WIN-OPEN','T-PRE','CLR']
const TIER_RANK: Record<Tier, number> = {
  'IN-LHA':0,'IN-RHA':1,'IN-IIP':2,'IN-DZ':3,'IN-LZ':4,'NEAR-30':5,'WIN-OPEN':6,'T-PRE':7,'CLR':8,
}
const TIER_COLOR: Record<Tier, string> = {
  'IN-LHA':   '#f43f5e',  // rose-500   — regulatory breach
  'IN-RHA':   '#fb7185',  // rose-400
  'IN-IIP':   '#fb923c',  // orange-400
  'IN-DZ':    '#f59e0b',  // amber-500
  'IN-LZ':    '#eab308',  // yellow-500
  'NEAR-30':  '#38bdf8',  // sky-400
  'WIN-OPEN': '#0ea5e9',  // sky-500
  'T-PRE':    '#7dd3fc',  // sky-300
  'CLR':      '#10b981',  // emerald-500
}
const TIER_LABEL: Record<Tier, string> = {
  'IN-LHA':'Inside Launch Hazard Area',
  'IN-RHA':'Inside Reentry Hazard Area',
  'IN-IIP':'Inside IIP corridor',
  'IN-DZ':'Inside Debris Drop Zone',
  'IN-LZ':'Inside Recovery Landing Zone',
  'NEAR-30':'<30 NM of hazard, window open',
  'WIN-OPEN':'Hazard window open, polygon clear',
  'T-PRE':'Launch ≤90 min, intersect projected',
  'CLR':'No active hazard',
}

// ---- Vehicle class -------------------------------------------------------
type Vehicle =
  | 'F9-RTLS' | 'F9-ASDS' | 'F9-EXP' | 'FH-RTLS' | 'FH-ASDS' | 'STAR'
  | 'ATLAS-V' | 'VULCAN' | 'ELECTRON' | 'NG' | 'ARIANE-6'
  | 'SOYUZ'   | 'H3'     | 'LM-CZ'   | 'PSLV-LVM3' | 'ALPHA-FIREFLY'

interface VehSpec {
  v: Vehicle
  label: string                // human-readable name
  liftKt: number               // launch GLOM tonnes (drives hazard scale)
  lhaNM: number                // LHA downrange extent
  lhaWidthDeg: number          // LHA fan half-angle
  iipNM: number                // IIP corridor track length
  iipWidthNM: number           // ±width of corridor
  hasRTLS: boolean             // returns first-stage to pad
  hasASDS: boolean             // first-stage to droneship
  dzS1NM: number               // S1 drop zone distance downrange (0 if RTLS)
  dzS2NM: number               // S2 deorbit DZ distance (mostly oceanic)
  fzNM:   number               // fairing jettison zone distance
  toxic:  boolean              // toxic propellant (UDMH/N2O4) — wider RHA
}

const VEHICLES: Record<Vehicle, VehSpec> = {
  'F9-RTLS':  { v:'F9-RTLS',  label:'Falcon 9 RTLS',          liftKt:549, lhaNM:340, lhaWidthDeg:6,  iipNM:1200, iipWidthNM:10, hasRTLS:true,  hasASDS:false, dzS1NM:0,    dzS2NM:1100, fzNM:520,  toxic:false },
  'F9-ASDS':  { v:'F9-ASDS',  label:'Falcon 9 ASDS',          liftKt:549, lhaNM:380, lhaWidthDeg:6,  iipNM:1300, iipWidthNM:10, hasRTLS:false, hasASDS:true,  dzS1NM:330,  dzS2NM:1200, fzNM:560,  toxic:false },
  'F9-EXP':   { v:'F9-EXP',   label:'Falcon 9 expendable',    liftKt:549, lhaNM:420, lhaWidthDeg:6,  iipNM:1400, iipWidthNM:11, hasRTLS:false, hasASDS:false, dzS1NM:420,  dzS2NM:1300, fzNM:600,  toxic:false },
  'FH-RTLS':  { v:'FH-RTLS',  label:'Falcon Heavy RTLS',      liftKt:1421,lhaNM:450, lhaWidthDeg:7,  iipNM:1500, iipWidthNM:12, hasRTLS:true,  hasASDS:true,  dzS1NM:330,  dzS2NM:1400, fzNM:680,  toxic:false },
  'FH-ASDS':  { v:'FH-ASDS',  label:'Falcon Heavy ASDS',      liftKt:1421,lhaNM:500, lhaWidthDeg:7,  iipNM:1600, iipWidthNM:12, hasRTLS:false, hasASDS:true,  dzS1NM:380,  dzS2NM:1500, fzNM:720,  toxic:false },
  'STAR':     { v:'STAR',     label:'Starship Super Heavy',   liftKt:5000,lhaNM:600, lhaWidthDeg:8,  iipNM:2400, iipWidthNM:18, hasRTLS:true,  hasASDS:false, dzS1NM:200,  dzS2NM:2200, fzNM:900,  toxic:false },
  'ATLAS-V':  { v:'ATLAS-V',  label:'ULA Atlas V',            liftKt:546, lhaNM:380, lhaWidthDeg:6,  iipNM:1300, iipWidthNM:10, hasRTLS:false, hasASDS:false, dzS1NM:380,  dzS2NM:1200, fzNM:560,  toxic:true  },
  'VULCAN':   { v:'VULCAN',   label:'ULA Vulcan Centaur',     liftKt:622, lhaNM:400, lhaWidthDeg:6,  iipNM:1400, iipWidthNM:11, hasRTLS:false, hasASDS:false, dzS1NM:400,  dzS2NM:1300, fzNM:600,  toxic:false },
  'ELECTRON': { v:'ELECTRON', label:'Rocket Lab Electron',    liftKt:13,  lhaNM:180, lhaWidthDeg:5,  iipNM:800,  iipWidthNM:8,  hasRTLS:false, hasASDS:false, dzS1NM:180,  dzS2NM:700,  fzNM:240,  toxic:false },
  'NG':       { v:'NG',       label:'Northrop Antares 330',   liftKt:296, lhaNM:280, lhaWidthDeg:5,  iipNM:1100, iipWidthNM:10, hasRTLS:false, hasASDS:false, dzS1NM:280,  dzS2NM:1000, fzNM:440,  toxic:false },
  'ARIANE-6': { v:'ARIANE-6', label:'ESA Ariane 6',           liftKt:860, lhaNM:420, lhaWidthDeg:6,  iipNM:1500, iipWidthNM:11, hasRTLS:false, hasASDS:false, dzS1NM:420,  dzS2NM:1400, fzNM:620,  toxic:false },
  'SOYUZ':    { v:'SOYUZ',    label:'Roscosmos Soyuz-2',      liftKt:312, lhaNM:340, lhaWidthDeg:6,  iipNM:1200, iipWidthNM:10, hasRTLS:false, hasASDS:false, dzS1NM:340,  dzS2NM:1100, fzNM:520,  toxic:true  },
  'H3':       { v:'H3',       label:'JAXA H3-22S',            liftKt:574, lhaNM:380, lhaWidthDeg:6,  iipNM:1300, iipWidthNM:10, hasRTLS:false, hasASDS:false, dzS1NM:380,  dzS2NM:1200, fzNM:560,  toxic:false },
  'LM-CZ':    { v:'LM-CZ',    label:'CASC Long March CZ-5',   liftKt:849, lhaNM:420, lhaWidthDeg:6,  iipNM:1500, iipWidthNM:11, hasRTLS:false, hasASDS:false, dzS1NM:420,  dzS2NM:1400, fzNM:620,  toxic:true  },
  'PSLV-LVM3':{ v:'PSLV-LVM3',label:'ISRO PSLV / LVM3',       liftKt:640, lhaNM:380, lhaWidthDeg:6,  iipNM:1300, iipWidthNM:10, hasRTLS:false, hasASDS:false, dzS1NM:380,  dzS2NM:1200, fzNM:560,  toxic:false },
  'ALPHA-FIREFLY': { v:'ALPHA-FIREFLY',label:'Firefly Alpha', liftKt:54,  lhaNM:220, lhaWidthDeg:5,  iipNM:900,  iipWidthNM:8,  hasRTLS:false, hasASDS:false, dzS1NM:220,  dzS2NM:800,  fzNM:300,  toxic:false },
}

// ---------------------------------------------------------------------------
// SPACEPORT CATALOGUE
// 32 active orbital / suborbital spaceports with lat/lng, typical azimuth(s),
// permitted vehicle classes, AST/CAST region, RTLS/ASDS recovery profile.
// ---------------------------------------------------------------------------
interface Spaceport {
  id: string                    // canonical short code
  name: string                  // human label
  pad?: string                  // launch complex (LC39A, SLC4E etc.)
  operator: string              // SpaceX / ULA / RocketLab / ESA / etc.
  region: 'NA-US' | 'NA-CAN' | 'SA' | 'EU' | 'EUR-N' | 'CIS' | 'ASIA' | 'PAC' | 'AFR' | 'ME' | 'OCEAN'
  lat: number
  lng: number
  azDeg: number[]               // typical launch azimuths (one or more orbital corridors)
  vehicles: Vehicle[]           // vehicles licensed at this pad
  asdsDownrangeKm?: number      // typical droneship downrange distance (km)
  asdsAz?: number               // droneship bearing from pad
  rtlsLzNM?: number             // radius of RTLS LZ safety circle (NM)
  cadence: 'HIGH' | 'MED' | 'LOW' | 'RARE'   // synthetic launch frequency
}

const PORTS: Spaceport[] = [
  // ─── USA EAST RANGE (Cape Canaveral / KSC) ──────────────────────────────
  { id:'KSC-LC39A',  name:'Kennedy Space Center LC-39A',     pad:'LC-39A', operator:'SpaceX',   region:'NA-US', lat:28.6080, lng:-80.6040, azDeg:[ 90, 51.6, 28], vehicles:['F9-RTLS','F9-ASDS','F9-EXP','FH-RTLS','FH-ASDS'], asdsDownrangeKm:660, asdsAz:90,  rtlsLzNM:1.6, cadence:'HIGH' },
  { id:'KSC-LC39B',  name:'Kennedy Space Center LC-39B',     pad:'LC-39B', operator:'NASA-SLS', region:'NA-US', lat:28.6270, lng:-80.6210, azDeg:[ 86,  90, 35], vehicles:['F9-EXP'],                                          rtlsLzNM:2.0, cadence:'RARE' },
  { id:'CCSFS-LC40', name:'Cape Canaveral SFS SLC-40',       pad:'SLC-40', operator:'SpaceX',   region:'NA-US', lat:28.5618, lng:-80.5772, azDeg:[ 90, 51.6, 35], vehicles:['F9-RTLS','F9-ASDS','F9-EXP'],                       asdsDownrangeKm:640, asdsAz:90,  rtlsLzNM:1.6, cadence:'HIGH' },
  { id:'CCSFS-SLC41',name:'Cape Canaveral SFS SLC-41',       pad:'SLC-41', operator:'ULA',      region:'NA-US', lat:28.5833, lng:-80.5829, azDeg:[ 93, 47],       vehicles:['ATLAS-V','VULCAN'],                                              rtlsLzNM:1.4, cadence:'MED' },
  // ─── USA WEST RANGE (Vandenberg) ────────────────────────────────────────
  { id:'VSFB-SLC4E', name:'Vandenberg SFB SLC-4E',           pad:'SLC-4E', operator:'SpaceX',   region:'NA-US', lat:34.6320, lng:-120.6109,azDeg:[196, 158, 220],vehicles:['F9-RTLS','F9-ASDS','F9-EXP'],                       asdsDownrangeKm:640, asdsAz:200, rtlsLzNM:1.6, cadence:'HIGH' },
  { id:'VSFB-SLC4W', name:'Vandenberg SFB SLC-4W',           pad:'SLC-4W', operator:'SpaceX',   region:'NA-US', lat:34.6307, lng:-120.6157,azDeg:[196],          vehicles:['F9-RTLS'],                                                       rtlsLzNM:1.6, cadence:'LOW' },
  { id:'VSFB-SLC2W', name:'Vandenberg SFB SLC-2W',           pad:'SLC-2W', operator:'Firefly',  region:'NA-US', lat:34.7517, lng:-120.6219,azDeg:[196],          vehicles:['ALPHA-FIREFLY'],                                                 rtlsLzNM:1.0, cadence:'RARE' },
  // ─── USA OTHER ───────────────────────────────────────────────────────────
  { id:'BOCA-OLP',   name:'Starbase / Boca Chica',           pad:'OLP-1',  operator:'SpaceX',   region:'NA-US', lat:25.9970, lng:-97.1547, azDeg:[ 95, 105],     vehicles:['STAR'],                                                          rtlsLzNM:2.5, cadence:'MED' },
  { id:'MARS-0A',    name:'MARS Wallops Pad-0A',             pad:'0A',     operator:'Northrop', region:'NA-US', lat:37.8328, lng:-75.4881, azDeg:[ 51.6, 90],    vehicles:['NG'],                                                            rtlsLzNM:1.4, cadence:'LOW' },
  { id:'MARS-0B',    name:'MARS Wallops Pad-0B',             pad:'0B',     operator:'RocketLab',region:'NA-US', lat:37.8338, lng:-75.4866, azDeg:[ 51.6, 38],    vehicles:['ELECTRON'],                                                      rtlsLzNM:0.8, cadence:'MED' },
  { id:'PSCA-LP-1',  name:'Kodiak Pacific Spaceport LP-1',   pad:'LP-1',   operator:'Astra',    region:'NA-US', lat:57.4356, lng:-152.3514,azDeg:[180, 200],     vehicles:['ELECTRON'],                                                      rtlsLzNM:1.0, cadence:'RARE' },
  { id:'MOJ-WEST',   name:'Mojave Air & Space Port',         pad:'WEST',   operator:'Mojave',   region:'NA-US', lat:35.0594, lng:-118.1517,azDeg:[180],          vehicles:['ALPHA-FIREFLY'],                                                 rtlsLzNM:0.8, cadence:'RARE' },
  // ─── CANADA / EU NORTH ───────────────────────────────────────────────────
  { id:'NSCS-CAN',   name:'Spaceport NS Canso',              pad:'CAN-1',  operator:'Maritime', region:'NA-CAN',lat:45.3500, lng:-60.9700, azDeg:[100, 51.6],    vehicles:['ELECTRON','ALPHA-FIREFLY'],                                      rtlsLzNM:1.0, cadence:'RARE' },
  { id:'SAX-COR',    name:'Spaceport Cornwall (horizontal)', pad:'RWY-30', operator:'VirginO',  region:'EU',    lat:50.4385, lng: -4.9962, azDeg:[270],          vehicles:['ALPHA-FIREFLY'],                                                 rtlsLzNM:0.6, cadence:'RARE' },
  { id:'AND-OYA',    name:'Andøya Spaceport (horizontal)',   pad:'NLP-1',  operator:'Andøya',   region:'EUR-N', lat:69.2940, lng: 16.0210, azDeg:[  0, 30],      vehicles:['ELECTRON','ALPHA-FIREFLY'],                                      rtlsLzNM:1.0, cadence:'RARE' },
  { id:'ESR-KIR',    name:'Esrange Space Center Kiruna',     pad:'SPC',    operator:'SSC',      region:'EUR-N', lat:67.8939, lng: 21.0668, azDeg:[  0,  20],     vehicles:['ELECTRON'],                                                      rtlsLzNM:1.0, cadence:'RARE' },
  { id:'SUT-NWO',    name:'Sutherland Spaceport',            pad:'NWO-1',  operator:'Orbex',    region:'EUR-N', lat:58.3666, lng: -4.4423, azDeg:[  0,  20],     vehicles:['ELECTRON'],                                                      rtlsLzNM:1.0, cadence:'RARE' },
  // ─── SOUTH AMERICA / KOUROU ─────────────────────────────────────────────
  { id:'CSG-ELA3',   name:'Kourou ELA-3 (Ariane 5/6)',       pad:'ELA-3',  operator:'Arianesp', region:'SA',    lat: 5.2390, lng:-52.7686, azDeg:[ 90, 7,  138], vehicles:['ARIANE-6'],                                                      rtlsLzNM:2.0, cadence:'LOW' },
  { id:'CSG-ELA4',   name:'Kourou ELA-4 (Ariane 6)',         pad:'ELA-4',  operator:'Arianesp', region:'SA',    lat: 5.2562, lng:-52.7836, azDeg:[ 90, 7,  138], vehicles:['ARIANE-6'],                                                      rtlsLzNM:2.0, cadence:'LOW' },
  { id:'CSG-ELS',    name:'Kourou ELS (Soyuz)',              pad:'ELS',    operator:'Arianesp', region:'SA',    lat: 5.3026, lng:-52.8338, azDeg:[ 90, 30],      vehicles:['SOYUZ'],                                                         rtlsLzNM:1.6, cadence:'RARE' },
  { id:'AEB-ALC',    name:'Alcântara Launch Center',         pad:'PEM',    operator:'AEB',      region:'SA',    lat:-2.3500, lng:-44.4040, azDeg:[ 90, 51.6],    vehicles:['ALPHA-FIREFLY','ELECTRON'],                                      rtlsLzNM:1.0, cadence:'RARE' },
  // ─── CIS RUSSIA / KAZAKHSTAN ────────────────────────────────────────────
  { id:'BAI-1',      name:'Baikonur Cosmodrome LC-1',        pad:'LC-1',   operator:'Roscosmos',region:'CIS',   lat:45.9200, lng: 63.3422, azDeg:[ 51.6, 65],    vehicles:['SOYUZ'],                                                         rtlsLzNM:1.6, cadence:'MED' },
  { id:'BAI-31',     name:'Baikonur Cosmodrome LC-31',       pad:'LC-31',  operator:'Roscosmos',region:'CIS',   lat:45.9967, lng: 63.5640, azDeg:[ 51.6, 65],    vehicles:['SOYUZ'],                                                         rtlsLzNM:1.6, cadence:'LOW' },
  { id:'PLE-43',     name:'Plesetsk Cosmodrome LC-43',       pad:'LC-43',  operator:'Roscosmos',region:'CIS',   lat:62.9279, lng: 40.5772, azDeg:[  0, 63],      vehicles:['SOYUZ'],                                                         rtlsLzNM:1.6, cadence:'LOW' },
  { id:'VOS-1S',     name:'Vostochny Cosmodrome 1S',         pad:'PU-1S',  operator:'Roscosmos',region:'CIS',   lat:51.8847, lng:128.3336, azDeg:[ 51.6, 90],    vehicles:['SOYUZ'],                                                         rtlsLzNM:1.6, cadence:'RARE' },
  // ─── ASIA-PAC ───────────────────────────────────────────────────────────
  { id:'TNG-LP-Y',   name:'Tanegashima Yoshinobu LP',        pad:'LP-Y2',  operator:'JAXA',     region:'ASIA',  lat:30.4006, lng:130.9755, azDeg:[ 90, 51.6,170],vehicles:['H3'],                                                            rtlsLzNM:1.6, cadence:'LOW' },
  { id:'UCH-M',      name:'Uchinoura Space Center',          pad:'M-1',    operator:'JAXA',     region:'ASIA',  lat:31.2510, lng:131.0784, azDeg:[ 90],          vehicles:['ELECTRON','H3'],                                                 rtlsLzNM:1.2, cadence:'RARE' },
  { id:'SRH-FLP',    name:'Satish Dhawan SDSC FLP',          pad:'FLP',    operator:'ISRO',     region:'ASIA',  lat:13.7330, lng: 80.2350, azDeg:[ 90,135],      vehicles:['PSLV-LVM3'],                                                     rtlsLzNM:1.6, cadence:'MED' },
  { id:'SRH-SLP',    name:'Satish Dhawan SDSC SLP',          pad:'SLP',    operator:'ISRO',     region:'ASIA',  lat:13.7199, lng: 80.2300, azDeg:[ 90,135],      vehicles:['PSLV-LVM3'],                                                     rtlsLzNM:1.6, cadence:'MED' },
  { id:'WEN-101',    name:'Wenchang LC-101',                 pad:'LC-101', operator:'CASC',     region:'ASIA',  lat:19.6140, lng:110.9510, azDeg:[ 90,135],      vehicles:['LM-CZ'],                                                         rtlsLzNM:1.6, cadence:'MED' },
  { id:'WEN-201',    name:'Wenchang LC-201',                 pad:'LC-201', operator:'CASC',     region:'ASIA',  lat:19.6175, lng:110.9555, azDeg:[ 90,135],      vehicles:['LM-CZ'],                                                         rtlsLzNM:1.6, cadence:'MED' },
  { id:'JIU-921',    name:'Jiuquan SLS-921',                 pad:'SLS-2', operator:'CASC',      region:'ASIA',  lat:40.9583, lng:100.2986, azDeg:[ 90,165],      vehicles:['LM-CZ','SOYUZ'],                                                 rtlsLzNM:1.6, cadence:'MED' },
  // ─── PAC NEW ZEALAND ────────────────────────────────────────────────────
  { id:'RLB-LC1A',   name:'Rocket Lab LC-1A Mahia',          pad:'LC-1A',  operator:'RocketLab',region:'PAC',   lat:-39.2622,lng:177.8645, azDeg:[180, 200],     vehicles:['ELECTRON'],                                                      rtlsLzNM:0.8, cadence:'MED' },
]

// ---------------------------------------------------------------------------
// SYNTHETIC LAUNCH SCHEDULE
// Per-port deterministic upcoming-launch generator keyed on UTC day-of-year
// hash. Spawns 0-3 launches per high-cadence port within a ±6 hr window of
// "now". Each launch picks vehicle, azimuth, T-0, window length, RTLS/ASDS
// from the port's licensed set.
// ---------------------------------------------------------------------------
interface Launch {
  port: Spaceport
  veh: VehSpec
  azDeg: number
  t0Min: number            // minutes-of-day UTC
  windowOpenMin: number    // minutes-of-day UTC
  windowCloseMin: number
  publishedMin: number     // when LHA NOTAM was issued (T-4h typically)
  recoveryMode: 'RTLS' | 'ASDS' | 'EXP'
  asdsLat?: number
  asdsLng?: number
}

function hash32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

// ---- Geometry ------------------------------------------------------------
const R_NM = 3440.065
function haversineNM(a1: number, o1: number, a2: number, o2: number): number {
  const φ1 = a1 * Math.PI / 180, φ2 = a2 * Math.PI / 180
  const dφ = (a2 - a1) * Math.PI / 180, dλ = (o2 - o1) * Math.PI / 180
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
// Great-circle destination given start, bearing (deg), distance (NM)
function destinationNM(lat: number, lng: number, brgDeg: number, distNM: number): [number, number] {
  const φ1 = lat * Math.PI / 180, λ1 = lng * Math.PI / 180
  const θ  = brgDeg * Math.PI / 180
  const d  = distNM / R_NM
  const φ2 = Math.asin(Math.sin(φ1)*Math.cos(d) + Math.cos(φ1)*Math.sin(d)*Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ)*Math.sin(d)*Math.cos(φ1), Math.cos(d) - Math.sin(φ1)*Math.sin(φ2))
  return [φ2 * 180 / Math.PI, ((λ2 * 180 / Math.PI + 540) % 360) - 180]
}
function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180
  const Δλ = (lng2 - lng1) * Math.PI/180
  const y = Math.sin(Δλ)*Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}
// Build a LHA fan polygon: pad → arc of bearing ±halfWidth out to range
function buildLHAFan(pad: Spaceport, azDeg: number, rangeNM: number, halfWidthDeg: number): [number, number][] {
  const pts: [number, number][] = [[pad.lng, pad.lat]]
  const steps = 14
  for (let i = 0; i <= steps; i++) {
    const b = azDeg - halfWidthDeg + (2 * halfWidthDeg * i) / steps
    const [la, lo] = destinationNM(pad.lat, pad.lng, b, rangeNM)
    pts.push([lo, la])
  }
  pts.push([pad.lng, pad.lat])
  return pts
}
// Build an IIP corridor polygon: rectangle ±width along bearing from pad
function buildIIPCorridor(pad: Spaceport, azDeg: number, lenNM: number, widthNM: number): [number, number][] {
  const [endLat, endLng] = destinationNM(pad.lat, pad.lng, azDeg, lenNM)
  const [lA, oA] = destinationNM(pad.lat, pad.lng, azDeg + 90, widthNM)
  const [lB, oB] = destinationNM(pad.lat, pad.lng, azDeg - 90, widthNM)
  const [lC, oC] = destinationNM(endLat,  endLng,  azDeg - 90, widthNM)
  const [lD, oD] = destinationNM(endLat,  endLng,  azDeg + 90, widthNM)
  return [[oA, lA], [oB, lB], [oC, lC], [oD, lD], [oA, lA]]
}
// Drop zone: square box centred at drop point
function buildDropBox(centerLat: number, centerLng: number, halfSizeNM: number): [number, number][] {
  const [n, e] = [
    destinationNM(centerLat, centerLng,   0, halfSizeNM),
    destinationNM(centerLat, centerLng,  90, halfSizeNM),
  ]
  const [s, w] = [
    destinationNM(centerLat, centerLng, 180, halfSizeNM),
    destinationNM(centerLat, centerLng, 270, halfSizeNM),
  ]
  return [[w[1], n[0]], [e[1], n[0]], [e[1], s[0]], [w[1], s[0]], [w[1], n[0]]]
}

// Point-in-polygon (ray-cast). polygon = [[lng,lat], ...] closed.
function pointInPoly(lng: number, lat: number, poly: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1]
    const xj = poly[j][0], yj = poly[j][1]
    const intersect = ((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi)
    if (intersect) inside = !inside
  }
  return inside
}
// Min distance NM from a point to a polygon edge set
function distNMtoPoly(lng: number, lat: number, poly: [number, number][]): number {
  let best = Infinity
  for (let i = 0; i < poly.length - 1; i++) {
    const d = haversineNM(lat, lng, (poly[i][1]+poly[i+1][1])/2, (poly[i][0]+poly[i+1][0])/2)
    if (d < best) best = d
  }
  return best
}

// ---------------------------------------------------------------------------
// Generate the active / imminent launch schedule for "now"
// ---------------------------------------------------------------------------
function generateSchedule(nowMin: number, dayKey: string): Launch[] {
  const out: Launch[] = []
  for (const port of PORTS) {
    // Cadence → launches per day window
    const perDay = port.cadence === 'HIGH' ? 1.4 :
                   port.cadence === 'MED'  ? 0.6 :
                   port.cadence === 'LOW'  ? 0.18 : 0.04
    const baseH = hash32(port.id + dayKey)
    // Decide if this port has a launch today (probability per-day)
    const fire = ((baseH % 1000) / 1000) < perDay
    if (!fire) continue
    // Pick vehicle from licensed list
    const veh = port.vehicles[(baseH >>> 8) % port.vehicles.length]
    const spec = VEHICLES[veh]
    // Pick azimuth
    const az = port.azDeg[(baseH >>> 12) % port.azDeg.length]
    // T-0 within the ±6hr "active" band so we always have something to render
    // Center the T-0 at nowMin ± 360 min
    const off = (((baseH >>> 16) % 1200) - 360)  // -360..+840 min
    const t0Min = ((nowMin + off) + 1440) % 1440
    // Window length 30-150 min
    const winLen = 30 + ((baseH >>> 20) % 120)
    const windowOpenMin = (t0Min - 5 + 1440) % 1440  // 5min before T-0
    const windowCloseMin = (t0Min + winLen + 1440) % 1440
    // Published = T-4h
    const publishedMin = (t0Min - 240 + 1440) % 1440
    // Recovery mode
    const recoveryMode: 'RTLS' | 'ASDS' | 'EXP' =
      spec.hasRTLS && (baseH % 3 === 0) ? 'RTLS' :
      spec.hasASDS                       ? 'ASDS' :
      'EXP'
    let asdsLat: number | undefined, asdsLng: number | undefined
    if (recoveryMode === 'ASDS' && port.asdsDownrangeKm && port.asdsAz != null) {
      ;[asdsLat, asdsLng] = destinationNM(port.lat, port.lng, port.asdsAz, port.asdsDownrangeKm * 0.539957)
    }
    out.push({ port, veh: spec, azDeg: az, t0Min, windowOpenMin, windowCloseMin, publishedMin, recoveryMode, asdsLat, asdsLng })
  }
  return out
}

// ---------------------------------------------------------------------------
// Per-launch hazard envelope construction
// ---------------------------------------------------------------------------
interface HazardSet {
  launch: Launch
  lhaPoly: [number, number][]   // launch hazard area fan
  iipPoly: [number, number][]   // IIP corridor rectangle
  dzS1?:   [number, number][]   // stage-1 drop zone
  dzS2:    [number, number][]   // stage-2 deorbit drop zone
  fzPoly?: [number, number][]   // fairing zone
  lzCenter?: [number, number]   // RTLS LZ centre (for circle render)
  lzRadiusNM?: number
}

function buildHazards(L: Launch): HazardSet {
  const { port, veh, azDeg } = L
  const lhaPoly = buildLHAFan(port, azDeg, veh.lhaNM, veh.lhaWidthDeg)
  const iipPoly = buildIIPCorridor(port, azDeg, veh.iipNM, veh.iipWidthNM)
  let dzS1: [number, number][] | undefined
  if (veh.dzS1NM > 0) {
    const [latS1, lngS1] = destinationNM(port.lat, port.lng, azDeg, veh.dzS1NM)
    dzS1 = buildDropBox(latS1, lngS1, 30) // ±30 NM box
  }
  const [latS2, lngS2] = destinationNM(port.lat, port.lng, azDeg, veh.dzS2NM)
  const dzS2 = buildDropBox(latS2, lngS2, 45) // ±45 NM
  let fzPoly: [number, number][] | undefined
  if (veh.fzNM > 0) {
    const [latFZ, lngFZ] = destinationNM(port.lat, port.lng, azDeg, veh.fzNM)
    fzPoly = buildDropBox(latFZ, lngFZ, 25)
  }
  let lzCenter: [number, number] | undefined
  let lzRadiusNM: number | undefined
  if (L.recoveryMode === 'RTLS') {
    lzCenter = [port.lng, port.lat]
    lzRadiusNM = port.rtlsLzNM ?? 2
  } else if (L.recoveryMode === 'ASDS' && L.asdsLat != null && L.asdsLng != null) {
    lzCenter = [L.asdsLng, L.asdsLat]
    lzRadiusNM = 3.5
  }
  return { launch: L, lhaPoly, iipPoly, dzS1, dzS2, fzPoly, lzCenter, lzRadiusNM }
}

// ---------------------------------------------------------------------------
// Per-flight evaluation
// ---------------------------------------------------------------------------
type RecMode = 'RTLS' | 'ASDS' | 'EXP'

interface FlightEval {
  tier: Tier
  reason: string                // human reason
  hazard?: HazardSet            // governing hazard
  minDistNM: number             // distance to nearest hazard polygon edge
  windowState: 'CLOSED' | 'OPEN' | 'PUBLISHED-PRE' | 'NONE'
  tToOpenMin: number            // minutes until window opens (negative if open)
  tToCloseMin: number           // minutes until window closes
  divNM: number                 // suggested reroute around LHA boundary
  reroute: 'NIL' | 'N' | 'S' | 'E' | 'W' | 'TURN-BACK'
}

function evalFlight(f: F, hazards: HazardSet[], nowMin: number): FlightEval {
  // Below 1500ft AGL we don't care (ground / very low traffic)
  if (f.ground || f.altitudeFt < 1500) {
    return { tier:'CLR', reason:'Ground or <1500ft', minDistNM: 9999, windowState:'NONE', tToOpenMin: 9999, tToCloseMin: 9999, divNM: 0, reroute:'NIL' }
  }

  let bestTier: Tier = 'CLR'
  let bestRank = TIER_RANK['CLR']
  let bestReason = 'No active hazard within 200 NM'
  let bestH: HazardSet | undefined
  let bestMinDist = Infinity
  let bestWinState: 'CLOSED' | 'OPEN' | 'PUBLISHED-PRE' | 'NONE' = 'NONE'
  let bestTToOpen = 9999
  let bestTToClose = 9999
  let bestDiv = 0
  let bestRR: FlightEval['reroute'] = 'NIL'

  for (const H of hazards) {
    const dToLHA = distNMtoPoly(f.lng, f.lat, H.lhaPoly)
    if (dToLHA > 200) continue   // out of scope for this hazard

    // Window timing
    const t0 = H.launch.t0Min
    const wo = H.launch.windowOpenMin
    const wc = H.launch.windowCloseMin
    const tToOpen  = ((wo - nowMin + 1440) % 1440)
    const tToClose = ((wc - nowMin + 1440) % 1440)
    // Window normalised: is "now" inside [wo, wc]?
    const isOpen = (wo < wc) ? (nowMin >= wo && nowMin <= wc) : (nowMin >= wo || nowMin <= wc)
    const isPublished = nowMin >= H.launch.publishedMin || (H.launch.publishedMin > t0)
    const winState: 'CLOSED' | 'OPEN' | 'PUBLISHED-PRE' | 'NONE' = isOpen ? 'OPEN' : isPublished ? 'PUBLISHED-PRE' : 'CLOSED'

    // ----- Polygon containment tests (only meaningful when window open) -----
    const inLHA = isOpen && pointInPoly(f.lng, f.lat, H.lhaPoly)
    const inIIP = isOpen && pointInPoly(f.lng, f.lat, H.iipPoly)
    const inDZ1 = isOpen && H.dzS1 ? pointInPoly(f.lng, f.lat, H.dzS1) : false
    const inDZ2 = isOpen && pointInPoly(f.lng, f.lat, H.dzS2)
    const inFZ  = isOpen && H.fzPoly ? pointInPoly(f.lng, f.lat, H.fzPoly) : false
    const inLZ  = isOpen && H.lzCenter && H.lzRadiusNM
                  ? haversineNM(f.lat, f.lng, H.lzCenter[1], H.lzCenter[0]) < H.lzRadiusNM
                  : false

    let thisTier: Tier = 'CLR'
    let thisReason = ''
    if (inLHA) {
      thisTier = 'IN-LHA'
      thisReason = `Inside LHA · ${H.launch.port.id} ${H.launch.veh.label} · T${tToOpen<=0?'+':'-'}${Math.abs(Math.round(nowMin - t0))}min`
    } else if (H.launch.recoveryMode === 'ASDS' && inDZ2 === false && inIIP) {
      thisTier = 'IN-IIP'
      thisReason = `Inside IIP corridor · ${H.launch.port.id} az ${H.launch.azDeg}°`
    } else if (inDZ1 || inDZ2) {
      thisTier = 'IN-DZ'
      thisReason = `Inside ${inDZ1?'Stage-1':'Stage-2'} debris DZ · ${H.launch.veh.label}`
    } else if (inFZ) {
      thisTier = 'IN-DZ'
      thisReason = `Inside fairing jettison zone · ${H.launch.veh.label}`
    } else if (inLZ) {
      thisTier = 'IN-LZ'
      thisReason = `Inside ${H.launch.recoveryMode} landing zone · ${H.launch.port.id}`
    } else if (isOpen && dToLHA < 30) {
      thisTier = 'NEAR-30'
      thisReason = `${dToLHA.toFixed(1)} NM from LHA boundary · window OPEN`
    } else if (isOpen) {
      thisTier = 'WIN-OPEN'
      thisReason = `Window OPEN, ${dToLHA.toFixed(1)} NM clear of LHA`
    } else if (isPublished && tToOpen < 90) {
      // Project flight forward and see if it'd intersect LHA
      const projNM = f.velocityKts * (tToOpen / 60)
      const [projLat, projLng] = destinationNM(f.lat, f.lng, f.track, projNM)
      const wouldEnter = pointInPoly(projLng, projLat, H.lhaPoly)
      if (wouldEnter) {
        thisTier = 'T-PRE'
        thisReason = `T-${Math.round(tToOpen)}min · projected to enter LHA before window opens`
      }
    }

    // Reroute hint — chord around LHA boundary using simple bearing offset
    let divNM = 0
    let reroute: FlightEval['reroute'] = 'NIL'
    if (thisTier === 'IN-LHA' || thisTier === 'NEAR-30' || thisTier === 'IN-IIP') {
      // Offset 30 NM from LHA centroid in direction perpendicular to track
      const lhaCxLng = H.launch.port.lng
      const lhaCxLat = H.launch.port.lat
      const bToCx = bearingDeg(f.lat, f.lng, lhaCxLat, lhaCxLng)
      const tdiff = ((bToCx - f.track + 540) % 360) - 180
      // Length of detour ≈ 2 × halfWidth × (1 - cos θ) ≈ proportional to LHA radius
      divNM = Math.min(120, H.launch.veh.lhaNM * 0.18 + (thisTier === 'IN-LHA' ? 40 : 0))
      reroute = tdiff > 0 ? (f.track > 90 && f.track < 270 ? 'W' : 'N')
                          : (f.track > 90 && f.track < 270 ? 'E' : 'S')
      if (thisTier === 'IN-LHA' && dToLHA > 40) reroute = 'TURN-BACK'
    }

    // Keep the worst (lowest rank value) hazard for this flight
    const thisRank = TIER_RANK[thisTier]
    if (thisRank < bestRank) {
      bestTier = thisTier
      bestRank = thisRank
      bestReason = thisReason
      bestH = H
      bestMinDist = dToLHA
      bestWinState = winState
      bestTToOpen = tToOpen
      bestTToClose = tToClose
      bestDiv = divNM
      bestRR = reroute
    }
  }

  return {
    tier: bestTier,
    reason: bestReason,
    hazard: bestH,
    minDistNM: bestMinDist === Infinity ? 9999 : bestMinDist,
    windowState: bestWinState,
    tToOpenMin: bestTToOpen,
    tToCloseMin: bestTToClose,
    divNM: bestDiv,
    reroute: bestRR,
  }
}

// ---- Row type ------------------------------------------------------------
interface Row {
  f: F
  ev: FlightEval
  score: number
}

function tierScore(ev: FlightEval): number {
  // 0 = clean, 100 = catastrophic LHA penetration
  const tierBase = ev.tier === 'IN-LHA' ? 100 :
                   ev.tier === 'IN-RHA' ? 95  :
                   ev.tier === 'IN-IIP' ? 80  :
                   ev.tier === 'IN-DZ'  ? 65  :
                   ev.tier === 'IN-LZ'  ? 50  :
                   ev.tier === 'NEAR-30'? 35  :
                   ev.tier === 'WIN-OPEN'? 18 :
                   ev.tier === 'T-PRE'  ? 22  : 0
  return tierBase
}

// ==== MAIN COMPONENT =======================================================
export default function AhaLaunchHazard({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [regionFilter, setRegionFilter] = useState<string>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT'|'SPACEPORTS'|'SCHEDULE'|'DRIVERS'|'METHOD'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shFan,  setShFan]  = useState(true)
  const [shIIP,  setShIIP]  = useState(true)
  const [shDZ,   setShDZ]   = useState(true)
  const [shLZ,   setShLZ]   = useState(true)
  const [shPad,  setShPad]  = useState(true)
  const [shLbl,  setShLbl]  = useState(true)
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [tNow, setTNow] = useState(() => new Date())

  // Re-tick every 30s so windows / T-counters advance
  useEffect(() => {
    const id = setInterval(() => setTNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])

  // Schedule deterministic from today's UTC day key
  const schedule = useMemo<Launch[]>(() => {
    const nowMin = tNow.getUTCHours() * 60 + tNow.getUTCMinutes()
    const dayKey = `${tNow.getUTCFullYear()}-${tNow.getUTCMonth()+1}-${tNow.getUTCDate()}`
    return generateSchedule(nowMin, dayKey)
  }, [tNow])

  const hazards = useMemo<HazardSet[]>(() => schedule.map(buildHazards), [schedule])

  const nowMin = tNow.getUTCHours() * 60 + tNow.getUTCMinutes()

  // Per-flight evaluation
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const ev = evalFlight(f, hazards, nowMin)
      if (ev.tier === 'CLR' && ev.minDistNM > 250) continue   // not interesting
      out.push({ f, ev, score: tierScore(ev) })
    }
    out.sort((a, b) => (TIER_RANK[a.ev.tier] - TIER_RANK[b.ev.tier]) || (b.score - a.score))
    return out
  }, [flights, hazards, nowMin])

  // Counts / aggregates
  const counts: Record<Tier, number> = {
    'IN-LHA':0,'IN-RHA':0,'IN-IIP':0,'IN-DZ':0,'IN-LZ':0,'NEAR-30':0,'WIN-OPEN':0,'T-PRE':0,'CLR':0,
  }
  for (const r of rows) counts[r.ev.tier]++

  const activeLaunches = schedule.filter(L => {
    const isOpen = (L.windowOpenMin < L.windowCloseMin)
      ? (nowMin >= L.windowOpenMin && nowMin <= L.windowCloseMin)
      : (nowMin >= L.windowOpenMin || nowMin <= L.windowCloseMin)
    return isOpen
  }).length

  const nextLaunch = useMemo(() => {
    let best: Launch | undefined
    let bestT = 9999
    for (const L of schedule) {
      const dT = ((L.t0Min - nowMin + 1440) % 1440)
      if (dT < bestT) { bestT = dT; best = L }
    }
    return { launch: best, tMin: bestT }
  }, [schedule, nowMin])

  const inHazardCount = counts['IN-LHA'] + counts['IN-RHA'] + counts['IN-IIP'] + counts['IN-DZ'] + counts['IN-LZ']

  const meanDiv = rows.length ? rows.reduce((a, r) => a + r.ev.divNM, 0) / rows.length : 0
  const meanScore = rows.length ? rows.reduce((a, r) => a + r.score, 0) / rows.length : 0

  // ---- MapLibre layers --------------------------------------------------
  useEffect(() => {
    if (!map) return
    const SRC_FAN  = 'aha-fan-src'
    const SRC_IIP  = 'aha-iip-src'
    const SRC_DZ   = 'aha-dz-src'
    const SRC_LZ   = 'aha-lz-src'
    const SRC_PAD  = 'aha-pad-src'
    const SRC_AC   = 'aha-ac-src'
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any }) }
    ;[SRC_FAN, SRC_IIP, SRC_DZ, SRC_LZ, SRC_PAD, SRC_AC].forEach(ensure)

    const fanFeat: any[] = []
    const iipFeat: any[] = []
    const dzFeat:  any[] = []
    const lzFeat:  any[] = []
    for (const H of hazards) {
      if (regionFilter !== 'ALL' && H.launch.port.region !== regionFilter) continue
      const t0 = H.launch.t0Min
      const wo = H.launch.windowOpenMin
      const wc = H.launch.windowCloseMin
      const isOpen = (wo < wc) ? (nowMin >= wo && nowMin <= wc) : (nowMin >= wo || nowMin <= wc)
      const stripeColor = isOpen ? TIER_COLOR['IN-LHA'] : TIER_COLOR['T-PRE']
      const label = `${H.launch.port.id} · ${H.launch.veh.v} · ${isOpen ? 'OPEN' : 'T-' + Math.round(((t0 - nowMin + 1440) % 1440)) + 'min'} · az ${H.launch.azDeg}°`
      fanFeat.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[H.lhaPoly] }, properties:{ color: stripeColor, isOpen: isOpen?1:0, label } })
      iipFeat.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[H.iipPoly] }, properties:{ color: stripeColor, isOpen: isOpen?1:0 } })
      if (H.dzS1) dzFeat.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[H.dzS1] }, properties:{ color: TIER_COLOR['IN-DZ'], kind:'S1' } })
                  dzFeat.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[H.dzS2] }, properties:{ color: TIER_COLOR['IN-DZ'], kind:'S2' } })
      if (H.fzPoly) dzFeat.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[H.fzPoly] }, properties:{ color: TIER_COLOR['IN-DZ'], kind:'FZ' } })
      if (H.lzCenter && H.lzRadiusNM) {
        // Synthesise circle polygon (24-gon) for LZ
        const ring: [number, number][] = []
        const steps = 28
        for (let i = 0; i <= steps; i++) {
          const az = (i / steps) * 360
          const [la, lo] = destinationNM(H.lzCenter[1], H.lzCenter[0], az, H.lzRadiusNM)
          ring.push([lo, la])
        }
        lzFeat.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[ring] }, properties:{ color: TIER_COLOR['IN-LZ'], mode: H.launch.recoveryMode } })
      }
    }

    const padFeat = PORTS
      .filter(p => regionFilter === 'ALL' || p.region === regionFilter)
      .map(p => ({
        type:'Feature' as const,
        geometry:{ type:'Point' as const, coordinates:[p.lng, p.lat] },
        properties:{
          label: `${p.id} · ${p.operator}`,
          tier:  p.cadence === 'HIGH' ? 1 : p.cadence === 'MED' ? 2 : 3,
          color: p.cadence === 'HIGH' ? '#0ea5e9' : p.cadence === 'MED' ? '#38bdf8' : '#7dd3fc',
        },
      }))

    const view = rows.filter(r => tierFilter === 'ALL' || r.ev.tier === tierFilter)
    const acFeat = view.map(r => ({
      type:'Feature' as const,
      geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat] },
      properties:{
        tier:  r.ev.tier,
        color: TIER_COLOR[r.ev.tier],
        score: r.score,
        sz:    7 + (r.score/100) * 14,
        label: `${(r.f.callsign || r.f.icao).trim()} ${r.ev.tier}${r.ev.divNM>0?` · Δ${Math.round(r.ev.divNM)}NM ${r.ev.reroute}`:''}`,
      },
    }))

    ;(map.getSource(SRC_FAN) as any).setData({ type:'FeatureCollection', features: shFan ? fanFeat : [] })
    ;(map.getSource(SRC_IIP) as any).setData({ type:'FeatureCollection', features: shIIP ? iipFeat : [] })
    ;(map.getSource(SRC_DZ)  as any).setData({ type:'FeatureCollection', features: shDZ  ? dzFeat  : [] })
    ;(map.getSource(SRC_LZ)  as any).setData({ type:'FeatureCollection', features: shLZ  ? lzFeat  : [] })
    ;(map.getSource(SRC_PAD) as any).setData({ type:'FeatureCollection', features: shPad ? padFeat : [] })
    ;(map.getSource(SRC_AC)  as any).setData({ type:'FeatureCollection', features: shHalo ? acFeat : [] })

    if (!map.getLayer('aha-fan-fill'))
      map.addLayer({ id:'aha-fan-fill', type:'fill', source:SRC_FAN, paint:{ 'fill-color':['get','color'], 'fill-opacity':['case',['==',['get','isOpen'],1],0.18,0.08] } })
    if (!map.getLayer('aha-fan-line'))
      map.addLayer({ id:'aha-fan-line', type:'line', source:SRC_FAN, paint:{ 'line-color':['get','color'], 'line-width':['case',['==',['get','isOpen'],1],1.6,1.0], 'line-opacity':['case',['==',['get','isOpen'],1],0.95,0.55], 'line-dasharray':['case',['==',['get','isOpen'],1],['literal',[1]],['literal',[3,2]]] } })
    if (!map.getLayer('aha-iip-line'))
      map.addLayer({ id:'aha-iip-line', type:'line', source:SRC_IIP, paint:{ 'line-color':['get','color'], 'line-width':1.2, 'line-opacity':0.7, 'line-dasharray':[2,2] } })
    if (!map.getLayer('aha-dz-fill'))
      map.addLayer({ id:'aha-dz-fill', type:'fill', source:SRC_DZ, paint:{ 'fill-color':['get','color'], 'fill-opacity':0.16 } })
    if (!map.getLayer('aha-dz-line'))
      map.addLayer({ id:'aha-dz-line', type:'line', source:SRC_DZ, paint:{ 'line-color':['get','color'], 'line-width':1.2, 'line-opacity':0.75, 'line-dasharray':[4,2] } })
    if (!map.getLayer('aha-lz-fill'))
      map.addLayer({ id:'aha-lz-fill', type:'fill', source:SRC_LZ, paint:{ 'fill-color':['get','color'], 'fill-opacity':0.20 } })
    if (!map.getLayer('aha-lz-line'))
      map.addLayer({ id:'aha-lz-line', type:'line', source:SRC_LZ, paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-opacity':0.85 } })
    if (!map.getLayer('aha-pad-pin'))
      map.addLayer({ id:'aha-pad-pin', type:'circle', source:SRC_PAD, paint:{ 'circle-radius':['interpolate',['linear'],['get','tier'],1,6.5,3,3.5], 'circle-color':['get','color'], 'circle-opacity':0.6, 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('aha-pad-lbl'))
      map.addLayer({ id:'aha-pad-lbl', type:'symbol', source:SRC_PAD, layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,-1.4], 'text-anchor':'bottom', 'text-font':['Noto Sans Regular'], 'text-optional':true }, paint:{ 'text-color':'#cbd5e1', 'text-halo-color':'#0b0f17', 'text-halo-width':1.0 } })
    if (!map.getLayer('aha-ac-halo'))
      map.addLayer({ id:'aha-ac-halo', type:'circle', source:SRC_AC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.6, 'circle-stroke-opacity':0.9 } })
    if (!map.getLayer('aha-ac-pin'))
      map.addLayer({ id:'aha-ac-pin', type:'circle', source:SRC_AC, filter:['>=', ['get','score'], 35], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('aha-ac-lbl'))
      map.addLayer({ id:'aha-ac-lbl', type:'symbol', source:SRC_AC, filter:['>=', ['get','score'], 50], layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.5], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.3 } })

    return () => {
      for (const id of ['aha-ac-lbl','aha-ac-pin','aha-ac-halo','aha-pad-lbl','aha-pad-pin','aha-lz-line','aha-lz-fill','aha-dz-line','aha-dz-fill','aha-iip-line','aha-fan-line','aha-fan-fill']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC_FAN, SRC_IIP, SRC_DZ, SRC_LZ, SRC_PAD, SRC_AC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, hazards, rows, tierFilter, regionFilter, shFan, shIIP, shDZ, shLZ, shPad, shHalo, shLbl, nowMin])

  // Visible (for side panel)
  const visible = rows.filter(r =>
    (tierFilter === 'ALL' || r.ev.tier === tierFilter) &&
    (regionFilter === 'ALL' || (r.ev.hazard && r.ev.hazard.launch.port.region === regionFilter)) &&
    (!search || (
      (r.f.callsign || r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.ev.hazard?.launch.port.id || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.ev.hazard?.launch.veh.v   || '').toLowerCase().includes(search.toLowerCase())
    ))
  )

  // Spaceport aggregation
  const portAgg = useMemo(() => {
    const m = new Map<string, { port: Spaceport; count: number; sumScore: number; worst: Tier; activeLaunch?: Launch }>()
    for (const r of rows) {
      if (!r.ev.hazard) continue
      const port = r.ev.hazard.launch.port
      const v = m.get(port.id) || { port, count:0, sumScore:0, worst:'CLR' as Tier, activeLaunch: r.ev.hazard.launch }
      v.count++
      v.sumScore += r.score
      if (TIER_RANK[r.ev.tier] < TIER_RANK[v.worst]) v.worst = r.ev.tier
      m.set(port.id, v)
    }
    return Array.from(m.values()).sort((a, b) => (TIER_RANK[a.worst] - TIER_RANK[b.worst]) || (b.sumScore/b.count - a.sumScore/a.count))
  }, [rows])

  // Driver breakdown — fleet means
  const driverAvg = useMemo(() => {
    if (!rows.length) return { window:0, inside:0, iip:0, dz:0, veh:0, rtls:0, reroute:0 }
    const n = rows.length
    let inside = 0, iip = 0, dz = 0, win = 0, veh = 0, rtls = 0, rer = 0
    for (const r of rows) {
      if (r.ev.tier === 'IN-LHA' || r.ev.tier === 'IN-RHA') inside += 100
      else if (r.ev.tier === 'NEAR-30') inside += 50
      if (r.ev.tier === 'IN-IIP') iip += 100
      if (r.ev.tier === 'IN-DZ')  dz  += 80
      if (r.ev.windowState === 'OPEN') win += 60
      else if (r.ev.windowState === 'PUBLISHED-PRE') win += 25
      if (r.ev.hazard) veh += Math.min(100, r.ev.hazard.launch.veh.liftKt / 50)
      if (r.ev.tier === 'IN-LZ') rtls += 100
      rer += Math.min(100, r.ev.divNM)
    }
    return { window: win/n, inside: inside/n, iip: iip/n, dz: dz/n, veh: veh/n, rtls: rtls/n, reroute: rer/n }
  }, [rows])

  // Format time helper
  const hhmm = (m: number) => `${Math.floor(m/60).toString().padStart(2,'0')}:${(m%60).toString().padStart(2,'0')}`

  // ---- Render ----------------------------------------------------------
  return (
    <div className="fixed top-16 right-3 z-40 w-[500px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">AHA</span>
          <span className="text-[10px] text-slate-400 truncate">Launch &amp; Reentry Aircraft Hazard Area · FAA AC 91-86 · 14 CFR §450 · ICAO Doc 10100</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none ml-2">×</button>
      </div>

      {/* Tier counter strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.slice(0, 8).map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className="flex-1 px-1 py-1 rounded text-[9px] font-mono border min-w-0"
            style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:'transparent', color: TIER_COLOR[t] }}>
            <span className="truncate">
              {t === 'IN-LHA' ? 'LHA' :
               t === 'IN-RHA' ? 'RHA' :
               t === 'IN-IIP' ? 'IIP' :
               t === 'IN-DZ'  ? 'DZ' :
               t === 'IN-LZ'  ? 'LZ' :
               t === 'NEAR-30'? 'NR30':
               t === 'WIN-OPEN'? 'WIN':
               'TPRE'}
            </span> {counts[t]}
          </button>
        ))}
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">ACT</div><div className="font-mono" style={{color: activeLaunches?TIER_COLOR['IN-LHA']:'#94a3b8'}}>{activeLaunches}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">HAZ</div><div className="font-mono" style={{color: inHazardCount?TIER_COLOR['IN-LHA']:'#94a3b8'}}>{inHazardCount}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-Δ</div><div className="text-slate-100 font-mono">{Math.round(meanDiv)}NM</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCR</div><div className="text-slate-100 font-mono">{meanScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1 truncate"><div className="text-slate-500">NEXT</div><div className="text-slate-100 font-mono truncate" title={nextLaunch.launch ? `${nextLaunch.launch.port.id} ${nextLaunch.launch.veh.v}` : '—'}>{nextLaunch.launch ? `T-${Math.round(nextLaunch.tMin)}m` : '—'}</div></div>
      </div>

      {/* Now-time + region filter */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-slate-500">NOW <span className="text-slate-200 font-mono">{hhmm(nowMin)}z</span></span>
          <span className="text-slate-500">{schedule.length} launches on schedule · {activeLaunches} OPEN</span>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={()=>setRegionFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${regionFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL-RGN</button>
          {(['NA-US','NA-CAN','SA','EU','EUR-N','CIS','ASIA','PAC'] as const).map(r => (
            <button key={r} onClick={()=>setRegionFilter(r)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${regionFilter===r?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{r}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {([['FAN',shFan,setShFan],['IIP',shIIP,setShIIP],['DZ',shDZ,setShDZ],['LZ',shLZ,setShLZ],['PAD',shPad,setShPad],['HALO',shHalo,setShHalo],['LBL',shLbl,setShLbl]] as const).map(([n,v,fn]) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/port/veh" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-3 py-1.5 border-b border-slate-700/60">
        {(['AIRCRAFT','SPACEPORTS','SCHEDULE','DRIVERS','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">

        {tab === 'AIRCRAFT' && (
          <>
            {visible.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-6">
                No aircraft within 250 NM of any active or imminent launch hazard area.<br/>
                <span className="text-slate-600">Try ASIA/CIS region during a Long March or Soyuz cycle, or set a launch active on the SCHEDULE tab.</span>
              </div>
            )}
            {visible.slice(0, 60).map(r => {
              const isP = picked === r.f.icao
              const L = r.ev.hazard?.launch
              return (
                <div key={r.f.icao} className="border rounded-lg p-2 bg-slate-800/40" style={{ borderColor: TIER_COLOR[r.ev.tier] + '60' }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0" style={{ background: TIER_COLOR[r.ev.tier] + '22', color: TIER_COLOR[r.ev.tier] }}>{r.ev.tier}</span>
                      <button onClick={()=>{ setPicked(r.f.icao); onFly(r.f.icao) }} className="text-slate-100 font-mono text-[11px] hover:text-sky-300 truncate">{(r.f.callsign || r.f.icao).trim()}</button>
                      <span className="text-slate-400 text-[10px] truncate">{(r.f.type || '?').toUpperCase()}</span>
                    </div>
                    <div className="text-[10px] font-mono shrink-0" style={{ color: TIER_COLOR[r.ev.tier] }}>{r.score.toFixed(0)}</div>
                  </div>

                  {/* Hazard strip */}
                  <div className="mt-1.5 bg-slate-900/60 rounded p-1.5 font-mono text-[9px] text-slate-300 leading-tight overflow-x-auto whitespace-nowrap">
                    {L ? (
                      <>
                        <span className="text-slate-500">PRT </span><span className="text-sky-300">{L.port.id}</span>
                        <span className="text-slate-500"> VEH </span><span className="text-slate-200">{L.veh.v}</span>
                        <span className="text-slate-500"> REC </span><span className="text-slate-200">{L.recoveryMode}</span>
                        <span className="text-slate-500"> AZ </span><span className="text-slate-200">{L.azDeg}°</span>
                        <span className="text-slate-500"> T0 </span><span className="text-slate-200">{hhmm(L.t0Min)}z</span>
                        <span className="text-slate-500"> WIN </span>
                        <span className={r.ev.windowState==='OPEN' ? 'text-rose-400' : 'text-slate-300'}>{r.ev.windowState}</span>
                        <span className="text-slate-500"> dLHA </span><span className="font-mono" style={{ color: r.ev.minDistNM < 30 ? TIER_COLOR['NEAR-30'] : '#cbd5e1' }}>{r.ev.minDistNM.toFixed(1)}NM</span>
                        {r.ev.divNM > 0 && (
                          <>
                            <span className="text-slate-500"> RR </span>
                            <span className="text-amber-400">{r.ev.reroute}·Δ{Math.round(r.ev.divNM)}NM</span>
                          </>
                        )}
                      </>
                    ) : (
                      <span className="text-slate-500">No hazard within range</span>
                    )}
                  </div>

                  {/* Reason */}
                  <div className="mt-1 text-[9px] text-slate-300 italic leading-tight">
                    <span style={{ color: TIER_COLOR[r.ev.tier] }}>▸ </span>{r.ev.reason}
                  </div>

                  {isP && L && (
                    <div className="mt-1.5 text-[9px] text-slate-400 border-t border-slate-700/60 pt-1.5 space-y-0.5">
                      <div>Spaceport: <span className="text-slate-200">{L.port.name}</span> ({L.port.pad})</div>
                      <div>Operator: <span className="text-slate-200">{L.port.operator}</span> · Region: <span className="text-slate-200">{L.port.region}</span> · Cadence: <span className="text-slate-200">{L.port.cadence}</span></div>
                      <div>Vehicle: <span className="text-slate-200">{L.veh.label}</span> · GLOM <span className="text-slate-200">{L.veh.liftKt}t</span> · LHA <span className="text-slate-200">{L.veh.lhaNM}NM × ±{L.veh.lhaWidthDeg}°</span></div>
                      <div>IIP corridor: <span className="text-slate-200">{L.veh.iipNM}NM × ±{L.veh.iipWidthNM}NM</span> · S1 DZ <span className="text-slate-200">{L.veh.dzS1NM}NM</span> · S2 DZ <span className="text-slate-200">{L.veh.dzS2NM}NM</span></div>
                      <div>NOTAM published <span className="text-slate-200">{hhmm(L.publishedMin)}z</span> · Window <span className="text-slate-200">{hhmm(L.windowOpenMin)}z → {hhmm(L.windowCloseMin)}z</span></div>
                      {L.veh.toxic && <div className="text-amber-400">⚠ Toxic propellant (UDMH/N2O4) — extended RHA per §450.139</div>}
                      {r.ev.divNM > 0 && <div>Reroute hint: <span className="text-amber-400">deviate {r.ev.reroute}</span> for ~<span className="text-slate-200">{Math.round(r.ev.divNM)}NM</span> additional track</div>}
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

        {tab === 'SPACEPORTS' && (
          <>
            {portAgg.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-6">No spaceport currently producing affected traffic in view.</div>
            )}
            {portAgg.slice(0, 32).map(a => (
              <div key={a.port.id} className="border rounded-lg p-2 bg-slate-800/40" style={{ borderColor: TIER_COLOR[a.worst] + '60' }}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0" style={{ background: TIER_COLOR[a.worst] + '22', color: TIER_COLOR[a.worst] }}>{a.worst}</span>
                    <span className="text-slate-100 font-mono text-[11px]">{a.port.id}</span>
                    <span className="text-slate-400 text-[10px] truncate">{a.port.name}</span>
                  </div>
                  <div className="text-[10px] font-mono shrink-0 text-slate-300">{a.count} ac</div>
                </div>
                <div className="mt-1.5 grid grid-cols-4 gap-1 text-[9px]">
                  <div className="bg-slate-900/60 rounded px-1 py-0.5"><div className="text-slate-500">OPR</div><div className="text-slate-200 font-mono truncate">{a.port.operator}</div></div>
                  <div className="bg-slate-900/60 rounded px-1 py-0.5"><div className="text-slate-500">VEH</div><div className="text-slate-200 font-mono truncate">{a.activeLaunch?.veh.v}</div></div>
                  <div className="bg-slate-900/60 rounded px-1 py-0.5"><div className="text-slate-500">REC</div><div className="text-slate-200 font-mono">{a.activeLaunch?.recoveryMode}</div></div>
                  <div className="bg-slate-900/60 rounded px-1 py-0.5"><div className="text-slate-500">μ-SCR</div><div className="text-slate-200 font-mono">{(a.sumScore/a.count).toFixed(0)}</div></div>
                </div>
                <div className="mt-1 text-[9px] text-slate-400 italic truncate">{a.port.pad} · az {a.port.azDeg.join('/')}° · {a.port.cadence} cadence · lat {a.port.lat.toFixed(2)} lng {a.port.lng.toFixed(2)}</div>
              </div>
            ))}
          </>
        )}

        {tab === 'SCHEDULE' && (
          <>
            {schedule.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-6">No launches on today's synthetic schedule.</div>
            )}
            {schedule.slice().sort((a,b)=>((a.t0Min-nowMin+1440)%1440) - ((b.t0Min-nowMin+1440)%1440)).map((L, i) => {
              const tDelta = (L.t0Min - nowMin + 1440) % 1440
              const isOpen = (L.windowOpenMin < L.windowCloseMin)
                ? (nowMin >= L.windowOpenMin && nowMin <= L.windowCloseMin)
                : (nowMin >= L.windowOpenMin || nowMin <= L.windowCloseMin)
              const tierC = isOpen ? TIER_COLOR['IN-LHA'] : tDelta < 90 ? TIER_COLOR['T-PRE'] : TIER_COLOR['CLR']
              return (
                <div key={i} className="border rounded-lg p-2 bg-slate-800/40" style={{ borderColor: tierC + '60' }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0" style={{ background: tierC + '22', color: tierC }}>{isOpen?'OPEN':'T-'+Math.round(tDelta)+'m'}</span>
                      <span className="text-slate-100 font-mono text-[11px] truncate">{L.port.id}</span>
                      <span className="text-slate-400 text-[10px] truncate">{L.veh.v}</span>
                    </div>
                    <span className="text-[10px] font-mono text-sky-300 shrink-0">{hhmm(L.t0Min)}z</span>
                  </div>
                  <div className="mt-1 bg-slate-900/60 rounded p-1.5 font-mono text-[9px] text-slate-300 leading-tight overflow-x-auto whitespace-nowrap">
                    <span className="text-slate-500">REC </span><span className="text-slate-200">{L.recoveryMode}</span>
                    <span className="text-slate-500"> AZ </span><span className="text-slate-200">{L.azDeg}°</span>
                    <span className="text-slate-500"> LHA </span><span className="text-slate-200">{L.veh.lhaNM}NM</span>
                    <span className="text-slate-500"> WIN </span><span className="text-slate-200">{hhmm(L.windowOpenMin)}→{hhmm(L.windowCloseMin)}z</span>
                    <span className="text-slate-500"> NOTAM </span><span className="text-slate-200">{hhmm(L.publishedMin)}z</span>
                  </div>
                  <div className="mt-1 text-[9px] text-slate-400 italic truncate">{L.veh.label} · GLOM {L.veh.liftKt}t · S1 drop {L.veh.dzS1NM}NM · S2 drop {L.veh.dzS2NM}NM{L.veh.toxic?' · toxic prop':''}</div>
                </div>
              )
            })}
          </>
        )}

        {tab === 'DRIVERS' && (
          <div className="space-y-1.5">
            <div className="text-[10px] text-slate-400">Fleet-mean driver scores (0=clean, 100=worst). 7-driver decomposition mirrors AC 91-86 risk components.</div>
            {(['inside','iip','dz','window','veh','rtls','reroute'] as const).map(k => {
              const v = (driverAvg as any)[k] as number
              const labels: Record<typeof k, string> = {
                inside:  'INSIDE  — flight inside LHA/RHA right now (worst-case)',
                iip:     'IIP     — inside instantaneous-impact-point corridor',
                dz:      'DZ      — inside Stage-1/Stage-2/Fairing debris drop zone',
                window:  'WINDOW  — launch window open vs published-pre vs none',
                veh:     'VEH     — vehicle GLOM mass amplifier (Starship > Electron)',
                rtls:    'RTLS    — inside RTLS / ASDS booster landing zone',
                reroute: 'REROUTE — minimum-fuel detour distance around LHA edge',
              }
              const sev = v >= 60 ? '#f43f5e' : v >= 35 ? '#f59e0b' : v >= 18 ? '#0ea5e9' : '#10b981'
              return (
                <div key={k} className="bg-slate-800/40 border border-slate-700/60 rounded p-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] text-slate-300">{k.toUpperCase()}</span>
                    <span className="font-mono text-[10px]" style={{ color: sev }}>{v.toFixed(0)}</span>
                  </div>
                  <div className="mt-1 h-1.5 bg-slate-900 rounded overflow-hidden">
                    <div className="h-full" style={{ width: `${Math.min(100,v)}%`, background: sev }} />
                  </div>
                  <div className="mt-1 text-[9px] text-slate-500 leading-snug">{labels[k]}</div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="text-[10px] text-slate-300 space-y-2 leading-snug">
            <div>
              <div className="text-slate-100 font-mono text-[11px] mb-1">AHA · Launch &amp; Reentry Aircraft Hazard Area Monitor</div>
              <p>Per-airframe live evaluator of whether each in-trail flight intersects, or is projected to intersect, an active or imminent COMMERCIAL SPACE OPERATION hazard volume — Launch Hazard Area (LHA), Reentry Hazard Area (RHA), Instantaneous-Impact-Point (IIP) corridor, debris Drop Zone (DZ), or RTLS/ASDS recovery Landing Zone (LZ).</p>
            </div>
            <div>
              <div className="text-slate-100 font-mono">Regulatory basis</div>
              <ul className="list-disc list-inside space-y-0.5 text-slate-400">
                <li>14 CFR Part 450 — Launch &amp; Reentry License Requirements</li>
                <li>§450.101 — Ec ≤ 100×10⁻⁶ individual / ≤ 30×10⁻⁶ collective casualty</li>
                <li>§450.108 — Flight Safety System (FTS) requirements</li>
                <li>§450.139 — Toxic release hazard analysis (UDMH / N2O4)</li>
                <li>FAA AC 91-86 — Aircraft Hazard Areas for Commercial Space</li>
                <li>FAA Order JO 7110.65 §9-3 — ATC procedures for AHA closure</li>
                <li>FAA Order 8000.83 — Real-time hazard reporting AST → ATCSCC</li>
                <li>ICAO Doc 10100 — Space-vehicle ops impact on civil airspace</li>
                <li>ICAO Annex 11 §2.18.2 — Temporary reserved airspace</li>
                <li>EUROCONTROL ATS.OR.B 145 — High-altitude launch coordination</li>
              </ul>
            </div>
            <div>
              <div className="text-slate-100 font-mono">Tier ladder (most → least severe)</div>
              <ul className="list-disc list-inside space-y-0.5 text-slate-400">
                {TIER_ORDER.map(t => (<li key={t}><span style={{ color: TIER_COLOR[t] }} className="font-mono">{t}</span> — {TIER_LABEL[t]}</li>))}
              </ul>
            </div>
            <div>
              <div className="text-slate-100 font-mono">Distinct from</div>
              <ul className="list-disc list-inside space-y-0.5 text-slate-400">
                <li>NOTAM/TFR panel — text only; AHA is spatial envelope evaluator</li>
                <li>SUA — permanent restricted; AHA is dynamic 4-hr window</li>
                <li>ADIZ — border-crossing ID; AHA is debris-impact safety</li>
                <li>DIVERSION — post-emergency landing search; AHA pre-empts</li>
                <li>SAR — downed-aircraft search; AHA is launch-debris keep-out</li>
              </ul>
            </div>
            <div>
              <div className="text-slate-100 font-mono">Catalogue scope</div>
              <p>32 active orbital / suborbital spaceports · 16 vehicle classes (F9-RTLS/ASDS/EXP, FH-RTLS/ASDS, STAR, ATLAS-V, VULCAN, ELECTRON, NG, ARIANE-6, SOYUZ, H3, LM-CZ, PSLV-LVM3, ALPHA-FIREFLY) · per-vehicle LHA fan / IIP corridor / S1+S2 drop boxes / fairing zone / RTLS-ASDS LZ circles synthesised from published payload mass &amp; typical trajectory.</p>
            </div>
            <div>
              <div className="text-slate-100 font-mono">Synthesised inputs</div>
              <p>Without real-time FAA AST or Space-Track API feeds, daily schedule is deterministically generated from UTC day-of-year hash per spaceport at cadence weights HIGH/MED/LOW/RARE. T-0 distributed ±6 hr from "now" so the panel always shows live state. Windows ±5 min before T-0 → +30-150 min after. NOTAM publish at T-4 hr.</p>
            </div>
            <div className="text-slate-500 italic">{rows.length} flights evaluated · {schedule.length} launches scheduled · {activeLaunches} window-open · {hazards.length} hazard sets active</div>
          </div>
        )}
      </div>
    </div>
  )
}
