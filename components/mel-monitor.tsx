'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   MEL / CDL Dispatch Deferral & Compliance Monitor
   -----------------------------------------------------------
   Watches every airborne aircraft and reconstructs its open
   Minimum Equipment List (MEL) and Configuration Deviation
   List (CDL) deferred items, tracking time-remaining against
   the FAA/EASA A/B/C/D repair category interval, dispatch
   restrictions imposed (ETOPS / Cat-II-III / RVSM / RNP /
   single-engine taxi), and the risk of a continuing-
   airworthiness breach if not closed before the interval
   expires.

   Regulatory & operational basis:
     · FAA AC 91-67 Minimum Equipment Requirements GA
     · FAA AC 120-77 Maintenance & Alteration MEL/CDL
     · FAA AC 25-19A Certification Maintenance Requirements
     · FAA Master MEL Policy Letters MMEL PL-25 / PL-110
     · 14 CFR 91.213 inoperative instruments and equipment
     · 14 CFR 121.628 inoperative instruments and equipment
     · 14 CFR 121.687 dispatch release
     · 14 CFR 135.179 inoperative instruments
     · EASA Part-MEL CAT.GEN.MPA.105 / NCC.IDE.A.105
     · EASA AMC/GM MEL Annex IV
     · ICAO Annex 6 Pt I 6.1.3 MMEL/MEL
     · Transport Canada CASS 605.07 Equipment Inoperative
     · Boeing AERO Q2-2017 MEL Dispatch
     · Airbus FAST Mag 56 MEL/CDL Operations
     · MMEL Cat A no specific interval per item proviso
     · MMEL Cat B 3 consecutive calendar days
     · MMEL Cat C 10 consecutive calendar days
     · MMEL Cat D 120 consecutive calendar days
     · CDL no repair interval; performance penalty per item

   Algorithm:
     1. Per airframe FNV-1a 32-bit hash drives deferred-item
        count 0..3 with per-class probability (HVY 0.42 / NRW
        0.55 / RGN 0.62 / BIZ 0.30 / TBP 0.48 / GA 0.20).
     2. Each deferred item is hash-selected from a 22-entry
        ATA-coded catalogue spanning ATA-21 (air-cond pack),
        ATA-22 (autopilot ch), ATA-23 (comm radio), ATA-24
        (gen), ATA-25 (slide), ATA-26 (fire bottle), ATA-27
        (slat asym), ATA-28 (fuel boost pump), ATA-29 (hyd
        pump), ATA-30 (anti-ice), ATA-31 (recorder), ATA-32
        (gear retract), ATA-33 (cabin light), ATA-34 (ADIRU /
        TCAS ch / weather radar), ATA-35 (O2 mask), ATA-36
        (bleed), ATA-38 (water), ATA-49 (APU), ATA-52 (door
        sensor), ATA-71 (engine), ATA-73 (FADEC ch), and a
        CDL panel-fairing item. Each entry carries category
        A/B/C/D, restrictions imposed, performance penalty
        kt or fuel-burn %, and base severity.
     3. Hours-since-deferral hash-stable 0..hourly cap
        scaled by FLEET-AGE slider 50-200pct.
     4. Days-remaining = intervalDays - hoursSinceDef/24.
        Negative = INTERVAL BREACH (14 CFR 91.213(c) /
        121.628(b)) — non-dispatchable until extension
        granted by POI per FAA Order 8900.1 Vol 4.
     5. Compute aggregate dispatch posture:
        · ETOPS-eligible (no APU OR pack OR generator MEL
          on ETOPS-equipped airframe)
        · Cat-II / III autoland (no autopilot ch / radalt /
          DH annunciator MEL)
        · RVSM (no altimeter / autopilot MEL)
        · RNP / RNAV (no FMS / GPS-receiver MEL)
        · single-engine taxi inhibited (hyd pump MEL)

   5 risk components composite = max-driver:
     INT   min days-remaining across open items vs interval
           sev 100 at <=0 (breach) ramping 0 at >=5 days
     CNT   count of open MEL items vs MEL-CNT-LIM slider sev
           0 below 1 ramping 100 at >=4
     RST   count of dispatch-restrictions imposed sev 0 at
           none ramping 100 at >=3 (no-ETOPS + no-CAT-III +
           single-eng-taxi = dispatch posture severely
           constrained per FCOM)
     CAT   worst category present: D 25 / C 45 / B 75 / A 90
           (A is no-interval but item-specific proviso — high
           risk if condition deteriorates)
     PEN   cumulative aerodynamic / engine perf penalty pct
           sev 0 below 0.5pct ramping 100 at >=4pct
           (CDL items + spoiler-panel + slat-asym etc.)

   Tier classification:
     BREACH score>=80 OR any item past interval rose —
            non-dispatchable per 14 CFR 121.628(b) / EASA
            CAT.GEN.MPA.105 file POI extension request
     RESTRICT score>=55 amber — operational restrictions
            imposed brief crew, monitor remaining interval
     WATCH  score>=25 sky — open deferrals within interval
            monitor MX availability at next port
     OK     score<25 emerald — all items within interval,
            no operational restriction
     IDLE   below MIN-FL or ground — slate

   MapLibre overlay:
     · Tier-coloured halo rings sized by score 8-22 px
     · Rose diamond pin at current pos for BREACH with
       category and days-remaining callout
     · Tier-coloured callsign + ATA code + days-rem label
       for RESTRICT / BREACH
     · 12-segment dashed forward-projection 50 nm tier-
       coloured for BREACH

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-DAYS-REM / WORST callsign+ATA / BREACH#
     · 2-cell OPEN-ITEMS-TOTAL / RESTRICTED-pct secondary
     · SVG days-remaining (x) vs item-count (y) scatter
       with rose breach band (x<=0), amber tight 0-3d,
       sky watch 3-7d, emerald nominal >7d
     · 6 sliders MIN-FL / FLEET-AGE / MEL-CNT-LIM / INT-
       BUF-DAYS / PEN-MUL / RST-WEIGHT
     · 7-class chip filter HVY/NRW/RGN/BIZ/TBP/GA/FTR
     · 4-category chip filter A/B/C/D
     · HALO/PIN/LBL/PROJ/REF/DIAG toggles + search
     · AIRCRAFT / ATA tab switcher
     · Aircraft tab: tier-coloured row with item breakdown
       chips, restriction pills, advice
     · ATA tab: grouped by ATA code, click-to-fly worst

   Layers > Safety & Traffic.
   Persisted: ft-mel
   ============================================================ */

