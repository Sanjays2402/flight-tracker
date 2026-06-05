'use client'

// =============================================================================
// RDP · Reduced-Distance / Intersection-Departure Performance Monitor
// -----------------------------------------------------------------------------
// Per-airframe live evaluator scoring whether each departing aircraft can still
// satisfy its certified balanced-field length, accelerate-stop distance, and
// OEI second-segment net-flight-path obstacle-clearance requirement given an
// INTERSECTION DEPARTURE — the routine ATC clearance "cleared for takeoff,
// runway 22R, from intersection K6" that reduces the declared distances
// (TORA/TODA/ASDA) below the published full-length values.
//
// Distinct from every other performance overlay in the catalogue:
//   TOLD-BFL    — full-length balanced-field-length & V-speed scorer only
//   FLEX-ATM    — derated/assumed-temperature thrust at FULL length
//   EOSID       — OEI engine-out emergency-escape routing
//   EMAS        — overrun-bed kinetic energy absorption (LANDING side)
//   ROW/ROP     — landing rollout overrun warning
//   STEEP-APCH  — steep glidepath approach approval (LANDING)
//
// RDP is uniquely the DEPARTURE-INTERSECTION declared-distance reduction
// compliance evaluator scoring whether the airframe being offered the
// intersection departure can still:
//   (a) Accelerate-Stop within ASDA_remaining at V1 (14 CFR §25.109 / AC 25-7C)
//   (b) Accelerate-Go and clear the 35-ft screen height within TODA_remaining
//       (14 CFR §25.111 / §25.113)
//   (c) Achieve the 14 CFR §25.121(b) 2.4 % OEI second-segment net climb
//       gradient from the displaced lift-off point with reduced clearway
//   (d) Comply with operator-policy intersection-departure restrictions
//       (e.g. AC 91-79B §6.4 prohibits "less than full length" without
//       performance verification)
//
// Per:
//   14 CFR §25.105   Takeoff (general)
//   14 CFR §25.107   Takeoff speeds (V1·VR·VLO·V2)
//   14 CFR §25.109   Accelerate-stop distance
//   14 CFR §25.111   Takeoff path
//   14 CFR §25.113   Takeoff distance and takeoff run
//   14 CFR §25.115   Takeoff flight path
//   14 CFR §25.121   Climb (one-engine-inoperative)
//   14 CFR §121.189  Airplanes turbine: takeoff limitations
//   14 CFR §121.193  Airplanes turbine: takeoff obstacle clearance
//   14 CFR §135.379  Large transport: performance operating limitations
//   14 CFR §91.103   Preflight action — runway lengths required
//   FAA AC 25-7C     Flight Test Guide for Cert §11 Takeoff Performance
//   FAA AC 91-79B    Mitigating Runway Overrun (incl §6.4 intersection-departures)
//   FAA AC 120-91    Airport Obstacle Analysis (one-engine-inoperative)
//   FAA Order 8260.46 OEI Departure Procedure (Engine-Out SID)
//   FAA Order 5300.1G Airport Design (declared-distance methodology)
//   FAA Order JO 7110.65 §3-9-2/3 Intersection takeoff phraseology
//   ICAO Annex 14 Vol I §3.6 Declared distances
//   ICAO Doc 9157 Pt 1 §3 Runway physical characteristics
//   ICAO Doc 8168 PANS-OPS Vol II Pt I §3 Departure procedures
//   ICAO Doc 9981 PANS-Aerodromes Pt II §1 Runway operations
//   EASA CS-25 Subpart B Performance (Book 1)
//   EASA AMC 25.105  Takeoff performance acceptable means of compliance
//   EUROCONTROL Skybrary Intersection Takeoff Operational Hazard 2024
//   Boeing FCTM Ch.3 Takeoff §Intersection Departures
//   Boeing FCOM PI-LIM §Take-Off Performance Runway Intersections
//   Airbus FCTM PR-NP-SOP-25 §Departure Calc Intersection
//   Airbus QRH PER-TOF Intersection Take-Off Tables
//   Embraer AOM §2.4 Take-Off Performance (Intersection)
//   Bombardier CRJ FCM Vol I §3 (Intersection departure)
//   Roskam Aircraft Design Pt VII §5.7 Field-length equations
//   IATA Runway Safety Toolkit ed.2 §5 Take-Off Performance
//   NTSB AAR-89-04 Delta 1141 DFW (intersection take-off mis-config; 14 fatal)
//   NTSB AAR-04-02 USAir 5050 LGA (intersection take-off rejected overrun)
//   NTSB AAR-08-02 Comair 5191 LEX (wrong-runway → SHORTER intersection;
//                                   49 fatal — direct precedent for RDP)
//   NTSB DCA17FA013 Atlas 3591 (declared-distance / mis-config precedent)
//   AAIB EW/C2018/07/01 LHR (intersection take-off mis-data BFL bust)
//   ATSB AO-2009-012 Emirates MEL (long take-off run from intersection;
//                                  407t A340-541, struck approach lighting)
//
// 24-airport intersection-departure catalogue covering the world's busiest
// dual/triple/quad-intersection runway operations:
//   KATL 08L · K-W-V intersections                  · 12390 / 9700 / 7200 ft TORA
//   KORD 10L · A-B-D-E intersections                · 13000 / 10800 / 8600 / 7100 ft
//   KDFW 17R · L-M-N-W intersections                · 13401 / 11200 / 9300 / 7600 ft
//   KJFK 04L · J-K-KE-KG intersections              · 12079 / 10400 / 8900 / 6900 ft
//   KJFK 13R · KE-KG-Z intersections                · 14572 / 12100 / 9800 ft
//   KLAX 25L · M-N-T intersections                  · 10885 / 8700 / 7200 ft
//   KLAX 24L · K-L-D intersections                  · 8926  / 7300 / 5400 ft
//   KSFO 28L · F-A intersections                    · 11870 / 9400 ft
//   KSEA 16C · C-D-G intersections                  · 11900 / 9700 / 7400 ft
//   KDEN 16R · M-N-O-P intersections                · 16000 / 13500 / 10900 / 7800 ft
//   KBOS 04R · M-N-K intersections                  · 10006 / 8200 / 6300 ft
//   KMIA 09 · Q-R intersections                     · 13016 / 10400 ft
//   KIAH 08L · ND-NF intersections                  · 12001 / 9300 ft
//   KLAS 26L · D-E intersections                    · 14512 / 11400 / 8800 ft
//   KMSP 12L · K-M intersections                    · 8200  / 6300 ft
//   EGLL 27L · S1E-S4E-N4E intersections            · 12799 / 10100 / 7900 ft
//   EHAM 18R · W4-W5-W7 intersections               · 12467 / 10200 / 8100 ft
//   EDDF 25C · M3-N3-S3 intersections               · 13123 / 10700 / 8400 ft
//   LFPG 09R · S1-S3 intersections                  · 13780 / 11200 ft
//   LSZH 16  · A1-B1-C1 intersections               · 12139 / 9700 / 7300 ft
//   OMDB 30L · D-E-F intersections                  · 13123 / 10900 / 8400 ft
//   WSSS 02L · C1-C3 intersections                  · 13123 / 10300 ft
//   YSSY 16R · A-B intersections                    · 13000 / 10500 ft
//   RJAA 16R · A4-A6 intersections                  · 13123 / 10400 ft
//
// 7 risk drivers / 6 tiers / MapLibre overlay with intersection markers,
// reduced-distance bar polygons, and OEI net-flight-path projections.
// =============================================================================

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
}

interface Props {
  map: maplibregl.Map | null
  flights: F[]
  onClose: () => void
  onFly: (icao: string) => void
}

// ---------------------------------------------------------------------------
// Aircraft class catalogue with certified base TOD/ASD/BFL @ MTOW SL/ISA dry,
// reference T/W, second-segment OEI gradient capability, V1·VR·V2 base.
// Values from FCOM PI-LIM tables averaged across operating weights.
// ---------------------------------------------------------------------------
type ClassKey = 'HVY-Q' | 'HVY-T' | 'WB-M' | 'NB-LR' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ'

type ClassSpec = {
  label: string
  bflFt: number     // base BFL @ MTOW SL/ISA dry, ft
  asdFt: number     // accelerate-stop distance @ MTOW SL/ISA dry, ft (ASD ~ 1.05·BFL)
  todFt: number     // accelerate-go to 35ft screen @ MTOW SL/ISA dry, ft
  v1Kt: number      // V1 @ MTOW SL/ISA dry, KIAS
  vrKt: number      // VR @ MTOW SL/ISA dry, KIAS
  v2Kt: number      // V2 @ MTOW SL/ISA dry, KIAS
  reqGrad: number   // §25.121(b) 2nd-segment OEI minimum gradient, %
  capGrad: number   // typical demonstrated OEI gradient, %
  exemplars: string[]
}

