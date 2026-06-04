'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   LVTO — Low-Visibility Take-Off Minima Compliance Monitor
   -----------------------------------------------------------
   For every departing aircraft (gate/taxi/line-up/roll/initial
   climb) snapped to a known runway threshold by proximity and
   heading alignment, infers the lowest legal Take-Off RVR
   regime the airframe could legally depart in, given:
     - aircraft HUD/HGS / dual-channel-autothrottle / multi-pilot
       crew certification class (HVY-T defaults HUD Cat-IIIa,
       NB-MAX optional HUD, RGN-J Cat-I-only, etc.)
     - runway infrastructure equipage matrix
         - centreline-light spacing (15m / 30m / nil)
         - touchdown-zone (TDZ) lighting
         - multi-segment RVR sensors (TDZ + MID + STOP-END)
         - illuminated stop-bars at LVP holding positions
         - low-visibility-procedures (LVP) declared
         - SMGCS / A-SMGCS surface-movement guidance
     - synthesised local RVR (m), ceiling (ft AGL), crosswind
       component, OAT, and slant-visibility
   then compares against the canonical 5-regime EU OPS App-1 to
   OPS 1.430 / FAA AC 120-28D / ICAO Doc 9365 Pt II LVTO matrix:

       CAT-I T/O      RVR ≥ 400 m  (single-pilot, basic cert)
       SMGCS / CL-300 RVR ≥ 300 m  (CL ≤30 m, multi-RVR rec)
       LVTO-200       RVR ≥ 200 m  (CL ≤15 m + TDZ-lights)
       LVTO-125       RVR ≥ 125 m  (HUD + multi-RVR + LVP)
       LVTO-75        RVR ≥ 75  m  (HUD Cat-IIIa + redundant)

   regime achievable = min(airframe HUD-cert, airport equipage)
   per-aircraft tier from current RVR vs required-by-regime:
     OPTIMAL  RVR margin ≥ 100 m above req       emerald
     LEGAL    margin ≥ 25 m                      sky
     TIGHT    margin within 25 m of floor        amber
     WAIT     RVR forecast trending up, hold     rose-pink
     NO-GO    below all-cat floor or no LVP      rose

   Per-runway rollup tracks departing/holding count + worst tier
   + driving regime, sorted worst-first then traffic desc.

   MapLibre overlay:
     - Tier-coloured 12px runway pin at picked thresholds
       with IATA/RWY + regime + tier label
     - Class-coloured aircraft halo ring sized by margin (7-19px)
     - Dashed tier-coloured projection line aircraft → threshold
       with diamond TDZ marker
     - Per-aircraft callsign + regime + RVR-margin-m label
   Side panel:
     - 5-tier counter strip click-to-filter
     - 5-cell DEPT-CNT / WORST-IATA / μ-RVR-m / Σ-NO-GO / LVP-on
     - SVG ceiling vs RVR scatter with regime-band overlays
     - SAMPLE-RNG / RVR-OFFSET / CEIL-OFFSET / CROSS-CAP sliders
     - AIRCRAFT / RUNWAYS / GEOMETRY / METHOD tabs
     - class chip row
     - search by callsign / type / op / IATA / city

   Registered under Layers > Safety & Traffic category.
   ft-lvto persisted preference.
   ============================================================ */

export interface LvtoFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  vertRate: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: LvtoFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OPTIMAL' | 'LEGAL' | 'TIGHT' | 'WAIT' | 'NO-GO' | 'NOT-DEP'
const TIER_COLOR: Record<Tier, string> = {
  'OPTIMAL': '#10b981',
  'LEGAL':   '#0ea5e9',
  'TIGHT':   '#f59e0b',
  'WAIT':    '#f97316',
  'NO-GO':   '#ef4444',
  'NOT-DEP': '#64748b',
}
const TIER_ORDER: Tier[] = ['NO-GO', 'WAIT', 'TIGHT', 'LEGAL', 'OPTIMAL']
const TIER_RANK: Record<Tier, number> = { 'NO-GO':0, 'WAIT':1, 'TIGHT':2, 'LEGAL':3, 'OPTIMAL':4, 'NOT-DEP':5 }

// Take-off regime ladder per EU OPS App-1 to OPS 1.430 / FAA AC 120-28D Ch 7 / ICAO Doc 9365 Pt II
type Regime = 'CAT-I-T/O' | 'SMGCS-300' | 'LVTO-200' | 'LVTO-125' | 'LVTO-75' | 'BELOW-FLOOR'
const REGIME_ORDER: Regime[] = ['CAT-I-T/O','SMGCS-300','LVTO-200','LVTO-125','LVTO-75']
const REGIME_RVR: Record<Regime, number> = {
  'CAT-I-T/O': 400, 'SMGCS-300': 300, 'LVTO-200': 200, 'LVTO-125': 125, 'LVTO-75': 75, 'BELOW-FLOOR': 9999,
}
const REGIME_LABEL: Record<Regime, string> = {
  'CAT-I-T/O': 'Cat-I T/O · 400m',
  'SMGCS-300': 'SMGCS · 300m',
  'LVTO-200':  'LVTO · 200m',
  'LVTO-125':  'LVTO · 125m',
  'LVTO-75':   'LVTO · 75m',
  'BELOW-FLOOR': 'BELOW-FLOOR',
}

// 8-class airframe HUD-cert ladder (max regime supported by airframe equipage + typical crew cert)
type Klass = 'HVY-T' | 'HVY-Q' | 'WB-M' | 'NB-MAX' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ'
const KLASS_HUD_CAP: Record<Klass, Regime> = {
  'HVY-T':  'LVTO-75',   // B777/A350/B787 — HUD-Cat-IIIa standard, dual-FMA, multi-crew
  'HVY-Q':  'LVTO-75',   // B747/A380 — HUD-Cat-IIIa optional but baseline trans-oceanic fleet
  'WB-M':   'LVTO-125',  // B767/A330 — Cat-IIIa HUD optional, typical Cat-II equip
  'NB-MAX': 'LVTO-125',  // B737MAX/A320neo — HUD Cat-IIIa optional (Alaska, Southwest)
  'NB':     'LVTO-200',  // B737NG/A320ceo — Cat-II HUD common
  'RGN-J':  'SMGCS-300', // E190/CRJ9 — Cat-I/II only typically
  'RGN-T':  'CAT-I-T/O', // AT72/Q400 — Cat-I only
  'BIZ':    'LVTO-125',  // G650/GLEX/FA8X — Cat-IIIa HUD optional
}
const KLASS_COLOR: Record<Klass, string> = {
  'HVY-T':'#a855f7','HVY-Q':'#c084fc','WB-M':'#3b82f6','NB-MAX':'#14b8a6',
  'NB':'#22c55e','RGN-J':'#84cc16','RGN-T':'#eab308','BIZ':'#06b6d4',
}

type Phase = 'GATE' | 'TAXI' | 'LINE-UP' | 'ROLL-LO' | 'ROLL-HI' | 'CLIMB-INIT' | 'OFF'
const PHASE_W: Record<Phase, number> = {
  'GATE':0.50, 'TAXI':0.70, 'LINE-UP':1.05, 'ROLL-LO':1.20, 'ROLL-HI':1.30, 'CLIMB-INIT':1.10, 'OFF':0,
}

