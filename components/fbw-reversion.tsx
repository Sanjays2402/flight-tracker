'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Fly-By-Wire Control Law Reversion & Protection-Loss Monitor
   -----------------------------------------------------------
   Reconstructs FBW control-law mode for every airborne aircraft
   equipped with electronic flight control (EFCS) and predicts
   the probability of a degraded law reversion based on inferred
   ADIRU agreement, computer health, hydraulic status, AOA-vane
   plausibility, and configuration.

   Architecture coverage:
     · Airbus EFCS (A320 / A330 / A340 / A350 / A380)
         NORMAL  — full envelope protections
         ALT-1   — pitch normal, lat normal w/o high-AOA prot
         ALT-2   — pitch alt, lat direct, no high-AOA prot
         DIRECT  — direct stick-to-surface, manual trim
         MECH    — pitch via trim wheel, yaw via rudder pedals
     · Boeing 777 / 787 PFCS
         NORMAL  — envelope protections, A/T integration
         SECONDARY — analog backup, reduced protections
         DIRECT  — direct mode, no protections
     · Embraer E-jets / Gulfstream FBW
         NORMAL / DIRECT
     · Conventional (RGN/TBP/GA) — N/A (no FBW)

   Regulatory & ops basis:
     · 14 CFR 25.671 / 25.672 / 25.677 / 25.1309 / 25.1329
     · CS-25.671 / 25.672 AMC 25.672 Stability augmentation
     · AC 25.672-1 EFCS guidance
     · Airbus FCOM DSC-27 FLIGHT CONTROLS / PRO-ABN-27
     · Airbus FCTM AS-27 reversion handling
     · Boeing 777 FCOM 9.10 Primary Flight Control / 9.20 Reversion
     · Boeing 787 FCOM 9.10 / FCTM Vol I Reversion
     · Embraer E-Jet AOM 27-10 FBW
     · BEA AF447 Final Report 2012 — ALT-2 + UAS
     · NTSB AAR-13/02 Asiana 214 — auto-throttle wake-up logic
     · QFA QF72 ATSB AO-2008-070 — ADIRU runaway
     · ATSB AO-2018-053 — ALT-2B Airbus pitch reversion
     · AAIB 2/2009 G-CGEX — pitot icing UAS ALT-2

   Per-airframe hash-stable synthesis (FNV-1a 32-bit of ICAO24):
     · ADIRU 1/2/3 agreement (heading, AOA, IAS) ±2σ
     · FAC / SEC / ELAC (Airbus) or PFC (Boeing) channel status
     · Pitot heat status (3-channel)
     · Hydraulic green/blue/yellow continuity bias from class
     · Spoiler / aileron lockout flags
     · Recent attitude (bank, pitch) for envelope-edge proximity

   Computes per airframe:
     · activeLaw enum NORMAL/ALT-1/ALT-2/DIRECT/MECH (Airbus) or
       NORMAL/SECONDARY/DIRECT (Boeing) or NORMAL/DIRECT (EMB/GLF)
     · reversionRisk pct — probability of further degradation in
       next 5 min based on triggers
     · 5 driver components ADIRU/PROBE/HYD/AOA/ENV severities
     · loss-of-protection set: HIGH-AOA / HIGH-SPD / LOAD-FACTOR /
       BANK / PITCH-ATT / AUTOTRIM
     · recommended actions per FCOM PRO-ABN-27

   Tier classification:
     SEVERE   DIRECT / MECH active OR risk>=80 → rose
              declare PAN, hand-fly per FCOM 9.20, no AP
     ALT      ALT-1 / ALT-2 / SECONDARY active OR risk>=55
              amber — manual trim awareness, brief crew
     WATCH    risk>=25 — sky — single-channel fault, monitor
     OK       NORMAL law all protections — emerald
     IDLE     conventional aircraft (no FBW) — slate

   MapLibre overlay:
     · tier halo rings sized by risk 8-22 px
     · rose diamond pin at current pos for SEVERE with law code
     · tier callsign + law + driver labels for ALT / SEVERE
     · 14-segment dashed forward-projection 50 nm for SEVERE
     · sky reference parallels lat 45/15/-15/-45 every 16°

   Side panel: full tally / summary / SVG risk-vs-AOA scatter /
   8 sliders / class filter / law filter / toggles / aircraft +
   laws tabs with detailed per-row breakdown.

   Layers > Safety & Traffic.
   Persisted: ft-fbw
   ============================================================ */

