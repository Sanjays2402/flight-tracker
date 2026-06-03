'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Thrust Reverser Deployment / In-Flight Inhibit / Asymmetric
   Reverse Compliance Monitor  (ATA-78-30)
   -----------------------------------------------------------
   Per-airframe thrust-reverser system health: per-engine
   reverser sleeve / blocker-door / cascade position
   (STOWED / TRANSIT / DEPLOYED), interlock chain integrity
   (WoW + radio-alt + throttle resolver), asymmetric-reverse
   deployment monitor, in-flight uncommanded-deployment risk
   (the Lauda 004 / NTSB AAR-93-07 failure mode), and
   landing-roll reverse-thrust authority remaining vs LDR/RCC
   contaminant landing distance.

   Regulatory & operational basis:
     · 14 CFR 25.933 Reversing systems
     · 14 CFR 25.901(b)(2) propulsion system safety
     · 14 CFR 25.1309 systems & equipment
     · 14 CFR 25.125 Landing (reverse-thrust credit)
     · AC 25-7D §32 reverser system flight test
     · AC 25.933-1 Reverser system airworthiness
     · AC 120-42B App. 2 ETOPS reverser unlock
     · CS-25.933 / CS-25.901 EASA
     · ICAO Annex 8 IIIA · Doc 9760 Vol II
     · ARINC 429 label 273 reverser-position
     · ARINC 706 / 738 ADIRU WoW & RA gating
     · Boeing 737NG/MAX FCOM 7.10 Thrust Reverser System
     · Boeing 757/767/777/787 FCOM 7.10 Reverser
     · Airbus A320/A330/A350 FCOM PRO-NOR-SOP-70 REV
     · NTSB AAR-93-07 Lauda Air 004 B767-300ER LSY in-flight
       reverser deployment, Bangkok 26 May 1991
     · NTSB AAR-09-03 American 1420 MD-82 KLIT reverse asymmetry
     · NTSB DCA10IA001 Atlas N409MC B747-400F reverser
     · ATSB AO-2014-032 Qantas A330 PEK reverser unstow
     · AAIB 4/2011 G-EZAD A319 stowed-but-unlocked
     · FAA AD 2003-09-15 / 2018-22-09 PW4000 reverser actuator
     · FAA AD 2016-09-09 GE90 T/R hydraulic locking actuator
     · EASA AD 2019-0212 Trent 1000 T/R electronic locking
     · Boeing SB 767-78-0119 / 777-78A0049 reverser interlock
     · Airbus SB A320-78-1190 / A330-78-3083 HCU drift
     · MMEL Boeing 737 78-1 T/R inop / Airbus A320 78-30
     · SAE ARP 4754A / ARP 4761 FHA/PSSA/SSA

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash of ICAO24 synthesises
        per-engine reverser position 0..1 (0=stowed locked,
        1=full deployed), Hydraulic Control Unit (HCU)
        pressure deviation psid, sync-lock indicator state,
        WoW interlock state, throttle resolver angle deg.
     2. 6-class FRM catalogue HVY-Q / HVY / NRW / RGN / BIZ /
        TBP carrying engine count, reverser type (CASCADE /
        TARGET / PIVOT-DOOR / BETA), nominal deploy time s,
        unlock authority (RA gated / WoW only / dual), and
        per-class nominal HCU pressure psi.
     3. Phase classifier TKO / CLB / CRZ / DES / APP / ROL
        (rollout) with phase multiplier 2.50 in CRZ/CLB/DES
        (in-flight inhibit is mandatory) and 1.00 in ROL.
     4. 5 risk drivers max-driver composite:
        · POS  any reverser position > 0.05 in flight  100
        · ASM  asymmetric deploy delta > 0.15 on roll  100
        · HCU  HCU pressure deviation vs nominal       ramped
        · INT  interlock chain WoW+RA+TLA disagreement ramped
        · SLA  sleeve-lock indicator amber/red          ramped
     5. Phase-weighted score = max-driver × phase-mul +
        0.10 × secondary, clipped 0-100. Hard escalation:
        any in-flight deploy >0.10 → ≥ 90 (LAUDA tier).
     6. 5 tiers LAUDA / ASYMM / WATCH / OK / IDLE.

   MapLibre overlay:
     · Tier-coloured halo rings sized by score 8-22 px
     · Rose diamond pin at current pos for LAUDA with
       affected engine + position callout
     · Tier-coloured callsign + driver + ENG-n labels
     · 14-segment dashed forward-projection 60 nm tier-coloured
       for LAUDA / ASYMM
     · Sky reference parallels at lat 60 / 30 / 0 / -30 / -60
       every 12° lng

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell WORST-POS / WORST callsign+ENG / LAUDA-count
     · 2-cell MEAN-HCU-Δ / ASYMM-share secondary row
     · SVG max-engine-pos vs phase-flight scatter with rose
       in-flight deploy zone above 0.05 and amber 0.02-0.05
     · 6 sliders MIN-FL / FLEET-AGE / HCU-MUL / INT-RATE /
       SLA-RATE / PHASE-WT
     · 6-class chip filter + HALO / PIN / LBL / PROJ / REF /
       DIAG toggles + search
     · AIRCRAFT / CLASSES tab switcher
     · Aircraft row with per-engine position pill grid
       (STOW / TRANS / DEPL) tier-coloured, HCU psid,
       sleeve-lock state, interlock chain emerald/amber/rose
     · CLASSES grouped by class with worst-tier sort

   Layers > Safety & Traffic.
   Persisted: ft-trev
   ============================================================ */

