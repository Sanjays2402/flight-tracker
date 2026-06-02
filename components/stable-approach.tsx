'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   Stable Approach Monitor
   -----------------------------------------------------------
   Live FSF stabilized-approach scoring for every arrival into
   a picked airport. Each inbound aircraft is checked against
   the standard ALAR Briefing Note 7.1 gates:

     Gate at 1000ft AGL (IMC) / 500ft AGL (VMC):
       - on profile  (within ±100ft of 3° glidepath)
       - on track    (within ±0.3nm of extended centerline)
       - on speed    (VRef..VRef+20 kt)
       - sink rate   (≤ 1000 fpm)
       - track stable (heading ±10° of final approach course)

   Active runway is inferred by binning every closing
   arrival's inbound bearing-to-field and picking the
   dominant 10°-radial. Runway heading = recip(inbound).

   Per-aircraft model:
     - dist nm from threshold along extended centerline
     - alt AGL above field elevation
     - on-glide delta ft   = currentAlt - (fieldElev + distNm * 318)
     - xtk nm              = perpendicular offset from RWY axis
     - speed delta kt      = ias|gs - VRef (class proxy)
     - sink delta fpm      = vertRate vs nominal (-700 .. -1000)
     - track delta deg     = |track - finalApprCourse|
     Stability Index = 0.25*|glideΔ|/100 + 0.20*|xtk|/0.3
                     + 0.20*|spdΔ|/15   + 0.20*|sinkΔ|/300
                     + 0.15*|trkΔ|/10
     Tier: STABLE<0.6 / ATTN<1.0 / UNSTBL<1.6 / GO-AROUND≥1.6

   Map overlay:
     - Violet airport pin + active RWY label
     - Sky 10nm extended centerline w/ 4/2nm fix markers
     - Tier-colored 1000ft and 500ft gate rings on glidepath
     - Tier-colored aircraft halo + dashed projection to TDZ
   Panel:
     - Searchable airport picker (NEAREST + FIT)
     - 4-tier counter strip click-to-filter
     - 3-cell INB / WORST-tier / MEAN-INDEX summary
     - SVG side-profile glideslope diagram (dist x alt-AGL)
       with 3° reference line, 1000/500ft gate bands, every
       aircraft plotted at its (dist, altAGL) coord
     - Sliders: RANGE / MAX-FL / VREF-OFFSET / MANUAL-RWY
     - Toggles: OVL / CENTERLINE / GATES / PROJ / LBL
     - Inbound list sorted worst-tier-first then ascending
       dist-to-threshold with per-row deviation chips
   ============================================================ */

interface SaFlight {
  icao: string
  callsign: string
  type: string
  operator: string
  category: string
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
  flights: SaFlight[]
  onClose: () => void
  onFly: (icao: string) => void
  onFlyLatLng: (lat: number, lng: number, zoom?: number) => void
}

type Tier = 'STABLE' | 'ATTN' | 'UNSTBL' | 'GA'
const TIER_COLOR: Record<Tier, string> = {
  STABLE: '#10b981',
  ATTN:   '#fbbf24',
  UNSTBL: '#fb923c',
  GA:     '#f43f5e',
}
const TIER_ORDER: Tier[] = ['GA','UNSTBL','ATTN','STABLE']
const TIER_LABEL: Record<Tier,string> = { STABLE:'STABLE', ATTN:'ATTENTION', UNSTBL:'UNSTABLE', GA:'GO-AROUND' }

const RAD = Math.PI / 180
const DEG = 180 / Math.PI
const R_NM = 3440.065

function distNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const dLat = (la2 - la1) * RAD, dLon = (lo2 - lo1) * RAD
  const a = Math.sin(dLat/2)**2 + Math.cos(la1*RAD)*Math.cos(la2*RAD)*Math.sin(dLon/2)**2
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1=la1*RAD, φ2=la2*RAD, Δλ=(lo2-lo1)*RAD
  const y=Math.sin(Δλ)*Math.cos(φ2)
  const x=Math.cos(φ1)*Math.sin(φ2)-Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ)
  return (Math.atan2(y,x)*DEG+360)%360
}
function destPt(lat: number, lng: number, brgDeg: number, nm: number): [number, number] {
  const br = brgDeg * RAD, d = nm / R_NM
  const phi1 = lat * RAD, lam1 = lng * RAD
  const phi2 = Math.asin(Math.sin(phi1)*Math.cos(d) + Math.cos(phi1)*Math.sin(d)*Math.cos(br))
  const lam2 = lam1 + Math.atan2(Math.sin(br)*Math.sin(d)*Math.cos(phi1), Math.cos(d)-Math.sin(phi1)*Math.sin(phi2))
  return [((lam2*DEG + 540) % 360) - 180, phi2 * DEG]
}
function hdgToId(hdg: number): string {
  let r = Math.round(hdg / 10); if (r === 0) r = 36; if (r > 36) r -= 36
  return r.toString().padStart(2, '0')
}

