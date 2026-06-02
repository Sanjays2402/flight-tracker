'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Icing Hazard Monitor / Airframe Ice Accretion Risk
   -----------------------------------------------------------
   Real aviation hazard. Structural ice accretes on airframe
   leading edges, props, intakes, and pitot/static when the
   aircraft flies through supercooled liquid water (SLD) at
   SAT between roughly -20 C and +2 C in visible moisture.
   It degrades lift (CLmax drops 30-40%), adds parasite drag,
   raises stall speed, masks the AoA picture, and can cause
   roll upset or tailplane stall on approach (NTSB ATR-72
   ROSELAWN 1994, 68 fatal; Comair 3272 Detroit 1997).

   This panel turns every airborne aircraft into a live icing
   risk picture by combining four sub-models:

   1) Static Air Temperature (SAT) via ISA + user-tunable ISA
      deviation slider (-20 to +20 C). Tropospheric lapse to
      36 089 ft (11 km) at 1.98 C/1000 ft, then isothermal
      -56.5 C up to 65 000 ft. SAT = T_ISA(h) + dISA.

   2) Total Air Temperature (TAT) from kinetic heating:
        TAT = SAT * (1 + 0.2 * Kr * M^2)
      where Kr=0.98 typical recovery factor and M = TAS/a,
      a = 20.0468*sqrt(T_K) m/s. We back out true Mach from
      reported velocityKts as TAS or use reported mach when
      available. TAT is what the OAT probe actually reads.

   3) Moisture / cloud probability proxy. We don't have METAR
      cloud bases, so we model probability of visible moisture
      from altitude band + phase of flight:
        SFC-FL050   p=0.55  (boundary layer convection / fog)
        FL050-180   p=0.70  (stratus, alto, cumulus deck)
        FL180-280   p=0.45  (broken mid-level cloud)
        FL280-380   p=0.25  (high cirrus, dry stratosphere edge)
        FL380+      p=0.10  (above most weather)
      Multiplied by phase factor: climb 1.20, descent 1.30,
      cruise 0.80 (cruise legs typically planned around wx).

   4) Class-tunable anti-ice capability:
        heavy/narrow/biz/regional  BLEED  cap_factor 0.40
        turboprop                  BOOTS  cap_factor 0.65
        ga                         NONE   cap_factor 1.00
        fighter                    LIMITED cap_factor 0.80
      Final exposure = base_intensity * cap_factor.

   Base icing intensity 0..1 from SAT distance to peak icing
   band centered at -8 C with sigma 7 C, gated to zero outside
   -20..+2 C window, multiplied by moisture proxy probability.

   Tier classification:
     SEVERE  exposure >= 0.55  (rose)    accumulating fast
     MOD     exposure >= 0.30  (orange)  active protection req
     TRACE   exposure >= 0.10  (amber)   monitor + cycle boots
     CLEAR   exposure <  0.10  (sky)     no icing risk

   Time-in-band estimator: scans forward along great-circle
   track at current GS for HORIZON minutes, sampling SAT every
   30 sec from current altitude + integrated vertRate * dt.
   Reports T_IN_BAND_SEC and EXIT_ALT_FT (predicted altitude
   when SAT crosses outside icing envelope by climb).

   MapLibre overlay: tier-colored halo rings on every aircraft
   in icing envelope, dashed sky projection line to predicted
   exit waypoint with amber diamond marker, callsign + SAT +
   tier labels, plus tier-colored translucent vertical-band
   shading visible on the SVG diagram.

   Side panel: 4-tier counter strip (click-to-filter), 3-cell
   FLEET MEAN INTENSITY / WORST EXPOSURE / IN BAND summary,
   SVG SAT-vs-altitude diagram with shaded -20..+2 C icing
   envelope and each aircraft plotted as tier-colored dot;
   ISA DEV slider, HORIZON slider, MIN-FL slider, 7-class chip
   filter, HALO/PROJ/LBL/DIAG/ANTI-ICE toggles, search, ranked
   list sorted tier-worst-first then exposure desc with per-row
   color stripe, callsign+type+tier badge, SAT/TAT/FL line,
   intensity bar with anti-ice reference tick, time-in-band +
   exit altitude readout, click-to-fly per row.
   ============================================================ */

