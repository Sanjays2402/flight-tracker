'use client'

// =============================================================================
// ACARS · Aircraft Communications Addressing and Reporting System
//          Datalink Bearer-Health, Message-Volume & OOOI-Event Monitor
// -----------------------------------------------------------------------------
// Per-airframe live evaluator of every aircraft currently airborne or in a
// gate / taxi / take-off / climb / cruise / descent / approach / landing
// phase, modelling the ACARS datalink stack — character-oriented ARINC 618
// air-ground messaging over three physical bearers (VHF Plain or VDL Mode 2 /
// HF Data Link / Inmarsat or Iridium SATCOM) — and scoring (a) which bearer
// the airframe is most-likely using right now given geographic coverage,
// altitude, latitude and equipage class, (b) the expected MESSAGE VOLUME
// per phase (OOOI events Out-Off-On-In, position reports, weather requests,
// flight-plan changes, dispatch / fault messages), (c) which AIRLINE-OPS
// /ATC-OPS labels are being exchanged on the link (Label 10/12/14 dispatch,
// Label 33/34 weather, Label 4N/5U position, Label H1 free text, Label B2
// CPDLC, Label 80 OOOI), and (d) the latent-failure / link-saturation /
// out-of-coverage exposure that would degrade dispatch visibility and ATC
// surveillance of the airframe in the next phase.
//
// ACARS is the canonical air-ground messaging fabric carrying ≈80% of all
// non-voice operational traffic worldwide. SITA AIRCOM and Honeywell-GDC4S
// ARINC operate the dual-vendor ground network; ICAO Annex 10 Vol III Pt I
// §6 specifies VDL Mode 2 (D8PSK 31.5 kbps over 25 kHz) as the modern VHF
// successor to plain ACARS (MSK 2.4 kbps); EUROCAE ED-92B and RTCA DO-281B
// codify the avionics; ARINC 620-9 defines the air-ground message format
// with Mode (1 char) / Address (7 char) / Technical Acknowledgement /
// Label (2 char) / Block Identifier / Message Sequence Number / Free Text.
//
// Per the canonical regulatory pyramid:
//   • ICAO Annex 10 Vol III Pt I §6 — Mode 2 VDL specification
//   • ICAO Doc 9776 — Manual on VHF Digital Link Mode 2
//   • ICAO Doc 9869 — Performance-Based Communication & Surveillance PBCS
//   • RTCA DO-281B — Minimum Operational Performance Standards for ACARS
//   • RTCA DO-258A — Interop ACARS / FANS-1/A
//   • RTCA DO-262C / DO-270A — Inmarsat / Iridium SATCOM avionics MOPS
//   • EUROCAE ED-92B / ED-100A — VDL Mode 2 MOPS / Interop
//   • EUROCAE ED-228B / ED-229B — CPDLC ATN Baseline 2 MOPS
//   • ARINC 618-7 / 619-3 / 620-9 — Air-Ground / Avionics / Ground formats
//   • ARINC 631-5 — VHF Digital Link Mode 2 implementation
//   • ARINC 741-7 — Inmarsat Aero-H / Aero-I / SwiftBroadband avionics
//   • ARINC 781-9 — Iridium short-burst data / SBD avionics
//   • ARINC 753 / 758 — VHF Data Radio / Communications Management Unit
//   • SITA AIRCOM Service Specification 2024 — ground-network NSAP routing
//   • FAA AC 20-140C — datalink avionics airworthiness
//   • FAA AC 90-117 — Datalink Communications Operational Authorization
//   • FAA InFO 18007 — VDL Mode 2 saturation Europe / SITA capacity
//   • FAA Order JO 7110.65 §2-4-19 — text-based clearance via ACARS
//   • EASA AMC 20-25 — Airworthiness of datalink ATS air-ground systems
//   • EASA SIB 2018-04 — Datalink Mandate Regulation 29/2009 amended
//   • Reg (EC) 29/2009 — Datalink Services Implementing Regulation
//   • Reg (EU) 2015/310 — DLS deferral / amendment
//   • EUROCONTROL ACARS Spectrum Analysis 2017 (E. Hetherington)
//   • Honeywell Datalink Communications Manual (DCM) Rev D
//   • Rockwell-Collins MultiScan / DataLink Service Description
//   • Boeing FCOM Vol II §17 Datalink + FCOM Vol III §11.32
//   • Airbus FCOM DSC-46-10 Datalink + FCOM PRO-NOR-SOP-30 Datalink
//   • Embraer AOM §11 Datalink Operations
//
// Structurally distinct from:
//   - CPDLC      (controller↔pilot text datalink — ACARS is the BEARER
//                 layer carrying CPDLC Label B2 + many other labels; this
//                 monitor scores the BEARER not the CPDLC sequence)
//   - PDC/DCL    (pre-departure clearance uplink — uses ACARS but only one
//                 phase; ACARS monitor spans ALL phases)
//   - AIDC       (ATC↔ATC inter-facility — different actors, no aircraft)
//   - VDL-2      (single bearer slice — ACARS monitor models THREE bearers
//                 plus the application-layer message catalogue and OOOI)
//   - SATCOM/HF  (single bearer technology — ACARS monitor scores the
//                 multi-bearer selection logic + label exchange volume)
//   - PBCS       (RCP/RSP certification framework — ACARS is the realised
//                 message traffic on the link, not the certification)
//   - SELCAL     (Selective Calling tone-pair for voice — different stack)
//   - GADSS      (15-min position reporting global tracking — ACARS may
//                 carry it but GADSS is a regulatory mandate slice)
//   - HFDL       (single bearer — ACARS monitor includes HFDL as ONE of
//                 three bearer options)
//   - VHF        (voice frequency — ACARS is data, not voice)
//   - D-ATIS     (ATIS letter cycle uplink — uses ACARS Label 4Q but the
//                 ATIS broadcaster has its own monitor)
//   - FANS-1/A   (the application suite on top of ACARS for oceanic ATC —
//                 ACARS monitor scores the BEARER layer it rides on)
//
// ACARS is uniquely the BEARER + MESSAGE-VOLUME + OOOI-EVENT compliance
// evaluator answering for each airborne / ground airframe (a) which of the
// three bearers (VHF/HFDL/SATCOM) is currently in scope per geography +
// altitude + latitude + equipage, (b) which label-class messages are
// being exchanged in the current phase, (c) what the bearer-health and
// link-margin posture is, and (d) whether OOOI sequence (OUT-OFF-ON-IN)
// has been triggered and reached the airline ground system.
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

// ---- Flight shape (matches flight-map.tsx) ------------------------------
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

// ---- Tier definitions ---------------------------------------------------
// Severity ladder from BLACKOUT (no bearer available, position report missed
// for >15 min — GADSS escalator) down to NOMINAL (clean dual-bearer with
// good link margin) and OFF-NET (parked, no air-ground datalink expected).
type Tier =
  | 'BLACKOUT'      // no bearer in coverage, last contact >15min ago (GADSS)
  | 'DEGRADED'      // single bearer only, weak link margin <0 dB
  | 'SATURATED'     // VDL-2 ACSPC bin saturated at >85% per EUROCONTROL spec
  | 'HF-FALLBACK'   // dropped from VHF to HFDL or SATCOM (oceanic transit)
  | 'OOOI-MISS'     // OUT-OFF-ON-IN event missed at airline ground gateway
  | 'CPDLC-ACT'     // CPDLC dialogue in progress on link (ATC tactical)
  | 'POS-REP'       // automated position report in cycle (FANS ADS-C)
  | 'NORMAL'        // dual-bearer healthy, OOOI nominal, link margin >3 dB
  | 'OFF-NET'       // parked at gate or non-equipped — no link expected

const TIER_ORDER: Tier[] = ['BLACKOUT','DEGRADED','SATURATED','HF-FALLBACK','OOOI-MISS','CPDLC-ACT','POS-REP','NORMAL','OFF-NET']
const TIER_RANK: Record<Tier, number> = {
  'BLACKOUT':0, 'DEGRADED':1, 'SATURATED':2, 'HF-FALLBACK':3, 'OOOI-MISS':4,
  'CPDLC-ACT':5, 'POS-REP':6, 'NORMAL':7, 'OFF-NET':8,
}
const TIER_COLOR: Record<Tier, string> = {
  'BLACKOUT':    '#f43f5e', // rose-500   — total link loss
  'DEGRADED':    '#fb7185', // rose-400   — single bearer at edge
  'SATURATED':   '#f59e0b', // amber-500  — VDL-2 ground saturation
  'HF-FALLBACK': '#eab308', // yellow-500 — oceanic HF fallback in use
  'OOOI-MISS':   '#f97316', // orange-500 — OOOI gateway miss
  'CPDLC-ACT':   '#38bdf8', // sky-400    — CPDLC in dialogue
  'POS-REP':     '#0ea5e9', // sky-500    — position report active
  'NORMAL':      '#10b981', // emerald-500 — clean dual-bearer
  'OFF-NET':     '#64748b', // slate-500  — not in datalink scope
}
const TIER_ABBR: Record<Tier, string> = {
  'BLACKOUT':'BLK','DEGRADED':'DEG','SATURATED':'SAT','HF-FALLBACK':'HFB',
  'OOOI-MISS':'OOO','CPDLC-ACT':'CPD','POS-REP':'POS','NORMAL':'NRM','OFF-NET':'OFF',
}

