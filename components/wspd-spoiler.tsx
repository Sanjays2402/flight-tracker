'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   WSPD · Wing-Spoiler / Speed-Brake Asymmetric-Deployment, In-
          Flight Float, Ground-Spoiler Failed-Deploy & Cross-
          Phase Authority Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of the WING-SPOILER SUBSYSTEM
   (flight-spoiler roll-augmenter + in-air speed-brake +
   ground-spoiler/lift-dumper) covering four canonical risk
   modes: (1) IN-FLIGHT FLOAT — uncommanded asymmetric panel
   deploy at flap-extended low speed (CI006 1985 NTSB AAR-86-03
   / USAir 427 1994 AAR-99-01) (2) ASYMMETRIC SPLIT —
   commanded but uneven L/R deploy exceeding aileron trim
   authority (3) SPDBRK-WITH-FLAPS — speedbrake extended with
   flaps past flap-1 (FCOM 9.20 pitch-coupling limit) (4)
   GROUND-SPOILER FAILED-DEPLOY at touchdown — lift-dump fails
   to fly-down weight onto gear, +25-40% rollout per AC 91-79B
   §5.2 (TAM 3054 / SWA 1455 / Asiana 214 contributing).

   Physics — ΔL_roll = q·S·b·Cl_δsp·δsp (per panel, Cl_δsp ≈
   0.04-0.08), ΔCD_sb ≈ 0.020-0.045 full clean (×0.55 flap-1,
   ×0.30 flap-25 per Boeing PEM §3), pitch coupling ΔCm ±0.06-
   0.08 sign per H-stab geometry, lift-dump removes ΔCL ≈ -0.45
   to -0.65 onto gear → brake friction × normal-force degraded
   35-50% in first 4s without dump (FAA AC 91-79B §5.2 / Boeing
   AC-805 §6 wet-rwy).

   Distinct from TREVERSER (gas-path), VMC (OEI rudder yaw),
   DUTCH-ROLL (lateral-directional eigenmode), RTL (rudder
   limiter), ALPHA-FLOOR (FBW α-protect), TOWS (takeoff config
   warning — spoiler-armed only 1 of 7 drivers), HYDROPLANE
   (consequence-side friction physics). WSPD is uniquely the
   wing-spoiler subsystem authority evaluator.

   Regulatory: 14 CFR §25.671/672/677/697/703/733/735/1309/1419;
   EASA CS-25.677/697/703/1309 + AMC 25.697 §1.2; FAA AC 25-7D
   §6 + AC 91-79B §5.2; SAE ARP-573; Boeing FCOM 9.20/9.32 +
   FCTM Vol 1 §03/§08; Airbus FCOM PRO-NOR-SOP-18 + PRO-ABN-
   FCTL + DSC-27-22; Embraer E-Jet AOM §03; CRJ FCOM Vol 2 §03;
   ATR FCOM §2.05; DHC-8 FCOM §2; AD 2002-22-04 B737 PCU.

   Accident precedent: CI006 N4522V B747SP Pacific 1985 (NTSB
   AAR-86-03) — uncommanded roll, spoiler-recovery; USAir 427
   B737 KPIT 1994 (AAR-99-01, 132 fatal) — PCU + spoiler-
   aileron interconnect; UA585 B737 COS 1991 (AAR-01-01, 25
   fatal); TAM 3054 A320 SBSP 2007 (CENIPA A-067/2007, 200
   fatal) — lift-dump asym on contaminated rwy; SWA 1455 B737
   KBUR 2000 (AAR-02-04); SWA 1248 B737 KMDW 2005 (AAR-07-06);
   Asiana 214 B777 KSFO 2013 (AAR-14-01, 3 fatal) — speedbrake
   extended for energy management; SU1492 SSJ-100 UUEE 2019
   (MAK Final 2021, 41 fatal) — bounce + spoiler asym wet rwy.

   8-class catalogue keyed off ICAO type prefix: HVY-Q (B747/
   A380, 12-panel FBW/cable, MLW auto-arm) · HVY-T (B777/B787/
   A350/A330, 10-14 PFC/PRIM, WoW+idle) · NB-MAX (B737MAX/
   A320neo, 8-panel SCEU/FBW, ARMED detent) · NB (B737NG/
   A320ceo, 8-panel cable+PCU/FBW) · RGN-J (E190/CRJ, 6-panel)
   · RGN-T (ATR72/Q400, 4-panel cable+blow-down) · BIZ (GLEX/
   G650/FA8X, 6-panel) · MIL (C17/KC-46/C-130, 6-10 panel).
============================================================ */

interface PFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: PFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'CRIT-FLOAT'|'ASYM-SPLIT'|'NO-LIFTDUMP'|'WATCH'|'NOMINAL'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  'CRIT-FLOAT':'#f43f5e',
  'ASYM-SPLIT':'#fb7185',
  'NO-LIFTDUMP':'#f59e0b',
  WATCH:'#0ea5e9',
  NOMINAL:'#10b981',
  OFF:'#475569',
}
const TIER_RANK: Record<Tier,number> = { 'CRIT-FLOAT':0, 'ASYM-SPLIT':1, 'NO-LIFTDUMP':2, WATCH:3, NOMINAL:4, OFF:5 }
const TIER_ORDER: Tier[] = ['CRIT-FLOAT','ASYM-SPLIT','NO-LIFTDUMP','WATCH','NOMINAL']

type Phase = 'TKO-ROLL'|'INI-CLB'|'CRZ'|'DSC'|'APPR'|'FLARE'|'TDN-ROLL'|'TAXI'|'OFF'
const PHASE_ORDER: Phase[] = ['TDN-ROLL','FLARE','APPR','DSC','TKO-ROLL','INI-CLB','CRZ','TAXI','OFF']

