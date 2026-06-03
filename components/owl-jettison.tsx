'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Overweight Landing / Fuel Jettison Decision Monitor (OWL)
   -----------------------------------------------------------
   Boeing FCOM QRH NNC "Overweight Landing" · Airbus FCOM
   PRO-ABN-MISC / QRH Overweight Landing · FAA AC 25-7C
   §32 OVERWEIGHT LANDING · EASA CS-25.473 Landing Weight ·
   ICAO Annex 6 Pt I 4.3.6.6 / Doc 9376 Fuel Jettison /
   14 CFR 25.1001 Fuel Jettisoning System / FAA AC 121-25A.

   When an in-flight emergency forces an immediate return,
   the airframe is usually well above its certified Maximum
   Landing Weight (MLW = MZFW + reserves). Three real-world
   options exist per dispatch:
     (a) FUEL JETTISON   wide-body & some narrow-body have
         certified dump nozzles (~600-2200 kg/min depending
         on type). Burn off the delta in minutes not hours.
     (b) BURN-HOLD       hold at a low-burn altitude until
         enough fuel is consumed to fall below MLW.
     (c) OVERWEIGHT LDG  per QRH if delay > emergency
         tolerance (engine fire, smoke, medical) — requires
         post-landing structural inspection per AMM 05-51-XX
         (Boeing) / Airbus AMM 05-51-12 within 24h.

   Per airframe we synthesise:
     - Current Gross Weight (GW) = ZFW + remaining fuel,
       where ZFW = MZFW * load-factor (FNV-1a hash 0.78-0.98)
       and remaining fuel = MFW * (1 - burn-frac) with
       burn-frac = clip(hrs / class-endurance, 0, 1)
     - hrs = inferred hours airborne from phase/altitude
       (TAKEOFF 0.04 / CLIMB 0.4 / CRUISE 0.8 + class cap /
       DESCENT 0.7 + cap*0.8) modulated by FUEL-BIAS slider
       50-200 % (simulates dispatch overfuel / under-fuel)
     - Delta-Over-MLW kg = max(0, GW - MLW)
     - Burn rate to MLW kg/min (class total-fuel-flow @ hold)
     - Jettison rate kg/min (class certified dump rate;
       zero for non-equipped airframes)
     - tMinBurn = deltaOver / burnRate (minutes to MLW)
     - tMinJett = jettCapable ? deltaOver / jettRate : Inf
     - tMin = min(tMinBurn, tMinJett)

   Tier classification per aircraft (airborne only):
     OK         GW <= MLW                       emerald nominal
     MARGIN     GW within MARGIN-KG slider      sky one-hour burn-off
     BURN       overweight, no jettison kit     amber hold to burn
     JETT       overweight, jettison capable    rose dump recommended
     OVWT-LDG   overweight + tMin > URGENCY     rose-bright emergency
                 slider (medical/fire/smoke)
     IDLE       on ground / below MIN-FL        slate excluded

   Class catalogue (Boeing TCDS / Airbus AOM / EMB TCDS /
   FAA TCDS A-XX). Units = kg (1 lb = 0.4536 kg):
                MTOW    MLW    MZFW   MFW    BURN  JETT  CAP
     HWB     395000  286000  246000 173000  6600  2200  Y  (B777/787/A330/350/380 typical)
     HMB     310000  235000  192000 110000  4400  1600  Y  (B767/A300/A310 mid-twin)
     HNB     79000   66000   62500   24700  2400     0  N  (B737/A320/A220 no dump)
     RGN     45000   41000   38000    9500  1300     0  N  (CRJ/E-jets/ATR no dump)
     BIZ     45000   38000   30000   18500  1400   800  Y  (G550/650/Global some equipped)
     TBP     27000   25000   22500    5000   600     0  N  (Q400/King Air no dump)
     GA      2500    2400    2200     400    50     0  N  (PA28/SR22/C172)
     FTR     22000   17000   14000    7000  3200  1800  Y  (F-15/Tornado wing pylons)

   Severity score 0-100 (per aircraft) =
     clip(deltaOver / (MTOW - MLW) * 80 + tMin/URGENCY * 20, 0, 100)
   with dominant driver labelling DELTA vs TIME.

   MapLibre overlay (registered Layers > Safety & Traffic):
     - Tier-coloured halo rings sized by severity 8-22 px
     - Rose diamond pin "OVWT" for OVWT-LDG aircraft
     - Tier-coloured callsign + Δkg labels for BURN/JETT/OVWT
     - 12-segment dashed forward-projection 100 nm for OVWT

   Side panel:
     - 5-tier counter strip click-to-filter (no IDLE chip)
     - 3-cell MEAN-Δkg / WORST callsign+Δt / OVWT-LDG-count
     - 2-cell MEAN-tMin / JETT-CAPABLE share secondary
     - SVG Δkg-vs-tMin scatter with emerald/sky/amber/rose
       threshold bands shaded + dashed lines at 0/MARGIN/
       URGENCY + every aircraft plotted as tier-coloured dot
     - 5 sliders MIN-FL / FUEL-BIAS / LOAD-FACTOR / MARGIN-KG
       / URGENCY-MIN in 2-col grid + JETT-RATE full-width
     - 7-class chip filter
     - HALO / LBL / PIN / PROJ / DIAG toggles + search
     - AIRCRAFT / CLASSES tab switcher
     - AIRCRAFT tab tier-worst-first then deltaOver desc
     - CLASSES tab grouped by class worst-tier-first

   Persisted: ft-owl
   ============================================================ */

