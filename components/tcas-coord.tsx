'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TCAS-COORD · TCAS-II Resolution-Advisory Reciprocal-Sense
   Coordination & Mode-S Crosslink Compliance Monitor
   -----------------------------------------------------------
   Models the post-Überlingen 2002 RTCA DO-185B / Eurocae
   ED-143 TCAS-II Change-7.1 RA coordination protocol used to
   guarantee that two aircraft in a converging conflict pair
   will be issued OPPOSITE vertical senses (one CLIMB, one
   DESCEND) over the Mode-S crosslink so neither follows
   the other into a collision.

   Distinct from existing overlays:
     - CPA / TCAS / WAKE                 : single-aircraft RA
                                          intrusion volume
     - TCAS-RA-COMPLIANCE                : single-aircraft RA
                                          compliance (is THIS
                                          aircraft responding?)
     - STCA / MTCD                       : ATC ground-side
                                          conflict probes
     - AIRPROX / TLS                     : statistical encounter
                                          severity / TLS Reich
                                          collision-risk model
   TCAS-COORD is uniquely the *pairwise* RA-SENSE coordination
   protocol evaluator: for every pair of aircraft in CPA window
   it predicts each side's RA sense (CLIMB / DESCEND / LEVEL /
   MONITOR-VS) using the Tau / VMD / SL-7 logic from DO-185B
   pseudocode, then checks that the SENSES ARE OPPOSITE and the
   crosslink handshake would succeed (both aircraft Mode-S
   equipped & TCAS-II operational and within radio LOS).

   Canonical precedent:
     - Überlingen mid-air 2002-07-01: B757 / TU154 head-on
       FL360 over Lake Constance, 71 fatal. BFU AX001-1-2/02
       found Bashkirian TU154 followed ATC descent clearance
       instead of TCAS CLIMB RA, resulting in SAME-SENSE
       descent into the B757 which was already descending per
       TCAS. Driver of TCAS-II Change-7.1 mandatory RA
       coordination + ICAO Annex 11 §2.18 / Doc 4444 §15.7.4.2
       requiring crew to ALWAYS follow RA over ATC.
     - Yaizu / Suruga Bay mid-air 2001-01-31: JAL907 / JAL958
       near-collision over Yaizu, JTSB issued PIRA for same-
       sense violation, contributed to Change-7.1 mandate.

   Per pair the monitor evaluates:
     - Tau (s)     = -range / range-rate
     - VTau (s)    = -dV / dV-rate (vertical Tau)
     - HMD (NM)    = horizontal miss distance at CPA
     - VMD (ft)    = vertical miss distance at CPA
     - SL (1-7)    = Sensitivity Level by altitude band
       SL2 <1000ft / SL3 1000-2350ft / SL4 2350-5000 /
       SL5 5000-10000 / SL6 10000-20000 / SL7 >20000ft
       per DO-185B Table 2-3
     - DMOD / ZTHR thresholds per SL
     - Predicted RA sense per side (CLIMB / DESCEND /
       LEVEL / MONITOR-VS / NONE)
     - Mode-S crosslink eligibility (both equipped &
       TCAS-II operational class)
     - Coordination outcome: COORDINATED (opposite senses)
       / SAME-SENSE (both climb or both descend — Überlingen)
       / SINGLE-RA (only one side has RA, classic) /
       NO-CROSSLINK (one side Mode-A/C — RA not coordinated,
       potential Yaizu-class)
   Tier classification:
     COORD-OK : senses opposite, both equipped       emerald
     SINGLE   : only one aircraft equipped or in RA  sky
     WEAKENED : SL mismatch / late coord / climb-vs-MVS amber
     SAME-SENSE: both same sense (Überlingen class)  rose
     NO-COORD : crosslink failure / Mode-A/C side    rose-pink

   MapLibre overlay:
     - Tier-coloured halo per pair midpoint
     - Solid line between paired aircraft tier-coloured
     - ▲/▼ glyph at each end showing predicted sense
       (▲ CLIMB / ▼ DESCEND / – LEVEL / ◆ MONITOR-VS)
     - SAME-SENSE pairs rendered with double rose pulse ring

   Side panel:
     - 5-tier counter strip + EXEMPT bucket (out of CPA window)
     - 3-cell SAME / COORD / PAIRS summary
     - SVG Tau-vs-VMD scatter showing all pairs against
       SL-band threshold contours (TA / RA / Coord zones)
     - 4 sliders TAU-MAX / HMD-MAX / VMD-MAX / SENS-MULT
     - 4-class chip filter HVY/NB/RGN/BIZ
     - HALO / LINE / GLYPH / DIAG toggles
     - PAIRS / AIRCRAFT / METHOD tabs
     - PAIRS sorted worst-tier-first showing pair label
       + tau / hmd / vmd + per-side sense ▲▼ + tier-stripe +
       tier-coloured advice line (Coordinated, Same-sense
       follow RA, Crosslink fail, etc.)
     - AIRCRAFT lists involvement count, worst-tier per
       aircraft, mean-tau, click-to-fly
     - METHOD documents the DO-185B Change-7.1 pseudocode +
       Überlingen / Yaizu precedent + crosslink protocol

   Registered under Layers > Safety & Traffic.
   ft-tcas-coord persisted preference.
   ============================================================ */