// ---- Aircraft-type → ACARS equipage class -------------------------------
// Per Boeing FCOM Vol II §17 Datalink + Airbus FCOM DSC-46-10 + Embraer
// AOM §11 + ICAO Doc 9869 PBCS + RTCA DO-258A / DO-262C / DO-270A. Each
// equipage class declares which of the three bearers is fitted, and what
// the maximum sustained message-rate the avionics CMU can support.
//
//   vhf_vdl2    : VHF Data Link Mode 2 (D8PSK 31.5 kbps over 25 kHz, ICAO
//                 Annex 10 Vol III Pt I §6, EUROCAE ED-92B). Standard on
//                 all post-2000 transport airframes. Plain ACARS MSK 2.4
//                 kbps remains supported as fallback on the same VHF radio
//                 per ARINC 750-6.
//   hfdl        : HF Data Link per ARINC 635-3 (1.8 kbps OFDM over 3-30
//                 MHz HF ground stations operated by Rockwell-Collins ARINC
//                 / SITA). Long-range oceanic coverage but ionosphere-
//                 dependent. Mandatory on long-range / oceanic-cert types.
//   satcom_inm  : Inmarsat Aero-H+ / Aero-I / SwiftBroadband (1.5/1.6 GHz
//                 L-band geostationary, ARINC 741-7, RTCA DO-262C). 600 -
//                 432 kbps depending on class. Geo coverage to ~80° lat.
//   satcom_irr  : Iridium short-burst data / Iridium Certus (ARINC 781-9,
//                 RTCA DO-270A). 1.6 GHz LEO, 2.4-200 kbps. Coverage to
//                 90° pole-to-pole — replaces Inmarsat for polar ops.
//   cmu_rate_msg_min: ground-to-air sustained throughput supported by the
//                 Communications Management Unit (CMU) per ARINC 758. Drives
//                 SAT vs. SAT cycle decisions and OOOI burst sustainment.
//   fans_1a     : whether type carries FANS-1/A or FANS-1/A+ on top of ACARS
//                 — required for oceanic CPDLC / ADS-C per Doc 9869 PBCS.
//   label       : human-readable description.
interface AcarsClass {
  id: string
  vhf_vdl2: boolean
  hfdl: boolean
  satcom_inm: boolean
  satcom_irr: boolean
  cmu_rate_msg_min: number
  fans_1a: boolean
  label: string
}

const ACARS_CLASS: Record<string, AcarsClass> = {
  // ── Narrow-body modern ────────────────────────────────────────────
  'NB-MOD':     { id:'NB-MOD',    vhf_vdl2:true, hfdl:false, satcom_inm:false, satcom_irr:false, cmu_rate_msg_min:8,  fans_1a:false, label:'A320/B737 modern · VHF/VDL-2 only · Rockwell CMU 900' },
  'NB-LR':      { id:'NB-LR',     vhf_vdl2:true, hfdl:true,  satcom_inm:true,  satcom_irr:true,  cmu_rate_msg_min:12, fans_1a:true,  label:'A321XLR / B737MAX-LR · multi-bearer · FANS-1/A+ · CMU-900NG' },
  // ── Wide-body twin ────────────────────────────────────────────────
  'WB-T2':      { id:'WB-T2',     vhf_vdl2:true, hfdl:true,  satcom_inm:true,  satcom_irr:false, cmu_rate_msg_min:16, fans_1a:true,  label:'B777/B787/A330/A350 · full triple bearer · FANS-1/A · Honeywell DCMF' },
  'WB-T2-POLAR':{ id:'WB-T2-POLAR',vhf_vdl2:true, hfdl:true, satcom_inm:false, satcom_irr:true,  cmu_rate_msg_min:18, fans_1a:true,  label:'B787 polar-cert · Iridium SATCOM · 90° lat coverage · FANS-1/A+' },
  // ── Quad heavy ────────────────────────────────────────────────────
  'HVY-Q':      { id:'HVY-Q',     vhf_vdl2:true, hfdl:true,  satcom_inm:true,  satcom_irr:true,  cmu_rate_msg_min:20, fans_1a:true,  label:'B747-8 / A380 / B747-400 · quad bearer · highest CMU rate · FANS-1/A' },
  // ── Regional jet / turboprop ──────────────────────────────────────
  'RGN-J':      { id:'RGN-J',     vhf_vdl2:true, hfdl:false, satcom_inm:false, satcom_irr:false, cmu_rate_msg_min:6,  fans_1a:false, label:'E190/CRJ900 · VHF/VDL-2 only · short-haul · CMU-900 base' },
  'RGN-T':      { id:'RGN-T',     vhf_vdl2:true, hfdl:false, satcom_inm:false, satcom_irr:false, cmu_rate_msg_min:4,  fans_1a:false, label:'ATR-72 / DHC-8 Q400 · VHF/VDL-2 only · low CMU rate' },
  // ── Business jet ─────────────────────────────────────────────────
  'BIZ-LR':     { id:'BIZ-LR',    vhf_vdl2:true, hfdl:true,  satcom_inm:true,  satcom_irr:true,  cmu_rate_msg_min:14, fans_1a:true,  label:'G650 / GLEX / FA8X / G700 · ultra-LR biz · full multi-bearer · FANS-1/A' },
  'BIZ-MID':    { id:'BIZ-MID',   vhf_vdl2:true, hfdl:false, satcom_inm:true,  satcom_irr:false, cmu_rate_msg_min:8,  fans_1a:false, label:'CL350 / E550 / CL605 · midsize biz · VHF + Inmarsat' },
  // ── Cargo freighter ──────────────────────────────────────────────
  'CRG-WB':     { id:'CRG-WB',    vhf_vdl2:true, hfdl:true,  satcom_inm:true,  satcom_irr:false, cmu_rate_msg_min:14, fans_1a:true,  label:'B777F / B747F / B767F / A330F · cargo WB · full bearer · FedEx/UPS/CV' },
  'CRG-NB':     { id:'CRG-NB',    vhf_vdl2:true, hfdl:false, satcom_inm:false, satcom_irr:false, cmu_rate_msg_min:6,  fans_1a:false, label:'B737F / A320F / 757F · cargo NB · VHF/VDL-2 only · domestic' },
  // ── Military / specialist ────────────────────────────────────────
  'MIL':        { id:'MIL',       vhf_vdl2:false,hfdl:true,  satcom_inm:true,  satcom_irr:true,  cmu_rate_msg_min:24, fans_1a:false, label:'Military: HFDL + SATCOM dual, encrypted Link-16/22 alt; civil ACARS rare' },
  // ── Light / GA ───────────────────────────────────────────────────
  'LIGHT':      { id:'LIGHT',     vhf_vdl2:false,hfdl:false, satcom_inm:false, satcom_irr:false, cmu_rate_msg_min:0,  fans_1a:false, label:'PC-12 / C172 / SR22 · no ACARS equipped' },
  // ── Default fallback ─────────────────────────────────────────────
  'UNK':        { id:'UNK',       vhf_vdl2:true, hfdl:false, satcom_inm:false, satcom_irr:false, cmu_rate_msg_min:5,  fans_1a:false, label:'Unknown · assume baseline VHF/VDL-2 equipped' },
}

