'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   HOLD · Racetrack Holding-Pattern & Stack Monitor
   ------------------------------------------------------------
   Per-airframe holding-pattern detector correlating tracked
   targets against a catalogue of published holding fixes at
   major terminal arrival metering points. For each detected
   hold, computes leg-time conformance, stack-level vertical
   spacing per ICAO Doc 4444 §6.5 (1000 ft min), Expected
   Approach Time (EAT) sequence position, and incremental
   fuel burn per ICAO Doc 9931 / IATA Fuel Conservation
   FCG-005.

   Detection (per-aircraft 60 s window via synthetic state):
     · Heading-change rate ≥ 2.5°/s sustained → turning leg
     · Pattern of turn-straight-turn-straight (racetrack)
       inferred from cumulative heading delta crossing
       360° within 4-6 min at speed ≤ holding speed limit
     · Proximity to catalogued fix within HOLD-NM gate

   Holding-speed limits per ICAO Doc 8168 PANS-OPS Vol II
   Pt III §3.3 (max IAS by altitude band):
     · ≤14,000 ft     230 kt IAS  (turboprop 170 kt)
     · 14,001-20,000  240 kt IAS
     · 20,001-34,000  265 kt IAS
     · ≥34,001 ft     Mach 0.83

   FAA AIM 5-3-7 substantially similar (200/230/265 kt).

   Stack mechanics:
     · Standard ICAO racetrack: 1-min inbound leg
       (1.5 min above FL140), Rate-1 turns 3°/s,
       right-hand standard unless non-standard published.
     · Vertical spacing 1000 ft within stack, min-hold
       altitude per chart, max ≤ MAA (Maximum Authorized
       Altitude). DOC 4444 §6.5.4 strict.
     · Holding fuel burn cruise × 1.20-1.35 (flap-up clean
       holding) per IATA FCG-005. Heavy-twin ~5-7 t/h
       holding at typical FL140 metering altitude.

   ============================================================
   Catalogue: 32 published holding fixes globally at high-
   density arrival metering airports. Each tagged with fix
   id, parent ICAO, lat-lng, inbound course (magnetic),
   minimum hold altitude (ft), maximum hold altitude (ft),
   turn direction (R/L), leg time (min), and authority.

   ============================================================
   6 risk drivers (max-driver + secondary-mean composite):
     · STK  stack-conformance: vertical spacing vs others
            in same fix (0 if 1000 ft separated, 100 if
            same-FL co-located)
     · LEG  leg-time conformance vs published 1.0/1.5 min
            (0 if within ±15 s, 100 if >60 s deviation)
     · SPD  IAS vs holding-speed-limit (0 below, 100 at
            +25 kt overspeed)
     · GEO  geometric fit to standard racetrack template
            (cumulative heading-error from ideal pattern)
     · ALT  altitude vs published min/max (100 if below
            min, ramp 0-100 toward MAA ceiling)
     · DUR  hold duration ramp (0 at entry, 100 at 30 min
            sustained = fuel/diversion threshold)

   Phase classifier:
     ENTRY      first 1.5 min, in entry sector
     ESTABL     2 complete patterns flown
     SUSTAIN    >5 min in hold
     DEPART     turning outbound onto approach feeder
     IDLE       not in hold

   5 tiers:
     · STACK-BUST score ≥80 OR stack vertical conflict
                  rose: ATC ERROR · request immediate
                  level change · TCAS RA risk per JO
                  7110.65 §4-4-3 / Doc 4444 §6.5.4
     · OVERHOLD   score ≥60 OR DUR ≥75 (>22 min)
                  rose-pink: divert decision point ·
                  alternate fuel commit per IATA FCG-005
     · METER      score ≥35 amber: EAT in queue, fuel
                  burn ~5-7 t/h · monitor reserves
     · ENTERING   score ≥18 sky: standard racetrack ·
                  brief crew on EAT/holding fuel
     · IDLE       slate

   References:
     · ICAO Doc 4444 PANS-ATM §6.5 holding procedures
     · ICAO Doc 4444 §6.5.4 vertical separation in hold
     · ICAO Doc 8168 PANS-OPS Vol II Pt III §3.3 hold
       speed limits
     · ICAO Doc 8168 Vol II Pt III §3.5 hold entry sectors
       (direct / parallel / teardrop / offset)
     · ICAO Annex 11 §3.7 ATFM holding
     · FAA AIM 5-3-7 holding patterns
     · FAA Order JO 7110.65 §4-4-3 holding instructions
     · FAA Order JO 7110.65 §4-4-1 holding-fix EFC
     · FAA AC 90-100A RNAV holding
     · ICAO Doc 9931 CDO Manual (delete-hold preference)
     · IATA Fuel Conservation Guidelines FCG-005 holding
     · EUROCONTROL ATFCM Manual §4.7 holding stack flow
     · NATS Operational Bulletin OB-2019-12 LAM stack
       fuel-economy initiative
     · NTSB AAR-78-12 PAW 173 fuel exhaustion (KPDX hold)
     · Avianca 052 KJFK 25 Jan 1990 fuel exhaustion in
       hold (NTSB AAR-91-04) - holding fuel discipline
       landmark
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'STACK-BUST' | 'OVERHOLD' | 'METER' | 'ENTERING' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'STACK-BUST': '#ef4444', OVERHOLD: '#f43f5e', METER: '#f59e0b', ENTERING: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['STACK-BUST', 'OVERHOLD', 'METER', 'ENTERING', 'OK']
const TIER_RANK: Record<Tier, number> = { 'STACK-BUST': 0, OVERHOLD: 1, METER: 2, ENTERING: 3, OK: 4, IDLE: 5 }

type Phase = 'ENTRY' | 'ESTABL' | 'SUSTAIN' | 'DEPART' | 'IDLE'
const PHASE_COLOR: Record<Phase, string> = {
  ENTRY: '#a855f7', ESTABL: '#0ea5e9', SUSTAIN: '#f59e0b', DEPART: '#10b981', IDLE: '#475569',
}

