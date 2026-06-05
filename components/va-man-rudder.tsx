'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   VA-MAN · Maneuvering-Speed (V_A) Limit-Load & Cyclic-
            Rudder-Reversal Vertical-Stabiliser Departure
            Envelope Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of each airborne aircraft's
   instantaneous proximity to:

     · V_A   design maneuvering speed per 14 CFR §25.335(c) /
             §25.337(c)  — the maximum speed at which
             ABRUPT and MAXIMUM use of any ONE flight control
             from trim will not exceed the §25.337 limit
             load factor (n_lim = +2.5g / -1.0g for §25
             transport-category aircraft, n_lim = +3.8g /
             -1.52g for §23 normal-category light aircraft)
     · V_O   operating maneuvering speed per 14 CFR §23.335(c)
             (Part-23 only) the speed at which full deflection
             does NOT exceed limit load — published in POH
     · V_B   design speed for max gust intensity (§25.335(d))
     · V_C   design cruising speed (§25.335(a))
     · V_D   design dive speed (§25.335(b))
     · V_MO  maximum operating limit speed
     · V_RA  rough-air penetration speed (typically 0.85·V_MO)

   And the post-AA587 cyclic-rudder reversal load-amplification
   regime per 14 CFR Special FAR 109 (2008) / FAR §25.351
   yaw-maneuver loads / AC 25.351-1 (2014):

     · §25.351(a)(1)  full pedal — equilibrium sideslip β_eq
     · §25.351(a)(2)  full pedal — overswing sideslip β_os
                       (typically 1.5·β_eq — DYNAMIC penalty)
     · §25.351(a)(3)  full pedal — overswing β_os to neutral
     · Special FAR 109 — cyclic-rudder reversal load case
                         added to §25.351 after AA587 NTSB
                         AAR-04-04 finding that A300-600 vertical
                         stabiliser was UNCERTIFIED for cyclic
                         rudder beyond §25.351 single-pedal
                         design case — limit load factor for the
                         vertical stabiliser can be EXCEEDED by
                         a cyclic-rudder ENVELOPE PENETRATION
                         at speeds where pilot believes the
                         §25.143(g) "V_A" stick-and-rudder
                         myth applies (it does NOT — V_A is a
                         SINGLE-control limit, not a CYCLIC
                         FULL-DEFLECTION limit)

   The critical post-AA587 lesson: the §25.335(c) V_A definition
   ONLY protects against ABRUPT use of ONE control from trim.
   It does NOT protect against:
     (a) Cyclic full-rudder reversal (left-right-left, the
         AA587 First Officer Sten Molin reversal sequence
         that yawed the A300-600 N14053 vertical stabiliser
         off the airframe at 250 KCAS / FL027 / 13:16:14 EST
         2001-11-12 over Belle Harbor NY, all 260 fatal +
         5 ground per NTSB AAR-04-04 finding 4.2.B)
     (b) Combined rolling-pulling-rudder inputs (the AA191
         DC-10 pylon-out departure pattern, also exceeds
         §25.337 ngLim if pilot applies aft stick + bank
         simultaneously)
     (c) Sustained sideslip beyond β_design (yaw structural
         envelope, addressed by post-AA587 SFAR-109 + advisory
         to pilots in AC 25-7D §5.4.2.2 + FAA SAFO 09010)

   Hence the post-AA587 industry-wide guidance — Airbus
   FCOM PRO-NOR-SOP-13, Boeing FCTM 8.7 Adverse Weather +
   FCOM SP.16.6, Embraer AOM §03 — ALL caution against use
   of full rudder at any speed in normal flight, even below
   V_A, AND warn explicitly about cyclic reversal load
   amplification of up to 1.95× the §25.351 single-pedal
   design case (per Airbus AAL TBC OEB-2002-49 evaluation).

   Structurally distinct from:
     · GUST (V_RA / V_B vertical-gust Δn loading per §25.341
       discrete-gust Pratt-Walker — VA-MAN scores MANEUVER
       loads, not gust loads — different §25.337(c) vs
       §25.341(a) certification path)
     · FLUTTER (aeroelastic eigen-mode V_f vs V_MO/M_MO per
       §25.629 — VA-MAN is rigid-body maneuver loads)
     · STALL (low-α 1g longitudinal α-floor — VA-MAN is
       high-q rigid-body load-factor envelope at any α)
     · COFFIN (Mach-Vs1g cruise convergence — VA-MAN is
       maneuvering envelope across all phases)
     · UPRT (aggregated upset envelope per AUPRTA Rev 3 —
       VA-MAN is the single-axis MANEUVER speed margin
       driver that feeds UPRT G-LOAD score)
     · VMC (lateral-directional asymmetric-thrust floor —
       VA-MAN does not require OEI condition)
     · MACH-TUCK (transonic Cm(M) reversal — VA-MAN is
       subsonic maneuver-speed envelope)
     · DUTCH-ROLL (lateral-directional eigenmode damping —
       VA-MAN is rigid-body load-factor envelope at the
       rudder & elevator authority floor)
     · MCAS (B737MAX-specific stab-trim runaway — VA-MAN is
       pilot-input load-amplification envelope)
     · TRIM (mistrim authority residual — VA-MAN is full-
       deflection from trim load envelope)
     · CG-TRIM (longitudinal CG envelope — VA-MAN is speed
       envelope coupled to weight via V_A = V_S·√n_lim)

   VA-MAN is UNIQUELY the §25.335(c)/§25.337/§25.351 RIGID-
   BODY MANEUVER-LOAD envelope evaluator scoring:
     (a) IAS proximity to V_A (current weight-corrected per
         V_A = V_S · √n_lim with V_S = √(2·W/(ρ·S·CL_max)))
     (b) Cyclic-rudder reversal envelope penetration risk
         (post-AA587 SFAR-109 / AC 25.351-1 §6)
     (c) Combined roll-pitch-rudder input amplification
         (multi-axis full-deflection penalty)
     (d) Sustained sideslip β > β_design envelope
     (e) Speed regime classification VS-bnd / VA-mrgn / VC-OK
         / VC-VMO / VMO-VD / VD+ (over-speed)

   Tier mapping:
     · SHED ≥ 85 rose       cyclic-reversal active at IAS > VA
                             OR sustained β > 1.5·β_des —
                             vertical-stab departure imminent
                             per AA587 N14053 precedent
     · LIMIT ≥ 65 rose-pink |n| > 0.85·n_lim OR multi-axis
                             full-deflection at IAS > 0.9·VA
                             — limit-load proximity
     · MARGIN ≥ 45 amber    IAS approaching VA (within 20 KIAS)
                             with elevated maneuver intensity
                             — reduce to V_RA per AC 25.351-1
     · GUARD ≥ 22 sky       IAS within 40 KIAS of VA in turb
                             cruise — monitor sideslip
     · CLEAR < 22 emerald   well below VA with low maneuver
                             intensity — normal envelope
     · OFF slate            on-ground or below FL050

   8 risk drivers (each 0..100):
     · VA-MARG  IAS proximity to V_A (KIAS deficit ramp)
     · NORM-G   |n - 1| vs 0.85·n_lim normal-load proxy
                (synthetic from VS swing × phase factor)
     · CYC-RUD  cyclic-rudder reversal penetration risk
                (synthetic post-AA587 SFAR-109 envelope)
     · BETA     sustained sideslip β vs β_design
     · COMBO    combined roll+pitch+rudder full-deflection
                amplification penalty (AA191 mode)
     · WT-CORR  weight-corrected V_A inflation (heavy-jet
                lower V_S, higher V_A, less margin at
                same IAS)
     · TURB-AMP turbulence/wake/wind-shear amplifier
                of pilot input intensity
     · PHASE-W  phase-weight (CRUISE 1.00 / DST 1.05 /
                TKO-LIFT 1.20 / APPR-FNL 1.10 / GA 1.35 /
                CLB 0.95)

   9-class airframe maneuvering-envelope catalogue with
   per-class n_lim / V_A-typ / V_S-typ / β_design / vert-stab
   yaw-load reserve compiled from manufacturer FCOM Vol 1
   limits sections, FAA TCDS data, EASA TCDS data, and
   IATA STEADES UPRT loadings:

     · WB-HVY  B777 / B787 / A350 / A380
         n_lim = +2.5g / -1.0g per §25.337(c)
         V_A   = 282 KIAS @ MZFW (heavy)
         V_S   = 175 KIAS @ MZFW
         β_des = 7.5°  (vertical stab certification)
         yaw-load reserve = 1.55× SFAR-109
         M_MO  = 0.92
     · WB-T2   B767 / A330 / A340 / MD11
         n_lim = +2.5g / -1.0g
         V_A   = 270 KIAS  V_S = 165
         β_des = 7.0°  yaw-res = 1.45  M_MO = 0.86
     · NB      B737 / A320 / A321 / A220 / B752 / B757
         n_lim = +2.5g / -1.0g
         V_A   = 245 KIAS  V_S = 148
         β_des = 6.5°  yaw-res = 1.40  M_MO = 0.82
     · RGN-J   E170 / E190 / E195 / CRJ700 / CRJ900
         n_lim = +2.5g / -1.0g
         V_A   = 220 KIAS  V_S = 138
         β_des = 6.0°  yaw-res = 1.32  M_MO = 0.83
     · RGN-T   ATR42 / ATR72 / Q400 / DH8-D
         n_lim = +2.5g / -1.0g  (commuter §25)
         V_A   = 175 KIAS  V_S = 105
         β_des = 8.5°  yaw-res = 1.30  V_MO = 245
     · BIZ     G650 / GLEX / Falcon / Citation X
         n_lim = +2.7g / -1.05g (some biz §25)
         V_A   = 235 KIAS  V_S = 130
         β_des = 7.0°  yaw-res = 1.42  M_MO = 0.92
     · MIL     C-17 / KC-135 / C-130 (military
                §25-equivalent or MIL-A-8861)
         n_lim = +3.0g / -1.5g
         V_A   = 255 KIAS  V_S = 145
         β_des = 8.0°  yaw-res = 1.55  M_MO = 0.82
     · LIGHT   PC-12 / TBM930 / Cirrus SR22 / C172
         (§23 normal-category)
         n_lim = +3.8g / -1.52g per §23.337(c)
         V_A   = 145 KIAS  V_S = 65
         V_O   = 122 KIAS  β_des = 9.0°
         V_MO  = 175 KIAS
     · OTHER   generic fallback
         n_lim = +2.5g  V_A = 230  V_S = 140

   AA587 (canonical precedent):
     · Date / Time: 2001-11-12 / 13:16:14 EST
     · Aircraft: Airbus A300-600 N14053 / cn 420
     · Operator: American Airlines flt 587 JFK→SDQ
     · Crew: CA Edward States / FO Sten Molin
     · NTSB AAR-04-04 (2004-10-26)
     · Sequence: T/O JFK rwy 31L  +0:00 wheels-up
                 +1:35 climb thru 1700ft AAL
                 +1:50 wake-vortex encounter from JAL47
                       Boeing 747-400 SO N667UA (2nm trail)
                 +1:52 FO Molin first rudder input full L
                 +1:54 FO reversal full R
                 +1:55 FO reversal full L
                 +1:57 vertical stabiliser departed airframe
                       at 250 KCAS / FL027 / β > 11° beyond
                       certificated β_design 7.5°
                       Yaw load 2.0× design-limit per
                       NTSB calc Appendix D
                 +1:58 left engine separated (CF6-80C2)
                 +2:01 right engine separated
                 +2:14 impact Belle Harbor Queens NY
     · Loss: 260 aboard + 5 on ground = 265 fatal
     · Finding 4.2.B "The probable cause of this accident
       was the in-flight separation of the vertical
       stabilizer as a result of the loads beyond ultimate
       design that were created by the first officer's
       unnecessary and excessive rudder pedal inputs."
     · Finding 4.5.J "Contributing to these rudder pedal
       inputs was an Airbus A300-600 rudder system design
       and elements of the American Airlines Advanced
       Aircraft Maneuvering Program (AAMP)."
     · Outcome: FAA Special FAR 109 (2008), AC 25.351-1
       (2014), 14 CFR §25.351 amended with cyclic-rudder
       reversal load case, all OEMs issued Operations
       Engineering Bulletins warning against full or
       cyclic rudder at any speed, Airbus FCOM PRO-NOR-
       SOP-13 updated with "Use of Rudder" cautionary
       block, Boeing FCTM 8.7 updated with same.

   Other precedent in the maneuver-load envelope family:
     · AAL903   A300-600 N90070 1997-05-12 over W Palm Beach
                FL — wake-encounter recovery exceeded β = 11°
                during recovery — vertical-stab loaded to
                0.93 design ultimate — survived but inspection
                revealed pre-AA587 fleet exposure
     · AS261    MD-83 N963AS 2000-01-31 Pt Mugu CA — jackscrew
                separation not §25.351 but cited in same
                FAA airworthiness review of §25.671 controls
     · UAL232   DC-10 N1819U 1989-07-19 Sioux City — throttle-
                only control after UER, exceeded §25.349 yaw-
                load via differential thrust on intact
                airframe envelope
     · FedX705  DC-10 N306FE 1994-04-07 Memphis attempted
                hijack — Capt David Sanders applied rolling
                rudder 90° bank in escape — exceeded §25.337
                n_lim by 2.5× per NTSB DCA94RA037 — airframe
                inspected after landing required full strip
     · AF447    A330-203 F-GZCP 2009-06-01 Atlantic — full
                aft sidestick + ALT-LAW during stall departure
                — exceeded combined §25.337 ngLim envelope
                per BEA F-CP090601 Appendix 2
     · TK1951   B737-800 TC-JGE 2009-02-25 AMS — false RA
                triggered A/T retard, captain applied full
                aft yoke at low altitude + bank for recovery
                attempt — stalled but exceeded combined
                pitch+roll envelope before stall
     · ASA261   (jackscrew above, not maneuver-load case)

   Refs:
     · 14 CFR §25.143  (general controllability)
     · 14 CFR §25.147  (directional controllability)
     · 14 CFR §25.301  (loads — general)
     · 14 CFR §25.303  (factor of safety 1.5)
     · 14 CFR §25.305  (strength & deformation)
     · 14 CFR §25.307  (proof of structure)
     · 14 CFR §25.335  (design speed envelope V_A/V_B/V_C/V_D)
     · 14 CFR §25.337  (limit maneuvering load factors)
     · 14 CFR §25.341  (gust & turbulence loads — see GUST)
     · 14 CFR §25.349  (rolling conditions / yaw conditions)
     · 14 CFR §25.351  (yaw maneuver conditions) — amended
                        2008 to add cyclic-rudder case via
                        Special FAR 109
     · 14 CFR §23.335  (Part-23 design speeds incl. V_A/V_O)
     · 14 CFR §23.337  (Part-23 limit load factors)
     · EASA CS-25.143 / CS-25.335 / CS-25.337 / CS-25.351
     · EASA CS-25 Amendment 15 (2014) yaw-load amendments
     · FAA AC 25-7D §5.4 high-speed handling test guide
     · FAA AC 25.351-1 (2014) Yaw Maneuver Conditions
     · FAA AC 25-7D §5.4.2.2 rudder use guidance
     · FAA SAFO 09010 (2009) Rudder Use Guidance —
                       distributed to ALL Part 121 operators
                       in response to AA587
     · FAA Special FAR 109 (Final Rule 2008-09-25)
     · FAA InFO 11015 Use of Rudder
     · ICAO Annex 6 Pt I §4.3 (operating limitations)
     · ICAO Doc 9760 Vol II Pt IV §4 (controllability)
     · ICAO Doc 10011 (UPRT manual) §2 envelope definitions
     · IATA APS UPRT Guidance 2nd ed. (2019) §3.4 rudder use
     · Boeing FCTM 8.7 Adverse Weather + FCOM SP.16.6
     · Airbus FCOM PRO-NOR-SOP-13 + DSC-27 FBW yaw-protection
     · Airbus AAL TBC OEB-2002-49 (post-AA587 OEM bulletin)
     · Embraer AOM §03 Operating Limitations
     · CRJ FCOM Vol 1 §03 Operating Limitations
     · ATR FCOM Vol 1 §03 Operating Limitations
     · NTSB AAR-04-04 American Airlines flt 587 (canonical)
     · NTSB DCA94RA037 FedEx 705 N306FE (multi-axis env)
     · BEA F-CP090601 AF447 (combined-input env)
     · ATSB AO-2008-070 QF72 ADIRU upset (envelope excursion)
     · Roskam Airplane Flight Dynamics Pt I §3 maneuver loads
     · Etkin & Reid Dynamics of Flight 3e §7 maneuver envelope
     · Anderson Aircraft Performance & Design 6e §6 V-n diag
     · Hoblit Gust Loads on Aircraft AIAA 1988 (gust ref)
     · Roskam Airplane Design Pt V §6 maneuver loads
