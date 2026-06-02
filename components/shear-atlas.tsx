'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Shear Atlas
   -----------------------------------------------------------
   Live wind shear & turbulence-probability analyzer.

   Every airborne aircraft with a reported wind vector (windDir
   FROM-deg + windKts) gets resolved into u/v components in
   meteorological convention. We then bin samples into a 3-D
   lattice: a horizontal grid (lat/lng cells, configurable
   spacing 1-5 deg) crossed with vertical altitude bands
   (SFC/050/100/180/240/300/360/450 — 8 bands).

   For each *horizontal cell* we compute, across bands present:
     • Vertical shear (kt/1000ft) = |Δwind_vector| / Δalt_kft
       between adjacent populated bands; we keep the worst pair
       and the band-pair label.
     • Horizontal shear (kt/100nm) = max wind-vector difference
       within the same band between this cell and its 8
       neighbours, divided by mean cell distance (~spacingDeg
       * 60 nm).
     • Mean wind, max wind, sample count, altitude span.

   Turbulence probability score (0-100) combines vertical shear
   (weight 0.55, ramp 0-12 kt/kft), horizontal shear (weight
   0.35, ramp 0-20 kt/100nm), and a "spread" term from the
   stddev of wind speeds in the cell (weight 0.10). Cells are
   classified into 4 tiers:
       SEVERE >=70 / MODERATE >=45 / LIGHT >=20 / SMOOTH
   Map paints fill polygons (rose / amber / yellow / sky), with
   optional dashed cell outline and per-cell shear-arrow glyph
   (an axis-aligned chevron rotated to the mean wind bearing
   with length scaled by vertical-shear magnitude).

   Side panel: tier counter strip (click-to-filter), 3 sliders
   (CELL spacing 1-5deg, MIN-SAMP 1-8, MIN-ALT FL040-FL300),
   OVL/ARROWS/LBL toggles, callsign/icao search across the
   cell-occupying aircraft, ranked HOTSPOT list (worst cells
   first) with tier stripe, lat/lng centroid, vertical+horizontal
   shear readout, FL band-pair, sample count, click-to-fly to
   cell centroid.
   ============================================================ */

interface F {
  icao: string
  callsign: string
  type: string
  operator: string
  lat: number
  lng: number
  altitudeFt: number
  ground: boolean
  windDir: number
  windKts: number
}

interface Props {
  map: maplibregl.Map | null
  flights: F[]
  onClose: () => void
}

const BANDS: Array<[number, number, string]> = [
  [0,     5000,   'SFC'],
  [5000,  10000,  '050'],
  [10000, 18000,  '100'],
  [18000, 24000,  '180'],
  [24000, 30000,  '240'],
  [30000, 36000,  '300'],
  [36000, 41000,  '360'],
  [41000, 60000,  '450'],
]

function bandIdx(alt: number): number {
  for (let i = 0; i < BANDS.length; i++) if (alt >= BANDS[i][0] && alt < BANDS[i][1]) return i
  return -1
}

// meteo wind dir is FROM. Convert to u,v in kt (toward).
function uvFromMeteo(dirFrom: number, spd: number): [number, number] {
  const r = ((dirFrom + 180) % 360) * Math.PI / 180
  return [Math.sin(r) * spd, Math.cos(r) * spd]
}

function vecMag(u: number, v: number) { return Math.sqrt(u*u + v*v) }
function vecBearing(u: number, v: number) {
  const deg = Math.atan2(u, v) * 180 / Math.PI
  return (deg + 360) % 360
}

