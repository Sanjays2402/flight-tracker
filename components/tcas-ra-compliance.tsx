'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TCAS-II 7.1 · Resolution-Advisory · Sensitivity-Level · Reversal-Logic · Crew-Response Compliance Monitor

   Foundational subsystem: TCAS-II is the certificated airborne collision-
   avoidance system mandated for all turbine-powered transport aeroplanes
   ≥5,700 kg MTOW or >19 pax in most ICAO state airspace systems (US §121.356
   §125.224 §129.18, EU AMC 20-15, ICAO Annex 10 Vol IV §4.3). TCAS-II monitors
   Mode-C/S transponder replies of nearby aircraft, projects closure tau
   (slant-range τ_r) and vertical tau (τ_v), and issues:
     · TA (Traffic Advisory)  : ~48-35 s to CPA — "TRAFFIC, TRAFFIC"
     · RA (Resolution Advisory): ~35-15 s to CPA — corrective vertical
       command ("CLIMB", "DESCEND", "MAINTAIN VS", "MONITOR VS", "INCREASE
       CLIMB", "INCREASE DESCENT", "CROSSING", "LEVEL-OFF"), optionally
       with REVERSAL ("CLIMB, CLIMB NOW") per DO-185B §2.2.5 if intruder
       fails to follow opposing-sense RA — the Change 7.1 reversal logic
       was the direct outcome of the BFU Überlingen 2002 accident.

   Compliance physics — what this overlay scores per airframe:

   1. SENSITIVITY-LEVEL REGION (SL)
        SL is a 7-band altitude classification (SL2-SL8) per DO-185B §2.2.3
        that controls the warning-time thresholds and the protection volume.
        SL2 : ≤1000 ft AGL          TA-only, RA inhibited (low-altitude inhibit)
        SL3 : 1000-2350 ft AGL      TA τ=20s    RA inhibited
        SL4 : 2350-5000 ft AGL      TA τ=25s    RA τ=15s
        SL5 : 5000-10000 ft AGL     TA τ=30s    RA τ=20s
        SL6 : 10000-20000 ft       TA τ=40s    RA τ=25s
        SL7 : 20000-42000 ft       TA τ=45s    RA τ=30s
        SL8 : >42000 ft            TA τ=48s    RA τ=35s
        The Sensitivity Level Control (SLC) bus is set by radio-altitude
        (low band) and pressure-altitude (high bands). Mis-set SL is one
        of the rare M5 failure modes.

   2. RA INHIBITS (the 7 hardware inhibits per DO-185B §2.2.5.4)
        a. Below 1000 ft AGL          all RAs inhibited (SL2)
        b. Below 900 ft AGL           "DESCEND" RA inhibited
        c. Below 1100 ft AGL          "INCREASE DESCENT" inhibited
        d. Below 1450 ft AGL          climb-rate >2500 fpm RAs inhibited
        e. With landing gear DOWN     all RAs may be inhibited (operator policy)
        f. Above 30000 ft Mach >0.9    "INCREASE CLIMB" inhibited
        g. With WoW SQUAT (ground)     all RAs inhibited
        The inhibit-band matters because a TCAS RA in landing flare is
        worse than the encounter it would resolve (Cerritos 1986 prevailed
        as a low-altitude inhibit test case).

   3. CREW-RESPONSE TIMING per RTCA DO-185B §2.1.4.3
        Initial response       ≤5 s
        Strengthened (revised) ≤2.5 s
        Reversal (sense flip)  ≤2.5 s
        Vertical acceleration  ≥0.25 g toward commanded sense
        Vertical-rate target   1500 fpm corrective / 2500 fpm preventive
        Crews who fail to comply within these gates produce the "non-compliant
        RA" event class which the FAA/EASA SMS programmes track.

   4. SENSE SELECTION & REVERSAL LOGIC
        At RA-issue time TCAS performs a sense-selection algorithm
        comparing two hypothetical maneuvers (climb-vs-descend) and picking
        the sense that produces the greater minimum vertical separation
        (z_min) at projected CPA per DO-185B §2.2.4. If both ownship and
        intruder are TCAS-II-equipped, a Mode-S coordination message
        ensures opposing-sense selection (cross-link via 1030/1090 MHz).
        At Change 7.0 (the version installed on TU154 and B757 at
        Überlingen 2002) this coordination failed when one party had its
        TCAS in TA-only mode AND an ATC instruction was given OPPOSITE to
        the RA. Change 7.1 (2008 mandate per EASA AMC 20-15, FAA AC 120-55D)
        added REVERSAL logic that re-evaluates sense ≥2s after issue and
        commands a sense reversal if z_min has degraded.

   5. CHANGE 7.1 IMPROVEMENTS (mandatory worldwide 2017-2018):
        a. REVERSAL logic for adjacent-altitude AC failing to comply
        b. "ADJUST VERTICAL SPEED, ADJUST" replaces ambiguous "ADJUST V/S"
           callout that contributed to Yokohama 2001 JAL907/958 incident
        c. Improved sense selection in level-off scenarios
        d. Adaptive threshold tightening at high vertical rates
        e. Suppression of nuisance RAs on parallel approaches (LDA / PRM)

   Structurally distinct from:
     - TCAS (basic traffic display only)
     - ACAS-X (next-gen DO-385 dynamic-programming offline-optimized successor)
     - STCA  (ground-based ATC Short-Term Conflict Alert)
     - DAA-WC (UAS detect-and-avoid well-clear DO-365B)
     - AIRPROX (Risk Assessment Tool encounter classifier)
     - CPA (geometric closest-point-of-approach pairing only)
     - MAC (CAST/CICTT mid-air-collision accident-category)

   TCAS-RA is uniquely the AIRBORNE LAST-LAYER DO-185B vertical RA evaluator
   — sense selection · reversal · crew compliance · inhibits · SL bands
   — the last defence between a 350-kt closure and the BFU Überlingen 71-
   fatality precedent.

   References (regulatory + accident + technical):
     · 14 CFR §121.356 §125.224 §129.18 §91.221 (US ACAS mandate)
     · FAA AC 120-55D · AC 120-55B · TSO-C119d · TSO-C112 (TCAS-II eq)
     · FAA Order 7110.65BB §5-5 (controller compatibility)
     · FAA Order 8900.1 V4 Ch1 §1 (ops insp ACAS training)
     · EASA AMC 20-15 (ACAS II equipage and 7.1 mandate)
     · EASA NPA 2009-08 (7.1 RIA)
     · EASA SIB 2018-22 (7.1 compliance reminder)
     · ICAO Annex 10 Vol IV §4.3 (SARP MOPS reference)
     · ICAO Doc 4444 §15.7.4 (controller ACAS RA reaction)
     · ICAO Doc 9863 ACAS Manual ed.2 (the canonical reference)
     · ICAO Doc 8168 PANS-OPS Vol I §3.2 (pilot ACAS RA reaction)
     · ICAO Doc 8643 (Mode-S extended squitter)
     · RTCA DO-185B / DO-185C (MOPS — the bible)
     · RTCA DO-300A (ACAS II Operational Standards)
     · RTCA DO-260B (1090ES squitter coordination)
     · EUROCONTROL ACAS Bulletin 1-22 (encounter case studies)
     · EUROCONTROL ACAS II 7.1 Programme final report 2017
     · EUROCONTROL ASARP / SCM analyses on RA compliance
     · BFU AX001-1-2/02 — Überlingen 2002 (TU154 / B757 71 fatal — the
       direct cause of 7.1 reversal logic)
     · JTSB AA2002-5 — JAL907/958 Yokohama 2001 (TCAS-vs-ATC instruction)
     · CENIPA RF 1907/06 — GOL1907 / N600XL Amazonia 2006 (154 fatal,
       transponder off in cruise — drove subsequent SSR maintenance ADs)
     · NTSB AAR-87-07 — Cerritos AeroMexico 498 1986 (low-altitude TA-only
       precedent — drove SL2 inhibit philosophy)
     · NTSB AAR-09-03 — US-1549 (TCAS bird-strike adjacent traffic clearance)
     · AAIB EW/G2001/03/27 — multiple parallel-approach nuisance RA cases
     · Kuchar & Drumm "TCAS Logic" LL J. 2007 (the logic synthesis paper)
     · Kuchar & Yang IEEE 2000 (modelling collision-avoidance dynamics)
     · Munoz et al. NASA TM-218022 (formal verification of ACAS X)
     · Holland et al. AFRL-RH-WP-TR-2014 (crew-response gate measurement)
     · Boeing FCTM Ch.8 / FCOM SP.16.20 (TCAS-RA procedure)
     · Airbus FCTM PRO-NOR-SOP-21 / FCOM PRO-ABN-TCAS (TCAS-RA escape)
     · Embraer AOM §03 / CRJ FCOM Vol 2 §08 (TCAS procedures)

   Color discipline: rose = REVERSAL/INCOMPLIANT (worst), amber = CORRECT (RA
   active), sky = STRENGTHEN (revised), emerald = CLEAR-OF-CONFLICT, slate =
   PROXIMATE/OTHER.
============================================================ */

interface PFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: PFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'REVERSAL'|'CORRECTIVE'|'PREVENTIVE'|'TA'|'PROX'|'CLEAR'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  'REVERSAL':'#ef4444', 'CORRECTIVE':'#f43f5e', 'PREVENTIVE':'#f59e0b',
  'TA':'#0ea5e9', 'PROX':'#64748b', 'CLEAR':'#10b981', 'OFF':'#475569',
}
const TIER_RANK: Record<Tier,number> = { 'REVERSAL':0, 'CORRECTIVE':1, 'PREVENTIVE':2, 'TA':3, 'PROX':4, 'CLEAR':5, 'OFF':6 }
const TIER_ORDER: Tier[] = ['REVERSAL','CORRECTIVE','PREVENTIVE','TA','PROX','CLEAR']