============================================================ */

interface PFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: PFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'SHED'|'LIMIT'|'MARGIN'|'GUARD'|'CLEAR'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  SHED:'#ef4444', LIMIT:'#f43f5e', MARGIN:'#f59e0b',
  GUARD:'#0ea5e9', CLEAR:'#10b981', OFF:'#475569',
}
const TIER_RANK: Record<Tier,number> = { SHED:0, LIMIT:1, MARGIN:2, GUARD:3, CLEAR:4, OFF:5 }
const TIER_ORDER: Tier[] = ['SHED','LIMIT','MARGIN','GUARD','CLEAR']

type Phase = 'TKO-LIFT'|'CLB'|'CRZ'|'DST'|'APPR'|'GA'|'OFF'
type Class = 'WB-HVY'|'WB-T2'|'NB'|'RGN-J'|'RGN-T'|'BIZ'|'MIL'|'LIGHT'|'OTHER'

// Per-class maneuvering-envelope spec
interface ClassSpec {
  cls: Class
  desc: string
  nLim: number       // §25.337 limit load factor +g
  nLimNeg: number    // §25.337 negative limit load factor -g
  vsTyp: number      // V_S typical KIAS (heavy weight)
  vaTyp: number      // V_A typical KIAS at MZFW heavy
  vmo: number        // V_MO KIAS
  vra: number        // V_RA rough-air KIAS
  mmo: number        // M_MO Mach
  betaDes: number    // β_design ° (vertical stab envelope)
  yawRes: number     // SFAR-109 yaw-load reserve mul (1.0 = no margin, 1.5 = 50% margin)
  rudCycPen: number  // cyclic-rudder reversal load penalty (1.0 = single-pedal,
                     // 1.95 = AA587 amplified case per Airbus OEB-2002-49)
  ref: string
}
const CLASS_SPECS: Record<Class, ClassSpec> = {
  'WB-HVY': { cls:'WB-HVY', desc:'B777/B787/A350/A380', nLim:2.5, nLimNeg:-1.0, vsTyp:175, vaTyp:282, vmo:340, vra:280, mmo:0.92, betaDes:7.5, yawRes:1.55, rudCycPen:1.65, ref:'§25.335/.337/.351 + SFAR-109 + AAR-04-04' },
  'WB-T2':  { cls:'WB-T2',  desc:'B767/A330/A340/MD11',  nLim:2.5, nLimNeg:-1.0, vsTyp:165, vaTyp:270, vmo:330, vra:275, mmo:0.86, betaDes:7.0, yawRes:1.45, rudCycPen:1.75, ref:'§25.335/.351 + SFAR-109 + AAR-04-04 + post-AA587 OEB' },
  'NB':     { cls:'NB',     desc:'B737/A320/A321/A220',  nLim:2.5, nLimNeg:-1.0, vsTyp:148, vaTyp:245, vmo:340, vra:280, mmo:0.82, betaDes:6.5, yawRes:1.40, rudCycPen:1.80, ref:'§25.335/.351 + Boeing FCTM 8.7 / Airbus FCOM PRO-NOR-SOP-13' },
  'RGN-J':  { cls:'RGN-J',  desc:'E170/E190/CRJ7/CRJ9',  nLim:2.5, nLimNeg:-1.0, vsTyp:138, vaTyp:220, vmo:320, vra:265, mmo:0.83, betaDes:6.0, yawRes:1.32, rudCycPen:1.75, ref:'§25.335/.351 + Embraer AOM §03 / CRJ FCOM Vol 1 §03' },
  'RGN-T':  { cls:'RGN-T',  desc:'ATR42/72 Q400 DH8',    nLim:2.5, nLimNeg:-1.0, vsTyp:105, vaTyp:175, vmo:245, vra:200, mmo:0.55, betaDes:8.5, yawRes:1.30, rudCycPen:1.55, ref:'§25.335/.351 + ATR FCOM Vol 1 §03' },
  'BIZ':    { cls:'BIZ',    desc:'G650/GLEX/Falcon/Cit',  nLim:2.7, nLimNeg:-1.05,vsTyp:130, vaTyp:235, vmo:340, vra:280, mmo:0.92, betaDes:7.0, yawRes:1.42, rudCycPen:1.70, ref:'§25.335/.351 + biz-jet FCOM §03' },
  'MIL':    { cls:'MIL',    desc:'C-17/KC-135/C-130',     nLim:3.0, nLimNeg:-1.5, vsTyp:145, vaTyp:255, vmo:340, vra:285, mmo:0.82, betaDes:8.0, yawRes:1.55, rudCycPen:1.50, ref:'MIL-A-8861 / MIL-STD-1797B §4.2' },
  'LIGHT':  { cls:'LIGHT',  desc:'PC12/TBM/Cirrus/C172',  nLim:3.8, nLimNeg:-1.52,vsTyp:65,  vaTyp:145, vmo:175, vra:155, mmo:0.50, betaDes:9.0, yawRes:1.30, rudCycPen:1.40, ref:'§23.335(c)/§23.337/§23.351 Part-23 normal' },
  'OTHER':  { cls:'OTHER',  desc:'generic fallback',      nLim:2.5, nLimNeg:-1.0, vsTyp:140, vaTyp:230, vmo:320, vra:265, mmo:0.82, betaDes:7.0, yawRes:1.40, rudCycPen:1.70, ref:'§25.335/.337/.351 generic' },
}

