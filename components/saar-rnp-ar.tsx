'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   SAAR · Special Aircraft & Aircrew Authorization Required
          (RNP-AR / RNP-AR APCH) Approach Conformance Monitor
   ------------------------------------------------------------
   Per-airframe approach scorer for arrivals flying published
   Required Navigation Performance Authorization Required
   procedures (RNP-AR APCH per FAA AC 90-101A / ICAO Doc 9905
   Pt B / EASA AMC 20-26). RNP-AR procedures require special
   operational approval beyond baseline RNP APCH (AC 90-105A)
   because of sub-RNP-1 segments (RNP 0.10–0.30), mandatory
   Radius-to-Fix (RF) leg containment, baro-VNAV temperature
   limits, missed-approach RNP < 1, and dual-FMS / dual-GNSS
   sensor architecture requirements.

   18-procedure global RNP-AR catalogue spanning the canonical
   high-terrain / curved-final SAAR portfolio:
     KPSP RNAV(RNP) Y 13R · Palm Springs valley RF curved final
     KEGE RNAV(RNP) Z 25  · Eagle/Vail RNP 0.15 RF Gore Range
     KASE RNAV(RNP) F 15  · Aspen Pitkin Co RNP 0.15 RF
     KSUN RNAV(RNP) Z 31  · Sun Valley RNP 0.30 RF Sawtooth
     KJAC RNAV(RNP) Y 19  · Jackson Hole RNP 0.20 RF Teton
     KMMH RNAV(RNP) Z 27  · Mammoth Lakes RNP 0.30 RF Sierra
     KSAN RNAV(RNP) Z 28R · San Diego RF over downtown
     KDCA RNAV(RNP) Z 19  · Reagan-Nat Mt-Vernon RF P-56 avoid
     KORD RNAV(RNP) Y 28C · O'Hare RF noise abatement
     KJFK RNAV(RNP) Y 13L · Canarsie RF replacement curved
     PANC RNAV(RNP) Z 07R · Anchorage Chugach RNP 0.30 RF
     PAJN RNAV(RNP) Z 08  · Juneau Gastineau RNP 0.30 RF
     CYLW RNAV(RNP) Y 16  · Kelowna BC RNP 0.30 RF Okanagan
     LSGS RNAV(RNP) Y 25  · Sion Switzerland RNP 0.15 Alps RF
     LOWI RNAV(RNP) Z 26  · Innsbruck Inn-valley RF Tyrol
     LFLB RNAV(RNP) Y 18  · Chambéry-Savoie RNP 0.30 RF Alps
     ENBR RNAV(RNP) Z 17  · Bergen Flesland RNP 0.30 RF fjord
     RJAF RNAV(RNP) Z 25  · Matsumoto Japan RNP 0.30 RF Alps

   Each procedure carries: runway threshold lat/lng, final
   bearing FBR, FAF lat/lng + altitude, IF (initial fix) +
   one RF turn-fix with arc-center / radius_NM / start-bearing /
   end-bearing / turn-direction L/R, RNP segment value (final
   0.10–0.30, missed 0.30–1.00), baro-VNAV temp limits
   (T_LO / T_HI Celsius beyond which compensation required
   per AC 90-101A §11.6 + Doc 9905 §3.5), required navigation
   sensor / system suite (GNSS+IRU+VOR/DME-DME / SBAS), and
   issuing authority + chart reference.

   Aircraft classifier — RNP-AR equipped class per AC 90-101A
   App D and Doc 9905 Pt B Table II-3:
     APPROVED-DUAL  twin-FMS / triple-IRU / SBAS or DME/DME
                    backup (B737-800/-900ER/MAX, B777, B787,
                    A220, A320neo, A321neo, A330neo, A350,
                    E190-E2, BCS3) → eligible RNP 0.10–0.30
     APPROVED-SINGLE legacy single-FMS upgrade kit (B737-700,
                    A319/A320 CEO with FMS R3, E190 R1)
                    → eligible RNP 0.30 only
     UNAPPROVED-AC  airframe not certified for RNP-AR
                    (B747-400 ex-cargo, MD-80, F100, BAe-146,
                    most turboprops, regional jets w/o upgrade)
                    → INCURSION if found on RNP-AR final
     UNKNOWN        unable to classify

   Phase classifier (per Doc 9905 §3.3):
     IF       Initial Fix segment, RNP 1.0
     IAF→IF   Intermediate, RNP 1.0
     RF       Radius-to-Fix curved turn, RNP=procedure value
     FAF→MAP  Final approach, RNP=procedure value (0.10–0.30)
     MAP→MA   Missed approach, RNP=missed value (0.30–1.0)
     OUT      Outside procedure scope

   6 risk drivers (max-driver composite, 0..100):
     LAT  Lateral cross-track error vs RNP containment
          (0 at |XTE| ≤ 0.5·RNP, 55 at 1.0·RNP, 100 at 2.0·RNP)
     RF   Radius-to-Fix arc containment penalty inside RF leg
          (0 at on-arc, 75 at ±1·RNP from arc, 100 at ±2·RNP)
          Computed as |radial − R| signed deviation from the
          arc; sustained outside ±RNP = BUST per Doc 9905 §3.3.2
     TMP  Baro-VNAV temperature limit conformance
          (0 within [T_LO, T_HI], 60 within ±5C of limit, 100
          beyond ±15C — RNP-AR forbidden, ILS/LPV required
          per AC 90-101A §11.6 / Doc 9905 §3.5)
     ELG  Aircraft eligibility for the procedure
          (APPROVED-DUAL 0 / APPROVED-SINGLE 40 if RNP<0.30 /
          UNAPPROVED-AC 100 INCURSION / UNKNOWN 60)
     STB  Approach stability proxy (Vref-band overspeed)
          (Vref+10 0 / Vref+20 50 / Vref+30 95)
     ALT  Vertical Path Angle deviation vs 3.00–3.77° VPA
          (0 within ±0.10°, 60 at ±0.30°, 100 at ±0.50°)

   Phase mul: RF 1.40 / FAF→MAP 1.25 / IF 0.85 / IAF→IF 0.70 /
   MAP→MA 1.10 / OUT 0.0

   Hard escalators (RNP-AR-specific):
     RF containment loss inside RF → score ≥ 92  go-around
       per AC 90-101A §10.4 + Doc 9905 §3.3.2 Annex 6 §4.5.7.5
     UNAPPROVED-AC inside RNP < 1.0 segment → score ≥ 95
       (operator violation per 14 CFR §91.205 / EASA SPA.PBN.105)
     TMP beyond ±15C → score ≥ 88 (revert to ILS / LPV)
     LAT > 2.0·RNP on FAF→MAP → score ≥ 90

   6 tiers:
     INCURSION   score ≥ 80 INCURSION rose · revoke clearance
                 alert ATSU per ICAO Doc 9870 §5.4 + §4.4 SDA
     GO-AROUND   score ≥ 65 rose-pink · missed-approach per
                 published MAP per Doc 9905 §3.3.4 + AC 90-101A
                 §10.4 + Boeing FCOM 11.40 + Airbus PRO-NOR-SOP-19
     DEVIATION   score ≥ 45 amber · advise crew of trend, brief
                 missed at FAF per FCOM PI-31 / FCTM Approach
     WATCH       score ≥ 22 sky · monitor TSE / RF radial trace
                 per AC 90-105A §6 stability cross-check
     CONFORM     score < 22 emerald · within containment per
                 ICAO Doc 9905 Vol II Pt B Table II-A-3-1
     OUT         not on any RNP-AR final

   MapLibre overlay:
     · 18 RNP-AR runway threshold pins coloured by procedure
       RNP-band (rose <0.15 / amber 0.15–0.20 / sky 0.20–0.30)
       with runway-id + RNP-XX labels
     · Per-procedure final-approach axis 8-NM polyline FAF→THR
       in procedure-band colour
     · RF leg arc drawn as 24-segment polyline from arc-center
       with radius_NM between start-bearing → end-bearing in
       procedure-band colour, 6% fill on inner-containment disc
     · ±RNP containment ribbon either side of final axis
     · Tier-coloured halo rings 8–22 px by score on each in-scope
       aircraft
     · Rose ◆ pins for INCURSION / GO-AROUND
     · Dashed tier-coloured aircraft-to-FAF link line
     · Tier-coloured callsign + RNP-XX + ±XTE-nm labels

   Side panel:
     · 6-tier counter strip click-to-filter
     · 3-cell MEAN-XTE-nm / WORST-callsign±nm / INCURSION-count
     · 3-cell GO-AROUND-count / UNAPPROVED-on-final-count /
       TEMP-violation-count
     · SVG diagnostic XTE vs VPA-error scatter, every aircraft
       as tier-coloured dot, rose breach quadrant |XTE|>RNP and
       |ΔVPA|>0.3° plus dashed RNP and 3° reference lines
     · 6 sliders: SCOPE-NM 5–50 / RNP-TOL 50–200% / TEMP-OAT
       -50..+50°C / ADV-MUL 50–200% / VPA-TOL 0.05–0.50° / MIN-AGL
       0–3000ft
     · 4-class chip filter ALL / APPROVED-DUAL / APPROVED-SINGLE /
       UNAPPROVED-AC
     · 4-RNP-band chip filter ALL / 0.10 / 0.15 / 0.20 / 0.30
     · HALO PIN LBL FNL RF CONT LINK toggles
     · Search by callsign / type / runway / airport
     · AIRCRAFT / PROCEDURES / AIRPORTS tab switcher

   References:
     FAA AC 90-101A §10.4 §11.6 App D
     FAA AC 90-105A §6 (baseline PBN)
     14 CFR §91.205 §97 §121.353 §135.165
     ICAO Doc 9905 Vol II Pt B Table II-A-3-1 §3.3 §3.5
     ICAO Annex 6 Pt I §4.5.7.5
     ICAO Annex 11 §2.27 §3.7.5
     ICAO Doc 8168 PANS-OPS Vol II Pt III §3.1 §3.3 §3.6
     ICAO Doc 9613 Vol II PBN Manual §3 §C-5
     EASA AMC 20-26 (RNP-AR)
     EASA SPA.PBN.105 / AMC1 SPA.PBN.105
     EASA Decision 2016/021/R RNP-AR
     UK CAA CAP 1385 §3 RNP-AR Authorisation
     CAP 670 SUR §5
     EUROCONTROL Spec for PBN Implementation 2020 §6.4
     Boeing FCOM 11.40 RNP-AR / FCTM Approach §31
     Airbus PRO-NOR-SOP-19 RNAV(RNP) AR / FCOM 31.40
     ARINC 424-21 path-terminators §5.10–5.16 (TF, CF, RF, FM, VM)
     NTSB AAR-13-02 Asiana 214 SFO
     AAIB EW/C2017/04/02 EGGD circling-RNP MDA bust
     ATSB AO-2018-016 Mildura RNP non-conformance

   Registered under Layers → Safety & Traffic, after VRP.
   ft-saar persisted preference.
   ============================================================ */

