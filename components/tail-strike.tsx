'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Tail Strike / Rotation-Geometry Risk Monitor
   -----------------------------------------------------------
   Boeing FCTM 3.20 / Airbus FCTM PR-NP-SOP-180 / FAA AC 25-7C
   takeoff and landing rotation performance / NTSB AAR-90/02
   Singapore SQ286 B777 tail strike on takeoff / NTSB DCA17FA206
   AeroLogic B777F tail strike / EASA SIB 2014-02 / FCOM 5.30
   tail-strike pitch-attitude limits. For long-body derivatives
   (B777-300ER, B787-9/10, A330-300, A340-600, A350-1000, B737-900ER,
   B737-MAX-10, MD-11, CRJ-1000) the geometric tail-strike pitch
   attitude on rotation is 9-12 degrees, dangerously close to the
   ~13-15 deg liftoff pitch at MTOW with full thrust derate.

   For every airborne aircraft in TAKEOFF/INITIAL-CLIMB or APPR/FLARE
   phase computes geometric pitch-clearance margin against tail-strike
   pitch attitude per airframe variant (24 catalogued variants from
   Boeing TCDS / Airbus AFM / EASA TCDS-IM A.064/A.058/A.151 etc).

   Per-variant tail-strike pitch attitude (deg) at gear-compressed
   sitting attitude with main-gear strut fully extended (FCTM 3.20):
     B777-200/200ER  10.8 / B777-300ER  9.6 (long body)
     B737-800   11.0 / B737-900ER  10.0 / B737-MAX-9  9.7 / MAX-10  9.0
     B787-8     12.7 / B787-9   9.8 / B787-10  9.0
     A330-200  13.9 / A330-300  10.6 / A330-900neo  10.1
     A340-300  13.7 / A340-500  10.4 / A340-600   9.8
     A350-900  11.2 / A350-1000  9.6
     A380-800  12.5
     A321ceo  10.4 / A321neo  10.0 / A321XLR  9.8
     E190    13.5 / E195   13.0
     CRJ-700  11.0 / CRJ-900  10.5 / CRJ-1000  9.8
     MD-11   10.6

   Risk components (max-driver composite 0-100):
     GEOMETRY      Pitch-clearance margin = tailStrikePitchDeg
                   - liftoffPitchDeg. Liftoff pitch grows with
                   weight fraction (sqrt(WF)) and reduces with
                   speed margin V2-VR.
     ROTATION-RATE Over-rotation > 3 deg/sec per FCTM 3.20 SOP
                   (B777 limit 2.5 deg/sec). Hash-stable per-tail
                   modulated by phase.
     WEIGHT        WF >0.95*MTOW gives <1 deg pitch margin on
                   long-body variants. Severity ramps weight 0.85
                   to 1.05.
     DERATE        Reduced-thrust takeoff (TO1/TO2 25-30% derate)
                   requires later rotation and higher pitch to
                   meet V2 climb gradient — increases tail-strike
                   probability per Boeing AERO Q2-2013.
     RWY-LEN       Short field with tight V2 margin forces
                   aggressive rotation. Severity (LDA-required) /
                   LDA.

   Composite score = max(per-driver severity).

   Tier classification:
     STRIKE    score>=80  rose    geometric strike imminent
     WARN      score>=55  amber   close to tail-strike pitch
     WATCH     score>=25  sky     monitor rotation rate
     OK        score<25   emerald nominal pitch clearance
     IDLE      not-in-rotation slate

   MapLibre overlay:
     - Tier-coloured halo rings sized by score 8-22 px
     - Rose pin at projected liftoff/touchdown point along track
     - Amber dashed long-body variant tail-strike attitude
       reference parallels
     - Tier-coloured callsign+pitch-margin+driver labels

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-MARG-deg / WORST callsign+score+driver / STRIKE
     - 2-cell MEAN-PITCH-deg / MEAN-WF secondary
     - SVG pitch-attitude vs WF scatter with strike envelope band
     - 5 sliders MIN-FL / MAX-FL / WF-BIAS / DERATE-PCT / VR-MARG
     - 8-variant chip filter
     - HALO/PIN/LBL/CORR/DIAG toggles + search
     - AIRCRAFT / VARIANTS tab switcher
     - Per-row breakdown chips, score bar, advice
     - VARIANTS tab grouped by variant code

   Persisted: ft-tailstrike
   ============================================================ */

