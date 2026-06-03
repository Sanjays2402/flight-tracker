'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TPIS / BTMS — Tire Pressure Indicating System &
   Brake Temperature Monitoring System & Fuse-Plug Release
   Risk Monitor (ATA-32-45 Wheels & Brakes · ATA-32-41 BTMS)
   ------------------------------------------------------------
   Per-airframe per-wheel tire pressure psi vs FCOM nominal /
   under-inflation flag (<95% nom) / severe-deflation flag
   (<80% nom or zero) / per-brake disc temperature degC /
   fuse-plug release threshold (typ. 177°C / 350°F core, 204°C
   wheel-hub) / brake-cooling-time minutes remaining / RTO
   energy margin MJ vs certified absorption per wheel /
   asymmetric-brake delta / tire-burst precursor index.

   Detects the failure modes that have driven multiple high-
   profile accidents: Concorde AF4590 (CDG, tire burst → wing
   tank rupture), Nigeria 992 DC-9 (tire fire → main gear),
   Mexicana 940 (overheated brake → tire explosion), and the
   long list of fuse-plug deflations and brake-fire diversions
   logged in FAA SDR / EASA OCC datasets.

   Regulatory & operational basis:
     · 14 CFR 25.731 Wheels
     · 14 CFR 25.733 Tires
     · 14 CFR 25.735 Brakes & braking systems
     · 14 CFR 25.109 RTO energy / accelerate-stop
     · 14 CFR 25.125 Landing distance
     · 14 CFR 25.729 Landing gear position & warning
     · 14 CFR 25.1322 Crew alerting (BRK TEMP / TIRE)
     · 14 CFR 25.1309 Systems & equipment
     · 14 CFR 121.97 / 121.703 MOR brake-fire / tire-burst
     · AC 25.735-1 Brakes
     · AC 25.733-1 Tires
     · AC 25-7D §32 brake & tire flight test
     · AC 91-79B runway overrun
     · CS-25.731 / 733 / 735 / 109 / 125 EASA
     · ICAO Annex 6 Pt I 6.1.3 / Annex 8 IIIA-4
     · ICAO Doc 9760 Vol II airworthiness
     · ICAO Doc 9137 Airport Services Manual Pt 9
     · ARINC 429 label 270 wheel-speed / 271 brake-temp
     · ARINC 706 / 738 ADIRU vertical-load Nz cross-ref
     · ARINC 624 OMS BTMS / TPIS BITE
     · Boeing 737NG-MAX FCOM 14.20 BRAKES / 14.30 LDG GEAR
     · Boeing 777 / 787 FCOM 14.20 BRK TEMP MON
     · Airbus A320 / A330 / A350 FCOM DSC-32 BTMU / TPIS
     · Embraer E-Jet FCOM 14.10 wheels & brakes
     · BEA F-BTSC Concorde AF4590 25 Jul 2000 tire burst
     · NTSB DCA10IA049 / DCA13IA060 brake-fire diversions
     · CIAA Mexicana 940 B727 overheat brake / tire explode
     · ATSB AO-2009-005 A320 fuse plug release on rollout
     · AAIB EW/C2008/01/04 G-EUOI A319 brake fire
     · FAA AD 2008-23-08 Goodrich carbon brake heat-shield
     · FAA AD 2017-06-06 Honeywell A350 BTMU drift
     · EASA AD 2019-0214 A320 fuse plug torque
     · Boeing SB 737-32-1521 fuse-plug heat-shield
     · Airbus SB A320-32-1611 TPIS sensor drift
     · MMEL Boeing 737 32-3 BTMS / A320 32-46 TPIS
     · SAE ARP 1493 / ARP 5765 carbon-brake LCF
     · SAE AIR 1739 wheel/tire/brake interface
     · SAE ARP 4754A / ARP 4761 FHA/PSSA/SSA

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash of ICAO24 synthesises
        per-wheel tire psi, per-brake disc °C, asymmetric-
        brake delta, fuse-plug release tail probability.
     2. 6-class catalogue (HVY-Q · HVY · NRW · RGN · BIZ · TBP)
        defines wheel-count, nominal tire psi, brake mass kg,
        cert RTO energy MJ/wheel, fuse-plug release temp °C.
     3. Phase classifier ROLLOUT / TAXI / TKO / FLARE /
        APPROACH / CRUISE. Brake/tire risk is dominated by
        ROLLOUT, TAXI, TKO, FLARE (post-touchdown rollout
        is the worst).
     4. Tire psi distribution per wheel: nominal × (0.85..1.05)
        seeded by hash + age multiplier. Severe-deflation tail
        random at 1% scaled by TIRE-FAULT slider.
     5. Brake temperature model: ground heat-soak proportional
        to (kt² × mass) / brake-mass; cools at 4°C/min during
        TAXI/CRUISE. ROLLOUT seeds 250–600°C depending on
        landing weight + braking effort + ROLLOUT-BIAS slider.
     6. Fuse-plug release: any brake °C ≥ class plugTempC AND
        any tire wheel ≥ 95% nominal psi or severe-deflated.
     7. RTO energy margin: RTO_MJ_estimate = ½ × mass × V² /
        wheelCount × ROLLOUT-MUL; margin = cert_MJ − est_MJ.

   5 risk drivers (max-driver composite):
     · TPR worst tire deflation pct (0 at 100% nom, 100 at ≤80%)
     · TMP worst brake °C vs plug-release (0 at ≤120°C, 100 ≥plug)
     · ASM left-right brake-delta °C  (0 at ≤40°C, 100 at ≥250°C)
     · COL brake-cool minutes remaining vs takeoff (0 at 0, 100 at ≥30)
     · RTO RTO-energy margin vs cert (0 at ≥50% margin, 100 at deficit)
   Phase multiplier ROLLOUT 1.40 / TKO 1.30 / FLARE 1.25 /
   TAXI 1.10 / APPROACH 1.00 / CRUISE 0.85.
   Hard escalations:
     · any fuse-plug release in ROLLOUT      ≥ 92 (CONCORDE tier)
     · brake °C ≥ plugTempC                  ≥ 88
     · RTO energy deficit on TKO             ≥ 85
     · severe-deflation (psi < 80% nom)      ≥ 80

   5 tiers: CONCORDE / FUSE / ASYM / WATCH / OK / IDLE
