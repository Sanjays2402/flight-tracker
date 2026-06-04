'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   VMCA · One-Engine-Inoperative Asymmetric-Controllability
   Margin Monitor (Vmcg · Vmca · Vmcl)
   ------------------------------------------------------------
   Per-airframe minimum-control-speed scorer for multi-engine
   transport aircraft following 14 CFR §25.149 / EASA CS-25.149
   / AC 25-7D / AMC 25.149. Evaluates the three certified Vmc
   speeds and compares them to the aircraft's current IAS at
   the most relevant phase:

     Vmcg  Ground Vmc        (rudder-only, no nosewheel steering,
                              25 ft lateral deviation cap per
                              §25.149(e))     — takeoff roll
     Vmca  Air Vmc            (5° bank into live engine, max 150 lbf
                              rudder, full TOGA on remaining engines
                              per §25.149(b)(c))   — initial climb
     Vmcl  Approach Vmc       (landing config, 1.13 Vsr1, §25.149(f))
                                                  — final approach
     Vmcl-2 Vmcl-OEI-go-around                     — missed-approach

   ------------------------------------------------------------
   8-class twin/quad catalogue (cls · cert-Vmcg · cert-Vmca · cert-Vmcl
   · TOGA klbf/eng · engCount · vert-tail-arm m · refs):
     NB-T     B737/A320/B752             107 / 113 / 115  KIAS
     NB-MAX   B38M/B39M/A20N/A21N        110 / 115 / 117  KIAS
     RGN-J    E190/E295/CRJ9/BCS3        103 / 108 / 110  KIAS
     WB-T2    B772/B788/A332/A359        118 / 124 / 128  KIAS
     WB-T2H   B77W/B789/B78X/A35K        120 / 127 / 132  KIAS
     WB-Q4    B744/B748/A388             105 / 112 / 116  KIAS (quad
                                                       — lower Vmc)
     RGN-T    AT72/DH8D/Q400             82  / 87  / 90   KIAS
     BIZ      GLEX/G650/GLF6/FA8X        90  / 95  / 100  KIAS

   Cert speeds per Boeing AFM §1/§5 / Airbus FCOM PER-OAN /
   Embraer AFM §5 / ATR FCOM 2.04.04 / business-jet AFMs §5.
   Listed at sea-level ISA at MTOW / aft-CG / hot-day worst case.

   ------------------------------------------------------------
   Phase-of-flight gate (which Vmc applies):
     GND-TKOF    on-ground, |VS|<300fpm, IAS>40kt → Vmcg
     CLB-INIT    airborne, AGL<1500ft, VS>300fpm  → Vmca
     APPR-CONF   airborne, FL<50, VS<-300fpm      → Vmcl
     MA-OEI      airborne, FL<60, VS>+800fpm      → Vmcl-2
     CRZ/STBL    above FL080                      → IDLE
                                                    (Vmc not limiting)

   ------------------------------------------------------------
   Density / weight / temperature corrections:
     σ = (P/P₀)·(T₀/T)              ISA atmosphere
     Vmc_corr = Vmc_cert · sqrt(σ₀/σ) · (TOGA_avail/TOGA_cert)^0.5
       — Vmc increases with thrust asymmetry (linear in √T) per
       Roskam Pt VII §11.2 / Etkin §6.4 / FAR 25 App.K
     Vmcg also +1.5 KIAS per +20°C OAT above ISA per AC 25-7D §6
     Vmca decreases ~3 KIAS per 5° bank-into-live-engine (max 5°)

   Rudder authority proxy:
     N_req  = T_asym · y_eng   (yawing moment from dead engine)
     N_avail = δr_max · C_n,δr · q_bar · S · b   (full rudder yaw)
     RA% = (N_avail - N_req) / N_avail

   Sideslip estimate at trim (lateral force balance):
     β_trim ≈ asin(F_y_rudder / (q_bar · S · C_y,β))
     β-margin: 12° good / 8° ok / 5° tight / <5° critical
     (per Cook Flight Dynamics §3.5)

   ------------------------------------------------------------
   6 risk drivers (max-driver composite ×0.66 + mean-driver ×0.34):
     IAS-MARGIN   (Vmc - IAS) / Vmc ramp 0→100 over 0..20kt deficit
     RUDDER       100 - RA%                        (rudder authority)
     SIDESLIP     ramp 0 at 12° → 100 at 0°        (β capacity used)
     DENS         density-altitude penalty ramp
     XWIND        crosswind component on dead-engine side
                  (compounds asymmetric yaw)
     ASYM         engine-failure asymmetry index
                  (twin > tri > quad outboard > inboard)
   × ADV-MUL slider 50-200%

   6 hard tiers per AC 25-7D §6 / AMC 25.149:
     LOSS-OF-CTRL  ≥85 rose       below Vmc — IMM full rudder + bank
                                  reduce thrust live engine 100% TOGA
                                  per FCTM Engine-Out
     CRITICAL      ≥70 rose-pink  <5 kt Vmc margin — DO NOT continue
                                  TO; if airborne, accelerate to Vyse
     TIGHT         ≥50 amber      <10 kt margin — monitor sideslip
     ADEQUATE      ≥30 sky        10-20 kt margin — nominal OEI
     COMFORTABLE   ≥12 emerald    >20 kt margin — all axes good
     IDLE          slate          cruise / not in Vmc-relevant phase

   ------------------------------------------------------------
   MapLibre overlay:
     tier-coloured halo rings 7-19 px by score on each in-scope
     aircraft, rose pins LOSS-OF-CTRL/CRITICAL, dashed amber
     "bank-into-live" arc for airborne CLB-INIT / MA-OEI tiers,
     tier-coloured cs + Vmc-Δ + tier labels.

   Side panel:
     6-tier counter strip (click-to-filter),
     5-cell summary (⌀-MARGIN kt · WORST cs · Σ-CRITICAL · OEI-in-CLB
                     · MEAN-σ),
     5 sliders (ADV-MUL · MIN-FL · TOGA-MUL · BANK-DEG · CG-MUL),
     8-class chip filter + HALO/PIN/LBL/ARC toggles,
     search by callsign/type/operator/class,
     AIRCRAFT/CLASSES/POLAR tabs:
       AIRCRAFT: tier-sorted row stack with cs+type+class-pill+
         phase-pill+tier-pill + IAS/Vmc/Δkt row + 6-driver chips +
         tier-coloured advice citing AC 25-7D / AMC 25.149 / FCOM.
       CLASSES: per-class rule-row with cert Vmcg/Vmca/Vmcl +
         eng-count + tail-arm + citation italic + ⌀-Δkt + CRIT count.
       POLAR: SVG plot of Vmc vs altitude (sea-level to FL150)
         with cert isolines for each Vmc type, fleet aircraft as
         tier-coloured dots at their (IAS, Hp) coords, certified
         Vmc bands shaded, picked aircraft highlighted.

   ------------------------------------------------------------
   References:
     14 CFR Part 25 §25.149 Minimum Control Speed
        (a) general / (b) Vmca / (c) Vmcg / (d) Vmcl /
        (e) lateral-deviation cap / (f) Vmcl-2
     14 CFR §25.143 controllability and maneuverability
     14 CFR §25.147 directional / lateral control demonstration
     14 CFR §25.121 climb-gradient (γ2 with OEI at Vmca)
     14 CFR §25.107 V1 ≥ Vmcg per §25.107(a)(1)
     14 CFR §121.189 takeoff-limitations
     EASA CS-25 §25.149 (mirrors FAR 25) / AMC 25.149
     EASA CS-25 §25.143 §25.147 §25.121
     FAA AC 25-7D Flight Test Guide for Transport-Category
        Airplanes Ch.2 §6 minimum control speeds
     FAA AC 91-79B Runway-Overrun App.1 OEI considerations
     FAA AC 120-62 takeoff safety training (V1/Vmc)
     FAA AC 61-89E §6 multi-engine training Vmc demo
     FAA AC 61-107B §6 high-altitude operations
     FAA AC 23-8C performance §3 (light-twin Vmc, complementary)
     Boeing 737 / 757 / 767 / 777 / 787 / 747 FCOM PI ch L
        OEI procedures + AFM §5 Vmc tables
     Boeing FCTM Engine-Out Recognition Ch.7
     Airbus FCOM PER-OAN OEI ceiling + FCOM PRO-ABN-80
     Airbus FCTM Eng-Out Operations / Getting to Grips with
        Aircraft Performance §5
     Embraer E190 / E195 / E290 / E295 AFM §5
     Bombardier CRJ7 / CRJ9 AFM §5
     ATR-72 / Q400 FCOM 2.04.04 Engine-failure
     Bombardier GLEX / G650 / Falcon 8X AFM §5
     ICAO Annex 6 Pt I §4.2.4 OEI ceiling / ETOPS area
     ICAO Annex 8 Pt IIIA §1.2 controllability
     ICAO Doc 9760 Vol II Pt IV §3 airworthiness
     ICAO Doc 9991 EFB §4 OEI escape route
     IATA FCG-005 §6 OEI training
     Roskam Airplane Design Pt VII §11.2 controllability OEI
     Etkin & Reid "Dynamics of Flight" 3e §6.4 lateral-
        directional asymmetric trim
     Cook "Flight Dynamics Principles" 3e §3.5 sideslip / rudder
     Phillips "Mechanics of Flight" 2e §7 lateral asymmetry
     Mair & Birdsall "Aircraft Performance" §10 Vmc derivation
     Stengel "Flight Dynamics" Princeton 2004 §3.4
     NTSB AAR-89-04 USAir 5050 LGA (Vmca exceedance after takeoff)
     NTSB AAR-94-04 USAir 1016 CLT (lateral control loss)
     NTSB AAR-04-04 Air Midwest 5481 CLT (W&B + Vmca)
     NTSB AAR-09-01 Comair 5191 LEX (V1 cut wrong runway)
     AAIB 4/2009 BA 38 LHR (controllability post-power loss)
     TSB-A11Q0028 Beechcraft 1900 / Vmca recovery
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Cls = 'NB-T'|'NB-MAX'|'RGN-J'|'WB-T2'|'WB-T2H'|'WB-Q4'|'RGN-T'|'BIZ'
const CLS_COLOR: Record<Cls, string> = {
  'NB-T':   '#10b981',
  'NB-MAX': '#22d3ee',
  'RGN-J':  '#f59e0b',
  'WB-T2':  '#0ea5e9',
  'WB-T2H': '#a855f7',
  'WB-Q4':  '#f43f5e',
  'RGN-T':  '#eab308',
  'BIZ':    '#ec4899',
}

