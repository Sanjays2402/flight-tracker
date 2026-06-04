'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   LRAH · Launch & Reentry Aircraft Hazard-Area Monitor
   ------------------------------------------------------------
   FAA 14 CFR Part 450 Launch & Reentry Licensing (final rule
     2020) §450.101 hazard analysis / §450.139 mission rules /
   FAA AC 450.139-1A Hazard-Area determination /
   FAA AC 91-63D Temporary Flight Restrictions /
   FAA Order JO 7210.3DD §18-9 Space-Vehicle Operations /
   FAA Order JO 7110.65 §9-3 Space Launch & Reentry / §9-4
     Aircraft Hazard Area (AHA) and AOA construct /
   FAA Space Data Integrator (SDI) ConOps v2.0 /
   FAA SDI Performance & Operational Requirements 2023 /
   ICAO Annex 11 §2.20 Space operations coordination /
   ICAO Doc 10039 Manual on Vertical Coordination of Civil-
     Military Air Traffic Mgmt and Space Operations §4 /
   ICAO Space Vehicle Operations Symposium 2022 outcomes /
   EUROCONTROL Sub-Orbital Vehicle Concept of Operations 2019 /
   FAA AST Quarterly Launch Reports 2022-2024 /
   FAA AHA dynamic-window methodology (Aerospace Corp 2019) /
   Aerospace Corp TOR-2018-02816 Debris Risk to Aircraft /
   NTSB AAB-04-01 N629RA SpaceShipOne contingency /
   NTSB AAR-15-02 SpaceShipTwo VSS Enterprise breakup /
   Mojave Air & Space Port event review 2014 /
   FAA AST Reentry Risk Analysis Handbook 2022 /
   ASTM F3322-22 UAS / suborbital flight test / 
   AIA NAS Space Integration Roadmap 2021.

   "Aircraft Hazard Area" (AHA) is the volume around a launch
   or reentry vehicle ground track within which the probability
   of a debris strike on an overflying aircraft exceeds the
   1e-7 / flight-hour collective risk threshold per Part 450
   §450.101(c). AHA windows are pre-coordinated with FAA ATC,
   published as ALTRVs / TFRs (NOTAM-formatted), and activated
   T-minus the launch-commit countdown plus a margin. Once a
   vehicle enters nominal trajectory, sub-volumes can be
   released via Space Data Integrator (SDI) dynamic re-opening.

   This monitor evaluates active tracked aircraft against a
   24-entry catalogue of currently-planned launch / reentry
   windows spanning the principal global launch & reentry
   sites: KSC/CCSFS-USA (39A Falcon-9, SLC-40 Falcon, SLC-37
   Vulcan-Delta, SLC-41 Vulcan/Atlas), VAFB/SLC-4 Falcon-9,
   Boca Chica Starbase Starship, MARS Wallops Antares/Minotaur,
   Kodiak PSCA Astra/Firefly, Spaceport-America VG Galactic,
   Mojave VSS, Mahia LC-1 Electron/Neutron, Kourou ELA-3/ELA-4
   Ariane-6 + Vega-C, Tanegashima H3, Baikonur Soyuz, Plesetsk
   Soyuz/Angara, Vostochny Soyuz/Angara, Wenchang Long-March-7,
   Jiuquan Long-March-2, Taiyuan Long-March-4, Sriharikota
   GSLV/PSLV, Hyderabad Skyroot, Kennedy Crew Dragon reentry
   splashdown zones, ISS Crew Dragon Pacific recovery box,
   Soyuz Kazakh-steppe landing, X-37B reentry corridor, Boeing
   Starliner WSMR recovery, and Blue Origin New Shepard
   sub-orbital arc.

   6 risk drivers (max-driver composite):
     · IAH  inside-AHA volume gate (0 outside, 100 inside)
     · PRX  proximity to AHA boundary
     · TTI  time-to-AHA-entry along track at GS
     · WND  launch-window proximity (T-30 → 100, > T+2h → 0)
     · ALT  altitude-band overlap with AHA floor/ceiling
     · CLS  class severity (LAUNCH 90 / REENTRY 100 / SUB-ORB 60)

   6 hard tiers:
     · BREACH-ACT    inside active-window AHA → divert
     · BREACH-IMM    inside AHA pre-window     → exit now
     · PRE-ACT       T-30 close to active AHA  → re-route
     · WATCH         AHA within scope          → brief crew
     · INFO          AHA in 24-h horizon       → plan around
     · CLEAR         well clear of any AHA
============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'BREACH-ACT' | 'BREACH-IMM' | 'PRE-ACT' | 'WATCH' | 'INFO' | 'CLEAR'
const TIER_COLOR: Record<Tier, string> = {
  'BREACH-ACT': '#ef4444', 'BREACH-IMM': '#f43f5e', 'PRE-ACT': '#f43f5e',
  WATCH: '#f59e0b', INFO: '#0ea5e9', CLEAR: '#10b981',
}
const TIER_ORDER: Tier[] = ['BREACH-ACT', 'BREACH-IMM', 'PRE-ACT', 'WATCH', 'INFO', 'CLEAR']
const TIER_RANK: Record<Tier, number> = { 'BREACH-ACT': 0, 'BREACH-IMM': 1, 'PRE-ACT': 2, WATCH: 3, INFO: 4, CLEAR: 5 }

type Klass = 'LAUNCH' | 'REENTRY' | 'SUB-ORB'
const KLASS_COLOR: Record<Klass, string> = { LAUNCH: '#a855f7', REENTRY: '#ec4899', 'SUB-ORB': '#22d3ee' }
const KLASS_WT: Record<Klass, number> = { LAUNCH: 90, REENTRY: 100, 'SUB-ORB': 60 }

type State = 'ACTIVE' | 'IMMINENT' | 'SCHEDULED' | 'STANDBY'
const STATE_COLOR: Record<State, string> = { ACTIVE: '#ef4444', IMMINENT: '#f43f5e', SCHEDULED: '#f59e0b', STANDBY: '#0ea5e9' }

interface Aha {
  id: string; site: string; pad: string; country: string
  vehicle: string; operator: string
  klass: Klass
  lat: number; lng: number
  /** AHA radius (NM) modelled as circular for early-flight phase */
  radiusNm: number
  /** floor / ceiling of AHA volume (ft MSL) */
  floorFt: number
  ceilFt: number
  /** down-range bearing of trajectory (deg, used to render asymmetric corridor) */
  azimuth: number
  /** corridor down-range length (NM) */
  corridorNm: number
  /** minutes from "now" to T-0 (positive = future, negative = recently passed) */
  tMinusMin: number
  /** window-open duration (minutes either side of T-0) */
  windowMin: number
  notam: string
  brief: string
}

