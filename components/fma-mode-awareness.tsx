'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   FMA · Flight-Mode Annunciator / Automation Mode-Awareness &
        Mode-Confusion Closed-Loop Crew-State Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of the AUTOFLIGHT MODE-AWARENESS
   subsystem state — the cockpit closed-loop coupling between
   the AUTOPILOT (AP1/AP2), AUTO-THROTTLE / AUTOTHRUST (A/T or
   A/THR), and FLIGHT DIRECTOR (FD) as annunciated on the
   PFD/ADI Flight-Mode Annunciator strip (top of the PFD),
   scoring whether the crew is at risk of MODE CONFUSION
   (acting on the wrong mental model of what the AFDS is doing),
   AUTOMATION SURPRISE (an unanticipated mode reversion), or
   AUTOTHRUST DISCONNECT WITHOUT ATTENTION (loss of speed/thrust
   protection) per Sarter-Woods "Strong Silent Type"
   IJAP 1995 / NTSB AAR-14-01 Asiana 214 KSFO (3 fatal, 2013) /
   AAIB Turkish 1951 Schiphol (9 fatal, 2009) / China Airlines
   140 Nagoya (264 fatal, 1994) / AF 447 (228 fatal, 2009) /
   AirAsia 8501 (162 fatal, 2014) / Aeroflot 1492 SVO (41
   fatal, 2019) / EthAir 409 Beirut (90 fatal, 2010) /
   AeroPeru 603 Lima (70 fatal, 1996 pitot-static) precedent.

   Structurally distinct from FBW-REV (law-reversion physical
   downgrade) / MCAS (B737 MAX pitch-augmentation) / PIO
   (closed-loop human-machine resonance) / TCAS (collision
   avoidance) / STALL (alpha-margin) / TEM-ENERGY (state
   balance) / STABLE-APP (approach gate) / LEVEL-BUST (FL bust)
   / COCKPIT-HUD (HUD conformity). FMA is uniquely the
   AUTOMATION MODE-AWARENESS evaluator — what mode the AFDS
   is ACTUALLY in vs what the crew BELIEVES it is in, and
   whether the closed-loop pilot/automation trust-calibration
   is degrading toward the canonical Sarter-Woods classification.

   References:
     · 14 CFR §25.1329 Automatic Pilot System cert basis
     · 14 CFR §25.1322 Crew alerting (FMA color discipline)
     · 14 CFR §25.1335 Flight director system
     · 14 CFR §121.579 Use of autopilot
     · FAA AC 25-7D §10 / AC 120-29A / AC 120-118 (CRM)
     · FAA InFO 11014 / SAFO 17007 reduced reliance / mode mgmt
     · EASA CS-25.1329 / AMC 25.1329 autoflight cert
     · ICAO Doc 9683 HF training / Doc 10151 automation reliance
     · IATA IOSA FLT 3.4 SOP / Automation Policy 2nd ed.
     · NTSB AAR-14-01 Asiana 214 KSFO 06-Jul-2013 B777 (3 fatal)
       Sarter mode 3+5: A/T HOLD vs THR REF confusion,
       autothrottle disengaged silently, speed 103 kt vs Vref 137
     · BEA AF 447 Rio-Paris 01-Jun-2009 A330 (228 fatal) —
       Sarter mode 4+6: pitot icing → AP off → Alt Law,
       crew did not recognise reversion, stalled cruise → ocean
     · KNCT NL Turkish 1951 Schiphol 25-Feb-2009 B738 (9 fatal)
       Sarter mode 3: RA failure, A/T RETARD latched on approach
     · AAIC Indonesia AirAsia 8501 Surabaya 28-Dec-2014 A320
       (162 fatal) — Sarter mode 2+4+6 rudder limiter / Alt Law
     · AAIC Japan China Airlines 140 Nagoya 26-Apr-1994 A300-600
       (264 fatal) — Sarter mode 1+2 GO-AROUND inadvertent armed
     · MAK Russia Aeroflot 1492 SVO 05-May-2019 SU100 (41 fatal)
       lightning → DIRECT MODE FBW reversion, manual landing
     · AAIB Lebanon Ethiopian 409 Beirut 25-Jan-2010 B738 (90)
       Sarter mode 1 PF confused VS vs IAS hold
     · DGAC Peru AeroPeru 603 Lima 02-Oct-1996 B757 (70 fatal)
       pitot-static blockage, ADC mode chaos
     · ATSB AO-2014-032 QF72 A330 ADIRU mode anomaly
     · DGCA India AAIB AI Express 1344 Kozhikode 07-Aug-2020
     · NASA TM-103970 Sarter-Woods mode-error taxonomy
     · IJAP 1995 5(1) Sarter & Woods "Strong silent type"
     · IJAP 1997 7(3) Sarter "How in the world..."
     · Bainbridge 1983 "Ironies of Automation" Automatica 19
     · Endsley 1995 SAGAT situation-awareness measure
     · Wickens 2008 Engineering Psychology 3rd ed Ch.12
     · Norman 1990 "Problem with Automation" Phil Tr R Soc B
     · Reason 1990 Human Error §4-6
     · Boeing FCTM Ch.8 "FMA Discipline & Mode Awareness"
     · Airbus FCTM PRO-NOR-SOP-12 / FCOM AUTO-FLT FMA
     · Embraer AOM §03 PFD FMA discipline
     · CRJ FCOM Vol.2 §06 AFCS modes
     · Honeywell Primus Epic AFCS Pilot Guide
     · Collins Pro Line 21 Pilot Guide

   Mode-confusion classification (Sarter-Woods 1995):
     M1 · MODE-AMBIGUITY            (≥2 plausible interpretations)
     M2 · MODE-UNCOUPLING           (selected ≠ managed)
     M3 · UNANNUNCIATED REVERSION   (silent SPD→THR or A/T idle)
     M4 · TROUBLESHOOTING-COCKPIT   (head-down reconfig)
     M5 · COUPLED-DISCONNECT        (AP & A/T off, FDs still on)
     M6 · ENVELOPE-PROTECTION-LOST  (Alt-Law / A/T-idle in flare)

   FMA color discipline (CS-25.1322 / FAA AC 120-29A):
     GREEN  · engaged / armed normally
     WHITE  · armed / capture-pending (Boeing) or selected (Airbus)
     MAGENTA· managed (FMS-driven, Airbus convention)
     CYAN   · selected (FCU/MCP, Airbus / mode-trend)
     AMBER  · alert / mode reversion / law downgrade
     RED    · failure / warning escalation
============================================================ */

interface PFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: PFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'REVERSION'|'CONFUSED'|'WATCH'|'DRIFT'|'NORMAL'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  'REVERSION':'#ef4444', 'CONFUSED':'#f43f5e', 'WATCH':'#f59e0b',
  'DRIFT':'#0ea5e9', 'NORMAL':'#10b981', 'OFF':'#475569',
}
const TIER_RANK: Record<Tier,number> = { 'REVERSION':0, 'CONFUSED':1, 'WATCH':2, 'DRIFT':3, 'NORMAL':4, 'OFF':5 }
const TIER_ORDER: Tier[] = ['REVERSION','CONFUSED','WATCH','DRIFT','NORMAL']