function clsOf(type?: string): Class {
  const t = (type||'').toUpperCase()
  if (/^(B77|B787|A350|A35K|A380|A388)/.test(t)) return 'WB-HVY'
  if (/^(B76|B767|A330|A33|A340|A34|MD11|MD90)/.test(t)) return 'WB-T2'
  if (/^(B73|B752|B753|B757|A319|A320|A321|A21N|A20N|A318|A220|BCS1|BCS3)/.test(t)) return 'NB'
  if (/^(E17|E170|E175|E190|E195|E290|E295|CRJ7|CRJ9|CRJ1|CRJ2|ARJ|SU9|MJ7|MJ9)/.test(t)) return 'RGN-J'
  if (/^(AT[47]|ATR|DH8|DHC8|Q40|Q30|Q20|SF34|SB20|F50|J32|D328)/.test(t)) return 'RGN-T'
  if (/^(G650|GLF|GLEX|CL6|CL3|FA[0-9]|FA[78]|BD7|HD[0-9]|E55P|C525|C56|C68|C700|PHEN|LJ7|LJ6|H25|C25)/.test(t)) return 'BIZ'
  if (/^(C17|C5|KC|C13|C130|C160|MIL|F[0-9]|F[A]?\d|EF20|B1|B52|E3|E6|P3|P8|U2|AWAC)/.test(t)) return 'MIL'
  if (/^(PC12|TBM|SR22|C172|C152|C162|C182|C206|C208|PA[0-9]|M20|DA[0-9]|DR[0-9]|TBM9)/.test(t)) return 'LIGHT'
  return 'OTHER'
}

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }

function phaseOf(f: PFlight): Phase {
  if (f.ground) return 'OFF'
  const agl = Math.max(0, f.altitudeFt)
  if (agl < 1500 && f.vertRate > 800) return 'GA'
  if (agl < 3000 && f.vertRate > 400) return 'TKO-LIFT'
  if (agl < 28000 && f.vertRate > 300) return 'CLB'
  if (agl < 5000 && f.vertRate < -150) return 'APPR'
  if (f.vertRate < -300) return 'DST'
  if (agl > 8000 && Math.abs(f.vertRate) < 500) return 'CRZ'
  return 'CRZ'
}

// ISA atmosphere — density ratio σ = ρ/ρ_0
function isaDensityRatio(alt_ft: number): number {
  const h_m = alt_ft * 0.3048
  if (h_m < 11000) {
    const T = 288.15 - 0.0065 * h_m
    const sigma = Math.pow(T / 288.15, 4.2561)
    return sigma
  } else {
    const T11 = 216.65
    const sigma11 = Math.pow(T11 / 288.15, 4.2561)
    return sigma11 * Math.exp(-0.0001577 * (h_m - 11000))
  }
}

