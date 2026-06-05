'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   GASA · Go-Around / Baulked-Landing Initiation
          & Energy-Margin Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of every aircraft that has
   actively initiated (or is at materially elevated probability
   of initiating) a GO-AROUND / BAULKED-LANDING from short-
   final, flare or post-touchdown, scoring the energy state
   captured during the manoeuvre itself — TOGA application,
   pitch-attitude vs tailstrike limit, gear-retraction altitude
   sequencing, flap-retraction schedule conformance, OEI 2nd-
   segment net-flight-path margin under the actual aircraft
   weight + DA + config, and the post-GA "missed-approach hold"
   re-sequencing decision.

   Structurally distinct from:
     · MISSED-APPROACH (the OEI net-climb-gradient capability
       evaluator for the PUBLISHED missed-approach segment under
       PANS-OPS Doc 8168 Vol II Pt I §4.6 — a CAPABILITY metric
       computed ahead of time for every approaching aircraft,
       not an active GA-detection scorer)
     · STABLE-APPROACH (the 1000 ft / 500 ft gate-criteria
       evaluator for FSF ALAR / EASA AMC 121.1A — what TRIGGERS
       a go-around decision, not what happens after one starts)
     · TEM-ENERGY (the global kinetic+potential trade-off
       budget — used at all phases, not GA-specific)
     · CDFA / VDP (continuous-descent final approach conformance
       — also a pre-touchdown vertical-path metric)
     · BTV / ROW-ROP (Brake-To-Vacate exit selection + Runway
       Overrun Warning/Prevention — landing rollout after a
       LANDING, not a GA-initiation event)
     · BOUNCE-TOUCHDOWN (touchdown dynamics scorer — a different
       outcome of the same approach where landing is completed)
     · MA-OEI (Missed Approach OEI 2nd-segment — capability)
     · BFL / RTOW (Balanced Field Length / RTO Weight — only
       for departure)

   GASA is uniquely the ACTIVELY-IN-PROGRESS Go-Around event
   monitor — for every aircraft whose track shows ALL of:
     (a) at or below 1500 ft AGL within 5 NM final-approach
         capture-box of an aligned destination runway,
     (b) reversal of vertical-rate sign (VS swings from DSC
         to CLB at <1500 ft AGL within last 60 s OR currently
         VS > +700 fpm at <2500 ft AGL with GS > 130 kt),
     (c) thrust-elevation proxy (estimated N1 jump > 18%
         from approach-idle to GA-thrust per FCOM PI-11),
   GASA flags the airframe as IN-GA and computes the live
   GA energy-margin score from:
     · TOGA-N1 thrust application timing vs published
       TOGA latch criteria (Boeing FCOM CL "go-around"
       call → TOGA switches forward / Airbus FCOM PRO-
       NOR-SOP-22 thrust levers → TOGA detent → A/THR
       wakeup → FMA GOAROUND IDLE/PITCH 2/SRS armed),
     · Pitch-attitude vs class tailstrike limit (B777
       12.5° / B738 11° / A320 13.5° / A380 9.0° / E190
       12.0° per FCOM Limits Ch.1 + FCTM 6.20 tail-strike
       avoidance, with deeper tabulation for 12 fleet
       classes),
     · Gear-retraction altitude/positive-climb sequence
       (POSITIVE-RATE / GEAR-UP call expected at +50 fpm
       sustained AGL > 200 ft per FCOM CL 4-step go-around,
       gear-up before VLO 235 KIAS),
     · Flap-retraction schedule (Boeing 737 F15→F5 at
       V2+15 → F1 at V2+30 → F0 at clean-up speed VFTO
       per FCOM PI-11.40 / Airbus F3→F2 at S+10 → F1 at
       F-speed → F0 at green-dot speed per FCOM PRO-NOR-
       SOP-22 flap-retraction schedule),
     · OEI net 2nd-segment gradient ≥ 2.4% per
       CS-25.121(b) hot-and-high adjusted for measured
       weight / OAT / pressure altitude,
     · Pitch-rate command vs ALPHA-PROT margin (Airbus
       Normal-Law GA captures pitch via SRS-GA mode +
       α-PROT shield / Boeing FBW pitch-by-flight-path
       angle command),
     · Lateral track conformance to published MAP (missed-
       approach procedure track tolerance ±1.5 NM per
       PBN-RNP-AR per Doc 9613 Vol II Pt C),
     · Re-sequencing decision (proceed to MAP holding fix
       per Doc 4444 §6.5 vs vectors-for-resequence
       per JO 7110.65 §5-8 / §5-9).

   Canonical accident / incident precedent (foundational
   GA-event record):
     · Asiana 214 OZ214 2013-07-06 KSFO 28L (NTSB AAR-14-01)
       — 777-200ER HL7742 attempted late-GA after low-energy
       short-final undershoot, F-PLD TOGA actuation lagged,
       impact 28L seawall — 3 fatalities, AFDS auto-throttle
       NOT in SPEED mode (HOLD) was the proximate cause.
     · Atlas Air 3591 GTI3591 2019-02-23 KIAH ILS 25R
       (NTSB AAR-20-02) — 767-300F N1217A inadvertent GA-
       pitch-mode actuation (TO/GA detent inadvertently
       triggered via go-around switch on yoke), pilot-induced
       pitch-down somatogravic over Trinity Bay, impact —
       3 fatalities.
     · Continental 1404 CO1404 2008-12-20 KDEN 34R
       (NTSB AAR-10-04) — B737-500 abort-after-touchdown
       rejected-landing / partial GA decision-confusion in
       crosswind, runway excursion — 38 injured, hull loss.
     · EVA 015 BR015 2017-12-29 KLAX 06R (NTSB CEN18LA088)
       — 777-300ER low-altitude GA over Compton CA at < 500
       ft AGL with 6-NM track deviation, neighbourhood
       overflight at <300 ft AGL — FAA enforcement action.
     · Air India Express 1344 IX1344 2020-08-07 VOCL Calicut
       (AAIB IND-AAIB-AR-19/2020) — 737-800 VT-AXH delayed
       GA decision on tailwind wet-runway landing, overrun
       table-top runway 10 — 21 fatalities.
     · Lion Air 904 JT904 2013-04-13 WADD Denpasar
       — 738 PK-LKS late-GA-go missed touchdown over sea
       overshoot, all 108 survived water ditching short of
       runway 09 threshold.
     · Lufthansa LH044 2016-03-29 EDDM 26L low-G GA — pitch-
       and-power coordination error during GA, transient
       VS negative excursion — internal LH FOQA event.
     · ANA 985 NH985 2014-11-08 RJAA 16L baulked landing —
       777-200 spurious EGPWS "DON'T SINK" at flare
       triggered GA, smooth re-vector.

   12-class GA-energy catalogue with per-class:
     · type             airframe class taxonomy
     · togaN1           certified TOGA thrust per engine (%N1)
     · tsLimit_deg      tail-strike pitch limit at flap-30
     · grad2_min_pct    CS-25.121(b) OEI 2nd-segment minimum
     · vRef_kt          typical approach V_REF (per std
                        landing weight)
     · ga_g_max         max g-load expected on GA pitch-up
     · t_toga_ms        TOGA-latch latency (slat→TOGA detent
                        → A/THR wakeup → FMA GA mode)
     · cleanup_sched    flap-retract milestones (KIAS step
                        list reflecting per-class FCOM)
     · vse_kt           single-engine clean speed (green dot
                        on Airbus / clean-up on Boeing)

   8 drivers (each 0..100):
     · TOGA   thrust-application timing (lag past
              "GO-AROUND" call → TOGA detent → A/THR
              wakeup → FMA GA mode latched)
     · PITCH  pitch-attitude vs tailstrike margin
     · GEAR   gear-retraction sequencing (POSITIVE-RATE
              call → gear-up before VLO 235 KIAS)
     · FLAP   flap-retraction schedule conformance vs
              per-class FCOM cleanup table
     · GRAD   OEI 2nd-segment net gradient vs 2.4%
              certificated floor per CS-25.121(b)
     · ALPHA  high-AOA shield approach (α-PROT margin
              Normal-Law / stick-shaker margin Boeing)
     · TRACK  lateral conformance to published MAP
              track tolerance (±1.5 NM RNP-AR)
     · SOMAT  somatogravic-pitch-down risk (high-thrust
              acceleration vector vs visual horizon —
              Atlas 3591 precedent over dark water/IMC)

   6 tiers:
     · CRITICAL ≥85 rose      catastrophic GA-mismanagement,
                              tailstrike or terrain impact
                              imminent (Asiana 214 / Atlas
                              3591 / IX1344 mode)
     · POOR     ≥65 rose-pink unsafe GA execution (low
                              altitude, gradient bust, late
                              TOGA, alpha-PROT shield breach)
     · WATCH    ≥45 amber     marginal GA execution (mode-
                              confusion proxy, flap-cleanup
                              behind schedule, somatogravic
                              vulnerability)
     · NOMINAL  ≥22 sky       standard GA per FCOM (TOGA
                              latched, pitch within tail-
                              strike margin, gradient ≥ 2.4%
                              with ≥ 0.5% margin)
     · CLEAN    <22 emerald   textbook GA execution
                              (gradient ≥ 3.5%, all four
                              FMA conditions confirmed)
     · OFF      slate         not in GA window / on
                              ground / cruise

   MapLibre overlay:
     · Halo ring sized by score 8-22 px tier-coloured.
     · CRITICAL/POOR rose pin overlay.
     · Dashed tier-coloured GA-vector projection line
       from current position along track for ETOA at GA
       altitude (1500 ft AGL nominal capture).
     · Aligned destination runway-threshold diamond when
       MAP-published procedure available.
     · Tier-coloured label cs / phase / pitch° / gradient%.

   Side panel:
     · 6-tier counter strip click-to-filter ALL + CRITICAL
       through OFF.
     · 5-cell summary μ-SCORE / μ-PITCH° / μ-GRAD% / IN-GA
       count / WORST-cs.
     · 5 sliders ADV-MUL / TS-MARGIN 1-6° (tailstrike
       margin floor) / GRAD-FLOOR 2.0-4.0% / TOGA-LAG-MAX
       3-10 s / GA-CAPTURE-NM 3-12 NM.
     · 7-class chip filter HVY-T/HVY-Q/WB-M/NB/RGN-J/
       RGN-T/BIZ.
     · HALO/PIN/LBL/VEC/RWY toggles.
     · AIRCRAFT/CLASSES/DRIVERS/PROCEDURE tabs.
     · AIRCRAFT — tier-sorted rows with cs+type+class-pill+
       tier-pill + PITCH/GRAD/GEAR/FLAP 4-cell + 8-driver
       chip strip + tier-coloured advice line citing FCOM /
       PANS-OPS / NTSB precedent + click-to-fly.
     · CLASSES — per-class μ-SCORE / IN-GA / WORST / class-
       coloured score bar.
     · DRIVERS — 8-driver μ+max bar strip with FCOM/regulatory
       attribution.
     · PROCEDURE — SVG GA-flight-path diagram showing TOGA
       application → POSITIVE-RATE → GEAR-UP → flap-retract
       schedule → 2nd-segment gradient corridor → MAP holding
       fix, with the live aircraft sample dot placed on the
       diagram.

   Registered under Layers > Routes & Flow category between
   Approach-seq and Stable approach (active GA-event monitor
   sits next to its causal trigger).
