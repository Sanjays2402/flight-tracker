'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   FIR / ARTCC Crossings Monitor
   ------------------------------------------------------------
   Live Flight-Information-Region boundary tracker. Every
   airborne aircraft above MIN-FL is assigned to its current
   FIR by point-in-polygon scan over 36 encoded regions
   spanning the world's busiest controlled airspace volumes:
   continental US ARTCCs (KZNY, KZDC, KZJX, KZMA, KZAB, KZLA,
   KZOA, KZAU, KZID, KZME, KZTL, KZBW, KZHU, KZSE, KZMP,
   KZKC, KZDV), European FIRs (EGTT London, LFFF Paris,
   EDGG Langen, EDMM Munich, LECM Madrid, LIRR Rome, LSAS
   Switzerland, EHAA Amsterdam, EKDK Copenhagen, EFIN Finland),
   oceanic (EGGX Shanwick, CZQX Gander, KZWY New York Oceanic,
   KZAK Oakland Oceanic), Asia/Pacific (RJJJ Fukuoka, RKRR
   Incheon, ZBPE Beijing, ZGZU Guangzhou, ZSHA Shanghai, VIDF
   Delhi, VABF Mumbai, OMAE Emirates, OAKX Karachi).

   For each aircraft above MIN-FL the tool:
     1. Assigns CURRENT FIR via point-in-polygon (winner = first
        polygon containing point, with sortKey priority so dense
        FIRs win over big ones).
     2. Forward-projects ground vector at GS in 60-sec increments
        out to HORIZON min, finds the FIRST step lying in a
        DIFFERENT FIR than current → that step = predicted
        crossing point, ETA-min = step*1min, NEXT-FIR = its FIR.
     3. Classifies aircraft tier:
          IMMINENT  ETA<5min   rose
          NEAR      ETA<15min  amber
          SOON      ETA<HORIZON yellow
          STABLE    no crossing within horizon sky

   Per-FIR rollup:
     - aircraft count, mean FL, max FL, worst-tier
     - inbound count (next aircraft scheduled to enter this FIR)
     - outbound count (currently inside, ETA<HORIZON)
     - net flow = inbound - outbound (sky=balanced amber=influx
       rose=heavy influx or drain)
     - controller workload index W = 0.5*cnt/CAP + 0.3*xings/15
       + 0.2*meanFL/350 classified GREEN<0.5 / YELLOW<0.85
       / RED<1.20 / SAT≥1.20

   Map overlay:
     - Dashed sky FIR-boundary polygon outlines + 0.06 sky fill
     - Workload-tinted active-FIR halos
     - Tier-coloured aircraft halo rings sized by ETA proximity
     - Dashed tier-coloured projection line from aircraft to
       crossing waypoint with amber crossing marker
     - FIR-id + workload + count labels at centroid

   Side panel:
     - 4-tier counter strip click-to-filter
     - 3-cell ACTIVE-FIRS / FLEET-AIRBORNE / MEAN-WORKLOAD
     - SVG flow-matrix diagram (every FIR plotted as a coloured
       row, x-axis = elapsed-min 0..HORIZON, every aircraft is
       a dot at its (eta-min, FIR-row) coordinate)
     - 4 sliders (HORIZON 5-60min / MIN-FL 30-450 / STEP-SEC
       30-180sec / WORKLOAD-CAP 10-40 aircraft)
     - OVL/POLY/PROJ/LBL toggle row
     - callsign/type/operator/FIR-id search
     - AIRCRAFT tab sorted tier-worst-first then ETA asc with
       tier color stripe + callsign+type+tier-pill + FIR+FL+GS
       line + ETA + next-FIR + xing-lat/lng + workload-of-next
       progress bar, click-to-fly per row
     - FIRS tab sorted by workload desc with workload-tinted
       stripe + id+name + count+meanFL+xings + workload bar with
       green/yellow/red threshold ticks + inbound/outbound flow
       line, click-to-fly to centroid
   ============================================================ */

interface FiFlight {
  icao: string
  callsign: string
  type: string
  operator: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  ground: boolean
}
interface Props {
  map: maplibregl.Map | null
  flights: FiFlight[]
  onClose: () => void
  onFly: (icao: string) => void
  onFlyLatLng: (lat: number, lng: number, zoom?: number) => void
}

/* FIR record: rectangular bounds [minLat,minLng,maxLat,maxLng].
   Sort key: higher = checked first (dense regions win over oceanic
   wrappers). */
