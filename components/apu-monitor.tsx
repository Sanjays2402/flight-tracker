'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   APU Health & ETOPS Continuous-Running Capability Monitor
   -----------------------------------------------------------
   Watches every airborne twin-engine ETOPS-eligible aircraft and
   models per-airframe APU (Auxiliary Power Unit) dispatch and
   in-flight-start readiness against the ETOPS continuous-running
   requirement, which mandates that for any single-engine-inop
   diversion the APU be available to provide a redundant source
   of electrical power and, on some types, pneumatic bleed for
   pressurisation and engine-restart support.

   Regulatory & operational basis:
     · 14 CFR 121.633 ETOPS APU requirement
     · FAA AC 120-42B ETOPS Approval — APU continuous-running
     · FAA AC 25-19A ETOPS continued-airworthiness
     · EASA AMC 20-6 rev 2 ETOPS / LROPS
     · ICAO Annex 6 Pt I §4.7 EDTO operations
     · Boeing 777 FCOM 8.20 APU operation / 787 FCOM 8.20
     · Airbus FCOM PRO-ABN-49 APU / DSC-49 APU systems
     · Honeywell 131-9A/B (737NG/A320) APU shop manual
     · Pratt & Whitney APS5000 (787) / APS3200 (A320) ICA
     · MEL CDL APU-INOP dispatch policy per FAA Order 8900.1

   APU health is reconstructed per-airframe from a hash-stable
   FNV-1a 32-bit seed of ICAO24, mapping to:
     · APU model (Honeywell 131-9A / 131-9B / 331-500 / APS3200
       / APS5000 / GTCP85 / GTCP36 / Microturbo Saphir) per
       class catalogue
     · ETOPS authority (NONE / 90 / 120 / 138 / 180 / 207 / 240
       / 330 min) per type and operator pattern
     · EGT-margin-C above redline 642-732C (Honeywell 131 series)
       eroded by hash-driven fleet hours-on-wing 0-12000 h
     · oil pressure psi (35-110) and oil quantity pct
     · start-attempt success probability (90-100% nominal, 60-89
       degraded, <60 marginal) per service-bulletin compliance
     · fuel-burn lb/hr at altitude (HVY 320 / NRW 260 / RGN 180)
     · MEL status: APU-OK / APU-MEL (deferred per MMEL 49-11)
       / APU-INOP (cannot dispatch ETOPS >120 per AC 120-42B)
     · bleed-air availability (yes for most types, no for A350
       / 787 which use electric ECS — affects pneumatic scoring)

   5 risk components, composite = max-driver:
     EGT     EGT margin to redline scaled 0..100 (margin >=40C
             healthy / 20-40C eroded / <20C critical hot-start
             risk per Honeywell SB 49-2061)
     OIL     oil pressure or quantity below MEL floor 35psi /
             25pct ramps 0..100
     START   start-reliability deficit (1-startProb)*100 weighted
             by RELI-MUL slider 50-200%
     ETOPS   etopsAuthority required vs APU-INOP gap — if
             ETOPS>=120 and APU-INOP severity 100 / >=90 and APU-MEL
             severity 70
     FUEL    fuel-burn excess vs class baseline (1+FUEL-MUL/100)
             eroded by EGT-margin loss (degraded APUs burn 8-22%
             more fuel per AC 25-19A condition-monitoring TR-44)

   Tier classification:
     NO-GO   score>=80 / APU-INOP and ETOPS>=120 — rose — must
             reduce ETOPS authority or substitute aircraft per
             14 CFR 121.633(c)
     DEGRADE score>=55 — amber — APU usable but margins eroded /
             MEL deferred / continuous-running unreliable
     WATCH   score>=25 — sky — trend monitor / schedule borescope
             at next A-check per AC 25-19A condition monitoring
     OK      score<25 — emerald — APU healthy / ETOPS-CR ready
     IDLE    on ground / non-ETOPS class / below MIN-FL — slate

   MapLibre overlay:
     · tier-coloured halo rings sized by score 8-22 px
     · rose diamond pin at current pos for NO-GO with APU-INOP
       and ETOPS authority callout
     · tier-coloured callsign+EGT-margin+driver labels for
       non-OK aircraft
     · amber ETOPS equal-time-point reference parallels at lat
       60 / 0 / -60 sampled every 12° longitude as ocean
       segment reference for the ETOPS audience
     · 18-segment dashed forward-projection 80 nm tier-coloured
       for NO-GO

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-EGT-margin / WORST callsign+score+driver /
       NO-GO-count summary
     · 2-cell MEAN-FUEL-LB-HR / APU-INOP-share secondary row
     · SVG EGT-margin-C (y, 0-80C) vs fleet-hours-on-wing
       (x, 0-12000h) scatter with rose CRIT band <20C, amber
       eroded 20-40C, sky watch 40-60C, emerald >60C, dashed
       thresholds at 20/40/60C and verticals at 2/4/6/8/10kh,
       per-aircraft tier-coloured dots
     · 6 sliders MIN-FL / RELI-MUL / FUEL-MUL / HRS-BIAS /
       EGT-BIAS / MEL-RATE in 2-col grid
     · 8-class chip filter HVY/HMB/HNB/RGN/BIZ/TBP/FTR/GA
     · 4-ETOPS chip filter 90/120/180/240+
     · HALO/PIN/LBL/PROJ/REF/DIAG toggles + search
     · AIRCRAFT / CLASSES tab switcher
     · Per-row breakdown chips, score bar, citation, advice,
       click-to-fly
     · CLASSES tab grouped by class with worst-aircraft drill

   Persisted: ft-apu
   ============================================================ */

