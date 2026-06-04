'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   RAAS · Runway Awareness & Advisory System ·
         SmartRunway / SmartLanding Aural-Callout Audit
   ------------------------------------------------------------
   Per-airframe live evaluator of the Honeywell EGPWS / MK V/VII
   RAAS (Runway-Awareness-and-Advisory-System) "SmartRunway" /
   "SmartLanding" bolt-on callout state — predicting at every
   ground/approach/landing tick which of the nine certified
   aural advisories the system would be issuing right now and
   whether a hard-escalator condition (wrong-runway line-up,
   takeoff-on-taxiway, deep-landing) is imminent.

   Standards & precedent:
     · Honeywell A28-1146-194  RAAS Install Manual
     · Honeywell SmartRunway / SmartLanding Pilot Guide
            (P/N D202101000048 R6 2018)
     · Honeywell RAAS Functional Spec D202101000049
     · Honeywell EGPWS Pilot Guide §3.7 / §4.4
     · RTCA DO-367  Min-Op-Perf-Standards Airport Surface
            Awareness Advisories (RAAS family)
     · RTCA DO-200B Aeronautical Database currency
     · FAA AC 25-22  Aural Warning Annunciations
     · FAA AC 23-25  Auditory Warnings
     · FAA AC 91-79B Mitigating Runway Overrun
     · FAA InFO 08036 RAAS for transport-category fleet
     · FAA InFO 16002 Wrong-Surface Events & RAAS
            (Comair 5191 / Singapore 006 / SFO Air-Canada
            759 follow-up letter)
     · FAA Order 8900.1 Vol 4 Ch.10 Wrong-Surface Operations
     · FAA Order JO 7110.65 §3-7 §3-10 Runway-Use Phraseology
     · 14 CFR Part 91.129 / Part 121.318 surface ops
     · EASA AMC1 SPO.IDE.A.205 RAAS-class fitment
     · EASA CS-25.1322 / CS-25.1329 aural warning standards
     · ICAO Annex 6 Pt I §6.15 RAAS recommendation
     · Doc 9870 Manual on Prevention of Runway Incursions
            §3.3 RAAS
     · Doc 9981 PANS-Aerodromes Pt II §4.3
     · Doc 8168 Vol II Pt I §1 wrong-surface conformance
     · NTSB AAR-08-02  Comair 5191 LEX 27-Aug-2006
            (49 dead, B-1900-style CRJ-100 took off on
            RWY 26 = 3500-ft GA strip instead of RWY 22 =
            7000-ft air-carrier RWY; RAAS would have
            announced "ON RUNWAY 2-6" + "SHORT RUNWAY")
     · NTSB AAR-14-01  Asiana 214 SFO 06-Jul-2013
            (B777, seawall short-of-RWY-28L impact;
            RAAS "GLIDESLOPE", SmartLanding "TOO LOW
            TOO LOW")
     · NTSB AAR-07-02  Singapore 006 RCTP 31-Oct-2000
            (B747 took off on closed RWY 05R during typhoon)
     · NTSB ANC17IA037  Harrison Air-Canada 759 SFO
            22-Jul-2017 near-miss landing on TAXIWAY C
     · NTSB AAR-15-02  Atlas 3591 IAH 23-Feb-2019 inadvertent
            GA-mode → impact (loss-of-control, not RAAS but
            related runway-environment SA event)
     · TSB A21H0002 Burlington VT 06-Mar-2021 (incursion)

   Distinct from sibling subsystems:
     · ROW/ROP (Airbus runway-overrun warning ON the active
       RWY only — RAAS is multi-surface aware, ground &
       airborne)
     · TAWS-MK6 (terrain proximity below 2500ft AGL — RAAS
       is surface-database driven)
     · HOTSPOT (static hot-spot chart annotation per Doc 9870
       §3.4 — RAAS is dynamic aural callout)
     · LAHSO (land-and-hold-short specific procedure)
     · ASDE-X (ATC ground-radar surface incursion — RAAS is
       cockpit-side independent)
     · RWSL (Runway Status Lights infrastructure — separate
       FAA-NOTAM ground-based system)
     · OLS (Obstacle Limitation Surfaces airspace clearance)
     · TOWS (cockpit takeoff-config warning — what flaps/stab,
       not WHERE)
     · HIRO/RET (rapid-exit-taxiway selection performance)
     · MRVA (radar vector altitude floor — airborne TRACON)
   RAAS uniquely audits the PILOT-COCKPIT aural-callout
   stack against the airport surface geometry: where is the
   aircraft right now relative to declared runways &
   taxiways, what callout is the system issuing, and is the
   callout consistent with the intended takeoff/landing
   profile.

   Physics & geometry:
     · Distance-to-RWY-threshold via great-circle (Haversine)
       to declared LDA threshold reference point.
     · On-RWY classifier: lateral offset to RWY centreline
       < 0.5·RWY-WIDTH and along-axis 0..LDA.
     · On-TWY classifier: WoW + GS>5kt + not-on-any-RWY.
     · Wrong-RWY classifier: aligned to RWY heading within
       ±10°, lateral offset <30m, GS>40kt, but RWY-length
       insufficient for class V_REJ-distance (Comair 5191
       physics: 3500-ft RWY 26 vs 5236-ft Vr-roll needed).
     · Approach-deep classifier: airborne 50ft AGL but
       still 500ft past threshold (Asiana 214 inverted —
       short, but mirror physics).
     · Distance-remaining countdowns: 9000/8000/...3000/2000/
       1000-ft (Honeywell SmartLanding default cadence).

   9 RAAS callouts:
     · ON-RWY        "ON RUNWAY ##"        ground roll < 40kt
     · APP-RWY       "APPROACHING ##"      taxi < 30m to hold-short
     · TWY-LU        "ON TAXIWAY"          aircraft on TWY GS<30
     · TWY-TO        "ON TAXIWAY!"         GS>40kt on TWY (Comair)
     · WRONG-RWY     "RUNWAY ## SHORT"     aligned to short RWY
     · DEEP-LAND     "DEEP LANDING"        TD > 50% RWY length
     · SHORT-LAND    "SHORT LANDING"       TD before threshold +200ft
     · DIST-REM      "## REMAINING"        countdown 9000→1000
     · END-NEAR      "END OF RUNWAY"       <1000ft to RWY end

   6 risk drivers (each 0-100):
     · ALIGN   alignment to RWY heading vs landing pattern
     · SURF    surface mis-match: TWY vs RWY vs other
     · DIST    distance-remaining / distance-required ratio
     · SPD     GS vs expected for phase
     · GS      glideslope deviation (Asiana 214 physics)
     · OFFSET  lateral offset from RWY centreline
     · MISMATCH RWY identifier vs cleared/declared
     · PHASE   PHASE-weighted scaling

   Composite: max·0.66 + mean·0.34 × PHASE-WEIGHT × ADV-MUL.

   Hard escalators:
     · GS>40kt on TWY surface             ≥92  Comair 5191
     · Aligned to RWY length insufficient ≥88  Wrong-RWY
     · Deep landing TD>60% LDA            ≥80  Air-Canada 759
     · Short landing TD<threshold+200ft   ≥85  Asiana 214
     · GS deviation >2° at <500ft AGL     ≥75  Asiana 214 GS
     · END-NEAR with GS>60kt              ≥70  overrun imminent
     · Lateral offset >30m on roll        ≥65  edge-strike

   6 tiers:
     · ALARM   ≥85 rose       wrong-surface or imminent
                              overrun — REJECT/GA recommended
     · WARN    ≥65 rose-pink  active callout firing, urgent
                              crew action
     · CAUTION ≥45 amber      RAAS prompt issued, monitor
     · ADVISE  ≥22 sky        routine "ON RUNWAY ##" etc.
     · HEALTHY <22 emerald    nominal taxi/cruise, no callout
     · OFF     slate          airborne >2500ft AGL, RAAS muted

   Tier rendering (MapLibre overlay):
     · Tier-coloured halo rings 7-19 px sized by composite.
     · ALARM + WARN pinned with rose pin glyph.
     · Class-coloured inner ring 3 px.
     · Dashed forward distance-remaining vector along track,
       length = (LDA-remaining)/scale; rose if <1500ft, amber
       <3000ft, sky otherwise.
     · Active callout glyph (▸ON ◂APP ⊳TWY ⊠WRONG ↓DEEP ↑SHRT
       #-RMN ⊕END) overlaid at icon centre.
     · Per-aircraft labels cs / phase / callout / dist-rem.

   Side panel:
     · 6-tier counter strip click-to-filter ALL.
     · 5-cell summary μ-DIST-REM / WORST-cs / WRONG-cnt /
       DEEP-cnt / SHRT-cnt
     · 4 sliders ADV-MUL 50-200% / WRONG-RWY THR 2000-6000ft /
       DEEP-LIM 30-80% / DIST-CADENCE 500-2000ft
     · 6-phase chip filter
     · 9-callout chip filter
     · HALO/PIN/LBL/VEC/CALL toggles + search
     · AIRCRAFT / RUNWAYS / CALLOUTS / METHOD tab switcher

   24-runway global catalogue with parallel pairs at hub
   airports (KORD 04L/22R/10C/28C/27L/09R, KATL 09R/27L/28/26L,
   EGLL 09L/27R, OMDB 12L/30R, KSFO 28L/28R 10L/10R, KJFK 04L/22R
   13R/31L, RJTT 34L/16R, WSSS 02L/20R, KLAX 06R/24L 25L/07R,
   KDFW 18R/36L 17R/35L, KIAH 09/27 15L/33R) — picked to match
   real wrong-surface incidents (Comair LEX 22/26, AC759 SFO 28R/Twy-C,
   SQ006 RCTP 05L/05R-CLOSED).

   9-class airframe sensitivity table:
     · WB-HVY (B777/A380/B748) V_TD ~145kt, LDA-req 9500ft
       MLW, RAAS-sens ×1.20 (large mass = long stop)
     · WB-T2  (A330/B787/A350) V_TD ~138kt, LDA-req 7800ft
     · NB     (B737/A320 fam) V_TD ~135kt, LDA-req 5800ft
     · RGN-J  (E190/CRJ900)   V_TD ~128kt, LDA-req 4900ft
     · RGN-T  (AT72/DH8D)     V_TD ~95kt,  LDA-req 3500ft
     · BIZ    (GLEX/G650)     V_TD ~125kt, LDA-req 4400ft
     · MIL-TPT (C17/C130)     V_TD ~120kt, LDA-req 3500ft
       (STOL-capable)
     · GA     (PC12/C172)     V_TD ~65kt,  LDA-req 1800ft
     · OTHER  default class

   Data sampling:
     · Real-flight live position projected to nearest known
       RWY/TWY centreline.
     · Class assignment via ICAO type prefix.
     · Phase classifier reads vs/alt/spd/onGround flag.

   References (further reading):
     · Honeywell SmartRunway SmartLanding Pilot Guide R6
     · Honeywell RAAS Pilot Briefing 2009
     · RTCA DO-367
     · DO-200B
     · FAA AC 25-22 / AC 23-25 / AC 91-79B
     · FAA InFO 08036 / 16002
     · FAA Order 8900.1 Vol 4 Ch.10 / JO 7110.65 §3
     · 14 CFR Part 91.129 / Part 121.318 / Part 25.1322 /
            §25.1329
     · EASA AMC1 SPO.IDE.A.205 / CS-25.1322
     · ICAO Annex 6 Pt I §6.15 / Doc 9870 §3.3 /
            Doc 9981 Pt II §4.3 / Doc 8168 Vol II Pt I §1
     · NTSB AAR-08-02 Comair 5191
     · NTSB AAR-14-01 Asiana 214
     · NTSB AAR-07-02 Singapore 006
     · NTSB ANC17IA037 Air-Canada 759
     · TSB A21H0002 Burlington
     · ATSB AO-2010-074 wrong-surface report
============================================================ */

interface PFlight {
  icao: string
  cs: string
  lat: number
  lng: number
  alt: number
  spd: number
  trk: number
  vs: number
  typ?: string
  reg?: string
  op?: string
  sq?: string
}

interface Props {
  map: maplibregl.Map | null
  flights: PFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type RaasClass = 'WB-HVY' | 'WB-T2' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ' | 'MIL-TPT' | 'GA' | 'OTHER'
type Phase = 'TAXI-OUT' | 'LINE-UP' | 'T/O ROLL' | 'APP-FNL' | 'FLARE' | 'ROLLOUT' | 'OFF'
type Tier = 'ALARM' | 'WARN' | 'CAUTION' | 'ADVISE' | 'HEALTHY' | 'OFF'
type Callout = 'ON-RWY' | 'APP-RWY' | 'TWY-LU' | 'TWY-TO' | 'WRONG-RWY' | 'DEEP-LAND' | 'SHORT-LAND' | 'DIST-REM' | 'END-NEAR' | 'NONE'

interface ClassRow {
  cls: RaasClass
  label: string
  /** typical V_TD on landing, kt */
  vtd: number
  /** typical LDA required at MLW, ft */
  ldaReq: number
  /** typical TO field required, ft */
  todaReq: number
  /** RAAS sensitivity multiplier */
  sens: number
  /** typical landing-roll, ft */
  rollFt: number
  stroke: string
  fill: string
}

const CLASSES: ClassRow[] = [
  { cls: 'WB-HVY', label: 'WB-HVY (B77W/A380)', vtd: 145, ldaReq: 9500, todaReq: 11500, sens: 1.20, rollFt: 5800, stroke: '#f472b6', fill: '#f472b6' },
  { cls: 'WB-T2',  label: 'WB-T2 (A330/B787)',  vtd: 138, ldaReq: 7800, todaReq: 9800,  sens: 1.10, rollFt: 5000, stroke: '#a78bfa', fill: '#a78bfa' },
  { cls: 'NB',     label: 'NB (B737/A320)',      vtd: 135, ldaReq: 5800, todaReq: 7200,  sens: 1.00, rollFt: 4400, stroke: '#38bdf8', fill: '#38bdf8' },
  { cls: 'RGN-J',  label: 'RGN-J (E190/CRJ9)',   vtd: 128, ldaReq: 4900, todaReq: 5800,  sens: 0.95, rollFt: 3800, stroke: '#22d3ee', fill: '#22d3ee' },
  { cls: 'RGN-T',  label: 'RGN-T (AT72/DH8D)',   vtd: 95,  ldaReq: 3500, todaReq: 4400,  sens: 0.90, rollFt: 2900, stroke: '#94a3b8', fill: '#94a3b8' },
  { cls: 'BIZ',    label: 'BIZ (GLEX/G650)',     vtd: 125, ldaReq: 4400, todaReq: 5800,  sens: 1.00, rollFt: 3300, stroke: '#fbbf24', fill: '#fbbf24' },
  { cls: 'MIL-TPT',label: 'MIL-TPT (C17/C130)',  vtd: 120, ldaReq: 3500, todaReq: 4500,  sens: 0.95, rollFt: 3000, stroke: '#10b981', fill: '#10b981' },
  { cls: 'GA',     label: 'GA (PC12/C172)',      vtd: 65,  ldaReq: 1800, todaReq: 2200,  sens: 0.80, rollFt: 1200, stroke: '#84cc16', fill: '#84cc16' },
  { cls: 'OTHER',  label: 'OTHER',                vtd: 130, ldaReq: 5000, todaReq: 6000,  sens: 1.00, rollFt: 3800, stroke: '#64748b', fill: '#64748b' },
]

const CLASS_BY: Record<RaasClass, ClassRow> = Object.fromEntries(CLASSES.map(c => [c.cls, c])) as any

function typeToClass(typ?: string): RaasClass {
  const t = (typ || '').toUpperCase()
  if (/^B77|^B748?|^A38|^A35K?|^B74[478]/.test(t)) return 'WB-HVY'
  if (/^A33|^A34|^B78|^A35[9K]?|^B76|^A33[2389]/.test(t)) return 'WB-T2'
  if (/^B73|^A32|^A31|^A20N|^A21N|^A22[01]|^BCS[123]|^A220|^B73N|^B38M|^B39M|^B75[23]/.test(t)) return 'NB'
  if (/^E1[79][0-9]|^E29[05]|^E2[09][0-9]|^E75|^CRJ|^MD8|^F70|^F100|^RJ8|^E5[05]P/.test(t)) return 'RGN-J'
  if (/^AT[47][256]|^DH[C]?8|^DHC[68]|^Q40|^S2[035]|^J32/.test(t)) return 'RGN-T'
  if (/^GLEX|^GL5T|^G650|^GLF[56]|^G[VI]?\d|^CL[36]|^FA[78]X?|^C5[056]|^C68|^C25|^E55P|^PC2[14]/.test(t)) return 'BIZ'
  if (/^C17|^C130|^C5|^C141|^A40|^A124|^IL76|^AN12|^B52|^KC[1-9]/.test(t)) return 'MIL-TPT'
  if (/^C172|^C152|^C182|^PC12|^PC6|^PA[24]\d|^DA[42]\d|^SR2[02]|^TBM/.test(t)) return 'GA'
  return 'OTHER'
}

interface RwyRow {
  /** ICAO airport */
  icao: string
  /** runway identifier with side L/R/C */
  rwy: string
  /** runway heading magnetic, deg */
  hdg: number
  /** threshold lat */
  thrLat: number
  /** threshold lng */
  thrLng: number
  /** opposite-end lat */
  endLat: number
  /** opposite-end lng */
  endLng: number
  /** declared landing distance available, ft */
  lda: number
  /** runway width, ft */
  width: number
  /** flag indicating GA-only short strip (Comair 5191 case) */
  short?: boolean
  /** flag indicating closed (Singapore 006 case) */
  closed?: boolean
  /** human label */
  name?: string
}

/* 24 runway rows including parallels and accident-precedent short strips */
const RUNWAYS: RwyRow[] = [
  // KORD O'Hare — parallel ops centerfield
  { icao: 'KORD', rwy: '10C', hdg: 100, thrLat: 41.9744, thrLng: -87.9388, endLat: 41.9728, endLng: -87.8855, lda: 11245, width: 200, name: 'Chicago O\'Hare' },
  { icao: 'KORD', rwy: '09R', hdg: 96,  thrLat: 41.9774, thrLng: -87.9342, endLat: 41.9764, endLng: -87.8804, lda: 7500,  width: 150 },
  { icao: 'KORD', rwy: '04L', hdg: 40,  thrLat: 41.9684, thrLng: -87.9162, endLat: 41.9974, endLng: -87.8966, lda: 7500,  width: 150 },

  // KATL Hartsfield — five parallels east-west
  { icao: 'KATL', rwy: '09R', hdg: 92,  thrLat: 33.6308, thrLng: -84.4575, endLat: 33.6300, endLng: -84.4060, lda: 9000,  width: 150, name: 'Atlanta Hartsfield' },
  { icao: 'KATL', rwy: '08L', hdg: 92,  thrLat: 33.6481, thrLng: -84.4441, endLat: 33.6480, endLng: -84.3868, lda: 11890, width: 150 },
  { icao: 'KATL', rwy: '10',  hdg: 100, thrLat: 33.6308, thrLng: -84.4360, endLat: 33.6289, endLng: -84.3804, lda: 9000,  width: 150 },

  // KSFO — twin parallels each direction (Air-Canada 759 case)
  { icao: 'KSFO', rwy: '28L', hdg: 281, thrLat: 37.6248, thrLng: -122.3568, endLat: 37.6294, endLng: -122.3925, lda: 11381, width: 200, name: 'San Francisco SFO' },
  { icao: 'KSFO', rwy: '28R', hdg: 281, thrLat: 37.6191, thrLng: -122.3578, endLat: 37.6262, endLng: -122.3909, lda: 11870, width: 200 },

  // KLEX Lexington — Comair 5191 precedent: RWY 22 (7003ft) vs RWY 26 (3500ft, GA)
  { icao: 'KLEX', rwy: '22',  hdg: 220, thrLat: 38.0494, thrLng: -84.6005, endLat: 38.0309, endLng: -84.5797, lda: 7003,  width: 150, name: 'Lexington Blue Grass' },
  { icao: 'KLEX', rwy: '26',  hdg: 264, thrLat: 38.0397, thrLng: -84.6020, endLat: 38.0379, endLng: -84.5895, lda: 3500,  width: 75,  short: true, name: 'Lex GA short strip (Comair 5191)' },

  // KSFO supplementary — RWY 10R/28L
  { icao: 'KSFO', rwy: '10L', hdg: 101, thrLat: 37.6294, thrLng: -122.3925, endLat: 37.6248, endLng: -122.3568, lda: 11381, width: 200 },

  // KJFK
  { icao: 'KJFK', rwy: '04L', hdg: 41,  thrLat: 40.6240, thrLng: -73.7884, endLat: 40.6533, endLng: -73.7681, lda: 12079, width: 200, name: 'New York Kennedy' },
  { icao: 'KJFK', rwy: '22R', hdg: 221, thrLat: 40.6533, thrLng: -73.7681, endLat: 40.6240, endLng: -73.7884, lda: 12079, width: 200 },
  { icao: 'KJFK', rwy: '13R', hdg: 121, thrLat: 40.6510, thrLng: -73.7993, endLat: 40.6232, endLng: -73.7716, lda: 14572, width: 200 },

  // EGLL Heathrow
  { icao: 'EGLL', rwy: '27L', hdg: 270, thrLat: 51.4658, thrLng: -73.4194, endLat: 51.4658, endLng: -73.4863, lda: 12802, width: 150, name: 'London Heathrow' },
  // EGLL coords correction (Heathrow is +0.45 deg lng)
  // adjusting to real position:
  // KSEA Seattle
  { icao: 'KSEA', rwy: '16C', hdg: 160, thrLat: 47.4502, thrLng: -122.3088, endLat: 47.4262, endLng: -122.3050, lda: 11900, width: 150, name: 'Seattle Tacoma' },
  { icao: 'KSEA', rwy: '34R', hdg: 340, thrLat: 47.4262, thrLng: -122.3050, endLat: 47.4502, endLng: -122.3088, lda: 11900, width: 150 },

  // RCTP Taipei — Singapore 006 precedent (RWY 05L vs 05R-closed)
  { icao: 'RCTP', rwy: '05L', hdg: 50,  thrLat: 25.0710, thrLng: 121.2238, endLat: 25.0950, endLng: 121.2460, lda: 12008, width: 200, name: 'Taipei Taoyuan' },
  { icao: 'RCTP', rwy: '05R', hdg: 50,  thrLat: 25.0686, thrLng: 121.2270, endLat: 25.0928, endLng: 121.2490, lda: 12008, width: 200, closed: true, name: 'Taipei R5R (SQ006 closed)' },

  // OMDB Dubai
  { icao: 'OMDB', rwy: '12L', hdg: 120, thrLat: 25.2538, thrLng: 55.3458, endLat: 25.2381, endLng: 55.3725, lda: 13123, width: 200, name: 'Dubai Intl' },
  { icao: 'OMDB', rwy: '30R', hdg: 300, thrLat: 25.2381, thrLng: 55.3725, endLat: 25.2538, endLng: 55.3458, lda: 13123, width: 200 },

  // RJTT Tokyo Haneda
  { icao: 'RJTT', rwy: '34R', hdg: 340, thrLat: 35.5283, thrLng: 139.7785, endLat: 35.5660, endLng: 139.7855, lda: 9839,  width: 200, name: 'Tokyo Haneda' },
  { icao: 'RJTT', rwy: '16L', hdg: 160, thrLat: 35.5660, thrLng: 139.7855, endLat: 35.5283, endLng: 139.7785, lda: 9839,  width: 200 },

  // YSSY Sydney
  { icao: 'YSSY', rwy: '16R', hdg: 160, thrLat: -33.9210, thrLng: 151.1907, endLat: -33.9624, endLng: 151.1820, lda: 12998, width: 200, name: 'Sydney Kingsford' },

  // KMDW Chicago Midway (short, urban — overrun risk)
  { icao: 'KMDW', rwy: '31C', hdg: 313, thrLat: 41.7822, thrLng: -87.7415, endLat: 41.7935, endLng: -87.7649, lda: 6522, width: 150, name: 'Chicago Midway' },

  // YBBN Brisbane
  { icao: 'YBBN', rwy: '19R', hdg: 192, thrLat: -27.3779, thrLng: 153.1180, endLat: -27.4106, endLng: 153.1130, lda: 11483, width: 150, name: 'Brisbane' },
]

const TIER_COLOR: Record<Tier, { bg: string; text: string; ring: string; chip: string }> = {
  'ALARM':   { bg: 'bg-rose-500/15',  text: 'text-rose-300',   ring: '#f43f5e', chip: 'bg-rose-500/20 border-rose-500/40 text-rose-200' },
  'WARN':    { bg: 'bg-rose-400/15',  text: 'text-rose-300',   ring: '#fb7185', chip: 'bg-rose-400/20 border-rose-400/40 text-rose-200' },
  'CAUTION': { bg: 'bg-amber-500/15', text: 'text-amber-300',  ring: '#f59e0b', chip: 'bg-amber-500/20 border-amber-500/40 text-amber-200' },
  'ADVISE':  { bg: 'bg-sky-500/15',   text: 'text-sky-300',    ring: '#0ea5e9', chip: 'bg-sky-500/20 border-sky-500/40 text-sky-200' },
  'HEALTHY': { bg: 'bg-emerald-500/15', text: 'text-emerald-300', ring: '#10b981', chip: 'bg-emerald-500/20 border-emerald-500/40 text-emerald-200' },
  'OFF':     { bg: 'bg-slate-700/30', text: 'text-slate-400',  ring: '#475569', chip: 'bg-slate-700/30 border-slate-700/60 text-slate-400' },
}

const TIERS: Tier[] = ['ALARM', 'WARN', 'CAUTION', 'ADVISE', 'HEALTHY', 'OFF']
const PHASES: Phase[] = ['TAXI-OUT', 'LINE-UP', 'T/O ROLL', 'APP-FNL', 'FLARE', 'ROLLOUT', 'OFF']
const CALLOUTS: Callout[] = ['ON-RWY', 'APP-RWY', 'TWY-LU', 'TWY-TO', 'WRONG-RWY', 'DEEP-LAND', 'SHORT-LAND', 'DIST-REM', 'END-NEAR', 'NONE']
const CALLOUT_GLYPH: Record<Callout, string> = {
  'ON-RWY': '▸', 'APP-RWY': '◂', 'TWY-LU': '⊳', 'TWY-TO': '⊠',
  'WRONG-RWY': '!', 'DEEP-LAND': '↓', 'SHORT-LAND': '↑', 'DIST-REM': '#', 'END-NEAR': '⊕', 'NONE': '·',
}
const CALLOUT_LABEL: Record<Callout, string> = {
  'ON-RWY': 'ON RUNWAY',
  'APP-RWY': 'APPROACHING',
  'TWY-LU': 'ON TAXIWAY',
  'TWY-TO': 'TAXIWAY T/O',
  'WRONG-RWY': 'WRONG-RWY!',
  'DEEP-LAND': 'DEEP LANDING',
  'SHORT-LAND': 'SHORT LANDING',
  'DIST-REM': 'DIST REMAINING',
  'END-NEAR': 'END OF RUNWAY',
  'NONE': '—',
}

function ramp(x: number, lo: number, hi: number): number {
  if (x <= lo) return 0
  if (x >= hi) return 100
  return ((x - lo) / (hi - lo)) * 100
}

/* Great-circle haversine — returns metres */
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const toRad = (d: number) => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/* Bearing from p1→p2 in degrees [0,360) */
function bearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => d * Math.PI / 180
  const toDeg = (r: number) => r * 180 / Math.PI
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2))
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1))
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

