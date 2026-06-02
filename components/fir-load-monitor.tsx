'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   FIR / ATC Sector Load Monitor
   -----------------------------------------------------------
   Real ops concern: every airborne aircraft is, at any moment,
   inside a controlled Flight Information Region (FIR) — a
   block of airspace delegated to a single Area Control Centre
   (ACC) that owns en-route separation. ACCs publish a nominal
   "declared capacity" (aircraft simultaneously workable for
   the on-duty controller team given sector splits, conflict
   density, comms frequency loading, MTCD support, etc.). When
   live count breaches that ceiling the network manager
   (e.g. EUROCONTROL NMOC, FAA ATCSCC) issues Air Traffic Flow
   Management (ATFM) regulations — ground delay, miles-in-
   trail, reroute pushes — to bleed demand. This panel makes
   the underlying signal visible to a hobby tracker.

   For ~30 globally significant FIRs we encode an approximate
   bounding polygon (the actual ICAO Doc 7030 LoA polygons are
   convex blocks of latitude/longitude, ~5-20 vertices each;
   we use a tractable simplification — accuracy on the order
   of the size of a typical sector group, fine for a load
   gauge), the ACC name, the ICAO 4-letter code, region, and a
   declared peak capacity tuned to published EUROCONTROL /
   FAA TFMS sector group ceilings.

   Per FIR:
     - rolled count of live airborne aircraft inside polygon
       (point-in-polygon, ray-casting)
     - load fraction = count / declared
     - tier OVERLOAD (>=1.0) rose / NEAR (>=0.85) amber /
       BUSY (>=0.55) yellow / NORMAL (<0.55) sky
     - per-FIR mean FL and traffic FL band
     - SLOP score: stdev of headings as a proxy for sector
       complexity (crossing traffic harder than parallel flow)

   Per aircraft:
     - assigned FIR (first polygon containing point)
     - per-FIR contribution
     - inherited tier from FIR

   MapLibre overlay:
     - tier-coloured FIR polygons (translucent fill + 1.4px
       dashed outline) showing the boundary blocks
     - centroid label with ICAO + count/cap
     - tier-coloured aircraft halo ring sized by FIR load
     - callsign + FIR + load% label

   Side panel:
     - 4-tier counter strip click-to-filter
     - 3-cell summary OVERLOAD-FIRS / FLEET-WORKLOAD / MEAN-LOAD
     - SVG load-bar chart: top 14 FIRs, ICAO code + bar to
       declared cap, with 0.55/0.85/1.0 tier ticks
     - CAP-MULT slider (network-wide rehearsal), MIN-FL slider,
       MAX-FL slider, REGION chip filter
     - OVL/FILL/LBL/HALO toggles
     - FIRS tab sorted load-desc with tier stripe + ACC name +
       count/cap + mean-FL + complexity
     - AIRCRAFT tab sorted tier worst-first then load-desc with
       callsign + FIR + FL + load%
     - search callsign / type / operator / FIR ICAO / region
     - click-to-fly per row
   ============================================================ */

export interface FmFlight {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: FmFlight[]
  onClose: () => void
  onFly: (icao: string) => void
  onFlyLatLng: (lat: number, lng: number, zoom?: number) => void
}

type Tier = 'NORMAL' | 'BUSY' | 'NEAR' | 'OVERLOAD'
const TIER_COLOR: Record<Tier, string> = {
  NORMAL: '#0ea5e9',
  BUSY: '#fde047',
  NEAR: '#f59e0b',
  OVERLOAD: '#ef4444',
}
const TIER_ORDER: Tier[] = ['OVERLOAD', 'NEAR', 'BUSY', 'NORMAL']
const TIER_RANK: Record<Tier, number> = { NORMAL: 0, BUSY: 1, NEAR: 2, OVERLOAD: 3 }

type Region = 'EUR' | 'NAM' | 'ASIA' | 'OCE' | 'AFR' | 'SAM' | 'OCN'
const REGION_LABEL: Record<Region, string> = {
  EUR: 'Europe', NAM: 'N.America', ASIA: 'Asia', OCE: 'Oceania', AFR: 'Africa', SAM: 'S.America', OCN: 'Oceanic',
}

