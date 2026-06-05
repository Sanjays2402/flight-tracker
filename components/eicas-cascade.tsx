'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   EICAS-CASCADE · ECAM / EICAS Multi-Failure Master-Caution /
   Warning Alert-Cascade & Crew-Workload Stack Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of the cockpit ALERT-DISPLAY
   subsystem during multi-failure / cascade events, scoring
   whether the simultaneous W/C/A message count, cascade
   direction (CONVERGE / STATIC / DIVERGE / RUNAWAY), cumulative
   ECAM/QRH action-item workload vs crew cadence, priority-sort
   inversion, ECL nest depth, and latent-fault overlap put the
   crew over comprehension / response capacity per Boeing EICAS
   / Airbus ECAM FWC / Embraer EICAS-IV / Bombardier EICAS-CRJ
   alert-display architectures.

   Structurally distinct from FMA (automation-mode confusion,
   single subsystem · Asiana 214 / Turkish 1951), FBW-REVERSION
   (FBW law degradation · Normal/Alt-1/Alt-2/Direct/Mech),
   MCAS / STAB-TRIM (B737-MAX pitch-augmentation runaway),
   MEL / CDL (dispatch-time deferral pre-flight), EHM / OIL /
   VIB / EGT (single-engine parameter trending), PINCAP (human
   crew incapacitation), TUC (hypoxia / O₂ depletion), PIO
   (closed-loop pilot coupling).  EICAS-CASCADE is uniquely the
   MULTI-FAILURE ALERT-DISPLAY SATURATION evaluator.

   13 airframe alert-architecture families catalogued: B-EICAS-
   NG (B777/B787 + ECL), B-EICAS-CL (B757/B767/B744 classic),
   B-EICAS-MAX (B737 MAX upgraded EIS), B-EICAS-737CL (B737NG
   annunciator-light), A-ECAM-NG (A350/A380 next-gen smart-page
   parallel-proc), A-ECAM-FBW (A320/A330/A340 FWC LEVEL-1/2/3),
   A-ECAM-CL (A300/A310 CRT FCU), A-ECAM-ATR (ATR-42/72-600
   Thales Avionica), E-EICAS-E2 (Embraer E2 next-gen),
   E-EICAS-IV (Embraer E1 Honeywell Primus Epic), C-EICAS-CRJ
   (Bombardier CRJ Collins Pro-Line 4/21), C-EICAS-Q (DHC-8-
   Q400), O-OTHER (mixed/GA baseline).

   Seven driver scores [0..100] aggregated per flight:
     MSG-COUNT  simultaneous active W+C+A vs per-family satN.
     CASCADE    net new-alert rate per minute; CONVERGE / STATIC
                / DIVERGE / RUNAWAY direction modulates score.
     PRIO-INV   fraction Level-3 (red MW) masked by Level-2 spam
                per SAE ARP-5588 alert-categorisation standard.
     ACK-LAG    max seconds top-priority alert unacknowledged
                (Sarter-Woods IJAP 1995 cognitive engagement).
     WKLD-RATE  cumulative ECAM/QRH actions/min vs crew cadence
                (FAA AC 25.1322-1 §6.2.4 task-allocation).
     ECL-DEPTH  electronic-checklist nesting depth.
     LATENT     latent + active fault overlap (Helios 522 mode).

   Six tiers (ICAO Doc 9859 SMM ed.4 risk-tolerability matrix
   mapped to alert-comprehension capacity):
     BAN ≥85  SATURATION   workload-saturation, declare ATC hold
     CRIT≥65  CASCADE      alert rate > crew cadence
     MARGIN≥45 HEAVY-LOAD  multiple parallel ECAM actions
     WATCH≥25 SINGLE-FAULT single ECAM/QRH actioned per flow
     CLEAR≥10 MINOR        advisory only
     OFF <10  ROUTINE      no active alerts

   Aggregate = max(0.65·worst, 0.35·mean) + 0.35·mean × phase
   multiplier (CASCADE-PH 1.25 / TKO|LDG 1.15 / APP 1.10 /
   CLB 0.90 / DST 0.92 / CRZ 0.85 / GND 0.55).  Hard escalators:
   ≥5 red MW → floor 88, RUNAWAY direction → floor 80.

   Accident precedents seeded into scenario library:
     · QF32  (A380 VH-OQA, 2010-11-04, ATSB AO-2010-089) — Trent
       900 #2 IPC stage-2 disk uncontained burst, 54 ECAM
       messages, 22 systems compromised, 80 min ECAM action.
     · UA232 (DC-10 N1819U, 1989-07-19, NTSB AAR-90-06) — CF6-6
       #2 fan-disk failure severed all three hydraulics; LOC.
     · AF447 (A330 F-GZCP, 2009-06-01, BEA F-CP090601) — pitot
       icing UAS cascade, FBW Alt-2 reversion, inconsistent
       stall warns; crew never consolidated mental model.
     · Helios 522 (737-300 5B-DBY, 2005-08-14, AAIASB 11/2006) —
       latent pre-departure mode-switch, cabin-alt horn ≡ TO-
       config horn, crew hypoxia.  Canonical LATENT reference.
     · Asiana 214 (777 HL7742, 2013-07-06, NTSB AAR-14-01) —
       A/T-mode masking low-speed in FLCH-SPD-HOLD reversion.
     · Spanair 5022 (MD-82 EC-HFP, 2008-08-20, CIAIAC A-032/
       2008) — TOWS silent C/B failure pre-rotation.
     · BMA 092 Kegworth (737-400 G-OBME, 1989-01-08, AAIB 4/90)
       — fan-blade-out, crew mis-read new EIS engine display,
       shut down the OTHER (good) engine.

   References: 14 CFR §25.1322 · EASA CS-25.1322 · FAA AC
   25.1322-1 (2010-12-13) · AC 25-11B · EASA AMC 25.1322 (ED
   2013/010/R) · SAE ARP-4754A · ARP-4761/A · ARP-5588 ·
   AIR-6055 · ICAO Annex 6 Pt I §6.10 · Doc 9760 Vol II Pt VI ·
   Doc 9859 SMM ed.4 · Doc 9683 HF · Boeing D6-83563 EICAS
   (777) · FCOM Vol 2 §02 · 787 OM §0.05 · Airbus FCOM DSC-31
   ECAM · PRO-ABN-MISC · Embraer EICAS-IV POM §0.04 · CRJ FCOM
   Vol 2 §02 · ATR FCOM §2.07 · RTCA DO-178C / DO-254 / DO-275 ·
   Sarter-Woods IJAP 1995 / HF 1997 · Wickens HF 2008 · FSF ALAR
   BN 7.1 · IATA STEADES 2024 §11 · EUROCONTROL EVAIR Bull 28 §4
   · NTSB AAR-90-06 / AAR-14-01 / AIR-08-01 · ATSB AO-2010-089 ·
   BEA F-CP090601 · AAIB 4/90 · AAIASB 11/2006 · CIAIAC A-032/
   2008.
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}

interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Family =
  | 'B-EICAS-NG'    // B777/B787 EICAS + ECL
  | 'B-EICAS-CL'    // B757/B767/B747-400 classic EICAS
  | 'B-EICAS-MAX'   // B737 MAX upgraded EIS
  | 'B-EICAS-737CL' // B737NG annunciator-light EIS
  | 'A-ECAM-NG'     // A350/A380 next-gen ECAM
  | 'A-ECAM-FBW'    // A320/A330/A340 FBW ECAM
  | 'A-ECAM-CL'     // A300/A310 classic ECAM
  | 'A-ECAM-ATR'    // ATR 42-600 / 72-600
  | 'E-EICAS-E2'    // Embraer E2 next-gen
  | 'E-EICAS-IV'    // Embraer E1 Honeywell EICAS-IV
  | 'C-EICAS-CRJ'   // CRJ Collins Pro-Line
  | 'C-EICAS-Q'     // DHC-8-Q400
  | 'O-OTHER'

