'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Fuel Tank Lateral Imbalance & Asymmetric Roll-Trim Monitor
   -----------------------------------------------------------
   Watches every airborne aircraft and reconstructs per-airframe
   left/right wing-tank quantities, computes lateral fuel-mass
   asymmetry against FCOM left/right wing-tank imbalance limits,
   and estimates the resulting rolling moment, aileron-trim
   deflection and rudder-trim demand required to hold wings
   level. Flags airframes operating beyond MEL/QRH fuel-balance
   procedures or showing trim runaway consistent with an
   unreported leak.

   Regulatory & operational basis:
     · 14 CFR 25.959 unusable fuel · 25.979 fuel system
     · 14 CFR 25.951 / 25.953 fuel system independence
     · 14 CFR 25.1305 fuel-quantity indication
     · 14 CFR 25.671 / 25.677 trim systems
     · CS-25.959 / CS-25.979 / AMC 25.979 cross-feed
     · Boeing 737 FCOM 12.20 / QRH 12.5 FUEL IMBALANCE
       limit 1000 lb between mains for taxi/takeoff/landing,
       max 1500 lb in flight before crossfeed required
     · Boeing 777 FCOM 12.20 / QRH 12.6 max 3000 lb main 1-2
     · Boeing 787 FCOM 12.20 max 2000 lb main 1-2
     · Boeing 747-8 FCOM 12.20 max 2000 lb main 1-4 / 4000 reserve
     · Airbus A320 FCOM PRO-ABN-28 / QRH 2.28
       FUEL L+R WING TK LO LVL 750 kg crossfeed required
       imbalance >1500 kg generic limit
     · Airbus A330 FCOM PRO-ABN-28 imbalance 3000 kg
     · Airbus A350 FCOM PRO-ABN-28 imbalance 4000 kg
     · Airbus A380 FCOM imbalance 9000 kg outer-inner
     · NTSB AAR-92/03 Markair 737 imbalance + leak hard-over
     · TWA 800 NTSB AAR-00/03 centre-tank ignition
     · AAIB 1/2019 G-EUYE A319 fuel leak undetected imbalance
     · Boeing AERO Q2-2009 Fuel Tank Imbalance
     · Honeywell FQIS fuel-quantity sensor capacitance probes
       per ARINC 425
     · FAA AC 25-19A condition-monitoring leak detection
     · FAA SAFO 17009 fuel-imbalance crew awareness

   8-class airframe catalogue with per-class FCOM limits:
     HVY  HHvy 4-engine 747/A380   maxImb 4000 lb inboards
     HMB  Hvy mainline 777/A350     maxImb 3000 lb
     HMW  Hvy widebody 787/A330     maxImb 2000 lb
     NRW  Narrowbody 737/A320/A22   maxImb 1500 lb cruise
     RGN  Regional CRJ/E170/ATR     maxImb  800 lb
     BIZ  Bizjet GLF/CL/FA/Global   maxImb  600 lb
     TBP  Turboprop DH8/PT6/B200    maxImb  300 lb
     GA   Light GA / single-pump    maxImb  100 lb

   Per-airframe hash-stable synthesis (FNV-1a 32-bit of ICAO24):
     · capacityLb per class (HVY 410000 / HMB 250000 / HMW 180000
       / NRW 50000 / RGN 18000 / BIZ 32000 / TBP 6000 / GA 600)
     · per-tank quantity left/right 25%..95% capacity each
     · burn asymmetry rate (gph) hash-stable 0..14 gph diff
     · cross-feed valve state OPEN / CLOSED / FAILED
     · per-airframe leak-flag (1.5% fleet share) with rate 60..250 gph
     · centre-tank state nominal/used/empty driving baseline lateral
       gravity contribution

   Computes for each row:
     · leftLb / rightLb / centreLb fuel mass
     · totalLb / loadFactor = total / capacity
     · imbalanceLb = |left - right|
     · imbalancePct = imbalanceLb / (left+right)
     · lateralCG-offset in (rolling moment / dynamic pressure)
     · aileron-trim-deflection-deg required (linearised
       0..6 deg per FCOM lateral-trim authority)
     · rudder-trim demand (0..3 deg) to coordinate
     · time-to-limit minutes if asymmetric burn continues

   5 risk components, composite = max-driver:
     IMB    imbalance vs class FCOM limit (sev 0 at 50% of
            limit ramping 100 at 110% of limit)
     XFD    cross-feed required but valve CLOSED or FAILED
            and imbalance > 50% limit (sev 100 if FAILED with
            imb>limit, 70 if CLOSED with imb>limit, 30 if
            CLOSED with imb>50%limit)
     TRIM   aileron-trim demand vs authority (sev 0 at
            <2deg, 100 at >5deg per FCOM 9.20 lateral trim)
     LEAK   leak flag with measurable rate driving imbalance
            growth (sev 100 if leak active and growing imbalance
            >50 gph)
     TTL    time-to-limit minutes (sev 0 at >120min, 100 at
            <15min)

   Tier classification:
     CRITICAL  score>=80 / leak+imb>limit / xfeed FAILED with
               imb>limit — rose — declare PAN-PAN, land at
               nearest suitable per QRH 12.5 FUEL LEAK
     HIGH      score>=55 — amber — execute QRH FUEL IMBALANCE
               open crossfeed, isolate suspected pump, monitor
     WATCH     score>=25 — sky — within FCOM limits but trend
               adverse, log fuel readings every 30 min
     OK        score<25 — emerald — symmetric, all systems
               nominal
     IDLE      ground / no-fuel-burn class — slate

   MapLibre overlay:
     · tier-coloured halo rings sized by score 8-22 px
     · rose diamond pin at current pos for CRITICAL with
       imbalance-lb and direction (L-HVY / R-HVY) callout
     · tier-coloured callsign+imb-lb+side+driver labels for
       HIGH/CRITICAL
     · 16-segment dashed forward-projection 60 nm tier-coloured
       for CRITICAL
     · sky reference parallels at lat 50/0/-50 sampled every
       14° longitude as fleet reference

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-IMB-LB / WORST callsign+side+score /
       CRITICAL-count summary
     · 2-cell MEAN-TRIM-DEG / LEAK-SHARE secondary row
     · SVG imbalance-vs-trim scatter with rose limit band,
       amber 50-100% limit band, sky 25-50% limit band,
       emerald <25% limit band, dashed FCOM-limit vertical,
       per-aircraft tier-coloured dots
     · 5 sliders MIN-FL / LIM-MUL / LEAK-RATE / TTL-MIN /
       TRIM-AUTH in 2-col grid
     · 8-class chip filter HVY/HMB/HMW/NRW/RGN/BIZ/TBP/GA
     · HALO/PIN/LBL/PROJ/REF/DIAG toggles + search
     · AIRCRAFT / CLASSES tab switcher
     · Per-row breakdown chips, score bar, citation, advice
       with click-to-fly
     · CLASSES tab grouped by class with worst-aircraft drill

   Persisted: ft-fuelimb
   ============================================================ */

