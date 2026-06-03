'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   EOSID · Engine-Out Standard Instrument Departure / Escape
   Route Obstacle-Clearance & Net-Flight-Path Monitor
   -----------------------------------------------------------
   Per-airframe takeoff-time analysis of the published EOSID
   (Engine-Out SID) or company-derived obstacle escape route
   in the event of a single-engine failure between V1 and
   acceleration height, with computed net flight path (gross
   - 0.8% / 0.9% / 1.0% per 14 CFR 25.115) versus the worst-
   case obstacle gradient out to 10 nm from the departure
   end of runway (DER).

   Regulatory & operational basis:
     · 14 CFR 25.111 takeoff path (first/second/third/final
       segment gross gradients)
     · 14 CFR 25.115 takeoff flight-path (net = gross minus
       0.8% 2-eng / 0.9% 3-eng / 1.0% 4-eng)
     · 14 CFR 25.121(b) second-segment minimum gross gradient
       (2.4% twin / 2.7% tri / 3.0% quad)
     · 14 CFR 121.189 operating limits in OEI takeoff
     · 14 CFR 91.605 / 121.197 obstacle clearance 35 ft net
     · ICAO Annex 6 Pt I 5.2.8 OEI obstacle clearance
     · ICAO Doc 8168 PANS-OPS Vol II Pt I §3 / §7 PDG 3.3%
     · ICAO Doc 9613 PBN Manual Vol II Pt C ch 5 EOSID/OEI
     · FAA Order 8260.3D TERPS / 8260.46F engine-out
       departure obstacle assessment
     · FAA AC 120-91A airport obstacle analysis
     · FAA AC 120-118 takeoff and landing performance
     · FAA AC 25-7D §3 powerplant flight test
     · EASA CS-25 Book 1 Subpart B Performance
     · EASA AMC 25.111 / AMC 25.115 / AMC 25.121
     · EASA CAT.POL.A.210 obstacle clearance commercial
     · IATA Performance Working Group EOSID Implementation
       Best-Practice 2023
     · Boeing FCOM PI Chapter 9 EOSID / Airbus FCOM
       PER-TOF-PRO-EOSID / Embraer FCOM 4.07 / Bombardier
       PMM EOSID / Gulfstream G650 AFM §5 OEI departure
     · ARINC 424 path-terminators (CA / CF / DF / FA / FM /
       HM / VA / VM / VI) used to encode EOSID procedures
     · NTSB AAR-89-04 USAir 5050 LGA OEI / AAR-08-01 Comair
       5191 LEX wrong-runway OEI / AAR-94-04 American 1572
       BDL CFIT OEI · AAR-19-01 Atlas 3591 IAH OEI departure
     · AAIB G-EUOE B777 LHR 2008 fuel-flow OEI departure
     · DCA89AA037 USAir 5050 LGA / DCA08FA081 G450 ASE / ICAO
       ADREP 2017-12-21 RJAA OEI rejected
     · Boeing AERO Q4-2007 / Airbus FAST 49 EOSID design
     · Jeppesen 10-7 / 10-7Z EOSID chart conventions
   ============================================================

   34-runway global catalogue with published EOSID / company
   escape route, terrain-driven gradient requirement, and
   acceleration-height altitude (the height at which 4th
   segment level acceleration begins, typically 800-3000 ft
   AAL depending on terrain):
     · Hot-and-high / mountain-bound:
       KASE Aspen / KEGE Eagle / KTEX Telluride / KJAC Jackson
       Hole / SCEL Santiago Pudahuel / SPJC Lima / SKBO Bogota
       / SEQM Quito / VOMM Chennai / VIDP Delhi / OERK Riyadh /
       OEMA Madinah / FAJS Johannesburg / FAOR ORTambo / NZQN
       Queenstown / LIPB Bolzano / LSGS Sion / LSZA Lugano /
       LOWI Innsbruck / LFLL Lyon / LSGG Geneva
     · Surrounded by terrain / unique escape:
       VHHH Hong Kong / RJTT Tokyo Haneda / RJAA Narita /
       VTBD Bangkok Don Mueang / OMDB Dubai / KSFO San
       Francisco / KSAN San Diego / KLGA New York LaGuardia /
       KMDW Chicago Midway / EGLC London City / LGAV Athens /
       LFMN Nice / WSSS Singapore Changi

   Per-airframe FNV-1a hash of ICAO24 synthesises:
     · departure runway (nearest of 34 catalogue runways the
       aircraft is climbing out of, within 35 nm + 25 deg of
       extended centreline)
     · OEI scenario active flag (hash-stable seeded by
       OEI-RATE 0-100% slider — IFSD baseline 1e-5/hr scaled
       to demo-relevant frequency)
     · failed engine number (1 or 2 of N) — drives asymmetric
       drag/thrust correction to gross gradient
     · current gross weight as fraction of MTOW (with weight
       bias slider) — drives second-segment achieved gradient
       per Boeing AERO Q4-2007 weight-vs-gradient curve

   Per-airframe class catalogue (6 classes):
     HVY-Q (747-8 / A380 / A340) 4-eng net-margin 1.0% min
       second-segment 3.0% TOGW-MTOW 0.85 V2 165
     HVY (777 / 787 / A350 / A330) 2-eng net 0.8% second 2.4%
       TOGW 0.88 V2 158
     NRW (737NG-MAX / A320 / 757) 2-eng net 0.8% second 2.4%
       TOGW 0.92 V2 142
     RGN (CRJ / E-Jet / ATR) 2-eng net 0.8% second 2.4%
       TOGW 0.91 V2 130
     BIZ (GLF / FA7X / CL30) 2-eng net 0.8% second 2.4%
       TOGW 0.78 V2 130
     TBP (PT6 / PW150 / Q400) 2-eng net 0.8% second 2.4%
       TOGW 0.88 V2 118

   Algorithm:
     1. classify phase: TKO (alt-AAL 0-1500ft & climbing &
        velocity 80-200 kt) / 2NDSEG (alt-AAL 35ft to
        acceleration-height) / 4THSEG (acceleration to MEA)
        / CRZ (above acceleration & no departure scope)
     2. nearest runway: 34-catalogue minimum great-circle
        distance + extended-centreline alignment within 25°
        of runway QFU and within 35 nm of DER; if none →
        IDLE
     3. OEI scenario: hash-gated by OEI-RATE slider; if
        active, compute asymmetric correction:
        gross-2ndseg = base gradient × (1 − weight-penalty)
        × (1 − asym-penalty × failed-engine-side)
     4. NET gradient = GROSS − net-margin per CFR 25.115
     5. obstacle MOC: 35 ft net per CFR 25.121(b) /
        ICAO Doc 8168 increasing 0.8% / nm beyond DER until
        acceleration height
     6. terrain-required gradient: per-runway worst-obstacle
        gradient out to 10 nm computed from the catalogue's
        OBSTACLE-GRAD field (% gross required) scaled by
        TERR-MUL slider 50-200%
     7. EOSID compliance score:
        max-driver composite of 5 drivers
        GRD second-segment NET vs required gradient 0 at
          margin ≥ 0.6% ramping 100 at deficit ≥ 0.6%
        OBS obstacle clearance height vs required at worst
          obstacle 0 at clearance ≥ 100 ft ramping 100 at
          breach
        WGT weight vs MTOW 0 at ≤ 0.90 ramping 100 at ≥ 1.00
          (overweight escape envelope)
        AHT acceleration-height vs published 0 at meet ramping
          100 at 500 ft under
        ROT runway-track vs EOSID-track deviation 0 at ≤ 5°
          ramping 100 at ≥ 30° (failure to fly published
          escape turn)
     8. phase multiplier: TKO 1.40 / 2NDSEG 1.50 / 4THSEG
        1.10 / CRZ 0.0 (out of scope)
     9. composite = max-driver × phase-mul + 0.12 ×
        secondary (clip 0-100)
    10. hard escalations:
        net 2nd-segment ≤ 0% in TKO/2NDSEG with OEI active
          ≥ 92 ATLAS3591 tier
        obstacle breach in 2NDSEG with OEI ≥ 88
        AHT deficit ≥ 800 ft ≥ 80 USAIR5050 tier
    11. 5 tiers:
        ATLAS3591 score ≥ 80 OR breach rose
        USAIR5050  score ≥ 55 amber
        WATCH      score ≥ 25 sky
        OK         score < 25 emerald
        IDLE       cruise or no departure scope slate

   Overlay:
     · tier-coloured halo rings 8-22 px by score
     · rose diamond ATLAS3591 pin
     · 34-runway pins coloured by terrain class (HOT-HIGH
       rose / SURROUND amber / NORMAL sky)
     · dashed tier-coloured EOSID escape-route polyline
       projected from DER along published bearing for 10 nm
       (with turn segments for runways requiring escape
       turns ASE LOWI LSGS LSGG LFMN EGLC LFLL VHHH)
     · 5-segment forward-projection 3 nm for non-OK
     · sky reference parallels at lat 60/30/0/-30/-60 every
       12° lng

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-NET-GRAD / WORST callsign / ATLAS3591-count
     · 2-cell OEI-share / TERR-class share secondary row
     · SVG net-gradient vs required-gradient scatter with
       y=x rose breach diagonal + 35 ft amber band + emerald
       margin zone + every aircraft as tier-coloured dot
     · 6 sliders MIN-AGL / WEIGHT-BIAS / OEI-RATE / TERR-MUL
       / NET-MARGIN-MUL / PHASE-WT
     · 3-terrain chip filter HOT-HIGH / SURROUND / NORMAL
     · HALO / PIN / LBL / RWY / ROUTE / PROJ / REF / DIAG
       toggles + search
     · AIRCRAFT / RUNWAYS / CLASSES tab switcher
     · AIRCRAFT tab tier-coloured row, score bar, 5-cell
       breakdown chips, advice click-to-fly
     · RUNWAYS tab sorted by served desc with terrain-class
       stripe / EOSID-track / required-grad / acc-ht / served
       / ATLAS3591-count
     · CLASSES tab grouped by class sorted worst-tier-first
       with class-pill / N-eng / net-margin / 2nd-seg-min /
       mean-score / worst-callsign

   Layers > Safety & Traffic.
   Persisted: ft-eosid
   ============================================================ */

