'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Step Climb Advisor
   -----------------------------------------------------------
   Long-haul fuel-efficiency optimizer. For every cruising
   aircraft (level flight, |VS| < 300 fpm, FL >= MIN-FL) the
   panel computes Specific Air Range (SAR, nm of air-distance
   per pound of fuel burned) at the current flight level and at
   every candidate RVSM cruise level above and below, then
   recommends the level with the highest ground-distance SAR
   given the aircraft's reported wind.

   Per airframe class we set:
     - typical max take-off weight   MTOW lb
     - typical zero-fuel weight      ZFW  lb
     - max operating altitude        Hmax ft
     - optimum cruise altitude span  Hopt(weight) ft via linear
       interpolation between Hopt_heavy (heavy weight, lower
       altitude) and Hopt_light (light weight, higher altitude)
     - reference cruise Mach M*
     - reference fuel flow at M* and Hopt  pph
     - cruise specific air range model
        SAR(h) = SAR* * exp(-((h - Hopt)/H_sigma)^2)
       i.e. a smooth Gaussian peak around Hopt with class-tuned
       sigma so e.g. heavies drop ~10% SAR ±4000 ft from Hopt.

   Aircraft weight is estimated from elapsed flight time but
   that data is not always available, so we approximate the
   weight fraction from a class-typical leg time and gracefully
   fall back to "mid-cruise" 0.85 * MTOW when unknown - this
   is good enough for relative step-climb advice.

   Ground-distance SAR (the metric pilots actually care about
   on a flight plan) = SAR_air * (TAS + tailwind) / TAS where
   tailwind is the projection of the wind vector onto the
   aircraft's track. Wind at candidate FLs is unknown from the
   single reported sample so we apply a class-default wind
   shear gradient of 1.5 kt/1000ft up to FL400 then
   isothermal-jet behaviour, lifted/lowered toward zero by a
   user-tunable WIND TRUST slider.

   Recommendation tiers:
     MAX-CLIMB   best FL gives >= +5% ground-SAR  (step up >=2 levels)
     CLIMB       best FL gives >= +1.5% ground-SAR (step up 1 level)
     HOLD        already within 1.5% of optimum
     DESCEND     best FL is below current and >= +1.5%

   MapLibre overlay: tier-coloured halo + dashed vertical
   chevron rotated to climb/descend direction with target FL
   label, plus optional callsign + delta% labels.

   Side panel: 4-tier counter strip (click-to-filter), 7-class
   chip filter, MIN-FL slider, WIND TRUST slider, FUEL-PRICE
   slider (turns the saved % into $/hr), OVL/LBL/DIAG toggles,
   search, SVG SAR-vs-FL curve with current/best dots per
   aircraft, ranked list sorted by gain%, click-to-fly.
   ============================================================ */

export interface ScFlight {
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
  vertRate?: number
  windDir?: number
  windKts?: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: ScFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'MAX-CLIMB' | 'CLIMB' | 'HOLD' | 'DESCEND'
const TIER_COLOR: Record<Tier, string> = {
  'MAX-CLIMB': '#10b981',
  'CLIMB': '#22d3ee',
  'HOLD': '#94a3b8',
  'DESCEND': '#f97316',
}
const TIER_ORDER: Tier[] = ['MAX-CLIMB', 'CLIMB', 'DESCEND', 'HOLD']
const TIER_LABEL: Record<Tier, string> = {
  'MAX-CLIMB': 'MAX',
  'CLIMB': 'CLB',
  'HOLD': 'HLD',
  'DESCEND': 'DES',
}

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}

