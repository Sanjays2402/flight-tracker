'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Hypoxia Monitor / Rapid Decompression Survivability
   -----------------------------------------------------------
   A real aviation-safety concern: at high cruise altitudes an
   unannounciated cabin depressurization gives the flight crew
   only seconds of useful consciousness (TUC) to don oxygen
   masks and begin an emergency descent to a breathable altitude
   (typically 10,000 ft MSL where ambient pO2 ~ 14.7 kPa is
   sufficient for unaided consciousness).

   This panel turns every airborne aircraft on the map into a
   live decompression risk picture by combining three sub-models:

   1) Cabin-altitude model.
      Modern pressurized airliners hold cabin altitude well
      below cruise. Per ICAO Annex 6 / FAR 25.841 the cabin must
      not exceed 8 000 ft under normal ops. Class-tunable
      cabin-differential pressure dP (psi):
        heavy   8.95   (B777 9.4, A380 9.5, B747 9.4)
        narrow  8.30   (A320 8.1, B737 8.65)
        regional 7.50  (E190 7.8, CRJ 8.3)
        biz     9.40   (G650 10.69, GLEX 9.95) — keeps cabin <FL060 to FL510
        turboprop 5.50 (Q400 5.46, ATR 6.0)
        ga      0.00   (unpressurized)
        fighter 5.00   (F-16 5 psi)
      Given dP psi -> isobaric inversion (ISA) gives cabin
      pressure altitude h_cabin = isaPressureAlt(P_outside + dP*6894.76 Pa).

   2) Time-of-Useful-Consciousness (TUC) after a rapid
      decompression. FAA AC 61-107B Table 1-1 values, fitted to
      a smooth curve over the FL150..FL550 band:
        FL150  30 min   FL250  3-5 min   FL350  30-60 sec
        FL180  20-30m   FL280  2.5-3m    FL400  15-20 sec
        FL220  10 min   FL300  1-2 min   FL450  9-15 sec
        FL250  3-5 min  FL350  30-60s    FL500+ 6-9 sec
      Use TUC_sec = clamp( 1800 * exp(-(FL-150)/40) , 6 , 1800 )
      Modified for rapid-decompression (RD) factor 0.33x at
      >=FL400 per FAA "rapid decompression cuts TUC by 1/3".

   3) Emergency-descent profile to 10 000 ft.
      Standard airline EMER DESC: idle thrust, speedbrake out,
      Mach .82/300 KIAS until 10 000 ft. Average ROD by class:
        heavy/narrow 6 000 fpm
        regional    5 000 fpm
        biz         8 000 fpm
        turboprop   3 500 fpm
        fighter    15 000 fpm
      Time to safe altitude: T_safe = (alt_ft - 10000) / ROD_fpm.

   Survivability margin (sec) = TUC_RD - T_safe_sec.
   Tier:
     SAFE     margin >= 60s AND cabin altitude < 8 000 ft
     WATCH    margin >= 20s
     WARN     margin >= 0
     CRITICAL margin <  0   (cannot descend to FL100 before TUC)

   MapLibre overlay paints tier-coloured halo rings on every
   monitored aircraft, dashed projected emergency-descent track
   showing the great-circle ground path covered during T_safe
   (current ground speed projected forward along track), and an
   amber diamond at the projected safe-altitude waypoint, plus
   callsign + TUC labels.

   Side panel: 4-tier counter strip (click-to-filter), 7-class
   chip filter row, MIN-FL slider, cabin-dP override slider,
   OVL/LBL/PROJ toggles, search, SVG TUC curve with each
   aircraft plotted as a tier-coloured dot, ranked list sorted
   tier-worst-first then ascending margin, click-to-fly per row.
   ============================================================ */

export interface HxFlight {
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
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: HxFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'SAFE' | 'WATCH' | 'WARN' | 'CRITICAL'
const TIER_COLOR: Record<Tier, string> = {
  SAFE: '#10b981',
  WATCH: '#fbbf24',
  WARN: '#f97316',
  CRITICAL: '#ef4444',
}
const TIER_ORDER: Tier[] = ['CRITICAL', 'WARN', 'WATCH', 'SAFE']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}
const KLASS_DP_PSI: Record<Klass, number> = {
  heavy: 8.95, narrow: 8.30, regional: 7.50, biz: 9.40, turboprop: 5.50, ga: 0, fighter: 5.0,
}
const KLASS_ROD_FPM: Record<Klass, number> = {
  heavy: 6000, narrow: 6000, regional: 5000, biz: 8000, turboprop: 3500, ga: 1500, fighter: 15000,
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
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'ga'
  if (/^(B19|B20|B30|B35|B40|B45|B55|B58|B95|B96|B99|EMB|E11|PA31|PA42|PC9|KODI)/.test(x)) return 'turboprop'
  return 'narrow'
}