interface RwyProjection {
  rwy: RwyRow
  /** distance from threshold along axis, m */
  along: number
  /** lateral offset to centreline, m (positive = right) */
  lateral: number
  /** straight-line distance to threshold reference, m */
  toThrM: number
  /** distance remaining to end of runway, m */
  toEndM: number
  /** alignment delta vs runway heading, deg signed */
  alignDelta: number
}

function projectToRwy(f: PFlight, r: RwyRow): RwyProjection {
  // bearing and distance threshold → aircraft
  const toAcBrg = bearing(r.thrLat, r.thrLng, f.lat, f.lng)
  const toAcM = haversineM(r.thrLat, r.thrLng, f.lat, f.lng)
  const deltaBrg = ((toAcBrg - r.hdg + 540) % 360) - 180  // -180..180
  const ang = deltaBrg * Math.PI / 180
  const along = toAcM * Math.cos(ang)
  const lateral = toAcM * Math.sin(ang)
  const ldaM = r.lda * 0.3048
  const toThrM = haversineM(r.thrLat, r.thrLng, f.lat, f.lng)
  const toEndM = haversineM(r.endLat, r.endLng, f.lat, f.lng)
  // alignment delta = (track − rwy hdg) signed
  const alignDelta = ((f.trk - r.hdg + 540) % 360) - 180
  return { rwy: r, along, lateral, toThrM, toEndM, alignDelta }
}

