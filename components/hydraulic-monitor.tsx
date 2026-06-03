'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Hydraulic System Redundancy & Loss-of-System Monitor
   -----------------------------------------------------------
   14 CFR 25.1309 / CS-25.1309 system safety + AC 25.1309-1B
   ARP4761 failure-condition severity classification /
   Boeing 777 FCOM 13.20 / 787 FCOM 13.20 LEFT / CENTER / RIGHT
   hydraulic systems / Airbus A320 FCOM DSC-29 GREEN / BLUE /
   YELLOW + PTU power-transfer unit / A350 FCOM DSC-29 GREEN /
   YELLOW + LEHGS local electro-hydraulic / RAT ram-air turbine
   per ARP1605 / FAA InFO 14004 dual-hydraulic loss / NTSB
   AAR-90/06 United 232 DC-10 Sioux City complete hydraulic loss
   / Qantas QF32 A380 Singapore Nov 2010 Green system breached.

   Models per airframe the live status of up to three hydraulic
   systems (LEFT / CENTER / RIGHT or GREEN / BLUE / YELLOW),
   PTU availability, RAT-deployable status, and the set of
   user-facing functions that fail when one or more systems
   are lost (gear extension, normal brakes, nose-wheel steer,
   flap drive, slat drive, primary flight controls, autopilot
   pitch trim, alternate brake accumulator capacity).

   Per-aircraft inference uses FNV-1a 32-bit hash of ICAO24
   plus phase-of-flight + altitude to stably synthesise:
     * pressure psi per system 0..3500 (nominal 3000±150)
     * reservoir quantity pct 0..110
     * pump status engine-driven EDP + electric ACMP + PTU
     * leak-rate gph 0..6 (hashed into 8pct of fleet)
     * RAT armed/extended state (above FL150 if dual loss)

   Risk components composite max-driver 0-100:
     SYS   number of degraded systems (one 35 / two 75 / three 100)
     FCTL  flight-control loss severity (primaries cap > secondaries)
     LDG   landing-gear + normal-brake loss vs phase weight
     LEAK  active leak gph rate vs reservoir capacity time-to-empty
     PHASE phase-weighted gravity (APPR 1.6× / DEP 1.4× / CRZ 0.7×)

   Tier classification:
     EMER   all 3 sys lost OR composite>=80 OR FCTL>=80
            rose — declare MAYDAY, RAT deployed, manual reversion,
            14 CFR 25.671 control-surface jam policy invoked
     DUAL   2 systems degraded OR composite>=55  amber
            single-source flight controls, brief alternate-gear
            extension and accumulator-only brakes (max 6 cycles)
     SNGL   1 system degraded OR composite>=25   sky
            QRH HYDRAULIC LOSS · monitor reservoir + PTU temps
     OK     all healthy                          emerald
     IDLE   on ground / below MIN-FL slider     slate

   Side panel: 5-tier counter strip + 3-cell stats + 2-cell
   secondary + SVG pressure-vs-quantity scatter shaded by tier
   bands + 6 sliders (MIN-FL / LEAK-MUL / RES-FLOOR / PUMP-MUL /
   RAT-FL / FAIL-RATE) + 7-class chip filter + HALO/PIN/LBL/REF/
   DIAG toggles + AIRCRAFT/SYSTEMS tab switcher with worst-tier
   sort and per-row 3-system status pills + breakdown chips +
   click-to-fly.

   Persisted preference: ft-hyd
   ============================================================ */