// ------------------------------------------------------------
// Sensitivity-Level bands per DO-185B §2.2.3
// AGL based (low) and pressure-alt (high).
interface SlBand { sl: number; agl?: [number,number]; alt?: [number,number]
  taTau: number; raTau: number; dmod: number; zthr: number;
  raEnabled: boolean; label: string }
const SL_BANDS: SlBand[] = [
  { sl:2, agl:[0,1000],         taTau:20, raTau:0,  dmod:0.30, zthr:850,  raEnabled:false, label:'TA-ONLY (low alt inhibit)' },
  { sl:3, agl:[1000,2350],      taTau:25, raTau:15, dmod:0.33, zthr:600,  raEnabled:false, label:'TA-ONLY transitional' },
  { sl:4, agl:[2350,5000],      taTau:30, raTau:20, dmod:0.48, zthr:600,  raEnabled:true,  label:'RA enabled (low TA)' },
  { sl:5, alt:[5000,10000],     taTau:40, raTau:25, dmod:0.75, zthr:600,  raEnabled:true,  label:'RA enabled (climb-out)' },
  { sl:6, alt:[10000,20000],    taTau:45, raTau:30, dmod:1.00, zthr:600,  raEnabled:true,  label:'RA enabled (mid alt)' },
  { sl:7, alt:[20000,42000],    taTau:48, raTau:35, dmod:1.30, zthr:700,  raEnabled:true,  label:'RA enabled (high cruise)' },
  { sl:8, alt:[42000,99000],    taTau:48, raTau:35, dmod:1.30, zthr:800,  raEnabled:true,  label:'RA enabled (FL420+)' },
]
function slFor(agl: number, alt: number): SlBand {
  // SL2/3 chosen by AGL when low; SL4+ by pressure-alt
  if (agl < 1000) return SL_BANDS[0]
  if (agl < 2350) return SL_BANDS[1]
  if (agl < 5000) return SL_BANDS[2]
  if (alt < 10000) return SL_BANDS[3]
  if (alt < 20000) return SL_BANDS[4]
  if (alt < 42000) return SL_BANDS[5]
  return SL_BANDS[6]
}

// ------------------------------------------------------------
// TCAS equipage catalogue — software version per airframe
interface TcasSpec { sw: string; rev: 'CH7.0'|'CH7.1'|'CH7.0/X-hybrid'|'NONE'
  proc: 'TPA-100A'|'TPA-100B'|'CAS-100'|'TT-31'|'ACSS-3000-SP'|'L-3-2100/T3CAS'|'T2CAS'|'NONE'
  reversalSpeed: number; cert: string }
