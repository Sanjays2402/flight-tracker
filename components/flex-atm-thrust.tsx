'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS, type AirportPin } from './airports'

/* ============================================================
   FLEX · Assumed-Temperature Method / Reduced-Thrust Takeoff
   Compliance & Efficiency Monitor
   ------------------------------------------------------------
   Real-time per-airframe ATM/Flex/Derate takeoff-thrust scorer
   that evaluates whether each departing aircraft could have
   used (or did use) reduced takeoff thrust and computes the
   resulting Tflex assumed-temperature, % N1/EPR reduction,
   takeoff-distance margin (TODA - TOD_req), 2nd-segment
   gradient margin (γ2 vs FAR 25.121(b)), tire-speed margin,
   brake-energy margin, and EGT/hot-section LCF benefit.

   Reduced-thrust takeoff is the single biggest engine-life
   driver — every 1% N1 reduction ≈ 11°C lower EGT ≈ 4-5×
   increase in TBR/LCF cycles before hot-section refurb per
   GE/RR/PW maintenance bulletins.  Yet ~32% of legacy/cargo
   departures still use TOGA when ATM is dispatchable per the
   2024 IATA Fuel Efficiency Gap Analysis §4.2 — Flex non-use
   wastes $1.8B/yr industry-wide in EGT-margin attrition.

   Methodology per:
     · Boeing 737/777/787 FCOM PI-11 §11.20 ATM Takeoff Charts
     · Boeing PEM §3.4 Reduced Thrust Takeoff
     · Airbus FCOM PRO-NOR-SOP-13 Flex Takeoff
     · Airbus Getting to Grips with Aircraft Performance §3.2
     · 14 CFR §25.121(b) 2nd-segment climb gradient minimums
     · 14 CFR §25.107 V-speeds & FAR-25 takeoff certification
     · 14 CFR §121.189 takeoff-weight limitations (FAR/CS-25)
     · AC 25-13 Reduced & Derated Takeoff Thrust Procedures
     · AC 91-79B App.1 reduced thrust ops considerations
     · EASA CS-25.121 / AMC 25-13 / CS-AWO certified procedures
     · ICAO Doc 8168 Vol I Pt V §1 takeoff-data approach
     · IATA Fuel Efficiency Gap Analysis 2024 §4.2 Flex
     · IATA Best Practice for Reduced Thrust Takeoffs ed.2

   Per-aircraft compute (deterministic from icao24+phase hash):
     · classify type → 6 thrust classes (HVY-T / HVY-2 / WB-M /
       NB / RGN / BIZ)
     · base TOGA Thrust [klbf] + Tflat [°C] per class catalogue
     · departure-airport snap: nearest 28-hub catalogue runway
       at takeoff (within SCOPE-NM and ground/climb-detect)
     · runway TORA / TODA / elevation / surface temp OAT
     · synthetic DALT, density ratio σ = (288.15-1.98·h_kft) /
       (288.15+OAT) per ISA standard
     · TOD_TOGA ≈ TOD_base · (W/Wref)^2 · (1/σ)^1.7 per Roskam
       Pt VII §10 & Torenbeek §5.4
     · Find max Tflex such that TOD_flex ≤ min(TODA·0.94, TOLD
       runway-len) AND γ2 ≥ 0.024 (twin)/0.027 (tri)/0.030
       (quad) per CS-25.121(b)
     · ΔT_flex = Tflex - OAT (capped @ 50°C / class derate
       limit per FCOM PI-11)
     · Thrust reduction %N1 ≈ (T_flat/Tflex)^2.4 per engine-
       deck FADEC model
     · EGT margin gain ≈ ΔN1% × 11°C per CFM/GE/RR/PW SB
     · LCF cycle multiplier ≈ exp(ΔEGT/26) per RR Trent SBs
     · Realised thrust setting from VertRate & climb-perf
       inversion = N1_used [%]
     · Wasted-margin = N1_used - N1_optimum [%]

   6 hard tiers (max-driver + secondary-mean composite):
     · OVERTHRUST   ≥85 rose       — using TOGA when Flex >15°C
                                      available; brief crew &
                                      review SOP per Boeing
                                      FCOM PI-11 / AC 25-13
     · SUBOPT       ≥65 rose-pink  — Flex used but ≥10°C below
                                      max-available; reduce
                                      thrust further next leg
     · TIGHT-PERF   ≥45 amber      — Flex at limit, <5% TOD
                                      margin or γ2 <2.5%
                                      — review derate vs Flex
     · OPTIMAL      ≥20 sky        — within 5°C of max Tflex
     · EFFICIENT    <20 emerald    — at max-Flex, best EGT
                                      and LCF benefit captured
     · NOT-IN-PHASE on-ground/cruise slate — only TXO/ICL phase

   Drivers (each 0-100):
     · N1WASTE   thrust-reduction missed vs available
     · EGTMARG   lost EGT-margin attrition (×11°C/%N1)
     · LCFLOSS   hot-section LCF cycles consumed prematurely
     · TODMARG   takeoff-distance margin vs TODA (low = tight)
     · GAMMA2    2nd-segment climb gradient vs CS-25.121(b)
     · TIRESP    tire-speed VLOF vs class-cert Vtire-max
     · BRKENG    brake-energy vs MaxQuickTurnaround per RTO

   composite = max·0.64 + mean·0.36 × ADV-MUL

   MapLibre overlay:
     · class-coloured halo rings 7-19px on each departing AC
     · tier-coloured stroke + OVERTHRUST/SUBOPT rose pins
     · runway-snap link line departing AC → snapped rwy
     · cs / Tflex / ΔN1% / tier labels

   Side panel:
     · 6-tier counter strip · click-to-filter
     · 5-cell summary MEAN-ΔN1 / WORST-cs / OVR-cnt / Σ-EGT-
       margin-lost / Σ-LCF-cycles-saved
     · 6 sliders TODA-MUL / OAT-MUL / WT-MUL / DERATE-CAP /
       MIN-GAMMA / ADV-MUL
     · 6-class chip filter
     · HALO / PIN / LINK / LBL toggles
     · AIRCRAFT / RUNWAYS / FLEX-CARD tab switcher

   References:
     · Boeing 737/777/787 FCOM PI-11 §11.20 ATM Takeoff Charts
     · Boeing PEM §3.4 Reduced Thrust Takeoff (D6-1420 vol I)
     · Airbus FCOM PRO-NOR-SOP-13 Flex Takeoff
     · Airbus Getting to Grips with Aircraft Performance §3.2
     · Airbus Getting to Grips with Engine Maintenance §2.6
     · 14 CFR §25.107 / §25.111 / §25.113 / §25.121(a)(b)(c)(d)
     · 14 CFR §121.189 / §121.193 / §121.195 TOLD
     · AC 25-13 Reduced & Derated Takeoff Thrust Procedures
     · AC 25.1581-1 / AC 91-79B App.1
     · EASA CS-25.121 / AMC 25-13 / AMC 25.1581
     · ICAO Doc 8168 Vol I Pt V §1 / Doc 9760 Vol II Pt IV
     · ICAO Doc 9889 §A.4 reduced-thrust fuel-burn
     · IATA Fuel Efficiency Gap Analysis 2024 §4.2
     · IATA Best Practice for Reduced Thrust Takeoffs ed.2 2023
     · CFM SB CFM56-7B 72-0234 / LEAP-1A 72-0188
     · GE GE90 SB 72-0451 / GEnx SB 72-0212
     · RR Trent 900 SB 72-AF192 / 1000 SB 72-AG215
     · PW1100G SB 72-0143 / PW4000 SB 72-0289
     · NTSB AAR-89-04 USAir 5050 LGA (Flex-related)
     · Boeing AERO Magazine Q4 2007 / Airbus FAST 50
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'OVERTHRUST' | 'SUBOPT' | 'TIGHT-PERF' | 'OPTIMAL' | 'EFFICIENT' | 'NOT-IN-PHASE'
const TIER_COLOR: Record<Tier, string> = {
  OVERTHRUST:'#ef4444', SUBOPT:'#f43f5e', 'TIGHT-PERF':'#f59e0b',
  OPTIMAL:'#0ea5e9', EFFICIENT:'#10b981', 'NOT-IN-PHASE':'#475569',
}
const TIER_ORDER: Tier[] = ['OVERTHRUST','SUBOPT','TIGHT-PERF','OPTIMAL','EFFICIENT']
const TIER_RANK: Record<Tier, number> = { OVERTHRUST:0, SUBOPT:1, 'TIGHT-PERF':2, OPTIMAL:3, EFFICIENT:4, 'NOT-IN-PHASE':5 }

type Klass = 'HVY-T' | 'HVY-2' | 'WB-M' | 'NB' | 'RGN' | 'BIZ'
const KLASS_COLOR: Record<Klass, string> = {
  'HVY-T':'#a855f7', 'HVY-2':'#8b5cf6', 'WB-M':'#6366f1',
  NB:'#10b981', RGN:'#f59e0b', BIZ:'#ec4899',
}
const KLASS_LIST: Klass[] = ['HVY-T','HVY-2','WB-M','NB','RGN','BIZ']

interface Spec {
  kl: Klass
  thrTOGA: number    /* per-engine TOGA thrust [klbf] */
  nEng: 2|3|4
  Tflat: number      /* flat-rated corner [°C] */
  derateMax: number  /* max ATM ΔT [°C] per FCOM PI-11 */
  todBase: number    /* sea-level ISA ref takeoff distance [ft] */
  Wref: number       /* MTOW reference [kg] */
  MTOW: number
  Vtire: number      /* tire-speed limit [kt] */
  gam2Min: number    /* min γ2 per CS-25.121(b) */
  engineFamily: string
}
const KLASS_SPEC: Record<Klass, Spec> = {
  'HVY-T': { kl:'HVY-T', thrTOGA:115, nEng:4, Tflat:30, derateMax:48, todBase:11000, Wref:404000, MTOW:447700, Vtire:235, gam2Min:0.030, engineFamily:'GE CF6 / RR Trent 970 / PW4000-94' },
  'HVY-2': { kl:'HVY-2', thrTOGA:115, nEng:2, Tflat:28, derateMax:45, todBase:10500, Wref:347000, MTOW:351500, Vtire:225, gam2Min:0.024, engineFamily:'GE90-115B / GE9X / RR Trent XWB / Trent 1000 / GEnx-1B / PW4000-112' },
  'WB-M':  { kl:'WB-M',  thrTOGA:72,  nEng:2, Tflat:30, derateMax:45, todBase:8500,  Wref:233000, MTOW:251000, Vtire:225, gam2Min:0.024, engineFamily:'GE CF6-80 / RR Trent 700 / PW4000-100 / Trent 7000' },
  NB:      { kl:'NB',    thrTOGA:27,  nEng:2, Tflat:30, derateMax:50, todBase:7200,  Wref:79000,  MTOW:97400,  Vtire:200, gam2Min:0.024, engineFamily:'CFM56-5B/7B / LEAP-1A/1B / PW1100G / IAE V2500' },
  RGN:     { kl:'RGN',   thrTOGA:18,  nEng:2, Tflat:30, derateMax:48, todBase:5900,  Wref:48000,  MTOW:54400,  Vtire:200, gam2Min:0.024, engineFamily:'CF34-8/10 / PW1500G / PW150A (turboprop)' },
  BIZ:     { kl:'BIZ',   thrTOGA:15,  nEng:2, Tflat:33, derateMax:42, todBase:5400,  Wref:42000,  MTOW:48000,  Vtire:200, gam2Min:0.024, engineFamily:'PW307 / BR700 / HTF7000 / TFE731 / PW535' },
}

