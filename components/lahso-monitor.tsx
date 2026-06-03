'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   LAHSO · Land-And-Hold-Short Operations Monitor
   ------------------------------------------------------------
   Per-arrival Available Landing Distance (ALD) vs published
   LAHSO hold-short distance compliance assessment for the FAA
   LAHSO programme per FAA Order JO 7110.118 / AC 91-73 / AIM
   4-3-11.  Cross-references aircraft category (A-E per AIM
   5-4-7), runway condition (RCAM / TALPA Mu per AC 25-32),
   stopping distance under wet/dry/contaminated surface, and
   intersecting traffic conflict on the held-short runway.

   16-airport LAHSO catalogue with 42 published LAHSO runway
   intersections:
     KORD 10L/10C/10R + 4L/22R/27L/27R/28C
     KATL 26L/26R + 27L/27R + 8L/8R + 9L/9R
     KDFW 17C/17R/18L/18R + 13L/13R
     KLAX 25L/25R + 24L/24R
     KBOS 4L/4R + 22L/22R + 27 + 33L
     KSFO 28L/28R + 1L/1R (SOIA)
     KMSP 12L/12R + 30L/30R
     KCLT 18L/18C/18R + 36L/36C/36R
     KPHL 9L/9R + 27L/27R
     KDTW 4L/4R + 22L/22R + 21L/21R
     KSLC 16L/16R + 34L/34R
     KMEM 9/27 + 18L/18R/18C
     KIAH 8L/8R + 26L/26R
     KMCO 17L/17R + 18L/18R
     KSEA 16L/16R + 34L/34R
     CYYZ 5/23 + 6L/6R + 33L/33R (Toronto LAHSO)

   Per-runway pair: published LAHSO distance (ft from threshold
   to hold-short point at the intersecting runway/taxiway), RCAM
   surface state (DRY/WET/CONT), crossing-runway ID and active
   traffic stream rate, magnetic alignment.

   Per-aircraft category A-E + class catalogue (HVY-Q HVY NRW
   RGN BIZ TBP) maps to landing-distance required (LDR) at Vref
   under:
     · DRY (FAR 91.605(b) / 121.195(b) factored 0.6)
     · WET (factored 1.15 × DRY per AC 91-79B)
     · CONT (factored 1.5 × DRY per AC 91-79B App 3)
   plus per-airframe stable bias for braking action (GOOD/MED/POOR
   per AC 25-32 RCAM Table 1).

   Phase classifier: ARR (RAlt ≤ 2500 & on approach corridor of
   LAHSO runway) / NEAR (RAlt ≤ 5000 within 8 nm of airport) /
   APP / OTHER.

   5 risk drivers (max-driver composite):
     ALD  ALD − LDR margin in ft  (0 at +1500, 100 at -300)
     SUR  RCAM surface state vs braking-action
          (DRY-GOOD 0 / WET-MED 45 / CONT-POOR 95)
     XTR  intersecting-runway traffic conflict probability
          (idle 0 / single arrival 35 / departure on roll 80
          / takeoff < 30 s 95)
     CAT  aircraft category-vs-runway-eligibility mismatch
          (cat-A/B on 5500 ft runway 0 / cat-D/E on 6500 ft 90)
     APP  approach stability proxy (Vref+10 0 / Vref+25 80)

   Phase multiplier: ARR 1.40 / NEAR 1.10 / APP 1.00 / OTHER 0.80

   Hard escalations:
     ALD margin ≤ 0 ft on approach ≥ 92  ATL1086 tier
     XTR conflict with takeoff on roll ≥ 90  USAIR1493 tier
     CONT surface with cat-D ≥ 85

   5 tiers:
     REJECT-LAHSO score≥80 rose · accept long landing, decline
       LAHSO via "UNABLE LAHSO" per AIM 4-3-11.b, go-around
       per QRH at decision-bar, file MOR
     CAUTION-LAHSO score≥55 amber · brief crew on RCAM braking,
       set autobrake MAX, plan early turnoff
     WATCH score≥25 sky · margin adequate but trend adverse,
       monitor surface report (M1/M5/M6 PIREP), brief intersection
     OK score<25 emerald · LAHSO accepted per AC 91-73 with
       adequate margin
     IDLE slate · not in arrival corridor of any LAHSO runway

   MapLibre overlay:
     · tier-coloured halo rings 8-22 px by score
     · rose diamond REJECT-LAHSO pin
     · tier-coloured callsign + ALD-margin-ft + RWY labels
     · 16 LAHSO airport pins coloured by surface-class-share
     · per-pair dashed extended centreline 4 nm tier-coloured
       for non-OK arrivals
     · 16-segment dashed forward-projection 4 nm tier-coloured
       for REJECT-LAHSO
     · sky reference parallels at lat ±60/±30/0 every 12° lng

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-ALD-margin-ft / WORST callsign / REJECT-count
     · 3-cell WET-share / CONT-share / XTR-conflict-count
     · SVG ALD-margin-ft vs LDR-ft scatter with rose <0 ft band,
       amber 0-500 ft band, sky 500-1500 band, emerald >1500
       + dashed y=x diagonal + dose limits
     · 6 sliders MIN-FL / SURF-STATE / TRAFFIC-MUL / VREF-NOISE
       / LDR-MUL / PHASE-WT
     · 4-category chip filter A B C D E
     · HALO PIN LBL XLINE PROJ AIRP REF DIAG toggles
     · search callsign / airport / runway
     · AIRCRAFT / AIRPORTS / RUNWAYS tabs

   References: FAA Order JO 7110.118 LAHSO / AC 91-73 LAHSO ·
   AC 91-79B Runway Overrun Prevention App 3 / AC 25-32 LDPM ·
   AC 150/5320-12C Friction / AC 150/5300-13A Airport Geometric
   Design · AIM 4-3-11 / 5-4-7 Cat A-E / 7-1-5 PIREP braking ·
   14 CFR 91.605 / 121.195(b) factored landing distance ·
   ICAO Annex 14 ch 3 LDA · Doc 9157 Pt 2 Aerodrome Design ·
   Doc 4444 7.5.4 simultaneous landings · NTSB AAB-95/01 USAir
   1493 LAX SkyWest collision intersection / AAR-08/03 Comair 5191
   LEX wrong-runway / AAR-15/01 SWA 1248 MDW overrun · TSB A05H0002
   AF358 YYZ overrun · ICAO Doc 9981 Annex 6 III RTOL · ARINC 424
   path-terminators · Boeing FCOM PI ch 6 landing data / Airbus
   FCOM PER-LDG-ULD · Jeppesen 10-9P LAHSO chart conventions.
   ft-lahso persisted preference.
   ============================================================ */

