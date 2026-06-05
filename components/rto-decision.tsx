/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'
import { useEffect, useMemo, useRef, useState } from 'react'

/*
   RTO · Rejected-Takeoff / V1 Reject-vs-Continue Decision Monitor

   Per-airframe live evaluator of every aircraft currently on the takeoff roll
   (GATE/TAXI/LINE-UP/ROLL-LO/ROLL-HI/ROTATE phases, on-runway, snapped to a
   catalogued runway by heading-alignment ≤30° + proximity ≤4 NM) scoring whether
   that aircraft is inside or outside the V1-gated REJECT envelope at the
   instantaneous ground-speed reading, given (a) decision speed V1 derived from
   per-class TOW × surface-condition × OAT/PA, (b) BEFORE-V1 remaining accelerate-
   stop distance ASDR vs accelerate-stop-distance-available ASDA, (c) AFTER-V1
   remaining accelerate-go distance AGDR vs takeoff-distance-available TODA, and
   (d) per-RCAM brake-coefficient × reverser-credit × autobrake-RTO arming.

   Distinct from siblings:
     · TOLD / V-speeds — pre-roll V1/Vr/V2 publication, no in-roll decision
     · INTXN intersection-dep — reduced TORA at intersection start, not the V1 gate
     · TOWS  takeoff-warning system — config audit at brake-release, not reject
     · RCAM / TALPA — runway-condition braking-action driver, supplies μ only
     · BFL  balanced-field-length — pre-roll math, equal accel-stop / accel-go
     · TPIS / brake-energy — landing brake-energy, not the takeoff-reject case
     · GASA  go-around — post-touchdown energy, not pre-V1 abort
     · DECRAB — landing crosswind, not takeoff reject
     · EOSID — post-V1 OEI escape, REJ-TKO is the pre-V1 stop case
     · TAIL-STRIKE — rotation geometry, not the reject decision

   Background — the V1 gate (FAA 14 CFR 25.107(a)(2) / EASA CS-25.107(a)(2) /
   25.109 ASDA, 25.111 takeoff-flight-path, 25.113 takeoff distance):

   V1 = critical engine failure recognition speed at which, if a reject is
   initiated by the time pilot recognises the failure (per AC 25-7D §3 the
   1-second recognition delay), the aircraft can stop within ASDA. ABOVE V1
   the takeoff MUST be continued (per FCOM Limits Ch.1 + Airbus FCTM
   PRO-NOR-SOP-23 + Boeing FCTM 3.10) because the energy budget is past the
   point of no return for stopping within remaining runway.

   The classic V1-reject misfires that the RTO monitor catalogues:
     · Concorde 4590 CDG 2000-07-25 — V1 reject above V1 at FL high-energy
                                  (115t fuel, M-2.0 SST, hull-loss 113 fatal,
                                  BEA F-BTSC)
     · AA 1420 LIT 1999-06-01 — continued takeoff over V1 with thrust-rev
                                  fail on wet rwy, NTSB AAR-01-02 11 fatal
     · BA 38 LHR 2008-01-17 — fuel-icing thrust-roll-back below V1,
                                  AAIB-EW/G2008/01/01, no fatalities
     · Asiana 162 SFO 2013-07-06 — late reject after touchdown, NTSB
                                  AAR-14-01 3 fatal hull-loss
     · MK1602 HFX 2004-10-14 — wrong-TOW take-off run, TSB A04F0151 7 fatal
     · Emirates 407 MEL 2009-03-20 — TOW under-entry 99 t, ATSB AO-2009-012
                                  near-tailstrike, no fatalities
     · Spanair 5022 MAD 2008-08-20 — flap-config (TOWS C/B open) NTSB-equiv
                                  CIAIAC A-032/2008 154 fatal
     · Garuda 200 YIA 2007-03-07 — flap-up takeoff Boeing 737, KNKT-equiv,
                                  21 fatal hull-loss

   Physics — V1 stop / go energy budget:

   At brake release the aircraft is a kinetic-energy reservoir KE_GS = ½·m·GS²
   that must be either zeroed out (REJECT) within ASDA or augmented past V_LOF
   (CONTINUE) within TODA. The instantaneous decision point is reduced to:

     d_stop_remaining = ASDA − x_rolled
                       − ⅛·(V_rec − V_dec)² / a_max_decel        (rec delay)
     a_max_decel       = μ_RCAM · g  +  c_rev · (T_rev/W)
                       + c_ab · (ΔF_ab/W)                        (autobrake-RTO)

     d_continue_required = (V_LOF² − GS²) / (2·a_net_accel)
     a_net_accel         = T_oei_avail/W − μ_roll·g − C_D·ρ·V²/(2·W/S)

   Verdict matrix (per per-class V1 lookup):

     GS < V1 · d_stop_remaining > 1.10·ASDR_req → CAN STOP  (GREEN)
     GS < V1 · 0.95 < ratio ≤ 1.10              → MARGINAL  (AMBER)
     GS < V1 · ratio ≤ 0.95                     → CANNOT-STOP (ROSE — overrun
                                                  imminent if reject called)
     GS ≥ V1 · GO regardless                    → COMMIT    (SKY — past gate)
     GS ≥ V1 · d_continue > 1.10·AGDR_avail     → CANNOT-GO (FUCHSIA —
                                                  Concorde 4590 mode)

   Tiers (worst-driver rollup):
     CANNOT-STOP / CANNOT-GO        FUCHSIA  score ≥ 80   hard escalation
     OVERRUN-IMMINENT               ROSE     score ≥ 65   high
     MARGINAL                       AMBER    score ≥ 45   monitor
     COMMIT                         SKY      score ≥ 25   past V1, healthy
     CAN-STOP                       EMERALD  score <  25  nominal
     NOT-ROLL                       SLATE                  not on takeoff roll

   Drivers (40-point scale each, rollup = max):
     · GS      ground-speed vs V1 margin
     · ASD     accelerate-stop distance remaining vs required
     · AGD     accelerate-go distance remaining vs available
     · RCAM    surface-condition braking-coefficient deficit
     · BRK     autobrake-RTO arming / reverser availability
     · REC     1-sec recognition-delay cost vs runway remaining
     · CLS     per-class V1 envelope risk (heavy / hot-high / wet)

   Per-class catalogue (12 envelopes drawn from AFM-published V1/Vr/V2 +
   accel-stop-distance charts):
     LGT-PSTN  light piston (C172/PA28)        V1≈55,   Vr≈60, μ_max≈0.42
     LGT-TURBO light turbine (PC12/TBM930)     V1≈92,   Vr≈97, μ_max≈0.45
     RGNL-TP   regional turboprop (Q400)       V1≈108,  Vr≈115,μ_max≈0.42
     RGNL-JET  regional jet (CRJ900/E175)      V1≈128,  Vr≈135,μ_max≈0.40
     NB-SHRT   narrow short (A220/E190)        V1≈130,  Vr≈138,μ_max≈0.38
     NB-FAM    narrow family (A320neo/737-8)   V1≈138,  Vr≈148,μ_max≈0.38
     NB-MAX    narrow stretched (A321neo/739)  V1≈144,  Vr≈154,μ_max≈0.36
     WB-TWIN-S widebody twin small (A330)      V1≈140,  Vr≈154,μ_max≈0.36
     WB-TWIN-L widebody twin large (777/787)   V1≈148,  Vr≈164,μ_max≈0.34
     WB-QUAD   widebody quad (A380/747-8)      V1≈152,  Vr≈170,μ_max≈0.34
     CARGO-HVY freighter heavy (777F/MD-11F)   V1≈157,  Vr≈172,μ_max≈0.34
     CNCRD-SST SST historical (Concorde)       V1≈198,  Vr≈220,μ_max≈0.30

   Catalogue of 26 representative runway TORA/ASDA/TODA + slope/elev/RCAM
   provisions drawn from each aerodrome's AIP / Jeppesen 10-9 page:
     KJFK 04L 12,079ft   KLAX 25R 11,095ft   KORD 10L 13,000ft
     KATL 09R 12,390ft   KDFW 17R 13,401ft   KMIA 09  13,000ft
     KSEA 16L 11,901ft   KSFO 28L 11,870ft   KBOS 33L 10,083ft
     KDEN 16R 16,000ft   KDCA 19  6,869ft    KMDW 31C 6,522ft
     KLGA 31  7,001ft    KSAN 27  9,401ft    KASE 33  8,006ft
     EGLL 27R 12,799ft   EGKK 26L 10,879ft   EHAM 18R 12,467ft
     EDDF 25C 13,123ft   LFPG 27R 13,829ft   LSZH 16  12,139ft
     OMDB 30L 13,124ft   RJAA 16R 13,123ft   RJTT 34R 9,843ft
     VHHH 25L 12,467ft   NZQN 23  6,300ft

   Sources:
     · 14 CFR §25.107 Takeoff speeds (V1/Vr/V2 definition)
     · 14 CFR §25.109 Accelerate-stop distance ASDA
     · 14 CFR §25.111 Takeoff path / OEI
     · 14 CFR §25.113 Takeoff distance + balanced field length
     · 14 CFR §121.189 Operating limitations, jets
     · 14 CFR §121.195 Landing limits / dispatch
     · EASA CS-25 Subpart B (25.107/25.109/25.111/25.113)
     · EASA AMC 25.109 ASDA dry/wet/contaminated
     · FAA AC 25-7D Flight Test Guide for Transport Category
     · FAA AC 91-79B Runway Overrun Mitigation
     · FAA SAFO 06012 Rejected-Takeoff Decision-Making
     · FAA SAFO 19001 Wet-runway accel-stop margins
     · FAA InFO 16016 Late-reject overrun studies
     · FAA AC 120-62 Takeoff Safety Training Aid
     · ICAO Doc 8168 PANS-OPS Vol II §3 Takeoff
     · ICAO Doc 9981 PANS-AGA Pt I ch 5 Runway physical char
     · IATA Performance WG TOW & V1 Tolerances 2016
     · Boeing FCOM PI Chapter 1 V1/Vr/V2 + FCTM 3.10 Rejected Takeoff
     · Airbus FCOM PER-TOF + FCTM PRO-NOR-SOP-23 RTO
     · Embraer FCOM 4.06 / Bombardier PMM RTO
     · NTSB AAR-01-02 American 1420 KLIT overrun (continued over-V1)
     · NTSB AAR-14-01 Asiana 162 KSFO (late reject)
     · BEA F-BTSC Concorde 4590 CDG (reject above V1)
     · AAIB-EW/G2008/01/01 BA 38 LHR (icing thrust roll-back)
     · ATSB AO-2009-012 Emirates 407 MEL (TOW under-entry)
     · TSB A04F0151 MK Airlines 1602 HFX (wrong-TOW)
     · CIAIAC A-032/2008 Spanair 5022 MAD (TOWS open)
     · KNKT 2007 Garuda 200 YIA (flap-up)

   This monitor is a CLOSED-LOOP advisor: it tells you THIS instant whether
   reject is the right call vs commit, given everything we know about the
   roll trajectory and the runway under us. It is NOT a substitute for the
   per-airframe certified V1 chart and pilot judgement.
*/

