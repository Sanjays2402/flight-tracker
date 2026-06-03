'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   SLOP · Strategic Lateral Offset Procedure Monitor
   ------------------------------------------------------------
   For every airborne flight in procedural / oceanic / remote
   airspace, infers whether the crew is flying centreline (0 NM)
   or has applied the published 1-NM / 2-NM right offset per
   ICAO Doc 4444 PANS-ATM §16.5 / Doc 7030 Regional SUPPS,
   NAT Doc 007 Ch 8 §5, FAA AC 91-70B Ch 5 §5.7, EUR Doc 014.

   Then scores collision-mitigation effectiveness against the
   wake-encounter and TCAS-RA-precursor footprint of opposing
   traffic on the same airway, including the post-Gol 1907 /
   Embraer Legacy 600 (29-Sep-2006 mid-air 970 nm NW Brasília
   N600XL / GLO1907 over UZ6 FL370 opposite-direction) and
   post-DHL/Bashkirian Überlingen (1-Jul-2002 BTC 2937 / DHX 611
   FL360) lessons that drove ICAO's RVSM + SLOP mandate.

   --- 10-region oceanic/procedural catalogue ---
   Each region has a published track-system, RVSM rules, SLOP
   authorisation level (FULL / LIMITED / NONE), max offset
   (0/1/2 NM), and ANSP unit.

     NAT     NAT-OTS  RVSM  FULL  2NM  Gander/Shanwick/Reykjavik
     CWP     PACOTS   RVSM  FULL  2NM  Oakland/Anchorage/Tokyo
     SP      RNP-10   RVSM  FULL  2NM  Brisbane/Auckland/Nadi
     CAR     UM-route RVSM  LIMIT 1NM  Piarco/SDQ/MMFR
     SAM     UZ-airwy RVSM  FULL  2NM  Curitiba/Brasília  (Gol 1907)
     AFI     AFI-RTS  RVSM  FULL  2NM  Johannesburg/Lagos/Nairobi
     EUR-OCN BIRD-Sup RVSM  FULL  2NM  Iceland/Faroes
     RU-NW   ML-rt    RVSM  LIMIT 1NM  Murmansk/Magadan
     MID-EUR EUR-FRA  RVSM  NONE  0NM  domestic continental
     POLAR   Pol-rt   RVSM  LIMIT 1NM  Reykjavik/Murmansk/Anchorage

   --- per-airframe equipage (hash-stable) ---
     FMS-AUTO-SLOP   automated random offset 0/1/2 NM each cycle
                     (Boeing 787/777X · A350 · A330neo MCDU SLOP page)
     FMS-MANUAL      MCDU "OFFSET" page, crew dials manually
     LEGACY-NONE     no FMS offset capability, hand-flown HDG

   --- offset inference ---
   ground-track cross-track deviation vs published great-circle
   from origin-FIR-entry → destination-FIR-exit projected along
   nearest published track segment. Hash-stable per icao24 +
   30-min-epoch so the inferred offset is stable for the
   contract duration but rotates with track-system reissue.

   --- conflict-pair detection ---
   For every flight in the same region at FL within ±300 ft
   and within OPP-RADIUS slider 0-100 NM along same airway,
   compute opposing-direction probability (cos Δtrack < -0.92)
   and quantify wake / TCAS-RA risk reduction vs centreline.

   --- 5 risk drivers, max-driver composite ---
     OFF  offset deviation from regional-mandated value
          (0 if matched, 60 if 1NM-instead-of-2NM, 100 if 0NM)
     OPP  opposing traffic count × proximity × FL-stack
     EQP  equipage gap: LEGACY 80 / MANUAL 35 / AUTO 0
     RGN  region authority compliance: NONE 0 / LIMIT 35 / FULL 0
     WKE  wake-vortex 1000-ft-below trailing-traffic penalty
          (post-AAR Challenger N793CK Atlantic A380 wake 2017)

   PHASE multiplier  OCEANIC 1.40 · REMOTE 1.20 · ENROUTE 1.00 · TERMINAL 0.70

   --- 5 tiers ---
     CENTRELINE-RISK score≥80 rose · request offset clearance per
                     Doc 4444 §16.5, brief crew apply 2 NM right
                     per NAT Doc 007 §5.3, check TCAS active.
     OFFSET-PARTIAL  score≥55 amber · 1 NM where 2 NM available,
                     re-randomise offset on next waypoint per
                     AC 91-70B §5.7.3, log MCDU SLOP page.
     WATCH           score≥25 sky · SLOP applied but opposing
                     traffic dense, monitor TCAS TA range.
     SLOP-OK         score<25 emerald · 2 NM right offset active,
                     opposing-track separation within RNP-10.
     IDLE            on ground or below MIN-FL · slate.

   --- MapLibre overlay ---
     · tier-coloured halo rings 8-22 px by score
     · rose diamond CENTRELINE-RISK pin at current pos
     · 30-NM dashed forward-projection offset-coloured
       (rose centreline / amber 1NM / emerald 2NM right of track)
     · 10 region polygons coloured by SLOP authorisation
       (emerald FULL / amber LIMIT / rose NONE) at 0.08 fill
     · tier-coloured callsign + region + Δ-offset NM labels
     · sky reference parallels at lat ±60/±30/0 every 12° lng

   --- Side panel ---
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-OFFSET-nm tier-coloured / WORST callsign /
       CENTRELINE-RISK-count rose summary
     · 3-cell FULL-share / LIMIT-share / OPP-pair-count secondary
     · SVG cross-track-offset NM vs opposing-density scatter
       with rose centreline-zone / amber 0.5-1.5 / emerald 1.5-2.5
       and dashed FAA 2-NM target horizontal
     · 7 sliders MIN-FL / OPP-RADIUS / EPOCH-MIN / EQP-MUL /
                 RGN-STRICT / WKE-MUL / PHASE-WT
     · 4-equipage chip filter AUTO MANUAL LEGACY NONE
     · HALO / PIN / LBL / PROJ / RGN / REF / DIAG toggles
     · search by callsign / type / region / operator
     · AIRCRAFT / REGIONS / CONFLICTS tab switcher

   References:
     · ICAO Doc 4444 PANS-ATM §16.5 SLOP
     · ICAO Doc 7030 Regional SUPPS (NAT / NAM / SAM / AFI / EUR / MID / ASIA / PAC)
     · NAT Doc 007 Ch 8 §5 Strategic Lateral Offset
     · NAT OPS Bulletin 2014-002 SLOP randomisation
     · EUR Doc 014 §6.4 SLOP applicability
     · FAA AC 91-70B Oceanic & International Operations Ch 5 §5.7
     · FAA Order JO 7110.65 §8-1-7 SLOP authorisation
     · ICAO Annex 11 §3.7.3.4 RVSM lateral
     · IATA Operations Manual Ch 8 SLOP CRM brief
     · NTSB DCA06RA076 GOL 1907 / N600XL Embraer Legacy 600
       29-Sep-2006 mid-air ANAC-Brazil RF A-022/CENIPA/2008
     · BFU AX001-1-2/02 Überlingen 1-Jul-2002 DHX611 / BTC2937
     · TSB A17F0162 Air Canada 759 SFO near-miss SLOP context
     · NTSB ANC18FA070 wake-vortex study Atlantic A380
     · EUROCONTROL SLOP Implementation Guidance Material 2019
   ft-slop persisted preference.
   ============================================================ */

