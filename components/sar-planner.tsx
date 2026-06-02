'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   SAR Pattern Planner
   -----------------------------------------------------------
   Plans a search & rescue pattern around a Last Known Position
   (LKP) using IAMSAR-style geometry. Drift vector is synthesised
   from live nearby aircraft wind reports (10% of wind = leeway
   approximation) plus a tunable manual current. Datum = LKP
   advanced along drift over elapsed-time-since-incident hours.

   Patterns (IAMSAR Vol III chapter 5):
     - EXPANDING SQUARE (SS) — best for small high-confidence
       search area, legs lengthening by track spacing each turn
     - SECTOR SEARCH (VS)    — 9 radial legs at 120°/60° turns,
       best for point targets with high search-object confidence
     - PARALLEL TRACK (PS)   — long boustrophedon for large area
     - CREEPING LINE (CS)    — perpendicular variant of parallel

   Per pattern the planner computes:
     - Total track length nm
     - On-scene time hr at search-platform GS
     - Per-leg POD via Koopman lateral-range exponential:
         POD_leg = 1 - exp(-W/S)
       where W = sweep-width (sensor performance) and S = track-
       spacing. Cumulative POS = 1 - (1-POD)^Nlegs assuming
       independent passes, capped at search-object POC slider.

   Map overlay:
     - Violet LKP pin + sky datum pin + dashed amber drift vector
     - Pattern leg polyline tier-coloured (entry sky → exit violet)
     - Sweep-width band as line-blur halo on every leg
     - Per-leg endpoint markers w/ leg number labels

   Side panel:
     - Pattern picker (SS/VS/PS/CS chips)
     - LKP source (selected / map center / manual lat-lng inputs)
     - Sliders: elapsed-hr, sweep-width nm, track-spacing nm,
       search-radius nm, search-GS kt, current dir/kt, POC%
     - Datum readout (lat/lng + drift-bearing/nm)
     - 4-cell summary: legs / total-nm / on-scene-hr / POS%
     - SVG schematic showing the pattern shape with sweep bands
     - Per-leg list (#, bearing, length nm, cum-POD)
   ============================================================ */

interface SarFlight {
  lat: number
  lng: number
  windDir: number
  windKts: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: SarFlight[]
  lkp: { lat: number; lng: number } | null
  onClose: () => void
  onFlyLatLng: (lat: number, lng: number, zoom?: number) => void
}

type Pattern = 'SS' | 'VS' | 'PS' | 'CS'

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

const SRC = 'sar-pat'
const SRC_DRIFT = 'sar-drift'
const SRC_PIN = 'sar-pin'
const SRC_HALO = 'sar-halo'
const LYR = 'sar-pat-l'
const LYR_HALO = 'sar-pat-halo-l'
const LYR_DRIFT = 'sar-drift-l'
const LYR_PIN = 'sar-pin-l'
const LYR_PIN_LBL = 'sar-pin-lbl-l'
const LYR_LEG_LBL = 'sar-leg-lbl-l'

const PAT_LABEL: Record<Pattern, string> = {
  SS: 'Expanding Square',
  VS: 'Sector Search',
  PS: 'Parallel Track',
  CS: 'Creeping Line',
}

export default function SarPlanner({ map, flights, lkp, onClose, onFlyLatLng }: Props) {
  const [pattern, setPattern] = useState<Pattern>(() => { try { return (localStorage.getItem('ft-sar-pat') as Pattern) || 'SS' } catch { return 'SS' } })
  const [manualLat, setManualLat] = useState<string>('')
  const [manualLng, setManualLng] = useState<string>('')
  const [useManual, setUseManual] = useState(false)
  const [elapsedHr, setElapsedHr] = useState(2)
  const [sweepW, setSweepW] = useState(2.0)         // nm
  const [trackS, setTrackS] = useState(1.0)         // nm
  const [radiusNm, setRadiusNm] = useState(20)
  const [searchKt, setSearchKt] = useState(140)
  const [curDir, setCurDir] = useState(270)         // current FROM dir
  const [curKt, setCurKt] = useState(1.0)           // sea current kt
  const [poc, setPoc] = useState(85)                // % probability of containment
  const [showOverlay, setShowOverlay] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showHalo, setShowHalo] = useState(true)
  const [trackOrient, setTrackOrient] = useState(0) // major-axis bearing for PS/CS

  useEffect(() => { try { localStorage.setItem('ft-sar-pat', pattern) } catch {} }, [pattern])

  const center = useMemo(() => {
    try { const c = map?.getCenter(); return c ? { lat: c.lat, lng: c.lng } : { lat: 40, lng: -95 } } catch { return { lat: 40, lng: -95 } }
  }, [map])

  const lkpPt = useMemo(() => {
    if (useManual) {
      const la = parseFloat(manualLat), lo = parseFloat(manualLng)
      if (Number.isFinite(la) && Number.isFinite(lo)) return { lat: la, lng: lo }
    }
    if (lkp) return lkp
    return center
  }, [useManual, manualLat, manualLng, lkp, center])

  // ---- synthesise drift = leeway(10% wind) + current ----
  const drift = useMemo(() => {
    // sample wind reports within 200nm of LKP
    let su = 0, sv = 0, sw = 0
    for (const f of flights) {
      if (f.ground) continue
      if (!f.windKts || f.windKts <= 0) continue
      const r = distNm(f.lat, f.lng, lkpPt.lat, lkpPt.lng)
      if (r > 200) continue
      const w = Math.max(0, 1 - r / 200)
      const u = -f.windKts * Math.sin(f.windDir * RAD)
      const v = -f.windKts * Math.cos(f.windDir * RAD)
      su += u * w; sv += v * w; sw += w
    }
    let windKt = 0, windToward = 0
    if (sw > 0) {
      const uM = su/sw, vM = sv/sw
      windKt = Math.sqrt(uM*uM + vM*vM)
      windToward = (Math.atan2(uM, vM) * DEG + 360) % 360
    }
    // leeway = 10% of wind speed in TOWARD direction
    const leewayKt = windKt * 0.10
    const leewayDir = windToward
    // current "FROM" → toward = +180
    const curToward = (curDir + 180) % 360
    // sum vectors
    const lu = leewayKt * Math.sin(leewayDir * RAD)
    const lv = leewayKt * Math.cos(leewayDir * RAD)
    const cu = curKt * Math.sin(curToward * RAD)
    const cv = curKt * Math.cos(curToward * RAD)
    const tu = lu + cu, tv = lv + cv
    const ktTot = Math.sqrt(tu*tu + tv*tv)
    const dirTo = (Math.atan2(tu, tv) * DEG + 360) % 360
    return { kt: ktTot, dirTo, leewayKt, windKt, samples: sw > 0 ? Math.round(sw * 10) / 10 : 0 }
  }, [flights, lkpPt.lat, lkpPt.lng, curDir, curKt])

  const datum = useMemo(() => {
    const dNm = drift.kt * elapsedHr
    if (dNm < 0.01) return { lat: lkpPt.lat, lng: lkpPt.lng, brg: 0, nm: 0 }
    const [lo, la] = destPt(lkpPt.lat, lkpPt.lng, drift.dirTo, dNm)
    return { lat: la, lng: lo, brg: drift.dirTo, nm: dNm }
  }, [lkpPt, drift, elapsedHr])

  // ---- build pattern legs (list of [lat,lng] vertices) ----
  type Leg = { from: [number,number]; to: [number,number]; brg: number; nm: number; idx: number }
  const legs = useMemo<Leg[]>(() => {
    const out: Leg[] = []
    const start: [number, number] = [datum.lat, datum.lng]
    let pos: [number, number] = start

    const push = (to: [number,number], brg: number, nm: number) => {
      out.push({ from: pos, to, brg, nm, idx: out.length + 1 })
      pos = to
    }

    if (pattern === 'SS') {
      // expanding square — first leg orient = trackOrient, turn right 90° each corner, leg N has length = ceil(N/2)*S
      let brg = trackOrient
      let legN = 1
      let cum = 0
      const maxCum = radiusNm * 4  // perimeter budget
      while (cum < maxCum && legN < 60) {
        const len = Math.ceil(legN / 2) * trackS
        if (len > radiusNm * 2) break
        const [lo, la] = destPt(pos[0], pos[1], brg, len)
        push([la, lo], brg, len)
        cum += len
        brg = (brg + 90) % 360
        legN++
      }
    } else if (pattern === 'VS') {
      // sector search — 9 legs of length radiusNm, alternating across center
      // IAMSAR: 1st leg outbound on brg, turn 120° right at end, inbound through datum,
      // continue trackS past, turn 120° right, etc. Simplified: 9 radial legs with center crossings.
      const turns = [0, 120, 60, 120, 60, 120, 60, 120, 60]
      let brg = trackOrient
      for (let i = 0; i < 9; i++) {
        brg = (brg + turns[i]) % 360
        const [lo, la] = destPt(pos[0], pos[1], brg, radiusNm)
        push([la, lo], brg, radiusNm)
      }
    } else {
      // PS / CS — boustrophedon across a square of side 2*radiusNm centered on datum
      // PS: long-axis along trackOrient, lateral steps perpendicular by trackS
      // CS: same but long-axis perpendicular to trackOrient
      const longAxis = pattern === 'PS' ? trackOrient : (trackOrient + 90) % 360
      const latAxis = (longAxis + 90) % 360
      const halfL = radiusNm
      const halfW = radiusNm
      // starting corner: opposite-lateral of latAxis (i.e. -latAxis half)
      const [slo, sla] = destPt(datum.lat, datum.lng, (latAxis + 180) % 360, halfW)
      const [slo2, sla2] = destPt(sla, slo, (longAxis + 180) % 360, halfL)
      pos = [sla2, slo2]
      const nSteps = Math.max(1, Math.floor((2 * halfW) / trackS))
      let dir = longAxis
      for (let i = 0; i <= nSteps; i++) {
        const [elo, ela] = destPt(pos[0], pos[1], dir, 2 * halfL)
        push([ela, elo], dir, 2 * halfL)
        if (i === nSteps) break
        // lateral step
        const [tlo, tla] = destPt(pos[0], pos[1], latAxis, trackS)
        push([tla, tlo], latAxis, trackS)
        dir = (dir + 180) % 360
      }
    }
    return out
  }, [pattern, datum.lat, datum.lng, trackOrient, trackS, radiusNm])

  // ---- statistics ----
  const stats = useMemo(() => {
    const totalNm = legs.reduce((s, l) => s + l.nm, 0)
    const onSceneHr = searchKt > 0 ? totalNm / searchKt : 0
    // Koopman per-leg POD
    const podLeg = 1 - Math.exp(-sweepW / Math.max(0.01, trackS))
    // Track-spacing in expanding square: each loop covers area once.
    // For PS/CS each forward leg is a sweep. Number of effective sweeps:
    const sweeps = pattern === 'PS' || pattern === 'CS'
      ? legs.filter(l => l.nm > trackS * 2).length
      : pattern === 'VS' ? 9
      : Math.max(1, Math.floor(legs.length / 4))
    const cumPodNoRedundancy = 1 - Math.pow(1 - podLeg, sweeps)
    const pos = cumPodNoRedundancy * (poc / 100)
    return { totalNm, onSceneHr, podLeg, sweeps, cumPod: cumPodNoRedundancy, pos }
  }, [legs, searchKt, sweepW, trackS, poc, pattern])

  // ---- map overlay ----
  useEffect(() => {
    if (!map) return
    const m = map as any
    const remove = () => {
      for (const id of [LYR_LEG_LBL, LYR_PIN_LBL, LYR_PIN, LYR_DRIFT, LYR_HALO, LYR]) {
        try { if (m.getLayer(id)) m.removeLayer(id) } catch {}
      }
      for (const id of [SRC, SRC_DRIFT, SRC_PIN, SRC_HALO]) {
        try { if (m.getSource(id)) m.removeSource(id) } catch {}
      }
    }
    if (!showOverlay) { remove(); return }

    // pattern polyline with per-leg color ramp
    const patFC: any = { type: 'FeatureCollection', features: [] as any[] }
    legs.forEach((l, i) => {
      const t = legs.length > 1 ? i / (legs.length - 1) : 0
      // sky -> violet ramp
      const r = Math.round(14 + (167-14)*t)
      const g = Math.round(165 + (139-165)*t)
      const b = Math.round(233 + (250-233)*t)
      const color = `rgb(${r},${g},${b})`
      patFC.features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[l.from[1], l.from[0]], [l.to[1], l.to[0]]] },
        properties: { color, idx: l.idx, label: showLabels ? `${l.idx}` : '' },
      })
    })
    // halo: same lines, fat blur
    const haloFC: any = { type: 'FeatureCollection', features: patFC.features }

    // drift vector LKP -> datum
    const driftFC: any = { type: 'FeatureCollection', features: [] as any[] }
    if (datum.nm > 0.01) {
      driftFC.features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[lkpPt.lng, lkpPt.lat], [datum.lng, datum.lat]] },
        properties: {},
      })
    }
    // pins: LKP (violet) + datum (sky)
    const pinFC: any = {
      type: 'FeatureCollection',
      features: [
        { type:'Feature', geometry:{type:'Point', coordinates:[lkpPt.lng, lkpPt.lat]}, properties:{ color:'#a78bfa', label: showLabels?'LKP':'' } },
        { type:'Feature', geometry:{type:'Point', coordinates:[datum.lng, datum.lat]}, properties:{ color:'#0ea5e9', label: showLabels?'DATUM':'' } },
      ],
    }
    // leg endpoint markers — small dots at end of every leg
    legs.forEach(l => {
      pinFC.features.push({ type:'Feature', geometry:{type:'Point', coordinates:[l.to[1], l.to[0]]}, properties:{ color:'#1e293b', label: showLabels?String(l.idx):'' } })
    })

    const upsert = (id: string, data: any) => {
      if (m.getSource(id)) (m.getSource(id) as any).setData(data)
      else m.addSource(id, { type: 'geojson', data })
    }
    upsert(SRC_HALO, haloFC); upsert(SRC, patFC); upsert(SRC_DRIFT, driftFC); upsert(SRC_PIN, pinFC)

    if (showHalo && !m.getLayer(LYR_HALO)) m.addLayer({ id: LYR_HALO, type: 'line', source: SRC_HALO, paint: { 'line-color': ['get','color'], 'line-width': Math.max(4, sweepW * 6), 'line-blur': Math.max(4, sweepW * 4), 'line-opacity': 0.18 } })
    if (!showHalo && m.getLayer(LYR_HALO)) { try { m.removeLayer(LYR_HALO) } catch {} }
    if (!m.getLayer(LYR)) m.addLayer({ id: LYR, type: 'line', source: SRC, paint: { 'line-color': ['get','color'], 'line-width': 2.2, 'line-opacity': 0.95 } })
    if (!m.getLayer(LYR_DRIFT)) m.addLayer({ id: LYR_DRIFT, type: 'line', source: SRC_DRIFT, paint: { 'line-color': '#fbbf24', 'line-width': 2.5, 'line-opacity': 0.9, 'line-dasharray': [3, 2] } })
    if (!m.getLayer(LYR_PIN)) m.addLayer({ id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: { 'circle-radius': ['case', ['in', ['get','label'], ['literal', ['LKP','DATUM']]], 7, 3], 'circle-color': ['get','color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2, 'circle-opacity': 0.95 } as any })
    if (!m.getLayer(LYR_PIN_LBL)) m.addLayer({ id: LYR_PIN_LBL, type: 'symbol', source: SRC_PIN, layout: { 'text-field': ['get','label'], 'text-size': 10, 'text-offset': [0, -1.2], 'text-anchor':'bottom', 'text-allow-overlap': true }, paint: { 'text-color': '#e2e8f0', 'text-halo-color':'#0f172a', 'text-halo-width': 1.4 } })

    return () => remove()
  }, [map, showOverlay, showHalo, showLabels, legs, lkpPt.lat, lkpPt.lng, datum.lat, datum.lng, datum.nm, sweepW])

  // ---- SVG schematic ----
  const SCH_W = 320, SCH_H = 200
  const schExtent = useMemo(() => {
    if (legs.length === 0) return 1
    let maxR = 0
    for (const l of legs) {
      const dx = (l.to[1] - datum.lng), dy = (l.to[0] - datum.lat)
      maxR = Math.max(maxR, Math.abs(dx), Math.abs(dy))
    }
    return Math.max(maxR * 1.1, 0.0001)
  }, [legs, datum.lat, datum.lng])
  const scx = SCH_W / 2, scy = SCH_H / 2
  const scaleSch = (Math.min(SCH_W, SCH_H) - 40) / 2 / schExtent
  const schPt = (lat: number, lng: number): [number, number] =>
    [scx + (lng - datum.lng) * scaleSch, scy - (lat - datum.lat) * scaleSch]

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-w-[95vw] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-100 max-h-[80vh] overflow-y-auto">
      <div className="sticky top-0 bg-slate-950/95 backdrop-blur-xl px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">IAMSAR pattern designer · Koopman POD</div>
          <div className="text-sm font-semibold">SAR Planner</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* Pattern picker */}
      <div className="px-4 pt-3 grid grid-cols-4 gap-1.5">
        {(['SS','VS','PS','CS'] as Pattern[]).map(p => (
          <button key={p} onClick={()=>setPattern(p)}
            className={`px-2 py-1.5 rounded-lg border text-left transition ${pattern===p ? 'bg-sky-500/15 border-sky-500/50' : 'bg-slate-900/50 border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[9px] uppercase tracking-widest text-slate-500">{p}</div>
            <div className="text-[10px] font-semibold text-slate-200 leading-tight">{PAT_LABEL[p].split(' ')[0]}</div>
          </button>
        ))}
      </div>
      <div className="px-4 pt-1 text-[10px] text-slate-500">{PAT_LABEL[pattern]}</div>

      {/* LKP source */}
      <div className="px-4 pt-3">
        <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">Last Known Position</div>
        <div className="flex items-center gap-1.5 text-[10px]">
          <button onClick={()=>setUseManual(false)} className={`px-2 py-1 rounded-md border ${!useManual?'bg-sky-500/15 border-sky-500/40 text-sky-200':'bg-slate-900/50 border-slate-800 text-slate-400'}`}>
            {lkp ? 'SELECTED A/C' : 'MAP CENTER'}
          </button>
          <button onClick={()=>setUseManual(true)} className={`px-2 py-1 rounded-md border ${useManual?'bg-sky-500/15 border-sky-500/40 text-sky-200':'bg-slate-900/50 border-slate-800 text-slate-400'}`}>MANUAL</button>
          {useManual && (
            <>
              <input value={manualLat} onChange={e=>setManualLat(e.target.value)} placeholder="lat"
                className="w-16 bg-slate-900/60 border border-slate-800 rounded px-1.5 py-1 text-[11px] font-mono outline-none focus:border-sky-500/60" />
              <input value={manualLng} onChange={e=>setManualLng(e.target.value)} placeholder="lng"
                className="w-16 bg-slate-900/60 border border-slate-800 rounded px-1.5 py-1 text-[11px] font-mono outline-none focus:border-sky-500/60" />
            </>
          )}
          <button onClick={()=>onFlyLatLng(lkpPt.lat, lkpPt.lng, 9)} className="ml-auto px-2 py-1 rounded-md border bg-slate-900/50 border-slate-800 text-slate-300 hover:bg-slate-800/80">Fit</button>
        </div>
        <div className="mt-1 text-[10px] font-mono text-slate-400">
          LKP {lkpPt.lat.toFixed(3)},{lkpPt.lng.toFixed(3)}  →  DATUM {datum.lat.toFixed(3)},{datum.lng.toFixed(3)}
        </div>
        <div className="text-[10px] font-mono text-slate-500">drift {datum.nm.toFixed(1)}nm @ {Math.round(datum.brg).toString().padStart(3,'0')}° · leeway {drift.leewayKt.toFixed(1)}kt · current {curKt.toFixed(1)}kt</div>
      </div>

      {/* Summary */}
      <div className="px-4 pt-3 grid grid-cols-4 gap-1.5">
        <div className="px-2 py-1.5 rounded-lg bg-slate-900/50 border border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Legs</div>
          <div className="text-base font-bold tabular-nums">{legs.length}</div>
        </div>
        <div className="px-2 py-1.5 rounded-lg bg-slate-900/50 border border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Track nm</div>
          <div className="text-base font-bold tabular-nums">{stats.totalNm.toFixed(1)}</div>
        </div>
        <div className="px-2 py-1.5 rounded-lg bg-slate-900/50 border border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">On-scene h</div>
          <div className="text-base font-bold tabular-nums">{stats.onSceneHr.toFixed(2)}</div>
        </div>
        <div className="px-2 py-1.5 rounded-lg bg-slate-900/50 border border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">POS %</div>
          <div className="text-base font-bold tabular-nums" style={{color: stats.pos>0.7?'#10b981':stats.pos>0.4?'#fbbf24':'#f43f5e'}}>{(stats.pos*100).toFixed(0)}</div>
        </div>
      </div>

      {/* SVG schematic */}
      <div className="px-4 pt-3">
        <div className="rounded-xl bg-slate-900/40 border border-slate-800 p-2">
          <svg width={SCH_W} height={SCH_H} className="block w-full">
            {/* grid */}
            <line x1={0} y1={scy} x2={SCH_W} y2={scy} stroke="#1e293b" strokeWidth={0.6} />
            <line x1={scx} y1={0} x2={scx} y2={SCH_H} stroke="#1e293b" strokeWidth={0.6} />
            {/* sweep halos */}
            {legs.map((l, i) => {
              const [x1,y1] = schPt(l.from[0], l.from[1])
              const [x2,y2] = schPt(l.to[0], l.to[1])
              const haloW = Math.max(2, sweepW * scaleSch * (1/60))
              const t = legs.length>1 ? i/(legs.length-1) : 0
              const r = Math.round(14 + (167-14)*t), g = Math.round(165 + (139-165)*t), b = Math.round(233 + (250-233)*t)
              return <line key={`h${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={`rgb(${r},${g},${b})`} strokeWidth={haloW} opacity={0.18} strokeLinecap="round" />
            })}
            {/* pattern */}
            {legs.map((l, i) => {
              const [x1,y1] = schPt(l.from[0], l.from[1])
              const [x2,y2] = schPt(l.to[0], l.to[1])
              const t = legs.length>1 ? i/(legs.length-1) : 0
              const r = Math.round(14 + (167-14)*t), g = Math.round(165 + (139-165)*t), b = Math.round(233 + (250-233)*t)
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={`rgb(${r},${g},${b})`} strokeWidth={1.4} />
            })}
            {/* datum */}
            <circle cx={scx} cy={scy} r={4} fill="#0ea5e9" stroke="#fff" strokeWidth={1} />
            <text x={scx+6} y={scy-6} fontSize={9} fontFamily="monospace" fill="#0ea5e9">DATUM</text>
            {/* drift vector from LKP -> datum if both visible */}
            {(() => {
              const [lx, ly] = schPt(lkpPt.lat, lkpPt.lng)
              if (datum.nm < 0.01) return null
              return <>
                <line x1={lx} y1={ly} x2={scx} y2={scy} stroke="#fbbf24" strokeWidth={1.2} strokeDasharray="3 2" />
                <circle cx={lx} cy={ly} r={3.5} fill="#a78bfa" stroke="#fff" strokeWidth={1} />
                <text x={lx+5} y={ly-5} fontSize={9} fontFamily="monospace" fill="#a78bfa">LKP</text>
              </>
            })()}
          </svg>
        </div>
      </div>

      {/* sliders */}
      <div className="px-4 pt-3 grid grid-cols-2 gap-x-3 gap-y-2">
        <label className="block col-span-2">
          <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500"><span>Elapsed h</span><span className="font-mono text-slate-300">{elapsedHr.toFixed(1)} h</span></div>
          <input type="range" min={0} max={24} step={0.25} value={elapsedHr} onChange={e=>setElapsedHr(+e.target.value)} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500"><span>Sweep W</span><span className="font-mono text-slate-300">{sweepW.toFixed(1)}nm</span></div>
          <input type="range" min={0.2} max={8} step={0.1} value={sweepW} onChange={e=>setSweepW(+e.target.value)} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500"><span>Track S</span><span className="font-mono text-slate-300">{trackS.toFixed(1)}nm</span></div>
          <input type="range" min={0.2} max={8} step={0.1} value={trackS} onChange={e=>setTrackS(+e.target.value)} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500"><span>Radius</span><span className="font-mono text-slate-300">{radiusNm}nm</span></div>
          <input type="range" min={2} max={100} step={1} value={radiusNm} onChange={e=>setRadiusNm(+e.target.value)} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500"><span>Search GS</span><span className="font-mono text-slate-300">{searchKt}kt</span></div>
          <input type="range" min={40} max={300} step={5} value={searchKt} onChange={e=>setSearchKt(+e.target.value)} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500"><span>Track orient</span><span className="font-mono text-slate-300">{Math.round(trackOrient).toString().padStart(3,'0')}°</span></div>
          <input type="range" min={0} max={359} step={1} value={trackOrient} onChange={e=>setTrackOrient(+e.target.value)} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500"><span>Current FROM</span><span className="font-mono text-slate-300">{Math.round(curDir).toString().padStart(3,'0')}°</span></div>
          <input type="range" min={0} max={359} step={1} value={curDir} onChange={e=>setCurDir(+e.target.value)} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500"><span>Current kt</span><span className="font-mono text-slate-300">{curKt.toFixed(1)}</span></div>
          <input type="range" min={0} max={6} step={0.1} value={curKt} onChange={e=>setCurKt(+e.target.value)} className="w-full accent-sky-500" />
        </label>
        <label className="block col-span-2">
          <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500"><span>POC %</span><span className="font-mono text-slate-300">{poc}%</span></div>
          <input type="range" min={10} max={100} step={5} value={poc} onChange={e=>setPoc(+e.target.value)} className="w-full accent-sky-500" />
        </label>
      </div>

      {/* toggles */}
      <div className="px-4 pt-3 flex flex-wrap gap-1.5">
        {[
          ['OVL', showOverlay, ()=>setShowOverlay(v=>!v)],
          ['HALO', showHalo, ()=>setShowHalo(v=>!v)],
          ['LBL', showLabels, ()=>setShowLabels(v=>!v)],
        ].map(([l, on, fn]: any) => (
          <button key={l} onClick={fn}
            className={`px-2 py-1 rounded-md border text-[10px] uppercase tracking-widest transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:bg-slate-800/80'}`}>{l}</button>
        ))}
      </div>

      {/* POD / sweeps readout */}
      <div className="px-4 pt-3 text-[11px] font-mono text-slate-400">
        per-leg POD <span className="text-sky-300">{(stats.podLeg*100).toFixed(0)}%</span>
        {' · '}sweeps <span className="text-slate-200">{stats.sweeps}</span>
        {' · '}cum POD <span className="text-emerald-300">{(stats.cumPod*100).toFixed(0)}%</span>
        {' · '}POS = POD × POC = <span className="text-violet-300">{(stats.pos*100).toFixed(0)}%</span>
      </div>
      {drift.windKt > 0 && (
        <div className="px-4 text-[10px] text-slate-500">live wind sample {drift.windKt.toFixed(1)}kt → leeway {drift.leewayKt.toFixed(1)}kt</div>
      )}

      {/* leg list */}
      <div className="px-4 py-3">
        <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">Legs · {legs.length}</div>
        <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
          {legs.length === 0 && <div className="text-xs text-slate-500 px-2 py-3">No legs — increase radius.</div>}
          {legs.map((l, i) => {
            const t = legs.length > 1 ? i/(legs.length-1) : 0
            const r = Math.round(14 + (167-14)*t), g = Math.round(165 + (139-165)*t), b = Math.round(233 + (250-233)*t)
            const color = `rgb(${r},${g},${b})`
            const cumPod = 1 - Math.pow(1 - stats.podLeg, i + 1)
            return (
              <button key={i} onClick={()=>onFlyLatLng(l.to[0], l.to[1], 10)}
                className="w-full text-left rounded-lg bg-slate-900/40 border border-slate-800 overflow-hidden hover:border-slate-700">
                <div className="flex items-stretch">
                  <div style={{background: color, width: 3}} />
                  <div className="flex-1 px-2 py-1.5">
                    <div className="flex items-baseline justify-between">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-xs font-bold text-slate-100">#{l.idx}</span>
                        <span className="font-mono text-[10px] text-slate-400">{Math.round(l.brg).toString().padStart(3,'0')}°</span>
                        <span className="font-mono text-[10px] text-slate-500">{l.nm.toFixed(1)}nm</span>
                      </div>
                      <span className="font-mono text-[10px] text-slate-500">cumPOD {(cumPod*100).toFixed(0)}%</span>
                    </div>
                    <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden">
                      <div className="h-full" style={{width: `${cumPod*100}%`, background: color}} />
                    </div>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