const AHAS: Aha[] = [
  // KSC / CCSFS
  { id: 'KSC39A',  site: 'Kennedy LC-39A',         pad: '39A',   country: 'USA', vehicle: 'Falcon 9 Crew Dragon',  operator: 'SpaceX',   klass: 'LAUNCH',  lat: 28.6080, lng: -80.6040, radiusNm: 40, floorFt: 0,     ceilFt: 60000,  azimuth: 75,  corridorNm: 320, tMinusMin: 32,   windowMin: 25, notam: '!FDC 4/3211 KSC AHA 32MIN',  brief: 'Crew-7 Dragon Endeavour, ISS rendezvous; KSC AHA azimuth 075° downrange to NAS Bahamas' },
  { id: 'SLC40',   site: 'CCSFS SLC-40',           pad: 'SLC-40',country: 'USA', vehicle: 'Falcon 9 Starlink G6',  operator: 'SpaceX',   klass: 'LAUNCH',  lat: 28.5618, lng: -80.5772, radiusNm: 35, floorFt: 0,     ceilFt: 60000,  azimuth: 96,  corridorNm: 280, tMinusMin: 115,  windowMin: 60, notam: '!FDC 4/3214 KSC AHA WIN',    brief: 'Starlink Group 6-58, 22 sats; southeast corridor over Bahamas FIR coordinated MNTW' },
  { id: 'SLC41',   site: 'CCSFS SLC-41',           pad: 'SLC-41',country: 'USA', vehicle: 'Atlas-V Project Kuiper', operator: 'ULA',     klass: 'LAUNCH',  lat: 28.5830, lng: -80.5828, radiusNm: 32, floorFt: 0,     ceilFt: 55000,  azimuth: 47,  corridorNm: 260, tMinusMin: 220,  windowMin: 90, notam: '!FDC 4/3215 KSC AHA RES',    brief: 'Amazon Kuiper KA-02 batch; northeast corridor over NAT-D oceanic' },
  { id: 'SLC37',   site: 'CCSFS SLC-37',           pad: 'SLC-37',country: 'USA', vehicle: 'Delta IV-H NROL-70',    operator: 'ULA',      klass: 'LAUNCH',  lat: 28.5320, lng: -80.5660, radiusNm: 45, floorFt: 0,     ceilFt: 65000,  azimuth: 90,  corridorNm: 400, tMinusMin: -25,  windowMin: 45, notam: '!FDC 4/3216 KSC AHA ACT',    brief: 'NROL-70 classified ISR; AHA still active during post-launch debris-clearance window' },
  // VAFB
  { id: 'VAFB4E',  site: 'Vandenberg SLC-4E',      pad: 'SLC-4E',country: 'USA', vehicle: 'Falcon 9 Tranche-1',    operator: 'SpaceX',   klass: 'LAUNCH',  lat: 34.6320, lng: -120.6110, radiusNm: 38, floorFt: 0,     ceilFt: 60000, azimuth: 196, corridorNm: 300, tMinusMin: 18,   windowMin: 30, notam: '!FDC 4/3217 VBG AHA IMM',    brief: 'SDA Tranche-1 Transport Layer; polar southbound, ZLA / ZOA AHA azimuth 196°' },
  // Boca Chica
  { id: 'STARBASE',site: 'Starbase Boca Chica',    pad: 'OLP-A', country: 'USA', vehicle: 'Starship Super-Heavy IFT-6', operator: 'SpaceX', klass: 'LAUNCH', lat: 25.9970, lng: -97.1560, radiusNm: 75, floorFt: 0,    ceilFt: 75000, azimuth: 95,  corridorNm: 600, tMinusMin: 480,  windowMin: 120, notam: '!FDC 4/3218 BRO AHA RES',   brief: 'Starship IFT-6 full stack; massive AHA extends across Gulf into Indian-Ocean splashdown' },
  // Wallops
  { id: 'WAL0',    site: 'MARS Wallops LP-0',      pad: 'LP-0A', country: 'USA', vehicle: 'Antares 230+ NG-21',    operator: 'NG/RKT',   klass: 'LAUNCH',  lat: 37.8330, lng: -75.4880, radiusNm: 30, floorFt: 0,     ceilFt: 50000, azimuth: 105, corridorNm: 280, tMinusMin: 1440, windowMin: 60, notam: '!FDC 4/3219 WAL AHA SCH',    brief: 'Cygnus NG-21 ISS resupply; ZDC AHA southeast corridor coordinated NY-Center' },
  // Kodiak
  { id: 'KODIAK',  site: 'Kodiak PSCA LP-3',       pad: 'LP-3',  country: 'USA', vehicle: 'Astra Rocket 4',        operator: 'Astra',    klass: 'LAUNCH',  lat: 57.4350, lng: -152.3380, radiusNm: 28, floorFt: 0,    ceilFt: 48000, azimuth: 180, corridorNm: 250, tMinusMin: 720,  windowMin: 90, notam: '!FDC 4/3220 ENA AHA SCH',    brief: 'Astra Rocket-4 polar SSO; ZAN AHA southbound over GOA, coord Anchorage Center' },
  // Spaceport America
  { id: 'SAM-VG',  site: 'Spaceport America',      pad: 'GAA-RW',country: 'USA', vehicle: 'VSS Unity SS2',         operator: 'V-Galactic',klass: 'SUB-ORB',lat: 32.9900, lng: -106.9750, radiusNm: 22, floorFt: 0,    ceilFt: 280000,azimuth: 90,  corridorNm: 60,  tMinusMin: 60,   windowMin: 30, notam: '!FDC 4/3221 SAF AHA WIN',    brief: 'VSS Unity-25 commercial sub-orbital; Galactic-07 mission, vertical AHA to FL280k' },
  // Mojave
  { id: 'MOJAVE',  site: 'Mojave Air & Space Port',pad: 'RW30',  country: 'USA', vehicle: 'Stratolaunch TA-1',     operator: 'Stratolaunch',klass: 'SUB-ORB',lat: 35.0590, lng: -118.1520, radiusNm: 35, floorFt: 30000, ceilFt: 90000,azimuth: 180, corridorNm: 140, tMinusMin: 240,  windowMin: 90, notam: '!FDC 4/3222 MHV AHA SCH',    brief: 'Stratolaunch Roc TA-1 separation test, Talon-A vehicle; ZLA AHA over Pacific' },
  // Mahia
  { id: 'MAHIA1',  site: 'Rocket Lab LC-1A',       pad: 'LC-1A', country: 'NZL', vehicle: 'Electron Strix-7',      operator: 'Rocket Lab',klass: 'LAUNCH',  lat: -39.2620, lng: 177.8650, radiusNm: 30, floorFt: 0,    ceilFt: 55000, azimuth: 180, corridorNm: 280, tMinusMin: 200,  windowMin: 75, notam: 'NZ NOTAM A1234/24',          brief: 'Electron "Owl For One" SAR cluster; NZZC AHA southbound polar SSO' },
  // Kourou
  { id: 'ELA4',    site: 'Kourou ELA-4',           pad: 'ELA-4', country: 'FRA', vehicle: 'Ariane 6 VA263',        operator: 'Arianespace',klass: 'LAUNCH', lat: 5.2360, lng:  -52.7750, radiusNm: 45, floorFt: 0,    ceilFt: 65000, azimuth: 92,  corridorNm: 350, tMinusMin: -8,   windowMin: 45, notam: 'SOCC ALTRV F-2024-A6',       brief: 'Ariane-6 first commercial Galileo-FOC dual-stack; CAYENNE AHA active post-T0' },
  { id: 'ELS',     site: 'Kourou ELS',             pad: 'ELS',   country: 'FRA', vehicle: 'Vega-C VV24',           operator: 'Arianespace',klass: 'LAUNCH', lat: 5.2370, lng:  -52.7710, radiusNm: 32, floorFt: 0,    ceilFt: 55000, azimuth: 0,   corridorNm: 260, tMinusMin: 1800, windowMin: 60, notam: 'SOCC ALTRV F-2024-VC',       brief: 'Vega-C VV24 Sentinel-1C; CAYENNE AHA polar SSO northbound over Atlantic' },
  // Tanegashima
  { id: 'TNSC-Y',  site: 'Tanegashima Yoshinobu',  pad: 'LP1',   country: 'JPN', vehicle: 'H3-22S F4',             operator: 'MHI/JAXA', klass: 'LAUNCH',  lat: 30.4000, lng: 130.9690, radiusNm: 38, floorFt: 0,    ceilFt: 60000, azimuth: 96,  corridorNm: 300, tMinusMin: 360,  windowMin: 90, notam: 'JCAB AIP SUP 12/24',         brief: 'H3 F4 commercial GTO; RJJJ FIR AHA azimuth 096° over Philippine Sea' },
  // Baikonur
  { id: 'BAIK1S',  site: 'Baikonur 1/5',           pad: '1/5',   country: 'KAZ', vehicle: 'Soyuz-2.1a Progress',   operator: 'Roscosmos',klass: 'LAUNCH',  lat: 45.9650, lng:  63.3050, radiusNm: 40, floorFt: 0,    ceilFt: 60000, azimuth: 51,  corridorNm: 350, tMinusMin: 95,   windowMin: 30, notam: 'AIP RUS SUP 23/24',          brief: 'Progress MS-29 ISS cargo; UAAA → UUOO AHA azimuth 051° northeast' },
  // Plesetsk
  { id: 'PLES43',  site: 'Plesetsk 43/4',          pad: '43/4',  country: 'RUS', vehicle: 'Soyuz-2.1b GLONASS',    operator: 'VKS',      klass: 'LAUNCH',  lat: 62.9270, lng:  40.5740, radiusNm: 38, floorFt: 0,    ceilFt: 60000, azimuth: 6,   corridorNm: 320, tMinusMin: 600,  windowMin: 45, notam: 'AIP RUS NTM PLE-2024-11',    brief: 'GLONASS-K2 replenishment; ULLL AHA polar northbound, ATC re-route MFR ZHU' },
  // Vostochny
  { id: 'VOSTO',   site: 'Vostochny LP-1S',        pad: '1S',    country: 'RUS', vehicle: 'Angara-A5 IPM',         operator: 'Roscosmos',klass: 'LAUNCH',  lat: 51.8840, lng: 128.3370, radiusNm: 42, floorFt: 0,    ceilFt: 65000, azimuth: 84,  corridorNm: 380, tMinusMin: 2880, windowMin: 60, notam: 'AIP RUS SUP 24/24',          brief: 'Angara-A5 GTO test; UHHH AHA azimuth 084° over Sea-of-Okhotsk' },
  // Wenchang
  { id: 'WSLC2',   site: 'Wenchang LC-201',        pad: 'LC-201',country: 'CHN', vehicle: 'Long March 7A',         operator: 'CASC',     klass: 'LAUNCH',  lat: 19.6140, lng: 110.9510, radiusNm: 38, floorFt: 0,    ceilFt: 60000, azimuth: 105, corridorNm: 320, tMinusMin: 480,  windowMin: 120, notam: 'AIP CHN NTM SOUTH-1124',    brief: 'LM-7A TJSW-12 GEO transfer; ZJSA AHA azimuth 105° over Philippine Sea, ZGZU coord' },
  // Jiuquan
  { id: 'JSLC-921',site: 'Jiuquan LA-2 921',       pad: '921',   country: 'CHN', vehicle: 'Shenzhou 19 Crew',      operator: 'CMSEO',    klass: 'LAUNCH',  lat: 41.1180, lng: 100.4640, radiusNm: 45, floorFt: 0,    ceilFt: 65000, azimuth: 40,  corridorNm: 350, tMinusMin: 60,   windowMin: 15, notam: 'AIP CHN NTM NORTH-1119',     brief: 'Crew Shenzhou-19 to Tiangong CSS; ZLHW AHA azimuth 040° NE, ATC vector all UCC traffic' },
  // Taiyuan
  { id: 'TSLC',    site: 'Taiyuan LC-9',           pad: 'LC-9',  country: 'CHN', vehicle: 'Long March 4C',         operator: 'CASC',     klass: 'LAUNCH',  lat: 38.8490, lng: 111.6080, radiusNm: 32, floorFt: 0,    ceilFt: 55000, azimuth: 180, corridorNm: 280, tMinusMin: 1200, windowMin: 60, notam: 'AIP CHN NTM CENTRE-1112',    brief: 'Yaogan-39 LEO recon; ZBPE AHA polar southbound across S. China Sea' },
  // Sriharikota
  { id: 'SDSC2',   site: 'Sriharikota SLP',        pad: 'SLP',   country: 'IND', vehicle: 'GSLV Mk-III LVM3 M5',   operator: 'ISRO',     klass: 'LAUNCH',  lat: 13.7330, lng:  80.2350, radiusNm: 40, floorFt: 0,    ceilFt: 60000, azimuth: 105, corridorNm: 320, tMinusMin: 168,  windowMin: 30, notam: 'AIP IND ENR 5.3 SDSC',       brief: 'LVM3 Gaganyaan G1 uncrewed test; VOMM AHA azimuth 105° over Bay-of-Bengal' },
  // Reentry: ISS Crew Dragon Pacific splashdown
  { id: 'CDR-RTN', site: 'Crew Dragon Splashdown', pad: 'OFF-PNS',country: 'USA',vehicle: 'Crew-8 Dragon Endeavour', operator: 'SpaceX',  klass: 'REENTRY', lat: 30.4500, lng: -86.6500, radiusNm: 50, floorFt: 0,    ceilFt: 80000, azimuth: 270, corridorNm: 600, tMinusMin: 22,   windowMin: 40, notam: '!FDC 4/3225 ZHU REENTRY',    brief: 'Crew-8 reentry, splashdown off Pensacola; ZHU AHA 50NM circle + 600NM upstream corridor' },
  // X-37B reentry
  { id: 'X37-RTN', site: 'X-37B OTV-7 Reentry',    pad: 'SLF-15',country: 'USA', vehicle: 'X-37B OTV-7',           operator: 'USSF',     klass: 'REENTRY', lat: 28.6150, lng:  -80.6940, radiusNm: 45, floorFt: 0,    ceilFt: 90000, azimuth: 100, corridorNm: 700, tMinusMin: 75,   windowMin: 60, notam: '!FDC 4/3226 ZJX REENTRY',    brief: 'X-37B OTV-7 deorbit, KSC SLF-15 runway landing; ZJX AHA upstream Caribbean corridor' },
]