interface Fir {
  id: string         // ICAO 4-letter
  acc: string        // ACC name
  region: Region
  cap: number        // declared peak (sum of all sector groups)
  poly: [number, number][]  // [lng,lat] simplified outline (closed CCW)
}

/* ------ 32 globally significant FIRs (simplified polygons) ------
   Capacities estimated from public EUROCONTROL NM, FAA TFMS,
   JCAB, CASA capacity declarations (peak hour worked traffic
   summed across the sector group). These are approximations. */
const FIRS: Fir[] = [
  // ===== EUROPE =====
  { id: 'EDUU', acc: 'Maastricht UAC',  region: 'EUR', cap: 80, poly: [[2.0,49.0],[9.0,49.0],[10.0,52.0],[9.0,55.0],[3.0,55.0],[2.0,52.5]] },
  { id: 'EDMM', acc: 'Munich ACC',      region: 'EUR', cap: 65, poly: [[7.0,47.0],[13.5,47.0],[13.5,50.5],[7.0,50.5]] },
  { id: 'EDWW', acc: 'Bremen ACC',      region: 'EUR', cap: 55, poly: [[5.5,52.0],[11.0,52.0],[11.0,55.0],[5.5,55.0]] },
  { id: 'LFFF', acc: 'Paris ACC',       region: 'EUR', cap: 75, poly: [[-1.5,46.0],[5.0,46.0],[5.0,50.5],[-1.5,50.5]] },
  { id: 'LFBB', acc: 'Bordeaux ACC',    region: 'EUR', cap: 55, poly: [[-4.0,42.5],[3.0,42.5],[3.0,46.5],[-4.0,46.5]] },
  { id: 'EGTT', acc: 'London ACC',      region: 'EUR', cap: 90, poly: [[-6.0,49.5],[2.5,49.5],[2.5,55.0],[-6.0,55.0]] },
  { id: 'EGPX', acc: 'Scottish ACC',    region: 'EUR', cap: 50, poly: [[-9.0,54.5],[2.5,54.5],[2.5,61.0],[-9.0,61.0]] },
  { id: 'EHAA', acc: 'Amsterdam ACC',   region: 'EUR', cap: 45, poly: [[2.5,51.0],[7.5,51.0],[7.5,55.0],[2.5,55.0]] },
  { id: 'LSAS', acc: 'Swiss ACC',       region: 'EUR', cap: 50, poly: [[5.8,45.7],[10.6,45.7],[10.6,47.9],[5.8,47.9]] },
  { id: 'LOVV', acc: 'Vienna ACC',      region: 'EUR', cap: 50, poly: [[9.5,46.4],[17.2,46.4],[17.2,49.1],[9.5,49.1]] },
  { id: 'LIMM', acc: 'Milan ACC',       region: 'EUR', cap: 55, poly: [[6.5,43.5],[14.0,43.5],[14.0,47.0],[6.5,47.0]] },
  { id: 'LECM', acc: 'Madrid ACC',      region: 'EUR', cap: 70, poly: [[-9.5,36.0],[3.5,36.0],[3.5,43.5],[-9.5,43.5]] },
  { id: 'LGGG', acc: 'Athens ACC',      region: 'EUR', cap: 45, poly: [[19.0,34.5],[29.5,34.5],[29.5,41.5],[19.0,41.5]] },
  { id: 'LTAA', acc: 'Ankara ACC',      region: 'EUR', cap: 55, poly: [[26.0,36.0],[44.5,36.0],[44.5,42.0],[26.0,42.0]] },
  { id: 'UUWV', acc: 'Moscow ACC',      region: 'EUR', cap: 65, poly: [[28.0,53.0],[44.0,53.0],[44.0,60.0],[28.0,60.0]] },
  { id: 'EPWW', acc: 'Warsaw ACC',      region: 'EUR', cap: 50, poly: [[14.0,49.0],[24.0,49.0],[24.0,55.0],[14.0,55.0]] },
  // ===== NORTH AMERICA =====
  { id: 'KZNY', acc: 'New York ARTCC',  region: 'NAM', cap: 90, poly: [[-77.0,38.5],[-71.0,38.5],[-71.0,42.5],[-77.0,42.5]] },
  { id: 'KZID', acc: 'Indianapolis',    region: 'NAM', cap: 80, poly: [[-89.0,36.0],[-82.0,36.0],[-82.0,41.5],[-89.0,41.5]] },
  { id: 'KZAU', acc: 'Chicago ARTCC',   region: 'NAM', cap: 85, poly: [[-92.0,40.0],[-84.5,40.0],[-84.5,46.0],[-92.0,46.0]] },
  { id: 'KZLA', acc: 'Los Angeles',     region: 'NAM', cap: 80, poly: [[-122.0,32.0],[-114.0,32.0],[-114.0,37.0],[-122.0,37.0]] },
  { id: 'KZOA', acc: 'Oakland ARTCC',   region: 'NAM', cap: 70, poly: [[-126.0,36.0],[-119.0,36.0],[-119.0,42.0],[-126.0,42.0]] },
  { id: 'KZDV', acc: 'Denver ARTCC',    region: 'NAM', cap: 60, poly: [[-110.0,37.0],[-101.0,37.0],[-101.0,44.0],[-110.0,44.0]] },
  { id: 'KZTL', acc: 'Atlanta ARTCC',   region: 'NAM', cap: 75, poly: [[-86.5,30.5],[-79.0,30.5],[-79.0,35.5],[-86.5,35.5]] },
  { id: 'CZUL', acc: 'Montreal ACC',    region: 'NAM', cap: 55, poly: [[-79.0,44.0],[-69.0,44.0],[-69.0,50.0],[-79.0,50.0]] },
  // ===== ASIA =====
  { id: 'RJJJ', acc: 'Fukuoka ACC',     region: 'ASIA', cap: 90, poly: [[127.0,30.0],[145.0,30.0],[145.0,42.0],[127.0,42.0]] },
  { id: 'ZBPE', acc: 'Beijing ACC',     region: 'ASIA', cap: 80, poly: [[113.0,36.0],[122.0,36.0],[122.0,42.0],[113.0,42.0]] },
  { id: 'ZSHA', acc: 'Shanghai ACC',    region: 'ASIA', cap: 95, poly: [[116.0,28.0],[125.0,28.0],[125.0,35.0],[116.0,35.0]] },
  { id: 'ZGGG', acc: 'Guangzhou ACC',   region: 'ASIA', cap: 75, poly: [[108.0,21.0],[118.0,21.0],[118.0,27.0],[108.0,27.0]] },
  { id: 'VHHK', acc: 'Hong Kong ACC',   region: 'ASIA', cap: 60, poly: [[111.5,19.5],[117.5,19.5],[117.5,23.5],[111.5,23.5]] },
  { id: 'VTBB', acc: 'Bangkok ACC',     region: 'ASIA', cap: 65, poly: [[97.0,5.5],[106.0,5.5],[106.0,20.5],[97.0,20.5]] },
  { id: 'WSJC', acc: 'Singapore ACC',   region: 'ASIA', cap: 55, poly: [[103.0,0.0],[107.5,0.0],[107.5,5.0],[103.0,5.0]] },
  { id: 'VABF', acc: 'Mumbai ACC',      region: 'ASIA', cap: 70, poly: [[68.0,15.0],[78.0,15.0],[78.0,23.0],[68.0,23.0]] },
  { id: 'VIDF', acc: 'Delhi ACC',       region: 'ASIA', cap: 65, poly: [[72.0,24.0],[82.0,24.0],[82.0,32.0],[72.0,32.0]] },
  { id: 'OMAE', acc: 'Emirates ACC',    region: 'ASIA', cap: 75, poly: [[51.0,22.5],[57.0,22.5],[57.0,26.5],[51.0,26.5]] },
  // ===== OCEANIA =====
  { id: 'YBBB', acc: 'Brisbane ACC',    region: 'OCE', cap: 60, poly: [[138.0,-29.0],[155.0,-29.0],[155.0,-10.0],[138.0,-10.0]] },
  { id: 'YMMM', acc: 'Melbourne ACC',   region: 'OCE', cap: 65, poly: [[129.0,-39.0],[150.0,-39.0],[150.0,-29.0],[129.0,-29.0]] },
  { id: 'NZZC', acc: 'Auckland ACC',    region: 'OCE', cap: 40, poly: [[166.0,-47.5],[179.0,-47.5],[179.0,-34.0],[166.0,-34.0]] },
  // ===== S.AMERICA / AFRICA =====
  { id: 'SBBS', acc: 'Brasilia ACC',    region: 'SAM', cap: 60, poly: [[-58.0,-22.0],[-42.0,-22.0],[-42.0,-12.0],[-58.0,-12.0]] },
  { id: 'SAEF', acc: 'Ezeiza ACC',      region: 'SAM', cap: 45, poly: [[-65.0,-38.0],[-55.0,-38.0],[-55.0,-30.0],[-65.0,-30.0]] },
  { id: 'FACA', acc: 'Johannesburg',    region: 'AFR', cap: 50, poly: [[20.0,-34.5],[33.0,-34.5],[33.0,-22.0],[20.0,-22.0]] },
  { id: 'HECC', acc: 'Cairo ACC',       region: 'AFR', cap: 55, poly: [[25.0,22.0],[37.0,22.0],[37.0,32.0],[25.0,32.0]] },
]