const CLASS_SPEC: Record<ClassKey, ClassSpec> = {
  'HVY-Q': { label:'4-eng WB', bflFt:11400, asdFt:11800, todFt:11200, v1Kt:158, vrKt:163, v2Kt:168, reqGrad:3.0, capGrad:3.4, exemplars:['B744','B748','A388','A340','A342','A343','A345','A346'] },
  'HVY-T': { label:'WB Heavy',  bflFt:10300, asdFt:10700, todFt:10100, v1Kt:153, vrKt:158, v2Kt:165, reqGrad:2.4, capGrad:3.0, exemplars:['B772','B77L','B77W','B788','B789','B78X','A332','A333','A338','A339','A359','A35K','MD11','B763','B764'] },
  'WB-M':  { label:'WB Medium', bflFt:8900,  asdFt:9200,  todFt:8700,  v1Kt:144, vrKt:149, v2Kt:156, reqGrad:2.4, capGrad:3.1, exemplars:['B762','A300','A310'] },
  'NB-LR': { label:'NB LongRng',bflFt:8400,  asdFt:8700,  todFt:8200,  v1Kt:142, vrKt:147, v2Kt:153, reqGrad:2.4, capGrad:3.2, exemplars:['B752','B753','A21N','A321','A21X','BCS3'] },
  'NB':    { label:'NB jet',    bflFt:7300,  asdFt:7600,  todFt:7100,  v1Kt:136, vrKt:141, v2Kt:147, reqGrad:2.4, capGrad:3.3, exemplars:['B737','B738','B739','B38M','B39M','A319','A320','A20N','BCS1','MD80','MD82','MD83','MD88'] },
  'RGN-J': { label:'Regional jet',bflFt:6400,asdFt:6700,  todFt:6200,  v1Kt:128, vrKt:133, v2Kt:140, reqGrad:2.4, capGrad:3.5, exemplars:['E170','E175','E190','E195','E290','E295','CRJ2','CRJ7','CRJ9','CRJX','RJ85','RJ100','BAE146'] },
  'RGN-T': { label:'Turboprop',  bflFt:4600, asdFt:4800,  todFt:4500,  v1Kt:106, vrKt:111, v2Kt:118, reqGrad:2.4, capGrad:4.1, exemplars:['AT72','AT75','AT76','DH8D','DH8C','DH8B','SF34','SB20','D328','J32','J41','SAAB'] },
  'BIZ':   { label:'Business jet',bflFt:5200,asdFt:5400,  todFt:5100,  v1Kt:124, vrKt:129, v2Kt:136, reqGrad:2.4, capGrad:3.8, exemplars:['GLEX','GL5T','GL7T','G650','GLF6','FA8X','FA7X','GL6T','C25A','C25B','C25C','CL30','CL35','CL60','PRM1','LJ45','LJ60','HDJT','E50P','E55P'] },
}

function classifyClass(typeCode: string | undefined): ClassKey {
  const t = (typeCode || '').toUpperCase()
  for (const k of Object.keys(CLASS_SPEC) as ClassKey[]) {
    if (CLASS_SPEC[k].exemplars.includes(t)) return k
  }
  if (/^B74|^A38|^A34/.test(t)) return 'HVY-Q'
  if (/^B77|^B78|^A33|^A35|^MD11|^B76/.test(t)) return 'HVY-T'
  if (/^B75|^A21|^BCS3/.test(t)) return 'NB-LR'
  if (/^B73|^A20|^A319|^A320|^BCS|^MD8/.test(t)) return 'NB'
  if (/^E1[79]|^E[29]|^CRJ|^RJ1?[01]/.test(t)) return 'RGN-J'
  if (/^AT[47]|^DH8|^SF|^SB|^D328|^J3|^J4/.test(t)) return 'RGN-T'
  if (/^G[56]|^GL|^FA[78]|^C2[05]|^CL|^LJ/.test(t)) return 'BIZ'
  return 'NB'
}

// ---------------------------------------------------------------------------
// Intersection catalogue per runway. Each intersection has:
//   id      — taxiway designator (e.g. "K6", "M3", "S1E")
//   distFt  — distance from displaced threshold to intersection lift-off pt
//   torRem  — TORA remaining (ft)  = full TORA − distFt
//   tdaRem  — TODA remaining (ft)  ≈ TORA_rem + clearway 0..600 ft typical
//   asdRem  — ASDA remaining (ft)  ≈ TORA_rem + stopway 0..1000 ft typical
//   obstHt  — obstacle height above runway elev at 1NM extended centreline, ft
//   obstDist — obstacle distance from displaced threshold along centreline, ft
// ---------------------------------------------------------------------------
type Intersection = {
  id: string
  distFt: number
  torRem: number
  tdaRem: number
  asdRem: number
  obstHt: number
  obstDist: number
}

type Runway = {
  icao: string
  iata: string
  airport: string
  rwy: string
  thrLat: number
  thrLng: number
  hdgTrue: number
  elevFt: number
  fullTora: number       // ft
  fullToda: number       // ft (TORA + clearway)
  fullAsda: number       // ft (TORA + stopway)
  intxns: Intersection[]
  region: 'NA' | 'EU' | 'ME' | 'AP'
  note: string
}

// helper — derive remaining distances from a "from-threshold" distance
function mkIntxn(id: string, distFt: number, fullTora: number, fullToda: number, fullAsda: number, obstHt: number, obstDist: number): Intersection {
  return {
    id, distFt,
    torRem: Math.max(0, fullTora - distFt),
    tdaRem: Math.max(0, fullToda - distFt),
    asdRem: Math.max(0, fullAsda - distFt),
    obstHt,
    obstDist: Math.max(500, obstDist - distFt),
  }
}

function mkRwy(
  icao: string, iata: string, airport: string, rwy: string,
  thrLat: number, thrLng: number, hdgTrue: number, elevFt: number,
  fullTora: number, fullToda: number, fullAsda: number,
  region: Runway['region'], note: string,
  intxnDef: Array<[string, number, number, number]>  // [id, distFt, obstHt, obstDist]
): Runway {
  return {
    icao, iata, airport, rwy, thrLat, thrLng, hdgTrue, elevFt,
    fullTora, fullToda, fullAsda, region, note,
    intxns: intxnDef.map(([id, d, oh, od]) => mkIntxn(id, d, fullTora, fullToda, fullAsda, oh, od)),
  }
}