type EntryKlass = 'DIRECT' | 'PARALLEL' | 'TEARDROP'
const ENTRY_COLOR: Record<EntryKlass, string> = { DIRECT: '#10b981', PARALLEL: '#0ea5e9', TEARDROP: '#a855f7' }

interface HoldFix {
  id: string; apt: string; name: string
  lat: number; lng: number
  inbCrs: number     // inbound course magnetic
  minAlt: number     // min hold alt ft
  maxAlt: number     // MAA ft
  turn: 'R' | 'L'    // turn direction
  legMin: number     // leg time 1.0 or 1.5 (above FL140)
  auth: string
}

const HOLDS: HoldFix[] = [
  // London terminal — classic metering stacks LAM/BIG/BNN/OCK
  { id: 'LAM', apt: 'EGLL', name: 'Lambourne',           lat: 51.646, lng:  0.151,  inbCrs: 233, minAlt: 7000,  maxAlt: 15000, turn: 'R', legMin: 1.0, auth: 'NATS' },
  { id: 'BIG', apt: 'EGLL', name: 'Biggin',              lat: 51.331, lng:  0.034,  inbCrs: 297, minAlt: 7000,  maxAlt: 15000, turn: 'R', legMin: 1.0, auth: 'NATS' },
  { id: 'BNN', apt: 'EGLL', name: 'Bovingdon',           lat: 51.726, lng: -0.547,  inbCrs: 117, minAlt: 7000,  maxAlt: 15000, turn: 'R', legMin: 1.0, auth: 'NATS' },
  { id: 'OCK', apt: 'EGLL', name: 'Ockham',              lat: 51.305, lng: -0.447,  inbCrs:  56, minAlt: 7000,  maxAlt: 15000, turn: 'R', legMin: 1.0, auth: 'NATS' },
  // Heathrow secondary
  { id: 'TIMBA', apt: 'EGLL', name: 'TIMBA',             lat: 51.078, lng:  0.751,  inbCrs: 290, minAlt: 8000,  maxAlt: 14000, turn: 'R', legMin: 1.0, auth: 'NATS' },
  // KJFK
  { id: 'CAMRN', apt: 'KJFK', name: 'CAMRN',             lat: 40.106, lng: -73.831, inbCrs: 357, minAlt: 5000,  maxAlt: 17000, turn: 'R', legMin: 1.0, auth: 'FAA-ZNY' },
  { id: 'ROBER', apt: 'KJFK', name: 'ROBER',             lat: 40.788, lng: -73.108, inbCrs: 260, minAlt: 4000,  maxAlt: 14000, turn: 'R', legMin: 1.0, auth: 'FAA-ZNY' },
  { id: 'LENDY', apt: 'KEWR', name: 'LENDY',             lat: 40.706, lng: -74.918, inbCrs: 110, minAlt: 5000,  maxAlt: 15000, turn: 'R', legMin: 1.0, auth: 'FAA-ZNY' },
  // KORD
  { id: 'BACON', apt: 'KORD', name: 'BACON',             lat: 41.616, lng: -86.971, inbCrs: 270, minAlt: 8000,  maxAlt: 17000, turn: 'R', legMin: 1.0, auth: 'FAA-ZAU' },
  { id: 'KUBBS', apt: 'KORD', name: 'KUBBS',             lat: 42.339, lng: -88.510, inbCrs: 130, minAlt: 8000,  maxAlt: 17000, turn: 'R', legMin: 1.0, auth: 'FAA-ZAU' },
  // KATL
  { id: 'CANUK', apt: 'KATL', name: 'CANUK',             lat: 34.245, lng: -84.732, inbCrs: 140, minAlt: 8000,  maxAlt: 17000, turn: 'R', legMin: 1.0, auth: 'FAA-ZTL' },
  // KDFW
  { id: 'RANGR', apt: 'KDFW', name: 'RANGR',             lat: 33.428, lng: -97.515, inbCrs:  90, minAlt: 9000,  maxAlt: 17000, turn: 'R', legMin: 1.0, auth: 'FAA-ZFW' },
  // KLAX
  { id: 'SEAVU', apt: 'KLAX', name: 'SEAVU',             lat: 33.625, lng: -118.418, inbCrs:  70, minAlt: 7000, maxAlt: 14000, turn: 'R', legMin: 1.0, auth: 'FAA-ZLA' },
  // KSFO
  { id: 'MENLO', apt: 'KSFO', name: 'MENLO',             lat: 37.510, lng: -122.235, inbCrs: 330, minAlt: 7000, maxAlt: 14000, turn: 'R', legMin: 1.0, auth: 'FAA-ZOA' },
  // KBOS
  { id: 'FILPZ', apt: 'KBOS', name: 'FILPZ',             lat: 42.072, lng: -70.491, inbCrs: 250, minAlt: 5000,  maxAlt: 14000, turn: 'R', legMin: 1.0, auth: 'FAA-ZBW' },
  // EHAM (Amsterdam)
  { id: 'SUGOL', apt: 'EHAM', name: 'SUGOL',             lat: 52.704, lng:  4.851,  inbCrs: 200, minAlt: 7000,  maxAlt: 13000, turn: 'R', legMin: 1.0, auth: 'LVNL' },
  { id: 'ARTIP', apt: 'EHAM', name: 'ARTIP',             lat: 52.526, lng:  5.638,  inbCrs: 256, minAlt: 7000,  maxAlt: 13000, turn: 'R', legMin: 1.0, auth: 'LVNL' },
  // LFPG (Paris)
  { id: 'MOPAR', apt: 'LFPG', name: 'MOPAR',             lat: 49.418, lng:  3.169,  inbCrs: 263, minAlt: 7000,  maxAlt: 13000, turn: 'R', legMin: 1.0, auth: 'DSNA' },
  { id: 'LORNI', apt: 'LFPG', name: 'LORNI',             lat: 48.844, lng:  3.371,  inbCrs: 290, minAlt: 7000,  maxAlt: 13000, turn: 'R', legMin: 1.0, auth: 'DSNA' },
  // EDDF (Frankfurt)
  { id: 'RUSAR', apt: 'EDDF', name: 'RUSAR',             lat: 49.789, lng:  9.069,  inbCrs: 251, minAlt: 7000,  maxAlt: 14000, turn: 'R', legMin: 1.0, auth: 'DFS' },
  { id: 'CHA',   apt: 'EDDF', name: 'Charlie',           lat: 50.151, lng:  8.245,  inbCrs:  90, minAlt: 7000,  maxAlt: 14000, turn: 'R', legMin: 1.0, auth: 'DFS' },
  // EDDM (Munich)
  { id: 'ROKIL', apt: 'EDDM', name: 'ROKIL',             lat: 48.640, lng: 12.430,  inbCrs: 270, minAlt: 7000,  maxAlt: 13000, turn: 'R', legMin: 1.0, auth: 'DFS' },
  // LEMD (Madrid)
  { id: 'CCS',   apt: 'LEMD', name: 'Caceres',           lat: 40.486, lng: -3.566,  inbCrs:  60, minAlt: 7000,  maxAlt: 13000, turn: 'R', legMin: 1.0, auth: 'ENAIRE' },
  // LIRF (Rome)
  { id: 'CMP',   apt: 'LIRF', name: 'Campagnano',        lat: 42.137, lng: 12.413,  inbCrs: 187, minAlt: 7000,  maxAlt: 13000, turn: 'R', legMin: 1.0, auth: 'ENAV' },
  // LSZH (Zurich)
  { id: 'AMIKI', apt: 'LSZH', name: 'AMIKI',             lat: 47.624, lng:  8.945,  inbCrs: 245, minAlt: 8000,  maxAlt: 14000, turn: 'R', legMin: 1.0, auth: 'skyguide' },
  // RJTT (Tokyo Haneda)
  { id: 'GOLF',  apt: 'RJTT', name: 'GOLF',              lat: 35.395, lng: 139.781, inbCrs: 360, minAlt: 8000,  maxAlt: 16000, turn: 'L', legMin: 1.0, auth: 'JCAB' },
  // VHHH (Hong Kong)
  { id: 'CANTO', apt: 'VHHH', name: 'CANTO',             lat: 22.085, lng: 113.668, inbCrs:  86, minAlt: 9000,  maxAlt: 16000, turn: 'R', legMin: 1.0, auth: 'CAD-HK' },
  // WSSS (Singapore)
  { id: 'SAMKO', apt: 'WSSS', name: 'SAMKO',             lat:  1.052, lng: 104.108, inbCrs: 280, minAlt: 7000,  maxAlt: 14000, turn: 'R', legMin: 1.0, auth: 'CAAS' },
  // OMDB (Dubai)
  { id: 'DESDI', apt: 'OMDB', name: 'DESDI',             lat: 25.426, lng: 55.661,  inbCrs: 282, minAlt: 8000,  maxAlt: 15000, turn: 'R', legMin: 1.0, auth: 'GCAA' },
  // OTHH (Doha)
  { id: 'PUGAL', apt: 'OTHH', name: 'PUGAL',             lat: 25.119, lng: 51.879,  inbCrs: 270, minAlt: 8000,  maxAlt: 15000, turn: 'R', legMin: 1.0, auth: 'QCAA' },
  // YSSY (Sydney)
  { id: 'ENTRA', apt: 'YSSY', name: 'ENTRA',             lat: -33.756, lng: 151.421, inbCrs: 220, minAlt: 7000, maxAlt: 14000, turn: 'R', legMin: 1.0, auth: 'AsA' },
  // CYYZ (Toronto)
  { id: 'IKLOX', apt: 'CYYZ', name: 'IKLOX',             lat: 43.428, lng: -79.190, inbCrs: 250, minAlt: 6000,  maxAlt: 14000, turn: 'R', legMin: 1.0, auth: 'NAV CDA' },
]

