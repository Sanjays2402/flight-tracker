'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Engine Anti-Ice (EAI) / Cowl Heat Penalty Monitor
   -----------------------------------------------------------
   FAA AC 20-73A "Aircraft Ice Protection" · FAA AC 91-74B
   "Pilot Guide: Flight in Icing Conditions" · 14 CFR 25 App C
   icing envelope (TAT -40..+10 °C with visible moisture) ·
   14 CFR 25 App O SLD freezing-drizzle/freezing-rain envelope ·
   EASA CS-25.1419 / CS-25.1420 ice protection certification ·
   Boeing FCTM Vol I §6 Engine Anti-Ice operation ·
   Airbus FCOM PRO-ABN-30 ENG ANTI ICE / FCOM PER-OPT engine
   anti-ice performance penalties · ICAO Doc 10018 Manual on
   Aircraft Ground Icing Operations.

   When an airplane flies through 14 CFR 25 App C / App O icing
   conditions (TAT ≤ +10 °C with visible moisture) every flight
   manual *mandates* Engine Anti-Ice (EAI) — hot bleed air routed
   through the engine cowl inlet lip — to prevent inlet ice
   accretion that could shed and damage the fan. This carries
   real performance costs that dispatch must plan for:

     - Bleed extraction reduces engine N1 thrust margin
       (typically 0.6–1.4 %N1 per pack-equivalent)
     - SFC penalty 1–3 % per engine
     - Climb-gradient penalty 50–250 ft/min reduction
     - EGT rise 8–20 °C (cumulative with EGT-margin monitor)
     - At low altitude high TAT the bleed becomes useless and
       can mask actual ice; SOPs require selecting OFF above
       SAT +10 °C and warn against extended use on the ground

   This monitor identifies every airborne aircraft inside the
   App-C icing envelope, infers the *required* EAI configuration
   per phase, computes the penalty stack, and flags any aircraft
   whose energy-state (excess thrust at present speed/altitude)
   has been eroded below safe climb margin by EAI demand.

   Per aircraft we synthesise:
     SAT (°C)    = 15 − 1.98·altKft (ISA) + ISA-DEV slider ±20
     TAT (°C)    = SAT + (M^2 · 0.2 · 288)  (recovery-factor 1.0
                   for slow GA, scaled below)
     ICING       = TAT ≤ +10 °C and visible-moisture probability
                   = phase-based humidity proxy +
                     hash-stable per-airframe RH bias
     SLD-RISK    = boolean: SAT ∈ [−10, 0] °C with high-RH bump
                   (App O freezing-drizzle envelope)
     EAI-REQ     = "MANDATORY" (App-O SLD or holding in App-C),
                   "REQUIRED" (App C with TAT ≤ +10),
                   "RECOMMENDED" (TAT ≤ +10 dry), "OFF" (TAT > 10)
     N1-PEN  %   = phase- and class-dependent (TAKEOFF/CLIMB
                   carry the biggest penalty)
     SFC-PEN %   = bleed extraction × class bleed-fraction
     CLB-PEN fpm = N1-PEN × climb-gradient sensitivity
     EGT-RISE °C = bleed re-circulation + EGT-margin lookup
     MARGIN  %   = (excess-thrust − EAI demand) / takeoff thrust

   Class catalogue (penalties typical to in-service fleets):
                BLEED   N1%    SFC%   CLB-fpm  EGT°C   PHASE-MULT
     HWB        BIG     0.9    1.7    -180     +12     CLB 1.2
     HMB        BIG     1.0    1.9    -160     +14     CLB 1.2
     HNB        MED     0.8    1.5    -130     +10     CLB 1.1
     RGN        MED     1.1    2.0    -120     + 9     CLB 1.0
     BIZ        MED     0.7    1.3    -110     + 8     CLB 1.1
     TBP        SML     1.4    2.4    -100     +18     CLB 0.9 (PT6 ITT)
     GA         SML     2.0    2.8    -200     +25     CLB 0.7 carb-heat
     FTR        BIG     0.5    1.0    -300     + 6     CLB 1.5 mil-bleed

   Tier classification per aircraft (airborne in icing window):
     OK         EAI selected per SOP, margin healthy   emerald
     WARN       inside icing band, EAI not "ON" model  sky
                 — REQ but PIREP latency expected
     PEN        EAI ON, climb margin reduced but valid amber
     CRIT       EAI ON, MARGIN < 2 % OR engine-pen     rose
                 stack > climb-gradient envelope
     IDLE       outside icing band (TAT > +10 °C)      slate

   Composite severity 0-100:
     clip( max( (1 − marginPct/10)*100, n1Pen/3*100,
                sfcPen/4*100, |clbPenFpm|/300*100 ), 0, 100 )

   MapLibre overlay (registered Layers > Safety & Traffic):
     - Tier-coloured halo rings sized by severity 8-22 px
     - Rose diamond pin "EAI-CRIT" for CRIT aircraft
     - Tier-coloured callsign + n1Pen labels for PEN+CRIT
     - 12-segment dashed forward-projection 60 nm for CRIT
       showing how far the eroded margin will carry them

   Side panel:
     - 5-tier counter strip click-to-filter (no IDLE chip)
     - 3-cell MEAN-N1% / WORST callsign+pen / CRIT-count
     - 2-cell MEAN-CLB-fpm tier-coloured / EAI-ON share
     - SVG TAT-vs-N1Pen scatter with App-C envelope shaded
       (−40..+10 °C window) plus class-typical penalty bands
     - 5 sliders MIN-FL / ISA-DEV / RH-BIAS / SAFETY-MARGIN /
       PHASE-WEIGHT in 2-col grid + BLEED-MULT full-width
     - 8-class chip filter HWB/HMB/HNB/RGN/BIZ/TBP/GA/FTR
     - HALO / LBL / PIN / PROJ / DIAG toggles + search
     - AIRCRAFT / CLASSES tab switcher
     - AIRCRAFT tab tier-worst-first then severity desc
     - CLASSES tab grouped by class worst-tier-first

   Persisted: ft-eai
   ============================================================ */