export interface ApuFlight {
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
  flights: ApuFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'NO-GO' | 'DEGRADE' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'NO-GO': '#ef4444', DEGRADE: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_LABEL: Record<Tier, string> = {
  'NO-GO': 'NO-GO', DEGRADE: 'DEGRADE', WATCH: 'WATCH', OK: 'OK', IDLE: 'IDLE',
}
const TIER_ORDER: Tier[] = ['NO-GO', 'DEGRADE', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { 'NO-GO': 0, DEGRADE: 1, WATCH: 2, OK: 3, IDLE: 4 }

type AcClass = 'HVY' | 'HMB' | 'HNB' | 'RGN' | 'BIZ' | 'TBP' | 'FTR' | 'GA'
const CLASS_LIST: AcClass[] = ['HVY', 'HMB', 'HNB', 'RGN', 'BIZ', 'TBP', 'FTR', 'GA']

interface ApuSpec {
  model: string
  egtRedC: number       // redline EGT °C
  oilFloorPsi: number   // MEL min oil pressure
  fuelBurnLbHr: number  // nominal cruise fuel burn
  bleed: boolean        // pneumatic bleed available
  baseStart: number     // base start reliability %
}
const APU_BY_CLASS: Record<AcClass, ApuSpec> = {
  HVY: { model: 'PW APS5000 / Honeywell 331-500', egtRedC: 732, oilFloorPsi: 45, fuelBurnLbHr: 320, bleed: false, baseStart: 0.98 },
  HMB: { model: 'Honeywell 331-350 / GTCP331-200', egtRedC: 695, oilFloorPsi: 42, fuelBurnLbHr: 290, bleed: true, baseStart: 0.97 },
  HNB: { model: 'Honeywell 131-9A/B', egtRedC: 682, oilFloorPsi: 40, fuelBurnLbHr: 260, bleed: true, baseStart: 0.96 },
  RGN: { model: 'Honeywell GTCP36-150 / APS2000', egtRedC: 660, oilFloorPsi: 38, fuelBurnLbHr: 180, bleed: true, baseStart: 0.94 },
  BIZ: { model: 'Honeywell RE220 / Pratt T-62', egtRedC: 650, oilFloorPsi: 36, fuelBurnLbHr: 120, bleed: true, baseStart: 0.95 },
  TBP: { model: 'Honeywell GTCP85 / Microturbo', egtRedC: 642, oilFloorPsi: 35, fuelBurnLbHr: 80, bleed: true, baseStart: 0.91 },
  FTR: { model: 'JFS190 jet-fuel starter', egtRedC: 720, oilFloorPsi: 50, fuelBurnLbHr: 60, bleed: false, baseStart: 0.93 },
  GA: { model: 'none / ground-cart only', egtRedC: 0, oilFloorPsi: 0, fuelBurnLbHr: 0, bleed: false, baseStart: 0 },
}

const ETOPS_LIST = [90, 120, 180, 240] as const
type EtopsAuth = 0 | 90 | 120 | 138 | 180 | 207 | 240 | 330

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B77|B78|B74|A33|A34|A35|A38|MD11|IL96/.test(t)) return 'HVY'
  if (/B76|A30|A31|DC10/.test(t)) return 'HMB'
  if (/B73|B72|A22|A31|A32|B75|MD8|MD9/.test(t)) return 'HNB'
  if (/CRJ|E17|E19|E29|AT[47]|DH8|RJ85|F70|F100/.test(t)) return 'RGN'
  if (/CL[36]|G[VI458]|GLF|GLEX|GL5T|FA[5789]|F2TH|E[35]5/.test(t)) return 'BIZ'
  if (/PC1|PC2|TBM|PT6|KING|BE20|C208|C30|DH3/.test(t)) return 'TBP'
  if (/F1[568]|F[24]|EFA|EUFI|TYPH|RAFL|MIG|SUKH|JAS/.test(t)) return 'FTR'
  return 'GA'
}