type Fir = { id: string; n: string; lat0: number; lon0: number; lat1: number; lon1: number; pr: number }
const FIRS: Fir[] = [
  // US ARTCCs
  { id:'KZNY', n:'New York',         lat0:39.0, lon0:-77.0, lat1:43.5, lon1:-71.5, pr:5 },
  { id:'KZBW', n:'Boston',           lat0:41.0, lon0:-74.0, lat1:47.5, lon1:-67.0, pr:5 },
  { id:'KZDC', n:'Washington',       lat0:35.0, lon0:-82.0, lat1:40.5, lon1:-74.0, pr:5 },
  { id:'KZJX', n:'Jacksonville',     lat0:29.5, lon0:-85.0, lat1:35.0, lon1:-77.0, pr:5 },
  { id:'KZMA', n:'Miami',            lat0:23.0, lon0:-85.0, lat1:29.5, lon1:-76.0, pr:5 },
  { id:'KZTL', n:'Atlanta',          lat0:30.0, lon0:-89.5, lat1:36.5, lon1:-81.0, pr:5 },
  { id:'KZHU', n:'Houston',          lat0:25.0, lon0:-99.0, lat1:32.5, lon1:-89.5, pr:5 },
  { id:'KZME', n:'Memphis',          lat0:33.0, lon0:-94.5, lat1:38.5, lon1:-86.0, pr:5 },
  { id:'KZID', n:'Indianapolis',     lat0:36.5, lon0:-89.0, lat1:42.0, lon1:-82.0, pr:5 },
  { id:'KZAU', n:'Chicago',          lat0:38.5, lon0:-92.0, lat1:46.0, lon1:-85.0, pr:5 },
  { id:'KZKC', n:'Kansas City',      lat0:35.5, lon0:-101.0, lat1:42.0, lon1:-92.0, pr:5 },
  { id:'KZMP', n:'Minneapolis',      lat0:42.0, lon0:-104.0, lat1:49.0, lon1:-89.5, pr:5 },
  { id:'KZDV', n:'Denver',           lat0:36.0, lon0:-112.0, lat1:45.0, lon1:-101.0, pr:5 },
  { id:'KZAB', n:'Albuquerque',      lat0:30.0, lon0:-110.0, lat1:36.0, lon1:-99.0, pr:5 },
  { id:'KZLA', n:'Los Angeles',      lat0:32.0, lon0:-120.5, lat1:37.5, lon1:-114.0, pr:5 },
  { id:'KZOA', n:'Oakland',          lat0:36.0, lon0:-125.0, lat1:43.0, lon1:-118.5, pr:5 },
  { id:'KZSE', n:'Seattle',          lat0:43.0, lon0:-125.0, lat1:49.0, lon1:-114.0, pr:5 },
  // Canada
  { id:'CZUL', n:'Montreal',         lat0:45.0, lon0:-79.0, lat1:55.0, lon1:-63.0, pr:4 },
  { id:'CZYZ', n:'Toronto',          lat0:43.0, lon0:-90.0, lat1:50.0, lon1:-79.0, pr:4 },
  { id:'CZVR', n:'Vancouver',        lat0:48.0, lon0:-140.0, lat1:60.0, lon1:-118.0, pr:4 },
  // Europe
  { id:'EGTT', n:'London',           lat0:49.0, lon0:-7.0, lat1:55.0, lon1:2.0, pr:5 },
  { id:'EGPX', n:'Scottish',         lat0:55.0, lon0:-9.0, lat1:61.0, lon1:2.0, pr:5 },
  { id:'EIDW', n:'Shannon',          lat0:51.0, lon0:-11.0, lat1:55.5, lon1:-5.5, pr:5 },
  { id:'LFFF', n:'Paris',            lat0:44.0, lon0:-2.0, lat1:51.0, lon1:6.5, pr:5 },
  { id:'EDGG', n:'Langen',           lat0:49.0, lon0:6.0, lat1:53.5, lon1:11.5, pr:5 },
  { id:'EDMM', n:'Munich',           lat0:47.0, lon0:9.0, lat1:50.5, lon1:13.5, pr:5 },
  { id:'EHAA', n:'Amsterdam',        lat0:51.0, lon0:2.5, lat1:54.0, lon1:7.5, pr:5 },
  { id:'EKDK', n:'Copenhagen',       lat0:54.0, lon0:8.0, lat1:58.0, lon1:15.5, pr:5 },
  { id:'LSAS', n:'Switzerland',      lat0:45.5, lon0:5.5, lat1:48.0, lon1:10.5, pr:5 },
  { id:'LIRR', n:'Roma',             lat0:36.0, lon0:6.0, lat1:46.5, lon1:18.5, pr:5 },
  { id:'LECM', n:'Madrid',           lat0:35.5, lon0:-10.0, lat1:44.0, lon1:4.0, pr:5 },
  { id:'EFIN', n:'Finland',          lat0:59.0, lon0:19.0, lat1:70.0, lon1:31.5, pr:4 },
  { id:'UUWV', n:'Moscow',           lat0:53.0, lon0:32.0, lat1:60.0, lon1:48.0, pr:4 },
  // Asia
  { id:'RJJJ', n:'Fukuoka',          lat0:24.0, lon0:122.0, lat1:46.0, lon1:153.0, pr:4 },
  { id:'RKRR', n:'Incheon',          lat0:32.0, lon0:124.0, lat1:39.5, lon1:132.0, pr:5 },
  { id:'ZBPE', n:'Beijing',          lat0:35.0, lon0:108.0, lat1:45.0, lon1:124.0, pr:5 },
  { id:'ZSHA', n:'Shanghai',         lat0:28.0, lon0:117.0, lat1:35.0, lon1:125.0, pr:5 },
  { id:'ZGZU', n:'Guangzhou',        lat0:18.0, lon0:108.0, lat1:28.0, lon1:117.0, pr:5 },
  { id:'VHHK', n:'Hong Kong',        lat0:18.0, lon0:111.0, lat1:23.5, lon1:118.0, pr:6 },
  { id:'VTBB', n:'Bangkok',          lat0:5.0,  lon0:97.0,  lat1:21.0, lon1:106.0, pr:4 },
  { id:'WSJC', n:'Singapore',        lat0:-2.0, lon0:103.0, lat1:5.0,  lon1:108.5, pr:6 },
  { id:'VIDF', n:'Delhi',            lat0:24.0, lon0:69.0,  lat1:34.0, lon1:82.5, pr:5 },
  { id:'VABF', n:'Mumbai',           lat0:8.0,  lon0:65.0,  lat1:24.0, lon1:78.0, pr:5 },
  { id:'VECF', n:'Kolkata',          lat0:8.0,  lon0:78.0,  lat1:24.0, lon1:95.0, pr:4 },
  { id:'OPLR', n:'Lahore',           lat0:28.0, lon0:69.0,  lat1:36.0, lon1:78.0, pr:4 },
  { id:'OAKX', n:'Karachi',          lat0:23.0, lon0:60.0,  lat1:32.0, lon1:69.0, pr:4 },
  { id:'OMAE', n:'Emirates',         lat0:22.0, lon0:51.5,  lat1:27.5, lon1:57.5, pr:5 },
  { id:'OERR', n:'Jeddah',           lat0:16.0, lon0:34.0,  lat1:29.0, lon1:50.0, pr:4 },
  // Oceanic (low priority — checked last)
  { id:'EGGX', n:'Shanwick',         lat0:48.0, lon0:-30.0, lat1:61.0, lon1:-10.0, pr:1 },
  { id:'CZQX', n:'Gander Oceanic',   lat0:42.0, lon0:-50.0, lat1:58.0, lon1:-30.0, pr:1 },
  { id:'KZWY', n:'New York Oceanic', lat0:27.0, lon0:-67.0, lat1:42.0, lon1:-40.0, pr:1 },
  { id:'KZAK', n:'Oakland Oceanic',  lat0:5.0,  lon0:-160.0, lat1:40.0, lon1:-130.0, pr:1 },
  // Southern Hemisphere
  { id:'YBBB', n:'Brisbane',         lat0:-30.0, lon0:138.0, lat1:-8.0, lon1:160.0, pr:4 },
  { id:'YMMM', n:'Melbourne',        lat0:-45.0, lon0:111.0, lat1:-26.0, lon1:154.0, pr:4 },
  { id:'NZZC', n:'Auckland',         lat0:-48.0, lon0:163.0, lat1:-30.0, lon1:179.0, pr:3 },
  { id:'SBBS', n:'Brasilia',         lat0:-30.0, lon0:-72.0, lat1:-5.0,  lon1:-40.0, pr:3 },
  { id:'SAEF', n:'Ezeiza',           lat0:-45.0, lon0:-72.0, lat1:-30.0, lon1:-53.0, pr:3 },
  { id:'FAJA', n:'Johannesburg',     lat0:-35.0, lon0:16.0,  lat1:-22.0, lon1:33.0, pr:3 },
  { id:'HEAA', n:'Cairo',            lat0:22.0,  lon0:24.0,  lat1:32.0,  lon1:38.0, pr:3 },
  { id:'HKNA', n:'Nairobi',          lat0:-5.0,  lon0:32.0,  lat1:6.0,   lon1:42.0, pr:3 },
]
const FIR_BY: Record<string, Fir> = Object.fromEntries(FIRS.map(f => [f.id, f]))
const FIR_SORTED = [...FIRS].sort((a,b) => b.pr - a.pr)

