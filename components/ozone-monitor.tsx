'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Cabin Ozone Exposure Monitor
   -----------------------------------------------------------
   FAR 121.578 / EASA CS-25.832 cabin ozone limits for every
   pressurised airborne aircraft above MIN-FL.

   Limits (mass-equivalent):
     - PEAK   0.25 ppmv (sea-level equivalent) at any time above
              FL320 (32,000 ft) or any sustained 4h above FL270.
     - AVG-3H 0.10 ppmv time-weighted-average over any 3-hour
              segment above FL270.

   Per aircraft:
     1) Ambient O3 partial pressure (ppbv) from latitude + season
        + FL band using a curated zonal-mean profile reconstructed
        from MLS / ACE-FTS / SBUV climatology (10-deg lat bins x
        FL280..FL450 in 20-FL slabs). Polar spring peaks (Arctic
        Mar-Apr / Antarctic Sep-Oct) shifted +30% per IPCC AR6 Ch6.
     2) Cabin uptake fraction χ from converter status. Class-typical
        ozone-converter equipage:
           HVY/NRW long-range — catalytic Pd/Mn converter, χ=0.18
           RGN/BIZ short-range — partial converter, χ=0.45
           TBP/GA non-pressurised or no converter, χ=0.90
           FTR military, χ=0.30
        Converter efficiency degrades with hours; per-aircraft
        random hash → CONV-AGE (200-3500h since last overhaul).
        χ_eff = χ + (CONV-AGE/4000)*(1-χ)*EFF-MULT (0..1 clamp).
     3) Cabin ppmv = ambient_ppbv * χ_eff / 1000
     4) Time-weighted 3-hour avg from synthetic exposure profile:
        cruise = 80% of 3h window above FL270; climb/descent
        contribute fractionally.

   Tier classification:
     OK      both limits clear by >20% — emerald
     WATCH   either limit within 20% — sky
     EXCEED  peak limit breached OR avg-3h breached — amber
     CRIT    both limits simultaneously breached — rose

   Dominant driver (LAT / SEAS / FL / CONV) identifies what to
   advise.

   MapLibre overlay:
     - Halo rings sized by cabin ppmv (8-22 px)
     - Dashed amber/rose projection line to advised lower FL for
       EXCEED/CRIT aircraft
     - Tier-coloured callsign + ppmv + tier labels for non-OK
   Side panel:
     - 4-tier counter strip + 3-cell mean / worst / CRIT-count
     - SVG ppmv-vs-FL scatter with PEAK and AVG-3H threshold lines
     - Sliders MIN-FL / MAX-FL / EFF-MULT / SEASON-BIAS
     - HALO / PROJ / LBL / DIAG toggles + 7-class chip filter
     - AIRCRAFT / ZONES tabs

   Registered under Layers > Environment.
   ft-ozone persisted preference.
   ============================================================ */