/* ISA pressure / altitude */
const T0 = 288.15
const P0 = 101325 // Pa
const L = 0.0065 // K/m
const FT_PER_M = 3.28084
function isaPressurePa(altFt: number): number {
  const h = altFt / FT_PER_M
  if (h < 11000) return P0 * Math.pow(1 - (L * h) / T0, 5.25588)
  // isothermal 11-20 km
  const P11 = P0 * Math.pow(1 - (L * 11000) / T0, 5.25588)
  return P11 * Math.exp(-(h - 11000) / 6341.62)
}
function isaAltFromPressure(P: number): number {
  const P11 = P0 * Math.pow(1 - (L * 11000) / T0, 5.25588)
  let h: number
  if (P >= P11) {
    h = (T0 / L) * (1 - Math.pow(P / P0, 1 / 5.25588))
  } else {
    h = 11000 + (-6341.62) * Math.log(P / P11)
  }
  return h * FT_PER_M
}
const PSI_TO_PA = 6894.757

function tucSec(cabinFt: number, rapid: boolean): number {
  // FAA AC 61-107B Table 1-1 fit, smooth exp decay
  const fl = Math.max(0, cabinFt / 100)
  if (fl < 100) return 1e6 // effectively unlimited below FL100
  const sec = 1800 * Math.exp(-(fl - 150) / 40)
  let v = Math.max(6, Math.min(1800, sec))
  if (rapid && fl >= 300) v *= 0.33
  return v
}

interface Row {
  f: HxFlight
  klass: Klass
  altFt: number
  cabinFt: number       // estimated cabin altitude in normal cruise
  cabinFtPostRD: number // cabin altitude after rapid decompression (= outside alt)
  tucSec: number        // TUC after RD
  rodFpm: number
  tSafeSec: number      // seconds to descend to 10kft
  marginSec: number     // TUC - tSafe
  projLat: number       // projected lat at safe altitude waypoint
  projLng: number
  projNm: number        // nm covered during descent
  tier: Tier
}

const SRC_RING = 'hx-ring', SRC_PROJ = 'hx-proj', SRC_DOT = 'hx-dot', SRC_LBL = 'hx-lbl'
const LYR_RING = 'hx-ring-l', LYR_PROJ = 'hx-proj-l', LYR_DOT = 'hx-dot-l', LYR_LBL = 'hx-lbl-l'

function projectGreatCircle(lat: number, lng: number, bearingDeg: number, distNm: number): { lat: number, lng: number } {
  const R = 3440.065 // nm
  const d = distNm / R
  const br = bearingDeg * Math.PI / 180
  const φ1 = lat * Math.PI / 180
  const λ1 = lng * Math.PI / 180
  const sφ2 = Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(br)
  const φ2 = Math.asin(sφ2)
  const y = Math.sin(br) * Math.sin(d) * Math.cos(φ1)
  const x = Math.cos(d) - Math.sin(φ1) * sφ2
  const λ2 = λ1 + Math.atan2(y, x)
  return { lat: φ2 * 180 / Math.PI, lng: ((λ2 * 180 / Math.PI + 540) % 360) - 180 }
}

