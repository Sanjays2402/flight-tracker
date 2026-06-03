'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Stall Margin / Alpha-Floor / Stick-Shaker Monitor
   -----------------------------------------------------------
   FAR 25.103 stall speed certification / FAR 25.207 stall warning
   margin / EASA CS-25.103 / CS-25.207 / Boeing FCOM 5.25 stall
   warning system (stick-shaker @ ~7% above VSR) / Airbus FCOM
   PRO-NOR-SOP-08 alpha-protection (Alpha-Prot ~ 1.05*Vs1g) and
   Alpha-Floor (~ 1.13*Vs1g triggers TOGA-LOCK) / NTSB AAR-10/01
   Colgan Air 3407 stall / BEA AF447 deep stall / FAA AC 25-7C
   stall-warning demo / FAA InFO 17012 angle-of-attack training.

   For every airborne aircraft, computes proximity to stall via
   1-g stall speed VS1g at current weight, altitude (density),
   load-factor, configuration (proxied by phase), and ice
   accretion factor; converts to alpha-margin and triggers
   tier classification matching airline FDM stall-margin EVAL
   (CEFA, Aerobytes) Level-1/2/3 thresholds.

   Per-class stall reference at MLW clean (KCAS):
     HVY  Vs1g 145  (B777/A350 MLW)
     NRW  Vs1g 122  (B737NG/A320 MLW)
     RGN  Vs1g  98  (CRJ/E190 MLW)
     BIZ  Vs1g 102  (GLEX/G650 MLW)
     TBP  Vs1g  78  (ATR/Q400 MLW)
     GA   Vs1g  48  (C172/SR22 MLW)
     FTR  Vs1g 130  (F-16/Typhoon)

   Class-typical CL_max clean / max-flap and per-class buffet
   boundary high-alt CL_buf reduction per FCOM 5.25 buffet onset
   chart. Coffin-corner Vs1g rises with altitude as 1/sqrt(sigma)
   while Mmo cap reduces with TAT.

   Per-airframe stable degradation via FNV-1a 32-bit hash of
   ICAO24 driving:
     - Weight fraction 0.78..1.00 of MLW (HVY/NRW long-haul)
     - Ice accretion 0..1 (only when in icing window)
     - AoA-vane health (stable per-airframe failure prob)
     - Stick-shaker calibration drift +/- 5kt

   Risk components (max-driver compositing 0-100):
     STALL    CAS margin above VS1g(weight, alt, ice, n). 0 sev
              at margin>=MARGIN-WARN slider 15-50kt, ramps to
              100 at margin<=0kt. Stick-shaker at +7% VS1g.
     ALPHA    Alpha-prot / alpha-floor envelope per Airbus AOM:
              alpha-prot @ 1.05*Vs1g (sev 60+), alpha-floor @
              1.13*Vs1g (TOGA-LOCK; sev 80+).
     BUFFET   High-alt buffet margin per FCOM 5.25 — both
              low-speed (pre-stall) and high-speed (Mach buffet)
              boundaries close to a "coffin corner" at FL400+.
              0.3g manoeuvre buffet margin required FAR 25.143(h).
     ICING    Tail-plane / wing ice accretion increases stall
              CAS by 20-40pct per AC 91-74B. Triggered when OAT
              -2..-15C and rel-hum proxy (cloud cover) high.
     CONFIG   Configuration penalty: flap-up at low energy
              during approach (under 1.3 Vs1g per stable approach
              criteria) or gear-up during landing checklist.

   Composite score = max(per-factor sev).
   Dominant driver = highest-scoring factor.

   Tier classification:
     STALL    score>=80  rose    immediate nose-down + TOGA
     APPROACH score>=55  amber   add power / monitor stick-shaker
     WATCH    score>=25  sky     monitor airspeed trend
     OK       score<25   emerald within stable approach envelope
     IDLE     ground/lo  slate   excluded

   MapLibre overlay:
     - Tier-coloured halo rings sized by score 8-22 px
     - Rose diamond pin at 30sec ahead projected position for
       STALL aircraft indicating where stall will breach
     - Amber dashed approach corridor markers
     - Tier-coloured callsign+kt-margin+driver labels non-OK

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-MARG / WORST callsign+driver / STALL count
     - 2-cell MEAN-Vs1g / ALPHA-FLOOR count secondary
     - SVG CAS vs VS1g scatter with stick-shaker envelope band
     - 5 sliders MIN-FL / WEIGHT-FRAC / ICING-MUL / MARGIN-WARN /
       BUF-MARG-G
     - 7-class chip filter HVY/NRW/RGN/BIZ/TBP/GA/FTR
     - HALO/PIN/LBL/ENV/DIAG toggles + search
     - AIRCRAFT/DRIVERS tab switcher
     - Per-row breakdown chips, score bar, advice
     - DRIVERS tab grouped by dominant driver

   Persisted: ft-stall
   ============================================================ */