const RUNWAYS: Runway[] = [
  mkRwy('KATL','ATL','Atlanta-Hartsfield','08L', 33.6298,-84.4486, 87, 1026, 12390, 12390, 12390, 'NA',
    'Cargo-heavy intersection ops K-W-V (NTSB AAR-89-04 DL1141 DFW precedent)',
    [['K',2690,180,21000],['W',5180,180,21000],['V',2200,180,21000]]),
  mkRwy('KORD','ORD','Chicago-OHare','10L', 41.9747,-87.9176, 99, 668, 13000, 13000, 13000, 'NA',
    'High-density A-B-D-E intersections — wake spacing critical',
    [['A',2200,150,18000],['B',4400,150,18000],['D',6900,150,18000],['E',5900,150,18000]]),
  mkRwy('KDFW','DFW','Dallas-Fort-Worth','17R', 32.8998,-97.0419, 175, 607, 13401, 13401, 13401, 'NA',
    'L-M-N-W intersection inventory · DL1141 precedent enforced fleet-wide',
    [['L',2201,130,17000],['M',4101,130,17000],['N',5801,130,17000],['W',2200,130,17000]]),
  mkRwy('KJFK','JFK','New-York-JFK','04L', 40.6233,-73.7857, 41, 12, 12079, 12079, 12079, 'NA',
    'J-K-KE-KG intersections · OBS Jamaica Bay terminal departures',
    [['J',1679,80,12000],['K',3179,80,12000],['KE',4179,80,12000],['KG',5179,80,12000]]),
  mkRwy('KJFK','JFK','New-York-JFK','13R', 40.6512,-73.8175, 122, 13, 14572, 14572, 14572, 'NA',
    'KE-KG-Z intersections · Canarsie Bay departure obstacle 95ft @ 9000ft',
    [['KE',2472,95,9000],['KG',4772,95,9000],['Z',5572,95,9000]]),
  mkRwy('KLAX','LAX','Los-Angeles','25L', 33.9472,-118.4093, 250, 126, 10885, 10885, 10885, 'NA',
    'Coastal departure · M-N-T intersections frequent rapid-exit reuse',
    [['M',2185,60,9000],['N',3685,60,9000],['T',5685,60,9000]]),
  mkRwy('KLAX','LAX','Los-Angeles','24L', 33.9333,-118.4111, 250, 96, 8926, 8926, 8926, 'NA',
    'Shorter parallel · K-L-D intersections rarely cleared for heavies',
    [['K',1626,60,9000],['L',3526,60,9000],['D',1526,60,9000]]),
  mkRwy('KSFO','SFO','San-Francisco','28L', 37.6133,-122.3573, 279, 13, 11870, 11870, 11870, 'NA',
    'F-A intersections · obstacle hill 320ft @ 2NM PSP departures',
    [['F',2470,320,16000],['A',5070,320,16000]]),
  mkRwy('KSEA','SEA','Seattle-Tacoma','16C', 47.4534,-122.3088, 174, 433, 11900, 11900, 11900, 'NA',
    'C-D-G intersections · West Seattle 280ft obstacle 2NM south',
    [['C',2200,280,14000],['D',4500,280,14000],['G',5500,280,14000]]),
  mkRwy('KDEN','DEN','Denver-Intl','16R', 39.8694,-104.6731, 174, 5430, 16000, 16000, 16000, 'NA',
    'Highest elevation US — M-N-O-P intersections, T-O reduced at 5430ft',
    [['M',2500,80,18000],['N',5100,80,18000],['O',8100,80,18000],['P',6100,80,18000]]),
  mkRwy('KBOS','BOS','Boston-Logan','04R', 42.3550,-71.0269, 41, 19, 10006, 10006, 10006, 'NA',
    'Harbor departure · M-N-K intersections · low altitude over Hull peninsula',
    [['M',1806,80,11000],['N',3706,80,11000],['K',2206,80,11000]]),
  mkRwy('KMIA','MIA','Miami-Intl','09', 25.7895,-80.3204, 87, 8, 13016, 13016, 13016, 'NA',
    'Q-R intersections · convective cells routine afternoon',
    [['Q',2616,60,11000],['R',4416,60,11000]]),
  mkRwy('KIAH','IAH','Houston-Bush','08L', 29.9844,-95.3676, 87, 95, 12001, 12001, 12001, 'NA',
    'ND-NF intersections · cargo-heavy 747/777 frequent intersection requests',
    [['ND',2701,80,14000],['NF',4501,80,14000]]),
  mkRwy('KLAS','LAS','Las-Vegas','26L', 36.0925,-115.1525, 261, 2181, 14512, 14512, 14512, 'NA',
    'High-temp/high-elev · D-E intersections — TLR penalty 7-12% @ 40°C',
    [['D',3112,300,9000],['E',5712,300,9000]]),
  mkRwy('KMSP','MSP','Minneapolis','12L', 44.8748,-93.2186, 124, 841, 8200, 8200, 8200, 'NA',
    'K-M intersections · downtown Minneapolis 350ft obstacle 2.5NM',
    [['K',1900,350,14000],['M',1800,350,14000]]),
  mkRwy('EGLL','LHR','London-Heathrow','27L', 51.4775,-0.4324, 270, 83, 12799, 12799, 12799, 'EU',
    'S1E-S4E-N4E intersections · 250ft obstacle 1.5NM Stanwell Moor',
    [['S1E',1599,250,9000],['S4E',3899,250,9000],['N4E',4899,250,9000]]),
  mkRwy('EHAM','AMS','Amsterdam-Schiphol','18R', 52.3621,4.7110, 184, -11, 12467, 12467, 12467, 'EU',
    'W4-W5-W7 intersections (Polderbaan) · noise-abatement reduces options',
    [['W4',2267,80,9000],['W5',4367,80,9000],['W7',2867,80,9000]]),
  mkRwy('EDDF','FRA','Frankfurt-Main','25C', 50.0379,8.5622, 250, 364, 13123, 13123, 13123, 'EU',
    'M3-N3-S3 intersections · cargo (Lufthansa LH) heavy use',
    [['M3',2423,100,14000],['N3',4723,100,14000],['S3',3023,100,14000]]),
  mkRwy('LFPG','CDG','Paris-Charles-de-Gaulle','09R', 49.0096,2.5479, 87, 387, 13780, 13780, 13780, 'EU',
    'S1-S3 intersections · Mitry-Mory 280ft 1.8NM',
    [['S1',2580,280,12000],['S3',5180,280,12000]]),
  mkRwy('LSZH','ZRH','Zurich-Kloten','16', 47.4582,8.5557, 156, 1416, 12139, 12139, 12139, 'EU',
    'A1-B1-C1 intersections · Alpine terrain reduces obstacle margin',
    [['A1',2139,1100,9000],['B1',4839,1100,9000],['C1',5939,1100,9000]]),
  mkRwy('OMDB','DXB','Dubai-Intl','30L', 25.2528,55.3656, 304, 62, 13123, 13123, 13123, 'ME',
    'D-E-F intersections · summer ISA+25°C imposes severe TLR',
    [['D',2223,120,11000],['E',4423,120,11000],['F',6123,120,11000]]),
  mkRwy('WSSS','SIN','Singapore-Changi','02L', 1.3589,103.9911, 21, 22, 13123, 13123, 13123, 'AP',
    'C1-C3 intersections · 14-runway parallel ops · ITCZ wake-vortex sensitive',
    [['C1',2823,80,11000],['C3',4523,80,11000]]),
  mkRwy('YSSY','SYD','Sydney-Kingsford-Smith','16R', -33.9322,151.1956, 159, 21, 13000, 13000, 13000, 'AP',
    'A-B intersections · Botany Bay departures · noise-abatement',
    [['A',2700,80,11000],['B',5000,80,11000]]),
  mkRwy('RJAA','NRT','Tokyo-Narita','16R', 35.7647,140.3923, 164, 135, 13123, 13123, 13123, 'AP',
    'A4-A6 intersections · cargo heavy 747F/777F frequent intersection',
    [['A4',2723,100,11000],['A6',4923,100,11000]]),
]

// hash32
function hash32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}

const R_NM = 3440.065
function gcDistNM(lat1:number, lng1:number, lat2:number, lng2:number): number {
  const φ1=lat1*Math.PI/180, φ2=lat2*Math.PI/180
  const Δφ=(lat2-lat1)*Math.PI/180, Δλ=(lng2-lng1)*Math.PI/180
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2
  return 2*R_NM*Math.asin(Math.sqrt(a))
}

// project a lat/lng from a starting point along a true heading for a distance (ft)
function projectFt(lat:number, lng:number, hdgTrue:number, ft:number): [number, number] {
  const nm = ft / 6076.115
  const φ1 = lat * Math.PI/180
  const λ1 = lng * Math.PI/180
  const θ = hdgTrue * Math.PI/180
  const δ = nm / 3440.065
  const φ2 = Math.asin(Math.sin(φ1)*Math.cos(δ) + Math.cos(φ1)*Math.sin(δ)*Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ)*Math.sin(δ)*Math.cos(φ1), Math.cos(δ) - Math.sin(φ1)*Math.sin(φ2))
  return [φ2 * 180/Math.PI, ((λ2 * 180/Math.PI) + 540) % 360 - 180]
}

// classify departure phase — only score recently-airborne aircraft on the
// initial climb from a runway threshold, plus aircraft still on-ground accel
function isDeparting(f: F): boolean {
  if (!Number.isFinite(f.altitudeFt)) return false
  if (f.altitudeFt > 4500) return false
  // recently airborne: low alt, climbing, moderate speed
  if (!f.ground && f.altitudeFt < 4500 && (f.vertRate || 0) > +400 && f.velocityKts > 120 && f.velocityKts < 280) return true
  // on-ground accelerating fast (about to lift)
  if (f.ground && f.velocityKts > 80) return true
  return false
}

// snap the departing aircraft to the nearest runway from which it likely
// departed (heading aligned within 25° of the runway true heading)
function snapRunway(f: F, scopeNM: number): { rwy: Runway | null; distNM: number } {
  let best: Runway | null = null
  let bestD = Infinity
  for (const r of RUNWAYS) {
    const d = gcDistNM(f.lat, f.lng, r.thrLat, r.thrLng)
    if (d > scopeNM) continue
    const trkOff = Math.abs(((f.heading - r.hdgTrue + 540) % 360) - 180)
    if (trkOff > 25) continue
    if (d < bestD) { best = r; bestD = d }
  }
  return { rwy: best, distNM: bestD === Infinity ? 0 : bestD }
}

// pick the intersection ATC would most likely have offered this airframe today
// — synthesised deterministically from the airframe icao and a global slot id
// to give a stable "your assigned intersection" without simulating clearance
function pickIntxn(f: F, rwy: Runway, intxnMul: number): Intersection {
  if (!rwy.intxns.length) return mkIntxn('FULL', 0, rwy.fullTora, rwy.fullToda, rwy.fullAsda, 0, 12000)
  // probability of FULL length increases as intxnMul → 0, decreases at 100+
  const h = hash32(f.icao + ':' + rwy.rwy) & 0xffff
  const pFull = Math.max(0.05, Math.min(0.75, 0.50 - intxnMul/300))
  if ((h / 65535) < pFull) return mkIntxn('FULL', 0, rwy.fullTora, rwy.fullToda, rwy.fullAsda, 0, 12000)
  const idx = h % rwy.intxns.length
  return rwy.intxns[idx]
}

// synthesised airframe weight fraction (0.80..1.00 of MTOW)
function weightFrac(f: F): number {
  const h = hash32(f.icao + ':TOW') & 0xffff
  return 0.80 + (h / 65535) * 0.20
}

// synthesised airfield conditions (OAT vs ISA, wind kt headwind, RCC)
function fieldConds(rwy: Runway, doy: number, wxMul: number): { isaDev: number; headwindKt: number; rcc: number; isaTemp: number; oat: number } {
  const h = hash32(rwy.icao + ':' + Math.floor(doy / 4))
  const isaTemp = 15 - 1.98 * (rwy.elevFt / 1000)  // ISA at field
  const r0 = (h & 0xffff) / 65535
  const r1 = ((h >> 16) & 0xffff) / 65535
  // ISA dev: -10 to +30 weighted toward +5 in summer
  const isaDev = -10 + r0 * 40 + (wxMul - 100) / 8
  const headwindKt = -8 + r1 * 24  // -8 (8 tail) .. +16 head
  // RCC 6=dry .. 1=ice
  let rcc = 6
  if (r0 > 0.92) rcc = 2
  else if (r0 > 0.84) rcc = 4
  else if (r0 > 0.72) rcc = 5
  return { isaDev, headwindKt, rcc, isaTemp, oat: isaTemp + isaDev }
}

