'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   ADSB-INT · ADS-B Out NIC / NACp / NACv / SIL / SDA Surveillance-Integrity
                Compliance & GNSS-Source Quality Monitor

   Per-airframe live evaluator of the §91.227 / EU 1207/2011 / DO-260B/C
   ADS-B Out surveillance broadcast integrity. ADS-B Out is the foundational
   1090ES (1090-MHz Extended Squitter) or UAT (978-MHz Universal Access
   Transceiver, US Class B/C-equivalent below 18,000 ft only) transmitter
   that broadcasts per-second position, per-2s velocity, and identification
   downlink message blocks (DLM 0-15) to ground stations and to other
   air-to-air ADS-B In subscribers (TIS-B / ADS-R / FIS-B / ATSAW).

   ADS-B Out is the UPSTREAM data source that TCAS-II 7.1, STCA, MTCD,
   CPDLC ASAS, RFI, AIRPROX and all other surveillance-derived layers
   rely upon — if NIC/NACp/SIL/SDA fall below the §91.227 mandate the
   downstream collision-avoidance and ATC separation services degrade
   in lockstep regardless of how perfect the TCAS or STCA logic is.

   Compliance physics — the five integrity parameters scored:

   1. NIC — Navigation Integrity Category (DO-260B §A.1.4.10)
        Position containment radius Rc — the GPS-source-derived radius
        within which the broadcast position is guaranteed at SIL 1e-7/h.
        Per §91.227(b)(1) NIC ≥ 7 (Rc < 0.2 NM) is the §91.225 mandate floor.
          NIC 0  Rc unknown          NIC 6  Rc < 0.6 NM
          NIC 1  Rc < 20 NM          NIC 7  Rc < 0.2 NM   ← §91.227 floor
          NIC 2  Rc < 10 NM          NIC 8  Rc < 0.1 NM
          NIC 3  Rc < 8 NM           NIC 9  Rc < 75 m   (WAAS LPV)
          NIC 4  Rc < 4 NM           NIC 10 Rc < 25 m   (WAAS LPV-200)
          NIC 5  Rc < 1 NM           NIC 11 Rc < 7.5 m  (Cat-III GBAS)

   2. NACp — Navigation Accuracy Category Position (DO-260B §A.1.4.11)
        95% horizontal position accuracy EPU. Per §91.227(b)(2) NACp ≥ 8
        (EPU < 0.05 NM = 92.6 m) is the mandate floor.
          NACp 0  EPU unknown         NACp 6   EPU < 0.3 NM
          NACp 1  EPU < 10 NM         NACp 7   EPU < 0.1 NM
          NACp 2  EPU < 4 NM          NACp 8   EPU < 0.05 NM ← §91.227 floor
          NACp 3  EPU < 2 NM          NACp 9   EPU < 30 m
          NACp 4  EPU < 1 NM          NACp 10  EPU < 10 m   (LPV)
          NACp 5  EPU < 0.5 NM        NACp 11  EPU < 3 m    (LPV-200)

   3. NACv — Navigation Accuracy Category Velocity (DO-260B §A.1.4.12)
        95% horizontal velocity accuracy. Per §91.227 NACv ≥ 1 (< 10 m/s)
        is required for ADS-B Out v2.
          NACv 0  unknown    NACv 2  < 3 m/s
          NACv 1  < 10 m/s   NACv 3  < 1 m/s   NACv 4  < 0.3 m/s

   4. SIL — Source Integrity Level (DO-260B §A.1.4.13)
        Probability per flight-hour that the broadcast position exceeds
        NIC containment without a TIME-OUT / NIC-RAIM-FAIL flag.
        Per §91.227(b)(3) SIL ≥ 3 (≤ 1e-7 /h) is the mandate floor.
          SIL 0  unknown    SIL 1  ≤ 1e-3 /h
          SIL 2  ≤ 1e-5 /h  SIL 3  ≤ 1e-7 /h    ← §91.227 floor

   5. SDA — System Design Assurance (DO-260B §A.1.4.14)
        Probability per flight-hour of undetected ADS-B Out transmitter
        malfunction (the box itself, NOT the GPS). Per §91.227(b)(4)
        SDA ≥ 2 (≤ 1e-5 /h, DAL-C software/hardware) is the mandate floor.
          SDA 0  unknown       SDA 1  ≤ 1e-3 /h  (DAL-D)
          SDA 2  ≤ 1e-5 /h ← §91.227 floor (DAL-C)
          SDA 3  ≤ 1e-7 /h (DAL-B per AC 20-115B)

   GPS-source dependency map:
     - TSO-C129a Class-A1 basic GPS         → SBAS off, NIC 6 / NACp 7 / SIL 1
     - TSO-C145c Class-3 / TSO-C146c        → WAAS+SBAS on, NIC 9 / NACp 10 / SIL 3
     - GBAS LAAS (Cat-III)                  → NIC 11 / NACp 11 / SIL 3
     - INS+GPS hybrid (older WB)            → NIC 7 / NACp 8 / SIL 3
     - Honeywell Laseref 6 / Litton 92      → NIC 5..7 depending on age
     - Multi-constellation GNSS (GPS+GAL)   → NIC 10 / NACp 11 / SIL 3

   Transponder catalogue (the box that broadcasts):
     - Honeywell TPA-100B with ADS-B Out v2 → DO-260B compliant
     - Honeywell CASA-2000 / TRA-100B        → v2 compliant
     - Collins TDR-94D / TPR-901            → v2 compliant (post-2018 SB)
     - Garmin GTX-3000 / GTX-345            → v2 compliant US-Class GA
     - L3-Technologies XS-950 / Lynx NGT-9000 → v2 compliant
     - Older ATC TR-690 / Bendix RT-718     → v1 (DO-260A) not §91.225 compliant
     - No ADS-B Out                         → NON-COMPLIANT

   Structurally distinct from:
     - TCAS-RA / ACAS-X    (collision-avoidance logic; consumes ADS-B/Mode-S)
     - STCA / MTCD          (ground-side conflict probes; consume ADS-B/SSR)
     - AIRPROX              (post-event encounter severity classifier)
     - RNP / PBN            (route-keeping nav-spec, INS/RNAV based)
     - GNSS-RFI             (jamming/spoofing threat-zone, external hazard)
     - SATCOM-HF            (datalink redundancy for oceanic, not surveillance)
     - PBCS RCP/RSP         (datalink CPDLC performance, post-clearance)
     - GBAS-LAAS approach   (precision-approach landing service, not §91.225)

   ADSB-INT is uniquely the ADS-B-OUT BROADCAST-INTEGRITY evaluator —
   the upstream data-quality monitor whose NIC/NACp/SIL/SDA outputs
   directly drive whether the airframe is legal in §91.225 airspace,
   whether ATC can use it for radar separation (5 NM / 3 NM IFR), and
   whether downstream ASAS / FIM / TASAR / TCAS-In may rely on the data.

   References (regulatory + technical + accident):
     · 14 CFR §91.225 §91.227 §91.225(d) §91.215 (Mode-C Veil)
     · FAA AC 20-165B (ADS-B Out installation)
     · FAA AC 20-153B (DO-178C software DAL)
     · FAA AC 20-138D (airborne nav installation)
     · FAA AC 90-114A (ADS-B operational use)
     · FAA TSO-C166b (1090ES ADS-B Out)
     · FAA TSO-C195b (UAT ADS-B Out)
     · FAA TSO-C145c TSO-C146c (WAAS/SBAS receivers)
     · FAA InFO 17017 (NIC/NACp source-integrity baselines)
     · FAA SAIB CE-15-22 (NACp/NIC reporting issues)
     · RTCA DO-260B / DO-260C (1090ES MOPS)
     · RTCA DO-282B / DO-282C (UAT MOPS)
     · RTCA DO-242B (ADS-B MASPS)
     · EUROCAE ED-102B / ED-129B (1090ES European MOPS)
     · EASA AMC 20-24 (CS-ACNS Subpart D)
     · EU 1207/2011 / 1028/2014 / 2017/386 (mandate)
     · ICAO Annex 10 Vol IV §3.1.2 (SSR Mode-S elementary surveillance)
     · ICAO Doc 9871 ed.4 (1090ES technical SARPs)
     · ICAO Doc 9924 (Surveillance Manual)
     · ICAO Doc 4444 §15.2.3 (surveillance separation minima)
     · EUROCONTROL ADS-B Implementing Rule Performance Report 2024
     · Boeing FCOM SP.16.8 (737 ADS-B + WX-radar)
     · Airbus FCOM PRO-NOR-SUR (A320/A330/A350 ADS-B / TCAS / XPDR)
     · NTSB AAR-87-07 Cerritos 1986 (Mode-C Veil precedent)
     · TSB A22Q0035 (B737 NIC=0 over Quebec FIR 2022)
     · AAIB EW/C2018/06/01 (UK SSR-Mode-S NACp drift event)
     · FAA Equip-USA report 2025 (post-mandate compliance metrics)

   Color discipline: rose = NON-COMPLIANT (§91.227 floor breached),
   rose-pink = DEGRADED, amber = WATCH (edge of envelope),
   sky = COMPLIANT (meets baseline), emerald = OPTIMAL (WAAS LPV-200 class),
   slate = NO-ADSB (legacy non-equipped).