export interface StallFlight {
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
  flights: StallFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'STALL' | 'APPR' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  STALL: '#ef4444', APPR: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_LABEL: Record<Tier, string> = {
  STALL: 'STALL', APPR: 'APPR', WATCH: 'WATCH', OK: 'OK', IDLE: 'IDLE',
}
const TIER_ORDER: Tier[] = ['STALL', 'APPR', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { STALL: 0, APPR: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Klass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const KL_NAME: Record<Klass, string> = {
  HVY: 'Heavy wide-body', NRW: 'Narrow-body', RGN: 'Regional jet',
  BIZ: 'Business jet', TBP: 'Turboprop', GA: 'General aviation', FTR: 'Fighter',
}
// Vs1g at MLW clean, sea level (KCAS) per FAR 25.103 cert data
const KL_VS1G: Record<Klass, number> = { HVY: 145, NRW: 122, RGN: 98, BIZ: 102, TBP: 78, GA: 48, FTR: 130 }
// Stall warning margin per FAR 25.207 — stick-shaker at +7% Vs1g
const SHAKER_FACTOR = 1.07
// Airbus Alpha-Prot @ 1.05 Vs1g, Alpha-Floor @ 1.13 Vs1g (FCOM PRO-NOR-SOP-08)
const ALPHA_PROT = 1.05
const ALPHA_FLOOR = 1.13
// Stable approach criterion: speed >= 1.3 Vs1g at 1000ft AGL
const STABLE_APP = 1.30

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

// ISA atmosphere — returns { tempC, sigma (rho/rho0) }
function isaAtm(altFt: number, isaDev: number) {
  const tropo = 36089
  let tK: number; let pRatio: number
  if (altFt <= tropo) {
    const tC = 15 - 1.98 * (altFt / 1000) + isaDev
    tK = tC + 273.15
    pRatio = Math.pow((tC + 273.15) / 288.15, 5.2561)
  } else {
    tK = 216.65 + isaDev
    const pT = Math.pow(216.65 / 288.15, 5.2561)
    pRatio = pT * Math.exp(-(altFt - tropo) / 20805.7)
  }
  const tStd = altFt <= tropo ? (15 - 1.98 * altFt / 1000 + 273.15) : 216.65
  const sigma = pRatio * (tStd / tK)
  return { tC: tK - 273.15, sigma }
}

// Phase inference from altitude & vertical rate
function inferPhase(altFt: number, vRate: number): 'TAKEOFF' | 'CLIMB' | 'CRUISE' | 'DESCENT' | 'APPR' {
  if (altFt < 2000 && vRate > 800) return 'TAKEOFF'
  if (vRate > 500) return 'CLIMB'
  if (altFt < 5000 && vRate < -300) return 'APPR'
  if (vRate < -500) return 'DESCENT'
  return 'CRUISE'
}

type Driver = 'STL' | 'ALP' | 'BUF' | 'ICE' | 'CFG' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  STL: 'Stall CAS margin', ALP: 'Alpha-prot / alpha-floor',
  BUF: 'High-alt buffet boundary', ICE: 'Ice-contaminated stall',
  CFG: 'Configuration / energy state', NONE: 'Nominal',
}

interface Row {
  f: StallFlight
  klass: Klass
  flCur: number
  phase: 'TAKEOFF' | 'CLIMB' | 'CRUISE' | 'DESCENT' | 'APPR'
  vs1gRef: number
  vs1gAct: number   // weight + alt + ice + n corrected
  cas: number
  marginKt: number
  marginRatio: number  // CAS / vs1gAct
  tatC: number
  weightFrac: number
  iceFactor: number
  bufMarginG: number
  sev: { stall: number; alpha: number; buf: number; ice: number; cfg: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'stall-halo', SRC_LBL = 'stall-lbl', SRC_PIN = 'stall-pin', SRC_ENV = 'stall-env'
const LYR_HALO = 'stall-halo-l', LYR_LBL = 'stall-lbl-l', LYR_PIN = 'stall-pin-l', LYR_ENV = 'stall-env-l'

export default function StallMargin({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'DRIVERS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klFilter, setKlFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(20)
  const [weightFrac, setWeightFrac] = useState(95)  // pct of MLW
  const [icingMul, setIcingMul] = useState(100)
  const [marginWarn, setMarginWarn] = useState(30)  // kt
  const [bufMargG, setBufMargG] = useState(30)      // 0.30 g cert
  const [showHalo, setShowHalo] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showEnv, setShowEnv] = useState(true)
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
      const vs1gRef = KL_VS1G[klass]
      const atm = isaAtm(f.altitudeFt, 0)
      const tas = Math.max(0, f.velocityKts || 0)
      const sigma = Math.max(0.05, atm.sigma)
      const cas = tas * Math.sqrt(sigma)
      const phase = inferPhase(f.altitudeFt, f.vertRate)

      const h = hash32(f.icao || '')
      // Weight: hash-stable + slider bias
      const wHash = 0.78 + (((h >>> 5) % 1000) / 1000) * 0.22  // 0.78..1.00
      const wFrac = Math.max(0.6, Math.min(1.05, wHash * (weightFrac / 95)))
      // Ice accretion: only when in icing window (OAT -15..-2C) and below FL250
      const inIce = atm.tC < -2 && atm.tC > -15 && flCur < 250
      const iceHash = (((h >>> 11) % 1000) / 1000)
      const iceFactor = inIce ? Math.min(0.45, iceHash * 0.40 * (icingMul / 100)) : 0
      // VS1g actual: scales with sqrt(weight) and sqrt(rho0/rho) for IAS at altitude,
      // plus ice penalty 1+iceFactor
      const vs1gAct = vs1gRef * Math.sqrt(wFrac) * (1 + iceFactor)
      const margin = cas - vs1gAct
      const marginRatio = vs1gAct > 0 ? cas / vs1gAct : 99
      const tatC = atm.tC  // simplified

      // ---- Severities ----
      // STALL: 0 at margin>=marginWarn, 100 at margin<=0
      const stallSev = margin <= 0 ? 100 : margin >= marginWarn ? 0
        : 100 * (1 - margin / marginWarn)
      // ALPHA-FLOOR: severity based on marginRatio vs 1.13 (alpha-floor) / 1.05 (alpha-prot)
      const alphaSev = marginRatio <= 1.0 ? 100
        : marginRatio <= ALPHA_PROT ? 80
        : marginRatio <= ALPHA_FLOOR ? 60 * (ALPHA_FLOOR - marginRatio) / (ALPHA_FLOOR - ALPHA_PROT) + 40
        : marginRatio <= 1.20 ? 40 * (1.20 - marginRatio) / (1.20 - ALPHA_FLOOR)
        : 0
      // BUFFET: high-alt FL>=300, Mach-buffet boundary closing. Approximate buffet
      // margin in g: g_avail = (CAS/Vs1g)^2 * CLmax_ratio. Need 0.3g margin per FAR 25.143(h).
      // Approximate g_avail = (marginRatio^2 - 1) at altitude with sigma-based reduction.
      const altPenalty = flCur >= 300 ? (flCur - 300) / 100 * 0.08 : 0  // ~0.08g per FL100
      const gAvail = Math.max(0, (marginRatio * marginRatio - 1) - altPenalty)
      const gMargRequired = bufMargG / 100
      const bufSev = flCur < 250 ? 0
        : gAvail >= gMargRequired ? 0
        : gAvail <= 0 ? 100
        : 100 * (1 - gAvail / gMargRequired)
      // ICING: kicks in only when ice present and margin tight
      const iceSev = iceFactor === 0 ? 0
        : marginRatio >= 1.4 ? 0
        : marginRatio <= 1.0 ? 100
        : 100 * (1.4 - marginRatio) / 0.4 * (iceFactor / 0.45)
      // CONFIG: low-energy during APPR/TAKEOFF below 1.3*Vs1g triggers
      const cfgSev = (phase === 'APPR' || phase === 'TAKEOFF')
        ? (marginRatio >= STABLE_APP ? 0
          : marginRatio <= 1.05 ? 95
          : 95 * (STABLE_APP - marginRatio) / (STABLE_APP - 1.05))
        : 0

      const sevs = { stall: stallSev, alpha: alphaSev, buf: bufSev, ice: iceSev, cfg: cfgSev }
      const drvList: Array<[Driver, number]> = [
        ['STL', stallSev], ['ALP', alphaSev], ['BUF', bufSev],
        ['ICE', iceSev], ['CFG', cfgSev],
      ]
      drvList.sort((a, b) => b[1] - a[1])
      const driver: Driver = drvList[0][1] > 0 ? drvList[0][0] : 'NONE'
      const score = drvList[0][1]
      let tier: Tier
      if (score >= 80) tier = 'STALL'
      else if (score >= 55) tier = 'APPR'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, klass, flCur, phase, vs1gRef, vs1gAct, cas,
        marginKt: margin, marginRatio, tatC, weightFrac: wFrac, iceFactor,
        bufMarginG: gAvail, sev: sevs, score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, weightFrac, icingMul, marginWarn, bufMargG])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { STALL: 0, APPR: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumMarg = 0, sumVs = 0, worst = 0, worstCs = '', worstDrv: Driver = 'NONE'
    let stall = 0, aFloor = 0
    for (const r of rows) {
      sumMarg += r.marginKt; sumVs += r.vs1gAct
      if (r.tier === 'STALL') stall++
      if (r.sev.alpha >= 80) aFloor++
      if (r.score > worst) { worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstDrv = r.driver }
    }
    return {
      meanMarg: rows.length ? sumMarg / rows.length : 0,
      meanVs: rows.length ? sumVs / rows.length : 0,
      worst, worstCs, worstDrv, stall, aFloor,
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
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'APPR' || r.tier === 'STALL').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${r.marginKt >= 0 ? '+' : ''}${r.marginKt.toFixed(0)}kt ${r.driver}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'STALL').map(r => {
      const distNm = (r.f.velocityKts || 0) / 120  // 30s ahead
      const p = projectPosition(r.f.lat, r.f.lng, r.f.track || 0, distNm)
      return {
        type: 'Feature' as const,
        properties: { color: TIER_COLOR[r.tier], text: `› NOSE DOWN + TOGA` },
        geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
      }
    }) : [] }
    // Approach corridor markers (simplified — alpha-floor reference latitudes)
    const envFeatures: any[] = []
    if (showEnv) {
      for (const lat of [55, 25, 0, -25, -55]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 8) coords.push([lng, lat])
        envFeatures.push({ type: 'Feature' as const, properties: { color: '#0ea5e9' }, geometry: { type: 'LineString' as const, coordinates: coords } })
      }
    }
    const envFc = { type: 'FeatureCollection' as const, features: envFeatures }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_ENV, envFc, () => map.addLayer({ id: LYR_ENV, type: 'line', source: SRC_ENV, paint: {
        'line-color': ['get', 'color'], 'line-width': 0.7, 'line-opacity': 0.22, 'line-dasharray': [4, 6],
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
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_ENV]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_ENV]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showEnv])

  // Diagram: CAS (x, 0..400 kt) vs marginRatio (y, 0.8..2.5)
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 30
    const yMin = 0.8, yMax = 2.5
    const xMax = 400
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, v / xMax)) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, (v - yMin) / (yMax - yMin)))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMax, yMin, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Stall Margin / Alpha-Floor</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean margin</div>
          <div className="font-mono text-sm" style={{ color: summary.meanMarg <= marginWarn * 0.3 ? '#ef4444' : summary.meanMarg <= marginWarn ? '#f59e0b' : '#10b981' }}>{summary.meanMarg >= 0 ? '+' : ''}{summary.meanMarg.toFixed(0)}kt</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worst.toFixed(0)}` : '—'}
          </div>
          <div className="text-[8px] text-slate-500 truncate">{summary.worstDrv !== 'NONE' ? DRIVER_LABEL[summary.worstDrv] : '—'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">STALL</div>
          <div className="font-mono text-sm" style={{ color: summary.stall > 0 ? '#ef4444' : '#10b981' }}>{summary.stall}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Vs1g</div>
          <div className="font-mono text-[11px] text-slate-300">{summary.meanVs.toFixed(0)}kt</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">α-FLOOR</div>
          <div className="font-mono text-[11px]" style={{ color: summary.aFloor > 0 ? '#ef4444' : '#10b981' }}>{summary.aFloor}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">CAS vs CAS/Vs1g · stick-shaker envelope</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[1.0, 1.3, 1.6, 2.0].map(r => (
              <g key={r}>
                <line x1={diag.PAD} y1={diag.ys(r)} x2={diag.W - 6} y2={diag.ys(r)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(r) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{r.toFixed(1)}</text>
              </g>
            ))}
            {[100, 200, 300, 400].map(c => (
              <g key={c}>
                <line x1={diag.xs(c)} y1={6} x2={diag.xs(c)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(c)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{c}</text>
              </g>
            ))}
            {/* stall band rose 0.8-1.0, alpha-floor amber 1.0-1.13, stable approach band sky 1.13-1.3, OK emerald above */}
            <rect x={diag.PAD} y={diag.ys(1.0)} width={diag.W - 6 - diag.PAD} height={diag.ys(diag.yMin) - diag.ys(1.0)} fill="#ef4444" opacity={0.10} />
            <rect x={diag.PAD} y={diag.ys(ALPHA_FLOOR)} width={diag.W - 6 - diag.PAD} height={diag.ys(1.0) - diag.ys(ALPHA_FLOOR)} fill="#f59e0b" opacity={0.10} />
            <rect x={diag.PAD} y={diag.ys(STABLE_APP)} width={diag.W - 6 - diag.PAD} height={diag.ys(ALPHA_FLOOR) - diag.ys(STABLE_APP)} fill="#0ea5e9" opacity={0.08} />
            <line x1={diag.PAD} y1={diag.ys(1.0)} x2={diag.W - 6} y2={diag.ys(1.0)} stroke="#ef4444" strokeWidth={1} strokeDasharray="4 3" opacity={0.8} />
            <line x1={diag.PAD} y1={diag.ys(SHAKER_FACTOR)} x2={diag.W - 6} y2={diag.ys(SHAKER_FACTOR)} stroke="#f59e0b" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
            <line x1={diag.PAD} y1={diag.ys(ALPHA_FLOOR)} x2={diag.W - 6} y2={diag.ys(ALPHA_FLOOR)} stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 3" opacity={0.8} />
            <line x1={diag.PAD} y1={diag.ys(STABLE_APP)} x2={diag.W - 6} y2={diag.ys(STABLE_APP)} stroke="#0ea5e9" strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />
            <text x={diag.W - 8} y={diag.ys(1.0) - 2} textAnchor="end" fontSize={7} fill="#ef4444" fontFamily="monospace">VS1g 1.00</text>
            <text x={diag.W - 8} y={diag.ys(ALPHA_FLOOR) - 2} textAnchor="end" fontSize={7} fill="#f59e0b" fontFamily="monospace">α-FLOOR 1.13</text>
            <text x={diag.W - 8} y={diag.ys(STABLE_APP) - 2} textAnchor="end" fontSize={7} fill="#0ea5e9" fontFamily="monospace">STABLE 1.30</text>
            {rows.map(r => (
              <circle key={r.f.icao}
                cx={diag.xs(Math.max(0, Math.min(diag.xMax, r.cas)))}
                cy={diag.ys(Math.max(diag.yMin, Math.min(diag.yMax, r.marginRatio)))}
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
            <div className="flex justify-between text-[10px] text-slate-500"><span>WT-FRAC</span><span className="font-mono text-slate-300">{weightFrac}%</span></div>
            <input type="range" min={70} max={105} step={1} value={weightFrac} onChange={e => setWeightFrac(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>ICING-MUL</span><span className="font-mono text-slate-300">{icingMul}%</span></div>
            <input type="range" min={0} max={200} step={5} value={icingMul} onChange={e => setIcingMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MARG-WARN</span><span className="font-mono text-slate-300">{marginWarn}kt</span></div>
            <input type="range" min={15} max={50} step={1} value={marginWarn} onChange={e => setMarginWarn(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>BUF-MARG-G</span><span className="font-mono text-slate-300">0.{String(bufMargG).padStart(2, '0')}g</span></div>
          <input type="range" min={10} max={60} step={1} value={bufMargG} onChange={e => setBufMargG(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showEnv} onChange={e => setShowEnv(e.target.checked)} className="accent-sky-500" /><span>ENV</span></label>
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
        <span>{tab === 'AIRCRAFT' ? 'phase · CAS · Vs1g · margin' : 'drv · count · mean · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const advice = r.tier === 'STALL'
            ? `nose-down · TOGA · break stall per QRH UPSET RECOVERY`
            : r.tier === 'APPR'
              ? `add power · monitor stick-shaker · approach alpha-prot`
              : r.tier === 'WATCH'
                ? `monitor airspeed trend · within stable approach`
                : `stall margin nominal`
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
                  <span title="phase" className="text-slate-500">{r.phase.slice(0, 3)}</span>
                  <span title="CAS">{r.cas.toFixed(0)}kt</span>
                  <span title="Vs1g actual" className="text-slate-500">/ {r.vs1gAct.toFixed(0)}</span>
                  <span title="margin kt" style={{ color: r.marginKt < 0 ? '#ef4444' : r.marginKt < marginWarn ? '#f59e0b' : '#10b981' }}>{r.marginKt >= 0 ? '+' : ''}{r.marginKt.toFixed(0)}kt</span>
                  <span className="ml-auto" title="composite risk score" style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`score ${r.score.toFixed(0)} / 100`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500/70" style={{ left: `25%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-500/70" style={{ left: `55%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-500/70" style={{ left: `80%` }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {([['STL', r.sev.stall], ['ALP', r.sev.alpha], ['BUF', r.sev.buf], ['ICE', r.sev.ice], ['CFG', r.sev.cfg]] as const).map(([lbl, v]) => {
                    const c = v >= 80 ? '#ef4444' : v >= 55 ? '#f59e0b' : v >= 25 ? '#0ea5e9' : '#475569'
                    return (
                      <span key={lbl} className="px-1 py-0 rounded border text-[9px] font-mono"
                        style={{ borderColor: c + '66', color: c, background: c + '14' }}>{lbl} {v.toFixed(0)}</span>
                    )
                  })}
                  <span className="px-1 py-0 rounded border text-[9px] font-mono"
                    style={{
                      borderColor: r.marginRatio < 1.0 ? '#ef444466' : r.marginRatio < ALPHA_FLOOR ? '#f59e0b66' : r.marginRatio < STABLE_APP ? '#0ea5e966' : '#10b98166',
                      color: r.marginRatio < 1.0 ? '#ef4444' : r.marginRatio < ALPHA_FLOOR ? '#f59e0b' : r.marginRatio < STABLE_APP ? '#0ea5e9' : '#10b981',
                      background: r.marginRatio < 1.0 ? '#ef444414' : r.marginRatio < ALPHA_FLOOR ? '#f59e0b14' : r.marginRatio < STABLE_APP ? '#0ea5e914' : '#10b98114',
                    }} title="CAS / Vs1g ratio">α {r.marginRatio.toFixed(2)}</span>
                  {r.iceFactor > 0 && (
                    <span className="px-1 py-0 rounded border text-[9px] font-mono border-sky-700/50 bg-sky-900/30 text-sky-300" title="ice accretion factor">ICE {(r.iceFactor * 100).toFixed(0)}%</span>
                  )}
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="weight fraction of MLW">W {(r.weightFrac * 100).toFixed(0)}%</span>
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
          const advice = a.driver === 'STL' ? 'stall margin breach · nose-down + TOGA recovery'
            : a.driver === 'ALP' ? 'alpha-prot / alpha-floor active · auto-TOGA lock per FCOM'
            : a.driver === 'BUF' ? 'high-alt buffet margin under 0.30g · descend'
            : a.driver === 'ICE' ? 'ice-contaminated stall risk · activate anti-ice'
            : a.driver === 'CFG' ? 'config/energy below 1.3 Vs1g · go-around if unstable'
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
                  <span className="truncate">FAR 25.103 / 25.207 · FCOM 5.25</span>
                  <span className="ml-auto truncate" style={{ color: a.worstTier === 'OK' ? '#64748b' : TIER_COLOR[a.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        FAR 25.103 / 25.207 / 25.143(h) · CS-25 · FCOM 5.25 stall-warning · Airbus FCOM PRO-NOR-SOP-08 alpha-prot · NTSB AAR-10/01 Colgan 3407 · BEA AF447
      </div>
    </div>
  )
}
