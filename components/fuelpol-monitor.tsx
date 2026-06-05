'use client'

// =============================================================================
// FUELPOL · Fuel-Policy Compliance, Reserve-Sanctity & MINFUEL / MAYDAY-FUEL
//           Escalation Monitor
// -----------------------------------------------------------------------------
// Per-airframe live evaluator of the IN-FLIGHT FUEL POLICY ladder enforced
// against every cruising / descending aircraft estimated to be holding less
// than the planned final-reserve fuel (FRF) plus contingency-and-alternate
// allowances on arrival. Scores the canonical fuel-policy stack documented
// across the ICAO/EASA/FAA/IATA fuel-policy regulatory framework, decides
// whether the crew is required to declare MINIMUM FUEL (advisory) or
// MAYDAY MAYDAY MAYDAY FUEL (emergency) under the regulator-specific
// thresholds, and ranks each airframe against the global fleet for
// controller workload and dispatch oversight prioritisation.
//
// FUELPOL is structurally distinct from every neighbouring fuel overlay:
//   RDP (Re-dispatch)        — planning-time RCF credit per §121.631(c)
//   PNR (Point-of-No-Return) — geographic last-return geometry
//   DRFTDN                   — OEI driftdown net-ceiling vs terrain
//   ETP / CP                 — equal-time inflection (geometric)
//   Optimum-Alt              — SAR / step-climb cruise-FL optimiser
//   Tankering                — economic uplift decision
// FUELPOL is uniquely the IN-FLIGHT REMAINING-FUEL vs FRF+CONT+ALT
// compliance evaluator + MINFUEL/MAYDAY escalation classifier.
//
// Canonical precedents:
//   Avianca 052 KJFK 1990 (NTSB AAR-91-04) — failure to declare emergency
//     fuel after multiple holds, fuel exhaustion go-around vectoring
//   Tuninter 1153 Mediterranean 2005 (ANSV A-01/05) — wrong FQI, fuel
//     exhaustion ditching short of Palermo
//   Air Transat 236 Lajes 2001 (GPIAA A04/2002) — fuel leak, dual flameout,
//     dead-stick glide to LPLA
//   Hapag-Lloyd 3378 LOWW 2000 (BFU 5X007-0/00) — gear-down drag, forced
//     landing in field short of LOWW
//   BA 38 LHR 2008 (AAIB EW/C2008/01/01) — FOHE fuel icing dual roll-back
//
// Per: ICAO Annex 6 Pt I §4.3.7 / Annex 10 Vol II §5.3.1.4 / PANS-ATM
// Doc 4444 §4.3.7.4 §15.1.4 §16.2.2 / EASA CAT.OP.MPA.150 / AMC1 / SIB
// 2017-12 / FAA 14 CFR §91.167 §121.639 §121.645 §121.647 §121.631(c)
// §135.223 / AC 120-103A / Order JO 7110.65 §2-1-8 §10-2 / InFO 08020
// / Boeing FCOM Suppl. Fuel Mgmt / Airbus FCOM PRO-NOR-MNG-30 /
// IATA Fuel Efficiency 2024 / IATA STEADES 2024 §5
//
// 7-class fuel-burn catalogue (cruise + holding + diversion FF, FOB envelope,
// reserve floor) sourced from Boeing PEM / Airbus FCOM PRO-NOR / BADA 3.15.
// 24-hub arrival anchor catalogue + 24-hub alternate catalogue for diversion
// burn computation. Phase-of-flight classifier (CRZ / DSC / TMA / HOLD).
// 8-driver / 5-tier composite scorer with hard escalators tied to Avianca-052
// fuel-exhaustion precedent and ICAO MAYDAY-FUEL threshold.
//
// MapLibre overlay: tier-coloured halo rings + MAYDAY/MINFUEL pins +
// reserve-floor bar + arrival/alternate connector arcs + FOB labels.
// Side panel: tier counter strip + 6-cell summary + 5 sliders + filters +
// 4-tab AIRCRAFT/HUBS/POLICY/METHOD switcher.
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

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

// -------------------------------------------------------------------- //
// Tier definitions (FUELPOL ladder)
// -------------------------------------------------------------------- //
type Tier = 'MAYDAY' | 'MINFUEL' | 'COMMIT' | 'WATCH' | 'NOMINAL' | 'IDLE'

const TIER_ORDER: Tier[] = ['MAYDAY', 'MINFUEL', 'COMMIT', 'WATCH', 'NOMINAL', 'IDLE']

const TIER_COLOR: Record<Tier, string> = {
  MAYDAY:  '#e11d48', // rose-600 — emergency fuel
  MINFUEL: '#fb7185', // rose-pink — advisory
  COMMIT:  '#f59e0b', // amber — committed past alt-decision
  WATCH:   '#0ea5e9', // sky — monitor
  NOMINAL: '#10b981', // emerald
  IDLE:    '#64748b', // slate
}

const TIER_RANK: Record<Tier, number> = {
  MAYDAY: 0, MINFUEL: 1, COMMIT: 2, WATCH: 3, NOMINAL: 4, IDLE: 5,
}

// -------------------------------------------------------------------- //
// Aircraft class catalogue
// Cruise FF, holding FF (clean @1500ft / divert leg FF @FL150),
// MTOW, max usable fuel kg, typical landing mass kg, FRF kg (30-min
// hold @1500ft per ICAO Annex 6 / CAT.OP.MPA.150). Sources: Boeing
// PEM §3, Airbus FCOM PRO-NOR-SOP-19, BADA 3.15 OPF/APF, ICAO Doc 8643.
// -------------------------------------------------------------------- //
type AClass = 'HVY-Q' | 'HVY-T' | 'WB-M' | 'NB-LR' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ' | 'OTHER'

interface AcSpec {
  label: string
  crzFFkgH: number      // cruise fuel flow kg/h at LRC
  hldFFkgH: number      // holding fuel flow kg/h @1500ft clean
  dvtFFkgH: number      // diversion FF (descent + low-cruise) kg/h
  mtowKg: number        // max takeoff weight
  oewKg: number         // operating empty weight (≈)
  maxFuelKg: number     // max usable fuel
  frfMin: number        // final reserve duration (min) per ICAO/EASA = 30
  fobInitialFrac: number // typical FOB at departure as % of max fuel
}