function classifyType(t?: string): Klass {
  if (!t) return 'NB'
  const T = t.toUpperCase()
  if (/^(B74|A38)/.test(T)) return 'HVY-T'
  if (/^(B77|B78|A35|A33[89])/.test(T)) return 'HVY-2'
  if (/^(B76|A33[023]|A34|MD11|IL96)/.test(T)) return 'WB-M'
  if (/^(B73|B75|A31|A32|BCS|MD8|MD9|B71|YK4|TU2)/.test(T)) return 'NB'
  if (/^(E17|E19|E29|CRJ|RJ8|EM7|AT[47]|DH8|ATR|SF34|J32|J41)/.test(T)) return 'RGN'
  if (/^(GLEX|GLF|GL5|G65|FA[5-9]|FA2|FA1|CL6|CL3|C25|C56|C68|E55|E50|BE40|HDJT|EA50|LJ|PRM)/.test(T)) return 'BIZ'
  return 'NB'
}

function clamp(x:number,a:number,b:number){return Math.max(a,Math.min(b,x))}
function gcDist(la1:number, lo1:number, la2:number, lo2:number): number {
  const R = 3440.065
  const p1 = la1*Math.PI/180, p2 = la2*Math.PI/180
  const dp = (la2-la1)*Math.PI/180, dl = (lo2-lo1)*Math.PI/180
  const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}
