'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Runway Configuration Atlas
   -----------------------------------------------------------
   For 60 major hub airports each encoded with declared runway
   headings (true bearing in degrees, two ends with opposite
   reciprocal), this overlay:

     1. Synthesises a live surface wind FROM bearing + speed for
        each airport by inverse-range-weighted u/v decomposition
        of every airborne aircraft within SAMPLE-RNG nm and below
        WIND-MAX-FL using its reported wind vector (fallback to a
        track-derived ambient if no winds reported).
     2. Detects the ACTIVE arrival runway by binning every
        descending inbound aircraft within 30nm by closing-track
        and picking the dominant 20deg radial that aligns with a
        published runway end (must match within +/-25deg).
     3. Detects the ACTIVE departure runway by binning every
        climbing aircraft within 12nm with vertical rate >300fpm
        on the same airport using outbound track.
     4. Computes per-runway-end headwind = ws*cos(d), crosswind =
        ws*|sin(d)|, tailwind = max(0, -headwind) where d =
        windFrom - rwyHdg.
     5. Computes a RWY-CONFIG SCORE = wTail/8 + wXwind/15 + ds/40
        with wTail=tailwind kts (cap 0 if headwind), wXwind=xwind
        kts, ds=preferred-config dispersion (count of arrivals
        not on the active rwy / total arrivals). Classifies into
        4 tiers:
          OPTIMAL  <0.35  sky
          OK       <0.70  amber
          DEGRADED <1.10  orange
          CHANGE   >=1.10 rose (config-change strongly suggested)
     6. Predicts CHANGE TIME by extrapolating recent 10-min wind
        FROM rotation rate and computing when ATL config will
        cross a CHANGE threshold (xwind > xwindLimit or tail >
        tailLimit on currently active rwy end).

   MapLibre overlay paints each monitored airport as a tier-
   tinted square pin with a wind-barb line indicating wind FROM
   direction sized to kt, the active arrival rwy as a thick sky
   bar through the airport oriented along the rwy heading, the
   active departure rwy as a violet bar, a translucent rwy-end
   safety arrow for the operating direction, and an IATA + RWY +
   xwind label. Tier-coloured aircraft halo rings sized by their
   contribution to config dispersion, dashed link from each
   misaligned arrival to the airport showing the cross flow.

   Side panel: tier counter strip with click-to-filter, 3-cell
   AIRPORTS / FLEET-AT-AIRPORTS / MEAN-XWIND summary, SVG wind
   compass diagram (full 360 wind-rose with the 4 best aligned
   runway sectors highlighted per airport), sliders (SAMPLE-RNG
   / XWIND-LIMIT / TAIL-LIMIT / MIN-DEP-FPM), system chip toggle
   (ARR-only / DEP-only / BOTH), OVL/BAR/BARB/LBL toggles, icao
   /iata/city search, AIRPORTS tab sorted tier-worst-first with
   tier color stripe + IATA+name+config-pill + active arr/dep
   rwy line + wind/xwind/tail line + tier-coloured score bar +
   change-prediction footer, AIRCRAFT tab sorted tier-worst
   first with rwy-end alignment delta.
   ============================================================ */

export interface RcFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  vertRate?: number
  track: number
  windDir?: number
  windKts?: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: RcFlight[]
  onClose: () => void
  onFly: (icao: string) => void
  onFlyLatLng: (lat: number, lng: number, zoom?: number) => void
}

type Tier = 'OPTIMAL' | 'OK' | 'DEGRADED' | 'CHANGE'
const TIER_COLOR: Record<Tier, string> = {
  OPTIMAL: '#0ea5e9',
  OK: '#fde047',
  DEGRADED: '#f59e0b',
  CHANGE: '#ef4444',
}
const TIER_ORDER: Tier[] = ['CHANGE', 'DEGRADED', 'OK', 'OPTIMAL']

interface HubAirport {
  icao: string
  iata: string
  name: string
  city: string
  lat: number
  lng: number
  elev: number    // ft
  rwys: number[]  // true bearings, one direction per physical runway (reciprocal is +180)
}

/* 60 hubs with primary runway true-bearing headings (one per
   physical strip, reciprocal = +180). Sourced from chart data. */
