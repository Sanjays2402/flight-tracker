'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   ULB / CVR / FDR Underwater Locator Beacon
   Battery End-of-Life & Recorder Health Monitor (ATA-31-30)
   -----------------------------------------------------------
   Per-airframe simulation of Cockpit Voice Recorder (CVR) /
   Flight Data Recorder (FDR) / Quick-Access Recorder (QAR)
   subsystem health, with explicit modelling of the underwater
   locator beacon (ULB) battery end-of-life (EOL) date, ping
   detection range vs sea-state / depth, and the post-AF447
   90-day extended-pinger mandate per ICAO Annex 6 Pt I App 8.

   Regulatory & operational basis:
     · ICAO Annex 6 Pt I App 8 — Flight Recorders
     · ICAO Annex 6 Pt I §6.3.1.2 — ULB 90-day battery
       (effective 1-Jan-2018 post-AF447 ASAGA / BEA F-PG)
     · ICAO Annex 6 Pt I §6.3.1.3 — 25-h CVR (effective
       1-Jan-2021 new builds) & 2-h legacy
     · ICAO Annex 13 §5.10 — Wreckage and flight recorders
     · ICAO Doc 9756 Pt III — Investigation of accidents
     · ICAO Doc 10054 — Manual on FDR / CVR / AIR Maintenance
     · 14 CFR 25.1457 — CVR install / 25.1459 FDR install
     · 14 CFR 121.359 CVR / 121.343 FDR / 121.344 FDR params
     · 14 CFR 91.609 / 91.1045 / 135.151 CVR operating rules
     · 14 CFR 121.342 Pitot heat / 25.1457(d) ULB
     · TSO-C121b — ULB Underwater Locator Equipment (37.5 kHz
       ±1 kHz nominal; new 8.8 kHz LF-ULB per Annex 6 6.3.4)
     · TSO-C123c — CVR / TSO-C124c — FDR
     · RTCA DO-160G — environmental qualification
     · RTCA DO-178C / DO-254 — recorder software / hardware
     · EUROCAE ED-112A — Minimum Operational Performance
       Specification for Crash-Protected Airborne Recorder
       Systems (90-day ULB Section II-7 / 8.8 kHz LF-ULB)
     · EUROCAE ED-155 — Lightweight Recorders
     · EASA CS-25.1457 / .1459 / AMC 25.1457
     · EASA Decision 2015/021/R — 90-day ULB & LF-ULB
     · NTSB AAR-10/03 — recorder data overwrite
     · BEA Rapport Final f-cp090601 AF447 A330-203 (2012)
       → triggered Annex 6 90-day ULB & LF-ULB amendments
     · ATSB AE-2014-054 MH370 (B777) — flight tracking /
       4-min GADSS streaming (Annex 6 §6.18)
     · Honeywell / GE / Curtiss-Wright DFDR / SSCVR
     · Dukane DK100 / DK120 ULB / Acoustical Engineering
       150-day prototype / Boeing SB 23-1226 LF-ULB retrofit
     · ARINC 717 — DFDR data frame / ARINC 757 CVR /
       ARINC 767 enhanced airborne flight recorder (EAFR)

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash of ICAO24 synthesises
        stable ULB install date / battery EOL date / ULB type
        37.5 kHz HF vs 8.8 kHz LF, recorder generation, CVR
        duration 2-h vs 25-h, FDR parameter count vs 25.1459
        88-param minimum.
     2. 6-class recorder catalogue (HVY-Q / HVY / NRW / RGN /
        BIZ / TBP) bias toward EAFR vs SSCVR/DFDR pairs, with
        nominal CVR-hours, FDR-params, ULB-type, recorder-MX
        interval.
     3. Battery age days = today - install + age-bias slider.
        Battery remaining days = certBatteryDays - age.
        Cert duration: 90 days HF post-Annex 6 / 30 days legacy
        TSO-C121a / scaled by BAT-MUL slider 50-200%.
     4. Acoustic propagation: 37.5 kHz HF source level 160.5
        dB re 1 µPa @ 1 m, spherical-spreading transmission
        loss TL = 20·log10(r_m) + α·r_km, α ≈ 8 dB/km HF /
        0.4 dB/km LF per Francois-Garrison absorption. Sea
        state noise floor NL = 60 + 20·log10(SS+1) dB. SNR
        margin vs +6 dB detection threshold per TSO-C121b
        scaled by SEA-STATE slider 0-7 Douglas.
     5. CVR data-loss risk: overwrite probability based on
        elapsed flight time vs CVR-hours (2 vs 25). FDR
        parameter coverage gap vs 25.1459 88-param minimum.
     6. GADSS streaming compliance: 1-min cruise / 4-min
        autonomous distress signal per Annex 6 §6.18, gated
        by SATCOM / ACARS link state hash-stable per icao.
     7. 5 risk drivers max-driver composite:
        · BAT  ULB battery remaining days vs cert window
        · DET  detection range vs ocean depth (3800 m AF447)
        · CVR  CVR duration vs flight time (overwrite risk)
        · FDR  FDR parameter count vs 25.1459 88-min
        · GAD  GADSS 4-min streaming compliance
     8. Phase-weighted score = max-driver * phase-mul + 0.10
        * secondary. Hard escalation: ULB-EOL <30 days at
        oceanic ETOPS → ≥85 (AF447 tier). LF-ULB absent at
        oceanic → ≥70 (MH370 tier).

   Output:
     · 5 tiers AF447 / MH370 / EOL-WATCH / RECORDER-OK / IDLE
     · MapLibre overlay: tier halos, AF447 pin, ETOPS-oceanic
       projection, dashed great-circle from aircraft to nearest
       wreckage-recovery search box for AF447 tier
     · Side panel: tier counter strip, 5-cell summary, 6
       sliders, 6-class chip filter, AIRCRAFT / CLASSES tabs
     · Per-aircraft row: ULB-type pill, BAT-days tier-coloured,
       CVR-h pill, FDR-params pill, GADSS pill, advice link

   Layers > Safety & Traffic.
   Persisted: ft-ulb
   ============================================================ */