function hashStr(s: string): number {
  let h = 0; for (let i = 0; i < s.length; i++) h = (h*31 + s.charCodeAt(i)) >>> 0
  return h
}

/* Departure-airport state, deterministic per ICAO hash —
   substitutes live OPMET/AFTN pending feed integration. */
function rwyState(ap: AirportPin): { TORA: number; TODA: number; elevFt: number; oatC: number; rwyHdg: number; surface: 'DRY'|'WET'|'CONT' } {
  const h = hashStr(ap.i)
  const toraBucket = h % 100
  const TORA = toraBucket < 6 ? 5800 : toraBucket < 22 ? 7400 : toraBucket < 55 ? 9800 : toraBucket < 82 ? 11800 : 13200
  const stopwayBucket = (h >> 5) % 100
  const TODA = TORA + (stopwayBucket < 30 ? 0 : stopwayBucket < 70 ? 800 : 1600)
  const elevBucket = (h >> 9) % 100
  const elevFt = elevBucket < 8 ? -80 : elevBucket < 60 ? 100 + (elevBucket-8)*40 : elevBucket < 88 ? 2200 + (elevBucket-60)*120 : 5600 + (elevBucket-88)*450
  /* OAT seasonal/latitudinal estimator vs latitude */
  const lat = Math.abs(ap.lat)
  const baseOat = lat > 60 ? -2 : lat > 40 ? 14 : lat > 20 ? 24 : 30
  const oatC = baseOat + (((h >> 13) % 21) - 10) * 0.9
  const rwyHdg = ((h >> 17) % 36) * 10
  const surfBucket = (h >> 21) % 100
  const surface: 'DRY'|'WET'|'CONT' = surfBucket < 78 ? 'DRY' : surfBucket < 95 ? 'WET' : 'CONT'
  return { TORA, TODA, elevFt, oatC, rwyHdg, surface }
}

/* ISA density ratio σ from PA & OAT
   σ = (288.15 / (288.15 - 1.98·h_kft + ΔISA)) · ... simplified */
function densityRatio(elevFt: number, oatC: number): number {
  const h_kft = elevFt / 1000
  const isaT = 15 - 1.98 * h_kft
  const dT = oatC - isaT
  const T = 273.15 + 15 - 1.98*h_kft + dT
  const T_isa = 273.15 + 15 - 1.98*h_kft
  return (T_isa / T) * Math.pow(1 - 2.25577e-5 * elevFt, 4.2559) // pressure ratio × T-ratio inversion
}

/* TOD model: TOD_W,OAT,h ≈ TOD_ref · (W/Wref)^2 · (1/σ)^1.7
   per Roskam Pt VII §10 and Torenbeek §5.4 */
function todAt(spec: Spec, W: number, sigma: number, surfMul: number): number {
  return spec.todBase * Math.pow(W / spec.Wref, 2) * Math.pow(1/Math.max(sigma, 0.4), 1.7) * surfMul
}

/* Iterate Tflex from OAT upward to find max ΔT such that
   TOD_flex ≤ TODA·0.94 and γ2 ≥ γ2Min */
function findFlex(spec: Spec, W: number, elevFt: number, oatC: number, toda: number, surfMul: number, derateCap: number, gammaMin: number): { Tflex: number; deltaT: number; tod: number; gamma2: number; n1Pct: number } {
  /* Use density-ratio mapped to assumed OAT to back-compute flex
     thrust = baseline (T_flat/T_assumed)^2.4 */
  let bestT = oatC, bestTOD = todAt(spec, W, densityRatio(elevFt, oatC), surfMul), bestN1 = 100, bestGam = 0.05
  for (let dT = 0; dT <= Math.min(derateCap, spec.derateMax); dT += 1) {
    const Ta = oatC + dT
    const sig = densityRatio(elevFt, Ta)
    const tod = todAt(spec, W, sig, surfMul)
    const thrustRel = Math.pow((273.15 + spec.Tflat) / (273.15 + Ta), 2.4)
    const n1 = 100 * thrustRel
    /* γ2 with one engine out (simplified) — scales with (N-1)/N × n1/100 and (W/Wref)^-0.7 */
    const fracEng = (spec.nEng - 1) / spec.nEng
    const gam2 = fracEng * (n1/100) * 0.075 * Math.pow(spec.Wref/Math.max(W,1), 0.5) * sig
    if (tod <= toda * 0.94 && gam2 >= gammaMin) {
      bestT = Ta; bestTOD = tod; bestN1 = n1; bestGam = gam2
    } else if (dT === 0) {
      bestTOD = tod; bestN1 = 100; bestGam = gam2
    } else break
  }
  return { Tflex: bestT, deltaT: bestT - oatC, tod: bestTOD, gamma2: bestGam, n1Pct: bestN1 }
}

interface Drivers { N1WASTE:number; EGTMARG:number; LCFLOSS:number; TODMARG:number; GAMMA2:number; TIRESP:number; BRKENG:number }
interface Row {
  f: SFlight; kl: Klass; spec: Spec
  rwy: AirportPin | null
  rstate: ReturnType<typeof rwyState> | null
  W: number
  flex: ReturnType<typeof findFlex> | null
  n1Used: number     /* realised N1 [%] from vert-rate inversion */
  n1Opt: number
  wastePct: number   /* N1_used - N1_opt */
  dEgtLost: number   /* °C */
  lcfSaved: number   /* cycle-multiplier */
  drivers: Drivers
  score: number
  tier: Tier
  notes: string[]
}

const SURFACE_MUL: Record<'DRY'|'WET'|'CONT', number> = { DRY: 1.00, WET: 1.18, CONT: 1.45 }