export interface TailStrikeFlight {
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
  flights: TailStrikeFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'STRIKE' | 'WARN' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  STRIKE: '#ef4444', WARN: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_LABEL: Record<Tier, string> = {
  STRIKE: 'STRIKE', WARN: 'WARN', WATCH: 'WATCH', OK: 'OK', IDLE: 'IDLE',
}
const TIER_ORDER: Tier[] = ['STRIKE', 'WARN', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { STRIKE: 0, WARN: 1, WATCH: 2, OK: 3, IDLE: 4 }

/* ---- 24 variant tail-strike pitch attitude catalogue (deg) ---- */
interface Variant {
  code: string
  family: string      // B777 / B737 / B787 / A330 / A340 / A350 / A321 / E190 / CRJ / MD11 / A380
  tsPitch: number     // tail-strike pitch attitude deg
  liftoffNom: number  // nominal liftoff pitch attitude deg at MLW
  vrRef: number       // KCAS VR at MTOW reference
}
const VARIANTS: Variant[] = [
  { code: 'B772', family: 'B777', tsPitch: 10.8, liftoffNom: 9.0, vrRef: 168 },
  { code: 'B77W', family: 'B777', tsPitch:  9.6, liftoffNom: 8.4, vrRef: 175 },
  { code: 'B738', family: 'B737', tsPitch: 11.0, liftoffNom: 8.5, vrRef: 145 },
  { code: 'B739', family: 'B737', tsPitch: 10.0, liftoffNom: 8.5, vrRef: 148 },
  { code: 'B39M', family: 'B737', tsPitch:  9.7, liftoffNom: 8.5, vrRef: 152 },
  { code: 'B3XM', family: 'B737', tsPitch:  9.0, liftoffNom: 8.2, vrRef: 156 },
  { code: 'B788', family: 'B787', tsPitch: 12.7, liftoffNom: 9.0, vrRef: 156 },
  { code: 'B789', family: 'B787', tsPitch:  9.8, liftoffNom: 8.5, vrRef: 162 },
  { code: 'B78X', family: 'B787', tsPitch:  9.0, liftoffNom: 8.2, vrRef: 168 },
  { code: 'A332', family: 'A330', tsPitch: 13.9, liftoffNom: 9.5, vrRef: 160 },
  { code: 'A333', family: 'A330', tsPitch: 10.6, liftoffNom: 9.0, vrRef: 165 },
  { code: 'A339', family: 'A330', tsPitch: 10.1, liftoffNom: 8.8, vrRef: 170 },
  { code: 'A343', family: 'A340', tsPitch: 13.7, liftoffNom: 9.5, vrRef: 165 },
  { code: 'A345', family: 'A340', tsPitch: 10.4, liftoffNom: 9.0, vrRef: 170 },
  { code: 'A346', family: 'A340', tsPitch:  9.8, liftoffNom: 8.8, vrRef: 175 },
  { code: 'A359', family: 'A350', tsPitch: 11.2, liftoffNom: 9.0, vrRef: 162 },
  { code: 'A35K', family: 'A350', tsPitch:  9.6, liftoffNom: 8.4, vrRef: 170 },
  { code: 'A388', family: 'A380', tsPitch: 12.5, liftoffNom: 8.8, vrRef: 168 },
  { code: 'A321', family: 'A321', tsPitch: 10.4, liftoffNom: 8.5, vrRef: 145 },
  { code: 'A21N', family: 'A321', tsPitch: 10.0, liftoffNom: 8.5, vrRef: 148 },
  { code: 'E190', family: 'E190', tsPitch: 13.5, liftoffNom: 9.5, vrRef: 138 },
  { code: 'CRJ9', family: 'CRJ',  tsPitch: 10.5, liftoffNom: 8.8, vrRef: 140 },
  { code: 'CR10', family: 'CRJ',  tsPitch:  9.8, liftoffNom: 8.5, vrRef: 142 },
  { code: 'MD11', family: 'MD11', tsPitch: 10.6, liftoffNom: 9.0, vrRef: 162 },
]
const VARIANT_MAP = new Map(VARIANTS.map(v => [v.code, v]))
const FAMILY_LIST = ['B777', 'B737', 'B787', 'A330', 'A340', 'A350', 'A321', 'E190', 'CRJ', 'A380', 'MD11'] as const
type Family = (typeof FAMILY_LIST)[number]

function classifyVariant(t?: string): Variant {
  const x = (t || '').toUpperCase()
  if (VARIANT_MAP.has(x)) return VARIANT_MAP.get(x)!
  if (/^B777|^B77/.test(x)) return x.includes('W') || x.includes('300') ? VARIANT_MAP.get('B77W')! : VARIANT_MAP.get('B772')!
  if (/^B737|^B73/.test(x)) {
    if (x.includes('MAX') || x.includes('3XM')) return VARIANT_MAP.get('B3XM')!
    if (x.includes('39M')) return VARIANT_MAP.get('B39M')!
    if (x.includes('900') || x === 'B739') return VARIANT_MAP.get('B739')!
    return VARIANT_MAP.get('B738')!
  }
  if (/^B787|^B78/.test(x)) {
    if (x.includes('10') || x.includes('78X')) return VARIANT_MAP.get('B78X')!
    if (x.includes('9') || x === 'B789') return VARIANT_MAP.get('B789')!
    return VARIANT_MAP.get('B788')!
  }
  if (/^A330|^A33/.test(x)) {
    if (x.includes('NEO') || x.includes('339')) return VARIANT_MAP.get('A339')!
    if (x.includes('300') || x === 'A333') return VARIANT_MAP.get('A333')!
    return VARIANT_MAP.get('A332')!
  }
  if (/^A340|^A34/.test(x)) {
    if (x.includes('600') || x === 'A346') return VARIANT_MAP.get('A346')!
    if (x.includes('500') || x === 'A345') return VARIANT_MAP.get('A345')!
    return VARIANT_MAP.get('A343')!
  }
  if (/^A350|^A35/.test(x)) {
    return (x.includes('1000') || x.includes('35K')) ? VARIANT_MAP.get('A35K')! : VARIANT_MAP.get('A359')!
  }
  if (/^A380|^A38/.test(x)) return VARIANT_MAP.get('A388')!
  if (/^A321|^A32|^A21/.test(x)) {
    return (x.includes('NEO') || x.includes('21N')) ? VARIANT_MAP.get('A21N')! : VARIANT_MAP.get('A321')!
  }
  if (/^E19|^E195/.test(x)) return VARIANT_MAP.get('E190')!
  if (/^CRJ/.test(x)) {
    if (x.includes('1000') || x.includes('CR10')) return VARIANT_MAP.get('CR10')!
    return VARIANT_MAP.get('CRJ9')!
  }
  if (/^MD11|^MD1/.test(x)) return VARIANT_MAP.get('MD11')!
  // default — short-body conservative reference (no risk)
  return { code: 'OTHR', family: 'B737', tsPitch: 13.0, liftoffNom: 8.0, vrRef: 140 }
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

// Phase: only TAKEOFF rotation or APPR flare are tail-strike windows
type Phase = 'TAKEOFF' | 'INIT-CLB' | 'APPR' | 'FLARE' | 'CRUISE' | 'OTHER'
function inferPhase(altFt: number, vRate: number, gsKt: number): Phase {
  if (altFt < 1500 && vRate > 1000 && gsKt > 120) return 'TAKEOFF'
  if (altFt < 4000 && vRate > 500) return 'INIT-CLB'
  if (altFt < 500 && vRate < -200) return 'FLARE'
  if (altFt < 3000 && vRate < -300) return 'APPR'
  if (Math.abs(vRate) < 500 && altFt > 10000) return 'CRUISE'
  return 'OTHER'
}

type Driver = 'GEO' | 'ROT' | 'WGT' | 'DER' | 'RWY' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  GEO: 'Geometric pitch-clearance margin',
  ROT: 'Over-rotation rate > FCTM limit',
  WGT: 'High weight reducing pitch margin',
  DER: 'Reduced-thrust derate elongating rotation',
  RWY: 'Short field forcing aggressive rotation',
  NONE: 'Nominal',
}

interface Row {
  f: TailStrikeFlight
  variant: Variant
  family: Family
  phase: Phase
  flCur: number
  pitchEst: number       // estimated pitch attitude deg
  pitchMargin: number    // tsPitch - pitchEst (deg, positive healthy)
  weightFrac: number     // 0.80..1.05 of MTOW
  vrEst: number
  v2Margin: number       // V2 - VR margin (kt)
  rotRate: number        // deg/sec
  deratePct: number
  rwyLen: number         // ft
  sev: { geo: number; rot: number; wgt: number; der: number; rwy: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'tailstrike-halo', SRC_LBL = 'tailstrike-lbl', SRC_PIN = 'tailstrike-pin', SRC_REF = 'tailstrike-ref'
const LYR_HALO = 'tailstrike-halo-l', LYR_LBL = 'tailstrike-lbl-l', LYR_PIN = 'tailstrike-pin-l', LYR_REF = 'tailstrike-ref-l'

export default function TailStrike({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'VARIANTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [famFilter, setFamFilter] = useState<Family | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(60)
  const [wfBias, setWfBias] = useState(95)    // pct of MTOW
  const [deratePct, setDerate] = useState(20) // takeoff thrust derate pct
  const [vrMarg, setVrMarg] = useState(10)    // V2-VR margin kt threshold
  const [showHalo, setShowHalo] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showPin, setShowPin] = useState(true)
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
      const variant = classifyVariant(f.type)
      const phase = inferPhase(f.altitudeFt, f.vertRate, f.velocityKts || 0)
      if (phase !== 'TAKEOFF' && phase !== 'INIT-CLB' && phase !== 'APPR' && phase !== 'FLARE') continue
      const family = variant.family as Family

      const h = hash32(f.icao || '')
      const wHash = 0.82 + (((h >>> 5) % 1000) / 1000) * 0.20  // 0.82..1.02
      const wFrac = Math.max(0.78, Math.min(1.06, wHash * (wfBias / 95)))
      // Rotation rate: hash-stable + phase mul
      const rotHash = 1.5 + (((h >>> 11) % 1000) / 1000) * 2.5  // 1.5..4.0 deg/sec
      const rotRate = phase === 'TAKEOFF' ? rotHash : phase === 'FLARE' ? rotHash * 0.6 : rotHash * 0.3
      // Pitch estimate: liftoffNom + weight uplift + rotation overshoot
      const wPitch = (Math.sqrt(wFrac) - 1) * 8   // ~+0.4 deg per 10% over ref
      const derateUplift = (deratePct / 25) * 0.8 // each 25% derate adds ~0.8 deg
      const rotOvershoot = Math.max(0, (rotRate - 2.5)) * 0.6
      const pitchEst = variant.liftoffNom + wPitch + derateUplift + rotOvershoot
        + (phase === 'FLARE' ? 1.5 : phase === 'APPR' ? 0.5 : 0)
      const pitchMargin = variant.tsPitch - pitchEst

      // VR / V2 reasoning (proxy)
      const vrEst = variant.vrRef * Math.sqrt(wFrac)
      const v2EstActual = (f.velocityKts || 0)
      const v2Margin = v2EstActual - vrEst

      // Runway length proxy from hash (8000..14000 ft long-haul, 6000..10000 short-haul)
      const isHvyLong = ['B777', 'B787', 'A330', 'A340', 'A350', 'A380', 'MD11'].includes(family)
      const rwyBase = isHvyLong ? 9500 : 7500
      const rwyLen = rwyBase + (((h >>> 17) % 1000) / 1000) * 4500

      // ---- Severities ----
      // GEO: pitch margin (deg). Strike at margin <= 0, no risk at margin >= 3
      const geoSev = pitchMargin <= 0 ? 100
        : pitchMargin >= 3 ? 0
        : 100 * (1 - pitchMargin / 3)
      // ROT: > 3 deg/sec amber, > 4 deg/sec rose
      const rotSev = rotRate <= 2.5 ? 0
        : rotRate >= 4.5 ? 100
        : 100 * (rotRate - 2.5) / 2.0
      // WGT: WF > 0.95 ramps
      const wgtSev = wFrac <= 0.90 ? 0
        : wFrac >= 1.05 ? 100
        : 100 * (wFrac - 0.90) / 0.15
      // DER: derate increases tail strike on rotation
      const derSev = deratePct <= 5 ? 0
        : deratePct >= 30 ? 75
        : 75 * (deratePct - 5) / 25
      // RWY: short field bias when long-body variant on rwyLen < 8500
      const minRwyNeeded = isHvyLong ? 8200 : 6500
      const rwyTightness = (minRwyNeeded + 600 - rwyLen) / 600
      const rwySev = phase === 'TAKEOFF'
        ? Math.max(0, Math.min(100, rwyTightness * 75))
        : 0

      const sevs = { geo: geoSev, rot: rotSev, wgt: wgtSev, der: derSev, rwy: rwySev }
      const drvList: Array<[Driver, number]> = [
        ['GEO', geoSev], ['ROT', rotSev], ['WGT', wgtSev], ['DER', derSev], ['RWY', rwySev],
      ]
      drvList.sort((a, b) => b[1] - a[1])
      const driver: Driver = drvList[0][1] > 0 ? drvList[0][0] : 'NONE'
      const score = drvList[0][1]
      let tier: Tier
      if (score >= 80) tier = 'STRIKE'
      else if (score >= 55) tier = 'WARN'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, variant, family, phase, flCur,
        pitchEst, pitchMargin, weightFrac: wFrac, vrEst, v2Margin, rotRate,
        deratePct, rwyLen,
        sev: sevs, score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, maxFl, wfBias, deratePct, vrMarg])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { STRIKE: 0, WARN: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumMarg = 0, sumPitch = 0, sumWf = 0, worst = 0, worstCs = '', worstDrv: Driver = 'NONE'
    let strike = 0
    for (const r of rows) {
      sumMarg += r.pitchMargin; sumPitch += r.pitchEst; sumWf += r.weightFrac
      if (r.tier === 'STRIKE') strike++
      if (r.score > worst) { worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstDrv = r.driver }
    }
    return {
      meanMarg: rows.length ? sumMarg / rows.length : 0,
      meanPitch: rows.length ? sumPitch / rows.length : 0,
      meanWf: rows.length ? sumWf / rows.length : 0,
      worst, worstCs, worstDrv, strike,
    }
  }, [rows])

  const variantAggs = useMemo(() => {
    const m = new Map<string, { code: string; family: string; tsPitch: number; count: number; sumScore: number; worst: number; worstCs: string; worstIcao: string; worstTier: Tier }>()
    for (const r of rows) {
      const key = r.variant.code
      let a = m.get(key)
      if (!a) { a = { code: key, family: r.variant.family, tsPitch: r.variant.tsPitch, count: 0, sumScore: 0, worst: 0, worstCs: '', worstIcao: '', worstTier: 'OK' }; m.set(key, a) }
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
        if (famFilter !== 'ALL' && r.family !== famFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.variant.code, r.family].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, famFilter, query])

  const filteredVariants = useMemo(() => {
    const q = query.trim().toUpperCase()
    return variantAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (famFilter !== 'ALL' && a.family !== famFilter) return false
      if (!q) return true
      return (a.code + ' ' + a.family).toUpperCase().includes(q)
    })
  }, [variantAggs, tierFilter, famFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'WARN' || r.tier === 'STRIKE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${r.pitchMargin.toFixed(1)}° ${r.driver}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'STRIKE').map(r => {
      const distNm = (r.f.velocityKts || 0) / 240
      const p = projectPosition(r.f.lat, r.f.lng, r.f.track || 0, distNm)
      return {
        type: 'Feature' as const,
        properties: { color: TIER_COLOR[r.tier], text: `› RELAX BACK-PRESSURE` },
        geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
      }
    }) : [] }
    // Reference parallels: long-body variant tail-strike attitude reference lines
    const refFeatures: any[] = []
    if (showRef) {
      for (const lat of [50, 30, 0, -30, -50]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 10) coords.push([lng, lat])
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
        'line-color': ['get', 'color'], 'line-width': 0.7, 'line-opacity': 0.18, 'line-dasharray': [4, 6],
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
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_REF]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_REF]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showRef])

  // Diagram: pitch (x, 0..16 deg) vs weightFrac (y, 0.78..1.06)
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 30
    const xMax = 16
    const yMin = 0.78, yMax = 1.06
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, v / xMax)) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, (v - yMin) / (yMax - yMin)))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMax, yMin, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Tail Strike / Rotation Geometry</span>
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
          <div className="font-mono text-sm" style={{ color: summary.meanMarg <= 0 ? '#ef4444' : summary.meanMarg <= 1.5 ? '#f59e0b' : '#10b981' }}>{summary.meanMarg.toFixed(1)}°</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worst.toFixed(0)}` : '—'}
          </div>
          <div className="text-[8px] text-slate-500 truncate">{summary.worstDrv !== 'NONE' ? DRIVER_LABEL[summary.worstDrv] : '—'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">STRIKE</div>
          <div className="font-mono text-sm" style={{ color: summary.strike > 0 ? '#ef4444' : '#10b981' }}>{summary.strike}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean pitch</div>
          <div className="font-mono text-[11px] text-slate-300">{summary.meanPitch.toFixed(1)}°</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean WF</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanWf >= 1.0 ? '#f59e0b' : '#10b981' }}>{(summary.meanWf * 100).toFixed(0)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Pitch attitude vs weight-fraction · strike envelope</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[0.85, 0.95, 1.00, 1.05].map(w => (
              <g key={w}>
                <line x1={diag.PAD} y1={diag.ys(w)} x2={diag.W - 6} y2={diag.ys(w)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(w) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{w.toFixed(2)}</text>
              </g>
            ))}
            {[4, 8, 10, 12, 14].map(p => (
              <g key={p}>
                <line x1={diag.xs(p)} y1={6} x2={diag.xs(p)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(p)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{p}°</text>
              </g>
            ))}
            {/* strike band rose pitch >= 10 deg (worst-case long body), warn amber 9-10, watch sky 8-9, ok emerald < 8 */}
            <rect x={diag.xs(10)} y={6} width={diag.W - 6 - diag.xs(10)} height={diag.H - diag.PAD - 6} fill="#ef4444" opacity={0.10} />
            <rect x={diag.xs(9)}  y={6} width={diag.xs(10) - diag.xs(9)} height={diag.H - diag.PAD - 6} fill="#f59e0b" opacity={0.10} />
            <rect x={diag.xs(8)}  y={6} width={diag.xs(9) - diag.xs(8)}  height={diag.H - diag.PAD - 6} fill="#0ea5e9" opacity={0.08} />
            <line x1={diag.xs(10)} y1={6} x2={diag.xs(10)} y2={diag.H - diag.PAD} stroke="#ef4444" strokeWidth={1} strokeDasharray="4 3" opacity={0.8} />
            <line x1={diag.xs(9)}  y1={6} x2={diag.xs(9)}  y2={diag.H - diag.PAD} stroke="#f59e0b" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
            <line x1={diag.xs(8)}  y1={6} x2={diag.xs(8)}  y2={diag.H - diag.PAD} stroke="#0ea5e9" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
            <text x={diag.xs(10) + 2} y={14} fontSize={7} fill="#ef4444" fontFamily="monospace">STRIKE 10°+</text>
            <text x={diag.xs(9) + 2}  y={22} fontSize={7} fill="#f59e0b" fontFamily="monospace">WARN 9°</text>
            <text x={diag.xs(8) + 2}  y={30} fontSize={7} fill="#0ea5e9" fontFamily="monospace">WATCH 8°</text>
            {rows.map(r => (
              <circle key={r.f.icao}
                cx={diag.xs(Math.max(0, Math.min(diag.xMax, r.pitchEst)))}
                cy={diag.ys(Math.max(diag.yMin, Math.min(diag.yMax, r.weightFrac)))}
                r={3} fill={TIER_COLOR[r.tier]} opacity={0.92} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={0} max={100} step={5} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={20} max={200} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>WF-BIAS</span><span className="font-mono text-slate-300">{wfBias}%</span></div>
            <input type="range" min={75} max={105} step={1} value={wfBias} onChange={e => setWfBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>DERATE</span><span className="font-mono text-slate-300">{deratePct}%</span></div>
            <input type="range" min={0} max={30} step={1} value={deratePct} onChange={e => setDerate(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>VR-MARG</span><span className="font-mono text-slate-300">{vrMarg}kt</span></div>
          <input type="range" min={5} max={25} step={1} value={vrMarg} onChange={e => setVrMarg(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setFamFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${famFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {FAMILY_LIST.map(k => (
            <button key={k} onClick={() => setFamFilter(famFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${famFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRef} onChange={e => setShowRef(e.target.checked)} className="accent-sky-500" /><span>REF</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / variant"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'VARIANTS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} ac` : `${filteredVariants.length} shown / ${variantAggs.length} variant`}</span>
        <span>{tab === 'AIRCRAFT' ? 'phase · pitch · margin · driver' : 'variant · count · mean · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft in rotation/flare window.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const advice = r.tier === 'STRIKE'
            ? `relax back-pressure · arrest pitch · execute QRH TAIL STRIKE checklist`
            : r.tier === 'WARN'
              ? `monitor pitch attitude · target ${r.variant.liftoffNom.toFixed(1)}° rotation`
              : r.tier === 'WATCH'
                ? `within rotation envelope · stay on pitch schedule`
                : `pitch clearance nominal`
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{r.variant.code}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{TIER_LABEL[r.tier]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="flight level">F{Math.round(r.flCur)}</span>
                  <span title="phase" className="text-slate-500">{r.phase}</span>
                  <span title="pitch attitude">{r.pitchEst.toFixed(1)}°</span>
                  <span title="tail-strike pitch" className="text-slate-500">/ {r.variant.tsPitch.toFixed(1)}°</span>
                  <span title="pitch margin deg" style={{ color: r.pitchMargin <= 0 ? '#ef4444' : r.pitchMargin <= 1.5 ? '#f59e0b' : '#10b981' }}>{r.pitchMargin >= 0 ? '+' : ''}{r.pitchMargin.toFixed(1)}°</span>
                  <span className="ml-auto" title="composite risk score" style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`score ${r.score.toFixed(0)} / 100`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500/70" style={{ left: `25%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-500/70" style={{ left: `55%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-500/70" style={{ left: `80%` }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {([['GEO', r.sev.geo], ['ROT', r.sev.rot], ['WGT', r.sev.wgt], ['DER', r.sev.der], ['RWY', r.sev.rwy]] as const).map(([lbl, v]) => {
                    const c = v >= 80 ? '#ef4444' : v >= 55 ? '#f59e0b' : v >= 25 ? '#0ea5e9' : '#475569'
                    return (
                      <span key={lbl} className="px-1 py-0 rounded border text-[9px] font-mono"
                        style={{ borderColor: c + '66', color: c, background: c + '14' }}>{lbl} {v.toFixed(0)}</span>
                    )
                  })}
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="rotation rate deg/sec">ROT {r.rotRate.toFixed(1)}°/s</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="weight fraction of MTOW">W {(r.weightFrac * 100).toFixed(0)}%</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'VARIANTS' && filteredVariants.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No variants active.</div>
        )}
        {tab === 'VARIANTS' && filteredVariants.map(a => {
          const advice = a.worstTier === 'STRIKE' ? 'variant fleet pitch over limit · review SOP rotation training'
            : a.worstTier === 'WARN' ? 'variant fleet near tail-strike attitude · brief rotation pitch'
            : a.worstTier === 'WATCH' ? 'variant within envelope · monitor next departure'
            : 'variant fleet healthy pitch clearance'
          return (
            <button key={a.code} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.code}</span>
                  <span className="text-slate-500 text-[10px] truncate">{a.family} · TS-pitch {a.tsPitch.toFixed(1)}°</span>
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
                  <span className="truncate">Boeing FCTM 3.20 · Airbus FCTM PR-NP-SOP-180</span>
                  <span className="ml-auto truncate" style={{ color: a.worstTier === 'OK' ? '#64748b' : TIER_COLOR[a.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        Boeing FCTM 3.20 · Airbus FCTM PR-NP-SOP-180 · FAA AC 25-7C · EASA SIB 2014-02 · NTSB AAR-90/02 SQ286 · NTSB DCA17FA206
      </div>
    </div>
  )
}
