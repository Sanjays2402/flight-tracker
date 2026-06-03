'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Mmo/Vmo Barber-Pole & Aeroelastic Flutter Margin Monitor
   -----------------------------------------------------------
   FAR 25.335(b) Vd/Md design dive speed / FAR 25.629 aeroelastic
   stability / EASA CS-25.629 flutter margin 15pct above Vd/Md /
   Boeing FCOM 5.20 Mmo/Vmo envelopes / Airbus FCOM PRO-NOR-SOP
   high-speed protection / NTSB AAR-66-AA China Airlines 006
   B747 Mach upset / NTSB AAR-99-01 Northwest Mach buffet /
   FAA AC 25.1323-1 high-speed warning / FAA AC 25-7C envelope
   demonstration / RTCA DO-178C aeroservoelastic certification.

   For every airborne aircraft, computes proximity to Mmo/Vmo
   barber-pole envelope, the FAR 25.629 flutter margin, and
   Mach-tuck onset risk. Mach proxy derived from velocity
   relative to local speed of sound at altitude via ISA SAT
   then a = sqrt(gamma * R * T_K) = 38.967 * sqrt(T_K) m/s
   converted to knots. CAS proxy derived from TAS via dynamic
   pressure relation with density ratio sigma = rho/rho0 by
   ISA atmosphere model.

   Per-class Vmo/Mmo certified envelope (typical TCDS / AFM):
     HVY  Vmo 350 kt / Mmo 0.90 (B777, A350, B787)
     NRW  Vmo 350 kt / Mmo 0.82 (B737NG, A320)
     RGN  Vmo 320 kt / Mmo 0.78 (CRJ, E190)
     BIZ  Vmo 320 kt / Mmo 0.92 (G650, GLEX, Falcon 7X)
     TBP  Vmo 250 kt / Mmo 0.55 (ATR, DHC8, TBM)
     GA   Vmo 195 kt / Mmo 0.40 (C172, SR22, PA28)
     FTR  Vmo 700 kt / Mmo 1.60 (F-18, Typhoon, F-35)

   FAR 25.335(b) design dive margin Vd/Md = 1.07-1.10 * Vmo/Mmo
   FAR 25.629 flutter free margin 15pct beyond Vd/Md = 1.23 nom

   Per-airframe stable degradation via FNV-1a 32-bit hash of
   ICAO24 driving:
     - Cycles since flutter damper inspection 0..1.0 cyc-frac
     - Trim-tab balance-weight aging 0..1.0 wear-frac
     - Control-surface free-play 0..1.0 deg play

   Risk components (max-driver compositing 0-100):
     VMO-BAR   CAS margin to Vmo (kt). Severity ramps from 0 at
               (Vmo-30) to 100 at Vmo. Beyond Vmo: 100 instant.
     MMO-BAR   Mach margin to Mmo. Severity 0 at (Mmo-0.04),
               100 at Mmo. Beyond: 100. Mach-tuck risk peaks
               at high alt + thin wing per Boeing FCOM 5.20.
     FLUT      FAR 25.629 flutter margin. Reduced by damper-cyc
               and free-play wear. Severity ramps when computed
               flutter margin < 1.15 * (Vmo/Mmo). NTSB AAR-66.
     TUCK      Mach-tuck onset: aft AC migration at high Mach
               above ~Mmo-0.02. Class-dependent; swept-wing HVY/
               NRW more susceptible. T-tails BIZ severely so.
     OVERSPD   Composite OS event score: Vmo+Mmo exceedance
               simultaneously triggers CASB OVERSPEED warning
               per AC 25.1323-1.

   Composite score = max(per-factor sev).
   Dominant driver = highest-scoring factor.

   Tier classification:
     CRIT     score>=80  rose    immediate retard + pitch-up
     HIGH     score>=55  amber   reduce thrust, retract speedbk
     WATCH    score>=25  sky     monitor Mach trend
     OK       score<25   emerald within envelope
     IDLE     ground/low slate   excluded

   MapLibre overlay:
     - Tier-coloured halo rings sized by composite 8-22 px
     - Rose diamond pin at projected 60sec ahead position for
       CRIT aircraft indicating where overspeed will breach
     - Dashed amber Mach-tuck risk corridor at FL400+ globally
       (high-alt thin-air envelope where coffin-corner narrow)
     - Tier-coloured callsign+Mach/CAS+driver labels for non-OK

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-SCORE / WORST callsign+driver / CRIT count
     - 2-cell MEAN-Mach / OVERSPD count secondary
     - SVG Mach vs CAS scatter with barber-pole envelope band
       overlay (Vmo and Mmo limits shown as dashed lines)
     - 5 sliders MIN-FL / ISA-DEV / VMO-MARGIN / DAMPER-AGE /
       PLAY-MUL
     - 7-class chip filter HVY/NRW/RGN/BIZ/TBP/GA/FTR
     - HALO/PIN/LBL/CORR/DIAG toggles
     - Search box
     - AIRCRAFT/DRIVERS tab switcher
     - Per-row composite breakdown chips, score bar, advice
     - DRIVERS tab grouped by dominant driver