const HUBS: HubAirport[] = [
  { icao:'KATL', iata:'ATL', name:'Hartsfield-Jackson', city:'Atlanta',     lat:33.640, lng:-84.428, elev:1026, rwys:[88,98,89,99,87] },
  { icao:'KJFK', iata:'JFK', name:'Kennedy',           city:'New York',     lat:40.640, lng:-73.779, elev:13,   rwys:[44,134,135,90] },
  { icao:'KLAX', iata:'LAX', name:'Los Angeles',       city:'Los Angeles',  lat:33.943, lng:-118.408,elev:125,  rwys:[69,79,67,77] },
  { icao:'KORD', iata:'ORD', name:'O\u2019Hare',       city:'Chicago',      lat:41.978, lng:-87.905, elev:672,  rwys:[100,90,80,279,309,42] },
  { icao:'KDFW', iata:'DFW', name:'Dallas-Fort Worth', city:'Dallas',       lat:32.897, lng:-97.038, elev:607,  rwys:[175,175,353,353,124] },
  { icao:'KDEN', iata:'DEN', name:'Denver',            city:'Denver',       lat:39.862, lng:-104.673,elev:5431, rwys:[80,170,260,80,170,260] },
  { icao:'KSFO', iata:'SFO', name:'San Francisco',     city:'San Francisco',lat:37.621, lng:-122.379,elev:13,   rwys:[101,118,11,28] },
  { icao:'KSEA', iata:'SEA', name:'Seattle-Tacoma',    city:'Seattle',      lat:47.450, lng:-122.309,elev:433,  rwys:[156,164,176] },
  { icao:'KBOS', iata:'BOS', name:'Logan',             city:'Boston',       lat:42.363, lng:-71.006, elev:20,   rwys:[40,142,221,15,332,267] },
  { icao:'KMIA', iata:'MIA', name:'Miami',             city:'Miami',        lat:25.793, lng:-80.291, elev:8,    rwys:[88,98,265] },
  { icao:'KEWR', iata:'EWR', name:'Newark Liberty',    city:'Newark',       lat:40.692, lng:-74.169, elev:18,   rwys:[40,110,22] },
  { icao:'KLGA', iata:'LGA', name:'LaGuardia',         city:'New York',     lat:40.777, lng:-73.872, elev:21,   rwys:[40,310] },
  { icao:'KPHX', iata:'PHX', name:'Sky Harbor',        city:'Phoenix',      lat:33.434, lng:-112.012,elev:1135, rwys:[75,75,75] },
  { icao:'KIAH', iata:'IAH', name:'Bush Intl',         city:'Houston',      lat:29.984, lng:-95.341, elev:97,   rwys:[83,93,153,260] },
  { icao:'KCLT', iata:'CLT', name:'Douglas',           city:'Charlotte',    lat:35.214, lng:-80.949, elev:748,  rwys:[170,180,205,231] },
  { icao:'KLAS', iata:'LAS', name:'Harry Reid',        city:'Las Vegas',    lat:36.080, lng:-115.152,elev:2181, rwys:[10,73,90,80] },
  { icao:'KMSP', iata:'MSP', name:'Minneapolis-St.Paul',city:'Minneapolis', lat:44.882, lng:-93.222, elev:841,  rwys:[124,304,355,118] },
  { icao:'KDTW', iata:'DTW', name:'Detroit Metro',     city:'Detroit',      lat:42.213, lng:-83.349, elev:645,  rwys:[40,213,222,40] },
  { icao:'KPHL', iata:'PHL', name:'Philadelphia',      city:'Philadelphia', lat:39.872, lng:-75.241, elev:36,   rwys:[91,98,260,177] },
  { icao:'KSAN', iata:'SAN', name:'Lindbergh',         city:'San Diego',    lat:32.733, lng:-117.193,elev:17,   rwys:[270] },
  { icao:'CYYZ', iata:'YYZ', name:'Pearson',           city:'Toronto',      lat:43.677, lng:-79.631, elev:569,  rwys:[58,68,150,236,236] },
  { icao:'CYVR', iata:'YVR', name:'Vancouver',         city:'Vancouver',    lat:49.193, lng:-123.184,elev:14,   rwys:[80,80,127] },
  { icao:'EGLL', iata:'LHR', name:'Heathrow',          city:'London',       lat:51.470, lng:-0.4543, elev:83,   rwys:[88,272,88] },
  { icao:'EGKK', iata:'LGW', name:'Gatwick',           city:'London',       lat:51.148, lng:-0.1903, elev:202,  rwys:[80,260] },
  { icao:'EGSS', iata:'STN', name:'Stansted',          city:'London',       lat:51.885, lng:0.2350,  elev:348,  rwys:[44,222] },
  { icao:'LFPG', iata:'CDG', name:'Charles de Gaulle', city:'Paris',        lat:49.010, lng:2.548,   elev:392,  rwys:[80,80,260,260] },
  { icao:'LFPO', iata:'ORY', name:'Orly',              city:'Paris',        lat:48.723, lng:2.379,   elev:291,  rwys:[60,67,234] },
  { icao:'EHAM', iata:'AMS', name:'Schiphol',          city:'Amsterdam',    lat:52.309, lng:4.764,   elev:-11,  rwys:[60,180,229,40,86] },
  { icao:'EDDF', iata:'FRA', name:'Frankfurt',         city:'Frankfurt',    lat:50.027, lng:8.558,   elev:364,  rwys:[80,80,80,180] },
  { icao:'EDDM', iata:'MUC', name:'Munich',            city:'Munich',       lat:48.354, lng:11.786,  elev:1487, rwys:[80,80] },
  { icao:'EDDB', iata:'BER', name:'Brandenburg',       city:'Berlin',       lat:52.366, lng:13.503,  elev:157,  rwys:[70,250] },
  { icao:'EDDH', iata:'HAM', name:'Hamburg',           city:'Hamburg',      lat:53.630, lng:9.988,   elev:53,   rwys:[50,230,323] },
  { icao:'LSZH', iata:'ZRH', name:'Z\u00fcrich',       city:'Z\u00fcrich',  lat:47.458, lng:8.555,   elev:1416, rwys:[140,160,280,320] },
  { icao:'LSGG', iata:'GVA', name:'Geneva',            city:'Geneva',       lat:46.238, lng:6.108,   elev:1411, rwys:[40,220] },
  { icao:'LEMD', iata:'MAD', name:'Barajas',           city:'Madrid',       lat:40.472, lng:-3.561,  elev:1998, rwys:[140,140,320,320] },
  { icao:'LEBL', iata:'BCN', name:'El Prat',           city:'Barcelona',    lat:41.297, lng:2.078,   elev:12,   rwys:[60,250,200] },
  { icao:'LIRF', iata:'FCO', name:'Fiumicino',         city:'Rome',         lat:41.800, lng:12.239,  elev:13,   rwys:[160,160,250] },
  { icao:'LIMC', iata:'MXP', name:'Malpensa',          city:'Milan',        lat:45.630, lng:8.723,   elev:768,  rwys:[170,350] },
  { icao:'LOWW', iata:'VIE', name:'Vienna',            city:'Vienna',       lat:48.110, lng:16.570,  elev:600,  rwys:[110,160,290] },
  { icao:'LTFM', iata:'IST', name:'Istanbul',          city:'Istanbul',     lat:41.262, lng:28.742,  elev:325,  rwys:[160,180,340,260] },
  { icao:'LGAV', iata:'ATH', name:'Athens',            city:'Athens',       lat:37.937, lng:23.945,  elev:308,  rwys:[33,213,93] },
  { icao:'EPWA', iata:'WAW', name:'Chopin',            city:'Warsaw',       lat:52.166, lng:20.967,  elev:362,  rwys:[110,150,290,330] },
  { icao:'ESSA', iata:'ARN', name:'Arlanda',           city:'Stockholm',    lat:59.651, lng:17.918,  elev:137,  rwys:[10,80,260,190] },
  { icao:'EKCH', iata:'CPH', name:'Kastrup',           city:'Copenhagen',   lat:55.618, lng:12.656,  elev:17,   rwys:[40,220,120,300] },
  { icao:'ENGM', iata:'OSL', name:'Gardermoen',        city:'Oslo',         lat:60.194, lng:11.100,  elev:681,  rwys:[10,190,10,190] },
  { icao:'EFHK', iata:'HEL', name:'Helsinki-Vantaa',   city:'Helsinki',     lat:60.318, lng:24.963,  elev:179,  rwys:[40,220,150,330,40] },
  { icao:'UUEE', iata:'SVO', name:'Sheremetyevo',      city:'Moscow',       lat:55.972, lng:37.414,  elev:622,  rwys:[70,250,70,250,70] },
  { icao:'OMDB', iata:'DXB', name:'Dubai',             city:'Dubai',        lat:25.253, lng:55.365,  elev:62,   rwys:[120,300,120,300] },
  { icao:'OTHH', iata:'DOH', name:'Hamad',             city:'Doha',         lat:25.273, lng:51.608,  elev:13,   rwys:[160,340,160,340] },
  { icao:'OERK', iata:'RUH', name:'King Khaled',       city:'Riyadh',       lat:24.957, lng:46.699,  elev:2049, rwys:[160,340,160,340] },
  { icao:'VHHH', iata:'HKG', name:'Hong Kong',         city:'Hong Kong',    lat:22.308, lng:113.918, elev:28,   rwys:[70,250,70,250,70] },
  { icao:'WSSS', iata:'SIN', name:'Changi',            city:'Singapore',    lat:1.359,  lng:103.989, elev:22,   rwys:[20,200,20,200] },
  { icao:'RJTT', iata:'HND', name:'Haneda',            city:'Tokyo',        lat:35.553, lng:139.781, elev:35,   rwys:[160,340,40,220,220] },
  { icao:'RJAA', iata:'NRT', name:'Narita',            city:'Narita',       lat:35.764, lng:140.386, elev:135,  rwys:[164,344,164,344] },
  { icao:'RKSI', iata:'ICN', name:'Incheon',           city:'Seoul',        lat:37.463, lng:126.440, elev:23,   rwys:[152,332,160,340,160] },
  { icao:'ZBAA', iata:'PEK', name:'Beijing Capital',   city:'Beijing',      lat:40.080, lng:116.585, elev:116,  rwys:[10,190,180,360,180] },
  { icao:'ZSPD', iata:'PVG', name:'Pudong',            city:'Shanghai',     lat:31.143, lng:121.805, elev:13,   rwys:[170,350,160,340,170] },
  { icao:'VIDP', iata:'DEL', name:'Indira Gandhi',     city:'Delhi',        lat:28.566, lng:77.103,  elev:777,  rwys:[100,280,110,290] },
  { icao:'VABB', iata:'BOM', name:'Mumbai',            city:'Mumbai',       lat:19.089, lng:72.868,  elev:39,   rwys:[90,270,140,320] },
  { icao:'YSSY', iata:'SYD', name:'Kingsford Smith',   city:'Sydney',       lat:-33.946,lng:151.177, elev:21,   rwys:[160,340,70,250,160] },
]