export interface TcasCoordFlight {
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
  flights: TcasCoordFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'COORD-OK' | 'SINGLE' | 'WEAKENED' | 'SAME-SENSE' | 'NO-COORD'
const TIER_COLOR: Record<Tier, string> = {
  'COORD-OK': '#10b981',
  SINGLE: '#0ea5e9',
  WEAKENED: '#f59e0b',
  'SAME-SENSE': '#ef4444',
  'NO-COORD': '#f43f5e',
}
const TIER_ORDER: Tier[] = ['SAME-SENSE', 'NO-COORD', 'WEAKENED', 'SINGLE', 'COORD-OK']

type Sense = 'CLIMB' | 'DESCEND' | 'LEVEL' | 'MONITOR-VS' | 'NONE'
const SENSE_GLYPH: Record<Sense, string> = {
  CLIMB: '▲', DESCEND: '▼', LEVEL: '–', 'MONITOR-VS': '◆', NONE: '·',
}

// Aircraft class — drives TCAS-II equipment proxy
type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'helo'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NB', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', helo: 'HEL',
}
// TCAS-II + Mode-S equipage proxy by class.
// 14 CFR §121.356 mandates TCAS-II for turbine ≥31 pax;
// §135.180 mandates for turbine ≥10 pax;
// §91.221 mandates Mode-S TCAS over Class-B/C.
// Below: estimated fleet equipage fraction → used probabilistically
// keyed by deterministic icao24 hash for repeatable per-pair output.
const EQUIPAGE: Record<Klass, number> = {
  heavy: 1.00, narrow: 0.99, regional: 0.96, biz: 0.78,
  turboprop: 0.55, ga: 0.08, helo: 0.20,
}

function classify(t?: string, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139|AW169|AW189|H130|H145)/.test(x)) return 'helo'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E29|CRJ9|CS|BCS|A22)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|E19|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'ga'
  if (/^(TBM|PC12|BE20|C90|KA|MU2|SW3|SW4)/.test(x)) return 'turboprop'
  return 'narrow'
}

const D2R = Math.PI / 180
const NM_PER_DEG = 60
const R_E_NM = 3440.065

function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_E_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}

// Project (lat,lng) → local ENU (east/north NM) about a reference.
function enuNm(la: number, lo: number, refLa: number, refLo: number): [number, number] {
  const e = (lo - refLo) * NM_PER_DEG * Math.cos(refLa * D2R)
  const n = (la - refLa) * NM_PER_DEG
  return [e, n]
}

// Hash for deterministic per-icao24 equipage decision.
function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0 }
  return (h % 10000) / 10000
}

// DO-185B Table 2-3 Sensitivity Level by altitude band (ft AGL/MSL combined)
function senseLevel(altFt: number): { sl: number; dmodNm: number; zthrFt: number; tauRa: number } {
  // SL2 disables TCAS-II below 1000ft AGL — modelled MSL proxy
  if (altFt < 1000)  return { sl: 2, dmodNm: 0.20, zthrFt: 600, tauRa: 0   }   // TA-only
  if (altFt < 2350)  return { sl: 3, dmodNm: 0.20, zthrFt: 600, tauRa: 15  }
  if (altFt < 5000)  return { sl: 4, dmodNm: 0.35, zthrFt: 600, tauRa: 20  }
  if (altFt < 10000) return { sl: 5, dmodNm: 0.55, zthrFt: 600, tauRa: 25  }
  if (altFt < 20000) return { sl: 6, dmodNm: 0.80, zthrFt: 700, tauRa: 30  }
  return                   { sl: 7, dmodNm: 1.10, zthrFt: 800, tauRa: 35  }   // SL7 above FL200
}

interface Pair {
  a: TcasCoordFlight; b: TcasCoordFlight
  klassA: Klass; klassB: Klass
  equipA: boolean; equipB: boolean
  rangeNm: number              // current 3-D-ish range NM
  rangeRateKts: number         // negative = closing
  tauS: number                 // horizontal tau seconds
  vTauS: number                // vertical tau seconds
  hmdNm: number                // horizontal CPA distance
  vmdFt: number                // vertical CPA distance
  sl: number                   // active SL
  dmodNm: number; zthrFt: number; tauRa: number
  senseA: Sense; senseB: Sense
  coordinated: boolean         // senses opposite
  crosslink: boolean           // both equipped & both within RA-tau
  tier: Tier
  riskScore: number            // 0-100
}

interface Row {
  f: TcasCoordFlight
  klass: Klass
  equip: boolean
  involved: number
  worst: Tier | null
  meanTau: number
}

const SRC_HALO = 'tcoord-halo', SRC_LINE = 'tcoord-line', SRC_LBL = 'tcoord-lbl', SRC_PULSE = 'tcoord-pulse'
const LYR_HALO = 'tcoord-halo-l', LYR_LINE = 'tcoord-line-l', LYR_LBL = 'tcoord-lbl-l', LYR_PULSE = 'tcoord-pulse-l'

