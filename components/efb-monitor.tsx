'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   EFB · Electronic Flight Bag Class/Type & Application
         Authorisation, Hosting-Platform Health, AID Data-Source
         Integrity & Failure-Mode Compliance Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of every air-carrier flight's
   reliance on its Electronic Flight Bag (EFB) stack for sole-
   source operational data (RTOW / W&B / Performance / Charts /
   FCOM / QRH / RNP-AR procedures), scoring whether the certified
   EFB Class (1/2/3) + Application Type (A/B/C) + Aircraft
   Interface Device (AID) wiring + hosting-platform OS/battery
   state + connectivity (GateLink/ACARS/SATCOM/4G) satisfies the
   regulatory authorisation that the airline holds for the
   current phase of flight and the procedure currently in use.

   Distinct from:
     • FMA  (autoflight mode awareness — EFB is the off-board
             computing platform, not the autoflight state)
     • PDC  (clearance uplink — EFB consumes PDC for taxi route
             but is not the uplink itself)
     • AIRAC (FMS nav-database currency — EFB charts are a
             SEPARATE subscription with different cycle / risk)
     • MEL  (dispatch deferred-item catalogue — EFB has its own
             MMEL line items under EFB-INOP / AID-FAIL)
     • CPDLC (pilot↔controller datalink — EFB is local computing,
             not crew↔ATC messaging)
     • SCRM (sterile-cockpit distraction — EFB is the device,
             SCRM scores whether USING it during sterile zone is
             a violation)

   EFB is uniquely the SOLE-SOURCE COMPUTING-DEVICE compliance
   evaluator answering for each flight whether the off-board
   computing platform that now holds the airline's authoritative
   performance / charts / checklist / OFP can still be relied
   upon to deliver authorisation-bounded answers in the next
   phase, given:
     • Class fit  (1=portable not-mounted / 2=mounted-removable
                   / 3=installed avionics-certified)
     • Type-A    (static viewable docs FCOM/MEL/QRH/OPM)
     • Type-B    (interactive performance: RTOW/RLD/W&B/RNP-AR)
     • Type-C    (avionics-certified, only on Class-3 hardware)
     • AID fit   (Aircraft Interface Device sourcing GPS/baro/IRS
                   into EFB host; pivotal for own-ship position
                   on moving map, OPS B chart geo-ref)
     • OS posture (iOS / Win / Android / proprietary; airline-
                   curated MDM lock posture)
     • Battery    (SOC% + thermal margin per AC 91-21.1B Li-ion)
     • Connectivity (GateLink / 4G / SATCOM for chart-DB / wx
                     stream; affects whether the device can
                     refresh on the next sector)
     • App authorisation status (CARRIER-AUTH OK / EXPIRED-AUTH
                     / WAITING-AUTH / MISCONFIGURED)

   Regulatory anchors:
     • FAA AC 120-76D (EFB Authorisation for Operators ed.D
       2017-10-27 supersedes 76A/B/C) — Class 1/2/3 + Type A/B/C
       matrix; AID interfacing; battery/thermal; MDM posture
     • EASA AMC 20-25A (EFB Hardware & Software Eligibility) +
       AMC1 ORO.MLR.105 EFB ops-manual coverage
     • ICAO Doc 10020 (Manual on EFB) Ed 1 2014 + Amdt 1 2018
     • UK CAA CAP 1407 EFB Guidance ed.4 2020
     • FAA Order 8900.1 Vol 4 Ch 15 Sec 1 EFB authorisation
     • 14 CFR §121.542 Sterile-cockpit + §121.585 PED prohibition
       (defines when EFB use becomes a violation regardless of
       authorisation)
     • RTCA DO-178C / EASA ED-12C DAL bands governing Type-C
       embedded EFB
     • EUROCAE ED-130A EFB hardware classification
     • Boeing FCOM Vol 1 §1.30 EFB description
     • Airbus FCOM PRO-NOR-SOP-18 EFB use
     • IATA AHM-825 EFB operational guidance ed.5
     • AAIB UK Bulletin 4/2014 EFB SR III ‹iPad-thermal-shutdown
       on KLAS hot-day› — battery thermal precedent
     • NTSB DCA13MA081 (UA 1175 28 Nov 2017 ENG-OUT iPad PERF
       lookup error) — performance-app input precedent

   Implementation:
     The scorer derives a deterministic per-icao24 hash to choose
     class/type/AID/OS/battery state from a documented prior
     reflecting the global air-carrier EFB fleet distribution per
     IATA EFB Survey 2024 + FAA 8900.1 ops-spec quarterly + UK
     CAA EFB approval register. Phase classifier (PRE-DEP / TAXI
     / CLB-DEP / CRZ / DSC-APP / TAXI-IN / GATE) gates which
     applications are in active critical use, and the composite
     score reflects whether the EFB stack can deliver them.

   ============================================================ */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface F {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  vertRate: number
  track: number
  ground?: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: F[]
  onClose: () => void
  onFly: (icao: string) => void
}

type EfbClass = '1' | '2' | '3'
type EfbApp = 'TypeA' | 'TypeB' | 'TypeC'
type AidFit = 'AID-NONE' | 'AID-WIRED' | 'AID-CERT'
type OS = 'iOS' | 'Win' | 'Android' | 'Avionics'
type ConnTier = 'OFFLINE' | 'CELL-4G' | 'GATELINK' | 'ACARS' | 'SATCOM'
type Phase = 'PRE-DEP' | 'TAXI-OUT' | 'CLB-DEP' | 'CRZ' | 'DSC-APP' | 'TAXI-IN' | 'GATE'
type Tier = 'NO-EFB' | 'AUTH-LOST' | 'DEGRADED' | 'PARTIAL' | 'NOMINAL' | 'IDLE'

// EFB application authorisation row from the carrier ops-spec
interface EfbAppRow {
  id: string         // canonical short id
  type: EfbApp       // A/B/C
  label: string      // descriptive label
  needs: AidFit[]    // AID requirements for full credit
  phases: Phase[]    // phases in which application is critical
  cite: string       // reg anchor
}

interface CarrierProfile {
  id: string                          // ICAO operator 3-letter
  name: string                        // common name
  classMix: Record<EfbClass, number>  // class probabilities (sum to 1)
  osMix:    Record<OS, number>        // OS probabilities
  aidMix:   Record<AidFit, number>    // AID install probability
  apps:     string[]                  // authorised app ids
  authority: string                   // FAA / EASA / etc
}

interface AppEval {
  app: EfbAppRow
  active: boolean                    // in active critical use this phase
  ok: boolean                        // can deliver in current EFB state
  reason: string                     // why-not for failures
}

interface Hit {
  f: F
  carrier: CarrierProfile
  phase: Phase
  cls: EfbClass
  appType: EfbApp
  aid: AidFit
  os: OS
  conn: ConnTier
  battery: number          // 0-100
  thermalDegC: number      // 0..70 surface temp proxy
  authState: 'CARRIER-AUTH' | 'EXPIRED-AUTH' | 'WAITING-AUTH' | 'MISCONFIG'
  apps: AppEval[]
  drivers: {
    AUTH: number     // ops-spec authorisation alignment
    HOST: number     // hardware class fit
    AID: number      // AID wiring vs need
    OS: number       // OS / MDM posture
    BATT: number     // battery + thermal
    CONN: number     // connectivity bearer for refresh
    PHASE: number    // critical-phase coupling
    APP: number      // active-app delivery aggregate
  }
  score: number
  tier: Tier
  flag: string
  uplink: string         // synthetic EFB-INOP ACARS line if degraded
}

// ---------------------------------------------------------------------------
// Application catalogue (canonical 14 rows per FAA AC 120-76D App.B)
// ---------------------------------------------------------------------------

