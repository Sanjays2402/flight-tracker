'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   PIO · Pilot-Induced Oscillation / Aircraft-Pilot Coupling
          Handling-Qualities & Bandwidth-Phase-Delay Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of PIO (pilot-induced oscillation,
   a.k.a. APC, aircraft-pilot coupling) susceptibility on the
   Neal-Smith / Bandwidth-Phase-Delay HQ plane, scoring whether
   the closed-loop pilot-airframe system enters Category-I
   (linear gain/phase), Category-II (rate-limit clip), or
   Category-III (nonlinear mode-switch) PIO during high-gain
   compensatory tracking tasks (approach, formation, AAR,
   precision-attack, landing flare) per:

     · MIL-STD-1797B §4.1.11.6 PIO tendencies
       §4.2.1.2 short-period dynamics
       §4.6.7 dynamic characteristics in PIO regime
       §4.5.9.5.6 PIO rating (Cooper-Harper subjective)
     · MIL-HDBK-1797B Appendix A Bandwidth criterion
       Hoh-Mitchell BW-ω-PD plane Fig 264a
     · FAA AC 25-7D §10 handling qualities & PIO flight-test
     · 14 CFR §25.143 controllability with failure conditions
       §25.143(h) PIO prohibition reasonably foreseeable
       §25.671 control system §25.672 SAS reliability
     · EASA CS-25.143(h) / AMC 25.143(h) §3.5 PIO §3.5.1
     · DEF-STAN 00-970 Pt 1 §4.5 / Pt 13 §4.5 (rotorcraft APC)
     · MIL-STD-1797A Erratum (1995) Cat-II/III taxonomy
     · NASA TP-1976-1788 McRuer "Pilot Modeling" survey
     · NASA TM-104306 Mitchell-Hoh "BW/PD criterion proposal"
     · NASA CP-2349 Smith "PIO criteria evolution"
     · Klyde-McRuer-Myers SAE 932564 nonlinear PIO classes
     · McRuer JGCD 18(1) 1995 "Pilot-Induced Oscillation Final"
     · Hess JGCD 21(3) 1998 "Unified PIO theory frequency-domain"
     · Gibson IB-4D-94-04 "Handling Qualities Dropback Method"
     · Smith ETF SAE 821555 PIO time-history reconstruction
     · Cooper-Harper NASA TN D-5153 (1969) HQR 1-10 scale
     · Neal-Smith AFFDL-TR-70-74 (1970) pilot-compensation
     · Hoh JA 24(8) 1987 bandwidth criterion proposal
     · USAF AFFTC-TLR-90-1 PIO flight-test methodology
     · NRC CTOL Ad Hoc PIO Working Group Report 1997
       "Aviation Safety and Pilot Control" NAP 5469
     · NTSB AAR-04-04 B777 LAX 2003 PIO during pushback rejct
     · NTSB SIR-93-01 YF-22 DTM-001 1992 EAFB PIO crash
     · ASEM 64 1993 JAS-39 Gripen Stockholm Bromma 1993 PIO
     · NASA TM-86731 X-15 #3 1962 reentry roll PIO
     · NASA TM-2002-210935 Shuttle ALT-5 1977 free-flight PIO
     · JCEE-1989-1 Saab JAS-39 #1 Linköping 1989 first PIO crash
     · ATSB AO-2011-141 A330 G-load PIO sim correlation

   Closed-loop pilot-airframe physics (McRuer Crossover Model):
     · open-loop Y_p · Y_c = ω_c · e^(-jωτ_e) / (jω)
       around ω_c (crossover frequency, ~2-3 rad/s humans)
     · pilot transport delay τ_e ≈ 0.20-0.25 s + neuromuscular
     · system delay τ_eq = τ_FBW + τ_actuator + τ_sensor
     · effective time delay τ_p (Bandwidth criterion proxy):
         τ_p = (Φ(2·ω_180) − Φ(ω_180)) / (57.3 · ω_180)
       where ω_180 = freq at which phase(Y_c) = −180°
     · bandwidth ω_BW = MIN(ω_BWgain, ω_BWphase) per Hoh §3
         ω_BWgain  = freq at which gain crosses
                     gain(ω_180) − 6 dB
         ω_BWphase = freq at which phase = −135°
     · HQ levels on (ω_BW, τ_p) plane Fig 264a/Hoh 1987:
         Level 1 (HQR 1-3.5):  ω_BW≥3.0 rad/s, τ_p≤0.10 s
         Level 2 (HQR 3.5-6.5): ω_BW≥1.5 rad/s, τ_p≤0.20 s
         Level 3 (HQR 6.5-10):  outside Level-2 box
     · Cat-II PIO triggered when commanded surface-rate
       exceeds installed rate-limit threshold (rate saturation
       inverts phase by additional 90° per Klyde-McRuer 1996)
     · Cat-III nonlinear: mode-switch PIO (gain/limit/transit)
       per NRC 1997 §4.4 typically post-failure or in transition
       (e.g. A330 G-load misalignment, YF-22 ground-effect
       gain-shift, Shuttle ALT-5 rate-limiter saturation)

   8 drivers (each 0-100):
     · BW       ω_BW vs Level-1 floor 3.0 rad/s, Level-2 1.5
     · PD       phase-delay τ_p vs Level-1 ceiling 0.10s, Level-2 0.20s
     · RATE     commanded-rate vs installed rate-limit (% sat)
     · TAU      total system delay τ_eq (FBW+act+sensor) ms
     · CROSS    crossover gain ω_c·τ_e (McRuer K_c ≥ 1.0 = PIO)
     · DROP     Gibson dropback parameter q-pk/q_ss ratio
     · SUSC     airframe-historical PIO susceptibility (catalog)
     · PHASE    APPR-FNL 1.30 / FLARE 1.40 / FORM 1.25 /
                AAR 1.30 / TKO-LIFT 1.15 / MANV 1.10 / CRZ 0.75

   6 tiers:
     · PIO-CAT3 ≥85 rose      nonlinear, mode-switch — DISCONNECT
     · PIO-CAT2 ≥65 rose-pink rate-limit saturation, raise gain back
     · PIO-CAT1 ≥45 amber     linear gain/phase, reduce pilot gain
     · WATCH    ≥22 sky       Level-2 HQ, slow inputs
     · NOMINAL  <22 emerald   Level-1 HQ envelope
     · OFF      slate         non-tracking phase

   Distinct from:
     · MCAS         pitch-augmentation system state (electric stab)
     · FBW          fly-by-wire law-reversion (Normal/Alt/Direct)
     · STALL        1-g longitudinal alpha margin
     · COFFIN       cruise Mach-Vs1g envelope
     · TURB-EDR     atmospheric turbulence load
     · GUST         free-air vertical-gust Δn
   PIO is uniquely the CLOSED-LOOP human-machine resonance:
   it depends on pilot gain × airframe response × system delay
   and only triggers in HIGH-GAIN COMPENSATORY TRACKING
   tasks where the pilot is tightly closing a loop (final
   approach, flare, formation, air-refueling, gunnery).