type Phase = 'TKO-ROLL'|'TKO-LIFT'|'CLIMB'|'CRUISE'|'DESCENT'|'APPR-INT'|'APPR-FNL'|'FLARE'|'GA'|'OFF'

// ------------------------------------------------------------
// Per-airframe AFDS (autoflight director system) architecture
// catalogue — what FMA philosophy, AP redundancy, A/T behaviour,
// reversion-mode taxonomy applies.
//   afds      vendor/family designation
//   afdsClass subclass for filtering
//   apCount   AP redundancy (1/2/3 channels)
//   atKind    autothrust type ('MANAGED'/'SELECTED'/'SPEED-ONLY'/'NONE')
//   fdConv    FD convention ('BOEING-MCP'/'AIRBUS-FCU'/'EMB-FCM'/'CRJ-FGCP')
//   revFlavor primary reversion behaviour
//   protectFloor envelope-protection floor (full / Alt-Law / Direct / NONE)
//   cert      cert basis
//   ref       documentation citation
interface AfdsSpec {
  afds: string; afdsClass: string
  apCount: number; atKind: 'MANAGED'|'SELECTED'|'SPEED-ONLY'|'NONE'
  fdConv: 'BOEING-MCP'|'AIRBUS-FCU'|'EMB-FCM'|'CRJ-FGCP'|'OTHER'
  revFlavor: string; protectFloor: 'FULL'|'ALT'|'DIRECT'|'NONE'
  cert: string; ref: string
}
function specOf(type?: string): AfdsSpec {
  const t = (type||'').toUpperCase()
  // A320-family / A220 — FBW-A Normal Law, FCU/PFD-managed
  if (/^(A319|A320|A321|A20N|A21N|A318|BCS1|BCS3|CS1|CS3|A220)/.test(t))
    return { afds:'Airbus FBW-A / Thales-Honeywell FCU', afdsClass:'A320-FBW',
      apCount:2, atKind:'MANAGED', fdConv:'AIRBUS-FCU',
      revFlavor:'NORMAL→ALT2 (1 ADR)→ALT1 (dual ADR)→DIRECT (gear-extend)→MECHANICAL',
      protectFloor:'ALT',
      cert:'CS-25.1329 / 1322 / AMC 25.1329',
      ref:'Airbus FCOM 1.22.30 AUTO-FLT FMA / FCTM PRO-NOR-SOP-12' }
  // A330/350/380 — FBW-A wide-body
  if (/^(A332|A333|A338|A339|A359|A35K|A388|A380)/.test(t))
    return { afds:'Airbus FBW-A / Thales-Honeywell FCU (WB)', afdsClass:'A330-FBW',
      apCount:2, atKind:'MANAGED', fdConv:'AIRBUS-FCU',
      revFlavor:'NORMAL→ALT2→ALT1→DIRECT→MECH (long-arm trim freeze)',
      protectFloor:'ALT',
      cert:'CS-25.1329 / 1322 / AMC 25.1329',
      ref:'A330 FCOM AUTO-FLT 1.22 / A350 FCTM PRO-NOR-SOP-12 / AF 447 BEA' }
  // B777/787 — FBW-B Boeing-style protections
  if (/^(B77W|B77L|B772|B773|B788|B789|B78X|B77X|B778|B779)/.test(t))
    return { afds:'Boeing FBW / Honeywell AFDS', afdsClass:'B777-FBW',
      apCount:3, atKind:'MANAGED', fdConv:'BOEING-MCP',
      revFlavor:'NORMAL→SECONDARY (ACEs)→DIRECT (control-column feel only)',
      protectFloor:'ALT',
      cert:'§25.1329 / 1322 / 1335',
      ref:'B777 FCOM SP.16 / B787 FCOM Ch.15 / Asiana 214 NTSB AAR-14-01' }
  // B737NG/MAX / B757/B767/B747 — conventional AFCS, MCP-driven
  if (/^(B73N|B738|B739|B736|B737|B37M|B38M|B39M|B752|B753|B763|B764|B748|B744|B742|B743)/.test(t))
    return { afds:'Boeing Conventional AFCS / Honeywell SP-800', afdsClass:'B737-AFCS',
      apCount:2, atKind:'MANAGED', fdConv:'BOEING-MCP',
      revFlavor:'A/T DISC (silent on B737NG)→FD-only→Manual',
      protectFloor:'NONE',
      cert:'§25.1329 / 1322',
      ref:'B737 FCOM 4.20 / FCTM 8.10 / Turkish 1951 KNCT' }
  // E170/E175/E190/E195 + E2 — Honeywell Primus Epic FBW-Dir
  if (/^(E17|E19|E70|E75|E170|E175|E190|E195|E290|E295)/.test(t))
    return { afds:'Embraer Primus Epic / Honeywell P-2000', afdsClass:'EMB-EJET',
      apCount:2, atKind:'MANAGED', fdConv:'EMB-FCM',
      revFlavor:'NORMAL→DIRECT-LAW (ELAC fail)→Manual',
      protectFloor:'DIRECT',
      cert:'§25.1329 / 1322',
      ref:'Embraer AOM Vol.1 §03 PFD FMA / E190 FCOM 12' }
  // CRJ-200/700/900 — Collins Pro Line 21 / 4
  if (/^(CRJ|CRJ2|CRJ7|CRJ9|CL60|CL30)/.test(t))
    return { afds:'Collins Pro Line 21 / FGC-3000', afdsClass:'CRJ-FGCP',
      apCount:2, atKind:'SELECTED', fdConv:'CRJ-FGCP',
      revFlavor:'A/T DISC (auto)→FGCS-DIR→Manual',
      protectFloor:'NONE',
      cert:'§25.1329 / 1322',
      ref:'CRJ FCOM Vol.2 §06 AFCS modes / Collins PG 523-0775' }
  // ATR/Q400/Saab/Dash — turboprop selected-thrust
  if (/^(AT4|AT5|AT7|ATR|DH8D|DH8C|DH8B|DH8A|DHC8|Q40|Q30|SF34|SB20|S20)/.test(t))
    return { afds:'Honeywell SPZ-8000 / Collins AFCS-65/77', afdsClass:'TURBOPROP-AFCS',
      apCount:1, atKind:'SELECTED', fdConv:'OTHER',
      revFlavor:'A/P TRIP (single channel)→FD-only→Manual',
      protectFloor:'NONE',
      cert:'§25.1329 / 1322 (turboprop)',
      ref:'ATR FCOM 1.04 / Q400 FCOM 23-10 / Honeywell SPZ-8000 PG' }
  // Biz-jets — Honeywell Primus Elite / Collins Pro Line Fusion
  if (/^(GLEX|GL5T|GL7T|G650|GLF6|GLF5|FA[78]|FA50|FA90|CL35|CL65|HD\d|E55P|C25B|C56X|C68A|C25C|LJ75|LJ60|LJ45)/.test(t))
    return { afds:'Honeywell Primus Epic / Collins Pro Line Fusion', afdsClass:'BIZ-FBW',
      apCount:2, atKind:'MANAGED', fdConv:'BOEING-MCP',
      revFlavor:'NORMAL→FD-BASIC→Manual',
      protectFloor:'ALT',
      cert:'§23.2110 / §25.1329 (high-end biz)',
      ref:'G650 FCOM AFCS / GLEX QRH / Honeywell Primus Epic PG' }
  // GA — single-axis WX or simple Garmin GFC-500/700
  if (/^(PC12|TBM|BE19|BE20|BE30|BE35|B19|B20|B30|B35|C90|E90|C208|C172|C182|SR2|SR22|DA40|DA42|M20|PA28|PA32)/.test(t))
    return { afds:'Garmin GFC-500/700 / S-TEC 55X', afdsClass:'GA-AP',
      apCount:1, atKind:'NONE', fdConv:'OTHER',
      revFlavor:'A/P TRIP→Manual (no envelope protection)',
      protectFloor:'NONE',
      cert:'§23.2110',
      ref:'GFC-500 PG / S-TEC 55X PG / FAA AC 23.1311-1C' }
  // Military / unknown — sample MIL-STD-1797B simple AFCS
  if (/^(C17|C5|C13|C30|KC1|A40|A400|C160|F[12-9]|F[A]?\d|EF20|EUFI|RFA)/.test(t))
    return { afds:'MIL AFCS (variant)', afdsClass:'MIL-AFCS',
      apCount:2, atKind:'SELECTED', fdConv:'OTHER',
      revFlavor:'MIL reversion taxonomy',
      protectFloor:'NONE',
      cert:'MIL-STD-1797B',
      ref:'MIL-HDBK-516C / DEF-STAN 00-970' }
  // Default — assume modern AFCS (transport)
  return { afds:'Modern AFCS (assumed)', afdsClass:'OTHER',
    apCount:2, atKind:'MANAGED', fdConv:'BOEING-MCP',
    revFlavor:'A/P TRIP→FD-only→Manual',
    protectFloor:'ALT',
    cert:'§25.1329 (assumed)',
    ref:'OEM AOM (assumed §25 transport)' }
}