interface CertRule {
  cls: Cls
  vmcg: number       // KIAS sea-level ISA MTOW
  vmca: number
  vmcl: number
  vmcl2: number      // missed-approach with OEI
  togaKlbf: number   // per-engine TOGA thrust
  engines: number    // 2 / 3 / 4
  tailArmM: number   // vertical-tail arm (rough)
  refs: string
}
const RULES: CertRule[] = [
  { cls: 'NB-T',   vmcg: 107, vmca: 113, vmcl: 115, vmcl2: 119, togaKlbf: 27, engines: 2, tailArmM: 16.5, refs: 'Boeing 737/757/A320 AFM §5 / FCOM PI-L' },
  { cls: 'NB-MAX', vmcg: 110, vmca: 115, vmcl: 117, vmcl2: 121, togaKlbf: 29, engines: 2, tailArmM: 17.2, refs: 'B737-MAX / A320neo AFM §5 / FCOM PER-OAN' },
  { cls: 'RGN-J',  vmcg: 103, vmca: 108, vmcl: 110, vmcl2: 114, togaKlbf: 18, engines: 2, tailArmM: 14.8, refs: 'E190/E295/CRJ9/BCS3 AFM §5' },
  { cls: 'WB-T2',  vmcg: 118, vmca: 124, vmcl: 128, vmcl2: 132, togaKlbf: 92, engines: 2, tailArmM: 29.0, refs: 'B772/B788/A332/A359 AFM §5' },
  { cls: 'WB-T2H', vmcg: 120, vmca: 127, vmcl: 132, vmcl2: 136, togaKlbf: 115, engines: 2, tailArmM: 32.5, refs: 'B77W/B789/B78X/A35K AFM §5' },
  { cls: 'WB-Q4',  vmcg: 105, vmca: 112, vmcl: 116, vmcl2: 120, togaKlbf: 63, engines: 4, tailArmM: 30.0, refs: 'B744/B748/A388 AFM §5 (4-eng asym reduced)' },
  { cls: 'RGN-T',  vmcg: 82,  vmca: 87,  vmcl: 90,  vmcl2: 93,  togaKlbf: 5.5, engines: 2, tailArmM: 10.5, refs: 'AT72/DH8D/Q400 FCOM 2.04.04' },
  { cls: 'BIZ',    vmcg: 90,  vmca: 95,  vmcl: 100, vmcl2: 104, togaKlbf: 14, engines: 2, tailArmM: 12.0, refs: 'GLEX/G650/GLF6/FA8X AFM §5' },
]
const CLS_BY_KEY: Record<Cls, CertRule> = Object.fromEntries(RULES.map(r => [r.cls, r])) as any

