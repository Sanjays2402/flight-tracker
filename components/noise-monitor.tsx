'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Noise Footprint Monitor
   -----------------------------------------------------------
   Physics-ish ground sound-pressure-level model for every
   airborne aircraft. Source level (Lw, dB re 1pW) is set by
   airframe class (heavy/narrow/regional/biz/turboprop/heli/
   light-piston/military-fighter). We then attenuate by:
     - Inverse-square spreading loss: 20*log10(slant_m)
     - Atmospheric absorption (linear ~5 dB/km @ A-weighting)
     - Source-directivity (rear-arc bonus for jets in climb)
     - Thrust modifier (climb adds, descent subtracts)

   For each aircraft we solve back for the ground radius
   inside which received SPL crosses 4 thresholds:
     >= 85 dBA  (SEVERE - jackhammer)
     >= 70 dBA  (LOUD - vacuum)
     >= 55 dBA  (NOTICEABLE - conversation)
     >= 40 dBA  (AUDIBLE - quiet room)

   Renders MapLibre concentric circle polygons (geodesic
   approximation) colored by tier. Side panel ranks aircraft
   by max ground SPL with a 4-tier counter strip, search,
   ground-toggle, alt cap, and click-to-fly.
   ============================================================ */

export interface NoiseFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  vertRate: number
  ground: boolean
  military?: boolean
  category?: string
}