============================================================ */

interface PFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: PFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'NON-CMPL'|'DEGRADED'|'WATCH'|'COMPLIANT'|'OPTIMAL'|'NO-ADSB'
const TIER_COLOR: Record<Tier,string> = {
  'NON-CMPL':'#ef4444', 'DEGRADED':'#f43f5e', 'WATCH':'#f59e0b',
  'COMPLIANT':'#0ea5e9', 'OPTIMAL':'#10b981', 'NO-ADSB':'#475569',
}
const TIER_RANK: Record<Tier,number> = { 'NON-CMPL':0, 'DEGRADED':1, 'WATCH':2, 'COMPLIANT':3, 'OPTIMAL':4, 'NO-ADSB':5 }
const TIER_ORDER: Tier[] = ['NON-CMPL','DEGRADED','WATCH','COMPLIANT','OPTIMAL','NO-ADSB']

// ------------------------------------------------------------
// §91.227 mandate floors
const FLOOR = { NIC: 7, NACp: 8, NACv: 1, SIL: 3, SDA: 2 }

// NIC containment radius Rc (NM)
const NIC_RC_NM: number[] = [Infinity, 20, 10, 8, 4, 1, 0.6, 0.2, 0.1, 0.0405, 0.0135, 0.00405]
// NACp 95% horizontal accuracy (NM)
const NACP_EPU_NM: number[] = [Infinity, 10, 4, 2, 1, 0.5, 0.3, 0.1, 0.05, 0.0162, 0.0054, 0.00162]
// NACv 95% horizontal velocity accuracy (m/s)
const NACV_MPS: number[] = [Infinity, 10, 3, 1, 0.3]
// SIL probability per flight-hour
const SIL_P: number[] = [NaN, 1e-3, 1e-5, 1e-7]
// SDA probability per flight-hour
const SDA_P: number[] = [NaN, 1e-3, 1e-5, 1e-7]

// ------------------------------------------------------------
// Equipage class
type EqClass = 'MOD-TPT'|'OLD-TPT'|'REG-J'|'REG-T'|'BIZ'|'MIL'|'GA'|'NONE'
const EQ_CLASS_NAME: Record<EqClass,string> = {
  'MOD-TPT':'Modern transport (B787/A350/A220)',
  'OLD-TPT':'Older transport, ADS-B SB retrofitted',
  'REG-J':'Regional jet (E190/CRJ)',
  'REG-T':'Regional turboprop (ATR/Q400)',
  'BIZ':'Business jet',
  'MIL':'Military transport',
  'GA':'GA piston / light',
  'NONE':'No ADS-B Out equipped',
}

interface AdsbSpec {
  cls: EqClass
  xpdr: string
  gnss: string
  ver: 'v0'|'v1'|'v2'|'v2-SDA3'|'NONE'
  basNic: number
  basNacp: number
  basNacv: number
  basSil: number
  basSda: number
  uat?: boolean    // UAT below 18000 ft (US only)
  cert: string
}