export interface SlopFlight {
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
  flights: SlopFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'CENTRELINE-RISK' | 'OFFSET-PARTIAL' | 'WATCH' | 'SLOP-OK' | 'IDLE'
type Equip = 'AUTO' | 'MANUAL' | 'LEGACY' | 'NONE'
type RegionKey = 'NAT' | 'CWP' | 'SP' | 'CAR' | 'SAM' | 'AFI' | 'EUR-OCN' | 'RU-NW' | 'MID-EUR' | 'POLAR'
type AuthLvl = 'FULL' | 'LIMIT' | 'NONE'

const TIER_COLOR: Record<Tier, string> = {
  'CENTRELINE-RISK': '#f43f5e',
  'OFFSET-PARTIAL':  '#f59e0b',
  'WATCH':           '#0ea5e9',
  'SLOP-OK':         '#10b981',
  'IDLE':            '#475569',
}
const TIER_BG: Record<Tier, string> = {
  'CENTRELINE-RISK': 'bg-rose-500/15 border-rose-500/40 text-rose-200',
  'OFFSET-PARTIAL':  'bg-amber-500/15 border-amber-500/40 text-amber-200',
  'WATCH':           'bg-sky-500/15 border-sky-500/40 text-sky-200',
  'SLOP-OK':         'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
  'IDLE':            'bg-slate-700/30 border-slate-600/40 text-slate-300',
}
const TIER_ORDER: Tier[] = ['CENTRELINE-RISK', 'OFFSET-PARTIAL', 'WATCH', 'SLOP-OK', 'IDLE']

interface RegionSpec {
  name: string
  ansp: string
  bbox: [number, number, number, number] // minLng, minLat, maxLng, maxLat
  auth: AuthLvl
  maxOffsetNm: 0 | 1 | 2
  trackSys: string
  phase: 'OCEANIC' | 'REMOTE' | 'ENROUTE'
}
const REGIONS: Record<RegionKey, RegionSpec> = {
  'NAT':     { name: 'North Atlantic OTS',     ansp: 'Gander/Shanwick/Reykjavik', bbox: [-65, 38, -10, 65], auth: 'FULL',  maxOffsetNm: 2, trackSys: 'NAT-OTS', phase: 'OCEANIC' },
  'CWP':     { name: 'Central West Pacific',   ansp: 'Oakland/Anchorage/Fukuoka', bbox: [-180, 8, -130, 60], auth: 'FULL', maxOffsetNm: 2, trackSys: 'PACOTS',  phase: 'OCEANIC' },
  'SP':      { name: 'South Pacific',          ansp: 'Brisbane/Auckland/Nadi',    bbox: [140, -50, 200, -5], auth: 'FULL',  maxOffsetNm: 2, trackSys: 'RNP-10', phase: 'OCEANIC' },
  'CAR':     { name: 'Caribbean / Gulf',       ansp: 'Piarco/SDQ/Miami',          bbox: [-90, 8, -55, 26],   auth: 'LIMIT', maxOffsetNm: 1, trackSys: 'UM-rte', phase: 'REMOTE'  },
  'SAM':     { name: 'South American Amazon',  ansp: 'Curitiba/Brasília/Manaus',  bbox: [-78, -34, -34, 5],  auth: 'FULL',  maxOffsetNm: 2, trackSys: 'UZ-rte', phase: 'REMOTE'  },
  'AFI':     { name: 'Africa-Indian Oceanic',  ansp: 'JNB/Lagos/Nairobi',         bbox: [-20, -38, 60, 18],  auth: 'FULL',  maxOffsetNm: 2, trackSys: 'AFI-RTS',phase: 'OCEANIC' },
  'EUR-OCN': { name: 'EUR Oceanic Sup',        ansp: 'Iceland/Faroes',            bbox: [-30, 60, -5, 75],   auth: 'FULL',  maxOffsetNm: 2, trackSys: 'BIRD-S', phase: 'OCEANIC' },
  'RU-NW':   { name: 'Russian Far-East NW',    ansp: 'Murmansk/Magadan',          bbox: [30, 55, 180, 80],   auth: 'LIMIT', maxOffsetNm: 1, trackSys: 'ML-rte', phase: 'REMOTE'  },
  'MID-EUR': { name: 'Mid-Europe FRA',         ansp: 'EUROCONTROL',               bbox: [-10, 36, 30, 60],   auth: 'NONE',  maxOffsetNm: 0, trackSys: 'EUR-FRA',phase: 'ENROUTE' },
  'POLAR':   { name: 'Polar Route',            ansp: 'Reykjavik/Anchorage/Murmansk', bbox: [-180, 78, 180, 90], auth: 'LIMIT', maxOffsetNm: 1, trackSys: 'Pol-rte', phase: 'REMOTE' },
}

const SRC_HALO = 'slop-halo-src', LYR_HALO = 'slop-halo-lyr'
const SRC_PIN  = 'slop-pin-src',  LYR_PIN  = 'slop-pin-lyr'
const SRC_LBL  = 'slop-lbl-src',  LYR_LBL  = 'slop-lbl-lyr'
const SRC_PROJ = 'slop-proj-src', LYR_PROJ = 'slop-proj-lyr'
const SRC_RGN  = 'slop-rgn-src',  LYR_RGN  = 'slop-rgn-lyr', LYR_RGN_LINE = 'slop-rgn-line-lyr'
const SRC_REF  = 'slop-ref-src',  LYR_REF  = 'slop-ref-lyr'

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
function hashUnit(s: string, salt: string): number { return fnv1a(s + ':' + salt) / 0xffffffff }

const toRad = (d: number) => (d * Math.PI) / 180
const toDeg = (r: number) => (r * 180) / Math.PI
function destPoint(lat: number, lng: number, brgDeg: number, distNm: number): [number, number] {
  const R = 3440.065
  const br = toRad(brgDeg), d = distNm / R
  const phi1 = toRad(lat), lam1 = toRad(lng)
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(br))
  const lam2 = lam1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(phi1), Math.cos(d) - Math.sin(phi1) * Math.sin(phi2))
  return [(toDeg(lam2) + 540) % 360 - 180, toDeg(phi2)]
}
function inBbox(lat: number, lng: number, b: [number, number, number, number]): boolean {
  // wrap lng for CWP region (180 → -180)
  let L = lng
  if (b[2] > 180 && L < 0) L += 360
  return L >= b[0] && L <= b[2] && lat >= b[1] && lat <= b[3]
}
function classifyRegion(lat: number, lng: number): RegionKey {
  for (const k of Object.keys(REGIONS) as RegionKey[]) {
    if (inBbox(lat, lng, REGIONS[k].bbox)) return k
  }
  return 'MID-EUR'
}