function tcasOf(type?: string): TcasSpec {
  const t = (type||'').toUpperCase()
  // Modern transport — Honeywell TPA-100B or ACSS-3000 with Change 7.1
  if (/^(A35|A359|A35K|A220|BCS|A21N|A20N|B78|B789|B788|B77W|B77X|B77L|B779)/.test(t))
    return { sw:'Honeywell TPA-100B', rev:'CH7.1', proc:'TPA-100B', reversalSpeed:0.30, cert:'TSO-C119d · DO-185B · 2017 EASA 7.1 mandate' }
  // Older transport but ch.7.1 retrofitted (post-2017 mandate)
  if (/^(B73|B738|B739|B752|B753|B763|B764|B744|B748|B742|A319|A320|A321|A332|A333|A339|A388|E170|E190|E195|E290|E295|CRJ|CRJ7|CRJ9)/.test(t))
    return { sw:'ACSS T3CAS / Collins TT-31 retrofit', rev:'CH7.1', proc:'L-3-2100/T3CAS', reversalSpeed:0.28, cert:'TSO-C119c · 7.1 SB applied (2018)' }
  // Regional turboprop — usually T2CAS / TPA-100B
  if (/^(AT4|AT5|AT7|ATR|DH8D|DH8C|DH8B|DH8A|DHC8|Q40|Q30|SF34|SB20|S20)/.test(t))
    return { sw:'ACSS TPA-100B / T2CAS', rev:'CH7.1', proc:'T2CAS', reversalSpeed:0.26, cert:'TSO-C119c · turboprop retrofit' }
  // Biz jets — TT-31 or T3CAS, ch.7.1 mandatory
  if (/^(GLEX|GL5T|GL7T|G650|GLF6|GLF5|FA[78]|FA50|FA90|CL35|CL65|HD\d|E55P|C25B|C56X|C68A|C25C|LJ75|LJ60|LJ45)/.test(t))
    return { sw:'Collins TT-31 / Honeywell CAS-100', rev:'CH7.1', proc:'TT-31', reversalSpeed:0.27, cert:'TSO-C119c · biz mandate' }
  // GA single-axis or none
  if (/^(C172|C152|C150|PA28|PA32|DA40|DA42|M20|SR2|SR22)/.test(t))
    return { sw:'TCAS-I / Skywatch HP', rev:'CH7.0/X-hybrid', proc:'CAS-100', reversalSpeed:0.0, cert:'TSO-C147 · TAS only (no RA)' }
  // Military — variant
  if (/^(C17|C5|C13|C30|KC1|A40|A400|C160|F[12-9]|F[A]?\d|EF20|EUFI|RFA|H60|H53|H47)/.test(t))
    return { sw:'MIL TCAS-II / DAS', rev:'CH7.0', proc:'TPA-100A', reversalSpeed:0.25, cert:'MIL-STD-882E' }
  return { sw:'Modern TCAS-II (assumed)', rev:'CH7.1', proc:'TPA-100B', reversalSpeed:0.28, cert:'TSO-C119d (assumed)' }
}

function clamp(v:number,a:number,b:number){return Math.max(a,Math.min(b,v))}
function nmDist(lat1:number,lng1:number,lat2:number,lng2:number) {
  const R=3440.065
  const φ1=lat1*Math.PI/180, φ2=lat2*Math.PI/180
  const dφ=(lat2-lat1)*Math.PI/180, dλ=(lng2-lng1)*Math.PI/180
  const a=Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2*R*Math.asin(Math.min(1,Math.sqrt(a)))
}

// Closure-rate kts along the line from a to b (positive = closing)
function closingKts(a: PFlight, b: PFlight) {
  const d0 = nmDist(a.lat,a.lng,b.lat,b.lng)
  if (d0 < 0.01) return 0
  const dtMin = 1/60
  const ta = a.track*Math.PI/180, tb = b.track*Math.PI/180
  const aLat2 = a.lat + (a.velocityKts*dtMin/60) * Math.cos(ta)
  const aLng2 = a.lng + (a.velocityKts*dtMin/60) * Math.sin(ta) / Math.max(0.001, Math.cos(a.lat*Math.PI/180))
  const bLat2 = b.lat + (b.velocityKts*dtMin/60) * Math.cos(tb)
  const bLng2 = b.lng + (b.velocityKts*dtMin/60) * Math.sin(tb) / Math.max(0.001, Math.cos(b.lat*Math.PI/180))
  const d1 = nmDist(aLat2,aLng2,bLat2,bLng2)
  return (d0 - d1) * 60 / dtMin
}

// ------------------------------------------------------------
// Per-encounter RA state
type RaSense = 'CLIMB'|'DESCEND'|'MONITOR-VS'|'MAINTAIN-VS'|'LEVEL-OFF'|'NONE'
type RaCmd = 'CORRECTIVE'|'PREVENTIVE'|'STRENGTHEN'|'REVERSAL'|'WEAKEN'|'CLEAR'|'NONE'
interface RaState {
  active: boolean
  cmd: RaCmd
  sense: RaSense
  tauR: number   // s to CPA range
  tauV: number   // s to CPA vertical
  rangeNm: number
  altDiff: number  // ft
  closingKts: number
  vRateTargetFpm: number
  intruderCs: string
  intruderType: string
  intruderRev: 'CH7.0'|'CH7.1'|'CH7.0/X-hybrid'|'NONE'
  inhibit: string  // current inhibit reason or ''
  compliance: 'GOOD'|'SLOW'|'OPPOSITE'|'NONE-ENGAGED'|'OK'
  reversalReason: string
  zminAtCpa: number  // ft predicted vertical separation at CPA
}

