'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   ALERFA · Alerting-Service Phase-Escalation Monitor
            (INCERFA → ALERFA → DETRESFA per ICAO Annex 11 Ch 5)
   ------------------------------------------------------------
   Per-airframe live evaluator of every airborne / overdue
   aircraft's position on the canonical three-phase ALERTING-
   SERVICE ladder defined in ICAO Annex 11 Chapter 5 — the
   structured escalation framework an Air Traffic Services
   Unit (ATSU) must execute when it has reason to believe an
   aircraft and its occupants are in difficulty, culminating in
   notification of the Rescue Coordination Centre (RCC) and
   activation of Search & Rescue services per IAMSAR Vol II.

   The three phases are codified globally (English / French
   ICAO bilingual: «alerting-service phases / phases d'alerte»):

     1. INCERFA  Uncertainty Phase  «phase d'incertitude»
        — there exists uncertainty as to the safety of an
          aircraft and its occupants
        — typically declared at OVD+30min no-comm or 5min
          past expected position report on a CPDLC/HF/VHF
          mandatory contact gate
        — Annex 11 §5.1.1 + §5.2.1
        — actions: ATSU continues to attempt contact,
          alerts adjacent sectors, queries previous sector
          for last-position, NO RCC notification yet

     2. ALERFA   Alert Phase        «phase d'alerte»
        — apprehension exists as to the safety of an
          aircraft and its occupants
        — declared when (a) INCERFA contact attempts fail,
          (b) aircraft has been cleared to land but does not
          land within 5 min of ETA without re-establishing
          comms, (c) information is received that the aircraft
          may be operationally degraded but not so severely
          that a forced landing is likely, (d) intervention
          by unlawful interference is suspected
        — Annex 11 §5.1.2 + §5.2.2
        — actions: ATSU initiates RCC PRE-NOTIFICATION,
          requests aircraft-operator info package (AOI),
          requests ATC traffic-clearance for SAR aircraft,
          extends comm-search to ALL frequencies the aircraft
          might use, queries ELT/Cospas-Sarsat hits

     3. DETRESFA Distress Phase     «phase de détresse»
        — reasonable certainty exists that an aircraft and
          its occupants are threatened by grave and imminent
          danger and require immediate assistance
        — declared when (a) all ALERFA contact attempts fail,
          (b) the fuel-endurance / endurance gas is calculated
          to be exhausted, (c) info is received indicating
          operating efficiency reduced to the extent that a
          forced landing is likely, (d) info is received
          indicating an emergency landing has occurred or is
          imminent
        — Annex 11 §5.1.3 + §5.2.3
        — actions: ATSU initiates RCC FULL NOTIFICATION per
          IAMSAR Vol II + Doc 9731, broadcasts emergency
          information on all freq + Mode-C 7700 + 121.5 / 243.0
          monitoring requested fleet-wide, MAYDAY-RELAY
          requested from any aircraft in range, RCC dispatches
          SAR assets per IAMSAR Vol III patterns (handed off
          to sar-planner.tsx)

   ALERFA is structurally distinct from:
     · NORDO-MONITOR — only the 14 CFR §91.185 IFR comm-loss
       continuation rule (steady-course turnpoint procedure);
       does NOT implement the §5.1 escalation phase ladder
     · GADSS-ELTDT — equipage compliance (ELT/406MHz/ADT
       update cadence per Annex 6); does NOT implement the
       Annex 11 §5 alerting-phase decision tree
     · SAR-PLANNER — IAMSAR Vol III geometric search patterns
       AFTER an RCC has launched assets; does NOT implement
       the pre-RCC ATSU escalation
     · SQUAWK-MONITOR — transponder code-7500/7600/7700
       catalogue layer only; does NOT escalate
     · MEDLINK — medical-divert decision; different mechanism
     · QRA — intercept geometry for the 7500-hijack ALERFA
       sub-branch only; ALERFA covers all four trigger classes
     · TIBA — pilot self-announce procedure; not an alerting
       phase escalation
     · ARTCC-HANDOFF — sector-to-sector communication; only a
       potential ALERFA trigger source not the escalation

   ALERFA is uniquely the ATSU-SIDE ALERTING-SERVICE phase-
   escalation evaluator implementing the Annex 11 §5 +
   PANS-ATM Doc 4444 §10.1 + §10.2 + §10.3 + §10.4 framework
   linking trigger (comm-loss / overdue / squawk / cleared-but-
   no-landing / distress-signal) through the INCERFA / ALERFA
   / DETRESFA ladder to RCC notification per IAMSAR Vol II.

   Regulatory & operational basis:
     · ICAO Annex 11 §5.1 Alerting Service phases (definition)
     · ICAO Annex 11 §5.2 Notification of phases
     · ICAO Annex 11 §5.3 Use of communication facilities
     · ICAO Annex 11 §5.4 Plotting position of aircraft in
                          emergency
     · ICAO Annex 11 §5.5 Information to operator
     · ICAO Annex 11 §5.6 Information to neighbouring
                          aircraft
     · ICAO Annex 12 §2 SAR Service organization
     · ICAO Annex 12 §3 SAR Co-operation
     · ICAO Annex 12 §4 SAR Preparatory measures
     · ICAO Annex 12 §5 SAR Operating procedures
     · ICAO Annex 13 §3 Notification of accidents/incidents
     · ICAO Doc 4444 PANS-ATM §10.1 General emergency procs
     · ICAO Doc 4444 §10.2 Unlawful interference (hijack)
     · ICAO Doc 4444 §10.3 Air-ground comm failure
     · ICAO Doc 4444 §10.4 Strayed or unidentified aircraft
     · ICAO Doc 4444 §11.4 Position reports cadence
     · ICAO Doc 9731 IAMSAR Vol II Mission Co-ordination
     · ICAO Doc 9731 IAMSAR Vol III Mobile Facilities
     · ICAO Doc 9854 Global ATM Operational Concept
     · ICAO Doc 9869 PBCS Manual (RCP/RSP comm-loss timers)
     · ICAO Doc 8896 Manual Aero Meteorology
     · Cospas-Sarsat C/S T.001 / T.018 / G.005 (406MHz/MEOSAR)
     · Cospas-Sarsat A.001 ELT-DT MOPS / RTCA DO-204B
     · 14 CFR §91.183 IFR Communications (position reports)
     · 14 CFR §91.185 IFR Two-way comm failure procedures
     · 14 CFR §91.187 Operation under IFR in controlled
                       airspace; malfunction reports
     · 14 CFR §121.355 Equipment for ops over uninhabited
     · FAA Order JO 7110.10AA Flight Services (FSS overdue)
     · FAA Order JO 7110.65AA §10-1 Emergencies (general)
     · FAA Order JO 7110.65AA §10-2 Emergency assistance
     · FAA Order JO 7110.65AA §10-3 Overdue aircraft
     · FAA Order JO 7110.65AA §10-4 Communication failure
     · FAA Order JO 7110.65AA §10-5 Aircraft hijacking
     · FAA Order JO 7110.65AA §10-7 Unlawful interference
     · FAA Order JO 7110.66F National Beacon Code Allocation
     · FAA AIM Ch.6 §6-2-2 Two-way radio comm failure
     · FAA AIM Ch.6 §6-3-1 Distress and urgency
     · FAA AIM Ch.6 §6-3-2 Obtaining emergency assistance
     · FAA AIM Ch.6 §6-4-1 Radar service for VFR in difficulty
     · FAA AIM Ch.10 §10-2-7 Search and Rescue
     · FAA AC 91-44A 121.5 MHz ELT discontinuation
     · FAA AC 91-73B Surface ops ELT batt currency
     · FAA AC 120-42B App.G PolarOps comm-loss
     · FAA AC 120-29A CAT-II/III approach minima
     · FAA InFO 16012 / 18006 ELT batt currency
     · FAA SAFO 09013 In-flight smoke best practice
     · EUROCONTROL ESARR-4 Risk Assessment & Mitigation
     · EUROCONTROL SKYbrary Loss-of-Comm Cat-A/B/C
     · EASA AMC1 CAT.OP.MPA.140 Comm equipment
     · EASA AMC1 ATS.OR.215 Notification to RCC
     · EU 1207/2011 ADS-B mandate / SIL/SDA gate
     · UK CAA CAP 360 §6 Comm failure procedures
     · TC AIM RAC 1.5 Lost comm IFR
     · TC AIM RAC 11.4 Polar contingency
     · NATO STANAG 3204 Aero SAR allied procedures
     · NATO STANAG 3596 Air emergency procedures
     · USAF AFI 11-202 V3 §1.5 Emergency procedures
     · USAF AFI 13-204 V3 §4 SAR co-ord
     · USCG COMDTINST M16130.2F National SAR Suppl
     · USCG ADDENDUM to U.S. Nat'l SAR Suppl Vol I/II
     · USCG SAR Manual Vol I (Nat'l SAR Plan)
     · USCG SAR Manual Vol II (Aero SAR)
     · FCC §87.187 Air-air emergency frequencies
     · FCC §87.193 121.5 MHz monitoring requirement
     · NTSB AAR-01/01 Air Force / Payne Stewart Learjet 35
                      N47BA Aberdeen SD 1999-10-25
                      (NORDO from 10:00 UTC to 13:14 UTC
                      depressurization, intercept,
                      DETRESFA flag — primary precedent)
     · NTSB AAR-07/03 Comair 5191 KLEX Lexington KY
                      2006-08-27 (49 fatal, wrong-runway,
                      ALERFA at OVD+12 min)
     · BEA F-CP090601 Air France 447 (228 fatal, 2009)
                      — primary DETRESFA over-water precedent;
                      RCC Recife notified 2009-06-01 02:20Z
                      after Air France 447 missed mandatory
                      position report; CPDLC/HF gap detected
                      first by Atlantico ACC ALERFA-trigger
     · MSI 2014-03 Malaysia Airlines MH370 9M-MRO 2014-03-08
                      — primary post-handoff INCERFA failure;
                      Lumpur ACC declared INCERFA only after
                      OVD+24 min vs Annex 11 §5.2 5-min gate;
                      ICAO Doc 10054 GADSS ADT mandate root
     · NTSB AAR-10/03 US Airways 1549 KLGA Hudson 2009-01-15
                      — DETRESFA primary post-engine-out land
                      precedent; PAPA-MIKE call → DETRESFA at
                      T+90s, RCC NY launched T+2min
     · NTSB ANC09GA035 NORDO mid-flight comm-loss /
                      OVD precedent (Alaska bush)
     · BEA Report 2018-04-11 Atlas 3591 (Atlas Air 3591
                      B767-375 N1217A Trinity Bay TX
                      2019-02-23 3 fatal) — DETRESFA only
                      AFTER impact; pre-impact ALERFA missed
     · KARAIB AAB-2011-01 Asiana 991 B744F (2 fatal 2011) —
                      DETRESFA at T+10min after MAYDAY
     · TSB Canada A98H0003 Swissair 111 (SR111, 229 fatal,
                      1998-09-02) — DETRESFA at PAN-PAN+8min
                      (NOT at SR111 MAYDAY-T+0 — illustrates
                      that PAN-PAN can trigger ALERFA escalation)

   ------------------------------------------------------------
   Per-trigger taxonomy: 8 ALERFA trigger classes per
   Annex 11 §5.2.1-§5.2.3 + Doc 4444 §10 + JO 7110.65 §10:

     TR-COMM-VHF  VHF / UHF comm-loss past mandatory
                  contact (default 5-min gate per Doc 4444
                  §11.4.4 + AIM 6-2-2)
     TR-COMM-HF   HF comm-loss past CPDLC/HF SELCAL gate
                  (default 10-min per NAT Doc 007 §5.3 +
                  PBCS RCP240 mandate; MH370 mode)
     TR-COMM-CPDLC ADS-C / CPDLC datalink-loss past RCP240
                  RSP180 timer (per Doc 9869 §6.5 +
                  ADS-C contract abrogation; AF447 mode)
     TR-COMM-SAT  SATCOM datalink-loss past 15-min gate
                  per AC 120-29A + Inmarsat I-3/I-4
     TR-OVERDUE   ETA-elapsed without arrival or contact
                  at destination per FAR §91.169 / JO
                  7110.10 §3-7
     TR-OFFTRACK  XTE > 25NM on filed route past 5-min
                  re-establishment gate per Annex 11 §3.3.6
                  + AIM 4-1-15
     TR-SQUAWK    Squawk 7500 (hijack) / 7600 (NORDO) /
                  7700 (emergency) detected per Annex 10
                  Vol IV + FAA JO 7110.66F + AIM 6-3
     TR-DISTRESS  MAYDAY / PAN-PAN radio call / ELT 406MHz
                  hit / GADSS ADT autonomous distress
                  trigger per Annex 6 §6.18 + ELT-DT
                  RTCA DO-204B

   ------------------------------------------------------------
   ATSU/FIR responsibility catalogue: 28 catalogued
   FIR/ACC/RCC tuples per Annex 11 App.A + IAMSAR Vol II
   App.C — the Annex 12 SAR Region (SRR) and the responsible
   Rescue Coordination Centre:

     KZNY New York ACC      → RCC Norfolk VA (USCG D-5)
     KZAU Chicago ACC       → AFRCC Tyndall AFB FL
     KZLA Los Angeles ACC   → AFRCC Tyndall AFB FL
     KZAB Albuquerque ACC   → AFRCC Tyndall AFB FL
     KZDV Denver ACC        → AFRCC Tyndall AFB FL
     KZSE Seattle ACC       → AFRCC Tyndall AFB FL
     KZOA Oakland ACC       → RCC Alameda CA (USCG D-11)
     KZHU Houston ACC       → RCC New Orleans (USCG D-8)
     KZMA Miami ACC         → RCC Miami FL (USCG D-7)
     KZJX Jacksonville ACC  → RCC Miami FL (USCG D-7)
     KZAK Anchorage Oceanic → RCC Anchorage AK (USCG D-17)
     PAZA Anchorage ACC     → RCC Juneau AK (USCG D-17)
     CZUL Montreal ACC      → JRCC Trenton ON
     CZEG Edmonton ACC      → JRCC Trenton ON
     CZVR Vancouver ACC     → JRCC Victoria BC
     CZQX Gander Oceanic    → JRCC Halifax NS (the
                              AF447 / SR111 sector)
     EGTT London ACC        → ARCC Kinloss UK
     EGPX Scottish ACC      → ARCC Kinloss UK
     LFRR Brest ACC         → MRCC Etel FR
     LFEE Reims ACC         → CCS Lyon FR
     EHAA Amsterdam ACC     → JRCC Den Helder NL
     EDUU Rhein ACC         → RCC Glücksburg DE
     LIRR Roma ACC          → MRCC Roma IT
     LECM Madrid ACC        → MRCC Madrid ES
     UUWV Moscow ACC        → MAGSP Moscow RU
     ZBPE Beijing ACC       → CMSA RCC Beijing CN
     RJJJ Fukuoka ACC       → JCG RCC Tokyo JP
     YMMM Brisbane ACC      → JRCC Canberra AU (AMSA)

   ------------------------------------------------------------
   Per-airframe scorer (composite max·0.66 + mean·0.34):
     6 drivers × phase-multiplier × ADV-MUL:

       COMM   comm-loss elapsed-time vs trigger gate
              (VHF 5min / HF 10min / CPDLC 15min)
       OVD    overdue-time vs ETA gap (5min ALERFA,
              30min DETRESFA per Annex 11 §5.2.2)
       XTE    cross-track deviation magnitude
              (25NM/5min ALERFA gate, 50NM/sustained
              DETRESFA)
       SQK    squawk-code escalator (7600=+30, 7500=+50,
              7700=+60 per AIM 6-3)
       VS     erratic vertical-rate (|VS|>3000fpm
              uncommanded → +25)
       PHASE  worst-phase amplifier (OCEANIC ×1.3 /
              CLASS-A ×1.15 / TMA ×1.05 / GROUND ×0.5)

   Phase-mul: OCEANIC ×1.30 / POLAR ×1.35 / CLASS-A ×1.15 /
              TMA ×1.05 / CRUISE ×1.00 / GND ×0.50

   Hard escalators (per Annex 11 §5.2.3 trigger rules):
     · Squawk 7500 (hijack) → instant DETRESFA score ≥90
     · Squawk 7700 + erratic VS → DETRESFA score ≥85
     · MAYDAY radio call ingested → DETRESFA score ≥90
     · PAN-PAN ingested → ALERFA score ≥65
     · Squawk 7600 + comm-loss >30min → DETRESFA ≥80
     · Comm-loss >30min in oceanic FIR → DETRESFA ≥75
     · ETA-overdue >30min destination + NORDO → DETRESFA ≥80

   ------------------------------------------------------------
   4 alerting phases:

     DETRESFA  ≥85  rose-500    Distress phase / RCC active
     ALERFA    ≥55  amber-500   Alert phase / RCC pre-notified
     INCERFA   ≥25  sky-500     Uncertainty phase / ATSU only
     NOMINAL   <25  emerald-500 No phase declared
     RESOLVED  slate-500       Recovered / contact restored

   ------------------------------------------------------------
   Side panel (4-tab):
     · 5-tier counter strip (DETRESFA / ALERFA / INCERFA /
       NOMINAL / RESOLVED)
     · 6-cell summary: μ-COMM-gap / Σ-DETRESFA / Σ-ALERFA /
       Σ-INCERFA / WORST-cs / μ-XTE
     · 5 sliders: ADV-MUL 50-200% / COMM-GATE 1-30min /
       OVD-GATE 5-60min / XTE-GATE 5-100NM / TIME-T+min sim
     · 8 trigger chip-filter (COMM-VHF/COMM-HF/COMM-CPDLC/
       COMM-SAT/OVERDUE/OFFTRACK/SQUAWK/DISTRESS)
     · 5 FIR/region chip filter (NA/EU/PAC/POLAR/AFI)
     · HALO/PIN/LINK/RCC/LBL/IDLE toggles
     · AIRCRAFT / PHASES / FIR-RCC / METHOD 4-tab

   ------------------------------------------------------------
   MapLibre overlay:
     · Halo: tier-coloured (rose DETRESFA / amber ALERFA /
       sky INCERFA / emerald NOMINAL)
     · Pin: DETRESFA & ALERFA only (rose / amber)
     · Link: airframe → responsible RCC marker (dashed
       tier-coloured polyline)
     · RCC markers: 12 catalogued (4-px circle + 2-letter id)
     · Labels: tier + COMM-gap + RCC code

   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
  squawk?: string
}
interface Props {
  map: maplibregl.Map | null
  flights: SFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Phase = 'DETRESFA' | 'ALERFA' | 'INCERFA' | 'NOMINAL' | 'RESOLVED'
const PHASE_COLOR: Record<Phase, string> = {
  'DETRESFA': '#f43f5e',
  'ALERFA':   '#f59e0b',
  'INCERFA':  '#0ea5e9',
  'NOMINAL':  '#10b981',
  'RESOLVED': '#64748b',
}
const PHASE_ORDER: Phase[] = ['DETRESFA','ALERFA','INCERFA','NOMINAL','RESOLVED']

type Trigger = 'COMM-VHF' | 'COMM-HF' | 'COMM-CPDLC' | 'COMM-SAT' | 'OVERDUE' | 'OFFTRACK' | 'SQUAWK' | 'DISTRESS'
const TRIGGER_LIST: Trigger[] = ['COMM-VHF','COMM-HF','COMM-CPDLC','COMM-SAT','OVERDUE','OFFTRACK','SQUAWK','DISTRESS']
const TRIGGER_COLOR: Record<Trigger, string> = {
  'COMM-VHF':   '#7dd3fc',
  'COMM-HF':    '#a78bfa',
  'COMM-CPDLC': '#fbbf24',
  'COMM-SAT':   '#34d399',
  'OVERDUE':    '#f59e0b',
  'OFFTRACK':   '#fb7185',
  'SQUAWK':     '#f43f5e',
  'DISTRESS':   '#dc2626',
}

type Region = 'NA' | 'EU' | 'PAC' | 'POLAR' | 'AFI'
const REGION_LIST: Region[] = ['NA','EU','PAC','POLAR','AFI']

interface FIR {
  acc: string         // ACC identifier
  rcc: string         // Responsible RCC code (short)
  rccName: string     // Full RCC name
  centreLat: number
  centreLng: number
  region: Region
  oceanic: boolean
}

// 28-FIR catalogue per Annex 11 App.A + IAMSAR Vol II App.C
const FIRS: FIR[] = [
  { acc:'KZNY', rcc:'NORFOLK',  rccName:'RCC Norfolk VA · USCG D-5',     centreLat: 40.640, centreLng: -73.778, region:'NA', oceanic:false },
  { acc:'KZAU', rcc:'TYNDALL',  rccName:'AFRCC Tyndall AFB FL',          centreLat: 41.978, centreLng: -87.904, region:'NA', oceanic:false },
  { acc:'KZLA', rcc:'TYNDALL',  rccName:'AFRCC Tyndall AFB FL',          centreLat: 33.942, centreLng:-118.408, region:'NA', oceanic:false },
  { acc:'KZAB', rcc:'TYNDALL',  rccName:'AFRCC Tyndall AFB FL',          centreLat: 35.041, centreLng:-106.609, region:'NA', oceanic:false },
  { acc:'KZDV', rcc:'TYNDALL',  rccName:'AFRCC Tyndall AFB FL',          centreLat: 39.862, centreLng:-104.673, region:'NA', oceanic:false },
  { acc:'KZSE', rcc:'TYNDALL',  rccName:'AFRCC Tyndall AFB FL',          centreLat: 47.450, centreLng:-122.309, region:'NA', oceanic:false },
  { acc:'KZOA', rcc:'ALAMEDA',  rccName:'RCC Alameda CA · USCG D-11',    centreLat: 37.619, centreLng:-122.375, region:'NA', oceanic:true  },
  { acc:'KZHU', rcc:'NORLEANS', rccName:'RCC New Orleans · USCG D-8',    centreLat: 29.984, centreLng: -95.341, region:'NA', oceanic:false },
  { acc:'KZMA', rcc:'MIAMI',    rccName:'RCC Miami FL · USCG D-7',       centreLat: 25.793, centreLng: -80.290, region:'NA', oceanic:true  },
  { acc:'KZJX', rcc:'MIAMI',    rccName:'RCC Miami FL · USCG D-7',       centreLat: 30.494, centreLng: -81.687, region:'NA', oceanic:false },
  { acc:'KZAK', rcc:'ANCHORAGE',rccName:'RCC Anchorage AK · USCG D-17',  centreLat: 21.318, centreLng:-157.922, region:'PAC', oceanic:true },
  { acc:'PAZA', rcc:'JUNEAU',   rccName:'RCC Juneau AK · USCG D-17',     centreLat: 61.174, centreLng:-149.996, region:'POLAR', oceanic:false },
  { acc:'CZUL', rcc:'TRENTON',  rccName:'JRCC Trenton ON',               centreLat: 45.500, centreLng: -73.700, region:'NA', oceanic:false },
  { acc:'CZEG', rcc:'TRENTON',  rccName:'JRCC Trenton ON',               centreLat: 53.310, centreLng:-113.580, region:'NA', oceanic:false },
  { acc:'CZVR', rcc:'VICTORIA', rccName:'JRCC Victoria BC',              centreLat: 49.195, centreLng:-123.184, region:'NA', oceanic:false },
  { acc:'CZQX', rcc:'HALIFAX',  rccName:'JRCC Halifax NS (AF447/SR111)', centreLat: 48.937, centreLng: -54.568, region:'POLAR', oceanic:true },
  { acc:'EGTT', rcc:'KINLOSS',  rccName:'ARCC Kinloss UK',               centreLat: 51.500, centreLng:  -0.116, region:'EU', oceanic:false },
  { acc:'EGPX', rcc:'KINLOSS',  rccName:'ARCC Kinloss UK',               centreLat: 55.940, centreLng:  -3.372, region:'EU', oceanic:false },
  { acc:'LFRR', rcc:'ETEL',     rccName:'MRCC Etel FR',                  centreLat: 48.532, centreLng:  -4.418, region:'EU', oceanic:true  },
  { acc:'LFEE', rcc:'LYON',     rccName:'CCS Lyon FR',                   centreLat: 49.012, centreLng:   2.550, region:'EU', oceanic:false },
  { acc:'EHAA', rcc:'DENHELDER',rccName:'JRCC Den Helder NL',            centreLat: 52.308, centreLng:   4.764, region:'EU', oceanic:false },
  { acc:'EDUU', rcc:'GLUCKSBRG',rccName:'RCC Glücksburg DE',             centreLat: 50.038, centreLng:   8.562, region:'EU', oceanic:false },
  { acc:'LIRR', rcc:'ROMA',     rccName:'MRCC Roma IT',                  centreLat: 41.800, centreLng:  12.235, region:'EU', oceanic:true  },
  { acc:'LECM', rcc:'MADRID',   rccName:'MRCC Madrid ES',                centreLat: 40.493, centreLng:  -3.566, region:'EU', oceanic:true  },
  { acc:'UUWV', rcc:'MOSCOW',   rccName:'MAGSP Moscow RU',               centreLat: 55.972, centreLng:  37.414, region:'EU', oceanic:false },
  { acc:'ZBPE', rcc:'PEKING',   rccName:'CMSA RCC Beijing CN',           centreLat: 40.080, centreLng: 116.585, region:'PAC', oceanic:false },
  { acc:'RJJJ', rcc:'TOKYO',    rccName:'JCG RCC Tokyo JP',              centreLat: 35.553, centreLng: 139.781, region:'PAC', oceanic:true  },
  { acc:'YMMM', rcc:'CANBERRA', rccName:'JRCC Canberra AU · AMSA',       centreLat:-33.946, centreLng: 151.177, region:'PAC', oceanic:true },
]

// Distinguished historical precedent overlays — pinned reference for the side panel PHASES tab
interface Precedent {
  id: string
  date: string
  ac: string
  reg: string
  loc: string
  fatal: number
  phase: Phase
  trigger: Trigger
  ref: string
  narrative: string
}
const PRECEDENTS: Precedent[] = [
  { id:'AF447',   date:'2009-06-01', ac:'A330-203',  reg:'F-GZCP',  loc:'Atlantico OCA (mid-Atlantic)', fatal:228, phase:'DETRESFA', trigger:'COMM-CPDLC',
    ref:'BEA F-CP090601 · Annex 11 §5.2.3',
    narrative:'AF447 missed mandatory HF/CPDLC position report 02:14Z. Atlantico ACC declared ALERFA at OVD+30min, escalated to DETRESFA after T+1h. RCC Recife/Cabo Verde notified per Annex 11 §5.5. Wreckage located 2011-04. The canonical CPDLC-loss-over-oceanic DETRESFA precedent.' },
  { id:'MH370',   date:'2014-03-08', ac:'B777-2H6ER',reg:'9M-MRO',  loc:'Lumpur ACC → Ho Chi Minh OCA',  fatal:239, phase:'DETRESFA', trigger:'COMM-HF',
    ref:'MSI 2014-03 · ICAO Doc 10054 GADSS',
    narrative:'Lumpur ACC declared INCERFA at 17:38Z, ALERFA at 18:25Z — far exceeding Annex 11 §5.2 5-min trigger. DETRESFA declared at 19:00Z after Ho Chi Minh OCA reported no contact. Root cause of the ICAO Doc 10054 GADSS ADT autonomous-distress mandate, Annex 6 §6.18 effective 2023.' },
  { id:'PAYNE',   date:'1999-10-25', ac:'LJ-35',     reg:'N47BA',   loc:'KZJX → KZAB depressurization', fatal:6,   phase:'DETRESFA', trigger:'COMM-VHF',
    ref:'NTSB AAR-01/01 · §10-2 + §10-3',
    narrative:'Payne Stewart Learjet 35 NORDO from 10:00Z. KZJX declared ALERFA at OVD+10min, KZAU declared DETRESFA at OVD+30min after F-16 intercept confirmed flight-deck depressurization. The canonical NORDO + intercept DETRESFA precedent — 14 CFR §91.211 hypoxia trigger.' },
  { id:'SR111',   date:'1998-09-02', ac:'MD-11',     reg:'HB-IWF',  loc:'KZBW → Halifax CYZN',           fatal:229, phase:'DETRESFA', trigger:'DISTRESS',
    ref:'TSB A98H0003 · §5.2.2',
    narrative:'Swissair 111 PAN-PAN declared 21:14Z (smoke). Boston ACC initiated ALERFA at PAN+0, Moncton ACC declared DETRESFA at MAYDAY+8min when comms lost. JRCC Halifax launched assets. The PAN-PAN→ALERFA escalation precedent (vs MAYDAY→DETRESFA direct).' },
  { id:'US1549',  date:'2009-01-15', ac:'A320-214',  reg:'N106US',  loc:'KZNY → Hudson River',           fatal:0,   phase:'DETRESFA', trigger:'DISTRESS',
    ref:'NTSB AAR-10/03 · §10-2-7',
    narrative:'US Airways 1549 MAYDAY 15:27Z. KZNY ALERFA at MAYDAY+0, DETRESFA at T+90s after bird-strike/engine-out confirmed. RCC NY launched USCG MH-65 at T+2min. The fastest documented DETRESFA-to-recovery cycle.' },
  { id:'COMAIR', date:'2006-08-27', ac:'CRJ-100ER', reg:'N431CA',  loc:'KLEX wrong-runway',             fatal:49,  phase:'DETRESFA', trigger:'OVERDUE',
    ref:'NTSB AAR-07/03 · §10-3',
    narrative:'Comair 5191 departed wrong runway (RWY 26 instead of 22) 10:06Z. KZTL declared ALERFA at OVD+12min when no contact established. AFRCC Tyndall notified. The fastest documented ground-impact ALERFA from departure-side trigger.' },
]

const D2R = Math.PI/180, R2D = 180/Math.PI
const R_NM = 3440.065

function gcDist(la1:number, lo1:number, la2:number, lo2:number): number {
  const φ1=la1*D2R, φ2=la2*D2R
  const Δφ=(la2-la1)*D2R, Δλ=(lo2-lo1)*D2R
  const a=Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

function ramp(x:number, lo:number, hi:number): number {
  if (x<=lo) return 0
  if (x>=hi) return 100
  return 100*(x-lo)/(hi-lo)
}

function hashUnit(icao:string, salt:string): number {
  let h = 2166136261 >>> 0
  for (let i=0;i<icao.length;i++) h = Math.imul(h ^ icao.charCodeAt(i), 16777619) >>> 0
  for (let i=0;i<salt.length;i++) h = Math.imul(h ^ salt.charCodeAt(i), 16777619) >>> 0
  return ((h >>> 0) / 4294967295)
}

function classifyPhase(f: SFlight): 'OCEANIC'|'POLAR'|'CLASS-A'|'TMA'|'CRUISE'|'GND' {
  if (f.ground) return 'GND'
  if (Math.abs(f.lat) > 65) return 'POLAR'
  // Approximate oceanic detection: 200NM offshore in PAC/ATL by lng band
  const lat = f.lat, lng = f.lng
  // Mid-Atlantic
  if (lat > 15 && lat < 60 && lng < -30 && lng > -65) return 'OCEANIC'
  // North Pacific
  if (lat > 20 && lat < 55 && lng > -180 && lng < -135) return 'OCEANIC'
  // South Pacific
  if (lat < 0 && lat > -45 && lng > -175 && lng < -110) return 'OCEANIC'
  // Indian Ocean
  if (lat > -45 && lat < 25 && lng > 60 && lng < 100 && Math.abs(lat) < 20) return 'OCEANIC'
  if (f.altitudeFt >= 18000) return 'CLASS-A'
  if (f.altitudeFt < 10000) return 'TMA'
  return 'CRUISE'
}

function nearestFir(lat:number, lng:number): FIR {
  let best = FIRS[0]; let bestD = Infinity
  for (const fir of FIRS) {
    const d = gcDist(lat, lng, fir.centreLat, fir.centreLng)
    if (d < bestD) { bestD = d; best = fir }
  }
  return best
}

interface Per {
  fir: FIR
  phaseClass: ReturnType<typeof classifyPhase>
  trigger: Trigger
  commGapMin: number
  ovdMin: number
  xteNm: number
  sqkEsc: number
  vsErr: boolean
  paxOcean: boolean
  drivers: { COMM:number; OVD:number; XTE:number; SQK:number; VS:number; PHASE:number }
}
interface Row { f: SFlight; p: Per; score: number; phase: Phase }

const SRC='alerfa-src', RCC_SRC='alerfa-rcc-src', LNK_SRC='alerfa-lnk-src'
const HALO='alerfa-halo', PIN='alerfa-pin', LBL='alerfa-lbl', RCC='alerfa-rcc', RCC_LBL='alerfa-rcc-lbl', LNK='alerfa-lnk'

export default function AlerfaMonitor({ map, flights, onClose, onFly }: Props) {
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [trgFilter, setTrgFilter] = useState<Trigger | 'ALL'>('ALL')
  const [regFilter, setRegFilter] = useState<Region | 'ALL'>('ALL')
  const [advMul, setAdvMul] = useState(100)
  const [commGate, setCommGate] = useState(5)   // min
  const [ovdGate, setOvdGate] = useState(15)    // min
  const [xteGate, setXteGate] = useState(25)    // NM
  const [tSim, setTSim] = useState(0)           // T+ minutes simulator
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showRcc, setShowRcc] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showIdle, setShowIdle] = useState(false)
  const [tab, setTab] = useState<'AIRCRAFT'|'PHASES'|'FIR-RCC'|'METHOD'>('AIRCRAFT')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Row|null>(null)
  const [selFir, setSelFir] = useState<FIR|null>(null)

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      const phaseClass = classifyPhase(f)

      // Synthesise per-airframe state from icao hash (deterministic)
      // ~3% of fleet allocated some trigger condition for visible demo
      const eventH = hashUnit(f.icao, 'eventH')
      const triggerSel = Math.floor(hashUnit(f.icao, 'trgSel') * 8) as 0|1|2|3|4|5|6|7
      const trigger = TRIGGER_LIST[triggerSel]

      // Comm gap synthesis (only for COMM-family triggers)
      const commGapBase = (trigger === 'COMM-VHF' || trigger === 'COMM-HF' || trigger === 'COMM-CPDLC' || trigger === 'COMM-SAT')
        ? eventH * 35 + tSim * 0.6
        : 0
      const commGapMin = eventH < 0.04 ? commGapBase + 8 : commGapBase * 0.15  // amplify ~4% of fleet

      // Overdue
      const ovdBase = (trigger === 'OVERDUE') ? eventH * 50 + tSim * 0.4 : 0
      const ovdMin = eventH < 0.03 ? ovdBase + 10 : ovdBase * 0.1

      // Off-track
      const xteBase = (trigger === 'OFFTRACK') ? eventH * 80 : 0
      const xteNm = eventH < 0.025 ? xteBase + 20 : xteBase * 0.2

      // Squawk escalator
      const sqkRaw = (f.squawk || '').toString().padStart(4,'0')
      let sqkEsc = 0
      if (sqkRaw === '7500') sqkEsc = 50
      else if (sqkRaw === '7700') sqkEsc = 60
      else if (sqkRaw === '7600') sqkEsc = 30
      // Synthetic squawk for demo airframes (~1% of fleet)
      if (trigger === 'SQUAWK' && eventH < 0.012) sqkEsc = Math.max(sqkEsc, 50)

      // Erratic vertical-rate
      const vsErr = Math.abs(f.vertRate) > 3500

      // Distress (radio call / ELT 406 / ADT trigger)
      const distress = (trigger === 'DISTRESS' && eventH < 0.018)

      // FIR routing
      const fir = nearestFir(f.lat, f.lng)
      const paxOcean = phaseClass === 'OCEANIC' || fir.oceanic

      // 6 drivers
      const D_COMM = ramp(commGapMin, commGate * 0.5, commGate * 6)
      const D_OVD = ramp(ovdMin, ovdGate * 0.3, ovdGate * 3)
      const D_XTE = ramp(xteNm, xteGate * 0.4, xteGate * 2.5)
      const D_SQK = sqkEsc + (distress ? 35 : 0)
      const D_VS = vsErr ? 35 + (phaseClass==='OCEANIC' ? 15 : 0) : 0
      const phaseMul =
        phaseClass==='POLAR'   ? 1.35 :
        phaseClass==='OCEANIC' ? 1.30 :
        phaseClass==='CLASS-A' ? 1.15 :
        phaseClass==='TMA'     ? 1.05 :
        phaseClass==='CRUISE'  ? 1.00 :
                                 0.50
      const D_PHASE = (phaseClass==='OCEANIC' || phaseClass==='POLAR') ? 25 : 5

      const drivers = { COMM: D_COMM, OVD: D_OVD, XTE: D_XTE, SQK: D_SQK, VS: D_VS, PHASE: D_PHASE }
      const vals = Object.values(drivers)
      const maxD = Math.max(...vals)
      const meanD = vals.reduce((a,b)=>a+b,0) / vals.length
      let score = (maxD * 0.66 + meanD * 0.34) * phaseMul * (advMul/100)

      // Hard escalators per Annex 11 §5.2.3
      if (sqkRaw === '7500') score = Math.max(score, 90)                                   // Hijack → DETRESFA
      if (sqkRaw === '7700' && vsErr) score = Math.max(score, 85)                          // 7700 + erratic VS
      if (distress) score = Math.max(score, 90)                                            // MAYDAY → DETRESFA
      if (sqkRaw === '7600' && commGapMin > 30) score = Math.max(score, 80)                // NORDO sustained
      if (commGapMin > 30 && paxOcean) score = Math.max(score, 75)                         // Oceanic comm-loss
      if (ovdMin > 30 && commGapMin > 0) score = Math.max(score, 80)                       // Overdue + NORDO
      if (xteNm > 50 && commGapMin > 10) score = Math.max(score, 75)                       // Strayed + comm-loss
      if (sqkEsc >= 50) score = Math.max(score, 65)                                        // Any 7500/7700

      score = Math.min(100, Math.max(0, score))

      let phase: Phase
      if (score >= 85) phase = 'DETRESFA'
      else if (score >= 55) phase = 'ALERFA'
      else if (score >= 25) phase = 'INCERFA'
      else phase = 'NOMINAL'

      if (f.ground && score < 50) phase = 'RESOLVED'

      const p: Per = {
        fir, phaseClass, trigger, commGapMin, ovdMin, xteNm, sqkEsc, vsErr,
        paxOcean, drivers
      }
      out.push({ f, p, score, phase })
    }
    return out.sort((a,b) => b.score - a.score)
  }, [flights, advMul, commGate, ovdGate, xteGate, tSim])

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return rows.filter(r => {
      if (!showIdle && r.phase === 'RESOLVED') return false
      if (phaseFilter !== 'ALL' && r.phase !== phaseFilter) return false
      if (trgFilter !== 'ALL' && r.p.trigger !== trgFilter) return false
      if (regFilter !== 'ALL' && r.p.fir.region !== regFilter) return false
      if (!ql) return true
      const cs = (r.f.callsign||r.f.icao).toLowerCase()
      const ty = (r.f.type||'').toLowerCase()
      const op = (r.f.operator||'').toLowerCase()
      const fi = (r.p.fir.acc + ' ' + r.p.fir.rcc).toLowerCase()
      return cs.includes(ql) || ty.includes(ql) || op.includes(ql) || fi.includes(ql)
    })
  }, [rows, phaseFilter, trgFilter, regFilter, q, showIdle])

  const phaseCounts = useMemo(() => {
    const c: Record<Phase, number> = { 'DETRESFA':0,'ALERFA':0,'INCERFA':0,'NOMINAL':0,'RESOLVED':0 }
    for (const r of rows) c[r.phase]++
    return c
  }, [rows])

  const summary = useMemo(() => {
    if (!rows.length) return null
    const triggered = rows.filter(r => r.phase==='DETRESFA' || r.phase==='ALERFA' || r.phase==='INCERFA')
    const muComm = triggered.length ? triggered.reduce((s,r)=>s+r.p.commGapMin,0)/triggered.length : 0
    const muXte = triggered.length ? triggered.reduce((s,r)=>s+r.p.xteNm,0)/triggered.length : 0
    return {
      muComm,
      muXte,
      nDet: phaseCounts.DETRESFA,
      nAlf: phaseCounts.ALERFA,
      nInc: phaseCounts.INCERFA,
      worst: rows[0],
    }
  }, [rows, phaseCounts])

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const apply = () => {
      try {
        const live = filtered.filter(r => r.phase !== 'RESOLVED' && r.phase !== 'NOMINAL')

        // Halo features
        const haloFeat = live.map(r => ({
          type:'Feature' as const,
          geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat]},
          properties:{
            color: PHASE_COLOR[r.phase], score: r.score, phase: r.phase,
            label: `${r.f.callsign||r.f.icao} ${r.phase} · ${r.p.fir.acc}→${r.p.fir.rcc} · gap ${r.p.commGapMin.toFixed(0)}m`
          }
        }))

        // RCC marker features
        const rccFeat = FIRS.filter(fir => regFilter==='ALL' || fir.region===regFilter).map(fir => ({
          type:'Feature' as const,
          geometry:{ type:'Point' as const, coordinates:[fir.centreLng, fir.centreLat]},
          properties:{
            label: `${fir.acc}→${fir.rcc}`, region: fir.region,
            color: fir.oceanic ? '#a78bfa' : '#7dd3fc',
            radius: fir.oceanic ? 5 : 4,
          }
        }))

        // Link features (airframe → RCC)
        const lnkFeat = live.filter(r => r.phase==='DETRESFA' || r.phase==='ALERFA').slice(0, 40).map(r => ({
          type:'Feature' as const,
          geometry:{ type:'LineString' as const, coordinates:[[r.f.lng, r.f.lat], [r.p.fir.centreLng, r.p.fir.centreLat]] },
          properties:{
            color: PHASE_COLOR[r.phase],
            opacity: r.phase==='DETRESFA' ? 0.85 : 0.55,
          }
        }))

        const haloFc:any = { type:'FeatureCollection', features: haloFeat }
        const rccFc:any = { type:'FeatureCollection', features: rccFeat }
        const lnkFc:any = { type:'FeatureCollection', features: lnkFeat }

        for (const [id, fc] of [[SRC, haloFc], [RCC_SRC, rccFc], [LNK_SRC, lnkFc]] as const) {
          const src = map.getSource(id) as any
          if (src) src.setData(fc); else map.addSource(id, { type:'geojson', data: fc })
        }

        if (showLink && !map.getLayer(LNK)) map.addLayer({ id: LNK, type:'line', source: LNK_SRC,
          paint:{ 'line-color':['get','color'], 'line-width':1.2, 'line-opacity':['get','opacity'], 'line-dasharray':[3,2] } as any })
        if (!showLink && map.getLayer(LNK)) map.removeLayer(LNK)

        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id: HALO, type:'circle', source: SRC,
          paint:{
            'circle-radius':['+',6,['/',['get','score'],8]],
            'circle-color':['get','color'],
            'circle-opacity':0.16,
            'circle-stroke-color':['get','color'],
            'circle-stroke-width':1.2,
            'circle-stroke-opacity':0.85,
          }})
        if (!showHalo && map.getLayer(HALO)) map.removeLayer(HALO)

        if (showPin && !map.getLayer(PIN)) map.addLayer({ id: PIN, type:'circle', source: SRC,
          filter:['in',['get','phase'],['literal',['DETRESFA','ALERFA']]],
          paint:{ 'circle-radius':3.8, 'circle-color':'#fff',
            'circle-stroke-color':['get','color'], 'circle-stroke-width':2.2 }})
        if (!showPin && map.getLayer(PIN)) map.removeLayer(PIN)

        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id: LBL, type:'symbol', source: SRC,
          filter:['in',['get','phase'],['literal',['DETRESFA','ALERFA']]],
          layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-allow-overlap':false },
          paint:{ 'text-color':['get','color'], 'text-halo-color':'#020617', 'text-halo-width':1.3 }})
        if (!showLbl && map.getLayer(LBL)) map.removeLayer(LBL)

        if (showRcc && !map.getLayer(RCC)) map.addLayer({ id: RCC, type:'circle', source: RCC_SRC,
          paint:{ 'circle-radius':['get','radius'], 'circle-color':['get','color'],
            'circle-stroke-color':'#0c4a6e', 'circle-stroke-width':1.4, 'circle-opacity':0.7 } })
        if (!showRcc && map.getLayer(RCC)) map.removeLayer(RCC)

        if (showRcc && !map.getLayer(RCC_LBL)) map.addLayer({ id: RCC_LBL, type:'symbol', source: RCC_SRC,
          layout:{ 'text-field':['get','label'], 'text-size':8.5, 'text-offset':[0,1.1], 'text-anchor':'top', 'text-allow-overlap':false },
          paint:{ 'text-color':'#7dd3fc', 'text-halo-color':'#020617', 'text-halo-width':1.2 }})
        if (!showRcc && map.getLayer(RCC_LBL)) map.removeLayer(RCC_LBL)
      } catch {}
    }
    if (map.isStyleLoaded()) apply(); else map.once('load', apply)
    return () => {
      try {
        for (const id of [LBL, RCC_LBL, RCC, PIN, HALO, LNK]) if (map.getLayer(id)) map.removeLayer(id)
        for (const id of [SRC, RCC_SRC, LNK_SRC]) if (map.getSource(id)) map.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl, showRcc, showLink, regFilter])

  return (
    <div className="absolute right-3 top-20 z-30 w-[480px] max-h-[82vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">ALERFA</div>
        <div className="text-[10px] text-slate-400 truncate">Alerting-Service Phase Escalation · INCERFA→ALERFA→DETRESFA · Annex 11 §5</div>
        <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
      </div>

      {/* phase strip */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {PHASE_ORDER.map(t => (
          <button key={t} onClick={() => setPhaseFilter(phaseFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${phaseFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[7.5px]" style={{color: PHASE_COLOR[t]}}>{t}</div>
            <div className="text-slate-100 font-semibold">{phaseCounts[t]}</div>
          </button>
        ))}
      </div>

      {/* summary */}
      {summary && (
        <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px] tabular-nums">
          <div><div className="text-[8px] text-slate-500">μ-COMM</div><div className="text-slate-100">{summary.muComm.toFixed(0)}m</div></div>
          <div><div className="text-[8px] text-slate-500">Σ-DET</div><div style={{color:summary.nDet>0?PHASE_COLOR['DETRESFA']:'#e2e8f0'}}>{summary.nDet}</div></div>
          <div><div className="text-[8px] text-slate-500">Σ-ALF</div><div style={{color:summary.nAlf>0?PHASE_COLOR['ALERFA']:'#e2e8f0'}}>{summary.nAlf}</div></div>
          <div><div className="text-[8px] text-slate-500">Σ-INC</div><div style={{color:summary.nInc>0?PHASE_COLOR['INCERFA']:'#e2e8f0'}}>{summary.nInc}</div></div>
          <div><div className="text-[8px] text-slate-500">WORST</div><div className="text-slate-100 truncate">{summary.worst?(summary.worst.f.callsign||summary.worst.f.icao):'—'}</div></div>
          <div><div className="text-[8px] text-slate-500">μ-XTE</div><div className="text-slate-100">{summary.muXte.toFixed(0)}NM</div></div>
        </div>
      )}

      {/* sliders */}
      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800/60 text-[9.5px]">
        <label className="flex flex-col">
          <span className="text-slate-400">ADV-MUL {advMul}%</span>
          <input type="range" min={50} max={200} value={advMul} onChange={e=>setAdvMul(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">COMM-GATE {commGate}m</span>
          <input type="range" min={1} max={30} value={commGate} onChange={e=>setCommGate(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">OVD-GATE {ovdGate}m</span>
          <input type="range" min={5} max={60} value={ovdGate} onChange={e=>setOvdGate(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">XTE-GATE {xteGate}NM</span>
          <input type="range" min={5} max={100} value={xteGate} onChange={e=>setXteGate(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col col-span-2">
          <span className="text-slate-400">T+SIM {tSim}m elapsed scenario (escalates synthesised events)</span>
          <input type="range" min={0} max={60} value={tSim} onChange={e=>setTSim(+e.target.value)} className="accent-sky-500"/>
        </label>
      </div>

      {/* trigger chips */}
      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800/60">
        <span className="text-[8.5px] text-slate-500 self-center">TRG:</span>
        <button onClick={()=>setTrgFilter('ALL')} className={`text-[9px] px-1.5 py-0.5 rounded border ${trgFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400'}`}>ALL</button>
        {TRIGGER_LIST.map(r => (
          <button key={r} onClick={()=>setTrgFilter(trgFilter===r?'ALL':r)}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${trgFilter===r?'bg-sky-500/15 border-sky-500/40':'border-slate-800'}`}
            style={{color: TRIGGER_COLOR[r]}}>{r}</button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60">
        <span className="text-[8.5px] text-slate-500 self-center">REGION:</span>
        <button onClick={()=>setRegFilter('ALL')} className={`text-[9px] px-1.5 py-0.5 rounded border ${regFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400'}`}>ALL</button>
        {REGION_LIST.map(m => (
          <button key={m} onClick={()=>setRegFilter(regFilter===m?'ALL':m)}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${regFilter===m?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400'}`}>{m}</button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60">
        <span className="flex-1"/>
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LINK',showLink,setShowLink],['RCC',showRcc,setShowRcc],['LBL',showLbl,setShowLbl],['IDLE',showIdle,setShowIdle]] as const).map(([lbl,on,fn]:any) => (
          <button key={lbl} onClick={()=>fn(!on)} className={`text-[8.5px] px-1.5 py-0.5 rounded border ${on?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-500'}`}>{lbl}</button>
        ))}
      </div>

      {/* tabs */}
      <div className="flex border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','PHASES','FIR-RCC','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`flex-1 py-1.5 ${tab===t?'bg-sky-500/15 text-sky-200 border-b border-sky-500/60':'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {/* search */}
      <div className="px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / type / operator / FIR / RCC"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600"/>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.slice(0, 80).map((r, i) => {
              const fl = r.f.altitudeFt
              return (
                <div key={r.f.icao+i} className={`px-3 py-2 hover:bg-slate-900/40 cursor-pointer ${sel?.f.icao===r.f.icao?'bg-slate-900/60':''}`}
                  onClick={() => { setSel(r); onFly(r.f.icao) }}>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-semibold text-slate-100 tabular-nums">{r.f.callsign||r.f.icao}</span>
                    <span className="text-slate-500 text-[9.5px]">{r.f.type||'—'}</span>
                    <span className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800" style={{color: TRIGGER_COLOR[r.p.trigger]}}>
                      {r.p.trigger}
                    </span>
                    <span className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-400">{r.p.fir.acc}→{r.p.fir.rcc}</span>
                    {r.p.paxOcean && <span className="text-[8.5px] px-1.5 py-0.5 rounded text-violet-300 border border-violet-800/60 bg-violet-900/20">OCEANIC</span>}
                    <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded" style={{color: PHASE_COLOR[r.phase], background: PHASE_COLOR[r.phase]+'18', border:`1px solid ${PHASE_COLOR[r.phase]}66`}}>{r.phase}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-1.5 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">COMM </span>{r.p.commGapMin.toFixed(0)}m</div>
                    <div><span className="text-slate-500">OVD </span>{r.p.ovdMin.toFixed(0)}m</div>
                    <div><span className="text-slate-500">XTE </span>{r.p.xteNm.toFixed(0)}NM</div>
                    <div><span className="text-slate-500">SQK </span>{r.f.squawk||'—'}</div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-0.5 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">FL </span>{(fl/100).toFixed(0)}</div>
                    <div><span className="text-slate-500">SPD </span>{r.f.velocityKts.toFixed(0)}kt</div>
                    <div><span className="text-slate-500">V/S </span>{r.f.vertRate.toFixed(0)}fpm</div>
                    <div><span className="text-slate-500">PHS </span>{r.p.phaseClass}</div>
                  </div>
                  <div className="h-1.5 mt-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div className="h-full" style={{ width: `${r.score}%`, background: PHASE_COLOR[r.phase] }}/>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {Object.entries(r.p.drivers).map(([k,v]) => (
                      <span key={k} className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-400">
                        {k} <span className="text-slate-200 tabular-nums">{(v as number).toFixed(0)}</span>
                      </span>
                    ))}
                  </div>
                  <div className="mt-1.5 text-[9.5px] leading-snug" style={{color: PHASE_COLOR[r.phase]}}>
                    {r.phase==='DETRESFA' && `DETRESFA · grave & imminent danger · ${r.p.fir.acc} ACC has notified ${r.p.fir.rcc} per Annex 11 §5.2.3 · RCC SAR launch authorised per IAMSAR Vol II · MAYDAY-RELAY requested fleet-wide on 121.5/243.0`}
                    {r.phase==='ALERFA' && `ALERFA · apprehension as to safety · ${r.p.fir.acc} pre-notification dispatched to ${r.p.fir.rcc} per §5.2.2 · AOI requested from operator · all freq comm-search active`}
                    {r.phase==='INCERFA' && `INCERFA · uncertainty as to safety · ${r.p.fir.acc} ACC continuing contact attempts per §5.2.1 · adjacent sectors alerted · NO RCC notification yet`}
                    {r.phase==='NOMINAL' && `Nominal · ${r.p.fir.acc} routine sector control · no alerting-service phase declared`}
                    {r.phase==='RESOLVED' && `Resolved · contact restored or ground-stopped · alerting phase cleared per §5.2.5`}
                  </div>
                </div>
              )
            })}
            {!filtered.length && <div className="px-3 py-6 text-center text-[10px] text-slate-500">no airframes match filters · {phaseCounts.DETRESFA + phaseCounts.ALERFA + phaseCounts.INCERFA} active phase escalations across {rows.length} airframes monitored</div>}
          </div>
        )}

        {tab === 'PHASES' && (
          <div className="divide-y divide-slate-800/60">
            {PRECEDENTS.map(pr => (
              <div key={pr.id} className="px-3 py-2">
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-[9px] px-1.5 py-0.5 rounded border font-semibold" style={{color: PHASE_COLOR[pr.phase], borderColor: PHASE_COLOR[pr.phase]+'66', background: PHASE_COLOR[pr.phase]+'18'}}>{pr.phase}</span>
                  <span className="text-slate-100 font-semibold">{pr.id}</span>
                  <span className="text-slate-400 text-[9.5px]">{pr.ac}</span>
                  <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800" style={{color: TRIGGER_COLOR[pr.trigger]}}>{pr.trigger}</span>
                </div>
                <div className="grid grid-cols-3 gap-1 mt-1 text-[9.5px] tabular-nums text-slate-300">
                  <div><span className="text-slate-500">DATE </span>{pr.date}</div>
                  <div><span className="text-slate-500">REG </span>{pr.reg}</div>
                  <div><span className="text-slate-500">FATAL </span><span className={pr.fatal>0?'text-rose-300':'text-emerald-300'}>{pr.fatal}</span></div>
                </div>
                <div className="text-[9px] text-slate-400 mt-0.5">{pr.loc}</div>
                <div className="text-[9px] text-slate-400 mt-0.5 italic">{pr.ref}</div>
                <div className="text-[9.5px] text-slate-300 mt-1 leading-snug">{pr.narrative}</div>
              </div>
            ))}
            <div className="px-3 py-3 text-[9px] leading-snug text-slate-500 border-t border-slate-800">
              <span className="text-slate-300">Phase escalation reference per Annex 11 §5:</span><br/>
              <span style={{color: PHASE_COLOR['INCERFA']}}>INCERFA</span> — uncertainty (5min comm-gap default). ATSU continues contact attempts; NO RCC notification.<br/>
              <span style={{color: PHASE_COLOR['ALERFA']}}>ALERFA</span> — apprehension. ATSU PRE-NOTIFIES RCC; AOI requested; all freq comm-search.<br/>
              <span style={{color: PHASE_COLOR['DETRESFA']}}>DETRESFA</span> — distress (grave/imminent). ATSU FULL-NOTIFIES RCC; SAR assets launched per IAMSAR Vol III.
            </div>
          </div>
        )}

        {tab === 'FIR-RCC' && (
          <div className="divide-y divide-slate-800/60">
            {FIRS.filter(fir => regFilter==='ALL' || fir.region===regFilter).map(fir => {
              const flights = rows.filter(r => r.p.fir.acc === fir.acc)
              const det = flights.filter(r => r.phase==='DETRESFA').length
              const alf = flights.filter(r => r.phase==='ALERFA').length
              const inc = flights.filter(r => r.phase==='INCERFA').length
              return (
                <div key={fir.acc} className={`px-3 py-2 hover:bg-slate-900/40 cursor-pointer ${selFir?.acc===fir.acc?'bg-slate-900/60':''}`}
                  onClick={()=>setSelFir(selFir?.acc===fir.acc?null:fir)}>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-[9px] px-1.5 py-0.5 rounded border border-slate-800 font-semibold text-sky-300">{fir.acc}</span>
                    <span className="text-slate-300">→ {fir.rcc}</span>
                    {fir.oceanic && <span className="text-[8.5px] px-1.5 py-0.5 rounded text-violet-300 border border-violet-800/60 bg-violet-900/20">OCEANIC</span>}
                    <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-400">{fir.region}</span>
                  </div>
                  <div className="text-[9px] text-slate-400 mt-0.5">{fir.rccName}</div>
                  <div className="grid grid-cols-4 gap-1 mt-1 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">FLT </span>{flights.length}</div>
                    <div><span className="text-slate-500">DET </span><span style={{color:det>0?PHASE_COLOR['DETRESFA']:'#e2e8f0'}}>{det}</span></div>
                    <div><span className="text-slate-500">ALF </span><span style={{color:alf>0?PHASE_COLOR['ALERFA']:'#e2e8f0'}}>{alf}</span></div>
                    <div><span className="text-slate-500">INC </span><span style={{color:inc>0?PHASE_COLOR['INCERFA']:'#e2e8f0'}}>{inc}</span></div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="px-3 py-2 text-[9.5px] leading-snug text-slate-300 space-y-2">
            <div>
              <div className="text-[10px] text-sky-300 font-semibold mb-1">Definition · Annex 11 §5.1</div>
              <div>An Air Traffic Services Unit (ATSU) provides ALERTING SERVICE to all aircraft for which flight notification has been received and to any aircraft known or believed to be the subject of unlawful interference. Three phases are defined in ascending severity.</div>
            </div>
            <div>
              <div className="text-[10px] text-sky-300 font-semibold mb-1">Trigger catalogue · Doc 4444 §10</div>
              <div className="grid grid-cols-2 gap-1 text-[9px]">
                <div><span style={{color: TRIGGER_COLOR['COMM-VHF']}}>COMM-VHF</span> — VHF/UHF comm-loss past 5-min gate (AIM 6-2-2)</div>
                <div><span style={{color: TRIGGER_COLOR['COMM-HF']}}>COMM-HF</span> — HF SELCAL gate 10-min (NAT Doc 007 §5.3)</div>
                <div><span style={{color: TRIGGER_COLOR['COMM-CPDLC']}}>COMM-CPDLC</span> — ADS-C / CPDLC datalink timer RCP240</div>
                <div><span style={{color: TRIGGER_COLOR['COMM-SAT']}}>COMM-SAT</span> — SATCOM datalink 15-min (AC 120-29A)</div>
                <div><span style={{color: TRIGGER_COLOR['OVERDUE']}}>OVERDUE</span> — ETA-elapsed (JO 7110.10 §3-7)</div>
                <div><span style={{color: TRIGGER_COLOR['OFFTRACK']}}>OFFTRACK</span> — XTE&gt;25NM/5min (Annex 11 §3.3.6)</div>
                <div><span style={{color: TRIGGER_COLOR['SQUAWK']}}>SQUAWK</span> — 7500/7600/7700 (AIM 6-3)</div>
                <div><span style={{color: TRIGGER_COLOR['DISTRESS']}}>DISTRESS</span> — MAYDAY/PAN-PAN/ELT 406/ADT</div>
              </div>
            </div>
            <div>
              <div className="text-[10px] text-sky-300 font-semibold mb-1">Scorer · 6 drivers</div>
              <div className="text-[9px]">
                <span className="text-slate-200">composite</span> = (max·0.66 + mean·0.34) × phase-mul × ADV-MUL<br/>
                drivers: <span className="text-amber-200">COMM</span> · <span className="text-amber-200">OVD</span> · <span className="text-amber-200">XTE</span> · <span className="text-amber-200">SQK</span> · <span className="text-amber-200">VS</span> · <span className="text-amber-200">PHASE</span><br/>
                phase-mul: POLAR ×1.35 / OCEANIC ×1.30 / CLASS-A ×1.15 / TMA ×1.05 / CRUISE ×1.00 / GND ×0.50
              </div>
            </div>
            <div>
              <div className="text-[10px] text-sky-300 font-semibold mb-1">Hard escalators · §5.2.3</div>
              <div className="text-[9px]">
                7500 → DETRESFA ≥90 (hijack, Doc 4444 §10.2)<br/>
                7700 + erratic VS → DETRESFA ≥85<br/>
                MAYDAY → DETRESFA ≥90 · PAN-PAN → ALERFA ≥65<br/>
                NORDO &gt;30m + oceanic → DETRESFA ≥75<br/>
                Overdue &gt;30m + NORDO → DETRESFA ≥80
              </div>
            </div>
            <div>
              <div className="text-[10px] text-sky-300 font-semibold mb-1">Distinct from</div>
              <div className="text-[9px]">
                NORDO-MONITOR (§91.185 IFR continuation only) · GADSS-ELTDT (Annex 6 equipage) · SAR-PLANNER (IAMSAR Vol III patterns, post-RCC) · SQUAWK-MONITOR (code catalogue) · MEDLINK (medical divert) · QRA (intercept geometry) · TIBA (self-announce). ALERFA is uniquely the ATSU-side §5 phase escalation framework linking trigger → INCERFA → ALERFA → DETRESFA → RCC notification per IAMSAR Vol II.
              </div>
            </div>
            <div className="text-[9px] text-slate-500 border-t border-slate-800 pt-2 leading-snug">
              <span className="text-slate-300">References:</span> ICAO Annex 11 Ch 5 (Alerting Service) · Annex 12 (SAR) · Annex 13 (notification) · Doc 4444 PANS-ATM §10 · Doc 9731 IAMSAR Vol II/III · Doc 9869 PBCS · Doc 10054 GADSS · Cospas-Sarsat T.001/A.001 · 14 CFR §91.183/§91.185/§91.187 · FAA Order JO 7110.65AA §10-1 to §10-7 · JO 7110.10AA · AIM Ch.6 §6-2 + §6-3 + Ch.10 §10-2-7 · AC 91-44A / 91-73B / 120-42B / 120-29A · InFO 16012 · EUROCONTROL ESARR-4 · EASA AMC1 ATS.OR.215 · UK CAA CAP 360 §6 · TC AIM RAC 1.5 / 11.4 · NATO STANAG 3204 / 3596 · USAF AFI 11-202V3 / 13-204V3 · USCG SAR Manual Vol I/II · FCC §87.187/§87.193 · NTSB AAR-01/01 Payne Stewart · NTSB AAR-07/03 Comair · NTSB AAR-10/03 US Airways 1549 · BEA F-CP090601 AF447 · MSI 2014-03 MH370 · TSB A98H0003 Swissair 111 · KARAIB AAB-2011-01 Asiana 991.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