interface MelFlight {
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
  flights: MelFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'BREACH' | 'RESTRICT' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  BREACH: '#ef4444', RESTRICT: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['BREACH', 'RESTRICT', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { BREACH: 0, RESTRICT: 1, WATCH: 2, OK: 3, IDLE: 4 }

type AcClass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const CLASS_LIST: AcClass[] = ['HVY', 'NRW', 'RGN', 'BIZ', 'TBP', 'GA', 'FTR']
const CLASS_LABEL: Record<AcClass, string> = {
  HVY: 'Heavy widebody', NRW: 'Narrowbody', RGN: 'Regional', BIZ: 'Bizjet', TBP: 'Turboprop', GA: 'General aviation', FTR: 'Military fighter',
}
const CLASS_DEF_PROB: Record<AcClass, number> = {
  HVY: 0.42, NRW: 0.55, RGN: 0.62, BIZ: 0.30, TBP: 0.48, GA: 0.20, FTR: 0.55,
}

type Cat = 'A' | 'B' | 'C' | 'D'
const CAT_DAYS: Record<Cat, number> = { A: 1, B: 3, C: 10, D: 120 }
const CAT_SEV: Record<Cat, number> = { A: 90, B: 75, C: 45, D: 25 }
const CAT_LIST: Cat[] = ['A', 'B', 'C', 'D']

type Restriction = 'NO-ETOPS' | 'NO-CAT-III' | 'NO-CAT-II' | 'NO-RVSM' | 'NO-RNP' | 'NO-AUTOLAND' | 'SINGLE-ENG-TAXI' | 'NO-NIGHT' | 'NO-IFR' | 'MAX-FL-RED' | 'PAYLOAD-RED'

interface MelItem {
  ata: string       // ATA-NN
  name: string      // short
  cat: Cat
  restr: Restriction[]
  perfPenPct: number // perf penalty pct
  baseSev: number
}

// 22-entry catalogue
const MEL_CATALOG: MelItem[] = [
  { ata: 'ATA-21', name: 'Air-cond pack 1', cat: 'C', restr: ['MAX-FL-RED'], perfPenPct: 0.0, baseSev: 30 },
  { ata: 'ATA-22', name: 'Autopilot channel B', cat: 'C', restr: ['NO-CAT-III', 'NO-AUTOLAND'], perfPenPct: 0.0, baseSev: 45 },
  { ata: 'ATA-23', name: 'VHF COM-2', cat: 'C', restr: ['NO-ETOPS'], perfPenPct: 0.0, baseSev: 35 },
  { ata: 'ATA-24', name: 'IDG / generator #2', cat: 'B', restr: ['NO-ETOPS'], perfPenPct: 0.2, baseSev: 70 },
  { ata: 'ATA-25', name: 'Cabin slide window', cat: 'D', restr: [], perfPenPct: 0.0, baseSev: 15 },
  { ata: 'ATA-26', name: 'Cargo fire bottle #2', cat: 'B', restr: ['NO-ETOPS'], perfPenPct: 0.0, baseSev: 75 },
  { ata: 'ATA-27', name: 'Slat asymmetry sensor', cat: 'C', restr: ['MAX-FL-RED'], perfPenPct: 0.3, baseSev: 55 },
  { ata: 'ATA-28', name: 'Fuel boost pump L', cat: 'C', restr: ['NO-ETOPS'], perfPenPct: 0.1, baseSev: 50 },
  { ata: 'ATA-29', name: 'Hyd pump #2', cat: 'B', restr: ['SINGLE-ENG-TAXI'], perfPenPct: 0.2, baseSev: 65 },
  { ata: 'ATA-30', name: 'Wing anti-ice valve', cat: 'C', restr: ['NO-ICING'] as any, perfPenPct: 0.1, baseSev: 50 },
  { ata: 'ATA-31', name: 'FDR / CVR', cat: 'C', restr: ['NO-ETOPS'], perfPenPct: 0.0, baseSev: 40 },
  { ata: 'ATA-32', name: 'Nose-gear steering ch', cat: 'C', restr: ['SINGLE-ENG-TAXI'], perfPenPct: 0.0, baseSev: 45 },
  { ata: 'ATA-33', name: 'Cabin emergency light row', cat: 'D', restr: [], perfPenPct: 0.0, baseSev: 15 },
  { ata: 'ATA-34', name: 'TCAS channel B', cat: 'C', restr: ['NO-RVSM'], perfPenPct: 0.0, baseSev: 55 },
  { ata: 'ATA-34', name: 'GPS receiver #2', cat: 'C', restr: ['NO-RNP'], perfPenPct: 0.0, baseSev: 50 },
  { ata: 'ATA-34', name: 'Weather radar', cat: 'B', restr: ['NO-IFR'], perfPenPct: 0.0, baseSev: 60 },
  { ata: 'ATA-35', name: 'O2 mask row 14', cat: 'D', restr: ['MAX-FL-RED'], perfPenPct: 0.0, baseSev: 25 },
  { ata: 'ATA-36', name: 'Bleed valve #1', cat: 'B', restr: ['MAX-FL-RED'], perfPenPct: 0.5, baseSev: 65 },
  { ata: 'ATA-49', name: 'APU starter / generator', cat: 'B', restr: ['NO-ETOPS'], perfPenPct: 0.3, baseSev: 70 },
  { ata: 'ATA-52', name: 'Door 2L sensor', cat: 'D', restr: [], perfPenPct: 0.0, baseSev: 20 },
  { ata: 'ATA-73', name: 'FADEC channel B eng 1', cat: 'A', restr: [], perfPenPct: 0.5, baseSev: 90 },
  { ata: 'CDL', name: 'Spoiler panel #4 missing', cat: 'C', restr: [], perfPenPct: 1.2, baseSev: 50 },
]

type Driver = 'INT' | 'CNT' | 'RST' | 'CAT' | 'PEN' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  INT: 'Interval near breach',
  CNT: 'Item-count saturation',
  RST: 'Dispatch restrictions',
  CAT: 'Worst-category present',
  PEN: 'Aero/engine perf penalty',
  NONE: 'Nominal',
}

function classifyClass(type: string, cat?: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|B77|B78|A33|A34|A35|A38/.test(t)) return 'HVY'
  if (/B73|A31|A319|A32|A22/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E27|E29|E[12]7|E[12]9|ATR/.test(t)) return 'RGN'
  if (/G[VI458]|GLF|GLEX|FA[78]X|F2TH|CL30|CL60|C68|C75|BE40|H25/.test(t)) return 'BIZ'
  if (/DH8|AT[47]|SF34|B190|BE20|C208/.test(t)) return 'TBP'
  if (/F15|F16|F18|F22|F35|EUFI|RFAL/.test(t)) return 'FTR'
  return 'GA'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

interface OpenItem {
  item: MelItem
  hoursSinceDef: number
  daysRem: number
}

interface Row {
  f: MelFlight
  klass: AcClass
  open: OpenItem[]
  totalRestr: Restriction[]
  perfPenPct: number
  worstCat: Cat | null
  minDaysRem: number
  score: number
  driver: Driver
  sev: { int: number; cnt: number; rst: number; cat: number; pen: number }
  tier: Tier
}

const SRC_HALO = 'mel-halo', SRC_LBL = 'mel-lbl', SRC_PIN = 'mel-pin', SRC_PROJ = 'mel-proj', SRC_REF = 'mel-ref'
const LYR_HALO = 'mel-halo-l', LYR_LBL = 'mel-lbl-l', LYR_PIN = 'mel-pin-l', LYR_PROJ = 'mel-proj-l', LYR_REF = 'mel-ref-l'

export default function MelMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'ATA'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [catFilter, setCatFilter] = useState<Cat | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(20)
  const [fleetAge, setFleetAge] = useState(100)        // 50..200
  const [cntLim, setCntLim] = useState(4)              // 1..6
  const [intBufDays, setIntBufDays] = useState(5)      // 1..15
  const [penMul, setPenMul] = useState(100)            // 50..200
  const [rstWeight, setRstWeight] = useState(100)      // 50..200
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
      const klass = classifyClass(f.type || '', f.category)
      const h = hash32(f.icao || '')

