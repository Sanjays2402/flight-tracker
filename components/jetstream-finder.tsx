'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/*
  Jet Stream Finder
  -----------------
  Detects coherent jet stream cores from live aircraft wind reports.
  For each altitude band (FL180 / FL240 / FL300 / FL360 / FL400+) we
  collect every airborne aircraft's reported (windDir,windKts), bin
  them on a tunable lat/lng grid, average u/v components per cell,
  and identify cells where mean wind speed >= MIN-CORE (60-200kt).
  Cells are then merged into connected components (8-neighbour flood)
  to form JET CORE polygons. Each core gets:
    - axis line: PCA principal direction of mean wind vectors weighted by speed
    - peak kt cell + centroid lat/lng
    - mean direction (from)
    - total cell count + span nm
    - tier: TROPICAL/SUBTROPICAL/POLAR/MID by latitude band of centroid
  For every airborne aircraft (cruising, |VS|<400fpm) we compute the
  track-aligned tailwind component from its own reported wind and
  classify rider tier:
    SURF (tail >= +60kt)  /  RIDE (+30..+60)  /  NEUTRAL (-15..+30)
    /  HEADBUTT (head >= +30kt = tail <= -30)
  We also suggest a STEP-CLIMB / STEP-DESCEND if a neighbouring band's
  best core would give >+20kt tail improvement on the aircraft's track.

  Visuals:
    - MapLibre overlay: tier-colored translucent core polygons (8-vert
      hulls around each cell cluster), dashed axis line through core
      centroid along principal wind direction (length scaled by mean
      kt), arrow glyph at axis terminus, callsign+tail-kt label on
      riders/headbutts; aircraft halo ring colored by rider tier.
    - Side panel: 4-tier counter strip (SURF/RIDE/NEUT/HEAD click-filter),
      3-cell BEST-CORE-KT / CORES / RIDERS summary,
      SVG vertical profile: kt vs FL (sky bars per band showing peak
      core kt with mean line),
      BAND selector chips (180/240/300/360/400),
      MIN-CORE slider (60-200kt), GRID slider (1-5deg), MIN-SAMP slider (2-8),
      OVL/AXIS/LBL toggles, callsign/icao search,
      CORES tab ranked by peak kt desc with tier color stripe, band+FL,
      peak kt + mean kt + axis bearing, cells count + span nm,
      RIDERS tab sorted by tail kt desc (riders first then headbutts
      ascending), callsign+type+tier-pill, FL+track+tail-kt color-coded,
      step-climb suggestion arrow with delta-kt gain.
*/

export interface JsFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  vertRate: number
  windDir: number
  windKts: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: JsFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type RTier = 'SURF' | 'RIDE' | 'NEUT' | 'HEAD'
const RTIER_COLOR: Record<RTier, string> = {
  SURF: '#a855f7', RIDE: '#10b981', NEUT: '#64748b', HEAD: '#ef4444',
}
const RTIER_ORDER: RTier[] = ['SURF', 'RIDE', 'NEUT', 'HEAD']

type CoreTier = 'POLAR' | 'SUBTROPICAL' | 'MID' | 'TROPICAL'
const CTIER_COLOR: Record<CoreTier, string> = {
  POLAR: '#a855f7', SUBTROPICAL: '#0ea5e9', MID: '#22d3ee', TROPICAL: '#fbbf24',
}
function coreTier(lat: number): CoreTier {
  const al = Math.abs(lat)
  if (al >= 55) return 'POLAR'
  if (al >= 35) return 'SUBTROPICAL'
  if (al >= 18) return 'MID'
  return 'TROPICAL'
}

const BANDS: Array<{ fl: number; lo: number; hi: number; label: string }> = [
  { fl: 180, lo: 14000, hi: 21000, label: 'FL180' },
  { fl: 240, lo: 21000, hi: 28000, label: 'FL240' },
  { fl: 300, lo: 28000, hi: 33000, label: 'FL300' },
  { fl: 360, lo: 33000, hi: 39000, label: 'FL360' },
  { fl: 400, lo: 39000, hi: 60000, label: 'FL400+' },
]

const toRad = (d: number) => (d * Math.PI) / 180
const toDeg = (r: number) => (r * 180) / Math.PI
const R_NM = 3440.065

