'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Coffin Corner / Flight Envelope Monitor
   -----------------------------------------------------------
   For every airborne aircraft we model the high-altitude
   flight envelope between low-speed stall and high-speed Mach
   buffet. As altitude increases the indicated stall speed
   (in KTAS) climbs while the Mmo speed (also KTAS) drops —
   they converge at the airframe's "coffin corner".

   Per-aircraft math:
     - ISA atmosphere (troposphere model up to 36 089 ft, then
       isothermal stratosphere) gives temperature K and pressure
       ratio sigma at altitude_ft.
     - Speed of sound a = a0 * sqrt(T/T0) kt.
     - 1-g stall in EAS by airframe class (heavy 145 / narrow 130
       / regional 105 / biz 110 / turboprop 80 / GA 50 / fighter
       125 / heli 0). Converted to KTAS via Vtas = Veas/sqrt(sigma).
     - Mmo by class (heavy 0.89 / narrow 0.82 / regional 0.78 /
       biz 0.85 / turboprop 0.55 / GA 0.30 / fighter 1.60 /
       heli 0.25). KTAS_max = Mmo * a.
     - Aircraft current KTAS estimated from GS + wind component
       along track (TAS = GS - tailwind), and current Mach from
       KTAS / a.
     - Envelope position: pct = (TAS - Vstall) / (Vmax - Vstall)
       clipped 0..1; dual margin (stall kt, Mmo Mach units).
   Tier: SAFE  band width >40 kt AND both margins >15% width
         MARGIN 25-40 kt or margins 7-15%
         WARN   margin 3-7%
         CORNER margin <3% OR negative (outside envelope).

   MapLibre overlay paints tier-colored halo ring + dashed
   "envelope bar" line east of each aircraft (length = band
   width, position dot = current TAS within band). Callsign +
   envelope-pct labels.

   Side panel: SVG envelope diagram — altitude (y, 0-50k) vs
   KTAS (x, 0-650) with stall curve, Mmo curve, shaded safe
   band, ranked aircraft plotted as tier-colored dots. 4-tier
   counter strip (click-to-filter), CLASS filter chips, MIN-FL
   slider, OVL/LBL/DIAG toggles, search, ranked list sorted by
   ascending envelope band width (tightest first) with stall /
   Mmo / band readouts and click-to-fly.
   ============================================================ */

export interface CcFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number   // ground speed
  track: number
  ground: boolean
  windDir?: number      // FROM, deg
  windKts?: number
  mach?: number         // optional reported
}

interface Props {
  map: maplibregl.Map | null
  flights: CcFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'SAFE' | 'MARGIN' | 'WARN' | 'CORNER'
const TIER_COLOR: Record<Tier, string> = {
  SAFE: '#10b981',
  MARGIN: '#fbbf24',
  WARN: '#f97316',
  CORNER: '#ef4444',
}
const TIER_ORDER: Tier[] = ['CORNER', 'WARN', 'MARGIN', 'SAFE']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter' | 'heli'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR', heli: 'HEL',
}
const VS_EAS: Record<Klass, number> = {     // 1-g stall KEAS at MTOW-ish
  heavy: 145, narrow: 130, regional: 105, biz: 110, turboprop: 80, ga: 50, fighter: 125, heli: 0,
}
const MMO: Record<Klass, number> = {
  heavy: 0.89, narrow: 0.82, regional: 0.78, biz: 0.85, turboprop: 0.55, ga: 0.30, fighter: 1.60, heli: 0.25,
}

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139|MD9|B06|B47)/.test(x)) return 'heli'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CRJ9|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS)/.test(x)) return 'fighter'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'ga'
  if (/^(B19|B20|B30|B35|B40|B45|B55|B58|B95|B96|B99|AT4|AT5|AT7|DH8|SF34|EMB|E11|PA31|PA42|PC9|KODI)/.test(x)) return 'turboprop'
  return 'narrow'
}