      // Determine deferred-item count
      const defProb = CLASS_DEF_PROB[klass]
      const r0 = ((h >>> 0) & 0xffff) / 0xffff
      const r1 = ((h >>> 8) & 0xffff) / 0xffff
      const r2 = ((h >>> 16) & 0xffff) / 0xffff
      let nItems = 0
      if (r0 < defProb) nItems = 1
      if (r1 < defProb * 0.55) nItems = 2
      if (r2 < defProb * 0.18) nItems = 3

      const open: OpenItem[] = []
      const restrSet = new Set<Restriction>()
      let perfPen = 0
      let worstCat: Cat | null = null
      let minDaysRem = Infinity

      for (let i = 0; i < nItems; i++) {
        const sel = (h >>> (3 + i * 5)) % MEL_CATALOG.length
        const item = MEL_CATALOG[sel]
        const intDays = CAT_DAYS[item.cat]
        // hoursSinceDef hash-stable 0..intDays*24*1.2 scaled by fleetAge
        const ageMul = fleetAge / 100
        const cap = intDays * 24 * 1.2 * ageMul
        const hoursSince = ((h >>> (7 + i * 7)) % 1000) / 1000 * cap
        const daysRem = intDays - hoursSince / 24
        open.push({ item, hoursSinceDef: hoursSince, daysRem })
        for (const r of item.restr) restrSet.add(r as Restriction)
        perfPen += item.perfPenPct
        if (!worstCat || CAT_SEV[item.cat] > CAT_SEV[worstCat]) worstCat = item.cat
        if (daysRem < minDaysRem) minDaysRem = daysRem
      }
      if (open.length === 0) minDaysRem = 999

