// AAR · Air-to-Air Refueling Track / Tanker-Receiver Compatibility & Boom-Drogue Service-Match Monitor
//
// What this is
// ------------
// A per-airframe live evaluator of every airborne MILITARY platform's air-to-air-refueling
// (AAR) eligibility, receptacle type (boom vs probe-and-drogue), nearest compatible tanker
// within practical range, currently-active AR-track corridor (USAF Air-Refueling Track
// catalogue + NATO/RAF tracks), tanker-formation rendezvous geometry, and MARSA
// (Military Accepts Responsibility for Separation of Aircraft) joinup probability.
//
// This is the live-map analog of the USAF/USN/USMC AR-track operations picture that a
// tanker-flight-following ATC controller would maintain, projected onto the ADS-B/MLAT
// military traffic snapshot — analytically distinct from any existing flight-tracker
// overlay (no civilian-fuel-tankering or fuel-flow component overlaps this domain).
//
// Distinct from / complementary to existing overlays:
//   · FUEL-TANKERING — civilian economics of carrying extra fuel sector-to-sector
//                       (extra burn vs price differential), no AAR coupling
//   · FUEL-TEMP / RESERVE / FUEL-IMBALANCE — fuel-state monitoring, no AAR
//   · ETOPS / ETP / CP — twin-engine diversion-time per CAT.IDE.A.215, no AAR
//   · FORMATION-PANEL — tactical formation-flight density (general fingertip / trail /
//                        echelon spacing), no boom/drogue compatibility logic
//   · OWL-JETTISON — fuel jettison flight-planning, no AAR
//   · BOOM-SUPERSONIC — sonic-boom over-pressure carpet, no AAR
//   · ADIZ — Air-Defense Identification Zone, no AAR
//
// AAR is uniquely the AIR-REFUELING DOMAIN evaluator covering the tanker-receiver
// compatibility matrix (BOOM single-point USAF heavy-bomber/fighter vs PROBE-AND-DROGUE
// multipoint USN/USMC/NATO fighter/heli/V-22), the AR-track geographic catalogue (USAF
// AR-1xx anchor/track racetracks + KC-46/KC-135/KC-10 unit basing), and the rendezvous
// geometry (rendezvous airspeed 270-310 KIAS, refueling altitude FL180-FL270 typical,
// receiver-tanker joinup vector under MARSA).
//
// Operational background
// ----------------------
//   Two boom-vs-drogue physical interfaces dominate AAR worldwide per ATP-3.3.4.2
//   NATO Air-to-Air Refueling Manual ed.G, AFI 11-235 (USAF), NTRP 3-22.4-VAQ (USN),
//   MIL-STD-1709C (boom-receptacle), MIL-STD-1791E (probe-drogue):
//
//   1. BOOM (Flying Boom System) — USAF standard since KC-97 Stratofreighter 1950s.
//      Receiver has a fixed receptacle on upper fuselage (B-1 / B-2 / B-52 / F-15 / F-16
//      / F-22 / F-35A / E-3 / E-4 / C-5 / C-17 / KC-46 etc.). Tanker boom-operator flies
//      the boom into the receiver receptacle. Single-point connection. Fuel flow up to
//      6,000 lbs/min (KC-46 / KC-135). Boom-equipped tankers: KC-135R/T, KC-10A, KC-46A,
//      KC-30A (RAAF), A330 MRTT (boom variant for ROKAF/UAE/Singapore).
//
//   2. PROBE-AND-DROGUE (Hose-Reel System / Wing Pods) — USN/USMC/RAF/NATO standard.
//      Receiver has an extendable probe (F/A-18 / F-35B / F-35C / EA-18G / V-22 /
//      Eurofighter / Rafale / Gripen / Mirage / Tornado / Harrier / Sea King / NH90).
//      Tanker trails a flexible hose terminating in a basket (drogue). Receiver flies
//      probe into basket. Multi-point (2-3 hoses typically). Fuel flow up to ~1,800
//      lbs/min/pod. Probe-drogue tankers: KC-130J, KC-10A (centerline hose), KC-46A
//      (centerline + wing pods), KA-6D, S-3B (retired), A330 MRTT pod variant.
//
//   3. UDF (Universal Drogue Fitting) — bilateral conversion kits allow some boom
//      tankers to be reconfigured with a Boom-Drogue-Adapter (BDA) for cross-service
//      operations, e.g., USAF KC-10 with Mk32B pods can refuel USN/USMC probe-equipped
//      receivers. Per AMC NOTAM K-AAR / USAF AFI 11-2KC-10 Vol.3.
//
// AR-track catalogue (USAF/FAA refueling track racetracks per FAA Order JO 7110.65BB
// §10-1-2, AFI 13-201, AP/1B, AP/3 Mil Aero Pubs, EUROCONTROL EAUP refueling areas):
//   AR-105 PA→VA East Coast B-2 / F-15 / F-22 anchor at KDOV
//   AR-115 OH/PA Hi-Alt KC-135 anchor at KSWF
//   AR-202 FL panhandle bomber egress KMQT
//   AR-215 Gulf East CONUS-Pac receiver outbound
//   AR-302 TX/LA panhandle KAFW/KBAD KC-135
//   AR-401 GA/SC East CONUS B-52/B-1 anchor KRBM
//   AR-553 CA Coastal F/A-18/F-35B (Mk32B drogue) anchor KNFL
//   AR-625 NV/UT high-altitude F-22/F-35A Red-Flag MOA
//   AR-712 MT/ND B-52 Hi-Alt North-CONUS
//   AR-911 AK Yukon coastal F-22/F-35A
//   AR-1004 HI Pacific PACAF receivers
//   AR-115B UK CONUS-Atlantic FANS-1A oceanic
//   NATO AR-04 GE high-altitude EurFighter anchor
//   NATO AR-31 IT Mediterranean Rafale/Typhoon
//   NATO AR-67 NO/SE Nordic anchor Gripen/F-35A
//
// Per-class catalogue (military receiver-tanker compatibility per ATP-3.3.4.2
// + AFI 11-235 + NTRP 3-22.4-VAQ):
//   USAF-FTR-A     F-22A / F-15E / F-16C boom receptacle (single-point)
//   USAF-FTR-B     F-35A boom receptacle, low-RCS receptacle door cycle
//   USN-FTR-PD     F/A-18E/F / F-35C / EA-18G probe extending starboard nose
//   USMC-FTR-PD    F-35B / V-22 / AV-8B+ probe extending starboard nose
//   USAF-BMR       B-1B / B-2A / B-52H boom-only (large)
//   USAF-HVY       C-5M / C-17A / KC-46A self / E-3G / E-4B boom
//   NATO-FTR-PD    Typhoon / Rafale / Gripen / Tornado / Mirage 2000 probe
//   NATO-HVY-PD    A400M / C-130J / E-7 / NH90 / Tornado-IDS probe
//   TKR-BOOM       KC-135R/T / KC-46A / KC-10A / KC-30A boom-equipped
//   TKR-PD         KC-130J / KC-10A (centerline) / A330MRTT-pod / Hose-Drum-Units
//   TKR-DUAL       KC-46A / A330 MRTT pod variant — boom + wing pods
//
// Tier system (5 tiers + OFF):
//   READY-AAR       Receiver in AR-track, compatible tanker within rendezvous range,
//                   fuel state requesting top-up (synth from icao24 hash 12-58%
//                   internal fuel) → score ≥ 80 (active joinup imminent)
//   PENDING-AAR     Receiver in AR-track, compatible tanker within range but tanker
//                   not yet on track or receiver formation forming up → score ≥ 60
//   COMPATIBLE      Receiver in CONUS military-traffic envelope, compatible tanker
//                   exists in catalogue but no immediate proximity → score ≥ 35
//   INCOMPATIBLE    Receiver type known but NO compatible tanker within rendezvous
//                   envelope (boom-receiver in drogue-only region or vice versa)
//                   → score ≥ 20 (operational gap, divert / alternate-tanker request)
//   NON-AAR         Civilian or non-AAR-equipped military (transport, intel, ELINT)
//                   → score < 20 (OFF the AAR domain)
//
// Drivers (7):
//   COMPAT     - boom-vs-drogue receptacle/tanker mismatch (binary big-hit if hard fail)
//   PROX       - distance receiver→nearest-compatible-tanker (ramp 0..400 NM)
//   AR-TRACK   - in/near an AR-track anchor point (within 60 NM corridor) → big hit
//   FUEL-LO    - synthesised receiver internal fuel state (12-58% → AAR-request flag)
//   ALT-WIN    - in refueling altitude window FL180-FL270 (vs cruise FL310+)
//   SPD-WIN    - speed window 270-310 KIAS for rendezvous
//   FORMATION  - leader/wingman role within 5 NM lateral separation amplifier