interface UlbFlight {
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
  flights: UlbFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'AF447' | 'MH370' | 'EOLWATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  AF447: '#ef4444', MH370: '#f59e0b', EOLWATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_LABEL: Record<Tier, string> = {
  AF447: 'AF447', MH370: 'MH370', EOLWATCH: 'EOL-WATCH', OK: 'REC-OK', IDLE: 'IDLE',
}
const TIER_ORDER: Tier[] = ['AF447', 'MH370', 'EOLWATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { AF447: 0, MH370: 1, EOLWATCH: 2, OK: 3, IDLE: 4 }

type AcClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const CLASS_LIST: AcClass[] = ['HVY-Q', 'HVY', 'NRW', 'RGN', 'BIZ', 'TBP']
const CLASS_LABEL: Record<AcClass, string> = {
  'HVY-Q': 'Heavy quad', HVY: 'Heavy twin', NRW: 'Narrowbody', RGN: 'Regional', BIZ: 'Bizjet', TBP: 'Turboprop',
}

type UlbType = 'HF' | 'LF' | 'DUAL' | 'NONE'
type RecGen = 'EAFR' | 'SSCVR-FDR' | 'DFDR-CVR'

interface RecSpec {
  family: string
  recGen: RecGen
  cvrHours: number      // 2 or 25
  fdrParams: number     // count vs CFR 25.1459 88-min
  ulbType: UlbType
  certBatDays: number   // 90 post-Annex 6 / 30 legacy
  hasGadss: boolean     // Annex 6 §6.18 streaming
}

const CLASS_SPEC: Record<AcClass, RecSpec> = {
  'HVY-Q': { family: '747-8 / A380 / A340',    recGen: 'EAFR',       cvrHours: 25, fdrParams: 1100, ulbType: 'DUAL', certBatDays: 90, hasGadss: true  },
  HVY:    { family: '777 / 787 / A350 / A330', recGen: 'EAFR',       cvrHours: 25, fdrParams: 950,  ulbType: 'DUAL', certBatDays: 90, hasGadss: true  },
  NRW:    { family: '737NG-MAX / A320 / 757',  recGen: 'SSCVR-FDR',  cvrHours: 2,  fdrParams: 380,  ulbType: 'HF',   certBatDays: 90, hasGadss: false },
  RGN:    { family: 'CRJ / E-Jet / ATR',       recGen: 'SSCVR-FDR',  cvrHours: 2,  fdrParams: 180,  ulbType: 'HF',   certBatDays: 90, hasGadss: false },
  BIZ:    { family: 'GLF / FA7X / CL30',       recGen: 'SSCVR-FDR',  cvrHours: 2,  fdrParams: 120,  ulbType: 'HF',   certBatDays: 90, hasGadss: false },
  TBP:    { family: 'PT6 / PW150 / Q400',      recGen: 'DFDR-CVR',   cvrHours: 0.5,fdrParams: 88,   ulbType: 'HF',   certBatDays: 30, hasGadss: false },
}

type Driver = 'BAT' | 'DET' | 'CVR' | 'FDR' | 'GAD' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  BAT: 'ULB battery remaining', DET: 'Acoustic detection range', CVR: 'CVR duration / overwrite',
  FDR: 'FDR parameter coverage', GAD: 'GADSS 4-min streaming', NONE: 'Nominal',
}