function clamp(v: number, mn: number, mx: number) { return Math.max(mn, Math.min(mx, v)) }
function gcNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 3440.065
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dφ = (la2 - la1) * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dλ = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}
function ringPolygon(lat: number, lng: number, rNm: number, steps = 48): number[][] {
  const latPerNm = 1 / 60
  const lngPerNm = 1 / (60 * Math.cos(lat * Math.PI / 180))
  const out: number[][] = []
  for (let i = 0; i <= steps; i++) {
    const θ = (i / steps) * 2 * Math.PI
    out.push([lng + Math.sin(θ) * rNm * lngPerNm, lat + Math.cos(θ) * rNm * latPerNm])
  }
  return out
}
function corridorPolygon(lat: number, lng: number, rNm: number, lenNm: number, azDeg: number): number[][] {
  // simple half-circle + rectangle pointing along azimuth
  const az = azDeg * Math.PI / 180
  const latPerNm = 1 / 60
  const lngPerNm = 1 / (60 * Math.cos(lat * Math.PI / 180))
  const tipLat = lat + Math.cos(az) * lenNm * latPerNm
  const tipLng = lng + Math.sin(az) * lenNm * lngPerNm
  // perpendicular offsets at base & tip
  const perp = az + Math.PI / 2
  const offLatB = Math.cos(perp) * rNm * latPerNm
  const offLngB = Math.sin(perp) * rNm * lngPerNm
  return [
    [lng + offLngB, lat + offLatB],
    [tipLng + offLngB, tipLat + offLatB],
    [tipLng - offLngB, tipLat - offLatB],
    [lng - offLngB, lat - offLatB],
    [lng + offLngB, lat + offLatB],
  ]
}