export interface SaarFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: number | string
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
  flights: SaarFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'INCURSION' | 'GO-AROUND' | 'DEVIATION' | 'WATCH' | 'CONFORM' | 'OUT'
type Driver = 'LAT' | 'RF' | 'TMP' | 'ELG' | 'STB' | 'ALT'
type Klass = 'APPROVED-DUAL' | 'APPROVED-SINGLE' | 'UNAPPROVED-AC' | 'UNKNOWN'
type Phase = 'IF' | 'IAF-IF' | 'RF' | 'FAF-MAP' | 'MAP-MA' | 'OUT'
type RnpBand = '0.10' | '0.15' | '0.20' | '0.30'

const TIER_COLOR: Record<Tier, string> = {
  INCURSION: '#f43f5e',
  'GO-AROUND': '#fb7185',
  DEVIATION: '#f59e0b',
  WATCH: '#0ea5e9',
  CONFORM: '#10b981',
  OUT: '#475569',
}
const TIER_ORDER: Tier[] = ['INCURSION', 'GO-AROUND', 'DEVIATION', 'WATCH', 'CONFORM', 'OUT']
const TIER_RANK: Record<Tier, number> = { INCURSION: 0, 'GO-AROUND': 1, DEVIATION: 2, WATCH: 3, CONFORM: 4, OUT: 5 }

const KLASS_COLOR: Record<Klass, string> = {
  'APPROVED-DUAL': '#10b981',
  'APPROVED-SINGLE': '#0ea5e9',
  'UNAPPROVED-AC': '#f43f5e',
  UNKNOWN: '#94a3b8',
}

const RNP_COLOR: Record<RnpBand, string> = {
  '0.10': '#f43f5e',
  '0.15': '#fb923c',
  '0.20': '#f59e0b',
  '0.30': '#0ea5e9',
}

interface RfLeg {
  centerLat: number
  centerLng: number
  radiusNm: number
  startBrg: number   // bearing from center to start fix (deg true)
  endBrg: number     // bearing from center to end fix (deg true)
  turn: 'L' | 'R'    // turn direction
}

interface SaarProc {
  id: string         // KPSP-13R
  icao: string
  airport: string
  rwy: string
  fbr: number        // final bearing (deg true) at threshold
  thrLat: number
  thrLng: number
  fafLat: number
  fafLng: number
  fafAltFt: number
  vpa: number        // °
  rnpFinal: number   // 0.10 / 0.15 / 0.20 / 0.30
  rnpMissed: number  // 0.30 / 0.50 / 1.00
  rf?: RfLeg
  tLoC: number       // °C lower limit baro-VNAV
  tHiC: number       // °C upper limit baro-VNAV
  authority: string
  chart: string
}