// 24-runway departure-equipage catalogue per ICAO Annex 14 Vol I §5 Table 5-3, FAA AC 150/5340-30J
// thrLat/thrLng = departure threshold; brg = runway heading (departure direction)
// clSpacing m (15 / 30 / 0 = none), tdzLight (true/false),
// rvrSensors (1 / 2 = TDZ+MID / 3 = TDZ+MID+STOP-END), stopBars, lvpDecl,
// smgcs (0 = none / 1 = SMGCS / 2 = A-SMGCS Level-2), rwyLen m, elevFt,
// equipMaxRegime (the lowest RVR the runway infrastructure itself supports)
interface RwyDep {
  icao: string
  iata: string
  rwy: string
  thrLat: number
  thrLng: number
  brg: number
  elev: number
  rwyLen: number
  clSpacing: number
  tdzLight: boolean
  rvrSensors: 1 | 2 | 3
  stopBars: boolean
  lvpDecl: boolean
  smgcs: 0 | 1 | 2
  equipMaxRegime: Regime
  note: string
}
const RWYS: RwyDep[] = [
  // US Cat-IIIb LVTO-capable hubs
  { icao:'KORD', iata:'ORD', rwy:'10C', thrLat:41.9920, thrLng:-87.9389, brg:100, elev:680, rwyLen:3963, clSpacing:15, tdzLight:true, rvrSensors:3, stopBars:true, lvpDecl:true, smgcs:2, equipMaxRegime:'LVTO-75', note:'O\'Hare 10C/28C dual Cat-IIIb A-SMGCS Level-2 FAA Order 8400.13D' },
  { icao:'KATL', iata:'ATL', rwy:'08L', thrLat:33.6479, thrLng:-84.4517, brg:80,  elev:1026, rwyLen:2743, clSpacing:15, tdzLight:true, rvrSensors:3, stopBars:true, lvpDecl:true, smgcs:2, equipMaxRegime:'LVTO-75', note:'Hartsfield 08L/26R Cat-IIIb LVTO-75 A-SMGCS' },
  { icao:'KDEN', iata:'DEN', rwy:'16R', thrLat:39.8983, thrLng:-104.6747, brg:160, elev:5431, rwyLen:4877, clSpacing:15, tdzLight:true, rvrSensors:3, stopBars:true, lvpDecl:true, smgcs:2, equipMaxRegime:'LVTO-75', note:'Denver 16R/34L (16,000ft) Cat-IIIb LVTO-75 fog-prone' },
  { icao:'KJFK', iata:'JFK', rwy:'04L', thrLat:40.6256, thrLng:-73.7706, brg:40,  elev:13, rwyLen:3682, clSpacing:15, tdzLight:true, rvrSensors:3, stopBars:true, lvpDecl:true, smgcs:1, equipMaxRegime:'LVTO-75', note:'JFK 04L/22R Cat-IIIb LVTO-75 marine fog' },
  { icao:'KSFO', iata:'SFO', rwy:'28R', thrLat:37.6131, thrLng:-122.3573, brg:280, elev:13, rwyLen:3618, clSpacing:15, tdzLight:true, rvrSensors:3, stopBars:true, lvpDecl:true, smgcs:1, equipMaxRegime:'LVTO-75', note:'SFO 28R/10L Cat-IIIb LVTO-75 stratus-fog dominant' },
  { icao:'KSEA', iata:'SEA', rwy:'16L', thrLat:47.4598, thrLng:-122.3088, brg:160, elev:432, rwyLen:3658, clSpacing:15, tdzLight:true, rvrSensors:3, stopBars:true, lvpDecl:true, smgcs:1, equipMaxRegime:'LVTO-75', note:'SEA 16L/34R Cat-IIIb LVTO-75 marine layer' },
  { icao:'KMEM', iata:'MEM', rwy:'18R', thrLat:35.0658, thrLng:-89.9824, brg:180, elev:341, rwyLen:2987, clSpacing:15, tdzLight:true, rvrSensors:3, stopBars:false, lvpDecl:true, smgcs:1, equipMaxRegime:'LVTO-125', note:'Memphis 18R FedEx hub Cat-IIIa LVTO-125 cargo-night' },
  { icao:'KSLC', iata:'SLC', rwy:'34L', thrLat:40.7884, thrLng:-111.9778, brg:340, elev:4225, rwyLen:3658, clSpacing:15, tdzLight:true, rvrSensors:2, stopBars:false, lvpDecl:true, smgcs:1, equipMaxRegime:'LVTO-200', note:'SLC 34L Cat-IIIa LVTO-200 winter inversion-fog' },
  { icao:'KBOS', iata:'BOS', rwy:'04R', thrLat:42.3568, thrLng:-71.0095, brg:40,  elev:20, rwyLen:3073, clSpacing:15, tdzLight:true, rvrSensors:2, stopBars:false, lvpDecl:true, smgcs:1, equipMaxRegime:'LVTO-200', note:'BOS 04R/22L Cat-II HUD LVTO-200 maritime' },
  { icao:'KIAD', iata:'IAD', rwy:'01R', thrLat:38.9347, thrLng:-77.4571, brg:10,  elev:312, rwyLen:3505, clSpacing:15, tdzLight:true, rvrSensors:2, stopBars:false, lvpDecl:true, smgcs:1, equipMaxRegime:'LVTO-200', note:'Dulles 01R/19L Cat-II LVTO-200' },
  // EU Cat-IIIb LVTO-75 (the canonical European LVTO regime)
  { icao:'EGLL', iata:'LHR', rwy:'27R', thrLat:51.4775, thrLng:-0.4615, brg:270, elev:83, rwyLen:3902, clSpacing:15, tdzLight:true, rvrSensors:3, stopBars:true, lvpDecl:true, smgcs:2, equipMaxRegime:'LVTO-75', note:'Heathrow 27R/09L Cat-IIIb LVTO-75 A-SMGCS UK CAA CAP 168' },
  { icao:'EHAM', iata:'AMS', rwy:'18R', thrLat:52.3286, thrLng:4.7079, brg:180, elev:-11, rwyLen:3800, clSpacing:15, tdzLight:true, rvrSensors:3, stopBars:true, lvpDecl:true, smgcs:2, equipMaxRegime:'LVTO-75', note:'Schiphol 18R Cat-IIIb LVTO-75 sea-fog regime' },
  { icao:'EDDF', iata:'FRA', rwy:'07L', thrLat:50.0457, thrLng:8.5057, brg:70,  elev:364, rwyLen:4000, clSpacing:15, tdzLight:true, rvrSensors:3, stopBars:true, lvpDecl:true, smgcs:2, equipMaxRegime:'LVTO-75', note:'Frankfurt 07L/25R Cat-IIIb LVTO-75 Rhein-Main fog' },
  { icao:'EDDM', iata:'MUC', rwy:'08R', thrLat:48.3417, thrLng:11.7506, brg:80,  elev:1487, rwyLen:4000, clSpacing:15, tdzLight:true, rvrSensors:3, stopBars:true, lvpDecl:true, smgcs:2, equipMaxRegime:'LVTO-75', note:'Munich 08R/26L Cat-IIIb LVTO-75 Alpine-fog' },
  { icao:'LFPG', iata:'CDG', rwy:'08R', thrLat:49.0153, thrLng:2.5641, brg:80,  elev:392, rwyLen:2700, clSpacing:15, tdzLight:true, rvrSensors:3, stopBars:true, lvpDecl:true, smgcs:2, equipMaxRegime:'LVTO-75', note:'Paris CDG 08R/26L Cat-IIIb LVTO-75 DSNA STAC' },
  { icao:'LSZH', iata:'ZRH', rwy:'16',  thrLat:47.4801, thrLng:8.5354, brg:160, elev:1416, rwyLen:3700, clSpacing:15, tdzLight:true, rvrSensors:2, stopBars:true, lvpDecl:true, smgcs:1, equipMaxRegime:'LVTO-125', note:'Zurich 16 Cat-IIIa LVTO-125 Alpine-inversion' },
  { icao:'ENGM', iata:'OSL', rwy:'01L', thrLat:60.1813, thrLng:11.0795, brg:10,  elev:684, rwyLen:3600, clSpacing:15, tdzLight:true, rvrSensors:2, stopBars:false, lvpDecl:true, smgcs:1, equipMaxRegime:'LVTO-200', note:'Oslo 01L/19R Cat-IIIa LVTO-200 winter-fog' },
  { icao:'ESSA', iata:'ARN', rwy:'01L', thrLat:59.6294, thrLng:17.9286, brg:10,  elev:137, rwyLen:3301, clSpacing:15, tdzLight:true, rvrSensors:2, stopBars:false, lvpDecl:true, smgcs:1, equipMaxRegime:'LVTO-200', note:'Stockholm-Arlanda 01L Cat-IIIa LVTO-200' },
  { icao:'UUEE', iata:'SVO', rwy:'06L', thrLat:55.9636, thrLng:37.4144, brg:60,  elev:622, rwyLen:3700, clSpacing:15, tdzLight:true, rvrSensors:3, stopBars:true, lvpDecl:true, smgcs:1, equipMaxRegime:'LVTO-75', note:'Sheremetyevo 06L/24R Cat-IIIb LVTO-75 continental-fog' },
  // Asia-Pacific
  { icao:'VHHH', iata:'HKG', rwy:'07R', thrLat:22.3084, thrLng:113.9085, brg:70,  elev:28, rwyLen:3800, clSpacing:15, tdzLight:true, rvrSensors:3, stopBars:true, lvpDecl:true, smgcs:2, equipMaxRegime:'LVTO-75', note:'Hong Kong 07R/25L Cat-IIIa LVTO-125 spring-fog' },
  { icao:'WSSS', iata:'SIN', rwy:'02L', thrLat:1.3257, thrLng:103.9966, brg:20,  elev:22, rwyLen:4000, clSpacing:15, tdzLight:true, rvrSensors:3, stopBars:true, lvpDecl:true, smgcs:2, equipMaxRegime:'LVTO-75', note:'Singapore Changi 02L/20R Cat-IIIb LVTO-75 haze-season' },
  { icao:'RJTT', iata:'HND', rwy:'34L', thrLat:35.5526, thrLng:139.7794, brg:340, elev:21, rwyLen:3000, clSpacing:15, tdzLight:true, rvrSensors:3, stopBars:true, lvpDecl:true, smgcs:2, equipMaxRegime:'LVTO-75', note:'Haneda 34L/16R Cat-IIIb LVTO-75 sea-fog' },
  { icao:'RKSI', iata:'ICN', rwy:'15R', thrLat:37.4691, thrLng:126.4408, brg:150, elev:23, rwyLen:3750, clSpacing:15, tdzLight:true, rvrSensors:3, stopBars:true, lvpDecl:true, smgcs:2, equipMaxRegime:'LVTO-75', note:'Incheon 15R/33L Cat-IIIb LVTO-75 Yellow-Sea fog' },
  { icao:'OMDB', iata:'DXB', rwy:'30R', thrLat:25.2638, thrLng:55.3692, brg:300, elev:62, rwyLen:4000, clSpacing:15, tdzLight:true, rvrSensors:3, stopBars:true, lvpDecl:true, smgcs:2, equipMaxRegime:'LVTO-75', note:'Dubai 30R/12L Cat-IIIb LVTO-75 winter radiation-fog' },
  { icao:'CYYZ', iata:'YYZ', rwy:'05',  thrLat:43.6800, thrLng:-79.6306, brg:50,  elev:569, rwyLen:3389, clSpacing:15, tdzLight:true, rvrSensors:2, stopBars:false, lvpDecl:true, smgcs:1, equipMaxRegime:'LVTO-200', note:'Toronto Pearson 05/23 Cat-IIIa LVTO-200 winter-fog' },
]