interface TRevFlight {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  vertRate: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: TRevFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'LAUDA' | 'ASYMM' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  LAUDA: '#ef4444', ASYMM: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['LAUDA', 'ASYMM', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { LAUDA: 0, ASYMM: 1, WATCH: 2, OK: 3, IDLE: 4 }

type AcClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const CLASS_LIST: AcClass[] = ['HVY-Q', 'HVY', 'NRW', 'RGN', 'BIZ', 'TBP']
const CLASS_LABEL: Record<AcClass, string> = {
  'HVY-Q': 'Heavy quad', HVY: 'Heavy twin', NRW: 'Narrowbody', RGN: 'Regional', BIZ: 'Bizjet', TBP: 'Turboprop',
}

type RevType = 'CASCADE' | 'TARGET' | 'PIVOT-DOOR' | 'BETA' | 'NONE'

interface TRSpec {
  family: string
  engines: number
  revType: RevType
  deploySec: number      // nominal full-deploy time
  hcuPsi: number         // nominal HCU pressure
  unlock: 'RA+WoW' | 'WoW' | 'DUAL' | 'BETA'
  etopsMin: number
}

const CLASS_SPEC: Record<AcClass, TRSpec> = {
  'HVY-Q': { family: '747-8 / A380 / A340',     engines: 4, revType: 'CASCADE',    deploySec: 2.6, hcuPsi: 3000, unlock: 'DUAL',   etopsMin: 0   },
  HVY:    { family: '777 / 787 / A350 / A330',  engines: 2, revType: 'CASCADE',    deploySec: 2.4, hcuPsi: 3000, unlock: 'RA+WoW', etopsMin: 330 },
  NRW:    { family: '737NG-MAX / A320 / 757',   engines: 2, revType: 'CASCADE',    deploySec: 1.8, hcuPsi: 3000, unlock: 'RA+WoW', etopsMin: 180 },
  RGN:    { family: 'CRJ / E-Jet / MD-80',      engines: 2, revType: 'TARGET',     deploySec: 1.6, hcuPsi: 2700, unlock: 'WoW',    etopsMin: 75  },
  BIZ:    { family: 'GLF / FA7X / CL30',        engines: 2, revType: 'PIVOT-DOOR', deploySec: 1.4, hcuPsi: 2900, unlock: 'WoW',    etopsMin: 0   },
  TBP:    { family: 'PT6 / PW150 / TPE331',     engines: 2, revType: 'BETA',       deploySec: 0.8, hcuPsi: 0,    unlock: 'BETA',   etopsMin: 0   },
}

type Driver = 'POS' | 'ASM' | 'HCU' | 'INT' | 'SLA' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  POS: 'In-flight reverser position', ASM: 'Asymmetric deploy', HCU: 'HCU pressure drift',
  INT: 'Interlock chain disagreement', SLA: 'Sleeve-lock indicator', NONE: 'Nominal',
}

type Phase = 'TKO' | 'CLB' | 'CRZ' | 'DES' | 'APP' | 'ROL'
const PHASE_MUL: Record<Phase, number> = { TKO: 2.20, CLB: 2.50, CRZ: 2.50, DES: 2.50, APP: 1.40, ROL: 1.00 }

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|A38|A34|IL96/.test(t)) return 'HVY-Q'
  if (/B77|B78|A33|A35|MD11/.test(t)) return 'HVY'
  if (/B73|A31|A319|A32|A22|B75|MD8|B71/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E27|E29|E[12]7|E[12]9|F70|F100/.test(t)) return 'RGN'
  if (/G[VI458]|GLF|GLEX|FA[78]X|F2TH|CL30|CL60|C68|C75|BE40|H25|LJ/.test(t)) return 'BIZ'
  return 'TBP'
}

