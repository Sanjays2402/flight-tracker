'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Mountain Wave Detector
   -----------------------------------------------------------
   Lee waves and rotor turbulence form when a stable airmass
   flows perpendicular to a mountain ridge with sufficient
   wind speed. Severity scales with:
     - cross-ridge wind component (kt) at crest level
     - ridge crest height (terrain forcing)
     - tropospheric stability (proxy via lapse / FL gain)
     - downwind distance (waves propagate 5-15 wavelengths)

   Catalogues 28 well-known wave-generating ridges (Sierra,
   Rockies, Andes, Alps, Pyrenees, Atlas, Drakensberg,
   Southern Alps NZ, Greenland east coast, Caucasus, Hindu
   Kush, Tien Shan, Trans-Antarctic, Appalachians, Brooks,
   Cascades, Coastal BC, Scottish Highlands, Apennines,
   Carpathians, Urals, Norwegian Spine, etc.) each as a
   centroid + axis bearing + crest height + influence radius.

   Per ridge: aggregates upwind component from every airborne
   aircraft with reported wind within a tunable sample radius
   above a tunable floor FL, weights inversely by range, picks
   weighted mean wind FROM-bearing and speed; computes cross-
   ridge component = ws * |sin(windFrom - ridgeBearing)|.
   Wave intensity index = (crossKt/30) * (crestFt/8000) *
   stabilityFactor (slider 0.4-1.6), classified into 4 tiers
   SEVERE>=1.5 / STRONG>=1.0 / MODERATE>=0.5 / CALM.

   Per aircraft (within ridge influence radius downwind):
     - downwind distance dwNm = -bearingProj toward ridge
       (negative = downwind of crest)
     - wavelength lambda = 2*pi*U/N with N=0.012 Hz stability
       approx and U=cross-wind ms; lambda_nm ~ 1.94*U_kt/3 nm
       per wave (handy: lambda_nm = U_kt / 1.5)
     - lobe number = floor(dwNm / lambda_nm); odd lobes =
       updraft (lift), even = downdraft (sink); rotor zone
       within first 0.5 lambda has highest turbulence
     - tier per-aircraft inherits ridge tier upgraded one
       level when inside rotor zone (dwNm < lambda/2)

   MapLibre overlay:
     - tier-coloured ridge axis line (great-circle 2-point
       computed from centroid +/- 60nm along bearing)
     - dashed downwind "wave fan" polygon extending 8 lambdas
       downwind perpendicular to ridge axis
     - tier-coloured rotor zone polygon at base (first lambda)
     - per-aircraft halo + callsign + lobe# + sink/lift label
     - violet diamond at ridge centroid with name+crest

   Side panel:
     - 4-tier counter strip click-to-filter
     - 3-cell summary: SEVERE-AC / STRONG-AC / MEAN-CROSS-KT
     - SVG ridge profile: U-shaped lee wave sinusoid coloured
       by tier with aircraft dots plotted at (dwNm, FL)
     - sliders: SAMPLE-RNG 50-500nm / FL-FLOOR 50-450 /
       STABILITY 0.4-1.6 (lapse multiplier)
     - OVL/AXIS/FAN/ROTOR/LBL toggles
     - search box (callsign/type/operator/ridge name)
     - AIRCRAFT tab worst-tier-first then ascending dwNm
     - RIDGES tab worst-tier-first then descending cross-kt
     - click-to-fly per row
   ============================================================ */

export interface MwFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  windDir?: number   // FROM
  windKts?: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: MwFlight[]
  onClose: () => void
  onFly: (icao: string) => void
  onFlyLatLng: (lat: number, lng: number, zoom?: number) => void
}

type Tier = 'SEVERE' | 'STRONG' | 'MODERATE' | 'CALM'
const TIER_COLOR: Record<Tier, string> = {
  SEVERE:   '#f43f5e',
  STRONG:   '#f59e0b',
  MODERATE: '#eab308',
  CALM:     '#38bdf8',
}
const TIER_ORDER: Tier[] = ['SEVERE','STRONG','MODERATE','CALM']
const TIER_RANK: Record<Tier, number> = { SEVERE:0, STRONG:1, MODERATE:2, CALM:3 }