export interface LahsoFlight {
  icao: string
  callsign: string
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
  flights: LahsoFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'REJECT-LAHSO' | 'CAUTION-LAHSO' | 'WATCH' | 'OK' | 'IDLE'
type Driver = 'ALD' | 'SUR' | 'XTR' | 'CAT' | 'APP'
type ClassKey = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
type AcCat = 'A' | 'B' | 'C' | 'D' | 'E'
type Surface = 'DRY' | 'WET' | 'CONT'

const TIER_COLOR: Record<Tier, string> = {
  'REJECT-LAHSO': '#f43f5e',
  'CAUTION-LAHSO': '#f59e0b',
  WATCH: '#0ea5e9',
  OK: '#10b981',
  IDLE: '#475569',
}
const TIER_ORDER: Tier[] = ['REJECT-LAHSO', 'CAUTION-LAHSO', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { 'REJECT-LAHSO': 0, 'CAUTION-LAHSO': 1, WATCH: 2, OK: 3, IDLE: 4 }

const SURF_COLOR: Record<Surface, string> = { DRY: '#10b981', WET: '#0ea5e9', CONT: '#f43f5e' }

interface ClassSpec { family: string; cat: AcCat; vref: number; ldrDry: number /* ft */; descentFpm: number }
const CLASS_SPEC: Record<ClassKey, ClassSpec> = {
  'HVY-Q': { family: '747-8 / A380',  cat: 'E', vref: 152, ldrDry: 7400, descentFpm: 650 },
  'HVY':   { family: '777 / 787 / A350', cat: 'D', vref: 145, ldrDry: 6200, descentFpm: 650 },
  'NRW':   { family: '737 / A320 / 757', cat: 'C', vref: 138, ldrDry: 4800, descentFpm: 700 },
  'RGN':   { family: 'CRJ / E-Jet',   cat: 'C', vref: 132, ldrDry: 4200, descentFpm: 700 },
  'BIZ':   { family: 'GLF / FA7X',    cat: 'B', vref: 118, ldrDry: 3300, descentFpm: 650 },
  'TBP':   { family: 'ATR / Q400',    cat: 'B', vref: 110, ldrDry: 2800, descentFpm: 600 },
}

interface LahsoPair {
  rwy: string         // landing runway
  hdg: number         // magnetic alignment deg
  ald: number         // available landing distance to hold-short point (ft)
  cross: string       // intersecting runway / taxiway
  trafficRate: number // arrivals+departures/hr on intersecting rwy
}
interface LahsoAirport {
  icao: string; name: string; lat: number; lng: number; surface: Surface; pairs: LahsoPair[]
}
const AIRPORTS: LahsoAirport[] = [
  { icao: 'KORD', name: "Chicago O'Hare", lat: 41.978, lng: -87.904, surface: 'DRY', pairs: [
    { rwy: '10L', hdg:  98, ald: 7500, cross: '4L',  trafficRate: 60 },
    { rwy: '10C', hdg:  98, ald: 7000, cross: '22R', trafficRate: 50 },
    { rwy: '27L', hdg: 278, ald: 6700, cross: '4L',  trafficRate: 55 },
    { rwy: '28C', hdg: 278, ald: 6500, cross: '22R', trafficRate: 50 },
  ]},
  { icao: 'KATL', name: 'Atlanta Hartsfield', lat: 33.640, lng: -84.428, surface: 'DRY', pairs: [
    { rwy: '26L', hdg: 264, ald: 8500, cross: '27R', trafficRate: 70 },
    { rwy: '27L', hdg: 264, ald: 7600, cross: '26R', trafficRate: 65 },
    { rwy: '8L',  hdg:  84, ald: 8500, cross: '9R',  trafficRate: 70 },
  ]},
  { icao: 'KDFW', name: 'Dallas/Fort Worth', lat: 32.897, lng: -97.038, surface: 'DRY', pairs: [
    { rwy: '17C', hdg: 174, ald: 7500, cross: '13R', trafficRate: 45 },
    { rwy: '18L', hdg: 184, ald: 8500, cross: '13L', trafficRate: 40 },
    { rwy: '17R', hdg: 174, ald: 7000, cross: '13L', trafficRate: 35 },
  ]},
  { icao: 'KLAX', name: 'Los Angeles', lat: 33.943, lng: -118.408, surface: 'DRY', pairs: [
    { rwy: '25L', hdg: 256, ald: 8500, cross: '24R', trafficRate: 65 },
    { rwy: '24L', hdg: 248, ald: 7500, cross: '25R', trafficRate: 60 },
  ]},
  { icao: 'KBOS', name: 'Boston Logan', lat: 42.363, lng: -71.006, surface: 'WET', pairs: [
    { rwy: '4L',  hdg:  44, ald: 6500, cross: '9',   trafficRate: 40 },
    { rwy: '22L', hdg: 224, ald: 6200, cross: '27',  trafficRate: 35 },
    { rwy: '33L', hdg: 334, ald: 5800, cross: '27',  trafficRate: 30 },
  ]},
  { icao: 'KSFO', name: 'San Francisco', lat: 37.619, lng: -122.375, surface: 'WET', pairs: [
    { rwy: '28L', hdg: 284, ald: 7500, cross: '1L',  trafficRate: 25 },
    { rwy: '28R', hdg: 284, ald: 8200, cross: '1R',  trafficRate: 30 },
  ]},
  { icao: 'KMSP', name: 'Minneapolis-St Paul', lat: 44.882, lng: -93.222, surface: 'CONT', pairs: [
    { rwy: '12L', hdg: 124, ald: 6500, cross: '30R', trafficRate: 35 },
    { rwy: '30L', hdg: 304, ald: 6500, cross: '12R', trafficRate: 30 },
  ]},
  { icao: 'KCLT', name: 'Charlotte-Douglas', lat: 35.214, lng: -80.943, surface: 'DRY', pairs: [
    { rwy: '18L', hdg: 184, ald: 6500, cross: '36C', trafficRate: 45 },
    { rwy: '36C', hdg:   4, ald: 7000, cross: '18R', trafficRate: 40 },
    { rwy: '18C', hdg: 184, ald: 6800, cross: '36L', trafficRate: 35 },
  ]},
  { icao: 'KPHL', name: 'Philadelphia', lat: 39.872, lng: -75.241, surface: 'WET', pairs: [
    { rwy: '9L',  hdg:  92, ald: 6300, cross: '27R', trafficRate: 30 },
    { rwy: '27R', hdg: 272, ald: 6200, cross: '9L',  trafficRate: 28 },
  ]},
  { icao: 'KDTW', name: 'Detroit Metro', lat: 42.212, lng: -83.353, surface: 'CONT', pairs: [
    { rwy: '4L',  hdg:  44, ald: 7500, cross: '21L', trafficRate: 30 },
    { rwy: '22L', hdg: 224, ald: 7000, cross: '21R', trafficRate: 28 },
  ]},
  { icao: 'KSLC', name: 'Salt Lake City', lat: 40.789, lng: -111.978, surface: 'DRY', pairs: [
    { rwy: '16L', hdg: 164, ald: 7800, cross: '34R', trafficRate: 25 },
    { rwy: '34L', hdg: 344, ald: 7500, cross: '16R', trafficRate: 25 },
  ]},
  { icao: 'KMEM', name: 'Memphis', lat: 35.043, lng: -89.977, surface: 'DRY', pairs: [
    { rwy: '9',   hdg:  92, ald: 6800, cross: '18C', trafficRate: 35 },
    { rwy: '18C', hdg: 184, ald: 7100, cross: '9',   trafficRate: 30 },
  ]},
  { icao: 'KIAH', name: 'Houston Intercontinental', lat: 29.984, lng: -95.341, surface: 'DRY', pairs: [
    { rwy: '8L',  hdg:  84, ald: 7500, cross: '26R', trafficRate: 35 },
    { rwy: '26R', hdg: 264, ald: 7500, cross: '8L',  trafficRate: 32 },
  ]},
  { icao: 'KMCO', name: 'Orlando', lat: 28.429, lng: -81.309, surface: 'WET', pairs: [
    { rwy: '17L', hdg: 174, ald: 6500, cross: '18R', trafficRate: 25 },
    { rwy: '18R', hdg: 184, ald: 6600, cross: '17L', trafficRate: 25 },
  ]},
  { icao: 'KSEA', name: 'Seattle-Tacoma', lat: 47.450, lng: -122.309, surface: 'WET', pairs: [
    { rwy: '16L', hdg: 164, ald: 7000, cross: '34R', trafficRate: 30 },
    { rwy: '34L', hdg: 344, ald: 7000, cross: '16R', trafficRate: 30 },
  ]},
  { icao: 'CYYZ', name: 'Toronto Pearson', lat: 43.677, lng: -79.631, surface: 'CONT', pairs: [
    { rwy: '5',   hdg:  52, ald: 6800, cross: '33L', trafficRate: 35 },
    { rwy: '6L',  hdg:  58, ald: 7100, cross: '33R', trafficRate: 32 },
    { rwy: '33L', hdg: 332, ald: 6500, cross: '6L',  trafficRate: 28 },
  ]},
]

const SRC_HALO = 'lahso-halo', LYR_HALO = 'lahso-halo-l'
const SRC_PIN  = 'lahso-pin',  LYR_PIN  = 'lahso-pin-l'
const SRC_LBL  = 'lahso-lbl',  LYR_LBL  = 'lahso-lbl-l'
const SRC_XLN  = 'lahso-xln',  LYR_XLN  = 'lahso-xln-l'
const SRC_PROJ = 'lahso-proj', LYR_PROJ = 'lahso-proj-l'
const SRC_AIRP = 'lahso-airp', LYR_AIRP = 'lahso-airp-l'
const SRC_ALBL = 'lahso-albl', LYR_ALBL = 'lahso-albl-l'
const SRC_REF  = 'lahso-ref',  LYR_REF  = 'lahso-ref-l'

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
const hu = (s: string, salt: string) => (fnv1a(s + ':' + salt) / 0xffffffff)

function classify(type?: string, category?: number | string): ClassKey {
  const t = (type || '').toUpperCase()
  if (/^(A380|A388|B748|B744|A340|A346)/.test(t)) return 'HVY-Q'
  if (/^(B77|B78|A350|A359|A35K|A330|A338|A339|A332|A333|MD11|B763|B764|B772|B773|B788|B789)/.test(t)) return 'HVY'
  if (/^(B73|A32|A31|A19|A20|A21|B75|B752|MD8|MD9)/.test(t)) return 'NRW'
  if (/^(CRJ|E1[79]|E2[19]|E29|E75|RJ85|RJ1H|F100)/.test(t)) return 'RGN'
  if (/^(GLF|GLEX|GL5T|GL7T|FA[0-9]|F2TH|F900|F7X|CL30|CL60|CL35|C25|C56|C68|H25|LJ)/.test(t)) return 'BIZ'
  if (/^(AT[47]|DH[8C]|SF34|J32|J41|B190|PC12|TBM|C208|BE[0-9])/.test(t)) return 'TBP'
  const cn = typeof category === 'string' ? parseInt(category, 10) : category
  if (cn === 5 || cn === 6) return 'HVY'
  if (cn === 4) return 'NRW'
  if (cn === 3) return 'RGN'
  if (cn === 2) return 'TBP'
  return 'NRW'
}

const toRad = (d: number) => (d * Math.PI) / 180
const toDeg = (r: number) => (r * 180) / Math.PI
function destPoint(lat: number, lng: number, brgDeg: number, distNm: number): [number, number] {
  const R = 3440.065
  const br = toRad(brgDeg)
  const d = distNm / R
  const phi1 = toRad(lat), lam1 = toRad(lng)
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(br))
  const lam2 = lam1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(phi1), Math.cos(d) - Math.sin(phi1) * Math.sin(phi2))
  return [(toDeg(lam2) + 540) % 360 - 180, toDeg(phi2)]
}
function distNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const p1 = toRad(lat1), p2 = toRad(lat2), dp = toRad(lat2 - lat1), dl = toRad(lng2 - lng1)
  const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}