const AC_CATALOGUE: Record<AClass, AcSpec> = {
  'HVY-Q':  { label: 'B747/A380 4-eng heavy',   crzFFkgH: 12500, hldFFkgH: 8200, dvtFFkgH: 11200, mtowKg: 560000, oewKg: 280000, maxFuelKg: 230000, frfMin: 30, fobInitialFrac: 0.78 },
  'HVY-T':  { label: 'B777/B787/A350/A330',     crzFFkgH:  6900, hldFFkgH: 4500, dvtFFkgH:  6200, mtowKg: 351000, oewKg: 168000, maxFuelKg: 145000, frfMin: 30, fobInitialFrac: 0.75 },
  'WB-M':   { label: 'B767/A330ceo',             crzFFkgH:  4900, hldFFkgH: 3300, dvtFFkgH:  4400, mtowKg: 230000, oewKg: 130000, maxFuelKg:  87000, frfMin: 30, fobInitialFrac: 0.72 },
  'NB-LR':  { label: 'A321XLR/B737MAX LR',       crzFFkgH:  2900, hldFFkgH: 2000, dvtFFkgH:  2600, mtowKg: 101000, oewKg:  55000, maxFuelKg:  32600, frfMin: 30, fobInitialFrac: 0.74 },
  'NB':     { label: 'B737/A320',                crzFFkgH:  2600, hldFFkgH: 1800, dvtFFkgH:  2300, mtowKg:  79000, oewKg:  41500, maxFuelKg:  20900, frfMin: 30, fobInitialFrac: 0.68 },
  'RGN-J':  { label: 'E190/CRJ9/E195',           crzFFkgH:  1850, hldFFkgH: 1200, dvtFFkgH:  1650, mtowKg:  56000, oewKg:  28800, maxFuelKg:  13000, frfMin: 30, fobInitialFrac: 0.65 },
  'RGN-T':  { label: 'AT72/Q400 turbo-prop',     crzFFkgH:   720, hldFFkgH:  480, dvtFFkgH:   650, mtowKg:  29000, oewKg:  17000, maxFuelKg:   5000, frfMin: 30, fobInitialFrac: 0.60 },
  'BIZ':    { label: 'G650/GLEX/FA8X',           crzFFkgH:  1450, hldFFkgH: 1000, dvtFFkgH:  1300, mtowKg:  47000, oewKg:  22500, maxFuelKg:  20000, frfMin: 30, fobInitialFrac: 0.78 },
  'OTHER':  { label: 'unclassified',             crzFFkgH:  2400, hldFFkgH: 1600, dvtFFkgH:  2100, mtowKg:  75000, oewKg:  40000, maxFuelKg:  18000, frfMin: 30, fobInitialFrac: 0.65 },
}

// Map of common ICAO type designators → AClass
function classify(type?: string, category?: string): AClass {
  const t = (type || '').toUpperCase()
  if (t === 'A380' || t === 'A388' || t === 'B748' || t === 'B744' || t === 'B741' || t === 'B742' || t === 'B743') return 'HVY-Q'
  if (t.startsWith('A35') || t.startsWith('A33') || t.startsWith('B77') || t.startsWith('B78') || t === 'B772' || t === 'B773' || t === 'B788' || t === 'B789' || t === 'B78X') return 'HVY-T'
  if (t.startsWith('B76') || t === 'A332' || t === 'A333' || t === 'A310' || t === 'A300') return 'WB-M'
  if (t === 'A321' || t === 'A21N' || t === 'B39M' || t === 'B38M' || t === 'B752' || t === 'B753') return 'NB-LR'
  if (t.startsWith('A32') || t.startsWith('A31') || t.startsWith('B73') || t === 'A319' || t === 'A320') return 'NB'
  if (t.startsWith('E17') || t.startsWith('E19') || t.startsWith('E29') || t.startsWith('CRJ') || t === 'E170' || t === 'E190' || t === 'E195' || t === 'C56X') return 'RGN-J'
  if (t.startsWith('AT') || t === 'DH8D' || t === 'DH8C' || t === 'DH8B' || t === 'SF34' || t === 'B190' || t === 'SW4') return 'RGN-T'
  if (t === 'GLEX' || t === 'GL5T' || t === 'GLF6' || t === 'GLF5' || t === 'GLF4' || t === 'FA8X' || t === 'FA7X' || t === 'F900' || t === 'F2TH' || t.startsWith('C56') || t.startsWith('C68') || t.startsWith('C75')) return 'BIZ'
  if ((category || '').toLowerCase().includes('heavy')) return 'HVY-T'
  return 'OTHER'
}

// -------------------------------------------------------------------- //
// Arrival hub catalogue
// 24 major-hub destinations with associated planned alternate (geographic
// distance ~80-300 NM). Drives diversion burn cost.
// -------------------------------------------------------------------- //
interface Hub {
  id: string
  name: string
  lat: number
  lng: number
  alt: { id: string; lat: number; lng: number; distNM: number }
}

