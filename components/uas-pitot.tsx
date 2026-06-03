'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Unreliable Airspeed / Pitot-Icing Risk Monitor (UAS)
   -----------------------------------------------------------
   BEA Final Report AF447 / NTSB SAFO 11003 / FAA AC 25-11B
   Total Air Temperature probe icing / EASA AMC1 CAT.OP.MPA.140
   ice protection systems compliance / RTCA DO-160G Sec 24
   pitot heater certification / Boeing FCOM QRH UNRELIABLE
   AIRSPEED / Airbus FCTM AOM-1.05.30 UAS memory items /
   ICAO Annex 6 Pt I 6.10 cold-soaked instrument operations /
   FAA InFO 15012 High Ice Water Content (HIWC) cruise
   pitot-probe blockage advisory.

   Synthesises per-airframe airspeed-instrument health from
   FNV-1a 32-bit hash of ICAO24 driving:
     - Pitot probe count by class (3 jets / 2 biz / 1 GA)
     - Per-probe heater wear-hours 0-32000h (TCDS replacement
       interval typ. 18000-25000h for Thales BA / Goodrich 0851)
     - AoA vane heater fault probability (hash-stable per-vane)
     - TAT probe insulation degradation
   plus environmental context:
     - SAT via ISA lapse -1.98 C/1000ft from SL 15C clamped at
       tropopause -56.5C with ISA-DEV slider -30..+30C
     - TAT = SAT * (1 + 0.2 * M^2) recovery-factor 1.0 (Boeing
       FCOM 5.20 Eqn 5.4) yielding warmer-than-SAT envelope
     - HIWC cluster proxy: cruise + tropical convergence band
       |lat|<25deg + storm-belt longitudes via cosine modulation
       (FAA InFO 15012 ITCZ ice-crystal corridor)
     - Phase-of-flight pressure dynamic head loss when AoA high

   Risk factors (max-driver compositing 0-100):
     TAT-FREEZE   TAT vs water-freezing & supercooled droplet
                  spectrum (AC 25-11B App C cont/inter max
                  envelopes). Severity peaks at TAT -30..-50C
                  where supercooled water + ice crystals overlap.
                  Score = clip((tat<-25?(-(tat+25))*2.5:0),0,100).
     HIWC         High Ice Water Content cruise corridor risk
                  ramp by altKft>=300 + tropical+storm proxy.
                  Score = altRamp * latBand * stormPhase * HIWC
                  slider 50-200pct (FAA InFO 15012, ICAO HIWC
                  TF 2017).
     PROBE-WEAR   Per-airframe probe heater wear-hours vs WEAR
                  slider 5-30kh. Beyond threshold: heater amps
                  drift, ice shedding lag rises. Severity ramp.
     AOA-FAULT    Per-vane AoA heater fault stable hash * class
                  prob (HVY 0.04 / NRW 0.06 / RGN 0.08 / BIZ 0.05
                  / TBP 0.10 / GA 0.18 / FTR 0.07). Triggers
                  ADR DISAGREE on cold day.
     REDUNDANCY   # working probes after fault deduction vs
                  required 2 (CS-25.1323(c) cross-monitoring).
                  Single-probe -> sev 95. Two -> sev 30.
                  Triple healthy -> sev 0.

   Composite score = max(per-factor sev).
   Dominant driver = highest-scoring factor.

   Tier classification:
     UAS-EVT  score>=80  rose    apply UNRELIABLE AIRSPEED memory
                                 items pitch+thrust table FCOM QRH
     HIWC     score>=55  amber   exit ice-crystal cluster descend
                                 or deviate around HIWC corridor
     WATCH    score>=25  sky     monitor stby ASI/IRS-GS cross-chk
     OK       score<25   emerald nominal airspeed instrumentation
     IDLE     ground/low slate   excluded

   MapLibre overlay:
     - Tier-coloured halo rings sized by composite 8-22 px
     - Dashed amber HIWC corridor polylines at lat +/-25 cruise
       belt sampled great-circle 60-pt
     - Rose diamond pin at 50nm-ahead descent waypoint for
       UAS-EVT aircraft (suggest IMMEDIATE descent FL250)
     - Tier-coloured callsign+TAT+driver labels for non-OK

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-SCORE / WORST callsign+driver / UAS-EVT count
     - 2-cell MEAN-TAT secondary / TRIPLE-PROBE share
     - SVG TAT-vs-altFL scatter with -25/-40/-56 threshold bands
     - 5 sliders ISA-DEV / HIWC / WEAR / MIN-FL / SOC-stub
     - 7-class chip filter + HALO/COR/PIN/LBL/DIAG toggles
     - AIRCRAFT / DRIVERS tab switcher

   Registered in Layers > Safety & Traffic. Persisted: ft-uas
   ============================================================ */

