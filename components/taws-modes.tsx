'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   EGPWS / TAWS Mode 1-7 Alert Predictor
   -----------------------------------------------------------
   RTCA DO-161A Minimum Performance Standards GPWS / RTCA DO-367
   TAWS Class A & B / TSO-C151d / TSO-C92c / ICAO Annex 6
   Part I 6.15 / FAA AC 25-23 / FAA AC 23-18 / Honeywell EGPWS
   Pilot's Guide MK V / VII / Mode definitions per ARINC 762.

   For every airborne aircraft above MIN-FL, models per-airframe
   GPWS / EGPWS Mode 1-7 alert envelopes. The seven envelopes
   carried by every TAWS-Class-A computer (B737 MK-V, A320
   MK-VII, B777/787 MK-VIII, A330/A350 Honeywell MK-VIII):

     MODE 1  SINK RATE / PULLDOWN  excessive descent rate vs AGL
             RAD ALT >2500ft VS>5000fpm / 1000ft VS>2500fpm /
             50ft VS>1500fpm. PULL UP at outer caution boundary.
     MODE 2  EXCESSIVE CLOSURE RATE  rising terrain closure
             > envelope (2A retracted / 2B gear+flap landing).
             Hard PULL UP warning.
     MODE 3  DESCENT AFTER TAKEOFF  >10pct height loss after
             liftoff (TOFA window). DON'T SINK callout.
     MODE 4  UNSAFE TERRAIN CLEARANCE  AGL low not in landing
             config (4A gear up / 4B gear down flap up /
             4C terrain rising into envelope on departure).
             TOO LOW TERRAIN / TOO LOW GEAR / TOO LOW FLAPS.
     MODE 5  BELOW GLIDESLOPE  ILS GS deviation >1.3 dots
             below path RAD ALT 50-1000ft. GLIDESLOPE
             callout (soft) escalates to hard alert.
     MODE 6  ADVISORY CALLOUTS  low-altitude awareness
             (BANK ANGLE, MINIMUMS, FIVE HUNDRED, RAD-ALT
             callouts 50/40/30/20/10ft, TCF Terrain Clearance
             Floor below ROC near runway).
     MODE 7  WINDSHEAR  reactive windshear detection low-alt
             (W band climb/descend, GS-vs-IAS divergence)
             plus Forward-Looking Windshear (predictive,
             radar-based).

   Plus EGPWS Look-Ahead Terrain Alerting (Mode-8 in some
   implementations) Forward Caution 60s / Forward Warning 30s
   look-ahead at current GS+VS predicting terrain conflict.

   For each airborne aircraft we infer phase, AGL proxy
   (altitudeFt with hash-stable elevation bias 0-1500ft AGL
   for low phases), terrain-closure-rate (rising terrain
   ahead), and configuration (gear/flap proxy by phase),
   then compute per-mode severity 0-100. Composite = max.

   Composite tiers:
     PULL-UP  score>=80  rose    Mode 1/2/4 hard warning
     CAUTION  score>=55  amber   Mode 3/5 / Mode 1 outer
     WATCH    score>=25  sky     Mode 6/7 advisory
     OK       score<25   emerald envelope clear
     IDLE     above MIN-FL slate (cruise)

   MapLibre overlay:
     - Tier-coloured halo rings sized by score 8-22 px
     - Rose 60s look-ahead terrain projection ahead-track line
     - Amber dashed RAD-ALT 1000ft / 500ft / 200ft warning
       envelope reference parallels
     - Tier-coloured callsign + mode + AGL labels

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-AGL / WORST callsign+mode / PULL-UP-count
     - 2-cell MEAN-VS / LOOK-AHEAD-COUNT secondary
     - SVG VS vs AGL scatter with Mode-1 envelope curves
     - 5 sliders MIN-FL / ELEV-BIAS / TERRAIN-MUL / GS-MARG / LA-WIN
     - 7-mode chip filter M1..M7
     - HALO / LBL / LA / REF / DIAG toggles + search
     - AIRCRAFT / MODES tab switcher
     - Per-row mode chips, score bar, advice
     - MODES tab grouped by Mode 1-7 with worst aircraft

   Persisted: ft-taws
   ============================================================ */