'use client'

import React, { useEffect, useMemo, useState } from 'react'
import maplibregl from 'maplibre-gl'

type Tier = 'READY-AAR' | 'PENDING-AAR' | 'COMPATIBLE' | 'INCOMPATIBLE' | 'NON-AAR' | 'OFF'
const TIER_COLOR: Record<Tier, string> = {
  'READY-AAR':'#10b981', 'PENDING-AAR':'#0ea5e9', 'COMPATIBLE':'#f59e0b',
  'INCOMPATIBLE':'#f43f5e', 'NON-AAR':'#475569', 'OFF':'#334155'
}
const TIER_RANK: Record<Tier, number> = {
  'READY-AAR':0, 'PENDING-AAR':1, 'COMPATIBLE':2, 'INCOMPATIBLE':3, 'NON-AAR':4, 'OFF':5
}
const TIER_ORDER: Tier[] = ['READY-AAR','PENDING-AAR','COMPATIBLE','INCOMPATIBLE','NON-AAR']

type Receptacle = 'BOOM' | 'PROBE' | 'DUAL' | 'NONE'
type TankerProvision = 'BOOM' | 'PROBE' | 'DUAL' | 'NONE'

interface ClassSpec {
  cls: string
  label: string
  receptacle: Receptacle        // receiver port type
  provision: TankerProvision    // if this is a tanker, what it provides
  isTanker: boolean
  fuelCapKg: number             // approximate full-fuel kg
  rendKtas: number              // rendezvous TAS at AR-block
  rendFlMin: number             // typical AR floor FL
  rendFlMax: number             // typical AR ceiling FL
  service: 'USAF'|'USN'|'USMC'|'NATO'|'RAF'|'RAAF'|'JASDF'|'ROKAF'|'OTHER'
}

const SPECS: ClassSpec[] = [
  // Receivers — USAF boom
  { cls:'USAF-FTR-A',  label:'F-22A / F-15E / F-16C boom receptacle',                    receptacle:'BOOM',  provision:'NONE', isTanker:false, fuelCapKg:5700,  rendKtas:295, rendFlMin:200, rendFlMax:280, service:'USAF' },
  { cls:'USAF-FTR-B',  label:'F-35A boom receptacle low-RCS receptacle door',            receptacle:'BOOM',  provision:'NONE', isTanker:false, fuelCapKg:8100,  rendKtas:290, rendFlMin:200, rendFlMax:280, service:'USAF' },
  { cls:'USAF-BMR',    label:'B-1B / B-2A / B-52H bomber boom-only',                     receptacle:'BOOM',  provision:'NONE', isTanker:false, fuelCapKg:120000, rendKtas:300, rendFlMin:200, rendFlMax:270, service:'USAF' },
  { cls:'USAF-HVY',    label:'C-5M / C-17A / KC-46A self / E-3G / E-4B boom',            receptacle:'BOOM',  provision:'NONE', isTanker:false, fuelCapKg:135000, rendKtas:300, rendFlMin:210, rendFlMax:280, service:'USAF' },
  // Receivers — USN/USMC probe
  { cls:'USN-FTR-PD',  label:'F/A-18E/F · F-35C · EA-18G probe starboard nose',          receptacle:'PROBE', provision:'NONE', isTanker:false, fuelCapKg:6800,  rendKtas:285, rendFlMin:180, rendFlMax:260, service:'USN' },
  { cls:'USMC-FTR-PD', label:'F-35B · V-22 · AV-8B+ probe starboard nose',               receptacle:'PROBE', provision:'NONE', isTanker:false, fuelCapKg:6100,  rendKtas:280, rendFlMin:160, rendFlMax:240, service:'USMC' },
  // Receivers — NATO/RAF/EU probe
  { cls:'NATO-FTR-PD', label:'Typhoon · Rafale · Gripen · Tornado · Mirage-2000 probe',  receptacle:'PROBE', provision:'NONE', isTanker:false, fuelCapKg:5400,  rendKtas:285, rendFlMin:180, rendFlMax:260, service:'NATO' },
  { cls:'NATO-HVY-PD', label:'A400M · C-130J · E-7 · NH90 · Tornado-IDS probe',          receptacle:'PROBE', provision:'NONE', isTanker:false, fuelCapKg:36000, rendKtas:275, rendFlMin:160, rendFlMax:230, service:'NATO' },
  // Tankers
  { cls:'TKR-BOOM',    label:'KC-135R/T · KC-10A · KC-30A · A330MRTT boom',              receptacle:'NONE',  provision:'BOOM', isTanker:true,  fuelCapKg:90000, rendKtas:300, rendFlMin:200, rendFlMax:280, service:'USAF' },
  { cls:'TKR-PD',      label:'KC-130J · KC-10A centerline · A330MRTT pod · Mk32B HDU',   receptacle:'NONE',  provision:'PROBE',isTanker:true,  fuelCapKg:35000, rendKtas:265, rendFlMin:170, rendFlMax:240, service:'USMC' },
  { cls:'TKR-DUAL',    label:'KC-46A · A330 MRTT dual · MRTT-EU boom + wing pods',       receptacle:'NONE',  provision:'DUAL', isTanker:true,  fuelCapKg:96000, rendKtas:295, rendFlMin:200, rendFlMax:280, service:'USAF' },
]

// === Aircraft-type ↔ class hash (ICAO type designator first; callsign fallback)
function specOf(type?: string, callsign?: string): ClassSpec | null {
  const t = (type||'').toUpperCase()
  const cs = (callsign||'').toUpperCase()
  // Tankers
  if (/^(K35R|K35E|KC35|KC135|R135|RC135)/.test(t)) return SPECS[8]
  if (/^(KC10|DC10|KDC10)/.test(t)) return SPECS[8]
  if (/^(KC30|K30)/.test(t)) return SPECS[8]
  if (/^(KC46|K46)/.test(t)) return SPECS[10]
  if (/^(K130|KC130)/.test(t)) return SPECS[9]
  if (/^A330$/.test(t) && /^(RRR|REACH|MRTT|NATO|TANK|QUID)/.test(cs)) return SPECS[10]
  // Receivers — USAF fighters (boom)
  if (/^(F22|F22A|F35A|F35|F16|F15|F15E|F15C)/.test(t)) {
    if (/^F35A$/.test(t)) return SPECS[1]
    if (/^F35$/.test(t)) return SPECS[1]
    return SPECS[0]
  }
  // USN/USMC probe
  if (/^(F18|FA18|F18E|F18F|F35B|F35C|EA18)/.test(t)) {
    if (/^F35B$/.test(t)) return SPECS[5]
    if (/^F35C$/.test(t)) return SPECS[4]
    return SPECS[4]
  }
  if (/^(V22|MV22|CV22|AV8|AV8B|H53|CH53)/.test(t)) return SPECS[5]
  // NATO/EU fighters (probe)
  if (/^(EUFI|TYP|RFAL|RAFA|GRIP|JAS3|TOR|TORN|MIR2|MIR4|F2TH)/.test(t)) return SPECS[6]
  if (/^(A400|A400M|C130|C30J|NH90|MERLIN|E7T|E737)/.test(t)) return SPECS[7]
  // USAF bombers (boom)
  if (/^(B1|B1B|B2|B2A|B52|B52H)/.test(t)) return SPECS[2]
  // USAF heavies (boom)
  if (/^(C5|C5M|C17|E3|E3G|E4|E4B|RC135|VC25|C32|C40)/.test(t)) return SPECS[3]
  // Callsign-driven fallback for unidentified types
  if (/^(REACH|RCH|EAGLE|HOG|VENOM|VIPER|HORNET|RHINO|LIGHTNING)/.test(cs)) {
    // assume probe-USN or boom-USAF by callsign convention
    if (/HORNET|RHINO|VENOM/.test(cs)) return SPECS[4]
    return SPECS[0]
  }
  return null  // civilian/non-AAR
}