export default function HypoxiaMonitor({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(100)
  const [dpOffset, setDpOffset] = useState(0)  // psi offset on top of class default
  const [rapid, setRapid] = useState(true)
  const [showOverlay, setShowOverlay] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || f.altitudeFt < minFl * 100) continue
      const klass = classify(f.type, f.category)
      const alt = f.altitudeFt
      // normal cabin altitude via dP
      const dp = Math.max(0, KLASS_DP_PSI[klass] + dpOffset)
      const pOut = isaPressurePa(alt)
      const pCabin = pOut + dp * PSI_TO_PA
      const cabinFt = Math.min(alt, isaAltFromPressure(Math.min(P0, pCabin)))
      // post-RD: cabin altitude jumps to outside altitude
      const cabinFtPostRD = alt
      const tuc = tucSec(cabinFtPostRD, rapid)
      const rod = KLASS_ROD_FPM[klass]
      const tSafe = Math.max(0, (alt - 10000) / rod) * 60 // sec
      const margin = tuc - tSafe
      // project ground track for tSafe
      const gs = Math.max(60, f.velocityKts || 0)
      const nm = (tSafe / 3600) * gs
      const proj = projectGreatCircle(f.lat, f.lng, f.track, nm)
      let tier: Tier
      if (margin < 0) tier = 'CRITICAL'
      else if (margin < 20) tier = 'WARN'
      else if (margin < 60 || cabinFt > 8000) tier = 'WATCH'
      else tier = 'SAFE'
      out.push({
        f, klass, altFt: alt, cabinFt, cabinFtPostRD,
        tucSec: tuc, rodFpm: rod, tSafeSec: tSafe, marginSec: margin,
        projLat: proj.lat, projLng: proj.lng, projNm: nm, tier,
      })
    }
    return out
  }, [flights, minFl, dpOffset, rapid])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { SAFE: 0, WATCH: 0, WARN: 0, CRITICAL: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return (r.f.callsign || '').toLowerCase().includes(q)
        || r.f.icao.toLowerCase().includes(q)
        || (r.f.type || '').toLowerCase().includes(q)
        || (r.f.operator || '').toLowerCase().includes(q)
    }).sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return a.marginSec - b.marginSec
    })
  }, [rows, tierFilter, klassFilter, query])

  /* ---------- MapLibre overlay ---------- */
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC_RING)) map.addSource(SRC_RING, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getSource(SRC_PROJ)) map.addSource(SRC_PROJ, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getSource(SRC_DOT)) map.addSource(SRC_DOT, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getSource(SRC_LBL)) map.addSource(SRC_LBL, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_RING)) map.addLayer({
          id: LYR_RING, type: 'circle', source: SRC_RING,
          paint: {
            'circle-radius': 14,
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.12,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 1.5,
            'circle-stroke-opacity': 0.85,
          },
        })
        if (!map.getLayer(LYR_PROJ)) map.addLayer({
          id: LYR_PROJ, type: 'line', source: SRC_PROJ,
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 1.5,
            'line-opacity': 0.7,
            'line-dasharray': [3, 2],
          },
        })
        if (!map.getLayer(LYR_DOT)) map.addLayer({
          id: LYR_DOT, type: 'circle', source: SRC_DOT,
          paint: {
            'circle-radius': 5,
            'circle-color': '#fbbf24',
            'circle-stroke-color': '#0b1220',
            'circle-stroke-width': 1.2,
          },
        })
        if (!map.getLayer(LYR_LBL)) map.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC_LBL,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-offset': [0, -1.8],
            'text-anchor': 'bottom',
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': ['get', 'color'],
            'text-halo-color': '#0b1220',
            'text-halo-width': 1.2,
          },
        })
      } catch {}
    }
    if (map.isStyleLoaded()) ensure()
    else map.once('load', ensure)
  }, [map])

  useEffect(() => {
    if (!map) return
    const visible = showOverlay ? filtered : []
    const ringFeats: any[] = []
    const projFeats: any[] = []
    const dotFeats: any[] = []
    const lblFeats: any[] = []
    for (const r of visible) {
      ringFeats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
        properties: { color: TIER_COLOR[r.tier] },
      })
      if (showProj && r.projNm > 0.1) {
        projFeats.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.projLng, r.projLat]] },
          properties: { color: TIER_COLOR[r.tier] },
        })
        dotFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.projLng, r.projLat] },
          properties: {},
        })
      }
      if (showLabels) {
        const t = r.tucSec >= 60 ? `${Math.round(r.tucSec/60)}m` : `${Math.round(r.tucSec)}s`
        const m = r.marginSec >= 0 ? `+${Math.round(r.marginSec)}s` : `${Math.round(r.marginSec)}s`
        lblFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: {
            color: TIER_COLOR[r.tier],
            label: `${(r.f.callsign || r.f.icao).trim()} \u2022 TUC ${t} \u2022 ${m}`,
          },
        })
      }
    }
    try {
      ;(map.getSource(SRC_RING) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: ringFeats })
      ;(map.getSource(SRC_PROJ) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: projFeats })
      ;(map.getSource(SRC_DOT) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: dotFeats })
      ;(map.getSource(SRC_LBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lblFeats })
    } catch {}
  }, [map, filtered, showOverlay, showLabels, showProj])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_LBL, LYR_DOT, LYR_PROJ, LYR_RING]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_LBL, SRC_DOT, SRC_PROJ, SRC_RING]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  /* ---------- TUC diagram ---------- */
  const diag = useMemo(() => {
    const W = 348, H = 180, padL = 36, padR = 8, padT = 10, padB = 22
    const flMin = 100, flMax = 550
    const tMin = 5, tMax = 1800
    const sx = (fl: number) => padL + (fl - flMin) / (flMax - flMin) * (W - padL - padR)
    const sy = (t: number) => {
      // log scale
      const lt = Math.log10(Math.max(tMin, Math.min(tMax, t)))
      const lMin = Math.log10(tMin), lMx = Math.log10(tMax)
      return H - padB - (lt - lMin) / (lMx - lMin) * (H - padT - padB)
    }
    const pts: [number, number][] = []
    for (let fl = flMin; fl <= flMax; fl += 10) {
      pts.push([fl, tucSec(fl * 100, rapid)])
    }
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ')
    return { W, H, sx, sy, path, flMin, flMax, tMin, tMax }
  }, [rapid])

  function fmtSec(s: number): string {
    if (s >= 60) {
      const m = Math.floor(s / 60), r = Math.round(s % 60)
      return `${m}:${String(r).padStart(2, '0')}`
    }
    return `${Math.round(s)}s`
  }

  return (
    <div className="fixed top-16 right-3 z-40 w-[380px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">&#9888;</span>
          <span className="text-sm font-semibold tracking-wide">HYPOXIA MONITOR</span>
          <span className="text-[10px] text-slate-500">decompression TUC</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {(['CRITICAL', 'WARN', 'WATCH', 'SAFE'] as Tier[]).map(t => (
          <button key={t}
            onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/50 bg-sky-500/10' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }} title={t}>
            <span className="text-[9px] tracking-wider">{t.slice(0, 4)}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/30">
          <div className="text-[10px] text-slate-500 tracking-wider flex items-center justify-between mb-1">
            <span>{'TUC \u2014 cabin FL vs seconds (log)'}</span>
            <span className="font-mono text-slate-400">{rapid ? 'RD' : 'slow'}</span>
          </div>
          <svg width={diag.W} height={diag.H} className="block">
            <rect x={0} y={0} width={diag.W} height={diag.H} fill="#0b1220" />
            {[5, 30, 60, 300, 1800].map(t => (
              <g key={t}>
                <line x1={36} x2={diag.W - 8} y1={diag.sy(t)} y2={diag.sy(t)} stroke="#1e293b" strokeWidth={0.5} />
                <text x={4} y={diag.sy(t) + 3} fill="#475569" fontSize={8} fontFamily="ui-monospace, monospace">{t < 60 ? `${t}s` : `${t / 60}m`}</text>
              </g>
            ))}
            {[100, 200, 300, 400, 500].map(fl => (
              <g key={fl}>
                <line x1={diag.sx(fl)} x2={diag.sx(fl)} y1={10} y2={diag.H - 22} stroke="#1e293b" strokeWidth={0.5} />
                <text x={diag.sx(fl) - 10} y={diag.H - 10} fill="#475569" fontSize={8} fontFamily="ui-monospace, monospace">FL{fl}</text>
              </g>
            ))}
            <path d={diag.path} stroke="#0ea5e9" strokeWidth={1.4} fill="none" />
            {/* aircraft dots */}
            {filtered.map(r => {
              const fl = r.cabinFtPostRD / 100
              if (fl < diag.flMin || fl > diag.flMax) return null
              const cx = diag.sx(fl), cy = diag.sy(r.tucSec)
              return <circle key={r.f.icao} cx={cx} cy={cy} r={2.8} fill={TIER_COLOR[r.tier]} stroke="#0b1220" strokeWidth={0.6} />
            })}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>MIN FLIGHT LEVEL</span>
            <span className="font-mono text-slate-300">FL{minFl}</span>
          </div>
          <input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>CABIN dP OFFSET</span>
            <span className="font-mono text-slate-300">{dpOffset >= 0 ? '+' : ''}{dpOffset.toFixed(1)} psi</span>
          </div>
          <input type="range" min={-4} max={2} step={0.1} value={dpOffset} onChange={e => setDpOffset(parseFloat(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={rapid} onChange={e => setRapid(e.target.checked)} className="accent-sky-500" /><span>RAPID</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showOverlay} onChange={e => setShowOverlay(e.target.checked)} className="accent-sky-500" /><span>OVL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{filtered.length} shown / {rows.length} airborne</span>
        <span>TUC / ROD to 10k</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {filtered.map(r => {
          const ratio = r.tucSec > 0 ? Math.max(0, Math.min(1, r.tSafeSec / r.tucSec)) : 1
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
                  <span title="aircraft altitude">FL{Math.round(r.altFt / 100)}</span>
                  <span title="estimated cabin altitude">cab {Math.round(r.cabinFt).toLocaleString()}ft</span>
                  <span className="ml-auto" title="time of useful consciousness">TUC {fmtSec(r.tucSec)}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="time to descend to 10 000 ft">desc {fmtSec(r.tSafeSec)}</span>
                  <span title="rate of descent">@ {r.rodFpm.toLocaleString()}fpm</span>
                  <span className="ml-auto" style={{ color: r.marginSec >= 0 ? '#94a3b8' : TIER_COLOR.CRITICAL }}>
                    {r.marginSec >= 0 ? '+' : ''}{Math.round(r.marginSec)}s margin
                  </span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${ratio * 100}%`, background: TIER_COLOR[r.tier], opacity: 0.55 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-300" style={{ left: '100%', transform: 'translateX(-1px)' }} />
                </div>
                <div className="flex items-center gap-2 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span>proj {r.projNm.toFixed(0)}nm</span>
                  <span className="ml-auto">desc:tuc {(ratio * 100).toFixed(0)}%</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