const HUBS: Hub[] = [
  { id: 'KJFK', name: 'New York Kennedy',    lat: 40.6398, lng:  -73.7789, alt: { id: 'KEWR', lat: 40.6925, lng:  -74.1687, distNM:  17 } },
  { id: 'KEWR', name: 'Newark',              lat: 40.6925, lng:  -74.1687, alt: { id: 'KJFK', lat: 40.6398, lng:  -73.7789, distNM:  17 } },
  { id: 'KBOS', name: 'Boston Logan',        lat: 42.3656, lng:  -71.0096, alt: { id: 'KMHT', lat: 42.9326, lng:  -71.4357, distNM:  47 } },
  { id: 'KATL', name: 'Atlanta Hartsfield',  lat: 33.6407, lng:  -84.4277, alt: { id: 'KCHA', lat: 35.0353, lng:  -85.2038, distNM: 108 } },
  { id: 'KORD', name: 'Chicago O\'Hare',     lat: 41.9742, lng:  -87.9073, alt: { id: 'KMDW', lat: 41.7868, lng:  -87.7522, distNM:  14 } },
  { id: 'KDFW', name: 'Dallas/Fort Worth',   lat: 32.8998, lng:  -97.0403, alt: { id: 'KDAL', lat: 32.8471, lng:  -96.8518, distNM:  10 } },
  { id: 'KLAX', name: 'Los Angeles',         lat: 33.9416, lng: -118.4085, alt: { id: 'KONT', lat: 34.0560, lng: -117.6011, distNM:  42 } },
  { id: 'KSFO', name: 'San Francisco',       lat: 37.6213, lng: -122.3790, alt: { id: 'KOAK', lat: 37.7213, lng: -122.2208, distNM:  10 } },
  { id: 'KSEA', name: 'Seattle Tacoma',      lat: 47.4502, lng: -122.3088, alt: { id: 'KBFI', lat: 47.5300, lng: -122.3015, distNM:   5 } },
  { id: 'KDEN', name: 'Denver',              lat: 39.8561, lng: -104.6737, alt: { id: 'KCOS', lat: 38.8058, lng: -104.7008, distNM:  64 } },
  { id: 'KMIA', name: 'Miami',               lat: 25.7959, lng:  -80.2870, alt: { id: 'KFLL', lat: 26.0726, lng:  -80.1527, distNM:  20 } },
  { id: 'CYYZ', name: 'Toronto Pearson',     lat: 43.6772, lng:  -79.6306, alt: { id: 'CYHM', lat: 43.1736, lng:  -79.9350, distNM:  32 } },
  { id: 'EGLL', name: 'London Heathrow',     lat: 51.4700, lng:   -0.4543, alt: { id: 'EGSS', lat: 51.8850, lng:    0.2350, distNM:  40 } },
  { id: 'EGKK', name: 'London Gatwick',      lat: 51.1481, lng:   -0.1903, alt: { id: 'EGLL', lat: 51.4700, lng:   -0.4543, distNM:  24 } },
  { id: 'LFPG', name: 'Paris Charles de G',  lat: 49.0097, lng:    2.5479, alt: { id: 'LFPO', lat: 48.7233, lng:    2.3794, distNM:  22 } },
  { id: 'EHAM', name: 'Amsterdam Schiphol',  lat: 52.3086, lng:    4.7639, alt: { id: 'EBBR', lat: 50.9014, lng:    4.4844, distNM:  90 } },
  { id: 'EDDF', name: 'Frankfurt',           lat: 50.0379, lng:    8.5622, alt: { id: 'EDDS', lat: 48.6900, lng:    9.2200, distNM: 100 } },
  { id: 'LSZH', name: 'Zurich',              lat: 47.4647, lng:    8.5492, alt: { id: 'LFSB', lat: 47.5896, lng:    7.5299, distNM:  47 } },
  { id: 'LIRF', name: 'Rome Fiumicino',      lat: 41.8003, lng:   12.2389, alt: { id: 'LIRA', lat: 41.7994, lng:   12.5949, distNM:  17 } },
  { id: 'OMDB', name: 'Dubai',               lat: 25.2532, lng:   55.3657, alt: { id: 'OMAA', lat: 24.4331, lng:   54.6511, distNM:  60 } },
  { id: 'WSSS', name: 'Singapore Changi',    lat:  1.3644, lng:  103.9915, alt: { id: 'WMKK', lat:  2.7456, lng:  101.7099, distNM: 175 } },
  { id: 'VHHH', name: 'Hong Kong',           lat: 22.3080, lng:  113.9185, alt: { id: 'ZGSZ', lat: 22.6393, lng:  113.8108, distNM:  22 } },
  { id: 'RJTT', name: 'Tokyo Haneda',        lat: 35.5494, lng:  139.7798, alt: { id: 'RJAA', lat: 35.7647, lng:  140.3863, distNM:  35 } },
  { id: 'YSSY', name: 'Sydney Kingsford',    lat: -33.9461, lng: 151.1772, alt: { id: 'YSCB', lat: -35.3069, lng: 149.1950, distNM: 130 } },
]

// -------------------------------------------------------------------- //
// Math + helpers
// -------------------------------------------------------------------- //
function clamp(x: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, x)) }
function dNM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065 // nm
  const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180
  const Δφ = (lat2 - lat1) * Math.PI/180
  const Δλ = (lng2 - lng1) * Math.PI/180
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}
function bearingTo(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180
  const λ1 = lng1 * Math.PI/180, λ2 = lng2 * Math.PI/180
  const y = Math.sin(λ2-λ1) * Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(λ2-λ1)
  return (Math.atan2(y, x) * 180/Math.PI + 360) % 360
}
function headingDelta(a: number, b: number): number {
  let d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}
// Deterministic per-icao24 hash 0..1
function rand(seed: number, salt: number): number {
  let h = (seed * 2654435761 + salt * 1597334677) >>> 0
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return (h % 100000) / 100000
}
function icaoSeed(icao: string): number {
  let h = 0
  for (let i = 0; i < icao.length; i++) h = ((h << 5) - h + icao.charCodeAt(i)) | 0
  return Math.abs(h)
}

// -------------------------------------------------------------------- //
// Phase classifier
// -------------------------------------------------------------------- //
type Phase = 'CRZ' | 'DSC' | 'TMA' | 'HOLD' | 'GND'
function classifyPhase(f: F, distNM: number): Phase {
  if (f.ground) return 'GND'
  if (f.altitudeFt < 12000 && distNM < 60 && f.velocityKts < 280) return 'TMA'
  // Holding heuristic: low GS at low FL with non-zero VS oscillation proxy
  if (f.altitudeFt < 16000 && f.velocityKts < 230 && Math.abs(f.vertRate) < 200 && distNM < 80) return 'HOLD'
  if (f.vertRate < -300) return 'DSC'
  return 'CRZ'
}

// -------------------------------------------------------------------- //
// Per-aircraft row computation
// -------------------------------------------------------------------- //
interface Row {
  f: F
  cls: AClass
  spec: AcSpec
  hub: Hub | null
  distToHubNM: number
  alongTrack: number // 0..1, alignment with bearing to hub
  phase: Phase
  fobKg: number          // current fuel-on-board estimate
  frfKg: number          // final reserve floor (30 min hold)
  contKg: number         // contingency (~5% of remaining trip)
  altKg: number          // alternate-leg burn estimate
  burnToDestKg: number   // expected burn from now → destination including descent/TMA
  burnAtAltKg: number    // expected burn from now → alternate via destination
  fobOnLandingKg: number // expected residual fuel on landing at destination
  fobAfterDivertKg: number // expected residual after divert to alternate
  marginVsFrfKg: number    // fobOnLandingKg - frfKg
  marginAfterDivertKg: number // fobAfterDivertKg - frfKg
  policyEndurMin: number  // endurance remaining (min) at current burn
  drivers: Record<string, number>
  score: number
  tier: Tier
  notes: string[]
}