const TIERS = ['SEVERE', 'MODERATE', 'LIGHT', 'SMOOTH'] as const
type Tier = typeof TIERS[number]
const TIER_FILL: Record<Tier, string> = {
  SEVERE: '#f43f5e', MODERATE: '#f59e0b', LIGHT: '#eab308', SMOOTH: '#0ea5e9'
}
const TIER_TXT: Record<Tier, string> = {
  SEVERE: 'text-rose-300', MODERATE: 'text-amber-300', LIGHT: 'text-yellow-300', SMOOTH: 'text-sky-300'
}
const TIER_BG: Record<Tier, string> = {
  SEVERE: 'bg-rose-500/15 border-rose-500/40', MODERATE: 'bg-amber-500/15 border-amber-500/40',
  LIGHT: 'bg-yellow-500/15 border-yellow-500/40', SMOOTH: 'bg-sky-500/15 border-sky-500/40',
}

function tierOf(score: number): Tier {
  if (score >= 70) return 'SEVERE'
  if (score >= 45) return 'MODERATE'
  if (score >= 20) return 'LIGHT'
  return 'SMOOTH'
}

interface CellAgg {
  key: string
  ix: number
  iy: number
  centroidLat: number
  centroidLng: number
  bands: Map<number, { u: number; v: number; n: number; spd: number[] }>
  icaos: string[]
  callsigns: string[]
}

interface CellResult {
  key: string
  ix: number
  iy: number
  lat: number
  lng: number
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
  vShear: number      // kt/1000ft
  vShearLabel: string // "100→240" etc
  hShear: number      // kt/100nm
  spdStd: number
  meanU: number
  meanV: number
  meanSpd: number
  maxSpd: number
  samples: number
  bandSpan: number
  score: number
  tier: Tier
  icaos: string[]
  callsigns: string[]
}

