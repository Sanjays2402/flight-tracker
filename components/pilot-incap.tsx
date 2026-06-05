'use client'
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   PINCAP · Pilot-Incapacitation / Two-Person-Cockpit-Rule /
            Locked-Door & Sole-Pilot Continuity Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of the human-on-the-loop side
   of two-crew flight-deck operations, specifically:

     (a) two-person-cockpit-rule policy compliance — the
         operator-level requirement that whenever one pilot
         leaves the flight deck, a second qualified crew
         member (typically the senior cabin attendant)
         must enter and remain on the flight deck so a
         single-occupant cockpit is never possible during
         flight, originating in the EASA SIB 2015-04 / FAA
         SAFO 15006 response to Germanwings 9525 (D-AIPX,
         Barcelonnette 2015-03-24, 150 fatal, BEA Final
         2016-03-13) and revised by EASA SIB 2016-09 +
         AAIB AAR-2017-05 to operator-discretion based
         on operator safety-case;

     (b) cockpit-access-denial dwell time — the locked
         armoured-door rejection-loop state under RTCA
         DO-329 / EUROCAE ED-198 + 14 CFR §25.795(a)
         intrusion-resistant flight-deck door spec
         (post-9/11 hardening per US PL-107-71 ATSA
         §104 + ICAO Annex 6 Pt I §13.2.2 +
         EASA AMC 25.795), with door-access dwell-time
         >5 min triggering "denied entry" Cat-A escalation
         (Germanwings precedent: 7 min 39 s denied);

     (c) sole-pilot interval risk — the dwell time during
         which only one pilot is in the flight deck (the
         other on a lavatory break or rest-trip per
         augmented-crew §117.17 / EASA ORO.FTL.205(e)) and
         the per-second probability that the remaining
         pilot experiences a SUBTLE (silent, partial) or
         OVERT (sudden, complete) incapacitation event
         per Mitchell-Evans BMJ 2004 epidemiology
         (∼1 medically-significant event per 4M flight-h
         for Class-1 fit ATPL) extended by Caldwell SAFTE
         fatigue-elevation factor;

     (d) subtle-incapacitation cue scoring — synthetic
         observation of flightpath-deviation rate (|Δh|
         > 100 ft/min off-FMS, |Δtrack| > 5°/min off-LNAV),
         no-input-detected timer (autoflight in command
         but no SP-side stick/wheel/pedal input registered
         for ≥120 s during below-FL100 / hand-flying
         phases per FAA SAFO 17007 dual-pilot vigilance
         protocol), autopilot mode-reversion without
         acknowledgement (Boeing FCOM PR 9.20 / Airbus
         FCTM PRO-NOR-SOP-15 acknowledge any mode change),
         and silence-on-frequency dwell (no read-back of
         ATC instruction within 30 s — ICAO Annex 10
         Vol II §5.2.1.4.1.1 / Doc 9432 read-back
         requirement);

     (e) MAYDAY-PAN-INCAP downlink readiness — whether
         the airframe has a CPDLC FANS-1A+ link active,
         a SELCAL HF-uplink to ARINC/AFTN, and an
         ACARS UTC-keyed crew-status downlink path per
         Boeing FCOM CHAP 17 / Airbus FCTM PRO-COM-50
         so that the surviving pilot (or the cabin-crew
         relay via the IDU) can transmit a MAYDAY-PAN
         within the 60 s ICAO Annex 10 Vol II §5.3.1
         emergency-broadcast window.

   ------------------------------------------------------------
   Structurally DISTINCT from sibling monitors:
     CIRCAD-FATIGUE   — chronobiology / WOCL / SAFTE only.
                        Does not score the
                        seat-occupancy / locked-door domain.
     CREW-DUTY        — FAR-117 FDP/duty-time accounting
                        (regulatory book-keeping, not
                        real-time vigilance).
     TUC-HYPOXIA      — physiological time-of-useful-
                        consciousness post-decompression
                        only.
     MEDLINK-DIVERSION— passenger medical emergency
                        diversion planner (not crew).
     VESTI-SPATIAL    — somatogravic / somatogyral
                        disorientation regime.
     SCRM-STERILE     — sterile-cockpit rule below 10k ft
                        non-essential conversation only.
     COCKPIT-HUD      — symbology layer; does not score
                        the human occupant.
     EFB-MONITOR      — electronic-flight-bag chart-data
                        currency only.

   PINCAP uniquely sits at the FLIGHT-DECK OCCUPANCY +
   LOCKED-DOOR + INCAPACITATION-CUE + MAYDAY-DOWNLINK
   intersection, the Germanwings-9525 / Helios-522 /
   Mozambique-LAM-470 problem class.

   ------------------------------------------------------------
   12-class crew-policy catalogue (cls · pilots · two-person · door-spec · refs):

     NB-DOM-US   2P  REQ      DO-329  FAR §121.587/.587 + ATSA §104
     NB-INT-US   2P  REQ      DO-329  FAA SAFO 15006 + Pt 121
     NB-EU       2P  OP-DISC  ED-198  EASA SIB 2016-09 op-discretion
     WB-MED      2P  OP-DISC  ED-198  EASA SIB 2016-09 / AAIB AAR-2017-05
     WB-LH-3P    3P  REQ      DO-329  §117.17 + cabin-attendant relief
     WB-ULR-4P   4P  REQ      DO-329  §117.19 + crew-rest module
     RGN-J       2P  OP-DISC  ED-198  CAT.OP.MPA.260
     TURBO       2P  OP-DISC  ED-198  CS-FCD App.1
     BIZ         2P  WAIVED   BASIC   NBAA OAM 2018 § Door
     CARGO-LH-3P 3P  N/A      DO-329  no cabin attendant — N/A
     HEMS        1-2P NONE    NONE    Pt 135 single-pilot exempt
     LIGHT       1P  N/A      NONE    Pt 91 single-pilot N/A

   ------------------------------------------------------------
   Per-flight synthetic state model (deterministic FNV-1a
   hash on icao24 + day-seed, matching post-2015 SOP +
   Mitchell-Evans incapacitation epidemiology):

     occupancyState:   BOTH (88%) / SINGLE-LAV (8%) /
                       SINGLE-REST (3.5%) / EMPTY-LOCKED
                       (0.5%) — gated by class
     doorState:        SECURED (94%) / GRANTED (3%) /
                       DENIED-RING (2.5%) / OVERRIDE (0.5%)
     accessDwellS:     0..480 s within doorState window
     soleDwellS:       0..1800 s within SINGLE-LAV
     noInputDwellS:    0..600 s no-SP-input timer
     deviationRate:    0..600 ft/min from desired path
     trackDeviation:   0..25 °/min off-LNAV
     ackMissedCount:   0..6 mode-reversions without ack
     freqSilenceS:     0..120 s no-readback
     mayLinkClass:     CPDLC-SELCAL-ACARS / SELCAL-ACARS /
                       ACARS-ONLY / NONE
     mayDownlinkOK:    1 / 0
     pilotFitnessP:    per-event probability adjusted by
                       per-icao24 fatigue-mul (CIRCAD bridge)

   ------------------------------------------------------------
   8 phase classes with phase-weight per criticality:
     TKO-INI        below 1500 ft AGL VS>+800 fpm   1.30
     CLIMB          1500-10000 ft VS>+400 fpm        1.10
     CRUISE         above FL280 |VS|<300            1.00 (lav-trip peak)
     STEP-CLIMB     |VS|>500 fpm at FL280-410        0.95
     DESCENT        VS<-400 fpm above 10000          1.05
     APPR-INT       below 10000 VS<-200 fpm          1.20
     APPR-FNL       below 3000 VS<-300 fpm           1.40
     GROUND         on-ground 0.30 / lav-trip ok    0.40

   ------------------------------------------------------------
   8 risk drivers (max·0.62 + mean·0.38) × phase-w × ADV-MUL:
     OCC      occupancy-state penalty (BOTH=0 / SINGLE-LAV=22
              / SINGLE-REST=14 / EMPTY-LOCKED=100)
     DWELL    sole-pilot dwell-seconds ramp 0→100 over
              0..600 s (Mitchell-Evans 4M-h baseline)
     DOOR     access-dwell ramp 0→100 over 0..480 s
              (Germanwings 459 s precedent ≥ 92)
     CUES     subtle-incap cues composite (deviation +
              track-Δ + no-input + ackMissed) summed
     FREQ     frequency-silence ramp 0→100 over 0..120 s
              past-due readback (ICAO Annex 10 §5.2.1.4.1.1)
     POLICY   two-person-rule policy gap × current single-
              occupancy: REQ + SINGLE → 60 / WAIVED → 0
     DOWN     MAYDAY-downlink readiness gap (NONE → 100 /
              ACARS-ONLY → 55 / SELCAL-ACARS → 25 /
              CPDLC-SELCAL-ACARS → 0)
     FAT      bridge to CIRCAD fatigue effectiveness deficit
              (E/100 inverted)

   ------------------------------------------------------------
   Hard escalators (score-min):
     (a) doorState=DENIED-RING + accessDwell ≥ 459 s + 2P
         class       → 96 GERMANWINGS-MODE Cat-A immediate
                        EASA SIB 2015-04 escalation pathway
     (b) occ=EMPTY-LOCKED any phase          → 95 Cat-A
                        flight-deck unoccupied — autopilot
                        sole controller per LAM-TM 470
                        2013 precedent
     (c) DENIED-RING + accessDwell ≥ 120 s   → 84 RING-
                        DENIED locked-out repeat-call SOP
     (d) SINGLE-LAV + DWELL ≥ 480 s + CRUISE → 72 over-
                        the-recommended-15-min toilet
                        break per Boeing FCOM PR 9.10
     (e) CUES composite ≥ 60 in APPR-INT/FNL → 78 subtle-
                        incap likely brief takeover per
                        FAA SAFO 17007 + Helios 522 precedent
     (f) FREQ silence ≥ 45 s in APPR-FNL     → 60 readback
                        overdue per Annex 10 §5.2.1.4.1.1

   ------------------------------------------------------------
   6 tiers:
     GW-MODE      ≥85 rose      Germanwings-mode — Cat-A
                                 escalation flightpath-protection
     LOCKED-OUT   ≥65 rose-pink Door rejection ring active
                                 repeat-call cabin-crew alert
     SUB-INCAP    ≥45 amber     Subtle incapacitation cues
                                 brief takeover protocol
     SOLO-WATCH   ≥22 sky       Single-pilot dwell exceeds
                                 prudent envelope monitor
     NOMINAL     <22 emerald   Two-pilot vigilant flight-deck
     OFF         on-ground / single-pilot-aircraft slate

   ------------------------------------------------------------
   MapLibre overlay (5 layers):
     pincap-halo   tier-coloured ring 7-19 px score-sized
     pincap-pin    GW-MODE / LOCKED-OUT rose pin
     pincap-door   dashed-rose orbit ring (60 px) on
                   DENIED-RING + accessDwell>120 s
                   showing locked-out cabin-crew presence
     pincap-vec    dashed forward subtle-incap deviation
                   vector along track (length proportional
                   to CUES composite × phase-w × 0.05 km)
     pincap-lbl    callsign · class · OCC · DWELL · TIER

   ------------------------------------------------------------
   Side panel:
     6-tier counter strip (click-to-filter ALL)
     5-cell summary: μ-SCORE / GW-cnt / LOCK-cnt /
                     SOLO-cnt / WORST-cs
     4 sliders: ADV-MUL 50-200% / SOLO-FLOOR 60-600 s
                / CUE-MUL 50-200% / DOOR-MUL 50-200%
     8-phase chip filter + 12-class chip filter
     5 toggles: HALO / PIN / DOOR / VEC / LBL
     search: callsign / type / operator / class
     4-tab switcher:
       AIRCRAFT — per-airframe row stack (tier-worst-first)
                  with cs + type + class-pill + phase-pill
                  + tier-pill + OCC-pill + DOOR-pill +
                  DWELL/CUES/FREQ row + 8-driver chips +
                  tier-coloured advice line citing reg+SOP
       SYSTEMS  — per-class equipment / occupancy SOP /
                  door-spec / downlink-class with fleet
                  μ-SCORE + GW-cnt + LOCK-cnt counters
                  + ICAO/SAFO citation note
       DRIVERS  — 8-driver fleet-mean breakdown bars +
                  per-driver description + phase-weight
                  card 8-phase × phase-w + Mitchell-Evans
                  epidemiology rate table + Helios/LAM
                  precedent narrative
       PRECEDENT — Six canonical case studies (Germanwings
                  9525 / Helios 522 / LAM 470 / Egypt
                  990 / Silk Air 185 / Continental 1404)
                  with one-paragraph narrative each plus
                  per-driver attribution rosette

   ------------------------------------------------------------
   References:
     EASA SIB 2015-04 "Minimum Cockpit Occupancy" 2015-03-27
     EASA SIB 2016-09 rev op-discretion two-person rule
     FAA SAFO 15006 "Minimum Flight-Deck Occupancy" 2015-04
     FAA SAFO 17007 "Pilot-Vigilance Risk Mitigation" 2017
     ICAO Annex 6 Pt I §13.2.2 Flight Deck Security Door
     ICAO Annex 10 Vol II §5.2.1.4.1.1 Read-Back
     ICAO Annex 10 Vol II §5.3.1 Emergency Communications
     ICAO Doc 9432 Manual of Radiotelephony 4th ed.
     ICAO Doc 9985 ATM Security Manual §3.4
     ICAO Doc 9966 FRMS App.B Fatigue & Vigilance
     14 CFR §25.795(a) Intrusion-Resistant Flight-Deck Door
     14 CFR §121.587 Flight-Deck Admission
     14 CFR §121.583 Persons Admitted to Flight-Deck
     14 CFR §121.629 Operations in Icing (collateral)
     14 CFR §91.105 Flight Crewmember at Stations
     14 CFR §117.17 / §117.19 Augmented-Crew Rest
     14 CFR §135.99 (HEMS single-pilot)
     US PL-107-71 ATSA §104 Cockpit Door Hardening
     EASA AMC 25.795(a) Intrusion-Resistant Doors
     EASA CS-25.795 Cockpit Door
     EASA AMC1 ORO.SEC.100 Operator Security Programme
     RTCA DO-329 / EUROCAE ED-198 Cockpit-Door Mon Sys
     RTCA DO-258A CPDLC FANS-1A+
     ARINC 741 SATCOM Voice
     ARINC 596 SELCAL
     UK CAA CAP 715 §3 Cockpit Door Security
     TC AC 705-001 §6 Flight Deck Admission
     CASA CAO 20.18 §10 Flight Deck Security
     IATA SeMS ed.5 §4 Onboard Security
     IATA Cabin Operations Safety Best Practices §6 Door
     Boeing FCOM Vol 1 §17 Cockpit-Door System
     Boeing FCTM Ch 3 §3.20 Crew Coordination /
            Two-Person Rule annotation post-2015
     Boeing FCOM PR 9.10 Lavatory-Trip Procedure
     Boeing FCOM PR 9.20 Mode-Reversion Acknowledgement
     Boeing FCOM CHAP 17 Datalink (ACARS/CPDLC/SATCOM)
     Airbus FCOM DSC-25 Cockpit Door System
     Airbus FCTM PRO-NOR-SOP-15 Mode-Awareness Callouts
     Airbus FCTM PRO-COM-50 Datalink Comms
     Airbus FCTM PRO-SUP-91 Pilot Incapacitation
     Airbus FCOM PRO-ABN-MISC Pilot Incapacitation drill
     Embraer AOM §03 Cockpit Door & Two-Crew Rule
     Bombardier CRJ/Global FCOM §16 Cockpit Door
     BEA Final Report Germanwings 9525 D-AIPX 2016-03-13
        ("Final Report on the accident on 24 March 2015")
     AAIB Helios 522 5B-DBY 2005-08-14 AAR-11/2006
     CIAIM Mozambique LAM 470 C9-EMC 2013-11-29 ATSB-final
     NTSB EgyptAir 990 SU-GAP 1999-10-31 AAR-02/01
     Silk Air 185 9V-TRF 1997-12-19 NTSC final
     NTSB CO-1404 N18611 2008-12-20 DCA09MA021
     Mitchell SJ, Evans AD. "Cardiovascular Incapacitation
        of Airline Pilots" BMJ 2004;329:1235
     Caldwell JA Aviation Space Environ Med 80-1 2009
     Bennett SA "Pilot Incapacitation" Routledge 2018 Ch.4
     Veillette PR FlightSafety Foundation AeroSafetyWorld
        2015-06 "After Germanwings"
     Lufthansa Group OM-A 2018-05 Two-Person Rule withdrawn
        with operator safety case
     Eurocontrol Voluntary ATM Incident Reporting (EVAIR)
        2019 Annual Report — Subtle Incapacitation chapter
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
}
interface Props {
  map: maplibregl.Map | null
  flights: SFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Cls =
  | 'NB-DOM-US' | 'NB-INT-US' | 'NB-EU' | 'WB-MED'
  | 'WB-LH-3P' | 'WB-ULR-4P' | 'RGN-J' | 'TURBO'
  | 'BIZ' | 'CARGO-LH-3P' | 'HEMS' | 'LIGHT'

const CLS_COLOR: Record<Cls, string> = {
  'NB-DOM-US':   '#10b981',
  'NB-INT-US':   '#22d3ee',
  'NB-EU':       '#0ea5e9',
  'WB-MED':      '#38bdf8',
  'WB-LH-3P':    '#a855f7',
  'WB-ULR-4P':   '#f43f5e',
  'RGN-J':       '#f59e0b',
  'TURBO':       '#eab308',
  'BIZ':         '#ec4899',
  'CARGO-LH-3P': '#fb923c',
  'HEMS':        '#dc2626',
  'LIGHT':       '#a3e635',
}

type TwoP = 'REQ' | 'OP-DISC' | 'WAIVED' | 'N/A' | 'NONE'
type DoorSpec = 'DO-329' | 'ED-198' | 'BASIC' | 'NONE'
type DownClass = 'CPDLC-SELCAL-ACARS' | 'SELCAL-ACARS' | 'ACARS-ONLY' | 'NONE'

interface ClsSpec {
  cls: Cls
  pilots: number
  twoP: TwoP
  doorSpec: DoorSpec
  downClass: DownClass
  refs: string
}
const SPECS: ClsSpec[] = [
  { cls:'NB-DOM-US',   pilots:2, twoP:'REQ',     doorSpec:'DO-329', downClass:'SELCAL-ACARS',         refs:'FAR §121.587 + ATSA §104'      },
  { cls:'NB-INT-US',   pilots:2, twoP:'REQ',     doorSpec:'DO-329', downClass:'CPDLC-SELCAL-ACARS',   refs:'SAFO 15006 + Pt 121'           },
  { cls:'NB-EU',       pilots:2, twoP:'OP-DISC', doorSpec:'ED-198', downClass:'SELCAL-ACARS',         refs:'EASA SIB 2016-09 op-disc'      },
  { cls:'WB-MED',      pilots:2, twoP:'OP-DISC', doorSpec:'ED-198', downClass:'CPDLC-SELCAL-ACARS',   refs:'SIB 2016-09 / AAIB AAR-2017-05'},
  { cls:'WB-LH-3P',    pilots:3, twoP:'REQ',     doorSpec:'DO-329', downClass:'CPDLC-SELCAL-ACARS',   refs:'§117.17 augmented + ICAO 9966' },
  { cls:'WB-ULR-4P',   pilots:4, twoP:'REQ',     doorSpec:'DO-329', downClass:'CPDLC-SELCAL-ACARS',   refs:'§117.19 ULR + 4-pilot rest'    },
  { cls:'RGN-J',       pilots:2, twoP:'OP-DISC', doorSpec:'ED-198', downClass:'ACARS-ONLY',           refs:'CAT.OP.MPA.260 / Pt 121 rgn'   },
  { cls:'TURBO',       pilots:2, twoP:'OP-DISC', doorSpec:'ED-198', downClass:'ACARS-ONLY',           refs:'EASA CS-FCD App.1 / CAR 705'   },
  { cls:'BIZ',         pilots:2, twoP:'WAIVED',  doorSpec:'BASIC',  downClass:'ACARS-ONLY',           refs:'NBAA OAM 2018 §Door (waived)'  },
  { cls:'CARGO-LH-3P', pilots:3, twoP:'N/A',     doorSpec:'DO-329', downClass:'CPDLC-SELCAL-ACARS',   refs:'no cabin attendant — N/A'      },
  { cls:'HEMS',        pilots:1, twoP:'NONE',    doorSpec:'NONE',   downClass:'ACARS-ONLY',           refs:'Pt 135 single-pilot HEMS exempt' },
  { cls:'LIGHT',       pilots:1, twoP:'N/A',     doorSpec:'NONE',   downClass:'NONE',                 refs:'Pt 91 single-pilot N/A'        },
]
const SPEC_BY_KEY: Record<Cls, ClsSpec> = Object.fromEntries(SPECS.map(s => [s.cls, s])) as any

function clsFromFlight(f: SFlight): Cls {
  const t = (f.type || '').toUpperCase()
  const op = (f.operator || '').toUpperCase()
  const cs = (f.callsign || '').toUpperCase()
  if (op.includes('MEDFLIGHT') || op.includes('LIFENET') || op.includes('REACH') || cs.startsWith('MED')) return 'HEMS'
  if (op.includes('FEDEX') || op.includes('UPS') || op.includes('CARGOLUX') || op.includes('ATLAS')
      || op.includes('KALITTA') || cs.startsWith('FDX') || cs.startsWith('UPS')
      || cs.startsWith('GTI') || cs.startsWith('CLX') || cs.startsWith('CKS')) return 'CARGO-LH-3P'
  if (op.includes('NETJET') || op.includes('FLEXJET') || op.includes('VISTAJET')
      || cs.startsWith('EJA') || cs.startsWith('LXJ') || cs.startsWith('VJT')) return 'BIZ'
  if (t.startsWith('GLEX') || t.startsWith('G650') || t.startsWith('GLF')
      || t.startsWith('FA') || t.startsWith('CL6') || t.startsWith('CL30')
      || t.startsWith('E55P') || t.startsWith('C25') || t.startsWith('C56') || t.startsWith('C68')
      || t.startsWith('PC12') || t.startsWith('PC24')) return 'BIZ'
  if (t.startsWith('EC') || t.startsWith('H1') || t.startsWith('H4') || t.startsWith('AS3')
      || t.startsWith('AW') || t.startsWith('S76') || t.startsWith('S92')
      || t.startsWith('R44') || t.startsWith('R66') || t.startsWith('UH60')) return 'HEMS'
  if (t.startsWith('AT') || t.startsWith('DH8') || t === 'DHC8' || t.startsWith('SF3')) return 'TURBO'
  if (t.startsWith('E17') || t.startsWith('E19') || t.startsWith('CRJ')
      || t === 'CRJ2' || t === 'CRJ7' || t === 'CRJ9') return 'RGN-J'
  if (t === 'B748' || t === 'A388' || t === 'B77W' || t === 'B789' || t === 'A35K') {
    // ULR-likely
    if (cs.startsWith('UAL') || cs.startsWith('SIA') || cs.startsWith('QFA')
        || cs.startsWith('UAE') || cs.startsWith('QTR') || cs.startsWith('ANA')) return 'WB-ULR-4P'
    return 'WB-LH-3P'
  }
  if (t === 'B772' || t === 'B788' || t === 'B78X' || t === 'A359'
      || t === 'A332' || t === 'A333' || t === 'A339' || t === 'B763' || t === 'B764') return 'WB-MED'
  if (t.startsWith('A31') || t.startsWith('A32') || t.startsWith('A20') || t.startsWith('A21')
      || t.startsWith('BCS') || t === 'B38M' || t === 'B39M' || t.startsWith('B73')) {
    // US vs EU narrow split — use callsign-hash + operator hint
    if (op.includes('AMERICAN') || op.includes('DELTA') || op.includes('UNITED')
        || op.includes('SOUTHWEST') || op.includes('ALASKA') || op.includes('JETBLUE')
        || cs.startsWith('AAL') || cs.startsWith('DAL') || cs.startsWith('UAL')
        || cs.startsWith('SWA') || cs.startsWith('ASA') || cs.startsWith('JBU')) {
      // narrow US — domestic vs international by callsign-hash
      let h = 0; for (let i = 0; i < cs.length; i++) h = ((h << 5) - h + cs.charCodeAt(i)) | 0
      return ((h >>> 0) % 100) < 72 ? 'NB-DOM-US' : 'NB-INT-US'
    }
    return 'NB-EU'
  }
  if (t.startsWith('C17') || t.startsWith('K35') || t.startsWith('C5')) return 'CARGO-LH-3P'
  if (t.startsWith('C172') || t.startsWith('C152') || t.startsWith('PA28') || t.startsWith('SR22')) return 'LIGHT'
  return 'NB-EU'
}

// FNV-1a 32-bit with day-seed (one synthetic state per icao24 per UTC day)
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}
function rng(seed: number) {
  let s = (seed | 0) || 1
  return () => {
    s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)
    s = (s ^ (s >>> 16)) >>> 0
    return (s & 0xffffffff) / 0x100000000
  }
}