function destPoint(lat: number, lng: number, brgDeg: number, distNm: number): [number, number] {
  const br = toRad(brgDeg), d = distNm / R_NM
  const phi1 = toRad(lat), lam1 = toRad(lng)
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(br))
  const lam2 = lam1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(phi1), Math.cos(d) - Math.sin(phi1) * Math.sin(phi2))
  return [(toDeg(lam2) + 540) % 360 - 180, toDeg(phi2)]
}

// Wind FROM-direction vector decomposition
function uvFrom(wd: number, ws: number): [number, number] {
  // u = -ws*sin(theta), v = -ws*cos(theta) gives velocity vector (toward)
  const t = toRad(wd)
  return [-ws * Math.sin(t), -ws * Math.cos(t)]
}
function dirFromUV(u: number, v: number): number {
  // returns FROM-direction (meteo)
  const toward = (toDeg(Math.atan2(u, v)) + 360) % 360
  return (toward + 180) % 360
}

// Project wind toward-vector onto aircraft track (heading-of-travel deg).
// Returns tailwind component in kt (positive = tail).
function tailwindKt(track: number, windDirFrom: number, windKt: number): number {
  // toward direction = windDir+180
  const wt = toRad((windDirFrom + 180) % 360)
  const tt = toRad(track)
  const u_w = windKt * Math.sin(wt), v_w = windKt * Math.cos(wt)
  const u_t = Math.sin(tt), v_t = Math.cos(tt)
  return u_w * u_t + v_w * v_t
}

const SRC_CORE = 'js-core-src', LYR_CORE_FILL = 'js-core-fill', LYR_CORE_LINE = 'js-core-line'
const SRC_AXIS = 'js-axis-src', LYR_AXIS = 'js-axis-lyr', LYR_AXIS_HEAD = 'js-axis-head'
const SRC_HALO = 'js-halo-src', LYR_HALO = 'js-halo-lyr'
const SRC_LBL = 'js-lbl-src', LYR_LBL = 'js-lbl-lyr'
const SRC_CLBL = 'js-clbl-src', LYR_CLBL = 'js-clbl-lyr'