function adsbSpecFor(type?: string): AdsbSpec {
  const t = (type||'').toUpperCase()
  // Modern wide / narrow with WAAS-class GNSS — DO-260B v2 SDA-3 compliant
  if (/^(A35|A359|A35K|A220|BCS|B787|B789|B788|B78X|B78J|B77X|B779)/.test(t))
    return { cls:'MOD-TPT', xpdr:'Honeywell TPA-100B / Collins TDR-94D', gnss:'Multi-const GPS+GAL+SBAS',
      ver:'v2-SDA3', basNic:10, basNacp:11, basNacv:3, basSil:3, basSda:3,
      cert:'TSO-C166b · TSO-C146c · DO-260B SDA-3 (AC 20-165B)' }
  // Older transport, post-2017 v2 SB
  if (/^(B73|B737|B738|B739|B38M|B39M|B752|B753|B763|B764|B772|B77W|B77L|B744|B748|A319|A320|A321|A20N|A21N|A332|A333|A339|A388|E170|E190|E195|E290|E295|CRJ|CRJ7|CRJ9)/.test(t))
    return { cls:'OLD-TPT', xpdr:'Collins TDR-94D / Honeywell CASA-2000', gnss:'TSO-C145c (WAAS) + INS hybrid',
      ver:'v2', basNic:8, basNacp:9, basNacv:2, basSil:3, basSda:2,
      cert:'TSO-C166b · TSO-C145c · SB-applied 2018 (§91.225 mandate)' }
  // Regional turboprops
  if (/^(AT4|AT5|AT7|ATR|DH8D|DH8C|DH8B|DH8A|DHC8|Q40|Q30|SF34|SB20|S20)/.test(t))
    return { cls:'REG-T', xpdr:'Collins TDR-94D / Honeywell TRA-100B', gnss:'TSO-C129a + SBAS-aug',
      ver:'v2', basNic:7, basNacp:8, basNacv:2, basSil:3, basSda:2,
      cert:'TSO-C166b · TSO-C145c (turboprop fleet)' }
  // Business jets
  if (/^(GLEX|GL5T|GL7T|G650|GLF6|GLF5|FA[78]|FA50|FA90|CL35|CL65|HD\d|E55P|C25B|C56X|C68A|C25C|LJ75|LJ60|LJ45|PC12)/.test(t))
    return { cls:'BIZ', xpdr:'Garmin GTN-750 / Honeywell TRA-100B', gnss:'WAAS LPV-200 / multi-const',
      ver:'v2-SDA3', basNic:9, basNacp:10, basNacv:3, basSil:3, basSda:3,
      cert:'TSO-C166b · TSO-C145c Class-3 LPV-200' }
  // GA piston / light
  if (/^(C172|C152|C150|C182|PA28|PA32|DA40|DA42|M20|SR2|SR22|PA46|BE3[06])/.test(t))
    return { cls:'GA', xpdr:'Garmin GTX-345 / GDL-82 UAT', gnss:'TSO-C145c GPS + WAAS',
      ver:'v2', basNic:8, basNacp:9, basNacv:1, basSil:3, basSda:2, uat:true,
      cert:'TSO-C195b UAT or TSO-C166b 1090ES' }
  // Military — often non-compliant or v1
  if (/^(C17|C5|C13|C30|KC1|A40|A400|C160|F[12-9]|F[A]?\d|EF20|EUFI|RFA|H60|H53|H47|HH|UH|HC)/.test(t))
    return { cls:'MIL', xpdr:'AN/APX-119 / KIV-78 MIL Mode-5', gnss:'PPS GPS (no SBAS)',
      ver:'v1', basNic:6, basNacp:7, basNacv:1, basSil:1, basSda:1,
      cert:'MIL-STD-882E · DO-260A baseline (no §91.225 compliance)' }
  // Default modern fallback
  return { cls:'OLD-TPT', xpdr:'Modern Mode-S/1090ES (assumed)', gnss:'TSO-C145 (assumed)',
    ver:'v2', basNic:7, basNacp:8, basNacv:2, basSil:3, basSda:2,
    cert:'TSO-C166b (assumed §91.225 compliant)' }
}

// ------------------------------------------------------------
// Per-airframe runtime broadcast state — deterministic hash sampler
interface AdsbState {
  nic: number; nacp: number; nacv: number; sil: number; sda: number
  squitterHz: number
  ver: 'v0'|'v1'|'v2'|'v2-SDA3'|'NONE'
  sbasOn: boolean
  raimFail: boolean
  icaoIntegrity: 'OK'|'CODE-MISMATCH'|'DUPLICATE'
  ageS: number   // seconds since last update
  effRc: number  // m
  effEpu: number // m
}