interface Row {
  f: LahsoFlight
  classKey: ClassKey
  cat: AcCat
  airport?: LahsoAirport
  pair?: LahsoPair
  phase: 'ARR' | 'NEAR' | 'APP' | 'OTHER'
  fl: number
  surface: Surface
  brakeMu: number
  vrefAct: number
  ldr: number
  ald: number
  marginFt: number
  xConflict: number  // 0..1 probability
  sAld: number; sSur: number; sXtr: number; sCat: number; sApp: number
  score: number
  driver: Driver
  tier: Tier
}

interface Opts {
  surfBias: number    // -50..+50 shift toward wet/cont
  trafficMul: number  // 50..250
  vrefNoise: number   // 50..250
  ldrMul: number      // 50..250
  phaseW: number      // 50..150
  minFL: number
}

function phaseOf(f: LahsoFlight, ap?: LahsoAirport, pair?: LahsoPair): 'ARR' | 'NEAR' | 'APP' | 'OTHER' {
  if (!ap || !pair) return 'OTHER'
  const dnm = distNm(f.lat, f.lng, ap.lat, ap.lng)
  const ral = Math.max(0, f.altitudeFt - 0) // proxy ground elev = 0 / use altitude
  if (dnm < 5 && ral < 2500 && f.vertRate < 200) return 'ARR'
  if (dnm < 8 && ral < 5000) return 'NEAR'
  if (ral < 8000 && dnm < 25) return 'APP'
  return 'OTHER'
}
const PHASE_MUL = { ARR: 1.40, NEAR: 1.10, APP: 1.00, OTHER: 0.80 } as const