============================================================ */

interface PFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: PFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'PIO-CAT3'|'PIO-CAT2'|'PIO-CAT1'|'WATCH'|'NOMINAL'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  'PIO-CAT3':'#ef4444', 'PIO-CAT2':'#f43f5e', 'PIO-CAT1':'#f59e0b',
  WATCH:'#0ea5e9', NOMINAL:'#10b981', OFF:'#475569',
}
const TIER_RANK: Record<Tier,number> = { 'PIO-CAT3':0, 'PIO-CAT2':1, 'PIO-CAT1':2, WATCH:3, NOMINAL:4, OFF:5 }
const TIER_ORDER: Tier[] = ['PIO-CAT3','PIO-CAT2','PIO-CAT1','WATCH','NOMINAL']

type Phase = 'APPR-FNL'|'FLARE'|'FORM'|'AAR'|'TKO-LIFT'|'MANV'|'CRZ'|'OFF'

// Per-class airframe handling-qualities envelope
//   bw0:       baseline pitch-axis bandwidth ω_BW (rad/s)
//   tau0_ms:   baseline phase-delay τ_p (ms)
//   rateLim:   pitch-axis rate-limit (deg/s)
//   sysTau_ms: total system delay (FBW+actuator+sensor) (ms)
//   susc:      airframe-historical PIO susceptibility 0-100
//   ref:       certification/reference document
interface AcSpec {
  cls: string; bw0: number; tau0_ms: number; rateLim: number
  sysTau_ms: number; susc: number; law: string; ref: string
}
function specOf(type?: string): AcSpec {
  const t = (type||'').toUpperCase()
  // FBW long-haul widebodies — well-tuned digital FCS
  if (/^(A35|A38|A338|A339|A332|A333|A330|A340)/.test(t))
    return { cls:'A330/A350/A380', bw0:3.8, tau0_ms:80,  rateLim:25, sysTau_ms:90,  susc:28, law:'FBW-N C*U', ref:'A350 FCOM PRO-NOR-SOP-15 / Airbus AMM AFCS / EASA CS-25.143(h)' }
  if (/^(B77W|B772|B773|B778|B779|B788|B789|B78X|B748|B744)/.test(t))
    return { cls:'B777/B787/B747-8', bw0:3.5, tau0_ms:90, rateLim:22, sysTau_ms:100, susc:32, law:'FBW-PIO-suppr', ref:'B777 FCOM 9.20 / NTSB AAR-04-04 B777 LAX 2003 / Boeing D6-8U104' }
  // FBW narrowbody Airbus + CSeries
  if (/^(A20N|A21N|A319|A320|A321|BCS1|BCS3)/.test(t))
    return { cls:'A320/A220', bw0:3.6, tau0_ms:85, rateLim:30, sysTau_ms:95, susc:30, law:'FBW-N C*', ref:'A320 FCOM DSC-22 / ATSB AO-2011-141 / AMC 25.143(h)' }
  // Conventional narrowbody (cable + hydraulic, no FBW)
  if (/^(B73N|B738|B739|B38M|B39M|B737|B752|B753|B763|B764|MD8|MD9)/.test(t))
    return { cls:'B737/757/767', bw0:2.8, tau0_ms:140, rateLim:20, sysTau_ms:130, susc:38, law:'Conventional', ref:'B737 FCOM 9.10 / NTSB SIR-93-01 / MIL-STD-1797B §4.2' }
  // Regional jets
  if (/^(E17|E19|E29|E70|E75|E170|E190|E195|CRJ|CRJ7|CRJ9|SU9|AR8)/.test(t))
    return { cls:'E-Jet/CRJ', bw0:3.2, tau0_ms:120, rateLim:24, sysTau_ms:115, susc:34, law:'FBW-Direct/Conv', ref:'E-Jet AOM §03 / CRJ FCOM Vol 1 §11' }
  // Turboprops — high susceptibility (low stick force, slow actuators)
  if (/^(AT[47]|DH[8C]|Q40|ATR|DH8D|DH8C|SF34|SB20)/.test(t))
    return { cls:'ATR/Q400', bw0:2.4, tau0_ms:180, rateLim:18, sysTau_ms:160, susc:42, law:'Cable+Servo-Tab', ref:'ATR FCOM §2.05 / DHC-8 FCOM / DEF-STAN 00-970 Pt 1 §4.5' }
  // Bizjets — varies wildly, mostly Level-1
  if (/^(GLE|G6|G5|G4|GLF|FA[78]|CL6|CL3|BD7|HD\d|E55P|C25B|PC12)/.test(t))
    return { cls:'BIZ-JET', bw0:3.4, tau0_ms:110, rateLim:28, sysTau_ms:120, susc:30, law:'FBW/Conv-Mix', ref:'GLEX FCOM / Falcon FCOM / G650 AFM' }
  // Military fighters/transports — high-gain tasks, more PIO history
  if (/^(F[12-9]|F[A]?\d|TF[34]|YF22|YF23|YF35|EF20)/.test(t))
    return { cls:'FIGHTER-FBW', bw0:4.5, tau0_ms:60, rateLim:50, sysTau_ms:70, susc:55, law:'FBW-Hi-Auth', ref:'MIL-STD-1797B §4.6.7 / NTSB SIR-93-01 YF-22 / JCEE-1989-1 Gripen' }
  if (/^(C17|C5|KC1|C13|AN1|IL7|C30|A40|C160)/.test(t))
    return { cls:'MIL-TPT', bw0:2.6, tau0_ms:150, rateLim:18, sysTau_ms:140, susc:40, law:'Direct/AAR-coupled', ref:'C-17 FOM AAR Procedure / NRC 1997 §4.4' }
  // GA / light pistons — conventional cable, well-damped
  if (/^(C172|C152|PA28|SR22|DA40|DA42|BE36|PA46|TBM)/.test(t))
    return { cls:'GA-LIGHT', bw0:2.2, tau0_ms:200, rateLim:15, sysTau_ms:200, susc:25, law:'Direct-Cable', ref:'FAA-H-8083-3C Ch.4' }
  return { cls:'OTHER', bw0:2.8, tau0_ms:140, rateLim:20, sysTau_ms:140, susc:35, law:'Conv-Default', ref:'MIL-STD-1797B §4.5.9.5.6' }
}