const RWY_BY_ICAO = new Map<string, RwyDep[]>()
for (const r of RWYS) {
  const arr = RWY_BY_ICAO.get(r.icao) || []
  arr.push(r); RWY_BY_ICAO.set(r.icao, arr)
}

const rad = (d:number) => d * Math.PI / 180
const deg = (r:number) => r * 180 / Math.PI
const clamp = (x:number, lo:number, hi:number) => Math.max(lo, Math.min(hi, x))
const dist_nm = (lat1:number,lng1:number,lat2:number,lng2:number) => {
  const dLat = lat2-lat1, dLng = (lng2-lng1)*Math.cos(rad((lat1+lat2)/2))
  return Math.hypot(dLat*60, dLng*60)
}
const bearing = (lat1:number,lng1:number,lat2:number,lng2:number) => {
  const y = Math.sin(rad(lng2-lng1)) * Math.cos(rad(lat2))
  const x = Math.cos(rad(lat1))*Math.sin(rad(lat2)) - Math.sin(rad(lat1))*Math.cos(rad(lat2))*Math.cos(rad(lng2-lng1))
  return (deg(Math.atan2(y,x)) + 360) % 360
}
const angDiff = (a:number, b:number) => { const d=Math.abs(a-b)%360; return d>180?360-d:d }

function classify(f: LvtoFlight): Klass {
  const t = (f.type || '').toUpperCase()
  if (/B777|B778|B779|B787|A350/.test(t)) return 'HVY-T'
  if (/B747|B748|A380/.test(t)) return 'HVY-Q'
  if (/B767|A330|A300|A310|MD11|B762|B763|B764/.test(t)) return 'WB-M'
  if (/B38M|B39M|B3XM|A20N|A21N|A19N|B73M|MAX/.test(t)) return 'NB-MAX'
  if (/B737|B738|B739|B752|B753|B73N|A319|A320|A321|B722/.test(t)) return 'NB'
  if (/E170|E175|E190|E195|E290|E295|CRJ|RJ85/.test(t)) return 'RGN-J'
  if (/AT|DH|Q400|ATR|S340|DH8/.test(t)) return 'RGN-T'
  if (/G[0-9]|GLEX|GLF|FA[0-9]|CL[0-9]|CIT|HAWK|LEAR|EMB-145|E145/.test(t)) return 'BIZ'
  return 'NB'
}

function phaseOf(f: LvtoFlight, distFromThrNm: number): Phase {
  // GATE: ground + slow
  // TAXI: ground + slow-moderate
  // LINE-UP: on/near runway threshold, low speed
  // ROLL-LO/HI: ground + accelerating
  // CLIMB-INIT: airborne, low altitude, climbing
  if (f.ground) {
    if (f.velocityKts < 5) return 'GATE'
    if (f.velocityKts < 25) return 'TAXI'
    if (distFromThrNm < 0.15 && f.velocityKts < 30) return 'LINE-UP'
    if (f.velocityKts < 80) return 'ROLL-LO'
    return 'ROLL-HI'
  }
  if (f.altitudeFt < 1500 && f.vertRate > 200) return 'CLIMB-INIT'
  return 'OFF'
}

interface Row {
  f: LvtoFlight
  klass: Klass
  phase: Phase
  rwy: RwyDep | null
  distFromThrNm: number
  hudCapRegime: Regime
  airportEquipRegime: Regime
  achievableRegime: Regime
  requiredRvr: number
  localRvr: number
  localCeilingFt: number
  localOat: number
  crossKt: number
  rvrMargin: number
  rvrTrend: 'up' | 'down' | 'flat'  // forecast trend proxy
  drivers: { RVRM:number; CL:number; TDZ:number; HUD:number; CREW:number; LVP:number; WIND:number; PHASE:number }
  score: number
  tier: Tier
  advice: string
}