interface EFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: EFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'ATLAS3591' | 'USAIR5050' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  ATLAS3591: '#ef4444', USAIR5050: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['ATLAS3591', 'USAIR5050', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { ATLAS3591: 0, USAIR5050: 1, WATCH: 2, OK: 3, IDLE: 4 }

type TClass = 'HOT-HIGH' | 'SURROUND' | 'NORMAL'
const TCLASS_COLOR: Record<TClass, string> = { 'HOT-HIGH': '#ef4444', SURROUND: '#f59e0b', NORMAL: '#0ea5e9' }
type Phase = 'TKO' | '2NDSEG' | '4THSEG' | 'CRZ'
const PHASE_MUL: Record<Phase, number> = { TKO: 1.40, '2NDSEG': 1.50, '4THSEG': 1.10, CRZ: 0 }

type AcClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
interface ClassSpec { nEng: number; netMargin: number; secondSegMin: number; togwFrac: number; v2: number; family: string }
const CLASS_SPEC: Record<AcClass, ClassSpec> = {
  'HVY-Q': { nEng: 4, netMargin: 1.0, secondSegMin: 3.0, togwFrac: 0.85, v2: 165, family: '747-8 / A380 / A340' },
  'HVY':   { nEng: 2, netMargin: 0.8, secondSegMin: 2.4, togwFrac: 0.88, v2: 158, family: '777 / 787 / A350 / A330' },
  'NRW':   { nEng: 2, netMargin: 0.8, secondSegMin: 2.4, togwFrac: 0.92, v2: 142, family: '737NG / A320 / 757' },
  'RGN':   { nEng: 2, netMargin: 0.8, secondSegMin: 2.4, togwFrac: 0.91, v2: 130, family: 'CRJ / E-Jet / ATR' },
  'BIZ':   { nEng: 2, netMargin: 0.8, secondSegMin: 2.4, togwFrac: 0.78, v2: 130, family: 'GLF / FA7X / CL30' },
  'TBP':   { nEng: 2, netMargin: 0.8, secondSegMin: 2.4, togwFrac: 0.88, v2: 118, family: 'PT6 / PW150 / Q400' },
}

interface Runway {
  icao: string; name: string; lat: number; lng: number; elevFt: number
  qfu: number          // departure runway bearing deg-true
  rwId: string         // e.g. "08L"
  tclass: TClass
  reqGrad: number      // % gross gradient required for terrain (worst within 10 nm)
  accHt: number        // ft AAL acceleration height
  escapeBearing: number // deg-true EOSID escape track (may differ from QFU)
  turnAt: number       // nm from DER where escape turn begins (0 = straight)
  notes: string
}
const RWYS: Runway[] = [
  // Hot-and-high / mountain
  { icao: 'KASE', name: 'Aspen', lat: 39.223, lng: -106.869, elevFt: 7820, qfu: 152, rwId: '15', tclass: 'HOT-HIGH', reqGrad: 6.8, accHt: 2800, escapeBearing: 220, turnAt: 1.5, notes: 'EOSID via LINDZ left turn 220° / 9000 ft MEA' },
  { icao: 'KEGE', name: 'Eagle/Vail', lat: 39.643, lng: -106.918, elevFt: 6548, qfu: 250, rwId: '25', tclass: 'HOT-HIGH', reqGrad: 5.6, accHt: 2600, escapeBearing: 250, turnAt: 0, notes: 'Straight valley climb 11,500 ft' },
  { icao: 'KTEX', name: 'Telluride', lat: 37.954, lng: -107.909, elevFt: 9078, qfu: 90, rwId: '09', tclass: 'HOT-HIGH', reqGrad: 7.2, accHt: 3000, escapeBearing: 90, turnAt: 0, notes: 'Mesa-top single-direction departure' },
  { icao: 'KJAC', name: 'Jackson Hole', lat: 43.607, lng: -110.737, elevFt: 6451, qfu: 190, rwId: '19', tclass: 'HOT-HIGH', reqGrad: 5.4, accHt: 2600, escapeBearing: 190, turnAt: 3, notes: 'South Pass climb left 160° at 3 nm' },
  { icao: 'SCEL', name: 'Santiago', lat: -33.393, lng: -70.785, elevFt: 1555, qfu: 170, rwId: '17L', tclass: 'HOT-HIGH', reqGrad: 4.8, accHt: 2400, escapeBearing: 170, turnAt: 5, notes: 'Andes south escape / right 245° at 5 nm' },
  { icao: 'SPJC', name: 'Lima Callao', lat: -12.022, lng: -77.114, elevFt: 113, qfu: 153, rwId: '15', tclass: 'NORMAL', reqGrad: 2.5, accHt: 1500, escapeBearing: 153, turnAt: 0, notes: 'Standard PDG 3.3%' },
  { icao: 'SKBO', name: 'Bogota El Dorado', lat: 4.701, lng: -74.147, elevFt: 8361, qfu: 130, rwId: '13L', tclass: 'HOT-HIGH', reqGrad: 4.6, accHt: 2400, escapeBearing: 130, turnAt: 0, notes: 'Sabana plateau / cold-and-high' },
  { icao: 'SEQM', name: 'Quito Tababela', lat: -0.124, lng: -78.359, elevFt: 7841, qfu: 36, rwId: '36', tclass: 'HOT-HIGH', reqGrad: 5.0, accHt: 2800, escapeBearing: 36, turnAt: 4, notes: 'Andes valley climb / right 90° at 4 nm' },
  { icao: 'VOMM', name: 'Chennai', lat: 12.994, lng: 80.180, elevFt: 52, qfu: 70, rwId: '07', tclass: 'NORMAL', reqGrad: 2.5, accHt: 1500, escapeBearing: 70, turnAt: 0, notes: 'Coastal departure' },
  { icao: 'VIDP', name: 'Delhi', lat: 28.566, lng: 77.103, elevFt: 777, qfu: 270, rwId: '27', tclass: 'NORMAL', reqGrad: 3.0, accHt: 1500, escapeBearing: 270, turnAt: 0, notes: 'Standard climb' },
  { icao: 'OERK', name: 'Riyadh', lat: 24.957, lng: 46.699, elevFt: 2049, qfu: 333, rwId: '33L', tclass: 'NORMAL', reqGrad: 3.2, accHt: 1800, escapeBearing: 333, turnAt: 0, notes: 'High-DA OAT-driven derate' },
  { icao: 'OEMA', name: 'Madinah', lat: 24.553, lng: 39.705, elevFt: 2151, qfu: 350, rwId: '35', tclass: 'HOT-HIGH', reqGrad: 4.4, accHt: 2400, escapeBearing: 350, turnAt: 3, notes: 'Volcanic terrain right 040° at 3 nm' },
  { icao: 'FAJS', name: 'Johannesburg OR', lat: -26.139, lng: 28.246, elevFt: 5558, qfu: 30, rwId: '03L', tclass: 'HOT-HIGH', reqGrad: 3.8, accHt: 2000, escapeBearing: 30, turnAt: 0, notes: 'Highveld plateau' },
  { icao: 'FAOR', name: 'OR Tambo Intl', lat: -26.135, lng: 28.246, elevFt: 5558, qfu: 210, rwId: '21R', tclass: 'HOT-HIGH', reqGrad: 3.8, accHt: 2000, escapeBearing: 210, turnAt: 0, notes: 'Reciprocal plateau' },
  { icao: 'NZQN', name: 'Queenstown', lat: -45.022, lng: 168.739, elevFt: 1171, qfu: 235, rwId: '23', tclass: 'SURROUND', reqGrad: 6.6, accHt: 3000, escapeBearing: 280, turnAt: 1, notes: 'Wakatipu basin / right 290° at 1 nm published RNP AR EOSID' },
  { icao: 'LIPB', name: 'Bolzano', lat: 46.461, lng: 11.327, elevFt: 789, qfu: 1, rwId: '01', tclass: 'SURROUND', reqGrad: 5.2, accHt: 2800, escapeBearing: 1, turnAt: 0, notes: 'Alpine valley single-direction' },
  { icao: 'LSGS', name: 'Sion', lat: 46.220, lng: 7.327, elevFt: 1583, qfu: 250, rwId: '25', tclass: 'SURROUND', reqGrad: 6.4, accHt: 3000, escapeBearing: 250, turnAt: 2, notes: 'Rhone valley / left 200° at 2 nm racetrack hold' },
  { icao: 'LSZA', name: 'Lugano', lat: 46.004, lng: 8.911, elevFt: 915, qfu: 187, rwId: '19', tclass: 'SURROUND', reqGrad: 5.8, accHt: 2800, escapeBearing: 187, turnAt: 0, notes: 'Lake-bound 6.65% PDG' },
  { icao: 'LOWI', name: 'Innsbruck', lat: 47.260, lng: 11.344, elevFt: 1907, qfu: 80, rwId: '08', tclass: 'SURROUND', reqGrad: 6.0, accHt: 2800, escapeBearing: 80, turnAt: 4, notes: 'Inn valley / RIVER VISUAL right 260° at 4 nm RTN' },
  { icao: 'LFLL', name: 'Lyon St Exupery', lat: 45.726, lng: 5.090, elevFt: 821, qfu: 360, rwId: '36L', tclass: 'NORMAL', reqGrad: 3.0, accHt: 1800, escapeBearing: 360, turnAt: 0, notes: 'Rhone corridor / Alps east escape via SOSAL' },
  { icao: 'LSGG', name: 'Geneva', lat: 46.238, lng: 6.108, elevFt: 1411, qfu: 230, rwId: '23', tclass: 'SURROUND', reqGrad: 4.6, accHt: 2400, escapeBearing: 230, turnAt: 3, notes: 'Jura escape left 180° at 3 nm DER' },
  // Surround / unique escape
  { icao: 'VHHH', name: 'Hong Kong', lat: 22.308, lng: 113.918, elevFt: 28, qfu: 70, rwId: '07R', tclass: 'SURROUND', reqGrad: 3.8, accHt: 1800, escapeBearing: 70, turnAt: 2.5, notes: 'Lantau escape right 095° at 2.5 nm' },
  { icao: 'RJTT', name: 'Tokyo Haneda', lat: 35.553, lng: 139.781, elevFt: 21, qfu: 340, rwId: '34L', tclass: 'NORMAL', reqGrad: 3.0, accHt: 1500, escapeBearing: 340, turnAt: 0, notes: 'Bay departure' },
  { icao: 'RJAA', name: 'Narita', lat: 35.766, lng: 140.386, elevFt: 135, qfu: 161, rwId: '16R', tclass: 'NORMAL', reqGrad: 3.0, accHt: 1500, escapeBearing: 161, turnAt: 0, notes: 'Standard PDG' },
  { icao: 'VTBD', name: 'Bangkok Don Mueang', lat: 13.912, lng: 100.607, elevFt: 9, qfu: 213, rwId: '21L', tclass: 'NORMAL', reqGrad: 2.5, accHt: 1500, escapeBearing: 213, turnAt: 0, notes: 'Standard' },
  { icao: 'OMDB', name: 'Dubai', lat: 25.253, lng: 55.365, elevFt: 62, qfu: 305, rwId: '30L', tclass: 'NORMAL', reqGrad: 3.0, accHt: 1500, escapeBearing: 305, turnAt: 0, notes: 'High-OAT derate primary driver' },
  { icao: 'KSFO', name: 'San Francisco', lat: 37.619, lng: -122.375, elevFt: 13, qfu: 282, rwId: '28L', tclass: 'SURROUND', reqGrad: 4.0, accHt: 2000, escapeBearing: 282, turnAt: 3, notes: 'San Bruno gap right 320° at 3 nm' },
  { icao: 'KSAN', name: 'San Diego Lindbergh', lat: 32.733, lng: -117.190, elevFt: 17, qfu: 270, rwId: '27', tclass: 'SURROUND', reqGrad: 4.2, accHt: 2200, escapeBearing: 270, turnAt: 1, notes: 'Point Loma escape right 290° at 1 nm' },
  { icao: 'KLGA', name: 'New York LaGuardia', lat: 40.777, lng: -73.872, elevFt: 21, qfu: 40, rwId: '04', tclass: 'NORMAL', reqGrad: 3.5, accHt: 1500, escapeBearing: 40, turnAt: 2, notes: 'Whitestone climb left 010° at 2 nm USAir 5050 site' },
  { icao: 'KMDW', name: 'Chicago Midway', lat: 41.786, lng: -87.752, elevFt: 619, qfu: 310, rwId: '31C', tclass: 'NORMAL', reqGrad: 3.2, accHt: 1500, escapeBearing: 310, turnAt: 0, notes: 'Standard but short' },
  { icao: 'EGLC', name: 'London City', lat: 51.505, lng: 0.055, elevFt: 19, qfu: 90, rwId: '09', tclass: 'SURROUND', reqGrad: 5.5, accHt: 2400, escapeBearing: 90, turnAt: 1, notes: 'Steep 5.5° PDG / left 060° at 1 nm river escape' },
  { icao: 'LGAV', name: 'Athens', lat: 37.937, lng: 23.945, elevFt: 308, qfu: 213, rwId: '21R', tclass: 'NORMAL', reqGrad: 3.0, accHt: 1500, escapeBearing: 213, turnAt: 0, notes: 'Plain departure' },
  { icao: 'LFMN', name: 'Nice', lat: 43.665, lng: 7.215, elevFt: 12, qfu: 220, rwId: '22L', tclass: 'SURROUND', reqGrad: 4.4, accHt: 2200, escapeBearing: 220, turnAt: 2, notes: 'Cap Antibes left 175° at 2 nm sea escape' },
  { icao: 'WSSS', name: 'Singapore Changi', lat: 1.359, lng: 103.989, elevFt: 22, qfu: 200, rwId: '20C', tclass: 'NORMAL', reqGrad: 3.0, accHt: 1500, escapeBearing: 200, turnAt: 0, notes: 'Sea departure' },
]

const FAMILY_CLASS: Array<[RegExp, AcClass]> = [
  [/^(A38|A340|A30|A31|74[0-9]|74F|74M)/i, 'HVY-Q'],
  [/^(B77|B78|77[0-9]|78[0-9]|A33|A35)/i, 'HVY'],
  [/^(B73|B75|73[0-9]|75[0-9]|A31[89]|A32[0-9]|MAX)/i, 'NRW'],
  [/^(CRJ|E1[79][0-9]|E2[27][05]|ERJ|ATR|AT4|AT7)/i, 'RGN'],
  [/^(GLF|G[VI]|GLEX|G6[05]0|FA[57]X|CL[36]0|LJ[34567])/i, 'BIZ'],
  [/^(DH[CC]|DH8|Q40|PC1|PC2|PT6|TBM|BE2|BE3|SF34|J32)/i, 'TBP'],
]
function classify(type?: string): AcClass {
  const t = (type || '').toUpperCase().trim()
  for (const [re, c] of FAMILY_CLASS) if (re.test(t)) return c
  return 'NRW'
}

type Driver = 'GRD' | 'OBS' | 'WGT' | 'AHT' | 'ROT' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  GRD: '2nd-seg net < required',
  OBS: 'Obstacle MOC breach',
  WGT: 'TOGW overweight escape',
  AHT: 'Acceleration height deficit',
  ROT: 'Escape-turn track deviation',
  NONE: 'EOSID nominal',
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
function haversineNm(la1: number, lo1: number, la2: number, lo2: number) {
  const R = 3440.065
  const dLat = (la2 - la1) * Math.PI / 180
  const dLon = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number) {
  const phi1 = la1 * Math.PI / 180, phi2 = la2 * Math.PI / 180
  const dLon = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dLon) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon)
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360
}
function destPoint(la: number, lo: number, brgDeg: number, distNm: number): [number, number] {
  const R = 3440.065
  const brg = brgDeg * Math.PI / 180
  const lat1 = la * Math.PI / 180, lon1 = lo * Math.PI / 180
  const d = distNm / R
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg))
  const lon2 = lon1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2))
  return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI]
}
function angDiff(a: number, b: number) {
  let d = Math.abs(a - b) % 360
  if (d > 180) d = 360 - d
  return d
}
function classifyPhase(altAgl: number, vs: number, vel: number, hasDep: boolean): Phase {
  if (!hasDep) return 'CRZ'
  if (altAgl < 35) return 'TKO'
  if (altAgl < 1500 && vs > 200) return '2NDSEG'
  if (altAgl < 5000 && vs > 0) return '4THSEG'
  return 'CRZ'
}

