'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   A-CDM · Airport Collaborative Decision-Making
   TOBT / TSAT / TTOT / ATOT milestone & departure pre-sequencer
   ------------------------------------------------------------
   EUROCONTROL A-CDM Implementation Manual ed.5 (2017) §3 16-milestone /
   EUROCONTROL Airport CDM Operational Concept Document ed.2.1 /
   ICAO Doc 9971 Manual on Collaborative ATM Pt II Ch 5 /
   ICAO Doc 4444 PANS-ATM §16 Flight & Flow Information /
   Commission Reg (EU) 716/2014 Pilot Common Project §AF-3 /
   EASA Decision 2017/020/R AMC1 ATM/ANS.OR.D.001 /
   FAA SCDM (Surface CDM) / TFDM (Terminal Flight Data Manager) /
   IATA Airport Handling Manual AHM 011 turn-round milestones.

   A-CDM is the pre-departure equivalent of CTOT/ATFCM. At ~30
   "A-CDM airports" (EGLL, EDDF, EHAM, LFPG, LSZH, LOWW, EDDM,
   LEMD, EGLR, LIRF, EPWA, ESSA, EFHK, LEBL, EBBR, EKCH, ENGM,
   LKPR, LGAV, LHBP, OERK, OMDB, KORD, KATL, KDFW, KJFK, KSFO,
   YSSY, RJTT, WSSS) the airport operator (APO), aircraft
   operator (AO), ground handler (GH), tower (ATC) and network
   manager (NM) share a 16-milestone timeline:

     M01 ATC FPL filed          M09 boarding start
     M02 EOBT-2h info update    M10 TOBT (Target Off-Block Time)
     M03 Take-off from origin   M11 TSAT (Target Start-up Approval)
     M04 Local radar contact    M12 boarding complete
     M05 Final approach         M13 ARDT (Actual Ready)
     M06 Landing                M14 startup request / approval
     M07 In-block at gate       M15 AOBT (Actual Off-Block) push
     M08 ground handling start  M16 ATOT (Actual Take-Off)

   The pre-sequencer balances TSAT compression vs CTOT window
   (-5/+10 min EUROCONTROL slot tolerance) to give a Target
   Take-Off Time (TTOT = TSAT + variable taxi-out time VTT per
   stand-runway combination). DPI (Departure Planning Info)
   messages T-DPI-t / T-DPI-s / A-DPI / C-DPI / X-DPI are sent
   to NM (Eurocontrol IFPS) per Reg 716/2014 §AF-3.

   This monitor takes the airborne flight list, identifies
   recent departures (vertRate>500, fl<150, near A-CDM apt
   within 80NM) and correlates each to a synthetic stand +
   milestone timeline (hash-stable per ICAO24). Stand-level
   entries are also generated for synthetic taxi-out + pushback
   queue. Output:

     · per-flight TOBT->TSAT->AOBT->ATOT compliance
     · taxi-out time vs VTT envelope (excess = pushback queue)
     · CTOT slot adherence (-5/+10 min) for slot-controlled deps
     · runway pressure index (rolling 60-min throughput vs MAP)
     · 6 risk drivers: TOB (TOBT->AOBT slip) / TSA (TSAT->AOBT)
       / TXI (taxi-out vs VTT) / CTO (CTOT breach) / RWP (runway
       pressure) / SEQ (sequence stability)
     · 6 hard tiers: SLOT-MISS / TOBT-SLIP / TAXI-OVER /
       PRESSURE / NOMINAL / IDLE

   References:
     · EUROCONTROL A-CDM Implementation Manual ed.5
     · EUROCONTROL Airport CDM Concept of Operations ed.2.1
     · EUROCONTROL ATFCM Operations Manual ed.27 ch.3 DPI
     · EUROCONTROL NM-B2B Reference Manual (DPI/FUM)
     · ICAO Doc 9971 Manual on Collaborative ATM Pt II Ch 5
     · ICAO Doc 4444 PANS-ATM §16.3 FFICE
     · ICAO Doc 9750 Global ANS Plan ASBU B0-ACDM / B1-ACDM
     · Commission Reg (EU) 716/2014 PCP §AF-3
     · Commission Implementing Reg (EU) 2019/123 Network Manager
     · EASA Decision 2017/020/R AMC1 ATM/ANS.OR.D.001
     · IATA Airport Handling Manual AHM 011 turn-round
     · FAA Surface CDM ConOps v3.0 (2014)
     · FAA TFDM Final System Description (2020)
     · SESAR PJ.04 TT Total Airport Management SPR-INTEROP
     · NATS A-CDM at EGLL Implementation Report (2014)
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'SLOT-MISS' | 'TOBT-SLIP' | 'TAXI-OVER' | 'PRESSURE' | 'NOMINAL' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'SLOT-MISS': '#ef4444', 'TOBT-SLIP': '#f43f5e', 'TAXI-OVER': '#f59e0b',
  PRESSURE: '#0ea5e9', NOMINAL: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['SLOT-MISS', 'TOBT-SLIP', 'TAXI-OVER', 'PRESSURE', 'NOMINAL']
const TIER_RANK: Record<Tier, number> = { 'SLOT-MISS': 0, 'TOBT-SLIP': 1, 'TAXI-OVER': 2, PRESSURE: 3, NOMINAL: 4, IDLE: 5 }

type Klass = 'HVY' | 'NRW' | 'RGN' | 'BIZ'
const KLASS_COLOR: Record<Klass, string> = { HVY: '#a855f7', NRW: '#0ea5e9', RGN: '#22d3ee', BIZ: '#10b981' }