// Synthetic deterministic RA state based on icao hash + phase, plus
// real geometric pairing against nearest other flight.
function syntheticRa(f: PFlight, all: PFlight[], spec: TcasSpec, sl: SlBand, aglFt: number): RaState {
  // Find nearest other AC within ±5000 ft and 20 NM
  let best: PFlight | null = null
  let bestD = Infinity
  for (const o of all) {
    if (o.icao === f.icao) continue
    if (Math.abs(o.altitudeFt - f.altitudeFt) > 5000) continue
    if (o.ground !== f.ground) continue
    const d = nmDist(f.lat,f.lng,o.lat,o.lng)
    if (d < bestD) { bestD = d; best = o }
  }
  // Deterministic hash for synthetic state
  let h=0; for (let i=0;i<f.icao.length;i++) h = ((h*131) + f.icao.charCodeAt(i)) >>> 0
  const r1 = (h%1000)/1000, r2 = ((h>>5)%1000)/1000, r3 = ((h>>11)%1000)/1000
  const r4 = ((h>>17)%1000)/1000, r5 = ((h>>23)%1000)/1000

  const out: RaState = {
    active: false, cmd:'NONE', sense:'NONE',
    tauR: 9999, tauV: 9999, rangeNm: bestD, altDiff: best ? best.altitudeFt - f.altitudeFt : 0,
    closingKts: best ? closingKts(f, best) : 0,
    vRateTargetFpm: 0,
    intruderCs: best ? (best.callsign || best.icao) : '—',
    intruderType: best ? (best.type || '—') : '—',
    intruderRev: best ? tcasOf(best.type).rev : 'NONE',
    inhibit: '', compliance:'OK', reversalReason:'', zminAtCpa: 0,
  }
  if (!best || bestD > 12) return out

  // Range/vertical tau
  const closing = out.closingKts
  out.tauR = closing > 0 ? Math.max(0, (bestD - sl.dmod) / closing * 3600) : 9999
  const dvRate = (f.vertRate - best.vertRate)
  out.tauV = Math.abs(dvRate) > 50 ? Math.max(0, (Math.abs(out.altDiff) - sl.zthr) / Math.abs(dvRate) * 60) : 9999

  // Predicted vertical separation at projected CPA
  const cpaT = Math.max(0.5, Math.min(out.tauR, 60))
  out.zminAtCpa = Math.abs(out.altDiff + (f.vertRate - best.vertRate) * (cpaT/60))

  // SL2/3 — TA-only, no RA possible
  if (!sl.raEnabled && out.tauR < sl.taTau && bestD < 6) {
    out.active = true
    out.cmd = 'PREVENTIVE'
    out.sense = 'MONITOR-VS'
    out.inhibit = sl.sl === 2 ? 'SL2 · all RAs inhibited <1000ft AGL' : 'SL3 · transition band TA only'
    return out
  }

  // RA inhibits (below thresholds)
  if (aglFt < 900 && f.vertRate < 0) out.inhibit = '<900ft AGL · DESCEND inhibited'
  else if (aglFt < 1100 && f.vertRate < -1500) out.inhibit = '<1100ft AGL · INCREASE DESCENT inhibited'
  else if (aglFt < 1450 && f.vertRate > 2500) out.inhibit = '<1450ft AGL · high VS climb RA inhibited'
  else if (f.altitudeFt > 30000 && f.velocityKts > 480 && f.vertRate > 500) out.inhibit = 'FL300+ M>0.9 · INCREASE CLIMB inhibited'
  else if (f.ground) out.inhibit = 'WoW · all RAs inhibited (ground)'

  // RA trigger: tauR < SL raTau AND geometric
  if (out.tauR < sl.raTau && bestD < 6 && Math.abs(out.altDiff) < 1200) {
    out.active = true
    // Sense selection — pick climb if intruder lower, descend if higher (no-cross when possible)
    if (out.altDiff > 200) {  // intruder above
      out.sense = 'DESCEND'
      out.vRateTargetFpm = -1500
      out.cmd = 'CORRECTIVE'
    } else if (out.altDiff < -200) {  // intruder below
      out.sense = 'CLIMB'
      out.vRateTargetFpm = 1500
      out.cmd = 'CORRECTIVE'
    } else {  // co-altitude, choose by vertical rates
      if (f.vertRate >= 0) { out.sense = 'CLIMB'; out.vRateTargetFpm = 1500 }
      else { out.sense = 'DESCEND'; out.vRateTargetFpm = -1500 }
      out.cmd = out.tauV < 15 ? 'CORRECTIVE' : 'PREVENTIVE'
    }
    if (out.cmd === 'PREVENTIVE') out.sense = (out.altDiff > 0 ? 'LEVEL-OFF' : 'MAINTAIN-VS')

    // INCREASE/REVERSAL escalation
    if (out.tauR < 12 && out.zminAtCpa < 200) {
      if (spec.rev === 'CH7.1' && r2 < 0.40) {
        out.cmd = 'REVERSAL'
        out.sense = out.sense === 'CLIMB' ? 'DESCEND' : out.sense === 'DESCEND' ? 'CLIMB' : out.sense
        out.vRateTargetFpm = out.vRateTargetFpm > 0 ? -2500 : 2500
        out.reversalReason = 'Intruder non-compliance · sense reversal per DO-185B §2.2.5.4(c)'
      } else if (out.tauR < 10) {
        out.cmd = 'STRENGTHEN'
        out.vRateTargetFpm = out.vRateTargetFpm > 0 ? 2500 : -2500
      }
    }

    // CLEAR if range opening or zmin large
    if (out.tauR > sl.raTau || out.zminAtCpa > 800 || closing < -50) {
      out.cmd = 'CLEAR'
      out.sense = 'NONE'
      out.active = false
    }

    // Crew compliance — synthetic 6% non-compliant + 11% slow
    if (out.active) {
      if (r3 < 0.06) out.compliance = 'OPPOSITE'  // Überlingen mode
      else if (r3 < 0.17) out.compliance = 'SLOW'
      else if (r4 < 0.04) out.compliance = 'NONE-ENGAGED'
      else out.compliance = 'GOOD'
    }

    // Inhibit overrides — if RA was inhibited, demote to TA
    if (out.inhibit && (out.sense === 'DESCEND' || out.sense === 'CLIMB')) {
      if (out.inhibit.includes('DESCEND') && out.sense === 'DESCEND') {
        out.cmd = 'PREVENTIVE'; out.sense = 'MAINTAIN-VS'; out.vRateTargetFpm = 0
      }
      if (out.inhibit.includes('high VS') && out.vRateTargetFpm > 1500) {
        out.vRateTargetFpm = 1500
      }
    }
  } else if (out.tauR < sl.taTau && bestD < 8) {
    // TA only
    out.active = true
    out.cmd = 'PREVENTIVE'
    out.sense = 'NONE'
  }

  return out
}

interface Row { f: PFlight; sl: SlBand; spec: TcasSpec; ra: RaState
  drivers: Record<string, number>; score: number; tier: Tier; aglFt: number; phase: string }