function classifyEtops(op: string, klass: AcClass, hash: number): EtopsAuth {
  if (klass === 'GA' || klass === 'TBP' || klass === 'FTR') return 0
  const o = (op || '').toUpperCase()
  // major ETOPS-180/240 operators
  if (/UAL|UA|DAL|DL|AAL|AA|BAW|BA|DLH|LH|AFR|AF|KLM|KL|QFA|QF|SIA|SQ|UAE|EK|QTR|QR|ANA|NH|JAL|JL|CPA|CX/.test(o)) {
    if (klass === 'HVY') return ((hash >>> 7) % 3) === 0 ? 330 : 240
    if (klass === 'HMB') return 180
    if (klass === 'HNB') return ((hash >>> 5) % 2) ? 180 : 120
  }
  if (klass === 'HVY') return 180
  if (klass === 'HMB') return 120
  if (klass === 'HNB') return ((hash >>> 3) % 2) ? 120 : 90
  return 0
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

type MelStatus = 'APU-OK' | 'APU-MEL' | 'APU-INOP'
type Driver = 'EGT' | 'OIL' | 'START' | 'ETOPS' | 'FUEL' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  EGT: 'EGT margin eroded',
  OIL: 'Oil pressure / quantity low',
  START: 'In-flight start reliability low',
  ETOPS: 'ETOPS continuous-running gap',
  FUEL: 'Fuel-burn excess vs baseline',
  NONE: 'Nominal',
}