// Procedure catalogue (representative SAAR portfolio)
const PROCS: SaarProc[] = [
  // KPSP RNAV(RNP) Y 13R — Palm Springs valley RF turn
  { id: 'KPSP-13R', icao: 'KPSP', airport: 'Palm Springs', rwy: '13R', fbr: 132, thrLat: 33.8294, thrLng: -116.5060, fafLat: 33.92, fafLng: -116.41, fafAltFt: 4400, vpa: 3.10, rnpFinal: 0.20, rnpMissed: 0.50,
    rf: { centerLat: 33.95, centerLng: -116.45, radiusNm: 3.0, startBrg: 200, endBrg: 240, turn: 'R' },
    tLoC: -30, tHiC: 50, authority: 'FAA', chart: 'KPSP RNAV(RNP) Y 13R Amdt 2A' },
  // KEGE RNAV(RNP) Z 25 — Eagle/Vail Gore Range
  { id: 'KEGE-25', icao: 'KEGE', airport: 'Eagle/Vail', rwy: '25', fbr: 252, thrLat: 39.6426, thrLng: -106.9177, fafLat: 39.59, fafLng: -106.71, fafAltFt: 10500, vpa: 3.77, rnpFinal: 0.15, rnpMissed: 0.30,
    rf: { centerLat: 39.55, centerLng: -106.75, radiusNm: 2.5, startBrg: 30, endBrg: 80, turn: 'L' },
    tLoC: -27, tHiC: 47, authority: 'FAA', chart: 'KEGE RNAV(RNP) Z 25 Amdt 3' },
  // KASE Aspen
  { id: 'KASE-15', icao: 'KASE', airport: 'Aspen Pitkin', rwy: '15', fbr: 152, thrLat: 39.2232, thrLng: -106.8689, fafLat: 39.34, fafLng: -106.94, fafAltFt: 12000, vpa: 3.50, rnpFinal: 0.15, rnpMissed: 0.30,
    rf: { centerLat: 39.30, centerLng: -106.78, radiusNm: 2.2, startBrg: 280, endBrg: 320, turn: 'R' },
    tLoC: -32, tHiC: 45, authority: 'FAA', chart: 'KASE RNAV(RNP)-F 15' },
  // KSUN Sun Valley
  { id: 'KSUN-31', icao: 'KSUN', airport: 'Sun Valley', rwy: '31', fbr: 312, thrLat: 43.5044, thrLng: -114.2960, fafLat: 43.42, fafLng: -114.21, fafAltFt: 8800, vpa: 3.20, rnpFinal: 0.30, rnpMissed: 0.50,
    rf: { centerLat: 43.39, centerLng: -114.28, radiusNm: 2.8, startBrg: 60, endBrg: 110, turn: 'L' },
    tLoC: -30, tHiC: 45, authority: 'FAA', chart: 'KSUN RNAV(RNP) Z 31 Amdt 2' },
  // KJAC Jackson Hole
  { id: 'KJAC-19', icao: 'KJAC', airport: 'Jackson Hole', rwy: '19', fbr: 192, thrLat: 43.6073, thrLng: -110.7378, fafLat: 43.70, fafLng: -110.69, fafAltFt: 9500, vpa: 3.50, rnpFinal: 0.20, rnpMissed: 0.30,
    rf: { centerLat: 43.74, centerLng: -110.78, radiusNm: 3.2, startBrg: 90, endBrg: 140, turn: 'R' },
    tLoC: -34, tHiC: 42, authority: 'FAA', chart: 'KJAC RNAV(RNP) Y 19' },
  // KMMH Mammoth Lakes
  { id: 'KMMH-27', icao: 'KMMH', airport: 'Mammoth Lakes', rwy: '27', fbr: 272, thrLat: 37.6240, thrLng: -118.8378, fafLat: 37.58, fafLng: -118.63, fafAltFt: 11000, vpa: 3.20, rnpFinal: 0.30, rnpMissed: 0.50,
    rf: { centerLat: 37.55, centerLng: -118.70, radiusNm: 3.0, startBrg: 30, endBrg: 80, turn: 'L' },
    tLoC: -30, tHiC: 42, authority: 'FAA', chart: 'KMMH RNAV(RNP) Z 27' },
  // KSAN San Diego over downtown RF
  { id: 'KSAN-28R', icao: 'KSAN', airport: 'San Diego', rwy: '28R', fbr: 281, thrLat: 32.7338, thrLng: -117.1933, fafLat: 32.74, fafLng: -117.02, fafAltFt: 2600, vpa: 3.50, rnpFinal: 0.30, rnpMissed: 0.50,
    rf: { centerLat: 32.71, centerLng: -117.08, radiusNm: 2.0, startBrg: 60, endBrg: 100, turn: 'L' },
    tLoC: -10, tHiC: 50, authority: 'FAA', chart: 'KSAN RNAV(RNP) Z 28R' },
  // KDCA Reagan P-56 RF
  { id: 'KDCA-19', icao: 'KDCA', airport: 'Reagan National', rwy: '19', fbr: 188, thrLat: 38.8521, thrLng: -77.0377, fafLat: 38.92, fafLng: -77.03, fafAltFt: 1800, vpa: 3.10, rnpFinal: 0.20, rnpMissed: 0.30,
    rf: { centerLat: 38.90, centerLng: -77.10, radiusNm: 2.5, startBrg: 80, endBrg: 130, turn: 'R' },
    tLoC: -25, tHiC: 50, authority: 'FAA', chart: 'KDCA RNAV(RNP) Z 19' },
  // KORD noise abatement RF
  { id: 'KORD-28C', icao: 'KORD', airport: "Chicago O'Hare", rwy: '28C', fbr: 282, thrLat: 41.9786, thrLng: -87.9048, fafLat: 41.95, fafLng: -87.71, fafAltFt: 3000, vpa: 3.00, rnpFinal: 0.30, rnpMissed: 1.00,
    rf: { centerLat: 41.93, centerLng: -87.80, radiusNm: 4.0, startBrg: 30, endBrg: 60, turn: 'L' },
    tLoC: -32, tHiC: 45, authority: 'FAA', chart: 'KORD RNAV(RNP) Y 28C' },
  // KJFK Canarsie replacement
  { id: 'KJFK-13L', icao: 'KJFK', airport: 'New York JFK', rwy: '13L', fbr: 132, thrLat: 40.6512, thrLng: -73.8011, fafLat: 40.72, fafLng: -73.81, fafAltFt: 2200, vpa: 3.10, rnpFinal: 0.20, rnpMissed: 0.30,
    rf: { centerLat: 40.70, centerLng: -73.85, radiusNm: 3.0, startBrg: 60, endBrg: 130, turn: 'R' },
    tLoC: -28, tHiC: 45, authority: 'FAA', chart: 'KJFK RNAV(RNP) Y 13L' },
  // PANC Anchorage Chugach
  { id: 'PANC-07R', icao: 'PANC', airport: 'Anchorage', rwy: '07R', fbr: 72, thrLat: 61.1719, thrLng: -149.9961, fafLat: 61.15, fafLng: -149.78, fafAltFt: 3500, vpa: 3.20, rnpFinal: 0.30, rnpMissed: 0.50,
    rf: { centerLat: 61.20, centerLng: -149.84, radiusNm: 3.5, startBrg: 200, endBrg: 250, turn: 'L' },
    tLoC: -45, tHiC: 35, authority: 'FAA', chart: 'PANC RNAV(RNP) Z 07R' },
  // PAJN Juneau Gastineau
  { id: 'PAJN-08', icao: 'PAJN', airport: 'Juneau', rwy: '08', fbr: 82, thrLat: 58.3550, thrLng: -134.5763, fafLat: 58.32, fafLng: -134.30, fafAltFt: 3800, vpa: 3.40, rnpFinal: 0.30, rnpMissed: 0.50,
    rf: { centerLat: 58.30, centerLng: -134.40, radiusNm: 3.0, startBrg: 250, endBrg: 310, turn: 'R' },
    tLoC: -40, tHiC: 32, authority: 'FAA', chart: 'PAJN RNAV(RNP) Z 08' },
  // CYLW Kelowna BC
  { id: 'CYLW-16', icao: 'CYLW', airport: 'Kelowna', rwy: '16', fbr: 162, thrLat: 49.9561, thrLng: -119.3777, fafLat: 50.06, fafLng: -119.40, fafAltFt: 5500, vpa: 3.00, rnpFinal: 0.30, rnpMissed: 0.50,
    rf: { centerLat: 50.04, centerLng: -119.46, radiusNm: 2.8, startBrg: 80, endBrg: 130, turn: 'R' },
    tLoC: -35, tHiC: 40, authority: 'NavCanada', chart: 'CYLW RNAV(RNP) Y 16' },
  // LSGS Sion Alps
  { id: 'LSGS-25', icao: 'LSGS', airport: 'Sion', rwy: '25', fbr: 252, thrLat: 46.2196, thrLng: 7.3268, fafLat: 46.24, fafLng: 7.55, fafAltFt: 8500, vpa: 3.50, rnpFinal: 0.15, rnpMissed: 0.30,
    rf: { centerLat: 46.20, centerLng: 7.50, radiusNm: 2.5, startBrg: 20, endBrg: 70, turn: 'L' },
    tLoC: -30, tHiC: 38, authority: 'Skyguide', chart: 'LSGS RNAV(RNP) Y 25' },
  // LOWI Innsbruck Inn-valley
  { id: 'LOWI-26', icao: 'LOWI', airport: 'Innsbruck', rwy: '26', fbr: 257, thrLat: 47.2602, thrLng: 11.3441, fafLat: 47.26, fafLng: 11.55, fafAltFt: 7500, vpa: 3.50, rnpFinal: 0.15, rnpMissed: 0.30,
    rf: { centerLat: 47.24, centerLng: 11.50, radiusNm: 2.0, startBrg: 30, endBrg: 80, turn: 'L' },
    tLoC: -28, tHiC: 38, authority: 'Austro Control', chart: 'LOWI RNAV(RNP) Z 26' },
  // LFLB Chambéry Alps
  { id: 'LFLB-18', icao: 'LFLB', airport: 'Chambéry-Savoie', rwy: '18', fbr: 182, thrLat: 45.6381, thrLng: 5.8804, fafLat: 45.73, fafLng: 5.92, fafAltFt: 6500, vpa: 3.20, rnpFinal: 0.30, rnpMissed: 0.50,
    rf: { centerLat: 45.76, centerLng: 5.87, radiusNm: 2.5, startBrg: 100, endBrg: 150, turn: 'R' },
    tLoC: -25, tHiC: 40, authority: 'DSNA', chart: 'LFLB RNAV(RNP) Y 18' },
  // ENBR Bergen Flesland fjord
  { id: 'ENBR-17', icao: 'ENBR', airport: 'Bergen Flesland', rwy: '17', fbr: 172, thrLat: 60.2934, thrLng: 5.2181, fafLat: 60.39, fafLng: 5.21, fafAltFt: 3200, vpa: 3.00, rnpFinal: 0.30, rnpMissed: 0.50,
    rf: { centerLat: 60.37, centerLng: 5.15, radiusNm: 2.8, startBrg: 80, endBrg: 130, turn: 'L' },
    tLoC: -25, tHiC: 32, authority: 'Avinor', chart: 'ENBR RNAV(RNP) Z 17' },
  // RJAF Matsumoto Japan Alps
  { id: 'RJAF-25', icao: 'RJAF', airport: 'Matsumoto', rwy: '25', fbr: 252, thrLat: 36.1668, thrLng: 137.9226, fafLat: 36.14, fafLng: 138.10, fafAltFt: 8500, vpa: 3.50, rnpFinal: 0.30, rnpMissed: 0.50,
    rf: { centerLat: 36.10, centerLng: 138.04, radiusNm: 2.5, startBrg: 30, endBrg: 80, turn: 'L' },
    tLoC: -28, tHiC: 42, authority: 'JCAB', chart: 'RJAF RNAV(RNP) Z 25' },
]