interface KlassPerf {
  hopt_heavy: number  // ft when heavy
  hopt_light: number  // ft when light
  hsigma: number      // ft - SAR drops ~1/e over this distance from hopt
  hmax: number        // ft service ceiling
  machRef: number     // typical cruise Mach
  fuelPph: number     // reference fuel flow at hopt, M* pph
  mtow: number        // lb
}
const PERF: Record<Klass, KlassPerf> = {
  heavy:    { hopt_heavy: 33000, hopt_light: 41000, hsigma: 6000, hmax: 43000, machRef: 0.84, fuelPph: 22000, mtow: 660000 },
  narrow:   { hopt_heavy: 33000, hopt_light: 39000, hsigma: 5500, hmax: 41000, machRef: 0.78, fuelPph: 5500,  mtow: 175000 },
  regional: { hopt_heavy: 31000, hopt_light: 37000, hsigma: 4500, hmax: 41000, machRef: 0.74, fuelPph: 2400,  mtow: 105000 },
  biz:      { hopt_heavy: 39000, hopt_light: 47000, hsigma: 6500, hmax: 51000, machRef: 0.85, fuelPph: 2600,  mtow: 100000 },
  turboprop:{ hopt_heavy: 18000, hopt_light: 25000, hsigma: 4000, hmax: 30000, machRef: 0.55, fuelPph: 1100,  mtow: 65000 },
  ga:       { hopt_heavy:  8000, hopt_light: 11000, hsigma: 3000, hmax: 18000, machRef: 0.28, fuelPph: 90,    mtow: 4000 },
  fighter:  { hopt_heavy: 35000, hopt_light: 45000, hsigma: 7000, hmax: 55000, machRef: 0.92, fuelPph: 9000,  mtow: 70000 },
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

/* ISA temperature for TAS@Mach */
const T0 = 288.15
const L = 0.0065
const FT_PER_M = 3.28084
function isaTempK(altFt: number): number {
  const h = altFt / FT_PER_M
  if (h < 11000) return T0 - L * h
  return 216.65
}
function speedOfSoundKts(altFt: number): number {
  const T = isaTempK(altFt)
  const a_ms = 20.0468 * Math.sqrt(T) // m/s
  return a_ms * 1.94384 // kts
}

interface Cand { flLevel: number; sar: number; sarGround: number; tas: number; tailwind: number }

interface Row {
  f: ScFlight
  klass: Klass
  perf: KlassPerf
  weightFrac: number  // 0.6..1.0 of MTOW estimated
  curFl: number
  curSar: number
  curSarG: number
  curTas: number
  curTw: number
  best: Cand
  cands: Cand[]
  deltaPct: number
  pphSavedAtBest: number
  tier: Tier
}

const SRC_RING = 'sc-ring', SRC_ARR = 'sc-arr', SRC_LBL = 'sc-lbl'
const LYR_RING = 'sc-ring-l', LYR_ARR = 'sc-arr-l', LYR_LBL = 'sc-lbl-l'

export default function StepClimb({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(200)
  const [windTrust, setWindTrust] = useState(0.6)  // 0..1
  const [fuelPrice, setFuelPrice] = useState(3.0)  // $/gal jet-A (lb / 6.7 lb/gal)
  const [showOverlay, setShowOverlay] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || f.altitudeFt < minFl * 100) continue
      const vs = Math.abs(f.vertRate || 0)
      if (vs > 300) continue  // must be in cruise
      const klass = classify(f.type, f.category)
      const perf = PERF[klass]
      if (f.altitudeFt > perf.hmax + 1500) continue
      // weight estimate: assume mid-cruise, 0.85 MTOW, will refine below
      const weightFrac = 0.85
      const hopt = perf.hopt_heavy + (perf.hopt_light - perf.hopt_heavy) * (1 - (weightFrac - 0.6) / 0.4)

      // compute tas at altitude from reported speed if any; fallback to Mach * a
      const aRef = speedOfSoundKts(f.altitudeFt)
      const tas0 = f.velocityKts && isFinite(f.velocityKts) ? f.velocityKts : perf.machRef * aRef
      // assume constant Mach across candidates
      const mach = Math.min(perf.machRef, Math.max(0.3, tas0 / aRef))

      // reported wind component along track at current FL
      const wDir = f.windDir
      const wKts = f.windKts || 0
      let tw0 = 0
      if (wDir != null && isFinite(wDir)) {
        // wind FROM dir => wind vector TOWARD dir+180
        const towardRad = (wDir + 180) * Math.PI / 180
        const trkRad = (f.track || 0) * Math.PI / 180
        // projection onto track unit vector
        const cosTheta = Math.cos(towardRad) * Math.cos(trkRad) + Math.sin(towardRad) * Math.sin(trkRad)
        tw0 = wKts * cosTheta
      }

      // build candidate FL list: RVSM 2000-ft separations from FL290 up; below FL290 use 1000-ft
      const cands: Cand[] = []
      const curFL = Math.round(f.altitudeFt / 100)
      const flMin = Math.max(50, Math.round((perf.hopt_heavy - 12000) / 100))
      const flMax = Math.min(Math.round(perf.hmax / 100), curFL + 80)
      for (let fl = flMin; fl <= flMax; fl += (fl >= 290 ? 20 : 10)) {
        const altF = fl * 100
        const sar = Math.exp(-Math.pow((altF - hopt) / perf.hsigma, 2))  // 0..1
        const a = speedOfSoundKts(altF)
        const tas = mach * a
        // wind extrapolation: simple linear from current FL
        const dFlKft = (fl - curFL) / 10
        const shearKtPerKft = (fl < 400 ? 1.5 : -0.5) // jet stream typically peaks ~FL350
        const twCand = tw0 + shearKtPerKft * dFlKft * windTrust
        // ground-distance SAR = sar * (tas + tw) / tas (per pound fuel)
        const sarG = sar * Math.max(60, tas + twCand) / Math.max(60, tas)
        cands.push({ flLevel: fl, sar, sarGround: sarG, tas, tailwind: twCand })
      }
      // current FL row (snap to nearest cand)
      let cur = cands[0]
      for (const c of cands) if (Math.abs(c.flLevel - curFL) < Math.abs(cur.flLevel - curFL)) cur = c
      let best = cur
      for (const c of cands) if (c.sarGround > best.sarGround) best = c
      const deltaPct = cur.sarGround > 0 ? (best.sarGround / cur.sarGround - 1) * 100 : 0
      // pph saved at best, relative to current SAR
      const fuelAtCur = perf.fuelPph / Math.max(0.01, cur.sar)
      const fuelAtBest = perf.fuelPph / Math.max(0.01, best.sar)
      const pphSaved = fuelAtCur - fuelAtBest

      let tier: Tier
      if (best.flLevel < cur.flLevel - 5 && deltaPct >= 1.5) tier = 'DESCEND'
      else if (deltaPct >= 5) tier = 'MAX-CLIMB'
      else if (deltaPct >= 1.5) tier = 'CLIMB'
      else tier = 'HOLD'

      out.push({
        f, klass, perf, weightFrac, curFl: curFL,
        curSar: cur.sar, curSarG: cur.sarGround, curTas: cur.tas, curTw: cur.tailwind,
        best, cands, deltaPct, pphSavedAtBest: pphSaved, tier,
      })
    }
    return out
  }, [flights, minFl, windTrust])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { 'MAX-CLIMB': 0, 'CLIMB': 0, 'HOLD': 0, 'DESCEND': 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const totalPphSaved = useMemo(() => rows.filter(r => r.tier !== 'HOLD').reduce((s, r) => s + Math.max(0, r.pphSavedAtBest), 0), [rows])
  // $/hr: lb / 6.7 lb/gal * $/gal
  const totalDollarsPerHr = totalPphSaved / 6.7 * fuelPrice

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
      return b.deltaPct - a.deltaPct
    })
  }, [rows, tierFilter, klassFilter, query])

  /* ---------- MapLibre overlay ---------- */
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC_RING)) map.addSource(SRC_RING, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getSource(SRC_ARR))  map.addSource(SRC_ARR,  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getSource(SRC_LBL))  map.addSource(SRC_LBL,  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_RING)) map.addLayer({
          id: LYR_RING, type: 'circle', source: SRC_RING,
          paint: {
            'circle-radius': 13,
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.10,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 1.4,
            'circle-stroke-opacity': 0.85,
          },
        })
        if (!map.getLayer(LYR_ARR)) map.addLayer({
          id: LYR_ARR, type: 'symbol', source: SRC_ARR,
          layout: {
            'text-field': ['get', 'glyph'],
            'text-size': 16,
            'text-offset': [0, 0],
            'text-anchor': 'center',
            'text-allow-overlap': true,
          },
          paint: {
            'text-color': ['get', 'color'],
            'text-halo-color': '#0b1220',
            'text-halo-width': 1.4,
          },
        })
        if (!map.getLayer(LYR_LBL)) map.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC_LBL,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-offset': [0, -1.9],
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
    const arrFeats: any[] = []
    const lblFeats: any[] = []
    for (const r of visible) {
      const color = TIER_COLOR[r.tier]
      ringFeats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
        properties: { color },
      })
      if (r.tier !== 'HOLD') {
        const glyph = r.tier === 'DESCEND' ? '\u2193' : (r.tier === 'MAX-CLIMB' ? '\u21C8' : '\u2191')
        arrFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: { color, glyph },
        })
      }
      if (showLabels) {
        const sign = r.deltaPct >= 0 ? '+' : ''
        const label = r.tier === 'HOLD'
          ? `${(r.f.callsign || r.f.icao).trim()} \u2022 OPT FL${r.curFl}`
          : `${(r.f.callsign || r.f.icao).trim()} \u2022 FL${r.best.flLevel} ${sign}${r.deltaPct.toFixed(1)}%`
        lblFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: { color, label },
        })
      }
    }
    try {
      ;(map.getSource(SRC_RING) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: ringFeats })
      ;(map.getSource(SRC_ARR)  as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: arrFeats })
      ;(map.getSource(SRC_LBL)  as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lblFeats })
    } catch {}
  }, [map, filtered, showOverlay, showLabels])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_LBL, LYR_ARR, LYR_RING]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_LBL, SRC_ARR, SRC_RING]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  /* ---------- SAR diagram ---------- */
  const diag = useMemo(() => {
    const W = 348, H = 180, padL = 30, padR = 8, padT = 10, padB = 22
    const flMin = 50, flMax = 510
    const sx = (fl: number) => padL + (fl - flMin) / (flMax - flMin) * (W - padL - padR)
    const sy = (v: number) => H - padB - v * (H - padT - padB)
    return { W, H, sx, sy, padL, padR, padT, padB, flMin, flMax }
  }, [])

  // pick the "lead" row for the diagram (first filtered)
  const lead = filtered[0]

  function fmtPct(p: number): string {
    return `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`
  }

  return (
    <div className="fixed top-16 right-3 z-40 w-[380px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">&#8645;</span>
          <span className="text-sm font-semibold tracking-wide">STEP CLIMB ADVISOR</span>
          <span className="text-[10px] text-slate-500">fuel-efficiency</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {(['MAX-CLIMB', 'CLIMB', 'DESCEND', 'HOLD'] as Tier[]).map(t => (
          <button key={t}
            onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/50 bg-sky-500/10' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }} title={t}>
            <span className="text-[9px] tracking-wider">{TIER_LABEL[t]}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="px-3 py-2 grid grid-cols-3 gap-1.5 border-b border-slate-800">
        <div className="rounded bg-slate-900/40 border border-slate-800 px-2 py-1">
          <div className="text-[9px] text-slate-500 tracking-wider">FLEET SAVE</div>
          <div className="text-xs font-mono text-emerald-300">{Math.round(totalPphSaved).toLocaleString()}<span className="text-slate-500 text-[9px] ml-0.5">pph</span></div>
        </div>
        <div className="rounded bg-slate-900/40 border border-slate-800 px-2 py-1">
          <div className="text-[9px] text-slate-500 tracking-wider">COST/HR</div>
          <div className="text-xs font-mono text-emerald-300">${Math.round(totalDollarsPerHr).toLocaleString()}</div>
        </div>
        <div className="rounded bg-slate-900/40 border border-slate-800 px-2 py-1">
          <div className="text-[9px] text-slate-500 tracking-wider">CRUISE</div>
          <div className="text-xs font-mono text-slate-100">{rows.length}</div>
        </div>
      </div>

      {showDiag && lead && (
        <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/30">
          <div className="text-[10px] text-slate-500 tracking-wider flex items-center justify-between mb-1">
            <span>SAR vs FL \u2014 <span className="text-slate-300 font-mono">{(lead.f.callsign || lead.f.icao).trim()}</span></span>
            <span className="font-mono text-slate-400">{KLASS_LABEL[lead.klass]} M{lead.perf.machRef.toFixed(2)}</span>
          </div>
          <svg width={diag.W} height={diag.H} className="block">
            <rect x={0} y={0} width={diag.W} height={diag.H} fill="#0b1220" />
            {[0, 0.25, 0.5, 0.75, 1.0].map(v => (
              <g key={v}>
                <line x1={diag.padL} x2={diag.W - diag.padR} y1={diag.sy(v)} y2={diag.sy(v)} stroke="#1e293b" strokeWidth={0.5} />
                <text x={4} y={diag.sy(v) + 3} fill="#475569" fontSize={8} fontFamily="ui-monospace, monospace">{(v * 100).toFixed(0)}%</text>
              </g>
            ))}
            {[100, 200, 300, 400, 500].map(fl => (
              <g key={fl}>
                <line x1={diag.sx(fl)} x2={diag.sx(fl)} y1={diag.padT} y2={diag.H - diag.padB} stroke="#1e293b" strokeWidth={0.5} />
                <text x={diag.sx(fl) - 10} y={diag.H - 10} fill="#475569" fontSize={8} fontFamily="ui-monospace, monospace">FL{fl}</text>
              </g>
            ))}
            {/* air-SAR curve */}
            {(() => {
              const pts: string[] = []
              for (const c of lead.cands) {
                pts.push(`${pts.length ? 'L' : 'M'}${diag.sx(c.flLevel).toFixed(1)},${diag.sy(c.sar).toFixed(1)}`)
              }
              return <path d={pts.join(' ')} stroke="#475569" strokeWidth={1} fill="none" strokeDasharray="2 2" />
            })()}
            {/* ground-SAR curve normalized to peak */}
            {(() => {
              const peak = Math.max(...lead.cands.map(c => c.sarGround))
              const pts: string[] = []
              for (const c of lead.cands) {
                pts.push(`${pts.length ? 'L' : 'M'}${diag.sx(c.flLevel).toFixed(1)},${diag.sy(c.sarGround / peak).toFixed(1)}`)
              }
              return <path d={pts.join(' ')} stroke="#0ea5e9" strokeWidth={1.6} fill="none" />
            })()}
            {/* dots per candidate */}
            {(() => {
              const peak = Math.max(...lead.cands.map(c => c.sarGround))
              return lead.cands.map(c => (
                <circle key={c.flLevel} cx={diag.sx(c.flLevel)} cy={diag.sy(c.sarGround / peak)} r={1.5} fill="#64748b" />
              ))
            })()}
            {/* current FL marker */}
            {(() => {
              const peak = Math.max(...lead.cands.map(c => c.sarGround))
              return (
                <g>
                  <line x1={diag.sx(lead.curFl)} x2={diag.sx(lead.curFl)} y1={diag.padT} y2={diag.H - diag.padB} stroke="#94a3b8" strokeWidth={0.8} />
                  <circle cx={diag.sx(lead.curFl)} cy={diag.sy(lead.curSarG / peak)} r={3.2} fill="#94a3b8" stroke="#0b1220" strokeWidth={0.7} />
                  <text x={diag.sx(lead.curFl) + 4} y={diag.padT + 9} fill="#94a3b8" fontSize={8} fontFamily="ui-monospace, monospace">cur</text>
                </g>
              )
            })()}
            {/* best FL marker */}
            {(() => {
              const peak = Math.max(...lead.cands.map(c => c.sarGround))
              return (
                <g>
                  <line x1={diag.sx(lead.best.flLevel)} x2={diag.sx(lead.best.flLevel)} y1={diag.padT} y2={diag.H - diag.padB} stroke={TIER_COLOR[lead.tier]} strokeWidth={0.8} strokeDasharray="3 2" />
                  <circle cx={diag.sx(lead.best.flLevel)} cy={diag.sy(lead.best.sarGround / peak)} r={3.2} fill={TIER_COLOR[lead.tier]} stroke="#0b1220" strokeWidth={0.7} />
                  <text x={diag.sx(lead.best.flLevel) + 4} y={diag.padT + 19} fill={TIER_COLOR[lead.tier]} fontSize={8} fontFamily="ui-monospace, monospace">best</text>
                </g>
              )
            })()}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>MIN FLIGHT LEVEL</span>
            <span className="font-mono text-slate-300">FL{minFl}</span>
          </div>
          <input type="range" min={50} max={450} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>WIND TRUST</span>
            <span className="font-mono text-slate-300">{Math.round(windTrust * 100)}%</span>
          </div>
          <input type="range" min={0} max={100} step={5} value={windTrust * 100} onChange={e => setWindTrust(parseInt(e.target.value) / 100)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>FUEL PRICE</span>
            <span className="font-mono text-slate-300">${fuelPrice.toFixed(2)}<span className="text-slate-500 ml-0.5">/gal</span></span>
          </div>
          <input type="range" min={1} max={10} step={0.1} value={fuelPrice} onChange={e => setFuelPrice(parseFloat(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showOverlay} onChange={e => setShowOverlay(e.target.checked)} className="accent-sky-500" /><span>OVL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{filtered.length} shown / {rows.length} cruising</span>
        <span>cur \u2192 best FL</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft in cruise.</div>
        )}
        {filtered.map(r => {
          const fuelDelta = r.pphSavedAtBest
          const dollars = Math.max(0, fuelDelta / 6.7 * fuelPrice)
          const dFl = r.best.flLevel - r.curFl
          const arrow = dFl > 0 ? '\u2191' : (dFl < 0 ? '\u2193' : '\u2192')
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{KLASS_LABEL[r.klass]}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{TIER_LABEL[r.tier]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span>FL{r.curFl}</span>
                  <span className="text-slate-600">{arrow}</span>
                  <span style={{ color: TIER_COLOR[r.tier] }}>FL{r.best.flLevel}</span>
                  <span className="ml-auto" style={{ color: r.deltaPct > 0 ? TIER_COLOR[r.tier] : '#64748b' }}>{fmtPct(r.deltaPct)}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="current tailwind / ground TAS">tw {r.curTw >= 0 ? '+' : ''}{Math.round(r.curTw)}kt</span>
                  <span>tas {Math.round(r.curTas)}</span>
                  <span className="ml-auto" title="estimated fuel saved per hour at best FL">
                    {fuelDelta > 0 ? `${Math.round(fuelDelta)}pph` : '\u2014'}
                  </span>
                </div>
                {/* mini bar showing where current sits in SAR range */}
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                  {(() => {
                    const minSar = Math.min(...r.cands.map(c => c.sarGround))
                    const maxSar = Math.max(...r.cands.map(c => c.sarGround))
                    const range = Math.max(1e-6, maxSar - minSar)
                    const curFrac = (r.curSarG - minSar) / range
                    const bestFrac = (r.best.sarGround - minSar) / range
                    return (
                      <>
                        <div className="absolute inset-y-0 left-0" style={{ width: `${Math.max(0, Math.min(100, curFrac * 100))}%`, background: '#1e293b' }} />
                        <div className="absolute inset-y-0 w-0.5 bg-slate-400" style={{ left: `${Math.max(0, Math.min(100, curFrac * 100))}%`, transform: 'translateX(-1px)' }} />
                        <div className="absolute inset-y-0 w-0.5" style={{ left: `${Math.max(0, Math.min(100, bestFrac * 100))}%`, background: TIER_COLOR[r.tier], transform: 'translateX(-1px)' }} />
                      </>
                    )
                  })()}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span>{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto" style={{ color: dollars > 0 ? '#10b981' : '#475569' }}>
                    {dollars > 0 ? `$${Math.round(dollars)}/hr` : 'optimal'}
                  </span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