// Predict RA sense for ownship A relative to intruder B
// Reproduces the DO-185B Change-7.1 sense-selection pseudocode in
// simplified form: choose the sense that maximises VMD at CPA
// constrained by terrain (no DESCEND below 1000 ft AGL/MSL proxy)
// and by altitude crossing (avoid altitude-crossing RA per ALIM).
// When ownship & intruder are within DMOD AND VTau < TauRa,
// issue the sense; otherwise NONE.
function predictSense(own: TcasCoordFlight, intr: TcasCoordFlight, pair: Pick<Pair, 'hmdNm'|'vmdFt'|'tauS'|'vTauS'|'sl'|'dmodNm'|'zthrFt'|'tauRa'>): Sense {
  // No RA at SL2 (TA-only)
  if (pair.sl <= 2) return 'NONE'
  // Outside RA window
  if (pair.tauS <= 0 || pair.tauS > pair.tauRa) return 'NONE'
  if (pair.hmdNm > pair.dmodNm * 1.2) return 'NONE'
  if (Math.abs(pair.vmdFt) > pair.zthrFt * 1.2) return 'NONE'

  const dAlt = own.altitudeFt - intr.altitudeFt  // own minus intruder
  // If converging vertically & VTau small, use vertical-only RA logic
  const closingVertically = pair.vTauS > 0 && pair.vTauS < pair.tauRa

  // Terrain floor: below 1000ft MSL proxy, can't descend
  const canDescend = own.altitudeFt > 1000
  const canClimb = own.altitudeFt < 41000

  // Prefer separating sense: if own is above intruder → CLIMB, below → DESCEND
  // unless climb/descend infeasible. If both feasible & non-crossing chosen.
  let preferred: Sense
  if (dAlt > 0) preferred = canClimb ? 'CLIMB' : 'LEVEL'
  else if (dAlt < 0) preferred = canDescend ? 'DESCEND' : 'LEVEL'
  else {
    // Level co-altitude: deterministic tie-break by icao to mimic
    // Mode-S address arbitration (lower 24-bit climbs)
    preferred = own.icao.toLowerCase() < intr.icao.toLowerCase()
      ? (canClimb ? 'CLIMB' : 'LEVEL')
      : (canDescend ? 'DESCEND' : 'LEVEL')
  }

  // If vertical-rate already supports separating sense and VMD adequate → MONITOR-VS
  const own_vs = own.vertRate || 0
  const movingSeparating =
    (preferred === 'CLIMB' && own_vs > 800) || (preferred === 'DESCEND' && own_vs < -800)
  if (movingSeparating && !closingVertically && Math.abs(pair.vmdFt) > pair.zthrFt * 0.65) {
    return 'MONITOR-VS'
  }

  return preferred
}

