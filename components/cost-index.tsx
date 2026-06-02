'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Cost Index Estimator
   -----------------------------------------------------------
   Every airline assigns a Cost Index (CI) to every flight — a
   single integer 0-999 representing the dollars-per-minute
   value of time relative to dollars-per-kg of fuel. CI=0 is
   pure-economy Long-Range Cruise (LRC, minimum trip fuel).
   CI=999 is maximum-speed Mach-Max-Operating (MMO), trading
   ~10-15% extra fuel for the fastest possible block time.
   Operationally airlines pick CI somewhere between the two:
     low fuel price + on-time slack    -> CI 20-40 (lazy)
     normal ops                         -> CI 60-100 (standard)
     downline curfew / connection risk -> CI 200-400 (push)
     high-yield premium / IROPS recovery -> CI 600-999 (max)

   This panel reverse-engineers each cruising aircraft's CI by
   comparing its current Mach number to the published LRC and
   MMO Mach for its weight-class and altitude band, then maps
   the position onto the 0-999 CI scale via a calibrated
   non-linear interpolation (CI vs Mach is roughly cubic — at
   low CI Mach climbs slowly, near MMO each extra knot costs
   many CI points because SFC degrades with the wave-drag
   bucket exit). The model uses Boeing/Airbus published CI
   tables for the 737NG/A320/777/787 families fitted to:
     M(CI) = M_lrc + (M_mmo - M_lrc) * (CI/999)^0.45

   inverted: CI(M) = 999 * ((M - M_lrc) / (M_mmo - M_lrc))^(1/0.45)

   Per-class M_lrc and M_mmo (cruise, mid-weight, near optimum):
     heavy    LRC .82  MMO .88  (B777/787/A330/A350)
     narrow   LRC .77  MMO .82  (A320/B737)
     regional LRC .73  MMO .78  (E-jets, CRJs)
     biz      LRC .78  MMO .90  (G650, GLEX, GLF7)
     turboprop LRC .47  MMO .56 (Q400, ATR — propeller M limit)
     ga       LRC .25  MMO .35
     fighter  LRC .82  MMO 1.60 (afterburner regime; CI N/A)

   For aircraft with reported Mach (M_now) and altitude in the
   class's cruise band (|VS|<400fpm AND FL>=MIN-FL):
     ci_raw  = inverse curve mapped CI
     ci_eff  = clamp(ci_raw, 0, 999)

   Fuel-burn delta vs LRC:
     Class typical pph at LRC (cruise):
       heavy 6500, narrow 4400, regional 1800, biz 1700,
       turboprop 900, ga 200, fighter 5000
     SFC penalty as Mach climbs above LRC:
       pph_at_CI = pph_lrc * (1 + 0.18 * ((M - M_lrc) / (M_mmo - M_lrc))^2)
     Trip time fraction saved:
       t_frac = M_lrc / M_now  (cruise-time ratio, ground speed
              roughly proportional to Mach in still air)

   Forward-projected over user-tunable LEG-HRS slider (0.5-12h)
   gives:
     fuel_extra_kg  = (pph_at_CI - pph_lrc) * leg_hrs * 0.4536
     time_saved_min = leg_hrs * 60 * (1 - t_frac)
     economic delta = $JET_PRICE * (pph_at_CI - pph_lrc) * leg_hrs
                    - $TIME_VALUE * time_saved_min

   Classification (4 tiers):
     LAZY   ci_eff <  40   sky    (cost-conservative, on time)
     STD    ci_eff < 150   emerald (normal-airline operation)
     PUSH   ci_eff < 500   amber   (premium / recovery)
     MAX    ci_eff >= 500  rose    (max-cost, last-resort speed)

   MapLibre overlay:
     - Tier-coloured halo rings on every cruising aircraft
     - Mach + CI labels per aircraft
     - Dashed forward projection to LEG-HRS endpoint

   Side panel:
     - 4-tier counter strip click-to-filter
     - 3-cell FLEET-MEDIAN-CI / FUEL-OVER-LRC-pph / TIME-SAVED-mph
     - SVG CI-curve diagram (CI 0-999 on x-axis, Mach on y-axis,
       class curves + every aircraft plotted as tier dot)
     - LEG-HRS / JET-PRICE / TIME-VALUE / MIN-FL sliders
     - 7-class chip filter row + OVL/PROJ/LBL toggles
     - Ranked list sorted tier-MAX-first then ascending CI
   ============================================================ */