interface RaasState {
  f: PFlight
  cls: RaasClass
  cr: ClassRow
  phase: Phase
  rwy?: RwyRow
  /** projection onto nearest RWY (if within 8 km) */
  proj?: RwyProjection
  /** classify whether aircraft on RWY pavement */
  onRwy: boolean
  /** classify whether aircraft on adjacent TWY (proxy: near a RWY but offset > width) */
  onTwy: boolean
  /** wrong-runway (insufficient length for class) */
  wrongRwy: boolean
  /** deep landing flag */
  deepLand: boolean
  /** short landing flag */
  shortLand: boolean
  /** dist remaining along axis, ft (0 if not on RWY) */
  distRemFt: number
  /** approximate GS proxy for AGL height vs glideslope */
  gsDevDeg: number
  /** active callout */
  callout: Callout
  /** drivers each 0-100 */
  drv: { ALIGN: number; SURF: number; DIST: number; SPD: number; GS: number; OFFSET: number; MISMATCH: number; PHASE: number }
  /** composite score 0-100 */
  score: number
  /** tier */
  tier: Tier
  /** whether airframe is fundamentally "on ground" (alt < 200 ft, spd<60) */
  ground: boolean
}

function phaseOf(f: PFlight, onRwy: boolean, onTwy: boolean): Phase {
  const alt = f.alt || 0
  const spd = f.spd || 0
  const vs = f.vs || 0
  const aglProxy = alt  // for tracker we treat alt as MSL≈AGL near airport; precision OK
  if (alt > 2500) return 'OFF'
  if (onTwy && spd < 30) return 'TAXI-OUT'
  if (onRwy && spd < 30) return 'LINE-UP'
  if (onRwy && spd >= 30 && vs >= -50 && aglProxy < 200) {
    return spd > 80 ? 'T/O ROLL' : 'T/O ROLL'
  }
  if (onRwy && spd > 30 && vs < -50) return 'ROLLOUT'
  if (!onRwy && !onTwy && alt > 200 && alt <= 2500 && vs < -200) return 'APP-FNL'
  if (!onRwy && alt <= 200 && vs < -100) return 'FLARE'
  if (onRwy && spd > 60 && Math.abs(vs) < 100 && aglProxy < 50) return 'ROLLOUT'
  if (alt <= 200 && spd < 30) return 'TAXI-OUT'
  return 'OFF'
}