type Occ = 'BOTH' | 'SINGLE-LAV' | 'SINGLE-REST' | 'EMPTY-LOCKED'
type DoorS = 'SECURED' | 'GRANTED' | 'DENIED-RING' | 'OVERRIDE'

interface SynthState {
  occ: Occ
  door: DoorS
  accessDwellS: number
  soleDwellS: number
  noInputDwellS: number
  deviationRate: number     // ft/min off-FMS
  trackDevDegMin: number    // °/min off-LNAV
  ackMissed: number
  freqSilenceS: number
  fitnessFactor: number     // 0.8-1.3 from per-icao24 fatigue
}

function synth(f: SFlight, spec: ClsSpec): SynthState {
  const day = Math.floor(Date.now() / 86400000)
  const seed = fnv1a(`${f.icao}|${day}|pincap`) ^ 0xdeadbeef
  const r = rng(seed)

  // Occupancy gated by class
  const u = r()
  let occ: Occ = 'BOTH'
  if (spec.pilots === 1) occ = 'BOTH' // single-pilot always BOTH-equivalent (no two-person concept)
  else if (spec.twoP === 'N/A' || spec.twoP === 'WAIVED') {
    // freighter / biz — lav-trips more frequent (no cabin attendant relay)
    if (u < 0.78) occ = 'BOTH'
    else if (u < 0.94) occ = 'SINGLE-LAV'
    else if (u < 0.998) occ = 'SINGLE-REST'
    else occ = 'EMPTY-LOCKED'
  } else {
    if (u < 0.88) occ = 'BOTH'
    else if (u < 0.96) occ = 'SINGLE-LAV'
    else if (u < 0.995) occ = 'SINGLE-REST'
    else occ = 'EMPTY-LOCKED'
  }

  // Door state, weighted by occupancy
  const u2 = r()
  let door: DoorS
  if (occ === 'BOTH') {
    door = u2 < 0.96 ? 'SECURED' : (u2 < 0.99 ? 'GRANTED' : 'DENIED-RING')
  } else if (occ === 'EMPTY-LOCKED') {
    door = u2 < 0.85 ? 'DENIED-RING' : 'OVERRIDE'
  } else {
    if (u2 < 0.62) door = 'SECURED'
    else if (u2 < 0.85) door = 'GRANTED'
    else if (u2 < 0.99) door = 'DENIED-RING'
    else door = 'OVERRIDE'
  }

  // Dwell times
  let accessDwellS = 0
  if (door === 'GRANTED') accessDwellS = Math.floor(2 + r() * 14)
  else if (door === 'DENIED-RING') accessDwellS = Math.floor(8 + r() * 480)
  else if (door === 'OVERRIDE') accessDwellS = Math.floor(45 + r() * 90)

  let soleDwellS = 0
  if (occ === 'SINGLE-LAV') soleDwellS = Math.floor(30 + r() * 540)
  else if (occ === 'SINGLE-REST') soleDwellS = Math.floor(120 + r() * 1680)
  else if (occ === 'EMPTY-LOCKED') soleDwellS = Math.floor(60 + r() * 360)

  // No-input dwell (autoflight active but no pilot input)
  let noInputDwellS = Math.floor(r() * 60)
  if (occ !== 'BOTH') noInputDwellS = Math.floor(20 + r() * 480)

  // Deviation rate (mostly 0; small bias upward in non-BOTH states)
  let deviationRate = Math.floor(r() * 30)
  if (occ === 'EMPTY-LOCKED') deviationRate = Math.floor(120 + r() * 480)
  else if (occ !== 'BOTH' && r() < 0.18) deviationRate = Math.floor(60 + r() * 240)

  let trackDevDegMin = Math.floor(r() * 3)
  if (occ === 'EMPTY-LOCKED') trackDevDegMin = Math.floor(4 + r() * 18)
  else if (occ !== 'BOTH' && r() < 0.12) trackDevDegMin = Math.floor(2 + r() * 8)

  // ACK missed
  let ackMissed = 0
  if (r() < 0.05) ackMissed = 1
  if (occ !== 'BOTH' && r() < 0.22) ackMissed = Math.min(6, ackMissed + 1 + Math.floor(r() * 3))

  // Frequency silence
  let freqSilenceS = Math.floor(r() * 18)
  if (occ === 'EMPTY-LOCKED') freqSilenceS = Math.floor(40 + r() * 80)
  else if (occ !== 'BOTH' && r() < 0.20) freqSilenceS = Math.floor(15 + r() * 60)

  // Fitness factor (CIRCAD bridge proxy)
  const fitnessFactor = 0.8 + r() * 0.5

  return { occ, door, accessDwellS, soleDwellS, noInputDwellS, deviationRate, trackDevDegMin, ackMissed, freqSilenceS, fitnessFactor }
}