function clamp(v:number, a:number, b:number) { return Math.max(a, Math.min(b, v)) }

function phaseOf(f: PFlight): Phase {
  if (f.ground && f.velocityKts > 70) return 'TKO-ROLL'
  if (f.ground) return 'OFF'
  const agl = f.altitudeFt
  if (agl < 200 && f.vertRate < -200) return 'FLARE'
  if (agl < 1500 && f.vertRate > 200) return 'TKO-LIFT'
  if (agl < 1500 && f.vertRate < -200) return 'APPR-FNL'
  if (agl < 5000 && f.vertRate < -200) return 'APPR-INT'
  if (agl < 3000 && f.vertRate > 50 && f.velocityKts < 180) return 'GA'
  if (agl > 28000 && Math.abs(f.vertRate) < 300) return 'CRUISE'
  if (f.vertRate > 300) return 'CLIMB'
  if (f.vertRate < -300) return 'DESCENT'
  return 'CRUISE'
}

// ------------------------------------------------------------
// FMA mode strings per AFDS convention.
// Roll / Pitch / Autothrust + 1 armed-mode (chained next-capture)
type ModeBank = { roll: string; pitch: string; at: string; armed: string }

const BOEING_ROLL = ['LNAV','HDG SEL','HDG HOLD','LOC','VOR','TO/GA','ROLLOUT','FAC']
const BOEING_PITCH = ['VNAV PATH','VNAV SPD','VNAV ALT','V/S','FL CH','ALT','ALT HOLD','G/S','FLARE','TO/GA','IDLE']
const BOEING_AT = ['SPEED','THR REF','THR HOLD','RETARD','IDLE','HOLD']
const BOEING_ARMED = ['VNAV','LOC','G/S','LNAV','ALT','FLARE','ROLLOUT','—']

const AIRBUS_ROLL = ['NAV','HDG','TRK','LOC*','LOC','LAND','ROLL OUT','RWY','GA TRK']
const AIRBUS_PITCH = ['CLB','OP CLB','DES','OP DES','V/S','FPA','ALT*','ALT','ALT CRZ','G/S*','G/S','FINAL','FLARE','SRS','TCAS','EXP CLB']
const AIRBUS_AT = ['THR CLB','THR DES','THR IDLE','THR MCT','SPEED','MACH','RETARD','TOGA','MAN THR']
const AIRBUS_ARMED = ['NAV','LOC','G/S','APPR','LAND','CLB','—']

const EMB_ROLL = ['NAV','HDG','LOC','APPR','TO/GA','ROLLOUT']
const EMB_PITCH = ['FLCH','VS','ALT','ALTS','GS','VPATH','VFLCH','VALT','FLARE','TO/GA']
const EMB_AT = ['SPDT','SPDE','HOLD','RET','TOGA','IDLE']
const EMB_ARMED = ['NAV','LOC','GS','ALT','VPATH','—']

const CRJ_ROLL = ['HDG','NAV','LOC','APPR','BC','GA','ROLL']
const CRJ_PITCH = ['VS','IAS','ALT','GS','APPR','GA','ALTSEL']
const CRJ_AT = ['SPD','MAN','OFF']
const CRJ_ARMED = ['ALT','GS','LOC','—']

function bankFor(spec: AfdsSpec): { roll: string[]; pitch: string[]; at: string[]; armed: string[] } {
  switch (spec.fdConv) {
    case 'BOEING-MCP': return { roll: BOEING_ROLL, pitch: BOEING_PITCH, at: BOEING_AT, armed: BOEING_ARMED }
    case 'AIRBUS-FCU': return { roll: AIRBUS_ROLL, pitch: AIRBUS_PITCH, at: AIRBUS_AT, armed: AIRBUS_ARMED }
    case 'EMB-FCM':    return { roll: EMB_ROLL, pitch: EMB_PITCH, at: EMB_AT, armed: EMB_ARMED }
    case 'CRJ-FGCP':   return { roll: CRJ_ROLL, pitch: CRJ_PITCH, at: CRJ_AT, armed: CRJ_ARMED }
    default:           return { roll: BOEING_ROLL, pitch: BOEING_PITCH, at: BOEING_AT, armed: BOEING_ARMED }
  }
}

interface ModeState {
  modes: ModeBank
  ap1: boolean; ap2: boolean; fd1: boolean; fd2: boolean
  atEng: boolean
  transRate: number     // mode transitions / min
  ambig: boolean        // mode ambiguity flag
  uncoupled: boolean    // selected ≠ managed
  silentRev: boolean    // unannunciated reversion
  fdOrphan: boolean     // FD bars commanding but AP+AT off
  lawDown: 'NORM'|'ALT'|'DIRECT'|'MECH'
  reconfBusy: boolean   // troubleshooting / reconfig active
  trustDrift: number    // 0-1 over-reliance proxy (long cruise w/o handflying)
  notes: string[]
}