interface Row {
  f: EFlight; cls: AcClass; spec: ClassSpec; phase: Phase
  rwy: Runway | null; aglFt: number; alignDeg: number; distFromDerNm: number
  oei: boolean; failedEng: number
  togwFrac: number; grossGrad: number; netGrad: number; reqGrad: number
  obstacleClearFt: number
  trackDevDeg: number
  sev: { grd: number; obs: number; wgt: number; aht: number; rot: number }
  score: number; driver: Driver; tier: Tier
}

const SRC_HALO = 'eosid-halo', SRC_LBL = 'eosid-lbl', SRC_PIN = 'eosid-pin', SRC_RWY = 'eosid-rwy', SRC_ROUTE = 'eosid-route', SRC_PROJ = 'eosid-proj', SRC_REF = 'eosid-ref'
const LYR_HALO = SRC_HALO + '-l', LYR_LBL = SRC_LBL + '-l', LYR_PIN = SRC_PIN + '-l', LYR_RWY = SRC_RWY + '-l', LYR_RWY_LBL = SRC_RWY + '-lbl-l', LYR_ROUTE = SRC_ROUTE + '-l', LYR_PROJ = SRC_PROJ + '-l', LYR_REF = SRC_REF + '-l'

export default function EosidMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'RUNWAYS' | 'CLASSES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tcFilter, setTcFilter] = useState<TClass | 'ALL'>('ALL')
  const [minAgl, setMinAgl] = useState(0)
  const [weightBias, setWeightBias] = useState(0)     // -15 to +15 pct
  const [oeiRate, setOeiRate] = useState(40)          // 0-100 pct
  const [terrMul, setTerrMul] = useState(100)         // 50-200 pct
  const [netMul, setNetMul] = useState(100)           // 50-200 pct
  const [phaseWt, setPhaseWt] = useState(100)         // 50-150 pct
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showRwy, setShowRwy] = useState(true)
  const [showRoute, setShowRoute] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const cls = classify(f.type)
      const spec = CLASS_SPEC[cls]
      const h = hash32(f.icao || '')

      // Find nearest catalogue runway within 35 nm
      let rwy: Runway | null = null
      let bestDist = 1e9
      let alignDeg = 999
      const pool = tcFilter === 'ALL' ? RWYS : RWYS.filter(r => r.tclass === tcFilter)
      for (const r of pool) {
        const d = haversineNm(f.lat, f.lng, r.lat, r.lng)
        if (d > 35) continue
        const brg = bearingDeg(r.lat, r.lng, f.lat, f.lng)
        const align = angDiff(brg, r.qfu)
        if (align > 25) continue
        if (d < bestDist) { bestDist = d; rwy = r; alignDeg = align }
      }

      const aglFt = rwy ? Math.max(0, f.altitudeFt - rwy.elevFt) : f.altitudeFt
      if (aglFt < minAgl) continue
      const hasDep = !!rwy && bestDist < 35
      const phase = classifyPhase(aglFt, f.vertRate, f.velocityKts, hasDep)

      // OEI scenario gate
      const oei = ((h & 0xffff) / 0xffff) * 100 < oeiRate && hasDep && (phase === 'TKO' || phase === '2NDSEG' || phase === '4THSEG')
      const failedEng = oei ? ((h >>> 16) & 1) + 1 : 0

      // Weight bias: 0.05 hash-stable variance + slider
      const wHash = ((h >>> 8) & 0xff) / 0xff       // 0..1
      const togwFrac = Math.min(1.05, Math.max(0.55, spec.togwFrac + (wHash - 0.5) * 0.10 + weightBias / 100))

      // Gross 2nd-segment gradient — degrade with TOGW & OEI asymmetric drag
      // Base = spec.secondSegMin + 0.8 (cert margin) - weight penalty
      const base = spec.secondSegMin + 0.8
      const wPen = Math.max(0, (togwFrac - 0.85)) * 9.0   // pct per fraction
      let grossGrad = base - wPen
      if (oei) grossGrad -= 0.30 * (failedEng === 1 ? 1.05 : 0.95)  // asym handling
      grossGrad = Math.max(0, grossGrad)

      const netGrad = grossGrad - spec.netMargin * (netMul / 100)
      const reqGrad = rwy ? rwy.reqGrad * (terrMul / 100) : 2.5

      // Obstacle clearance at worst point (assume worst obstacle at 4 nm AAL height = derived)
      // 35 ft MOC at DER, +0.8% per nm beyond
      const worstObstacleNm = 4
      const obstacleHt = worstObstacleNm * 6076.12 * reqGrad / 100   // ft
      const climbHt = (rwy ? 35 : 0) + worstObstacleNm * 6076.12 * netGrad / 100
      const obstacleClearFt = climbHt - obstacleHt

      // Track deviation from EOSID escape bearing
      const trackDevDeg = rwy ? angDiff(f.track, rwy.escapeBearing) : 0

      // Drivers (scored only if hasDep & oei active)
      const active = hasDep && oei
      const gradDef = reqGrad - netGrad           // positive = deficit
      const grdSev = !active ? 0 : gradDef <= -0.6 ? 0 : gradDef >= 0.6 ? 100 : ((gradDef + 0.6) / 1.2) * 100
      const obsSev = !active ? 0 : obstacleClearFt >= 100 ? 0 : obstacleClearFt <= -50 ? 100 : ((100 - obstacleClearFt) / 150) * 100
      const wgtSev = togwFrac <= 0.90 ? 0 : togwFrac >= 1.00 ? 100 : ((togwFrac - 0.90) / 0.10) * 100
      const ahtDeficit = rwy ? Math.max(0, rwy.accHt - aglFt) : 0
      const ahtSev = !active ? 0 : ahtDeficit <= 0 ? 0 : ahtDeficit >= 500 ? 100 : (ahtDeficit / 500) * 100
      const rotSev = !active ? 0 : trackDevDeg <= 5 ? 0 : trackDevDeg >= 30 ? 100 : ((trackDevDeg - 5) / 25) * 100

      const sev = { grd: grdSev, obs: obsSev, wgt: wgtSev, aht: ahtSev, rot: rotSev }
      const drivers: Array<[Driver, number]> = [['GRD', sev.grd], ['OBS', sev.obs], ['WGT', sev.wgt], ['AHT', sev.aht], ['ROT', sev.rot]]
      drivers.sort((a, b) => b[1] - a[1])
      const driver: Driver = drivers[0][1] >= 15 ? drivers[0][0] : 'NONE'
      const phMul = PHASE_MUL[phase] * (phaseWt / 100)
      let score = Math.min(100, drivers[0][1] * phMul + 0.12 * drivers[1][1])
      // Hard escalations
      if (active && (phase === 'TKO' || phase === '2NDSEG') && netGrad <= 0) score = Math.max(score, 92)
      if (active && phase === '2NDSEG' && obstacleClearFt < 0) score = Math.max(score, 88)
      if (active && ahtDeficit >= 800) score = Math.max(score, 80)
      if (phase === 'CRZ') score = 0

      let tier: Tier
      if (phase === 'CRZ' || !hasDep) tier = 'IDLE'
      else if (score >= 80) tier = 'ATLAS3591'
      else if (score >= 55) tier = 'USAIR5050'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({ f, cls, spec, phase, rwy, aglFt, alignDeg, distFromDerNm: bestDist, oei, failedEng, togwFrac, grossGrad, netGrad, reqGrad, obstacleClearFt, trackDevDeg, sev, score, driver, tier })
    }
    return out
  }, [flights, minAgl, weightBias, oeiRate, terrMul, netMul, phaseWt, tcFilter])

  const tierCount: Record<Tier, number> = { ATLAS3591: 0, USAIR5050: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++

  const active = rows.filter(r => r.tier !== 'IDLE')
  const meanNetGrad = active.length ? active.reduce((a, r) => a + r.netGrad, 0) / active.length : 0
  const meanReqGrad = active.length ? active.reduce((a, r) => a + r.reqGrad, 0) / active.length : 0
  const oeiShare = active.length ? active.filter(r => r.oei).length / active.length : 0
  const hotHighShare = active.length ? active.filter(r => r.rwy && r.rwy.tclass === 'HOT-HIGH').length / active.length : 0
  const worst = active.length ? active.slice().sort((a, b) => b.score - a.score)[0] : null

  const rwyRows = useMemo(() => {
    const m = new Map<string, { rwy: Runway; served: number; sumScore: number; atlasCount: number }>()
    for (const r of rows) {
      if (!r.rwy) continue
      const e = m.get(r.rwy.icao) || { rwy: r.rwy, served: 0, sumScore: 0, atlasCount: 0 }
      e.served++; e.sumScore += r.score; if (r.tier === 'ATLAS3591') e.atlasCount++
      m.set(r.rwy.icao, e)
    }
    const arr: Array<{ rwy: Runway; served: number; meanScore: number; atlasCount: number }> = []
    for (const [, v] of m) arr.push({ rwy: v.rwy, served: v.served, meanScore: v.served ? v.sumScore / v.served : 0, atlasCount: v.atlasCount })
    for (const r of RWYS) if (!m.has(r.icao)) arr.push({ rwy: r, served: 0, meanScore: 0, atlasCount: 0 })
    arr.sort((a, b) => b.served - a.served || a.rwy.icao.localeCompare(b.rwy.icao))
    return arr
  }, [rows])

  const classRows = useMemo(() => {
    const m = new Map<AcClass, { cls: AcClass; spec: ClassSpec; ac: number; sumScore: number; atlasCount: number; oeiCount: number; worst: Row | null }>()
    for (const c of Object.keys(CLASS_SPEC) as AcClass[]) m.set(c, { cls: c, spec: CLASS_SPEC[c], ac: 0, sumScore: 0, atlasCount: 0, oeiCount: 0, worst: null })
    for (const r of rows) {
      const e = m.get(r.cls)!
      e.ac++; e.sumScore += r.score; if (r.tier === 'ATLAS3591') e.atlasCount++; if (r.oei) e.oeiCount++
      if (!e.worst || r.score > e.worst.score) e.worst = r
    }
    return Array.from(m.values()).sort((a, b) => b.atlasCount - a.atlasCount || b.sumScore - a.sumScore)
  }, [rows])

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(x => (x.f.callsign || '').toLowerCase().includes(q) || (x.f.type || '').toLowerCase().includes(q) || (x.f.icao || '').toLowerCase().includes(q) || (x.rwy?.icao || '').toLowerCase().includes(q))
    return r.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, query])

  useEffect(() => {
    if (!map) return
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }) }
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_RWY, SRC_ROUTE, SRC_PROJ, SRC_REF]
    sources.forEach(ensure)
    if (!map.getLayer(LYR_REF)) map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.14, 'line-width': 0.7, 'line-dasharray': [2, 4] } })
    if (!map.getLayer(LYR_ROUTE)) map.addLayer({ id: LYR_ROUTE, type: 'line', source: SRC_ROUTE, paint: { 'line-color': ['get', 'color'], 'line-width': 1.6, 'line-opacity': 0.75, 'line-dasharray': [4, 2] } })
    if (!map.getLayer(LYR_PROJ)) map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.6, 'line-dasharray': [2, 3] } })
    if (!map.getLayer(LYR_HALO)) map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.65, 'circle-stroke-width': 1.4 } })
    if (!map.getLayer(LYR_RWY)) map.addLayer({ id: LYR_RWY, type: 'circle', source: SRC_RWY, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.85, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.4 } })
    if (!map.getLayer(LYR_RWY_LBL)) map.addLayer({ id: LYR_RWY_LBL, type: 'symbol', source: SRC_RWY, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.1], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.4 } })
    if (!map.getLayer(LYR_PIN)) map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': '◆', 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    if (!map.getLayer(LYR_LBL)) map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })

    const halo: any[] = [], lbl: any[] = [], pin: any[] = [], rwy: any[] = [], route: any[] = [], proj: any[] = [], ref: any[] = []

    if (showRwy) {
      for (const rr of rwyRows) {
        if (tcFilter !== 'ALL' && rr.rwy.tclass !== tcFilter) continue
        const c = TCLASS_COLOR[rr.rwy.tclass]
        const r = 4 + Math.min(5, Math.sqrt(rr.served))
        rwy.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [rr.rwy.lng, rr.rwy.lat] }, properties: { color: c, r, label: `${rr.rwy.icao} ${rr.rwy.rwId}` } })
        if (showRoute) {
          const coords: [number, number][] = [[rr.rwy.lng, rr.rwy.lat]]
          if (rr.rwy.turnAt > 0) {
            const turn = destPoint(rr.rwy.lat, rr.rwy.lng, rr.rwy.qfu, rr.rwy.turnAt)
            coords.push(turn)
            const end = destPoint(turn[1], turn[0], rr.rwy.escapeBearing, Math.max(2, 10 - rr.rwy.turnAt))
            coords.push(end)
          } else {
            const end = destPoint(rr.rwy.lat, rr.rwy.lng, rr.rwy.escapeBearing, 10)
            coords.push(end)
          }
          route.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { color: c } })
        }
      }
    }
    for (const r of rows) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'OK' && r.tier !== 'IDLE') {
        const rad = 8 + (r.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: rad } })
      }
      if (showPin && r.tier === 'ATLAS3591') pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      if (showLbl && (r.tier === 'ATLAS3591' || r.tier === 'USAIR5050')) {
        const label = `${r.f.callsign || r.f.icao}${r.oei ? ' OEI' : ''} · ${r.rwy?.icao || '—'} ${r.rwy?.rwId || ''} · NET ${r.netGrad.toFixed(1)}% / REQ ${r.reqGrad.toFixed(1)}%`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showProj && (r.tier === 'ATLAS3591' || r.tier === 'USAIR5050')) {
        const coords: [number, number][] = []
        for (let i = 0; i <= 5; i++) {
          coords.push(destPoint(r.f.lat, r.f.lng, r.f.track, i * 0.6))
        }
        proj.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { color } })
      }
    }
    for (const lat of [60, 30, 0, -30, -60]) {
      const coords: [number, number][] = []
      for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
      ref.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
    }

    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_RWY) as any).setData({ type: 'FeatureCollection', features: rwy })
    ;(map.getSource(SRC_ROUTE) as any).setData({ type: 'FeatureCollection', features: route })
    ;(map.getSource(SRC_PROJ) as any).setData({ type: 'FeatureCollection', features: proj })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: ref })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_ROUTE, LYR_RWY_LBL, LYR_RWY, LYR_REF]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of sources) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, rows, rwyRows, showHalo, showPin, showLbl, showRwy, showRoute, showProj, tcFilter])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const driverBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (r: Row) => {
    if (!r.rwy) return 'No catalogued EOSID for departure runway'
    if (r.tier === 'ATLAS3591') return `OEI escape FAILURE · NET ${r.netGrad.toFixed(1)}% < REQ ${r.reqGrad.toFixed(1)}% at ${r.rwy.icao} ${r.rwy.rwId} · declare MAYDAY · fly ${r.rwy.notes} per 14 CFR 121.197 / FCOM EOSID`
    if (r.tier === 'USAIR5050') return `Marginal escape · brief published EOSID ${r.rwy.escapeBearing.toFixed(0)}° ${r.rwy.turnAt > 0 ? `turn at ${r.rwy.turnAt} nm` : 'straight'} · acc-ht ${r.rwy.accHt} ft AAL · request lower MTOW or wait for cooler OAT`
    if (r.tier === 'WATCH') return `Monitor 2nd-segment gradient · pre-brief EOSID escape ${r.rwy.qfu.toFixed(0)}°→${r.rwy.escapeBearing.toFixed(0)}° / req ${r.rwy.reqGrad}% / acc-ht ${r.rwy.accHt} ft`
    return `EOSID OK · NET ${r.netGrad.toFixed(1)}% > REQ ${r.reqGrad.toFixed(1)}% margin ${(r.netGrad - r.reqGrad).toFixed(1)}%`
  }

  // Scatter: req-grad (x) vs net-grad (y)
  const W = 280, H = 180
  const xMax = 8, yMax = 8
  const sx = (n: number) => 32 + (Math.min(xMax, Math.max(0, n)) / xMax) * (W - 42)
  const sy = (e: number) => H - 24 - (Math.min(yMax, Math.max(0, e)) / yMax) * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">EOSID · OEI Escape & Net Flight Path</div>
          <div className="text-[10px] text-slate-500">14 CFR 25.111 / 25.115 / 25.121 · ICAO Doc 8168 / FAA 8260.46F / EASA AMC 25.121</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[10px] font-semibold" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean NET grad</div>
          <div className="text-sm font-semibold" style={{ color: meanNetGrad < meanReqGrad ? '#ef4444' : meanNetGrad < meanReqGrad + 0.5 ? '#f59e0b' : '#10b981' }}>{meanNetGrad.toFixed(2)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">ATLAS3591</div>
          <div className="text-sm font-semibold" style={{ color: tierCount.ATLAS3591 > 0 ? '#ef4444' : '#10b981' }}>{tierCount.ATLAS3591}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">OEI share</div>
          <div className="text-xs font-semibold" style={{ color: oeiShare > 0.5 ? '#ef4444' : oeiShare > 0.2 ? '#f59e0b' : '#10b981' }}>{(oeiShare * 100).toFixed(1)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">HOT-HIGH share</div>
          <div className="text-xs font-semibold" style={{ color: hotHighShare > 0.4 ? '#ef4444' : hotHighShare > 0.15 ? '#f59e0b' : '#10b981' }}>{(hotHighShare * 100).toFixed(1)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={32} y={24} width={W - 42} height={H - 48} fill="#0b1220" />
            {/* y=x diagonal: above = OK (emerald), below = breach (rose) */}
            <polygon points={`${sx(0)},${sy(0)} ${sx(xMax)},${sy(0)} ${sx(xMax)},${sy(xMax)}`} fill="#ef4444" opacity={0.10} />
            <polygon points={`${sx(0)},${sy(0)} ${sx(0)},${sy(yMax)} ${sx(xMax)},${sy(xMax)}`} fill="#10b981" opacity={0.08} />
            <line x1={sx(0)} y1={sy(0)} x2={sx(xMax)} y2={sy(xMax)} stroke="#64748b" strokeDasharray="2 2" strokeOpacity={0.7} />
            {/* 0.5% margin band amber */}
            <line x1={sx(0)} y1={sy(0.5)} x2={sx(xMax - 0.5)} y2={sy(xMax)} stroke="#f59e0b" strokeDasharray="3 3" strokeOpacity={0.5} />
            {active.map((r, i) => (
              <circle key={i} cx={sx(r.reqGrad)} cy={sy(r.netGrad)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={r.oei ? 0.9 : 0.4} />
            ))}
            <text x={W / 2} y={H - 6} fontSize={9} fill="#64748b" textAnchor="middle">required gradient %</text>
            <text x={6} y={H / 2} fontSize={9} fill="#64748b" transform={`rotate(-90 6 ${H / 2})`} textAnchor="middle">NET 2nd-seg %</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-AGL {minAgl} ft</span><input type="range" min={0} max={5000} step={100} value={minAgl} onChange={e => setMinAgl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">WEIGHT-BIAS {weightBias > 0 ? '+' : ''}{weightBias}%</span><input type="range" min={-15} max={15} value={weightBias} onChange={e => setWeightBias(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">OEI-RATE {oeiRate}%</span><input type="range" min={0} max={100} value={oeiRate} onChange={e => setOeiRate(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">TERR-MUL {terrMul}%</span><input type="range" min={50} max={200} value={terrMul} onChange={e => setTerrMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">NET-MARGIN {netMul}%</span><input type="range" min={50} max={200} value={netMul} onChange={e => setNetMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setTcFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${tcFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {(['HOT-HIGH', 'SURROUND', 'NORMAL'] as const).map(t => (
          <button key={t} onClick={() => setTcFilter(tcFilter === t ? 'ALL' : t)} className={`px-2 py-0.5 rounded text-[10px] border ${tcFilter === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLbl, setShowLbl], ['RWY', showRwy, setShowRwy], ['ROUTE', showRoute, setShowRoute], ['PROJ', showProj, setShowProj], ['DIAG', showDiag, setShowDiag]] as const).map(([l, v, s]) => (
          <button key={l} onClick={() => s(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>{l}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / type / icao / rwy" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'RUNWAYS', 'CLASSES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.cls}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.phase}</span>
              {r.oei && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/30">OEI E{r.failedEng}</span>}
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              {r.rwy ? `${r.rwy.icao} ${r.rwy.rwId}` : '—'} · AGL {r.aglFt.toFixed(0)} ft · TOGW {(r.togwFrac * 100).toFixed(0)}% MTOW · NET {r.netGrad.toFixed(2)}% / REQ {r.reqGrad.toFixed(2)}% · MOC {r.obstacleClearFt.toFixed(0)} ft · trk-dev {r.trackDevDeg.toFixed(0)}°
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('GRD', r.sev.grd)}{driverBadge('OBS', r.sev.obs)}{driverBadge('WGT', r.sev.wgt)}{driverBadge('AHT', r.sev.aht)}{driverBadge('ROT', r.sev.rot)}
            </div>
            <div className="px-2 pb-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {advice(r)}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && filtered.length === 0 && <div className="text-center py-6 text-slate-500 text-[11px]">No aircraft match the current filters.</div>}

        {tab === 'RUNWAYS' && rwyRows.filter(rr => tcFilter === 'ALL' || rr.rwy.tclass === tcFilter).slice(0, 80).map((rr, i) => {
          const c = TCLASS_COLOR[rr.rwy.tclass]
          return (
            <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
              <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${c}` }}>
                <span className="font-semibold text-slate-100">{rr.rwy.icao}</span>
                <span className="text-slate-500 text-[10px] truncate">{rr.rwy.name} · {rr.rwy.rwId}</span>
                <span className="px-1 py-px rounded text-[9px]" style={{ color: c, backgroundColor: c + '22', border: `1px solid ${c}66` }}>{rr.rwy.tclass}</span>
                <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{rr.served} AC</span>
                {rr.atlasCount > 0 && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/30">{rr.atlasCount} A3591</span>}
              </div>
              <div className="px-2 text-[10px] text-slate-500">QFU {rr.rwy.qfu}° · escape {rr.rwy.escapeBearing}°{rr.rwy.turnAt > 0 ? ` turn @ ${rr.rwy.turnAt} nm` : ''} · REQ {rr.rwy.reqGrad}% · acc-ht {rr.rwy.accHt} ft · elev {rr.rwy.elevFt} ft</div>
              <div className="px-2 pb-1">
                <div className="h-1 rounded bg-slate-800 overflow-hidden">
                  <div style={{ width: `${rr.meanScore}%`, backgroundColor: rr.meanScore >= 55 ? '#f59e0b' : rr.meanScore >= 25 ? '#0ea5e9' : '#10b981' }} className="h-full" />
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">{rr.rwy.notes}</div>
              </div>
            </div>
          )
        })}

        {tab === 'CLASSES' && classRows.map((cr, i) => {
          const tier: Tier = cr.atlasCount > 0 ? 'ATLAS3591' : cr.sumScore / Math.max(1, cr.ac) >= 55 ? 'USAIR5050' : cr.sumScore / Math.max(1, cr.ac) >= 25 ? 'WATCH' : 'OK'
          const meanScore = cr.ac ? cr.sumScore / cr.ac : 0
          return (
            <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
              <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[tier]}` }}>
                <span className="font-semibold text-slate-100">{cr.cls}</span>
                <span className="text-slate-500 text-[10px] truncate">{cr.spec.family}</span>
                <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{cr.ac} AC</span>
                {cr.atlasCount > 0 && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/30">{cr.atlasCount} A3591</span>}
                {cr.oeiCount > 0 && <span className="px-1 py-px rounded text-[9px] bg-amber-500/15 text-amber-300 border border-amber-500/30">{cr.oeiCount} OEI</span>}
              </div>
              <div className="px-2 text-[10px] text-slate-500">{cr.spec.nEng}-eng · net-margin {cr.spec.netMargin}% · min 2nd-seg {cr.spec.secondSegMin}% · TOGW {(cr.spec.togwFrac * 100).toFixed(0)}% MTOW · V2 {cr.spec.v2} kt</div>
              <div className="px-2 pb-1">
                <div className="h-1 rounded bg-slate-800 overflow-hidden">
                  <div style={{ width: `${meanScore}%`, backgroundColor: TIER_COLOR[tier] }} className="h-full" />
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">mean score {meanScore.toFixed(0)}{cr.worst ? ` · worst ${cr.worst.f.callsign || cr.worst.f.icao}` : ''} {cr.worst && <button onClick={() => cr.worst && onFly(cr.worst.f.icao)} className="text-sky-400 hover:text-sky-200">fly →</button>}</div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: 14 CFR 25.111 / 25.115 / 25.121(b) / 25.123 / 121.189 / 121.197 / 91.605 · ICAO Annex 6 Pt I 5.2.8 · Doc 8168 PANS-OPS Vol II §3/§7 · Doc 9613 Vol II Pt C · FAA Order 8260.3D TERPS · 8260.46F · AC 120-91A · AC 120-118 · AC 25-7D §3 · EASA CS-25 Subpart B · AMC 25.111/25.115/25.121 · CAT.POL.A.210 · Boeing FCOM PI ch 9 EOSID · AERO Q4-2007 · Airbus FCOM PER-TOF-PRO-EOSID · FAST 49 · Jeppesen 10-7Z · ARINC 424 path-terminators · NTSB AAR-89-04 USAir 5050 LGA · AAR-19-01 Atlas 3591 IAH · AAR-94-04 American 1572 BDL.
      </div>
    </div>
  )
}