type Phase = 'TKO-INI' | 'CLIMB' | 'CRUISE' | 'STEP-CLIMB' | 'DESCENT' | 'APPR-INT' | 'APPR-FNL' | 'GROUND'
const PHASE_W: Record<Phase, number> = {
  'TKO-INI':1.30, CLIMB:1.10, CRUISE:1.00, 'STEP-CLIMB':0.95, DESCENT:1.05,
  'APPR-INT':1.20, 'APPR-FNL':1.40, GROUND:0.40,
}
function phaseOf(f: SFlight): Phase {
  if (f.ground) return 'GROUND'
  const fl = f.altitudeFt / 100
  if (f.altitudeFt < 1500 && f.vertRate > 800) return 'TKO-INI'
  if (fl < 100 && f.vertRate > 400) return 'CLIMB'
  if (fl >= 100 && fl < 280 && f.vertRate > 400) return 'CLIMB'
  if (f.altitudeFt < 3000 && f.vertRate < -300) return 'APPR-FNL'
  if (fl < 100 && f.vertRate < -200) return 'APPR-INT'
  if (fl >= 100 && f.vertRate < -400) return 'DESCENT'
  if (fl >= 280 && fl < 410 && Math.abs(f.vertRate) > 500) return 'STEP-CLIMB'
  return 'CRUISE'
}

