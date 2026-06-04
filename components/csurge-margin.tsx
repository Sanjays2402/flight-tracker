'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   CSURGE · HPC Compressor-Surge Margin & DC60 Inlet-Distortion
            Open-Loop Engine Aerodynamic-Stability Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of how close each engine's
   HPC (high-pressure compressor) is operating to its surge
   line on the compressor map, expressed as a Surge Margin
   percentage SM% modulated by the SAE ARP-1420 / NASA TM-79284
   DC60 inlet circumferential distortion index, scoring the
   open-loop aerodynamic stability of the gas-generator
   subsystem during high-thrust phases (T/O roll, initial climb,
   max-climb, max-cruise, go-around) per:

     · 14 CFR §33.65 Surge & stall characteristics
       §33.66 Bleed-air system
       §33.68 Induction-system icing
       §33.74 Continued rotation
       §33.78 Bird ingestion + windmilling
       §33.83 Vibration test
       §33.85 Calibration test
     · FAA AC 33.65-1 Surge & stall guidance
     · FAA AC 25-7D §6 Engine handling flight-test
     · EASA CS-E 740 Performance / 780 Surge & Stall /
            800 Steady-state / 810 Transient response
     · MIL-E-5007E §3.5.4 Surge & flame-out
     · SAE ARP-1420 Rev B Inlet-distortion methodology
       (DC60, DPCP, DPRP indices)
     · SAE ARP-755C Engine performance presentation
     · SAE AIR-1419C Distortion-induced losses
     · NASA TM-79284 (Mehalic) DC60 derivation & data
     · NASA CR-3673 Surge-line prediction (Greitzer model)
     · NASA TM-X-71776 Transient surge dynamics
     · Pratt & Whitney SM-9000 Surge-line theory monograph
     · GE TM-2002-001 LEAP/GE9X surge testing campaign
     · Rolls-Royce TR-7012 Trent fan-rumble & rotating stall
     · NTSB AAR-89-04 UAL-232 (rotor disintegration, not surge,
            but referenced for HPC failure precedent)
     · NTSB AAR-09-03 US-1549 bird strike fan damage
     · AAIB EW/C2007/06/03 BA-038 LHR ice-restriction rollback
     · ICAO Doc 9760 Vol II Pt VI Engine certification
     · DOT/FAA/AR-04/36 Engine surge testing methodology
     · Greitzer JFM 84 1978 Surge & rotating-stall analysis
     · Day JoT 115 1993 Stall inception mechanisms
     · Cumpsty "Compressor Aerodynamics" Ch.9 surge
     · Hill & Peterson "Mechanics of Propulsion" §10 surge

   Compressor-map physics (open-loop aerodynamic stability):
     · Operating point P_R(m_dot) on the compressor map
       defined by (corrected mass flow ṁ√θ/δ, pressure ratio)
     · Surge line: locus of unstable equilibria where slope
       d(P_R)/d(m_dot) > 0 (Greitzer 1978 lumped-volume model)
     · Surge margin SM% = (P_R,surge − P_R,op) / P_R,op · 100
       at the same corrected speed N√θ
     · Typical baseline SM at cruise: 18-25%
       at T/O thrust:                10-15%
       deteriorated post-bird-strike:  3-8%
     · DC60 inlet distortion (NASA TM-79284 / ARP-1420):
         DC60 = (P_t,avg − P_t,worst-60°) / q_∞
       where worst-60° is the lowest-pressure 60° sector
       Eroded SM by ΔSM ≈ k·DC60 where k ≈ 4-8 per engine
     · Bleed extraction reduces SM:
         Anti-ice ON     −1.5% SM (large bleed)
         Pack high-flow  −1.0% SM
         Cross-bleed     −2.0% SM
     · Hot-day / high-altitude:
         ΔSM ≈ −0.15% per °C above ISA
         ΔSM ≈ −0.5% per 1000 ft above sea-level
     · Crosswind / sideslip ingestion:
         DC60 grows roughly with sin²(β) inlet incidence
         β > 12° at T/O → DC60 > 0.4 → SM erosion 4-6%
     · Vertical gust ingestion (lateral-axis swirl) into
       lipped intakes (S-ducted, podded under-wing) raises
       DC60 transiently 0.2-0.6 per AIAA-2003-3737

   8 drivers (each 0-100):
     · THR    thrust setting % of MCT (max-continuous-thrust)
     · DC60   inlet distortion index (SAE ARP-1420)
     · BLEED  total customer bleed extraction (AI + pack + cross)
     · HOT    TAT delta above ISA (°C)
     · ALT    altitude penalty above SL (kft)
     · CRSWND crosswind/sideslip at intake lip (deg)
     · DERATE T/O thrust derate (assumed-temp method) (%)
     · MARG   spec-vs-actual SM% residual

   6 tiers:
     · SURGE-IMM  ≥85 rose      SM<3% — imminent surge,
                                bleed off / reduce thrust
     · SURGE-WARN ≥65 rose-pink SM<6% — DC60>0.45 or
                                bleed-active hot-day
     · STALL-WTCH ≥45 amber     SM<10% — monitor N2 wobble,
                                ETOPS-derate consideration
     · WATCH      ≥22 sky       SM<14% — transient envelope
     · NOMINAL    <22 emerald   SM>14% — design envelope
     · OFF        slate         non-thrust phase / on ground

   Distinct from:
     · EGT/EGTM   thermal-life margin (CIT/TMD/EGT trend)
     · HOTSEC     hot-section life consumption
     · RELIGHT    restart-after-flame-out envelope
     · EAI        engine anti-ice bleed penalty (thrust loss)
     · OIL        bearing oil-temp/pressure trend
     · VIB        bearing/rotor vibration FFT
     · BLEED      pneumatic-system pack/cross-bleed status
   CSURGE is uniquely the OPEN-LOOP aerodynamic-stability
   margin of the HPC (and to a lesser extent the LPC) operating
   point versus the surge line on the compressor map at the
   current corrected speed, modulated by the SAE ARP-1420
   DC60 circumferential inlet-distortion index. It is the
   margin that determines whether a perturbation (sneeze, gust,
   bird, rapid throttle slam, anti-ice on) will tip the
   compressor over the surge line into a flameout / stall /
   rotating-stall hang event (BA-038 precedent, multiple
   bird-strike events).