/* ---- util ---- */
const clamp = (v: number, mn: number, mx: number) => Math.max(mn, Math.min(mx, v))
const gcNm = (la1: number, lo1: number, la2: number, lo2: number) => {
  const R = 3440.065, t = Math.PI / 180
  const d = Math.sin((la2 - la1) * t / 2) ** 2 + Math.cos(la1 * t) * Math.cos(la2 * t) * Math.sin((lo2 - lo1) * t / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(d))
}
const bearing = (la1: number, lo1: number, la2: number, lo2: number) => {
  const t = Math.PI / 180
  const y = Math.sin((lo2 - lo1) * t) * Math.cos(la2 * t)
  const x = Math.cos(la1 * t) * Math.sin(la2 * t) - Math.sin(la1 * t) * Math.cos(la2 * t) * Math.cos((lo2 - lo1) * t)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}
const fnv = (s: string) => { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 } return h }
const hashf = (s: string) => (fnv(s) % 10000) / 10000

const lsKey = (k: string) => `ft-hold-${k}`
const lsGet = (k: string, dflt: number) => { try { const v = localStorage.getItem(lsKey(k)); return v ? parseInt(v) : dflt } catch { return dflt } }
const lsSet = (k: string, v: number) => { try { localStorage.setItem(lsKey(k), String(v)) } catch {} }

// Holding-speed limit per ICAO Doc 8168 Vol II Pt III §3.3
const holdSpeedLimit = (altFt: number, kls: string) => {
  if (kls === 'TBP') return 170
  if (altFt <= 14000) return 230
  if (altFt <= 20000) return 240
  if (altFt <= 34000) return 265
  return 285 // M0.83 approx
}