/* Class proxy for VRef (target threshold speed kt) */
function classOf(category: string, type: string): 'HVY'|'NRW'|'RGN'|'BIZ'|'TBP'|'GA'|'FTR'|'HEL' {
  if (category === 'A7') return 'HEL'
  if (category === 'A5' || category === 'A6') return 'HVY'
  const t = (type||'').toUpperCase()
  if (/^(A38|B74|B77|B78|B75|A33|A34|A35|MD11|IL96|DC10|L101)/.test(t)) return 'HVY'
  if (/^(A31|A32|B73|B72|B71|MD8|MD9|MD90|E19|E29|A22|A23|BCS)/.test(t)) return 'NRW'
  if (/^(E14|E15|E17|E70|E75|CRJ|DH8|AT4|AT7|AT5|F70|F10)/.test(t)) return 'RGN'
  if (/^(GLF|GLEX|GL5|CL3|CL6|HDJ|LJ|CRJ2|FA|C56|C5|C7|C68|BE40|E50P|E55P|PC24)/.test(t)) return 'BIZ'
  if (/^(BE2|BE3|B190|SF34|DHC|AN24|AN26|AN28|TBM|PC12)/.test(t)) return 'TBP'
  if (/^(F1[68]|F22|F35|EUF|MIG|SU2|SU3|J39)/.test(t)) return 'FTR'
  return 'GA'
}
const VREF: Record<string, number> = { HVY:145, NRW:138, RGN:125, BIZ:115, TBP:105, GA:75, FTR:155, HEL:65 }

const SRC_AP = 'sa-ap', SRC_CL='sa-cl', SRC_GATE='sa-gate', SRC_AC='sa-ac', SRC_PROJ='sa-proj', SRC_LBL='sa-lbl'
const LYR_AP = 'sa-ap-l', LYR_AP_LBL='sa-ap-lbl', LYR_CL='sa-cl-l', LYR_CL_PT='sa-cl-pt', LYR_GATE='sa-gate-l', LYR_GATE_LBL='sa-gate-lbl', LYR_AC='sa-ac-l', LYR_PROJ='sa-proj-l', LYR_AC_LBL='sa-ac-lbl'

interface Solution {
  f: SaFlight
  cls: ReturnType<typeof classOf>
  vref: number
  distNm: number        // along-centerline distance from threshold (+ outbound = before TDZ)
  xtkNm: number         // perpendicular offset (signed: + right of approach course)
  altAgl: number
  glideDeltaFt: number  // current alt - target glidepath alt
  spdDeltaKt: number    // gs - vref
  sinkDeltaFpm: number  // vertRate - target sink at this dist
  trkDeltaDeg: number   // |track - finalApprCourse|
  index: number
  tier: Tier
  proj: [number, number] // projected TDZ entry along ground vector
  reasons: string[]
}

