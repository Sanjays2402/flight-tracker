'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Mass & Balance Estimator
   -----------------------------------------------------------
   Reverse-engineers gross weight (GW) and load-factor fraction
   for every airborne aircraft by inverting steady-climb
   performance: at constant V2+climb speed the rate-of-climb is
   ROC = (T-D)·V / W (Eshelby AC perf eq 2.7), so for a given
   class thrust/drag schedule a slower-than-book climb implies a
   heavier-than-average aircraft. We blend two independent
   estimators:

     a)  GW_climb = (T_avail - D) · V_TAS / ROC_observed
         where T_avail is class-typical (de-rated) installed
         thrust × density ratio, D = 0.5·ρ·V²·S·CD0 + induced,
         observed via ADS-B vertRate + TAS-from-GS.

     b)  GW_cruise = q · S · CL / 1, where CL is from level-flight
         lift-equation at observed Mach/FL and lifting class
         reference area S; flown only when |VS|<300fpm.

   Final GW = weighted blend (climb 0.7 / cruise 0.3 when both
   valid). Load-factor LF = (GW - OEW) / (MTOW - OEW) clipped 0-1.

   Class fleet table (OEW kg / MTOW kg / S m² / CD0 / Tinst kN
   per engine × N / Vref kt / Mref):
     HVY 130000 / 380000 / 525 / 0.020 / 320×2 / 250 / 0.84
     NRW  42000 /  79000 / 124 / 0.022 / 120×2 / 230 / 0.78
     RGN  21000 /  41000 /  78 / 0.024 /  65×2 / 210 / 0.74
     BIZ  22000 /  46000 / 119 / 0.020 /  75×2 / 245 / 0.80
     TBP  10500 /  21500 /  61 / 0.030 / 1830kW×2 turboprop / 170 / 0.50
     GA    1100 /   2200 /  16 / 0.028 / 230×1 piston / 120 / 0.28
     FTR  11000 /  27000 /  78 / 0.021 / 100×2 (mil) / 350 / 0.90

   Tier (load factor LF after blending):
     LIGHT   LF<0.30 emerald (ferry / training / ULTRA-light)
     STD     LF<0.65 sky (typical revenue load)
     HEAVY   LF<0.90 amber (full pax+freight, watch perf)
     MAX     LF>=0.90 rose (at/above MTOW limit — V1/V2 risk)

   Per-aircraft also computes:
     - Vs1g stall speed at observed GW = V·sqrt(CL/CLmax) so
       margin Vs vs current TAS
     - Required runway TODR_est = 12·GW/MTOW²·MTOW kg / 1000 m
       (linearised Boeing-FCOM TOR scaling)
     - Balanced-field hint: at MAX tier flag "V1 critical"
     - Cruise specific range SR_nm/kg = V_TAS / SFC·D, where
       SFC is class typical (heavy 0.55 / narrow 0.60 / etc)

   MapLibre overlay:
     - Tier-coloured halo rings sized by GW magnitude (8-22px)
     - Dashed tier-coloured vertical bar at aircraft showing
       LF gauge (0-100% from below the dot)
     - HEAVY/MAX aircraft get callsign + GW-tons + LF-percent
       labels (LIGHT/STD suppressed to keep map quiet)

   Side panel: 4-tier counter strip click-to-filter, 3-cell
   FLEET-LF / WORST-LF callsign / MAX-COUNT summary, SVG
   GW-vs-FL scatter (x FL 0-450, y GW tons 0-400, per-class
   reference MTOW horizontals shaded, every aircraft as
   tier-coloured dot), 5 sliders (MIN-FL/MAX-FL/THRUST-FRAC
   60-110%/CD0-MULT 70-150%/STALL-MARGIN-KT 0-50), 7-class chip
   filter row, HALO/GAUGE/LBL/DIAG toggles, callsign/type/
   operator/icao search, ranked list sorted worst-tier-first
   then LF desc with tier color stripe, click-to-fly per row.

   Registered under Layers > Analysis category.
   ft-mass persisted preference.
   ============================================================ */