function pickAirport(f: LahsoFlight): { ap?: LahsoAirport; pair?: LahsoPair } {
  let bestAp: LahsoAirport | undefined; let bestPair: LahsoPair | undefined; let bestD = Infinity
  for (const ap of AIRPORTS) {
    const d = distNm(f.lat, f.lng, ap.lat, ap.lng)
    if (d > 30) continue
    // pick best-aligned pair to current track
    for (const p of ap.pairs) {
      const trk = f.track || 0
      let diff = Math.abs(((trk - p.hdg + 540) % 360) - 180)
      // landing alignment: track ≈ runway heading
      if (diff > 35) continue
      const score = d + diff * 0.05
      if (score < bestD) { bestD = score; bestAp = ap; bestPair = p }
    }
  }
  return { ap: bestAp, pair: bestPair }
}

function brakeMuFor(surf: Surface, u: number): number {
  // RCAM mu: DRY ≈ 0.40-0.50 / WET ≈ 0.25-0.40 / CONT ≈ 0.05-0.25
  if (surf === 'DRY')  return 0.40 + u * 0.10
  if (surf === 'WET')  return 0.25 + u * 0.15
  return 0.05 + u * 0.20
}

function ldrFor(spec: ClassSpec, surf: Surface, mu: number, vrefAct: number, ldrMul: number): number {
  // LDR ≈ baseline × (vref/vrefNom)^2 × surface-factor × (0.40/mu)
  const speedFac = (vrefAct / spec.vref) ** 2
  const surfFac = surf === 'DRY' ? 1.0 : surf === 'WET' ? 1.15 : 1.5
  const muFac = 0.40 / Math.max(0.10, mu)
  // FAR 121.195(b) factor: dispatch must use 60% rule on dry, 70% rule wet → apply for ALD comparison
  const factor = surf === 'DRY' ? 1.0 / 0.6 : 1.0 / 0.7
  return spec.ldrDry * speedFac * surfFac * muFac * factor * (ldrMul / 100)
}

function compute(f: LahsoFlight, opts: Opts): Row {
  const classKey = classify(f.type, f.category)
  const spec = CLASS_SPEC[classKey]
  const { ap, pair } = pickAirport(f)
  const phase = phaseOf(f, ap, pair)
  const fl = f.altitudeFt / 100

  // Surface bias: shift base airport surface toward WET/CONT under slider
  let surface: Surface = ap?.surface || 'DRY'
  const u1 = hu(f.icao, 'surf')
  const shift = (u1 + opts.surfBias / 100) // 0..1.5
  if (surface === 'DRY' && shift > 0.85) surface = 'WET'
  if (surface === 'WET' && shift > 0.85) surface = 'CONT'
  const u2 = hu(f.icao, 'mu')
  const mu = brakeMuFor(surface, u2)
  const u3 = hu(f.icao, 'vref')
  const vrefAct = spec.vref + (u3 - 0.5) * 14 * (opts.vrefNoise / 100)
  const ldr = pair ? ldrFor(spec, surface, mu, vrefAct, opts.ldrMul) : 0
  const ald = pair?.ald || 0
  const marginFt = ald - ldr

  // intersecting-traffic conflict
  const u4 = hu(f.icao, 'xtr')
  const baseRate = pair ? pair.trafficRate / 60 : 0 // per minute
  const xConflict = Math.min(0.98, baseRate * (opts.trafficMul / 100) * (0.4 + u4 * 1.2))

  // === scores ===
  // ALD margin: 0 at +1500, 25 at +750, 55 at +300, 80 at 0, 100 at -300
  const sAld = !pair ? 0 :
    marginFt >= 1500 ? 0 :
    marginFt >= 750 ? 25 :
    marginFt >= 300 ? 55 :
    marginFt >= 0   ? 80 :
    marginFt >= -300 ? 92 : 100

  // surface
  const sSur = surface === 'DRY' ? (mu < 0.42 ? 10 : 0) :
               surface === 'WET' ? (mu < 0.32 ? 55 : 30) :
                                   (mu < 0.15 ? 95 : 75)

  // intersecting traffic conflict
  const sXtr = Math.round(xConflict * 100)

  // category vs runway eligibility: cat D/E heavy on shorter LAHSO runway
  let sCat = 0
  if (pair) {
    if ((spec.cat === 'D' || spec.cat === 'E') && pair.ald < 7000) sCat = 70
    else if (spec.cat === 'E' && pair.ald < 7500) sCat = 88
    else if (spec.cat === 'C' && pair.ald < 5500) sCat = 50
  }

  // approach stability proxy via vref noise (high = fast approach)
  const overspeed = vrefAct - spec.vref
  const sApp = overspeed <= 5 ? 0 : overspeed <= 12 ? 30 : overspeed <= 18 ? 55 : 80

  const drivers: Array<[Driver, number]> = [['ALD', sAld], ['SUR', sSur], ['XTR', sXtr], ['CAT', sCat], ['APP', sApp]]
  drivers.sort((a, b) => b[1] - a[1])
  let raw = drivers[0][1]
  // secondary contribution
  raw = Math.min(100, raw + 0.10 * drivers[1][1])

  // hard escalations
  if (pair && marginFt <= 0 && (phase === 'ARR')) raw = Math.max(raw, 92)
  if (xConflict > 0.85 && (phase === 'ARR' || phase === 'NEAR')) raw = Math.max(raw, 90)
  if (surface === 'CONT' && (spec.cat === 'D' || spec.cat === 'E') && phase !== 'OTHER') raw = Math.max(raw, 85)

  const score = Math.round(Math.min(100, raw * (phase === 'OTHER' ? 0.5 : (PHASE_MUL[phase] * opts.phaseW / 100))))

  let tier: Tier = 'IDLE'
  if (phase === 'OTHER' || !pair || fl > opts.minFL / 100 + 50) tier = 'IDLE'
  else if (score >= 80) tier = 'REJECT-LAHSO'
  else if (score >= 55) tier = 'CAUTION-LAHSO'
  else if (score >= 25) tier = 'WATCH'
  else tier = 'OK'

  return {
    f, classKey, cat: spec.cat, airport: ap, pair, phase, fl,
    surface, brakeMu: mu, vrefAct, ldr, ald, marginFt, xConflict,
    sAld, sSur, sXtr, sCat, sApp, score, driver: drivers[0][0], tier,
  }
}