============================================================ */

type Tier = 'CONCORDE' | 'FUSE' | 'ASYM' | 'WATCH' | 'OK' | 'IDLE'
const TIER_ORDER: Tier[] = ['CONCORDE','FUSE','ASYM','WATCH','OK','IDLE']
const TIER_COLOR: Record<Tier,string> = {
  CONCORDE:'#ef4444', FUSE:'#f97316', ASYM:'#f59e0b',
  WATCH:'#0ea5e9', OK:'#10b981', IDLE:'#64748b',
}

interface TpisFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string | number
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: TpisFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type AcClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const CLASS_LIST: AcClass[] = ['HVY-Q','HVY','NRW','RGN','BIZ','TBP']
const CLASS_LABEL: Record<AcClass,string> = {
  'HVY-Q':'747-8 / A380 / A340', HVY:'777 / 787 / A350', NRW:'737NG-MAX / A320',
  RGN:'CRJ / E-Jet / ATR', BIZ:'GLF / FA7X / CL30', TBP:'PT6 / PW150 / Q400',
}

type Phase = 'ROLLOUT' | 'TKO' | 'TAXI' | 'FLARE' | 'APPROACH' | 'CRUISE'
const PHASE_MUL: Record<Phase,number> = { ROLLOUT:1.40, TKO:1.30, FLARE:1.25, TAXI:1.10, APPROACH:1.00, CRUISE:0.85 }

interface TbSpec {
  family: string
  wheels: number          // total main + nose
  mains: number           // main gear wheels (these carry brakes)
  nomPsi: number          // nominal cold tire pressure psi (mains)
  brakeKg: number         // mass per brake assembly kg
  certRtoMj: number       // certified RTO energy per wheel MJ
  plugTempC: number       // fuse-plug release temp °C
  massKg: number          // typical landing mass kg (used in RTO calc)
}

const CLASS_SPEC: Record<AcClass,TbSpec> = {
  'HVY-Q': { family:'747-8 / A380 / A340', wheels:22, mains:20, nomPsi:215, brakeKg:120, certRtoMj:120, plugTempC:182, massKg:340000 },
  HVY:    { family:'777 / 787 / A350',     wheels:14, mains:12, nomPsi:200, brakeKg:105, certRtoMj:95,  plugTempC:177, massKg:230000 },
  NRW:    { family:'737NG-MAX / A320',     wheels:6,  mains:4,  nomPsi:190, brakeKg:55,  certRtoMj:55,  plugTempC:177, massKg:65000  },
  RGN:    { family:'CRJ / E-Jet / ATR',    wheels:6,  mains:4,  nomPsi:170, brakeKg:40,  certRtoMj:30,  plugTempC:170, massKg:30000  },
  BIZ:    { family:'GLF / FA7X / CL30',    wheels:6,  mains:4,  nomPsi:195, brakeKg:35,  certRtoMj:25,  plugTempC:177, massKg:35000  },
  TBP:    { family:'PT6 / PW150 / Q400',   wheels:6,  mains:4,  nomPsi:120, brakeKg:25,  certRtoMj:14,  plugTempC:165, massKg:25000  },
}