export default function StableApproach({ map, flights, onClose, onFly, onFlyLatLng }: Props) {
  const [airportI, setAirportI] = useState<string>(() => { try { return localStorage.getItem('ft-stable-ap') || '' } catch { return '' } })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQ, setPickerQ] = useState('')
  const [rangeNm, setRangeNm] = useState(25)
  const [maxFl, setMaxFl] = useState(120)
  const [vrefOffset, setVrefOffset] = useState(0)
  const [manualRwy, setManualRwy] = useState<number>(-1) // -1 = AUTO
  const [showOverlay, setShowOverlay] = useState(true)
  const [showCenterline, setShowCenterline] = useState(true)
  const [showGates, setShowGates] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [filterTier, setFilterTier] = useState<Tier | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => { try { localStorage.setItem('ft-stable-ap', airportI) } catch {} }, [airportI])

  const center = useMemo(() => {
    try { const c = map?.getCenter(); return c ? { lat: c.lat, lng: c.lng } : { lat: 40, lng: -95 } } catch { return { lat: 40, lng: -95 } }
  }, [map, flights])

  const airport = useMemo(() => {
    if (airportI) { const a = AIRPORTS.find(x => x.i === airportI); if (a) return a }
    let best = AIRPORTS[0], bd = Infinity
    for (const a of AIRPORTS) { const d = distNm(center.lat, center.lng, a.lat, a.lon); if (d < bd) { bd = d; best = a } }
    return best
  }, [airportI, center.lat, center.lng])

  // Step 1: gather inbound candidates (within range, below ceiling, closing)
  const inbounds = useMemo(() => {
    if (!airport) return [] as { f: SaFlight; rng: number; brgToAp: number; closing: number }[]
    const out: { f: SaFlight; rng: number; brgToAp: number; closing: number }[] = []
    for (const f of flights) {
      if (f.ground) continue
      if ((f.altitudeFt / 100) > maxFl) continue
      const r = distNm(f.lat, f.lng, airport.lat, airport.lon)
      if (r > rangeNm) continue
      const brgToAp = bearingDeg(f.lat, f.lng, airport.lat, airport.lon)
      // closing if ground track within ±60° of bearing-to-airport
      const delta = Math.abs(((f.track - brgToAp + 540) % 360) - 180)
      if (delta > 60) continue
      const closing = Math.cos(delta * RAD)
      out.push({ f, rng: r, brgToAp, closing })
    }
    return out
  }, [flights, airport, rangeNm, maxFl])

  // Step 2: derive active runway heading
  const activeRwyHdg = useMemo(() => {
    if (manualRwy >= 0) return manualRwy
    if (!inbounds.length) return 0
    const bins = new Array(36).fill(0)
    for (const x of inbounds) {
      const w = Math.max(0.1, x.closing)
      const idx = Math.floor(((x.brgToAp + 5) % 360) / 10) % 36
      bins[idx] += w
    }
    let bi = 0, bm = -1
    for (let i = 0; i < 36; i++) if (bins[i] > bm) { bm = bins[i]; bi = i }
    // Inbound radial = runway-FROM direction; runway heading = same (we land along inbound)
    return bi * 10
  }, [inbounds, manualRwy])

  const fieldElev = 0 // (no DB; approximate sea-level for AGL; user reads delta as MSL-equivalent)

  // Step 3: per-aircraft stability
  const solutions = useMemo<Solution[]>(() => {
    if (!airport) return []
    const out: Solution[] = []
    const rwyRad = activeRwyHdg * RAD
    for (const x of inbounds) {
      const f = x.f
      // delta from airport to aircraft, project into along-track and cross-track
      // along-axis bearing = activeRwyHdg+180 (away from airport along approach)
      const apprCourse = activeRwyHdg            // landing direction
      const reciprocal = (apprCourse + 180) % 360 // away from airport (outbound)
      const brgFromAp = bearingDeg(airport.lat, airport.lon, f.lat, f.lng)
      const rel = ((brgFromAp - reciprocal + 540) % 360) - 180 // -180..180 vs outbound axis
      const distAlong = x.rng * Math.cos(rel * RAD) // + = behind airport on approach (TDZ-positive)
      const distXtk = x.rng * Math.sin(rel * RAD)   // + = right of approach course (looking toward TDZ)
      if (distAlong < 0.5) continue // crossed threshold or wrong side
      const cls = classOf(f.category, f.type)
      const vref = VREF[cls] + vrefOffset
      const altAgl = Math.max(0, f.altitudeFt - fieldElev)
      const targetGlideAlt = fieldElev + distAlong * 318  // 3° glide ≈ 318 ft/nm
      const glideDeltaFt = f.altitudeFt - targetGlideAlt
      const spdDeltaKt = f.velocityKts - vref
      const targetSink = -Math.min(1000, distAlong * 30 + 600) // shallow far out, ~-700 near, -1000 cap
      const sinkDeltaFpm = f.vertRate - targetSink
      const trkDeltaDeg = Math.abs(((f.track - apprCourse + 540) % 360) - 180)

      // gate bands
      const xtkAbs = Math.abs(distXtk)
      const idx = 0.25 * Math.min(3, Math.abs(glideDeltaFt)/100)
                + 0.20 * Math.min(3, xtkAbs/0.3)
                + 0.20 * Math.min(3, Math.abs(spdDeltaKt)/15)
                + 0.20 * Math.min(3, Math.abs(sinkDeltaFpm)/300)
                + 0.15 * Math.min(3, trkDeltaDeg/10)
      let tier: Tier = 'STABLE'
      if (idx >= 1.6) tier = 'GA'
      else if (idx >= 1.0) tier = 'UNSTBL'
      else if (idx >= 0.6) tier = 'ATTN'

      // reasons (top deviations)
      const reasons: string[] = []
      if (Math.abs(glideDeltaFt) > 100) reasons.push(glideDeltaFt > 0 ? `HIGH ${Math.round(glideDeltaFt)}ft` : `LOW ${Math.abs(Math.round(glideDeltaFt))}ft`)
      if (xtkAbs > 0.3) reasons.push(`OFFSET ${distXtk>0?'R':'L'}${xtkAbs.toFixed(1)}nm`)
      if (Math.abs(spdDeltaKt) > 15) reasons.push(spdDeltaKt > 0 ? `FAST +${Math.round(spdDeltaKt)}` : `SLOW ${Math.round(spdDeltaKt)}`)
      if (sinkDeltaFpm < -300) reasons.push(`SINK ${Math.round(f.vertRate)}fpm`)
      if (trkDeltaDeg > 10) reasons.push(`TRK Δ${Math.round(trkDeltaDeg)}°`)
      if (!reasons.length) reasons.push('on profile')

      // projected TDZ entry: continue ground vector to where x-track hits zero
      // crude: extrapolate 1nm along track
      const proj = destPt(f.lat, f.lng, f.track, Math.min(distAlong, 10))

      out.push({ f, cls, vref, distNm: distAlong, xtkNm: distXtk, altAgl, glideDeltaFt, spdDeltaKt, sinkDeltaFpm, trkDeltaDeg, index: idx, tier, proj, reasons })
    }
    return out
  }, [inbounds, airport, activeRwyHdg, vrefOffset, fieldElev])

  const counts = useMemo(() => ({
    STABLE: solutions.filter(s => s.tier === 'STABLE').length,
    ATTN:   solutions.filter(s => s.tier === 'ATTN').length,
    UNSTBL: solutions.filter(s => s.tier === 'UNSTBL').length,
    GA:     solutions.filter(s => s.tier === 'GA').length,
  }), [solutions])

  const meanIdx = useMemo(() => solutions.length ? solutions.reduce((s,x)=>s+x.index,0)/solutions.length : 0, [solutions])
  const worst = useMemo(() => { let w: Tier = 'STABLE'; for (const s of solutions) if (TIER_ORDER.indexOf(s.tier) < TIER_ORDER.indexOf(w)) w = s.tier; return w }, [solutions])

  const filtered = useMemo(() => {
    let list = solutions
    if (filterTier) list = list.filter(s => s.tier === filterTier)
    const q = search.trim().toLowerCase()
    if (q) list = list.filter(s => (s.f.callsign||'').toLowerCase().includes(q) || (s.f.type||'').toLowerCase().includes(q) || (s.f.icao||'').toLowerCase().includes(q) || (s.f.operator||'').toLowerCase().includes(q))
    return [...list].sort((a,b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return a.distNm - b.distNm
    })
  }, [solutions, filterTier, search])

  // Map overlay
  useEffect(() => {
    if (!map) return
    const m = map as any
    const remove = () => {
      for (const id of [LYR_AC_LBL, LYR_PROJ, LYR_AC, LYR_GATE_LBL, LYR_GATE, LYR_CL_PT, LYR_CL, LYR_AP_LBL, LYR_AP]) {
        try { if (m.getLayer(id)) m.removeLayer(id) } catch {}
      }
      for (const id of [SRC_AP, SRC_CL, SRC_GATE, SRC_AC, SRC_PROJ, SRC_LBL]) {
        try { if (m.getSource(id)) m.removeSource(id) } catch {}
      }
    }
    if (!showOverlay || !airport) { remove(); return }

    const apFC: any = { type:'FeatureCollection', features: [{ type:'Feature', geometry:{ type:'Point', coordinates:[airport.lon, airport.lat] }, properties:{ label: showLabels ? `${airport.a}  RWY ${hdgToId(activeRwyHdg)}` : '' } }] }

    const clFC: any = { type:'FeatureCollection', features: [] as any[] }
    if (showCenterline) {
      const tail = destPt(airport.lat, airport.lon, (activeRwyHdg+180)%360, 10)
      clFC.features.push({ type:'Feature', geometry:{ type:'LineString', coordinates: [tail, [airport.lon, airport.lat]] }, properties:{} })
      // 4nm / 2nm fix markers
      for (const fix of [2, 4, 7, 10]) {
        const p = destPt(airport.lat, airport.lon, (activeRwyHdg+180)%360, fix)
        clFC.features.push({ type:'Feature', geometry:{ type:'Point', coordinates: p }, properties:{ label: showLabels ? `${fix}nm` : '' } })
      }
    }

    const gateFC: any = { type:'FeatureCollection', features: [] as any[] }
    if (showGates) {
      // 1000ft AGL at 3° = ~3.15nm out; 500ft = ~1.57nm out
      for (const g of [{ alt:1000, nm:1000/318, color: TIER_COLOR[worst] }, { alt:500, nm:500/318, color: TIER_COLOR[worst] }]) {
        const pos = destPt(airport.lat, airport.lon, (activeRwyHdg+180)%360, g.nm)
        // 0.3nm half-width band perpendicular
        const left = destPt(pos[1], pos[0], (activeRwyHdg+90)%360, 0.3)
        const right = destPt(pos[1], pos[0], (activeRwyHdg-90+360)%360, 0.3)
        gateFC.features.push({ type:'Feature', geometry:{ type:'LineString', coordinates: [left, right] }, properties:{ color: g.color, label: showLabels ? `${g.alt}ft` : '' } })
      }
    }

    const acFC: any = { type:'FeatureCollection', features: [] as any[] }
    const projFC: any = { type:'FeatureCollection', features: [] as any[] }
    for (const s of solutions) {
      acFC.features.push({ type:'Feature', geometry:{ type:'Point', coordinates: [s.f.lng, s.f.lat] }, properties:{ color: TIER_COLOR[s.tier], rad: 6 + Math.min(14, s.index*5), label: showLabels ? `${s.f.callsign||s.f.icao} · ${TIER_LABEL[s.tier]}` : '' } })
      if (showProj) projFC.features.push({ type:'Feature', geometry:{ type:'LineString', coordinates: [[s.f.lng, s.f.lat], s.proj] }, properties:{ color: TIER_COLOR[s.tier] } })
    }

    const upsert = (id: string, data: any) => { if (m.getSource(id)) (m.getSource(id) as any).setData(data); else m.addSource(id, { type:'geojson', data }) }
    upsert(SRC_AP, apFC); upsert(SRC_CL, clFC); upsert(SRC_GATE, gateFC); upsert(SRC_AC, acFC); upsert(SRC_PROJ, projFC)

    if (!m.getLayer(LYR_AP)) m.addLayer({ id: LYR_AP, type:'circle', source: SRC_AP, paint:{ 'circle-radius':7, 'circle-color':'#a78bfa', 'circle-stroke-color':'#fff', 'circle-stroke-width':2, 'circle-opacity':0.95 } })
    if (!m.getLayer(LYR_AP_LBL)) m.addLayer({ id: LYR_AP_LBL, type:'symbol', source: SRC_AP, layout:{ 'text-field':['get','label'], 'text-size':12, 'text-offset':[0,-1.6], 'text-anchor':'bottom', 'text-allow-overlap':true }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0f172a', 'text-halo-width':1.6 } })
    if (!m.getLayer(LYR_CL)) m.addLayer({ id: LYR_CL, type:'line', source: SRC_CL, filter:['==',['geometry-type'],'LineString'], paint:{ 'line-color':'#0ea5e9', 'line-width':1.8, 'line-opacity':0.9, 'line-dasharray':[3,2] } })
    if (!m.getLayer(LYR_CL_PT)) m.addLayer({ id: LYR_CL_PT, type:'circle', source: SRC_CL, filter:['==',['geometry-type'],'Point'], paint:{ 'circle-radius':3, 'circle-color':'#0ea5e9', 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1 } })
    if (!m.getLayer(LYR_GATE)) m.addLayer({ id: LYR_GATE, type:'line', source: SRC_GATE, paint:{ 'line-color':['get','color'], 'line-width':4, 'line-opacity':0.85 } })
    if (!m.getLayer(LYR_GATE_LBL)) m.addLayer({ id: LYR_GATE_LBL, type:'symbol', source: SRC_GATE, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,-0.9], 'text-allow-overlap':true }, paint:{ 'text-color':'#cbd5e1', 'text-halo-color':'#0f172a', 'text-halo-width':1.4 } })
    if (!m.getLayer(LYR_PROJ)) m.addLayer({ id: LYR_PROJ, type:'line', source: SRC_PROJ, paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-opacity':0.7, 'line-dasharray':[2,2] } })
    if (!m.getLayer(LYR_AC)) m.addLayer({ id: LYR_AC, type:'circle', source: SRC_AC, paint:{ 'circle-radius':['get','rad'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.6 } })
    if (!m.getLayer(LYR_AC_LBL)) m.addLayer({ id: LYR_AC_LBL, type:'symbol', source: SRC_AC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-allow-overlap':true }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0f172a', 'text-halo-width':1.4 } })

    return () => remove()
  }, [map, showOverlay, showCenterline, showGates, showProj, showLabels, airport, activeRwyHdg, solutions, worst])

  // airport picker
  const pickerList = useMemo(() => {
    const q = pickerQ.trim().toLowerCase()
    let base = AIRPORTS
    if (q) base = base.filter(a => a.i.toLowerCase().includes(q) || a.a.toLowerCase().includes(q) || a.m.toLowerCase().includes(q) || a.n.toLowerCase().includes(q))
    return base.slice(0, 60)
  }, [pickerQ])

  // SVG profile diagram (distance x altitude AGL)
  const W = 380, H = 180
  const PAD = { l: 30, r: 8, t: 8, b: 22 }
  const maxDist = Math.max(15, rangeNm)
  const maxAlt = 4500
  const sx = (d: number) => PAD.l + (1 - d/maxDist) * (W - PAD.l - PAD.r)
  const sy = (a: number) => PAD.t + (1 - Math.min(1, a/maxAlt)) * (H - PAD.t - PAD.b)

  return (
    <div className="absolute top-16 right-3 z-40 w-[440px] max-w-[95vw] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-100 max-h-[82vh] overflow-y-auto">
      <div className="sticky top-0 bg-slate-950/95 backdrop-blur-xl px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">FSF ALAR gate scoring</div>
          <div className="text-sm font-semibold">Stable Approach Monitor</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* Airport picker */}
      <div className="px-4 py-3 border-b border-slate-900">
        <div className="flex items-center gap-2">
          <button onClick={()=>setPickerOpen(v=>!v)} className="flex-1 text-left bg-slate-900/60 border border-slate-800 hover:border-sky-500/40 rounded-lg px-3 py-2">
            <div className="text-[10px] uppercase tracking-widest text-slate-500">Airport · RWY {hdgToId(activeRwyHdg)} {manualRwy<0 && <span className="text-slate-600">(auto)</span>}</div>
            <div className="text-sm font-semibold">{airport.a} <span className="text-slate-500 font-mono text-xs">{airport.i}</span></div>
            <div className="text-[11px] text-slate-400 truncate">{airport.m}</div>
          </button>
          <button onClick={()=>{ setAirportI(''); setPickerOpen(false) }} title="Snap nearest" className="px-2 py-2 rounded-lg bg-slate-900/60 border border-slate-800 text-[10px] uppercase tracking-widest text-slate-300 hover:bg-slate-800/80">Near</button>
          <button onClick={()=>onFlyLatLng(airport.lat, airport.lon, 11)} title="Fit airport" className="px-2 py-2 rounded-lg bg-slate-900/60 border border-slate-800 text-[10px] uppercase tracking-widest text-slate-300 hover:bg-slate-800/80">Fit</button>
        </div>
        {pickerOpen && (
          <div className="mt-2 bg-slate-900/80 border border-slate-800 rounded-lg p-2">
            <input value={pickerQ} onChange={e=>setPickerQ(e.target.value)} placeholder="Search IATA / ICAO / city"
              className="w-full bg-slate-950/70 border border-slate-800 rounded px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 outline-none focus:border-sky-500/60" />
            <div className="max-h-44 overflow-y-auto mt-2 divide-y divide-slate-800/60">
              {pickerList.map(a => (
                <button key={a.i} onClick={()=>{ setAirportI(a.i); setPickerOpen(false); setPickerQ('') }} className="w-full text-left px-2 py-1.5 hover:bg-slate-800/60 rounded">
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

      {/* Tier counters */}
      <div className="px-4 pt-3 grid grid-cols-4 gap-1.5">
        {(['STABLE','ATTN','UNSTBL','GA'] as Tier[]).map(t => (
          <button key={t} onClick={()=>setFilterTier(filterTier===t ? null : t)}
            className={`px-2 py-1.5 rounded-lg border text-left transition ${filterTier===t ? 'bg-sky-500/15 border-sky-500/50' : 'bg-slate-900/50 border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[9px] uppercase tracking-widest" style={{color: TIER_COLOR[t]}}>{TIER_LABEL[t]}</div>
            <div className="text-base font-bold tabular-nums">{counts[t]}</div>
          </button>
        ))}
      </div>

      {/* Summary */}
      <div className="px-4 pt-3 grid grid-cols-3 gap-1.5">
        <div className="px-2 py-1.5 rounded-lg bg-slate-900/50 border border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Inbound</div>
          <div className="text-base font-bold font-mono tabular-nums">{solutions.length}</div>
        </div>
        <div className="px-2 py-1.5 rounded-lg bg-slate-900/50 border border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="text-base font-bold font-mono tabular-nums" style={{color: TIER_COLOR[worst]}}>{TIER_LABEL[worst]}</div>
        </div>
        <div className="px-2 py-1.5 rounded-lg bg-slate-900/50 border border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean idx</div>
          <div className="text-base font-bold font-mono tabular-nums">{meanIdx.toFixed(2)}</div>
        </div>
      </div>

      {/* Profile diagram */}
      <div className="px-4 pt-3">
        <div className="rounded-xl bg-slate-900/40 border border-slate-800 p-2">
          <svg width={W} height={H} className="block">
            {/* axes */}
            <line x1={PAD.l} y1={H-PAD.b} x2={W-PAD.r} y2={H-PAD.b} stroke="#1e293b" strokeWidth={1} />
            <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={H-PAD.b} stroke="#1e293b" strokeWidth={1} />
            {/* alt grid */}
            {[1000,2000,3000,4000].map(a => (
              <g key={a}>
                <line x1={PAD.l} y1={sy(a)} x2={W-PAD.r} y2={sy(a)} stroke="#1e293b" strokeWidth={0.5} strokeDasharray="2 3" />
                <text x={PAD.l-3} y={sy(a)} fill="#475569" fontSize={9} fontFamily="monospace" textAnchor="end" dominantBaseline="central">{a}</text>
              </g>
            ))}
            {/* dist grid */}
            {[5,10,15,20].filter(d=>d<=maxDist).map(d => (
              <g key={d}>
                <line x1={sx(d)} y1={PAD.t} x2={sx(d)} y2={H-PAD.b} stroke="#1e293b" strokeWidth={0.5} strokeDasharray="2 3" />
                <text x={sx(d)} y={H-PAD.b+10} fill="#475569" fontSize={9} fontFamily="monospace" textAnchor="middle">{d}nm</text>
              </g>
            ))}
            {/* 3deg glidepath reference */}
            <line x1={sx(maxDist)} y1={sy(maxDist*318)} x2={sx(0)} y2={sy(0)} stroke="#0ea5e9" strokeWidth={1.4} strokeOpacity={0.7} />
            {/* gate bands */}
            <rect x={sx(1000/318+0.3)} y={sy(1100)} width={Math.max(2,sx(1000/318-0.3)-sx(1000/318+0.3))} height={Math.max(2,sy(900)-sy(1100))} fill="#10b981" fillOpacity={0.14} />
            <rect x={sx(500/318+0.3)} y={sy(600)} width={Math.max(2,sx(500/318-0.3)-sx(500/318+0.3))} height={Math.max(2,sy(400)-sy(600))} fill="#fbbf24" fillOpacity={0.18} />
            <text x={sx(1000/318)} y={sy(1100)-3} fill="#10b981" fontSize={9} fontFamily="monospace" textAnchor="middle">1000ft gate</text>
            <text x={sx(500/318)} y={sy(600)-3} fill="#fbbf24" fontSize={9} fontFamily="monospace" textAnchor="middle">500ft</text>
            {/* aircraft dots */}
            {solutions.map(s => (
              <g key={s.f.icao}>
                <circle cx={sx(Math.min(maxDist, s.distNm))} cy={sy(Math.min(maxAlt, s.altAgl))} r={3} fill={TIER_COLOR[s.tier]} stroke="#0f172a" strokeWidth={0.8} />
              </g>
            ))}
            {/* axes labels */}
            <text x={W-PAD.r} y={H-4} fill="#64748b" fontSize={9} fontFamily="monospace" textAnchor="end">dist→TDZ</text>
            <text x={PAD.l+2} y={PAD.t+8} fill="#64748b" fontSize={9} fontFamily="monospace">alt AGL ft</text>
          </svg>
        </div>
      </div>

      {/* sliders */}
      <div className="px-4 pt-3 space-y-2">
        <label className="block">
          <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500"><span>Inbound range</span><span className="font-mono text-slate-300">{rangeNm} nm</span></div>
          <input type="range" min={10} max={60} step={1} value={rangeNm} onChange={e=>setRangeNm(+e.target.value)} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500"><span>Max FL ceiling</span><span className="font-mono text-slate-300">FL{maxFl}</span></div>
          <input type="range" min={30} max={250} step={5} value={maxFl} onChange={e=>setMaxFl(+e.target.value)} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500"><span>VRef offset</span><span className="font-mono text-slate-300">{vrefOffset>=0?'+':''}{vrefOffset} kt</span></div>
          <input type="range" min={-15} max={25} step={1} value={vrefOffset} onChange={e=>setVrefOffset(+e.target.value)} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-500"><span>Active runway</span><span className="font-mono text-slate-300">{manualRwy<0 ? 'AUTO' : `RWY ${hdgToId(manualRwy)}`}</span></div>
          <input type="range" min={-1} max={350} step={10} value={manualRwy} onDoubleClick={()=>setManualRwy(-1)} onChange={e=>setManualRwy(+e.target.value)} className="w-full accent-sky-500" />
        </label>
      </div>

      {/* toggles */}
      <div className="px-4 pt-3 flex flex-wrap gap-1.5">
        {[
          ['OVL', showOverlay, ()=>setShowOverlay(v=>!v)],
          ['CL',  showCenterline, ()=>setShowCenterline(v=>!v)],
          ['GATE', showGates, ()=>setShowGates(v=>!v)],
          ['PROJ', showProj, ()=>setShowProj(v=>!v)],
          ['LBL', showLabels, ()=>setShowLabels(v=>!v)],
        ].map(([l, on, fn]: any) => (
          <button key={l} onClick={fn} className={`px-2 py-1 rounded-md border text-[10px] uppercase tracking-widest transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:bg-slate-800/80'}`}>{l}</button>
        ))}
      </div>

      {/* search */}
      <div className="px-4 pt-3">
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Filter callsign / type / operator"
          className="w-full bg-slate-900/60 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 outline-none focus:border-sky-500/60" />
      </div>

      {/* list */}
      <div className="px-4 py-3">
        <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">Inbounds · {filtered.length}</div>
        <div className="space-y-1 max-h-[40vh] overflow-y-auto pr-1">
          {filtered.length === 0 && <div className="text-xs text-slate-500 px-2 py-3">No inbound aircraft match.</div>}
          {filtered.map(s => (
            <button key={s.f.icao} onClick={()=>onFly(s.f.icao)} className="w-full text-left rounded-lg bg-slate-900/40 border border-slate-800 overflow-hidden hover:border-slate-700 transition">
              <div className="flex items-stretch">
                <div style={{background: TIER_COLOR[s.tier], width: 3}} />
                <div className="flex-1 px-2 py-1.5">
                  <div className="flex items-baseline justify-between">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-sm font-bold text-slate-100">{s.f.callsign || s.f.icao}</span>
                      <span className="font-mono text-[10px] text-slate-500">{s.f.type || '—'}</span>
                      <span className="text-[9px] uppercase tracking-widest text-slate-500 px-1 rounded border border-slate-800">{s.cls}</span>
                      <span className="text-[9px] uppercase tracking-widest px-1.5 rounded" style={{color: TIER_COLOR[s.tier], background: TIER_COLOR[s.tier]+'22'}}>{TIER_LABEL[s.tier]}</span>
                    </div>
                    <span className="font-mono text-[10px] text-slate-500">idx {s.index.toFixed(2)}</span>
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-3 text-[11px] font-mono">
                    <span className="text-slate-400">{s.distNm.toFixed(1)}nm</span>
                    <span className="text-slate-400">AGL <span className="text-slate-200">{Math.round(s.altAgl)}</span></span>
                    <span className="text-slate-400">GS <span className="text-slate-200">{Math.round(s.f.velocityKts)}</span></span>
                    <span className="text-slate-400">VS <span className={s.f.vertRate<-1200?'text-rose-300':'text-slate-200'}>{Math.round(s.f.vertRate)}</span></span>
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-2 text-[10px] font-mono">
                    <span className={Math.abs(s.glideDeltaFt)>100 ? (s.glideDeltaFt>0 ? 'text-amber-300' : 'text-rose-300') : 'text-slate-500'}>Δalt {s.glideDeltaFt>=0?'+':''}{Math.round(s.glideDeltaFt)}ft</span>
                    <span className={Math.abs(s.xtkNm)>0.3 ? 'text-amber-300' : 'text-slate-500'}>XTK {s.xtkNm>=0?'R':'L'}{Math.abs(s.xtkNm).toFixed(2)}</span>
                    <span className={Math.abs(s.spdDeltaKt)>15 ? (s.spdDeltaKt>0 ? 'text-rose-300' : 'text-amber-300') : 'text-slate-500'}>Δspd {s.spdDeltaKt>=0?'+':''}{Math.round(s.spdDeltaKt)}</span>
                    <span className={s.trkDeltaDeg>10 ? 'text-amber-300' : 'text-slate-500'}>Δtrk {Math.round(s.trkDeltaDeg)}°</span>
                  </div>
                  {/* index bar */}
                  <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden relative">
                    <div className="h-full" style={{width: `${Math.min(100, s.index/2*100)}%`, background: TIER_COLOR[s.tier]}} />
                    <div className="absolute inset-y-0" style={{left: `${0.6/2*100}%`, width: 1, background: '#fbbf2466'}} />
                    <div className="absolute inset-y-0" style={{left: `${1.0/2*100}%`, width: 1, background: '#fb923c66'}} />
                    <div className="absolute inset-y-0" style={{left: `${1.6/2*100}%`, width: 1, background: '#f43f5e66'}} />
                  </div>
                  <div className="mt-1 flex items-baseline justify-between gap-2 text-[10px]">
                    <span className="text-slate-500 truncate">{s.reasons.slice(0,3).join(' · ')}</span>
                    <span className="font-mono text-slate-600 truncate">{s.f.operator || ''}</span>
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
