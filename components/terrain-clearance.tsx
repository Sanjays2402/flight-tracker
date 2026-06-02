'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Terrain Clearance Monitor (TAWS / GPWS Mode 2 surrogate)
   -----------------------------------------------------------
   ICAO Annex 6 Part I §6.15 Terrain Awareness and Warning System
   surrogate. For every airborne aircraft below MAX-FL, compute
   Height-Above-Terrain (HAT) using a hard-coded coarse global
   max-terrain-elevation grid (10° lat × 10° lng cells covering
   the world's major mountain regions: Rockies, Sierras, Cascades,
   Andes, Coast Ranges, Greenland Ice, Alps, Pyrenees, Caucasus,
   Zagros, Hindu Kush, Himalayas, Tibetan Plateau, Tian Shan,
   Japanese Alps, New Guinea Highlands, NZ Southern Alps, East
   African Rift, Drakensberg, Atlas, plus oceanic = 0).

   HAT     = altitudeFt - max(terrainFt in current cell, neighbours)
   Closure = -vertRate (fpm descending) - GS*headingIntoRising*term
   PULL-UP horizon = HAT / max(closureFpm, 1) minutes

   Tier classification (FAA AC 25-23 GPWS thresholds):
     PULL-UP   HAT<500ft  AND closure>0    rose  (Mode 2 hard)
     WARN      HAT<1500ft AND closure>200  amber (Mode 1 sink)
     CAUTION   HAT<3000ft                  sky   (terrain ahead)
     OK        HAT>=3000ft                 emerald

   MapLibre overlay:
     - Tier-coloured halo rings sized inversely by HAT (8-22px)
     - Slate-gray terrain cell quads (opacity by elevation 0-30%)
     - Dashed tier-coloured projection line aircraft -> projected
       ground-track impact point at current sink (for PULL-UP/WARN)
     - Diamond marker at projected impact, tier-coloured label
       callsign + HAT-ft + closure-fpm

   Side panel: 4-tier counter strip click-to-filter, 3-cell
   MIN-HAT-ft (tier-coloured) / WORST-CS+HAT / PULLUP-COUNT,
   SVG HAT-vs-FL scatter with PULLUP/WARN/CAUTION threshold
   bands, 5 sliders (MIN-FL, MAX-FL, PULLUP-FT, WARN-FT,
   CAUTION-FT), 7-class chip filter, OVL/CELLS/HALO/PROJ/LBL
   toggles, callsign/type/operator/icao search, ranked list
   sorted tier-worst-first then HAT asc with tier color stripe,
   click-to-fly per row.

   Registered under Layers > Safety & Traffic category.
   ft-terrain persisted preference.
   ============================================================ */

export interface TerrainFlight {
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
  flights: TerrainFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'CAUTION' | 'WARN' | 'PULLUP'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981',
  CAUTION: '#0ea5e9',
  WARN: '#f59e0b',
  PULLUP: '#ef4444',
}
const TIER_ORDER: Tier[] = ['PULLUP', 'WARN', 'CAUTION', 'OK']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
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