/* ISA atmosphere */
const T0 = 288.15           // K at sea level
const A0 = 661.4787          // kt speed of sound at SL
const L  = 0.0019812         // K/ft lapse rate
const TROPOPAUSE_FT = 36089
const T_TROPO = 216.65

function isaTempK(altFt: number): number {
  if (altFt < TROPOPAUSE_FT) return T0 - L * altFt
  return T_TROPO
}
function isaSigma(altFt: number): number {  // density ratio rho/rho0
  if (altFt < TROPOPAUSE_FT) {
    const T = isaTempK(altFt)
    return Math.pow(T / T0, 4.2561)
  }
  // stratosphere
  const sigmaTropo = Math.pow(T_TROPO / T0, 4.2561)
  return sigmaTropo * Math.exp(-(altFt - TROPOPAUSE_FT) / 20805.7)
}
function soundKt(altFt: number): number { return A0 * Math.sqrt(isaTempK(altFt) / T0) }

function bearingDelta(a: number, b: number): number {
  let d = a - b
  while (d > 180) d -= 360
  while (d < -180) d += 360
  return d
}

interface Row {
  f: CcFlight
  klass: Klass
  altFt: number
  vStallTas: number       // KTAS at altitude
  vMaxTas: number         // KTAS at altitude from Mmo
  band: number            // kt
  curTas: number
  curMach: number
  pct: number             // 0..1 inside band
  marginStall: number     // pct band
  marginMmo: number       // pct band
  tier: Tier
}

const SRC_RING = 'cc-ring', SRC_BAR = 'cc-bar', SRC_LBL = 'cc-lbl'
const LYR_RING = 'cc-ring-l', LYR_BAR = 'cc-bar-l', LYR_BAR_DOT = 'cc-bar-dot', LYR_LBL = 'cc-lbl-l'