type Ridge = {
  id: string; name: string;
  lat: number; lng: number;     // centroid
  bearing: number;              // ridge axis bearing 0-180 deg
  crestFt: number;              // mean crest height
  radiusNm: number;             // influence half-width perpendicular
  lengthNm: number;             // along-axis length / 2
}
// axis bearing convention: 0=N-S spine, 90=E-W spine
const RIDGES: Ridge[] = [
  { id:'SIERRA',   name:'Sierra Nevada (CA)',     lat: 37.7,  lng:-119.0, bearing:155, crestFt:11000, radiusNm:60,  lengthNm:140 },
  { id:'CASCADE',  name:'Cascade Range',          lat: 45.5,  lng:-121.6, bearing:  0, crestFt: 9000, radiusNm:55,  lengthNm:200 },
  { id:'COASTBC',  name:'Coastal BC Range',       lat: 52.5,  lng:-126.0, bearing:155, crestFt: 9500, radiusNm:55,  lengthNm:180 },
  { id:'ROCKIES',  name:'Colorado Rockies',       lat: 39.6,  lng:-106.4, bearing:170, crestFt:12500, radiusNm:70,  lengthNm:220 },
  { id:'BIGHORN',  name:'Bighorn / Wind River',   lat: 43.5,  lng:-108.5, bearing:155, crestFt:11000, radiusNm:55,  lengthNm:120 },
  { id:'BROOKS',   name:'Brooks Range (AK)',      lat: 68.0,  lng:-150.0, bearing: 95, crestFt: 7500, radiusNm:70,  lengthNm:280 },
  { id:'APPS',     name:'Appalachian Spine',      lat: 38.0,  lng: -79.5, bearing: 35, crestFt: 4800, radiusNm:35,  lengthNm:300 },
  { id:'SMOKY',    name:'Great Smoky Mountains',  lat: 35.6,  lng: -83.5, bearing: 45, crestFt: 5800, radiusNm:30,  lengthNm:90 },
  { id:'ALPS',     name:'European Alps',          lat: 46.5,  lng:  9.5,  bearing: 70, crestFt:12000, radiusNm:75,  lengthNm:280 },
  { id:'PYRENEES', name:'Pyrenees',               lat: 42.7,  lng:  0.8,  bearing: 95, crestFt: 9000, radiusNm:45,  lengthNm:160 },
  { id:'APEN',     name:'Apennines',              lat: 43.5,  lng: 11.5,  bearing:135, crestFt: 5500, radiusNm:40,  lengthNm:280 },
  { id:'DINARIC',  name:'Dinaric Alps',           lat: 43.5,  lng: 17.5,  bearing:135, crestFt: 6000, radiusNm:40,  lengthNm:240 },
  { id:'CARPATH',  name:'Carpathians',            lat: 47.5,  lng: 24.5,  bearing:130, crestFt: 7000, radiusNm:50,  lengthNm:300 },
  { id:'SCOT',     name:'Scottish Highlands',     lat: 57.0,  lng: -4.5,  bearing: 40, crestFt: 3800, radiusNm:35,  lengthNm:140 },
  { id:'NORSPINE', name:'Norwegian Spine',        lat: 62.0,  lng:  9.0,  bearing: 30, crestFt: 6500, radiusNm:50,  lengthNm:350 },
  { id:'URALS',    name:'Ural Mountains',         lat: 60.0,  lng: 60.0,  bearing:  0, crestFt: 5500, radiusNm:55,  lengthNm:500 },
  { id:'CAUCASUS', name:'Caucasus Range',         lat: 43.0,  lng: 43.0,  bearing: 95, crestFt:13000, radiusNm:55,  lengthNm:280 },
  { id:'ZAGROS',   name:'Zagros Mountains',       lat: 33.0,  lng: 49.0,  bearing:135, crestFt: 9000, radiusNm:60,  lengthNm:400 },
  { id:'HINDUK',   name:'Hindu Kush',             lat: 36.5,  lng: 71.5,  bearing: 70, crestFt:14000, radiusNm:70,  lengthNm:260 },
  { id:'KARAKO',   name:'Karakoram / Pamir',      lat: 36.0,  lng: 76.0,  bearing: 95, crestFt:18000, radiusNm:75,  lengthNm:240 },
  { id:'HIMA',     name:'Himalaya Main',          lat: 28.5,  lng: 84.0,  bearing:110, crestFt:21000, radiusNm:85,  lengthNm:550 },
  { id:'TIENSH',   name:'Tien Shan',              lat: 42.5,  lng: 78.0,  bearing: 95, crestFt:14000, radiusNm:65,  lengthNm:400 },
  { id:'JAPNORTH', name:'Japan Northern Alps',    lat: 36.5,  lng:137.6,  bearing:  0, crestFt: 9500, radiusNm:40,  lengthNm:120 },
  { id:'ATLAS',    name:'Atlas Mountains',        lat: 32.0,  lng: -6.5,  bearing: 70, crestFt:11000, radiusNm:55,  lengthNm:340 },
  { id:'DRAKENS',  name:'Drakensberg',            lat:-29.5,  lng: 29.5,  bearing: 30, crestFt:10500, radiusNm:50,  lengthNm:280 },
  { id:'ETHIOP',   name:'Ethiopian Highlands',    lat: 10.0,  lng: 38.5,  bearing:  0, crestFt:11500, radiusNm:55,  lengthNm:340 },
  { id:'ANDESN',   name:'Northern Andes',         lat:  5.0,  lng:-75.0,  bearing:  0, crestFt:14500, radiusNm:55,  lengthNm:400 },
  { id:'ANDESC',   name:'Central Andes',          lat:-23.0,  lng:-67.5,  bearing:  0, crestFt:18000, radiusNm:60,  lengthNm:500 },
  { id:'ANDESS',   name:'Southern Andes',         lat:-42.0,  lng:-71.5,  bearing:  0, crestFt:10000, radiusNm:50,  lengthNm:550 },
  { id:'NZALPS',   name:'Southern Alps (NZ)',     lat:-43.5,  lng:170.5,  bearing: 35, crestFt:10000, radiusNm:45,  lengthNm:280 },
  { id:'GRNLAND',  name:'Greenland East Coast',   lat: 66.0,  lng:-37.0,  bearing: 20, crestFt:10000, radiusNm:55,  lengthNm:450 },
  { id:'ANTPEN',   name:'Antarctic Peninsula',    lat:-67.0,  lng:-66.0,  bearing: 15, crestFt: 7500, radiusNm:50,  lengthNm:450 },
]

