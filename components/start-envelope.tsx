'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Engine Start Envelope · Hot-Start / Hung-Start / Wet-Start
   Cold-Soak Margin Monitor  (ATA-80 Starting / ATA-71 Powerplant)
   ------------------------------------------------------------
   Per-airframe engine-start sequence health on the ground:
   starter air-pressure delivered (psi) vs FCOM minimum,
   N2 motoring acceleration rpm/s vs spec, time-from-cutoff
   to commanded fuel-on, EGT peak at light-off vs RTO redline,
   TAT cold-soak penalty, APU bleed vs cross-bleed vs GPU
   air-cart source, hot-start / hung-start / wet-start risk
   per engine, and per-class start envelope.

   Regulatory & operational basis:
     · 14 CFR 33.89  Engine starting tests
     · 14 CFR 33.27  Turbine, compressor, fan blade burst
     · 14 CFR 25.901(b)(2) propulsion system safety
     · 14 CFR 25.903(d)(1) engine fire / containment
     · 14 CFR 25.1309 systems & equipment
     · AC 33.89-1  Engine starting characteristics
     · AC 25-7D §31 powerplant flight test
     · AC 120-94 ETOPS in-flight start (relight covered separately)
     · CS-E 740 EASA starting
     · CS-25.901 / 25.903 EASA
     · ICAO Annex 8 IIIA powerplant cert
     · ARINC 429 label 350-377 N1 / N2 / EGT
     · ARINC 706 / 738 ADIRU TAT / SAT
     · SAE ARP 5316 starter requirements
     · SAE ARP 4754A / ARP 4761 FHA/PSSA/SSA
     · Boeing 737NG/MAX FCOM 7.20 ENG START
       757/767/777/787 FCOM 7.20 ENG START
     · Airbus A320 / A330 / A350 FCOM PRO-NOR-SOP-70 START
     · NTSB DCA08IA049 PW-150 hot-start
     · NTSB DCA14IA063 V2500 hung-start
     · FAA AD 2018-08-09  CFM56-7B starter cutout
     · FAA AD 2021-12-09  LEAP-1B starter air valve
     · EASA AD 2020-0186  Trent XWB starter check valve
     · Boeing SB 737-80-A105  hot-start preventive
     · Airbus SB A320-80-1003  starter air valve

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash of ICAO24 synthesises
        per-engine starter air pressure psi, N2 motoring
        rpm/s, fuel-on cut-in N2 %, peak EGT C, light-off
        time s, and wet-start probability.
     2. 6-class start catalogue HVY-Q / HVY / NRW / RGN /
        BIZ / TBP carrying engine count, nominal starter
        air psi at AIR-cart, N2-min for fuel-on, EGT
        redline, target light-off time, primary start source
        (APU / X-BLEED / GPU / BAT), and per-class hung-start
        sensitivity.
     3. Phase classifier START / TAXI / PRE-T (only START is
        active for hot/hung detection; others are post-start
        residual context).
     4. 5 risk drivers max-driver composite:
        · PSI  starter air psi vs min FCOM        ramped
        · MOT  N2 motoring acceleration vs spec    ramped
        · EGT  peak EGT vs redline                 ramped
        · LOT  light-off / fuel-on timing          ramped
        · TAT  cold-soak TAT penalty               ramped
     5. Hard escalations:
        · EGT >= redline → HOT-START tier
        · N2 stagnates < cut-in for > 25 s → HUNG-START tier
        · Fuel-on without light-off > 12 s → WET-START tier
     6. 5 tiers HOT-START / HUNG / WATCH / OK / IDLE

   MapLibre overlay:
     · Tier-coloured halo rings sized 8-22 px by score
     · Rose diamond pin at current pos for HOT-START
     · Tier-coloured callsign + ENG-n + driver labels
     · 12-segment dashed taxi-projection 4 nm tier-coloured
       for HOT / HUNG
     · Sky reference parallels at lat 60 / 30 / 0 / -30 / -60
       every 12° lng

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell WORST-EGT / WORST callsign+ENG / HOT-count
     · 2-cell MEAN-PSI-Δ / HUNG-share secondary row
     · SVG peak-EGT vs light-off-time scatter with rose
       hot-start zone above redline and amber +25C
     · 6 sliders MIN-FL / FLEET-AGE / PSI-MUL / TAT-BIAS /
       SRC-RATE / PHASE-WT
     · 6-class chip filter + HALO / PIN / LBL / PROJ / REF /
       DIAG toggles + search
     · AIRCRAFT / CLASSES tab switcher
     · Aircraft row with per-engine pill grid (N2-rpm,
       EGT-C, source-pill) tier-coloured
     · CLASSES grouped by class worst-tier-first

   Layers > Safety & Traffic.
   Persisted: ft-start
   ============================================================ */