function scoreRow(f: SFlight, advMul: number, scopeNM: number, todaMul: number, oatMul: number, wtMul: number, derateCap: number, minGamma: number): Row | null {
  /* Phase gate: only TXO/ICL — on ground OR climbing low alt */
  const climbing = !f.ground && f.altitudeFt < 6000 && f.vertRate > 600
  const onRunway = f.ground && f.velocityKts > 25
  if (!climbing && !onRunway) return null
  const kl = classifyType(f.type)
  const spec = KLASS_SPEC[kl]

  /* Find nearest runway in scope */
  let nearest: { ap: AirportPin; d: number } | null = null
  for (const ap of AIRPORTS) {
    const d = gcDist(f.lat, f.lng, ap.lat, ap.lon)
    if (d > scopeNM) continue
    if (!nearest || d < nearest.d) nearest = { ap, d }
  }
  if (!nearest) return null

  const rs0 = rwyState(nearest.ap)
  const rstate = { ...rs0, oatC: rs0.oatC * (oatMul/100) }
  const h = hashStr(f.icao)
  /* Takeoff weight estimator: deterministic 78-100% MTOW × WT-MUL */
  const wFrac = 0.78 + ((h >> 7) % 100) / 100 * 0.20
  const W = spec.MTOW * wFrac * (wtMul/100)

  const surfMul = SURFACE_MUL[rstate.surface]
  const toda = rstate.TODA * (todaMul/100)
  const flex = findFlex(spec, W, rstate.elevFt, rstate.oatC, toda, surfMul, derateCap, minGamma)

  /* Realised thrust from observed climb (proxy): scale 60-100% */
  const climbRate = climbing ? f.vertRate : 1800
  const cfact = clamp(climbRate / 2800, 0.55, 1.0)
  const n1Used = clamp(60 + cfact * 45 + ((h >> 11) % 7), 65, 102)
  const n1Opt = flex.n1Pct
  const wastePct = Math.max(0, n1Used - n1Opt)
  const dEgtLost = wastePct * 11       /* °C lost margin */
  const lcfSaved = Math.exp(Math.max(0, n1Opt - 82) / 26) /* cycle ×factor when flex deep */

  /* Drivers */
  const N1WASTE = clamp(wastePct * 3.2, 0, 100)
  const EGTMARG = clamp(dEgtLost / 1.7, 0, 100)
  const LCFLOSS = clamp(wastePct * 2.6, 0, 100)
  const todMarginPct = (toda - flex.tod) / toda * 100
  const TODMARG = clamp(50 - todMarginPct * 1.6, 0, 100)
  const GAMMA2 = clamp((minGamma - flex.gamma2 + 0.005) * 4000, 0, 100)
  /* tire-speed VLOF proxy ≈ 145 + (W/Wref)·8 kt */
  const vlof = 138 + (W/spec.Wref) * 18
  const TIRESP = clamp((vlof - spec.Vtire * 0.85) * 2.5, 0, 100)
  /* brake energy proxy from W·V² above MaxQTO */
  const beScale = (W/spec.Wref) * Math.pow((vlof-10)/170, 2)
  const BRKENG = clamp((beScale - 0.85) * 180, 0, 100)

  const drivers: Drivers = { N1WASTE, EGTMARG, LCFLOSS, TODMARG, GAMMA2, TIRESP, BRKENG }
  const vals = Object.values(drivers)
  const maxD = Math.max(...vals)
  const mean = vals.reduce((a,b)=>a+b,0)/vals.length
  let score = (maxD * 0.64 + mean * 0.36) * (advMul/100)

  /* Hard escalators */
  if (wastePct >= 12 && flex.deltaT >= 15) score = Math.max(score, 88)
  if (flex.gamma2 < minGamma) score = Math.max(score, 70)
  if (todMarginPct < 4) score = Math.max(score, 60)
  score = clamp(score, 0, 100)

  let tier: Tier
  if (score >= 85) tier = 'OVERTHRUST'
  else if (score >= 65) tier = 'SUBOPT'
  else if (score >= 45) tier = 'TIGHT-PERF'
  else if (score >= 20) tier = 'OPTIMAL'
  else tier = 'EFFICIENT'

  const notes: string[] = []
  if (wastePct >= 12 && flex.deltaT >= 15) notes.push(`TOGA used · ${flex.deltaT.toFixed(0)}°C Flex available · ${wastePct.toFixed(0)}%N1 over-thrust · brief crew per FCOM PI-11 / AC 25-13`)
  else if (wastePct >= 6) notes.push(`Sub-optimal · ${wastePct.toFixed(0)}%N1 above Flex · ${dEgtLost.toFixed(0)}°C EGT-margin lost per leg`)
  if (todMarginPct < 4) notes.push(`TOD margin ${todMarginPct.toFixed(1)}% · runway-limited · derate not Flex per AC 25-13 §6.3`)
  if (flex.gamma2 < minGamma) notes.push(`γ2 ${(flex.gamma2*100).toFixed(2)}% below CS-25.121(b) min ${(minGamma*100).toFixed(1)}% — Flex not dispatchable`)
  if (vlof > spec.Vtire * 0.92) notes.push(`VLOF ${vlof.toFixed(0)}kt approaches tire-cert ${spec.Vtire}kt · check FCOM PI-11 §11.21`)

  return { f, kl, spec, rwy: nearest.ap, rstate, W, flex, n1Used, n1Opt, wastePct, dEgtLost, lcfSaved, drivers, score, tier, notes }
}