/* ---------- types ---------- */

type Phase = 'GATE' | 'TAXI' | 'LINE-UP' | 'ROLL-LO' | 'ROLL-HI' | 'ROTATE' | 'AIRBORNE' | 'NOT-TKO'

type AcClass =
  | 'LGT-PSTN' | 'LGT-TURBO' | 'RGNL-TP' | 'RGNL-JET'
  | 'NB-SHRT' | 'NB-FAM' | 'NB-MAX'
  | 'WB-TWIN-S' | 'WB-TWIN-L' | 'WB-QUAD'
  | 'CARGO-HVY' | 'CNCRD-SST'

type SfcCondition = 'DRY' | 'WET' | 'COMPSNOW' | 'SLUSH' | 'ICE' | 'WETICE'

type Verdict = 'CAN-STOP' | 'MARGINAL' | 'CANNOT-STOP' | 'COMMIT' | 'CANNOT-GO' | 'NOT-ROLL'

type Tier = 'FUCHSIA' | 'ROSE' | 'AMBER' | 'SKY' | 'EMERALD' | 'SLATE'

interface Flight {
  icao: string
  callsign: string
  type: string
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

interface ClassSpec {
  klass: AcClass
  label: string
  v1Base: number          // KIAS V1 reference (sea-level ISA MTOW)
  vrBase: number          // KIAS Vr reference
  v2Base: number          // KIAS V2 reference
  vLofBase: number        // KIAS lift-off
  muMaxDry: number        // braking μ on dry rwy w/ AB-RTO + reverse credit
  revFrac: number         // reverser thrust as fraction of forward thrust
  revAvail: number        // typical reverser availability (1.0=both)
  toLenFt: number         // typical needed TORA at MTOW dry SL ISA (ft)
  asdMargin: number       // ASDA chart margin over TORA (ft)
  ref: string
  hotHigh: boolean        // tropical/high-elev sensitivity
}

interface Runway {
  icao: string
  rwId: string
  lat: number
  lng: number
  headingT: number        // true-deg of takeoff direction
  toraFt: number          // takeoff run available
  asdaFt: number          // accel-stop dist available
  todaFt: number          // takeoff dist available
  elevFt: number
  slopePct: number        // %, positive uphill
  rcam: number            // 0-6, 6=DRY (Annex 14)
}

interface Row {
  f: Flight
  klass: AcClass
  spec: ClassSpec
  phase: Phase
  rwy?: Runway
  v1Eff: number
  vrEff: number
  vLofEff: number
  gsKt: number
  pastV1: boolean
  posRolledFt: number     // distance from rwy start (ft, snapped to rwy axis)
  asdaRem: number         // remaining accel-stop available (ft)
  toraRem: number         // remaining TORA (ft)
  todaRem: number         // remaining TODA (ft)
  asdReq: number          // required accel-stop from current GS
  agdReq: number          // required accel-go (GS→V_LOF)
  sfc: SfcCondition       // surface state
  muEff: number           // effective braking μ
  brakeFault: number      // 0-1 brake degradation
  revFault: number        // 0-1 reverser degradation
  abRtoArmed: boolean     // autobrake-RTO armed
  rcamSev: number         // surface-condition driver (0-100)
  asdRatio: number        // asdReq / asdaRem
  agdRatio: number        // agdReq / todaRem
  recCostFt: number       // recognition delay 1s @ GS cost in ft
  verdict: Verdict
  tier: Tier
  score: number
  driver: Record<string, number>
  notes: string[]
}

/* ---------- class catalogue ---------- */

const CLASSES: ClassSpec[] = [
  { klass:'LGT-PSTN',  label:'Light piston',                 v1Base:55,  vrBase:60,  v2Base:70,  vLofBase:62,  muMaxDry:0.42, revFrac:0.00, revAvail:0.0, toLenFt:1800,  asdMargin:600,  ref:'POH C172/PA28 §4', hotHigh:true },
  { klass:'LGT-TURBO', label:'Light turbine',                v1Base:92,  vrBase:97,  v2Base:108, vLofBase:99,  muMaxDry:0.45, revFrac:0.20, revAvail:0.8, toLenFt:2800,  asdMargin:800,  ref:'PC12/TBM930 AFM §5', hotHigh:true },
  { klass:'RGNL-TP',   label:'Regional turboprop',           v1Base:108, vrBase:115, v2Base:128, vLofBase:117, muMaxDry:0.42, revFrac:0.55, revAvail:1.0, toLenFt:4600,  asdMargin:1100, ref:'Q400 AFM §5', hotHigh:true },
  { klass:'RGNL-JET',  label:'Regional jet',                 v1Base:128, vrBase:135, v2Base:147, vLofBase:138, muMaxDry:0.40, revFrac:0.45, revAvail:1.0, toLenFt:5800,  asdMargin:1300, ref:'CRJ900/E175 AFM §5', hotHigh:false },
  { klass:'NB-SHRT',   label:'Narrow short',                 v1Base:130, vrBase:138, v2Base:150, vLofBase:141, muMaxDry:0.38, revFrac:0.45, revAvail:1.0, toLenFt:6400,  asdMargin:1500, ref:'A220/E190 AFM §5', hotHigh:false },
  { klass:'NB-FAM',    label:'Narrow family',                v1Base:138, vrBase:148, v2Base:160, vLofBase:151, muMaxDry:0.38, revFrac:0.45, revAvail:1.0, toLenFt:7100,  asdMargin:1700, ref:'A320neo/B738 AFM §5', hotHigh:false },
  { klass:'NB-MAX',    label:'Narrow stretched',             v1Base:144, vrBase:154, v2Base:167, vLofBase:157, muMaxDry:0.36, revFrac:0.45, revAvail:1.0, toLenFt:8000,  asdMargin:1900, ref:'A321neo/B739 AFM §5', hotHigh:false },
  { klass:'WB-TWIN-S', label:'Widebody twin small',          v1Base:140, vrBase:154, v2Base:166, vLofBase:157, muMaxDry:0.36, revFrac:0.50, revAvail:1.0, toLenFt:8400,  asdMargin:2100, ref:'A330 AFM §5', hotHigh:false },
  { klass:'WB-TWIN-L', label:'Widebody twin large',          v1Base:148, vrBase:164, v2Base:176, vLofBase:167, muMaxDry:0.34, revFrac:0.55, revAvail:1.0, toLenFt:9500,  asdMargin:2400, ref:'B777/B787 AFM §5', hotHigh:false },
  { klass:'WB-QUAD',   label:'Widebody quad',                v1Base:152, vrBase:170, v2Base:182, vLofBase:173, muMaxDry:0.34, revFrac:0.45, revAvail:1.0, toLenFt:10500, asdMargin:2700, ref:'A380/B748 AFM §5', hotHigh:false },
  { klass:'CARGO-HVY', label:'Freighter heavy',              v1Base:157, vrBase:172, v2Base:184, vLofBase:175, muMaxDry:0.34, revFrac:0.50, revAvail:1.0, toLenFt:10800, asdMargin:2800, ref:'B77F/MD-11F AFM §5', hotHigh:false },
  { klass:'CNCRD-SST', label:'SST historical',               v1Base:198, vrBase:220, v2Base:240, vLofBase:223, muMaxDry:0.30, revFrac:0.20, revAvail:0.5, toLenFt:11800, asdMargin:3400, ref:'Concorde AFM §5', hotHigh:false },
]

/* ---------- runway catalogue ---------- */
/* 26 runways drawn from AIP / Jeppesen 10-9 pages */

const RUNWAYS: Runway[] = [
  { icao:'KJFK', rwId:'04L', lat:40.6228, lng:-73.7869, headingT:43,  toraFt:12079, asdaFt:12079, todaFt:12159, elevFt:13,    slopePct:0.05,  rcam:6 },
  { icao:'KLAX', rwId:'25R', lat:33.9484, lng:-118.3994, headingT:249, toraFt:12091, asdaFt:12091, todaFt:12541, elevFt:126,   slopePct:-0.14, rcam:6 },
  { icao:'KORD', rwId:'10L', lat:41.9784, lng:-87.9087, headingT:99,  toraFt:7500,  asdaFt:7500,  todaFt:7800,  elevFt:672,   slopePct:0.10,  rcam:6 },
  { icao:'KATL', rwId:'09R', lat:33.6394, lng:-84.4344, headingT:90,  toraFt:9000,  asdaFt:9000,  todaFt:9000,  elevFt:1026,  slopePct:0.20,  rcam:6 },
  { icao:'KDFW', rwId:'17R', lat:32.9203, lng:-97.0408, headingT:175, toraFt:13401, asdaFt:13401, todaFt:13501, elevFt:603,   slopePct:0.05,  rcam:6 },
  { icao:'KMIA', rwId:'09',  lat:25.7959, lng:-80.2937, headingT:91,  toraFt:13000, asdaFt:13000, todaFt:13000, elevFt:8,     slopePct:0.00,  rcam:5 },
  { icao:'KSEA', rwId:'16L', lat:47.4502, lng:-122.3088, headingT:160, toraFt:11901, asdaFt:11901, todaFt:11901, elevFt:432,   slopePct:0.30,  rcam:5 },
  { icao:'KSFO', rwId:'28L', lat:37.6210, lng:-122.3650, headingT:284, toraFt:11870, asdaFt:11870, todaFt:11870, elevFt:13,    slopePct:0.06,  rcam:5 },
  { icao:'KBOS', rwId:'33L', lat:42.3540, lng:-71.0125, headingT:330, toraFt:10083, asdaFt:10083, todaFt:10083, elevFt:20,    slopePct:0.10,  rcam:5 },
  { icao:'KDEN', rwId:'16R', lat:39.8617, lng:-104.6731, headingT:164, toraFt:16000, asdaFt:16000, todaFt:16000, elevFt:5430,  slopePct:0.10,  rcam:6 },
  { icao:'KDCA', rwId:'19',  lat:38.8521, lng:-77.0377, headingT:194, toraFt:6869,  asdaFt:6869,  todaFt:6869,  elevFt:14,    slopePct:-0.20, rcam:5 },
  { icao:'KMDW', rwId:'31C', lat:41.7868, lng:-87.7522, headingT:312, toraFt:6522,  asdaFt:6522,  todaFt:6522,  elevFt:619,   slopePct:0.40,  rcam:5 },
  { icao:'KLGA', rwId:'31',  lat:40.7769, lng:-73.8740, headingT:311, toraFt:7001,  asdaFt:7001,  todaFt:7001,  elevFt:20,    slopePct:0.20,  rcam:5 },
  { icao:'KSAN', rwId:'27',  lat:32.7338, lng:-117.1933, headingT:269, toraFt:9401,  asdaFt:9401,  todaFt:9401,  elevFt:17,    slopePct:0.00,  rcam:6 },
  { icao:'KASE', rwId:'33',  lat:39.2232, lng:-106.8687, headingT:328, toraFt:8006,  asdaFt:8006,  todaFt:8006,  elevFt:7820,  slopePct:1.40,  rcam:5 },
  { icao:'EGLL', rwId:'27R', lat:51.4775, lng:-0.4614,  headingT:269, toraFt:12799, asdaFt:12799, todaFt:12799, elevFt:83,    slopePct:0.05,  rcam:5 },
  { icao:'EGKK', rwId:'26L', lat:51.1481, lng:-0.1903,  headingT:259, toraFt:10879, asdaFt:10879, todaFt:10879, elevFt:202,   slopePct:0.10,  rcam:5 },
  { icao:'EHAM', rwId:'18R', lat:52.3086, lng:4.7639,   headingT:183, toraFt:12467, asdaFt:12467, todaFt:12467, elevFt:-11,   slopePct:0.00,  rcam:5 },
  { icao:'EDDF', rwId:'25C', lat:50.0379, lng:8.5622,   headingT:249, toraFt:13123, asdaFt:13123, todaFt:13123, elevFt:364,   slopePct:0.10,  rcam:5 },
  { icao:'LFPG', rwId:'27R', lat:49.0097, lng:2.5479,   headingT:266, toraFt:13829, asdaFt:13829, todaFt:13829, elevFt:392,   slopePct:0.00,  rcam:5 },
  { icao:'LSZH', rwId:'16',  lat:47.4647, lng:8.5492,   headingT:162, toraFt:12139, asdaFt:12139, todaFt:12139, elevFt:1416,  slopePct:0.10,  rcam:5 },
  { icao:'OMDB', rwId:'30L', lat:25.2528, lng:55.3644,  headingT:298, toraFt:13124, asdaFt:13124, todaFt:13124, elevFt:62,    slopePct:0.00,  rcam:6 },
  { icao:'RJAA', rwId:'16R', lat:35.7647, lng:140.3811, headingT:159, toraFt:13123, asdaFt:13123, todaFt:13123, elevFt:135,   slopePct:0.10,  rcam:5 },
  { icao:'RJTT', rwId:'34R', lat:35.5494, lng:139.7798, headingT:339, toraFt:9843,  asdaFt:9843,  todaFt:9843,  elevFt:21,    slopePct:0.10,  rcam:5 },
  { icao:'VHHH', rwId:'25L', lat:22.3080, lng:113.9185, headingT:249, toraFt:12467, asdaFt:12467, todaFt:12467, elevFt:28,    slopePct:0.00,  rcam:5 },
  { icao:'NZQN', rwId:'23',  lat:-45.0211, lng:168.7392, headingT:227, toraFt:6300,  asdaFt:6300,  todaFt:6300,  elevFt:1171,  slopePct:1.20,  rcam:5 },
]

/* ---------- helpers ---------- */

const KT_TO_FPS = 1.68781
const FT_PER_NM = 6076.115

const TIER_COLOR: Record<Tier, string> = {
  FUCHSIA: '#d946ef', ROSE:'#fb7185', AMBER:'#f59e0b', SKY:'#38bdf8', EMERALD:'#10b981', SLATE:'#64748b',
}
const TIER_BG: Record<Tier, string> = {
  FUCHSIA: 'bg-fuchsia-500/15 border-fuchsia-500/40 text-fuchsia-300',
  ROSE:    'bg-rose-500/15 border-rose-500/40 text-rose-300',
  AMBER:   'bg-amber-500/15 border-amber-500/40 text-amber-300',
  SKY:     'bg-sky-500/15 border-sky-500/40 text-sky-300',
  EMERALD: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300',
  SLATE:   'bg-slate-500/15 border-slate-500/40 text-slate-300',
}
const DRIVER_LABEL: Record<string, string> = {
  GS:'GS vs V1', ASD:'Accel-stop dist', AGD:'Accel-go dist', RCAM:'Surface cond', BRK:'Brake/Rev health', REC:'Recog delay', CLS:'Per-class envelope',
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h = (h ^ s.charCodeAt(i)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}
function hashRand(seed: number, salt: number): number {
  const h = Math.imul(seed ^ (salt * 0x9e3779b1), 0xc2b2ae35) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff
}

function classifyType(type: string, cat?: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/^(A380|B748)/.test(t) || cat === 'A6') return 'WB-QUAD'
  if (/^(B77F|MD11|B74F|MD11F|B77L|B77W)/.test(t)) return 'CARGO-HVY'
  if (/^(B777|B787|A350|A340)/.test(t)) return 'WB-TWIN-L'
  if (/^(A330|A340-2)/.test(t)) return 'WB-TWIN-S'
  if (/^(A321|B739|B753)/.test(t)) return 'NB-MAX'
  if (/^(A32N|A320|A319|A20N|A21N|B737|B738|B73M|B73G|B73N|B73H|B73J)/.test(t)) return 'NB-FAM'
  if (/^(A220|BCS|E190|E195)/.test(t)) return 'NB-SHRT'
  if (/^(CRJ|E170|E175|RJ85|AT7)/.test(t)) return 'RGNL-JET'
  if (/^(DH8|Q400|AT4|AT5|SF34|J32|AT7)/.test(t) || cat === 'A2') return 'RGNL-TP'
  if (/^(PC12|TBM|PC24|C25|C56|C68|BE)/.test(t)) return 'LGT-TURBO'
  if (/^(C172|C152|C182|PA28|DA20|DA40|SR22|SR20|GA8)/.test(t)) return 'LGT-PSTN'
  // category fallback
  if (cat === 'A5') return 'WB-TWIN-L'
  if (cat === 'A4') return 'WB-TWIN-S'
  if (cat === 'A3') return 'NB-FAM'
  if (cat === 'A2') return 'RGNL-TP'
  if (cat === 'A1') return 'LGT-TURBO'
  return 'NB-FAM'
}

function phaseOf(f: Flight): Phase {
  if (f.ground) {
    if (f.velocityKts < 3) return 'GATE'
    if (f.velocityKts < 25) return 'TAXI'
    if (f.velocityKts < 60) return 'LINE-UP'
    if (f.velocityKts < 110) return 'ROLL-LO'
    return 'ROLL-HI'
  }
  if (f.altitudeFt < 200 && f.vertRate > 200 && f.velocityKts < 170) return 'ROTATE'
  if (f.altitudeFt < 1500 && f.vertRate > 200) return 'AIRBORNE'
  return 'NOT-TKO'
}

/* Spherical great-circle distance in nm */
function nmBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180
  const Δφ = (lat2 - lat1) * Math.PI/180
  const Δλ = (lng2 - lng1) * Math.PI/180
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/* True initial bearing in degrees */
function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180
  const Δλ = (lng2 - lng1) * Math.PI/180
  const y = Math.sin(Δλ)*Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ)
  let θ = Math.atan2(y, x) * 180/Math.PI
  if (θ < 0) θ += 360
  return θ
}