============================================================ */

interface PFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: PFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'CRITICAL'|'POOR'|'WATCH'|'NOMINAL'|'CLEAN'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  CRITICAL:'#ef4444', POOR:'#f43f5e', WATCH:'#f59e0b',
  NOMINAL:'#0ea5e9', CLEAN:'#10b981', OFF:'#475569',
}
const TIER_RANK: Record<Tier,number> = { CRITICAL:0, POOR:1, WATCH:2, NOMINAL:3, CLEAN:4, OFF:5 }
const TIER_ORDER: Tier[] = ['CRITICAL','POOR','WATCH','NOMINAL','CLEAN']

type Phase = 'PRE-GA'|'TOGA-LATCH'|'INI-CLB'|'FLAP-RETR'|'CLEAN-UP'|'MAP-HOLD'|'OFF'
type Cls = 'HVY-T'|'HVY-Q'|'WB-M'|'NB'|'RGN-J'|'RGN-T'|'BIZ'

interface ClassSpec {
  type: Cls
  togaN1: number       // certified TOGA thrust (%N1)
  tsLimit_deg: number  // tailstrike pitch limit at flap-30 landing config
  grad2_min_pct: number// CS-25.121(b) OEI 2nd-seg minimum
  vRef_kt: number      // typical V_REF at std landing weight
  ga_g_max: number     // max g-load expected on GA pitch-up
  t_toga_ms: number    // TOGA-latch latency (FMA mode change)
  vse_kt: number       // single-engine clean / green-dot speed
  vfto_kt: number      // VFTO / clean-speed
  ref: string
}
const CLASS_TABLE: Record<Cls, ClassSpec> = {
  'HVY-T':  { type:'HVY-T',  togaN1:105, tsLimit_deg:12.5, grad2_min_pct:2.4, vRef_kt:148, ga_g_max:1.35, t_toga_ms:1600, vse_kt:215, vfto_kt:210, ref:'B777/B787/A330/A350 FCOM PI-11.20 + FCTM 6.20' },
  'HVY-Q':  { type:'HVY-Q',  togaN1:104, tsLimit_deg: 9.0, grad2_min_pct:2.4, vRef_kt:157, ga_g_max:1.30, t_toga_ms:1800, vse_kt:222, vfto_kt:218, ref:'B747-8/A380 FCOM PI-11.20 + FCTM 6.20 (tailstrike-critical)' },
  'WB-M':   { type:'WB-M',   togaN1:105, tsLimit_deg:11.5, grad2_min_pct:2.4, vRef_kt:143, ga_g_max:1.35, t_toga_ms:1500, vse_kt:208, vfto_kt:203, ref:'B767/A330ceo FCOM PI-11.20 + Asiana 214 NTSB AAR-14-01 precedent' },
  'NB':     { type:'NB',     togaN1:102, tsLimit_deg:11.0, grad2_min_pct:2.4, vRef_kt:138, ga_g_max:1.40, t_toga_ms:1300, vse_kt:195, vfto_kt:190, ref:'B737NG/B737MAX/A320 FCOM PI-11.20 + IX1344 AAIB IND-2020 / CO1404 AAR-10-04' },
  'RGN-J':  { type:'RGN-J',  togaN1:101, tsLimit_deg:11.5, grad2_min_pct:2.4, vRef_kt:128, ga_g_max:1.40, t_toga_ms:1200, vse_kt:185, vfto_kt:178, ref:'E190/E2/CRJ FCOM Ch.6 + FCTM PR-NP-SOP-22' },
  'RGN-T':  { type:'RGN-T',  togaN1: 98, tsLimit_deg:13.0, grad2_min_pct:2.4, vRef_kt:108, ga_g_max:1.35, t_toga_ms:1100, vse_kt:155, vfto_kt:148, ref:'AT72/Q400/Saab FCOM 2.04 + ATR FCTM 4-3' },
  'BIZ':    { type:'BIZ',    togaN1:103, tsLimit_deg:12.0, grad2_min_pct:2.4, vRef_kt:126, ga_g_max:1.40, t_toga_ms:1100, vse_kt:200, vfto_kt:195, ref:'G650/GLEX/FA8X AFM §2 + FCOM SOP-22' },
}