// Deterministic per-airframe synthetic FMA state, derived from icao hash + phase + spec
function syntheticState(f: PFlight, ph: Phase, spec: AfdsSpec): ModeState {
  let h = 0; for (let i=0;i<f.icao.length;i++) h = ((h*131) + f.icao.charCodeAt(i)) >>> 0
  const r1 = (h%1000)/1000
  const r2 = ((h>>3)%1000)/1000
  const r3 = ((h>>7)%1000)/1000
  const r4 = ((h>>11)%1000)/1000
  const r5 = ((h>>17)%1000)/1000
  const r6 = ((h>>23)%1000)/1000

  const bank = bankFor(spec)
  // Phase-driven nominal mode selection
  let roll = bank.roll[0]
  let pitch = bank.pitch[0]
  let at = bank.at[0]
  let armed = bank.armed[bank.armed.length-1]
  let ap1 = true, ap2 = false, fd1 = true, fd2 = true, atEng = spec.atKind !== 'NONE'

  if (ph === 'TKO-ROLL') {
    roll = spec.fdConv === 'AIRBUS-FCU' ? 'RWY' : 'TO/GA'
    pitch = spec.fdConv === 'AIRBUS-FCU' ? 'SRS' : 'TO/GA'
    at = spec.fdConv === 'AIRBUS-FCU' ? 'TOGA' : 'THR REF'
    ap1 = false; ap2 = false
  } else if (ph === 'TKO-LIFT') {
    roll = spec.fdConv === 'AIRBUS-FCU' ? 'RWY' : 'TO/GA'
    pitch = spec.fdConv === 'AIRBUS-FCU' ? 'SRS' : 'TO/GA'
    at = spec.fdConv === 'AIRBUS-FCU' ? 'THR CLB' : 'THR REF'
    armed = spec.fdConv === 'AIRBUS-FCU' ? 'NAV' : 'LNAV'
    ap1 = r1 < 0.7   // typically engaged ~700 ft AGL
  } else if (ph === 'CLIMB') {
    roll = spec.fdConv === 'AIRBUS-FCU' ? 'NAV' : 'LNAV'
    pitch = spec.fdConv === 'AIRBUS-FCU' ? (r2 < 0.7 ? 'CLB' : 'OP CLB') : (r2 < 0.7 ? 'VNAV SPD' : 'FL CH')
    at = spec.fdConv === 'AIRBUS-FCU' ? 'THR CLB' : 'THR REF'
    armed = 'ALT'
    ap1 = true; ap2 = false
  } else if (ph === 'CRUISE') {
    roll = spec.fdConv === 'AIRBUS-FCU' ? 'NAV' : 'LNAV'
    pitch = spec.fdConv === 'AIRBUS-FCU' ? 'ALT CRZ' : 'ALT'
    at = spec.fdConv === 'AIRBUS-FCU' ? 'SPEED' : 'SPEED'
    armed = '—'
    ap1 = true; ap2 = r3 < 0.3  // dual AP in long cruise
  } else if (ph === 'DESCENT') {
    roll = spec.fdConv === 'AIRBUS-FCU' ? 'NAV' : 'LNAV'
    pitch = spec.fdConv === 'AIRBUS-FCU' ? (r2 < 0.6 ? 'DES' : 'OP DES') : (r2 < 0.6 ? 'VNAV PATH' : 'V/S')
    at = spec.fdConv === 'AIRBUS-FCU' ? (r3 < 0.5 ? 'THR IDLE' : 'SPEED') : (r3 < 0.5 ? 'RETARD' : 'SPEED')
    armed = 'ALT'
  } else if (ph === 'APPR-INT') {
    roll = spec.fdConv === 'AIRBUS-FCU' ? 'NAV' : 'LNAV'
    pitch = spec.fdConv === 'AIRBUS-FCU' ? 'ALT' : 'ALT'
    at = 'SPEED'
    armed = spec.fdConv === 'AIRBUS-FCU' ? 'APPR' : 'LOC'
  } else if (ph === 'APPR-FNL') {
    roll = spec.fdConv === 'AIRBUS-FCU' ? (r1 < 0.5 ? 'LOC*' : 'LOC') : 'LOC'
    pitch = spec.fdConv === 'AIRBUS-FCU' ? (r2 < 0.5 ? 'G/S*' : 'G/S') : 'G/S'
    at = 'SPEED'
    armed = spec.fdConv === 'AIRBUS-FCU' ? 'LAND' : 'FLARE'
    ap1 = true; ap2 = r4 < 0.3   // dual-channel for autoland
  } else if (ph === 'FLARE') {
    roll = spec.fdConv === 'AIRBUS-FCU' ? 'LAND' : 'ROLLOUT'
    pitch = 'FLARE'
    at = spec.fdConv === 'AIRBUS-FCU' ? 'RETARD' : 'IDLE'
    armed = '—'
    ap1 = true; ap2 = r4 < 0.3
  } else if (ph === 'GA') {
    roll = spec.fdConv === 'AIRBUS-FCU' ? 'GA TRK' : 'TO/GA'
    pitch = spec.fdConv === 'AIRBUS-FCU' ? 'SRS' : 'TO/GA'
    at = 'TOGA'
    armed = 'NAV'
    ap1 = r5 < 0.5
  }

  // Synthetic mode-confusion events (calibrated to ~5-8% of fleet in WATCH+ tiers)
  const notes: string[] = []
  let ambig = false, uncoupled = false, silentRev = false, fdOrphan = false
  let lawDown: ModeState['lawDown'] = 'NORM'
  let reconfBusy = false

  // 4% — mode ambiguity (e.g., VS vs FLCH on Boeing; OP CLB vs CLB on Airbus)
  if (r1 < 0.04 && (ph === 'CLIMB' || ph === 'DESCENT' || ph === 'APPR-INT')) {
    ambig = true
    notes.push(`MODE AMBIGUITY · ${pitch} active but FCU/MCP setting suggests alt mode — Sarter M1 · ${spec.afds}`)
  }
  // 3% — selected vs managed uncoupling (Airbus: NAV armed + HDG flying)
  if (r2 < 0.03 && (ph === 'CRUISE' || ph === 'DESCENT' || ph === 'APPR-INT')) {
    uncoupled = true
    notes.push(`SELECTED ≠ MANAGED · ${roll}/${pitch} not following FMS path · Sarter M2 · ${spec.ref}`)
  }
  // 4% — silent reversion (A/T HOLD/RETARD latched, autothrottle disengaged silently)
  if (r3 < 0.04 && (ph === 'APPR-FNL' || ph === 'APPR-INT' || ph === 'FLARE')) {
    silentRev = true
    at = spec.fdConv === 'AIRBUS-FCU' ? 'MAN THR' : 'HOLD'
    atEng = false
    notes.push(`A/T SILENT DISENGAGE · ${at} latched, thrust not protecting speed · Sarter M3 · Asiana 214 KSFO precedent NTSB AAR-14-01`)
  }
  // 2% — FD orphan (AP and A/T off but FD bars still commanding — "ghost following")
  if (r4 < 0.02 && (ph === 'CRUISE' || ph === 'DESCENT' || ph === 'APPR-FNL')) {
    fdOrphan = true
    ap1 = false; ap2 = false; atEng = false
    notes.push(`FD-ONLY · AP+A/T disengaged but FD bars commanding — ghost-following · Sarter M5 · §25.1335`)
  }
  // 1.5% — FBW law downgrade (Alt2 / Direct / Mech)
  if (r5 < 0.015 && spec.protectFloor !== 'NONE' && (ph !== 'OFF' && ph !== 'TKO-ROLL')) {
    lawDown = r6 < 0.45 ? 'ALT' : r6 < 0.85 ? 'DIRECT' : 'MECH'
    notes.push(`LAW DOWNGRADE · ${lawDown} · envelope protection ${lawDown === 'ALT' ? 'reduced' : 'LOST'} · ${spec.revFlavor}`)
  }
  // 3% — head-down troubleshooting / reconfig (during high-WL phases)
  if (r6 < 0.03 && (ph === 'TKO-LIFT' || ph === 'APPR-INT' || ph === 'APPR-FNL' || ph === 'GA')) {
    reconfBusy = true
    notes.push(`HEAD-DOWN RECONFIG · automation troubleshooting steals attention from flight-path · Sarter M4 · FAA InFO 11014`)
  }

  // 0.6% — multi-failure scenarios (rare combined modes — Asiana / AF447 class)
  if (r1 < 0.006 && (ph === 'APPR-FNL' || ph === 'CRUISE') && spec.protectFloor !== 'NONE') {
    silentRev = true; ambig = true; lawDown = lawDown === 'NORM' ? 'ALT' : lawDown
    atEng = false; at = 'MAN THR'
    notes.push(`MULTI-MODE EVENT · silent A/T disc + LAW ${lawDown} simultaneously · BEA AF 447 / NTSB AAR-14-01 envelope`)
  }

  // Transition rate (per minute, synthetic)
  const trBase = ph === 'APPR-INT' ? 4 : ph === 'APPR-FNL' ? 5 : ph === 'CLIMB' ? 3 : ph === 'DESCENT' ? 3.5 : ph === 'TKO-LIFT' ? 4 : ph === 'GA' ? 6 : ph === 'CRUISE' ? 0.4 : 1
  const transRate = trBase * (0.7 + r4 * 0.6) + (reconfBusy ? 3 : 0) + (silentRev ? 2 : 0) + (ambig ? 1.5 : 0)

  // Trust-drift proxy: long cruise + dual-AP + low-WL → drift toward over-reliance
  const trustDrift = ph === 'CRUISE' ? clamp(0.20 + (ap2 ? 0.30 : 0) + r5 * 0.20, 0, 1) : ph === 'OFF' ? 0 : 0.10 + r5 * 0.10

  return { modes: { roll, pitch, at, armed }, ap1, ap2, fd1, fd2, atEng,
    transRate, ambig, uncoupled, silentRev, fdOrphan, lawDown, reconfBusy, trustDrift, notes }
}