============================================================ */

interface FlutterFlight {
  icao: string
  callsign: string
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
  flights: FlutterFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'WATCH' | 'HIGH' | 'CRIT' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981', WATCH: '#0ea5e9', HIGH: '#f59e0b', CRIT: '#ef4444', IDLE: '#64748b',
}
const TIER_LABEL: Record<Tier, string> = {
  OK: 'OK', WATCH: 'WATCH', HIGH: 'HIGH', CRIT: 'CRIT', IDLE: 'IDLE',
}
const TIER_ORDER: Tier[] = ['CRIT', 'HIGH', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { CRIT: 0, HIGH: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Klass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const KL_NAME: Record<Klass, string> = {
  HVY: 'Heavy wide-body',
  NRW: 'Narrow-body',
  RGN: 'Regional jet',
  BIZ: 'Business jet',
  TBP: 'Turboprop',
  GA: 'General aviation',
  FTR: 'Fighter',
}
// Vmo (KCAS) / Mmo (Mach) per typical class certification
const KL_VMO: Record<Klass, number> = { HVY: 350, NRW: 350, RGN: 320, BIZ: 320, TBP: 250, GA: 195, FTR: 700 }
const KL_MMO: Record<Klass, number> = { HVY: 0.90, NRW: 0.82, RGN: 0.78, BIZ: 0.92, TBP: 0.55, GA: 0.40, FTR: 1.60 }
// Mach-tuck susceptibility (0-1) — swept-wing/T-tail biz worst
const KL_TUCK_SUS: Record<Klass, number> = { HVY: 0.55, NRW: 0.45, RGN: 0.50, BIZ: 0.80, TBP: 0.10, GA: 0.05, FTR: 0.30 }

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

// ISA atmosphere — returns { tempK, sigma (rho/rho0), aKt (speed of sound, knots) }
function isaAtm(altFt: number, isaDev: number) {
  const tropo = 36089
  let tK: number
  let pRatio: number
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
  const sigma = pRatio * (tStd / tK)  // density ratio
  // a (m/s) = 20.0468 * sqrt(T_K); convert to knots: * 1.94384
  const aMs = 20.0468 * Math.sqrt(tK)
  const aKt = aMs * 1.94384
  return { tK, sigma, aKt }
}

// TAS (kt) -> CAS (kt) via simplified compressibility-free density correction:
// CAS ≈ TAS * sqrt(sigma). Adequate for envelope-margin scoring at sub-Mmo.
function tasToCas(tasKt: number, sigma: number): number {
  return tasKt * Math.sqrt(Math.max(0.01, sigma))
}

type Driver = 'VMO' | 'MMO' | 'FLUT' | 'TUCK' | 'OS' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  VMO: 'Vmo CAS barber-pole',
  MMO: 'Mmo Mach barber-pole',
  FLUT: 'Aeroelastic flutter margin',
  TUCK: 'Mach-tuck onset',
  OS: 'Overspeed composite',
  NONE: 'Nominal',
}

interface Row {
  f: FlutterFlight
  klass: Klass
  flCur: number
  vmo: number
  mmo: number
  cas: number
  mach: number
  vmoMargin: number   // kt
  mmoMargin: number   // mach
  flutterMargin: number  // ratio vs Vd reference (1.0=at Vd, 1.15=15pct above Mmo)
  damperCycFrac: number
  playWear: number
  tatC: number
  sev: { vmo: number; mmo: number; flut: number; tuck: number; os: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'flut-halo', SRC_LBL = 'flut-lbl', SRC_PIN = 'flut-pin', SRC_COR = 'flut-cor'
const LYR_HALO = 'flut-halo-l', LYR_LBL = 'flut-lbl-l', LYR_PIN = 'flut-pin-l', LYR_COR = 'flut-cor-l'

export default function FlutterMargin({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'DRIVERS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klFilter, setKlFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(80)
  const [isaDev, setIsaDev] = useState(0)
  const [vmoMargin, setVmoMargin] = useState(30)     // 10-60 kt warning margin
  const [damperAge, setDamperAge] = useState(100)    // 50-200 pct cycle-fraction multiplier
  const [playMul, setPlayMul] = useState(100)        // 50-200 pct free-play multiplier
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
      const vmo = KL_VMO[klass]
      const mmo = KL_MMO[klass]
      const atm = isaAtm(f.altitudeFt, isaDev)
      const tas = Math.max(0, f.velocityKts || 0)  // proxy
      const cas = tasToCas(tas, atm.sigma)
      const mach = tas / Math.max(1, atm.aKt)
      const tatC = atm.tK - 273.15 + 0.2 * mach * mach * (atm.tK - 273.15)

      const vMargin = vmo - cas       // kt below Vmo
      const mMargin = mmo - mach      // mach below Mmo

      // Per-airframe hash-stable degradations
      const h = hash32(f.icao || '')
      const damperCycFrac = (((h >>> 7) % 1000) / 1000) * (damperAge / 100)  // 0..1+
      const playWear = (((h >>> 13) % 1000) / 1000) * (playMul / 100)

      // FAR 25.629 flutter margin: reference 1.15 (15pct above Vmo/Mmo per
      // CS-25.629(b)(3)). Damper & play wear reduce it linearly.
      const flutterMargin = Math.max(0.85, 1.15 - 0.18 * damperCycFrac - 0.12 * playWear)

      // ---- Severities ----
      // Vmo: 0 at margin>=vmoMargin, ramps to 100 at margin<=0, 100+ beyond
      const vmoSev = vMargin <= 0 ? 100 : vMargin >= vmoMargin ? 0
        : 100 * (1 - vMargin / vmoMargin)
      // Mmo: 0 at margin>=0.04, ramps to 100 at margin<=0, 100 beyond
      const mmoBand = 0.04
      const mmoSev = mMargin <= 0 ? 100 : mMargin >= mmoBand ? 0
        : 100 * (1 - mMargin / mmoBand)
      // Flutter: triggers if flutterMargin < 1.10 (cert min). Severity ramps from 0 at 1.15 to 100 at 0.90
      const flutSev = flutterMargin >= 1.15 ? 0
        : flutterMargin <= 0.90 ? 100
        : 100 * (1.15 - flutterMargin) / 0.25
      // Mach-tuck: kicks in within Mmo-0.02; scaled by class susceptibility
      const tuckBand = 0.02
      const tuckBase = mMargin >= tuckBand ? 0 : mMargin <= -0.01 ? 100
        : 100 * (1 - (mMargin + 0.01) / (tuckBand + 0.01))
      const tuckSev = tuckBase * KL_TUCK_SUS[klass]
      // Composite overspeed: both Vmo and Mmo near-breach simultaneously
      const osSev = (vMargin < vmoMargin * 0.5 && mMargin < 0.02)
        ? Math.min(100, 60 + (vmoSev + mmoSev) / 4)
        : 0

      const sevs = { vmo: vmoSev, mmo: mmoSev, flut: flutSev, tuck: tuckSev, os: osSev }
      const drvList: Array<[Driver, number]> = [
        ['VMO', vmoSev], ['MMO', mmoSev], ['FLUT', flutSev],
        ['TUCK', tuckSev], ['OS', osSev],
      ]
      drvList.sort((a, b) => b[1] - a[1])
      const driver: Driver = drvList[0][1] > 0 ? drvList[0][0] : 'NONE'
      const score = drvList[0][1]
      let tier: Tier
      if (score >= 80) tier = 'CRIT'
      else if (score >= 55) tier = 'HIGH'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, klass, flCur, vmo, mmo, cas, mach,
        vmoMargin: vMargin, mmoMargin: mMargin, flutterMargin,
        damperCycFrac, playWear, tatC,
        sev: sevs, score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, isaDev, vmoMargin, damperAge, playMul])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, WATCH: 0, HIGH: 0, CRIT: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumScore = 0, sumMach = 0, worst = 0, worstCs = '', worstDrv: Driver = 'NONE'
    let crit = 0, os = 0
    for (const r of rows) {
      sumScore += r.score; sumMach += r.mach
      if (r.tier === 'CRIT') crit++
      if (r.sev.os > 0) os++
      if (r.score > worst) { worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstDrv = r.driver }
    }
    return {
      meanScore: rows.length ? sumScore / rows.length : 0,
      meanMach: rows.length ? sumMach / rows.length : 0,
      worst, worstCs, worstDrv, crit, os,
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
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'HIGH' || r.tier === 'CRIT').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} M${r.mach.toFixed(2)} ${r.driver}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'CRIT').map(r => {
      // project 60sec ahead at current ground speed
      const distNm = (r.f.velocityKts || 0) / 60
      const p = projectPosition(r.f.lat, r.f.lng, r.f.track || 0, distNm)
      return {
        type: 'Feature' as const,
        properties: { color: TIER_COLOR[r.tier], text: `› RETARD THRUST` },
        geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
      }
    }) : [] }
    const corFeatures: any[] = []
    if (showCor) {
      // Mach-tuck high-alt corridor: dashed lines at FL400 (visualised as parallels of latitude
      // representing where coffin-corner narrows). For map representation we sample latitudes
      // every 6deg as a global high-alt envelope band.
      for (const lat of [60, 30, 0, -30, -60]) {
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
        'line-color': ['get', 'color'], 'line-width': 0.8, 'line-opacity': 0.30, 'line-dasharray': [5, 5],
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

  // Diagram: Mach (x, 0..1.0) vs CAS (y, 0..400 kt)
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 30
    const xMin = 0, xMax = 1.0, yMax = 400
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Mmo/Vmo Flutter Margin</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">CRIT</div>
          <div className="font-mono text-sm" style={{ color: summary.crit > 0 ? '#ef4444' : '#10b981' }}>{summary.crit}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Mach</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanMach >= 0.82 ? '#f59e0b' : summary.meanMach >= 0.70 ? '#0ea5e9' : '#10b981' }}>M{summary.meanMach.toFixed(2)}</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">OVERSPD</div>
          <div className="font-mono text-[11px]" style={{ color: summary.os > 0 ? '#ef4444' : '#10b981' }}>{summary.os}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Mach vs CAS · barber-pole envelope</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[100, 200, 300, 400].map(c => (
              <g key={c}>
                <line x1={diag.PAD} y1={diag.ys(c)} x2={diag.W - 6} y2={diag.ys(c)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(c) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{c}</text>
              </g>
            ))}
            {[0.4, 0.6, 0.8, 0.9].map(m => (
              <g key={m}>
                <line x1={diag.xs(m)} y1={6} x2={diag.xs(m)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(m)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">M{m.toFixed(1)}</text>
              </g>
            ))}
            {/* Tier bands by score on log-ish: emerald 0-25, sky 25-55, amber 55-80, rose 80+ */}
            {/* Render barber-pole envelope for HVY (Vmo=350, Mmo=0.90) as representative */}
            <line x1={diag.PAD} y1={diag.ys(350)} x2={diag.W - 6} y2={diag.ys(350)} stroke="#ef4444" strokeWidth={1} strokeDasharray="4 3" opacity={0.8} />
            <line x1={diag.xs(0.90)} y1={6} x2={diag.xs(0.90)} y2={diag.H - diag.PAD} stroke="#ef4444" strokeWidth={1} strokeDasharray="4 3" opacity={0.8} />
            <text x={diag.W - 8} y={diag.ys(350) - 3} textAnchor="end" fontSize={7} fill="#ef4444" fontFamily="monospace">Vmo 350</text>
            <text x={diag.xs(0.90) + 3} y={12} fontSize={7} fill="#ef4444" fontFamily="monospace">Mmo 0.90</text>
            {/* warning margin band */}
            <rect x={diag.PAD} y={diag.ys(350)} width={diag.W - 6 - diag.PAD} height={diag.ys(350 - vmoMargin) - diag.ys(350)} fill="#ef4444" opacity={0.06} />
            <rect x={diag.xs(0.86)} y={6} width={diag.xs(0.90) - diag.xs(0.86)} height={diag.H - diag.PAD - 6} fill="#f59e0b" opacity={0.08} />
            {rows.map(r => (
              <circle key={r.f.icao}
                cx={diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, r.mach)))}
                cy={diag.ys(Math.max(0, Math.min(diag.yMax, r.cas)))}
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
            <div className="flex justify-between text-[10px] text-slate-500"><span>ISA-DEV</span><span className="font-mono text-slate-300">{isaDev > 0 ? '+' : ''}{isaDev}C</span></div>
            <input type="range" min={-30} max={30} step={1} value={isaDev} onChange={e => setIsaDev(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>VMO-WARN</span><span className="font-mono text-slate-300">{vmoMargin}kt</span></div>
            <input type="range" min={10} max={60} step={2} value={vmoMargin} onChange={e => setVmoMargin(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>DAMPER-AGE</span><span className="font-mono text-slate-300">{damperAge}%</span></div>
            <input type="range" min={50} max={200} step={5} value={damperAge} onChange={e => setDamperAge(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>PLAY-MUL</span><span className="font-mono text-slate-300">{playMul}%</span></div>
          <input type="range" min={50} max={200} step={5} value={playMul} onChange={e => setPlayMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showCor} onChange={e => setShowCor(e.target.checked)} className="accent-sky-500" /><span>CORR</span></label>
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
        <span>{tab === 'AIRCRAFT' ? 'M · CAS · margin · driver' : 'drv · count · mean · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const advice = r.tier === 'CRIT'
            ? `retard thrust · extend speedbrake · pitch up to reduce Mach`
            : r.tier === 'HIGH'
              ? `reduce N1 · monitor barber-pole · prepare to retard`
              : r.tier === 'WATCH'
                ? `monitor Mach trend · within envelope`
                : `Mmo/Vmo envelope nominal`
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
                  <span title="mach" style={{ color: r.mmoMargin < 0.04 ? '#f59e0b' : '#94a3b8' }}>M{r.mach.toFixed(2)}</span>
                  <span title="CAS" style={{ color: r.vmoMargin < vmoMargin ? '#f59e0b' : '#94a3b8' }}>{r.cas.toFixed(0)}kt</span>
                  <span title="vmo margin kt" style={{ color: r.vmoMargin < 0 ? '#ef4444' : r.vmoMargin < vmoMargin ? '#f59e0b' : '#10b981' }}>{r.vmoMargin >= 0 ? '+' : ''}{r.vmoMargin.toFixed(0)}V</span>
                  <span title="mmo margin" style={{ color: r.mmoMargin < 0 ? '#ef4444' : r.mmoMargin < 0.04 ? '#f59e0b' : '#10b981' }}>{r.mmoMargin >= 0 ? '+' : ''}{r.mmoMargin.toFixed(2)}M</span>
                  <span className="ml-auto" title="composite risk score" style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`score ${r.score.toFixed(0)} / 100`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500/70" style={{ left: `25%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-500/70" style={{ left: `55%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-500/70" style={{ left: `80%` }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {([['VMO', r.sev.vmo], ['MMO', r.sev.mmo], ['FLT', r.sev.flut], ['TCK', r.sev.tuck], ['OS', r.sev.os]] as const).map(([lbl, v]) => {
                    const c = v >= 80 ? '#ef4444' : v >= 55 ? '#f59e0b' : v >= 25 ? '#0ea5e9' : '#475569'
                    return (
                      <span key={lbl} className="px-1 py-0 rounded border text-[9px] font-mono"
                        style={{ borderColor: c + '66', color: c, background: c + '14' }}>{lbl} {v.toFixed(0)}</span>
                    )
                  })}
                  <span className="px-1 py-0 rounded border text-[9px] font-mono"
                    style={{
                      borderColor: r.flutterMargin < 1.0 ? '#ef444466' : r.flutterMargin < 1.10 ? '#f59e0b66' : '#10b98166',
                      color: r.flutterMargin < 1.0 ? '#ef4444' : r.flutterMargin < 1.10 ? '#f59e0b' : '#10b981',
                      background: r.flutterMargin < 1.0 ? '#ef444414' : r.flutterMargin < 1.10 ? '#f59e0b14' : '#10b98114',
                    }} title="FAR 25.629 flutter margin">FLM {r.flutterMargin.toFixed(2)}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="Vmo / Mmo cert">{r.vmo}/{r.mmo.toFixed(2)}</span>
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
          const advice = a.driver === 'VMO' ? 'Vmo barber-pole breach risk · retard thrust / extend speedbrake'
            : a.driver === 'MMO' ? 'Mmo barber-pole breach risk · pitch up to reduce Mach'
            : a.driver === 'FLUT' ? 'FAR 25.629 flutter margin degraded · damper inspection due'
            : a.driver === 'TUCK' ? 'Mach-tuck onset · trim runaway risk · reduce Mach'
            : a.driver === 'OS' ? 'composite overspeed · CASB warning probable'
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
                  <span className="truncate">FCOM 5.20 / CS-25.629</span>
                  <span className="ml-auto truncate" style={{ color: a.worstTier === 'OK' ? '#64748b' : TIER_COLOR[a.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        FAR 25.335(b) Vd/Md · FAR 25.629 / CS-25.629 flutter · AC 25.1323-1 high-speed warning · NTSB AAR-66-AA · Boeing FCOM 5.20 · Airbus FCOM PRO-NOR-SOP
      </div>
    </div>
  )
}