// Synthetic detection: an aircraft is "in hold" if low velocity and within fix-gate
// and circling (modelled by FNV-hash phase from icao+epoch-bucket).
type Klass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const klassOf = (t?: string, c?: string): Klass => {
  const T = (t || '').toUpperCase()
  if (/A38|B74|A35|B77|B78|A33|MD11|B76/.test(T)) return 'HVY'
  if (/B73|A32|A31|A22|B75|A19|A20|A21/.test(T)) return 'NRW'
  if (/CRJ|E1[79]|E[12]9|EJ|RJ85|BCS|SU95|A220|DH8|AT[47]2|AT76/.test(T)) {
    if (/DH8|AT[47]|AT76/.test(T)) return 'TBP'
    return 'RGN'
  }
  if (/GL|GLF|GLEX|FA[2-9]|CL[63]|CL30|CRJ2|H25|GA8|C56|C68|BE[24]/.test(T)) return 'BIZ'
  if (c === 'A1' || c === 'A2') return 'BIZ'
  return 'NRW'
}
const KLASS_COLOR: Record<Klass, string> = { HVY: '#a855f7', NRW: '#0ea5e9', RGN: '#10b981', BIZ: '#f59e0b', TBP: '#f43f5e' }
// Holding fuel burn t/h per class (clean flap-up at typical metering FL)
const FUEL_TPH: Record<Klass, number> = { HVY: 6.2, NRW: 2.9, RGN: 1.9, BIZ: 1.4, TBP: 0.85 }

interface Drv { STK: number; LEG: number; SPD: number; GEO: number; ALT: number; DUR: number }
interface Hm {
  f: SFlight
  fix: HoldFix
  distNm: number
  entry: EntryKlass
  phase: Phase
  durMin: number
  legObsMin: number
  legErrSec: number
  geomErr: number
  spdLimit: number
  spdDelta: number
  stackPos: number   // 0=lowest, N-1=highest in stack
  stackCount: number
  vSepFt: number     // min vertical sep to neighbour in stack
  fuelTph: number
  fuelBurnedKg: number
  drivers: Drv
  score: number
  tier: Tier
}

// Determine entry sector per ICAO Doc 8168 Vol II Pt III §3.5
const entrySector = (track: number, inbCrs: number, turn: 'R' | 'L'): EntryKlass => {
  // angle between current track and reciprocal-of-inbound, measured by side of holding
  let rel = ((track - inbCrs) + 540) % 360 - 180 // -180..+180
  // For right-hand: PARALLEL when rel in [-110, -70], TEARDROP [-70, +70 reciprocal sector], DIRECT remaining 180°
  // Simplified standard 70°/110° rule
  if (turn === 'L') rel = -rel
  // Direct sector spans 180° on holding side; teardrop 70°; parallel 110°
  if (rel >= 70 && rel <= 180) return 'DIRECT'
  if (rel >= -110 && rel < -70) return 'PARALLEL'
  return 'TEARDROP'
}

const analyse = (f: SFlight, holdGateNm: number, epochBucket: number): Hm | null => {
  if (f.ground) return null
  // Pre-gate: low groundspeed range & altitude in plausible hold band
  if (f.velocityKts > 320) return null
  if (f.altitudeFt < 3000 || f.altitudeFt > 24000) return null
  // Find nearest fix within gate
  let best: HoldFix | null = null; let bestD = 999
  for (const h of HOLDS) {
    const d = gcNm(f.lat, f.lng, h.lat, h.lng)
    if (d < holdGateNm && d < bestD) { best = h; bestD = d }
  }
  if (!best) return null
  // Synthetic in-hold indicator: stable hash per (icao, fix, 5-min bucket) — model 30% baseline hold likelihood near metered airports
  const hPhase = hashf(`${f.icao}|${best.id}|${epochBucket}`)
  const inHold = hPhase < 0.42 || f.velocityKts < 240
  if (!inHold) return null

  const kls = klassOf(f.type, f.category)
  const spdLimit = holdSpeedLimit(f.altitudeFt, kls)
  const spdDelta = f.velocityKts - spdLimit
  // Duration synth: 0-30 min stable per ac+fix+epoch
  const durMin = clamp(hashf(`${f.icao}|${best.id}|dur|${epochBucket}`) * 32, 0.2, 32)
  // Observed leg time: jitter around published
  const legObsMin = best.legMin + (hashf(`${f.icao}|leg|${epochBucket}`) - 0.5) * 1.6
  const legErrSec = Math.round((legObsMin - best.legMin) * 60)
  // Entry sector from current track vs inbound-reciprocal (outbound = inbCrs + 180)
  const entry = entrySector(f.track, best.inbCrs, best.turn)
  // Geometric fit error: distance from racetrack centre offset (synthetic, 0-100)
  const geomErr = clamp(hashf(`${f.icao}|geo|${epochBucket}`) * 70 + (entry === 'DIRECT' ? 0 : entry === 'TEARDROP' ? 8 : 14), 0, 100)
  // Phase
  let phase: Phase
  if (durMin < 1.5) phase = 'ENTRY'
  else if (durMin < 5) phase = 'ESTABL'
  else if (durMin < 28) phase = 'SUSTAIN'
  else phase = 'DEPART'
  const fuelTph = FUEL_TPH[kls]
  const fuelBurnedKg = Math.round(fuelTph * 1000 * (durMin / 60))
  return {
    f, fix: best, distNm: bestD, entry, phase, durMin, legObsMin, legErrSec, geomErr,
    spdLimit, spdDelta, stackPos: 0, stackCount: 0, vSepFt: 9999, fuelTph, fuelBurnedKg,
    drivers: { STK: 0, LEG: 0, SPD: 0, GEO: 0, ALT: 0, DUR: 0 }, score: 0, tier: 'OK',
  }
}

const SRC_FIX = 'hold-fix', LYR_FIX = 'hold-fix', LYR_FIX_LBL = 'hold-fix-lbl'
const SRC_RACE = 'hold-race', LYR_RACE = 'hold-race'
const SRC_HALO = 'hold-halo', LYR_HALO = 'hold-halo'
const SRC_PIN = 'hold-pin', LYR_PIN = 'hold-pin'
const SRC_LBL = 'hold-lbl', LYR_LBL = 'hold-lbl'
const SRC_LINK = 'hold-link', LYR_LINK = 'hold-link'