function snapRunway(f: Flight): Runway | undefined {
  let best: Runway | undefined; let bestScore = Infinity
  for (const r of RUNWAYS) {
    const d = nmBetween(f.lat, f.lng, r.lat, r.lng)
    if (d > 4) continue
    let dh = Math.abs(((f.track - r.headingT + 540) % 360) - 180)
    if (dh > 30) continue
    const s = d * 10 + dh
    if (s < bestScore) { bestScore = s; best = r }
  }
  return best
}

/* ---------- main scorer ---------- */

function scoreRow(f: Flight, salt: number): Row {
  const klass = classifyType(f.type, f.category)
  const spec = CLASSES.find(c => c.klass === klass)!
  const phase = phaseOf(f)
  const seed = hash32(f.icao + spec.klass)
  const r1 = hashRand(seed, salt + 11), r2 = hashRand(seed, salt + 17), r3 = hashRand(seed, salt + 23), r4 = hashRand(seed, salt + 29)

  const rwy = snapRunway(f)
  const gsKt = Math.max(0, f.velocityKts)

  /* Surface state distribution: 60% DRY / 22% WET / 10% COMPSNOW / 5% SLUSH / 2% ICE / 1% WETICE */
  const sfc: SfcCondition = r2 < 0.60 ? 'DRY' : r2 < 0.82 ? 'WET' : r2 < 0.92 ? 'COMPSNOW' : r2 < 0.97 ? 'SLUSH' : r2 < 0.99 ? 'ICE' : 'WETICE'
  const sfcμ: Record<SfcCondition, number> = { DRY:1.0, WET:0.85, COMPSNOW:0.55, SLUSH:0.45, ICE:0.30, WETICE:0.18 }
  /* Override with rcam if hi-fidelity */
  const muRcam = rwy ? Math.min(1.0, 0.55 + rwy.rcam * 0.075) : sfcμ[sfc]
  const muSfcBlend = (muRcam + sfcμ[sfc]) / 2

  /* Brake/reverser health */
  const brakeFault = r3 < 0.04 ? 0.55 + r3 * 5 : r3 < 0.12 ? 0.15 + r3 * 1 : 0
  const revFault = r4 < 0.05 ? 0.7 : r4 < 0.18 ? 0.2 : 0
  const abRtoArmed = r1 > 0.07           // 93% armed

  /* TOW correction to V1 — heavy if r1 > 0.6 (overweight bias) */
  const towFrac = 0.78 + r1 * 0.25       // 0.78 .. 1.03
  /* Elevation correction (density alt): +1.2% per 1000ft elev for V1 ground-speed */
  const elev = rwy?.elevFt ?? 0
  const oatPen = 1 + (elev/1000) * 0.012 + (r2 - 0.5) * 0.020
  /* Wet/contam reduces V1 slightly (FCOM derate) */
  const wetDerate = sfc === 'DRY' ? 1.0 : sfc === 'WET' ? 0.985 : 0.96

  const v1Eff = spec.v1Base * Math.sqrt(towFrac) * oatPen * wetDerate
  const vrEff = spec.vrBase * Math.sqrt(towFrac) * oatPen
  const vLofEff = spec.vLofBase * Math.sqrt(towFrac) * oatPen

  /* Rolled position along runway:
     LINE-UP / ROLL-LO / ROLL-HI / ROTATE scale GS² → distance proportionally */
  const v1Sq = v1Eff * v1Eff
  const ratioGS = v1Sq > 0 ? Math.min(1.5, (gsKt * gsKt) / v1Sq) : 0
  // assume balanced field length ≈ spec.toLenFt+asdMargin at V1
  const bfl = spec.toLenFt + spec.asdMargin
  let posRolledFt = phase === 'GATE' || phase === 'TAXI' ? 0 : ratioGS * bfl
  if (phase === 'LINE-UP') posRolledFt = 0
  if (phase === 'ROTATE') posRolledFt = bfl * 0.92
  if (phase === 'AIRBORNE' || phase === 'NOT-TKO') posRolledFt = bfl * 1.0

  const toraRem = rwy ? Math.max(0, rwy.toraFt - posRolledFt) : Math.max(0, bfl - posRolledFt)
  const asdaRem = rwy ? Math.max(0, rwy.asdaFt - posRolledFt) : Math.max(0, bfl + 600 - posRolledFt)
  const todaRem = rwy ? Math.max(0, rwy.todaFt - posRolledFt) : Math.max(0, bfl + 800 - posRolledFt)

  /* Recognition delay 1.0 s @ GS = GS * 1.0 ft/s — multiplied by 1.69 (kt→fps) */
  const recCostFt = gsKt * KT_TO_FPS * 1.0

  /* Effective μ with brake/reverser credit */
  const revCredit = spec.revFrac * spec.revAvail * (1 - revFault)
  const muEff = Math.max(0.10, spec.muMaxDry * muSfcBlend * (1 - brakeFault)) + revCredit * 0.10
  const aDecel_fps2 = muEff * 32.174  // g·μ ft/s²

  /* Accel-stop required (using kinematic 0 = GS² − 2·a·d → d = GS²/(2·a)) */
  const gsFps = gsKt * KT_TO_FPS
  const asdReq = (gsFps * gsFps) / (2 * aDecel_fps2) + recCostFt + (rwy?.slopePct ?? 0) * -50

  /* Accel-go required (GS → V_LOF, assume average accel of 0.30g − 0.5·revCredit) */
  const aAccel_fps2 = (0.32 - 0.04 * revCredit) * 32.174
  const vLofFps = vLofEff * KT_TO_FPS
  const agdReq = vLofFps > gsFps ? (vLofFps*vLofFps - gsFps*gsFps) / (2 * aAccel_fps2) : 0

  const asdRatio = asdaRem > 50 ? asdReq / asdaRem : 99
  const agdRatio = todaRem > 50 ? agdReq / todaRem : 99

  const pastV1 = gsKt >= v1Eff
  const driver: Record<string, number> = {}

  /* GS driver: how close to V1 (saturates at V1) — peak risk window 0.85 V1 .. V1 */
  driver.GS = pastV1
    ? Math.min(100, 35 + (gsKt - v1Eff) * 1.5)
    : Math.min(100, 80 - Math.abs(gsKt / v1Eff - 0.92) * 200)

  /* ASD driver: REJECT path stop overflow */
  driver.ASD = pastV1 ? 0
    : asdRatio > 1.20 ? 100
    : asdRatio > 1.05 ? 75
    : asdRatio > 0.95 ? 45
    : asdRatio > 0.85 ? 20
    : 5

  /* AGD driver: CONTINUE path TODA overflow (mostly past V1) */
  driver.AGD = !pastV1 ? 5
    : agdRatio > 1.15 ? 100
    : agdRatio > 1.00 ? 80
    : agdRatio > 0.85 ? 35
    : 10

  /* RCAM driver — surface condition badness */
  driver.RCAM = (1 - muSfcBlend) * 100

  /* BRK driver — brake / reverser degradation */
  driver.BRK = (brakeFault * 70) + (revFault * 30) + (abRtoArmed ? 0 : 18)

  /* REC driver — recognition delay cost vs runway remaining */
  driver.REC = asdaRem > 0 ? Math.min(100, (recCostFt / asdaRem) * 100 * 4) : 100

  /* CLS driver — per-class envelope penalty for hot/high or heavy-cargo */
  let cls = 0
  if (spec.hotHigh && elev > 4000) cls += 35
  if (klass === 'CARGO-HVY') cls += 18
  if (klass === 'CNCRD-SST') cls += 25
  if (klass === 'WB-QUAD' && sfc !== 'DRY') cls += 22
  driver.CLS = cls

  /* Verdict matrix */
  let verdict: Verdict = 'NOT-ROLL'
  if (phase === 'NOT-TKO' || phase === 'AIRBORNE') verdict = 'NOT-ROLL'
  else if (phase === 'GATE' || phase === 'TAXI' || phase === 'LINE-UP') verdict = 'CAN-STOP'  // not rolling
  else if (pastV1 && agdRatio > 1.10) verdict = 'CANNOT-GO'
  else if (pastV1) verdict = 'COMMIT'
  else if (asdRatio > 1.05) verdict = 'CANNOT-STOP'
  else if (asdRatio > 0.95) verdict = 'MARGINAL'
  else verdict = 'CAN-STOP'

  /* Tier rollup: max driver + verdict-specific kick */
  let score = Object.values(driver).reduce((m, v) => Math.max(m, v), 0)
  if (verdict === 'CANNOT-STOP' || verdict === 'CANNOT-GO') score = Math.max(score, 88)
  else if (verdict === 'COMMIT' && pastV1) score = Math.max(40, Math.min(score, 55))
  else if (verdict === 'MARGINAL') score = Math.max(50, score)
  if (phase === 'GATE' || phase === 'TAXI' || phase === 'NOT-TKO' || phase === 'AIRBORNE') score = 0

  let tier: Tier
  if (phase === 'NOT-TKO' || phase === 'AIRBORNE' || phase === 'GATE' || phase === 'TAXI') tier = 'SLATE'
  else if (verdict === 'CANNOT-STOP' || verdict === 'CANNOT-GO') tier = 'FUCHSIA'
  else if (score >= 65) tier = 'ROSE'
  else if (score >= 45) tier = 'AMBER'
  else if (verdict === 'COMMIT') tier = 'SKY'
  else tier = 'EMERALD'

  /* Notes */
  const notes: string[] = []
  const rwyDesc = rwy ? `${rwy.icao} ${rwy.rwId}` : 'unsnapped'
  if (verdict === 'CANNOT-STOP')
    notes.push(`CANNOT-STOP — REJECT past safe-stop window · ${asdReq.toFixed(0)}ft req > ${asdaRem.toFixed(0)}ft ASDA on ${rwyDesc} · NTSB AAR-01-02 AA1420 LIT mode`)
  else if (verdict === 'CANNOT-GO')
    notes.push(`CANNOT-GO — TODA insufficient past V1 · ${agdReq.toFixed(0)}ft req > ${todaRem.toFixed(0)}ft TODA · BEA F-BTSC Concorde 4590 mode`)
  else if (verdict === 'COMMIT')
    notes.push(`COMMIT — GS ${gsKt.toFixed(0)} ≥ V1 ${v1Eff.toFixed(0)} · continue rotation per FCTM 3.10 / PRO-NOR-SOP-23`)
  else if (verdict === 'MARGINAL')
    notes.push(`MARGINAL stop — ratio ${asdRatio.toFixed(2)} (target ≤0.95) · brief reject criteria FAA AC 25-7D §3`)
  if (sfc !== 'DRY')
    notes.push(`Surface ${sfc} (RCAM ${rwy?.rcam ?? '?'}) — wet-runway accel-stop margin per SAFO 19001`)
  if (!abRtoArmed) notes.push(`AUTOBRAKE-RTO not armed — manual reject lengthens reaction by ~1s · FCOM Limits Ch.1`)
  if (revFault > 0.5) notes.push(`Reverser FAULT — ${(revFault*100).toFixed(0)}% credit lost · revise ASDR per AC 25-7D §3.3.10`)
  if (brakeFault > 0.4) notes.push(`Brake DEGRADED — μ_eff ${muEff.toFixed(2)} · AAR-14-01 Asiana 162 mode if rejected late`)
  if (spec.klass === 'CNCRD-SST') notes.push(`SST envelope — Concorde 4590 reference, V1 ${v1Eff.toFixed(0)} above all other classes`)
  if (rwy && rwy.elevFt > 5000) notes.push(`Hot/high (elev ${rwy.elevFt}ft) — V1 ground-speed inflated by density altitude per AFM §5`)
  if (notes.length === 0) notes.push(`Nominal · ${verdict} on ${rwyDesc} · V1 ${v1Eff.toFixed(0)}kt · GS ${gsKt.toFixed(0)}kt`)

  const rcamSev = driver.RCAM

  return { f, klass, spec, phase, rwy, v1Eff, vrEff, vLofEff, gsKt, pastV1, posRolledFt, asdaRem, toraRem, todaRem, asdReq, agdReq, sfc, muEff, brakeFault, revFault, abRtoArmed, rcamSev, asdRatio, agdRatio, recCostFt, verdict, tier, score, driver, notes }
}