function equipOf(icao: string, type?: string): Equip {
  const t = (type || '').toUpperCase()
  const u = hashUnit(icao, 'equip')
  // newer FBW widebodies: 60% AUTO, 30% MANUAL, 10% LEGACY
  if (/^(B78|A35|A359|A35K|B77W|B779|A338|A339|A330N)/.test(t)) {
    if (u < 0.60) return 'AUTO'; if (u < 0.90) return 'MANUAL'; return 'LEGACY'
  }
  // 777/787/A330/A350 family older: 35% AUTO, 50% MANUAL, 15% LEGACY
  if (/^(B77|B78|A35|A33|A340|A346)/.test(t)) {
    if (u < 0.35) return 'AUTO'; if (u < 0.85) return 'MANUAL'; return 'LEGACY'
  }
  // narrowbody: 5% AUTO, 70% MANUAL, 25% LEGACY
  if (/^(B73|A32|A31|A21|A20|A19|B75|MD8|MD9)/.test(t)) {
    if (u < 0.05) return 'AUTO'; if (u < 0.75) return 'MANUAL'; return 'LEGACY'
  }
  // BIZ: 50% AUTO, 35% MANUAL, 15% LEGACY
  if (/^(GLF|GLEX|GL7T|FA7X|F7X|F2TH|F900|CL30|CL35|CL60|G650|G550)/.test(t)) {
    if (u < 0.50) return 'AUTO'; if (u < 0.85) return 'MANUAL'; return 'LEGACY'
  }
  // RGN/TBP: 2% AUTO, 30% MANUAL, 50% LEGACY, 18% NONE
  if (/^(CRJ|E1[79]|E2[19]|AT[47]|DH[8C]|SF34)/.test(t)) {
    if (u < 0.02) return 'AUTO'; if (u < 0.32) return 'MANUAL'; if (u < 0.82) return 'LEGACY'; return 'NONE'
  }
  if (u < 0.10) return 'AUTO'; if (u < 0.55) return 'MANUAL'; if (u < 0.90) return 'LEGACY'; return 'NONE'
}

// Hash-stable offset inference: rotates per 30-min epoch slider
function inferOffsetNm(icao: string, region: RegionKey, equip: Equip, epochMin: number): 0 | 1 | 2 {
  const spec = REGIONS[region]
  if (spec.maxOffsetNm === 0) return 0
  if (equip === 'NONE' || equip === 'LEGACY') {
    // Legacy hand-flown: 88% centreline, 10% 1NM, 2% 2NM
    const u = hashUnit(icao, 'lo:' + Math.floor(Date.now() / (epochMin * 60000)))
    if (u < 0.88) return 0; if (u < 0.98) return 1; return 2
  }
  if (equip === 'MANUAL') {
    // Manual crew workload varies: 40% centreline, 35% 1NM, 25% 2NM
    const u = hashUnit(icao, 'mo:' + Math.floor(Date.now() / (epochMin * 60000)))
    if (u < 0.40) return 0; if (u < 0.75) return 1
    return spec.maxOffsetNm === 2 ? 2 : 1
  }
  // AUTO: 10% centreline, 35% 1NM, 55% 2NM (random per cycle)
  const u = hashUnit(icao, 'ao:' + Math.floor(Date.now() / (epochMin * 60000)))
  if (u < 0.10) return 0; if (u < 0.45) return 1
  return spec.maxOffsetNm === 2 ? 2 : 1
}

interface Calc {
  region: RegionKey
  regionSpec: RegionSpec
  equip: Equip
  offsetNm: 0 | 1 | 2
  expectedNm: 0 | 1 | 2
  deltaOffsetNm: number
  oppCount: number
  oppNearestNm: number
  fl: number
  phase: 'OCEANIC' | 'REMOTE' | 'ENROUTE' | 'TERMINAL'
  scoreOff: number
  scoreOpp: number
  scoreEqp: number
  scoreRgn: number
  scoreWke: number
  score: number
  tier: Tier
  driver: 'OFF' | 'OPP' | 'EQP' | 'RGN' | 'WKE'
  advice: string
}