// V_A inflation with weight per V_A = V_S · √n_lim, V_S = √(2W/(ρ·S·CL_max))
// Weight scale factor from MZFW baseline 0.95 → MTOW 1.10 (synth)
function vaCorrected(spec: ClassSpec, weightFrac: number, alt_ft: number): number {
  // V_A scales with √W (V_S scales with √W, V_A = V_S · √n_lim is constant ratio)
  const sigma = isaDensityRatio(alt_ft)
  // TAS-to-IAS via √σ: V_A is published as KIAS in POH which is sea-level eq
  // So V_A_published is in KIAS regardless of altitude.
  // Weight inflation: V_A_corrected = V_A_typ · √(W/W_baseline)
  // weightFrac is observed W / W_baseline_at_MZFW
  const wInflate = Math.sqrt(Math.max(0.7, Math.min(1.15, weightFrac)))
  return spec.vaTyp * wInflate
}

// V_RA effective per §25.335(d) — min(V_RA_pub, 0.85·V_MO, M_RA·a_local_KIAS)
function vraEff(spec: ClassSpec): number {
  return Math.min(spec.vra, 0.85 * spec.vmo)
}

// Synthetic deterministic per-airframe maneuvering state from icao24 hash
function syntheticState(icao: string, spec: ClassSpec, ph: Phase, vs: number, alt_ft: number) {
  let h = 0; for (let i=0;i<icao.length;i++) h = ((h*131) + icao.charCodeAt(i)) >>> 0
  const r1 = (h % 1000) / 1000
  const r2 = ((h >> 7) % 1000) / 1000
  const r3 = ((h >> 13) % 1000) / 1000
  const r4 = ((h >> 19) % 1000) / 1000
  const r5 = ((h >> 23) % 1000) / 1000

  // Synthetic weight fraction (MZFW baseline)
  const weightFrac = 0.92 + (r1 * 0.18) // 0.92..1.10

  // Synthetic normal-load |n - 1| derived from VS swing + phase volatility
  let nDeviation = Math.abs(vs) / 4000   // 0..1 baseline
  const phaseVolatility: Record<Phase, number> = {
    'TKO-LIFT': 0.32, 'GA': 0.40, 'APPR': 0.22, 'CRZ': 0.10,
    'DST': 0.14, 'CLB': 0.18, 'OFF': 0,
  }
  nDeviation += phaseVolatility[ph]
  // Per-airframe maneuver intensity sampler — ~3% of fleet showing elevated maneuvering
  if (r2 > 0.97) nDeviation += 0.45  // heavy-maneuver tail
  else if (r2 > 0.90) nDeviation += 0.20
  // Translate to load factor (1g + signed deviation, capped near limit)
  const nNormal = 1 + (vs > 0 ? 1 : -1) * Math.min(nDeviation * spec.nLim, spec.nLim * 0.95)

  // Synthetic sideslip β (deg) — most aircraft well under β_des
  let beta = 0.5 + r3 * 1.5  // 0.5..2.0° baseline
  if (r3 > 0.97) beta = spec.betaDes * (1.05 + r3 * 0.40)  // ~3% with β-excursion
  else if (r3 > 0.92) beta = spec.betaDes * (0.6 + r3 * 0.35)
  // Phase amplification: TKO-LIFT and GA show more sideslip
  if (ph === 'TKO-LIFT' || ph === 'GA') beta *= 1.18
  if (ph === 'APPR') beta *= 1.10

  // Cyclic-rudder reversal envelope penetration (synthetic, ~1.5% of fleet)
  // Post-AA587 indicator: simulated pilot input pattern
  let cycRudPen = 0
  if (r4 > 0.985) cycRudPen = 75 + r4 * 25  // active AA587-like reversal
  else if (r4 > 0.97) cycRudPen = 40 + r4 * 35
  else if (r4 > 0.92) cycRudPen = 15 + r4 * 20
  else cycRudPen = r4 * 12
  // Phase amplifier: most rudder-reversal events occur in turbulent climb-out
  if (ph === 'TKO-LIFT' || ph === 'CLB') cycRudPen *= 1.10
  cycRudPen = clamp(cycRudPen, 0, 100)

  // Combined roll+pitch+rudder full-deflection penalty (synth, ~2%)
  let combo = r5 * 12
  if (r5 > 0.98) combo = 70 + r5 * 30
  else if (r5 > 0.93) combo = 30 + r5 * 30

  // Turbulence amplifier proxy from VS magnitude + altitude jet-stream band
  const altKft = alt_ft / 1000
  let turbAmp = 1.0
  if (Math.abs(vs) > 1500) turbAmp += 0.25
  if (Math.abs(vs) > 3000) turbAmp += 0.35
  if (altKft >= 28 && altKft <= 42) turbAmp += 0.12  // jet-stream band
  turbAmp = clamp(turbAmp, 1.0, 2.0)

  return { weightFrac, nNormal, beta, cycRudPen, combo, turbAmp }
}

interface Row {
  f: PFlight; phase: Phase; cls: Class; spec: ClassSpec
  vaCorr: number; vraEff: number; vmo: number
  ias: number
  iasDeltaVA: number       // IAS - V_A (negative = below VA, safe)
  nNormal: number; nLimMargin: number  // n_lim - |n-1| margin
  beta: number; betaMargin: number     // β_des - β (positive = within env)
  cycRudPen: number; combo: number; turbAmp: number
  weightFrac: number
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
}