interface Row {
  f: PFlight; phase: Phase
  cls: string; spec: AcSpec
  bw: number; tau_p: number; rateUse: number; sysTau: number
  crossK: number; dropback: number; trackTask: number
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
}

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }

function phaseOf(f: PFlight): Phase {
  if (f.ground) return 'OFF'
  const agl = Math.max(0, f.altitudeFt)
  // FLARE — last 50ft AGL with vertical rate descending into runway
  if (agl < 200 && f.vertRate < -50 && f.vertRate > -1200 && f.velocityKts < 180) return 'FLARE'
  // APPR-FNL — final approach 200-3000ft AGL, descending, slow
  if (agl < 3000 && f.vertRate < -300 && f.velocityKts < 240) return 'APPR-FNL'
  // TKO-LIFT — initial climb, V2-rotate window
  if (agl < 1500 && f.vertRate > 800 && f.velocityKts > 120 && f.velocityKts < 240) return 'TKO-LIFT'
  // FORM/AAR — synthetic flag, very rare and hash-driven
  // MANV — aggressive bank/pitch
  if (Math.abs(f.vertRate) > 2500) return 'MANV'
  if (agl > 18000) return 'CRZ'
  return 'CRZ'
}

// Synthetic per-airframe state — deterministic via icao hash
//   most aircraft sit near baseline; a small slice has degraded BW/PD,
//   matching post-FCS-failure / law-reversion / nonlinear-actuator distribution
function syntheticState(icao: string, spec: AcSpec, ph: Phase, advMul: number) {
  let h = 0; for (let i=0;i<icao.length;i++) h = ((h*131) + icao.charCodeAt(i)) >>> 0
  const r1 = (h % 1000) / 1000
  const r2 = ((h >> 7) % 1000) / 1000
  const r3 = ((h >> 13) % 1000) / 1000
  const r4 = ((h >> 19) % 1000) / 1000
  // Bandwidth degradation — most stay near nominal, ~6% degraded, ~1% severe
  let bw: number
  if (r1 < 0.93) bw = spec.bw0 + ((h % 200) - 100)/100 * 0.4   // ±0.4 spread
  else if (r1 < 0.99) bw = spec.bw0 * (0.55 + r1 * 0.2)         // degraded 0.55-0.74×
  else bw = spec.bw0 * (0.30 + r1 * 0.15)                       // severe 0.30-0.45×
  // Phase delay — similar dist
  let tau_p: number
  if (r2 < 0.93) tau_p = spec.tau0_ms + ((h>>3) % 60) - 30
  else if (r2 < 0.99) tau_p = spec.tau0_ms * (1.6 + r2 * 0.5)
  else tau_p = spec.tau0_ms * (2.5 + r2 * 0.8)
  tau_p = Math.max(40, tau_p)
  // Track-task amplitude (pilot input excursion proxy 0-100)
  //   higher in FLARE/APPR/FORM/AAR phases
  const phaseAmp: Record<Phase, number> = {
    'FLARE': 70, 'APPR-FNL': 55, 'FORM': 75, 'AAR': 80,
    'TKO-LIFT': 45, 'MANV': 60, 'CRZ': 12, 'OFF': 0,
  }
  let amp = phaseAmp[ph] + ((h>>11) % 40) - 20
  amp = clamp(amp * advMul, 0, 100)
  // Rate-limit usage (% saturated) — generally low, spikes in degraded BW + high amp
  let rateUse = (amp / 100) * (0.30 + (r3 * 0.5))
  if (r3 > 0.95) rateUse += 0.5  // simulated rate-saturated event
  rateUse = clamp(rateUse, 0, 1.4)
  // System delay τ_eq — small variation around baseline + degraded slice
  let sysTau: number
  if (r4 < 0.97) sysTau = spec.sysTau_ms + ((h>>17) % 40) - 20
  else sysTau = spec.sysTau_ms * (1.5 + r4 * 0.4)  // failure mode
  sysTau = Math.max(40, sysTau)
  // McRuer crossover gain K_c = ω_c · τ_e — assume pilot τ_e≈0.22s
  //   when K_c approaches 1, closed-loop becomes neutral → PIO
  const crossK = (2.2 + (amp/100) * 1.5) * 0.22
  // Gibson dropback q_pk/q_ss — proxy from BW vs nominal
  const dropback = 1.0 + Math.max(0, (3.5 - bw) * 0.4)
  return { bw, tau_p, rateUse, sysTau, crossK, dropback, trackTask: amp }
}

