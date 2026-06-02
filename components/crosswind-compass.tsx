'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   Crosswind Compass
   -----------------------------------------------------------
   Pick any airport in the global database, derive a "live"
   surface-wind estimate from every airborne aircraft within a
   tunable radius and below a tunable altitude ceiling (lower-
   altitude reports weight higher), then for every candidate
   runway heading (010 / 020 / ... / 360 in 10° steps) compute
   the headwind / crosswind / tailwind component vs that
   runway's takeoff direction.

   Per-runway scoring:
     headwind   kt = windSpeed * cos(windDir_TOWARD - runwayHdg)
     crosswind  kt = windSpeed * sin(windDir_TOWARD - runwayHdg)
   Pilots care about magnitude + sign:
     - headwind positive  = into the nose (good)
     - tailwind  (negative headwind) bad above ~10 kt
     - crosswind magnitude vs demonstrated-xwind limit Vxw

   Tiers:
     BEST       |xwind| <= 0.6*Vxw  AND tailwind <= 5 kt   (preferred)
     OK         |xwind| <= Vxw      AND tailwind <= 10 kt
     CAUTION    |xwind| <= 1.2*Vxw  AND tailwind <= 15 kt
     EXCEEDS    over limits — landing not advised

   Map overlay (at picked airport):
     - Sky pin for the airport with IATA tag
     - Solid sky arrow centered on the airport showing wind
       direction TOWARDS, length scaled to speed (0-50 kt)
     - Tier-colored axis line for every active candidate runway
       (showing the takeoff direction, length scaled to score)
     - Recommended-runway axis highlighted in violet with both
       reciprocal ends drawn so you can see the full runway
   Side panel:
     - Searchable airport picker + NEAREST snap + FIT button
     - 4-tier counter strip (click-to-filter)
     - 3-cell WIND DIR / WIND KT / SAMPLES summary
     - SVG wind-rose: 360° circular rose, 4 range rings at
       Vxw quarters, 8 compass spokes, every candidate runway
       hdg plotted as tier-colored radial bar with magnitude =
       score, plus blue wind-from arrow
     - Vxw slider (5-45 kt demonstrated limit)
     - RADIUS slider (10-300 nm sample radius)
     - MAX-FL slider (sample weight cutoff)
     - OVL / LBL / FIT toggles
     - Ranked runway list sorted BEST first then ascending xwind
       magnitude, tier color stripe, RWY id + reciprocal id,
       headwind kt (signed) + crosswind kt (L/R), score bar
   ============================================================ */

interface XwFlight {
  icao: string
  callsign: string
  lat: number
  lng: number
  altitudeFt: number
  windDir: number   // FROM degrees true
  windKts: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: XwFlight[]
  onClose: () => void
  onFlyLatLng: (lat: number, lng: number, zoom?: number) => void
}

type Tier = 'BEST' | 'OK' | 'CAUTION' | 'EXCEEDS'
const TIER_COLOR: Record<Tier, string> = {
  BEST:    '#10b981',
  OK:      '#22d3ee',
  CAUTION: '#fbbf24',
  EXCEEDS: '#f43f5e',
}
const TIER_ORDER: Tier[] = ['BEST', 'OK', 'CAUTION', 'EXCEEDS']

const RAD = Math.PI / 180
const DEG = 180 / Math.PI
const R_NM = 3440.065

function distNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const dLat = (la2 - la1) * RAD
  const dLon = (lo2 - lo1) * RAD
  const a = Math.sin(dLat/2)**2 + Math.cos(la1*RAD)*Math.cos(la2*RAD)*Math.sin(dLon/2)**2
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}
function destPt(lat: number, lng: number, brgDeg: number, distNmIn: number): [number, number] {
  const br = brgDeg * RAD, d = distNmIn / R_NM
  const phi1 = lat * RAD, lam1 = lng * RAD
  const phi2 = Math.asin(Math.sin(phi1)*Math.cos(d) + Math.cos(phi1)*Math.sin(d)*Math.cos(br))
  const lam2 = lam1 + Math.atan2(Math.sin(br)*Math.sin(d)*Math.cos(phi1), Math.cos(d)-Math.sin(phi1)*Math.sin(phi2))
  return [((lam2*DEG + 540) % 360) - 180, phi2 * DEG]
}