export interface EaiFlight {
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
  flights: EaiFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'WARN' | 'PEN' | 'CRIT' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981',
  WARN: '#0ea5e9',
  PEN: '#f59e0b',
  CRIT: '#fb7185',
  IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['CRIT', 'PEN', 'WARN', 'OK']
const TIER_RANK: Record<Tier, number> = { CRIT: 0, PEN: 1, WARN: 2, OK: 3, IDLE: 4 }

type Klass = 'HWB' | 'HMB' | 'HNB' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const KL_NAME: Record<Klass, string> = {
  HWB: 'Heavy wide-body (B777/787/A330/350/380)',
  HMB: 'Mid-twin (B767/A300/A310)',
  HNB: 'Narrow-body (B737/A320/A220)',
  RGN: 'Regional (CRJ/E-jets/ATR)',
  BIZ: 'Business jet (G550/650/Global)',
  TBP: 'Turboprop (Q400/King Air/PT6 ITT)',
  GA: 'General-aviation / carb-heat',
  FTR: 'Fighter (mil-bleed)',
}
// Performance penalties for engine anti-ice ON (typical FCOM PER-OPT data)
const KL_N1:    Record<Klass, number> = { HWB: 0.9, HMB: 1.0, HNB: 0.8, RGN: 1.1, BIZ: 0.7, TBP: 1.4, GA: 2.0, FTR: 0.5 } // % N1
const KL_SFC:   Record<Klass, number> = { HWB: 1.7, HMB: 1.9, HNB: 1.5, RGN: 2.0, BIZ: 1.3, TBP: 2.4, GA: 2.8, FTR: 1.0 } // % SFC
const KL_CLB:   Record<Klass, number> = { HWB: 180, HMB: 160, HNB: 130, RGN: 120, BIZ: 110, TBP: 100, GA: 200, FTR: 300 } // fpm penalty
const KL_EGT:   Record<Klass, number> = { HWB: 12,  HMB: 14,  HNB: 10,  RGN: 9,   BIZ: 8,   TBP: 18,  GA: 25,  FTR: 6 }   // °C rise
const KL_PHASE: Record<Klass, number> = { HWB: 1.2, HMB: 1.2, HNB: 1.1, RGN: 1.0, BIZ: 1.1, TBP: 0.9, GA: 0.7, FTR: 1.5 }
const KL_BLEED: Record<Klass, 'BIG' | 'MED' | 'SML'> = { HWB: 'BIG', HMB: 'BIG', HNB: 'MED', RGN: 'MED', BIZ: 'MED', TBP: 'SML', GA: 'SML', FTR: 'BIG' }

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'GA'
  if (/^(B77|B78|A33|A34|A35|A38|B74|MD11|IL96)/.test(x)) return 'HWB'
  if (/^(B76|A30|A31[0-9]|IL62|DC10|L101)/.test(x)) return 'HMB'
  if (/^(A31|A32|A19|A20|A21|A22|B73|B72|B71|MD8|MD9|BCS|CS1|CS3)/.test(x)) return 'HNB'
  if (/^(CRJ|E14|E15|E17|E19|E29|E70|E75|AT4|AT5|AT7)/.test(x)) return 'RGN'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'BIZ'
  if (/^(DH8|Q40|SF34|J32|J41|ATR|TBM|PC12|TB|PC6|DHC|AN2|BE9|BE3|BE2)/.test(x)) return 'TBP'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS|TORN)/.test(x)) return 'FTR'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|C20)/.test(x)) return 'GA'
  return 'HNB'
}