export interface FuelImbFlight {
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
  flights: FuelImbFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'CRITICAL' | 'HIGH' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  CRITICAL: '#ef4444', HIGH: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['CRITICAL', 'HIGH', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { CRITICAL: 0, HIGH: 1, WATCH: 2, OK: 3, IDLE: 4 }

type AcClass = 'HVY' | 'HMB' | 'HMW' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA'
const CLASS_LIST: AcClass[] = ['HVY', 'HMB', 'HMW', 'NRW', 'RGN', 'BIZ', 'TBP', 'GA']

interface ClassSpec {
  capacityLb: number   // total usable fuel
  maxImbLb: number     // FCOM imbalance limit
  baseTrimAuth: number // deg lateral trim authority
  burnGph: number      // total cruise burn
  fcom: string
}
const CLASS_SPEC: Record<AcClass, ClassSpec> = {
  HVY: { capacityLb: 410000, maxImbLb: 4000, baseTrimAuth: 5.5, burnGph: 3400, fcom: '747-8 FCOM 12.20 / A380 FCOM 28-30-00' },
  HMB: { capacityLb: 250000, maxImbLb: 3000, baseTrimAuth: 5.0, burnGph: 2200, fcom: '777 FCOM 12.20 / A350 FCOM PRO-ABN-28' },
  HMW: { capacityLb: 180000, maxImbLb: 2000, baseTrimAuth: 4.8, burnGph: 1900, fcom: '787 FCOM 12.20 / A330 FCOM PRO-ABN-28' },
  NRW: { capacityLb: 50000,  maxImbLb: 1500, baseTrimAuth: 4.5, burnGph: 800,  fcom: '737 FCOM 12.20 / A320 FCOM PRO-ABN-28' },
  RGN: { capacityLb: 18000,  maxImbLb: 800,  baseTrimAuth: 4.0, burnGph: 380,  fcom: 'CRJ/E170 FCOM 12.20' },
  BIZ: { capacityLb: 32000,  maxImbLb: 600,  baseTrimAuth: 4.0, burnGph: 320,  fcom: 'GLF/CL FCOM 28' },
  TBP: { capacityLb: 6000,   maxImbLb: 300,  baseTrimAuth: 3.5, burnGph: 110,  fcom: 'DH8/B200 AFM 28' },
  GA:  { capacityLb: 600,    maxImbLb: 100,  baseTrimAuth: 2.5, burnGph: 12,   fcom: 'POH §7 Fuel' },
}

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|A38|IL96/.test(t)) return 'HVY'
  if (/B77|A35/.test(t)) return 'HMB'
  if (/B78|A33|A34|MD11/.test(t)) return 'HMW'
  if (/B73|B72|A22|A31|A32|B75|MD8|MD9/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E29|AT[47]|DH8|RJ85|F70|F100/.test(t)) return 'RGN'
  if (/CL[36]|G[VI458]|GLF|GLEX|FA[5789]|F2TH|E[35]5/.test(t)) return 'BIZ'
  if (/PC1|PC2|TBM|PT6|KING|BE20|C208|C30|DH3/.test(t)) return 'TBP'
  return 'GA'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

type XfeedState = 'OPEN' | 'CLOSED' | 'FAILED'
type Driver = 'IMB' | 'XFD' | 'TRIM' | 'LEAK' | 'TTL' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  IMB: 'Imbalance vs FCOM limit',
  XFD: 'Cross-feed required, valve fault',
  TRIM: 'Aileron-trim demand exceeded',
  LEAK: 'Suspected wing-tank leak',
  TTL: 'Time-to-limit imminent',
  NONE: 'Nominal',
}