type Tier = 'IMM' | 'NEAR' | 'SOON' | 'STAB'
const TIER_COLOR: Record<Tier,string> = { IMM:'#f43f5e', NEAR:'#fbbf24', SOON:'#facc15', STAB:'#38bdf8' }
const TIER_ORDER: Tier[] = ['IMM','NEAR','SOON','STAB']
const TIER_LABEL: Record<Tier,string> = { IMM:'IMMINENT', NEAR:'NEAR', SOON:'SOON', STAB:'STABLE' }
type WlTier = 'GREEN' | 'YELLOW' | 'RED' | 'SAT'
const WL_COLOR: Record<WlTier,string> = { GREEN:'#10b981', YELLOW:'#fbbf24', RED:'#fb923c', SAT:'#f43f5e' }

const RAD = Math.PI/180, DEG = 180/Math.PI, R_NM = 3440.065
function destPt(lat:number, lng:number, brg:number, nm:number): [number,number] {
  const br = brg*RAD, d = nm/R_NM
  const φ1 = lat*RAD, λ1 = lng*RAD
  const φ2 = Math.asin(Math.sin(φ1)*Math.cos(d) + Math.cos(φ1)*Math.sin(d)*Math.cos(br))
  const λ2 = λ1 + Math.atan2(Math.sin(br)*Math.sin(d)*Math.cos(φ1), Math.cos(d)-Math.sin(φ1)*Math.sin(φ2))
  return [((λ2*DEG+540)%360)-180, φ2*DEG]
}
function firAt(lat:number, lng:number): Fir | null {
  for (const f of FIR_SORTED) {
    if (lat >= f.lat0 && lat <= f.lat1 && lng >= f.lon0 && lng <= f.lon1) return f
  }
  return null
}