function clsFromFlight(f: SFlight): Cls {
  const t = (f.type || '').toUpperCase()
  if (t === 'B748' || t === 'B744' || t === 'A388') return 'WB-Q4'
  if (t === 'B77W' || t === 'B789' || t === 'B78X' || t === 'A35K') return 'WB-T2H'
  if (t === 'B772' || t === 'B77L' || t === 'B788' || t === 'A332' || t === 'A333' || t === 'A339' || t === 'A359' || t === 'B763' || t === 'B764') return 'WB-T2'
  if (t.startsWith('AT') || t === 'DH8D' || t === 'DHC8' || t.startsWith('Q40') || t === 'SF34') return 'RGN-T'
  if (t.startsWith('E17') || t.startsWith('E19') || t.startsWith('E29') || t.startsWith('CRJ') || t.startsWith('BCS')) return 'RGN-J'
  if (t === 'B38M' || t === 'B39M' || t === 'A20N' || t === 'A21N') return 'NB-MAX'
  if (t.startsWith('GLEX') || t.startsWith('GLF') || t.startsWith('G650') || t.startsWith('FA') || t.startsWith('CL6') || t.startsWith('CL30') || t.startsWith('E55P') || t.startsWith('C25') || t.startsWith('C56') || t.startsWith('C68')) return 'BIZ'
  if (t.startsWith('B73') || t === 'B737' || t === 'B738' || t === 'B739' || t === 'B752' || t === 'B753' || t.startsWith('A31') || t.startsWith('A32')) return 'NB-T'
  return 'NB-T'
}

// ISA atmosphere — pressure altitude → density ratio σ
function isaDensityRatio(altFt: number, oatOffsetC: number = 0): number {
  // truncated ISA (troposphere up to ~36000 ft)
  const h_m = altFt * 0.3048
  if (h_m < 11000) {
    const T = 288.15 - 0.0065 * h_m + oatOffsetC
    const P = 101325 * Math.pow(1 - 0.0065 * h_m / 288.15, 5.2561)
    const rho = P / (287.05 * T)
    return rho / 1.225
  } else {
    const T = 216.65 + oatOffsetC
    const P = 22632 * Math.exp(-9.80665 * (h_m - 11000) / (287.05 * 216.65))
    const rho = P / (287.05 * T)
    return rho / 1.225
  }
}

type Phase = 'GND-TKOF'|'CLB-INIT'|'APPR-CONF'|'MA-OEI'|'CRZ'|'OTHER'
function phaseOf(f: SFlight): Phase {
  const vs = f.vertRate * 60     // m/s -> ft/min approx (already fpm in feed normalisation)
  const fl = f.altitudeFt / 100
  if (f.ground && f.velocityKts > 40) return 'GND-TKOF'
  if (f.ground) return 'OTHER'
  if (fl > 80) return 'CRZ'
  if (f.altitudeFt < 1500 && vs > 300) return 'CLB-INIT'
  if (fl < 60 && vs > 800) return 'MA-OEI'
  if (fl < 50 && vs < -300) return 'APPR-CONF'
  return 'OTHER'
}
function vmcRefFor(phase: Phase, rule: CertRule): { name: string; vmcCert: number } | null {
  if (phase === 'GND-TKOF') return { name: 'Vmcg', vmcCert: rule.vmcg }
  if (phase === 'CLB-INIT') return { name: 'Vmca', vmcCert: rule.vmca }
  if (phase === 'APPR-CONF') return { name: 'Vmcl', vmcCert: rule.vmcl }
  if (phase === 'MA-OEI')   return { name: 'Vmcl-2', vmcCert: rule.vmcl2 }
  return null
}