interface SpoilerSpec {
  cls: string
  panels: number              // per-side panels count (so 2× is total)
  archi: string               // architecture description
  spdBrkClean_cd: number      // ΔCD increment full-deflection clean
  spdBrkF1_cd: number         // ΔCD with flap-1
  spdBrkFmax_cd: number       // ΔCD with full flaps (most pen)
  gndDump_dCL: number         // |ΔCL_dump| at touchdown
  pitchCoup_cm: number        // pitching-moment coupling sign+mag
  histSusc: number            // 0-100 historical float/asym susc
  gndAutoArm: string          // ground-spoiler auto-arm logic
  fcomRef: string             // FCOM / cert reference
}
function specOf(type?: string): SpoilerSpec {
  const t = (type||'').toUpperCase()
  if (/^(B748|B744|B74F|B741|B742|B743|A388|A380)/.test(t))
    return { cls:'HVY-Q', panels:6, archi:'FBW/cable hybrid 12-panel total · WoW+RA<2ft auto-arm',
      spdBrkClean_cd:0.045, spdBrkF1_cd:0.027, spdBrkFmax_cd:0.014, gndDump_dCL:0.62,
      pitchCoup_cm:0.04, histSusc:18, gndAutoArm:'WoW + RA<2ft (B747) / WoW + N1<70% (A380)',
      fcomRef:'B747 FCOM 9.20 + A380 FCOM DSC-27-22' }
  if (/^(B77W|B772|B773|B778|B779|B77L|B77F|B788|B789|B78X|A350|A35K|A359|A338|A339|A332|A333|A330|A340|A346|A343|A345|B763|B764|B752|B753|B767)/.test(t))
    return { cls:'HVY-T', panels:6, archi:'FBW PFC/PRIM 10-14 panel total · WoW + thrust-idle auto-arm',
      spdBrkClean_cd:0.040, spdBrkF1_cd:0.024, spdBrkFmax_cd:0.012, gndDump_dCL:0.58,
      pitchCoup_cm:-0.05, histSusc:24, gndAutoArm:'WoW + thrust<idle+epsilon (B777/B787) / WoW + N1<idle (A330/A350)',
      fcomRef:'B777 FCOM 9.20 + A350 FCOM DSC-27-22 + FCTM Vol1 §03' }
  if (/^(B38M|B39M|B37M|B3XM|A20N|A21N|A319N|A320N)/.test(t))
    return { cls:'NB-MAX', panels:4, archi:'FBW (A320) / cable+SCEU (737MAX) 8-panel total · SPEEDBRAKE ARMED detent',
      spdBrkClean_cd:0.035, spdBrkF1_cd:0.021, spdBrkFmax_cd:0.010, gndDump_dCL:0.55,
      pitchCoup_cm:0.07, histSusc:32, gndAutoArm:'SPEEDBRAKE ARMED + WoW (B737MAX) / WoW + thrust-idle (A320neo)',
      fcomRef:'B737MAX FCOM 9.20 + A320neo FCOM DSC-27-22' }
  if (/^(B73N|B738|B739|B736|B737|B731|B732|B733|B734|B735|A318|A319|A320|A321)/.test(t))
    return { cls:'NB', panels:4, archi:'cable+PCU (737) / FBW (A320) 8-panel total · SPEEDBRAKE ARMED detent',
      spdBrkClean_cd:0.033, spdBrkF1_cd:0.020, spdBrkFmax_cd:0.010, gndDump_dCL:0.53,
      pitchCoup_cm:0.08, histSusc:28, gndAutoArm:'SPEEDBRAKE ARMED + WoW (B737NG) / WoW + thrust-idle (A320ceo)',
      fcomRef:'B737NG FCOM 9.20 + A320 FCOM DSC-27-22 + USAir 427 AAR-99-01 ref' }
  if (/^(E170|E175|E190|E195|E290|E295|E17|E19|E70|E75|E55P|BCS1|BCS3|E2[79]|E190E2|E195E2|E220|CRJ|CRJ7|CRJ9|CRJ2|SU9|RJ85|RJ70|BAE)/.test(t))
    return { cls:'RGN-J', panels:3, archi:'FBW (E-Jet) / cable (CRJ) 6-panel total · armed via SPLR ARM switch',
      spdBrkClean_cd:0.030, spdBrkF1_cd:0.018, spdBrkFmax_cd:0.009, gndDump_dCL:0.48,
      pitchCoup_cm:0.05, histSusc:22, gndAutoArm:'SPLR ARM + WoW + thrust-idle',
      fcomRef:'E190 AOM §03 / CRJ900 FCOM Vol 2 §03' }
  if (/^(AT[47]|ATR|SF34|SB20|J32|DH8|DH8C|DH8D|Q40|Q300|Q200|F50|F70|F100|JS41|SF34|MD11)/.test(t))
    return { cls:'RGN-T', panels:2, archi:'cable+blow-down 4-panel · NO speedbrake on AT72 (lift-dump only)',
      spdBrkClean_cd:0.022, spdBrkF1_cd:0.013, spdBrkFmax_cd:0.006, gndDump_dCL:0.40,
      pitchCoup_cm:0.03, histSusc:14, gndAutoArm:'WoW + thrust idle + LDG flaps selected',
      fcomRef:'ATR72 FCOM §2.05 / DHC-8 FCOM §2 SPOILERS' }
  if (/^(GLE|G6|G5|G4|GLF|FA[78]|CL6|CL3|BD7|HD\d|C25B|PC12|FA50|FA20|FA90|F2TH|LJ4|LJ6|LJ7|GLF6)/.test(t))
    return { cls:'BIZ', panels:3, archi:'FBW (G650/GLEX) or dual-PCU 6-panel · multi-position GROUND-SPLR',
      spdBrkClean_cd:0.030, spdBrkF1_cd:0.018, spdBrkFmax_cd:0.009, gndDump_dCL:0.45,
      pitchCoup_cm:0.04, histSusc:20, gndAutoArm:'WoW + thrust-idle (G650) / WoW (GLEX)',
      fcomRef:'G650 AFM §03 / GLEX FCOM Ch.7 SPOILERS' }
  if (/^(C17|C5|KC1|KC4|C13|AN1|IL7|C30|A40|C160|F[12-9]|F[A]?\d|EF20|B1|B2|B52|E3|E7|E4)/.test(t))
    return { cls:'MIL', panels:4, archi:'mission-mode schedule 6-10 panel · armed via SPLR ARM PNL',
      spdBrkClean_cd:0.035, spdBrkF1_cd:0.021, spdBrkFmax_cd:0.010, gndDump_dCL:0.50,
      pitchCoup_cm:0.06, histSusc:30, gndAutoArm:'mission-mode WoW + thrust-idle',
      fcomRef:'C-17 FOM SPOILERS / MIL-STD-1797B §4.6' }
  return { cls:'OTHER', panels:3, archi:'unknown 6-panel total',
    spdBrkClean_cd:0.030, spdBrkF1_cd:0.018, spdBrkFmax_cd:0.009, gndDump_dCL:0.48,
    pitchCoup_cm:0.05, histSusc:22, gndAutoArm:'WoW + thrust-idle',
    fcomRef:'14 CFR §25.677 §25.697' }
}

interface SpoilerState {
  spArm: boolean              // ground-spoiler armed
  spBrkPos: number            // 0..1 commanded speed-brake position
  spDeployL: number           // 0..1 actual left-side panel deploy
  spDeployR: number           // 0..1 actual right-side panel deploy
  asym: number                // |L-R| asymmetry 0..1
  flapDetent: number          // 0/1/5/10/15/25/30/40 typical
  thrustIdle: boolean         // thrust at idle (auto-arm condition)
  wow: boolean                // weight-on-wheels
  atDisc: boolean             // autothrottle disconnected
  iceLE: number               // 0..1 leading-edge ice (penalty)
}

interface Row {
  f: PFlight
  phase: Phase
  spec: SpoilerSpec
  state: SpoilerState
  drivers: Record<string, number>
  score: number
  tier: Tier
  notes: string[]
  effDrag: number             // effective ΔCD currently being produced
  effLiftDump: number         // effective ΔCL_dump if touchdown now
  rolloutPenalty: number      // % extra rollout distance vs spec
}