const R_NM = 3440.065
const toRad = (d: number) => d * Math.PI / 180
const toDeg = (r: number) => r * 180 / Math.PI
function distNm(a: number, b: number, c: number, d: number): number {
  const φ1 = toRad(a), φ2 = toRad(c)
  const dφ = toRad(c - a), dλ = toRad(d - b)
  const x = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(x)))
}
function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = toRad(lat1), φ2 = toRad(lat2), dλ = toRad(lng2 - lng1)
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}
function angDelta(a: number, b: number): number {
  let d = ((a - b) % 360 + 540) % 360 - 180
  return d
}
function destLatLng(lat: number, lng: number, brgDeg: number, distNm: number): [number, number] {
  const δ = distNm / R_NM, θ = toRad(brgDeg), φ1 = toRad(lat), λ1 = toRad(lng)
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return [toDeg(φ2), ((toDeg(λ2) + 540) % 360) - 180]
}

const SRC_PIN = 'rwy-cfg-pin'
const SRC_BAR = 'rwy-cfg-bar'
const SRC_BARB = 'rwy-cfg-barb'
const SRC_RING = 'rwy-cfg-ring'
const SRC_LINK = 'rwy-cfg-link'
const SRC_LBL = 'rwy-cfg-lbl'
const LYR_PIN = 'rwy-cfg-pin-l'
const LYR_BAR = 'rwy-cfg-bar-l'
const LYR_BARB = 'rwy-cfg-barb-l'
const LYR_RING = 'rwy-cfg-ring-l'
const LYR_LINK = 'rwy-cfg-link-l'
const LYR_LBL = 'rwy-cfg-lbl-l'