interface HydFlight {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  category?: number | string
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
  flights: HydFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'EMER' | 'DUAL' | 'SNGL' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  EMER: '#f43f5e',
  DUAL: '#f59e0b',
  SNGL: '#0ea5e9',
  OK:   '#10b981',
  IDLE: '#475569',
}
const TIER_ORDER: Tier[] = ['EMER', 'DUAL', 'SNGL', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { EMER: 0, DUAL: 1, SNGL: 2, OK: 3, IDLE: 4 }
const TIER_LABEL: Record<Tier, string> = {
  EMER: 'EMER · 3-LOSS',
  DUAL: 'DUAL-LOSS',
  SNGL: 'SINGLE-LOSS',
  OK:   'NOMINAL',
  IDLE: 'IDLE',
}
const TIER_ADVICE: Record<Tier, string> = {
  EMER: 'all 3 systems compromised — declare MAYDAY, deploy RAT, manual reversion per UAL232 protocol, alternate-gear + accumulator brakes (6 cycles max), vector to longest dry runway',
  DUAL: 'two systems degraded — single-source flight controls, brief alternate-gear extension, accumulator-only brakes, no autobrake, divert recommended per ARP4761 hazardous-failure threshold',
  SNGL: 'single-system loss — run QRH HYDRAULIC system-X LOSS, verify PTU power transfer, monitor reservoir quantity and pump temps, brief no-autoland',
  OK:   'three-system redundancy intact, pumps and PTU nominal, reservoirs ≥ 80pct, no leaks detected per FCOM 13.20',
  IDLE: 'on ground or below MIN-FL — system monitoring suspended',
}

type Cls = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const CLS_NAME: Record<Cls, string> = {
  HVY: 'Heavy widebody',
  NRW: 'Narrowbody',
  RGN: 'Regional jet',
  BIZ: 'Business jet',
  TBP: 'Turboprop',
  GA:  'GA piston',
  FTR: 'Fighter / military',
}

// Per-class architecture: number of systems, naming, RAT/PTU availability
interface Arch {
  sysCount: 1 | 2 | 3
  names: [string, string?, string?]
  ratFl: number           // FL above which RAT auto-deploys on dual-loss (0 = no RAT)
  ptu: boolean            // power-transfer unit between two main systems
  nomPsi: number
  resGal: number          // reservoir capacity gallons (per system)
  // Function map: which system drives which user-facing function
  // (idx into names; -1 = electric backup; -2 = mechanical reversion)
  fnPrimaryFctl: number   // primary flight controls main hyd
  fnPrimaryFctlBkup: number
  fnGear: number
  fnNormalBrake: number
  fnAltBrake: number      // accumulator backup
  fnNws: number
  fnFlaps: number
  fnAutoland: number      // typically requires all 3
}
const ARCH: Record<Cls, Arch> = {
  HVY: { sysCount: 3, names: ['LEFT', 'CENTER', 'RIGHT'],   ratFl: 0,   ptu: false, nomPsi: 3000, resGal: 18, fnPrimaryFctl: 0, fnPrimaryFctlBkup: 2, fnGear: 1, fnNormalBrake: 1, fnAltBrake: 0, fnNws: 1, fnFlaps: 1, fnAutoland: 1 },
  NRW: { sysCount: 3, names: ['GREEN', 'BLUE', 'YELLOW'],   ratFl: 0,   ptu: true,  nomPsi: 3000, resGal: 8,  fnPrimaryFctl: 0, fnPrimaryFctlBkup: 2, fnGear: 0, fnNormalBrake: 0, fnAltBrake: 2, fnNws: 2, fnFlaps: 0, fnAutoland: 1 },
  RGN: { sysCount: 2, names: ['SYS-1', 'SYS-2'],            ratFl: 0,   ptu: false, nomPsi: 3000, resGal: 4,  fnPrimaryFctl: 0, fnPrimaryFctlBkup: 1, fnGear: 1, fnNormalBrake: 0, fnAltBrake: 1, fnNws: 0, fnFlaps: 0, fnAutoland: 0 },
  BIZ: { sysCount: 2, names: ['SYS-A', 'SYS-B'],            ratFl: 0,   ptu: false, nomPsi: 3000, resGal: 3,  fnPrimaryFctl: 0, fnPrimaryFctlBkup: 1, fnGear: 0, fnNormalBrake: 0, fnAltBrake: 1, fnNws: 0, fnFlaps: 0, fnAutoland: 0 },
  TBP: { sysCount: 1, names: ['MAIN'],                      ratFl: 0,   ptu: false, nomPsi: 2000, resGal: 2,  fnPrimaryFctl: -2, fnPrimaryFctlBkup: -2, fnGear: 0, fnNormalBrake: 0, fnAltBrake: 0, fnNws: 0, fnFlaps: 0, fnAutoland: 0 },
  GA:  { sysCount: 1, names: ['BRAKE'],                     ratFl: 0,   ptu: false, nomPsi: 1500, resGal: 0.5,fnPrimaryFctl: -2, fnPrimaryFctlBkup: -2, fnGear: -2, fnNormalBrake: 0, fnAltBrake: -2, fnNws: -2, fnFlaps: -2, fnAutoland: -2 },
  FTR: { sysCount: 2, names: ['PC-1', 'PC-2'],              ratFl: 100, ptu: false, nomPsi: 3000, resGal: 5,  fnPrimaryFctl: 0, fnPrimaryFctlBkup: 1, fnGear: 0, fnNormalBrake: 0, fnAltBrake: 1, fnNws: 0, fnFlaps: 0, fnAutoland: 0 },
}

interface SysState {
  name: string
  psi: number
  resPct: number
  edpOk: boolean
  acmpOk: boolean
  leakGph: number
  degraded: boolean
}

interface Row {
  f: HydFlight
  cls: Cls
  arch: Arch
  fl: number
  phase: 'TKO' | 'CLB' | 'CRZ' | 'DES' | 'APP'
  sys: SysState[]
  degCount: number
  ptuOk: boolean
  ratExt: boolean
  // function loss flags
  lossFctl: boolean
  lossFctlBkup: boolean
  lossGear: boolean
  lossBrake: boolean
  lossAltBrake: boolean
  lossNws: boolean
  lossFlaps: boolean
  lossAutoland: boolean
  // severities
  sysSev: number
  fctlSev: number
  ldgSev: number
  leakSev: number
  phaseMul: number
  driver: string
  driverLong: string
  score: number
  tier: Tier
}

const DRIVER_LONG: Record<string, string> = {
  SYS:   'Number of degraded hydraulic systems exceeds redundancy budget',
  FCTL:  'Primary flight-control power loss — manual reversion or single-source actuation',
  LDG:   'Landing-gear extension or normal-brake hydraulic loss — alternate-extension required',
  LEAK:  'Active hydraulic leak draining reservoir below FCOM minimum',
  PHASE: 'Phase-of-flight gravity — loss during approach or departure window',
}

// FNV-1a 32-bit -> 0..1
function hashUnit(s: string, salt: string): number {
  let h = 0x811c9dc5
  const x = (salt + '|' + s)
  for (let i = 0; i < x.length; i++) {
    h ^= x.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h % 100000) / 100000
}

function classify(type?: string): Cls {
  const t = (type || '').toUpperCase()
  if (/^(B77|B78|B74|B76|A33|A34|A35|A38|MD11)/.test(t)) return 'HVY'
  if (/^(B73|A31|A32|A22|MD8|MD9)/.test(t)) return 'NRW'
  if (/^(CRJ|E17|E19|E29|AT[47])/.test(t)) return 'RGN'
  if (/^(GLF|GL|FA|F900|F2TH|CL|GLEX|G[56])/.test(t)) return 'BIZ'
  if (/^(DH8|AT4|AT7|BE|PA4|SF34|J32)/.test(t)) return 'TBP'
  if (/^(C1[5678]|SR2|PA28|DA40|DA42|PC12|TBM)/.test(t)) return 'GA'
  if (/^(F1[56]|F18|F22|F35|EUF|MIG|SU[2-3]|T[6-8])/.test(t)) return 'FTR'
  return 'NRW'
}

function inferPhase(altFt: number, vs: number, ground: boolean): Row['phase'] {
  if (ground) return 'TKO'
  if (altFt < 3000 && vs > 500) return 'TKO'
  if (altFt < 18000 && vs > 300) return 'CLB'
  if (altFt < 6000 && vs < -300) return 'APP'
  if (vs < -500) return 'DES'
  return 'CRZ'
}

export default function HydraulicMonitor({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState(0)
  const [leakMul, setLeakMul] = useState(100)     // 50-200
  const [resFloor, setResFloor] = useState(35)    // 10-80 pct
  const [pumpMul, setPumpMul] = useState(100)     // 50-200
  const [ratFlBias, setRatFlBias] = useState(150) // 50-400 ft thousands
  const [failRate, setFailRate] = useState(8)     // 1-30 pct fleet-wide hash-degraded share
  const [tierFilter, setTierFilter] = useState<Set<Tier>>(new Set())
  const [clsFilter, setClsFilter] = useState<Set<Cls>>(new Set())
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT' | 'SYSTEMS'>('AIRCRAFT')

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const leakScale = leakMul / 100
    const pumpScale = pumpMul / 100
    const failProb = failRate / 100
    for (const f of flights) {
      const cls = classify(f.type)
      const arch = ARCH[cls]
      const fl = Math.round(f.altitudeFt / 100)
      const phase = inferPhase(f.altitudeFt, f.vertRate, f.ground)

      // Per-system synthetic state
      const sys: SysState[] = []
      let degCount = 0
      for (let i = 0; i < arch.sysCount; i++) {
        const name = arch.names[i] || `SYS-${i+1}`
        const hPsi = hashUnit(f.icao, 'psi' + i)
        const hRes = hashUnit(f.icao, 'res' + i)
        const hEdp = hashUnit(f.icao, 'edp' + i)
        const hAcmp = hashUnit(f.icao, 'acmp' + i)
        const hLeak = hashUnit(f.icao, 'leak' + i)
        // Degradation flag: ~failProb per system per airframe
        const sysFail = hPsi < failProb
        // Pump failures independent, scaled by pumpMul (higher mul -> fewer failures)
        const edpOk = hEdp > (0.03 / pumpScale)
        const acmpOk = hAcmp > (0.04 / pumpScale)
        // Pressure: nominal 3000 ± 200, drop to <1000 if sysFail
        let psi = arch.nomPsi + (hPsi - 0.5) * 300
        if (sysFail) psi = Math.min(800, psi * 0.25)
        if (!edpOk && !acmpOk) psi = Math.min(psi, 600)
        // Reservoir
        let resPct = 70 + hRes * 35
        if (sysFail) resPct = Math.max(0, resPct - 50)
        // Leak (8pct fleet has detectable leak; scaled by leakMul)
        const leakGph = hLeak < 0.08 ? hLeak * 75 * leakScale : 0
        if (leakGph > 0) resPct = Math.max(0, resPct - leakGph * 4)
        const degraded = sysFail || psi < 2400 || resPct < resFloor || (!edpOk && !acmpOk)
        if (degraded) degCount++
        sys.push({ name, psi, resPct, edpOk, acmpOk, leakGph, degraded })
      }

      // PTU + RAT
      const ptuOk = arch.ptu && hashUnit(f.icao, 'ptu') > 0.05
      const ratExt = arch.ratFl > 0 && fl > (arch.ratFl * (ratFlBias / 100)) && degCount >= 2

      // Function loss inference
      const isLost = (idx: number): boolean => {
        if (idx < 0) return false // electric/mechanical bkup always avail in this model
        if (idx >= arch.sysCount) return false
        return sys[idx].degraded
      }
      const lossFctl = isLost(arch.fnPrimaryFctl) && isLost(arch.fnPrimaryFctlBkup)
      const lossFctlBkup = isLost(arch.fnPrimaryFctlBkup)
      const lossGear = isLost(arch.fnGear)
      const lossBrake = isLost(arch.fnNormalBrake)
      const lossAltBrake = isLost(arch.fnAltBrake)
      const lossNws = isLost(arch.fnNws)
      const lossFlaps = isLost(arch.fnFlaps)
      const lossAutoland = isLost(arch.fnAutoland) || degCount >= 2

      // Severities
      let sysSev: number
      if (degCount === 0) sysSev = 0
      else if (degCount === 1) sysSev = 35
      else if (degCount === 2) sysSev = 75
      else sysSev = 100

      let fctlSev = 0
      if (lossFctl) fctlSev = 100
      else if (lossFctlBkup) fctlSev = 55
      else if (degCount >= 2) fctlSev = 40

      let ldgSev = 0
      if (lossGear) ldgSev = Math.max(ldgSev, 70)
      if (lossBrake && lossAltBrake) ldgSev = Math.max(ldgSev, 90)
      else if (lossBrake) ldgSev = Math.max(ldgSev, 45)
      if (lossNws) ldgSev = Math.max(ldgSev, 30)
      if (lossFlaps) ldgSev = Math.max(ldgSev, 50)

      // Leak severity: time-to-empty
      let leakSev = 0
      for (const s of sys) {
        if (s.leakGph > 0 && s.resPct > 0) {
          const remGal = (s.resPct / 100) * arch.resGal
          const minToEmpty = (remGal / s.leakGph) * 60
          if (minToEmpty < 5) leakSev = Math.max(leakSev, 100)
          else if (minToEmpty < 15) leakSev = Math.max(leakSev, 75)
          else if (minToEmpty < 45) leakSev = Math.max(leakSev, 45)
          else leakSev = Math.max(leakSev, 20)
        }
      }

      // Phase multiplier (intensifies during critical phases)
      const phaseMul = phase === 'APP' ? 1.6 : phase === 'TKO' ? 1.4 : phase === 'CLB' ? 1.2 : phase === 'DES' ? 1.05 : 0.7

      const parts: { name: string; sev: number }[] = [
        { name: 'SYS', sev: sysSev },
        { name: 'FCTL', sev: fctlSev },
        { name: 'LDG', sev: ldgSev * (phase === 'APP' || phase === 'TKO' ? 1.15 : 0.8) },
        { name: 'LEAK', sev: leakSev },
      ]
      parts.sort((a, b) => b.sev - a.sev)
      const baseScore = parts[0].sev
      const score = Math.min(100, Math.max(0, baseScore * (parts[0].name === 'SYS' || parts[0].name === 'FCTL' ? phaseMul : 1)))
      const driver = parts[0].name

      let tier: Tier
      if (f.ground || fl < minFL) tier = 'IDLE'
      else if (degCount >= 3 || score >= 80 || fctlSev >= 80) tier = 'EMER'
      else if (degCount >= 2 || score >= 55) tier = 'DUAL'
      else if (degCount >= 1 || score >= 25) tier = 'SNGL'
      else tier = 'OK'

      out.push({
        f, cls, arch, fl, phase, sys, degCount, ptuOk, ratExt,
        lossFctl, lossFctlBkup, lossGear, lossBrake, lossAltBrake, lossNws, lossFlaps, lossAutoland,
        sysSev, fctlSev, ldgSev, leakSev, phaseMul,
        driver, driverLong: DRIVER_LONG[driver] || driver,
        score, tier,
      })
    }
    return out
  }, [flights, minFL, leakMul, resFloor, pumpMul, ratFlBias, failRate])

  const stats = useMemo(() => {
    const counts: Record<Tier, number> = { EMER: 0, DUAL: 0, SNGL: 0, OK: 0, IDLE: 0 }
    let sumDeg = 0, sumPsi = 0, sysN = 0, ratN = 0, leakN = 0, n = 0
    let worst: Row | null = null
    for (const r of rows) {
      counts[r.tier]++
      if (r.tier === 'IDLE') continue
      sumDeg += r.degCount; n++
      if (r.ratExt) ratN++
      for (const s of r.sys) {
        sumPsi += s.psi; sysN++
        if (s.leakGph > 0) leakN++
      }
      if (!worst || r.score > worst.score) worst = r
    }
    return {
      counts,
      meanDeg: n ? sumDeg / n : 0,
      meanPsi: sysN ? sumPsi / sysN : 0,
      ratShare: n ? ratN / n : 0,
      leakShare: sysN ? leakN / sysN : 0,
      worst,
    }
  }, [rows])

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter.size && !tierFilter.has(r.tier)) return false
      if (clsFilter.size && !clsFilter.has(r.cls)) return false
      if (q) {
        const blob = `${r.f.callsign || ''} ${r.f.type || ''} ${r.f.operator || ''}`.toUpperCase()
        if (!blob.includes(q)) return false
      }
      return true
    }).sort((a, b) => {
      const r = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (r) return r
      return b.score - a.score
    })
  }, [rows, tierFilter, clsFilter, search])

  // SYSTEMS tab: group by system-name across all aircraft (per class)
  const systems = useMemo(() => {
    type Grp = { key: string; cls: Cls; name: string; rs: Row[]; degCount: number; meanPsi: number; worstTier: Tier; worst: Row }
    const map: Record<string, { cls: Cls; name: string; rs: Row[]; sysIdx: number }> = {}
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      for (let i = 0; i < r.sys.length; i++) {
        const key = `${r.cls}-${r.sys[i].name}`
        if (!map[key]) map[key] = { cls: r.cls, name: r.sys[i].name, rs: [], sysIdx: i }
        map[key].rs.push(r)
      }
    }
    const out: Grp[] = Object.entries(map).map(([key, g]) => {
      const worstTier = g.rs.reduce<Tier>((a, b) => TIER_RANK[b.tier] < TIER_RANK[a] ? b.tier : a, 'OK')
      let degCount = 0, sumPsi = 0
      for (const r of g.rs) {
        if (r.sys[g.sysIdx].degraded) degCount++
        sumPsi += r.sys[g.sysIdx].psi
      }
      const worst = g.rs.reduce((a, b) => b.score > a.score ? b : a)
      return { key, cls: g.cls, name: g.name, rs: g.rs, degCount, meanPsi: sumPsi / g.rs.length, worstTier, worst }
    })
    return out.sort((a, b) => {
      const r = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
      if (r) return r
      return b.degCount - a.degCount
    })
  }, [rows])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const SRC = 'ft-hyd-src'
    const HALO = 'ft-hyd-halo'
    const PIN = 'ft-hyd-pin'
    const LBL = 'ft-hyd-lbl'
    const REF_SRC = 'ft-hyd-ref-src'
    const REF_LYR = 'ft-hyd-ref-lyr'

    const features: GeoJSON.Feature[] = []
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      if (tierFilter.size && !tierFilter.has(r.tier)) continue
      if (clsFilter.size && !clsFilter.has(r.cls)) continue
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
        properties: {
          tier: r.tier,
          color: TIER_COLOR[r.tier],
          radius: 8 + (r.score / 100) * 14,
          label: `${r.f.callsign || r.f.icao} · ${r.driver} · ${r.degCount}/${r.arch.sysCount}${r.ratExt ? ' · RAT' : ''}`,
          isEmer: r.tier === 'EMER' ? 1 : 0,
        },
      })
    }
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features }

    const refFeatures: GeoJSON.Feature[] = []
    if (showRef) {
      // reference: nominal-pressure marker stripe at selected latitude rings
      for (const lat of [60, 30, 0, -30, -60]) {
        for (let lon = -180; lon <= 180; lon += 12) {
          refFeatures.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { m: 1 } })
        }
      }
    }
    const refFc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: refFeatures }

    const addAll = () => {
      const existSrc = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined
      if (existSrc) existSrc.setData(fc); else map.addSource(SRC, { type: 'geojson', data: fc })

      const existRef = map.getSource(REF_SRC) as maplibregl.GeoJSONSource | undefined
      if (existRef) existRef.setData(refFc); else map.addSource(REF_SRC, { type: 'geojson', data: refFc })

      if (showHalo && !map.getLayer(HALO)) {
        map.addLayer({
          id: HALO, source: SRC, type: 'circle',
          paint: {
            'circle-radius': ['get', 'radius'],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.15,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 1.4,
            'circle-stroke-opacity': 0.85,
          },
        })
      }
      if (!showHalo && map.getLayer(HALO)) map.removeLayer(HALO)

      if (showPin && !map.getLayer(PIN)) {
        map.addLayer({
          id: PIN, source: SRC, type: 'circle',
          filter: ['==', ['get', 'isEmer'], 1],
          paint: {
            'circle-radius': 6,
            'circle-color': '#f43f5e',
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 1.5,
          },
        })
      }
      if (!showPin && map.getLayer(PIN)) map.removeLayer(PIN)

      if (showLbl && !map.getLayer(LBL)) {
        map.addLayer({
          id: LBL, source: SRC, type: 'symbol',
          filter: ['!=', ['get', 'tier'], 'OK'],
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-offset': [0, 1.4],
            'text-anchor': 'top',
            'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          },
          paint: {
            'text-color': ['get', 'color'],
            'text-halo-color': '#020617',
            'text-halo-width': 1.4,
          },
        })
      }
      if (!showLbl && map.getLayer(LBL)) map.removeLayer(LBL)

      if (showRef && !map.getLayer(REF_LYR)) {
        map.addLayer({
          id: REF_LYR, source: REF_SRC, type: 'circle',
          paint: {
            'circle-radius': 1.5,
            'circle-color': '#0ea5e9',
            'circle-opacity': 0.35,
            'circle-stroke-width': 0,
          },
        })
      }
      if (!showRef && map.getLayer(REF_LYR)) map.removeLayer(REF_LYR)
    }

    if (map.isStyleLoaded()) addAll()
    else map.once('load', addAll)

    return () => {
      for (const l of [LBL, PIN, HALO, REF_LYR]) if (map.getLayer(l)) map.removeLayer(l)
      for (const s of [SRC, REF_SRC]) if (map.getSource(s)) map.removeSource(s)
    }
  }, [map, rows, tierFilter, clsFilter, showHalo, showPin, showLbl, showRef])

  const toggleSet = <T,>(s: Set<T>, v: T): Set<T> => {
    const n = new Set(s); if (n.has(v)) n.delete(v); else n.add(v); return n
  }

  // SVG: pressure (x) vs reservoir-quantity (y) per-system scatter
  const w = 360, h = 180
  const xMin = 0, xMax = 3500, yMin = 0, yMax = 110
  const px = (psi: number) => ((psi - xMin) / (xMax - xMin)) * w
  const py = (q: number) => h - ((q - yMin) / (yMax - yMin)) * h

  const points: { x: number; y: number; tier: Tier }[] = []
  for (const r of rows) {
    if (r.tier === 'IDLE') continue
    for (const s of r.sys) {
      points.push({ x: Math.max(0, Math.min(w, px(s.psi))), y: Math.max(0, Math.min(h, py(s.resPct))), tier: r.tier })
    }
  }

  return (
    <div className="absolute top-4 right-4 z-40 w-[420px] max-h-[90vh] overflow-hidden bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl flex flex-col">
      <div className="sticky top-0 bg-slate-950/95 px-4 py-3 border-b border-slate-800 flex items-center justify-between shrink-0">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">14 CFR 25.1309 · ARP4761 · FCOM 13.20 · UAL232</div>
          <div className="text-sm font-semibold text-slate-100">Hydraulic Redundancy · 3-System Loss Watch</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      <div className="overflow-y-auto px-4 py-3 space-y-3 text-xs">
        {/* Tier counter strip */}
        <div className="grid grid-cols-5 gap-1">
          {TIER_ORDER.map(t => (
            <button key={t}
              onClick={() => setTierFilter(s => toggleSet(s, t))}
              className={`px-1.5 py-1 rounded border text-[10px] transition ${tierFilter.has(t) ? 'bg-sky-500/15 border-sky-500/50' : 'bg-slate-900/50 border-slate-800 hover:border-slate-700'}`}
              style={{ borderLeftWidth: 3, borderLeftColor: TIER_COLOR[t] }}>
              <div className="font-semibold text-slate-100">{stats.counts[t]}</div>
              <div className="text-[9px] text-slate-500 truncate">{TIER_LABEL[t]}</div>
            </button>
          ))}
        </div>

        {/* Summary */}
        <div className="grid grid-cols-3 gap-1.5">
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">MEAN DEG</div>
            <div className={`font-mono ${stats.meanDeg >= 2 ? 'text-rose-300' : stats.meanDeg >= 1 ? 'text-amber-300' : 'text-slate-100'}`}>{stats.meanDeg.toFixed(2)} / ac</div>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">WORST</div>
            <div className="font-mono text-slate-100 truncate">
              {stats.worst ? `${stats.worst.f.callsign || stats.worst.f.icao} · ${stats.worst.driver}` : '—'}
            </div>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5" style={{ borderLeftWidth: 3, borderLeftColor: TIER_COLOR['EMER'] }}>
            <div className="text-[9px] uppercase tracking-wider text-slate-500">EMER</div>
            <div className="font-mono text-slate-100">{stats.counts['EMER']}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">MEAN PSI</div>
            <div className={`font-mono ${stats.meanPsi < 2000 ? 'text-rose-300' : stats.meanPsi < 2700 ? 'text-amber-300' : 'text-emerald-300'}`}>
              {stats.meanPsi.toFixed(0)} psi
            </div>
          </div>
          <div className="bg-slate-900/50 border border-slate-800 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">RAT EXT · LEAK SYS</div>
            <div className="font-mono text-slate-100">
              <span className={stats.ratShare > 0 ? 'text-amber-300' : ''}>{(stats.ratShare * 100).toFixed(0)}%</span>
              {' / '}
              <span className={stats.leakShare > 0.15 ? 'text-amber-300' : ''}>{(stats.leakShare * 100).toFixed(0)}%</span>
            </div>
          </div>
        </div>

        {/* SVG scatter */}
        {showDiag && (
          <div className="bg-slate-900/30 border border-slate-800 rounded p-1.5">
            <div className="flex justify-between items-center text-[9px] text-slate-500 mb-1">
              <span>pressure psi × reservoir pct (all systems)</span>
              <span>{points.length} pts</span>
            </div>
            <svg viewBox={`0 0 ${w} ${h + 22}`} className="w-full">
              {/* danger zone left: pressure < 2000 */}
              <rect x={0} y={0} width={px(2000)} height={h} fill="#f43f5e" fillOpacity={0.06} />
              <rect x={px(2000)} y={0} width={px(2700) - px(2000)} height={h} fill="#f59e0b" fillOpacity={0.06} />
              <rect x={px(2700)} y={0} width={w - px(2700)} height={h} fill="#10b981" fillOpacity={0.05} />
              {/* low reservoir band */}
              <rect x={0} y={py(resFloor)} width={w} height={h - py(resFloor)} fill="#f43f5e" fillOpacity={0.05} />
              {/* threshold lines */}
              <line x1={px(2700)} x2={px(2700)} y1={0} y2={h} stroke="#10b981" strokeOpacity={0.45} strokeDasharray="3 3" strokeWidth={0.8} />
              <line x1={px(2000)} x2={px(2000)} y1={0} y2={h} stroke="#f43f5e" strokeOpacity={0.5} strokeDasharray="3 3" strokeWidth={0.8} />
              <line x1={0} x2={w} y1={py(resFloor)} y2={py(resFloor)} stroke="#f43f5e" strokeOpacity={0.45} strokeDasharray="3 3" strokeWidth={0.8} />
              {/* grid */}
              {[1000, 2000, 3000].map(p => (
                <g key={'p' + p}>
                  <line x1={px(p)} x2={px(p)} y1={0} y2={h} stroke="#1e293b" strokeWidth={0.5} />
                  <text x={px(p) + 2} y={h - 2} fontSize={7} fill="#475569">{p}psi</text>
                </g>
              ))}
              {[25, 50, 75, 100].map(q => (
                <g key={'q' + q}>
                  <line x1={0} x2={w} y1={py(q)} y2={py(q)} stroke="#1e293b" strokeWidth={0.5} />
                  <text x={2} y={py(q) - 1} fontSize={7} fill="#475569">{q}%</text>
                </g>
              ))}
              {points.slice(0, 1500).map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={p.tier === 'EMER' ? 2.4 : 1.6} fill={TIER_COLOR[p.tier]} fillOpacity={0.8} />
              ))}
              <g transform={`translate(0,${h + 4})`}>
                <rect x={0} y={0} width={8} height={8} fill="#10b981" fillOpacity={0.4} stroke="#10b981" strokeWidth={0.5} />
                <text x={11} y={7} fontSize={8} fill="#94a3b8">nom ≥ 2700</text>
                <rect x={70} y={0} width={8} height={8} fill="#f59e0b" fillOpacity={0.4} stroke="#f59e0b" strokeWidth={0.5} />
                <text x={81} y={7} fontSize={8} fill="#94a3b8">deg 2000-2700</text>
                <rect x={170} y={0} width={8} height={8} fill="#f43f5e" fillOpacity={0.4} stroke="#f43f5e" strokeWidth={0.5} />
                <text x={181} y={7} fontSize={8} fill="#94a3b8">lost &lt; 2000</text>
              </g>
            </svg>
          </div>
        )}

        {/* Sliders */}
        <div className="grid grid-cols-2 gap-2">
          {[
            ['MIN-FL', minFL, setMinFL, 0, 400, ''],
            ['LEAK-MUL', leakMul, setLeakMul, 50, 200, '%'],
            ['RES-FLOOR', resFloor, setResFloor, 10, 80, '%'],
            ['PUMP-MUL', pumpMul, setPumpMul, 50, 200, '%'],
          ].map(([lbl, val, setter, min, max, unit]: any) => (
            <label key={lbl} className="block">
              <div className="flex justify-between text-[9px] uppercase tracking-wider text-slate-500 mb-0.5">
                <span>{lbl}</span><span className="font-mono text-slate-300">{val}{unit}</span>
              </div>
              <input type="range" min={min} max={max} value={val} onChange={e => setter(Number(e.target.value))}
                className="w-full accent-sky-500" />
            </label>
          ))}
        </div>
        <label className="block">
          <div className="flex justify-between text-[9px] uppercase tracking-wider text-slate-500 mb-0.5">
            <span>RAT-FL-BIAS</span><span className="font-mono text-slate-300">{ratFlBias}%</span>
          </div>
          <input type="range" min={50} max={400} value={ratFlBias} onChange={e => setRatFlBias(Number(e.target.value))}
            className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="flex justify-between text-[9px] uppercase tracking-wider text-slate-500 mb-0.5">
            <span>FAIL-RATE</span><span className="font-mono text-slate-300">{failRate}% fleet</span>
          </div>
          <input type="range" min={1} max={30} value={failRate} onChange={e => setFailRate(Number(e.target.value))}
            className="w-full accent-sky-500" />
        </label>

        {/* Class filter */}
        <div className="flex gap-1 flex-wrap">
          {(Object.keys(CLS_NAME) as Cls[]).map(c => (
            <button key={c} onClick={() => setClsFilter(s => toggleSet(s, c))}
              title={CLS_NAME[c]}
              className={`px-1.5 py-0.5 rounded border text-[10px] transition ${clsFilter.has(c) ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-300 hover:border-slate-700'}`}>
              {c}
            </button>
          ))}
        </div>

        {/* Layer toggles */}
        <div className="flex items-center gap-1 flex-wrap">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['REF', showRef, setShowRef],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lbl, on, set]: any) => (
            <button key={lbl} onClick={() => set((v: boolean) => !v)}
              className={`px-1.5 py-0.5 rounded border text-[10px] ${on ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400'}`}>
              {lbl}
            </button>
          ))}
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search"
            className="flex-1 min-w-0 bg-slate-900/50 border border-slate-800 rounded px-2 py-0.5 text-[11px] text-slate-100 placeholder-slate-600" />
        </div>

        {/* Tab */}
        <div className="flex gap-1">
          {(['AIRCRAFT', 'SYSTEMS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 rounded border text-[10px] ${tab === t ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400'}`}>
              {t}
            </button>
          ))}
        </div>

        {/* Aircraft tab */}
        {tab === 'AIRCRAFT' && (
          <div className="space-y-1.5">
            {filtered.slice(0, 100).map(r => {
              const tc = TIER_COLOR[r.tier]
              return (
                <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
                  className="w-full text-left bg-slate-900/50 hover:bg-slate-800/70 border border-slate-800 hover:border-slate-700 rounded p-2 transition"
                  style={{ borderLeftWidth: 3, borderLeftColor: tc }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-slate-100 text-[11px] truncate flex-1">
                      {r.f.callsign || r.f.icao}
                      <span className="text-slate-500 ml-1">{r.f.type || ''}</span>
                    </div>
                    <span className="text-[9px] px-1 py-0.5 rounded border" style={{ color: tc, borderColor: tc + '80' }}>{r.cls}</span>
                    <span className="text-[9px] px-1 py-0.5 rounded font-semibold" style={{ color: tc, background: tc + '22', border: `1px solid ${tc}66` }}>{TIER_LABEL[r.tier]}</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] mt-0.5">
                    <span className="font-mono text-slate-400">FL{r.fl} · {r.phase} · {r.degCount}/{r.arch.sysCount} deg{r.ratExt ? ' · ★ RAT' : ''}</span>
                  </div>
                  <div className="mt-1 h-1.5 bg-slate-800 rounded relative overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${r.score}%`, background: tc, opacity: 0.85 }} />
                    {[25, 55, 80].map(t => (
                      <div key={t} className="absolute top-0 bottom-0 w-px bg-slate-600" style={{ left: `${t}%` }} />
                    ))}
                  </div>
                  {/* per-system pills */}
                  <div className="grid gap-0.5 mt-1" style={{ gridTemplateColumns: `repeat(${r.sys.length}, minmax(0,1fr))` }}>
                    {r.sys.map((s, i) => {
                      const sc = s.degraded ? (s.psi < 1000 ? TIER_COLOR.EMER : TIER_COLOR.DUAL) : TIER_COLOR.OK
                      return (
                        <div key={i} className="text-center text-[8px] py-0.5 rounded" style={{ background: sc + '22', color: sc, border: `1px solid ${sc}44` }}>
                          {s.name} {s.psi.toFixed(0)} · {s.resPct.toFixed(0)}%{s.leakGph > 0 ? ' ↓' : ''}
                        </div>
                      )
                    })}
                  </div>
                  {/* breakdown chips */}
                  <div className="grid grid-cols-4 gap-0.5 mt-1">
                    {[
                      ['SYS', r.sysSev],
                      ['FCTL', r.fctlSev],
                      ['LDG', r.ldgSev],
                      ['LEAK', r.leakSev],
                    ].map(([k, v]: any) => {
                      const c = v >= 80 ? TIER_COLOR.EMER : v >= 55 ? TIER_COLOR.DUAL : v >= 25 ? TIER_COLOR.SNGL : TIER_COLOR.OK
                      return (
                        <div key={k} className="text-center text-[8px] py-0.5 rounded" style={{ background: c + '22', color: c, border: `1px solid ${c}44` }}>
                          {k} {v.toFixed(0)}
                        </div>
                      )
                    })}
                  </div>
                  {/* function loss row */}
                  <div className="flex flex-wrap gap-1 mt-1 text-[9px]">
                    {r.lossFctl && <span className="px-1 py-0.5 rounded" style={{ background: TIER_COLOR.EMER + '22', color: TIER_COLOR.EMER, border: `1px solid ${TIER_COLOR.EMER}66` }}>! FCTL</span>}
                    {r.lossGear && <span className="px-1 py-0.5 rounded" style={{ background: TIER_COLOR.DUAL + '22', color: TIER_COLOR.DUAL, border: `1px solid ${TIER_COLOR.DUAL}66` }}>! GEAR</span>}
                    {r.lossBrake && <span className="px-1 py-0.5 rounded" style={{ background: TIER_COLOR.DUAL + '22', color: TIER_COLOR.DUAL, border: `1px solid ${TIER_COLOR.DUAL}66` }}>! BRAKE</span>}
                    {r.lossNws && <span className="px-1 py-0.5 rounded" style={{ background: TIER_COLOR.SNGL + '22', color: TIER_COLOR.SNGL, border: `1px solid ${TIER_COLOR.SNGL}66` }}>! NWS</span>}
                    {r.lossFlaps && <span className="px-1 py-0.5 rounded" style={{ background: TIER_COLOR.DUAL + '22', color: TIER_COLOR.DUAL, border: `1px solid ${TIER_COLOR.DUAL}66` }}>! FLAPS</span>}
                    {r.lossAutoland && <span className="px-1 py-0.5 rounded" style={{ background: TIER_COLOR.SNGL + '22', color: TIER_COLOR.SNGL, border: `1px solid ${TIER_COLOR.SNGL}66` }}>! AUTOLAND</span>}
                    {r.arch.ptu && <span className={`px-1 py-0.5 rounded border ${r.ptuOk ? 'text-emerald-400 border-emerald-700' : 'text-amber-400 border-amber-700'}`}>PTU {r.ptuOk ? 'OK' : 'OFF'}</span>}
                  </div>
                  <div className="flex items-center justify-between text-[9px] mt-1 text-slate-500">
                    <span className="font-mono">phase ×{r.phaseMul.toFixed(2)} · arch {r.arch.sysCount}-sys</span>
                    <span className="truncate ml-1">{r.f.operator || ''}</span>
                  </div>
                  <div className="text-[9px] mt-0.5" style={{ color: tc }}>› {r.driverLong} · {TIER_ADVICE[r.tier]}</div>
                </button>
              )
            })}
            {!filtered.length && (
              <div className="text-center text-slate-500 py-4 text-[11px]">No aircraft match filters</div>
            )}
          </div>
        )}

        {/* Systems tab */}
        {tab === 'SYSTEMS' && (
          <div className="space-y-1.5">
            {systems.map(g => {
              const tc = TIER_COLOR[g.worstTier]
              const degShare = g.degCount / g.rs.length
              return (
                <button key={g.key} onClick={() => onFly(g.worst.f.icao)}
                  className="w-full text-left bg-slate-900/50 hover:bg-slate-800/70 border border-slate-800 hover:border-slate-700 rounded p-2 transition"
                  style={{ borderLeftWidth: 3, borderLeftColor: tc }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 flex-1 min-w-0">
                      <span className="text-[9px] px-1 py-0.5 rounded border font-mono" style={{ color: tc, borderColor: tc + '80' }}>{g.cls}</span>
                      <span className="text-slate-100 text-[11px] truncate font-mono">{g.name}</span>
                    </div>
                    <span className="text-[10px] font-mono text-slate-400">{g.rs.length} ac</span>
                    <span className="text-[9px] px-1 py-0.5 rounded font-semibold" style={{ color: tc, background: tc + '22', border: `1px solid ${tc}66` }}>{TIER_LABEL[g.worstTier]}</span>
                  </div>
                  <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                    deg <span style={{ color: degShare >= 0.3 ? TIER_COLOR.EMER : degShare >= 0.1 ? TIER_COLOR.DUAL : TIER_COLOR.OK }}>{g.degCount}/{g.rs.length}</span>
                    {' · '}mean psi <span className={g.meanPsi < 2000 ? 'text-rose-400' : g.meanPsi < 2700 ? 'text-amber-400' : 'text-emerald-400'}>{g.meanPsi.toFixed(0)}</span>
                    {' · '}worst {g.worst.f.callsign || g.worst.f.icao} score {g.worst.score.toFixed(0)}
                  </div>
                  <div className="mt-1 h-1.5 bg-slate-800 rounded relative overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${degShare * 100}%`, background: tc, opacity: 0.85 }} />
                  </div>
                  <div className="text-[9px] mt-0.5 text-slate-500 font-mono">
                    nom {ARCH[g.cls].nomPsi}psi · res {ARCH[g.cls].resGal}gal{ARCH[g.cls].ptu ? ' · PTU' : ''}{ARCH[g.cls].ratFl > 0 ? ` · RAT≥FL${ARCH[g.cls].ratFl}` : ''}
                  </div>
                  <div className="text-[9px] mt-0.5" style={{ color: tc }}>› {TIER_ADVICE[g.worstTier]}</div>
                </button>
              )
            })}
            {!systems.length && (
              <div className="text-center text-slate-500 py-4 text-[11px]">No active systems</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