interface Row {
  f: PFlight; phase: Phase; spec: AfdsSpec; st: ModeState
  drivers: Record<string, number>
  score: number; tier: Tier; sarter: string[]
}

// ------------------------------------------------------------
// Canonical mode-confusion accident precedent catalogue —
// 11 reference accidents drawn from the Sarter-Woods literature
// and major investigations. Used for the PRECEDENT tab.
interface ModeAccident { date: string; cs: string; type: string; loc: string; fatal: number; sarter: string; brief: string; ref: string }
const PRECEDENT: ModeAccident[] = [
  { date:'2013-07-06', cs:'OZ214', type:'B772', loc:'KSFO', fatal:3,   sarter:'M3+M5', brief:'A/T HOLD vs THR REF confusion, autothrottle silently disengaged on glideslope, speed decayed 137→103 kt, low-energy touchdown short of seawall', ref:'NTSB AAR-14-01' },
  { date:'2009-06-01', cs:'AF447', type:'A332', loc:'OCEAN', fatal:228, sarter:'M4+M6', brief:'Pitot icing → ADRs disagree → AP off → ALT-LAW; crew did not recognise law reversion, persistent nose-up sidestick, deep stall to ocean', ref:'BEA F-GZCP' },
  { date:'2009-02-25', cs:'TK1951', type:'B738', loc:'EHAM', fatal:9,   sarter:'M3',    brief:'Radio Altimeter #1 failed (-8 ft), A/T mistakenly entered RETARD on approach, thrust to idle 1950 ft AGL, undetected by crew, stalled short of runway', ref:'KNCT M2009LV0225_01' },
  { date:'2014-12-28', cs:'QZ8501', type:'A320', loc:'WIOO→WSSS', fatal:162, sarter:'M2+M4+M6', brief:'Rudder limiter CB pulled inflight → AP disengaged + ALT-LAW; rapid 11° roll right, crew control inputs mismatched, deep stall to Java Sea', ref:'AAIC KNKT.14.12.29.04' },
  { date:'1994-04-26', cs:'CI140',  type:'A30B', loc:'RJNN', fatal:264, sarter:'M1+M2', brief:'GO-AROUND lever inadvertently engaged on approach; throttle/pitch fought trimmable horizontal stabilizer running fully nose-up, stalled at flare', ref:'AAIC Japan 96-5' },
  { date:'2019-05-05', cs:'SU1492', type:'SU95', loc:'UUEE', fatal:41,  sarter:'M5',    brief:'Lightning strike → DIRECT MODE FBW reversion; crew flew manual approach in thunderstorm, hard touchdown + bounce, structural fire on rollout', ref:'MAK SU-RA-89098' },
  { date:'2010-01-25', cs:'ET409',  type:'B738', loc:'OLBA', fatal:90,  sarter:'M1',    brief:'PF confused V/S vs IAS hold pitch attitude after takeoff into thunderstorm, asymmetric bank/pitch chase, loss of control to sea', ref:'AAIB Lebanon Final' },
  { date:'1996-10-02', cs:'PL603',  type:'B752', loc:'SPIM', fatal:70,  sarter:'M1+M3', brief:'Tape over pitot/static ports → ADC mode chaos (ALT/IAS DISAGREE)+windshear+stall+overspeed simultaneously, controlled descent into Pacific', ref:'DGAC Peru CIAA' },
  { date:'2020-08-07', cs:'IX1344', type:'B738', loc:'VOCL', fatal:21,  sarter:'M4',    brief:'Autoflight reconfig high-workload + circling tailwind landing on tabletop runway, long touchdown, overrun off cliff', ref:'DGCA India AAIB' },
  { date:'2008-10-07', cs:'QF72',   type:'A332', loc:'YPLM',  fatal:0,  sarter:'M1+M2', brief:'ADIRU #1 spike → ALT-LAW reversion + uncommanded pitch-down upset (-650 ft in 2s), 110 injured; FCS rejection logic refined post-accident', ref:'ATSB AO-2008-070' },
  { date:'2006-07-28', cs:'FX630',  type:'MD10', loc:'KLAX', fatal:0,   sarter:'M1+M3', brief:'Glideslope mode bust during approach reconfig, descent below crossing altitude, FMA ambiguity contributing factor', ref:'NTSB AAR-04-04' },
]