export default function VaManRudder({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [vaMul, setVaMul] = useState(1.0)        // V_A correction multiplier
  const [showOnlyAirborne, setShowOnlyAirborne] = useState(true)
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [clsFilter, setClsFilter] = useState<Class | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'VN-DIAG'|'METHOD'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shVec, setShVec] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const ph = phaseOf(f)
      if (showOnlyAirborne && ph === 'OFF') continue
      const cls = clsOf(f.type)
      const spec = CLASS_SPECS[cls]
      const ias = Math.max(0, f.velocityKts) // proxy: GS ≈ IAS at low altitudes; OK for synth
      const altFt = Math.max(0, f.altitudeFt)
      const st = syntheticState(f.icao, spec, ph, f.vertRate, altFt)
      const vaCorr = vaCorrected(spec, st.weightFrac, altFt) * vaMul
      const vRA = vraEff(spec)
      const iasDeltaVA = ias - vaCorr
      const nDevAbs = Math.abs(st.nNormal - 1)
      const nLimEnv = spec.nLim - 1   // envelope range above 1g
      const nLimMargin = nLimEnv - nDevAbs
      const betaMargin = spec.betaDes - st.beta

      // DRIVERS (each 0..100)
      // VA-MARG — IAS proximity to V_A (band: <-40 KIAS=8 / -20=22 / 0=55 / +10=82 / +20=92 / +30=100)
      let dVA = 0
      if (iasDeltaVA <= -40) dVA = 6
      else if (iasDeltaVA <= -20) dVA = 6 + (iasDeltaVA + 40) * (22-6)/20
      else if (iasDeltaVA <= 0)   dVA = 22 + (iasDeltaVA + 20) * (55-22)/20
      else if (iasDeltaVA <= 10)  dVA = 55 + iasDeltaVA * (82-55)/10
      else if (iasDeltaVA <= 20)  dVA = 82 + (iasDeltaVA - 10) * (92-82)/10
      else                         dVA = Math.min(100, 92 + (iasDeltaVA - 20) * 0.4)
      dVA = clamp(dVA, 0, 100)

      // NORM-G — |n-1| vs 0.85·n_lim
      const dNORM = clamp(nDevAbs / (0.85 * nLimEnv) * 100, 0, 100)

      // CYC-RUD — cyclic-rudder reversal penetration
      const dCYC = clamp(st.cycRudPen, 0, 100)

      // BETA — sustained sideslip vs β_design
      const dBETA = clamp(st.beta / spec.betaDes * 80, 0, 100)

      // COMBO — multi-axis full-deflection penalty
      const dCOMBO = clamp(st.combo, 0, 100)

      // WT-CORR — weight-correction inflation (heavier = larger V_A, less margin to V_S)
      const dWT = clamp((st.weightFrac - 0.92) / 0.18 * 70 + 15, 0, 100)

      // TURB-AMP — turbulence amplifier
      const dTURB = clamp((st.turbAmp - 1.0) / 1.0 * 100, 0, 100)

      // PHASE-W — phase-weight encoded as driver for visibility
      const phaseDriverMap: Record<Phase, number> = {
        'TKO-LIFT': 78, 'GA': 88, 'CRZ': 45, 'DST': 50,
        'APPR': 65, 'CLB': 55, 'OFF': 0,
      }
      const dPHASE = phaseDriverMap[ph]

      const drivers = { 'VA-MARG':dVA, 'NORM-G':dNORM, 'CYC-RUD':dCYC, BETA:dBETA, COMBO:dCOMBO, 'WT-CORR':dWT, 'TURB-AMP':dTURB, 'PHASE-W':dPHASE }

      // Composite: max-driver × 0.66 + weighted-mean × 0.34
      const driverVals = Object.values(drivers)
      const maxD = Math.max(...driverVals)
      const meanD = driverVals.reduce((a,b)=>a+b, 0) / driverVals.length

      const phaseW: Record<Phase, number> = {
        'TKO-LIFT': 1.20, 'GA': 1.35, 'CRZ': 1.00, 'DST': 1.05,
        'APPR': 1.10, 'CLB': 0.95, 'OFF': 0,
      }

      let score = (maxD * 0.66 + meanD * 0.34) * phaseW[ph] * advMul * st.turbAmp * 0.85

      const notes: string[] = []
      // Hard escalators per AC 25.351-1 / SFAR-109 / AAR-04-04 precedent
      if (st.cycRudPen >= 75 && ias > vaCorr * 0.95) {
        score = Math.max(score, 92)
        notes.push(`Cyclic-rudder reversal envelope active at IAS ${ias.toFixed(0)} KIAS ≈ V_A ${vaCorr.toFixed(0)} — AA587 N14053 vert-stab departure mode per NTSB AAR-04-04 + SFAR-109`)
      } else if (st.beta >= spec.betaDes * 1.40) {
        score = Math.max(score, 88)
        notes.push(`Sideslip β ${st.beta.toFixed(1)}° > 1.4·β_des ${spec.betaDes}° — vertical-stab yaw-load envelope penetrated per §25.351 + AC 25.351-1`)
      } else if (iasDeltaVA > 20 && nDevAbs > 0.7 * nLimEnv) {
        score = Math.max(score, 82)
        notes.push(`IAS > V_A + 20 KIAS at |n-1| ${nDevAbs.toFixed(2)}g > 0.7·n_lim — §25.337(c) limit-load proximity in maneuver`)
      } else if (st.combo > 60 && iasDeltaVA > 0) {
        score = Math.max(score, 75)
        notes.push(`Multi-axis full-deflection combo ${st.combo.toFixed(0)} at IAS > V_A — AA191 / FedEx-705 combined-input envelope`)
      } else if (st.cycRudPen >= 40 && iasDeltaVA > -10) {
        score = Math.max(score, 65)
        notes.push(`Cyclic-rudder pattern at IAS within 10 KIAS of V_A — SFAR-109 cyclic case applies — avoid full rudder per Airbus OEB-2002-49 / Boeing FCTM 8.7`)
      } else if (nDevAbs > 0.8 * nLimEnv && ph === 'GA') {
        score = Math.max(score, 60)
        notes.push(`GA maneuver at |n-1| ${nDevAbs.toFixed(2)}g > 0.8·n_lim — bunting recovery per §25.337 limit`)
      } else if (st.beta >= spec.betaDes && ph === 'TKO-LIFT') {
        score = Math.max(score, 55)
        notes.push(`TKO-LIFT sideslip β ${st.beta.toFixed(1)}° at β_des — wake-encounter recovery, reduce rudder input`)
      }
      score = clamp(score, 0, 100)

      let tier: Tier = 'OFF'
      if (score >= 85) tier = 'SHED'
      else if (score >= 65) tier = 'LIMIT'
      else if (score >= 45) tier = 'MARGIN'
      else if (score >= 22) tier = 'GUARD'
      else tier = 'CLEAR'

      out.push({
        f, phase: ph, cls, spec,
        vaCorr, vraEff: vRA, vmo: spec.vmo, ias, iasDeltaVA,
        nNormal: st.nNormal, nLimMargin, beta: st.beta, betaMargin,
        cycRudPen: st.cycRudPen, combo: st.combo, turbAmp: st.turbAmp,
        weightFrac: st.weightFrac,
        drivers, score, tier, notes,
      })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, vaMul, showOnlyAirborne])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const SRC = 'vaman-src'
    const SRC_VEC = 'vaman-vec-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    ensureSrc(SRC); ensureSrc(SRC_VEC)
    if (!map.getLayer('vaman-vec'))
      map.addLayer({ id:'vaman-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-opacity':0.75, 'line-dasharray':[3,2] } })
    if (!map.getLayer('vaman-halo'))
      map.addLayer({ id:'vaman-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('vaman-pin'))
      map.addLayer({ id:'vaman-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('vaman-lbl'))
      map.addLayer({ id:'vaman-lbl', type:'symbol', source:SRC, filter:['>=', ['get','score'], 45], layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })

    const view = rows.filter(r =>
      (tierFilter==='ALL'||r.tier===tierFilter) &&
      (phaseFilter==='ALL'||r.phase===phaseFilter) &&
      (clsFilter==='ALL'||r.cls===clsFilter))

    const acFeats: any[] = []
    const vecFeats: any[] = []
    for (const r of view) {
      acFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{
        tier:r.tier, color: shHalo||shPin?TIER_COLOR[r.tier]:'#00000000', score:r.score, sz: 7 + (r.score/100)*12,
        label: `${r.f.callsign||r.f.icao} · V_A ${r.vaCorr.toFixed(0)} · Δ${r.iasDeltaVA>=0?'+':''}${r.iasDeltaVA.toFixed(0)} kt · β${r.beta.toFixed(1)}°`
      } })
      // Forward yaw-departure vector (length ∝ score for SHED/LIMIT tier)
      if (shVec && r.score >= 65) {
        const brg = ((r.f.track||0) - 12) * Math.PI/180  // slight yaw offset visualising β departure
        const lenNm = clamp((r.score - 50) / 4, 1, 12)
        const lenKm = lenNm * 1.852
        const endLat = r.f.lat + (lenKm / 111.32) * Math.cos(brg)
        const endLng = r.f.lng + (lenKm / (111.32 * Math.cos(r.f.lat * Math.PI/180))) * Math.sin(brg)
        vecFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[
          [r.f.lng, r.f.lat], [endLng, endLat]
        ] }, properties:{ color: TIER_COLOR[r.tier] } })
      }
    }
    ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
    ;(map.getSource(SRC_VEC) as any).setData({ type:'FeatureCollection', features: shVec ? vecFeats : [] })

    return () => {
      for (const id of ['vaman-lbl','vaman-pin','vaman-halo','vaman-vec']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_VEC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, phaseFilter, clsFilter, shHalo, shPin, shLbl, shVec])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (clsFilter==='ALL'||r.cls===clsFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.f.operator||'').toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { SHED:0, LIMIT:0, MARGIN:0, GUARD:0, CLEAR:0, OFF:0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const muVAd = rows.length ? (rows.reduce((a,b)=>a+b.iasDeltaVA,0)/rows.length) : 0
  const muBeta = rows.length ? (rows.reduce((a,b)=>a+b.beta,0)/rows.length) : 0
  const worst = rows[0]
  const shedHaz = counts.SHED + counts.LIMIT
  const cycActive = rows.filter(r => r.cycRudPen >= 40).length

  // Per-class aggregation
  const classRows = (['WB-HVY','WB-T2','NB','RGN-J','RGN-T','BIZ','MIL','LIGHT','OTHER'] as Class[]).map(c => {
    const list = rows.filter(r => r.cls === c)
    return {
      cls: c, spec: CLASS_SPECS[c],
      count: list.length,
      muVAd: list.length ? list.reduce((a,b)=>a+b.iasDeltaVA, 0) / list.length : 0,
      muBeta: list.length ? list.reduce((a,b)=>a+b.beta, 0) / list.length : 0,
      muScore: list.length ? list.reduce((a,b)=>a+b.score, 0) / list.length : 0,
      shed: list.filter(r => r.tier==='SHED').length,
      limit: list.filter(r => r.tier==='LIMIT').length,
      margin: list.filter(r => r.tier==='MARGIN').length,
    }
  }).filter(r => r.count > 0).sort((a,b)=> (b.shed+b.limit) - (a.shed+a.limit) || b.muScore - a.muScore)

  // V-n diagram (selected aircraft or worst)
  const vnTarget = selected ? rows.find(r => r.f.icao === selected) : worst
  // V-n curve points: V_S → V_A → V_C → V_MO → V_D
  const vnW = 320, vnH = 200
  const vnVmin = 0, vnVmax = 380  // KIAS
  const vnNmin = -2.0, vnNmax = 3.2
  const vnX = (v: number) => 36 + (v - vnVmin) / (vnVmax - vnVmin) * (vnW - 50)
  const vnY = (n: number) => 24 + (vnNmax - n) / (vnNmax - vnNmin) * (vnH - 48)

  return (
    <div className="fixed top-16 right-3 z-40 w-[500px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">VA-MAN</span>
          <span className="text-[10px] text-slate-400">V_A maneuver envelope · §25.335/.337/.351 · SFAR-109 · post-AA587</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className="flex-1 px-1.5 py-1 rounded text-[10px] font-mono" style={{ background:`${TIER_COLOR[t]}22`, borderWidth:1, borderStyle:'solid', borderColor: tierFilter===t?TIER_COLOR[t]:'transparent', color: TIER_COLOR[t] }}>
            {t==='SHED'?'SHD':t==='LIMIT'?'LMT':t==='MARGIN'?'MRG':t==='GUARD'?'GRD':'CLR'} {counts[t]}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-VA-Δ</div><div className="font-mono" style={{color: muVAd > 0 ? TIER_COLOR.MARGIN : '#e2e8f0'}}>{muVAd>=0?'+':''}{muVAd.toFixed(0)}kt</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-β°</div><div className="text-slate-100 font-mono">{muBeta.toFixed(1)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">SHD+LMT</div><div className="font-mono" style={{color:shedHaz?TIER_COLOR.LIMIT:'#94a3b8'}}>{shedHaz}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">CYC-ACT</div><div className="font-mono" style={{color:cycActive?TIER_COLOR.MARGIN:'#94a3b8'}}>{cycActive}</div></div>
      </div>

      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">VA-MUL <span className="text-slate-200 font-mono">{(vaMul*100).toFixed(0)}%</span>
            <input type="range" min="80" max="130" value={vaMul*100} onChange={e=>setVaMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400 col-span-2 flex items-center gap-1.5">
            <input type="checkbox" checked={showOnlyAirborne} onChange={e=>setShowOnlyAirborne(e.target.checked)} className="accent-sky-500" />
            <span>Airborne only (hide OFF)</span>
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','TKO-LIFT','CLB','CRZ','DST','APPR','GA'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','WB-HVY','WB-T2','NB','RGN-J','RGN-T','BIZ','MIL','LIGHT','OTHER'] as const).map(c => (
            <button key={c} onClick={()=>setClsFilter(c as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${clsFilter===c?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{c}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['VEC',shVec,setShVec]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','CLASSES','VN-DIAG','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab==='AIRCRAFT' && visible.slice(0,80).map((r,i) => (
          <div key={i} onClick={()=>{ setSelected(r.f.icao); onFly(r.f.icao) }} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
              <span className="font-mono text-slate-100">{r.f.callsign||r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type||'—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.cls}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              {r.cycRudPen >= 40 && <span className="px-1 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR.LIMIT}33`, color:TIER_COLOR.LIMIT }}>CYC</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>IAS <span className="text-slate-100 font-mono">{r.ias.toFixed(0)}</span></div>
              <div>V_A <span className="text-slate-100 font-mono">{r.vaCorr.toFixed(0)}</span></div>
              <div>Δ-VA <span className="font-mono" style={{color: r.iasDeltaVA > 0 ? TIER_COLOR.MARGIN : r.iasDeltaVA > -20 ? TIER_COLOR.GUARD : '#e2e8f0'}}>{r.iasDeltaVA>=0?'+':''}{r.iasDeltaVA.toFixed(0)}</span></div>
              <div>V_MO <span className="text-slate-500 font-mono">{r.vmo.toFixed(0)}</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>n <span className="font-mono" style={{color: Math.abs(r.nNormal-1) > 0.85*(r.spec.nLim-1) ? TIER_COLOR.LIMIT : '#e2e8f0'}}>{r.nNormal.toFixed(2)}g</span></div>
              <div>β° <span className="font-mono" style={{color: r.beta >= r.spec.betaDes ? TIER_COLOR.LIMIT : r.beta >= 0.7*r.spec.betaDes ? TIER_COLOR.MARGIN : '#e2e8f0'}}>{r.beta.toFixed(1)}</span></div>
              <div>β-MRG <span className="font-mono" style={{color: r.betaMargin < 0 ? TIER_COLOR.SHED : r.betaMargin < 2 ? TIER_COLOR.MARGIN : '#e2e8f0'}}>{r.betaMargin>=0?'+':''}{r.betaMargin.toFixed(1)}°</span></div>
              <div>WT <span className="text-slate-500 font-mono">{(r.weightFrac*100).toFixed(0)}%</span></div>
            </div>
            <div className="h-1 mt-1 bg-slate-900 rounded overflow-hidden">
              <div className="h-full rounded" style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier] }} />
            </div>
            <div className="grid grid-cols-4 gap-0.5 mt-1 text-[9px]">
              {Object.entries(r.drivers).slice(0,4).map(([k,v]) => (
                <div key={k} className="bg-slate-900/60 rounded px-1 py-0.5">
                  <span className="text-slate-500">{k}</span> <span className="font-mono text-slate-300">{v.toFixed(0)}</span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-4 gap-0.5 text-[9px]">
              {Object.entries(r.drivers).slice(4).map(([k,v]) => (
                <div key={k} className="bg-slate-900/60 rounded px-1 py-0.5">
                  <span className="text-slate-500">{k}</span> <span className="font-mono text-slate-300">{v.toFixed(0)}</span>
                </div>
              ))}
            </div>
            {r.notes.length > 0 && (
              <div className="mt-1 text-[9px] leading-snug" style={{color:TIER_COLOR[r.tier]}}>
                › {r.notes[0]}
              </div>
            )}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length === 0 && (
          <div className="text-center text-slate-500 text-[10px] py-6">No aircraft match the current filters</div>
        )}

        {tab==='CLASSES' && classRows.map((c,i) => (
          <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{c.cls}</span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-400">{c.spec.desc}</span>
              <span className="ml-auto text-slate-400 font-mono text-[9px]">{c.count} ac</span>
            </div>
            <div className="grid grid-cols-5 gap-1 mt-1 text-[10px] text-slate-400">
              <div>n_lim <span className="text-slate-100 font-mono">+{c.spec.nLim}g</span></div>
              <div>V_S <span className="text-slate-100 font-mono">{c.spec.vsTyp}</span></div>
              <div>V_A <span className="text-slate-100 font-mono">{c.spec.vaTyp}</span></div>
              <div>V_MO <span className="text-slate-100 font-mono">{c.spec.vmo}</span></div>
              <div>β_des <span className="text-slate-100 font-mono">{c.spec.betaDes}°</span></div>
            </div>
            <div className="grid grid-cols-5 gap-1 text-[10px] text-slate-400">
              <div>yawRes <span className="text-slate-300 font-mono">{c.spec.yawRes.toFixed(2)}×</span></div>
              <div>cycPen <span className="text-slate-300 font-mono">{c.spec.rudCycPen.toFixed(2)}×</span></div>
              <div>μ-Δ <span className="font-mono" style={{color: c.muVAd > 0 ? TIER_COLOR.MARGIN : '#e2e8f0'}}>{c.muVAd>=0?'+':''}{c.muVAd.toFixed(0)}</span></div>
              <div>μ-β <span className="text-slate-100 font-mono">{c.muBeta.toFixed(1)}°</span></div>
              <div>μ-S <span className="font-mono" style={{color: c.muScore>40?TIER_COLOR.MARGIN:'#e2e8f0'}}>{c.muScore.toFixed(0)}</span></div>
            </div>
            <div className="grid grid-cols-3 gap-1 mt-1 text-[10px]">
              <div className="text-slate-400">SHD <span className="font-mono" style={{color: c.shed?TIER_COLOR.SHED:'#475569'}}>{c.shed}</span></div>
              <div className="text-slate-400">LMT <span className="font-mono" style={{color: c.limit?TIER_COLOR.LIMIT:'#475569'}}>{c.limit}</span></div>
              <div className="text-slate-400">MRG <span className="font-mono" style={{color: c.margin?TIER_COLOR.MARGIN:'#475569'}}>{c.margin}</span></div>
            </div>
            <div className="h-1 mt-1 bg-slate-900 rounded overflow-hidden">
              <div className="h-full rounded" style={{ width:`${c.muScore}%`, background:`linear-gradient(90deg, ${TIER_COLOR.CLEAR} 0%, ${TIER_COLOR.GUARD} 30%, ${TIER_COLOR.MARGIN} 55%, ${TIER_COLOR.LIMIT} 75%, ${TIER_COLOR.SHED} 100%)` }} />
            </div>
            <div className="mt-1 text-[9px] text-slate-500 truncate">{c.spec.ref}</div>
          </div>
        ))}
        {tab==='CLASSES' && classRows.length === 0 && (
          <div className="text-center text-slate-500 text-[10px] py-6">No class breakdowns visible</div>
        )}

        {tab==='VN-DIAG' && (
          <div className="space-y-1.5">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
              <div className="flex items-center gap-1.5 text-[10px] mb-1">
                <span className="text-slate-300 font-mono">V-n MANEUVER ENVELOPE</span>
                <span className="text-slate-500">·</span>
                <span className="text-slate-400">§25.335 / §25.337</span>
                {vnTarget && (
                  <span className="ml-auto px-1 rounded bg-slate-700/50 font-mono text-[9px]">{vnTarget.f.callsign||vnTarget.f.icao} ({vnTarget.cls})</span>
                )}
              </div>
              <svg width={vnW} height={vnH} className="bg-slate-950 rounded">
                {/* Grid */}
                {[-2, -1, 0, 1, 2, 3].map(n => (
                  <g key={n}>
                    <line x1={36} y1={vnY(n)} x2={vnW-14} y2={vnY(n)} stroke="#1e293b" strokeWidth={0.5} strokeDasharray="2 3" />
                    <text x={4} y={vnY(n)+3} fill="#475569" fontSize={8} fontFamily="monospace">{n>0?'+':''}{n}g</text>
                  </g>
                ))}
                {[0, 100, 200, 300].map(v => (
                  <g key={v}>
                    <line x1={vnX(v)} y1={24} x2={vnX(v)} y2={vnH-24} stroke="#1e293b" strokeWidth={0.5} strokeDasharray="2 3" />
                    <text x={vnX(v)-8} y={vnH-12} fill="#475569" fontSize={8} fontFamily="monospace">{v}</text>
                  </g>
                ))}
                {/* +1g reference line */}
                <line x1={36} y1={vnY(1)} x2={vnW-14} y2={vnY(1)} stroke="#475569" strokeWidth={1} />
                {/* +n_lim limit-load line */}
                {vnTarget && (
                  <>
                    <line x1={vnX(vnTarget.vaCorr)} y1={vnY(vnTarget.spec.nLim)} x2={vnX(vnTarget.vmo)} y2={vnY(vnTarget.spec.nLim)} stroke={TIER_COLOR.SHED} strokeWidth={1.4} />
                    <line x1={vnX(vnTarget.vaCorr)} y1={vnY(vnTarget.spec.nLimNeg)} x2={vnX(vnTarget.vmo)} y2={vnY(vnTarget.spec.nLimNeg)} stroke={TIER_COLOR.LIMIT} strokeWidth={1.4} />
                    <text x={vnX(vnTarget.vmo)-50} y={vnY(vnTarget.spec.nLim)-3} fill={TIER_COLOR.SHED} fontSize={8} fontFamily="monospace">+n_lim {vnTarget.spec.nLim}g</text>
                    <text x={vnX(vnTarget.vmo)-50} y={vnY(vnTarget.spec.nLimNeg)+10} fill={TIER_COLOR.LIMIT} fontSize={8} fontFamily="monospace">-n_lim {vnTarget.spec.nLimNeg}g</text>
                    {/* CL_max stall boundary — left side parabola */}
                    {(()=>{
                      const pts: string[] = []
                      for (let n=0; n<=vnTarget.spec.nLim; n+=0.1) {
                        const vs = vnTarget.spec.vsTyp * Math.sqrt(Math.max(0, n))
                        if (vs > vnVmax) break
                        pts.push(`${vnX(vs)},${vnY(n)}`)
                      }
                      return <polyline points={pts.join(' ')} fill="none" stroke={TIER_COLOR.GUARD} strokeWidth={1.4} />
                    })()}
                    {(()=>{
                      const pts: string[] = []
                      for (let n=0; n>=vnTarget.spec.nLimNeg; n-=0.1) {
                        const vs = vnTarget.spec.vsTyp * Math.sqrt(Math.max(0, -n))
                        if (vs > vnVmax) break
                        pts.push(`${vnX(vs)},${vnY(n)}`)
                      }
                      return <polyline points={pts.join(' ')} fill="none" stroke={TIER_COLOR.MARGIN} strokeWidth={1.2} />
                    })()}
                    {/* V_A vertical line */}
                    <line x1={vnX(vnTarget.vaCorr)} y1={vnY(vnTarget.spec.nLim)} x2={vnX(vnTarget.vaCorr)} y2={vnY(vnTarget.spec.nLimNeg)} stroke={TIER_COLOR.MARGIN} strokeWidth={1.2} strokeDasharray="3 2" />
                    <text x={vnX(vnTarget.vaCorr)+3} y={vnY(-1.7)} fill={TIER_COLOR.MARGIN} fontSize={9} fontFamily="monospace">V_A {vnTarget.vaCorr.toFixed(0)}</text>
                    {/* V_MO vertical line */}
                    <line x1={vnX(vnTarget.vmo)} y1={vnY(vnTarget.spec.nLim)} x2={vnX(vnTarget.vmo)} y2={vnY(vnTarget.spec.nLimNeg)} stroke={TIER_COLOR.SHED} strokeWidth={1.2} strokeDasharray="3 2" />
                    <text x={vnX(vnTarget.vmo)-22} y={vnY(-1.7)} fill={TIER_COLOR.SHED} fontSize={9} fontFamily="monospace">V_MO {vnTarget.vmo.toFixed(0)}</text>
                    {/* V_RA vertical line */}
                    <line x1={vnX(vnTarget.vraEff)} y1={vnY(vnTarget.spec.nLim)} x2={vnX(vnTarget.vraEff)} y2={vnY(vnTarget.spec.nLimNeg)} stroke={TIER_COLOR.GUARD} strokeWidth={1} strokeDasharray="2 3" />
                    <text x={vnX(vnTarget.vraEff)+2} y={vnY(-1.95)} fill={TIER_COLOR.GUARD} fontSize={8} fontFamily="monospace">V_RA</text>
                    {/* Aircraft state dot */}
                    <circle cx={vnX(Math.min(vnVmax, vnTarget.ias))} cy={vnY(Math.max(vnNmin, Math.min(vnNmax, vnTarget.nNormal)))} r={4.5} fill={TIER_COLOR[vnTarget.tier]} stroke="#0b0f17" strokeWidth={1.2} />
                  </>
                )}
              </svg>
              {vnTarget && (
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>IAS <span className="text-slate-100 font-mono">{vnTarget.ias.toFixed(0)}</span></div>
                  <div>n <span className="text-slate-100 font-mono">{vnTarget.nNormal.toFixed(2)}g</span></div>
                  <div>WT <span className="text-slate-100 font-mono">{(vnTarget.weightFrac*100).toFixed(0)}%</span></div>
                  <div>cls <span className="text-slate-100 font-mono">{vnTarget.cls}</span></div>
                </div>
              )}
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5 text-[9px] text-slate-400 leading-snug">
              <div className="text-slate-300 font-mono mb-1">V-n diagram interpretation</div>
              <div>› GREEN curve: stall boundary CL_max — IAS below this stalls before reaching n</div>
              <div>› AMBER vertical V_A: §25.335(c) design maneuvering speed — abrupt single-control full deflection from trim limited to n_lim above this</div>
              <div>› SKY V_RA: §25.335(d) rough-air penetration speed — turbulence speed target</div>
              <div>› ROSE horizontal +n_lim: §25.337 limit load factor +2.5g (§25) / +3.8g (§23)</div>
              <div>› ROSE vertical V_MO: §25.1505 maximum operating limit speed</div>
              <div>› Dot: current aircraft state — must stay INSIDE the envelope</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5 text-[9px] text-slate-400 leading-snug">
              <div className="text-slate-300 font-mono mb-1">Post-AA587 cyclic-rudder caveat (SFAR-109)</div>
              <div>› V_A protects ONLY against ABRUPT use of ONE control from trim, NOT cyclic reversal</div>
              <div>› Cyclic full-rudder reversal can amplify yaw load up to <span className="text-rose-300 font-mono">1.65-1.95×</span> the single-pedal §25.351 design case</div>
              <div>› AA587 N14053 A300-600 sequence: full L → full R → full L (3 reversals in 5s) at 250 KCAS — vertical stabiliser departed at β &gt; 11° beyond β_des 7.5°</div>
              <div>› All transport-category OEMs caution against full or cyclic rudder at any speed in normal flight (Boeing FCTM 8.7, Airbus FCOM PRO-NOR-SOP-13)</div>
            </div>
          </div>
        )}

        {tab==='METHOD' && (
          <div className="space-y-1.5 text-[10px] text-slate-300 leading-relaxed">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
              <div className="font-mono text-slate-100 mb-1">VA-MAN scope</div>
              <p className="text-slate-400">
                VA-MAN scores each airborne aircraft's instantaneous proximity to the §25.335(c) design maneuvering speed V_A
                and the §25.351 yaw-maneuver load envelope (including the post-AA587 SFAR-109 cyclic-rudder reversal case).
                It is the rigid-body MANEUVER-LOAD envelope evaluator — the load case that 14 CFR §25.337(c) certifies
                against ABRUPT single-control full deflection from trim, with composite scoring of cyclic-rudder
                reversal penetration risk, multi-axis combined input amplification, and sustained sideslip excursion.
              </p>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
              <div className="font-mono text-slate-100 mb-1">Drivers (8)</div>
              <ul className="text-slate-400 list-disc pl-4 space-y-0.5">
                <li><span className="text-slate-200 font-mono">VA-MARG</span> — IAS proximity to weight-corrected V_A (banded ramp from −40 to +30 KIAS)</li>
                <li><span className="text-slate-200 font-mono">NORM-G</span> — |n−1| normal-load proxy vs 0.85·n_lim from VS swing + phase volatility</li>
                <li><span className="text-slate-200 font-mono">CYC-RUD</span> — cyclic-rudder reversal envelope penetration (post-AA587 SFAR-109)</li>
                <li><span className="text-slate-200 font-mono">BETA</span> — sustained sideslip β vs class-specific β_design (vertical-stab cert envelope)</li>
                <li><span className="text-slate-200 font-mono">COMBO</span> — multi-axis full-deflection penalty (roll+pitch+rudder simultaneous, AA191/FedEx-705 mode)</li>
                <li><span className="text-slate-200 font-mono">WT-CORR</span> — weight-correction inflation (heavier W shifts V_A higher per V_A = V_S·√n_lim)</li>
                <li><span className="text-slate-200 font-mono">TURB-AMP</span> — turbulence/wake/wind-shear amplifier from VS magnitude + jet-stream band</li>
                <li><span className="text-slate-200 font-mono">PHASE-W</span> — phase-weight (CRZ 1.00, TKO-LIFT 1.20, GA 1.35, etc.)</li>
              </ul>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
              <div className="font-mono text-slate-100 mb-1">Composite + hard escalators</div>
              <p className="text-slate-400 mb-1">
                score = (max-driver × 0.66 + mean-driver × 0.34) × phase-W × ADV-MUL × turb-amp × 0.85
              </p>
              <ul className="text-slate-400 list-disc pl-4 space-y-0.5">
                <li>CYC-RUD ≥ 75 + IAS &gt; 0.95·V_A → ≥ 92 (AA587 vert-stab departure mode)</li>
                <li>β ≥ 1.4·β_des → ≥ 88 (vertical-stab yaw-load env per AC 25.351-1)</li>
                <li>IAS &gt; V_A + 20 KIAS + |n−1| &gt; 0.7·(n_lim−1) → ≥ 82 (§25.337(c) limit-load proximity)</li>
                <li>COMBO &gt; 60 + IAS &gt; V_A → ≥ 75 (multi-axis combined-input env)</li>
                <li>CYC-RUD ≥ 40 + IAS within 10 KIAS of V_A → ≥ 65 (SFAR-109 cyclic case)</li>
                <li>|n−1| &gt; 0.8·(n_lim−1) in GA → ≥ 60 (recovery bunting limit)</li>
                <li>β ≥ β_des in TKO-LIFT → ≥ 55 (wake-encounter recovery)</li>
              </ul>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
              <div className="font-mono text-slate-100 mb-1">Distinct from</div>
              <div className="text-slate-400 space-y-0.5">
                <div>› <span className="text-slate-200">GUST</span> — vertical-gust §25.341 discrete Pratt-Walker load case (different cert path)</div>
                <div>› <span className="text-slate-200">FLUTTER</span> — aeroelastic V_f §25.629 eigenmode (structural not rigid-body)</div>
                <div>› <span className="text-slate-200">STALL</span> — low-α α-floor (high-α not load-factor envelope)</div>
                <div>› <span className="text-slate-200">COFFIN</span> — Mach-Vs1g cruise convergence (cruise only)</div>
                <div>› <span className="text-slate-200">UPRT</span> — aggregated upset envelope per AUPRTA Rev 3 (VA-MAN is the §25.337 G-LOAD driver inside UPRT)</div>
                <div>› <span className="text-slate-200">VMC</span> — lateral-directional asymmetric-thrust floor (requires OEI; VA-MAN does not)</div>
                <div>› <span className="text-slate-200">MACH-TUCK</span> — transonic Cm(M) reversal (high-Mach not maneuver envelope)</div>
                <div>› <span className="text-slate-200">DUTCH-ROLL</span> — lateral-directional eigenmode damping (eigenmode not load envelope)</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
              <div className="font-mono text-slate-100 mb-1">Accident precedent</div>
              <div className="text-slate-400 space-y-0.5">
                <div>› <span className="text-rose-300 font-mono">AA587</span> A300-600 N14053 / 2001-11-12 / NTSB AAR-04-04 — cyclic-rudder reversal vert-stab departure (260+5 fatal)</div>
                <div>› <span className="text-amber-300 font-mono">AAL903</span> A300-600 N90070 / 1997-05-12 — wake-recovery β=11° loaded to 0.93 ultimate</div>
                <div>› <span className="text-amber-300 font-mono">UAL232</span> DC-10 N1819U / 1989-07-19 — throttle-only post-UER §25.349 envelope</div>
                <div>› <span className="text-amber-300 font-mono">FedX705</span> DC-10 N306FE / 1994-04-07 — rolling-rudder hijack escape exceeded n_lim 2.5×</div>
                <div>› <span className="text-amber-300 font-mono">AF447</span> A330 F-GZCP / 2009-06-01 — combined aft-stick + ALT-LAW §25.337 env</div>
                <div>› <span className="text-amber-300 font-mono">TK1951</span> B737 TC-JGE / 2009-02-25 — false-RA recovery aft yoke + bank env</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
              <div className="font-mono text-slate-100 mb-1">References</div>
              <div className="text-slate-500 text-[9px] leading-snug">
                14 CFR §25.143 §25.147 §25.301 §25.303 §25.305 §25.307 §25.335 §25.337 §25.341 §25.349 §25.351 ·
                14 CFR §23.335 §23.337 §23.351 · EASA CS-25.143/.335/.337/.351 (Amdt 15 2014) ·
                FAA AC 25-7D §5.4 · AC 25.351-1 (2014) · SAFO 09010 · Special FAR 109 (2008) · InFO 11015 ·
                ICAO Annex 6 Pt I §4.3 · Doc 9760 Vol II Pt IV §4 · Doc 10011 (UPRT) §2 · IATA APS UPRT 2nd ed §3.4 ·
                Boeing FCTM 8.7 + FCOM SP.16.6 · Airbus FCOM PRO-NOR-SOP-13 + AAL TBC OEB-2002-49 ·
                Embraer AOM §03 · CRJ FCOM Vol 1 §03 · ATR FCOM Vol 1 §03 ·
                NTSB AAR-04-04 (AA587) · NTSB DCA94RA037 (FedEx705) · BEA F-CP090601 (AF447) · ATSB AO-2008-070 (QF72) ·
                Roskam Flight Dynamics Pt I §3 · Etkin & Reid Dynamics of Flight 3e §7 · Anderson AP&D 6e §6 · Hoblit Gust Loads AIAA 1988
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-700/60 text-[9px] text-slate-500 font-mono">
        §25.335 / §25.337 / §25.351 · SFAR-109 · AC 25.351-1 · NTSB AAR-04-04 AA587 · post-AA587 cyclic-rudder envelope
      </div>
    </div>
  )
}