type Driver = 'MSG-COUNT' | 'CASCADE' | 'PRIO-INV' | 'ACK-LAG' | 'WKLD-RATE' | 'ECL-DEPTH' | 'LATENT'
type Tier = 'BAN' | 'CRIT' | 'MARGIN' | 'WATCH' | 'CLEAR' | 'OFF'
type Phase = 'GND' | 'TKO' | 'CLB' | 'CRZ' | 'DST' | 'APP' | 'LDG' | 'CASCADE-PH'
type CascadeDir = 'CONVERGE' | 'STATIC' | 'DIVERGE' | 'RUNAWAY'

const FAMILIES: Family[] = [
  'B-EICAS-NG','B-EICAS-CL','B-EICAS-MAX','B-EICAS-737CL',
  'A-ECAM-NG','A-ECAM-FBW','A-ECAM-CL','A-ECAM-ATR',
  'E-EICAS-E2','E-EICAS-IV',
  'C-EICAS-CRJ','C-EICAS-Q',
  'O-OTHER',
]
const DRIVERS: Driver[] = ['MSG-COUNT','CASCADE','PRIO-INV','ACK-LAG','WKLD-RATE','ECL-DEPTH','LATENT']
const TIERS: Tier[] = ['BAN','CRIT','MARGIN','WATCH','CLEAR','OFF']
const PHASES: Phase[] = ['GND','TKO','CLB','CRZ','DST','APP','LDG','CASCADE-PH']

const TIER_COLOR: Record<Tier, string> = {
  BAN: '#ef4444', CRIT: '#f43f5e', MARGIN: '#f59e0b',
  WATCH: '#0ea5e9', CLEAR: '#10b981', OFF: '#64748b',
}
const TIER_RANK: Record<Tier, number> = { BAN:0, CRIT:1, MARGIN:2, WATCH:3, CLEAR:4, OFF:5 }
function tierFromScore(s: number): Tier {
  if (s >= 85) return 'BAN'
  if (s >= 65) return 'CRIT'
  if (s >= 45) return 'MARGIN'
  if (s >= 25) return 'WATCH'
  if (s >= 10) return 'CLEAR'
  return 'OFF'
}

const TIER_LABEL: Record<Tier, string> = {
  BAN: 'SATURATION', CRIT: 'CASCADE', MARGIN: 'HEAVY-LOAD',
  WATCH: 'SINGLE-FAULT', CLEAR: 'MINOR', OFF: 'ROUTINE',
}

// Family colour swatches for fleet-mix bars + chip pills
const FAMILY_COLOR: Record<Family, string> = {
  'B-EICAS-NG':    '#3b82f6',
  'B-EICAS-CL':    '#60a5fa',
  'B-EICAS-MAX':   '#2563eb',
  'B-EICAS-737CL': '#1d4ed8',
  'A-ECAM-NG':     '#22d3ee',
  'A-ECAM-FBW':    '#06b6d4',
  'A-ECAM-CL':     '#0891b2',
  'A-ECAM-ATR':    '#14b8a6',
  'E-EICAS-E2':    '#a78bfa',
  'E-EICAS-IV':    '#8b5cf6',
  'C-EICAS-CRJ':   '#ec4899',
  'C-EICAS-Q':     '#f472b6',
  'O-OTHER':       '#64748b',
}

const FAMILY_DESC: Record<Family, string> = {
  'B-EICAS-NG':    'B777/B787 EICAS + Electronic Checklist · ECL coupling',
  'B-EICAS-CL':    'B757/B767/B744 classic EICAS · primary+secondary engine',
  'B-EICAS-MAX':   'B737 MAX upgraded EIS · screen-based',
  'B-EICAS-737CL': 'B737NG annunciator-light EIS · individual lamps',
  'A-ECAM-NG':     'A350/A380 next-gen ECAM · smart pages + parallel proc',
  'A-ECAM-FBW':    'A320/A330/A340 FBW ECAM · FWC LEVEL-1/2/3',
  'A-ECAM-CL':     'A300/A310 classic ECAM · CRT FCU/FWC era',
  'A-ECAM-ATR':    'ATR 42/72-600 ECAM · Thales Avionica',
  'E-EICAS-E2':    'Embraer E2 EICAS · enhanced fault-handling',
  'E-EICAS-IV':    'Embraer E1 EICAS-IV · Honeywell Primus Epic',
  'C-EICAS-CRJ':   'Bombardier CRJ EICAS · Collins Pro-Line 4/21',
  'C-EICAS-Q':     'DHC-8-Q400 simplified EICAS',
  'O-OTHER':       'Mixed / GA / older minimal alert subsystem',
}

// Per-family caps used by scoring: saturation count, ECL philosophy weight,
// inhibits-on-takeoff coverage, latent-mask susceptibility (Helios index).
interface FamSpec {
  // Soft saturation threshold for simultaneous active alerts
  satN: number
  // Crew expected response cadence (items per minute baseline)
  cadence: number
  // ECL nesting depth tolerance before triggering depth escalator
  eclMax: number
  // Latent susceptibility (Helios mode) — higher = older/lesser inhibit logic
  latentSusc: number
  // Priority-inversion baseline susceptibility per arbiter generation
  prioBaseline: number
}
const FAM_SPEC: Record<Family, FamSpec> = {
  'B-EICAS-NG':    { satN: 10, cadence: 7.5, eclMax: 4, latentSusc: 0.10, prioBaseline: 0.05 },
  'B-EICAS-CL':    { satN: 8,  cadence: 6.0, eclMax: 3, latentSusc: 0.18, prioBaseline: 0.10 },
  'B-EICAS-MAX':   { satN: 9,  cadence: 6.8, eclMax: 4, latentSusc: 0.15, prioBaseline: 0.10 },
  'B-EICAS-737CL': { satN: 6,  cadence: 5.0, eclMax: 1, latentSusc: 0.32, prioBaseline: 0.22 },
  'A-ECAM-NG':     { satN: 12, cadence: 8.0, eclMax: 5, latentSusc: 0.08, prioBaseline: 0.04 },
  'A-ECAM-FBW':    { satN: 10, cadence: 7.0, eclMax: 4, latentSusc: 0.12, prioBaseline: 0.08 },
  'A-ECAM-CL':     { satN: 7,  cadence: 5.5, eclMax: 2, latentSusc: 0.22, prioBaseline: 0.16 },
  'A-ECAM-ATR':    { satN: 7,  cadence: 5.5, eclMax: 3, latentSusc: 0.18, prioBaseline: 0.12 },
  'E-EICAS-E2':    { satN: 10, cadence: 7.0, eclMax: 4, latentSusc: 0.10, prioBaseline: 0.06 },
  'E-EICAS-IV':    { satN: 8,  cadence: 6.0, eclMax: 3, latentSusc: 0.15, prioBaseline: 0.10 },
  'C-EICAS-CRJ':   { satN: 7,  cadence: 5.5, eclMax: 2, latentSusc: 0.18, prioBaseline: 0.14 },
  'C-EICAS-Q':     { satN: 6,  cadence: 5.0, eclMax: 2, latentSusc: 0.22, prioBaseline: 0.18 },
  'O-OTHER':       { satN: 5,  cadence: 4.5, eclMax: 1, latentSusc: 0.28, prioBaseline: 0.22 },
}