interface KlassPerf { boardMin: number; pushMin: number; vttBase: number; examples: string }
const KLASS: Record<Klass, KlassPerf> = {
  HVY: { boardMin: 35, pushMin: 4.0, vttBase: 18, examples: 'B777 B787 A350 A330 B747' },
  NRW: { boardMin: 22, pushMin: 3.0, vttBase: 14, examples: 'B737 A320 B757 A220' },
  RGN: { boardMin: 16, pushMin: 2.5, vttBase: 11, examples: 'CRJ E-Jet Q400 ATR' },
  BIZ: { boardMin: 10, pushMin: 1.5, vttBase:  8, examples: 'GLF FA7X CL30 PC-24' },
}
function classify(type: string | undefined): Klass {
  const t = (type || '').toUpperCase()
  if (/^(B77[0-9]|B78[0-9]|A35[0-9]|A33[0-9]|A340|B74[0-9]|MD11|A38[0-9]|B767)$/.test(t)) return 'HVY'
  if (/^(B73[0-9]|B7M[78]|A32[0-9]|A31[89]|B757|A22[01]|A21N|A20N|A19N|BCS[123])$/.test(t)) return 'NRW'
  if (/^(CRJ[0-9]+|E[12-9][0-9]{2}|E170|E175|E190|E195|DH8[A-D]|AT4[2-7]|AT7[2-6])$/.test(t)) return 'RGN'
  if (/^(GLF[0-9]|G[2-7][0-9]{2}|FA[0-9X]+|CL[0-9]+|C[5-7][0-9]{2}|PC[0-9]+|HDJT|LJ[0-9]+)$/.test(t)) return 'BIZ'
  return 'NRW'
}

/* ---- A-CDM coordinated airport catalogue (30) ---- */
interface AcdmAp {
  icao: string; name: string; lat: number; lng: number
  stands: number          // approximate gate count
  rwyMap: number          // max acceptance rate movements / hour
  vttFloor: number        // best-case taxi-out min (closest stand to active rwy)
  vttCeil: number         // worst-case taxi-out min (far stand)
  slotPct: number         // share of departures under CTOT (ATFCM)
  cdmTier: 'A' | 'B' | 'C' // implementation maturity tier
}
const APS: AcdmAp[] = [
  { icao: 'EGLL', name: 'London Heathrow',     lat: 51.470, lng:  -0.454, stands: 220, rwyMap: 47, vttFloor: 12, vttCeil: 28, slotPct: 0.62, cdmTier: 'A' },
  { icao: 'EDDF', name: 'Frankfurt',           lat: 50.034, lng:   8.563, stands: 175, rwyMap: 56, vttFloor: 11, vttCeil: 26, slotPct: 0.58, cdmTier: 'A' },
  { icao: 'EHAM', name: 'Amsterdam Schiphol',  lat: 52.309, lng:   4.764, stands: 200, rwyMap: 60, vttFloor: 14, vttCeil: 32, slotPct: 0.55, cdmTier: 'A' },
  { icao: 'LFPG', name: 'Paris CDG',           lat: 49.013, lng:   2.550, stands: 320, rwyMap: 58, vttFloor: 15, vttCeil: 34, slotPct: 0.50, cdmTier: 'A' },
  { icao: 'LSZH', name: 'Zürich',              lat: 47.464, lng:   8.549, stands:  90, rwyMap: 36, vttFloor: 10, vttCeil: 22, slotPct: 0.48, cdmTier: 'A' },
  { icao: 'LOWW', name: 'Vienna',              lat: 48.110, lng:  16.570, stands:  96, rwyMap: 38, vttFloor:  9, vttCeil: 20, slotPct: 0.42, cdmTier: 'A' },
  { icao: 'EDDM', name: 'Munich',              lat: 48.354, lng:  11.786, stands: 150, rwyMap: 52, vttFloor: 11, vttCeil: 24, slotPct: 0.55, cdmTier: 'A' },
  { icao: 'LEMD', name: 'Madrid Barajas',      lat: 40.493, lng:  -3.567, stands: 180, rwyMap: 50, vttFloor: 13, vttCeil: 30, slotPct: 0.40, cdmTier: 'A' },
  { icao: 'EGKK', name: 'London Gatwick',      lat: 51.148, lng:  -0.190, stands: 115, rwyMap: 55, vttFloor:  9, vttCeil: 18, slotPct: 0.62, cdmTier: 'A' },
  { icao: 'LIRF', name: 'Rome Fiumicino',      lat: 41.800, lng:  12.239, stands: 140, rwyMap: 44, vttFloor: 12, vttCeil: 25, slotPct: 0.35, cdmTier: 'B' },
  { icao: 'EPWA', name: 'Warsaw Chopin',       lat: 52.166, lng:  20.967, stands:  60, rwyMap: 28, vttFloor:  8, vttCeil: 17, slotPct: 0.32, cdmTier: 'B' },
  { icao: 'ESSA', name: 'Stockholm Arlanda',   lat: 59.652, lng:  17.918, stands:  90, rwyMap: 32, vttFloor: 10, vttCeil: 22, slotPct: 0.30, cdmTier: 'B' },
  { icao: 'EFHK', name: 'Helsinki Vantaa',     lat: 60.317, lng:  24.963, stands:  70, rwyMap: 28, vttFloor:  9, vttCeil: 19, slotPct: 0.28, cdmTier: 'B' },
  { icao: 'LEBL', name: 'Barcelona El Prat',   lat: 41.297, lng:   2.078, stands: 165, rwyMap: 56, vttFloor: 11, vttCeil: 23, slotPct: 0.42, cdmTier: 'A' },
  { icao: 'EBBR', name: 'Brussels',            lat: 50.901, lng:   4.484, stands:  80, rwyMap: 36, vttFloor:  9, vttCeil: 19, slotPct: 0.45, cdmTier: 'A' },
  { icao: 'EKCH', name: 'Copenhagen Kastrup',  lat: 55.618, lng:  12.656, stands: 100, rwyMap: 38, vttFloor: 10, vttCeil: 21, slotPct: 0.40, cdmTier: 'A' },
  { icao: 'ENGM', name: 'Oslo Gardermoen',     lat: 60.194, lng:  11.100, stands:  85, rwyMap: 35, vttFloor: 11, vttCeil: 22, slotPct: 0.32, cdmTier: 'B' },
  { icao: 'LKPR', name: 'Prague Václav Havel', lat: 50.101, lng:  14.260, stands:  55, rwyMap: 26, vttFloor:  8, vttCeil: 17, slotPct: 0.30, cdmTier: 'B' },
  { icao: 'LGAV', name: 'Athens E. Venizelos', lat: 37.937, lng:  23.945, stands:  60, rwyMap: 30, vttFloor:  9, vttCeil: 18, slotPct: 0.30, cdmTier: 'B' },
  { icao: 'LHBP', name: 'Budapest Ferenc L.',  lat: 47.439, lng:  19.262, stands:  45, rwyMap: 24, vttFloor:  8, vttCeil: 16, slotPct: 0.28, cdmTier: 'B' },
  { icao: 'OERK', name: 'Riyadh King Khalid',  lat: 24.957, lng:  46.699, stands:  80, rwyMap: 32, vttFloor: 11, vttCeil: 24, slotPct: 0.18, cdmTier: 'C' },
  { icao: 'OMDB', name: 'Dubai',               lat: 25.253, lng:  55.366, stands: 180, rwyMap: 60, vttFloor: 13, vttCeil: 28, slotPct: 0.30, cdmTier: 'B' },
  { icao: 'KORD', name: 'Chicago O\u02bcHare', lat: 41.978, lng: -87.904, stands: 200, rwyMap: 90, vttFloor: 14, vttCeil: 32, slotPct: 0.20, cdmTier: 'B' },
  { icao: 'KATL', name: 'Atlanta Hartsfield',  lat: 33.640, lng: -84.428, stands: 195, rwyMap: 96, vttFloor: 13, vttCeil: 30, slotPct: 0.18, cdmTier: 'B' },
  { icao: 'KDFW', name: 'Dallas/Fort Worth',   lat: 32.897, lng: -97.038, stands: 180, rwyMap: 88, vttFloor: 14, vttCeil: 32, slotPct: 0.16, cdmTier: 'B' },
  { icao: 'KJFK', name: 'New York JFK',        lat: 40.640, lng: -73.779, stands: 130, rwyMap: 70, vttFloor: 16, vttCeil: 38, slotPct: 0.35, cdmTier: 'B' },
  { icao: 'KSFO', name: 'San Francisco',       lat: 37.619, lng:-122.375, stands:  95, rwyMap: 58, vttFloor: 12, vttCeil: 26, slotPct: 0.30, cdmTier: 'B' },
  { icao: 'YSSY', name: 'Sydney Kingsford',    lat:-33.946, lng: 151.177, stands:  75, rwyMap: 44, vttFloor: 11, vttCeil: 22, slotPct: 0.40, cdmTier: 'B' },
  { icao: 'RJTT', name: 'Tokyo Haneda',        lat: 35.553, lng: 139.781, stands: 145, rwyMap: 80, vttFloor: 13, vttCeil: 28, slotPct: 0.35, cdmTier: 'B' },
  { icao: 'WSSS', name: 'Singapore Changi',    lat:  1.359, lng: 103.989, stands: 140, rwyMap: 68, vttFloor: 12, vttCeil: 26, slotPct: 0.32, cdmTier: 'B' },
]

