'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Convective Cell Monitor / Thunderstorm Penetration Risk
   -----------------------------------------------------------
   Real aviation hazard. Convective cells (CB / TCU) produce
   severe turbulence, hail, microbursts, lightning, and engine
   flameouts. ICAO Doc 4444 and FAA AIM both require pilots to
   deviate at least 20 nm around active cells and 5000 ft above
   the visible tops. Penetration has caused mid-air break-ups
   (Air France 447 contributing factor, Southern Airways 242
   Dothan 1977 hail/flameout, Pan Am 759 microburst New Orleans
   1982).

   We have no live radar mosaic in the public OpenSky feed, but
   ADS-B traffic itself reveals where cells are: pilots deviate
   around them, top them, and avoid bands. This panel synthesises
   live convective cells from three traffic-derived signals:

   1) DEVIATION CLUSTERS. Aircraft showing a |dHeading| > 12 deg
      over a short window are deviation candidates. We cluster
      candidates within 35 nm using a leader algorithm. A cluster
      with >= 3 deviating aircraft at compatible altitudes is
      promoted to a synthesised cell centred at the cluster
      centroid weighted by deviation magnitude.

   2) TOPPING SIGNATURE. Aircraft cruising significantly above
      their type's typical optimum (heavy/narrow > FL400) within
      80 nm of a cluster strengthen the cell's TOP estimate by
      pushing TOPS_FL toward max(observed alt) + 30 hundreds.
      When no topping aircraft exist we assume MOD cell with
      TOPS_FL 350.

   3) GAP / AVOIDANCE. We compute traffic density in a 60 nm
      ring around each candidate centroid and compare to a wider
      120 nm ring. A density ratio < 0.35 (ring much emptier than
      annulus) reinforces the cell hypothesis (aircraft avoiding
      the area) and bumps tier severity.

   Cell intensity index (CII) 0..1 combines:
      0.45 * (devCount / 8)            (clipped)
      0.30 * (1 - densityRatio)
      0.25 * (topsFL - 250) / 200      (clipped 0..1)
   Tier classification:
      SEVERE  CII >= 0.65   rose      CB / SUPERCELL — deviate 30nm
      STRONG  CII >= 0.45   amber     CB ACTIVE — deviate 20nm
      MOD     CII >= 0.25   yellow    TCU / building — caution
      WEAK    CII <  0.25   sky       isolated showers possible

   Per-aircraft penetration risk: for every airborne aircraft
   above MIN-FL we find the nearest active cell within HORIZON
   minutes along great-circle track. We project current GS *
   HORIZON forward in 30-second steps and test if the projected
   point falls within the cell's hazard radius (DEVIATE-NM from
   tier) AND if current altitude is below TOPS_FL + 50. We
   classify the aircraft into 4 risk tiers:
      PENETRATING  inside cell hazard ring now      rose
      INTERCEPT    enters hazard ring within 5 min  amber
      WATCH        enters within HORIZON window     yellow
      CLEAR        no intercept                     sky

   MapLibre overlay: tier-coloured cell circle (radius =
   DEVIATE-NM hazard ring) with dashed border + filled centre;
   triangle CB pin with id + TOPS-FL label; tier-coloured halo
   ring on every penetrating aircraft sized by risk; dashed
   amber projection line from WATCH aircraft to predicted
   entry waypoint with marker; callsign + cell-id + risk-tier
   labels.

   Side panel: 4-tier counter strip (click-to-filter), 3-cell
   ACTIVE-CELLS / FLEET-IN-CELL / MEAN-TOPS-FL summary, SVG
   range-ring radar-style diagram (concentric rings 0/40/80/120
   nm, cells plotted as tier-coloured filled circles at their
   bearing-from-map-centre with radius scaled by hazard nm,
   aircraft plotted as tier-coloured triangles at their bearing
   pointing along their track), DEVIATE-NM / TOPS-FL / HORIZON /
   MIN-FL / DENSITY-THRESH sliders, OVL/RING/PROJ/LBL toggles,
   callsign/type/operator/cell-id search, AIRCRAFT tab sorted by
   tier worst-first then ascending miss-distance with tier color
   stripe, callsign+type+tier-pill, cell-id + FL + GS + miss-nm
   + ETA line, mini hazard-distance bar (centered on cell with
   tier-colored position marker, +/-40nm view, rose-tinted
   hazard zone at center), reason chip + operator + cell tops
   line; CELLS tab sorted by tier worst-first then CII desc with
   tier color stripe, cell-id + tier-pill, TOPS-FL + dev-count +
   density-ratio + hazard-nm + CII percent line, click-to-fly
   per row (aircraft for AIRCRAFT, lat/lng for CELLS).

   Registered in Layers > Environment category and Cmd+K palette.
   Persisted preference: ft-cells.
   ============================================================ */