// 10°×10° world max-terrain-elevation grid (ft). Sparse: missing cells = 0 (ocean/lowland).
// Keys: "latIdx,lngIdx" where latIdx = floor((lat+90)/10), lngIdx = floor((lng+180)/10).
// Values empirically aligned to highest peak in each cell.
const TERRAIN_CELLS: Record<string, number> = (() => {
  const t: Record<string, number> = {}
  const k = (latS: number, latN: number, lngW: number, lngE: number, ft: number) => {
    for (let la = latS; la < latN; la += 10) {
      for (let ln = lngW; ln < lngE; ln += 10) {
        const li = Math.floor((la + 90) / 10), gi = Math.floor((ln + 180) / 10)
        const key = `${li},${gi}`
        if (!t[key] || t[key] < ft) t[key] = ft
      }
    }
  }
  // North American Rockies / Cascades / Sierras / Coast Ranges
  k(30, 60, -130, -100, 14000)     // wide Rockies belt
  k(30, 50, -125, -115, 14500)     // Sierras + Cascades peaks
  k(60, 80, -160, -120, 19000)     // Alaska / Denali
  k(50, 80, -70, -20, 12000)       // Greenland ice cap + Baffin
  // Mexico / Central America
  k(10, 30, -110, -80, 18500)      // Trans-Mexican volcanic belt (Orizaba 18491)
  // South America Andes
  k(-60, 10, -80, -60, 22800)      // Aconcagua belt 22841
  k(-40, -10, -75, -65, 22000)     // Bolivia/Peru Altiplano
  // Europe
  k(40, 50, 5, 20, 15800)          // Alps Mont Blanc 15770
  k(40, 50, -10, 5, 11200)         // Pyrenees
  k(40, 50, 20, 40, 9000)          // Carpathians / Balkans
  k(40, 50, 40, 50, 18500)         // Caucasus Elbrus 18510
  k(60, 70, 10, 30, 8100)          // Scandes
  // Africa
  k(20, 40, -10, 10, 13700)        // Atlas Toubkal 13671
  k(-10, 10, 30, 40, 19300)        // E.African Rift Kilimanjaro 19341 / Kenya
  k(-40, -20, 20, 35, 11400)       // Drakensberg
  // Asia (the big stuff)
  k(20, 40, 60, 80, 28200)         // Hindu Kush / Karakoram K2 28251
  k(20, 40, 70, 100, 29000)        // Himalayas Everest 29029
  k(30, 50, 70, 110, 23000)        // Tibetan Plateau
  k(30, 50, 60, 80, 19000)         // Pamirs
  k(30, 50, 70, 90, 24400)         // Tian Shan / Pobeda
  k(20, 40, 40, 60, 18600)         // Zagros / Iran plateau (Damavand 18406)
  k(40, 60, 80, 130, 14800)        // Altai / Sayan / Mongolia
  k(50, 70, 130, 180, 15600)       // Kamchatka volcanoes (Klyuchevskaya 15584)
  // Japan
  k(30, 50, 130, 150, 12400)       // Japanese Alps / Fuji 12388
  // SE Asia
  k(0, 10, 110, 120, 13400)        // Borneo Kinabalu 13435
  k(-10, 0, 130, 150, 16000)       // New Guinea Highlands Puncak Jaya 16024
  // Oceania
  k(-50, -40, 160, 180, 12300)     // NZ Southern Alps Cook 12218
  k(-50, -30, 140, 160, 7300)      // Australia Eastern Highlands Kosciuszko 7310
  // Antarctica
  k(-90, -60, -180, 180, 16000)    // generic antarctic ice + Vinson Massif 16050
  return t
})()