/* ---- math ---- */
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const R_NM = 3440.065
function gcNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dφ = (la2 - la1) * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
function fnv(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}
function hashUnit(s: string, salt: string): number { return (fnv(s + '|' + salt) % 100000) / 100000 }

function nearestAp(f: SFlight): { ap: AcdmAp; distNm: number } | null {
  let best: { ap: AcdmAp; distNm: number } | null = null
  for (const a of APS) {
    const d = gcNm(f.lat, f.lng, a.lat, a.lng)
    if (!best || d < best.distNm) best = { ap: a, distNm: d }
  }
  return best && best.distNm <= 80 ? best : null
}

/* ---- per-flight A-CDM milestone synthesis ---- */
interface Milestone {
  tobtMin: number   // minutes ago TOBT was scheduled (negative = future)
  tsatMin: number   // TSAT (minutes ago, allocated by NM/CDM)
  aobtMin: number   // AOBT (actual off-block)
  atotMin: number   // ATOT (actual take-off) — 0 = just now for active climbouts
  ctotMin: number | null  // CTOT (if slot-controlled), minutes ago / future
  vtt: number       // variable taxi-out time (TSAT->ATOT predicted)
  actualTaxi: number  // actual taxi-out (AOBT->ATOT)
  hasCtot: boolean
  slotLo: number    // CTOT-5 (earliest acceptable ATOT relative to CTOT, signed minutes)
  slotHi: number    // CTOT+10
  slotBreach: number  // signed minutes outside the window (0 if inside)
  dpiState: 'T-DPI-t' | 'T-DPI-s' | 'A-DPI' | 'C-DPI' | 'X-DPI'
  boardingPct: number
}