function ensureLayer(map: maplibregl.Map, id: string, src: string, spec: maplibregl.LayerSpecification) {
  if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
  if (!map.getLayer(id)) map.addLayer(spec as any)
}
function setData(map: maplibregl.Map, src: string, fc: any) {
  const s = map.getSource(src) as any
  if (s && s.setData) s.setData(fc)
}
function removeLayers(map: maplibregl.Map, ids: string[], srcs: string[]) {
  ids.forEach(id => { if (map.getLayer(id)) map.removeLayer(id) })
  srcs.forEach(s => { if (map.getSource(s)) map.removeSource(s) })
}

export default function LahsoMonitor({ map, flights, onClose, onFly }: Props) {
  const [surfBias, setSurfBias] = useState(0)
  const [trafficMul, setTrafficMul] = useState(100)
  const [vrefNoise, setVrefNoise] = useState(100)
  const [ldrMul, setLdrMul] = useState(100)
  const [phaseW, setPhaseW] = useState(100)
  const [minFL, setMinFL] = useState(0)

  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showXline, setShowXline] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showAirp, setShowAirp] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)

  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [catFilter, setCatFilter] = useState<AcCat | 'ALL'>('ALL')
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'AC' | 'AIRP' | 'RWY'>('AC')

  const opts: Opts = { surfBias, trafficMul, vrefNoise, ldrMul, phaseW, minFL }

  const rows = useMemo(() => {
    return flights
      .filter(f => !f.ground && f.altitudeFt > 0)
      .map(f => compute(f, opts))
      .filter(r => r.phase !== 'OTHER')
      .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [flights, surfBias, trafficMul, vrefNoise, ldrMul, phaseW, minFL])

  const filteredRows = useMemo(() => {
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (catFilter !== 'ALL' && r.cat !== catFilter) return false
      if (query) {
        const q = query.toLowerCase()
        if (!(r.f.callsign?.toLowerCase().includes(q) || r.f.icao.toLowerCase().includes(q)
          || (r.f.type || '').toLowerCase().includes(q) || (r.airport?.icao || '').toLowerCase().includes(q)
          || (r.pair?.rwy || '').toLowerCase().includes(q))) return false
      }
      return true
    })
  }, [rows, tierFilter, catFilter, query])

  const tierCount = useMemo(() => {
    const c: Record<Tier, number> = { 'REJECT-LAHSO': 0, 'CAUTION-LAHSO': 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const worst = rows[0]
  const meanMargin = rows.length ? rows.reduce((s, r) => s + r.marginFt, 0) / rows.length : 0
  const wetShare = rows.length ? rows.filter(r => r.surface === 'WET').length / rows.length : 0
  const contShare = rows.length ? rows.filter(r => r.surface === 'CONT').length / rows.length : 0
  const xtrConflicts = rows.filter(r => r.xConflict > 0.6).length

  // Airport aggregation
  const airportAgg = useMemo(() => {
    const m = new Map<string, { ap: LahsoAirport; n: number; reject: number; meanMargin: number; sumMargin: number }>()
    for (const r of rows) {
      if (!r.airport) continue
      const k = r.airport.icao
      const cur = m.get(k) || { ap: r.airport, n: 0, reject: 0, meanMargin: 0, sumMargin: 0 }
      cur.n++
      if (r.tier === 'REJECT-LAHSO') cur.reject++
      cur.sumMargin += r.marginFt
      m.set(k, cur)
    }
    for (const v of m.values()) v.meanMargin = v.sumMargin / Math.max(1, v.n)
    return Array.from(m.values()).sort((a, b) => b.reject - a.reject || b.n - a.n)
  }, [rows])

  const runwayAgg = useMemo(() => {
    const m = new Map<string, { ap: LahsoAirport; pair: LahsoPair; n: number; reject: number; meanMargin: number; sumMargin: number }>()
    for (const r of rows) {
      if (!r.airport || !r.pair) continue
      const k = r.airport.icao + ':' + r.pair.rwy
      const cur = m.get(k) || { ap: r.airport, pair: r.pair, n: 0, reject: 0, meanMargin: 0, sumMargin: 0 }
      cur.n++
      if (r.tier === 'REJECT-LAHSO') cur.reject++
      cur.sumMargin += r.marginFt
      m.set(k, cur)
    }
    for (const v of m.values()) v.meanMargin = v.sumMargin / Math.max(1, v.n)
    return Array.from(m.values()).sort((a, b) => b.reject - a.reject || a.meanMargin - b.meanMargin)
  }, [rows])

  // === Map overlay ===
  useEffect(() => {
    if (!map) return
    const ids = [LYR_HALO, LYR_PIN, LYR_LBL, LYR_XLN, LYR_PROJ, LYR_AIRP, LYR_ALBL, LYR_REF]
    const srcs = [SRC_HALO, SRC_PIN, SRC_LBL, SRC_XLN, SRC_PROJ, SRC_AIRP, SRC_ALBL, SRC_REF]

    ensureLayer(map, LYR_HALO, SRC_HALO, { id: LYR_HALO, type: 'circle', source: SRC_HALO,
      paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'c'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'c'], 'circle-stroke-opacity': 0.55, 'circle-stroke-width': 1.2 } })
    ensureLayer(map, LYR_PIN, SRC_PIN, { id: LYR_PIN, type: 'symbol', source: SRC_PIN,
      layout: { 'text-field': '◆', 'text-size': 14, 'text-allow-overlap': true }, paint: { 'text-color': '#f43f5e' } })
    ensureLayer(map, LYR_LBL, SRC_LBL, { id: LYR_LBL, type: 'symbol', source: SRC_LBL,
      layout: { 'text-field': ['get', 't'], 'text-size': 10, 'text-offset': [0, 1.3], 'text-allow-overlap': true, 'text-anchor': 'top' },
      paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    ensureLayer(map, LYR_XLN, SRC_XLN, { id: LYR_XLN, type: 'line', source: SRC_XLN,
      paint: { 'line-color': ['get', 'c'], 'line-width': 1.4, 'line-dasharray': [3, 3], 'line-opacity': 0.7 } })
    ensureLayer(map, LYR_PROJ, SRC_PROJ, { id: LYR_PROJ, type: 'line', source: SRC_PROJ,
      paint: { 'line-color': ['get', 'c'], 'line-width': 1.3, 'line-dasharray': [2, 3], 'line-opacity': 0.65 } })
    ensureLayer(map, LYR_AIRP, SRC_AIRP, { id: LYR_AIRP, type: 'circle', source: SRC_AIRP,
      paint: { 'circle-radius': 5, 'circle-color': ['get', 'c'], 'circle-stroke-color': '#e2e8f0', 'circle-stroke-width': 1, 'circle-opacity': 0.85 } })
    ensureLayer(map, LYR_ALBL, SRC_ALBL, { id: LYR_ALBL, type: 'symbol', source: SRC_ALBL,
      layout: { 'text-field': ['get', 't'], 'text-size': 9, 'text-offset': [0, -1.4], 'text-allow-overlap': true, 'text-anchor': 'bottom' },
      paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.1 } })
    ensureLayer(map, LYR_REF, SRC_REF, { id: LYR_REF, type: 'line', source: SRC_REF,
      paint: { 'line-color': '#0ea5e9', 'line-width': 0.5, 'line-dasharray': [2, 4], 'line-opacity': 0.25 } })

    const haloFt: any[] = []
    const pinFt: any[] = []
    const lblFt: any[] = []
    const xlnFt: any[] = []
    const projFt: any[] = []
    const airpFt: any[] = []
    const albFt: any[] = []
    const refFt: any[] = []

    if (showAirp) {
      for (const ap of AIRPORTS) {
        airpFt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [ap.lng, ap.lat] }, properties: { c: SURF_COLOR[ap.surface] } })
        albFt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [ap.lng, ap.lat] }, properties: { t: `${ap.icao} · ${ap.surface}`, c: '#cbd5e1' } })
      }
    }

    if (showRef) {
      const lats = [-60, -30, 0, 30, 60]
      for (const la of lats) {
        const coords: number[][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, la])
        refFt.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }

    for (const r of filteredRows) {
      if (r.tier === 'IDLE') continue
      const col = TIER_COLOR[r.tier]
      const radius = 8 + (r.score / 100) * 14
      if (showHalo) haloFt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { c: col, r: radius } })
      if (showPin && r.tier === 'REJECT-LAHSO') pinFt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      if (showLabels) {
        const sign = r.marginFt >= 0 ? '+' : ''
        const t = `${r.f.callsign || r.f.icao} · ${r.pair?.rwy || '?'} ${sign}${Math.round(r.marginFt)}ft`
        lblFt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { t, c: col } })
      }
      // dashed extended centreline to LAHSO airport along approach heading
      if (showXline && r.airport && r.pair && r.tier !== 'OK') {
        const back = (r.pair.hdg + 180) % 360
        const [lng2, lat2] = destPoint(r.airport.lat, r.airport.lng, back, 4)
        xlnFt.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.airport.lng, r.airport.lat], [lng2, lat2]] }, properties: { c: col } })
      }
      // forward projection 4 nm for REJECT
      if (showProj && r.tier === 'REJECT-LAHSO') {
        const coords: number[][] = []
        for (let i = 0; i <= 16; i++) {
          const [lng2, lat2] = destPoint(r.f.lat, r.f.lng, r.f.track || 0, (i / 16) * 4)
          coords.push([lng2, lat2])
        }
        projFt.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { c: col } })
      }
    }

    setData(map, SRC_HALO, { type: 'FeatureCollection', features: haloFt })
    setData(map, SRC_PIN, { type: 'FeatureCollection', features: pinFt })
    setData(map, SRC_LBL, { type: 'FeatureCollection', features: lblFt })
    setData(map, SRC_XLN, { type: 'FeatureCollection', features: xlnFt })
    setData(map, SRC_PROJ, { type: 'FeatureCollection', features: projFt })
    setData(map, SRC_AIRP, { type: 'FeatureCollection', features: airpFt })
    setData(map, SRC_ALBL, { type: 'FeatureCollection', features: albFt })
    setData(map, SRC_REF, { type: 'FeatureCollection', features: refFt })

    return () => { removeLayers(map, ids, srcs) }
  }, [map, filteredRows, showHalo, showPin, showLabels, showXline, showProj, showAirp, showRef])

  // === Diagnostic scatter ===
  const W = 280, H = 180
  const xMax = 12000, yMax = 12000 // ft
  const sx = (v: number) => 30 + (Math.max(0, Math.min(xMax, v)) / xMax) * (W - 40)
  const sy = (v: number) => (H - 24) - (Math.max(0, Math.min(yMax, v)) / yMax) * (H - 48)

  const advice = (r: Row): string => {
    if (r.tier === 'REJECT-LAHSO') {
      if (r.driver === 'ALD') return `ALD ${r.ald} ft − LDR ${Math.round(r.ldr)} ft margin ${Math.round(r.marginFt)} ft inadequate — decline "UNABLE LAHSO" per AIM 4-3-11.b, request full-length per FAA Order JO 7110.118`
      if (r.driver === 'SUR') return `${r.surface} surface μ ${r.brakeMu.toFixed(2)} below LAHSO-eligible braking per AC 25-32 RCAM — refuse LAHSO, request PIREP M5/M6 per AIM 7-1-5`
      if (r.driver === 'XTR') return `Intersecting ${r.pair?.cross} runway has takeoff/arrival conflict P=${(r.xConflict*100).toFixed(0)}% — refuse LAHSO per AC 91-73 §6, prevent USAir 1493 LAX-class collision`
      if (r.driver === 'CAT') return `Cat-${r.cat} airframe on ${r.ald}-ft LAHSO runway not authorised per AIM 4-3-11.a — request full-length runway`
      return `REJECT-LAHSO — decline LAHSO clearance, accept long landing, go-around at decision-bar if uncertain per Boeing FCOM PI 6`
    }
    if (r.tier === 'CAUTION-LAHSO') return `Margin ${Math.round(r.marginFt)} ft on ${r.surface} surface μ ${r.brakeMu.toFixed(2)} — autobrake MAX, plan early turnoff, brief intersecting ${r.pair?.cross} per AC 91-73`
    if (r.tier === 'WATCH') return `LAHSO acceptable but monitor surface report and intersecting traffic on ${r.pair?.cross} per AIM 7-1-5 PIREP`
    if (r.tier === 'OK') return `LAHSO accepted — adequate margin ${Math.round(r.marginFt)} ft, ${r.surface} μ ${r.brakeMu.toFixed(2)} per AC 91-73`
    return 'Not in LAHSO arrival corridor — IDLE'
  }

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">LAHSO · Land-And-Hold-Short</div>
          <div className="text-[10px] text-slate-500">FAA Order JO 7110.118 · AC 91-73 · AIM 4-3-11 · 16 airports · 42 runway pairs</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className="rounded px-1 py-1 text-center"
            style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[9px] font-semibold" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean margin</div>
          <div className="text-sm font-semibold" style={{ color: meanMargin > 1500 ? '#10b981' : meanMargin > 500 ? '#0ea5e9' : meanMargin > 0 ? '#f59e0b' : '#f43f5e' }}>{Math.round(meanMargin)} ft</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Reject</div>
          <div className="text-sm font-semibold" style={{ color: tierCount['REJECT-LAHSO'] > 0 ? '#f43f5e' : '#10b981' }}>{tierCount['REJECT-LAHSO']}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Wet share</div>
          <div className="text-xs font-semibold" style={{ color: wetShare > 0.4 ? '#f59e0b' : '#10b981' }}>{(wetShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Cont share</div>
          <div className="text-xs font-semibold" style={{ color: contShare > 0.2 ? '#f43f5e' : '#10b981' }}>{(contShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">X-conflict</div>
          <div className="text-xs font-semibold" style={{ color: xtrConflicts > 0 ? '#f43f5e' : '#10b981' }}>{xtrConflicts}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W - 40} height={H - 48} fill="#0b1220" />
            {/* y=x diagonal (LDR == ALD threshold) */}
            <line x1={sx(0)} y1={sy(0)} x2={sx(yMax)} y2={sy(yMax)} stroke="#f43f5e" strokeDasharray="3 3" strokeOpacity={0.55} />
            {/* y = x - 500, x - 1500 amber/sky bands */}
            <line x1={sx(500)} y1={sy(0)} x2={sx(yMax)} y2={sy(yMax - 500)} stroke="#f59e0b" strokeDasharray="2 3" strokeOpacity={0.45} />
            <line x1={sx(1500)} y1={sy(0)} x2={sx(yMax)} y2={sy(yMax - 1500)} stroke="#10b981" strokeDasharray="2 4" strokeOpacity={0.45} />
            {[0, 3000, 6000, 9000, 12000].map(t => (
              <text key={`x${t}`} x={sx(t) - 8} y={H - 8} fontSize={8} fill="#64748b">{t/1000}k</text>
            ))}
            {[0, 3000, 6000, 9000, 12000].map(t => (
              <text key={`y${t}`} x={4} y={sy(t) + 3} fontSize={8} fill="#64748b">{t/1000}k</text>
            ))}
            {rows.filter(r => r.tier !== 'IDLE' && r.pair).map((r, i) => (
              <circle key={i} cx={sx(r.ald)} cy={sy(r.ldr)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
            <text x={W / 2} y={H - 6} fontSize={9} fill="#64748b" textAnchor="middle">ALD (ft) × LDR (ft) · below y=x = OK</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFL}</span><input type="range" min={0} max={400} value={minFL} onChange={e => setMinFL(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">SURF-BIAS {surfBias > 0 ? '+' : ''}{surfBias}%</span><input type="range" min={-50} max={50} value={surfBias} onChange={e => setSurfBias(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">TRAFFIC-MUL {trafficMul}%</span><input type="range" min={50} max={250} value={trafficMul} onChange={e => setTrafficMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">VREF-NOISE {vrefNoise}%</span><input type="range" min={50} max={250} value={vrefNoise} onChange={e => setVrefNoise(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">LDR-MUL {ldrMul}%</span><input type="range" min={50} max={250} value={ldrMul} onChange={e => setLdrMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PHASE-WT {phaseW}%</span><input type="range" min={50} max={150} value={phaseW} onChange={e => setPhaseW(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setCatFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${catFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {(['A', 'B', 'C', 'D', 'E'] as AcCat[]).map(c => (
          <button key={c} onClick={() => setCatFilter(catFilter === c ? 'ALL' : c)} className={`px-2 py-0.5 rounded text-[10px] border ${catFilter === c ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{c}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['XLINE', showXline, setShowXline], ['PROJ', showProj, setShowProj], ['AIRP', showAirp, setShowAirp], ['REF', showRef, setShowRef], ['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / airport / rwy" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex gap-1 px-3 py-2 border-b border-slate-800">
        {(['AC', 'AIRP', 'RWY'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[10px] border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>
            {t === 'AC' ? 'Aircraft' : t === 'AIRP' ? 'Airports' : 'Runways'}
          </button>
        ))}
      </div>

      {tab === 'AC' && (
        <div className="px-2 py-2 space-y-1">
          {filteredRows.slice(0, 50).map(r => (
            <div key={r.f.icao} onClick={() => onFly(r.f.icao)} className="cursor-pointer rounded border border-slate-800 bg-slate-900/50 hover:bg-slate-800/60 p-2"
              style={{ borderLeft: '3px solid ' + TIER_COLOR[r.tier] }}>
              <div className="flex items-center gap-1 text-[10px]">
                <span className="font-semibold text-slate-100 truncate flex-1">{r.f.callsign || r.f.icao}</span>
                <span className="text-slate-500 truncate">{r.f.type}</span>
                <span className="px-1 rounded bg-slate-800 text-slate-300">{r.classKey}</span>
                <span className="px-1 rounded" style={{ backgroundColor: '#0ea5e933', color: '#7dd3fc' }}>cat-{r.cat}</span>
                <span className="px-1 rounded" style={{ backgroundColor: SURF_COLOR[r.surface] + '33', color: SURF_COLOR[r.surface] }}>{r.surface}</span>
                <span className="px-1 rounded" style={{ backgroundColor: TIER_COLOR[r.tier] + '33', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-1">
                {r.airport?.icao} RWY {r.pair?.rwy}/{r.pair?.cross} · ALD {r.ald} ft · LDR {Math.round(r.ldr)} ft · margin <span style={{ color: r.marginFt < 0 ? '#f43f5e' : r.marginFt < 500 ? '#f59e0b' : '#10b981' }}>{r.marginFt >= 0 ? '+' : ''}{Math.round(r.marginFt)} ft</span> · μ {r.brakeMu.toFixed(2)} · Vref {Math.round(r.vrefAct)} kt · X-conf {(r.xConflict*100).toFixed(0)}%
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} />
              </div>
              <div className="flex gap-1 mt-1 text-[9px]">
                {(['ALD', 'SUR', 'XTR', 'CAT', 'APP'] as Driver[]).map(d => {
                  const v = d === 'ALD' ? r.sAld : d === 'SUR' ? r.sSur : d === 'XTR' ? r.sXtr : d === 'CAT' ? r.sCat : r.sApp
                  const col = v >= 80 ? '#f43f5e' : v >= 55 ? '#f59e0b' : v >= 25 ? '#0ea5e9' : '#10b981'
                  return <span key={d} className="px-1 rounded" style={{ backgroundColor: col + '22', color: col, border: '1px solid ' + col + '44' }}>{d} {v}</span>
                })}
              </div>
              <div className="mt-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>{advice(r)}</div>
            </div>
          ))}
          {filteredRows.length === 0 && <div className="text-center text-slate-500 py-4 text-[11px]">No arrivals in LAHSO corridor</div>}
        </div>
      )}

      {tab === 'AIRP' && (
        <div className="px-2 py-2 space-y-1">
          {airportAgg.map(a => (
            <div key={a.ap.icao} className="rounded border border-slate-800 bg-slate-900/50 p-2" style={{ borderLeft: '3px solid ' + SURF_COLOR[a.ap.surface] }}>
              <div className="flex items-center gap-1 text-[10px]">
                <span className="font-semibold text-slate-100 truncate flex-1">{a.ap.icao} · {a.ap.name}</span>
                <span className="px-1 rounded" style={{ backgroundColor: SURF_COLOR[a.ap.surface] + '33', color: SURF_COLOR[a.ap.surface] }}>{a.ap.surface}</span>
                <span className="px-1 rounded bg-slate-800 text-slate-300">{a.ap.pairs.length} pairs</span>
                {a.reject > 0 && <span className="px-1 rounded" style={{ backgroundColor: '#f43f5e33', color: '#fda4af' }}>REJ {a.reject}</span>}
              </div>
              <div className="text-[10px] text-slate-400 mt-1">arrivals {a.n} · mean margin <span style={{ color: a.meanMargin > 1000 ? '#10b981' : a.meanMargin > 0 ? '#f59e0b' : '#f43f5e' }}>{Math.round(a.meanMargin)} ft</span></div>
            </div>
          ))}
          {airportAgg.length === 0 && <div className="text-center text-slate-500 py-4 text-[11px]">No active LAHSO airports</div>}
        </div>
      )}

      {tab === 'RWY' && (
        <div className="px-2 py-2 space-y-1">
          {runwayAgg.slice(0, 50).map((r, i) => (
            <div key={i} className="rounded border border-slate-800 bg-slate-900/50 p-2" style={{ borderLeft: '3px solid ' + SURF_COLOR[r.ap.surface] }}>
              <div className="flex items-center gap-1 text-[10px]">
                <span className="font-semibold text-slate-100 truncate flex-1">{r.ap.icao} RWY {r.pair.rwy}</span>
                <span className="text-slate-500">hold @ {r.pair.cross}</span>
                <span className="px-1 rounded bg-slate-800 text-slate-300">{r.pair.ald} ft</span>
                {r.reject > 0 && <span className="px-1 rounded" style={{ backgroundColor: '#f43f5e33', color: '#fda4af' }}>REJ {r.reject}</span>}
              </div>
              <div className="text-[10px] text-slate-400 mt-1">hdg {r.pair.hdg.toString().padStart(3, '0')}° · X-rate {r.pair.trafficRate}/hr · arrivals {r.n} · mean margin <span style={{ color: r.meanMargin > 1000 ? '#10b981' : r.meanMargin > 0 ? '#f59e0b' : '#f43f5e' }}>{Math.round(r.meanMargin)} ft</span></div>
            </div>
          ))}
          {runwayAgg.length === 0 && <div className="text-center text-slate-500 py-4 text-[11px]">No active LAHSO runway pairs</div>}
        </div>
      )}
    </div>
  )
}