const PRECEDENT = [
  { date:'2002-07-01', cs:'BTC2937/DHX611', type:'TU54/B752', loc:'Überlingen', fatal:71, brief:'TU154 received CLIMB RA but obeyed ATC DESCEND instruction · pre-Change-7.1 · 71 fatal · direct cause of 7.1 reversal-logic + Doc 4444 §15.7.4 ATC-shall-not-overrule', ref:'BFU AX001-1-2/02' },
  { date:'2006-09-29', cs:'GLO1907/N600XL', type:'B738/E55P',  loc:'Brazil-Amazonia', fatal:154, brief:'EMB-135BJ XPDR off in cruise — TCAS could not coordinate, head-on collision FL370 · 154 fatal · drove subsequent SSR XPDR maintenance ADs', ref:'CENIPA RF 1907/06' },
  { date:'2001-01-31', cs:'JAL907/JAL958', type:'B744/DC10',   loc:'Yokohama-FIR',   fatal:0,   brief:'JAL907 received CLIMB RA but obeyed ATC DESCEND, JAL958 received DESCEND and complied — near miss · drove Change 7.0 "ADJUST V/S, ADJUST" callout clarification at 7.1', ref:'JTSB AA2002-5' },
  { date:'1986-08-31', cs:'AMX498/N4891F',  type:'DC9/PA28',   loc:'Cerritos KLAX',   fatal:82,  brief:'PA28 Piper without XPDR in LAX TCA · DC-9 had no TCAS yet · drove §91.215 Mode-C Veil and TCAS-II carriage mandate', ref:'NTSB AAR-87-07' },
  { date:'2014-03-04', cs:'EZY3343/ENT200', type:'A320/AT75',  loc:'Greece-Aegean',  fatal:0,   brief:'Multiple opposing TA-then-RA cascade in TMA · revealed nuisance-RA suppression need in CH7.1', ref:'EUROCONTROL ACAS Bull 18' },
  { date:'2009-09-15', cs:'BAW786/UPS232',  type:'A319/B763',  loc:'CYUL TMA',       fatal:0,   brief:'Late-issued RA at 10500ft due ground STCA-induced manoeuvre · RA sense disagreement, A319 reversed CH7.1 · validation of reversal logic', ref:'TSB A09Q0150' },
  { date:'2017-07-08', cs:'AC759/UAL1/PHL115/QFA011', type:'A320/B789/A321/B742', loc:'KSFO-28R taxiway-C', fatal:0, brief:'Near-disaster 28R offset onto Taxiway C (4 AC on C) · TCAS-resolution role moot (visual GA) · runway-incursion not TCAS event', ref:'NTSB AAR-18-01' },
  { date:'2023-01-13', cs:'B6206/AAL106',   type:'B738/B738',  loc:'KJFK 4L/31L',     fatal:0,   brief:'Runway incursion 4L vs 31L · TCAS in ground inhibit (WoW) · drove ASDE-X / RWSL improvements', ref:'NTSB DCA23FA113' },
]

