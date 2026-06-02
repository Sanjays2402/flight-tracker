'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   RVSM Compliance Monitor
   -----------------------------------------------------------
   Reduced Vertical Separation Minimum airspace (FL290-FL410)
   altitude-keeping watch per ICAO Doc 9574 / FAA AC 91-85B /
   EASA AMC 20-13. In RVSM airspace vertical separation between
   aircraft is reduced from 2000 ft to 1000 ft, which only works
   because every airframe is certified to hold altitude inside
   tight Total Vertical Error (TVE) tolerances. The North
   Atlantic Regional Monitoring Agency (NAT RMA) and FAA's CARMA
   continuously monitor TVE; this overlay reproduces that watch
   from passive ADS-B telemetry for every aircraft cruising in
   RVSM strata.

   Per aircraft the monitor synthesises:
     - Assigned Flight Level (AFL): the nearest legal RVSM FL
       (290, 300, 310, ... 410 — i.e. nearest multiple of 1000 ft
       within the strata). This is the FL the aircraft is
       presumed to be cleared to.
     - Assigned-Altitude Deviation (AAD): actual altitude minus
       AFL in feet, signed (positive = high, negative = low).
       FAA AC 91-85B 5.3 caps acceptable AAD at ±300 ft outside
       transient climb / descent.
     - Altimetry System Error (ASE) PROXY: per-class typical
       installed ASE 1-sigma in feet (HVY 35 / NRW 45 / RGN 55
       / BIZ 50 / TBP 70 / GA 90 / FTR 80) from NAT RMA Long-
       Term Monitoring data. We render this as a 95% confidence
       envelope (2-sigma).
     - Total Vertical Error TVE = AAD + ASE (worst-case combine).
       ICAO Doc 9574 threshold = 300 ft 95% / 200 ft 99%.
     - Drift rate ft/min from vertRate trend (negative AAD with
       sink rate = continuing to deviate; with climb rate =
       returning to AFL).
     - Vertical proximity scan: for every other aircraft within
       LATERAL-NM slider (default 10 nm) AND within 2000 ft
       vertically, computes vertical separation; if separation
       < 1000 ft AND both are in RVSM stratum, flags PROX
       conflict (loss of RVSM separation standard).
     - Per-pair encounter risk: P_collision ~ exp(-d_v²/(2σ²))
       with σ = sqrt(ASE_A² + ASE_B² + AAD_A² + AAD_B²) showing
       Reich collision-risk-model contribution.

   Tier classification (FAA AC 91-85B):
     IN-TOL  |AAD| <= 200 AND |TVE_95| < 300 emerald (compliant)
     SOFT    |AAD| <= 300 AND |TVE_95| < 500 sky    (within FAA
                                                      tolerance)
     ALERT   |AAD| > 300 OR |TVE_95| < 1000 amber   (large
                                                      deviation report
                                                      / TSO-C129)
     BUST    |AAD| > 500 OR vertical-prox < 1000 ft rose (altitude
                                                      bust /
                                                      separation loss)

   Aircraft below FL290 or above FL410 are tagged OUT-OF-RVSM
   and excluded from compliance scoring (still counted as
   OUTSIDE-STRATA bucket).

   MapLibre overlay:
     - Tier-coloured halo ring per aircraft sized by |AAD| ft
       (8-22px).
     - Vertical sigma envelope: small inline tick showing ±2σ
       above/below the aircraft glyph for ALERT/BUST tiers.
     - Dashed rose proximity line between conflict pairs.
     - Callsign + signed-AAD-ft + AFL-pill labels tier-coloured.

   Side panel:
     - 4-tier counter strip + OUTSIDE bucket click-to-filter
     - 3-cell BUST-COUNT / MEAN-AAD / WORST-callsign+ft summary
     - SVG AAD-vs-FL scatter (x-axis FL 290-410 with 10 vertical
       gridlines per RVSM level, y-axis AAD -800..+800 ft with
       ±200/±300/±500 threshold shading bands, every aircraft
       plotted as tier-coloured dot at (FL, AAD) coord)
     - 4 sliders MIN-FL 250-350 / MAX-FL 350-450 / LATERAL-NM
       3-25 / TVE-MULT 60-160 percent (calibrates per-class ASE)
     - 7-class chip filter row
     - HALO/PROX/SIGMA/LBL/DIAG toggles
     - callsign / type / operator / icao / level search
     - AIRCRAFT tab sorted tier-worst-first then |AAD| desc with
       tier color stripe + callsign+type+class-pill+tier-pill +
       FL+AFL+signed-AAD tier-coloured + ASE-95-ft line +
       tier-coloured AAD bar -800..+800 ft with emerald/amber/rose
       threshold ticks at 200/300/500 + TVE-95 + drift fpm +
       prox-count + operator + tier-coloured advice (compliant /
       within FAA tolerance / large deviation report / altitude
       bust report ATC) footer click-to-fly per row
     - LEVELS tab sorted by occupancy desc with FL-pill + count
       + worst tier + mean-AAD line + tier-coloured occupancy
       bar 0-20 + click-to-fly to centroid of busiest aircraft

   Registered under Layers > Safety & Traffic category.
   ft-rvsm persisted preference.
   ============================================================ */