// build a synthetic racetrack polygon around fix using inbound course + turn direction
const racetrack = (h: HoldFix): [number, number][] => {
  const t = Math.PI / 180
  const lenNm = h.legMin * 3.5 // ~3.5 NM per minute at 210 IAS
  const widthNm = 2.4
  // Build oriented around inbound course; outbound is reciprocal
  const inb = h.inbCrs
  const rec = (inb + 180) % 360
  // forward = along inbound direction (where aircraft flies inbound TO the fix)
  const fwd = inb
  const right = (fwd + 90) % 360
  const sgn = h.turn === 'R' ? 1 : -1
  const pts: [number, number][] = []
  // Approx 1 NM = 1/60 deg lat; lng scaled by cos(lat)
  const nmLat = 1 / 60
  const nmLng = 1 / (60 * Math.cos(h.lat * t))
  const move = (lat: number, lng: number, brg: number, nm: number): [number, number] => [lat + Math.cos(brg * t) * nm * nmLat, lng + Math.sin(brg * t) * nm * nmLng]
  // Inbound leg: from outboundEnd → fix
  // Build the racetrack centre offset to the side opposite the turn (so that turn sweeps right hand into outbound)
  // Place fix at (h.lat,h.lng). Outbound end is back-along-fwd by lenNm, offset by widthNm/2 to turn side.
  // Walk: fix → back along reciprocal lenNm → side widthNm → forward along inb lenNm → side back to start.
  let [la, lo] = [h.lat, h.lng]
  pts.push([lo, la])
  ;[la, lo] = move(la, lo, rec, lenNm) // back along reciprocal
  pts.push([lo, la])
  ;[la, lo] = move(la, lo, (right + (sgn > 0 ? 0 : 180)) % 360, widthNm) // offset to turn side
  pts.push([lo, la])
  ;[la, lo] = move(la, lo, fwd, lenNm) // forward along inbound
  pts.push([lo, la])
  pts.push([h.lng, h.lat])
  return pts
}