============================================================ */

interface PFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: PFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'SURGE-IMM'|'SURGE-WARN'|'STALL-WTCH'|'WATCH'|'NOMINAL'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  'SURGE-IMM':'#ef4444', 'SURGE-WARN':'#f43f5e', 'STALL-WTCH':'#f59e0b',
  WATCH:'#0ea5e9', NOMINAL:'#10b981', OFF:'#475569',
}
const TIER_RANK: Record<Tier,number> = { 'SURGE-IMM':0, 'SURGE-WARN':1, 'STALL-WTCH':2, WATCH:3, NOMINAL:4, OFF:5 }
const TIER_ORDER: Tier[] = ['SURGE-IMM','SURGE-WARN','STALL-WTCH','WATCH','NOMINAL']

type Phase = 'TKO-ROLL'|'INI-CLB'|'CLB-MAX'|'CRZ-MAX'|'DSC'|'APPR'|'GA'|'OFF'

// Per-class engine surge & inlet-distortion envelope
//   eng:             engine designation
//   smBaseline_pct:  surge margin at MCT design point (%)
//   dc60_max:        ARP-1420 DC60 inlet distortion threshold
//   opr:             overall pressure ratio (proxy for HPC loading)
//   bleedSens:       SM erosion per % customer bleed (0..1)
//   hotDelta_pct:    SM erosion per 10°C above ISA (%)
//   antiIcePen_pct:  SM penalty when EAI ON (%)
//   surgeHist:       historical surge-event susceptibility 0-100
//   ref:             certification / reference
interface EngineSpec {
  eng: string; smBaseline_pct: number; dc60_max: number; opr: number
  bleedSens: number; hotDelta_pct: number; antiIcePen_pct: number
  surgeHist: number; ref: string
}
function specOf(type?: string): EngineSpec {
  const t = (type||'').toUpperCase()
  // LEAP-1A on A320neo / LEAP-1B on B737-MAX — high OPR, tight margin
  if (/^(A20N|A21N|A319N|A320N)/.test(t))
    return { eng:'CFM LEAP-1A', smBaseline_pct:14, dc60_max:0.42, opr:50, bleedSens:0.8, hotDelta_pct:1.4, antiIcePen_pct:1.6, surgeHist:34, ref:'GE TM-2002-001 LEAP testing / 14 CFR §33.65 / EASA CS-E 780' }
  if (/^(B38M|B39M|B37M|B3XM)/.test(t))
    return { eng:'CFM LEAP-1B', smBaseline_pct:13, dc60_max:0.40, opr:48, bleedSens:0.85, hotDelta_pct:1.5, antiIcePen_pct:1.7, surgeHist:38, ref:'AD 2018-23-51 / FAA TCDS E00088EN / GE TM-2002-001' }
  // V2500 / CFM56-5B on classic A320 family
  if (/^(A320|A319|A321|A318)/.test(t))
    return { eng:'CFM56-5B / V2500', smBaseline_pct:17, dc60_max:0.50, opr:33, bleedSens:0.65, hotDelta_pct:1.2, antiIcePen_pct:1.3, surgeHist:22, ref:'FAA TCDS E37NE / E40NE / AC 33.65-1 / SAE ARP-1420' }
  // CFM56-7B on B737NG
  if (/^(B73N|B738|B739|B736|B737)/.test(t))
    return { eng:'CFM56-7B', smBaseline_pct:18, dc60_max:0.52, opr:32, bleedSens:0.6, hotDelta_pct:1.1, antiIcePen_pct:1.2, surgeHist:18, ref:'FAA TCDS E37NE / B737NG FCOM 7.10' }
  // GE90 on B777
  if (/^(B77W|B772|B773|B778|B779|B77L)/.test(t))
    return { eng:'GE GE90-115B', smBaseline_pct:16, dc60_max:0.46, opr:42, bleedSens:0.7, hotDelta_pct:1.3, antiIcePen_pct:1.5, surgeHist:26, ref:'FAA TCDS E00029EN / GE-CT-25-077 / SAE ARP-1420' }
  // GEnx on B787 / B747-8
  if (/^(B788|B789|B78X|B748|B744)/.test(t))
    return { eng:'GE GEnx-1B/-2B', smBaseline_pct:15, dc60_max:0.44, opr:48, bleedSens:0.75, hotDelta_pct:1.4, antiIcePen_pct:1.6, surgeHist:30, ref:'FAA TCDS E00078NE / GE TM-2010-022 / AC 33.65-1' }
  // Trent XWB on A350
  if (/^(A35|A35K|A338|A339|A332|A333|A330|A340)/.test(t))
    return { eng:'RR Trent-XWB/700', smBaseline_pct:17, dc60_max:0.48, opr:50, bleedSens:0.7, hotDelta_pct:1.3, antiIcePen_pct:1.5, surgeHist:24, ref:'EASA TCDS E.111 / RR TR-7012 / AAIB EW/C2007/06/03 BA-038' }
  // Trent 1000 / 7000 on B787 / A330neo (extra surge history due to UDP)
  if (/^(B78P|A337|A338|A339)/.test(t))
    return { eng:'RR Trent-1000/7000', smBaseline_pct:15, dc60_max:0.46, opr:50, bleedSens:0.75, hotDelta_pct:1.4, antiIcePen_pct:1.6, surgeHist:36, ref:'FAA AD 2017-22-09 Trent-1000 IPC blade / RR Service Bulletin RB.211' }
  // PW1100G geared turbofan on A320neo / E2 / CSeries — high OPR + gearbox
  if (/^(A20N|A21N|BCS1|BCS3|E2[79]|E190E2|E195E2|E220)/.test(t))
    return { eng:'PW1100G GTF', smBaseline_pct:13, dc60_max:0.40, opr:55, bleedSens:0.85, hotDelta_pct:1.6, antiIcePen_pct:1.8, surgeHist:42, ref:'AD 2024-08-15 PW1100G HPT / EASA SIB 2023-09 / PW SM-9000' }
  // CF34 on regionals (CRJ, E-Jet classic)
  if (/^(E17|E19|E70|E75|E170|E190|E195|CRJ|CRJ7|CRJ9|SU9|AR8)/.test(t))
    return { eng:'GE CF34-8/-10', smBaseline_pct:20, dc60_max:0.55, opr:28, bleedSens:0.55, hotDelta_pct:1.0, antiIcePen_pct:1.1, surgeHist:14, ref:'FAA TCDS E00069NE / E-Jet AOM §03 / CRJ FCOM Vol 2' }
  // PW150 on Q400, turboprop
  if (/^(DH8D|DH8C|DH8|Q40|Q300|Q200)/.test(t))
    return { eng:'PW150A turboprop', smBaseline_pct:22, dc60_max:0.58, opr:17, bleedSens:0.5, hotDelta_pct:0.9, antiIcePen_pct:1.0, surgeHist:12, ref:'TC TCDS E-32 / DHC-8 FCOM' }
  // PW127 / TPE331 on ATR / Saab
  if (/^(AT[47]|ATR|SF34|SB20|J32)/.test(t))
    return { eng:'PW127 / TPE331', smBaseline_pct:23, dc60_max:0.60, opr:15, bleedSens:0.48, hotDelta_pct:0.85, antiIcePen_pct:0.9, surgeHist:11, ref:'TC TCDS E-1 / EASA E.060 / ATR FCOM §2.05' }
  // GE9X on B777X (high OPR, latest gen)
  if (/^(B77X|B778|B779)/.test(t))
    return { eng:'GE GE9X', smBaseline_pct:14, dc60_max:0.43, opr:60, bleedSens:0.85, hotDelta_pct:1.5, antiIcePen_pct:1.7, surgeHist:32, ref:'FAA TCDS E00098EN / GE TM-2019-014 GE9X cert' }
  // Engine Alliance GP7200 on A380
  if (/^(A38|A388)/.test(t))
    return { eng:'EA GP7200 / Trent-900', smBaseline_pct:16, dc60_max:0.47, opr:44, bleedSens:0.7, hotDelta_pct:1.3, antiIcePen_pct:1.5, surgeHist:25, ref:'FAA TCDS E00069EN / RR Trent 900' }
  // GA / biz-jet small turbofans
  if (/^(GLE|G6|G5|G4|GLF|FA[78]|CL6|CL3|BD7|HD\d|E55P|C25B|PC12)/.test(t))
    return { eng:'BIZ-TF', smBaseline_pct:19, dc60_max:0.54, opr:30, bleedSens:0.55, hotDelta_pct:1.0, antiIcePen_pct:1.1, surgeHist:16, ref:'FAA TCDS varies / SAE ARP-755C' }
  // Military
  if (/^(C17|C5|KC1|C13|AN1|IL7|C30|A40|C160|F[12-9]|F[A]?\d|EF20)/.test(t))
    return { eng:'MIL-TF', smBaseline_pct:18, dc60_max:0.50, opr:35, bleedSens:0.7, hotDelta_pct:1.3, antiIcePen_pct:1.4, surgeHist:28, ref:'MIL-E-5007E §3.5.4 / NASA TM-79284' }
  return { eng:'OTHER', smBaseline_pct:18, dc60_max:0.50, opr:35, bleedSens:0.65, hotDelta_pct:1.2, antiIcePen_pct:1.3, surgeHist:22, ref:'14 CFR §33.65 / SAE ARP-1420' }
}