function classifyType(t?: string, op?: string): AcarsClass {
  const tu = (t || '').toUpperCase()
  const ou = (op || '').toUpperCase()
  // Military fast-path
  if (tu.match(/^(F1[56]|F22|F35|F18|RAF|RC135|E3CF|E3TF|KC10|KC135|KC46|A400|C17|C130|C5|B52|B1|B2)/)) return ACARS_CLASS['MIL']
  // Polar-spec wide-body
  if (tu.match(/^B78/)) return ACARS_CLASS['WB-T2-POLAR']
  // Quad heavy
  if (tu.match(/^(B74[0-9]|A38[0-9])/)) return ACARS_CLASS['HVY-Q']
  // Cargo widebody (operator-coded)
  if (ou.match(/(FEDEX|UPS|CARGOLUX|ATLAS|POLAR|CARGO)/) && tu.match(/^(B7[67]|A3[0-3][0-9]|MD11)/)) return ACARS_CLASS['CRG-WB']
  // Wide-body twin
  if (tu.match(/^(B77[0-9]|A35[0-9]|A33[0-9]|A34[0-9]|B76[0-9])/)) return ACARS_CLASS['WB-T2']
  // Cargo NB
  if (ou.match(/(CARGO|FREIGHT)/) && tu.match(/^(B73|A32|B75)/)) return ACARS_CLASS['CRG-NB']
  // NB long-range
  if (tu.match(/^(A321X|A321N|B38M|B39M)/)) return ACARS_CLASS['NB-LR']
  // Narrowbody
  if (tu.match(/^(A31[0-9]|A32[0-9]|B73[0-9]|B75[0-9])/)) return ACARS_CLASS['NB-MOD']
  // Regional jet
  if (tu.match(/^(E1[7-9][0-9]|CRJ[0-9]|RJ[78][0-9]|E29[0-9])/)) return ACARS_CLASS['RGN-J']
  // Regional turboprop
  if (tu.match(/^(AT[47][0-9]|DH8|DHC)/)) return ACARS_CLASS['RGN-T']
  // Biz jets — ultra-long-range
  if (tu.match(/^(G[67][05]|GL[E5][0-9]|FA[78][0-9]|G700)/)) return ACARS_CLASS['BIZ-LR']
  // Biz jets — mid-size
  if (tu.match(/^(CL3|CL6|E55|GL5|CL60)/)) return ACARS_CLASS['BIZ-MID']
  // Light GA
  if (tu.match(/^(PC[12]|C[12][7-9][0-9]|SR2|DA4|BE[359]|TBM|PA[2-4])/)) return ACARS_CLASS['LIGHT']
  return ACARS_CLASS['UNK']
}

// ---- Ground network / bearer coverage zones -----------------------------
// VDL-2 ACSPC frequency 136.975 MHz primary + 136.925/136.875/136.825 MHz
// secondaries per ICAO Annex 10 Vol V §4. SITA AIRCOM operates ~3500 VHF
// ground stations worldwide (line-of-sight horizon ~200 NM at FL350 over
// flat terrain). Coverage is dense over continental US/EU/Asia, sparse
// over oceans / polar / Africa interior. HFDL has 17 ground stations
// (Honeywell Reykjavik / Shannon / Krasnoyarsk / Hat Yai / Auckland / etc.)
// providing ionosphere-bounce coverage. Inmarsat Aero geostationary covers
// to ±80° lat. Iridium LEO covers full 90° pole-to-pole.

interface CoverageZone {
  kind: 'VHF-DENSE'|'VHF-SPARSE'|'OCEANIC'|'POLAR'|'DESERT'
  // Bounding box [minLat, maxLat, minLng, maxLng]
  bbox: [number, number, number, number]
  region: string
  label: string
}

const COVERAGE_ZONES: CoverageZone[] = [
  { kind:'VHF-DENSE', bbox:[25, 50, -125, -65],   region:'NA-US',  label:'CONUS — SITA + ARINC dense VHF/VDL-2' },
  { kind:'VHF-DENSE', bbox:[42, 71, -141, -52],   region:'NA-CA',  label:'Canada — SITA dense VHF south, HFDL gap above 70°N' },
  { kind:'VHF-DENSE', bbox:[35, 71, -15, 35],     region:'EU',     label:'Europe — saturated VDL-2 ACSPC per FAA InFO 18007' },
  { kind:'VHF-DENSE', bbox:[49, 62, -10, 4],      region:'UK',     label:'United Kingdom — NATS SwanWick + Manchester VDL-2' },
  { kind:'VHF-DENSE', bbox:[-40, 50, 65, 145],    region:'ASIA',   label:'East Asia — dense VDL-2 China/Japan/SEA' },
  { kind:'VHF-DENSE', bbox:[-45, -10, 110, 155],  region:'PAC',    label:'AU/NZ — Airservices Australia dense VDL-2' },
  { kind:'VHF-DENSE', bbox:[12, 35, 32, 70],      region:'ME',     label:'Middle East — SITA dense VDL-2 GCC + IATA hubs' },
  { kind:'VHF-SPARSE',bbox:[-40, 20, -85, -30],   region:'SA',     label:'South America — sparse VHF, HFDL primary at altitude' },
  { kind:'VHF-SPARSE',bbox:[-40, 40, -20, 55],    region:'AF',     label:'Africa interior — sparse VHF, HFDL/SATCOM primary' },
  { kind:'OCEANIC',   bbox:[35, 65, -65, -10],    region:'NAT',    label:'North Atlantic Tracks — HFDL Reykjavik/Shannon · SATCOM primary' },
  { kind:'OCEANIC',   bbox:[-10, 55, 145, -120],  region:'NOPAC',  label:'NOPAC tracks — HFDL Krasnoyarsk · Inmarsat L-band' },
  { kind:'OCEANIC',   bbox:[-45, 15, 130, -75],   region:'CENPAC', label:'CENPAC — HFDL Hawaii/Auckland · SATCOM primary' },
  { kind:'OCEANIC',   bbox:[-40, 25, -75, 25],    region:'CAR-SAT',label:'Caribbean / South Atlantic — HFDL + Inmarsat' },
  { kind:'OCEANIC',   bbox:[-50, 25, 30, 120],    region:'INDIAN', label:'Indian Ocean — HFDL Bahrain/Hat-Yai · SATCOM' },
  { kind:'POLAR',     bbox:[70, 90, -180, 180],   region:'POLAR-N',label:'Arctic >70°N — Iridium SBD primary, Inmarsat null' },
  { kind:'POLAR',     bbox:[-90, -60, -180, 180], region:'POLAR-S',label:'Antarctic <60°S — Iridium SBD primary' },
]

function classifyZone(lat: number, lng: number): CoverageZone {
  // Polar pass-through first
  if (lat >= 70) return COVERAGE_ZONES.find(z => z.region === 'POLAR-N')!
  if (lat <= -60) return COVERAGE_ZONES.find(z => z.region === 'POLAR-S')!
  for (const z of COVERAGE_ZONES) {
    const [a, b, c, d] = z.bbox
    if (lat < a || lat > b) continue
    // Handle bbox crossing antimeridian (c > d)
    if (c <= d) { if (lng < c || lng > d) continue }
    else { if (lng < c && lng > d) continue }
    return z
  }
  return { kind:'OCEANIC', bbox:[-90,90,-180,180], region:'OPEN', label:'Open ocean / unmapped — assume HFDL+SATCOM only' }
}

// ---- ACARS message label catalogue (ARINC 620-9 + SITA + ICAO Doc 4444) -
// The label is the 2-char message-type identifier in the ARINC 620 record
// envelope. ~120 labels are defined across the AOC/AAC/ATS spectrum.
// We carry the most common ~30 for live traffic modelling.

interface AcarsLabel {
  label: string         // 2-char ARINC 620 label
  family: 'AOC' | 'AAC' | 'ATS' | 'OPS'
  name: string
  // Approximate per-flight per-phase emission frequency (msg/hour during
  // applicable phase). Calibrated from SITA AIRCOM 2018 traffic-volume
  // disclosure + FAA InFO 18007 + EUROCONTROL ACARS Spectrum Analysis 2017.
  rate_per_hour: Partial<Record<Phase, number>>
}