function clamp(v:number, a:number, b:number){ return Math.max(a, Math.min(b, v)) }

function phaseOf(f: PFlight): Phase {
  if (f.ground) {
    if (f.velocityKts > 60) return 'TDN-ROLL'  // assume rolling fast on ground = landing rollout primarily
    if (f.velocityKts > 5)  return 'TAXI'
    return 'OFF'
  }
  const agl = Math.max(0, f.altitudeFt)
  if (agl < 50 && f.vertRate < -100 && f.velocityKts > 80) return 'FLARE'
  if (agl < 800 && f.vertRate < 100 && f.velocityKts > 100 && f.velocityKts < 200) return 'TKO-ROLL'
  if (agl < 3000 && f.vertRate < -200 && f.velocityKts < 250) return 'APPR'
  if (agl < 5000 && f.vertRate > 500) return 'INI-CLB'
  if (f.vertRate < -400) return 'DSC'
  if (agl > 18000) return 'CRZ'
  return 'DSC'
}

// Deterministic per-airframe spoiler-state sampler matching post-AD
// fleet distribution: 88% nominal in-band / 6% spdbrk-with-flaps bias /
// 3% lift-dump-arm-fail / 2% asym deploy / 1% in-flight float
function syntheticState(icao: string, spec: SpoilerSpec, ph: Phase, advMul: number): SpoilerState {
  let h = 0; for (let i=0;i<icao.length;i++) h = ((h*131) + icao.charCodeAt(i)) >>> 0
  const r1 = (h % 1000) / 1000
  const r2 = ((h >> 7) % 1000) / 1000
  const r3 = ((h >> 13) % 1000) / 1000
  const r4 = ((h >> 19) % 1000) / 1000
  const r5 = ((h >> 23) % 1000) / 1000
  const r6 = ((h >> 11) % 1000) / 1000

  // Phase-driven nominal posture
  let spArm = false
  let spBrkPos = 0
  let spDeployL = 0
  let spDeployR = 0
  let flapDetent = 0
  let thrustIdle = false
  let wow = false
  let atDisc = false
  let asym = 0
  let iceLE = 0

  if (ph === 'TDN-ROLL') {
    spArm = r1 > 0.05  // 95% armed correctly
    wow = true
    thrustIdle = true
    flapDetent = (r2 > 0.85 ? 25 : (r2 > 0.5 ? 30 : 40))
    // After WoW most have auto-deployed fully
    spDeployL = spArm ? (0.92 + r3 * 0.08) : (r3 > 0.5 ? 0.0 : 0.15)  // failed-deploy slice
    spDeployR = spArm ? (0.92 + r4 * 0.08) : (r4 > 0.5 ? 0.0 : 0.15)
    if (r5 > 0.97) spDeployL *= 0.3  // asym slice
    if (r5 > 0.985) spDeployR *= 0.3
    asym = Math.abs(spDeployL - spDeployR)
    spBrkPos = (spDeployL + spDeployR) / 2
    iceLE = r6 > 0.92 ? (0.4 + r6 * 0.4) : 0
  } else if (ph === 'FLARE') {
    spArm = r1 > 0.08
    wow = false
    thrustIdle = true
    flapDetent = (r2 > 0.85 ? 25 : (r2 > 0.5 ? 30 : 40))
    spDeployL = r4 > 0.95 ? 0.4 : 0  // pre-armed but should not deploy in air
    spDeployR = spDeployL + (r5 > 0.97 ? 0.5 : 0) * (r5 > 0.985 ? -1 : 1)
    spDeployR = clamp(spDeployR, 0, 1)
    asym = Math.abs(spDeployL - spDeployR)
    spBrkPos = (spDeployL + spDeployR) / 2
    iceLE = r6 > 0.92 ? (0.3 + r6 * 0.4) : 0
  } else if (ph === 'APPR') {
    spArm = r1 > 0.20  // 80% armed by 1000ft per FCOM
    wow = false
    thrustIdle = false
    flapDetent = r2 > 0.7 ? 30 : (r2 > 0.5 ? 25 : (r2 > 0.3 ? 15 : 5))
    // Some pilots leave speedbrake out for energy management — caught hard
    if (r3 > 0.85 && flapDetent > 1) {
      spBrkPos = 0.3 + r3 * 0.4
      spDeployL = spBrkPos
      spDeployR = spBrkPos
    } else {
      spBrkPos = 0
      spDeployL = 0
      spDeployR = 0
    }
    // 1.2% asym float in low-speed flap-out
    if (r4 > 0.988) {
      spDeployL += 0.35
      asym = 0.35
    }
    atDisc = r5 > 0.96
  } else if (ph === 'DSC') {
    spArm = false
    wow = false
    thrustIdle = r1 > 0.4
    flapDetent = 0
    // Normal speedbrake deploy 20-60% during descent
    spBrkPos = thrustIdle ? (0.15 + r2 * 0.4) : 0
    spDeployL = spBrkPos
    spDeployR = spBrkPos + (r3 > 0.99 ? (r3 > 0.995 ? 0.3 : 0.15) : 0)
    spDeployR = clamp(spDeployR, 0, 1)
    asym = Math.abs(spDeployL - spDeployR)
    atDisc = r4 > 0.92
  } else if (ph === 'CRZ') {
    spArm = false
    wow = false
    thrustIdle = false
    flapDetent = 0
    spBrkPos = 0
    spDeployL = 0
    spDeployR = r5 > 0.997 ? 0.2 : 0  // very rare in-cruise float
    asym = spDeployR
  } else if (ph === 'INI-CLB' || ph === 'TKO-ROLL') {
    spArm = false  // disarmed by takeoff
    wow = ph === 'TKO-ROLL'
    thrustIdle = false
    flapDetent = r2 > 0.7 ? 5 : 10
    spBrkPos = 0
    spDeployL = 0
    spDeployR = 0
  } else if (ph === 'TAXI') {
    spArm = false
    wow = true
    thrustIdle = true
    flapDetent = 0
    spBrkPos = 0
    spDeployL = 0
    spDeployR = 0
  }

  return { spArm, spBrkPos, spDeployL, spDeployR, asym, flapDetent, thrustIdle, wow, atDisc, iceLE }
}