function computeRow(f: F, advMul: number, contPctMul: number, holdMinExtra: number, fuelBiasPct: number): Row | null {
  if (f.ground) return null
  if (f.altitudeFt < 5000) return null // pre-cruise / climb

  const cls = classify(f.type, f.category)
  const spec = AC_CATALOGUE[cls]
  // Best-hub snap: nearest from HUBS with track alignment preference
  let best: { h: Hub; d: number; ali: number } | null = null
  for (const h of HUBS) {
    const d = dNM(f.lat, f.lng, h.lat, h.lng)
    if (d > 1800) continue
    const brg = bearingTo(f.lat, f.lng, h.lat, h.lng)
    const ali = 1 - clamp(headingDelta(f.track || 0, brg) / 90, 0, 1)
    const score = d - 200 * ali
    if (!best || score < best.d - 200 * best.ali) best = { h, d, ali }
  }
  if (!best) return null

  const { h: hub, d: distToHubNM, ali: alongTrack } = best
  // Only score if reasonably aligned (heading toward) OR well within terminal area
  if (alongTrack < 0.25 && distToHubNM > 80) return null
  if (distToHubNM > 1200) return null // outside arrival-phase scope

  const phase = classifyPhase(f, distToHubNM)
  if (phase === 'GND') return null

  // Effective ground-speed for burn estimation
  const gs = Math.max(180, f.velocityKts)
  const timeToDestHr = distToHubNM / gs
  // Synthesise FOB: based on hash-bias against typical FOB-vs-distance curve.
  // Assume departure ~3000NM segment, FOB scales linearly with remaining-distance fraction.
  const seed = icaoSeed(f.icao)
  // Endurance fudge: deterministic per-airframe stress factor 0.85..1.05 of nominal
  const stressFac = 0.85 + rand(seed, 7) * 0.20
  // Plausible FOB envelope: mid-flight ~ 40-65% of max fuel, late arrivals lower
  // Use distance-to-destination as a proxy for trip remaining: linear scale.
  const distFracRemaining = clamp(distToHubNM / 1200, 0.04, 1.0) // 0.04 means very close
  // FOB at departure × residual based on distance
  const nominalRemainingFrac = 0.18 + 0.55 * distFracRemaining // 18%..73% of max fuel
  const fobKgRaw = spec.maxFuelKg * nominalRemainingFrac * stressFac
  // User bias slider (±20%)
  const fobKg = clamp(fobKgRaw * (1 + fuelBiasPct/100), spec.maxFuelKg * 0.04, spec.maxFuelKg * 0.95)

  // Burn-to-destination model:
  //   CRZ portion @ crzFF until 100NM out, then TMA @ holding-mix FF
  //   DSC portion @ 0.85 × crzFF
  //   TMA portion @ holding FF + descent allowance
  const crzNM = Math.max(0, distToHubNM - 60) // CRZ to top-of-descent
  const tmaNM = Math.min(60, distToHubNM)
  const crzHr = crzNM / gs
  const tmaHr = tmaNM / 250 // assume avg 250kt in TMA
  let burnToDestKg = crzHr * spec.crzFFkgH + tmaHr * (spec.hldFFkgH * 1.2)
  // Phase adjustments
  if (phase === 'DSC') burnToDestKg *= 0.92  // already in descent, less to burn
  if (phase === 'HOLD') burnToDestKg += (holdMinExtra / 60) * spec.hldFFkgH

  // Alternate-leg burn = direct cruise leg at low FL (FL150 typical divert)
  const altHr = hub.alt.distNM / 280
  const altKg = altHr * spec.dvtFFkgH + 0.10 * spec.crzFFkgH // approach overhead

  // Final reserve: 30 min holding @ 1500ft per ICAO Annex 6 / EASA
  const frfKg = (spec.frfMin / 60) * spec.hldFFkgH

  // Contingency: 5% of remaining trip burn per ICAO/EASA (scaled by user)
  const contKg = burnToDestKg * 0.05 * contPctMul

  // Residual estimates
  const fobOnLandingKg = fobKg - burnToDestKg
  const fobAfterDivertKg = fobOnLandingKg - altKg

  const marginVsFrfKg = fobOnLandingKg - frfKg
  const marginAfterDivertKg = fobAfterDivertKg - frfKg

  // Endurance min at current burn
  const currentFF = phase === 'HOLD' ? spec.hldFFkgH : (phase === 'DSC' ? spec.crzFFkgH * 0.92 : spec.crzFFkgH)
  const policyEndurMin = (fobKg / currentFF) * 60

  // ---------------- DRIVERS (each 0..100) ---------------- //
  // FRF-MARGIN: how close is landing fuel to FRF (negative = bust)
  const dFRF = clamp(((frfKg - fobOnLandingKg) / frfKg) * 120, 0, 100)
  // DIVERT-MARGIN: residual after divert vs FRF
  const dDIV = clamp(((frfKg - fobAfterDivertKg) / frfKg) * 110, 0, 100)
  // CONT-CONSUMED: contingency consumption proxy
  const dCONT = clamp(((contKg - Math.max(0, marginVsFrfKg)) / Math.max(contKg, 1)) * 75, 0, 100)
  // HOLD-RISK: time spent or expected in holding consumes FRF
  const dHOLD = phase === 'HOLD' ? clamp(35 + rand(seed, 11) * 35, 0, 100) : 0
  // ENDUR: endurance minutes remaining
  const dENDUR = clamp((45 - policyEndurMin) * 2.5, 0, 100) // 45 min = nominal floor
  // DST: distance to nearest field if FOB low
  const dDIST = fobOnLandingKg < frfKg ? clamp((distToHubNM - 20) / 4, 0, 100) : 0
  // PHASE: critical-phase weight (arrival + low FL + low fuel = high)
  const dPHASE = (phase === 'TMA' || phase === 'HOLD') && fobKg < spec.maxFuelKg * 0.18 ? 60 : 0
  // ALT-AVAIL: alternate too far for current FOB
  const altReachable = (fobKg - burnToDestKg - frfKg) >= altKg
  const dALT = !altReachable && phase !== 'CRZ' ? 70 : 0

  const drivers = {
    'FRF':    Math.round(dFRF),
    'DIVERT': Math.round(dDIV),
    'CONT':   Math.round(dCONT),
    'HOLD':   Math.round(dHOLD),
    'ENDUR':  Math.round(dENDUR),
    'DIST':   Math.round(dDIST),
    'PHASE':  Math.round(dPHASE),
    'ALT':    Math.round(dALT),
  }
  const drvArr = Object.values(drivers)
  let score = (Math.max(...drvArr) * 0.66 + (drvArr.reduce((a, c) => a + c, 0) / drvArr.length) * 0.34) * advMul

  // ---------------- Hard escalators ---------------- //
  const notes: string[] = []
  // MAYDAY FUEL: USABLE landing fuel < FRF — per ICAO Annex 6 Pt I §4.3.7.5
  // crew is REQUIRED to transmit "MAYDAY MAYDAY MAYDAY [callsign] FUEL"
  if (marginVsFrfKg < 0) {
    score = Math.max(score, 92)
    notes.push(`MAYDAY-FUEL · landing FOB ${Math.round(fobOnLandingKg)} kg < FRF ${Math.round(frfKg)} kg — declare emergency per ICAO Annex 6 Pt I §4.3.7.5 / Doc 4444 §15.1.4 (Avianca 052 precedent)`)
  }
  // MINFUEL: any change to clearance may result in below-FRF landing
  // per ICAO Annex 6 Pt I §4.3.7.4 / Doc 4444 §4.3.7.4
  else if (marginVsFrfKg < contKg * 0.5) {
    score = Math.max(score, 75)
    notes.push(`MINFUEL advisory · margin ${Math.round(marginVsFrfKg)} kg vs FRF ${Math.round(frfKg)} kg — declare MINIMUM FUEL to ATC per Doc 4444 §4.3.7.4, request expected delay`)
  }
  // Past alternate-decision threshold (committed to destination)
  else if (!altReachable && phase !== 'CRZ') {
    score = Math.max(score, 60)
    notes.push(`Committed to destination — alternate ${hub.alt.id} unreachable with FRF intact (would consume ${Math.round(altKg)} kg vs ${Math.round(fobKg - burnToDestKg - frfKg)} kg available)`)
  }
  // Holding with low FOB
  else if (phase === 'HOLD' && marginVsFrfKg < contKg) {
    score = Math.max(score, 55)
    notes.push(`Holding ${policyEndurMin.toFixed(0)} min endurance remaining — MINFUEL trigger at next hold extension per OpSpec`)
  }
  // Reserve under stress
  else if (marginVsFrfKg < contKg * 1.5) {
    score = Math.max(score, 38)
    notes.push(`Reserve under stress · margin ${Math.round(marginVsFrfKg)} kg, contingency ${Math.round(contKg)} kg — monitor closely`)
  }

  // BA-38 / FOHE icing context
  if (cls === 'HVY-T' && phase === 'DSC' && f.altitudeFt < 25000 && distToHubNM < 100) {
    notes.push(`Fuel-icing watch · cold-soak descent ≤25000ft (BA 38 FOHE precedent)`)
  }
  // Avianca-052 keyword reinforcement
  if (score >= 70 && phase === 'HOLD') {
    notes.push(`Phraseology · use the words "MINIMUM FUEL" or "MAYDAY FUEL" — Avianca 052 mode (NTSB AAR-91-04 cited "priority" was insufficient)`)
  }

  score = clamp(score, 0, 100)

  // ---------------- Tier classification ---------------- //
  let tier: Tier = 'IDLE'
  if (marginVsFrfKg < 0) tier = 'MAYDAY'
  else if (score >= 75 || marginVsFrfKg < contKg * 0.5) tier = 'MINFUEL'
  else if (score >= 55 || (!altReachable && phase !== 'CRZ')) tier = 'COMMIT'
  else if (score >= 30) tier = 'WATCH'
  else if (score > 0) tier = 'NOMINAL'
  else tier = 'IDLE'

  return {
    f, cls, spec, hub, distToHubNM, alongTrack, phase,
    fobKg, frfKg, contKg, altKg, burnToDestKg, burnAtAltKg: burnToDestKg + altKg,
    fobOnLandingKg, fobAfterDivertKg, marginVsFrfKg, marginAfterDivertKg, policyEndurMin,
    drivers, score, tier, notes,
  }
}