export interface TawsFlight {
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
  flights: TawsFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'PULL-UP' | 'CAUTION' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'PULL-UP': '#ef4444', CAUTION: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_LABEL: Record<Tier, string> = {
  'PULL-UP': 'PULL-UP', CAUTION: 'CAUTION', WATCH: 'WATCH', OK: 'OK', IDLE: 'IDLE',
}
const TIER_ORDER: Tier[] = ['PULL-UP', 'CAUTION', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { 'PULL-UP': 0, CAUTION: 1, WATCH: 2, OK: 3, IDLE: 4 }

const MODES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'] as const
type Mode = (typeof MODES)[number]
const MODE_NAME: Record<Mode, string> = {
  M1: 'Sink Rate / Pull-Up',
  M2: 'Excessive Closure Rate',
  M3: 'Descent After T/O',
  M4: 'Unsafe Terrain Clearance',
  M5: 'Below Glideslope',
  M6: 'Advisory Callouts / TCF',
  M7: 'Windshear (Reactive + FLW)',
}
const MODE_CALLOUT: Record<Mode, string> = {
  M1: 'SINK RATE / PULL UP',
  M2: 'TERRAIN TERRAIN PULL UP',
  M3: "DON'T SINK",
  M4: 'TOO LOW TERRAIN / TOO LOW GEAR / TOO LOW FLAPS',
  M5: 'GLIDESLOPE',
  M6: 'BANK ANGLE / MINIMUMS / FIVE HUNDRED',
  M7: 'WINDSHEAR WINDSHEAR WINDSHEAR',
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

type Phase = 'TAKEOFF' | 'CLIMB' | 'CRUISE' | 'DESCENT' | 'APPR' | 'FLARE' | 'OTHER'
function inferPhase(altFt: number, vRate: number, gsKt: number): Phase {
  if (altFt < 600 && vRate < -100 && gsKt > 60) return 'FLARE'
  if (altFt < 1500 && vRate > 1000 && gsKt > 100) return 'TAKEOFF'
  if (altFt < 3000 && vRate < -300) return 'APPR'
  if (altFt < 12000 && vRate > 500) return 'CLIMB'
  if (altFt > 18000 && Math.abs(vRate) < 500) return 'CRUISE'
  if (vRate < -400) return 'DESCENT'
  return 'OTHER'
}

interface Row {
  f: TawsFlight
  phase: Phase
  flCur: number
  agl: number              // ft above ground level (proxy)
  rocFt: number            // required obstacle clearance floor
  vs: number               // fpm (=vertRate)
  gsKt: number
  gearDown: boolean
  flapsLanding: boolean
  closureFpm: number       // terrain closure rate fpm (rising terrain ahead)
  gsDevDots: number        // ILS glideslope deviation (dots, neg=below)
  bankDeg: number          // estimated bank
  windshearIdx: number     // 0..1 windshear probability proxy
  laTerrainSec: number     // seconds to look-ahead terrain conflict (Infinity = clear)
  sev: { m1: number; m2: number; m3: number; m4: number; m5: number; m6: number; m7: number }
  score: number
  driverMode: Mode | 'NONE'
  tier: Tier
}

const SRC_HALO = 'taws-halo', SRC_LBL = 'taws-lbl', SRC_LA = 'taws-la', SRC_REF = 'taws-ref'
const LYR_HALO = 'taws-halo-l', LYR_LBL = 'taws-lbl-l', LYR_LA = 'taws-la-l', LYR_REF = 'taws-ref-l'

export default function TawsModes({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'MODES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [modeFilter, setModeFilter] = useState<Mode | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(120)
  const [elevBias, setElevBias] = useState(100)     // pct of hash-derived terrain elevation
  const [terrainMul, setTerrainMul] = useState(100) // pct of closure-rate multiplier
  const [gsMarg, setGsMarg] = useState(13)          // GS deviation tolerance, 0.1 dots units
  const [laWin, setLaWin] = useState(60)            // look-ahead window seconds
  const [showHalo, setShowHalo] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showLa, setShowLa] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl || flCur > maxFl) continue
      const phase = inferPhase(f.altitudeFt, f.vertRate, f.velocityKts || 0)

      const h = hash32(f.icao || '')
      // Hash-stable terrain-elevation proxy 0..1500ft (low phases see real AGL pressure)
      const terrainElev = ((h >>> 3) % 1500) * (elevBias / 100)
      const agl = phase === 'CRUISE'
        ? f.altitudeFt - 1500
        : phase === 'DESCENT' || phase === 'CLIMB'
          ? Math.max(50, f.altitudeFt - terrainElev * 0.6)
          : Math.max(20, f.altitudeFt - terrainElev * 0.3)

      const vs = f.vertRate
      const gsKt = f.velocityKts || 0
      // ROC floor: TCF schedule near terminal area 700ft / enroute 1000ft (mountainous 2000)
      const isMtn = ((h >>> 7) % 100) < 22  // 22% of flights over mountainous terrain
      const rocFt = phase === 'APPR' || phase === 'FLARE' || phase === 'TAKEOFF' ? 200
        : isMtn ? 2000 : 1000

      // Configuration proxy
      const gearDown = phase === 'APPR' || phase === 'FLARE' || phase === 'TAKEOFF'
      const flapsLanding = phase === 'APPR' || phase === 'FLARE'

      // Terrain closure rate (rising terrain ahead) — hash-stable per airframe modulated by phase
      const baseClosure = (((h >>> 13) % 1000) / 1000) * 1600  // 0..1600 fpm
      const phaseMul = phase === 'CLIMB' ? 1.2 : phase === 'DESCENT' ? 1.4 : phase === 'APPR' ? 1.6 : phase === 'TAKEOFF' ? 1.5 : 0.4
      const closureFpm = isMtn ? baseClosure * phaseMul * (terrainMul / 100) : baseClosure * phaseMul * 0.35 * (terrainMul / 100)

      // Glideslope deviation (dots, neg below) — only meaningful on approach
      const gsDevDots = phase === 'APPR' || phase === 'FLARE'
        ? (((h >>> 19) % 1000) / 1000 - 0.45) * 3.2  // -1.44..+1.7 dots, biased low
        : 0
      // Bank angle proxy
      const bankDeg = Math.abs((((h >>> 23) % 100) / 100 - 0.5) * 50) + (phase === 'APPR' ? 5 : 0)
      // Windshear index: low-alt + hash + phase
      const wsBase = ((h >>> 17) % 1000) / 1000
      const windshearIdx = (phase === 'APPR' || phase === 'TAKEOFF' || phase === 'FLARE')
        ? wsBase * 0.9 + (agl < 1000 ? 0.15 : 0)
        : wsBase * 0.2

      // Look-ahead seconds to terrain conflict — if closing AGL via VS+closure
      const sinkRate = Math.max(0, -vs) + closureFpm  // fpm AGL erosion
      const laTerrainSec = sinkRate > 50 ? (agl / sinkRate) * 60 : Infinity

      /* ---------- Mode 1: Sink Rate (RAD-ALT vs VS envelope) ---------- */
      // Honeywell MK-V envelope: AGL 100ft VS>1500fpm caution / 2500fpm warning
      //                          AGL 1000ft VS>2500fpm caution / 5000fpm warning
      const sink = Math.max(0, -vs)
      let m1 = 0
      if (agl < 2500 && sink > 0) {
        const cautionVS = 1500 + (agl / 2500) * 1000   // 1500..2500 fpm
        const warnVS = 2500 + (agl / 2500) * 2500       // 2500..5000 fpm
        if (sink >= warnVS) m1 = 100
        else if (sink >= cautionVS) m1 = 55 + ((sink - cautionVS) / (warnVS - cautionVS)) * 45
        else if (sink >= cautionVS * 0.7) m1 = 25 + ((sink - cautionVS * 0.7) / (cautionVS * 0.3)) * 30
      }

      /* ---------- Mode 2: Excessive Closure Rate ---------- */
      // 2A (clean): AGL 200ft closure>2000fpm warn / 2B (landing): tighter
      let m2 = 0
      if (agl < 2200 && closureFpm > 500) {
        const envWarn = (gearDown && flapsLanding) ? 1700 : 2200
        const envCaut = envWarn * 0.65
        if (closureFpm >= envWarn) m2 = 100
        else if (closureFpm >= envCaut) m2 = 55 + ((closureFpm - envCaut) / (envWarn - envCaut)) * 45
        else if (closureFpm >= envCaut * 0.6) m2 = 25 + ((closureFpm - envCaut * 0.6) / (envCaut * 0.4)) * 30
      }

      /* ---------- Mode 3: Descent After Takeoff (DON'T SINK) ---------- */
      // Trigger only in TAKEOFF/initial climb if sink rate > +height-loss threshold
      let m3 = 0
      if (phase === 'TAKEOFF' && vs < -100) {
        const loss = Math.abs(vs)  // fpm proxy of height-loss rate
        if (loss >= 500) m3 = 100
        else if (loss >= 250) m3 = 55 + ((loss - 250) / 250) * 45
        else if (loss >= 100) m3 = 25 + ((loss - 100) / 150) * 30
      }

      /* ---------- Mode 4: Unsafe Terrain Clearance ---------- */
      // 4A gear up <500ft AGL / 4B gear down flap up <245ft / 4C departure rising
      let m4 = 0
      if (agl < 700) {
        if (!gearDown && agl < 500) {
          const sev = (500 - agl) / 500 * 100
          m4 = Math.max(m4, sev)
        }
        if (gearDown && !flapsLanding && agl < 245) {
          const sev = (245 - agl) / 245 * 100
          m4 = Math.max(m4, sev * 0.9)
        }
      }
      // 4C: rising terrain on departure
      if (phase === 'TAKEOFF' && closureFpm > 1200 && agl < 1500) {
        const sev = ((closureFpm - 1200) / 1500) * 70
        m4 = Math.max(m4, Math.min(95, sev))
      }

      /* ---------- Mode 5: Below Glideslope ---------- */
      let m5 = 0
      if ((phase === 'APPR' || phase === 'FLARE') && agl > 50 && agl < 1500) {
        const below = -gsDevDots  // positive when below path
        const dotsThresh = gsMarg / 10  // 1.3 dots default
        if (below > 0) {
          if (below >= dotsThresh + 1.0) m5 = 100
          else if (below >= dotsThresh) m5 = 55 + ((below - dotsThresh) / 1.0) * 45
          else if (below >= dotsThresh * 0.7) m5 = 25 + ((below - dotsThresh * 0.7) / (dotsThresh * 0.3)) * 30
        }
      }

      /* ---------- Mode 6: Advisory Callouts + TCF ---------- */
      let m6 = 0
      // Bank angle: > 35 deg low-alt (< 1000ft) = warn
      if (agl < 1000) {
        if (bankDeg > 35) m6 = Math.max(m6, Math.min(80, (bankDeg - 35) * 4))
        else if (bankDeg > 25) m6 = Math.max(m6, 25 + (bankDeg - 25) * 3)
      }
      // TCF: below ROC floor
      if (agl < rocFt && phase !== 'APPR' && phase !== 'FLARE' && phase !== 'TAKEOFF') {
        const sev = ((rocFt - agl) / rocFt) * 90
        m6 = Math.max(m6, Math.min(95, sev))
      }
      // Rad-alt callouts (advisory only, low severity)
      if (agl > 0 && agl < 50 && phase === 'FLARE') m6 = Math.max(m6, 25)

      /* ---------- Mode 7: Windshear (Reactive + Forward-Looking) ---------- */
      let m7 = 0
      if ((phase === 'APPR' || phase === 'TAKEOFF' || phase === 'FLARE') && agl < 2500) {
        const idx = windshearIdx
        if (idx >= 0.85) m7 = 100
        else if (idx >= 0.65) m7 = 55 + (idx - 0.65) / 0.20 * 45
        else if (idx >= 0.45) m7 = 25 + (idx - 0.45) / 0.20 * 30
      }

      const sevs = { m1, m2, m3, m4, m5, m6, m7 }
      // Look-ahead override (predictive terrain alert)
      if (laTerrainSec < 30) sevs.m2 = Math.max(sevs.m2, 90)
      else if (laTerrainSec < laWin) sevs.m2 = Math.max(sevs.m2, 55 + (laWin - laTerrainSec) / (laWin - 30) * 30)

      const drvList: Array<[Mode, number]> = [
        ['M1', sevs.m1], ['M2', sevs.m2], ['M3', sevs.m3], ['M4', sevs.m4],
        ['M5', sevs.m5], ['M6', sevs.m6], ['M7', sevs.m7],
      ]
      drvList.sort((a, b) => b[1] - a[1])
      const driverMode: Mode | 'NONE' = drvList[0][1] > 0 ? drvList[0][0] : 'NONE'
      const score = drvList[0][1]
      let tier: Tier
      if (score >= 80) tier = 'PULL-UP'
      else if (score >= 55) tier = 'CAUTION'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'
      if (phase === 'CRUISE' && score < 25) tier = 'IDLE'

      out.push({
        f, phase, flCur, agl, rocFt, vs, gsKt, gearDown, flapsLanding,
        closureFpm, gsDevDots, bankDeg, windshearIdx, laTerrainSec,
        sev: sevs, score, driverMode, tier,
      })
    }
    return out
  }, [flights, minFl, maxFl, elevBias, terrainMul, gsMarg, laWin])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { 'PULL-UP': 0, CAUTION: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumAgl = 0, sumVs = 0, worst = 0, worstCs = '', worstMode: Mode | 'NONE' = 'NONE'
    let pullup = 0, laCount = 0
    for (const r of rows) {
      sumAgl += r.agl; sumVs += r.vs
      if (r.tier === 'PULL-UP') pullup++
      if (isFinite(r.laTerrainSec) && r.laTerrainSec < laWin) laCount++
      if (r.score > worst) { worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstMode = r.driverMode }
    }
    return {
      meanAgl: rows.length ? sumAgl / rows.length : 0,
      meanVs: rows.length ? sumVs / rows.length : 0,
      worst, worstCs, worstMode, pullup, laCount,
    }
  }, [rows, laWin])

  const modeAggs = useMemo(() => {
    const m = new Map<Mode, { mode: Mode; count: number; sumScore: number; worst: number; worstCs: string; worstIcao: string; worstTier: Tier }>()
    for (const md of MODES) m.set(md, { mode: md, count: 0, sumScore: 0, worst: 0, worstCs: '', worstIcao: '', worstTier: 'OK' })
    for (const r of rows) {
      for (const md of MODES) {
        const sev = r.sev[md.toLowerCase() as 'm1']
        if (sev <= 0) continue
        const a = m.get(md)!
        a.count++; a.sumScore += sev
        const t: Tier = sev >= 80 ? 'PULL-UP' : sev >= 55 ? 'CAUTION' : sev >= 25 ? 'WATCH' : 'OK'
        if (TIER_RANK[t] < TIER_RANK[a.worstTier]) a.worstTier = t
        if (sev > a.worst) { a.worst = sev; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
      }
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
        if (modeFilter !== 'ALL' && r.driverMode !== modeFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, modeFilter, query])

  const filteredModes = useMemo(() => {
    const q = query.trim().toUpperCase()
    return modeAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (modeFilter !== 'ALL' && a.mode !== modeFilter) return false
      if (!q) return true
      return (a.mode + ' ' + MODE_NAME[a.mode]).toUpperCase().includes(q)
    })
  }, [modeAggs, tierFilter, modeFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'CAUTION' || r.tier === 'PULL-UP').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${r.driverMode} ${Math.round(r.agl)}ft` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    // Look-ahead terrain projection lines
    const laFeatures: any[] = []
    if (showLa) {
      for (const r of rows) {
        if (!isFinite(r.laTerrainSec) || r.laTerrainSec >= laWin) continue
        const distNm = ((r.gsKt) * r.laTerrainSec) / 3600
        if (distNm < 0.05) continue
        const p = projectPosition(r.f.lat, r.f.lng, r.f.track || 0, distNm)
        laFeatures.push({
          type: 'Feature' as const,
          properties: { color: r.laTerrainSec < 30 ? '#ef4444' : '#f59e0b' },
          geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [p.lng, p.lat]] },
        })
      }
    }
    const laFc = { type: 'FeatureCollection' as const, features: laFeatures }
    // Reference dashed parallels (RAD-ALT envelope visual)
    const refFeatures: any[] = []
    if (showRef) {
      for (const lat of [55, 35, 15, -15, -35, -55]) {
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
        'line-color': ['get', 'color'], 'line-width': 0.7, 'line-opacity': 0.16, 'line-dasharray': [4, 6],
      } }))
      ensure(SRC_LA, laFc, () => map.addLayer({ id: LYR_LA, type: 'line', source: SRC_LA, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.8, 'line-opacity': 0.75, 'line-dasharray': [2, 2],
      } }))
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_HALO, LYR_LA, LYR_REF]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_HALO, SRC_LA, SRC_REF]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showLa, showRef, laWin])

  // Diagram: VS-down (y, 0..6000fpm) vs AGL (x, 0..2500ft) with Mode-1 envelope
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 30
    const xMax = 2500
    const yMax = 6000
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, v / xMax)) * (W - PAD - 6)
    const ys = (v: number) => 6 + Math.max(0, Math.min(1, v / yMax)) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">EGPWS / TAWS Mode 1-7</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean AGL</div>
          <div className="font-mono text-sm" style={{ color: summary.meanAgl < 500 ? '#ef4444' : summary.meanAgl < 1500 ? '#f59e0b' : '#10b981' }}>{Math.round(summary.meanAgl)}ft</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worst.toFixed(0)}` : '\u2014'}
          </div>
          <div className="text-[8px] text-slate-500 truncate">{summary.worstMode !== 'NONE' ? `${summary.worstMode} ${MODE_NAME[summary.worstMode]}` : '\u2014'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">PULL-UP</div>
          <div className="font-mono text-sm" style={{ color: summary.pullup > 0 ? '#ef4444' : '#10b981' }}>{summary.pullup}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean VS</div>
          <div className="font-mono text-[11px] text-slate-300">{summary.meanVs >= 0 ? '+' : ''}{Math.round(summary.meanVs)}fpm</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Look-Ahead</div>
          <div className="font-mono text-[11px]" style={{ color: summary.laCount > 0 ? '#f59e0b' : '#10b981' }}>{summary.laCount} ac</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Sink rate vs AGL · Mode 1 envelope</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[1500, 3000, 4500, 6000].map(v => (
              <g key={v}>
                <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(v) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{v}</text>
              </g>
            ))}
            {[500, 1000, 1500, 2000, 2500].map(a => (
              <g key={a}>
                <line x1={diag.xs(a)} y1={6} x2={diag.xs(a)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(a)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{a}</text>
              </g>
            ))}
            {/* Mode-1 envelope: warn (rose) curve and caution (amber) curve */}
            {(() => {
              const pts: Array<[number, number]> = []
              for (let a = 0; a <= 2500; a += 50) {
                const vw = 2500 + (a / 2500) * 2500
                pts.push([diag.xs(a), diag.ys(vw)])
              }
              const dWarn = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0] + ' ' + p[1]).join(' ')
              const cpts: Array<[number, number]> = []
              for (let a = 0; a <= 2500; a += 50) {
                const vc = 1500 + (a / 2500) * 1000
                cpts.push([diag.xs(a), diag.ys(vc)])
              }
              const dCaut = cpts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0] + ' ' + p[1]).join(' ')
              return (
                <g>
                  <path d={dWarn + ` L ${diag.xs(2500)} ${diag.ys(diag.yMax)} L ${diag.xs(0)} ${diag.ys(diag.yMax)} Z`} fill="#ef4444" opacity={0.10} />
                  <path d={dWarn} stroke="#ef4444" strokeWidth={1.2} strokeDasharray="4 3" fill="none" opacity={0.85} />
                  <path d={dCaut} stroke="#f59e0b" strokeWidth={1} strokeDasharray="3 3" fill="none" opacity={0.7} />
                  <text x={diag.xs(120)} y={diag.ys(4900)} fontSize={7} fill="#ef4444" fontFamily="monospace">WARN</text>
                  <text x={diag.xs(120)} y={diag.ys(2900)} fontSize={7} fill="#f59e0b" fontFamily="monospace">CAUTION</text>
                </g>
              )
            })()}
            {rows.map(r => {
              const sink = Math.max(0, -r.vs)
              return (
                <circle key={r.f.icao}
                  cx={diag.xs(Math.max(0, Math.min(diag.xMax, r.agl)))}
                  cy={diag.ys(Math.max(0, Math.min(diag.yMax, sink)))}
                  r={3} fill={TIER_COLOR[r.tier]} opacity={0.92} />
              )
            })}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={0} max={200} step={5} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={30} max={400} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>ELEV-BIAS</span><span className="font-mono text-slate-300">{elevBias}%</span></div>
            <input type="range" min={50} max={200} step={5} value={elevBias} onChange={e => setElevBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>TERRAIN-MUL</span><span className="font-mono text-slate-300">{terrainMul}%</span></div>
            <input type="range" min={50} max={200} step={5} value={terrainMul} onChange={e => setTerrainMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>GS-MARG</span><span className="font-mono text-slate-300">{(gsMarg / 10).toFixed(1)}d</span></div>
            <input type="range" min={5} max={25} step={1} value={gsMarg} onChange={e => setGsMarg(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>LA-WIN</span><span className="font-mono text-slate-300">{laWin}s</span></div>
            <input type="range" min={30} max={120} step={5} value={laWin} onChange={e => setLaWin(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setModeFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${modeFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {MODES.map(k => (
            <button key={k} onClick={() => setModeFilter(modeFilter === k ? 'ALL' : k)}
              title={MODE_NAME[k]}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${modeFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLa} onChange={e => setShowLa(e.target.checked)} className="accent-sky-500" /><span>LA</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRef} onChange={e => setShowRef(e.target.checked)} className="accent-sky-500" /><span>REF</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / mode"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'MODES'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} ac` : `${filteredModes.length} shown / ${modeAggs.length} mode`}</span>
        <span>{tab === 'AIRCRAFT' ? 'AGL · VS · driver-mode · score' : 'mode · count · mean · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft in TAWS envelope window.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const advice = r.tier === 'PULL-UP'
            ? `${MODE_CALLOUT[r.driverMode as Mode] || 'PULL UP'} · max thrust · pitch +20° · landing gear up after positive clb`
            : r.tier === 'CAUTION'
              ? `${r.driverMode} envelope · arrest descent · verify configuration`
              : r.tier === 'WATCH'
                ? `monitor ${r.driverMode} parameters · within advisory band`
                : `TAWS envelope clear`
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{r.driverMode !== 'NONE' ? r.driverMode : '\u2014'}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{TIER_LABEL[r.tier]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="flight level">F{Math.round(r.flCur)}</span>
                  <span title="phase" className="text-slate-500">{r.phase}</span>
                  <span title="AGL ft" style={{ color: r.agl < 500 ? '#ef4444' : r.agl < 1000 ? '#f59e0b' : r.agl < 2500 ? '#0ea5e9' : '#94a3b8' }}>{Math.round(r.agl)}ft</span>
                  <span title="vertical rate fpm" style={{ color: r.vs < -2000 ? '#ef4444' : r.vs < -1000 ? '#f59e0b' : '#94a3b8' }}>{r.vs >= 0 ? '+' : ''}{Math.round(r.vs)}fpm</span>
                  <span title="closure fpm" className="text-slate-500">↗{Math.round(r.closureFpm)}</span>
                  <span className="ml-auto" title="composite risk score" style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`score ${r.score.toFixed(0)} / 100`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500/70" style={{ left: `25%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-500/70" style={{ left: `55%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-500/70" style={{ left: `80%` }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {MODES.map(md => {
                    const v = r.sev[md.toLowerCase() as 'm1']
                    const c = v >= 80 ? '#ef4444' : v >= 55 ? '#f59e0b' : v >= 25 ? '#0ea5e9' : '#475569'
                    return (
                      <span key={md} title={`${MODE_NAME[md]} · sev ${v.toFixed(0)}`}
                        className="px-1 py-0 rounded border text-[9px] font-mono"
                        style={{ borderColor: c + '66', color: c, background: c + '14' }}>{md} {v.toFixed(0)}</span>
                    )
                  })}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="gear configuration" className={r.gearDown ? 'text-emerald-400' : 'text-slate-500'}>{r.gearDown ? 'GEAR↓' : 'GEAR↑'}</span>
                  <span title="flaps configuration" className={r.flapsLanding ? 'text-emerald-400' : 'text-slate-500'}>{r.flapsLanding ? 'FLAP-LD' : 'FLAP-UP'}</span>
                  {isFinite(r.laTerrainSec) && r.laTerrainSec < laWin && (
                    <span title="look-ahead terrain seconds" style={{ color: r.laTerrainSec < 30 ? '#ef4444' : '#f59e0b' }}>LA {Math.round(r.laTerrainSec)}s</span>
                  )}
                  {(r.phase === 'APPR' || r.phase === 'FLARE') && Math.abs(r.gsDevDots) > 0.1 && (
                    <span title="ILS GS deviation (dots)" style={{ color: r.gsDevDots < -1.3 ? '#ef4444' : r.gsDevDots < -0.7 ? '#f59e0b' : '#94a3b8' }}>GS {r.gsDevDots >= 0 ? '+' : ''}{r.gsDevDots.toFixed(1)}d</span>
                  )}
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' || r.tier === 'IDLE' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'MODES' && filteredModes.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No mode triggers active.</div>
        )}
        {tab === 'MODES' && filteredModes.map(a => {
          const advice = a.worstTier === 'PULL-UP' ? `${a.mode} hard warning active · review fleet altitude-awareness SOP`
            : a.worstTier === 'CAUTION' ? `${a.mode} caution band · brief crews on envelope`
              : a.worstTier === 'WATCH' ? `${a.mode} advisory · monitor next cycle`
                : `${a.mode} envelope nominal across fleet`
          return (
            <button key={a.mode} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.mode}</span>
                  <span className="text-slate-500 text-[10px] truncate">{MODE_NAME[a.mode]}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.worstTier] }}>{TIER_LABEL[a.worstTier]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="mean severity">mean {a.meanScore.toFixed(0)}</span>
                  <span title="worst severity" style={{ color: TIER_COLOR[a.worstTier] }}>worst {a.worst.toFixed(0)}</span>
                  <span className="ml-auto truncate">{a.worstCs || '\u2014'}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`mean ${a.meanScore.toFixed(0)} / 100`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, a.meanScore)}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500/70" style={{ left: `25%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-500/70" style={{ left: `55%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-500/70" style={{ left: `80%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate" title="aural callout">› {MODE_CALLOUT[a.mode]}</span>
                  <span className="ml-auto truncate" style={{ color: a.worstTier === 'OK' || a.worstTier === 'IDLE' ? '#64748b' : TIER_COLOR[a.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        RTCA DO-161A / DO-367 · TSO-C151d · ICAO Annex 6 6.15 · Honeywell EGPWS MK-V/VII/VIII · FAA AC 25-23
      </div>
    </div>
  )
}