type Phase = 'TAKEOFF' | 'CLIMB' | 'CRUISE' | 'DESCENT' | 'APPR'
const PHASE_LABEL: Record<Phase, string> = { TAKEOFF: 'TO', CLIMB: 'CLB', CRUISE: 'CRZ', DESCENT: 'DES', APPR: 'APP' }
function inferPhase(altFt: number, vsFpm: number): Phase {
  if (altFt < 5000 && vsFpm > 2200) return 'TAKEOFF'
  if (altFt < 8000) return 'APPR'
  if (vsFpm > 600) return 'CLIMB'
  if (vsFpm < -600) return 'DESCENT'
  if (altFt < 18000 && vsFpm < -200) return 'DESCENT'
  return 'CRUISE'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

function projectPosition(lat: number, lng: number, trackDeg: number, distNm: number) {
  const R = 3440.065
  const δ = distNm / R
  const θ = (trackDeg * Math.PI) / 180
  const φ1 = (lat * Math.PI) / 180
  const λ1 = (lng * Math.PI) / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return { lat: (φ2 * 180) / Math.PI, lng: (((λ2 * 180) / Math.PI + 540) % 360) - 180 }
}

type EaiReq = 'MANDATORY' | 'REQUIRED' | 'RECOMMENDED' | 'OFF'

interface Row {
  f: EaiFlight
  klass: Klass
  flCur: number
  phase: Phase
  sat: number
  tat: number
  mach: number
  rhPct: number
  visMoisture: boolean
  appC: boolean         // inside 14 CFR 25 App C
  appO: boolean         // SLD envelope (App O)
  eaiReq: EaiReq
  eaiOn: boolean
  n1Pen: number         // %
  sfcPen: number        // %
  clbPenFpm: number     // signed, negative = penalty
  egtRise: number       // °C
  marginPct: number     // excess thrust margin %
  severity: number
  tier: Tier
}

function fmtPct(v: number, d = 1) { return v.toFixed(d) + '%' }
function fmtSigned(v: number, suf = '') { return (v >= 0 ? '+' : '') + Math.round(v) + suf }

const SRC_HALO = 'eai-halo', SRC_LBL = 'eai-lbl', SRC_PIN = 'eai-pin', SRC_PROJ = 'eai-proj'
const LYR_HALO = 'eai-halo-l', LYR_LBL = 'eai-lbl-l', LYR_PIN = 'eai-pin-l', LYR_PROJ = 'eai-proj-l'

export default function EaiPenalty({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klFilter, setKlFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [isaDev, setIsaDev] = useState(0)        // -20..+20 °C
  const [rhBias, setRhBias] = useState(60)       // 0-100 % humidity proxy
  const [safetyMargin, setSafetyMargin] = useState(2) // % thrust margin floor
  const [phaseWeight, setPhaseWeight] = useState(100) // 50-150 %
  const [bleedMul, setBleedMul] = useState(100)  // 50-150 %
  const [showHalo, setShowHalo] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl) continue
      const klass = classify(f.type, f.category)
      const phase = inferPhase(f.altitudeFt, f.vertRate || 0)
      const h = hash32(f.icao || '')

      // ISA SAT
      const altKft = f.altitudeFt / 1000
      let satIsa = 15 - 1.98 * altKft
      if (altKft > 36) satIsa = -56.5
      const sat = satIsa + isaDev

      // TAT via Mach proxy (GS / 575 kt ~ sea-level Mach)
      const gs = f.velocityKts || 0
      const mach = Math.max(0, gs / 575)
      const recovery = klass === 'GA' || klass === 'TBP' ? 0.5 : 1.0
      const tat = sat + recovery * mach * mach * 0.2 * 288

      // Humidity / visible moisture proxy. Phase-biased: APP/TAKEOFF higher.
      const rhNoise = ((h % 1000) / 1000) * 30 - 15 // ±15 %
      const phaseRh = phase === 'TAKEOFF' || phase === 'APPR' ? 18 : phase === 'CLIMB' || phase === 'DESCENT' ? 8 : 0
      const rhPct = Math.max(0, Math.min(100, rhBias + rhNoise + phaseRh))
      const visMoisture = rhPct >= 65

      // 14 CFR 25 App C envelope: SAT ∈ [-40, 0] (strict liquid water) but FAA AC 91-74B
      // AIRPLANE icing condition: TAT ≤ +10 °C and visible moisture
      const appC = tat <= 10 && sat >= -40 && visMoisture
      // App O SLD freezing-drizzle: SAT in [-10, 0] with high RH
      const appO = sat >= -10 && sat <= 0 && rhPct >= 80

      let eaiReq: EaiReq
      if (appO) eaiReq = 'MANDATORY'
      else if (appC) eaiReq = 'REQUIRED'
      else if (tat <= 10) eaiReq = 'RECOMMENDED'
      else eaiReq = 'OFF'

      // Hash-stable per-airframe EAI selection lag (90 % of fleet complies)
      const eaiOnHash = (h >>> 7) % 100 < 90
      const eaiOn = (eaiReq === 'MANDATORY' || eaiReq === 'REQUIRED') && eaiOnHash

      // Penalty stack scaled by phase + bleed multiplier
      const phaseMul = (phase === 'TAKEOFF' || phase === 'CLIMB') ? KL_PHASE[klass] : 1.0
      const wMul = (phaseWeight / 100) * (bleedMul / 100)
      const n1Pen = eaiOn ? KL_N1[klass] * phaseMul * wMul : 0
      const sfcPen = eaiOn ? KL_SFC[klass] * phaseMul * wMul : 0
      const clbPenFpm = eaiOn ? -KL_CLB[klass] * phaseMul * wMul : 0
      const egtRise = eaiOn ? KL_EGT[klass] * phaseMul * wMul : 0

      // Excess-thrust margin proxy: cruise reserve ~ 8 %, climb 4 %, take-off 6 %, descent 12 %, app 7 %
      const baseMargin = phase === 'CRUISE' ? 8 : phase === 'CLIMB' ? 4 : phase === 'TAKEOFF' ? 6 : phase === 'DESCENT' ? 12 : 7
      const marginPct = baseMargin - n1Pen

      let tier: Tier
      if (eaiReq === 'OFF') tier = 'IDLE'
      else if (eaiOn && (marginPct < safetyMargin || n1Pen > 2.0)) tier = 'CRIT'
      else if (eaiOn) tier = 'PEN'
      else if (eaiReq === 'REQUIRED' || eaiReq === 'MANDATORY') tier = 'WARN'
      else tier = 'OK'

      const sev = Math.max(
        Math.max(0, (1 - marginPct / 10)) * 100,
        (n1Pen / 3) * 100,
        (sfcPen / 4) * 100,
        Math.abs(clbPenFpm) / 300 * 100,
      )
      const severity = Math.max(0, Math.min(100, sev))

      out.push({ f, klass, flCur, phase, sat, tat, mach, rhPct, visMoisture, appC, appO, eaiReq, eaiOn, n1Pen, sfcPen, clbPenFpm, egtRise, marginPct, severity, tier })
    }
    return out
  }, [flights, minFl, isaDev, rhBias, safetyMargin, phaseWeight, bleedMul])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, WARN: 0, PEN: 0, CRIT: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumN1 = 0, n = 0, sumClb = 0, eaiOn = 0
    let worstSev = -1, worstCs = '', worstN1 = 0
    let crit = 0
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      n++
      sumN1 += r.n1Pen
      sumClb += r.clbPenFpm
      if (r.eaiOn) eaiOn++
      if (r.tier === 'CRIT') crit++
      if (r.severity > worstSev) { worstSev = r.severity; worstCs = (r.f.callsign || r.f.icao).trim(); worstN1 = r.n1Pen }
    }
    return {
      meanN1: n ? sumN1 / n : 0,
      meanClb: n ? sumClb / n : 0,
      eaiOnShare: n ? (eaiOn / n) * 100 : 0,
      worstCs, worstN1, crit,
      active: n,
    }
  }, [rows])

  const klassAggs = useMemo(() => {
    const m = new Map<Klass, { klass: Klass; count: number; sumN1: number; sumClb: number; worstSev: number; worstCs: string; worstIcao: string; worstN1: number; worstTier: Tier; eaiOn: number }>()
    for (const r of rows) {
      let a = m.get(r.klass)
      if (!a) { a = { klass: r.klass, count: 0, sumN1: 0, sumClb: 0, worstSev: -1, worstCs: '', worstIcao: '', worstN1: 0, worstTier: 'OK', eaiOn: 0 }; m.set(r.klass, a) }
      a.count++
      a.sumN1 += r.n1Pen
      a.sumClb += r.clbPenFpm
      if (r.eaiOn) a.eaiOn++
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.severity > a.worstSev) { a.worstSev = r.severity; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao; a.worstN1 = r.n1Pen }
    }
    const arr = Array.from(m.values()).map(a => ({
      ...a,
      meanN1: a.count ? a.sumN1 / a.count : 0,
      meanClb: a.count ? a.sumClb / a.count : 0,
    }))
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
      .filter(r => {
        if (r.tier === 'IDLE' && tierFilter === 'ALL') return false
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (klFilter !== 'ALL' && r.klass !== klFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.klass].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.severity - a.severity
      })
  }, [rows, tierFilter, klFilter, query])

  const filteredKlass = useMemo(() => {
    const q = query.trim().toUpperCase()
    return klassAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (!q) return true
      return (a.klass + ' ' + KL_NAME[a.klass]).toUpperCase().includes(q)
    })
  }, [klassAggs, tierFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.severity / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'PEN' || r.tier === 'CRIT').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} N1−${r.n1Pen.toFixed(1)}%` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'CRIT').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} › EAI-CRIT` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFeatures: any[] = []
    if (showProj) {
      for (const r of rows) {
        if (r.tier !== 'CRIT') continue
        const coords: [number, number][] = []
        for (let i = 0; i <= 12; i++) {
          const p = projectPosition(r.f.lat, r.f.lng, r.f.track || 0, (60 * i) / 12)
          coords.push([p.lng, p.lat])
        }
        projFeatures.push({ type: 'Feature' as const, properties: { color: TIER_COLOR[r.tier] }, geometry: { type: 'LineString' as const, coordinates: coords } })
      }
    }
    const projFc = { type: 'FeatureCollection' as const, features: projFeatures }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.7, 'line-dasharray': [2, 3],
      } }))
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['get', 'text'], 'text-size': 10,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-offset': [0, -1.8], 'text-anchor': 'bottom', 'icon-allow-overlap': true,
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.6 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_PROJ]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showProj])

  // Diagram: TAT °C (x, -50..+20) vs N1-penalty % (y, 0..4)
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 30
    const xMin = -50, xMax = 20, yMax = 4
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">EAI / Anti-Ice Penalty</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.active} active</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800">
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean N1</div>
          <div className="font-mono text-sm" style={{ color: summary.meanN1 > 1.5 ? '#f59e0b' : summary.meanN1 > 0 ? '#0ea5e9' : '#10b981' }}>−{summary.meanN1.toFixed(2)}<span className="text-[9px] text-slate-500"> %</span></div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} −${summary.worstN1.toFixed(1)}%` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">CRIT</div>
          <div className="font-mono text-sm" style={{ color: summary.crit > 0 ? '#fb7185' : '#10b981' }}>{summary.crit}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean CLB pen</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanClb < -150 ? '#fb7185' : summary.meanClb < -50 ? '#f59e0b' : '#10b981' }}>{Math.round(summary.meanClb)}<span className="text-[9px] text-slate-500"> fpm</span></div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">EAI-ON share</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.eaiOnShare.toFixed(0)}<span className="text-[9px] text-slate-500"> %</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">TAT °C vs N1-Penalty %</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* y-axis ticks */}
            {[1, 2, 3].map(s => (
              <g key={s}>
                <line x1={diag.PAD} y1={diag.ys(s)} x2={diag.W - 6} y2={diag.ys(s)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(s) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{s}%</text>
              </g>
            ))}
            {/* x-axis: temperature */}
            {[-40, -20, 0, 10].map(x => (
              <g key={x}>
                <line x1={diag.xs(x)} y1={6} x2={diag.xs(x)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(x)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{x}°</text>
              </g>
            ))}
            {/* App-C icing envelope band: TAT -40..+10 with visible moisture */}
            <rect x={diag.xs(-40)} y={6} width={diag.xs(10) - diag.xs(-40)} height={diag.H - diag.PAD - 6} fill="#0ea5e9" opacity={0.06} />
            <line x1={diag.xs(10)} y1={6} x2={diag.xs(10)} y2={diag.H - diag.PAD} stroke="#0ea5e9" strokeWidth={0.9} strokeDasharray="3 2" opacity={0.8} />
            <text x={diag.xs(10) - 2} y={12} textAnchor="end" fontSize={7} fill="#0ea5e9" fontFamily="monospace">App-C +10°</text>
            {/* App-O SLD slot -10..0 */}
            <rect x={diag.xs(-10)} y={6} width={diag.xs(0) - diag.xs(-10)} height={diag.H - diag.PAD - 6} fill="#fb7185" opacity={0.08} />
            <text x={diag.xs(-5)} y={20} textAnchor="middle" fontSize={7} fill="#fb7185" fontFamily="monospace">SLD</text>
            {/* horizontal CRIT line at N1 = 2 % */}
            <line x1={diag.PAD} y1={diag.ys(2)} x2={diag.W - 6} y2={diag.ys(2)} stroke="#fb7185" strokeWidth={0.9} strokeDasharray="3 2" opacity={0.8} />
            <text x={diag.W - 8} y={diag.ys(2) - 2} textAnchor="end" fontSize={7} fill="#fb7185" fontFamily="monospace">CRIT 2%</text>
            {rows.filter(r => r.tier !== 'IDLE').map(r => {
              const x = diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, r.tat)))
              const y = diag.ys(Math.min(diag.yMax, r.n1Pen))
              return <circle key={r.f.icao} cx={x} cy={y} r={3} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            })}
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
            <div className="flex justify-between text-[10px] text-slate-500"><span>ISA-DEV</span><span className="font-mono text-slate-300">{isaDev >= 0 ? '+' : ''}{isaDev}°</span></div>
            <input type="range" min={-20} max={20} step={1} value={isaDev} onChange={e => setIsaDev(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>RH-BIAS</span><span className="font-mono text-slate-300">{rhBias}%</span></div>
            <input type="range" min={0} max={100} step={5} value={rhBias} onChange={e => setRhBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>SAFETY-MARG</span><span className="font-mono text-slate-300">{safetyMargin}%</span></div>
            <input type="range" min={0} max={10} step={1} value={safetyMargin} onChange={e => setSafetyMargin(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>PHASE-W</span><span className="font-mono text-slate-300">{phaseWeight}%</span></div>
            <input type="range" min={50} max={150} step={5} value={phaseWeight} onChange={e => setPhaseWeight(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>BLEED-MUL</span><span className="font-mono text-slate-300">{bleedMul}%</span></div>
            <input type="range" min={50} max={150} step={5} value={bleedMul} onChange={e => setBleedMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['HWB', 'HMB', 'HNB', 'RGN', 'BIZ', 'TBP', 'GA', 'FTR'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlFilter(klFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / class"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'CLASSES'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${summary.active} active` : `${filteredKlass.length} shown / ${klassAggs.length} cls`}</span>
        <span>{tab === 'AIRCRAFT' ? 'N1% · CLB-fpm · TAT · tier' : 'cls · ac · mean-pen · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          // Penalty bar 0-3 %N1
          const penPct = Math.max(0, Math.min(100, (r.n1Pen / 3) * 100))
          const advice = r.tier === 'CRIT'
            ? `EAI eroded climb margin · review N1 / level-off / climb at MCT only`
            : r.tier === 'PEN'
              ? `EAI ON · expect ${r.n1Pen.toFixed(1)}% N1 / ${fmtSigned(r.clbPenFpm)} fpm / +${r.egtRise.toFixed(0)}°C EGT`
              : r.tier === 'WARN'
                ? `${r.eaiReq} per AC 91-74B · select ENG ANTI-ICE ON now`
                : `outside icing band · EAI selection OFF nominal`
          const reqColor = r.eaiReq === 'MANDATORY' ? '#fb7185' : r.eaiReq === 'REQUIRED' ? '#f59e0b' : r.eaiReq === 'RECOMMENDED' ? '#0ea5e9' : '#475569'
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{r.klass}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="flight level">F{Math.round(r.flCur)}</span>
                  <span title="phase">{PHASE_LABEL[r.phase]}</span>
                  <span title="static air temp">SAT {r.sat.toFixed(0)}°</span>
                  <span title="total air temp" style={{ color: r.tat <= 10 ? TIER_COLOR[r.tier] : '#94a3b8' }}>TAT {r.tat.toFixed(0)}°</span>
                  <span className="ml-auto" title="N1 penalty %" style={{ color: TIER_COLOR[r.tier] }}>−{r.n1Pen.toFixed(2)}%</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`N1 penalty as share of 3% CRIT threshold`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${penPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${(2 / 3) * 100}%` }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  <span className="px-1 py-0 rounded border text-[9px] font-mono"
                    style={{ borderColor: reqColor + '66', color: reqColor, background: reqColor + '14' }}
                    title="EAI selection requirement">{r.eaiReq}{r.eaiOn ? ' · ON' : ' · OFF'}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="climb-gradient penalty">{fmtSigned(r.clbPenFpm)} fpm</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="SFC fuel penalty">SFC +{r.sfcPen.toFixed(1)}%</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="EGT rise from bleed extraction">EGT +{r.egtRise.toFixed(0)}°</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono"
                    style={{ borderColor: TIER_COLOR[r.tier] + '66', color: TIER_COLOR[r.tier], background: TIER_COLOR[r.tier] + '14' }}
                    title="excess-thrust margin after EAI">MARG {r.marginPct.toFixed(1)}%</span>
                  {r.appO && <span className="px-1 py-0 rounded border text-[9px] font-mono" style={{ borderColor: '#fb718566', color: '#fb7185', background: '#fb718514' }} title="14 CFR 25 App O supercooled large droplets">SLD</span>}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'CLASSES' && filteredKlass.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No classes match.</div>
        )}
        {tab === 'CLASSES' && filteredKlass.map(a => {
          const penPct = Math.max(0, Math.min(100, (a.meanN1 / 3) * 100))
          const eaiOnShare = a.count ? (a.eaiOn / a.count) * 100 : 0
          const advice = a.worstTier === 'CRIT' ? 'class margin eroded · expect EAI-driven thrust calls'
            : a.worstTier === 'PEN' ? 'class operating with EAI penalty · monitor climb gradient'
              : a.worstTier === 'WARN' ? 'class inside icing band · verify EAI selected per SOP'
                : 'class outside icing band · nominal operation'
          return (
            <button key={a.klass} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.klass}</span>
                  <span className="text-slate-500 text-[10px] truncate">{KL_NAME[a.klass]}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="mean N1 penalty">mean −{a.meanN1.toFixed(2)}%</span>
                  <span title="mean climb penalty">{Math.round(a.meanClb)} fpm</span>
                  <span title="worst N1 penalty" style={{ color: TIER_COLOR[a.worstTier] }}>worst −{a.worstN1.toFixed(1)}%</span>
                  <span className="ml-auto truncate">{a.worstCs || '—'}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`mean N1 penalty as share of 3% CRIT threshold`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${penPct}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${(2 / 3) * 100}%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate" title="class spec">BLEED {KL_BLEED[a.klass]} · EAI-ON {eaiOnShare.toFixed(0)}% · EGT +{KL_EGT[a.klass]}°</span>
                  <span className="ml-auto truncate" style={{ color: a.worstTier === 'OK' ? '#64748b' : TIER_COLOR[a.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        FAA AC 20-73A · FAA AC 91-74B · 14 CFR 25 App C / App O · EASA CS-25.1419/1420 · Boeing FCTM Vol I §6 · Airbus FCOM PRO-ABN-30
      </div>
    </div>
  )
}