export interface IcFlight {
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
  mach?: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: IcFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'CLEAR' | 'TRACE' | 'MOD' | 'SEVERE'
const TIER_COLOR: Record<Tier, string> = {
  CLEAR: '#0ea5e9',
  TRACE: '#fbbf24',
  MOD: '#f97316',
  SEVERE: '#ef4444',
}
const TIER_ORDER: Tier[] = ['SEVERE', 'MOD', 'TRACE', 'CLEAR']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}
const KLASS_PROTECT: Record<Klass, { kind: string, factor: number }> = {
  heavy:     { kind: 'BLEED',   factor: 0.40 },
  narrow:    { kind: 'BLEED',   factor: 0.40 },
  regional:  { kind: 'BLEED',   factor: 0.45 },
  biz:       { kind: 'BLEED',   factor: 0.40 },
  turboprop: { kind: 'BOOTS',   factor: 0.65 },
  ga:        { kind: 'NONE',    factor: 1.00 },
  fighter:   { kind: 'LIMITED', factor: 0.80 },
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

/* ISA helpers */
const T0 = 288.15
const FT_PER_M = 3.28084
const TROP_FT = 36089.24
const T_TROP = 216.65 // K

function isaTempK(altFt: number): number {
  if (altFt <= TROP_FT) return T0 - 0.0019812 * altFt
  return T_TROP
}
function satCelsius(altFt: number, dISA: number): number {
  return isaTempK(altFt) - 273.15 + dISA
}
function speedOfSoundKts(tempK: number): number {
  // a = 20.0468 * sqrt(T) m/s -> convert to kts (1 m/s = 1.94384 kts)
  return 20.0468 * Math.sqrt(Math.max(150, tempK)) * 1.94384
}

function moistureP(altFt: number, vertRate: number): number {
  let base: number
  if (altFt < 5000) base = 0.55
  else if (altFt < 18000) base = 0.70
  else if (altFt < 28000) base = 0.45
  else if (altFt < 38000) base = 0.25
  else base = 0.10
  let phase = 0.80
  if (vertRate > 250) phase = 1.20
  else if (vertRate < -250) phase = 1.30
  return Math.min(1, base * phase)
}

function baseIcing(sat: number): number {
  // 0 outside -20..+2, peak at -8 C, sigma 7 C
  if (sat > 2 || sat < -20) return 0
  const x = (sat + 8) / 7
  return Math.exp(-x * x)
}

function projectGreatCircle(lat: number, lng: number, bearingDeg: number, distNm: number): { lat: number, lng: number } {
  const R = 3440.065
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

interface Row {
  f: IcFlight
  klass: Klass
  altFt: number
  satC: number
  tatC: number
  mach: number
  baseI: number
  moist: number
  expI: number              // exposure 0..1 after anti-ice factor
  tInBandSec: number        // seconds until SAT leaves icing envelope (climb path)
  exitAltFt: number
  exitLat: number
  exitLng: number
  exitNm: number
  inEnvelope: boolean
  tier: Tier
}

const SRC_RING = 'ic-ring', SRC_PROJ = 'ic-proj', SRC_DOT = 'ic-dot', SRC_LBL = 'ic-lbl'
const LYR_RING = 'ic-ring-l', LYR_PROJ = 'ic-proj-l', LYR_DOT = 'ic-dot-l', LYR_LBL = 'ic-lbl-l'

export default function IcingMonitor({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [isaDev, setIsaDev] = useState(0)
  const [horizonMin, setHorizonMin] = useState(15)
  const [useAntiIce, setUseAntiIce] = useState(true)
  const [showHalo, setShowHalo] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || f.altitudeFt < minFl * 100) continue
      const klass = classify(f.type, f.category)
      const alt = f.altitudeFt
      const sat = satCelsius(alt, isaDev)
      const tK = sat + 273.15
      const a = speedOfSoundKts(tK)
      const mach = f.mach && isFinite(f.mach) ? f.mach : (a > 0 ? (f.velocityKts || 0) / a : 0)
      const kr = 0.98
      const tatK = tK * (1 + 0.2 * kr * mach * mach)
      const tat = tatK - 273.15
      const base = baseIcing(sat)
      const moist = moistureP(alt, f.vertRate || 0)
      const protect = KLASS_PROTECT[klass]
      const factor = useAntiIce ? protect.factor : 1.0
      const exp = base * moist * factor
      // forward integrate altitude along track for horizonMin to find exit from icing envelope
      const gs = Math.max(60, f.velocityKts || 0)
      let exitT = horizonMin * 60
      let exitAlt = alt
      let inAny = false
      for (let t = 0; t <= horizonMin * 60; t += 30) {
        const aAlt = alt + (f.vertRate || 0) * (t / 60)
        const aSat = satCelsius(Math.max(0, aAlt), isaDev)
        const inB = aSat >= -20 && aSat <= 2
        if (t === 0 && inB) inAny = true
        if (inAny && !inB) { exitT = t; exitAlt = aAlt; break }
        if (t === horizonMin * 60) { exitT = inAny ? t : 0; exitAlt = aAlt }
      }
      const nmFwd = (exitT / 3600) * gs
      const proj = projectGreatCircle(f.lat, f.lng, f.track || 0, nmFwd)
      let tier: Tier
      if (exp >= 0.55) tier = 'SEVERE'
      else if (exp >= 0.30) tier = 'MOD'
      else if (exp >= 0.10) tier = 'TRACE'
      else tier = 'CLEAR'
      out.push({
        f, klass, altFt: alt, satC: sat, tatC: tat, mach,
        baseI: base, moist, expI: exp,
        tInBandSec: inAny ? exitT : 0,
        exitAltFt: exitAlt,
        exitLat: proj.lat, exitLng: proj.lng, exitNm: nmFwd,
        inEnvelope: inAny, tier,
      })
    }
    return out
  }, [flights, minFl, isaDev, horizonMin, useAntiIce])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { CLEAR: 0, TRACE: 0, MOD: 0, SEVERE: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const summary = useMemo(() => {
    let mean = 0, worst = 0, inBand = 0
    for (const r of rows) {
      mean += r.expI
      if (r.expI > worst) worst = r.expI
      if (r.inEnvelope) inBand++
    }
    return { mean: rows.length ? mean / rows.length : 0, worst, inBand }
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
      return b.expI - a.expI
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
            'circle-radius': ['interpolate', ['linear'], ['get', 'exp'], 0.1, 9, 1.0, 22],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.10,
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
    const ringFeats: any[] = []
    const projFeats: any[] = []
    const dotFeats: any[] = []
    const lblFeats: any[] = []
    for (const r of filtered) {
      if (r.tier === 'CLEAR') continue
      if (showHalo) {
        ringFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: { color: TIER_COLOR[r.tier], exp: r.expI },
        })
      }
      if (showProj && r.inEnvelope && r.exitNm > 0.5) {
        projFeats.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.exitLng, r.exitLat]] },
          properties: { color: TIER_COLOR[r.tier] },
        })
        dotFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.exitLng, r.exitLat] },
          properties: {},
        })
      }
      if (showLabels) {
        lblFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: {
            color: TIER_COLOR[r.tier],
            label: `${(r.f.callsign || r.f.icao).trim()} \u2022 SAT ${r.satC.toFixed(0)}C \u2022 ${r.tier}`,
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
  }, [map, filtered, showHalo, showProj, showLabels])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_LBL, LYR_DOT, LYR_PROJ, LYR_RING]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_LBL, SRC_DOT, SRC_PROJ, SRC_RING]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  /* ---------- SAT vs Altitude diagram ---------- */
  const diag = useMemo(() => {
    const W = 348, H = 200, padL = 38, padR = 8, padT = 10, padB = 24
    const satMin = -70, satMax = 30
    const altMin = 0, altMax = 50000
    const sx = (sat: number) => padL + (sat - satMin) / (satMax - satMin) * (W - padL - padR)
    const sy = (alt: number) => H - padB - (alt - altMin) / (altMax - altMin) * (H - padT - padB)
    // ISA curve
    const isaPts: [number, number][] = []
    for (let alt = 0; alt <= 50000; alt += 500) isaPts.push([satCelsius(alt, isaDev), alt])
    const isaPath = isaPts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ')
    // icing envelope band -20..+2 C
    const xMin = sx(-20), xMax = sx(2)
    return { W, H, sx, sy, isaPath, xMin, xMax, padT, padB, altMin, altMax }
  }, [isaDev])

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
          <span className="text-sky-400">&#10046;</span>
          <span className="text-sm font-semibold tracking-wide">ICING MONITOR</span>
          <span className="text-[10px] text-slate-500">SAT &middot; SLD risk</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {(['SEVERE', 'MOD', 'TRACE', 'CLEAR'] as Tier[]).map(t => (
          <button key={t}
            onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/50 bg-sky-500/10' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }} title={t}>
            <span className="text-[9px] tracking-wider">{t.slice(0, 4)}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="px-3 py-2 grid grid-cols-3 gap-1 border-b border-slate-800">
        <div className="rounded bg-slate-900/40 border border-slate-800 px-2 py-1 text-center">
          <div className="text-[9px] tracking-wider text-slate-500">FLEET MEAN</div>
          <div className="text-sm font-mono text-slate-200">{(summary.mean * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded bg-slate-900/40 border border-slate-800 px-2 py-1 text-center">
          <div className="text-[9px] tracking-wider text-slate-500">WORST</div>
          <div className="text-sm font-mono" style={{ color: summary.worst >= 0.55 ? TIER_COLOR.SEVERE : summary.worst >= 0.30 ? TIER_COLOR.MOD : summary.worst >= 0.10 ? TIER_COLOR.TRACE : TIER_COLOR.CLEAR }}>
            {(summary.worst * 100).toFixed(0)}%
          </div>
        </div>
        <div className="rounded bg-slate-900/40 border border-slate-800 px-2 py-1 text-center">
          <div className="text-[9px] tracking-wider text-slate-500">IN BAND</div>
          <div className="text-sm font-mono text-slate-200">{summary.inBand}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/30">
          <div className="text-[10px] text-slate-500 tracking-wider flex items-center justify-between mb-1">
            <span>SAT vs ALTITUDE &mdash; icing envelope shaded</span>
            <span className="font-mono text-slate-400">{isaDev >= 0 ? '+' : ''}{isaDev}ISA</span>
          </div>
          <svg width={diag.W} height={diag.H} className="block">
            <rect x={0} y={0} width={diag.W} height={diag.H} fill="#0b1220" />
            {/* icing envelope shaded band */}
            <rect x={diag.xMin} y={diag.padT} width={diag.xMax - diag.xMin} height={diag.H - diag.padT - diag.padB} fill="#fbbf24" opacity={0.08} />
            <line x1={diag.sx(-20)} x2={diag.sx(-20)} y1={diag.padT} y2={diag.H - diag.padB} stroke="#fbbf24" strokeWidth={0.6} strokeDasharray="2 2" opacity={0.6} />
            <line x1={diag.sx(2)} x2={diag.sx(2)} y1={diag.padT} y2={diag.H - diag.padB} stroke="#fbbf24" strokeWidth={0.6} strokeDasharray="2 2" opacity={0.6} />
            <line x1={diag.sx(-8)} x2={diag.sx(-8)} y1={diag.padT} y2={diag.H - diag.padB} stroke="#fbbf24" strokeWidth={0.8} opacity={0.45} />
            {/* axes */}
            {[-60, -40, -20, 0, 20].map(s => (
              <g key={s}>
                <line x1={diag.sx(s)} x2={diag.sx(s)} y1={diag.padT} y2={diag.H - diag.padB} stroke="#1e293b" strokeWidth={0.5} />
                <text x={diag.sx(s) - 8} y={diag.H - 10} fill="#475569" fontSize={8} fontFamily="ui-monospace, monospace">{s}C</text>
              </g>
            ))}
            {[0, 10000, 20000, 30000, 40000, 50000].map(a => (
              <g key={a}>
                <line x1={38} x2={diag.W - 8} y1={diag.sy(a)} y2={diag.sy(a)} stroke="#1e293b" strokeWidth={0.5} />
                <text x={4} y={diag.sy(a) + 3} fill="#475569" fontSize={8} fontFamily="ui-monospace, monospace">FL{a / 100}</text>
              </g>
            ))}
            {/* ISA reference */}
            <path d={diag.isaPath} stroke="#0ea5e9" strokeWidth={1.4} fill="none" opacity={0.85} />
            {/* aircraft dots */}
            {filtered.map(r => {
              if (r.satC < -70 || r.satC > 30) return null
              if (r.altFt < 0 || r.altFt > 50000) return null
              return (
                <circle key={r.f.icao} cx={diag.sx(r.satC)} cy={diag.sy(r.altFt)} r={r.tier === 'CLEAR' ? 2.0 : 2.8}
                  fill={TIER_COLOR[r.tier]} stroke="#0b1220" strokeWidth={0.6} opacity={r.tier === 'CLEAR' ? 0.6 : 1} />
              )
            })}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>ISA DEVIATION</span>
            <span className="font-mono text-slate-300">{isaDev >= 0 ? '+' : ''}{isaDev} C</span>
          </div>
          <input type="range" min={-20} max={20} step={1} value={isaDev} onChange={e => setIsaDev(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>HORIZON</span>
            <span className="font-mono text-slate-300">{horizonMin} min</span>
          </div>
          <input type="range" min={2} max={60} step={1} value={horizonMin} onChange={e => setHorizonMin(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>MIN FLIGHT LEVEL</span>
            <span className="font-mono text-slate-300">FL{minFl}</span>
          </div>
          <input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={useAntiIce} onChange={e => setUseAntiIce(e.target.checked)} className="accent-sky-500" /><span>ANTI-ICE</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{filtered.length} shown / {rows.length} airborne</span>
        <span>SAT &middot; TAT &middot; exposure</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {filtered.map(r => {
          const protect = KLASS_PROTECT[r.klass]
          const rawPct = r.baseI * r.moist * 100
          const finalPct = r.expI * 100
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
                  <span title="static air temperature">SAT {r.satC.toFixed(0)}C</span>
                  <span title="total air temperature">TAT {r.tatC.toFixed(0)}C</span>
                  <span title="mach number">M{r.mach.toFixed(2)}</span>
                  <span className="ml-auto">FL{Math.round(r.altFt / 100)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, rawPct)}%`, background: '#475569', opacity: 0.55 }} />
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, finalPct)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '55%' }} title="SEVERE threshold" />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '30%' }} title="MOD threshold" />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="anti-ice kind / factor">{protect.kind} &times;{protect.factor.toFixed(2)}</span>
                  <span title="visible moisture probability">moist {(r.moist * 100).toFixed(0)}%</span>
                  <span className="ml-auto" style={{ color: TIER_COLOR[r.tier] }}>{finalPct.toFixed(0)}%</span>
                </div>
                {r.inEnvelope && (
                  <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                    <span title="time remaining in icing envelope along projected track">in-band {fmtSec(r.tInBandSec)}</span>
                    <span title="altitude at projected exit">exit FL{Math.max(0, Math.round(r.exitAltFt / 100))}</span>
                    <span className="ml-auto">{r.exitNm.toFixed(0)}nm</span>
                  </div>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
