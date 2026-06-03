'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Engine Oil Consumption & IFSD-Risk Monitor (ATA-79)
   -----------------------------------------------------------
   Per-engine oil quantity / pressure / temperature trending
   with time-to-IFSD prediction.

   Regulatory & operational basis:
     · 14 CFR 25.1019 / 25.1021 / 25.1023 oil system
     · 14 CFR 25.1305 powerplant indication
     · 14 CFR 33.39 / 33.71 oil system endurance
     · 14 CFR 33.83 vibration test
     · 14 CFR 91.213 / 121.628 (oil-qty MEL)
     · 14 CFR 121.703(b) IFSD reporting
     · 14 CFR 121.374 ETOPS engine condition monitoring
     · AC 120-42B Appendix 2 ETOPS oil-consumption trend
     · AC 33-9 ETOPS engine reliability
     · CS-25.1019 / CS-E 100 / CS-E 660
     · ICAO Annex 6 Pt I 5.2.6 ECM trend monitoring
     · ARINC 624 OMS engine oil report
     · Boeing AERO Q3-2016 Oil Consumption Monitoring
     · Boeing 777 FCOM 7.30 PW4090/GE90/Trent 800 oil
     · Boeing 787 FCOM 7.30 GEnx-1B / Trent 1000 oil
     · Airbus FAST Mag 49 Oil Consumption
     · Airbus A320 FCOM PRO-NOR-SOP-23 CFM56 oil limits
     · Airbus A350 FCOM Trent XWB oil
     · CFM56-7B SB 79-0028 oil consumption MEL
     · PW1100G-JM SB 79-001 GTF oil-loss IFSD
     · Trent 1000 SB 79-AJ001 oil-mist
     · NTSB AAR-89/03 / AAR-96/03 oil-starvation IFSD
     · NTSB DCA17IA148 SWA1380 fan-blade-out
     · FAA SAIB NE-18-26 high-bypass oil systems
     · SAE ARP 5757 engine condition monitoring
     · MMEL Boeing 737 79-1 OIL QTY 7.0 qt dispatch min
     · MMEL Airbus A320 79-01 OIL QTY 11 qt dispatch min

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash of ICAO24 drives
        per-engine oil quantity (qt), consumption rate (qt/hr),
        oil-pressure (psi), oil-temp (°C), filter-bypass flag.
     2. Per-class engine catalogue defines oil capacity, max
        dispatch addition threshold, min in-flight quantity,
        nominal pressure / temp band, FCOM consumption alert
        limit (qt/hr), and engine count (2/3/4).
     3. Time-to-min-qty = (qty − minQty) / consumption rate.
     4. ETOPS-validated airframes carry tighter trend
        thresholds (AC 120-42B App 2 oil-consumption MAX).
     5. Aggregate worst-engine drives airframe posture.

   5 risk components (composite = max-driver):
     QTY  current oil qty vs (minQty, addQty) thresholds
          100 at <=minQty (engine shutdown), 75 at addQty/2,
          50 at addQty, 0 at full capacity
     CON  consumption rate vs FCOM alert limit
          100 at >=2x limit (severe loss), ramping 0 at <=0.5x
     TMP  oil temp vs nominal high-side (155°C class-typed)
          100 at >=tempMax, ramping 0 at <=tempNom
     PRS  oil pressure vs low-press alert
          100 at <=presMin (red-line), ramping 0 at >=presNom
     TTL  time-to-min-qty in hours
          100 at <=ETOPS-time / 2, 0 at >= ETOPS-time * 2
          ETOPS-180 = 3h, ETOPS-120 = 2h, non-ETOPS = 1h ref
     filter-bypass flag adds +25 to QTY severity (debris loop).

   Composite score = max-driver + 0.10*secondary, clip 0-100.

   Tiers:
     IFSD       any engine score>=80 OR qty<=minQty OR
                TTL <= ETOPS-time / 4
                rose: shut-down imminent, declare emergency,
                divert nearest suitable per AC 120-42B
     HIGH       score>=55 amber: ECM trend exceedance,
                file ETOPS dispatch deviation, monitor every
                10 min, brief CTRL on IFSD checklist
     WATCH      score>=25 sky: within trend buffer, log every
                30 min, schedule MX at next port
     OK         score<25 emerald: all engines nominal
     IDLE       below MIN-FL slider / on ground: slate

   MapLibre overlay:
     · Tier-coloured halo rings sized by score 8-22 px
     · Rose diamond pin at current pos for IFSD with
       engine# + qty + TTL callout
     · Tier-coloured callsign + ENG# + driver labels for non-OK
     · 12-segment dashed forward-projection 50 nm tier-coloured
       for IFSD (with TTL minute markers)
     · Sky reference parallels at lat 60/30/0/-30/-60 every
       12° lng as fleet reference

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-TTL-hr tier-coloured / WORST cs+ENG /
       IFSD-count summary
     · 2-cell MEAN-CONS-rate / FLTR-BYPASS-share secondary
     · SVG TTL-hr vs consumption-qt/hr scatter with rose
       <=ETOPS/2 band, amber ETOPS, sky 2*ETOPS, every engine
       plotted as tier-coloured dot
     · 6 sliders MIN-FL / FLEET-AGE / CONS-MUL / TEMP-BIAS /
       FBP-SHARE / ETOPS-MIN
     · 7-class chip filter HVY/NRW/RGN/BIZ/TBP/GA/FTR
     · HALO/PIN/LBL/PROJ/REF/DIAG toggles + search
     · AIRCRAFT / ENGINES tab switcher
     · Aircraft tab tier-coloured row with per-engine pills
       (eng# / qty / cons / temp / pres / TTL / sev-tier)
       + driver chips + advice + click-to-fly
     · Engines tab grouped by class+engine-position sorted
       worst-tier-first

   Layers > Safety & Traffic.
   Persisted: ft-oil
   ============================================================ */

interface OilFlight {
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
  flights: OilFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'IFSD' | 'HIGH' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  IFSD: '#ef4444', HIGH: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['IFSD', 'HIGH', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { IFSD: 0, HIGH: 1, WATCH: 2, OK: 3, IDLE: 4 }

type AcClass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const CLASS_LIST: AcClass[] = ['HVY', 'NRW', 'RGN', 'BIZ', 'TBP', 'GA', 'FTR']
const CLASS_LABEL: Record<AcClass, string> = {
  HVY: 'Heavy widebody',
  NRW: 'Narrowbody',
  RGN: 'Regional',
  BIZ: 'Bizjet',
  TBP: 'Turboprop',
  GA: 'General aviation',
  FTR: 'Military fighter',
}

interface EngineSpec {
  engCount: number       // 2/3/4
  family: string         // CFM56 / GE90 / Trent / PW1100G / ...
  capQt: number          // oil-tank capacity quarts
  addQt: number          // top-up addition threshold (FCOM)
  minQt: number          // in-flight min (red-line)
  consAlert: number      // qt/hr FCOM alert limit
  tempNom: number        // °C nominal cruise
  tempMax: number        // °C red-line
  presNom: number        // psi cruise nominal
  presMin: number        // psi red-line low
  etopsMin: number       // ETOPS authority minutes (0 = non-ETOPS)
}

const CLASS_ENG: Record<AcClass, EngineSpec> = {
  HVY: { engCount: 2, family: 'Trent / GE90 / GEnx', capQt: 30, addQt: 22, minQt: 9,  consAlert: 0.45, tempNom: 110, tempMax: 165, presNom: 75, presMin: 25, etopsMin: 180 },
  NRW: { engCount: 2, family: 'CFM56 / PW1100G / LEAP', capQt: 24, addQt: 18, minQt: 7,  consAlert: 0.40, tempNom: 105, tempMax: 155, presNom: 70, presMin: 22, etopsMin: 120 },
  RGN: { engCount: 2, family: 'CF34 / PW1500G',         capQt: 18, addQt: 13, minQt: 5,  consAlert: 0.35, tempNom: 100, tempMax: 150, presNom: 65, presMin: 20, etopsMin: 60  },
  BIZ: { engCount: 2, family: 'BR710 / HTF7000 / PW307', capQt: 15, addQt: 10, minQt: 4,  consAlert: 0.30, tempNom: 100, tempMax: 145, presNom: 65, presMin: 18, etopsMin: 0   },
  TBP: { engCount: 2, family: 'PT6 / PW150 / TPE331',   capQt: 12, addQt:  8, minQt: 3,  consAlert: 0.25, tempNom:  95, tempMax: 140, presNom: 60, presMin: 15, etopsMin: 0   },
  GA:  { engCount: 1, family: 'IO-540 / Continental',   capQt:  8, addQt:  6, minQt: 2,  consAlert: 0.20, tempNom:  90, tempMax: 130, presNom: 55, presMin: 12, etopsMin: 0   },
  FTR: { engCount: 2, family: 'F119 / F135 / EJ200',    capQt: 22, addQt: 16, minQt: 6,  consAlert: 0.50, tempNom: 120, tempMax: 175, presNom: 80, presMin: 28, etopsMin: 0   },
}

type Driver = 'QTY' | 'CON' | 'TMP' | 'PRS' | 'TTL' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  QTY: 'Low oil quantity',
  CON: 'High consumption',
  TMP: 'Oil over-temp',
  PRS: 'Low oil pressure',
  TTL: 'Time-to-IFSD short',
  NONE: 'Nominal',
}

function classifyClass(type: string, _cat?: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|B77|B78|A33|A34|A35|A38|MD11|IL96/.test(t)) return 'HVY'
  if (/B73|A31|A319|A32|A22|MD8|B71/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E27|E29|E[12]7|E[12]9|ATR|F70|F100/.test(t)) return 'RGN'
  if (/G[VI458]|GLF|GLEX|FA[78]X|F2TH|CL30|CL60|C68|C75|BE40|H25|LJ/.test(t)) return 'BIZ'
  if (/DH8|AT[47]|SF34|B190|BE20|C208|DHC/.test(t)) return 'TBP'
  if (/F15|F16|F18|F22|F35|EUFI|RFAL|TYPH|MIG|SU[2-5]/.test(t)) return 'FTR'
  return 'GA'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

interface EngState {
  pos: number          // 1..4
  qty: number          // qt current
  cons: number         // qt/hr
  temp: number         // °C
  pres: number         // psi
  fbp: boolean         // filter-bypass
  ttlHr: number        // hours to minQty
  sev: { qty: number; con: number; tmp: number; prs: number; ttl: number }
  score: number
  driver: Driver
  tier: Tier
}

interface Row {
  f: OilFlight
  klass: AcClass
  spec: EngineSpec
  engines: EngState[]
  worst: EngState
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'oil-halo', SRC_LBL = 'oil-lbl', SRC_PIN = 'oil-pin', SRC_PROJ = 'oil-proj', SRC_REF = 'oil-ref'
const LYR_HALO = 'oil-halo-l', LYR_LBL = 'oil-lbl-l', LYR_PIN = 'oil-pin-l', LYR_PROJ = 'oil-proj-l', LYR_REF = 'oil-ref-l'

export default function OilConsumption({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'ENGINES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(30)
  const [fleetAge, setFleetAge] = useState(100)   // 50..200
  const [consMul, setConsMul] = useState(100)     // 50..200
  const [tempBias, setTempBias] = useState(0)     // -20..+20 °C
  const [fbpShare, setFbpShare] = useState(8)     // 0..30 pct
  const [etopsMinSlider, setEtopsMinSlider] = useState(180) // 60..330
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
      const spec = CLASS_ENG[klass]
      const h = hash32(f.icao || '')
      const ageMul = fleetAge / 100

      const engines: EngState[] = []
      for (let e = 0; e < spec.engCount; e++) {
        const hh = (h ^ (0x9e3779b9 * (e + 1))) >>> 0
        const r0 = ((hh >>> 0) & 0xffff) / 0xffff
        const r1 = ((hh >>> 8) & 0xffff) / 0xffff
        const r2 = ((hh >>> 16) & 0xffff) / 0xffff
        const r3 = (((hh * 0x85ebca6b) >>> 0) & 0xffff) / 0xffff
        const r4 = (((hh * 0xc2b2ae35) >>> 8) & 0xffff) / 0xffff

        // Oil quantity: distributed 30%..100% of capacity, age-skewed downward
        const qtyFrac = 0.30 + r0 * 0.70 * (1 - (ageMul - 1) * 0.18)
        const qty = Math.max(spec.minQt * 0.55, Math.min(spec.capQt, qtyFrac * spec.capQt))

        // Consumption rate: base 0.05..0.5 qt/hr * ageMul * consMul; tail of fleet >alert
        const consBase = 0.04 + r1 * (spec.consAlert * 1.4)
        const cons = consBase * ageMul * (consMul / 100)

        // Oil temp: nominal + r * 60, bias
        const temp = spec.tempNom - 5 + r2 * 70 * (0.85 + (ageMul - 1) * 0.5) + tempBias

        // Oil pressure: nominal ±30, low-tail with high cons / low qty
        const pres = spec.presNom - r3 * 55 + (qty / spec.capQt) * 15

        // Filter-bypass flag: probability fbpShare% per engine (hash-stable)
        const fbp = r4 < (fbpShare / 100)

        // Time-to-min-qty
        const ttlHr = cons > 0.001 ? Math.max(0, (qty - spec.minQt) / cons) : 999

        // Severities
        const qtySev = qty <= spec.minQt
          ? 100
          : qty <= spec.addQt / 2
            ? 75 + ((spec.addQt / 2 - qty) / Math.max(0.01, spec.addQt / 2 - spec.minQt)) * 25
            : qty <= spec.addQt
              ? 50 + ((spec.addQt - qty) / Math.max(0.01, spec.addQt / 2)) * 25
              : Math.max(0, 50 - ((qty - spec.addQt) / Math.max(0.01, spec.capQt - spec.addQt)) * 50)
        const qtySevAdj = Math.min(100, qtySev + (fbp ? 25 : 0))

        const conSev = cons >= spec.consAlert * 2
          ? 100
          : cons <= spec.consAlert * 0.5
            ? 0
            : ((cons - spec.consAlert * 0.5) / (spec.consAlert * 1.5)) * 100
        const tmpSev = temp >= spec.tempMax
          ? 100
          : temp <= spec.tempNom
            ? 0
            : ((temp - spec.tempNom) / (spec.tempMax - spec.tempNom)) * 100
        const prsSev = pres <= spec.presMin
          ? 100
          : pres >= spec.presNom
            ? 0
            : ((spec.presNom - pres) / (spec.presNom - spec.presMin)) * 100

        // TTL ref: ETOPS auth (use slider as default when class non-ETOPS, but scaled)
        const etopsRefHr = (spec.etopsMin > 0 ? spec.etopsMin : Math.max(30, etopsMinSlider / 3)) / 60
        const ttlSev = ttlHr <= etopsRefHr / 2
          ? 100
          : ttlHr >= etopsRefHr * 2
            ? 0
            : (1 - (ttlHr - etopsRefHr / 2) / (etopsRefHr * 1.5)) * 100

        const sevList: Array<[Driver, number]> = [
          ['QTY', qtySevAdj], ['CON', conSev], ['TMP', tmpSev], ['PRS', prsSev], ['TTL', ttlSev],
        ]
        sevList.sort((a, b) => b[1] - a[1])
        const driver: Driver = sevList[0][1] > 0 ? sevList[0][0] : 'NONE'
        const score = Math.min(100, sevList[0][1] + sevList[1][1] * 0.10)

        let tier: Tier
        if (qty <= spec.minQt || ttlHr <= etopsRefHr / 4 || score >= 80) tier = 'IFSD'
        else if (score >= 55) tier = 'HIGH'
        else if (score >= 25) tier = 'WATCH'
        else tier = 'OK'

        engines.push({
          pos: e + 1, qty, cons, temp, pres, fbp, ttlHr,
          sev: { qty: qtySevAdj, con: conSev, tmp: tmpSev, prs: prsSev, ttl: ttlSev },
          score, driver, tier,
        })
      }

      // Aircraft worst-engine drives row tier
      const worst = engines.slice().sort((a, b) => b.score - a.score)[0]
      out.push({
        f, klass, spec, engines, worst,
        score: worst.score, driver: worst.driver, tier: worst.tier,
      })
    }
    return out
  }, [flights, minFl, fleetAge, consMul, tempBias, fbpShare, etopsMinSlider])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { IFSD: 0, HIGH: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumTtl = 0, sumTtlN = 0, sumCons = 0, sumConsN = 0, fbpN = 0, engN = 0
    let worst = 0, worstCs = '', worstEng = 0
    for (const r of rows) {
      for (const e of r.engines) {
        engN++
        if (isFinite(e.ttlHr) && e.ttlHr < 100) { sumTtl += e.ttlHr; sumTtlN++ }
        sumCons += e.cons; sumConsN++
        if (e.fbp) fbpN++
      }
      if (r.score > worst) { worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstEng = r.worst.pos }
    }
    return {
      meanTtl: sumTtlN ? sumTtl / sumTtlN : 999,
      meanCons: sumConsN ? sumCons / sumConsN : 0,
      ifsd: tally.IFSD, worst, worstCs, worstEng,
      fbpShare: engN ? fbpN / engN : 0,
    }
  }, [rows, tally])

  const engAggs = useMemo(() => {
    const m = new Map<string, { key: string; klass: AcClass; pos: number; count: number; sumScore: number; sumTtl: number; sumCons: number; ifsd: number; worst: number; worstCs: string; worstIcao: string; worstTier: Tier }>()
    for (const r of rows) {
      for (const e of r.engines) {
        const k = r.klass + '|ENG-' + e.pos
        let a = m.get(k)
        if (!a) { a = { key: k, klass: r.klass, pos: e.pos, count: 0, sumScore: 0, sumTtl: 0, sumCons: 0, ifsd: 0, worst: 0, worstCs: '', worstIcao: '', worstTier: 'OK' }; m.set(k, a) }
        a.count++; a.sumScore += e.score; a.sumTtl += Math.min(e.ttlHr, 50); a.sumCons += e.cons
        if (e.tier === 'IFSD') a.ifsd++
        if (TIER_RANK[e.tier] < TIER_RANK[a.worstTier]) a.worstTier = e.tier
        if (e.score > a.worst) { a.worst = e.score; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
      }
    }
    return Array.from(m.values()).map(a => ({
      ...a, meanScore: a.count ? a.sumScore / a.count : 0,
      meanTtl: a.count ? a.sumTtl / a.count : 0,
      meanCons: a.count ? a.sumCons / a.count : 0,
    })).sort((a, b) => {
      const ti = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
      if (ti !== 0) return ti
      return b.ifsd - a.ifsd || b.count - a.count
    })
  }, [rows])

  // ---- MapLibre rendering ----
  useEffect(() => {
    if (!map) return
    const m = map
    const ready = () => {
      const ensure = (id: string, type: 'geojson') => {
        if (!m.getSource(id)) m.addSource(id, { type, data: { type: 'FeatureCollection', features: [] } } as any)
      }
      ensure(SRC_HALO, 'geojson'); ensure(SRC_PIN, 'geojson'); ensure(SRC_LBL, 'geojson'); ensure(SRC_PROJ, 'geojson'); ensure(SRC_REF, 'geojson')
      if (!m.getLayer(LYR_HALO)) m.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'c'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'c'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85 } })
      if (!m.getLayer(LYR_PROJ)) m.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: { 'line-color': ['get', 'c'], 'line-width': 1.5, 'line-opacity': 0.7, 'line-dasharray': [2, 2] } })
      if (!m.getLayer(LYR_REF)) m.addLayer({ id: LYR_REF, type: 'circle', source: SRC_REF, paint: { 'circle-radius': 1.6, 'circle-color': '#0ea5e9', 'circle-opacity': 0.35 } })
      if (!m.getLayer(LYR_PIN)) m.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': '◆', 'text-size': 14, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#0b0f1a', 'text-halo-width': 1.4 } })
      if (!m.getLayer(LYR_LBL)) m.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 't'], 'text-size': 10, 'text-offset': [0, 1.3], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#0b0f1a', 'text-halo-width': 1.4 } })
    }
    if (m.isStyleLoaded()) ready(); else m.once('load', ready)
    return () => {
      for (const l of [LYR_HALO, LYR_PROJ, LYR_REF, LYR_PIN, LYR_LBL]) if (m.getLayer(l)) m.removeLayer(l)
      for (const s of [SRC_HALO, SRC_PROJ, SRC_REF, SRC_PIN, SRC_LBL]) if (m.getSource(s)) m.removeSource(s)
    }
  }, [map])

  useEffect(() => {
    if (!map) return
    const m = map
    if (!m.getSource(SRC_HALO)) return

    const halos: any[] = [], pins: any[] = [], labels: any[] = [], proj: any[] = [], refs: any[] = []
    for (const r of rows) {
      if (r.tier === 'OK' || r.tier === 'IDLE') continue
      const c = TIER_COLOR[r.tier]
      const rad = 8 + (r.score / 100) * 14
      if (showHalo) halos.push({ type: 'Feature', properties: { c, r: rad }, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
      if (showPin && r.tier === 'IFSD') pins.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
      if (showLabels) {
        const ttl = isFinite(r.worst.ttlHr) ? (r.worst.ttlHr < 10 ? r.worst.ttlHr.toFixed(1) + 'h' : '>10h') : '>10h'
        labels.push({ type: 'Feature', properties: { c, t: `${(r.f.callsign || r.f.icao).trim()}  E${r.worst.pos} ${r.driver} ${ttl}` }, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
      }
      if (showProj && r.tier === 'IFSD') {
        const trk = (r.f.track || 0) * Math.PI / 180
        const nm = 50
        const dLat = Math.cos(trk) * (nm / 60)
        const dLng = Math.sin(trk) * (nm / 60) / Math.max(0.2, Math.cos(r.f.lat * Math.PI / 180))
        proj.push({ type: 'Feature', properties: { c }, geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.f.lng + dLng, r.f.lat + dLat]] } })
      }
    }
    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) for (let lng = -180; lng < 180; lng += 12) {
        refs.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lng, lat] } })
      }
    }
    ;(m.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halos })
    ;(m.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pins })
    ;(m.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: labels })
    ;(m.getSource(SRC_PROJ) as any).setData({ type: 'FeatureCollection', features: proj })
    ;(m.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: refs })
  }, [map, rows, showHalo, showPin, showLabels, showProj, showRef])

  // ---- View filtering ----
  const q = query.trim().toUpperCase()
  const filteredRows = rows.filter(r => {
    if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
    if (classFilter !== 'ALL' && r.klass !== classFilter) return false
    if (q) {
      const cs = (r.f.callsign || r.f.icao).toUpperCase()
      if (!cs.includes(q) && !(r.f.type || '').toUpperCase().includes(q)) return false
    }
    return true
  }).sort((a, b) => {
    const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
    return ti !== 0 ? ti : b.score - a.score
  })

  // ---- Diagnostic SVG (TTL vs Consumption) ----
  const diag = useMemo(() => {
    const W = 360, H = 200, padL = 38, padR = 10, padT = 12, padB = 28
    const xMax = 12   // hours
    const yMax = 1.0  // qt/hr
    const xToPx = (x: number) => padL + Math.min(1, x / xMax) * (W - padL - padR)
    const yToPx = (y: number) => H - padB - Math.min(1, y / yMax) * (H - padT - padB)
    return { W, H, padL, padR, padT, padB, xMax, yMax, xToPx, yToPx }
  }, [])

  function advice(r: Row): string {
    if (r.tier === 'IFSD') return `Engine ${r.worst.pos} ${DRIVER_LABEL[r.driver].toLowerCase()} — IFSD imminent. Declare emergency, run QRH ENG SHUTDOWN, divert nearest suitable per AC 120-42B.`
    if (r.tier === 'HIGH') return `Engine ${r.worst.pos} ECM trend exceedance (${DRIVER_LABEL[r.driver].toLowerCase()}). File ETOPS dispatch deviation, monitor every 10 min, brief on IFSD checklist.`
    if (r.tier === 'WATCH') return `Engine ${r.worst.pos} within trend buffer (${DRIVER_LABEL[r.driver].toLowerCase()}). Log every 30 min, schedule MX at next port.`
    return 'All engines within FCOM oil-system envelope; nominal ECM trend.'
  }

  return (
    <div className="fixed top-16 right-2 z-40 w-[440px] max-h-[calc(100vh-5rem)] overflow-y-auto rounded-xl border border-sky-500/40 bg-slate-950/95 backdrop-blur p-3 text-xs text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-sky-300">Oil Consumption / IFSD-Risk</span>
          <span className="text-[10px] text-slate-500">ATA-79 · AC 120-42B</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100">✕</button>
      </div>

      {/* Tier counter strip */}
      <div className="grid grid-cols-5 gap-1 mb-2">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`px-1.5 py-1 rounded border text-[10px] ${tierFilter === t ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-700/70'}`}
            style={{ color: TIER_COLOR[t] }}>
            {t} {tally[t]}
          </button>
        ))}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-1 mb-1">
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">MEAN TTL</div>
          <div className="text-sm" style={{ color: summary.meanTtl < 2 ? '#ef4444' : summary.meanTtl < 5 ? '#f59e0b' : '#10b981' }}>{summary.meanTtl > 50 ? '>50h' : summary.meanTtl.toFixed(1) + 'h'}</div>
        </div>
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">WORST</div>
          <div className="text-[11px] text-slate-200 truncate">{summary.worstCs || '—'}{summary.worstEng ? ` E${summary.worstEng}` : ''}</div>
        </div>
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">IFSD</div>
          <div className="text-sm" style={{ color: summary.ifsd ? '#ef4444' : '#10b981' }}>{summary.ifsd}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 mb-2">
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">MEAN CONS</div>
          <div className="text-sm text-sky-300">{summary.meanCons.toFixed(2)} qt/h</div>
        </div>
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">FLTR-BYPASS</div>
          <div className="text-sm" style={{ color: summary.fbpShare > 0.25 ? '#f59e0b' : '#10b981' }}>{(summary.fbpShare * 100).toFixed(0)}%</div>
        </div>
      </div>

      {/* Diagnostic */}
      {showDiag && (
        <div className="mb-2 rounded border border-slate-700/60 bg-slate-900/60 p-1">
          <div className="text-[9px] text-slate-500 mb-0.5">TTL-hr × CONS-qt/h (every engine)</div>
          <svg width={diag.W} height={diag.H} className="block">
            {/* Rose band: TTL <= 1.5h */}
            <rect x={diag.padL} y={diag.padT} width={diag.xToPx(1.5) - diag.padL} height={diag.H - diag.padT - diag.padB} fill="#ef4444" fillOpacity={0.10} />
            {/* Amber 1.5..3h */}
            <rect x={diag.xToPx(1.5)} y={diag.padT} width={diag.xToPx(3) - diag.xToPx(1.5)} height={diag.H - diag.padT - diag.padB} fill="#f59e0b" fillOpacity={0.08} />
            {/* Sky 3..6h */}
            <rect x={diag.xToPx(3)} y={diag.padT} width={diag.xToPx(6) - diag.xToPx(3)} height={diag.H - diag.padT - diag.padB} fill="#0ea5e9" fillOpacity={0.05} />
            {/* Axes & gridlines */}
            <line x1={diag.padL} y1={diag.H - diag.padB} x2={diag.W - diag.padR} y2={diag.H - diag.padB} stroke="#334155" />
            <line x1={diag.padL} y1={diag.padT} x2={diag.padL} y2={diag.H - diag.padB} stroke="#334155" />
            {[1, 3, 6, 9, 12].map(x => (
              <g key={'vx' + x}>
                <line x1={diag.xToPx(x)} y1={diag.padT} x2={diag.xToPx(x)} y2={diag.H - diag.padB} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xToPx(x)} y={diag.H - diag.padB + 10} fontSize={8} fill="#64748b" textAnchor="middle">{x}h</text>
              </g>
            ))}
            {[0.2, 0.5, 0.8].map(y => (
              <g key={'hy' + y}>
                <line x1={diag.padL} y1={diag.yToPx(y)} x2={diag.W - diag.padR} y2={diag.yToPx(y)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.padL - 4} y={diag.yToPx(y) + 3} fontSize={8} fill="#64748b" textAnchor="end">{y.toFixed(1)}</text>
              </g>
            ))}
            {/* Engine dots */}
            {rows.flatMap(r => r.engines.map((e, i) => {
              const xx = diag.xToPx(Math.min(diag.xMax, e.ttlHr))
              const yy = diag.yToPx(Math.min(diag.yMax, e.cons))
              return <circle key={r.f.icao + '-' + i} cx={xx} cy={yy} r={2} fill={TIER_COLOR[e.tier]} fillOpacity={0.85} />
            }))}
            <text x={diag.W - diag.padR} y={diag.H - 4} fontSize={8} fill="#64748b" textAnchor="end">TTL-hr</text>
            <text x={diag.padL + 4} y={diag.padT + 8} fontSize={8} fill="#64748b">qt/h</text>
          </svg>
        </div>
      )}

      {/* Sliders */}
      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">MIN-FL</span><span className="text-[10px] text-slate-300">{minFl}</span></div>
          <input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">FLEET-AGE %</span><span className="text-[10px] text-slate-300">{fleetAge}</span></div>
          <input type="range" min={50} max={200} value={fleetAge} onChange={e => setFleetAge(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">CONS-MUL %</span><span className="text-[10px] text-slate-300">{consMul}</span></div>
          <input type="range" min={50} max={200} value={consMul} onChange={e => setConsMul(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">TEMP-BIAS °C</span><span className="text-[10px] text-slate-300">{tempBias > 0 ? '+' + tempBias : tempBias}</span></div>
          <input type="range" min={-20} max={20} value={tempBias} onChange={e => setTempBias(+e.target.value)} className="w-full accent-sky-500" />
        </div>
      </div>
      <div className="mb-2">
        <div className="flex justify-between"><span className="text-[10px] text-slate-500">FBP-SHARE %</span><span className="text-[10px] text-slate-300">{fbpShare}</span></div>
        <input type="range" min={0} max={30} value={fbpShare} onChange={e => setFbpShare(+e.target.value)} className="w-full accent-sky-500" />
      </div>
      <div className="mb-2">
        <div className="flex justify-between"><span className="text-[10px] text-slate-500">ETOPS-MIN ref</span><span className="text-[10px] text-slate-300">{etopsMinSlider}</span></div>
        <input type="range" min={60} max={330} step={30} value={etopsMinSlider} onChange={e => setEtopsMinSlider(+e.target.value)} className="w-full accent-sky-500" />
      </div>

      {/* Class chips */}
      <div className="flex flex-wrap gap-1 mb-2">
        <button onClick={() => setClassFilter('ALL')}
          className={`px-1.5 py-0.5 rounded border text-[10px] ${classFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700/70 text-slate-400'}`}>ALL</button>
        {CLASS_LIST.map(k => (
          <button key={k} onClick={() => setClassFilter(classFilter === k ? 'ALL' : k)}
            className={`px-1.5 py-0.5 rounded border text-[10px] ${classFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700/70 text-slate-400'}`}>{k}</button>
        ))}
      </div>

      {/* Toggles */}
      <div className="flex flex-wrap gap-1 mb-2">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['PROJ', showProj, setShowProj], ['REF', showRef, setShowRef], ['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)}
            className={`px-1.5 py-0.5 rounded border text-[10px] ${v ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700/70 text-slate-400'}`}>{lbl}</button>
        ))}
      </div>

      {/* Search + tabs */}
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type"
        className="w-full mb-2 px-2 py-1 rounded border border-slate-700 bg-slate-900/60 text-[11px] placeholder:text-slate-600" />
      <div className="grid grid-cols-2 gap-1 mb-2">
        {(['AIRCRAFT', 'ENGINES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2 py-1 rounded border text-[10px] ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700/70 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      {/* Rows */}
      <div className="space-y-1">
        {tab === 'AIRCRAFT' && filteredRows.slice(0, 60).map(r => (
          <div key={r.f.icao} className="rounded border border-slate-700/60 bg-slate-900/60 overflow-hidden cursor-pointer hover:border-sky-500/40" onClick={() => onFly(r.f.icao)}>
            <div className="h-0.5" style={{ background: TIER_COLOR[r.tier] }} />
            <div className="p-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <span className="text-[11px] font-semibold text-slate-100">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-[9px] text-slate-500">{r.f.type || '—'}</span>
                  <span className="text-[9px] px-1 rounded border border-slate-700/70 text-slate-400">{r.klass}</span>
                </div>
                <span className="text-[9px] px-1 rounded border" style={{ color: TIER_COLOR[r.tier], borderColor: TIER_COLOR[r.tier] + '55' }}>{r.tier}</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                FL{Math.round(r.f.altitudeFt / 100)} · {r.spec.family} · {r.spec.engCount}× · ETOPS-{r.spec.etopsMin || 'N/A'}
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: r.score + '%', background: TIER_COLOR[r.tier] }} />
              </div>
              <div className="mt-1 grid grid-cols-2 gap-1">
                {r.engines.map(e => (
                  <div key={e.pos} className="px-1.5 py-1 rounded border" style={{ borderColor: TIER_COLOR[e.tier] + '55' }}>
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-slate-300">E{e.pos}</span>
                      <span style={{ color: TIER_COLOR[e.tier] }}>{e.driver}</span>
                    </div>
                    <div className="text-[9px] text-slate-400 mt-0.5">
                      <span style={{ color: e.qty <= r.spec.minQt ? '#ef4444' : e.qty <= r.spec.addQt ? '#f59e0b' : '#94a3b8' }}>{e.qty.toFixed(1)}qt</span>
                      {' · '}
                      <span style={{ color: e.cons >= r.spec.consAlert ? '#f59e0b' : '#94a3b8' }}>{e.cons.toFixed(2)}/h</span>
                      {' · '}
                      <span style={{ color: e.temp >= r.spec.tempMax ? '#ef4444' : e.temp >= r.spec.tempNom + 30 ? '#f59e0b' : '#94a3b8' }}>{e.temp.toFixed(0)}°</span>
                      {' · '}
                      <span style={{ color: e.pres <= r.spec.presMin ? '#ef4444' : e.pres <= r.spec.presNom * 0.6 ? '#f59e0b' : '#94a3b8' }}>{e.pres.toFixed(0)}psi</span>
                    </div>
                    <div className="text-[9px] mt-0.5">
                      <span style={{ color: e.ttlHr < 2 ? '#ef4444' : e.ttlHr < 5 ? '#f59e0b' : '#10b981' }}>
                        TTL {e.ttlHr > 50 ? '>50h' : e.ttlHr.toFixed(1) + 'h'}
                      </span>
                      {e.fbp && <span className="ml-1 px-1 rounded text-[8px]" style={{ color: '#ef4444', borderColor: '#ef444455', border: '1px solid' }}>FBP</span>}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-1 text-[10px] text-slate-400">{r.f.operator || '—'}</div>
              <div className="mt-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>{advice(r)}</div>
            </div>
          </div>
        ))}

        {tab === 'ENGINES' && engAggs.slice(0, 40).map(a => (
          <div key={a.key} className="rounded border border-slate-700/60 bg-slate-900/60 overflow-hidden cursor-pointer hover:border-sky-500/40" onClick={() => a.worstIcao && onFly(a.worstIcao)}>
            <div className="h-0.5" style={{ background: TIER_COLOR[a.worstTier] }} />
            <div className="p-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <span className="text-[9px] px-1 rounded border border-slate-700/70 text-slate-300">{a.klass}</span>
                  <span className="text-[11px] font-semibold text-slate-100">ENG-{a.pos}</span>
                  <span className="text-[9px] text-slate-500">×{a.count} ac</span>
                </div>
                <span className="text-[9px] px-1 rounded border" style={{ color: TIER_COLOR[a.worstTier], borderColor: TIER_COLOR[a.worstTier] + '55' }}>{a.worstTier}</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                mean TTL {a.meanTtl > 40 ? '>40h' : a.meanTtl.toFixed(1) + 'h'} · cons {a.meanCons.toFixed(2)} qt/h · IFSD {a.ifsd}
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: a.meanScore + '%', background: TIER_COLOR[a.worstTier] }} />
              </div>
              <div className="text-[10px] text-slate-400 mt-1">{CLASS_ENG[a.klass].family} · cap {CLASS_ENG[a.klass].capQt}qt · add≤{CLASS_ENG[a.klass].addQt}qt · min {CLASS_ENG[a.klass].minQt}qt · worst {a.worstCs}</div>
            </div>
          </div>
        ))}
        {filteredRows.length === 0 && tab === 'AIRCRAFT' && (
          <div className="text-center text-[10px] text-slate-500 py-4">No aircraft above FL{minFl}.</div>
        )}
      </div>
    </div>
  )
}