export interface CiFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  vertRate?: number
  track: number
  mach?: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: CiFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'LAZY' | 'STD' | 'PUSH' | 'MAX'
const TIER_COLOR: Record<Tier, string> = {
  LAZY: '#0ea5e9',
  STD: '#10b981',
  PUSH: '#f59e0b',
  MAX: '#ef4444',
}
const TIER_ORDER: Tier[] = ['MAX', 'PUSH', 'STD', 'LAZY']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}
const KLASS_LRC: Record<Klass, number> = { heavy: 0.82, narrow: 0.77, regional: 0.73, biz: 0.78, turboprop: 0.47, ga: 0.25, fighter: 0.82 }
const KLASS_MMO: Record<Klass, number> = { heavy: 0.88, narrow: 0.82, regional: 0.78, biz: 0.90, turboprop: 0.56, ga: 0.35, fighter: 1.60 }
const KLASS_PPH_LRC: Record<Klass, number> = { heavy: 6500, narrow: 4400, regional: 1800, biz: 1700, turboprop: 900, ga: 200, fighter: 5000 }
const KLASS_MIN_FL: Record<Klass, number> = { heavy: 280, narrow: 280, regional: 200, biz: 320, turboprop: 180, ga: 60, fighter: 300 }

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

/* CI<->Mach inversion */
function ciFromMach(m: number, mLrc: number, mMmo: number): number {
  if (mMmo <= mLrc) return 0
  const frac = (m - mLrc) / (mMmo - mLrc)
  if (frac <= 0) return 0
  if (frac >= 1) return 999
  return Math.max(0, Math.min(999, 999 * Math.pow(frac, 1 / 0.45)))
}
function machFromCi(ci: number, mLrc: number, mMmo: number): number {
  return mLrc + (mMmo - mLrc) * Math.pow(Math.max(0, Math.min(999, ci)) / 999, 0.45)
}
/* fallback Mach from TAS at altitude (ISA) */
function machFromTas(tasKts: number, altFt: number): number {
  // SAT in K via ISA
  const h = altFt / 3.28084
  const T = h < 11000 ? 288.15 - 0.0065 * h : 216.65
  const a = 20.0468 * Math.sqrt(T) * 1.94384 // kts
  return a > 0 ? tasKts / a : 0
}

interface Row {
  f: CiFlight
  klass: Klass
  mach: number
  mLrc: number
  mMmo: number
  ci: number
  pphLrc: number
  pphNow: number
  pphDelta: number      // pph extra burn vs LRC
  fuelExtraKg: number   // over LEG-HRS
  timeSavedMin: number  // over LEG-HRS
  econDelta: number     // $ net (+ = extra cost, - = saving)
  projLat: number
  projLng: number
  projNm: number
  tier: Tier
}

const SRC_RING = 'ci-ring', SRC_PROJ = 'ci-proj', SRC_DOT = 'ci-dot', SRC_LBL = 'ci-lbl'
const LYR_RING = 'ci-ring-l', LYR_PROJ = 'ci-proj-l', LYR_DOT = 'ci-dot-l', LYR_LBL = 'ci-lbl-l'

function projectGreatCircle(lat: number, lng: number, bearingDeg: number, distNm: number): { lat: number, lng: number } {
  const R = 3440.065
  const d = distNm / R
  const br = bearingDeg * Math.PI / 180
  const f1 = lat * Math.PI / 180
  const l1 = lng * Math.PI / 180
  const sf2 = Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(br)
  const f2 = Math.asin(sf2)
  const y = Math.sin(br) * Math.sin(d) * Math.cos(f1)
  const x = Math.cos(d) - Math.sin(f1) * sf2
  const l2 = l1 + Math.atan2(y, x)
  return { lat: f2 * 180 / Math.PI, lng: ((l2 * 180 / Math.PI + 540) % 360) - 180 }
}