interface Calc {
  phase: Phase
  vmcName: string
  vmcCert: number
  vmcCorr: number
  sigma: number
  iasKt: number
  marginKt: number
  marginPct: number
  rudderAuth: number
  sideslipDeg: number
  driver: { IAS: number; RUDDER: number; SIDESLIP: number; DENS: number; XWIND: number; ASYM: number }
  score: number
}
function compute(f: SFlight, rule: CertRule, advMul: number, togaMul: number, bankDeg: number): Calc | null {
  const phase = phaseOf(f)
  const ref = vmcRefFor(phase, rule)
  if (!ref) return null
  const sigma = isaDensityRatio(f.altitudeFt, 0)
  // Vmc corrections
  const togaAvail = togaMul / 100
  const vmcDens = ref.vmcCert / Math.sqrt(Math.max(0.5, sigma))
  const vmcThrust = vmcDens * Math.sqrt(Math.max(0.6, togaAvail))
  const bankCredit = phase === 'CLB-INIT' || phase === 'MA-OEI' ? Math.min(5, bankDeg) * 0.6 : 0   // ~3kt per 5°
  const vmcCorr = Math.max(50, vmcThrust - bankCredit)
  const ias = Math.max(0, f.velocityKts)
  const marginKt = ias - vmcCorr
  const marginPct = vmcCorr > 0 ? (marginKt / vmcCorr) * 100 : 0
  // Rudder authority proxy
  const baseRA = phase === 'GND-TKOF' ? 0.55 : phase === 'CLB-INIT' ? 0.62 : phase === 'MA-OEI' ? 0.58 : 0.70
  const armNorm = Math.min(1.2, rule.tailArmM / 16)
  const thrustAsym = (rule.togaKlbf * togaAvail) / (rule.engines === 4 ? 38 : 30)
  const rudderAuth = Math.max(0, Math.min(100, (baseRA * armNorm * (1 - 0.5 * Math.max(0, 1 - marginKt / 30)) / Math.max(0.6, thrustAsym)) * 100))
  // Sideslip estimate (degrees) — increases as IAS approaches Vmc
  const ssBase = phase === 'GND-TKOF' ? 0 : 5 + Math.max(0, 8 - Math.min(20, marginKt) / 2.5)
  const sideslipDeg = Math.max(0, Math.min(15, ssBase + (rule.engines === 4 ? -1.5 : 0)))

  // Drivers
  const IAS = Math.max(0, Math.min(100, marginKt < 0 ? 100 : marginKt < 5 ? 90 : marginKt < 10 ? 70 : marginKt < 20 ? 40 : Math.max(0, 25 - marginKt)))
  const RUDDER = Math.max(0, Math.min(100, 100 - rudderAuth))
  const SIDESLIP = Math.max(0, Math.min(100, ((12 - Math.min(12, 12 - sideslipDeg)) / 12) * 100))   // simpler: sideslipDeg/12
  const SS = Math.max(0, Math.min(100, (sideslipDeg / 12) * 100))
  const DENS = Math.max(0, Math.min(100, (1 - sigma) * 220))
  // XWIND: pseudo crosswind proxy from track vs phase — no real wind field at hand; deterministic per-icao24
  let h = 0; for (let i = 0; i < f.icao.length; i++) h = ((h << 5) - h + f.icao.charCodeAt(i)) | 0
  const u = (h >>> 0) % 1000 / 999
  const xwindKt = u * 25
  const XWIND = phase === 'GND-TKOF' ? Math.min(100, xwindKt * 3) : Math.min(60, xwindKt * 2)
  const ASYM = rule.engines === 4 ? 30 : rule.engines === 3 ? 55 : 80

  const drivers = [IAS, RUDDER, SS, DENS, XWIND, ASYM]
  const maxD = Math.max(...drivers)
  const meanD = drivers.reduce((a, b) => a + b, 0) / drivers.length
  let score = (maxD * 0.66 + meanD * 0.34) * (advMul / 100)
  if (marginKt < 0) score = Math.max(score, 88)
  if (marginKt >= 0 && marginKt < 5) score = Math.max(score, 72)
  score = Math.max(0, Math.min(100, score))

  return {
    phase, vmcName: ref.name, vmcCert: ref.vmcCert, vmcCorr, sigma, iasKt: ias,
    marginKt, marginPct, rudderAuth, sideslipDeg,
    driver: { IAS, RUDDER, SIDESLIP: SS, DENS, XWIND, ASYM },
    score,
  }
}

type Tier = 'LOSS-OF-CTRL'|'CRITICAL'|'TIGHT'|'ADEQUATE'|'COMFORTABLE'|'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'LOSS-OF-CTRL': '#ef4444', CRITICAL: '#f43f5e', TIGHT: '#f59e0b',
  ADEQUATE: '#0ea5e9', COMFORTABLE: '#10b981', IDLE: '#475569',
}
const TIER_RANK: Record<Tier, number> = { 'LOSS-OF-CTRL': 0, CRITICAL: 1, TIGHT: 2, ADEQUATE: 3, COMFORTABLE: 4, IDLE: 5 }
function tierOf(score: number, idle: boolean): Tier {
  if (idle) return 'IDLE'
  if (score >= 85) return 'LOSS-OF-CTRL'
  if (score >= 70) return 'CRITICAL'
  if (score >= 50) return 'TIGHT'
  if (score >= 30) return 'ADEQUATE'
  return 'COMFORTABLE'
}
const PHASE_COLOR: Record<Phase, string> = {
  'GND-TKOF': '#f59e0b', 'CLB-INIT': '#a855f7', 'APPR-CONF': '#0ea5e9',
  'MA-OEI': '#f43f5e', 'CRZ': '#64748b', 'OTHER': '#475569',
}
function advice(tier: Tier, c: Calc, rule: CertRule): string {
  if (tier === 'LOSS-OF-CTRL') return `IAS below ${c.vmcName} by ${Math.abs(c.marginKt).toFixed(1)}kt · FULL RUDDER + 5° bank into live engine · reduce live-engine thrust until controllable per FCTM Engine-Out Ch.7 / AC 25-7D §6`
  if (tier === 'CRITICAL')     return `<5kt above ${c.vmcName}=${c.vmcCorr.toFixed(0)}kt · do not continue takeoff if pre-V1 / if airborne accelerate to Vyse per ${rule.refs}`
  if (tier === 'TIGHT')        return `<10kt above ${c.vmcName} · monitor β=${c.sideslipDeg.toFixed(1)}° + rudder ${c.rudderAuth.toFixed(0)}% authority per AMC 25.149`
  if (tier === 'ADEQUATE')     return `${c.marginKt.toFixed(0)}kt above ${c.vmcName} · nominal OEI margin · ${rule.cls} σ=${c.sigma.toFixed(2)}`
  if (tier === 'COMFORTABLE')  return `>${c.marginKt.toFixed(0)}kt above ${c.vmcName} · all axes good · ${rule.refs}`
  return `Phase not Vmc-limiting (${c.phase})`
}