interface Drivers {
  OCC: number; DWELL: number; DOOR: number; CUES: number
  FREQ: number; POLICY: number; DOWN: number; FAT: number
}

interface Calc {
  s: SynthState
  phase: Phase
  d: Drivers
  score: number
  hardLabel?: string
}

function compute(f: SFlight, spec: ClsSpec, advMul: number, soloFloor: number, cueMul: number, doorMul: number): Calc {
  const s = synth(f, spec)
  const phase = phaseOf(f)
  const pw = PHASE_W[phase]

  // Driver: OCC penalty
  const OCC = s.occ === 'BOTH' ? 0
           : s.occ === 'SINGLE-LAV' ? 22
           : s.occ === 'SINGLE-REST' ? 14
           : 100

  // DWELL: ramp 0→100 over 0..600 s sole-pilot
  const DWELL = Math.max(0, Math.min(100, (s.soleDwellS / 600) * 100))

  // DOOR: ramp 0→100 over 0..480 s
  let DOOR = (s.door === 'DENIED-RING' || s.door === 'OVERRIDE')
    ? Math.max(0, Math.min(100, (s.accessDwellS / 480) * 100))
    : (s.door === 'GRANTED' ? Math.min(8, s.accessDwellS) : 0)
  DOOR = DOOR * (doorMul / 100)

  // CUES: composite subtle-incap cues
  const cueDev   = Math.min(100, (s.deviationRate / 400) * 100)
  const cueTrack = Math.min(100, (s.trackDevDegMin / 15) * 100)
  const cueAck   = Math.min(100, s.ackMissed * 20)
  const cueNoIn  = Math.min(100, (s.noInputDwellS / 240) * 100)
  const CUES = Math.max(0, Math.min(100, ((cueDev * 0.32) + (cueTrack * 0.22) + (cueAck * 0.20) + (cueNoIn * 0.26)) * (cueMul / 100)))

  // FREQ silence
  const FREQ = Math.max(0, Math.min(100, (s.freqSilenceS / 120) * 100))

  // POLICY gap (only active in non-BOTH states + REQ-class)
  const POLICY = (spec.twoP === 'REQ' && s.occ !== 'BOTH') ? 60
              : (spec.twoP === 'OP-DISC' && s.occ !== 'BOTH') ? 30
              : 0

  // Downlink readiness gap
  const DOWN = spec.downClass === 'NONE' ? 100
            : spec.downClass === 'ACARS-ONLY' ? 55
            : spec.downClass === 'SELCAL-ACARS' ? 25
            : 0

  // FAT bridge (E_deficit = 100 − E_proxy)
  const fatE = Math.max(0, Math.min(120, 70 + (s.fitnessFactor - 1.05) * 60))
  const FAT = Math.max(0, Math.min(100, 100 - fatE))

  const d: Drivers = { OCC, DWELL, DOOR, CUES, FREQ, POLICY, DOWN, FAT }

  // Composite
  const arr = [OCC, DWELL, DOOR, CUES, FREQ, POLICY, DOWN, FAT]
  const maxD = Math.max(...arr)
  const meanD = arr.reduce((a, b) => a + b, 0) / arr.length
  let score = Math.max(0, Math.min(100, (maxD * 0.62 + meanD * 0.38) * pw * (advMul / 100)))

  // Hard escalators
  let hardLabel: string | undefined
  if (s.door === 'DENIED-RING' && s.accessDwellS >= 459 && spec.twoP === 'REQ') { score = Math.max(score, 96); hardLabel = 'GERMANWINGS-MODE' }
  if (s.occ === 'EMPTY-LOCKED') { score = Math.max(score, 95); hardLabel = hardLabel || 'EMPTY-LOCKED' }
  if (s.door === 'DENIED-RING' && s.accessDwellS >= 120) { score = Math.max(score, 84); hardLabel = hardLabel || 'RING-DENIED' }
  if (s.occ === 'SINGLE-LAV' && s.soleDwellS >= soloFloor && phase === 'CRUISE') { score = Math.max(score, 72); hardLabel = hardLabel || 'LAV-OVERRUN' }
  if (CUES >= 60 && (phase === 'APPR-INT' || phase === 'APPR-FNL')) { score = Math.max(score, 78); hardLabel = hardLabel || 'SUB-INCAP-APPR' }
  if (s.freqSilenceS >= 45 && phase === 'APPR-FNL') { score = Math.max(score, 60); hardLabel = hardLabel || 'READBACK-LATE' }

  return { s, phase, d, score, hardLabel }
}

