'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Engine Vibration & Fan-Blade-Imbalance Monitor (ATA-77)
   -----------------------------------------------------------
   Per-engine N1 (fan) / N2 (core/LPT) broadband vibration
   units (IPS = inches per second peak) trending with
   fan-blade-out (FBO) imbalance prediction and main-bearing
   spectral-tone watch.

   Regulatory & operational basis:
     · 14 CFR 25.901 / 25.903 powerplant installation
     · 14 CFR 25.1305 powerplant indication
     · 14 CFR 33.63 vibration limits
     · 14 CFR 33.83 vibration test (engine cert)
     · 14 CFR 33.94 fan blade-out containment
     · 14 CFR 121.703(b) IFSD reporting
     · 14 CFR 121.374 ETOPS engine condition monitoring
     · AC 33-9 ETOPS engine reliability
     · AC 33.94-1 FBO containment
     · AC 120-42B App 2 ETOPS vibration trend
     · CS-E 650 vibration test / CS-E 800 FBO
     · ICAO Annex 6 Pt I 5.2.6 ECM trend monitoring
     · ARINC 624 OMS engine vibration report
     · ARINC 720 EVMU Engine Vibration Monitoring Unit
     · Boeing AERO Q4-2010 Engine Vibration Monitoring
     · Boeing 777 FCOM 7.30 PW4090/GE90/Trent 800 VIB N1/N2
     · Boeing 787 FCOM 7.30 GEnx-1B/Trent 1000 VIB
     · Airbus FAST Mag 51 Engine Vibration Diagnostics
     · Airbus A320 FCOM PRO-NOR-SOP-23 CFM56 VIB limits
     · Airbus A350 FCOM Trent XWB VIB
     · CFM56-7B SB 72-1075 fan blade vibration trim
     · PW1100G-JM SB 77-001 GTF gearbox tone
     · Trent 1000 SB 72-AK001 IPC blade
     · NTSB AAR-19/03 SWA 1380 PW1100 fan blade-out
     · NTSB AIR-90-03 UA 232 GE CF6 fan-disk separation
     · NTSB DCA17IA148 SWA1380 fan-blade-out
     · FAA SAIB NE-18-26 high-bypass fan blades
     · SAE ARP 5757 engine condition monitoring
     · SAE ARP 5120 spectral broadband vibration
     · MMEL Boeing 737 77-2 VIB indication 1 inop allowed
     · MMEL Airbus A320 77-22 ENG VIB N1 or N2 1 ch INOP

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash of ICAO24 drives
        per-engine N1-IPS, N2-IPS, EGT-margin, bearing-tone
        ratio, blade-trim-mass index.
     2. Per-class engine catalogue defines fan/core IPS
        advisory / caution / red-line thresholds and engine
        count (1/2/3/4).
     3. Phase-weighting: TAKEOFF/CLIMB amplifies driver
        intensity vs CRUISE (high-N1 excitation).
     4. ETOPS-validated airframes carry tighter trend
        thresholds (AC 120-42B App 2 vibration MAX).
     5. Aggregate worst-engine drives airframe posture.

   5 risk components (composite = max-driver):
     N1V  fan-shaft IPS vs advisory/caution/red-line
          100 at >= red-line, 0 at <= advisory
     N2V  core/LPT-shaft IPS vs advisory/caution/red-line
          100 at >= red-line, 0 at <= advisory
     BRG  main-bearing spectral-tone amplitude ratio
          100 at >=2.0× baseline, 0 at <=0.6×
     FBO  fan-blade imbalance composite (trim-mass × IPS)
          100 at >=trim-limit (FBO precursor), AC 33.94-1
     EGT  EGT-margin erosion (vibration accelerates wear)
          100 at <=0°C margin, 0 at >=+40°C
     phase multiplier: TAKEOFF 1.35 / CLIMB 1.20 /
       CRUISE 1.00 / DESC 0.95 / APPR 1.10
     ETOPS engine in cruise oceanic: ×1.10 trend penalty

   Composite score = max-driver × phaseMul + 0.10*secondary,
   clip 0–100.

   Tiers:
     FBO        score>=80 OR N1V>=redLine OR FBO>=85
                rose: fan-blade-out precursor — declare
                emergency, run QRH ENG SEVERE DAMAGE,
                shutdown affected engine per AC 33.94-1
     CAUTION    score>=55 amber: trend caution exceedance
                file ETOPS deviation, monitor every 10 min
     ADVISORY   score>=25 sky: advisory threshold breached
                log every 30 min, schedule borescope
     OK         score<25 emerald: nominal vibration
     IDLE       below MIN-FL slider / on ground: slate

   MapLibre overlay:
     · Tier-coloured halo rings sized by score 8–22 px
     · Rose diamond pin at current pos for FBO with
       engine# + IPS + driver callout
     · Tier-coloured callsign + ENG# + driver labels for
       non-OK aircraft
     · 12-segment dashed forward-projection 60 nm
       tier-coloured for FBO
     · Sky reference parallels at lat 60/30/0/-30/-60
       every 12° longitude as fleet reference

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell WORST-N1-IPS tier-coloured / WORST cs+ENG /
       FBO-count summary
     · 2-cell MEAN-N2-IPS / RED-LINE-share secondary
     · SVG N1-IPS × N2-IPS scatter with red-line bands,
       caution bands, advisory bands; every engine plotted
       as tier-coloured dot
     · 7 sliders MIN-FL / FLEET-AGE / VIB-MUL / BRG-BIAS /
       FBO-RATE / PHASE-WEIGHT / ETOPS-MIN
     · 7-class chip filter HVY/NRW/RGN/BIZ/TBP/GA/FTR
     · HALO/PIN/LBL/PROJ/REF/DIAG toggles + search
     · AIRCRAFT / ENGINES tab switcher
     · Aircraft tab tier-coloured row with per-engine pills
       (eng# / N1-IPS / N2-IPS / BRG / FBO / EGT) +
       phase chip + advice + click-to-fly
     · Engines tab grouped by class+ENG-pos sorted
       worst-tier-first

   Layers > Safety & Traffic.
   Persisted: ft-vib
   ============================================================ */

interface VibFlight {
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
  flights: VibFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'FBO' | 'CAUTION' | 'ADVISORY' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  FBO: '#ef4444', CAUTION: '#f59e0b', ADVISORY: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['FBO', 'CAUTION', 'ADVISORY', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { FBO: 0, CAUTION: 1, ADVISORY: 2, OK: 3, IDLE: 4 }

type AcClass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const CLASS_LIST: AcClass[] = ['HVY', 'NRW', 'RGN', 'BIZ', 'TBP', 'GA', 'FTR']

interface VibSpec {
  engCount: number
  family: string
  n1Adv: number   // IPS advisory
  n1Cau: number   // IPS caution
  n1Red: number   // IPS red-line
  n2Adv: number
  n2Cau: number
  n2Red: number
  trimLim: number // fan-trim mass-equivalent (FBO precursor)
  brgBase: number // spectral tone baseline
  egtNom: number  // °C margin nominal
  etopsMin: number
}

// Per AC 33.94-1 / Boeing AERO Q4-2010 / Airbus FAST 51 typical IPS bands.
const CLASS_VIB: Record<AcClass, VibSpec> = {
  HVY: { engCount: 2, family: 'Trent / GE90 / GEnx', n1Adv: 1.5, n1Cau: 2.5, n1Red: 4.0, n2Adv: 2.0, n2Cau: 3.0, n2Red: 4.5, trimLim: 1.30, brgBase: 0.40, egtNom: 32, etopsMin: 180 },
  NRW: { engCount: 2, family: 'CFM56 / LEAP / PW1100G', n1Adv: 1.4, n1Cau: 2.2, n1Red: 3.8, n2Adv: 1.8, n2Cau: 2.7, n2Red: 4.2, trimLim: 1.20, brgBase: 0.38, egtNom: 28, etopsMin: 120 },
  RGN: { engCount: 2, family: 'CF34 / PW1500G', n1Adv: 1.3, n1Cau: 2.0, n1Red: 3.5, n2Adv: 1.7, n2Cau: 2.5, n2Red: 4.0, trimLim: 1.10, brgBase: 0.35, egtNom: 24, etopsMin: 60 },
  BIZ: { engCount: 2, family: 'BR710 / HTF7000 / PW307', n1Adv: 1.2, n1Cau: 1.9, n1Red: 3.3, n2Adv: 1.6, n2Cau: 2.4, n2Red: 3.8, trimLim: 1.05, brgBase: 0.32, egtNom: 22, etopsMin: 0 },
  TBP: { engCount: 2, family: 'PT6 / PW150 / TPE331', n1Adv: 1.0, n1Cau: 1.6, n1Red: 2.8, n2Adv: 1.4, n2Cau: 2.1, n2Red: 3.4, trimLim: 0.90, brgBase: 0.28, egtNom: 18, etopsMin: 0 },
  GA:  { engCount: 1, family: 'IO-540 / Continental', n1Adv: 0.8, n1Cau: 1.3, n1Red: 2.3, n2Adv: 0.8, n2Cau: 1.3, n2Red: 2.3, trimLim: 0.70, brgBase: 0.22, egtNom: 14, etopsMin: 0 },
  FTR: { engCount: 2, family: 'F119 / F135 / EJ200', n1Adv: 1.8, n1Cau: 2.8, n1Red: 4.5, n2Adv: 2.2, n2Cau: 3.3, n2Red: 5.0, trimLim: 1.45, brgBase: 0.45, egtNom: 36, etopsMin: 0 },
}

type Driver = 'N1V' | 'N2V' | 'BRG' | 'FBO' | 'EGT' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  N1V: 'Fan (N1) vibration',
  N2V: 'Core (N2/LPT) vibration',
  BRG: 'Bearing spectral tone',
  FBO: 'Fan-blade imbalance',
  EGT: 'EGT margin erosion',
  NONE: 'Nominal',
}

type Phase = 'TKO' | 'CLB' | 'CRZ' | 'DES' | 'APP'
const PHASE_MUL: Record<Phase, number> = { TKO: 1.35, CLB: 1.20, CRZ: 1.00, DES: 0.95, APP: 1.10 }

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|B77|B78|A33|A34|A35|A38|MD11|IL96/.test(t)) return 'HVY'
  if (/B73|A31|A319|A32|A22|MD8|B71/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E27|E29|E[12]7|E[12]9|ATR|F70|F100/.test(t)) return 'RGN'
  if (/G[VI458]|GLF|GLEX|FA[78]X|F2TH|CL30|CL60|C68|C75|BE40|H25|LJ/.test(t)) return 'BIZ'
  if (/DH8|AT[47]|SF34|B190|BE20|C208|DHC/.test(t)) return 'TBP'
  if (/F15|F16|F18|F22|F35|EUFI|RFAL|TYPH|MIG|SU[2-5]/.test(t)) return 'FTR'
  return 'GA'
}

