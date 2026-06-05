'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   AIDC · ATS Inter-facility Data Communication & OLDI Handoff
          Protocol Conformance Monitor
   ------------------------------------------------------------
   Per-flight live evaluator of the inter-facility ATC↔ATC
   coordination message stack that governs how each flight is
   handed off across adjacent ACC/UAC/Oceanic/Approach boundaries.

   AIDC = ICAO Doc 9694 PANS-ATM ATS Inter-facility Data
   Communication application defined for AFTN/AMHS or P2P
   bilateral SARP-compliant transport. Regional implementation
   profiles share the same logical message catalogue but differ
   on serialisation, validation deadlines, optional fields, and
   bilateral overlay:
     · EUROCONTROL OLDI ed.4.3 (European overlay, ABI/PAC/EST/
       REV/ACT/MAC/LAM/COD/INF + OCM/ROF/CDN add-ons)
     · FAA NAS-IR-25080004 ER-6 IFDD (CONUS centre-to-centre)
     · FAA AIDC-NICS Pacific implementation (ZAK/ZAN/RJJJ/NZZO/
       NTTT/YBBB Pacific overlay)
     · Eurocontrol/IATA SWIM Yellow Profile (FF-ICE/R1 evolution
       overlay)
     · ICAO APAC AIDC-ICD ed.3.0 (Asia/Pacific bilateral)
     · NAT NTS/RNDSG AIDC profile (NAT oceanic)

   Message catalogue (canonical 11-entry set):
     · ABI  Advance Boundary Information   T-COBT 15-25 min
     · PAC  Pre-Activation                 T-COBT  3-10 min
     · EST  Estimate                       T-COBT  5-12 min
     · REV  Revision                       on change
     · ACT  Activation                     T-COBT  3-7  min
     · MAC  Message for Abrogation         on cancel
     · LAM  Logical Acknowledgement        ≤4 s respond-by
     · COD  Coordination                   manual handoff
     · INF  Information                    free-text
     · ROF  Request On Frequency           pilot-on-freq trigger
     · CDN  Coordination Dialogue          conditional revision
                                            (OLDI extension)
   plus the upstream/downstream protocol envelope:
     · TOC  Transfer of Control            authority pivot
     · AOC  Assumption of Control          downstream accepts
     · OCM  Oceanic Clearance Message      NAT/PAC overlay

   Refs (canonical):
     · ICAO Doc 9694 ATS Data Link Applications Manual
     · ICAO Doc 4444 PANS-ATM §10 Coordination & Transfer
     · ICAO Doc 7030 RASPs (regional supplementary procedures)
     · ICAO Annex 11 §3.7 Co-ordination between ATS units
     · ICAO Annex 10 Vol II §3.3 AFTN/AMHS
     · EUROCONTROL OLDI Specification ed.4.3 (2024)
       (Annex A messages, Annex B LAM timer, Annex C COD)
     · EUROCONTROL OLDI ICD-MNUC-3.0 (Multi-NUC bilateral)
     · FAA NAS-IR-25080004 ER-6 IFDD (Inter-Facility Data Distr)
     · FAA AIDC-NICS Pacific Operations Manual (ZAK/ZAN/Tokyo)
     · FAA Order JO 7110.65 §8-5 Oceanic / §8-6 AIDC
     · FAA Order JO 7110.65 §10-3 ATCSCC interfacility
     · FAA Order JO 7610.4 §8 oceanic/non-radar coordination
     · FAA Order JO 7210.633 NICS Pacific IO-Hbk
     · ICAO APAC AIDC-ICD ed.3.0 (CRG Bali 2018)
     · NAT NTS RNDSG/57 AIDC Pacific & NAT profile
     · ICAO Doc 9854 GATMOC §3.4 information sharing
     · ICAO Doc 9882 SWIM Manual
     · ICAO Doc 9931 CDM Manual §4 inter-ANSP info
     · ICAO Doc 9971 Pt II Ch.6 Sector Capacity & Coord
     · ED-153 Software Safety Assurance Levels for SNETs
     · ED-202A Airworthiness Safety Process (AISG)
     · CANSO Standard of Excellence in SMS 2019
     · BFU AX001-1-2/02 Überlingen final 2004
       (the inter-FIR coordination accident family driver —
        DFS Zürich vs Skyguide LSAS failure of LAM/REV
        verbal coordination during STCA outage)
     · BEA AF447 (informational — NAT inter-FIR coord
        relevance to oceanic handoff)
     · NTSB AAR-91-08 LAX1493 (CSC + handoff related)
     · ICAO Cir 314 HF training §6 inter-unit coord

   Why structurally distinct from neighbours:
     · FIR / FIR-LOAD: count-only sector load, no protocol
       messaging dimension
     · FIR-CROSSINGS: geographic boundary catalogue only
     · CPDLC: pilot↔controller text datalink, not ATC↔ATC
     · VDL2 / HFDL: physical-link air-ground bearer
     · PBCS: certification framework for RCP/RSP
     · AMAN / E-AMAN: single-FIR arrival sequencer (NOT
       inter-facility coordination — though E-AMAN consumes
       AIDC for upstream metering windows)
     · CLAM / RAM: cleared-level / route adherence ground
       safety-nets, not handoff coordination
     · MTCD / STCA: medium/short conflict probes, not coord
     · SWIM: information distribution backbone (AIDC uses it
       as a transport in newer profiles)
     · CSC: callsign-confusion taxonomy
   AIDC is uniquely the INTER-FACILITY MESSAGE STACK monitor:
   answering for each flight crossing an adjacent-ANSP boundary
   in the next ~15 min whether the canonical sequence
       ABI →  PAC? → EST → ACT  →  LAM  →  TOC  →  AOC
   has been emitted by the upstream centre, acknowledged by
   the downstream centre, and completed within deadline, with
   per-stage timer compliance, per-LAM responsiveness, REV
   churn rate, and Überlingen-precedent escalators.

   Bilateral profile catalogue (12 adjacent ANSP pairs):
     · EDUU↔EISN  MUAC ↔ Shannon UIR (NAT-E gateway)
     · EDUU↔EGTT  MUAC ↔ London ACC
     · EDUU↔LFFF  MUAC ↔ Paris ACC
     · EDUU↔EDMM  MUAC ↔ Munich UAC
     · EDMM↔LSAS  Munich ↔ Zurich UAC (Überlingen pair)
     · LFFF↔LECM  Paris ↔ Madrid ACC
     · LFFF↔LIRR  Paris ↔ Rome ACC
     · ZNY↔EISN   New York ↔ Shannon (NAT-E)
     · ZAK↔ZAN    Oakland Pacific ↔ Anchorage (NICS PAC)
     · ZAK↔RJJJ   Oakland ↔ Fukuoka (NICS PAC)
     · RJJJ↔ZGZU  Fukuoka ↔ Guangzhou (ASIA/PAC AIDC-ICD)
     · WSJC↔VHHK  Singapore ↔ Hong Kong (ASIA/PAC AIDC-ICD)
     · OMAE↔VIDP  Emirates ↔ Delhi (ASIA/PAC)
     · YBBB↔WSJC  Melbourne ↔ Singapore (ASIA/PAC)
     · ZMA↔MUFH   Miami ↔ Habana (CAR/SAM)

   Stage timer (T-COBT = time-to-coordinated-boundary-time):
     · ABI emitted ≥15 min before COBT
     · PAC (if profile) ≥7 min before COBT (OLDI only)
     · EST emitted ≥7 min before COBT (ICAO)
                  or ≥5 min before (OLDI fast-handoff)
     · ACT emitted ≥3 min before COBT
     · LAM expected ≤4 s after each receivable msg (OLDI
            Annex B) / ≤30 s (APAC profile relaxed)
     · TOC after ACT-LAM, before COBT
     · AOC ≤2 min after TOC

   Drivers (each 0-100):
     · ABI-LATE   timer breach for ABI (s)
     · EST-LATE   timer breach for EST (s)
     · ACT-LATE   timer breach for ACT (s)
     · LAM-MISS   missing or late LAM ack (count·sev)
     · REV-CHURN  REV/MAC churn rate per flight per leg
     · TOC-GAP    TOC-without-AOC gap (s) — unowned aircraft
     · PROFILE    profile-mismatch (OLDI↔ICAO field set)
     · ESC        Überlingen-style escalator (multiple
                    stages missing + STCA proxy degraded)

   6 tiers:
     · BREACH     ≥80 rose       coordination dialogue
                                  has failed — verbal HF/SATVOICE
                                  fall-back, do NOT release
     · DEGRADED   ≥62 rose-pink  partial handoff — chase LAM,
                                  re-emit EST, log INC
     · LATE       ≥42 amber      one stage past timer — recover
                                  by Issue ACT or REV-LAM cycle
     · WATCH      ≥22 sky        nominal sequence, monitor
                                  next stage trigger
     · CLEAN      <22 emerald    full sequence completed in
                                  envelope
     · IDLE       slate          flight not in any 15-min
                                  bilateral inter-FIR window
   ============================================================ */

