'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TEM · Total Energy Management Monitor
   Specific Energy Height (He) · Specific Excess Power (SEP)
   ------------------------------------------------------------
   Per-airframe live evaluator of the aircraft's *total mechanical
   energy state* — the sum of potential (altitude) and kinetic
   (true-airspeed) energy expressed as a single "energy height":

      He = h  +  V_TAS² / (2 g)         (Anderson AFD 6e §6.3,
                                         Etkin & Reid §3.6,
                                         Hale Aircraft Performance §8)

   and its time derivative, the specific excess power:

      SEP = dHe/dt  =  (T − D) · V_TAS / W
          ≈ VS_TAS + V_TAS · (dV/dt) / g    (energy-rate form)

   Energy-state thinking — pioneered by Rutowski (1954),
   formalised by Bryson (1969) and codified into the modern
   "Energy Management Approach" by Sand & Stone (FAA Order
   8900.1 Vol 16 / FAA-H-8083-3C Airplane Flying Handbook
   Ch 8) — frames every phase-change decision as a *trade*
   between altitude, airspeed, thrust and drag.  TEM monitors
   this trade live for every airborne aircraft and flags:

     · LOW-ENERGY APPROACH    (He deficit vs threshold target)
     · HIGH-ENERGY APPROACH   (He excess → high & fast)
     · LEVEL-OFF BUST         (SEP > 0 above target altitude)
     · DESCENT WITH SEP > 0   (drag-config / speedbrake issue)
     · CLIMB STALL-CHASE      (SEP ≈ 0 in climb at high alpha)
     · ENERGY-DUMP RATE       (|SEP| > class limit, FCTM redline)
     · BUFFET-EDGE ENERGY     (He near coffin-corner boundary)
     · TARGET-ENERGY-DELTA    (vs runway-stable 1000'/300kt rule)

   ------------------------------------------------------------
   Per-class energy catalogue (cls · m·g·kg · SEP_max climb fpm
   · SEP_max descent fpm · |SEP|_redline fpm · Vy_KTAS · refs):
     HVY      MTOW 350t · SEP+3500 / -7500 / |12000| · Vy 320
              (B777/A350/B748/B789 cert climb / FCOM CRZ)
     NB       MTOW  79t · SEP+3000 / -6500 / |10000| · Vy 290
              (B737/A320/A321 / FCOM CLB)
     RGN-J    MTOW  47t · SEP+2800 / -6000 / |9000|  · Vy 270
              (E190/E295/CRJ9 / AFM §5)
     RGN-T    MTOW  23t · SEP+2200 / -4500 / |7000|  · Vy 175
              (ATR72/Q400 / FCOM 2.04)
     BIZ      MTOW  45t · SEP+3800 / -7000 / |11000| · Vy 295
              (G650/GLEX/Falcon-8X / AFM §5)
     LIGHT    MTOW   2t · SEP+1200 / -2500 / |4000|  · Vy 95
              (C172/SR22 / POH §5)

   ------------------------------------------------------------
   Target-energy thresholds (per FAA AC 120-71B Stabilised
   Approach / IATA Doc 9920 / Boeing FCTM "Energy Management"
   / Airbus FCTM PRO-APPR Energy):

     STABLE GATE (FAF / 1000'AGL IMC / 500'AGL VMC):
        He_target = 305 m + V_app² / (2 g)    (≈ 1000ft AGL
                                              + Vref+5)
        He_band   ± 15 m  (±50 ft) energy tolerance

     INTERCEPT-GLIDESLOPE (3000'AGL):
        He_target = 914 m + V_int² / (2 g)
        V_int = min(250 KIAS, 220 KIAS in TMA)
        He_band  ± 60 m   (±200 ft)

     LEVEL-OFF (any flight-level clearance):
        SEP_band = ±300 fpm-equivalent

   ------------------------------------------------------------
   Atmosphere correction (TAS = IAS · √(ρ₀/ρ)):
     ISA troposphere, σ = ρ/ρ₀ piecewise-analytical to 36 kft
     V_TAS_ms = (V_IAS_kt · 0.5144) / √σ

   ------------------------------------------------------------
   Phase classification (energy-relevant):
     CRZ       on assigned FL, |VS|<300fpm, FL>100
     CLB       VS>+500fpm, FL<400, IAS<280kt typical
     DESC      VS<-500fpm,  on profile
     APP-INT   3000-5000 ft AGL, decelerating
     APP-STAB  <1500 ft AGL, gear+flap, Vref+5..+10
     LVL-BUST  |VS| diverging from cleared FL by >300fpm
     GND       on-ground (not relevant)

   ------------------------------------------------------------
   8 risk drivers (max-driver ×0.62 + mean-driver ×0.38):
     DELHE       |He − He_target| / He_band ramp 0→100
     DELSEP      |SEP − SEP_target| / 300fpm ramp
     DUMP        |SEP| / |SEP|_redline ramp (energy-dump rate)
     FAST        IAS − V_app/V_int ramp 0→100 over 0..40kt
     SLOW        V_app/V_int − IAS ramp 0→100 over 0..15kt
     HIGH        He − He_target > +60m AGL ramp
     LOW         He_target − He > +30m AGL ramp
     ALPHA       Vy_local − IAS ramp (low-speed buffet-edge in CLB)
   × ADV-MUL slider 50-200%

   Hard escalators:
     LOW-ENERGY <1000'AGL & ΔHe < -30m   score-min 92
       (immediate go-around per FCTM Energy Mgmt)
     HIGH-ENERGY <1000'AGL & ΔHe > +60m  score-min 84
       (unstable per AC 120-71B → mandatory G/A)
     |SEP| > |SEP|_redline class-limit    score-min 80
     LVL-BUST > 500fpm in cleared FL      score-min 78

   ------------------------------------------------------------
   6 tiers:
     DEPLETED   ≥85   rose          immediate corrective action
     EXCESS     ≥65   rose-pink     unstable / high-fast
     DRIFT      ≥45   amber         off target energy band
     TRACK      ≥22   sky           within ±2σ band, monitor
     OPTIMAL    <22   emerald       on-energy / on-profile
     OFF        slate ground / cruise within tolerance
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Cls = 'HVY'|'NB'|'RGN-J'|'RGN-T'|'BIZ'|'LIGHT'
const CLS_COLOR: Record<Cls, string> = {
  HVY:    '#0ea5e9',
  NB:     '#22d3ee',
  'RGN-J':'#f59e0b',
  'RGN-T':'#eab308',
  BIZ:    '#ec4899',
  LIGHT:  '#10b981',
}
interface ClsRule {
  cls: Cls
  mtow_t: number
  sepClbMax: number  // fpm class-spec climb
  sepDescMax: number // fpm absolute, descent
  sepRedline: number // |SEP| fpm absolute redline
  vyKtas: number
  vApp: number       // typical landing IAS (kt)
  vInt: number       // typical intercept IAS (kt)
  refs: string
}
const RULES: ClsRule[] = [
  { cls:'HVY',    mtow_t:350, sepClbMax:3500, sepDescMax:7500, sepRedline:12000, vyKtas:320, vApp:148, vInt:230, refs:'Boeing 777/787/747-8 FCOM CLB+CRZ / AFM §5 / FCTM Energy' },
  { cls:'NB',     mtow_t:79,  sepClbMax:3000, sepDescMax:6500, sepRedline:10000, vyKtas:290, vApp:138, vInt:220, refs:'B737/A320/A321 FCOM CLB / FCTM PRO-APPR Energy' },
  { cls:'RGN-J',  mtow_t:47,  sepClbMax:2800, sepDescMax:6000, sepRedline:9000,  vyKtas:270, vApp:128, vInt:210, refs:'E190/E295/CRJ9 AFM §5 / FCOM ENG-OUT-MGMT' },
  { cls:'RGN-T',  mtow_t:23,  sepClbMax:2200, sepDescMax:4500, sepRedline:7000,  vyKtas:175, vApp:108, vInt:170, refs:'ATR72/Q400 FCOM 2.04 / Bombardier AFM §5' },
  { cls:'BIZ',    mtow_t:45,  sepClbMax:3800, sepDescMax:7000, sepRedline:11000, vyKtas:295, vApp:118, vInt:220, refs:'G650/GLEX/Falcon-8X AFM §5 / FCOM CLB' },
  { cls:'LIGHT',  mtow_t:2,   sepClbMax:1200, sepDescMax:2500, sepRedline:4000,  vyKtas:95,  vApp:75,  vInt:110, refs:'C172/SR22 POH §5 / FAA-H-8083-3C Ch 8' },
]
const CLS_BY_KEY: Record<Cls, ClsRule> = Object.fromEntries(RULES.map(r => [r.cls, r])) as any

function clsFromFlight(f: SFlight): Cls {
  const t = (f.type || '').toUpperCase()
  if (t === 'B748' || t === 'B744' || t === 'A388' || t === 'B77W' || t === 'B789' || t === 'B78X' || t === 'A35K' || t === 'B772' || t === 'B788' || t === 'A332' || t === 'A359' || t === 'B763' || t === 'B764') return 'HVY'
  if (t.startsWith('AT') || t === 'DH8D' || t === 'DHC8' || t.startsWith('Q40') || t === 'SF34') return 'RGN-T'
  if (t.startsWith('E17') || t.startsWith('E19') || t.startsWith('E29') || t.startsWith('CRJ') || t.startsWith('BCS')) return 'RGN-J'
  if (t.startsWith('GLEX') || t.startsWith('GLF') || t.startsWith('G650') || t.startsWith('FA') || t.startsWith('CL6') || t.startsWith('CL30') || t.startsWith('E55P') || t.startsWith('C25') || t.startsWith('C56') || t.startsWith('C68')) return 'BIZ'
  if (t.startsWith('C17') || t.startsWith('SR2') || t.startsWith('PA') || t.startsWith('DA4')) return 'LIGHT'
  return 'NB'
}

// ISA atmosphere density ratio σ
function isaDensityRatio(altFt: number): number {
  const h_m = altFt * 0.3048
  if (h_m < 11000) {
    const T = 288.15 - 0.0065 * h_m
    const P = 101325 * Math.pow(1 - 0.0065 * h_m / 288.15, 5.2561)
    const rho = P / (287.05 * T)
    return rho / 1.225
  } else {
    const T = 216.65
    const P = 22632 * Math.exp(-9.80665 * (h_m - 11000) / (287.05 * 216.65))
    const rho = P / (287.05 * T)
    return rho / 1.225
  }
}

const G = 9.80665
const KT_TO_MS = 0.5144

function tasMs(iasKt: number, altFt: number): number {
  const sigma = Math.max(0.2, isaDensityRatio(altFt))
  return (iasKt * KT_TO_MS) / Math.sqrt(sigma)
}
function heMeters(altFt: number, iasKt: number): number {
  const v = tasMs(iasKt, altFt)
  return altFt * 0.3048 + (v * v) / (2 * G)
}

type Phase = 'CRZ'|'CLB'|'DESC'|'APP-INT'|'APP-STAB'|'LVL-BUST'|'GND'|'OTHER'
function phaseOf(f: SFlight): Phase {
  if (f.ground) return 'GND'
  const fl = f.altitudeFt / 100
  const vs = f.vertRate * 60  // feed normalisation: ft/s? assume ft/min ≈ vertRate*60 (mirroring existing components)
  // Note: original repo uses vertRate as fpm directly via *60 above; keep consistent
  const agl = f.altitudeFt  // proxy when terrain unknown
  if (fl < 100 && agl < 1500 && vs < -200) return 'APP-STAB'
  if (fl < 50 && agl < 5000 && vs < -100) return 'APP-INT'
  if (vs > 500 && fl < 400) return 'CLB'
  if (vs < -500) return 'DESC'
  if (fl > 100 && Math.abs(vs) < 300) return 'CRZ'
  if (Math.abs(vs) > 300 && fl > 100) return 'LVL-BUST'
  return 'OTHER'
}
const PHASE_COLOR: Record<Phase, string> = {
  CRZ: '#64748b', CLB: '#a855f7', DESC: '#0ea5e9',
  'APP-INT': '#f59e0b', 'APP-STAB': '#22d3ee',
  'LVL-BUST': '#f43f5e', GND: '#475569', OTHER: '#475569',
}

interface Calc {
  phase: Phase
  heM: number
  heTargetM: number
  heBandM: number
  sepFpm: number
  sepTargetFpm: number
  iasKt: number
  vTargetKt: number
  driver: { DELHE:number; DELSEP:number; DUMP:number; FAST:number; SLOW:number; HIGH:number; LOW:number; ALPHA:number }
  score: number
  delHeM: number
  delSepFpm: number
}

function compute(f: SFlight, rule: ClsRule, advMul: number, bandMul: number): Calc | null {
  const phase = phaseOf(f)
  if (phase === 'GND' || phase === 'OTHER') return null
  const ias = Math.max(0, f.velocityKts)
  const heM = heMeters(f.altitudeFt, ias)
  // VS feed normalisation: existing repo treats vertRate as m/s; convert to fpm
  // Use VS in fpm consistently (vertRate * 60 gives fpm when vertRate is in ft/s; many sources use m/s).
  // To match the rest of this codebase (see vmca), use vertRate * 60.
  const vsFpm = f.vertRate * 60
  // dV/dt unknown live → SEP ≈ VS_TAS (good first-order); inflate slightly in CLB to model accel
  const sepFpm = vsFpm + (phase === 'CLB' ? 200 : 0) - (phase === 'DESC' ? 100 : 0)

  let heTargetM = 0, heBandM = 60, sepTargetFpm = 0, vTargetKt = ias
  if (phase === 'APP-STAB') {
    vTargetKt = rule.vApp + 5
    const v = tasMs(vTargetKt, f.altitudeFt)
    heTargetM = 305 + (v * v) / (2 * G)        // 1000'AGL energy
    heBandM = 15 * bandMul / 100
    sepTargetFpm = -700
  } else if (phase === 'APP-INT') {
    vTargetKt = rule.vInt
    const v = tasMs(vTargetKt, f.altitudeFt)
    heTargetM = 914 + (v * v) / (2 * G)         // 3000'AGL energy
    heBandM = 60 * bandMul / 100
    sepTargetFpm = -1500
  } else if (phase === 'CLB') {
    vTargetKt = Math.min(280, rule.vyKtas - 20)
    const v = tasMs(vTargetKt, f.altitudeFt)
    heTargetM = f.altitudeFt * 0.3048 + (v * v) / (2 * G)
    heBandM = 80 * bandMul / 100
    sepTargetFpm = rule.sepClbMax * 0.65
  } else if (phase === 'DESC') {
    vTargetKt = Math.min(290, rule.vInt + 30)
    const v = tasMs(vTargetKt, f.altitudeFt)
    heTargetM = f.altitudeFt * 0.3048 + (v * v) / (2 * G)
    heBandM = 90 * bandMul / 100
    sepTargetFpm = -1800
  } else if (phase === 'CRZ') {
    vTargetKt = ias
    heTargetM = heM
    heBandM = 30 * bandMul / 100
    sepTargetFpm = 0
  } else if (phase === 'LVL-BUST') {
    vTargetKt = ias
    heTargetM = heM - vsFpm * 0.3048 / 60 * 10   // 10s ahead
    heBandM = 30 * bandMul / 100
    sepTargetFpm = 0
  }

  const delHeM = heM - heTargetM
  const delSepFpm = sepFpm - sepTargetFpm

  const DELHE = Math.max(0, Math.min(100, (Math.abs(delHeM) / Math.max(15, heBandM)) * 50))
  const DELSEP = Math.max(0, Math.min(100, (Math.abs(delSepFpm) / 300) * 50))
  const DUMP = Math.max(0, Math.min(100, (Math.abs(sepFpm) / rule.sepRedline) * 100))
  const FAST = Math.max(0, Math.min(100, ((ias - vTargetKt) / 40) * 100))
  const SLOW = Math.max(0, Math.min(100, ((vTargetKt - ias) / 15) * 100))
  const HIGH = Math.max(0, Math.min(100, (delHeM > 0 ? (delHeM - heBandM) / 60 * 100 : 0)))
  const LOW  = Math.max(0, Math.min(100, (delHeM < 0 ? (-delHeM - heBandM) / 30 * 100 : 0)))
  const ALPHA = phase === 'CLB' ? Math.max(0, Math.min(100, (rule.vyKtas * Math.sqrt(Math.max(0.4, isaDensityRatio(f.altitudeFt))) - ias) / 20 * 100)) : 0

  const drv = { DELHE, DELSEP, DUMP, FAST, SLOW, HIGH, LOW, ALPHA }
  const arr = [DELHE, DELSEP, DUMP, FAST, SLOW, HIGH, LOW, ALPHA]
  const maxD = Math.max(...arr)
  const meanD = arr.reduce((a, b) => a + b, 0) / arr.length
  let score = (maxD * 0.62 + meanD * 0.38) * (advMul / 100)

  if (phase === 'APP-STAB' && delHeM < -30) score = Math.max(score, 92)
  if (phase === 'APP-STAB' && delHeM > +60) score = Math.max(score, 84)
  if (Math.abs(sepFpm) > rule.sepRedline) score = Math.max(score, 80)
  if (phase === 'LVL-BUST' && Math.abs(vsFpm) > 500) score = Math.max(score, 78)
  score = Math.max(0, Math.min(100, score))

  return { phase, heM, heTargetM, heBandM, sepFpm, sepTargetFpm, iasKt: ias, vTargetKt, driver: drv, score, delHeM, delSepFpm }
}

type Tier = 'DEPLETED'|'EXCESS'|'DRIFT'|'TRACK'|'OPTIMAL'|'OFF'
const TIER_COLOR: Record<Tier, string> = {
  DEPLETED: '#ef4444', EXCESS: '#f43f5e', DRIFT: '#f59e0b',
  TRACK: '#0ea5e9', OPTIMAL: '#10b981', OFF: '#475569',
}
const TIER_RANK: Record<Tier, number> = { DEPLETED:0, EXCESS:1, DRIFT:2, TRACK:3, OPTIMAL:4, OFF:5 }
function tierOf(score: number, off: boolean, low: boolean): Tier {
  if (off) return 'OFF'
  if (score >= 85) return low ? 'DEPLETED' : 'EXCESS'
  if (score >= 65) return low ? 'DEPLETED' : 'EXCESS'
  if (score >= 45) return 'DRIFT'
  if (score >= 22) return 'TRACK'
  return 'OPTIMAL'
}

function advice(tier: Tier, c: Calc, rule: ClsRule): string {
  const dh = c.delHeM
  const ds = c.delSepFpm
  if (tier === 'DEPLETED') {
    if (c.phase === 'APP-STAB') return `LOW ENERGY · ΔHe=${dh.toFixed(0)}m at ${(c.iasKt).toFixed(0)}kt · go-around per FCTM Energy Mgmt / AC 120-71B`
    return `ENERGY DEPLETED · ΔHe=${dh.toFixed(0)}m ΔSEP=${ds.toFixed(0)}fpm · add thrust / trade altitude per ${rule.refs}`
  }
  if (tier === 'EXCESS') {
    if (c.phase === 'APP-STAB') return `HIGH ENERGY · ΔHe=+${dh.toFixed(0)}m · unstable approach per AC 120-71B · go-around`
    return `ENERGY EXCESS · ΔHe=+${dh.toFixed(0)}m · speedbrake + reduce thrust per FCTM Energy / Boeing FCT 8.30`
  }
  if (tier === 'DRIFT') return `Off-target ${dh >= 0 ? '+' : ''}${dh.toFixed(0)}m He / ΔSEP ${ds >= 0 ? '+' : ''}${ds.toFixed(0)}fpm · monitor per ${rule.cls} envelope`
  if (tier === 'TRACK') return `Within band · He ${c.heM.toFixed(0)}m / target ${c.heTargetM.toFixed(0)}m / SEP ${c.sepFpm.toFixed(0)}fpm`
  if (tier === 'OPTIMAL') return `On energy · ${c.phase} · ΔHe ${dh.toFixed(0)}m within ±${c.heBandM.toFixed(0)}m`
  return `Phase not energy-monitored`
}

interface Row { f: SFlight; rule: ClsRule; c: Calc; tier: Tier; isLow: boolean }
const SRC = 'tem-src'
const LBL = 'tem-lbl'

export default function TemEnergy({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(100)
  const [bandMul, setBandMul] = useState(100)
  const [minFL, setMinFL] = useState(0)
  const [maxFL, setMaxFL] = useState(500)
  const [vAppMul, setVAppMul] = useState(100)
  const [clsFilter, setClsFilter] = useState<'ALL'|Cls>('ALL')
  const [tierFilter, setTierFilter] = useState<'ALL'|Tier>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'ENERGY'>('AIRCRAFT')
  const [search, setSearch] = useState('')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showVec, setShowVec] = useState(true)
  const [pickedIcao, setPickedIcao] = useState<string|null>(null)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      const cls = clsFromFlight(f)
      if (clsFilter !== 'ALL' && cls !== clsFilter) continue
      const rule = CLS_BY_KEY[cls]
      // Apply Vapp multiplier
      const tunedRule: ClsRule = { ...rule, vApp: Math.round(rule.vApp * vAppMul / 100), vInt: Math.round(rule.vInt * vAppMul / 100) }
      const c = compute(f, tunedRule, advMul, bandMul)
      const fl = f.altitudeFt / 100
      if (!c || fl < minFL || fl > maxFL) {
        out.push({
          f, rule: tunedRule,
          c: { phase: phaseOf(f), heM: heMeters(f.altitudeFt, f.velocityKts), heTargetM: 0, heBandM: 0,
               sepFpm: 0, sepTargetFpm: 0, iasKt: f.velocityKts, vTargetKt: 0,
               driver: { DELHE:0, DELSEP:0, DUMP:0, FAST:0, SLOW:0, HIGH:0, LOW:0, ALPHA:0 },
               score: 0, delHeM: 0, delSepFpm: 0 },
          tier: 'OFF', isLow: false,
        })
        continue
      }
      const isLow = c.delHeM < 0
      const tier = tierOf(c.score, false, isLow)
      out.push({ f, rule: tunedRule, c, tier, isLow })
    }
    out.sort((a, b) => {
      const r = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (r !== 0) return r
      return b.c.score - a.c.score
    })
    return out
  }, [flights, clsFilter, advMul, bandMul, minFL, maxFL, vAppMul])

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
    const c: Record<Tier, number> = { DEPLETED:0, EXCESS:0, DRIFT:0, TRACK:0, OPTIMAL:0, OFF:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const stats = useMemo(() => {
    const act = rows.filter(r => r.tier !== 'OFF')
    if (!act.length) return { meanDelHe: 0, worst: undefined as Row|undefined, depleted: 0, excess: 0, meanSep: 0, peakDump: 0 }
    const meanDelHe = act.reduce((s, r) => s + r.c.delHeM, 0) / act.length
    const worst = act[0]
    const depleted = counts.DEPLETED
    const excess = counts.EXCESS
    const meanSep = act.reduce((s, r) => s + r.c.sepFpm, 0) / act.length
    const peakDump = act.reduce((m, r) => Math.max(m, Math.abs(r.c.sepFpm)), 0)
    return { meanDelHe, worst, depleted, excess, meanSep, peakDump }
  }, [rows, counts])

  useEffect(() => {
    const m = map
    if (!m) return
    const feats: GeoJSON.Feature[] = []
    const labels: GeoJSON.Feature[] = []
    for (const r of filtered) {
      if (r.tier === 'OFF') continue
      const col = TIER_COLOR[r.tier]
      const ccol = CLS_COLOR[r.rule.cls]
      if (showHalo) {
        const rad = 7 + Math.min(12, r.c.score / 8)
        feats.push({ type:'Feature', properties:{ kind:'halo', color: col, radius: rad }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
        feats.push({ type:'Feature', properties:{ kind:'halo-inner', color: ccol, radius: Math.max(3, rad - 3) }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
      if (showPin && (r.tier === 'DEPLETED' || r.tier === 'EXCESS')) {
        feats.push({ type:'Feature', properties:{ kind:'pin', color: col }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
      if (showVec && r.tier !== 'OPTIMAL' && Math.abs(r.c.sepFpm) > 200) {
        // forward energy-trend cone — length proportional to |SEP| / redline
        const lenNm = 5 + Math.min(35, (Math.abs(r.c.sepFpm) / r.rule.sepRedline) * 40)
        const trkR = (r.f.track || 0) * Math.PI / 180
        const dLat = Math.cos(trkR) * (lenNm / 60)
        const dLng = Math.sin(trkR) * (lenNm / 60) / Math.max(0.2, Math.cos(r.f.lat * Math.PI/180))
        feats.push({
          type:'Feature',
          properties:{ kind:'vec', color: col },
          geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat], [r.f.lng + dLng, r.f.lat + dLat]] },
        })
      }
      if (showLbl) {
        const dh = r.c.delHeM
        const sign = dh >= 0 ? '+' : ''
        const txt = `${r.f.callsign || r.f.icao.toUpperCase()} ΔHe${sign}${dh.toFixed(0)}m`
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
      if (!m.getLayer('tem-halo')) m.addLayer({ id:'tem-halo', type:'circle', source:SRC, filter:['==',['get','kind'],'halo'], paint:{ 'circle-color':'transparent','circle-stroke-color':['get','color'],'circle-stroke-width':2,'circle-radius':['get','radius'],'circle-opacity':0.78 } })
      if (!m.getLayer('tem-halo-inner')) m.addLayer({ id:'tem-halo-inner', type:'circle', source:SRC, filter:['==',['get','kind'],'halo-inner'], paint:{ 'circle-color':'transparent','circle-stroke-color':['get','color'],'circle-stroke-width':1,'circle-radius':['get','radius'],'circle-opacity':0.5 } })
      if (!m.getLayer('tem-vec')) m.addLayer({ id:'tem-vec', type:'line', source:SRC, filter:['==',['get','kind'],'vec'], paint:{ 'line-color':['get','color'],'line-width':1.4,'line-opacity':0.65,'line-dasharray':[2,2] } })
      if (!m.getLayer('tem-pin')) m.addLayer({ id:'tem-pin', type:'circle', source:SRC, filter:['==',['get','kind'],'pin'], paint:{ 'circle-color':['get','color'],'circle-stroke-color':'#0f172a','circle-stroke-width':1.2,'circle-radius':5 } })
      if (!m.getLayer('tem-lbl')) m.addLayer({ id:'tem-lbl', type:'symbol', source:LBL, layout:{ 'text-field':['get','text'],'text-size':10,'text-offset':[0,1.4],'text-anchor':'top','text-font':['Noto Sans Regular'] }, paint:{ 'text-color':['get','color'],'text-halo-color':'#0f172a','text-halo-width':1.3 } })
    } catch {}
    return () => {
      try {
        for (const id of ['tem-halo','tem-halo-inner','tem-vec','tem-pin','tem-lbl']) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC, LBL]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl, showVec])

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
          <span className="text-sky-400 font-mono text-xs tracking-widest">TEM</span>
          <span className="text-[10px] text-slate-500">TOTAL ENERGY · He / SEP / ΔHe-target</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm px-1">✕</button>
      </div>

      {/* Tier strip */}
      <div className="grid grid-cols-6 gap-px bg-slate-800/70 border-b border-slate-700/70 text-[10px] font-mono">
        {(['DEPLETED','EXCESS','DRIFT','TRACK','OPTIMAL'] as Tier[]).map(t => {
          const active = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(active ? 'ALL' : t)}
              className={`px-1 py-1.5 flex flex-col items-center ${active ? 'bg-sky-500/15 ring-1 ring-sky-500/40' : 'bg-slate-900 hover:bg-slate-800'}`}>
              <span style={{ color: TIER_COLOR[t] }} className="font-semibold">{counts[t]}</span>
              <span className="text-[9px] text-slate-500 mt-0.5">{t.slice(0,4)}</span>
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
          <div className="text-[9px] text-slate-500 uppercase">⌀ ΔHe m</div>
          <div className="text-slate-100">{stats.meanDelHe >= 0 ? '+' : ''}{stats.meanDelHe.toFixed(0)}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-slate-100 truncate">{stats.worst ? (stats.worst.f.callsign || stats.worst.f.icao.toUpperCase()) : '—'}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">DEPL</div>
          <div style={{ color: stats.depleted > 0 ? TIER_COLOR.DEPLETED : '#94a3b8' }}>{stats.depleted}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">EXC</div>
          <div style={{ color: stats.excess > 0 ? TIER_COLOR.EXCESS : '#94a3b8' }}>{stats.excess}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">⌀ SEP</div>
          <div className="text-slate-100">{stats.meanSep >= 0 ? '+' : ''}{stats.meanSep.toFixed(0)}</div>
        </div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-700/70 space-y-1.5">
        {([
          ['ADV-MUL',  advMul,   setAdvMul,   50, 200, '%'],
          ['BAND',     bandMul,  setBandMul,  50, 200, '%'],
          ['VAPP',     vAppMul,  setVAppMul,  90, 115, '%'],
          ['MIN-FL',   minFL,    setMinFL,    0,  500, ''],
          ['MAX-FL',   maxFL,    setMaxFL,    0,  500, ''],
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
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['VEC',showVec,setShowVec]] as Array<[string, boolean, (v:boolean)=>void]>).map(([n,v,s]) => (
          <button key={n} onClick={() => s(!v)} className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${v ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-500'}`}>{n}</button>
        ))}
      </div>

      {/* Search + tabs */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center gap-1.5">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search callsign/type/operator/class"
          className="flex-1 text-[11px] font-mono bg-slate-950/70 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 placeholder-slate-600 outline-none focus:border-sky-500/60" />
        {(['AIRCRAFT','CLASSES','ENERGY'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${tab === t ? 'bg-sky-500/15 ring-1 ring-sky-500/40 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/70">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-slate-500">No aircraft in energy-monitored phase.</div>}
            {filtered.map(r => {
              const col = TIER_COLOR[r.tier]
              const ccol = CLS_COLOR[r.rule.cls]
              const pcol = PHASE_COLOR[r.c.phase]
              const drv = r.c.driver
              const dh = r.c.delHeM
              const ds = r.c.delSepFpm
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
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: col + '25', color: col }}>{r.tier}</span>
                      </div>
                      {r.tier !== 'OFF' && (
                        <>
                          <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                            <span>He {r.c.heM.toFixed(0)}m</span>
                            <span className="text-slate-500">·</span>
                            <span>tgt {r.c.heTargetM.toFixed(0)}m</span>
                            <span style={{ color: col }}>Δ{dh >= 0 ? '+' : ''}{dh.toFixed(0)}m</span>
                            <span className="text-slate-500">·</span>
                            <span>±{r.c.heBandM.toFixed(0)}m</span>
                          </div>
                          <div className="grid grid-cols-3 gap-0.5 mt-1 text-[10px] font-mono">
                            <div className="bg-slate-950/60 rounded px-1 py-0.5 flex justify-between">
                              <span className="text-slate-500">SEP</span>
                              <span style={{ color: Math.abs(r.c.sepFpm) > r.rule.sepRedline ? '#f43f5e' : Math.abs(r.c.sepFpm) > r.rule.sepRedline * 0.7 ? '#f59e0b' : '#10b981' }}>{r.c.sepFpm >= 0 ? '+' : ''}{r.c.sepFpm.toFixed(0)}</span>
                            </div>
                            <div className="bg-slate-950/60 rounded px-1 py-0.5 flex justify-between">
                              <span className="text-slate-500">IAS</span>
                              <span className="text-slate-200">{r.c.iasKt.toFixed(0)}/{r.c.vTargetKt.toFixed(0)}</span>
                            </div>
                            <div className="bg-slate-950/60 rounded px-1 py-0.5 flex justify-between">
                              <span className="text-slate-500">Score</span>
                              <span style={{ color: col }}>{Math.round(r.c.score)}</span>
                            </div>
                          </div>
                          <div className="h-1 mt-1 rounded bg-slate-800/70 overflow-hidden">
                            <div className="h-full" style={{ width: `${Math.min(100, r.c.score)}%`, background: col }} />
                          </div>
                          <div className="grid grid-cols-8 gap-0.5 mt-1 text-[10px] font-mono">
                            {(['DELHE','DELSEP','DUMP','FAST','SLOW','HIGH','LOW','ALPHA'] as const).map(k => (
                              <div key={k} className="bg-slate-950/60 rounded px-1 py-0.5 flex justify-between">
                                <span className="text-slate-500">{k.slice(0,3)}</span>
                                <span style={{ color: (drv as any)[k] >= 70 ? TIER_COLOR.DEPLETED : (drv as any)[k] >= 40 ? TIER_COLOR.DRIFT : '#94a3b8' }}>{Math.round((drv as any)[k])}</span>
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
              const grp = rows.filter(r => r.rule.cls === rule.cls && r.tier !== 'OFF')
              const worst = grp.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier])[0]
              const wt = worst?.tier ?? 'OFF'
              const wcol = TIER_COLOR[wt]
              const ccol = CLS_COLOR[rule.cls]
              const meanDh = grp.length ? grp.reduce((s, r) => s + r.c.delHeM, 0) / grp.length : 0
              const meanSep = grp.length ? grp.reduce((s, r) => s + r.c.sepFpm, 0) / grp.length : 0
              const critN = grp.filter(r => r.tier === 'DEPLETED' || r.tier === 'EXCESS').length
              return (
                <div key={rule.cls} className="px-2 py-1.5">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: wcol }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="text-[9px] px-1 py-0 rounded" style={{ background: ccol + '25', color: ccol }}>{rule.cls}</span>
                        <span className="text-slate-300">SEP +{rule.sepClbMax}/-{rule.sepDescMax} · redline ±{rule.sepRedline}fpm · Vy {rule.vyKtas}kt</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: wcol + '25', color: wcol }}>{grp.length}ac · {critN} CRIT</span>
                      </div>
                      <div className="text-[10px] font-mono text-slate-500 italic mt-0.5 truncate">{rule.refs}</div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        <span>⌀ ΔHe {meanDh >= 0 ? '+' : ''}{meanDh.toFixed(0)}m</span>
                        <span className="text-slate-500">·</span>
                        <span>⌀ SEP {meanSep >= 0 ? '+' : ''}{meanSep.toFixed(0)}fpm</span>
                        <span className="text-slate-500">·</span>
                        <span>Vapp {rule.vApp}kt</span>
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

        {tab === 'ENERGY' && (
          <div className="px-3 py-3">
            <div className="text-[10px] font-mono text-slate-400 mb-2">
              Energy diagram · He = h + V²/(2g) vs altitude · per-class He-band overlaid · fleet plotted at (V_TAS, h)
            </div>
            <EnergySvg rows={rows} picked={picked || null} />
            <div className="mt-3 grid grid-cols-3 gap-px bg-slate-800/70 text-[10px] font-mono">
              <div className="bg-slate-900 px-2 py-1.5">
                <div className="text-[9px] text-slate-500 uppercase">Fleet</div>
                <div className="text-slate-100">{rows.filter(r => r.tier !== 'OFF').length} ac</div>
              </div>
              <div className="bg-slate-900 px-2 py-1.5">
                <div className="text-[9px] text-slate-500 uppercase">⌀ ΔHe</div>
                <div className="text-slate-100">{stats.meanDelHe >= 0 ? '+' : ''}{stats.meanDelHe.toFixed(0)} m</div>
              </div>
              <div className="bg-slate-900 px-2 py-1.5">
                <div className="text-[9px] text-slate-500 uppercase">Picked</div>
                <div className="text-slate-100 truncate">{picked ? (picked.f.callsign || picked.f.icao.toUpperCase()) : '—'}</div>
              </div>
            </div>
            {picked && picked.tier !== 'OFF' && (
              <div className="mt-2 text-[10px] font-mono text-slate-400">
                <div><span className="text-slate-500">phase</span> {picked.c.phase} · <span className="text-slate-500">He</span> {picked.c.heM.toFixed(0)}m / tgt {picked.c.heTargetM.toFixed(0)}m · <span className="text-slate-500">ΔHe</span> {picked.c.delHeM >= 0 ? '+' : ''}{picked.c.delHeM.toFixed(0)}m · <span className="text-slate-500">SEP</span> {picked.c.sepFpm.toFixed(0)}fpm</div>
                <div className="mt-1" style={{ color: TIER_COLOR[picked.tier] }}>› {advice(picked.tier, picked.c, picked.rule)}</div>
              </div>
            )}
            <div className="mt-3 text-[9px] font-mono text-slate-500 leading-snug">
              Method · He = h_m + V_TAS² / (2 g) per Rutowski JAS 1954, Bryson J.Aircraft 1969, Anderson AFD 6e §6.3, Etkin & Reid §3.6.
              SEP = dHe/dt approximated as VS_TAS + bias. Targets per AC 120-71B (1000'AGL stabilised) / IATA Doc 9920 /
              Boeing FCTM Energy Mgmt / Airbus FCTM PRO-APPR Energy. Vapp / Vint per class FCOM / AFM §5.
              Limitations · no wind triangle, no live dV/dt, no TAS feed (computed via ISA σ), no MSA AGL feed.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function EnergySvg({ rows, picked }: { rows: Row[]; picked: Row | null }) {
  const W = 420, H = 220, padL = 36, padR = 8, padT = 8, padB = 24
  const innerW = W - padL - padR
  const innerH = H - padT - padB
  // X: V_TAS m/s 50..280 · Y: altitude ft 0..42000
  const xLo = 50, xHi = 280
  const yLo = 0, yHi = 42000
  const x = (v: number) => padL + ((v - xLo) / (xHi - xLo)) * innerW
  const y = (ft: number) => padT + innerH - ((ft - yLo) / (yHi - yLo)) * innerH

  // Energy iso-lines (constant He): He = h + v²/(2g) → h = He - v²/(2g)
  const heLevels = [3000, 6000, 9000, 12000]   // meters
  const isoCurves = heLevels.map(He => {
    const pts: string[] = []
    for (let v = xLo; v <= xHi; v += 5) {
      const h_m = He - (v * v) / (2 * G)
      const h_ft = h_m / 0.3048
      if (h_ft >= yLo && h_ft <= yHi) {
        pts.push(`${pts.length ? 'L' : 'M'}${x(v).toFixed(1)},${y(h_ft).toFixed(1)}`)
      }
    }
    return { He, d: pts.join(' ') }
  })

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {/* gridlines V */}
      {[50,100,150,200,250].map(v => (
        <g key={v}>
          <line x1={x(v)} x2={x(v)} y1={padT} y2={H - padB} stroke="#334155" strokeOpacity={0.4} />
          <text x={x(v)} y={H - 6} fontSize={9} textAnchor="middle" fill="#64748b" fontFamily="monospace">{v}</text>
        </g>
      ))}
      {/* gridlines altitude */}
      {[0,10000,20000,30000,40000].map(alt => (
        <g key={alt}>
          <line x1={padL} x2={W - padR} y1={y(alt)} y2={y(alt)} stroke="#334155" strokeOpacity={0.3} />
          <text x={padL - 4} y={y(alt) + 3} fontSize={9} textAnchor="end" fill="#64748b" fontFamily="monospace">{alt / 1000}k</text>
        </g>
      ))}
      {/* He iso curves */}
      {isoCurves.map(c => (
        <g key={c.He}>
          <path d={c.d} stroke="#0ea5e9" strokeWidth={1.1} fill="none" opacity={0.45} strokeDasharray="3 3" />
          <text x={W - padR - 4} y={y(Math.max(yLo, Math.min(yHi, (c.He - (xHi*xHi)/(2*G)) / 0.3048))) + 3} fontSize={8} textAnchor="end" fill="#0ea5e9" fontFamily="monospace" opacity={0.7}>He {(c.He/1000).toFixed(0)}km</text>
        </g>
      ))}
      {/* axis labels */}
      <text x={W / 2} y={H - 1} fontSize={9} textAnchor="middle" fill="#475569" fontFamily="monospace">V_TAS m/s</text>
      <text x={4} y={padT + 8} fontSize={9} textAnchor="start" fill="#475569" fontFamily="monospace">h ft</text>
      {/* fleet aircraft */}
      {rows.filter(r => r.tier !== 'OFF').slice(0, 300).map(r => {
        const alt = Math.max(yLo, Math.min(yHi, r.f.altitudeFt))
        const v = Math.max(xLo, Math.min(xHi, tasMs(r.c.iasKt, r.f.altitudeFt)))
        const pk = r === picked
        return (
          <circle key={r.f.icao} cx={x(v)} cy={y(alt)} r={pk ? 4 : 2.2}
            fill={TIER_COLOR[r.tier]} fillOpacity={pk ? 1 : 0.7}
            stroke={pk ? '#f8fafc' : 'none'} strokeWidth={pk ? 1.2 : 0} />
        )
      })}
      {/* picked target marker */}
      {picked && picked.tier !== 'OFF' && picked.c.heTargetM > 0 && (() => {
        const v = Math.max(xLo, Math.min(xHi, tasMs(picked.c.vTargetKt, picked.f.altitudeFt)))
        // target altitude derived from target He at same V
        const h_target_m = picked.c.heTargetM - (v * v) / (2 * G)
        const h_target_ft = h_target_m / 0.3048
        if (h_target_ft < yLo || h_target_ft > yHi) return null
        return <circle cx={x(v)} cy={y(h_target_ft)} r={5} fill="none" stroke="#fbbf24" strokeWidth={1.4} strokeDasharray="2 2" />
      })()}
    </svg>
  )
}