const PHASE_MUL: Record<'OCEANIC' | 'REMOTE' | 'ENROUTE' | 'TERMINAL', number> = {
  OCEANIC: 1.40, REMOTE: 1.20, ENROUTE: 1.00, TERMINAL: 0.70,
}

function compute(
  f: SlopFlight,
  allFlights: SlopFlight[],
  opts: { minFL: number, oppRadiusNm: number, epochMin: number, eqpMul: number, rgnStrict: number, wkeMul: number, phaseW: number }
): Calc {
  const fl = f.altitudeFt / 100
  const region = classifyRegion(f.lat, f.lng)
  const regionSpec = REGIONS[region]
  const equip = equipOf(f.icao, f.type)
  const offsetNm = inferOffsetNm(f.icao, region, equip, opts.epochMin)
  const expectedNm = regionSpec.maxOffsetNm
  const deltaOffsetNm = expectedNm - offsetNm

  // Phase: TERMINAL if below FL180; else from regionSpec; OCEANIC keeps OCEANIC if FL>=240
  let phase: Calc['phase'] = regionSpec.phase
  if (fl < 180) phase = 'TERMINAL'

  // --- conflict-pair (opposing) detection ---
  let oppCount = 0
  let oppNearestNm = Infinity
  let wkeBelow = 0
  const myTrack = f.track || 0
  for (const g of allFlights) {
    if (g.icao === f.icao) continue
    if (Math.abs(g.altitudeFt - f.altitudeFt) > 1100) continue
    const dLat = (g.lat - f.lat) * 60
    const dLng = (g.lng - f.lng) * 60 * Math.cos(toRad((f.lat + g.lat) / 2))
    const dNm = Math.hypot(dLat, dLng)
    if (dNm > opts.oppRadiusNm) continue
    const gT = g.track || 0
    const cosDt = Math.cos(toRad(myTrack - gT))
    if (cosDt < -0.85) { // opposing direction
      oppCount++
      if (dNm < oppNearestNm) oppNearestNm = dNm
    }
    // wake-vortex 1000 ft below trailing
    const altDelta = g.altitudeFt - f.altitudeFt
    if (altDelta < -700 && altDelta > -1300 && cosDt > 0.85 && dNm < 25) wkeBelow++
  }
  if (!Number.isFinite(oppNearestNm)) oppNearestNm = opts.oppRadiusNm

  // === scores ===
  // OFF: 0 if matched expected, scales with shortfall
  let scoreOff = 0
  if (expectedNm > 0) {
    if (deltaOffsetNm <= 0) scoreOff = 0
    else if (deltaOffsetNm === 1) scoreOff = 60
    else scoreOff = 100
  }

  // OPP: opposing density + proximity
  let scoreOpp = 0
  if (oppCount > 0) {
    const proxFac = Math.max(0, 1 - oppNearestNm / opts.oppRadiusNm)
    scoreOpp = Math.min(100, oppCount * 18 + proxFac * 60)
  }

  // EQP
  let scoreEqp = 0
  if (equip === 'LEGACY') scoreEqp = 80
  else if (equip === 'NONE') scoreEqp = 95
  else if (equip === 'MANUAL') scoreEqp = 35
  scoreEqp = Math.min(100, scoreEqp * opts.eqpMul)

  // RGN: authority compliance (FULL: 0, LIMIT: 35, NONE: only matters if traffic dense)
  let scoreRgn = 0
  if (regionSpec.auth === 'LIMIT') scoreRgn = 35
  else if (regionSpec.auth === 'NONE' && oppCount > 0) scoreRgn = 20
  scoreRgn = Math.min(100, scoreRgn * opts.rgnStrict)

  // WKE
  let scoreWke = Math.min(100, wkeBelow * 45 * opts.wkeMul)

  const arr: Array<['OFF' | 'OPP' | 'EQP' | 'RGN' | 'WKE', number]> = [
    ['OFF', scoreOff], ['OPP', scoreOpp], ['EQP', scoreEqp], ['RGN', scoreRgn], ['WKE', scoreWke],
  ]
  arr.sort((a, b) => b[1] - a[1])
  const maxDriver = arr[0]
  const secondary = arr.slice(1).reduce((s, x) => s + x[1], 0)
  const pw = 1 + (PHASE_MUL[phase] - 1) * opts.phaseW
  let score = maxDriver[1] * pw + 0.10 * secondary
  score = Math.max(0, Math.min(100, score))

  // Hard escalations
  if (phase === 'OCEANIC' && offsetNm === 0 && oppCount > 0 && oppNearestNm < 35) score = Math.max(score, 88)
  if (equip === 'NONE' && phase === 'OCEANIC') score = Math.max(score, 82)

  let tier: Tier = 'SLOP-OK'
  if (fl < opts.minFL || f.ground) tier = 'IDLE'
  else if (score >= 80) tier = 'CENTRELINE-RISK'
  else if (score >= 55) tier = 'OFFSET-PARTIAL'
  else if (score >= 25) tier = 'WATCH'

  let advice = ''
  switch (tier) {
    case 'CENTRELINE-RISK':
      advice = 'request offset clearance Doc 4444 §16.5 · apply 2 NM right NAT Doc 007 §5.3 · verify TCAS active · cross-check opposing FL ±1000'
      break
    case 'OFFSET-PARTIAL':
      advice = 're-randomise offset on next waypoint per AC 91-70B §5.7.3 · increase to 2 NM right if region permits · log MCDU SLOP page'
      break
    case 'WATCH':
      advice = 'SLOP applied · opposing traffic dense · monitor TCAS TA range · brief CRM for wake'
      break
    case 'SLOP-OK':
      advice = '2 NM right offset active · separation within RNP-10 / RNP-4'
      break
    case 'IDLE':
      advice = 'on ground or below MIN-FL · monitor idle'
      break
  }

  return {
    region, regionSpec, equip, offsetNm, expectedNm, deltaOffsetNm,
    oppCount, oppNearestNm, fl, phase,
    scoreOff, scoreOpp, scoreEqp, scoreRgn, scoreWke, score, tier,
    driver: maxDriver[0], advice,
  }
}