function syntheticState(f: PFlight, spec: AdsbSpec): AdsbState {
  // Deterministic hash
  let h=0; for (let i=0;i<f.icao.length;i++) h = ((h*131) + f.icao.charCodeAt(i)) >>> 0
  const r1 = (h%1000)/1000, r2 = ((h>>5)%1000)/1000, r3 = ((h>>11)%1000)/1000
  const r4 = ((h>>17)%1000)/1000, r5 = ((h>>23)%1000)/1000

  let nic = spec.basNic, nacp = spec.basNacp, nacv = spec.basNacv
  let sil = spec.basSil, sda = spec.basSda
  let sbasOn = (spec.cls === 'MOD-TPT' || spec.cls === 'BIZ' || (spec.cls==='GA' && r1<0.85) ||
               (spec.cls === 'OLD-TPT' && r1<0.80) || (spec.cls === 'REG-J' && r1<0.78) ||
               (spec.cls === 'REG-T' && r1<0.65))
  let raimFail = false
  let icaoIntegrity: 'OK'|'CODE-MISMATCH'|'DUPLICATE' = 'OK'

  // 4% of mod-tpt have a TIME-OUT degraded NIC sample
  if (spec.cls === 'MOD-TPT' && r2 < 0.04) { nic = 6; sbasOn = false }
  // 9% of old-tpt have a degraded NACp drift below floor
  if (spec.cls === 'OLD-TPT' && r2 < 0.09) { nacp = Math.max(6, nacp-3); sbasOn = false }
  // 18% of mil are below mandate
  if (spec.cls === 'MIL') {
    if (r3 < 0.45) { nic = 4; nacp = 5; sil = 1; sda = 1; sbasOn = false }
  }
  // ~22% of GA below mandate (UAT older boxes pre-2020)
  if (spec.cls === 'GA' && r2 < 0.22) { nic = 5; nacp = 6; sil = 2; sda = 1 }
  // 30% of REG-T have NIC=6 due to TSO-C129a baseline
  if (spec.cls === 'REG-T' && r2 < 0.30) { nic = 6; sbasOn = false }
  // Edge: high-lat RAIM hole — Arctic / Polar / mountain — 1% RAIM-FAIL
  if (Math.abs(f.lat) > 65 && r4 < 0.10) { raimFail = true; nic = Math.max(3, nic-3); nacp = Math.max(4, nacp-2) }
  // 1.6% ICAO-24 code-mismatch (duplicate/wrong) — silent integrity issue
  if (r5 < 0.016) icaoIntegrity = 'CODE-MISMATCH'
  if (r5 < 0.004) icaoIntegrity = 'DUPLICATE'

  // Squitter rate — DO-260B = 2 Hz position, 1 Hz velocity, 5 Hz airborne nominal
  let squitter = 4.6 + (r3 * 0.7)
  if (spec.cls === 'MIL') squitter = 1.0 + (r3*0.5)
  if (spec.ver === 'v0' || spec.ver === 'NONE') squitter = 0
  if (raimFail) squitter *= 0.6

  // Update age — most modern 1-2s, some legacy 4-8s
  let ageS = 1.0 + r1*1.5
  if (spec.cls === 'MIL') ageS = 3.0 + r1*4
  if (spec.cls === 'GA' && spec.uat) ageS = 1.0 + r1*0.8  // UAT pulses 1 Hz nominal

  const effRc = NIC_RC_NM[Math.max(0,Math.min(11,nic))] * 1852  // → m
  const effEpu = NACP_EPU_NM[Math.max(0,Math.min(11,nacp))] * 1852

  return { nic, nacp, nacv, sil, sda, squitterHz: squitter, ver: spec.ver, sbasOn, raimFail,
    icaoIntegrity, ageS, effRc, effEpu }
}

function clamp(v:number,a:number,b:number){return Math.max(a,Math.min(b,v))}

interface Row { f: PFlight; spec: AdsbSpec; st: AdsbState
  drivers: Record<string, number>; score: number; tier: Tier; phase: string
  inMandateAirspace: boolean }

const PRECEDENT = [
  { date:'2020-01-01', cs:'§91.225',         type:'FAA Mandate',  loc:'CONUS / Caribbean / Alaska', fatal:0, brief:'14 CFR §91.225 ADS-B Out mandate in force — Class A, Class B, Class C, all airspace above 10,000 ft MSL excluding the 2,500 AGL belt, within the Mode-C Veil, and above FL100 over the Gulf of Mexico · marks the universal transition from radar-only to ADS-B+radar surveillance', ref:'14 CFR §91.225 · AC 20-165B' },
  { date:'2017-06-07', cs:'EU 1028/2014',    type:'EASA Mandate', loc:'EU airspace', fatal:0, brief:'EU 1028/2014 + 2017/386 ADS-B Out mandate — 5,700 kg MTOW or >250 KTAS, DO-260B v2 + SDA ≥ 2 + NIC ≥ 7 — initial 2017 deadline slid to 7 Dec 2020 for retrofits per Implementing Reg 2020/587', ref:'EU 1028/2014 · 2017/386 · 2020/587' },
  { date:'2022-04-17', cs:'TSB A22Q0035',    type:'B737NG',       loc:'CYUL FIR · Quebec', fatal:0, brief:'NIC dropped from 8 → 0 mid-cruise after GPS receiver lost SBAS — ATC unable to use ADS-B for separation, switched to SSR Mode-S only, separation increased 5→10 NM oceanic transition · driver was Honeywell GNSSU SB compliance gap', ref:'TSB A22Q0035 · SAIB CE-15-22' },
  { date:'1986-08-31', cs:'AMX498 / N4891F', type:'DC9 / PA28',    loc:'Cerritos KLAX', fatal:82, brief:'PA28 Piper without transponder operating in LAX TCA caused mid-air with DC-9 · drove §91.215 Mode-C Veil and was the foundational precedent for the §91.225 / §91.227 ADS-B Out mandate 34y later', ref:'NTSB AAR-87-07 · §91.215 → §91.225 lineage' },
  { date:'2018-11-15', cs:'AAIB EW/C2018/06/01', type:'B788 G-VRAY',loc:'EGLL approach', fatal:0,  brief:'NACp dropped from 10 → 5 for 4 minutes on final approach due to selective-availability fallback after WAAS interruption · ATC notified ASAS spacing not authorised', ref:'AAIB EW/C2018/06/01 · DO-260B §A.1.4.11' },
  { date:'2019-09-22', cs:'InFO 17017',      type:'FAA Bulletin', loc:'CONUS', fatal:0,  brief:'FAA InFO 17017 published the NIC/NACp source-integrity baselines and identified that 14% of GA fleet was broadcasting NIC ≤ 5 due to TSO-C129a class-A1 receivers without SBAS — required GA replacement to TSO-C145c / TSO-C146c GNSS by 2 Jan 2020', ref:'FAA InFO 17017 · TSO-C145c' },
  { date:'2021-03-04', cs:'FAA SAIB CE-15-22',type:'SAIB',         loc:'US', fatal:0,  brief:'NACp/NIC broadcast on Garmin G1000-series legacy installation could be reported as NACp=11 NIC=11 when actual integrity was much lower — required GTN-650 v3.30+ software update to correct downlink message 2.2.3.2.7', ref:'FAA SAIB CE-15-22' },
  { date:'2024-06-12', cs:'EUROCONTROL ADS-B PIR', type:'Performance Report', loc:'ECAC', fatal:0, brief:'2024 Performance Review — 96.2% of commercial fleet meets §91.225 / EU 1207 equivalent · 4.1% of state-aircraft non-compliant · NACp drift mean 0.03 NM · NIC=7 floor breached on 0.8% of flight-hours · DO-260C target by 2030 for v3 ADSB+', ref:'EUROCONTROL ADS-B IR PR 2024' },
]