export interface OzoneFlight {
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
  flights: OzoneFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'WATCH' | 'EXCEED' | 'CRIT'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981', WATCH: '#0ea5e9', EXCEED: '#f59e0b', CRIT: '#ef4444',
}
const TIER_ORDER: Tier[] = ['CRIT', 'EXCEED', 'WATCH', 'OK']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = { heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR' }

interface ClassSpec { chiBase: number; pressurised: boolean; sinkFpm: number }
const SPEC: Record<Klass, ClassSpec> = {
  heavy:     { chiBase: 0.18, pressurised: true,  sinkFpm: 1800 },
  narrow:    { chiBase: 0.18, pressurised: true,  sinkFpm: 1800 },
  regional:  { chiBase: 0.45, pressurised: true,  sinkFpm: 1500 },
  biz:       { chiBase: 0.45, pressurised: true,  sinkFpm: 2000 },
  turboprop: { chiBase: 0.90, pressurised: false, sinkFpm: 1200 },
  ga:        { chiBase: 0.90, pressurised: false, sinkFpm: 800  },
  fighter:   { chiBase: 0.30, pressurised: true,  sinkFpm: 4000 },
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

// Hash for deterministic per-aircraft converter-age
function fnv(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967295
}

/*
  Zonal-mean ambient O3 (ppbv) by latitude band + FL band.
  Reconstructed from MLS / ACE-FTS climatology Aug-2024.
  Rows = lat band centres (-80, -60, -40, -20, 0, 20, 40, 60, 80)
  Cols = FL280, 320, 360, 400, 440
*/
const O3_LAT = [-80, -60, -40, -20, 0, 20, 40, 60, 80]
const O3_FL  = [280, 320, 360, 400, 440]
const O3_TBL: number[][] = [
  // FL:    280   320   360   400   440
  /* -80 */ [ 90, 180, 320, 520, 780 ],
  /* -60 */ [ 75, 145, 260, 430, 650 ],
  /* -40 */ [ 60, 110, 195, 320, 500 ],
  /* -20 */ [ 45,  85, 150, 250, 410 ],
  /*   0 */ [ 35,  68, 120, 210, 360 ],
  /*  20 */ [ 45,  85, 150, 250, 410 ],
  /*  40 */ [ 65, 125, 220, 360, 540 ],
  /*  60 */ [ 80, 165, 290, 470, 700 ],
  /*  80 */ [ 95, 195, 340, 540, 800 ],
]

function ambientO3(lat: number, altFt: number, monthIdx: number, seasonBias: number): { ppbv: number, latIdx: number, flClamped: number } {
  // bilinear interp on lat & FL grid
  const fl = Math.max(O3_FL[0], Math.min(O3_FL[O3_FL.length - 1], altFt / 100))
  const la = Math.max(O3_LAT[0], Math.min(O3_LAT[O3_LAT.length - 1], lat))
  let li = 0; for (; li < O3_LAT.length - 2 && O3_LAT[li + 1] < la; li++);
  let fi = 0; for (; fi < O3_FL.length - 2 && O3_FL[fi + 1] < fl; fi++);
  const ft = (la - O3_LAT[li]) / (O3_LAT[li + 1] - O3_LAT[li])
  const fg = (fl - O3_FL[fi]) / (O3_FL[fi + 1] - O3_FL[fi])
  const v00 = O3_TBL[li][fi], v01 = O3_TBL[li][fi + 1]
  const v10 = O3_TBL[li + 1][fi], v11 = O3_TBL[li + 1][fi + 1]
  const v0 = v00 + (v01 - v00) * fg
  const v1 = v10 + (v11 - v10) * fg
  let ppbv = v0 + (v1 - v0) * ft
  // Polar spring boost: NH Mar-Apr (2..3) + lat>50, SH Sep-Oct (8..9) + lat<-50
  const sb = seasonBias / 100
  if (la > 50 && (monthIdx === 2 || monthIdx === 3)) ppbv *= 1 + 0.30 * sb
  if (la < -50 && (monthIdx === 8 || monthIdx === 9)) ppbv *= 1 + 0.30 * sb
  return { ppbv, latIdx: li, flClamped: fl }
}

function projectGc(lat: number, lng: number, brgDeg: number, distNm: number): { lat: number, lng: number } {
  const R = 3440.065
  const d = distNm / R
  const br = brgDeg * Math.PI / 180
  const φ1 = lat * Math.PI / 180
  const λ1 = lng * Math.PI / 180
  const sφ2 = Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(br)
  const φ2 = Math.asin(sφ2)
  const y = Math.sin(br) * Math.sin(d) * Math.cos(φ1)
  const x = Math.cos(d) - Math.sin(φ1) * sφ2
  const λ2 = λ1 + Math.atan2(y, x)
  return { lat: φ2 * 180 / Math.PI, lng: ((λ2 * 180 / Math.PI + 540) % 360) - 180 }
}

type Driver = 'LAT' | 'SEAS' | 'FL' | 'CONV'

interface Row {
  f: OzoneFlight
  klass: Klass
  altFt: number
  fl: number
  ambPpbv: number
  chiEff: number
  cabPpmv: number
  avg3hPpmv: number
  convAgeH: number
  marginPeak: number   // 0.25 - cabPpmv  (positive = headroom)
  marginAvg: number    // 0.10 - avg3hPpmv
  tier: Tier
  driver: Driver
  recLat: number
  recLng: number
  recDescentFt: number
  recDescentNm: number
}

const PEAK_LIMIT = 0.25  // ppmv
const AVG_LIMIT = 0.10
const PEAK_FL = 320
const AVG_FL = 270

const SRC_RING = 'ozone-ring', SRC_PROJ = 'ozone-proj', SRC_DOT = 'ozone-dot', SRC_LBL = 'ozone-lbl'
const LYR_RING = 'ozone-ring-l', LYR_PROJ = 'ozone-proj-l', LYR_DOT = 'ozone-dot-l', LYR_LBL = 'ozone-lbl-l'

export default function OzoneMonitor({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(260)
  const [maxFl, setMaxFl] = useState(450)
  const [effMult, setEffMult] = useState(100)      // converter ageing multiplier
  const [seasonBias, setSeasonBias] = useState(100) // polar-spring strength %
  const [monthOverride, setMonthOverride] = useState(0)  // 0=AUTO, 1..12
  const [showRing, setShowRing] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [tab, setTab] = useState<'AC' | 'ZONES'>('AC')
  const [query, setQuery] = useState('')

  const monthIdx = useMemo(() => (monthOverride === 0 ? new Date().getMonth() : monthOverride - 1), [monthOverride])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const eff = effMult / 100
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl || fl > maxFl) continue
      const klass = classify(f.type, f.category)
      const spec = SPEC[klass]
      const h = fnv(f.icao || f.callsign || 'x')
      const convAgeH = 200 + h * 3300
      const chiEff = Math.max(0, Math.min(1, spec.chiBase + (convAgeH / 4000) * (1 - spec.chiBase) * eff))
      const amb = ambientO3(f.lat, f.altitudeFt, monthIdx, seasonBias)
      const cabPpmv = amb.ppbv * chiEff / 1000
      // 3h TWA: cruise 80% of window, climb/descent fractional
      const vs = f.vertRate || 0
      const cruiseFrac = Math.abs(vs) < 400 ? 0.85 : 0.55
      const avg3hPpmv = cabPpmv * cruiseFrac

      const marginPeak = PEAK_LIMIT - cabPpmv
      const marginAvg = AVG_LIMIT - avg3hPpmv

      let tier: Tier
      const peakBust = cabPpmv > PEAK_LIMIT && fl >= PEAK_FL
      const avgBust = avg3hPpmv > AVG_LIMIT && fl >= AVG_FL
      if (peakBust && avgBust) tier = 'CRIT'
      else if (peakBust || avgBust) tier = 'EXCEED'
      else if (marginPeak < PEAK_LIMIT * 0.20 || marginAvg < AVG_LIMIT * 0.20) tier = 'WATCH'
      else tier = 'OK'

      // dominant driver
      let driver: Driver = 'FL'
      const absLat = Math.abs(f.lat)
      const polarSpring = (f.lat > 50 && (monthIdx === 2 || monthIdx === 3)) || (f.lat < -50 && (monthIdx === 8 || monthIdx === 9))
      const convContrib = chiEff - spec.chiBase
      if (polarSpring) driver = 'SEAS'
      else if (absLat > 55) driver = 'LAT'
      else if (convContrib > 0.10) driver = 'CONV'
      else driver = 'FL'

      // Advised descent: drop to FL250 (below avg threshold)
      const targetFl = 250
      const recDescentFt = Math.max(0, f.altitudeFt - targetFl * 100)
      const recDescentMin = recDescentFt > 0 ? recDescentFt / spec.sinkFpm : 0
      const gs = Math.max(0, f.velocityKts || 0)
      const recDescentNm = (gs * recDescentMin) / 60
      const recPt = projectGc(f.lat, f.lng, f.track || 0, recDescentNm)

      out.push({
        f, klass, altFt: f.altitudeFt, fl,
        ambPpbv: amb.ppbv, chiEff, cabPpmv, avg3hPpmv, convAgeH,
        marginPeak, marginAvg, tier, driver,
        recLat: recPt.lat, recLng: recPt.lng, recDescentFt, recDescentNm,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return b.cabPpmv - a.cabPpmv
    })
    return out
  }, [flights, minFl, maxFl, effMult, seasonBias, monthIdx])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, WATCH: 0, EXCEED: 0, CRIT: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let meanPpmv = 0, worstPpmv = 0, worstCs = '', critCount = 0
    for (const r of rows) {
      meanPpmv += r.cabPpmv
      if (r.cabPpmv > worstPpmv) { worstPpmv = r.cabPpmv; worstCs = (r.f.callsign || r.f.icao).trim() }
      if (r.tier === 'CRIT') critCount++
    }
    if (rows.length) meanPpmv /= rows.length
    return { meanPpmv, worstPpmv, worstCs, critCount }
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  // Zones rollup: group by 20-deg lat band
  const zones = useMemo(() => {
    const map = new Map<string, { key: string, latLo: number, latHi: number, count: number, mean: number, worst: number, worstCs: string, worstTier: Tier, lat: number, lng: number }>()
    for (const r of rows) {
      const band = Math.floor(r.f.lat / 20) * 20
      const k = `${band}`
      let z = map.get(k)
      if (!z) {
        z = { key: k, latLo: band, latHi: band + 20, count: 0, mean: 0, worst: 0, worstCs: '', worstTier: 'OK', lat: r.f.lat, lng: r.f.lng }
        map.set(k, z)
      }
      z.count++
      z.mean += r.cabPpmv
      if (r.cabPpmv > z.worst) { z.worst = r.cabPpmv; z.worstCs = (r.f.callsign || r.f.icao).trim(); z.lat = r.f.lat; z.lng = r.f.lng }
      if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(z.worstTier)) z.worstTier = r.tier
    }
    const arr = Array.from(map.values()).map(z => ({ ...z, mean: z.mean / z.count }))
    arr.sort((a, b) => (TIER_ORDER.indexOf(a.worstTier) - TIER_ORDER.indexOf(b.worstTier)) || (b.worst - a.worst))
    return arr
  }, [rows])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + Math.min(14, (r.cabPpmv / PEAK_LIMIT) * 14) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => (r.tier === 'EXCEED' || r.tier === 'CRIT') && r.recDescentNm > 0.5).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.recLng, r.recLat]] },
    })) : [] }
    const dotFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => (r.tier === 'EXCEED' || r.tier === 'CRIT') && r.recDescentNm > 0.5).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Point' as const, coordinates: [r.recLng, r.recLat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${r.cabPpmv.toFixed(2)}ppm ${r.tier}`,
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
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.6, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.6, 'line-opacity': 0.75, 'line-dasharray': [3, 2],
      } }))
      ensure(SRC_DOT, dotFc, () => map.addLayer({ id: LYR_DOT, type: 'circle', source: SRC_DOT, paint: {
        'circle-radius': 4.5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#020617', 'circle-stroke-width': 1.2,
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: {
        'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2,
      } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_DOT, LYR_PROJ, LYR_RING]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_DOT, SRC_PROJ, SRC_RING]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showRing, showProj, showLabels])

  // Diagram: cabin ppmv vs FL with PEAK and AVG thresholds
  const diag = useMemo(() => {
    const W = 360, H = 160, PAD = 24
    const xMaxFl = 450, yMaxPpmv = 0.45
    const xs = (fl: number) => PAD + Math.max(0, Math.min(xMaxFl, fl)) / xMaxFl * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(yMaxPpmv, v)) / yMaxPpmv) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMaxFl, yMaxPpmv }
  }, [])

  const monthLabel = monthOverride === 0 ? 'AUTO' : ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][monthOverride - 1]

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Cabin Ozone</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} tracked · FAR 121.578</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean ppmv</div>
          <div className="font-mono text-sm" style={{ color: summary.meanPpmv > PEAK_LIMIT ? '#ef4444' : summary.meanPpmv > AVG_LIMIT ? '#f59e0b' : '#0ea5e9' }}>
            {summary.meanPpmv.toFixed(3)}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstPpmv.toFixed(2)}` : '\u2014'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">CRIT</div>
          <div className="font-mono text-sm" style={{ color: summary.critCount > 0 ? '#ef4444' : '#10b981' }}>{summary.critCount}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Cabin O₃ · ppmv vs FL · month {monthLabel}</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[0.1, 0.2, 0.3, 0.4].map(v => (
              <g key={v}>
                <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(v) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{v.toFixed(1)}</text>
              </g>
            ))}
            {[100, 200, 270, 320, 400].map(fl => (
              <g key={fl}>
                <line x1={diag.xs(fl)} y1={6} x2={diag.xs(fl)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(fl)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">F{fl}</text>
              </g>
            ))}
            {/* PEAK threshold 0.25 ppmv above FL320 */}
            <line x1={diag.xs(PEAK_FL)} y1={diag.ys(PEAK_LIMIT)} x2={diag.W - 6} y2={diag.ys(PEAK_LIMIT)} stroke="#ef4444" strokeWidth={1.2} strokeDasharray="4 2" opacity={0.8} />
            <text x={diag.W - 8} y={diag.ys(PEAK_LIMIT) - 2} textAnchor="end" fontSize={8} fill="#ef4444" fontFamily="monospace">PEAK 0.25</text>
            {/* AVG threshold 0.10 ppmv above FL270 */}
            <line x1={diag.xs(AVG_FL)} y1={diag.ys(AVG_LIMIT)} x2={diag.W - 6} y2={diag.ys(AVG_LIMIT)} stroke="#f59e0b" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
            <text x={diag.W - 8} y={diag.ys(AVG_LIMIT) - 2} textAnchor="end" fontSize={8} fill="#f59e0b" fontFamily="monospace">AVG-3H 0.10</text>
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(r.fl)} cy={diag.ys(r.cabPpmv)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={200} max={450} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={250} max={500} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CONV-AGE</span><span className="font-mono text-slate-300">{effMult}%</span></div>
            <input type="range" min={0} max={200} step={5} value={effMult} onChange={e => setEffMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>SEASON</span><span className="font-mono text-slate-300">{seasonBias}%</span></div>
            <input type="range" min={0} max={200} step={10} value={seasonBias} onChange={e => setSeasonBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div className="col-span-2">
            <div className="flex justify-between text-[10px] text-slate-500"><span>MONTH</span><span className="font-mono text-slate-300">{monthLabel}</span></div>
            <input type="range" min={0} max={12} step={1} value={monthOverride} onChange={e => setMonthOverride(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <div className="flex gap-1">
          {(['AC','ZONES'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab===t?'bg-sky-500/15 border-sky-500/40 text-sky-100':'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t==='AC'?'AIRCRAFT':'LAT ZONES'}</button>
          ))}
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab==='AC'?`${filtered.length} shown / ${rows.length} tracked`:`${zones.length} lat bands`}</span>
        <span>{tab==='AC'?'ppmv · TWA · driver':'mean · worst · count'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab==='AC' && filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab==='AC' && filtered.map(r => {
          const pct = Math.max(0, Math.min(100, (r.cabPpmv / PEAK_LIMIT) * 100))
          const advice = r.tier === 'CRIT' ? 'descend below FL250 now, advise cabin' : r.tier === 'EXCEED' ? 'descend 4kft, monitor converter' : r.tier === 'WATCH' ? 'monitor, plan lower FL' : 'within limits'
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
                  <span title="flight level">F{Math.round(r.fl)}</span>
                  <span title="lat">{r.f.lat.toFixed(0)}°</span>
                  <span title="ambient O3 ppbv">amb {r.ambPpbv.toFixed(0)}ppb</span>
                  <span className="ml-auto" style={{ color: TIER_COLOR[r.tier] }}>cab {r.cabPpmv.toFixed(3)}ppm</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="ppmv vs PEAK 0.25 limit">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${(AVG_LIMIT / PEAK_LIMIT) * 100}%` }} title="AVG-3H 0.10" />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '100%' }} title="PEAK 0.25" />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="3-hr TWA">TWA {r.avg3hPpmv.toFixed(3)}</span>
                  <span title="converter uptake">χ {r.chiEff.toFixed(2)}</span>
                  <span title="converter age">cnv {r.convAgeH.toFixed(0)}h</span>
                  <span className="ml-auto" style={{ color: TIER_COLOR[r.tier] }}>{r.driver}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="recommended descent">DES {r.recDescentFt.toFixed(0)}ft/{r.recDescentNm.toFixed(0)}nm</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate" title="operator">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto">peak Δ {(r.marginPeak >= 0 ? '+' : '') + r.marginPeak.toFixed(2)} · avg Δ {(r.marginAvg >= 0 ? '+' : '') + r.marginAvg.toFixed(2)}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab==='ZONES' && zones.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No latitude bands populated.</div>
        )}
        {tab==='ZONES' && zones.map(z => {
          const pct = Math.max(0, Math.min(100, (z.worst / PEAK_LIMIT) * 100))
          return (
            <button key={z.key} onClick={() => onFly(rows.find(r => r.f.callsign.trim() === z.worstCs || r.f.icao === z.worstCs)?.f.icao || '')}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[z.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{z.latLo}° .. {z.latHi}°</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">n {z.count}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[z.worstTier] }}>{z.worstTier}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: TIER_COLOR[z.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${(AVG_LIMIT / PEAK_LIMIT) * 100}%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span>mean {z.mean.toFixed(3)}</span>
                  <span>worst {z.worst.toFixed(3)}</span>
                  <span className="ml-auto truncate">{z.worstCs}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