interface Props {
  map: maplibregl.Map | null
  flights: NoiseFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Class = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'heli' | 'piston' | 'fighter'

const CLASS_LW: Record<Class, number> = {
  heavy: 158,     // 747/777/A380
  narrow: 150,    // 737/A320
  regional: 144,  // CRJ/E-jet
  biz: 138,       // bizjet
  turboprop: 142, // ATR/Dash-8/C-130
  heli: 140,      // rotor slap is loud at distance
  piston: 122,    // C172
  fighter: 165,   // afterburner-capable
}

const CLASS_LABEL: Record<Class, string> = {
  heavy: 'Heavy jet', narrow: 'Narrowbody', regional: 'Regional jet',
  biz: 'Bizjet', turboprop: 'Turboprop', heli: 'Helicopter',
  piston: 'Light piston', fighter: 'Fighter',
}

function classify(t?: string, cat?: string, mil?: boolean): Class {
  const u = (t || '').toUpperCase()
  if (/^(B74|B77|B78|A33|A34|A35|A38|MD11|IL96|AN12|AN22|AN24|AN26|AN70|AN12|C5|C17|KC10|KC46|E4|VC25)/.test(u)) return 'heavy'
  if (/^(B73|B75|B76|A31|A32|A21|A20|MD8|MD9|TU15|TU20|YK4|E19)/.test(u)) return 'narrow'
  if (/^(CRJ|E17|E19|E29|E45|E55|AT4|AT5|AT7|DH8|F70|F10|SF3|J41|SB20)/.test(u)) return 'regional'
  if (/^(C25|C56|C68|C75|GLF|GLEX|GL5|CL3|CL6|H25|F2T|F9|F2X|LJ|PRM|BE40|E50|E55|E545|E55P|HDJT|EC|SF)/.test(u)) return 'biz'
  if (/^(C130|C295|CN23|C212|DH6|BE20|PC12|TBM|KODI|SR22|PA46|TWE|EPIC)/.test(u)) return 'turboprop'
  if (/^(EC|AS3|AS5|AS6|R22|R44|R66|S76|S92|B06|B47|B412|B429|H1|H2|H47|H60|H64|H53|UH|CH|MD5|MD9H|AW1|AW139|AW189|MI|KA)/.test(u) || cat === 'A7') return 'heli'
  if (/^(C15|C17|C18|C20|C22|PA2|PA28|PA32|DR40|SR2|DA40|DA42|TBA|GLI)/.test(u)) return 'piston'
  if (mil && /^(F1[0-9]|F2[0-9]|F4|F5|F15|F16|F18|F22|F35|EUFI|TYP|RFAL|GRIP|SU2|SU3|MIG|J10|J20|MIR|JAS)/.test(u)) return 'fighter'
  if (cat === 'A1') return 'piston'
  if (cat === 'A2' || cat === 'A3') return 'biz'
  if (cat === 'A4') return 'narrow'
  if (cat === 'A5') return 'heavy'
  return 'narrow'
}

function thrustMod(vr: number): number {
  // climb adds noise (more throttle), descent subtracts (idle)
  if (vr > 1500) return 4
  if (vr > 500) return 2
  if (vr < -1500) return -5
  if (vr < -500) return -3
  return 0
}

/**
 * Solve for slant distance (m) at which received SPL = target.
 * SPL(r) = Lw - 20*log10(r) - 11 - alpha*r/1000 + bias
 * Ignoring atmospheric term in closed-form, then iterating once.
 */
function radiusForDb(lw: number, targetDb: number, bias: number): number {
  // initial geometric solve
  const x = (lw + bias - 11 - targetDb) / 20
  let r = Math.pow(10, x)
  // newton-ish refine with absorption (alpha=5dB/km => 0.005 dB/m)
  for (let i = 0; i < 3; i++) {
    const spl = lw + bias - 20 * Math.log10(Math.max(1, r)) - 11 - 0.005 * r
    const err = spl - targetDb
    r *= Math.pow(10, err / 20) // step
  }
  return Math.max(0, r)
}

interface Hit {
  f: NoiseFlight
  cls: Class
  altM: number
  groundDb: number   // SPL directly below
  // ground radii (meters) for each tier
  r85: number
  r70: number
  r55: number
  r40: number
  maxTierIdx: number // 3=severe,2=loud,1=notice,0=audible,-1=none
}

const TIERS = [
  { idx: 3, label: 'SEVERE', sub: '≥85 dBA', fill: '#f43f5e', stroke: '#fb7185' },
  { idx: 2, label: 'LOUD',   sub: '≥70 dBA', fill: '#f97316', stroke: '#fb923c' },
  { idx: 1, label: 'NOTICE', sub: '≥55 dBA', fill: '#facc15', stroke: '#fde047' },
  { idx: 0, label: 'AUDIBLE',sub: '≥40 dBA', fill: '#22d3ee', stroke: '#67e8f9' },
]

const SRC = 'ft-noise-src'
const L_FILL = 'ft-noise-fill'
const L_LINE = 'ft-noise-line'
const L_LBL  = 'ft-noise-lbl'

// geodesic circle ring (polygon)
function circlePolygon(lat: number, lng: number, radiusM: number, steps = 48): number[][] {
  if (!Number.isFinite(radiusM) || radiusM <= 0) return []
  const R = 6371000
  const d = radiusM / R
  const latR = lat * Math.PI / 180
  const lngR = lng * Math.PI / 180
  const ring: number[][] = []
  for (let i = 0; i <= steps; i++) {
    const brg = (i / steps) * 2 * Math.PI
    const sinLat = Math.sin(latR) * Math.cos(d) + Math.cos(latR) * Math.sin(d) * Math.cos(brg)
    const lat2 = Math.asin(sinLat)
    const y = Math.sin(brg) * Math.sin(d) * Math.cos(latR)
    const x = Math.cos(d) - Math.sin(latR) * sinLat
    const lng2 = lngR + Math.atan2(y, x)
    ring.push([(lng2 * 180 / Math.PI + 540) % 360 - 180, lat2 * 180 / Math.PI])
  }
  return ring
}

export default function NoiseMonitor({ map, flights, onClose, onFly }: Props) {
  const lsGet = (k: string, def: any) => { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v) } catch { return def } }
  const lsSet = (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

  const [showFootprint, setShowFootprint] = useState<boolean>(() => lsGet('ft-noise-fp', true))
  const [showLabels, setShowLabels] = useState<boolean>(() => lsGet('ft-noise-lbl', true))
  const [minTier, setMinTier] = useState<number>(() => lsGet('ft-noise-tier', 0))
  const [maxAltFt, setMaxAltFt] = useState<number>(() => lsGet('ft-noise-alt', 15000))
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<'db' | 'r70' | 'callsign'>('db')

  useEffect(() => { lsSet('ft-noise-fp', showFootprint) }, [showFootprint])
  useEffect(() => { lsSet('ft-noise-lbl', showLabels) }, [showLabels])
  useEffect(() => { lsSet('ft-noise-tier', minTier) }, [minTier])
  useEffect(() => { lsSet('ft-noise-alt', maxAltFt) }, [maxAltFt])

  const hits: Hit[] = useMemo(() => {
    const out: Hit[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      if (f.altitudeFt > maxAltFt) continue
      const cls = classify(f.type, f.category, f.military)
      const lw = CLASS_LW[cls]
      const altM = Math.max(30, f.altitudeFt * 0.3048)
      const bias = thrustMod(f.vertRate || 0)
      // Direct overhead SPL
      const groundDb = lw + bias - 20 * Math.log10(altM) - 11 - 0.005 * altM
      // Tier radii on the ground require slant >= alt. Compute slant for each target, then ground radius = sqrt(slant^2 - alt^2)
      const radii: number[] = []
      for (const tgt of [40, 55, 70, 85]) {
        const slant = radiusForDb(lw, tgt, bias)
        if (slant <= altM) { radii.push(0); continue }
        radii.push(Math.sqrt(slant * slant - altM * altM))
      }
      const [r40, r55, r70, r85] = radii
      let maxTierIdx = -1
      if (r85 > 0) maxTierIdx = 3
      else if (r70 > 0) maxTierIdx = 2
      else if (r55 > 0) maxTierIdx = 1
      else if (r40 > 0) maxTierIdx = 0
      if (maxTierIdx < minTier) continue
      out.push({ f, cls, altM, groundDb, r85, r70, r55, r40, maxTierIdx })
    }
    return out
  }, [flights, maxAltFt, minTier])

  const counts = useMemo(() => {
    const c = [0, 0, 0, 0]
    for (const h of hits) {
      if (h.maxTierIdx >= 0) c[h.maxTierIdx]++
    }
    return c
  }, [hits])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    let arr = hits
    if (q) arr = arr.filter(h => (h.f.callsign || '').toUpperCase().includes(q) || (h.f.type || '').toUpperCase().includes(q) || (h.f.operator || '').toUpperCase().includes(q) || h.f.icao.toUpperCase().includes(q))
    arr = arr.slice().sort((a, b) => {
      if (sortBy === 'db') return b.groundDb - a.groundDb
      if (sortBy === 'r70') return b.r70 - a.r70
      return (a.f.callsign || '').localeCompare(b.f.callsign || '')
    })
    return arr
  }, [hits, query, sortBy])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      if (!map.getSource(SRC)) {
        map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
      }
      if (!map.getLayer(L_FILL)) {
        map.addLayer({
          id: L_FILL, type: 'fill', source: SRC,
          paint: {
            'fill-color': ['get', 'fill'],
            'fill-opacity': ['interpolate', ['linear'], ['get', 'tier'], 0, 0.08, 3, 0.28],
          },
          filter: ['==', ['get', 'kind'], 'ring']
        })
      }
      if (!map.getLayer(L_LINE)) {
        map.addLayer({
          id: L_LINE, type: 'line', source: SRC,
          paint: {
            'line-color': ['get', 'stroke'],
            'line-width': ['interpolate', ['linear'], ['get', 'tier'], 0, 0.6, 3, 1.6],
            'line-opacity': 0.85,
          },
          filter: ['==', ['get', 'kind'], 'ring']
        })
      }
      if (!map.getLayer(L_LBL)) {
        map.addLayer({
          id: L_LBL, type: 'symbol', source: SRC,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-offset': [0, -1.6],
            'text-allow-overlap': true,
          },
          paint: {
            'text-color': '#fde047',
            'text-halo-color': '#0f172a',
            'text-halo-width': 1.4,
          },
          filter: ['==', ['get', 'kind'], 'label']
        })
      }
    }
    if (!map.isStyleLoaded()) {
      map.once('load', ensure)
    } else {
      ensure()
    }
    return () => {
      try {
        for (const id of [L_LBL, L_LINE, L_FILL]) if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(SRC)) map.removeSource(SRC)
      } catch {}
    }
  }, [map])

  useEffect(() => {
    if (!map || !map.getSource(SRC)) return
    const features: any[] = []
    if (showFootprint) {
      for (const h of filtered) {
        const series: Array<{ r: number; tierIdx: number }> = []
        if (h.r40 > 0) series.push({ r: h.r40, tierIdx: 0 })
        if (h.r55 > 0) series.push({ r: h.r55, tierIdx: 1 })
        if (h.r70 > 0) series.push({ r: h.r70, tierIdx: 2 })
        if (h.r85 > 0) series.push({ r: h.r85, tierIdx: 3 })
        // largest first so smaller overlaps
        series.sort((a, b) => b.r - a.r)
        for (const s of series) {
          const ring = circlePolygon(h.f.lat, h.f.lng, s.r, 40)
          if (ring.length < 4) continue
          const t = TIERS.find(x => x.idx === s.tierIdx)!
          features.push({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [ring] },
            properties: { kind: 'ring', tier: s.tierIdx, fill: t.fill, stroke: t.stroke, icao: h.f.icao }
          })
        }
        if (showLabels) {
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [h.f.lng, h.f.lat] },
            properties: { kind: 'label', label: `${h.f.callsign || h.f.icao} · ${h.groundDb.toFixed(0)} dBA`, tier: h.maxTierIdx }
          })
        }
      }
    }
    try { (map.getSource(SRC) as any).setData({ type: 'FeatureCollection', features }) } catch {}
  }, [map, filtered, showFootprint, showLabels])

  const totalAirborne = flights.filter(f => !f.ground).length

  return (
    <div className="absolute top-20 right-2 sm:right-3 md:right-4 z-20 w-[min(94vw,22rem)] max-h-[80vh] bg-slate-950/92 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl flex flex-col text-slate-100 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-amber-400 font-semibold">Noise Monitor</div>
          <div className="text-xs text-slate-400">{hits.length}/{totalAirborne} aircraft scoring</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-rose-300 text-sm leading-none">✕</button>
      </div>

      {/* Tier counters */}
      <div className="grid grid-cols-4 gap-1 px-2 py-2 border-b border-slate-800">
        {TIERS.map(t => (
          <button
            key={t.idx}
            onClick={() => setMinTier(minTier === t.idx ? 0 : t.idx)}
            className={`flex flex-col items-center px-1 py-1.5 rounded-lg border text-[10px] uppercase tracking-wide transition ${minTier === t.idx ? 'border-amber-400' : 'border-slate-800 hover:border-slate-700'}`}
            style={{ background: `${t.fill}18` }}
          >
            <span style={{ color: t.stroke }} className="font-bold">{counts[t.idx]}</span>
            <span style={{ color: t.fill }} className="font-semibold">{t.label}</span>
            <span className="text-slate-500 text-[9px]">{t.sub}</span>
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-slate-400">
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={showFootprint} onChange={e => setShowFootprint(e.target.checked)} className="accent-amber-400" />
            <span>Footprint</span>
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-amber-400" />
            <span>Labels</span>
          </label>
        </div>
        <div>
          <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-400">
            <span>Max alt</span>
            <span className="text-slate-300">{maxAltFt.toLocaleString()} ft</span>
          </div>
          <input type="range" min={2000} max={45000} step={500} value={maxAltFt}
            onChange={e => setMaxAltFt(Number(e.target.value))}
            className="w-full accent-amber-400" />
        </div>
        <input
          value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Filter callsign / type / op"
          className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs outline-none focus:border-amber-400"
        />
        <div className="flex gap-1 text-[10px]">
          {([['db', 'Loudest'], ['r70', 'Reach'], ['callsign', 'A-Z']] as const).map(([k, lbl]) => (
            <button key={k} onClick={() => setSortBy(k)}
              className={`flex-1 px-2 py-1 rounded border uppercase tracking-widest ${sortBy === k ? 'border-amber-400 text-amber-300 bg-amber-400/10' : 'border-slate-800 text-slate-400 hover:border-slate-700'}`}>{lbl}</button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-slate-500 text-xs">No aircraft match current filters.</div>
        )}
        {filtered.slice(0, 200).map(h => {
          const tier = TIERS.find(t => t.idx === h.maxTierIdx)
          return (
            <button key={h.f.icao} onClick={() => onFly(h.f.icao)}
              className="w-full text-left px-3 py-1.5 border-b border-slate-900 hover:bg-slate-900/70 transition flex items-center gap-2">
              <span className="w-1 h-7 rounded shrink-0" style={{ background: tier?.fill || '#475569' }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-semibold text-slate-100 truncate">{h.f.callsign || h.f.icao}</span>
                  <span className="text-[10px] text-slate-500 truncate">{h.f.type || '—'}</span>
                </div>
                <div className="text-[10px] text-slate-500 truncate">{h.f.operator || CLASS_LABEL[h.cls]}</div>
              </div>
              <div className="text-right shrink-0 leading-tight">
                <div className="text-xs font-mono text-amber-300">{h.groundDb.toFixed(0)} dBA</div>
                <div className="text-[10px] text-slate-500 font-mono">{(h.r70 / 1000).toFixed(1)}km · FL{(h.f.altitudeFt / 100).toFixed(0).padStart(3, '0')}</div>
              </div>
            </button>
          )
        })}
      </div>
      <div className="px-3 py-1.5 border-t border-slate-800 text-[10px] text-slate-500 flex justify-between">
        <span>Source · spreading · absorption · thrust</span>
        <span>A-weighted</span>
      </div>
    </div>
  )
}