interface Eval {
  f: SFlight; aha: Aha
  distNm: number; ttiSec: number; closing: boolean
  insideAha: boolean
  state: State
  drivers: { IAH: number; PRX: number; TTI: number; WND: number; ALT: number; CLS: number }
  tier: Tier; score: number; advice: string
}

function ahaState(a: Aha): State {
  const tAbs = Math.abs(a.tMinusMin)
  if (tAbs <= a.windowMin / 2) return 'ACTIVE'
  if (a.tMinusMin > 0 && a.tMinusMin <= 30) return 'IMMINENT'
  if (a.tMinusMin > 0 && a.tMinusMin <= 24 * 60) return 'SCHEDULED'
  return 'STANDBY'
}

const SRC_AHA  = 'lrah-aha',  LYR_AHA  = 'lrah-aha-fill'
const SRC_AHAB = 'lrah-ahab', LYR_AHAB = 'lrah-ahab-line'
const SRC_COR  = 'lrah-cor',  LYR_COR  = 'lrah-cor-fill'
const SRC_PAD  = 'lrah-pad',  LYR_PAD  = 'lrah-pad'
const SRC_PADL = 'lrah-padl', LYR_PADL = 'lrah-padl'
const SRC_HALO = 'lrah-halo', LYR_HALO = 'lrah-halo'
const SRC_PIN  = 'lrah-pin',  LYR_PIN  = 'lrah-pin'
const SRC_LBL  = 'lrah-lbl',  LYR_LBL  = 'lrah-lbl'
const SRC_LINK = 'lrah-link', LYR_LINK = 'lrah-link'
const SRC_TRAJ = 'lrah-traj', LYR_TRAJ = 'lrah-traj'