const SRC_HALO = 'saar-halo', LYR_HALO = 'saar-halo-l'
const SRC_PIN  = 'saar-pin',  LYR_PIN  = 'saar-pin-l'
const SRC_LBL  = 'saar-lbl',  LYR_LBL  = 'saar-lbl-l'
const SRC_FNL  = 'saar-fnl',  LYR_FNL  = 'saar-fnl-l'
const SRC_RF   = 'saar-rf',   LYR_RF   = 'saar-rf-l'
const SRC_CONT = 'saar-cont', LYR_CONT = 'saar-cont-l'
const SRC_LNK  = 'saar-lnk',  LYR_LNK  = 'saar-lnk-l'
const SRC_THR  = 'saar-thr',  LYR_THR  = 'saar-thr-l'
const SRC_TLBL = 'saar-tlbl', LYR_TLBL = 'saar-tlbl-l'

const D2R = Math.PI / 180
const R_NM = 3440.065

function distNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dp = (lat2 - lat1) * D2R, dl = (lng2 - lng1) * D2R
  const a = Math.sin(dp/2)**2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl/2)**2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = lat1 * D2R, φ2 = lat2 * D2R, dλ = (lng2 - lng1) * D2R
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return ((Math.atan2(y, x) / D2R) + 360) % 360
}
function destPoint(lat: number, lng: number, brgDeg: number, dNm: number): [number, number] {
  const d = dNm / R_NM, br = brgDeg * D2R
  const φ1 = lat * D2R, λ1 = lng * D2R
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(br))
  const λ2 = λ1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2))
  return [λ2 / D2R, φ2 / D2R]
}
function headingDelta(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}
function crossTrackNm(latP: number, lngP: number, latA: number, lngA: number, latB: number, lngB: number): number {
  const d13 = distNm(latA, lngA, latP, lngP) / R_NM
  const brg13 = bearingDeg(latA, lngA, latP, lngP) * D2R
  const brg12 = bearingDeg(latA, lngA, latB, lngB) * D2R
  return Math.asin(Math.sin(d13) * Math.sin(brg13 - brg12)) * R_NM
}

function classify(type: string | undefined): Klass {
  const t = (type || '').toUpperCase()
  if (!t) return 'UNKNOWN'
  // APPROVED-DUAL: modern dual-FMS/dual-GNSS
  if (/^(B38M|B39M|B3XM|B772|B773|B77L|B77W|B788|B789|B78X|A20N|A21N|A319N|A21N|A332N|A333N|A338|A339|A359|A35K|BCS3|BCS1|E290|E295|E190|E195)/.test(t)) return 'APPROVED-DUAL'
  // APPROVED-SINGLE: legacy single-FMS upgrade kit
  if (/^(B737|B738|B739|B752|B753|A319|A320|A321|E170|E175)/.test(t)) return 'APPROVED-SINGLE'
  // UNAPPROVED-AC: no RNP-AR cert path
  if (/^(B741|B742|B743|B744|B748|MD8|MD9|MD11|F100|F70|BA46|RJ85|RJ1H|CRJ2|CRJ7|CRJ9|AT[47]|DH8|SF34|J32|J41|B190|C208|PC12)/.test(t)) return 'UNAPPROVED-AC'
  return 'UNKNOWN'
}

function rnpBand(v: number): RnpBand {
  if (v <= 0.10) return '0.10'
  if (v <= 0.15) return '0.15'
  if (v <= 0.20) return '0.20'
  return '0.30'
}

interface Row {
  f: SaarFlight
  klass: Klass
  proc?: SaarProc
  phase: Phase
  rnp: number
  xte: number             // signed cross-track NM on FAF→THR axis
  rfDev: number           // signed radial error vs RF arc (NM); 0 if not RF
  vpaActual: number       // °
  vpaErr: number          // °
  oat: number             // selected OAT °C
  tmpExceed: number       // °C beyond closest temp limit (0 inside)
  sLat: number; sRf: number; sTmp: number; sElg: number; sStb: number; sAlt: number
  score: number
  driver: Driver
  tier: Tier
  distToFafNm: number
  alongFracOnFinal: number
}

interface Opts {
  scopeNm: number
  rnpTolPct: number       // 50..200
  oatC: number            // -50..50
  advMul: number          // 50..200
  vpaTolDeg: number       // 0.05..0.50
  minAglFt: number
}

function pickProc(f: SaarFlight, opts: Opts): { proc?: SaarProc; phase: Phase; xte: number; rfDev: number; distToFaf: number; alongFrac: number } {
  let best: { proc: SaarProc; phase: Phase; xte: number; rfDev: number; distToFaf: number; alongFrac: number; sortKey: number } | null = null
  for (const p of PROCS) {
    const dThr = distNm(f.lat, f.lng, p.thrLat, p.thrLng)
    if (dThr > opts.scopeNm) continue
    const dFaf = distNm(f.lat, f.lng, p.fafLat, p.fafLng)
    // Reciprocal-of-final-bearing check (aircraft track must roughly align with FBR ±45°)
    const trkAlign = headingDelta(f.track || 0, p.fbr)
    if (trkAlign > 50) continue
    // Final axis is FAF → THR
    const xte = crossTrackNm(f.lat, f.lng, p.fafLat, p.fafLng, p.thrLat, p.thrLng)
    const fafToThrNm = distNm(p.fafLat, p.fafLng, p.thrLat, p.thrLng)
    // Along-track frac (0 at FAF, 1 at THR; negative before FAF)
    const dirFaf = bearingDeg(p.fafLat, p.fafLng, p.thrLat, p.thrLng)
    const brgFafAc = bearingDeg(p.fafLat, p.fafLng, f.lat, f.lng)
    const along = distNm(p.fafLat, p.fafLng, f.lat, f.lng) * Math.cos((brgFafAc - dirFaf) * D2R)
    const alongFrac = fafToThrNm > 0 ? along / fafToThrNm : 0
    // Phase classification
    let phase: Phase = 'OUT'
    let rfDev = 0
    // RF leg check: inside angular sector of RF arc + within 2 NM radial of arc-circle
    if (p.rf) {
      const dCenter = distNm(p.rf.centerLat, p.rf.centerLng, f.lat, f.lng)
      const brgCenterAc = bearingDeg(p.rf.centerLat, p.rf.centerLng, f.lat, f.lng)
      // Angular sweep test (within ±15° of start..end arc)
      const inArc = (() => {
        let a0 = p.rf.startBrg, a1 = p.rf.endBrg
        if (p.rf.turn === 'L') { const t = a0; a0 = a1; a1 = t }
        let span = ((a1 - a0) + 360) % 360
        let cur = ((brgCenterAc - a0) + 360) % 360
        return cur >= -15 && cur <= span + 15
      })()
      if (inArc && Math.abs(dCenter - p.rf.radiusNm) < 2.0) {
        phase = 'RF'
        rfDev = dCenter - p.rf.radiusNm
      }
    }
    if (phase !== 'RF') {
      if (alongFrac >= 0 && alongFrac <= 1.05 && dFaf < fafToThrNm + 2) phase = 'FAF-MAP'
      else if (alongFrac > 1.05) phase = 'MAP-MA'
      else if (alongFrac < 0 && dFaf < 12) phase = 'IF'
      else phase = 'OUT'
    }
    if (phase === 'OUT') continue
    const sortKey = Math.abs(xte) + dThr * 0.02 + trkAlign * 0.05
    if (!best || sortKey < best.sortKey) {
      best = { proc: p, phase, xte, rfDev, distToFaf: dFaf, alongFrac, sortKey }
    }
  }
  if (!best) return { phase: 'OUT', xte: 0, rfDev: 0, distToFaf: 0, alongFrac: 0 }
  return { proc: best.proc, phase: best.phase, xte: best.xte, rfDev: best.rfDev, distToFaf: best.distToFaf, alongFrac: best.alongFrac }
}