const DRIVER_WEIGHT: Record<Driver, number> = {
  'MSG-COUNT': 0.22, 'CASCADE': 0.20, 'PRIO-INV': 0.13,
  'ACK-LAG': 0.10, 'WKLD-RATE': 0.18, 'ECL-DEPTH': 0.07, 'LATENT': 0.10,
}

const DRIVER_DESC: Record<Driver, string> = {
  'MSG-COUNT':  'Simultaneous active alert messages (W+C+A) vs saturation N.',
  'CASCADE':    'Net new-alert rate per minute (− = converging, + = diverging).',
  'PRIO-INV':   'Fraction Level-3 (red MW) masked by Level-2 spam (SAE ARP-5588).',
  'ACK-LAG':    'Max seconds the top-priority alert has been unacknowledged.',
  'WKLD-RATE':  'Cumulative ECAM/QRH action items per minute vs crew cadence.',
  'ECL-DEPTH':  'Electronic-checklist nesting depth (each nest adds load).',
  'LATENT':     'Latent-vs-active alert co-existence (Helios 522 mode).',
}

const PHASE_DESC: Record<Phase, string> = {
  'GND':         'Ground · alerts mostly inhibited per §25.1322(d)',
  'TKO':         'Takeoff roll / initial climb · high baseline workload',
  'CLB':         'Climb',
  'CRZ':         'Cruise · slack capacity available',
  'DST':         'Descent',
  'APP':         'Approach · high baseline workload',
  'LDG':         'Landing flare / rollout',
  'CASCADE-PH':  'Active multi-failure cascade in progress',
}

const PHASE_MUL: Record<Phase, number> = {
  'GND': 0.55, 'TKO': 1.15, 'CLB': 0.90, 'CRZ': 0.85, 'DST': 0.92, 'APP': 1.10, 'LDG': 1.15, 'CASCADE-PH': 1.25,
}

// ------ Hash helpers (deterministic synthesis) ------
function h32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967295
}
function h32b(s: string, salt: string): number { return h32(s + salt) }

function pickFamily(f: SFlight): Family {
  const t = (f.type || '').toUpperCase()
  // Boeing
  if (/^(B77|B78)/.test(t)) return 'B-EICAS-NG'
  if (/^(B75|B76|B74)/.test(t)) return 'B-EICAS-CL'
  if (/^B3[89]M/.test(t) || /^B38M|B39M/.test(t)) return 'B-EICAS-MAX'
  if (/^(B73)/.test(t)) return 'B-EICAS-737CL'
  // Airbus
  if (/^(A35|A38)/.test(t)) return 'A-ECAM-NG'
  if (/^(A31[89]|A32|A33|A34|A20N|A21N|A22|A220)/.test(t)) return 'A-ECAM-FBW'
  if (/^(A30|A31[06])/.test(t)) return 'A-ECAM-CL'
  if (/^AT[47]/.test(t)) return 'A-ECAM-ATR'
  // Embraer
  if (/^(E29|E19[05])/.test(t)) return 'E-EICAS-E2'
  if (/^(E17|E19|E170|E190|E50|E55)/.test(t)) return 'E-EICAS-IV'
  // Bombardier
  if (/^(CRJ|CL6)/.test(t)) return 'C-EICAS-CRJ'
  if (/^(DH8|Q40|DHC8)/.test(t)) return 'C-EICAS-Q'
  // Category fallback
  const c = (f.category || 'A3').toUpperCase()
  if (c === 'A5') return 'B-EICAS-NG'
  if (c === 'A4') return 'A-ECAM-FBW'
  if (c === 'A3') {
    const h = h32(f.icao + 'fam')
    return h < 0.35 ? 'A-ECAM-FBW' : h < 0.70 ? 'B-EICAS-737CL' : 'E-EICAS-IV'
  }
  if (c === 'A2') return 'A-ECAM-ATR'
  return 'O-OTHER'
}

// Phase classifier — derive from altitude / vert rate / ground / vel.
// Includes a synthetic "CASCADE-PH" phase trigger when this airframe is in
// a deterministic-by-hash active cascade scenario.
function classifyPhaseBase(f: SFlight): Phase {
  if (f.ground) return 'GND'
  const fl = f.altitudeFt / 100
  if (fl < 15) return f.vertRate > 500 ? 'TKO' : f.vertRate < -200 ? 'LDG' : 'TKO'
  if (fl < 100 && f.vertRate > 400) return 'CLB'
  if (fl < 150 && f.vertRate < -500) return 'APP'
  if (f.vertRate > 300) return 'CLB'
  if (f.vertRate < -300) return 'DST'
  return 'CRZ'
}

// Synthetic state of the alert subsystem for this airframe — sampled
// deterministically by ICAO hash.  Most airframes are in routine state;
// a small fraction are in active cascade scenarios drawn from the
// precedent library.
interface AlertState {
  msgCount: number              // simultaneous active messages (W+C+A)
  warnings: number              // red Master Warnings (Level-3)
  cautions: number              // amber Master Cautions (Level-2)
  advisories: number            // Level-1
  cascadeRate: number           // net new msgs/min
  cascadeDir: CascadeDir
  prioInvFrac: number           // 0..1 priority-inversion fraction
  ackLagSec: number             // max unack seconds top-prio
  wkldItemsPerMin: number       // ECAM/QRH actions per minute
  eclDepth: number              // ECL nest depth
  latent: boolean               // latent fault co-existing
  scenario: ScenarioId          // origin tag for precedent reference
}

type ScenarioId =
  | 'ROUTINE'
  | 'SINGLE-CAUT'
  | 'SINGLE-WARN'
  | 'MULTI-PARALLEL'
  | 'UER-LIKE-QF32'
  | 'HYD-LIKE-UA232'
  | 'UAS-LIKE-AF447'
  | 'LATENT-LIKE-HELIOS'
  | 'MODE-LIKE-OZ214'
  | 'TOWS-LIKE-5022'
  | 'EIS-LIKE-KEGWORTH'

const SCENARIO_PRECEDENT: Record<ScenarioId, string> = {
  'ROUTINE':              '—',
  'SINGLE-CAUT':          'single Level-2 caution',
  'SINGLE-WARN':          'single Level-3 warning',
  'MULTI-PARALLEL':       'parallel non-related caut+adv stack',
  'UER-LIKE-QF32':        'UER cascade · QF32 A380 VH-OQA precedent (ATSB AO-2010-089, 54 ECAM msgs)',
  'HYD-LIKE-UA232':       'Hydraulic cascade · UA232 DC-10 N1819U precedent (NTSB AAR-90-06)',
  'UAS-LIKE-AF447':       'Unreliable-airspeed cascade · AF447 A330 F-GZCP precedent (BEA F-CP090601)',
  'LATENT-LIKE-HELIOS':   'Latent + active overlap · Helios 522 B737 5B-DBY precedent (AAIASB 11/2006)',
  'MODE-LIKE-OZ214':      'A/T-mode masking · Asiana 214 B777 HL7742 precedent (NTSB AAR-14-01)',
  'TOWS-LIKE-5022':       'TOWS latent C/B failure · Spanair 5022 MD-82 EC-HFP precedent (CIAIAC A-032/2008)',
  'EIS-LIKE-KEGWORTH':    'EIS mis-localisation · British Midland 092 G-OBME precedent (AAIB 4/90)',
}