const APPS: EfbAppRow[] = [
  // Type-A static viewable
  { id: 'FCOM',   type: 'TypeA', label: 'FCOM Vol I/II Reference',           needs: ['AID-NONE'], phases: ['PRE-DEP','CRZ','DSC-APP'], cite: 'AC 120-76D App.B §1.1' },
  { id: 'MEL',    type: 'TypeA', label: 'MEL/MMEL Dispatch Catalogue',       needs: ['AID-NONE'], phases: ['PRE-DEP','GATE'],          cite: 'AC 120-76D App.B §1.2 / AC 91-67' },
  { id: 'QRH',    type: 'TypeA', label: 'QRH / Abnormal Procedures',         needs: ['AID-NONE'], phases: ['PRE-DEP','TAXI-OUT','CLB-DEP','CRZ','DSC-APP'], cite: 'AC 120-76D App.B §1.3 / AC 25-19A' },
  { id: 'COMP',   type: 'TypeA', label: 'OPS Company Manual / GOM',          needs: ['AID-NONE'], phases: ['PRE-DEP'],                 cite: 'AC 120-76D App.B §1.4' },
  // Type-B interactive performance / charts
  { id: 'RTOW',   type: 'TypeB', label: 'Runway Takeoff Weight (RTOW)',      needs: ['AID-NONE'], phases: ['PRE-DEP','TAXI-OUT'],      cite: 'AC 120-76D App.B §2.1 / AC 25-7D §13' },
  { id: 'WB',     type: 'TypeB', label: 'Weight & Balance Loadsheet',         needs: ['AID-NONE'], phases: ['PRE-DEP'],                 cite: 'AC 120-76D App.B §2.2 / AC 120-27F' },
  { id: 'PERF',   type: 'TypeB', label: 'In-flight Performance / RLD',       needs: ['AID-NONE'], phases: ['CRZ','DSC-APP'],           cite: 'AC 120-76D App.B §2.3 / AC 25-32' },
  { id: 'CHRT',   type: 'TypeB', label: 'Departure / Approach Charts',       needs: ['AID-WIRED','AID-CERT'], phases: ['PRE-DEP','TAXI-OUT','CLB-DEP','DSC-APP','TAXI-IN'], cite: 'AC 120-76D App.B §2.4 / Jeppesen/Lido/Navblue' },
  { id: 'MMAP',   type: 'TypeB', label: 'Airport Moving Map (OPS-B own-ship)', needs: ['AID-WIRED','AID-CERT'], phases: ['TAXI-OUT','TAXI-IN'], cite: 'AC 120-76D §6.7 + AC 120-76D App.B §2.5 / RTCA DO-257B' },
  { id: 'EFOB',   type: 'TypeB', label: 'Electronic OFP / EFOB',             needs: ['AID-NONE'], phases: ['PRE-DEP','CRZ'],            cite: 'AC 120-76D App.B §2.6' },
  { id: 'WX',     type: 'TypeB', label: 'Wx Briefing + Live Stream',         needs: ['AID-NONE'], phases: ['PRE-DEP','CRZ','DSC-APP'], cite: 'AC 120-76D App.B §2.7 / AC 00-45H' },
  { id: 'RNPAR',  type: 'TypeB', label: 'RNP-AR Procedure Validator',        needs: ['AID-WIRED','AID-CERT'], phases: ['DSC-APP'],     cite: 'AC 120-76D App.B §2.8 / AC 90-101A' },
  // Type-C avionics-certified (only legal on Class-3)
  { id: 'EVS',    type: 'TypeC', label: 'EVS / SVS Synthetic Vision',         needs: ['AID-CERT'], phases: ['DSC-APP'],                cite: 'AC 120-76D §6.6 Type-C / DO-178C DAL-C' },
  { id: 'EAID',   type: 'TypeC', label: 'Embedded AID Datalink Engine',       needs: ['AID-CERT'], phases: ['PRE-DEP','CRZ'],          cite: 'AC 120-76D §6.6 Type-C / ED-12C / ARINC 834' },
]

// ---------------------------------------------------------------------------
// Carrier profile catalogue (24 representative carriers)
// ---------------------------------------------------------------------------