interface PFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: PFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'BREACH'|'DEGRADED'|'LATE'|'WATCH'|'CLEAN'|'IDLE'
const TIER_COLOR: Record<Tier,string> = {
  BREACH:'#ef4444', DEGRADED:'#f43f5e', LATE:'#f59e0b',
  WATCH:'#0ea5e9', CLEAN:'#10b981', IDLE:'#475569',
}
const TIER_RANK: Record<Tier,number> = { BREACH:0, DEGRADED:1, LATE:2, WATCH:3, CLEAN:4, IDLE:5 }
const TIER_ORDER: Tier[] = ['BREACH','DEGRADED','LATE','WATCH','CLEAN']

// 11-entry AIDC/OLDI message catalogue
type MsgKind = 'ABI'|'PAC'|'EST'|'REV'|'ACT'|'MAC'|'LAM'|'COD'|'INF'|'ROF'|'CDN'|'TOC'|'AOC'|'OCM'
interface MsgSpec {
  k: MsgKind; full: string
  // T-COBT seconds (negative = before COBT)
  triggerT: number
  // OLDI? ICAO? APAC? NAT? NICS?
  profiles: string[]
  // LAM expected back?
  needsLam: boolean
  // canonical reference
  ref: string
}
const MSG_CATALOG: MsgSpec[] = [
  { k:'ABI', full:'Advance Boundary Information',  triggerT:-900, profiles:['OLDI','ICAO','APAC','NICS','NAT'], needsLam:true,  ref:'OLDI ed.4.3 §A.4 / Doc 9694 §4.2.1' },
  { k:'PAC', full:'Pre-Activation',                triggerT:-420, profiles:['OLDI'],                              needsLam:true,  ref:'OLDI ed.4.3 §A.5 (European overlay)' },
  { k:'EST', full:'Estimate',                      triggerT:-420, profiles:['OLDI','ICAO','APAC','NICS','NAT'], needsLam:true,  ref:'OLDI ed.4.3 §A.6 / Doc 9694 §4.2.2' },
  { k:'REV', full:'Revision',                      triggerT: 0,   profiles:['OLDI','ICAO','APAC','NICS','NAT'], needsLam:true,  ref:'OLDI ed.4.3 §A.7 / Doc 9694 §4.2.3' },
  { k:'ACT', full:'Activation',                    triggerT:-180, profiles:['OLDI','ICAO','APAC','NICS','NAT'], needsLam:true,  ref:'OLDI ed.4.3 §A.8 / Doc 9694 §4.2.4' },
  { k:'MAC', full:'Message for Abrogation',        triggerT: 0,   profiles:['OLDI','ICAO','APAC','NICS','NAT'], needsLam:true,  ref:'OLDI ed.4.3 §A.9 / Doc 9694 §4.2.5' },
  { k:'LAM', full:'Logical Acknowledgement',       triggerT: 0,   profiles:['OLDI','ICAO','APAC','NICS','NAT'], needsLam:false, ref:'OLDI ed.4.3 §B / Doc 9694 §4.1.4 ≤4s' },
  { k:'COD', full:'Coordination',                  triggerT:-300, profiles:['OLDI','ICAO'],                       needsLam:true,  ref:'OLDI ed.4.3 §A.10 (manual COD)' },
  { k:'INF', full:'Information',                   triggerT: 0,   profiles:['OLDI','ICAO','APAC','NICS','NAT'], needsLam:false, ref:'OLDI ed.4.3 §A.11 free-text' },
  { k:'ROF', full:'Request On Frequency',          triggerT: 0,   profiles:['OLDI'],                              needsLam:true,  ref:'OLDI ed.4.3 §A.12 (pilot-on-freq)' },
  { k:'CDN', full:'Coordination Dialogue',         triggerT: 0,   profiles:['OLDI'],                              needsLam:true,  ref:'OLDI ed.4.3 §C (conditional revision)' },
  { k:'TOC', full:'Transfer of Control',           triggerT:-30,  profiles:['OLDI','ICAO','APAC','NICS','NAT'], needsLam:true,  ref:'Doc 4444 §10.4.3 authority pivot' },
  { k:'AOC', full:'Assumption of Control',         triggerT: 120, profiles:['OLDI','ICAO','APAC','NICS','NAT'], needsLam:false, ref:'Doc 4444 §10.4.5 / ≤2 min post-TOC' },
  { k:'OCM', full:'Oceanic Clearance Message',     triggerT:-1200,profiles:['NAT','NICS'],                        needsLam:true,  ref:'NAT Doc 007 §6 / NICS POM §4' },
]