function synthState(f: SFlight, fam: Family, basePhase: Phase): { state: AlertState; phase: Phase } {
  const spec = FAM_SPEC[fam]
  const r = h32(f.icao + 'eicas')
  const r2 = h32b(f.icao + fam, 'b')
  const r3 = h32b(f.icao + fam, 'c')
  const r4 = h32b(f.icao + fam, 'd')

  // Scenario sampling (deterministic): cascade scenarios are rare events.
  // routine ~70% / single-caut 13% / single-warn 6% / multi-parallel 5% /
  // cascade scenarios ~6% combined.
  let scenario: ScenarioId = 'ROUTINE'
  if (basePhase === 'GND') {
    // On the ground we generally see only TOWS / latent / startup events
    if (r < 0.94) scenario = 'ROUTINE'
    else if (r < 0.97) scenario = 'TOWS-LIKE-5022'
    else if (r < 0.985) scenario = 'LATENT-LIKE-HELIOS'
    else scenario = 'SINGLE-CAUT'
  } else {
    if (r < 0.70) scenario = 'ROUTINE'
    else if (r < 0.83) scenario = 'SINGLE-CAUT'
    else if (r < 0.89) scenario = 'SINGLE-WARN'
    else if (r < 0.94) scenario = 'MULTI-PARALLEL'
    else if (r < 0.962) scenario = 'UER-LIKE-QF32'
    else if (r < 0.975) scenario = 'HYD-LIKE-UA232'
    else if (r < 0.985) scenario = 'UAS-LIKE-AF447'
    else if (r < 0.992) scenario = 'MODE-LIKE-OZ214'
    else if (r < 0.997) scenario = 'EIS-LIKE-KEGWORTH'
    else scenario = 'LATENT-LIKE-HELIOS'
  }

  // Synthesise state per scenario
  let warnings = 0, cautions = 0, advisories = 0, cascadeRate = 0
  let prioInvFrac = spec.prioBaseline, ackLagSec = 0, wkldItemsPerMin = 0, eclDepth = 0
  let latent = false
  let cascadeDir: CascadeDir = 'STATIC'

  switch (scenario) {
    case 'ROUTINE':
      advisories = Math.floor(r2 * 2) // 0..1
      ackLagSec = Math.floor(r3 * 4)
      wkldItemsPerMin = r2 * 0.5
      break
    case 'SINGLE-CAUT':
      cautions = 1
      advisories = Math.floor(r2 * 2)
      ackLagSec = 4 + r3 * 12
      wkldItemsPerMin = 1.0 + r2 * 1.0
      eclDepth = r2 > 0.5 ? 1 : 0
      break
    case 'SINGLE-WARN':
      warnings = 1
      cautions = Math.floor(r2 * 2)
      ackLagSec = 2 + r3 * 6
      wkldItemsPerMin = 2.0 + r2 * 2.0
      eclDepth = 1
      cascadeRate = 0.4
      cascadeDir = 'STATIC'
      break
    case 'MULTI-PARALLEL':
      warnings = r2 > 0.5 ? 1 : 0
      cautions = 2 + Math.floor(r3 * 2)
      advisories = 1 + Math.floor(r4 * 3)
      ackLagSec = 8 + r3 * 20
      wkldItemsPerMin = 3.0 + r2 * 2.0
      eclDepth = 2
      cascadeRate = 1.2
      cascadeDir = 'STATIC'
      prioInvFrac = spec.prioBaseline + r3 * 0.10
      break
    case 'UER-LIKE-QF32':
      // The big one — sustained cascade
      warnings = 4 + Math.floor(r2 * 4)        // 4..7 red MW
      cautions = 18 + Math.floor(r3 * 18)      // 18..35 amber MC
      advisories = 6 + Math.floor(r4 * 12)     // 6..17 adv
      ackLagSec = 35 + r3 * 90
      wkldItemsPerMin = spec.cadence * (1.4 + r2 * 0.6)
      eclDepth = Math.min(spec.eclMax, 3 + Math.floor(r3 * 3))
      cascadeRate = 3.5 + r2 * 4.0
      cascadeDir = cascadeRate > 5 ? 'RUNAWAY' : 'DIVERGE'
      prioInvFrac = spec.prioBaseline + 0.15 + r3 * 0.20
      latent = r4 > 0.65
      break
    case 'HYD-LIKE-UA232':
      warnings = 3 + Math.floor(r2 * 3)
      cautions = 8 + Math.floor(r3 * 8)
      advisories = 3 + Math.floor(r4 * 4)
      ackLagSec = 25 + r3 * 60
      wkldItemsPerMin = spec.cadence * (1.2 + r2 * 0.4)
      eclDepth = Math.min(spec.eclMax, 2 + Math.floor(r3 * 2))
      cascadeRate = 2.5 + r2 * 2.5
      cascadeDir = cascadeRate > 4 ? 'RUNAWAY' : 'DIVERGE'
      prioInvFrac = spec.prioBaseline + 0.08
      break
    case 'UAS-LIKE-AF447':
      warnings = 1 + Math.floor(r2 * 2)        // STALL warning oscillation
      cautions = 3 + Math.floor(r3 * 4)        // SPD DISAGREE / AP-OFF / FBW
      advisories = 2 + Math.floor(r4 * 3)
      ackLagSec = 18 + r3 * 35
      wkldItemsPerMin = spec.cadence * (1.0 + r2 * 0.3)
      eclDepth = 1
      cascadeRate = 1.5 + r2 * 1.0
      cascadeDir = 'DIVERGE'
      prioInvFrac = spec.prioBaseline + 0.25 + r3 * 0.20  // STALL warn oscillation = high inversion
      break
    case 'LATENT-LIKE-HELIOS':
      cautions = 1
      advisories = Math.floor(r2 * 2)
      ackLagSec = 60 + r3 * 240                 // long unacknowledged
      wkldItemsPerMin = 0.8 + r2 * 0.8
      eclDepth = 0
      cascadeRate = 0.2
      cascadeDir = 'STATIC'
      prioInvFrac = spec.prioBaseline + 0.30   // canonical mis-categorisation
      latent = true
      break
    case 'MODE-LIKE-OZ214':
      cautions = 1
      advisories = 1 + Math.floor(r2 * 2)
      ackLagSec = 12 + r3 * 30
      wkldItemsPerMin = 1.5 + r2 * 1.5
      eclDepth = 0
      cascadeRate = 0.6
      cascadeDir = 'STATIC'
      prioInvFrac = spec.prioBaseline + 0.40 + r3 * 0.15
      break
    case 'TOWS-LIKE-5022':
      // Silent inhibit failure: low count, high latent, GND phase
      cautions = 0
      advisories = Math.floor(r2 * 2)
      ackLagSec = 0
      wkldItemsPerMin = 0
      eclDepth = 0
      cascadeRate = 0
      cascadeDir = 'STATIC'
      prioInvFrac = spec.prioBaseline + 0.50  // silent inhibit = inverted priority
      latent = true
      break
    case 'EIS-LIKE-KEGWORTH':
      warnings = 1 + Math.floor(r2 * 2)
      cautions = 3 + Math.floor(r3 * 4)
      advisories = 1
      ackLagSec = 8 + r3 * 18
      wkldItemsPerMin = spec.cadence * (1.0 + r2 * 0.3)
      eclDepth = Math.min(spec.eclMax, 1 + Math.floor(r3 * 2))
      cascadeRate = 1.0 + r2 * 1.0
      cascadeDir = 'DIVERGE'
      prioInvFrac = spec.prioBaseline + 0.35  // engine mis-localisation
      break
  }

  // CONVERGE bias for older airframes / smaller families — they tend to
  // have fewer simultaneous active messages by design.
  if (scenario === 'ROUTINE') cascadeDir = 'CONVERGE'

  // Phase elevation: an active cascade scenario overrides the phase to
  // CASCADE-PH so the multiplier reflects the abnormal regime.
  let phase = basePhase
  if (scenario === 'UER-LIKE-QF32' || scenario === 'HYD-LIKE-UA232' ||
      scenario === 'UAS-LIKE-AF447' || scenario === 'EIS-LIKE-KEGWORTH') {
    phase = 'CASCADE-PH'
  }

  prioInvFrac = Math.max(0, Math.min(1, prioInvFrac))

  const state: AlertState = {
    msgCount: warnings + cautions + advisories,
    warnings, cautions, advisories,
    cascadeRate, cascadeDir,
    prioInvFrac, ackLagSec, wkldItemsPerMin, eclDepth, latent,
    scenario,
  }
  return { state, phase }
}