export default function CoffinCorner({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(100)
  const [showOverlay, setShowOverlay] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || f.altitudeFt < minFl * 100) continue
      if (!isFinite(f.velocityKts) || f.velocityKts <= 0) continue
      const klass = classify(f.type, f.category)
      if (klass === 'heli') continue
      const alt = f.altitudeFt
      const sigma = Math.max(0.05, isaSigma(alt))
      const a = soundKt(alt)
      const vStallEas = VS_EAS[klass]
      const vStallTas = vStallEas / Math.sqrt(sigma)
      const vMaxTas = MMO[klass] * a
      const band = vMaxTas - vStallTas
      // estimate TAS: GS - tailwind component (along track)
      let curTas = f.velocityKts
      if (f.windKts && isFinite(f.windDir!)) {
        // wind FROM windDir; wind vector toward (windDir+180). Tailwind = wind toward * cos(track - windToward)
        const toward = (f.windDir! + 180) % 360
        const tailwind = f.windKts * Math.cos(bearingDelta(f.track, toward) * Math.PI / 180)
        curTas = f.velocityKts - tailwind
      }
      // fall back / sanity: if reported mach, use it
      let curMach = f.mach && f.mach > 0 ? f.mach : curTas / a
      if (f.mach && f.mach > 0) curTas = curMach * a
      const pct = band > 0 ? (curTas - vStallTas) / band : 0
      const marginStall = pct
      const marginMmo = 1 - pct
      let tier: Tier
      if (band < 30 || marginStall < 0.03 || marginMmo < 0.03) tier = 'CORNER'
      else if (marginStall < 0.07 || marginMmo < 0.07) tier = 'WARN'
      else if (band < 60 || marginStall < 0.15 || marginMmo < 0.15) tier = 'MARGIN'
      else tier = 'SAFE'
      out.push({ f, klass, altFt: alt, vStallTas, vMaxTas, band, curTas, curMach, pct, marginStall, marginMmo, tier })
    }
    return out
  }, [flights, minFl])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { SAFE: 0, MARGIN: 0, WARN: 0, CORNER: 0 }
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
      return a.band - b.band
    })
  }, [rows, tierFilter, klassFilter, query])

  /* ---------- MapLibre overlay ---------- */
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC_RING)) map.addSource(SRC_RING, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getSource(SRC_BAR)) map.addSource(SRC_BAR, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
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
        if (!map.getLayer(LYR_BAR)) map.addLayer({
          id: LYR_BAR, type: 'line', source: SRC_BAR,
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 2,
            'line-opacity': 0.7,
            'line-dasharray': [2, 1.5],
          },
          filter: ['==', ['geometry-type'], 'LineString'],
        })
        if (!map.getLayer(LYR_BAR_DOT)) map.addLayer({
          id: LYR_BAR_DOT, type: 'circle', source: SRC_BAR,
          paint: {
            'circle-radius': 4,
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#0b1220',
            'circle-stroke-width': 1,
          },
          filter: ['==', ['geometry-type'], 'Point'],
        })
        if (!map.getLayer(LYR_LBL)) map.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC_LBL,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-offset': [0, -1.6],
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
    const barFeats: any[] = []
    const lblFeats: any[] = []
    for (const r of visible) {
      ringFeats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
        properties: { color: TIER_COLOR[r.tier] },
      })
      // east-facing dashed envelope bar, ~0.18° wide
      const w = 0.18
      const lng0 = r.f.lng + 0.04
      const lng1 = lng0 + w
      barFeats.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[lng0, r.f.lat], [lng1, r.f.lat]] },
        properties: { color: TIER_COLOR[r.tier] },
      })
      const dotLng = lng0 + w * Math.max(0, Math.min(1, r.pct))
      barFeats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [dotLng, r.f.lat] },
        properties: { color: TIER_COLOR[r.tier] },
      })
      if (showLabels) {
        lblFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: {
            color: TIER_COLOR[r.tier],
            label: `${(r.f.callsign || r.f.icao).trim()} \u2022 M${r.curMach.toFixed(2)} \u2022 ${Math.round(r.band)}kt`,
          },
        })
      }
    }
    try {
      ;(map.getSource(SRC_RING) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: ringFeats })
      ;(map.getSource(SRC_BAR) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: barFeats })
      ;(map.getSource(SRC_LBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lblFeats })
    } catch {}
  }, [map, filtered, showOverlay, showLabels])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_LBL, LYR_BAR_DOT, LYR_BAR, LYR_RING]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_LBL, SRC_BAR, SRC_RING]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  /* ---------- Envelope diagram ---------- */
  const diagram = useMemo(() => {
    const W = 348, H = 200, padL = 32, padR = 8, padT = 10, padB = 22
    const xMin = 0, xMax = 650
    const yMin = 0, yMax = 50000
    const sx = (kt: number) => padL + (kt - xMin) / (xMax - xMin) * (W - padL - padR)
    const sy = (ft: number) => H - padB - (ft - yMin) / (yMax - yMin) * (H - padT - padB)
    // Reference class for the diagram curves — pick narrowbody by default,
    // but if all visible are of one class use it.
    const klassesShown = new Set(filtered.map(r => r.klass))
    const refKlass: Klass = klassesShown.size === 1 ? (filtered[0]?.klass || 'narrow') : 'narrow'
    const stallPts: [number, number][] = []
    const mmoPts: [number, number][] = []
    for (let alt = 0; alt <= yMax; alt += 1000) {
      const sigma = Math.max(0.05, isaSigma(alt))
      const a = soundKt(alt)
      stallPts.push([VS_EAS[refKlass] / Math.sqrt(sigma), alt])
      mmoPts.push([MMO[refKlass] * a, alt])
    }
    const path = (pts: [number, number][]) => pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ')
    const stallPath = path(stallPts)
    const mmoPath = path(mmoPts)
    const bandPath = path(stallPts) + ' ' + path([...mmoPts].reverse()) + ' Z'
    return { W, H, sx, sy, stallPath, mmoPath, bandPath, refKlass }
  }, [filtered])

  return (
    <div className="fixed top-16 right-3 z-40 w-[380px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">&#9651;</span>
          <span className="text-sm font-semibold tracking-wide">COFFIN CORNER</span>
          <span className="text-[10px] text-slate-500">flight envelope</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {(['CORNER', 'WARN', 'MARGIN', 'SAFE'] as Tier[]).map(t => (
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
            <span>{'ENVELOPE \u2014 KTAS vs ALT'}</span>
            <span className="font-mono text-slate-400">ref: {KLASS_LABEL[diagram.refKlass]}</span>
          </div>
          <svg width={diagram.W} height={diagram.H} className="block">
            <rect x={0} y={0} width={diagram.W} height={diagram.H} fill="#0b1220" />
            {/* axis */}
            {[0, 10000, 20000, 30000, 40000, 50000].map(ft => (
              <g key={ft}>
                <line x1={32} x2={diagram.W - 8} y1={diagram.sy(ft)} y2={diagram.sy(ft)} stroke="#1e293b" strokeWidth={0.5} />
                <text x={4} y={diagram.sy(ft) + 3} fill="#475569" fontSize={8} fontFamily="ui-monospace, monospace">{ft / 1000}k</text>
              </g>
            ))}
            {[100, 200, 300, 400, 500, 600].map(kt => (
              <g key={kt}>
                <line x1={diagram.sx(kt)} x2={diagram.sx(kt)} y1={10} y2={diagram.H - 22} stroke="#1e293b" strokeWidth={0.5} />
                <text x={diagram.sx(kt) - 6} y={diagram.H - 10} fill="#475569" fontSize={8} fontFamily="ui-monospace, monospace">{kt}</text>
              </g>
            ))}
            {/* shaded safe band */}
            <path d={diagram.bandPath} fill="#0ea5e9" fillOpacity={0.08} />
            <path d={diagram.stallPath} stroke="#ef4444" strokeWidth={1.2} fill="none" />
            <path d={diagram.mmoPath} stroke="#fbbf24" strokeWidth={1.2} fill="none" />
            {/* aircraft dots */}
            {filtered.map(r => {
              const cx = diagram.sx(r.curTas), cy = diagram.sy(r.altFt)
              if (cx < 32 || cx > diagram.W - 8 || cy < 10 || cy > diagram.H - 22) return null
              return <circle key={r.f.icao} cx={cx} cy={cy} r={2.8} fill={TIER_COLOR[r.tier]} stroke="#0b1220" strokeWidth={0.6} />
            })}
            {/* legend */}
            <g>
              <text x={diagram.W - 70} y={20} fill="#ef4444" fontSize={8} fontFamily="ui-monospace, monospace">{'\u2014 stall'}</text>
              <text x={diagram.W - 70} y={31} fill="#fbbf24" fontSize={8} fontFamily="ui-monospace, monospace">{'\u2014 Mmo'}</text>
            </g>
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
        <span>{filtered.length} shown / {rows.length} airborne</span>
        <span>Vs / Mmo (ISA)</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {filtered.map(r => {
          const pctCl = Math.max(0, Math.min(1, r.pct))
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
                  <span title="stall KTAS">Vs {Math.round(r.vStallTas)}</span>
                  <span title="Mmo KTAS">Vm {Math.round(r.vMaxTas)}</span>
                  <span title="current KTAS">@ {Math.round(r.curTas)} kt</span>
                  <span className="ml-auto">FL{Math.round(r.altFt / 100)}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="current Mach">M{r.curMach.toFixed(2)}</span>
                  <span title="band width">band {Math.round(r.band)}kt</span>
                  <span className="ml-auto">stall +{Math.round(r.marginStall * 100)}% · Mmo \u2212{Math.round(r.marginMmo * 100)}%</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0 bg-rose-500/40" style={{ width: '8%' }} />
                  <div className="absolute inset-y-0 right-0 bg-amber-500/40" style={{ width: '8%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-300" style={{ left: `${pctCl * 100}%` }} />
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