const lsGet = (k: string, d: any) => { if (typeof window === 'undefined') return d; try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }
const lsSet = (k: string, v: any) => { if (typeof window === 'undefined') return; try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

export default function LrahMonitor({ map, flights, onClose, onFly }: Props) {
  const [scopeNm, setScopeNm]   = useState<number>(() => lsGet('ft-lrah-scope', 300))
  const [horizonMin, setHorizon] = useState<number>(() => lsGet('ft-lrah-hzn', 60))
  const [radMul, setRadMul]     = useState<number>(() => lsGet('ft-lrah-rmul', 100))
  const [corMul, setCorMul]     = useState<number>(() => lsGet('ft-lrah-cmul', 100))
  const [advMul, setAdvMul]     = useState<number>(() => lsGet('ft-lrah-adv', 100))
  const [minFl, setMinFl]       = useState<number>(() => lsGet('ft-lrah-mnfl', 0))
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [stateFilter, setStateFilter] = useState<State | 'ALL'>('ALL')
  const [tierFilter, setTierFilter]   = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'AHA' | 'SITES'>('AIRCRAFT')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin]   = useState(true)
  const [showLbl, setShowLbl]   = useState(true)
  const [showAha, setShowAha]   = useState(true)
  const [showCor, setShowCor]   = useState(true)
  const [showPad, setShowPad]   = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showTraj, setShowTraj] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    lsSet('ft-lrah-scope', scopeNm); lsSet('ft-lrah-hzn', horizonMin)
    lsSet('ft-lrah-rmul', radMul); lsSet('ft-lrah-cmul', corMul)
    lsSet('ft-lrah-adv', advMul); lsSet('ft-lrah-mnfl', minFl)
  }, [scopeNm, horizonMin, radMul, corMul, advMul, minFl])

  const evals = useMemo(() => {
    const out: Eval[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (f.altitudeFt < minFl * 100) continue
      let best: { aha: Aha; distNm: number; ttiSec: number; closing: boolean; insideAha: boolean } | null = null
      for (const a of AHAS) {
        const d = gcNm(f.lat, f.lng, a.lat, a.lng)
        if (d > scopeNm) continue
        const effR = a.radiusNm * (radMul / 100)
        // along-track / down-range geometry: aircraft is inside if within circle OR inside corridor
        const brgToPad = bearingDeg(a.lat, a.lng, f.lat, f.lng)
        const corBrgDelta = Math.abs(((brgToPad - a.azimuth + 540) % 360) - 180)
        const downRangeNm = d * Math.cos(corBrgDelta * Math.PI / 180)
        const crossRangeNm = Math.abs(d * Math.sin(corBrgDelta * Math.PI / 180))
        const corLen = a.corridorNm * (corMul / 100)
        const insideCircle = d < effR
        const insideCor = downRangeNm > 0 && downRangeNm < corLen && crossRangeNm < effR
        const insideAha = insideCircle || insideCor
        // track to nearest point
        const brgFromAcToPad = bearingDeg(f.lat, f.lng, a.lat, a.lng)
        const angleOff = Math.abs(((f.track - brgFromAcToPad + 540) % 360) - 180)
        const closing = angleOff < 90 && f.velocityKts > 1
        const gsNmPerSec = f.velocityKts / 3600
        const distToBound = Math.max(0, d - effR)
        const tti = closing && gsNmPerSec > 0 ? distToBound / gsNmPerSec : 99999
        if (!best || d < best.distNm) best = { aha: a, distNm: d, ttiSec: tti, closing, insideAha }
      }
      if (!best) continue
      const a = best.aha
      const state = ahaState(a)
      // altitude band overlap
      const ahaOverlap = f.altitudeFt >= a.floorFt && f.altitudeFt <= a.ceilFt
      const effR = a.radiusNm * (radMul / 100)
      const IAH = best.insideAha && ahaOverlap ? 100 : 0
      const PRX = best.insideAha ? 100 : clamp(100 - ((best.distNm - effR) / Math.max(1, effR)) * 100, 0, 100)
      const TTI = best.closing && best.ttiSec < horizonMin * 60 ? clamp(100 - (best.ttiSec / (horizonMin * 60)) * 100, 0, 100) : 0
      const tAbs = Math.abs(a.tMinusMin)
      const WND = state === 'ACTIVE' ? 100 : state === 'IMMINENT' ? clamp(100 - (tAbs / 30) * 50, 50, 100) : state === 'SCHEDULED' ? clamp(50 - (tAbs / (24 * 60)) * 50, 0, 50) : 0
      const ALT = ahaOverlap ? 100 : clamp(100 - Math.min(Math.abs(f.altitudeFt - a.floorFt), Math.abs(f.altitudeFt - a.ceilFt)) / 200, 0, 100)
      const CLS = KLASS_WT[a.klass]
      const drivers = { IAH, PRX, TTI, WND, ALT, CLS }
      const arr = [IAH, PRX, TTI, WND, ALT, CLS].sort((a, b) => b - a)
      let composite = arr[0] * 0.46 + arr[1] * 0.24 + arr[2] * 0.14 + arr[3] * 0.09 + arr[4] * 0.04 + arr[5] * 0.03
      composite *= (advMul / 100)
      composite = clamp(composite, 0, 100)

      let tier: Tier, advice: string
      if (best.insideAha && ahaOverlap && state === 'ACTIVE') {
        tier = 'BREACH-ACT'; composite = Math.max(composite, 96)
        advice = `INSIDE active ${a.klass} AHA ${a.id} (${a.site}) — vacate immediately via vector away from azimuth ${a.azimuth}°; cite ${a.notam} / FAA JO 7110.65 §9-4`
      } else if (best.insideAha && ahaOverlap && (state === 'IMMINENT' || state === 'SCHEDULED')) {
        tier = 'BREACH-IMM'; composite = Math.max(composite, 86)
        advice = `Inside ${a.klass} AHA ${a.id} pre-window T${a.tMinusMin > 0 ? '-' : '+'}${Math.abs(a.tMinusMin).toFixed(0)}min — request immediate re-route; FAA AC 91-63D TFR pending`
      } else if (state === 'ACTIVE' && best.closing && best.ttiSec < horizonMin * 60 * 0.5) {
        tier = 'PRE-ACT'; composite = Math.max(composite, 72)
        advice = `Closing on active AHA ${a.id} (${a.vehicle}); TTI ${(best.ttiSec / 60).toFixed(1)}min — vector around, file revised SID per JO 7210.3 §18-9`
      } else if (composite >= 35 || state === 'IMMINENT') {
        tier = 'WATCH'
        advice = `Approaching ${a.klass} AHA ${a.id} (${a.vehicle}) at ${a.site}; T${a.tMinusMin > 0 ? '-' : '+'}${Math.abs(a.tMinusMin).toFixed(0)}min — brief crew, monitor SDI per FAA SDI ConOps v2.0`
      } else if (state === 'SCHEDULED' || state === 'STANDBY') {
        tier = 'INFO'
        advice = `Scheduled AHA ${a.id} (${a.vehicle}) at ${a.site} T${a.tMinusMin > 0 ? '-' : '+'}${Math.abs(a.tMinusMin).toFixed(0)}min; ${best.distNm.toFixed(0)}NM distant — plan around per ICAO Annex 11 §2.20`
      } else {
        tier = 'CLEAR'; advice = `Clear of AHA volume; nominal per Part 450 §450.101`
      }
      out.push({ f, aha: a, distNm: best.distNm, ttiSec: best.ttiSec, closing: best.closing, insideAha: best.insideAha, state, drivers, tier, score: composite, advice })
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, scopeNm, horizonMin, radMul, corMul, advMul, minFl])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return evals.filter(e => {
      if (klassFilter !== 'ALL' && e.aha.klass !== klassFilter) return false
      if (stateFilter !== 'ALL' && e.state !== stateFilter) return false
      if (tierFilter !== 'ALL' && e.tier !== tierFilter) return false
      if (q) {
        const blob = `${e.f.callsign} ${e.f.icao} ${e.f.type} ${e.aha.id} ${e.aha.site} ${e.aha.vehicle} ${e.aha.operator}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [evals, klassFilter, stateFilter, tierFilter, query])

  const tierCount: Record<Tier, number> = { 'BREACH-ACT': 0, 'BREACH-IMM': 0, 'PRE-ACT': 0, WATCH: 0, INFO: 0, CLEAR: 0 }
  for (const e of evals) tierCount[e.tier]++
  const meanScore = evals.length ? evals.reduce((s, e) => s + e.score, 0) / evals.length : 0
  const worst = evals[0]
  const breachActN = evals.filter(e => e.tier === 'BREACH-ACT').length
  const breachImmN = evals.filter(e => e.tier === 'BREACH-IMM').length
  const preActN = evals.filter(e => e.tier === 'PRE-ACT').length
  const activeAhaN = AHAS.filter(a => ahaState(a) === 'ACTIVE').length
  const imminentAhaN = AHAS.filter(a => ahaState(a) === 'IMMINENT').length

  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any)
    }
    ensure(LYR_AHA,  'fill',   SRC_AHA,  { 'fill-color': ['get', 'color'], 'fill-opacity': 0.14 })
    ensure(LYR_AHAB, 'line',   SRC_AHAB, { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.85, 'line-dasharray': [3, 2] })
    ensure(LYR_COR,  'fill',   SRC_COR,  { 'fill-color': ['get', 'color'], 'fill-opacity': 0.08 })
    ensure(LYR_PAD,  'circle', SRC_PAD,  { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 4, 8, 7, 12, 11], 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-stroke-color': '#fff' })
    ensure(LYR_PADL, 'symbol', SRC_PADL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN,  'circle', SRC_PIN,  { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_LBL,  'symbol', SRC_LBL,  {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    ensure(LYR_LINK, 'line',   SRC_LINK, { 'line-color': ['get', 'color'], 'line-width': 1.3, 'line-opacity': 0.8, 'line-dasharray': [2, 2] })
    ensure(LYR_TRAJ, 'line',   SRC_TRAJ, { 'line-color': ['get', 'color'], 'line-width': 1.1, 'line-opacity': 0.55, 'line-dasharray': [1, 2] })
    if (map.getLayer(LYR_LBL))  { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }
    if (map.getLayer(LYR_PADL)) { map.setPaintProperty(LYR_PADL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_PADL, 'text-halo-color', '#020617'); map.setPaintProperty(LYR_PADL, 'text-halo-width', 1.4) }

    const ahaFeats: any[] = [], ahabFeats: any[] = [], corFeats: any[] = [], padFeats: any[] = [], padlFeats: any[] = []
    for (const a of AHAS) {
      if (klassFilter !== 'ALL' && a.klass !== klassFilter) continue
      const st = ahaState(a)
      if (stateFilter !== 'ALL' && st !== stateFilter) continue
      const color = STATE_COLOR[st]
      const effR = a.radiusNm * (radMul / 100)
      const corLen = a.corridorNm * (corMul / 100)
      if (showAha) {
        ahaFeats.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ringPolygon(a.lat, a.lng, effR)] }, properties: { color } })
        ahabFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: ringPolygon(a.lat, a.lng, effR) }, properties: { color } })
      }
      if (showCor) {
        corFeats.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [corridorPolygon(a.lat, a.lng, effR, corLen, a.azimuth)] }, properties: { color: KLASS_COLOR[a.klass] } })
      }
      if (showPad) {
        padFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng, a.lat] }, properties: { color: KLASS_COLOR[a.klass] } })
        padlFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng, a.lat] }, properties: { color, label: `${a.id}·${a.klass}·T${a.tMinusMin > 0 ? '-' : '+'}${Math.abs(a.tMinusMin).toFixed(0)}m` } })
      }
    }

    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = [], traj: any[] = []
    for (const e of filtered) {
      const color = TIER_COLOR[e.tier]
      if (showHalo && e.tier !== 'CLEAR' && e.tier !== 'INFO') halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, r: 8 + e.score * 0.14 } })
      if (showPin && (e.tier === 'BREACH-ACT' || e.tier === 'BREACH-IMM' || e.tier === 'PRE-ACT')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color } })
      if (showLbl && e.tier !== 'CLEAR' && e.tier !== 'INFO') {
        const tag = e.closing && e.ttiSec < 99999 ? `${e.distNm.toFixed(0)}NM/${(e.ttiSec / 60).toFixed(1)}m` : `${e.distNm.toFixed(0)}NM`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, label: `${e.f.callsign || e.f.icao} › ${e.aha.id} · ${tag} · ${e.tier}` } })
      }
      if (showLink && e.tier !== 'CLEAR' && e.tier !== 'INFO') {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[e.f.lng, e.f.lat], [e.aha.lng, e.aha.lat]] }, properties: { color } })
      }
      if (showTraj && e.closing) {
        const trk = e.f.track * Math.PI / 180
        const horizonNm = (e.f.velocityKts * horizonMin) / 60
        const latPerNm = 1 / 60
        const lngPerNm = 1 / (60 * Math.cos(e.f.lat * Math.PI / 180))
        const endLat = e.f.lat + Math.cos(trk) * horizonNm * latPerNm
        const endLng = e.f.lng + Math.sin(trk) * horizonNm * lngPerNm
        traj.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[e.f.lng, e.f.lat], [endLng, endLat]] }, properties: { color } })
      }
    }
    ;(map.getSource(SRC_AHA)  as any).setData({ type: 'FeatureCollection', features: ahaFeats })
    ;(map.getSource(SRC_AHAB) as any).setData({ type: 'FeatureCollection', features: ahabFeats })
    ;(map.getSource(SRC_COR)  as any).setData({ type: 'FeatureCollection', features: corFeats })
    ;(map.getSource(SRC_PAD)  as any).setData({ type: 'FeatureCollection', features: padFeats })
    ;(map.getSource(SRC_PADL) as any).setData({ type: 'FeatureCollection', features: padlFeats })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN)  as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL)  as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_TRAJ) as any).setData({ type: 'FeatureCollection', features: traj })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_TRAJ, LYR_PADL, LYR_PAD, LYR_AHAB, LYR_AHA, LYR_COR]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_LINK, SRC_TRAJ, SRC_PADL, SRC_PAD, SRC_AHAB, SRC_AHA, SRC_COR]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, evals, showHalo, showPin, showLbl, showAha, showCor, showPad, showLink, showTraj, klassFilter, stateFilter, horizonMin, radMul, corMul])

  const tierBadge = (t: Tier) => <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  const klassBadge = (k: Klass) => <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: KLASS_COLOR[k], backgroundColor: KLASS_COLOR[k] + '1f', border: `1px solid ${KLASS_COLOR[k]}55` }}>{k}</span>
  const stateBadge = (s: State) => <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: STATE_COLOR[s], backgroundColor: STATE_COLOR[s] + '1f', border: `1px solid ${STATE_COLOR[s]}55` }}>{s}</span>
  const drvBadge = (k: string, v: number) => {
    const c = v >= 70 ? '#ef4444' : v >= 40 ? '#f59e0b' : v >= 18 ? '#0ea5e9' : '#10b981'
    return <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: c, backgroundColor: c + '1c', border: `1px solid ${c}55` }}>{k}{v.toFixed(0)}</span>
  }

  /* Scatter: distance-NM (x 0-scope) vs T-minus-min (y -60..+300) */
  const W = 280, H = 110, padL = 28, padB = 16, padT = 6, padR = 6
  const xMin = 0, xMax = scopeNm
  const yMin = -60, yMax = horizonMin > 180 ? horizonMin : 240
  const sx = (v: number) => padL + ((clamp(v, xMin, xMax) - xMin) / (xMax - xMin || 1)) * (W - padL - padR)
  const sy = (v: number) => padT + (1 - (clamp(v, yMin, yMax) - yMin) / (yMax - yMin || 1)) * (H - padT - padB)

  const sites = useMemo(() => {
    const m: Record<string, { country: string; ahas: Aha[]; ac: number; mean: number; worstTier: Tier }> = {}
    for (const a of AHAS) {
      if (!m[a.country]) m[a.country] = { country: a.country, ahas: [], ac: 0, mean: 0, worstTier: 'CLEAR' }
      m[a.country].ahas.push(a)
    }
    for (const e of evals) {
      const s = m[e.aha.country]; if (!s) continue
      s.ac++; s.mean += e.score
      if (TIER_RANK[e.tier] < TIER_RANK[s.worstTier]) s.worstTier = e.tier
    }
    return Object.values(m).map(s => ({ ...s, mean: s.ac ? s.mean / s.ac : 0 })).sort((a, b) => TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier] || b.ac - a.ac)
  }, [evals])

  const ahaAgg = useMemo(() => {
    const m: Record<string, { aha: Aha; ac: number; mean: number; breach: number; pre: number; watch: number }> = {}
    for (const a of AHAS) m[a.id] = { aha: a, ac: 0, mean: 0, breach: 0, pre: 0, watch: 0 }
    for (const e of evals) {
      const a = m[e.aha.id]; if (!a) continue
      a.ac++; a.mean += e.score
      if (e.tier === 'BREACH-ACT' || e.tier === 'BREACH-IMM') a.breach++
      if (e.tier === 'PRE-ACT') a.pre++
      if (e.tier === 'WATCH') a.watch++
    }
    return Object.values(m).map(a => ({ ...a, mean: a.ac ? a.mean / a.ac : 0, state: ahaState(a.aha) }))
      .sort((a, b) => {
        const sa = a.state === 'ACTIVE' ? 0 : a.state === 'IMMINENT' ? 1 : a.state === 'SCHEDULED' ? 2 : 3
        const sb = b.state === 'ACTIVE' ? 0 : b.state === 'IMMINENT' ? 1 : b.state === 'SCHEDULED' ? 2 : 3
        return sa - sb || b.breach - a.breach || b.ac - a.ac
      })
  }, [evals])

  return (
    <div className="absolute right-3 top-20 z-40 w-[27rem] max-h-[calc(100vh-6rem)] flex flex-col bg-slate-900/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-sky-500 animate-pulse" />
          <span className="text-[10px] font-bold tracking-widest uppercase text-sky-400">LRAH · Launch &amp; Reentry AHA Monitor</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm leading-none">×</button>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[7px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean score</div><div className="text-sm font-semibold" style={{ color: meanScore >= 65 ? '#ef4444' : meanScore >= 35 ? '#f59e0b' : '#10b981' }}>{meanScore.toFixed(0)}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Worst</div><div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Breach-act</div><div className="text-sm font-semibold" style={{ color: breachActN > 0 ? '#ef4444' : '#10b981' }}>{breachActN}</div></div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Breach-imm</div><div className="text-xs font-semibold" style={{ color: breachImmN > 0 ? '#f43f5e' : '#10b981' }}>{breachImmN}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Pre-act / Active AHA</div><div className="text-xs font-semibold" style={{ color: preActN > 0 ? '#f43f5e' : '#10b981' }}>{preActN} <span className="text-slate-500">/</span> <span style={{ color: activeAhaN > 0 ? '#ef4444' : '#94a3b8' }}>{activeAhaN}</span></div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Imminent AHA</div><div className="text-xs font-semibold" style={{ color: imminentAhaN > 0 ? '#f43f5e' : '#94a3b8' }}>{imminentAhaN}</div></div>
      </div>

      {showDiag && evals.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* breach quadrant: dist<radius, T<30 */}
            <rect x={sx(0)} y={sy(30)} width={sx(50) - sx(0)} height={sy(-60) - sy(30)} fill="#ef444415" />
            {/* clear band */}
            <rect x={sx(scopeNm * 0.5)} y={padT} width={W - padR - sx(scopeNm * 0.5)} height={H - padT - padB} fill="#10b98112" />
            <line x1={sx(50)} y1={padT} x2={sx(50)} y2={H - padB} stroke="#ef444466" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={padL} y1={sy(0)} x2={W - padR} y2={sy(0)} stroke="#f43f5e66" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={padL} y1={sy(30)} x2={W - padR} y2={sy(30)} stroke="#f59e0b66" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={padL} y={H - 3} fill="#475569" fontSize="8">dist→NM</text>
            <text x={W - 30} y={padT + 7} fill="#475569" fontSize="8">T↑min</text>
            {evals.map((e, i) => (
              <circle key={i} cx={sx(e.distNm)} cy={sy(e.aha.tMinusMin)} r={2} fill={TIER_COLOR[e.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          <label className="text-[9px] text-slate-400">Scope {scopeNm}NM<input type="range" min={50} max={800} step={10} value={scopeNm} onChange={e => setScopeNm(+e.target.value)} className="w-full accent-sky-500" /></label>
          <label className="text-[9px] text-slate-400">Horizon {horizonMin}min<input type="range" min={10} max={360} step={5} value={horizonMin} onChange={e => setHorizon(+e.target.value)} className="w-full accent-sky-500" /></label>
          <label className="text-[9px] text-slate-400">AHA-radius ×{radMul}%<input type="range" min={50} max={200} value={radMul} onChange={e => setRadMul(+e.target.value)} className="w-full accent-sky-500" /></label>
          <label className="text-[9px] text-slate-400">Corridor ×{corMul}%<input type="range" min={50} max={200} value={corMul} onChange={e => setCorMul(+e.target.value)} className="w-full accent-sky-500" /></label>
          <label className="text-[9px] text-slate-400">Advisory ×{advMul}%<input type="range" min={50} max={200} value={advMul} onChange={e => setAdvMul(+e.target.value)} className="w-full accent-sky-500" /></label>
          <label className="text-[9px] text-slate-400">Min-FL {minFl}<input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(+e.target.value)} className="w-full accent-sky-500" /></label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','LAUNCH','REENTRY','SUB-ORB'] as const).map(k => (
            <button key={k} onClick={() => setKlassFilter(k === 'ALL' ? 'ALL' : k as Klass)} className="px-1.5 py-0.5 rounded text-[9px] font-mono" style={{ color: k === 'ALL' ? '#cbd5e1' : KLASS_COLOR[k as Klass], backgroundColor: klassFilter === (k === 'ALL' ? 'ALL' : k as Klass) ? (k === 'ALL' ? '#33415555' : KLASS_COLOR[k as Klass] + '33') : '#0b1220', border: '1px solid ' + (klassFilter === (k === 'ALL' ? 'ALL' : k as Klass) ? (k === 'ALL' ? '#64748b' : KLASS_COLOR[k as Klass]) : '#1e293b') }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','ACTIVE','IMMINENT','SCHEDULED','STANDBY'] as const).map(s => (
            <button key={s} onClick={() => setStateFilter(s === 'ALL' ? 'ALL' : s as State)} className="px-1.5 py-0.5 rounded text-[9px] font-mono" style={{ color: s === 'ALL' ? '#cbd5e1' : STATE_COLOR[s as State], backgroundColor: stateFilter === (s === 'ALL' ? 'ALL' : s as State) ? (s === 'ALL' ? '#33415555' : STATE_COLOR[s as State] + '33') : '#0b1220', border: '1px solid ' + (stateFilter === (s === 'ALL' ? 'ALL' : s as State) ? (s === 'ALL' ? '#64748b' : STATE_COLOR[s as State]) : '#1e293b') }}>{s}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {[['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['AHA',showAha,setShowAha],['COR',showCor,setShowCor],['PAD',showPad,setShowPad],['LINK',showLink,setShowLink],['TRAJ',showTraj,setShowTraj],['DIAG',showDiag,setShowDiag]].map(([k,v,fn]:any) => (
            <button key={k} onClick={() => fn((x:boolean)=>!x)} className="px-1.5 py-0.5 rounded text-[9px] font-mono" style={{ color: v ? '#7dd3fc' : '#64748b', backgroundColor: v ? '#0ea5e91f' : '#0b1220', border: '1px solid ' + (v ? '#0ea5e966' : '#1e293b') }}>{k}</button>
          ))}
        </div>
        <input type="text" placeholder="Search callsign / type / pad / vehicle…" value={query} onChange={e => setQuery(e.target.value)} className="w-full px-2 py-1 bg-slate-950 border border-slate-800 rounded text-[10px] text-slate-200 placeholder:text-slate-600" />
        <div className="flex gap-1">
          {(['AIRCRAFT','AHA','SITES'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} className="flex-1 px-2 py-1 rounded text-[10px] font-semibold" style={{ color: tab === t ? '#0ea5e9' : '#94a3b8', backgroundColor: tab === t ? '#0ea5e924' : '#0b1220', border: '1px solid ' + (tab === t ? '#0ea5e966' : '#1e293b') }}>{t}</button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-slate-500">No traffic in launch / reentry AHA scope.</div>}
            {filtered.map((e, i) => (
              <button key={e.f.icao + '/' + e.aha.id + '/' + i} onClick={() => onFly(e.f.icao)} className="w-full text-left px-3 py-2 hover:bg-slate-800/30 transition" style={{ borderLeft: '3px solid ' + TIER_COLOR[e.tier] }}>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-mono text-[11px] font-semibold text-slate-100 truncate">{e.f.callsign || e.f.icao}</span>
                    <span className="text-[9px] text-slate-500 font-mono truncate">{e.f.type || '—'}</span>
                    {klassBadge(e.aha.klass)} {stateBadge(e.state)} {tierBadge(e.tier)}
                  </div>
                </div>
                <div className="text-[10px] text-slate-400 font-mono flex flex-wrap gap-x-2 gap-y-0.5">
                  <span className="text-sky-300">{e.aha.id}</span>
                  <span className="text-slate-500 italic truncate max-w-[12rem]">{e.aha.site}</span>
                  <span style={{ color: e.distNm < e.aha.radiusNm ? '#f43f5e' : e.distNm < e.aha.radiusNm * 2 ? '#f59e0b' : '#10b981' }}>{e.distNm.toFixed(0)}NM</span>
                  {e.closing && e.ttiSec < 99999 ? <span style={{ color: e.ttiSec < 600 ? '#f43f5e' : e.ttiSec < 1800 ? '#f59e0b' : '#10b981' }}>TTI {(e.ttiSec / 60).toFixed(1)}m</span> : <span className="text-slate-500">stable</span>}
                  <span className="text-slate-500">FL{(e.f.altitudeFt / 100).toFixed(0)}</span>
                  <span className="text-slate-500">{e.f.velocityKts.toFixed(0)}kt</span>
                  <span style={{ color: e.aha.tMinusMin > 0 ? '#f59e0b' : '#ef4444' }}>T{e.aha.tMinusMin > 0 ? '-' : '+'}{Math.abs(e.aha.tMinusMin).toFixed(0)}m</span>
                </div>
                <div className="text-[10px] text-slate-500 font-mono truncate mt-0.5">{e.aha.vehicle} · {e.aha.operator}</div>
                <div className="mt-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                  <div style={{ width: e.score + '%', backgroundColor: TIER_COLOR[e.tier] }} className="h-full" />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {drvBadge('IAH', e.drivers.IAH)} {drvBadge('PRX', e.drivers.PRX)} {drvBadge('TTI', e.drivers.TTI)} {drvBadge('WND', e.drivers.WND)} {drvBadge('ALT', e.drivers.ALT)} {drvBadge('CLS', e.drivers.CLS)}
                </div>
                <div className="mt-1 text-[10px]" style={{ color: TIER_COLOR[e.tier] }}>{e.advice}</div>
              </button>
            ))}
          </div>
        )}
        {tab === 'AHA' && (
          <div className="divide-y divide-slate-800/60">
            {ahaAgg.map(a => (
              <div key={a.aha.id} className="px-3 py-2" style={{ borderLeft: '3px solid ' + STATE_COLOR[a.state] }}>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="font-mono text-[11px] text-sky-300">{a.aha.id}</span>
                  {klassBadge(a.aha.klass)} {stateBadge(a.state)}
                  <span className="text-[9px] text-slate-500 italic truncate">{a.aha.site}</span>
                </div>
                <div className="text-[10px] text-slate-400 font-mono mb-1 line-clamp-2">{a.aha.vehicle} · {a.aha.operator}</div>
                <div className="text-[10px] text-slate-500 font-mono mb-1 line-clamp-2">{a.aha.brief}</div>
                <div className="flex flex-wrap gap-2 text-[10px] text-slate-400 font-mono">
                  <span>R{a.aha.radiusNm}NM</span>
                  <span>az{a.aha.azimuth}°</span>
                  <span>cor {a.aha.corridorNm}NM</span>
                  <span>FL{(a.aha.floorFt / 100).toFixed(0)}-{(a.aha.ceilFt / 100).toFixed(0)}</span>
                  <span style={{ color: a.aha.tMinusMin > 0 ? '#f59e0b' : '#ef4444' }}>T{a.aha.tMinusMin > 0 ? '-' : '+'}{Math.abs(a.aha.tMinusMin).toFixed(0)}m</span>
                  <span>win ±{(a.aha.windowMin / 2).toFixed(0)}m</span>
                  <span>ac {a.ac}</span>
                  {a.breach > 0 && <span className="text-rose-400">BRCH {a.breach}</span>}
                  {a.pre > 0 && <span className="text-rose-300">PRE {a.pre}</span>}
                  {a.watch > 0 && <span className="text-amber-400">WTCH {a.watch}</span>}
                </div>
                <div className="text-[9px] text-slate-500 font-mono mt-0.5 truncate">{a.aha.notam}</div>
                <div className="mt-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                  <div style={{ width: a.mean + '%', backgroundColor: a.mean >= 65 ? '#ef4444' : a.mean >= 35 ? '#f59e0b' : a.mean >= 18 ? '#0ea5e9' : '#10b981' }} className="h-full" />
                </div>
              </div>
            ))}
          </div>
        )}
        {tab === 'SITES' && (
          <div className="divide-y divide-slate-800/60">
            {sites.map(s => (
              <div key={s.country} className="px-3 py-2" style={{ borderLeft: '3px solid ' + TIER_COLOR[s.worstTier] }}>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="font-mono text-[11px] text-sky-300">{s.country}</span>
                  {tierBadge(s.worstTier)}
                  <span className="text-[10px] text-slate-300 italic truncate">{s.ahas.length} AHA volumes</span>
                </div>
                <div className="flex flex-wrap gap-1 mb-1">
                  {s.ahas.slice(0, 6).map(a => (
                    <span key={a.id} className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: STATE_COLOR[ahaState(a)], backgroundColor: STATE_COLOR[ahaState(a)] + '1c', border: `1px solid ${STATE_COLOR[ahaState(a)]}55` }}>{a.id}</span>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 text-[10px] text-slate-400 font-mono">
                  <span>ac {s.ac}</span>
                  <span>active {s.ahas.filter(a => ahaState(a) === 'ACTIVE').length}</span>
                  <span>imm {s.ahas.filter(a => ahaState(a) === 'IMMINENT').length}</span>
                  <span>sched {s.ahas.filter(a => ahaState(a) === 'SCHEDULED').length}</span>
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                  <div style={{ width: s.mean + '%', backgroundColor: s.mean >= 65 ? '#ef4444' : s.mean >= 35 ? '#f59e0b' : s.mean >= 18 ? '#0ea5e9' : '#10b981' }} className="h-full" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