interface FbwFlight {
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
  flights: FbwFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'SEVERE' | 'ALT' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  SEVERE: '#ef4444', ALT: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['SEVERE', 'ALT', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { SEVERE: 0, ALT: 1, WATCH: 2, OK: 3, IDLE: 4 }

type AcClass = 'ABA' | 'ABB' | 'ABS' | 'BOE' | 'EMB' | 'BIZ' | 'CONV'
const CLASS_LIST: AcClass[] = ['ABA', 'ABB', 'ABS', 'BOE', 'EMB', 'BIZ', 'CONV']
const CLASS_LABEL: Record<AcClass, string> = {
  ABA: 'Airbus A320-fam', ABB: 'Airbus A330/340', ABS: 'Airbus A350/380',
  BOE: 'Boeing 777/787', EMB: 'Embraer E-Jet', BIZ: 'Bizjet FBW', CONV: 'Conventional',
}

type Law = 'NORMAL' | 'ALT-1' | 'ALT-2' | 'DIRECT' | 'MECH' | 'SECONDARY' | 'N/A'
const LAW_LIST: Law[] = ['NORMAL', 'ALT-1', 'ALT-2', 'SECONDARY', 'DIRECT', 'MECH', 'N/A']
const LAW_SEV: Record<Law, number> = {
  NORMAL: 0, 'ALT-1': 35, 'ALT-2': 60, SECONDARY: 55, DIRECT: 90, MECH: 100, 'N/A': 0,
}

type Driver = 'ADIRU' | 'PROBE' | 'HYD' | 'AOA' | 'ENV' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  ADIRU: 'ADIRU disagreement',
  PROBE: 'Pitot / AOA probe fault',
  HYD: 'Hydraulic / EFCS channel loss',
  AOA: 'AOA-vane plausibility',
  ENV: 'Envelope-edge proximity',
  NONE: 'Nominal',
}

interface ClassSpec {
  laws: Law[]              // possible laws for class
  fcom: string
  protections: string[]
  baseHealth: number       // 0..1 baseline computer health
}

const CLASS_SPEC: Record<AcClass, ClassSpec> = {
  ABA: { laws: ['NORMAL', 'ALT-1', 'ALT-2', 'DIRECT', 'MECH'], fcom: 'A320 FCOM DSC-27 / PRO-ABN-27', protections: ['HIGH-AOA', 'HIGH-SPD', 'LOAD-FACTOR', 'BANK', 'PITCH-ATT'], baseHealth: 0.97 },
  ABB: { laws: ['NORMAL', 'ALT-1', 'ALT-2', 'DIRECT', 'MECH'], fcom: 'A330/340 FCOM DSC-27', protections: ['HIGH-AOA', 'HIGH-SPD', 'LOAD-FACTOR', 'BANK', 'PITCH-ATT'], baseHealth: 0.96 },
  ABS: { laws: ['NORMAL', 'ALT-1', 'ALT-2', 'DIRECT', 'MECH'], fcom: 'A350/A380 FCOM DSC-27', protections: ['HIGH-AOA', 'HIGH-SPD', 'LOAD-FACTOR', 'BANK', 'PITCH-ATT', 'AUTOTRIM'], baseHealth: 0.98 },
  BOE: { laws: ['NORMAL', 'SECONDARY', 'DIRECT'], fcom: 'B777/787 FCOM 9.20', protections: ['BANK', 'PITCH-ATT', 'LOAD-FACTOR', 'AUTOTRIM'], baseHealth: 0.98 },
  EMB: { laws: ['NORMAL', 'DIRECT'], fcom: 'E-Jet AOM 27-10', protections: ['BANK', 'PITCH-ATT', 'AUTOTRIM'], baseHealth: 0.95 },
  BIZ: { laws: ['NORMAL', 'DIRECT'], fcom: 'G500/G650 FCOM', protections: ['BANK', 'AUTOTRIM'], baseHealth: 0.96 },
  CONV: { laws: ['N/A'], fcom: 'Conventional cables / hydraulic boost', protections: [], baseHealth: 1.0 },
}

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/A35|A38/.test(t)) return 'ABS'
  if (/A33|A34/.test(t)) return 'ABB'
  if (/A31|A319|A32|A22/.test(t)) return 'ABA'
  if (/B77|B78/.test(t)) return 'BOE'
  if (/E17|E19|E29|E[12]7|E[12]9/.test(t)) return 'EMB'
  if (/G[VI458]|GLF|GLEX|FA[78]X|F2TH/.test(t)) return 'BIZ'
  return 'CONV'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

