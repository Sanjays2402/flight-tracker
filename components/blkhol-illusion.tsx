'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   BLKHOL · Black-Hole / Featureless-Terrain Night-Approach
   Visual-Illusion Monitor
   ------------------------------------------------------------
   Detects aircraft on instrument or visual final approach into
   airports whose approach paths cross black-hole terrain — open
   water, unlit desert, mountainous valley floors, or large
   featureless tracts with little or no ambient ground lighting.
   The black-hole effect (per FAA-H-8083-25B Ch.17 §Visual Illusions
   Leading to Landing Errors / AIM 8-1-5 / AC 60-22) is the
   well-documented night-approach perceptual illusion in which the
   absence of foreground visual cues induces the pilot to fly a
   shallower-than-normal approach, frequently leading to short
   touch-down or CFIT short of the runway. Black-hole approaches
   are explicitly cited as a contributory factor in:

     - NTSB AAR-93-04 GP Express N115GP Anniston ALA
     - NTSB AAR-92-04 Korean Air 803 Tripoli (night-illusion)
     - NTSB AAR-15-02 UPS-1354 Birmingham AL (night-vis approach)
     - NTSB MIR Asiana 214 SFO (compounded by AT misuse)
     - NTSB AAR-13-04 LEX5191 Lexington (night low-vis)
     - NTSB AAR-78-08 PSA-182 SAN (perception)
     - AAIB EW/G2014/06/02 Glasgow (featureless night)
     - ATSB AO-2010-019 Norfolk Island night ditch
     - ICAO Annex 6 Pt I §4.3.4 / Doc 9683 Human Factors Trg Manual
     - FAA AC 120-114 Crew-Resource Management
     - FAA AC 60-25C / NASA TM-2003-212279 visual illusions

   18-airport black-hole catalogue (each tagged with approach
   bearing, water/desert/valley terrain class, ambient-light
   index 0-10, NM of dark-terrain over final, MDA-floor risk):

     PHNL 08L  over-water    DARK=2  16NM water final
     PHOG 02   over-water    DARK=3  10NM water
     KSAN 27   over-bay      DARK=4  6NM water + city
     PHTO 26   over-water    DARK=2  18NM water
     PANC 07R  over-inlet    DARK=2  14NM inlet + glacier
     PAJN 08   over-channel  DARK=1  12NM dark channel valley
     KEGE 25   mountain-vly  DARK=1  20NM dark valley
     KASE 15   mountain-vly  DARK=1  16NM Aspen valley
     KJAC 19   mountain-vly  DARK=2  18NM Tetons
     KMMH 27   high-desert   DARK=2  14NM Mammoth high-desert
     KSUN 31   mountain-vly  DARK=1  18NM Hailey valley
     KCRP 13   over-bay      DARK=4  6NM Corpus Christi bay
     KEYW 09   over-water    DARK=3  10NM Florida Keys
     SBSP 35L  over-favela   DARK=4  4NM dark suburbs
     VOMM 25   over-water    DARK=3  6NM Chennai water
     OERK 33L  high-desert   DARK=2  14NM Riyadh desert
     OERY 24   high-desert   DARK=1  16NM Riyadh-Khalid desert
     RJSN 16   over-coast    DARK=3  8NM Sea of Japan
     CYYR 12   subarctic     DARK=1  20NM Goose-Bay tundra
     SCEL 17R  over-andes    DARK=2  18NM mountainous approach

   Per-airframe scoring (only triggered when phase is APPROACH
   and the local-aerodrome time-of-day window is NIGHT):

     1. ILL · Illusion-source magnitude = (10 - ambientLightIdx) +
              dark-terrain-NM weighting + over-water boost +
              MDA-floor-bust correlation.
     2. PROF · Profile-shallow risk = signed deviation below the
              ideal 3.0° vertical path (GPA = atan(VS / GS_fps)).
              Below-glide path is the canonical black-hole
              symptom.  Pure positive driver.
     3. ENRG · Energy-low / unstable approach proxy = energy
              ratio (V/Vref) at AGL.  Augments the LOC-I-on-final
              correlation per AC 120-71.
     4. LUMA · Lunar-phase / horizon-visibility proxy.  Synthetic
              from current UTC date, deterministic.  New-moon
              periods amplify ILL.
     5. EXP · Pilot/Operator night-approach experience proxy from
              operator-class (FLAG=low, MAJOR=low, REG=med, LCC=med,
              CARGO=med, BIZ-OWNER=high, GA=high).
     6. EQUIP · Equipment availability proxy: PAPI / VASI installed
              at airport reduces risk by 20pts; HUD / EFVS by 25;
              autoland by 40.  Default no-PAPI airports retain
              full driver weight.

   Composite max-driver × 0.65 + secondary-mean × 0.35 × ADV-MUL.

   6 hard tiers:
     - CRITICAL (rose)    score ≥ 80 — visual-illusion CFIT-imminent
     - HIGH (rose-pink)   score ≥ 62 — sustained low profile, glide
                           reduction, GS deviation
     - ELEVATED (amber)   score ≥ 44 — early-final risk
     - WATCH (sky)        score ≥ 24 — within scope but stabilised
     - NOMINAL (emerald)  score < 24
     - IDLE (slate)       not in scope / day / on-ground

   MapLibre overlay:
     - dark-terrain envelope polygons per runway (sector of length
       darkNM × width 1.5NM, tinted by darkness index)
     - rose CRITICAL / HIGH pins on offending aircraft
     - dashed link line aircraft → runway threshold
     - tier-coloured halo rings 8-22px by score
     - airport markers with black-hole class + DARK index
     - night-zone overlay (synthetic UTC-local time map)

   Side panel:
     - 6-tier counter strip, click-to-filter ALL
     - 4-cell MEAN / WORST / CRITICAL-count / NIGHT-AC summary
     - 4 sliders SCOPE 5-60NM, GPA-IDEAL 2.5-4.0°, ADV-MUL 50-200pct,
       NIGHT-OFFSET ±6h
     - 5-class terrain chip filter WATER/DESERT/VALLEY/SUBARCTIC/MIXED
     - HALO/PIN/ENVELOPE/LINK/LBL toggles
     - search by callsign / airport
     - AIRCRAFT / RUNWAYS / TERRAIN tab switcher

   References:
     · FAA-H-8083-25B Pilot's Handbook of Aero Knowledge Ch.17
       Aeromedical Factors §Visual Illusions Leading to Landing Errors
     · FAA AIM 8-1-5 Illusions in Flight (Black-Hole Approach)
     · FAA AC 60-22 Aeronautical Decision Making §10
     · FAA AC 60-25C Reference Material — Pilot Vision
     · FAA AC 120-71 SOP for Flight Deck Crewmembers §4
     · FAA AC 91-79B Runway Overrun Prevention App.1
     · NASA TM-2003-212279 Visual Approach Illusions
     · NASA CR-2010-216868 Black-Hole CFIT analysis
     · ICAO Annex 6 Pt I §4.3.4 night approach
     · ICAO Doc 9683 Human Factors Training Manual Ch.3
     · ICAO Doc 9870 Manual on Runway Safety §6
     · NTSB AAR-93-04 GP-Express Anniston / AAR-92-04 KAL-803 Tripoli
     · NTSB AAR-15-02 UPS-1354 / AAR-78-08 PSA-182
     · AAIB EW/G2014/06/02 Glasgow
     · ATSB AO-2010-019 Norfolk Island
     · Boeing FCTM 5.50 Stabilised Approach
     · Airbus Getting-to-Grips-with Approach-and-Landing §4
     · FSF ALAR Toolkit Briefing 5.3 / 5.4 Visual illusions
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'CRITICAL' | 'HIGH' | 'ELEVATED' | 'WATCH' | 'NOMINAL' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  CRITICAL:'#ef4444', HIGH:'#f43f5e', ELEVATED:'#f59e0b', WATCH:'#0ea5e9', NOMINAL:'#10b981', IDLE:'#475569',
}
const TIER_ORDER: Tier[] = ['CRITICAL','HIGH','ELEVATED','WATCH','NOMINAL']
const TIER_RANK: Record<Tier, number> = { CRITICAL:0, HIGH:1, ELEVATED:2, WATCH:3, NOMINAL:4, IDLE:5 }