const SRC = 'xw-cmp'
const SRC_RWY = 'xw-cmp-rwy'
const SRC_WIND = 'xw-cmp-wind'
const SRC_AP = 'xw-cmp-ap'
const LYR_RWY = 'xw-cmp-rwy-l'
const LYR_REC = 'xw-cmp-rec-l'
const LYR_WIND = 'xw-cmp-wind-l'
const LYR_WIND_HEAD = 'xw-cmp-wind-head-l'
const LYR_AP = 'xw-cmp-ap-l'
const LYR_AP_LBL = 'xw-cmp-ap-lbl-l'
const LYR_RWY_LBL = 'xw-cmp-rwy-lbl-l'

interface RwySolution {
  hdg: number          // takeoff heading degrees true
  id: string           // 09 / 27 / 36 etc
  recipId: string
  headwindKt: number   // signed: positive=headwind
  xwindKt: number      // signed: positive=from right
  xwindAbs: number
  tailwindKt: number   // positive if tail (= -headwind)
  score: number        // 0-100 quality
  tier: Tier
}

function hdgToId(hdg: number): string {
  let r = Math.round(hdg / 10)
  if (r === 0) r = 36
  if (r > 36) r -= 36
  return r.toString().padStart(2, '0')
}

export default function CrosswindCompass({ map, flights, onClose, onFlyLatLng }: Props) {
  const [airportI, setAirportI] = useState<string>(() => { try { return localStorage.getItem('ft-xwind-ap') || '' } catch { return '' } })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQ, setPickerQ] = useState('')
  const [radiusNm, setRadiusNm] = useState(150)
  const [maxFl, setMaxFl] = useState(180)        // cap altitude (FL) for sample weighting
  const [vxw, setVxw] = useState(25)             // demonstrated crosswind limit kt
  const [showOverlay, setShowOverlay] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [filterTier, setFilterTier] = useState<Tier | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => { try { localStorage.setItem('ft-xwind-ap', airportI) } catch {} }, [airportI])

  const center = useMemo(() => {
    try { const c = map?.getCenter(); return c ? { lat: c.lat, lng: c.lng } : { lat: 40, lng: -95 } } catch { return { lat: 40, lng: -95 } }
  }, [map, flights])

  const airport = useMemo(() => {
    if (airportI) {
      const a = AIRPORTS.find(x => x.i === airportI)
      if (a) return a
    }
    let best = AIRPORTS[0], bd = Infinity
    for (const a of AIRPORTS) {
      const d = distNm(center.lat, center.lng, a.lat, a.lon)
      if (d < bd) { bd = d; best = a }
    }
    return best
  }, [airportI, center.lat, center.lng])

  // Pick nearby aircraft + weighted-average their wind reports
  const windSamples = useMemo(() => {
    if (!airport) return [] as { f: XwFlight; rng: number; w: number }[]
    const out: { f: XwFlight; rng: number; w: number }[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!f.windKts || f.windKts <= 0) continue
      if ((f.altitudeFt / 100) > maxFl) continue
      const r = distNm(f.lat, f.lng, airport.lat, airport.lon)
      if (r > radiusNm) continue
      // weight: closer + lower = higher; range-falloff + altitude-falloff
      const rngW = Math.max(0, 1 - r / radiusNm)
      const altW = Math.max(0.1, 1 - (f.altitudeFt / 100) / maxFl)
      const w = rngW * altW
      out.push({ f, rng: r, w })
    }
    return out
  }, [flights, airport, radiusNm, maxFl])

  const wind = useMemo(() => {
    // Average wind FROM as u/v vector with weights. u = east, v = north
    if (!windSamples.length) return { dirFrom: 0, kt: 0, n: 0 }
    let su = 0, sv = 0, sw = 0
    for (const s of windSamples) {
      // wind FROM dir → blowing TOWARDS dir+180 → meteor convention u/v
      const dirRad = s.f.windDir * RAD
      // wind vector points FROM dir towards dir+180; in meteor uv: u = -ws*sin(dir), v = -ws*cos(dir)
      const u = -s.f.windKts * Math.sin(dirRad)
      const v = -s.f.windKts * Math.cos(dirRad)
      su += u * s.w
      sv += v * s.w
      sw += s.w
    }
    if (sw === 0) return { dirFrom: 0, kt: 0, n: windSamples.length }
    const uMean = su / sw, vMean = sv / sw
    const kt = Math.sqrt(uMean * uMean + vMean * vMean)
    // recover FROM-direction: vector points TOWARDS, so FROM is opposite
    const towardDir = (Math.atan2(uMean, vMean) * DEG + 360) % 360
    const dirFrom = (towardDir + 180) % 360
    return { dirFrom, kt, n: windSamples.length }
  }, [windSamples])

  // Per-runway solver — 36 candidate headings
  const runways = useMemo<RwySolution[]>(() => {
    const ws = wind.kt
    const windFrom = wind.dirFrom
    const out: RwySolution[] = []
    for (let h = 10; h <= 360; h += 10) {
      const hdg = h % 360 === 0 ? 360 : h
      // delta between wind FROM bearing and runway heading
      const delta = ((windFrom - hdg + 540) % 360) - 180   // -180..180
      const dRad = delta * RAD
      const headwindKt = ws * Math.cos(dRad)
      const xwindKt = ws * Math.sin(dRad)
      const xwindAbs = Math.abs(xwindKt)
      const tailwindKt = Math.max(0, -headwindKt)
      // tiering
      let tier: Tier = 'BEST'
      if (xwindAbs > 1.2 * vxw || tailwindKt > 15) tier = 'EXCEEDS'
      else if (xwindAbs > vxw || tailwindKt > 10) tier = 'CAUTION'
      else if (xwindAbs > 0.6 * vxw || tailwindKt > 5) tier = 'OK'
      // score: 100 when pure headwind, 0 when xwind=Vxw or tailwind>=15
      const xwindPen = Math.min(1, xwindAbs / Math.max(1, vxw))
      const tailPen = Math.min(1, tailwindKt / 15)
      const headBonus = Math.max(0, headwindKt) / Math.max(1, ws || 1)
      let score = 100 * (1 - xwindPen * 0.6 - tailPen * 0.4) + 10 * headBonus
      if (ws < 1) score = 60  // calm wind = any runway ~OK
      score = Math.max(0, Math.min(100, score))
      out.push({
        hdg,
        id: hdgToId(hdg),
        recipId: hdgToId((hdg + 180) % 360 === 0 ? 360 : (hdg + 180) % 360),
        headwindKt, xwindKt, xwindAbs, tailwindKt, score, tier,
      })
    }
    return out
  }, [wind, vxw])

  const counts = useMemo(() => ({
    BEST: runways.filter(r => r.tier === 'BEST').length,
    OK: runways.filter(r => r.tier === 'OK').length,
    CAUTION: runways.filter(r => r.tier === 'CAUTION').length,
    EXCEEDS: runways.filter(r => r.tier === 'EXCEEDS').length,
  }), [runways])

  const best = useMemo(() => {
    const sorted = [...runways].sort((a, b) => b.score - a.score)
    return sorted[0]
  }, [runways])

  const filtered = useMemo(() => {
    let list = runways
    if (filterTier) list = list.filter(r => r.tier === filterTier)
    const q = search.trim().toLowerCase()
    if (q) list = list.filter(r => r.id.includes(q) || r.recipId.includes(q))
    return [...list].sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return a.xwindAbs - b.xwindAbs
    })
  }, [runways, filterTier, search])

  // ------------ Map overlay --------------
  useEffect(() => {
    if (!map) return
    const m = map as any
    const remove = () => {
      for (const id of [LYR_REC, LYR_RWY, LYR_RWY_LBL, LYR_WIND, LYR_WIND_HEAD, LYR_AP, LYR_AP_LBL]) {
        try { if (m.getLayer(id)) m.removeLayer(id) } catch {}
      }
      for (const id of [SRC, SRC_RWY, SRC_WIND, SRC_AP]) {
        try { if (m.getSource(id)) m.removeSource(id) } catch {}
      }
    }
    if (!showOverlay || !airport) { remove(); return }

    // airport pin
    const apFC: any = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [airport.lon, airport.lat] },
        properties: { label: showLabels ? `${airport.a}  RWY ${best?.id ?? '—'}` : '' },
      }],
    }
    // wind arrow — line FROM windFrom dir towards airport, length scales with kt
    const windLen = Math.min(40, Math.max(2, wind.kt * 0.8))  // nm
    const windFC: any = { type: 'FeatureCollection', features: [] as any[] }
    if (wind.kt > 0.5) {
      const tail = destPt(airport.lat, airport.lon, wind.dirFrom, windLen)
      windFC.features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [tail, [airport.lon, airport.lat]] },
        properties: { kind: 'wind' },
      })
    }
    // each candidate runway: tier-colored radial bar at takeoff direction
    const rwyFC: any = { type: 'FeatureCollection', features: [] as any[] }
    for (const r of runways) {
      const len = 6 + (r.score / 100) * 24    // 6-30nm
      const end = destPt(airport.lat, airport.lon, r.hdg, len)
      rwyFC.features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[airport.lon, airport.lat], end] },
        properties: { color: TIER_COLOR[r.tier], score: r.score },
      })
    }
    // recommended runway — both ends drawn
    const recFC: any = { type: 'FeatureCollection', features: [] as any[] }
    if (best) {
      const lenR = 22
      const fwd = destPt(airport.lat, airport.lon, best.hdg, lenR)
      const back = destPt(airport.lat, airport.lon, (best.hdg + 180) % 360, lenR)
      recFC.features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [back, fwd] },
        properties: { id: best.id, recip: best.recipId },
      })
    }

    // upsert sources/layers
    const upsert = (id: string, data: any) => {
      if (m.getSource(id)) (m.getSource(id) as any).setData(data)
      else m.addSource(id, { type: 'geojson', data })
    }
    upsert(SRC_AP, apFC); upsert(SRC_WIND, windFC); upsert(SRC_RWY, rwyFC); upsert(SRC, recFC)

    if (!m.getLayer(LYR_RWY)) m.addLayer({ id: LYR_RWY, type: 'line', source: SRC_RWY, paint: { 'line-color': ['get','color'], 'line-width': 2, 'line-opacity': 0.85, 'line-dasharray': [3,2] } })
    if (!m.getLayer(LYR_REC)) m.addLayer({ id: LYR_REC, type: 'line', source: SRC, paint: { 'line-color': '#a78bfa', 'line-width': 5, 'line-opacity': 0.9 } })
    if (!m.getLayer(LYR_WIND)) m.addLayer({ id: LYR_WIND, type: 'line', source: SRC_WIND, paint: { 'line-color': '#0ea5e9', 'line-width': 3, 'line-opacity': 0.9 } })
    if (!m.getLayer(LYR_AP)) m.addLayer({ id: LYR_AP, type: 'circle', source: SRC_AP, paint: { 'circle-radius': 7, 'circle-color': '#a78bfa', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2, 'circle-opacity': 0.95 } })
    if (!m.getLayer(LYR_AP_LBL)) m.addLayer({ id: LYR_AP_LBL, type: 'symbol', source: SRC_AP, layout: { 'text-field': ['get','label'], 'text-size': 12, 'text-offset': [0, -1.6], 'text-anchor': 'bottom', 'text-allow-overlap': true }, paint: { 'text-color': '#e2e8f0', 'text-halo-color': '#0f172a', 'text-halo-width': 1.6 } })

    return () => remove()
  }, [map, showOverlay, showLabels, airport, runways, best, wind])

  // -------- airport picker --------
  const pickerList = useMemo(() => {
    const q = pickerQ.trim().toLowerCase()
    let base = AIRPORTS
    if (q) base = base.filter(a =>
      a.i.toLowerCase().includes(q) ||
      a.a.toLowerCase().includes(q) ||
      a.m.toLowerCase().includes(q) ||
      a.n.toLowerCase().includes(q)
    )
    return base.slice(0, 60)
  }, [pickerQ])

  // SVG wind rose: 360° polar plot
  const ROSE_SIZE = 320
  const ROSE_R = 140
  const cx = ROSE_SIZE / 2
  const cy = ROSE_SIZE / 2
  // map bearing → svg coords: north up, east right
  const polar = (brg: number, r: number): [number, number] => {
    const a = (brg - 90) * RAD
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]
  }

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-w-[95vw] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-100 max-h-[80vh] overflow-y-auto">
      <div className="sticky top-0 bg-slate-950/95 backdrop-blur-xl px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Surface wind · runway picker</div>
          <div className="text-sm font-semibold">Crosswind Compass</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* Airport picker */}
      <div className="px-4 py-3 border-b border-slate-900">
        <div className="flex items-center gap-2">
          <button onClick={()=>setPickerOpen(v=>!v)} className="flex-1 text-left bg-slate-900/60 border border-slate-800 hover:border-sky-500/40 rounded-lg px-3 py-2">
            <div className="text-[10px] uppercase tracking-widest text-slate-500">Airport</div>
            <div className="text-sm font-semibold">{airport.a} <span className="text-slate-500 font-mono text-xs">{airport.i}</span></div>
            <div className="text-[11px] text-slate-400 truncate">{airport.m}</div>
          </button>
          <button onClick={()=>{ setAirportI(''); setPickerOpen(false) }} title="Snap to nearest map center"
            className="px-2 py-2 rounded-lg bg-slate-900/60 border border-slate-800 text-[10px] uppercase tracking-widest text-slate-300 hover:bg-slate-800/80">Near</button>
          <button onClick={()=>onFlyLatLng(airport.lat, airport.lon, 10)} title="Fit map to airport"
            className="px-2 py-2 rounded-lg bg-slate-900/60 border border-slate-800 text-[10px] uppercase tracking-widest text-slate-300 hover:bg-slate-800/80">Fit</button>
        </div>
        {pickerOpen && (
          <div className="mt-2 bg-slate-900/80 border border-slate-800 rounded-lg p-2">
            <input value={pickerQ} onChange={e=>setPickerQ(e.target.value)} placeholder="Search IATA / ICAO / city"
              className="w-full bg-slate-950/70 border border-slate-800 rounded px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 outline-none focus:border-sky-500/60" />
            <div className="max-h-44 overflow-y-auto mt-2 divide-y divide-slate-800/60">
              {pickerList.map(a => (
                <button key={a.i} onClick={()=>{ setAirportI(a.i); setPickerOpen(false); setPickerQ('') }}
                  className="w-full text-left px-2 py-1.5 hover:bg-slate-800/60 rounded">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-sky-300 text-xs">{a.a}</span>
                    <span className="font-mono text-slate-500 text-[10px]">{a.i}</span>
                    <span className="text-[11px] text-slate-200 truncate">{a.m}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Tier counter strip */}
      <div className="px-4 pt-3 grid grid-cols-4 gap-1.5">
        {(['BEST','OK','CAUTION','EXCEEDS'] as Tier[]).map(t => (
          <button key={t} onClick={()=>setFilterTier(filterTier===t ? null : t)}
            className={`px-2 py-1.5 rounded-lg border text-left transition ${filterTier===t ? 'bg-sky-500/15 border-sky-500/50' : 'bg-slate-900/50 border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[9px] uppercase tracking-widest" style={{color: TIER_COLOR[t]}}>{t}</div>
            <div className="text-base font-bold tabular-nums">{counts[t]}</div>
          </button>
        ))}
      </div>

      {/* Wind summary */}
      <div className="px-4 pt-3 grid grid-cols-3 gap-1.5">
        <div className="px-2 py-1.5 rounded-lg bg-slate-900/50 border border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Wind from</div>
          <div className="text-base font-bold font-mono tabular-nums">{wind.kt > 0.5 ? Math.round(wind.dirFrom).toString().padStart(3,'0') + '°' : '—'}</div>
        </div>
        <div className="px-2 py-1.5 rounded-lg bg-slate-900/50 border border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Speed kt</div>
          <div className="text-base font-bold font-mono tabular-nums">{wind.kt.toFixed(1)}</div>
        </div>
        <div className="px-2 py-1.5 rounded-lg bg-slate-900/50 border border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Samples</div>
          <div className="text-base font-bold font-mono tabular-nums">{wind.n}</div>
        </div>
      </div>

      {/* SVG Wind rose */}
      <div className="px-4 pt-3">
        <div className="rounded-xl bg-slate-900/40 border border-slate-800 p-2 flex items-center justify-center">
          <svg width={ROSE_SIZE} height={ROSE_SIZE} className="block">
            {/* range rings */}
            {[0.25, 0.5, 0.75, 1].map(f => (
              <circle key={f} cx={cx} cy={cy} r={ROSE_R*f} fill="none" stroke="#1e293b" strokeWidth={1} strokeDasharray="3 3" />
            ))}
            {/* compass spokes */}
            {[0,45,90,135,180,225,270,315].map(brg => {
              const [x,y] = polar(brg, ROSE_R)
              return <line key={brg} x1={cx} y1={cy} x2={x} y2={y} stroke="#1e293b" strokeWidth={0.8} />
            })}
            {/* cardinal labels */}
            {[['N',0],['E',90],['S',180],['W',270]].map(([t,brg]) => {
              const [x,y] = polar(brg as number, ROSE_R + 14)
              return <text key={t as string} x={x} y={y} fill="#94a3b8" fontSize={11} fontFamily="monospace" textAnchor="middle" dominantBaseline="central">{t}</text>
            })}
            {/* runway radial bars */}
            {runways.map(r => {
              const mag = (r.score / 100) * ROSE_R
              const [x,y] = polar(r.hdg, mag)
              return <line key={r.hdg} x1={cx} y1={cy} x2={x} y2={y} stroke={TIER_COLOR[r.tier]} strokeWidth={r.tier==='BEST'?3:2} strokeOpacity={0.85} />
            })}
            {/* wind arrow — from windFrom direction toward center */}
            {wind.kt > 0.5 && (() => {
              const len = Math.min(ROSE_R, ROSE_R * (wind.kt / Math.max(20, vxw*1.5)))
              const [x,y] = polar(wind.dirFrom, len)
              return <g>
                <line x1={x} y1={y} x2={cx} y2={cy} stroke="#0ea5e9" strokeWidth={3} />
                <circle cx={cx} cy={cy} r={4} fill="#0ea5e9" />
              </g>
            })()}
            {/* best runway label */}
            {best && (() => {
              const [x,y] = polar(best.hdg, ROSE_R - 22)
              return <text x={x} y={y} fill="#a78bfa" fontSize={14} fontWeight={700} fontFamily="monospace" textAnchor="middle" dominantBaseline="central">{best.id}</text>
            })()}
            {/* center crosshair */}
            <circle cx={cx} cy={cy} r={2} fill="#475569" />
          </svg>
        </div>
        {best && (
          <div className="mt-2 px-3 py-2 rounded-lg bg-slate-900/60 border border-slate-800 flex items-center justify-between">
            <div>
              <div className="text-[9px] uppercase tracking-widest text-slate-500">Recommended</div>
              <div className="text-base font-bold font-mono">RWY {best.id} <span className="text-slate-500 text-xs font-normal">/ {best.recipId}</span></div>
            </div>
            <div className="text-right">
              <div className="text-[10px] text-slate-500">HW <span className="font-mono text-emerald-300">{best.headwindKt.toFixed(1)}</span></div>
              <div className="text-[10px] text-slate-500">XW <span className="font-mono text-sky-300">{best.xwindAbs.toFixed(1)}{best.xwindKt>0?'R':best.xwindKt<0?'L':''}</span></div>
            </div>
          </div>
        )}
      </div>

      {/* sliders */}
      <div className="px-4 pt-3 space-y-2">
        <label className="block">
          <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500"><span>Demonstrated Xwind (Vxw)</span><span className="font-mono text-slate-300">{vxw} kt</span></div>
          <input type="range" min={5} max={45} step={1} value={vxw} onChange={e=>setVxw(+e.target.value)} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500"><span>Sample radius</span><span className="font-mono text-slate-300">{radiusNm} nm</span></div>
          <input type="range" min={10} max={300} step={5} value={radiusNm} onChange={e=>setRadiusNm(+e.target.value)} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500"><span>Max FL cutoff</span><span className="font-mono text-slate-300">FL{maxFl}</span></div>
          <input type="range" min={30} max={450} step={10} value={maxFl} onChange={e=>setMaxFl(+e.target.value)} className="w-full accent-sky-500" />
        </label>
      </div>

      {/* toggles */}
      <div className="px-4 pt-3 flex flex-wrap gap-1.5">
        {[
          ['OVL', showOverlay, ()=>setShowOverlay(v=>!v)],
          ['LBL', showLabels, ()=>setShowLabels(v=>!v)],
        ].map(([l, on, fn]: any) => (
          <button key={l} onClick={fn}
            className={`px-2 py-1 rounded-md border text-[10px] uppercase tracking-widest transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:bg-slate-800/80'}`}>{l}</button>
        ))}
      </div>

      {/* search */}
      <div className="px-4 pt-3">
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Filter runway id (e.g. 27)"
          className="w-full bg-slate-900/60 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 outline-none focus:border-sky-500/60" />
      </div>

      {/* runway list */}
      <div className="px-4 py-3">
        <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">Runways · {filtered.length}</div>
        <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
          {filtered.length === 0 && <div className="text-xs text-slate-500 px-2 py-3">No runways match.</div>}
          {filtered.map(r => (
            <div key={r.hdg} className="rounded-lg bg-slate-900/40 border border-slate-800 overflow-hidden">
              <div className="flex items-stretch">
                <div style={{background: TIER_COLOR[r.tier], width: 3}} />
                <div className="flex-1 px-2 py-1.5">
                  <div className="flex items-baseline justify-between">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-sm font-bold text-slate-100">RWY {r.id}</span>
                      <span className="font-mono text-[10px] text-slate-500">/ {r.recipId}</span>
                      <span className="text-[9px] uppercase tracking-widest px-1.5 rounded" style={{color: TIER_COLOR[r.tier], background: TIER_COLOR[r.tier]+'22'}}>{r.tier}</span>
                    </div>
                    <span className="font-mono text-[10px] text-slate-500">score {r.score.toFixed(0)}</span>
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-3 text-[11px] font-mono">
                    <span className="text-slate-400">HW <span className={r.headwindKt >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{r.headwindKt >= 0 ? '+' : ''}{r.headwindKt.toFixed(1)}</span></span>
                    <span className="text-slate-400">XW <span className="text-sky-300">{r.xwindAbs.toFixed(1)}{r.xwindKt > 0 ? 'R' : r.xwindKt < 0 ? 'L' : ''}</span></span>
                    {r.tailwindKt > 0.5 && <span className="text-rose-400">TW {r.tailwindKt.toFixed(1)}</span>}
                  </div>
                  {/* score bar */}
                  <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden relative">
                    <div className="h-full" style={{width: `${r.score}%`, background: TIER_COLOR[r.tier]}} />
                    {/* Vxw reference tick at score where xwind=Vxw - omitted: score curve nonlinear */}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