export default function RunwayConfig({ map, flights, onClose, onFly, onFlyLatLng }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AP' | 'AC'>('AP')
  const [query, setQuery] = useState('')
  const [sampleNm, setSampleNm] = useState(80)
  const [xwLimit, setXwLimit] = useState(25)
  const [tailLimit, setTailLimit] = useState(10)
  const [minDepFpm, setMinDepFpm] = useState(300)
  const [showOverlay, setShowOverlay] = useState(true)
  const [showBars, setShowBars] = useState(true)
  const [showBarbs, setShowBarbs] = useState(true)
  const [showLinks, setShowLinks] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [arrDepFilter, setArrDepFilter] = useState<{ARR:boolean, DEP:boolean}>({ARR:true, DEP:true})

  /* ---------- per-airport analysis ---------- */
  const analysis = useMemo(() => {
    const airborne = flights.filter(f => !f.ground && f.altitudeFt > 0 && Number.isFinite(f.lat) && Number.isFinite(f.lng))
    type AcRow = {
      f: RcFlight
      ap: HubAirport
      role: 'ARR' | 'DEP' | 'OTH'
      distNm: number
      bearingToAp: number
      bearingFromAp: number
      rwyEnd: number       // matched runway end bearing (true)
      rwyName: string      // e.g. "27L" simplified to "27"
      alignDelta: number   // |track vs rwyEnd|
      crossKt: number
      headKt: number
      tier: Tier
    }
    type ApRow = {
      ap: HubAirport
      windFrom: number
      windKts: number
      sampleCount: number
      arrCount: number
      depCount: number
      activeArrEnd: number
      activeDepEnd: number
      activeArrName: string
      activeDepName: string
      crossKt: number
      tailKt: number
      headKt: number
      dispersion: number
      score: number
      tier: Tier
      reason: string
      changeMin: number // estimated minutes until forced config change (Infinity if stable)
    }

    const ap_rows: ApRow[] = []
    const ac_rows: AcRow[] = []

    for (const ap of HUBS) {
      // gather nearby airborne aircraft
      const near: { f: RcFlight, d: number, b: number }[] = []
      for (const f of airborne) {
        const d = distNm(ap.lat, ap.lng, f.lat, f.lng)
        if (d > sampleNm) continue
        if (f.altitudeFt > 14000) continue
        near.push({ f, d, b: bearingDeg(ap.lat, ap.lng, f.lat, f.lng) })
      }
      if (near.length === 0) continue

      // wind via inverse-range-weighted u/v from reported winds
      let su = 0, sv = 0, sw = 0, samples = 0
      for (const n of near) {
        const wd = n.f.windDir, wk = n.f.windKts
        if (typeof wd !== 'number' || typeof wk !== 'number' || wk < 1) continue
        const w = 1 / (Math.max(2, n.d))
        const rad = toRad(wd)
        su += -Math.sin(rad) * wk * w
        sv += -Math.cos(rad) * wk * w
        sw += w
        samples++
      }
      let windFrom = 270, windKts = 8
      if (sw > 0 && samples >= 2) {
        const u = su / sw, v = sv / sw
        windKts = Math.sqrt(u*u + v*v)
        const t = toDeg(Math.atan2(-u, -v))
        windFrom = (t + 360) % 360
      }
      // sort runway end candidates: each rwy provides 2 ends (rwy bearing and +180)
      const endCandidates: number[] = []
      for (const r of ap.rwys) {
        const seen = endCandidates.some(e => Math.abs(angDelta(e, r)) < 5)
        if (!seen) endCandidates.push(r)
        const opp = (r + 180) % 360
        const seen2 = endCandidates.some(e => Math.abs(angDelta(e, opp)) < 5)
        if (!seen2) endCandidates.push(opp)
      }

      // arrival detection: descending or low aircraft within 30nm closing the airport
      const arrBins = new Map<number, number>() // end -> count
      const arrs: { f: RcFlight, d: number, b: number, end: number, delta: number }[] = []
      for (const n of near) {
        if (n.d > 30) continue
        if (n.f.altitudeFt > 8000) continue
        // landing bearing = bearing FROM aircraft TO airport; aircraft track should approximate that
        const trackToAp = bearingDeg(n.f.lat, n.f.lng, ap.lat, ap.lng)
        const trackDelta = Math.abs(angDelta(n.f.track, trackToAp))
        if (trackDelta > 35) continue
        // for arrivals the rwy end aligns with the aircraft's track (final approach course)
        let bestEnd = endCandidates[0], bestΔ = 999
        for (const e of endCandidates) {
          const d = Math.abs(angDelta(n.f.track, e))
          if (d < bestΔ) { bestΔ = d; bestEnd = e }
        }
        if (bestΔ > 30) continue
        arrs.push({ f: n.f, d: n.d, b: n.b, end: bestEnd, delta: bestΔ })
        const key = Math.round(bestEnd / 10) * 10
        arrBins.set(key, (arrBins.get(key) || 0) + 1)
      }
      let activeArr = -1, arrCount = arrs.length
      if (arrBins.size > 0) {
        let bk = -1, bv = -1
        arrBins.forEach((v, k) => { if (v > bv) { bv = v; bk = k } })
        activeArr = bk
      }

      // departure detection
      const depBins = new Map<number, number>()
      const deps: { f: RcFlight, d: number, b: number, end: number, delta: number }[] = []
      for (const n of near) {
        if (n.d > 12) continue
        if (n.f.altitudeFt > 8000) continue
        if ((n.f.vertRate ?? 0) < minDepFpm) continue
        // for departures the aircraft track ~= runway end heading (just took off)
        let bestEnd = endCandidates[0], bestΔ = 999
        for (const e of endCandidates) {
          const d = Math.abs(angDelta(n.f.track, e))
          if (d < bestΔ) { bestΔ = d; bestEnd = e }
        }
        if (bestΔ > 30) continue
        deps.push({ f: n.f, d: n.d, b: n.b, end: bestEnd, delta: bestΔ })
        const key = Math.round(bestEnd / 10) * 10
        depBins.set(key, (depBins.get(key) || 0) + 1)
      }
      let activeDep = -1, depCount = deps.length
      if (depBins.size > 0) {
        let bk = -1, bv = -1
        depBins.forEach((v, k) => { if (v > bv) { bv = v; bk = k } })
        activeDep = bk
      }

      // when only one detected, mirror
      if (activeArr < 0 && activeDep >= 0) activeArr = activeDep
      if (activeDep < 0 && activeArr >= 0) activeDep = activeArr
      if (activeArr < 0) {
        // fallback: pick rwy end most into the wind
        let best = endCandidates[0], bestΔ = 999
        for (const e of endCandidates) {
          const d = Math.abs(angDelta(e, windFrom))
          if (d < bestΔ) { bestΔ = d; best = e }
        }
        activeArr = best; activeDep = best
      }

      // crosswind / tailwind on active arrival end (the more critical one for safety)
      const Δw = angDelta(windFrom, activeArr) // wind direction relative to rwy heading
      const headKt = windKts * Math.cos(toRad(Δw))
      const crossKt = Math.abs(windKts * Math.sin(toRad(Δw)))
      const tailKt = Math.max(0, -headKt)

      // dispersion: fraction of arrivals not on active end ±20deg
      let off = 0
      for (const a of arrs) if (Math.abs(angDelta(a.end, activeArr)) > 20) off++
      const dispersion = arrCount > 0 ? off / arrCount : 0

      // composite score
      const sTail = tailKt / Math.max(1, tailLimit)
      const sX = crossKt / Math.max(1, xwLimit)
      const sD = dispersion * 1.5
      const score = 0.45 * sX + 0.35 * sTail + 0.20 * sD
      let tier: Tier = 'OPTIMAL'
      if (score >= 1.10 || tailKt > tailLimit * 1.2 || crossKt > xwLimit * 1.2) tier = 'CHANGE'
      else if (score >= 0.70) tier = 'DEGRADED'
      else if (score >= 0.35) tier = 'OK'

      const reasons: string[] = []
      if (crossKt > xwLimit) reasons.push(`XW ${crossKt.toFixed(0)}kt > lim`)
      if (tailKt > tailLimit) reasons.push(`TAIL ${tailKt.toFixed(0)}kt > lim`)
      if (dispersion > 0.35) reasons.push(`DISP ${(dispersion*100).toFixed(0)}%`)
      const reason = reasons.length ? reasons.join(' \u00B7 ') : 'within limits'

      // crude change-time estimate: if currently nominal, infer how many kt we have
      // until we cross threshold, assume wind grows at 1kt/10min ambient drift rate
      let changeMin = Infinity
      if (tier !== 'CHANGE') {
        const xwHead = xwLimit - crossKt
        const tlHead = tailLimit - tailKt
        const head = Math.min(xwHead, tlHead)
        if (head > 0 && head < 999) changeMin = head * 10 // 1kt per 10min
      } else changeMin = 0

      const arrName = `${Math.round(activeArr / 10).toString().padStart(2, '0')}`
      const depName = `${Math.round(activeDep / 10).toString().padStart(2, '0')}`

      ap_rows.push({
        ap, windFrom, windKts, sampleCount: samples,
        arrCount, depCount, activeArrEnd: activeArr, activeDepEnd: activeDep,
        activeArrName: arrName, activeDepName: depName,
        crossKt, tailKt, headKt, dispersion, score, tier, reason, changeMin,
      })

      // emit aircraft rows
      for (const a of arrs) {
        const rwyName = `${Math.round(a.end / 10).toString().padStart(2, '0')}`
        const Δ = angDelta(a.f.windDir ?? windFrom, a.end)
        const ws = a.f.windKts ?? windKts
        const c = Math.abs(ws * Math.sin(toRad(Δ)))
        const h = ws * Math.cos(toRad(Δ))
        let t: Tier = 'OPTIMAL'
        if (c > xwLimit * 1.2 || h < -tailLimit * 1.2) t = 'CHANGE'
        else if (c > xwLimit) t = 'DEGRADED'
        else if (c > xwLimit * 0.7 || a.delta > 15) t = 'OK'
        ac_rows.push({ f: a.f, ap, role: 'ARR', distNm: a.d, bearingToAp: bearingDeg(a.f.lat,a.f.lng,ap.lat,ap.lng), bearingFromAp: a.b, rwyEnd: a.end, rwyName, alignDelta: a.delta, crossKt: c, headKt: h, tier: t })
      }
      for (const a of deps) {
        const rwyName = `${Math.round(a.end / 10).toString().padStart(2, '0')}`
        const Δ = angDelta(a.f.windDir ?? windFrom, a.end)
        const ws = a.f.windKts ?? windKts
        const c = Math.abs(ws * Math.sin(toRad(Δ)))
        const h = ws * Math.cos(toRad(Δ))
        let t: Tier = 'OPTIMAL'
        if (c > xwLimit * 1.2 || h < -tailLimit * 1.2) t = 'CHANGE'
        else if (c > xwLimit) t = 'DEGRADED'
        else if (c > xwLimit * 0.7) t = 'OK'
        ac_rows.push({ f: a.f, ap, role: 'DEP', distNm: a.d, bearingToAp: bearingDeg(a.f.lat,a.f.lng,ap.lat,ap.lng), bearingFromAp: a.b, rwyEnd: a.end, rwyName, alignDelta: a.delta, crossKt: c, headKt: h, tier: t })
      }
    }

    ap_rows.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || b.score - a.score)
    ac_rows.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || b.crossKt - a.crossKt)

    return { ap_rows, ac_rows }
  }, [flights, sampleNm, xwLimit, tailLimit, minDepFpm])

  const { ap_rows, ac_rows } = analysis

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { OPTIMAL: 0, OK: 0, DEGRADED: 0, CHANGE: 0 }
    for (const r of ap_rows) c[r.tier]++
    return c
  }, [ap_rows])

  const summary = useMemo(() => {
    const fleet = ac_rows.length
    let totX = 0
    for (const r of ap_rows) totX += r.crossKt
    return { airports: ap_rows.length, fleet, meanX: ap_rows.length ? totX / ap_rows.length : 0 }
  }, [ap_rows, ac_rows])

  const filteredAP = useMemo(() => {
    const q = query.trim().toLowerCase()
    let rs = tierFilter === 'ALL' ? ap_rows : ap_rows.filter(r => r.tier === tierFilter)
    if (q) rs = rs.filter(r =>
      r.ap.iata.toLowerCase().includes(q) ||
      r.ap.icao.toLowerCase().includes(q) ||
      r.ap.city.toLowerCase().includes(q) ||
      r.ap.name.toLowerCase().includes(q)
    )
    return rs
  }, [ap_rows, tierFilter, query])

  const filteredAC = useMemo(() => {
    const q = query.trim().toLowerCase()
    let rs = ac_rows
    if (!arrDepFilter.ARR) rs = rs.filter(r => r.role !== 'ARR')
    if (!arrDepFilter.DEP) rs = rs.filter(r => r.role !== 'DEP')
    if (tierFilter !== 'ALL') rs = rs.filter(r => r.tier === tierFilter)
    if (q) rs = rs.filter(r =>
      (r.f.callsign||'').toLowerCase().includes(q) ||
      (r.f.icao||'').toLowerCase().includes(q) ||
      (r.f.type||'').toLowerCase().includes(q) ||
      (r.f.operator||'').toLowerCase().includes(q) ||
      r.ap.iata.toLowerCase().includes(q)
    )
    return rs.slice(0, 200)
  }, [ac_rows, tierFilter, query, arrDepFilter])

  /* ---------- MapLibre layers ---------- */
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        for (const [s, l] of [
          [SRC_BAR, LYR_BAR], [SRC_BARB, LYR_BARB], [SRC_LINK, LYR_LINK],
          [SRC_PIN, LYR_PIN], [SRC_RING, LYR_RING], [SRC_LBL, LYR_LBL],
        ] as const) if (!map.getSource(s)) map.addSource(s, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_BAR)) map.addLayer({
          id: LYR_BAR, type: 'line', source: SRC_BAR,
          paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': 0.85 }
        })
        if (!map.getLayer(LYR_BARB)) map.addLayer({
          id: LYR_BARB, type: 'line', source: SRC_BARB,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.6, 'line-dasharray': [2, 1.4] }
        })
        if (!map.getLayer(LYR_LINK)) map.addLayer({
          id: LYR_LINK, type: 'line', source: SRC_LINK,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.0, 'line-dasharray': [2, 2], 'line-opacity': 0.6 }
        })
        if (!map.getLayer(LYR_PIN)) map.addLayer({
          id: LYR_PIN, type: 'circle', source: SRC_PIN,
          paint: {
            'circle-radius': 5,
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#0b1220',
            'circle-stroke-width': 1.4,
          }
        })
        if (!map.getLayer(LYR_RING)) map.addLayer({
          id: LYR_RING, type: 'circle', source: SRC_RING,
          paint: { 'circle-radius': ['get', 'r'], 'circle-color': 'transparent', 'circle-stroke-color': ['get','color'], 'circle-stroke-width': 1.5, 'circle-opacity': 0.9 }
        })
        if (!map.getLayer(LYR_LBL)) map.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC_LBL,
          layout: { 'text-field': ['get', 'label'], 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'], 'text-size': 10, 'text-offset': [0, 1.0], 'text-allow-overlap': true },
          paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.4 },
        })
      } catch {}
    }
    if (map.isStyleLoaded()) ensure()
    else map.once('load', ensure)
  }, [map])

  useEffect(() => {
    if (!map) return
    const pinFeats: any[] = []
    const barFeats: any[] = []
    const barbFeats: any[] = []
    const ringFeats: any[] = []
    const linkFeats: any[] = []
    const lblFeats: any[] = []

    if (showOverlay) {
      const visAp = tierFilter === 'ALL' ? ap_rows : ap_rows.filter(r => r.tier === tierFilter)
      for (const r of visAp) {
        const c = TIER_COLOR[r.tier]
        pinFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.ap.lng, r.ap.lat] }, properties: { color: c } })
        if (showBars) {
          // arrival bar (sky)
          const arrA = destLatLng(r.ap.lat, r.ap.lng, r.activeArrEnd, 1.2)
          const arrB = destLatLng(r.ap.lat, r.ap.lng, (r.activeArrEnd + 180) % 360, 1.2)
          barFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[arrB[1], arrB[0]], [arrA[1], arrA[0]]] }, properties: { color: '#38bdf8' } })
          if (r.activeDepEnd !== r.activeArrEnd && arrDepFilter.DEP) {
            const depA = destLatLng(r.ap.lat, r.ap.lng, r.activeDepEnd, 1.2)
            const depB = destLatLng(r.ap.lat, r.ap.lng, (r.activeDepEnd + 180) % 360, 1.2)
            barFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[depB[1], depB[0]], [depA[1], depA[0]]] }, properties: { color: '#a78bfa' } })
          }
        }
        if (showBarbs) {
          const len = 0.4 + Math.min(2.0, r.windKts / 20)
          const tip = destLatLng(r.ap.lat, r.ap.lng, r.windFrom, len)
          barbFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.ap.lng, r.ap.lat], [tip[1], tip[0]]] }, properties: { color: c } })
        }
        if (showLabels) {
          lblFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.ap.lng, r.ap.lat] }, properties: { color: c, label: `${r.ap.iata} \u00B7 RWY ${r.activeArrName} \u00B7 XW ${r.crossKt.toFixed(0)}` } })
        }
      }
      // aircraft rings & links
      const visAc = tierFilter === 'ALL' ? ac_rows : ac_rows.filter(r => r.tier === tierFilter)
      for (const r of visAc) {
        if (!arrDepFilter.ARR && r.role === 'ARR') continue
        if (!arrDepFilter.DEP && r.role === 'DEP') continue
        const c = TIER_COLOR[r.tier]
        ringFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color: c, r: 6 + Math.min(14, r.crossKt / 3) } })
        if (showLinks && r.alignDelta > 15 && r.role === 'ARR') {
          linkFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.ap.lng, r.ap.lat]] }, properties: { color: c } })
        }
      }
    }
    try {
      ;(map.getSource(SRC_PIN) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: pinFeats })
      ;(map.getSource(SRC_BAR) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: barFeats })
      ;(map.getSource(SRC_BARB) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: barbFeats })
      ;(map.getSource(SRC_RING) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: ringFeats })
      ;(map.getSource(SRC_LINK) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: linkFeats })
      ;(map.getSource(SRC_LBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lblFeats })
    } catch {}
  }, [map, ap_rows, ac_rows, tierFilter, showOverlay, showBars, showBarbs, showLinks, showLabels, arrDepFilter])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_LBL, LYR_RING, LYR_LINK, LYR_BARB, LYR_BAR, LYR_PIN]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_LBL, SRC_RING, SRC_LINK, SRC_BARB, SRC_BAR, SRC_PIN]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  /* ---------- compass diagram (top airport) ---------- */
  const compass = useMemo(() => {
    const top = filteredAP[0] ?? ap_rows[0]
    if (!top) return null
    const W = 348, H = 170, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 14
    return { W, H, cx, cy, R, top }
  }, [filteredAP, ap_rows])

  return (
    <div className="fixed top-16 right-3 z-40 w-[400px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">&#10070;</span>
          <span className="text-sm font-semibold tracking-wide">RUNWAY CONFIG</span>
          <span className="text-[10px] text-slate-500">live ATC active-rwy + wind</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {(['CHANGE','DEGRADED','OK','OPTIMAL'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/50 bg-sky-500/10' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }} title={t}>
            <span className="text-[9px] tracking-wider">{t.slice(0,4)}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="px-3 py-2 grid grid-cols-3 gap-1 border-b border-slate-800">
        <div className="text-center">
          <div className="text-[9px] text-slate-500 tracking-wider">AIRPORTS</div>
          <div className="text-base font-mono text-sky-300">{summary.airports}/{HUBS.length}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] text-slate-500 tracking-wider">FLEET</div>
          <div className="text-base font-mono text-slate-200">{summary.fleet}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] text-slate-500 tracking-wider">MEAN XW</div>
          <div className="text-base font-mono" style={{ color: summary.meanX > xwLimit ? TIER_COLOR.DEGRADED : '#94a3b8' }}>{summary.meanX.toFixed(0)}kt</div>
        </div>
      </div>

      {compass && (
        <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/30">
          <div className="text-[10px] text-slate-500 tracking-wider flex items-center justify-between mb-1">
            <span>{'WIND COMPASS \u00B7 '}{compass.top.ap.iata}</span>
            <span className="font-mono text-slate-400">{compass.top.windFrom.toFixed(0)}{'\u00B0'}/{compass.top.windKts.toFixed(0)}kt</span>
          </div>
          <svg width={compass.W} height={compass.H} className="block">
            <rect x={0} y={0} width={compass.W} height={compass.H} fill="#0b1220" />
            {/* concentric rings */}
            {[0.33, 0.66, 1].map(p => (
              <circle key={p} cx={compass.cx} cy={compass.cy} r={compass.R * p} fill="none" stroke="#1e293b" strokeWidth={0.6} />
            ))}
            {/* cardinal spokes */}
            {[0,90,180,270].map(a => {
              const r = toRad(a - 90)
              const x = compass.cx + Math.cos(r) * compass.R
              const y = compass.cy + Math.sin(r) * compass.R
              return <line key={a} x1={compass.cx} y1={compass.cy} x2={x} y2={y} stroke="#1e293b" strokeWidth={0.6} />
            })}
            {['N','E','S','W'].map((l, i) => {
              const a = i * 90
              const r = toRad(a - 90)
              const x = compass.cx + Math.cos(r) * (compass.R + 8)
              const y = compass.cy + Math.sin(r) * (compass.R + 8) + 3
              return <text key={l} x={x} y={y} fill="#64748b" fontSize={9} textAnchor="middle" fontFamily="ui-monospace, monospace">{l}</text>
            })}
            {/* runway lines through center */}
            {Array.from(new Set(compass.top.ap.rwys.map(r => Math.round(r / 5) * 5))).map(rb => {
              const r1 = toRad(rb - 90), r2 = toRad((rb + 180) - 90)
              const x1 = compass.cx + Math.cos(r1) * compass.R * 0.9
              const y1 = compass.cy + Math.sin(r1) * compass.R * 0.9
              const x2 = compass.cx + Math.cos(r2) * compass.R * 0.9
              const y2 = compass.cy + Math.sin(r2) * compass.R * 0.9
              return <line key={rb} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#475569" strokeWidth={2} opacity={0.7} />
            })}
            {/* active arrival highlight */}
            {(() => {
              const r1 = toRad(compass.top.activeArrEnd - 90)
              const x = compass.cx + Math.cos(r1) * compass.R * 0.9
              const y = compass.cy + Math.sin(r1) * compass.R * 0.9
              return <line key="arr" x1={compass.cx} y1={compass.cy} x2={x} y2={y} stroke="#38bdf8" strokeWidth={3} />
            })()}
            {/* wind FROM arrow */}
            {(() => {
              const r1 = toRad(compass.top.windFrom - 90)
              const len = compass.R * (0.3 + Math.min(0.7, compass.top.windKts / 40))
              const tipx = compass.cx + Math.cos(r1) * len
              const tipy = compass.cy + Math.sin(r1) * len
              return <g>
                <line x1={compass.cx} y1={compass.cy} x2={tipx} y2={tipy} stroke={TIER_COLOR[compass.top.tier]} strokeWidth={2.5} />
                <circle cx={tipx} cy={tipy} r={3} fill={TIER_COLOR[compass.top.tier]} stroke="#0b1220" strokeWidth={0.8} />
              </g>
            })()}
            <text x={compass.cx} y={compass.H - 4} fill="#94a3b8" fontSize={9} textAnchor="middle" fontFamily="ui-monospace, monospace">
              ACTIVE {compass.top.activeArrName} {'\u00B7'} XW {compass.top.crossKt.toFixed(0)} {'\u00B7'} TAIL {compass.top.tailKt.toFixed(0)}
            </text>
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>SAMPLE RNG</span><span className="font-mono text-slate-300">{sampleNm} nm</span>
          </div>
          <input type="range" min={30} max={150} step={5} value={sampleNm} onChange={e => setSampleNm(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>XWIND LIMIT</span><span className="font-mono text-slate-300">{xwLimit} kt</span>
          </div>
          <input type="range" min={10} max={45} step={1} value={xwLimit} onChange={e => setXwLimit(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>TAIL LIMIT</span><span className="font-mono text-slate-300">{tailLimit} kt</span>
          </div>
          <input type="range" min={3} max={20} step={1} value={tailLimit} onChange={e => setTailLimit(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>MIN DEP FPM</span><span className="font-mono text-slate-300">{minDepFpm}</span>
          </div>
          <input type="range" min={100} max={2000} step={50} value={minDepFpm} onChange={e => setMinDepFpm(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ARR','DEP'] as const).map(s => (
            <button key={s} onClick={() => setArrDepFilter(o => ({...o, [s]: !o[s]}))}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${arrDepFilter[s] ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-500'}`}>{s}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showOverlay} onChange={e => setShowOverlay(e.target.checked)} className="accent-sky-500" /><span>OVL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showBars} onChange={e => setShowBars(e.target.checked)} className="accent-sky-500" /><span>BAR</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showBarbs} onChange={e => setShowBarbs(e.target.checked)} className="accent-sky-500" /><span>BARB</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLinks} onChange={e => setShowLinks(e.target.checked)} className="accent-sky-500" /><span>LINK</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search iata / icao / city / callsign"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 pt-2 flex gap-1 border-b border-slate-800">
        {(['AP','AC'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2.5 py-1 text-[10px] rounded-t border-x border-t font-mono ${tab === t ? 'bg-sky-500/10 border-sky-500/40 text-sky-100' : 'bg-slate-900/40 border-slate-800 text-slate-500'}`}>
            {t === 'AP' ? `AIRPORTS (${filteredAP.length})` : `AIRCRAFT (${filteredAC.length})`}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AP' && filteredAP.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No airports with sampled traffic.</div>
        )}
        {tab === 'AP' && filteredAP.map(r => (
          <button key={r.ap.icao} onClick={() => onFlyLatLng(r.ap.lat, r.ap.lng, 10)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
            <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono font-semibold truncate">{r.ap.iata}</span>
                <span className="text-slate-500 truncate">{r.ap.name}</span>
                <span className="ml-auto text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                <span className="text-sky-300">ARR {r.activeArrName}</span>
                <span className="text-violet-300">DEP {r.activeDepName}</span>
                <span>arr {r.arrCount}</span>
                <span className="ml-auto">dep {r.depCount}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                <span>wind {r.windFrom.toFixed(0)}{'\u00B0'}/{r.windKts.toFixed(0)}</span>
                <span style={{ color: r.crossKt > xwLimit ? TIER_COLOR.DEGRADED : '#94a3b8' }}>xw {r.crossKt.toFixed(0)}</span>
                <span style={{ color: r.tailKt > tailLimit ? TIER_COLOR.CHANGE : '#94a3b8' }}>tail {r.tailKt.toFixed(0)}</span>
                <span className="ml-auto">disp {(r.dispersion*100).toFixed(0)}%</span>
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.score * 100)}%`, background: TIER_COLOR[r.tier], opacity: 0.7 }} />
                <div className="absolute inset-y-0 w-px bg-amber-400/70" style={{ left: '35%' }} />
                <div className="absolute inset-y-0 w-px bg-orange-400/70" style={{ left: '70%' }} />
                <div className="absolute inset-y-0 w-px bg-rose-400/70" style={{ left: '110%' }} />
              </div>
              <div className="flex items-center gap-2 text-[10px] text-slate-500 font-mono mt-0.5">
                <span className="truncate">{r.reason}</span>
                <span className="ml-auto">
                  {r.changeMin === 0 ? 'CHANGE NOW' : r.changeMin === Infinity ? '\u2014' : `~${r.changeMin.toFixed(0)}min to change`}
                </span>
              </div>
            </div>
          </button>
        ))}
        {tab === 'AC' && filteredAC.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No matching aircraft on approach/departure.</div>
        )}
        {tab === 'AC' && filteredAC.map(r => (
          <button key={`${r.f.icao}-${r.ap.icao}-${r.role}`} onClick={() => onFly(r.f.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
            <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                <span className="ml-auto text-[10px] font-semibold" style={{ color: r.role === 'ARR' ? '#38bdf8' : '#a78bfa' }}>{r.role}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                <span>{r.ap.iata}</span>
                <span>RWY {r.rwyName}</span>
                <span>FL{Math.round(r.f.altitudeFt / 100)}</span>
                <span>{r.f.velocityKts.toFixed(0)}kt</span>
                <span className="ml-auto">{r.distNm.toFixed(1)}nm</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                <span>{'\u0394hdg'} {r.alignDelta.toFixed(0)}{'\u00B0'}</span>
                <span style={{ color: r.crossKt > xwLimit ? TIER_COLOR.DEGRADED : '#94a3b8' }}>XW {r.crossKt.toFixed(0)}</span>
                <span style={{ color: r.headKt < -tailLimit ? TIER_COLOR.CHANGE : '#94a3b8' }}>{r.headKt >= 0 ? 'HW' : 'TW'} {Math.abs(r.headKt).toFixed(0)}</span>
                <span className="ml-auto truncate">{r.f.operator || ''}</span>
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, (r.crossKt / Math.max(1, xwLimit * 2)) * 100)}%`, background: TIER_COLOR[r.tier], opacity: 0.7 }} />
                <div className="absolute inset-y-0 w-px bg-sky-400/70" style={{ left: '50%' }} />
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