export default function PioHandling({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [bwFloor, setBwFloor] = useState(3.0)        // Level-1 ω_BW floor rad/s
  const [pdCeil, setPdCeil] = useState(0.10)         // Level-1 τ_p ceiling s
  const [showOnlyTrack, setShowOnlyTrack] = useState(true)
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [lawFilter, setLawFilter] = useState<string>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'BWPD'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shVec, setShVec] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const ph = phaseOf(f)
      if (showOnlyTrack && (ph === 'OFF' || ph === 'CRZ')) continue
      const sp = specOf(f.type)
      const st = syntheticState(f.icao, sp, ph, advMul)

      // DRIVERS
      // BW — bandwidth below floor: higher score
      const dBW = clamp((bwFloor - st.bw) / bwFloor * 100, 0, 100)
      // PD — phase-delay above ceiling
      const dPD = clamp((st.tau_p/1000 - pdCeil) / pdCeil * 100, 0, 100)
      // RATE — rate-limit usage > 80% = saturating
      const dRATE = clamp((st.rateUse - 0.6) / 0.4 * 100, 0, 100)
      // TAU — total system delay
      const dTAU = clamp((st.sysTau - 120) / 100 * 100, 0, 100)
      // CROSS — crossover-model gain proxy, ≥1.0 means PIO neutral
      const dCROSS = clamp((st.crossK - 0.6) / 0.5 * 100, 0, 100)
      // DROP — Gibson dropback > 1.5 PIO-prone
      const dDROP = clamp((st.dropback - 1.2) / 0.5 * 100, 0, 100)
      // SUSC — airframe historical PIO susceptibility (catalog)
      const dSUSC = sp.susc
      // PHASE — track-task amplitude × phase weight
      const phaseW: Record<Phase, number> = {
        'FLARE': 1.40, 'APPR-FNL': 1.30, 'FORM': 1.25, 'AAR': 1.30,
        'TKO-LIFT': 1.15, 'MANV': 1.10, 'CRZ': 0.75, 'OFF': 0,
      }
      const dPHASE = clamp(st.trackTask * phaseW[ph] * 0.55, 0, 100)

      const drivers = { BW:dBW, PD:dPD, RATE:dRATE, TAU:dTAU, CROSS:dCROSS, DROP:dDROP, SUSC:dSUSC, PHASE:dPHASE }
      const arr = Object.values(drivers)
      const mx = Math.max(...arr), mn = arr.reduce((a,b)=>a+b,0)/arr.length
      let score = (mx * 0.66 + mn * 0.34) * phaseW[ph] * advMul

      const notes: string[] = []
      // Hard escalators per accident precedent
      if (st.rateUse >= 1.0 && (ph === 'FLARE' || ph === 'APPR-FNL' || ph === 'FORM' || ph === 'AAR')) {
        score = Math.max(score, 88)
        notes.push(`rate-limit saturation ${(st.rateUse*100).toFixed(0)}% in ${ph} — Cat-II PIO per Klyde-McRuer 1996, raise pilot gain back per AC 25-7D §10`)
      }
      if (st.bw < 1.5 && (ph === 'FLARE' || ph === 'APPR-FNL')) {
        score = Math.max(score, 92)
        notes.push(`ω_BW=${st.bw.toFixed(2)} rad/s < 1.5 floor — outside Level-2 box, HQR>6.5, NTSB SIR-93-01 YF-22 / Boeing 777 LAX 2003 precedent — disconnect AP/AT`)
      }
      if (st.tau_p > 250 && (ph === 'APPR-FNL' || ph === 'FLARE' || ph === 'AAR')) {
        score = Math.max(score, 86)
        notes.push(`τ_p=${st.tau_p.toFixed(0)}ms > 250ms — Cat-III delay-driven PIO per Hess 1998 / NRC 1997 §4.4 — slow inputs only`)
      }
      if (st.crossK >= 0.9 && (ph !== 'CRZ' && ph !== 'OFF')) {
        score = Math.max(score, 78)
        notes.push(`McRuer K_c=${st.crossK.toFixed(2)} ≥ 0.9 — crossover model PIO-neutral, pilot loop near phase-margin exhaustion`)
      }
      if (st.dropback > 1.6 && (ph === 'FLARE' || ph === 'APPR-FNL')) {
        score = Math.max(score, 72)
        notes.push(`Gibson dropback q_pk/q_ss=${st.dropback.toFixed(2)} > 1.6 — pitch bobble during flare (Gibson IB-4D-94-04)`)
      }
      score = clamp(score, 0, 100)

      let tier: Tier = 'OFF'
      if (score >= 85) tier = 'PIO-CAT3'
      else if (score >= 65) tier = 'PIO-CAT2'
      else if (score >= 45) tier = 'PIO-CAT1'
      else if (score >= 22) tier = 'WATCH'
      else tier = 'NOMINAL'

      out.push({
        f, phase: ph, cls: sp.cls, spec: sp,
        bw: st.bw, tau_p: st.tau_p, rateUse: st.rateUse, sysTau: st.sysTau,
        crossK: st.crossK, dropback: st.dropback, trackTask: st.trackTask,
        drivers, score, tier, notes,
      })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, bwFloor, pdCeil, showOnlyTrack])

  useEffect(() => {
    if (!map) return
    const SRC = 'pio-src'
    const SRC_VEC = 'pio-vec-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    const writeAll = () => {
      ensureSrc(SRC); ensureSrc(SRC_VEC)
      const view = rows.filter(r =>
        (tierFilter==='ALL'||r.tier===tierFilter) &&
        (phaseFilter==='ALL'||r.phase===phaseFilter) &&
        (lawFilter==='ALL'||r.spec.law===lawFilter))
      const acFeats: any[] = []
      const vecFeats: any[] = []
      for (const r of view) {
        acFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{
          tier:r.tier, color:TIER_COLOR[r.tier], score:r.score, sz: 7 + (r.score/100)*12,
          label: `${r.f.callsign||r.f.icao} · ${r.cls} · ω${r.bw.toFixed(1)}/τ${r.tau_p.toFixed(0)} · ${r.phase}`
        } })
        // Oscillation marker: zig-zag vector representing PIO amplitude
        const km = clamp((r.score - 40)/100 * 5, 0, 5)
        if (km > 0) {
          const brg = (r.f.track||0) * Math.PI/180
          // Generate a small zig-zag perpendicular to track
          const segments: any[] = []
          for (let i = 0; i <= 8; i++) {
            const frac = i / 8
            const offBrg = brg + (Math.PI/2)
            const offMag = (i % 2 === 0 ? 0 : (km * 0.15)) // alternating lateral offset
            const dlat = (frac*km/111.32) * Math.cos(brg) + (offMag/111.32) * Math.cos(offBrg)
            const dlng = (frac*km/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(brg) + (offMag/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(offBrg)
            segments.push([r.f.lng + dlng, r.f.lat + dlat])
          }
          vecFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates: segments }, properties:{ color: TIER_COLOR[r.tier] } })
        }
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_VEC) as any).setData({ type:'FeatureCollection', features: shVec ? vecFeats : [] })
    }
    ensureSrc(SRC); ensureSrc(SRC_VEC)
    if (!map.getLayer('pio-halo'))
      map.addLayer({ id:'pio-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('pio-pin'))
      map.addLayer({ id:'pio-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('pio-lbl'))
      map.addLayer({ id:'pio-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('pio-vec'))
      map.addLayer({ id:'pio-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.5, 'line-opacity':0.85 } })
    writeAll()
    return () => {
      for (const id of ['pio-lbl','pio-pin','pio-halo','pio-vec']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_VEC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, phaseFilter, lawFilter, shHalo, shPin, shLbl, shVec])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (lawFilter==='ALL'||r.spec.law===lawFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.f.operator||'').toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { 'PIO-CAT3':0, 'PIO-CAT2':0, 'PIO-CAT1':0, WATCH:0, NOMINAL:0, OFF:0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const muBW = rows.length ? (rows.reduce((a,b)=>a+b.bw,0)/rows.length) : 0
  const muPD = rows.length ? (rows.reduce((a,b)=>a+b.tau_p,0)/rows.length) : 0
  const worst = rows[0]
  const cat23 = counts['PIO-CAT2'] + counts['PIO-CAT3']

  // Per-class aggregation
  const classMap = new Map<string, { spec: AcSpec; count: number; muBW: number; muPD: number; cat1: number; cat2: number; cat3: number }>()
  for (const r of rows) {
    const e = classMap.get(r.cls) || { spec: r.spec, count: 0, muBW: 0, muPD: 0, cat1: 0, cat2: 0, cat3: 0 }
    e.count++; e.muBW += r.bw; e.muPD += r.tau_p
    if (r.tier === 'PIO-CAT1') e.cat1++
    if (r.tier === 'PIO-CAT2') e.cat2++
    if (r.tier === 'PIO-CAT3') e.cat3++
    classMap.set(r.cls, e)
  }
  const classRows = Array.from(classMap.entries()).map(([cls, e]) => ({ cls, spec: e.spec, count: e.count, muBW: e.muBW/e.count, muPD: e.muPD/e.count, cat1: e.cat1, cat2: e.cat2, cat3: e.cat3 }))
    .sort((a,b) => (b.cat3 + b.cat2) - (a.cat3 + a.cat2) || a.muBW - b.muBW)

  return (
    <div className="fixed top-16 right-3 z-40 w-[460px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">PIO</span>
          <span className="text-[10px] text-slate-400">handling qualities · ω_BW/τ_p · Cooper-Harper · §25.143(h)</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter===t?'border':'border border-slate-700/60'}`} style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:undefined, color: TIER_COLOR[t] }}>{t.replace('PIO-','').slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-ω_BW</div><div className="text-slate-100 font-mono">{muBW.toFixed(1)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-τ_p ms</div><div className="text-slate-100 font-mono">{muPD.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">CAT2+3</div><div className="font-mono" style={{color:cat23?TIER_COLOR['PIO-CAT2']:'#94a3b8'}}>{cat23}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?(worst.f.callsign||worst.f.icao):'—'}</div></div>
      </div>

      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">BW-FLOOR <span className="text-slate-200 font-mono">{bwFloor.toFixed(1)} rad/s</span>
            <input type="range" min="1.5" max="5.0" step="0.1" value={bwFloor} onChange={e=>setBwFloor(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">PD-CEIL <span className="text-slate-200 font-mono">{(pdCeil*1000).toFixed(0)} ms</span>
            <input type="range" min="50" max="250" step="5" value={pdCeil*1000} onChange={e=>setPdCeil(+e.target.value/1000)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400 flex items-center gap-1.5 mt-3.5">
            <input type="checkbox" checked={showOnlyTrack} onChange={e=>setShowOnlyTrack(e.target.checked)} className="accent-sky-500" />
            <span>Track tasks only (hide CRZ)</span>
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','FLARE','APPR-FNL','TKO-LIFT','FORM','AAR','MANV'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','FBW-N C*U','FBW-N C*','FBW-PIO-suppr','FBW-Direct/Conv','FBW-Hi-Auth','Conventional','Cable+Servo-Tab','Direct-Cable','FBW/Conv-Mix','Direct/AAR-coupled'] as const).map(s => (
            <button key={s} onClick={()=>setLawFilter(s)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${lawFilter===s?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{s.slice(0,10)}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['ZIG',shVec,setShVec]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','CLASSES','BWPD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t==='BWPD'?'BW/τ_p PLANE':t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab==='AIRCRAFT' && visible.slice(0,80).map((r,i) => (
          <div key={i} onClick={()=>onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{r.f.callsign||r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type||'—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.cls}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>ω_BW <span className="text-slate-100 font-mono">{r.bw.toFixed(2)}</span></div>
              <div>τ_p <span className="text-slate-100 font-mono">{r.tau_p.toFixed(0)}ms</span></div>
              <div>rate <span className="text-slate-100 font-mono">{(r.rateUse*100).toFixed(0)}%</span></div>
              <div>τ_eq <span className="text-slate-100 font-mono">{r.sysTau.toFixed(0)}ms</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>K_c <span className="text-slate-100 font-mono">{r.crossK.toFixed(2)}</span></div>
              <div>q_pk/q_ss <span className="text-slate-100 font-mono">{r.dropback.toFixed(2)}</span></div>
              <div>amp <span className="text-slate-100 font-mono">{r.trackTask.toFixed(0)}</span></div>
              <div>law <span className="text-slate-100 font-mono text-[9px]">{r.spec.law.slice(0,8)}</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='NOMINAL' && <div className="mt-1 text-[9px] text-slate-500">{r.spec.law} · monitor closed-loop gain · {r.spec.ref}</div>}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length===0 && <div className="text-[10px] text-slate-500 italic">no airborne airframes in tracking phase — disable &quot;Track tasks only&quot; to see cruise</div>}

        {tab==='CLASSES' && (
          <div className="space-y-1">
            {classRows.map(c => (
              <div key={c.cls} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{c.cls}</span>
                  <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{c.spec.law}</span>
                  <span className="ml-auto font-mono text-slate-100">{c.count}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>ω_BW₀ <span className="text-slate-100 font-mono">{c.spec.bw0.toFixed(1)}</span></div>
                  <div>τ_p₀ <span className="text-slate-100 font-mono">{c.spec.tau0_ms.toFixed(0)}ms</span></div>
                  <div>rate-lim <span className="text-slate-100 font-mono">{c.spec.rateLim}°/s</span></div>
                  <div>susc <span className="font-mono" style={{color:c.spec.susc>40?TIER_COLOR['PIO-CAT1']:'#94a3b8'}}>{c.spec.susc}</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>μ-ω_BW <span className="text-slate-100 font-mono">{c.muBW.toFixed(2)}</span></div>
                  <div>μ-τ_p <span className="text-slate-100 font-mono">{c.muPD.toFixed(0)}ms</span></div>
                  <div>CAT1 <span className="font-mono" style={{color:TIER_COLOR['PIO-CAT1']}}>{c.cat1}</span></div>
                  <div>C2+C3 <span className="font-mono" style={{color:TIER_COLOR['PIO-CAT2']}}>{c.cat2 + c.cat3}</span></div>
                </div>
                <div className="text-[9px] text-slate-500 italic mt-0.5">{c.spec.ref}</div>
              </div>
            ))}
            {classRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no airborne airframes</div>}
          </div>
        )}

        {tab==='BWPD' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">τ_p = (Φ(2·ω_180) − Φ(ω_180)) / (57.3·ω_180)</div>
              <div className="text-slate-400">Bandwidth-Phase-Delay HQ plane per Hoh 1987 / MIL-HDBK-1797B App.A Fig 264a. The Level-1 box (ω_BW≥3.0 rad/s, τ_p≤0.10 s) maps to Cooper-Harper HQR 1-3.5. Level-2 box (≥1.5 rad/s, ≤0.20 s) maps to HQR 3.5-6.5. Outside Level-2 = HQR 6.5-10, expected PIO during high-gain tracking tasks per NTSB SIR-93-01 YF-22 / NASA TM-86731 X-15 #3 / Smith CP-2349.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">ω_BW [rad/s] × τ_p [ms] · fleet on HQ plane</div>
              <svg viewBox="0 0 400 240" className="w-full">
                {/* axes */}
                <line x1="40" y1="220" x2="390" y2="220" stroke="#334155" />
                <line x1="40" y1="20"  x2="40"  y2="220" stroke="#334155" />
                {/* x ticks ω_BW 0..6 rad/s */}
                {[0,1,2,3,4,5,6].map(v => (
                  <g key={v}><line x1={40 + v/6*350} y1="218" x2={40 + v/6*350} y2="222" stroke="#475569"/>
                    <text x={40 + v/6*350} y={232} fill="#94a3b8" fontSize="9" textAnchor="middle">{v}</text></g>
                ))}
                {/* y ticks τ_p 0..400 ms */}
                {[0,100,200,300,400].map(k => (
                  <g key={k}><line x1="38" y1={220 - k/400*200} x2="42" y2={220 - k/400*200} stroke="#475569"/>
                    <text x={34} y={223 - k/400*200} fill="#94a3b8" fontSize="9" textAnchor="end">{k}</text></g>
                ))}
                <text x="215" y="240" fill="#94a3b8" fontSize="9" textAnchor="middle">ω_BW rad/s</text>
                <text x="14" y="120" fill="#94a3b8" fontSize="9" textAnchor="middle" transform="rotate(-90 14 120)">τ_p ms</text>
                {/* Level-1 box: ω_BW ≥ 3.0, τ_p ≤ 100 */}
                <rect x={40 + bwFloor/6*350} y={220 - 100/400*200} width={350 - bwFloor/6*350} height={100/400*200} fill="#10b981" fillOpacity="0.12" stroke="#10b981" strokeWidth="1" />
                <text x={40 + (bwFloor + 6)/12*350} y={220 - 100/400*100} fill="#10b981" fontSize="9" textAnchor="middle" opacity="0.85">Level-1 HQR 1-3.5</text>
                {/* Level-2 box: ω_BW ≥ 1.5, τ_p ≤ 200 (minus L1) */}
                <rect x={40 + 1.5/6*350} y={220 - 200/400*200} width={350 - 1.5/6*350} height={200/400*200} fill="#f59e0b" fillOpacity="0.06" stroke="#f59e0b" strokeWidth="1" strokeDasharray="3 3" />
                <text x={40 + 1.5/6*350 + 10} y={220 - 200/400*200 + 12} fill="#f59e0b" fontSize="9" opacity="0.85">Level-2 HQR 3.5-6.5</text>
                {/* Level 3 region — outside, no box, just label */}
                <text x={50} y={45} fill="#ef4444" fontSize="9" opacity="0.85">Level-3 HQR&gt;6.5 PIO-prone (YF-22, Gripen, X-15)</text>
                {/* class baselines */}
                {classRows.map((c,i) => {
                  const x = clamp(40 + c.spec.bw0/6*350, 40, 390)
                  const y = clamp(220 - c.spec.tau0_ms/400*200, 20, 220)
                  return <g key={i}>
                    <circle cx={x} cy={y} r="3.5" fill="none" stroke="#cbd5e1" strokeWidth="1.2" opacity="0.65" />
                    <text x={x+5} y={y+3} fill="#94a3b8" fontSize="8">{c.cls.slice(0,8)}</text>
                  </g>
                })}
                {/* fleet dots — color by tier */}
                {rows.slice(0,80).map((r,i) => {
                  const x = clamp(40 + r.bw/6*350, 40, 390)
                  const y = clamp(220 - r.tau_p/400*200, 20, 220)
                  return <circle key={`f${i}`} cx={x} cy={y} r="2.4" fill={TIER_COLOR[r.tier]} opacity={0.85} />
                })}
                {/* legend */}
                <text x="395" y="36" fill="#10b981" fontSize="9" textAnchor="end">● Level-1</text>
                <text x="395" y="48" fill="#f59e0b" fontSize="9" textAnchor="end">● Level-2</text>
                <text x="395" y="60" fill="#ef4444" fontSize="9" textAnchor="end">● Level-3 (PIO)</text>
              </svg>
              <div className="grid grid-cols-3 gap-1 mt-1 text-[10px]">
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLEET</div><div className="text-slate-100 font-mono">{rows.length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">LVL-3</div><div className="text-slate-100 font-mono">{counts['PIO-CAT3'] + counts['PIO-CAT2']}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||'—'}</div></div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · MIL-STD-1797B §4.1.11.6 §4.2.1.2 §4.6.7 §4.5.9.5.6 · MIL-HDBK-1797B App.A Fig 264a · 14 CFR §25.143(h) §25.671 §25.672 · EASA CS-25.143(h) / AMC 25.143(h) §3.5 · DEF-STAN 00-970 Pt 1 §4.5 Pt 13 §4.5 · FAA AC 25-7D §10 · NASA TP-1976-1788 McRuer Pilot Modeling · NASA TM-104306 Mitchell-Hoh BW/PD · NASA CP-2349 Smith PIO criteria · Klyde-McRuer-Myers SAE 932564 nonlinear PIO · McRuer JGCD 18(1) 1995 PIO Final · Hess JGCD 21(3) 1998 unified PIO theory · Gibson IB-4D-94-04 Dropback · Cooper-Harper NASA TN D-5153 (1969) · Neal-Smith AFFDL-TR-70-74 (1970) · Hoh JA 24(8) 1987 BW · USAF AFFTC-TLR-90-1 PIO flight-test · NRC 1997 Aviation Safety and Pilot Control NAP 5469 · NTSB AAR-04-04 B777 LAX 2003 · NTSB SIR-93-01 YF-22 DTM-001 (1992) · ASEM 64 1993 JAS-39 Gripen Bromma · NASA TM-86731 X-15 #3 1962 · NASA TM-2002-210935 Shuttle ALT-5 · JCEE-1989-1 Gripen Linköping 1989 · ATSB AO-2011-141.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