const SRC_AXIS = 'mw-axis-src', LYR_AXIS = 'mw-axis-lyr'
const SRC_FAN  = 'mw-fan-src',  LYR_FAN  = 'mw-fan-lyr', LYR_FAN_LN = 'mw-fan-ln-lyr'
const SRC_ROT  = 'mw-rot-src',  LYR_ROT  = 'mw-rot-lyr'
const SRC_PIN  = 'mw-pin-src',  LYR_PIN  = 'mw-pin-lyr', LYR_PIN_LBL = 'mw-pin-lbl'
const SRC_HALO = 'mw-halo-src', LYR_HALO = 'mw-halo-lyr'
const SRC_LBL  = 'mw-lbl-src',  LYR_LBL  = 'mw-lbl-lyr'

function deg2rad(d:number){return d*Math.PI/180}
function rad2deg(r:number){return r*180/Math.PI}
function distNm(la1:number,lo1:number,la2:number,lo2:number){
  const R=3440.065
  const dLa=deg2rad(la2-la1), dLo=deg2rad(lo2-lo1)
  const a=Math.sin(dLa/2)**2+Math.cos(deg2rad(la1))*Math.cos(deg2rad(la2))*Math.sin(dLo/2)**2
  return 2*R*Math.asin(Math.min(1,Math.sqrt(a)))
}
function bearingDeg(la1:number,lo1:number,la2:number,lo2:number){
  const f1=deg2rad(la1), f2=deg2rad(la2), dl=deg2rad(lo2-lo1)
  const y=Math.sin(dl)*Math.cos(f2)
  const x=Math.cos(f1)*Math.sin(f2)-Math.sin(f1)*Math.cos(f2)*Math.cos(dl)
  return (rad2deg(Math.atan2(y,x))+360)%360
}
function projectLatLng(lat:number, lng:number, brg:number, nm:number): [number, number] {
  // small-distance flat projection (good for <500nm visualisation)
  const R = nm / 60
  const b = deg2rad(brg)
  const dLat = R * Math.cos(b)
  const dLng = R * Math.sin(b) / Math.max(0.1, Math.cos(deg2rad(lat)))
  return [lng + dLng, lat + dLat]
}

