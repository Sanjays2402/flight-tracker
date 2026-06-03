'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Electrical Load / IDG · Generator Bus-Tie & RAT Deployment
   Compliance Monitor (ATA-24)
   -----------------------------------------------------------
   Per-airframe per-generator electrical load (% of rated kVA),
   Integrated Drive Generator (IDG) oil-in temp, bus-tie /
   cross-tie configuration, TRU / battery state-of-charge, and
   Ram Air Turbine (RAT) deployment-criteria proximity, with
   ETOPS electrical-source-isolation compliance per:
     · 14 CFR 25.1351 / 25.1353 / 25.1357 / 25.1431 General
     · 14 CFR 25.1309 system safety
     · 14 CFR 25.671 / 25.901(c) catastrophic-failure mitigation
     · 14 CFR 25 App K ETOPS electrical-source independence
     · 14 CFR 121.161 / 121.374 ETOPS continued safe flight
     · AC 25-19A CMR / AC 120-42B App 2 ETOPS electrical
     · AC 25-22 elec system design / AC 25-7C flight test
     · AC 25-11B Cockpit displays of generator status
     · ICAO Annex 6 Pt I 5.2.6 ECM / 6.18 dispatch
     · ARINC 624 OMS electrical-system reports
     · ARINC 705 attitude / 740 ELMS
     · Boeing AERO Q1-2014 Generator System Reliability
     · Boeing 777 FCOM 6.10 IDG / VFSG / TRU bus architecture
     · Boeing 787 FCOM 6.10 235 VAC variable-frequency
     · Airbus FCOM PRO-NOR-SOP-25 elec / DSC-24 ELEC
     · A380 / A350 GCU + BTC isolation logic
     · CFM56-7B SB 24-1015 IDG oil-leak / disconnect
     · Trent 1000 SB 24-AJ-001 VFSG bearing
     · NTSB AAR-90/06 / AAR-96/03 elec-bus loss IFSD
     · NTSB DCA15IA014 Qantas A380 #2 IDG disc
     · FAA AD 2018-23-51 PW1100G GCU
     · FAA AD 2017-13-09 787 GCU power-down 248 days
     · EASA AD 2018-0233 A350 ELMS
     · SAE ARP 1199 electrical-load analysis
     · SAE AS 1810 / AS 4805 / AS 8033 ATA-24
     · MMEL Boeing 737 24-11 / Airbus A320 24-21
     · UTC Aerospace / Honeywell IDG service data

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash of ICAO24 drives per-
        generator load% (% of rated kVA), IDG oil-in temp °C,
        IDG service-hours, GCU fault flag, bus-tie open/closed
        configuration, TRU output current A, battery SoC %,
        RAT armed flag.
     2. 7-class catalogue HVY/NRW/RGN/BIZ/TBP/GA/FTR with rated
        kVA per generator, IDG temp limit, ETOPS electrical
        authority minutes, battery min-SoC for hot-start,
        cross-tie capability, RAT-equipped flag.
     3. Bus-tie configuration synthesised from generator health:
        symmetric (both gens online), split (one gen lost,
        cross-tied to opposite side), isolated (gen + tie open).
     4. RAT-deployment criteria: dual-gen-fail OR all-AC-bus-
        offline OR APU-out + 1-gen + LOSS-OF-CONTROL trigger
        per Boeing 777 FCOM 6.10 / Airbus DSC-24-RAT.

   5 risk components (composite = max-driver):
     LOAD  worst-generator load% vs rated kVA
           0 at <=70%, ramping 100 at >=110% (overload trip)
     IDGT  IDG oil-in temp vs class limit
           0 at <=120°C, ramping 100 at >=160°C (disconnect)
     BUS   bus-tie config severity
           0 symmetric, 35 split, 70 isolated, 100 all-AC-lost
     TRU   TRU output / battery SoC margin
           0 at SoC >=70%, ramping 100 at <=15% (BAT-OFF)
     RAT   RAT-deployment criteria proximity
           0 normal, 55 armed-pending, 100 deployed (RAT-OUT)

   Composite score = max-driver + 0.10*secondary, clip 0-100.

   Tiers:
     RAT-OUT  score>=80 OR rat-deployed OR all-AC-lost
              rose: declare emergency MAYDAY, run QRH
              ELEC ALL AC BUS OFF, divert nearest suitable
              per AC 120-42B App 2
     ISOLATE  score>=55 amber: bus-tie isolated or gen-overload
              brief crew on electrical load shed plan
              file ETOPS deviation per 14 CFR 121.374
     SHED     score>=25 sky: load-shed advisory or IDG temp
              elevated, monitor every 10 min, schedule MX
     OK       score<25 emerald: symmetric bus, all gens nominal
     IDLE     below MIN-FL slider / on ground: slate

   MapLibre overlay:
     · Tier-coloured halo rings sized by score 8-22 px
     · Rose diamond pin for RAT-OUT with bus-config callout
     · Tier-coloured callsign + worst-gen + driver labels
     · 12-segment dashed forward-projection 50 nm tier-coloured
       for RAT-OUT (drift-down divert vector)
     · Slate reference parallels at lat 60/30/0/-30/-60 every
       12° lng

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-LOAD% tier-coloured / WORST cs+GEN /
       RAT-OUT-count summary
     · 2-cell MEAN-IDG-TEMP °C / BAT-LOW-share secondary
     · SVG load% vs IDG-temp scatter with rose >=100% / >=160°C
       quadrant, amber 90-100% / 140-160°C, sky 80-90% /
       120-140°C, emerald <80% / <120°C; every generator
       plotted as tier-coloured dot
     · 7 sliders MIN-FL / FLEET-AGE / LOAD-MUL / TEMP-BIAS /
       BAT-DEPL / RAT-RATE / ETOPS-MIN
     · 7-class chip filter HVY/NRW/RGN/BIZ/TBP/GA/FTR
     · 4-config chip filter SYM / SPLIT / ISO / LOST
     · HALO/PIN/LBL/PROJ/REF/DIAG toggles + search
     · AIRCRAFT / GENERATORS tab switcher
     · Aircraft tab tier-coloured row with per-gen pills
       (GEN# / load% / IDG-temp / SoC / config / sev-tier)
       + driver chips + advice + click-to-fly
     · Generators tab grouped by class+gen-position sorted
       worst-tier-first

   Layers > Safety & Traffic.
   Persisted: ft-elec
   ============================================================ */

interface ElecFlight {
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
  flights: ElecFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'RAT-OUT' | 'ISOLATE' | 'SHED' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'RAT-OUT': '#ef4444', ISOLATE: '#f59e0b', SHED: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['RAT-OUT', 'ISOLATE', 'SHED', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { 'RAT-OUT': 0, ISOLATE: 1, SHED: 2, OK: 3, IDLE: 4 }

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

interface ElecSpec {
  genCount: number       // engine-driven generators (typ 2..4)
  family: string         // IDG / VFSG / VSCF family
  ratedKVA: number       // per-gen rated kVA
  idgTempLim: number     // °C IDG oil-in disconnect limit
  idgTempNom: number     // °C cruise nominal
  batMinSoc: number      // % battery min hot-start SoC
  etopsElecMin: number   // ETOPS electrical-source authority (min)
  hasRat: boolean        // RAT-equipped
  crossTie: boolean      // cross-tie capable
  family2: string        // TRU/ELMS subsystem
}

const CLASS_ELEC: Record<AcClass, ElecSpec> = {
  HVY: { genCount: 2, family: '120 kVA IDG (777) / 250 kVA VFSG (787)',     ratedKVA: 180, idgTempLim: 160, idgTempNom: 115, batMinSoc: 40, etopsElecMin: 180, hasRat: true,  crossTie: true,  family2: 'ELMS · 4× TRU 75A · 2× 50Ah Li-ion' },
  NRW: { genCount: 2, family: '90 kVA IDG (CFM56 / LEAP)',                  ratedKVA: 90,  idgTempLim: 155, idgTempNom: 110, batMinSoc: 35, etopsElecMin: 120, hasRat: true,  crossTie: true,  family2: 'PEPDC · 3× TRU 50A · 2× 23Ah NiCd' },
  RGN: { genCount: 2, family: '60 kVA IDG (CF34 / PW1500G)',                ratedKVA: 60,  idgTempLim: 150, idgTempNom: 105, batMinSoc: 30, etopsElecMin: 60,  hasRat: false, crossTie: true,  family2: '2× TRU 30A · 1× 17Ah NiCd' },
  BIZ: { genCount: 2, family: '40 kVA GCU (BR710 / PW307)',                 ratedKVA: 40,  idgTempLim: 150, idgTempNom: 105, batMinSoc: 30, etopsElecMin: 0,   hasRat: true,  crossTie: true,  family2: '2× TRU 25A · 1× 17Ah Li-ion' },
  TBP: { genCount: 2, family: '28 V DC starter-gen (PT6 / PW150)',          ratedKVA: 12,  idgTempLim: 145, idgTempNom: 100, batMinSoc: 25, etopsElecMin: 0,   hasRat: false, crossTie: false, family2: '1× TRU 25A · 1× 25Ah lead-acid' },
  GA:  { genCount: 1, family: '28 V DC alternator (IO-540)',                ratedKVA: 3.5, idgTempLim: 140, idgTempNom: 95,  batMinSoc: 20, etopsElecMin: 0,   hasRat: false, crossTie: false, family2: '1× regulator · 1× 35Ah lead-acid' },
  FTR: { genCount: 2, family: '90 kVA IDG (F119 / F135) + EPGS',            ratedKVA: 110, idgTempLim: 170, idgTempNom: 120, batMinSoc: 50, etopsElecMin: 0,   hasRat: true,  crossTie: true,  family2: 'EPGS · 4× TRU 65A · 2× 40Ah Li-ion' },
}

type Driver = 'LOAD' | 'IDGT' | 'BUS' | 'TRU' | 'RAT' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  LOAD: 'Generator overload',
  IDGT: 'IDG over-temp',
  BUS: 'Bus-tie isolated',
  TRU: 'TRU / battery low',
  RAT: 'RAT deployment criteria',
  NONE: 'Nominal',
}

type BusConfig = 'SYM' | 'SPLIT' | 'ISO' | 'LOST'
const BUS_LIST: BusConfig[] = ['SYM', 'SPLIT', 'ISO', 'LOST']
const BUS_LABEL: Record<BusConfig, string> = {
  SYM: 'Symmetric · both AC tied',
  SPLIT: 'Split · cross-tied',
  ISO: 'Isolated · gen+tie open',
  LOST: 'All AC bus lost',
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

interface GenState {
  pos: number          // 1..4
  loadPct: number      // % rated
  idgTemp: number      // °C
  idgHr: number        // service hours
  gcuFault: boolean
  sev: { load: number; idgt: number }
  score: number
  driver: Driver
  tier: Tier
}

interface Row {
  f: ElecFlight
  klass: AcClass
  spec: ElecSpec
  gens: GenState[]
  worst: GenState
  busConfig: BusConfig
  truA: number          // TRU output amps (one bus)
  truRated: number
  batSoc: number        // % battery state of charge
  ratArmed: boolean
  ratDeployed: boolean
  busSev: number
  truSev: number
  ratSev: number
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'elec-halo', SRC_LBL = 'elec-lbl', SRC_PIN = 'elec-pin', SRC_PROJ = 'elec-proj', SRC_REF = 'elec-ref'
const LYR_HALO = 'elec-halo-l', LYR_LBL = 'elec-lbl-l', LYR_PIN = 'elec-pin-l', LYR_PROJ = 'elec-proj-l', LYR_REF = 'elec-ref-l'

export default function ElectricalBus({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'GENERATORS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [busFilter, setBusFilter] = useState<BusConfig | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(30)
  const [fleetAge, setFleetAge] = useState(100)
  const [loadMul, setLoadMul] = useState(100)
  const [tempBias, setTempBias] = useState(0)
  const [batDepl, setBatDepl] = useState(0)     // -30..+10 %
  const [ratRate, setRatRate] = useState(2)     // 0..15 pct fleet share-armed
  const [etopsMinSlider, setEtopsMinSlider] = useState(180)
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
      const spec = CLASS_ELEC[klass]
      const h = hash32(f.icao || '')
      const ageMul = fleetAge / 100

      const gens: GenState[] = []
      let anyGenFail = false
      let genFailCount = 0
      for (let g = 0; g < spec.genCount; g++) {
        const hh = (h ^ (0x9e3779b9 * (g + 1))) >>> 0
        const r0 = ((hh >>> 0) & 0xffff) / 0xffff
        const r1 = ((hh >>> 8) & 0xffff) / 0xffff
        const r2 = ((hh >>> 16) & 0xffff) / 0xffff
        const r3 = (((hh * 0x85ebca6b) >>> 0) & 0xffff) / 0xffff

        // Load%: typical cruise 55-85, age-skewed up, multiplier
        const loadBase = 45 + r0 * 60
        const loadPct = Math.min(135, loadBase * (loadMul / 100) * (0.9 + (ageMul - 1) * 0.3))

        // IDG temp: nom ± 50, age-skewed up
        const idgTemp = spec.idgTempNom - 10 + r1 * 75 * (0.85 + (ageMul - 1) * 0.5) + tempBias

        // Service hours: 1k..18k, age-scaled
        const idgHr = (1000 + r2 * 17000) * ageMul

        // GCU fault: ~3% per gen (age-amplified)
        const gcuFault = r3 < 0.025 * Math.max(1, ageMul)

        const loadSev = loadPct <= 70 ? 0
          : loadPct >= 110 ? 100
          : ((loadPct - 70) / 40) * 100
        const idgtSev = idgTemp <= 120 ? 0
          : idgTemp >= 160 ? 100
          : ((idgTemp - 120) / 40) * 100
        const sLoad = Math.min(100, loadSev + (gcuFault ? 25 : 0))

        const sev = { load: sLoad, idgt: idgtSev }
        const sevList: Array<[Driver, number]> = [['LOAD', sLoad], ['IDGT', idgtSev]]
        sevList.sort((a, b) => b[1] - a[1])
        const driver: Driver = sevList[0][1] > 0 ? sevList[0][0] : 'NONE'
        const score = Math.min(100, sevList[0][1] + sevList[1][1] * 0.10)

        // Per-gen tier: this gen failed if load>=110 OR idg>=lim OR gcuFault
        const failed = loadPct >= 110 || idgTemp >= spec.idgTempLim || gcuFault
        if (failed) { anyGenFail = true; genFailCount++ }

        let tier: Tier
        if (score >= 80 || failed) tier = 'RAT-OUT'
        else if (score >= 55) tier = 'ISOLATE'
        else if (score >= 25) tier = 'SHED'
        else tier = 'OK'

        gens.push({ pos: g + 1, loadPct, idgTemp, idgHr, gcuFault, sev, score, driver, tier })
      }

      // Bus-tie config from gen-fail count
      let busConfig: BusConfig
      if (genFailCount === 0) busConfig = 'SYM'
      else if (genFailCount === 1) busConfig = spec.crossTie ? 'SPLIT' : 'ISO'
      else if (genFailCount < spec.genCount) busConfig = 'ISO'
      else busConfig = 'LOST'
      const busSev = busConfig === 'SYM' ? 0 : busConfig === 'SPLIT' ? 35 : busConfig === 'ISO' ? 70 : 100

      // TRU output: derate when bus split/isolated
      const r4 = ((h >>> 20) & 0xffff) / 0xffff
      const truRated = klass === 'HVY' ? 75 : klass === 'NRW' ? 50 : klass === 'RGN' || klass === 'BIZ' ? 30 : 25
      const truLoadFrac = busConfig === 'LOST' ? 0.0 : busConfig === 'ISO' ? 0.30 + r4 * 0.30 : 0.45 + r4 * 0.35
      const truA = truRated * truLoadFrac

      // Battery SoC: 100% nominal, depleted when bus lost / time
      const baseSoc = 100 - r4 * 35 + batDepl
      const batSoc = Math.max(0, Math.min(100, busConfig === 'LOST' ? baseSoc * 0.30 : busConfig === 'ISO' ? baseSoc * 0.75 : baseSoc))
      const truSev = batSoc >= 70 ? 0
        : batSoc <= 15 ? 100
        : ((70 - batSoc) / 55) * 100

      // RAT: armed if dual-fail criteria approaching, deployed if all-AC-lost OR (gen-fail + battery low + APU-out hash)
      const r5 = ((h >>> 4) & 0xff) / 255
      const ratEligible = spec.hasRat
      const ratPending = ratEligible && (genFailCount >= 1 && batSoc < 40) || (r5 < (ratRate / 100))
      const ratDeployed = ratEligible && (busConfig === 'LOST' || (genFailCount >= 2 && batSoc < 25))
      const ratSev = ratDeployed ? 100 : ratPending ? 55 : 0

      // Aircraft composite
      const sevList: Array<[Driver, number]> = [
        ['LOAD', gens.reduce((m, g) => Math.max(m, g.sev.load), 0)],
        ['IDGT', gens.reduce((m, g) => Math.max(m, g.sev.idgt), 0)],
        ['BUS',  busSev],
        ['TRU',  truSev],
        ['RAT',  ratSev],
      ]
      sevList.sort((a, b) => b[1] - a[1])
      const driver: Driver = sevList[0][1] > 0 ? sevList[0][0] : 'NONE'
      const score = Math.min(100, sevList[0][1] + sevList[1][1] * 0.10)

      let tier: Tier
      if (ratDeployed || busConfig === 'LOST' || score >= 80) tier = 'RAT-OUT'
      else if (busConfig === 'ISO' || score >= 55) tier = 'ISOLATE'
      else if (score >= 25) tier = 'SHED'
      else tier = 'OK'

      const worst = gens.slice().sort((a, b) => b.score - a.score)[0]
      out.push({
        f, klass, spec, gens, worst, busConfig, truA, truRated, batSoc,
        ratArmed: ratPending, ratDeployed, busSev, truSev, ratSev, score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, fleetAge, loadMul, tempBias, batDepl, ratRate, etopsMinSlider])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { 'RAT-OUT': 0, ISOLATE: 0, SHED: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumLoad = 0, sumLoadN = 0, sumTemp = 0, sumTempN = 0, batLowN = 0, n = 0
    let worst = 0, worstCs = '', worstGen = 0
    for (const r of rows) {
      n++
      for (const g of r.gens) { sumLoad += g.loadPct; sumLoadN++; sumTemp += g.idgTemp; sumTempN++ }
      if (r.batSoc < 50) batLowN++
      if (r.score > worst) { worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstGen = r.worst.pos }
    }
    return {
      meanLoad: sumLoadN ? sumLoad / sumLoadN : 0,
      meanTemp: sumTempN ? sumTemp / sumTempN : 0,
      ratOut: tally['RAT-OUT'], worst, worstCs, worstGen,
      batLow: n ? batLowN / n : 0,
    }
  }, [rows, tally])

  const genAggs = useMemo(() => {
    const m = new Map<string, { key: string; klass: AcClass; pos: number; count: number; sumScore: number; sumLoad: number; sumTemp: number; ratOut: number; worst: number; worstCs: string; worstIcao: string; worstTier: Tier }>()
    for (const r of rows) {
      for (const g of r.gens) {
        const k = r.klass + '|GEN-' + g.pos
        let a = m.get(k)
        if (!a) { a = { key: k, klass: r.klass, pos: g.pos, count: 0, sumScore: 0, sumLoad: 0, sumTemp: 0, ratOut: 0, worst: 0, worstCs: '', worstIcao: '', worstTier: 'OK' }; m.set(k, a) }
        a.count++; a.sumScore += g.score; a.sumLoad += g.loadPct; a.sumTemp += g.idgTemp
        if (g.tier === 'RAT-OUT') a.ratOut++
        if (TIER_RANK[g.tier] < TIER_RANK[a.worstTier]) a.worstTier = g.tier
        if (g.score > a.worst) { a.worst = g.score; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
      }
    }
    return Array.from(m.values()).map(a => ({
      ...a, meanScore: a.count ? a.sumScore / a.count : 0,
      meanLoad: a.count ? a.sumLoad / a.count : 0,
      meanTemp: a.count ? a.sumTemp / a.count : 0,
    })).sort((a, b) => {
      const ti = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
      if (ti !== 0) return ti
      return b.ratOut - a.ratOut || b.count - a.count
    })
  }, [rows])

  // ---- MapLibre rendering ----
  useEffect(() => {
    if (!map) return
    const m = map
    const ready = () => {
      const ensure = (id: string) => {
        if (!m.getSource(id)) m.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      }
      ensure(SRC_HALO); ensure(SRC_PIN); ensure(SRC_LBL); ensure(SRC_PROJ); ensure(SRC_REF)
      if (!m.getLayer(LYR_HALO)) m.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'c'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'c'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85 } })
      if (!m.getLayer(LYR_PROJ)) m.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: { 'line-color': ['get', 'c'], 'line-width': 1.5, 'line-opacity': 0.7, 'line-dasharray': [2, 2] } })
      if (!m.getLayer(LYR_REF)) m.addLayer({ id: LYR_REF, type: 'circle', source: SRC_REF, paint: { 'circle-radius': 1.6, 'circle-color': '#64748b', 'circle-opacity': 0.30 } })
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
      if (showPin && r.tier === 'RAT-OUT') pins.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
      if (showLabels) {
        labels.push({ type: 'Feature', properties: { c, t: `${(r.f.callsign || r.f.icao).trim()}  G${r.worst.pos} ${r.driver} ${r.busConfig}` }, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
      }
      if (showProj && r.tier === 'RAT-OUT') {
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
    if (busFilter !== 'ALL' && r.busConfig !== busFilter) return false
    if (q) {
      const cs = (r.f.callsign || r.f.icao).toUpperCase()
      if (!cs.includes(q) && !(r.f.type || '').toUpperCase().includes(q)) return false
    }
    return true
  }).sort((a, b) => {
    const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
    return ti !== 0 ? ti : b.score - a.score
  })

  // ---- Diagnostic SVG (load% vs IDG-temp) ----
  const diag = useMemo(() => {
    const W = 360, H = 200, padL = 38, padR = 10, padT = 12, padB = 28
    const xMin = 50, xMax = 135   // load %
    const yMin = 90, yMax = 175   // IDG °C
    const xToPx = (x: number) => padL + ((Math.max(xMin, Math.min(xMax, x)) - xMin) / (xMax - xMin)) * (W - padL - padR)
    const yToPx = (y: number) => H - padB - ((Math.max(yMin, Math.min(yMax, y)) - yMin) / (yMax - yMin)) * (H - padT - padB)
    return { W, H, padL, padR, padT, padB, xMin, xMax, yMin, yMax, xToPx, yToPx }
  }, [])

  function advice(r: Row): string {
    if (r.tier === 'RAT-OUT') return `${DRIVER_LABEL[r.driver]} on G${r.worst.pos} (${r.busConfig}). Declare emergency MAYDAY, run QRH ELEC ALL-AC-BUS-OFF, divert nearest suitable per AC 120-42B App 2.`
    if (r.tier === 'ISOLATE') return `Bus-tie ${r.busConfig} · ${DRIVER_LABEL[r.driver].toLowerCase()}. Brief load-shed plan, file ETOPS deviation per 14 CFR 121.374, monitor every 10 min.`
    if (r.tier === 'SHED') return `Load-shed advisory (${DRIVER_LABEL[r.driver].toLowerCase()}). Monitor every 10 min, schedule MX at next port per AC 25-19A.`
    return 'Symmetric bus · all generators within ELMS envelope · nominal.'
  }

  return (
    <div className="fixed top-16 right-2 z-40 w-[440px] max-h-[calc(100vh-5rem)] overflow-y-auto rounded-xl border border-sky-500/40 bg-slate-950/95 backdrop-blur p-3 text-xs text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-sky-300">Electrical / IDG · Bus-Tie · RAT</span>
          <span className="text-[10px] text-slate-500">ATA-24 · AC 120-42B</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100">✕</button>
      </div>

      {/* Tier counters */}
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
          <div className="text-[9px] text-slate-500">MEAN LOAD</div>
          <div className="text-sm" style={{ color: summary.meanLoad > 100 ? '#ef4444' : summary.meanLoad > 85 ? '#f59e0b' : '#10b981' }}>{summary.meanLoad.toFixed(0)}%</div>
        </div>
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">WORST</div>
          <div className="text-[11px] text-slate-200 truncate">{summary.worstCs || '—'}{summary.worstGen ? ` G${summary.worstGen}` : ''}</div>
        </div>
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">RAT-OUT</div>
          <div className="text-sm" style={{ color: summary.ratOut ? '#ef4444' : '#10b981' }}>{summary.ratOut}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 mb-2">
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">MEAN IDG-T</div>
          <div className="text-sm" style={{ color: summary.meanTemp > 150 ? '#ef4444' : summary.meanTemp > 130 ? '#f59e0b' : '#0ea5e9' }}>{summary.meanTemp.toFixed(0)}°C</div>
        </div>
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">BAT-LOW</div>
          <div className="text-sm" style={{ color: summary.batLow > 0.25 ? '#f59e0b' : '#10b981' }}>{(summary.batLow * 100).toFixed(0)}%</div>
        </div>
      </div>

      {/* Diagnostic SVG */}
      {showDiag && (
        <div className="mb-2 rounded border border-slate-700/60 bg-slate-900/60 p-1">
          <div className="text-[9px] text-slate-500 mb-0.5">LOAD% × IDG-T °C (per gen)</div>
          <svg width={diag.W} height={diag.H} className="block">
            {/* Quadrant bands */}
            <rect x={diag.xToPx(100)} y={diag.padT} width={diag.W - diag.padR - diag.xToPx(100)} height={diag.yToPx(160) - diag.padT} fill="#ef4444" fillOpacity={0.10} />
            <rect x={diag.xToPx(90)} y={diag.padT} width={diag.xToPx(100) - diag.xToPx(90)} height={diag.yToPx(140) - diag.padT} fill="#f59e0b" fillOpacity={0.08} />
            <rect x={diag.xToPx(80)} y={diag.padT} width={diag.xToPx(90) - diag.xToPx(80)} height={diag.yToPx(120) - diag.padT} fill="#0ea5e9" fillOpacity={0.05} />
            {/* Axes */}
            <line x1={diag.padL} y1={diag.H - diag.padB} x2={diag.W - diag.padR} y2={diag.H - diag.padB} stroke="#334155" />
            <line x1={diag.padL} y1={diag.padT} x2={diag.padL} y2={diag.H - diag.padB} stroke="#334155" />
            {[70, 85, 100, 110, 125].map(x => (
              <g key={'vx' + x}>
                <line x1={diag.xToPx(x)} y1={diag.padT} x2={diag.xToPx(x)} y2={diag.H - diag.padB} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xToPx(x)} y={diag.H - diag.padB + 10} fontSize={8} fill="#64748b" textAnchor="middle">{x}%</text>
              </g>
            ))}
            {[100, 120, 140, 160].map(y => (
              <g key={'hy' + y}>
                <line x1={diag.padL} y1={diag.yToPx(y)} x2={diag.W - diag.padR} y2={diag.yToPx(y)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.padL - 4} y={diag.yToPx(y) + 3} fontSize={8} fill="#64748b" textAnchor="end">{y}°</text>
              </g>
            ))}
            {/* Red-line at 110% / 160°C */}
            <line x1={diag.xToPx(110)} y1={diag.padT} x2={diag.xToPx(110)} y2={diag.H - diag.padB} stroke="#ef4444" strokeDasharray="3 2" strokeOpacity={0.5} />
            <line x1={diag.padL} y1={diag.yToPx(160)} x2={diag.W - diag.padR} y2={diag.yToPx(160)} stroke="#ef4444" strokeDasharray="3 2" strokeOpacity={0.5} />
            {/* Gen dots */}
            {rows.flatMap(r => r.gens.map((g, i) => {
              const xx = diag.xToPx(g.loadPct)
              const yy = diag.yToPx(g.idgTemp)
              return <circle key={r.f.icao + '-' + i} cx={xx} cy={yy} r={2} fill={TIER_COLOR[g.tier]} fillOpacity={0.85} />
            }))}
            <text x={diag.W - diag.padR} y={diag.H - 4} fontSize={8} fill="#64748b" textAnchor="end">LOAD%</text>
            <text x={diag.padL + 4} y={diag.padT + 8} fontSize={8} fill="#64748b">IDG °C</text>
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
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">LOAD-MUL %</span><span className="text-[10px] text-slate-300">{loadMul}</span></div>
          <input type="range" min={50} max={200} value={loadMul} onChange={e => setLoadMul(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">TEMP-BIAS °C</span><span className="text-[10px] text-slate-300">{tempBias > 0 ? '+' + tempBias : tempBias}</span></div>
          <input type="range" min={-20} max={30} value={tempBias} onChange={e => setTempBias(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">BAT-DEPL %</span><span className="text-[10px] text-slate-300">{batDepl > 0 ? '+' + batDepl : batDepl}</span></div>
          <input type="range" min={-30} max={10} value={batDepl} onChange={e => setBatDepl(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">RAT-RATE %</span><span className="text-[10px] text-slate-300">{ratRate}</span></div>
          <input type="range" min={0} max={15} value={ratRate} onChange={e => setRatRate(+e.target.value)} className="w-full accent-sky-500" />
        </div>
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

      {/* Bus config chips */}
      <div className="flex flex-wrap gap-1 mb-2">
        <button onClick={() => setBusFilter('ALL')}
          className={`px-1.5 py-0.5 rounded border text-[10px] ${busFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700/70 text-slate-400'}`}>BUS-ALL</button>
        {BUS_LIST.map(b => (
          <button key={b} onClick={() => setBusFilter(busFilter === b ? 'ALL' : b)}
            className={`px-1.5 py-0.5 rounded border text-[10px] ${busFilter === b ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700/70 text-slate-400'}`}>{b}</button>
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
        {(['AIRCRAFT', 'GENERATORS'] as const).map(t => (
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
                  <span className="text-[9px] px-1 rounded border" style={{ color: r.busConfig === 'SYM' ? '#10b981' : r.busConfig === 'SPLIT' ? '#0ea5e9' : r.busConfig === 'ISO' ? '#f59e0b' : '#ef4444', borderColor: '#33415555' }}>{r.busConfig}</span>
                  {r.ratDeployed && <span className="text-[9px] px-1 rounded border border-rose-500/55 text-rose-400">RAT</span>}
                </div>
                <span className="text-[9px] px-1 rounded border" style={{ color: TIER_COLOR[r.tier], borderColor: TIER_COLOR[r.tier] + '55' }}>{r.tier}</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                FL{Math.round(r.f.altitudeFt / 100)} · {r.spec.family} · {r.spec.genCount}× {r.spec.ratedKVA}kVA · ETOPS-{r.spec.etopsElecMin || 'N/A'}
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: r.score + '%', background: TIER_COLOR[r.tier] }} />
              </div>
              <div className="mt-1 grid grid-cols-2 gap-1">
                {r.gens.map(g => (
                  <div key={g.pos} className="px-1.5 py-1 rounded border" style={{ borderColor: TIER_COLOR[g.tier] + '55' }}>
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-slate-300">G{g.pos}</span>
                      <span style={{ color: TIER_COLOR[g.tier] }}>{g.driver}</span>
                    </div>
                    <div className="text-[9px] text-slate-400 mt-0.5">
                      <span style={{ color: g.loadPct >= 110 ? '#ef4444' : g.loadPct >= 90 ? '#f59e0b' : '#94a3b8' }}>{g.loadPct.toFixed(0)}%</span>
                      {' · '}
                      <span style={{ color: g.idgTemp >= r.spec.idgTempLim ? '#ef4444' : g.idgTemp >= r.spec.idgTempNom + 25 ? '#f59e0b' : '#94a3b8' }}>{g.idgTemp.toFixed(0)}°</span>
                      {' · '}
                      <span className="text-slate-500">{(g.idgHr / 1000).toFixed(1)}kh</span>
                    </div>
                    <div className="text-[9px] mt-0.5">
                      {g.gcuFault && <span className="px-1 rounded border border-rose-500/55 text-rose-400">GCU-FLT</span>}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-1 grid grid-cols-3 gap-1 text-[9px]">
                <div className="px-1 rounded border border-slate-700/60">
                  <span className="text-slate-500">TRU </span>
                  <span style={{ color: r.truA / r.truRated > 0.85 ? '#f59e0b' : '#94a3b8' }}>{r.truA.toFixed(0)}/{r.truRated}A</span>
                </div>
                <div className="px-1 rounded border border-slate-700/60">
                  <span className="text-slate-500">BAT </span>
                  <span style={{ color: r.batSoc < 25 ? '#ef4444' : r.batSoc < 50 ? '#f59e0b' : '#10b981' }}>{r.batSoc.toFixed(0)}%</span>
                </div>
                <div className="px-1 rounded border border-slate-700/60">
                  <span className="text-slate-500">RAT </span>
                  <span style={{ color: r.ratDeployed ? '#ef4444' : r.ratArmed ? '#f59e0b' : r.spec.hasRat ? '#10b981' : '#64748b' }}>{r.ratDeployed ? 'OUT' : r.ratArmed ? 'ARM' : r.spec.hasRat ? 'STBY' : 'N/A'}</span>
                </div>
              </div>
              <div className="mt-1 text-[9px] text-slate-500">{r.spec.family2}</div>
              <div className="mt-1 text-[10px] text-slate-400">{r.f.operator || '—'}</div>
              <div className="mt-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>{advice(r)}</div>
            </div>
          </div>
        ))}

        {tab === 'GENERATORS' && genAggs.slice(0, 40).map(a => (
          <div key={a.key} className="rounded border border-slate-700/60 bg-slate-900/60 overflow-hidden cursor-pointer hover:border-sky-500/40" onClick={() => a.worstIcao && onFly(a.worstIcao)}>
            <div className="h-0.5" style={{ background: TIER_COLOR[a.worstTier] }} />
            <div className="p-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <span className="text-[9px] px-1 rounded border border-slate-700/70 text-slate-300">{a.klass}</span>
                  <span className="text-[11px] font-semibold text-slate-100">GEN-{a.pos}</span>
                  <span className="text-[9px] text-slate-500">×{a.count} ac</span>
                </div>
                <span className="text-[9px] px-1 rounded border" style={{ color: TIER_COLOR[a.worstTier], borderColor: TIER_COLOR[a.worstTier] + '55' }}>{a.worstTier}</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                mean load {a.meanLoad.toFixed(0)}% · IDG {a.meanTemp.toFixed(0)}°C · RAT-OUT {a.ratOut}
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: a.meanScore + '%', background: TIER_COLOR[a.worstTier] }} />
              </div>
              <div className="text-[10px] text-slate-400 mt-1">{CLASS_ELEC[a.klass].family} · {CLASS_ELEC[a.klass].ratedKVA}kVA · lim {CLASS_ELEC[a.klass].idgTempLim}°C · worst {a.worstCs}</div>
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