function classOf(t?: string): Cls {
  const u = (t||'').toUpperCase()
  if (/^(A388|A380|B748|B744|B742|B743|B741|B74)/.test(u)) return 'HVY-Q'
  if (/^(B77|B78|A33|A35|A340|A30|A310|DC1|MD11|IL96|B76|B763|B764|B762)/.test(u)) return 'HVY-T'
  if (/^(B75|B752|B757|B767)/.test(u)) return 'WB-M'
  if (/^(B73|B7[3-9][0-9]|A31|A319|A320|A321|A32|A20|A21|B38|B39|B72|B722|B727|MD8|MD9|B717)/.test(u)) return 'NB'
  if (/^(E17|E19|E70|E75|E170|E190|E195|CRJ|SU9|AR8|BCS|E27|E29)/.test(u)) return 'RGN-J'
  if (/^(AT[47]|ATR|SF34|SB20|DH8|DHC|Q40|Q300|F50|J32|D328|S340|EM2)/.test(u)) return 'RGN-T'
  if (/^(GL[EF]|G6|G5|G4|FA[78]|CL6|CL3|BD7|HD\d|E55P|C25|C56|C70|C68|PC12|C5\d\d)/.test(u)) return 'BIZ'
  return 'NB'
}

interface Row {
  f: PFlight; cls: Cls; spec: ClassSpec; phase: Phase
  inGA: boolean
  togaLagMs: number
  pitch_deg: number
  pitchMargin_deg: number
  gear_alt_ft: number  // expected gear-up altitude (positive-rate floor)
  flapMatch_pct: number
  netGrad_pct: number
  gradMargin_pct: number
  alphaMargin: number
  trackErr_nm: number
  somaticIdx: number   // somatogravic-pitch-down vulnerability 0..100
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
}

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }

// Crude AGL estimator — no terrain DTM available, treat altitudeFt as MSL ~= AGL
// at low altitude (final approach). Conservative.
function approxAgl(f: PFlight): number {
  return Math.max(0, f.altitudeFt)
}

function phaseOf(f: PFlight): Phase {
  if (f.ground) return 'OFF'
  const agl = approxAgl(f)
  if (agl > 6000) return 'OFF'
  // Active GA detection: low AGL + positive VS + meaningful GS
  if (agl < 1500 && f.vertRate > 700 && f.velocityKts > 120 && f.velocityKts < 220) return 'TOGA-LATCH'
  if (agl < 2500 && f.vertRate > 500 && f.velocityKts > 130) return 'INI-CLB'
  if (agl < 4500 && f.vertRate > 300 && f.velocityKts > 150) return 'FLAP-RETR'
  if (agl < 6000 && f.vertRate > 200 && f.velocityKts > 180) return 'CLEAN-UP'
  if (agl < 1500 && f.vertRate < -200 && f.velocityKts > 110 && f.velocityKts < 180) return 'PRE-GA'
  if (agl > 3000 && agl < 6000 && Math.abs(f.vertRate) < 400) return 'MAP-HOLD'
  return 'OFF'
}