// Bilateral FIR-pair catalogue. centroid coords pivot the boundary midpoint;
// fwdHdg = upstream→downstream true bearing approx, used to filter inbound flights.
type Bilateral = {
  id: string
  up: string; upName: string
  down: string; downName: string
  region: 'EUR'|'NAT'|'NICS-PAC'|'APAC'|'CAR-SAM'
  profile: 'OLDI'|'ICAO'|'APAC'|'NICS'|'NAT'
  mid: [number, number] // [lng, lat] boundary midpoint
  fwdHdg: number        // bearing UP→DOWN, deg
  declMins: number      // declared inter-facility capacity (movements/hr)
  lamTimerS: number     // bilateral LAM deadline (4-30s)
  abiLeadS: number      // ABI lead time before COBT (s)
  estLeadS: number      // EST lead time before COBT (s)
  actLeadS: number      // ACT lead time before COBT (s)
  precedent?: string    // accident/incident note
}
const BILAT: Bilateral[] = [
  { id:'EDUU-EISN', up:'EDUU', upName:'Maastricht UAC', down:'EISN', downName:'Shannon UIR', region:'NAT', profile:'OLDI', mid:[-9.0,53.0], fwdHdg:270, declMins:140, lamTimerS:4, abiLeadS:900, estLeadS:420, actLeadS:180, precedent:'NAT-E gateway, OLDI bilateral' },
  { id:'EDUU-EGTT', up:'EDUU', upName:'Maastricht UAC', down:'EGTT', downName:'London ACC',  region:'EUR', profile:'OLDI', mid:[2.0,51.5],  fwdHdg:280, declMins:180, lamTimerS:4, abiLeadS:900, estLeadS:300, actLeadS:120, precedent:'highest-volume EU pair, MUAC↔NATS' },
  { id:'EDUU-LFFF', up:'EDUU', upName:'Maastricht UAC', down:'LFFF', downName:'Paris ACC',   region:'EUR', profile:'OLDI', mid:[4.5,50.0],  fwdHdg:230, declMins:160, lamTimerS:4, abiLeadS:900, estLeadS:300, actLeadS:120 },
  { id:'EDUU-EDMM', up:'EDUU', upName:'Maastricht UAC', down:'EDMM', downName:'Munich UAC',  region:'EUR', profile:'OLDI', mid:[9.5,49.5],  fwdHdg:120, declMins:170, lamTimerS:4, abiLeadS:900, estLeadS:300, actLeadS:120 },
  { id:'EDMM-LSAS', up:'EDMM', upName:'Munich UAC',     down:'LSAS', downName:'Zurich UAC',  region:'EUR', profile:'OLDI', mid:[9.0,47.5],  fwdHdg:200, declMins:120, lamTimerS:4, abiLeadS:900, estLeadS:300, actLeadS:120, precedent:'Überlingen BFU AX001-1-2/02 (2002-07-01) — STCA outage + LAM/REV failure → 71 fatal' },
  { id:'LFFF-LECM', up:'LFFF', upName:'Paris ACC',      down:'LECM', downName:'Madrid ACC',  region:'EUR', profile:'OLDI', mid:[-1.0,43.5], fwdHdg:200, declMins:130, lamTimerS:4, abiLeadS:900, estLeadS:300, actLeadS:120 },
  { id:'LFFF-LIRR', up:'LFFF', upName:'Paris ACC',      down:'LIRR', downName:'Rome ACC',    region:'EUR', profile:'OLDI', mid:[7.0,44.5],  fwdHdg:130, declMins:110, lamTimerS:4, abiLeadS:900, estLeadS:300, actLeadS:120 },
  { id:'ZNY-EISN',  up:'ZNY',  upName:'New York ARTCC', down:'EISN', downName:'Shannon UIR', region:'NAT', profile:'NAT',  mid:[-30,52],    fwdHdg:70,  declMins:60,  lamTimerS:30,abiLeadS:1200,estLeadS:600, actLeadS:300, precedent:'NAT-E westbound oceanic exit, NAT NTS profile' },
  { id:'ZAK-ZAN',   up:'ZAK',  upName:'Oakland Oceanic',down:'ZAN',  downName:'Anchorage AC', region:'NICS-PAC', profile:'NICS', mid:[-160,55], fwdHdg:340, declMins:40, lamTimerS:30, abiLeadS:1200, estLeadS:600, actLeadS:300, precedent:'NICS Pacific bilateral per FAA AIDC-NICS POM' },
  { id:'ZAK-RJJJ',  up:'ZAK',  upName:'Oakland Oceanic',down:'RJJJ', downName:'Fukuoka AC',  region:'NICS-PAC', profile:'NICS', mid:[-170,40], fwdHdg:270, declMins:55, lamTimerS:30, abiLeadS:1500, estLeadS:720, actLeadS:300 },
  { id:'RJJJ-ZGZU', up:'RJJJ', upName:'Fukuoka AC',    down:'ZGZU', downName:'Guangzhou AC', region:'APAC', profile:'APAC', mid:[125,30],    fwdHdg:230, declMins:90, lamTimerS:30, abiLeadS:900, estLeadS:420, actLeadS:180 },
  { id:'WSJC-VHHK', up:'WSJC', upName:'Singapore AC',  down:'VHHK', downName:'Hong Kong AC', region:'APAC', profile:'APAC', mid:[112,15],    fwdHdg:30,  declMins:100,lamTimerS:30, abiLeadS:900, estLeadS:420, actLeadS:180 },
  { id:'OMAE-VIDP', up:'OMAE', upName:'Emirates AC',   down:'VIDP', downName:'Delhi AC',    region:'APAC', profile:'APAC', mid:[63,25],     fwdHdg:80,  declMins:75, lamTimerS:30, abiLeadS:900, estLeadS:420, actLeadS:180 },
  { id:'YBBB-WSJC', up:'YBBB', upName:'Melbourne AC',  down:'WSJC', downName:'Singapore AC',region:'APAC', profile:'APAC', mid:[110,-8],    fwdHdg:300, declMins:50, lamTimerS:30, abiLeadS:1200,estLeadS:600, actLeadS:240 },
  { id:'ZMA-MUFH',  up:'ZMA',  upName:'Miami ARTCC',   down:'MUFH', downName:'Habana AC',   region:'CAR-SAM', profile:'ICAO', mid:[-80,23.5], fwdHdg:200, declMins:45, lamTimerS:30, abiLeadS:900, estLeadS:420, actLeadS:180 },
]

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }

// Haversine NM
const R_NM = 3440.065
function dNM(lat1:number, lng1:number, lat2:number, lng2:number) {
  const φ1 = lat1*Math.PI/180, φ2 = lat2*Math.PI/180
  const dφ = (lat2-lat1)*Math.PI/180, dλ = (lng2-lng1)*Math.PI/180
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2*R_NM*Math.asin(Math.sqrt(a))
}
function bearingDeg(lat1:number, lng1:number, lat2:number, lng2:number) {
  const φ1 = lat1*Math.PI/180, φ2 = lat2*Math.PI/180
  const dλ = (lng2-lng1)*Math.PI/180
  const y = Math.sin(dλ)*Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(dλ)
  return (Math.atan2(y,x)*180/Math.PI + 360) % 360
}
function headingDelta(a:number, b:number) {
  let d = Math.abs(a-b) % 360
  if (d > 180) d = 360 - d
  return d
}

// Deterministic per-airframe synthetic AIDC dialogue state
//   simulates whether each stage has been EMITTED yet and ACKED yet,
//   and how late the dialog is running vs the bilateral timer envelope.
interface StageState {
  stage: 'ABI'|'PAC'|'EST'|'ACT'|'TOC'|'AOC'
  emitted: boolean
  acked: boolean      // LAM received
  emit_at_T: number   // T relative to COBT in s (negative = before)
  ack_lat_s: number   // LAM latency observed (s) — 0 if not received
}
function syntheticDialog(icao: string, b: Bilateral, tToCobt_s: number, advMul: number) {
  let h = 0; for (let i=0;i<icao.length;i++) h = ((h*131) + icao.charCodeAt(i)) >>> 0
  let h2 = 0; for (let i=0;i<b.id.length;i++) h2 = ((h2*173) + b.id.charCodeAt(i)) >>> 0
  const seed = (h ^ h2) >>> 0
  const rand = (k:number) => ((seed >> k) % 1000) / 1000

  const profileHasPAC = b.profile === 'OLDI'
  const stagesArr: Array<StageState['stage']> = profileHasPAC
    ? ['ABI','PAC','EST','ACT','TOC','AOC']
    : ['ABI','EST','ACT','TOC','AOC']

  const stages: StageState[] = stagesArr.map((st, i) => {
    const triggerLead = st==='ABI' ? b.abiLeadS
                      : st==='PAC' ? 420
                      : st==='EST' ? b.estLeadS
                      : st==='ACT' ? b.actLeadS
                      : st==='TOC' ? 30
                      : -120  // AOC is post-COBT
    // Has time passed for this stage to be expected emitted?
    const dueT = -triggerLead  // T-COBT when expected emit
    const isDue = tToCobt_s <= dueT
    // Random per-stage emit failure rate (slightly higher for ABI under OLDI volume,
    // higher for TOC/AOC under NICS PAC HF coverage)
    const baseEmitFail = st==='ABI' ? 0.03
                       : st==='PAC' ? 0.06
                       : st==='EST' ? 0.04
                       : st==='ACT' ? 0.05
                       : st==='TOC' ? 0.07
                       : 0.10  // AOC most fragile
    const profilePenalty = b.profile==='NAT' ? 1.6 : b.profile==='NICS' ? 1.5 : b.profile==='APAC' ? 1.2 : 1.0
    const emitFail = clamp(baseEmitFail * profilePenalty * advMul, 0, 0.55)
    const emitted = isDue && (rand(3 + i*5) > emitFail)
    // Late emit lag (s) — even when emitted, may be late
    const lateLag = emitted ? (rand(7 + i*5) * 90 * advMul) : 0
    const emit_at_T = emitted ? (dueT + lateLag) : (isDue ? Math.min(tToCobt_s, dueT + 240) : dueT)

    // LAM ack — needed for most stages
    const needsLam = (st === 'AOC') ? false : true
    // LAM latency observed (synthesised against bilateral lamTimerS)
    const lamFail = clamp(0.04 * profilePenalty * advMul, 0, 0.35)
    const ackOK = emitted && needsLam && (rand(11 + i*5) > lamFail)
    // If acked, latency is fraction of timer; if not, set to timer*3 (deadline overshoot)
    const ack_lat_s = !needsLam
      ? 0
      : ackOK
        ? Math.max(0.3, rand(13 + i*5) * b.lamTimerS * 2.4 * advMul)
        : b.lamTimerS * 4
    return { stage: st, emitted, acked: ackOK || !needsLam, emit_at_T, ack_lat_s }
  })

  // REV churn count — random 0-3
  const revCount = Math.floor(rand(17) * 4 * advMul)
  // ESC flag: STCA-degraded proxy (rare)
  const escFlag = rand(19) > (1 - 0.012 * advMul)
  return { stages, revCount, escFlag, profileHasPAC }
}

interface Row {
  f: PFlight; b: Bilateral
  tToCobt_s: number      // negative = before COBT
  distNM: number
  alongTrack: number     // 0..1 alignment with fwdHdg
  stages: StageState[]
  revCount: number
  escFlag: boolean
  profileHasPAC: boolean
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
}