      const totalRestr = Array.from(restrSet)
      perfPen *= (penMul / 100)

      // Severities
      const intSev = minDaysRem <= 0 ? 100 : Math.max(0, Math.min(100, (1 - minDaysRem / intBufDays) * 100))
      const cntSev = open.length <= 0 ? 0 : Math.min(100, ((open.length) / Math.max(1, cntLim)) * 100)
      const rstSev = Math.min(100, (totalRestr.length / 3) * 100) * (rstWeight / 100)
      const catSev = worstCat ? CAT_SEV[worstCat] : 0
      const penSev = Math.min(100, (perfPen / 4) * 100)

      const sevs: Array<[Driver, number]> = [
        ['INT', intSev], ['CNT', cntSev], ['RST', Math.min(100, rstSev)], ['CAT', catSev], ['PEN', penSev],
      ]
      sevs.sort((a, b) => b[1] - a[1])
      const driver: Driver = sevs[0][1] > 0 ? sevs[0][0] : 'NONE'
      const score = Math.min(100, sevs[0][1] + sevs[1][1] * 0.1)

      let tier: Tier
      const breach = open.some(o => o.daysRem <= 0)
      if (breach || score >= 80) tier = 'BREACH'
      else if (score >= 55) tier = 'RESTRICT'
      else if (score >= 25) tier = 'WATCH'
      else if (open.length === 0) tier = 'OK'
      else tier = 'OK'