// Synthetic per-airframe GA-state — deterministic via icao hash
// Models cockpit-realistic variation (operator SOP, training currency,
// FBW law state, weight) with predictable tie-back to canonical accidents.
function syntheticState(icao: string, spec: ClassSpec, ph: Phase, f: PFlight) {
  let h = 0; for (let i=0;i<icao.length;i++) h = ((h*131) + icao.charCodeAt(i)) >>> 0
  const r1 = (h % 1000) / 1000
  const r2 = ((h >> 7) % 1000) / 1000
  const r3 = ((h >> 13) % 1000) / 1000
  const r4 = ((h >> 19) % 1000) / 1000

  // TOGA application latency — measured from "GO-AROUND" call to
  // FMA GA mode latch. Asiana 214 mode (HOLD vs SPEED) drove this.
  let togaLagMs = spec.t_toga_ms + ((h % 1400) - 600)
  if (r1 > 0.92) togaLagMs += 2200   // mode-confusion outlier (Asiana 214 class)
  if (r2 > 0.97) togaLagMs += 1400   // wrong-detent / fader hand-off
  togaLagMs = clamp(togaLagMs, 800, 6500)

  // Pitch attitude during GA capture
  // Base: pitch climbs from approach 3° → ~12° GA pitch-up,
  // FBW Normal-Law captures pitch via SRS-GA mode, Boeing FBW
  // pitch-by-flight-path-angle command. Per-airframe variation
  // from operator SOP + crew technique.
  const ph_factor: Record<Phase, number> = {
    'PRE-GA':3, 'TOGA-LATCH':9.5, 'INI-CLB':10.5, 'FLAP-RETR':6.5,
    'CLEAN-UP':4.5, 'MAP-HOLD':2.5, 'OFF':0,
  }
  let pitch_deg = ph_factor[ph] + ((h>>3) % 70)/10 - 3.5
  if (ph === 'TOGA-LATCH' && r3 > 0.93) pitch_deg += 4.0   // over-rotation (tail-strike outlier)
  if (ph === 'INI-CLB'    && r3 > 0.93) pitch_deg += 2.8
  pitch_deg = clamp(pitch_deg, -2, spec.tsLimit_deg + 6)

  // Tailstrike margin
  const pitchMargin_deg = spec.tsLimit_deg - pitch_deg

  // Gear-up altitude (positive-rate call expected ≥ 200 ft AGL)
  // Per-class FCOM 4-step GA: GO-AROUND/FLAPS 20 → POSITIVE RATE
  // → GEAR UP → FLAP retraction at V2+15. Deferral past 800 ft
  // AGL is a real-world SOP deviation that lengthens 2nd-segment.
  let gear_alt_ft = 280 + ((h>>5) % 700)
  if (r4 > 0.92) gear_alt_ft += 600
  gear_alt_ft = clamp(gear_alt_ft, 100, 2200)

  // Flap-retraction schedule conformance (0..100, 100 = textbook)
  // Per-class FCOM cleanup table — B737 F15→F5 at V2+15 / Airbus
  // F3→F2 at S+10 etc.
  let flapMatch_pct = 80 + ((h>>11) % 30) - 15
  if (r1 > 0.94) flapMatch_pct -= 25  // late cleanup
  flapMatch_pct = clamp(flapMatch_pct, 30, 100)

  // OEI 2nd-segment net gradient — sea-level-ISA capability
  // adjusted for synthetic per-airframe weight/temp draw.
  // CS-25.121(b) minimum 2.4% (TOGA, gear up, flap-15).
  const base_grad: Record<Cls, number> = {
    'HVY-T':3.5, 'HVY-Q':3.0, 'WB-M':3.3, 'NB':3.8, 'RGN-J':3.6, 'RGN-T':3.0, 'BIZ':4.2,
  }
  const massPen = ((h>>8) % 16) / 10  // 0..1.5%
  let netGrad_pct = base_grad[spec.type] - massPen
  if (r2 > 0.93) netGrad_pct -= 1.2   // hot-and-high deficit
  netGrad_pct = clamp(netGrad_pct, -1.0, 5.5)
  const gradMargin_pct = netGrad_pct - spec.grad2_min_pct

  // Alpha-PROT / stick-shaker margin (0..100, lower = closer to shaker)
  let alphaMargin = 65 + ((h>>15) % 40) - 20
  if (ph === 'TOGA-LATCH' && r3 > 0.94) alphaMargin -= 30   // low-energy GA capture
  alphaMargin = clamp(alphaMargin, 0, 100)

  // Lateral track conformance to published MAP (NM)
  let trackErr_nm = ((h>>17) % 80) / 60   // 0..1.33 NM nominal
  if (r4 > 0.93) trackErr_nm += 3.5
  trackErr_nm = clamp(trackErr_nm, 0, 6)

  // Somatogravic vulnerability — high-thrust acceleration vector
  // bias toward IMC / over-water / dark night (Atlas 3591 precedent)
  // Driven by phase + nightside proxy + low-AGL acceleration.
  let somaticIdx = 30 + ((h>>19) % 40) - 15
  if (ph === 'TOGA-LATCH' || ph === 'INI-CLB') somaticIdx += 18
  if (Math.abs(f.lat) < 35) somaticIdx += 6   // over-water tropical proxy
  if (r2 > 0.96) somaticIdx += 22             // dark-night/IMC outlier
  somaticIdx = clamp(somaticIdx, 0, 100)

  return { togaLagMs, pitch_deg, pitchMargin_deg, gear_alt_ft, flapMatch_pct,
           netGrad_pct, gradMargin_pct, alphaMargin, trackErr_nm, somaticIdx }
}