type Phase = 'OCEANIC' | 'ETOPS' | 'ENROUTE' | 'TERMINAL'
const PHASE_MUL: Record<Phase, number> = { OCEANIC: 1.35, ETOPS: 1.20, ENROUTE: 1.00, TERMINAL: 0.85 }

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|A38|A34|IL96/.test(t)) return 'HVY-Q'
  if (/B77|B78|A33|A35|MD11/.test(t)) return 'HVY'
  if (/B73|A31|A319|A32|A22|B75|MD8|B71/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E27|E29|E[12]7|E[12]9|F70|F100|AT[47]|DH[48]/.test(t)) return 'RGN'
  if (/G[VI458]|GLF|GLEX|FA[78]X|F2TH|CL30|CL60|C68|C75|BE40|H25|LJ/.test(t)) return 'BIZ'
  return 'TBP'
}

function classifyPhase(lat: number, lng: number, alt: number): Phase {
  // Crude oceanic detection: deep ocean basins
  const absLat = Math.abs(lat)
  const oceanic =
    // North Atlantic NAT-OTS
    (absLat > 30 && absLat < 65 && lng > -50 && lng < -10 && lat > 35) ||
    // North Pacific
    (lat > 20 && lat < 55 && lng > 150) || (lat > 20 && lat < 55 && lng < -130) ||
    // South Atlantic AF447 zone
    (lat < 5 && lat > -25 && lng > -35 && lng < 0) ||
    // South Pacific MH370 zone
    (lat < -10 && lng > 80 && lng < 130) ||
    // Indian Ocean
    (lat < 5 && lat > -40 && lng > 50 && lng < 100)
  if (oceanic && alt > 25000) return 'OCEANIC'
  if (alt > 30000) return 'ETOPS'
  if (alt > 10000) return 'ENROUTE'
  return 'TERMINAL'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

// Acoustic detection range — solve TL = SL - NL - DT for r
// SL = 160.5 dB HF / 158 dB LF; DT = +6 dB; alpha HF 8 dB/km, LF 0.4 dB/km
function detectionRangeM(ulb: UlbType, seaState: number, depthM: number): number {
  if (ulb === 'NONE') return 0
  const SL = ulb === 'LF' ? 158 : ulb === 'DUAL' ? 161 : 160.5
  const NL = 60 + 20 * Math.log10(seaState + 1)
  const DT = 6
  const alpha = ulb === 'LF' ? 0.4 : ulb === 'DUAL' ? 1.5 : 8 // dB/km
  const budget = SL - NL - DT
  // budget = 20 log10(r_m) + alpha * r_m / 1000
  // Solve iteratively
  let r = 1000
  for (let i = 0; i < 40; i++) {
    const tl = 20 * Math.log10(r) + alpha * r / 1000
    const err = budget - tl
    if (Math.abs(err) < 0.1) break
    r = r * Math.pow(10, err / 40)
  }
  return Math.max(0, Math.min(r, depthM * 2.5))
}

interface Row {
  f: UlbFlight
  klass: AcClass
  spec: RecSpec
  phase: Phase
  ulbType: UlbType
  cvrHours: number
  fdrParams: number
  batRemainDays: number
  batAgeDays: number
  certBatDays: number
  detRangeM: number
  oceanDepthM: number
  flightHours: number
  gadssOK: boolean
  isOceanic: boolean
  sev: { bat: number; det: number; cvr: number; fdr: number; gad: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'ulb-halo', SRC_LBL = 'ulb-lbl', SRC_PIN = 'ulb-pin', SRC_PROJ = 'ulb-proj', SRC_REF = 'ulb-ref', SRC_SEARCH = 'ulb-search'
const LYR_HALO = 'ulb-halo-l', LYR_LBL = 'ulb-lbl-l', LYR_PIN = 'ulb-pin-l', LYR_PROJ = 'ulb-proj-l', LYR_REF = 'ulb-ref-l', LYR_SEARCH = 'ulb-search-l'

// Historic wreckage-search boxes
const SEARCH_BOXES: Array<{ name: string; lat: number; lng: number; r: number }> = [
  { name: 'AF447',  lat:  3.04, lng: -30.55, r: 3.0 },
  { name: 'MH370',  lat: -38.0, lng: 90.0,   r: 6.5 },
  { name: 'AF066',  lat: 60.0,  lng: -45.0,  r: 2.0 },
  { name: 'SQ006',  lat: 25.0,  lng: 121.0,  r: 1.2 },
]

export default function UlbPingerMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(100)
  const [ageBias, setAgeBias] = useState(0)     // days +/- shift
  const [batMul, setBatMul] = useState(100)     // 50..200 of cert window
  const [seaState, setSeaState] = useState(3)   // Douglas 0..7
  const [depthMul, setDepthMul] = useState(100) // 50..200% of nominal ocean depth
  const [phaseWt, setPhaseWt] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showSearch, setShowSearch] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const today = Date.now() / 86400e3
    for (const f of flights) {
      if (!isFinite(f.altitudeFt)) continue
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl) continue
      const phase = classifyPhase(f.lat, f.lng, f.altitudeFt)
      const klass = classifyClass(f.type || '')
      const spec = CLASS_SPEC[klass]
      const h = hash32(f.icao || '')

      const r0 = (h & 0xffff) / 0xffff
      const r1 = ((h >>> 8) & 0xffff) / 0xffff
      const r2 = ((h >>> 16) & 0xffff) / 0xffff

      // Battery age: install was 0..(cert*1.4) days ago
      const certDays = spec.certBatDays * (batMul / 100)
      const batAgeDays = Math.max(0, r0 * certDays * 1.25 + ageBias)
      const batRemainDays = certDays - batAgeDays

      // Ocean depth nominal 3000 m if oceanic phase, else 200 m for shelf
      const oceanDepthM = (phase === 'OCEANIC' ? 3800 : phase === 'ETOPS' ? 1500 : 200) * (depthMul / 100)

      const ulbType = spec.ulbType
      const detRangeM = detectionRangeM(ulbType, seaState, oceanDepthM)

      // Flight time hash-stable 0.5..14 h
      const flightHours = 0.5 + r1 * 13.5
      // GADSS hash-stable 90% nominal if equipped
      const gadssOK = spec.hasGadss && r2 > 0.10

      // Severities
      const batSev = batRemainDays <= 0 ? 100 :
                     batRemainDays <= 7 ? 90 :
                     batRemainDays <= 30 ? 65 :
                     batRemainDays <= 60 ? 30 : 0
      const detRatio = detRangeM / Math.max(500, oceanDepthM)
      const detSev = detRatio >= 1.5 ? 0 : detRatio >= 1.0 ? (1.5 - detRatio) / 0.5 * 25 :
                     detRatio >= 0.5 ? 25 + (1.0 - detRatio) / 0.5 * 45 : 70 + (0.5 - detRatio) / 0.5 * 30
      const cvrRatio = flightHours / Math.max(0.5, spec.cvrHours)
      const cvrSev = cvrRatio <= 1.0 ? 0 : cvrRatio <= 2.0 ? (cvrRatio - 1.0) * 40 :
                     cvrRatio <= 5.0 ? 40 + (cvrRatio - 2.0) / 3.0 * 40 : 80
      const fdrGap = Math.max(0, 88 - spec.fdrParams)
      const fdrSev = spec.fdrParams >= 800 ? 0 : spec.fdrParams >= 300 ? 10 :
                     spec.fdrParams >= 150 ? 30 : spec.fdrParams >= 88 ? 50 : 80
      const gadSev = !spec.hasGadss ? (phase === 'OCEANIC' ? 65 : 25) :
                     !gadssOK ? 55 : 0

      const sev = { bat: batSev, det: detSev, cvr: cvrSev, fdr: fdrSev, gad: gadSev }
      const drivers: Array<[Driver, number]> = [['BAT', batSev], ['DET', detSev], ['CVR', cvrSev], ['FDR', fdrSev], ['GAD', gadSev]]
      drivers.sort((a, b) => b[1] - a[1])
      const driver: Driver = drivers[0][1] >= 12 ? drivers[0][0] : 'NONE'

      const phaseMul = 1 + ((PHASE_MUL[phase] - 1) * (phaseWt / 100))
      const max = drivers[0][1]
      const secondary = drivers[1][1]
      let score = Math.min(100, Math.max(0, max * phaseMul + 0.10 * secondary))

      // Hard escalations
      const isOceanic = phase === 'OCEANIC'
      if (batRemainDays < 30 && isOceanic) score = Math.max(score, 85)
      if (ulbType === 'HF' && isOceanic && oceanDepthM > 3000) score = Math.max(score, 70)
      if (batRemainDays <= 0) score = Math.max(score, 88)

      let tier: Tier
      if (fl < minFl) tier = 'IDLE'
      else if (score >= 82) tier = 'AF447'
      else if (score >= 60) tier = 'MH370'
      else if (score >= 28) tier = 'EOLWATCH'
      else tier = 'OK'

      out.push({ f, klass, spec, phase, ulbType, cvrHours: spec.cvrHours, fdrParams: spec.fdrParams, batRemainDays, batAgeDays, certBatDays: certDays, detRangeM, oceanDepthM, flightHours, gadssOK, isOceanic, sev, score, driver, tier })
    }
    return out
  }, [flights, minFl, ageBias, batMul, seaState, depthMul, phaseWt])

  const tierCount: Record<Tier, number> = { AF447: 0, MH370: 0, EOLWATCH: 0, OK: 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++

  const meanBatDays = rows.length ? rows.reduce((a, r) => a + r.batRemainDays, 0) / rows.length : 0
  const oceanicShare = rows.length ? rows.filter(r => r.isOceanic).length / rows.length : 0
  const eolCount = rows.filter(r => r.batRemainDays <= 30).length
  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null
  const lfShare = rows.length ? rows.filter(r => r.ulbType === 'LF' || r.ulbType === 'DUAL').length / rows.length : 0
  const gadssShare = rows.length ? rows.filter(r => r.spec.hasGadss).length / rows.length : 0

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
    for (const r of rows) { const e = m.get(r.klass) || []; e.push(r); m.set(r.klass, e) }
    const arr: Array<{ klass: AcClass; spec: RecSpec; ac: number; af: number; mh: number; eol: number; worstTier: Tier; meanScore: number; meanBat: number; worstCs: string }> = []
    for (const [k, v] of m) {
      const wt = v.reduce((a, r) => TIER_RANK[r.tier] < TIER_RANK[a] ? r.tier : a, 'IDLE' as Tier)
      const ms = v.reduce((a, r) => a + r.score, 0) / v.length
      const mb = v.reduce((a, r) => a + r.batRemainDays, 0) / v.length
      const af = v.filter(r => r.tier === 'AF447').length
      const mh = v.filter(r => r.tier === 'MH370').length
      const eol = v.filter(r => r.batRemainDays <= 30).length
      const wc = v.slice().sort((a, b) => b.score - a.score)[0]
      arr.push({ klass: k, spec: CLASS_SPEC[k], ac: v.length, af, mh, eol, worstTier: wt, meanScore: ms, meanBat: mb, worstCs: wc?.f.callsign || wc?.f.icao || '' })
    }
    arr.sort((a, b) => TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier] || b.af - a.af)
    return arr
  }, [rows])

  useEffect(() => {
    if (!map) return
    const ensureSource = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    }
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_PROJ, SRC_REF, SRC_SEARCH]
    sources.forEach(ensureSource)

    if (!map.getLayer(LYR_REF)) {
      map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.16, 'line-width': 0.8, 'line-dasharray': [2, 4] } })
    }
    if (!map.getLayer(LYR_SEARCH)) {
      map.addLayer({ id: LYR_SEARCH, type: 'line', source: SRC_SEARCH, paint: { 'line-color': '#ef4444', 'line-opacity': 0.55, 'line-width': 1.2, 'line-dasharray': [3, 2] } })
    }
    if (!map.getLayer(LYR_PROJ)) {
      map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.6, 'line-dasharray': [1.5, 2] } })
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
      if (showPin && r.tier === 'AF447') {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLabels && (r.tier === 'AF447' || r.tier === 'MH370')) {
        const label = `${r.f.callsign || r.f.icao} · ULB-${r.ulbType} · BAT ${r.batRemainDays.toFixed(0)}d`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showProj && r.isOceanic && (r.tier === 'AF447' || r.tier === 'MH370')) {
        // Project to nearest historic search box
        let best = SEARCH_BOXES[0]; let bestD = Infinity
        for (const s of SEARCH_BOXES) {
          const d = Math.hypot(s.lat - r.f.lat, s.lng - r.f.lng)
          if (d < bestD) { bestD = d; best = s }
        }
        const steps = 14
        for (let i = 0; i < steps; i++) {
          if (i % 2 === 1) continue
          const t0 = i / steps, t1 = (i + 1) / steps
          const p0: [number, number] = [r.f.lng + (best.lng - r.f.lng) * t0, r.f.lat + (best.lat - r.f.lat) * t0]
          const p1: [number, number] = [r.f.lng + (best.lng - r.f.lng) * t1, r.f.lat + (best.lat - r.f.lat) * t1]
          proj.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [p0, p1] }, properties: { color } })
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

    const searchFeats: any[] = []
    if (showSearch) {
      for (const s of SEARCH_BOXES) {
        const coords: [number, number][] = []
        for (let a = 0; a <= 360; a += 18) {
          const rad = a * Math.PI / 180
          coords.push([s.lng + s.r * Math.cos(rad) / Math.max(0.2, Math.cos(s.lat * Math.PI / 180)), s.lat + s.r * Math.sin(rad)])
        }
        searchFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { name: s.name } })
      }
    }

    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_PROJ) as any).setData({ type: 'FeatureCollection', features: proj })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: refFeats })
    ;(map.getSource(SRC_SEARCH) as any).setData({ type: 'FeatureCollection', features: searchFeats })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_REF, LYR_SEARCH]) { if (m.getLayer(id)) m.removeLayer(id) }
      for (const id of sources) { if (m.getSource(id)) m.removeSource(id) }
    }
  }, [map, rows, showHalo, showPin, showLabels, showProj, showRef, showSearch])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{TIER_LABEL[t]}</span>
  )
  const driverBadge = (d: Driver, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const ulbPill = (u: UlbType) => {
    const col = u === 'NONE' ? '#ef4444' : u === 'HF' ? '#f59e0b' : u === 'LF' ? '#0ea5e9' : '#10b981'
    return <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '66', backgroundColor: col + '14' }}>ULB-{u}</span>
  }

  const advice = (r: Row) => {
    if (r.tier === 'AF447') {
      if (r.batRemainDays <= 0) return 'ULB BATTERY EXPIRED — recorder unrecoverable in deep-ocean wreckage scenario · MX immediate per Annex 6 Pt I App 8 §II-7 / TSO-C121b · ground until replacement'
      return 'ULB EOL <30 days at oceanic phase · post-AF447 BEA finding · battery replacement next A-check per ED-112A §II-7 / Boeing SB 23-1226'
    }
    if (r.tier === 'MH370') {
      if (r.ulbType === 'HF') return 'HF-only 37.5 kHz ULB in deep ocean — detection range collapses below depth · LF-ULB 8.8 kHz retrofit per Annex 6 §6.3.4 / EASA Decision 2015/021/R'
      return 'GADSS streaming non-compliant — fit autonomous 4-min distress per Annex 6 §6.18 post-MH370 ATSB AE-2014-054'
    }
    if (r.tier === 'EOLWATCH') return 'ULB battery within 60-day window or FDR parameter coverage marginal — schedule recorder bench-test per Doc 10054'
    return 'CVR/FDR/ULB compliant — 25-h CVR + 90-day ULB per Annex 6 Pt I App 8 / 14 CFR 25.1457'
  }

  const W = 280, H = 180
  const xMax = 120 // battery remaining days
  const yMax = 8000 // detection range m
  const sx = (v: number) => 30 + (Math.min(xMax, Math.max(0, v)) / xMax) * (W - 40)
  const sy = (v: number) => H - 24 - (Math.min(yMax, Math.max(0, v)) / yMax) * (H - 48)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">ULB · CVR/FDR Battery & Recorder Health</div>
          <div className="text-[10px] text-slate-500">ATA 31-30 · Annex 6 Pt I App 8 · TSO-C121b · BEA AF447 · ATSB MH370</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[10px] font-semibold" style={{ color: TIER_COLOR[t] }}>{TIER_LABEL[t]}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean BAT days</div>
          <div className="text-sm font-semibold" style={{ color: meanBatDays < 30 ? '#ef4444' : meanBatDays < 60 ? '#f59e0b' : '#10b981' }}>{meanBatDays.toFixed(0)}d</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst aircraft</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">EOL ≤30d</div>
          <div className="text-sm font-semibold" style={{ color: eolCount > 0 ? '#ef4444' : '#10b981' }}>{eolCount}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Oceanic share</div>
          <div className="text-xs font-semibold" style={{ color: oceanicShare > 0.30 ? '#f59e0b' : '#10b981' }}>{(oceanicShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">LF-ULB equip</div>
          <div className="text-xs font-semibold" style={{ color: lfShare < 0.40 ? '#f59e0b' : '#10b981' }}>{(lfShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">GADSS equip</div>
          <div className="text-xs font-semibold" style={{ color: gadssShare < 0.40 ? '#f59e0b' : '#10b981' }}>{(gadssShare * 100).toFixed(0)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W-40} height={H-48} fill="#0b1220" />
            {/* Quadrants: EOL window */}
            <rect x={sx(0)} y={24} width={sx(30) - sx(0)} height={H - 48} fill="#ef4444" opacity={0.08} />
            <rect x={sx(30)} y={24} width={sx(60) - sx(30)} height={H - 48} fill="#f59e0b" opacity={0.06} />
            {/* 90-day threshold */}
            <line x1={sx(90)} y1={24} x2={sx(90)} y2={H - 24} stroke="#10b981" strokeDasharray="3 3" strokeOpacity={0.6} />
            <text x={sx(90) + 4} y={36} fontSize={8} fill="#10b981">90d Annex 6</text>
            <line x1={sx(30)} y1={24} x2={sx(30)} y2={H - 24} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.55} />
            <text x={sx(30) + 4} y={36} fontSize={8} fill="#ef4444">EOL 30d</text>
            {/* Ocean depth reference */}
            <line x1={sx(0)} y1={sy(3800)} x2={sx(xMax)} y2={sy(3800)} stroke="#0ea5e9" strokeDasharray="3 3" strokeOpacity={0.5} />
            <text x={W - 8} y={sy(3800) - 4} fontSize={8} fill="#0ea5e9" textAnchor="end">AF447 3800m</text>
            {rows.map((r, i) => (
              <circle key={i} cx={sx(r.batRemainDays)} cy={sy(r.detRangeM)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
            <text x={W/2} y={H-6} fontSize={9} fill="#64748b" textAnchor="middle">battery-days vs detection-range (m)</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">AGE-BIAS {ageBias > 0 ? '+' : ''}{ageBias}d</span><input type="range" min={-60} max={120} value={ageBias} onChange={e => setAgeBias(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">BAT-MUL {batMul}%</span><input type="range" min={50} max={200} value={batMul} onChange={e => setBatMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">SEA-STATE {seaState}</span><input type="range" min={0} max={7} value={seaState} onChange={e => setSeaState(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">DEPTH-MUL {depthMul}%</span><input type="range" min={50} max={200} value={depthMul} onChange={e => setDepthMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setClassFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${classFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {CLASS_LIST.map(c => (
          <button key={c} onClick={() => setClassFilter(classFilter === c ? 'ALL' : c)} className={`px-2 py-0.5 rounded text-[10px] border ${classFilter===c?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>{c}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo],['PIN', showPin, setShowPin],['LBL', showLabels, setShowLabels],['PROJ', showProj, setShowProj],['REF', showRef, setShowRef],['SRCH', showSearch, setShowSearch],['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
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
              {ulbPill(r.ulbType)}
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{r.phase}</span>
              {r.isOceanic && <span className="px-1 py-px rounded text-[9px] bg-sky-500/15 text-sky-300 border border-sky-500/40">OCEANIC</span>}
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              FL{(r.f.altitudeFt/100).toFixed(0)} · {r.spec.recGen} · BAT <span style={{color: r.batRemainDays<=0?'#ef4444':r.batRemainDays<30?'#f59e0b':r.batRemainDays<60?'#0ea5e9':'#10b981'}}>{r.batRemainDays.toFixed(0)}/{r.certBatDays.toFixed(0)}d</span> · CVR {r.cvrHours}h · FDR {r.fdrParams}p · DET {(r.detRangeM/1000).toFixed(1)}km · DEPTH {(r.oceanDepthM/1000).toFixed(1)}km · FLT {r.flightHours.toFixed(1)}h
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('BAT', r.sev.bat)}
              {driverBadge('DET', r.sev.det)}
              {driverBadge('CVR', r.sev.cvr)}
              {driverBadge('FDR', r.sev.fdr)}
              {driverBadge('GAD', r.sev.gad)}
              {!r.spec.hasGadss && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/40">no-GADSS</span>}
              {r.spec.hasGadss && !r.gadssOK && <span className="px-1 py-px rounded text-[9px] bg-amber-500/15 text-amber-300 border border-amber-500/40">GADSS-LOST</span>}
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
              {ulbPill(c.spec.ulbType)}
              <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{c.ac} ac</span>
              {tierBadge(c.worstTier)}
            </div>
            <div className="px-2 text-[10px] text-slate-400">{c.spec.family} · {c.spec.recGen} · CVR {c.spec.cvrHours}h · FDR {c.spec.fdrParams}p · cert-BAT {c.spec.certBatDays}d · GADSS {c.spec.hasGadss ? 'Y' : 'N'} · mean-BAT {c.meanBat.toFixed(0)}d · AF447 {c.af} · MH370 {c.mh} · EOL {c.eol}</div>
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
        Refs: ICAO Annex 6 Pt I App 8 / §6.3.1.2 90-day ULB post-AF447 / §6.18 GADSS · Annex 13 §5.10 · Doc 9756 / 10054 · 14 CFR 25.1457 / 25.1459 / 121.343 / 121.359 · TSO-C121b ULB 37.5 kHz / LF 8.8 kHz · TSO-C123c CVR · TSO-C124c FDR · EUROCAE ED-112A §II-7 · ED-155 · EASA CS-25.1457 / AMC 25.1457 · EASA Decision 2015/021/R · BEA AF447 Final · ATSB AE-2014-054 MH370 · NTSB AAR-10/03 · Boeing SB 23-1226 LF-ULB · Dukane DK100/DK120 · ARINC 717/757/767 EAFR. Acoustic model: SL 160.5 dB HF / 158 dB LF re 1 µPa @ 1 m, TL spherical + Francois-Garrison absorption (8 dB/km HF, 0.4 dB/km LF), NL Knudsen sea-state.
      </div>
    </div>
  )
}