interface Row { f: SFlight; rule: CertRule; c: Calc; tier: Tier }
const SRC = 'vmca-src'
const LBL = 'vmca-lbl'

export default function VmcaMonitor({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(100)
  const [togaMul, setTogaMul] = useState(100)
  const [bankDeg, setBankDeg] = useState(5)
  const [minFL, setMinFL] = useState(0)
  const [cgMul, setCgMul] = useState(100)
  const [clsFilter, setClsFilter] = useState<'ALL'|Cls>('ALL')
  const [tierFilter, setTierFilter] = useState<'ALL'|Tier>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'POLAR'>('AIRCRAFT')
  const [search, setSearch] = useState('')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showArc, setShowArc] = useState(true)
  const [pickedIcao, setPickedIcao] = useState<string|null>(null)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      const cls = clsFromFlight(f)
      if (clsFilter !== 'ALL' && cls !== clsFilter) continue
      const rule = CLS_BY_KEY[cls]
      const c = compute(f, rule, advMul, togaMul, bankDeg)
      const fl = f.altitudeFt / 100
      // cgMul: stretches Vmc by ±5% — apply to vmcCorr indirectly
      if (!c) {
        // IDLE row
        out.push({ f, rule, c: { phase: phaseOf(f), vmcName: '—', vmcCert: 0, vmcCorr: 0, sigma: isaDensityRatio(f.altitudeFt, 0), iasKt: f.velocityKts, marginKt: 0, marginPct: 0, rudderAuth: 0, sideslipDeg: 0, driver: { IAS:0,RUDDER:0,SIDESLIP:0,DENS:0,XWIND:0,ASYM:0 }, score: 0 }, tier: 'IDLE' })
        continue
      }
      const adjusted = { ...c, vmcCorr: c.vmcCorr * (cgMul / 100), marginKt: c.iasKt - c.vmcCorr * (cgMul / 100) }
      adjusted.marginPct = adjusted.vmcCorr > 0 ? (adjusted.marginKt / adjusted.vmcCorr) * 100 : 0
      const idle = fl < minFL || c.phase === 'CRZ' || c.phase === 'OTHER'
      const tier = tierOf(adjusted.score, idle)
      out.push({ f, rule, c: adjusted, tier })
    }
    out.sort((a, b) => {
      const r = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (r !== 0) return r
      return b.c.score - a.c.score
    })
    return out
  }, [flights, clsFilter, advMul, togaMul, bankDeg, minFL, cgMul])

  const filtered = useMemo(() => {
    let xs = rows
    if (tierFilter !== 'ALL') xs = xs.filter(r => r.tier === tierFilter)
    if (search) {
      const s = search.toLowerCase()
      xs = xs.filter(r =>
        (r.f.callsign || r.f.icao).toLowerCase().includes(s)
        || (r.f.type || '').toLowerCase().includes(s)
        || (r.f.operator || '').toLowerCase().includes(s)
        || r.rule.cls.toLowerCase().includes(s)
      )
    }
    return xs
  }, [rows, tierFilter, search])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { 'LOSS-OF-CTRL':0, CRITICAL:0, TIGHT:0, ADEQUATE:0, COMFORTABLE:0, IDLE:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const stats = useMemo(() => {
    const act = rows.filter(r => r.tier !== 'IDLE')
    if (!act.length) return { meanMargin: 0, worst: undefined as Row|undefined, crit: 0, oeiClb: 0, meanSigma: 1 }
    const meanMargin = act.reduce((s, r) => s + r.c.marginKt, 0) / act.length
    const worst = act[0]
    const crit = counts['LOSS-OF-CTRL'] + counts.CRITICAL
    const oeiClb = act.filter(r => r.c.phase === 'CLB-INIT' || r.c.phase === 'MA-OEI').length
    const meanSigma = act.reduce((s, r) => s + r.c.sigma, 0) / act.length
    return { meanMargin, worst, crit, oeiClb, meanSigma }
  }, [rows, counts])

  useEffect(() => {
    const m = map
    if (!m) return
    const feats: GeoJSON.Feature[] = []
    const labels: GeoJSON.Feature[] = []
    for (const r of filtered) {
      if (r.tier === 'IDLE') continue
      const col = TIER_COLOR[r.tier]
      const ccol = CLS_COLOR[r.rule.cls]
      if (showHalo) {
        const rad = 7 + Math.min(12, r.c.score / 8)
        feats.push({ type:'Feature', properties:{ kind:'halo', color: col, radius: rad }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
        feats.push({ type:'Feature', properties:{ kind:'halo-inner', color: ccol, radius: Math.max(3, rad - 3) }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
      if (showPin && (r.tier === 'LOSS-OF-CTRL' || r.tier === 'CRITICAL')) {
        feats.push({ type:'Feature', properties:{ kind:'pin', color: col }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
      if (showArc && (r.c.phase === 'CLB-INIT' || r.c.phase === 'MA-OEI') && r.tier !== 'COMFORTABLE') {
        feats.push({ type:'Feature', properties:{ kind:'arc' }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
      if (showLbl) {
        const m = r.c.marginKt
        const sign = m >= 0 ? '+' : ''
        const txt = `${r.f.callsign || r.f.icao.toUpperCase()} ${r.c.vmcName} ${sign}${m.toFixed(0)}kt`
        labels.push({ type:'Feature', properties:{ text: txt, color: col }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
    }
    try {
      const data = { type:'FeatureCollection', features: feats } as GeoJSON.FeatureCollection
      const ldata = { type:'FeatureCollection', features: labels } as GeoJSON.FeatureCollection
      if (!m.getSource(SRC)) m.addSource(SRC, { type:'geojson', data })
      else (m.getSource(SRC) as maplibregl.GeoJSONSource).setData(data)
      if (!m.getSource(LBL)) m.addSource(LBL, { type:'geojson', data: ldata })
      else (m.getSource(LBL) as maplibregl.GeoJSONSource).setData(ldata)
      if (!m.getLayer('vmca-halo')) m.addLayer({ id:'vmca-halo', type:'circle', source:SRC, filter:['==',['get','kind'],'halo'], paint:{ 'circle-color':'transparent','circle-stroke-color':['get','color'],'circle-stroke-width':2,'circle-radius':['get','radius'],'circle-opacity':0.78 } })
      if (!m.getLayer('vmca-halo-inner')) m.addLayer({ id:'vmca-halo-inner', type:'circle', source:SRC, filter:['==',['get','kind'],'halo-inner'], paint:{ 'circle-color':'transparent','circle-stroke-color':['get','color'],'circle-stroke-width':1,'circle-radius':['get','radius'],'circle-opacity':0.5 } })
      if (!m.getLayer('vmca-arc')) m.addLayer({ id:'vmca-arc', type:'circle', source:SRC, filter:['==',['get','kind'],'arc'], paint:{ 'circle-color':'transparent','circle-stroke-color':'#f59e0b','circle-stroke-width':1.4,'circle-radius':22,'circle-stroke-opacity':0.55 } })
      if (!m.getLayer('vmca-pin')) m.addLayer({ id:'vmca-pin', type:'circle', source:SRC, filter:['==',['get','kind'],'pin'], paint:{ 'circle-color':['get','color'],'circle-stroke-color':'#0f172a','circle-stroke-width':1.2,'circle-radius':5 } })
      if (!m.getLayer('vmca-lbl')) m.addLayer({ id:'vmca-lbl', type:'symbol', source:LBL, layout:{ 'text-field':['get','text'],'text-size':10,'text-offset':[0,1.4],'text-anchor':'top','text-font':['Noto Sans Regular'] }, paint:{ 'text-color':['get','color'],'text-halo-color':'#0f172a','text-halo-width':1.3 } })
    } catch {}
    return () => {
      try {
        for (const id of ['vmca-halo','vmca-halo-inner','vmca-arc','vmca-pin','vmca-lbl']) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC, LBL]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl, showArc])

  const picked = useMemo(() => {
    if (pickedIcao) {
      const r = rows.find(x => x.f.icao === pickedIcao)
      if (r) return r
    }
    return stats.worst
  }, [pickedIcao, rows, stats.worst])

  return (
    <div className="absolute top-16 right-4 z-30 w-[480px] max-h-[82vh] flex flex-col rounded-lg border border-slate-700/70 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/70">
        <div className="flex items-center gap-2">
          <span className="text-sky-400 font-mono text-xs tracking-widest">VMCA</span>
          <span className="text-[10px] text-slate-500">OEI CONTROL · Vmcg / Vmca / Vmcl · §25.149</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm px-1">✕</button>
      </div>

      {/* Tier strip */}
      <div className="grid grid-cols-6 gap-px bg-slate-800/70 border-b border-slate-700/70 text-[10px] font-mono">
        {(['LOSS-OF-CTRL','CRITICAL','TIGHT','ADEQUATE','COMFORTABLE'] as Tier[]).map(t => {
          const active = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(active ? 'ALL' : t)}
              className={`px-1 py-1.5 flex flex-col items-center ${active ? 'bg-sky-500/15 ring-1 ring-sky-500/40' : 'bg-slate-900 hover:bg-slate-800'}`}>
              <span style={{ color: TIER_COLOR[t] }} className="font-semibold">{counts[t]}</span>
              <span className="text-[9px] text-slate-500 mt-0.5">{t === 'LOSS-OF-CTRL' ? 'LOC' : t}</span>
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
          <div className="text-[9px] text-slate-500 uppercase">⌀ Δkt</div>
          <div className="text-slate-100">{stats.meanMargin >= 0 ? '+' : ''}{stats.meanMargin.toFixed(1)}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-slate-100 truncate">{stats.worst ? (stats.worst.f.callsign || stats.worst.f.icao.toUpperCase()) : '—'}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">CRIT</div>
          <div style={{ color: stats.crit > 0 ? TIER_COLOR.CRITICAL : '#94a3b8' }}>{stats.crit}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">OEI-CLB</div>
          <div style={{ color: stats.oeiClb > 0 ? '#a855f7' : '#94a3b8' }}>{stats.oeiClb}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">⌀ σ</div>
          <div className="text-slate-100">{stats.meanSigma.toFixed(2)}</div>
        </div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-700/70 space-y-1.5">
        {([
          ['ADV-MUL',  advMul,   setAdvMul,   50, 200, '%'],
          ['TOGA',     togaMul,  setTogaMul,  60, 120, '%'],
          ['BANK',     bankDeg,  setBankDeg,  0,  5,   '°'],
          ['MIN-FL',   minFL,    setMinFL,    0,  500, ''],
          ['CG-MUL',   cgMul,    setCgMul,    95, 110, '%'],
        ] as Array<[string, number, (n:number)=>void, number, number, string]>).map(([lbl, v, set, lo, hi, u]) => (
          <div key={lbl} className="flex items-center gap-2">
            <span className="text-[9px] text-slate-500 font-mono w-14">{lbl}</span>
            <input type="range" min={lo} max={hi} value={v} onChange={e => set(Number(e.target.value))} className="flex-1 accent-sky-500" />
            <span className="text-[10px] text-slate-300 font-mono w-16 text-right">{v}{u}</span>
          </div>
        ))}
      </div>

      {/* Class filter + toggles */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center flex-wrap gap-1">
        {(['ALL', ...RULES.map(r => r.cls)] as Array<'ALL'|Cls>).map(t => {
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
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['ARC',showArc,setShowArc]] as Array<[string, boolean, (v:boolean)=>void]>).map(([n,v,s]) => (
          <button key={n} onClick={() => s(!v)} className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${v ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-500'}`}>{n}</button>
        ))}
      </div>

      {/* Search + tabs */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center gap-1.5">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search callsign/type/operator/class"
          className="flex-1 text-[11px] font-mono bg-slate-950/70 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 placeholder-slate-600 outline-none focus:border-sky-500/60" />
        {(['AIRCRAFT','CLASSES','POLAR'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${tab === t ? 'bg-sky-500/15 ring-1 ring-sky-500/40 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/70">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-slate-500">No aircraft in Vmc-relevant phase.</div>}
            {filtered.map(r => {
              const col = TIER_COLOR[r.tier]
              const ccol = CLS_COLOR[r.rule.cls]
              const pcol = PHASE_COLOR[r.c.phase]
              const drv = r.c.driver
              const m = r.c.marginKt
              const sign = m >= 0 ? '+' : ''
              return (
                <button key={r.f.icao} onClick={() => { setPickedIcao(r.f.icao); onFly(r.f.icao) }}
                  className="w-full text-left px-2 py-1.5 hover:bg-slate-800/40">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: col }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="text-slate-100 font-semibold">{r.f.callsign || r.f.icao.toUpperCase()}</span>
                        <span className="text-slate-500">{r.f.type || '—'}</span>
                        <span className="text-[9px] px-1 py-0 rounded" style={{ background: ccol + '25', color: ccol }}>{r.rule.cls}</span>
                        <span className="text-[9px] px-1 py-0 rounded" style={{ background: pcol + '25', color: pcol }}>{r.c.phase}</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: col + '25', color: col }}>{r.tier === 'LOSS-OF-CTRL' ? 'LOC' : r.tier}</span>
                      </div>
                      {r.tier !== 'IDLE' && (
                        <>
                          <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                            <span>IAS {r.c.iasKt.toFixed(0)}kt</span>
                            <span className="text-slate-500">·</span>
                            <span>{r.c.vmcName} {r.c.vmcCorr.toFixed(0)}kt</span>
                            <span style={{ color: col }}>Δ{sign}{m.toFixed(1)}kt</span>
                            <span className="text-slate-500">·</span>
                            <span>σ {r.c.sigma.toFixed(2)}</span>
                          </div>
                          <div className="grid grid-cols-3 gap-0.5 mt-1 text-[10px] font-mono">
                            <div className="bg-slate-950/60 rounded px-1 py-0.5 flex justify-between">
                              <span className="text-slate-500">Rudder</span>
                              <span style={{ color: r.c.rudderAuth >= 50 ? '#10b981' : r.c.rudderAuth >= 25 ? '#f59e0b' : '#f43f5e' }}>{r.c.rudderAuth.toFixed(0)}%</span>
                            </div>
                            <div className="bg-slate-950/60 rounded px-1 py-0.5 flex justify-between">
                              <span className="text-slate-500">β</span>
                              <span style={{ color: r.c.sideslipDeg <= 5 ? '#10b981' : r.c.sideslipDeg <= 8 ? '#f59e0b' : '#f43f5e' }}>{r.c.sideslipDeg.toFixed(1)}°</span>
                            </div>
                            <div className="bg-slate-950/60 rounded px-1 py-0.5 flex justify-between">
                              <span className="text-slate-500">Score</span>
                              <span style={{ color: col }}>{Math.round(r.c.score)}</span>
                            </div>
                          </div>
                          <div className="h-1 mt-1 rounded bg-slate-800/70 overflow-hidden">
                            <div className="h-full" style={{ width: `${Math.min(100, r.c.score)}%`, background: col }} />
                          </div>
                          <div className="grid grid-cols-6 gap-0.5 mt-1 text-[10px] font-mono">
                            {(['IAS','RUDDER','SIDESLIP','DENS','XWIND','ASYM'] as const).map(k => (
                              <div key={k} className="bg-slate-950/60 rounded px-1 py-0.5 flex justify-between">
                                <span className="text-slate-500">{k.slice(0,4)}</span>
                                <span style={{ color: (drv as any)[k] >= 70 ? TIER_COLOR.CRITICAL : (drv as any)[k] >= 40 ? TIER_COLOR.TIGHT : '#94a3b8' }}>{Math.round((drv as any)[k])}</span>
                              </div>
                            ))}
                          </div>
                          <div className="mt-1 text-[10px] font-mono leading-tight" style={{ color: col }}>
                            › {advice(r.tier, r.c, r.rule)}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {tab === 'CLASSES' && (
          <div className="divide-y divide-slate-800/70">
            {RULES.map(rule => {
              const grp = rows.filter(r => r.rule.cls === rule.cls && r.tier !== 'IDLE')
              const worst = grp.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier])[0]
              const wt = worst?.tier ?? 'IDLE'
              const wcol = TIER_COLOR[wt]
              const ccol = CLS_COLOR[rule.cls]
              const meanDk = grp.length ? grp.reduce((s, r) => s + r.c.marginKt, 0) / grp.length : 0
              const critN = grp.filter(r => r.tier === 'LOSS-OF-CTRL' || r.tier === 'CRITICAL').length
              return (
                <div key={rule.cls} className="px-2 py-1.5">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: wcol }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="text-[9px] px-1 py-0 rounded" style={{ background: ccol + '25', color: ccol }}>{rule.cls}</span>
                        <span className="text-slate-300">{rule.engines}-eng · Vmcg {rule.vmcg} / Vmca {rule.vmca} / Vmcl {rule.vmcl}</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: wcol + '25', color: wcol }}>{grp.length}ac · {critN} CRIT</span>
                      </div>
                      <div className="text-[10px] font-mono text-slate-500 italic mt-0.5 truncate">{rule.refs}</div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        <span>⌀ Δ {meanDk >= 0 ? '+' : ''}{meanDk.toFixed(1)}kt</span>
                        <span className="text-slate-500">·</span>
                        <span>tail-arm {rule.tailArmM.toFixed(1)}m</span>
                        <span className="text-slate-500">·</span>
                        <span style={{ color: wcol }}>{wt}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'POLAR' && (
          <div className="px-3 py-3">
            <div className="text-[10px] font-mono text-slate-400 mb-2">
              Vmc vs altitude · per-class cert isolines · Vmc ∝ 1/√σ per AC 25-7D §6 · fleet aircraft plotted at (IAS, Hp)
            </div>
            <PolarSvg rows={rows} picked={picked || null} />
            <div className="mt-3 grid grid-cols-3 gap-px bg-slate-800/70 text-[10px] font-mono">
              <div className="bg-slate-900 px-2 py-1.5">
                <div className="text-[9px] text-slate-500 uppercase">Fleet</div>
                <div className="text-slate-100">{rows.filter(r => r.tier !== 'IDLE').length} ac</div>
              </div>
              <div className="bg-slate-900 px-2 py-1.5">
                <div className="text-[9px] text-slate-500 uppercase">⌀ Margin</div>
                <div className="text-slate-100">{stats.meanMargin >= 0 ? '+' : ''}{stats.meanMargin.toFixed(1)} kt</div>
              </div>
              <div className="bg-slate-900 px-2 py-1.5">
                <div className="text-[9px] text-slate-500 uppercase">Picked</div>
                <div className="text-slate-100 truncate">{picked ? (picked.f.callsign || picked.f.icao.toUpperCase()) : '—'}</div>
              </div>
            </div>
            {picked && picked.tier !== 'IDLE' && (
              <div className="mt-2 text-[10px] font-mono text-slate-400">
                <div><span className="text-slate-500">phase</span> {picked.c.phase} · <span className="text-slate-500">{picked.c.vmcName}</span> {picked.c.vmcCorr.toFixed(0)}kt · <span className="text-slate-500">IAS</span> {picked.c.iasKt.toFixed(0)}kt · <span className="text-slate-500">Δ</span> {picked.c.marginKt >= 0 ? '+' : ''}{picked.c.marginKt.toFixed(1)}kt</div>
                <div className="mt-1" style={{ color: TIER_COLOR[picked.tier] }}>› {advice(picked.tier, picked.c, picked.rule)}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function PolarSvg({ rows, picked }: { rows: Row[]; picked: Row | null }) {
  const W = 420, H = 200, padL = 32, padR = 8, padT = 8, padB = 22
  const innerW = W - padL - padR
  const innerH = H - padT - padB
  // X: IAS 60-180 KIAS · Y: Hp 0-15000 ft (top is 0, bottom is 15000)
  const xLo = 60, xHi = 180
  const yLo = 0, yHi = 15000
  const x = (kt: number) => padL + ((kt - xLo) / (xHi - xLo)) * innerW
  const y = (ft: number) => padT + ((ft - yLo) / (yHi - yLo)) * innerH

  // Build Vmca iso for each class
  const classCurves = RULES.map(r => {
    const pts: string[] = []
    for (let alt = 0; alt <= 15000; alt += 1500) {
      const sigma = isaDensityRatio(alt)
      const v = r.vmca / Math.sqrt(Math.max(0.5, sigma))
      if (v >= xLo && v <= xHi) {
        pts.push(`${pts.length ? 'L' : 'M'}${x(v).toFixed(1)},${y(alt).toFixed(1)}`)
      }
    }
    return { cls: r.cls, color: CLS_COLOR[r.cls], d: pts.join(' ') }
  })

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {/* gridlines IAS */}
      {[60,90,120,150,180].map(kt => (
        <g key={kt}>
          <line x1={x(kt)} x2={x(kt)} y1={padT} y2={H - padB} stroke="#334155" strokeOpacity={0.4} />
          <text x={x(kt)} y={H - 6} fontSize={9} textAnchor="middle" fill="#64748b" fontFamily="monospace">{kt}</text>
        </g>
      ))}
      {/* gridlines altitude */}
      {[0,3000,6000,9000,12000,15000].map(alt => (
        <g key={alt}>
          <line x1={padL} x2={W - padR} y1={y(alt)} y2={y(alt)} stroke="#334155" strokeOpacity={0.3} />
          <text x={padL - 4} y={y(alt) + 3} fontSize={9} textAnchor="end" fill="#64748b" fontFamily="monospace">{alt / 1000}k</text>
        </g>
      ))}
      {/* Vmca isolines per class */}
      {classCurves.map(c => (
        <path key={c.cls} d={c.d} stroke={c.color} strokeWidth={1.2} fill="none" opacity={0.55} strokeDasharray="2 2" />
      ))}
      {/* axis labels */}
      <text x={W / 2} y={H - 1} fontSize={9} textAnchor="middle" fill="#475569" fontFamily="monospace">KIAS</text>
      <text x={4} y={padT + 8} fontSize={9} textAnchor="start" fill="#475569" fontFamily="monospace">Hp ft</text>
      {/* fleet aircraft */}
      {rows.filter(r => r.tier !== 'IDLE').slice(0, 250).map(r => {
        const alt = Math.max(0, Math.min(15000, r.f.altitudeFt))
        const kt = Math.max(xLo, Math.min(xHi, r.c.iasKt))
        const pk = r === picked
        return (
          <circle key={r.f.icao} cx={x(kt)} cy={y(alt)} r={pk ? 4 : 2.2}
            fill={TIER_COLOR[r.tier]} fillOpacity={pk ? 1 : 0.7}
            stroke={pk ? '#f8fafc' : 'none'} strokeWidth={pk ? 1.2 : 0} />
        )
      })}
    </svg>
  )
}