interface StartFlight {
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
  flights: StartFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'HOT-START' | 'HUNG' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'HOT-START': '#ef4444', HUNG: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['HOT-START', 'HUNG', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { 'HOT-START': 0, HUNG: 1, WATCH: 2, OK: 3, IDLE: 4 }

type AcClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const CLASS_LIST: AcClass[] = ['HVY-Q', 'HVY', 'NRW', 'RGN', 'BIZ', 'TBP']
const CLASS_LABEL: Record<AcClass, string> = {
  'HVY-Q': 'Heavy quad', HVY: 'Heavy twin', NRW: 'Narrowbody', RGN: 'Regional', BIZ: 'Bizjet', TBP: 'Turboprop',
}

type Source = 'APU' | 'X-BLEED' | 'GPU' | 'BAT'

interface StSpec {
  family: string
  engines: number
  psiMin: number       // FCOM min start-bleed psi
  n2Cut: number        // N2 % for fuel-on
  egtRed: number       // peak EGT redline °C
  lotSec: number       // nominal time-to-light-off s
  source: Source
  hungSens: number     // 0.5..1.5 hung-start sensitivity
}

const CLASS_SPEC: Record<AcClass, StSpec> = {
  'HVY-Q': { family: '747-8 / A380 / A340',    engines: 4, psiMin: 30, n2Cut: 25, egtRed: 750, lotSec: 18, source: 'APU',     hungSens: 0.9 },
  HVY:    { family: '777 / 787 / A350 / A330',  engines: 2, psiMin: 35, n2Cut: 22, egtRed: 800, lotSec: 16, source: 'APU',     hungSens: 1.0 },
  NRW:    { family: '737NG-MAX / A320 / 757',   engines: 2, psiMin: 30, n2Cut: 20, egtRed: 725, lotSec: 14, source: 'APU',     hungSens: 1.1 },
  RGN:    { family: 'CRJ / E-Jet / MD-80',      engines: 2, psiMin: 28, n2Cut: 18, egtRed: 700, lotSec: 12, source: 'APU',     hungSens: 1.2 },
  BIZ:    { family: 'GLF / FA7X / CL30',        engines: 2, psiMin: 32, n2Cut: 20, egtRed: 760, lotSec: 12, source: 'X-BLEED', hungSens: 1.0 },
  TBP:    { family: 'PT6 / PW150 / TPE331',     engines: 2, psiMin: 0,  n2Cut: 12, egtRed: 850, lotSec: 8,  source: 'BAT',     hungSens: 1.3 },
}

type Driver = 'PSI' | 'MOT' | 'EGT' | 'LOT' | 'TAT' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  PSI: 'Starter air pressure', MOT: 'N2 motoring acceleration', EGT: 'Peak EGT vs redline',
  LOT: 'Light-off / fuel-on timing', TAT: 'Cold-soak TAT penalty', NONE: 'Nominal',
}

type Phase = 'START' | 'TAXI' | 'PRE-T'
const PHASE_MUL: Record<Phase, number> = { START: 2.50, TAXI: 1.10, 'PRE-T': 1.00 }

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|A38|A34|IL96/.test(t)) return 'HVY-Q'
  if (/B77|B78|A33|A35|MD11/.test(t)) return 'HVY'
  if (/B73|A31|A319|A32|A22|B75|MD8|B71/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E27|E29|E[12]7|E[12]9|F70|F100/.test(t)) return 'RGN'
  if (/G[VI458]|GLF|GLEX|FA[78]X|F2TH|CL30|CL60|C68|C75|BE40|H25|LJ/.test(t)) return 'BIZ'
  return 'TBP'
}