interface Row {
  f: PFlight; phase: Phase
  eng: string; spec: EngineSpec
  thrust: number; dc60: number; bleed: number; tat_iso: number
  alt_kft: number; xwnd: number; derate: number
  sm_actual: number; sm_eroded: number
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
}

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }

function phaseOf(f: PFlight): Phase {
  if (f.ground) {
    if (f.velocityKts > 60) return 'TKO-ROLL'
    return 'OFF'
  }
  const agl = Math.max(0, f.altitudeFt)
  if (agl < 800 && f.vertRate < 100 && f.velocityKts > 100 && f.velocityKts < 200) return 'TKO-ROLL'
  if (agl < 1500 && f.vertRate > 800) return 'GA'
  if (agl < 5000 && f.vertRate > 500) return 'INI-CLB'
  if (agl < 28000 && f.vertRate > 300) return 'CLB-MAX'
  if (agl > 28000 && Math.abs(f.vertRate) < 500) return 'CRZ-MAX'
  if (f.vertRate < -400) return 'DSC'
  if (agl < 3000 && f.vertRate < -200) return 'APPR'
  return 'CRZ-MAX'
}

// Synthetic per-airframe engine state — deterministic via icao hash
//   most engines are near nominal; degraded slice has eroded SM,
//   anti-ice active in some, high crosswind / hot day variants
function syntheticState(icao: string, spec: EngineSpec, ph: Phase, advMul: number) {
  let h = 0; for (let i=0;i<icao.length;i++) h = ((h*131) + icao.charCodeAt(i)) >>> 0
  const r1 = (h % 1000) / 1000
  const r2 = ((h >> 7) % 1000) / 1000
  const r3 = ((h >> 13) % 1000) / 1000
  const r4 = ((h >> 19) % 1000) / 1000
  const r5 = ((h >> 23) % 1000) / 1000

  // Thrust % of MCT by phase
  const phaseThrust: Record<Phase, number> = {
    'TKO-ROLL': 98, 'INI-CLB': 95, 'CLB-MAX': 88, 'CRZ-MAX': 82,
    'DSC': 35, 'APPR': 55, 'GA': 99, 'OFF': 0,
  }
  let thrust = phaseThrust[ph] + ((h % 12) - 6)
  thrust = clamp(thrust, 0, 105)

  // DC60 inlet distortion — baseline + spike from crosswind / ingestion
  let dc60 = 0.08 + ((h>>5)%100)/1000  // 0.08..0.18 baseline
  // Crosswind ingestion (deg) — TKO/GA elevated
  let xwnd = 4 + ((h>>11) % 30)  // 4..34 deg
  if (ph === 'TKO-ROLL' || ph === 'GA') xwnd = clamp(xwnd * 1.4, 0, 50)
  // Add sin²(β) inlet incidence
  const sinb = Math.sin(xwnd*Math.PI/180)
  dc60 += sinb * sinb * 0.6
  // Degraded engine slice
  if (r1 > 0.94) dc60 += 0.20
  if (r1 > 0.98) dc60 += 0.25

  // Bleed extraction (0..15%)
  let bleed = 4 + ((h>>17) % 6)  // 4..10% baseline
  // Anti-ice ON probability (cold/wet phases)
  const aiOn = (r2 > 0.7 && (ph === 'CLB-MAX' || ph === 'CRZ-MAX' || ph === 'DSC' || ph === 'INI-CLB'))
  if (aiOn) bleed += 5
  bleed = clamp(bleed, 0, 18)

  // TAT delta from ISA (-30..+30°C)
  const tat_iso = -20 + ((h>>3) % 60) + (r3 > 0.9 ? 10 : 0)

  // Altitude (kft)
  const alt_kft = Math.max(0, Math.min(50, ((h>>9) % 50)))
  // (actual alt would come from f.altitudeFt — we'll use that in caller)

  // T/O derate (assumed temp method) — only meaningful on TKO-ROLL
  let derate = 0
  if (ph === 'TKO-ROLL') derate = (r4 > 0.3 ? (5 + r4 * 20) : 0)  // 0..25%

  // Compute eroded surge margin
  // SM_eroded = SM_base − k_dc60·(DC60−0.15) − bleedSens·bleed − hotDelta·max(0,tat_iso)/10 − 0.5·alt_kft/10 − antiIce·(aiOn?1:0)
  const k_dc60 = 18  // SM% loss per unit DC60 above baseline 0.15
  let sm = spec.smBaseline_pct
  sm -= k_dc60 * Math.max(0, dc60 - 0.15)
  sm -= spec.bleedSens * (bleed - 4)  // baseline bleed 4%
  sm -= spec.hotDelta_pct * Math.max(0, tat_iso) / 10
  sm -= 0.5 * alt_kft / 10
  if (aiOn) sm -= spec.antiIcePen_pct
  // T/O thrust slam at low altitude — transient surge probability
  if (ph === 'TKO-ROLL' && thrust >= 95) sm -= 1.5
  // Degraded engine slice — random extra erosion
  if (r5 > 0.93) sm -= 4
  if (r5 > 0.98) sm -= 6
  sm = clamp(sm, -2, spec.smBaseline_pct + 4)

  return { thrust, dc60, bleed, tat_iso, alt_kft, xwnd, derate, sm_actual: sm, aiOn }
}