export default function TcasRaCompliance({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [horizonS, setHorizonS] = useState(40)
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [revFilter, setRevFilter] = useState<string>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'PAIRS'|'INHIBITS'|'PRECEDENT'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shVec, setShVec] = useState(true)

  // AGL approximation (without terrain DB we use a 250-ft typical airport-elevation offset)
  function aglOf(f: PFlight): number {
    if (f.ground) return 0
    return Math.max(0, f.altitudeFt - 250)
  }
  function phaseOf(f: PFlight): string {
    if (f.ground) return 'GND'
    const agl = aglOf(f)
    if (agl < 1000 && f.vertRate > 200) return 'TKO'
    if (agl < 1500 && f.vertRate < -200) return 'APP'
    if (agl < 5000 && f.vertRate > 200) return 'CLB-LO'
    if (f.altitudeFt > 28000 && Math.abs(f.vertRate) < 300) return 'CRZ'
    if (f.vertRate > 300) return 'CLB'
    if (f.vertRate < -300) return 'DSC'
    return 'LVL'
  }

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const agl = aglOf(f)
      const sl = slFor(agl, f.altitudeFt)
      const spec = tcasOf(f.type)
      const ph = phaseOf(f)
      const ra = syntheticRa(f, flights, spec, sl, agl)

      // Drivers 0-100
      const dRA = ra.cmd === 'REVERSAL' ? 95 : ra.cmd === 'STRENGTHEN' ? 75 : ra.cmd === 'CORRECTIVE' ? 60 : ra.cmd === 'PREVENTIVE' ? 35 : ra.cmd === 'CLEAR' ? 8 : 0
      const dTAU = ra.tauR < 15 ? 90 : ra.tauR < 25 ? 65 : ra.tauR < 35 ? 35 : ra.tauR < 60 ? 15 : 0
      const dCMP = ra.compliance === 'OPPOSITE' ? 100 : ra.compliance === 'NONE-ENGAGED' ? 80 : ra.compliance === 'SLOW' ? 55 : 5
      const dCOO = (ra.intruderRev === 'CH7.0' || ra.intruderRev === 'NONE') && ra.active ? 70 : 0
      const dINH = ra.inhibit && ra.active ? 60 : ra.inhibit ? 20 : 0
      const dCLO = ra.closingKts > 800 ? 90 : ra.closingKts > 600 ? 65 : ra.closingKts > 400 ? 40 : ra.closingKts > 200 ? 18 : 0
      const dZMC = ra.active && ra.zminAtCpa < 200 ? 90 : ra.active && ra.zminAtCpa < 500 ? 50 : 0
      const dSLB = sl.sl <= 3 && ra.active ? 50 : 0

      const drivers = { RA:dRA, TAU:dTAU, CMP:dCMP, COO:dCOO, INH:dINH, CLO:dCLO, ZMC:dZMC, SLB:dSLB }
      const arr = Object.values(drivers)
      const mx = Math.max(...arr), mn = arr.reduce((a,b)=>a+b,0)/arr.length
      let score = (mx * 0.66 + mn * 0.34) * advMul

      // Hard escalators
      if (ra.cmd === 'REVERSAL' && ra.compliance === 'OPPOSITE') score = Math.max(score, 96)
      else if (ra.cmd === 'REVERSAL') score = Math.max(score, 88)
      else if (ra.compliance === 'OPPOSITE' && ra.active) score = Math.max(score, 92)
      if (ra.active && ra.intruderRev === 'NONE') score = Math.max(score, 85)
      if (ra.active && sl.sl <= 3) score = Math.max(score, 70)

      score = clamp(score, 0, 100)

      let tier: Tier = 'CLEAR'
      if (f.ground) tier = 'OFF'
      else if (ra.cmd === 'REVERSAL' || score >= 88) tier = 'REVERSAL'
      else if (ra.cmd === 'CORRECTIVE' || ra.cmd === 'STRENGTHEN' || score >= 65) tier = 'CORRECTIVE'
      else if (ra.cmd === 'PREVENTIVE' || score >= 40) tier = 'PREVENTIVE'
      else if (ra.active || score >= 22) tier = 'TA'
      else if (ra.rangeNm < 8 && Math.abs(ra.altDiff) < 1500) tier = 'PROX'
      else tier = 'CLEAR'

      out.push({ f, sl, spec, ra, drivers, score, tier, aglFt: agl, phase: ph })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, horizonS])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const SRC = 'tcasra-src'
    const SRC_VEC = 'tcasra-vec-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    ensureSrc(SRC); ensureSrc(SRC_VEC)

    const writeAll = () => {
      const view = rows.filter(r => (tierFilter==='ALL'||r.tier===tierFilter) && (revFilter==='ALL'||r.spec.rev===revFilter))
      const acFeats: any[] = []
      const vecFeats: any[] = []
      for (const r of view) {
        const labelBits = [
          r.f.callsign||r.f.icao,
          `SL${r.sl.sl}`,
          r.ra.cmd === 'NONE' ? '' : r.ra.cmd,
          r.ra.sense === 'NONE' ? '' : r.ra.sense,
        ].filter(Boolean).join(' · ')
        acFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ tier:r.tier, color:TIER_COLOR[r.tier], score:r.score, sz: 6 + (r.score/100)*14, label: labelBits } })

        // Pair link to intruder for active RA encounters
        if (r.ra.active && r.ra.rangeNm < 10) {
          // find intruder coords from callsign — re-search nearest within filter window
          let best: PFlight | null = null
          let bestD = Infinity
          for (const o of flights) {
            if (o.icao === r.f.icao) continue
            if ((o.callsign || o.icao) !== r.ra.intruderCs) continue
            const d = nmDist(r.f.lat, r.f.lng, o.lat, o.lng)
            if (d < bestD) { bestD = d; best = o as any }
          }
          if (best) {
            vecFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[r.f.lng,r.f.lat],[best.lng,best.lat]] }, properties:{ color:TIER_COLOR[r.tier] } })
            // RA sense vector — short arrow up/down at ownship
            const dKm = 4
            const dy = r.ra.sense === 'CLIMB' ? dKm/111.32 : r.ra.sense === 'DESCEND' ? -dKm/111.32 : 0
            if (dy !== 0) {
              vecFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[r.f.lng,r.f.lat],[r.f.lng,r.f.lat+dy]] }, properties:{ color:TIER_COLOR[r.tier] } })
            }
          }
        }
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_VEC) as any).setData({ type:'FeatureCollection', features: shVec ? vecFeats : [] })
    }

    if (!map.getLayer('tcasra-halo'))
      map.addLayer({ id:'tcasra-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.16, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.82 } })
    if (!map.getLayer('tcasra-pin'))
      map.addLayer({ id:'tcasra-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 40], paint:{ 'circle-radius':4.8, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('tcasra-lbl'))
      map.addLayer({ id:'tcasra-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('tcasra-vec'))
      map.addLayer({ id:'tcasra-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.8, 'line-dasharray':[2,1.6], 'line-opacity':0.85 } })

    writeAll()
    return () => {
      for (const id of ['tcasra-lbl','tcasra-pin','tcasra-halo','tcasra-vec']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_VEC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, revFilter, shHalo, shPin, shLbl, shVec, flights])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (revFilter==='ALL'||r.spec.rev===revFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type||'').toLowerCase().includes(search.toLowerCase()) ||
      (r.f.operator||'').toLowerCase().includes(search.toLowerCase()) ||
      r.ra.intruderCs.toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { 'REVERSAL':0, 'CORRECTIVE':0, 'PREVENTIVE':0, 'TA':0, 'PROX':0, 'CLEAR':0, 'OFF':0 }
  for (const r of rows) counts[r.tier]++
  const activeRas = rows.filter(r => r.ra.active && r.ra.cmd !== 'PREVENTIVE').length
  const reversals = rows.filter(r => r.ra.cmd === 'REVERSAL').length
  const opposite = rows.filter(r => r.ra.compliance === 'OPPOSITE' && r.ra.active).length
  const ch71 = rows.filter(r => r.spec.rev === 'CH7.1').length
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const worst = rows[0]

  // SL aggregation
  const slMap = new Map<number, { count:number; ra:number; rev:number; opp:number; band: SlBand }>()
  for (const r of rows) {
    const e = slMap.get(r.sl.sl) || { count:0, ra:0, rev:0, opp:0, band:r.sl }
    e.count++
    if (r.ra.active && r.ra.cmd !== 'PREVENTIVE') e.ra++
    if (r.ra.cmd === 'REVERSAL') e.rev++
    if (r.ra.compliance === 'OPPOSITE' && r.ra.active) e.opp++
    slMap.set(r.sl.sl, e)
  }
  const slRows = Array.from(slMap.entries()).map(([sl, e]) => ({ sl, ...e })).sort((a,b)=> a.sl-b.sl)

  // Active pairs
  const pairs = rows.filter(r => r.ra.active).map(r => ({
    own: r.f.callsign||r.f.icao,
    ownType: r.f.type||'—',
    intr: r.ra.intruderCs, intrType: r.ra.intruderType, intrRev: r.ra.intruderRev,
    rng: r.ra.rangeNm, dAlt: r.ra.altDiff, closing: r.ra.closingKts,
    tauR: r.ra.tauR, tauV: r.ra.tauV, sense: r.ra.sense, cmd: r.ra.cmd,
    zmin: r.ra.zminAtCpa, comp: r.ra.compliance, inhib: r.ra.inhibit,
    tier: r.tier, score: r.score,
  })).sort((a,b)=> a.tauR - b.tauR).slice(0, 60)

  // Inhibits aggregation
  const inhibitMap = new Map<string,number>()
  for (const r of rows) {
    if (!r.ra.inhibit) continue
    inhibitMap.set(r.ra.inhibit, (inhibitMap.get(r.ra.inhibit)||0) + 1)
  }
  const inhibRows = Array.from(inhibitMap.entries()).map(([k,v])=>({k,v})).sort((a,b)=> b.v - a.v)

  const allRevs = ['ALL', ...Array.from(new Set(rows.map(r => r.spec.rev))).sort()]

  return (
    <div className="fixed top-16 right-3 z-40 w-[480px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">TCAS-RA</span>
          <span className="text-[10px] text-slate-400">DO-185B · CH7.1 · reversal / inhibit / SL · §121.356</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* tier strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter===t?'border':'border border-slate-700/60'}`} style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:undefined, color: TIER_COLOR[t] }}>{t.slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      {/* summary cells */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">RA-ACT</div><div className="text-slate-100 font-mono">{activeRas}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">REV</div><div className="font-mono" style={{color:TIER_COLOR['REVERSAL']}}>{reversals}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">OPP</div><div className="font-mono" style={{color:TIER_COLOR['REVERSAL']}}>{opposite}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">CH7.1</div><div className="text-slate-100 font-mono">{ch71}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||worst?.f.icao||'—'}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">HORIZON <span className="text-slate-200 font-mono">{horizonS}s</span>
            <input type="range" min="20" max="60" value={horizonS} onChange={e=>setHorizonS(+e.target.value)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {allRevs.map(rv => (
            <button key={rv} onClick={()=>setRevFilter(rv)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${revFilter===rv?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{rv}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['VEC',shVec,setShVec]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/intruder" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','PAIRS','INHIBITS','PRECEDENT'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab==='AIRCRAFT' && visible.slice(0,80).map((r,i) => (
          <div key={i} onClick={()=>onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
              <span className="font-mono text-slate-100">{r.f.callsign||r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type||'—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">SL{r.sl.sl}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.spec.rev}</span>
              {r.ra.inhibit && <span className="px-1 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR['PREVENTIVE']}33`, color:TIER_COLOR['PREVENTIVE'] }}>INHIB</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            {/* RA strip — 3 columns CMD · SENSE · COMPLIANCE */}
            <div className="mt-1 grid grid-cols-4 gap-1 font-mono">
              <div className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-center"><div className="text-[8px] text-slate-500">CMD</div><div className="text-[10px]" style={{ color: r.ra.cmd === 'NONE' ? '#475569' : TIER_COLOR[r.tier] }}>{r.ra.cmd}</div></div>
              <div className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-center"><div className="text-[8px] text-slate-500">SENSE</div><div className="text-[10px]" style={{ color: r.ra.sense === 'NONE' ? '#475569' : '#10b981' }}>{r.ra.sense}</div></div>
              <div className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-center"><div className="text-[8px] text-slate-500">VS-TGT</div><div className="text-[10px] text-slate-200">{r.ra.vRateTargetFpm === 0 ? '—' : `${r.ra.vRateTargetFpm > 0 ? '+' : ''}${r.ra.vRateTargetFpm}`}</div></div>
              <div className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-center"><div className="text-[8px] text-slate-500">CRW</div><div className="text-[10px]" style={{ color: r.ra.compliance === 'OPPOSITE' || r.ra.compliance === 'NONE-ENGAGED' ? '#ef4444' : r.ra.compliance === 'SLOW' ? '#f59e0b' : r.ra.active ? '#10b981' : '#475569' }}>{r.ra.active ? r.ra.compliance : '—'}</div></div>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>τR <span className="text-slate-100 font-mono">{r.ra.tauR < 999 ? r.ra.tauR.toFixed(0)+'s' : '—'}</span></div>
              <div>τV <span className="text-slate-100 font-mono">{r.ra.tauV < 999 ? r.ra.tauV.toFixed(0)+'s' : '—'}</span></div>
              <div>RNG <span className="text-slate-100 font-mono">{r.ra.rangeNm < 99 ? r.ra.rangeNm.toFixed(1)+'NM' : '—'}</span></div>
              <div>ΔALT <span className="text-slate-100 font-mono">{r.ra.altDiff > 0 ? '+' : ''}{r.ra.altDiff.toFixed(0)}</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>VS <span className="text-slate-100 font-mono">{r.f.vertRate > 0 ? '+' : ''}{r.f.vertRate.toFixed(0)}</span></div>
              <div>VC <span className="text-slate-100 font-mono">{r.ra.closingKts.toFixed(0)}kt</span></div>
              <div>zMIN <span className="text-slate-100 font-mono">{r.ra.active ? r.ra.zminAtCpa.toFixed(0)+'ft' : '—'}</span></div>
              <div>AGL <span className="text-slate-100 font-mono">{r.aglFt.toFixed(0)}</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v)}</span>
              ))}
            </div>
            {r.ra.active && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>› vs {r.ra.intruderCs} ({r.ra.intruderType}) · intr-eqp {r.ra.intruderRev}</div>}
            {r.ra.reversalReason && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR['REVERSAL']}}>! {r.ra.reversalReason}</div>}
            {r.ra.inhibit && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR['PREVENTIVE']}}>{`★ ${r.ra.inhibit}`}</div>}
            {!r.ra.active && r.tier === 'PROX' && <div className="mt-1 text-[9px] text-slate-500">proximate · range {r.ra.rangeNm.toFixed(1)}NM ΔALT {r.ra.altDiff > 0 ? '+' : ''}{r.ra.altDiff.toFixed(0)}ft</div>}
            {!r.ra.active && r.tier === 'CLEAR' && <div className="mt-1 text-[9px] text-slate-500">{r.spec.sw} · {r.sl.label}</div>}
            {r.tier === 'OFF' && <div className="mt-1 text-[9px] text-slate-500">ground · WoW · all RAs inhibited</div>}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length===0 && <div className="text-[10px] text-slate-500 italic">no airframes match current filters</div>}

        {tab==='PAIRS' && (
          <div className="space-y-1">
            <div className="text-[9px] text-slate-500 italic mb-1">Active TCAS-RA encounter pairs · sorted by τR (range-to-CPA in seconds) · "opp" rows = Überlingen-class compliance failure</div>
            {pairs.map((p, i) => (
              <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
                  <span className="font-mono text-slate-100">{p.own}</span>
                  <span className="text-slate-500">·</span>
                  <span className="font-mono text-slate-400">{p.ownType}</span>
                  <span className="px-1 rounded text-slate-500 text-[9px]">›</span>
                  <span className="font-mono text-slate-200">{p.intr}</span>
                  <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{p.intrType}</span>
                  <span className="px-1 rounded font-mono text-[9px]" style={{ background: p.intrRev === 'CH7.1' ? '#10b98133' : '#f5970833', color: p.intrRev === 'CH7.1' ? '#10b981' : '#f59e0b' }}>{p.intrRev}</span>
                  <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[p.tier]}33`, color:TIER_COLOR[p.tier] }}>{p.tier} {p.score.toFixed(0)}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>τR <span className="text-slate-100 font-mono">{p.tauR.toFixed(0)}s</span></div>
                  <div>τV <span className="text-slate-100 font-mono">{p.tauV < 999 ? p.tauV.toFixed(0)+'s' : '—'}</span></div>
                  <div>RNG <span className="text-slate-100 font-mono">{p.rng.toFixed(2)}NM</span></div>
                  <div>ΔALT <span className="text-slate-100 font-mono">{p.dAlt > 0 ? '+' : ''}{p.dAlt.toFixed(0)}</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>CMD <span className="font-mono" style={{ color:TIER_COLOR[p.tier] }}>{p.cmd}</span></div>
                  <div>SENSE <span className="text-slate-100 font-mono">{p.sense}</span></div>
                  <div>VC <span className="text-slate-100 font-mono">{p.closing.toFixed(0)}kt</span></div>
                  <div>zMIN <span className="text-slate-100 font-mono">{p.zmin.toFixed(0)}ft</span></div>
                </div>
                {p.comp === 'OPPOSITE' && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR['REVERSAL']}}>! crew opposite-sense — Überlingen class</div>}
                {p.comp === 'NONE-ENGAGED' && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR['REVERSAL']}}>! no crew response to RA</div>}
                {p.comp === 'SLOW' && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR['PREVENTIVE']}}>{'› crew slow (>5s)'}</div>}
                {p.inhib && <div className="mt-1 text-[9px] text-slate-500 italic">{p.inhib}</div>}
              </div>
            ))}
            {pairs.length === 0 && <div className="text-[10px] text-slate-500 italic">no active RA encounters in current data</div>}
          </div>
        )}

        {tab==='INHIBITS' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">Sensitivity-Level bands (DO-185B §2.2.3)</div>
              <div className="text-slate-400 leading-relaxed">SL controls warning-time thresholds and the protection volume. Low altitude inhibits RAs to avoid RA-induced CFIT.</div>
            </div>
            {slRows.map(s => (
              <div key={s.sl} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">SL{s.sl}</span>
                  <span className="text-slate-400">{s.band.label}</span>
                  <span className="ml-auto font-mono text-slate-100">×{s.count}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>TA-τ <span className="text-slate-100 font-mono">{s.band.taTau}s</span></div>
                  <div>RA-τ <span className="text-slate-100 font-mono">{s.band.raEnabled ? s.band.raTau+'s' : '—'}</span></div>
                  <div>DMOD <span className="text-slate-100 font-mono">{s.band.dmod.toFixed(2)}NM</span></div>
                  <div>ZTHR <span className="text-slate-100 font-mono">{s.band.zthr}ft</span></div>
                </div>
                <div className="grid grid-cols-3 gap-1 text-[10px] text-slate-400">
                  <div>RA-ACT <span className="font-mono" style={{color:TIER_COLOR['CORRECTIVE']}}>{s.ra}</span></div>
                  <div>REV <span className="font-mono" style={{color:TIER_COLOR['REVERSAL']}}>{s.rev}</span></div>
                  <div>OPP <span className="font-mono" style={{color:TIER_COLOR['REVERSAL']}}>{s.opp}</span></div>
                </div>
                <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden flex">
                  <div style={{ width:`${s.opp/Math.max(1,s.count)*100}%`, background:TIER_COLOR['REVERSAL'], height:'100%' }} />
                  <div style={{ width:`${s.rev/Math.max(1,s.count)*100}%`, background:TIER_COLOR['REVERSAL'], height:'100%' }} />
                  <div style={{ width:`${(s.ra-s.rev-s.opp)/Math.max(1,s.count)*100}%`, background:TIER_COLOR['CORRECTIVE'], height:'100%' }} />
                </div>
              </div>
            ))}
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">Active RA inhibits in current fleet (DO-185B §2.2.5.4)</div>
              {inhibRows.length === 0 && <div className="text-slate-500 italic">no inhibits flagged</div>}
              {inhibRows.map((ih,i) => (
                <div key={i} className="flex items-center justify-between mt-1 text-[10px]">
                  <span className="text-slate-400">{ih.k}</span>
                  <span className="font-mono text-slate-100">×{ih.v}</span>
                </div>
              ))}
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">DO-185B §2.2.5.4 — RA inhibit hardware bands</div>
              <div className="text-slate-400 leading-relaxed">
                <div>· &lt;1000ft AGL: all RAs inhibited (SL2)</div>
                <div>· &lt;900ft AGL: DESCEND inhibited</div>
                <div>· &lt;1100ft AGL: INCREASE DESCENT inhibited</div>
                <div>· &lt;1450ft AGL: high-rate climb (&gt;2500fpm) RAs inhibited</div>
                <div>· Landing gear DOWN: operator-policy RA suppression</div>
                <div>· FL300+ M&gt;0.9: INCREASE CLIMB inhibited</div>
                <div>· WoW (ground): all RAs inhibited</div>
              </div>
            </div>
          </div>
        )}

        {tab==='PRECEDENT' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">TCAS-II encounter precedent — Change 7.1 reversal-logic genesis</div>
              <div className="text-slate-400 leading-relaxed">
                The canonical 71-fatality Überlingen 2002 collision drove the worldwide Change 7.1 mandate (effective 2017 EASA / 2018 FAA-equivalent). 7.1 adds (a) sense-reversal logic when intruder fails to follow opposing RA, (b) clarified "ADJUST V/S, ADJUST" callout, (c) suppression of nuisance RAs on PRM/LDA parallel approaches, (d) ICAO Doc 4444 §15.7.4 controller-shall-not-overrule clause.
              </div>
            </div>
            {PRECEDENT.map(a => (
              <div key={a.cs+a.date} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
                  <span className="font-mono text-slate-100">{a.cs}</span>
                  <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{a.type}</span>
                  <span className="text-slate-500 font-mono">{a.date}</span>
                  <span className="text-slate-400 font-mono">{a.loc}</span>
                  {a.fatal>0 && <span className="ml-auto px-1 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR['REVERSAL']}33`, color:TIER_COLOR['REVERSAL'] }}>† {a.fatal}</span>}
                </div>
                <div className="mt-1 text-[10px] text-slate-300 leading-relaxed">{a.brief}</div>
                <div className="mt-1 text-[9px] text-slate-500 italic">{a.ref}</div>
              </div>
            ))}
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · 14 CFR §121.356 §125.224 §129.18 §91.221 / FAA AC 120-55D / TSO-C119d / TSO-C112 / FAA Order 7110.65BB §5-5 / Order 8900.1 V4 Ch1 · EASA AMC 20-15 / NPA 2009-08 / SIB 2018-22 · ICAO Annex 10 Vol IV §4.3 / Doc 4444 §15.7.4 / Doc 9863 ACAS Manual ed.2 / Doc 8168 PANS-OPS Vol I §3.2 · RTCA DO-185B / DO-185C / DO-300A / DO-260B · EUROCONTROL ACAS Bulletin 1-22 / ACAS II 7.1 Programme final report 2017 / ASARP / SCM analyses · BFU AX001-1-2/02 Überlingen / JTSB AA2002-5 Yokohama / CENIPA RF 1907/06 GOL1907 / NTSB AAR-87-07 Cerritos · Kuchar-Drumm LL J. 2007 / Kuchar-Yang IEEE 2000 / Munoz NASA TM-218022 / Holland AFRL-RH-WP-TR-2014 · Boeing FCTM Ch.8 / FCOM SP.16.20 · Airbus FCTM PRO-NOR-SOP-21 / FCOM PRO-ABN-TCAS · Embraer AOM §03 · CRJ FCOM Vol 2 §08.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