interface MFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props {
  map: maplibregl.Map | null
  flights: MFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

// === AR-track catalogue (USAF + NATO + RAF anchors per FAA JO 7110.65BB §10-1-2,
// AFI 13-201 §6, AP/1B Mil Aero Pubs, EUROCONTROL EAUP refueling-area DB)
interface ARTrack {
  id: string
  label: string
  lat: number
  lng: number
  hdg: number          // anchor inbound heading deg
  flMin: number
  flMax: number
  receptacle: Receptacle | 'BOTH'
  region: 'CONUS-E'|'CONUS-W'|'CONUS-N'|'CONUS-S'|'AK'|'HI'|'NATO'|'PAC'|'MED'
}

const TRACKS: ARTrack[] = [
  { id:'AR-105',  label:'PA→VA East Coast B-2/F-15/F-22 KDOV',            lat:39.10, lng:-75.45, hdg:170, flMin:220, flMax:280, receptacle:'BOOM', region:'CONUS-E' },
  { id:'AR-115',  label:'OH/PA Hi-Alt KC-135 KSWF',                       lat:41.50, lng:-78.10, hdg:90,  flMin:230, flMax:280, receptacle:'BOOM', region:'CONUS-E' },
  { id:'AR-202',  label:'FL panhandle bomber egress KMQT',                 lat:30.20, lng:-86.50, hdg:270, flMin:210, flMax:270, receptacle:'BOOM', region:'CONUS-S' },
  { id:'AR-215',  label:'Gulf East CONUS-Pac outbound',                    lat:28.60, lng:-91.20, hdg:230, flMin:200, flMax:270, receptacle:'BOOM', region:'CONUS-S' },
  { id:'AR-302',  label:'TX/LA panhandle KAFW/KBAD KC-135',                lat:32.40, lng:-94.80, hdg:180, flMin:210, flMax:270, receptacle:'BOOM', region:'CONUS-S' },
  { id:'AR-401',  label:'GA/SC East CONUS B-52/B-1 KRBM',                  lat:32.95, lng:-80.40, hdg:50,  flMin:220, flMax:280, receptacle:'BOOM', region:'CONUS-E' },
  { id:'AR-553',  label:'CA Coastal F/A-18/F-35B Mk32B drogue KNFL',       lat:38.10, lng:-122.80, hdg:280, flMin:180, flMax:240, receptacle:'PROBE', region:'CONUS-W' },
  { id:'AR-625',  label:'NV/UT high-altitude F-22/F-35A Red-Flag MOA',     lat:38.40, lng:-116.20, hdg:70,  flMin:230, flMax:280, receptacle:'BOTH', region:'CONUS-W' },
  { id:'AR-712',  label:'MT/ND B-52 Hi-Alt North-CONUS',                   lat:47.80, lng:-104.50, hdg:90,  flMin:240, flMax:280, receptacle:'BOOM', region:'CONUS-N' },
  { id:'AR-820',  label:'WA/OR coastal F-15/F-22 PNW',                     lat:46.30, lng:-123.40, hdg:200, flMin:220, flMax:280, receptacle:'BOOM', region:'CONUS-W' },
  { id:'AR-911',  label:'AK Yukon coastal F-22/F-35A PACAF',               lat:63.50, lng:-149.20, hdg:330, flMin:210, flMax:280, receptacle:'BOTH', region:'AK' },
  { id:'AR-1004', label:'HI Pacific PACAF receivers KHIK',                 lat:21.60, lng:-158.50, hdg:240, flMin:200, flMax:270, receptacle:'BOTH', region:'HI' },
  { id:'AR-115B', label:'UK CONUS-Atlantic FANS-1A oceanic',               lat:53.10, lng:-12.50, hdg:280, flMin:230, flMax:290, receptacle:'BOOM', region:'NATO' },
  { id:'AR-04N',  label:'NATO AR-04 GE high-altitude EurFighter anchor',   lat:51.40, lng:11.20, hdg:90,  flMin:220, flMax:280, receptacle:'BOTH', region:'NATO' },
  { id:'AR-31M',  label:'NATO AR-31 IT Mediterranean Rafale/Typhoon',      lat:40.20, lng:13.50, hdg:120, flMin:210, flMax:280, receptacle:'PROBE', region:'MED' },
  { id:'AR-67N',  label:'NATO AR-67 NO/SE Nordic Gripen/F-35A anchor',     lat:59.80, lng:14.20, hdg:30,  flMin:220, flMax:280, receptacle:'BOTH', region:'NATO' },
  { id:'AR-PAC1', label:'JASDF AR-PAC1 Sea of Japan F-15J/F-35A',          lat:36.20, lng:135.40, hdg:50,  flMin:220, flMax:270, receptacle:'BOOM', region:'PAC' },
  { id:'AR-ROK1', label:'ROKAF AR-ROK1 East Sea KC-330 boom',              lat:36.60, lng:130.10, hdg:90,  flMin:220, flMax:270, receptacle:'BOOM', region:'PAC' },
]

function classifyPhase(f: MFlight): 'CRUISE'|'CLIMB'|'DESCENT'|'OFF' {
  if (f.ground) return 'OFF'
  const vs = f.vertRate
  if (Math.abs(vs) < 500) return 'CRUISE'
  if (vs > 500) return 'CLIMB'
  return 'DESCENT'
}

function clamp(x: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, x)) }

// Great-circle distance (NM) per haversine
function distNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const toR = Math.PI/180
  const dLat = (lat2-lat1)*toR
  const dLng = (lng2-lng1)*toR
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*toR)*Math.cos(lat2*toR)*Math.sin(dLng/2)**2
  return 2*R*Math.asin(Math.sqrt(a))
}

// Deterministic 32-bit hash → [0,1)
function dhash(s: string, salt: number): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < s.length; i++) { h = (h ^ s.charCodeAt(i)) * 16777619 }
  return (h >>> 0) / 0xffffffff
}

// Synthesise receiver fuel state (deterministic per icao24)
function synthFuel(icao: string): { fuelPct: number; reqAAR: boolean } {
  const u = dhash(icao, 7)
  // 35% of receivers in AAR-request band 12-58% fuel
  const reqAAR = u < 0.42
  const fuelPct = reqAAR ? 12 + u*110 : 60 + u*40
  return { fuelPct: clamp(fuelPct, 8, 95), reqAAR }
}

interface Row {
  f: MFlight; phase: 'CRUISE'|'CLIMB'|'DESCENT'|'OFF'; cls: string; spec: ClassSpec
  nearestTanker: { icao: string; cs: string; dist: number; cls: string; provision: TankerProvision } | null
  nearestTrack: { id: string; dist: number; receptacle: Receptacle | 'BOTH' } | null
  fuelPct: number; reqAAR: boolean
  compatMismatch: boolean; inAltWindow: boolean; inSpdWindow: boolean
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
}