interface Assess {
  f: SFlight
  family: Family
  phase: Phase
  state: AlertState
  drivers: Record<Driver, number>
  score: number
  tier: Tier
  rationale: string
  worst: Driver
  weightedMean: number
}

function scoreFlight(f: SFlight, advMul: number): Assess {
  const family = pickFamily(f)
  const spec = FAM_SPEC[family]
  const basePhase = classifyPhaseBase(f)
  const { state, phase } = synthState(f, family, basePhase)

  const drivers: Record<Driver, number> = {
    'MSG-COUNT': 0, 'CASCADE': 0, 'PRIO-INV': 0, 'ACK-LAG': 0, 'WKLD-RATE': 0, 'ECL-DEPTH': 0, 'LATENT': 0,
  }

  // MSG-COUNT: 0 at 0, 50 at satN, 100 at 2·satN, saturating
  if (state.msgCount === 0) drivers['MSG-COUNT'] = 0
  else {
    const r = state.msgCount / spec.satN
    drivers['MSG-COUNT'] = Math.min(100, r * 50)
  }
  // Red MW = double-weight under MSG-COUNT (>=4 reds = floor 80)
  if (state.warnings >= 4) drivers['MSG-COUNT'] = Math.max(drivers['MSG-COUNT'], 80)
  else if (state.warnings >= 2) drivers['MSG-COUNT'] = Math.max(drivers['MSG-COUNT'], 55)

  // CASCADE: scale by direction
  let cas = Math.min(100, state.cascadeRate * 16) // 6/min → 96
  if (state.cascadeDir === 'CONVERGE') cas *= 0.25
  else if (state.cascadeDir === 'STATIC') cas *= 0.60
  else if (state.cascadeDir === 'RUNAWAY') cas = Math.max(cas, 85)
  drivers['CASCADE'] = cas

  // PRIO-INV: 0..1 mapped 0..100 with floor
  drivers['PRIO-INV'] = Math.min(100, state.prioInvFrac * 130)

  // ACK-LAG: 0..30s shallow, 30..120s steep
  if (state.ackLagSec < 5) drivers['ACK-LAG'] = state.ackLagSec * 2
  else if (state.ackLagSec < 30) drivers['ACK-LAG'] = 10 + (state.ackLagSec - 5) * 1.4
  else drivers['ACK-LAG'] = Math.min(100, 45 + (state.ackLagSec - 30) * 0.6)

  // WKLD-RATE: vs crew cadence baseline — over 100% capacity = saturation
  const wkldR = state.wkldItemsPerMin / spec.cadence
  if (wkldR < 0.4) drivers['WKLD-RATE'] = wkldR * 30
  else if (wkldR < 0.9) drivers['WKLD-RATE'] = 12 + (wkldR - 0.4) * 60
  else if (wkldR < 1.2) drivers['WKLD-RATE'] = 42 + (wkldR - 0.9) * 100
  else drivers['WKLD-RATE'] = Math.min(100, 72 + (wkldR - 1.2) * 70)

  // ECL-DEPTH: 0..eclMax shallow, beyond escalates
  if (state.eclDepth === 0) drivers['ECL-DEPTH'] = 0
  else if (state.eclDepth <= spec.eclMax) drivers['ECL-DEPTH'] = (state.eclDepth / spec.eclMax) * 50
  else drivers['ECL-DEPTH'] = Math.min(100, 50 + (state.eclDepth - spec.eclMax) * 20)

  // LATENT: high boolean + family susceptibility
  drivers['LATENT'] = state.latent ? Math.min(100, 60 + spec.latentSusc * 130) : spec.latentSusc * 20

  // ADV-MUL
  const mul = advMul / 100
  for (const d of DRIVERS) drivers[d] = Math.min(100, drivers[d] * mul)

  // Weighted mean
  let wm = 0, wsum = 0
  for (const d of DRIVERS) { wm += drivers[d] * DRIVER_WEIGHT[d]; wsum += DRIVER_WEIGHT[d] }
  const weightedMean = wsum > 0 ? wm / wsum : 0

  // Worst
  let worst: Driver = 'MSG-COUNT'; let bestV = -1
  for (const d of DRIVERS) if (drivers[d] > bestV) { bestV = drivers[d]; worst = d }

  // Composite: max(0.65·worst, 0.35·mean) × phase mul
  let composite = Math.max(0.65 * bestV, 0.35 * weightedMean) + 0.35 * weightedMean
  composite *= PHASE_MUL[phase]
  // Hard escalator: RUNAWAY cascade → floor 80
  if (state.cascadeDir === 'RUNAWAY') composite = Math.max(composite, 80)
  // Saturation MW count: >=5 reds → floor 88
  if (state.warnings >= 5) composite = Math.max(composite, 88)
  const score = Math.min(100, Math.max(0, composite))
  const tier = tierFromScore(score)

  // Rationale
  let rationale = ''
  if (tier === 'BAN') {
    rationale = `SATURATION — ${state.msgCount} msgs (${state.warnings}W·${state.cautions}C·${state.advisories}A) @ ${state.cascadeRate.toFixed(1)}/min ${state.cascadeDir} on ${family}; crew at workload saturation, transfer-of-control + ATC hold + delegate triage per FCOM ${family.startsWith('A') ? 'PRO-ABN-MISC' : 'FCOM 02 Warning'}.`
  } else if (tier === 'CRIT') {
    rationale = `CASCADE — ${state.msgCount} msgs ${state.cascadeDir} on ${family}; alert generation > response cadence (${state.wkldItemsPerMin.toFixed(1)} vs ${spec.cadence.toFixed(1)} items/min); sterile-cockpit, prioritise top-3 Level-3 only.`
  } else if (tier === 'MARGIN') {
    rationale = `HEAVY-LOAD — ${state.msgCount} parallel msgs on ${family} ECL depth ${state.eclDepth}; PF/PM colour-band split per ECAM action discipline.`
  } else if (tier === 'WATCH') {
    rationale = `SINGLE-FAULT — ${state.warnings + state.cautions} top-level msg on ${family}; established ECAM/QRH flow.`
  } else if (tier === 'CLEAR') {
    rationale = `MINOR — ${state.advisories} advisory on ${family}; routine memo discipline.`
  } else {
    rationale = `Routine — no active alerts on ${family}; ${PHASE_DESC[phase]}.`
  }
  if (state.latent && tier !== 'BAN' && tier !== 'OFF') rationale += ' LATENT fault co-existing — Helios 522 mode.'

  return { f, family, phase, state, drivers, score, tier, rationale, worst, weightedMean }
}

const SRC = 'eicas-src'
const LNK = 'eicas-lnk'
const LBL = 'eicas-lbl'