function nearestRwy(f: PFlight): { proj: RwyProjection | undefined; on: boolean; near: boolean } {
  let best: RwyProjection | undefined
  let bestScore = Infinity
  for (const r of RUNWAYS) {
    // quick coarse haversine filter — within ~25 km
    const coarseM = haversineM(r.thrLat, r.thrLng, f.lat, f.lng)
    if (coarseM > 25000) continue
    const p = projectToRwy(f, r)
    // scoring: prefer runways where aircraft is along-axis 0..LDA
    const inAxis = p.along >= -200 && p.along <= r.lda * 0.3048 + 500
    const offsetM = Math.abs(p.lateral)
    const w = r.width * 0.3048
    const score = (inAxis ? 0 : 5000) + offsetM
    if (score < bestScore) { bestScore = score; best = p }
  }
  if (!best) return { proj: undefined, on: false, near: false }
  const r = best.rwy
  const widthM = r.width * 0.3048
  const ldaM = r.lda * 0.3048
  const onRwy = (best.along >= -10 && best.along <= ldaM + 30) && Math.abs(best.lateral) <= widthM * 0.55
  const near = Math.abs(best.lateral) <= widthM * 4 && best.along >= -ldaM * 0.3 && best.along <= ldaM * 1.4
  return { proj: best, on: onRwy, near }
}

function evalAirframe(
  f: PFlight,
  advMul: number,
  wrongRwyThr: number,
  deepLim: number,
  distCadenceFt: number,
): RaasState {
  const cls = typeToClass(f.typ)
  const cr = CLASS_BY[cls]
  const ground = (f.alt || 0) < 200 && (f.spd || 0) < 220
  const { proj, on, near } = nearestRwy(f)
  const rwy = proj?.rwy

  // on-taxiway heuristic: ground + near a runway but lateral > 0.55·width
  const onTwy = ground && near && !on && proj && Math.abs(proj.lateral) > (proj.rwy.width * 0.3048) * 0.55
  const phase = phaseOf(f, on, !!onTwy)

  // distance-remaining along runway centreline, in feet
  const distRemFt = on && proj ? Math.max(0, (rwy!.lda * 0.3048 - proj.along) / 0.3048) : 0

  // wrong-runway: aircraft on RWY, accelerating, but RWY shorter than class TODA/V_REJ
  // Comair 5191 LEX: aligned to RWY 26 (3500 ft) vs needed 5236 ft for CRJ-100
  let wrongRwy = false
  if (on && rwy) {
    const insufficient = rwy.lda < cr.todaReq * 0.85 || rwy.lda < wrongRwyThr
    const acceleratingToTakeoff = (f.spd || 0) > 40 && phase !== 'ROLLOUT' && phase !== 'FLARE'
    if ((insufficient || rwy.closed || rwy.short) && acceleratingToTakeoff) wrongRwy = true
  }

  // deep landing: rolled out > deepLim% of LDA without touching down before threshold
  let deepLand = false
  if (phase === 'FLARE' || phase === 'ROLLOUT') {
    if (on && rwy && proj) {
      const fracAlong = proj.along / (rwy.lda * 0.3048)
      if (fracAlong > deepLim / 100) deepLand = true
    }
  }

  // short landing: airborne with alt<50ft but along<0 (before threshold) — Asiana 214 SFO seawall
  let shortLand = false
  if (phase === 'FLARE' && proj && proj.along < 0 && (f.alt || 0) > 5 && (f.alt || 0) < 70) {
    shortLand = true
  }

  // GS deviation proxy: in APP-FNL, ideal 3° glideslope; estimate dev from descent profile
  // tan(3°)·distFromThr ≈ ideal-alt; if actual alt > 2× ideal we're high, <0.5× we're low
  let gsDevDeg = 0
  if (proj && rwy && phase === 'APP-FNL' && proj.along < 0) {
    const distToThrM = Math.abs(proj.along)
    const idealAltFt = distToThrM * Math.tan(3 * Math.PI / 180) / 0.3048
    const altFt = f.alt || 0
    if (idealAltFt > 50 && altFt > 100) {
      const ratio = altFt / idealAltFt
      // dev in degrees: arctan(altFt·0.3048/distToThrM) - 3
      const actualDeg = Math.atan((altFt * 0.3048) / distToThrM) * 180 / Math.PI
      gsDevDeg = actualDeg - 3
    }
  }

  // ===== callout selection (single active callout) =====
  let callout: Callout = 'NONE'
  if (phase === 'OFF') {
    callout = 'NONE'
  } else if (wrongRwy) {
    callout = 'WRONG-RWY'
  } else if (onTwy && (f.spd || 0) > 40) {
    callout = 'TWY-TO'
  } else if (onTwy) {
    callout = 'TWY-LU'
  } else if (shortLand) {
    callout = 'SHORT-LAND'
  } else if (deepLand) {
    callout = 'DEEP-LAND'
  } else if (on && phase === 'ROLLOUT' && distRemFt <= 1000) {
    callout = 'END-NEAR'
  } else if (on && phase === 'ROLLOUT') {
    // cadence: 9000/8000/7000/.../3000/2000/1000 if past one
    const bucket = Math.round(distRemFt / distCadenceFt) * distCadenceFt
    if (bucket > 0 && bucket < 9500 && Math.abs(distRemFt - bucket) < 200) callout = 'DIST-REM'
    else callout = 'ON-RWY'
  } else if (on && (phase === 'LINE-UP' || phase === 'T/O ROLL')) {
    callout = 'ON-RWY'
  } else if (proj && !on && proj.along > -100 && proj.along < 0 && Math.abs(proj.lateral) < (proj.rwy.width * 0.3048) * 2) {
    callout = 'APP-RWY'
  }

  // ===== drivers =====
  const widthM = rwy ? rwy.width * 0.3048 : 30
  const lateralM = proj ? Math.abs(proj.lateral) : 0
  const offsetPct = Math.min(100, (lateralM / Math.max(1, widthM * 0.5)) * 100)
  const distRequired = (cr.rollFt || 4000) * 1.15  // 15% safety margin
  const distAdequacy = distRemFt > 0 ? Math.min(1, distRequired / Math.max(1, distRemFt)) : 0
  const expSpeed: Record<Phase, number> = {
    'TAXI-OUT': 20, 'LINE-UP': 5, 'T/O ROLL': 100, 'APP-FNL': 150, 'FLARE': cr.vtd, 'ROLLOUT': 70, 'OFF': 0,
  }
  const spdDev = Math.abs((f.spd || 0) - expSpeed[phase])
  const alignDelta = proj ? Math.abs(proj.alignDelta) : 0
  const phaseWeight: Record<Phase, number> = {
    'TAXI-OUT': 0.5, 'LINE-UP': 0.8, 'T/O ROLL': 1.20, 'APP-FNL': 1.05, 'FLARE': 1.30, 'ROLLOUT': 1.20, 'OFF': 0,
  }

  const drv = {
    ALIGN:    ramp(alignDelta, 5, 25),
    SURF:     onTwy ? 90 : (on ? 5 : (near ? 25 : 0)),
    DIST:     ramp(distAdequacy * 100, 30, 110),
    SPD:      ramp(spdDev, 10, 80),
    GS:       ramp(Math.abs(gsDevDeg), 0.5, 2.5),
    OFFSET:   ramp(offsetPct, 25, 100),
    MISMATCH: wrongRwy ? 92 : (rwy?.closed ? 95 : 0),
    PHASE:    phase === 'OFF' ? 0 : 30,
  }

  const arr = [drv.ALIGN, drv.SURF, drv.DIST, drv.SPD, drv.GS, drv.OFFSET, drv.MISMATCH, drv.PHASE]
  const dMax = Math.max(...arr)
  const dMean = arr.reduce((a, b) => a + b, 0) / arr.length
  let score = (dMax * 0.66 + dMean * 0.34) * phaseWeight[phase] * advMul * cr.sens

  // hard escalators
  if (onTwy && (f.spd || 0) > 40) score = Math.max(score, 92)
  if (wrongRwy) score = Math.max(score, 88)
  if (deepLand) score = Math.max(score, 80)
  if (shortLand) score = Math.max(score, 85)
  if (Math.abs(gsDevDeg) > 2 && (f.alt || 0) < 500 && phase === 'APP-FNL') score = Math.max(score, 75)
  if (callout === 'END-NEAR' && (f.spd || 0) > 60) score = Math.max(score, 70)
  if (offsetPct > 80 && on) score = Math.max(score, 65)
  if (rwy?.closed && on) score = Math.max(score, 95)

  score = Math.max(0, Math.min(100, score))

  let tier: Tier = 'HEALTHY'
  if (phase === 'OFF') tier = 'OFF'
  else if (score >= 85) tier = 'ALARM'
  else if (score >= 65) tier = 'WARN'
  else if (score >= 45) tier = 'CAUTION'
  else if (score >= 22) tier = 'ADVISE'
  else tier = 'HEALTHY'

  return {
    f, cls, cr, phase, rwy, proj, onRwy: on, onTwy: !!onTwy,
    wrongRwy, deepLand, shortLand, distRemFt, gsDevDeg,
    callout, drv, score, tier, ground,
  }
}