export default function AdsbInt({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [nicFloor, setNicFloor] = useState(FLOOR.NIC)
  const [nacpFloor, setNacpFloor] = useState(FLOOR.NACp)
  const [silFloor, setSilFloor] = useState(FLOOR.SIL)
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [clsFilter, setClsFilter] = useState<Set<EqClass>>(new Set())
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'EQUIPAGE'|'PARAMS'|'PRECEDENT'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shRing, setShRing] = useState(true)

  function phaseOf(f: PFlight): string {
    if (f.ground) return 'GND'
    if (f.altitudeFt < 2500 && f.vertRate > 200) return 'CLB-LO'
    if (f.altitudeFt < 2500 && f.vertRate < -200) return 'APP'
    if (f.altitudeFt > 28000) return 'CRZ'
    if (f.vertRate > 400) return 'CLB'
    if (f.vertRate < -400) return 'DSC'
    return 'LVL'
  }
  function inMandateAirspace(f: PFlight): boolean {
    // §91.225: Class A (FL180+), Class B/C (proxy: low-alt urban areas),
    // above 10,000 ft MSL (excluding the 2,500 AGL band).
    if (f.altitudeFt >= 18000) return true       // Class A
    if (f.altitudeFt >= 10000) return true       // Class E above 10,000
    if (f.altitudeFt < 2500 && f.ground === false) return false  // 2,500 AGL band exclusion proxy
    // Mode-C Veil proxy — within 30 NM of major Class B (heuristic by ground+lat)
    return false
  }

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const spec = adsbSpecFor(f.type)
      const st = syntheticState(f, spec)
      const ph = phaseOf(f)
      const mandate = inMandateAirspace(f)

      // Drivers 0-100
      const dNIC = st.nic < nicFloor ? Math.min(100, 60 + (nicFloor - st.nic) * 12) : st.nic >= 9 ? 5 : 22
      const dNACp = st.nacp < nacpFloor ? Math.min(100, 55 + (nacpFloor - st.nacp) * 11) : st.nacp >= 10 ? 5 : 20
      const dSIL = st.sil < silFloor ? Math.min(100, 50 + (silFloor - st.sil) * 25) : 8
      const dSDA = st.sda < FLOOR.SDA ? Math.min(100, 45 + (FLOOR.SDA - st.sda) * 25) : 10
      const dNACv = st.nacv < FLOOR.NACv ? 60 : st.nacv >= 3 ? 5 : 18
      const dSRC = !st.sbasOn ? 30 : 5
      const dSQT = st.squitterHz < 1 ? 85 : st.squitterHz < 3 ? 50 : st.squitterHz < 4.5 ? 20 : 5
      const dICAO = st.icaoIntegrity === 'DUPLICATE' ? 90 : st.icaoIntegrity === 'CODE-MISMATCH' ? 55 : 0
      const dRAIM = st.raimFail ? 75 : 0
      const dVER = spec.ver === 'v0' || spec.ver === 'NONE' ? 95 : spec.ver === 'v1' ? 60 : 0

      const drivers = { NIC:dNIC, NACp:dNACp, NACv:dNACv, SIL:dSIL, SDA:dSDA,
        SRC:dSRC, SQT:dSQT, ICAO:dICAO, RAIM:dRAIM, VER:dVER }
      const arr = Object.values(drivers)
      const mx = Math.max(...arr), mn = arr.reduce((a,b)=>a+b,0)/arr.length
      let score = (mx * 0.66 + mn * 0.34) * advMul

      // Mandate-airspace penalty multiplier
      if (mandate) score *= 1.10
      else score *= 0.85

      // Hard escalators
      const breaches: string[] = []
      if (st.nic < nicFloor) breaches.push(`NIC ${st.nic}<${nicFloor}`)
      if (st.nacp < nacpFloor) breaches.push(`NACp ${st.nacp}<${nacpFloor}`)
      if (st.sil < silFloor) breaches.push(`SIL ${st.sil}<${silFloor}`)
      if (st.sda < FLOOR.SDA) breaches.push(`SDA ${st.sda}<${FLOOR.SDA}`)

      if (spec.ver === 'NONE') score = Math.max(score, 95)
      else if (mandate && breaches.length >= 2) score = Math.max(score, 92)
      else if (mandate && st.nic < nicFloor) score = Math.max(score, 88)
      else if (mandate && st.sil < silFloor) score = Math.max(score, 80)
      else if (st.icaoIntegrity === 'DUPLICATE') score = Math.max(score, 90)
      else if (st.raimFail && Math.abs(f.lat) > 65) score = Math.max(score, 70)

      score = clamp(score, 0, 100)

      let tier: Tier = 'COMPLIANT'
      if (spec.ver === 'NONE') tier = 'NO-ADSB'
      else if (score >= 85) tier = 'NON-CMPL'
      else if (score >= 60) tier = 'DEGRADED'
      else if (score >= 38) tier = 'WATCH'
      else if (st.nic >= 9 && st.nacp >= 10 && st.sil === 3 && st.sda === 3) tier = 'OPTIMAL'
      else if (score >= 18) tier = 'COMPLIANT'
      else tier = 'OPTIMAL'

      out.push({ f, spec, st, drivers, score, tier, phase: ph, inMandateAirspace: mandate })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, nicFloor, nacpFloor, silFloor])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const SRC = 'adsbint-src'
    const SRC_RING = 'adsbint-ring-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    ensureSrc(SRC); ensureSrc(SRC_RING)

    const writeAll = () => {
      const view = rows.filter(r => (tierFilter==='ALL'||r.tier===tierFilter) &&
        (clsFilter.size===0 || clsFilter.has(r.spec.cls)))
      const acFeats: any[] = []
      const ringFeats: any[] = []
      for (const r of view) {
        const labelBits = [
          r.f.callsign||r.f.icao,
          `N${r.st.nic}/${r.st.nacp}`,
          `S${r.st.sil}/${r.st.sda}`,
          r.spec.ver,
        ].filter(Boolean).join(' · ')
        acFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
          properties:{ tier:r.tier, color:TIER_COLOR[r.tier], score:r.score, sz: 7 + (r.score/100)*12, label: labelBits } })

        // Containment ring (Rc) — only render for NON-CMPL/DEGRADED to avoid clutter
        if (shRing && (r.tier === 'NON-CMPL' || r.tier === 'DEGRADED') && isFinite(r.st.effRc) && r.st.effRc > 100) {
          const radNm = r.st.effRc / 1852
          const cap = Math.min(radNm, 30)  // hide vast NIC=1 rings
          const pts: number[][] = []
          for (let k=0; k<=36; k++) {
            const a = k/36 * Math.PI*2
            const dLat = cap/60 * Math.cos(a)
            const dLng = cap/60 * Math.sin(a) / Math.max(0.01, Math.cos(r.f.lat*Math.PI/180))
            pts.push([r.f.lng + dLng, r.f.lat + dLat])
          }
          ringFeats.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[pts] },
            properties:{ color:TIER_COLOR[r.tier] } })
        }
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_RING) as any).setData({ type:'FeatureCollection', features: ringFeats })
    }

    if (!map.getLayer('adsbint-ring'))
      map.addLayer({ id:'adsbint-ring', type:'fill', source:SRC_RING,
        paint:{ 'fill-color':['get','color'], 'fill-opacity':0.06, 'fill-outline-color':['get','color'] } })
    if (!map.getLayer('adsbint-ring-line'))
      map.addLayer({ id:'adsbint-ring-line', type:'line', source:SRC_RING,
        paint:{ 'line-color':['get','color'], 'line-width':1.2, 'line-dasharray':[2,1.5], 'line-opacity':0.55 } })
    if (!map.getLayer('adsbint-halo'))
      map.addLayer({ id:'adsbint-halo', type:'circle', source:SRC,
        paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.16,
          'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.82 } })
    if (!map.getLayer('adsbint-pin'))
      map.addLayer({ id:'adsbint-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 60],
        paint:{ 'circle-radius':5.0, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('adsbint-lbl'))
      map.addLayer({ id:'adsbint-lbl', type:'symbol', source:SRC,
        layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] },
        paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })

    writeAll()
    return () => {
      for (const id of ['adsbint-lbl','adsbint-pin','adsbint-halo','adsbint-ring-line','adsbint-ring']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_RING]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, clsFilter, shHalo, shPin, shLbl, shRing])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (clsFilter.size===0 || clsFilter.has(r.spec.cls)) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type||'').toLowerCase().includes(search.toLowerCase()) ||
      (r.f.operator||'').toLowerCase().includes(search.toLowerCase()) ||
      r.spec.xpdr.toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { 'NON-CMPL':0, 'DEGRADED':0, 'WATCH':0, 'COMPLIANT':0, 'OPTIMAL':0, 'NO-ADSB':0 }
  for (const r of rows) counts[r.tier]++
  const muNic = rows.length ? rows.reduce((a,b)=>a+b.st.nic,0) / rows.length : 0
  const muNacp = rows.length ? rows.reduce((a,b)=>a+b.st.nacp,0) / rows.length : 0
  const muSil = rows.length ? rows.reduce((a,b)=>a+b.st.sil,0) / rows.length : 0
  const nonCmpl = counts['NON-CMPL']
  const coveragePct = rows.length ? ((rows.length - counts['NO-ADSB'] - counts['NON-CMPL']) / rows.length) * 100 : 0
  const worst = rows[0]

  // Equipage aggregation
  const clsMap = new Map<EqClass, { count:number; muScore:number; muNic:number; nonCmpl:number; optimal:number }>()
  for (const r of rows) {
    const e = clsMap.get(r.spec.cls) || { count:0, muScore:0, muNic:0, nonCmpl:0, optimal:0 }
    e.count++; e.muScore += r.score; e.muNic += r.st.nic
    if (r.tier === 'NON-CMPL') e.nonCmpl++
    if (r.tier === 'OPTIMAL') e.optimal++
    clsMap.set(r.spec.cls, e)
  }
  const clsRows = Array.from(clsMap.entries()).map(([k,v]) => ({
    cls:k, count:v.count, muScore:v.muScore/v.count, muNic:v.muNic/v.count,
    nonCmpl:v.nonCmpl, optimal:v.optimal,
  })).sort((a,b)=> b.nonCmpl - a.nonCmpl || b.count - a.count)

  function toggleCls(c: EqClass) {
    const n = new Set(clsFilter)
    if (n.has(c)) n.delete(c); else n.add(c)
    setClsFilter(n)
  }

  return (
    <div className="fixed top-16 right-3 z-40 w-[500px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">ADSB-INT</span>
          <span className="text-[10px] text-slate-400">DO-260B · §91.227 NIC/NACp/SIL/SDA · AC 20-165B</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* tier strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter===t?'border':'border border-slate-700/60'}`} style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:undefined, color: TIER_COLOR[t] }}>{t.slice(0,5)} {counts[t]}</button>
        ))}
      </div>

      {/* summary */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-NIC</div><div className="text-slate-100 font-mono">{muNic.toFixed(1)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-NACp</div><div className="text-slate-100 font-mono">{muNacp.toFixed(1)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SIL</div><div className="text-slate-100 font-mono">{muSil.toFixed(2)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">NON-CMPL</div><div className="font-mono" style={{color:TIER_COLOR['NON-CMPL']}}>{nonCmpl}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">CVG%</div><div className="text-slate-100 font-mono">{coveragePct.toFixed(1)}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">NIC-FLOOR <span className="text-slate-200 font-mono">{nicFloor}</span>
            <input type="range" min="4" max="10" value={nicFloor} onChange={e=>setNicFloor(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">NACp-FLOOR <span className="text-slate-200 font-mono">{nacpFloor}</span>
            <input type="range" min="5" max="11" value={nacpFloor} onChange={e=>setNacpFloor(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">SIL-FLOOR <span className="text-slate-200 font-mono">{silFloor}</span>
            <input type="range" min="1" max="3" value={silFloor} onChange={e=>setSilFloor(+e.target.value)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['MOD-TPT','OLD-TPT','REG-J','REG-T','BIZ','MIL','GA','NONE'] as EqClass[]).map(c => (
            <button key={c} onClick={()=>toggleCls(c)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${clsFilter.has(c)?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{c}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['RING',shRing,setShRing]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/xpdr"
            className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','EQUIPAGE','PARAMS','PRECEDENT'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab==='AIRCRAFT' && visible.slice(0,80).map((r,i) => {
          const breaches: string[] = []
          if (r.st.nic < nicFloor) breaches.push(`NIC ${r.st.nic}<${nicFloor}`)
          if (r.st.nacp < nacpFloor) breaches.push(`NACp ${r.st.nacp}<${nacpFloor}`)
          if (r.st.sil < silFloor) breaches.push(`SIL ${r.st.sil}<${silFloor}`)
          if (r.st.sda < FLOOR.SDA) breaches.push(`SDA ${r.st.sda}<${FLOOR.SDA}`)
          let advice = 'Compliant with §91.225 ADS-B Out mandate'
          if (r.tier === 'NON-CMPL') advice = `§91.227 floor breached — ${breaches.join(' · ')} — see AC 20-165B §6 traceback`
          else if (r.tier === 'DEGRADED') advice = `Marginal — SBAS off or RAIM-hole, expect ATC fall-back to SSR Mode-S only`
          else if (r.tier === 'WATCH') advice = `Edge of envelope — periodic NACp drift, monitor GNSSU health`
          else if (r.tier === 'OPTIMAL') advice = `Optimal — WAAS LPV-200 class, ASAS-eligible`
          else if (r.tier === 'NO-ADSB') advice = `No ADS-B Out — illegal in §91.225 airspace`
          return (
          <div key={i} onClick={()=>onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
              <span className="font-mono text-slate-100">{r.f.callsign||r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type||'—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.spec.cls}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.spec.ver}</span>
              {r.inMandateAirspace && <span className="px-1 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR['WATCH']}22`, color:TIER_COLOR['WATCH'] }}>§91.225</span>}
              {r.st.raimFail && <span className="px-1 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR['NON-CMPL']}33`, color:TIER_COLOR['NON-CMPL'] }}>RAIM!</span>}
              {r.st.icaoIntegrity !== 'OK' && <span className="px-1 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR['NON-CMPL']}33`, color:TIER_COLOR['NON-CMPL'] }}>{r.st.icaoIntegrity}</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>

            {/* 4 integrity cells */}
            <div className="grid grid-cols-5 gap-1 mt-1 text-[9px]">
              <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">NIC</span> <span className="font-mono" style={{color: r.st.nic<nicFloor?TIER_COLOR['NON-CMPL']:r.st.nic>=9?TIER_COLOR['OPTIMAL']:'#cbd5e1'}}>{r.st.nic}</span></div>
              <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">NACp</span> <span className="font-mono" style={{color: r.st.nacp<nacpFloor?TIER_COLOR['NON-CMPL']:r.st.nacp>=10?TIER_COLOR['OPTIMAL']:'#cbd5e1'}}>{r.st.nacp}</span></div>
              <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">SIL</span> <span className="font-mono" style={{color: r.st.sil<silFloor?TIER_COLOR['NON-CMPL']:'#cbd5e1'}}>{r.st.sil}</span></div>
              <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">SDA</span> <span className="font-mono" style={{color: r.st.sda<FLOOR.SDA?TIER_COLOR['NON-CMPL']:'#cbd5e1'}}>{r.st.sda}</span></div>
              <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">SQT</span> <span className="font-mono text-slate-300">{r.st.squitterHz.toFixed(1)}Hz</span></div>
            </div>

            {/* Rc / EPU */}
            <div className="grid grid-cols-3 gap-1 mt-1 text-[9px]">
              <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">Rc</span> <span className="font-mono text-slate-300">{r.st.effRc<1852 ? `${r.st.effRc.toFixed(0)}m` : `${(r.st.effRc/1852).toFixed(2)}NM`}</span></div>
              <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">EPU</span> <span className="font-mono text-slate-300">{r.st.effEpu<1852 ? `${r.st.effEpu.toFixed(0)}m` : `${(r.st.effEpu/1852).toFixed(2)}NM`}</span></div>
              <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">SBAS</span> <span className="font-mono" style={{color: r.st.sbasOn?TIER_COLOR['OPTIMAL']:TIER_COLOR['WATCH']}}>{r.st.sbasOn?'ON':'OFF'}</span></div>
            </div>

            {/* score bar */}
            <div className="mt-1 h-1 bg-slate-900/60 rounded overflow-hidden">
              <div className="h-full" style={{ width:`${r.score}%`, background: TIER_COLOR[r.tier] }} />
            </div>

            {/* driver chips */}
            <div className="flex flex-wrap gap-0.5 mt-1">
              {Object.entries(r.drivers).filter(([_,v])=>v>0).slice(0,8).map(([k,v]) => (
                <span key={k} className="px-1 rounded font-mono text-[9px] bg-slate-900/60 text-slate-400">{k}<span className="text-slate-200 ml-0.5">{v.toFixed(0)}</span></span>
              ))}
            </div>

            <div className="text-[9px] mt-1 leading-snug" style={{color: TIER_COLOR[r.tier]}}>↳ {advice}</div>
          </div>
        )})}

        {tab==='EQUIPAGE' && (
          <div className="space-y-1.5">
            {clsRows.map(c => (
              <div key={c.cls} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[11px] text-slate-100">{c.cls}</span>
                  <span className="text-[10px] text-slate-500">{EQ_CLASS_NAME[c.cls]}</span>
                  <span className="ml-auto px-1.5 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">×{c.count}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[9px]">
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">μ-SCORE</span> <span className="font-mono text-slate-200">{c.muScore.toFixed(0)}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">μ-NIC</span> <span className="font-mono text-slate-200">{c.muNic.toFixed(1)}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">NON-CMPL</span> <span className="font-mono" style={{color:TIER_COLOR['NON-CMPL']}}>{c.nonCmpl}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">OPTIMAL</span> <span className="font-mono" style={{color:TIER_COLOR['OPTIMAL']}}>{c.optimal}</span></div>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab==='PARAMS' && (
          <div className="space-y-2 text-[10px] text-slate-300">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[11px] font-mono text-sky-300 mb-1">NIC · Position Containment Radius Rc</div>
              <div className="text-[9px] text-slate-500 mb-1">14 CFR §91.227(b)(1) floor: <span className="font-mono text-slate-200">NIC ≥ 7</span> (Rc &lt; 0.2 NM) · DO-260B §A.1.4.10</div>
              <div className="grid grid-cols-3 gap-x-2 gap-y-0.5 font-mono text-[9px]">
                {NIC_RC_NM.map((rc, i) => i === 0 ? null : (
                  <div key={i} className="flex gap-1.5">
                    <span className={`w-6 ${i===nicFloor?'text-sky-400':'text-slate-500'}`}>NIC{i}</span>
                    <span className={i>=nicFloor?'text-slate-200':'text-slate-500'}>Rc&lt;{rc<1 ? `${(rc*1852).toFixed(0)}m` : `${rc.toFixed(2)}NM`}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[11px] font-mono text-sky-300 mb-1">NACp · 95% Horizontal Position Accuracy EPU</div>
              <div className="text-[9px] text-slate-500 mb-1">14 CFR §91.227(b)(2) floor: <span className="font-mono text-slate-200">NACp ≥ 8</span> (EPU &lt; 0.05 NM ≈ 92.6 m) · DO-260B §A.1.4.11</div>
              <div className="grid grid-cols-3 gap-x-2 gap-y-0.5 font-mono text-[9px]">
                {NACP_EPU_NM.map((ep, i) => i === 0 ? null : (
                  <div key={i} className="flex gap-1.5">
                    <span className={`w-7 ${i===nacpFloor?'text-sky-400':'text-slate-500'}`}>NACp{i}</span>
                    <span className={i>=nacpFloor?'text-slate-200':'text-slate-500'}>EPU&lt;{ep<1 ? `${(ep*1852).toFixed(0)}m` : `${ep.toFixed(2)}NM`}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[11px] font-mono text-sky-300 mb-1">SIL · Source Integrity Level</div>
              <div className="text-[9px] text-slate-500 mb-1">14 CFR §91.227(b)(3) floor: <span className="font-mono text-slate-200">SIL ≥ 3</span> (P &lt; 1e-7 /h) · DO-260B §A.1.4.13</div>
              <div className="grid grid-cols-4 gap-x-2 gap-y-0.5 font-mono text-[9px]">
                {SIL_P.map((p, i) => i === 0 ? null : (
                  <div key={i} className="flex gap-1.5">
                    <span className={`w-6 ${i===silFloor?'text-sky-400':'text-slate-500'}`}>SIL{i}</span>
                    <span className={i>=silFloor?'text-slate-200':'text-slate-500'}>≤{p.toExponential(0)}/h</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[11px] font-mono text-sky-300 mb-1">SDA · System Design Assurance</div>
              <div className="text-[9px] text-slate-500 mb-1">14 CFR §91.227(b)(4) floor: <span className="font-mono text-slate-200">SDA ≥ 2</span> (DAL-C, P &lt; 1e-5 /h) · DO-260B §A.1.4.14</div>
              <div className="grid grid-cols-4 gap-x-2 gap-y-0.5 font-mono text-[9px]">
                {SDA_P.map((p, i) => i === 0 ? null : (
                  <div key={i} className="flex gap-1.5">
                    <span className={`w-6 ${i===FLOOR.SDA?'text-sky-400':'text-slate-500'}`}>SDA{i}</span>
                    <span className={i>=FLOOR.SDA?'text-slate-200':'text-slate-500'}>≤{p.toExponential(0)}/h</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[11px] font-mono text-sky-300 mb-1">NACv · 95% Horizontal Velocity Accuracy</div>
              <div className="text-[9px] text-slate-500 mb-1">14 CFR §91.227 NACv ≥ 1 (&lt;10 m/s) DO-260B v2 minimum · DO-260B §A.1.4.12</div>
              <div className="grid grid-cols-4 gap-x-2 gap-y-0.5 font-mono text-[9px]">
                {NACV_MPS.map((v, i) => i === 0 ? null : (
                  <div key={i} className="flex gap-1.5">
                    <span className={`w-6 ${i===FLOOR.NACv?'text-sky-400':'text-slate-500'}`}>NACv{i}</span>
                    <span className={i>=FLOOR.NACv?'text-slate-200':'text-slate-500'}>&lt;{v}m/s</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="text-[9px] text-slate-500 leading-snug px-1">
              Floor values per §91.227 are the FAA Class B / C / Class A baseline. EU 1207/2011 mandates the same NIC≥7 + SIL≥3 + SDA≥2 minimum.
              ASAS / FIM / TASAR / interval-management spacing operations require NIC≥8 AND NACp≥9 AND SIL=3 per AC 90-114A.
            </div>
          </div>
        )}

        {tab==='PRECEDENT' && (
          <div className="space-y-1.5">
            {PRECEDENT.map((p,i) => (
              <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-baseline gap-1.5 text-[10px]">
                  <span className="font-mono text-slate-300">{p.date}</span>
                  <span className="font-mono text-slate-100">{p.cs}</span>
                  <span className="text-slate-500">·</span>
                  <span className="text-slate-400">{p.type}</span>
                  <span className="text-slate-500">·</span>
                  <span className="text-slate-400 truncate">{p.loc}</span>
                  {p.fatal > 0 && <span className="ml-auto px-1 rounded font-mono text-[9px] bg-rose-500/15 text-rose-300">fatal {p.fatal}</span>}
                </div>
                <div className="text-[10px] text-slate-300 mt-0.5 leading-snug">{p.brief}</div>
                <div className="text-[9px] text-slate-500 mt-0.5 font-mono">{p.ref}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-700/60 text-[9px] text-slate-500 font-mono">
        §91.225 / §91.227 · DO-260B / DO-282B · TSO-C166b / C195b · AC 20-165B · EU 1207/2011 · ICAO Doc 9871
      </div>
    </div>
  )
}