export default function MountainWave({ map, flights, onClose, onFly, onFlyLatLng }: Props) {
  const [sampleRng, setSampleRng] = useState<number>(200)
  const [flFloor, setFlFloor] = useState<number>(100)
  const [stability, setStability] = useState<number>(1.0)
  const [showOvl, setShowOvl] = useState(true)
  const [showAxis, setShowAxis] = useState(true)
  const [showFan, setShowFan] = useState(true)
  const [showRotor, setShowRotor] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [tab, setTab] = useState<'AIRCRAFT'|'RIDGES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [query, setQuery] = useState('')

  // ---- per-ridge wind aggregation ----
  type RidgeState = {
    r: Ridge
    windFrom: number | null
    windKts: number
    samples: number
    crossKt: number
    intensity: number
    tier: Tier
    lambdaNm: number
  }
  const ridgeStates = useMemo<RidgeState[]>(() => {
    const out: RidgeState[] = []
    for (const r of RIDGES) {
      let u = 0, v = 0, wsum = 0, n = 0
      for (const f of flights) {
        if (f.ground) continue
        if (!Number.isFinite(f.windDir) || !Number.isFinite(f.windKts)) continue
        if ((f.windKts as number) < 5) continue
        if (f.altitudeFt < flFloor * 100) continue
        const dN = distNm(f.lat, f.lng, r.lat, r.lng)
        if (dN > sampleRng) continue
        const w = 1 / (1 + dN / 60)
        const dirRad = deg2rad(f.windDir as number)
        // u/v in meteo from-vector (kt)
        u += -(f.windKts as number) * Math.sin(dirRad) * w
        v += -(f.windKts as number) * Math.cos(dirRad) * w
        wsum += w
        n++
      }
      if (wsum < 0.05 || n < 1) {
        out.push({ r, windFrom: null, windKts: 0, samples: n, crossKt: 0, intensity: 0, tier: 'CALM', lambdaNm: 0 })
        continue
      }
      u /= wsum; v /= wsum
      const ws = Math.sqrt(u*u + v*v)
      const toRad = Math.atan2(-u, -v) // toward
      const fromDeg = (rad2deg(toRad) + 180 + 360) % 360
      // cross-ridge component
      const delta = ((fromDeg - r.bearing + 540) % 180) - 90
      const crossKt = ws * Math.abs(Math.sin(deg2rad(delta + 90))) // |cos(perp angle)|; alt: ws*|sin(fromDeg-bearing)|
      // simpler: |sin(fromDeg - bearing)|
      const crossKtSimple = ws * Math.abs(Math.sin(deg2rad(fromDeg - r.bearing)))
      const cross = crossKtSimple
      const intensity = (cross / 30) * (r.crestFt / 8000) * stability
      let tier: Tier = 'CALM'
      if (intensity >= 1.5) tier = 'SEVERE'
      else if (intensity >= 1.0) tier = 'STRONG'
      else if (intensity >= 0.5) tier = 'MODERATE'
      const lambdaNm = Math.max(4, cross / 1.5) // ~U_kt/1.5
      out.push({ r, windFrom: fromDeg, windKts: ws, samples: n, crossKt: cross, intensity, tier, lambdaNm })
    }
    return out
  }, [flights, sampleRng, flFloor, stability])

  // ---- per-aircraft assignment ----
  type AcEval = {
    f: MwFlight
    ridge: RidgeState
    dwNm: number       // downwind distance (positive = downwind of crest)
    crossNm: number    // perpendicular offset from axis line (unsigned)
    lobe: number       // wave lobe number
    inRotor: boolean
    sinkLift: 'LIFT' | 'SINK' | 'NEUTRAL'
    tier: Tier
  }
  const acEvals = useMemo<AcEval[]>(() => {
    const out: AcEval[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (f.altitudeFt < flFloor * 100) continue
      // find best ridge: nearest by perpendicular distance and within downwind range
      let best: AcEval | null = null
      for (const rs of ridgeStates) {
        if (rs.windFrom == null) continue
        if (rs.tier === 'CALM') continue
        const dN = distNm(f.lat, f.lng, rs.r.lat, rs.r.lng)
        if (dN > rs.r.lengthNm + 8 * rs.lambdaNm) continue
        // along-axis vs perpendicular decomposition relative to ridge centroid
        const brgFromRidge = bearingDeg(rs.r.lat, rs.r.lng, f.lat, f.lng)
        const angAlong = (brgFromRidge - rs.r.bearing + 540) % 360 - 180 // -180..180
        const along = dN * Math.cos(deg2rad(angAlong))
        const perp = dN * Math.sin(deg2rad(angAlong))
        if (Math.abs(along) > rs.r.lengthNm) continue
        // downwind direction = wind toward direction projected perpendicular to ridge axis
        // wind toward = (windFrom+180)%360
        const windToward = (rs.windFrom + 180) % 360
        const perpRefDir = (rs.r.bearing + 90) % 360 // one perpendicular side
        // sign of downwind: dot of windToward unit vec with perpRefDir
        const downSign = Math.cos(deg2rad(windToward - perpRefDir)) >= 0 ? +1 : -1
        const dw = perp * downSign  // positive if aircraft is downwind of crest
        if (dw < -10) continue       // upwind side: no wave (negligible)
        if (dw > 8 * rs.lambdaNm) continue
        if (Math.abs(perp) > rs.r.radiusNm + 8 * rs.lambdaNm) continue
        const lobe = Math.floor(dw / Math.max(1, rs.lambdaNm))
        const inRotor = dw < rs.lambdaNm * 0.6
        // odd lobe = updraft (lift); even = sink. lobe 0 = rotor messy
        const sinkLift: 'LIFT' | 'SINK' | 'NEUTRAL' =
          lobe === 0 ? 'NEUTRAL' : (lobe % 2 === 1 ? 'LIFT' : 'SINK')
        let tier: Tier = rs.tier
        if (inRotor && tier !== 'SEVERE') {
          tier = (tier === 'STRONG' ? 'SEVERE' : tier === 'MODERATE' ? 'STRONG' : 'MODERATE')
        }
        const ev: AcEval = { f, ridge: rs, dwNm: dw, crossNm: Math.abs(perp), lobe, inRotor, sinkLift, tier }
        if (!best || TIER_RANK[ev.tier] < TIER_RANK[best.tier] || (ev.tier === best.tier && ev.dwNm < best.dwNm)) {
          best = ev
        }
      }
      if (best) out.push(best)
    }
    return out
  }, [flights, ridgeStates, flFloor])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { SEVERE: 0, STRONG: 0, MODERATE: 0, CALM: 0 }
    for (const a of acEvals) c[a.tier]++
    return c
  }, [acEvals])

  const meanCrossKt = useMemo(() => {
    const act = ridgeStates.filter(r => r.crossKt > 0)
    if (!act.length) return 0
    return act.reduce((s, r) => s + r.crossKt, 0) / act.length
  }, [ridgeStates])

  const rankedAc = useMemo(() => {
    const q = query.trim().toLowerCase()
    return acEvals
      .filter(a => tierFilter === 'ALL' || a.tier === tierFilter)
      .filter(a => !q || a.f.callsign?.toLowerCase().includes(q) || a.f.type?.toLowerCase().includes(q)
        || a.f.operator?.toLowerCase().includes(q) || a.f.icao.toLowerCase().includes(q)
        || a.ridge.r.name.toLowerCase().includes(q) || a.ridge.r.id.toLowerCase().includes(q))
      .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.dwNm - b.dwNm)
  }, [acEvals, tierFilter, query])

  const rankedRidges = useMemo(() => {
    const q = query.trim().toLowerCase()
    return ridgeStates
      .filter(r => tierFilter === 'ALL' || r.tier === tierFilter)
      .filter(r => !q || r.r.name.toLowerCase().includes(q) || r.r.id.toLowerCase().includes(q))
      .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.crossKt - a.crossKt)
  }, [ridgeStates, tierFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC_FAN)) map.addSource(SRC_FAN, { type:'geojson', data:{type:'FeatureCollection',features:[]} })
        if (!map.getLayer(LYR_FAN)) map.addLayer({
          id: LYR_FAN, type:'fill', source: SRC_FAN,
          paint: { 'fill-color':['get','color'], 'fill-opacity': 0.10 },
        })
        if (!map.getLayer(LYR_FAN_LN)) map.addLayer({
          id: LYR_FAN_LN, type:'line', source: SRC_FAN,
          paint: { 'line-color':['get','color'], 'line-width': 1.0, 'line-opacity':0.55, 'line-dasharray':[2,2] },
        })
        if (!map.getSource(SRC_ROT)) map.addSource(SRC_ROT, { type:'geojson', data:{type:'FeatureCollection',features:[]} })
        if (!map.getLayer(LYR_ROT)) map.addLayer({
          id: LYR_ROT, type:'fill', source: SRC_ROT,
          paint: { 'fill-color':['get','color'], 'fill-opacity': 0.22 },
        })
        if (!map.getSource(SRC_AXIS)) map.addSource(SRC_AXIS, { type:'geojson', data:{type:'FeatureCollection',features:[]} })
        if (!map.getLayer(LYR_AXIS)) map.addLayer({
          id: LYR_AXIS, type:'line', source: SRC_AXIS,
          paint: { 'line-color':['get','color'], 'line-width': 2.4, 'line-opacity': 0.85 },
        })
        if (!map.getSource(SRC_HALO)) map.addSource(SRC_HALO, { type:'geojson', data:{type:'FeatureCollection',features:[]} })
        if (!map.getLayer(LYR_HALO)) map.addLayer({
          id: LYR_HALO, type:'line', source: SRC_HALO,
          paint: { 'line-color':['get','color'], 'line-width': 1.6, 'line-opacity': 0.85 },
        })
        if (!map.getSource(SRC_PIN)) map.addSource(SRC_PIN, { type:'geojson', data:{type:'FeatureCollection',features:[]} })
        if (!map.getLayer(LYR_PIN)) map.addLayer({
          id: LYR_PIN, type:'circle', source: SRC_PIN,
          paint: { 'circle-radius': 5, 'circle-color': '#a78bfa', 'circle-stroke-color': '#0f172a', 'circle-stroke-width': 1.5 },
        })
        if (!map.getLayer(LYR_PIN_LBL)) map.addLayer({
          id: LYR_PIN_LBL, type:'symbol', source: SRC_PIN,
          layout: { 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.1], 'text-anchor':'top', 'text-allow-overlap':true },
          paint: { 'text-color':'#a78bfa', 'text-halo-color':'#0f172a', 'text-halo-width':1.2 },
        })
        if (!map.getSource(SRC_LBL)) map.addSource(SRC_LBL, { type:'geojson', data:{type:'FeatureCollection',features:[]} })
        if (!map.getLayer(LYR_LBL)) map.addLayer({
          id: LYR_LBL, type:'symbol', source: SRC_LBL,
          layout: { 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,-1.5], 'text-anchor':'bottom', 'text-allow-overlap':true },
          paint: { 'text-color':['get','color'], 'text-halo-color':'#000', 'text-halo-width':1.2 },
        })
      } catch {}
    }
    ensure()

    if (!showOvl) {
      try {
        for (const s of [SRC_AXIS, SRC_FAN, SRC_ROT, SRC_PIN, SRC_HALO, SRC_LBL]) {
          (map.getSource(s) as maplibregl.GeoJSONSource | undefined)?.setData({ type:'FeatureCollection', features: [] })
        }
      } catch {}
      return
    }

    const axisFeats: any[] = []
    const fanFeats: any[] = []
    const rotFeats: any[] = []
    const pinFeats: any[] = []
    for (const rs of ridgeStates) {
      const color = TIER_COLOR[rs.tier]
      // axis line: centroid +/- lengthNm along bearing
      if (showAxis) {
        const a = projectLatLng(rs.r.lat, rs.r.lng, rs.r.bearing, rs.r.lengthNm)
        const b = projectLatLng(rs.r.lat, rs.r.lng, (rs.r.bearing + 180) % 360, rs.r.lengthNm)
        axisFeats.push({
          type:'Feature',
          geometry:{ type:'LineString', coordinates:[ a, b ] },
          properties:{ color },
        })
      }
      // downwind fan polygon
      if (showFan && rs.windFrom != null && rs.tier !== 'CALM') {
        const perpRefDir = (rs.r.bearing + 90) % 360
        const windToward = (rs.windFrom + 180) % 360
        const downSign = Math.cos(deg2rad(windToward - perpRefDir)) >= 0 ? +1 : -1
        const downDir = downSign > 0 ? perpRefDir : (perpRefDir + 180) % 360
        const fanLen = Math.min(400, 8 * rs.lambdaNm)
        const halfL = rs.r.lengthNm
        // corners: ridge axis +/- halfL, then translated downwind by fanLen
        const c1 = projectLatLng(rs.r.lat, rs.r.lng, rs.r.bearing, halfL)
        const c2 = projectLatLng(rs.r.lat, rs.r.lng, (rs.r.bearing + 180) % 360, halfL)
        // shift c1,c2 downwind
        const c3 = projectLatLng(c2[1], c2[0], downDir, fanLen)
        const c4 = projectLatLng(c1[1], c1[0], downDir, fanLen)
        fanFeats.push({
          type:'Feature',
          geometry:{ type:'Polygon', coordinates:[[ c1, c2, c3, c4, c1 ]] },
          properties:{ color },
        })
        if (showRotor) {
          const rotLen = Math.min(80, rs.lambdaNm * 0.6)
          const r3 = projectLatLng(c2[1], c2[0], downDir, rotLen)
          const r4 = projectLatLng(c1[1], c1[0], downDir, rotLen)
          rotFeats.push({
            type:'Feature',
            geometry:{ type:'Polygon', coordinates:[[ c1, c2, r3, r4, c1 ]] },
            properties:{ color },
          })
        }
      }
      pinFeats.push({
        type:'Feature',
        geometry:{ type:'Point', coordinates:[ rs.r.lng, rs.r.lat ] },
        properties:{ label: showLabels ? `${rs.r.id} \u25C6 ${Math.round(rs.r.crestFt/1000)}k` : rs.r.id },
      })
    }

    const haloFeats: any[] = []
    const lblFeats: any[] = []
    for (const a of acEvals) {
      const color = TIER_COLOR[a.tier]
      // small ring around aircraft
      const ring: [number, number][] = []
      const ringNm = 4 + (a.tier === 'SEVERE' ? 6 : a.tier === 'STRONG' ? 3 : 1)
      for (let i = 0; i <= 24; i++) {
        const ang = (i / 24) * 360
        ring.push(projectLatLng(a.f.lat, a.f.lng, ang, ringNm))
      }
      haloFeats.push({
        type:'Feature',
        geometry:{ type:'LineString', coordinates: ring },
        properties:{ color },
      })
      if (showLabels) {
        const tag = a.inRotor ? 'ROTOR' : (a.sinkLift === 'LIFT' ? `\u2191L${a.lobe}` : a.sinkLift === 'SINK' ? `\u2193L${a.lobe}` : `L${a.lobe}`)
        lblFeats.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[ a.f.lng, a.f.lat ] },
          properties:{ color, label: `${a.f.callsign?.trim() || a.f.icao} ${a.ridge.r.id} ${tag}` },
        })
      }
    }

    try {
      ;(map.getSource(SRC_AXIS) as maplibregl.GeoJSONSource | undefined)?.setData({ type:'FeatureCollection', features: axisFeats })
      ;(map.getSource(SRC_FAN)  as maplibregl.GeoJSONSource | undefined)?.setData({ type:'FeatureCollection', features: fanFeats })
      ;(map.getSource(SRC_ROT)  as maplibregl.GeoJSONSource | undefined)?.setData({ type:'FeatureCollection', features: rotFeats })
      ;(map.getSource(SRC_PIN)  as maplibregl.GeoJSONSource | undefined)?.setData({ type:'FeatureCollection', features: pinFeats })
      ;(map.getSource(SRC_HALO) as maplibregl.GeoJSONSource | undefined)?.setData({ type:'FeatureCollection', features: haloFeats })
      ;(map.getSource(SRC_LBL)  as maplibregl.GeoJSONSource | undefined)?.setData({ type:'FeatureCollection', features: lblFeats })
    } catch {}
  }, [map, ridgeStates, acEvals, showOvl, showAxis, showFan, showRotor, showLabels])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_LBL, LYR_HALO, LYR_PIN_LBL, LYR_PIN, LYR_ROT, LYR_FAN_LN, LYR_FAN, LYR_AXIS]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_LBL, SRC_HALO, SRC_PIN, SRC_ROT, SRC_FAN, SRC_AXIS]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  // ---- SVG wave profile ----
  const diag = useMemo(() => {
    const W = 380, H = 110, pad = 6
    const maxDw = Math.max(40, ...acEvals.map(a => a.dwNm), ...ridgeStates.map(r => r.lambdaNm * 6))
    const wavelen = ridgeStates.length ? Math.max(8, ridgeStates.reduce((s, r) => s + r.lambdaNm, 0) / Math.max(1, ridgeStates.filter(r => r.tier !== 'CALM').length)) : 25
    const xFor = (dw: number) => pad + (dw / maxDw) * (W - 2 * pad)
    const yFor = (alt: number) => H - pad - (alt / 50000) * (H - 2 * pad)
    // sinusoid path 0..maxDw
    const segs: string[] = []
    for (let x = 0; x <= maxDw; x += 2) {
      const yWave = 0.5 + 0.5 * Math.sin((x / wavelen) * 2 * Math.PI)
      const altKt = 30000 + yWave * 6000 // wave amplitude visualisation
      const px = xFor(x)
      const py = yFor(altKt)
      segs.push(`${segs.length === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`)
    }
    return { W, H, pad, path: segs.join(' '), xFor, yFor, maxDw, wavelen }
  }, [acEvals, ridgeStates])

  return (
    <div className="fixed top-16 right-3 z-40 w-[420px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">&#9650;</span>
          <span className="text-sm font-semibold tracking-wide">MOUNTAIN WAVE</span>
          <span className="text-[10px] text-slate-500">lee wave / rotor turbulence</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">&times;</button>
      </div>

      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/40 bg-sky-500/15' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }} title={t}>
            <span className="text-[9px] tracking-wider">{t}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="px-3 py-2 grid grid-cols-3 gap-1 border-b border-slate-800">
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">SEVERE A/C</span>
          <span className="text-sm font-mono" style={{ color: counts.SEVERE ? TIER_COLOR.SEVERE : '#cbd5e1' }}>{counts.SEVERE}</span>
        </div>
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">STRONG A/C</span>
          <span className="text-sm font-mono" style={{ color: counts.STRONG ? TIER_COLOR.STRONG : '#cbd5e1' }}>{counts.STRONG}</span>
        </div>
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">MEAN CROSS</span>
          <span className="text-sm font-mono text-slate-100">{meanCrossKt.toFixed(0)}kt</span>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider mb-1">
          <span>LEE WAVE PROFILE</span>
          <span className="font-mono">&lambda; {diag.wavelen.toFixed(0)}nm</span>
        </div>
        <svg viewBox={`0 0 ${diag.W} ${diag.H}`} className="w-full bg-slate-900/50 rounded">
          {/* axis */}
          <line x1={diag.pad} x2={diag.W - diag.pad} y1={diag.H - diag.pad} y2={diag.H - diag.pad} stroke="#334155" strokeWidth={0.5} />
          {/* crest pyramid */}
          <polygon points={`${diag.pad},${diag.H - diag.pad} ${diag.pad + 20},${diag.H - diag.pad - 40} ${diag.pad + 40},${diag.H - diag.pad}`} fill="#1e293b" stroke="#475569" strokeWidth={0.6} />
          {/* wave sinusoid */}
          <path d={diag.path} fill="none" stroke="#38bdf8" strokeWidth={1.2} opacity={0.75} />
          {/* aircraft dots */}
          {acEvals.slice(0, 80).map((a, i) => (
            <circle key={i} cx={diag.xFor(Math.max(0, a.dwNm))} cy={diag.yFor(a.f.altitudeFt)} r={2.2} fill={TIER_COLOR[a.tier]} stroke="#0f172a" strokeWidth={0.4} />
          ))}
          {/* legend */}
          <text x={diag.W - diag.pad} y={10} textAnchor="end" fill="#64748b" fontSize={8}>{'downwind \u2192'}</text>
        </svg>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>SAMPLE RANGE</span><span className="font-mono text-slate-300">{sampleRng}nm</span>
          </div>
          <input type="range" min={50} max={500} step={10} value={sampleRng} onChange={e => setSampleRng(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>FL FLOOR</span><span className="font-mono text-slate-300">FL{flFloor}</span>
          </div>
          <input type="range" min={50} max={450} step={10} value={flFloor} onChange={e => setFlFloor(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>STABILITY (N)</span><span className="font-mono text-slate-300">{stability.toFixed(2)}x</span>
          </div>
          <input type="range" min={0.4} max={1.6} step={0.05} value={stability} onChange={e => setStability(parseFloat(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showOvl}    onChange={e => setShowOvl(e.target.checked)}    className="accent-sky-500" /><span>OVL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showAxis}   onChange={e => setShowAxis(e.target.checked)}   className="accent-sky-500" /><span>AXIS</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showFan}    onChange={e => setShowFan(e.target.checked)}    className="accent-sky-500" /><span>FAN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRotor}  onChange={e => setShowRotor(e.target.checked)}  className="accent-sky-500" /><span>ROTOR</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / ridge"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/40 outline-none" />
        <div className="flex items-center gap-1">
          {(['AIRCRAFT', 'RIDGES'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 text-[10px] tracking-wider px-2 py-1 rounded border ${tab === t ? 'border-sky-500/40 bg-sky-500/15 text-slate-100' : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:text-slate-200'}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <>
            {rankedAc.length === 0 && <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft in lee-wave zones.</div>}
            {rankedAc.map((a, i) => (
              <button key={`${a.f.icao}-${a.ridge.r.id}-${i}`} onClick={() => onFly(a.f.icao)}
                className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
                <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.tier] }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono font-semibold truncate text-slate-100">{a.f.callsign?.trim() || a.f.icao}</span>
                    <span className="text-slate-500 truncate">{a.f.type || '\u2014'}</span>
                    <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded border" style={{ color: TIER_COLOR[a.tier], borderColor: TIER_COLOR[a.tier] + '66' }}>{a.tier}</span>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                    <span className="text-sky-300">{a.ridge.r.id}</span>
                    <span>FL{Math.round(a.f.altitudeFt / 100)}</span>
                    <span>dw {a.dwNm.toFixed(0)}nm</span>
                    <span>x{a.crossNm.toFixed(0)}</span>
                    <span className="ml-auto" style={{ color: a.inRotor ? TIER_COLOR.SEVERE : (a.sinkLift === 'LIFT' ? '#10b981' : a.sinkLift === 'SINK' ? '#f59e0b' : '#94a3b8') }}>
                      {a.inRotor ? 'ROTOR' : `${a.sinkLift} L${a.lobe}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] mt-0.5">
                    <div className="flex-1 h-1.5 bg-slate-900 rounded overflow-hidden relative">
                      {/* position within 8 lambdas downwind, with rotor zone marked rose at start */}
                      {(() => {
                        const span = 8 * Math.max(1, a.ridge.lambdaNm)
                        const pct = Math.max(0, Math.min(1, a.dwNm / span))
                        return (
                          <>
                            <div className="absolute inset-y-0 left-0" style={{ width: `${(0.6 / 8) * 100}%`, background: TIER_COLOR.SEVERE, opacity: 0.35 }} />
                            <div className="absolute inset-y-0" style={{ left: `${pct * 100}%`, width: 2, background: TIER_COLOR[a.tier] }} />
                          </>
                        )
                      })()}
                    </div>
                    <span className="font-mono text-slate-500">&lambda;{a.ridge.lambdaNm.toFixed(0)}</span>
                  </div>
                  <div className="text-[10px] text-slate-600 truncate mt-0.5">{a.f.operator || '\u2014'} &middot; {a.ridge.r.name} cross {a.ridge.crossKt.toFixed(0)}kt &middot; wind {a.ridge.windFrom?.toFixed(0)}{'\u00B0'}/{a.ridge.windKts.toFixed(0)}kt</div>
                </div>
              </button>
            ))}
          </>
        )}
        {tab === 'RIDGES' && (
          <>
            {rankedRidges.length === 0 && <div className="px-3 py-6 text-center text-xs text-slate-500">No ridges match filter.</div>}
            {rankedRidges.map(rs => (
              <button key={rs.r.id} onClick={() => onFlyLatLng(rs.r.lat, rs.r.lng, 6)}
                className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
                <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[rs.tier] }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono font-semibold text-sky-300">{rs.r.id}</span>
                    <span className="text-slate-300 truncate">{rs.r.name}</span>
                    <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded border" style={{ color: TIER_COLOR[rs.tier], borderColor: TIER_COLOR[rs.tier] + '66' }}>{rs.tier}</span>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                    <span>crest {Math.round(rs.r.crestFt / 1000)}k</span>
                    <span>brg {rs.r.bearing}{'\u00B0'}</span>
                    <span>cross {rs.crossKt.toFixed(0)}kt</span>
                    <span>&lambda;{rs.lambdaNm.toFixed(0)}nm</span>
                    <span className="ml-auto">N{rs.samples}</span>
                  </div>
                  <div className="text-[10px] text-slate-600 truncate mt-0.5">
                    wind {rs.windFrom == null ? '\u2014' : `${rs.windFrom.toFixed(0)}\u00B0/${rs.windKts.toFixed(0)}kt`} &middot; index {rs.intensity.toFixed(2)}
                  </div>
                </div>
              </button>
            ))}
          </>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 tracking-wider flex justify-between">
        <span>SEVERE&ge;1.5 &middot; STRONG&ge;1.0 &middot; MOD&ge;0.5 &middot; rotor=lobe0</span>
        <span>{RIDGES.length} RIDGES</span>
      </div>
    </div>
  )
}