export default function JetStreamFinder({ map, flights, onClose, onFly }: Props) {
  const [rTierFilter, setRTierFilter] = useState<RTier | 'ALL'>('ALL')
  const [bandFilter, setBandFilter] = useState<number | 'ALL'>('ALL')
  const [minCore, setMinCore] = useState<number>(() => {
    if (typeof window !== 'undefined') { const v = localStorage.getItem('ft-jet-mincore'); if (v) return Number(v) }
    return 90
  })
  const [grid, setGrid] = useState<number>(() => {
    if (typeof window !== 'undefined') { const v = localStorage.getItem('ft-jet-grid'); if (v) return Number(v) }
    return 2
  })
  const [minSamp, setMinSamp] = useState<number>(3)
  const [showOvl, setShowOvl] = useState(true)
  const [showAxis, setShowAxis] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [tab, setTab] = useState<'CORES' | 'RIDERS'>('RIDERS')
  const [query, setQuery] = useState('')
  const [, setTick] = useState(0)

  useEffect(() => { try { localStorage.setItem('ft-jet-mincore', String(minCore)) } catch {} }, [minCore])
  useEffect(() => { try { localStorage.setItem('ft-jet-grid', String(grid)) } catch {} }, [grid])
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 6000)
    return () => clearInterval(t)
  }, [])

  // ---- compute cores per band ----
  const { cores, riders, peakByBand } = useMemo(() => {
    type Cell = {
      key: string; band: number; row: number; col: number;
      sumU: number; sumV: number; n: number;
      latC: number; lngC: number;
    }
    const cellsByBand = new Map<number, Map<string, Cell>>()
    BANDS.forEach(b => cellsByBand.set(b.fl, new Map()))

    for (const f of flights) {
      if (f.ground) continue
      if (!Number.isFinite(f.windDir) || !Number.isFinite(f.windKts)) continue
      if (f.windKts < 1) continue
      const b = BANDS.find(x => f.altitudeFt >= x.lo && f.altitudeFt < x.hi)
      if (!b) continue
      const row = Math.floor(f.lat / grid)
      const col = Math.floor(f.lng / grid)
      const key = `${row}_${col}`
      const m = cellsByBand.get(b.fl)!
      let c = m.get(key)
      if (!c) {
        c = { key, band: b.fl, row, col, sumU: 0, sumV: 0, n: 0, latC: (row + 0.5) * grid, lngC: (col + 0.5) * grid }
        m.set(key, c)
      }
      const [u, v] = uvFrom(f.windDir, f.windKts)
      // Use toward-vector for averaging (sign of wind flow)
      c.sumU += -u; c.sumV += -v
      c.n++
    }

    // Build core clusters per band via flood fill on cells with mean speed >= minCore
    type Core = {
      id: string; band: number; tier: CoreTier;
      cells: Array<{ row: number; col: number; lat: number; lng: number; kt: number; dir: number }>
      peakKt: number; meanKt: number; axisDeg: number;
      centroidLat: number; centroidLng: number;
      poly: Array<[number, number]>; axisStart: [number, number]; axisEnd: [number, number];
    }
    const allCores: Core[] = []
    BANDS.forEach(b => {
      const m = cellsByBand.get(b.fl)!
      const active = new Map<string, { row: number; col: number; lat: number; lng: number; kt: number; dir: number }>()
      m.forEach((c) => {
        if (c.n < minSamp) return
        const u = c.sumU / c.n, v = c.sumV / c.n
        const kt = Math.sqrt(u * u + v * v)
        if (kt < minCore) return
        const dir = dirFromUV(-u, -v) // back to FROM
        active.set(c.key, { row: c.row, col: c.col, lat: c.latC, lng: c.lngC, kt, dir })
      })
      const visited = new Set<string>()
      let cid = 0
      active.forEach((seed, sk) => {
        if (visited.has(sk)) return
        const stack = [sk]; const group: typeof seed[] = []
        while (stack.length) {
          const k = stack.pop()!
          if (visited.has(k)) continue
          visited.add(k)
          const cell = active.get(k); if (!cell) continue
          group.push(cell)
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue
            const nk = `${cell.row + dr}_${cell.col + dc}`
            if (!visited.has(nk) && active.has(nk)) stack.push(nk)
          }
        }
        if (group.length === 0) return
        const peakKt = group.reduce((m2, g) => Math.max(m2, g.kt), 0)
        const meanKt = group.reduce((s, g) => s + g.kt, 0) / group.length
        // Centroid
        const cLat = group.reduce((s, g) => s + g.lat, 0) / group.length
        const cLng = group.reduce((s, g) => s + g.lng, 0) / group.length
        // Axis = weighted mean toward-direction
        let su = 0, sv = 0
        group.forEach(g => {
          const tw = (g.dir + 180) % 360
          su += g.kt * Math.sin(toRad(tw)); sv += g.kt * Math.cos(toRad(tw))
        })
        const axisToward = (toDeg(Math.atan2(su, sv)) + 360) % 360
        // axis length scaled to peakKt
        const halfNm = Math.min(900, 60 + peakKt * 4 + group.length * 30)
        const axisStart = destPoint(cLat, cLng, (axisToward + 180) % 360, halfNm)
        const axisEnd = destPoint(cLat, cLng, axisToward, halfNm)
        // Hull polygon = convex hull of cell corners (approximated by 1.4x cell radius around each cell)
        const pts: Array<[number, number]> = []
        const cellRadNm = grid * 60 * 0.75
        group.forEach(g => {
          for (let i = 0; i < 8; i++) pts.push(destPoint(g.lat, g.lng, i * 45, cellRadNm))
        })
        const poly = convexHull(pts)
        allCores.push({
          id: `${b.fl}_${cid++}`, band: b.fl, tier: coreTier(cLat),
          cells: group, peakKt, meanKt, axisDeg: axisToward,
          centroidLat: cLat, centroidLng: cLng,
          poly, axisStart, axisEnd,
        })
      })
    })

    // Peak kt by band
    const pbb = new Map<number, number>()
    BANDS.forEach(b => {
      const ofb = allCores.filter(c => c.band === b.fl)
      pbb.set(b.fl, ofb.length ? Math.max(...ofb.map(c => c.peakKt)) : 0)
    })

    // Riders
    type Rider = {
      f: JsFlight; tail: number; head: number; tier: RTier;
      bandFl: number; suggestFl: number | null; suggestGain: number;
    }
    const riderList: Rider[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!Number.isFinite(f.windDir) || !Number.isFinite(f.windKts)) continue
      if (Math.abs(f.vertRate) > 400) continue
      if (f.altitudeFt < 14000) continue
      const b = BANDS.find(x => f.altitudeFt >= x.lo && f.altitudeFt < x.hi)
      const tail = tailwindKt(f.track, f.windDir, f.windKts)
      const head = -tail
      let tier: RTier
      if (tail >= 60) tier = 'SURF'
      else if (tail >= 30) tier = 'RIDE'
      else if (tail <= -30) tier = 'HEAD'
      else tier = 'NEUT'
      // Suggest step climb: find any band whose nearest core to aircraft yields better tail
      let bestSuggestFl: number | null = null; let bestGain = 0
      BANDS.forEach(bb => {
        if (b && bb.fl === b.fl) return
        // find nearest core in this band within 600nm
        let bestTailHere = -9999
        for (const c of allCores) {
          if (c.band !== bb.fl) continue
          const dNm = approxNm(f.lat, f.lng, c.centroidLat, c.centroidLng)
          if (dNm > 600) continue
          // mean wind in core: use peakKt and axisDeg (toward); recover FROM = (axisDeg+180)
          const wFrom = (c.axisDeg + 180) % 360
          const t = tailwindKt(f.track, wFrom, c.peakKt)
          if (t > bestTailHere) bestTailHere = t
        }
        const gain = bestTailHere - tail
        if (gain > 20 && gain > bestGain) { bestGain = gain; bestSuggestFl = bb.fl }
      })
      riderList.push({ f, tail, head, tier, bandFl: b?.fl ?? 0, suggestFl: bestSuggestFl, suggestGain: bestGain })
    }

    riderList.sort((a, b) => {
      const ao = RTIER_ORDER.indexOf(a.tier), bo = RTIER_ORDER.indexOf(b.tier)
      if (ao !== bo) return ao - bo
      return b.tail - a.tail
    })

    return { cores: allCores.sort((a, b) => b.peakKt - a.peakKt), riders: riderList, peakByBand: pbb }
  }, [flights, grid, minCore, minSamp])

  const filteredCores = useMemo(() => {
    let cs = cores
    if (bandFilter !== 'ALL') cs = cs.filter(c => c.band === bandFilter)
    return cs
  }, [cores, bandFilter])

  const filteredRiders = useMemo(() => {
    let rs = riders
    if (rTierFilter !== 'ALL') rs = rs.filter(r => r.tier === rTierFilter)
    if (bandFilter !== 'ALL') rs = rs.filter(r => r.bandFl === bandFilter)
    if (query) {
      const q = query.toLowerCase()
      rs = rs.filter(r =>
        r.f.callsign?.toLowerCase().includes(q) ||
        r.f.icao?.toLowerCase().includes(q) ||
        r.f.type?.toLowerCase().includes(q) ||
        r.f.operator?.toLowerCase().includes(q)
      )
    }
    return rs
  }, [riders, rTierFilter, bandFilter, query])

  // ---- counts
  const tierCounts = useMemo(() => {
    const m: Record<RTier, number> = { SURF: 0, RIDE: 0, NEUT: 0, HEAD: 0 }
    riders.forEach(r => { m[r.tier]++ })
    return m
  }, [riders])

  const bestCoreKt = cores.length ? cores[0].peakKt : 0
  const riderActive = riders.filter(r => r.tier === 'SURF' || r.tier === 'RIDE').length

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        const coreFeatures: any[] = []
        const axisFeatures: any[] = []
        const haloFeatures: any[] = []
        const labelFeatures: any[] = []
        const coreLabels: any[] = []

        if (showOvl) {
          filteredCores.forEach(c => {
            coreFeatures.push({
              type: 'Feature',
              geometry: { type: 'Polygon', coordinates: [c.poly.concat([c.poly[0]])] },
              properties: { color: CTIER_COLOR[c.tier], op: Math.min(0.32, 0.10 + c.peakKt / 600) },
            })
            if (showLbl) {
              coreLabels.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [c.centroidLng, c.centroidLat] },
                properties: { text: `${Math.round(c.peakKt)}kt FL${c.band}`, color: CTIER_COLOR[c.tier] },
              })
            }
          })
        }

        if (showAxis) {
          filteredCores.forEach(c => {
            axisFeatures.push({
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: [c.axisStart, [c.centroidLng, c.centroidLat], c.axisEnd] },
              properties: { color: CTIER_COLOR[c.tier], width: 1 + c.peakKt / 80 },
            })
          })
        }

        filteredRiders.forEach(r => {
          haloFeatures.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
            properties: { color: RTIER_COLOR[r.tier], radius: 8 + Math.min(20, Math.abs(r.tail) / 4) },
          })
          if (showLbl && (r.tier === 'SURF' || r.tier === 'RIDE' || r.tier === 'HEAD')) {
            const sign = r.tail >= 0 ? '+' : ''
            labelFeatures.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
              properties: { text: `${r.f.callsign || r.f.icao} ${sign}${Math.round(r.tail)}kt`, color: RTIER_COLOR[r.tier] },
            })
          }
        })

        const setOrAdd = (id: string, data: any, addSrc: () => void, addLyr: () => void) => {
          const src = map.getSource(id) as any
          if (src && src.setData) src.setData(data)
          else { addSrc(); addLyr() }
        }

        setOrAdd(SRC_CORE, { type: 'FeatureCollection', features: coreFeatures },
          () => map.addSource(SRC_CORE, { type: 'geojson', data: { type: 'FeatureCollection', features: coreFeatures } } as any),
          () => {
            map.addLayer({ id: LYR_CORE_FILL, type: 'fill', source: SRC_CORE, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'op'] } as any })
            map.addLayer({ id: LYR_CORE_LINE, type: 'line', source: SRC_CORE, paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-dasharray': [2, 2] as any, 'line-opacity': 0.85 } as any })
          })

        setOrAdd(SRC_AXIS, { type: 'FeatureCollection', features: axisFeatures },
          () => map.addSource(SRC_AXIS, { type: 'geojson', data: { type: 'FeatureCollection', features: axisFeatures } } as any),
          () => map.addLayer({ id: LYR_AXIS, type: 'line', source: SRC_AXIS, paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] as any, 'line-opacity': 0.95 } as any }))

        setOrAdd(SRC_HALO, { type: 'FeatureCollection', features: haloFeatures },
          () => map.addSource(SRC_HALO, { type: 'geojson', data: { type: 'FeatureCollection', features: haloFeatures } } as any),
          () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'radius'] as any, 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.85 } as any }))

        setOrAdd(SRC_LBL, { type: 'FeatureCollection', features: labelFeatures },
          () => map.addSource(SRC_LBL, { type: 'geojson', data: { type: 'FeatureCollection', features: labelFeatures } } as any),
          () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'] }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.5 } as any }))

        setOrAdd(SRC_CLBL, { type: 'FeatureCollection', features: coreLabels },
          () => map.addSource(SRC_CLBL, { type: 'geojson', data: { type: 'FeatureCollection', features: coreLabels } } as any),
          () => map.addLayer({ id: LYR_CLBL, type: 'symbol', source: SRC_CLBL, layout: { 'text-field': ['get', 'text'], 'text-size': 12, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'] }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 2 } as any }))
      } catch (e) { /* style not ready */ }
    }
    if (map.isStyleLoaded()) ensure()
    else { const h = () => ensure(); map.once('load', h); return () => { try { map.off('load', h) } catch {} } }
  }, [map, filteredCores, filteredRiders, showOvl, showAxis, showLbl])

  // cleanup on unmount
  useEffect(() => {
    return () => {
      if (!map) return
      ;[LYR_CORE_FILL, LYR_CORE_LINE, LYR_AXIS, LYR_AXIS_HEAD, LYR_HALO, LYR_LBL, LYR_CLBL].forEach(id => { try { if (map.getLayer(id)) map.removeLayer(id) } catch {} })
      ;[SRC_CORE, SRC_AXIS, SRC_HALO, SRC_LBL, SRC_CLBL].forEach(id => { try { if (map.getSource(id)) map.removeSource(id) } catch {} })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])

  // ---- vertical profile SVG ----
  const maxBandKt = Math.max(60, ...Array.from(peakByBand.values()))

  return (
    <div className="absolute right-3 top-20 z-40 w-[min(96vw,420px)] max-h-[calc(100vh-7rem)] overflow-hidden bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 shrink-0">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Routes &amp; Flow</div>
          <div className="text-sm font-semibold text-slate-100">Jet Stream Finder</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none px-1">×</button>
      </div>

      {/* Tier filter strip */}
      <div className="grid grid-cols-4 gap-1 px-2 py-2 border-b border-slate-800 shrink-0">
        {RTIER_ORDER.map(t => (
          <button key={t} onClick={() => setRTierFilter(rTierFilter === t ? 'ALL' : t)}
            className={`px-1.5 py-1 rounded text-[10px] font-bold tracking-wide border transition ${rTierFilter === t ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:text-slate-200'}`}>
            <span className="block" style={{ color: RTIER_COLOR[t] }}>{t}</span>
            <span className="block text-slate-300 font-mono text-[11px]">{tierCounts[t]}</span>
          </button>
        ))}
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-3 gap-1 px-2 py-2 border-b border-slate-800 shrink-0">
        <div className="bg-slate-900/60 rounded px-2 py-1.5 border border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Peak Core</div>
          <div className="text-sm font-mono text-sky-300">{Math.round(bestCoreKt)}kt</div>
        </div>
        <div className="bg-slate-900/60 rounded px-2 py-1.5 border border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Cores</div>
          <div className="text-sm font-mono text-slate-100">{cores.length}</div>
        </div>
        <div className="bg-slate-900/60 rounded px-2 py-1.5 border border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Riders</div>
          <div className="text-sm font-mono text-emerald-300">{riderActive}</div>
        </div>
      </div>

      {/* SVG vertical profile */}
      <div className="px-2 py-2 border-b border-slate-800 shrink-0">
        <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Peak Core kt by FL band</div>
        <svg viewBox="0 0 380 90" className="w-full h-[90px]">
          {BANDS.map((b, i) => {
            const kt = peakByBand.get(b.fl) || 0
            const w = (kt / maxBandKt) * 300
            const y = 10 + i * 14
            const col = kt >= minCore ? CTIER_COLOR[coreTier(0)] : '#334155'
            return (
              <g key={b.fl} onClick={() => setBandFilter(bandFilter === b.fl ? 'ALL' : b.fl)} style={{ cursor: 'pointer' }}>
                <text x={2} y={y + 8} fontSize={8} fill={bandFilter === b.fl ? '#7dd3fc' : '#94a3b8'} fontFamily="monospace">{b.label}</text>
                <rect x={40} y={y} width={300} height={10} fill="#0f172a" stroke="#1e293b" />
                <rect x={40} y={y} width={w} height={10} fill={col} opacity={0.7} />
                <text x={345} y={y + 8} fontSize={8} fill="#cbd5e1" fontFamily="monospace">{Math.round(kt)}kt</text>
              </g>
            )
          })}
          {/* Min-core reference line */}
          <line x1={40 + (minCore / maxBandKt) * 300} y1={6} x2={40 + (minCore / maxBandKt) * 300} y2={84} stroke="#ef4444" strokeDasharray="3 2" strokeWidth={1} />
        </svg>
      </div>

      {/* Controls */}
      <div className="px-3 py-2 border-b border-slate-800 shrink-0 space-y-1.5">
        <div>
          <div className="flex justify-between text-[9px] uppercase tracking-widest text-slate-500"><span>Min Core</span><span className="text-slate-300 font-mono">{minCore}kt</span></div>
          <input type="range" min={60} max={200} step={5} value={minCore} onChange={e => setMinCore(Number(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between text-[9px] uppercase tracking-widest text-slate-500"><span>Grid</span><span className="text-slate-300 font-mono">{grid}°</span></div>
          <input type="range" min={1} max={5} step={1} value={grid} onChange={e => setGrid(Number(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between text-[9px] uppercase tracking-widest text-slate-500"><span>Min Samples / cell</span><span className="text-slate-300 font-mono">{minSamp}</span></div>
          <input type="range" min={2} max={8} step={1} value={minSamp} onChange={e => setMinSamp(Number(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex gap-1 pt-1">
          {(['OVL', 'AXIS', 'LBL'] as const).map(t => {
            const v = t === 'OVL' ? showOvl : t === 'AXIS' ? showAxis : showLbl
            const set = t === 'OVL' ? setShowOvl : t === 'AXIS' ? setShowAxis : setShowLbl
            return (
              <button key={t} onClick={() => set(!v)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-bold tracking-wide border transition ${v ? 'bg-sky-500/15 border-sky-500/50 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-500'}`}>{t}</button>
            )
          })}
        </div>
      </div>

      {/* Tabs */}
      <div className="grid grid-cols-2 px-2 pt-2 gap-1 shrink-0">
        {(['RIDERS', 'CORES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded-t text-[10px] font-bold tracking-widest border-b-2 ${tab === t ? 'border-sky-500 text-sky-100' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'RIDERS' && (
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / type"
          className="mx-2 mb-1 px-2 py-1 text-xs bg-slate-900 border border-slate-800 rounded text-slate-200 placeholder-slate-600 shrink-0" />
      )}

      <div className="overflow-y-auto flex-1">
        {tab === 'CORES' && (
          <>
            {filteredCores.length === 0 && <div className="text-[11px] text-slate-500 text-center py-6">No jet cores detected above {minCore}kt — lower threshold or grid size.</div>}
            {filteredCores.map(c => (
              <button key={c.id} onClick={() => { /* fly to centroid through any rider near it */ }}
                className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 transition flex gap-2">
                <div className="w-1 self-stretch rounded" style={{ background: CTIER_COLOR[c.tier] }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-xs text-slate-100">FL{c.band} · {c.tier}</span>
                    <span className="font-mono text-[10px] text-sky-300">{Math.round(c.peakKt)}kt peak</span>
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono">
                    mean {Math.round(c.meanKt)}kt · axis {Math.round(c.axisDeg).toString().padStart(3, '0')}° · {c.cells.length} cell{c.cells.length > 1 ? 's' : ''}
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono">
                    {c.centroidLat.toFixed(1)}°, {c.centroidLng.toFixed(1)}°
                  </div>
                </div>
              </button>
            ))}
          </>
        )}
        {tab === 'RIDERS' && (
          <>
            {filteredRiders.length === 0 && <div className="text-[11px] text-slate-500 text-center py-6">No cruising aircraft with wind reports match the filter.</div>}
            {filteredRiders.slice(0, 200).map(r => {
              const sign = r.tail >= 0 ? '+' : ''
              const tcol = r.tail >= 30 ? '#10b981' : r.tail <= -30 ? '#ef4444' : '#cbd5e1'
              return (
                <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
                  className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 transition flex gap-2">
                  <div className="w-1 self-stretch rounded" style={{ background: RTIER_COLOR[r.tier] }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-xs text-slate-100 truncate">
                        {r.f.callsign || r.f.icao.toUpperCase()}
                        {r.f.type && <span className="text-slate-500 ml-1">{r.f.type}</span>}
                      </span>
                      <span className="px-1.5 py-0.5 text-[9px] font-bold tracking-wider rounded" style={{ background: RTIER_COLOR[r.tier] + '22', color: RTIER_COLOR[r.tier] }}>{r.tier}</span>
                    </div>
                    <div className="text-[10px] text-slate-400 font-mono">
                      FL{Math.round(r.f.altitudeFt / 100).toString().padStart(3, '0')} · trk {Math.round(r.f.track).toString().padStart(3, '0')}° · <span style={{ color: tcol }}>{sign}{Math.round(r.tail)}kt</span>
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono flex items-center gap-2">
                      <span>wind {Math.round(r.f.windDir).toString().padStart(3, '0')}°@{Math.round(r.f.windKts)}kt</span>
                      {r.suggestFl != null && (
                        <span className="text-emerald-400">› FL{r.suggestFl} (+{Math.round(r.suggestGain)}kt)</span>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}

// --- helpers ---
function approxNm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const dLat = (lat2 - lat1) * 60
  const dLng = (lng2 - lng1) * 60 * Math.cos(toRad((lat1 + lat2) / 2))
  return Math.sqrt(dLat * dLat + dLng * dLng)
}

// Andrew's monotone chain convex hull
function convexHull(pts: Array<[number, number]>): Array<[number, number]> {
  if (pts.length < 3) return pts.slice()
  const ps = pts.slice().sort((a, b) => a[0] === b[0] ? a[1] - b[1] : a[0] - b[0])
  const cross = (O: [number, number], A: [number, number], B: [number, number]) => (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0])
  const lower: Array<[number, number]> = []
  for (const p of ps) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p) }
  const upper: Array<[number, number]> = []
  for (let i = ps.length - 1; i >= 0; i--) { const p = ps[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p) }
  upper.pop(); lower.pop()
  return lower.concat(upper)
}