export interface UasFlight {
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
  flights: UasFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'WATCH' | 'HIWC' | 'UAS' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981',
  WATCH: '#0ea5e9',
  HIWC: '#f59e0b',
  UAS: '#ef4444',
  IDLE: '#64748b',
}
const TIER_LABEL: Record<Tier, string> = {
  OK: 'OK', WATCH: 'WATCH', HIWC: 'HIWC', UAS: 'UAS-EVT', IDLE: 'IDLE',
}
const TIER_ORDER: Tier[] = ['UAS', 'HIWC', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { UAS: 0, HIWC: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Klass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const KL_NAME: Record<Klass, string> = {
  HVY: 'Heavy wide-body',
  NRW: 'Narrow-body',
  RGN: 'Regional jet/turboprop',
  BIZ: 'Business jet',
  TBP: 'Turboprop',
  GA: 'General aviation',
  FTR: 'Fighter',
}
const KL_PROBES: Record<Klass, number> = { HVY: 3, NRW: 3, RGN: 3, BIZ: 2, TBP: 2, GA: 1, FTR: 2 }
const KL_AOA_FAULT: Record<Klass, number> = { HVY: 0.04, NRW: 0.06, RGN: 0.08, BIZ: 0.05, TBP: 0.10, GA: 0.18, FTR: 0.07 }
const KL_MAX_WEAR: Record<Klass, number> = { HVY: 28000, NRW: 24000, RGN: 20000, BIZ: 22000, TBP: 16000, GA: 8000, FTR: 12000 }
const KL_CRUISE_MACH: Record<Klass, number> = { HVY: 0.82, NRW: 0.78, RGN: 0.74, BIZ: 0.80, TBP: 0.45, GA: 0.25, FTR: 0.85 }

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'GA'
  if (/^(B77|B78|A33|A34|A35|A38|B74|MD11|IL96|B76|A30|A31[0-9])/.test(x)) return 'HVY'
  if (/^(A31|A32|A19|A20|A21|A22|B73|B72|B71|MD8|MD9|BCS|CS1|CS3)/.test(x)) return 'NRW'
  if (/^(CRJ|E14|E15|E17|E19|E29|E70|E75|AT4|AT5|AT7|DH8|Q40)/.test(x)) return 'RGN'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'BIZ'
  if (/^(SF34|J32|J41|ATR|TBM|PC12|TB|PC6|DHC|AN2|BE9|BE3|BE2)/.test(x)) return 'TBP'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS|TORN)/.test(x)) return 'FTR'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|C20)/.test(x)) return 'GA'
  return 'NRW'
}

type Phase = 'CLIMB' | 'CRUISE' | 'DESCENT' | 'APPR' | 'LOW'
const PHASE_LABEL: Record<Phase, string> = { CLIMB: 'CLB', CRUISE: 'CRZ', DESCENT: 'DES', APPR: 'APP', LOW: 'LOW' }
function inferPhase(altFt: number, vsFpm: number): Phase {
  if (altFt < 8000) return 'LOW'
  if (vsFpm > 600) return 'CLIMB'
  if (vsFpm < -600) return 'DESCENT'
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

// ISA SAT (Celsius) with deviation
function satC(altFt: number, isaDev: number): number {
  const tropo = 36089
  const baseC = altFt <= tropo ? 15 - 1.98 * (altFt / 1000) : -56.5
  return baseC + isaDev
}

// HIWC corridor: tropical convergence + cruise altitude + storm-cycle modulation
function hiwcSeverity(lat: number, lng: number, altKft: number, hiwcMul: number): number {
  if (altKft < 250) return 0
  const altRamp = Math.min(1, Math.max(0, (altKft - 250) / 150)) // ramps 250->400
  const absLat = Math.abs(lat)
  const latBand = absLat <= 25 ? 1.0 : absLat <= 35 ? Math.max(0, 1 - (absLat - 25) / 10) : 0
  // storm cycle: cosine over longitude representing ITCZ moving cluster
  const hour = new Date().getUTCHours()
  const phase = 0.6 + 0.4 * Math.cos((lng / 360 + hour / 48) * Math.PI * 2)
  return Math.min(100, altRamp * latBand * phase * 95 * (hiwcMul / 100))
}

type Driver = 'TAT' | 'HIWC' | 'WEAR' | 'AOA' | 'REDUN' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  TAT: 'TAT freeze envelope',
  HIWC: 'High ice water content',
  WEAR: 'Probe heater wear',
  AOA: 'AoA vane heater fault',
  REDUN: 'Probe redundancy gap',
  NONE: 'Nominal',
}