type Driver = 'TPR' | 'TMP' | 'ASM' | 'COL' | 'RTO' | 'NONE'
const DRIVER_LABEL: Record<Driver,string> = {
  TPR:'Tire deflation', TMP:'Brake temp vs plug', ASM:'L/R brake asym',
  COL:'Cooling time short', RTO:'RTO energy deficit', NONE:'Nominal',
}

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|A38|A34|IL96|AN12|AN22|AN124|MD11/.test(t)) return 'HVY-Q'
  if (/B77|B78|A33|A35|B767|MD11/.test(t)) return 'HVY'
  if (/B73|A31|A319|A32|A22|B75|MD8|B71|B71|B72/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E27|E29|E[12]7|E[12]9|F70|F100|AT[47]|RJ85|BAE/.test(t)) return 'RGN'
  if (/G[VI458]|GLF|GLEX|FA[78]X|F2TH|CL30|CL60|C68|C75|BE40|H25|LJ|PC24/.test(t)) return 'BIZ'
  return 'TBP'
}

function classifyPhase(altFt: number, vel: number, vertRate: number, ground: boolean): Phase {
  if (ground) {
    if (vel >= 60) return 'ROLLOUT'
    if (vel >= 30) return 'TKO'
    return 'TAXI'
  }
  if (altFt < 200 && vertRate < -200) return 'FLARE'
  if (altFt < 1500) return 'APPROACH'
  return 'CRUISE'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

interface WheelState { id: string; side: 'L' | 'R' | 'N'; psi: number; nomPsi: number; tempC: number; deflated: boolean; plugRelease: boolean }
interface Row {
  f: TpisFlight; klass: AcClass; spec: TbSpec; phase: Phase
  wheels: WheelState[]
  worstPsiPct: number    // 0..1 (1 = nominal)
  worstTempC: number
  asymC: number          // |meanL − meanR|
  coolMin: number        // minutes remaining until brake usable for next takeoff
  rtoEstMj: number       // estimated RTO energy / wheel
  rtoMarginPct: number   // (cert - est) / cert  (positive = ok)
  fusePlug: boolean
  sev: { tpr: number; tmp: number; asm: number; col: number; rto: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'tpis-halo', SRC_LBL = 'tpis-lbl', SRC_PIN = 'tpis-pin', SRC_PROJ = 'tpis-proj', SRC_REF = 'tpis-ref'
const LYR_HALO = 'tpis-halo-l', LYR_LBL = 'tpis-lbl-l', LYR_PIN = 'tpis-pin-l', LYR_PROJ = 'tpis-proj-l', LYR_REF = 'tpis-ref-l'

export default function TpisBtms({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [fleetAge, setFleetAge] = useState(100)     // 50..200
  const [tireFault, setTireFault] = useState(100)   // 50..250
  const [tempBias, setTempBias] = useState(0)       // -50..+150 °C
  const [rolloutMul, setRolloutMul] = useState(100) // 50..200
  const [rtoMul, setRtoMul] = useState(100)         // 50..200
  const [phaseWt, setPhaseWt] = useState(100)       // 50..150
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (!isFinite(f.altitudeFt)) continue
      if (f.altitudeFt / 100 < minFl) continue
      const klass = classifyClass(f.type || '')
      const spec = CLASS_SPEC[klass]
      const h = hash32(f.icao || '')
      const ageMul = fleetAge / 100

      const phase = classifyPhase(f.altitudeFt, f.velocityKts, f.vertRate, f.ground)

      // Per-wheel synthesis
      const wheels: WheelState[] = []
      const noseCount = spec.wheels - spec.mains
      const halfMain = spec.mains / 2
      for (let i = 0; i < spec.wheels; i++) {
        const hi = hash32((f.icao || '') + ':w:' + i)
        const r0 = (hi & 0xffff) / 0xffff
        const r1 = ((hi >>> 12) & 0xffff) / 0xffff
        const r2 = ((hi >>> 22) & 0xff) / 0xff
        // Side assignment: first noseCount wheels are nose, then alternating L/R for mains
        let side: 'L' | 'R' | 'N'
        if (i < noseCount) side = i === 0 ? 'L' : 'R'
        const isNose = i < noseCount
        if (!isNose) side = (i - noseCount) < halfMain ? 'L' : 'R'
        else side = 'N'
        // Tire psi: nominal centered, age increases scatter
        let psiFrac = 0.95 + r0 * 0.10 + (ageMul - 1) * -0.04
        // Severe deflation tail
        const defThresh = 1 - 0.01 * (tireFault / 100) * ageMul
        const deflated = r1 > defThresh
        if (deflated) psiFrac = 0.30 + r2 * 0.40
        const psi = spec.nomPsi * Math.max(0, psiFrac)

        // Brake temp (nose wheels carry no brake on most types, leave them low)
        let tempC = 25
        if (!isNose) {
          // Base soak: ground motion heats them
          if (phase === 'ROLLOUT') {
            const v = Math.max(60, f.velocityKts)
            const ke = (spec.massKg * v * v * 0.5144 * 0.5144 * 0.5) / spec.mains  // J/wheel
            tempC = 200 + (ke / 1.0e6) * 0.45 * (rolloutMul / 100)
          } else if (phase === 'TKO') {
            tempC = 80 + r2 * 60
          } else if (phase === 'TAXI') {
            tempC = 60 + r2 * 80
          } else if (phase === 'FLARE') {
            tempC = 90 + r2 * 50
          } else if (phase === 'APPROACH') {
            tempC = 35 + r2 * 20
          } else {
            tempC = 18 + r2 * 8  // cold-soak in cruise
          }
          tempC += tempBias + (ageMul - 1) * 25
          // Asymmetric drag if one tire deflated nearby
          if (deflated) tempC += 60
        }
        const plugRelease = !isNose && tempC >= spec.plugTempC
        wheels.push({ id: `${side}${i}`, side, psi, nomPsi: spec.nomPsi, tempC, deflated, plugRelease })
      }

      const mainWheels = wheels.filter(w => w.side !== 'N')
      const worstPsiPct = Math.min(...wheels.map(w => w.psi / w.nomPsi))
      const worstTempC = Math.max(...mainWheels.map(w => w.tempC))
      const leftWheels = mainWheels.filter(w => w.side === 'L')
      const rightWheels = mainWheels.filter(w => w.side === 'R')
      const meanL = leftWheels.length ? leftWheels.reduce((a,b)=>a+b.tempC,0)/leftWheels.length : 0
      const meanR = rightWheels.length ? rightWheels.reduce((a,b)=>a+b.tempC,0)/rightWheels.length : 0
      const asymC = Math.abs(meanL - meanR)

      // Cooling time: if hot, need (T - 100)/4 min to be takeoff-ready (4°C/min)
      const coolMin = Math.max(0, (worstTempC - 100) / 4)

      // RTO energy estimate per wheel at current speed
      const vMs = f.velocityKts * 0.5144
      const rtoEstMj = (spec.massKg * vMs * vMs * 0.5) / spec.mains / 1.0e6 * (rtoMul / 100)
      const rtoMarginPct = (spec.certRtoMj - rtoEstMj) / spec.certRtoMj

      const fusePlug = wheels.some(w => w.plugRelease)

      // Risk drivers 0..100
      const tprSev = worstPsiPct >= 1.0 ? 0 : worstPsiPct <= 0.80 ? 100 : (1 - worstPsiPct) / 0.20 * 100
      const tmpSev = worstTempC <= 120 ? 0 : worstTempC >= spec.plugTempC ? 100 : (worstTempC - 120) / (spec.plugTempC - 120) * 100
      const asmSev = asymC <= 40 ? 0 : asymC >= 250 ? 100 : (asymC - 40) / 210 * 100
      // COL only matters if TAXI/TKO (about to take off)
      const colSev = (phase === 'TAXI' || phase === 'TKO') ? Math.min(100, coolMin / 30 * 100) : 0
      // RTO only matters at TKO (when reject possible)
      const rtoSev = phase === 'TKO' ? (rtoMarginPct >= 0.5 ? 0 : rtoMarginPct <= 0 ? 100 : (0.5 - rtoMarginPct) / 0.5 * 100) : 0

      const sev = { tpr: tprSev, tmp: tmpSev, asm: asmSev, col: colSev, rto: rtoSev }
      const maxDriver = Math.max(tprSev, tmpSev, asmSev, colSev, rtoSev)
      let driver: Driver = 'NONE'
      if (maxDriver === tprSev && tprSev > 0) driver = 'TPR'
      else if (maxDriver === tmpSev && tmpSev > 0) driver = 'TMP'
      else if (maxDriver === asmSev && asmSev > 0) driver = 'ASM'
      else if (maxDriver === colSev && colSev > 0) driver = 'COL'
      else if (maxDriver === rtoSev && rtoSev > 0) driver = 'RTO'

      let score = maxDriver * PHASE_MUL[phase] * (phaseWt / 100)
      // Hard escalations
      if (fusePlug && phase === 'ROLLOUT') score = Math.max(score, 92)
      if (worstTempC >= spec.plugTempC) score = Math.max(score, 88)
      if (phase === 'TKO' && rtoMarginPct < 0) score = Math.max(score, 85)
      if (worstPsiPct <= 0.80) score = Math.max(score, 80)
      score = Math.max(0, Math.min(100, score))

      let tier: Tier = 'IDLE'
      if (phase === 'CRUISE' && f.altitudeFt / 100 > 100) tier = 'IDLE'
      else if (score >= 85 || (fusePlug && phase === 'ROLLOUT')) tier = 'CONCORDE'
      else if (score >= 60 || worstTempC >= spec.plugTempC) tier = 'FUSE'
      else if (score >= 40 || asymC >= 120) tier = 'ASYM'
      else if (score >= 20) tier = 'WATCH'
      else tier = 'OK'

      out.push({ f, klass, spec, phase, wheels, worstPsiPct, worstTempC, asymC, coolMin, rtoEstMj, rtoMarginPct, fusePlug, sev, score, driver, tier })
    }
    return out
  }, [flights, minFl, fleetAge, tireFault, tempBias, rolloutMul, rtoMul, phaseWt])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (classFilter !== 'ALL' && r.klass !== classFilter) return false
      if (q && !(r.f.callsign || '').toLowerCase().includes(q) && !(r.f.icao || '').toLowerCase().includes(q) && !(r.f.type || '').toLowerCase().includes(q) && !(r.f.operator || '').toLowerCase().includes(q)) return false
      return true
    }).sort((a,b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || b.score - a.score)
  }, [rows, tierFilter, classFilter, query])

  const tierCount = useMemo(() => {
    const c: Record<Tier,number> = { CONCORDE:0, FUSE:0, ASYM:0, WATCH:0, OK:0, IDLE:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const worst = rows.slice().sort((a,b) => b.score - a.score)[0]
  const tprShare = rows.length ? rows.filter(r => r.worstPsiPct < 0.95).length / rows.length : 0
  const tmpShare = rows.length ? rows.filter(r => r.worstTempC > 150).length / rows.length : 0
  const asmShare = rows.length ? rows.filter(r => r.asymC >= 80).length / rows.length : 0

  const classRows = useMemo(() => {
    const groups: Record<string, Row[]> = {}
    for (const r of rows) (groups[r.klass] = groups[r.klass] || []).push(r)
    return Object.entries(groups).map(([klass, rs]) => {
      const meanScore = rs.reduce((a,b)=>a+b.score,0) / rs.length
      const meanTemp = rs.reduce((a,b)=>a+b.worstTempC,0) / rs.length
      const concorde = rs.filter(r => r.tier === 'CONCORDE').length
      const fuse = rs.filter(r => r.tier === 'FUSE').length
      const asym = rs.filter(r => r.tier === 'ASYM').length
      const worstTier = TIER_ORDER.find(t => rs.some(r => r.tier === t)) || 'IDLE'
      const worstRow = rs.slice().sort((a,b)=>b.score-a.score)[0]
      return { klass: klass as AcClass, spec: CLASS_SPEC[klass as AcClass], ac: rs.length, meanScore, meanTemp, concorde, fuse, asym, worstTier, worstCs: worstRow?.f.callsign || worstRow?.f.icao }
    }).sort((a,b) => TIER_ORDER.indexOf(a.worstTier) - TIER_ORDER.indexOf(b.worstTier) || b.concorde - a.concorde)
  }, [rows])

  // ----- MapLibre overlay layers -----
  useEffect(() => {
    if (!map) return
    const m = map
    const ensureSrc = (id: string, data: any) => {
      const s = m.getSource(id) as any
      if (s) s.setData(data)
      else m.addSource(id, { type: 'geojson', data })
    }
    const haloFeats: any[] = []
    const lblFeats: any[] = []
    const pinFeats: any[] = []
    const projFeats: any[] = []
    const refFeats: any[] = []
    for (const r of rows) {
      if (r.tier === 'IDLE' || r.tier === 'OK') continue
      const color = TIER_COLOR[r.tier]
      haloFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ color, r: 8 + (r.score / 100) * 14 } })
      if (r.tier === 'CONCORDE' || r.fusePlug) pinFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ color } })
      lblFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{
        label: `${r.f.callsign || r.f.icao} ${r.worstTempC.toFixed(0)}°C ${(r.worstPsiPct*100).toFixed(0)}%${r.fusePlug?' FUSE!':''}`, color,
      }})
      if (r.tier === 'CONCORDE') {
        const segs = 12, dNm = 4
        const coords: [number, number][] = []
        const trkRad = (r.f.track || 0) * Math.PI / 180
        for (let i = 0; i <= segs; i++) {
          const dnm = (i / segs) * dNm
          const dlat = (dnm / 60) * Math.cos(trkRad)
          const dlng = (dnm / 60) * Math.sin(trkRad) / Math.max(0.01, Math.cos(r.f.lat * Math.PI / 180))
          coords.push([r.f.lng + dlng, r.f.lat + dlat])
        }
        projFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates: coords }, properties:{ color } })
      }
    }
    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) {
        const coords: [number,number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        refFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates: coords }, properties:{} })
      }
    }
    ensureSrc(SRC_HALO, { type:'FeatureCollection', features: showHalo ? haloFeats : [] })
    ensureSrc(SRC_PIN, { type:'FeatureCollection', features: showPin ? pinFeats : [] })
    ensureSrc(SRC_LBL, { type:'FeatureCollection', features: showLabels ? lblFeats : [] })
    ensureSrc(SRC_PROJ, { type:'FeatureCollection', features: showProj ? projFeats : [] })
    ensureSrc(SRC_REF, { type:'FeatureCollection', features: refFeats })

    if (!m.getLayer(LYR_HALO)) m.addLayer({ id: LYR_HALO, source: SRC_HALO, type: 'circle', paint: {
      'circle-radius': ['get','r'], 'circle-color': ['get','color'], 'circle-opacity': 0.18,
      'circle-stroke-width': 1.5, 'circle-stroke-color': ['get','color'], 'circle-stroke-opacity': 0.6,
    }})
    if (!m.getLayer(LYR_PIN)) m.addLayer({ id: LYR_PIN, source: SRC_PIN, type: 'circle', paint: {
      'circle-radius': 6, 'circle-color': ['get','color'], 'circle-opacity': 0.9,
      'circle-stroke-width': 1, 'circle-stroke-color': '#0b1220',
    }})
    if (!m.getLayer(LYR_LBL)) m.addLayer({ id: LYR_LBL, source: SRC_LBL, type: 'symbol', layout: {
      'text-field': ['get','label'], 'text-size': 10, 'text-offset': [0, -1.6], 'text-anchor': 'bottom', 'text-allow-overlap': false,
    }, paint: {
      'text-color': ['get','color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.5,
    }})
    if (!m.getLayer(LYR_PROJ)) m.addLayer({ id: LYR_PROJ, source: SRC_PROJ, type: 'line', paint: {
      'line-color': ['get','color'], 'line-width': 1.5, 'line-dasharray': [3, 3], 'line-opacity': 0.7,
    }})
    if (!m.getLayer(LYR_REF)) m.addLayer({ id: LYR_REF, source: SRC_REF, type: 'line', paint: {
      'line-color': '#0ea5e9', 'line-width': 0.5, 'line-dasharray': [2, 4], 'line-opacity': 0.25,
    }})
    return () => {
      for (const l of [LYR_LBL, LYR_HALO, LYR_PIN, LYR_PROJ, LYR_REF]) if (m.getLayer(l)) m.removeLayer(l)
      for (const s of [SRC_LBL, SRC_HALO, SRC_PIN, SRC_PROJ, SRC_REF]) if (m.getSource(s)) m.removeSource(s)
    }
  }, [map, rows, showHalo, showPin, showLabels, showProj, showRef])

  // ----- UI helpers -----
  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const driverBadge = (d: Driver, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const wheelPill = (w: WheelState, spec: TbSpec) => {
    const psiPct = w.psi / w.nomPsi
    const col = w.plugRelease ? '#ef4444' : w.deflated ? '#f97316' : w.tempC >= spec.plugTempC - 30 ? '#f59e0b' : w.tempC >= 120 ? '#0ea5e9' : '#10b981'
    return (
      <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '66', backgroundColor: col + '14' }} title={`${w.id} ${w.psi.toFixed(0)}psi / ${w.nomPsi}psi nom · ${w.tempC.toFixed(0)}°C`}>
        {w.id} {(psiPct * 100).toFixed(0)}%{w.side === 'N' ? '' : ' ' + w.tempC.toFixed(0) + '°'}{w.plugRelease ? '!' : ''}
      </span>
    )
  }

  const advice = (r: Row) => {
    if (r.tier === 'CONCORDE') {
      if (r.fusePlug) return 'FUSE-PLUG RELEASE — brake °C ≥ class plug-release threshold, expect rapid deflation per ATSB AO-2009-005, RTO if before V1, declare emergency clear runway, fire crews per ICAO Doc 9137 Pt 9'
      if (r.worstPsiPct <= 0.80) return 'SEVERE TIRE DEFLATION — possible debris ejection per BEA AF4590 Concorde; abort if before V1, post-flight inspect adjacent tires & wheel-well per AC 25.733-1'
      return 'CONCORDE-tier brakes/tires — multiple hard escalations active, divert nearest, ARFF on standby per AC 91-79B'
    }
    if (r.tier === 'FUSE') return 'Brake at fuse-plug margin — extend cooling before next sector, monitor BTMU per FCOM 14.20, file MOR if release occurred per 14 CFR 121.703'
    if (r.tier === 'ASYM') {
      if (r.asymC >= 120) return 'L/R brake asymmetry ≥ 120°C — possible dragging brake or seized caliper, taxi with caution, request maintenance per Boeing SB 737-32-1521 / Airbus SB A320-32-1611'
      if (r.coolMin > 15) return 'Long brake cooling time — defer next departure ≥ ' + r.coolMin.toFixed(0) + ' min per FCOM brake-energy chart'
      return 'Asym tier — recheck BTMU readings, log every 10 min, schedule TPIS BITE at next A-check'
    }
    if (r.tier === 'WATCH') return 'Single tire psi or brake °C drift — log per ARINC 624 OMS BTMS BITE, no operational impact'
    if (r.tier === 'OK') return 'Tires within nominal psi, brake °C and asymmetry within FCOM limits, RTO margin healthy'
    return 'Idle / cruise — wheel & brake monitoring deferred until descent'
  }

  // SVG diag: brake °C (y) vs tire psi % (x)
  const W = 280, H = 180
  const sx = (psiPct: number) => 30 + Math.min(1, Math.max(0, (psiPct - 0.7) / 0.4)) * (W - 40)
  const sy = (temp: number) => H - 24 - Math.min(1, temp / 300) * (H - 48)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">TPIS · BTMS · Fuse-Plug</div>
          <div className="text-[10px] text-slate-500">ATA 32-45 / 32-41 · CFR 25.731 / .733 / .735 · AC 25.735-1 · ARINC 429 lbl 270/271</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[9px] font-semibold" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Deflated &lt; 95%</div>
          <div className="text-sm font-semibold" style={{ color: tprShare >= 0.20 ? '#ef4444' : tprShare >= 0.08 ? '#f59e0b' : '#10b981' }}>{(tprShare * 100).toFixed(1)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst aircraft</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Concorde</div>
          <div className="text-sm font-semibold" style={{ color: tierCount.CONCORDE > 0 ? '#ef4444' : '#10b981' }}>{tierCount.CONCORDE}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Hot brake (&gt;150°C)</div>
          <div className="text-xs font-semibold" style={{ color: tmpShare >= 0.20 ? '#ef4444' : tmpShare >= 0.08 ? '#f59e0b' : '#10b981' }}>{(tmpShare * 100).toFixed(1)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">L/R asym share</div>
          <div className="text-xs font-semibold" style={{ color: asmShare >= 0.10 ? '#f59e0b' : '#10b981' }}>{(asmShare * 100).toFixed(1)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W - 40} height={H - 48} fill="#0b1220" />
            {/* Danger band: high temp */}
            <rect x={30} y={sy(300)} width={W - 40} height={sy(177) - sy(300)} fill="#ef4444" opacity={0.10} />
            <rect x={30} y={sy(177)} width={W - 40} height={sy(120) - sy(177)} fill="#f59e0b" opacity={0.10} />
            {/* Danger band: low psi */}
            <rect x={sx(0.7)} y={24} width={sx(0.8) - sx(0.7)} height={H - 48} fill="#ef4444" opacity={0.12} />
            <rect x={sx(0.8)} y={24} width={sx(0.95) - sx(0.8)} height={H - 48} fill="#f59e0b" opacity={0.10} />
            <line x1={30} x2={W - 10} y1={sy(177)} y2={sy(177)} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.6} />
            <line x1={sx(0.95)} x2={sx(0.95)} y1={24} y2={H - 24} stroke="#10b981" strokeDasharray="2 3" strokeOpacity={0.5} />
            <line x1={sx(0.80)} x2={sx(0.80)} y1={24} y2={H - 24} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.7} />
            <text x={6} y={sy(180) + 3} fontSize={9} fill="#64748b">177°</text>
            <text x={6} y={sy(0) + 3} fontSize={9} fill="#64748b">0°</text>
            <text x={sx(0.7) - 2} y={H - 8} fontSize={8} fill="#64748b">70%</text>
            <text x={sx(0.95) - 6} y={H - 8} fontSize={8} fill="#64748b">95%</text>
            <text x={sx(1.0) - 8} y={H - 8} fontSize={8} fill="#64748b">100%</text>
            {rows.map((r, i) => (
              <circle key={i} cx={sx(r.worstPsiPct)} cy={sy(r.worstTempC)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.8} />
            ))}
            <text x={W / 2} y={H - 6} fontSize={9} fill="#64748b" textAnchor="middle">tire % nom · worst brake °C</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">FLEET-AGE {fleetAge}%</span><input type="range" min={50} max={200} value={fleetAge} onChange={e => setFleetAge(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">TIRE-FAULT {tireFault}%</span><input type="range" min={50} max={250} value={tireFault} onChange={e => setTireFault(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">TEMP-BIAS {tempBias}°C</span><input type="range" min={-50} max={150} value={tempBias} onChange={e => setTempBias(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">ROLLOUT-MUL {rolloutMul}%</span><input type="range" min={50} max={200} value={rolloutMul} onChange={e => setRolloutMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">RTO-MUL {rtoMul}%</span><input type="range" min={50} max={200} value={rtoMul} onChange={e => setRtoMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col col-span-2"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setClassFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${classFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {CLASS_LIST.map(c => (
          <button key={c} onClick={() => setClassFilter(classFilter === c ? 'ALL' : c)} className={`px-2 py-0.5 rounded text-[10px] border ${classFilter === c ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{c}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['PROJ', showProj, setShowProj], ['REF', showRef, setShowRef], ['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / type / op" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'CLASSES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.klass}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{r.phase}</span>
              {r.fusePlug && <span className="px-1 py-px rounded text-[9px] text-rose-300 border border-rose-500/40 bg-rose-500/10">FUSE!</span>}
              {r.worstPsiPct <= 0.80 && <span className="px-1 py-px rounded text-[9px] text-orange-300 border border-orange-500/40 bg-orange-500/10">DEFL</span>}
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              {r.spec.family} · {r.spec.wheels}w/{r.spec.mains}m · psi-nom {r.spec.nomPsi} · plug {r.spec.plugTempC}°C · worst {r.worstTempC.toFixed(0)}°C · {(r.worstPsiPct * 100).toFixed(0)}% psi · asym {r.asymC.toFixed(0)}°C · cool {r.coolMin.toFixed(0)}min · RTO {(r.rtoMarginPct * 100).toFixed(0)}%
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('TPR', r.sev.tpr)}
              {driverBadge('TMP', r.sev.tmp)}
              {driverBadge('ASM', r.sev.asm)}
              {driverBadge('COL', r.sev.col)}
              {driverBadge('RTO', r.sev.rto)}
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {r.wheels.map((w, j) => <span key={j}>{wheelPill(w, r.spec)}</span>)}
            </div>
            <div className="px-2 pb-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {advice(r)}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No aircraft match the current filters.</div>
        )}

        {tab === 'CLASSES' && classRows.map((c, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[c.worstTier]}` }}>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{c.klass}</span>
              <span className="text-slate-300 truncate">{CLASS_LABEL[c.klass]}</span>
              <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{c.ac} ac</span>
              {tierBadge(c.worstTier)}
            </div>
            <div className="px-2 text-[10px] text-slate-400">{c.spec.family} · {c.spec.wheels}w/{c.spec.mains}m · psi {c.spec.nomPsi} · brake {c.spec.brakeKg}kg · cert {c.spec.certRtoMj}MJ · plug {c.spec.plugTempC}°C · CONCORDE {c.concorde} · FUSE {c.fuse} · ASYM {c.asym}</div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${c.meanScore}%`, backgroundColor: TIER_COLOR[c.worstTier] }} className="h-full" />
              </div>
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-500">mean score {c.meanScore.toFixed(0)} · mean worst-°C {c.meanTemp.toFixed(0)} · worst <button onClick={() => { const w = rows.find(rw => rw.klass === c.klass && (rw.f.callsign === c.worstCs || rw.f.icao === c.worstCs)); if (w) onFly(w.f.icao) }} className="text-sky-400 hover:text-sky-300">{c.worstCs || '—'}</button></div>
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: 14 CFR 25.731 / 25.733 / 25.735 / 25.109 / 25.125 / 25.1309 / 25.1322 · AC 25.733-1 · AC 25.735-1 · AC 25-7D §32 · AC 91-79B · CS-25.731/733/735 · ICAO Annex 6/8 · Doc 9760 Vol II · Doc 9137 Pt 9 · ARINC 429 lbl 270/271 · ARINC 624 OMS BTMS · Boeing FCOM 14.20 BRK TEMP / 14.30 LDG GEAR · Airbus DSC-32 BTMU / TPIS · BEA F-BTSC Concorde AF4590 CDG 2000 · NTSB DCA10IA049 · CIAA Mexicana 940 · ATSB AO-2009-005 A320 fuse plug · AAIB EW/C2008/01/04 A319 brake fire · FAA AD 2008-23-08 · 2017-06-06 · EASA AD 2019-0214 · Boeing SB 737-32-1521 · Airbus SB A320-32-1611 · MMEL B737 32-3 / A320 32-46 · SAE ARP 1493 / 5765 / 4754A / 4761.
      </div>
    </div>
  )
}