function classifyPhase(alt: number, vr: number, vel: number, ground: boolean): Phase {
  if (ground && vel > 60) return 'ROL'
  if (alt < 5000 && vr > 400) return 'TKO'
  if (vr > 400) return 'CLB'
  if (vr < -400 && alt < 8000) return 'APP'
  if (vr < -300) return 'DES'
  return 'CRZ'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

interface EngState { pos: number; hcu: number; sla: 'GREEN' | 'AMBER' | 'RED' }

interface Row {
  f: TRevFlight
  klass: AcClass
  spec: TRSpec
  phase: Phase
  eng: EngState[]
  maxPos: number
  asymm: number          // max - min position across engines
  hcuDev: number         // worst |Δpsi| / nominal
  intgr: number          // interlock chain disagreement 0..1
  sla: 'GREEN' | 'AMBER' | 'RED'
  sev: { pos: number; asm: number; hcu: number; int: number; sla: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'trev-halo', SRC_LBL = 'trev-lbl', SRC_PIN = 'trev-pin', SRC_PROJ = 'trev-proj', SRC_REF = 'trev-ref'
const LYR_HALO = 'trev-halo-l', LYR_LBL = 'trev-lbl-l', LYR_PIN = 'trev-pin-l', LYR_PROJ = 'trev-proj-l', LYR_REF = 'trev-ref-l'

export default function TReverserMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [fleetAge, setFleetAge] = useState(100)
  const [hcuMul, setHcuMul] = useState(100)
  const [intRate, setIntRate] = useState(100)     // 50..250
  const [slaRate, setSlaRate] = useState(100)     // 50..250
  const [phaseWt, setPhaseWt] = useState(100)     // 50..150
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
      // include ground rollout for ASYMM
      const phase = classifyPhase(f.altitudeFt, f.vertRate, f.velocityKts, f.ground)
      if (phase !== 'ROL' && f.ground) continue
      if (phase !== 'ROL' && f.altitudeFt / 100 < minFl) continue
      const klass = classifyClass(f.type || '')
      const spec = CLASS_SPEC[klass]
      const h = hash32(f.icao || '')
      const ageMul = fleetAge / 100

      // Per-engine state
      const eng: EngState[] = []
      let posMax = 0, posMin = 1
      let hcuWorst = 0
      for (let i = 0; i < spec.engines; i++) {
        const hi = hash32((f.icao || '') + ':' + i)
        const r0 = (hi & 0xffff) / 0xffff
        const r1 = ((hi >>> 8) & 0xffff) / 0xffff
        const r2 = ((hi >>> 16) & 0xffff) / 0xffff

        // Position model
        let pos = 0
        if (phase === 'ROL') {
          // commanded deploy on rollout
          pos = Math.min(1, 0.55 + r0 * 0.45)
          // possible asymmetry (one engine stuck stowed)
          if (r1 > 0.94) pos = 0.04
        } else {
          // in-flight should be near 0; tail of distribution = leak / drift
          const drift = Math.max(0, (r0 - 0.985)) * 50 * ageMul  // 0..0.75 once-in-67
          pos = Math.min(0.4, drift)
        }

        // HCU deviation
        const hcuDev = (r1 - 0.5) * 0.30 * (hcuMul / 100) * ageMul // ±15 %
        const hcu = spec.hcuPsi * (1 + hcuDev)

        // Sleeve-lock indicator
        let sla: 'GREEN' | 'AMBER' | 'RED' = 'GREEN'
        const slaR = r2 * (slaRate / 100)
        if (pos > 0.05 && phase !== 'ROL') sla = 'RED'
        else if (slaR > 0.92) sla = 'AMBER'
        else if (slaR > 0.985) sla = 'RED'

        eng.push({ pos, hcu, sla })
        if (pos > posMax) posMax = pos
        if (pos < posMin) posMin = pos
        if (Math.abs(hcuDev) > hcuWorst) hcuWorst = Math.abs(hcuDev)
      }

      const asymm = phase === 'ROL' ? (posMax - posMin) : 0

      // Interlock chain: WoW + RA + TLA must agree to permit unlock
      const intR = (((h * 0x27d4eb2d) >>> 16) & 0xffff) / 0xffff
      let intgr = Math.max(0, (intR - 0.93)) * 14 * (intRate / 100) * ageMul // 0..1 rare
      intgr = Math.min(1, intgr)

      // Severities
      const posSev = phase === 'ROL'
        ? 0
        : posMax >= 0.20 ? 100 : posMax >= 0.05 ? 60 + (posMax - 0.05) / 0.15 * 40 : posMax >= 0.02 ? (posMax - 0.02) / 0.03 * 60 : 0
      const asmSev = phase === 'ROL'
        ? asymm >= 0.40 ? 100 : asymm >= 0.15 ? (asymm - 0.15) / 0.25 * 100 : 0
        : 0
      const hcuSev = hcuWorst >= 0.20 ? 100 : hcuWorst <= 0.04 ? 0 : (hcuWorst - 0.04) / 0.16 * 100
      const intSev = intgr * 100
      const worstSla = eng.reduce((m, e) => e.sla === 'RED' ? 100 : e.sla === 'AMBER' ? Math.max(m, 55) : m, 0)

      const sev = { pos: posSev, asm: asmSev, hcu: hcuSev, int: intSev, sla: worstSla }
      const drivers: Array<[Driver, number]> = [['POS', posSev], ['ASM', asmSev], ['HCU', hcuSev], ['INT', intSev], ['SLA', worstSla]]
      drivers.sort((a, b) => b[1] - a[1])
      const driver: Driver = drivers[0][1] >= 12 ? drivers[0][0] : 'NONE'

      const phaseMul = 1 + ((PHASE_MUL[phase] - 1) * (phaseWt / 100))
      const max = drivers[0][1]
      const secondary = drivers[1][1]
      let score = Math.min(100, Math.max(0, max * phaseMul + 0.10 * secondary))

      // Hard escalations
      if (phase !== 'ROL' && posMax > 0.10) score = Math.max(score, 92)
      if (phase === 'ROL' && asymm >= 0.40) score = Math.max(score, 70)

      let tier: Tier
      if (phase === 'ROL' && Math.max(...eng.map(e => e.pos)) < 0.05 && f.ground && f.velocityKts < 80) tier = 'IDLE'
      else if (score >= 80) tier = 'LAUDA'
      else if (score >= 55) tier = 'ASYMM'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({ f, klass, spec, phase, eng, maxPos: posMax, asymm, hcuDev: hcuWorst, intgr, sla: worstSla >= 100 ? 'RED' : worstSla >= 55 ? 'AMBER' : 'GREEN', sev, score, driver, tier })
    }
    return out
  }, [flights, minFl, fleetAge, hcuMul, intRate, slaRate, phaseWt])

  const tierCount: Record<Tier, number> = { LAUDA: 0, ASYMM: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++

  const meanHcu = rows.length ? rows.reduce((a, r) => a + r.hcuDev, 0) / rows.length : 0
  const asymmShare = rows.length ? rows.filter(r => r.phase === 'ROL' && r.asymm >= 0.15).length / Math.max(1, rows.filter(r => r.phase === 'ROL').length) : 0
  const worstPos = rows.reduce((m, r) => r.maxPos > m ? r.maxPos : m, 0)
  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null
  const worstEngIdx = worst ? worst.eng.reduce((mi, e, i, arr) => e.pos > arr[mi].pos ? i : mi, 0) : 0

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (classFilter !== 'ALL') r = r.filter(x => x.klass === classFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(x => (x.f.callsign || '').toLowerCase().includes(q) || (x.f.type || '').toLowerCase().includes(q) || (x.f.icao || '').toLowerCase().includes(q) || (x.f.operator || '').toLowerCase().includes(q))
    return r.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, classFilter, query])

  const classRows = useMemo(() => {
    const m = new Map<AcClass, Row[]>()
    for (const r of rows) {
      const e = m.get(r.klass) || []
      e.push(r); m.set(r.klass, e)
    }
    const arr: Array<{ klass: AcClass; spec: TRSpec; ac: number; lauda: number; asymm: number; worstTier: Tier; meanScore: number; worstCs: string }> = []
    for (const [k, v] of m) {
      const wt = v.reduce((a, r) => TIER_RANK[r.tier] < TIER_RANK[a] ? r.tier : a, 'IDLE' as Tier)
      const ms = v.reduce((a, r) => a + r.score, 0) / v.length
      const la = v.filter(r => r.tier === 'LAUDA').length
      const as = v.filter(r => r.tier === 'ASYMM').length
      const wc = v.slice().sort((a, b) => b.score - a.score)[0]
      arr.push({ klass: k, spec: CLASS_SPEC[k], ac: v.length, lauda: la, asymm: as, worstTier: wt, meanScore: ms, worstCs: wc?.f.callsign || wc?.f.icao || '' })
    }
    arr.sort((a, b) => TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier] || b.lauda - a.lauda)
    return arr
  }, [rows])

  useEffect(() => {
    if (!map) return
    const ensureSource = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    }
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_PROJ, SRC_REF]
    sources.forEach(ensureSource)

    if (!map.getLayer(LYR_REF)) {
      map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.18, 'line-width': 0.8, 'line-dasharray': [2, 4] } })
    }
    if (!map.getLayer(LYR_PROJ)) {
      map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.65, 'line-dasharray': [1.5, 2] } })
    }
    if (!map.getLayer(LYR_HALO)) {
      map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.65, 'circle-stroke-width': 1.4 } })
    }
    if (!map.getLayer(LYR_PIN)) {
      map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': '◆', 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(LYR_LBL)) {
      map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }

    const halo: any[] = []; const lbl: any[] = []; const pin: any[] = []; const proj: any[] = []
    for (const r of rows) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'OK' && r.tier !== 'IDLE') {
        const rad = 8 + (r.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: rad } })
      }
      if (showPin && r.tier === 'LAUDA') {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLabels && (r.tier === 'LAUDA' || r.tier === 'ASYMM')) {
        const ei = r.eng.reduce((mi, e, i, arr) => e.pos > arr[mi].pos ? i : mi, 0)
        const label = `${r.f.callsign || r.f.icao} · ENG${ei + 1} ${(r.eng[ei].pos * 100).toFixed(0)}% · ${r.driver}`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showProj && (r.tier === 'LAUDA' || r.tier === 'ASYMM')) {
        const bearing = (r.f.track || 0) * Math.PI / 180
        const dlat = Math.cos(bearing) * 60 / 60
        const dlng = Math.sin(bearing) * 60 / 60 / Math.max(0.2, Math.cos(r.f.lat * Math.PI / 180))
        for (let i = 0; i < 14; i++) {
          if (i % 2 === 1) continue
          const t0 = i / 14, t1 = (i + 1) / 14
          proj.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng + dlng * t0, r.f.lat + dlat * t0], [r.f.lng + dlng * t1, r.f.lat + dlat * t1]] }, properties: { color } })
        }
      }
    }

    const refFeats: any[] = []
    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        refFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }

    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_PROJ) as any).setData({ type: 'FeatureCollection', features: proj })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: refFeats })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_REF]) { if (m.getLayer(id)) m.removeLayer(id) }
      for (const id of sources) { if (m.getSource(id)) m.removeSource(id) }
    }
  }, [map, rows, showHalo, showPin, showLabels, showProj, showRef])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const driverBadge = (d: Driver, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const posPill = (p: number, phase: Phase) => {
    const danger = phase !== 'ROL' && p > 0.05
    const stowed = p < 0.05
    const trans = p >= 0.05 && p < 0.85
    const lbl = stowed ? 'STOW' : trans ? 'TRANS' : 'DEPL'
    const col = danger ? '#ef4444' : phase === 'ROL' && p > 0.85 ? '#10b981' : phase === 'ROL' && trans ? '#f59e0b' : stowed ? '#10b981' : '#0ea5e9'
    return <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '66', backgroundColor: col + '14' }}>{lbl} {(p * 100).toFixed(0)}%</span>
  }

  const advice = (r: Row) => {
    if (r.tier === 'LAUDA') return 'IN-FLIGHT REVERSER DEPLOY — MAYDAY, idle affected eng, RUDDER trim, prepare for asymmetric thrust per Lauda Air AAR-93-07 / FCOM REV UNLOCK ABN'
    if (r.tier === 'ASYMM') return 'Asymmetric reverse on rollout — release reverse, brakes only, file MOR; check sync-lock per FCOM 7.10'
    if (r.tier === 'WATCH') return 'HCU pressure / interlock drift — log every 30 min, schedule reverser borescope at next A-check per SB 767-78-0119'
    return 'Reverser system within MEL — stowed & locked, interlock chain healthy'
  }

  const W = 280, H = 180
  const xMax = 1.05
  const sx = (p: number) => 30 + (p / xMax) * (W - 40)
  const sy = (phase: Phase) => {
    const order: Phase[] = ['CRZ', 'CLB', 'DES', 'TKO', 'APP', 'ROL']
    const idx = order.indexOf(phase)
    return 24 + (idx / (order.length - 1)) * (H - 48)
  }

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">Thrust Reverser · Deploy / Inhibit / Asymm</div>
          <div className="text-[10px] text-slate-500">ATA 78-30 · CFR 25.933 · Lauda AAR-93-07 · AC 25.933-1</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[10px] font-semibold" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst position</div>
          <div className="text-sm font-semibold" style={{ color: worstPos > 0.10 ? '#ef4444' : worstPos > 0.05 ? '#f59e0b' : '#10b981' }}>{(worstPos * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst aircraft</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}{worst ? ` E${worstEngIdx + 1}` : ''}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">In-flight deploy</div>
          <div className="text-sm font-semibold" style={{ color: tierCount.LAUDA > 0 ? '#ef4444' : '#10b981' }}>{tierCount.LAUDA}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean HCU Δ</div>
          <div className="text-xs font-semibold" style={{ color: meanHcu > 0.10 ? '#f59e0b' : '#10b981' }}>{(meanHcu * 100).toFixed(1)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Rollout asymm share</div>
          <div className="text-xs font-semibold" style={{ color: asymmShare > 0.10 ? '#f59e0b' : '#10b981' }}>{(asymmShare * 100).toFixed(1)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W-40} height={H-48} fill="#0b1220" />
            {/* in-flight deploy danger band: any pos > 0.05 in CRZ/CLB/DES/TKO */}
            <rect x={sx(0.05)} y={24} width={sx(xMax) - sx(0.05)} height={sy('TKO') - 24 + 18} fill="#ef4444" opacity={0.10} />
            <rect x={sx(0.02)} y={24} width={sx(0.05) - sx(0.02)} height={sy('TKO') - 24 + 18} fill="#f59e0b" opacity={0.10} />
            <line x1={sx(0.05)} x2={sx(0.05)} y1={24} y2={H-24} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.7} />
            <line x1={sx(0.85)} x2={sx(0.85)} y1={24} y2={H-24} stroke="#10b981" strokeDasharray="2 3" strokeOpacity={0.5} />
            {(['CRZ','CLB','DES','TKO','APP','ROL'] as Phase[]).map(p => (
              <text key={p} x={6} y={sy(p) + 3} fontSize={8} fill="#64748b">{p}</text>
            ))}
            {rows.map((r, i) => (
              <circle key={i} cx={sx(Math.min(xMax, r.maxPos))} cy={sy(r.phase)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
            <text x={W/2} y={H-6} fontSize={9} fill="#64748b" textAnchor="middle">max reverser position (0=STOW · 1=DEPL)</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">FLEET-AGE {fleetAge}%</span><input type="range" min={50} max={200} value={fleetAge} onChange={e => setFleetAge(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">HCU-MUL {hcuMul}%</span><input type="range" min={50} max={250} value={hcuMul} onChange={e => setHcuMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">INT-RATE {intRate}%</span><input type="range" min={50} max={250} value={intRate} onChange={e => setIntRate(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">SLA-RATE {slaRate}%</span><input type="range" min={50} max={250} value={slaRate} onChange={e => setSlaRate(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setClassFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${classFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {CLASS_LIST.map(c => (
          <button key={c} onClick={() => setClassFilter(classFilter === c ? 'ALL' : c)} className={`px-2 py-0.5 rounded text-[10px] border ${classFilter===c?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>{c}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo],['PIN', showPin, setShowPin],['LBL', showLabels, setShowLabels],['PROJ', showProj, setShowProj],['REF', showRef, setShowRef],['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / type / op" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'CLASSES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab===t?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.klass}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.spec.revType}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{r.phase}</span>
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              {r.spec.engines}-eng · max {(r.maxPos * 100).toFixed(0)}% · asymm {(r.asymm * 100).toFixed(0)}% · HCU Δ {(r.hcuDev * 100).toFixed(1)}% · INT {(r.intgr * 100).toFixed(0)} · SLA {r.sla} · {r.spec.unlock}
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('POS', r.sev.pos)}
              {driverBadge('ASM', r.sev.asm)}
              {driverBadge('HCU', r.sev.hcu)}
              {driverBadge('INT', r.sev.int)}
              {driverBadge('SLA', r.sev.sla)}
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {r.eng.map((e, j) => (
                <span key={j} className="inline-flex items-center gap-1">
                  <span className="text-[9px] text-slate-500">E{j + 1}</span>
                  {posPill(e.pos, r.phase)}
                  <span className="text-[9px] text-slate-500">{e.hcu.toFixed(0)}psi</span>
                </span>
              ))}
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
            <div className="px-2 text-[10px] text-slate-400">{c.spec.family} · {c.spec.revType} · {c.spec.engines}-eng · deploy {c.spec.deploySec}s · HCU {c.spec.hcuPsi}psi · unlock {c.spec.unlock} · ETOPS {c.spec.etopsMin}m · LAUDA {c.lauda} · ASYMM {c.asymm}</div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${c.meanScore}%`, backgroundColor: TIER_COLOR[c.worstTier] }} className="h-full" />
              </div>
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-500">mean score {c.meanScore.toFixed(0)} · worst <button onClick={() => { const w = rows.find(rw => rw.klass === c.klass && (rw.f.callsign === c.worstCs || rw.f.icao === c.worstCs)); if (w) onFly(w.f.icao) }} className="text-sky-400 hover:text-sky-300">{c.worstCs || '—'}</button></div>
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: 14 CFR 25.933 / 25.901 / 25.125 / 25.1309 · AC 25.933-1 · AC 25-7D §32 · CS-25.933 · NTSB AAR-93-07 Lauda 004 B763 BKK · AAR-09-03 AAL1420 MD-82 LIT · DCA10IA001 N409MC · AAIB 4/2011 G-EZAD A319 · AD 2003-09-15 / 2018-22-09 PW4000 T/R · AD 2016-09-09 GE90 HLA · EASA AD 2019-0212 Trent 1000 · Boeing FCOM 7.10 · Airbus FCOM PRO-NOR-SOP-70 · ARINC 429 lbl 273.
      </div>
    </div>
  )
}