function synthMilestones(f: SFlight, ap: AcdmAp, klass: Klass, taxiMul: number, slotJitter: number): Milestone {
  const perf = KLASS[klass]
  // Hash-stable per ICAO24 (so each refresh stays consistent for a given aircraft)
  const h1 = hashUnit(f.icao, 'tobt')
  const h2 = hashUnit(f.icao, 'slip')
  const h3 = hashUnit(f.icao, 'ctot')
  const h4 = hashUnit(f.icao, 'taxi')
  // The aircraft is airborne low-alt climbout; ATOT ~ now. We back-calculate.
  // Assume ATOT was vertRate-implied: time-since-rotation ~ altitudeFt / vertRate
  const fpm = Math.max(300, f.vertRate)
  const sinceRotMin = clamp(f.altitudeFt / fpm, 0.3, 12)
  const atotMin = sinceRotMin
  // VTT: floor + 0..(ceil-floor) by stand-distance hash, scaled by per-class base & multiplier
  const vtt = (ap.vttFloor + h1 * (ap.vttCeil - ap.vttFloor)) * (perf.vttBase / 14) * taxiMul
  // Push-back duration (already in actual-taxi)
  const pushMin = perf.pushMin
  // Actual taxi: VTT +/- skew from a second hash (-2 .. +8 min skew, biased queue-positive)
  const taxiSkew = (h4 - 0.3) * 10  // -3 .. +7
  const actualTaxi = Math.max(vtt + pushMin * 0.5, vtt + taxiSkew + pushMin * 0.7)
  const aobtMin = atotMin + actualTaxi
  // TSAT: allocated to be vtt before ATOT; if AOBT slipped, TSAT was earlier than AOBT
  const tsatSlipMin = h2 * 14 - 2  // -2 .. +12 min later than TSAT (slip)
  const tsatMin = aobtMin + tsatSlipMin
  // TOBT: target was 0..8 min earlier than TSAT
  const tobtSlipMin = h2 * 8
  const tobtMin = tsatMin + tobtSlipMin
  // CTOT if slot-controlled
  const hasCtot = h3 < ap.slotPct
  const ctotJitter = (h3 - 0.5) * 22 * slotJitter // -11..+11 scaled
  const ctotMin = hasCtot ? atotMin + ctotJitter : null  // CTOT relative to "now"
  const slotLo = -5, slotHi = 10  // EUROCONTROL CTOT window
  // Slot breach: ATOT vs CTOT window. ATOT-CTOT signed (positive = late)
  // ATOT was sinceRotMin ago. CTOT was (ctotMin) ago. ATOT-CTOT = sinceRotMin - ctotMin (both "ago")
  // Inside window if -5 <= (ATOT-CTOT) <= +10
  let slotBreach = 0
  if (hasCtot && ctotMin !== null) {
    const delta = sinceRotMin - ctotMin  // signed minutes early/late
    if (delta < slotLo) slotBreach = delta - slotLo  // negative
    else if (delta > slotHi) slotBreach = delta - slotHi  // positive
  }
  // DPI state machine: closest applicable phase
  let dpiState: Milestone['dpiState'] = 'T-DPI-t'
  if (atotMin > 0) dpiState = 'A-DPI'
  if (slotBreach !== 0) dpiState = 'C-DPI'
  if (Math.abs(slotBreach) > 10) dpiState = 'X-DPI'
  // Boarding pct (cosmetic)
  const boardingPct = clamp(100 - tobtSlipMin * 6, 30, 100)
  return { tobtMin, tsatMin, aobtMin, atotMin, ctotMin, vtt, actualTaxi, hasCtot, slotLo, slotHi, slotBreach, dpiState, boardingPct }
}

/* ---- evaluation ---- */
interface Eval {
  f: SFlight; ap: AcdmAp; klass: Klass; ms: Milestone
  drivers: { TOB: number; TSA: number; TXI: number; CTO: number; RWP: number; SEQ: number }
  tier: Tier; score: number; advice: string
}

function makeEval(f: SFlight, ap: AcdmAp, klass: Klass, taxiMul: number, slotJitter: number, rwyPressure: number, seqStability: number, advMul: number): Eval {
  const ms = synthMilestones(f, ap, klass, taxiMul, slotJitter)
  // Drivers (0-100)
  const tobtSlip = ms.aobtMin - ms.tobtMin  // positive = AOBT later than TOBT (slip)
  const tsatSlip = ms.aobtMin - ms.tsatMin
  const taxiOver = ms.actualTaxi - ms.vtt
  const TOB = clamp(tobtSlip * 7, 0, 100)         // 14 min slip => 100
  const TSA = clamp(Math.abs(tsatSlip) * 9, 0, 100)
  const TXI = clamp(taxiOver * 11, 0, 100)        // 9 min over VTT => 100
  const CTO = ms.hasCtot ? clamp(Math.abs(ms.slotBreach) * 9, 0, 100) : 0
  const RWP = clamp(rwyPressure, 0, 100)
  const SEQ = clamp((1 - seqStability) * 100, 0, 100)
  const drivers = { TOB, TSA, TXI, CTO, RWP, SEQ }
  const arr = [TOB, TSA, TXI, CTO, RWP, SEQ].sort((a, b) => b - a)
  let composite = arr[0] * 0.45 + arr[1] * 0.25 + arr[2] * 0.14 + arr[3] * 0.09 + arr[4] * 0.04 + arr[5] * 0.03
  // Tier-A airports get less penalty (mature CDM); C more
  const tierMul = ap.cdmTier === 'A' ? 0.92 : ap.cdmTier === 'B' ? 1.0 : 1.12
  composite *= tierMul * (advMul / 100)
  composite = clamp(composite, 0, 100)
  // Hard escalations
  if (ms.hasCtot && Math.abs(ms.slotBreach) > 8) composite = Math.max(composite, 84)
  if (tobtSlip > 12) composite = Math.max(composite, 70)
  if (taxiOver > 12) composite = Math.max(composite, 60)

  let tier: Tier, advice: string
  if (composite >= 80 && ms.hasCtot && Math.abs(ms.slotBreach) > 5) {
    tier = 'SLOT-MISS'
    const sign = ms.slotBreach > 0 ? 'late' : 'early'
    advice = `CTOT breach ${ms.slotBreach.toFixed(1)} min ${sign} (window -5/+10) — request slot revision via NMOC FUM/B2B; coordinate with TWR per ATFCM Ops Manual ed.27 §3`
  } else if (composite >= 60) {
    tier = 'TOBT-SLIP'
    advice = `TOBT slip +${tobtSlip.toFixed(1)} min — AO push TOBT update via A-DPI; review boarding & ground-handling per AHM 011 / A-CDM IM ed.5 §M09-M13`
  } else if (composite >= 40) {
    tier = 'TAXI-OVER'
    advice = `Taxi-out ${ms.actualTaxi.toFixed(1)} min vs VTT ${ms.vtt.toFixed(1)} (+${taxiOver.toFixed(1)}) — pushback queue / runway hold; check TSAT compression per A-CDM IM ed.5 §5.4`
  } else if (composite >= 20) {
    tier = 'PRESSURE'
    advice = `Runway pressure ${rwyPressure.toFixed(0)}/100 vs MAP ${ap.rwyMap}/hr — monitor sequence stability; preserve TSAT per EUROCONTROL CDM ConOps ed.2.1`
  } else {
    tier = 'NOMINAL'
    advice = `TOBT→TSAT→AOBT→ATOT nominal · DPI ${ms.dpiState} · taxi ${ms.actualTaxi.toFixed(1)}/${ms.vtt.toFixed(1)} min · A-CDM tier ${ap.cdmTier}`
  }
  return { f, ap, klass, ms, drivers, tier, score: composite, advice }
}