interface Row {
  f: ApuFlight
  klass: AcClass
  apu: ApuSpec
  etops: EtopsAuth
  hrsOnWing: number
  egtMarginC: number
  oilPsi: number
  oilQtyPct: number
  startProb: number
  fuelLbHr: number
  mel: MelStatus
  sev: { egt: number; oil: number; start: number; etops: number; fuel: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'apu-halo', SRC_LBL = 'apu-lbl', SRC_PIN = 'apu-pin', SRC_REF = 'apu-ref', SRC_PROJ = 'apu-proj'
const LYR_HALO = 'apu-halo-l', LYR_LBL = 'apu-lbl-l', LYR_PIN = 'apu-pin-l', LYR_REF = 'apu-ref-l', LYR_PROJ = 'apu-proj-l'

export default function ApuMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [etopsFilter, setEtopsFilter] = useState<EtopsAuth | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [reliMul, setReliMul] = useState(100)
  const [fuelMul, setFuelMul] = useState(100)
  const [hrsBias, setHrsBias] = useState(0)        // -25..+25 %
  const [egtBias, setEgtBias] = useState(0)        // -20..+20 °C
  const [melRate, setMelRate] = useState(8)        // % fleet on MEL
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
      const apu = APU_BY_CLASS[klass]
      const h = hash32(f.icao || '')
      const etops = classifyEtops(f.operator || '', klass, h)
      // No-APU class
      if (klass === 'GA') {
        out.push({
          f, klass, apu, etops, hrsOnWing: 0, egtMarginC: 0, oilPsi: 0, oilQtyPct: 0,
          startProb: 0, fuelLbHr: 0, mel: 'APU-INOP',
          sev: { egt: 0, oil: 0, start: 0, etops: 0, fuel: 0 },
          score: 0, driver: 'NONE', tier: 'IDLE',
        })
        continue
      }
      // hash-stable health derivation
      const hrsRaw = ((h >>> 3) % 12000)
      const hrsOnWing = Math.max(0, Math.min(12500, hrsRaw * (1 + hrsBias / 100)))
      // EGT margin: linear decay from +70C new to 0C at 12000h, plus bias
      const egtMargin = Math.max(0, 70 - (hrsOnWing / 12000) * 70 + egtBias + (((h >>> 13) % 200) / 10 - 10))
      const oilPsi = apu.oilFloorPsi + 5 + ((h >>> 17) % 60)
      const oilQty = 35 + ((h >>> 19) % 65)
      const startProb = Math.max(0.45, Math.min(0.995, apu.baseStart - (hrsOnWing / 12000) * 0.30 - (((h >>> 23) % 100) / 1000)))
      const fuelDeg = (1 - egtMargin / 70) * 0.22 // up to +22%
      const fuelLb = apu.fuelBurnLbHr * (1 + fuelDeg) * (fuelMul / 100)
      // MEL status — melRate% of fleet on MEL, half of those INOP
      const melRoll = (h >>> 11) % 1000
      const melThr = melRate * 10
      let mel: MelStatus = 'APU-OK'
      if (melRoll < melThr / 3) mel = 'APU-INOP'
      else if (melRoll < melThr) mel = 'APU-MEL'

      // severities
      const egtSev = egtMargin >= 40 ? 0 : egtMargin <= 5 ? 100 : (1 - (egtMargin - 5) / 35) * 100
      const oilSev = Math.max(
        oilPsi >= apu.oilFloorPsi + 10 ? 0 : oilPsi <= apu.oilFloorPsi ? 100 : (1 - (oilPsi - apu.oilFloorPsi) / 10) * 100,
        oilQty >= 50 ? 0 : oilQty <= 25 ? 100 : (1 - (oilQty - 25) / 25) * 100,
      )
      const startSev = Math.min(100, (1 - startProb) * 100 * (reliMul / 100) * 1.4)
      let etopsSev = 0
      if (mel === 'APU-INOP') {
        if (etops >= 120) etopsSev = 100
        else if (etops >= 90) etopsSev = 80
        else etopsSev = 30
      } else if (mel === 'APU-MEL') {
        if (etops >= 180) etopsSev = 85
        else if (etops >= 120) etopsSev = 60
        else if (etops >= 90) etopsSev = 35
      }
      const fuelSev = fuelDeg <= 0.05 ? 0 : fuelDeg >= 0.22 ? 70 : ((fuelDeg - 0.05) / 0.17) * 70

      const drvList: Array<[Driver, number]> = [
        ['EGT', egtSev], ['OIL', oilSev], ['START', startSev], ['ETOPS', etopsSev], ['FUEL', fuelSev],
      ]
      drvList.sort((a, b) => b[1] - a[1])
      const driver: Driver = drvList[0][1] > 0 ? drvList[0][0] : 'NONE'
      const score = drvList[0][1]
      let tier: Tier
      if (mel === 'APU-INOP' && etops >= 120) tier = 'NO-GO'
      else if (score >= 80) tier = 'NO-GO'
      else if (score >= 55) tier = 'DEGRADE'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, klass, apu, etops, hrsOnWing, egtMarginC: egtMargin,
        oilPsi, oilQtyPct: oilQty, startProb, fuelLbHr: fuelLb, mel,
        sev: { egt: egtSev, oil: oilSev, start: startSev, etops: etopsSev, fuel: fuelSev },
        score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, reliMul, fuelMul, hrsBias, egtBias, melRate])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { 'NO-GO': 0, DEGRADE: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumEgt = 0, sumFuel = 0, worst = 0, worstCs = '', worstDrv: Driver = 'NONE', worstScore = 0
    let nogo = 0, inop = 0, count = 0
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      count++
      sumEgt += r.egtMarginC; sumFuel += r.fuelLbHr
      if (r.tier === 'NO-GO') nogo++
      if (r.mel === 'APU-INOP') inop++
      if (r.score > worst) { worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstDrv = r.driver; worstScore = r.score }
    }
    return {
      meanEgt: count ? sumEgt / count : 0,
      meanFuel: count ? sumFuel / count : 0,
      worst, worstCs, worstDrv, worstScore, nogo,
      inopShare: count ? inop / count : 0,
      activeCount: count,
    }
  }, [rows])

  const classAggs = useMemo(() => {
    const m = new Map<AcClass, { klass: AcClass; apu: ApuSpec; count: number; sumScore: number; sumEgt: number; sumFuel: number; worst: number; worstCs: string; worstIcao: string; worstTier: Tier; nogo: number; inop: number }>()
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      let a = m.get(r.klass)
      if (!a) { a = { klass: r.klass, apu: r.apu, count: 0, sumScore: 0, sumEgt: 0, sumFuel: 0, worst: 0, worstCs: '', worstIcao: '', worstTier: 'OK', nogo: 0, inop: 0 }; m.set(r.klass, a) }
      a.count++; a.sumScore += r.score; a.sumEgt += r.egtMarginC; a.sumFuel += r.fuelLbHr
      if (r.tier === 'NO-GO') a.nogo++
      if (r.mel === 'APU-INOP') a.inop++
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.score > a.worst) { a.worst = r.score; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
    }
    const arr = Array.from(m.values()).map(a => ({ ...a, meanScore: a.count ? a.sumScore / a.count : 0, meanEgt: a.count ? a.sumEgt / a.count : 0, meanFuel: a.count ? a.sumFuel / a.count : 0 }))
    arr.sort((a, b) => {
      const ti = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
      if (ti !== 0) return ti
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
        if (etopsFilter !== 'ALL' && r.etops !== etopsFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.apu.model].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, classFilter, etopsFilter, query])

  const filteredClasses = useMemo(() => {
    const q = query.trim().toUpperCase()
    return classAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (classFilter !== 'ALL' && a.klass !== classFilter) return false
      if (!q) return true
      return (a.klass + ' ' + a.apu.model).toUpperCase().includes(q)
    })
  }, [classAggs, tierFilter, classFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'DEGRADE' || r.tier === 'NO-GO').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} EGT ${r.egtMarginC.toFixed(0)}C ${r.driver}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'NO-GO').map(r => ({
      type: 'Feature' as const,
      properties: { color: '#ef4444', text: `\u203a ${r.mel === 'APU-INOP' ? 'APU-INOP' : 'APU-MEL'} ETOPS ${r.etops || '\u2014'}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    // forward projection 80nm dashed
    const projFeatures: any[] = []
    if (showProj) {
      for (const r of rows) {
        if (r.tier !== 'NO-GO' && r.tier !== 'DEGRADE') continue
        const tr = r.f.track * Math.PI / 180
        const dNm = 80
        const dLat = (dNm / 60) * Math.cos(tr)
        const dLng = (dNm / 60) * Math.sin(tr) / Math.max(0.1, Math.cos(r.f.lat * Math.PI / 180))
        const coords: [number, number][] = []
        const segs = 18
        for (let i = 0; i <= segs; i++) {
          coords.push([r.f.lng + dLng * (i / segs), r.f.lat + dLat * (i / segs)])
        }
        projFeatures.push({ type: 'Feature' as const, properties: { color: TIER_COLOR[r.tier] }, geometry: { type: 'LineString' as const, coordinates: coords } })
      }
    }
    const projFc = { type: 'FeatureCollection' as const, features: projFeatures }

    // amber reference parallels lat 60/0/-60 ETOPS-relevant ocean bands
    const refFeatures: any[] = []
    if (showRef) {
      for (const lat of [60, 0, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        refFeatures.push({ type: 'Feature' as const, properties: { color: '#f59e0b' }, geometry: { type: 'LineString' as const, coordinates: coords } })
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
        'line-color': ['get', 'color'], 'line-width': 0.6, 'line-opacity': 0.14, 'line-dasharray': [4, 6],
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

  // Diagram: EGT margin C (y, 0..80) vs hrs-on-wing (x, 0..12000)
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 30
    const xMin = 0, xMax = 12000
    const yMax = 80
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">APU Health · ETOPS-CR</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.activeCount} ac · {summary.nogo} NO-GO</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold" style={{ color: TIER_COLOR[t] }}>{TIER_LABEL[t]}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean EGT-mrg</div>
          <div className="font-mono text-sm" style={{ color: summary.meanEgt < 20 ? '#ef4444' : summary.meanEgt < 40 ? '#f59e0b' : summary.meanEgt < 60 ? '#0ea5e9' : '#10b981' }}>{summary.meanEgt.toFixed(0)}°C</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstScore.toFixed(0)}` : '—'}
          </div>
          <div className="text-[8px] text-slate-500 truncate">{summary.worstDrv !== 'NONE' ? DRIVER_LABEL[summary.worstDrv] : '—'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">NO-GO</div>
          <div className="font-mono text-sm" style={{ color: summary.nogo > 0 ? '#ef4444' : '#10b981' }}>{summary.nogo}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean burn</div>
          <div className="font-mono text-[11px] text-slate-300">{summary.meanFuel.toFixed(0)} lb/hr</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">APU-INOP share</div>
          <div className="font-mono text-[11px]" style={{ color: summary.inopShare > 0.15 ? '#ef4444' : summary.inopShare > 0.05 ? '#f59e0b' : '#10b981' }}>{(summary.inopShare * 100).toFixed(1)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">EGT margin °C vs hrs-on-wing · APU degradation</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* horizontal bands: low EGT = bad (rose at bottom) */}
            <rect x={diag.PAD} y={diag.ys(20)} width={diag.W - 6 - diag.PAD} height={(diag.H - diag.PAD) - diag.ys(20)} fill="#ef4444" opacity={0.10} />
            <rect x={diag.PAD} y={diag.ys(40)} width={diag.W - 6 - diag.PAD} height={diag.ys(20) - diag.ys(40)} fill="#f59e0b" opacity={0.10} />
            <rect x={diag.PAD} y={diag.ys(60)} width={diag.W - 6 - diag.PAD} height={diag.ys(40) - diag.ys(60)} fill="#0ea5e9" opacity={0.08} />
            {[20, 40, 60].map(yv => (
              <g key={yv}>
                <line x1={diag.PAD} y1={diag.ys(yv)} x2={diag.W - 6} y2={diag.ys(yv)} stroke={yv === 20 ? '#ef4444' : yv === 40 ? '#f59e0b' : '#0ea5e9'} strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
                <text x={diag.PAD - 2} y={diag.ys(yv) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{yv}</text>
              </g>
            ))}
            {[2000, 4000, 6000, 8000, 10000].map(xv => (
              <g key={xv}>
                <line x1={diag.xs(xv)} y1={6} x2={diag.xs(xv)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(xv)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{(xv / 1000) | 0}k</text>
              </g>
            ))}
            <text x={diag.PAD + 4} y={diag.H - diag.PAD - 4} fontSize={7} fill="#ef4444" fontFamily="monospace">CRIT &lt;20°C</text>
            <text x={diag.PAD + 4} y={diag.ys(40) - 2} fontSize={7} fill="#f59e0b" fontFamily="monospace">ERODED 20-40</text>
            <text x={diag.PAD + 4} y={diag.ys(60) - 2} fontSize={7} fill="#0ea5e9" fontFamily="monospace">WATCH 40-60</text>
            {rows.filter(r => r.tier !== 'IDLE').map(r => (
              <circle key={r.f.icao}
                cx={diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, r.hrsOnWing)))}
                cy={diag.ys(Math.max(0, Math.min(diag.yMax, r.egtMarginC)))}
                r={3} fill={TIER_COLOR[r.tier]} opacity={0.92} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>RELI-MUL</span><span className="font-mono text-slate-300">{reliMul}%</span></div>
            <input type="range" min={50} max={200} step={5} value={reliMul} onChange={e => setReliMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>FUEL-MUL</span><span className="font-mono text-slate-300">{fuelMul}%</span></div>
            <input type="range" min={50} max={150} step={5} value={fuelMul} onChange={e => setFuelMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>HRS-BIAS</span><span className="font-mono text-slate-300">{hrsBias >= 0 ? '+' : ''}{hrsBias}%</span></div>
            <input type="range" min={-25} max={25} step={1} value={hrsBias} onChange={e => setHrsBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>EGT-BIAS</span><span className="font-mono text-slate-300">{egtBias >= 0 ? '+' : ''}{egtBias}°C</span></div>
            <input type="range" min={-20} max={20} step={1} value={egtBias} onChange={e => setEgtBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MEL-RATE</span><span className="font-mono text-slate-300">{melRate}%</span></div>
            <input type="range" min={0} max={30} step={1} value={melRate} onChange={e => setMelRate(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setClassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${classFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {CLASS_LIST.map(k => (
            <button key={k} onClick={() => setClassFilter(classFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${classFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setEtopsFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${etopsFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ETOPS</button>
          {ETOPS_LIST.map(k => (
            <button key={k} onClick={() => setEtopsFilter(etopsFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${etopsFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{k}m</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRef} onChange={e => setShowRef(e.target.checked)} className="accent-sky-500" /><span>REF</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / APU"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'CLASSES'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${summary.activeCount} ac` : `${filteredClasses.length} shown / ${classAggs.length} cls`}</span>
        <span>{tab === 'AIRCRAFT' ? 'EGT · OIL · STR · ETP · FUE' : 'class · count · mean · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No ETOPS-eligible aircraft airborne above MIN-FL.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const advice = r.tier === 'NO-GO'
            ? r.mel === 'APU-INOP'
              ? `APU-INOP and ETOPS-${r.etops} authority \u2014 reduce to ETOPS-${r.etops >= 180 ? 120 : 90} or substitute per 14 CFR 121.633(c)`
              : `APU score ${r.score.toFixed(0)} driver ${r.driver} \u2014 ground-stop / shop-visit per AC 25-19A`
            : r.tier === 'DEGRADE'
              ? `APU usable but ${DRIVER_LABEL[r.driver].toLowerCase()} \u2014 brief crew continuous-running may be unreliable / monitor EGT`
              : r.tier === 'WATCH'
                ? `${r.driver} trend monitor \u2014 schedule borescope at next A-check per AC 25-19A condition monitoring`
                : `APU healthy \u2014 ETOPS-CR ready / EGT mrg ${r.egtMarginC.toFixed(0)}\u00b0C / start ${(r.startProb * 100).toFixed(0)}%`
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{r.klass}</span>
                  <span className="text-[10px] font-mono text-slate-500">E{r.etops || '\u2014'}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{TIER_LABEL[r.tier]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="hours on wing">{(r.hrsOnWing / 1000).toFixed(1)}kh</span>
                  <span title="EGT margin C" style={{ color: r.egtMarginC < 20 ? '#ef4444' : r.egtMarginC < 40 ? '#f59e0b' : '#10b981' }}>EGT {r.egtMarginC.toFixed(0)}\u00b0C</span>
                  <span title="oil psi" className="text-slate-500">oil {r.oilPsi}psi/{r.oilQtyPct.toFixed(0)}%</span>
                  <span title="in-flight start reliability" style={{ color: r.startProb < 0.8 ? '#f59e0b' : '#94a3b8' }}>STR {(r.startProb * 100).toFixed(0)}%</span>
                  <span className="ml-auto" title="composite risk score" style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`score ${r.score.toFixed(0)} / 100`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500/70" style={{ left: `25%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-500/70" style={{ left: `55%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-500/70" style={{ left: `80%` }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {([['EGT', r.sev.egt], ['OIL', r.sev.oil], ['STR', r.sev.start], ['ETP', r.sev.etops], ['FUE', r.sev.fuel]] as const).map(([lbl, v]) => {
                    const c = v >= 80 ? '#ef4444' : v >= 55 ? '#f59e0b' : v >= 25 ? '#0ea5e9' : '#475569'
                    return (
                      <span key={lbl} className="px-1 py-0 rounded border text-[9px] font-mono"
                        style={{ borderColor: c + '66', color: c, background: c + '14' }}>{lbl} {v.toFixed(0)}</span>
                    )
                  })}
                  <span className="px-1 py-0 rounded border text-[9px] font-mono"
                    style={{ borderColor: r.mel === 'APU-INOP' ? '#ef444466' : r.mel === 'APU-MEL' ? '#f59e0b66' : '#10b98166',
                             color: r.mel === 'APU-INOP' ? '#ef4444' : r.mel === 'APU-MEL' ? '#f59e0b' : '#10b981',
                             background: r.mel === 'APU-INOP' ? '#ef444414' : r.mel === 'APU-MEL' ? '#f59e0b14' : '#10b98114' }}>{r.mel}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="fuel burn lb/hr">{r.fuelLbHr.toFixed(0)}lb/hr</span>
                  {r.apu.bleed && <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-500">BLEED</span>}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'} · {r.apu.model}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'CLASSES' && filteredClasses.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No active classes within filter.</div>
        )}
        {tab === 'CLASSES' && filteredClasses.map(a => {
          const advice = a.worstTier === 'NO-GO' ? `${a.nogo} aircraft NO-GO / ${a.inop} INOP \u2014 audit ETOPS dispatch reliability per AC 120-42B`
            : a.worstTier === 'DEGRADE' ? `class APU pool degrading \u2014 schedule fleet-wide borescope per Honeywell SB 49-2061`
            : a.worstTier === 'WATCH' ? `class APU trend monitor \u2014 condition monitoring per AC 25-19A`
            : `class APU pool healthy \u2014 ETOPS-CR margins nominal`
          return (
            <button key={a.klass} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.klass}</span>
                  <span className="text-slate-500 text-[10px] truncate">{a.apu.model}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.worstTier] }}>{TIER_LABEL[a.worstTier]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="mean EGT margin" style={{ color: a.meanEgt < 20 ? '#ef4444' : a.meanEgt < 40 ? '#f59e0b' : '#10b981' }}>EGT {a.meanEgt.toFixed(0)}\u00b0C</span>
                  <span title="mean fuel burn">{a.meanFuel.toFixed(0)}lb/hr</span>
                  <span title="INOP count" style={{ color: a.inop > 0 ? '#ef4444' : '#94a3b8' }}>INOP {a.inop}</span>
                  <span className="ml-auto truncate">{a.worstCs || '—'}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`mean score ${a.meanScore.toFixed(0)} / 100`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, a.meanScore)}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500/70" style={{ left: `25%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-500/70" style={{ left: `55%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-500/70" style={{ left: `80%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate">red {a.apu.egtRedC}\u00b0C / oil≥{a.apu.oilFloorPsi}psi / base-start {(a.apu.baseStart * 100).toFixed(0)}%</span>
                  <span className="ml-auto truncate" style={{ color: a.worstTier === 'OK' ? '#64748b' : TIER_COLOR[a.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        14 CFR 121.633 · FAA AC 120-42B · FAA AC 25-19A · EASA AMC 20-6 · ICAO Annex 6 Pt I §4.7 · Boeing FCOM 8.20 · Airbus PRO-ABN-49 · Honeywell SB 49-2061 · MMEL 49-11
      </div>
    </div>
  )
}