export default function WspdSpoiler({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [asymFloor, setAsymFloor] = useState(0.18)        // ASYM-SPLIT asymmetry floor 0-1
  const [rolloutCeil, setRolloutCeil] = useState(28.0)    // NO-LIFTDUMP rollout-penalty ceiling %
  const [showOnlyCrit, setShowOnlyCrit] = useState(false)
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [clsFilter, setClsFilter] = useState<string>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'AUTHORITY'|'METHOD'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shVec, setShVec] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const ph = phaseOf(f)
      const sp = specOf(f.type)
      const st = syntheticState(f.icao, sp, ph, advMul)

      // Effective speed-brake drag at current flap detent (interpolated 0/1/max)
      const flapFrac = st.flapDetent === 0 ? 0 : (st.flapDetent <= 5 ? 0.35 : (st.flapDetent <= 15 ? 0.6 : 1.0))
      const cdEffMax = (flapFrac === 0 ? sp.spdBrkClean_cd : flapFrac === 0.35 ? sp.spdBrkF1_cd : (flapFrac <= 0.6 ? (sp.spdBrkF1_cd + sp.spdBrkFmax_cd)/2 : sp.spdBrkFmax_cd))
      const effDrag = cdEffMax * st.spBrkPos

      // Effective lift-dump if at touchdown now
      let effLiftDump = sp.gndDump_dCL * ((st.spDeployL + st.spDeployR) / 2)
      if (st.iceLE > 0.3) effLiftDump *= (1 - st.iceLE * 0.18)

      // Rollout-distance penalty vs spec lift-dump (per FAA AC 91-79B §5.2)
      // 100% deploy = 0% penalty; 0% deploy = +40%; asym >0.25 = +15% extra
      const dumpEff = effLiftDump / sp.gndDump_dCL
      let rolloutPenalty = (1 - dumpEff) * 40
      if (st.asym > 0.25) rolloutPenalty += st.asym * 20
      if (st.iceLE > 0.3) rolloutPenalty += st.iceLE * 10
      rolloutPenalty = clamp(rolloutPenalty, 0, 80)

      // DRIVERS (each 0..100)
      // FLOAT — uncommanded panel deploy in flight (the CI006 / USAir 427 mode)
      const inAir = ph === 'CRZ' || ph === 'DSC' || ph === 'APPR' || ph === 'INI-CLB' || ph === 'FLARE'
      let dFLOAT = 0
      if (inAir) {
        // any deploy with flaps>0 in low-speed phases
        const lowSpeedFlapOut = (ph === 'APPR' || ph === 'FLARE') && st.flapDetent > 1
        if (lowSpeedFlapOut && st.spBrkPos > 0.15) dFLOAT = clamp(50 + st.spBrkPos * 50, 0, 100)
        else if (st.spBrkPos > 0.10 && st.flapDetent > 1) dFLOAT = clamp(35 + st.spBrkPos * 50, 0, 100)
        else if (st.asym > 0.15 && inAir) dFLOAT = clamp(40 + st.asym * 100, 0, 100)
      }
      // ASYM — |L-R| asymmetric deploy vs floor
      const dASYM = clamp(st.asym / asymFloor * 100, 0, 100)
      // SPFLP — speedbrake extended with flaps past flap-1
      const dSPFLP = (st.flapDetent > 1 && st.spBrkPos > 0.10 && !st.wow) ? clamp(25 + st.spBrkPos * 60 + st.flapDetent * 1.2, 0, 100) : 0
      // DUMP — ground-spoiler failed-deploy at TD-ROLL = inverse of dumpEff
      const dDUMP = (ph === 'TDN-ROLL' || ph === 'FLARE') ? clamp((1 - dumpEff) * 100, 0, 100) : 0
      // ARM — armed-state vs phase
      let dARM = 0
      if ((ph === 'APPR' || ph === 'FLARE') && !st.spArm) dARM = 70
      else if (ph === 'TDN-ROLL' && !st.spArm && st.spDeployL < 0.5) dARM = 88
      // PITCH — pitching-moment coupling severity (high in DSC/APPR with B737/B757/B767)
      const dPITCH = (st.spBrkPos > 0.3 && Math.abs(sp.pitchCoup_cm) > 0.05) ? clamp(st.spBrkPos * 60 + Math.abs(sp.pitchCoup_cm) * 250, 0, 100) : 0
      // AT — autothrottle disconnect concurrent with speedbrake out
      const dAT = (st.atDisc && st.spBrkPos > 0.15) ? clamp(40 + st.spBrkPos * 50, 0, 100) : 0
      // ROLL — predicted rollout penalty vs ceiling
      const dROLL = (ph === 'TDN-ROLL' || ph === 'FLARE') ? clamp(rolloutPenalty / rolloutCeil * 100, 0, 100) : 0

      const drivers = { FLOAT:dFLOAT, ASYM:dASYM, SPFLP:dSPFLP, DUMP:dDUMP, ARM:dARM, PITCH:dPITCH, AT:dAT, ROLL:dROLL }

      // Phase weight
      const phaseW: Record<Phase, number> = {
        'TDN-ROLL': 1.40,
        'FLARE':    1.30,
        'APPR':     1.20,
        'DSC':      0.85,
        'CRZ':      0.55,
        'INI-CLB':  0.70,
        'TKO-ROLL': 0.55,
        'TAXI':     0.30,
        'OFF':      0,
      }
      // composite — max·0.66 + mean·0.34 × phaseW × advMul
      const vals = Object.values(drivers)
      const mx = Math.max(...vals)
      const mn = vals.reduce((a,b)=>a+b,0) / vals.length
      let score = (mx * 0.66 + mn * 0.34) * phaseW[ph] * advMul

      const notes: string[] = []
      // Hard escalators per accident precedent
      if (dFLOAT >= 70 && (ph === 'APPR' || ph === 'FLARE')) {
        score = Math.max(score, 92)
        notes.push(`Uncommanded SPOILER FLOAT ${(st.spBrkPos*100).toFixed(0)}% in ${ph} with flap-${st.flapDetent} — disconnect AP, QRH SPOILER FAULT per ${sp.fcomRef.split('/')[0].trim()}`)
      } else if (dDUMP >= 80 && ph === 'TDN-ROLL') {
        score = Math.max(score, 90)
        notes.push(`Ground-spoiler failed-deploy on TD-ROLL — dump-eff ${(dumpEff*100).toFixed(0)}% — manual SPDBRK lever full aft per FCOM 9.20 + AC 91-79B §5.2 (TAM 3054 precedent)`)
      } else if (dASYM >= 75 && ph === 'TDN-ROLL') {
        score = Math.max(score, 85)
        notes.push(`Asymmetric ground-spoiler deploy L${(st.spDeployL*100).toFixed(0)}% / R${(st.spDeployR*100).toFixed(0)}% — anticipate roll-into-low-side directional control issue`)
      } else if (dASYM >= 70 && (ph === 'APPR' || ph === 'FLARE')) {
        score = Math.max(score, 82)
        notes.push(`Asymmetric panel float L${(st.spDeployL*100).toFixed(0)}% / R${(st.spDeployR*100).toFixed(0)}% in low-speed — aileron trim authority compromised — USAir 427 precedent AAR-99-01`)
      } else if (dSPFLP >= 65 && st.flapDetent >= 25) {
        score = Math.max(score, 70)
        notes.push(`SPDBRK ${(st.spBrkPos*100).toFixed(0)}% extended with flap-${st.flapDetent} — pitch coupling ΔCm=${sp.pitchCoup_cm > 0 ? '+' : ''}${sp.pitchCoup_cm.toFixed(2)} (${sp.pitchCoup_cm > 0 ? 'pitch-up' : 'pitch-down'}) — retract per FCOM 9.20 limit`)
      } else if (dARM >= 80 && ph === 'TDN-ROLL') {
        score = Math.max(score, 75)
        notes.push(`SPOILERS not armed at touchdown — manual deploy required, ~4s reaction-delay × +35% rollout per Asiana 214 AAR-14-01 precedent`)
      } else if (dAT >= 55 && st.spBrkPos > 0.3) {
        score = Math.max(score, 55)
        notes.push(`SPDBRK ${(st.spBrkPos*100).toFixed(0)}% + A/THR disconnected — energy management trap (FCTM Vol 1 §03)`)
      }
      score = clamp(score, 0, 100)

      let tier: Tier = 'OFF'
      if (ph === 'OFF' || ph === 'TAXI') tier = 'OFF'
      else if (score >= 85) tier = 'CRIT-FLOAT'
      else if (score >= 65) tier = 'ASYM-SPLIT'
      else if (score >= 45) tier = 'NO-LIFTDUMP'
      else if (score >= 22) tier = 'WATCH'
      else tier = 'NOMINAL'

      out.push({ f, phase: ph, spec: sp, state: st, drivers, score, tier, notes, effDrag, effLiftDump, rolloutPenalty })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, asymFloor, rolloutCeil])

  useEffect(() => {
    if (!map) return
    const SRC = 'wspd-src'
    const SRC_VEC = 'wspd-vec-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    const writeAll = () => {
      ensureSrc(SRC); ensureSrc(SRC_VEC)
      const view = rows.filter(r =>
        (tierFilter==='ALL'||r.tier===tierFilter) &&
        (phaseFilter==='ALL'||r.phase===phaseFilter) &&
        (clsFilter==='ALL'||r.spec.cls===clsFilter))
      const acFeats: any[] = []
      const vecFeats: any[] = []
      for (const r of view) {
        if (r.tier === 'OFF') continue
        const tierShort = r.tier.replace('CRIT-','').replace('ASYM-','').replace('NO-','N-').slice(0,5)
        acFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{
          tier:r.tier, color:TIER_COLOR[r.tier], score:r.score, sz: 7 + (r.score/100)*12,
          label: `${r.f.callsign||r.f.icao} · ${r.spec.cls} · ${tierShort} ${r.score.toFixed(0)} · L${(r.state.spDeployL*100).toFixed(0)}% R${(r.state.spDeployR*100).toFixed(0)}% · ${r.phase}`
        } })
        // Asymmetry vector — perpendicular to track scaled by L-R imbalance
        if (Math.abs(r.state.spDeployL - r.state.spDeployR) > 0.10) {
          const imb = r.state.spDeployL - r.state.spDeployR  // +ve = left more deploy
          const km = clamp(Math.abs(imb) * 6, 0, 8)
          const brg = (r.f.track||0) * Math.PI/180
          const perpBrg = brg + Math.PI/2 + (imb > 0 ? Math.PI : 0)  // point toward low-side
          const segments: any[] = []
          for (let i = 0; i <= 5; i++) {
            const frac = i / 5
            const dlat = (frac*km/111.32) * Math.cos(perpBrg)
            const dlng = (frac*km/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(perpBrg)
            segments.push([r.f.lng + dlng, r.f.lat + dlat])
          }
          vecFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates: segments }, properties:{ color: TIER_COLOR[r.tier] } })
        }
        // Rollout-penalty forward vector for failed-deploy on TD roll
        if ((r.phase === 'TDN-ROLL' || r.phase === 'FLARE') && r.rolloutPenalty > 15) {
          const km = clamp(r.rolloutPenalty / 12, 0.5, 5)
          const brg = (r.f.track||0) * Math.PI/180
          const segments: any[] = []
          for (let i = 0; i <= 6; i++) {
            const frac = i / 6
            const dlat = (frac*km/111.32) * Math.cos(brg)
            const dlng = (frac*km/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(brg)
            segments.push([r.f.lng + dlng, r.f.lat + dlat])
          }
          vecFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates: segments }, properties:{ color: TIER_COLOR[r.tier] } })
        }
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_VEC) as any).setData({ type:'FeatureCollection', features: shVec ? vecFeats : [] })
    }
    ensureSrc(SRC); ensureSrc(SRC_VEC)
    if (!map.getLayer('wspd-halo'))
      map.addLayer({ id:'wspd-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('wspd-pin'))
      map.addLayer({ id:'wspd-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('wspd-lbl'))
      map.addLayer({ id:'wspd-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('wspd-vec'))
      map.addLayer({ id:'wspd-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.5, 'line-opacity':0.85, 'line-dasharray':[2,1] } })
    writeAll()
    return () => {
      for (const id of ['wspd-lbl','wspd-pin','wspd-halo','wspd-vec']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_VEC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, phaseFilter, clsFilter, shHalo, shPin, shLbl, shVec])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (clsFilter==='ALL'||r.spec.cls===clsFilter) &&
    (!showOnlyCrit || r.score >= 45) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.f.operator||'').toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { 'CRIT-FLOAT':0, 'ASYM-SPLIT':0, 'NO-LIFTDUMP':0, WATCH:0, NOMINAL:0, OFF:0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const muAsym  = rows.length ? (rows.reduce((a,b)=>a+b.state.asym,0)/rows.length) : 0
  const muRoll  = rows.filter(r=>r.phase==='TDN-ROLL'||r.phase==='FLARE')
                      .reduce((a,b)=>a+b.rolloutPenalty,0) /
                  Math.max(1, rows.filter(r=>r.phase==='TDN-ROLL'||r.phase==='FLARE').length)
  const worst = rows[0]
  const critical = counts['CRIT-FLOAT'] + counts['ASYM-SPLIT'] + counts['NO-LIFTDUMP']

  // Per-class aggregation
  const clsMap = new Map<string, { spec: SpoilerSpec; count: number; muScore: number; crit: number; asym: number; dump: number }>()
  for (const r of rows) {
    const c = clsMap.get(r.spec.cls) || { spec: r.spec, count: 0, muScore: 0, crit: 0, asym: 0, dump: 0 }
    c.count++; c.muScore += r.score
    if (r.tier === 'CRIT-FLOAT') c.crit++
    if (r.tier === 'ASYM-SPLIT') c.asym++
    if (r.tier === 'NO-LIFTDUMP') c.dump++
    clsMap.set(r.spec.cls, c)
  }
  const clsRows = Array.from(clsMap.entries()).map(([cls, c]) => ({ cls, spec: c.spec, count: c.count, muScore: c.muScore/c.count, crit: c.crit, asym: c.asym, dump: c.dump }))
    .sort((a,b) => (b.crit + b.asym + b.dump) - (a.crit + a.asym + a.dump) || b.muScore - a.muScore)

  // Driver aggregates
  const driverTotals: Record<string, { sum: number; cnt: number; mx: number }> = {}
  for (const r of rows) {
    for (const [k,v] of Object.entries(r.drivers)) {
      const t = driverTotals[k] || { sum: 0, cnt: 0, mx: 0 }
      t.sum += v; t.cnt++; t.mx = Math.max(t.mx, v)
      driverTotals[k] = t
    }
  }
  const driverRows = Object.entries(driverTotals).map(([k,v]) => ({ k, mean: v.sum/Math.max(1,v.cnt), max: v.mx }))
    .sort((a,b)=> b.mean - a.mean)

  return (
    <div className="fixed top-16 right-3 z-40 w-[460px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">WSPD</span>
          <span className="text-[10px] text-slate-400">spoiler / speed-brake authority · §25.677/697 · AC 91-79B</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter===t?'border':'border border-slate-700/60'}`} style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:undefined, color: TIER_COLOR[t] }}>{t.replace('CRIT-','').replace('ASYM-','A-').replace('NO-','N-').slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-ASYM</div><div className="text-slate-100 font-mono">{(muAsym*100).toFixed(0)}%</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-ROLL+</div><div className="text-slate-100 font-mono">{muRoll.toFixed(0)}%</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLT+ASY+DMP</div><div className="font-mono" style={{color:critical?TIER_COLOR['ASYM-SPLIT']:'#94a3b8'}}>{critical}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?(worst.f.callsign||worst.f.icao):'—'}</div></div>
      </div>

      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">ASYM-FLOOR <span className="text-slate-200 font-mono">{(asymFloor*100).toFixed(0)}%</span>
            <input type="range" min="5" max="50" value={asymFloor*100} onChange={e=>setAsymFloor(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">ROLL+CEIL <span className="text-slate-200 font-mono">{rolloutCeil.toFixed(0)}%</span>
            <input type="range" min="10" max="50" value={rolloutCeil} onChange={e=>setRolloutCeil(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400 flex items-center gap-1.5 mt-3.5">
            <input type="checkbox" checked={showOnlyCrit} onChange={e=>setShowOnlyCrit(e.target.checked)} className="accent-sky-500" />
            <span>Only score≥45 (hide healthy fleet)</span>
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','TDN-ROLL','FLARE','APPR','DSC','CRZ','INI-CLB','TKO-ROLL'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {['ALL','HVY-Q','HVY-T','NB-MAX','NB','RGN-J','RGN-T','BIZ','MIL'].map(s => (
            <button key={s} onClick={()=>setClsFilter(s)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${clsFilter===s?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{s}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['VEC',shVec,setShVec]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','CLASSES','AUTHORITY','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab==='AIRCRAFT' && visible.slice(0,80).map((r,i) => (
          <div key={i} onClick={()=>onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{r.f.callsign||r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type||'—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.spec.cls}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              {r.state.spArm && (r.phase==='APPR'||r.phase==='FLARE'||r.phase==='TDN-ROLL') && <span className="px-1 rounded bg-emerald-500/15 text-emerald-300 font-mono text-[9px]">ARMD</span>}
              {!r.state.spArm && (r.phase==='APPR'||r.phase==='FLARE') && <span className="px-1 rounded bg-rose-500/15 text-rose-300 font-mono text-[9px]">!ARM</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>L <span className="font-mono" style={{color: r.state.spDeployL > 0.1 && (r.phase==='APPR'||r.phase==='FLARE')?TIER_COLOR['ASYM-SPLIT']:'#e2e8f0'}}>{(r.state.spDeployL*100).toFixed(0)}%</span></div>
              <div>R <span className="font-mono" style={{color: r.state.spDeployR > 0.1 && (r.phase==='APPR'||r.phase==='FLARE')?TIER_COLOR['ASYM-SPLIT']:'#e2e8f0'}}>{(r.state.spDeployR*100).toFixed(0)}%</span></div>
              <div>ΔLR <span className="font-mono" style={{color: r.state.asym > asymFloor?TIER_COLOR['ASYM-SPLIT']:'#e2e8f0'}}>{(r.state.asym*100).toFixed(0)}%</span></div>
              <div>FLP <span className="text-slate-100 font-mono">{r.state.flapDetent}</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>SB% <span className="text-slate-100 font-mono">{(r.state.spBrkPos*100).toFixed(0)}%</span></div>
              <div>ΔCD <span className="text-slate-100 font-mono">{r.effDrag.toFixed(3)}</span></div>
              <div>DUMP <span className="font-mono" style={{color: (r.phase==='TDN-ROLL'||r.phase==='FLARE') && (r.effLiftDump/r.spec.gndDump_dCL)<0.7 ? TIER_COLOR['NO-LIFTDUMP'] : '#e2e8f0'}}>{(r.effLiftDump/r.spec.gndDump_dCL*100).toFixed(0)}%</span></div>
              <div>ROL+ <span className="font-mono" style={{color: r.rolloutPenalty > rolloutCeil ? TIER_COLOR['NO-LIFTDUMP'] : '#e2e8f0'}}>+{r.rolloutPenalty.toFixed(0)}%</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300" style={v>=60?{color:TIER_COLOR['ASYM-SPLIT']}:v>=30?{color:TIER_COLOR['NO-LIFTDUMP']}:undefined}>{k} {Math.round(v)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='NOMINAL' && r.tier!=='OFF' && <div className="mt-1 text-[9px] text-slate-500">{r.spec.cls} · {r.spec.archi} · {r.spec.fcomRef.split('/')[0].trim()}</div>}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length===0 && <div className="text-[10px] text-slate-500 italic">no airframes in scope — relax filters or wait for arrival traffic</div>}

        {tab==='CLASSES' && (
          <div className="space-y-1">
            {clsRows.map(c => (
              <div key={c.cls} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{c.cls}</span>
                  <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{c.spec.panels*2} panels</span>
                  <span className="ml-auto font-mono text-slate-100">{c.count}</span>
                </div>
                <div className="text-[10px] text-slate-300 italic mt-0.5">{c.spec.archi}</div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>ΔCD_clean <span className="text-slate-100 font-mono">{c.spec.spdBrkClean_cd.toFixed(3)}</span></div>
                  <div>ΔCD_F1 <span className="text-slate-100 font-mono">{c.spec.spdBrkF1_cd.toFixed(3)}</span></div>
                  <div>ΔCD_Fmax <span className="text-slate-100 font-mono">{c.spec.spdBrkFmax_cd.toFixed(3)}</span></div>
                  <div>|ΔCL_dump| <span className="text-slate-100 font-mono">{c.spec.gndDump_dCL.toFixed(2)}</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>ΔCm_couple <span className="font-mono" style={{color: c.spec.pitchCoup_cm > 0 ? '#fb7185' : '#0ea5e9'}}>{c.spec.pitchCoup_cm > 0 ? '+' : ''}{c.spec.pitchCoup_cm.toFixed(2)}</span></div>
                  <div>hist-susc <span className="font-mono" style={{color: c.spec.histSusc>25?TIER_COLOR['NO-LIFTDUMP']:'#94a3b8'}}>{c.spec.histSusc}</span></div>
                  <div>μ-SCORE <span className="font-mono" style={{color: c.muScore>45?TIER_COLOR['NO-LIFTDUMP']:'#e2e8f0'}}>{c.muScore.toFixed(0)}</span></div>
                  <div>C+A+D <span className="font-mono" style={{color:(c.crit+c.asym+c.dump)>0?TIER_COLOR['ASYM-SPLIT']:'#94a3b8'}}>{c.crit+c.asym+c.dump}</span></div>
                </div>
                <div className="text-[9px] text-slate-500 italic mt-0.5">Auto-arm: {c.spec.gndAutoArm}</div>
                <div className="text-[9px] text-slate-500 italic">Ref: {c.spec.fcomRef}</div>
              </div>
            ))}
            {clsRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no airframes in scope</div>}
          </div>
        )}

        {tab==='AUTHORITY' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">ΔL_roll = q·S·b·Cl_δsp·δsp (per panel)</div>
              <div className="text-slate-400">Asymmetric spoiler deploy produces rolling moment ΔL_roll proportional to dynamic pressure q, panel span moment-arm b, panel effectiveness Cl_δsp ≈ 0.04-0.08 per panel-position, and deflection δsp. Full-up split of 4-6 panels on a heavy-twin yields rolling moment ~1.5× aileron full-deflection capability — the canonical USAir 427 / United 585 / SilkAir 185 PCU-induced asymmetric float failure mode investigated in NTSB AAR-99-01 and addressed by AD 2002-22-04 (B737 RPRA dual-servo PCU rebuild). In-flight float at flap-extended low speed exceeds aileron trim authority and produces uncommanded roll into the low-side wing — the QRH SPOILER FAULT abnormal procedure family.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">ASYM-DEPLOY [%] × SPEED [kt] · fleet authority plane</div>
              <svg viewBox="0 0 400 240" className="w-full">
                {/* axes */}
                <line x1="40" y1="220" x2="390" y2="220" stroke="#334155" />
                <line x1="40" y1="20"  x2="40"  y2="220" stroke="#334155" />
                {/* x ticks SPEED 0..350kt */}
                {[0,100,150,200,250,300,350].map(v => (
                  <g key={v}><line x1={40 + v/350*350} y1="218" x2={40 + v/350*350} y2="222" stroke="#475569"/>
                    <text x={40 + v/350*350} y={232} fill="#94a3b8" fontSize="9" textAnchor="middle">{v}</text></g>
                ))}
                {/* y ticks ASYM 0..100% */}
                {[0,25,50,75,100].map(k => (
                  <g key={k}><line x1="38" y1={220 - k/100*200} x2="42" y2={220 - k/100*200} stroke="#475569"/>
                    <text x={34} y={223 - k/100*200} fill="#94a3b8" fontSize="9" textAnchor="end">{k}</text></g>
                ))}
                <text x="215" y="240" fill="#94a3b8" fontSize="9" textAnchor="middle">IAS [kt]</text>
                <text x="14" y="120" fill="#94a3b8" fontSize="9" textAnchor="middle" transform="rotate(-90 14 120)">|L−R| asym %</text>
                {/* NOMINAL box: asym ≤ asymFloor, any speed */}
                <rect x={40} y={220 - asymFloor*200} width={350} height={asymFloor*200} fill="#10b981" fillOpacity="0.12" stroke="#10b981" strokeWidth="1" />
                <text x={195} y={220 - asymFloor*200 / 2 + 4} fill="#10b981" fontSize="9" textAnchor="middle" opacity="0.85">NOMINAL — within trim authority</text>
                {/* SPLIT region — asym > 30% any speed */}
                <rect x={40} y={20} width={350} height={Math.max(0, 220 - 0.30*200 - 20)} fill="#fb7185" fillOpacity="0.10" />
                <text x={195} y={45} fill="#fb7185" fontSize="9" textAnchor="middle" opacity="0.85">ASYM-SPLIT — aileron authority exceeded</text>
                {/* CRIT-FLOAT region — asym > 25% AND speed > 180 (flap-out approach band) */}
                <rect x={40 + 180/350*350} y={20} width={350 - 180/350*350} height={Math.max(0, 220 - 0.25*200 - 20)} fill="#f43f5e" fillOpacity="0.08" stroke="#f43f5e" strokeWidth="1" strokeDasharray="3 3" />
                <text x={300} y={70} fill="#f43f5e" fontSize="9" textAnchor="middle" opacity="0.85">CI006 / USAir-427 mode</text>
                {/* Threshold lines */}
                <line x1={40} y1={220 - 0.18*200} x2={390} y2={220 - 0.18*200} stroke="#f59e0b" strokeWidth="1" strokeDasharray="2 2" opacity="0.5" />
                <text x={385} y={220 - 0.18*200 - 3} fill="#f59e0b" fontSize="8" textAnchor="end">trim-authority floor 18%</text>
                {/* fleet dots */}
                {rows.slice(0,80).filter(r => r.f.velocityKts > 60).map((r,i) => {
                  const x = clamp(40 + r.f.velocityKts/350*350, 40, 390)
                  const y = clamp(220 - r.state.asym*200, 20, 220)
                  return <circle key={`f${i}`} cx={x} cy={y} r="2.4" fill={TIER_COLOR[r.tier]} opacity={0.85} />
                })}
                {/* legend */}
                <text x="395" y="36" fill="#10b981" fontSize="9" textAnchor="end">● NOMINAL</text>
                <text x="395" y="48" fill="#f59e0b" fontSize="9" textAnchor="end">● TRIM-FLOOR</text>
                <text x="395" y="60" fill="#fb7185" fontSize="9" textAnchor="end">● SPLIT</text>
                <text x="395" y="72" fill="#f43f5e" fontSize="9" textAnchor="end">● CI006</text>
              </svg>
              <div className="grid grid-cols-3 gap-1 mt-1 text-[10px]">
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLEET</div><div className="text-slate-100 font-mono">{rows.length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLOAT+SPLIT</div><div className="text-slate-100 font-mono">{counts['CRIT-FLOAT'] + counts['ASYM-SPLIT']}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-DUMP</div><div className="text-slate-100 font-mono">{(rows.filter(r=>r.phase==='TDN-ROLL').reduce((a,b)=>a + b.effLiftDump/b.spec.gndDump_dCL, 0) / Math.max(1, rows.filter(r=>r.phase==='TDN-ROLL').length) * 100).toFixed(0)}%</div></div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · 14 CFR §25.671 control systems · §25.677 trim · §25.697 lift &amp; drag devices · §25.703 takeoff warning · §25.733 §25.735 wheel/brake · §25.1309 system safety · §25.1419 ice protection · FAA AC 25-7D §6 speed-brake flight test · FAA AC 91-79B §5.2 wet-rwy lift-dump · EASA CS-25.677 §1-3 · CS-25.697 · AMC 25.697 §1.2 gnd-spoiler auto-deploy · SAE ARP-573 spoiler nomenclature · Boeing FCOM 9.20 SPEEDBRAKE LEVER · FCOM 9.32 SPOILER FAULT · FCTM Vol 1 §03 §08 · Airbus FCOM PRO-NOR-SOP-18 SPEEDBRAKE · PRO-ABN-FCTL SPOILER FAULT · FCOM DSC-27-22 SPOILERS · NTSB AAR-86-03 CI006 N4522V B747SP Pacific 1985 · NTSB AAR-99-01 USAir 427 B737 KPIT 1994 · NTSB AAR-01-01 UA 585 B737 COS 1991 · CENIPA A-067/2007 TAM 3054 A320 SBSP 2007 · NTSB AAR-02-04 SWA 1455 B737 KBUR 2000 · NTSB AAR-07-06 SWA 1248 B737 KMDW 2005 · NTSB AAR-14-01 Asiana 214 B777 KSFO 2013 · MAK Final 2021 SU1492 SSJ-100 UUEE 2019 · AD 2002-22-04 B737 PCU dual-servo rebuild · ICAO Doc 8168 Vol I Pt VI · Doc 9760 Vol II Pt VI · ESDU 91035 ice penalty on lift-dump.
            </div>
          </div>
        )}

        {tab==='METHOD' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="text-slate-400">Driver-stack ranked by fleet-mean contribution. Each driver expresses 0-100 the severity of that risk vector. Composite score = (max × 0.66 + mean × 0.34) × phase-weight × ADV-MUL. Hard escalators bypass composite when FLOAT≥70 in APPR/FLARE (forces ≥92, CI006/USAir 427 mode) / DUMP≥80 in TDN-ROLL (forces ≥90, TAM 3054 wet-rwy mode) / ASYM≥75 in TDN-ROLL (forces ≥85, directional control loss) / ASYM≥70 in APPR/FLARE (forces ≥82, USAir 427 PCU AD 2002-22-04 mode) / SPFLP≥65 with flap≥25 (forces ≥70, FCOM 9.20 limit) / ARM≥80 at TD (forces ≥75, Asiana 214 late-deploy +35% rollout).</div>
            </div>
            <div className="space-y-1">
              {driverRows.map(d => {
                const desc: Record<string,string> = {
                  FLOAT:  'In-flight uncommanded panel deploy — the CI006 / USAir 427 PCU-induced asymmetric float at flap-extended low speed',
                  ASYM:   '|L-R| asymmetric spoiler deploy — produces rolling moment ΔL = q·S·b·Cl_δsp·δsp_asym exceeding aileron trim authority above ~18%',
                  SPFLP:  'Speed-brake extended with flaps past flap-1 — pitch coupling ΔCm per FCOM 9.20 limit (B737/B757/B767 pitch-up; A320 pitch-down)',
                  DUMP:   'Ground-spoiler failed-deploy at touchdown — lift-dump <70% of spec — anti-skid degraded, +25-40% rollout per AC 91-79B §5.2',
                  ARM:    'SPOILERS not armed at TD — manual deploy required, ~4s reaction delay × +35% rollout (Asiana 214 AAR-14-01 mode)',
                  PITCH:  'Pitching-moment coupling severity from speedbrake at high deflection — per-class spec sign (B737 pitch-up / A320 pitch-down)',
                  AT:     'A/THR disconnected with speedbrake extended — energy management trap, FCTM Vol 1 §03 explicit caution',
                  ROLL:   'Projected rollout-distance penalty vs ceiling — composite of dump-eff + asym + ice-LE per ESDU 91035',
                }
                return (
                  <div key={d.k} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <span className="font-mono text-slate-100 w-14">{d.k}</span>
                      <div className="flex-1 h-1.5 bg-slate-700/40 rounded overflow-hidden">
                        <div style={{ width:`${d.mean}%`, background: d.mean>60?TIER_COLOR['ASYM-SPLIT']:d.mean>30?TIER_COLOR['NO-LIFTDUMP']:'#0ea5e9', height:'100%' }} />
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
              <div className="grid grid-cols-5 gap-1 text-[9px]">
                {([['TDN-ROLL',1.40],['FLARE',1.30],['APPR',1.20],['DSC',0.85],['CRZ',0.55],['INI-CLB',0.70],['TKO-ROLL',0.55],['TAXI',0.30]] as const).map(([p,w]) => (
                  <div key={p} className="bg-slate-800/50 rounded px-1 py-1 text-center">
                    <div className="text-slate-500">{p}</div>
                    <div className="text-slate-100 font-mono">{w.toFixed(2)}</div>
                  </div>
                ))}
              </div>
              <div className="text-slate-400 text-[9px] mt-1.5">Touchdown-rollout dominates because failed lift-dump is the canonical wet-runway excursion mechanism per AC 91-79B (TAM 3054 / SWA 1455 / SWA 1248 precedent family). Flare-and-final next because asymmetric float at flap-extended low speed compromises aileron trim authority below the speed at which it can be overpowered (CI006 / USAir 427 mode). Cruise weight is low because spoilers are armed-OFF / undeployed in normal cruise — a deploy event is rare but high-severity (in-flight float advisories surface immediately on driver max-clamp).</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="text-slate-100 font-mono mb-1">Mitigation pathway by tier</div>
              <div className="space-y-1 text-[9px]">
                <div className="text-slate-400"><span className="font-mono" style={{color:TIER_COLOR['CRIT-FLOAT']}}>CRIT-FLOAT </span>· Disconnect AP/AT, retract speedbrake, QRH SPOILER FAULT, divert to longer-runway airport, consider AD/SB embodiment audit before next leg</div>
                <div className="text-slate-400"><span className="font-mono" style={{color:TIER_COLOR['ASYM-SPLIT']}}>ASYM-SPLIT</span>· Manual spoiler control, monitor aileron trim, consider GA if &lt;500 AGL, write up at gate, MEL 27-60-XX deferral category check</div>
                <div className="text-slate-400"><span className="font-mono" style={{color:TIER_COLOR['NO-LIFTDUMP']}}>NO-LIFTDUMP</span>· Manual SPDBRK full aft after touchdown, max manual braking, expect +25-40% rollout — if exposed taxi: aggressive directional control, anticipate hydroplane onset</div>
                <div className="text-slate-400"><span className="font-mono" style={{color:TIER_COLOR['WATCH']}}>WATCH     </span>· Monitor speedbrake position vs flap detent, verify SPLR ARM by 1000 AGL, brief lift-dump scan on rollout</div>
                <div className="text-slate-400"><span className="font-mono" style={{color:TIER_COLOR['NOMINAL']}}>NOMINAL   </span>· Healthy spoiler subsystem within FCOM envelope, no action required</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