/* ---- map layer ids ---- */
const SRC_HALO = 'acdm-halo', LYR_HALO = 'acdm-halo'
const SRC_PIN  = 'acdm-pin',  LYR_PIN  = 'acdm-pin'
const SRC_LBL  = 'acdm-lbl',  LYR_LBL  = 'acdm-lbl'
const SRC_AP   = 'acdm-ap',   LYR_AP   = 'acdm-ap'
const SRC_ALBL = 'acdm-albl', LYR_ALBL = 'acdm-albl'
const SRC_LINK = 'acdm-link', LYR_LINK = 'acdm-link'

const lsGet = (k: string, d: any) => { if (typeof window === 'undefined') return d; try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }
const lsSet = (k: string, v: any) => { if (typeof window === 'undefined') return; try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

export default function AcdmMonitor({ map, flights, onClose, onFly }: Props) {
  const [taxiMul, setTaxiMul]   = useState<number>(() => lsGet('ft-acdm-taxi', 100))
  const [slotJit, setSlotJit]   = useState<number>(() => lsGet('ft-acdm-slot', 100))
  const [advMul, setAdvMul]     = useState<number>(() => lsGet('ft-acdm-adv', 100))
  const [minFl, setMinFl]       = useState<number>(() => lsGet('ft-acdm-mnfl', 0))
  const [maxFl, setMaxFl]       = useState<number>(() => lsGet('ft-acdm-mxfl', 150))
  const [scope, setScope]       = useState<number>(() => lsGet('ft-acdm-scp', 80))
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS' | 'SLOTS'>('AIRCRAFT')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin]   = useState(true)
  const [showLbl, setShowLbl]   = useState(true)
  const [showAp, setShowAp]     = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    lsSet('ft-acdm-taxi', taxiMul); lsSet('ft-acdm-slot', slotJit); lsSet('ft-acdm-adv', advMul)
    lsSet('ft-acdm-mnfl', minFl); lsSet('ft-acdm-mxfl', maxFl); lsSet('ft-acdm-scp', scope)
  }, [taxiMul, slotJit, advMul, minFl, maxFl, scope])

  // Pre-compute runway pressure per airport (count of departures within 80 NM climbing, /MAP * 100)
  const pressureByAp = useMemo(() => {
    const cnt: Record<string, number> = {}
    for (const f of flights) {
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (fl > 150 || f.vertRate < 200) continue
      const n = nearestAp(f); if (!n) continue
      cnt[n.ap.icao] = (cnt[n.ap.icao] || 0) + 1
    }
    const out: Record<string, number> = {}
    for (const a of APS) {
      const c = cnt[a.icao] || 0
      // pressure: live climbouts vs MAP/hour-derived expected (~MAP/8 in any 7-min snapshot)
      const expected = a.rwyMap / 8
      out[a.icao] = clamp((c / Math.max(1, expected)) * 60, 0, 100)
    }
    return out
  }, [flights])

  // Sequence stability per airport (cosmetic: invert std dev of synthetic TSAT slips)
  const stabilityByAp = useMemo(() => {
    const out: Record<string, number> = {}
    for (const a of APS) {
      // Hash-stable per airport (ranges 0.55..0.95 with rwyMap influence)
      const h = hashUnit(a.icao, 'stab')
      const base = 0.55 + h * 0.4
      out[a.icao] = clamp(base - (pressureByAp[a.icao] || 0) / 250, 0.30, 0.98)
    }
    return out
  }, [pressureByAp])

  const evals = useMemo(() => {
    const out: Eval[] = []
    for (const f of flights) {
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl || fl > maxFl) continue
      if (f.vertRate < 200) continue  // climbing only
      let best: { ap: AcdmAp; distNm: number } | null = null
      for (const a of APS) {
        const d = gcNm(f.lat, f.lng, a.lat, a.lng)
        if (!best || d < best.distNm) best = { ap: a, distNm: d }
      }
      if (!best || best.distNm > scope) continue
      const klass = classify(f.type)
      const rp = pressureByAp[best.ap.icao] || 0
      const st = stabilityByAp[best.ap.icao] || 0.8
      out.push(makeEval(f, best.ap, klass, taxiMul / 100, slotJit / 100, rp, st, advMul))
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, taxiMul, slotJit, advMul, minFl, maxFl, scope, pressureByAp, stabilityByAp])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return evals.filter(e => {
      if (klassFilter !== 'ALL' && e.klass !== klassFilter) return false
      if (tierFilter !== 'ALL' && e.tier !== tierFilter) return false
      if (q) {
        const blob = `${e.f.callsign} ${e.f.icao} ${e.f.type} ${e.f.operator} ${e.ap.icao} ${e.ap.name}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [evals, klassFilter, tierFilter, query])

  const tierCount: Record<Tier, number> = { 'SLOT-MISS': 0, 'TOBT-SLIP': 0, 'TAXI-OVER': 0, PRESSURE: 0, NOMINAL: 0, IDLE: 0 }
  for (const e of evals) tierCount[e.tier]++
  const meanScore = evals.length ? evals.reduce((s, e) => s + e.score, 0) / evals.length : 0
  const worst = evals[0]
  const slotCount = evals.filter(e => e.ms.hasCtot).length
  const slotMissCount = evals.filter(e => e.tier === 'SLOT-MISS').length
  const meanTobtSlip = evals.length ? evals.reduce((s, e) => s + (e.ms.aobtMin - e.ms.tobtMin), 0) / evals.length : 0
  const meanTaxiOver = evals.length ? evals.reduce((s, e) => s + (e.ms.actualTaxi - e.ms.vtt), 0) / evals.length : 0

  /* Map layers */
  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any)
    }
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN,  'circle', SRC_PIN,  { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_AP,   'circle', SRC_AP,   { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.55, 'circle-stroke-width': 1, 'circle-stroke-color': '#7dd3fc' })
    ensure(LYR_LINK, 'line',   SRC_LINK, { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.85, 'line-dasharray': [2, 2] })
    ensure(LYR_LBL,  'symbol', SRC_LBL,  {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    ensure(LYR_ALBL, 'symbol', SRC_ALBL, {}, { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, -1.2], 'text-anchor': 'bottom', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL))  { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }
    if (map.getLayer(LYR_ALBL)) { map.setPaintProperty(LYR_ALBL, 'text-color', '#7dd3fc'); map.setPaintProperty(LYR_ALBL, 'text-halo-color', '#020617'); map.setPaintProperty(LYR_ALBL, 'text-halo-width', 1.4) }

    const ap: any[] = [], albl: any[] = []
    if (showAp) {
      for (const a of APS) {
        const inN = evals.filter(e => e.ap.icao === a.icao).length
        if (inN === 0) continue
        const rp = pressureByAp[a.icao] || 0
        const c = rp >= 65 ? '#ef4444' : rp >= 35 ? '#f59e0b' : '#0ea5e9'
        ap.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng, a.lat] }, properties: { r: 4 + Math.min(inN, 8) * 0.6, color: c } })
        albl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng, a.lat] }, properties: { label: `${a.icao}·${inN}·${rp.toFixed(0)}%` } })
      }
    }
    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = []
    for (const e of filtered) {
      const color = TIER_COLOR[e.tier]
      if (showHalo && e.tier !== 'IDLE' && e.tier !== 'NOMINAL') halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, r: 8 + e.score * 0.14 } })
      if (showPin && (e.tier === 'SLOT-MISS' || e.tier === 'TOBT-SLIP')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color } })
      if (showLbl && e.tier !== 'NOMINAL' && e.tier !== 'IDLE') {
        const tag = e.ms.hasCtot ? `CTOT${e.ms.slotBreach >= 0 ? '+' : ''}${e.ms.slotBreach.toFixed(0)}` : `TOB${e.ms.aobtMin - e.ms.tobtMin >= 0 ? '+' : ''}${(e.ms.aobtMin - e.ms.tobtMin).toFixed(0)}`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, label: `${e.f.callsign || e.f.icao} · ${e.ap.icao} · ${tag} · ${e.tier}` } })
      }
      if (showLink && e.tier !== 'NOMINAL' && e.tier !== 'IDLE') {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[e.f.lng, e.f.lat], [e.ap.lng, e.ap.lat]] }, properties: { color } })
      }
    }
    ;(map.getSource(SRC_AP)   as any).setData({ type: 'FeatureCollection', features: ap })
    ;(map.getSource(SRC_ALBL) as any).setData({ type: 'FeatureCollection', features: albl })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN)  as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL)  as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_AP, LYR_ALBL]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_LINK, SRC_AP, SRC_ALBL]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, evals, pressureByAp, showHalo, showPin, showLbl, showAp, showLink])

  const tierBadge = (t: Tier) => <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  const klassBadge = (k: Klass) => <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: KLASS_COLOR[k], backgroundColor: KLASS_COLOR[k] + '1f', border: `1px solid ${KLASS_COLOR[k]}55` }}>{k}</span>
  const drvBadge = (k: string, v: number) => {
    const c = v >= 70 ? '#ef4444' : v >= 40 ? '#f59e0b' : v >= 18 ? '#0ea5e9' : '#10b981'
    return <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: c, backgroundColor: c + '1c', border: `1px solid ${c}55` }}>{k}{v.toFixed(0)}</span>
  }

  /* Scatter: tobt-slip min (x) vs taxi-over min (y) */
  const W = 280, H = 110, padL = 26, padB = 16, padT = 6, padR = 6
  const xMin = -4, xMax = 18, yMin = -4, yMax = 18
  const sx = (v: number) => padL + ((clamp(v, xMin, xMax) - xMin) / (xMax - xMin)) * (W - padL - padR)
  const sy = (v: number) => padT + (1 - (clamp(v, yMin, yMax) - yMin) / (yMax - yMin)) * (H - padT - padB)

  return (
    <div className="absolute right-3 top-20 z-40 w-[26rem] max-h-[calc(100vh-6rem)] flex flex-col bg-slate-900/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-sky-500 animate-pulse" />
          <span className="text-[10px] font-bold tracking-widest uppercase text-sky-400">A-CDM · TOBT / TSAT / ATOT Milestones</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[8px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean score</div><div className="text-sm font-semibold" style={{ color: meanScore >= 65 ? '#ef4444' : meanScore >= 35 ? '#f59e0b' : '#10b981' }}>{meanScore.toFixed(0)}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Worst</div><div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Slot miss</div><div className="text-sm font-semibold" style={{ color: slotMissCount > 0 ? '#ef4444' : '#10b981' }}>{slotMissCount}</div></div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">CTOT-controlled</div><div className="text-xs font-semibold text-sky-300">{slotCount}/{evals.length}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean TOBT slip</div><div className="text-xs font-semibold" style={{ color: meanTobtSlip > 6 ? '#f43f5e' : meanTobtSlip > 3 ? '#f59e0b' : '#10b981' }}>+{meanTobtSlip.toFixed(1)}min</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean taxi over</div><div className="text-xs font-semibold" style={{ color: meanTaxiOver > 6 ? '#f43f5e' : meanTaxiOver > 3 ? '#f59e0b' : '#10b981' }}>+{meanTaxiOver.toFixed(1)}min</div></div>
      </div>

      {showDiag && evals.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* nominal quadrant: small slips */}
            <rect x={sx(-4)} y={sy(4)} width={sx(3) - sx(-4)} height={sy(-4) - sy(4)} fill="#10b98115" />
            {/* breach quadrant: tobt slip > 8 AND taxi over > 6 */}
            <rect x={sx(8)} y={padT} width={W - padR - sx(8)} height={sy(6) - padT} fill="#ef444418" />
            <line x1={sx(0)} y1={padT} x2={sx(0)} y2={H - padB} stroke="#475569" strokeWidth={0.5} />
            <line x1={padL} y1={sy(0)} x2={W - padR} y2={sy(0)} stroke="#475569" strokeWidth={0.5} />
            <line x1={sx(8)} y1={padT} x2={sx(8)} y2={H - padB} stroke="#f43f5e66" strokeWidth={0.5} strokeDasharray="2 3" />
            <line x1={padL} y1={sy(6)} x2={W - padR} y2={sy(6)} stroke="#f59e0b66" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={W / 2} y={H - 3} textAnchor="middle" fontSize="9" fill="#64748b">TOBT slip (min, AOBT−TOBT)</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>Taxi over VTT (min)</text>
            {evals.map((e, i) => (
              <circle key={i} cx={sx(e.ms.aobtMin - e.ms.tobtMin)} cy={sy(e.ms.actualTaxi - e.ms.vtt)} r={2.4} fill={TIER_COLOR[e.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['TAXI-MUL', taxiMul, 50, 200, setTaxiMul, '%'],
            ['SLOT-JIT', slotJit, 50, 200, setSlotJit, '%'],
            ['ADV-MUL', advMul, 50, 200, setAdvMul, '%'],
            ['MIN-FL', minFl, 0, 100, setMinFl, ''],
            ['MAX-FL', maxFl, 50, 250, setMaxFl, ''],
            ['SCOPE', scope, 20, 200, setScope, 'nm'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[40px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['HVY', 'NRW', 'RGN', 'BIZ'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: klassFilter === k ? KLASS_COLOR[k] + '33' : '#0b1220', borderColor: klassFilter === k ? KLASS_COLOR[k] : '#1e293b', color: klassFilter === k ? KLASS_COLOR[k] : '#cbd5e1' }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['APT', showAp, setShowAp],
            ['LINK', showLink, setShowLink],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, v, setter]: any) => (
            <button key={lab} onClick={() => setter(!v)} className="px-1.5 py-0.5 rounded text-[9px] font-mono border" style={{ backgroundColor: v ? '#0ea5e933' : '#0b1220', borderColor: v ? '#0ea5e9' : '#1e293b', color: v ? '#7dd3fc' : '#64748b' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / type / airport" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'AIRPORTS', 'SLOTS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No recent A-CDM departures in scope.</div>}
            {filtered.map((e, idx) => {
              const ms = e.ms
              const tobtSlip = ms.aobtMin - ms.tobtMin
              const taxiOver = ms.actualTaxi - ms.vtt
              return (
                <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(e.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[e.tier]}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-slate-200 text-[11px] font-semibold truncate">{e.f.callsign || e.f.icao}</span>
                      <span className="text-slate-500 text-[10px] font-mono">{e.f.type || '—'}</span>
                      {klassBadge(e.klass)}
                      <span className="px-1 py-0.5 rounded text-[9px] font-mono text-slate-400 bg-slate-800/60 border border-slate-700">{ms.dpiState}</span>
                    </div>
                    {tierBadge(e.tier)}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    <span className="text-sky-300">{e.ap.icao}</span>
                    {' · TOBT '}<span className="text-slate-300">−{ms.tobtMin.toFixed(0)}m</span>
                    {' › TSAT '}<span className="text-slate-300">−{ms.tsatMin.toFixed(0)}m</span>
                    {' › AOBT '}<span style={{ color: tobtSlip > 8 ? '#f43f5e' : tobtSlip > 3 ? '#f59e0b' : '#10b981' }}>−{ms.aobtMin.toFixed(0)}m</span>
                    {' › ATOT '}<span className="text-slate-300">−{ms.atotMin.toFixed(0)}m</span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    › TOBT slip <span style={{ color: tobtSlip > 8 ? '#f43f5e' : tobtSlip > 3 ? '#f59e0b' : '#10b981' }}>{tobtSlip >= 0 ? '+' : ''}{tobtSlip.toFixed(1)}m</span>
                    {' · taxi '}<span style={{ color: taxiOver > 6 ? '#f43f5e' : taxiOver > 3 ? '#f59e0b' : '#10b981' }}>{ms.actualTaxi.toFixed(1)}</span>{'/'}<span className="text-slate-300">{ms.vtt.toFixed(1)}m</span>
                    {ms.hasCtot && (<>
                      {' · CTOT '}<span style={{ color: Math.abs(ms.slotBreach) > 5 ? '#ef4444' : Math.abs(ms.slotBreach) > 2 ? '#f59e0b' : '#10b981' }}>{ms.slotBreach >= 0 ? '+' : ''}{ms.slotBreach.toFixed(1)}m</span>
                      <span className="text-slate-500">{' [-5/+10]'}</span>
                    </>)}
                  </div>
                  <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${e.score}%`, backgroundColor: TIER_COLOR[e.tier] }} /></div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {drvBadge('TOB', e.drivers.TOB)}
                    {drvBadge('TSA', e.drivers.TSA)}
                    {drvBadge('TXI', e.drivers.TXI)}
                    {drvBadge('CTO', e.drivers.CTO)}
                    {drvBadge('RWP', e.drivers.RWP)}
                    {drvBadge('SEQ', e.drivers.SEQ)}
                  </div>
                  <div className="text-[10px] mt-1.5 italic" style={{ color: TIER_COLOR[e.tier] }}>{e.advice}</div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'AIRPORTS' && (
          <div className="divide-y divide-slate-800">
            {APS.slice().sort((a, b) => {
              const ca = evals.filter(e => e.ap.icao === a.icao).length
              const cb = evals.filter(e => e.ap.icao === b.icao).length
              return cb - ca
            }).map(a => {
              const inA = evals.filter(e => e.ap.icao === a.icao)
              if (inA.length === 0) return null
              const rp = pressureByAp[a.icao] || 0
              const st = stabilityByAp[a.icao] || 0.8
              const slot = inA.filter(e => e.tier === 'SLOT-MISS').length
              const tob = inA.filter(e => e.tier === 'TOBT-SLIP').length
              const ms = inA.length ? inA.reduce((s, e) => s + e.score, 0) / inA.length : 0
              const rpColor = rp >= 65 ? '#ef4444' : rp >= 35 ? '#f59e0b' : '#10b981'
              return (
                <div key={a.icao} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${rpColor}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-mono text-sky-300 text-[11px]">{a.icao}</span>
                      <span className="px-1 py-0.5 rounded text-[9px] font-mono text-slate-400 bg-slate-800/60 border border-slate-700">tier-{a.cdmTier}</span>
                      <span className="text-[10px] text-slate-400 truncate">{a.name}</span>
                    </div>
                    <span className="text-[10px] font-mono" style={{ color: rpColor }}>{rp.toFixed(0)}% / MAP {a.rwyMap}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    {inA.length} dep · <span className="text-rose-400">{slot} SLT</span> · <span className="text-rose-400">{tob} TOB</span>
                    {' · VTT '}<span className="text-slate-300">{a.vttFloor}-{a.vttCeil}m</span>
                    {' · CTOT '}<span className="text-sky-300">{(a.slotPct * 100).toFixed(0)}%</span>
                    {' · stab '}<span className="text-slate-300">{(st * 100).toFixed(0)}%</span>
                  </div>
                  <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 65 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'SLOTS' && (
          <div className="divide-y divide-slate-800">
            {evals.filter(e => e.ms.hasCtot).sort((a, b) => Math.abs(b.ms.slotBreach) - Math.abs(a.ms.slotBreach)).map((e, i) => {
              const ms = e.ms
              const inside = Math.abs(ms.slotBreach) === 0
              const pos = clamp(((ms.atotMin - (ms.ctotMin ?? 0)) - ms.slotLo) / (ms.slotHi - ms.slotLo), -0.5, 1.5)
              return (
                <div key={i} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(e.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[e.tier]}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-slate-200 text-[11px] font-semibold truncate">{e.f.callsign || e.f.icao}</span>
                      <span className="px-1 py-0.5 rounded text-[9px] font-mono text-slate-400 bg-slate-800/60 border border-slate-700">{ms.dpiState}</span>
                      <span className="font-mono text-sky-300 text-[10px]">{e.ap.icao}</span>
                    </div>
                    {tierBadge(e.tier)}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-1 font-mono">
                    CTOT-window <span className="text-slate-300">[-5/+10]</span> · ATOT-CTOT
                    {' '}<span style={{ color: inside ? '#10b981' : '#ef4444' }}>{(ms.atotMin - (ms.ctotMin ?? 0)).toFixed(1)}m</span>
                    {' · breach '}<span style={{ color: inside ? '#10b981' : '#ef4444' }}>{ms.slotBreach >= 0 ? '+' : ''}{ms.slotBreach.toFixed(1)}m</span>
                  </div>
                  <div className="mt-1 relative h-2 bg-slate-800 rounded overflow-hidden">
                    {/* slot window band (0..1 maps to -5..+10) */}
                    <div className="absolute inset-y-0 bg-emerald-500/20" style={{ left: '0%', width: '100%' }} />
                    {/* aircraft indicator */}
                    <div className="absolute top-0 bottom-0 w-[2px]" style={{ left: `${clamp(pos * 100, 0, 100)}%`, backgroundColor: inside ? '#10b981' : '#ef4444' }} />
                  </div>
                </div>
              )
            })}
            {evals.filter(e => e.ms.hasCtot).length === 0 && (
              <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No CTOT-controlled departures in scope.</div>
            )}
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        EUROCONTROL A-CDM IM ed.5 · CDM ConOps ed.2.1 · ATFCM Ops Manual ed.27 · ICAO Doc 9971 · Doc 4444 §16 · ICAO Doc 9750 ASBU B0-ACDM · EU 716/2014 PCP §AF-3 · EU 2019/123 NM · EASA 2017/020/R · IATA AHM 011 · FAA SCDM/TFDM · SESAR PJ.04 TT
      </div>
    </div>
  )
}