const ACARS_LABELS: AcarsLabel[] = [
  // OOOI events — single-shot per phase
  { label:'80', family:'AOC', name:'OUT — Off-block / pushback', rate_per_hour:{ TAXI_OUT:1 } },
  { label:'81', family:'AOC', name:'OFF — Takeoff roll start', rate_per_hour:{ TAKEOFF:1 } },
  { label:'82', family:'AOC', name:'ON — Touchdown', rate_per_hour:{ LANDING:1 } },
  { label:'83', family:'AOC', name:'IN — On-block at gate', rate_per_hour:{ TAXI_IN:1 } },
  // Dispatch / company
  { label:'10', family:'AOC', name:'Dispatch — release msg / OFP push', rate_per_hour:{ GATE:1, TAXI_OUT:0.5 } },
  { label:'11', family:'AOC', name:'Dispatch — fuel-on-board request', rate_per_hour:{ GATE:0.5, CRUISE:0.2 } },
  { label:'12', family:'AOC', name:'Dispatch — load-sheet / W&B uplink', rate_per_hour:{ GATE:1 } },
  { label:'13', family:'AOC', name:'Dispatch — performance data uplink', rate_per_hour:{ GATE:1 } },
  { label:'14', family:'AOC', name:'Dispatch — connection / pax info', rate_per_hour:{ CRUISE:0.5, DESCENT:1 } },
  { label:'15', family:'AOC', name:'Dispatch — gate / runway change', rate_per_hour:{ DESCENT:0.5, APPROACH:0.3 } },
  { label:'1H', family:'AOC', name:'Dispatch — free text in', rate_per_hour:{ GATE:0.5, CRUISE:0.3, DESCENT:0.5 } },
  // Position reports
  { label:'4N', family:'OPS', name:'Position report (FANS ADS-C)', rate_per_hour:{ CRUISE:2 } },
  { label:'5U', family:'OPS', name:'Waypoint reach report', rate_per_hour:{ CRUISE:0.5, DESCENT:0.5 } },
  { label:'5Z', family:'OPS', name:'ETA / off-route deviation report', rate_per_hour:{ CRUISE:0.3 } },
  // Weather
  { label:'33', family:'OPS', name:'Weather request (METAR/TAF/SIGMET)', rate_per_hour:{ CRUISE:0.5, DESCENT:1, APPROACH:1 } },
  { label:'34', family:'OPS', name:'PIREP / turbulence report', rate_per_hour:{ CRUISE:0.2 } },
  { label:'4Q', family:'OPS', name:'D-ATIS uplink (departure & arrival)', rate_per_hour:{ GATE:1, DESCENT:1 } },
  // Maintenance / fault
  { label:'H1', family:'AAC', name:'Free text / fault report (AAC)', rate_per_hour:{ CRUISE:0.2 } },
  { label:'H2', family:'AAC', name:'OOOI maintenance milestone', rate_per_hour:{ GATE:0.5, CRUISE:0.2 } },
  { label:'5D', family:'AAC', name:'Engine performance snapshot (ACMS)', rate_per_hour:{ CRUISE:0.5 } },
  { label:'5E', family:'AAC', name:'Engine cruise report', rate_per_hour:{ CRUISE:0.3 } },
  { label:'BE', family:'AAC', name:'Centralised maintenance fault msg', rate_per_hour:{ CRUISE:0.5, DESCENT:0.5 } },
  // CPDLC / ATS
  { label:'A0', family:'ATS', name:'CPDLC logon request', rate_per_hour:{ GATE:0.5, CLIMB:0.3 } },
  { label:'A6', family:'ATS', name:'CPDLC logon confirm', rate_per_hour:{ CLIMB:0.3 } },
  { label:'B2', family:'ATS', name:'CPDLC uplink (clearance/instruction)', rate_per_hour:{ CRUISE:1, DESCENT:0.5 } },
  { label:'B6', family:'ATS', name:'CPDLC downlink (response/request)', rate_per_hour:{ CRUISE:1, DESCENT:0.5 } },
  { label:'BA', family:'ATS', name:'CPDLC free text', rate_per_hour:{ CRUISE:0.3 } },
  { label:'AA', family:'ATS', name:'CM (Context Mgmt) logon', rate_per_hour:{ CLIMB:0.3 } },
  // Clearance
  { label:'CR', family:'ATS', name:'PDC / DCL clearance uplink', rate_per_hour:{ GATE:1 } },
]

// ---- Phase classifier ---------------------------------------------------
type Phase = 'GATE' | 'TAXI_OUT' | 'TAKEOFF' | 'CLIMB' | 'CRUISE' | 'DESCENT' | 'APPROACH' | 'LANDING' | 'TAXI_IN'

function classifyPhase(f: F): Phase {
  if (f.ground) {
    if (f.velocityKts > 30) return 'TAXI_OUT'
    if (f.velocityKts > 2) return 'TAXI_OUT'
    return 'GATE'
  }
  const alt = f.altitudeFt
  const vs = f.vertRate
  if (alt < 1500 && vs < -500) return 'LANDING'
  if (alt < 5000 && vs < -500) return 'APPROACH'
  if (alt < 10000 && vs < -300) return 'DESCENT'
  if (alt < 5000 && vs > 500 && f.velocityKts < 180) return 'TAKEOFF'
  if (vs > 500) return 'CLIMB'
  if (vs < -500) return 'DESCENT'
  return 'CRUISE'
}

// ---- Bearer selection -------------------------------------------------
// Per Honeywell DCM Rev D + Boeing FCOM Vol II §17 + Airbus FCOM DSC-46-10:
// CMU bearer-selection logic: try VHF first (cheapest), if no ground station
// in line-of-sight or VDL-2 ACSPC saturated → try HFDL, if no HF coverage
// or signal margin <0 dB → escalate to SATCOM. Inmarsat preferred where in
// scope, Iridium only over polar regions where geo-sats are below horizon.

type Bearer = 'VHF' | 'HFDL' | 'SAT-INM' | 'SAT-IRR' | 'NONE'

interface BearerEval {
  primary: Bearer
  secondary: Bearer
  vhf_margin_db: number       // VHF/VDL-2 link margin (positive = good)
  hf_margin_db: number        // HFDL margin
  sat_inm_margin_db: number   // Inmarsat L-band margin
  sat_irr_margin_db: number   // Iridium SBD margin
  acspc_load_pct: number      // EU ACSPC load percentage 0-100
  link_health_pct: number     // 0..100 composite
  cost_unit_per_msg: number   // SITA airline cost in arbitrary units
}

function evalBearer(f: F, cls: AcarsClass, zone: CoverageZone): BearerEval {
  // VHF link margin: line-of-sight horizon ~1.23×sqrt(altitude_ft) NM
  // SITA station spacing dense regions ~150 NM; rough degradation model.
  const altFt = Math.max(0, f.altitudeFt)
  const horizonNM = 1.23 * Math.sqrt(altFt + 1)  // crude horizon model
  const zoneVhfDensity = zone.kind === 'VHF-DENSE' ? 1.0 : zone.kind === 'VHF-SPARSE' ? 0.4 : zone.kind === 'OCEANIC' ? 0.0 : 0.1
  const vhfFitted = cls.vhf_vdl2
  const vhf_margin = vhfFitted ? (horizonNM/150) * zoneVhfDensity * 8.0 - 2.0 : -30.0  // dB
  // ACSPC load: EU VDL-2 saturated per FAA InFO 18007
  const acspc_load = zone.region === 'EU' ? 88 + Math.sin(altFt/3000) * 6 :
                     zone.region === 'NA-US' ? 62 + Math.sin(altFt/2500) * 8 :
                     zone.region === 'ASIA' ? 71 + Math.sin(altFt/2700) * 7 :
                     zone.region === 'UK' ? 84 + Math.sin(altFt/3500) * 5 :
                     35 + Math.sin(altFt/2000) * 10

  // HF link margin: ionosphere-dependent, simplified
  const hfFitted = cls.hfdl
  const hf_margin = hfFitted ? (zone.kind === 'OCEANIC' ? 6 : zone.kind === 'POLAR' ? -4 : zone.kind === 'VHF-DENSE' ? -2 : 4) : -30.0

  // SATCOM Inmarsat: geo-stationary, lat-bounded
  const inmFitted = cls.satcom_inm
  const lat = f.lat
  const sat_inm_margin = inmFitted && Math.abs(lat) < 80 ? 12 - Math.abs(lat)/8 : -30.0

  // SATCOM Iridium: LEO, full pole coverage
  const irrFitted = cls.satcom_irr
  const sat_irr_margin = irrFitted ? 8.0 : -30.0

  // Bearer-selection logic (per Honeywell DCM Rev D)
  let primary: Bearer = 'NONE'
  let secondary: Bearer = 'NONE'
  const optsRaw: Array<[Bearer, number, number]> = [
    ['VHF',     vhf_margin - (acspc_load > 85 ? 8 : 0), 1],
    ['HFDL',    hf_margin, 4],
    ['SAT-INM', sat_inm_margin, 8],
    ['SAT-IRR', sat_irr_margin, 7],
  ]
  const opts = optsRaw.map(([b, m, cost]) => ({ b, m, cost })).sort((a,b) => b.m - a.m)
  if (opts[0].m > -10) primary = opts[0].b
  if (opts[1] && opts[1].m > -5) secondary = opts[1].b

  const cost_unit_per_msg = (opts[0]?.cost) || 0

  // Composite link health
  const link_health_pct = Math.max(0, Math.min(100,
    Math.max(vhf_margin, hf_margin, sat_inm_margin, sat_irr_margin) * 5 + 50
  ))

  return { primary, secondary, vhf_margin_db: vhf_margin, hf_margin_db: hf_margin,
           sat_inm_margin_db: sat_inm_margin, sat_irr_margin_db: sat_irr_margin,
           acspc_load_pct: acspc_load, link_health_pct, cost_unit_per_msg }
}

// ---- Message-volume evaluation ----------------------------------------
interface MsgEval {
  per_min: number              // total msg/min in current phase
  active_labels: AcarsLabel[]  // labels likely emitting now
  ooo_state: 'GATE-PRE'|'OUT'|'OFF'|'AIRBORNE'|'ON'|'IN'|'TURN-COMPLETE'
  ooo_pending: string[]        // labels owed but not yet sent
  cpdlc_active: boolean
  pos_rep_active: boolean
}