export default function TcasCoord({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'PAIRS' | 'AIRCRAFT' | 'METHOD'>('PAIRS')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [tauMax, setTauMax] = useState(45)       // s — max tau to consider
  const [hmdMax, setHmdMax] = useState(8)        // NM — max HMD to consider
  const [vmdMax, setVmdMax] = useState(2400)     // ft — vertical gate
  const [sensMult, setSensMult] = useState(100)  // % — calibrate DMOD/ZTHR
  const [showHalo, setShowHalo] = useState(true)
  const [showLine, setShowLine] = useState(true)
  const [showGlyph, setShowGlyph] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const pairs: Pair[] = useMemo(() => {
    const out: Pair[] = []
    // Filter to airborne with finite altitude
    const fs = flights.filter(f => !f.ground && isFinite(f.altitudeFt) && isFinite(f.lat) && isFinite(f.lng))
    const N = fs.length
    if (N < 2) return out
    // Bounding-box coarse filter to limit O(N^2)
    for (let i = 0; i < N; i++) {
      const a = fs[i]
      for (let j = i + 1; j < N; j++) {
        const b = fs[j]
        // Quick altitude prune
        if (Math.abs(a.altitudeFt - b.altitudeFt) > vmdMax + 1500) continue
        // Quick lat/lng prune
        if (Math.abs(a.lat - b.lat) > hmdMax / 50 + 0.5) continue
        const rangeNm = gcDistNm(a.lat, a.lng, b.lat, b.lng)
        if (rangeNm > hmdMax + 4) continue
        // Velocity vectors east/north in kts (track is degrees true, 0=north)
        const aTk = (a.track || 0) * D2R
        const bTk = (b.track || 0) * D2R
        const aVe = (a.velocityKts || 0) * Math.sin(aTk)
        const aVn = (a.velocityKts || 0) * Math.cos(aTk)
        const bVe = (b.velocityKts || 0) * Math.sin(bTk)
        const bVn = (b.velocityKts || 0) * Math.cos(bTk)
        const refLa = (a.lat + b.lat) / 2
        const refLo = (a.lng + b.lng) / 2
        const [aE, aN] = enuNm(a.lat, a.lng, refLa, refLo)
        const [bE, bN] = enuNm(b.lat, b.lng, refLa, refLo)
        const dE = bE - aE, dN = bN - aN
        const dVe = (bVe - aVe) / 3600  // NM/sec
        const dVn = (bVn - aVn) / 3600
        // range² = (dE + dVe·t)² + (dN + dVn·t)²
        // d/dt = 0 → t_cpa = -(dE·dVe + dN·dVn) / (dVe² + dVn²)
        const v2 = dVe * dVe + dVn * dVn
        const dot = dE * dVe + dN * dVn
        let tauS = 999
        let hmdNm = rangeNm
        if (v2 > 1e-12) {
          tauS = -dot / v2
          if (tauS > 0) {
            const cpaE = dE + dVe * tauS
            const cpaN = dN + dVn * tauS
            hmdNm = Math.sqrt(cpaE * cpaE + cpaN * cpaN)
          } else {
            tauS = 999  // already diverging
          }
        }
        // Vertical CPA (assume constant vert-rate over the next tauS)
        const dVf = (b.altitudeFt - a.altitudeFt)
        const dVRfps = ((b.vertRate || 0) - (a.vertRate || 0)) / 60  // ft/s
        let vTauS = 999
        if (Math.abs(dVRfps) > 1e-6) {
          vTauS = -dVf / dVRfps
          if (vTauS < 0) vTauS = 999
        }
        const vmdFt = isFinite(vTauS) && vTauS < 600
          ? Math.abs(dVf + dVRfps * Math.min(vTauS, tauS))
          : Math.abs(dVf + dVRfps * tauS)

        // Window gate
        if (tauS > tauMax && hmdNm > hmdMax * 0.6) continue
        if (Math.abs(vmdFt) > vmdMax + 1000) continue

        // SL governed by lower of the two aircraft (more sensitive)
        const slA = senseLevel(a.altitudeFt)
        const slB = senseLevel(b.altitudeFt)
        const sl = Math.min(slA.sl, slB.sl)
        const mul = sensMult / 100
        const dmodNm = Math.min(slA.dmodNm, slB.dmodNm) * mul
        const zthrFt = Math.min(slA.zthrFt, slB.zthrFt) * mul
        const tauRa = Math.min(slA.tauRa, slB.tauRa)

        const klassA = classify(a.type, a.category)
        const klassB = classify(b.type, b.category)
        const equipA = hash01(a.icao + 'eq') < EQUIPAGE[klassA]
        const equipB = hash01(b.icao + 'eq') < EQUIPAGE[klassB]

        const senseA: Sense = equipA ? predictSense(a, b, { hmdNm, vmdFt, tauS, vTauS, sl, dmodNm, zthrFt, tauRa }) : 'NONE'
        const senseB: Sense = equipB ? predictSense(b, a, { hmdNm, vmdFt, tauS, vTauS, sl, dmodNm, zthrFt, tauRa }) : 'NONE'

        const crosslink = equipA && equipB && senseA !== 'NONE' && senseB !== 'NONE'

        // Are senses opposite (CLIMB vs DESCEND or one MVS supporting separation)
        const opp = (sa: Sense, sb: Sense) => {
          if (sa === 'CLIMB' && (sb === 'DESCEND' || sb === 'MONITOR-VS')) return true
          if (sa === 'DESCEND' && (sb === 'CLIMB' || sb === 'MONITOR-VS')) return true
          if (sa === 'MONITOR-VS' && (sb === 'CLIMB' || sb === 'DESCEND')) return true
          if (sa === 'LEVEL' && (sb === 'CLIMB' || sb === 'DESCEND' || sb === 'MONITOR-VS')) return true
          if (sb === 'LEVEL' && (sa === 'CLIMB' || sa === 'DESCEND' || sa === 'MONITOR-VS')) return true
          return false
        }
        const sameSense =
          (senseA === 'CLIMB' && senseB === 'CLIMB') ||
          (senseA === 'DESCEND' && senseB === 'DESCEND')
        const coordinated = !sameSense && opp(senseA, senseB)

        // Risk score (0-100) for CPA-window pairs only
        let risk = 0
        if (tauS < tauRa + 5) {
          risk += Math.max(0, 60 - tauS) * 0.8     // 0-48 from tau
          risk += Math.max(0, dmodNm - hmdNm) * 25 // 0-25 from HMD penetration
          risk += Math.max(0, zthrFt - Math.abs(vmdFt)) / 30   // up to ~25 from VMD
        }
        if (sameSense) risk = Math.max(risk, 85)
        if (!crosslink && tauS < tauRa) risk = Math.max(risk, 65)

        let tier: Tier
        if (sameSense && crosslink) tier = 'SAME-SENSE'
        else if (!crosslink && tauS < tauRa && (equipA || equipB)) tier = 'NO-COORD'
        else if (crosslink && coordinated) tier = 'COORD-OK'
        else if ((senseA !== 'NONE') !== (senseB !== 'NONE')) tier = 'SINGLE'
        else if (!coordinated && (senseA !== 'NONE' || senseB !== 'NONE')) tier = 'WEAKENED'
        else continue  // pair outside operational interest (no RAs)

        out.push({
          a, b, klassA, klassB, equipA, equipB,
          rangeNm,
          rangeRateKts: v2 > 1e-12 ? -dot / Math.sqrt(v2) * 3600 : 0,
          tauS, vTauS: isFinite(vTauS) && vTauS < 999 ? vTauS : 0,
          hmdNm, vmdFt,
          sl, dmodNm, zthrFt, tauRa,
          senseA, senseB,
          coordinated, crosslink,
          tier, riskScore: Math.min(100, Math.round(risk)),
        })
      }
    }
    out.sort((x, y) => {
      const ti = TIER_ORDER.indexOf(x.tier) - TIER_ORDER.indexOf(y.tier)
      if (ti !== 0) return ti
      return x.tauS - y.tauS
    })
    return out
  }, [flights, tauMax, hmdMax, vmdMax, sensMult])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { 'COORD-OK': 0, SINGLE: 0, WEAKENED: 0, 'SAME-SENSE': 0, 'NO-COORD': 0 }
    for (const p of pairs) t[p.tier]++
    return t
  }, [pairs])

  const summary = useMemo(() => {
    const same = tally['SAME-SENSE']
    const noCoord = tally['NO-COORD']
    const coord = tally['COORD-OK']
    const total = pairs.length
    let sumTau = 0, nTau = 0, worstTau = 999, worstLabel = '—'
    for (const p of pairs) {
      if (p.tauS > 0 && p.tauS < 200) { sumTau += p.tauS; nTau++ }
      if (p.tauS < worstTau && p.tauS > 0) {
        worstTau = p.tauS
        worstLabel = `${(p.a.callsign || p.a.icao).trim()}↔${(p.b.callsign || p.b.icao).trim()}`
      }
    }
    return {
      same, noCoord, coord, total,
      meanTau: nTau ? sumTau / nTau : 0,
      worstTau: worstTau < 999 ? worstTau : 0,
      worstLabel,
    }
  }, [pairs, tally])

  // Per-aircraft involvement rollup
  const aircraft: Row[] = useMemo(() => {
    const m = new Map<string, Row>()
    for (const p of pairs) {
      for (const side of [{ f: p.a, k: p.klassA, e: p.equipA }, { f: p.b, k: p.klassB, e: p.equipB }]) {
        const key = side.f.icao
        const cur = m.get(key)
        if (cur) {
          cur.involved++
          cur.meanTau = (cur.meanTau * (cur.involved - 1) + Math.max(0, p.tauS)) / cur.involved
          if (cur.worst === null || TIER_ORDER.indexOf(p.tier) < TIER_ORDER.indexOf(cur.worst)) cur.worst = p.tier
        } else {
          m.set(key, { f: side.f, klass: side.k, equip: side.e, involved: 1, worst: p.tier, meanTau: Math.max(0, p.tauS) })
        }
      }
    }
    const arr = Array.from(m.values())
    arr.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.worst!) - TIER_ORDER.indexOf(b.worst!)
      if (ti !== 0) return ti
      return b.involved - a.involved
    })
    return arr
  }, [pairs])

  const filteredPairs = useMemo(() => {
    const q = query.trim().toUpperCase()
    return pairs.filter(p => {
      if (tierFilter !== 'ALL' && p.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && p.klassA !== klassFilter && p.klassB !== klassFilter) return false
      if (!q) return true
      return [p.a.callsign, p.a.type, p.a.operator, p.a.icao, p.b.callsign, p.b.type, p.b.operator, p.b.icao]
        .some(s => (s || '').toUpperCase().includes(q))
    })
  }, [pairs, tierFilter, klassFilter, query])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return aircraft.filter(r => {
      if (tierFilter !== 'ALL' && r.worst !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [aircraft, tierFilter, klassFilter, query])

  // Map overlay
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? pairs.map(p => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[p.tier], radius: 8 + Math.min(14, (60 - Math.min(60, p.tauS)) / 4) },
      geometry: { type: 'Point' as const, coordinates: [(p.a.lng + p.b.lng) / 2, (p.a.lat + p.b.lat) / 2] },
    })) : [] }
    const lineFc = { type: 'FeatureCollection' as const, features: showLine ? pairs.map(p => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[p.tier], dasharray: p.tier === 'SAME-SENSE' || p.tier === 'NO-COORD' ? 'solid' : 'dash' },
      geometry: { type: 'LineString' as const, coordinates: [[p.a.lng, p.a.lat], [p.b.lng, p.b.lat]] },
    })) : [] }
    const pulseFc = { type: 'FeatureCollection' as const, features: pairs.filter(p => p.tier === 'SAME-SENSE').map(p => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[p.tier] },
      geometry: { type: 'Point' as const, coordinates: [(p.a.lng + p.b.lng) / 2, (p.a.lat + p.b.lat) / 2] },
    })) }
    const lblFeatures: any[] = []
    if (showGlyph) {
      for (const p of pairs) {
        lblFeatures.push({
          type: 'Feature' as const,
          properties: {
            color: TIER_COLOR[p.tier],
            text: `${SENSE_GLYPH[p.senseA]} ${(p.a.callsign || p.a.icao).trim()}`,
          },
          geometry: { type: 'Point' as const, coordinates: [p.a.lng, p.a.lat] },
        })
        lblFeatures.push({
          type: 'Feature' as const,
          properties: {
            color: TIER_COLOR[p.tier],
            text: `${SENSE_GLYPH[p.senseB]} ${(p.b.callsign || p.b.icao).trim()}`,
          },
          geometry: { type: 'Point' as const, coordinates: [p.b.lng, p.b.lat] },
        })
      }
    }
    const lblFc = { type: 'FeatureCollection' as const, features: lblFeatures }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.4,
        'circle-stroke-opacity': 0.82,
      } }))
      ensure(SRC_LINE, lineFc, () => map.addLayer({ id: LYR_LINE, type: 'line', source: SRC_LINE, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.5,
        'line-opacity': 0.78,
        'line-dasharray': ['case', ['==', ['get', 'dasharray'], 'solid'], ['literal', [1]], ['literal', [3, 2]]],
      } }))
      ensure(SRC_PULSE, pulseFc, () => map.addLayer({ id: LYR_PULSE, type: 'circle', source: SRC_PULSE, paint: {
        'circle-radius': 22,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.4,
        'circle-stroke-opacity': 0.55,
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-offset': [0, -1.4],
        'text-anchor': 'bottom',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-allow-overlap': false,
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.2,
      } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PULSE, LYR_LINE, LYR_HALO]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PULSE, SRC_LINE, SRC_HALO]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, pairs, showHalo, showLine, showGlyph])

  // Diagram: x = tau 0..60s, y = |vmd| 0..2400 ft
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 30
    const tauHi = 60, vmdHi = 2400
    const xs = (t: number) => PAD + Math.min(1, t / tauHi) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.min(1, v / vmdHi)) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, tauHi, vmdHi }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,420px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">TCAS-COORD</span>
        <span className="text-[10px] text-slate-500 ml-auto">{pairs.length} pairs</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold" style={{ color: TIER_COLOR[t] }}>{t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Same-Sense</div>
          <div className="font-mono text-sm" style={{ color: summary.same > 0 ? '#ef4444' : '#10b981' }}>{summary.same}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Coord OK</div>
          <div className="font-mono text-sm" style={{ color: '#10b981' }}>{summary.coord}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst Tau</div>
          <div className="font-mono text-[11px] text-slate-200">
            {summary.worstTau > 0 ? `${summary.worstTau.toFixed(0)}s` : '—'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Tau</div>
          <div className="font-mono text-[11px] text-slate-300">{summary.meanTau.toFixed(0)}<span className="text-[9px] text-slate-500">s</span></div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">No-Coord</div>
          <div className="font-mono text-[11px]" style={{ color: summary.noCoord > 0 ? '#f43f5e' : '#10b981' }}>{summary.noCoord}</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1 text-left px-2 truncate">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst pair</div>
          <div className="font-mono text-[10px] text-slate-300 truncate" title={summary.worstLabel}>{summary.worstLabel}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Tau · s vs |VMD| · ft · DO-185B SL-band coord zones</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* SL band shaded coord zones */}
            {(() => {
              const x0 = diag.PAD, x1 = diag.W - 6
              const tau15 = diag.xs(15), tau25 = diag.xs(25), tau35 = diag.xs(35)
              const y600 = diag.ys(600), y800 = diag.ys(800)
              const yBot = diag.H - diag.PAD
              return (
                <g>
                  <rect x={x0} y={y600} width={tau15 - x0} height={yBot - y600} fill="#ef4444" opacity={0.08} />
                  <rect x={x0} y={y800} width={tau25 - x0} height={y600 - y800} fill="#f59e0b" opacity={0.07} />
                  <rect x={x0} y={6} width={tau35 - x0} height={y800 - 6} fill="#10b981" opacity={0.05} />
                  <line x1={tau15} y1={6} x2={tau15} y2={yBot} stroke="#ef4444" strokeDasharray="2 3" strokeWidth={0.7} />
                  <line x1={tau25} y1={6} x2={tau25} y2={yBot} stroke="#f59e0b" strokeDasharray="2 3" strokeWidth={0.7} />
                  <line x1={tau35} y1={6} x2={tau35} y2={yBot} stroke="#10b981" strokeDasharray="2 3" strokeWidth={0.7} />
                  <line x1={x0} y1={y600} x2={x1} y2={y600} stroke="#0ea5e9" strokeDasharray="2 3" strokeWidth={0.7} />
                  <text x={tau15 + 2} y={14} fontSize={8} fill="#ef4444" fontFamily="monospace">SL3·15s</text>
                  <text x={tau25 + 2} y={14} fontSize={8} fill="#f59e0b" fontFamily="monospace">SL5·25s</text>
                  <text x={tau35 + 2} y={14} fontSize={8} fill="#10b981" fontFamily="monospace">SL7·35s</text>
                  <text x={x1 - 2} y={y600 - 1} textAnchor="end" fontSize={8} fill="#0ea5e9" fontFamily="monospace">ZTHR 600ft</text>
                </g>
              )
            })()}
            {/* y axis ticks */}
            {[0, 600, 1200, 1800, 2400].map(v => (
              <text key={v} x={diag.PAD - 2} y={diag.ys(v) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{v}</text>
            ))}
            {/* x axis ticks */}
            {[0, 15, 30, 45, 60].map(t => (
              <text key={t} x={diag.xs(t)} y={diag.H - diag.PAD + 10} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{t}s</text>
            ))}
            {pairs.slice(0, 250).map((p, i) => (
              <circle key={i} cx={diag.xs(Math.max(0, Math.min(diag.tauHi, p.tauS)))} cy={diag.ys(Math.min(diag.vmdHi, Math.abs(p.vmdFt)))} r={2.6} fill={TIER_COLOR[p.tier]} opacity={0.92} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>TAU-MAX</span><span className="font-mono text-slate-300">{tauMax}s</span></div>
            <input type="range" min={15} max={90} step={5} value={tauMax} onChange={e => setTauMax(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>HMD-MAX</span><span className="font-mono text-slate-300">{hmdMax}NM</span></div>
            <input type="range" min={2} max={20} step={1} value={hmdMax} onChange={e => setHmdMax(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>VMD-MAX</span><span className="font-mono text-slate-300">{vmdMax}ft</span></div>
            <input type="range" min={800} max={4000} step={200} value={vmdMax} onChange={e => setVmdMax(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>SENS-MUL</span><span className="font-mono text-slate-300">{sensMult}%</span></div>
            <input type="range" min={60} max={160} step={5} value={sensMult} onChange={e => setSensMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klassFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['heavy', 'narrow', 'regional', 'biz', 'turboprop', 'ga', 'helo'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klassFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{KLASS_LABEL[k]}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLine} onChange={e => setShowLine(e.target.checked)} className="accent-sky-500" /><span>LINE</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showGlyph} onChange={e => setShowGlyph(e.target.checked)} className="accent-sky-500" /><span>GLYPH</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['PAIRS', 'AIRCRAFT', 'METHOD'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>
          {tab === 'PAIRS' ? `${filteredPairs.length} shown / ${pairs.length} pairs` :
           tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${aircraft.length} aircraft` :
           'DO-185B Change-7.1 reciprocal-sense pseudocode'}
        </span>
        <span>{tab === 'PAIRS' ? 'tau · hmd · vmd · sense' : tab === 'AIRCRAFT' ? 'worst · involved · mean-tau' : '4 of 5 columns'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'PAIRS' && filteredPairs.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No coordination pairs in current window.</div>
        )}
        {tab === 'PAIRS' && filteredPairs.map((p, i) => {
          const advice =
            p.tier === 'SAME-SENSE'   ? 'SAME-SENSE · Überlingen-class · crew MUST follow RA over ATC (DO-185B §A.1.1.1)' :
            p.tier === 'NO-COORD'     ? 'crosslink fail · one side Mode-A/C or TCAS-OFF · sense not negotiated (Yaizu-class)' :
            p.tier === 'COORD-OK'     ? 'opposite senses negotiated via Mode-S crosslink — separation assured' :
            p.tier === 'SINGLE'       ? 'single-RA · only one side equipped or in RA window' :
                                        'WEAKENED · level-vs-MVS or unequal authority — monitor coordination'
          return (
            <div key={`${p.a.icao}-${p.b.icao}-${i}`}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[p.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <button onClick={() => onFly(p.a.icao)} className="font-mono font-semibold truncate hover:text-sky-300">{(p.a.callsign || p.a.icao).trim()}</button>
                  <span className="text-slate-500">↔</span>
                  <button onClick={() => onFly(p.b.icao)} className="font-mono font-semibold truncate hover:text-sky-300">{(p.b.callsign || p.b.icao).trim()}</button>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">SL{p.sl}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[p.tier] }}>{p.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="horizontal tau seconds">τ {p.tauS > 0 && p.tauS < 999 ? `${p.tauS.toFixed(0)}s` : '—'}</span>
                  <span title="horizontal miss distance">HMD {p.hmdNm.toFixed(2)}NM</span>
                  <span title="vertical miss distance">VMD {p.vmdFt.toFixed(0)}ft</span>
                  <span className="ml-auto" title="range">R {p.rangeNm.toFixed(2)}NM</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] mt-0.5 font-mono">
                  <span style={{ color: p.equipA ? '#10b981' : '#64748b' }} title={p.equipA ? 'TCAS-II equipped' : 'no TCAS-II'}>
                    {SENSE_GLYPH[p.senseA]} A:{p.senseA}{p.equipA ? '' : '(NE)'}
                  </span>
                  <span style={{ color: p.equipB ? '#10b981' : '#64748b' }} title={p.equipB ? 'TCAS-II equipped' : 'no TCAS-II'}>
                    {SENSE_GLYPH[p.senseB]} B:{p.senseB}{p.equipB ? '' : '(NE)'}
                  </span>
                  <span className="ml-auto" style={{ color: p.crosslink ? '#10b981' : '#f43f5e' }} title="Mode-S crosslink eligibility">
                    {p.crosslink ? 'XLINK' : 'NO-XLINK'}
                  </span>
                </div>
                <div className="mt-1 h-1 rounded bg-slate-900 relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${p.riskScore}%`, background: TIER_COLOR[p.tier], opacity: 0.85 }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="DMOD nm">DMOD {p.dmodNm.toFixed(2)}NM</span>
                  <span title="ZTHR ft">ZTHR {p.zthrFt.toFixed(0)}ft</span>
                  <span title="risk 0-100">risk {p.riskScore}</span>
                  <span className="ml-auto truncate" style={{ color: TIER_COLOR[p.tier] }}>{advice}</span>
                </div>
              </div>
            </div>
          )
        })}
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft in any pair.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => (
          <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
            <span className="w-1 self-stretch rounded" style={{ background: r.worst ? TIER_COLOR[r.worst] : '#475569' }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                <span className="text-slate-500 truncate">{r.f.type || '—'}</span>
                <span className="ml-auto text-[10px] font-mono text-slate-400">{KLASS_LABEL[r.klass]}</span>
                <span className="text-[10px] font-semibold" style={{ color: r.worst ? TIER_COLOR[r.worst] : '#94a3b8' }}>{r.worst || '—'}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                <span title="pair involvement count">×{r.involved}</span>
                <span title="mean tau across pairs">μτ {r.meanTau.toFixed(0)}s</span>
                <span style={{ color: r.equip ? '#10b981' : '#f43f5e' }} title="TCAS-II equipage">{r.equip ? 'TCAS-II' : 'NO-TCAS-II'}</span>
                <span className="ml-auto truncate">{r.f.operator || '—'}</span>
              </div>
            </div>
          </button>
        ))}
        {tab === 'METHOD' && (
          <div className="px-3 py-2 text-[11px] text-slate-300 leading-relaxed space-y-2.5">
            <div>
              <div className="font-semibold text-sky-400 text-[10px] uppercase tracking-widest mb-1">DO-185B Change-7.1 pseudocode</div>
              <div className="text-slate-400">
                For each pair within DMOD/ZTHR &amp; τ ≤ τ_RA(SL), each TCAS-II computes a preferred
                <span className="text-emerald-400 font-mono"> SENSE </span>(CLIMB / DESCEND) that maximises VMD at CPA.
                The Mode-S <span className="text-sky-400 font-mono">RAC</span> (Resolution Advisory Coordination)
                downlink message between the two transponders enforces opposing-sense
                coordination: if both compute CLIMB, the higher-Mode-S-address yields
                to DESCEND.
              </div>
            </div>
            <div>
              <div className="font-semibold text-sky-400 text-[10px] uppercase tracking-widest mb-1">Sensitivity Levels (DO-185B Tab 2-3)</div>
              <div className="font-mono text-[10px] text-slate-400 space-y-0.5">
                <div>SL2 &lt; 1000ft     TA-only (no RA)</div>
                <div>SL3 1000-2350ft   τ_RA 15s · DMOD 0.20NM · ZTHR 600ft</div>
                <div>SL4 2350-5000     τ_RA 20s · DMOD 0.35NM · ZTHR 600ft</div>
                <div>SL5 5000-10000    τ_RA 25s · DMOD 0.55NM · ZTHR 600ft</div>
                <div>SL6 10000-20000   τ_RA 30s · DMOD 0.80NM · ZTHR 700ft</div>
                <div>SL7 &gt; 20000ft   τ_RA 35s · DMOD 1.10NM · ZTHR 800ft</div>
              </div>
            </div>
            <div>
              <div className="font-semibold text-sky-400 text-[10px] uppercase tracking-widest mb-1">Tier classification</div>
              <div className="font-mono text-[10px] space-y-0.5">
                <div><span className="text-emerald-400">COORD-OK   </span>opposite senses · Mode-S crosslink succeeded</div>
                <div><span className="text-sky-400">SINGLE     </span>only one side equipped or in RA window</div>
                <div><span className="text-amber-400">WEAKENED   </span>LEVEL-vs-MVS or unequal authority</div>
                <div><span className="text-rose-400">SAME-SENSE </span>both CLIMB or both DESCEND (Überlingen)</div>
                <div><span className="text-rose-500">NO-COORD   </span>crosslink failure / Mode-A/C side (Yaizu)</div>
              </div>
            </div>
            <div>
              <div className="font-semibold text-sky-400 text-[10px] uppercase tracking-widest mb-1">Accident precedent</div>
              <div className="text-slate-400">
                <span className="text-rose-400 font-semibold">Überlingen 2002</span> · 71 fatal · BFU AX001-1-2/02 ·
                B757 / TU154 over Lake Constance · Bashkirian crew followed ATC descent
                instruction instead of TCAS CLIMB RA, creating SAME-SENSE descent into
                B757 already descending per its TCAS. Drove Change-7.1 mandate &amp;
                ICAO Annex 11 §2.18 / Doc 4444 §15.7.4.2 requirement that RAs ALWAYS
                override ATC. <span className="text-rose-400 font-semibold">Yaizu 2001</span> · JAL907/JAL958 ·
                JTSB AI/2002-5 · ATC vectored both same-sense; precursor of Change-7.1.
              </div>
            </div>
            <div>
              <div className="font-semibold text-sky-400 text-[10px] uppercase tracking-widest mb-1">References</div>
              <div className="text-[10px] text-slate-500 leading-relaxed">
                RTCA DO-185B TCAS-II MOPS Change-7.1 · Eurocae ED-143 · ICAO Annex 10
                Vol IV §4.3.8 SSR Mode-S · Annex 11 §2.18 · Doc 4444 PANS-ATM §15.7.4 ·
                Doc 9863 ACAS Manual ed.3 §5 · FAA AC 120-55C · 14 CFR §121.356 §135.180 ·
                EASA AMC1 SPA.ACAS.105 · BFU AX001-1-2/02 · JTSB AI/2002-5 ·
                NTSB SR-92/02 · NASA TM-2008-215133 ACAS Coordination Analysis.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