function rnpForPhase(proc: SaarProc, phase: Phase): number {
  if (phase === 'IF' || phase === 'IAF-IF') return 1.00
  if (phase === 'MAP-MA') return proc.rnpMissed
  return proc.rnpFinal
}

function compute(f: SaarFlight, opts: Opts): Row {
  const klass = classify(f.type)
  const sel = pickProc(f, opts)
  const proc = sel.proc
  const phase = sel.phase
  if (!proc) {
    return {
      f, klass, phase: 'OUT', rnp: 0, xte: 0, rfDev: 0, vpaActual: 0, vpaErr: 0,
      oat: opts.oatC, tmpExceed: 0,
      sLat: 0, sRf: 0, sTmp: 0, sElg: 0, sStb: 0, sAlt: 0,
      score: 0, driver: 'LAT', tier: 'OUT', distToFafNm: 0, alongFracOnFinal: 0,
    }
  }
  const rnpRaw = rnpForPhase(proc, phase)
  const rnp = rnpRaw * (opts.rnpTolPct / 100)

  // Drivers
  const xteAbs = Math.abs(sel.xte)
  const sLat = phase === 'RF' ? 0 : (() => {
    const r = xteAbs / Math.max(0.01, rnp)
    if (r <= 0.5) return 0
    if (r <= 1.0) return 25 + (r - 0.5) * 60
    if (r <= 2.0) return 55 + (r - 1.0) * 45
    return 100
  })()

  const sRf = phase === 'RF' ? (() => {
    const r = Math.abs(sel.rfDev) / Math.max(0.01, rnp)
    if (r <= 0.3) return 0
    if (r <= 1.0) return 30 + (r - 0.3) * 64   // 30 → 75
    if (r <= 2.0) return 75 + (r - 1.0) * 25
    return 100
  })() : 0

  // OAT vs procedure baro-VNAV temp limits (linear penalty)
  const tmpExceed = opts.oatC < proc.tLoC ? proc.tLoC - opts.oatC : opts.oatC > proc.tHiC ? opts.oatC - proc.tHiC : 0
  const sTmp = tmpExceed <= 0 ? 0 : tmpExceed <= 5 ? tmpExceed * 12 : tmpExceed <= 15 ? 60 + (tmpExceed - 5) * 4 : 100

  // Aircraft eligibility for the procedure
  let sElg = 0
  if (klass === 'UNAPPROVED-AC' && (phase === 'FAF-MAP' || phase === 'RF')) sElg = 100
  else if (klass === 'UNAPPROVED-AC') sElg = 70
  else if (klass === 'APPROVED-SINGLE' && rnpRaw < 0.30) sElg = 55
  else if (klass === 'UNKNOWN') sElg = 60

  // Approach stability proxy: high GS or descent rate inconsistent with VPA → STB
  const gs = Math.max(60, f.velocityKts || 140)
  // Expected descent rate at proc VPA: VS_fpm = GS_kt × tan(VPA) × 101.3
  const vsExpected = gs * Math.tan(proc.vpa * D2R) * 101.3
  const vsActual = Math.abs(f.vertRate || 0)
  const vsExcess = Math.max(0, vsActual - vsExpected)
  const sStb = vsExcess <= 200 ? 0 : vsExcess <= 500 ? 30 : vsExcess <= 800 ? 60 : 95

  // VPA error: derive actual VPA from current alt-above-thr / distance-to-thr
  const dThrNm = distNm(f.lat, f.lng, proc.thrLat, proc.thrLng)
  const altAboveThr = Math.max(0, f.altitudeFt - 0) // assume threshold ≈ 0 MSL for proxy
  const vpaActual = dThrNm > 0.1 ? Math.atan2(altAboveThr / 6076, dThrNm) / D2R : proc.vpa
  const vpaErr = vpaActual - proc.vpa
  const sAlt = (() => {
    const e = Math.abs(vpaErr)
    if (e <= opts.vpaTolDeg) return 0
    if (e <= opts.vpaTolDeg * 3) return 30 + (e / opts.vpaTolDeg - 1) * 30
    if (e <= opts.vpaTolDeg * 6) return 60 + (e / opts.vpaTolDeg - 3) * 13
    return 100
  })()

  const drivers: Array<[Driver, number]> = [
    ['LAT', sLat], ['RF', sRf], ['TMP', sTmp], ['ELG', sElg], ['STB', sStb], ['ALT', sAlt],
  ]
  drivers.sort((a, b) => b[1] - a[1])
  let raw = drivers[0][1] * 0.78
  // secondary-mean of remaining drivers contribution
  const meanRest = drivers.slice(1).reduce((s, d) => s + d[1], 0) / 5
  raw += meanRest * 0.22

  // Phase multiplier
  const phaseMul: Record<Phase, number> = { RF: 1.40, 'FAF-MAP': 1.25, 'MAP-MA': 1.10, IF: 0.85, 'IAF-IF': 0.70, OUT: 0 }
  raw = raw * phaseMul[phase] * (opts.advMul / 100)

  // Hard escalators
  if (phase === 'RF' && sRf >= 75) raw = Math.max(raw, 92)
  if (klass === 'UNAPPROVED-AC' && (phase === 'FAF-MAP' || phase === 'RF')) raw = Math.max(raw, 95)
  if (sTmp >= 100) raw = Math.max(raw, 88)
  if (phase === 'FAF-MAP' && sLat >= 100) raw = Math.max(raw, 90)

  const score = Math.round(Math.min(100, raw))
  let tier: Tier = 'CONFORM'
  if (phase === 'OUT') tier = 'OUT'
  else if (score >= 80) tier = 'INCURSION'
  else if (score >= 65) tier = 'GO-AROUND'
  else if (score >= 45) tier = 'DEVIATION'
  else if (score >= 22) tier = 'WATCH'
  else tier = 'CONFORM'

  return {
    f, klass, proc, phase, rnp, xte: sel.xte, rfDev: sel.rfDev, vpaActual, vpaErr,
    oat: opts.oatC, tmpExceed,
    sLat: Math.round(sLat), sRf: Math.round(sRf), sTmp: Math.round(sTmp),
    sElg: Math.round(sElg), sStb: Math.round(sStb), sAlt: Math.round(sAlt),
    score, driver: drivers[0][0], tier,
    distToFafNm: sel.distToFaf, alongFracOnFinal: sel.alongFrac,
  }
}

function ensureLayer(map: maplibregl.Map, id: string, src: string, spec: maplibregl.LayerSpecification) {
  if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
  if (!map.getLayer(id)) map.addLayer(spec as any)
}
function setData(map: maplibregl.Map, src: string, fc: any) {
  const s = map.getSource(src) as any
  if (s && s.setData) s.setData(fc)
}
function removeLayers(map: maplibregl.Map, ids: string[], srcs: string[]) {
  ids.forEach(id => { if (map.getLayer(id)) map.removeLayer(id) })
  srcs.forEach(s => { if (map.getSource(s)) map.removeSource(s) })
}