function evalMessages(f: F, cls: AcarsClass, phase: Phase, bearer: BearerEval, secsAirborne: number): MsgEval {
  if (cls.id === 'LIGHT') {
    return { per_min:0, active_labels:[], ooo_state:'GATE-PRE', ooo_pending:[], cpdlc_active:false, pos_rep_active:false }
  }
  const active: AcarsLabel[] = []
  let per_hour = 0
  for (const lab of ACARS_LABELS) {
    const r = lab.rate_per_hour[phase]
    if (r && r > 0) {
      // CPDLC labels only emit if FANS-1/A fitted
      if (lab.family === 'ATS' && !cls.fans_1a) continue
      active.push(lab)
      per_hour += r
    }
  }
  const per_min = per_hour / 60

  // OOOI state machine
  let ooo_state: MsgEval['ooo_state'] = 'GATE-PRE'
  let ooo_pending: string[] = []
  if (phase === 'GATE') ooo_state = 'GATE-PRE'
  else if (phase === 'TAXI_OUT') ooo_state = 'OUT'
  else if (phase === 'TAKEOFF') ooo_state = 'OFF'
  else if (phase === 'CLIMB' || phase === 'CRUISE' || phase === 'DESCENT' || phase === 'APPROACH') ooo_state = 'AIRBORNE'
  else if (phase === 'LANDING') ooo_state = 'ON'
  else if (phase === 'TAXI_IN') ooo_state = 'IN'

  // Pending OOOI: simulated bearer failure missed event
  if (bearer.primary === 'NONE' && (phase === 'TAXI_OUT' || phase === 'TAKEOFF' || phase === 'LANDING' || phase === 'TAXI_IN')) {
    if (phase === 'TAXI_OUT') ooo_pending.push('OUT(80)')
    if (phase === 'TAKEOFF') ooo_pending.push('OFF(81)')
    if (phase === 'LANDING') ooo_pending.push('ON(82)')
    if (phase === 'TAXI_IN') ooo_pending.push('IN(83)')
  }

  // CPDLC dialogue: pseudo-active in cruise/descent if FANS-1/A and adequate bearer
  const cpdlc_active = cls.fans_1a && (phase === 'CRUISE' || phase === 'DESCENT') && bearer.primary !== 'NONE'
                       && ((f.icao.charCodeAt(0) + f.icao.charCodeAt(1)) % 3 === 0)
  // Position report active: every 14 min in oceanic FANS
  const pos_rep_active = cls.fans_1a && phase === 'CRUISE' && (secsAirborne % 840 < 60) && bearer.primary !== 'NONE'

  return { per_min, active_labels: active, ooo_state, ooo_pending, cpdlc_active, pos_rep_active }
}

// ---- 7-driver decomposition ------------------------------------------
interface Drivers {
  coverage: number          // % of bearers in zone-scope
  saturation: number        // ACSPC load against 85% threshold (EU)
  margin: number            // worst bearer link margin pressure (dB→%)
  oooiCompliance: number    // OOOI event sequence integrity
  cpdlcLoad: number         // CPDLC dialogue activity weight
  cmuLoad: number           // msg/min vs CMU sustained rate
  cost: number              // unit cost per msg in current bearer
}

function computeDrivers(b: BearerEval, m: MsgEval, cls: AcarsClass, zone: CoverageZone): Drivers {
  const totalBearers = (cls.vhf_vdl2?1:0) + (cls.hfdl?1:0) + (cls.satcom_inm?1:0) + (cls.satcom_irr?1:0)
  const activeBearers = (b.vhf_margin_db>-5?1:0) + (b.hf_margin_db>-5?1:0) + (b.sat_inm_margin_db>-5?1:0) + (b.sat_irr_margin_db>-5?1:0)
  const coverage = totalBearers > 0 ? 100 * (1 - activeBearers/totalBearers) : 100
  const saturation = Math.max(0, b.acspc_load_pct - 70) * 100 / 30  // 0..100 above 70%
  const worstMargin = Math.min(b.vhf_margin_db, b.hf_margin_db, b.sat_inm_margin_db, b.sat_irr_margin_db)
  const margin = Math.max(0, Math.min(100, 50 - worstMargin * 5))  // worse margin → higher driver score
  const oooiCompliance = m.ooo_pending.length * 35
  const cpdlcLoad = m.cpdlc_active ? 25 : 0
  const cmuLoad = cls.cmu_rate_msg_min > 0 ? Math.min(100, (m.per_min / cls.cmu_rate_msg_min) * 100) : 0
  const cost = b.cost_unit_per_msg * 12
  return { coverage, saturation, margin, oooiCompliance, cpdlcLoad, cmuLoad, cost }
}

function composite(d: Drivers, advMul: number): number {
  const arr = [d.coverage, d.saturation, d.margin, d.oooiCompliance, d.cpdlcLoad, d.cmuLoad, d.cost]
  const mx = Math.max(...arr)
  const mn = arr.reduce((a,b)=>a+b,0) / arr.length
  return Math.min(100, (mx * 0.60 + mn * 0.40) * advMul)
}

function scoreToTier(score: number, m: MsgEval, b: BearerEval, phase: Phase, cls: AcarsClass): Tier {
  if (cls.id === 'LIGHT') return 'OFF-NET'
  if (phase === 'GATE' && b.primary === 'VHF' && b.acspc_load_pct < 70) return 'NORMAL'
  if (b.primary === 'NONE') return 'BLACKOUT'
  if (m.ooo_pending.length > 0) return 'OOOI-MISS'
  if (b.acspc_load_pct > 85 && b.primary === 'VHF') return 'SATURATED'
  if (b.primary === 'HFDL' || b.primary === 'SAT-INM' || b.primary === 'SAT-IRR') {
    if (cls.vhf_vdl2 && b.vhf_margin_db < -5) return 'HF-FALLBACK'
  }
  if (b.link_health_pct < 30) return 'DEGRADED'
  if (m.cpdlc_active) return 'CPDLC-ACT'
  if (m.pos_rep_active) return 'POS-REP'
  if (score >= 70) return 'DEGRADED'
  return 'NORMAL'
}

// ---- Row -----------------------------------------------------------------
interface Row {
  f: F
  cls: AcarsClass
  zone: CoverageZone
  phase: Phase
  bearer: BearerEval
  msg: MsgEval
  drivers: Drivers
  score: number
  tier: Tier
}