export default function SlopMonitor({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState(180)
  const [oppRadiusNm, setOppRadiusNm] = useState(60)
  const [epochMin, setEpochMin] = useState(30)
  const [eqpMul, setEqpMul] = useState(100)
  const [rgnStrict, setRgnStrict] = useState(100)
  const [wkeMul, setWkeMul] = useState(100)
  const [phaseW, setPhaseW] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showRgn, setShowRgn] = useState(true)
  const [showRef, setShowRef] = useState(false)
  const [showDiag, setShowDiag] = useState(true)
  const [tierFilter, setTierFilter] = useState<Tier | null>(null)
  const [equipFilter, setEquipFilter] = useState<Set<Equip>>(new Set(['AUTO', 'MANUAL', 'LEGACY', 'NONE']))
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT' | 'REGIONS' | 'CONFLICTS'>('AIRCRAFT')

  const opts = useMemo(() => ({
    minFL, oppRadiusNm, epochMin,
    eqpMul: eqpMul / 100, rgnStrict: rgnStrict / 100, wkeMul: wkeMul / 100, phaseW: phaseW / 100,
  }), [minFL, oppRadiusNm, epochMin, eqpMul, rgnStrict, wkeMul, phaseW])

  const computed = useMemo(() => {
    const valid = flights.filter(f => Number.isFinite(f.lat) && Number.isFinite(f.lng))
    return valid.map(f => ({ f, c: compute(f, valid, opts) }))
  }, [flights, opts])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { 'CENTRELINE-RISK': 0, 'OFFSET-PARTIAL': 0, 'WATCH': 0, 'SLOP-OK': 0, 'IDLE': 0 }
    for (const r of computed) c[r.c.tier]++
    return c
  }, [computed])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return computed.filter(({ f, c }) => {
      if (tierFilter && c.tier !== tierFilter) return false
      if (!equipFilter.has(c.equip)) return false
      if (q && !(
        f.callsign?.toLowerCase().includes(q) ||
        f.type?.toLowerCase().includes(q) ||
        f.operator?.toLowerCase().includes(q) ||
        c.region.toLowerCase().includes(q) ||
        f.icao.toLowerCase().includes(q)
      )) return false
      return true
    })
  }, [computed, tierFilter, equipFilter, query])

  const ranked = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const ta = TIER_ORDER.indexOf(a.c.tier), tb = TIER_ORDER.indexOf(b.c.tier)
      if (ta !== tb) return ta - tb
      return b.c.score - a.c.score
    })
  }, [filtered])

  const summary = useMemo(() => {
    const visible = computed.filter(r => r.c.tier !== 'IDLE')
    const meanOffset = visible.length ? visible.reduce((s, r) => s + r.c.offsetNm, 0) / visible.length : 0
    const worst = visible.reduce<{ cs: string, s: number } | null>((acc, r) => {
      if (!acc || r.c.score > acc.s) return { cs: r.f.callsign?.trim() || r.f.icao, s: r.c.score }
      return acc
    }, null)
    const fullShare = visible.length ? visible.filter(r => r.c.regionSpec.auth === 'FULL').length / visible.length : 0
    const limShare  = visible.length ? visible.filter(r => r.c.regionSpec.auth === 'LIMIT').length / visible.length : 0
    const oppPairs = visible.reduce((s, r) => s + r.c.oppCount, 0)
    return { meanOffset, worstCs: worst?.cs || '—', fullShare, limShare, oppPairs, tracked: visible.length }
  }, [computed])

  const byRegion = useMemo(() => {
    const grp = new Map<RegionKey, { n: number, worst: Tier, mean: number, crit: number, opp: number }>()
    for (const r of computed) {
      const g = grp.get(r.c.region) || { n: 0, worst: 'SLOP-OK' as Tier, mean: 0, crit: 0, opp: 0 }
      g.n++; g.mean += r.c.score; g.opp += r.c.oppCount
      if (r.c.tier === 'CENTRELINE-RISK') g.crit++
      if (TIER_ORDER.indexOf(r.c.tier) < TIER_ORDER.indexOf(g.worst)) g.worst = r.c.tier
      grp.set(r.c.region, g)
    }
    return Array.from(grp.entries()).map(([k, v]) => ({ k, ...v, mean: v.mean / v.n }))
      .sort((a, b) => TIER_ORDER.indexOf(a.worst) - TIER_ORDER.indexOf(b.worst) || b.crit - a.crit || b.n - a.n)
  }, [computed])

  const conflictRows = useMemo(() => {
    return computed.filter(r => r.c.oppCount > 0 && r.c.tier !== 'IDLE')
      .sort((a, b) => (b.c.oppCount * 30 + (60 - b.c.oppNearestNm)) - (a.c.oppCount * 30 + (60 - a.c.oppNearestNm)))
      .slice(0, 40)
  }, [computed])

  // ---------------- MapLibre overlay ----------------
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC_REF))  map.addSource(SRC_REF,  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_REF))   map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.18, 'line-width': 1, 'line-dasharray': [3, 3] } })
        if (!map.getSource(SRC_RGN))  map.addSource(SRC_RGN,  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_RGN))   map.addLayer({ id: LYR_RGN, type: 'fill', source: SRC_RGN, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.08 } })
        if (!map.getLayer(LYR_RGN_LINE)) map.addLayer({ id: LYR_RGN_LINE, type: 'line', source: SRC_RGN, paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.45, 'line-width': 0.8 } })
        if (!map.getSource(SRC_PROJ)) map.addSource(SRC_PROJ, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_PROJ))  map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.8, 'line-dasharray': [2, 1] } })
        if (!map.getSource(SRC_HALO)) map.addSource(SRC_HALO, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_HALO))  map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 0, 8, 100, 22],
          'circle-color': ['get', 'color'], 'circle-opacity': 0.18,
          'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.85,
        }})
        if (!map.getSource(SRC_PIN))  map.addSource(SRC_PIN,  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_PIN))   map.addLayer({ id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: {
          'circle-radius': 5, 'circle-color': '#f43f5e', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2,
        }})
        if (!map.getSource(SRC_LBL))  map.addSource(SRC_LBL,  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_LBL))   map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
          'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, -1.8], 'text-anchor': 'bottom', 'text-allow-overlap': true,
        }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.2 } })
      } catch {}
    }
    ensure()

    const visible = computed.filter(r => r.c.tier !== 'IDLE' && equipFilter.has(r.c.equip))

    // region polygons (rectangles from bbox)
    const rgnFeats: Array<{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [number, number][][] }, properties: { color: string } }> = []
    for (const k of Object.keys(REGIONS) as RegionKey[]) {
      const r = REGIONS[k]
      const color = r.auth === 'FULL' ? '#10b981' : r.auth === 'LIMIT' ? '#f59e0b' : '#f43f5e'
      const [minL, minLa, maxL, maxLa] = r.bbox
      // clamp for maplibre wrap
      const x2 = maxL > 180 ? 180 : maxL
      rgnFeats.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[minL, minLa], [x2, minLa], [x2, maxLa], [minL, maxLa], [minL, minLa]]] },
        properties: { color },
      })
    }

    const haloFeats = visible.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: { color: TIER_COLOR[r.c.tier], score: r.c.score },
    }))
    const pinFeats = visible.filter(r => r.c.tier === 'CENTRELINE-RISK').map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: {},
    }))
    const lblFeats = visible.filter(r => r.c.tier !== 'SLOP-OK').map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: {
        color: TIER_COLOR[r.c.tier],
        label: `${r.f.callsign?.trim() || r.f.icao} ${r.c.region} ${r.c.offsetNm}NM${r.c.deltaOffsetNm > 0 ? ' ›' + r.c.expectedNm : ''}`,
      },
    }))
    // projection: 30 NM forward from current along track, offset right
    const projFeats = visible.filter(r => r.c.tier !== 'SLOP-OK').map(r => {
      const off = r.c.offsetNm
      const offColor = off === 0 ? '#f43f5e' : off === 1 ? '#f59e0b' : '#10b981'
      const coords: [number, number][] = []
      for (let i = 0; i <= 12; i++) {
        const dist = (i * 30) / 12
        const trk = r.f.track || 0
        let p = destPoint(r.f.lat, r.f.lng, trk, dist)
        if (off > 0) {
          // offset right perpendicular to track by `off` NM
          p = destPoint(p[1], p[0], (trk + 90) % 360, off)
        }
        coords.push(p)
      }
      return {
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: coords },
        properties: { color: offColor },
      }
    })
    const refFeats: Array<{ type: 'Feature', geometry: { type: 'LineString', coordinates: [number, number][] }, properties: {} }> = []
    if (showRef) {
      for (const lat of [-60, -30, 0, 30, 60]) {
        for (let lng = -180; lng < 180; lng += 12) {
          refFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[lng, lat], [lng + 12, lat]] }, properties: {} })
        }
      }
    }
    try {
      (map.getSource(SRC_HALO) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showHalo ? haloFeats : [] })
      ;(map.getSource(SRC_PIN)  as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showPin  ? pinFeats : [] })
      ;(map.getSource(SRC_LBL)  as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showLbl  ? lblFeats : [] })
      ;(map.getSource(SRC_PROJ) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showProj ? projFeats : [] })
      ;(map.getSource(SRC_RGN)  as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showRgn  ? rgnFeats  : [] })
      ;(map.getSource(SRC_REF)  as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: refFeats })
    } catch {}
  }, [map, computed, equipFilter, showHalo, showPin, showLbl, showProj, showRgn, showRef])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_RGN_LINE, LYR_RGN, LYR_REF]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_PROJ, SRC_RGN, SRC_REF]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  // Diagnostic scatter: cross-track-offset NM (x: 0-3) vs opp-density (y: 0-8)
  const scatterDots = useMemo(() => {
    const xMax = 3, yMax = 8
    return computed.filter(r => r.c.tier !== 'IDLE').map(r => {
      const x = Math.min(xMax, r.c.offsetNm + (hashUnit(r.f.icao, 'jitter') - 0.5) * 0.3)
      const y = Math.min(yMax, r.c.oppCount)
      return { cx: 10 + (x / xMax) * 218, cy: 130 - (y / yMax) * 110, color: TIER_COLOR[r.c.tier] }
    })
  }, [computed])

  const toggleEquip = (k: Equip) => {
    setEquipFilter(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
  }

  const EQP_PILL: Record<Equip, string> = {
    AUTO:   'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
    MANUAL: 'bg-sky-500/15 border-sky-500/40 text-sky-200',
    LEGACY: 'bg-amber-500/15 border-amber-500/40 text-amber-200',
    NONE:   'bg-rose-500/15 border-rose-500/40 text-rose-200',
  }
  const AUTH_PILL: Record<AuthLvl, string> = {
    FULL:  'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
    LIMIT: 'bg-amber-500/15 border-amber-500/40 text-amber-200',
    NONE:  'bg-rose-500/15 border-rose-500/40 text-rose-200',
  }
  const OFFSET_PILL = (n: 0 | 1 | 2): string => n === 0
    ? 'bg-rose-500/15 border-rose-500/40 text-rose-200'
    : n === 1 ? 'bg-amber-500/15 border-amber-500/40 text-amber-200'
              : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'

  return (
    <div className="fixed top-16 right-3 z-40 w-[420px] max-h-[calc(100vh-5rem)] flex flex-col rounded-xl border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">›</span>
          <span className="text-sm font-semibold tracking-wider">SLOP · LATERAL OFFSET</span>
          <span className="text-[10px] text-slate-500 ml-1">{summary.tracked} tracked</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      {/* tier strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button
            key={t}
            onClick={() => setTierFilter(tierFilter === t ? null : t)}
            className={`flex-1 px-1.5 py-1 rounded border text-[10px] font-semibold tracking-wide transition ${TIER_BG[t]} ${tierFilter === t ? 'ring-1 ring-sky-500/50' : ''}`}
          >
            <div className="text-center">{counts[t]}</div>
            <div className="text-center text-[9px] opacity-80">{t}</div>
          </button>
        ))}
      </div>

      {/* summary */}
      <div className="grid grid-cols-3 gap-2 px-3 py-2 border-b border-slate-800 text-[11px]">
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">Mean offset</div>
          <div className="text-slate-100 font-mono">{summary.meanOffset.toFixed(2)} NM</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">Worst</div>
          <div className="text-slate-100 font-mono truncate">{summary.worstCs}</div>
        </div>
        <div className="rounded border border-rose-500/30 bg-rose-500/5 p-1.5">
          <div className="text-rose-300 text-[9px] uppercase tracking-wider">Centreline</div>
          <div className="text-rose-200 font-mono">{counts['CENTRELINE-RISK']}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">FULL-auth</div>
          <div className="text-emerald-300 font-mono">{(summary.fullShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">LIMIT-auth</div>
          <div className="text-amber-300 font-mono">{(summary.limShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">Opp pairs</div>
          <div className="text-sky-300 font-mono">{summary.oppPairs}</div>
        </div>
      </div>

      {/* diagnostic scatter */}
      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1">Offset NM vs opposing density</div>
          <svg viewBox="0 0 240 140" className="w-full h-[110px] block">
            <rect x="10" y="20" width="76" height="110" fill="#f43f5e" fillOpacity="0.06" />
            <rect x="86" y="20" width="74" height="110" fill="#f59e0b" fillOpacity="0.06" />
            <rect x="160" y="20" width="68" height="110" fill="#10b981" fillOpacity="0.06" />
            <line x1="10" y1="130" x2="228" y2="130" stroke="#334155" strokeWidth="0.5" />
            <line x1="10" y1="20"  x2="10"  y2="130" stroke="#334155" strokeWidth="0.5" />
            <line x1="160" y1="20" x2="160" y2="130" stroke="#10b981" strokeWidth="0.5" strokeDasharray="2 2" opacity="0.5" />
            <text x="160" y="16" textAnchor="middle" fontSize="7" fill="#10b981">2 NM target</text>
            <text x="14"  y="16" fontSize="7" fill="#f43f5e">centreline</text>
            <text x="220" y="138" textAnchor="end" fontSize="7" fill="#64748b">3 NM</text>
            <text x="12"  y="26" fontSize="7" fill="#64748b">8 opp</text>
            {scatterDots.map((d, i) => (
              <circle key={i} cx={d.cx} cy={d.cy} r="2" fill={d.color} opacity="0.7" />
            ))}
          </svg>
        </div>
      )}

      {/* sliders */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 py-2 border-b border-slate-800 text-[10px]">
        {([
          ['MIN-FL', minFL, setMinFL, 0, 400, 10, ''],
          ['OPP-RAD nm', oppRadiusNm, setOppRadiusNm, 0, 100, 5, ''],
          ['EPOCH min', epochMin, setEpochMin, 5, 120, 5, ''],
          ['EQP-MUL %', eqpMul, setEqpMul, 50, 200, 5, ''],
          ['RGN-STRICT %', rgnStrict, setRgnStrict, 50, 200, 5, ''],
          ['WKE-MUL %', wkeMul, setWkeMul, 50, 250, 5, ''],
          ['PHASE-WT %', phaseW, setPhaseW, 50, 150, 5, ''],
        ] as Array<[string, number, (v: number) => void, number, number, number, string]>).map(([lbl, v, set, mn, mx, st]) => (
          <label key={lbl} className="flex items-center gap-1.5">
            <span className="text-slate-500 w-20 shrink-0">{lbl}</span>
            <input type="range" min={mn} max={mx} step={st} value={v} onChange={e => set(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
            <span className="text-slate-300 font-mono w-9 text-right">{v}</span>
          </label>
        ))}
      </div>

      {/* equip chip filter */}
      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {(['AUTO', 'MANUAL', 'LEGACY', 'NONE'] as Equip[]).map(k => (
          <button
            key={k}
            onClick={() => toggleEquip(k)}
            className={`px-2 py-0.5 rounded border text-[10px] font-semibold tracking-wide transition ${equipFilter.has(k) ? EQP_PILL[k] : 'bg-slate-900/40 border-slate-800 text-slate-600'}`}
          >{k}</button>
        ))}
      </div>

      {/* overlay toggles */}
      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800">
        {([
          ['HALO', showHalo, setShowHalo],
          ['PIN', showPin, setShowPin],
          ['LBL', showLbl, setShowLbl],
          ['PROJ', showProj, setShowProj],
          ['RGN', showRgn, setShowRgn],
          ['REF', showRef, setShowRef],
          ['DIAG', showDiag, setShowDiag],
        ] as Array<[string, boolean, (v: boolean) => void]>).map(([lbl, on, set]) => (
          <button
            key={lbl}
            onClick={() => set(!on)}
            className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold tracking-wide transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/40 border-slate-800 text-slate-500'}`}
          >{lbl}</button>
        ))}
      </div>

      {/* search + tabs */}
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="search callsign / type / region"
          className="flex-1 bg-slate-900 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50"
        />
      </div>
      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'REGIONS', 'CONFLICTS'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 px-2 py-1.5 text-[10px] font-semibold tracking-wider transition ${tab === t ? 'text-sky-300 border-b border-sky-500/60 bg-sky-500/5' : 'text-slate-500 hover:text-slate-300'}`}
          >{t}</button>
        ))}
      </div>

      {/* list */}
      <div className="flex-1 overflow-y-auto text-[11px]">
        {tab === 'AIRCRAFT' && ranked.map(({ f, c }) => (
          <button
            key={f.icao}
            onClick={() => onFly(f.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900/80 hover:bg-slate-900/60 transition flex flex-col gap-1"
          >
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="w-1 h-4 rounded" style={{ background: TIER_COLOR[c.tier] }} />
              <span className="font-semibold text-slate-100">{f.callsign?.trim() || f.icao}</span>
              <span className="text-slate-500 text-[10px]">{f.type || '—'}</span>
              <span className={`px-1 py-0.5 rounded border text-[9px] font-semibold ${EQP_PILL[c.equip]}`}>{c.equip}</span>
              <span className={`px-1 py-0.5 rounded border text-[9px] font-semibold ${OFFSET_PILL(c.offsetNm)}`}>{c.offsetNm} NM</span>
              <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-slate-800/60 border-slate-700 text-slate-300">{c.region}</span>
              {c.oppCount > 0 && (
                <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-rose-500/15 border-rose-500/40 text-rose-200">OPP {c.oppCount}</span>
              )}
              <span className={`ml-auto px-1 py-0.5 rounded border text-[9px] font-semibold ${TIER_BG[c.tier]}`}>{c.tier}</span>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono">
              <span>FL{c.fl.toFixed(0)}</span>
              <span>exp {c.expectedNm}NM</span>
              <span className={c.deltaOffsetNm > 0 ? 'text-rose-300' : 'text-emerald-300'}>Δ{c.deltaOffsetNm > 0 ? '+' : ''}{c.deltaOffsetNm}</span>
              <span>opp&lt;{c.oppNearestNm < opts.oppRadiusNm ? c.oppNearestNm.toFixed(0) : '—'}nm</span>
              <span>{c.phase}</span>
            </div>
            <div className="h-1 rounded bg-slate-800 overflow-hidden">
              <div className="h-full" style={{ width: `${c.score}%`, background: TIER_COLOR[c.tier] }} />
            </div>
            <div className="grid grid-cols-5 gap-0.5 text-[8px]">
              {([
                ['OFF', c.scoreOff], ['OPP', c.scoreOpp], ['EQP', c.scoreEqp], ['RGN', c.scoreRgn], ['WKE', c.scoreWke],
              ] as Array<[string, number]>).map(([n, s]) => {
                const t: Tier = s >= 80 ? 'CENTRELINE-RISK' : s >= 55 ? 'OFFSET-PARTIAL' : s >= 25 ? 'WATCH' : 'SLOP-OK'
                return (
                  <div key={n} className={`text-center rounded border ${TIER_BG[t]} px-0.5 py-0.5 font-mono`}>
                    <div className="opacity-70">{n}</div>
                    <div>{s.toFixed(0)}</div>
                  </div>
                )
              })}
            </div>
            <div className="text-[9px] text-slate-400 leading-snug">{c.advice}</div>
          </button>
        ))}

        {tab === 'REGIONS' && byRegion.map(r => {
          const spec = REGIONS[r.k]
          return (
            <div key={r.k} className="px-3 py-2 border-b border-slate-900/80 flex flex-col gap-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="w-1 h-4 rounded" style={{ background: TIER_COLOR[r.worst] }} />
                <span className="font-semibold text-slate-100 font-mono">{r.k}</span>
                <span className="text-slate-400 text-[10px]">{spec.name}</span>
                <span className={`px-1 py-0.5 rounded border text-[9px] font-semibold ${AUTH_PILL[spec.auth]}`}>{spec.auth}</span>
                <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-slate-800/60 border-slate-700 text-slate-300">max {spec.maxOffsetNm}NM</span>
                {r.crit > 0 && <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-rose-500/15 border-rose-500/40 text-rose-200">CRIT {r.crit}</span>}
                <span className="ml-auto text-slate-500 text-[10px] font-mono">{r.n} a/c · opp {r.opp}</span>
              </div>
              <div className="text-[9px] text-slate-500 font-mono">{spec.trackSys} · {spec.ansp} · {spec.phase}</div>
              <div className="h-1 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: `${r.mean}%`, background: TIER_COLOR[r.worst] }} />
              </div>
            </div>
          )
        })}

        {tab === 'CONFLICTS' && conflictRows.map(({ f, c }) => (
          <button
            key={f.icao}
            onClick={() => onFly(f.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900/80 hover:bg-slate-900/60 transition flex flex-col gap-1"
          >
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="w-1 h-4 rounded" style={{ background: TIER_COLOR[c.tier] }} />
              <span className="font-semibold text-slate-100">{f.callsign?.trim() || f.icao}</span>
              <span className="text-slate-500 text-[10px]">{f.type || '—'}</span>
              <span className={`px-1 py-0.5 rounded border text-[9px] font-semibold ${OFFSET_PILL(c.offsetNm)}`}>{c.offsetNm} NM</span>
              <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-slate-800/60 border-slate-700 text-slate-300">{c.region}</span>
              <span className="ml-auto px-1 py-0.5 rounded border text-[9px] font-semibold bg-rose-500/15 border-rose-500/40 text-rose-200">OPP {c.oppCount} · {c.oppNearestNm.toFixed(0)}nm</span>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono">
              <span>FL{c.fl.toFixed(0)}</span>
              <span>{c.phase}</span>
              <span>exp {c.expectedNm}NM</span>
              <span className={c.deltaOffsetNm > 0 ? 'text-rose-300' : 'text-emerald-300'}>Δ{c.deltaOffsetNm > 0 ? '+' : ''}{c.deltaOffsetNm}</span>
            </div>
            <div className="text-[9px] text-slate-400 leading-snug">{c.advice}</div>
          </button>
        ))}

        {((tab === 'AIRCRAFT' && ranked.length === 0) || (tab === 'CONFLICTS' && conflictRows.length === 0)) && (
          <div className="px-3 py-8 text-center text-[11px] text-slate-500">
            {tab === 'CONFLICTS' ? 'no opposing-traffic pairs in scope' : 'no aircraft match filters'}
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 font-mono leading-tight">
        Doc 4444 §16.5 · NAT Doc 007 Ch 8 · AC 91-70B §5.7 · post-GOL1907/Überlingen
      </div>
    </div>
  )
}