export interface MassFlight {
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
  flights: MassFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'LIGHT' | 'STD' | 'HEAVY' | 'MAX'
const TIER_COLOR: Record<Tier, string> = {
  LIGHT: '#10b981',
  STD: '#0ea5e9',
  HEAVY: '#f59e0b',
  MAX: '#ef4444',
}
const TIER_ORDER: Tier[] = ['MAX', 'HEAVY', 'STD', 'LIGHT']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}
const KLASS_COLOR: Record<Klass, string> = {
  heavy: '#8b5cf6', narrow: '#38bdf8', regional: '#22d3ee', biz: '#a855f7',
  turboprop: '#a3e635', ga: '#94a3b8', fighter: '#fbbf24',
}

// OEW / MTOW kg, S m², CD0, T_inst_kN (total all engines), Vref kt, Mref, CLmax, SFC kg/kN/hr
interface KSpec {
  oewKg: number; mtowKg: number; sMeter2: number; cd0: number; tKn: number;
  vrefKt: number; mref: number; clMax: number; sfcKgKnHr: number
}
const SPEC: Record<Klass, KSpec> = {
  heavy:     { oewKg: 130000, mtowKg: 380000, sMeter2: 525, cd0: 0.020, tKn: 640, vrefKt: 250, mref: 0.84, clMax: 2.6, sfcKgKnHr: 55 },
  narrow:    { oewKg:  42000, mtowKg:  79000, sMeter2: 124, cd0: 0.022, tKn: 240, vrefKt: 230, mref: 0.78, clMax: 2.7, sfcKgKnHr: 60 },
  regional:  { oewKg:  21000, mtowKg:  41000, sMeter2:  78, cd0: 0.024, tKn: 130, vrefKt: 210, mref: 0.74, clMax: 2.5, sfcKgKnHr: 65 },
  biz:       { oewKg:  22000, mtowKg:  46000, sMeter2: 119, cd0: 0.020, tKn: 150, vrefKt: 245, mref: 0.80, clMax: 2.4, sfcKgKnHr: 70 },
  turboprop: { oewKg:  10500, mtowKg:  21500, sMeter2:  61, cd0: 0.030, tKn:  90, vrefKt: 170, mref: 0.50, clMax: 2.3, sfcKgKnHr: 90 },
  ga:        { oewKg:   1100, mtowKg:   2200, sMeter2:  16, cd0: 0.028, tKn:  10, vrefKt: 120, mref: 0.28, clMax: 1.9, sfcKgKnHr: 120 },
  fighter:   { oewKg:  11000, mtowKg:  27000, sMeter2:  78, cd0: 0.021, tKn: 200, vrefKt: 350, mref: 0.90, clMax: 1.6, sfcKgKnHr: 110 },
}

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'ga'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CRJ9|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS)/.test(x)) return 'fighter'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'turboprop'
  return 'narrow'
}

// ISA density ratio (sigma) and temperature at altitude
function isaSigma(altFt: number): number {
  // Below 36089ft troposphere
  if (altFt < 36089) {
    return Math.pow(1 - 6.876e-6 * altFt, 4.2559)
  }
  return 0.2971 * Math.exp(-(altFt - 36089) / 20805)
}
function isaTempK(altFt: number): number {
  if (altFt < 36089) return 288.15 - 1.98 * (altFt / 1000)
  return 216.65
}

interface Row {
  f: MassFlight
  klass: Klass
  spec: KSpec
  altFt: number
  gs: number
  vTasKt: number
  mach: number
  vs: number
  gwKg: number
  lf: number
  oewKg: number
  mtowKg: number
  vs1gKt: number
  stallMarginKt: number
  todrM: number
  srNmKg: number
  source: 'CLIMB' | 'CRUISE' | 'BLEND' | 'SCHED'
  tier: Tier
}