export interface OwlFlight {
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
  flights: OwlFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'MARGIN' | 'BURN' | 'JETT' | 'OVWT' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981',
  MARGIN: '#0ea5e9',
  BURN: '#f59e0b',
  JETT: '#fb7185',
  OVWT: '#ef4444',
  IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['OVWT', 'JETT', 'BURN', 'MARGIN', 'OK']
const TIER_RANK: Record<Tier, number> = { OVWT: 0, JETT: 1, BURN: 2, MARGIN: 3, OK: 4, IDLE: 5 }

type Klass = 'HWB' | 'HMB' | 'HNB' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const KL_NAME: Record<Klass, string> = {
  HWB: 'Heavy wide-body (B777/787/A330/350/380)',
  HMB: 'Mid-twin (B767/A300/A310)',
  HNB: 'Narrow-body (B737/A320/A220)',
  RGN: 'Regional (CRJ/E-jets/ATR)',
  BIZ: 'Business jet (G550/650/Global)',
  TBP: 'Turboprop (Q400/King Air)',
  GA: 'General-aviation prop',
  FTR: 'Fighter (wing pylons)',
}
const KL_MTOW: Record<Klass, number>  = { HWB: 395000, HMB: 175000, HNB: 79000, RGN: 45000, BIZ: 45000, TBP: 27000, GA: 2500, FTR: 22000 }
const KL_MLW:  Record<Klass, number>  = { HWB: 286000, HMB: 145000, HNB: 66000, RGN: 41000, BIZ: 38000, TBP: 25000, GA: 2400, FTR: 17000 }
const KL_MZFW: Record<Klass, number>  = { HWB: 246000, HMB: 128000, HNB: 62500, RGN: 38000, BIZ: 30000, TBP: 22500, GA: 2200, FTR: 14000 }
const KL_MFW:  Record<Klass, number>  = { HWB: 173000, HMB:  60000, HNB: 24700, RGN:  9500, BIZ: 18500, TBP:  5000, GA:  400, FTR:  7000 }
const KL_BURN: Record<Klass, number>  = { HWB: 6600,   HMB: 4000,   HNB: 2400,  RGN: 1300,  BIZ: 1400,  TBP: 600,   GA:  50,  FTR: 3200 }   // kg/min cruise
const KL_HOLD: Record<Klass, number>  = { HWB: 4800,   HMB: 2900,   HNB: 1750,  RGN: 950,   BIZ: 1000,  TBP: 440,   GA:  38,  FTR: 2400 }   // kg/min holding
const KL_JETT: Record<Klass, number>  = { HWB: 2200,   HMB: 1600,   HNB:    0,  RGN:    0,  BIZ:  800,  TBP:   0,   GA:   0,  FTR: 1800 }   // kg/min jettison nozzle
const KL_END:  Record<Klass, number>  = { HWB: 14,     HMB: 8,      HNB: 6,     RGN: 3,     BIZ: 8,     TBP: 2.5,   GA:  4,   FTR: 2 }      // hours

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

function inferHrs(klass: Klass, phase: Phase, h: number): number {
  const cap = KL_END[klass]
  const noise = ((h >>> 13) % 1000) / 1000
  if (phase === 'TAKEOFF') return 0.04 + noise * 0.05
  if (phase === 'CLIMB') return 0.2 + noise * 0.5
  if (phase === 'CRUISE') return 0.6 + noise * cap
  if (phase === 'DESCENT') return 0.5 + noise * cap * 0.8
  return 0.1 + noise * 0.3
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

interface Row {
  f: OwlFlight
  klass: Klass
  flCur: number
  phase: Phase
  hrs: number
  mtow: number; mlw: number; mzfw: number; mfw: number
  burnKg: number; holdKg: number; jettKg: number
  jettCapable: boolean
  zfw: number
  fuelRem: number
  gw: number
  deltaOver: number       // kg above MLW (>=0)
  tMinBurn: number        // minutes to MLW via holding burn
  tMinJett: number        // minutes via jettison (Inf if N)
  tMin: number            // min(burn,jett)
  severity: number
  tier: Tier
  domDriver: 'DELTA' | 'TIME' | 'OK'
}

function fmtKg(kg: number) {
  if (!isFinite(kg)) return '∞'
  if (kg >= 1000) return (kg / 1000).toFixed(1) + 't'
  return Math.round(kg) + 'kg'
}
function fmtMin(m: number) {
  if (!isFinite(m)) return '∞'
  if (m < 0.5) return '<1m'
  if (m < 60) return m.toFixed(0) + 'm'
  const h = Math.floor(m / 60), mm = Math.round(m - h * 60)
  return `${h}h${mm.toString().padStart(2, '0')}`
}

const SRC_HALO = 'owl-halo', SRC_LBL = 'owl-lbl', SRC_PIN = 'owl-pin', SRC_PROJ = 'owl-proj'
const LYR_HALO = 'owl-halo-l', LYR_LBL = 'owl-lbl-l', LYR_PIN = 'owl-pin-l', LYR_PROJ = 'owl-proj-l'

export default function OwlJettison({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klFilter, setKlFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(20)
  const [fuelBias, setFuelBias] = useState(100)    // 50-200 %
  const [loadFactor, setLoadFactor] = useState(88) // 60-100 %
  const [marginKg, setMarginKg] = useState(2000)   // 0-10000 kg "near-MLW" band
  const [urgencyMin, setUrgencyMin] = useState(20) // 5-90 min "must-land" threshold
  const [jettRateMul, setJettRateMul] = useState(100) // 50-150 %
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

      const mtow = KL_MTOW[klass], mlw = KL_MLW[klass], mzfw = KL_MZFW[klass], mfw = KL_MFW[klass]
      const burnKg = KL_HOLD[klass]                 // holding burn rate
      const jettKg = KL_JETT[klass] * (jettRateMul / 100)
      const jettCapable = KL_JETT[klass] > 0

      // hash-stable load factor within (loadFactor +/- 8 %)
      const lfNoise = (((h % 1000) / 1000) - 0.5) * 16   // -8..+8 %
      const lfPct = Math.max(60, Math.min(100, loadFactor + lfNoise))
      const zfw = mzfw * (lfPct / 100)

      // hours airborne and remaining fuel
      const hrs = inferHrs(klass, phase, h)
      const burnFrac = Math.max(0, Math.min(1, hrs / KL_END[klass]))
      // dispatch over/under-fuel: start with mfw*FUEL-BIAS, capped at MFW*1.0 effective
      const startFuel = Math.min(mfw, mfw * (fuelBias / 100))
      const fuelRem = Math.max(0, startFuel * (1 - burnFrac))
      const gw = zfw + fuelRem
      const deltaOver = Math.max(0, gw - mlw)
      const tMinBurn = deltaOver > 0 && burnKg > 0 ? deltaOver / burnKg : 0
      const tMinJett = deltaOver > 0 && jettCapable && jettKg > 0 ? deltaOver / jettKg : Infinity
      const tMin = Math.min(tMinBurn || 0, tMinJett)

      const sev1 = Math.min(80, (deltaOver / Math.max(1, mtow - mlw)) * 80)
      const sev2 = isFinite(tMin) ? Math.min(20, (tMin / Math.max(1, urgencyMin)) * 20) : 20
      const severity = Math.max(0, Math.min(100, sev1 + sev2))
      const domDriver: Row['domDriver'] = deltaOver === 0 ? 'OK' : (sev1 >= sev2 ? 'DELTA' : 'TIME')

      let tier: Tier
      if (deltaOver === 0) tier = 'OK'
      else if (deltaOver <= marginKg) tier = 'MARGIN'
      else if (isFinite(tMin) && tMin > urgencyMin) tier = 'OVWT'
      else if (jettCapable) tier = 'JETT'
      else tier = 'BURN'

      out.push({ f, klass, flCur, phase, hrs, mtow, mlw, mzfw, mfw, burnKg, holdKg: burnKg, jettKg, jettCapable, zfw, fuelRem, gw, deltaOver, tMinBurn, tMinJett, tMin, severity, tier, domDriver })
    }
    return out
  }, [flights, minFl, fuelBias, loadFactor, marginKg, urgencyMin, jettRateMul])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, MARGIN: 0, BURN: 0, JETT: 0, OVWT: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumDelta = 0, sumT = 0, finiteT = 0, worstD = 0, worstCs = '', worstT = 0
    let ovwt = 0, jettCap = 0
    for (const r of rows) {
      sumDelta += r.deltaOver
      if (isFinite(r.tMin)) { sumT += r.tMin; finiteT++ }
      if (r.tier === 'OVWT') ovwt++
      if (r.jettCapable) jettCap++
      if (r.deltaOver > worstD) { worstD = r.deltaOver; worstCs = (r.f.callsign || r.f.icao).trim(); worstT = r.tMin }
    }
    return {
      meanDelta: rows.length ? sumDelta / rows.length : 0,
      meanT: finiteT ? sumT / finiteT : 0,
      worstD, worstCs, worstT, ovwt,
      jettShare: rows.length ? (jettCap / rows.length) * 100 : 0,
    }
  }, [rows])

  const klassAggs = useMemo(() => {
    const m = new Map<Klass, { klass: Klass; count: number; sumDelta: number; sumT: number; finiteT: number; worstD: number; worstCs: string; worstIcao: string; worstT: number; worstTier: Tier }>()
    for (const r of rows) {
      let a = m.get(r.klass)
      if (!a) { a = { klass: r.klass, count: 0, sumDelta: 0, sumT: 0, finiteT: 0, worstD: -1, worstCs: '', worstIcao: '', worstT: 0, worstTier: 'OK' }; m.set(r.klass, a) }
      a.count++
      a.sumDelta += r.deltaOver
      if (isFinite(r.tMin)) { a.sumT += r.tMin; a.finiteT++ }
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.deltaOver > a.worstD) { a.worstD = r.deltaOver; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao; a.worstT = r.tMin }
    }
    const arr = Array.from(m.values()).map(a => ({
      ...a,
      meanDelta: a.count ? a.sumDelta / a.count : 0,
      meanT: a.finiteT ? a.sumT / a.finiteT : 0,
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
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (klFilter !== 'ALL' && r.klass !== klFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.klass].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.deltaOver - a.deltaOver
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
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.severity / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'BURN' || r.tier === 'JETT' || r.tier === 'OVWT').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} +${fmtKg(r.deltaOver)}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'OVWT').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} › OVWT-LDG` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFeatures: any[] = []
    if (showProj) {
      for (const r of rows) {
        if (r.tier !== 'OVWT') continue
        const coords: [number, number][] = []
        for (let i = 0; i <= 12; i++) {
          const p = projectPosition(r.f.lat, r.f.lng, r.f.track || 0, (100 * i) / 12)
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

  // Diagram: tMin (x, 0..90 min) vs deltaOver (y, 0..40 t)
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 30
    const xMax = 90, yMax = 40
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, v / xMax)) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">OWL / Fuel Jettison</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} ac</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Δ</div>
          <div className="font-mono text-sm text-slate-200">{fmtKg(summary.meanDelta)}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} +${fmtKg(summary.worstD)}` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">OVWT-LDG</div>
          <div className="font-mono text-sm" style={{ color: summary.ovwt > 0 ? '#ef4444' : '#10b981' }}>{summary.ovwt}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean t-min</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanT > urgencyMin ? '#ef4444' : summary.meanT > urgencyMin / 2 ? '#f59e0b' : '#10b981' }}>{fmtMin(summary.meanT)}</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Jett-Capable</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.jettShare.toFixed(0)}<span className="text-[9px] text-slate-500"> %</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Δkg vs Time-to-MLW (min)</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* y-axis ticks (tonnes) */}
            {[5, 10, 20, 30].map(s => (
              <g key={s}>
                <line x1={diag.PAD} y1={diag.ys(s)} x2={diag.W - 6} y2={diag.ys(s)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(s) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{s}t</text>
              </g>
            ))}
            {/* x-axis: minutes */}
            {[15, 30, 45, 60, 75].map(x => (
              <g key={x}>
                <line x1={diag.xs(x)} y1={6} x2={diag.xs(x)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(x)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{x}m</text>
              </g>
            ))}
            {/* threshold bands: urgency vertical, margin horizontal */}
            <rect x={diag.PAD} y={6} width={diag.xs(urgencyMin) - diag.PAD} height={diag.H - diag.PAD - 6} fill="#10b981" opacity={0.06} />
            <rect x={diag.xs(urgencyMin)} y={6} width={diag.W - 6 - diag.xs(urgencyMin)} height={diag.H - diag.PAD - 6} fill="#ef4444" opacity={0.06} />
            <line x1={diag.xs(urgencyMin)} y1={6} x2={diag.xs(urgencyMin)} y2={diag.H - diag.PAD} stroke="#ef4444" strokeWidth={0.9} strokeDasharray="3 2" opacity={0.8} />
            <text x={diag.xs(urgencyMin) + 2} y={12} fontSize={7} fill="#ef4444" fontFamily="monospace">URGENCY {urgencyMin}m</text>
            <line x1={diag.PAD} y1={diag.ys(marginKg / 1000)} x2={diag.W - 6} y2={diag.ys(marginKg / 1000)} stroke="#0ea5e9" strokeWidth={0.9} strokeDasharray="3 2" opacity={0.8} />
            <text x={diag.W - 8} y={diag.ys(marginKg / 1000) - 2} textAnchor="end" fontSize={7} fill="#0ea5e9" fontFamily="monospace">MARGIN {(marginKg / 1000).toFixed(1)}t</text>
            {rows.filter(r => r.deltaOver > 0).map(r => {
              const x = diag.xs(Math.min(diag.xMax, isFinite(r.tMin) ? r.tMin : diag.xMax))
              const y = diag.ys(Math.min(diag.yMax, r.deltaOver / 1000))
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
            <div className="flex justify-between text-[10px] text-slate-500"><span>FUEL-BIAS</span><span className="font-mono text-slate-300">{fuelBias}%</span></div>
            <input type="range" min={50} max={200} step={5} value={fuelBias} onChange={e => setFuelBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>LOAD-FACTOR</span><span className="font-mono text-slate-300">{loadFactor}%</span></div>
            <input type="range" min={60} max={100} step={1} value={loadFactor} onChange={e => setLoadFactor(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MARGIN-KG</span><span className="font-mono text-slate-300">{marginKg}</span></div>
            <input type="range" min={0} max={10000} step={250} value={marginKg} onChange={e => setMarginKg(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>URGENCY-MIN</span><span className="font-mono text-slate-300">{urgencyMin}m</span></div>
            <input type="range" min={5} max={90} step={1} value={urgencyMin} onChange={e => setUrgencyMin(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>JETT-RATE</span><span className="font-mono text-slate-300">{jettRateMul}%</span></div>
            <input type="range" min={50} max={150} step={5} value={jettRateMul} onChange={e => setJettRateMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} ac` : `${filteredKlass.length} shown / ${klassAggs.length} cls`}</span>
        <span>{tab === 'AIRCRAFT' ? 'Δkg · t-burn · t-jett · tier' : 'cls · ac · mean-Δ · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          // GW bar: zero..MTOW, with MLW tick
          const gwPct = Math.max(0, Math.min(100, (r.gw / r.mtow) * 100))
          const mlwTick = (r.mlw / r.mtow) * 100
          const mzfwTick = (r.mzfw / r.mtow) * 100
          const advice = r.tier === 'OVWT'
            ? `cannot burn down before URGENCY · land overweight per QRH · AMM 05-51 inspection`
            : r.tier === 'JETT'
              ? `jettison fuel · estimated ${fmtMin(r.tMinJett)} to MLW @ ${r.jettKg.toFixed(0)} kg/min`
              : r.tier === 'BURN'
                ? `no dump fit · hold to burn ${fmtMin(r.tMinBurn)} @ ${r.burnKg.toFixed(0)} kg/min`
                : r.tier === 'MARGIN'
                  ? `within MARGIN-band · routine descent burns Δ to zero`
                  : `GW under MLW · nominal landing weight`
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
                  <span title="hours airborne">{r.hrs.toFixed(1)}h</span>
                  <span title="current gross weight" style={{ color: r.deltaOver > 0 ? TIER_COLOR[r.tier] : '#94a3b8' }}>{fmtKg(r.gw)}</span>
                  <span className="ml-auto" title="kg over MLW" style={{ color: TIER_COLOR[r.tier] }}>+{fmtKg(r.deltaOver)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`MZFW ${fmtKg(r.mzfw)} · MLW ${fmtKg(r.mlw)} · MTOW ${fmtKg(r.mtow)}`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${gwPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-slate-500" style={{ left: `${mzfwTick}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${mlwTick}%` }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="ZFW (passengers + cargo)">ZFW {fmtKg(r.zfw)}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="remaining fuel">FUEL {fmtKg(r.fuelRem)}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono"
                    style={{ borderColor: (r.jettCapable ? '#fb7185' : '#475569') + '66', color: r.jettCapable ? '#fb7185' : '#94a3b8', background: (r.jettCapable ? '#fb7185' : '#475569') + '14' }}
                    title={r.jettCapable ? 'jettison-capable airframe' : 'no fuel dump nozzles'}>{r.jettCapable ? `JETT ${r.jettKg.toFixed(0)} kg/m` : 'NO-DUMP'}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="hold-burn rate">HOLD {r.burnKg.toFixed(0)} kg/m</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono"
                    style={{ borderColor: TIER_COLOR[r.tier] + '66', color: TIER_COLOR[r.tier], background: TIER_COLOR[r.tier] + '14' }}
                    title="time to MLW via best path">{fmtMin(r.tMin)}{r.domDriver !== 'OK' ? ` · ${r.domDriver}` : ''}</span>
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
          const dPct = Math.max(0, Math.min(100, (a.meanDelta / Math.max(1, KL_MTOW[a.klass] - KL_MLW[a.klass])) * 100))
          const jettCapable = KL_JETT[a.klass] > 0
          const advice = a.worstTier === 'OVWT' ? 'class has aircraft beyond burn-down window · expect overweight landings'
            : a.worstTier === 'JETT' ? 'class equipped with fuel-dump nozzles · jettison is the fast path'
              : a.worstTier === 'BURN' ? 'class lacks dump kit · all overweight returns must hold-and-burn'
                : a.worstTier === 'MARGIN' ? 'class trending near MLW · routine descent absorbs delta'
                  : 'class operates under MLW · nominal'
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
                  <span title="mean delta over MLW">mean +{fmtKg(a.meanDelta)}</span>
                  <span title="mean time to MLW">{fmtMin(a.meanT)}</span>
                  <span title="worst delta" style={{ color: TIER_COLOR[a.worstTier] }}>worst +{fmtKg(a.worstD)}</span>
                  <span className="ml-auto truncate">{a.worstCs || '—'}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`mean Δ as share of MTOW−MLW band (${fmtKg(KL_MTOW[a.klass] - KL_MLW[a.klass])})`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${dPct}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate" title="class envelope">MLW {fmtKg(KL_MLW[a.klass])} · {jettCapable ? `JETT ${KL_JETT[a.klass]} kg/m` : 'NO-DUMP'}</span>
                  <span className="ml-auto truncate" style={{ color: a.worstTier === 'OK' ? '#64748b' : TIER_COLOR[a.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        Boeing FCOM QRH NNC · Airbus FCOM PRO-ABN-MISC · FAA AC 25-7C §32 · 14 CFR 25.1001 · ICAO Doc 9376 · EASA CS-25.473
      </div>
    </div>
  )
}