// -------------------------------------------------------------------- //
// Component
// -------------------------------------------------------------------- //
export default function FuelpolMonitor({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [contPctMul, setContPctMul] = useState(1.0)
  const [holdMinExtra, setHoldMinExtra] = useState(0)
  const [fuelBiasPct, setFuelBiasPct] = useState(0)
  const [scopeNM, setScopeNM] = useState(1200)
  const [classFilter, setClassFilter] = useState<'ALL' | AClass>('ALL')
  const [hubFilter, setHubFilter] = useState<'ALL' | string>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<'ALL' | Phase>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT' | 'HUBS' | 'POLICY' | 'METHOD'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shArc, setShArc] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const r = computeRow(f, advMul, contPctMul, holdMinExtra, fuelBiasPct)
      if (!r) continue
      if (r.distToHubNM > scopeNM) continue
      out.push(r)
    }
    out.sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return out
  }, [flights, advMul, contPctMul, holdMinExtra, fuelBiasPct, scopeNM])

  // ---------------- MapLibre overlay ---------------- //
  useEffect(() => {
    if (!map) return
    const SRC = 'fuelpol-src'
    const SRC_ARC = 'fuelpol-arc-src'
    const SRC_ALT = 'fuelpol-alt-src'
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any }) }
    ;[SRC, SRC_ARC, SRC_ALT].forEach(ensure)

    const writeAll = () => {
      const view = rows.filter(r =>
        (tierFilter === 'ALL' || r.tier === tierFilter) &&
        (classFilter === 'ALL' || r.cls === classFilter) &&
        (hubFilter === 'ALL' || (r.hub && r.hub.id === hubFilter)) &&
        (phaseFilter === 'ALL' || r.phase === phaseFilter)
      )
      const ac: any[] = []
      const arc: any[] = []
      const altPts: any[] = []
      const seenAlt = new Set<string>()
      for (const r of view) {
        ac.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
          properties:{
            tier: r.tier,
            color: TIER_COLOR[r.tier],
            score: r.score,
            sz: 7 + (r.score/100) * 14,
            label: `${r.f.callsign||r.f.icao} · ${r.tier} · FOB ${Math.round(r.fobKg)} · ${r.policyEndurMin.toFixed(0)}min`,
          },
        })
        if (shArc && r.hub) {
          arc.push({
            type:'Feature',
            geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat], [r.hub.lng, r.hub.lat]] },
            properties:{ color: TIER_COLOR[r.tier], w: r.tier === 'MAYDAY' ? 2.4 : r.tier === 'MINFUEL' ? 1.8 : 1.2 },
          })
          if (!seenAlt.has(r.hub.alt.id)) {
            seenAlt.add(r.hub.alt.id)
            altPts.push({
              type:'Feature',
              geometry:{ type:'Point', coordinates:[r.hub.alt.lng, r.hub.alt.lat] },
              properties:{ label: r.hub.alt.id, color: '#94a3b8' },
            })
          }
        }
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: (shHalo||shPin||shLbl) ? ac : [] })
      ;(map.getSource(SRC_ARC) as any).setData({ type:'FeatureCollection', features: arc })
      ;(map.getSource(SRC_ALT) as any).setData({ type:'FeatureCollection', features: altPts })
    }

    if (!map.getLayer('fuelpol-arc'))
      map.addLayer({ id:'fuelpol-arc', type:'line', source:SRC_ARC, paint:{ 'line-color':['get','color'], 'line-width':['get','w'], 'line-opacity':0.45, 'line-dasharray':[2,2] } })
    if (!map.getLayer('fuelpol-alt-pin'))
      map.addLayer({ id:'fuelpol-alt-pin', type:'circle', source:SRC_ALT, paint:{ 'circle-radius':3.2, 'circle-color':['get','color'], 'circle-opacity':0.55, 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':0.8 } })
    if (!map.getLayer('fuelpol-alt-lbl'))
      map.addLayer({ id:'fuelpol-alt-lbl', type:'symbol', source:SRC_ALT, layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,-1.0], 'text-anchor':'bottom', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#94a3b8', 'text-halo-color':'#0b0f17', 'text-halo-width':1.0 } })
    if (!map.getLayer('fuelpol-halo'))
      map.addLayer({ id:'fuelpol-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('fuelpol-pin'))
      map.addLayer({ id:'fuelpol-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 60], paint:{ 'circle-radius':4.8, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('fuelpol-lbl'))
      map.addLayer({ id:'fuelpol-lbl', type:'symbol', source:SRC, filter:['>=', ['get','score'], 50], layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.5], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.3 } })

    writeAll()

    return () => {
      for (const id of ['fuelpol-lbl','fuelpol-pin','fuelpol-halo','fuelpol-alt-lbl','fuelpol-alt-pin','fuelpol-arc']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_ARC, SRC_ALT]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, classFilter, hubFilter, phaseFilter, shHalo, shPin, shLbl, shArc])

  // ---------------- Aggregations ---------------- //
  const visible = rows.filter(r =>
    (tierFilter === 'ALL' || r.tier === tierFilter) &&
    (classFilter === 'ALL' || r.cls === classFilter) &&
    (hubFilter === 'ALL' || (r.hub && r.hub.id === hubFilter)) &&
    (phaseFilter === 'ALL' || r.phase === phaseFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.hub?.id||'').toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { MAYDAY:0, MINFUEL:0, COMMIT:0, WATCH:0, NOMINAL:0, IDLE:0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? rows.reduce((a, c) => a + c.score, 0) / rows.length : 0
  const sumMayday = counts.MAYDAY
  const sumMinFuel = counts.MINFUEL
  const muEndurMin = rows.length ? rows.reduce((a, c) => a + c.policyEndurMin, 0) / rows.length : 0
  const sumFobKg = rows.reduce((a, c) => a + c.fobKg, 0)
  const worst = rows[0]

  // Per-hub aggregation
  interface HubAgg { h: Hub; n: number; mayday: number; minfuel: number; muScore: number; muFob: number }
  const hubAggMap = new Map<string, HubAgg>()
  for (const r of rows) {
    if (!r.hub) continue
    const m = hubAggMap.get(r.hub.id) || { h: r.hub, n: 0, mayday: 0, minfuel: 0, muScore: 0, muFob: 0 }
    m.n++
    if (r.tier === 'MAYDAY') m.mayday++
    if (r.tier === 'MINFUEL') m.minfuel++
    m.muScore += r.score
    m.muFob += r.fobKg
    hubAggMap.set(r.hub.id, m)
  }
  const hubAgg = Array.from(hubAggMap.values()).map(m => ({ ...m, muScore: m.muScore / m.n, muFob: m.muFob / m.n })).sort((a,b) => (b.mayday + b.minfuel) - (a.mayday + a.minfuel) || b.muScore - a.muScore)

  // ---------------- Render ---------------- //
  return (
    <div className="fixed top-16 right-3 z-40 w-[480px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">FUELPOL</span>
          <span className="text-[10px] text-slate-400">Fuel-Policy · MINFUEL/MAYDAY · ICAO Annex 6 §4.3.7 / Doc 4444 §15.1.4 / CAT.OP.MPA.150 / §121.639</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* Tier counter strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.slice(0,5).map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className="flex-1 px-1.5 py-1 rounded text-[10px] font-mono border"
            style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:'transparent', color: TIER_COLOR[t] }}>{t.slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCR</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">MAYDAY</div><div className="font-mono" style={{color: sumMayday?TIER_COLOR.MAYDAY:'#94a3b8'}}>{sumMayday}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">MIN-F</div><div className="font-mono" style={{color: sumMinFuel?TIER_COLOR.MINFUEL:'#94a3b8'}}>{sumMinFuel}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-END m</div><div className="text-slate-100 font-mono">{muEndurMin.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">Σ-FOB t</div><div className="text-slate-100 font-mono">{(sumFobKg/1000).toFixed(1)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?(worst.f.callsign||worst.f.icao):'—'}</div></div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">CONT % <span className="text-slate-200 font-mono">{(contPctMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="300" value={contPctMul*100} onChange={e=>setContPctMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">HOLD min+ <span className="text-slate-200 font-mono">{holdMinExtra}</span>
            <input type="range" min="0" max="45" value={holdMinExtra} onChange={e=>setHoldMinExtra(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">FOB-BIAS % <span className="text-slate-200 font-mono">{fuelBiasPct>=0?'+':''}{fuelBiasPct}</span>
            <input type="range" min="-20" max="20" value={fuelBiasPct} onChange={e=>setFuelBiasPct(+e.target.value)} className="w-full accent-sky-500" />
          </label>
        </div>
        <label className="text-[10px] text-slate-400">SCOPE NM <span className="text-slate-200 font-mono">{scopeNM}</span>
          <input type="range" min="200" max="2000" step="50" value={scopeNM} onChange={e=>setScopeNM(+e.target.value)} className="w-full accent-sky-500" />
        </label>
        {/* Phase filter */}
        <div className="flex flex-wrap gap-1">
          {(['ALL','CRZ','DSC','TMA','HOLD'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        {/* Class filter */}
        <div className="flex flex-wrap gap-1">
          <button onClick={()=>setClassFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL-CLS</button>
          {(['HVY-Q','HVY-T','WB-M','NB-LR','NB','RGN-J','RGN-T','BIZ'] as AClass[]).map(c => (
            <button key={c} onClick={()=>setClassFilter(c)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter===c?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{c}</button>
          ))}
        </div>
        {/* Overlay toggles + search */}
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['ARC',shArc,setShArc]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/hub" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 px-3 py-1.5 border-b border-slate-700/60">
        {(['AIRCRAFT','HUBS','POLICY','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {tab === 'AIRCRAFT' && (
          <>
            {visible.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-6">No aircraft within FUELPOL scope · adjust SCOPE-NM or FOB-BIAS</div>
            )}
            {visible.slice(0, 60).map(r => (
              <div key={r.f.icao} className="border rounded-lg p-2 bg-slate-800/40" style={{ borderColor: TIER_COLOR[r.tier] + '60' }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: TIER_COLOR[r.tier] + '22', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                    <button onClick={()=>onFly(r.f.icao)} className="text-slate-100 font-mono text-[11px] hover:text-sky-300">{r.f.callsign||r.f.icao}</button>
                    <span className="text-slate-400 text-[10px]">{r.f.type||'?'}·{r.cls}·{r.phase}</span>
                  </div>
                  <div className="text-[10px] font-mono" style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</div>
                </div>
                <div className="grid grid-cols-5 gap-1 mt-1.5 text-[10px]">
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><div className="text-slate-500">FOB kg</div><div className="text-slate-200 font-mono">{Math.round(r.fobKg)}</div></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><div className="text-slate-500">LDG kg</div><div className="font-mono" style={{color: r.marginVsFrfKg<0?TIER_COLOR.MAYDAY:r.marginVsFrfKg<r.contKg?TIER_COLOR.MINFUEL:'#cbd5e1'}}>{Math.round(r.fobOnLandingKg)}</div></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><div className="text-slate-500">FRF kg</div><div className="text-slate-200 font-mono">{Math.round(r.frfKg)}</div></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><div className="text-slate-500">END min</div><div className="text-slate-200 font-mono">{r.policyEndurMin.toFixed(0)}</div></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><div className="text-slate-500">DIST NM</div><div className="text-slate-200 font-mono">{r.distToHubNM.toFixed(0)}</div></div>
                </div>
                {/* Reserve-bar: FOB vs (Burn + Alt + FRF) */}
                <div className="mt-1.5">
                  <div className="text-[9px] text-slate-500 mb-0.5">Fuel ladder · → {r.hub?.id} (alt {r.hub?.alt.id}, {r.hub?.alt.distNM} NM)</div>
                  <div className="h-2 bg-slate-900/60 rounded relative overflow-hidden">
                    {/* Burn band */}
                    <div className="absolute left-0 top-0 h-full" style={{ width: `${clamp(r.burnToDestKg/r.fobKg*100, 0, 100)}%`, background: '#475569' }} />
                    {/* Alt band */}
                    <div className="absolute top-0 h-full" style={{ left: `${clamp(r.burnToDestKg/r.fobKg*100, 0, 100)}%`, width: `${clamp(r.altKg/r.fobKg*100, 0, 100-r.burnToDestKg/r.fobKg*100)}%`, background: '#0ea5e9' }} />
                    {/* FRF band */}
                    <div className="absolute top-0 h-full" style={{ left: `${clamp((r.burnToDestKg+r.altKg)/r.fobKg*100, 0, 100)}%`, width: `${clamp(r.frfKg/r.fobKg*100, 0, 100-(r.burnToDestKg+r.altKg)/r.fobKg*100)}%`, background: TIER_COLOR[r.tier] }} />
                  </div>
                  <div className="flex justify-between text-[8px] text-slate-500 mt-0.5">
                    <span>BURN {Math.round(r.burnToDestKg)}</span>
                    <span>ALT {Math.round(r.altKg)}</span>
                    <span>FRF {Math.round(r.frfKg)}</span>
                  </div>
                </div>
                {/* Drivers */}
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {Object.entries(r.drivers).map(([k,v]) => (
                    <span key={k} className="text-[9px] px-1 py-0.5 rounded font-mono" style={{ background: v>=50?TIER_COLOR.MINFUEL+'22':'#334155', color: v>=50?TIER_COLOR.MINFUEL:'#94a3b8' }}>{k} {v}</span>
                  ))}
                </div>
                {/* Notes */}
                {r.notes.length > 0 && (
                  <div className="mt-1.5 space-y-0.5">
                    {r.notes.slice(0,3).map((n,i) => (
                      <div key={i} className="text-[9px] text-slate-300 leading-tight">› {n}</div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {visible.length > 60 && (
              <div className="text-center text-[9px] text-slate-500 py-2">… +{visible.length-60} more · narrow filters to inspect</div>
            )}
          </>
        )}

        {tab === 'HUBS' && (
          <>
            <div className="text-[9px] text-slate-500 mb-1.5">24-hub arrival anchor catalogue · click to filter</div>
            <button onClick={()=>setHubFilter('ALL')} className={`w-full text-left mb-1 px-2 py-1 rounded text-[10px] font-mono ${hubFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL · {rows.length} aircraft, {sumMayday+sumMinFuel} non-nominal</button>
            {hubAgg.map(m => (
              <button key={m.h.id} onClick={()=>setHubFilter(m.h.id)} className={`w-full text-left px-2 py-1.5 rounded border ${hubFilter===m.h.id?'bg-sky-500/10 border-sky-500/40':'bg-slate-800/40 border-slate-700/40'} mb-1`}>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[11px] font-mono text-slate-100">{m.h.id} · {m.h.name}</div>
                    <div className="text-[9px] text-slate-500">alt {m.h.alt.id} ({m.h.alt.distNM} NM)</div>
                  </div>
                  <div className="text-[10px] font-mono text-right">
                    <div className="text-slate-300">n={m.n}</div>
                    <div className="text-rose-400">M{m.mayday} m{m.minfuel}</div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-1 mt-1 text-[9px]">
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">μ-SCR</span> <span className="font-mono text-slate-200">{m.muScore.toFixed(0)}</span></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">μ-FOB t</span> <span className="font-mono text-slate-200">{(m.muFob/1000).toFixed(1)}</span></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">SAT</span> <span className="font-mono text-slate-200">{(m.n>=10?'HI':m.n>=4?'MD':'LO')}</span></div>
                </div>
              </button>
            ))}
          </>
        )}

        {tab === 'POLICY' && (
          <div className="text-[10px] text-slate-300 space-y-2 leading-snug">
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› REGULATORY LADDER</div>
              <div className="space-y-1.5">
                <div className="bg-slate-800/40 rounded px-2 py-1.5">
                  <div className="font-mono text-[10px] text-slate-100">ICAO Annex 6 Pt I §4.3.7</div>
                  <div className="text-[10px] text-slate-400">Pre-planned fuel = Taxi + Trip + Contingency (5% trip or 5min@1500ft) + Alternate + Final Reserve (30 min hold @1500ft, ISA, turbine) + Additional + Discretionary.</div>
                </div>
                <div className="bg-slate-800/40 rounded px-2 py-1.5">
                  <div className="font-mono text-[10px] text-slate-100">EASA CAT.OP.MPA.150 / AMC1</div>
                  <div className="text-[10px] text-slate-400">EU implementation aligned with ICAO Annex 6. RCF variants per Operator manual. SIB 2017-12 codifies MINFUEL/MAYDAY phraseology.</div>
                </div>
                <div className="bg-slate-800/40 rounded px-2 py-1.5">
                  <div className="font-mono text-[10px] text-slate-100">FAA 14 CFR §121.639 / 645 / 647</div>
                  <div className="text-[10px] text-slate-400">Domestic: trip + 45 min reserve. Flag/supplemental: trip + 10% trip + alternate + 30 min. §121.631(c) RCF re-dispatch credit allows reduced enroute fuel with re-clearance point.</div>
                </div>
                <div className="bg-slate-800/40 rounded px-2 py-1.5">
                  <div className="font-mono text-[10px] text-slate-100">FAA 14 CFR §91.167 / §135.223</div>
                  <div className="text-[10px] text-slate-400">Part 91 IFR: destination + alternate + 45 min. Part 135 commuter/on-demand: 45 min day, 45 min night IFR.</div>
                </div>
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› ESCALATION PHRASEOLOGY</div>
              <div className="space-y-1.5">
                <div className="bg-rose-950/40 rounded px-2 py-1.5 border border-rose-900/40">
                  <div className="font-mono text-[10px] text-rose-300">MAYDAY MAYDAY MAYDAY [CALLSIGN] FUEL</div>
                  <div className="text-[10px] text-slate-300">Emergency. Calculated usable fuel-on-landing &lt; Final Reserve. ATC must give priority handling per Doc 4444 §15.1.4. Reference: ICAO Annex 6 Pt I §4.3.7.5 / Annex 10 Vol II §5.3.1.4.</div>
                </div>
                <div className="bg-rose-950/30 rounded px-2 py-1.5 border border-rose-900/30">
                  <div className="font-mono text-[10px] text-rose-200">MINIMUM FUEL</div>
                  <div className="text-[10px] text-slate-300">Advisory. Any change to clearance may result in landing with less than FRF. NOT an emergency. ATC must inform crew of expected delay per Doc 4444 §4.3.7.4.</div>
                </div>
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› ACCIDENT PRECEDENT</div>
              <div className="space-y-1">
                <div className="bg-slate-800/40 rounded px-2 py-1 text-[10px] text-slate-300"><span className="font-mono text-slate-100">Avianca 052 KJFK 1990-01-25</span> NTSB AAR-91-04 · 73 fatal · failure to declare emergency fuel</div>
                <div className="bg-slate-800/40 rounded px-2 py-1 text-[10px] text-slate-300"><span className="font-mono text-slate-100">Tuninter 1153 Med 2005-08-06</span> ANSV A-01/05 · 16 fatal · wrong FQI fitted</div>
                <div className="bg-slate-800/40 rounded px-2 py-1 text-[10px] text-slate-300"><span className="font-mono text-slate-100">Air Transat 236 LPLA 2001-08-24</span> GPIAA A04/2002 · 0 fatal · fuel leak, dead-stick glide</div>
                <div className="bg-slate-800/40 rounded px-2 py-1 text-[10px] text-slate-300"><span className="font-mono text-slate-100">Hapag-Lloyd 3378 LOWW 2000-07-12</span> BFU 5X007-0/00 · 0 fatal · gear-down drag, field landing</div>
                <div className="bg-slate-800/40 rounded px-2 py-1 text-[10px] text-slate-300"><span className="font-mono text-slate-100">BA 38 EGLL 2008-01-17</span> AAIB EW/C2008/01/01 · 0 fatal · FOHE fuel-icing dual roll-back</div>
              </div>
            </div>
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="text-[10px] text-slate-300 space-y-2 leading-snug">
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› MODEL</div>
              <div className="text-[10px] text-slate-400">Per-airframe class snap (HVY-Q / HVY-T / WB-M / NB-LR / NB / RGN-J / RGN-T / BIZ). Cruise/holding/diversion fuel-flow catalogue from Boeing PEM / Airbus FCOM / BADA 3.15. 24-hub arrival anchor catalogue with per-hub alternate distances 5-175 NM. Phase classifier (CRZ / DSC / TMA / HOLD).</div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› FOB ESTIMATION</div>
              <div className="text-[10px] text-slate-400">FOB synthesised per-icao24 hash against typical FOB-vs-distance curve: 18% to 73% of max-fuel as distance-to-go ramps 0→1200 NM, stress factor ±10% per-airframe deterministic. FOB-BIAS slider ±20% for sensitivity sweep. Real-system would consume FQI feed.</div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› BURN MODEL</div>
              <div className="text-[10px] text-slate-400">Burn-to-destination = CRZ-leg × crzFF + TMA-leg × 1.2×holdFF + descent allowance. Burn-to-alternate = altLeg × dvtFF + 0.10×crzFF approach overhead. Final Reserve = 30 min × holdFF per ICAO Annex 6. Contingency = 5% × tripBurn × user-multiplier.</div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› DRIVERS (each 0-100)</div>
              <ul className="space-y-0.5 text-[10px] text-slate-400 ml-2">
                <li>· FRF: (frf − landing FOB)/frf × 120 (negative margin → bust)</li>
                <li>· DIVERT: (frf − after-divert FOB)/frf × 110</li>
                <li>· CONT: contingency consumption proxy</li>
                <li>· HOLD: phase=HOLD with hash variability</li>
                <li>· ENDUR: (45 − endur_min) × 2.5</li>
                <li>· DIST: distance penalty when FOB &lt; FRF</li>
                <li>· PHASE: critical-phase (TMA/HOLD) low-FOB amplifier</li>
                <li>· ALT: alternate-unreachable post-cruise</li>
              </ul>
            </div>
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› COMPOSITE + TIER</div>
              <div className="text-[10px] text-slate-400">score = (max·0.66 + mean·0.34) × ADV-MUL · hard escalators: marginVsFRF&lt;0 → MAYDAY 92; margin&lt;0.5×cont → MINFUEL 75; alt-unreachable in arrival → COMMIT 60; hold + margin&lt;cont → 55. Tier ladder: MAYDAY ≥ 92 OR &lt;0margin / MINFUEL ≥ 75 / COMMIT ≥ 55 OR alt-unreach / WATCH ≥ 30 / NOMINAL &lt; 30.</div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› LIMITATIONS</div>
              <div className="text-[10px] text-slate-400">No live FQI feed (FOB synthesised). No WX-rerouting impact. No live alternate WX (CAT minima). No operator-specific OpSpec overlays (e.g. United UAL-EOD-FUEL-2024 contingency = 7%). No ETOPS extra-burn for engine-out cruise. Holding endurance assumes clean configuration. Not certified for dispatch decisions — overlay is observational/educational only.</div>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-1.5 border-t border-slate-700/60 text-[9px] text-slate-500 flex items-center justify-between">
        <span>FUELPOL · sky-500 accent · MAYDAY ≥ {sumMayday}</span>
        <span className="font-mono">Annex 6 §4.3.7 · Doc 4444 §15.1.4</span>
      </div>
    </div>
  )
}