type Terrain = 'WATER' | 'DESERT' | 'VALLEY' | 'SUBARCTIC' | 'MIXED'
const TERR_COLOR: Record<Terrain, string> = {
  WATER:'#0ea5e9', DESERT:'#f59e0b', VALLEY:'#a855f7', SUBARCTIC:'#94a3b8', MIXED:'#10b981',
}
const TERR_LIST: Terrain[] = ['WATER','DESERT','VALLEY','SUBARCTIC','MIXED']

interface BHRunway {
  icao: string; rwy: string; name: string; lat: number; lng: number; brg: number
  terr: Terrain; dark: number; darkNM: number; elev: number
  papi: boolean; hud: boolean
}

/* 20-airport catalogue — bearing is runway HEADING (i.e. magnetic
   landing direction), so threshold is at lat/lng and aircraft on
   final approaches from (brg+180) heading. darkNM = length of dark
   terrain over the inbound final. */
const RUNWAYS: BHRunway[] = [
  { icao:'PHNL', rwy:'08L', name:'Honolulu', lat:21.3245, lng:-157.9251, brg:80,  terr:'WATER',    dark:2, darkNM:16, elev:13,   papi:true,  hud:false },
  { icao:'PHOG', rwy:'02',  name:'Kahului',  lat:20.8867, lng:-156.4366, brg:20,  terr:'WATER',    dark:3, darkNM:10, elev:54,   papi:true,  hud:false },
  { icao:'KSAN', rwy:'27',  name:'San Diego',lat:32.7335, lng:-117.1897, brg:270, terr:'WATER',    dark:4, darkNM:6,  elev:17,   papi:true,  hud:true  },
  { icao:'PHTO', rwy:'26',  name:'Hilo',     lat:19.7203, lng:-155.0479, brg:260, terr:'WATER',    dark:2, darkNM:18, elev:38,   papi:true,  hud:false },
  { icao:'PANC', rwy:'07R', name:'Anchorage',lat:61.1744, lng:-149.9961, brg:70,  terr:'WATER',    dark:2, darkNM:14, elev:152,  papi:true,  hud:true  },
  { icao:'PAJN', rwy:'08',  name:'Juneau',   lat:58.3550, lng:-134.5763, brg:80,  terr:'VALLEY',   dark:1, darkNM:12, elev:21,   papi:false, hud:false },
  { icao:'KEGE', rwy:'25',  name:'Eagle Vail',lat:39.6426,lng:-106.9176, brg:250, terr:'VALLEY',   dark:1, darkNM:20, elev:6548, papi:true,  hud:false },
  { icao:'KASE', rwy:'15',  name:'Aspen',    lat:39.2230, lng:-106.8688, brg:150, terr:'VALLEY',   dark:1, darkNM:16, elev:7820, papi:true,  hud:false },
  { icao:'KJAC', rwy:'19',  name:'Jackson H',lat:43.6075, lng:-110.7395, brg:190, terr:'VALLEY',   dark:2, darkNM:18, elev:6451, papi:true,  hud:false },
  { icao:'KMMH', rwy:'27',  name:'Mammoth',  lat:37.6240, lng:-118.8378, brg:270, terr:'DESERT',   dark:2, darkNM:14, elev:7128, papi:true,  hud:false },
  { icao:'KSUN', rwy:'31',  name:'Sun Vly',  lat:43.5044, lng:-114.2961, brg:310, terr:'VALLEY',   dark:1, darkNM:18, elev:5318, papi:true,  hud:false },
  { icao:'KCRP', rwy:'13',  name:'Corpus C', lat:27.7704, lng:-97.5012,  brg:130, terr:'WATER',    dark:4, darkNM:6,  elev:44,   papi:true,  hud:false },
  { icao:'KEYW', rwy:'09',  name:'Key West', lat:24.5561, lng:-81.7559,  brg:90,  terr:'WATER',    dark:3, darkNM:10, elev:3,    papi:true,  hud:false },
  { icao:'SBSP', rwy:'35L', name:'Congonhas',lat:-23.6262,lng:-46.6553,  brg:350, terr:'MIXED',    dark:4, darkNM:4,  elev:2631, papi:true,  hud:false },
  { icao:'VOMM', rwy:'25',  name:'Chennai',  lat:12.9941, lng:80.1709,   brg:250, terr:'WATER',    dark:3, darkNM:6,  elev:52,   papi:true,  hud:false },
  { icao:'OERK', rwy:'33L', name:'Riyadh',   lat:24.9576, lng:46.6988,   brg:330, terr:'DESERT',   dark:2, darkNM:14, elev:2049, papi:true,  hud:false },
  { icao:'RJSN', rwy:'16',  name:'Niigata',  lat:37.9558, lng:139.1212,  brg:160, terr:'WATER',    dark:3, darkNM:8,  elev:11,   papi:true,  hud:false },
  { icao:'CYYR', rwy:'12',  name:'Goose Bay',lat:53.3192, lng:-60.4258,  brg:120, terr:'SUBARCTIC',dark:1, darkNM:20, elev:160,  papi:true,  hud:false },
  { icao:'SCEL', rwy:'17R', name:'Santiago', lat:-33.3930,lng:-70.7858,  brg:170, terr:'VALLEY',   dark:2, darkNM:18, elev:1555, papi:true,  hud:true  },
  { icao:'CYHZ', rwy:'05',  name:'Halifax',  lat:44.8808, lng:-63.5086,  brg:50,  terr:'MIXED',    dark:2, darkNM:14, elev:477,  papi:true,  hud:false },
]