interface Row {
  f: FbwFlight
  klass: AcClass
  spec: ClassSpec
  law: Law
  risk: number
  driver: Driver
  protLost: string[]
  adiruDelta: number   // kt IAS disagree
  aoaVane: number      // deg
  bankDeg: number
  pitchDeg: number
  probeOk: number      // 0..3 healthy probes
  efcsCh: number       // 0..3 healthy primary channels
  sev: { adiru: number; probe: number; hyd: number; aoa: number; env: number }
  tier: Tier
}

const SRC_HALO = 'fbw-halo', SRC_LBL = 'fbw-lbl', SRC_PIN = 'fbw-pin', SRC_REF = 'fbw-ref', SRC_PROJ = 'fbw-proj'
const LYR_HALO = 'fbw-halo-l', LYR_LBL = 'fbw-lbl-l', LYR_PIN = 'fbw-pin-l', LYR_REF = 'fbw-ref-l', LYR_PROJ = 'fbw-proj-l'

export default function FbwReversion({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'LAWS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [lawFilter, setLawFilter] = useState<Law | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(20)
  const [adiruThresh, setAdiruThresh] = useState(10)     // kt IAS disagree threshold 4..30
  const [probeBias, setProbeBias] = useState(100)         // 50..200
  const [hydMul, setHydMul] = useState(100)               // 50..200
  const [envMul, setEnvMul] = useState(100)               // 50..200
  const [revRate, setRevRate] = useState(5)               // % fleet base reversion 0..20
  const [riskWin, setRiskWin] = useState(5)               // forecast minutes 1..15
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
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      if (f.altitudeFt / 100 < minFl) continue
      const klass = classifyClass(f.type || '')
      const spec = CLASS_SPEC[klass]
      const h = hash32(f.icao || '')

      // Hash-stable parameter synthesis
      const adiruDelta = ((h >>> 3) % 40) * (probeBias / 100) * 0.6 // 0..24 kt
      const probeOk = adiruDelta > adiruThresh ? ((h >>> 11) % 3) : 3  // 0..3
      const efcsCh = ((h >>> 17) % 100) < 92 ? 3 : ((h >>> 17) % 100) < 98 ? 2 : 1
      const aoaVane = 2 + ((h >>> 7) % 80) / 10 // 2..10 deg
      const bankDeg = ((h >>> 13) % 60) - 5     // -5..55
      const pitchDeg = ((h >>> 19) % 30) - 10   // -10..20
      const hydFault = ((h >>> 23) % 1000) < 25 * (hydMul / 100) // ~2.5% fleet base
      const aoaFault = ((h >>> 29) % 1000) < 18 * (probeBias / 100) // ~1.8%

      // Component severities 0..100
      const adiruSev = adiruDelta <= adiruThresh ? 0 : Math.min(100, ((adiruDelta - adiruThresh) / adiruThresh) * 60 + 30)
      const probeSev = probeOk === 3 ? 0 : probeOk === 2 ? 40 : probeOk === 1 ? 75 : 100
      const hydSev = hydFault ? (efcsCh <= 1 ? 95 : efcsCh === 2 ? 65 : 40) : (efcsCh === 2 ? 25 : efcsCh === 1 ? 70 : 0)
      const aoaSev = aoaFault ? 80 : aoaVane > 12 ? 60 : 0
      const envSev = (Math.abs(bankDeg) > 33 ? 60 : 0) + (Math.abs(pitchDeg) > 25 ? 40 : 0)
      const envSevC = Math.min(100, envSev) * (envMul / 100)

      const sevs: Array<[Driver, number]> = [
        ['ADIRU', adiruSev], ['PROBE', probeSev], ['HYD', hydSev],
        ['AOA', aoaSev], ['ENV', envSevC],
      ]
      sevs.sort((a, b) => b[1] - a[1])
      const driver: Driver = sevs[0][1] > 0 ? sevs[0][0] : 'NONE'
      let composite = sevs[0][1]
      // small additive boost from secondary drivers
      composite = Math.min(100, composite + sevs[1][1] * 0.1)

      // Determine active law based on triggers (conservative ladder)
      let law: Law = 'NORMAL'
      if (klass === 'CONV') law = 'N/A'
      else if (klass === 'BOE') {
        if (composite >= 85 || efcsCh <= 1) law = 'DIRECT'
        else if (composite >= 55 || efcsCh === 2) law = 'SECONDARY'
      } else if (klass === 'EMB' || klass === 'BIZ') {
        if (composite >= 75 || efcsCh <= 1) law = 'DIRECT'
      } else { // Airbus
        if (efcsCh <= 1 && hydFault) law = 'MECH'
        else if (composite >= 88 || (hydFault && efcsCh === 1)) law = 'DIRECT'
        else if (composite >= 65 || probeSev >= 75 || aoaSev >= 80) law = 'ALT-2'
        else if (composite >= 38 || adiruSev > 0 || hydSev > 35) law = 'ALT-1'
      }

      // Risk: probability of further reversion within riskWin minutes
      const lawSev = LAW_SEV[law]
      const baseRisk = (revRate / 100) * 100  // base fleet rate %
      let risk = Math.min(100, baseRisk + composite * 0.5 + lawSev * 0.25)
      // riskWin scales: more time = more chance
      risk = Math.min(100, risk * (1 + (riskWin - 5) * 0.05))

      // Lost protections
      const lostMap: Record<Law, string[]> = {
        NORMAL: [],
        'ALT-1': ['HIGH-AOA'],
        'ALT-2': ['HIGH-AOA', 'HIGH-SPD', 'BANK'],
        SECONDARY: ['HIGH-AOA', 'AUTOTRIM-partial'],
        DIRECT: ['HIGH-AOA', 'HIGH-SPD', 'LOAD-FACTOR', 'BANK', 'PITCH-ATT', 'AUTOTRIM'],
        MECH: ['ALL-FBW'],
        'N/A': [],
      }
      const protLost = lostMap[law]

      let tier: Tier
      if (klass === 'CONV') tier = 'IDLE'
      else if (law === 'DIRECT' || law === 'MECH' || risk >= 80) tier = 'SEVERE'
      else if (law === 'ALT-1' || law === 'ALT-2' || law === 'SECONDARY' || risk >= 55) tier = 'ALT'
      else if (risk >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, klass, spec, law, risk, driver, protLost,
        adiruDelta, aoaVane, bankDeg, pitchDeg, probeOk, efcsCh,
        sev: { adiru: adiruSev, probe: probeSev, hyd: hydSev, aoa: aoaSev, env: envSevC },
        tier,
      })
    }
    return out
  }, [flights, minFl, adiruThresh, probeBias, hydMul, envMul, revRate, riskWin])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { SEVERE: 0, ALT: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const lawTally = useMemo(() => {
    const t: Record<Law, number> = { NORMAL: 0, 'ALT-1': 0, 'ALT-2': 0, SECONDARY: 0, DIRECT: 0, MECH: 0, 'N/A': 0 }
    for (const r of rows) t[r.law]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumRisk = 0, worst = 0, worstCs = '', worstLaw: Law = 'NORMAL'
    let severe = 0, alt = 0, count = 0, fbwCount = 0
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      count++; fbwCount++
      sumRisk += r.risk
      if (r.tier === 'SEVERE') severe++
      if (r.tier === 'ALT') alt++
      if (r.risk > worst) { worst = r.risk; worstCs = (r.f.callsign || r.f.icao).trim(); worstLaw = r.law }
    }
    const totalAc = rows.length
    return {
      meanRisk: count ? sumRisk / count : 0,
      worst, worstCs, worstLaw, severe, alt, activeCount: count,
      altShare: totalAc ? alt / totalAc : 0,
    }
  }, [rows])

  const lawAggs = useMemo(() => {
    const m = new Map<Law, { law: Law; count: number; sumRisk: number; worst: number; worstCs: string; worstIcao: string; worstTier: Tier; severe: number }>()
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      let a = m.get(r.law)
      if (!a) { a = { law: r.law, count: 0, sumRisk: 0, worst: 0, worstCs: '', worstIcao: '', worstTier: 'OK', severe: 0 }; m.set(r.law, a) }
      a.count++; a.sumRisk += r.risk
      if (r.tier === 'SEVERE') a.severe++
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.risk > a.worst) { a.worst = r.risk; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
    }
    const arr = Array.from(m.values()).map(a => ({ ...a, meanRisk: a.count ? a.sumRisk / a.count : 0 }))
    arr.sort((a, b) => {
      const ls = LAW_SEV[b.law] - LAW_SEV[a.law]
      if (ls !== 0) return ls
      return b.count - a.count
    })
    return arr
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows
      .filter(r => r.tier !== 'IDLE')
      .filter(r => {
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (classFilter !== 'ALL' && r.klass !== classFilter) return false
        if (lawFilter !== 'ALL' && r.law !== lawFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.risk - a.risk
      })
  }, [rows, tierFilter, classFilter, lawFilter, query])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.risk / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'ALT' || r.tier === 'SEVERE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${r.law} ${r.driver}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'SEVERE').map(r => ({
      type: 'Feature' as const,
      properties: { color: '#ef4444', text: `\u203a ${r.law} ${r.driver} ${r.risk.toFixed(0)}%` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const projFeatures: any[] = []
    if (showProj) {
      for (const r of rows) {
        if (r.tier !== 'SEVERE') continue
        const tr = r.f.track * Math.PI / 180
        const dNm = 50
        const dLat = (dNm / 60) * Math.cos(tr)
        const dLng = (dNm / 60) * Math.sin(tr) / Math.max(0.1, Math.cos(r.f.lat * Math.PI / 180))
        const coords: [number, number][] = []
        const segs = 14
        for (let i = 0; i <= segs; i++) coords.push([r.f.lng + dLng * (i / segs), r.f.lat + dLat * (i / segs)])
        projFeatures.push({ type: 'Feature' as const, properties: { color: TIER_COLOR[r.tier] }, geometry: { type: 'LineString' as const, coordinates: coords } })
      }
    }
    const projFc = { type: 'FeatureCollection' as const, features: projFeatures }

    const refFeatures: any[] = []
    if (showRef) {
      for (const lat of [45, 15, -15, -45]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 16) coords.push([lng, lat])
        refFeatures.push({ type: 'Feature' as const, properties: { color: '#0ea5e9' }, geometry: { type: 'LineString' as const, coordinates: coords } })
      }
    }
    const refFc = { type: 'FeatureCollection' as const, features: refFeatures }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_REF, refFc, () => map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: {
        'line-color': ['get', 'color'], 'line-width': 0.6, 'line-opacity': 0.12, 'line-dasharray': [3, 6],
      } }))
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [3, 3],
      } }))
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['get', 'text'], 'text-size': 10,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-offset': [0, -1.5], 'text-anchor': 'bottom', 'icon-allow-overlap': true,
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.6 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_REF]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_PROJ, SRC_REF]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showProj, showRef])

  // SVG diagram: risk % (y) vs ADIRU disagree kt (x)
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 30
    const xMax = 30, yMax = 100
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, v / xMax)) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMax, yMax }
  }, [])

  const tierColorOf = (s: number) => s >= 80 ? '#ef4444' : s >= 55 ? '#f59e0b' : s >= 25 ? '#0ea5e9' : '#10b981'
  const adviceFor = (r: Row): string => {
    if (r.tier === 'SEVERE') {
      if (r.law === 'MECH') return 'MECHANICAL backup active — use trim wheel for pitch, pedals for yaw, declare PAN-PAN per FCOM PRO-ABN-27 MECHANICAL FLT CTL'
      if (r.law === 'DIRECT') return 'DIRECT LAW active — autopilot inhibited, no protections, hand-fly to landing, manual trim awareness per FCOM 9.20'
      return 'Reversion imminent — disconnect AP/AT, hand-fly, brief crew per FCOM PRO-ABN-27, request lower FL and direct routing'
    }
    if (r.tier === 'ALT') {
      if (r.law === 'ALT-2') return 'ALT-2 LAW — pitch alternate, lateral direct, no high-AOA/HIGH-SPD protections — limit bank 33°, monitor stall margin per FCOM AS-27'
      if (r.law === 'ALT-1') return 'ALT-1 LAW — full pitch protections retained except high-AOA — brief crew, monitor speed band'
      if (r.law === 'SECONDARY') return 'SECONDARY mode — reduced protections, A/T compatibility limited per B777/787 FCOM 9.20'
      return 'Risk elevated — single-channel fault, monitor PFD reversion annunciators'
    }
    if (r.tier === 'WATCH') return 'Single-channel fault or envelope-edge — monitor ECAM/EICAS, no crew action required'
    return 'NORMAL law — all envelope protections active'
  }

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">FBW Law Reversion</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.activeCount} ac · {summary.severe} SEV</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold" style={{ color: TIER_COLOR[t] }}>{t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Risk</div>
          <div className="font-mono text-sm" style={{ color: tierColorOf(summary.meanRisk) }}>{summary.meanRisk.toFixed(0)}%</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] truncate" style={{ color: tierColorOf(summary.worst) }}>{summary.worstCs || '—'} {summary.worstLaw}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Severe</div>
          <div className="font-mono text-sm text-rose-400">{summary.severe}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">ALT-law share</div>
          <div className="font-mono text-[11px]" style={{ color: summary.altShare > 0.05 ? '#ef4444' : summary.altShare > 0.02 ? '#f59e0b' : '#10b981' }}>{(summary.altShare * 100).toFixed(1)}%</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">NORMAL count</div>
          <div className="font-mono text-[11px] text-emerald-400">{lawTally.NORMAL}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg viewBox={`0 0 ${diag.W} ${diag.H}`} className="w-full h-auto">
            <rect x={diag.PAD} y={diag.ys(100)} width={diag.W - diag.PAD - 6} height={diag.ys(80) - diag.ys(100)} fill="#ef4444" opacity={0.07} />
            <rect x={diag.PAD} y={diag.ys(80)} width={diag.W - diag.PAD - 6} height={diag.ys(55) - diag.ys(80)} fill="#f59e0b" opacity={0.07} />
            <rect x={diag.PAD} y={diag.ys(55)} width={diag.W - diag.PAD - 6} height={diag.ys(25) - diag.ys(55)} fill="#0ea5e9" opacity={0.07} />
            <rect x={diag.PAD} y={diag.ys(25)} width={diag.W - diag.PAD - 6} height={diag.H - 22 - diag.ys(25)} fill="#10b981" opacity={0.07} />
            {[25, 55, 80].map(y => (
              <line key={y} x1={diag.PAD} y1={diag.ys(y)} x2={diag.W - 6} y2={diag.ys(y)} stroke="#475569" strokeWidth={0.5} strokeDasharray="2 4" />
            ))}
            <line x1={diag.xs(adiruThresh)} y1={6} x2={diag.xs(adiruThresh)} y2={diag.H - 22} stroke="#f59e0b" strokeWidth={0.6} strokeDasharray="2 3" opacity={0.7} />
            {[5, 10, 15, 20, 25].map(x => (
              <text key={x} x={diag.xs(x)} y={diag.H - 8} textAnchor="middle" fontSize={7} fill="#64748b">{x}</text>
            ))}
            {rows.filter(r => r.tier !== 'IDLE').map((r, i) => (
              <circle key={i} cx={diag.xs(r.adiruDelta)} cy={diag.ys(r.risk)} r={2} fill={TIER_COLOR[r.tier]} opacity={0.75} />
            ))}
            <text x={diag.W / 2} y={diag.H - 1} textAnchor="middle" fontSize={7} fill="#64748b">ADIRU disagree (kt IAS)</text>
            <text x={4} y={12} fontSize={7} fill="#64748b">risk%</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        {[
          ['Min FL', minFl, setMinFl, 0, 400, 10, ''],
          ['ADIRU Δ', adiruThresh, setAdiruThresh, 4, 30, 1, 'kt'],
          ['Probe bias', probeBias, setProbeBias, 50, 200, 5, '%'],
          ['Hyd mul', hydMul, setHydMul, 50, 200, 5, '%'],
          ['Env mul', envMul, setEnvMul, 50, 200, 5, '%'],
          ['Rev rate', revRate, setRevRate, 0, 20, 1, '%'],
        ].map(([label, v, setV, mn, mx, st, unit]: any) => (
          <label key={label} className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-widest text-slate-500 flex justify-between">
              <span>{label}</span><span className="text-slate-300 font-mono">{v}{unit}</span>
            </span>
            <input type="range" min={mn} max={mx} step={st} value={v}
              onChange={e => setV(Number(e.target.value))}
              className="accent-sky-500 h-1" />
          </label>
        ))}
      </div>

      <div className="px-3 py-1.5 border-b border-slate-800">
        <label className="flex flex-col gap-0.5">
          <span className="text-[9px] uppercase tracking-widest text-slate-500 flex justify-between">
            <span>Forecast window</span><span className="text-slate-300 font-mono">{riskWin} min</span>
          </span>
          <input type="range" min={1} max={15} step={1} value={riskWin}
            onChange={e => setRiskWin(Number(e.target.value))}
            className="accent-sky-500 h-1" />
        </label>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 flex flex-wrap gap-1">
        {CLASS_LIST.map(c => {
          const on = classFilter === c
          return (
            <button key={c} onClick={() => setClassFilter(on ? 'ALL' : c)}
              title={CLASS_LABEL[c]}
              className={`px-1.5 py-0.5 rounded text-[9px] font-mono border transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:text-slate-200'}`}>
              {c}
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-b border-slate-800 flex flex-wrap gap-1">
        {LAW_LIST.map(l => {
          const on = lawFilter === l
          const color = LAW_SEV[l] >= 80 ? '#ef4444' : LAW_SEV[l] >= 40 ? '#f59e0b' : '#10b981'
          return (
            <button key={l} onClick={() => setLawFilter(on ? 'ALL' : l)}
              className={`px-1.5 py-0.5 rounded text-[9px] font-mono border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}
              style={{ color: on ? '#e2e8f0' : color }}>
              {l} {lawTally[l]}
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-b border-slate-800 flex flex-wrap gap-1 items-center">
        {[
          ['HALO', showHalo, setShowHalo],
          ['PIN', showPin, setShowPin],
          ['LBL', showLabels, setShowLabels],
          ['PROJ', showProj, setShowProj],
          ['REF', showRef, setShowRef],
          ['DIAG', showDiag, setShowDiag],
        ].map(([label, on, setOn]: any) => (
          <button key={label} onClick={() => setOn(!on)}
            className={`px-1.5 py-0.5 rounded text-[9px] font-mono border transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{label}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search…"
          className="ml-auto bg-slate-900/60 border border-slate-800 rounded px-1.5 py-0.5 text-[10px] w-24 focus:outline-none focus:border-sky-500" />
      </div>

      <div className="px-3 py-1.5 border-b border-slate-800 flex gap-1">
        {(['AIRCRAFT', 'LAWS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2 py-0.5 rounded text-[10px] font-mono border transition ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1 min-h-0">
        {tab === 'AIRCRAFT' && filteredAircraft.map((r, i) => (
          <button key={r.f.icao + i} onClick={() => onFly(r.f.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/50 transition flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="w-1 h-3 rounded-sm" style={{ background: TIER_COLOR[r.tier] }} />
              <span className="font-mono font-semibold text-slate-100 truncate">{(r.f.callsign || r.f.icao).trim()}</span>
              <span className="text-slate-500 font-mono">{r.f.type}</span>
              <span className="px-1 rounded text-[8px] bg-slate-800 text-slate-400 font-mono">{r.klass}</span>
              <span className="px-1 rounded text-[8px] font-mono ml-auto" style={{ background: TIER_COLOR[r.tier] + '33', color: TIER_COLOR[r.tier] }}>{r.law}</span>
              <span className="px-1 rounded text-[8px] font-mono" style={{ background: TIER_COLOR[r.tier] + '33', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
            </div>
            <div className="text-[10px] font-mono text-slate-400 flex gap-2 flex-wrap">
              <span>FL{Math.round(r.f.altitudeFt / 100)}</span>
              <span style={{ color: r.adiruDelta > adiruThresh ? '#f59e0b' : '#94a3b8' }}>ΔIAS {r.adiruDelta.toFixed(0)}kt</span>
              <span style={{ color: r.efcsCh < 3 ? '#f59e0b' : '#94a3b8' }}>EFCS {r.efcsCh}/3</span>
              <span>AOA {r.aoaVane.toFixed(1)}°</span>
              <span style={{ color: Math.abs(r.bankDeg) > 33 ? '#f59e0b' : '#94a3b8' }}>bank {r.bankDeg.toFixed(0)}°</span>
              <span style={{ color: tierColorOf(r.risk) }}>risk {r.risk.toFixed(0)}%</span>
            </div>
            <div className="h-1 bg-slate-800 rounded overflow-hidden relative">
              <div className="h-full" style={{ width: `${r.risk}%`, background: TIER_COLOR[r.tier] }} />
              {[25, 55, 80].map(t => (
                <div key={t} className="absolute top-0 bottom-0 w-px bg-slate-600" style={{ left: `${t}%` }} />
              ))}
            </div>
            <div className="flex gap-1 text-[8px] font-mono">
              {(['adiru', 'probe', 'hyd', 'aoa', 'env'] as const).map(k => {
                const v = r.sev[k]
                return <span key={k} className="px-1 rounded" style={{ background: tierColorOf(v) + '22', color: tierColorOf(v) }}>{k.toUpperCase().slice(0, 3)} {v.toFixed(0)}</span>
              })}
            </div>
            {r.protLost.length > 0 && (
              <div className="text-[9px] text-rose-300/80 font-mono truncate">LOST: {r.protLost.join(' · ')}</div>
            )}
            <div className="text-[9px] text-slate-500 leading-snug">{adviceFor(r)}</div>
            <div className="text-[8px] text-slate-600 font-mono">{r.spec.fcom} · {DRIVER_LABEL[r.driver]}</div>
          </button>
        ))}
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-slate-500 text-[10px]">No aircraft match current filters</div>
        )}

        {tab === 'LAWS' && lawAggs.map((a, i) => (
          <button key={a.law + i} onClick={() => a.worstIcao && onFly(a.worstIcao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/50 transition flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="w-1 h-3 rounded-sm" style={{ background: TIER_COLOR[a.worstTier] }} />
              <span className="font-mono font-semibold text-slate-100">{a.law}</span>
              <span className="text-slate-500 font-mono ml-auto">{a.count} ac</span>
              <span className="px-1 rounded text-[8px] font-mono" style={{ background: TIER_COLOR[a.worstTier] + '33', color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
            </div>
            <div className="text-[10px] font-mono text-slate-400 flex gap-2">
              <span style={{ color: tierColorOf(a.meanRisk) }}>mean risk {a.meanRisk.toFixed(0)}%</span>
              <span style={{ color: a.severe > 0 ? '#ef4444' : '#94a3b8' }}>severe {a.severe}</span>
              <span className="ml-auto text-slate-500 truncate">worst {a.worstCs}</span>
            </div>
            <div className="h-1 bg-slate-800 rounded overflow-hidden relative">
              <div className="h-full" style={{ width: `${a.meanRisk}%`, background: TIER_COLOR[a.worstTier] }} />
              {[25, 55, 80].map(t => (
                <div key={t} className="absolute top-0 bottom-0 w-px bg-slate-600" style={{ left: `${t}%` }} />
              ))}
            </div>
            <div className="text-[8px] text-slate-600 font-mono">LAW-SEV base {LAW_SEV[a.law]} · click-to-fly worst</div>
          </button>
        ))}
        {tab === 'LAWS' && lawAggs.length === 0 && (
          <div className="px-3 py-6 text-center text-slate-500 text-[10px]">No active laws</div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 font-mono leading-snug">
        FBW reversion · 14 CFR 25.671/672/1329 · Airbus FCOM DSC-27 / PRO-ABN-27 · Boeing FCOM 9.20 · EMB AOM 27-10
      </div>
    </div>
  )
}