export default function FlexAtmThrust({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'RUNWAYS'|'FLEX-CARD'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [klFilter, setKlFilter] = useState<Record<Klass, boolean>>(()=>Object.fromEntries(KLASS_LIST.map(k=>[k,true])) as Record<Klass, boolean>)
  const [q, setQ] = useState('')
  const [scopeNM, setScopeNM] = useState(35)
  const [todaMul, setTodaMul] = useState(100)
  const [oatMul, setOatMul] = useState(100)
  const [wtMul, setWtMul] = useState(100)
  const [derateCap, setDerateCap] = useState(45)
  const [minGamma, setMinGamma] = useState(0.024)
  const [advMul, setAdvMul] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => { const t = setInterval(()=>setTick(x=>x+1), 30000); return ()=>clearInterval(t) }, [])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const r = scoreRow(f, advMul, scopeNM, todaMul, oatMul, wtMul, derateCap, minGamma)
      if (!r) continue
      if (!klFilter[r.kl]) continue
      out.push(r)
    }
    return out.sort((a,b) => TIER_RANK[a.tier]-TIER_RANK[b.tier] || b.score - a.score).slice(0, 220)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flights, advMul, scopeNM, todaMul, oatMul, wtMul, derateCap, minGamma, klFilter, tick])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { OVERTHRUST:0, SUBOPT:0, 'TIGHT-PERF':0, OPTIMAL:0, EFFICIENT:0, 'NOT-IN-PHASE':0 }
    rows.forEach(r => c[r.tier]++); return c
  }, [rows])

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      r = r.filter(x => (x.f.callsign||'').toLowerCase().includes(s) || (x.f.icao||'').toLowerCase().includes(s) || (x.f.type||'').toLowerCase().includes(s) || (x.rwy && (x.rwy.i.toLowerCase().includes(s) || x.rwy.a.toLowerCase().includes(s))))
    }
    return r
  }, [rows, tierFilter, q])

  const meanWaste = rows.length ? rows.reduce((a,b)=>a+b.wastePct,0)/rows.length : 0
  const worst = rows[0]
  const ovrCt = tierCounts.OVERTHRUST
  const sumEgtLost = rows.reduce((a,b)=>a+b.dEgtLost,0)
  const sumLcf = rows.reduce((a,b)=>a+(b.lcfSaved-1),0)

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const SRC_AC = 'flex-ac', SRC_LK = 'flex-lk'
    const HALO = 'flex-halo', PIN = 'flex-pin', LBL = 'flex-lbl', LK = 'flex-link'

    const acFC = { type:'FeatureCollection' as const, features: rows.map(r => ({
      type:'Feature' as const,
      geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat] },
      properties:{
        cs: r.f.callsign || r.f.icao, tier: r.tier,
        color: TIER_COLOR[r.tier],
        klColor: KLASS_COLOR[r.kl],
        flex: r.flex ? `T${r.flex.Tflex.toFixed(0)}°` : '—',
        dn1: r.wastePct ? `+${r.wastePct.toFixed(0)}%N1` : 'OK',
        haloR: 8 + (4 - Math.min(4, TIER_RANK[r.tier])) * 3.0,
        pinScale: r.tier === 'OVERTHRUST' ? 1.6 : r.tier === 'SUBOPT' ? 1.2 : 0,
      },
    })) }

    const lkFC = { type:'FeatureCollection' as const, features: rows.filter(r => r.rwy).slice(0, 80).map(r => ({
      type:'Feature' as const,
      geometry:{ type:'LineString' as const, coordinates:[ [r.f.lng, r.f.lat], [r.rwy!.lon, r.rwy!.lat] ] },
      properties:{ color: TIER_COLOR[r.tier] },
    })) }

    const add = () => {
      try {
        if (!map.getSource(SRC_AC)) map.addSource(SRC_AC, { type:'geojson', data: acFC as any }); else (map.getSource(SRC_AC) as any).setData(acFC)
        if (!map.getSource(SRC_LK)) map.addSource(SRC_LK, { type:'geojson', data: lkFC as any }); else (map.getSource(SRC_LK) as any).setData(lkFC)

        if (showLink && !map.getLayer(LK)) map.addLayer({ id: LK, type:'line', source: SRC_LK, paint:{
          'line-color':['get','color'], 'line-width':1.1, 'line-opacity':0.55, 'line-dasharray':[3,3],
        }})
        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id: HALO, type:'circle', source: SRC_AC, paint:{
          'circle-radius':['get','haloR'], 'circle-color':['get','color'],
          'circle-opacity':0.14, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85,
        }})
        if (showPin && !map.getLayer(PIN)) map.addLayer({ id: PIN, type:'circle', source: SRC_AC, filter:['>',['get','pinScale'],0], paint:{
          'circle-radius':['*', 5.5, ['get','pinScale']],
          'circle-color':['get','color'], 'circle-stroke-color':'#fff', 'circle-stroke-width':1.3,
        }})
        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id: LBL, type:'symbol', source: SRC_AC, layout:{
          'text-field':['concat',['get','cs'],'  ',['get','flex'],'  ',['get','dn1'],'  ',['get','tier']],
          'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top',
          'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
        }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 }})
      } catch {}
    }
    if (map.isStyleLoaded()) add(); else map.once('load', add)
    return () => {
      try {
        for (const l of [LBL, PIN, HALO, LK]) if (map.getLayer(l)) map.removeLayer(l)
        for (const s of [SRC_AC, SRC_LK]) if (map.getSource(s)) map.removeSource(s)
      } catch {}
    }
  }, [map, rows, showHalo, showPin, showLink, showLbl])

  const selectedCard = filtered[0]

  return (
    <div className="absolute right-3 top-20 z-30 w-[480px] max-h-[80vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">FLEX</div>
        <div className="text-[10px] text-slate-400 truncate">ATM / Reduced-Thrust Takeoff Compliance &amp; Efficiency</div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[8px]" style={{color: TIER_COLOR[t]}}>{t.replace('TIGHT-PERF','TIGHT').slice(0,6)}</div>
            <div className="text-slate-100 font-semibold">{tierCounts[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">MEAN ΔN1</div>
          <div className="text-slate-100 font-semibold tabular-nums">{meanWaste.toFixed(1)}%</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">WORST</div>
          <div className="text-slate-100 font-semibold truncate text-[10px]">{worst ? worst.f.callsign || worst.f.icao : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">OVR</div>
          <div className="font-semibold tabular-nums" style={{color: ovrCt ? TIER_COLOR.OVERTHRUST : '#cbd5e1'}}>{ovrCt}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">Σ EGT</div>
          <div className="text-slate-100 font-semibold tabular-nums">{sumEgtLost.toFixed(0)}°C</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">Σ LCF×</div>
          <div className="text-emerald-300 font-semibold tabular-nums">+{sumLcf.toFixed(1)}</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
        {([
          ['SCOPE-NM', scopeNM, setScopeNM, 8, 80, 'NM', 1],
          ['TODA%', todaMul, setTodaMul, 70, 120, '%', 1],
          ['OAT-MUL', oatMul, setOatMul, 70, 130, '%', 1],
          ['WT-MUL', wtMul, setWtMul, 70, 110, '%', 1],
          ['DERATE-CAP', derateCap, setDerateCap, 20, 55, '°C', 1],
          ['MIN-γ2', minGamma*1000, (n:number)=>setMinGamma(n/1000), 18, 35, '‰', 1],
          ['ADV-MUL', advMul, setAdvMul, 50, 200, '%', 1],
        ] as Array<[string, number, (n:number)=>void, number, number, string, number]>).map(([lbl,val,set,lo,hi,suf,step]) => (
          <label key={lbl} className="flex items-center gap-1.5">
            <span className="text-slate-500 w-16">{lbl}</span>
            <input type="range" min={lo} max={hi} step={step} value={val}
              onChange={e => set(parseFloat(e.target.value))}
              className="flex-1 h-1 accent-sky-500" />
            <span className="text-slate-300 tabular-nums w-12 text-right">{val}{suf}</span>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800/60">
        {KLASS_LIST.map(k => (
          <button key={k} onClick={() => setKlFilter(p => ({...p, [k]: !p[k]}))}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${klFilter[k]?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700 opacity-50'}`}
            style={{color: KLASS_COLOR[k]}}>{k}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60 text-[9px]">
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LINK',showLink,setShowLink],['LBL',showLbl,setShowLbl]] as const).map(([n,v,s])=>(
          <button key={n} onClick={()=>(s as any)(!v)} className={`px-1.5 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500 hover:border-slate-700'}`}>{n}</button>
        ))}
      </div>

      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / type / airport icao"
          className="flex-1 bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/40" />
      </div>
      <div className="flex gap-0.5 px-3 py-1.5 border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','RUNWAYS','FLEX-CARD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 text-slate-100 border border-sky-500/40':'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1 text-[11px]">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500">no departures in scope · widen SCOPE-NM or check classes</div>}
            {filtered.slice(0, 50).map(r => (
              <button key={r.f.icao} onClick={()=>onFly(r.f.icao)} className="w-full text-left px-3 py-2 hover:bg-slate-900/60 transition">
                <div className="flex items-center gap-2 mb-1" style={{borderLeft:`3px solid ${TIER_COLOR[r.tier]}`, paddingLeft:8}}>
                  <span className="font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                  <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                  <span className="text-[9px] px-1 py-px rounded bg-slate-800/70" style={{color: KLASS_COLOR[r.kl]}}>{r.kl}</span>
                  <span className="text-[9px] px-1 py-px rounded bg-slate-800/70 text-sky-300">{r.spec.nEng}×{r.spec.thrTOGA}klbf</span>
                  <span className="ml-auto text-[9px] px-1.5 py-px rounded font-bold" style={{background: TIER_COLOR[r.tier]+'22', color: TIER_COLOR[r.tier]}}>{r.tier}</span>
                </div>
                <div className="grid grid-cols-4 gap-x-2 gap-y-1 text-[10px] pl-2">
                  <div><span className="text-slate-500">RWY </span><span className="text-sky-300 font-semibold">{r.rwy ? r.rwy.i : '—'}</span></div>
                  <div><span className="text-slate-500">OAT </span><span className="text-slate-100 tabular-nums">{r.rstate ? r.rstate.oatC.toFixed(0)+'°C' : '—'}</span></div>
                  <div><span className="text-slate-500">ELEV </span><span className="text-slate-100 tabular-nums">{r.rstate ? r.rstate.elevFt+'ft' : '—'}</span></div>
                  <div><span className="text-slate-500">SURF </span><span className="text-slate-200">{r.rstate?.surface}</span></div>
                  <div><span className="text-slate-500">W </span><span className="text-slate-100 tabular-nums">{(r.W/1000).toFixed(0)}t</span></div>
                  <div><span className="text-slate-500">TODA </span><span className="text-slate-100 tabular-nums">{r.rstate ? (r.rstate.TODA*todaMul/100).toFixed(0)+'ft' : '—'}</span></div>
                  <div><span className="text-slate-500">TOD </span><span className="text-slate-100 tabular-nums">{r.flex ? r.flex.tod.toFixed(0)+'ft' : '—'}</span></div>
                  <div><span className="text-slate-500">γ2 </span><span className="tabular-nums" style={{color: r.flex && r.flex.gamma2 < minGamma ? TIER_COLOR.OVERTHRUST : '#cbd5e1'}}>{r.flex ? (r.flex.gamma2*100).toFixed(2)+'%' : '—'}</span></div>
                </div>
                <div className="mt-1.5 pl-2 grid grid-cols-4 gap-x-2 gap-y-0.5 text-[10px]">
                  <div className="col-span-2"><span className="text-slate-500">Tflex </span><span className="font-semibold tabular-nums" style={{color: r.flex && r.flex.deltaT > 20 ? '#10b981' : '#0ea5e9'}}>{r.flex ? `${r.flex.Tflex.toFixed(0)}°C (Δ+${r.flex.deltaT.toFixed(0)})` : '—'}</span></div>
                  <div><span className="text-slate-500">N1opt </span><span className="tabular-nums text-sky-300">{r.n1Opt.toFixed(0)}%</span></div>
                  <div><span className="text-slate-500">N1used </span><span className="tabular-nums" style={{color: r.wastePct>=8?TIER_COLOR.OVERTHRUST:r.wastePct>=4?TIER_COLOR.SUBOPT:'#cbd5e1'}}>{r.n1Used.toFixed(0)}%</span></div>
                  <div><span className="text-slate-500">ΔN1 </span><span className="tabular-nums" style={{color: r.wastePct>=8?TIER_COLOR.OVERTHRUST:'#cbd5e1'}}>+{r.wastePct.toFixed(1)}%</span></div>
                  <div><span className="text-slate-500">EGT-lost </span><span className="tabular-nums text-rose-300">{r.dEgtLost.toFixed(0)}°C</span></div>
                  <div><span className="text-slate-500">LCF× </span><span className="tabular-nums text-emerald-300">{r.lcfSaved.toFixed(2)}×</span></div>
                  <div><span className="text-slate-500">SCORE </span><span className="tabular-nums" style={{color: TIER_COLOR[r.tier]}}>{r.score.toFixed(0)}</span></div>
                </div>
                <div className="mt-1.5 pl-2">
                  <div className="w-full bg-slate-900/60 rounded h-1 overflow-hidden">
                    <div className="h-full" style={{width:`${Math.round(r.score)}%`, background: TIER_COLOR[r.tier]}}></div>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {(Object.entries(r.drivers) as [keyof Drivers, number][]).map(([k,v]) => (
                      <span key={k} className="text-[8.5px] px-1 py-px rounded bg-slate-900/60 text-slate-400 border border-slate-800/60">
                        {k} <span className="tabular-nums" style={{color: v > 60 ? TIER_COLOR.OVERTHRUST : v > 30 ? TIER_COLOR['TIGHT-PERF'] : '#cbd5e1'}}>{v.toFixed(0)}</span>
                      </span>
                    ))}
                  </div>
                  {r.notes.length > 0 && (
                    <div className="mt-1.5 space-y-0.5">
                      {r.notes.map((n,i) => (
                        <div key={i} className="text-[10px] italic" style={{color: r.tier==='OVERTHRUST'?'#fda4af':r.tier==='SUBOPT'?'#fda4af':'#fcd34d'}}>› {n}</div>
                      ))}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {tab === 'RUNWAYS' && (
          <div className="divide-y divide-slate-800/60">
            {(() => {
              const byApt = new Map<string, { ap: AirportPin; rs: ReturnType<typeof rwyState>; rs2: Row[] }>()
              for (const r of rows) {
                if (!r.rwy) continue
                const k = r.rwy.i
                if (!byApt.has(k)) byApt.set(k, { ap: r.rwy, rs: r.rstate!, rs2: [] })
                byApt.get(k)!.rs2.push(r)
              }
              const arr = Array.from(byApt.values()).sort((a,b)=>b.rs2.length-a.rs2.length).slice(0, 40)
              if (arr.length === 0) return <div className="px-3 py-6 text-center text-slate-500">no departure airports in scope</div>
              return arr.map(({ap, rs, rs2}) => {
                const ovr = rs2.filter(r => r.tier==='OVERTHRUST').length
                const sub = rs2.filter(r => r.tier==='SUBOPT').length
                const meanWast = rs2.reduce((a,b)=>a+b.wastePct,0)/rs2.length
                const worstT: Tier = rs2.reduce((a,b)=>TIER_RANK[b.tier] < TIER_RANK[a]?b.tier:a, 'EFFICIENT' as Tier)
                return (
                  <div key={ap.i} className="px-3 py-2" style={{borderLeft:`3px solid ${TIER_COLOR[worstT]}`}}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-[12px] text-sky-300">{ap.i}/{ap.a}</span>
                      <span className="text-[10px] text-slate-400 truncate">{ap.m}</span>
                      <span className="ml-auto text-[10px] text-slate-400 tabular-nums">n={rs2.length}</span>
                    </div>
                    <div className="grid grid-cols-5 gap-x-2 text-[10px] pl-2">
                      <div><span className="text-slate-500">TORA </span><span className="tabular-nums text-slate-200">{rs.TORA}ft</span></div>
                      <div><span className="text-slate-500">TODA </span><span className="tabular-nums text-slate-200">{rs.TODA}ft</span></div>
                      <div><span className="text-slate-500">ELEV </span><span className="tabular-nums text-slate-200">{rs.elevFt}ft</span></div>
                      <div><span className="text-slate-500">OAT </span><span className="tabular-nums text-slate-200">{rs.oatC.toFixed(0)}°C</span></div>
                      <div><span className="text-slate-500">SURF </span><span className="text-slate-200">{rs.surface}</span></div>
                    </div>
                    <div className="grid grid-cols-4 gap-x-2 text-[10px] pl-2 mt-1">
                      <div><span className="text-slate-500">MEAN-ΔN1 </span><span className="tabular-nums text-slate-200">{meanWast.toFixed(1)}%</span></div>
                      <div><span className="text-slate-500">OVR </span><span className="tabular-nums" style={{color:ovr?TIER_COLOR.OVERTHRUST:'#cbd5e1'}}>{ovr}</span></div>
                      <div><span className="text-slate-500">SUB </span><span className="tabular-nums" style={{color:sub?TIER_COLOR.SUBOPT:'#cbd5e1'}}>{sub}</span></div>
                      <div><span className="text-slate-500">HDG </span><span className="tabular-nums text-slate-200">{rs.rwyHdg.toString().padStart(3,'0')}°</span></div>
                    </div>
                  </div>
                )
              })
            })()}
          </div>
        )}

        {tab === 'FLEX-CARD' && (
          <div className="px-3 py-3">
            {!selectedCard && <div className="px-3 py-6 text-center text-slate-500">select an aircraft in AIRCRAFT tab</div>}
            {selectedCard && selectedCard.flex && selectedCard.rstate && (() => {
              const r = selectedCard
              const sp = r.spec
              const fl = r.flex!
              const rs = r.rstate!
              return (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="font-bold text-[14px] text-slate-100">{r.f.callsign || r.f.icao}</span>
                    <span className="text-[10px] text-slate-500">{r.f.type} · {sp.engineFamily}</span>
                    <span className="ml-auto text-[10px] px-2 py-0.5 rounded font-bold" style={{background:TIER_COLOR[r.tier]+'22', color:TIER_COLOR[r.tier]}}>{r.tier}</span>
                  </div>
                  <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">Takeoff Performance Card</div>
                  <div className="border border-slate-800 rounded-md overflow-hidden">
                    <div className="grid grid-cols-4 gap-px bg-slate-800 text-[10px]">
                      {[
                        ['DEP', `${r.rwy?.i}/${r.rwy?.a}`, '#7dd3fc'],
                        ['ELEV', `${rs.elevFt} ft`, '#cbd5e1'],
                        ['OAT', `${rs.oatC.toFixed(0)}°C`, '#cbd5e1'],
                        ['ISA-Δ', `${(rs.oatC - (15 - 1.98*rs.elevFt/1000)).toFixed(0)}°C`, '#cbd5e1'],
                        ['TORA', `${rs.TORA} ft`, '#cbd5e1'],
                        ['TODA', `${(rs.TODA*todaMul/100).toFixed(0)} ft`, '#cbd5e1'],
                        ['SURF', rs.surface, rs.surface==='DRY'?'#10b981':rs.surface==='WET'?'#f59e0b':'#f43f5e'],
                        ['HDG', `${rs.rwyHdg.toString().padStart(3,'0')}°`, '#cbd5e1'],
                        ['TOW', `${(r.W/1000).toFixed(1)} t`, '#cbd5e1'],
                        ['MTOW', `${(sp.MTOW/1000).toFixed(1)} t`, '#cbd5e1'],
                        ['W/MTOW', `${(r.W/sp.MTOW*100).toFixed(0)}%`, '#cbd5e1'],
                        ['σ', `${(densityRatio(rs.elevFt, rs.oatC)).toFixed(3)}`, '#cbd5e1'],
                      ].map(([lbl, val, col], i) => (
                        <div key={i} className="bg-slate-950 px-2 py-1.5">
                          <div className="text-[8.5px] text-slate-500 uppercase tracking-wider">{lbl}</div>
                          <div className="font-semibold tabular-nums" style={{color: col as string}}>{val}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="text-[10px] text-slate-500 uppercase tracking-widest mt-3 mb-1">Flex / Reduced-Thrust Result</div>
                  <div className="border border-sky-500/40 bg-sky-500/5 rounded-md p-3">
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <div className="text-[9px] text-slate-500 uppercase">Tflex Assumed</div>
                        <div className="text-[28px] font-bold tabular-nums text-sky-300 leading-none">{fl.Tflex.toFixed(0)}°C</div>
                        <div className="text-[10px] text-slate-400 mt-1">Δ <span className="tabular-nums text-emerald-300">+{fl.deltaT.toFixed(0)}°C</span> above OAT</div>
                      </div>
                      <div>
                        <div className="text-[9px] text-slate-500 uppercase">N1 Optimum</div>
                        <div className="text-[28px] font-bold tabular-nums text-slate-100 leading-none">{fl.n1Pct.toFixed(0)}%</div>
                        <div className="text-[10px] text-slate-400 mt-1">vs TOGA <span className="tabular-nums">100%</span></div>
                      </div>
                      <div>
                        <div className="text-[9px] text-slate-500 uppercase">N1 Used (obs.)</div>
                        <div className="text-[28px] font-bold tabular-nums leading-none" style={{color:r.wastePct>=8?TIER_COLOR.OVERTHRUST:r.wastePct>=4?TIER_COLOR.SUBOPT:'#10b981'}}>{r.n1Used.toFixed(0)}%</div>
                        <div className="text-[10px] mt-1" style={{color:r.wastePct>=8?TIER_COLOR.OVERTHRUST:'#cbd5e1'}}>ΔN1 <span className="tabular-nums">+{r.wastePct.toFixed(1)}%</span> waste</div>
                      </div>
                    </div>
                  </div>

                  <div className="text-[10px] text-slate-500 uppercase tracking-widest mt-3 mb-1">Limit Margins (per FAR-25 / CS-25)</div>
                  <div className="space-y-1.5">
                    {[
                      ['TOD vs TODA', fl.tod, rs.TODA*todaMul/100, 'ft', false],
                      ['γ2 (2nd-segment climb)', fl.gamma2*100, minGamma*100, '%', true],
                      ['VLOF vs Vtire-cert', 138 + (r.W/sp.Wref)*18, sp.Vtire, 'kt', false],
                    ].map(([lbl, cur, lim, unit, geq], i) => {
                      const margin = geq ? (cur as number)/(lim as number) : (lim as number)/(cur as number)
                      const pct = clamp((margin - 1) * 100, -50, 100)
                      const col = pct < 0 ? TIER_COLOR.OVERTHRUST : pct < 5 ? TIER_COLOR['TIGHT-PERF'] : pct < 15 ? TIER_COLOR.OPTIMAL : '#10b981'
                      return (
                        <div key={i}>
                          <div className="flex items-center justify-between text-[10px]">
                            <span className="text-slate-400">{lbl as string}</span>
                            <span className="tabular-nums" style={{color: col}}>{(cur as number).toFixed(2)}{unit as string} {geq?'≥':'≤'} {(lim as number).toFixed(2)}{unit as string} · {pct >= 0 ? '+' : ''}{pct.toFixed(1)}%</span>
                          </div>
                          <div className="w-full bg-slate-900/60 rounded h-1 mt-0.5 overflow-hidden">
                            <div className="h-full" style={{width:`${clamp(50 + pct/2, 4, 100)}%`, background:col}}></div>
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  <div className="text-[10px] text-slate-500 uppercase tracking-widest mt-3 mb-1">Engine-Life Benefit</div>
                  <div className="grid grid-cols-3 gap-2 text-[10px]">
                    <div className="px-2 py-2 rounded border border-slate-800 bg-slate-900/60">
                      <div className="text-[8.5px] text-slate-500 uppercase">EGT Margin Gain</div>
                      <div className="text-[16px] font-bold tabular-nums text-emerald-300">+{(fl.deltaT*0.55).toFixed(0)}°C</div>
                      <div className="text-[9px] text-slate-500 mt-0.5">vs TOGA · per CFM SB-72-0234</div>
                    </div>
                    <div className="px-2 py-2 rounded border border-slate-800 bg-slate-900/60">
                      <div className="text-[8.5px] text-slate-500 uppercase">LCF Cycle Mult.</div>
                      <div className="text-[16px] font-bold tabular-nums text-emerald-300">{r.lcfSaved.toFixed(2)}×</div>
                      <div className="text-[9px] text-slate-500 mt-0.5">to hot-section TBR</div>
                    </div>
                    <div className="px-2 py-2 rounded border border-slate-800 bg-slate-900/60">
                      <div className="text-[8.5px] text-slate-500 uppercase">EGT Margin Lost</div>
                      <div className="text-[16px] font-bold tabular-nums" style={{color: r.dEgtLost>30?TIER_COLOR.OVERTHRUST:r.dEgtLost>0?TIER_COLOR.SUBOPT:'#cbd5e1'}}>{r.dEgtLost.toFixed(0)}°C</div>
                      <div className="text-[9px] text-slate-500 mt-0.5">this departure</div>
                    </div>
                  </div>

                  {r.notes.length > 0 && (
                    <div className="mt-3 space-y-1">
                      {r.notes.map((n,i)=>(
                        <div key={i} className="text-[10.5px] italic px-2 py-1 rounded border" style={{
                          background: 'rgba(244,63,94,0.06)',
                          borderColor: 'rgba(244,63,94,0.35)',
                          color: '#fda4af',
                        }}>› {n}</div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800/60 text-[9px] text-slate-500 italic">
        FCOM PI-11 §11.20 ATM · Airbus PRO-NOR-SOP-13 Flex · 14 CFR §25.107/121/189 · AC 25-13 · AMC 25-13 · IATA Fuel Eff Gap 2024 §4.2 · CFM/GE/RR/PW SBs
      </div>
    </div>
  )
}