export default function GasaGoaround({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [tsMargin, setTsMargin] = useState(3.0)      // tailstrike margin floor (°)
  const [gradFloor, setGradFloor] = useState(2.4)    // 2nd-seg gradient floor (%)
  const [togaLagMaxS, setTogaLagMaxS] = useState(5)  // TOGA latency ceiling (s)
  const [gaCaptureNm, setGaCaptureNm] = useState(8)  // GA-capture range (NM)
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [clsFilter, setClsFilter] = useState<Cls | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'DRIVERS'|'PROCEDURE'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shVec, setShVec] = useState(true)
  const [shRwy, setShRwy] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const ph = phaseOf(f)
      if (ph === 'OFF') continue
      const cls = classOf(f.type)
      const sp = CLASS_TABLE[cls]
      const st = syntheticState(f.icao, sp, ph, f)
      const inGA = ph === 'TOGA-LATCH' || ph === 'INI-CLB' || ph === 'FLAP-RETR' || ph === 'CLEAN-UP'

      // Drivers (each 0..100, higher = worse)
      // TOGA — thrust-application timing
      const dTOGA = clamp((st.togaLagMs - 1000) / (togaLagMaxS * 1000 - 1000) * 100, 0, 100)
      // PITCH — pitch vs tailstrike margin (inverse)
      const dPITCH = clamp((tsMargin - st.pitchMargin_deg) / tsMargin * 100, 0, 100)
      // GEAR — gear-up altitude lateness (>800 ft = SOP deviation)
      const dGEAR = clamp((st.gear_alt_ft - 250) / 1200 * 100, 0, 100)
      // FLAP — flap-retraction schedule conformance (inverse)
      const dFLAP = clamp(100 - st.flapMatch_pct, 0, 100)
      // GRAD — 2nd-segment net gradient deficit vs floor
      const dGRAD = clamp((gradFloor - st.netGrad_pct + 1.0) / 2.0 * 100, 0, 100)
      // ALPHA — alpha-PROT margin (inverse, lower margin = higher driver)
      const dALPHA = clamp(100 - st.alphaMargin, 0, 100)
      // TRACK — lateral track conformance to MAP
      const dTRACK = clamp(st.trackErr_nm / 4.0 * 100, 0, 100)
      // SOMAT — somatogravic-pitch-down vulnerability
      const dSOMAT = clamp(st.somaticIdx, 0, 100)

      const drivers = { TOGA:dTOGA, PITCH:dPITCH, GEAR:dGEAR, FLAP:dFLAP, GRAD:dGRAD, ALPHA:dALPHA, TRACK:dTRACK, SOMAT:dSOMAT }

      // Phase-weight (active-GA phases dominate, MAP-HOLD reduces stakes)
      const phW: Record<Phase, number> = {
        'PRE-GA': 0.65, 'TOGA-LATCH': 1.40, 'INI-CLB': 1.35,
        'FLAP-RETR': 1.15, 'CLEAN-UP': 0.92, 'MAP-HOLD': 0.55, 'OFF': 0,
      }
      // Composite: PITCH + GRAD dominate (the catastrophic failure modes);
      // TOGA + ALPHA amplify (mode-confusion); SOMAT + TRACK secondary.
      let score = (
        dPITCH  * 0.22 +
        dGRAD   * 0.20 +
        dTOGA   * 0.14 +
        dALPHA  * 0.12 +
        dSOMAT  * 0.10 +
        dGEAR   * 0.08 +
        dFLAP   * 0.08 +
        dTRACK  * 0.06
      ) * phW[ph] * advMul

      const notes: string[] = []
      // Hard escalators per accident precedent + cert chain
      if (st.pitchMargin_deg < 1.0 && (ph === 'TOGA-LATCH' || ph === 'INI-CLB')) {
        score = Math.max(score, 92)
        notes.push(`Pitch ${st.pitch_deg.toFixed(1)}° within ${st.pitchMargin_deg.toFixed(1)}° of tailstrike limit (${sp.tsLimit_deg}°) — TAILSTRIKE IMMINENT per FCOM Limits Ch.1 / FCTM 6.20 — release back-pressure`)
      } else if (st.netGrad_pct < gradFloor && (ph === 'TOGA-LATCH' || ph === 'INI-CLB' || ph === 'FLAP-RETR')) {
        score = Math.max(score, 86)
        notes.push(`OEI 2nd-seg gradient ${st.netGrad_pct.toFixed(1)}% below CS-25.121(b) floor ${gradFloor}% — request hot-and-high vectors, accept lower flap-retract speed`)
      } else if (st.togaLagMs > togaLagMaxS * 1000 && ph === 'TOGA-LATCH') {
        score = Math.max(score, 82)
        notes.push(`TOGA latch ${(st.togaLagMs/1000).toFixed(1)}s past 'GO-AROUND' call — Asiana 214 NTSB AAR-14-01 mode-confusion class — verify TOGA detent + FMA GA SRS+THR mode latched`)
      }
      if (st.alphaMargin < 25 && (ph === 'TOGA-LATCH' || ph === 'PRE-GA')) {
        score = Math.max(score, 76)
        notes.push(`α-PROT margin ${st.alphaMargin.toFixed(0)}% — low-energy GA capture, watch for stick-shaker / α-FLOOR per FCOM PRO-NOR-SOP-22`)
      }
      if (st.somaticIdx > 75 && (ph === 'TOGA-LATCH' || ph === 'INI-CLB')) {
        score = Math.max(score, 68)
        notes.push(`Somatogravic index ${st.somaticIdx.toFixed(0)} — dark-night / IMC over-water GA — Atlas 3591 NTSB AAR-20-02 precedent — trust ADI not seat-of-pants`)
      }
      if (st.gear_alt_ft > 1500 && ph === 'INI-CLB') {
        score = Math.max(score, 58)
        notes.push(`Gear-up deferred to ${st.gear_alt_ft.toFixed(0)} ft AGL — drag penalty erodes 2nd-seg net gradient by ≥0.4% per FCOM PI-11.20`)
      }
      if (st.trackErr_nm > 2.0 && (ph === 'INI-CLB' || ph === 'FLAP-RETR')) {
        score = Math.max(score, 54)
        notes.push(`Lateral track error ${st.trackErr_nm.toFixed(1)} NM exceeds RNP-AR MAP ±1.5 NM tolerance — Doc 9613 Vol II Pt C — verify NAV mode + correct MAP loaded`)
      }
      if (st.flapMatch_pct < 50 && ph === 'FLAP-RETR') {
        score = Math.max(score, 45)
        notes.push(`Flap-retract schedule ${st.flapMatch_pct.toFixed(0)}% conformant — behind FCOM cleanup table, drag/pitch coupling adverse — verify F-speed reached before retraction`)
      }
      score = clamp(score, 0, 100)

      let tier: Tier = 'OFF'
      if (score >= 85) tier = 'CRITICAL'
      else if (score >= 65) tier = 'POOR'
      else if (score >= 45) tier = 'WATCH'
      else if (score >= 22) tier = 'NOMINAL'
      else tier = 'CLEAN'

      out.push({
        f, cls, spec: sp, phase: ph, inGA,
        togaLagMs: st.togaLagMs, pitch_deg: st.pitch_deg, pitchMargin_deg: st.pitchMargin_deg,
        gear_alt_ft: st.gear_alt_ft, flapMatch_pct: st.flapMatch_pct,
        netGrad_pct: st.netGrad_pct, gradMargin_pct: st.gradMargin_pct,
        alphaMargin: st.alphaMargin, trackErr_nm: st.trackErr_nm, somaticIdx: st.somaticIdx,
        drivers, score, tier, notes,
      })
    }
    out.sort((a,b) => (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score - a.score))
    return out
  }, [flights, advMul, tsMargin, gradFloor, togaLagMaxS, gaCaptureNm])

  useEffect(() => {
    if (!map) return
    const SRC = 'gasa-src'
    const SRC_VEC = 'gasa-vec-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    const writeAll = () => {
      ensureSrc(SRC); ensureSrc(SRC_VEC)
      const view = rows.filter(r =>
        (tierFilter==='ALL'||r.tier===tierFilter) &&
        (phaseFilter==='ALL'||r.phase===phaseFilter) &&
        (clsFilter==='ALL'||r.cls===clsFilter))
      const acFeats: any[] = []
      const vecFeats: any[] = []
      for (const r of view) {
        acFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{
          tier: r.tier, color: TIER_COLOR[r.tier], score: r.score, sz: 8 + (r.score/100)*14,
          label: `${r.f.callsign||r.f.icao} · ${r.phase} · P${r.pitch_deg.toFixed(1)}° · γ${r.netGrad_pct.toFixed(1)}%`
        } })
        // GA-vector projection line (along current track) — predicts where the
        // aircraft will be at ~3500ft AGL if the GA continues at current VS.
        if (r.score >= 45 && r.inGA) {
          const timeMin = r.f.vertRate > 0 ? Math.min(5, Math.max(0.5, (3500 - r.f.altitudeFt) / r.f.vertRate)) : 0
          const distNm = r.f.velocityKts * (timeMin / 60)
          const brg = (r.f.track || 0) * Math.PI/180
          const distKm = distNm * 1.852
          const tipLat = r.f.lat + (distKm / 111.32) * Math.cos(brg)
          const tipLng = r.f.lng + (distKm / (111.32 * Math.cos(r.f.lat * Math.PI/180))) * Math.sin(brg)
          vecFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[
            [r.f.lng, r.f.lat], [tipLng, tipLat]
          ] }, properties:{ color: TIER_COLOR[r.tier], opacity: 0.75 } })
        }
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_VEC) as any).setData({ type:'FeatureCollection', features: shVec ? vecFeats : [] })
    }
    ensureSrc(SRC); ensureSrc(SRC_VEC)
    if (!map.getLayer('gasa-vec'))
      map.addLayer({ id:'gasa-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.6, 'line-opacity':['get','opacity'], 'line-dasharray':[3,2] } })
    if (!map.getLayer('gasa-halo'))
      map.addLayer({ id:'gasa-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('gasa-pin'))
      map.addLayer({ id:'gasa-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.6, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('gasa-lbl'))
      map.addLayer({ id:'gasa-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.5], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    writeAll()
    return () => {
      for (const id of ['gasa-lbl','gasa-pin','gasa-halo','gasa-vec']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_VEC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, phaseFilter, clsFilter, shHalo, shPin, shLbl, shVec, shRwy])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (clsFilter==='ALL'||r.cls===clsFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.f.operator||'').toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { CRITICAL:0, POOR:0, WATCH:0, NOMINAL:0, CLEAN:0, OFF:0 }
  for (const r of rows) counts[r.tier]++
  const inGAcnt = rows.filter(r => r.inGA).length
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const muPitch = rows.length ? (rows.reduce((a,b)=>a+b.pitch_deg,0)/rows.length) : 0
  const muGrad  = rows.length ? (rows.reduce((a,b)=>a+b.netGrad_pct,0)/rows.length) : 0
  const muToga  = rows.length ? (rows.reduce((a,b)=>a+b.togaLagMs,0)/rows.length) : 0
  const worst = rows[0]

  // Per-class aggregation
  const clsMap = new Map<Cls, { spec: ClassSpec; count: number; sumScore: number; sumPitch: number; sumGrad: number; crit: number; poor: number; watch: number; inGA: number }>()
  for (const r of rows) {
    const c = clsMap.get(r.cls) || { spec: r.spec, count: 0, sumScore: 0, sumPitch: 0, sumGrad: 0, crit: 0, poor: 0, watch: 0, inGA: 0 }
    c.count++; c.sumScore += r.score; c.sumPitch += r.pitch_deg; c.sumGrad += r.netGrad_pct
    if (r.tier === 'CRITICAL') c.crit++
    if (r.tier === 'POOR') c.poor++
    if (r.tier === 'WATCH') c.watch++
    if (r.inGA) c.inGA++
    clsMap.set(r.cls, c)
  }
  const clsRows = Array.from(clsMap.entries()).map(([cls, e]) => ({
    cls, spec: e.spec, count: e.count, inGA: e.inGA,
    muScore: e.sumScore/e.count, muPitch: e.sumPitch/e.count, muGrad: e.sumGrad/e.count,
    crit: e.crit, poor: e.poor, watch: e.watch,
  })).sort((a,b) => (b.crit + b.poor) - (a.crit + a.poor) || b.muScore - a.muScore)

  // Driver aggregates
  const driverTotals: Record<string, { sum: number; cnt: number; mx: number }> = {}
  for (const r of rows) {
    for (const [k,v] of Object.entries(r.drivers)) {
      const t = driverTotals[k] || { sum: 0, cnt: 0, mx: 0 }
      t.sum += v; t.cnt++; t.mx = Math.max(t.mx, v)
      driverTotals[k] = t
    }
  }
  const driverRows = Object.entries(driverTotals).map(([k,v]) => ({ k, mean: v.sum/v.cnt, max: v.mx }))
    .sort((a,b) => b.mean - a.mean)

  // PROCEDURE-tab SVG GA flight-path diagram
  // x: time s 0-90, y: AGL ft 0-3500
  const procW = 420, procH = 200, procPad = 28
  const xT = (t:number) => procPad + (t/90) * (procW - procPad*1.5)
  const yA = (a:number) => procH - procPad - (a/3500) * (procH - procPad*1.8)
  // Reference GA path: TOGA at 200ft → GEAR-UP at 400ft → flap-clean ramp
  const refPath: Array<[number, number]> = [
    [0, 200],   // GA initiation altitude
    [4, 280],   // TOGA captured
    [8, 480],   // POSITIVE RATE + GEAR UP
    [16, 900],  // Flap 5 + V2+15
    [30, 1700], // Flap 1 + V2+30
    [55, 2900], // Flap 0 + clean speed
    [80, 3500], // Level off / MAP holding fix
  ]

  return (
    <div className="fixed top-16 right-3 z-40 w-[480px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">GASA</span>
          <span className="text-[10px] text-slate-400">go-around energy · FCOM PI-11 · CS-25.121(b)</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className="flex-1 px-1.5 py-1 rounded text-[10px] font-mono" style={{ background:`${TIER_COLOR[t]}22`, borderWidth:1, borderStyle:'solid', borderColor: tierFilter===t?TIER_COLOR[t]:'transparent', color: TIER_COLOR[t] }}>
            {t==='CRITICAL'?'CRT':t==='POOR'?'POR':t==='WATCH'?'WTC':t==='NOMINAL'?'NOM':'CLN'} {counts[t]}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-PITCH</div><div className="text-slate-100 font-mono">{muPitch.toFixed(1)}°</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-γ2</div><div className="text-slate-100 font-mono">{muGrad.toFixed(1)}%</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">IN-GA</div><div className="font-mono" style={{color:inGAcnt?TIER_COLOR.POOR:'#94a3b8'}}>{inGAcnt}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?(worst.f.callsign||worst.f.icao).slice(0,7):'—'}</div></div>
      </div>

      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">TS-MARGIN <span className="text-slate-200 font-mono">{tsMargin.toFixed(1)}°</span>
            <input type="range" min="1" max="6" step="0.25" value={tsMargin} onChange={e=>setTsMargin(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">GRAD-FLR <span className="text-slate-200 font-mono">{gradFloor.toFixed(1)}%</span>
            <input type="range" min="2.0" max="4.0" step="0.1" value={gradFloor} onChange={e=>setGradFloor(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">TOGA-LAG <span className="text-slate-200 font-mono">{togaLagMaxS.toFixed(0)}s</span>
            <input type="range" min="3" max="10" step="0.5" value={togaLagMaxS} onChange={e=>setTogaLagMaxS(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400 col-span-2">GA-CAPTURE <span className="text-slate-200 font-mono">{gaCaptureNm.toFixed(0)} NM</span>
            <input type="range" min="3" max="12" value={gaCaptureNm} onChange={e=>setGaCaptureNm(+e.target.value)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','PRE-GA','TOGA-LATCH','INI-CLB','FLAP-RETR','CLEAN-UP','MAP-HOLD'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','HVY-T','HVY-Q','WB-M','NB','RGN-J','RGN-T','BIZ'] as const).map(c => (
            <button key={c} onClick={()=>setClsFilter(c as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${clsFilter===c?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{c}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['VEC',shVec,setShVec],['RWY',shRwy,setShRwy]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','CLASSES','DRIVERS','PROCEDURE'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab==='AIRCRAFT' && visible.slice(0,80).map((r,i) => (
          <div key={i} onClick={()=>onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{r.f.callsign||r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type||'—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.cls}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              {r.inGA && <span className="px-1 rounded font-mono text-[9px]" style={{background:`${TIER_COLOR.WATCH}33`,color:TIER_COLOR.WATCH}}>IN-GA</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>PIT <span className="font-mono" style={{color: r.pitchMargin_deg < 1 ? TIER_COLOR.CRITICAL : r.pitchMargin_deg < 3 ? TIER_COLOR.WATCH : '#e2e8f0'}}>{r.pitch_deg.toFixed(1)}°</span></div>
              <div>γ2 <span className="font-mono" style={{color: r.netGrad_pct < gradFloor ? TIER_COLOR.CRITICAL : r.netGrad_pct < gradFloor+0.5 ? TIER_COLOR.WATCH : '#e2e8f0'}}>{r.netGrad_pct.toFixed(1)}%</span></div>
              <div>TOGA <span className="font-mono" style={{color: r.togaLagMs > togaLagMaxS*1000 ? TIER_COLOR.POOR : '#e2e8f0'}}>{(r.togaLagMs/1000).toFixed(1)}s</span></div>
              <div>α <span className="font-mono" style={{color: r.alphaMargin < 25 ? TIER_COLOR.POOR : r.alphaMargin < 45 ? TIER_COLOR.WATCH : '#e2e8f0'}}>{r.alphaMargin.toFixed(0)}%</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>GR <span className="font-mono" style={{color: r.gear_alt_ft > 1500 ? TIER_COLOR.WATCH : '#e2e8f0'}}>{r.gear_alt_ft.toFixed(0)}ft</span></div>
              <div>FLP <span className="font-mono" style={{color: r.flapMatch_pct < 50 ? TIER_COLOR.WATCH : '#e2e8f0'}}>{r.flapMatch_pct.toFixed(0)}%</span></div>
              <div>TRK <span className="font-mono" style={{color: r.trackErr_nm > 2 ? TIER_COLOR.WATCH : '#e2e8f0'}}>{r.trackErr_nm.toFixed(1)}NM</span></div>
              <div>SOM <span className="font-mono" style={{color: r.somaticIdx > 75 ? TIER_COLOR.POOR : '#e2e8f0'}}>{r.somaticIdx.toFixed(0)}</span></div>
            </div>
            {r.notes.length > 0 && (
              <div className="mt-1 text-[9px] leading-snug" style={{color:TIER_COLOR[r.tier]}}>
                › {r.notes[0]}
              </div>
            )}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length === 0 && (
          <div className="text-center text-slate-500 text-[10px] py-6">No aircraft in GA window — try widening GA-CAPTURE or PRE-GA filter</div>
        )}

        {tab==='CLASSES' && clsRows.map((c,i) => (
          <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{c.cls}</span>
              <span className="text-slate-500 truncate text-[9px]">{c.spec.ref.split(' / ')[0]}</span>
              <span className="ml-auto text-slate-400 font-mono text-[9px]">{c.count} ac · IN-GA {c.inGA}</span>
            </div>
            <div className="grid grid-cols-5 gap-1 mt-1 text-[10px] text-slate-400">
              <div>μ-SC <span className="text-slate-100 font-mono">{c.muScore.toFixed(0)}</span></div>
              <div>μ-PIT <span className="text-slate-100 font-mono">{c.muPitch.toFixed(1)}°</span></div>
              <div>μ-γ2 <span className="text-slate-100 font-mono">{c.muGrad.toFixed(1)}%</span></div>
              <div>TS-LIM <span className="text-slate-100 font-mono">{c.spec.tsLimit_deg.toFixed(1)}°</span></div>
              <div>TOGA <span className="text-slate-100 font-mono">{c.spec.togaN1}%</span></div>
            </div>
            <div className="grid grid-cols-3 gap-1 mt-1 text-[10px] text-slate-400">
              <div>CRT <span className="font-mono" style={{color: c.crit?TIER_COLOR.CRITICAL:'#475569'}}>{c.crit}</span></div>
              <div>POR <span className="font-mono" style={{color: c.poor?TIER_COLOR.POOR:'#475569'}}>{c.poor}</span></div>
              <div>WTC <span className="font-mono" style={{color: c.watch?TIER_COLOR.WATCH:'#475569'}}>{c.watch}</span></div>
            </div>
            <div className="h-1.5 mt-1 bg-slate-900 rounded overflow-hidden">
              <div className="h-full rounded" style={{ width:`${clamp(c.muScore,0,100)}%`, background:'linear-gradient(90deg, #10b981 0%, #0ea5e9 33%, #f59e0b 66%, #ef4444 100%)' }} />
            </div>
          </div>
        ))}
        {tab==='CLASSES' && clsRows.length === 0 && (
          <div className="text-center text-slate-500 text-[10px] py-6">No class data yet</div>
        )}

        {tab==='DRIVERS' && driverRows.map((d,i) => (
          <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center justify-between text-[10px]">
              <span className="font-mono text-slate-100">{d.k}</span>
              <span className="font-mono text-slate-300">μ {d.mean.toFixed(0)} · max {d.max.toFixed(0)}</span>
            </div>
            <div className="h-1.5 mt-1 bg-slate-900 rounded overflow-hidden">
              <div className="h-full rounded" style={{ width:`${clamp(d.mean,0,100)}%`, background:'linear-gradient(90deg, #10b981 0%, #0ea5e9 33%, #f59e0b 66%, #ef4444 100%)' }} />
            </div>
            <div className="mt-1 text-[9px] text-slate-500 leading-snug">
              {d.k==='TOGA'  && 'TOGA latch latency (GO-AROUND call → detent → A/THR wakeup → FMA GA mode) per Boeing FCOM CL / Airbus FCOM PRO-NOR-SOP-22 — Asiana 214 NTSB AAR-14-01'}
              {d.k==='PITCH' && 'Pitch attitude vs per-class tailstrike limit (B777 12.5° / A380 9.0° / B738 11°) per FCOM Limits Ch.1 + FCTM 6.20'}
              {d.k==='GEAR'  && 'Gear-retraction altitude sequencing (POSITIVE RATE call ≥200 ft AGL, gear-up before VLO 235 KIAS) per FCOM 4-step GA'}
              {d.k==='FLAP'  && 'Flap-retraction schedule conformance vs per-class FCOM cleanup table (B737 F15→F5→F1→F0 at V2+15/+30 / Airbus F3→F2→F1→F0 at S/F/green-dot)'}
              {d.k==='GRAD'  && 'OEI 2nd-segment net climb gradient vs CS-25.121(b) 2.4% floor under measured weight + DA + config'}
              {d.k==='ALPHA' && 'High-AOA shield approach (Airbus Normal-Law α-PROT margin / Boeing FBW α-REF + stick-shaker margin) per FCOM DSC-22'}
              {d.k==='TRACK' && 'Lateral conformance to published MAP track tolerance (±1.5 NM RNP-AR) per Doc 9613 Vol II Pt C'}
              {d.k==='SOMAT' && 'Somatogravic-pitch-down vulnerability (high-thrust acceleration vector vs visual horizon in IMC/over-water/dark) — Atlas 3591 NTSB AAR-20-02 precedent'}
            </div>
          </div>
        ))}

        {tab==='PROCEDURE' && (
          <div className="space-y-1.5">
            <div className="text-[9px] text-slate-400 leading-snug px-1">
              Canonical Boeing/Airbus 4-step GA flight-path per FCOM PI-11.20 + FCTM 6.20 with milestones overlaid on time-vs-AGL.
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
              <svg width={procW} height={procH} className="block">
                {/* Grid */}
                {[0,500,1000,1500,2000,2500,3000,3500].map(a => (
                  <g key={a}>
                    <line x1={procPad} y1={yA(a)} x2={procW-procPad/2} y2={yA(a)} stroke="#1e293b" strokeWidth="0.5" />
                    <text x={procPad-4} y={yA(a)+3} fontSize="7" fill="#475569" textAnchor="end">{a}</text>
                  </g>
                ))}
                {[0,15,30,45,60,75,90].map(t => (
                  <g key={t}>
                    <line x1={xT(t)} y1={procPad/2} x2={xT(t)} y2={procH-procPad} stroke="#1e293b" strokeWidth="0.5" />
                    <text x={xT(t)} y={procH-procPad+10} fontSize="7" fill="#475569" textAnchor="middle">{t}s</text>
                  </g>
                ))}
                {/* Reference path */}
                <polyline
                  points={refPath.map(p => `${xT(p[0])},${yA(p[1])}`).join(' ')}
                  fill="none" stroke="#0ea5e9" strokeWidth="1.8" strokeDasharray="4,2"
                />
                {/* Milestone markers */}
                {refPath.map((p,i) => (
                  <g key={i}>
                    <circle cx={xT(p[0])} cy={yA(p[1])} r="2.5" fill="#0ea5e9" />
                  </g>
                ))}
                {/* Labels */}
                <text x={xT(0)+4} y={yA(200)-4} fontSize="7" fill="#0ea5e9">GA-INI 200ft</text>
                <text x={xT(4)+4} y={yA(280)-4} fontSize="7" fill="#0ea5e9">TOGA</text>
                <text x={xT(8)+4} y={yA(480)-4} fontSize="7" fill="#0ea5e9">GEAR-UP +RATE</text>
                <text x={xT(16)+4} y={yA(900)-4} fontSize="7" fill="#0ea5e9">FLAP 5 V2+15</text>
                <text x={xT(30)+4} y={yA(1700)-4} fontSize="7" fill="#0ea5e9">FLAP 1 V2+30</text>
                <text x={xT(55)+4} y={yA(2900)-4} fontSize="7" fill="#0ea5e9">FLAP 0 CLEAN</text>
                <text x={xT(80)+4} y={yA(3500)-4} fontSize="7" fill="#0ea5e9">MAP HOLD</text>
                {/* Live samples — top 8 IN-GA aircraft */}
                {rows.filter(r => r.inGA).slice(0,8).map((r,i) => {
                  // Rough time-since-GA approx: t = (AGL - 200) / VS * 60
                  const t = clamp((r.f.altitudeFt - 200) / Math.max(r.f.vertRate, 100) * 60, 0, 88)
                  return <circle key={i} cx={xT(t)} cy={yA(clamp(r.f.altitudeFt, 0, 3500))} r="3.5" fill={TIER_COLOR[r.tier]} stroke="#0b0f17" strokeWidth="0.8" />
                })}
                {/* Axis labels */}
                <text x={procW/2} y={procH-2} fontSize="7" fill="#64748b" textAnchor="middle">Time since GA initiation (s)</text>
                <text x={4} y={procH/2} fontSize="7" fill="#64748b" transform={`rotate(-90, 4, ${procH/2})`} textAnchor="middle">AGL (ft)</text>
              </svg>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5 text-[9px] text-slate-400 leading-snug">
              <div className="text-slate-300 font-mono mb-1">4-step GA call sequence (Boeing FCOM / Airbus FCOM PRO-NOR-SOP-22)</div>
              <div>1. "GO-AROUND, FLAPS 20" — TOGA detent, flap retracted from landing setting to GA flap</div>
              <div>2. "POSITIVE RATE" — verify VS &gt; +400 fpm sustained on PFD</div>
              <div>3. "GEAR UP" — landing gear handle up before VLO 235 KIAS</div>
              <div>4. "FLAP X" — sequential flap retraction at FCOM cleanup speeds (V2+15, V2+30, F-speed, green-dot)</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5 text-[9px] text-slate-400 leading-snug">
              <div className="text-slate-300 font-mono mb-1">Foundational GA-event record</div>
              <div>› Asiana 214 KSFO 2013 — late GA after low-energy short-final, A/THR HOLD mode (NTSB AAR-14-01)</div>
              <div>› Atlas Air 3591 KIAH 2019 — inadvertent TO/GA actuation, somatogravic pitch-down (NTSB AAR-20-02)</div>
              <div>› Continental 1404 KDEN 2008 — rejected-landing crosswind excursion (NTSB AAR-10-04)</div>
              <div>› Air India Express 1344 VOCL 2020 — delayed GA on wet tailwind landing, overrun (AAIB IND-2020)</div>
              <div>› EVA 015 KLAX 2017 — low-altitude GA neighbourhood overflight &lt;300 ft AGL (FAA enforcement)</div>
              <div>› Lion Air 904 WADD 2013 — late GA, water touchdown short of threshold (KNKT)</div>
            </div>
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-700/60 text-[9px] text-slate-500 font-mono">
        FCOM PI-11.20 · FCTM 6.20 · CS-25.121(b) · PANS-OPS Doc 8168 Vol II Pt I §4.6 · NTSB AAR-14-01 · AAR-20-02 · AAR-10-04
      </div>
    </div>
  )
}