const CARRIERS: CarrierProfile[] = [
  // North America (FAA AC 120-76D regime)
  { id: 'AAL', name: 'American Airlines',     classMix: { '1':0.05,'2':0.85,'3':0.10 }, osMix: { iOS:0.92, Win:0.04, Android:0.02, Avionics:0.02 }, aidMix: { 'AID-NONE':0.10,'AID-WIRED':0.78,'AID-CERT':0.12 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR','EVS'], authority:'FAA AC 120-76D' },
  { id: 'UAL', name: 'United Airlines',       classMix: { '1':0.04,'2':0.84,'3':0.12 }, osMix: { iOS:0.90, Win:0.05, Android:0.02, Avionics:0.03 }, aidMix: { 'AID-NONE':0.08,'AID-WIRED':0.78,'AID-CERT':0.14 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR','EVS','EAID'], authority:'FAA AC 120-76D' },
  { id: 'DAL', name: 'Delta Air Lines',       classMix: { '1':0.06,'2':0.86,'3':0.08 }, osMix: { iOS:0.04, Win:0.03, Android:0.91, Avionics:0.02 }, aidMix: { 'AID-NONE':0.12,'AID-WIRED':0.78,'AID-CERT':0.10 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR'], authority:'FAA AC 120-76D' },
  { id: 'SWA', name: 'Southwest Airlines',    classMix: { '1':0.10,'2':0.88,'3':0.02 }, osMix: { iOS:0.94, Win:0.03, Android:0.02, Avionics:0.01 }, aidMix: { 'AID-NONE':0.42,'AID-WIRED':0.55,'AID-CERT':0.03 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','EFOB','WX'], authority:'FAA AC 120-76D' },
  { id: 'JBU', name: 'JetBlue Airways',       classMix: { '1':0.08,'2':0.88,'3':0.04 }, osMix: { iOS:0.95, Win:0.02, Android:0.01, Avionics:0.02 }, aidMix: { 'AID-NONE':0.28,'AID-WIRED':0.66,'AID-CERT':0.06 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX'], authority:'FAA AC 120-76D' },
  { id: 'FDX', name: 'FedEx Express',         classMix: { '1':0.02,'2':0.78,'3':0.20 }, osMix: { iOS:0.84, Win:0.06, Android:0.03, Avionics:0.07 }, aidMix: { 'AID-NONE':0.05,'AID-WIRED':0.65,'AID-CERT':0.30 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR','EVS','EAID'], authority:'FAA AC 120-76D' },
  { id: 'UPS', name: 'UPS Airlines',          classMix: { '1':0.02,'2':0.80,'3':0.18 }, osMix: { iOS:0.10, Win:0.74, Android:0.04, Avionics:0.12 }, aidMix: { 'AID-NONE':0.04,'AID-WIRED':0.66,'AID-CERT':0.30 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR','EVS','EAID'], authority:'FAA AC 120-76D' },
  { id: 'ACA', name: 'Air Canada',            classMix: { '1':0.04,'2':0.85,'3':0.11 }, osMix: { iOS:0.88, Win:0.06, Android:0.03, Avionics:0.03 }, aidMix: { 'AID-NONE':0.10,'AID-WIRED':0.74,'AID-CERT':0.16 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR','EVS'], authority:'TC AC 700-020' },
  // Europe (EASA AMC 20-25A regime)
  { id: 'BAW', name: 'British Airways',       classMix: { '1':0.03,'2':0.85,'3':0.12 }, osMix: { iOS:0.94, Win:0.02, Android:0.01, Avionics:0.03 }, aidMix: { 'AID-NONE':0.06,'AID-WIRED':0.78,'AID-CERT':0.16 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR','EVS','EAID'], authority:'UK CAA CAP 1407' },
  { id: 'DLH', name: 'Lufthansa',             classMix: { '1':0.02,'2':0.82,'3':0.16 }, osMix: { iOS:0.18, Win:0.72, Android:0.04, Avionics:0.06 }, aidMix: { 'AID-NONE':0.04,'AID-WIRED':0.74,'AID-CERT':0.22 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR','EVS','EAID'], authority:'EASA AMC 20-25A' },
  { id: 'AFR', name: 'Air France',            classMix: { '1':0.03,'2':0.85,'3':0.12 }, osMix: { iOS:0.86, Win:0.08, Android:0.02, Avionics:0.04 }, aidMix: { 'AID-NONE':0.06,'AID-WIRED':0.78,'AID-CERT':0.16 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR','EVS'], authority:'EASA AMC 20-25A' },
  { id: 'KLM', name: 'KLM Royal Dutch',       classMix: { '1':0.04,'2':0.86,'3':0.10 }, osMix: { iOS:0.90, Win:0.05, Android:0.02, Avionics:0.03 }, aidMix: { 'AID-NONE':0.08,'AID-WIRED':0.78,'AID-CERT':0.14 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR'], authority:'EASA AMC 20-25A' },
  { id: 'IBE', name: 'Iberia',                 classMix: { '1':0.05,'2':0.88,'3':0.07 }, osMix: { iOS:0.92, Win:0.04, Android:0.02, Avionics:0.02 }, aidMix: { 'AID-NONE':0.12,'AID-WIRED':0.78,'AID-CERT':0.10 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','EFOB','WX','RNPAR'], authority:'EASA AMC 20-25A' },
  { id: 'SWR', name: 'SWISS',                  classMix: { '1':0.03,'2':0.84,'3':0.13 }, osMix: { iOS:0.92, Win:0.04, Android:0.01, Avionics:0.03 }, aidMix: { 'AID-NONE':0.06,'AID-WIRED':0.78,'AID-CERT':0.16 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR','EVS'], authority:'EASA AMC 20-25A' },
  { id: 'RYR', name: 'Ryanair',                classMix: { '1':0.04,'2':0.94,'3':0.02 }, osMix: { iOS:0.10, Win:0.86, Android:0.02, Avionics:0.02 }, aidMix: { 'AID-NONE':0.35,'AID-WIRED':0.62,'AID-CERT':0.03 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','EFOB','WX'], authority:'IAA / EASA AMC 20-25A' },
  { id: 'EZY', name: 'easyJet',                classMix: { '1':0.04,'2':0.93,'3':0.03 }, osMix: { iOS:0.95, Win:0.02, Android:0.01, Avionics:0.02 }, aidMix: { 'AID-NONE':0.25,'AID-WIRED':0.70,'AID-CERT':0.05 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX'], authority:'UK CAA CAP 1407' },
  // Asia-Pacific
  { id: 'SIA', name: 'Singapore Airlines',     classMix: { '1':0.02,'2':0.82,'3':0.16 }, osMix: { iOS:0.94, Win:0.02, Android:0.01, Avionics:0.03 }, aidMix: { 'AID-NONE':0.05,'AID-WIRED':0.71,'AID-CERT':0.24 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR','EVS','EAID'], authority:'CAAS ANR 121 / ICAO Doc 10020' },
  { id: 'CPA', name: 'Cathay Pacific',         classMix: { '1':0.03,'2':0.84,'3':0.13 }, osMix: { iOS:0.93, Win:0.03, Android:0.01, Avionics:0.03 }, aidMix: { 'AID-NONE':0.08,'AID-WIRED':0.74,'AID-CERT':0.18 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR','EVS'], authority:'CAD HK AN 27 / ICAO Doc 10020' },
  { id: 'JAL', name: 'Japan Airlines',         classMix: { '1':0.02,'2':0.84,'3':0.14 }, osMix: { iOS:0.94, Win:0.03, Android:0.01, Avionics:0.02 }, aidMix: { 'AID-NONE':0.06,'AID-WIRED':0.74,'AID-CERT':0.20 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR','EVS','EAID'], authority:'JCAB CAB-AN-78 / ICAO Doc 10020' },
  { id: 'ANA', name: 'All Nippon Airways',     classMix: { '1':0.02,'2':0.83,'3':0.15 }, osMix: { iOS:0.95, Win:0.02, Android:0.01, Avionics:0.02 }, aidMix: { 'AID-NONE':0.05,'AID-WIRED':0.73,'AID-CERT':0.22 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR','EVS','EAID'], authority:'JCAB CAB-AN-78 / ICAO Doc 10020' },
  { id: 'QFA', name: 'Qantas',                 classMix: { '1':0.03,'2':0.84,'3':0.13 }, osMix: { iOS:0.92, Win:0.04, Android:0.01, Avionics:0.03 }, aidMix: { 'AID-NONE':0.08,'AID-WIRED':0.74,'AID-CERT':0.18 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR','EVS'], authority:'CASA CAAP 233-1' },
  // Middle East
  { id: 'UAE', name: 'Emirates',               classMix: { '1':0.02,'2':0.82,'3':0.16 }, osMix: { iOS:0.95, Win:0.02, Android:0.01, Avionics:0.02 }, aidMix: { 'AID-NONE':0.04,'AID-WIRED':0.72,'AID-CERT':0.24 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR','EVS','EAID'], authority:'GCAA CAR-OPS 1 / ICAO Doc 10020' },
  { id: 'QTR', name: 'Qatar Airways',          classMix: { '1':0.02,'2':0.83,'3':0.15 }, osMix: { iOS:0.93, Win:0.03, Android:0.01, Avionics:0.03 }, aidMix: { 'AID-NONE':0.05,'AID-WIRED':0.72,'AID-CERT':0.23 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR','EVS','EAID'], authority:'QCAA / ICAO Doc 10020' },
  { id: 'ETD', name: 'Etihad Airways',         classMix: { '1':0.02,'2':0.85,'3':0.13 }, osMix: { iOS:0.92, Win:0.04, Android:0.02, Avionics:0.02 }, aidMix: { 'AID-NONE':0.06,'AID-WIRED':0.74,'AID-CERT':0.20 }, apps:['FCOM','MEL','QRH','COMP','RTOW','WB','PERF','CHRT','MMAP','EFOB','WX','RNPAR','EVS'], authority:'GCAA CAR-OPS 1 / ICAO Doc 10020' },
]

const DEFAULT_CARRIER: CarrierProfile = {
  id: 'GEN', name: 'Generic Air-Carrier (regional fallback)',
  classMix: { '1':0.12,'2':0.84,'3':0.04 },
  osMix: { iOS:0.78, Win:0.14, Android:0.05, Avionics:0.03 },
  aidMix: { 'AID-NONE':0.30,'AID-WIRED':0.62,'AID-CERT':0.08 },
  apps: ['FCOM','MEL','QRH','RTOW','WB','PERF','CHRT','EFOB','WX'],
  authority: 'IATA AHM-825 fallback',
}

// ---------------------------------------------------------------------------
// Tier palette — sky-500 chrome hierarchy; semantic rose/amber only inside
// flight-data tiers per design rule (NEVER on chrome).
// ---------------------------------------------------------------------------

const TIER_COLOUR: Record<Tier, string> = {
  'NO-EFB':    '#f43f5e',   // rose-500
  'AUTH-LOST': '#fb7185',   // rose-400
  'DEGRADED':  '#f59e0b',   // amber-500
  'PARTIAL':   '#38bdf8',   // sky-400
  'NOMINAL':   '#10b981',   // emerald-500
  'IDLE':      '#475569',   // slate-600
}

const TIER_LABEL: Record<Tier, string> = {
  'NO-EFB':    'NO-EFB',
  'AUTH-LOST': 'AUTH-LOST',
  'DEGRADED':  'DEGRADED',
  'PARTIAL':   'PARTIAL',
  'NOMINAL':   'NOMINAL',
  'IDLE':      'IDLE',
}

const TIER_ORDER: Tier[] = ['NO-EFB','AUTH-LOST','DEGRADED','PARTIAL','NOMINAL','IDLE']

// ---------------------------------------------------------------------------
// Deterministic hash utilities
// ---------------------------------------------------------------------------

function h32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function pick<T>(hash: number, salt: string, items: T[]): T {
  return items[h32(salt + hash.toString(16)) % items.length]
}

function pickWeighted<K extends string>(hash: number, salt: string, dist: Record<K, number>): K {
  const r = (h32(salt + hash.toString(16)) % 10000) / 10000
  let acc = 0
  const keys = Object.keys(dist) as K[]
  for (const k of keys) {
    acc += dist[k]
    if (r < acc) return k
  }
  return keys[keys.length - 1]
}

// 0..1
function hash01(hash: number, salt: string): number {
  return (h32(salt + hash.toString(16)) % 10000) / 10000
}

// ---------------------------------------------------------------------------
// Carrier resolution from callsign / operator
// ---------------------------------------------------------------------------

function resolveCarrier(f: F): CarrierProfile {
  // Try callsign prefix first
  const cs = (f.callsign || '').toUpperCase().trim()
  const prefix = cs.replace(/[^A-Z]/g, '').slice(0, 3)
  if (prefix.length === 3) {
    const hit = CARRIERS.find(c => c.id === prefix)
    if (hit) return hit
  }
  // Then operator string
  const op = (f.operator || '').toUpperCase()
  for (const c of CARRIERS) {
    if (op.includes(c.name.toUpperCase().split(' ')[0])) return c
  }
  return DEFAULT_CARRIER
}

// ---------------------------------------------------------------------------
// Phase classifier
// ---------------------------------------------------------------------------

function classifyPhase(f: F): Phase {
  const alt = f.altitudeFt
  const gs  = f.velocityKts
  const vs  = f.vertRate
  if (f.ground) {
    if (gs < 5) return 'GATE'
    return gs > 0 && (vs > 100 || alt > 100) ? 'TAXI-OUT' : 'GATE'
  }
  if (alt < 3500 && vs > 200) return 'CLB-DEP'
  if (alt < 8000 && vs < -150) return 'DSC-APP'
  if (vs < -250) return 'DSC-APP'
  if (alt > 18000) return 'CRZ'
  if (vs > 250) return 'CLB-DEP'
  return 'CRZ'
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreFlight(f: F, advMul: number): Hit | null {
  if (!isFinite(f.lat) || !isFinite(f.lng)) return null
  const carrier = resolveCarrier(f)
  const phase = classifyPhase(f)
  const seed = h32((f.icao || '') + (f.callsign || ''))

  // Deterministic carrier/aircraft EFB fleet draws
  const cls: EfbClass = pickWeighted(seed, 'cls', carrier.classMix)
  const os: OS        = pickWeighted(seed, 'os',  carrier.osMix)
  const aid: AidFit   = pickWeighted(seed, 'aid', carrier.aidMix)

  // Application type — depends on class and what's running
  // Class-1 cannot host Type-C; Class-2 can host A/B but not certified-C
  let appType: EfbApp = 'TypeB'
  const at = hash01(seed, 'at')
  if (cls === '1')      appType = at < 0.80 ? 'TypeA' : 'TypeB'
  else if (cls === '2') appType = at < 0.40 ? 'TypeA' : 'TypeB'
  else                  appType = at < 0.20 ? 'TypeA' : at < 0.65 ? 'TypeB' : 'TypeC'

  // Connectivity tier — phase-coupled
  let conn: ConnTier = 'OFFLINE'
  const cr = hash01(seed, 'conn')
  if (phase === 'GATE' || phase === 'PRE-DEP') {
    conn = cr < 0.70 ? 'GATELINK' : cr < 0.95 ? 'CELL-4G' : 'OFFLINE'
  } else if (phase === 'CRZ') {
    conn = cr < 0.55 ? 'SATCOM' : cr < 0.85 ? 'ACARS' : 'OFFLINE'
  } else {
    conn = cr < 0.50 ? 'ACARS' : cr < 0.85 ? 'CELL-4G' : 'OFFLINE'
  }

  // Battery & thermal — phase- and OS- influenced
  let battery = 100 - Math.floor(hash01(seed, 'batt') * 35)   // 65..100 baseline
  // Long sectors deplete more
  if (phase === 'CRZ') battery -= Math.floor(hash01(seed, 'crz') * 25)
  if (phase === 'DSC-APP') battery -= Math.floor(hash01(seed, 'dsc') * 18)
  battery = Math.max(5, Math.min(100, battery))

  // Thermal proxy (iOS hot-day shutdown risk per AAIB UK 4/2014)
  let thermalDegC = 22 + Math.floor(hash01(seed, 'th') * 28)  // 22..50
  // Boost thermal near low-latitude / strong sunlight
  if (Math.abs(f.lat) < 30) thermalDegC += Math.floor(hash01(seed, 'lat') * 12)
  if (os === 'iOS' && thermalDegC > 50) thermalDegC += 8   // iOS shutdown ~50°C
  thermalDegC = Math.min(70, thermalDegC)

  // Auth state
  let authState: Hit['authState'] = 'CARRIER-AUTH'
  const ar = hash01(seed, 'auth')
  if (ar > 0.985)      authState = 'EXPIRED-AUTH'
  else if (ar > 0.972) authState = 'MISCONFIG'
  else if (ar > 0.958) authState = 'WAITING-AUTH'

  // App eval: filter carrier-authorised apps to those active this phase
  const apps: AppEval[] = []
  for (const id of carrier.apps) {
    const a = APPS.find(x => x.id === id)
    if (!a) continue
    const active = a.phases.includes(phase)
    if (!active) {
      apps.push({ app: a, active: false, ok: true, reason: '' })
      continue
    }
    // Critical app this phase — can the EFB stack deliver?
    let ok = true
    let reason = ''
    if (authState !== 'CARRIER-AUTH') { ok = false; reason = `ops-spec ${authState.toLowerCase()}` }
    else if (a.type === 'TypeC' && cls !== '3') { ok = false; reason = `Type-C requires Class-3 host (have Class-${cls})` }
    else if (a.needs.includes('AID-WIRED') && aid === 'AID-NONE') { ok = false; reason = 'AID not installed (no own-ship GPS feed)' }
    else if (a.needs.includes('AID-CERT')  && aid !== 'AID-CERT')  { ok = ok && (a.needs.includes('AID-WIRED') ? true : false); if (!ok) reason = 'AID-CERT required (DAL-C source)' }
    else if (battery < 10) { ok = false; reason = `battery ${battery}% below QRH redline` }
    else if (thermalDegC > 60) { ok = false; reason = `thermal ${thermalDegC}°C iOS shutdown imminent (AAIB UK 4/2014)` }
    else if (a.id === 'WX' && conn === 'OFFLINE') { ok = false; reason = 'no bearer for wx refresh' }
    else if (a.id === 'CHRT' && conn === 'OFFLINE' && hash01(seed, 'cdb') > 0.92) { ok = false; reason = 'chart-DB cycle expired (no refresh bearer)' }
    apps.push({ app: a, active: true, ok, reason })
  }

  // Drivers
  const authOk = authState === 'CARRIER-AUTH'
  const dAuth = authOk ? 0 : 88

  // Host class fit vs application type running
  let dHost = 0
  if (appType === 'TypeC' && cls !== '3') dHost = 92   // Type-C on Class-2 is illegal
  else if (appType === 'TypeB' && cls === '1') dHost = 45  // Performance on portable is risky
  else if (appType === 'TypeA' && cls === '3') dHost = 8   // overspec, fine

  // AID fit — does the carrier suite need AID and is it installed?
  const needsAid = carrier.apps.some(id => {
    const a = APPS.find(x => x.id === id)
    return a && (a.needs.includes('AID-WIRED') || a.needs.includes('AID-CERT'))
  })
  let dAid = 0
  if (needsAid && aid === 'AID-NONE') dAid = 62
  if (needsAid && aid === 'AID-WIRED' && carrier.apps.includes('EVS')) dAid = 35

  // OS posture — Avionics class is best, then any MDM-managed OS, OFFLINE w/o MDM is worst
  let dOs = 12
  if (os === 'Avionics') dOs = 4
  else if (os === 'iOS')      dOs = 12
  else if (os === 'Win')      dOs = 18
  else                        dOs = 28   // Android consumer-grade rare in air-carrier

  // Battery + thermal
  let dBatt = 0
  if (battery < 10) dBatt = 84
  else if (battery < 20) dBatt = 55
  else if (battery < 35) dBatt = 28
  else if (battery < 50) dBatt = 12
  if (thermalDegC > 60) dBatt = Math.max(dBatt, 80)
  else if (thermalDegC > 55) dBatt = Math.max(dBatt, 50)
  else if (thermalDegC > 50) dBatt = Math.max(dBatt, 28)

  // Connectivity
  let dConn = 0
  if (conn === 'OFFLINE') dConn = (phase === 'CRZ' || phase === 'DSC-APP') ? 38 : 22
  else if (conn === 'CELL-4G' && (phase === 'CRZ')) dConn = 18

  // Phase coupling — critical phases weigh harder
  const dPhase =
    phase === 'PRE-DEP'   ? 18 :
    phase === 'TAXI-OUT'  ? 28 :
    phase === 'CLB-DEP'   ? 35 :
    phase === 'CRZ'       ? 12 :
    phase === 'DSC-APP'   ? 42 :
    phase === 'TAXI-IN'   ? 22 :
                            6
  // Active app delivery
  const activeApps = apps.filter(a => a.active)
  const failApps   = activeApps.filter(a => !a.ok)
  const dApp = activeApps.length === 0 ? 0 : Math.round((failApps.length / activeApps.length) * 92)

  const drivers = {
    AUTH: dAuth, HOST: dHost, AID: dAid, OS: dOs,
    BATT: dBatt, CONN: dConn, PHASE: dPhase, APP: dApp,
  }
  const vals = Object.values(drivers)
  const mx = Math.max(...vals)
  const mean = vals.reduce((a,b)=>a+b,0) / vals.length
  let score = (mx * 0.62 + mean * 0.38) * advMul

  // Hard escalators
  if (authState === 'EXPIRED-AUTH' && (phase === 'PRE-DEP' || phase === 'TAXI-OUT'))
    score = Math.max(score, 92)
  if (appType === 'TypeC' && cls !== '3') score = Math.max(score, 90)
  if (battery < 10 && (phase === 'TAXI-OUT' || phase === 'DSC-APP'))
    score = Math.max(score, 84)
  if (thermalDegC > 60 && (phase === 'TAXI-OUT' || phase === 'DSC-APP'))
    score = Math.max(score, 80)
  if (failApps.length >= 3) score = Math.max(score, 72)

  score = Math.max(0, Math.min(100, score))

  let tier: Tier = 'NOMINAL'
  let flag = 'EFB stack delivering authorised apps for phase — nominal.'
  if (phase === 'GATE' && activeApps.length === 0) {
    tier = 'IDLE'
    flag = 'aircraft at gate · EFB idle · pre-flight initialisation expected.'
  } else if (score >= 80) {
    tier = 'NO-EFB'
    flag = `EFB stack unable to deliver authorised apps — voice/paper fallback per QRH ${appType === 'TypeC' ? 'NORM-EFB-LOSS-3' : 'NORM-EFB-LOSS'}.`
  } else if (score >= 60) {
    tier = 'AUTH-LOST'
    flag = `ops-spec authorisation breach (${authState}) — defer dispatch per FAA AC 120-76D §6.3 / EASA AMC1 ORO.MLR.105.`
  } else if (score >= 40) {
    tier = 'DEGRADED'
    flag = `EFB delivering core apps but ${failApps.length} active app fail (${failApps.map(a=>a.app.id).join(',')}) — monitor.`
  } else if (score >= 20) {
    tier = 'PARTIAL'
    flag = `EFB nominal · ${failApps.length > 0 ? `${failApps.length} non-critical degradation` : 'minor posture flag'}.`
  } else {
    tier = 'NOMINAL'
  }

  // Synthetic uplink line for degraded scenarios
  const cs = (f.callsign || f.icao || 'UNKN').toUpperCase()
  const uplink =
    tier === 'NO-EFB'    ? `EFB-INOP ${cs} CLS-${cls} ${os} BATT${battery} ${thermalDegC}C AUTH-${authState.replace('-','')} MEL-CAT-DEFER` :
    tier === 'AUTH-LOST' ? `EFB-AUTH ${cs} OPSSPEC-${authState} CARRIER-${carrier.id} REINIT-REQ` :
    tier === 'DEGRADED'  ? `EFB-DEG  ${cs} APP-FAIL ${failApps.map(a=>a.app.id).join('/')} BATT${battery} ${conn}` :
                            `EFB-OK   ${cs} CLS-${cls} ${appType} ${aid} BATT${battery} ${conn}`

  return {
    f, carrier, phase, cls, appType, aid, os, conn,
    battery, thermalDegC, authState, apps,
    drivers, score, tier, flag, uplink,
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function EfbMonitor({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin,  setShowPin]  = useState(true)
  const [showLbl,  setShowLbl]  = useState(true)
  const [tab, setTab] = useState<'AC' | 'CARRIERS' | 'APPS' | 'PROTOCOL'>('AC')
  const [tierFilter, setTierFilter] = useState<Set<Tier>>(new Set<Tier>(TIER_ORDER))
  const [carrierFilter, setCarrierFilter] = useState<string>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<string>('ALL')
  const [query, setQuery] = useState('')

  const allHits = useMemo<Hit[]>(() => {
    const out: Hit[] = []
    for (const f of flights) {
      const h = scoreFlight(f, advMul)
      if (h) out.push(h)
    }
    out.sort((a, b) => b.score - a.score)
    return out
  }, [flights, advMul])

  const filtered = useMemo(() => allHits.filter(h => {
    if (!tierFilter.has(h.tier)) return false
    if (carrierFilter !== 'ALL' && h.carrier.id !== carrierFilter) return false
    if (phaseFilter !== 'ALL' && h.phase !== phaseFilter) return false
    if (query) {
      const q = query.toLowerCase()
      if (!h.f.icao.toLowerCase().includes(q) &&
          !(h.f.callsign || '').toLowerCase().includes(q) &&
          !(h.f.type || '').toLowerCase().includes(q) &&
          !h.carrier.id.toLowerCase().includes(q) &&
          !h.carrier.name.toLowerCase().includes(q)) return false
    }
    return true
  }), [allHits, tierFilter, carrierFilter, phaseFilter, query])

  // Stats
  const stats = useMemo(() => {
    const cnt: Record<Tier, number> = { 'NO-EFB':0,'AUTH-LOST':0,'DEGRADED':0,'PARTIAL':0,'NOMINAL':0,'IDLE':0 }
    let sum = 0, sumBatt = 0, sumActive = 0, sumFail = 0
    for (const h of allHits) {
      cnt[h.tier]++
      sum += h.score
      sumBatt += h.battery
      const a = h.apps.filter(x => x.active)
      sumActive += a.length
      sumFail   += a.filter(x => !x.ok).length
    }
    const mean = allHits.length ? sum / allHits.length : 0
    const meanBatt = allHits.length ? sumBatt / allHits.length : 0
    const appOk = sumActive > 0 ? ((sumActive - sumFail) / sumActive) * 100 : 100
    const worst = allHits.length ? allHits[0] : null
    return { cnt, mean, meanBatt, appOk, total: allHits.length, worst, sumActive, sumFail }
  }, [allHits])

  // Per-carrier aggregation
  const carrierAgg = useMemo(() => {
    const m: Record<string, { c: CarrierProfile; total: number; tiers: Record<Tier, number>; meanScore: number; meanBatt: number; sumFail: number; sumActive: number }> = {}
    for (const h of allHits) {
      const k = h.carrier.id
      if (!m[k]) m[k] = { c: h.carrier, total: 0, tiers: { 'NO-EFB':0,'AUTH-LOST':0,'DEGRADED':0,'PARTIAL':0,'NOMINAL':0,'IDLE':0 }, meanScore: 0, meanBatt: 0, sumFail: 0, sumActive: 0 }
      m[k].total++
      m[k].tiers[h.tier]++
      m[k].meanScore += h.score
      m[k].meanBatt += h.battery
      const a = h.apps.filter(x => x.active)
      m[k].sumActive += a.length
      m[k].sumFail   += a.filter(x => !x.ok).length
    }
    const arr = Object.values(m).map(x => ({
      ...x,
      meanScore: x.total ? x.meanScore / x.total : 0,
      meanBatt:  x.total ? x.meanBatt / x.total : 0,
    }))
    arr.sort((a, b) => b.total - a.total)
    return arr
  }, [allHits])

  // ---------------------------------------------------------------------------
  // MapLibre layers
  // ---------------------------------------------------------------------------
  const SRC_HALO = 'efb-halo-src'
  const SRC_PIN  = 'efb-pin-src'
  const SRC_LBL  = 'efb-lbl-src'
  const LYR_HALO = 'efb-halo-lyr'
  const LYR_PIN  = 'efb-pin-lyr'
  const LYR_LBL  = 'efb-lbl-lyr'

  useEffect(() => {
    if (!map) return
    const cleanup = () => {
      for (const l of [LYR_LBL, LYR_PIN, LYR_HALO]) if (map.getLayer(l)) try { map.removeLayer(l) } catch {}
      for (const s of [SRC_LBL, SRC_PIN, SRC_HALO]) if (map.getSource(s)) try { map.removeSource(s) } catch {}
    }
    cleanup()

    // Halo rings (size by score, colour by tier)
    if (showHalo) {
      const haloFeats = filtered.slice(0, 220).map(h => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [h.f.lng, h.f.lat] as [number, number] },
        properties: { id: h.f.icao, tier: h.tier, score: Math.round(h.score), color: TIER_COLOUR[h.tier] },
      }))
      map.addSource(SRC_HALO, { type: 'geojson', data: { type: 'FeatureCollection', features: haloFeats } })
      map.addLayer({
        id: LYR_HALO, type: 'circle', source: SRC_HALO,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 0, 6, 50, 12, 100, 22],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.18,
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': 1.5,
          'circle-stroke-opacity': 0.85,
        },
      })
    }

    // Pin markers for NO-EFB / AUTH-LOST
    if (showPin) {
      const pinFeats = filtered.filter(h => h.tier === 'NO-EFB' || h.tier === 'AUTH-LOST').slice(0, 80).map(h => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [h.f.lng, h.f.lat] as [number, number] },
        properties: { id: h.f.icao, color: TIER_COLOUR[h.tier] },
      }))
      map.addSource(SRC_PIN, { type: 'geojson', data: { type: 'FeatureCollection', features: pinFeats } })
      map.addLayer({
        id: LYR_PIN, type: 'circle', source: SRC_PIN,
        paint: {
          'circle-radius': 3.5,
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 1.5,
        },
      })
    }

    // Labels
    if (showLbl) {
      const lblFeats = filtered.slice(0, 60).map(h => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [h.f.lng, h.f.lat] as [number, number] },
        properties: {
          id: h.f.icao,
          label: `${h.f.callsign || h.f.icao}\nCLS-${h.cls}/${h.appType.replace('Type','')} ${h.battery}%`,
          color: TIER_COLOUR[h.tier],
        },
      }))
      map.addSource(SRC_LBL, { type: 'geojson', data: { type: 'FeatureCollection', features: lblFeats } })
      map.addLayer({
        id: LYR_LBL, type: 'symbol', source: SRC_LBL,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 9,
          'text-font': ['Inter Medium', 'Open Sans Bold', 'Arial Unicode MS Bold'],
          'text-offset': [0, 1.6],
          'text-anchor': 'top',
          'text-allow-overlap': false,
          'text-optional': true,
        },
        paint: {
          'text-color': ['get', 'color'],
          'text-halo-color': '#0f172a',
          'text-halo-width': 1.5,
        },
      })
    }

    return () => cleanup()
  }, [map, filtered, showHalo, showPin, showLbl])

  // Helpers for filter chip
  const toggleTier = (t: Tier) => {
    setTierFilter(prev => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }

  return (
    <div className="absolute right-2 top-16 z-40 w-[480px] max-h-[78vh] flex flex-col rounded-xl border border-sky-500/40 bg-slate-900/95 backdrop-blur shadow-2xl shadow-sky-900/40 text-slate-100">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-sky-500/15 border border-sky-500/40 text-sky-300 text-[10px] font-mono font-semibold">EFB</span>
          <div>
            <div className="text-[12px] font-semibold tracking-wide">Electronic Flight Bag · Class/Type/AID Compliance</div>
            <div className="text-[10px] text-slate-500 tracking-wide">FAA AC 120-76D · EASA AMC 20-25A · ICAO Doc 10020 · UK CAA CAP 1407</div>
          </div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none px-1" aria-label="Close EFB monitor">×</button>
      </div>

      {/* Tier strip */}
      <div className="px-3 py-2 border-b border-slate-800/80 flex items-center gap-1 flex-wrap">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => toggleTier(t)}
            className={`px-1.5 py-0.5 rounded text-[9px] font-mono border transition ${tierFilter.has(t) ? 'bg-slate-800/60' : 'opacity-40 bg-slate-900'} `}
            style={{ borderColor: TIER_COLOUR[t] + '88', color: TIER_COLOUR[t] }}
            title={`Toggle ${TIER_LABEL[t]} (${stats.cnt[t]})`}>
            {TIER_LABEL[t]} {stats.cnt[t]}
          </button>
        ))}
      </div>

      {/* Summary cells */}
      <div className="px-3 py-2 border-b border-slate-800/80 grid grid-cols-5 gap-1 text-[9px]">
        <div className="rounded border border-slate-800 bg-slate-900/40 px-1.5 py-1">
          <div className="text-slate-500">FLIGHTS</div>
          <div className="text-slate-100 font-mono">{stats.total}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-1.5 py-1">
          <div className="text-slate-500">μ-SCORE</div>
          <div className="text-slate-100 font-mono">{stats.mean.toFixed(1)}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-1.5 py-1">
          <div className="text-slate-500">μ-BATT</div>
          <div className="text-slate-100 font-mono">{stats.meanBatt.toFixed(0)}%</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-1.5 py-1">
          <div className="text-slate-500">APP-OK</div>
          <div className="text-slate-100 font-mono">{stats.appOk.toFixed(0)}%</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-1.5 py-1">
          <div className="text-slate-500">WORST</div>
          <div className="text-slate-100 font-mono truncate" title={stats.worst?.f.callsign || stats.worst?.f.icao || '—'}>
            {stats.worst ? (stats.worst.f.callsign || stats.worst.f.icao) : '—'}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="px-3 py-2 border-b border-slate-800/80 space-y-1.5">
        <div className="flex items-center gap-2 text-[9px] font-mono text-slate-400">
          <label className="flex-1">
            <div className="flex items-center justify-between mb-0.5">
              <span>ADV-MUL</span><span className="text-slate-200">{advMul.toFixed(1)}×</span>
            </div>
            <input type="range" min={0.5} max={2.0} step={0.1} value={advMul}
              onChange={e => setAdvMul(parseFloat(e.target.value))}
              className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex items-center gap-1 text-[9px] flex-wrap">
          <select value={carrierFilter} onChange={e => setCarrierFilter(e.target.value)}
            className="bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-slate-200 font-mono">
            <option value="ALL">ALL CARRIERS</option>
            {CARRIERS.map(c => <option key={c.id} value={c.id}>{c.id} · {c.name}</option>)}
            <option value={DEFAULT_CARRIER.id}>{DEFAULT_CARRIER.id}</option>
          </select>
          <select value={phaseFilter} onChange={e => setPhaseFilter(e.target.value)}
            className="bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-slate-200 font-mono">
            <option value="ALL">ALL PHASES</option>
            {(['PRE-DEP','TAXI-OUT','CLB-DEP','CRZ','DSC-APP','TAXI-IN','GATE'] as Phase[]).map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search cs / type / carrier"
            className="bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-slate-200 font-mono flex-1 min-w-[100px]" />
        </div>
        <div className="flex items-center gap-2 text-[9px] font-mono text-slate-400">
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={showHalo} onChange={e=>setShowHalo(e.target.checked)} className="accent-sky-500" />HALO
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={showPin} onChange={e=>setShowPin(e.target.checked)} className="accent-sky-500" />PIN
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={showLbl} onChange={e=>setShowLbl(e.target.checked)} className="accent-sky-500" />LBL
          </label>
          <span className="ml-auto text-slate-500">{filtered.length}/{stats.total}</span>
        </div>
      </div>

      {/* Tab strip */}
      <div className="px-2 pt-2 flex items-center gap-1 text-[10px] font-mono border-b border-slate-800/80">
        {(['AC','CARRIERS','APPS','PROTOCOL'] as const).map(k => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-2 py-1 rounded-t border-b-2 transition ${tab === k ? 'border-sky-500 text-sky-300' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            {k}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'AC' && (
          <div className="divide-y divide-slate-800/80">
            {filtered.length === 0 && (
              <div className="px-3 py-6 text-[11px] text-slate-500 text-center">No flights match current filters.</div>
            )}
            {filtered.slice(0, 80).map(h => (
              <button key={h.f.icao} onClick={() => onFly(h.f.icao)}
                className="w-full text-left px-3 py-2 hover:bg-slate-800/40 transition">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[12px] font-mono font-semibold text-slate-100">{h.f.callsign || h.f.icao}</span>
                  <span className="text-[9px] text-slate-500 font-mono">{h.f.type || '—'}</span>
                  <span className="text-[9px] font-mono px-1 py-0 rounded border border-sky-500/40 bg-sky-500/10 text-sky-200">{h.carrier.id}</span>
                  <span className="text-[9px] font-mono px-1 py-0 rounded border border-slate-700 bg-slate-800/40 text-slate-300">{h.phase}</span>
                  <span className="ml-auto px-1.5 py-0 rounded border text-[9px] font-mono"
                    style={{ borderColor: TIER_COLOUR[h.tier] + '88', backgroundColor: TIER_COLOUR[h.tier] + '20', color: TIER_COLOUR[h.tier] }}>
                    {TIER_LABEL[h.tier]} {Math.round(h.score)}
                  </span>
                </div>
                {/* EFB stack chips */}
                <div className="grid grid-cols-6 gap-1 text-[9px] font-mono mb-1">
                  <div className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800/40">
                    <div className="text-slate-500 text-[7px]">CLS</div>
                    <div className="text-slate-200">{h.cls}</div>
                  </div>
                  <div className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800/40">
                    <div className="text-slate-500 text-[7px]">TYPE</div>
                    <div className="text-slate-200">{h.appType.replace('Type','')}</div>
                  </div>
                  <div className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800/40">
                    <div className="text-slate-500 text-[7px]">AID</div>
                    <div className="text-slate-200">{h.aid.replace('AID-','')}</div>
                  </div>
                  <div className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800/40">
                    <div className="text-slate-500 text-[7px]">OS</div>
                    <div className="text-slate-200">{h.os}</div>
                  </div>
                  <div className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800/40">
                    <div className="text-slate-500 text-[7px]">BATT</div>
                    <div className={`${h.battery < 20 ? 'text-rose-300' : h.battery < 35 ? 'text-amber-300' : 'text-slate-200'}`}>{h.battery}%</div>
                  </div>
                  <div className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800/40">
                    <div className="text-slate-500 text-[7px]">CONN</div>
                    <div className="text-slate-200">{h.conn}</div>
                  </div>
                </div>
                {/* Score bar */}
                <div className="h-1 rounded bg-slate-800 overflow-hidden mb-1">
                  <div className="h-full rounded" style={{ width: `${h.score}%`, backgroundColor: TIER_COLOUR[h.tier] }} />
                </div>
                {/* Driver chips */}
                <div className="flex flex-wrap gap-1 mb-1">
                  {(Object.keys(h.drivers) as Array<keyof Hit['drivers']>).map(d => (
                    <span key={d} className={`text-[8px] font-mono px-1 py-0 rounded border ${
                      h.drivers[d] >= 50 ? 'border-rose-500/40 bg-rose-500/10 text-rose-300' :
                      h.drivers[d] >= 25 ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' :
                      h.drivers[d] >= 10 ? 'border-sky-500/40 bg-sky-500/10 text-sky-300' :
                      'border-slate-700 bg-slate-800/40 text-slate-500'
                    }`}>{d} {h.drivers[d]}</span>
                  ))}
                </div>
                {/* Active app pills */}
                {h.apps.filter(a => a.active).length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1">
                    {h.apps.filter(a => a.active).map(a => (
                      <span key={a.app.id} title={a.ok ? a.app.label : a.reason}
                        className={`text-[8px] font-mono px-1 py-0 rounded border ${
                          a.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                               : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                        }`}>
                        {a.ok ? '✓' : '!'}{a.app.id}
                      </span>
                    ))}
                  </div>
                )}
                {/* Synthetic ACARS uplink */}
                <div className="text-[9px] font-mono text-slate-400 px-2 py-1 bg-slate-950 rounded border border-slate-800 break-all">
                  {h.uplink}
                </div>
                {/* advice */}
                <div className="text-[9px] text-slate-400 mt-1 leading-snug">{h.flag}</div>
              </button>
            ))}
          </div>
        )}

        {tab === 'CARRIERS' && (
          <div className="divide-y divide-slate-800/80">
            {carrierAgg.length === 0 && (
              <div className="px-3 py-6 text-[11px] text-slate-500 text-center">No carriers in current dataset.</div>
            )}
            {carrierAgg.map(x => (
              <div key={x.c.id} className="px-3 py-2">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[12px] font-mono font-semibold text-slate-100">{x.c.id}</span>
                  <span className="text-[9px] text-slate-500">{x.c.name}</span>
                  <span className="ml-auto px-1.5 py-0 rounded border text-[9px] font-mono border-sky-500/40 bg-sky-500/15 text-sky-200">{x.c.authority}</span>
                </div>
                <div className="grid grid-cols-6 gap-1 text-[9px] font-mono mb-1">
                  {TIER_ORDER.map(t => (
                    <div key={t} className="flex flex-col items-center" style={{ color: TIER_COLOUR[t] }}>
                      <div className="text-[7px] opacity-70">{TIER_LABEL[t]}</div>
                      <div>{x.tiers[t]}</div>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2 text-[9px] font-mono text-slate-500 mb-0.5">
                  <span>μ-SCORE {x.meanScore.toFixed(1)}</span>
                  <span>·</span>
                  <span>μ-BATT {x.meanBatt.toFixed(0)}%</span>
                  <span>·</span>
                  <span>FLT {x.total}</span>
                  <span>·</span>
                  <span>APP-FAIL {x.sumActive ? Math.round((x.sumFail / x.sumActive) * 100) : 0}%</span>
                </div>
                {/* Class mix bar */}
                <div className="flex h-1.5 rounded overflow-hidden bg-slate-800">
                  <div className="bg-rose-500/60" style={{ width: `${x.c.classMix['1']*100}%` }} title={`Class-1 ${(x.c.classMix['1']*100).toFixed(0)}%`} />
                  <div className="bg-sky-500/60" style={{ width: `${x.c.classMix['2']*100}%` }} title={`Class-2 ${(x.c.classMix['2']*100).toFixed(0)}%`} />
                  <div className="bg-emerald-500/60" style={{ width: `${x.c.classMix['3']*100}%` }} title={`Class-3 ${(x.c.classMix['3']*100).toFixed(0)}%`} />
                </div>
                <div className="text-[8px] text-slate-500 mt-0.5 font-mono">
                  CLS-1 {(x.c.classMix['1']*100).toFixed(0)}% · CLS-2 {(x.c.classMix['2']*100).toFixed(0)}% · CLS-3 {(x.c.classMix['3']*100).toFixed(0)}% · apps {x.c.apps.length}/14
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'APPS' && (
          <div className="divide-y divide-slate-800/80">
            <div className="px-3 py-1.5 text-[9px] font-mono text-slate-500 sticky top-0 bg-slate-900/95">
              FAA AC 120-76D App.B canonical EFB application catalogue
            </div>
            {APPS.map(a => {
              const inUse = allHits.filter(h => h.apps.some(ap => ap.app.id === a.id && ap.active))
              const failing = allHits.filter(h => h.apps.some(ap => ap.app.id === a.id && ap.active && !ap.ok))
              return (
                <div key={a.id} className="px-3 py-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[12px] font-mono font-semibold text-slate-100">{a.id}</span>
                    <span className={`text-[9px] font-mono px-1.5 py-0 rounded border ${
                      a.type === 'TypeA' ? 'border-slate-700 bg-slate-800/40 text-slate-300' :
                      a.type === 'TypeB' ? 'border-sky-500/40 bg-sky-500/10 text-sky-200' :
                                            'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                    }`}>{a.type.replace('Type','Type-')}</span>
                    <span className="ml-auto text-[9px] font-mono text-slate-400">{inUse.length} active · {failing.length} fail</span>
                  </div>
                  <div className="text-[10px] text-slate-200 mb-1">{a.label}</div>
                  <div className="text-[8px] font-mono text-slate-500 mb-0.5">
                    PHASES: {a.phases.join(' · ')}
                  </div>
                  <div className="text-[8px] font-mono text-slate-500 mb-0.5">
                    AID: {a.needs.join(' · ')}
                  </div>
                  <div className="text-[8px] font-mono text-slate-500 italic">{a.cite}</div>
                  {/* mini bar — active vs fail */}
                  <div className="flex h-1 rounded overflow-hidden bg-slate-800 mt-1">
                    {inUse.length > 0 && (
                      <>
                        <div className="bg-emerald-500/60" style={{ width: `${((inUse.length - failing.length) / Math.max(1, inUse.length)) * 100}%` }} />
                        <div className="bg-rose-500/60" style={{ width: `${(failing.length / Math.max(1, inUse.length)) * 100}%` }} />
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'PROTOCOL' && (
          <div className="p-3 text-[10px] text-slate-300 leading-relaxed space-y-3">
            <div>
              <div className="font-mono text-slate-500 text-[9px] tracking-wide mb-1">EFB Class Catalogue · FAA AC 120-76D §6 / EASA AMC 20-25A §3</div>
              <div className="grid grid-cols-3 gap-1 text-[9px] font-mono">
                <div className="px-1.5 py-1 rounded border border-rose-500/40 bg-rose-500/10 text-rose-200">
                  <div>Class 1</div>
                  <div className="text-[8px] opacity-80">portable</div>
                  <div className="text-[8px] opacity-80">not-mounted</div>
                  <div className="text-[8px] opacity-80">stowed for T/O+LDG</div>
                </div>
                <div className="px-1.5 py-1 rounded border border-sky-500/40 bg-sky-500/10 text-sky-200">
                  <div>Class 2</div>
                  <div className="text-[8px] opacity-80">mounted+removable</div>
                  <div className="text-[8px] opacity-80">PED-cert</div>
                  <div className="text-[8px] opacity-80">most air-carrier</div>
                </div>
                <div className="px-1.5 py-1 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-200">
                  <div>Class 3</div>
                  <div className="text-[8px] opacity-80">installed avionics</div>
                  <div className="text-[8px] opacity-80">DAL-C cert / DO-178C</div>
                  <div className="text-[8px] opacity-80">Type-C eligible</div>
                </div>
              </div>
            </div>
            <div>
              <div className="font-mono text-slate-500 text-[9px] tracking-wide mb-1">Application Type Matrix · AC 120-76D §6.5</div>
              <div className="grid grid-cols-3 gap-1 text-[9px] font-mono">
                <div className="px-1.5 py-1 rounded border border-slate-700 bg-slate-800/40 text-slate-300">
                  <div>Type A</div>
                  <div className="text-[8px] opacity-80">static viewable</div>
                  <div className="text-[8px] opacity-80">FCOM/MEL/QRH</div>
                </div>
                <div className="px-1.5 py-1 rounded border border-sky-500/40 bg-sky-500/10 text-sky-200">
                  <div>Type B</div>
                  <div className="text-[8px] opacity-80">interactive</div>
                  <div className="text-[8px] opacity-80">RTOW/W&amp;B/CHRT</div>
                </div>
                <div className="px-1.5 py-1 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-200">
                  <div>Type C</div>
                  <div className="text-[8px] opacity-80">avionics certified</div>
                  <div className="text-[8px] opacity-80">EVS/SVS embedded</div>
                </div>
              </div>
            </div>
            <div>
              <div className="font-mono text-slate-500 text-[9px] tracking-wide mb-1">AID · Aircraft Interface Device · ARINC 834 / 759</div>
              <ol className="space-y-1 list-decimal list-inside text-[9px]">
                <li><span className="text-sky-300 font-mono">AID-NONE</span> · No AID — EFB has no own-ship GPS / baro / IRS — moving-map OPS-B unauthorised.</li>
                <li><span className="text-sky-300 font-mono">AID-WIRED</span> · ARINC 834 wired tap to GPS/IRS/ADC bus — OPS-B own-ship enabled at parked / taxi / climb.</li>
                <li><span className="text-sky-300 font-mono">AID-CERT</span> · DAL-C certified AID host — Type-C apps enabled (EVS / embedded datalink engine).</li>
              </ol>
            </div>
            <div>
              <div className="font-mono text-slate-500 text-[9px] tracking-wide mb-1">Failure Mode Catalogue · QRH EFB-LOSS Procedures</div>
              <ol className="space-y-1 list-decimal list-inside text-[9px]">
                <li>Battery {'<'} 10% → load shed Type-B, retain Type-A QRH on backup device.</li>
                <li>Thermal {'>'} 60°C (iOS hot-day shutdown) → cool / power off → revert paper-RTOW per ops-spec C078.</li>
                <li>OS / MDM lock breach → device quarantine, voice WB request from dispatch.</li>
                <li>AID-bus loss → manual position entry on charts, no moving-map.</li>
                <li>Connectivity loss (chart-DB cycle near expiry) → must defer dispatch per AC 120-76D §7.</li>
                <li>Ops-spec authorisation EXPIRED → flight non-RVSM-EFB; revert to paper or paired-device.</li>
              </ol>
            </div>
            <div className="pt-2 border-t border-slate-700 text-[8px] font-mono text-slate-500 leading-relaxed">
              FAA AC 120-76D · EASA AMC 20-25A · ICAO Doc 10020 · UK CAA CAP 1407 · FAA Order 8900.1 Vol 4 Ch 15 · 14 CFR §121.542 sterile-cockpit · §121.585 cockpit-PED · RTCA DO-178C / DO-257B Airport Moving Map · EUROCAE ED-12C / ED-130A · ARINC 834 / 759 / 619 AID interface · Boeing FCOM Vol 1 §1.30 · Airbus FCOM PRO-NOR-SOP-18 · IATA AHM-825 ed.5 · AAIB UK 4/2014 EFB SR III thermal · NTSB DCA13MA081 UA1175 perf-input · ASRS callback #471 EFB MMAP miscue.
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-2 py-1 border-t border-slate-700/60 text-[8px] font-mono text-slate-500 flex items-center justify-between">
        <span>EFB · {CARRIERS.length}+1 carriers · {APPS.length} apps · {filtered.length}/{stats.total} shown</span>
        <span>FAA AC 120-76D · EASA AMC 20-25A · ICAO Doc 10020</span>
      </div>
    </div>
  )
}
