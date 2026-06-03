'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Pavement Classification Number (PCN / ACR-PCR) Bearing-Strength
   Compliance Monitor
   -----------------------------------------------------------
   ICAO Annex 14 Vol I 2.6 Pavement Strength reporting /
   ICAO Doc 9157 Aerodrome Design Manual Pt 3 Pavements (4th ed) /
   ACR-PCR replacing ACN-PCN system effective 28 Nov 2024 per
   Annex 14 Amendment 13-B / FAA AC 150/5335-5C Standardized
   Method of Reporting Airport Pavement Strength PCN /
   FAA EB 109 ACR-PCR Implementation 2022 / FAA Order 5300.7
   Standard Naming Convention for Aeronautical Surface Types /
   EASA CS-ADR-DSN.D.270 Pavement strength / Boeing 777 ACN
   tables (FCOM Performance) / Boeing 787 ACN/ACR tables /
   Airbus A380 Airplane Characteristics for Airport Planning
   sec 7 / FAA Advisory PAV-OVRLD Overload Operations 5pct/year
   rule per ICAO Doc 9157 Pt 3 6.3 (10pct factor allowance) /
   FAA AC 150/5320-6G Airport Pavement Design and Evaluation.
   
   Watch for every airborne aircraft on approach (phase APPR
   or DESC below FL120 within CAPTURE 10-200nm slider of one of
   48 catalogued destination airports across 4 pavement
   regimes RGD-HI (rigid concrete PCN>=90 highway-class hubs)
   RGD-MD (rigid PCN 55-89 international midsize) FLX-HI
   (flexible asphalt PCN>=70 narrowbody hubs) FLX-MD (flexible
   PCN 35-69 regional). Aligns aircraft to closest airport
   within capture by bearing within +/-60deg of track.
   
   Per-airframe synthesises actual landing weight via:
   - class-base MLW (HVY 250t HMB 180t HMW 75t NRW 64t RGN 36t
     BIZ 18t TBP 22t GA 1.2t FTR 22t) per Boeing/Airbus AFM MLW
   - hash-stable per-icao weight fraction 0.62-1.00 of MLW
     (typical real-world landing 70-90pct MLW per IATA AHM 560)
     scaled by LOAD-BIAS slider 60-110pct
   - tire pressure category W/X/Y/Z per ICAO Annex 14 (W=high
     no limit, X<=1.50MPa, Y<=1.00MPa, Z<=0.50MPa) per-class
     from gear/tire psi tables
   - landing gear configuration code S/D/T/TT/TDT/QDT per
     undercarriage layout (single/dual/tandem/twin-tandem/
     triple-dual-tandem/quad-dual-tandem) per AC 150/5335-5C
     Table A1-1 derived per type
   - subgrade category A/B/C/D per airport hash (A=high CBR>=13,
     B=medium 8-13, C=low 4-8, D=ultra-low <=4) per AC 150/
     5335-5C Table 2-1, modulated by SUBGRADE-OVR slider 0-3
   
   Computes per (aircraft × airport × subgrade) the Aircraft
   Classification Number ACN via tire-pressure × weight × gear-
   config lookup (linearised per Boeing/Airbus ACN tables):
     ACN_base[cls,subgrade] × (W/MLW)^1.6 × tireMul[pressureCat]
   For ACR (new 2024 system) ACR = ACN × 0.9 approximation per
   FAA EB 109 conversion guidance.
   
   5 risk components composite max-driver:
     ACN     ACN vs PCN ratio severity 0 below 1.0, ramping to
             100 at 1.10 (ICAO 10pct overload allowance breached),
             saturating 100 above
     PSI     tire pressure vs airport tire-pressure category
             limit (W=no-lim, X 1.5MPa, Y 1.0MPa, Z 0.5MPa)
             sev 0 within, ramping to 100 at 30pct over
     GEAR    gear-config vs subgrade mismatch (heavy gear on
             weak subgrade D) sev 0 if match, 60 if mismatch
             per AC 150/5335-5C Table 2-1
     OVRLD   cumulative overload-frequency exceedance vs ICAO
             Doc 9157 Pt 3 6.3 5pct-per-year rule, ramped via
             hash-stable monthly-overload-count 0-12 vs limit
     SUBG   subgrade weakness vs class (HVY on D subgrade with
             ACN>0.95 PCN ramps 0-100)
   
   Classifies 5 tiers:
     PROHIBIT score>=80 OR ACN>1.10*PCN rose — divert or weight
              dump required, exceeds 10pct overload allowance
              per ICAO Doc 9157 Pt 3 6.3
     RESTRICT score>=55 amber — ACN approaches PCN, file PPR
              with airport, restrict taxi to bypass weak areas
     WATCH    score>=25 sky — ACN within envelope but tire-PSI
              or subgrade margin tight, monitor
     OK       score<25 emerald — ACN comfortably within PCN
              all bearing limits satisfied
     IDLE     not arriving, ground, or outside capture slate

   MapLibre overlay:
     - Tier-coloured halo rings sized by score 8-22 px
     - Rose diamond pin at destination airport for PROHIBIT
       with ACN/PCN callout
     - Dashed tier-coloured projection line aircraft → airport
       threshold
     - 48 airport pins: rose RGD-HI emerald, FLX-HI sky,
       MD-tier slate, with IATA + PCN code label
     - Tier-coloured callsign + IATA + ACN/PCN + driver labels

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-ACN/PCN ratio / WORST callsign+ratio /
       PROHIBIT-count
     - 2-cell MEAN-PCN slate / OVERLOAD-share secondary
     - SVG ACN-vs-PCN scatter with rose excursion band ACN>PCN,
       amber tight 0.85-1.0, sky watch 0.65-0.85, emerald
       below 0.65, dashed thresholds, every aircraft plotted
     - 5 sliders CAPTURE 10-200nm / LOAD-BIAS 60-110pct /
       SUBGRADE-OVR 0-3 / OVRLD-MUL 0-200pct in 2-col
       + ACN-MARG 0-25pct full-width
     - 9-class chip filter HVY/HMB/HMW/NRW/RGN/BIZ/TBP/GA/FTR
     - 4-regime chip filter RGD-HI/RGD-MD/FLX-HI/FLX-MD
     - HALO/PIN/LBL/PROJ/APT/DIAG toggles + search
     - AIRCRAFT/AIRPORTS tab switcher

   Persisted preference: ft-pcn
   ============================================================ */

interface PcnFlight {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  category?: number | string
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
  flights: PcnFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'PROH' | 'REST' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  PROH: '#f43f5e',
  REST: '#f59e0b',
  WATCH: '#0ea5e9',
  OK: '#10b981',
  IDLE: '#475569',
}
const TIER_ORDER: Tier[] = ['PROH', 'REST', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { PROH: 0, REST: 1, WATCH: 2, OK: 3, IDLE: 4 }
const TIER_LABEL: Record<Tier, string> = {
  PROH: 'PROHIBIT',
  REST: 'RESTRICT',
  WATCH: 'WATCH',
  OK: 'OK',
  IDLE: 'IDLE',
}
const TIER_ADVICE: Record<Tier, string> = {
  PROH: 'ACN exceeds 10pct PCN overload allowance per ICAO Doc 9157 Pt 3 6.3 — divert or fuel-jettison to reduce LDW',
  REST: 'ACN approaches PCN — file PPR with airport, restrict taxi to load-rated centreline only',
  WATCH: 'ACN within envelope but tire-PSI or subgrade margin tight — brief crew on taxi route',
  OK: 'ACN comfortably within PCN — all bearing-strength limits satisfied',
  IDLE: 'not arriving, on ground, or outside destination capture window',
}

type Cls = 'HVY' | 'HMB' | 'HMW' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const CLS_NAME: Record<Cls, string> = {
  HVY: 'Heavy widebody (A380/747)',
  HMB: 'Heavy mid (777/787/A330/A350)',
  HMW: 'Heavy narrow (757)',
  NRW: 'Narrowbody (737/A320)',
  RGN: 'Regional jet',
  BIZ: 'Business jet',
  TBP: 'Turboprop',
  GA: 'GA piston',
  FTR: 'Fighter / military',
}

// Per-class spec: MLW(t), tire PSI, gear-config-code, ACN-base table per subgrade A/B/C/D rigid
interface ClsSpec {
  mlw: number       // t (metric tonnes)
  tirePsi: number   // psi
  tireCat: 'W' | 'X' | 'Y' | 'Z'
  gearCode: 'S' | 'D' | 'T' | 'TT' | 'TDT' | 'QDT'
  // ACN at MLW per subgrade A/B/C/D (rigid PCC / flexible AC), linearised
  acnRgd: [number, number, number, number]
  acnFlx: [number, number, number, number]
}

// Approximate ACNs derived from Boeing/Airbus ACAP documents at MLW (sample)
const CLS_SPEC: Record<Cls, ClsSpec> = {
  HVY: { mlw: 391, tirePsi: 218, tireCat: 'W', gearCode: 'QDT', acnRgd: [62, 70, 81, 96], acnFlx: [55, 64, 78, 95] },   // A380
  HMB: { mlw: 213, tirePsi: 220, tireCat: 'W', gearCode: 'TT',  acnRgd: [54, 60, 70, 84], acnFlx: [50, 58, 72, 90] },   // 777/787
  HMW: { mlw:  92, tirePsi: 195, tireCat: 'X', gearCode: 'D',   acnRgd: [36, 41, 47, 56], acnFlx: [34, 40, 49, 60] },   // 757
  NRW: { mlw:  66, tirePsi: 205, tireCat: 'X', gearCode: 'D',   acnRgd: [28, 32, 37, 44], acnFlx: [26, 31, 38, 47] },   // 737/A320
  RGN: { mlw:  36, tirePsi: 175, tireCat: 'X', gearCode: 'D',   acnRgd: [16, 18, 21, 25], acnFlx: [15, 18, 22, 27] },   // CRJ/E-jet
  BIZ: { mlw:  18, tirePsi: 165, tireCat: 'Y', gearCode: 'D',   acnRgd: [ 9, 10, 12, 14], acnFlx: [ 8, 10, 12, 15] },   // Gulfstream
  TBP: { mlw:  22, tirePsi: 110, tireCat: 'Y', gearCode: 'D',   acnRgd: [10, 11, 13, 15], acnFlx: [ 9, 11, 13, 16] },   // Dash 8
  GA:  { mlw:1.2, tirePsi:  45, tireCat: 'Z', gearCode: 'S',   acnRgd: [ 1,  1,  2,  2], acnFlx: [ 1,  1,  2,  2] },
  FTR: { mlw:  22, tirePsi: 280, tireCat: 'W', gearCode: 'S',   acnRgd: [14, 16, 19, 23], acnFlx: [13, 15, 19, 24] },   // F-15/F-22
}

// Tire pressure category limits (MPa → psi conversion: 1 MPa = 145 psi)
const TIRE_LIMIT_PSI: Record<'W' | 'X' | 'Y' | 'Z', number> = { W: 9999, X: 218, Y: 145, Z: 72 }

interface Airport {
  iata: string; icao: string; name: string; lat: number; lng: number
  pcn: number              // numerical PCN value
  pavType: 'R' | 'F'       // R rigid concrete, F flexible asphalt
  tireCat: 'W' | 'X' | 'Y' | 'Z'
  subgrade: 0 | 1 | 2 | 3  // A=0 high CBR, B=1 med, C=2 low, D=3 ultra-low
  regime: 'RGD-HI' | 'RGD-MD' | 'FLX-HI' | 'FLX-MD'
}

const AIRPORTS: Airport[] = [
  // RGD-HI rigid concrete PCN>=90 (heavy-cap hubs)
  { iata:'DXB',icao:'OMDB',name:'Dubai',lat:25.253,lng:55.366,pcn:95,pavType:'R',tireCat:'W',subgrade:1,regime:'RGD-HI'},
  { iata:'DOH',icao:'OTHH',name:'Doha',lat:25.273,lng:51.608,pcn:95,pavType:'R',tireCat:'W',subgrade:1,regime:'RGD-HI'},
  { iata:'JFK',icao:'KJFK',name:'New York JFK',lat:40.640,lng:-73.779,pcn:98,pavType:'R',tireCat:'W',subgrade:2,regime:'RGD-HI'},
  { iata:'LAX',icao:'KLAX',name:'Los Angeles',lat:33.943,lng:-118.408,pcn:90,pavType:'R',tireCat:'W',subgrade:1,regime:'RGD-HI'},
  { iata:'ORD',icao:'KORD',name:'Chicago O\'Hare',lat:41.978,lng:-87.905,pcn:92,pavType:'R',tireCat:'W',subgrade:2,regime:'RGD-HI'},
  { iata:'ATL',icao:'KATL',name:'Atlanta',lat:33.640,lng:-84.428,pcn:95,pavType:'R',tireCat:'W',subgrade:1,regime:'RGD-HI'},
  { iata:'DFW',icao:'KDFW',name:'Dallas/Ft Worth',lat:32.897,lng:-97.038,pcn:90,pavType:'R',tireCat:'W',subgrade:1,regime:'RGD-HI'},
  { iata:'LHR',icao:'EGLL',name:'London Heathrow',lat:51.470,lng:-0.454,pcn:90,pavType:'R',tireCat:'W',subgrade:2,regime:'RGD-HI'},
  { iata:'CDG',icao:'LFPG',name:'Paris CDG',lat:49.010,lng:2.548,pcn:92,pavType:'R',tireCat:'W',subgrade:1,regime:'RGD-HI'},
  { iata:'FRA',icao:'EDDF',name:'Frankfurt',lat:50.037,lng:8.562,pcn:96,pavType:'R',tireCat:'W',subgrade:1,regime:'RGD-HI'},
  { iata:'AMS',icao:'EHAM',name:'Amsterdam',lat:52.310,lng:4.762,pcn:90,pavType:'R',tireCat:'W',subgrade:3,regime:'RGD-HI'},
  { iata:'HND',icao:'RJTT',name:'Tokyo Haneda',lat:35.553,lng:139.781,pcn:95,pavType:'R',tireCat:'W',subgrade:2,regime:'RGD-HI'},
  { iata:'NRT',icao:'RJAA',name:'Tokyo Narita',lat:35.764,lng:140.386,pcn:90,pavType:'R',tireCat:'W',subgrade:1,regime:'RGD-HI'},
  { iata:'ICN',icao:'RKSI',name:'Seoul Incheon',lat:37.469,lng:126.450,pcn:92,pavType:'R',tireCat:'W',subgrade:1,regime:'RGD-HI'},
  { iata:'SIN',icao:'WSSS',name:'Singapore Changi',lat:1.359,lng:103.989,pcn:95,pavType:'R',tireCat:'W',subgrade:2,regime:'RGD-HI'},
  { iata:'HKG',icao:'VHHH',name:'Hong Kong',lat:22.308,lng:113.918,pcn:90,pavType:'R',tireCat:'W',subgrade:2,regime:'RGD-HI'},
  { iata:'PEK',icao:'ZBAA',name:'Beijing Capital',lat:40.080,lng:116.585,pcn:95,pavType:'R',tireCat:'W',subgrade:1,regime:'RGD-HI'},
  { iata:'PVG',icao:'ZSPD',name:'Shanghai Pudong',lat:31.143,lng:121.805,pcn:92,pavType:'R',tireCat:'W',subgrade:2,regime:'RGD-HI'},
  { iata:'SYD',icao:'YSSY',name:'Sydney',lat:-33.946,lng:151.177,pcn:90,pavType:'R',tireCat:'W',subgrade:1,regime:'RGD-HI'},
  { iata:'AUH',icao:'OMAA',name:'Abu Dhabi',lat:24.433,lng:54.651,pcn:95,pavType:'R',tireCat:'W',subgrade:1,regime:'RGD-HI'},
  // RGD-MD rigid PCN 55-89
  { iata:'DEN',icao:'KDEN',name:'Denver',lat:39.862,lng:-104.673,pcn:80,pavType:'R',tireCat:'W',subgrade:1,regime:'RGD-MD'},
  { iata:'PHX',icao:'KPHX',name:'Phoenix',lat:33.434,lng:-112.012,pcn:78,pavType:'R',tireCat:'W',subgrade:1,regime:'RGD-MD'},
  { iata:'SEA',icao:'KSEA',name:'Seattle',lat:47.450,lng:-122.309,pcn:75,pavType:'R',tireCat:'W',subgrade:2,regime:'RGD-MD'},
  { iata:'SFO',icao:'KSFO',name:'San Francisco',lat:37.619,lng:-122.375,pcn:70,pavType:'R',tireCat:'W',subgrade:3,regime:'RGD-MD'},
  { iata:'BOS',icao:'KBOS',name:'Boston',lat:42.363,lng:-71.006,pcn:72,pavType:'R',tireCat:'W',subgrade:2,regime:'RGD-MD'},
  { iata:'YYZ',icao:'CYYZ',name:'Toronto Pearson',lat:43.677,lng:-79.631,pcn:82,pavType:'R',tireCat:'W',subgrade:2,regime:'RGD-MD'},
  { iata:'YVR',icao:'CYVR',name:'Vancouver',lat:49.194,lng:-123.184,pcn:78,pavType:'R',tireCat:'W',subgrade:3,regime:'RGD-MD'},
  { iata:'GRU',icao:'SBGR',name:'São Paulo',lat:-23.435,lng:-46.473,pcn:60,pavType:'R',tireCat:'X',subgrade:2,regime:'RGD-MD'},
  { iata:'JNB',icao:'FAOR',name:'Johannesburg',lat:-26.139,lng:28.246,pcn:65,pavType:'R',tireCat:'W',subgrade:1,regime:'RGD-MD'},
  { iata:'CAI',icao:'HECA',name:'Cairo',lat:30.122,lng:31.406,pcn:70,pavType:'R',tireCat:'W',subgrade:1,regime:'RGD-MD'},
  { iata:'BKK',icao:'VTBS',name:'Bangkok',lat:13.690,lng:100.750,pcn:85,pavType:'R',tireCat:'W',subgrade:2,regime:'RGD-MD'},
  { iata:'MEX',icao:'MMMX',name:'Mexico City',lat:19.436,lng:-99.072,pcn:55,pavType:'R',tireCat:'X',subgrade:3,regime:'RGD-MD'},
  // FLX-HI flexible PCN>=70
  { iata:'MIA',icao:'KMIA',name:'Miami',lat:25.793,lng:-80.291,pcn:88,pavType:'F',tireCat:'W',subgrade:2,regime:'FLX-HI'},
  { iata:'EWR',icao:'KEWR',name:'Newark',lat:40.692,lng:-74.169,pcn:75,pavType:'F',tireCat:'W',subgrade:2,regime:'FLX-HI'},
  { iata:'IST',icao:'LTFM',name:'Istanbul',lat:41.275,lng:28.752,pcn:80,pavType:'F',tireCat:'W',subgrade:1,regime:'FLX-HI'},
  { iata:'MAD',icao:'LEMD',name:'Madrid',lat:40.472,lng:-3.561,pcn:82,pavType:'F',tireCat:'W',subgrade:1,regime:'FLX-HI'},
  { iata:'BCN',icao:'LEBL',name:'Barcelona',lat:41.297,lng:2.078,pcn:75,pavType:'F',tireCat:'W',subgrade:2,regime:'FLX-HI'},
  { iata:'FCO',icao:'LIRF',name:'Rome Fiumicino',lat:41.804,lng:12.252,pcn:78,pavType:'F',tireCat:'W',subgrade:2,regime:'FLX-HI'},
  { iata:'MUC',icao:'EDDM',name:'Munich',lat:48.353,lng:11.786,pcn:78,pavType:'F',tireCat:'W',subgrade:1,regime:'FLX-HI'},
  { iata:'ZRH',icao:'LSZH',name:'Zurich',lat:47.464,lng:8.549,pcn:72,pavType:'F',tireCat:'W',subgrade:2,regime:'FLX-HI'},
  { iata:'TLV',icao:'LLBG',name:'Tel Aviv',lat:32.011,lng:34.886,pcn:85,pavType:'F',tireCat:'W',subgrade:1,regime:'FLX-HI'},
  { iata:'DEL',icao:'VIDP',name:'Delhi',lat:28.566,lng:77.103,pcn:90,pavType:'F',tireCat:'W',subgrade:2,regime:'FLX-HI'},
  // FLX-MD flexible PCN 35-69 (regional / weak)
  { iata:'LGA',icao:'KLGA',name:'New York LaGuardia',lat:40.777,lng:-73.872,pcn:60,pavType:'F',tireCat:'X',subgrade:3,regime:'FLX-MD'},
  { iata:'DCA',icao:'KDCA',name:'Washington Reagan',lat:38.852,lng:-77.038,pcn:55,pavType:'F',tireCat:'X',subgrade:3,regime:'FLX-MD'},
  { iata:'MDW',icao:'KMDW',name:'Chicago Midway',lat:41.786,lng:-87.752,pcn:50,pavType:'F',tireCat:'X',subgrade:2,regime:'FLX-MD'},
  { iata:'LCY',icao:'EGLC',name:'London City',lat:51.505,lng:0.055,pcn:42,pavType:'F',tireCat:'X',subgrade:3,regime:'FLX-MD'},
  { iata:'SAN',icao:'KSAN',name:'San Diego',lat:32.733,lng:-117.190,pcn:58,pavType:'F',tireCat:'X',subgrade:2,regime:'FLX-MD'},
  { iata:'ASE',icao:'KASE',name:'Aspen',lat:39.223,lng:-106.869,pcn:38,pavType:'F',tireCat:'Y',subgrade:2,regime:'FLX-MD'},
  { iata:'TEB',icao:'KTEB',name:'Teterboro',lat:40.850,lng:-74.061,pcn:48,pavType:'F',tireCat:'X',subgrade:3,regime:'FLX-MD'},
  { iata:'BUR',icao:'KBUR',name:'Burbank',lat:34.201,lng:-118.359,pcn:55,pavType:'F',tireCat:'X',subgrade:2,regime:'FLX-MD'},
]

interface Row {
  f: PcnFlight
  cls: Cls
  spec: ClsSpec
  apt: Airport | null
  distNm: number
  phase: string
  altKft: number
  loadFrac: number
  ldwT: number
  acn: number
  acr: number
  acnRatio: number      // ACN / PCN
  tireSev: number
  gearSev: number
  acnSev: number
  ovrldSev: number
  subgSev: number
  driver: string
  driverLong: string
  score: number
  tier: Tier
}

const DRIVER_LONG: Record<string, string> = {
  ACN: 'ACN exceeds PCN bearing capacity',
  PSI: 'Tire pressure above airport category limit',
  GEAR: 'Heavy gear-config on weak subgrade — taxi restriction',
  OVRLD: 'Cumulative overload-frequency exceeds Doc 9157 6.3 rule',
  SUBG: 'Subgrade weakness margin tight for class',
}

function hashUnit(s: string, salt: string): number {
  let h = 0x811c9dc5
  const x = (salt + '|' + s)
  for (let i = 0; i < x.length; i++) {
    h ^= x.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h % 100000) / 100000
}

function classify(type?: string): Cls {
  const t = (type || '').toUpperCase()
  if (/^(A38|B74)/.test(t)) return 'HVY'
  if (/^(B77|B78|A33|A34|A35|MD11)/.test(t)) return 'HMB'
  if (/^(B75)/.test(t)) return 'HMW'
  if (/^(B73|A31|A32|A22|MD8|MD9)/.test(t)) return 'NRW'
  if (/^(CRJ|E17|E19|E29|AT[47])/.test(t)) return 'RGN'
  if (/^(GLF|GL|FA|F900|F2TH|CL|GLEX|G[56])/.test(t)) return 'BIZ'
  if (/^(DH8|AT4|AT7|BE|PA4|SF34|J32)/.test(t)) return 'TBP'
  if (/^(C1[5678]|SR2|PA28|DA40|DA42|PC12|TBM)/.test(t)) return 'GA'
  if (/^(F1[56]|F18|F22|F35|EUF|MIG|SU[2-3]|T[6-8])/.test(t)) return 'FTR'
  return 'NRW'
}

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3440
  const dl = (lat2 - lat1) * Math.PI / 180
  const dn = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dl/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dn/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

function bearingTo(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = lat1*Math.PI/180, φ2 = lat2*Math.PI/180
  const Δλ = (lon2-lon1)*Math.PI/180
  const y = Math.sin(Δλ)*Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ)
  return (Math.atan2(y, x)*180/Math.PI + 360) % 360
}

export default function PcnPavement({ map, flights, onClose, onFly }: Props) {
  const [capture, setCapture] = useState(80)        // 10-200 nm
  const [loadBias, setLoadBias] = useState(100)     // 60-110 pct
  const [subgradeOvr, setSubgradeOvr] = useState(0) // 0=auto, 1-3 force
  const [ovrldMul, setOvrldMul] = useState(100)     // 0-200 pct
  const [acnMarg, setAcnMarg] = useState(10)        // 0-25 pct (ICAO 10pct allowance)
  const [tierFilter, setTierFilter] = useState<Set<Tier>>(new Set())
  const [clsFilter, setClsFilter] = useState<Set<Cls>>(new Set())
  const [regimeFilter, setRegimeFilter] = useState<Set<Airport['regime']>>(new Set())
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showApt, setShowApt] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const lbScale = loadBias / 100
    const ovScale = ovrldMul / 100
    const margFrac = 1 + acnMarg / 100
    for (const f of flights) {
      const cls = classify(f.type)
      const spec = CLS_SPEC[cls]
      const altKft = f.altitudeFt / 1000
      const fl = Math.round(altKft * 10)
      // phase inference
      let phase = 'CRZ'
      if (f.ground) phase = 'GND'
      else if (fl < 50) phase = 'APPR'
      else if (fl < 120 && f.vertRate < -500) phase = 'DESC'
      else if (f.vertRate < -300) phase = 'DESC'
      else if (f.vertRate > 500) phase = 'CLB'

      // find destination airport: closest within capture, bearing aligned within +/-60deg of track
      let apt: Airport | null = null
      let bestD = Infinity
      if (!f.ground && (phase === 'APPR' || phase === 'DESC') && fl < 200) {
        for (const a of AIRPORTS) {
          const d = haversineNm(f.lat, f.lng, a.lat, a.lng)
          if (d > capture) continue
          const brg = bearingTo(f.lat, f.lng, a.lat, a.lng)
          let dHd = Math.abs(((brg - f.track) + 540) % 360 - 180)
          if (dHd > 60) continue
          if (d < bestD) { bestD = d; apt = a }
        }
      }

      const distNm = apt ? bestD : -1

      // synth load fraction
      const loadFrac = Math.max(0.55, Math.min(1.05, (0.62 + hashUnit(f.icao, 'load') * 0.38) * lbScale))
      const ldwT = spec.mlw * loadFrac

      // subgrade effective: airport.subgrade if not override
      const sgIdx = apt ? (subgradeOvr > 0 ? subgradeOvr - 1 : apt.subgrade) : 0
      const acnTbl = apt ? (apt.pavType === 'R' ? spec.acnRgd : spec.acnFlx) : spec.acnRgd
      const acnAtMlw = acnTbl[sgIdx]
      const acn = acnAtMlw * Math.pow(loadFrac, 1.6)
      const acr = acn * 0.9
      const acnRatio = apt ? acn / apt.pcn : 0

      // tire pressure check
      const tireLim = apt ? TIRE_LIMIT_PSI[apt.tireCat] : 9999
      const tireOver = Math.max(0, (spec.tirePsi - tireLim) / Math.max(50, tireLim))
      const tireSev = Math.min(100, tireOver / 0.30 * 100)

      // gear-config × subgrade mismatch (heavy gear on D subgrade is bad)
      const heavyGear = spec.gearCode === 'QDT' || spec.gearCode === 'TDT' || spec.gearCode === 'TT'
      const gearSev = (apt && sgIdx === 3 && heavyGear && acnRatio > 0.85) ? 60 :
                     (apt && sgIdx >= 2 && heavyGear && acnRatio > 0.95) ? 35 : 0

      // ACN ratio severity
      let acnSev = 0
      if (apt) {
        if (acnRatio < 0.85) acnSev = 0
        else if (acnRatio < 1.0) acnSev = (acnRatio - 0.85) / 0.15 * 35
        else if (acnRatio < margFrac) acnSev = 50 + (acnRatio - 1.0) / (margFrac - 1.0) * 30
        else acnSev = Math.min(100, 80 + (acnRatio - margFrac) / 0.1 * 100)
      }

      // overload-frequency: hash-stable monthly overloads vs limit
      const monthlyOv = Math.floor(hashUnit(f.icao + (apt ? apt.iata : ''), 'ovl') * 12) * ovScale
      const ovrldSev = apt && acnRatio > 1.0 ? Math.min(100, monthlyOv / 12 * 100) :
                      apt && acnRatio > 0.9 ? Math.min(60, monthlyOv / 12 * 60) : 0

      // subgrade weakness alarm
      const subgSev = apt && sgIdx === 3 && (cls === 'HVY' || cls === 'HMB') ?
                     Math.min(100, Math.max(0, (acnRatio - 0.7)) * 200) : 0

      const parts: { name: string; sev: number }[] = [
        { name: 'ACN', sev: acnSev },
        { name: 'PSI', sev: tireSev },
        { name: 'GEAR', sev: gearSev },
        { name: 'OVRLD', sev: ovrldSev },
        { name: 'SUBG', sev: subgSev },
      ]
      parts.sort((a, b) => b.sev - a.sev)
      const score = parts[0].sev
      const driver = parts[0].name

      let tier: Tier
      if (!apt || f.ground) tier = 'IDLE'
      else if (score >= 80 || acnRatio > margFrac) tier = 'PROH'
      else if (score >= 55) tier = 'REST'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, cls, spec, apt, distNm, phase, altKft, loadFrac, ldwT,
        acn, acr, acnRatio,
        tireSev, gearSev, acnSev, ovrldSev, subgSev,
        driver, driverLong: DRIVER_LONG[driver] || driver,
        score, tier,
      })
    }
    return out
  }, [flights, capture, loadBias, subgradeOvr, ovrldMul, acnMarg])

  const stats = useMemo(() => {
    const counts: Record<Tier, number> = { PROH: 0, REST: 0, WATCH: 0, OK: 0, IDLE: 0 }
    let sumRatio = 0, sumPcn = 0, n = 0, ovN = 0, totN = 0
    let worst: Row | null = null
    for (const r of rows) {
      counts[r.tier]++
      if (r.tier === 'IDLE') continue
      sumRatio += r.acnRatio; if (r.apt) sumPcn += r.apt.pcn
      n++; totN++
      if (r.acnRatio > 1.0) ovN++
      if (!worst || r.score > worst.score) worst = r
    }
    return {
      counts,
      meanRatio: n ? sumRatio / n : 0,
      meanPcn: n ? sumPcn / n : 0,
      ovShare: totN ? ovN / totN : 0,
      worst,
    }
  }, [rows])

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter.size && !tierFilter.has(r.tier)) return false
      if (clsFilter.size && !clsFilter.has(r.cls)) return false
      if (regimeFilter.size && (!r.apt || !regimeFilter.has(r.apt.regime))) return false
      if (q) {
        const blob = `${r.f.callsign || ''} ${r.f.type || ''} ${r.f.operator || ''} ${r.apt?.iata || ''}`.toUpperCase()
        if (!blob.includes(q)) return false
      }
      return true
    }).sort((a, b) => {
      const r = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (r) return r
      return b.score - a.score
    })
  }, [rows, tierFilter, clsFilter, regimeFilter, search])

  const airports = useMemo(() => {
    const grp = new Map<string, Row[]>()
    for (const r of rows) {
      if (r.tier === 'IDLE' || !r.apt) continue
      const k = r.apt.iata
      if (!grp.has(k)) grp.set(k, [])
      grp.get(k)!.push(r)
    }
    return Array.from(grp.entries()).map(([iata, rs]) => {
      const a = rs[0].apt!
      const worstTier = rs.reduce<Tier>((t, r) => TIER_RANK[r.tier] < TIER_RANK[t] ? r.tier : t, 'OK')
      const meanScore = rs.reduce((s, r) => s + r.score, 0) / rs.length
      const meanRatio = rs.reduce((s, r) => s + r.acnRatio, 0) / rs.length
      const worst = rs.reduce((p, r) => r.score > p.score ? r : p)
      const prohN = rs.filter(r => r.tier === 'PROH').length
      return { iata, a, rs, worstTier, meanScore, meanRatio, worst, prohN }
    }).sort((x, y) => {
      const r = TIER_RANK[x.worstTier] - TIER_RANK[y.worstTier]
      if (r) return r
      return y.rs.length - x.rs.length
    })
  }, [rows])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const SRC = 'ft-pcn-src'
    const HALO = 'ft-pcn-halo'
    const PIN = 'ft-pcn-pin'
    const LBL = 'ft-pcn-lbl'
    const PROJ_SRC = 'ft-pcn-proj-src'
    const PROJ_LYR = 'ft-pcn-proj'
    const APT_SRC = 'ft-pcn-apt-src'
    const APT_PIN = 'ft-pcn-apt-pin'
    const APT_LBL = 'ft-pcn-apt-lbl'

    const features: GeoJSON.Feature[] = []
    const projFeatures: GeoJSON.Feature[] = []
    for (const r of rows) {
      if (r.tier === 'IDLE' || !r.apt) continue
      if (tierFilter.size && !tierFilter.has(r.tier)) continue
      if (clsFilter.size && !clsFilter.has(r.cls)) continue
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
        properties: {
          tier: r.tier,
          color: TIER_COLOR[r.tier],
          radius: 8 + (r.score / 100) * 14,
          label: `${r.f.callsign || r.f.icao} · ${r.apt.iata} · ACN ${r.acn.toFixed(0)}/${r.apt.pcn} · ${r.driver}`,
          isProh: r.tier === 'PROH' ? 1 : 0,
        },
      })
      if (r.tier !== 'OK') {
        projFeatures.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.apt.lng, r.apt.lat]] },
          properties: { color: TIER_COLOR[r.tier] },
        })
      }
    }
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features }
    const pfc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: projFeatures }

    const aptFeatures: GeoJSON.Feature[] = []
    if (showApt) {
      for (const a of AIRPORTS) {
        const color = a.regime === 'FLX-MD' || a.regime === 'RGD-MD' ? '#475569' :
                      a.regime === 'FLX-HI' ? '#0ea5e9' : '#10b981'
        aptFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [a.lng, a.lat] },
          properties: { color, label: `${a.iata} ${a.pavType}${a.pcn}` },
        })
      }
    }
    const afc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: aptFeatures }

    const addAll = () => {
      for (const [s, d] of [[SRC, fc], [PROJ_SRC, pfc], [APT_SRC, afc]] as const) {
        const ex = map.getSource(s) as maplibregl.GeoJSONSource | undefined
        if (ex) ex.setData(d as any)
        else map.addSource(s, { type: 'geojson', data: d as any })
      }

      if (showProj && !map.getLayer(PROJ_LYR)) {
        map.addLayer({
          id: PROJ_LYR, source: PROJ_SRC, type: 'line',
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 1,
            'line-opacity': 0.55,
            'line-dasharray': [2, 3],
          },
        })
      }
      if (!showProj && map.getLayer(PROJ_LYR)) map.removeLayer(PROJ_LYR)

      if (showApt) {
        if (!map.getLayer(APT_PIN)) {
          map.addLayer({
            id: APT_PIN, source: APT_SRC, type: 'circle',
            paint: {
              'circle-radius': 3.5,
              'circle-color': ['get', 'color'],
              'circle-opacity': 0.6,
              'circle-stroke-color': '#0f172a',
              'circle-stroke-width': 1,
            },
          })
        }
        if (!map.getLayer(APT_LBL)) {
          map.addLayer({
            id: APT_LBL, source: APT_SRC, type: 'symbol',
            layout: {
              'text-field': ['get', 'label'],
              'text-size': 9,
              'text-offset': [0, 1.0],
              'text-anchor': 'top',
              'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
            },
            paint: {
              'text-color': '#94a3b8',
              'text-halo-color': '#020617',
              'text-halo-width': 1.2,
            },
          })
        }
      } else {
        for (const l of [APT_LBL, APT_PIN]) if (map.getLayer(l)) map.removeLayer(l)
      }

      if (showHalo && !map.getLayer(HALO)) {
        map.addLayer({
          id: HALO, source: SRC, type: 'circle',
          paint: {
            'circle-radius': ['get', 'radius'],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.15,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 1.4,
            'circle-stroke-opacity': 0.85,
          },
        })
      }
      if (!showHalo && map.getLayer(HALO)) map.removeLayer(HALO)

      if (showPin && !map.getLayer(PIN)) {
        map.addLayer({
          id: PIN, source: SRC, type: 'circle',
          filter: ['==', ['get', 'isProh'], 1],
          paint: {
            'circle-radius': 6,
            'circle-color': '#f43f5e',
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 1.5,
          },
        })
      }
      if (!showPin && map.getLayer(PIN)) map.removeLayer(PIN)

      if (showLbl && !map.getLayer(LBL)) {
        map.addLayer({
          id: LBL, source: SRC, type: 'symbol',
          filter: ['!=', ['get', 'tier'], 'OK'],
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-offset': [0, 1.4],
            'text-anchor': 'top',
            'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          },
          paint: {
            'text-color': ['get', 'color'],
            'text-halo-color': '#020617',
            'text-halo-width': 1.4,
          },
        })
      }
      if (!showLbl && map.getLayer(LBL)) map.removeLayer(LBL)
    }

    if (map.isStyleLoaded()) addAll()
    else map.once('load', addAll)

    return () => {
      for (const l of [LBL, PIN, HALO, PROJ_LYR, APT_LBL, APT_PIN]) if (map.getLayer(l)) map.removeLayer(l)
      for (const s of [SRC, PROJ_SRC, APT_SRC]) if (map.getSource(s)) map.removeSource(s)
    }
  }, [map, rows, tierFilter, clsFilter, showHalo, showPin, showLbl, showProj, showApt])

  const toggleSet = <T,>(s: Set<T>, v: T): Set<T> => {
    const n = new Set(s); if (n.has(v)) n.delete(v); else n.add(v); return n
  }

  // SVG scatter ACN vs PCN
  const w = 360, h = 180
  const xMin = 30, xMax = 110  // PCN
  const yMin = 0,  yMax = 1.4  // ratio
  const px = (pcn: number) => ((pcn - xMin) / (xMax - xMin)) * w
  const py = (rat: number) => h - ((rat - yMin) / (yMax - yMin)) * h

  return (
    <div className="absolute top-4 right-4 z-40 w-[420px] max-h-[90vh] overflow-hidden bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl flex flex-col">
      <div className="sticky top-0 bg-slate-950/95 px-4 py-3 border-b border-slate-800 flex items-center justify-between shrink-0">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">ICAO Annex 14 · Doc 9157 Pt 3 · FAA AC 150/5335-5C</div>
          <div className="text-sm font-semibold text-slate-100">PCN / ACR Pavement Bearing-Strength</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      <div className="overflow-y-auto px-4 py-3 space-y-3 text-xs">
        {/* Tier counter strip */}
        <div className="grid grid-cols-5 gap-1">
          {TIER_ORDER.map(t => (
            <button key={t}
              onClick={() => setTierFilter(s => toggleSet(s, t))}
              className={`px-1.5 py-1 rounded border text-[10px] transition ${tierFilter.has(t) ? 'bg-sky-500/15 border-sky-500/50' : 'bg-slate-900/50 border-slate-800 hover:border-slate-700'}`}
              style={{ borderLeftWidth: 3, borderLeftColor: TIER_COLOR[t] }}>
              <div className="font-semibold text-slate-100">{stats.counts[t]}</div>
              <div className="text-[9px] text-slate-500 truncate">{TIER_LABEL[t]}</div>
            </button>
          ))}
        </div>

        {/* Summary cells */}
        <div className="grid grid-cols-3 gap-1.5">
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">MEAN ACN/PCN</div>
            <div className={`font-mono ${stats.meanRatio > 1.0 ? 'text-rose-300' : stats.meanRatio > 0.85 ? 'text-amber-300' : 'text-slate-100'}`}>
              {stats.meanRatio.toFixed(2)}
            </div>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">WORST</div>
            <div className="font-mono text-slate-100 truncate">
              {stats.worst ? `${stats.worst.f.callsign || stats.worst.f.icao} · ${stats.worst.acnRatio.toFixed(2)}` : '—'}
            </div>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5" style={{ borderLeftWidth: 3, borderLeftColor: TIER_COLOR['PROH'] }}>
            <div className="text-[9px] uppercase tracking-wider text-slate-500">PROHIBIT</div>
            <div className="font-mono text-slate-100">{stats.counts['PROH']}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">MEAN PCN</div>
            <div className="font-mono text-slate-100">{stats.meanPcn.toFixed(0)}</div>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">OVERLOAD &gt;1.0</div>
            <div className={`font-mono ${stats.ovShare >= 0.15 ? 'text-rose-300' : stats.ovShare >= 0.05 ? 'text-amber-300' : 'text-slate-100'}`}>
              {(stats.ovShare * 100).toFixed(0)}%
            </div>
          </div>
        </div>

        {/* SVG scatter */}
        {showDiag && (
          <div className="bg-slate-900/30 border border-slate-800 rounded p-1.5">
            <div className="flex justify-between items-center text-[9px] text-slate-500 mb-1">
              <span>ACN/PCN × PCN · ICAO Doc 9157 6.3</span>
              <span>overload &gt; 1.10</span>
            </div>
            <svg viewBox={`0 0 ${w} ${h + 22}`} className="w-full">
              {/* tier bands */}
              <rect x={0} y={py(1 + acnMarg/100)} width={w} height={py(1.0) - py(1 + acnMarg/100)} fill="#f59e0b" fillOpacity={0.1} />
              <rect x={0} y={py(1.4)} width={w} height={py(1 + acnMarg/100) - py(1.4)} fill="#f43f5e" fillOpacity={0.13} />
              <rect x={0} y={py(1.0)} width={w} height={py(0.85) - py(1.0)} fill="#0ea5e9" fillOpacity={0.06} />
              <rect x={0} y={py(0.85)} width={w} height={py(0) - py(0.85)} fill="#10b981" fillOpacity={0.06} />
              {/* thresholds */}
              <line x1={0} x2={w} y1={py(1.0)} y2={py(1.0)} stroke="#f59e0b" strokeWidth={0.8} strokeDasharray="3 2" />
              <line x1={0} x2={w} y1={py(1 + acnMarg/100)} y2={py(1 + acnMarg/100)} stroke="#f43f5e" strokeWidth={0.8} strokeDasharray="3 2" />
              <text x={2} y={py(1.0) - 1} fontSize={7} fill="#f59e0b">PCN limit</text>
              <text x={2} y={py(1 + acnMarg/100) - 1} fontSize={7} fill="#f43f5e">+{acnMarg}% overload</text>
              {/* grid */}
              {[40, 60, 80, 100].map(pc => (
                <g key={'pc' + pc}>
                  <line x1={px(pc)} x2={px(pc)} y1={0} y2={h} stroke="#1e293b" strokeWidth={0.5} />
                  <text x={px(pc) + 2} y={h - 2} fontSize={7} fill="#475569">PCN{pc}</text>
                </g>
              ))}
              {[0.5, 1.0, 1.2].map(rt => (
                <text key={'r'+rt} x={w - 22} y={py(rt) - 1} fontSize={7} fill="#475569">{rt.toFixed(1)}</text>
              ))}
              {/* dots */}
              {rows.filter(r => r.tier !== 'IDLE' && r.apt).slice(0, 800).map((r, i) => (
                <circle key={i} cx={Math.max(0, Math.min(w, px(r.apt!.pcn)))} cy={Math.max(0, Math.min(h, py(r.acnRatio)))}
                  r={r.tier === 'PROH' ? 3 : 2} fill={TIER_COLOR[r.tier]} fillOpacity={0.85} />
              ))}
              {/* legend */}
              <g transform={`translate(0,${h + 4})`}>
                <rect x={0} y={0} width={8} height={8} fill="#f43f5e" fillOpacity={0.4} />
                <text x={11} y={7} fontSize={8} fill="#94a3b8">overload</text>
                <rect x={60} y={0} width={8} height={8} fill="#f59e0b" fillOpacity={0.4} />
                <text x={71} y={7} fontSize={8} fill="#94a3b8">10% margin</text>
                <rect x={140} y={0} width={8} height={8} fill="#0ea5e9" fillOpacity={0.4} />
                <text x={151} y={7} fontSize={8} fill="#94a3b8">watch</text>
                <rect x={195} y={0} width={8} height={8} fill="#10b981" fillOpacity={0.4} />
                <text x={206} y={7} fontSize={8} fill="#94a3b8">nominal</text>
              </g>
            </svg>
          </div>
        )}

        {/* Sliders */}
        <div className="grid grid-cols-2 gap-2">
          {[
            ['CAPTURE', capture, setCapture, 10, 200, 'nm'],
            ['LOAD-BIAS', loadBias, setLoadBias, 60, 110, '%'],
            ['SUBG-OVR', subgradeOvr, setSubgradeOvr, 0, 3, ''],
            ['OVRLD-MUL', ovrldMul, setOvrldMul, 0, 200, '%'],
          ].map(([lbl, val, setter, min, max, unit]: any) => (
            <label key={lbl} className="block">
              <div className="flex justify-between text-[9px] uppercase tracking-wider text-slate-500 mb-0.5">
                <span>{lbl}</span><span className="font-mono text-slate-300">{val}{unit}</span>
              </div>
              <input type="range" min={min} max={max} value={val} onChange={e => setter(Number(e.target.value))}
                className="w-full accent-sky-500" />
            </label>
          ))}
        </div>
        <label className="block">
          <div className="flex justify-between text-[9px] uppercase tracking-wider text-slate-500 mb-0.5">
            <span>ACN-MARG (ICAO overload allowance)</span><span className="font-mono text-slate-300">+{acnMarg}%</span>
          </div>
          <input type="range" min={0} max={25} value={acnMarg} onChange={e => setAcnMarg(Number(e.target.value))}
            className="w-full accent-sky-500" />
        </label>

        {/* Class filter */}
        <div className="flex gap-1 flex-wrap">
          {(Object.keys(CLS_SPEC) as Cls[]).map(c => (
            <button key={c} onClick={() => setClsFilter(s => toggleSet(s, c))}
              title={CLS_NAME[c]}
              className={`px-1.5 py-0.5 rounded border text-[10px] transition ${clsFilter.has(c) ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-300 hover:border-slate-700'}`}>
              {c}
            </button>
          ))}
        </div>
        {/* Regime filter */}
        <div className="flex gap-1 flex-wrap">
          {(['RGD-HI', 'RGD-MD', 'FLX-HI', 'FLX-MD'] as Airport['regime'][]).map(r => (
            <button key={r} onClick={() => setRegimeFilter(s => toggleSet(s, r))}
              className={`px-1.5 py-0.5 rounded border text-[10px] transition ${regimeFilter.has(r) ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>
              {r}
            </button>
          ))}
        </div>

        {/* Layer toggles + search */}
        <div className="flex items-center gap-1 flex-wrap">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['PROJ', showProj, setShowProj],
            ['APT', showApt, setShowApt],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lbl, on, set]: any) => (
            <button key={lbl} onClick={() => set((v: boolean) => !v)}
              className={`px-1.5 py-0.5 rounded border text-[10px] ${on ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400'}`}>
              {lbl}
            </button>
          ))}
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search"
            className="flex-1 min-w-0 bg-slate-900/50 border border-slate-800 rounded px-2 py-0.5 text-[11px] text-slate-100 placeholder-slate-600" />
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1">
          {(['AIRCRAFT', 'AIRPORTS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 rounded border text-[10px] ${tab === t ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400'}`}>
              {t}
            </button>
          ))}
        </div>

        {/* Aircraft tab */}
        {tab === 'AIRCRAFT' && (
          <div className="space-y-1.5">
            {filtered.slice(0, 100).map(r => {
              const tc = TIER_COLOR[r.tier]
              const apt = r.apt!
              return (
                <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
                  className="w-full text-left bg-slate-900/50 hover:bg-slate-800/70 border border-slate-800 hover:border-slate-700 rounded p-2 transition"
                  style={{ borderLeftWidth: 3, borderLeftColor: tc }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-slate-100 text-[11px] truncate flex-1">
                      {r.f.callsign || r.f.icao}
                      <span className="text-slate-500 ml-1">{r.f.type || ''}</span>
                    </div>
                    <span className="text-[9px] px-1 py-0.5 rounded border" style={{ color: tc, borderColor: tc + '80' }}>{apt.iata}</span>
                    <span className="text-[9px] px-1 py-0.5 rounded font-semibold" style={{ color: tc, background: tc + '22', border: `1px solid ${tc}66` }}>{TIER_LABEL[r.tier]}</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] mt-0.5">
                    <span className="font-mono text-slate-400">
                      {r.phase} · {r.distNm.toFixed(0)}nm · LDW {r.ldwT.toFixed(0)}t/{r.spec.mlw}t · ACN <span style={{ color: r.acnRatio > 1 ? '#f43f5e' : r.acnRatio > 0.85 ? '#f59e0b' : '#10b981' }}>{r.acn.toFixed(0)}</span>/<span className="text-slate-300">{apt.pcn}</span> ({(r.acnRatio*100).toFixed(0)}%)
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 bg-slate-800 rounded relative overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${r.score}%`, background: tc, opacity: 0.85 }} />
                    {[25, 55, 80].map(t => (
                      <div key={t} className="absolute top-0 bottom-0 w-px bg-slate-600" style={{ left: `${t}%` }} />
                    ))}
                  </div>
                  <div className="grid grid-cols-5 gap-0.5 mt-1">
                    {[
                      ['ACN', r.acnSev],
                      ['PSI', r.tireSev],
                      ['GR', r.gearSev],
                      ['OVL', r.ovrldSev],
                      ['SUBG', r.subgSev],
                    ].map(([k, v]: any) => {
                      const c = v >= 80 ? TIER_COLOR.PROH : v >= 55 ? TIER_COLOR.REST : v >= 25 ? TIER_COLOR.WATCH : TIER_COLOR.OK
                      return (
                        <div key={k} className="text-center text-[8px] py-0.5 rounded" style={{ background: c + '22', color: c, border: `1px solid ${c}44` }}>
                          {k} {v.toFixed(0)}
                        </div>
                      )
                    })}
                  </div>
                  <div className="flex items-center justify-between text-[9px] mt-1 text-slate-500">
                    <span className="font-mono">
                      <span className="text-slate-400">{apt.pavType==='R'?'PCC':'AC'} {apt.tireCat} subg {['A','B','C','D'][apt.subgrade]}</span>
                      {' · '}
                      <span className={r.spec.tirePsi > TIRE_LIMIT_PSI[apt.tireCat] ? 'text-rose-400' : ''}>tire {r.spec.tirePsi}psi</span>
                      {' · gear '}<span className="text-slate-400">{r.spec.gearCode}</span>
                      {' · ACR '}<span className="text-slate-400">{r.acr.toFixed(0)}</span>
                    </span>
                    <span className="truncate ml-1">{r.f.operator || ''}</span>
                  </div>
                  <div className="text-[9px] mt-0.5" style={{ color: tc }}>› {r.driverLong} · {TIER_ADVICE[r.tier]}</div>
                </button>
              )
            })}
            {!filtered.length && (
              <div className="text-center text-slate-500 py-4 text-[11px]">No aircraft match filters</div>
            )}
          </div>
        )}

        {/* Airports tab */}
        {tab === 'AIRPORTS' && (
          <div className="space-y-1.5">
            {airports.map(a => {
              const tc = TIER_COLOR[a.worstTier]
              return (
                <button key={a.iata} onClick={() => onFly(a.worst.f.icao)}
                  className="w-full text-left bg-slate-900/50 hover:bg-slate-800/70 border border-slate-800 hover:border-slate-700 rounded p-2 transition"
                  style={{ borderLeftWidth: 3, borderLeftColor: tc }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 flex-1 min-w-0">
                      <span className="text-[9px] px-1 py-0.5 rounded border font-mono" style={{ color: tc, borderColor: tc + '80' }}>{a.iata}</span>
                      <span className="text-slate-100 text-[11px] truncate">{a.a.name}</span>
                    </div>
                    <span className="text-[10px] font-mono text-slate-400">{a.rs.length} ac</span>
                    <span className="text-[9px] px-1 py-0.5 rounded font-semibold" style={{ color: tc, background: tc + '22', border: `1px solid ${tc}66` }}>{TIER_LABEL[a.worstTier]}</span>
                  </div>
                  <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                    PCN <span className="text-slate-200">{a.a.pcn}/{a.a.pavType}/{a.a.tireCat}/{['A','B','C','D'][a.a.subgrade]}</span>
                    {' · '}mean ACN/PCN <span style={{ color: a.meanRatio > 1 ? '#f43f5e' : a.meanRatio > 0.85 ? '#f59e0b' : '#10b981' }}>{a.meanRatio.toFixed(2)}</span>
                    {' · '}worst {a.worst.f.callsign || a.worst.f.icao} {a.worst.acnRatio.toFixed(2)}
                  </div>
                  <div className="mt-1 h-1.5 bg-slate-800 rounded relative overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${a.meanScore}%`, background: tc, opacity: 0.85 }} />
                    {[25, 55, 80].map(t => (
                      <div key={t} className="absolute top-0 bottom-0 w-px bg-slate-600" style={{ left: `${t}%` }} />
                    ))}
                  </div>
                  <div className="text-[9px] mt-1 text-slate-500 font-mono">
                    regime {a.a.regime}
                    {' · '}prohibit {a.prohN}
                    {' · '}{a.a.icao}
                  </div>
                  <div className="text-[9px] mt-0.5" style={{ color: tc }}>› {TIER_ADVICE[a.worstTier]}</div>
                </button>
              )
            })}
            {!airports.length && (
              <div className="text-center text-slate-500 py-4 text-[11px]">No active arrivals</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