/* ---------- helpers ---------- */
function pointInPoly(lng: number, lat: number, poly: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1]
    const xj = poly[j][0], yj = poly[j][1]
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside
  }
  return inside
}
function polyCentroid(poly: [number, number][]): { lat: number; lng: number } {
  let sx = 0, sy = 0
  for (const [x, y] of poly) { sx += x; sy += y }
  return { lng: sx / poly.length, lat: sy / poly.length }
}
function tierOf(load: number): Tier {
  if (load >= 1.0) return 'OVERLOAD'
  if (load >= 0.85) return 'NEAR'
  if (load >= 0.55) return 'BUSY'
  return 'NORMAL'
}
function fmtFL(ft: number): string { return 'FL' + String(Math.round(ft / 100)).padStart(3, '0') }

/* SOURCES + LAYERS */
const SRC = { POLY: 'fir-poly', PLBL: 'fir-plbl', HALO: 'fir-halo', LBL: 'fir-lbl' }
const LYR = {
  POLY_F: 'fir-poly-f', POLY_L: 'fir-poly-l', PLBL: 'fir-plbl-l', HALO: 'fir-halo-l', LBL: 'fir-lbl-l',
}

interface FirRollup {
  fir: Fir
  count: number
  cap: number
  load: number
  tier: Tier
  meanFL: number
  complexity: number  // 0..1 heading stdev / 60deg
  flMin: number
  flMax: number
}