      out.push({
        f, klass, open, totalRestr, perfPenPct: perfPen, worstCat,
        minDaysRem: open.length ? minDaysRem : 999, score, driver,
        sev: { int: intSev, cnt: cntSev, rst: Math.min(100, rstSev), cat: catSev, pen: penSev },
        tier,
      })
    }
    return out
  }, [flights, minFl, fleetAge, cntLim, intBufDays, penMul, rstWeight])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { BREACH: 0, RESTRICT: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumDays = 0, sumDaysN = 0, breach = 0, restr = 0, openTotal = 0
    let worst = 0, worstCs = '', worstAta = ''
    let restrictedAc = 0
    for (const r of rows) {
      openTotal += r.open.length
      if (r.open.length) { sumDays += Math.max(-30, r.minDaysRem); sumDaysN++ }
      if (r.tier === 'BREACH') breach++
      if (r.tier === 'RESTRICT') restr++
      if (r.totalRestr.length > 0) restrictedAc++
      if (r.score > worst) {
        worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim()
        worstAta = r.open[0]?.item.ata || ''
      }
    }
    return {
      meanDays: sumDaysN ? sumDays / sumDaysN : 999,
      breach, restr, openTotal, worst, worstCs, worstAta,
      restrictedPct: rows.length ? (restrictedAc / rows.length) : 0,
    }
  }, [rows])

  const ataAggs = useMemo(() => {
    const m = new Map<string, { ata: string; count: number; sumDays: number; worst: number; worstCs: string; worstIcao: string; worstTier: Tier; breach: number; cats: Set<Cat> }>()
    for (const r of rows) {
      for (const o of r.open) {
        const k = o.item.ata + '|' + o.item.name
        let a = m.get(k)
        if (!a) { a = { ata: k, count: 0, sumDays: 0, worst: 0, worstCs: '', worstIcao: '', worstTier: 'OK', breach: 0, cats: new Set() }; m.set(k, a) }
        a.count++; a.sumDays += o.daysRem; a.cats.add(o.item.cat)
        if (o.daysRem <= 0) a.breach++
        if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
        if (r.score > a.worst) { a.worst = r.score; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
      }
    }
    return Array.from(m.values()).map(a => ({ ...a, meanDays: a.count ? a.sumDays / a.count : 0 })).sort((a, b) => {
      const ti = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
      if (ti !== 0) return ti
      return b.count - a.count
    })
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows
      .filter(r => r.tier !== 'IDLE')
      .filter(r => r.open.length > 0 || tierFilter === 'OK' || tierFilter === 'ALL')
      .filter(r => {
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (classFilter !== 'ALL' && r.klass !== classFilter) return false
        if (catFilter !== 'ALL' && !r.open.some(o => o.item.cat === catFilter)) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao].some(s => (s || '').toUpperCase().includes(q))
          || r.open.some(o => o.item.ata.toUpperCase().includes(q) || o.item.name.toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
      .slice(0, 200)
  }, [rows, tierFilter, classFilter, catFilter, query])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'RESTRICT' || r.tier === 'BREACH').map(r => {
      const top = r.open.slice().sort((a, b) => a.daysRem - b.daysRem)[0]
      return {
        type: 'Feature' as const,
        properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${top ? top.item.ata : ''} ${top ? top.daysRem.toFixed(1) + 'd' : ''}` },
        geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      }
    }) : [] }

    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'BREACH').map(r => {
      const top = r.open.slice().sort((a, b) => a.daysRem - b.daysRem)[0]
      return {
        type: 'Feature' as const,
        properties: { color: '#ef4444', text: `\u203a CAT-${top?.item.cat ?? '?'} ${top?.daysRem.toFixed(1) ?? ''}d` },
        geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      }
    }) : [] }

    const projFeatures: any[] = []
    if (showProj) {
      for (const r of rows) {
        if (r.tier !== 'BREACH') continue
        const tr = r.f.track * Math.PI / 180
        const dNm = 50
        const dLat = (dNm / 60) * Math.cos(tr)
        const dLng = (dNm / 60) * Math.sin(tr) / Math.max(0.1, Math.cos(r.f.lat * Math.PI / 180))
        const coords: [number, number][] = []
        const segs = 12
        for (let i = 0; i <= segs; i++) coords.push([r.f.lng + dLng * (i / segs), r.f.lat + dLat * (i / segs)])
        projFeatures.push({ type: 'Feature' as const, properties: { color: TIER_COLOR[r.tier] }, geometry: { type: 'LineString' as const, coordinates: coords } })
      }
    }
    const projFc = { type: 'FeatureCollection' as const, features: projFeatures }

    const refFeatures: any[] = []
    if (showRef) {
      for (const lat of [50, 0, -50]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 18) coords.push([lng, lat])
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
        'line-color': ['get', 'color'], 'line-width': 0.6, 'line-opacity': 0.10, 'line-dasharray': [3, 6],
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

  // SVG diagram: days-remaining (x) vs item-count (y)
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 30
    const xMin = -10, xMax = 30, yMax = 4
    const xs = (v: number) => PAD + ((v - xMin) / (xMax - xMin)) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMax }
  }, [])

  const tierColorOf = (s: number) => s >= 80 ? '#ef4444' : s >= 55 ? '#f59e0b' : s >= 25 ? '#0ea5e9' : '#10b981'
  const daysColor = (d: number) => d <= 0 ? '#ef4444' : d <= 3 ? '#f59e0b' : d <= 7 ? '#0ea5e9' : '#10b981'

  const adviceFor = (r: Row): string => {
    if (r.tier === 'BREACH') {
      const top = r.open.slice().sort((a, b) => a.daysRem - b.daysRem)[0]
      return `Interval breach on ${top?.item.ata} (CAT-${top?.item.cat}, ${top?.daysRem.toFixed(1)}d past) — non-dispatchable per 14 CFR 121.628(b) / EASA CAT.GEN.MPA.105; file POI extension or close item before next dispatch`
    }
    if (r.tier === 'RESTRICT') {
      return `Dispatch restrictions imposed: ${r.totalRestr.join(' · ') || 'multiple items open'} — brief crew per ${r.open[0]?.item.ata} MEL O/M proviso, monitor remaining interval`
    }
    if (r.tier === 'WATCH') return 'Open deferrals within interval — verify MX availability at next port; review M-procedures for crew workload impact'
    if (r.open.length === 0) return 'No open MEL/CDL items — full dispatch envelope available'
    return 'Open deferrals nominal — all categories within interval'
  }

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">MEL / CDL Dispatch</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.openTotal} items · {summary.breach} brch</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Days-Rem</div>
          <div className="font-mono text-sm" style={{ color: daysColor(summary.meanDays) }}>{summary.meanDays > 100 ? '—' : summary.meanDays.toFixed(1) + 'd'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] truncate" style={{ color: tierColorOf(summary.worst) }}>{summary.worstCs || '—'} {summary.worstAta}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Breach</div>
          <div className="font-mono text-sm text-rose-400">{summary.breach}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Open items</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.openTotal}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Restricted</div>
          <div className="font-mono text-[11px]" style={{ color: summary.restrictedPct > 0.4 ? '#f59e0b' : '#94a3b8' }}>{(summary.restrictedPct * 100).toFixed(0)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg viewBox={`0 0 ${diag.W} ${diag.H}`} className="w-full h-auto">
            {/* breach band x<=0 */}
            <rect x={diag.xs(diag.xMin)} y={6} width={diag.xs(0) - diag.xs(diag.xMin)} height={diag.H - 22 - 6} fill="#ef4444" opacity={0.08} />
            <rect x={diag.xs(0)} y={6} width={diag.xs(3) - diag.xs(0)} height={diag.H - 22 - 6} fill="#f59e0b" opacity={0.08} />
            <rect x={diag.xs(3)} y={6} width={diag.xs(7) - diag.xs(3)} height={diag.H - 22 - 6} fill="#0ea5e9" opacity={0.07} />
            <rect x={diag.xs(7)} y={6} width={diag.xs(diag.xMax) - diag.xs(7)} height={diag.H - 22 - 6} fill="#10b981" opacity={0.05} />
            <line x1={diag.xs(0)} y1={6} x2={diag.xs(0)} y2={diag.H - 22} stroke="#ef4444" strokeWidth={0.8} strokeDasharray="2 3" />
            <line x1={diag.xs(intBufDays)} y1={6} x2={diag.xs(intBufDays)} y2={diag.H - 22} stroke="#f59e0b" strokeWidth={0.5} strokeDasharray="2 4" opacity={0.7} />
            {[-10, 0, 3, 10, 20, 30].map(x => (
              <text key={x} x={diag.xs(x)} y={diag.H - 8} textAnchor="middle" fontSize={7} fill="#64748b">{x}</text>
            ))}
            {[1, 2, 3, 4].map(y => (
              <line key={y} x1={diag.PAD} y1={diag.ys(y)} x2={diag.W - 6} y2={diag.ys(y)} stroke="#475569" strokeWidth={0.4} strokeDasharray="2 4" />
            ))}
            {rows.filter(r => r.tier !== 'IDLE' && r.open.length > 0).map((r, i) => {
              const x = Math.max(diag.xMin, Math.min(diag.xMax, r.minDaysRem))
              return <circle key={i} cx={diag.xs(x)} cy={diag.ys(r.open.length)} r={2} fill={TIER_COLOR[r.tier]} opacity={0.75} />
            })}
            <text x={diag.W / 2} y={diag.H - 1} textAnchor="middle" fontSize={7} fill="#64748b">min days-remaining (negative = INTERVAL BREACH)</text>
            <text x={4} y={12} fontSize={7} fill="#64748b">items#</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        {[
          ['Min FL', minFl, setMinFl, 0, 400, 10, ''],
          ['Fleet age', fleetAge, setFleetAge, 50, 200, 5, '%'],
          ['Cnt lim', cntLim, setCntLim, 1, 6, 1, ''],
          ['Int buf', intBufDays, setIntBufDays, 1, 15, 1, 'd'],
          ['Pen mul', penMul, setPenMul, 50, 200, 5, '%'],
          ['Rst wt', rstWeight, setRstWeight, 50, 200, 5, '%'],
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

      <div className="px-3 py-1.5 border-b border-slate-800 flex flex-wrap gap-1">
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

      <div className="px-3 py-1 border-b border-slate-800 flex flex-wrap gap-1">
        {CAT_LIST.map(c => {
          const on = catFilter === c
          const col = c === 'A' ? '#ef4444' : c === 'B' ? '#f59e0b' : c === 'C' ? '#0ea5e9' : '#10b981'
          return (
            <button key={c} onClick={() => setCatFilter(on ? 'ALL' : c)}
              title={`Category ${c} · ${CAT_DAYS[c]}d interval`}
              className={`px-1.5 py-0.5 rounded text-[9px] font-mono border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}
              style={{ color: on ? '#e2e8f0' : col }}>
              CAT-{c} {CAT_DAYS[c]}d
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
        {(['AIRCRAFT', 'ATA'] as const).map(t => (
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
              <span className="px-1 rounded text-[8px] font-mono ml-auto" style={{ background: TIER_COLOR[r.tier] + '33', color: TIER_COLOR[r.tier] }}>{r.open.length} open</span>
              <span className="px-1 rounded text-[8px] font-mono" style={{ background: TIER_COLOR[r.tier] + '33', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
            </div>
            <div className="text-[10px] font-mono text-slate-400 flex gap-2 flex-wrap">
              <span>FL{Math.round(r.f.altitudeFt / 100)}</span>
              <span style={{ color: daysColor(r.minDaysRem) }}>min {r.minDaysRem > 100 ? '—' : r.minDaysRem.toFixed(1) + 'd'}</span>
              <span style={{ color: r.worstCat ? (CAT_SEV[r.worstCat] >= 75 ? '#f59e0b' : '#94a3b8') : '#94a3b8' }}>worst CAT-{r.worstCat ?? '—'}</span>
              <span style={{ color: r.perfPenPct > 1 ? '#f59e0b' : '#94a3b8' }}>pen {r.perfPenPct.toFixed(1)}%</span>
              <span style={{ color: tierColorOf(r.score) }}>score {r.score.toFixed(0)}</span>
            </div>
            <div className="h-1 bg-slate-800 rounded overflow-hidden relative">
              <div className="h-full" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }} />
              {[25, 55, 80].map(t => (
                <div key={t} className="absolute top-0 bottom-0 w-px bg-slate-600" style={{ left: `${t}%` }} />
              ))}
            </div>
            <div className="flex gap-1 text-[8px] font-mono flex-wrap">
              {(['int', 'cnt', 'rst', 'cat', 'pen'] as const).map(k => {
                const v = r.sev[k]
                return <span key={k} className="px-1 rounded" style={{ background: tierColorOf(v) + '22', color: tierColorOf(v) }}>{k.toUpperCase()} {v.toFixed(0)}</span>
              })}
            </div>
            {r.open.length > 0 && (
              <div className="flex gap-1 text-[8px] font-mono flex-wrap">
                {r.open.map((o, j) => (
                  <span key={j} className="px-1 rounded" style={{ background: daysColor(o.daysRem) + '22', color: daysColor(o.daysRem) }}>
                    {o.item.ata} C{o.item.cat} {o.daysRem <= 0 ? 'BRCH' : o.daysRem.toFixed(1) + 'd'}
                  </span>
                ))}
              </div>
            )}
            {r.totalRestr.length > 0 && (
              <div className="text-[9px] text-amber-300/80 font-mono truncate">RESTR: {r.totalRestr.join(' · ')}</div>
            )}
            <div className="text-[9px] text-slate-500 leading-snug">{adviceFor(r)}</div>
            <div className="text-[8px] text-slate-600 font-mono truncate">{r.f.operator || ''} · {DRIVER_LABEL[r.driver]}</div>
          </button>
        ))}
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-slate-500 text-[10px]">No aircraft match current filters</div>
        )}

        {tab === 'ATA' && ataAggs.map((a, i) => {
          const [ata, name] = a.ata.split('|')
          return (
            <button key={a.ata + i} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/50 transition flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-[10px]">
                <span className="w-1 h-3 rounded-sm" style={{ background: TIER_COLOR[a.worstTier] }} />
                <span className="font-mono font-semibold text-slate-100">{ata}</span>
                <span className="text-slate-400 font-mono truncate">{name}</span>
                <span className="text-slate-500 font-mono ml-auto">{a.count} ac</span>
                <span className="px-1 rounded text-[8px] font-mono" style={{ background: TIER_COLOR[a.worstTier] + '33', color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
              </div>
              <div className="text-[10px] font-mono text-slate-400 flex gap-2">
                <span style={{ color: daysColor(a.meanDays) }}>mean {a.meanDays.toFixed(1)}d</span>
                <span style={{ color: a.breach > 0 ? '#ef4444' : '#94a3b8' }}>breach {a.breach}</span>
                <span className="ml-auto text-slate-500 truncate">worst {a.worstCs}</span>
              </div>
              <div className="h-1 bg-slate-800 rounded overflow-hidden relative">
                <div className="h-full" style={{ width: `${Math.min(100, a.worst)}%`, background: TIER_COLOR[a.worstTier] }} />
                {[25, 55, 80].map(t => (
                  <div key={t} className="absolute top-0 bottom-0 w-px bg-slate-600" style={{ left: `${t}%` }} />
                ))}
              </div>
              <div className="text-[8px] text-slate-600 font-mono truncate">cats {Array.from(a.cats).join(',')} · click-to-fly worst</div>
            </button>
          )
        })}
        {tab === 'ATA' && ataAggs.length === 0 && (
          <div className="px-3 py-6 text-center text-slate-500 text-[10px]">No open deferrals</div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 font-mono leading-snug">
        MEL/CDL · 14 CFR 91.213/121.628 · EASA Part-MEL · MMEL PL-25/110 · AC 120-77 · A 1d / B 3d / C 10d / D 120d
      </div>
    </div>
  )
}