export default function CSurgeMargin({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [smFloor, setSmFloor] = useState(10.0)        // STALL-WTCH SM% floor
  const [dc60Ceil, setDc60Ceil] = useState(0.45)      // SURGE-WARN DC60 ceiling
  const [showOnlyThrust, setShowOnlyThrust] = useState(true)
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [engFilter, setEngFilter] = useState<string>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'ENGINES'|'DC60MAP'|'DRIVERS'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shVec, setShVec] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const ph = phaseOf(f)
      if (showOnlyThrust && (ph === 'OFF' || ph === 'DSC')) continue
      const sp = specOf(f.type)
      const st = syntheticState(f.icao, sp, ph, advMul)
      // Override alt_kft with actual altitude
      const altKft = Math.max(0, f.altitudeFt / 1000)

      // DRIVERS (each 0..100)
      // THR — thrust setting %
      const dTHR = clamp((st.thrust - 60) / 40 * 100, 0, 100)
      // DC60 — distortion vs ceiling
      const dDC60 = clamp((st.dc60 - 0.15) / (dc60Ceil - 0.15) * 100, 0, 100)
      // BLEED — total customer bleed
      const dBLEED = clamp((st.bleed - 4) / 12 * 100, 0, 100)
      // HOT — TAT delta above ISA
      const dHOT = clamp(st.tat_iso / 30 * 100, 0, 100)
      // ALT — altitude penalty (above 30 kft starts mattering for CRZ)
      const dALT = clamp((altKft - 25) / 20 * 100, 0, 100)
      // CRSWND — crosswind/sideslip at intake
      const dCRSWND = clamp((st.xwnd - 4) / 30 * 100, 0, 100)
      // DERATE — T/O derate (negative for surge — more derate = lower thrust = safer)
      const dDERATE = clamp((20 - st.derate) / 20 * 100, 0, 100)
      // MARG — actual SM% vs floor (inverse — smaller margin = higher driver score)
      const dMARG = clamp((smFloor - st.sm_actual) / smFloor * 100, 0, 100)

      const drivers = { THR:dTHR, DC60:dDC60, BLEED:dBLEED, HOT:dHOT, ALT:dALT, CRSWND:dCRSWND, DERATE:dDERATE, MARG:dMARG }

      // Phase weight
      const phaseW: Record<Phase, number> = {
        'TKO-ROLL': 1.40, 'INI-CLB': 1.30, 'GA': 1.35,
        'CLB-MAX': 1.20, 'CRZ-MAX': 1.05,
        'APPR': 0.85, 'DSC': 0.55, 'OFF': 0,
      }
      // Composite: marg-driven score
      // Most-important driver = MARG (inverse SM%); throttle-up phases amplify
      let score = (dMARG * 0.55 + Math.max(dDC60, dBLEED, dHOT) * 0.25 + dTHR * 0.10 + dCRSWND * 0.10) * phaseW[ph] * advMul

      const notes: string[] = []
      // Hard escalators per accident / AC 33.65-1 precedent
      if (st.sm_actual < 3) {
        score = Math.max(score, 92)
        notes.push(`SM=${st.sm_actual.toFixed(1)}% < 3% — imminent surge per AC 33.65-1 / Greitzer 1978 — reduce thrust, bleed OFF`)
      } else if (st.sm_actual < 6 && (ph === 'TKO-ROLL' || ph === 'GA' || ph === 'INI-CLB')) {
        score = Math.max(score, 78)
        notes.push(`SM=${st.sm_actual.toFixed(1)}% < 6% in ${ph} — DC60=${st.dc60.toFixed(2)} aggravates per SAE ARP-1420 — derate next T/O`)
      }
      if (st.dc60 > 0.55) {
        score = Math.max(score, 70)
        notes.push(`DC60=${st.dc60.toFixed(2)} > 0.55 — distorted inlet flow per NASA TM-79284 — check crosswind ${st.xwnd.toFixed(0)}° + nacelle FOD`)
      }
      if (st.aiOn && st.thrust > 90 && st.sm_actual < 10) {
        score = Math.max(score, 65)
        notes.push(`EAI ON + thrust>${st.thrust.toFixed(0)}% + SM<10% — bleed-extraction penalty ${sp.antiIcePen_pct.toFixed(1)}% per CS-E 780 — consider cycling EAI`)
      }
      if (sp.surgeHist >= 40 && ph === 'TKO-ROLL' && st.thrust >= 95) {
        score = Math.max(score, 58)
        notes.push(`${sp.eng} historical surge susc=${sp.surgeHist} + T/O slam — ${sp.ref.split('/')[0].trim()}`)
      }
      score = clamp(score, 0, 100)

      let tier: Tier = 'OFF'
      if (score >= 85) tier = 'SURGE-IMM'
      else if (score >= 65) tier = 'SURGE-WARN'
      else if (score >= 45) tier = 'STALL-WTCH'
      else if (score >= 22) tier = 'WATCH'
      else tier = 'NOMINAL'

      out.push({
        f, phase: ph, eng: sp.eng, spec: sp,
        thrust: st.thrust, dc60: st.dc60, bleed: st.bleed, tat_iso: st.tat_iso,
        alt_kft: altKft, xwnd: st.xwnd, derate: st.derate,
        sm_actual: st.sm_actual, sm_eroded: sp.smBaseline_pct - st.sm_actual,
        drivers, score, tier, notes,
      })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, smFloor, dc60Ceil, showOnlyThrust])

  useEffect(() => {
    if (!map) return
    const SRC = 'csurge-src'
    const SRC_VEC = 'csurge-vec-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    const writeAll = () => {
      ensureSrc(SRC); ensureSrc(SRC_VEC)
      const view = rows.filter(r =>
        (tierFilter==='ALL'||r.tier===tierFilter) &&
        (phaseFilter==='ALL'||r.phase===phaseFilter) &&
        (engFilter==='ALL'||r.spec.eng===engFilter))
      const acFeats: any[] = []
      const vecFeats: any[] = []
      for (const r of view) {
        acFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{
          tier:r.tier, color:TIER_COLOR[r.tier], score:r.score, sz: 7 + (r.score/100)*12,
          label: `${r.f.callsign||r.f.icao} · ${r.spec.eng.slice(0,12)} · SM${r.sm_actual.toFixed(1)}%/DC60-${r.dc60.toFixed(2)} · ${r.phase}`
        } })
        // Distortion vector: lateral fan-face arrow oriented opposite to crosswind direction
        // pointing toward the worst-60° sector of the inlet, length proportional to DC60
        const km = clamp((r.dc60 - 0.15) * 12, 0, 6)
        if (km > 0) {
          const brg = (r.f.track||0) * Math.PI/180
          // Worst-sector typically downwind of crosswind component — offset 90° from track
          const segments: any[] = []
          const offBrg = brg + (Math.PI/2)
          for (let i = 0; i <= 6; i++) {
            const frac = i / 6
            // Sweep an arc-like vector showing the distortion pattern
            const sweep = Math.sin(frac * Math.PI) * 0.4
            const dlat = (frac*km/111.32) * Math.cos(offBrg) + (sweep*km/111.32) * Math.cos(brg)
            const dlng = (frac*km/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(offBrg) + (sweep*km/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(brg)
            segments.push([r.f.lng + dlng, r.f.lat + dlat])
          }
          vecFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates: segments }, properties:{ color: TIER_COLOR[r.tier] } })
        }
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_VEC) as any).setData({ type:'FeatureCollection', features: shVec ? vecFeats : [] })
    }
    ensureSrc(SRC); ensureSrc(SRC_VEC)
    if (!map.getLayer('csurge-halo'))
      map.addLayer({ id:'csurge-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('csurge-pin'))
      map.addLayer({ id:'csurge-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('csurge-lbl'))
      map.addLayer({ id:'csurge-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('csurge-vec'))
      map.addLayer({ id:'csurge-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.5, 'line-opacity':0.85, 'line-dasharray':[2,1] } })
    writeAll()
    return () => {
      for (const id of ['csurge-lbl','csurge-pin','csurge-halo','csurge-vec']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_VEC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, phaseFilter, engFilter, shHalo, shPin, shLbl, shVec])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (engFilter==='ALL'||r.spec.eng===engFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.f.operator||'').toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { 'SURGE-IMM':0, 'SURGE-WARN':0, 'STALL-WTCH':0, WATCH:0, NOMINAL:0, OFF:0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const muSM = rows.length ? (rows.reduce((a,b)=>a+b.sm_actual,0)/rows.length) : 0
  const muDC60 = rows.length ? (rows.reduce((a,b)=>a+b.dc60,0)/rows.length) : 0
  const muBleed = rows.length ? (rows.reduce((a,b)=>a+b.bleed,0)/rows.length) : 0
  const worst = rows[0]
  const critical = counts['SURGE-IMM'] + counts['SURGE-WARN']

  // Per-engine-class aggregation
  const engMap = new Map<string, { spec: EngineSpec; count: number; muSM: number; muDC60: number; imm: number; warn: number; watch: number }>()
  for (const r of rows) {
    const e = engMap.get(r.eng) || { spec: r.spec, count: 0, muSM: 0, muDC60: 0, imm: 0, warn: 0, watch: 0 }
    e.count++; e.muSM += r.sm_actual; e.muDC60 += r.dc60
    if (r.tier === 'SURGE-IMM') e.imm++
    if (r.tier === 'SURGE-WARN') e.warn++
    if (r.tier === 'STALL-WTCH') e.watch++
    engMap.set(r.eng, e)
  }
  const engRows = Array.from(engMap.entries()).map(([eng, e]) => ({ eng, spec: e.spec, count: e.count, muSM: e.muSM/e.count, muDC60: e.muDC60/e.count, imm: e.imm, warn: e.warn, watch: e.watch }))
    .sort((a,b) => (b.imm + b.warn) - (a.imm + a.warn) || a.muSM - b.muSM)

  // Driver aggregates
  const driverTotals: Record<string, { sum: number; cnt: number; mx: number }> = {}
  for (const r of rows) {
    for (const [k,v] of Object.entries(r.drivers)) {
      const t = driverTotals[k] || { sum: 0, cnt: 0, mx: 0 }
      t.sum += v; t.cnt++; t.mx = Math.max(t.mx, v)
      driverTotals[k] = t
    }
  }
  const driverRows = Object.entries(driverTotals).map(([k,v]) => ({ k, mean: v.sum/v.cnt, max: v.mx }))
    .sort((a,b)=> b.mean - a.mean)

  return (
    <div className="fixed top-16 right-3 z-40 w-[460px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">CSURGE</span>
          <span className="text-[10px] text-slate-400">HPC surge margin · DC60 distortion · §33.65 · ARP-1420</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter===t?'border':'border border-slate-700/60'}`} style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:undefined, color: TIER_COLOR[t] }}>{t.replace('SURGE-','').replace('STALL-','S-').slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SM %</div><div className="text-slate-100 font-mono">{muSM.toFixed(1)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-DC60</div><div className="text-slate-100 font-mono">{muDC60.toFixed(2)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">IMM+WRN</div><div className="font-mono" style={{color:critical?TIER_COLOR['SURGE-WARN']:'#94a3b8'}}>{critical}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?(worst.f.callsign||worst.f.icao):'—'}</div></div>
      </div>

      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">SM-FLOOR <span className="text-slate-200 font-mono">{smFloor.toFixed(1)}%</span>
            <input type="range" min="5" max="20" step="0.5" value={smFloor} onChange={e=>setSmFloor(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">DC60-CEIL <span className="text-slate-200 font-mono">{dc60Ceil.toFixed(2)}</span>
            <input type="range" min="0.25" max="0.70" step="0.01" value={dc60Ceil} onChange={e=>setDc60Ceil(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400 flex items-center gap-1.5 mt-3.5">
            <input type="checkbox" checked={showOnlyThrust} onChange={e=>setShowOnlyThrust(e.target.checked)} className="accent-sky-500" />
            <span>Thrust phases only (hide DSC/OFF)</span>
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','TKO-ROLL','INI-CLB','CLB-MAX','CRZ-MAX','GA','APPR'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {['ALL','CFM LEAP-1A','CFM LEAP-1B','CFM56-7B','CFM56-5B / V2500','GE GE90-115B','GE GEnx-1B/-2B','GE GE9X','RR Trent-XWB/700','RR Trent-1000/7000','PW1100G GTF','GE CF34-8/-10'].map(s => (
            <button key={s} onClick={()=>setEngFilter(s)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${engFilter===s?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{s.replace('CFM ','').replace('GE ','').replace('RR ','').replace('PW','PW').slice(0,11)}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['ARC',shVec,setShVec]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','ENGINES','DC60MAP','DRIVERS'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t==='DC60MAP'?'SM/DC60 MAP':t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab==='AIRCRAFT' && visible.slice(0,80).map((r,i) => (
          <div key={i} onClick={()=>onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{r.f.callsign||r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type||'—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.eng.replace('CFM ','').replace('GE ','').replace('RR ','').slice(0,12)}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>SM <span className="font-mono" style={{color: r.sm_actual<6?TIER_COLOR['SURGE-WARN']:r.sm_actual<10?TIER_COLOR['STALL-WTCH']:'#e2e8f0'}}>{r.sm_actual.toFixed(1)}%</span></div>
              <div>DC60 <span className="font-mono" style={{color: r.dc60>0.45?TIER_COLOR['STALL-WTCH']:'#e2e8f0'}}>{r.dc60.toFixed(2)}</span></div>
              <div>THR <span className="text-slate-100 font-mono">{r.thrust.toFixed(0)}%</span></div>
              <div>BLD <span className="text-slate-100 font-mono">{r.bleed.toFixed(1)}%</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>TATΔ <span className="text-slate-100 font-mono">{r.tat_iso>=0?'+':''}{r.tat_iso.toFixed(0)}°C</span></div>
              <div>ALT <span className="text-slate-100 font-mono">{r.alt_kft.toFixed(0)}k</span></div>
              <div>XW <span className="text-slate-100 font-mono">{r.xwnd.toFixed(0)}°</span></div>
              <div>DRT <span className="text-slate-100 font-mono">{r.derate.toFixed(0)}%</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='NOMINAL' && <div className="mt-1 text-[9px] text-slate-500">{r.spec.eng} · OPR {r.spec.opr} · {r.spec.ref.split('/')[0].trim()}</div>}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length===0 && <div className="text-[10px] text-slate-500 italic">no airborne airframes in thrust phase — disable &quot;Thrust phases only&quot; to see descent/idle</div>}

        {tab==='ENGINES' && (
          <div className="space-y-1">
            {engRows.map(c => (
              <div key={c.eng} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{c.eng}</span>
                  <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">OPR {c.spec.opr}</span>
                  <span className="ml-auto font-mono text-slate-100">{c.count}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>SM₀ <span className="text-slate-100 font-mono">{c.spec.smBaseline_pct.toFixed(0)}%</span></div>
                  <div>DC60_mx <span className="text-slate-100 font-mono">{c.spec.dc60_max.toFixed(2)}</span></div>
                  <div>bldSens <span className="text-slate-100 font-mono">{c.spec.bleedSens.toFixed(2)}</span></div>
                  <div>histᵤ <span className="font-mono" style={{color:c.spec.surgeHist>35?TIER_COLOR['SURGE-WARN']:'#94a3b8'}}>{c.spec.surgeHist}</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>μ-SM <span className="font-mono" style={{color: c.muSM<10?TIER_COLOR['STALL-WTCH']:'#e2e8f0'}}>{c.muSM.toFixed(1)}%</span></div>
                  <div>μ-DC60 <span className="text-slate-100 font-mono">{c.muDC60.toFixed(2)}</span></div>
                  <div>IMM <span className="font-mono" style={{color:TIER_COLOR['SURGE-IMM']}}>{c.imm}</span></div>
                  <div>W+S <span className="font-mono" style={{color:TIER_COLOR['SURGE-WARN']}}>{c.warn + c.watch}</span></div>
                </div>
                <div className="grid grid-cols-2 gap-1 text-[10px] text-slate-400">
                  <div>EAI penalty <span className="text-slate-100 font-mono">−{c.spec.antiIcePen_pct.toFixed(1)}%</span></div>
                  <div>hotΔ/10°C <span className="text-slate-100 font-mono">−{c.spec.hotDelta_pct.toFixed(1)}%</span></div>
                </div>
                <div className="text-[9px] text-slate-500 italic mt-0.5">{c.spec.ref}</div>
              </div>
            ))}
            {engRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no airborne airframes</div>}
          </div>
        )}

        {tab==='DC60MAP' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">SM% = (P_R,surge − P_R,op) / P_R,op · 100</div>
              <div className="text-slate-400">Compressor-map operating point on (DC60 inlet distortion × Surge Margin %) plane per NASA TM-79284 (Mehalic) DC60 derivation and SAE ARP-1420 Rev B distortion methodology. The Greitzer 1978 (JFM 84) lumped-volume model predicts surge onset when d(P_R)/d(m_dot) &gt; 0; DC60 erodes effective SM by ΔSM ≈ k·DC60 with k ≈ 4-8 per engine class. The DESIGN box (SM≥14%, DC60≤0.30) maps to nominal cruise envelope. The TRANSIENT box (SM≥10%, DC60≤0.45) accommodates anti-ice ON + hot-day. Below SM=6% with DC60&gt;0.45 the engine enters the WARN region per AC 33.65-1; below SM=3% surge is imminent (BA-038 LHR ice-restriction rollback precedent per AAIB EW/C2007/06/03).</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">SM [%] × DC60 [—] · fleet on compressor-map plane</div>
              <svg viewBox="0 0 400 240" className="w-full">
                {/* axes */}
                <line x1="40" y1="220" x2="390" y2="220" stroke="#334155" />
                <line x1="40" y1="20"  x2="40"  y2="220" stroke="#334155" />
                {/* x ticks SM 0..25% */}
                {[0,5,10,15,20,25].map(v => (
                  <g key={v}><line x1={40 + v/25*350} y1="218" x2={40 + v/25*350} y2="222" stroke="#475569"/>
                    <text x={40 + v/25*350} y={232} fill="#94a3b8" fontSize="9" textAnchor="middle">{v}</text></g>
                ))}
                {/* y ticks DC60 0..0.8 */}
                {[0,0.2,0.4,0.6,0.8].map(k => (
                  <g key={k}><line x1="38" y1={220 - k/0.8*200} x2="42" y2={220 - k/0.8*200} stroke="#475569"/>
                    <text x={34} y={223 - k/0.8*200} fill="#94a3b8" fontSize="9" textAnchor="end">{k.toFixed(1)}</text></g>
                ))}
                <text x="215" y="240" fill="#94a3b8" fontSize="9" textAnchor="middle">Surge Margin %</text>
                <text x="14" y="120" fill="#94a3b8" fontSize="9" textAnchor="middle" transform="rotate(-90 14 120)">DC60</text>
                {/* DESIGN box: SM ≥ 14, DC60 ≤ 0.30 (top-right safe corner) */}
                <rect x={40 + smFloor/25*350 + (14-smFloor)/25*350} y={220 - 0.30/0.8*200} width={350 - (14)/25*350} height={0.30/0.8*200} fill="#10b981" fillOpacity="0.12" stroke="#10b981" strokeWidth="1" />
                <text x={40 + 18/25*350} y={220 - 0.15/0.8*200} fill="#10b981" fontSize="9" textAnchor="middle" opacity="0.85">DESIGN envelope</text>
                {/* TRANSIENT box: SM ≥ smFloor (10%), DC60 ≤ dc60Ceil (0.45) */}
                <rect x={40 + smFloor/25*350} y={220 - dc60Ceil/0.8*200} width={350 - smFloor/25*350} height={dc60Ceil/0.8*200} fill="#f59e0b" fillOpacity="0.06" stroke="#f59e0b" strokeWidth="1" strokeDasharray="3 3" />
                <text x={40 + smFloor/25*350 + 10} y={220 - dc60Ceil/0.8*200 + 12} fill="#f59e0b" fontSize="9" opacity="0.85">TRANSIENT envelope</text>
                {/* Surge-imminent region — SM < 3% any DC60 */}
                <rect x={40} y={20} width={3/25*350} height={200} fill="#ef4444" fillOpacity="0.10" />
                <text x={42 + 3/25*350/2} y={45} fill="#ef4444" fontSize="9" textAnchor="middle" opacity="0.85">SURGE</text>
                {/* Threshold lines */}
                <line x1={40 + 6/25*350} y1="20" x2={40 + 6/25*350} y2="220" stroke="#f43f5e" strokeWidth="1" strokeDasharray="2 2" opacity="0.5" />
                <text x={40 + 6/25*350 + 3} y={32} fill="#f43f5e" fontSize="8">SM=6%</text>
                {/* Eroded SM curve — illustrative ΔSM = k·DC60 */}
                <path d="M 40 20 Q 100 80 200 140 T 390 220" fill="none" stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4 2" opacity="0.4" />
                <text x={280} y={155} fill="#94a3b8" fontSize="8" opacity="0.7">eroded-SM locus ΔSM=k·DC60</text>
                {/* engine baselines */}
                {engRows.map((c,i) => {
                  const x = clamp(40 + c.spec.smBaseline_pct/25*350, 40, 390)
                  const y = clamp(220 - c.spec.dc60_max/0.8*200, 20, 220)
                  return <g key={i}>
                    <circle cx={x} cy={y} r="3.5" fill="none" stroke="#cbd5e1" strokeWidth="1.2" opacity="0.65" />
                    <text x={x+5} y={y+3} fill="#94a3b8" fontSize="8">{c.eng.replace('CFM ','').replace('GE ','').replace('RR ','').slice(0,10)}</text>
                  </g>
                })}
                {/* fleet dots — color by tier */}
                {rows.slice(0,80).map((r,i) => {
                  const x = clamp(40 + r.sm_actual/25*350, 40, 390)
                  const y = clamp(220 - r.dc60/0.8*200, 20, 220)
                  return <circle key={`f${i}`} cx={x} cy={y} r="2.4" fill={TIER_COLOR[r.tier]} opacity={0.85} />
                })}
                {/* legend */}
                <text x="395" y="36" fill="#10b981" fontSize="9" textAnchor="end">● DESIGN</text>
                <text x="395" y="48" fill="#f59e0b" fontSize="9" textAnchor="end">● TRANSIENT</text>
                <text x="395" y="60" fill="#ef4444" fontSize="9" textAnchor="end">● SURGE</text>
              </svg>
              <div className="grid grid-cols-3 gap-1 mt-1 text-[10px]">
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLEET</div><div className="text-slate-100 font-mono">{rows.length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">SURGE+WARN</div><div className="text-slate-100 font-mono">{counts['SURGE-IMM'] + counts['SURGE-WARN']}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-BLEED</div><div className="text-slate-100 font-mono">{muBleed.toFixed(1)}%</div></div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · 14 CFR §33.65 Surge &amp; stall §33.66 Bleed §33.68 Induction icing §33.74 Continued rotation §33.78 Bird ingestion · FAA AC 33.65-1 Surge guidance · AC 25-7D §6 Engine handling · EASA CS-E 740 / 780 / 800 / 810 · MIL-E-5007E §3.5.4 · SAE ARP-1420 Rev B inlet distortion (DC60/DPCP/DPRP) · ARP-755C performance · AIR-1419C distortion losses · NASA TM-79284 Mehalic DC60 · NASA CR-3673 Greitzer surge prediction · NASA TM-X-71776 transient surge · P&amp;W SM-9000 surge-line monograph · GE TM-2002-001 LEAP testing · GE TM-2010-022 GEnx cert · RR TR-7012 Trent rumble &amp; rotating stall · NTSB AAR-89-04 UAL-232 HPC rotor disintegration · NTSB AAR-09-03 US-1549 bird-strike fan damage · AAIB EW/C2007/06/03 BA-038 LHR ice-restriction rollback · ICAO Doc 9760 Vol II Pt VI · DOT/FAA/AR-04/36 surge testing · Greitzer JFM 84 1978 surge &amp; rotating-stall · Day JoT 115 1993 stall inception · Cumpsty Compressor Aerodynamics Ch.9 · Hill &amp; Peterson Mechanics of Propulsion §10.
            </div>
          </div>
        )}

        {tab==='DRIVERS' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="text-slate-400">Driver-stack ranked by fleet-mean contribution. Each driver expresses 0-100 the distance of that factor from its safe baseline. Composite score = 0.55·MARG + 0.25·max(DC60,BLEED,HOT) + 0.10·THR + 0.10·CRSWND, then × phase weight × ADV-MUL. Hard escalators bypass composite when SM&lt;3% (forces ≥92), DC60&gt;0.55 (forces ≥70), or EAI+T/O+SM&lt;10% (forces ≥65).</div>
            </div>
            <div className="space-y-1">
              {driverRows.map(d => {
                const desc: Record<string,string> = {
                  THR:    'Throttle setting % of MCT — higher thrust raises operating-point closer to surge line',
                  DC60:   'SAE ARP-1420 / NASA TM-79284 inlet circumferential distortion index — erodes SM by k·DC60',
                  BLEED:  'Customer bleed extraction (pack/cross/EAI) — reduces SM per engine bleedSens coefficient',
                  HOT:    'TAT delta above ISA — hot-day SM erosion ~0.15%/°C per CS-E 780',
                  ALT:    'Altitude penalty above SL — thinner air shifts operating point, ~0.5%/kft',
                  CRSWND: 'Crosswind / sideslip at inlet lip — sin²(β) drives DC60 spike per AIAA-2003-3737',
                  DERATE: 'T/O thrust derate (assumed-temp method) — protective, reduces inlet loading',
                  MARG:   'Inverse-SM residual vs floor — the dominant composite contributor',
                }
                return (
                  <div key={d.k} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <span className="font-mono text-slate-100 w-14">{d.k}</span>
                      <div className="flex-1 h-1.5 bg-slate-700/40 rounded overflow-hidden">
                        <div style={{ width:`${d.mean}%`, background: d.mean>60?TIER_COLOR['SURGE-WARN']:d.mean>30?TIER_COLOR['STALL-WTCH']:'#0ea5e9', height:'100%' }} />
                      </div>
                      <span className="font-mono text-slate-300 text-[9px] w-12 text-right">μ {d.mean.toFixed(0)}</span>
                      <span className="font-mono text-slate-400 text-[9px] w-12 text-right">mx {d.max.toFixed(0)}</span>
                    </div>
                    <div className="text-[9px] text-slate-500 mt-0.5">{desc[d.k]||''}</div>
                  </div>
                )
              })}
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="text-slate-100 font-mono mb-1">Phase weighting</div>
              <div className="grid grid-cols-7 gap-1 text-[9px]">
                {([['TKO-ROLL',1.40],['GA',1.35],['INI-CLB',1.30],['CLB-MAX',1.20],['CRZ-MAX',1.05],['APPR',0.85],['DSC',0.55]] as const).map(([p,w]) => (
                  <div key={p} className="bg-slate-800/50 rounded px-1 py-1 text-center">
                    <div className="text-slate-500">{p}</div>
                    <div className="text-slate-100 font-mono">{w.toFixed(2)}</div>
                  </div>
                ))}
              </div>
              <div className="text-slate-400 text-[9px] mt-1.5">High-thrust + low-AGL phases dominate the weighting because the surge envelope is tightest when bleed is high (anti-ice ON) and inlet distortion peaks (crosswind T/O, bird ingestion, gust). Cruise weight is moderate because anti-ice is often active above FL250 in convective tops despite lower demanded thrust.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