export default function CostIndex({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(200)
  const [legHrs, setLegHrs] = useState(3)
  const [jetPrice, setJetPrice] = useState(3.2)   // $/gal, conv 6.7 lb/gal
  const [timeValue, setTimeValue] = useState(75)  // $/min (crew + slot + aircraft)
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
      const vs = Math.abs(f.vertRate || 0)
      if (vs > 400) continue // cruise only
      const klass = classify(f.type, f.category)
      if (f.altitudeFt < KLASS_MIN_FL[klass] * 100) continue
      const mLrc = KLASS_LRC[klass]
      const mMmo = KLASS_MMO[klass]
      let mach = f.mach || 0
      if (!mach || mach < 0.1) {
        // estimate Mach from TAS (assume gs ≈ tas; rough)
        mach = machFromTas(f.velocityKts || 0, f.altitudeFt)
      }
      if (!mach || mach < 0.1) continue
      const ci = ciFromMach(mach, mLrc, mMmo)
      const frac = Math.max(0, Math.min(1, (mach - mLrc) / (mMmo - mLrc)))
      const pphLrc = KLASS_PPH_LRC[klass]
      const pphNow = pphLrc * (1 + 0.18 * frac * frac)
      const pphDelta = pphNow - pphLrc
      const fuelExtraKg = pphDelta * legHrs * 0.4536
      const tFrac = mach > 0 ? mLrc / mach : 1
      const timeSavedMin = legHrs * 60 * (1 - tFrac)
      const extraGal = (pphDelta * legHrs) / 6.7
      const econDelta = jetPrice * extraGal - timeValue * timeSavedMin
      let tier: Tier
      if (ci < 40) tier = 'LAZY'
      else if (ci < 150) tier = 'STD'
      else if (ci < 500) tier = 'PUSH'
      else tier = 'MAX'
      const gs = Math.max(60, f.velocityKts || 0)
      const nm = gs * legHrs
      const proj = projectGreatCircle(f.lat, f.lng, f.track, nm)
      out.push({
        f, klass, mach, mLrc, mMmo, ci,
        pphLrc, pphNow, pphDelta, fuelExtraKg, timeSavedMin, econDelta,
        projLat: proj.lat, projLng: proj.lng, projNm: nm, tier,
      })
    }
    return out
  }, [flights, minFl, legHrs, jetPrice, timeValue])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { LAZY: 0, STD: 0, PUSH: 0, MAX: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const summary = useMemo(() => {
    if (rows.length === 0) return { medCi: 0, fuelOver: 0, timeSaved: 0 }
    const cis = rows.map(r => r.ci).sort((a, b) => a - b)
    const medCi = cis[Math.floor(cis.length / 2)]
    const fuelOver = rows.reduce((s, r) => s + r.pphDelta, 0)
    const timeSaved = rows.reduce((s, r) => s + r.timeSavedMin, 0)
    return { medCi, fuelOver, timeSaved }
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
      return a.ci - b.ci
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
            'circle-radius': ['interpolate', ['linear'], ['get', 'ci'], 0, 8, 999, 18],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.12,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 1.4,
            'circle-stroke-opacity': 0.85,
          },
        })
        if (!map.getLayer(LYR_PROJ)) map.addLayer({
          id: LYR_PROJ, type: 'line', source: SRC_PROJ,
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 1.4,
            'line-opacity': 0.6,
            'line-dasharray': [3, 2],
          },
        })
        if (!map.getLayer(LYR_DOT)) map.addLayer({
          id: LYR_DOT, type: 'circle', source: SRC_DOT,
          paint: {
            'circle-radius': 4,
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#0b1220',
            'circle-stroke-width': 1.2,
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
    const projFeats: any[] = []
    const dotFeats: any[] = []
    const lblFeats: any[] = []
    for (const r of visible) {
      ringFeats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
        properties: { color: TIER_COLOR[r.tier], ci: r.ci },
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
          properties: { color: TIER_COLOR[r.tier] },
        })
      }
      if (showLabels) {
        lblFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: {
            color: TIER_COLOR[r.tier],
            label: `${(r.f.callsign || r.f.icao).trim()} \u2022 M${r.mach.toFixed(2)} \u2022 CI${Math.round(r.ci)}`,
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

  /* ---------- CI curve diagram ---------- */
  const diag = useMemo(() => {
    const W = 348, H = 200, padL = 36, padR = 8, padT = 12, padB = 22
    const ciMin = 0, ciMax = 999
    const mMin = 0.20, mMax = 0.95
    const sx = (ci: number) => padL + (ci - ciMin) / (ciMax - ciMin) * (W - padL - padR)
    const sy = (m: number) => H - padB - (m - mMin) / (mMax - mMin) * (H - padT - padB)
    /* per-class curve */
    function curve(k: Klass): string {
      const lrc = KLASS_LRC[k], mmo = KLASS_MMO[k]
      const pts: [number, number][] = []
      for (let ci = 0; ci <= 999; ci += 20) pts.push([ci, machFromCi(ci, lrc, mmo)])
      return pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ')
    }
    const KLASS_CURVE_COLOR: Record<Klass, string> = {
      heavy: '#7c3aed', narrow: '#0ea5e9', regional: '#06b6d4', biz: '#a855f7',
      turboprop: '#84cc16', ga: '#64748b', fighter: '#f43f5e',
    }
    return { W, H, sx, sy, curve, ciMin, ciMax, mMin, mMax, klassColor: KLASS_CURVE_COLOR }
  }, [])

  function fmtN(n: number, d = 0): string {
    if (!isFinite(n)) return '\u2014'
    if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: d })
    return n.toFixed(d)
  }
  function fmtSigned(n: number, suffix = ''): string {
    if (!isFinite(n)) return '\u2014'
    return (n >= 0 ? '+' : '') + (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(1)) + suffix
  }

  return (
    <div className="fixed top-16 right-3 z-40 w-[380px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">$</span>
          <span className="text-sm font-semibold tracking-wide">COST INDEX</span>
          <span className="text-[10px] text-slate-500">CI estimator</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {(['MAX', 'PUSH', 'STD', 'LAZY'] as Tier[]).map(t => (
          <button key={t}
            onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/50 bg-sky-500/10' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }} title={t}>
            <span className="text-[9px] tracking-wider">{t}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="px-3 py-2 grid grid-cols-3 gap-1 border-b border-slate-800 text-center">
        <div className="rounded border border-slate-800 bg-slate-900/40 py-1">
          <div className="text-[9px] text-slate-500 tracking-wider">MED CI</div>
          <div className="text-sm font-mono text-slate-100">{Math.round(summary.medCi)}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 py-1">
          <div className="text-[9px] text-slate-500 tracking-wider">FUEL/LRC</div>
          <div className="text-sm font-mono text-amber-300">+{fmtN(summary.fuelOver)}pph</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 py-1">
          <div className="text-[9px] text-slate-500 tracking-wider">TIME SAVED</div>
          <div className="text-sm font-mono text-emerald-300">{fmtN(summary.timeSaved)}min</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/30">
          <div className="text-[10px] text-slate-500 tracking-wider flex items-center justify-between mb-1">
            <span>{'CI \u2192 Mach \u2014 class schedules'}</span>
            <span className="font-mono text-slate-400">M({Math.round(diag.mMin*100)/100}..{Math.round(diag.mMax*100)/100})</span>
          </div>
          <svg width={diag.W} height={diag.H} className="block">
            <rect x={0} y={0} width={diag.W} height={diag.H} fill="#0b1220" />
            {[0, 100, 200, 400, 600, 800, 999].map(ci => (
              <g key={ci}>
                <line x1={diag.sx(ci)} x2={diag.sx(ci)} y1={12} y2={diag.H - 22} stroke="#1e293b" strokeWidth={0.5} />
                <text x={diag.sx(ci) - 8} y={diag.H - 10} fill="#475569" fontSize={8} fontFamily="ui-monospace, monospace">{ci}</text>
              </g>
            ))}
            {[0.3, 0.5, 0.7, 0.8, 0.9].map(m => (
              <g key={m}>
                <line x1={36} x2={diag.W - 8} y1={diag.sy(m)} y2={diag.sy(m)} stroke="#1e293b" strokeWidth={0.5} />
                <text x={4} y={diag.sy(m) + 3} fill="#475569" fontSize={8} fontFamily="ui-monospace, monospace">M{m.toFixed(2)}</text>
              </g>
            ))}
            {/* tier threshold ticks at CI 40/150/500 */}
            {[40, 150, 500].map(ci => (
              <line key={ci} x1={diag.sx(ci)} x2={diag.sx(ci)} y1={12} y2={diag.H - 22} stroke="#334155" strokeWidth={0.6} strokeDasharray="2 2" />
            ))}
            {(['heavy', 'narrow', 'regional', 'biz', 'turboprop'] as Klass[]).map(k => (
              <path key={k} d={diag.curve(k)} stroke={diag.klassColor[k]} strokeWidth={1.2} fill="none" opacity={klassFilter === 'ALL' || klassFilter === k ? 0.9 : 0.2} />
            ))}
            {filtered.map(r => {
              const cx = diag.sx(r.ci)
              const cy = diag.sy(Math.max(diag.mMin, Math.min(diag.mMax, r.mach)))
              return <circle key={r.f.icao} cx={cx} cy={cy} r={2.8} fill={TIER_COLOR[r.tier]} stroke="#0b1220" strokeWidth={0.6} />
            })}
            {/* legend */}
            <g transform={`translate(${diag.W - 96}, 14)`}>
              {(['heavy', 'narrow', 'regional', 'biz', 'turboprop'] as Klass[]).map((k, i) => (
                <g key={k} transform={`translate(0, ${i * 10})`}>
                  <rect x={0} y={0} width={10} height={2} fill={diag.klassColor[k]} />
                  <text x={14} y={3} fill="#94a3b8" fontSize={7} fontFamily="ui-monospace, monospace">{KLASS_LABEL[k]} {KLASS_LRC[k].toFixed(2)}-{KLASS_MMO[k].toFixed(2)}</text>
                </g>
              ))}
            </g>
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
              <span>LEG HRS</span>
              <span className="font-mono text-slate-300">{legHrs.toFixed(1)}h</span>
            </div>
            <input type="range" min={0.5} max={12} step={0.5} value={legHrs} onChange={e => setLegHrs(parseFloat(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
              <span>MIN FL</span>
              <span className="font-mono text-slate-300">FL{minFl}</span>
            </div>
            <input type="range" min={100} max={450} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
              <span>JET-A $/GAL</span>
              <span className="font-mono text-slate-300">${jetPrice.toFixed(2)}</span>
            </div>
            <input type="range" min={1} max={10} step={0.1} value={jetPrice} onChange={e => setJetPrice(parseFloat(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
              <span>TIME $/MIN</span>
              <span className="font-mono text-slate-300">${timeValue}</span>
            </div>
            <input type="range" min={10} max={500} step={5} value={timeValue} onChange={e => setTimeValue(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showOverlay} onChange={e => setShowOverlay(e.target.checked)} className="accent-sky-500" /><span>OVL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{filtered.length} cruising / {rows.length} eligible</span>
        <span>CI / fuel-delta over {legHrs.toFixed(1)}h</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No cruising aircraft match.</div>
        )}
        {filtered.map(r => {
          const ciPct = Math.max(0, Math.min(1, r.ci / 999))
          const econColor = r.econDelta < 0 ? TIER_COLOR.STD : (r.econDelta > 500 ? TIER_COLOR.MAX : TIER_COLOR.PUSH)
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
                  <span>M{r.mach.toFixed(2)}</span>
                  <span className="text-slate-600">L{r.mLrc.toFixed(2)}/M{r.mMmo.toFixed(2)}</span>
                  <span className="ml-auto text-sky-300 font-semibold">CI {Math.round(r.ci)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${ciPct * 100}%`, background: TIER_COLOR[r.tier], opacity: 0.6 }} />
                  {/* tier threshold ticks: 40/150/500 of 999 */}
                  {[40, 150, 500].map(t => (
                    <div key={t} className="absolute inset-y-0 w-px bg-slate-700" style={{ left: `${(t / 999) * 100}%` }} />
                  ))}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="extra burn vs LRC">{fmtSigned(r.pphDelta, 'pph')}</span>
                  <span title={`fuel over ${legHrs}h`}>+{fmtN(r.fuelExtraKg)}kg</span>
                  <span className="ml-auto text-emerald-400" title="time saved over leg">{fmtN(r.timeSavedMin)}min</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate">{r.f.operator || ''}</span>
                  <span className="ml-auto" style={{ color: econColor }}>
                    {r.econDelta >= 0 ? 'net +$' : 'net -$'}{Math.abs(Math.round(r.econDelta)).toLocaleString()}
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