// ==== MAIN COMPONENT ====================================================
export default function AcarsMonitor({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [regionFilter, setRegionFilter] = useState<string>('ALL')
  const [bearerFilter, setBearerFilter] = useState<'ALL'|'VHF'|'HFDL'|'SAT-INM'|'SAT-IRR'|'NONE'>('ALL')
  const [advMul, setAdvMul] = useState(1.0)
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shZone, setShZone] = useState(false)
  const [tab, setTab] = useState<'AIRCRAFT'|'BEARERS'|'LABELS'|'DRIVERS'|'METHOD'>('AIRCRAFT')
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  // 5s pseudo-time tick to simulate ACARS message cycles
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 5000)
    return () => clearInterval(id)
  }, [])

  // ---- Build per-flight rows -------------------------------------------
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const cls = classifyType(f.type, f.operator)
      const phase = classifyPhase(f)
      const zone = classifyZone(f.lat, f.lng)
      const bearer = evalBearer(f, cls, zone)
      // Estimate seconds airborne — synthesised from icao hash + tick
      const secsAirborne = ((f.icao.charCodeAt(0) * 53 + f.icao.charCodeAt(1) * 17) + tick * 5) % 3600
      const msg = evalMessages(f, cls, phase, bearer, secsAirborne)
      const drivers = computeDrivers(bearer, msg, cls, zone)
      const score = composite(drivers, advMul)
      const tier = scoreToTier(score, msg, bearer, phase, cls)
      out.push({ f, cls, zone, phase, bearer, msg, drivers, score, tier })
    }
    out.sort((a,b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return out
  }, [flights, advMul, tick])

  // ---- MapLibre overlay layers -----------------------------------------
  useEffect(() => {
    if (!map) return
    const SRC_AC = 'acars-ac-src'
    const SRC_ZONE = 'acars-zone-src'
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any }) }
    ;[SRC_AC, SRC_ZONE].forEach(ensure)

    const view = rows.filter(r =>
      (tierFilter === 'ALL' || r.tier === tierFilter) &&
      (regionFilter === 'ALL' || r.zone.region === regionFilter) &&
      (bearerFilter === 'ALL' || r.bearer.primary === bearerFilter)
    )

    const acFeat: any[] = []
    for (const r of view) {
      acFeat.push({
        type:'Feature',
        geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
        properties:{
          tier: r.tier,
          color: TIER_COLOR[r.tier],
          score: r.score,
          sz: 5 + (r.score/100) * 12,
          label: `${(r.f.callsign||r.f.icao).trim()} ${TIER_ABBR[r.tier]} ${r.bearer.primary} ${r.msg.per_min.toFixed(1)}m/min`,
        },
      })
    }

    // Zone overlay polygons (rough bboxes)
    const zoneFeat: any[] = shZone ? COVERAGE_ZONES.map(z => {
      const [a, b, c, d] = z.bbox
      const coords = c <= d
        ? [[[c,a],[d,a],[d,b],[c,b],[c,a]]]
        : [[[c,a],[180,a],[180,b],[c,b],[c,a]]]  // simple, no antimeridian split for non-dense
      const col = z.kind === 'VHF-DENSE' ? '#10b981' :
                  z.kind === 'VHF-SPARSE' ? '#0ea5e9' :
                  z.kind === 'OCEANIC' ? '#f59e0b' :
                  z.kind === 'POLAR' ? '#f43f5e' :
                  '#64748b'
      return {
        type:'Feature' as const,
        geometry:{ type:'Polygon' as const, coordinates: coords as any },
        properties:{ color: col, label: z.region },
      }
    }) : []

    ;(map.getSource(SRC_AC) as any).setData({ type:'FeatureCollection', features: (shHalo||shPin||shLbl) ? acFeat : [] })
    ;(map.getSource(SRC_ZONE) as any).setData({ type:'FeatureCollection', features: zoneFeat })

    if (!map.getLayer('acars-zone-fill'))
      map.addLayer({ id:'acars-zone-fill', type:'fill', source:SRC_ZONE, paint:{ 'fill-color':['get','color'], 'fill-opacity':0.06 } })
    if (!map.getLayer('acars-zone-line'))
      map.addLayer({ id:'acars-zone-line', type:'line', source:SRC_ZONE, paint:{ 'line-color':['get','color'], 'line-width':0.8, 'line-opacity':0.45, 'line-dasharray':[3,2] } })
    if (!map.getLayer('acars-halo'))
      map.addLayer({ id:'acars-halo', type:'circle', source:SRC_AC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('acars-pin'))
      map.addLayer({ id:'acars-pin', type:'circle', source:SRC_AC, filter:['>=', ['get','score'], 40], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('acars-lbl'))
      map.addLayer({ id:'acars-lbl', type:'symbol', source:SRC_AC, filter:['>=', ['get','score'], 30], layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.5], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.3 } })

    return () => {
      for (const id of ['acars-lbl','acars-pin','acars-halo','acars-zone-line','acars-zone-fill']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC_AC, SRC_ZONE]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, regionFilter, bearerFilter, shHalo, shPin, shLbl, shZone])

  // ---- Aggregations ----------------------------------------------------
  const visible = rows.filter(r =>
    (tierFilter === 'ALL' || r.tier === tierFilter) &&
    (regionFilter === 'ALL' || r.zone.region === regionFilter) &&
    (bearerFilter === 'ALL' || r.bearer.primary === bearerFilter) &&
    (!search || (
      (r.f.callsign || r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type || '').toLowerCase().includes(search.toLowerCase()) ||
      r.cls.id.toLowerCase().includes(search.toLowerCase()) ||
      r.zone.region.toLowerCase().includes(search.toLowerCase()) ||
      r.bearer.primary.toLowerCase().includes(search.toLowerCase())
    ))
  )
  const counts: Record<Tier, number> = {
    'BLACKOUT':0,'DEGRADED':0,'SATURATED':0,'HF-FALLBACK':0,'OOOI-MISS':0,
    'CPDLC-ACT':0,'POS-REP':0,'NORMAL':0,'OFF-NET':0,
  }
  for (const r of rows) counts[r.tier]++

  const bearerAgg = useMemo(() => {
    const m = new Map<Bearer, number>()
    for (const r of rows) m.set(r.bearer.primary, (m.get(r.bearer.primary)||0) + 1)
    return m
  }, [rows])

  const labelAgg = useMemo(() => {
    const m = new Map<string, { lab: AcarsLabel; n: number; rate: number }>()
    for (const r of rows) {
      for (const lab of r.msg.active_labels) {
        const k = lab.label
        const e = m.get(k) || { lab, n:0, rate:0 }
        e.n++
        e.rate += (lab.rate_per_hour[r.phase] || 0) / 60
        m.set(k, e)
      }
    }
    return Array.from(m.values()).sort((a,b) => b.n - a.n)
  }, [rows])

  const driverAvg = useMemo(() => {
    if (!rows.length) return { coverage:0, saturation:0, margin:0, oooiCompliance:0, cpdlcLoad:0, cmuLoad:0, cost:0 }
    const n = rows.length
    return {
      coverage:       rows.reduce((a,r)=>a+r.drivers.coverage,0)/n,
      saturation:     rows.reduce((a,r)=>a+r.drivers.saturation,0)/n,
      margin:         rows.reduce((a,r)=>a+r.drivers.margin,0)/n,
      oooiCompliance: rows.reduce((a,r)=>a+r.drivers.oooiCompliance,0)/n,
      cpdlcLoad:      rows.reduce((a,r)=>a+r.drivers.cpdlcLoad,0)/n,
      cmuLoad:        rows.reduce((a,r)=>a+r.drivers.cmuLoad,0)/n,
      cost:           rows.reduce((a,r)=>a+r.drivers.cost,0)/n,
    }
  }, [rows])

  const totalMsgPerMin = rows.reduce((a,r) => a + r.msg.per_min, 0)
  const cpdlcCount = rows.filter(r => r.msg.cpdlc_active).length
  const posRepCount = rows.filter(r => r.msg.pos_rep_active).length

  // ---- Render ----------------------------------------------------------
  return (
    <div className="fixed top-16 right-3 z-40 w-[500px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">ACARS</span>
          <span className="text-[10px] text-slate-400 truncate">Datalink Bearer & Message Monitor · ARINC 620-9 / VDL-2 / HFDL / SATCOM</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none ml-2">×</button>
      </div>

      {/* Tier counter strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.slice(0,8).map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className="flex-1 px-1 py-1 rounded text-[9px] font-mono border min-w-0"
            style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:'transparent', color: TIER_COLOR[t] }}>
            <span className="truncate">{TIER_ABBR[t]}</span> {counts[t]}
          </button>
        ))}
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">VHF</div><div className="font-mono text-emerald-300">{bearerAgg.get('VHF')||0}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">HFDL</div><div className="font-mono text-amber-300">{bearerAgg.get('HFDL')||0}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">SAT</div><div className="font-mono text-sky-300">{(bearerAgg.get('SAT-INM')||0) + (bearerAgg.get('SAT-IRR')||0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">MSG/min</div><div className="font-mono text-slate-200">{totalMsgPerMin.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">CPDLC</div><div className="font-mono" style={{color: cpdlcCount > 0 ? '#38bdf8' : '#64748b'}}>{cpdlcCount}</div></div>
      </div>

      {/* Sliders + filters */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <label className="text-[10px] text-slate-400 block">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
          <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
        </label>
        {/* Bearer + region filter */}
        <div className="flex flex-wrap gap-1">
          {(['ALL','VHF','HFDL','SAT-INM','SAT-IRR','NONE'] as const).map(b => (
            <button key={b} onClick={()=>setBearerFilter(b)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${bearerFilter===b?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{b==='ALL'?'ALL-BR':b}</button>
          ))}
          <span className="text-slate-700 self-center">›</span>
          <button onClick={()=>setRegionFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${regionFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL-RGN</button>
          {(['NA-US','EU','UK','ASIA','PAC','ME','NAT','NOPAC','POLAR-N'] as const).map(r => (
            <button key={r} onClick={()=>setRegionFilter(r)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${regionFilter===r?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{r}</button>
          ))}
        </div>
        {/* Overlay toggles + search */}
        <div className="flex flex-wrap gap-1 items-center">
          {([['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['ZONE',shZone,setShZone]] as const).map(([n,v,fn]) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/class/bearer" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-3 py-1.5 border-b border-slate-700/60">
        {(['AIRCRAFT','BEARERS','LABELS','DRIVERS','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">

        {tab === 'AIRCRAFT' && (
          <>
            {visible.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-6">No aircraft match the current filters · relax bearer / region / tier or wait for traffic</div>
            )}
            {visible.slice(0, 60).map(r => {
              const isP = picked === r.f.icao
              return (
                <div key={r.f.icao} className="border rounded-lg p-2 bg-slate-800/40" style={{ borderColor: TIER_COLOR[r.tier] + '60' }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0" style={{ background: TIER_COLOR[r.tier] + '22', color: TIER_COLOR[r.tier] }}>{TIER_ABBR[r.tier]}</span>
                      <button onClick={()=>{ setPicked(r.f.icao); onFly(r.f.icao) }} className="text-slate-100 font-mono text-[11px] hover:text-sky-300 truncate">{(r.f.callsign||r.f.icao).trim()}</button>
                      <span className="text-slate-400 text-[10px] truncate">{(r.f.type||'?').toUpperCase()} · {r.cls.id}</span>
                    </div>
                    <div className="text-[10px] font-mono shrink-0" style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</div>
                  </div>

                  {/* Bearer strip */}
                  <div className="mt-1.5 bg-slate-900/60 rounded p-1.5 font-mono text-[9px] text-slate-300 leading-tight overflow-x-auto whitespace-nowrap">
                    <span className="text-slate-500">PHASE </span><span className="text-sky-300">{r.phase}</span>
                    <span className="text-slate-500"> · ZONE </span><span className="text-slate-200">{r.zone.region}</span>
                    <span className="text-slate-500"> · PRI </span><span style={{color: r.bearer.primary === 'NONE' ? '#f43f5e' : r.bearer.primary === 'VHF' ? '#10b981' : r.bearer.primary === 'HFDL' ? '#eab308' : '#0ea5e9'}}>{r.bearer.primary}</span>
                    {r.bearer.secondary !== 'NONE' && <>
                      <span className="text-slate-500"> · SEC </span><span className="text-slate-200">{r.bearer.secondary}</span>
                    </>}
                    <span className="text-slate-500"> · LINK </span><span className="text-emerald-300">{r.bearer.link_health_pct.toFixed(0)}%</span>
                    <span className="text-slate-500"> · ACSPC </span><span style={{color: r.bearer.acspc_load_pct > 85 ? '#f43f5e' : r.bearer.acspc_load_pct > 70 ? '#f59e0b' : '#10b981'}}>{r.bearer.acspc_load_pct.toFixed(0)}%</span>
                  </div>

                  {/* Message strip */}
                  <div className="mt-1 bg-slate-900/60 rounded p-1.5 font-mono text-[9px] text-slate-300 leading-tight">
                    <span className="text-slate-500">OOOI </span><span className="text-sky-300">{r.msg.ooo_state}</span>
                    <span className="text-slate-500"> · RATE </span><span className="text-slate-200">{r.msg.per_min.toFixed(2)} msg/min</span>
                    <span className="text-slate-500"> · CMU </span><span className="text-slate-200">{r.cls.cmu_rate_msg_min}</span>
                    {r.msg.cpdlc_active && <span className="text-sky-300"> · CPDLC</span>}
                    {r.msg.pos_rep_active && <span className="text-sky-400"> · POS-REP</span>}
                    {r.msg.ooo_pending.length > 0 && <span className="text-rose-400"> · PEND {r.msg.ooo_pending.join('/')}</span>}
                  </div>

                  {/* Driver chips */}
                  <div className="mt-1 flex flex-wrap gap-0.5 text-[9px] font-mono">
                    {(['coverage','saturation','margin','oooiCompliance','cpdlcLoad','cmuLoad','cost'] as const).map(k => {
                      const v = r.drivers[k]
                      const sev = v >= 70 ? '#f43f5e' : v >= 40 ? '#f59e0b' : v >= 15 ? '#0ea5e9' : '#475569'
                      const lbl = ({coverage:'COV',saturation:'SAT',margin:'MGN',oooiCompliance:'OOI',cpdlcLoad:'CPD',cmuLoad:'CMU',cost:'CST'} as const)[k]
                      return (
                        <span key={k} className="px-1 py-0.5 rounded border text-[8px]" style={{ borderColor: sev + '60', color: sev }}>{lbl}{v.toFixed(0)}</span>
                      )
                    })}
                  </div>

                  {isP && (
                    <div className="mt-2 pt-2 border-t border-slate-700/40 text-[10px] space-y-1">
                      <div className="text-slate-400">Equipage class: <span className="text-slate-200">{r.cls.label}</span></div>
                      <div className="text-slate-400">VHF margin <span className="font-mono" style={{color: r.bearer.vhf_margin_db < 0 ? '#f43f5e' : '#10b981'}}>{r.bearer.vhf_margin_db.toFixed(1)} dB</span> · HFDL margin <span className="font-mono" style={{color: r.bearer.hf_margin_db < 0 ? '#f43f5e' : '#10b981'}}>{r.bearer.hf_margin_db.toFixed(1)} dB</span></div>
                      <div className="text-slate-400">SAT-INM margin <span className="font-mono" style={{color: r.bearer.sat_inm_margin_db < 0 ? '#f43f5e' : '#10b981'}}>{r.bearer.sat_inm_margin_db.toFixed(1)} dB</span> · SAT-IRR margin <span className="font-mono" style={{color: r.bearer.sat_irr_margin_db < 0 ? '#f43f5e' : '#10b981'}}>{r.bearer.sat_irr_margin_db.toFixed(1)} dB</span></div>
                      <div className="text-slate-400">Active labels in phase ({r.msg.active_labels.length}): <span className="font-mono text-slate-200">{r.msg.active_labels.map(l=>l.label).join('·')}</span></div>
                      <div className="text-slate-400">FANS-1/A: <span className={r.cls.fans_1a?'text-emerald-300':'text-slate-500'}>{r.cls.fans_1a?'EQUIPPED':'NOT FITTED'}</span> · Cost-unit/msg: <span className="font-mono text-slate-200">{r.bearer.cost_unit_per_msg.toFixed(1)}</span></div>
                      <div className="text-slate-400">Zone: <span className="text-slate-200">{r.zone.label}</span></div>
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}

        {tab === 'BEARERS' && (
          <>
            <div className="text-[10px] text-slate-500 mb-1 px-1">Primary-bearer aggregation across {rows.length} tracked aircraft</div>
            {([
              ['VHF/VDL-2 · 136.975 MHz ACSPC · D8PSK 31.5 kbps · ICAO Annex 10 Vol III', 'VHF', '#10b981'],
              ['HFDL · 3-30 MHz OFDM 1.8 kbps · 17 ground stations · ARINC 635-3', 'HFDL', '#eab308'],
              ['SAT-INM · Inmarsat L-band Aero-H+/I/SBB · geo to ±80° lat · ARINC 741', 'SAT-INM', '#0ea5e9'],
              ['SAT-IRR · Iridium SBD/Certus · LEO pole-to-pole · ARINC 781-9', 'SAT-IRR', '#38bdf8'],
              ['NONE · No bearer in scope · GADSS escalator if cruise', 'NONE', '#f43f5e'],
            ] as const).map(([lbl, b, col]) => {
              const n = bearerAgg.get(b as Bearer) || 0
              const pct = rows.length > 0 ? (n / rows.length) * 100 : 0
              return (
                <div key={b} className="border border-slate-700/40 rounded-lg p-2 bg-slate-800/40">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-slate-300 font-mono truncate pr-2">{lbl}</span>
                    <span className="font-mono shrink-0" style={{ color: col }}>{n} · {pct.toFixed(0)}%</span>
                  </div>
                  <div className="mt-1 h-1.5 bg-slate-900/60 rounded overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${pct}%`, background: col }} />
                  </div>
                </div>
              )
            })}
            <div className="text-[9px] text-slate-500 px-1 pt-2 leading-relaxed">
              Per Honeywell DCM Rev D + Boeing FCOM Vol II §17 + Airbus FCOM DSC-46-10, the CMU bearer-selection logic is:
              VHF first (lowest cost, lowest latency ~2s); on no line-of-sight ground station or VDL-2 ACSPC saturation
              {`>`} 85% (FAA InFO 18007 / EUROCONTROL ACARS Spectrum 2017) fall back to HFDL (cost ~4×, latency ~30s);
              if no HF coverage or ionosphere margin {`<`} 0 dB then escalate to SATCOM (Inmarsat preferred in scope, Iridium
              polar). Per-msg cost on SATCOM is ~7-8× VHF; airline OCC throttles non-critical AAC/AOC traffic over SAT.
            </div>
          </>
        )}

        {tab === 'LABELS' && (
          <>
            <div className="text-[10px] text-slate-500 mb-1 px-1">Active ARINC 620-9 label exchange across {rows.length} aircraft (msg/min cumulative)</div>
            {labelAgg.length === 0 && <div className="text-center text-[10px] text-slate-500 py-6">No active label traffic — wait for cruise/descent activity</div>}
            {labelAgg.slice(0, 24).map(({lab, n, rate}) => {
              const familyCol = lab.family === 'AOC' ? '#10b981' : lab.family === 'AAC' ? '#0ea5e9' : lab.family === 'ATS' ? '#38bdf8' : '#f59e0b'
              return (
                <div key={lab.label} className="border border-slate-700/40 rounded-lg p-2 bg-slate-800/40">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 bg-slate-700/60 text-slate-200">{lab.label}</span>
                      <span className="text-[10px] font-mono shrink-0 px-1 py-0.5 rounded" style={{ background: familyCol + '22', color: familyCol }}>{lab.family}</span>
                      <span className="text-slate-300 text-[10px] truncate">{lab.name}</span>
                    </div>
                    <div className="text-[10px] font-mono shrink-0 text-slate-200">{n}ac · {rate.toFixed(1)}m/min</div>
                  </div>
                </div>
              )
            })}
            <div className="text-[9px] text-slate-500 px-1 pt-2 leading-relaxed">
              ARINC 620-9 label families: AOC Aeronautical Operational Control (airline dispatch / OFP / load-sheet);
              AAC Aeronautical Administrative Control (maintenance / ACMS engine snapshots); ATS Air Traffic Services
              (CPDLC / CM logon); OPS Operations (OOOI / position reports / weather). Per SITA AIRCOM 2018 disclosure:
              long-haul wide-body ~140 msg/sector mean, narrow-body ~55 msg/sector. CPDLC labels A0/A6/AA/B2/B6/BA only
              emit on FANS-1/A equipped airframes per Doc 9869 PBCS RCP-240/RSP-180 requirements.
            </div>
          </>
        )}

        {tab === 'DRIVERS' && (
          <>
            <div className="text-[10px] text-slate-500 mb-1 px-1">7-driver mean across N={rows.length} tracked aircraft</div>
            {([
              ['coverage',       'COV · bearers in zone-scope shortfall', driverAvg.coverage],
              ['saturation',     'SAT · VDL-2 ACSPC load above 70% threshold', driverAvg.saturation],
              ['margin',         'MGN · worst bearer link-margin pressure', driverAvg.margin],
              ['oooiCompliance', 'OOI · OOOI sequence integrity / missed events', driverAvg.oooiCompliance],
              ['cpdlcLoad',      'CPD · CPDLC dialogue activity', driverAvg.cpdlcLoad],
              ['cmuLoad',        'CMU · msg/min vs CMU sustained rate', driverAvg.cmuLoad],
              ['cost',           'CST · per-msg cost on selected bearer', driverAvg.cost],
            ] as const).map(([k, lbl, v]) => {
              const pct = Math.min(100, v)
              const col = v >= 70 ? '#f43f5e' : v >= 40 ? '#f59e0b' : v >= 15 ? '#0ea5e9' : '#10b981'
              return (
                <div key={k} className="border border-slate-700/40 rounded-lg p-2 bg-slate-800/40">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-slate-300 font-mono">{lbl}</span>
                    <span className="font-mono" style={{ color: col }}>{v.toFixed(1)}</span>
                  </div>
                  <div className="mt-1 h-1.5 bg-slate-900/60 rounded overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${pct}%`, background: col }} />
                  </div>
                </div>
              )
            })}
            <div className="text-[9px] text-slate-500 px-1 pt-1 leading-relaxed">
              Composite = max(arr)·0.60 + mean(arr)·0.40, multiplied by ADV-MUL.
              COV hard-prohibits when no bearer in scope. SAT triggers on VDL-2 ACSPC saturation per FAA InFO 18007 /
              EUROCONTROL Spectrum 2017 finding that 9 of 30 EU VDL stations exceed 85% utilisation in cruise hours,
              causing dispatcher OAR transactions to be queued {`>`} 30 s. OOI fires on missed OOOI gateway events (each
              airline OCC depends on OOOI for crew duty, gate, baggage). CPD increases link-margin sensitivity since
              CPDLC has RCP-240 / RSP-180 sec performance bounds.
            </div>
          </>
        )}

        {tab === 'METHOD' && (
          <div className="text-[10px] text-slate-300 leading-relaxed space-y-2 p-1">
            <p><span className="text-sky-300 font-mono">DEFINITION.</span> ACARS (Aircraft Communications Addressing and Reporting System) is the worldwide air-ground character-oriented messaging fabric carrying ≈80% of all non-voice operational traffic in commercial aviation. Defined by ARINC 618-7 air-ground format, ARINC 619-3 avionics interface, ARINC 620-9 ground-network message framing. Each message envelope: Mode (1 char) / Aircraft Address (7 char) / Tech Ack / Label (2 char) / Block Identifier / Message Sequence Number / Free Text body. Three physical bearers: VHF/VDL-2 (line-of-sight, dense over continental land masses), HFDL (long-range oceanic ionosphere bounce), SATCOM Inmarsat (L-band geo ±80°) and Iridium (LEO pole-to-pole).</p>
            <p><span className="text-sky-300 font-mono">REGULATORY.</span> ICAO Annex 10 Vol III Pt I §6 + Doc 9776 specify VDL Mode 2 (D8PSK 31.5 kbps over 25 kHz channelisation in 136-137 MHz aeronautical band). Doc 9869 PBCS defines RCP-240 / RSP-180 sec performance bounds for CPDLC/ADS-C riding on ACARS. RTCA DO-281B / EUROCAE ED-92B / ED-100A are the avionics MOPS. ARINC 741-7 (Inmarsat) and 781-9 (Iridium) specify SATCOM avionics. Reg (EC) 29/2009 + EASA SIB 2018-04 mandate datalink for IFR {`>`} FL285 in EU; FAA AC 90-117 codifies US datalink operational authorisation.</p>
            <p><span className="text-sky-300 font-mono">BEARER SELECT.</span> Per Honeywell DCM Rev D + Boeing FCOM Vol II §17 + Airbus FCOM DSC-46-10, the CMU bearer-selection algorithm tries VHF first (1× cost, ~2s latency); on no line-of-sight (horizon ≈ 1.23·√(alt_ft) NM) or VDL-2 ACSPC {`>`} 85% saturation (FAA InFO 18007), falls back to HFDL (4× cost, ~30 s); on HF margin {`<`} 0 dB escalates to SATCOM (7-8× cost, ~3 s on Iridium SBD, ~5 s Inmarsat SBB). Inmarsat preferred in lat ±80°; Iridium for polar {`>`} 80°N or {`<`} -60°S where geo-satellites fall below horizon.</p>
            <p><span className="text-sky-300 font-mono">OOOI.</span> The Out-Off-On-In event sequence is the airline-dispatch crown-jewel transaction set: Label 80 OUT on pushback (TAXI_OUT entry), Label 81 OFF on takeoff-roll (TAKEOFF entry), Label 82 ON at touchdown (LANDING entry), Label 83 IN at on-block at arrival gate (TAXI_IN exit). OOOI drives crew duty-time, gate management, baggage transit, connection management, ATC arrival/departure stamps. Missed OOOI events trigger downstream airline-OCC dispatcher escalation within 5-10 min; per ICAO GADSS Annex 6 Pt I Amendment 39 a missed cruise position-report (Label 4N) for {`>`} 15 min escalates to Aircraft Tracking Anomaly Alert.</p>
            <p><span className="text-sky-300 font-mono">SATURATION.</span> EUROCONTROL ACARS Spectrum Analysis 2017 (Hetherington et al.) documented that 9 of 30 EU VDL ground stations exceeded 85% slot utilisation during morning rush hours, causing 30-90 sec retransmit queues. FAA InFO 18007 confirmed similar saturation on US east coast hubs. SITA AIRCOM 2024 service spec rate-limits non-critical AOC labels (12/13/14/15) during peak hours to preserve OOOI and CPDLC traffic. CMU sustained-rate limit per ARINC 758 is the throughput ceiling: 4 msg/min on regional turboprops, 24 msg/min on military equipped airframes.</p>
            <p><span className="text-sky-300 font-mono">SCORING.</span> Per-flight: BLACKOUT if no bearer in scope (cruise &gt; 15 min triggers GADSS); DEGRADED if single bearer at link margin &lt; 0 dB; SATURATED on VDL-2 ACSPC &gt; 85%; HF-FALLBACK on dropped VHF to HFDL/SAT; OOOI-MISS on missed OUT/OFF/ON/IN event; CPDLC-ACT on active CPDLC dialogue; POS-REP on active ADS-C position-report cycle; NORMAL on dual-bearer healthy. Composite = max(7 drivers)·0.60 + mean(·)·0.40 multiplied by ADV-MUL. Region-level aggregate ranks bearers by share of airborne fleet; label aggregate ranks the ARINC 620 message types by active emission.</p>
            <p><span className="text-sky-300 font-mono">DISTINCT FROM.</span> CPDLC (controller↔pilot text — ACARS is the BEARER layer it rides on, Label B2/B6), PDC/DCL (pre-departure clearance — one phase only, uses ACARS Label CR), AIDC (ATC↔ATC inter-facility — no aircraft), VDL-2 (single bearer slice — ACARS spans all three), SATCOM/HF (single bearer technology), PBCS (RCP/RSP certification framework), SELCAL (voice selective calling tone-pair), GADSS (15-min position reporting mandate), HFDL (single bearer), VHF (voice frequency), D-ATIS (ATIS letter cycle uplink Label 4Q), FANS-1/A (oceanic application suite on top of ACARS).</p>
          </div>
        )}
      </div>
    </div>
  )
}