export default function ShearAtlas({ map, flights, onClose }: Props) {
  const [spacing, setSpacing] = useState<number>(2)      // degrees
  const [minSamp, setMinSamp] = useState<number>(2)
  const [minAlt, setMinAlt] = useState<number>(4000)
  const [showOvl, setShowOvl] = useState<boolean>(true)
  const [showArrows, setShowArrows] = useState<boolean>(true)
  const [showLbl, setShowLbl] = useState<boolean>(true)
  const [tierFilter, setTierFilter] = useState<Tier | null>(null)
  const [query, setQuery] = useState<string>('')
  const overlayInstalledRef = useRef(false)

  // -------- compute --------
  const cells = useMemo<CellResult[]>(() => {
    const agg = new Map<string, CellAgg>()
    for (const f of flights) {
      if (f.ground) continue
      if (!f.windKts || f.windKts < 1) continue
      if (f.windDir == null || isNaN(f.windDir)) continue
      if (f.altitudeFt < minAlt) continue
      const bi = bandIdx(f.altitudeFt)
      if (bi < 0) continue
      const ix = Math.floor(f.lng / spacing)
      const iy = Math.floor(f.lat / spacing)
      const key = `${ix}:${iy}`
      let c = agg.get(key)
      if (!c) {
        c = {
          key, ix, iy,
          centroidLat: (iy + 0.5) * spacing,
          centroidLng: (ix + 0.5) * spacing,
          bands: new Map(),
          icaos: [],
          callsigns: [],
        }
        agg.set(key, c)
      }
      let bb = c.bands.get(bi)
      if (!bb) { bb = { u: 0, v: 0, n: 0, spd: [] }; c.bands.set(bi, bb) }
      const [u, v] = uvFromMeteo(f.windDir, f.windKts)
      bb.u += u; bb.v += v; bb.n++
      bb.spd.push(f.windKts)
      if (c.icaos.length < 24) {
        c.icaos.push(f.icao)
        c.callsigns.push(f.callsign || f.icao.toUpperCase())
      }
    }

    // First pass: per-cell band-means
    interface Prelim {
      cell: CellAgg
      bandMean: Map<number, { u: number; v: number; spd: number; n: number }>
      meanU: number; meanV: number; meanSpd: number; maxSpd: number
      samples: number
      spdStd: number
      vShear: number; vShearLabel: string
      bandSpan: number
    }
    const prelim: Prelim[] = []
    for (const c of agg.values()) {
      const bm = new Map<number, { u: number; v: number; spd: number; n: number }>()
      let totN = 0, sumU = 0, sumV = 0
      const allSpd: number[] = []
      let maxSpd = 0
      for (const [bi, bb] of c.bands) {
        if (bb.n < 1) continue
        bm.set(bi, { u: bb.u / bb.n, v: bb.v / bb.n, spd: bb.spd.reduce((a,b)=>a+b,0)/bb.spd.length, n: bb.n })
        totN += bb.n
        sumU += bb.u
        sumV += bb.v
        for (const s of bb.spd) { allSpd.push(s); if (s > maxSpd) maxSpd = s }
      }
      if (totN < minSamp) continue
      const meanU = sumU / totN
      const meanV = sumV / totN
      const meanSpd = allSpd.reduce((a,b)=>a+b,0) / allSpd.length
      const sVar = allSpd.reduce((a,s)=>a+(s-meanSpd)*(s-meanSpd),0) / allSpd.length
      const spdStd = Math.sqrt(sVar)

      // vertical shear between adjacent populated bands
      const bandsSorted = [...bm.keys()].sort((a,b)=>a-b)
      let vShear = 0, vShearLabel = '—'
      for (let i = 0; i < bandsSorted.length - 1; i++) {
        for (let j = i + 1; j < bandsSorted.length; j++) {
          const a = bm.get(bandsSorted[i])!
          const b = bm.get(bandsSorted[j])!
          const altA = (BANDS[bandsSorted[i]][0] + BANDS[bandsSorted[i]][1]) / 2
          const altB = (BANDS[bandsSorted[j]][0] + BANDS[bandsSorted[j]][1]) / 2
          const dKft = Math.abs(altB - altA) / 1000
          if (dKft < 0.5) continue
          const du = a.u - b.u, dv = a.v - b.v
          const sh = Math.sqrt(du*du + dv*dv) / dKft
          if (sh > vShear) {
            vShear = sh
            vShearLabel = `${BANDS[bandsSorted[i]][2]}→${BANDS[bandsSorted[j]][2]}`
          }
        }
      }
      const bandSpan = bandsSorted.length

      prelim.push({ cell: c, bandMean: bm, meanU, meanV, meanSpd, maxSpd, samples: totN, spdStd, vShear, vShearLabel, bandSpan })
    }

    // Build index for neighbour lookup
    const idx = new Map<string, Prelim>()
    for (const p of prelim) idx.set(p.cell.key, p)

    // Second pass: horizontal shear
    const spacingNm = spacing * 60
    const results: CellResult[] = []
    for (const p of prelim) {
      let hShear = 0
      // Compare cell mean to each neighbour mean (8-connected)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue
          const n = idx.get(`${p.cell.ix + dx}:${p.cell.iy + dy}`)
          if (!n) continue
          const du = p.meanU - n.meanU, dv = p.meanV - n.meanV
          const distNm = Math.sqrt(dx*dx + dy*dy) * spacingNm
          if (distNm < 1) continue
          const sh = Math.sqrt(du*du + dv*dv) / (distNm / 100)
          if (sh > hShear) hShear = sh
        }
      }
      // score
      const vNorm = Math.min(1, p.vShear / 12)
      const hNorm = Math.min(1, hShear / 20)
      const sNorm = Math.min(1, p.spdStd / 25)
      const score = Math.round((vNorm * 0.55 + hNorm * 0.35 + sNorm * 0.10) * 100)
      const tier = tierOf(score)

      const c = p.cell
      const minLng = c.ix * spacing
      const maxLng = minLng + spacing
      const minLat = c.iy * spacing
      const maxLat = minLat + spacing
      results.push({
        key: c.key, ix: c.ix, iy: c.iy,
        lat: c.centroidLat, lng: c.centroidLng,
        minLat, maxLat, minLng, maxLng,
        vShear: p.vShear, vShearLabel: p.vShearLabel,
        hShear,
        spdStd: p.spdStd,
        meanU: p.meanU, meanV: p.meanV,
        meanSpd: p.meanSpd, maxSpd: p.maxSpd,
        samples: p.samples,
        bandSpan: p.bandSpan,
        score, tier,
        icaos: c.icaos, callsigns: c.callsigns,
      })
    }
    results.sort((a, b) => b.score - a.score || b.vShear - a.vShear)
    return results
  }, [flights, spacing, minSamp, minAlt])

  const counts = useMemo<Record<Tier, number>>(() => {
    const r: Record<Tier, number> = { SEVERE: 0, MODERATE: 0, LIGHT: 0, SMOOTH: 0 }
    for (const c of cells) r[c.tier]++
    return r
  }, [cells])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return cells.filter(c => {
      if (tierFilter && c.tier !== tierFilter) return false
      if (q) {
        const hit = c.icaos.some(i => i.toLowerCase().includes(q)) ||
                    c.callsigns.some(s => s.toLowerCase().includes(q))
        if (!hit) return false
      }
      return true
    })
  }, [cells, tierFilter, query])

  // -------- MapLibre overlay --------
  useEffect(() => {
    const m = map
    if (!m) return
    const setup = () => {
      try {
        if (!m.getSource('shear-fill')) m.addSource('shear-fill', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
        if (!m.getSource('shear-line')) m.addSource('shear-line', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
        if (!m.getSource('shear-arrow')) m.addSource('shear-arrow', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
        if (!m.getSource('shear-label')) m.addSource('shear-label', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
        if (!m.getLayer('shear-fill-l')) m.addLayer({
          id: 'shear-fill-l', type: 'fill', source: 'shear-fill',
          paint: { 'fill-color': ['get','color'], 'fill-opacity': ['get','op'] }
        })
        if (!m.getLayer('shear-line-l')) m.addLayer({
          id: 'shear-line-l', type: 'line', source: 'shear-line',
          paint: { 'line-color': ['get','color'], 'line-width': 1.2, 'line-dasharray': [2,2], 'line-opacity': 0.85 }
        })
        if (!m.getLayer('shear-arrow-l')) m.addLayer({
          id: 'shear-arrow-l', type: 'line', source: 'shear-arrow',
          paint: { 'line-color': ['get','color'], 'line-width': 2.2 }
        })
        if (!m.getLayer('shear-label-l')) m.addLayer({
          id: 'shear-label-l', type: 'symbol', source: 'shear-label',
          layout: {
            'text-field': ['get','txt'], 'text-size': 10, 'text-offset': [0, -0.3],
            'text-anchor': 'bottom', 'text-allow-overlap': false, 'text-font': ['Open Sans Regular','Arial Unicode MS Regular'],
          },
          paint: { 'text-color': ['get','color'], 'text-halo-color': '#020617', 'text-halo-width': 1.4 }
        })
        overlayInstalledRef.current = true
      } catch {}
    }
    if (m.isStyleLoaded()) setup()
    else m.once('load', setup)

    return () => {
      try {
        ['shear-fill-l','shear-line-l','shear-arrow-l','shear-label-l'].forEach(id => { if (m.getLayer(id)) m.removeLayer(id) })
        ;['shear-fill','shear-line','shear-arrow','shear-label'].forEach(id => { if (m.getSource(id)) m.removeSource(id) })
      } catch {}
      overlayInstalledRef.current = false
    }
  }, [map])

  useEffect(() => {
    const m = map
    if (!m || !overlayInstalledRef.current) return
    const visible = (showOvl ? cells : [])
    const fillFeats: any[] = []
    const lineFeats: any[] = []
    const arrowFeats: any[] = []
    const labelFeats: any[] = []
    for (const c of visible) {
      const color = TIER_FILL[c.tier]
      const op = c.tier === 'SEVERE' ? 0.32 : c.tier === 'MODERATE' ? 0.24 : c.tier === 'LIGHT' ? 0.16 : 0.07
      const ring = [
        [c.minLng, c.minLat],[c.maxLng, c.minLat],[c.maxLng, c.maxLat],[c.minLng, c.maxLat],[c.minLng, c.minLat]
      ]
      fillFeats.push({ type:'Feature', properties:{ color, op }, geometry:{ type:'Polygon', coordinates:[ring] } })
      lineFeats.push({ type:'Feature', properties:{ color }, geometry:{ type:'LineString', coordinates: ring } })
      if (showArrows && c.meanSpd > 0.5) {
        const bear = vecBearing(c.meanU, c.meanV)
        const lenDeg = Math.min(spacing * 0.45, 0.15 + (c.vShear / 12) * spacing * 0.4)
        const br = bear * Math.PI / 180
        // shaft start (tail) -> end (head) along bear, centred on cell centroid
        const tailLat = c.lat - Math.cos(br) * lenDeg * 0.5
        const tailLng = c.lng - Math.sin(br) * lenDeg * 0.5 / Math.cos(c.lat * Math.PI/180)
        const headLat = c.lat + Math.cos(br) * lenDeg * 0.5
        const headLng = c.lng + Math.sin(br) * lenDeg * 0.5 / Math.cos(c.lat * Math.PI/180)
        // arrowhead chevron
        const wingLen = lenDeg * 0.25
        const wAng = 145 * Math.PI / 180
        const w1Lat = headLat - Math.cos(br + (180*Math.PI/180 - wAng)) * wingLen
        const w1Lng = headLng - Math.sin(br + (180*Math.PI/180 - wAng)) * wingLen / Math.cos(c.lat*Math.PI/180)
        const w2Lat = headLat - Math.cos(br - (180*Math.PI/180 - wAng)) * wingLen
        const w2Lng = headLng - Math.sin(br - (180*Math.PI/180 - wAng)) * wingLen / Math.cos(c.lat*Math.PI/180)
        arrowFeats.push({ type:'Feature', properties:{ color }, geometry:{ type:'LineString', coordinates: [
          [tailLng, tailLat],[headLng, headLat],[w1Lng, w1Lat],[headLng, headLat],[w2Lng, w2Lat],
        ] } })
      }
      if (showLbl && c.tier !== 'SMOOTH') {
        labelFeats.push({
          type:'Feature',
          properties:{ color, txt: `${c.vShear.toFixed(1)}/kft  ${c.hShear.toFixed(0)}/100nm` },
          geometry:{ type:'Point', coordinates:[c.lng, c.lat] }
        })
      }
    }
    try {
      (m.getSource('shear-fill') as any)?.setData({ type:'FeatureCollection', features: fillFeats })
      ;(m.getSource('shear-line') as any)?.setData({ type:'FeatureCollection', features: lineFeats })
      ;(m.getSource('shear-arrow') as any)?.setData({ type:'FeatureCollection', features: arrowFeats })
      ;(m.getSource('shear-label') as any)?.setData({ type:'FeatureCollection', features: labelFeats })
    } catch {}
  }, [map, cells, showOvl, showArrows, showLbl, spacing])

  return (
    <div className="absolute right-3 top-20 z-40 w-[360px] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl flex flex-col">
      <div className="px-3.5 py-2.5 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Turbulence</div>
          <div className="text-sm font-semibold text-slate-100">Shear Atlas <span className="text-slate-500 font-normal">· {cells.length} cells</span></div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none px-1">×</button>
      </div>

      {/* tier counter strip */}
      <div className="px-3 py-2 border-b border-slate-900 grid grid-cols-4 gap-1.5">
        {TIERS.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? null : t)}
              className={`px-1.5 py-1 rounded-md border text-[10px] text-center transition ${on ? TIER_BG[t] : 'bg-slate-900/50 border-slate-800 hover:border-slate-700'}`}>
              <div className={`font-mono font-bold ${TIER_TXT[t]}`}>{counts[t]}</div>
              <div className="text-[9px] uppercase tracking-wider text-slate-400">{t.slice(0,4)}</div>
            </button>
          )
        })}
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-900 space-y-2">
        {([
          ['CELL', spacing, 1, 5, 0.5, 'deg', (v: number) => setSpacing(v)],
          ['MIN-SAMP', minSamp, 1, 8, 1, '', (v: number) => setMinSamp(v)],
          ['MIN-ALT', minAlt / 1000, 0, 30, 2, ' kft', (v: number) => setMinAlt(v * 1000)],
        ] as const).map(([lbl, val, mn, mx, step, suf, fn]) => (
          <label key={lbl} className="block">
            <div className="flex items-baseline justify-between text-[10px]">
              <span className="text-slate-500 uppercase tracking-wider">{lbl}</span>
              <span className="font-mono text-sky-300">{typeof val === 'number' ? (Number.isInteger(val) ? val : val.toFixed(1)) : val}{suf}</span>
            </div>
            <input type="range" min={mn} max={mx} step={step} value={val as number}
              onChange={e => fn(parseFloat(e.target.value))}
              className="w-full accent-sky-500" />
          </label>
        ))}
      </div>

      {/* layer toggles + search */}
      <div className="px-3 py-2 border-b border-slate-900 space-y-2">
        <div className="grid grid-cols-3 gap-1.5">
          {([['OVL', showOvl, setShowOvl], ['ARROWS', showArrows, setShowArrows], ['LBL', showLbl, setShowLbl]] as const).map(([lbl, on, fn]) => (
            <button key={lbl} onClick={() => fn(!on)}
              className={`px-2 py-1 rounded-md text-[10px] font-mono uppercase tracking-wider border transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>{lbl}</button>
          ))}
        </div>
        <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="callsign or icao…"
          className="w-full bg-slate-900/70 border border-slate-800 rounded-md px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600 font-mono focus:outline-none focus:border-sky-500/50" />
      </div>

      {/* hotspot list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-[11px] text-slate-500">
            {cells.length === 0 ? 'No wind reports above MIN-ALT yet.' : 'No cells match filter.'}
          </div>
        ) : filtered.slice(0, 80).map(c => (
          <button key={c.key} onClick={() => {
            try { map?.flyTo({ center: [c.lng, c.lat], zoom: 6, duration: 800 }) } catch {}
          }} className="w-full text-left px-3 py-2 border-b border-slate-900/70 hover:bg-slate-900/60 transition">
            <div className="flex items-stretch gap-2">
              <div className="w-1 rounded-full shrink-0" style={{ background: TIER_FILL[c.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="flex items-baseline gap-1.5 min-w-0">
                    <span className={`text-[10px] font-mono font-bold ${TIER_TXT[c.tier]}`}>{c.tier}</span>
                    <span className="font-mono text-[10px] text-slate-500 truncate">{c.lat.toFixed(1)}°,{c.lng.toFixed(1)}°</span>
                  </div>
                  <span className="font-mono text-[10px] text-slate-300 shrink-0">{c.score}</span>
                </div>
                <div className="mt-0.5 grid grid-cols-3 gap-2 text-[10px] font-mono text-slate-300">
                  <span><span className="text-slate-500">V</span> {c.vShear.toFixed(1)}/kft</span>
                  <span><span className="text-slate-500">H</span> {c.hShear.toFixed(0)}/100nm</span>
                  <span><span className="text-slate-500">N</span> {c.samples}</span>
                </div>
                <div className="mt-0.5 text-[10px] text-slate-500 font-mono truncate">
                  {c.vShearLabel} · max {Math.round(c.maxSpd)}kt · σ{c.spdStd.toFixed(1)} · {c.bandSpan} bands
                </div>
                {c.callsigns.length > 0 && (
                  <div className="text-[9.5px] text-slate-600 font-mono truncate">{c.callsigns.slice(0,5).join(' · ')}{c.callsigns.length>5?` +${c.callsigns.length-5}`:''}</div>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