export default function AarMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'TANKERS'|'TRACKS'|'METHOD'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<string>('ALL')
  const [serviceFilter, setServiceFilter] = useState<string>('ALL')
  const [search, setSearch] = useState('')

  // sliders
  const [advMul, setAdvMul] = useState(1.0)
  const [proxMax, setProxMax] = useState(400)        // tanker-proximity ramp top NM
  const [trkCorridor, setTrkCorridor] = useState(60) // AR-track corridor half-width NM
  const [minFl, setMinFl] = useState(120)            // minimum FL to consider

  // overlay layer toggles
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(false)
  const [shTracks, setShTracks] = useState(true)
  const [shJoinup, setShJoinup] = useState(true)

  // === Identify tanker flights present in the live feed
  const tankers = useMemo(() => {
    const out: { f: MFlight; spec: ClassSpec }[] = []
    for (const f of flights) {
      const sp = specOf(f.type, f.callsign)
      if (sp && sp.isTanker) out.push({ f, spec: sp })
    }
    return out
  }, [flights])

  // === per-airframe rows
  const rows = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.altitudeFt < minFl*100 && !f.ground) continue
      const ph = classifyPhase(f)
      if (ph === 'OFF') continue
      const sp = specOf(f.type, f.callsign)
      if (!sp) continue

      // Tankers themselves are rendered but assigned READY-AAR tier when in their service-floor
      const fl = f.altitudeFt/100

      if (sp.isTanker) {
        // Tanker classification — just show as available
        const inWin = fl >= sp.rendFlMin && fl <= sp.rendFlMax
        const notes: string[] = []
        notes.push(`Tanker on station · provision ${sp.provision} · ${sp.fuelCapKg.toLocaleString()} kg max offload`)
        if (inWin) notes.push(`In AR-block FL${sp.rendFlMin}-FL${sp.rendFlMax} ready to dispense`)
        out.push({
          f, phase: ph, cls: sp.cls, spec: sp,
          nearestTanker: null, nearestTrack: null,
          fuelPct: 100, reqAAR: false,
          compatMismatch: false, inAltWindow: inWin, inSpdWindow: f.velocityKts >= 250 && f.velocityKts <= 320,
          drivers: { COMPAT: 0, PROX: 0, AR_TRK: inWin?15:30, FUEL_LO: 0, ALT_WIN: inWin?0:35, SPD_WIN: 0, FORM: 0 },
          score: inWin ? 78 : 55,
          tier: inWin ? 'READY-AAR' : 'PENDING-AAR',
          notes
        })
        continue
      }

      // Receiver classification
      const fuel = synthFuel(f.icao)

      // Find nearest compatible tanker
      let nearestTanker: Row['nearestTanker'] = null
      let nearestTankerDist = Infinity
      let anyTankerNearby = false
      let compatTankerExists = false
      for (const t of tankers) {
        const d = distNm(f.lat, f.lng, t.f.lat, t.f.lng)
        const tankerCompatible =
          (sp.receptacle === 'BOOM' && (t.spec.provision === 'BOOM' || t.spec.provision === 'DUAL')) ||
          (sp.receptacle === 'PROBE' && (t.spec.provision === 'PROBE' || t.spec.provision === 'DUAL'))
        if (tankerCompatible) compatTankerExists = true
        if (d < proxMax) anyTankerNearby = true
        if (tankerCompatible && d < nearestTankerDist) {
          nearestTankerDist = d
          nearestTanker = { icao: t.f.icao, cs: t.f.callsign||t.f.icao, dist: d, cls: t.spec.cls, provision: t.spec.provision }
        }
      }

      // Find nearest AR-track
      let nearestTrack: Row['nearestTrack'] = null
      let nearestTrackDist = Infinity
      for (const tr of TRACKS) {
        const d = distNm(f.lat, f.lng, tr.lat, tr.lng)
        if (d < nearestTrackDist) {
          nearestTrackDist = d
          nearestTrack = { id: tr.id, dist: d, receptacle: tr.receptacle }
        }
      }
      const inTrkCorridor = nearestTrack !== null && nearestTrack.dist < trkCorridor
      const trkCompat = inTrkCorridor && nearestTrack !== null &&
        (nearestTrack.receptacle === 'BOTH' ||
         nearestTrack.receptacle === sp.receptacle)

      const inAltWindow = fl >= sp.rendFlMin - 20 && fl <= sp.rendFlMax + 20
      const inSpdWindow = f.velocityKts >= sp.rendKtas - 35 && f.velocityKts <= sp.rendKtas + 35

      // Compatibility-mismatch: track exists in corridor but is wrong type for receiver
      const compatMismatch = inTrkCorridor && nearestTrack !== null &&
        nearestTrack.receptacle !== 'BOTH' && nearestTrack.receptacle !== sp.receptacle

      // === drivers (0-100 scale)
      // COMPAT: hard 90 if no compatible tanker anywhere, 45 if mismatch in track, 0 if compatible nearby
      let dCOMPAT = 0
      if (!compatTankerExists) dCOMPAT = 90
      else if (compatMismatch) dCOMPAT = 55
      else if (nearestTanker && nearestTanker.dist > proxMax * 0.85) dCOMPAT = 30

      // PROX: ramp 0..proxMax NM (closer is better — but for AAR_DRIVER, low PROX means READY)
      const dPROX = nearestTanker ? clamp(100 - (nearestTanker.dist/proxMax)*100, 0, 100) : 5

      // AR_TRK: in-corridor compatible track is a big positive for AAR scoring
      const dAR = inTrkCorridor && trkCompat ? 75 : inTrkCorridor ? 35 : 8

      // FUEL_LO: fuel state ramp — below 30% triggers AAR-request flag
      const dFUEL = fuel.reqAAR ? clamp(100 - fuel.fuelPct*1.5, 30, 100) : clamp(40 - fuel.fuelPct*0.4, 0, 40)

      // ALT_WIN: in altitude window is a positive for AAR scoring (matches READY)
      const dALT = inAltWindow ? 60 : clamp(100 - Math.abs(fl - (sp.rendFlMin+sp.rendFlMax)/2)/2, 0, 60)

      // SPD_WIN: in speed window 270-310 kts amplifies READY tier
      const dSPD = inSpdWindow ? 65 : 25

      // FORMATION: synthetic — within 5 NM of another military airframe of same service
      let dFORM = 0
      for (const o of flights) {
        if (o.icao === f.icao) continue
        const oSp = specOf(o.type, o.callsign)
        if (!oSp || oSp.service !== sp.service) continue
        const d = distNm(f.lat, f.lng, o.lat, o.lng)
        if (d < 5) { dFORM = 60; break }
      }

      const drivers = { COMPAT: dCOMPAT, PROX: dPROX, AR_TRK: dAR, FUEL_LO: dFUEL, ALT_WIN: dALT, SPD_WIN: dSPD, FORM: dFORM }

      // === Composite scoring
      // For AAR-eligibility, HIGH score = MORE likely to be in active AAR operation
      // This is a "positive" score system — opposite polarity from danger-monitors
      const positives = (dAR*1.2 + dPROX*0.8 + dFUEL*0.9 + dALT*0.7 + dSPD*0.5 + dFORM*0.4) / 4.5
      let score = clamp(positives - dCOMPAT*0.3, 0, 100)
      score *= advMul
      score = clamp(score, 0, 100)

      const notes: string[] = []
      let tier: Tier = 'NON-AAR'

      // Hard escalators
      if (inTrkCorridor && trkCompat && fuel.reqAAR && nearestTanker && nearestTanker.dist < 80) {
        score = Math.max(score, 85)
        notes.push(`READY: in AR-${nearestTrack!.id} corridor (${nearestTrack!.dist.toFixed(0)} NM), compatible tanker ${nearestTanker.cs} at ${nearestTanker.dist.toFixed(0)} NM, fuel ${fuel.fuelPct.toFixed(0)}% AAR-request flag · joinup imminent under MARSA per ATP-3.3.4.2 / AFI 11-235`)
      }
      if (inTrkCorridor && trkCompat && (!nearestTanker || nearestTanker.dist > 80)) {
        score = Math.max(score, 65)
        notes.push(`PENDING: in AR-${nearestTrack!.id} corridor (${nearestTrack!.dist.toFixed(0)} NM), compatible tanker not yet on station · expect rendezvous-time slip per Air-Refueling-Schedule`)
      }
      if (compatMismatch) {
        score = Math.max(score, 50)
        notes.push(`INCOMPATIBLE: nearest AR-${nearestTrack!.id} is ${nearestTrack!.receptacle}-only but receiver is ${sp.receptacle}-equipped — alternate tanker required (cross-service Boom-Drogue-Adapter Mk32B or KC-46A dual)`)
      }
      if (!compatTankerExists) {
        score = Math.max(score, 35)
        notes.push(`OPERATIONAL GAP: no compatible ${sp.receptacle}-tanker in current envelope — divert / request inter-theater tanker support per JFACC tanker-airlift coordination cell`)
      }

      // Tier mapping
      if (score >= 80) tier = 'READY-AAR'
      else if (score >= 60) tier = 'PENDING-AAR'
      else if (score >= 35) tier = 'COMPATIBLE'
      else if (compatMismatch || !compatTankerExists) tier = 'INCOMPATIBLE'
      else if (sp.service === 'NATO' || sp.service === 'USAF' || sp.service === 'USN' || sp.service === 'USMC') tier = 'COMPATIBLE'
      else tier = 'NON-AAR'

      out.push({
        f, phase: ph, cls: sp.cls, spec: sp,
        nearestTanker, nearestTrack, fuelPct: fuel.fuelPct, reqAAR: fuel.reqAAR,
        compatMismatch, inAltWindow, inSpdWindow,
        drivers, score, tier, notes
      })
    }
    out.sort((a,b) => (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, tankers, advMul, proxMax, trkCorridor, minFl])

  // === MapLibre overlay
  useEffect(() => {
    if (!map) return
    const SRC = 'aar-src'
    const SRC_TRK = 'aar-trk-src'
    const SRC_JOIN = 'aar-join-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    const writeAll = () => {
      ensureSrc(SRC); ensureSrc(SRC_TRK); ensureSrc(SRC_JOIN)
      const view = rows.filter(r =>
        (tierFilter==='ALL'||r.tier===tierFilter) &&
        (classFilter==='ALL'||r.cls===classFilter) &&
        (serviceFilter==='ALL'||r.spec.service===serviceFilter)
      )
      const acFeats: any[] = []
      const trkFeats: any[] = []
      const joinFeats: any[] = []

      for (const r of view) {
        acFeats.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
          properties:{
            tier: r.tier, color: TIER_COLOR[r.tier], score: r.score,
            sz: 6 + (r.score/100)*14,
            label: `${r.f.callsign||r.f.icao} · ${r.cls} · ${r.spec.receptacle!=='NONE'?r.spec.receptacle:r.spec.provision} · ${r.tier}`
          }
        })
        // Joinup vector line receiver → nearest compatible tanker
        if (shJoinup && r.nearestTanker && (r.tier === 'READY-AAR' || r.tier === 'PENDING-AAR')) {
          const t = flights.find(x => x.icao === r.nearestTanker!.icao)
          if (t) {
            joinFeats.push({
              type:'Feature',
              geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat], [t.lng, t.lat]] },
              properties:{ color: TIER_COLOR[r.tier] }
            })
          }
        }
      }

      // AR-tracks as anchor points + corridor circles
      if (shTracks) {
        for (const tr of TRACKS) {
          trkFeats.push({
            type:'Feature',
            geometry:{ type:'Point', coordinates:[tr.lng, tr.lat] },
            properties:{
              label: tr.id,
              color: tr.receptacle === 'BOOM' ? '#0ea5e9' : tr.receptacle === 'PROBE' ? '#a78bfa' : '#10b981'
            }
          })
        }
      }

      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_TRK) as any).setData({ type:'FeatureCollection', features: trkFeats })
      ;(map.getSource(SRC_JOIN) as any).setData({ type:'FeatureCollection', features: joinFeats })
    }
    ensureSrc(SRC); ensureSrc(SRC_TRK); ensureSrc(SRC_JOIN)
    if (!map.getLayer('aar-halo'))
      map.addLayer({ id:'aar-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.16, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.2, 'circle-stroke-opacity':0.8 } })
    if (!map.getLayer('aar-pin'))
      map.addLayer({ id:'aar-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 60], paint:{ 'circle-radius':4.6, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('aar-lbl'))
      map.addLayer({ id:'aar-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.6], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('aar-trk-circ'))
      map.addLayer({ id:'aar-trk-circ', type:'circle', source:SRC_TRK, paint:{ 'circle-radius':8, 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.0, 'circle-stroke-opacity':0.7 } })
    if (!map.getLayer('aar-trk-lbl'))
      map.addLayer({ id:'aar-trk-lbl', type:'symbol', source:SRC_TRK, layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('aar-join'))
      map.addLayer({ id:'aar-join', type:'line', source:SRC_JOIN, paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-dasharray':[2, 2.5], 'line-opacity':0.78 } })
    writeAll()
    return () => {
      for (const id of ['aar-lbl','aar-pin','aar-halo','aar-trk-lbl','aar-trk-circ','aar-join']) if (map.getLayer(id)) map.removeLayer(id)
      for (const id of [SRC, SRC_TRK, SRC_JOIN]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, classFilter, serviceFilter, shHalo, shPin, shLbl, shTracks, shJoinup, flights])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (classFilter==='ALL'||r.cls===classFilter) &&
    (serviceFilter==='ALL'||r.spec.service===serviceFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.f.operator||'').toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { 'READY-AAR':0, 'PENDING-AAR':0, 'COMPATIBLE':0, 'INCOMPATIBLE':0, 'NON-AAR':0, 'OFF':0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const muFuel = rows.filter(r=>!r.spec.isTanker).length ? (rows.filter(r=>!r.spec.isTanker).reduce((a,b)=>a+b.fuelPct,0)/rows.filter(r=>!r.spec.isTanker).length) : 0
  const worst = rows[0]
  const tankerCnt = tankers.length
  const boomTankers = tankers.filter(t => t.spec.provision === 'BOOM' || t.spec.provision === 'DUAL').length
  const pdTankers = tankers.filter(t => t.spec.provision === 'PROBE' || t.spec.provision === 'DUAL').length
  const requesters = rows.filter(r => r.reqAAR && !r.spec.isTanker).length
  const services = Array.from(new Set(SPECS.map(s => s.service)))

  // class aggregation
  const classMap = new Map<string, { spec: ClassSpec; count: number; muScore: number; ready: number; pending: number; compat: number; incomp: number }>()
  for (const r of rows) {
    const e = classMap.get(r.cls) || { spec: r.spec, count: 0, muScore: 0, ready: 0, pending: 0, compat: 0, incomp: 0 }
    e.count++; e.muScore += r.score
    if (r.tier === 'READY-AAR') e.ready++
    if (r.tier === 'PENDING-AAR') e.pending++
    if (r.tier === 'COMPATIBLE') e.compat++
    if (r.tier === 'INCOMPATIBLE') e.incomp++
    classMap.set(r.cls, e)
  }
  const classRows = Array.from(classMap.entries()).map(([cls, e]) => ({
    cls, spec: e.spec, count: e.count, muScore: e.muScore/e.count,
    ready: e.ready, pending: e.pending, compat: e.compat, incomp: e.incomp
  })).sort((a,b) => (b.ready+b.pending) - (a.ready+a.pending) || b.muScore-a.muScore)

  // Receptacle compatibility matrix
  const compatMatrix: Array<{ recv: Receptacle; tankerB: string; tankerP: string; tankerD: string }> = [
    { recv: 'BOOM',  tankerB: '✓ direct', tankerP: '✗ incompatible (Mk32B BDA req)', tankerD: '✓ direct (KC-46A / MRTT)' },
    { recv: 'PROBE', tankerB: '✗ incompatible (Mk32B BDA req)', tankerP: '✓ direct', tankerD: '✓ direct (KC-46A / MRTT)' },
    { recv: 'DUAL',  tankerB: '✓ via boom', tankerP: '✓ via probe', tankerD: '✓ either' },
  ]

  return (
    <div className="fixed top-16 right-3 z-40 w-[480px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">AAR</span>
          <span className="text-[10px] text-slate-400">Air-to-Air Refueling · Track / Receptacle / Tanker · ATP-3.3.4.2 · AFI 11-235</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* tier strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter===t?'border':'border border-slate-700/60'}`} style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:undefined, color: TIER_COLOR[t] }}>{t.split('-')[0].slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      {/* summary cells */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">TANKERS</div><div className="text-slate-100 font-mono">{tankerCnt} · B{boomTankers} P{pdTankers}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-FUEL</div><div className="font-mono" style={{color: muFuel<35 ? TIER_COLOR['INCOMPATIBLE'] : muFuel<55 ? TIER_COLOR['COMPATIBLE'] : TIER_COLOR['READY-AAR']}}>{muFuel.toFixed(0)}%</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">REQUEST</div><div className="font-mono" style={{color: requesters>0 ? TIER_COLOR['READY-AAR'] : '#cbd5e1'}}>{requesters}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||worst?.f.icao||'—'}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">PROX-MAX <span className="text-slate-200 font-mono">{proxMax} NM</span>
            <input type="range" min="100" max="800" value={proxMax} onChange={e=>setProxMax(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">TRK-CORR <span className="text-slate-200 font-mono">{trkCorridor} NM</span>
            <input type="range" min="20" max="200" value={trkCorridor} onChange={e=>setTrkCorridor(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">MIN-FL <span className="text-slate-200 font-mono">{minFl}</span>
            <input type="range" min="0" max="400" value={minFl} onChange={e=>setMinFl(+e.target.value)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={()=>setClassFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL</button>
          {SPECS.map(s => (
            <button key={s.cls} onClick={()=>setClassFilter(s.cls)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter===s.cls?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{s.cls}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={()=>setServiceFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${serviceFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL-SVC</button>
          {services.map(s => (
            <button key={s} onClick={()=>setServiceFilter(s)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${serviceFilter===s?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{s}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['TRK',shTracks,setShTracks],['JOIN',shJoinup,setShJoinup]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','TANKERS','TRACKS','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab==='AIRCRAFT' && visible.slice(0,80).map((r,i) => (
          <div key={i} onClick={()=>onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{r.f.callsign||r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type||'—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.cls}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.spec.service}</span>
              {r.spec.receptacle!=='NONE' && <span className="px-1 rounded font-mono text-[9px]" style={{background: r.spec.receptacle==='BOOM' ? '#0ea5e933' : '#a78bfa33', color: r.spec.receptacle==='BOOM' ? '#0ea5e9' : '#a78bfa'}}>{r.spec.receptacle}</span>}
              {r.spec.isTanker && <span className="px-1 rounded font-mono text-[9px]" style={{background: '#10b98133', color: '#10b981'}}>TKR-{r.spec.provision}</span>}
              {r.reqAAR && !r.spec.isTanker && <span className="px-1 rounded font-mono text-[9px]" style={{background: '#f59e0b33', color: '#f59e0b'}}>FUEL-REQ</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier.split('-')[0]} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>FL <span className="text-slate-100 font-mono">{(r.f.altitudeFt/100).toFixed(0)}</span></div>
              <div>KTS <span className="font-mono" style={{color: r.inSpdWindow ? TIER_COLOR['READY-AAR'] : '#cbd5e1'}}>{r.f.velocityKts.toFixed(0)}</span></div>
              <div>FUEL <span className="font-mono" style={{color: r.fuelPct<35 ? TIER_COLOR['INCOMPATIBLE'] : r.fuelPct<55 ? TIER_COLOR['COMPATIBLE'] : TIER_COLOR['READY-AAR']}}>{r.fuelPct.toFixed(0)}%</span></div>
              <div>ALT-WIN <span className="font-mono" style={{color: r.inAltWindow ? TIER_COLOR['READY-AAR'] : '#cbd5e1'}}>{r.inAltWindow ? '✓' : '×'}</span></div>
            </div>
            {r.nearestTanker && (
              <div className="text-[10px] text-slate-400 mt-0.5">↳ TKR <span className="font-mono text-slate-100">{r.nearestTanker.cs}</span> · <span className="font-mono">{r.nearestTanker.cls}/{r.nearestTanker.provision}</span> · <span className="font-mono" style={{color: r.nearestTanker.dist<80 ? TIER_COLOR['READY-AAR'] : r.nearestTanker.dist<200 ? TIER_COLOR['PENDING-AAR'] : '#cbd5e1'}}>{r.nearestTanker.dist.toFixed(0)} NM</span></div>
            )}
            {!r.nearestTanker && !r.spec.isTanker && (
              <div className="text-[10px] text-slate-500 mt-0.5">↳ no compatible {r.spec.receptacle} tanker airborne in current envelope</div>
            )}
            {r.nearestTrack && (
              <div className="text-[10px] text-slate-400">↳ TRK <span className="font-mono text-slate-100">{r.nearestTrack.id}</span> · <span className="font-mono">{r.nearestTrack.receptacle}</span> · <span className="font-mono" style={{color: r.nearestTrack.dist<trkCorridor ? TIER_COLOR['READY-AAR'] : '#cbd5e1'}}>{r.nearestTrack.dist.toFixed(0)} NM</span></div>
            )}
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v as number)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>› {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='NON-AAR' && <div className="mt-1 text-[9px] text-slate-500">monitor receptacle compatibility · verify tanker provision matches receiver type · ATP-3.3.4.2 §4 ATC handoff</div>}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length === 0 && (
          <div className="text-[10px] text-slate-500 italic px-2 py-6 text-center">no AAR-capable airframes above FL{minFl} in scope · adjust MIN-FL or filters · note: military traffic is sparse in ADS-B feeds</div>
        )}

        {tab==='TANKERS' && (
          <div className="space-y-1.5">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
              <div className="text-[10px] text-slate-300 font-mono mb-1">Tankers airborne in current snapshot · {tankers.length} platforms</div>
              {tankers.length === 0 && (
                <div className="text-[10px] text-slate-500 italic">no tankers identified in current ADS-B feed · KC-46A / KC-135 / KC-10 / KC-130J / A330-MRTT typically operate with callsigns REACH / QUID / NOMAD / MUSTANG / SHELL</div>
              )}
              {tankers.map(t => (
                <div key={t.f.icao} onClick={()=>onFly(t.f.icao)} className="cursor-pointer flex items-center gap-1.5 text-[10px] py-0.5 hover:bg-slate-700/30 rounded px-1">
                  <span className="font-mono text-slate-100">{t.f.callsign||t.f.icao}</span>
                  <span className="text-slate-500">·</span>
                  <span className="font-mono text-slate-400">{t.f.type||'—'}</span>
                  <span className="px-1 rounded font-mono text-[9px]" style={{background: '#10b98133', color: '#10b981'}}>{t.spec.provision}</span>
                  <span className="px-1 rounded bg-slate-700/50 text-slate-400 font-mono text-[9px]">{t.spec.service}</span>
                  <span className="ml-auto text-slate-400 font-mono text-[9px]">FL{(t.f.altitudeFt/100).toFixed(0)} · {t.f.velocityKts.toFixed(0)}kt</span>
                </div>
              ))}
            </div>

            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-300 font-mono mb-1">Receptacle ↔ Tanker compatibility matrix · ATP-3.3.4.2 / AFI 11-235 / NTRP 3-22.4</div>
              <table className="w-full text-[9px] text-slate-300">
                <thead>
                  <tr className="text-slate-500 border-b border-slate-700/60">
                    <th className="text-left py-1">Receiver</th>
                    <th className="text-left py-1">TKR-BOOM</th>
                    <th className="text-left py-1">TKR-PD</th>
                    <th className="text-left py-1">TKR-DUAL</th>
                  </tr>
                </thead>
                <tbody>
                  {compatMatrix.map((row,i) => (
                    <tr key={i} className="border-b border-slate-800/40">
                      <td className="py-1 font-mono"><span className="px-1 rounded" style={{background: row.recv==='BOOM' ? '#0ea5e933' : row.recv==='PROBE' ? '#a78bfa33' : '#10b98133', color: row.recv==='BOOM' ? '#0ea5e9' : row.recv==='PROBE' ? '#a78bfa' : '#10b981'}}>{row.recv}</span></td>
                      <td className="py-1 text-[9px]"><span style={{color: row.tankerB.startsWith('✓') ? TIER_COLOR['READY-AAR'] : TIER_COLOR['INCOMPATIBLE']}}>{row.tankerB}</span></td>
                      <td className="py-1 text-[9px]"><span style={{color: row.tankerP.startsWith('✓') ? TIER_COLOR['READY-AAR'] : TIER_COLOR['INCOMPATIBLE']}}>{row.tankerP}</span></td>
                      <td className="py-1 text-[9px]"><span style={{color: row.tankerD.startsWith('✓') ? TIER_COLOR['READY-AAR'] : TIER_COLOR['INCOMPATIBLE']}}>{row.tankerD}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="text-[9px] text-slate-500 mt-1.5 leading-relaxed">Mk32B Boom-Drogue-Adapter (BDA) is a removable centerline conversion kit allowing some boom-equipped tankers to dispense to probe-equipped receivers (KC-10A standard fit, KC-46A standard fit, KC-135R with field-installed kit). Per AMC NOTAM K-AAR / AFI 11-2KC-10 Vol.3 / NTRP 3-22.4-VAQ App.A.</div>
            </div>

            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-300 font-mono mb-1">Per-class fleet · {classRows.length} types airborne</div>
              {classRows.map(c => (
                <div key={c.cls} className="bg-slate-800/30 border border-slate-700/30 rounded p-1.5 mt-1">
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{c.cls}</span>
                    <span className="text-slate-300 truncate text-[10px]">{c.spec.label}</span>
                    <span className="ml-auto font-mono text-slate-100">{c.count}</span>
                  </div>
                  <div className="grid grid-cols-5 gap-1 mt-1 text-[10px] text-slate-400">
                    <div>μ-SC <span className="text-slate-100 font-mono">{c.muScore.toFixed(0)}</span></div>
                    <div>READY <span className="font-mono" style={{color:TIER_COLOR['READY-AAR']}}>{c.ready}</span></div>
                    <div>PEND <span className="font-mono" style={{color:TIER_COLOR['PENDING-AAR']}}>{c.pending}</span></div>
                    <div>COMP <span className="font-mono" style={{color:TIER_COLOR.COMPATIBLE}}>{c.compat}</span></div>
                    <div>INC <span className="font-mono" style={{color:TIER_COLOR.INCOMPATIBLE}}>{c.incomp}</span></div>
                  </div>
                </div>
              ))}
              {classRows.length === 0 && <div className="text-[10px] text-slate-500 italic mt-1">no airframes in scope</div>}
            </div>
          </div>
        )}

        {tab==='TRACKS' && (
          <div className="space-y-1.5">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-300 font-mono mb-1">AR-track catalogue · {TRACKS.length} anchor refueling areas</div>
              <div className="text-[9px] text-slate-500 mb-1.5">Per FAA JO 7110.65BB §10-1-2 air-refueling areas, AFI 13-201 §6, AP/1B Mil Aero Pubs DoD FLIP, EUROCONTROL EAUP refueling-area database. Boom-only (BOOM, blue) corridors for USAF/RAAF/ROKAF heavy-receivers, probe-drogue (PROBE, violet) for USN/USMC/NATO fighters, dual-mode (BOTH, green) for KC-46A / A330-MRTT cross-service tracks.</div>
              <div className="max-h-72 overflow-y-auto space-y-0.5">
                {TRACKS.map(tr => {
                  const trkColor = tr.receptacle === 'BOOM' ? '#0ea5e9' : tr.receptacle === 'PROBE' ? '#a78bfa' : '#10b981'
                  const activeRows = rows.filter(r => r.nearestTrack?.id === tr.id && r.nearestTrack.dist < trkCorridor)
                  return (
                    <div key={tr.id} className="bg-slate-800/30 border border-slate-700/30 rounded p-1.5">
                      <div className="flex items-center gap-1.5 text-[10px]">
                        <span className="px-1 rounded font-mono text-[9px]" style={{ background:`${trkColor}22`, color: trkColor }}>{tr.id}</span>
                        <span className="text-slate-300 truncate text-[10px]">{tr.label}</span>
                        <span className="ml-auto px-1 rounded bg-slate-700/50 text-slate-400 font-mono text-[9px]">{tr.region}</span>
                      </div>
                      <div className="grid grid-cols-5 gap-1 mt-0.5 text-[10px] text-slate-400">
                        <div>HDG <span className="text-slate-100 font-mono">{String(tr.hdg).padStart(3,'0')}°</span></div>
                        <div>FL <span className="text-slate-100 font-mono">{tr.flMin}-{tr.flMax}</span></div>
                        <div>RCP <span className="font-mono" style={{ color: trkColor }}>{tr.receptacle}</span></div>
                        <div>LAT <span className="text-slate-100 font-mono">{tr.lat.toFixed(1)}</span></div>
                        <div>ACT <span className="font-mono" style={{ color: activeRows.length>0 ? TIER_COLOR['READY-AAR'] : '#475569' }}>{activeRows.length}</span></div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-300 font-mono mb-1">Track-region map · 18 anchors over 8 regions</div>
              <svg viewBox="0 0 400 220" className="w-full">
                {/* Equirectangular world frame */}
                <rect x="0" y="0" width="400" height="220" fill="#0b0f17" />
                <line x1="0" y1="110" x2="400" y2="110" stroke="#334155" strokeWidth="0.5" />
                <line x1="200" y1="0" x2="200" y2="220" stroke="#334155" strokeWidth="0.5" />
                {/* Tracks plotted lng→x lat→y */}
                {TRACKS.map(tr => {
                  const x = ((tr.lng + 180) / 360) * 400
                  const y = ((90 - tr.lat) / 180) * 220
                  const trkColor = tr.receptacle === 'BOOM' ? '#0ea5e9' : tr.receptacle === 'PROBE' ? '#a78bfa' : '#10b981'
                  return (
                    <g key={tr.id}>
                      <circle cx={x} cy={y} r="5" fill={trkColor} opacity="0.25" stroke={trkColor} strokeWidth="0.8" />
                      <text x={x+7} y={y+3} fill={trkColor} fontSize="7" fontFamily="monospace">{tr.id}</text>
                    </g>
                  )
                })}
                {/* Fleet rows superimposed for context */}
                {rows.slice(0,40).map((r,i) => {
                  const x = ((r.f.lng + 180) / 360) * 400
                  const y = ((90 - r.f.lat) / 180) * 220
                  return <circle key={i} cx={x} cy={y} r="2" fill={TIER_COLOR[r.tier]} opacity="0.8" />
                })}
                <g transform="translate(8, 14)">
                  <circle cx="3" cy="0" r="3" fill="#0ea5e9" opacity="0.4" stroke="#0ea5e9" />
                  <text x="10" y="3" fill="#cbd5e1" fontSize="8">BOOM</text>
                  <circle cx="50" cy="0" r="3" fill="#a78bfa" opacity="0.4" stroke="#a78bfa" />
                  <text x="57" y="3" fill="#cbd5e1" fontSize="8">PROBE</text>
                  <circle cx="100" cy="0" r="3" fill="#10b981" opacity="0.4" stroke="#10b981" />
                  <text x="107" y="3" fill="#cbd5e1" fontSize="8">BOTH</text>
                </g>
              </svg>
            </div>
          </div>
        )}

        {tab==='METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-300 leading-relaxed">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Definition</div>
              <div className="text-slate-400">AAR (Air-to-Air Refueling) is the doctrinal capability of transferring fuel from a TANKER airframe to a RECEIVER airframe in flight, performed under MARSA (Military Accepts Responsibility for Separation of Aircraft) per FAA JO 7110.65BB §10-1-3 in a designated AR-track corridor. Two physical interfaces dominate worldwide per ATP-3.3.4.2 NATO AAR Manual ed.G: BOOM (Flying Boom System, USAF standard, single-point receptacle on receiver fuselage, KC-135/KC-10/KC-46 dispensing) and PROBE-AND-DROGUE (Hose-Reel System / Wing Pods, USN/USMC/RAF/NATO standard, extending probe on receiver mating with trailing basket). Universal Drogue Fitting (Mk32B Boom-Drogue-Adapter) allows some boom tankers to be reconfigured for cross-service probe dispensing.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Receptacle-Tanker compatibility matrix</div>
              <div className="text-slate-400">Compatibility is governed by physical receiver-tanker interface match: BOOM-receivers (F-22/F-15/F-16/F-35A/B-1/B-2/B-52/C-5/C-17/E-3/E-4/KC-46 self) require BOOM-dispensing tankers (KC-135R/T, KC-10A, KC-46A, KC-30A, A330-MRTT boom variant). PROBE-receivers (F/A-18/F-35B/F-35C/EA-18G/V-22/Typhoon/Rafale/Gripen/Tornado/Mirage/A400M/C-130J/NH90/Tornado-IDS) require PROBE-DROGUE tankers (KC-130J, KC-10A centerline, A330-MRTT pod variant, Mk32B-equipped converted boom tankers). KC-46A and A330-MRTT (full kit) are DUAL — boom AND wing pods simultaneously — enabling mixed receiver flights on a single tanker mission per AFI 11-2KC-46 Vol.3 / RAAF KC-30A OpsManual.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Hard-escalator score floors</div>
              <div className="text-slate-400 space-y-0.5">
                <div>· In AR-track corridor + compatible tanker &lt; 80 NM + FUEL-REQ flag → READY ≥ 85 (active joinup imminent under MARSA)</div>
                <div>· In AR-track corridor + compatible tanker on station → PENDING ≥ 65 (rendezvous-time slip expected)</div>
                <div>· Receptacle-track mismatch (BOOM-receiver in PROBE-only track or vice versa) → INCOMPATIBLE ≥ 50 (alternate tanker / Mk32B BDA / cross-service handoff required)</div>
                <div>· No compatible tanker airborne anywhere in current ADS-B envelope → INCOMPATIBLE ≥ 35 (operational gap, JFACC tanker-airlift coordination cell request)</div>
                <div>· Receiver fuel state &lt; 30% + outside AR-corridor → PENDING ≥ 45 (request divert / nearest-tanker handover)</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Operational notes</div>
              <div className="text-slate-400">Receiver fuel state is synthesised per icao24 hash since ADS-B does not broadcast internal fuel; about 42% of receivers are assigned the AAR-request band (12-58% fuel) and 58% are nominal. Rendezvous geometry assumes tanker on station at AR-track anchor on inbound HDG, receiver inbound from join-point at PROX-MAX (default 400 NM, slider 100-800), with FL window FL180-FL280 typical (KC-46A operates up to FL400 self). Speed window 250-320 KIAS encompasses the standard tanker-receiver mating speed band per AFI 11-2KC-135 Vol.3 §3 + AFI 11-2KC-46 Vol.3 §3. Formation amplifier triggers when another military airframe of the same service is within 5 NM lateral (fingertip/trail formation typical).</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">AR-track regional structure</div>
              <div className="text-slate-400">The 18 anchor tracks cover the 8 principal AAR regions: CONUS-East (AR-105, AR-115, AR-202, AR-401), CONUS-West (AR-553, AR-625, AR-820), CONUS-North (AR-712), CONUS-South (AR-215, AR-302), Alaska (AR-911 Yukon coastal F-22/F-35A PACAF), Hawaii (AR-1004 Pacific PACAF receivers), NATO-Europe (AR-115B Atlantic FANS-1A, AR-04N GE high-altitude EurFighter, AR-67N Nordic Gripen/F-35A), Mediterranean (AR-31M IT Rafale/Typhoon), Pacific (AR-PAC1 JASDF F-15J/F-35A Sea of Japan, AR-ROK1 ROKAF KC-330). Corridor half-width adjustable 20-200 NM (default 60 NM) per AFI 11-235 §7 air-refueling-area dimensions.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · ATP-3.3.4.2 NATO Air-to-Air Refueling Manual ed.G · AFI 11-235 USAF Air Refueling · AFI 11-2KC-10 Vol.3 / AFI 11-2KC-135 Vol.3 / AFI 11-2KC-46 Vol.3 USAF Aircrew Procedures · AFI 13-201 §6 USAF Airspace Management · NTRP 3-22.4-VAQ USN AAR Procedures · MIL-STD-1709C Boom-Receptacle Interface · MIL-STD-1791E Probe-Drogue Interface · MIL-STD-1853 Air Refueling System · FAA JO 7110.65BB §10-1-2 air-refueling areas / §10-1-3 MARSA · FAA Order JO 7610.4P §10-1 SUA / §10-3 ATCAA · AP/1B / AP/3 DoD FLIP Mil Aero Pubs · EUROCONTROL EAUP refueling-area database · NATO ATP-56(C) Air-to-Air Refueling Tactical Manual · USN OPNAV 3710.7V §8.10 air refueling · USMC MCO 3500.30B §6 air refueling · RAAF AAP 7214.003 §6 KC-30A · RAF Mil Aero Publication MAP 01 §4 Voyager · ICAO Doc 4444 §16.5 SUA / Doc 9854 §3 GANP § Mil · Boeing 767 KC-46A Pegasus Test Report 2019 · Boeing 707 KC-135 Stratotanker FCOM Vol.1 §3 boom-operator station · Airbus Defense A330 MRTT FCOM §3 boom + pod operation · GAO-21-105279 KC-46 RVS deficiency · NTSB AAR-66 KC-135 56-3592 Lake Mead 1962 · USAF Air Mobility Command Air Refueling Initial Qualification Course CGTM · Wright-Patterson AFRL Air Refueling Test Reports 1955-1962 boom-development history · 460th Air Refueling Squadron Loring AFB historical KC-135 ops · ICAO Annex 2 Appendix 4 · Annex 11 §2.27 · MIL-HDBK-516C §15 air refueling certification.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