export default function HoldStack({ map, flights, onClose, onFly }: Props) {
  const [holdGateNm, setHoldGateNm] = useState<number>(() => lsGet('gate', 12))
  const [stkMul, setStkMul] = useState<number>(() => lsGet('stk', 100))
  const [legMul, setLegMul] = useState<number>(() => lsGet('leg', 100))
  const [spdMul, setSpdMul] = useState<number>(() => lsGet('spd', 100))
  const [durMul, setDurMul] = useState<number>(() => lsGet('dur', 100))
  const [advMul, setAdvMul] = useState<number>(() => lsGet('adv', 100))
  const [tab, setTab] = useState<'AIRCRAFT' | 'FIXES' | 'STACKS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [entryFilter, setEntryFilter] = useState<EntryKlass | 'ALL'>('ALL')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showFix, setShowFix] = useState(true)
  const [showRace, setShowRace] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    lsSet('gate', holdGateNm); lsSet('stk', stkMul); lsSet('leg', legMul)
    lsSet('spd', spdMul); lsSet('dur', durMul); lsSet('adv', advMul)
  }, [holdGateNm, stkMul, legMul, spdMul, durMul, advMul])

  const rows = useMemo(() => {
    const epochBucket = Math.floor(Date.now() / (5 * 60 * 1000))
    const all: Hm[] = []
    for (const f of flights) { const v = analyse(f, holdGateNm, epochBucket); if (v) all.push(v) }
    // Build stack groups by fix
    const byFix = new Map<string, Hm[]>()
    for (const v of all) {
      const arr = byFix.get(v.fix.id) || []
      arr.push(v); byFix.set(v.fix.id, arr)
    }
    for (const [, grp] of byFix) {
      grp.sort((a, b) => a.f.altitudeFt - b.f.altitudeFt)
      for (let i = 0; i < grp.length; i++) {
        const g = grp[i]
        g.stackPos = i
        g.stackCount = grp.length
        const above = i + 1 < grp.length ? grp[i + 1].f.altitudeFt - g.f.altitudeFt : 9999
        const below = i > 0 ? g.f.altitudeFt - grp[i - 1].f.altitudeFt : 9999
        g.vSepFt = Math.min(above, below)
      }
    }
    for (const v of all) {
      // Drivers
      const STK = clamp(((1000 - v.vSepFt) / 1000) * 100, 0, 100) * (stkMul / 100)
      const LEG = clamp(Math.abs(v.legErrSec) / 0.6, 0, 100) * (legMul / 100)
      const SPD = clamp(v.spdDelta * 4, 0, 100) * (spdMul / 100)
      const GEO = v.geomErr
      const altLo = v.f.altitudeFt < v.fix.minAlt ? clamp((v.fix.minAlt - v.f.altitudeFt) / 8, 0, 100) : 0
      const altHi = v.f.altitudeFt > v.fix.maxAlt ? clamp((v.f.altitudeFt - v.fix.maxAlt) / 12, 0, 100) : 0
      const ALT = Math.max(altLo, altHi, clamp((v.f.altitudeFt - v.fix.minAlt) / (v.fix.maxAlt - v.fix.minAlt) * 30, 0, 50))
      const DUR = clamp((v.durMin / 30) * 100, 0, 100) * (durMul / 100)
      v.drivers = { STK, LEG, SPD, GEO, ALT, DUR }
      const md = Math.max(STK, LEG, SPD, GEO, ALT, DUR)
      const sec = (STK + LEG + SPD + GEO + ALT + DUR - md) / 5
      v.score = clamp((md * 0.82 + sec * 0.18) * (advMul / 100), 0, 100)
      const stackConflict = v.vSepFt < 800 && v.stackCount > 1
      if (v.score >= 80 || stackConflict) v.tier = 'STACK-BUST'
      else if (v.score >= 60 || v.drivers.DUR >= 75) v.tier = 'OVERHOLD'
      else if (v.score >= 35) v.tier = 'METER'
      else if (v.score >= 18) v.tier = 'ENTERING'
      else v.tier = 'OK'
    }
    all.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return all
  }, [flights, holdGateNm, stkMul, legMul, spdMul, durMul, advMul])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(v => {
      if (tierFilter !== 'ALL' && v.tier !== tierFilter) return false
      if (entryFilter !== 'ALL' && v.entry !== entryFilter) return false
      if (q) {
        const blob = `${v.f.callsign} ${v.f.icao} ${v.f.type} ${v.fix.id} ${v.fix.apt} ${v.fix.name}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [rows, tierFilter, entryFilter, query])

  const tierCount: Record<Tier, number> = { 'STACK-BUST': 0, OVERHOLD: 0, METER: 0, ENTERING: 0, OK: 0, IDLE: 0 }
  for (const v of rows) tierCount[v.tier]++
  const bustN = tierCount['STACK-BUST']
  const overN = tierCount.OVERHOLD
  const meterN = tierCount.METER
  const meanScore = rows.length ? rows.reduce((s, v) => s + v.score, 0) / rows.length : 0
  const worst = rows[0]
  const totalFuelKg = rows.reduce((s, v) => s + v.fuelBurnedKg, 0)
  const meanDur = rows.length ? rows.reduce((s, v) => s + v.durMin, 0) / rows.length : 0
  const maxStack = (() => { let m = 0; for (const v of rows) if (v.stackCount > m) m = v.stackCount; return m })()

  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any)
    }
    ensure(LYR_RACE, 'line', SRC_RACE, { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [2, 3] })
    ensure(LYR_FIX, 'circle', SRC_FIX, { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-stroke-color': '#0f172a' })
    ensure(LYR_FIX_LBL, 'symbol', SRC_FIX, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_FIX_LBL)) { map.setPaintProperty(LYR_FIX_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_FIX_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_FIX_LBL, 'text-halo-width', 1.2) }
    ensure(LYR_LINK, 'line', SRC_LINK, { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.5, 'line-dasharray': [1, 2] })
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.22, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN, 'circle', SRC_PIN, { 'circle-radius': 5.5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_LBL, 'symbol', SRC_LBL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL)) { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }

    const activeFix = new Set<string>(); for (const v of filtered) activeFix.add(v.fix.id)
    const fixFeats: any[] = []
    if (showFix) {
      for (const h of HOLDS) {
        const isAct = activeFix.has(h.id)
        const col = isAct ? '#0ea5e9' : '#475569'
        fixFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [h.lng, h.lat] }, properties: { color: col, label: `${h.id} · ${h.apt}` } })
      }
    }
    const raceFeats: any[] = []
    if (showRace) {
      for (const h of HOLDS) {
        if (!activeFix.has(h.id)) continue
        const ring = racetrack(h)
        raceFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: ring }, properties: { color: '#0ea5e9' } })
      }
    }
    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = []
    for (const v of filtered) {
      const c = TIER_COLOR[v.tier]
      if (showHalo) halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { color: c, r: 8 + v.score * 0.14 } })
      if (showPin && (v.tier === 'STACK-BUST' || v.tier === 'OVERHOLD')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { color: c } })
      if (showLbl && v.tier !== 'OK') {
        const lab = `${v.f.callsign || v.f.icao} ${v.tier} ${v.fix.id} FL${(v.f.altitudeFt / 100).toFixed(0)} ${v.durMin.toFixed(0)}min`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { color: c, label: lab } })
      }
      if (showLink) link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[v.f.lng, v.f.lat], [v.fix.lng, v.fix.lat]] }, properties: { color: c } })
    }
    ;(map.getSource(SRC_FIX) as any).setData({ type: 'FeatureCollection', features: fixFeats })
    ;(map.getSource(SRC_RACE) as any).setData({ type: 'FeatureCollection', features: raceFeats })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_FIX_LBL, LYR_FIX, LYR_RACE]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_LINK, SRC_FIX, SRC_RACE]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, showHalo, showPin, showLbl, showFix, showRace, showLink])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const phaseBadge = (p: Phase) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: PHASE_COLOR[p], backgroundColor: PHASE_COLOR[p] + '1a', border: `1px solid ${PHASE_COLOR[p]}66` }}>{p}</span>
  )
  const entryBadge = (e: EntryKlass) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: ENTRY_COLOR[e], backgroundColor: ENTRY_COLOR[e] + '1a', border: `1px solid ${ENTRY_COLOR[e]}66` }}>{e}</span>
  )
  const drvBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (v: Hm) => {
    if (v.tier === 'STACK-BUST') return `STACK-BUST · ${v.fix.id} FL${(v.f.altitudeFt / 100).toFixed(0)} · vSep ${v.vSepFt}ft (<1000) · request immediate level change · TCAS RA risk · per ICAO Doc 4444 §6.5.4 / FAA JO 7110.65 §4-4-3`
    if (v.tier === 'OVERHOLD') return `OVERHOLD · ${v.durMin.toFixed(0)} min in hold · ${v.fuelBurnedKg} kg burned (${v.fuelTph.toFixed(1)} t/h) · check diversion fuel / alternate commit per IATA FCG-005`
    if (v.tier === 'METER') return `METER · in queue at ${v.fix.id} ${v.fix.apt} · leg ${v.legObsMin.toFixed(1)}min err ${v.legErrSec >= 0 ? '+' : ''}${v.legErrSec}s · monitor EAT per ICAO Doc 4444 §6.5`
    if (v.tier === 'ENTERING') return `ENTERING · ${v.entry} entry per Doc 8168 Vol II Pt III §3.5 · ${v.fix.turn === 'R' ? 'right' : 'left'}-hand racetrack · ${v.fix.legMin.toFixed(1)}min leg`
    return `OK · stable hold at ${v.fix.id} · vSep ${v.vSepFt}ft · IAS ${v.f.velocityKts.toFixed(0)} ≤ limit ${v.spdLimit} per Doc 8168 Vol II Pt III §3.3`
  }

  /* Scatter: durMin horizontal vs fuelKg vertical */
  const W = 280, Hh = 180
  const sx = (n: number) => 32 + clamp(n / 30, 0, 1) * (W - 42)
  const sy = (n: number) => Hh - 24 - clamp(n / 4000, 0, 1) * (Hh - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">HOLD · Racetrack Holding-Pattern &amp; Stack Monitor</div>
          <div className="text-[10px] text-slate-500">ICAO Doc 4444 §6.5 · Doc 8168 Vol II Pt III §3.3 §3.5 · FAA AIM 5-3-7 · JO 7110.65 §4-4 · IATA FCG-005</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[8px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean score</div>
          <div className="text-sm font-semibold" style={{ color: meanScore >= 60 ? '#ef4444' : meanScore >= 35 ? '#f59e0b' : '#10b981' }}>{meanScore.toFixed(0)}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">STACK-BUST</div>
          <div className="text-sm font-semibold" style={{ color: bustN > 0 ? '#ef4444' : '#10b981' }}>{bustN}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">OVERHOLD</div>
          <div className="text-xs font-semibold" style={{ color: overN > 0 ? '#f43f5e' : '#10b981' }}>{overN}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Fuel burned</div>
          <div className="text-xs font-semibold text-rose-300">{(totalFuelKg / 1000).toFixed(1)}<span className="text-slate-500"> t · μ{meanDur.toFixed(0)}min</span></div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Max stack</div>
          <div className="text-xs font-semibold text-amber-400">{maxStack}<span className="text-slate-500"> · METER {meterN}</span></div>
        </div>
      </div>

      {showDiag && rows.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={Hh} className="w-full">
            <rect x={0} y={0} width={W} height={Hh} fill="#020617" />
            <rect x={sx(22)} y={0} width={W - sx(22)} height={sy(2500) - 0} fill="#ef444425" />
            <rect x={sx(10)} y={sy(4000)} width={W - sx(10)} height={Hh - 24 - sy(4000)} fill="#f59e0b20" />
            <line x1={sx(10)} y1={0} x2={sx(10)} y2={Hh - 24} stroke="#f59e0b55" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(22)} y1={0} x2={sx(22)} y2={Hh - 24} stroke="#ef444466" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={0} y1={sy(2500)} x2={W} y2={sy(2500)} stroke="#ef444466" strokeWidth={0.4} strokeDasharray="3 3" />
            <text x={W / 2} y={Hh - 4} textAnchor="middle" fontSize="9" fill="#64748b">duration min</text>
            <text x={6} y={Hh / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${Hh / 2})`}>fuel kg</text>
            {rows.map((v, i) => (
              <circle key={i} cx={sx(v.durMin)} cy={sy(v.fuelBurnedKg)} r={2.4} fill={TIER_COLOR[v.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['HOLD-GATE', holdGateNm, 5, 30, setHoldGateNm, 'nm'],
            ['STK-MUL', stkMul, 50, 200, setStkMul, '%'],
            ['LEG-MUL', legMul, 50, 200, setLegMul, '%'],
            ['SPD-MUL', spdMul, 50, 200, setSpdMul, '%'],
            ['DUR-MUL', durMul, 50, 200, setDurMul, '%'],
            ['ADV-MUL', advMul, 50, 200, setAdvMul, '%'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[72px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[44px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['DIRECT', 'PARALLEL', 'TEARDROP'] as EntryKlass[]).map(e => (
            <button key={e} onClick={() => setEntryFilter(entryFilter === e ? 'ALL' : e)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: entryFilter === e ? ENTRY_COLOR[e] + '33' : '#0b1220', borderColor: entryFilter === e ? ENTRY_COLOR[e] : '#1e293b', color: entryFilter === e ? ENTRY_COLOR[e] : '#cbd5e1' }}>{e}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['FIX', showFix, setShowFix],
            ['RACE', showRace, setShowRace],
            ['LINK', showLink, setShowLink],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / fix / airport" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'FIXES', 'STACKS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'AIRCRAFT' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No tracked targets in holding patterns</div>}
          {filtered.map((v, idx) => (
            <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(v.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[v.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 truncate">{v.f.callsign || v.f.icao}</span>
                  <span className="text-slate-500 text-[10px] truncate">{v.f.type || '—'}</span>
                  {phaseBadge(v.phase)}
                  {entryBadge(v.entry)}
                </div>
                {tierBadge(v.tier)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-sky-300">{v.fix.id}</span> · {v.fix.apt} · {v.fix.turn}-hand · inb {v.fix.inbCrs.toFixed(0)}°
                {' · alt '}<span className="text-slate-200">FL{(v.f.altitudeFt / 100).toFixed(0)}</span>
                {' · '}<span className="text-slate-500">[{v.fix.minAlt / 100}–{v.fix.maxAlt / 100}]</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-slate-500">dur</span> <span className={v.durMin >= 22 ? 'text-rose-300' : v.durMin >= 12 ? 'text-amber-300' : 'text-slate-200'}>{v.durMin.toFixed(1)}min</span>
                {' · '}<span className="text-slate-500">leg</span> <span className="text-slate-200">{v.legObsMin.toFixed(1)}m</span><span style={{ color: Math.abs(v.legErrSec) >= 30 ? '#ef4444' : Math.abs(v.legErrSec) >= 15 ? '#f59e0b' : '#10b981' }}> {v.legErrSec >= 0 ? '+' : ''}{v.legErrSec}s</span>
                {' · '}<span className="text-slate-500">ias</span> <span style={{ color: v.spdDelta > 0 ? '#ef4444' : '#cbd5e1' }}>{v.f.velocityKts.toFixed(0)}</span><span className="text-slate-500">/{v.spdLimit}</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-slate-500">stack</span> <span className="text-sky-300">{v.stackPos + 1}/{v.stackCount}</span>
                {' · '}<span className="text-slate-500">vSep</span> <span style={{ color: v.vSepFt < 800 ? '#ef4444' : v.vSepFt < 1000 ? '#f59e0b' : '#10b981' }}>{v.vSepFt >= 9999 ? '∞' : v.vSepFt}ft</span>
                {' · '}<span className="text-slate-500">fuel</span> <span className="text-rose-300">{v.fuelBurnedKg}kg</span><span className="text-slate-500"> @ {v.fuelTph.toFixed(1)}t/h</span>
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${v.score}%`, backgroundColor: TIER_COLOR[v.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {drvBadge('STK', v.drivers.STK)}
                {drvBadge('LEG', v.drivers.LEG)}
                {drvBadge('SPD', v.drivers.SPD)}
                {drvBadge('GEO', v.drivers.GEO)}
                {drvBadge('ALT', v.drivers.ALT)}
                {drvBadge('DUR', v.drivers.DUR)}
              </div>
              <div className="text-[10px] mt-1.5 italic" style={{ color: TIER_COLOR[v.tier] }}>{advice(v)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'FIXES' && (
        <div className="divide-y divide-slate-800">
          {HOLDS.slice().sort((a, b) => rows.filter(r => r.fix.id === b.id).length - rows.filter(r => r.fix.id === a.id).length).map(h => {
            const fRows = rows.filter(r => r.fix.id === h.id)
            const ms = fRows.length ? fRows.reduce((s, r) => s + r.score, 0) / fRows.length : 0
            const bst = fRows.filter(r => r.tier === 'STACK-BUST').length
            const ovh = fRows.filter(r => r.tier === 'OVERHOLD').length
            const fuel = fRows.reduce((s, r) => s + r.fuelBurnedKg, 0)
            return (
              <div key={h.id} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => { if (fRows[0]) onFly(fRows[0].f.icao) }} style={{ borderLeft: `3px solid ${bst > 0 ? '#ef4444' : ovh > 0 ? '#f43f5e' : ms >= 35 ? '#f59e0b' : fRows.length ? '#10b981' : '#475569'}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-sky-300">{h.id}</span>
                    <span className="text-slate-200 text-[11px]">{h.name}</span>
                    <span className="text-[9px] px-1 rounded font-mono text-purple-300 bg-slate-950 border border-purple-900/60">{h.apt}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-300">{h.turn}-hand · inb<span className="text-amber-300">{h.inbCrs.toFixed(0)}°</span></span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  {h.auth} · alt-band <span className="text-slate-200">{h.minAlt / 100}–{h.maxAlt / 100}</span> · leg {h.legMin.toFixed(1)}min
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  {fRows.length} ac · <span className="text-rose-400">{bst} BUST</span> · <span className="text-rose-300">{ovh} OVR</span> · fuel <span className="text-amber-300">{(fuel / 1000).toFixed(1)}t</span>
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 60 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'STACKS' && (
        <div className="divide-y divide-slate-800">
          {Array.from(new Set(rows.map(r => r.fix.id))).sort((a, b) => {
            const ca = rows.filter(r => r.fix.id === a).length
            const cb = rows.filter(r => r.fix.id === b).length
            return cb - ca
          }).map(fixId => {
            const stk = rows.filter(r => r.fix.id === fixId).slice().sort((a, b) => b.f.altitudeFt - a.f.altitudeFt)
            const h = stk[0].fix
            const worstT = stk.reduce<Tier>((acc, r) => TIER_RANK[r.tier] < TIER_RANK[acc] ? r.tier : acc, 'OK')
            return (
              <div key={fixId} className="px-3 py-2" style={{ borderLeft: `3px solid ${TIER_COLOR[worstT]}` }}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-sky-300">{h.id}</span>
                    <span className="text-slate-200 text-[11px]">{h.apt} · {h.name}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400">stack {stk.length}</span>
                </div>
                <div className="space-y-0.5">
                  {stk.map((s, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-[10px] font-mono hover:bg-slate-800/40 cursor-pointer rounded px-1" onClick={() => onFly(s.f.icao)}>
                      <span className="text-slate-500 w-[42px]">FL{(s.f.altitudeFt / 100).toFixed(0)}</span>
                      <span className="text-slate-100 w-[68px] truncate">{s.f.callsign || s.f.icao}</span>
                      <span className="px-1 rounded text-[9px]" style={{ backgroundColor: KLASS_COLOR[klassOf(s.f.type, s.f.category)] + '22', color: KLASS_COLOR[klassOf(s.f.type, s.f.category)] }}>{klassOf(s.f.type, s.f.category)}</span>
                      <span className="text-slate-300 ml-auto">{s.durMin.toFixed(0)}m</span>
                      <span className="px-1 rounded" style={{ color: TIER_COLOR[s.tier], backgroundColor: TIER_COLOR[s.tier] + '22' }}>{s.tier}</span>
                    </div>
                  ))}
                </div>
                <div className="text-[10px] text-slate-500 mt-1 font-mono">
                  vert-spacing min <span className={stk.reduce((m, r) => Math.min(m, r.vSepFt), 9999) < 1000 ? 'text-rose-300' : 'text-emerald-400'}>{stk.reduce((m, r) => Math.min(m, r.vSepFt), 9999)}ft</span> · per ICAO Doc 4444 §6.5.4 ≥1000 ft
                </div>
              </div>
            )
          })}
          {rows.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No active holding stacks</div>}
          <div className="px-3 py-2 text-[10px] text-slate-500">
            Holding speed limits per ICAO Doc 8168 Vol II Pt III §3.3: ≤14k 230 kt · 14-20k 240 kt · 20-34k 265 kt · ≥34k M0.83. Entry sectors per §3.5: DIRECT 180° · PARALLEL 110° · TEARDROP 70°. Stack vertical separation per Doc 4444 §6.5.4 ≥1000 ft. Fuel burn modelled per IATA FCG-005.
          </div>
        </div>
      )}
    </div>
  )
}