function terrainAt(lat: number, lng: number): number {
  const li = Math.floor((lat + 90) / 10), gi = Math.floor((lng + 180) / 10)
  let m = TERRAIN_CELLS[`${li},${gi}`] || 0
  // include 8-neighbour worst-case to be conservative near sharp ridges
  for (let dla = -1; dla <= 1; dla++) {
    for (let dln = -1; dln <= 1; dln++) {
      if (!dla && !dln) continue
      const lii = li + dla, gii = ((gi + dln) % 36 + 36) % 36
      if (lii < 0 || lii > 17) continue
      const v = TERRAIN_CELLS[`${lii},${gii}`] || 0
      if (v > m) m = v * 0.85 // neighbour discount
    }
  }
  return m
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

interface Row {
  f: TerrainFlight
  klass: Klass
  altFt: number
  gs: number
  trk: number
  vs: number
  terrainFt: number
  hatFt: number
  closureFpm: number       // positive = closing on terrain
  timeToImpactMin: number  // HAT/closure
  aheadTerrainFt: number   // terrain 10nm ahead on track
  recLat: number
  recLng: number
  tier: Tier
}

const SRC_RING = 'tcm-ring', SRC_PROJ = 'tcm-proj', SRC_DOT = 'tcm-dot', SRC_LBL = 'tcm-lbl', SRC_CELL = 'tcm-cell'
const LYR_RING = 'tcm-ring-l', LYR_PROJ = 'tcm-proj-l', LYR_DOT = 'tcm-dot-l', LYR_LBL = 'tcm-lbl-l', LYR_CELL = 'tcm-cell-l', LYR_CELL_OUT = 'tcm-cell-out-l'

export default function TerrainClearance({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(300)
  const [pullupFt, setPullupFt] = useState(500)
  const [warnFt, setWarnFt] = useState(1500)
  const [cautionFt, setCautionFt] = useState(3000)
  const [showRing, setShowRing] = useState(true)
  const [showCells, setShowCells] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl || fl > maxFl) continue
      const klass = classify(f.type, f.category)
      const gs = Math.max(0, f.velocityKts || 0)
      const trk = f.track || 0
      const vs = f.vertRate || 0
      const terrainFt = terrainAt(f.lat, f.lng)
      const hatFt = f.altitudeFt - terrainFt
      // 10nm-ahead terrain look-ahead for closure rate
      const ahead = projectGc(f.lat, f.lng, trk, 10)
      const aheadTerrainFt = terrainAt(ahead.lat, ahead.lng)
      const terrainRiseFt = aheadTerrainFt - terrainFt  // ft per 10nm on track
      // closure (fpm): pure descent + ground-track approach into rising terrain
      const sinkFpm = vs < 0 ? -vs : 0
      const riseFpm = (terrainRiseFt / 10) * (gs / 60)  // ft per nm * nm/min
      const closureFpm = sinkFpm + Math.max(0, riseFpm)
      const timeToImpactMin = closureFpm > 1 && hatFt > 0 ? hatFt / closureFpm : 999
      // Tier
      let tier: Tier
      if (hatFt < pullupFt && closureFpm > 0) tier = 'PULLUP'
      else if (hatFt < warnFt && closureFpm > 200) tier = 'WARN'
      else if (hatFt < cautionFt) tier = 'CAUTION'
      else tier = 'OK'
      // Projection: extrapolate ground track to impact horizon (cap 25nm)
      const projNm = Math.min(25, Math.max(2, gs * Math.min(timeToImpactMin, 8) / 60))
      const recPt = projectGc(f.lat, f.lng, trk, projNm)
      out.push({
        f, klass, altFt: f.altitudeFt, gs, trk, vs,
        terrainFt, hatFt, closureFpm, timeToImpactMin,
        aheadTerrainFt, recLat: recPt.lat, recLng: recPt.lng, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return a.hatFt - b.hatFt
    })
    return out
  }, [flights, minFl, maxFl, pullupFt, warnFt, cautionFt])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, CAUTION: 0, WARN: 0, PULLUP: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let minHat = Infinity, worstCs = '', pullup = 0
    for (const r of rows) {
      if (r.hatFt < minHat) { minHat = r.hatFt; worstCs = (r.f.callsign || r.f.icao).trim() }
      if (r.tier === 'PULLUP') pullup++
    }
    if (!isFinite(minHat)) minHat = 0
    return { minHat, worstCs, pullup, total: rows.length }
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

  // Terrain cells visible within map bounds for OVL.
  const cellFeatures = useMemo(() => {
    if (!map) return []
    let b: any = null
    try { b = map.getBounds() } catch {}
    const w = b ? b.getWest() : -180, e = b ? b.getEast() : 180
    const s = b ? b.getSouth() : -90, n = b ? b.getNorth() : 90
    const feats: any[] = []
    for (const [key, ft] of Object.entries(TERRAIN_CELLS)) {
      if (ft < 3000) continue
      const [liS, giS] = key.split(',')
      const li = parseInt(liS), gi = parseInt(giS)
      const latS = li * 10 - 90, latN = latS + 10
      const lngW = gi * 10 - 180, lngE = lngW + 10
      if (latN < s || latS > n) continue
      if (lngE < w || lngW > e) continue
      // grayscale by elevation 3000..29000 -> 0.05..0.30 opacity
      const op = Math.min(0.30, 0.05 + ((ft - 3000) / 26000) * 0.25)
      feats.push({
        type: 'Feature',
        properties: { color: '#94a3b8', opacity: op, ft, label: `${(ft / 1000).toFixed(0)}k` },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [lngW, latS], [lngE, latS], [lngE, latN], [lngW, latN], [lngW, latS],
          ]],
        },
      })
    }
    return feats
  }, [map, rows])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + Math.max(0, Math.min(14, (3000 - r.hatFt) / 200)) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projRows = rows.filter(r => r.tier === 'PULLUP' || r.tier === 'WARN')
    const projFc = { type: 'FeatureCollection' as const, features: showProj ? projRows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.recLng, r.recLat]] },
    })) : [] }
    const dotFc = { type: 'FeatureCollection' as const, features: showProj ? projRows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Point' as const, coordinates: [r.recLng, r.recLat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} HAT${r.hatFt >= 0 ? Math.round(r.hatFt) : 0} ${r.closureFpm > 0 ? '↓' + Math.round(r.closureFpm) : ''}`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const cellFc = { type: 'FeatureCollection' as const, features: showCells ? cellFeatures : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_CELL, cellFc, () => {
        map.addLayer({ id: LYR_CELL, type: 'fill', source: SRC_CELL, paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': ['get', 'opacity'],
        } })
        map.addLayer({ id: LYR_CELL_OUT, type: 'line', source: SRC_CELL, paint: {
          'line-color': '#475569',
          'line-width': 0.6,
          'line-opacity': 0.5,
          'line-dasharray': [2, 3],
        } })
      })
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'circle', source: SRC_RING, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.6,
        'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.6,
        'line-opacity': 0.8,
        'line-dasharray': [3, 2],
      } }))
      ensure(SRC_DOT, dotFc, () => map.addLayer({ id: LYR_DOT, type: 'circle', source: SRC_DOT, paint: {
        'circle-radius': 4.5,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#020617',
        'circle-stroke-width': 1.2,
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-offset': [0, 1.6],
        'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.2,
      } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_DOT, LYR_PROJ, LYR_RING, LYR_CELL_OUT, LYR_CELL]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_DOT, SRC_PROJ, SRC_RING, SRC_CELL]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showRing, showProj, showLabels, showCells, cellFeatures])

  // SVG diagram: x = FL 0..300, y = HAT ft 0..15000
  const diag = useMemo(() => {
    const W = 360, H = 160, PAD = 30
    const xMaxFl = 300, yMaxHat = 15000
    const xs = (fl: number) => PAD + (Math.max(0, Math.min(xMaxFl, fl)) / xMaxFl) * (W - PAD - 6)
    const ys = (h: number) => 6 + (1 - Math.max(0, Math.min(yMaxHat, h)) / yMaxHat) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMaxFl, yMaxHat }
  }, [])

  const minHatColor = summary.minHat < pullupFt ? '#ef4444' : summary.minHat < warnFt ? '#f59e0b' : summary.minHat < cautionFt ? '#0ea5e9' : '#10b981'

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Terrain Clearance · TAWS</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} tracked</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Min HAT</div>
          <div className="font-mono text-sm" style={{ color: minHatColor }}>{Math.round(summary.minHat)}<span className="text-[9px] text-slate-500"> ft</span></div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>{summary.worstCs || '—'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Pull-up</div>
          <div className="font-mono text-sm" style={{ color: summary.pullup > 0 ? '#ef4444' : '#10b981' }}>{summary.pullup}</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">HAT · ft vs FL</div>
        <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
          <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
          <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
          {[0, 3000, 6000, 9000, 12000, 15000].map(v => (
            <g key={v}>
              <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)} stroke="#1e293b" strokeDasharray="2 3" />
              <text x={diag.PAD - 2} y={diag.ys(v) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{v / 1000}k</text>
            </g>
          ))}
          {[100, 200, 300].map(fl => (
            <g key={fl}>
              <line x1={diag.xs(fl)} y1={6} x2={diag.xs(fl)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
              <text x={diag.xs(fl)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">F{fl}</text>
            </g>
          ))}
          {/* tier bands */}
          <rect x={diag.PAD} y={diag.ys(pullupFt)} width={diag.W - diag.PAD - 6} height={diag.H - diag.PAD - diag.ys(pullupFt)} fill={TIER_COLOR.PULLUP} opacity={0.10} />
          <rect x={diag.PAD} y={diag.ys(warnFt)} width={diag.W - diag.PAD - 6} height={diag.ys(pullupFt) - diag.ys(warnFt)} fill={TIER_COLOR.WARN} opacity={0.10} />
          <rect x={diag.PAD} y={diag.ys(cautionFt)} width={diag.W - diag.PAD - 6} height={diag.ys(warnFt) - diag.ys(cautionFt)} fill={TIER_COLOR.CAUTION} opacity={0.08} />
          {/* threshold lines */}
          <line x1={diag.PAD} y1={diag.ys(pullupFt)} x2={diag.W - 6} y2={diag.ys(pullupFt)} stroke={TIER_COLOR.PULLUP} strokeWidth={1} strokeDasharray="4 2" opacity={0.7} />
          <line x1={diag.PAD} y1={diag.ys(warnFt)} x2={diag.W - 6} y2={diag.ys(warnFt)} stroke={TIER_COLOR.WARN} strokeWidth={1} strokeDasharray="3 2" opacity={0.6} />
          <line x1={diag.PAD} y1={diag.ys(cautionFt)} x2={diag.W - 6} y2={diag.ys(cautionFt)} stroke={TIER_COLOR.CAUTION} strokeWidth={1} strokeDasharray="2 3" opacity={0.5} />
          <text x={diag.W - 8} y={diag.ys(pullupFt) - 2} textAnchor="end" fontSize={8} fill={TIER_COLOR.PULLUP} fontFamily="monospace">PULLUP {pullupFt}</text>
          <text x={diag.W - 8} y={diag.ys(warnFt) - 2} textAnchor="end" fontSize={8} fill={TIER_COLOR.WARN} fontFamily="monospace">WARN {warnFt}</text>
          <text x={diag.W - 8} y={diag.ys(cautionFt) - 2} textAnchor="end" fontSize={8} fill={TIER_COLOR.CAUTION} fontFamily="monospace">CAUTN {cautionFt}</text>
          {/* aircraft dots */}
          {rows.map(r => (
            <circle key={r.f.icao} cx={diag.xs(r.altFt / 100)} cy={diag.ys(Math.max(0, r.hatFt))} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.95} />
          ))}
        </svg>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={50} max={500} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>PULLUP-FT</span><span className="font-mono text-slate-300">{pullupFt}</span></div>
            <input type="range" min={100} max={1500} step={50} value={pullupFt} onChange={e => setPullupFt(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>WARN-FT</span><span className="font-mono text-slate-300">{warnFt}</span></div>
            <input type="range" min={500} max={3000} step={100} value={warnFt} onChange={e => setWarnFt(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div className="col-span-2">
            <div className="flex justify-between text-[10px] text-slate-500"><span>CAUTION-FT</span><span className="font-mono text-slate-300">{cautionFt}</span></div>
            <input type="range" min={1000} max={6000} step={250} value={cautionFt} onChange={e => setCautionFt(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showCells} onChange={e => setShowCells(e.target.checked)} className="accent-sky-500" /><span>CELLS</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRing} onChange={e => setShowRing(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{filtered.length} shown / {rows.length} tracked</span>
        <span>HAT · closure · TTI</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {filtered.map(r => {
          // HAT progress 0..6000ft -> bar inversely (lower = more rose)
          const hatPct = Math.max(0, Math.min(100, (r.hatFt / 6000) * 100))
          const advice = r.tier === 'OK' ? 'safe'
            : r.tier === 'CAUTION' ? 'terrain ahead, monitor MSA'
            : r.tier === 'WARN' ? 'reduce sink, check chart MEA'
            : 'TERRAIN PULL UP — climb now'
          const tti = r.timeToImpactMin < 99 ? `${r.timeToImpactMin.toFixed(1)}m` : '—'
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
                  <span title="flight level">F{Math.round(r.altFt / 100)}</span>
                  <span title="terrain">TER {Math.round(r.terrainFt)}</span>
                  <span title="height above terrain" style={{ color: TIER_COLOR[r.tier] }}>HAT {Math.round(r.hatFt)}</span>
                  <span className="ml-auto" title="vertical speed">{r.vs >= 0 ? '↑' : '↓'}{Math.abs(Math.round(r.vs))}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="HAT 0..6000ft">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${hatPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${(pullupFt / 6000) * 100}%` }} title="pullup" />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${(warnFt / 6000) * 100}%` }} title="warn" />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `${(cautionFt / 6000) * 100}%` }} title="caution" />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="closure rate (sink + terrain rise on track)">CL {Math.round(r.closureFpm)}fpm</span>
                  <span title="time to impact">TTI {tti}</span>
                  <span title="terrain 10nm ahead">AHEAD {Math.round(r.aheadTerrainFt)}</span>
                  <span className="ml-auto" title="gs">{Math.round(r.gs)}kt</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate" title="operator">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