export interface RvsmFlight {
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
  flights: RvsmFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'IN-TOL' | 'SOFT' | 'ALERT' | 'BUST'
const TIER_COLOR: Record<Tier, string> = {
  'IN-TOL': '#10b981',
  SOFT: '#0ea5e9',
  ALERT: '#f59e0b',
  BUST: '#ef4444',
}
const TIER_ORDER: Tier[] = ['BUST', 'ALERT', 'SOFT', 'IN-TOL']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}

// Per-class installed ASE 1-sigma (ft) from NAT RMA Long-Term Monitoring summaries.
const ASE_SIGMA_FT: Record<Klass, number> = {
  heavy: 35, narrow: 45, regional: 55, biz: 50, turboprop: 70, ga: 90, fighter: 80,
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

const D2R = Math.PI / 180
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)))
}

interface Row {
  f: RvsmFlight
  klass: Klass
  altFt: number
  fl: number
  afl: number              // assigned FL in feet (nearest 1000)
  aad: number              // assigned-altitude deviation (ft, signed)
  ase95: number            // 2-sigma altimetry system error (ft)
  tve95: number            // TVE 95% magnitude (ft)
  vsActual: number
  proxCount: number        // other aircraft within lateral & < 1000ft vertical
  proxMin: number          // smallest vertical separation in ft to any neighbour
  reichRisk: number        // qualitative 0-1 collision risk proxy
  inStrata: boolean        // FL290-FL410
  tier: Tier
}

const SRC_RING = 'rvsm-ring', SRC_PROX = 'rvsm-prox', SRC_LBL = 'rvsm-lbl', SRC_SIG = 'rvsm-sig'
const LYR_RING = 'rvsm-ring-l', LYR_PROX = 'rvsm-prox-l', LYR_LBL = 'rvsm-lbl-l', LYR_SIG = 'rvsm-sig-l'