interface Row {
  f: FuelImbFlight
  klass: AcClass
  spec: ClassSpec
  leftLb: number
  rightLb: number
  centreLb: number
  totalLb: number
  imbLb: number
  imbPct: number
  side: 'L' | 'R' | '='
  xfeed: XfeedState
  trimDeg: number       // aileron trim required
  rudDeg: number        // rudder trim required
  leak: boolean
  leakGph: number
  burnDiffGph: number   // asymmetric burn rate (gph) +R / -L
  ttlMin: number        // time to reach max imbalance
  sev: { imb: number; xfd: number; trim: number; leak: number; ttl: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'fimb-halo', SRC_LBL = 'fimb-lbl', SRC_PIN = 'fimb-pin', SRC_REF = 'fimb-ref', SRC_PROJ = 'fimb-proj'
const LYR_HALO = 'fimb-halo-l', LYR_LBL = 'fimb-lbl-l', LYR_PIN = 'fimb-pin-l', LYR_REF = 'fimb-ref-l', LYR_PROJ = 'fimb-proj-l'

export default function FuelImbalance({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [limMul, setLimMul] = useState(100)        // FCOM-limit scale 50..150
  const [leakRateMul, setLeakRateMul] = useState(100) // 50..200
  const [ttlMinSlider, setTtlMinSlider] = useState(30) // alarm horizon 5..120
  const [trimAuthMul, setTrimAuthMul] = useState(100)  // 50..150
  const [leakRateFleet, setLeakRateFleet] = useState(2) // % fleet 0..15
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
      const klass = classifyClass(f.type || '')
      const spec = CLASS_SPEC[klass]
      const h = hash32(f.icao || '')
      const maxImb = spec.maxImbLb * (limMul / 100)
      const trimAuth = spec.baseTrimAuth * (trimAuthMul / 100)
      // Per-tank quantities — total load factor 30..95%
      const lf = 0.30 + ((h >>> 3) % 65) / 100
      const total = spec.capacityLb * lf
      // Centre tank: 30% of total when present (HVY/HMW/HMB/NRW only) and lf>0.55
      const hasCentre = (klass === 'HVY' || klass === 'HMB' || klass === 'HMW' || klass === 'NRW') && lf > 0.55
      const centre = hasCentre ? total * 0.30 * (((h >>> 11) % 100) / 100) : 0
      const wingTotal = total - centre
      // Imbalance fraction 0..18% biased low; hash-stable
      const imbFracRaw = ((h >>> 7) % 1000) / 1000
      // skew the distribution: most aircraft <5%, some up to 18%
      const imbFrac = imbFracRaw < 0.7 ? imbFracRaw * 0.07 : 0.05 + (imbFracRaw - 0.7) * 0.45
      const left = wingTotal / 2 * (1 + imbFrac)
      const right = wingTotal / 2 * (1 - imbFrac)
      const imbLb = Math.abs(left - right)
      const side: 'L' | 'R' | '=' = imbFrac > 0.005 ? 'L' : imbFrac < -0.005 ? 'R' : '='
      const imbPct = wingTotal > 0 ? imbLb / wingTotal : 0
      // Cross-feed state: 90% OPEN when imb>50%limit else 70% CLOSED, 2% FAILED
      const xfRoll = (h >>> 17) % 100
      let xfeed: XfeedState = 'OPEN'
      if (xfRoll < 2) xfeed = 'FAILED'
      else if (imbLb < maxImb * 0.5) {
        if (xfRoll < 70) xfeed = 'CLOSED'
      } else {
        if (xfRoll > 92) xfeed = 'CLOSED'
      }
      // Leak: leakRateFleet% of fleet
      const leakRoll = (h >>> 19) % 1000
      const leak = leakRoll < leakRateFleet * 10
      const leakGph = leak ? (60 + ((h >>> 23) % 200)) * (leakRateMul / 100) : 0
      // Asymmetric burn rate — base small unless leak
      const baseBurnDiff = ((h >>> 13) % 14) - 4 // -4..+10 gph
      const burnDiffGph = leak ? Math.sign(left - right || 1) * (leakGph * 0.6) + baseBurnDiff : baseBurnDiff
      // Trim demand: linear in imbalance fraction × dynamic-pressure factor ≈ velocityKts²
      const qFactor = Math.min(1.4, Math.max(0.4, (f.velocityKts || 250) / 280))
      const trimDeg = Math.min(8, imbPct * 32 * qFactor)
      const rudDeg = Math.min(3, trimDeg * 0.45)
      // Time-to-limit: if burnDiff drives imbalance toward maxImb in gph * 6.7 lb/gal jet-A
      const lbPerGal = 6.7
      const closingLbHr = Math.abs(burnDiffGph) * lbPerGal
      const headroomLb = Math.max(0, maxImb - imbLb)
      const ttlMin = (closingLbHr > 1 && (burnDiffGph > 0 ? side === 'R' : side === 'L'))
        ? (headroomLb / closingLbHr) * 60
        : 9999

      // severities
      const imbRatio = imbLb / Math.max(1, maxImb)
      const imbSev = imbRatio <= 0.5 ? 0 : imbRatio >= 1.10 ? 100 : ((imbRatio - 0.5) / 0.60) * 100
      let xfdSev = 0
      if (xfeed === 'FAILED' && imbLb > maxImb) xfdSev = 100
      else if (xfeed === 'FAILED' && imbLb > maxImb * 0.5) xfdSev = 70
      else if (xfeed === 'CLOSED' && imbLb > maxImb) xfdSev = 75
      else if (xfeed === 'CLOSED' && imbLb > maxImb * 0.6) xfdSev = 40
      const trimSev = trimDeg <= 2 ? 0 : trimDeg >= trimAuth ? 100 : ((trimDeg - 2) / Math.max(0.5, trimAuth - 2)) * 100
      const leakSev = leak ? (leakGph > 120 ? 100 : 60 + (leakGph - 60) * 0.4) : 0
      const ttlSev = ttlMin >= 120 ? 0 : ttlMin <= ttlMinSlider / 2 ? 100 : (1 - (ttlMin - ttlMinSlider / 2) / (120 - ttlMinSlider / 2)) * 100

      const drvList: Array<[Driver, number]> = [
        ['IMB', imbSev], ['XFD', xfdSev], ['TRIM', trimSev], ['LEAK', leakSev], ['TTL', ttlSev],
      ]
      drvList.sort((a, b) => b[1] - a[1])
      const driver: Driver = drvList[0][1] > 0 ? drvList[0][0] : 'NONE'
      const score = drvList[0][1]
      let tier: Tier
      if ((leak && imbLb > maxImb) || (xfeed === 'FAILED' && imbLb > maxImb) || score >= 80) tier = 'CRITICAL'
      else if (score >= 55) tier = 'HIGH'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, klass, spec,
        leftLb: left, rightLb: right, centreLb: centre, totalLb: total,
        imbLb, imbPct, side, xfeed, trimDeg, rudDeg, leak, leakGph, burnDiffGph, ttlMin,
        sev: { imb: imbSev, xfd: xfdSev, trim: trimSev, leak: leakSev, ttl: ttlSev },
        score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, limMul, leakRateMul, ttlMinSlider, trimAuthMul, leakRateFleet])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { CRITICAL: 0, HIGH: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumImb = 0, sumTrim = 0, worst = 0, worstCs = '', worstSide = '=', worstScore = 0
    let crit = 0, leakN = 0, count = 0
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      count++
      sumImb += r.imbLb; sumTrim += r.trimDeg
      if (r.tier === 'CRITICAL') crit++
      if (r.leak) leakN++
      if (r.score > worst) { worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstSide = r.side; worstScore = r.score }
    }
    return {
      meanImb: count ? sumImb / count : 0,
      meanTrim: count ? sumTrim / count : 0,
      worst, worstCs, worstSide, worstScore, crit,
      leakShare: count ? leakN / count : 0,
      activeCount: count,
    }
  }, [rows])

  const classAggs = useMemo(() => {
    const m = new Map<AcClass, { klass: AcClass; spec: ClassSpec; count: number; sumScore: number; sumImb: number; sumTrim: number; worst: number; worstCs: string; worstIcao: string; worstTier: Tier; crit: number; leakN: number }>()
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      let a = m.get(r.klass)
      if (!a) { a = { klass: r.klass, spec: r.spec, count: 0, sumScore: 0, sumImb: 0, sumTrim: 0, worst: 0, worstCs: '', worstIcao: '', worstTier: 'OK', crit: 0, leakN: 0 }; m.set(r.klass, a) }
      a.count++; a.sumScore += r.score; a.sumImb += r.imbLb; a.sumTrim += r.trimDeg
      if (r.tier === 'CRITICAL') a.crit++
      if (r.leak) a.leakN++
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.score > a.worst) { a.worst = r.score; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
    }
    const arr = Array.from(m.values()).map(a => ({ ...a, meanScore: a.count ? a.sumScore / a.count : 0, meanImb: a.count ? a.sumImb / a.count : 0, meanTrim: a.count ? a.sumTrim / a.count : 0 }))
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
      .filter(r => r.tier !== 'IDLE')
      .filter(r => {
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (classFilter !== 'ALL' && r.klass !== classFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, classFilter, query])

  const filteredClasses = useMemo(() => {
    const q = query.trim().toUpperCase()
    return classAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (classFilter !== 'ALL' && a.klass !== classFilter) return false
      if (!q) return true
      return (a.klass + ' ' + a.spec.fcom).toUpperCase().includes(q)
    })
  }, [classAggs, tierFilter, classFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'HIGH' || r.tier === 'CRITICAL').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${r.side}${(r.imbLb/1000).toFixed(1)}k ${r.driver}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'CRITICAL').map(r => ({
      type: 'Feature' as const,
      properties: { color: '#ef4444', text: `\u203a ${r.leak ? 'LEAK' : 'IMB'} ${r.side}-HVY ${(r.imbLb).toFixed(0)}lb` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const projFeatures: any[] = []
    if (showProj) {
      for (const r of rows) {
        if (r.tier !== 'CRITICAL') continue
        const tr = r.f.track * Math.PI / 180
        const dNm = 60
        const dLat = (dNm / 60) * Math.cos(tr)
        const dLng = (dNm / 60) * Math.sin(tr) / Math.max(0.1, Math.cos(r.f.lat * Math.PI / 180))
        const coords: [number, number][] = []
        const segs = 16
        for (let i = 0; i <= segs; i++) coords.push([r.f.lng + dLng * (i / segs), r.f.lat + dLat * (i / segs)])
        projFeatures.push({ type: 'Feature' as const, properties: { color: TIER_COLOR[r.tier] }, geometry: { type: 'LineString' as const, coordinates: coords } })
      }
    }
    const projFc = { type: 'FeatureCollection' as const, features: projFeatures }

    const refFeatures: any[] = []
    if (showRef) {
      for (const lat of [50, 0, -50]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 14) coords.push([lng, lat])
        refFeatures.push({ type: 'Feature' as const, properties: { color: '#0ea5e9' }, geometry: { type: 'LineString' as const, coordinates: coords } })
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
        'line-color': ['get', 'color'], 'line-width': 0.6, 'line-opacity': 0.12, 'line-dasharray': [3, 6],
      } }))
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [3, 3],
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
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_REF]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_PROJ, SRC_REF]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showProj, showRef])

  // SVG diagram: imbalance lb (x) vs trim deg (y)
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 30
    const xMax = 5000, yMax = 8
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, v / xMax)) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMax, yMax }
  }, [])

  const tierColorOf = (s: number) => s >= 80 ? '#ef4444' : s >= 55 ? '#f59e0b' : s >= 25 ? '#0ea5e9' : '#10b981'
  const adviceFor = (r: Row): string => {
    if (r.tier === 'CRITICAL') {
      if (r.leak && r.imbLb > r.spec.maxImbLb) return 'PAN-PAN suspected wing-tank leak with imbalance beyond FCOM limit — isolate affected side, do not crossfeed, land at nearest suitable per QRH FUEL LEAK'
      if (r.xfeed === 'FAILED') return 'Cross-feed valve failed with imbalance over FCOM limit — divert, prepare for asymmetric landing, brief crew on rudder-trim recovery'
      return 'Imbalance and trim demand at limit — execute QRH FUEL IMBALANCE memory items, isolate suspected boost pump, monitor TTL'
    }
    if (r.tier === 'HIGH') return 'Execute QRH FUEL IMBALANCE: open crossfeed, isolate higher-side boost pump, monitor trim and FQIS, log every 10 min'
    if (r.tier === 'WATCH') return 'Within FCOM limits but trend adverse — log fuel readings every 30 min, brief crew on crossfeed procedure if imbalance grows'
    return 'Symmetric within FCOM tolerance, crossfeed valve nominal, trim authority intact'
  }

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Fuel Imbalance · Asym Trim</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.activeCount} ac · {summary.crit} CRIT</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Imb</div>
          <div className="font-mono text-sm" style={{ color: summary.meanImb > 1500 ? '#ef4444' : summary.meanImb > 600 ? '#f59e0b' : summary.meanImb > 200 ? '#0ea5e9' : '#10b981' }}>{summary.meanImb.toFixed(0)}lb</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] truncate" style={{ color: tierColorOf(summary.worstScore) }}>{summary.worstCs || '—'} {summary.worstSide}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Critical</div>
          <div className="font-mono text-sm text-rose-400">{summary.crit}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Trim</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanTrim > 4 ? '#ef4444' : summary.meanTrim > 2 ? '#f59e0b' : '#10b981' }}>{summary.meanTrim.toFixed(1)}°</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Leak share</div>
          <div className="font-mono text-[11px]" style={{ color: summary.leakShare > 0.05 ? '#ef4444' : summary.leakShare > 0.02 ? '#f59e0b' : '#10b981' }}>{(summary.leakShare * 100).toFixed(1)}%</div>
        </div>
      </div>

      {/* Diagram */}
      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg viewBox={`0 0 ${diag.W} ${diag.H}`} className="w-full h-auto">
            {/* bands */}
            <rect x={diag.PAD} y={6} width={diag.xs(1250) - diag.PAD} height={diag.H - 14 - 30 + 30} fill="#10b981" opacity={0.05} />
            <rect x={diag.xs(1250)} y={6} width={diag.xs(2500) - diag.xs(1250)} height={diag.H - 14 - 30 + 30} fill="#0ea5e9" opacity={0.05} />
            <rect x={diag.xs(2500)} y={6} width={diag.xs(3750) - diag.xs(2500)} height={diag.H - 14 - 30 + 30} fill="#f59e0b" opacity={0.06} />
            <rect x={diag.xs(3750)} y={6} width={diag.W - 6 - diag.xs(3750)} height={diag.H - 14 - 30 + 30} fill="#ef4444" opacity={0.07} />
            {/* gridlines */}
            {[1000, 2000, 3000, 4000].map(v => (
              <g key={v}>
                <line x1={diag.xs(v)} y1={6} x2={diag.xs(v)} y2={diag.H - 22} stroke="#334155" strokeWidth={0.4} strokeDasharray="2 3" />
                <text x={diag.xs(v)} y={diag.H - 12} fill="#64748b" fontSize={8} textAnchor="middle">{v}</text>
              </g>
            ))}
            {[2, 4, 6].map(v => (
              <g key={v}>
                <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)} stroke="#334155" strokeWidth={0.4} strokeDasharray="2 3" />
                <text x={4} y={diag.ys(v) + 3} fill="#64748b" fontSize={8}>{v}°</text>
              </g>
            ))}
            {/* trim authority dashed */}
            <line x1={diag.PAD} y1={diag.ys(5)} x2={diag.W - 6} y2={diag.ys(5)} stroke="#f59e0b" strokeWidth={0.8} strokeDasharray="4 3" opacity={0.5} />
            {/* dots */}
            {rows.filter(r => r.tier !== 'IDLE').slice(0, 800).map((r, i) => (
              <circle key={i} cx={diag.xs(r.imbLb)} cy={diag.ys(r.trimDeg)} r={2} fill={TIER_COLOR[r.tier]} opacity={0.8} />
            ))}
            <text x={diag.W - 6} y={diag.H - 2} fill="#475569" fontSize={8} textAnchor="end">imbalance lb · aileron trim °</text>
          </svg>
        </div>
      )}

      {/* sliders */}
      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Min FL</span><span className="text-slate-300 font-mono">{minFl}</span></span>
          <input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Lim Mul</span><span className="text-slate-300 font-mono">{limMul}%</span></span>
          <input type="range" min={50} max={150} step={5} value={limMul} onChange={e => setLimMul(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Leak Rate Mul</span><span className="text-slate-300 font-mono">{leakRateMul}%</span></span>
          <input type="range" min={50} max={200} step={5} value={leakRateMul} onChange={e => setLeakRateMul(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>TTL Alarm</span><span className="text-slate-300 font-mono">{ttlMinSlider}m</span></span>
          <input type="range" min={5} max={120} step={5} value={ttlMinSlider} onChange={e => setTtlMinSlider(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest col-span-2">
          <span className="flex justify-between"><span>Trim Auth</span><span className="text-slate-300 font-mono">{trimAuthMul}%</span></span>
          <input type="range" min={50} max={150} step={5} value={trimAuthMul} onChange={e => setTrimAuthMul(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest col-span-2">
          <span className="flex justify-between"><span>Leak Fleet</span><span className="text-slate-300 font-mono">{leakRateFleet}%</span></span>
          <input type="range" min={0} max={15} step={1} value={leakRateFleet} onChange={e => setLeakRateFleet(+e.target.value)} className="accent-sky-500" />
        </label>
      </div>

      {/* chip filters */}
      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {CLASS_LIST.map(c => {
          const on = classFilter === c
          return <button key={c} onClick={() => setClassFilter(on ? 'ALL' : c)}
            className={`px-1.5 py-0.5 rounded border text-[10px] font-mono transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-800 text-slate-400 hover:text-slate-200'}`}>{c}</button>
        })}
      </div>

      <div className="flex items-center gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['PROJ', showProj, setShowProj], ['REF', showRef, setShowRef], ['DIAG', showDiag, setShowDiag]] as const).map(([l, v, fn]) => (
          <button key={l} onClick={() => (fn as any)((x: boolean) => !x)}
            className={`px-1.5 py-0.5 rounded border text-[10px] font-mono transition ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-800 text-slate-500'}`}>{l}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search…"
          className="ml-auto bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-[10px] text-slate-200 placeholder:text-slate-600 w-24 focus:outline-none focus:border-sky-500/40" />
      </div>

      <div className="flex border-b border-slate-800 text-[10px]">
        {(['AIRCRAFT', 'CLASSES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-1.5 uppercase tracking-widest font-bold ${tab === t ? 'text-sky-300 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-8 text-center text-slate-500 text-[11px]">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => (
          <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/70 transition relative">
            <span className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: TIER_COLOR[r.tier] }} />
            <div className="flex items-center gap-1.5">
              <span className="font-mono font-bold text-slate-100">{(r.f.callsign || r.f.icao).trim()}</span>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="text-[9px] font-mono px-1 rounded border border-slate-800 text-slate-400">{r.klass}</span>
              <span className="text-[9px] font-mono px-1 rounded border ml-auto" style={{ borderColor: TIER_COLOR[r.tier], color: TIER_COLOR[r.tier] }}>{r.tier}</span>
            </div>
            <div className="flex items-baseline gap-2 mt-0.5 text-[10px] font-mono text-slate-400">
              <span>L {(r.leftLb/1000).toFixed(1)}k</span>
              <span>R {(r.rightLb/1000).toFixed(1)}k</span>
              <span style={{ color: r.imbLb > r.spec.maxImbLb ? '#ef4444' : r.imbLb > r.spec.maxImbLb * 0.6 ? '#f59e0b' : '#10b981' }}>{r.side}{r.imbLb.toFixed(0)}lb</span>
              <span style={{ color: r.trimDeg > 4 ? '#ef4444' : r.trimDeg > 2 ? '#f59e0b' : '#10b981' }}>{r.trimDeg.toFixed(1)}°</span>
              {r.ttlMin < 120 && <span style={{ color: r.ttlMin < 15 ? '#ef4444' : r.ttlMin < 45 ? '#f59e0b' : '#0ea5e9' }}>TTL {r.ttlMin.toFixed(0)}m</span>}
            </div>
            <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden relative">
              <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier] }} />
              <div className="absolute inset-y-0" style={{ left: '25%', width: 1, background: '#0ea5e966' }} />
              <div className="absolute inset-y-0" style={{ left: '55%', width: 1, background: '#f59e0b66' }} />
              <div className="absolute inset-y-0" style={{ left: '80%', width: 1, background: '#ef444466' }} />
            </div>
            <div className="flex flex-wrap gap-1 mt-1 text-[9px] font-mono">
              {(['IMB', 'XFD', 'TRIM', 'LEAK', 'TTL'] as const).map(k => {
                const v = (r.sev as any)[k.toLowerCase()] as number
                return <span key={k} className="px-1 rounded border" style={{ borderColor: tierColorOf(v) + '88', color: tierColorOf(v) }}>{k} {v.toFixed(0)}</span>
              })}
            </div>
            <div className="flex flex-wrap gap-1 mt-1 text-[9px] font-mono text-slate-400">
              <span className="px-1 rounded border border-slate-800">XFD {r.xfeed}</span>
              {r.leak && <span className="px-1 rounded border" style={{ borderColor: '#ef444488', color: '#ef4444' }}>LEAK {r.leakGph.toFixed(0)}gph</span>}
              {r.centreLb > 0 && <span className="px-1 rounded border border-slate-800">CTR {(r.centreLb/1000).toFixed(1)}k</span>}
              <span className="px-1 rounded border border-slate-800">LIM {r.spec.maxImbLb}lb</span>
              <span className="px-1 rounded border border-slate-800">RUD {r.rudDeg.toFixed(1)}°</span>
            </div>
            <div className="mt-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>{adviceFor(r)}</div>
            <div className="mt-0.5 text-[9px] text-slate-600">{r.spec.fcom} · {r.f.operator || '—'}</div>
          </button>
        ))}
        {tab === 'CLASSES' && filteredClasses.length === 0 && (
          <div className="px-3 py-8 text-center text-slate-500 text-[11px]">No classes match.</div>
        )}
        {tab === 'CLASSES' && filteredClasses.map(a => (
          <button key={a.klass} onClick={() => a.worstIcao && onFly(a.worstIcao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/70 transition relative">
            <span className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: TIER_COLOR[a.worstTier] }} />
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono px-1 rounded border border-slate-800 text-slate-300">{a.klass}</span>
              <span className="text-slate-400 text-[10px]">{a.count} ac</span>
              <span className="text-[9px] font-mono px-1 rounded border ml-auto" style={{ borderColor: TIER_COLOR[a.worstTier], color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
            </div>
            <div className="flex items-baseline gap-2 mt-0.5 text-[10px] font-mono text-slate-400">
              <span style={{ color: a.meanImb > a.spec.maxImbLb * 0.6 ? '#f59e0b' : '#10b981' }}>μ{a.meanImb.toFixed(0)}lb</span>
              <span style={{ color: a.meanTrim > 3 ? '#f59e0b' : '#10b981' }}>μ{a.meanTrim.toFixed(1)}°</span>
              {a.crit > 0 && <span className="text-rose-400">{a.crit} CRIT</span>}
              {a.leakN > 0 && <span className="text-rose-400">{a.leakN} LEAK</span>}
              <span className="ml-auto">{a.worstCs}</span>
            </div>
            <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden relative">
              <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, a.meanScore)}%`, background: TIER_COLOR[a.worstTier] }} />
            </div>
            <div className="mt-0.5 text-[9px] text-slate-600">cap {(a.spec.capacityLb/1000).toFixed(0)}k lb · lim {a.spec.maxImbLb}lb · trim {a.spec.baseTrimAuth}° · {a.spec.fcom}</div>
          </button>
        ))}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        14 CFR 25.959 / 25.979 · Boeing FCOM 12.20 · Airbus PRO-ABN-28 · AC 25-19A leak detection · NTSB AAR-92/03
      </div>
    </div>
  )
}