type Tier = 'GW-MODE' | 'LOCKED-OUT' | 'SUB-INCAP' | 'SOLO-WATCH' | 'NOMINAL' | 'OFF'
const TIER_COLOR: Record<Tier, string> = {
  'GW-MODE':    '#ef4444',
  'LOCKED-OUT': '#f43f5e',
  'SUB-INCAP':  '#f59e0b',
  'SOLO-WATCH': '#0ea5e9',
  NOMINAL:      '#10b981',
  OFF:          '#475569',
}
const TIER_RANK: Record<Tier, number> = {
  'GW-MODE': 0, 'LOCKED-OUT': 1, 'SUB-INCAP': 2, 'SOLO-WATCH': 3, NOMINAL: 4, OFF: 5,
}
function tierOf(score: number, off: boolean): Tier {
  if (off) return 'OFF'
  if (score >= 85) return 'GW-MODE'
  if (score >= 65) return 'LOCKED-OUT'
  if (score >= 45) return 'SUB-INCAP'
  if (score >= 22) return 'SOLO-WATCH'
  return 'NOMINAL'
}

function advice(t: Tier, c: Calc, spec: ClsSpec): string {
  if (t === 'GW-MODE') {
    if (c.hardLabel === 'EMPTY-LOCKED') return `EMPTY FLIGHT-DECK · autopilot-only · MAYDAY-INCAP relay via cabin crew per EASA SIB 2015-04 / LAM 470 precedent`
    return `Germanwings-mode · door denied ${c.s.accessDwellS}s · Cat-A escalation per EASA SIB 2015-04 + BEA Final 2016-03-13 D-AIPX`
  }
  if (t === 'LOCKED-OUT') return `RING-DENIED ${c.s.accessDwellS}s · cabin-crew repeat-call SOP per ED-198 §4 + FAA SAFO 15006`
  if (t === 'SUB-INCAP') return `Subtle-incap cues · CUES=${c.d.CUES.toFixed(0)} (dev ${c.s.deviationRate}fpm / track Δ${c.s.trackDevDegMin}°/min / ack-miss ${c.s.ackMissed} / no-input ${c.s.noInputDwellS}s) · brief takeover per SAFO 17007`
  if (t === 'SOLO-WATCH') return `Single-occupant ${c.s.soleDwellS}s · ${spec.twoP === 'REQ' ? '2P-rule REQ' : '2P-rule OP-DISC'} · monitor per Boeing FCOM PR 9.10 / Airbus FCTM PRO-SUP-91`
  if (t === 'NOMINAL') return `Two-pilot vigilant deck · door SECURED · downlink ${spec.downClass} · ${spec.refs}`
  return `Off-scope · ${spec.cls}`
}

interface Row { f: SFlight; spec: ClsSpec; c: Calc; tier: Tier }
const SRC = 'pincap-src'
const LBL = 'pincap-lbl'