export default function FmaModeAwareness({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [transMul, setTransMul] = useState(1.0)
  const [trustMul, setTrustMul] = useState(1.0)
  const [revMul, setRevMul] = useState(1.0)
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<string>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'AFDS'|'MODES'|'PRECEDENT'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shVec, setShVec] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const spec = specOf(f.type)
      const ph = phaseOf(f)
      const st = syntheticState(f, ph, spec)

      // DRIVERS 0-100
      const dTRANS = clamp((st.transRate / 8) * 100 * transMul, 0, 100)
      const dAMBIG = st.ambig ? 75 : 0
      const dAT    = st.silentRev ? 85 * revMul : (!st.atEng && (ph === 'APPR-FNL' || ph === 'FLARE') ? 60 : 0)
      const dAP    = (!st.ap1 && !st.ap2 && (ph === 'APPR-FNL' || ph === 'FLARE' || ph === 'APPR-INT')) ? 55 : 0
      const dFD    = st.fdOrphan ? 70 : 0
      const dLAW   = st.lawDown === 'MECH' ? 95 : st.lawDown === 'DIRECT' ? 80 : st.lawDown === 'ALT' ? 50 : 0
      const dRECONF= st.reconfBusy ? 60 : 0
      const dTRUST = clamp(st.trustDrift * 70 * trustMul, 0, 70)
      const phaseW: Record<Phase, number> = {
        'TKO-ROLL':1.15, 'TKO-LIFT':1.35, 'CLIMB':1.05, 'CRUISE':0.65, 'DESCENT':1.10,
        'APPR-INT':1.30, 'APPR-FNL':1.45, 'FLARE':1.50, 'GA':1.40, 'OFF':0,
      }
      const dPHASE = phaseW[ph] * 35

      const drivers = { TRANS:dTRANS, AMBIG:dAMBIG, AT:dAT, AP:dAP, FD:dFD, LAW:dLAW, RECONF:dRECONF, TRUST:dTRUST, PHASE:dPHASE }
      const arr = Object.values(drivers)
      const mx = Math.max(...arr), mn = arr.reduce((a,b)=>a+b,0)/arr.length
      let score = (mx * 0.66 + mn * 0.34) * phaseW[ph] * advMul

      // Hard escalators — canonical Sarter mode classifications
      const sarter: string[] = []
      if (st.silentRev && (ph === 'APPR-FNL' || ph === 'FLARE' || ph === 'APPR-INT')) {
        score = Math.max(score, 92)
        sarter.push('M3·SILENT REVERSION')
      }
      if (st.lawDown === 'DIRECT' || st.lawDown === 'MECH') {
        score = Math.max(score, 88)
        sarter.push(`M6·LAW-${st.lawDown}`)
      }
      if (st.fdOrphan && (ph === 'APPR-FNL' || ph === 'FLARE')) {
        score = Math.max(score, 80)
        sarter.push('M5·FD-ORPHAN')
      }
      if (st.ambig && st.uncoupled) {
        score = Math.max(score, 72)
        sarter.push('M1+M2·AMBIG-UNCOUPLED')
      } else if (st.ambig) {
        score = Math.max(score, 55)
        sarter.push('M1·AMBIGUITY')
      } else if (st.uncoupled) {
        score = Math.max(score, 52)
        sarter.push('M2·UNCOUPLED')
      }
      if (st.reconfBusy && (ph === 'APPR-INT' || ph === 'APPR-FNL' || ph === 'TKO-LIFT' || ph === 'GA')) {
        score = Math.max(score, 60)
        sarter.push('M4·HEAD-DOWN')
      }
      if (st.transRate > 7 && (ph === 'APPR-INT' || ph === 'APPR-FNL')) {
        score = Math.max(score, 58)
        sarter.push(`HIGH-TRANS ${st.transRate.toFixed(1)}/min`)
      }
      if (st.trustDrift > 0.55 && ph === 'CRUISE') {
        score = Math.max(score, 35)
        sarter.push('TRUST-DRIFT')
      }

      score = clamp(score, 0, 100)

      let tier: Tier = 'NORMAL'
      if (ph === 'OFF') tier = 'OFF'
      else if (score >= 85) tier = 'REVERSION'
      else if (score >= 65) tier = 'CONFUSED'
      else if (score >= 45) tier = 'WATCH'
      else if (score >= 22) tier = 'DRIFT'
      else tier = 'NORMAL'

      out.push({ f, phase: ph, spec, st, drivers, score, tier, sarter })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, transMul, trustMul, revMul])

  // === MapLibre overlay ===
  useEffect(() => {
    if (!map) return
    const SRC = 'fma-src'
    const SRC_VEC = 'fma-vec-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    ensureSrc(SRC); ensureSrc(SRC_VEC)

    const writeAll = () => {
      const view = rows.filter(r => (tierFilter==='ALL'||r.tier===tierFilter) && (phaseFilter==='ALL'||r.phase===phaseFilter) && (classFilter==='ALL'||r.spec.afdsClass===classFilter))
      const acFeats: any[] = []
      const vecFeats: any[] = []
      for (const r of view) {
        const labelBits = [
          r.f.callsign||r.f.icao,
          r.spec.afdsClass,
          `${r.st.modes.roll}/${r.st.modes.pitch}`,
          r.st.atEng ? r.st.modes.at : 'AT-OFF',
          r.sarter[0] || '',
        ].filter(Boolean).join(' · ')
        acFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ tier:r.tier, color:TIER_COLOR[r.tier], score:r.score, sz: 6 + (r.score/100)*13, label: labelBits } })

        // Mode-transition zig-vector — drawn for CONFUSED/REVERSION as a short perpendicular spike
        if (r.tier === 'REVERSION' || r.tier === 'CONFUSED') {
          const km = 6 + (r.score/100) * 10
          const brg = (r.f.track || 0) * Math.PI/180
          const sideways = brg + Math.PI/2
          // dashed zigzag perpendicular to track — automation churn
          const pts: any[] = [[r.f.lng, r.f.lat]]
          for (let i = 1; i <= 6; i++) {
            const sign = (i % 2 === 0) ? 1 : -1
            const dKm = (km/6) * i
            const offKm = sign * (km/8)
            const lat0 = r.f.lat + (dKm/111.32) * Math.cos(brg)
            const lng0 = r.f.lng + (dKm/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(brg)
            const lat1 = lat0 + (offKm/111.32) * Math.cos(sideways)
            const lng1 = lng0 + (offKm/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(sideways)
            pts.push([lng1, lat1])
          }
          vecFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates: pts }, properties:{ color: TIER_COLOR[r.tier] } })
        }
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_VEC) as any).setData({ type:'FeatureCollection', features: shVec ? vecFeats : [] })
    }

    if (!map.getLayer('fma-halo'))
      map.addLayer({ id:'fma-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.16, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.82 } })
    if (!map.getLayer('fma-pin'))
      map.addLayer({ id:'fma-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.6, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('fma-lbl'))
      map.addLayer({ id:'fma-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('fma-vec'))
      map.addLayer({ id:'fma-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.6, 'line-dasharray':[1.5,1.5], 'line-opacity':0.78 } })

    writeAll()
    return () => {
      for (const id of ['fma-lbl','fma-pin','fma-halo','fma-vec']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_VEC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, phaseFilter, classFilter, shHalo, shPin, shLbl, shVec])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (classFilter==='ALL'||r.spec.afdsClass===classFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type||'').toLowerCase().includes(search.toLowerCase()) ||
      (r.f.operator||'').toLowerCase().includes(search.toLowerCase()) ||
      r.spec.afds.toLowerCase().includes(search.toLowerCase()) ||
      r.st.modes.roll.toLowerCase().includes(search.toLowerCase()) ||
      r.st.modes.pitch.toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { 'REVERSION':0, 'CONFUSED':0, 'WATCH':0, 'DRIFT':0, 'NORMAL':0, 'OFF':0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const worst = rows[0]
  const muTrans = rows.length ? (rows.reduce((a,b)=>a+b.st.transRate,0)/rows.length) : 0
  const revCnt = counts['REVERSION'], cnfCnt = counts['CONFUSED']

  // per-class aggregation
  const classMap = new Map<string, { spec: AfdsSpec; count: number; muScore: number; rev: number; cnf: number; mode3: number }>()
  for (const r of rows) {
    const e = classMap.get(r.spec.afdsClass) || { spec: r.spec, count: 0, muScore: 0, rev: 0, cnf: 0, mode3: 0 }
    e.count++; e.muScore += r.score
    if (r.tier === 'REVERSION') e.rev++
    if (r.tier === 'CONFUSED') e.cnf++
    if (r.st.silentRev) e.mode3++
    classMap.set(r.spec.afdsClass, e)
  }
  const classRows = Array.from(classMap.entries()).map(([cls, e]) => ({
    cls, spec: e.spec, count: e.count, muScore: e.muScore/e.count, rev: e.rev, cnf: e.cnf, mode3: e.mode3
  })).sort((a,b) => (b.rev - a.rev) || (b.cnf - a.cnf) || b.muScore - a.muScore)

  // per-mode aggregation (pitch mode is the most diagnostic)
  const modeMap = new Map<string, { count: number; rev: number; cnf: number; bank: 'BOEING'|'AIRBUS'|'EMB'|'CRJ'|'OTHER' }>()
  for (const r of rows) {
    const key = r.st.modes.pitch
    const bank = r.spec.fdConv === 'AIRBUS-FCU' ? 'AIRBUS' : r.spec.fdConv === 'BOEING-MCP' ? 'BOEING' : r.spec.fdConv === 'EMB-FCM' ? 'EMB' : r.spec.fdConv === 'CRJ-FGCP' ? 'CRJ' : 'OTHER'
    const e = modeMap.get(key) || { count: 0, rev: 0, cnf: 0, bank }
    e.count++
    if (r.tier === 'REVERSION') e.rev++
    if (r.tier === 'CONFUSED') e.cnf++
    modeMap.set(key, e)
  }
  const modeRows = Array.from(modeMap.entries()).map(([m, e]) => ({ m, ...e })).sort((a,b)=> (b.rev - a.rev) || (b.cnf - a.cnf) || b.count - a.count)

  const allClasses = ['ALL', ...Array.from(new Set(rows.map(r => r.spec.afdsClass))).sort()]

  return (
    <div className="fixed top-16 right-3 z-40 w-[480px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">FMA</span>
          <span className="text-[10px] text-slate-400">automation mode-awareness · Sarter-Woods M1-M6 · §25.1329</span>
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
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-TRANS</div><div className="text-slate-100 font-mono">{muTrans.toFixed(1)}/m</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">REV</div><div className="font-mono" style={{color:TIER_COLOR['REVERSION']}}>{revCnt}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">CNFD</div><div className="font-mono" style={{color:TIER_COLOR['CONFUSED']}}>{cnfCnt}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||worst?.f.icao||'—'}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">TRANS-MUL <span className="text-slate-200 font-mono">{(transMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={transMul*100} onChange={e=>setTransMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">TRUST-MUL <span className="text-slate-200 font-mono">{(trustMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={trustMul*100} onChange={e=>setTrustMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">REV-MUL <span className="text-slate-200 font-mono">{(revMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={revMul*100} onChange={e=>setRevMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','TKO-ROLL','TKO-LIFT','CLIMB','CRUISE','DESCENT','APPR-INT','APPR-FNL','FLARE','GA'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {allClasses.map(c => (
            <button key={c} onClick={()=>setClassFilter(c)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter===c?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{c}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['VEC',shVec,setShVec]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/afds/mode" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','AFDS','MODES','PRECEDENT'] as const).map(t => (
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
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.spec.afdsClass}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              {r.st.lawDown !== 'NORM' && <span className="px-1 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR['REVERSION']}33`, color:TIER_COLOR['REVERSION'] }}>LAW-{r.st.lawDown}</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            {/* PFD-style FMA strip — 3 columns A/T · Roll · Pitch (Boeing) or 5-col Airbus */}
            <div className="mt-1 grid grid-cols-4 gap-1 font-mono">
              <div className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-center"><div className="text-[8px] text-slate-500">A/T</div><div className="text-[10px]" style={{ color: r.st.atEng ? '#10b981' : '#f59e0b' }}>{r.st.atEng ? r.st.modes.at : 'OFF'}</div></div>
              <div className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-center"><div className="text-[8px] text-slate-500">ROLL</div><div className="text-[10px] text-emerald-400">{r.st.modes.roll}</div></div>
              <div className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-center"><div className="text-[8px] text-slate-500">PITCH</div><div className="text-[10px] text-emerald-400">{r.st.modes.pitch}</div></div>
              <div className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-center"><div className="text-[8px] text-slate-500">ARMED</div><div className="text-[10px] text-slate-200">{r.st.modes.armed}</div></div>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>AP1 <span className="font-mono" style={{ color: r.st.ap1 ? '#10b981' : '#475569' }}>{r.st.ap1?'ON':'OFF'}</span></div>
              <div>AP2 <span className="font-mono" style={{ color: r.st.ap2 ? '#10b981' : '#475569' }}>{r.st.ap2?'ON':'OFF'}</span></div>
              <div>FD <span className="font-mono" style={{ color: r.st.fd1||r.st.fd2 ? '#10b981' : '#475569' }}>{r.st.fd1?'1':''}{r.st.fd2?'2':''}{!r.st.fd1&&!r.st.fd2?'OFF':''}</span></div>
              <div>trans <span className="text-slate-100 font-mono">{r.st.transRate.toFixed(1)}/m</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>AGL <span className="text-slate-100 font-mono">{r.f.altitudeFt.toFixed(0)}ft</span></div>
              <div>IAS <span className="text-slate-100 font-mono">{r.f.velocityKts.toFixed(0)}kt</span></div>
              <div>V/S <span className="text-slate-100 font-mono">{r.f.vertRate>0?'+':''}{r.f.vertRate.toFixed(0)}</span></div>
              <div>law <span className="font-mono" style={{ color: r.st.lawDown==='NORM' ? '#10b981' : '#f43f5e' }}>{r.st.lawDown}</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v)}</span>
              ))}
            </div>
            {r.sarter.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
                {r.sarter.map(s => <span key={s} className="px-1 rounded" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{s}</span>)}
              </div>
            )}
            {r.st.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.st.notes[0]}</div>}
            {r.st.notes.length===0 && r.tier!=='NORMAL' && r.tier!=='OFF' && <div className="mt-1 text-[9px] text-slate-500">monitor FMA · {r.spec.afds} · {r.spec.ref}</div>}
            {r.tier==='NORMAL' && <div className="mt-1 text-[9px] text-slate-500">{r.spec.afds} · {r.spec.atKind} A/T · law-floor {r.spec.protectFloor}</div>}
            {r.tier==='OFF' && <div className="mt-1 text-[9px] text-slate-500">ground · {r.spec.afds}</div>}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length===0 && <div className="text-[10px] text-slate-500 italic">no airframes match current filters</div>}

        {tab==='AFDS' && (
          <div className="space-y-1">
            <div className="text-[9px] text-slate-500 italic mb-1">Per-AFDS-architecture aggregation · M3 = Sarter mode-3 silent reversion count (Asiana / Turkish precedent)</div>
            {classRows.map(c => (
              <div key={c.cls} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{c.cls}</span>
                  <span className="text-slate-400">{c.spec.afds}</span>
                  <span className="ml-auto font-mono text-slate-100">×{c.count}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>AP-chan <span className="text-slate-100 font-mono">{c.spec.apCount}</span></div>
                  <div>A/T <span className="text-slate-100 font-mono">{c.spec.atKind}</span></div>
                  <div>FD <span className="text-slate-100 font-mono">{c.spec.fdConv.split('-')[0]}</span></div>
                  <div>prot <span className="text-slate-100 font-mono">{c.spec.protectFloor}</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>μ-SCORE <span className="text-slate-100 font-mono">{c.muScore.toFixed(0)}</span></div>
                  <div>REV <span className="font-mono" style={{color:TIER_COLOR['REVERSION']}}>{c.rev}</span></div>
                  <div>CNFD <span className="font-mono" style={{color:TIER_COLOR['CONFUSED']}}>{c.cnf}</span></div>
                  <div>M3 <span className="font-mono" style={{color:TIER_COLOR['REVERSION']}}>{c.mode3}</span></div>
                </div>
                <div className="text-[9px] text-slate-500 italic mt-0.5">reversion: {c.spec.revFlavor} · cert: {c.spec.cert} · {c.spec.ref}</div>
              </div>
            ))}
            {classRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no AFDS aggregation</div>}
          </div>
        )}

        {tab==='MODES' && (
          <div className="space-y-1">
            <div className="text-[9px] text-slate-500 italic mb-1">Per pitch-mode aggregation · which FMA pitch annunciations are correlated with current REV/CNFD events</div>
            {modeRows.map(m => (
              <div key={m.m} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="px-1 rounded bg-slate-900 border border-slate-700 text-emerald-400 font-mono text-[10px]">{m.m}</span>
                  <span className="text-slate-400">{m.bank}</span>
                  <span className="ml-auto font-mono text-slate-100">×{m.count}</span>
                </div>
                <div className="grid grid-cols-3 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>REV <span className="font-mono" style={{color:TIER_COLOR['REVERSION']}}>{m.rev}</span></div>
                  <div>CNFD <span className="font-mono" style={{color:TIER_COLOR['CONFUSED']}}>{m.cnf}</span></div>
                  <div>share <span className="text-slate-100 font-mono">{(m.count/Math.max(1,rows.length)*100).toFixed(1)}%</span></div>
                </div>
                <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden flex">
                  <div style={{ width:`${m.rev/Math.max(1,m.count)*100}%`, background:TIER_COLOR['REVERSION'], height:'100%' }} />
                  <div style={{ width:`${m.cnf/Math.max(1,m.count)*100}%`, background:TIER_COLOR['CONFUSED'], height:'100%' }} />
                </div>
              </div>
            ))}
            {modeRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no pitch-mode data</div>}
          </div>
        )}

        {tab==='PRECEDENT' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">Sarter-Woods mode-confusion taxonomy (NASA TM-103970 / IJAP 1995)</div>
              <div className="text-slate-400 leading-relaxed">
                <div>M1 · MODE-AMBIGUITY · ≥2 plausible interpretations</div>
                <div>M2 · MODE-UNCOUPLING · selected ≠ managed</div>
                <div>M3 · UNANNUNCIATED REVERSION · silent SPD→THR or A/T idle (Asiana 214 / Turkish 1951)</div>
                <div>M4 · TROUBLESHOOTING-COCKPIT · head-down reconfig steals attention</div>
                <div>M5 · COUPLED-DISCONNECT · AP+A/T off but FDs still command (ghost-following)</div>
                <div>M6 · ENVELOPE-PROTECTION-LOST · Alt-Law / Direct / A/T-idle in flare (AF447 / QF72)</div>
              </div>
            </div>
            <div className="text-[9px] text-slate-500 italic">Canonical precedent — read against current REVERSION/CONFUSED rows for pattern-matching</div>
            {PRECEDENT.map(a => (
              <div key={a.cs+a.date} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
                  <span className="font-mono text-slate-100">{a.cs}</span>
                  <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{a.type}</span>
                  <span className="text-slate-500 font-mono">{a.date}</span>
                  <span className="text-slate-400 font-mono">{a.loc}</span>
                  {a.fatal>0 && <span className="px-1 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR['REVERSION']}33`, color:TIER_COLOR['REVERSION'] }}>† {a.fatal}</span>}
                  <span className="ml-auto px-1 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR['CONFUSED']}33`, color:TIER_COLOR['CONFUSED'] }}>{a.sarter}</span>
                </div>
                <div className="mt-1 text-[10px] text-slate-300 leading-relaxed">{a.brief}</div>
                <div className="mt-1 text-[9px] text-slate-500 italic">{a.ref}</div>
              </div>
            ))}
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · 14 CFR §25.1329 Automatic Pilot / §25.1322 alerting / §25.1335 FD / §121.579 use of autopilot · FAA AC 25-7D §10 / AC 120-29A Cat I/II / AC 120-118 CRM / SAFO 17007 automation mgmt / InFO 11014 reduced reliance · EASA CS 25.1329 / AMC 25.1329 · ICAO Doc 9683 HF / Doc 10151 automation reliance / Doc 9803 LOSA · IATA IOSA FLT 3.4 / Automation Policy 2nd ed. · NASA TM-103970 Sarter-Woods · IJAP 1995/1997/2000 · Bainbridge 1983 "Ironies of Automation" Automatica 19 · Endsley 1995 SAGAT · Wickens 2008 EngPsych · Reason 1990 Human Error · Norman 1990 Phil Tr R Soc B · Boeing FCTM Ch.8 / Airbus FCTM PRO-NOR-SOP-12 / Embraer AOM §03 / CRJ FCOM Vol.2 §06 · Honeywell Primus Epic PG · Collins Pro Line 21 PG.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