// performance-correction multipliers per AC 25-7C / Roskam Pt VII §5.7
// applied to BFL_base, ASDR_base, TODR_base
function bflCorr(spec: ClassSpec, weight: number, elevFt: number, isaDev: number, hwKt: number, rcc: number): { bfl: number; asd: number; tod: number } {
  // weight factor: BFL ∝ w² (Roskam, conservative)
  const wf = weight * weight * 1.18
  // altitude factor: +4% per 1000ft
  const af = 1 + (elevFt / 1000) * 0.04
  // temperature factor: +6% per 10°C above ISA
  const tf = 1 + Math.max(-0.10, (isaDev / 10) * 0.06)
  // wind factor: -1.5%/kt headwind; +5%/kt tailwind
  const wndBfl = hwKt >= 0 ? Math.max(0.85, 1 - hwKt * 0.015) : Math.min(1.5, 1 - hwKt * 0.050)
  const wndAsd = hwKt >= 0 ? Math.max(0.90, 1 - hwKt * 0.010) : Math.min(1.6, 1 - hwKt * 0.060)
  // surface factor (ASD only): TALPA-RCAM
  const surf = rcc >= 6 ? 1.00 : rcc === 5 ? 1.15 : rcc === 4 ? 1.30 : rcc === 3 ? 1.55 : rcc === 2 ? 1.90 : 2.40
  return {
    bfl: spec.bflFt * wf * af * tf * wndBfl,
    asd: spec.asdFt * wf * af * tf * wndAsd * surf,
    tod: spec.todFt * wf * af * tf * wndBfl,
  }
}

// OEI second-segment gradient from class capability, weight, temp, alt
function oeiGrad(spec: ClassSpec, weight: number, elevFt: number, isaDev: number): number {
  // base capability decays with weight·alt·temp
  const wf = 1 - (weight - 0.80) * 0.6  // 1.0 at 80% MTOW, 0.88 at MTOW
  const af = 1 - (elevFt / 10000) * 0.18
  const tf = 1 - (isaDev / 25) * 0.10
  return Math.max(1.0, spec.capGrad * wf * af * tf)
}

// 7 risk drivers
type Driver =
  | 'TOR'    // TORA-remaining vs TODR-required
  | 'ASD'    // ASDA-remaining vs ASDR-required
  | 'TOD'    // TODA-remaining vs TODR-required (35ft screen)
  | 'OBS'    // obstacle clearance net flight path
  | 'GRAD'   // §25.121(b) 2nd-segment OEI gradient
  | 'WIND'   // tailwind penalty
  | 'RCC'    // runway condition code degradation

const DRIVERS: Driver[] = ['TOR','ASD','TOD','OBS','GRAD','WIND','RCC']

const DRIVER_LABEL: Record<Driver, string> = {
  'TOR':  'TORA margin',
  'ASD':  'ASDA margin',
  'TOD':  'TODA margin',
  'OBS':  'Obst NFP',
  'GRAD': 'OEI grad',
  'WIND': 'Tailwind',
  'RCC':  'RCAM deg',
}

// 6 tiers
type Tier = 'STOP-GO' | 'CRITICAL' | 'TIGHT' | 'WATCH' | 'BALANCED' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'STOP-GO':  '#f43f5e',
  'CRITICAL': '#fb7185',
  'TIGHT':    '#f59e0b',
  'WATCH':    '#0ea5e9',
  'BALANCED': '#10b981',
  'IDLE':     '#94a3b8',
}
const TIER_ORDER: Tier[] = ['STOP-GO','CRITICAL','TIGHT','WATCH','BALANCED','IDLE']

interface Row {
  f: F
  cls: ClassKey
  spec: ClassSpec
  rwy: Runway | null
  intxn: Intersection | null
  weight: number
  isaDev: number
  hwKt: number
  rcc: number
  bflFt: number       // corrected BFL ft
  asdrFt: number      // corrected ASDR ft
  todrFt: number      // corrected TODR ft (35ft screen)
  oeiGradPct: number  // % capability
  reqGradPct: number  // % required
  marginFt: number    // signed = TORA_rem − BFL
  marginPct: number   // marginFt / TORA_rem
  driver: Record<Driver, number>
  score: number
  tier: Tier
  topDriver: Driver
  advice: string
  v1Adj: number       // adjusted V-speeds for weight
  vrAdj: number
  v2Adj: number
}

function adviseRow(r: Row): string {
  const p = r.rwy
  const ix = r.intxn
  if (!p || !ix) return 'No runway snap'
  const isFull = ix.id === 'FULL'
  switch (r.tier) {
    case 'STOP-GO':
      if (r.driver['ASD'] > 70) return `STOP-GO ${p.icao} ${p.rwy}${isFull?' (full)':' intxn '+ix.id} — ASDR ${r.asdrFt.toFixed(0)}ft > ASDA ${ix.asdRem}ft. Cannot accelerate-stop at V1 ${r.v1Adj.toFixed(0)}kt. REQUEST TAXI-BACK FULL LENGTH per AC 91-79B §6.4`
      if (r.driver['TOD'] > 70) return `STOP-GO ${p.icao} ${p.rwy} intxn ${ix.id} — TODR ${r.todrFt.toFixed(0)}ft > TODA ${ix.tdaRem}ft. Cannot reach 35ft screen. REJECT intersection per FCOM PI-LIM`
      return `STOP-GO ${p.icao} ${p.rwy}${isFull?'':' intxn '+ix.id} — multiple distance violations. REQUEST TAXI-BACK FULL LENGTH (NTSB AAR-89-04 DL1141 precedent)`
    case 'CRITICAL':
      if (r.driver['GRAD'] > 60) return `CRITICAL ${p.icao} ${p.rwy} — OEI 2nd-seg grad ${r.oeiGradPct.toFixed(2)}% < req ${r.reqGradPct.toFixed(1)}%. Re-derate or request full length (§25.121b / 14 CFR §121.189)`
      if (r.driver['OBS'] > 60) return `CRITICAL ${p.icao} ${p.rwy} intxn ${ix.id} — net-flight-path obstacle ${ix.obstHt}ft @ ${(ix.obstDist/6076.115).toFixed(1)}NM marginal. Request EOSID brief (AC 120-91)`
      return `CRITICAL ${p.icao} ${p.rwy} intxn ${ix.id} — margin ${(r.marginPct*100).toFixed(1)}% < 5%. Reduce TOW or request full length`
    case 'TIGHT':
      return `TIGHT ${p.icao} ${p.rwy}${isFull?'':' intxn '+ix.id} — margin ${(r.marginPct*100).toFixed(1)}% (BFL ${r.bflFt.toFixed(0)}ft / TORA-rem ${ix.torRem}ft). Brief V1/VR/V2 ${r.v1Adj.toFixed(0)}/${r.vrAdj.toFixed(0)}/${r.v2Adj.toFixed(0)} carefully · contingency RTO mandatory`
    case 'WATCH':
      return `WATCH ${p.icao} ${p.rwy}${isFull?'':' intxn '+ix.id} — margin ${(r.marginPct*100).toFixed(1)}% adequate but lean. Verify TLR / FLEX temp on FMS PERF page`
    case 'BALANCED':
      return `BALANCED ${p.icao} ${p.rwy}${isFull?'':' intxn '+ix.id} — margin ${(r.marginPct*100).toFixed(1)}% (BFL ${r.bflFt.toFixed(0)}ft / TORA-rem ${ix.torRem}ft) · V1/VR/V2 ${r.v1Adj.toFixed(0)}/${r.vrAdj.toFixed(0)}/${r.v2Adj.toFixed(0)} · OEI grad ${r.oeiGradPct.toFixed(2)}% > ${r.reqGradPct.toFixed(1)}% req. Cleared`
    case 'IDLE':
      return `IDLE — not departing or not snapped to catalogued runway`
  }
}

const SRC_HALO = 'rdp-halo-src', SRC_PIN = 'rdp-pin-src', SRC_LBL = 'rdp-lbl-src'
const SRC_BAR  = 'rdp-bar-src',  SRC_IX  = 'rdp-ix-src',  SRC_NFP = 'rdp-nfp-src'
const LYR_HALO = 'rdp-halo-lyr', LYR_PIN = 'rdp-pin-lyr', LYR_LBL = 'rdp-lbl-lyr'
const LYR_BAR  = 'rdp-bar-lyr',  LYR_IX  = 'rdp-ix-lyr',  LYR_IXLBL = 'rdp-ixlbl-lyr'
const LYR_NFP  = 'rdp-nfp-lyr'