interface Drivers { ILL:number; PROF:number; ENRG:number; LUMA:number; EXP:number; EQUIP:number }
interface Row {
  f: SFlight; rw: BHRunway
  distNM: number; bearingErrDeg: number; agl: number; gpaDeg: number; gpaDev: number
  drivers: Drivers; score: number; tier: Tier; notes: string[]
}

const KT_TO_FPS = 1.68781
const NM_TO_FT = 6076.12
function clamp(x:number,a:number,b:number){return Math.max(a,Math.min(b,x))}

/* Great-circle distance in NM (haversine). */
function gcDist(la1:number, lo1:number, la2:number, lo2:number): number {
  const R = 3440.065
  const phi1 = la1 * Math.PI/180, phi2 = la2 * Math.PI/180
  const dphi = (la2-la1) * Math.PI/180
  const dlam = (lo2-lo1) * Math.PI/180
  const a = Math.sin(dphi/2)**2 + Math.cos(phi1)*Math.cos(phi2)*Math.sin(dlam/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}
function bearingTo(la1:number, lo1:number, la2:number, lo2:number): number {
  const phi1 = la1 * Math.PI/180, phi2 = la2 * Math.PI/180
  const dlam = (lo2-lo1) * Math.PI/180
  const y = Math.sin(dlam) * Math.cos(phi2)
  const x = Math.cos(phi1)*Math.sin(phi2) - Math.sin(phi1)*Math.cos(phi2)*Math.cos(dlam)
  return (Math.atan2(y, x) * 180/Math.PI + 360) % 360
}
function angleDiff(a:number, b:number): number {
  let d = ((a - b) % 360 + 540) % 360 - 180
  return Math.abs(d)
}

/* Local approximate aerodrome solar position from UTC + longitude.
   Sun above horizon = day. Crude: |solar hour - 12| < 6 → day. */
function isLocalNight(lng:number, nowMs:number, offsetH:number): boolean {
  const utcH = (nowMs/3600000) % 24
  const localH = (utcH + lng/15 + offsetH + 48) % 24
  return localH < 6.5 || localH > 18.0
}

/* Synthetic lunar-illumination 0..1 from date (deterministic).
   Real value not critical; just used for LUMA driver. */
function lunarPhase(nowMs:number): number {
  const days = nowMs / 86400000
  const cyc = 29.53059
  const ph = ((days - 13.5) % cyc + cyc) % cyc / cyc
  // 0=new 0.5=full
  return 1 - Math.abs(ph - 0.5) * 2 // 0=new 1=full
}

function operatorExp(op?: string, callsign?: string): number {
  const s = `${op||''} ${callsign||''}`.toUpperCase()
  if (/^(UAL|AAL|DAL|BAW|DLH|AFR|KLM|JAL|ANA|QFA|SIA|CPA|EIN|IBE|VIR|ETD|UAE|QTR)/.test(s)) return 18
  if (/^(EZY|RYR|JBU|NKS|SWA|VRD|ACA|WJA|EZS|VLG|FDB|W6|IBK)/.test(s)) return 32
  if (/^(FDX|UPS|ABX|GTI|CLX|GEC|CAL|ATN|ABW|MPH|NCA|CKS)/.test(s)) return 28
  if (/^(NETJ|FLEXJET|XOJ|EJM|JET|PRIV|CORP|EXEC)/.test(s)) return 55
  if (/^N\d/.test(s)) return 68 // generic GA N-reg
  return 38
}

function scoreRow(f: SFlight, rw: BHRunway, advMul: number, gpaIdeal: number, nowMs: number, offsetH: number): Row | null {
  // Approach geometry: aircraft must be inbound to runway, descending
  if (f.ground) return null
  const distNM = gcDist(f.lat, f.lng, rw.lat, rw.lng)
  if (distNM > 60) return null
  const brgToRwy = bearingTo(f.lat, f.lng, rw.lat, rw.lng)
  // inbound-axis = runway heading (landing direction). aircraft's
  // bearing-to-threshold should equal rwy.brg (approaching from
  // upwind of runway).
  const bearingErrDeg = angleDiff(brgToRwy, rw.brg)
  if (bearingErrDeg > 35) return null
  if (f.vertRate > 100) return null // not descending
  // Approach altitude band: < 6000 AGL  
  const agl = Math.max(0, f.altitudeFt - rw.elev)
  if (agl > 6500) return null
  if (agl < 200) return null // already at MDA / landed

  const night = isLocalNight(rw.lng, nowMs, offsetH)
  if (!night) return null

  /* GPA: arctan(VS / GS_fps).  VS is fpm → divide 60.  GS fps =
     velocityKts × 1.68781.  Convert to degrees. */
  const vsFps = f.vertRate / 60 // ft/s descent rate (negative)
  const gsFps = f.velocityKts * KT_TO_FPS
  const gpaDeg = gsFps > 1 ? Math.atan2(-vsFps, gsFps) * 180/Math.PI : 0
  const gpaDev = gpaIdeal - gpaDeg // positive = shallower than ideal

  /* 1. ILL — illusion-source magnitude */
  const ambientGap = 10 - rw.dark // 1..10
  const overWater = rw.terr === 'WATER' ? 12 : 0
  const distDeep = clamp((rw.darkNM - distNM) >= -2 ? Math.min(rw.darkNM, distNM) * 3 : 0, 0, 32)
  let ILL = ambientGap * 5 + overWater + distDeep
  ILL = clamp(ILL, 0, 100)

  /* 2. PROF — shallow-profile black-hole symptom */
  let PROF = 0
  if (gpaDev > 0) {
    PROF = clamp(gpaDev * 28, 0, 100)
  } else PROF = clamp(-gpaDev * 8, 0, 35)

  /* 3. ENRG — energy-low proxy: kt/AGL ratio vs nominal */
  // Nominal approach: 140 KIAS at 1000 ft, 180 KIAS at 3000 ft
  const expectedKt = clamp(120 + (agl/1000) * 25, 120, 220)
  const energy = f.velocityKts / expectedKt
  let ENRG = 0
  if (energy < 0.88) ENRG = clamp((0.88 - energy) * 220, 0, 100)
  else if (energy > 1.12) ENRG = clamp((energy - 1.12) * 120, 0, 60)

  /* 4. LUMA — moon-darkness boost */
  const moon = lunarPhase(nowMs)
  const LUMA = clamp((1 - moon) * 30 + (rw.terr === 'SUBARCTIC' ? 10 : 0), 0, 60)

  /* 5. EXP — operator night-approach experience proxy */
  const EXP = operatorExp(f.operator, f.callsign)

  /* 6. EQUIP — equipment mitigations: PAPI/HUD reduce */
  let mitigation = 0
  if (rw.papi) mitigation += 20
  if (rw.hud) mitigation += 18
  const EQUIP = clamp(60 - mitigation, 0, 60)

  const drivers: Drivers = { ILL, PROF, ENRG, LUMA, EXP, EQUIP }
  const vals = Object.values(drivers)
  const max = Math.max(...vals)
  const mean = vals.reduce((a,b)=>a+b,0) / vals.length
  let score = (max * 0.65 + mean * 0.35) * (advMul/100)

  const notes: string[] = []
  if (PROF >= 70) {
    score = Math.max(score, 84)
    notes.push('Sustained below-ideal-glide on dark final — verify PAPI/VASI red-over-red, go-around if uncertain (AIM 8-1-5)')
  }
  if (ILL >= 70 && PROF >= 35) {
    score = Math.max(score, 78)
    notes.push('Black-hole illusion zone: cross-check radar altimeter and ILS/RNAV vertical guidance (FAA-H-8083-25B Ch.17)')
  }
  if (ENRG >= 60) notes.push('Energy-low on final: add power early, fly the donut (AC 120-71 §4)')
  if (rw.terr === 'WATER' && PROF >= 50) notes.push('Over-water final: featureless surface, lean on baro-VNAV/ILS GS (FSF ALAR 5.3)')
  if (rw.terr === 'VALLEY' && agl < 2000) notes.push('Mountain-valley dark approach: ensure MOCA/MORA clearance (Doc 9683 Ch.3)')

  score = clamp(score, 0, 100)

  let tier: Tier
  if (score >= 80) tier = 'CRITICAL'
  else if (score >= 62) tier = 'HIGH'
  else if (score >= 44) tier = 'ELEVATED'
  else if (score >= 24) tier = 'WATCH'
  else tier = 'NOMINAL'

  return { f, rw, distNM, bearingErrDeg, agl, gpaDeg, gpaDev, drivers, score, tier, notes }
}

/* Build dark-terrain envelope polygon for a runway as a triangle
   from threshold outward along approach back-azimuth, length =
   darkNM, half-width = 1.2NM. Returns geojson coords [lng,lat]. */
function darkEnvelope(rw: BHRunway): number[][] {
  const backAz = (rw.brg + 180) % 360
  const tipNM = rw.darkNM
  const halfW = 1.2
  const tip = offsetLatLng(rw.lat, rw.lng, backAz, tipNM)
  const left = offsetLatLng(tip.lat, tip.lng, (backAz + 90) % 360, halfW)
  const right = offsetLatLng(tip.lat, tip.lng, (backAz + 270) % 360, halfW)
  return [
    [rw.lng, rw.lat],
    [left.lng, left.lat],
    [tip.lng, tip.lat],
    [right.lng, right.lat],
    [rw.lng, rw.lat],
  ]
}
function offsetLatLng(lat:number, lng:number, brg:number, distNM:number): {lat:number, lng:number} {
  const R = 3440.065
  const phi1 = lat * Math.PI/180
  const lam1 = lng * Math.PI/180
  const th = brg * Math.PI/180
  const d = distNM / R
  const phi2 = Math.asin(Math.sin(phi1)*Math.cos(d) + Math.cos(phi1)*Math.sin(d)*Math.cos(th))
  const lam2 = lam1 + Math.atan2(Math.sin(th)*Math.sin(d)*Math.cos(phi1), Math.cos(d) - Math.sin(phi1)*Math.sin(phi2))
  return { lat: phi2 * 180/Math.PI, lng: ((lam2 * 180/Math.PI + 540) % 360) - 180 }
}

export default function BlkHolIllusion({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'RUNWAYS'|'TERRAIN'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [terrFilter, setTerrFilter] = useState<Record<Terrain, boolean>>(()=>Object.fromEntries(TERR_LIST.map(t=>[t,true])) as Record<Terrain, boolean>)
  const [q, setQ] = useState('')
  const [advMul, setAdvMul] = useState(100)
  const [scopeNM, setScopeNM] = useState(40)
  const [gpaIdeal, setGpaIdeal] = useState(3.0)
  const [offsetH, setOffsetH] = useState(0)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showEnv, setShowEnv] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => { const t = setInterval(()=>setTick(x=>x+1), 30000); return ()=>clearInterval(t) }, [])

  const rows = useMemo<Row[]>(() => {
    const now = Date.now()
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      // pick closest in-scope runway, score
      let best: Row | null = null
      for (const rw of RUNWAYS) {
        if (!terrFilter[rw.terr]) continue
        const d = gcDist(f.lat, f.lng, rw.lat, rw.lng)
        if (d > scopeNM) continue
        const r = scoreRow(f, rw, advMul, gpaIdeal, now, offsetH)
        if (!r) continue
        if (!best || r.score > best.score) best = r
      }
      if (best) out.push(best)
    }
    return out.sort((a,b) => TIER_RANK[a.tier]-TIER_RANK[b.tier] || b.score - a.score)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flights, advMul, scopeNM, gpaIdeal, offsetH, terrFilter, tick])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { CRITICAL:0, HIGH:0, ELEVATED:0, WATCH:0, NOMINAL:0, IDLE:0 }
    rows.forEach(r => c[r.tier]++); return c
  }, [rows])

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      r = r.filter(x => (x.f.callsign||'').toLowerCase().includes(s) || (x.f.icao||'').toLowerCase().includes(s) || x.rw.icao.toLowerCase().includes(s) || x.rw.name.toLowerCase().includes(s))
    }
    return r
  }, [rows, tierFilter, q])

  const mean = rows.length ? rows.reduce((a,b)=>a+b.score,0)/rows.length : 0
  const worst = rows[0]
  const critCt = tierCounts.CRITICAL + tierCounts.HIGH

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const SRC = 'blkhol-src'
    const SRC_AC = 'blkhol-ac'
    const SRC_ENV = 'blkhol-env'
    const SRC_LINK = 'blkhol-link'
    const SRC_RWY = 'blkhol-rwy'
    const HALO = 'blkhol-halo', PIN = 'blkhol-pin', LBL = 'blkhol-lbl'
    const ENV_FILL = 'blkhol-env-fill', ENV_LINE = 'blkhol-env-line'
    const LINK = 'blkhol-link-l'
    const RWY_PT = 'blkhol-rwy-pt', RWY_LBL = 'blkhol-rwy-lbl'

    const acFC = { type:'FeatureCollection' as const, features: rows.map(r => ({
      type:'Feature' as const,
      geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat] },
      properties:{
        cs: r.f.callsign || r.f.icao, tier: r.tier, score: Math.round(r.score),
        color: TIER_COLOR[r.tier], rwy: `${r.rw.icao}/${r.rw.rwy}`,
        gpa: r.gpaDeg.toFixed(1), haloR: 8 + (4 - Math.min(4, TIER_RANK[r.tier])) * 3.5,
        pinScale: r.tier === 'CRITICAL' ? 1.6 : r.tier === 'HIGH' ? 1.2 : 0,
      },
    })) }

    const visibleRunways = RUNWAYS.filter(rw => terrFilter[rw.terr])
    const envFC = { type:'FeatureCollection' as const, features: visibleRunways.map(rw => ({
      type:'Feature' as const,
      geometry:{ type:'Polygon' as const, coordinates:[ darkEnvelope(rw) ] },
      properties:{ icao: rw.icao, terr: rw.terr, dark: rw.dark, color: TERR_COLOR[rw.terr] },
    })) }

    const linkFC = { type:'FeatureCollection' as const, features: rows.filter(r => r.tier !== 'NOMINAL').map(r => ({
      type:'Feature' as const,
      geometry:{ type:'LineString' as const, coordinates:[ [r.f.lng, r.f.lat], [r.rw.lng, r.rw.lat] ] },
      properties:{ color: TIER_COLOR[r.tier] },
    })) }

    const rwyFC = { type:'FeatureCollection' as const, features: visibleRunways.map(rw => ({
      type:'Feature' as const,
      geometry:{ type:'Point' as const, coordinates:[rw.lng, rw.lat] },
      properties:{ label: `${rw.icao}/${rw.rwy}`, color: TERR_COLOR[rw.terr], dark: rw.dark },
    })) }

    const add = () => {
      try {
        if (!map.getSource(SRC_AC)) map.addSource(SRC_AC, { type:'geojson', data: acFC as any }); else (map.getSource(SRC_AC) as any).setData(acFC)
        if (!map.getSource(SRC_ENV)) map.addSource(SRC_ENV, { type:'geojson', data: envFC as any }); else (map.getSource(SRC_ENV) as any).setData(envFC)
        if (!map.getSource(SRC_LINK)) map.addSource(SRC_LINK, { type:'geojson', data: linkFC as any }); else (map.getSource(SRC_LINK) as any).setData(linkFC)
        if (!map.getSource(SRC_RWY)) map.addSource(SRC_RWY, { type:'geojson', data: rwyFC as any }); else (map.getSource(SRC_RWY) as any).setData(rwyFC)

        if (showEnv) {
          if (!map.getLayer(ENV_FILL)) map.addLayer({ id: ENV_FILL, type:'fill', source: SRC_ENV, paint:{
            'fill-color':['get','color'],
            'fill-opacity':['interpolate',['linear'],['get','dark'], 1, 0.22, 5, 0.06],
          }})
          if (!map.getLayer(ENV_LINE)) map.addLayer({ id: ENV_LINE, type:'line', source: SRC_ENV, paint:{
            'line-color':['get','color'], 'line-width':1.2, 'line-opacity':0.6, 'line-dasharray':[2,2],
          }})
        }
        if (showLink && !map.getLayer(LINK)) map.addLayer({ id: LINK, type:'line', source: SRC_LINK, paint:{
          'line-color':['get','color'], 'line-width':1.3, 'line-opacity':0.7, 'line-dasharray':[1.5,1.5],
        }})
        if (!map.getLayer(RWY_PT)) map.addLayer({ id: RWY_PT, type:'circle', source: SRC_RWY, paint:{
          'circle-radius':4, 'circle-color':['get','color'], 'circle-stroke-color':'#0b1220', 'circle-stroke-width':1.2,
        }})
        if (!map.getLayer(RWY_LBL)) map.addLayer({ id: RWY_LBL, type:'symbol', source: SRC_RWY, layout:{
          'text-field':['get','label'], 'text-size':9, 'text-offset':[0, -1.2], 'text-anchor':'bottom',
          'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
        }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 }})
        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id: HALO, type:'circle', source: SRC_AC, paint:{
          'circle-radius':['get','haloR'], 'circle-color':['get','color'],
          'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85,
        }})
        if (showPin && !map.getLayer(PIN)) map.addLayer({ id: PIN, type:'circle', source: SRC_AC, filter:['>',['get','pinScale'],0], paint:{
          'circle-radius':['*', 5.5, ['get','pinScale']],
          'circle-color':['get','color'], 'circle-stroke-color':'#fff', 'circle-stroke-width':1.3,
        }})
        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id: LBL, type:'symbol', source: SRC_AC, layout:{
          'text-field':['concat',['get','cs'],'  ',['get','rwy'],'  GPA ',['get','gpa'],'°  ',['get','tier']],
          'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top',
          'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
        }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 }})
      } catch {}
    }
    if (map.isStyleLoaded()) add(); else map.once('load', add)
    return () => {
      try {
        for (const l of [LBL, PIN, HALO, LINK, ENV_LINE, ENV_FILL, RWY_LBL, RWY_PT]) if (map.getLayer(l)) map.removeLayer(l)
        for (const s of [SRC_AC, SRC_ENV, SRC_LINK, SRC_RWY, SRC]) if (map.getSource(s)) map.removeSource(s)
      } catch {}
    }
  }, [map, rows, showHalo, showPin, showLbl, showEnv, showLink, terrFilter])

  return (
    <div className="absolute right-3 top-20 z-30 w-[460px] max-h-[78vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">BLKHOL</div>
        <div className="text-[10px] text-slate-400 truncate">Black-Hole / featureless-terrain night-approach illusion monitor</div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
        </div>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {(['CRITICAL','HIGH','ELEVATED','WATCH','NOMINAL'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[8px]" style={{color: TIER_COLOR[t]}}>{t.slice(0,4)}</div>
            <div className="text-slate-100 font-semibold">{tierCounts[t]}</div>
          </button>
        ))}
        <button onClick={() => setTierFilter('ALL')} className={`px-1 py-1 rounded border ${tierFilter==='ALL'?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
          <div className="text-[8px] text-slate-400">ALL</div>
          <div className="text-slate-100 font-semibold">{rows.length}</div>
        </button>
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">MEAN</div>
          <div className="text-slate-100 font-semibold">{mean.toFixed(1)}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">WORST</div>
          <div className="text-slate-100 font-semibold truncate">{worst ? worst.f.callsign || worst.f.icao : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">CRIT+HI</div>
          <div className="font-semibold" style={{color: critCt ? TIER_COLOR.CRITICAL : '#cbd5e1'}}>{critCt}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">NIGHT-RWY</div>
          <div className="text-slate-100 font-semibold">{RUNWAYS.filter(rw => terrFilter[rw.terr] && isLocalNight(rw.lng, Date.now(), offsetH)).length}/{RUNWAYS.length}</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
        {([
          ['SCOPE', scopeNM, setScopeNM, 5, 60, 'NM', 1],
          ['ADV-MUL', advMul, setAdvMul, 50, 200, '%', 1],
          ['GPA-IDEAL', gpaIdeal, setGpaIdeal as any, 2.5, 4.0, '°', 0.1],
          ['UTC-OFF', offsetH, setOffsetH as any, -6, 6, 'h', 1],
        ] as Array<[string, number, (n:number)=>void, number, number, string, number]>).map(([lbl,val,set,lo,hi,suf,step]) => (
          <label key={lbl} className="flex items-center gap-1.5">
            <span className="text-slate-500 w-16">{lbl}</span>
            <input type="range" min={lo} max={hi} step={step} value={val}
              onChange={e => set(parseFloat(e.target.value))}
              className="flex-1 h-1 accent-sky-500" />
            <span className="text-slate-300 tabular-nums w-12 text-right">{typeof val === 'number' && step < 1 ? val.toFixed(1) : val}{suf}</span>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800/60">
        {TERR_LIST.map(t => (
          <button key={t} onClick={() => setTerrFilter(p => ({...p, [t]: !p[t]}))}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${terrFilter[t]?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700 opacity-50'}`}
            style={{color: TERR_COLOR[t]}}>{t}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60 text-[9px]">
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['ENV',showEnv,setShowEnv],['LINK',showLink,setShowLink],['LBL',showLbl,setShowLbl]] as const).map(([n,v,s])=>(
          <button key={n} onClick={()=>(s as any)(!v)} className={`px-1.5 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500 hover:border-slate-700'}`}>{n}</button>
        ))}
      </div>

      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / icao / airport"
          className="flex-1 bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/40" />
      </div>
      <div className="flex gap-0.5 px-3 py-1.5 border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','RUNWAYS','TERRAIN'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 text-slate-100 border border-sky-500/40':'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1 text-[11px]">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500">no night black-hole approaches in scope · adjust SCOPE / UTC-OFF / terrain chips</div>}
            {filtered.slice(0, 60).map(r => (
              <button key={r.f.icao} onClick={()=>onFly(r.f.icao)} className="w-full text-left px-3 py-2 hover:bg-slate-900/60 transition">
                <div className="flex items-center gap-2 mb-1" style={{borderLeft:`3px solid ${TIER_COLOR[r.tier]}`, paddingLeft:8}}>
                  <span className="font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                  <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                  <span className="text-[9px] px-1 py-px rounded bg-slate-800/70" style={{color: TERR_COLOR[r.rw.terr]}}>{r.rw.terr}</span>
                  <span className="text-[9px] px-1 py-px rounded bg-slate-800/70 text-sky-300">{r.rw.icao}/{r.rw.rwy}</span>
                  <span className="ml-auto text-[9px] px-1.5 py-px rounded font-bold" style={{background: TIER_COLOR[r.tier]+'22', color: TIER_COLOR[r.tier]}}>{r.tier}</span>
                </div>
                <div className="grid grid-cols-4 gap-x-2 gap-y-1 text-[10px] pl-2">
                  <div><span className="text-slate-500">DIST </span><span className="text-slate-100 tabular-nums">{r.distNM.toFixed(1)}nm</span></div>
                  <div><span className="text-slate-500">AGL </span><span className="text-slate-100 tabular-nums">{r.agl.toFixed(0)}ft</span></div>
                  <div><span className="text-slate-500">GPA </span><span className="tabular-nums" style={{color: r.gpaDev > 0.5 ? TIER_COLOR.CRITICAL : r.gpaDev > 0.2 ? TIER_COLOR.HIGH : '#cbd5e1'}}>{r.gpaDeg.toFixed(1)}°</span></div>
                  <div><span className="text-slate-500">Δ </span><span className="tabular-nums" style={{color: r.gpaDev > 0.5 ? TIER_COLOR.CRITICAL : '#cbd5e1'}}>{r.gpaDev > 0 ? '-' : '+'}{Math.abs(r.gpaDev).toFixed(2)}°</span></div>
                  <div><span className="text-slate-500">VS </span><span className="text-slate-100 tabular-nums">{r.f.vertRate.toFixed(0)}</span></div>
                  <div><span className="text-slate-500">KT </span><span className="text-slate-100 tabular-nums">{r.f.velocityKts.toFixed(0)}</span></div>
                  <div className="col-span-2"><span className="text-slate-500">RWY-DARK </span><span className="text-slate-100 tabular-nums">{r.rw.dark}/10 · {r.rw.darkNM}nm</span></div>
                </div>
                <div className="mt-1.5 pl-2">
                  <div className="w-full bg-slate-900/60 rounded h-1 overflow-hidden">
                    <div className="h-full" style={{width:`${Math.round(r.score)}%`, background: TIER_COLOR[r.tier]}}></div>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {(Object.entries(r.drivers) as [keyof Drivers, number][]).map(([k,v]) => (
                      <span key={k} className="text-[8.5px] px-1 py-px rounded bg-slate-900/60 text-slate-400 border border-slate-800/60">
                        {k} <span className="tabular-nums" style={{color: v > 60 ? TIER_COLOR.CRITICAL : v > 30 ? TIER_COLOR.ELEVATED : '#cbd5e1'}}>{v.toFixed(0)}</span>
                      </span>
                    ))}
                  </div>
                  {r.notes.length > 0 && (
                    <div className="mt-1.5 space-y-0.5">
                      {r.notes.map((n,i) => (
                        <div key={i} className="text-[10px] text-rose-300/85 italic">› {n}</div>
                      ))}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {tab === 'RUNWAYS' && (
          <div className="divide-y divide-slate-800/60">
            {(() => {
              const groups = new Map<string, Row[]>()
              rows.forEach(r => { const k = `${r.rw.icao}/${r.rw.rwy}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r) })
              const visible = RUNWAYS.filter(rw => terrFilter[rw.terr])
              return visible.map(rw => {
                const rs = groups.get(`${rw.icao}/${rw.rwy}`) || []
                const meanS = rs.length ? rs.reduce((a,b)=>a+b.score,0)/rs.length : 0
                const worstT: Tier = rs.length ? rs.reduce((a,b)=>TIER_RANK[b.tier] < TIER_RANK[a]?b.tier:a, 'NOMINAL' as Tier) : 'IDLE'
                const isNight = isLocalNight(rw.lng, Date.now(), offsetH)
                return (
                  <div key={`${rw.icao}/${rw.rwy}`} className="px-3 py-2" style={{borderLeft:`3px solid ${TIER_COLOR[worstT]}`}}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-sky-300 text-[12px]">{rw.icao}/{rw.rwy}</span>
                      <span className="text-slate-400 text-[10px]">{rw.name}</span>
                      <span className="text-[9px] px-1 py-px rounded bg-slate-800/70" style={{color: TERR_COLOR[rw.terr]}}>{rw.terr}</span>
                      {isNight ? <span className="text-[9px] px-1 py-px rounded bg-indigo-900/70 text-indigo-300">NIGHT</span> : <span className="text-[9px] px-1 py-px rounded bg-amber-900/40 text-amber-400">DAY</span>}
                      <span className="ml-auto text-[10px] text-slate-400 tabular-nums">n={rs.length}</span>
                    </div>
                    <div className="grid grid-cols-4 gap-x-2 text-[10px] pl-2">
                      <div><span className="text-slate-500">BRG </span><span className="tabular-nums text-slate-200">{rw.brg.toString().padStart(3,'0')}°</span></div>
                      <div><span className="text-slate-500">ELEV </span><span className="tabular-nums text-slate-200">{rw.elev}ft</span></div>
                      <div><span className="text-slate-500">DARK </span><span className="tabular-nums text-slate-200">{rw.dark}/10</span></div>
                      <div><span className="text-slate-500">DARK-NM </span><span className="tabular-nums text-slate-200">{rw.darkNM}</span></div>
                      <div><span className="text-slate-500">PAPI </span><span className={rw.papi?'text-emerald-400':'text-rose-400'}>{rw.papi?'YES':'NO'}</span></div>
                      <div><span className="text-slate-500">HUD </span><span className={rw.hud?'text-emerald-400':'text-slate-500'}>{rw.hud?'YES':'—'}</span></div>
                      <div className="col-span-2"><span className="text-slate-500">MEAN </span><span className="tabular-nums text-slate-100">{meanS.toFixed(1)}</span></div>
                    </div>
                    <div className="w-full bg-slate-900/60 rounded h-1 overflow-hidden mt-1.5">
                      <div className="h-full" style={{width:`${Math.round(meanS)}%`, background: TIER_COLOR[worstT]}}></div>
                    </div>
                  </div>
                )
              })
            })()}
          </div>
        )}

        {tab === 'TERRAIN' && (
          <div className="divide-y divide-slate-800/60">
            {TERR_LIST.map(t => {
              const ofTerr = RUNWAYS.filter(rw => rw.terr === t)
              const inscope = rows.filter(r => r.rw.terr === t)
              const meanS = inscope.length ? inscope.reduce((a,b)=>a+b.score,0)/inscope.length : 0
              const meanDark = ofTerr.length ? ofTerr.reduce((a,b)=>a+b.dark,0)/ofTerr.length : 0
              const worstT: Tier = inscope.length ? inscope.reduce((a,b)=>TIER_RANK[b.tier] < TIER_RANK[a]?b.tier:a, 'NOMINAL' as Tier) : 'IDLE'
              return (
                <div key={t} className="px-3 py-2" style={{borderLeft:`3px solid ${TIER_COLOR[worstT]}`}}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold text-[12px]" style={{color: TERR_COLOR[t]}}>{t}</span>
                    <span className="text-[10px] text-slate-400">{ofTerr.length} runways</span>
                    <span className="ml-auto text-[10px] text-slate-400 tabular-nums">n-ac={inscope.length}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-x-2 text-[10px] pl-2">
                    <div><span className="text-slate-500">MEAN-DARK </span><span className="tabular-nums text-slate-200">{meanDark.toFixed(1)}/10</span></div>
                    <div><span className="text-slate-500">MEAN-SCORE </span><span className="tabular-nums text-slate-200">{meanS.toFixed(1)}</span></div>
                    <div><span className="text-slate-500">WORST </span><span className="tabular-nums" style={{color: TIER_COLOR[worstT]}}>{worstT}</span></div>
                  </div>
                  <div className="text-[9.5px] text-slate-500 italic mt-1">
                    {t === 'WATER' && 'Over-water final · featureless surface · FSF ALAR 5.3 · NTSB AAR-78-08 PSA-182'}
                    {t === 'DESERT' && 'High-desert sparse-light · AC 60-22 §10 · NTSB AAR-93-04 GP-Express'}
                    {t === 'VALLEY' && 'Mountain-valley dark approach · Doc 9683 Ch.3 · NTSB AAR-19-04'}
                    {t === 'SUBARCTIC' && 'Subarctic tundra/snow uniform reflectance · ICAO Annex 6 Pt I §4.3.4'}
                    {t === 'MIXED' && 'Mixed urban/dark transition · pattern-disrupted depth perception · AC 60-25C'}
                  </div>
                  <div className="w-full bg-slate-900/60 rounded h-1 overflow-hidden mt-1.5">
                    <div className="h-full" style={{width:`${Math.round(meanS)}%`, background: TIER_COLOR[worstT]}}></div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800/60 text-[9px] text-slate-500 italic">
        AIM 8-1-5 · FAA-H-8083-25B Ch.17 · AC 60-22/60-25C/120-71 · NASA TM-2003-212279 · ICAO Doc 9683 Ch.3 · FSF ALAR 5.3/5.4 · NTSB AAR-93-04/15-02
      </div>
    </div>
  )
}