export default function PilotIncap({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(100)
  const [soloFloor, setSoloFloor] = useState(420)
  const [cueMul, setCueMul] = useState(100)
  const [doorMul, setDoorMul] = useState(100)
  const [clsFilter, setClsFilter] = useState<'ALL'|Cls>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<'ALL'|Phase>('ALL')
  const [tierFilter, setTierFilter] = useState<'ALL'|Tier>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT'|'SYSTEMS'|'DRIVERS'|'PRECEDENT'>('AIRCRAFT')
  const [search, setSearch] = useState('')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showDoor, setShowDoor] = useState(true)
  const [showVec, setShowVec] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [pickedIcao, setPickedIcao] = useState<string|null>(null)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      const cls = clsFromFlight(f)
      if (clsFilter !== 'ALL' && cls !== clsFilter) continue
      const spec = SPEC_BY_KEY[cls]
      // Single-pilot aircraft are OFF (no two-person concept)
      const off = spec.pilots <= 1
      const c = compute(f, spec, advMul, soloFloor, cueMul, doorMul)
      if (phaseFilter !== 'ALL' && c.phase !== phaseFilter) continue
      const tier = tierOf(c.score, off || f.ground)
      out.push({ f, spec, c, tier })
    }
    out.sort((a, b) => {
      const r = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (r !== 0) return r
      return b.c.score - a.c.score
    })
    return out
  }, [flights, clsFilter, phaseFilter, advMul, soloFloor, cueMul, doorMul])

  const filtered = useMemo(() => {
    let xs = rows
    if (tierFilter !== 'ALL') xs = xs.filter(r => r.tier === tierFilter)
    if (search) {
      const q = search.toLowerCase()
      xs = xs.filter(r =>
        (r.f.callsign || r.f.icao).toLowerCase().includes(q)
        || (r.f.type || '').toLowerCase().includes(q)
        || (r.f.operator || '').toLowerCase().includes(q)
        || r.spec.cls.toLowerCase().includes(q)
      )
    }
    return xs
  }, [rows, tierFilter, search])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { 'GW-MODE':0, 'LOCKED-OUT':0, 'SUB-INCAP':0, 'SOLO-WATCH':0, NOMINAL:0, OFF:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const stats = useMemo(() => {
    const act = rows.filter(r => r.tier !== 'OFF')
    if (!act.length) return { meanScore: 0, gwCnt: 0, lockCnt: 0, soloCnt: 0, worst: undefined as Row|undefined }
    const meanScore = act.reduce((s, r) => s + r.c.score, 0) / act.length
    const gwCnt = counts['GW-MODE']
    const lockCnt = counts['LOCKED-OUT']
    const soloCnt = act.filter(r => r.c.s.occ !== 'BOTH').length
    return { meanScore, gwCnt, lockCnt, soloCnt, worst: act[0] }
  }, [rows, counts])

  useEffect(() => {
    const m = map
    if (!m) return
    const feats: GeoJSON.Feature[] = []
    const labels: GeoJSON.Feature[] = []
    for (const r of filtered) {
      if (r.tier === 'OFF') continue
      const col = TIER_COLOR[r.tier]
      const ccol = CLS_COLOR[r.spec.cls]
      const lat = r.f.lat, lng = r.f.lng
      if (showHalo) {
        const rad = 7 + Math.min(12, r.c.score / 7)
        feats.push({ type:'Feature', properties:{ kind:'halo', color: col, radius: rad },
                     geometry:{ type:'Point', coordinates:[lng, lat] } })
        feats.push({ type:'Feature', properties:{ kind:'halo-inner', color: ccol, radius: Math.max(3, rad - 3) },
                     geometry:{ type:'Point', coordinates:[lng, lat] } })
      }
      if (showPin && (r.tier === 'GW-MODE' || r.tier === 'LOCKED-OUT')) {
        feats.push({ type:'Feature', properties:{ kind:'pin', color: col },
                     geometry:{ type:'Point', coordinates:[lng, lat] } })
      }
      if (showDoor && r.c.s.door === 'DENIED-RING' && r.c.s.accessDwellS >= 120) {
        feats.push({ type:'Feature', properties:{ kind:'door' },
                     geometry:{ type:'Point', coordinates:[lng, lat] } })
      }
      if (showVec && r.c.d.CUES >= 40) {
        const trk = (r.f.track || 0) * Math.PI / 180
        const lenKm = Math.min(6, r.c.d.CUES * PHASE_W[r.c.phase] * 0.05)
        const segs = 5
        const coords: [number, number][] = [[lng, lat]]
        for (let i = 1; i <= segs; i++) {
          const dKm = lenKm * (i / segs)
          // Lateral wobble alternating ±0.15 km perpendicular (subtle-incap deviation visual)
          const wob = (i % 2 === 0 ? 1 : -1) * Math.min(0.4, r.c.d.CUES / 200)
          const fwdLat = lat + (dKm / 111) * Math.cos(trk)
          const fwdLng = lng + (dKm / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)))) * Math.sin(trk)
          const perpLat = (wob / 111) * Math.cos(trk + Math.PI / 2)
          const perpLng = (wob / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)))) * Math.sin(trk + Math.PI / 2)
          coords.push([fwdLng + perpLng, fwdLat + perpLat])
        }
        feats.push({ type:'Feature', properties:{ kind:'vec', color: col },
                     geometry:{ type:'LineString', coordinates: coords } })
      }
      if (showLbl) {
        const occShort = r.c.s.occ === 'BOTH' ? '2P' : r.c.s.occ === 'SINGLE-LAV' ? 'LAV' : r.c.s.occ === 'SINGLE-REST' ? 'RST' : 'EMP'
        const txt = `${r.f.callsign || r.f.icao.toUpperCase()} ${r.spec.cls} ${occShort} ${r.c.s.soleDwellS}s ${r.tier}`
        labels.push({ type:'Feature', properties:{ text: txt, color: col },
                      geometry:{ type:'Point', coordinates:[lng, lat] } })
      }
    }
    try {
      const data = { type:'FeatureCollection', features: feats } as GeoJSON.FeatureCollection
      const ldata = { type:'FeatureCollection', features: labels } as GeoJSON.FeatureCollection
      if (!m.getSource(SRC)) m.addSource(SRC, { type:'geojson', data })
      else (m.getSource(SRC) as maplibregl.GeoJSONSource).setData(data)
      if (!m.getSource(LBL)) m.addSource(LBL, { type:'geojson', data: ldata })
      else (m.getSource(LBL) as maplibregl.GeoJSONSource).setData(ldata)
      if (!m.getLayer('pincap-halo')) m.addLayer({ id:'pincap-halo', type:'circle', source:SRC, filter:['==',['get','kind'],'halo'],
        paint:{ 'circle-color':'transparent','circle-stroke-color':['get','color'],'circle-stroke-width':2,
                'circle-radius':['get','radius'],'circle-opacity':0.8 } })
      if (!m.getLayer('pincap-halo-inner')) m.addLayer({ id:'pincap-halo-inner', type:'circle', source:SRC, filter:['==',['get','kind'],'halo-inner'],
        paint:{ 'circle-color':'transparent','circle-stroke-color':['get','color'],'circle-stroke-width':1,
                'circle-radius':['get','radius'],'circle-opacity':0.5 } })
      if (!m.getLayer('pincap-door')) m.addLayer({ id:'pincap-door', type:'circle', source:SRC, filter:['==',['get','kind'],'door'],
        paint:{ 'circle-color':'transparent','circle-stroke-color':'#f43f5e','circle-stroke-width':1.4,
                'circle-radius':30,'circle-stroke-opacity':0.7 } })
      if (!m.getLayer('pincap-vec')) m.addLayer({ id:'pincap-vec', type:'line', source:SRC, filter:['==',['get','kind'],'vec'],
        paint:{ 'line-color':['get','color'],'line-width':1.4,'line-opacity':0.7,'line-dasharray':[2,2] } })
      if (!m.getLayer('pincap-pin')) m.addLayer({ id:'pincap-pin', type:'circle', source:SRC, filter:['==',['get','kind'],'pin'],
        paint:{ 'circle-color':['get','color'],'circle-stroke-color':'#0f172a','circle-stroke-width':1.2,'circle-radius':5 } })
      if (!m.getLayer('pincap-lbl')) m.addLayer({ id:'pincap-lbl', type:'symbol', source:LBL,
        layout:{ 'text-field':['get','text'],'text-size':10,'text-offset':[0,1.4],'text-anchor':'top','text-font':['Noto Sans Regular'] },
        paint:{ 'text-color':['get','color'],'text-halo-color':'#0f172a','text-halo-width':1.3 } })
    } catch {}
    return () => {
      try {
        for (const id of ['pincap-halo','pincap-halo-inner','pincap-door','pincap-vec','pincap-pin','pincap-lbl']) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC, LBL]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showDoor, showVec, showLbl])

  const picked = useMemo(() => {
    if (pickedIcao) {
      const r = rows.find(x => x.f.icao === pickedIcao)
      if (r) return r
    }
    return stats.worst
  }, [pickedIcao, rows, stats.worst])
  void picked

  const driverFleetMean = useMemo(() => {
    const keys: (keyof Drivers)[] = ['OCC','DWELL','DOOR','CUES','FREQ','POLICY','DOWN','FAT']
    const out: Record<string, { mean: number; max: number }> = {}
    const act = rows.filter(r => r.tier !== 'OFF')
    if (!act.length) { for (const k of keys) out[k] = { mean: 0, max: 0 }; return out }
    for (const k of keys) {
      let sum = 0, mx = 0
      for (const r of act) { sum += r.c.d[k]; if (r.c.d[k] > mx) mx = r.c.d[k] }
      out[k] = { mean: sum / act.length, max: mx }
    }
    return out
  }, [rows])

  const sysAgg = useMemo(() => {
    const m: Record<Cls, { count: number; gw: number; lock: number; sum: number }> = {} as any
    for (const s of SPECS) m[s.cls] = { count: 0, gw: 0, lock: 0, sum: 0 }
    for (const r of rows) {
      const x = m[r.spec.cls]
      x.count++; x.sum += r.c.score
      if (r.tier === 'GW-MODE') x.gw++
      if (r.tier === 'LOCKED-OUT') x.lock++
    }
    return m
  }, [rows])

  const driverDesc: Record<string, string> = {
    OCC:    'Occupancy-state penalty: BOTH=0, SINGLE-LAV=22, SINGLE-REST=14, EMPTY-LOCKED=100. Bridges EASA SIB 2015-04 minimum cockpit occupancy.',
    DWELL:  'Sole-pilot dwell seconds ramped 0→100 over 0..600 s. Mitchell-Evans BMJ 2004 baseline ~1 medically-significant event / 4 M flight-h × fatigue elevation.',
    DOOR:   'Cockpit-door access-dwell ramp 0→100 over 0..480 s. Germanwings 9525 precedent 459 s denied; hard escalator at REQ-class.',
    CUES:   'Subtle-incap cues composite: deviation ft/min + track Δ°/min + ack-missed + no-input dwell s. Helios 522 / SAFO 17007 family.',
    FREQ:   'Frequency-silence: no readback within 30 s past ATC instruction (Annex 10 Vol II §5.2.1.4.1.1). 120 s = 100.',
    POLICY: 'Two-person-rule gap × current single-occupancy: REQ-class=60 / OP-DISC=30. Operator safety case per SIB 2016-09 lowers this.',
    DOWN:   'MAYDAY-INCAP downlink readiness gap: NONE=100, ACARS-ONLY=55, SELCAL-ACARS=25, CPDLC-SELCAL-ACARS=0. Annex 10 §5.3.1 window.',
    FAT:    'Bridge to crew fatigue effectiveness deficit (per-icao24 fitness factor × CIRCAD-style proxy). Caldwell ASEM 80-1 2009.',
  }

  const precedents = [
    { name: 'Germanwings 9525 / D-AIPX',          loc: 'Barcelonnette FR · 2015-03-24 · 150 fatal',
      driver: 'DOOR + POLICY',
      narrative: 'Captain left cockpit for lavatory; FO locked door electronically, set FCU altitude FL100→100 ft, descended into Massif des Trois-Évêchés. Door denied 7 min 39 s, cabin attendant access-code override locked out. BEA Final 2016-03-13 — direct cause of EASA SIB 2015-04 minimum-cockpit-occupancy advisory.' },
    { name: 'Helios 522 / 5B-DBY',                loc: 'Grammatiko GR · 2005-08-14 · 121 fatal',
      driver: 'CUES + DOWN',
      narrative: 'Pressurisation panel left in MAN after maintenance test; cabin altitude warning misinterpreted as TCONFIG. Crew hypoxic by FL180, autopilot held FL340 for 2 h 50 min. F-16 intercept observed FO unconscious in seat. AAIB Cyprus AAR-11/2006.' },
    { name: 'LAM 470 / C9-EMC',                   loc: 'Bwabwata NA · 2013-11-29 · 33 fatal',
      driver: 'OCC + DOOR',
      narrative: 'FO left flight deck for lavatory; Captain manually selected FL387→592 ft on FCU + retarded throttles. CVR captured locked-door rejection-ring for 8 min before impact. CIAIM Mozambique Final 2016 — pre-Germanwings analogue.' },
    { name: 'EgyptAir 990 / SU-GAP',              loc: 'Atlantic · 1999-10-31 · 217 fatal',
      driver: 'OCC + CUES',
      narrative: 'Relief FO seated in command seat alone after Captain bathroom break; pushed yoke fully forward at FL330, engines cut off. NTSB AAR-02/01 — unique sole-occupant intentional event. Drove FCOM PR 9.10 lavatory-trip SOP tightening.' },
    { name: 'Silk Air 185 / 9V-TRF',              loc: 'Musi River ID · 1997-12-19 · 104 fatal',
      driver: 'OCC + CUES',
      narrative: 'NTSC Indonesian final inconclusive; NTSB AAR Annex concluded sole-pilot intentional input. CVR/FDR breakers pulled before dive from FL350. Catalysed regulatory interest in two-pilot cockpit continuity.' },
    { name: 'Continental 1404 / N18611',          loc: 'KDEN · 2008-12-20 · 38 inj (no fatal)',
      driver: 'CUES + FREQ',
      narrative: 'B737-500 veered off RWY 34R during takeoff in 27-kt crosswind. CVR analysis revealed multi-second FO frequency-silence + delayed rudder input consistent with momentary attention-channel narrowing — SAFO 17007 cited as cue-cluster exemplar (not full incapacitation, but vigilance-loss).' },
  ]

  return (
    <div className="absolute top-16 right-4 z-30 w-[520px] max-h-[82vh] flex flex-col rounded-lg border border-slate-700/70 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/70">
        <div className="flex items-center gap-2">
          <span className="text-sky-400 font-mono text-xs tracking-widest">PINCAP</span>
          <span className="text-[10px] text-slate-500">FLIGHT-DECK OCCUPANCY · LOCKED-DOOR · SUBTLE-INCAP</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm px-1">✕</button>
      </div>

      {/* Tier strip */}
      <div className="grid grid-cols-7 gap-px bg-slate-800/70 border-b border-slate-700/70 text-[10px] font-mono">
        {(['GW-MODE','LOCKED-OUT','SUB-INCAP','SOLO-WATCH','NOMINAL','OFF'] as Tier[]).map(t => {
          const active = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(active ? 'ALL' : t)}
              className={`px-1 py-1.5 flex flex-col items-center ${active ? 'bg-sky-500/15 ring-1 ring-sky-500/40' : 'bg-slate-900 hover:bg-slate-800'}`}>
              <span style={{ color: TIER_COLOR[t] }} className="font-semibold">{counts[t]}</span>
              <span className="text-[9px] text-slate-500 mt-0.5">{t}</span>
            </button>
          )
        })}
        <button onClick={() => setTierFilter('ALL')}
          className={`px-1 py-1.5 flex flex-col items-center ${tierFilter === 'ALL' ? 'bg-sky-500/15 ring-1 ring-sky-500/40' : 'bg-slate-900 hover:bg-slate-800'}`}>
          <span className="text-slate-200 font-semibold">{rows.length}</span>
          <span className="text-[9px] text-slate-500 mt-0.5">ALL</span>
        </button>
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-5 gap-px bg-slate-800/70 border-b border-slate-700/70 text-[10px] font-mono">
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">μ-Score</div>
          <div className="text-slate-100">{stats.meanScore.toFixed(0)}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">GW</div>
          <div style={{ color: stats.gwCnt > 0 ? TIER_COLOR['GW-MODE'] : '#94a3b8' }}>{stats.gwCnt}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">LOCK</div>
          <div style={{ color: stats.lockCnt > 0 ? TIER_COLOR['LOCKED-OUT'] : '#94a3b8' }}>{stats.lockCnt}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">SOLO</div>
          <div style={{ color: stats.soloCnt > 0 ? '#0ea5e9' : '#94a3b8' }}>{stats.soloCnt}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-slate-100 truncate">{stats.worst ? (stats.worst.f.callsign || stats.worst.f.icao.toUpperCase()) : '—'}</div>
        </div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-700/70 space-y-1.5">
        {([
          ['ADV-MUL',   advMul,    setAdvMul,    50,  200, '%'],
          ['SOLO-FL',   soloFloor, setSoloFloor, 60,  600, 's'],
          ['CUE-MUL',   cueMul,    setCueMul,    50,  200, '%'],
          ['DOOR-MUL',  doorMul,   setDoorMul,   50,  200, '%'],
        ] as Array<[string, number, (n:number)=>void, number, number, string]>).map(([lbl, v, set, lo, hi, u]) => (
          <div key={lbl} className="flex items-center gap-2">
            <span className="text-[9px] text-slate-500 font-mono w-14">{lbl}</span>
            <input type="range" min={lo} max={hi} value={v} onChange={e => set(Number(e.target.value))} className="flex-1 accent-sky-500" />
            <span className="text-[10px] text-slate-300 font-mono w-14 text-right">{v}{u}</span>
          </div>
        ))}
      </div>

      {/* Phase chip filter */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center flex-wrap gap-1">
        <span className="text-[9px] text-slate-500 font-mono mr-1">PHASE</span>
        {(['ALL','TKO-INI','CLIMB','CRUISE','STEP-CLIMB','DESCENT','APPR-INT','APPR-FNL','GROUND'] as Array<'ALL'|Phase>).map(t => {
          const active = phaseFilter === t
          return (
            <button key={t} onClick={() => setPhaseFilter(t)}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${active ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
              {t}
            </button>
          )
        })}
      </div>

      {/* Class filter + toggles */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center flex-wrap gap-1">
        {(['ALL', ...SPECS.map(s => s.cls)] as Array<'ALL'|Cls>).map(t => {
          const active = clsFilter === t
          const col = t === 'ALL' ? '#94a3b8' : CLS_COLOR[t as Cls]
          return (
            <button key={t} onClick={() => setClsFilter(t)}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${active ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
              <span style={{ color: col }}>●</span> {t}
            </button>
          )
        })}
        <div className="flex-1" />
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['DOOR',showDoor,setShowDoor],['VEC',showVec,setShowVec],['LBL',showLbl,setShowLbl]] as Array<[string, boolean, (v:boolean)=>void]>).map(([n,v,s]) => (
          <button key={n} onClick={() => s(!v)} className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${v ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-500'}`}>{n}</button>
        ))}
      </div>

      {/* Search + tabs */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center gap-1.5">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search callsign/type/operator/class"
          className="flex-1 text-[11px] font-mono bg-slate-950/70 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 placeholder-slate-600 outline-none focus:border-sky-500/60" />
        {(['AIRCRAFT','SYSTEMS','DRIVERS','PRECEDENT'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${tab === t ? 'bg-sky-500/15 ring-1 ring-sky-500/40 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/70">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-slate-500">No flights in scope.</div>}
            {filtered.map(r => {
              const col = TIER_COLOR[r.tier]
              const ccol = CLS_COLOR[r.spec.cls]
              const drv = r.c.d
              const adv = advice(r.tier, r.c, r.spec)
              const occCol = r.c.s.occ === 'BOTH' ? '#10b981'
                          : r.c.s.occ === 'EMPTY-LOCKED' ? '#ef4444'
                          : '#f59e0b'
              const doorCol = r.c.s.door === 'SECURED' ? '#10b981'
                           : r.c.s.door === 'GRANTED' ? '#0ea5e9'
                           : r.c.s.door === 'OVERRIDE' ? '#a855f7'
                           : '#f43f5e'
              return (
                <button key={r.f.icao} onClick={() => { setPickedIcao(r.f.icao); onFly(r.f.icao) }}
                  className="w-full text-left px-3 py-2 hover:bg-slate-800/70">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] font-mono text-slate-100 font-semibold">{r.f.callsign || r.f.icao.toUpperCase()}</span>
                    <span className="text-[10px] font-mono text-slate-400">{r.f.type || '?'}</span>
                    <span className="text-[9px] font-mono px-1 py-px rounded" style={{ background: ccol + '22', color: ccol, border: `1px solid ${ccol}40` }}>{r.spec.cls}</span>
                    <span className="text-[9px] font-mono px-1 py-px rounded border border-slate-700 text-slate-400">{r.c.phase}</span>
                    <span className="text-[9px] font-mono px-1 py-px rounded" style={{ background: occCol + '22', color: occCol, border: `1px solid ${occCol}40` }}>{r.c.s.occ}</span>
                    <span className="text-[9px] font-mono px-1 py-px rounded" style={{ background: doorCol + '22', color: doorCol, border: `1px solid ${doorCol}40` }}>{r.c.s.door}</span>
                    <div className="flex-1" />
                    <span className="text-[10px] font-mono font-semibold" style={{ color: col }}>{r.tier}</span>
                    <span className="text-[10px] font-mono text-slate-300 w-10 text-right">{r.c.score.toFixed(0)}</span>
                  </div>

                  <div className="grid grid-cols-4 gap-1 text-[9px] font-mono mb-1">
                    <div className="px-1 py-0.5 bg-slate-800/50 rounded">
                      <span className="text-slate-500">SOLE </span><span className="text-slate-200">{r.c.s.soleDwellS}s</span>
                    </div>
                    <div className="px-1 py-0.5 bg-slate-800/50 rounded">
                      <span className="text-slate-500">DOOR </span><span className="text-slate-200">{r.c.s.accessDwellS}s</span>
                    </div>
                    <div className="px-1 py-0.5 bg-slate-800/50 rounded">
                      <span className="text-slate-500">CUES </span><span className="text-slate-200">{drv.CUES.toFixed(0)}</span>
                    </div>
                    <div className="px-1 py-0.5 bg-slate-800/50 rounded">
                      <span className="text-slate-500">FREQ </span><span className="text-slate-200">{r.c.s.freqSilenceS}s</span>
                    </div>
                  </div>

                  <div className="w-full bg-slate-800 rounded h-1 mb-1">
                    <div className="h-1 rounded" style={{ width: `${r.c.score}%`, background: col }} />
                  </div>

                  <div className="flex flex-wrap gap-1 mb-1">
                    {([['OCC',drv.OCC],['DWELL',drv.DWELL],['DOOR',drv.DOOR],['CUES',drv.CUES],['FREQ',drv.FREQ],['POLICY',drv.POLICY],['DOWN',drv.DOWN],['FAT',drv.FAT]] as Array<[string, number]>).map(([k, v]) => {
                      const dcol = v >= 60 ? '#f43f5e' : v >= 35 ? '#f59e0b' : v >= 15 ? '#0ea5e9' : '#475569'
                      return (
                        <span key={k} className="text-[9px] font-mono px-1 py-px rounded"
                          style={{ background: dcol + '22', color: dcol, border: `1px solid ${dcol}40` }}>
                          {k}·{v.toFixed(0)}
                        </span>
                      )
                    })}
                  </div>

                  <div className="text-[10px] font-mono leading-tight" style={{ color: col }}>{adv}</div>
                </button>
              )
            })}
          </div>
        )}

        {tab === 'SYSTEMS' && (
          <div className="divide-y divide-slate-800/70">
            {SPECS.map(s => {
              const ag = sysAgg[s.cls]
              const ccol = CLS_COLOR[s.cls]
              const mu = ag.count > 0 ? ag.sum / ag.count : 0
              const twoPCol = s.twoP === 'REQ' ? '#10b981' : s.twoP === 'OP-DISC' ? '#0ea5e9' : s.twoP === 'WAIVED' ? '#a855f7' : '#475569'
              const doorCol = s.doorSpec === 'DO-329' ? '#10b981' : s.doorSpec === 'ED-198' ? '#0ea5e9' : s.doorSpec === 'BASIC' ? '#f59e0b' : '#475569'
              const dlCol  = s.downClass === 'CPDLC-SELCAL-ACARS' ? '#10b981' : s.downClass === 'SELCAL-ACARS' ? '#0ea5e9' : s.downClass === 'ACARS-ONLY' ? '#f59e0b' : '#ef4444'
              return (
                <div key={s.cls} className="px-3 py-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-mono px-1 py-px rounded" style={{ background: ccol + '22', color: ccol, border: `1px solid ${ccol}40` }}>{s.cls}</span>
                    <span className="text-[10px] font-mono text-slate-400">{s.pilots}P</span>
                    <span className="text-[9px] font-mono px-1 py-px rounded" style={{ background: twoPCol + '22', color: twoPCol, border: `1px solid ${twoPCol}40` }}>2P:{s.twoP}</span>
                    <span className="text-[9px] font-mono px-1 py-px rounded" style={{ background: doorCol + '22', color: doorCol, border: `1px solid ${doorCol}40` }}>{s.doorSpec}</span>
                    <span className="text-[9px] font-mono px-1 py-px rounded" style={{ background: dlCol + '22', color: dlCol, border: `1px solid ${dlCol}40` }}>{s.downClass}</span>
                    <div className="flex-1" />
                    <span className="text-[10px] font-mono text-slate-300">n={ag.count}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1 mb-1 text-[9px] font-mono">
                    <div className="px-1 py-0.5 bg-slate-800/50 rounded">
                      <span className="text-slate-500">μ </span><span className="text-slate-200">{mu.toFixed(0)}</span>
                    </div>
                    <div className="px-1 py-0.5 bg-slate-800/50 rounded">
                      <span className="text-slate-500">GW </span><span style={{ color: ag.gw > 0 ? TIER_COLOR['GW-MODE'] : '#94a3b8' }}>{ag.gw}</span>
                    </div>
                    <div className="px-1 py-0.5 bg-slate-800/50 rounded">
                      <span className="text-slate-500">LOCK </span><span style={{ color: ag.lock > 0 ? TIER_COLOR['LOCKED-OUT'] : '#94a3b8' }}>{ag.lock}</span>
                    </div>
                  </div>
                  <div className="text-[9px] font-mono italic text-slate-500">{s.refs}</div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'DRIVERS' && (
          <div className="px-3 py-2 space-y-2">
            <div className="text-[10px] font-mono text-slate-400 mb-1">Fleet-mean / max contribution per driver (active-flights only)</div>
            {(['OCC','DWELL','DOOR','CUES','FREQ','POLICY','DOWN','FAT'] as const).map(k => {
              const v = driverFleetMean[k]
              const col = v.mean >= 35 ? '#f59e0b' : v.mean >= 15 ? '#0ea5e9' : '#475569'
              return (
                <div key={k}>
                  <div className="flex items-center justify-between text-[10px] font-mono mb-0.5">
                    <span className="text-slate-300">{k}</span>
                    <span style={{ color: col }}>μ {v.mean.toFixed(1)} · max {v.max.toFixed(0)}</span>
                  </div>
                  <div className="w-full bg-slate-800 rounded h-1 mb-0.5">
                    <div className="h-1 rounded" style={{ width: `${v.mean}%`, background: col }} />
                  </div>
                  <div className="text-[9px] font-mono text-slate-500 leading-tight">{driverDesc[k]}</div>
                </div>
              )
            })}

            <div className="mt-3 pt-2 border-t border-slate-800">
              <div className="text-[10px] font-mono text-slate-400 mb-1">Phase weighting</div>
              <div className="grid grid-cols-4 gap-1 text-[9px] font-mono">
                {(Object.keys(PHASE_W) as Phase[]).map(p => (
                  <div key={p} className="px-1 py-0.5 bg-slate-800/50 rounded flex justify-between">
                    <span className="text-slate-400">{p}</span>
                    <span className="text-slate-200">{PHASE_W[p].toFixed(2)}</span>
                  </div>
                ))}
              </div>
              <div className="text-[9px] font-mono text-slate-500 mt-1 leading-tight">
                APPR-FNL peaks at 1.40 (high-workload + LOC-I cue cluster); CRUISE 1.00 (lav-trip occupancy peak; ICAO 9966 vigilance trough).
              </div>
            </div>

            <div className="mt-3 pt-2 border-t border-slate-800">
              <div className="text-[10px] font-mono text-slate-400 mb-1">Mitchell-Evans incapacitation epidemiology</div>
              <div className="grid grid-cols-2 gap-1 text-[9px] font-mono">
                <div className="px-1 py-0.5 bg-slate-800/50 rounded flex justify-between"><span className="text-slate-400">Class-1 ATPL</span><span className="text-slate-200">1 / 4 M h</span></div>
                <div className="px-1 py-0.5 bg-slate-800/50 rounded flex justify-between"><span className="text-slate-400">Age &lt;40</span><span className="text-slate-200">0.4 / M h</span></div>
                <div className="px-1 py-0.5 bg-slate-800/50 rounded flex justify-between"><span className="text-slate-400">Age 40-60</span><span className="text-slate-200">1.0 / M h</span></div>
                <div className="px-1 py-0.5 bg-slate-800/50 rounded flex justify-between"><span className="text-slate-400">Age &gt;60</span><span className="text-slate-200">3.2 / M h</span></div>
                <div className="px-1 py-0.5 bg-slate-800/50 rounded flex justify-between"><span className="text-slate-400">Subtle / overt</span><span className="text-slate-200">68% / 32%</span></div>
                <div className="px-1 py-0.5 bg-slate-800/50 rounded flex justify-between"><span className="text-slate-400">Cardiac dominant</span><span className="text-slate-200">~52%</span></div>
              </div>
              <div className="text-[9px] font-mono text-slate-500 mt-1 leading-tight">
                Mitchell SJ, Evans AD. BMJ 2004;329:1235. Caldwell ASEM 80-1 2009 fatigue elevation factor ×1.7 in WOCL.
              </div>
            </div>
          </div>
        )}

        {tab === 'PRECEDENT' && (
          <div className="divide-y divide-slate-800/70">
            {precedents.map(p => (
              <div key={p.name} className="px-3 py-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-mono text-slate-100 font-semibold">{p.name}</span>
                  <span className="text-[9px] font-mono px-1 py-px rounded border border-rose-500/40 text-rose-400">{p.driver}</span>
                </div>
                <div className="text-[10px] font-mono text-slate-400 mb-1">{p.loc}</div>
                <div className="text-[10px] font-mono text-slate-300 leading-tight">{p.narrative}</div>
              </div>
            ))}
            <div className="px-3 py-2 text-[9px] font-mono text-slate-500 leading-tight">
              References: BEA Final 2016-03-13 D-AIPX · AAIB Cyprus AAR-11/2006 5B-DBY · CIAIM Mozambique Final 2016 C9-EMC · NTSB AAR-02/01 SU-GAP · NTSC Indonesia / NTSB Annex 9V-TRF · NTSB DCA09MA021 N18611 · EASA SIB 2015-04 / 2016-09 · FAA SAFO 15006 / 17007 · ICAO Annex 6 Pt I §13.2.2 · ED-198 / DO-329 · 14 CFR §25.795 / §121.587.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