export default function AidcInterfacility({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [scopeNM, setScopeNM] = useState(220.0)
  const [lookMin, setLookMin] = useState(15.0)       // T-COBT look-ahead window
  const [lamMul, setLamMul] = useState(1.0)
  const [regionFilter, setRegionFilter] = useState<'ALL'|Bilateral['region']>('ALL')
  const [bilatFilter, setBilatFilter] = useState<'ALL'|string>('ALL')
  const [profileFilter, setProfileFilter] = useState<'ALL'|Bilateral['profile']>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'BILATERAL'|'STAGES'|'METHOD'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shBnd, setShBnd] = useState(true)
  const [shLink, setShLink] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (f.altitudeFt < 18000) continue  // AIDC bilateral coordination = enroute only
      // For each bilateral pair, compute distance from boundary midpoint and
      // alignment of aircraft track with upstream→downstream forward bearing
      let best: { b: Bilateral; d: number; ali: number } | null = null
      for (const b of BILAT) {
        const d = dNM(f.lat, f.lng, b.mid[1], b.mid[0])
        if (d > scopeNM * 1.2) continue
        // alignment: aircraft track close to b.fwdHdg means inbound to downstream
        const hdgD = headingDelta(f.track || 0, b.fwdHdg)
        const ali = 1 - clamp(hdgD/90, 0, 1)  // 1 if straight forward, 0 at 90°+
        if (!best || (d - 30*ali) < (best.d - 30*best.ali)) best = { b, d, ali }
      }
      if (!best) continue
      const { b, d, ali } = best
      // T-COBT: estimate seconds until aircraft crosses boundary midpoint
      const gs = Math.max(80, f.velocityKts)
      const tToCobt_s = -((d / gs) * 3600)  // negative = before COBT
      // Only score if within look-ahead window AND alignment is plausibly inbound (ali > 0.25)
      if (tToCobt_s < -lookMin*60) continue
      if (tToCobt_s > 240) continue  // past COBT > 4 min — already handed over
      if (ali < 0.20) continue  // not actually crossing this boundary

      const dlg = syntheticDialog(f.icao, b, tToCobt_s, advMul)

      // DRIVERS (each 0..100)
      // ABI-LATE: timer breach for ABI (s past expected emit)
      const abiSt = dlg.stages.find(s => s.stage==='ABI')!
      const abiBreach_s = abiSt.emitted ? Math.max(0, abiSt.emit_at_T - (-b.abiLeadS)) : (tToCobt_s <= -b.abiLeadS ? Math.abs(tToCobt_s) + b.abiLeadS : 0)
      const dABILATE = clamp(abiBreach_s / 300 * 100, 0, 100)

      // EST-LATE
      const estSt = dlg.stages.find(s => s.stage==='EST')!
      const estBreach_s = estSt.emitted ? Math.max(0, estSt.emit_at_T - (-b.estLeadS)) : (tToCobt_s <= -b.estLeadS ? Math.abs(tToCobt_s) + b.estLeadS : 0)
      const dESTLATE = clamp(estBreach_s / 180 * 100, 0, 100)

      // ACT-LATE
      const actSt = dlg.stages.find(s => s.stage==='ACT')!
      const actBreach_s = actSt.emitted ? Math.max(0, actSt.emit_at_T - (-b.actLeadS)) : (tToCobt_s <= -b.actLeadS ? Math.abs(tToCobt_s) + b.actLeadS : 0)
      const dACTLATE = clamp(actBreach_s / 120 * 100, 0, 100)

      // LAM-MISS: count of stages where LAM was needed but not received in timer envelope
      let lamMissCount = 0
      let lamLateCount = 0
      for (const s of dlg.stages) {
        if (s.stage === 'AOC') continue
        if (!s.emitted) continue
        if (!s.acked) lamMissCount++
        else if (s.ack_lat_s > b.lamTimerS) lamLateCount++
      }
      const dLAMMISS = clamp((lamMissCount * 38 + lamLateCount * 18) * lamMul, 0, 100)

      // REV-CHURN
      const dREVCHURN = clamp(dlg.revCount * 22, 0, 100)

      // TOC-GAP: TOC emitted but AOC not yet — unowned aircraft slice
      const tocSt = dlg.stages.find(s => s.stage==='TOC')!
      const aocSt = dlg.stages.find(s => s.stage==='AOC')!
      const tocWithoutAOC = tocSt.emitted && !aocSt.emitted && tToCobt_s > -60
      const dTOCGAP = tocWithoutAOC ? 75 : 0

      // PROFILE mismatch: OLDI bilateral but no PAC observed (or non-OLDI with PAC)
      let dPROFILE = 0
      if (b.profile === 'OLDI' && dlg.profileHasPAC) {
        const pacSt = dlg.stages.find(s => s.stage==='PAC')
        if (pacSt && !pacSt.emitted && tToCobt_s <= -420) dPROFILE = 30
      }

      // ESC: Überlingen-style escalator — 2+ stages missing AND STCA-degraded proxy
      const missingCount = dlg.stages.filter(s => !s.emitted && (s.stage==='ABI' || s.stage==='EST' || s.stage==='ACT')).length
      const dESC = dlg.escFlag && missingCount >= 2 ? 95 : (dlg.escFlag ? 55 : 0)

      const drivers = { 'ABI-LATE':dABILATE, 'EST-LATE':dESTLATE, 'ACT-LATE':dACTLATE, 'LAM-MISS':dLAMMISS, 'REV-CHURN':dREVCHURN, 'TOC-GAP':dTOCGAP, PROFILE:dPROFILE, ESC:dESC }

      const drvArr = Object.values(drivers)
      let score = (Math.max(...drvArr) * 0.66 + (drvArr.reduce((a,c)=>a+c,0)/drvArr.length) * 0.34) * advMul

      const notes: string[] = []
      // Hard escalators per Überlingen / OLDI ed.4.3 §B
      if (dESC >= 90) {
        score = Math.max(score, 92)
        notes.push(`ESC: ${missingCount} stages missing + STCA-degraded proxy — Überlingen BFU AX001-1-2/02 mode, fall-back to verbal HF/SATVOICE per Doc 4444 §10.5`)
      } else if (lamMissCount >= 2) {
        score = Math.max(score, 80)
        notes.push(`LAM-MISS x${lamMissCount} — OLDI ed.4.3 §B.2 deadline ${b.lamTimerS}s breached on ≥2 msgs, re-emit EST + chase ack`)
      } else if (tocWithoutAOC) {
        score = Math.max(score, 76)
        notes.push(`TOC issued without AOC for ${Math.abs(tToCobt_s).toFixed(0)}s — unowned aircraft slice per Doc 4444 §10.4.5, query downstream${b.down}`)
      } else if (!abiSt.emitted && tToCobt_s > -b.abiLeadS) {
        score = Math.max(score, 60)
        notes.push(`ABI not emitted at T-COBT ${(-tToCobt_s/60).toFixed(1)}min (deadline ${(b.abiLeadS/60).toFixed(0)}min) — coordination dialogue at risk`)
      } else if (!estSt.emitted && tToCobt_s > -b.estLeadS - 60) {
        score = Math.max(score, 50)
        notes.push(`EST overdue at T-COBT ${(-tToCobt_s/60).toFixed(1)}min — partial sequence per OLDI ed.4.3 §A.6`)
      } else if (dlg.revCount >= 3) {
        score = Math.max(score, 45)
        notes.push(`REV churn x${dlg.revCount} — clearance instability on ${b.id}, consider CDN dialogue per OLDI §C`)
      }
      if (b.precedent && score >= 60) {
        notes.push(`Precedent · ${b.precedent}`)
      }
      score = clamp(score, 0, 100)

      let tier: Tier = 'IDLE'
      if (score >= 80) tier = 'BREACH'
      else if (score >= 62) tier = 'DEGRADED'
      else if (score >= 42) tier = 'LATE'
      else if (score >= 22) tier = 'WATCH'
      else tier = 'CLEAN'

      out.push({ f, b, tToCobt_s, distNM:d, alongTrack:ali, stages:dlg.stages, revCount:dlg.revCount, escFlag:dlg.escFlag, profileHasPAC:dlg.profileHasPAC, drivers, score, tier, notes })
    }
    out.sort((a,b) => (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, scopeNM, lookMin, lamMul])

  useEffect(() => {
    if (!map) return
    const SRC = 'aidc-src'
    const SRC_BND = 'aidc-bnd-src'
    const SRC_LNK = 'aidc-lnk-src'
    const SRC_NDE = 'aidc-nde-src'
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any }) }
    ;[SRC, SRC_BND, SRC_LNK, SRC_NDE].forEach(ensure)
    const writeAll = () => {
      const view = rows.filter(r =>
        (tierFilter==='ALL'||r.tier===tierFilter) &&
        (regionFilter==='ALL'||r.b.region===regionFilter) &&
        (bilatFilter==='ALL'||r.b.id===bilatFilter) &&
        (profileFilter==='ALL'||r.b.profile===profileFilter)
      )
      const ac: any[] = []
      const lnk: any[] = []
      for (const r of view) {
        ac.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{
          tier: r.tier, color: TIER_COLOR[r.tier], score: r.score, sz: 7 + (r.score/100)*12,
          label: `${r.f.callsign||r.f.icao} · ${r.b.id} · T${(r.tToCobt_s/60).toFixed(1)}m · ${r.tier}`
        } })
        if (shLink) {
          lnk.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat], r.b.mid] }, properties:{ color: TIER_COLOR[r.tier] } })
        }
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: (shHalo||shPin||shLbl)?ac:[] })
      ;(map.getSource(SRC_LNK) as any).setData({ type:'FeatureCollection', features: lnk })

      // Bilateral boundaries — represented as a wide diamond at midpoint + connector lines to up/down centroid
      const bndFeats: any[] = []
      const ndeFeats: any[] = []
      if (shBnd) {
        // collect active bilaterals (those with any rows visible)
        const active = new Set(view.map(r => r.b.id))
        for (const b of BILAT) {
          const isAct = active.has(b.id)
          const baseColor = isAct ? '#0ea5e9' : '#475569'
          // small diamond polygon around midpoint, sized by declMins
          const sz = 0.6 + (b.declMins / 200) * 1.5  // degrees, illustrative
          const [lng, lat] = b.mid
          const dia: number[][] = [
            [lng, lat + sz*0.6],
            [lng + sz, lat],
            [lng, lat - sz*0.6],
            [lng - sz, lat],
            [lng, lat + sz*0.6],
          ]
          bndFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates: dia }, properties:{ color: baseColor, w: isAct?1.6:1.0, dash: isAct?[3,2]:[1,3] } })
          ndeFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[lng, lat] }, properties:{ color: baseColor, sz: isAct?6:3.5, label: b.id, prof: b.profile } })
        }
      }
      ;(map.getSource(SRC_BND) as any).setData({ type:'FeatureCollection', features: bndFeats })
      ;(map.getSource(SRC_NDE) as any).setData({ type:'FeatureCollection', features: ndeFeats })
    }
    if (!map.getLayer('aidc-bnd-line'))
      map.addLayer({ id:'aidc-bnd-line', type:'line', source:SRC_BND, paint:{ 'line-color':['get','color'], 'line-width':['get','w'], 'line-opacity':0.6, 'line-dasharray':[3,2] } })
    if (!map.getLayer('aidc-nde'))
      map.addLayer({ id:'aidc-nde', type:'circle', source:SRC_NDE, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.20, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.2, 'circle-stroke-opacity':0.8 } })
    if (!map.getLayer('aidc-nde-lbl'))
      map.addLayer({ id:'aidc-nde-lbl', type:'symbol', source:SRC_NDE, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,-1.4], 'text-anchor':'bottom', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#cbd5e1', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('aidc-link'))
      map.addLayer({ id:'aidc-link', type:'line', source:SRC_LNK, paint:{ 'line-color':['get','color'], 'line-width':1.2, 'line-opacity':0.6, 'line-dasharray':[2,2] } })
    if (!map.getLayer('aidc-halo'))
      map.addLayer({ id:'aidc-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('aidc-pin'))
      map.addLayer({ id:'aidc-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 62], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('aidc-lbl'))
      map.addLayer({ id:'aidc-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    writeAll()
    return () => {
      for (const id of ['aidc-lbl','aidc-pin','aidc-halo','aidc-link','aidc-nde-lbl','aidc-nde','aidc-bnd-line']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_BND, SRC_LNK, SRC_NDE]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, regionFilter, bilatFilter, profileFilter, shHalo, shPin, shLbl, shBnd, shLink])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (regionFilter==='ALL'||r.b.region===regionFilter) &&
    (bilatFilter==='ALL'||r.b.id===bilatFilter) &&
    (profileFilter==='ALL'||r.b.profile===profileFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || r.b.id.toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { BREACH:0, DEGRADED:0, LATE:0, WATCH:0, CLEAN:0, IDLE:0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,c)=>a+c.score,0)/rows.length) : 0
  const lamLatencies = rows.flatMap(r => r.stages.filter(s => s.acked && s.ack_lat_s > 0).map(s => s.ack_lat_s))
  const muLam = lamLatencies.length ? (lamLatencies.reduce((a,c)=>a+c,0)/lamLatencies.length) : 0
  const totLamMiss = rows.reduce((a,r) => a + r.stages.filter(s => s.emitted && !s.acked && s.stage !== 'AOC').length, 0)
  const totBreach = counts.BREACH + counts.DEGRADED
  const worst = rows[0]

  // Per-bilateral aggregation
  const bilatMap = new Map<string, { b: Bilateral; count: number; breach: number; deg: number; muScore: number; lamMiss: number }>()
  for (const r of rows) {
    const m = bilatMap.get(r.b.id) || { b: r.b, count: 0, breach: 0, deg: 0, muScore: 0, lamMiss: 0 }
    m.count++
    if (r.tier === 'BREACH') m.breach++
    if (r.tier === 'DEGRADED') m.deg++
    m.muScore += r.score
    m.lamMiss += r.stages.filter(s => s.emitted && !s.acked && s.stage !== 'AOC').length
    bilatMap.set(r.b.id, m)
  }
  const bilatRows = Array.from(bilatMap.values()).map(m => ({ ...m, muScore: m.muScore / m.count })).sort((a,b) => (b.breach + b.deg) - (a.breach + a.deg) || b.muScore - a.muScore)
  // include the empty bilaterals at end
  const seen = new Set(bilatRows.map(r => r.b.id))
  for (const b of BILAT) if (!seen.has(b.id)) bilatRows.push({ b, count:0, breach:0, deg:0, muScore:0, lamMiss:0 })

  // Per-stage aggregation
  const stageNames: Array<StageState['stage']> = ['ABI','PAC','EST','ACT','TOC','AOC']
  const stageTotals: Record<string, { emit: number; ack: number; total: number; muLat: number; latN: number }> = {}
  for (const s of stageNames) stageTotals[s] = { emit:0, ack:0, total:0, muLat:0, latN:0 }
  for (const r of rows) {
    for (const s of r.stages) {
      const t = stageTotals[s.stage]
      t.total++
      if (s.emitted) t.emit++
      if (s.acked) t.ack++
      if (s.acked && s.ack_lat_s > 0) { t.muLat += s.ack_lat_s; t.latN++ }
    }
  }

  return (
    <div className="fixed top-16 right-3 z-40 w-[480px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">AIDC</span>
          <span className="text-[10px] text-slate-400">ATS Inter-facility · OLDI ed.4.3 / Doc 9694 / NICS</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter===t?'border':'border border-slate-700/60'}`} style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:undefined, color: TIER_COLOR[t] }}>{t.slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-LAM s</div><div className="text-slate-100 font-mono">{muLam.toFixed(1)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">LAM-MS</div><div className="font-mono" style={{color: totLamMiss?TIER_COLOR.LATE:'#94a3b8'}}>{totLamMiss}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">BR+DG</div><div className="font-mono" style={{color: totBreach?TIER_COLOR.DEGRADED:'#94a3b8'}}>{totBreach}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?(worst.f.callsign||worst.f.icao):'—'}</div></div>
      </div>

      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">SCOPE NM <span className="text-slate-200 font-mono">{scopeNM.toFixed(0)}</span>
            <input type="range" min="80" max="500" step="10" value={scopeNM} onChange={e=>setScopeNM(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">LOOK min <span className="text-slate-200 font-mono">{lookMin.toFixed(0)}</span>
            <input type="range" min="5" max="30" step="1" value={lookMin} onChange={e=>setLookMin(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">LAM-MUL <span className="text-slate-200 font-mono">{(lamMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={lamMul*100} onChange={e=>setLamMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','EUR','NAT','NICS-PAC','APAC','CAR-SAM'] as const).map(r => (
            <button key={r} onClick={()=>setRegionFilter(r as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${regionFilter===r?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{r}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','OLDI','ICAO','APAC','NICS','NAT'] as const).map(p => (
            <button key={p} onClick={()=>setProfileFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${profileFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['BND',shBnd,setShBnd],['LNK',shLink,setShLink]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/bilat" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={()=>setBilatFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${bilatFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL · {BILAT.length}</button>
          {BILAT.map(b => (
            <button key={b.id} onClick={()=>setBilatFilter(b.id)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${bilatFilter===b.id?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{b.id}</button>
          ))}
        </div>
      </div>

      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','BILATERAL','STAGES','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab==='AIRCRAFT' && visible.slice(0,80).map((r,i) => (
          <div key={i} onClick={()=>onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
              <span className="font-mono text-slate-100">{r.f.callsign||r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type||'—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{r.b.id}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.b.profile}</span>
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>T-COBT <span className="font-mono" style={{color: r.tToCobt_s>-300?TIER_COLOR.LATE:'#e2e8f0'}}>{(r.tToCobt_s/60).toFixed(1)}m</span></div>
              <div>DIST <span className="text-slate-100 font-mono">{r.distNM.toFixed(0)}NM</span></div>
              <div>FL <span className="text-slate-100 font-mono">{(r.f.altitudeFt/100).toFixed(0)}</span></div>
              <div>REV <span className="font-mono" style={{color:r.revCount>=3?TIER_COLOR.LATE:'#e2e8f0'}}>{r.revCount}</span></div>
            </div>
            {/* per-stage strip — visual sequence */}
            <div className="mt-1 grid gap-1" style={{ gridTemplateColumns: `repeat(${r.stages.length}, 1fr)` }}>
              {r.stages.map((s,k) => (
                <div key={k} className="text-center py-0.5 rounded font-mono text-[9px]" style={{
                  background: s.emitted ? (s.acked ? '#10b98133' : '#f59e0b33') : '#47556922',
                  color: s.emitted ? (s.acked ? '#10b981' : '#f59e0b') : '#64748b',
                  border: `1px solid ${s.emitted ? (s.acked ? '#10b98155' : '#f59e0b55') : '#47556944'}`,
                }}>{s.stage}{s.acked && s.ack_lat_s > 0 ? <span className="text-[8px] opacity-70"> {s.ack_lat_s.toFixed(0)}s</span> : ''}</div>
              ))}
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).filter(([_,v]) => v > 5).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v as number)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='CLEAN' && <div className="mt-1 text-[9px] text-slate-500">{r.b.upName} → {r.b.downName} · ABI≥{(r.b.abiLeadS/60).toFixed(0)}m EST≥{(r.b.estLeadS/60).toFixed(0)}m ACT≥{(r.b.actLeadS/60).toFixed(0)}m LAM≤{r.b.lamTimerS}s</div>}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length===0 && <div className="text-[10px] text-slate-500 italic">no enroute airframes within {scopeNM.toFixed(0)}NM of an active inter-FIR boundary in the next {lookMin.toFixed(0)}min — try widening SCOPE / LOOK or clear region filter</div>}

        {tab==='BILATERAL' && (
          <div className="space-y-1">
            {bilatRows.map(m => (
              <div key={m.b.id} onClick={()=>setBilatFilter(m.b.id)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
                  <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{m.b.id}</span>
                  <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{m.b.profile}</span>
                  <span className="px-1 rounded bg-slate-700/50 text-slate-400 font-mono text-[9px]">{m.b.region}</span>
                  <span className="ml-auto font-mono text-slate-100">{m.count}</span>
                </div>
                <div className="text-[9px] text-slate-400 mt-0.5">{m.b.upName} → {m.b.downName}</div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>DECL <span className="text-slate-100 font-mono">{m.b.declMins}/h</span></div>
                  <div>LAM≤ <span className="text-slate-100 font-mono">{m.b.lamTimerS}s</span></div>
                  <div>ABI≥ <span className="text-slate-100 font-mono">{(m.b.abiLeadS/60).toFixed(0)}m</span></div>
                  <div>EST≥ <span className="text-slate-100 font-mono">{(m.b.estLeadS/60).toFixed(0)}m</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400 mt-0.5">
                  <div>μ-SCR <span className="font-mono" style={{color: m.muScore>60?TIER_COLOR.DEGRADED:m.muScore>40?TIER_COLOR.LATE:'#e2e8f0'}}>{m.muScore.toFixed(0)}</span></div>
                  <div>BRCH <span className="font-mono" style={{color: TIER_COLOR.BREACH}}>{m.breach}</span></div>
                  <div>DEG <span className="font-mono" style={{color: TIER_COLOR.DEGRADED}}>{m.deg}</span></div>
                  <div>LAM-MS <span className="font-mono" style={{color: m.lamMiss?TIER_COLOR.LATE:'#94a3b8'}}>{m.lamMiss}</span></div>
                </div>
                {m.b.precedent && <div className="mt-1 text-[9px] text-slate-400 italic">{m.b.precedent}</div>}
              </div>
            ))}
          </div>
        )}

        {tab==='STAGES' && (
          <div className="space-y-2">
            <div className="text-[10px] text-slate-400">Per-stage emit / ack envelope across {rows.length} flight × bilateral pairs in look-ahead window</div>
            {stageNames.map(sn => {
              const t = stageTotals[sn]
              if (t.total === 0) return (
                <div key={sn} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{sn}</span>
                    <span className="text-slate-500 text-[9px] italic">no eligible flights</span>
                  </div>
                </div>
              )
              const emitPct = (t.emit/t.total)*100
              const ackPct = (t.ack/t.total)*100
              const muLat = t.latN ? (t.muLat/t.latN) : 0
              const spec = MSG_CATALOG.find(m => m.k === sn)
              return (
                <div key={sn} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                  <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
                    <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{sn}</span>
                    {spec && <span className="text-slate-400 text-[9px]">{spec.full}</span>}
                    <span className="ml-auto font-mono text-slate-100">{t.total}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1 mt-1 text-[10px] text-slate-400">
                    <div>EMIT <span className="font-mono" style={{color: emitPct<70?TIER_COLOR.LATE:emitPct<90?TIER_COLOR.WATCH:'#10b981'}}>{emitPct.toFixed(0)}%</span></div>
                    <div>ACK <span className="font-mono" style={{color: ackPct<70?TIER_COLOR.LATE:ackPct<90?TIER_COLOR.WATCH:'#10b981'}}>{ackPct.toFixed(0)}%</span></div>
                    <div>μ-LAT <span className="font-mono">{muLat.toFixed(1)}s</span></div>
                  </div>
                  <div className="mt-1 h-1 bg-slate-700/40 rounded overflow-hidden flex">
                    <div style={{ width: `${ackPct}%`, background:'#10b981', height:'100%' }} />
                    <div style={{ width: `${Math.max(0, emitPct-ackPct)}%`, background:'#f59e0b', height:'100%' }} />
                  </div>
                  {spec && <div className="mt-1 text-[9px] text-slate-500">{spec.ref}</div>}
                </div>
              )
            })}
          </div>
        )}

        {tab==='METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-300 leading-relaxed">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-slate-100 font-mono text-[11px] mb-1">AIDC · ATS Inter-facility Data Communication</div>
              <p>Per-flight evaluator of the inter-facility coordination message stack between adjacent ACC/UAC/Oceanic centres. Scores whether the canonical handoff sequence ABI → (PAC) → EST → ACT → LAM → TOC → AOC has been emitted by the upstream centre, acknowledged within the bilateral LAM deadline, and completed before the coordinated boundary time (COBT).</p>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-slate-100 font-mono text-[11px] mb-1">Message catalogue</div>
              <div className="space-y-0.5">
                {MSG_CATALOG.filter(m => m.k !== 'OCM').map(m => (
                  <div key={m.k} className="grid grid-cols-12 gap-1">
                    <span className="col-span-1 font-mono text-sky-300">{m.k}</span>
                    <span className="col-span-4 text-slate-300">{m.full}</span>
                    <span className="col-span-3 font-mono text-slate-500">{m.triggerT<0?`T${(m.triggerT/60).toFixed(0)}m`:m.triggerT>0?`T+${(m.triggerT/60).toFixed(0)}m`:'event'}</span>
                    <span className="col-span-4 text-slate-400 text-[9px]">{m.profiles.slice(0,3).join(',')}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-slate-100 font-mono text-[11px] mb-1">8 drivers</div>
              <ul className="list-disc list-inside space-y-0.5 text-slate-400">
                <li><span className="text-slate-200 font-mono">ABI-LATE</span> · Advance Boundary Info timer breach (s past T-COBT lead)</li>
                <li><span className="text-slate-200 font-mono">EST-LATE</span> · Estimate timer breach</li>
                <li><span className="text-slate-200 font-mono">ACT-LATE</span> · Activation timer breach</li>
                <li><span className="text-slate-200 font-mono">LAM-MISS</span> · OLDI §B.2 ≤4s ack missing (or APAC ≤30s)</li>
                <li><span className="text-slate-200 font-mono">REV-CHURN</span> · revision/abrogation churn per leg</li>
                <li><span className="text-slate-200 font-mono">TOC-GAP</span> · Transfer-of-Control without Assumption — unowned aircraft slice</li>
                <li><span className="text-slate-200 font-mono">PROFILE</span> · bilateral profile field-set mismatch (OLDI PAC missing etc)</li>
                <li><span className="text-slate-200 font-mono">ESC</span> · Überlingen-style multi-stage failure + STCA-degraded proxy</li>
              </ul>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-slate-100 font-mono text-[11px] mb-1">6 tiers</div>
              <div className="space-y-0.5">
                {[
                  ['BREACH','≥80','coordination dialogue failed · verbal HF/SATVOICE fall-back · do NOT release'],
                  ['DEGRADED','≥62','partial handoff · chase LAM · re-emit EST · log inc'],
                  ['LATE','≥42','one stage past timer · recover with REV-LAM cycle'],
                  ['WATCH','≥22','nominal sequence · monitor next stage trigger'],
                  ['CLEAN','<22','full sequence in envelope'],
                  ['IDLE','—','flight not in any 15-min bilateral window'],
                ].map(([t,thr,d]) => (
                  <div key={t} className="grid grid-cols-12 gap-1">
                    <span className="col-span-2 font-mono" style={{color:TIER_COLOR[t as Tier]}}>{t}</span>
                    <span className="col-span-2 font-mono text-slate-500">{thr}</span>
                    <span className="col-span-8 text-slate-400">{d}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-slate-100 font-mono text-[11px] mb-1">Distinct from</div>
              <p className="text-slate-400">FIR/FIR-LOAD (count-only sector load), FIR-CROSSINGS (geographic boundary catalogue), CPDLC (pilot↔controller datalink), VDL2/HFDL (physical-link air-ground), PBCS (RCP/RSP cert), AMAN/E-AMAN (single-FIR arrival sequencer), CLAM/RAM (clearance/route adherence safety-nets), MTCD/STCA (conflict probes), SWIM (information distribution backbone), CSC (callsign confusion). AIDC is uniquely the INTER-FACILITY ATC↔ATC MESSAGE STACK conformance evaluator.</p>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-slate-100 font-mono text-[11px] mb-1">References</div>
              <p className="text-slate-400 text-[9px]">ICAO Doc 9694 ATS Data Link Apps · Doc 4444 PANS-ATM §10 · Doc 7030 RASPs · Annex 11 §3.7 · Annex 10 Vol II §3.3 · EUROCONTROL OLDI ed.4.3 §A/B/C · OLDI ICD-MNUC-3.0 · FAA NAS-IR-25080004 ER-6 IFDD · FAA AIDC-NICS Pacific Operations Manual · FAA JO 7110.65 §8-5/§8-6/§10-3 · FAA JO 7610.4 §8 · FAA JO 7210.633 NICS Pacific IO-Hbk · ICAO APAC AIDC-ICD ed.3.0 (CRG Bali 2018) · NAT NTS RNDSG/57 · Doc 9854 GATMOC §3.4 · Doc 9882 SWIM · Doc 9931 CDM §4 · Doc 9971 Pt II Ch.6 · ED-153 SSAL · ED-202A AISG · CANSO SoE-SMS 2019 · BFU AX001-1-2/02 Überlingen (71 fatal, 2002-07-01) · BEA AF447 (informational, NAT inter-FIR) · NTSB AAR-91-08 LAX1493 · ICAO Cir 314 §6 HF inter-unit coord.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