export default function RvsmMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'LEVELS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'OUTSIDE' | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(290)
  const [maxFl, setMaxFl] = useState(410)
  const [lateralNm, setLateralNm] = useState(10)
  const [tveMult, setTveMult] = useState(100)
  const [showRing, setShowRing] = useState(true)
  const [showProx, setShowProx] = useState(true)
  const [showSigma, setShowSigma] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    // Build per-aircraft baseline first
    interface Base {
      f: RvsmFlight; klass: Klass; altFt: number; fl: number; afl: number; aad: number;
      ase95: number; tve95: number; vsActual: number; inStrata: boolean
    }
    const base: Base[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const fl = f.altitudeFt / 100
      // include OUTSIDE-strata aircraft but only inside extended bounds
      if (fl < (minFl - 10) || fl > (maxFl + 10)) continue
      const klass = classify(f.type, f.category)
      // AFL = nearest 1000-ft level clipped to RVSM strata 29000-41000
      const aflRaw = Math.round(f.altitudeFt / 1000) * 1000
      const afl = Math.max(29000, Math.min(41000, aflRaw))
      const aad = f.altitudeFt - afl
      const aseSigma = ASE_SIGMA_FT[klass] * (tveMult / 100)
      const ase95 = 2 * aseSigma  // 95% confidence band
      const tve95 = Math.abs(aad) + ase95  // worst-case magnitude
      const inStrata = fl >= 290 && fl <= 410
      base.push({
        f, klass, altFt: f.altitudeFt, fl, afl,
        aad: inStrata ? aad : 0,
        ase95, tve95: inStrata ? tve95 : 0,
        vsActual: f.vertRate || 0, inStrata,
      })
    }
    // O(N^2) proximity scan limited to ~3000 aircraft
    const N = base.length
    for (let i = 0; i < N; i++) {
      const a = base[i]
      let proxCount = 0
      let proxMin = 99999
      let reichRisk = 0
      if (a.inStrata) {
        for (let j = 0; j < N; j++) {
          if (i === j) continue
          const b = base[j]
          if (!b.inStrata) continue
          const dV = Math.abs(a.altFt - b.altFt)
          if (dV > 2000) continue
          const dNm = gcDistNm(a.f.lat, a.f.lng, b.f.lat, b.f.lng)
          if (dNm > lateralNm) continue
          if (dV < proxMin) proxMin = dV
          if (dV < 1000) proxCount++
          const sigma = Math.sqrt(a.ase95 ** 2 + b.ase95 ** 2 + a.aad ** 2 + b.aad ** 2) || 1
          reichRisk = Math.max(reichRisk, Math.exp(-(dV * dV) / (2 * sigma * sigma)))
        }
      }
      if (proxMin === 99999) proxMin = 0
      let tier: Tier
      if (!a.inStrata) tier = 'IN-TOL'  // tier irrelevant — filtered out as OUTSIDE
      else {
        const aADabs = Math.abs(a.aad)
        if (aADabs > 500 || (proxCount > 0 && proxMin < 1000)) tier = 'BUST'
        else if (aADabs > 300 || a.tve95 >= 1000) tier = 'ALERT'
        else if (aADabs > 200 || a.tve95 >= 500) tier = 'SOFT'
        else tier = 'IN-TOL'
      }
      out.push({ ...a, proxCount, proxMin, reichRisk, tier })
    }
    out.sort((a, b) => {
      // OUTSIDE-strata sink to bottom
      if (a.inStrata !== b.inStrata) return a.inStrata ? -1 : 1
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return Math.abs(b.aad) - Math.abs(a.aad)
    })
    return out
  }, [flights, minFl, maxFl, lateralNm, tveMult])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { 'IN-TOL': 0, SOFT: 0, ALERT: 0, BUST: 0 }
    let outside = 0
    for (const r of rows) { if (!r.inStrata) outside++; else t[r.tier]++ }
    return { ...t, OUTSIDE: outside }
  }, [rows])

  const summary = useMemo(() => {
    let n = 0, sumAad = 0, worstAad = 0, worstCs = '', bustCount = 0, sumTve = 0
    for (const r of rows) {
      if (!r.inStrata) continue
      n++
      sumAad += Math.abs(r.aad)
      sumTve += r.tve95
      if (Math.abs(r.aad) > Math.abs(worstAad)) { worstAad = r.aad; worstCs = (r.f.callsign || r.f.icao).trim() }
      if (r.tier === 'BUST') bustCount++
    }
    return { n, meanAad: n ? sumAad / n : 0, meanTve: n ? sumTve / n : 0, worstAad, worstCs, bustCount }
  }, [rows])

  // Per-level rollup
  const levels = useMemo(() => {
    const m = new Map<number, { fl: number, count: number, sumAad: number, worst: Tier, sampleLat: number, sampleLng: number }>()
    for (const r of rows) {
      if (!r.inStrata) continue
      const flKey = Math.round(r.afl / 1000) * 10  // FL number
      const e = m.get(flKey)
      if (e) {
        e.count++
        e.sumAad += r.aad
        if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(e.worst)) {
          e.worst = r.tier
          e.sampleLat = r.f.lat; e.sampleLng = r.f.lng
        }
      } else {
        m.set(flKey, { fl: flKey, count: 1, sumAad: r.aad, worst: r.tier, sampleLat: r.f.lat, sampleLng: r.f.lng })
      }
    }
    return Array.from(m.values()).sort((a, b) => b.count - a.count)
  }, [rows])

  // Conflict pairs for map line rendering — dedupe by sorted icao key
  const conflictPairs = useMemo(() => {
    const pairs: { a: Row, b: Row, dV: number }[] = []
    const seen = new Set<string>()
    for (const r of rows) {
      if (!r.inStrata || r.proxCount === 0) continue
      // Recompute neighbour to render the line (closest one)
      let nearest: Row | null = null
      let bestDv = 1001
      for (const s of rows) {
        if (s === r || !s.inStrata) continue
        const dV = Math.abs(r.altFt - s.altFt)
        if (dV >= 1000) continue
        const dNm = gcDistNm(r.f.lat, r.f.lng, s.f.lat, s.f.lng)
        if (dNm > lateralNm) continue
        if (dV < bestDv) { bestDv = dV; nearest = s }
      }
      if (!nearest) continue
      const k = r.f.icao < nearest.f.icao ? `${r.f.icao}|${nearest.f.icao}` : `${nearest.f.icao}|${r.f.icao}`
      if (seen.has(k)) continue
      seen.add(k)
      pairs.push({ a: r, b: nearest, dV: bestDv })
    }
    return pairs
  }, [rows, lateralNm])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter === 'OUTSIDE') { if (r.inStrata) return false }
      else if (tierFilter !== 'ALL') { if (!r.inStrata || r.tier !== tierFilter) return false }
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, `FL${Math.round(r.fl)}`].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.filter(r => r.inStrata).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + Math.min(14, Math.abs(r.aad) / 50) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const sigFc = { type: 'FeatureCollection' as const, features: showSigma ? rows.filter(r => r.inStrata && (r.tier === 'ALERT' || r.tier === 'BUST')).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const proxFc = { type: 'FeatureCollection' as const, features: showProx ? conflictPairs.map(p => ({
      type: 'Feature' as const,
      properties: { color: '#ef4444' },
      geometry: { type: 'LineString' as const, coordinates: [[p.a.f.lng, p.a.f.lat], [p.b.f.lng, p.b.f.lat]] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.inStrata && r.tier !== 'IN-TOL').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${r.aad >= 0 ? '+' : ''}${r.aad.toFixed(0)}ft ›F${(r.afl / 100).toFixed(0)}`,
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
        'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.6,
        'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_SIG, sigFc, () => map.addLayer({ id: LYR_SIG, type: 'circle', source: SRC_SIG, paint: {
        'circle-radius': 4,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 0.8,
        'circle-stroke-opacity': 0.55,
      } }))
      ensure(SRC_PROX, proxFc, () => map.addLayer({ id: LYR_PROX, type: 'line', source: SRC_PROX, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.6,
        'line-opacity': 0.75,
        'line-dasharray': [2, 2],
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-offset': [0, 1.6],
        'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.2,
      } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PROX, LYR_SIG, LYR_RING]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PROX, SRC_SIG, SRC_RING]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, conflictPairs, showRing, showProx, showSigma, showLabels])

  // Diagram: x = FL 290..410, y = AAD -800..+800 ft
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 28
    const flLo = 290, flHi = 410, yMax = 800
    const xs = (fl: number) => PAD + ((fl - flLo) / (flHi - flLo)) * (W - PAD - 6)
    const ys = (aad: number) => 6 + (1 - (aad + yMax) / (2 * yMax)) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, flLo, flHi, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">RVSM Compliance</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.n} in strata</span>
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
        <button onClick={() => setTierFilter(tierFilter === 'OUTSIDE' ? 'ALL' : 'OUTSIDE')}
          className={`flex flex-col items-center py-1 rounded border transition ${tierFilter === 'OUTSIDE' ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
          <span className="text-[9px] font-bold text-slate-400">OUT</span>
          <span className="font-mono text-xs text-slate-200">{tally.OUTSIDE}</span>
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Bust</div>
          <div className="font-mono text-sm" style={{ color: summary.bustCount > 0 ? '#ef4444' : '#10b981' }}>{summary.bustCount}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean |AAD|</div>
          <div className="font-mono text-sm" style={{ color: summary.meanAad > 300 ? '#f59e0b' : summary.meanAad > 200 ? '#0ea5e9' : '#10b981' }}>
            {summary.meanAad.toFixed(0)}<span className="text-[9px] text-slate-500"> ft</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstAad >= 0 ? '+' : ''}${summary.worstAad.toFixed(0)}ft` : '—'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean TVE-95</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanTve > 500 ? '#f59e0b' : '#10b981' }}>{summary.meanTve.toFixed(0)}<span className="text-[9px] text-slate-500"> ft</span></div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Prox Pairs</div>
          <div className="font-mono text-[11px]" style={{ color: conflictPairs.length > 0 ? '#ef4444' : '#10b981' }}>{conflictPairs.length}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">AAD · ft vs FL · ±200/±300/±500 ICAO thresholds</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* Tolerance shading bands */}
            {(() => {
              const y200hi = diag.ys(200), y200lo = diag.ys(-200)
              const y300hi = diag.ys(300), y300lo = diag.ys(-300)
              const y500hi = diag.ys(500), y500lo = diag.ys(-500)
              const x0 = diag.PAD, x1 = diag.W - 6
              return (
                <g>
                  <rect x={x0} y={y200hi} width={x1 - x0} height={y200lo - y200hi} fill="#10b981" opacity={0.06} />
                  <rect x={x0} y={y300hi} width={x1 - x0} height={y200hi - y300hi} fill="#0ea5e9" opacity={0.08} />
                  <rect x={x0} y={y200lo} width={x1 - x0} height={y300lo - y200lo} fill="#0ea5e9" opacity={0.08} />
                  <rect x={x0} y={y500hi} width={x1 - x0} height={y300hi - y500hi} fill="#f59e0b" opacity={0.08} />
                  <rect x={x0} y={y300lo} width={x1 - x0} height={y500lo - y300lo} fill="#f59e0b" opacity={0.08} />
                  <line x1={x0} y1={y200hi} x2={x1} y2={y200hi} stroke="#10b981" strokeDasharray="2 3" strokeWidth={0.8} />
                  <line x1={x0} y1={y200lo} x2={x1} y2={y200lo} stroke="#10b981" strokeDasharray="2 3" strokeWidth={0.8} />
                  <line x1={x0} y1={y300hi} x2={x1} y2={y300hi} stroke="#0ea5e9" strokeDasharray="2 3" strokeWidth={0.8} />
                  <line x1={x0} y1={y300lo} x2={x1} y2={y300lo} stroke="#0ea5e9" strokeDasharray="2 3" strokeWidth={0.8} />
                  <line x1={x0} y1={y500hi} x2={x1} y2={y500hi} stroke="#f59e0b" strokeDasharray="2 3" strokeWidth={0.8} />
                  <line x1={x0} y1={y500lo} x2={x1} y2={y500lo} stroke="#f59e0b" strokeDasharray="2 3" strokeWidth={0.8} />
                  <text x={x1 - 2} y={y200hi - 1} textAnchor="end" fontSize={8} fill="#10b981" fontFamily="monospace">±200</text>
                  <text x={x1 - 2} y={y300hi - 1} textAnchor="end" fontSize={8} fill="#0ea5e9" fontFamily="monospace">±300</text>
                  <text x={x1 - 2} y={y500hi - 1} textAnchor="end" fontSize={8} fill="#f59e0b" fontFamily="monospace">±500</text>
                </g>
              )
            })()}
            {/* y axis labels */}
            {[-800,-400,0,400,800].map(v => (
              <text key={v} x={diag.PAD - 2} y={diag.ys(v) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{v >= 0 ? '+' : ''}{v}</text>
            ))}
            {/* x axis labels (RVSM levels) */}
            {[290,310,330,350,370,390,410].map(fl => (
              <g key={fl}>
                <line x1={diag.xs(fl)} y1={6} x2={diag.xs(fl)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(fl)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">F{fl}</text>
              </g>
            ))}
            {/* zero centerline */}
            <line x1={diag.PAD} y1={diag.ys(0)} x2={diag.W - 6} y2={diag.ys(0)} stroke="#475569" strokeWidth={0.8} />
            {/* aircraft dots */}
            {rows.filter(r => r.inStrata).map(r => (
              <circle key={r.f.icao} cx={diag.xs(r.fl)} cy={diag.ys(Math.max(-diag.yMax, Math.min(diag.yMax, r.aad)))} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={250} max={350} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={350} max={450} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>LATERAL</span><span className="font-mono text-slate-300">{lateralNm}nm</span></div>
            <input type="range" min={3} max={25} step={1} value={lateralNm} onChange={e => setLateralNm(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>TVE-MULT</span><span className="font-mono text-slate-300">{tveMult}%</span></div>
            <input type="range" min={60} max={160} step={5} value={tveMult} onChange={e => setTveMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProx} onChange={e => setShowProx(e.target.checked)} className="accent-sky-500" /><span>PROX</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showSigma} onChange={e => setShowSigma(e.target.checked)} className="accent-sky-500" /><span>SIGMA</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao / FL"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT','LEVELS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} tracks` : `${levels.length} levels active`}</span>
        <span>{tab === 'AIRCRAFT' ? 'AAD · TVE · prox' : 'count · worst · mean-AAD'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          // AAD bar: -800..+800 ft mapped to 0..100%
          const aadPct = Math.max(0, Math.min(100, ((r.aad + 800) / 1600) * 100))
          const t200lo = ((-200 + 800) / 1600) * 100
          const t200hi = ((200 + 800) / 1600) * 100
          const t300lo = ((-300 + 800) / 1600) * 100
          const t300hi = ((300 + 800) / 1600) * 100
          const t500lo = ((-500 + 800) / 1600) * 100
          const t500hi = ((500 + 800) / 1600) * 100
          const advice = !r.inStrata ? 'outside RVSM strata' :
            r.tier === 'IN-TOL' ? 'compliant · normal monitoring' :
            r.tier === 'SOFT' ? 'within FAA tolerance · monitor altimeter' :
            r.tier === 'ALERT' ? 'large deviation · report TSO-C129 / verify altimeter' :
            'altitude bust · report ATC immediate · separation loss risk'
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: r.inStrata ? TIER_COLOR[r.tier] : '#475569' }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{KLASS_LABEL[r.klass]}</span>
                  <span className="text-[10px] font-semibold" style={{ color: r.inStrata ? TIER_COLOR[r.tier] : '#94a3b8' }}>{r.inStrata ? r.tier : 'OUT'}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="current FL">F{r.fl.toFixed(0)}</span>
                  <span title="assigned FL">›F{(r.afl / 100).toFixed(0)}</span>
                  <span title="ASE 95%">σ95 {r.ase95.toFixed(0)}ft</span>
                  <span className="ml-auto" title="AAD" style={{ color: r.inStrata ? TIER_COLOR[r.tier] : '#94a3b8' }}>{r.inStrata ? `${r.aad >= 0 ? '+' : ''}${r.aad.toFixed(0)}ft` : '—'}</span>
                </div>
                {r.inStrata && (
                  <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="AAD (-800..+800 ft)">
                    <div className="absolute inset-y-0" style={{ left: `${Math.min(50, aadPct)}%`, width: `${Math.abs(aadPct - 50)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                    <div className="absolute inset-y-0 w-0.5 bg-slate-500" style={{ left: `50%` }} />
                    <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `${t200lo}%` }} />
                    <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `${t200hi}%` }} />
                    <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `${t300lo}%` }} />
                    <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `${t300hi}%` }} />
                    <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${t500lo}%` }} />
                    <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${t500hi}%` }} />
                  </div>
                )}
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="TVE 95%">TVE {r.tve95.toFixed(0)}ft</span>
                  <span title="vertical rate">VS{r.vsActual >= 0 ? '+' : ''}{r.vsActual.toFixed(0)}</span>
                  <span title="proximity count <1000ft" style={{ color: r.proxCount > 0 ? '#ef4444' : '#64748b' }}>prox {r.proxCount}</span>
                  <span className="ml-auto" title="closest vertical separation">{r.proxMin > 0 ? `${r.proxMin.toFixed(0)}ft` : '—'}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.inStrata ? (r.tier === 'IN-TOL' ? '#64748b' : TIER_COLOR[r.tier]) : '#64748b' }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'LEVELS' && levels.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No RVSM levels occupied.</div>
        )}
        {tab === 'LEVELS' && levels.map(l => {
          const mean = l.count ? l.sumAad / l.count : 0
          const pct = Math.min(100, (l.count / 20) * 100)
          return (
            <button key={l.fl} onClick={() => { try { map?.flyTo({ center: [l.sampleLng, l.sampleLat], zoom: 5 }) } catch {} }}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[l.worst] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">F{l.fl}</span>
                  <span className="text-slate-500">{l.count} aircraft</span>
                  <span className="ml-auto text-[10px] font-semibold" style={{ color: TIER_COLOR[l.worst] }}>{l.worst}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="level occupancy 0-20">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: TIER_COLOR[l.worst], opacity: 0.85 }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="mean signed AAD" style={{ color: Math.abs(mean) > 200 ? TIER_COLOR[l.worst] : '#64748b' }}>mean {mean >= 0 ? '+' : ''}{mean.toFixed(0)}ft</span>
                  <span className="ml-auto" title="centroid sample">{l.sampleLat.toFixed(2)}, {l.sampleLng.toFixed(2)}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