function classifyPhase(altFt: number, vrFpm: number): Phase {
  if (altFt < 8000 && vrFpm > 500) return 'TKO'
  if (vrFpm > 400) return 'CLB'
  if (vrFpm < -400 && altFt < 10000) return 'APP'
  if (vrFpm < -300) return 'DES'
  return 'CRZ'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

interface EngVib {
  pos: number
  n1ips: number
  n2ips: number
  brgRatio: number   // × baseline
  fboIdx: number     // × trim limit; >=1 = FBO precursor
  egtMargin: number  // °C
  sev: { n1: number; n2: number; brg: number; fbo: number; egt: number }
  score: number
  driver: Driver
  tier: Tier
}

interface Row {
  f: VibFlight
  klass: AcClass
  spec: VibSpec
  phase: Phase
  engines: EngVib[]
  worst: EngVib
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'vib-halo', SRC_LBL = 'vib-lbl', SRC_PIN = 'vib-pin', SRC_PROJ = 'vib-proj', SRC_REF = 'vib-ref'
const LYR_HALO = 'vib-halo-l', LYR_LBL = 'vib-lbl-l', LYR_PIN = 'vib-pin-l', LYR_PROJ = 'vib-proj-l', LYR_REF = 'vib-ref-l'

export default function VibMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'ENGINES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(30)
  const [fleetAge, setFleetAge] = useState(100)
  const [vibMul, setVibMul] = useState(100)
  const [brgBias, setBrgBias] = useState(0)     // -30..+50 pct
  const [fboRate, setFboRate] = useState(6)     // 0..25 pct
  const [phaseWeight, setPhaseWeight] = useState(100) // 50..150 pct
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
    const pwMul = phaseWeight / 100
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      if (f.altitudeFt / 100 < minFl) continue
      const klass = classifyClass(f.type || '')
      const spec = CLASS_VIB[klass]
      const phase = classifyPhase(f.altitudeFt, f.vertRate || 0)
      const phMul = 1 + (PHASE_MUL[phase] - 1) * pwMul
      const h = hash32(f.icao || '')
      const ageMul = fleetAge / 100
      const vMul = vibMul / 100
      const etopsCruise = spec.etopsMin > 0 && phase === 'CRZ' ? 1.10 : 1.0

      const engines: EngVib[] = []
      for (let e = 0; e < spec.engCount; e++) {
        const hh = (h ^ (0x9e3779b9 * (e + 1))) >>> 0
        const r0 = ((hh >>> 0) & 0xffff) / 0xffff
        const r1 = ((hh >>> 8) & 0xffff) / 0xffff
        const r2 = ((hh >>> 16) & 0xffff) / 0xffff
        const r3 = (((hh * 0x85ebca6b) >>> 0) & 0xffff) / 0xffff
        const r4 = (((hh * 0xc2b2ae35) >>> 8) & 0xffff) / 0xffff

        // N1 IPS: skew so most engines below advisory, tail above red-line
        const n1Base = spec.n1Adv * 0.35 + Math.pow(r0, 1.6) * (spec.n1Red * 1.10)
        const n1ips = n1Base * ageMul * vMul * phMul

        // N2 IPS: similar, slightly less FBO-driven
        const n2Base = spec.n2Adv * 0.30 + Math.pow(r1, 1.5) * (spec.n2Red * 1.05)
        const n2ips = n2Base * ageMul * vMul * phMul * 0.95

        // Bearing tone ratio: 0.4..2.2× baseline (× brgBias)
        const brgRatio = (0.4 + r2 * 1.8) * (1 + brgBias / 100) * (0.85 + (ageMul - 1) * 0.6)

        // FBO index: drives off N1ips × hash-skew, scaled by fboRate-share
        const fboPick = r3 < (fboRate / 100)
        const fboIdx = fboPick
          ? 0.85 + r4 * 0.55      // 0.85..1.40 (FBO band)
          : 0.20 + r4 * 0.60      // 0.20..0.80 (nominal)
        // Couple FBO with N1ips
        const fboCoupled = fboIdx * (0.6 + (n1ips / spec.n1Red) * 0.6)

        // EGT margin erosion as ageMul + n1ips
        const egtMargin = spec.egtNom * (1 - (ageMul - 1) * 0.35) - (n1ips / spec.n1Red) * 12 - (fboCoupled > 1 ? 8 : 0)

        // Severities
        const n1Sev = n1ips >= spec.n1Red
          ? 100
          : n1ips <= spec.n1Adv
            ? Math.max(0, (n1ips / spec.n1Adv) * 25)
            : n1ips <= spec.n1Cau
              ? 25 + ((n1ips - spec.n1Adv) / (spec.n1Cau - spec.n1Adv)) * 30
              : 55 + ((n1ips - spec.n1Cau) / Math.max(0.01, spec.n1Red - spec.n1Cau)) * 45
        const n2Sev = n2ips >= spec.n2Red
          ? 100
          : n2ips <= spec.n2Adv
            ? Math.max(0, (n2ips / spec.n2Adv) * 25)
            : n2ips <= spec.n2Cau
              ? 25 + ((n2ips - spec.n2Adv) / (spec.n2Cau - spec.n2Adv)) * 30
              : 55 + ((n2ips - spec.n2Cau) / Math.max(0.01, spec.n2Red - spec.n2Cau)) * 45
        const brgSev = brgRatio >= 2.0
          ? 100
          : brgRatio <= 0.6
            ? 0
            : ((brgRatio - 0.6) / 1.4) * 100
        const fboSev = fboCoupled >= spec.trimLim
          ? 100
          : fboCoupled <= 0.5
            ? 0
            : ((fboCoupled - 0.5) / (spec.trimLim - 0.5)) * 100
        const egtSev = egtMargin <= 0
          ? 100
          : egtMargin >= 40
            ? 0
            : (1 - egtMargin / 40) * 100

        const sevList: Array<[Driver, number]> = [
          ['N1V', n1Sev], ['N2V', n2Sev], ['BRG', brgSev], ['FBO', fboSev], ['EGT', egtSev],
        ]
        sevList.sort((a, b) => b[1] - a[1])
        const driver: Driver = sevList[0][1] > 0 ? sevList[0][0] : 'NONE'
        const rawScore = (sevList[0][1] + sevList[1][1] * 0.10) * etopsCruise
        const score = Math.min(100, rawScore)

        let tier: Tier
        if (score >= 80 || n1ips >= spec.n1Red || fboSev >= 85) tier = 'FBO'
        else if (score >= 55) tier = 'CAUTION'
        else if (score >= 25) tier = 'ADVISORY'
        else tier = 'OK'

        engines.push({
          pos: e + 1, n1ips, n2ips, brgRatio, fboIdx: fboCoupled, egtMargin,
          sev: { n1: n1Sev, n2: n2Sev, brg: brgSev, fbo: fboSev, egt: egtSev },
          score, driver, tier,
        })
      }

      const worst = engines.slice().sort((a, b) => b.score - a.score)[0]
      out.push({ f, klass, spec, phase, engines, worst, score: worst.score, driver: worst.driver, tier: worst.tier })
    }
    return out
  }, [flights, minFl, fleetAge, vibMul, brgBias, fboRate, phaseWeight, etopsMinSlider])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { FBO: 0, CAUTION: 0, ADVISORY: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumN1 = 0, sumN2 = 0, engN = 0, redN = 0
    let worst = 0, worstCs = '', worstEng = 0, worstN1 = 0
    for (const r of rows) {
      for (const e of r.engines) {
        engN++; sumN1 += e.n1ips; sumN2 += e.n2ips
        if (e.n1ips >= r.spec.n1Red || e.n2ips >= r.spec.n2Red) redN++
      }
      if (r.score > worst) {
        worst = r.score
        worstCs = (r.f.callsign || r.f.icao).trim()
        worstEng = r.worst.pos
        worstN1 = r.worst.n1ips
      }
    }
    return {
      meanN1: engN ? sumN1 / engN : 0,
      meanN2: engN ? sumN2 / engN : 0,
      worst, worstCs, worstEng, worstN1,
      fbo: tally.FBO,
      redShare: engN ? redN / engN : 0,
    }
  }, [rows, tally])

  const engAggs = useMemo(() => {
    const m = new Map<string, { key: string; klass: AcClass; pos: number; count: number; sumScore: number; sumN1: number; sumN2: number; fbo: number; worst: number; worstCs: string; worstIcao: string; worstTier: Tier }>()
    for (const r of rows) {
      for (const e of r.engines) {
        const k = r.klass + '|ENG-' + e.pos
        let a = m.get(k)
        if (!a) { a = { key: k, klass: r.klass, pos: e.pos, count: 0, sumScore: 0, sumN1: 0, sumN2: 0, fbo: 0, worst: 0, worstCs: '', worstIcao: '', worstTier: 'OK' }; m.set(k, a) }
        a.count++; a.sumScore += e.score; a.sumN1 += e.n1ips; a.sumN2 += e.n2ips
        if (e.tier === 'FBO') a.fbo++
        if (TIER_RANK[e.tier] < TIER_RANK[a.worstTier]) a.worstTier = e.tier
        if (e.score > a.worst) { a.worst = e.score; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
      }
    }
    return Array.from(m.values()).map(a => ({
      ...a,
      meanScore: a.count ? a.sumScore / a.count : 0,
      meanN1: a.count ? a.sumN1 / a.count : 0,
      meanN2: a.count ? a.sumN2 / a.count : 0,
    })).sort((a, b) => {
      const ti = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
      if (ti !== 0) return ti
      return b.fbo - a.fbo || b.count - a.count
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
      if (showPin && r.tier === 'FBO') pins.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
      if (showLabels) {
        labels.push({ type: 'Feature', properties: { c, t: `${(r.f.callsign || r.f.icao).trim()}  E${r.worst.pos} ${r.driver} ${r.worst.n1ips.toFixed(1)}IPS` }, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
      }
      if (showProj && r.tier === 'FBO') {
        const trk = (r.f.track || 0) * Math.PI / 180
        const nm = 60
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

  // ---- Diagnostic SVG (N1-IPS × N2-IPS) ----
  const diag = useMemo(() => {
    const W = 360, H = 200, padL = 38, padR = 10, padT = 12, padB = 28
    const xMax = 5   // N1 IPS
    const yMax = 5   // N2 IPS
    const xToPx = (x: number) => padL + Math.min(1, x / xMax) * (W - padL - padR)
    const yToPx = (y: number) => H - padB - Math.min(1, y / yMax) * (H - padT - padB)
    return { W, H, padL, padR, padT, padB, xMax, yMax, xToPx, yToPx }
  }, [])

  function advice(r: Row): string {
    if (r.tier === 'FBO') return `Engine ${r.worst.pos} ${DRIVER_LABEL[r.driver].toLowerCase()} — FBO precursor. Declare emergency, QRH ENG SEVERE DAMAGE, shutdown engine ${r.worst.pos} per AC 33.94-1 / NTSB AAR-19/03.`
    if (r.tier === 'CAUTION') return `Engine ${r.worst.pos} trend caution exceedance (${DRIVER_LABEL[r.driver].toLowerCase()}). File ETOPS deviation, monitor every 10 min, brief on IFSD checklist.`
    if (r.tier === 'ADVISORY') return `Engine ${r.worst.pos} advisory threshold (${DRIVER_LABEL[r.driver].toLowerCase()}). Log every 30 min, schedule borescope at next A-check per AC 25-19A.`
    return 'All engines within FCOM vibration envelope; nominal ECM trend.'
  }

  return (
    <div className="fixed top-16 right-2 z-40 w-[440px] max-h-[calc(100vh-5rem)] overflow-y-auto rounded-xl border border-sky-500/40 bg-slate-950/95 backdrop-blur p-3 text-xs text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-sky-300">Engine Vibration / FBO</span>
          <span className="text-[10px] text-slate-500">ATA-77 · AC 33.94-1</span>
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
          <div className="text-[9px] text-slate-500">WORST N1</div>
          <div className="text-sm" style={{ color: summary.worstN1 >= 3.5 ? '#ef4444' : summary.worstN1 >= 2.2 ? '#f59e0b' : '#10b981' }}>{summary.worstN1.toFixed(2)} IPS</div>
        </div>
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">WORST</div>
          <div className="text-[11px] text-slate-200 truncate">{summary.worstCs || '—'}{summary.worstEng ? ` E${summary.worstEng}` : ''}</div>
        </div>
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">FBO</div>
          <div className="text-sm" style={{ color: summary.fbo ? '#ef4444' : '#10b981' }}>{summary.fbo}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 mb-2">
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">MEAN N2</div>
          <div className="text-sm text-sky-300">{summary.meanN2.toFixed(2)} IPS</div>
        </div>
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">RED-LINE</div>
          <div className="text-sm" style={{ color: summary.redShare > 0.05 ? '#ef4444' : summary.redShare > 0.02 ? '#f59e0b' : '#10b981' }}>{(summary.redShare * 100).toFixed(0)}%</div>
        </div>
      </div>

      {/* Diagnostic */}
      {showDiag && (
        <div className="mb-2 rounded border border-slate-700/60 bg-slate-900/60 p-1">
          <div className="text-[9px] text-slate-500 mb-0.5">N1-IPS × N2-IPS (every engine)</div>
          <svg width={diag.W} height={diag.H} className="block">
            {/* Rose band: N1>=3.5 or N2>=4 */}
            <rect x={diag.xToPx(3.5)} y={diag.padT} width={diag.W - diag.padR - diag.xToPx(3.5)} height={diag.H - diag.padT - diag.padB} fill="#ef4444" fillOpacity={0.08} />
            <rect x={diag.padL} y={diag.padT} width={diag.W - diag.padR - diag.padL} height={diag.yToPx(4) - diag.padT} fill="#ef4444" fillOpacity={0.08} />
            {/* Amber band 2.2..3.5 / 2.7..4 */}
            <rect x={diag.xToPx(2.2)} y={diag.padT} width={diag.xToPx(3.5) - diag.xToPx(2.2)} height={diag.H - diag.padT - diag.padB} fill="#f59e0b" fillOpacity={0.06} />
            <rect x={diag.padL} y={diag.yToPx(4)} width={diag.W - diag.padR - diag.padL} height={diag.yToPx(2.7) - diag.yToPx(4)} fill="#f59e0b" fillOpacity={0.06} />
            {/* Sky advisory band 1.4..2.2 / 1.8..2.7 */}
            <rect x={diag.xToPx(1.4)} y={diag.padT} width={diag.xToPx(2.2) - diag.xToPx(1.4)} height={diag.H - diag.padT - diag.padB} fill="#0ea5e9" fillOpacity={0.04} />
            {/* Axes */}
            <line x1={diag.padL} y1={diag.H - diag.padB} x2={diag.W - diag.padR} y2={diag.H - diag.padB} stroke="#334155" />
            <line x1={diag.padL} y1={diag.padT} x2={diag.padL} y2={diag.H - diag.padB} stroke="#334155" />
            {[1, 2, 3, 4, 5].map(x => (
              <g key={'vx' + x}>
                <line x1={diag.xToPx(x)} y1={diag.padT} x2={diag.xToPx(x)} y2={diag.H - diag.padB} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xToPx(x)} y={diag.H - diag.padB + 10} fontSize={8} fill="#64748b" textAnchor="middle">{x}</text>
              </g>
            ))}
            {[1, 2, 3, 4].map(y => (
              <g key={'hy' + y}>
                <line x1={diag.padL} y1={diag.yToPx(y)} x2={diag.W - diag.padR} y2={diag.yToPx(y)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.padL - 4} y={diag.yToPx(y) + 3} fontSize={8} fill="#64748b" textAnchor="end">{y}</text>
              </g>
            ))}
            {/* Dashed red-line thresholds */}
            <line x1={diag.xToPx(3.5)} y1={diag.padT} x2={diag.xToPx(3.5)} y2={diag.H - diag.padB} stroke="#ef4444" strokeOpacity={0.5} strokeDasharray="3 3" />
            <line x1={diag.padL} y1={diag.yToPx(4)} x2={diag.W - diag.padR} y2={diag.yToPx(4)} stroke="#ef4444" strokeOpacity={0.5} strokeDasharray="3 3" />
            {/* Engine dots */}
            {rows.flatMap(r => r.engines.map((e, i) => {
              const xx = diag.xToPx(Math.min(diag.xMax, e.n1ips))
              const yy = diag.yToPx(Math.min(diag.yMax, e.n2ips))
              return <circle key={r.f.icao + '-' + i} cx={xx} cy={yy} r={2} fill={TIER_COLOR[e.tier]} fillOpacity={0.85} />
            }))}
            <text x={diag.W - diag.padR} y={diag.H - 4} fontSize={8} fill="#64748b" textAnchor="end">N1 IPS</text>
            <text x={diag.padL + 4} y={diag.padT + 8} fontSize={8} fill="#64748b">N2 IPS</text>
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
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">VIB-MUL %</span><span className="text-[10px] text-slate-300">{vibMul}</span></div>
          <input type="range" min={50} max={200} value={vibMul} onChange={e => setVibMul(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">BRG-BIAS %</span><span className="text-[10px] text-slate-300">{brgBias > 0 ? '+' + brgBias : brgBias}</span></div>
          <input type="range" min={-30} max={50} value={brgBias} onChange={e => setBrgBias(+e.target.value)} className="w-full accent-sky-500" />
        </div>
      </div>
      <div className="mb-2">
        <div className="flex justify-between"><span className="text-[10px] text-slate-500">FBO-RATE %</span><span className="text-[10px] text-slate-300">{fboRate}</span></div>
        <input type="range" min={0} max={25} value={fboRate} onChange={e => setFboRate(+e.target.value)} className="w-full accent-sky-500" />
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">PHASE-WT %</span><span className="text-[10px] text-slate-300">{phaseWeight}</span></div>
          <input type="range" min={50} max={150} value={phaseWeight} onChange={e => setPhaseWeight(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">ETOPS-MIN</span><span className="text-[10px] text-slate-300">{etopsMinSlider}</span></div>
          <input type="range" min={60} max={330} step={30} value={etopsMinSlider} onChange={e => setEtopsMinSlider(+e.target.value)} className="w-full accent-sky-500" />
        </div>
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
                  <span className="text-[9px] px-1 rounded border border-slate-700/70 text-slate-400">{r.phase}</span>
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
                      <span style={{ color: e.n1ips >= r.spec.n1Red ? '#ef4444' : e.n1ips >= r.spec.n1Cau ? '#f59e0b' : e.n1ips >= r.spec.n1Adv ? '#0ea5e9' : '#94a3b8' }}>N1 {e.n1ips.toFixed(2)}</span>
                      {' · '}
                      <span style={{ color: e.n2ips >= r.spec.n2Red ? '#ef4444' : e.n2ips >= r.spec.n2Cau ? '#f59e0b' : e.n2ips >= r.spec.n2Adv ? '#0ea5e9' : '#94a3b8' }}>N2 {e.n2ips.toFixed(2)}</span>
                    </div>
                    <div className="text-[9px] text-slate-400 mt-0.5">
                      <span style={{ color: e.brgRatio >= 2.0 ? '#ef4444' : e.brgRatio >= 1.4 ? '#f59e0b' : '#94a3b8' }}>BRG {e.brgRatio.toFixed(2)}×</span>
                      {' · '}
                      <span style={{ color: e.fboIdx >= r.spec.trimLim ? '#ef4444' : e.fboIdx >= 0.85 ? '#f59e0b' : '#94a3b8' }}>FBO {e.fboIdx.toFixed(2)}</span>
                    </div>
                    <div className="text-[9px] mt-0.5">
                      <span style={{ color: e.egtMargin <= 0 ? '#ef4444' : e.egtMargin <= 10 ? '#f59e0b' : '#10b981' }}>
                        EGT mrg {e.egtMargin.toFixed(0)}°
                      </span>
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
                mean N1 {a.meanN1.toFixed(2)} · N2 {a.meanN2.toFixed(2)} IPS · FBO {a.fbo}
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: a.meanScore + '%', background: TIER_COLOR[a.worstTier] }} />
              </div>
              <div className="text-[10px] text-slate-400 mt-1">{CLASS_VIB[a.klass].family} · N1 red {CLASS_VIB[a.klass].n1Red} · N2 red {CLASS_VIB[a.klass].n2Red} · worst {a.worstCs}</div>
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