const SRC_RING = 'mbm-ring', SRC_GAUGE = 'mbm-gauge', SRC_LBL = 'mbm-lbl'
const LYR_RING = 'mbm-ring-l', LYR_GAUGE = 'mbm-gauge-l', LYR_GAUGE_BG = 'mbm-gauge-bg-l', LYR_LBL = 'mbm-lbl-l'

export default function MassBalance({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(20)
  const [maxFl, setMaxFl] = useState(450)
  const [thrustFrac, setThrustFrac] = useState(85)   // % installed thrust used in climb
  const [cd0Mult, setCd0Mult] = useState(100)        // % CD0 calibration knob
  const [stallMargin, setStallMargin] = useState(20) // kt minimum acceptable Vs margin
  const [showRing, setShowRing] = useState(true)
  const [showGauge, setShowGauge] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const g = 9.80665
    const rho0 = 1.225  // kg/m^3 sea-level
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl || fl > maxFl) continue
      const klass = classify(f.type, f.category)
      const spec = SPEC[klass]
      const sigma = isaSigma(f.altitudeFt)
      const rho = rho0 * sigma
      const gs = Math.max(0, f.velocityKts || 0)
      // TAS approx from GS: use GS as proxy when no wind data; tiny altitude bias for turboprops/GA which fly slow
      const vTasKt = gs > 0 ? gs : spec.vrefKt
      const vTasMs = vTasKt * 0.5144
      const a = Math.sqrt(1.4 * 287.05 * isaTempK(f.altitudeFt))
      const mach = vTasMs / a
      const vs = f.vertRate || 0

      // Climb estimator: ROC = (T - D) * V / (W * g) → W_kg = (T - D) * V / (ROC * g)
      // T available (N) = thrustFrac/100 * Tinst_kN * 1000 * sigma^0.6 (lapse)
      const tAvailN = (thrustFrac / 100) * spec.tKn * 1000 * Math.pow(sigma, 0.6)
      // Drag at observed condition assuming CL=W/qS; we iterate but solve algebraic:
      // ROC_mps = (T - 0.5*rho*V²*S*CD0*cd0Mult/100 - k*W²/(0.5*rho*V²*S)) * V / (W * g)
      // → solving for W → quadratic, easier: numerical solve.
      const cd0eff = spec.cd0 * (cd0Mult / 100)
      const k = 1 / (Math.PI * 9.0 * 0.80)  // Oswald e=.80, AR~9
      const qS = 0.5 * rho * vTasMs * vTasMs * spec.sMeter2
      const dParasite = qS * cd0eff   // N
      // ROC in m/s
      const rocMps = vs * 0.00508

      let gwClimb = 0
      let gwCruise = 0
      let source: Row['source'] = 'SCHED'

      // Climb only when ROC > 400 fpm
      if (rocMps > (400 * 0.00508) && qS > 0) {
        // Bisection on W between OEW and 1.4*MTOW
        let lo = spec.oewKg, hi = spec.mtowKg * 1.4
        for (let i = 0; i < 36; i++) {
          const mid = (lo + hi) / 2
          const wN = mid * g
          const dInduced = (k * wN * wN) / qS
          const excess = tAvailN - dParasite - dInduced
          const rocPred = (excess * vTasMs) / wN
          if (rocPred > rocMps) lo = mid; else hi = mid
        }
        gwClimb = (lo + hi) / 2
        source = 'CLIMB'
      }

      // Cruise estimator: level flight CL = W·g/(qS); choose CL within achievable range using observed Mach for L/Dmax inversion proxy
      // Trick: at constant Mach, drag = qS·CD0 + k·W²/qS. In level cruise: T = D; assume T = T_cruise = TSFC-typical
      // Better: invert from required ROC=0 → W = sqrt((T_cruise - qS·CD0)·qS/k)
      if (Math.abs(vs) < 300 && qS > 0) {
        const tCruiseN = 0.30 * spec.tKn * 1000 * Math.pow(sigma, 0.6)  // typ cruise thrust 30% installed
        const excess = tCruiseN - dParasite
        if (excess > 0) {
          const w2 = (excess * qS) / k
          if (w2 > 0) gwCruise = Math.sqrt(w2)
        }
      }

      let gwKg: number
      if (gwClimb > 0 && gwCruise > 0) {
        gwKg = 0.7 * gwClimb + 0.3 * gwCruise
        source = 'BLEND'
      } else if (gwClimb > 0) {
        gwKg = gwClimb
        source = 'CLIMB'
      } else if (gwCruise > 0) {
        gwKg = gwCruise
        source = 'CRUISE'
      } else {
        // Schedule fallback: assume 80% MTOW at cruise FLs, OEW+30% at low FLs
        gwKg = spec.oewKg + (spec.mtowKg - spec.oewKg) * (fl > 200 ? 0.70 : 0.45)
        source = 'SCHED'
      }
      // Hard clip
      gwKg = Math.max(spec.oewKg * 0.95, Math.min(spec.mtowKg * 1.10, gwKg))

      const lf = Math.max(0, Math.min(1, (gwKg - spec.oewKg) / (spec.mtowKg - spec.oewKg)))

      // Vs1g at this GW
      // Vs (m/s) = sqrt( 2 * W*g / (rho * S * CLmax) )
      const vs1gMs = Math.sqrt((2 * gwKg * g) / (rho * spec.sMeter2 * spec.clMax))
      const vs1gKt = vs1gMs / 0.5144
      const stallMarginKt = vTasKt - vs1gKt

      // TODR linearised (m) - Boeing-FCOM scaling: TODR proportional to (GW/MTOW)^2 * baseline
      const baselineTodrM = klass === 'heavy' ? 3300 : klass === 'narrow' ? 2400 : klass === 'regional' ? 1700 :
                            klass === 'biz' ? 1800 : klass === 'turboprop' ? 1200 : klass === 'ga' ? 500 : 1500
      const todrM = baselineTodrM * Math.pow(gwKg / spec.mtowKg, 2.0)

      // Specific range nm/kg fuel
      // SR = V / (SFC * Drag); estimate cruise drag at observed condition
      const dCruise = dParasite + (k * Math.pow(gwKg * g, 2)) / Math.max(qS, 1)
      const fuelKgPerHr = (spec.sfcKgKnHr / 1000) * (dCruise) // sfcKgKnHr is per kN-hr so Drag-kN * sfcKgKnHr
      const srNmKg = fuelKgPerHr > 0 ? vTasKt / fuelKgPerHr : 0

      let tier: Tier
      if (lf < 0.30) tier = 'LIGHT'
      else if (lf < 0.65) tier = 'STD'
      else if (lf < 0.90) tier = 'HEAVY'
      else tier = 'MAX'

      out.push({
        f, klass, spec, altFt: f.altitudeFt, gs, vTasKt, mach, vs,
        gwKg, lf, oewKg: spec.oewKg, mtowKg: spec.mtowKg,
        vs1gKt, stallMarginKt, todrM, srNmKg, source, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return b.lf - a.lf
    })
    return out
  }, [flights, minFl, maxFl, thrustFrac, cd0Mult])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { LIGHT: 0, STD: 0, HEAVY: 0, MAX: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumLf = 0, n = 0, worstLf = 0, worstCs = '', maxCnt = 0
    for (const r of rows) {
      sumLf += r.lf; n++
      if (r.lf > worstLf) { worstLf = r.lf; worstCs = (r.f.callsign || r.f.icao).trim() }
      if (r.tier === 'MAX') maxCnt++
    }
    return { meanLf: n ? sumLf / n : 0, worstLf, worstCs, maxCnt, total: n }
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (r.stallMarginKt < stallMargin && tierFilter === 'ALL') {/* allowed */}
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, stallMargin, query])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + r.lf * 14 },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    // Load-factor gauge: thin coloured bar per aircraft using circle-stroke
    const gaugeFc = { type: 'FeatureCollection' as const, features: showGauge ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 3 + r.lf * 6 },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'HEAVY' || r.tier === 'MAX').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${(r.gwKg / 1000).toFixed(0)}t ${Math.round(r.lf * 100)}%`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'circle', source: SRC_RING, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.12,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.4,
        'circle-stroke-opacity': 0.8,
      } }))
      ensure(SRC_GAUGE, gaugeFc, () => {
        map.addLayer({ id: LYR_GAUGE_BG, type: 'circle', source: SRC_GAUGE, paint: {
          'circle-radius': 9,
          'circle-color': '#020617',
          'circle-opacity': 0.0,
          'circle-stroke-color': '#334155',
          'circle-stroke-width': 1,
          'circle-stroke-opacity': 0.5,
        } })
        map.addLayer({ id: LYR_GAUGE, type: 'circle', source: SRC_GAUGE, paint: {
          'circle-radius': ['get', 'radius'],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.9,
          'circle-stroke-color': '#020617',
          'circle-stroke-width': 1,
        } })
      })
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-offset': [0, 1.7],
        'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.2,
      } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_GAUGE, LYR_GAUGE_BG, LYR_RING]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_GAUGE, SRC_RING]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showRing, showGauge, showLabels])

  // SVG diagram: x = FL 0..450, y = GW tons 0..400
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 32
    const xMaxFl = 450, yMaxTons = 400
    const xs = (fl: number) => PAD + (Math.max(0, Math.min(xMaxFl, fl)) / xMaxFl) * (W - PAD - 6)
    const ys = (t: number) => 6 + (1 - Math.max(0, Math.min(yMaxTons, t)) / yMaxTons) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMaxFl, yMaxTons }
  }, [])

  const meanLfColor = summary.meanLf >= 0.90 ? '#ef4444' : summary.meanLf >= 0.65 ? '#f59e0b' : summary.meanLf >= 0.30 ? '#0ea5e9' : '#10b981'
  const worstLfColor = summary.worstLf >= 0.90 ? '#ef4444' : summary.worstLf >= 0.65 ? '#f59e0b' : summary.worstLf >= 0.30 ? '#0ea5e9' : '#10b981'

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Mass &amp; Balance · GW Estimator</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} tracked</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[10px] font-bold" style={{ color: TIER_COLOR[t] }}>{t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean LF</div>
          <div className="font-mono text-sm" style={{ color: meanLfColor }}>{(summary.meanLf * 100).toFixed(0)}<span className="text-[9px] text-slate-500"> %</span></div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] truncate" style={{ color: worstLfColor }} title={summary.worstCs}>{summary.worstCs || '\u2014'}</div>
          <div className="font-mono text-[10px]" style={{ color: worstLfColor }}>{(summary.worstLf * 100).toFixed(0)}%</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Max ›90</div>
          <div className="font-mono text-sm" style={{ color: summary.maxCnt > 0 ? '#ef4444' : '#10b981' }}>{summary.maxCnt}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Gross Weight · tons vs FL</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[0, 100, 200, 300, 400].map(v => (
              <g key={v}>
                <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(v) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{v}t</text>
              </g>
            ))}
            {[100, 200, 300, 400].map(fl => (
              <g key={fl}>
                <line x1={diag.xs(fl)} y1={6} x2={diag.xs(fl)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(fl)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">F{fl}</text>
              </g>
            ))}
            {/* Class MTOW reference horizontals */}
            {(['heavy', 'narrow', 'regional', 'biz', 'turboprop'] as Klass[]).map(k => {
              const dim = klassFilter !== 'ALL' && klassFilter !== k
              const mtTon = SPEC[k].mtowKg / 1000
              return (
                <g key={k} opacity={dim ? 0.18 : 0.9}>
                  <line x1={diag.PAD} y1={diag.ys(mtTon)} x2={diag.W - 6} y2={diag.ys(mtTon)} stroke={KLASS_COLOR[k]} strokeWidth={0.9} strokeDasharray="4 3" opacity={0.55} />
                  <text x={diag.W - 8} y={diag.ys(mtTon) - 1.5} textAnchor="end" fontSize={7} fill={KLASS_COLOR[k]} fontFamily="monospace">{KLASS_LABEL[k]} MTOW</text>
                </g>
              )
            })}
            {/* aircraft dots */}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(r.altFt / 100)} cy={diag.ys(r.gwKg / 1000)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.92} />
            ))}
            {/* legend strip */}
            <g transform={`translate(${diag.PAD + 2}, 8)`}>
              {(['heavy', 'narrow', 'regional', 'biz', 'turboprop'] as Klass[]).map((k, i) => (
                <g key={k} transform={`translate(${i * 42}, 0)`}>
                  <rect width={6} height={6} fill={KLASS_COLOR[k]} opacity={0.85} />
                  <text x={9} y={5.5} fontSize={7.2} fill={KLASS_COLOR[k]} fontFamily="monospace">{KLASS_LABEL[k]}</text>
                </g>
              ))}
            </g>
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
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={50} max={500} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>THRUST</span><span className="font-mono text-slate-300">{thrustFrac}%</span></div>
            <input type="range" min={60} max={110} step={1} value={thrustFrac} onChange={e => setThrustFrac(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CD0-MULT</span><span className="font-mono text-slate-300">{cd0Mult}%</span></div>
            <input type="range" min={70} max={150} step={1} value={cd0Mult} onChange={e => setCd0Mult(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div className="col-span-2">
            <div className="flex justify-between text-[10px] text-slate-500"><span>STALL-MGN-KT</span><span className="font-mono text-slate-300">{stallMargin}</span></div>
            <input type="range" min={0} max={50} step={1} value={stallMargin} onChange={e => setStallMargin(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klassFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['heavy', 'narrow', 'regional', 'biz', 'turboprop', 'ga', 'fighter'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klassFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{KLASS_LABEL[k]}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRing} onChange={e => setShowRing(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showGauge} onChange={e => setShowGauge(e.target.checked)} className="accent-sky-500" /><span>GAUGE</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{filtered.length} shown / {rows.length} tracked</span>
        <span>GW · LF · Vs-margin</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {filtered.map(r => {
          const lfPct = Math.round(r.lf * 100)
          const stallLow = r.stallMarginKt < stallMargin
          const stallColor = r.stallMarginKt < 10 ? '#ef4444' : r.stallMarginKt < stallMargin ? '#f59e0b' : '#10b981'
          const advice = r.tier === 'LIGHT' ? 'ferry / training weight'
            : r.tier === 'STD' ? 'normal revenue load'
            : r.tier === 'HEAVY' ? 'full load — confirm V1/V2'
            : 'at MTOW — verify perf charts'
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{KLASS_LABEL[r.klass]}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="flight level">F{Math.round(r.altFt / 100)}</span>
                  <span title="gross weight (kg)" style={{ color: TIER_COLOR[r.tier] }}>{(r.gwKg / 1000).toFixed(1)}t</span>
                  <span title="OEW..MTOW window">/ {(r.mtowKg / 1000).toFixed(0)}t</span>
                  <span className="ml-auto" title="vertical speed">{r.vs >= 0 ? '↑' : '↓'}{Math.abs(Math.round(r.vs))}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="load factor 0..100%">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${lfPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `30%` }} title="LIGHT›STD" />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `65%` }} title="STD›HEAVY" />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `90%` }} title="HEAVY›MAX" />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="load factor">LF {lfPct}%</span>
                  <span title="Mach">M{r.mach.toFixed(2)}</span>
                  <span title="true airspeed">TAS {Math.round(r.vTasKt)}</span>
                  <span title="stall speed Vs1g at this GW" style={{ color: stallColor }}>Vs {Math.round(r.vs1gKt)}</span>
                  <span className="ml-auto" title="stall margin (TAS - Vs1g)" style={{ color: stallColor }}>{stallLow ? '!' : '›'} {Math.round(r.stallMarginKt)}kt</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="estimated takeoff distance required">TODR {Math.round(r.todrM)}m</span>
                  <span title="specific range">SR {r.srNmKg.toFixed(3)}nm/kg</span>
                  <span title="estimator source">{r.source}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate" title="operator">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'LIGHT' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