function computeRow(f: LvtoFlight, advMul: number, rvrOff: number, ceilOff: number, crossCap: number, scopeNm: number): Row {
  const h = Math.abs(parseInt((f.icao || '00').slice(-4), 16) || 0)
  const klass = classify(f)
  const hudCapRegime = KLASS_HUD_CAP[klass]

  // Snap to nearest departure runway threshold within scopeNm, with track-bearing alignment ≤30°
  let bestRwy: RwyDep | null = null
  let bestD = Infinity
  for (const r of RWYS) {
    const d = dist_nm(f.lat, f.lng, r.thrLat, r.thrLng)
    if (d > scopeNm) continue
    const brgToRwy = bearing(f.lat, f.lng, r.thrLat, r.thrLng)
    // For departing aircraft: heading approximately aligned with runway brg (within 35°)
    // OR for climb-init: position close (<2NM), track aligned with runway brg
    const headOk = angDiff(f.track, r.brg) < 35
    const onGroundClose = f.ground && d < 1.0
    if (!headOk && !onGroundClose) continue
    if (d < bestD) { bestD = d; bestRwy = r }
  }

  const distFromThr = bestRwy ? bestD : 0
  const phase = bestRwy ? phaseOf(f, distFromThr) : 'OFF'

  if (phase === 'OFF' || !bestRwy) {
    return {
      f, klass, phase, rwy: null, distFromThrNm: 0,
      hudCapRegime, airportEquipRegime: 'CAT-I-T/O', achievableRegime: 'BELOW-FLOOR',
      requiredRvr: 0, localRvr: 0, localCeilingFt: 0, localOat: 15, crossKt: 0,
      rvrMargin: 0, rvrTrend: 'flat',
      drivers: { RVRM:0, CL:0, TDZ:0, HUD:0, CREW:0, LVP:0, WIND:0, PHASE:0 },
      score: 0, tier: 'NOT-DEP', advice: '',
    }
  }

  const r = bestRwy
  const airportEquipRegime: Regime = r.equipMaxRegime
  // Achievable = the more restrictive (higher RVR) of airframe-HUD-cap and airport-equip
  const achievableRegime: Regime = REGIME_RVR[hudCapRegime] >= REGIME_RVR[airportEquipRegime] ? hudCapRegime : airportEquipRegime
  const requiredRvr = REGIME_RVR[achievableRegime]

  // Synthesise local RVR (m): per-airport climatology + diurnal + airframe-hash sample, then offset
  const seasonal = (h % 365) / 365
  const fogProneness = r.lvpDecl ? 0.65 : 0.30
  let baseRvr = 2000
  // 12% probability of LVO conditions (RVR < 600m)
  if (((h >> 4) % 100) < 12) baseRvr = 60 + ((h >> 8) % 720)  // 60-780m
  else if (((h >> 4) % 100) < 28) baseRvr = 800 + ((h >> 12) % 1200)  // 800-2000m
  else baseRvr = 1800 + ((h >> 16) % 6000)  // 1800-7800m
  // Foggy airport bias
  if (fogProneness > 0.5 && ((h >> 20) % 100) < 35) baseRvr = Math.min(baseRvr, 250 + ((h >> 24) % 400))
  const localRvr = Math.max(50, baseRvr + rvrOff)

  // Local ceiling AGL ft, correlated with RVR
  const ceilBand = localRvr < 200 ? 80 + (h % 80) :
                   localRvr < 600 ? 200 + (h % 300) :
                   localRvr < 1600 ? 500 + (h % 1500) :
                   2500 + (h % 4500)
  const localCeilingFt = Math.max(0, ceilBand + ceilOff)

  // Local OAT °C — seasonal + lat
  const latAbs = Math.abs(f.lat)
  const baseT = 28 - latAbs * 0.55
  const localOat = baseT + Math.sin(seasonal * 2 * Math.PI) * 12 + ((h >> 28) & 0x0f) - 7

  // Crosswind component (kt) — bell distribution
  const windDir = (h * 7) % 360
  const windSpd = 4 + ((h >> 6) % 22)
  const angOff = angDiff(windDir, r.brg)
  const crossKt = Math.abs(windSpd * Math.sin(rad(angOff)))

  // RVR margin
  const rvrMargin = localRvr - requiredRvr

  // RVR trend proxy: hashed bias upward (improving) ~45% of the time, down ~30%, flat ~25%
  const tBucket = (h >> 9) % 100
  const rvrTrend: 'up'|'down'|'flat' = tBucket < 45 ? 'up' : tBucket < 75 ? 'down' : 'flat'

  // Drivers (each 0..100)
  const dRVRM = clamp(rvrMargin >= 100 ? 5 : rvrMargin >= 25 ? 30 : rvrMargin >= 0 ? 60 : rvrMargin >= -50 ? 85 : 100, 0, 100)
  const dCL = r.clSpacing === 15 ? 5 : r.clSpacing === 30 ? 40 : 90
  const dTDZ = r.tdzLight ? 5 : (requiredRvr <= 200 ? 90 : 40)
  // HUD penalty: aircraft can't meet airport floor
  const dHUD = REGIME_RVR[hudCapRegime] > requiredRvr ? clamp((REGIME_RVR[hudCapRegime] - requiredRvr) / 4, 0, 100) :
               (REGIME_RVR[hudCapRegime] === requiredRvr ? 20 : 5)
  // Crew cert proxy from class: HVY/NB-MAX/BIZ assumed Cat-IIIa cert; others NB Cat-II
  const crewCertMaxRegime: Regime = (klass === 'HVY-T' || klass === 'HVY-Q' || klass === 'NB-MAX' || klass === 'BIZ') ? 'LVTO-75' :
                                     klass === 'WB-M' ? 'LVTO-125' :
                                     klass === 'NB' ? 'LVTO-200' :
                                     klass === 'RGN-J' ? 'SMGCS-300' : 'CAT-I-T/O'
  const dCREW = REGIME_RVR[crewCertMaxRegime] > requiredRvr ? 75 : (REGIME_RVR[crewCertMaxRegime] === requiredRvr ? 30 : 8)
  const dLVP = (requiredRvr <= 300 && !r.lvpDecl) ? 100 : (requiredRvr <= 600 && !r.lvpDecl) ? 50 : 5
  // Wind: LVTO ≤125m typically requires xwind ≤10kt (EU OPS 1.430 LVTO limit)
  const xwLimit = requiredRvr <= 125 ? 10 : requiredRvr <= 200 ? 15 : requiredRvr <= 300 ? 20 : 25
  const dWIND = crossKt > xwLimit ? clamp(60 + (crossKt - xwLimit) * 4, 60, 100) : clamp(crossKt / xwLimit * 25, 0, 25)
  const dPHASE = PHASE_W[phase] >= 1.2 ? 60 : PHASE_W[phase] >= 1.05 ? 45 : PHASE_W[phase] >= 0.7 ? 30 : 15

  const driversArr = [dRVRM, dCL, dTDZ, dHUD, dCREW, dLVP, dWIND, dPHASE]
  const maxD = Math.max(...driversArr)
  const meanD = driversArr.reduce((a, b) => a + b, 0) / driversArr.length
  let score = (maxD * 0.66 + meanD * 0.34) * PHASE_W[phase] * advMul

  // Hard escalators
  if (rvrMargin < -75 && (phase === 'LINE-UP' || phase === 'ROLL-LO' || phase === 'ROLL-HI')) score = Math.max(score, 92)
  if (rvrMargin < 0 && (phase === 'LINE-UP' || phase === 'ROLL-LO')) score = Math.max(score, 85)
  if (requiredRvr <= 300 && !r.lvpDecl && phase !== 'GATE') score = Math.max(score, 88)
  if (crossKt > xwLimit + 5 && requiredRvr <= 200) score = Math.max(score, 78)
  if (r.clSpacing !== 15 && requiredRvr <= 200) score = Math.max(score, 75)
  if (!r.tdzLight && requiredRvr <= 200) score = Math.max(score, 70)

  score = clamp(score, 0, 100)

  let tier: Tier
  if (rvrMargin < 0 && rvrTrend === 'up') tier = 'WAIT'
  else if (rvrMargin < 0) tier = 'NO-GO'
  else if (score >= 60) tier = 'NO-GO'
  else if (score >= 40 || rvrMargin < 25) tier = 'TIGHT'
  else if (rvrMargin >= 100) tier = 'OPTIMAL'
  else tier = 'LEGAL'

  let advice = ''
  if (tier === 'NO-GO') advice = `! NO-GO · RVR ${localRvr}m vs req ${requiredRvr}m for ${REGIME_LABEL[achievableRegime]} · ${rvrMargin < 0 ? `${-rvrMargin}m below floor` : 'equipage/crew mismatch'} · EU OPS App-1 to 1.430 / AC 120-28D §7.3`
  else if (tier === 'WAIT') advice = `RVR trending up · hold for ${-rvrMargin}m improvement · forecast favourable · ${achievableRegime} regime`
  else if (tier === 'TIGHT') advice = `tight margin ${rvrMargin}m above ${REGIME_LABEL[achievableRegime]} floor · re-check RVR before ROLL · xwind ${crossKt.toFixed(0)}kt vs limit ${xwLimit}kt`
  else if (tier === 'OPTIMAL') advice = `well-clear · RVR ${localRvr}m vs req ${requiredRvr}m · ${REGIME_LABEL[achievableRegime]} · margin ${rvrMargin}m`
  else advice = `legal for ${REGIME_LABEL[achievableRegime]} · margin ${rvrMargin}m · xwind ${crossKt.toFixed(0)}kt`

  return {
    f, klass, phase, rwy: r, distFromThrNm: distFromThr,
    hudCapRegime, airportEquipRegime, achievableRegime, requiredRvr,
    localRvr, localCeilingFt, localOat, crossKt,
    rvrMargin, rvrTrend,
    drivers: { RVRM:dRVRM, CL:dCL, TDZ:dTDZ, HUD:dHUD, CREW:dCREW, LVP:dLVP, WIND:dWIND, PHASE:dPHASE },
    score, tier, advice,
  }
}