export default function EicasCascade({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState<number>(100)
  const [minFL, setMinFL] = useState<number>(0)
  const [maxFL, setMaxFL] = useState<number>(450)
  const [famFilter, setFamFilter] = useState<'ALL' | Family>('ALL')
  const [tierFilter, setTierFilter] = useState<'ALL' | Tier>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<'ALL' | Phase>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'FAMILIES' | 'PRECEDENT' | 'METHOD'>('AIRCRAFT')
  const [search, setSearch] = useState<string>('')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showRing, setShowRing] = useState(true)

  const assessments = useMemo<Assess[]>(() => {
    const out: Assess[] = []
    for (const f of flights) {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      const fl = f.altitudeFt / 100
      if (!f.ground && (fl < minFL || fl > maxFL)) continue
      out.push(scoreFlight(f, advMul))
    }
    out.sort((a, b) => {
      const r = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (r !== 0) return r
      return b.score - a.score
    })
    return out
  }, [flights, advMul, minFL, maxFL])

  const filtered = useMemo(() => {
    let xs = assessments
    if (tierFilter !== 'ALL') xs = xs.filter(a => a.tier === tierFilter)
    if (famFilter !== 'ALL') xs = xs.filter(a => a.family === famFilter)
    if (phaseFilter !== 'ALL') xs = xs.filter(a => a.phase === phaseFilter)
    if (search) {
      const s = search.toLowerCase()
      xs = xs.filter(a =>
        (a.f.callsign || a.f.icao).toLowerCase().includes(s) ||
        (a.f.operator || '').toLowerCase().includes(s) ||
        (a.f.type || '').toLowerCase().includes(s) ||
        a.family.toLowerCase().includes(s) ||
        a.state.scenario.toLowerCase().includes(s))
    }
    return xs
  }, [assessments, tierFilter, famFilter, phaseFilter, search])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { BAN:0, CRIT:0, MARGIN:0, WATCH:0, CLEAR:0, OFF:0 }
    for (const a of assessments) c[a.tier]++
    return c
  }, [assessments])

  const famCounts = useMemo(() => {
    const c: Record<Family, { ac: number; crit: number; sumScore: number; cascades: number }> = {} as any
    for (const fam of FAMILIES) c[fam] = { ac: 0, crit: 0, sumScore: 0, cascades: 0 }
    for (const a of assessments) {
      if (a.tier === 'OFF') continue
      c[a.family].ac++
      c[a.family].sumScore += a.score
      if (a.tier === 'BAN' || a.tier === 'CRIT') c[a.family].crit++
      if (a.phase === 'CASCADE-PH') c[a.family].cascades++
    }
    return c
  }, [assessments])

  const scenCounts = useMemo(() => {
    const c: Record<ScenarioId, number> = {} as any
    for (const k of Object.keys(SCENARIO_PRECEDENT)) c[k as ScenarioId] = 0
    for (const a of assessments) c[a.state.scenario]++
    return c
  }, [assessments])

  const meanScore = assessments.length ? (assessments.reduce((s, a) => s + a.score, 0) / assessments.length) : 0
  const worst = assessments[0]
  const banCrit = counts.BAN + counts.CRIT
  const totalCascades = assessments.filter(a => a.phase === 'CASCADE-PH').length
  const totalLatent = assessments.filter(a => a.state.latent).length

  // ------ Map overlay ------
  useEffect(() => {
    const m = map
    if (!m) return
    const features: GeoJSON.Feature[] = []
    const labels: GeoJSON.Feature[] = []
    for (const a of filtered) {
      if (a.tier === 'OFF') continue
      const col = TIER_COLOR[a.tier]
      if (showHalo) {
        const r = 6 + Math.min(20, a.score * 0.22)
        features.push({ type:'Feature', properties:{ kind:'halo', color: col, radius: r }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
      if (showRing && (a.tier === 'BAN' || a.tier === 'CRIT')) {
        // outer cascade ring
        features.push({ type:'Feature', properties:{ kind:'ring', color: col }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
      if (showPin && (a.tier === 'BAN' || a.tier === 'CRIT' || a.tier === 'MARGIN')) {
        features.push({ type:'Feature', properties:{ kind:'pin', color: col }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
      if (showLbl && (a.tier === 'BAN' || a.tier === 'CRIT')) {
        const cs = a.f.callsign || a.f.icao.toUpperCase()
        const text = `${cs} ${a.family} ${a.state.msgCount}msg`
        labels.push({ type:'Feature', properties:{ kind:'lbl', text, color: FAMILY_COLOR[a.family] }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
    }
    try {
      for (const [id, fc] of [[SRC, features], [LBL, labels]] as Array<[string, GeoJSON.Feature[]]>) {
        if (!m.getSource(id)) m.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features: fc } as GeoJSON.FeatureCollection })
        else (m.getSource(id) as maplibregl.GeoJSONSource).setData({ type:'FeatureCollection', features: fc } as GeoJSON.FeatureCollection)
      }
      if (!m.getLayer('eicas-ring')) m.addLayer({ id:'eicas-ring', type:'circle', source:SRC, filter:['==',['get','kind'],'ring'], paint:{ 'circle-color':'transparent', 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.2, 'circle-radius':28, 'circle-opacity':0.55 } })
      if (!m.getLayer('eicas-halo')) m.addLayer({ id:'eicas-halo', type:'circle', source:SRC, filter:['==',['get','kind'],'halo'], paint:{ 'circle-color':'transparent', 'circle-stroke-color':['get','color'], 'circle-stroke-width':2, 'circle-radius':['get','radius'], 'circle-opacity':0.8 } })
      if (!m.getLayer('eicas-pin')) m.addLayer({ id:'eicas-pin', type:'circle', source:SRC, filter:['==',['get','kind'],'pin'], paint:{ 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.2, 'circle-radius':5 } })
      if (!m.getLayer('eicas-lbl')) m.addLayer({ id:'eicas-lbl', type:'symbol', source:LBL, layout:{ 'text-field':['get','text'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.3 } })
    } catch {}
    return () => {
      try {
        for (const id of ['eicas-ring','eicas-halo','eicas-pin','eicas-lbl'])
          if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC, LBL, LNK]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl, showRing])

  return (
    <div className="absolute top-16 right-4 z-30 w-[500px] max-h-[84vh] flex flex-col rounded-lg border border-slate-700/70 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/70">
        <div className="flex items-center gap-2">
          <span className="text-sky-400 font-mono text-xs tracking-widest">EICAS</span>
          <span className="text-[10px] text-slate-500">ECAM/EICAS CASCADE · §25.1322 · QF32 · AF447</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm px-1" aria-label="Close">✕</button>
      </div>

      {/* Tier strip */}
      <div className="grid grid-cols-7 gap-px bg-slate-800/70 border-b border-slate-700/70 text-[10px] font-mono">
        {TIERS.map(t => {
          const active = tierFilter === t
          return (
            <button key={t}
              onClick={() => setTierFilter(active ? 'ALL' : t)}
              className={`px-1 py-1.5 flex flex-col items-center ${active ? 'bg-sky-500/15 ring-1 ring-sky-500/40' : 'bg-slate-900 hover:bg-slate-800'}`}>
              <span style={{ color: TIER_COLOR[t] }} className="font-semibold">{counts[t]}</span>
              <span className="text-[9px] text-slate-500 mt-0.5">{t}</span>
            </button>
          )
        })}
        <button
          onClick={() => setTierFilter('ALL')}
          className={`px-1 py-1.5 flex flex-col items-center ${tierFilter === 'ALL' ? 'bg-sky-500/15 ring-1 ring-sky-500/40' : 'bg-slate-900 hover:bg-slate-800'}`}>
          <span className="text-slate-200 font-semibold">{assessments.length}</span>
          <span className="text-[9px] text-slate-500 mt-0.5">ALL</span>
        </button>
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-4 gap-px bg-slate-800/70 border-b border-slate-700/70 text-[10px] font-mono">
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">μ-Score</div>
          <div className="text-slate-100">{meanScore.toFixed(1)}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao.toUpperCase()) : '—'}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Cascade</div>
          <div style={{ color: totalCascades > 0 ? TIER_COLOR.CRIT : '#94a3b8' }}>{totalCascades}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Latent</div>
          <div style={{ color: totalLatent > 0 ? TIER_COLOR.MARGIN : '#94a3b8' }}>{totalLatent}</div>
        </div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-700/70 space-y-1.5">
        {([
          ['ADV-MUL', advMul, setAdvMul, 50, 200, '%'],
          ['MIN-FL', minFL, setMinFL, 0, 200, ''],
          ['MAX-FL', maxFL, setMaxFL, 50, 450, ''],
        ] as Array<[string, number, (n:number)=>void, number, number, string]>).map(([lbl, v, set, lo, hi, u]) => (
          <div key={lbl} className="flex items-center gap-2">
            <span className="text-[9px] text-slate-500 font-mono w-14">{lbl}</span>
            <input type="range" min={lo} max={hi} value={v} onChange={e => set(Number(e.target.value))} className="flex-1 accent-sky-500" />
            <span className="text-[10px] text-slate-300 font-mono w-14 text-right">{v}{u}</span>
          </div>
        ))}
      </div>

      {/* Family filter chips */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center flex-wrap gap-1">
        <button onClick={() => setFamFilter('ALL')}
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${famFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400'}`}>ALL</button>
        {FAMILIES.map(c => {
          const active = famFilter === c
          const ac = famCounts[c].ac
          return (
            <button key={c} onClick={() => setFamFilter(active ? 'ALL' : c)}
              disabled={ac === 0 && !active}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${active ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : ac === 0 ? 'border-slate-800 text-slate-700' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
              <span style={{ color: FAMILY_COLOR[c] }}>●</span> {c.replace('EICAS-','').replace('ECAM-','')}
            </button>
          )
        })}
      </div>

      {/* Phase filter chips */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center flex-wrap gap-1">
        <button onClick={() => setPhaseFilter('ALL')}
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${phaseFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400'}`}>ALL</button>
        {PHASES.map(p => {
          const active = phaseFilter === p
          return (
            <button key={p} onClick={() => setPhaseFilter(active ? 'ALL' : p)}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${active ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}
              title={PHASE_DESC[p]}>
              {p}
            </button>
          )
        })}
      </div>

      {/* Toggles + search */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center gap-1.5 flex-wrap">
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['RING',showRing,setShowRing]] as Array<[string, boolean, (v:boolean)=>void]>).map(([n,v,s]) => (
          <button key={n} onClick={() => s(!v)} className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${v ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-500'}`}>{n}</button>
        ))}
        <div className="flex-1" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search cs/type/family"
          className="w-44 text-[11px] font-mono bg-slate-950/70 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 placeholder-slate-600 outline-none focus:border-sky-500/60" />
      </div>

      {/* Tabs */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center gap-1.5">
        {(['AIRCRAFT','FAMILIES','PRECEDENT','METHOD'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${tab === t ? 'bg-sky-500/15 ring-1 ring-sky-500/40 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/70">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-slate-500">No flights match filters.</div>}
            {filtered.slice(0, 250).map(a => {
              const col = TIER_COLOR[a.tier]
              const fCol = FAMILY_COLOR[a.family]
              const st = a.state
              return (
                <button key={a.f.icao}
                  onClick={() => onFly(a.f.icao)}
                  className="w-full text-left px-2 py-1.5 hover:bg-slate-800/40">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: col }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="text-slate-100 font-semibold">{a.f.callsign || a.f.icao.toUpperCase()}</span>
                        <span className="text-slate-500">{a.f.type || '—'}</span>
                        <span className="text-[9px] px-1 py-0 rounded" style={{ background: fCol + '25', color: fCol }}>{a.family.replace('EICAS-','').replace('ECAM-','')}</span>
                        <span className="text-[9px] px-1 py-0 rounded text-slate-300 bg-slate-800">{a.phase}</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: col + '25', color: col }}>{a.tier}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        <span>FL{String(Math.round(a.f.altitudeFt / 100)).padStart(3,'0')}</span>
                        <span>{Math.round(a.f.velocityKts)}kt</span>
                        <span style={{ color: a.f.vertRate > 200 ? '#10b981' : a.f.vertRate < -200 ? '#f59e0b' : '#94a3b8' }}>{a.f.vertRate > 0 ? '↑' : a.f.vertRate < 0 ? '↓' : '→'}{Math.abs(Math.round(a.f.vertRate))}fpm</span>
                        <span className="text-slate-500 truncate ml-auto">{a.f.operator || ''}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        <span style={{ color: '#ef4444' }}>{st.warnings}W</span>
                        <span style={{ color: '#f59e0b' }}>{st.cautions}C</span>
                        <span style={{ color: '#0ea5e9' }}>{st.advisories}A</span>
                        <span className="text-slate-500">·</span>
                        <span style={{ color: st.cascadeDir === 'RUNAWAY' ? '#ef4444' : st.cascadeDir === 'DIVERGE' ? '#f59e0b' : st.cascadeDir === 'CONVERGE' ? '#10b981' : '#94a3b8' }}>
                          {st.cascadeDir === 'DIVERGE' || st.cascadeDir === 'RUNAWAY' ? '↗' : st.cascadeDir === 'CONVERGE' ? '↘' : '→'}{st.cascadeRate.toFixed(1)}/min
                        </span>
                        <span className="text-slate-500">ECL·{st.eclDepth}</span>
                        <span className="text-slate-500">ACK·{Math.round(st.ackLagSec)}s</span>
                        {st.latent && <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: '#f59e0b25', color: '#f59e0b' }}>LATENT</span>}
                      </div>
                      <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden">
                        <div className="h-full" style={{ width: `${Math.min(100, a.score)}%`, background: col }} />
                      </div>
                      <div className="grid grid-cols-7 gap-0.5 mt-1 text-[9px] font-mono">
                        {DRIVERS.map(k => {
                          const s = a.drivers[k]
                          const muted = s < 6
                          return (
                            <div key={k} className="bg-slate-950/60 rounded px-1 py-0.5 flex flex-col items-center" title={DRIVER_DESC[k]}>
                              <span className={muted ? 'text-slate-700' : 'text-slate-300'}>{k.replace('MSG-COUNT','MSG').replace('PRIO-INV','PRIO').replace('ACK-LAG','ACK').replace('WKLD-RATE','WKLD').replace('ECL-DEPTH','ECL').replace('CASCADE','CASC').replace('LATENT','LAT')}</span>
                              <span className={muted ? 'text-slate-700' : 'text-slate-300'}>{Math.round(s)}</span>
                            </div>
                          )
                        })}
                      </div>
                      <div className="mt-1 text-[10px] text-slate-400 leading-snug">{a.rationale}</div>
                      {st.scenario !== 'ROUTINE' && st.scenario !== 'SINGLE-CAUT' && st.scenario !== 'SINGLE-WARN' && st.scenario !== 'MULTI-PARALLEL' && (
                        <div className="mt-0.5 text-[9px] text-slate-500 italic">{SCENARIO_PRECEDENT[st.scenario]}</div>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {tab === 'FAMILIES' && (
          <div className="divide-y divide-slate-800/70">
            {FAMILIES.map(fam => {
              const info = famCounts[fam]
              const mean = info.ac > 0 ? info.sumScore / info.ac : 0
              const tier = tierFromScore(mean)
              const col = TIER_COLOR[tier]
              const spec = FAM_SPEC[fam]
              return (
                <div key={fam} className="px-2 py-1.5">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: FAMILY_COLOR[fam] }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="text-slate-100 font-semibold">{fam}</span>
                        <span className="text-slate-300 truncate">{FAMILY_DESC[fam]}</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: col + '25', color: col }}>{info.ac} ac</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        <span>satN <span className="text-slate-200">{spec.satN}</span></span>
                        <span>cad <span className="text-slate-200">{spec.cadence}</span>/min</span>
                        <span>ECL≤<span className="text-slate-200">{spec.eclMax}</span></span>
                        <span>latS <span className="text-slate-200">{(spec.latentSusc*100).toFixed(0)}%</span></span>
                        <span className="ml-auto">μ {mean.toFixed(1)}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        {info.crit > 0 && <span style={{ color: TIER_COLOR.BAN }}>{info.crit} ban+crit</span>}
                        {info.cascades > 0 && <span style={{ color: TIER_COLOR.CRIT }}>{info.cascades} cascading</span>}
                        {info.crit === 0 && info.cascades === 0 && info.ac > 0 && <span className="text-slate-500">no active cascade</span>}
                        {info.ac === 0 && <span className="text-slate-600 italic">no flights in fleet</span>}
                      </div>
                      <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden">
                        <div className="h-full" style={{ width: `${Math.min(100, mean)}%`, background: col }} />
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'PRECEDENT' && (
          <div className="divide-y divide-slate-800/70">
            <div className="px-3 py-2 text-[10px] text-slate-400 leading-snug">
              <span className="text-slate-100 font-semibold">Active scenario synthesis · per-airframe.</span>{' '}
              Each airframe is sampled deterministically into one of the scenario classes below.
              Cascade-class scenarios are rare (~6% fleet) and inherit accident precedents.
              Counts below are CURRENT-tick samples — they reflect synthetic state for the visualisation.
            </div>
            {(Object.keys(SCENARIO_PRECEDENT) as ScenarioId[]).map(s => {
              const c = scenCounts[s]
              const isCascade = s.includes('LIKE-') && !s.includes('TOWS')
              const isLatent = s === 'LATENT-LIKE-HELIOS' || s === 'TOWS-LIKE-5022'
              const col = isCascade ? TIER_COLOR.CRIT : isLatent ? TIER_COLOR.MARGIN : c > 0 ? TIER_COLOR.WATCH : TIER_COLOR.OFF
              return (
                <div key={s} className="px-2 py-1.5">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: col }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="text-slate-100 font-semibold">{s}</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: col + '25', color: col }}>{c}</span>
                      </div>
                      <div className="text-[10px] text-slate-400 mt-0.5 leading-snug">{SCENARIO_PRECEDENT[s]}</div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="px-3 py-2 text-[11px] text-slate-300 leading-snug space-y-2">
            <p>
              <span className="text-slate-100 font-semibold">EICAS-CASCADE — ECAM / EICAS Multi-Failure Master-Caution / Warning Alert-Cascade & Crew-Workload Stack Monitor.</span>
              {' '}Per-airframe live evaluator of cockpit alert-display subsystem saturation during multi-failure / cascade events.
              Classifies every airframe into one of 13 alert-architecture families (B-EICAS-NG · A-ECAM-FBW · etc.) each with its own
              saturation threshold (satN), crew response cadence, electronic-checklist nest tolerance, and latent susceptibility profile,
              then scores the active alert state against the per-family capacity envelope.
            </p>
            <p>
              <span className="text-slate-100 font-semibold">Driver scoring [0..100]:</span>
            </p>
            <ul className="text-[10px] font-mono space-y-0.5 ml-2 text-slate-400">
              {DRIVERS.map(d => (
                <li key={d}><span className="text-slate-200">{d}</span> · <span className="text-slate-500">w={Math.round(DRIVER_WEIGHT[d]*100)}%</span> · {DRIVER_DESC[d]}</li>
              ))}
            </ul>
            <p>
              <span className="text-slate-100 font-semibold">Composite</span>{' = '}
              <span className="font-mono">max(0.65·worst, 0.35·mean) + 0.35·mean</span>, then phase-multiplier
              (CASCADE-PH 1.25 · TKO/LDG 1.15 · APP 1.10 · CLB 0.90 · DST 0.92 · CRZ 0.85 · GND 0.55).
              Hard escalators: ≥5 red MW → floor 88 · RUNAWAY direction → floor 80.
            </p>
            <p>
              <span className="text-slate-100 font-semibold">Tiers:</span>
              {' '}BAN ≥ 85 (SATURATION) · CRIT ≥ 65 (CASCADE) · MARGIN ≥ 45 (HEAVY-LOAD) ·
              WATCH ≥ 25 (SINGLE-FAULT) · CLEAR ≥ 10 (MINOR) · OFF (ROUTINE).
            </p>
            <p>
              <span className="text-slate-100 font-semibold">Accident precedents seeded into scenario library:</span>{' '}
              QF32 (A380 ATSB AO-2010-089 · 54 ECAM msgs) · UA232 (DC-10 NTSB AAR-90-06) · AF447 (A330 BEA F-CP090601) ·
              Helios 522 (737 AAIASB 11/2006 · latent inhibit) · Asiana 214 (777 NTSB AAR-14-01 · A/T-mode masking) ·
              Spanair 5022 (MD-82 CIAIAC A-032/2008 · TOWS silent) · BMA 092 Kegworth (737-400 AAIB 4/90 · EIS mis-localisation).
            </p>
            <p className="text-slate-400">
              <span className="text-slate-200">Distinct from</span> FMA (automation-mode confusion, single-system),
              FBW-REV (FBW law degradation, single-system), MCAS (B737 MAX stab-trim runaway, single failure),
              MEL (dispatch-time deferral, pre-flight), EHM / OIL / VIB / EGT (single-engine trending),
              PINCAP (human crew incapacitation), TUC (hypoxia), PIO (closed-loop pilot coupling).
              EICAS-CASCADE is uniquely the MULTI-FAILURE ALERT-DISPLAY SATURATION evaluator.
            </p>
            <p className="text-slate-500 italic">
              References: 14 CFR §25.1322 · EASA CS-25.1322 · FAA AC 25.1322-1 (2010) · FAA AC 25-11B · EASA AMC 25.1322 (ED 2013/010/R)
              · SAE ARP-4754A · ARP-4761/A · ARP-5588 · AIR-6055 · ICAO Annex 6 Pt I §6.10 · Doc 9760 Vol II Pt VI · Doc 9859 SMM ed.4
              · Doc 9683 HF Training · Boeing D6-83563 EICAS (777) · FCOM Vol 2 §02 · 787 OM §0.05 · Airbus FCOM DSC-31 ECAM · PRO-ABN-MISC
              · Embraer EICAS-IV POM §0.04 · CRJ FCOM Vol 2 §02 · RTCA DO-178C / DO-254 / DO-275 · Sarter-Woods IJAP 1995 · HF 1997
              · Wickens HF 2008 · FSF ALAR BN 7.1 · IATA STEADES 2024 §11 · EUROCONTROL EVAIR Bull 28 §4
              · NTSB AAR-90-06 / AAR-14-01 / AIR-08-01 · ATSB AO-2010-089 · BEA F-CP090601 · AAIB 4/90 · AAIASB 11/2006 · CIAIAC A-032/2008.
            </p>
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-700/70 text-[9px] text-slate-500 leading-snug">
        §25.1322 / CS-25.1322 / ARP-5588 / Annex 6 Pt I §6.10 · cascade-direction + workload-stack composite · synthetic deterministic-by-ICAO-hash scenario sample, not live cockpit data · planner/visualisation only, not a certified alert system.
      </div>
    </div>
  )
}