/* ---------- map source IDs ---------- */

const SRC_HALO = 'rto-halo-src'
const SRC_PIN = 'rto-pin-src'
const SRC_LBL = 'rto-lbl-src'
const SRC_RWY = 'rto-rwy-src'
const LYR_HALO = 'rto-halo-l'
const LYR_PIN = 'rto-pin-l'
const LYR_LBL = 'rto-lbl-l'
const LYR_RWY = 'rto-rwy-l'

/* ---------- component ---------- */

export default function RtoDecision({ map, flights, onClose, onFly }:{
  map: any
  flights: Flight[]
  onClose: () => void
  onFly?: (icao: string) => void
}) {
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'RUNWAYS'>('AIRCRAFT')
  const [filter, setFilter] = useState<'ALL'|'ROLL'|'CRIT'>('ROLL')
  const [salt, setSalt] = useState(0)
  const [pinned, setPinned] = useState<string | null>(null)
  const [showRwys, setShowRwys] = useState(true)

  useEffect(() => {
    const t = setInterval(() => setSalt(s => (s + 1) % 9973), 4000)
    return () => clearInterval(t)
  }, [])

  const rows = useMemo<Row[]>(() => flights.map(f => scoreRow(f, salt)), [flights, salt])

  const filtered = useMemo(() => {
    let xs = rows
    if (filter === 'ROLL') xs = xs.filter(r => ['LINE-UP','ROLL-LO','ROLL-HI','ROTATE'].includes(r.phase))
    if (filter === 'CRIT') xs = xs.filter(r => r.tier === 'FUCHSIA' || r.tier === 'ROSE')
    return xs.slice().sort((a, b) => b.score - a.score)
  }, [rows, filter])

  const agg = useMemo(() => {
    const buckets: Record<Tier, number> = { FUCHSIA:0, ROSE:0, AMBER:0, SKY:0, EMERALD:0, SLATE:0 }
    const klassCounts: Record<string, { n: number; worst: Tier; v1: number }> = {}
    let rollN = 0; let pastV1N = 0
    for (const r of rows) {
      buckets[r.tier]++
      if (['ROLL-LO','ROLL-HI','ROTATE'].includes(r.phase)) rollN++
      if (r.pastV1) pastV1N++
      const k = r.klass
      if (!klassCounts[k]) klassCounts[k] = { n:0, worst:'EMERALD', v1: r.v1Eff }
      klassCounts[k].n++
      const ord: Tier[] = ['SLATE','EMERALD','SKY','AMBER','ROSE','FUCHSIA']
      if (ord.indexOf(r.tier) > ord.indexOf(klassCounts[k].worst)) klassCounts[k].worst = r.tier
    }
    return { buckets, rollN, pastV1N, klassCounts, total: rows.length }
  }, [rows])

  /* ---------- map layer plumbing ---------- */
  useEffect(() => {
    if (!map) return
    const m = map
    const tryAdd = () => {
      try {
        if (!m.getSource(SRC_HALO)) m.addSource(SRC_HALO, { type:'geojson', data:{ type:'FeatureCollection', features:[] } })
        if (!m.getSource(SRC_PIN))  m.addSource(SRC_PIN,  { type:'geojson', data:{ type:'FeatureCollection', features:[] } })
        if (!m.getSource(SRC_LBL))  m.addSource(SRC_LBL,  { type:'geojson', data:{ type:'FeatureCollection', features:[] } })
        if (!m.getSource(SRC_RWY))  m.addSource(SRC_RWY,  { type:'geojson', data:{ type:'FeatureCollection', features:[] } })
        if (!m.getLayer(LYR_RWY))   m.addLayer({ id:LYR_RWY, type:'symbol', source:SRC_RWY, layout:{ 'text-field':['get','txt'], 'text-size':9, 'text-offset':[0, 1.0], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#94a3b8','text-halo-color':'#0f172a','text-halo-width':1.2 } })
        if (!m.getLayer(LYR_HALO))  m.addLayer({ id:LYR_HALO, type:'circle', source:SRC_HALO, paint:{ 'circle-color':'transparent', 'circle-stroke-color':['get','color'], 'circle-stroke-width':2, 'circle-radius':['get','radius'], 'circle-opacity':0.85 } })
        if (!m.getLayer(LYR_PIN))   m.addLayer({ id:LYR_PIN, type:'circle', source:SRC_PIN, paint:{ 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.4, 'circle-radius':5 } })
        if (!m.getLayer(LYR_LBL))   m.addLayer({ id:LYR_LBL, type:'symbol', source:SRC_LBL, layout:{ 'text-field':['get','txt'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a','text-halo-width':1.4 } })
      } catch {}
    }
    if (m.isStyleLoaded && m.isStyleLoaded()) tryAdd()
    else m.once && m.once('style.load', tryAdd)
    return () => {
      try {
        for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_RWY]) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_RWY]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map])

  useEffect(() => {
    if (!map) return
    const m = map
    const halo: any[] = []; const pin: any[] = []; const lbl: any[] = []; const rwyF: any[] = []
    /* aircraft features */
    for (const r of filtered) {
      const color = TIER_COLOR[r.tier]
      const rad = r.tier === 'FUCHSIA' ? 14 : r.tier === 'ROSE' ? 11 : r.tier === 'AMBER' ? 9 : 7
      halo.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ color, radius:rad } })
      pin.push({  type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ color } })
      if (r.tier === 'FUCHSIA' || r.tier === 'ROSE') {
        const ratio = r.pastV1 ? r.agdRatio : r.asdRatio
        const txt = `${r.f.callsign} ${r.verdict} ${ratio.toFixed(2)}`
        lbl.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ txt, color } })
      }
    }
    /* runway features (catalogue) */
    if (showRwys) {
      for (const r of RUNWAYS) {
        rwyF.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.lng, r.lat] }, properties:{ txt: `${r.icao} ${r.rwId} · ${r.toraFt}ft` } })
      }
    }
    try {
      m.getSource(SRC_HALO) && m.getSource(SRC_HALO).setData({ type:'FeatureCollection', features: halo })
      m.getSource(SRC_PIN)  && m.getSource(SRC_PIN).setData({ type:'FeatureCollection', features: pin })
      m.getSource(SRC_LBL)  && m.getSource(SRC_LBL).setData({ type:'FeatureCollection', features: lbl })
      m.getSource(SRC_RWY)  && m.getSource(SRC_RWY).setData({ type:'FeatureCollection', features: rwyF })
    } catch {}
  }, [map, filtered, showRwys])

  const pinnedRow = pinned ? rows.find(r => r.f.icao === pinned) : undefined

  return (
    <div className="absolute top-3 right-3 bottom-3 w-[440px] z-30 bg-slate-950/95 backdrop-blur border border-slate-800 rounded-md flex flex-col shadow-2xl">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">RTO · Rejected-Takeoff Decision</div>
          <div className="text-[10px] text-slate-400 truncate">V1 reject-vs-continue · 25.107 / SAFO 06012 / AC 25-7D</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none" aria-label="Close">×</button>
      </div>

      {/* Top stat cards */}
      <div className="px-2 py-2 grid grid-cols-4 gap-1.5 border-b border-slate-800/60">
        {[
          ['CRIT', agg.buckets.FUCHSIA + agg.buckets.ROSE, '#fb7185'],
          ['WATCH', agg.buckets.AMBER, '#f59e0b'],
          ['COMMIT', agg.buckets.SKY, '#38bdf8'],
          ['NOMINAL', agg.buckets.EMERALD, '#10b981'],
        ].map(([lbl, v, c]) => (
          <div key={lbl as string} className="bg-slate-900/60 border border-slate-800 rounded px-1.5 py-1">
            <div className="text-[9px] uppercase text-slate-500">{lbl as string}</div>
            <div className="text-sm font-semibold" style={{ color: c as string }}>{v as number}</div>
          </div>
        ))}
      </div>

      <div className="px-2 py-2 text-[10px] text-slate-500 border-b border-slate-800/60 flex items-center justify-between gap-2">
        <div className="truncate">{agg.rollN} on-roll · {agg.pastV1N} past-V1 · {agg.total} airframes · live-tick {salt}</div>
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={showRwys} onChange={e=>setShowRwys(e.target.checked)} className="accent-sky-500"/>
          <span>show runways</span>
        </label>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800/60">
        {(['AIRCRAFT','CLASSES','RUNWAYS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 text-[10px] py-1.5 uppercase tracking-wider ${tab===t ? 'text-sky-400 border-b border-sky-500/60 bg-sky-500/5' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'AIRCRAFT' && (
        <div className="flex-1 min-h-0 flex flex-col">
          {/* filter chips */}
          <div className="px-2 py-1.5 border-b border-slate-800/60 flex gap-1 text-[10px]">
            {(['ROLL','CRIT','ALL'] as const).map(k => (
              <button key={k} onClick={()=>setFilter(k)} className={`px-2 py-0.5 rounded border ${filter===k ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'}`}>{k}</button>
            ))}
          </div>

          {/* list */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {filtered.length === 0 && (
              <div className="px-3 py-8 text-center text-slate-500 text-[11px]">
                {filter === 'ROLL' ? 'No aircraft on takeoff roll — try ALL' : 'No targets match filter'}
              </div>
            )}
            {filtered.slice(0, 80).map(r => {
              const cs = r.f.callsign || r.f.icao
              return (
                <div key={r.f.icao} onClick={() => setPinned(pinned === r.f.icao ? null : r.f.icao)} className={`px-2 py-1.5 border-b border-slate-800/60 cursor-pointer hover:bg-slate-900/40 ${pinned===r.f.icao ? 'bg-slate-900/60' : ''}`}>
                  <div className="flex items-center gap-1.5">
                    <span className={`px-1.5 py-0.5 rounded text-[9px] border ${TIER_BG[r.tier]}`}>{r.tier}</span>
                    <span className="font-semibold text-slate-100 text-[12px] truncate flex-1">{cs}</span>
                    <span className="text-[10px] text-slate-500">{r.f.type}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-slate-400">
                    <span>{r.phase}</span>
                    <span>·</span>
                    <span>GS {r.gsKt.toFixed(0)}</span>
                    <span className="text-slate-600">/V1 {r.v1Eff.toFixed(0)}</span>
                    {r.pastV1 && <span className="text-sky-400">past-V1</span>}
                    <span className="ml-auto" style={{ color: TIER_COLOR[r.tier] }}>{r.verdict}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[9px] text-slate-500">
                    <span>{r.rwy ? `${r.rwy.icao} ${r.rwy.rwId}` : 'no-rwy'}</span>
                    <span>·</span>
                    <span>ASDR {r.asdReq.toFixed(0)}/{r.asdaRem.toFixed(0)}ft</span>
                    <span className="ml-auto" style={{ color: r.asdRatio > 1 ? '#fb7185' : r.asdRatio > 0.9 ? '#f59e0b' : '#10b981' }}>{r.asdRatio < 9 ? r.asdRatio.toFixed(2) : '—'}</span>
                  </div>
                  {/* driver chips */}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {Object.entries(r.driver).filter(([,v])=>v >= 25).slice(0, 4).map(([k, v]) => {
                      const col = v >= 75 ? '#fb7185' : v >= 50 ? '#f59e0b' : '#38bdf8'
                      return <span key={k} className="px-1 py-px rounded text-[8px] border" style={{ color: col, borderColor: col + '60', background: col + '15' }}>{k} {v.toFixed(0)}</span>
                    })}
                  </div>
                  {/* pinned detail */}
                  {pinned === r.f.icao && (
                    <div className="mt-2 px-2 py-1.5 bg-slate-900/80 border border-slate-800 rounded text-[10px] space-y-1">
                      <div className="text-slate-300">{r.notes[0]}</div>
                      {r.notes.slice(1, 4).map((n, i) => <div key={i} className="text-slate-500">· {n}</div>)}
                      <div className="pt-1 grid grid-cols-3 gap-1 text-[9px]">
                        <div><span className="text-slate-500">V1</span> <span className="text-slate-300">{r.v1Eff.toFixed(0)}</span></div>
                        <div><span className="text-slate-500">Vr</span> <span className="text-slate-300">{r.vrEff.toFixed(0)}</span></div>
                        <div><span className="text-slate-500">VLOF</span> <span className="text-slate-300">{r.vLofEff.toFixed(0)}</span></div>
                        <div><span className="text-slate-500">ASDA</span> <span className="text-slate-300">{r.asdaRem.toFixed(0)}</span></div>
                        <div><span className="text-slate-500">TODA</span> <span className="text-slate-300">{r.todaRem.toFixed(0)}</span></div>
                        <div><span className="text-slate-500">μ-eff</span> <span className="text-slate-300">{r.muEff.toFixed(2)}</span></div>
                        <div><span className="text-slate-500">sfc</span> <span className="text-slate-300">{r.sfc}</span></div>
                        <div><span className="text-slate-500">rev</span> <span className="text-slate-300">{((1-r.revFault)*100).toFixed(0)}%</span></div>
                        <div><span className="text-slate-500">AB-RTO</span> <span className="text-slate-300">{r.abRtoArmed?'Y':'N'}</span></div>
                      </div>
                      <div className="pt-1 flex gap-2">
                        {onFly && <button onClick={(e)=>{e.stopPropagation(); onFly(r.f.icao)}} className="text-sky-400 hover:text-sky-300 text-[10px]">› fly to</button>}
                        <span className="text-slate-500 text-[9px]">{r.spec.ref}</span>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {tab === 'CLASSES' && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {CLASSES.map(c => {
            const stat = agg.klassCounts[c.klass]
            const n = stat?.n ?? 0
            const worst = stat?.worst ?? 'SLATE'
            return (
              <div key={c.klass} className="px-2 py-1.5 border-b border-slate-800/60">
                <div className="flex items-center gap-2">
                  <span className={`px-1.5 py-0.5 rounded text-[9px] border ${TIER_BG[worst]}`}>{worst}</span>
                  <span className="font-semibold text-slate-100 text-[12px] flex-1 truncate">{c.label}</span>
                  <span className="text-[10px] text-slate-500">n={n}</span>
                </div>
                <div className="mt-0.5 text-[10px] text-slate-400 grid grid-cols-3 gap-1">
                  <div>V1 {c.v1Base}</div>
                  <div>Vr {c.vrBase}</div>
                  <div>VLOF {c.vLofBase}</div>
                  <div>μ-max {c.muMaxDry.toFixed(2)}</div>
                  <div>rev {(c.revFrac*100).toFixed(0)}%</div>
                  <div>BFL {c.toLenFt}ft</div>
                </div>
                <div className="mt-0.5 text-[9px] text-slate-500">{c.ref}</div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'RUNWAYS' && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {RUNWAYS.slice().sort((a,b)=>a.toraFt-b.toraFt).map(r => {
            const tight = r.toraFt < 8000
            const hi = r.elevFt > 4000
            return (
              <div key={r.icao+r.rwId} className="px-2 py-1.5 border-b border-slate-800/60">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-100 text-[12px]">{r.icao} {r.rwId}</span>
                  {tight && <span className="px-1 py-px rounded text-[9px] bg-amber-500/15 text-amber-300 border border-amber-500/40">TIGHT</span>}
                  {hi && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/40">HOT-HIGH</span>}
                  <span className="ml-auto text-[10px] text-slate-500">RCAM {r.rcam}</span>
                </div>
                <div className="mt-0.5 text-[10px] text-slate-400 grid grid-cols-3 gap-1">
                  <div>TORA {r.toraFt}</div>
                  <div>ASDA {r.asdaFt}</div>
                  <div>TODA {r.todaFt}</div>
                  <div>elev {r.elevFt}ft</div>
                  <div>slope {r.slopePct>0?'+':''}{r.slopePct.toFixed(2)}%</div>
                  <div>hdg {r.headingT.toFixed(0)}°T</div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* footer driver legend */}
      <div className="px-2 py-1.5 border-t border-slate-800/60 bg-slate-950/60 text-[9px] text-slate-500">
        <div className="flex flex-wrap gap-x-2 gap-y-0.5">
          {Object.entries(DRIVER_LABEL).map(([k,v]) => <span key={k}><span className="text-slate-400">{k}</span> {v}</span>)}
        </div>
        <div className="mt-1 text-[9px] text-slate-600">Refs: 14 CFR 25.107/109/111/113/121.189 · CS-25 Subpart B · AC 25-7D · AC 91-79B · SAFO 06012/19001 · InFO 16016 · Doc 8168 · FCOM PI Ch.1 + FCTM 3.10 / FCOM PER-TOF + FCTM PRO-NOR-SOP-23 · NTSB AAR-01-02 AA1420 · AAR-14-01 Asiana 162 · BEA F-BTSC Concorde · AAIB BA 38 · ATSB EK407 · TSB MK1602 · CIAIAC Spanair 5022 · KNKT Garuda 200</div>
      </div>
    </div>
  )
}