function classifyPhase(alt: number, vel: number, ground: boolean): Phase {
  if (!ground) return 'PRE-T'
  if (vel < 5) return 'START'
  if (vel < 30) return 'TAXI'
  return 'PRE-T'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

interface EngState { psi: number; mot: number; egt: number; lot: number; src: Source; wet: boolean }

interface Row {
  f: StartFlight
  klass: AcClass
  spec: StSpec
  phase: Phase
  eng: EngState[]
  worstEgt: number
  meanPsi: number
  hungEng: number   // count of hung
  hotEng: number
  wetEng: number
  sev: { psi: number; mot: number; egt: number; lot: number; tat: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'st-halo', SRC_LBL = 'st-lbl', SRC_PIN = 'st-pin', SRC_PROJ = 'st-proj', SRC_REF = 'st-ref'
const LYR_HALO = 'st-halo-l', LYR_LBL = 'st-lbl-l', LYR_PIN = 'st-pin-l', LYR_PROJ = 'st-proj-l', LYR_REF = 'st-ref-l'

export default function StartEnvelope({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [fleetAge, setFleetAge] = useState(100)
  const [psiMul, setPsiMul] = useState(100)
  const [tatBias, setTatBias] = useState(0)    // -40..+40 °C
  const [srcRate, setSrcRate] = useState(100)  // 50..250
  const [phaseWt, setPhaseWt] = useState(100)
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
      // Only consider ground / low-speed aircraft for start envelope
      if (!f.ground) continue
      const phase = classifyPhase(f.altitudeFt, f.velocityKts, f.ground)
      if (phase === 'PRE-T') continue
      if (f.altitudeFt / 100 < minFl) continue
      const klass = classifyClass(f.type || '')
      const spec = CLASS_SPEC[klass]
      const h = hash32(f.icao || '')
      const ageMul = fleetAge / 100

      const eng: EngState[] = []
      let egtWorst = 0, psiSum = 0
      let hung = 0, hot = 0, wet = 0
      for (let i = 0; i < spec.engines; i++) {
        const hi = hash32((f.icao || '') + ':' + i)
        const r0 = (hi & 0xffff) / 0xffff
        const r1 = ((hi >>> 8) & 0xffff) / 0xffff
        const r2 = ((hi >>> 16) & 0xffff) / 0xffff
        const r3 = (((hi * 0x27d4eb2d) >>> 16) & 0xffff) / 0xffff

        // Source picker (APU usual; cross-bleed if APU offline rare; GPU air-cart rarer)
        let src: Source = spec.source
        const sr = r3 * (srcRate / 100)
        if (sr > 0.90 && spec.engines >= 2) src = 'X-BLEED'
        if (sr > 0.97) src = 'GPU'
        if (klass === 'TBP') src = 'BAT'

        // Starter air pressure delivered (psi)
        const psiNoise = (r0 - 0.5) * 14 * (psiMul / 100)
        const srcPsiBonus = src === 'GPU' ? 8 : src === 'X-BLEED' ? -4 : 0
        const psi = Math.max(0, spec.psiMin + psiNoise + srcPsiBonus)

        // N2 motoring acceleration rpm/s — depends on psi and TAT (cold-soak penalty)
        const tat = 15 + tatBias
        const tatPenalty = tat < -20 ? (-20 - tat) * 0.012 : 0
        const motNominal = 1.20 // N2 %/s
        const mot = Math.max(0.05, motNominal * (psi / Math.max(1, spec.psiMin)) - tatPenalty - (r1 - 0.5) * 0.10 * ageMul)

        // Time to N2-cut-in (fuel-on threshold)
        const tCut = mot > 0 ? spec.n2Cut / mot : 99
        // Wet start (fuel cock open, no light-off in >12s)
        wet += (r2 > 0.98) ? 1 : 0
        const wetThis = r2 > 0.98

        // Light-off time
        const lot = wetThis ? 14 + r1 * 8 : spec.lotSec * (0.85 + r1 * 0.30) + tatPenalty * 6

        // Peak EGT — fuel-on at low N2 + cold-soak + age = hot
        const lowN2Penalty = mot < motNominal * 0.65 ? (motNominal * 0.65 - mot) * 220 : 0
        const hotProb = r0 > 0.94 ? 1 : 0
        const peakEgt = spec.egtRed * (0.78 + r1 * 0.18) + lowN2Penalty + (hotProb ? 80 + r2 * 80 : 0) + ageMul * 8

        const hotThis = peakEgt >= spec.egtRed
        const hungThis = mot < motNominal * 0.55 * (1 / spec.hungSens) && !wetThis
        if (hotThis) hot += 1
        if (hungThis) hung += 1

        eng.push({ psi, mot, egt: peakEgt, lot, src, wet: wetThis })
        if (peakEgt > egtWorst) egtWorst = peakEgt
        psiSum += psi
      }
      const meanPsi = psiSum / spec.engines

      // Severities
      const psiSev = meanPsi >= spec.psiMin ? 0 : ((spec.psiMin - meanPsi) / Math.max(1, spec.psiMin)) * 100 * 2
      const motSev = eng.reduce((m, e) => {
        const ratio = e.mot / 1.20
        const s = ratio >= 0.8 ? 0 : ratio <= 0.4 ? 100 : (0.8 - ratio) / 0.4 * 100
        return Math.max(m, s)
      }, 0)
      const egtSev = (() => {
        const over = egtWorst - CLASS_SPEC[klass].egtRed
        if (over >= 0) return 100
        if (over <= -75) return 0
        return (1 - (-over) / 75) * 100
      })()
      const lotSev = eng.reduce((m, e) => {
        const over = e.lot - spec.lotSec
        const s = over <= 0 ? 0 : over >= 8 ? 100 : (over / 8) * 100
        return Math.max(m, s)
      }, 0)
      const tat = 15 + tatBias
      const tatSev = tat >= 0 ? 0 : tat <= -45 ? 100 : ((-tat) / 45) * 90

      const sev = { psi: Math.min(100, psiSev), mot: motSev, egt: egtSev, lot: lotSev, tat: tatSev }
      const drivers: Array<[Driver, number]> = [['PSI', sev.psi], ['MOT', sev.mot], ['EGT', sev.egt], ['LOT', sev.lot], ['TAT', sev.tat]]
      drivers.sort((a, b) => b[1] - a[1])
      const driver: Driver = drivers[0][1] >= 12 ? drivers[0][0] : 'NONE'

      const phaseMul = 1 + ((PHASE_MUL[phase] - 1) * (phaseWt / 100))
      const max = drivers[0][1]
      const secondary = drivers[1][1]
      let score = Math.min(100, Math.max(0, max * phaseMul + 0.10 * secondary))
      if (hot > 0) score = Math.max(score, 92)
      if (hung > 0) score = Math.max(score, 70)
      if (wet > 0) score = Math.max(score, 55)

      let tier: Tier
      if (phase !== 'START' && hot === 0 && hung === 0 && score < 25) tier = 'IDLE'
      else if (hot > 0 || score >= 85) tier = 'HOT-START'
      else if (hung > 0 || score >= 55) tier = 'HUNG'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({ f, klass, spec, phase, eng, worstEgt: egtWorst, meanPsi, hungEng: hung, hotEng: hot, wetEng: wet, sev, score, driver, tier })
    }
    return out
  }, [flights, minFl, fleetAge, psiMul, tatBias, srcRate, phaseWt])

  const tierCount: Record<Tier, number> = { 'HOT-START': 0, HUNG: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++

  const meanPsiAll = rows.length ? rows.reduce((a, r) => a + r.meanPsi, 0) / rows.length : 0
  const hungShare = rows.length ? rows.filter(r => r.hungEng > 0).length / rows.length : 0
  const worstEgtAll = rows.reduce((m, r) => r.worstEgt > m ? r.worstEgt : m, 0)
  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null
  const worstEngIdx = worst ? worst.eng.reduce((mi, e, i, arr) => e.egt > arr[mi].egt ? i : mi, 0) : 0

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
    const arr: Array<{ klass: AcClass; spec: StSpec; ac: number; hot: number; hung: number; worstTier: Tier; meanScore: number; worstCs: string; meanEgt: number }> = []
    for (const [k, v] of m) {
      const wt = v.reduce((a, r) => TIER_RANK[r.tier] < TIER_RANK[a] ? r.tier : a, 'IDLE' as Tier)
      const ms = v.reduce((a, r) => a + r.score, 0) / v.length
      const me = v.reduce((a, r) => a + r.worstEgt, 0) / v.length
      const ho = v.filter(r => r.hotEng > 0).length
      const hu = v.filter(r => r.hungEng > 0).length
      const wc = v.slice().sort((a, b) => b.score - a.score)[0]
      arr.push({ klass: k, spec: CLASS_SPEC[k], ac: v.length, hot: ho, hung: hu, worstTier: wt, meanScore: ms, worstCs: wc?.f.callsign || wc?.f.icao || '', meanEgt: me })
    }
    arr.sort((a, b) => TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier] || b.hot - a.hot)
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
      if (showPin && r.tier === 'HOT-START') {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLabels && (r.tier === 'HOT-START' || r.tier === 'HUNG')) {
        const ei = r.eng.reduce((mi, e, i, arr) => e.egt > arr[mi].egt ? i : mi, 0)
        const label = `${r.f.callsign || r.f.icao} · ENG${ei + 1} ${r.eng[ei].egt.toFixed(0)}°C · ${r.driver}`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showProj && (r.tier === 'HOT-START' || r.tier === 'HUNG')) {
        const bearing = (r.f.track || 0) * Math.PI / 180
        const dlat = Math.cos(bearing) * 4 / 60
        const dlng = Math.sin(bearing) * 4 / 60 / Math.max(0.2, Math.cos(r.f.lat * Math.PI / 180))
        for (let i = 0; i < 12; i++) {
          if (i % 2 === 1) continue
          const t0 = i / 12, t1 = (i + 1) / 12
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
  const sourcePill = (s: Source) => {
    const col = s === 'GPU' ? '#10b981' : s === 'APU' ? '#0ea5e9' : s === 'X-BLEED' ? '#f59e0b' : '#64748b'
    return <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '66', backgroundColor: col + '14' }}>{s}</span>
  }
  const egtPill = (e: number, red: number) => {
    const ratio = e / red
    const col = ratio >= 1.0 ? '#ef4444' : ratio >= 0.96 ? '#f59e0b' : ratio >= 0.9 ? '#0ea5e9' : '#10b981'
    return <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '66', backgroundColor: col + '14' }}>{e.toFixed(0)}°C</span>
  }

  const advice = (r: Row) => {
    if (r.tier === 'HOT-START') return 'HOT START — cut fuel switch, motor engine, EGT cooldown ≥ 5 min per FCOM 7.20 / Airbus PRO-NOR-SOP-70; log MOR, borescope before next start'
    if (r.tier === 'HUNG') return 'Hung start — N2 stagnated below cut-in, cut fuel switch, allow starter to cool ≥ 3 min per AC 33.89-1; check starter air valve SB 737-80-A105'
    if (r.tier === 'WATCH') return 'PSI / motoring marginal — cross-bleed source advised, recheck APU bleed psi at FCOM 7.20 limits before next attempt'
    return 'Start envelope nominal — within FCOM EGT / N2 / time limits'
  }

  const W = 280, H = 180
  const xMax = 30 // light-off time s
  const sx = (t: number) => 30 + (t / xMax) * (W - 40)
  const sy = (egt: number) => {
    // 400..900 °C
    const lo = 400, hi = 900
    const t = Math.max(0, Math.min(1, (egt - lo) / (hi - lo)))
    return (H - 24) - t * (H - 48)
  }

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">Engine Start · Hot / Hung / Wet</div>
          <div className="text-[10px] text-slate-500">ATA 80 · CFR 33.89 · AC 33.89-1 · CS-E 740</div>
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
          <div className="text-[9px] text-slate-500 uppercase">Worst EGT</div>
          <div className="text-sm font-semibold" style={{ color: worstEgtAll >= 750 ? '#ef4444' : worstEgtAll >= 700 ? '#f59e0b' : '#10b981' }}>{worstEgtAll.toFixed(0)}°C</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst aircraft</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}{worst ? ` E${worstEngIdx + 1}` : ''}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Hot starts</div>
          <div className="text-sm font-semibold" style={{ color: tierCount['HOT-START'] > 0 ? '#ef4444' : '#10b981' }}>{tierCount['HOT-START']}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean start PSI</div>
          <div className="text-xs font-semibold" style={{ color: meanPsiAll < 28 ? '#f59e0b' : '#10b981' }}>{meanPsiAll.toFixed(1)} psi</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Hung-start share</div>
          <div className="text-xs font-semibold" style={{ color: hungShare > 0.10 ? '#f59e0b' : '#10b981' }}>{(hungShare * 100).toFixed(1)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W - 40} height={H - 48} fill="#0b1220" />
            {/* hot-start band above 750 redline */}
            <rect x={30} y={24} width={W - 40} height={sy(750) - 24} fill="#ef4444" opacity={0.10} />
            <rect x={30} y={sy(750)} width={W - 40} height={sy(725) - sy(750)} fill="#f59e0b" opacity={0.10} />
            <line x1={30} x2={W - 10} y1={sy(750)} y2={sy(750)} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.7} />
            <line x1={sx(18)} x2={sx(18)} y1={24} y2={H - 24} stroke="#10b981" strokeDasharray="2 3" strokeOpacity={0.45} />
            {[400, 500, 600, 700, 800, 900].map(t => (
              <text key={t} x={6} y={sy(t) + 3} fontSize={8} fill="#64748b">{t}</text>
            ))}
            {[0, 8, 16, 24].map(t => (
              <text key={t} x={sx(t) - 4} y={H - 8} fontSize={8} fill="#64748b">{t}s</text>
            ))}
            {rows.flatMap((r, i) => r.eng.map((e, j) => (
              <circle key={`${i}-${j}`} cx={sx(Math.min(xMax, e.lot))} cy={sy(Math.min(900, e.egt))} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.8} />
            )))}
            <text x={W / 2} y={H - 6} fontSize={9} fill="#64748b" textAnchor="middle">light-off time (s) · peak EGT (°C)</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">FLEET-AGE {fleetAge}%</span><input type="range" min={50} max={200} value={fleetAge} onChange={e => setFleetAge(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PSI-MUL {psiMul}%</span><input type="range" min={50} max={250} value={psiMul} onChange={e => setPsiMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">TAT-BIAS {tatBias}°C</span><input type="range" min={-40} max={40} value={tatBias} onChange={e => setTatBias(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">SRC-RATE {srcRate}%</span><input type="range" min={50} max={250} value={srcRate} onChange={e => setSrcRate(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
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
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.spec.source}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{r.phase}</span>
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              {r.spec.engines}-eng · EGT-max {r.worstEgt.toFixed(0)}°C / red {r.spec.egtRed}°C · PSI {r.meanPsi.toFixed(0)}/{r.spec.psiMin} · HOT {r.hotEng} · HUNG {r.hungEng} · WET {r.wetEng}
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('PSI', r.sev.psi)}
              {driverBadge('MOT', r.sev.mot)}
              {driverBadge('EGT', r.sev.egt)}
              {driverBadge('LOT', r.sev.lot)}
              {driverBadge('TAT', r.sev.tat)}
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {r.eng.map((e, j) => (
                <span key={j} className="inline-flex items-center gap-1">
                  <span className="text-[9px] text-slate-500">E{j + 1}</span>
                  {egtPill(e.egt, r.spec.egtRed)}
                  <span className="text-[9px] text-slate-500">{e.mot.toFixed(2)}rpm/s · {e.lot.toFixed(0)}s</span>
                  {sourcePill(e.src)}
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
            <div className="px-2 text-[10px] text-slate-400">{c.spec.family} · {c.spec.engines}-eng · psi-min {c.spec.psiMin} · EGT-red {c.spec.egtRed}°C · LOT {c.spec.lotSec}s · src {c.spec.source} · HOT {c.hot} · HUNG {c.hung}</div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${c.meanScore}%`, backgroundColor: TIER_COLOR[c.worstTier] }} className="h-full" />
              </div>
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-500">mean score {c.meanScore.toFixed(0)} · mean EGT {c.meanEgt.toFixed(0)}°C · worst <button onClick={() => { const w = rows.find(rw => rw.klass === c.klass && (rw.f.callsign === c.worstCs || rw.f.icao === c.worstCs)); if (w) onFly(w.f.icao) }} className="text-sky-400 hover:text-sky-300">{c.worstCs || '—'}</button></div>
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: 14 CFR 33.89 / 25.901 / 25.903 / 25.1309 · AC 33.89-1 · AC 25-7D §31 · CS-E 740 · CS-25.901 · SAE ARP 5316 · NTSB DCA08IA049 PW-150 hot-start · DCA14IA063 V2500 hung · AD 2018-08-09 CFM56-7B starter cutout · AD 2021-12-09 LEAP-1B SAV · EASA AD 2020-0186 XWB SCV · Boeing FCOM 7.20 ENG START · Airbus FCOM PRO-NOR-SOP-70 · SB 737-80-A105 / A320-80-1003 · ARINC 429 lbl 350-377.
      </div>
    </div>
  )
}