const SRC_POLY='fc-poly', SRC_AC='fc-ac', SRC_PROJ='fc-proj', SRC_LBL='fc-lbl', SRC_XING='fc-xing'
const LYR_POLY_FILL='fc-poly-f', LYR_POLY_LINE='fc-poly-l', LYR_POLY_LBL='fc-poly-lbl'
const LYR_AC='fc-ac-l', LYR_PROJ='fc-proj-l', LYR_LBL='fc-lbl-l', LYR_XING='fc-xing-l'

interface Sol {
  f: FiFlight
  cur: Fir | null
  next: Fir | null
  etaMin: number | null
  xLat: number | null
  xLng: number | null
  tier: Tier
}

export default function FirCrossings({ map, flights, onClose, onFly, onFlyLatLng }: Props) {
  const [horizon, setHorizon] = useState(30)
  const [minFl, setMinFl] = useState(180)
  const [stepSec, setStepSec] = useState(60)
  const [cap, setCap] = useState(25)
  const [showOverlay, setShowOverlay] = useState(true)
  const [showPoly, setShowPoly] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [filterTier, setFilterTier] = useState<Tier | null>(null)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AC'|'FIRS'>('AC')

  // Solve all aircraft above MIN-FL
  const sols = useMemo<Sol[]>(() => {
    const out: Sol[] = []
    const stepHr = stepSec / 3600
    const maxSteps = Math.ceil(horizon * 60 / stepSec)
    for (const f of flights) {
      if (f.ground) continue
      if ((f.altitudeFt/100) < minFl) continue
      const cur = firAt(f.lat, f.lng)
      if (!cur) continue
      let next: Fir | null = null, etaMin: number | null = null, xLat: number | null = null, xLng: number | null = null
      const gs = Math.max(f.velocityKts, 60)
      for (let s = 1; s <= maxSteps; s++) {
        const nm = gs * stepHr * s
        const [lng, lat] = destPt(f.lat, f.lng, f.track, nm)
        const ff = firAt(lat, lng)
        if (!ff) continue
        if (ff.id !== cur.id) {
          next = ff; etaMin = s * (stepSec/60); xLat = lat; xLng = lng; break
        }
      }
      let tier: Tier = 'STAB'
      if (etaMin != null) {
        if (etaMin < 5) tier = 'IMM'
        else if (etaMin < 15) tier = 'NEAR'
        else tier = 'SOON'
      }
      out.push({ f, cur, next, etaMin, xLat, xLng, tier })
    }
    return out
  }, [flights, horizon, minFl, stepSec])

  // Per-FIR rollup
  const firStats = useMemo(() => {
    const m = new Map<string, { id:string; cnt:number; meanFl:number; maxFl:number; inb:number; outb:number; worst:Tier }>()
    for (const f of FIRS) m.set(f.id, { id:f.id, cnt:0, meanFl:0, maxFl:0, inb:0, outb:0, worst:'STAB' })
    for (const s of sols) {
      if (s.cur) {
        const r = m.get(s.cur.id)!
        r.cnt++; r.meanFl += s.f.altitudeFt/100; if (s.f.altitudeFt/100 > r.maxFl) r.maxFl = s.f.altitudeFt/100
        if (s.next) r.outb++
        if (TIER_ORDER.indexOf(s.tier) < TIER_ORDER.indexOf(r.worst)) r.worst = s.tier
      }
      if (s.next) {
        const r = m.get(s.next.id)!
        r.inb++
      }
    }
    const arr = Array.from(m.values()).map(r => {
      const meanFl = r.cnt ? r.meanFl/r.cnt : 0
      const xings = r.outb // outbound = scheduled crossings within horizon
      const w = 0.5*r.cnt/cap + 0.3*xings/15 + 0.2*meanFl/350
      let wTier: WlTier = 'GREEN'
      if (w >= 1.2) wTier = 'SAT'
      else if (w >= 0.85) wTier = 'RED'
      else if (w >= 0.5) wTier = 'YELLOW'
      return { ...r, meanFl, xings, w, wTier }
    })
    return arr
  }, [sols, cap])
  const firById = useMemo(() => Object.fromEntries(firStats.map(r => [r.id, r])), [firStats])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { IMM:0, NEAR:0, SOON:0, STAB:0 }
    for (const s of sols) c[s.tier]++
    return c
  }, [sols])
  const meanW = useMemo(() => {
    const occ = firStats.filter(r => r.cnt > 0)
    if (!occ.length) return 0
    return occ.reduce((s,r) => s+r.w, 0) / occ.length
  }, [firStats])
  const activeFirs = useMemo(() => firStats.filter(r => r.cnt > 0).length, [firStats])

  /* Map overlay sync */
  useEffect(() => {
    if (!map) return
    const m = map
    const ready = m.isStyleLoaded()
    const apply = () => {
      try {
        const polyFc = { type:'FeatureCollection', features: showOverlay && showPoly ? FIRS.map(f => {
          const r = firById[f.id]
          const wTier: WlTier = r ? r.wTier : 'GREEN'
          return {
            type:'Feature',
            properties: { id:f.id, w: r?.w || 0, wcol: WL_COLOR[wTier], cnt: r?.cnt || 0 },
            geometry: { type:'Polygon', coordinates: [[
              [f.lon0,f.lat0],[f.lon1,f.lat0],[f.lon1,f.lat1],[f.lon0,f.lat1],[f.lon0,f.lat0]
            ]] }
          }
        }) : [] } as any
        const acFc = { type:'FeatureCollection', features: showOverlay ? sols.filter(s => !filterTier || s.tier === filterTier).map(s => ({
          type:'Feature',
          properties: { tier: s.tier, col: TIER_COLOR[s.tier], r: s.tier==='IMM'?16:s.tier==='NEAR'?12:s.tier==='SOON'?9:7 },
          geometry: { type:'Point', coordinates: [s.f.lng, s.f.lat] }
        })) : [] } as any
        const projFc = { type:'FeatureCollection', features: showOverlay && showProj ? sols.filter(s => s.next && s.xLat != null && (!filterTier || s.tier === filterTier)).map(s => ({
          type:'Feature',
          properties: { col: TIER_COLOR[s.tier] },
          geometry: { type:'LineString', coordinates: [[s.f.lng, s.f.lat], [s.xLng!, s.xLat!]] }
        })) : [] } as any
        const xingFc = { type:'FeatureCollection', features: showOverlay && showProj ? sols.filter(s => s.xLat != null && (!filterTier || s.tier === filterTier)).map(s => ({
          type:'Feature', properties:{ col: TIER_COLOR[s.tier] },
          geometry:{ type:'Point', coordinates:[s.xLng!, s.xLat!] }
        })) : [] } as any
        const lblFc = { type:'FeatureCollection', features: showOverlay && showLabels ? firStats.filter(r => r.cnt > 0).map(r => {
          const f = FIR_BY[r.id]
          return { type:'Feature', properties:{ t:`${r.id} · ${r.cnt} · W${r.w.toFixed(2)}`, col: WL_COLOR[r.wTier] },
            geometry:{ type:'Point', coordinates:[(f.lon0+f.lon1)/2, (f.lat0+f.lat1)/2] } }
        }) : [] } as any

        for (const [sid, data] of [[SRC_POLY, polyFc],[SRC_AC, acFc],[SRC_PROJ, projFc],[SRC_XING, xingFc],[SRC_LBL, lblFc]] as const) {
          const s = m.getSource(sid) as any
          if (s) s.setData(data)
          else m.addSource(sid, { type:'geojson', data })
        }
        if (!m.getLayer(LYR_POLY_FILL)) m.addLayer({ id:LYR_POLY_FILL, source:SRC_POLY, type:'fill', paint:{ 'fill-color':['get','wcol'], 'fill-opacity':0.06 } })
        if (!m.getLayer(LYR_POLY_LINE)) m.addLayer({ id:LYR_POLY_LINE, source:SRC_POLY, type:'line', paint:{ 'line-color':['get','wcol'], 'line-width':1.2, 'line-dasharray':[2,2], 'line-opacity':0.55 } })
        if (!m.getLayer(LYR_PROJ)) m.addLayer({ id:LYR_PROJ, source:SRC_PROJ, type:'line', paint:{ 'line-color':['get','col'], 'line-width':1.3, 'line-dasharray':[1.5,1.5], 'line-opacity':0.7 } })
        if (!m.getLayer(LYR_XING)) m.addLayer({ id:LYR_XING, source:SRC_XING, type:'circle', paint:{ 'circle-radius':4, 'circle-color':['get','col'], 'circle-stroke-width':1, 'circle-stroke-color':'#fbbf24', 'circle-opacity':0.9 } })
        if (!m.getLayer(LYR_AC)) m.addLayer({ id:LYR_AC, source:SRC_AC, type:'circle', paint:{ 'circle-radius':['get','r'], 'circle-color':['get','col'], 'circle-opacity':0.18, 'circle-stroke-width':1.2, 'circle-stroke-color':['get','col'], 'circle-stroke-opacity':0.85 } })
        if (!m.getLayer(LYR_POLY_LBL)) m.addLayer({ id:LYR_POLY_LBL, source:SRC_LBL, type:'symbol',
          layout:{ 'text-field':['get','t'], 'text-size':10, 'text-font':['Noto Sans Bold'], 'text-allow-overlap':false },
          paint:{ 'text-color':['get','col'], 'text-halo-color':'#020617', 'text-halo-width':1.2 } })
      } catch {}
    }
    if (ready) apply(); else m.once('load', apply)
    return () => {
      try {
        for (const l of [LYR_POLY_LBL, LYR_AC, LYR_XING, LYR_PROJ, LYR_POLY_LINE, LYR_POLY_FILL]) if (m.getLayer(l)) m.removeLayer(l)
        for (const s of [SRC_POLY, SRC_AC, SRC_PROJ, SRC_XING, SRC_LBL]) if (m.getSource(s)) m.removeSource(s)
      } catch {}
    }
  }, [map, sols, firStats, firById, showOverlay, showPoly, showProj, showLabels, filterTier])

  // Filtered list for AIRCRAFT tab
  const acList = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = sols.slice()
    if (filterTier) list = list.filter(s => s.tier === filterTier)
    if (q) list = list.filter(s =>
      s.f.callsign.toLowerCase().includes(q) ||
      s.f.type.toLowerCase().includes(q) ||
      s.f.operator.toLowerCase().includes(q) ||
      (s.cur?.id||'').toLowerCase().includes(q) ||
      (s.next?.id||'').toLowerCase().includes(q))
    list.sort((a,b) => {
      const da = TIER_ORDER.indexOf(a.tier), db = TIER_ORDER.indexOf(b.tier)
      if (da !== db) return da - db
      return (a.etaMin ?? 9999) - (b.etaMin ?? 9999)
    })
    return list.slice(0, 200)
  }, [sols, filterTier, search])

  const firList = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = firStats.filter(r => r.cnt > 0 || r.inb > 0)
    if (q) list = list.filter(r => r.id.toLowerCase().includes(q) || FIR_BY[r.id].n.toLowerCase().includes(q))
    list.sort((a,b) => b.w - a.w)
    return list.slice(0, 80)
  }, [firStats, search])

  // SVG flow matrix
  const SVG_W = 380, SVG_H = 200
  const topFirs = useMemo(() => firStats.filter(r => r.cnt > 0).sort((a,b) => b.cnt - a.cnt).slice(0, 12), [firStats])
  const rowH = topFirs.length ? SVG_H / topFirs.length : 16

  return (
    <div className="absolute inset-y-0 right-0 z-40 w-[min(96vw,440px)] bg-slate-950/95 backdrop-blur-xl border-l border-slate-800 shadow-2xl flex flex-col">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">FIR / ARTCC</div>
          <div className="text-sm font-semibold text-slate-100">Crossings <span className="text-slate-500 font-normal">· {sols.length} airborne · {activeFirs} active FIRs</span></div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* Tier counters */}
      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-4 gap-1.5">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setFilterTier(filterTier === t ? null : t)}
            className={`px-2 py-1.5 rounded-lg border text-left transition ${filterTier === t ? 'border-sky-500/50 bg-sky-500/10' : 'border-slate-800 bg-slate-900/50 hover:border-slate-700'}`}>
            <div className="text-[9px] uppercase tracking-widest" style={{ color: TIER_COLOR[t] }}>{TIER_LABEL[t]}</div>
            <div className="text-base font-bold tabular-nums text-slate-100">{counts[t]}</div>
          </button>
        ))}
      </div>

      {/* Summary */}
      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-3 gap-2">
        <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-2">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Active FIRs</div>
          <div className="text-sm font-mono text-slate-100">{activeFirs}</div>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-2">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Tracked</div>
          <div className="text-sm font-mono text-slate-100">{sols.length}</div>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-2">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Workload</div>
          <div className="text-sm font-mono" style={{ color: meanW >= 1.2 ? WL_COLOR.SAT : meanW >= 0.85 ? WL_COLOR.RED : meanW >= 0.5 ? WL_COLOR.YELLOW : WL_COLOR.GREEN }}>{meanW.toFixed(2)}</div>
        </div>
      </div>

      {/* Flow matrix SVG */}
      <div className="px-4 py-2 border-b border-slate-900">
        <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Flow Matrix · top 12 FIRs · ETA min →</div>
        <svg width={SVG_W} height={SVG_H} className="block">
          <rect x={0} y={0} width={SVG_W} height={SVG_H} fill="#020617" stroke="#1e293b" />
          {[0, 0.25, 0.5, 0.75, 1].map(p => (
            <line key={p} x1={p*SVG_W} y1={0} x2={p*SVG_W} y2={SVG_H} stroke="#1e293b" strokeWidth={0.5} />
          ))}
          {[5/horizon, 15/horizon].map((p,i) => p <= 1 && (
            <line key={i} x1={p*SVG_W} y1={0} x2={p*SVG_W} y2={SVG_H} stroke={i===0?TIER_COLOR.IMM:TIER_COLOR.NEAR} strokeWidth={0.6} strokeDasharray="3,3" opacity={0.5} />
          ))}
          {topFirs.map((r, i) => (
            <g key={r.id} transform={`translate(0, ${i*rowH})`}>
              <rect x={0} y={0} width={SVG_W} height={rowH} fill={WL_COLOR[r.wTier]} opacity={0.06} />
              <line x1={0} y1={rowH} x2={SVG_W} y2={rowH} stroke="#0f172a" strokeWidth={0.5} />
              <text x={4} y={rowH/2+3} fontSize={9} fill={WL_COLOR[r.wTier]} fontFamily="monospace">{r.id}</text>
              <text x={42} y={rowH/2+3} fontSize={8} fill="#64748b" fontFamily="monospace">{r.cnt}</text>
            </g>
          ))}
          {sols.filter(s => s.next && s.etaMin != null).map((s, idx) => {
            const i = topFirs.findIndex(r => r.id === s.cur?.id)
            if (i < 0) return null
            const x = Math.min(SVG_W-2, (s.etaMin!/horizon) * SVG_W)
            const y = i*rowH + rowH/2
            return <circle key={`${s.f.icao}-${idx}`} cx={x} cy={y} r={2.2} fill={TIER_COLOR[s.tier]} opacity={0.85} />
          })}
        </svg>
      </div>

      {/* Sliders */}
      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-2 gap-2 text-[10px]">
        <label className="block">
          <span className="text-slate-500 uppercase tracking-widest">Horizon · {horizon}min</span>
          <input type="range" min={5} max={60} step={1} value={horizon} onChange={e => setHorizon(+e.target.value)} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <span className="text-slate-500 uppercase tracking-widest">Min FL · {minFl}</span>
          <input type="range" min={30} max={450} step={10} value={minFl} onChange={e => setMinFl(+e.target.value)} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <span className="text-slate-500 uppercase tracking-widest">Step · {stepSec}s</span>
          <input type="range" min={30} max={180} step={10} value={stepSec} onChange={e => setStepSec(+e.target.value)} className="w-full accent-sky-500" />
        </label>
        <label className="block">
          <span className="text-slate-500 uppercase tracking-widest">Cap · {cap}ac</span>
          <input type="range" min={10} max={40} step={1} value={cap} onChange={e => setCap(+e.target.value)} className="w-full accent-sky-500" />
        </label>
      </div>

      {/* Toggles */}
      <div className="px-4 py-2 border-b border-slate-900 flex flex-wrap gap-1.5">
        {([['OVL',showOverlay,setShowOverlay],['POLY',showPoly,setShowPoly],['PROJ',showProj,setShowProj],['LBL',showLabels,setShowLabels]] as const).map(([l,v,s]) => (
          <button key={l} onClick={() => s(!v)} className={`px-2 py-1 rounded-md text-[10px] tracking-wider border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400'}`}>{l}</button>
        ))}
      </div>

      {/* Tabs + search */}
      <div className="px-4 py-2 border-b border-slate-900 flex gap-2 items-center">
        <div className="flex gap-1">
          {(['AC','FIRS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} className={`px-2.5 py-1 rounded-md text-[10px] font-bold tracking-widest border ${tab===t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400'}`}>{t==='AC'?'AIRCRAFT':'FIRS'}</button>
          ))}
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder={tab==='AC' ? 'callsign / type / FIR' : 'FIR id / name'}
          className="flex-1 bg-slate-900/60 border border-slate-800 rounded-md px-2 py-1 text-[11px] text-slate-100 placeholder-slate-600 focus:outline-none focus:border-sky-700" />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'AC' ? (
          acList.length === 0 ? <div className="px-4 py-10 text-center text-[11px] text-slate-500">No aircraft match.</div> :
          acList.map(s => (
            <button key={s.f.icao} onClick={() => onFly(s.f.icao)} className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/50">
              <div className="flex gap-2">
                <div className="w-0.5 self-stretch rounded-full" style={{ background: TIER_COLOR[s.tier] }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="flex items-baseline gap-1.5 min-w-0">
                      <span className="font-mono text-xs text-slate-100 font-bold truncate">{s.f.callsign || s.f.icao.toUpperCase()}</span>
                      <span className="text-[10px] text-slate-500 truncate">{s.f.type}</span>
                    </div>
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ color: TIER_COLOR[s.tier], background: TIER_COLOR[s.tier]+'22' }}>{TIER_LABEL[s.tier]}</span>
                  </div>
                  <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                    <span className="text-sky-300">{s.cur?.id || '—'}</span>
                    {s.next && <> → <span className="text-amber-300">{s.next.id}</span></>}
                    <span className="text-slate-600 ml-2">FL{Math.round(s.f.altitudeFt/100)}</span>
                    <span className="text-slate-600 ml-1.5">{Math.round(s.f.velocityKts)}kt</span>
                    {s.etaMin != null && <span className="ml-1.5" style={{ color: TIER_COLOR[s.tier] }}>ETA {s.etaMin.toFixed(0)}min</span>}
                  </div>
                  {s.xLat != null && (
                    <div className="text-[9px] font-mono text-slate-500 mt-0.5">
                      xing {s.xLat.toFixed(2)}, {s.xLng!.toFixed(2)}
                      {s.next && firById[s.next.id] && <> · next-W <span style={{ color: WL_COLOR[firById[s.next.id].wTier] }}>{firById[s.next.id].w.toFixed(2)}</span></>}
                    </div>
                  )}
                  {s.next && firById[s.next.id] && (
                    <div className="h-1 mt-1 bg-slate-900 rounded-full overflow-hidden relative">
                      <div className="h-full" style={{ width: `${Math.min(100, firById[s.next.id].w/1.5*100)}%`, background: WL_COLOR[firById[s.next.id].wTier] }} />
                      <div className="absolute top-0 h-full w-px" style={{ left: `${0.5/1.5*100}%`, background:'#fbbf24' }} />
                      <div className="absolute top-0 h-full w-px" style={{ left: `${0.85/1.5*100}%`, background:'#fb923c' }} />
                      <div className="absolute top-0 h-full w-px" style={{ left: `${1.2/1.5*100}%`, background:'#f43f5e' }} />
                    </div>
                  )}
                </div>
              </div>
            </button>
          ))
        ) : (
          firList.length === 0 ? <div className="px-4 py-10 text-center text-[11px] text-slate-500">No active FIRs.</div> :
          firList.map(r => {
            const f = FIR_BY[r.id]
            const net = r.inb - r.outb
            return (
              <button key={r.id} onClick={() => onFlyLatLng((f.lat0+f.lat1)/2, (f.lon0+f.lon1)/2, 5)} className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/50">
                <div className="flex gap-2">
                  <div className="w-0.5 self-stretch rounded-full" style={{ background: WL_COLOR[r.wTier] }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="flex items-baseline gap-1.5 min-w-0">
                        <span className="font-mono text-xs text-slate-100 font-bold">{r.id}</span>
                        <span className="text-[10px] text-slate-400 truncate">{f.n}</span>
                      </div>
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ color: WL_COLOR[r.wTier], background: WL_COLOR[r.wTier]+'22' }}>{r.wTier}</span>
                    </div>
                    <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                      <span className="text-sky-300">{r.cnt}ac</span>
                      <span className="text-slate-600 ml-2">mean FL{r.meanFl.toFixed(0)}</span>
                      <span className="text-slate-600 ml-1.5">max FL{r.maxFl.toFixed(0)}</span>
                      <span className="text-slate-600 ml-1.5">xings {r.xings}</span>
                    </div>
                    <div className="text-[9px] font-mono text-slate-500 mt-0.5">
                      flow IN <span className="text-emerald-400">{r.inb}</span> · OUT <span className="text-rose-400">{r.outb}</span> · NET <span style={{ color: net>0?'#10b981':net<0?'#f43f5e':'#64748b' }}>{net>0?'+':''}{net}</span>
                    </div>
                    <div className="h-1 mt-1 bg-slate-900 rounded-full overflow-hidden relative">
                      <div className="h-full" style={{ width: `${Math.min(100, r.w/1.5*100)}%`, background: WL_COLOR[r.wTier] }} />
                      <div className="absolute top-0 h-full w-px" style={{ left: `${0.5/1.5*100}%`, background:'#fbbf24' }} />
                      <div className="absolute top-0 h-full w-px" style={{ left: `${0.85/1.5*100}%`, background:'#fb923c' }} />
                      <div className="absolute top-0 h-full w-px" style={{ left: `${1.2/1.5*100}%`, background:'#f43f5e' }} />
                    </div>
                  </div>
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