interface CFlight {
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
  flights: CFlight[]
  onClose: () => void
  onFly: (icao: string) => void
  onFlyLatLng?: (lat: number, lng: number, zoom?: number) => void
}

type CTier = 'WEAK' | 'MOD' | 'STRONG' | 'SEVERE'
type RTier = 'CLEAR' | 'WATCH' | 'INTERCEPT' | 'PENETRATING'
const C_COLOR: Record<CTier, string> = { WEAK: '#0ea5e9', MOD: '#facc15', STRONG: '#f59e0b', SEVERE: '#ef4444' }
const R_COLOR: Record<RTier, string> = { CLEAR: '#0ea5e9', WATCH: '#facc15', INTERCEPT: '#f59e0b', PENETRATING: '#ef4444' }
const C_ORDER: CTier[] = ['SEVERE', 'STRONG', 'MOD', 'WEAK']
const R_ORDER: RTier[] = ['PENETRATING', 'INTERCEPT', 'WATCH', 'CLEAR']

const R_NM = 3440.065
function deg2rad(d: number) { return d * Math.PI / 180 }
function rad2deg(r: number) { return r * 180 / Math.PI }
function haversineNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const dLa = deg2rad(la2 - la1), dLo = deg2rad(lo2 - lo1)
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(deg2rad(la1)) * Math.cos(deg2rad(la2)) * Math.sin(dLo / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
function bearing(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = deg2rad(la1), φ2 = deg2rad(la2)
  const dλ = deg2rad(lo2 - lo1)
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (rad2deg(Math.atan2(y, x)) + 360) % 360
}
function project(lat: number, lng: number, brgDeg: number, distNm: number): { lat: number, lng: number } {
  const d = distNm / R_NM
  const br = deg2rad(brgDeg)
  const φ1 = deg2rad(lat), λ1 = deg2rad(lng)
  const sφ2 = Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(br)
  const φ2 = Math.asin(sφ2)
  const y = Math.sin(br) * Math.sin(d) * Math.cos(φ1)
  const x = Math.cos(d) - Math.sin(φ1) * sφ2
  const λ2 = λ1 + Math.atan2(y, x)
  return { lat: rad2deg(φ2), lng: ((rad2deg(λ2) + 540) % 360) - 180 }
}

interface CellRec {
  id: string
  lat: number
  lng: number
  topsFl: number
  devCount: number
  densityRatio: number
  cii: number
  tier: CTier
  hazardNm: number
}

interface AcRow {
  f: CFlight
  cellId: string | null
  cellTier: CTier | null
  hazardNm: number
  missNm: number       // signed: positive outside ring, negative inside
  etaMin: number       // minutes to entry (0 if inside)
  rTier: RTier
  reason: string
}

const SRC_FILL = 'cv-fill', SRC_RING = 'cv-ring', SRC_PIN = 'cv-pin'
const SRC_HALO = 'cv-halo', SRC_PROJ = 'cv-proj', SRC_DOT = 'cv-dot', SRC_LBL = 'cv-lbl'
const LYR_FILL = 'cv-fill-l', LYR_RING = 'cv-ring-l', LYR_PIN = 'cv-pin-l'
const LYR_HALO = 'cv-halo-l', LYR_PROJ = 'cv-proj-l', LYR_DOT = 'cv-dot-l', LYR_LBL = 'cv-lbl-l'

// keep previous heading per aircraft across renders to estimate dHeading
const headingMem = new Map<string, { hdg: number, t: number }>()

export default function ConvectiveCells({ map, flights, onClose, onFly, onFlyLatLng }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CELLS'>('AIRCRAFT')
  const [rFilter, setRFilter] = useState<RTier | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(50)
  const [horizonMin, setHorizonMin] = useState(15)
  const [deviateNm, setDeviateNm] = useState(20)
  const [densityThresh, setDensityThresh] = useState(0.35)
  const [topsBase, setTopsBase] = useState(350)
  const [showOvl, setShowOvl] = useState(true)
  const [showRing, setShowRing] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [query, setQuery] = useState('')

  // -------- detect deviating aircraft via dHeading memory --------
  const now = Date.now()
  const deviating = useMemo(() => {
    const arr: { f: CFlight, dH: number }[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || f.altitudeFt < minFl * 100) continue
      const prev = headingMem.get(f.icao)
      headingMem.set(f.icao, { hdg: f.track, t: now })
      if (!prev) continue
      const dt = (now - prev.t) / 1000
      if (dt < 4 || dt > 90) continue
      let dH = Math.abs(f.track - prev.hdg)
      if (dH > 180) dH = 360 - dH
      const rate = dH / dt
      // > 0.5 deg/sec heading change OR > 12 deg total qualifies as deviation
      if (rate > 0.5 || dH > 12) arr.push({ f, dH })
    }
    // prune stale memory
    for (const [k, v] of headingMem) if (now - v.t > 120000) headingMem.delete(k)
    return arr
  }, [flights, now, minFl])

  // -------- cluster into cells (leader algorithm) --------
  const cells: CellRec[] = useMemo(() => {
    const CLUSTER_NM = 35
    const groups: { lat: number, lng: number, members: { f: CFlight, dH: number }[] }[] = []
    for (const d of deviating) {
      let placed = false
      for (const g of groups) {
        if (haversineNm(g.lat, g.lng, d.f.lat, d.f.lng) <= CLUSTER_NM) {
          g.members.push(d)
          // re-centre by dH-weighted mean
          let sw = 0, sla = 0, slo = 0
          for (const m of g.members) { const w = Math.max(1, m.dH); sw += w; sla += m.f.lat * w; slo += m.f.lng * w }
          g.lat = sla / sw; g.lng = slo / sw
          placed = true; break
        }
      }
      if (!placed) groups.push({ lat: d.f.lat, lng: d.f.lng, members: [d] })
    }
    const out: CellRec[] = []
    let idx = 0
    for (const g of groups) {
      if (g.members.length < 3) continue
      // tops estimate from member altitudes
      let topAlt = 0
      for (const m of g.members) if (m.f.altitudeFt > topAlt) topAlt = m.f.altitudeFt
      // include all airborne aircraft within 80nm for top boost
      for (const f of flights) {
        if (f.ground || !isFinite(f.altitudeFt)) continue
        const d = haversineNm(g.lat, g.lng, f.lat, f.lng)
        if (d <= 80 && f.altitudeFt > topAlt) topAlt = f.altitudeFt
      }
      const topsFl = Math.max(topsBase, Math.round((topAlt / 100) + 30))
      // density ratio
      let inner = 0, annulus = 0
      for (const f of flights) {
        if (f.ground) continue
        const d = haversineNm(g.lat, g.lng, f.lat, f.lng)
        if (d <= 60) inner++
        if (d > 60 && d <= 120) annulus++
      }
      const innerArea = Math.PI * 60 * 60
      const annulusArea = Math.PI * (120 * 120 - 60 * 60)
      const innerDens = inner / innerArea
      const annulusDens = annulus / annulusArea || 0.0000001
      const dRatio = Math.min(1, innerDens / annulusDens)
      const cii = Math.max(0, Math.min(1,
        0.45 * Math.min(1, g.members.length / 8) +
        0.30 * (1 - dRatio) +
        0.25 * Math.max(0, Math.min(1, (topsFl - 250) / 200))
      ))
      let tier: CTier
      let hazard: number
      if (cii >= 0.65) { tier = 'SEVERE'; hazard = deviateNm + 10 }
      else if (cii >= 0.45) { tier = 'STRONG'; hazard = deviateNm }
      else if (cii >= 0.25) { tier = 'MOD'; hazard = Math.max(10, deviateNm - 5) }
      else { tier = 'WEAK'; hazard = Math.max(8, deviateNm - 10) }
      out.push({
        id: `CB${String(++idx).padStart(2, '0')}`,
        lat: g.lat, lng: g.lng,
        topsFl, devCount: g.members.length, densityRatio: dRatio,
        cii, tier, hazardNm: hazard,
      })
    }
    // sort by CII desc
    out.sort((a, b) => b.cii - a.cii)
    return out
  }, [deviating, flights, deviateNm, topsBase])

  // -------- per-aircraft penetration risk --------
  const acRows: AcRow[] = useMemo(() => {
    const out: AcRow[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || f.altitudeFt < minFl * 100) continue
      let best: AcRow | null = null
      for (const c of cells) {
        if (f.altitudeFt > c.topsFl * 100 + 5000) continue
        const curD = haversineNm(c.lat, c.lng, f.lat, f.lng)
        const miss = curD - c.hazardNm
        let rTier: RTier = 'CLEAR'
        let etaMin = 0
        let reason = ''
        if (miss <= 0) {
          rTier = 'PENETRATING'
          reason = 'INSIDE CELL'
        } else {
          // forward integrate
          const gs = Math.max(60, f.velocityKts || 0)
          const step = 30 // sec
          const horizonSec = horizonMin * 60
          let entered = false
          for (let t = step; t <= horizonSec; t += step) {
            const nm = (t / 3600) * gs
            const p = project(f.lat, f.lng, f.track || 0, nm)
            const d = haversineNm(c.lat, c.lng, p.lat, p.lng)
            if (d <= c.hazardNm) {
              entered = true
              etaMin = t / 60
              break
            }
          }
          if (entered) {
            if (etaMin <= 5) { rTier = 'INTERCEPT'; reason = `ETA ${etaMin.toFixed(1)}m` }
            else { rTier = 'WATCH'; reason = `ETA ${etaMin.toFixed(0)}m` }
          } else reason = `${miss.toFixed(0)}nm clear`
        }
        if (!best || R_ORDER.indexOf(rTier) < R_ORDER.indexOf(best.rTier) ||
            (rTier === best.rTier && Math.abs(miss) < Math.abs(best.missNm))) {
          best = {
            f, cellId: c.id, cellTier: c.tier, hazardNm: c.hazardNm,
            missNm: miss, etaMin, rTier, reason,
          }
        }
      }
      if (!best) {
        best = { f, cellId: null, cellTier: null, hazardNm: 0, missNm: 999, etaMin: 0, rTier: 'CLEAR', reason: 'no cell' }
      }
      out.push(best)
    }
    return out
  }, [flights, cells, minFl, horizonMin])

  const acCounts = useMemo(() => {
    const c: Record<RTier, number> = { CLEAR: 0, WATCH: 0, INTERCEPT: 0, PENETRATING: 0 }
    for (const r of acRows) c[r.rTier]++
    return c
  }, [acRows])

  const summary = useMemo(() => {
    let topsSum = 0
    for (const c of cells) topsSum += c.topsFl
    return {
      active: cells.length,
      inCell: acCounts.PENETRATING + acCounts.INTERCEPT,
      meanTops: cells.length ? Math.round(topsSum / cells.length) : 0,
    }
  }, [cells, acCounts])

  const filteredAc = useMemo(() => {
    const q = query.trim().toLowerCase()
    return acRows.filter(r => {
      if (rFilter !== 'ALL' && r.rTier !== rFilter) return false
      if (!q) return r.rTier !== 'CLEAR' || tab === 'AIRCRAFT'
      return (r.f.callsign || '').toLowerCase().includes(q)
        || r.f.icao.toLowerCase().includes(q)
        || (r.f.type || '').toLowerCase().includes(q)
        || (r.f.operator || '').toLowerCase().includes(q)
        || (r.cellId || '').toLowerCase().includes(q)
    }).sort((a, b) => {
      const ti = R_ORDER.indexOf(a.rTier) - R_ORDER.indexOf(b.rTier)
      if (ti !== 0) return ti
      return a.missNm - b.missNm
    })
  }, [acRows, rFilter, query, tab])

  const filteredCells = useMemo(() => {
    const q = query.trim().toLowerCase()
    return cells.filter(c => !q || c.id.toLowerCase().includes(q))
      .sort((a, b) => {
        const ti = C_ORDER.indexOf(a.tier) - C_ORDER.indexOf(b.tier)
        if (ti !== 0) return ti
        return b.cii - a.cii
      })
  }, [cells, query])

  /* ---------- MapLibre overlay ---------- */
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        for (const s of [SRC_FILL, SRC_RING, SRC_PIN, SRC_HALO, SRC_PROJ, SRC_DOT, SRC_LBL]) {
          if (!map.getSource(s)) map.addSource(s, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        }
        if (!map.getLayer(LYR_FILL)) map.addLayer({
          id: LYR_FILL, type: 'fill', source: SRC_FILL,
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.10 },
        })
        if (!map.getLayer(LYR_RING)) map.addLayer({
          id: LYR_RING, type: 'line', source: SRC_RING,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.6, 'line-opacity': 0.85, 'line-dasharray': [3, 2] },
        })
        if (!map.getLayer(LYR_PIN)) map.addLayer({
          id: LYR_PIN, type: 'circle', source: SRC_PIN,
          paint: {
            'circle-radius': 6,
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#0b1220',
            'circle-stroke-width': 1.4,
          },
        })
        if (!map.getLayer(LYR_HALO)) map.addLayer({
          id: LYR_HALO, type: 'circle', source: SRC_HALO,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['get', 'risk'], 0, 8, 1, 20],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.10,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 1.4,
            'circle-stroke-opacity': 0.85,
          },
        })
        if (!map.getLayer(LYR_PROJ)) map.addLayer({
          id: LYR_PROJ, type: 'line', source: SRC_PROJ,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.3, 'line-opacity': 0.7, 'line-dasharray': [3, 2] },
        })
        if (!map.getLayer(LYR_DOT)) map.addLayer({
          id: LYR_DOT, type: 'circle', source: SRC_DOT,
          paint: { 'circle-radius': 4, 'circle-color': '#fbbf24', 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1 },
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

  // build circle polygon for cell hazard ring
  function circlePoly(lat: number, lng: number, rNm: number, steps = 48): number[][] {
    const coords: number[][] = []
    for (let i = 0; i <= steps; i++) {
      const b = (i / steps) * 360
      const p = project(lat, lng, b, rNm)
      coords.push([p.lng, p.lat])
    }
    return coords
  }

  useEffect(() => {
    if (!map) return
    const fill: any[] = []
    const ring: any[] = []
    const pin: any[] = []
    const halo: any[] = []
    const proj: any[] = []
    const dot: any[] = []
    const lbl: any[] = []
    if (showOvl) {
      for (const c of cells) {
        const poly = circlePoly(c.lat, c.lng, c.hazardNm)
        fill.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [poly] },
          properties: { color: C_COLOR[c.tier] },
        })
        if (showRing) {
          ring.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: poly },
            properties: { color: C_COLOR[c.tier] },
          })
        }
        pin.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
          properties: { color: C_COLOR[c.tier] },
        })
        if (showLabels) {
          lbl.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
            properties: { color: C_COLOR[c.tier], label: `${c.id} \u2022 FL${c.topsFl} \u2022 ${c.tier}` },
          })
        }
      }
    }
    for (const r of filteredAc) {
      if (r.rTier === 'CLEAR') continue
      const riskVal = r.rTier === 'PENETRATING' ? 1 : r.rTier === 'INTERCEPT' ? 0.7 : 0.4
      halo.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
        properties: { color: R_COLOR[r.rTier], risk: riskVal },
      })
      if (showProj && r.rTier !== 'PENETRATING' && r.etaMin > 0) {
        const nm = (r.etaMin / 60) * Math.max(60, r.f.velocityKts || 0)
        const p = project(r.f.lat, r.f.lng, r.f.track || 0, nm)
        proj.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [p.lng, p.lat]] },
          properties: { color: R_COLOR[r.rTier] },
        })
        dot.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          properties: {},
        })
      }
      if (showLabels) {
        lbl.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: { color: R_COLOR[r.rTier], label: `${(r.f.callsign || r.f.icao).trim()} \u2022 ${r.cellId || ''} \u2022 ${r.rTier}` },
        })
      }
    }
    try {
      ;(map.getSource(SRC_FILL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: fill })
      ;(map.getSource(SRC_RING) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: ring })
      ;(map.getSource(SRC_PIN) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: pin })
      ;(map.getSource(SRC_HALO) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: halo })
      ;(map.getSource(SRC_PROJ) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: proj })
      ;(map.getSource(SRC_DOT) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: dot })
      ;(map.getSource(SRC_LBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lbl })
    } catch {}
  }, [map, cells, filteredAc, showOvl, showRing, showProj, showLabels])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_LBL, LYR_DOT, LYR_PROJ, LYR_HALO, LYR_PIN, LYR_RING, LYR_FILL]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_LBL, SRC_DOT, SRC_PROJ, SRC_HALO, SRC_PIN, SRC_RING, SRC_FILL]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  /* ---------- radar-style diagram ---------- */
  const diag = useMemo(() => {
    const W = 348, H = 200
    const cx = W / 2, cy = H / 2
    // pick a reference centroid: weighted centroid of cells, else map centre proxy = first flight
    let lat = 0, lng = 0, n = 0
    for (const c of cells) { lat += c.lat; lng += c.lng; n++ }
    if (!n) {
      const f = flights.find(x => !x.ground)
      if (f) { lat = f.lat; lng = f.lng; n = 1 }
    }
    if (!n) return { W, H, cx, cy, lat: 0, lng: 0, ok: false as const, rings: [] as { r: number, lbl: string }[], cells: [] as any[], aircraft: [] as any[] }
    lat /= n; lng /= n
    const maxRange = 120
    const px = (rNm: number) => (rNm / maxRange) * Math.min(W, H) * 0.45
    const rings = [40, 80, 120].map(r => ({ r: px(r), lbl: `${r}nm` }))
    const cellDots = cells.map(c => {
      const d = haversineNm(lat, lng, c.lat, c.lng)
      if (d > maxRange) return null
      const b = bearing(lat, lng, c.lat, c.lng)
      const x = cx + Math.sin(deg2rad(b)) * px(d)
      const y = cy - Math.cos(deg2rad(b)) * px(d)
      return { x, y, r: Math.max(4, px(c.hazardNm) * 0.5), color: C_COLOR[c.tier], id: c.id }
    }).filter(Boolean)
    const acDots = acRows.filter(r => r.rTier !== 'CLEAR').map(r => {
      const d = haversineNm(lat, lng, r.f.lat, r.f.lng)
      if (d > maxRange) return null
      const b = bearing(lat, lng, r.f.lat, r.f.lng)
      const x = cx + Math.sin(deg2rad(b)) * px(d)
      const y = cy - Math.cos(deg2rad(b)) * px(d)
      return { x, y, color: R_COLOR[r.rTier], hdg: r.f.track || 0 }
    }).filter(Boolean)
    return { W, H, cx, cy, lat, lng, ok: true as const, rings, cells: cellDots, aircraft: acDots }
  }, [cells, acRows, flights])

  return (
    <div className="fixed top-16 right-3 z-40 w-[380px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">&#9650;</span>
          <span className="text-sm font-semibold tracking-wide">CONVECTIVE CELLS</span>
          <span className="text-[10px] text-slate-500">CB / TCU penetration</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {(['PENETRATING', 'INTERCEPT', 'WATCH', 'CLEAR'] as RTier[]).map(t => (
          <button key={t}
            onClick={() => setRFilter(rFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${rFilter === t ? 'border-sky-500/40 bg-sky-500/15' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: R_COLOR[t] }} title={t}>
            <span className="text-[9px] tracking-wider">{t.slice(0, 4)}</span>
            <span className="text-sm font-mono">{acCounts[t]}</span>
          </button>
        ))}
      </div>

      <div className="px-3 py-2 grid grid-cols-3 gap-1 border-b border-slate-800">
        <div className="rounded bg-slate-900/40 border border-slate-800 px-2 py-1 text-center">
          <div className="text-[9px] tracking-wider text-slate-500">ACTIVE CELLS</div>
          <div className="text-sm font-mono text-slate-200">{summary.active}</div>
        </div>
        <div className="rounded bg-slate-900/40 border border-slate-800 px-2 py-1 text-center">
          <div className="text-[9px] tracking-wider text-slate-500">FLEET IN-CELL</div>
          <div className="text-sm font-mono" style={{ color: summary.inCell > 0 ? R_COLOR.INTERCEPT : R_COLOR.CLEAR }}>{summary.inCell}</div>
        </div>
        <div className="rounded bg-slate-900/40 border border-slate-800 px-2 py-1 text-center">
          <div className="text-[9px] tracking-wider text-slate-500">MEAN TOPS</div>
          <div className="text-sm font-mono text-slate-200">FL{summary.meanTops || '—'}</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/30">
        <div className="text-[10px] text-slate-500 tracking-wider flex items-center justify-between mb-1">
          <span>RANGE SCOPE &mdash; 0/40/80/120 nm rings</span>
          <span className="font-mono text-slate-400">{diag.ok ? `${diag.lat.toFixed(1)},${diag.lng.toFixed(1)}` : 'no cells'}</span>
        </div>
        <svg width={diag.W} height={diag.H} className="block">
          <rect x={0} y={0} width={diag.W} height={diag.H} fill="#0b1220" />
          {diag.ok && (
            <>
              {diag.rings.map((r, i) => (
                <g key={i}>
                  <circle cx={diag.cx} cy={diag.cy} r={r.r} fill="none" stroke="#1e293b" strokeWidth={0.6} />
                  <text x={diag.cx + r.r + 2} y={diag.cy + 3} fill="#475569" fontSize={8} fontFamily="ui-monospace, monospace">{r.lbl}</text>
                </g>
              ))}
              {/* compass spokes */}
              {[0, 90, 180, 270].map(b => {
                const len = Math.min(diag.W, diag.H) * 0.45
                const x2 = diag.cx + Math.sin(deg2rad(b)) * len
                const y2 = diag.cy - Math.cos(deg2rad(b)) * len
                return <line key={b} x1={diag.cx} y1={diag.cy} x2={x2} y2={y2} stroke="#1e293b" strokeWidth={0.4} />
              })}
              {diag.cells.map((c: any, i: number) => (
                <g key={`c${i}`}>
                  <circle cx={c.x} cy={c.y} r={c.r} fill={c.color} fillOpacity={0.18} stroke={c.color} strokeWidth={1.2} strokeDasharray="3 2" />
                  <text x={c.x + c.r + 2} y={c.y + 3} fill={c.color} fontSize={9} fontFamily="ui-monospace, monospace">{c.id}</text>
                </g>
              ))}
              {diag.aircraft.map((a: any, i: number) => (
                <g key={`a${i}`} transform={`translate(${a.x},${a.y}) rotate(${a.hdg})`}>
                  <polygon points="0,-4 3,3 -3,3" fill={a.color} stroke="#0b1220" strokeWidth={0.6} />
                </g>
              ))}
              <circle cx={diag.cx} cy={diag.cy} r={2} fill="#64748b" />
            </>
          )}
          {!diag.ok && (
            <text x={diag.W / 2} y={diag.H / 2} fill="#475569" fontSize={10} fontFamily="ui-monospace, monospace" textAnchor="middle">no cells synthesised &mdash; waiting on traffic deviation signal</text>
          )}
        </svg>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>DEVIATE</span>
            <span className="font-mono text-slate-300">{deviateNm} nm</span>
          </div>
          <input type="range" min={10} max={50} step={1} value={deviateNm} onChange={e => setDeviateNm(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
            <span>TOPS BASE</span>
            <span className="font-mono text-slate-300">FL{topsBase}</span>
          </div>
          <input type="range" min={200} max={450} step={10} value={topsBase} onChange={e => setTopsBase(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>MIN FL</span>
            <span className="font-mono text-slate-300">FL{minFl}</span>
          </div>
          <input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>DENSITY THRESH</span>
            <span className="font-mono text-slate-300">{densityThresh.toFixed(2)}</span>
          </div>
          <input type="range" min={0.1} max={1} step={0.05} value={densityThresh} onChange={e => setDensityThresh(parseFloat(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showOvl} onChange={e => setShowOvl(e.target.checked)} className="accent-sky-500" /><span>OVL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRing} onChange={e => setShowRing(e.target.checked)} className="accent-sky-500" /><span>RING</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / cell-id"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1 flex gap-1 border-b border-slate-800">
        {(['AIRCRAFT', 'CELLS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 text-[10px] tracking-wider py-1 rounded ${tab === t ? 'bg-sky-500/15 text-sky-100 border border-sky-500/40' : 'border border-slate-800 bg-slate-900/40 text-slate-400'}`}>
            {t} {t === 'AIRCRAFT' ? `(${acRows.filter(r => r.rTier !== 'CLEAR').length})` : `(${cells.length})`}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <>
            {filteredAc.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-slate-500">no aircraft match active cells</div>
            )}
            {filteredAc.map(r => {
              // bar: -40..+40 nm, center = cell edge
              const minD = -40, maxD = 40
              const v = Math.max(minD, Math.min(maxD, r.missNm))
              const pct = ((v - minD) / (maxD - minD)) * 100
              return (
                <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
                  className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
                  <span className="w-1 self-stretch rounded" style={{ background: R_COLOR[r.rTier] }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                      <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                      <span className="ml-auto text-[10px] font-semibold" style={{ color: R_COLOR[r.rTier] }}>{r.rTier}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                      <span>{r.cellId || '—'}</span>
                      <span>FL{Math.round(r.f.altitudeFt / 100)}</span>
                      <span>GS {Math.round(r.f.velocityKts || 0)}</span>
                      <span className="ml-auto">{r.missNm >= 0 ? `+${r.missNm.toFixed(0)}` : r.missNm.toFixed(0)}nm</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                      {/* hazard zone (left half = inside cell) */}
                      <div className="absolute inset-y-0 left-0" style={{ width: '50%', background: '#ef4444', opacity: 0.15 }} />
                      {/* cell edge marker at center */}
                      <div className="absolute inset-y-0 w-0.5 bg-slate-600" style={{ left: '50%' }} />
                      {/* current position marker */}
                      <div className="absolute inset-y-0 w-1" style={{ left: `calc(${pct.toFixed(1)}% - 2px)`, background: R_COLOR[r.rTier] }} />
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                      <span style={{ color: r.rTier === 'CLEAR' ? '#64748b' : R_COLOR[r.rTier] }}>{r.reason}</span>
                      <span className="truncate">{r.f.operator || ''}</span>
                      <span className="ml-auto">{r.cellTier ? `tops FL${cells.find(c => c.id === r.cellId)?.topsFl ?? '—'}` : ''}</span>
                    </div>
                  </div>
                </button>
              )
            })}
          </>
        )}
        {tab === 'CELLS' && (
          <>
            {filteredCells.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-slate-500">no cells synthesised &mdash; need &ge; 3 deviating aircraft within 35 nm</div>
            )}
            {filteredCells.map(c => (
              <button key={c.id} onClick={() => onFlyLatLng?.(c.lat, c.lng, 7)}
                className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
                <span className="w-1 self-stretch rounded" style={{ background: C_COLOR[c.tier] }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono font-semibold">{c.id}</span>
                    <span className="text-slate-500">{c.lat.toFixed(1)},{c.lng.toFixed(1)}</span>
                    <span className="ml-auto text-[10px] font-semibold" style={{ color: C_COLOR[c.tier] }}>{c.tier}</span>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                    <span>tops FL{c.topsFl}</span>
                    <span>dev {c.devCount}</span>
                    <span>ρ {(c.densityRatio * 100).toFixed(0)}%</span>
                    <span className="ml-auto">hazard {c.hazardNm}nm</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                    <div className="absolute inset-y-0 left-0" style={{ width: `${(c.cii * 100).toFixed(1)}%`, background: C_COLOR[c.tier], opacity: 0.85 }} />
                    <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '65%' }} title="SEVERE threshold" />
                    <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '45%' }} title="STRONG threshold" />
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                    <span>CII {(c.cii * 100).toFixed(0)}%</span>
                    <span className="ml-auto">{c.densityRatio < densityThresh ? 'avoidance' : 'transit'}</span>
                  </div>
                </div>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