interface AcRow {
  f: FmFlight
  fir: Fir | null
  tier: Tier
  load: number
}

export default function FirLoadMonitor({ map, flights, onClose, onFly, onFlyLatLng }: Props) {
  const [capMult, setCapMult] = useState(1.0)
  const [minFL, setMinFL] = useState(50)
  const [maxFL, setMaxFL] = useState(450)
  const [showOvl, setShowOvl] = useState(true)
  const [showFill, setShowFill] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showHalo, setShowHalo] = useState(true)
  const [regionsOn, setRegionsOn] = useState<Record<Region, boolean>>({ EUR: true, NAM: true, ASIA: true, OCE: true, AFR: true, SAM: true, OCN: true })
  const [tierFilter, setTierFilter] = useState<Tier | null>(null)
  const [tab, setTab] = useState<'F' | 'A'>('F')
  const [q, setQ] = useState('')

  /* Assign every flight to a FIR */
  const acRows = useMemo<AcRow[]>(() => {
    const out: AcRow[] = []
    for (const f of flights) {
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (fl < minFL || fl > maxFL) continue
      let assigned: Fir | null = null
      for (const fr of FIRS) {
        if (!regionsOn[fr.region]) continue
        if (pointInPoly(f.lng, f.lat, fr.poly)) { assigned = fr; break }
      }
      out.push({ f, fir: assigned, tier: 'NORMAL', load: 0 })
    }
    return out
  }, [flights, minFL, maxFL, regionsOn])

  /* Per-FIR rollup */
  const firRollup = useMemo<FirRollup[]>(() => {
    const byId = new Map<string, { count: number; sumFL: number; flMin: number; flMax: number; hdgs: number[] }>()
    for (const r of acRows) {
      if (!r.fir) continue
      let agg = byId.get(r.fir.id)
      if (!agg) { agg = { count: 0, sumFL: 0, flMin: 999, flMax: 0, hdgs: [] }; byId.set(r.fir.id, agg) }
      const fl = r.f.altitudeFt / 100
      agg.count++; agg.sumFL += fl
      if (fl < agg.flMin) agg.flMin = fl
      if (fl > agg.flMax) agg.flMax = fl
      agg.hdgs.push(r.f.track)
    }
    const out: FirRollup[] = []
    for (const fr of FIRS) {
      if (!regionsOn[fr.region]) continue
      const agg = byId.get(fr.id)
      const count = agg?.count || 0
      const cap = Math.max(1, fr.cap * capMult)
      const load = count / cap
      const meanFL = agg && agg.count > 0 ? agg.sumFL / agg.count : 0
      // heading stdev via circular variance approximation
      let complexity = 0
      if (agg && agg.hdgs.length >= 2) {
        let sumCos = 0, sumSin = 0
        for (const h of agg.hdgs) { sumCos += Math.cos(h * Math.PI / 180); sumSin += Math.sin(h * Math.PI / 180) }
        const r = Math.sqrt(sumCos * sumCos + sumSin * sumSin) / agg.hdgs.length
        complexity = Math.min(1, (1 - r) * 2)  // 0 = parallel flow, 1 = scrambled
      }
      out.push({
        fir: fr, count, cap, load, tier: tierOf(load), meanFL,
        complexity, flMin: agg?.flMin || 0, flMax: agg?.flMax || 0,
      })
    }
    return out
  }, [acRows, capMult, regionsOn])

  /* Inherit tier into aircraft rows */
  const acRowsTiered = useMemo<AcRow[]>(() => {
    const byId = new Map<string, FirRollup>()
    for (const fr of firRollup) byId.set(fr.fir.id, fr)
    return acRows.map(r => {
      if (!r.fir) return { ...r, tier: 'NORMAL' as Tier, load: 0 }
      const fr = byId.get(r.fir.id)
      return { ...r, tier: fr?.tier || 'NORMAL', load: fr?.load || 0 }
    })
  }, [acRows, firRollup])

  /* counts */
  const counts = useMemo(() => {
    const c: Record<Tier, number> = { NORMAL: 0, BUSY: 0, NEAR: 0, OVERLOAD: 0 }
    for (const fr of firRollup) c[fr.tier]++
    return c
  }, [firRollup])

  const summary = useMemo(() => {
    const overloads = firRollup.filter(f => f.tier === 'OVERLOAD').length
    const totalAc = acRowsTiered.length
    const inFir = acRowsTiered.filter(r => r.fir).length
    const meanLoad = firRollup.length > 0
      ? firRollup.reduce((s, f) => s + f.load, 0) / firRollup.length : 0
    return { overloads, totalAc, inFir, meanLoad }
  }, [firRollup, acRowsTiered])

  const filteredFirs = useMemo(() => {
    const qs = q.trim().toLowerCase()
    return firRollup.filter(fr => {
      if (tierFilter && fr.tier !== tierFilter) return false
      if (!qs) return true
      return fr.fir.id.toLowerCase().includes(qs)
        || fr.fir.acc.toLowerCase().includes(qs)
        || REGION_LABEL[fr.fir.region].toLowerCase().includes(qs)
    }).sort((a, b) => b.load - a.load)
  }, [firRollup, tierFilter, q])

  const filteredAc = useMemo(() => {
    const qs = q.trim().toLowerCase()
    return acRowsTiered.filter(r => {
      if (tierFilter && r.tier !== tierFilter) return false
      if (!qs) return true
      return (r.f.callsign || '').toLowerCase().includes(qs)
        || r.f.icao.toLowerCase().includes(qs)
        || (r.f.type || '').toLowerCase().includes(qs)
        || (r.f.operator || '').toLowerCase().includes(qs)
        || (r.fir?.id || '').toLowerCase().includes(qs)
    }).sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return b.load - a.load
    })
  }, [acRowsTiered, tierFilter, q])

  /* ---------- MapLibre overlay ---------- */
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        for (const s of [SRC.POLY, SRC.PLBL, SRC.HALO, SRC.LBL]) {
          if (!map.getSource(s)) map.addSource(s, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        }
        if (!map.getLayer(LYR.POLY_F)) map.addLayer({
          id: LYR.POLY_F, type: 'fill', source: SRC.POLY,
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'op'] },
        })
        if (!map.getLayer(LYR.POLY_L)) map.addLayer({
          id: LYR.POLY_L, type: 'line', source: SRC.POLY,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.9, 'line-dasharray': [3, 2] },
        })
        if (!map.getLayer(LYR.HALO)) map.addLayer({
          id: LYR.HALO, type: 'circle', source: SRC.HALO,
          paint: {
            'circle-radius': ['get', 'r'],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.10,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 1.2,
            'circle-stroke-opacity': 0.85,
          },
        })
        if (!map.getLayer(LYR.PLBL)) map.addLayer({
          id: LYR.PLBL, type: 'symbol', source: SRC.PLBL,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 11,
            'text-anchor': 'center',
            'text-allow-overlap': true,
          },
          paint: {
            'text-color': ['get', 'color'],
            'text-halo-color': '#0b1220',
            'text-halo-width': 1.4,
          },
        })
        if (!map.getLayer(LYR.LBL)) map.addLayer({
          id: LYR.LBL, type: 'symbol', source: SRC.LBL,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-offset': [0, -1.7],
            'text-anchor': 'bottom',
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': ['get', 'color'],
            'text-halo-color': '#0b1220',
            'text-halo-width': 1.1,
          },
        })
      } catch {}
    }
    if (map.isStyleLoaded()) ensure()
    else map.once('load', ensure)
  }, [map])

  useEffect(() => {
    if (!map) return
    const polyFeats: any[] = []
    const plblFeats: any[] = []
    const haloFeats: any[] = []
    const lblFeats: any[] = []

    if (showOvl) {
      for (const fr of firRollup) {
        const ring = [...fr.fir.poly, fr.fir.poly[0]]
        polyFeats.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [ring] },
          properties: {
            color: TIER_COLOR[fr.tier],
            op: showFill ? (0.04 + Math.min(0.20, fr.load * 0.16)) : 0,
            id: fr.fir.id,
          },
        })
        if (showLbl) {
          const c = polyCentroid(fr.fir.poly)
          plblFeats.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
            properties: {
              color: TIER_COLOR[fr.tier],
              label: `${fr.fir.id}  ${fr.count}/${Math.round(fr.cap)}`,
            },
          })
        }
      }
      if (showHalo) {
        const visible = tierFilter ? acRowsTiered.filter(r => r.tier === tierFilter) : acRowsTiered
        for (const r of visible) {
          if (!r.fir) continue
          haloFeats.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
            properties: { color: TIER_COLOR[r.tier], r: 6 + Math.round(Math.min(1.4, r.load) * 14) },
          })
          if (showLbl && r.tier !== 'NORMAL') {
            lblFeats.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
              properties: {
                color: TIER_COLOR[r.tier],
                label: `${(r.f.callsign || r.f.icao).trim()} \u2022 ${r.fir.id} \u2022 ${(r.load * 100).toFixed(0)}%`,
              },
            })
          }
        }
      }
    }

    try {
      ;(map.getSource(SRC.POLY) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: polyFeats })
      ;(map.getSource(SRC.PLBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: plblFeats })
      ;(map.getSource(SRC.HALO) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: haloFeats })
      ;(map.getSource(SRC.LBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lblFeats })
    } catch {}
  }, [map, firRollup, acRowsTiered, tierFilter, showOvl, showFill, showLbl, showHalo])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR.LBL, LYR.PLBL, LYR.HALO, LYR.POLY_L, LYR.POLY_F]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC.LBL, SRC.HALO, SRC.PLBL, SRC.POLY]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  /* ---------- bar diagram (top 14 by load) ---------- */
  const topFirs = useMemo(() => [...firRollup].sort((a, b) => b.load - a.load).slice(0, 14), [firRollup])
  const diag = useMemo(() => {
    const W = 348, rowH = 14, padT = 6, padB = 14, padL = 44, padR = 30
    const H = padT + padB + rowH * topFirs.length
    const maxL = Math.max(1.2, ...topFirs.map(f => f.load))
    const sx = (l: number) => padL + (l / maxL) * (W - padL - padR)
    return { W, H, rowH, padT, padB, padL, padR, sx, maxL }
  }, [topFirs])

  return (
    <div className="fixed top-16 right-3 z-40 w-[400px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">&#9678;</span>
          <span className="text-sm font-semibold tracking-wide">FIR / Sector Load</span>
          <span className="text-[10px] text-slate-500">ATFM capacity gauge</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      {/* tier strip */}
      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {(['OVERLOAD', 'NEAR', 'BUSY', 'NORMAL'] as Tier[]).map(t => (
          <button key={t}
            onClick={() => setTierFilter(tierFilter === t ? null : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/50 bg-sky-500/10' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }} title={t}>
            <span className="text-[9px] tracking-wider">{t.slice(0, 4)}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      {/* summary */}
      <div className="px-3 py-2 grid grid-cols-3 gap-1 border-b border-slate-800">
        <div className="text-center">
          <div className="text-[9px] text-slate-500 tracking-wider">OVERLOAD FIRS</div>
          <div className="text-base font-mono" style={{ color: summary.overloads ? TIER_COLOR.OVERLOAD : '#94a3b8' }}>{summary.overloads}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] text-slate-500 tracking-wider">A/C IN FIR</div>
          <div className="text-base font-mono text-slate-300">{summary.inFir}/{summary.totalAc}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] text-slate-500 tracking-wider">MEAN LOAD</div>
          <div className="text-base font-mono" style={{ color: TIER_COLOR[tierOf(summary.meanLoad)] }}>{(summary.meanLoad * 100).toFixed(0)}%</div>
        </div>
      </div>

      {/* bar diagram */}
      <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/30">
        <div className="text-[10px] text-slate-500 tracking-wider flex items-center justify-between mb-1">
          <span>TOP {topFirs.length} BY LOAD</span>
          <span className="font-mono text-slate-400">max {(diag.maxL * 100).toFixed(0)}%</span>
        </div>
        <svg width={diag.W} height={diag.H} className="block">
          <rect x={0} y={0} width={diag.W} height={diag.H} fill="#0b1220" />
          {/* tier threshold ticks */}
          {[0.55, 0.85, 1.0].map(t => (
            <line key={t} x1={diag.sx(t)} x2={diag.sx(t)} y1={diag.padT} y2={diag.H - diag.padB}
              stroke={t === 1.0 ? '#ef4444' : t === 0.85 ? '#f59e0b' : '#fde047'} strokeWidth={0.7} strokeDasharray="3 2" opacity={0.7} />
          ))}
          {topFirs.map((fr, i) => {
            const y = diag.padT + i * diag.rowH
            const w = diag.sx(fr.load) - diag.padL
            return (
              <g key={fr.fir.id}>
                <text x={4} y={y + diag.rowH - 3} fill={TIER_COLOR[fr.tier]} fontSize={9} fontFamily="ui-monospace, monospace">{fr.fir.id}</text>
                <rect x={diag.padL} y={y + 2} width={Math.max(1, w)} height={diag.rowH - 5} fill={TIER_COLOR[fr.tier]} opacity={0.55} />
                <rect x={diag.padL} y={y + 2} width={diag.W - diag.padL - diag.padR} height={diag.rowH - 5} fill="none" stroke="#1e293b" strokeWidth={0.5} />
                <text x={diag.W - 3} y={y + diag.rowH - 3} fill={TIER_COLOR[fr.tier]} fontSize={9} fontFamily="ui-monospace, monospace" textAnchor="end">{(fr.load * 100).toFixed(0)}%</text>
              </g>
            )
          })}
          {/* x ticks */}
          <text x={diag.sx(0.55) - 12} y={diag.H - 2} fill="#475569" fontSize={8} fontFamily="ui-monospace, monospace">0.55</text>
          <text x={diag.sx(0.85) - 12} y={diag.H - 2} fill="#475569" fontSize={8} fontFamily="ui-monospace, monospace">0.85</text>
          <text x={diag.sx(1.00) - 8} y={diag.H - 2} fill="#475569" fontSize={8} fontFamily="ui-monospace, monospace">1.0</text>
        </svg>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>CAP MULT</span>
            <span className="font-mono text-slate-300">{capMult.toFixed(2)}x {capMult < 0.85 ? '\u2022 SQUEEZE' : capMult > 1.15 ? '\u2022 RELIEF' : '\u2022 NORMAL'}</span>
          </div>
          <input type="range" min={0.5} max={1.5} step={0.05} value={capMult} onChange={e => setCapMult(parseFloat(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>MIN FL</span>
            <span className="font-mono text-slate-300">FL{String(minFL).padStart(3,'0')}</span>
          </div>
          <input type="range" min={0} max={400} step={10} value={minFL} onChange={e => setMinFL(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>MAX FL</span>
            <span className="font-mono text-slate-300">FL{String(maxFL).padStart(3,'0')}</span>
          </div>
          <input type="range" min={100} max={500} step={10} value={maxFL} onChange={e => setMaxFL(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap gap-1">
          {(Object.keys(REGION_LABEL) as Region[]).filter(r => r !== 'OCN').map(rg => (
            <button key={rg} onClick={() => setRegionsOn(s => ({ ...s, [rg]: !s[rg] }))}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${regionsOn[rg] ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-500'}`}
              title={REGION_LABEL[rg]}>{rg}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showOvl} onChange={e => setShowOvl(e.target.checked)} className="accent-sky-500" /><span>OVL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showFill} onChange={e => setShowFill(e.target.checked)} className="accent-sky-500" /><span>FILL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLbl} onChange={e => setShowLbl(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
        </div>
        <input type="text" value={q} onChange={e => setQ(e.target.value)} placeholder="search callsign / type / operator / FIR ICAO"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      {/* tabs */}
      <div className="px-3 pt-2 flex gap-1 border-b border-slate-800">
        {(['F', 'A'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2.5 py-1 text-[10px] rounded-t border-x border-t font-mono ${tab === t ? 'bg-sky-500/10 border-sky-500/40 text-sky-100' : 'bg-slate-900/40 border-slate-800 text-slate-500'}`}>
            {t === 'F' ? `FIRS (${filteredFirs.length})` : `AIRCRAFT (${filteredAc.length})`}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'F' && filteredFirs.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No FIRs match.</div>
        )}
        {tab === 'F' && filteredFirs.map(fr => (
          <button key={fr.fir.id} onClick={() => { const c = polyCentroid(fr.fir.poly); onFlyLatLng(c.lat, c.lng, 5) }}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
            <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[fr.tier] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono font-semibold truncate" style={{ color: TIER_COLOR[fr.tier] }}>{fr.fir.id}</span>
                <span className="text-slate-300 truncate">{fr.fir.acc}</span>
                <span className="ml-auto text-[10px] font-mono" style={{ color: TIER_COLOR[fr.tier] }}>{fr.tier}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                <span title="region">{REGION_LABEL[fr.fir.region]}</span>
                <span title="count / declared cap">{fr.count}/{Math.round(fr.cap)}</span>
                <span className="ml-auto" title="load fraction">{(fr.load * 100).toFixed(0)}%</span>
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, fr.load * 100)}%`, background: TIER_COLOR[fr.tier], opacity: 0.6 }} />
                <div className="absolute inset-y-0 w-px bg-yellow-400/60" style={{ left: '55%' }} />
                <div className="absolute inset-y-0 w-px bg-amber-400/60" style={{ left: '85%' }} />
                <div className="absolute inset-y-0 w-px bg-rose-400/70" style={{ left: '100%' }} />
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                <span title="mean flight level">mean {fr.count > 0 ? fmtFL(fr.meanFL * 100) : '\u2014'}</span>
                <span title="flight level band">band {fr.count > 0 ? `${fmtFL(fr.flMin * 100)}\u2013${fmtFL(fr.flMax * 100)}` : '\u2014'}</span>
                <span className="ml-auto" title="heading complexity (1=crossing, 0=parallel)">cplx {(fr.complexity * 100).toFixed(0)}</span>
              </div>
            </div>
          </button>
        ))}
        {tab === 'A' && filteredAc.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'A' && filteredAc.map(r => (
          <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
            <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                <span className="ml-auto text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                <span title="assigned FIR">{r.fir?.id || 'UNCTL'}</span>
                <span title="flight level">{fmtFL(r.f.altitudeFt)}</span>
                <span title="ground speed">{Math.round(r.f.velocityKts)}kt</span>
                <span className="ml-auto" title="FIR load">{(r.load * 100).toFixed(0)}%</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                <span className="truncate">{r.f.operator || '\u2014'}</span>
                <span className="ml-auto truncate">{r.fir ? r.fir.acc : 'OUT-OF-NET'}</span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