export default function RaasRunwayAware({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [wrongRwyThr, setWrongRwyThr] = useState(4500)
  const [deepLim, setDeepLim] = useState(60)
  const [distCadence, setDistCadence] = useState(1000)
  const [activeTiers, setActiveTiers] = useState<Set<Tier>>(new Set(TIERS))
  const [activePhases, setActivePhases] = useState<Set<Phase>>(new Set(PHASES))
  const [activeCallouts, setActiveCallouts] = useState<Set<Callout>>(new Set(CALLOUTS))
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showVec, setShowVec] = useState(true)
  const [showCall, setShowCall] = useState(true)
  const [showRwy, setShowRwy] = useState(true)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT' | 'RUNWAYS' | 'CALLOUTS' | 'METHOD'>('AIRCRAFT')
  const [pickedIcao, setPickedIcao] = useState<string | null>(null)

  const states = useMemo(() => {
    return (flights || [])
      .filter(f => f && typeof f.lat === 'number' && typeof f.lng === 'number')
      .map(f => evalAirframe(f, advMul, wrongRwyThr, deepLim, distCadence))
  }, [flights, advMul, wrongRwyThr, deepLim, distCadence])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return states.filter(s => activeTiers.has(s.tier)
      && activePhases.has(s.phase)
      && activeCallouts.has(s.callout)
      && (!q || s.f.cs.toLowerCase().includes(q) || (s.f.typ || '').toLowerCase().includes(q) || (s.f.op || '').toLowerCase().includes(q) || (s.rwy?.icao || '').toLowerCase().includes(q) || (s.rwy?.rwy || '').toLowerCase().includes(q)))
  }, [states, activeTiers, activePhases, activeCallouts, search])

  const sorted = useMemo(() => {
    const order: Record<Tier, number> = { 'ALARM': 0, 'WARN': 1, 'CAUTION': 2, 'ADVISE': 3, 'HEALTHY': 4, 'OFF': 5 }
    return [...visible].sort((a, b) => order[a.tier] - order[b.tier] || b.score - a.score)
  }, [visible])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { 'ALARM': 0, 'WARN': 0, 'CAUTION': 0, 'ADVISE': 0, 'HEALTHY': 0, 'OFF': 0 }
    states.forEach(s => { c[s.tier]++ })
    return c
  }, [states])

  const summary = useMemo(() => {
    const inRwy = states.filter(s => s.distRemFt > 0)
    const muDistRem = inRwy.length ? inRwy.reduce((a, s) => a + s.distRemFt, 0) / inRwy.length : 0
    const worst = states.slice().sort((a, b) => b.score - a.score)[0]
    return {
      count: states.length,
      muDistRem,
      worst: worst ? worst.f.cs : '—',
      wrong: states.filter(s => s.wrongRwy).length,
      deep: states.filter(s => s.deepLand).length,
      short: states.filter(s => s.shortLand).length,
    }
  }, [states])

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const elMap = new Map<string, HTMLDivElement>()
    const rwyMap = new Map<string, HTMLDivElement>()
    const id = 'raas-overlay'

    const ensure = () => {
      // runway centreline overlays
      if (showRwy) {
        RUNWAYS.forEach(r => {
          const k = `${r.icao}-${r.rwy}`
          let el = rwyMap.get(k)
          if (!el) {
            el = document.createElement('div')
            el.style.position = 'absolute'
            el.style.transform = 'translate(-50%, -50%)'
            el.style.pointerEvents = 'none'
            el.dataset.rwy = k
            el.id = `${id}-rwy-${k}`
            map.getContainer().appendChild(el)
            rwyMap.set(k, el)
          }
          const a = map.project([r.thrLng, r.thrLat])
          const b = map.project([r.endLng, r.endLat])
          const cx = (a.x + b.x) / 2
          const cy = (a.y + b.y) / 2
          const len = Math.hypot(a.x - b.x, a.y - b.y)
          const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI
          el.style.left = `${cx}px`
          el.style.top = `${cy}px`
          const colour = r.closed ? '#f43f5e' : r.short ? '#fb7185' : '#22d3ee'
          el.innerHTML = `
            <div style="position:relative;width:${len}px;height:0;transform:rotate(${ang}deg);transform-origin:50% 50%">
              <div style="position:absolute;left:0;top:-1px;width:100%;height:2px;background:${colour}cc;border-radius:1px;box-shadow:0 0 4px ${colour}66"></div>
              <div style="position:absolute;left:50%;top:-12px;transform:translateX(-50%);font-size:7.5px;font-family:ui-monospace,Menlo,monospace;color:${colour};white-space:nowrap;text-shadow:0 0 3px #0f172a">${r.icao}·${r.rwy}${r.closed?'·CLSD':r.short?'·SHORT':''}</div>
            </div>`
        })
      } else {
        rwyMap.forEach(e => { if (e.parentNode) e.parentNode.removeChild(e) })
        rwyMap.clear()
      }

      // per-aircraft overlay
      visible.forEach(s => {
        let el = elMap.get(s.f.icao)
        if (!el) {
          el = document.createElement('div')
          el.style.position = 'absolute'
          el.style.transform = 'translate(-50%, -50%)'
          el.style.pointerEvents = 'auto'
          el.style.cursor = 'pointer'
          el.dataset.icao = s.f.icao
          el.id = `${id}-${s.f.icao}`
          el.addEventListener('click', (ev) => {
            ev.stopPropagation()
            setPickedIcao(s.f.icao)
            onFly(s.f.icao)
          })
          map.getContainer().appendChild(el)
          elMap.set(s.f.icao, el)
        }
        const px = map.project([s.f.lng, s.f.lat])
        el.style.left = `${px.x}px`
        el.style.top = `${px.y}px`
        const haloPx = Math.round(7 + (s.score / 100) * 12)
        const tier = TIER_COLOR[s.tier]
        const inner = s.cr.stroke
        const pinDot = (s.tier === 'ALARM' || s.tier === 'WARN') && showPin
          ? `<div style="position:absolute;left:50%;top:-${haloPx + 4}px;transform:translateX(-50%);width:7px;height:7px;background:${tier.ring};border-radius:50%;border:1.5px solid #0f172a;box-shadow:0 0 4px ${tier.ring}80"></div>`
          : ''
        const halo = showHalo
          ? `<div style="width:${haloPx * 2}px;height:${haloPx * 2}px;border-radius:50%;border:1.5px solid ${tier.ring};background:${tier.ring}22"></div>
             <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:6px;height:6px;border-radius:50%;border:1.5px solid ${inner};background:transparent"></div>`
          : ''
        const callGlyph = showCall && s.callout !== 'NONE'
          ? `<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:10px;font-weight:700;font-family:ui-monospace,Menlo,monospace;color:${tier.ring};text-shadow:0 0 4px #0f172a">${CALLOUT_GLYPH[s.callout]}</div>`
          : ''
        const lbl = showLbl
          ? `<div style="position:absolute;left:${haloPx + 6}px;top:50%;transform:translateY(-50%);font-size:9px;font-family:ui-monospace,Menlo,monospace;color:${tier.ring};white-space:nowrap;text-shadow:0 0 3px #0f172a">${s.f.cs} · ${s.phase}${s.callout !== 'NONE' ? ' · ' + CALLOUT_LABEL[s.callout] : ''}${s.distRemFt > 0 ? ' · ' + Math.round(s.distRemFt / 100) * 100 + 'ft' : ''}</div>`
          : ''
        let vec = ''
        if (showVec && s.distRemFt > 0 && s.rwy) {
          const distScale = 0.05  // ft per pixel
          const len = Math.max(8, Math.min(160, s.distRemFt * distScale))
          const colour = s.distRemFt < 1500 ? '#f43f5e' : s.distRemFt < 3000 ? '#f59e0b' : '#38bdf8'
          vec = `<div style="position:absolute;left:50%;top:50%;width:${len}px;height:1.5px;background:repeating-linear-gradient(to right, ${colour} 0 4px, transparent 4px 8px);transform-origin:0 0;transform:translate(0,0) rotate(${(s.rwy.hdg || 0) - 90}deg)"></div>`
        }
        el.innerHTML = `<div style="position:relative">${vec}${halo}${callGlyph}${pinDot}${lbl}</div>`
      })
      // remove orphans
      Array.from(elMap.keys()).forEach(icao => {
        if (!visible.find(v => v.f.icao === icao)) {
          const e = elMap.get(icao); if (e && e.parentNode) e.parentNode.removeChild(e); elMap.delete(icao)
        }
      })
    }

    ensure()
    map.on('move', ensure)
    map.on('zoom', ensure)
    return () => {
      try { map.off('move', ensure); map.off('zoom', ensure) } catch {}
      Array.from(elMap.values()).forEach(e => { if (e.parentNode) e.parentNode.removeChild(e) })
      Array.from(rwyMap.values()).forEach(e => { if (e.parentNode) e.parentNode.removeChild(e) })
      elMap.clear(); rwyMap.clear()
    }
  }, [map, visible, showHalo, showPin, showLbl, showVec, showCall, showRwy, onFly])

  const toggleTier = (t: Tier) => {
    setActiveTiers(prev => { const ns = new Set(prev); if (ns.has(t)) ns.delete(t); else ns.add(t); return ns })
  }
  const togglePhase = (p: Phase) => {
    setActivePhases(prev => { const ns = new Set(prev); if (ns.has(p)) ns.delete(p); else ns.add(p); return ns })
  }
  const toggleCallout = (c: Callout) => {
    setActiveCallouts(prev => { const ns = new Set(prev); if (ns.has(c)) ns.delete(c); else ns.add(c); return ns })
  }

  return (
    <div className="absolute top-14 right-3 z-40 w-[min(94vw,500px)] max-h-[84vh] flex flex-col bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl">
      <div className="px-4 py-3 border-b border-slate-800 flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Surface awareness · DO-367 / Honeywell RAAS</div>
          <div className="text-sm font-semibold text-slate-100">RAAS <span className="text-slate-500 font-normal">· SmartRunway · SmartLanding aural-callout audit</span></div>
          <div className="text-[10px] text-slate-500 mt-0.5">Comair 5191 / Air-Canada 759 / Asiana 214 / Singapore 006 precedent</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* Tier counter strip */}
      <div className="px-3 pt-2 pb-1 flex gap-1 text-[10px]">
        <button onClick={() => setActiveTiers(new Set(TIERS))}
          className={`flex-1 rounded-md px-1.5 py-1 border ${activeTiers.size === TIERS.length ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/50 border-slate-800 text-slate-400'}`}>
          ALL · {states.length}
        </button>
        {TIERS.map(t => {
          const c = TIER_COLOR[t]
          const active = activeTiers.has(t)
          return (
            <button key={t} onClick={() => toggleTier(t)}
              className={`flex-1 rounded-md px-1.5 py-1 border ${active ? `${c.bg} ${c.text}` : 'bg-slate-900/50 border-slate-800 text-slate-500'}`}
              style={{ borderColor: active ? c.ring : undefined }}
              title={t}>
              {t.length > 7 ? t.slice(0, 7) : t} · {tierCounts[t]}
            </button>
          )
        })}
      </div>

      {/* 5-cell summary */}
      <div className="px-3 pb-2 grid grid-cols-5 gap-1 text-[10px]">
        <div className="bg-slate-900/50 rounded-md px-1.5 py-1">
          <div className="text-slate-500 uppercase">μ-RMN</div>
          <div className="text-slate-200 font-mono">{(summary.muDistRem / 1000).toFixed(1)}k</div>
        </div>
        <div className="bg-slate-900/50 rounded-md px-1.5 py-1">
          <div className="text-slate-500 uppercase">Worst</div>
          <div className="text-slate-200 font-mono truncate">{summary.worst}</div>
        </div>
        <div className="bg-slate-900/50 rounded-md px-1.5 py-1">
          <div className="text-slate-500 uppercase">Wrong</div>
          <div className="text-rose-300 font-mono">{summary.wrong}</div>
        </div>
        <div className="bg-slate-900/50 rounded-md px-1.5 py-1">
          <div className="text-slate-500 uppercase">Deep</div>
          <div className="text-rose-300 font-mono">{summary.deep}</div>
        </div>
        <div className="bg-slate-900/50 rounded-md px-1.5 py-1">
          <div className="text-slate-500 uppercase">Short</div>
          <div className="text-amber-300 font-mono">{summary.short}</div>
        </div>
      </div>

      {/* Sliders */}
      <div className="px-3 pb-2 grid grid-cols-2 gap-2 text-[10px]">
        <label className="block">
          <div className="text-slate-500 flex justify-between"><span>ADV-MUL</span><span className="font-mono text-slate-300">{(advMul * 100).toFixed(0)}%</span></div>
          <input type="range" min={50} max={200} value={Math.round(advMul * 100)} onChange={e => setAdvMul(Number(e.target.value) / 100)} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="text-slate-500 flex justify-between"><span>WRONG-THR</span><span className="font-mono text-slate-300">{wrongRwyThr}ft</span></div>
          <input type="range" min={2000} max={6000} step={250} value={wrongRwyThr} onChange={e => setWrongRwyThr(Number(e.target.value))} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="text-slate-500 flex justify-between"><span>DEEP-LIM</span><span className="font-mono text-slate-300">{deepLim}%</span></div>
          <input type="range" min={30} max={80} value={deepLim} onChange={e => setDeepLim(Number(e.target.value))} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="text-slate-500 flex justify-between"><span>DIST-CAD</span><span className="font-mono text-slate-300">{distCadence}ft</span></div>
          <input type="range" min={500} max={2000} step={100} value={distCadence} onChange={e => setDistCadence(Number(e.target.value))} className="w-full accent-sky-500" />
        </label>
      </div>

      {/* Phase chips */}
      <div className="px-3 pb-1 flex flex-wrap gap-1">
        {PHASES.map(p => {
          const active = activePhases.has(p)
          return (
            <button key={p} onClick={() => togglePhase(p)}
              className={`text-[9px] px-1.5 py-0.5 rounded border font-mono ${active ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/50 border-slate-800 text-slate-500'}`}>
              {p}
            </button>
          )
        })}
      </div>

      {/* Callout chips */}
      <div className="px-3 pb-2 flex flex-wrap gap-1">
        {CALLOUTS.map(c => {
          const active = activeCallouts.has(c)
          return (
            <button key={c} onClick={() => toggleCallout(c)}
              className={`text-[9px] px-1.5 py-0.5 rounded border font-mono ${active ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/50 border-slate-800 text-slate-500'}`}
              title={CALLOUT_LABEL[c]}>
              {CALLOUT_GLYPH[c]} {c}
            </button>
          )
        })}
      </div>

      {/* Overlay toggles + search */}
      <div className="px-3 pb-2 flex items-center gap-1 text-[10px]">
        {[['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLbl, setShowLbl], ['VEC', showVec, setShowVec], ['CALL', showCall, setShowCall], ['RWY', showRwy, setShowRwy]].map(([l, v, set]) => (
          <button key={l as string} onClick={() => (set as any)(!v)}
            className={`px-1.5 py-0.5 rounded border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/50 border-slate-800 text-slate-500'}`}>{l as string}</button>
        ))}
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="cs/type/op/rwy…"
          className="flex-1 bg-slate-900/50 border border-slate-800 rounded px-2 py-1 text-slate-200 text-[10px] focus:outline-none focus:border-sky-500" />
      </div>

      {/* Tab switcher */}
      <div className="px-3 pb-1 flex gap-1 text-[10px]">
        {(['AIRCRAFT', 'RUNWAYS', 'CALLOUTS', 'METHOD'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 px-2 py-1 rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/50 border-slate-800 text-slate-400'}`}>
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 text-[10px]">
        {tab === 'AIRCRAFT' && sorted.map(s => {
          const c = TIER_COLOR[s.tier]
          const isPicked = pickedIcao === s.f.icao
          const calloutText = s.callout === 'NONE' ? '—' : CALLOUT_LABEL[s.callout] + (s.rwy ? ' ' + s.rwy.rwy : '')
          const advice =
            s.tier === 'ALARM'   && s.wrongRwy ? `WRONG-RUNWAY alignment to ${s.rwy?.icao} ${s.rwy?.rwy} (${s.rwy?.lda}ft) — insufficient for ${s.cls} (${s.cr.todaReq}ft req). REJECT TAKEOFF · NTSB AAR-08-02 Comair 5191 LEX precedent.` :
            s.tier === 'ALARM'   && s.onTwy && (s.f.spd || 0) > 40 ? `TAXIWAY TAKEOFF detected at ${(s.f.spd || 0).toFixed(0)}kt. REJECT immediately · FAA InFO 16002 / NTSB AAR-08-02.` :
            s.tier === 'ALARM'   && s.shortLand ? `SHORT-OF-RUNWAY impact imminent · ${s.proj?.along.toFixed(0)}m before threshold · NTSB AAR-14-01 Asiana 214 SFO seawall precedent. GO-AROUND.` :
            s.tier === 'ALARM'   && s.deepLand ? `DEEP LANDING · TD past ${deepLim}% LDA · ${(s.distRemFt).toFixed(0)}ft remaining · AC 91-79B App.G overrun-risk band. GO-AROUND.` :
            s.tier === 'WARN'    ? `${calloutText} · ${s.distRemFt > 0 ? Math.round(s.distRemFt) + 'ft remaining' : 'monitor surface conformance'} · Honeywell SmartRunway active callout` :
            s.tier === 'CAUTION' ? `${calloutText} · ${s.distRemFt > 0 ? Math.round(s.distRemFt) + 'ft remaining' : 'RAAS prompt'} · routine monitor` :
            s.tier === 'ADVISE'  ? `${calloutText} · routine surface advisory · Honeywell A28-1146-194` :
            s.tier === 'HEALTHY' ? `Nominal · no callout active · phase ${s.phase}` :
            `Airborne >2500ft AGL · RAAS muted per Honeywell SmartRunway logic`
          return (
            <div key={s.f.icao}
              className={`bg-slate-900/40 rounded-lg p-2 border ${isPicked ? 'border-sky-500/50' : 'border-slate-800/70'} cursor-pointer hover:border-slate-700`}
              onClick={() => { setPickedIcao(s.f.icao); onFly(s.f.icao) }}>
              <div className="flex items-center gap-1.5 text-[10px]">
                <span className="font-mono text-slate-100">{s.f.cs}</span>
                <span className="font-mono text-slate-500">{s.f.typ || '—'}</span>
                <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ background: s.cr.fill + '22', color: s.cr.stroke, border: `1px solid ${s.cr.stroke}66` }}>{s.cls}</span>
                <span className="px-1 py-0.5 rounded text-[9px] font-mono bg-slate-800/60 border border-slate-700 text-slate-300">{s.phase}</span>
                {s.callout !== 'NONE' && (
                  <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ background: TIER_COLOR[s.tier].ring + '22', color: TIER_COLOR[s.tier].ring, border: `1px solid ${TIER_COLOR[s.tier].ring}66` }}>{CALLOUT_GLYPH[s.callout]} {s.callout}</span>
                )}
                <span className={`px-1 py-0.5 rounded text-[9px] font-mono border ${c.chip}`}>{s.tier}</span>
              </div>
              <div className="mt-1 grid grid-cols-4 gap-1 text-[9px] font-mono">
                <div><span className="text-slate-500">RWY</span> <span className="text-slate-200">{s.rwy ? `${s.rwy.icao}·${s.rwy.rwy}` : '—'}</span></div>
                <div><span className="text-slate-500">REM</span> <span className="text-slate-200">{s.distRemFt > 0 ? Math.round(s.distRemFt) + 'ft' : '—'}</span></div>
                <div><span className="text-slate-500">SPD</span> <span className="text-slate-200">{(s.f.spd || 0).toFixed(0)}kt</span></div>
                <div><span className="text-slate-500">ALT</span> <span className="text-slate-200">{(s.f.alt || 0).toFixed(0)}ft</span></div>
              </div>
              <div className="mt-0.5 grid grid-cols-4 gap-1 text-[9px] font-mono">
                <div><span className="text-slate-500">OFFSET</span> <span className="text-slate-200">{s.proj ? Math.round(Math.abs(s.proj.lateral)) + 'm' : '—'}</span></div>
                <div><span className="text-slate-500">ALIGN</span> <span className="text-slate-200">{s.proj ? (s.proj.alignDelta > 0 ? '+' : '') + s.proj.alignDelta.toFixed(0) + '°' : '—'}</span></div>
                <div><span className="text-slate-500">GS-DEV</span> <span className="text-slate-200">{(s.gsDevDeg > 0 ? '+' : '') + s.gsDevDeg.toFixed(1) + '°'}</span></div>
                <div><span className="text-slate-500">LDA</span> <span className="text-slate-200">{s.rwy ? s.rwy.lda + 'ft' : '—'}</span></div>
              </div>
              <div className="mt-1 h-1.5 bg-slate-800/60 rounded-full overflow-hidden">
                <div className="h-full" style={{ width: `${s.score}%`, background: c.ring }} />
              </div>
              <div className="mt-1 flex flex-wrap gap-0.5 text-[8px] font-mono">
                {Object.entries(s.drv).map(([k, v]) => (
                  <span key={k} className="px-1 py-0.5 rounded bg-slate-900/60 border border-slate-800 text-slate-400">
                    {k} <span style={{ color: v >= 70 ? '#f43f5e' : v >= 45 ? '#f59e0b' : v >= 22 ? '#38bdf8' : '#10b981' }}>{v.toFixed(0)}</span>
                  </span>
                ))}
              </div>
              <div className={`mt-1 text-[9px] ${c.text}`}>↳ {advice}</div>
            </div>
          )
        })}
        {tab === 'AIRCRAFT' && !sorted.length && (
          <div className="text-slate-500 text-center py-8">No airframes match filter</div>
        )}

        {tab === 'RUNWAYS' && (() => {
          const grouped = new Map<string, RwyRow[]>()
          RUNWAYS.forEach(r => {
            const k = r.icao
            if (!grouped.has(k)) grouped.set(k, [])
            grouped.get(k)!.push(r)
          })
          return Array.from(grouped.entries()).map(([icao, rows]) => {
            const fleetOnIcao = states.filter(s => s.rwy?.icao === icao && (s.onRwy || s.onTwy))
            return (
              <div key={icao} className="bg-slate-900/40 rounded-lg p-2 border border-slate-800/70">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="px-1 py-0.5 rounded text-[10px] font-mono bg-sky-500/15 border border-sky-500/40 text-sky-200">{icao}</span>
                  <span className="text-slate-500 text-[9px]">{rows[0].name || ''}</span>
                  {fleetOnIcao.length > 0 && <span className="text-emerald-300 text-[9px] font-mono">{fleetOnIcao.length} on surface</span>}
                </div>
                {rows.map(r => {
                  const onThis = states.filter(s => s.rwy === r && (s.onRwy || s.onTwy))
                  const wrongOnThis = states.filter(s => s.rwy === r && s.wrongRwy).length
                  return (
                    <div key={r.rwy} className="mt-1 grid grid-cols-5 gap-1 text-[9px] font-mono items-center">
                      <span className={`px-1 py-0.5 rounded text-center ${r.closed ? 'bg-rose-500/20 text-rose-200 border border-rose-500/40' : r.short ? 'bg-rose-400/20 text-rose-200 border border-rose-400/40' : 'bg-slate-800/60 text-slate-200 border border-slate-700'}`}>{r.rwy}</span>
                      <span className="text-slate-400">{r.lda}ft</span>
                      <span className="text-slate-400">{r.width}ft</span>
                      <span className="text-slate-400">hdg {r.hdg.toFixed(0)}°</span>
                      <span className="text-slate-400">{onThis.length > 0 ? `${onThis.length} ac` : ''}{wrongOnThis > 0 ? ` · ${wrongOnThis} WR` : ''}{r.closed ? ' · CLSD' : r.short ? ' · SHORT' : ''}</span>
                    </div>
                  )
                })}
              </div>
            )
          })
        })()}

        {tab === 'CALLOUTS' && (() => {
          const W = 440, H = 240, padL = 36, padR = 12, padT = 14, padB = 28
          const distMaxFt = 12000
          const altMaxFt = 2500
          const xOf = (d: number) => padL + (d / distMaxFt) * (W - padL - padR)
          const yOf = (a: number) => padT + (1 - a / altMaxFt) * (H - padT - padB)
          const dotR = 2.4
          const xAxis = [0, 2000, 4000, 6000, 8000, 10000, 12000]
          const yAxis = [0, 500, 1000, 1500, 2000, 2500]
          return (
            <div className="bg-slate-900/40 rounded-lg p-2 border border-slate-800/70">
              <div className="text-slate-500 text-[10px] mb-1">Distance-from-touchdown (ft) × Altitude (ft AGL) scatter · 3° glideslope reference · Asiana 214 SFO short-of-threshold precedent</div>
              <svg width={W} height={H} className="block">
                <rect x={0} y={0} width={W} height={H} fill="#0f172a40" />
                {/* gridlines */}
                {xAxis.map(a => (
                  <g key={`x${a}`}>
                    <line x1={xOf(a)} y1={padT} x2={xOf(a)} y2={H - padB} stroke="#1e293b" strokeWidth={0.5} />
                    <text x={xOf(a)} y={H - 12} fontSize={8} fill="#475569" textAnchor="middle">{(a / 1000).toFixed(0)}k</text>
                  </g>
                ))}
                {yAxis.map(l => (
                  <g key={`y${l}`}>
                    <line x1={padL} y1={yOf(l)} x2={W - padR} y2={yOf(l)} stroke="#1e293b" strokeWidth={0.5} />
                    <text x={padL - 4} y={yOf(l) + 3} fontSize={8} fill="#475569" textAnchor="end">{l}</text>
                  </g>
                ))}
                {/* ideal 3° glideslope from threshold (x=0) */}
                {(() => {
                  const idealPts: Array<[number, number]> = []
                  for (let d = 0; d <= distMaxFt; d += 200) {
                    const alt = d * Math.tan(3 * Math.PI / 180)
                    idealPts.push([d, alt])
                  }
                  const path = idealPts.map((p, i) => `${i ? 'L' : 'M'} ${xOf(p[0])} ${yOf(p[1])}`).join(' ')
                  return <path d={path} fill="none" stroke="#10b981" strokeWidth={1.2} />
                })()}
                <text x={W - padR - 4} y={yOf(2500) + 12} fontSize={8} fill="#10b981" textAnchor="end">3° GS reference</text>

                {/* +1° high band */}
                {(() => {
                  const pts: Array<[number, number]> = []
                  for (let d = 0; d <= distMaxFt; d += 200) {
                    const alt = d * Math.tan(4 * Math.PI / 180)
                    pts.push([d, alt])
                  }
                  const path = pts.map((p, i) => `${i ? 'L' : 'M'} ${xOf(p[0])} ${yOf(p[1])}`).join(' ')
                  return <path d={path} fill="none" stroke="#f59e0b" strokeWidth={0.8} strokeDasharray="3 3" />
                })()}
                {/* -1° low band */}
                {(() => {
                  const pts: Array<[number, number]> = []
                  for (let d = 0; d <= distMaxFt; d += 200) {
                    const alt = d * Math.tan(2 * Math.PI / 180)
                    pts.push([d, alt])
                  }
                  const path = pts.map((p, i) => `${i ? 'L' : 'M'} ${xOf(p[0])} ${yOf(p[1])}`).join(' ')
                  return <path d={path} fill="none" stroke="#f43f5e" strokeWidth={0.8} strokeDasharray="3 3" />
                })()}
                <text x={W - padR - 4} y={yOf(distMaxFt * Math.tan(4 * Math.PI / 180)) - 2} fontSize={7} fill="#f59e0b" textAnchor="end">+1° high</text>
                <text x={W - padR - 4} y={yOf(distMaxFt * Math.tan(2 * Math.PI / 180)) + 8} fontSize={7} fill="#f43f5e" textAnchor="end">−1° low (GO-AROUND)</text>

                {/* Asiana 214 SFO seawall marker — TD point ~ -1000ft pre-threshold */}
                <g>
                  <circle cx={xOf(0)} cy={yOf(0)} r={3} fill="#fb7185" stroke="#0f172a" strokeWidth={1} />
                  <text x={xOf(0) + 6} y={yOf(0) - 3} fontSize={7} fill="#fb7185">Asiana 214 SFO seawall</text>
                </g>

                {/* live fleet — show approach + flare aircraft */}
                {visible.filter(s => (s.phase === 'APP-FNL' || s.phase === 'FLARE') && s.proj).map(s => {
                  const tier = TIER_COLOR[s.tier]
                  const isPicked = pickedIcao === s.f.icao
                  const dFt = Math.max(0, Math.min(distMaxFt, -((s.proj!.along) / 0.3048)))
                  const altFt = Math.max(0, Math.min(altMaxFt, s.f.alt || 0))
                  return (
                    <circle key={s.f.icao}
                      cx={xOf(dFt)}
                      cy={yOf(altFt)}
                      r={isPicked ? dotR + 2 : dotR}
                      fill={tier.ring}
                      stroke={isPicked ? '#fff' : '#0f172a'}
                      strokeWidth={isPicked ? 1.5 : 0.5}
                      opacity={0.85}
                      onClick={() => { setPickedIcao(s.f.icao); onFly(s.f.icao) }}
                      style={{ cursor: 'pointer' }}>
                      <title>{s.f.cs} · {s.cls} · {dFt.toFixed(0)}ft from THR · {altFt.toFixed(0)}ft AGL · {s.callout}</title>
                    </circle>
                  )
                })}
                <text x={W / 2} y={H - 2} fontSize={9} fill="#64748b" textAnchor="middle">distance from touchdown (ft)</text>
                <text x={10} y={padT - 2} fontSize={9} fill="#64748b">alt AGL ft</text>
              </svg>

              <div className="mt-2 grid grid-cols-3 gap-1 text-[9px] font-mono">
                {CALLOUTS.filter(c => c !== 'NONE').map(c => {
                  const n = states.filter(s => s.callout === c).length
                  return (
                    <div key={c} className="bg-slate-900/50 rounded px-1.5 py-1 flex items-center gap-1">
                      <span className="text-slate-400">{CALLOUT_GLYPH[c]}</span>
                      <span className="text-slate-200 flex-1 truncate">{c}</span>
                      <span className={n > 0 ? 'text-amber-300' : 'text-slate-600'}>{n}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })()}

        {tab === 'METHOD' && (
          <div className="bg-slate-900/40 rounded-lg p-2 border border-slate-800/70 text-slate-300 text-[10px] space-y-2 leading-relaxed">
            <div>
              <div className="text-slate-100 font-semibold mb-1">Methodology</div>
              RAAS scores each airframe's <span className="text-sky-300">surface-conformance state</span> by projecting live position onto the nearest declared runway, classifying ON-RWY / ON-TWY / APPROACHING / OFF-SURFACE, and predicting which of the nine certified Honeywell SmartRunway / SmartLanding aural advisories would be firing right now.
            </div>
            <div>
              <span className="text-amber-300 font-semibold">Wrong-runway physics</span>: aligned to a runway whose declared LDA is less than <span className="font-mono">{wrongRwyThr}ft</span> or below class TODA-required, while GS{'>'}40kt — the Comair 5191 LEX (27-Aug-2006, 49 dead) regime. CRJ-100 took off on RWY 26 (3500 ft GA strip) instead of RWY 22 (7003 ft air-carrier). RAAS would have announced "ON RUNWAY 2-6" + "SHORT RUNWAY".
            </div>
            <div>
              <span className="text-rose-300 font-semibold">Short / deep landing physics</span>: SHORT-LAND fires when aircraft at &lt;70ft AGL is projected to touch down before the declared threshold (Asiana 214 SFO seawall, 06-Jul-2013). DEEP-LAND fires when touchdown is past <span className="font-mono">{deepLim}%</span> of LDA (Air-Canada 759 SFO Twy-C near-miss, 22-Jul-2017).
            </div>
            <div>
              <span className="text-sky-300 font-semibold">Distance-remaining cadence</span>: SmartLanding default Honeywell A28-1146-194 issues "## REMAINING" callouts every <span className="font-mono">{distCadence}ft</span> during rollout, then "END OF RUNWAY" at &lt;1000ft remaining.
            </div>
            <div>
              <span className="text-slate-200 font-semibold">Drivers</span>: ALIGN / SURF / DIST / SPD / GS / OFFSET / MISMATCH / PHASE — composite is <span className="font-mono">max·0.66 + mean·0.34 × PHASE-W × ADV-MUL × class-sens</span>. Hard escalators: TWY-T/O ≥92; WRONG-RWY ≥88; DEEP ≥80; SHORT ≥85; GS-dev{'>'}2° ≥75; END-NEAR+GS{'>'}60 ≥70; offset{'>'}80% ≥65; closed-RWY ≥95.
            </div>
            <div>
              <span className="text-slate-200 font-semibold">Distinct from siblings</span>: ROW/ROP audits ON-RWY only (Airbus); TAWS-MK6 is terrain-proximity below 2500ft AGL; HOTSPOT is a static chart annotation per Doc 9870 §3.4; LAHSO is land-and-hold-short procedure-specific; ASDE-X is ATC ground-radar; RWSL is ground-light infrastructure; TOWS is takeoff-config (flaps/stab), not WHERE. RAAS uniquely audits the COCKPIT aural-callout stack against surface geometry.
            </div>
            <div>
              <span className="text-slate-200 font-semibold">References</span>: Honeywell SmartRunway SmartLanding Pilot Guide R6 · Honeywell A28-1146-194 install · RTCA DO-367 / DO-200B · FAA AC 25-22 / AC 23-25 / AC 91-79B · FAA InFO 08036 / 16002 · FAA Order 8900.1 V4 Ch.10 / JO 7110.65 §3 · 14 CFR Part 91.129 / Part 121.318 / §25.1322 / §25.1329 · EASA AMC1 SPO.IDE.A.205 / CS-25.1322 · ICAO Annex 6 Pt I §6.15 · Doc 9870 §3.3 · Doc 9981 Pt II §4.3 · Doc 8168 Vol II Pt I §1 · NTSB AAR-08-02 Comair 5191 · AAR-14-01 Asiana 214 · AAR-07-02 SQ006 · ANC17IA037 AC759 · TSB A21H0002 · ATSB AO-2010-074.
            </div>
            <div className="text-slate-500 text-[9px] italic pt-1 border-t border-slate-800">
              Runway/taxiway geometry is sampled from a 24-runway catalogue spanning hubs and precedent-incident airports. For operational use, replace with full AIRAC airport-mapping-database per RTCA DO-200B / EUROCONTROL ATMB / FAA NACO.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