interface Row {
  f: UasFlight
  klass: Klass
  flCur: number
  phase: Phase
  mach: number
  sat: number
  tat: number
  hrsWear: number
  probes: number
  probesOk: number
  aoaFault: boolean
  sev: { tat: number; hiwc: number; wear: number; aoa: number; redun: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'uas-halo', SRC_LBL = 'uas-lbl', SRC_PIN = 'uas-pin', SRC_COR = 'uas-cor'
const LYR_HALO = 'uas-halo-l', LYR_LBL = 'uas-lbl-l', LYR_PIN = 'uas-pin-l', LYR_COR = 'uas-cor-l'

export default function UasPitot({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'DRIVERS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klFilter, setKlFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(80)
  const [isaDev, setIsaDev] = useState(0)        // -30..+30 C
  const [hiwcMul, setHiwcMul] = useState(100)    // 50-200 %
  const [wearKh, setWearKh] = useState(18)       // 5-30 kh threshold
  const [warnC, setWarnC] = useState(-25)        // -10..-50 C TAT warn threshold
  const [showHalo, setShowHalo] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showCor, setShowCor] = useState(true)
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

      // Mach proxy: GS / 575 (rough TAS->Mach @ FL350 ISA) clipped by class cruise mach
      const machProxy = Math.max(0.1, Math.min(0.95, (f.velocityKts || 0) / 575))
      const mach = phase === 'CRUISE' ? Math.min(KL_CRUISE_MACH[klass] + 0.04, machProxy) : machProxy * 0.85

      const sat = satC(f.altitudeFt, isaDev)
      const tat = sat * (1 + 0.2 * mach * mach) + 0.0  // recovery 1.0, no Joule heating
      // -- but TAT > SAT only if SAT positive; in negative SAT, multiplication makes it MORE negative? No:
      // TAT - SAT = 0.2 * M^2 * |SAT|*sign — actually formula: TAT = SAT*(1+0.2*M^2) where SAT in K.
      // Use kelvin properly:
      const satK = sat + 273.15
      const tatK = satK * (1 + 0.2 * mach * mach)
      const tatC = tatK - 273.15

      // Per-airframe wear-hours
      const hrsWear = ((h >>> 11) % 1000) / 1000 * KL_MAX_WEAR[klass]
      // AOA fault: hash bucket vs class probability
      const aoaProb = KL_AOA_FAULT[klass]
      const aoaRoll = ((h >>> 5) % 1000) / 1000
      const aoaFault = aoaRoll < aoaProb
      // Probes failed: hash-driven, more likely if worn
      const probes = KL_PROBES[klass]
      const wearFrac = hrsWear / Math.max(1, KL_MAX_WEAR[klass])
      const probeFailRoll = ((h >>> 17) % 1000) / 1000
      const probeFailProb = wearFrac * 0.18 + 0.02
      const probesDown = probeFailRoll < probeFailProb ? 1 : 0
      const probesOk = Math.max(0, probes - probesDown)

      // Severities
      const tatSev = tatC < warnC ? Math.min(100, (warnC - tatC) * 3.0) : 0
      const hiwcSev = hiwcSeverity(f.lat, f.lng, flCur, hiwcMul)
      const wearSev = hrsWear > wearKh * 1000 ? Math.min(100, ((hrsWear - wearKh * 1000) / 8000) * 100) : 0
      const aoaSev = aoaFault ? (tatC < -10 ? 85 : 55) : 0
      const redunSev = probesOk <= 1 ? 95 : probesOk === 2 ? 30 : 0

      const sevs = { tat: tatSev, hiwc: hiwcSev, wear: wearSev, aoa: aoaSev, redun: redunSev }
      const drvList: Array<[Driver, number]> = [
        ['TAT', tatSev], ['HIWC', hiwcSev], ['WEAR', wearSev],
        ['AOA', aoaSev], ['REDUN', redunSev]
      ]
      drvList.sort((a, b) => b[1] - a[1])
      const driver: Driver = drvList[0][1] > 0 ? drvList[0][0] : 'NONE'
      const score = drvList[0][1]

      let tier: Tier
      if (score >= 80) tier = 'UAS'
      else if (score >= 55) tier = 'HIWC'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({ f, klass, flCur, phase, mach, sat, tat: tatC, hrsWear, probes, probesOk, aoaFault, sev: sevs, score, driver, tier })
    }
    return out
  }, [flights, minFl, isaDev, hiwcMul, wearKh, warnC])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, WATCH: 0, HIWC: 0, UAS: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumScore = 0, sumTat = 0, worst = 0, worstCs = '', worstDrv: Driver = 'NONE'
    let uas = 0, triple = 0
    for (const r of rows) {
      sumScore += r.score; sumTat += r.tat
      if (r.tier === 'UAS') uas++
      if (r.probesOk >= 3) triple++
      if (r.score > worst) { worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstDrv = r.driver }
    }
    return {
      meanScore: rows.length ? sumScore / rows.length : 0,
      meanTat: rows.length ? sumTat / rows.length : 0,
      worst, worstCs, worstDrv, uas,
      tripleShare: rows.length ? (triple / rows.length) * 100 : 0,
    }
  }, [rows])

  const driverAggs = useMemo(() => {
    const m = new Map<Driver, { driver: Driver; count: number; sumScore: number; worst: number; worstCs: string; worstIcao: string; worstTier: Tier }>()
    for (const r of rows) {
      if (r.driver === 'NONE') continue
      let a = m.get(r.driver)
      if (!a) { a = { driver: r.driver, count: 0, sumScore: 0, worst: 0, worstCs: '', worstIcao: '', worstTier: 'OK' }; m.set(r.driver, a) }
      a.count++; a.sumScore += r.score
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.score > a.worst) { a.worst = r.score; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
    }
    const arr = Array.from(m.values()).map(a => ({ ...a, meanScore: a.count ? a.sumScore / a.count : 0 }))
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
        return b.score - a.score
      })
  }, [rows, tierFilter, klFilter, query])

  const filteredDrivers = useMemo(() => {
    const q = query.trim().toUpperCase()
    return driverAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (!q) return true
      return (a.driver + ' ' + DRIVER_LABEL[a.driver]).toUpperCase().includes(q)
    })
  }, [driverAggs, tierFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'HIWC' || r.tier === 'UAS').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${Math.round(r.tat)}C ${r.driver}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'UAS').map(r => {
      const p = projectPosition(r.f.lat, r.f.lng, r.f.track || 0, 50)
      return {
        type: 'Feature' as const,
        properties: { color: TIER_COLOR[r.tier], text: `› DESCEND FL250` },
        geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
      }
    }) : [] }
    const corFeatures: any[] = []
    if (showCor) {
      // HIWC corridor: latitude bands +/-25 sampled across longitudes
      for (const lat of [25, -25]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 6) coords.push([lng, lat])
        corFeatures.push({ type: 'Feature' as const, properties: { color: '#f59e0b' }, geometry: { type: 'LineString' as const, coordinates: coords } })
      }
    }
    const corFc = { type: 'FeatureCollection' as const, features: corFeatures }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_COR, corFc, () => map.addLayer({ id: LYR_COR, type: 'line', source: SRC_COR, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.0, 'line-opacity': 0.45, 'line-dasharray': [4, 4],
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
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_COR]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_COR]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showCor])

  // Diagram: TAT (x, -60..+10C) vs FL (y, 0..500)
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 30
    const xMin = -60, xMax = 10, yMax = 500
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">UAS / Pitot-Icing</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} ac</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean score</div>
          <div className="font-mono text-sm" style={{ color: summary.meanScore >= 55 ? '#f59e0b' : summary.meanScore >= 25 ? '#0ea5e9' : '#10b981' }}>{summary.meanScore.toFixed(0)}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worst.toFixed(0)}` : '—'}
          </div>
          <div className="text-[8px] text-slate-500 truncate">{summary.worstDrv !== 'NONE' ? DRIVER_LABEL[summary.worstDrv] : '—'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">UAS-EVT</div>
          <div className="font-mono text-sm" style={{ color: summary.uas > 0 ? '#ef4444' : '#10b981' }}>{summary.uas}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean TAT</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanTat < -40 ? '#ef4444' : summary.meanTat < -25 ? '#f59e0b' : '#10b981' }}>{summary.meanTat.toFixed(0)}C</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">3-Probe share</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.tripleShare.toFixed(0)}<span className="text-[9px] text-slate-500"> %</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">TAT (C) vs Flight Level</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* y-axis FL ticks */}
            {[100, 200, 300, 400].map(fl => (
              <g key={fl}>
                <line x1={diag.PAD} y1={diag.ys(fl)} x2={diag.W - 6} y2={diag.ys(fl)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(fl) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">F{fl}</text>
              </g>
            ))}
            {/* x-axis TAT ticks */}
            {[-50, -40, -25, -10, 0].map(c => (
              <g key={c}>
                <line x1={diag.xs(c)} y1={6} x2={diag.xs(c)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(c)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{c}</text>
              </g>
            ))}
            {/* threshold bands: rose <-40, amber -40..-25, sky -25..-10, emerald > -10 */}
            <rect x={diag.PAD} y={6} width={diag.xs(-40) - diag.PAD} height={diag.H - diag.PAD - 6} fill="#ef4444" opacity={0.08} />
            <rect x={diag.xs(-40)} y={6} width={diag.xs(-25) - diag.xs(-40)} height={diag.H - diag.PAD - 6} fill="#f59e0b" opacity={0.08} />
            <rect x={diag.xs(-25)} y={6} width={diag.xs(-10) - diag.xs(-25)} height={diag.H - diag.PAD - 6} fill="#0ea5e9" opacity={0.06} />
            <rect x={diag.xs(-10)} y={6} width={diag.W - 6 - diag.xs(-10)} height={diag.H - diag.PAD - 6} fill="#10b981" opacity={0.06} />
            <line x1={diag.xs(-40)} y1={6} x2={diag.xs(-40)} y2={diag.H - diag.PAD} stroke="#ef4444" strokeWidth={0.9} strokeDasharray="3 2" opacity={0.8} />
            <line x1={diag.xs(warnC)} y1={6} x2={diag.xs(warnC)} y2={diag.H - diag.PAD} stroke="#f59e0b" strokeWidth={0.9} strokeDasharray="3 2" opacity={0.8} />
            <text x={diag.xs(warnC) + 2} y={12} fontSize={7} fill="#f59e0b" fontFamily="monospace">WARN {warnC}C</text>
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, r.tat)))} cy={diag.ys(Math.min(diag.yMax, r.flCur))} r={3} fill={TIER_COLOR[r.tier]} opacity={0.92} />
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
            <div className="flex justify-between text-[10px] text-slate-500"><span>ISA-DEV</span><span className="font-mono text-slate-300">{isaDev > 0 ? '+' : ''}{isaDev}C</span></div>
            <input type="range" min={-30} max={30} step={1} value={isaDev} onChange={e => setIsaDev(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>HIWC-MUL</span><span className="font-mono text-slate-300">{hiwcMul}%</span></div>
            <input type="range" min={50} max={200} step={5} value={hiwcMul} onChange={e => setHiwcMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>WEAR-kh</span><span className="font-mono text-slate-300">{wearKh}k</span></div>
            <input type="range" min={5} max={30} step={1} value={wearKh} onChange={e => setWearKh(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>WARN-C</span><span className="font-mono text-slate-300">{warnC}C</span></div>
          <input type="range" min={-50} max={-10} step={1} value={warnC} onChange={e => setWarnC(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['HVY', 'NRW', 'RGN', 'BIZ', 'TBP', 'GA', 'FTR'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlFilter(klFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showCor} onChange={e => setShowCor(e.target.checked)} className="accent-sky-500" /><span>COR</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / class"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'DRIVERS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} ac` : `${filteredDrivers.length} shown / ${driverAggs.length} drv`}</span>
        <span>{tab === 'AIRCRAFT' ? 'score · TAT · driver · tier' : 'drv · count · mean · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const advice = r.tier === 'UAS'
            ? `apply UNRELIABLE AIRSPEED memory items · pitch+thrust per QRH · descend FL250`
            : r.tier === 'HIWC'
              ? `HIWC corridor · deviate around ice-crystal cluster or descend below FL250`
              : r.tier === 'WATCH'
                ? `monitor stby ASI · cross-check IRS GS · arm engine anti-ice`
                : `airspeed instrumentation nominal`
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{r.klass}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{TIER_LABEL[r.tier]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="flight level">F{Math.round(r.flCur)}</span>
                  <span title="phase">{PHASE_LABEL[r.phase]}</span>
                  <span title="mach proxy">M{r.mach.toFixed(2)}</span>
                  <span title="total air temp" style={{ color: r.tat < -40 ? '#ef4444' : r.tat < -25 ? '#f59e0b' : '#94a3b8' }}>{r.tat.toFixed(0)}C</span>
                  <span className="ml-auto" title="composite risk score" style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`score ${r.score.toFixed(0)} / 100`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500/70" style={{ left: `25%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-500/70" style={{ left: `55%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-500/70" style={{ left: `80%` }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {([['TAT', r.sev.tat], ['HIWC', r.sev.hiwc], ['WEAR', r.sev.wear], ['AOA', r.sev.aoa], ['RDN', r.sev.redun]] as const).map(([lbl, v]) => {
                    const c = v >= 80 ? '#ef4444' : v >= 55 ? '#f59e0b' : v >= 25 ? '#0ea5e9' : '#475569'
                    return (
                      <span key={lbl} className="px-1 py-0 rounded border text-[9px] font-mono"
                        style={{ borderColor: c + '66', color: c, background: c + '14' }}>{lbl} {v.toFixed(0)}</span>
                    )
                  })}
                  <span className="px-1 py-0 rounded border text-[9px] font-mono"
                    style={{ borderColor: r.probesOk >= 3 ? '#10b98166' : r.probesOk === 2 ? '#0ea5e966' : '#ef444466', color: r.probesOk >= 3 ? '#10b981' : r.probesOk === 2 ? '#0ea5e9' : '#ef4444', background: r.probesOk >= 3 ? '#10b98114' : r.probesOk === 2 ? '#0ea5e914' : '#ef444414' }}
                    title="working pitot probes">{r.probesOk}/{r.probes} PROBE</span>
                  {r.aoaFault && (
                    <span className="px-1 py-0 rounded border text-[9px] font-mono"
                      style={{ borderColor: '#f59e0b66', color: '#f59e0b', background: '#f59e0b14' }} title="AoA vane heater fault">AoA FAULT</span>
                  )}
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="probe heater wear hours">{(r.hrsWear / 1000).toFixed(1)}kh</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'DRIVERS' && filteredDrivers.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No drivers active.</div>
        )}
        {tab === 'DRIVERS' && filteredDrivers.map(a => {
          const advice = a.driver === 'TAT' ? 'cold soak envelope · select cont engine anti-ice · monitor TAT'
            : a.driver === 'HIWC' ? 'ice-crystal corridor active · deviate around clusters · descend FL250'
            : a.driver === 'WEAR' ? 'probe heater wear over threshold · schedule TCDS replacement'
            : a.driver === 'AOA' ? 'AoA vane heater fault detected · expect ADR DISAGREE on cold day'
            : a.driver === 'REDUN' ? 'probe redundancy degraded · CS-25.1323(c) cross-monitoring at risk'
            : 'nominal'
          return (
            <button key={a.driver} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.driver}</span>
                  <span className="text-slate-500 text-[10px] truncate">{DRIVER_LABEL[a.driver]}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.worstTier] }}>{TIER_LABEL[a.worstTier]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="mean score">mean {a.meanScore.toFixed(0)}</span>
                  <span title="worst score" style={{ color: TIER_COLOR[a.worstTier] }}>worst {a.worst.toFixed(0)}</span>
                  <span className="ml-auto truncate">{a.worstCs || '—'}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`mean score ${a.meanScore.toFixed(0)} / 100`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, a.meanScore)}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500/70" style={{ left: `25%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-500/70" style={{ left: `55%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-500/70" style={{ left: `80%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate">QRH / FCOM</span>
                  <span className="ml-auto truncate" style={{ color: a.worstTier === 'OK' ? '#64748b' : TIER_COLOR[a.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        BEA AF447 · NTSB SAFO 11003 · FAA AC 25-11B · FAA InFO 15012 HIWC · RTCA DO-160G §24 · CS-25.1323(c) · Boeing FCOM QRH UNRELIABLE AIRSPEED · Airbus FCTM AOM-1.05.30
      </div>
    </div>
  )
}