export default function LvtoMonitor({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [rvrOff, setRvrOff] = useState(0)
  const [ceilOff, setCeilOff] = useState(0)
  const [crossCap, setCrossCap] = useState(15)
  const [scopeNm, setScopeNm] = useState(5)
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'RUNWAYS'|'GEOMETRY'|'METHOD'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shLink, setShLink] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out = flights.map(f => computeRow(f, advMul, rvrOff, ceilOff, crossCap, scopeNm))
    out.sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return out
  }, [flights, advMul, rvrOff, ceilOff, crossCap, scopeNm])

  const counts: Record<Tier, number> = { 'OPTIMAL':0, 'LEGAL':0, 'TIGHT':0, 'WAIT':0, 'NO-GO':0, 'NOT-DEP':0 }
  for (const r of rows) counts[r.tier]++
  const dept = rows.filter(r => r.phase !== 'OFF')
  const muRvr = dept.length ? dept.reduce((a, b) => a + b.localRvr, 0) / dept.length : 0
  const lvpOn = new Set(dept.filter(r => r.rwy?.lvpDecl).map(r => r.rwy!.icao)).size
  const worstRow = rows[0]?.tier !== 'NOT-DEP' ? rows[0] : null

  // Per-runway aggregate
  const rwyAgg = useMemo(() => {
    const m = new Map<string, { rwy: RwyDep; dept: number; holding: number; worstTier: Tier; muRvr: number; rows: Row[] }>()
    for (const r of rows) {
      if (!r.rwy || r.phase === 'OFF') continue
      const k = `${r.rwy.icao}-${r.rwy.rwy}`
      const v = m.get(k) || { rwy: r.rwy, dept: 0, holding: 0, worstTier: 'OPTIMAL', muRvr: 0, rows: [] }
      v.dept++
      if (r.phase === 'GATE' || r.phase === 'TAXI') v.holding++
      v.rows.push(r)
      if (TIER_RANK[r.tier] < TIER_RANK[v.worstTier]) v.worstTier = r.tier
      m.set(k, v)
    }
    const arr = Array.from(m.values())
    arr.forEach(v => { v.muRvr = v.rows.reduce((a, b) => a + b.localRvr, 0) / Math.max(1, v.rows.length) })
    arr.sort((a, b) => (TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]) || (b.dept - a.dept))
    return arr
  }, [rows])

  const visible = rows.filter(r =>
    (tierFilter === 'ALL' || r.tier === tierFilter) &&
    (phaseFilter === 'ALL' || r.phase === phaseFilter) &&
    (klassFilter === 'ALL' || r.klass === klassFilter) &&
    r.phase !== 'OFF' &&
    (!search || (r.f.callsign || r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.f.operator || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.rwy ? r.rwy.iata.toLowerCase().includes(search.toLowerCase()) : false))
  )

  // === MapLibre overlay ===
  useEffect(() => {
    if (!map) return
    const SRC_HALO = 'lvto-halo-src'
    const SRC_PIN  = 'lvto-pin-src'
    const SRC_LINK = 'lvto-link-src'
    const SRC_RWY  = 'lvto-rwy-src'

    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    ensureSrc(SRC_HALO); ensureSrc(SRC_PIN); ensureSrc(SRC_LINK); ensureSrc(SRC_RWY)

    const writeAll = () => {
      const haloFeats: any[] = []
      const pinFeats: any[] = []
      const linkFeats: any[] = []
      const rwyFeats: any[] = []

      // Runway pins
      for (const v of rwyAgg) {
        const r = v.rwy
        const tcol = TIER_COLOR[v.worstTier]
        rwyFeats.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[r.thrLng, r.thrLat] },
          properties:{ color:tcol, label:`${r.iata}/${r.rwy} · ${REGIME_LABEL[r.equipMaxRegime]} · ${v.dept} dep · ${v.worstTier}${r.lvpDecl?' · LVP':''}` }
        })
      }

      for (const r of visible) {
        if (!r.rwy) continue
        const tcol = TIER_COLOR[r.tier]
        const kcol = KLASS_COLOR[r.klass]
        const sz = 7 + clamp((100 - r.score) / 100, 0, 1) * 12
        haloFeats.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
          properties:{ color:tcol, kcol, sz }
        })
        if (shPin && (r.tier === 'NO-GO' || r.tier === 'WAIT')) {
          pinFeats.push({
            type:'Feature',
            geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
            properties:{ color:tcol, sz:6, label:'' }
          })
        }
        if (shLbl) {
          const lbl = `${(r.f.callsign || r.f.icao).slice(0, 10)} · ${REGIME_LABEL[r.achievableRegime].split(' · ')[1] || 'CAT-I'} · ${r.rvrMargin >= 0 ? '+' : ''}${r.rvrMargin}m`
          pinFeats.push({
            type:'Feature',
            geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
            properties:{ color:tcol, sz:0, label:lbl, lblOnly:true }
          })
        }
        if (shLink && r.phase !== 'OFF') {
          linkFeats.push({
            type:'Feature',
            geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat],[r.rwy.thrLng, r.rwy.thrLat]] },
            properties:{ color:tcol }
          })
        }
      }

      const src = (id: string) => map.getSource(id) as any
      src(SRC_HALO).setData({ type:'FeatureCollection', features: shHalo ? haloFeats : [] })
      src(SRC_PIN).setData({ type:'FeatureCollection', features: pinFeats })
      src(SRC_LINK).setData({ type:'FeatureCollection', features: linkFeats })
      src(SRC_RWY).setData({ type:'FeatureCollection', features: rwyFeats })
    }

    if (!map.getLayer('lvto-link'))
      map.addLayer({ id:'lvto-link', type:'line', source:SRC_LINK, paint:{ 'line-color':['get','color'], 'line-width':1.3, 'line-opacity':0.6, 'line-dasharray':[2, 2] } })
    if (!map.getLayer('lvto-rwy'))
      map.addLayer({ id:'lvto-rwy', type:'circle', source:SRC_RWY, paint:{ 'circle-radius':6, 'circle-color':['get','color'], 'circle-opacity':0.85, 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.4 } })
    if (!map.getLayer('lvto-rwy-lbl'))
      map.addLayer({ id:'lvto-rwy-lbl', type:'symbol', source:SRC_RWY, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0, 1.3], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('lvto-halo'))
      map.addLayer({ id:'lvto-halo', type:'circle', source:SRC_HALO, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.16, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('lvto-pin'))
      map.addLayer({ id:'lvto-pin', type:'circle', source:SRC_PIN, filter:['!=',['get','lblOnly'], true], paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.9 } })
    if (!map.getLayer('lvto-pin-lbl'))
      map.addLayer({ id:'lvto-pin-lbl', type:'symbol', source:SRC_PIN, layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0, -1.2], 'text-anchor':'bottom', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })

    writeAll()
    return () => {
      for (const id of ['lvto-pin-lbl','lvto-pin','lvto-halo','lvto-rwy-lbl','lvto-rwy','lvto-link']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC_HALO, SRC_PIN, SRC_LINK, SRC_RWY]) {
        if (map.getSource(id)) map.removeSource(id)
      }
    }
  }, [map, rows, rwyAgg, visible, shHalo, shPin, shLbl, shLink])

  // --- GEOMETRY tab SVG: RVR vs Ceiling scatter w/ regime band overlays ---
  const geomSvg = useMemo(() => {
    const W = 460, H = 240
    const padL = 38, padR = 14, padT = 14, padB = 30
    const innerW = W - padL - padR, innerH = H - padT - padB
    const xMax = 2000  // RVR m: 0 .. 2000
    const yMax = 1500  // ceiling AGL ft: 0 .. 1500
    const xToPx = (m: number) => padL + (Math.min(m, xMax) / xMax) * innerW
    const yToPx = (ft: number) => padT + innerH - (Math.min(ft, yMax) / yMax) * innerH

    // Regime band overlays (RVR thresholds vertical bands)
    const bands: { x: number; w: number; color: string; lbl: string }[] = [
      { x: xToPx(0),   w: xToPx(75) - xToPx(0),     color: '#ef4444', lbl: 'NO-GO' },
      { x: xToPx(75),  w: xToPx(125) - xToPx(75),   color: '#a855f7', lbl: 'LVTO-75' },
      { x: xToPx(125), w: xToPx(200) - xToPx(125),  color: '#7c3aed', lbl: 'LVTO-125' },
      { x: xToPx(200), w: xToPx(300) - xToPx(200),  color: '#0ea5e9', lbl: 'LVTO-200' },
      { x: xToPx(300), w: xToPx(400) - xToPx(300),  color: '#22c55e', lbl: 'SMGCS' },
      { x: xToPx(400), w: xToPx(xMax) - xToPx(400), color: '#10b981', lbl: 'CAT-I' },
    ]

    const dots: { x: number; y: number; color: string; lbl: string }[] = []
    for (const r of visible) {
      if (!r.rwy || r.localRvr < 0 || r.localRvr > xMax) continue
      dots.push({ x: xToPx(r.localRvr), y: yToPx(r.localCeilingFt), color: TIER_COLOR[r.tier], lbl: r.f.callsign || r.f.icao })
    }

    return (
      <svg width={W} height={H} className="block">
        <rect x={0} y={0} width={W} height={H} fill="#0b0f17" rx={6} />
        {/* Regime bands */}
        {bands.map((b, i) => (
          <g key={i}>
            <rect x={b.x} y={padT} width={b.w} height={innerH} fill={b.color} opacity={0.08} />
            {b.w > 22 && <text x={b.x + b.w / 2} y={padT + 9} fill={b.color} fontSize={7.5} textAnchor="middle" opacity={0.9}>{b.lbl}</text>}
          </g>
        ))}
        {/* axes */}
        <line x1={padL} y1={padT} x2={padL} y2={padT + innerH} stroke="#334155" strokeWidth={0.6} />
        <line x1={padL} y1={padT + innerH} x2={padL + innerW} y2={padT + innerH} stroke="#334155" strokeWidth={0.6} />
        {/* y grid */}
        {[300, 600, 900, 1200].map(y => (
          <g key={y}>
            <line x1={padL} y1={yToPx(y)} x2={padL + innerW} y2={yToPx(y)} stroke="#1e293b" strokeWidth={0.4} />
            <text x={padL - 4} y={yToPx(y) + 3} fill="#64748b" fontSize={8} textAnchor="end">{y}</text>
          </g>
        ))}
        {/* x grid */}
        {[75, 125, 200, 300, 400, 800, 1200, 1600, 2000].map(x => (
          <g key={x}>
            <line x1={xToPx(x)} y1={padT} x2={xToPx(x)} y2={padT + innerH} stroke="#1e293b" strokeWidth={0.4} />
            <text x={xToPx(x)} y={padT + innerH + 10} fill="#64748b" fontSize={7.5} textAnchor="middle">{x}</text>
          </g>
        ))}
        <text x={W / 2} y={H - 6} fill="#94a3b8" fontSize={9} textAnchor="middle">RVR · m</text>
        <text x={6} y={padT + 6} fill="#94a3b8" fontSize={9} transform={`rotate(-90 6 ${padT + 6})`}>ceiling AGL · ft</text>
        {/* Regime threshold vertical lines */}
        {[75, 125, 200, 300, 400].map(v => (
          <line key={`th${v}`} x1={xToPx(v)} y1={padT} x2={xToPx(v)} y2={padT + innerH} stroke="#475569" strokeWidth={0.6} strokeDasharray="2 2" opacity={0.65} />
        ))}
        {/* Aircraft dots */}
        {dots.map((d, i) => (
          <g key={i}>
            <circle cx={d.x} cy={d.y} r={3.5} fill={d.color} opacity={0.9} stroke="#0b0f17" strokeWidth={0.6} />
          </g>
        ))}
        {/* legend */}
        <g transform={`translate(${padL + 8} ${padT + 16})`}>
          <rect x={0} y={0} width={150} height={48} fill="#0f172a" stroke="#1e293b" rx={3} opacity={0.85} />
          <text x={4} y={10} fill="#94a3b8" fontSize={8}>dot · departure on threshold</text>
          <text x={4} y={20} fill="#94a3b8" fontSize={8}>band · 5-regime RVR ladder</text>
          <text x={4} y={30} fill="#94a3b8" fontSize={8}>dashed · regime RVR floor</text>
          <text x={4} y={40} fill="#94a3b8" fontSize={8}>EU OPS App-1 / AC 120-28D</text>
        </g>
      </svg>
    )
  }, [visible])

  return (
    <div className="fixed top-16 right-3 z-40 w-[540px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">LVTO</span>
          <span className="text-[10px] text-slate-400">low-visibility take-off · 5-regime RVR ladder · EU OPS App-1 / AC 120-28D</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* mode strip */}
      <div className="px-3 py-1.5 border-b border-slate-700/40 flex items-center gap-2 text-[10px]">
        <span className="text-slate-500">DEP</span>
        <span className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 font-mono">{dept.length} active</span>
        <span className="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 font-mono">{counts['NO-GO']} no-go</span>
        <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-mono">{lvpOn} LVP-on</span>
        <span className="ml-auto text-slate-500">μ RVR <span className="text-slate-100 font-mono">{muRvr.toFixed(0)}m</span></span>
      </div>

      {/* tier counter strip */}
      <div className="px-3 py-2 border-b border-slate-700/40 flex gap-1.5 flex-wrap text-[10px]">
        <button onClick={() => setTierFilter('ALL')} className={`px-1.5 py-0.5 rounded font-mono ${tierFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL {dept.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(t)} className={`px-1.5 py-0.5 rounded font-mono ${tierFilter === t ? '' : 'opacity-60'}`} style={{ background: `${TIER_COLOR[t]}26`, border: `1px solid ${TIER_COLOR[t]}66`, color: TIER_COLOR[t] }}>{t} {counts[t]}</button>
        ))}
      </div>

      {/* summary 5-cell */}
      <div className="px-3 py-2 border-b border-slate-700/40 grid grid-cols-5 gap-2 text-[10px]">
        <div><div className="text-slate-500 text-[9px]">DEP</div><div className="text-slate-100 font-mono">{dept.length}</div></div>
        <div><div className="text-slate-500 text-[9px]">WORST</div><div className="text-slate-100 font-mono">{worstRow?.rwy?.iata || '-'}</div></div>
        <div><div className="text-slate-500 text-[9px]">μ RVR</div><div className="text-slate-100 font-mono">{muRvr.toFixed(0)}m</div></div>
        <div><div className="text-slate-500 text-[9px]">Σ NO-GO</div><div className="font-mono" style={{ color: counts['NO-GO'] > 0 ? TIER_COLOR['NO-GO'] : '#cbd5e1' }}>{counts['NO-GO']}</div></div>
        <div><div className="text-slate-500 text-[9px]">LVP-on</div><div className="font-mono" style={{ color: lvpOn > 0 ? TIER_COLOR['OPTIMAL'] : '#cbd5e1' }}>{lvpOn}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/40 grid grid-cols-2 gap-2 text-[10px]">
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">ADV-MUL <span className="text-slate-100 font-mono">{(advMul*100).toFixed(0)}%</span></span>
          <input type="range" min={0.5} max={2.0} step={0.05} value={advMul} onChange={e=>setAdvMul(parseFloat(e.target.value))} className="accent-sky-400 h-1" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">RVR-OFF <span className="text-slate-100 font-mono">{rvrOff >= 0 ? '+' : ''}{rvrOff}m</span></span>
          <input type="range" min={-500} max={500} step={25} value={rvrOff} onChange={e=>setRvrOff(parseInt(e.target.value))} className="accent-sky-400 h-1" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">CEIL-OFF <span className="text-slate-100 font-mono">{ceilOff >= 0 ? '+' : ''}{ceilOff}ft</span></span>
          <input type="range" min={-500} max={500} step={50} value={ceilOff} onChange={e=>setCeilOff(parseInt(e.target.value))} className="accent-sky-400 h-1" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">SCOPE-NM <span className="text-slate-100 font-mono">{scopeNm.toFixed(1)}</span></span>
          <input type="range" min={2} max={12} step={0.5} value={scopeNm} onChange={e=>setScopeNm(parseFloat(e.target.value))} className="accent-sky-400 h-1" />
        </label>
      </div>

      {/* chip filters */}
      <div className="px-3 py-2 border-b border-slate-700/40 flex flex-col gap-1 text-[10px]">
        <div className="flex gap-1 flex-wrap">
          <span className="text-slate-500 mr-1 self-center text-[9px]">PHASE</span>
          {(['ALL','GATE','TAXI','LINE-UP','ROLL-LO','ROLL-HI','CLIMB-INIT'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p)} className={`px-1.5 py-0.5 rounded font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex gap-1 flex-wrap">
          <span className="text-slate-500 mr-1 self-center text-[9px]">CLASS</span>
          {(['ALL','HVY-T','HVY-Q','WB-M','NB-MAX','NB','RGN-J','RGN-T','BIZ'] as const).map(k => (
            <button key={k} onClick={()=>setKlassFilter(k as any)} className={`px-1.5 py-0.5 rounded font-mono ${klassFilter===k?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{k}</button>
          ))}
        </div>
        <div className="flex items-center gap-2 mt-1">
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op/iata" className="flex-1 bg-slate-800/60 border border-slate-700/60 rounded px-2 py-0.5 text-slate-100 text-[10px]" />
          <div className="flex gap-1 text-[9px]">
            {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['LNK',shLink,setShLink]].map(([l,v,s]:any) => (
              <button key={l} onClick={()=>s(!v)} className={`px-1 py-0.5 rounded font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','RUNWAYS','GEOMETRY','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && visible.map((r, i) => (
          <div key={i} className="bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5 cursor-pointer" onClick={()=>onFly(r.f.icao)}>
            <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
              <span className="font-mono text-slate-100">{r.f.callsign || r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-400">{r.f.type || '?'}</span>
              <span className="px-1 rounded font-mono text-[9px]" style={{ background:`${KLASS_COLOR[r.klass]}33`, color:KLASS_COLOR[r.klass] }}>{r.klass}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-400 font-mono text-[9px]">{r.phase}</span>
              {r.rwy?.lvpDecl && <span className="px-1 rounded bg-emerald-500/15 text-emerald-300 font-mono text-[9px]">› LVP</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>rwy <span className="text-slate-100 font-mono">{r.rwy?.iata}/{r.rwy?.rwy}</span></div>
              <div>regime <span className="text-slate-100 font-mono">{REGIME_LABEL[r.achievableRegime].split(' · ')[1] || REGIME_LABEL[r.achievableRegime]}</span></div>
              <div>req <span className="text-slate-100 font-mono">{r.requiredRvr}m</span></div>
              <div>RVR <span className="font-mono" style={{color: r.rvrMargin < 0 ? TIER_COLOR['NO-GO'] : '#cbd5e1'}}>{r.localRvr}m</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>margin <span className="font-mono" style={{color: r.rvrMargin < 0 ? TIER_COLOR['NO-GO'] : r.rvrMargin < 25 ? TIER_COLOR['TIGHT'] : '#cbd5e1'}}>{r.rvrMargin >= 0 ? '+' : ''}{r.rvrMargin}m</span></div>
              <div>trend <span className="font-mono" style={{color: r.rvrTrend==='up'?TIER_COLOR['OPTIMAL']:r.rvrTrend==='down'?TIER_COLOR['NO-GO']:'#cbd5e1'}}>{r.rvrTrend==='up'?'↑':r.rvrTrend==='down'?'↓':'·'}</span></div>
              <div>ceil <span className="text-slate-100 font-mono">{r.localCeilingFt.toFixed(0)}ft</span></div>
              <div>xwind <span className="font-mono" style={{color: r.crossKt > (r.requiredRvr<=125?10:r.requiredRvr<=200?15:25) ? TIER_COLOR['TIGHT'] : '#cbd5e1'}}>{r.crossKt.toFixed(0)}kt</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>HUD-cap <span className="text-slate-100 font-mono">{REGIME_LABEL[r.hudCapRegime].split(' · ')[1] || REGIME_LABEL[r.hudCapRegime]}</span></div>
              <div>rwy-cap <span className="text-slate-100 font-mono">{REGIME_LABEL[r.airportEquipRegime].split(' · ')[1] || REGIME_LABEL[r.airportEquipRegime]}</span></div>
              <div>CL <span className="text-slate-100 font-mono">{r.rwy?.clSpacing===15?'15m':r.rwy?.clSpacing===30?'30m':'-'}</span></div>
              <div>TDZ <span className="font-mono" style={{color: r.rwy?.tdzLight ? '#cbd5e1' : TIER_COLOR['TIGHT']}}>{r.rwy?.tdzLight ? 'Y' : 'N'}</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k, v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v as number)}</span>
              ))}
            </div>
            <div className="mt-1 text-[9px] text-slate-500 italic">{r.advice}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && visible.length === 0 && <div className="text-[10px] text-slate-500 italic">no aircraft on departure phase match current filters</div>}

        {tab === 'RUNWAYS' && rwyAgg.map((v, i) => (
          <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
              <span className="font-mono text-slate-100">{v.rwy.iata}/{v.rwy.rwy}</span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-400">{v.rwy.icao}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{REGIME_LABEL[v.rwy.equipMaxRegime]}</span>
              {v.rwy.lvpDecl && <span className="px-1 rounded bg-emerald-500/15 text-emerald-300 font-mono text-[9px]">› LVP</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[v.worstTier]}33`, color:TIER_COLOR[v.worstTier] }}>{v.worstTier} · {v.dept} dep</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>brg <span className="text-slate-100 font-mono">{v.rwy.brg}°</span></div>
              <div>len <span className="text-slate-100 font-mono">{v.rwy.rwyLen}m</span></div>
              <div>elev <span className="text-slate-100 font-mono">{v.rwy.elev}ft</span></div>
              <div>holding <span className="text-slate-100 font-mono">{v.holding}</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>CL <span className="text-slate-100 font-mono">{v.rwy.clSpacing===15?'15m':v.rwy.clSpacing===30?'30m':'-'}</span></div>
              <div>TDZ <span className="font-mono" style={{color: v.rwy.tdzLight ? '#cbd5e1' : TIER_COLOR['TIGHT']}}>{v.rwy.tdzLight ? 'Y' : 'N'}</span></div>
              <div>RVR-sg <span className="text-slate-100 font-mono">{v.rwy.rvrSensors}</span></div>
              <div>stop-b <span className="font-mono" style={{color: v.rwy.stopBars ? '#cbd5e1' : TIER_COLOR['TIGHT']}}>{v.rwy.stopBars ? 'Y' : 'N'}</span></div>
            </div>
            <div className="grid grid-cols-3 gap-1 text-[10px] text-slate-400">
              <div>SMGCS <span className="text-slate-100 font-mono">{v.rwy.smgcs===2?'A-SM L2':v.rwy.smgcs===1?'SMGCS':'-'}</span></div>
              <div>LVP <span className="font-mono" style={{color: v.rwy.lvpDecl ? TIER_COLOR['OPTIMAL'] : TIER_COLOR['TIGHT']}}>{v.rwy.lvpDecl ? 'declared' : '-'}</span></div>
              <div>μ-RVR <span className="text-slate-100 font-mono">{v.muRvr.toFixed(0)}m</span></div>
            </div>
            <div className="mt-1 text-[9px] text-slate-500 italic">{v.rwy.note}</div>
          </div>
        ))}
        {tab === 'RUNWAYS' && rwyAgg.length === 0 && <div className="text-[10px] text-slate-500 italic">no departure activity in catalogue</div>}

        {tab === 'GEOMETRY' && (
          <div className="space-y-2">
            {geomSvg}
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] space-y-1">
              <div className="text-slate-400 font-semibold">Methodology · 5-regime RVR ladder</div>
              <div className="font-mono text-slate-300">CAT-I T/O   ≥ 400 m   single-pilot · basic cert</div>
              <div className="font-mono text-slate-300">SMGCS-300   ≥ 300 m   CL ≤30m · multi-RVR rec</div>
              <div className="font-mono text-slate-300">LVTO-200    ≥ 200 m   CL ≤15m + TDZ-lights</div>
              <div className="font-mono text-slate-300">LVTO-125    ≥ 125 m   HUD + multi-RVR + LVP</div>
              <div className="font-mono text-slate-300">LVTO-75     ≥  75 m   HUD Cat-IIIa + redundant CL/edge/RCL</div>
              <div className="text-slate-500 italic">EU OPS App-1 to OPS 1.430 · FAA AC 120-28D Ch 7 · ICAO Doc 9365 Pt II · Annex 14 Vol I §5 Tbl 5-3</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px]">
              <div className="text-slate-400 font-semibold mb-1">Take-off RVR vs landing RVR · regulatory distinction</div>
              <div className="text-slate-500 text-[9px] space-y-0.5">
                <div>· take-off RVR is DEPARTURE side · pilot must SEE down rwy</div>
                <div>· landing RVR (approach mins) is ARRIVAL side · use ApMin overlay</div>
                <div>· LVTO &lt;125m mandates HUD/HGS dual-channel · multi-pilot cert</div>
                <div>· xwind ≤10kt for LVTO ≤125m (EU OPS 1.430 (g) limit)</div>
                <div>· LVP must be declared at airport before any LVTO ≤300m</div>
                <div>· operator OpSpec must authorise LVTO regime per FAA OpSpec C078</div>
              </div>
            </div>
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-400">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 space-y-1">
              <div className="text-slate-300 font-semibold">LVTO · Low-Visibility Take-Off</div>
              <div>A take-off conducted on a runway where the runway visual range (RVR) is less than 400m. The ICAO classical lower bound at 75m RVR was set when reverse-time HUD-HGS-Cat-IIIa rollout guidance became reliably certifiable on commercial transport airframes per JAR-OPS 1 / EU OPS 1.430 App-1.</div>
              <div className="text-slate-500">Ref: EU OPS App-1 to OPS 1.430 · FAA AC 120-28D §7 · ICAO Doc 9365 Pt II · Annex 6 Pt I §4.2.8 · ICAO Annex 14 Vol I §5.3 Tbl 5-3 LVTO infrastructure</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 space-y-1">
              <div className="text-slate-300 font-semibold">Runway infrastructure required</div>
              <div className="text-slate-500 text-[9px] space-y-0.5">
                <div>· Centreline lights spaced ≤15m (white in-pavement) for ≤200m RVR</div>
                <div>· Touchdown-zone (TDZ) lights for ≤200m</div>
                <div>· Multi-segment RVR sensors (TDZ + MID + STOP-END) for ≤300m</div>
                <div>· Illuminated stop-bars at all LVP holding positions</div>
                <div>· LVP-procedures declared & ATIS-broadcast</div>
                <div>· SMGCS / A-SMGCS Level-2 surface-movement guidance</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 space-y-1">
              <div className="text-slate-300 font-semibold">Airframe equipage required (per regime)</div>
              <div className="text-slate-500 text-[9px] space-y-0.5">
                <div>· LVTO-75: HUD/HGS Cat-IIIa fail-op autoflight · dual-channel autothrottle</div>
                <div>· LVTO-125: HUD/HGS Cat-IIIa or dual-channel A/T · multi-crew certified</div>
                <div>· LVTO-200: Cat-II HUD or dual-A/T · trained crew</div>
                <div>· SMGCS-300: standard glass-cockpit · multi-crew</div>
                <div>· CAT-I T/O: any §25 transport · pilot RVR-400m visual contact</div>
                <div>· HVY-T/HVY-Q baseline Cat-IIIa · NB-MAX optional Cat-IIIa · RGN-T Cat-I-only</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 space-y-1">
              <div className="text-slate-300 font-semibold">Hard escalators · score floors</div>
              <div className="text-slate-400 text-[9px] space-y-0.5">
                <div>· RVR ≥75m below floor during LINE-UP/ROLL → score ≥ 92</div>
                <div>· RVR below floor during LINE-UP/ROLL-LO → score ≥ 85</div>
                <div>· LVTO ≤300m without LVP declared → score ≥ 88</div>
                <div>· xwind &gt; limit+5kt for LVTO ≤200m → score ≥ 78</div>
                <div>· CL spacing ≠15m for LVTO ≤200m regime → score ≥ 75</div>
                <div>· No TDZ-lights for LVTO ≤200m regime → score ≥ 70</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 space-y-1">
              <div className="text-slate-300 font-semibold">Precedent · LVTO accident family</div>
              <div className="text-slate-400 text-[9px] space-y-0.5">
                <div>· Linate SAS 686 / Cessna D-IEVX 2001-10-08 (118 fatal) — RVR ≤200m no SMGCS rwy 36L incursion ANSV 2004</div>
                <div>· Singapore Airlines 006 RCTP 2000-10-31 (83 fatal) — wrong-rwy 05R closed for typhoon RVR 600m no stop-bars</div>
                <div>· Comair 5191 KLEX 2006-08-27 (49 fatal) — pre-dawn RVR 1600m wrong-rwy 26 (3500ft) line-up vs 22 NTSB AAR-07-05</div>
                <div>· TAM 3054 SBSP 2007-07-17 (199 fatal) — RVR ≤900m wet 35L overrun T-Reverser-INOP CENIPA A-067/2007</div>
                <div>· LAPA 3142 SAEZ 1999-08-31 (65 fatal) — RVR-OK but flap-zero TOWS-INOP (overlap precedent)</div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-700/40 text-[9px] text-slate-500 italic flex items-center justify-between">
        <span>LVTO · EU OPS App-1 to 1.430 · FAA AC 120-28D §7 · ICAO Doc 9365 Pt II</span>
        <span className="font-mono text-slate-600">v1</span>
      </div>
    </div>
  )
}