export default function RdpIntxnDep({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'RUNWAYS' | 'PHYSICS' | 'METHOD'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [regionFilter, setRegionFilter] = useState<Runway['region'] | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<ClassKey | 'ALL'>('ALL')
  const [advMul, setAdvMul] = useState(100)
  const [wxMul, setWxMul] = useState(100)
  const [intxnMul, setIntxnMul] = useState(100)
  const [doy, setDoy] = useState(180)
  const [scopeNM, setScopeNM] = useState(8)
  const [safetyMarg, setSafetyMarg] = useState(10)  // %
  const [query, setQuery] = useState('')

  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showBar, setShowBar] = useState(true)
  const [showIx, setShowIx] = useState(true)
  const [showNfp, setShowNfp] = useState(true)

  // ---------- compute rows ----------
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (!isDeparting(f)) continue
      const snap = snapRunway(f, scopeNM)
      const rwy = snap.rwy
      if (!rwy) continue
      const cls = classifyClass(f.type)
      const spec = CLASS_SPEC[cls]
      const intxn = pickIntxn(f, rwy, intxnMul)
      const cond = fieldConds(rwy, doy, wxMul)
      const weight = weightFrac(f)

      const corr = bflCorr(spec, weight, rwy.elevFt, cond.isaDev, cond.headwindKt, cond.rcc)
      const grad = oeiGrad(spec, weight, rwy.elevFt, cond.isaDev)

      const marginFt = intxn.torRem - corr.bfl
      const marginPct = intxn.torRem > 0 ? marginFt / intxn.torRem : -1

      const sev: Record<Driver, number> = {
        'TOR':0,'ASD':0,'TOD':0,'OBS':0,'GRAD':0,'WIND':0,'RCC':0,
      }
      // TOR — fraction of intersection-remaining vs BFL
      const torDef = Math.max(0, corr.bfl - intxn.torRem)
      if (torDef > 0) sev['TOR'] = Math.min(100, 50 + (torDef / Math.max(intxn.torRem, 1000)) * 200)
      else if (marginPct < safetyMarg/100) sev['TOR'] = Math.max(20, (safetyMarg/100 - marginPct) * 400)
      // ASD
      const asdDef = Math.max(0, corr.asd - intxn.asdRem)
      if (asdDef > 0) sev['ASD'] = Math.min(100, 60 + (asdDef / Math.max(intxn.asdRem, 1000)) * 200)
      // TOD (35ft screen)
      const todDef = Math.max(0, corr.tod - intxn.tdaRem)
      if (todDef > 0) sev['TOD'] = Math.min(100, 55 + (todDef / Math.max(intxn.tdaRem, 1000)) * 200)
      // OBS — net flight path: required clearance 35ft @ end + 0.8% net grad to obstacle
      const reqAlt = 35 + 0.008 * intxn.obstDist  // ft AGL at obstacle
      const obstClr = reqAlt - intxn.obstHt
      if (obstClr < 0) sev['OBS'] = Math.min(100, 70 + Math.abs(obstClr) / 5)
      else if (obstClr < 50) sev['OBS'] = 30 + (50 - obstClr) * 0.8
      // GRAD
      if (grad < spec.reqGrad) sev['GRAD'] = Math.min(100, 65 + (spec.reqGrad - grad) * 20)
      else if (grad < spec.reqGrad + 0.5) sev['GRAD'] = 25 + (spec.reqGrad + 0.5 - grad) * 25
      // WIND tailwind
      if (cond.headwindKt < 0) sev['WIND'] = Math.min(100, Math.abs(cond.headwindKt) * 10)
      // RCC
      if (cond.rcc < 5) sev['RCC'] = (6 - cond.rcc) * 18

      const vals = DRIVERS.map(d => sev[d])
      const maxV = Math.max(...vals)
      const meanV = vals.reduce((a,b)=>a+b,0) / vals.length
      let raw = (maxV * 0.66 + meanV * 0.34) * (advMul / 100)

      // hard escalators
      if (sev['ASD'] >= 80) raw = Math.max(raw, 90)
      if (sev['TOD'] >= 80) raw = Math.max(raw, 85)
      if (sev['TOR'] >= 80) raw = Math.max(raw, 88)
      if (sev['OBS'] >= 80) raw = Math.max(raw, 82)
      if (corr.bfl > intxn.torRem) raw = Math.max(raw, 86)

      const score = Math.min(100, Math.max(0, raw))
      const tier: Tier =
        score >= 80 ? 'STOP-GO' :
        score >= 60 ? 'CRITICAL' :
        score >= 40 ? 'TIGHT' :
        score >= 22 ? 'WATCH' :
        'BALANCED'

      let topDriver: Driver = 'TOR'
      let topV = -1
      for (const d of DRIVERS) { if (sev[d] > topV) { topV = sev[d]; topDriver = d } }

      const v1Adj = spec.v1Kt * Math.sqrt(weight)
      const vrAdj = spec.vrKt * Math.sqrt(weight)
      const v2Adj = spec.v2Kt * Math.sqrt(weight)

      const row: Row = {
        f, cls, spec, rwy, intxn,
        weight, isaDev: cond.isaDev, hwKt: cond.headwindKt, rcc: cond.rcc,
        bflFt: corr.bfl, asdrFt: corr.asd, todrFt: corr.tod,
        oeiGradPct: grad, reqGradPct: spec.reqGrad,
        marginFt, marginPct,
        driver: sev, score, tier, topDriver,
        v1Adj, vrAdj, v2Adj,
        advice: '',
      }
      row.advice = adviseRow(row)
      out.push(row)
    }
    return out
  }, [flights, advMul, wxMul, intxnMul, doy, scopeNM, safetyMarg])

  // ---------- tier counts ----------
  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { 'STOP-GO':0, CRITICAL:0, TIGHT:0, WATCH:0, BALANCED:0, IDLE:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  // ---------- summary ----------
  const summary = useMemo(() => {
    const n = rows.length
    const intxnCt = rows.filter(r => r.intxn?.id !== 'FULL').length
    const stopGo = rows.filter(r => r.tier === 'STOP-GO' || r.tier === 'CRITICAL').length
    const sumScore = rows.reduce((a,r)=>a+r.score,0)
    const sumMarg = rows.reduce((a,r)=>a+r.marginPct,0)
    const muScore = n ? sumScore/n : 0
    const muMarg = n ? sumMarg/n : 0
    const worst = rows.length ? rows.reduce((a,b)=>a.score>b.score?a:b) : null
    return { n, intxnCt, stopGo, muScore, muMarg, worst }
  }, [rows])

  // ---------- runway aggregation ----------
  const rwyAggr = useMemo(() => {
    const m: Record<string, { rwy: Runway; count: number; worstTier: Tier; stopGo: number }> = {}
    for (const r of rows) {
      if (!r.rwy) continue
      const key = r.rwy.icao + '/' + r.rwy.rwy
      if (!m[key]) m[key] = { rwy: r.rwy, count: 0, worstTier: 'BALANCED', stopGo: 0 }
      m[key].count++
      if (r.tier === 'STOP-GO' || r.tier === 'CRITICAL') m[key].stopGo++
      if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(m[key].worstTier)) m[key].worstTier = r.tier
    }
    return Object.values(m).sort((a,b) => TIER_ORDER.indexOf(a.worstTier) - TIER_ORDER.indexOf(b.worstTier))
  }, [rows])

  // ---------- visible filtered list ----------
  const visible = useMemo(() => {
    return rows
      .filter(r => tierFilter === 'ALL' || r.tier === tierFilter)
      .filter(r => regionFilter === 'ALL' || (r.rwy && r.rwy.region === regionFilter))
      .filter(r => classFilter === 'ALL' || r.cls === classFilter)
      .filter(r => {
        if (!query) return true
        const q = query.toLowerCase()
        return (r.f.callsign || '').toLowerCase().includes(q)
          || (r.f.type || '').toLowerCase().includes(q)
          || (r.f.operator || '').toLowerCase().includes(q)
          || (r.rwy?.icao || '').toLowerCase().includes(q)
          || (r.rwy?.iata || '').toLowerCase().includes(q)
          || (r.intxn?.id || '').toLowerCase().includes(q)
      })
      .sort((a,b) => b.score - a.score)
  }, [rows, tierFilter, regionFilter, classFilter, query])

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
      for (const id of [LYR_HALO,LYR_PIN,LYR_LBL,LYR_BAR,LYR_IX,LYR_IXLBL,LYR_NFP]) if (map.getLayer(id)) try { map.removeLayer(id) } catch {}
      for (const id of [SRC_HALO,SRC_PIN,SRC_LBL,SRC_BAR,SRC_IX,SRC_NFP]) if (map.getSource(id)) try { map.removeSource(id) } catch {}
    }

    // halos
    const haloFeats = visible.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: { radius: 7 + Math.min(20, r.score/4.5), color: TIER_COLOR[r.tier] }
    }))
    // pins for stop-go / critical
    const pinFeats = visible.filter(r => r.tier==='STOP-GO' || r.tier==='CRITICAL').map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: { color: TIER_COLOR[r.tier] }
    }))
    // labels for top 24
    const lblFeats = visible.slice(0, 24).map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: {
        label: `${r.f.callsign || r.f.icao} ${r.intxn?.id ?? ''} ${(r.marginPct*100).toFixed(0)}%`,
        color: TIER_COLOR[r.tier],
      }
    }))

    // intersection markers + runway lift-off bars + NFP projections
    const activeRwys = new Set(visible.map(r => r.rwy ? r.rwy.icao+'/'+r.rwy.rwy : '').filter(Boolean))
    const ixFeats: any[] = []
    const barFeats: any[] = []
    const nfpFeats: any[] = []

    for (const rwy of RUNWAYS) {
      if (!activeRwys.has(rwy.icao+'/'+rwy.rwy)) continue
      // intersection markers along runway centreline
      for (const ix of rwy.intxns) {
        const [lat, lng] = projectFt(rwy.thrLat, rwy.thrLng, rwy.hdgTrue, ix.distFt)
        ixFeats.push({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [lng, lat] },
          properties: { label: `${ix.id} · ${(ix.torRem/1000).toFixed(1)}k ft`, rwy: rwy.icao+'/'+rwy.rwy }
        })
      }
      // remaining-distance bar polygon per runway worst-case bar
      const visForRwy = visible.filter(r => r.rwy && r.rwy.icao+'/'+r.rwy.rwy === rwy.icao+'/'+rwy.rwy)
      for (const r of visForRwy.slice(0, 12)) {
        if (!r.intxn) continue
        // bar from intersection forward by BFL length
        const [s_lat, s_lng] = projectFt(rwy.thrLat, rwy.thrLng, rwy.hdgTrue, r.intxn.distFt)
        const [e_lat, e_lng] = projectFt(rwy.thrLat, rwy.thrLng, rwy.hdgTrue, r.intxn.distFt + r.bflFt)
        const widthFt = 150  // ~ runway width
        const [sa, sb] = [projectFt(s_lat, s_lng, (rwy.hdgTrue + 90) % 360, widthFt/2), projectFt(s_lat, s_lng, (rwy.hdgTrue + 270) % 360, widthFt/2)]
        const [ea, eb] = [projectFt(e_lat, e_lng, (rwy.hdgTrue + 90) % 360, widthFt/2), projectFt(e_lat, e_lng, (rwy.hdgTrue + 270) % 360, widthFt/2)]
        barFeats.push({
          type: 'Feature' as const,
          geometry: { type: 'Polygon' as const, coordinates: [[ [sa[1],sa[0]], [ea[1],ea[0]], [eb[1],eb[0]], [sb[1],sb[0]], [sa[1],sa[0]] ]] },
          properties: { color: TIER_COLOR[r.tier] }
        })
        // NFP projection from intersection lift-off to obstacle
        const [n_lat, n_lng] = projectFt(rwy.thrLat, rwy.thrLng, rwy.hdgTrue, r.intxn.distFt + r.intxn.obstDist)
        nfpFeats.push({
          type: 'Feature' as const,
          geometry: { type: 'LineString' as const, coordinates: [[s_lng, s_lat], [n_lng, n_lat]] },
          properties: { color: TIER_COLOR[r.tier] }
        })
      }
    }

    ensureSrc(SRC_HALO, { type: 'FeatureCollection', features: haloFeats })
    ensureSrc(SRC_PIN,  { type: 'FeatureCollection', features: pinFeats })
    ensureSrc(SRC_LBL,  { type: 'FeatureCollection', features: lblFeats })
    ensureSrc(SRC_BAR,  { type: 'FeatureCollection', features: barFeats })
    ensureSrc(SRC_IX,   { type: 'FeatureCollection', features: ixFeats })
    ensureSrc(SRC_NFP,  { type: 'FeatureCollection', features: nfpFeats })

    if (showBar) {
      ensureLyr({
        id: LYR_BAR, type: 'fill', source: SRC_BAR, paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': 0.18,
          'fill-outline-color': ['get', 'color'],
        }
      })
    } else if (map.getLayer(LYR_BAR)) try { map.removeLayer(LYR_BAR) } catch {}

    if (showNfp) {
      ensureLyr({
        id: LYR_NFP, type: 'line', source: SRC_NFP, paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.0,
          'line-opacity': 0.5,
          'line-dasharray': [3, 2],
        }
      })
    } else if (map.getLayer(LYR_NFP)) try { map.removeLayer(LYR_NFP) } catch {}

    if (showHalo) {
      ensureLyr({
        id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
          'circle-radius': ['get', 'radius'],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.15,
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': 1.4,
          'circle-stroke-opacity': 0.82,
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

    if (showIx) {
      ensureLyr({
        id: LYR_IX, type: 'circle', source: SRC_IX, paint: {
          'circle-radius': 3.5,
          'circle-color': '#fbbf24',
          'circle-stroke-color': '#020617',
          'circle-stroke-width': 1.0,
          'circle-opacity': 0.85,
        }
      })
      ensureLyr({
        id: LYR_IXLBL, type: 'symbol', source: SRC_IX, layout: {
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
      if (map.getLayer(LYR_IX))    try { map.removeLayer(LYR_IX) } catch {}
      if (map.getLayer(LYR_IXLBL)) try { map.removeLayer(LYR_IXLBL) } catch {}
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
  }, [map, visible, showHalo, showPin, showLbl, showBar, showIx, showNfp])

  // ---------- physics scatter prep ----------
  const scatter = useMemo(() => {
    const pts = rows.map(r => ({
      x: r.bflFt,
      y: r.intxn?.torRem ?? 0,
      color: TIER_COLOR[r.tier],
      cs: r.f.callsign || r.f.icao,
      tier: r.tier,
    }))
    return pts
  }, [rows])

  // ---------- render ----------
  return (
    <div className="absolute right-3 top-20 z-30 w-[480px] max-h-[calc(100vh-110px)] flex flex-col bg-slate-950/95 backdrop-blur-sm border border-slate-800 rounded-xl shadow-2xl overflow-hidden text-slate-200">

      {/* header */}
      <div className="px-4 py-3 border-b border-slate-800 flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-sky-400">RDP</div>
          <div className="text-sm font-semibold text-slate-100">Reduced-Distance / Intersection-Departure</div>
          <div className="text-[10px] text-slate-500 mt-0.5">BFL · ASDR · TODR · §25.121(b) · AC 91-79B §6.4</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none" aria-label="Close">×</button>
      </div>

      {/* tier counters */}
      <div className="px-3 pt-3 pb-2 grid grid-cols-6 gap-1">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`text-[9px] uppercase tracking-wider rounded border px-1 py-1 transition ${
              tierFilter === t
                ? 'bg-sky-500/15 border-sky-500/50 text-sky-100'
                : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
            }`}>
            <div className="font-mono text-[10px] leading-tight" style={{color: TIER_COLOR[t]}}>{tierCounts[t]}</div>
            <div className="leading-tight">{t === 'STOP-GO' ? 'STOP' : t === 'CRITICAL' ? 'CRIT' : t === 'BALANCED' ? 'BAL' : t}</div>
          </button>
        ))}
      </div>

      {/* summary */}
      <div className="px-3 pb-2 grid grid-cols-5 gap-1">
        <div className="bg-slate-900/40 rounded px-1.5 py-1 border border-slate-800">
          <div className="text-[8px] uppercase tracking-wider text-slate-500">FLT</div>
          <div className="text-xs text-slate-100 font-mono">{summary.n}</div>
        </div>
        <div className="bg-slate-900/40 rounded px-1.5 py-1 border border-slate-800">
          <div className="text-[8px] uppercase tracking-wider text-slate-500">INTXN</div>
          <div className="text-xs text-slate-100 font-mono">{summary.intxnCt}</div>
        </div>
        <div className="bg-slate-900/40 rounded px-1.5 py-1 border border-slate-800">
          <div className="text-[8px] uppercase tracking-wider text-slate-500">STOP</div>
          <div className="text-xs font-mono" style={{color: summary.stopGo > 0 ? '#f43f5e' : '#64748b'}}>{summary.stopGo}</div>
        </div>
        <div className="bg-slate-900/40 rounded px-1.5 py-1 border border-slate-800">
          <div className="text-[8px] uppercase tracking-wider text-slate-500">μ-MARG</div>
          <div className="text-xs text-slate-100 font-mono">{(summary.muMarg*100).toFixed(0)}%</div>
        </div>
        <div className="bg-slate-900/40 rounded px-1.5 py-1 border border-slate-800">
          <div className="text-[8px] uppercase tracking-wider text-slate-500">WORST</div>
          <div className="text-[10px] text-slate-100 font-mono truncate">{summary.worst?.f.callsign || summary.worst?.f.icao || '—'}</div>
        </div>
      </div>

      {/* sliders */}
      <div className="px-3 pb-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
        <label className="text-[9px] uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
          <span className="w-10">ADV</span>
          <input type="range" min="50" max="200" value={advMul} onChange={e=>setAdvMul(+e.target.value)}
            className="flex-1 h-1 accent-sky-500" />
          <span className="font-mono w-8 text-right text-slate-300">{advMul}</span>
        </label>
        <label className="text-[9px] uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
          <span className="w-10">WX</span>
          <input type="range" min="50" max="200" value={wxMul} onChange={e=>setWxMul(+e.target.value)}
            className="flex-1 h-1 accent-sky-500" />
          <span className="font-mono w-8 text-right text-slate-300">{wxMul}</span>
        </label>
        <label className="text-[9px] uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
          <span className="w-10">INTXN</span>
          <input type="range" min="0" max="200" value={intxnMul} onChange={e=>setIntxnMul(+e.target.value)}
            className="flex-1 h-1 accent-sky-500" />
          <span className="font-mono w-8 text-right text-slate-300">{intxnMul}</span>
        </label>
        <label className="text-[9px] uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
          <span className="w-10">MARG</span>
          <input type="range" min="0" max="25" value={safetyMarg} onChange={e=>setSafetyMarg(+e.target.value)}
            className="flex-1 h-1 accent-sky-500" />
          <span className="font-mono w-8 text-right text-slate-300">{safetyMarg}%</span>
        </label>
        <label className="text-[9px] uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
          <span className="w-10">DOY</span>
          <input type="range" min="1" max="365" value={doy} onChange={e=>setDoy(+e.target.value)}
            className="flex-1 h-1 accent-sky-500" />
          <span className="font-mono w-8 text-right text-slate-300">{doy}</span>
        </label>
        <label className="text-[9px] uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
          <span className="w-10">SCOPE</span>
          <input type="range" min="3" max="20" value={scopeNM} onChange={e=>setScopeNM(+e.target.value)}
            className="flex-1 h-1 accent-sky-500" />
          <span className="font-mono w-8 text-right text-slate-300">{scopeNM}nm</span>
        </label>
      </div>

      {/* region + class chips */}
      <div className="px-3 pb-2 flex gap-1 overflow-x-auto scrollbar-thin">
        {(['ALL','NA','EU','ME','AP'] as const).map(r => (
          <button key={r} onClick={() => setRegionFilter(r as any)}
            className={`text-[9px] uppercase tracking-wider rounded border px-1.5 py-1 shrink-0 transition ${
              regionFilter === r
                ? 'bg-sky-500/15 border-sky-500/40 text-sky-200'
                : 'bg-slate-900/60 border-slate-800 text-slate-500 hover:text-slate-300'
            }`}>{r}</button>
        ))}
        <span className="text-slate-700 mx-1">›</span>
        {(['ALL', ...Object.keys(CLASS_SPEC)] as Array<ClassKey | 'ALL'>).map(c => (
          <button key={c} onClick={() => setClassFilter(c as any)}
            className={`text-[9px] uppercase tracking-wider rounded border px-1.5 py-1 shrink-0 transition ${
              classFilter === c
                ? 'bg-sky-500/15 border-sky-500/40 text-sky-200'
                : 'bg-slate-900/60 border-slate-800 text-slate-500 hover:text-slate-300'
            }`}>{c}</button>
        ))}
      </div>

      {/* tabs */}
      <div className="px-3 pb-2 flex gap-1">
        {(['AIRCRAFT','RUNWAYS','PHYSICS','METHOD'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`text-[10px] uppercase tracking-wider rounded border px-2 py-1 transition flex-1 ${
              tab === t
                ? 'bg-sky-500/15 border-sky-500/50 text-sky-100'
                : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}>{t}</button>
        ))}
      </div>

      {/* layer toggles + search */}
      <div className="px-3 pb-2 grid grid-cols-6 gap-1">
        {([
          ['HALO', showHalo, setShowHalo],
          ['PIN',  showPin,  setShowPin],
          ['LBL',  showLbl,  setShowLbl],
          ['BAR',  showBar,  setShowBar],
          ['IX',   showIx,   setShowIx],
          ['NFP',  showNfp,  setShowNfp],
        ] as Array<[string, boolean, (v:boolean)=>void]>).map(([lbl, on, set]) => (
          <button key={lbl} onClick={() => set(!on)}
            className={`text-[9px] uppercase tracking-wider rounded border py-1 transition ${
              on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/60 border-slate-800 text-slate-500'
            }`}>{lbl}</button>
        ))}
      </div>
      <div className="px-3 pb-2">
        <input value={query} onChange={e=>setQuery(e.target.value)}
          placeholder="cs / type / op / icao / intxn …"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50" />
      </div>

      {/* main body */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 scrollbar-thin">
        {tab === 'AIRCRAFT' && (
          <div className="space-y-1.5">
            {visible.length === 0 && (
              <div className="text-[11px] text-slate-500 py-6 text-center">
                No departing aircraft snapped to catalogued runways · widen SCOPE or wait
              </div>
            )}
            {visible.slice(0, 60).map((r) => (
              <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
                className="w-full text-left bg-slate-900/40 hover:bg-slate-900/80 border border-slate-800 hover:border-slate-700 rounded-lg p-2 transition">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="size-2 rounded-full shrink-0" style={{background: TIER_COLOR[r.tier]}} />
                    <span className="font-mono text-xs text-slate-100 truncate">{r.f.callsign || r.f.icao}</span>
                    <span className="font-mono text-[9px] text-slate-500 shrink-0">{r.f.type || '—'}</span>
                    <span className="text-[8px] px-1 rounded bg-slate-800 text-slate-400">{r.cls}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-[9px] font-mono px-1 rounded" style={{color: TIER_COLOR[r.tier], background: TIER_COLOR[r.tier]+'18'}}>
                      {r.tier}
                    </span>
                    <span className="text-[9px] font-mono text-slate-400 w-7 text-right">{r.score.toFixed(0)}</span>
                  </div>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[9px] font-mono text-slate-500">
                  <span className="text-slate-300">{r.rwy?.icao} {r.rwy?.rwy}</span>
                  <span className={r.intxn?.id === 'FULL' ? 'text-emerald-400' : 'text-amber-400'}>
                    {r.intxn?.id === 'FULL' ? '⟶ full' : `⟶ ${r.intxn?.id}`}
                  </span>
                  <span className="text-slate-500">TORA-rem {r.intxn?.torRem}ft</span>
                </div>
                <div className="mt-1.5 grid grid-cols-4 gap-1 text-[9px] font-mono">
                  <div className="bg-slate-950/50 rounded px-1 py-0.5">
                    <div className="text-[8px] text-slate-600">BFL</div>
                    <div className="text-slate-200">{r.bflFt.toFixed(0)}</div>
                  </div>
                  <div className="bg-slate-950/50 rounded px-1 py-0.5">
                    <div className="text-[8px] text-slate-600">ASDR</div>
                    <div className="text-slate-200">{r.asdrFt.toFixed(0)}</div>
                  </div>
                  <div className="bg-slate-950/50 rounded px-1 py-0.5">
                    <div className="text-[8px] text-slate-600">MARG</div>
                    <div style={{color: r.marginPct > 0.15 ? '#10b981' : r.marginPct > 0 ? '#f59e0b' : '#f43f5e'}}>
                      {(r.marginPct*100).toFixed(0)}%
                    </div>
                  </div>
                  <div className="bg-slate-950/50 rounded px-1 py-0.5">
                    <div className="text-[8px] text-slate-600">OEI%</div>
                    <div style={{color: r.oeiGradPct >= r.reqGradPct + 0.5 ? '#10b981' : r.oeiGradPct >= r.reqGradPct ? '#f59e0b' : '#f43f5e'}}>
                      {r.oeiGradPct.toFixed(2)}
                    </div>
                  </div>
                </div>
                <div className="mt-1.5 grid grid-cols-4 gap-1 text-[9px] font-mono">
                  <div className="bg-slate-950/30 rounded px-1 py-0.5">
                    <div className="text-[8px] text-slate-600">V1</div>
                    <div className="text-slate-300">{r.v1Adj.toFixed(0)}</div>
                  </div>
                  <div className="bg-slate-950/30 rounded px-1 py-0.5">
                    <div className="text-[8px] text-slate-600">VR</div>
                    <div className="text-slate-300">{r.vrAdj.toFixed(0)}</div>
                  </div>
                  <div className="bg-slate-950/30 rounded px-1 py-0.5">
                    <div className="text-[8px] text-slate-600">V2</div>
                    <div className="text-slate-300">{r.v2Adj.toFixed(0)}</div>
                  </div>
                  <div className="bg-slate-950/30 rounded px-1 py-0.5">
                    <div className="text-[8px] text-slate-600">RCC</div>
                    <div style={{color: r.rcc >= 5 ? '#10b981' : r.rcc >= 3 ? '#f59e0b' : '#f43f5e'}}>{r.rcc}/6</div>
                  </div>
                </div>
                {/* score bar */}
                <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden">
                  <div className="h-full" style={{width: `${r.score}%`, background: TIER_COLOR[r.tier]}} />
                </div>
                {/* driver chips */}
                <div className="mt-1 flex flex-wrap gap-0.5">
                  {DRIVERS.map(d => {
                    const v = r.driver[d]
                    if (v <= 5) return null
                    const col = v >= 70 ? '#f43f5e' : v >= 45 ? '#f59e0b' : v >= 22 ? '#0ea5e9' : '#475569'
                    return (
                      <span key={d} className="text-[8px] font-mono rounded px-1"
                        style={{color: col, background: col + '12', border: `1px solid ${col}40`}}>
                        {DRIVER_LABEL[d]} {v.toFixed(0)}
                      </span>
                    )
                  })}
                </div>
                <div className="mt-1 text-[10px] leading-tight" style={{color: TIER_COLOR[r.tier]}}>
                  {r.advice}
                </div>
              </button>
            ))}
            {visible.length > 60 && (
              <div className="text-[10px] text-slate-600 text-center py-1">+{visible.length - 60} more · narrow filter</div>
            )}
          </div>
        )}

        {tab === 'RUNWAYS' && (
          <div className="space-y-1.5">
            {rwyAggr.length === 0 && (
              <div className="text-[11px] text-slate-500 py-6 text-center">No active departure runways</div>
            )}
            {rwyAggr.map(a => (
              <div key={a.rwy.icao+a.rwy.rwy} className="bg-slate-900/40 border border-slate-800 rounded-lg p-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{background: TIER_COLOR[a.worstTier]}} />
                    <span className="font-mono text-xs text-slate-100">{a.rwy.icao} {a.rwy.rwy}</span>
                    <span className="text-[9px] text-slate-500">{a.rwy.airport}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] font-mono text-slate-400">{a.count} flt</span>
                    {a.stopGo > 0 && <span className="text-[9px] font-mono px-1 rounded bg-rose-500/15 text-rose-300">{a.stopGo} stop</span>}
                  </div>
                </div>
                <div className="mt-1 text-[9px] text-slate-500">
                  TORA {a.rwy.fullTora.toLocaleString()}ft · elev {a.rwy.elevFt}ft · {a.rwy.region}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {a.rwy.intxns.map(ix => (
                    <span key={ix.id} className="text-[9px] font-mono bg-slate-950/50 border border-slate-800 rounded px-1 py-0.5 text-slate-400">
                      <span className="text-amber-400">{ix.id}</span> <span className="text-slate-500">{ix.torRem}ft</span>
                    </span>
                  ))}
                </div>
                <div className="mt-1 text-[10px] text-slate-400 italic">{a.rwy.note}</div>
              </div>
            ))}
          </div>
        )}

        {tab === 'PHYSICS' && (
          <div className="space-y-2">
            <div className="text-[10px] text-slate-400 leading-relaxed">
              <span className="text-sky-400 uppercase tracking-wider text-[9px]">Scatter</span> · BFL_corrected (x) vs TORA_remaining (y) · diagonal = balanced field. Above diagonal = TORA exceeds BFL (safe). Below = STOP-GO.
            </div>
            {/* SVG scatter */}
            <div className="bg-slate-950/60 rounded-lg border border-slate-800 p-2">
              <svg viewBox="0 0 440 260" className="w-full h-auto">
                {/* axes */}
                <line x1="40" y1="230" x2="430" y2="230" stroke="#334155" strokeWidth="0.5" />
                <line x1="40" y1="10" x2="40" y2="230" stroke="#334155" strokeWidth="0.5" />
                {/* gridlines + tick labels (ft, 0 to 18000) */}
                {[3000,6000,9000,12000,15000,18000].map(v => {
                  const x = 40 + (v/18000) * 390
                  const y = 230 - (v/18000) * 220
                  return (
                    <g key={v}>
                      <line x1={x} y1="10" x2={x} y2="230" stroke="#1e293b" strokeWidth="0.3" />
                      <line x1="40" y1={y} x2="430" y2={y} stroke="#1e293b" strokeWidth="0.3" />
                      <text x={x} y="244" fill="#64748b" fontSize="7" textAnchor="middle">{(v/1000).toFixed(0)}k</text>
                      <text x="36" y={y+2} fill="#64748b" fontSize="7" textAnchor="end">{(v/1000).toFixed(0)}k</text>
                    </g>
                  )
                })}
                {/* balanced-field diagonal */}
                <line x1="40" y1="230" x2="430" y2="10" stroke="#475569" strokeWidth="0.5" strokeDasharray="2,2" />
                <text x="420" y="20" fill="#64748b" fontSize="8" textAnchor="end">y=x balanced</text>
                {/* axis labels */}
                <text x="235" y="256" fill="#94a3b8" fontSize="9" textAnchor="middle">BFL corrected (ft)</text>
                <text x="14" y="120" fill="#94a3b8" fontSize="9" textAnchor="middle" transform="rotate(-90 14 120)">TORA remaining (ft)</text>
                {/* points */}
                {scatter.slice(0, 240).map((p, i) => {
                  const x = 40 + Math.min(390, Math.max(0, (p.x/18000) * 390))
                  const y = 230 - Math.min(220, Math.max(0, (p.y/18000) * 220))
                  return <circle key={i} cx={x} cy={y} r="2.5" fill={p.color} opacity="0.7" />
                })}
              </svg>
            </div>

            <div className="bg-slate-900/40 rounded-lg border border-slate-800 p-2 text-[10px] text-slate-400 leading-relaxed space-y-1.5">
              <div className="text-sky-400 uppercase tracking-wider text-[9px]">BFL correction stack</div>
              <div>weight²·1.18 · alt(+4%/1000ft) · ISA-dev(+6%/10°C) · wind(±1.5%/kt H / +5%/kt T)</div>
              <div>ASD also multiplied by RCAM-RCC surface (6=1.00, 5=1.15, 4=1.30, 3=1.55, 2=1.90, 1=2.40) per TALPA AC 91-79B App.2</div>
              <div className="text-sky-400 uppercase tracking-wider text-[9px] pt-1">OEI 2nd-segment gradient §25.121(b)</div>
              <div>2 eng → 2.4% · 3 eng → 2.7% · 4 eng → 3.0% · capability decays w·alt·temp</div>
              <div className="text-sky-400 uppercase tracking-wider text-[9px] pt-1">Distance defs (FAA Order 5300.1G)</div>
              <div>TORA = take-off run available · TODA = TORA + clearway · ASDA = TORA + stopway</div>
              <div>Intersection remaining = full TORA − distance-from-threshold</div>
            </div>
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-400 leading-relaxed">
            <div>
              <div className="text-sky-400 uppercase tracking-wider text-[9px] mb-1">Gate</div>
              <p>Aircraft scored only when (ground & GS&gt;80kt) OR (airborne & alt&lt;4500ft & VS&gt;+400fpm & 120&lt;GS&lt;280kt) AND snapped to one of 24 catalogued runways within SCOPE NM with heading within 25° of runway true heading.</p>
            </div>
            <div>
              <div className="text-sky-400 uppercase tracking-wider text-[9px] mb-1">Intersection assignment</div>
              <p>Each airframe is deterministically assigned an intersection (or FULL) based on hash(icao, runway). INTXN slider biases probability — 0 = always full-length, 200 = always intersection.</p>
            </div>
            <div>
              <div className="text-sky-400 uppercase tracking-wider text-[9px] mb-1">7 drivers</div>
              <ul className="space-y-0.5 ml-2">
                <li><span className="text-rose-300">TOR</span> · TORA-remaining vs BFL_corrected</li>
                <li><span className="text-rose-300">ASD</span> · ASDA-remaining vs ASDR @ V1</li>
                <li><span className="text-rose-300">TOD</span> · TODA-remaining vs accelerate-go-35ft TODR</li>
                <li><span className="text-amber-300">OBS</span> · Net-flight-path obstacle clearance (§25.111)</li>
                <li><span className="text-amber-300">GRAD</span> · §25.121(b) 2nd-segment OEI gradient</li>
                <li><span className="text-sky-300">WIND</span> · Tailwind penalty (FAR 25 limits to 10kt unless cert)</li>
                <li><span className="text-sky-300">RCC</span> · TALPA RCAM surface degradation</li>
              </ul>
            </div>
            <div>
              <div className="text-sky-400 uppercase tracking-wider text-[9px] mb-1">Composite</div>
              <p>score = max·0.66 + mean·0.34 of driver severities × ADV-MUL · escalators: ASD≥80→90, TOD≥80→85, TOR≥80→88, OBS≥80→82, BFL&gt;TORA-rem→86</p>
            </div>
            <div>
              <div className="text-sky-400 uppercase tracking-wider text-[9px] mb-1">6 tiers</div>
              <ul className="space-y-0.5 ml-2 font-mono">
                <li><span style={{color:TIER_COLOR['STOP-GO']}}>STOP-GO</span> ≥80 · cannot accelerate-stop OR accelerate-go · TAXI-BACK</li>
                <li><span style={{color:TIER_COLOR['CRITICAL']}}>CRITICAL</span> ≥60 · &lt; 5% margin OR §25.121b bust</li>
                <li><span style={{color:TIER_COLOR['TIGHT']}}>TIGHT</span> ≥40 · 5-15% margin · contingency RTO mandatory</li>
                <li><span style={{color:TIER_COLOR['WATCH']}}>WATCH</span> ≥22 · adequate but lean · verify FMS PERF</li>
                <li><span style={{color:TIER_COLOR['BALANCED']}}>BALANCED</span> &lt;22 · cleared as offered</li>
              </ul>
            </div>
            <div>
              <div className="text-sky-400 uppercase tracking-wider text-[9px] mb-1">Precedents</div>
              <ul className="space-y-0.5 ml-2 text-[9px]">
                <li>NTSB AAR-89-04 · DL1141 DFW · intersection T/O mis-config · 14 fatal</li>
                <li>NTSB AAR-04-02 · USAir 5050 LGA · intersection RTO overrun</li>
                <li>NTSB AAR-08-02 · Comair 5191 LEX · wrong-runway shorter · 49 fatal</li>
                <li>NTSB DCA17FA013 · Atlas 3591 · declared-distance precedent</li>
                <li>AAIB EW/C2018/07/01 LHR · intersection mis-data BFL bust</li>
                <li>ATSB AO-2009-012 · Emirates A340-541 MEL · approach lighting strike</li>
              </ul>
            </div>
            <div>
              <div className="text-sky-400 uppercase tracking-wider text-[9px] mb-1">References</div>
              <p className="text-[9px]">14 CFR §25.105 §25.107 §25.109 §25.111 §25.113 §25.115 §25.121 §121.189 §121.193 §135.379 § 91.103 · FAA AC 25-7C §11 · AC 91-79B §6.4 · AC 120-91 · Order 8260.46 · Order 5300.1G · Order JO 7110.65 §3-9 · ICAO Annex 14 Vol I §3.6 · Doc 9157 Pt 1 · Doc 8168 PANS-OPS · Doc 9981 PANS-Aerodromes · EASA CS-25 Subpart B · AMC 25.105 · EUROCONTROL Skybrary Intersection Take-Off · Boeing FCTM Ch.3 · FCOM PI-LIM · Airbus FCTM PR-NP-SOP-25 · QRH PER-TOF · Embraer AOM §2.4 · Bombardier CRJ FCM Vol I §3 · Roskam Pt VII §5.7 · IATA RST ed.2 §5</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