export default function SaarRnpAr({ map, flights, onClose, onFly }: Props) {
  const [scopeNm, setScopeNm] = useState(25)
  const [rnpTolPct, setRnpTolPct] = useState(100)
  const [oatC, setOatC] = useState(15)
  const [advMul, setAdvMul] = useState(100)
  const [vpaTolDeg, setVpaTolDeg] = useState(0.10)
  const [minAglFt, setMinAglFt] = useState(0)

  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showFnl, setShowFnl] = useState(true)
  const [showRf, setShowRf] = useState(true)
  const [showCont, setShowCont] = useState(true)
  const [showLnk, setShowLnk] = useState(true)
  const [showDiag, setShowDiag] = useState(true)

  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [bandFilter, setBandFilter] = useState<RnpBand | 'ALL'>('ALL')
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'AC' | 'PROC' | 'AIRP'>('AC')

  const opts: Opts = { scopeNm, rnpTolPct, oatC, advMul, vpaTolDeg, minAglFt }

  const rows = useMemo(() => {
    return flights
      .filter(f => !f.ground && f.altitudeFt > 0 && f.altitudeFt < 15000)
      .map(f => compute(f, opts))
      .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [flights, scopeNm, rnpTolPct, oatC, advMul, vpaTolDeg, minAglFt])

  const filteredRows = useMemo(() => {
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (bandFilter !== 'ALL' && r.proc && rnpBand(r.proc.rnpFinal) !== bandFilter) return false
      if (query) {
        const q = query.toLowerCase()
        if (!(r.f.callsign?.toLowerCase().includes(q) || r.f.icao.toLowerCase().includes(q)
          || (r.f.type || '').toLowerCase().includes(q) || (r.proc?.icao || '').toLowerCase().includes(q)
          || (r.proc?.rwy || '').toLowerCase().includes(q) || (r.proc?.airport || '').toLowerCase().includes(q))) return false
      }
      return true
    })
  }, [rows, tierFilter, klassFilter, bandFilter, query])

  const tierCount = useMemo(() => {
    const c: Record<Tier, number> = { INCURSION: 0, 'GO-AROUND': 0, DEVIATION: 0, WATCH: 0, CONFORM: 0, OUT: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const worst = rows.find(r => r.tier !== 'OUT')
  const inScope = rows.filter(r => r.tier !== 'OUT')
  const meanXte = inScope.length ? inScope.reduce((s, r) => s + Math.abs(r.xte), 0) / inScope.length : 0
  const unapprovedOnFinal = inScope.filter(r => r.klass === 'UNAPPROVED-AC' && (r.phase === 'FAF-MAP' || r.phase === 'RF')).length
  const tempViol = inScope.filter(r => r.tmpExceed > 0).length

  const procAgg = useMemo(() => {
    const m = new Map<string, { proc: SaarProc; n: number; inc: number; ga: number; meanXte: number; sumXte: number }>()
    for (const r of inScope) {
      if (!r.proc) continue
      const k = r.proc.id
      const cur = m.get(k) || { proc: r.proc, n: 0, inc: 0, ga: 0, meanXte: 0, sumXte: 0 }
      cur.n++
      if (r.tier === 'INCURSION') cur.inc++
      if (r.tier === 'GO-AROUND') cur.ga++
      cur.sumXte += Math.abs(r.xte)
      m.set(k, cur)
    }
    for (const v of m.values()) v.meanXte = v.sumXte / Math.max(1, v.n)
    return Array.from(m.values()).sort((a, b) => b.inc - a.inc || b.n - a.n)
  }, [inScope])

  const airportAgg = useMemo(() => {
    const m = new Map<string, { icao: string; airport: string; n: number; inc: number; ga: number; procs: number }>()
    for (const p of PROCS) {
      m.set(p.icao, { icao: p.icao, airport: p.airport, n: 0, inc: 0, ga: 0, procs: (m.get(p.icao)?.procs || 0) + 1 })
    }
    for (const r of inScope) {
      if (!r.proc) continue
      const cur = m.get(r.proc.icao)!
      cur.n++
      if (r.tier === 'INCURSION') cur.inc++
      if (r.tier === 'GO-AROUND') cur.ga++
    }
    return Array.from(m.values()).sort((a, b) => b.inc - a.inc || b.n - a.n)
  }, [inScope])

  // === Map overlay ===
  useEffect(() => {
    if (!map) return
    const ids = [LYR_CONT, LYR_FNL, LYR_RF, LYR_LNK, LYR_HALO, LYR_THR, LYR_TLBL, LYR_PIN, LYR_LBL]
    const srcs = [SRC_CONT, SRC_FNL, SRC_RF, SRC_LNK, SRC_HALO, SRC_THR, SRC_TLBL, SRC_PIN, SRC_LBL]

    ensureLayer(map, LYR_CONT, SRC_CONT, { id: LYR_CONT, type: 'fill', source: SRC_CONT,
      paint: { 'fill-color': ['get', 'c'], 'fill-opacity': 0.07 } })
    ensureLayer(map, LYR_FNL, SRC_FNL, { id: LYR_FNL, type: 'line', source: SRC_FNL,
      paint: { 'line-color': ['get', 'c'], 'line-width': 1.6, 'line-opacity': 0.75 } })
    ensureLayer(map, LYR_RF, SRC_RF, { id: LYR_RF, type: 'line', source: SRC_RF,
      paint: { 'line-color': ['get', 'c'], 'line-width': 1.8, 'line-dasharray': [2, 2], 'line-opacity': 0.85 } })
    ensureLayer(map, LYR_LNK, SRC_LNK, { id: LYR_LNK, type: 'line', source: SRC_LNK,
      paint: { 'line-color': ['get', 'c'], 'line-width': 1.2, 'line-dasharray': [3, 3], 'line-opacity': 0.65 } })
    ensureLayer(map, LYR_HALO, SRC_HALO, { id: LYR_HALO, type: 'circle', source: SRC_HALO,
      paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'c'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'c'], 'circle-stroke-opacity': 0.6, 'circle-stroke-width': 1.2 } })
    ensureLayer(map, LYR_THR, SRC_THR, { id: LYR_THR, type: 'circle', source: SRC_THR,
      paint: { 'circle-radius': 5, 'circle-color': ['get', 'c'], 'circle-stroke-color': '#e2e8f0', 'circle-stroke-width': 1, 'circle-opacity': 0.9 } })
    ensureLayer(map, LYR_TLBL, SRC_TLBL, { id: LYR_TLBL, type: 'symbol', source: SRC_TLBL,
      layout: { 'text-field': ['get', 't'], 'text-size': 9, 'text-offset': [0, -1.3], 'text-allow-overlap': true, 'text-anchor': 'bottom' },
      paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.1 } })
    ensureLayer(map, LYR_PIN, SRC_PIN, { id: LYR_PIN, type: 'symbol', source: SRC_PIN,
      layout: { 'text-field': '◆', 'text-size': 14, 'text-allow-overlap': true },
      paint: { 'text-color': '#f43f5e' } })
    ensureLayer(map, LYR_LBL, SRC_LBL, { id: LYR_LBL, type: 'symbol', source: SRC_LBL,
      layout: { 'text-field': ['get', 't'], 'text-size': 10, 'text-offset': [0, 1.3], 'text-allow-overlap': true, 'text-anchor': 'top' },
      paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })

    const contFt: any[] = []
    const fnlFt: any[] = []
    const rfFt: any[] = []
    const lnkFt: any[] = []
    const haloFt: any[] = []
    const thrFt: any[] = []
    const tlblFt: any[] = []
    const pinFt: any[] = []
    const lblFt: any[] = []

    // Per-procedure overlays
    for (const p of PROCS) {
      if (bandFilter !== 'ALL' && rnpBand(p.rnpFinal) !== bandFilter) continue
      const col = RNP_COLOR[rnpBand(p.rnpFinal)]
      // Threshold pin + label
      thrFt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.thrLng, p.thrLat] }, properties: { c: col } })
      tlblFt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.thrLng, p.thrLat] }, properties: { t: `${p.icao}·${p.rwy}·RNP${p.rnpFinal.toFixed(2)}`, c: col } })
      // Final axis FAF → THR extended 1 NM past
      if (showFnl) {
        const [eLng, eLat] = destPoint(p.thrLat, p.thrLng, (p.fbr + 180) % 360, -1)
        fnlFt.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[p.fafLng, p.fafLat], [p.thrLng, p.thrLat], [eLng, eLat]] }, properties: { c: col } })
        // Containment ribbon ±RNP
        if (showCont) {
          const rnpHalf = p.rnpFinal
          // Build polygon: FAF-left, THR-left, THR-right, FAF-right
          const perpLeft = (p.fbr - 90 + 360) % 360
          const perpRight = (p.fbr + 90) % 360
          const [aL_lng, aL_lat] = destPoint(p.fafLat, p.fafLng, perpLeft, rnpHalf)
          const [aR_lng, aR_lat] = destPoint(p.fafLat, p.fafLng, perpRight, rnpHalf)
          const [bL_lng, bL_lat] = destPoint(p.thrLat, p.thrLng, perpLeft, rnpHalf)
          const [bR_lng, bR_lat] = destPoint(p.thrLat, p.thrLng, perpRight, rnpHalf)
          contFt.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[aL_lng, aL_lat], [bL_lng, bL_lat], [bR_lng, bR_lat], [aR_lng, aR_lat], [aL_lng, aL_lat]]] }, properties: { c: col } })
        }
      }
      // RF arc
      if (showRf && p.rf) {
        const coords: number[][] = []
        let a0 = p.rf.startBrg, a1 = p.rf.endBrg
        let span = ((a1 - a0) + 360) % 360
        if (p.rf.turn === 'L') {
          a0 = p.rf.endBrg; span = ((p.rf.startBrg - p.rf.endBrg) + 360) % 360
        }
        const steps = 24
        for (let i = 0; i <= steps; i++) {
          const br = (a0 + (i / steps) * span + 360) % 360
          const [lng2, lat2] = destPoint(p.rf.centerLat, p.rf.centerLng, br, p.rf.radiusNm)
          coords.push([lng2, lat2])
        }
        rfFt.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { c: col } })
      }
    }

    // Per-aircraft overlays
    for (const r of filteredRows) {
      if (r.tier === 'OUT' || !r.proc) continue
      const col = TIER_COLOR[r.tier]
      const radius = 8 + (r.score / 100) * 14
      if (showHalo) haloFt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { c: col, r: radius } })
      if (showPin && (r.tier === 'INCURSION' || r.tier === 'GO-AROUND')) {
        pinFt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLbl) {
        const sign = r.xte >= 0 ? '+' : ''
        const t = `${r.f.callsign || r.f.icao} · RNP${r.proc.rnpFinal.toFixed(2)} · ${sign}${r.xte.toFixed(2)}nm`
        lblFt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { t, c: col } })
      }
      if (showLnk) {
        lnkFt.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.proc.fafLng, r.proc.fafLat]] }, properties: { c: col } })
      }
    }

    setData(map, SRC_CONT, { type: 'FeatureCollection', features: contFt })
    setData(map, SRC_FNL, { type: 'FeatureCollection', features: fnlFt })
    setData(map, SRC_RF, { type: 'FeatureCollection', features: rfFt })
    setData(map, SRC_LNK, { type: 'FeatureCollection', features: lnkFt })
    setData(map, SRC_HALO, { type: 'FeatureCollection', features: haloFt })
    setData(map, SRC_THR, { type: 'FeatureCollection', features: thrFt })
    setData(map, SRC_TLBL, { type: 'FeatureCollection', features: tlblFt })
    setData(map, SRC_PIN, { type: 'FeatureCollection', features: pinFt })
    setData(map, SRC_LBL, { type: 'FeatureCollection', features: lblFt })

    return () => { removeLayers(map, ids, srcs) }
  }, [map, filteredRows, bandFilter, showHalo, showPin, showLbl, showFnl, showRf, showCont, showLnk])

  // === Diagnostic scatter ===
  const W = 280, H = 180
  const xMax = 2.5, yMax = 0.8
  const sx = (v: number) => 30 + (Math.max(-xMax, Math.min(xMax, v)) + xMax) / (2 * xMax) * (W - 40)
  const sy = (v: number) => (H - 24) - (Math.max(-yMax, Math.min(yMax, v)) + yMax) / (2 * yMax) * (H - 48)

  const advice = (r: Row): string => {
    if (!r.proc) return 'Not on RNP-AR final'
    if (r.tier === 'INCURSION') {
      if (r.driver === 'ELG') return `${r.klass} not authorised for RNP-AR (RNP ${r.proc.rnpFinal.toFixed(2)}) — revoke clearance per 14 CFR §91.205 / EASA SPA.PBN.105 / AC 90-101A App D`
      if (r.driver === 'RF') return `RF arc containment loss (radial dev ${r.rfDev.toFixed(2)} nm) — GO-AROUND per AC 90-101A §10.4 / Doc 9905 §3.3.2 / Annex 6 §4.5.7.5`
      if (r.driver === 'TMP') return `OAT ${r.oat}°C exceeds baro-VNAV limits [${r.proc.tLoC},${r.proc.tHiC}]°C — RNP-AR forbidden, revert ILS/LPV per AC 90-101A §11.6`
      if (r.driver === 'LAT') return `Lateral XTE ${r.xte.toFixed(2)} nm > 2·RNP on FAF→MAP — GO-AROUND per Doc 9905 §3.3.4 / FCOM 11.40`
      return `INCURSION on ${r.proc.id} — revoke clearance, file SDA per ICAO Doc 9870 §5.4`
    }
    if (r.tier === 'GO-AROUND') return `${r.driver} driver score ${r.score} on ${r.proc.id} — execute published missed per AC 90-101A §10.4 / Airbus PRO-NOR-SOP-19`
    if (r.tier === 'DEVIATION') return `XTE ${r.xte.toFixed(2)} nm / VPA err ${r.vpaErr.toFixed(2)}° on ${r.proc.id} — advise trend, brief missed at FAF per FCTM Approach §31`
    if (r.tier === 'WATCH') return `Within containment on ${r.proc.id}; monitor TSE per AC 90-105A §6 / ARINC 424-21 path-terminator review`
    if (r.tier === 'CONFORM') return `Within ½·RNP on ${r.proc.id}, VPA err ${r.vpaErr.toFixed(2)}° — CONFORM per Doc 9905 Vol II Pt B Table II-A-3-1`
    return ''
  }

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">SAAR · RNP-AR Conformance</div>
          <div className="text-[10px] text-slate-500">AC 90-101A · Doc 9905 Pt B · AMC 20-26 · 18 SAAR procedures</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className="rounded px-1 py-1 text-center"
            style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[9px] font-semibold" style={{ color: TIER_COLOR[t] }}>{t === 'GO-AROUND' ? 'GO-AR' : t === 'DEVIATION' ? 'DEVI' : t === 'INCURSION' ? 'INCUR' : t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean |XTE|</div>
          <div className="text-sm font-semibold" style={{ color: meanXte > 0.5 ? '#f43f5e' : meanXte > 0.2 ? '#f59e0b' : '#10b981' }}>{meanXte.toFixed(2)} nm</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Incursions</div>
          <div className="text-sm font-semibold" style={{ color: tierCount.INCURSION > 0 ? '#f43f5e' : '#10b981' }}>{tierCount.INCURSION}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Go-around</div>
          <div className="text-xs font-semibold" style={{ color: tierCount['GO-AROUND'] > 0 ? '#fb7185' : '#10b981' }}>{tierCount['GO-AROUND']}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Unapproved on final</div>
          <div className="text-xs font-semibold" style={{ color: unapprovedOnFinal > 0 ? '#f43f5e' : '#10b981' }}>{unapprovedOnFinal}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Temp violations</div>
          <div className="text-xs font-semibold" style={{ color: tempViol > 0 ? '#f59e0b' : '#10b981' }}>{tempViol}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W - 40} height={H - 48} fill="#0b1220" />
            {/* RNP reference lines x = ±0.30 nm */}
            <line x1={sx(-0.30)} y1={24} x2={sx(-0.30)} y2={H - 24} stroke="#f59e0b" strokeDasharray="3 3" strokeOpacity={0.5} />
            <line x1={sx(0.30)} y1={24} x2={sx(0.30)} y2={H - 24} stroke="#f59e0b" strokeDasharray="3 3" strokeOpacity={0.5} />
            <line x1={sx(-1.00)} y1={24} x2={sx(-1.00)} y2={H - 24} stroke="#f43f5e" strokeDasharray="3 3" strokeOpacity={0.5} />
            <line x1={sx(1.00)} y1={24} x2={sx(1.00)} y2={H - 24} stroke="#f43f5e" strokeDasharray="3 3" strokeOpacity={0.5} />
            {/* VPA reference line y=0 */}
            <line x1={30} y1={sy(0)} x2={W - 10} y2={sy(0)} stroke="#0ea5e9" strokeDasharray="2 4" strokeOpacity={0.5} />
            {/* X / Y axis labels */}
            <text x={W / 2 - 20} y={H - 4} fontSize={9} fill="#64748b">XTE (nm)</text>
            <text x={2} y={36} fontSize={9} fill="#64748b">ΔVPA°</text>
            {inScope.map((r, i) => (
              <circle key={i} cx={sx(r.xte)} cy={sy(r.vpaErr)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">SCOPE {scopeNm} nm</span><input type="range" min={5} max={50} value={scopeNm} onChange={e => setScopeNm(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">RNP-TOL {rnpTolPct}%</span><input type="range" min={50} max={200} value={rnpTolPct} onChange={e => setRnpTolPct(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">OAT {oatC > 0 ? '+' : ''}{oatC}°C</span><input type="range" min={-50} max={50} value={oatC} onChange={e => setOatC(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">ADV-MUL {advMul}%</span><input type="range" min={50} max={200} value={advMul} onChange={e => setAdvMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">VPA-TOL {vpaTolDeg.toFixed(2)}°</span><input type="range" min={5} max={50} value={Math.round(vpaTolDeg * 100)} onChange={e => setVpaTolDeg(+e.target.value / 100)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-AGL {minAglFt} ft</span><input type="range" min={0} max={3000} step={100} value={minAglFt} onChange={e => setMinAglFt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setKlassFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${klassFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {(['APPROVED-DUAL', 'APPROVED-SINGLE', 'UNAPPROVED-AC', 'UNKNOWN'] as Klass[]).map(k => (
          <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)} className={`px-2 py-0.5 rounded text-[10px] border ${klassFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{k === 'APPROVED-DUAL' ? 'A-DUAL' : k === 'APPROVED-SINGLE' ? 'A-SNG' : k === 'UNAPPROVED-AC' ? 'UNAPP' : 'UNK'}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setBandFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${bandFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {(['0.10', '0.15', '0.20', '0.30'] as RnpBand[]).map(b => (
          <button key={b} onClick={() => setBandFilter(bandFilter === b ? 'ALL' : b)} className={`px-2 py-0.5 rounded text-[10px] border ${bandFilter === b ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`} style={{ color: bandFilter === b ? RNP_COLOR[b] : undefined }}>RNP {b}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLbl, setShowLbl], ['FNL', showFnl, setShowFnl], ['RF', showRf, setShowRf], ['CONT', showCont, setShowCont], ['LNK', showLnk, setShowLnk], ['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / type / rwy / airport" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex gap-1 px-3 py-2 border-b border-slate-800">
        {(['AC', 'PROC', 'AIRP'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[10px] border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>
            {t === 'AC' ? 'Aircraft' : t === 'PROC' ? 'Procedures' : 'Airports'}
          </button>
        ))}
      </div>

      {tab === 'AC' && (
        <div className="px-2 py-2 space-y-1">
          {filteredRows.filter(r => r.tier !== 'OUT').slice(0, 60).map(r => (
            <div key={r.f.icao} onClick={() => onFly(r.f.icao)} className="cursor-pointer rounded border border-slate-800 bg-slate-900/50 hover:bg-slate-800/60 p-2"
              style={{ borderLeft: '3px solid ' + TIER_COLOR[r.tier] }}>
              <div className="flex items-center gap-1 text-[10px]">
                <span className="font-semibold text-slate-100 truncate flex-1">{r.f.callsign || r.f.icao}</span>
                <span className="text-slate-500 truncate">{r.f.type}</span>
                <span className="px-1 rounded" style={{ backgroundColor: KLASS_COLOR[r.klass] + '33', color: KLASS_COLOR[r.klass] }}>{r.klass === 'APPROVED-DUAL' ? 'DUAL' : r.klass === 'APPROVED-SINGLE' ? 'SNG' : r.klass === 'UNAPPROVED-AC' ? 'UNAPP' : 'UNK'}</span>
                <span className="px-1 rounded bg-slate-800 text-slate-300">{r.phase}</span>
                <span className="px-1 rounded" style={{ backgroundColor: TIER_COLOR[r.tier] + '33', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-1">
                {r.proc?.id} · RNP {r.proc?.rnpFinal.toFixed(2)} · XTE <span style={{ color: Math.abs(r.xte) > (r.proc?.rnpFinal || 0.3) ? '#f43f5e' : Math.abs(r.xte) > (r.proc?.rnpFinal || 0.3) * 0.5 ? '#f59e0b' : '#10b981' }}>{r.xte >= 0 ? '+' : ''}{r.xte.toFixed(2)} nm</span> · VPA {r.vpaActual.toFixed(2)}° (Δ {r.vpaErr >= 0 ? '+' : ''}{r.vpaErr.toFixed(2)}°) · OAT {r.oat}°C{r.tmpExceed > 0 ? ` (+${r.tmpExceed.toFixed(0)}°C ⚠)` : ''}{r.phase === 'RF' ? ` · RF dev ${r.rfDev >= 0 ? '+' : ''}${r.rfDev.toFixed(2)} nm` : ''}
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} />
              </div>
              <div className="flex gap-1 mt-1 text-[9px]">
                {(['LAT', 'RF', 'TMP', 'ELG', 'STB', 'ALT'] as Driver[]).map(d => {
                  const v = d === 'LAT' ? r.sLat : d === 'RF' ? r.sRf : d === 'TMP' ? r.sTmp : d === 'ELG' ? r.sElg : d === 'STB' ? r.sStb : r.sAlt
                  const col = v >= 80 ? '#f43f5e' : v >= 55 ? '#f59e0b' : v >= 25 ? '#0ea5e9' : '#10b981'
                  return <span key={d} className="px-1 rounded" style={{ backgroundColor: col + '22', color: col, border: '1px solid ' + col + '44' }}>{d} {v}</span>
                })}
              </div>
              <div className="mt-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>{advice(r)}</div>
            </div>
          ))}
          {filteredRows.filter(r => r.tier !== 'OUT').length === 0 && <div className="text-center text-slate-500 py-4 text-[11px]">No aircraft on RNP-AR finals in scope</div>}
        </div>
      )}

      {tab === 'PROC' && (
        <div className="px-2 py-2 space-y-1">
          {PROCS.filter(p => bandFilter === 'ALL' || rnpBand(p.rnpFinal) === bandFilter).map(p => {
            const agg = procAgg.find(a => a.proc.id === p.id)
            const col = RNP_COLOR[rnpBand(p.rnpFinal)]
            return (
              <div key={p.id} className="rounded border border-slate-800 bg-slate-900/50 p-2" style={{ borderLeft: '3px solid ' + col }}>
                <div className="flex items-center gap-1 text-[10px]">
                  <span className="font-semibold text-slate-100 truncate flex-1">{p.id}</span>
                  <span className="text-slate-500 truncate">{p.airport}</span>
                  <span className="px-1 rounded" style={{ backgroundColor: col + '33', color: col }}>RNP {p.rnpFinal.toFixed(2)}</span>
                  <span className="px-1 rounded bg-slate-800 text-slate-300">VPA {p.vpa.toFixed(2)}°</span>
                  {agg && agg.inc > 0 && <span className="px-1 rounded" style={{ backgroundColor: '#f43f5e33', color: '#fda4af' }}>INC {agg.inc}</span>}
                </div>
                <div className="text-[10px] text-slate-400 mt-1">
                  FBR {p.fbr.toString().padStart(3, '0')}° · FAF {p.fafAltFt} ft · Missed RNP {p.rnpMissed.toFixed(2)} · T [{p.tLoC},{p.tHiC}]°C · {p.authority} · <span className="italic">{p.chart}</span>
                </div>
                {agg && <div className="text-[10px] text-slate-500 mt-1">in-scope {agg.n} · mean |XTE| {agg.meanXte.toFixed(2)} nm{agg.ga > 0 ? ` · GA ${agg.ga}` : ''}</div>}
              </div>
            )
          })}
        </div>
      )}

      {tab === 'AIRP' && (
        <div className="px-2 py-2 space-y-1">
          {airportAgg.map(a => (
            <div key={a.icao} className="rounded border border-slate-800 bg-slate-900/50 p-2" style={{ borderLeft: '3px solid ' + (a.inc > 0 ? '#f43f5e' : a.ga > 0 ? '#fb7185' : '#0ea5e9') }}>
              <div className="flex items-center gap-1 text-[10px]">
                <span className="font-semibold text-slate-100 truncate flex-1">{a.icao} · {a.airport}</span>
                <span className="px-1 rounded bg-slate-800 text-slate-300">{a.procs} proc</span>
                {a.inc > 0 && <span className="px-1 rounded" style={{ backgroundColor: '#f43f5e33', color: '#fda4af' }}>INC {a.inc}</span>}
                {a.ga > 0 && <span className="px-1 rounded" style={{ backgroundColor: '#fb718533', color: '#fecdd3' }}>GA {a.ga}</span>}
              </div>
              <div className="text-[10px] text-slate-400 mt-1">in-scope {a.n}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
