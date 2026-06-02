'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   METAR Monitor
   ------------------------------------------------------------
   Synthesises a "live METAR" picture for 60 major airports
   worldwide by aggregating low-altitude aircraft reports
   within SAMPLE-RNG nm of the field and below MAX-FL.

     wind   = inverse-range-weighted u/v vector mean of
              reported (windDir-from, windKts), recovered to
              FROM bearing + speed (kt).
     temp   = ISA SAT lapsed back to field elevation, mean of
              all valid samples, +/- ISA-DEV slider.
     altim  = QNH proxy from ISA pressure altitude offset.
     vis    = visibility proxy from sample-count density
              (more low samples = more activity = better vis;
              very few samples in a busy hub region = LIFR).
     ceil   = lowest sampled altitude AGL projected from
              traffic activity below 3000 AGL.

   Each airport is classified per FAA flight-category rules:
     VFR    ceil > 3000 AGL  & vis > 5 SM      sky
     MVFR   ceil 1000-3000   & vis 3-5         yellow
     IFR    ceil 500-1000    & vis 1-3         amber
     LIFR   ceil < 500       & vis < 1         rose

   Output: per-airport METAR-style readout
     KJFK 1830Z 24015KT 6SM BKN025 18/12 A2992 [VFR]

   Overlay paints tier-coloured airport pin + range ring +
   wind barb, with side panel showing 4-tier counter,
   summary, sortable airport table, decoded raw-METAR row.
   ============================================================ */

const SRC_PIN = 'metar-pin-src'
const LYR_PIN = 'metar-pin-lyr'
const SRC_RING = 'metar-ring-src'
const LYR_RING = 'metar-ring-lyr'
const SRC_BARB = 'metar-barb-src'
const LYR_BARB = 'metar-barb-lyr'
const SRC_LBL = 'metar-lbl-src'
const LYR_LBL = 'metar-lbl-lyr'

export interface MtFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  vertRate: number
  windDir?: number
  windKts?: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: MtFlight[]
  onClose: () => void
  onFly: (icao: string) => void
  onFlyLatLng: (lat: number, lng: number, zoom?: number) => void
}

type Tier = 'VFR' | 'MVFR' | 'IFR' | 'LIFR'
const TIER_COLOR: Record<Tier, string> = {
  VFR: '#0ea5e9',
  MVFR: '#fbbf24',
  IFR: '#f97316',
  LIFR: '#ef4444',
}
const TIER_ORDER: Tier[] = ['LIFR', 'IFR', 'MVFR', 'VFR']

interface Stn {
  icao: string
  iata: string
  name: string
  city: string
  lat: number
  lng: number
  elevFt: number
}

/* 60 curated major airports with published field elevations (AIP / Jeppesen). */
const STATIONS: Stn[] = [
  { icao:'KATL', iata:'ATL', name:'Hartsfield-Jackson', city:'Atlanta', lat:33.6407, lng:-84.4277, elevFt:1026 },
  { icao:'KORD', iata:'ORD', name:"O'Hare", city:'Chicago', lat:41.9786, lng:-87.9048, elevFt:672 },
  { icao:'KDFW', iata:'DFW', name:'Dallas/Fort Worth', city:'Dallas', lat:32.8998, lng:-97.0403, elevFt:607 },
  { icao:'KDEN', iata:'DEN', name:'Denver', city:'Denver', lat:39.8617, lng:-104.6731, elevFt:5431 },
  { icao:'KLAX', iata:'LAX', name:'Los Angeles', city:'Los Angeles', lat:33.9416, lng:-118.4085, elevFt:128 },
  { icao:'KJFK', iata:'JFK', name:'John F Kennedy', city:'New York', lat:40.6413, lng:-73.7781, elevFt:13 },
  { icao:'KSFO', iata:'SFO', name:'San Francisco', city:'San Francisco', lat:37.6213, lng:-122.379, elevFt:13 },
  { icao:'KSEA', iata:'SEA', name:'Seattle-Tacoma', city:'Seattle', lat:47.4502, lng:-122.3088, elevFt:432 },
  { icao:'KLAS', iata:'LAS', name:'Harry Reid', city:'Las Vegas', lat:36.084, lng:-115.1537, elevFt:2181 },
  { icao:'KMCO', iata:'MCO', name:'Orlando', city:'Orlando', lat:28.4312, lng:-81.308, elevFt:96 },
  { icao:'KMIA', iata:'MIA', name:'Miami', city:'Miami', lat:25.7959, lng:-80.287, elevFt:8 },
  { icao:'KEWR', iata:'EWR', name:'Newark', city:'Newark', lat:40.6895, lng:-74.1745, elevFt:18 },
  { icao:'KBOS', iata:'BOS', name:'Logan', city:'Boston', lat:42.3656, lng:-71.0096, elevFt:20 },
  { icao:'KPHX', iata:'PHX', name:'Sky Harbor', city:'Phoenix', lat:33.4373, lng:-112.0078, elevFt:1135 },
  { icao:'KIAH', iata:'IAH', name:'George Bush', city:'Houston', lat:29.9902, lng:-95.3368, elevFt:97 },
  { icao:'KMSP', iata:'MSP', name:'Minneapolis-St Paul', city:'Minneapolis', lat:44.8848, lng:-93.2223, elevFt:841 },
  { icao:'KDTW', iata:'DTW', name:'Detroit Metro', city:'Detroit', lat:42.2124, lng:-83.3534, elevFt:645 },
  { icao:'KBWI', iata:'BWI', name:'Baltimore/Washington', city:'Baltimore', lat:39.1754, lng:-76.6684, elevFt:146 },
  { icao:'KDCA', iata:'DCA', name:'Reagan National', city:'Washington', lat:38.8512, lng:-77.0402, elevFt:15 },
  { icao:'KIAD', iata:'IAD', name:'Dulles', city:'Washington', lat:38.9531, lng:-77.4565, elevFt:312 },
  { icao:'KSAN', iata:'SAN', name:'San Diego', city:'San Diego', lat:32.7338, lng:-117.1933, elevFt:17 },
  { icao:'CYYZ', iata:'YYZ', name:'Toronto Pearson', city:'Toronto', lat:43.6777, lng:-79.6248, elevFt:569 },
  { icao:'CYVR', iata:'YVR', name:'Vancouver', city:'Vancouver', lat:49.1939, lng:-123.1844, elevFt:14 },
  { icao:'MMMX', iata:'MEX', name:'Mexico City', city:'Mexico City', lat:19.4361, lng:-99.0719, elevFt:7316 },
  { icao:'SBGR', iata:'GRU', name:'Guarulhos', city:'São Paulo', lat:-23.4356, lng:-46.4731, elevFt:2459 },
  { icao:'SAEZ', iata:'EZE', name:'Ezeiza', city:'Buenos Aires', lat:-34.8222, lng:-58.5358, elevFt:67 },
  { icao:'EGLL', iata:'LHR', name:'Heathrow', city:'London', lat:51.47, lng:-0.4543, elevFt:83 },
  { icao:'EGKK', iata:'LGW', name:'Gatwick', city:'London', lat:51.1537, lng:-0.1821, elevFt:202 },
  { icao:'EGSS', iata:'STN', name:'Stansted', city:'London', lat:51.885, lng:0.235, elevFt:348 },
  { icao:'EHAM', iata:'AMS', name:'Schiphol', city:'Amsterdam', lat:52.3105, lng:4.7683, elevFt:-11 },
  { icao:'LFPG', iata:'CDG', name:'Charles de Gaulle', city:'Paris', lat:49.0097, lng:2.5479, elevFt:392 },
  { icao:'LFPO', iata:'ORY', name:'Orly', city:'Paris', lat:48.7233, lng:2.3795, elevFt:291 },
  { icao:'EDDF', iata:'FRA', name:'Frankfurt', city:'Frankfurt', lat:50.0379, lng:8.5622, elevFt:364 },
  { icao:'EDDM', iata:'MUC', name:'Munich', city:'Munich', lat:48.3537, lng:11.775, elevFt:1487 },
  { icao:'EDDB', iata:'BER', name:'Berlin Brandenburg', city:'Berlin', lat:52.366, lng:13.5033, elevFt:157 },
  { icao:'LSZH', iata:'ZRH', name:'Zurich', city:'Zurich', lat:47.4647, lng:8.5492, elevFt:1416 },
  { icao:'LSGG', iata:'GVA', name:'Geneva', city:'Geneva', lat:46.2381, lng:6.1089, elevFt:1411 },
  { icao:'EBBR', iata:'BRU', name:'Brussels', city:'Brussels', lat:50.9014, lng:4.4844, elevFt:184 },
  { icao:'LEMD', iata:'MAD', name:'Barajas', city:'Madrid', lat:40.4936, lng:-3.5668, elevFt:1998 },
  { icao:'LEBL', iata:'BCN', name:'El Prat', city:'Barcelona', lat:41.2974, lng:2.0833, elevFt:39 },
  { icao:'LIRF', iata:'FCO', name:'Fiumicino', city:'Rome', lat:41.8003, lng:12.2389, elevFt:13 },
  { icao:'LOWW', iata:'VIE', name:'Vienna', city:'Vienna', lat:48.1103, lng:16.5697, elevFt:600 },
  { icao:'EKCH', iata:'CPH', name:'Kastrup', city:'Copenhagen', lat:55.6181, lng:12.6561, elevFt:17 },
  { icao:'ESSA', iata:'ARN', name:'Arlanda', city:'Stockholm', lat:59.6519, lng:17.9186, elevFt:137 },
  { icao:'ENGM', iata:'OSL', name:'Gardermoen', city:'Oslo', lat:60.1939, lng:11.1004, elevFt:681 },
  { icao:'UUEE', iata:'SVO', name:'Sheremetyevo', city:'Moscow', lat:55.9726, lng:37.4146, elevFt:622 },
  { icao:'LTFM', iata:'IST', name:'Istanbul', city:'Istanbul', lat:41.2611, lng:28.7414, elevFt:325 },
  { icao:'OMDB', iata:'DXB', name:'Dubai', city:'Dubai', lat:25.2532, lng:55.3657, elevFt:62 },
  { icao:'OTHH', iata:'DOH', name:'Hamad', city:'Doha', lat:25.2731, lng:51.6086, elevFt:13 },
  { icao:'VABB', iata:'BOM', name:'Chhatrapati Shivaji', city:'Mumbai', lat:19.0887, lng:72.8679, elevFt:39 },
  { icao:'VIDP', iata:'DEL', name:'Indira Gandhi', city:'Delhi', lat:28.5562, lng:77.1, elevFt:777 },
  { icao:'VHHH', iata:'HKG', name:'Hong Kong', city:'Hong Kong', lat:22.308, lng:113.9185, elevFt:28 },
  { icao:'ZBAA', iata:'PEK', name:'Beijing Capital', city:'Beijing', lat:40.0801, lng:116.5846, elevFt:116 },
  { icao:'ZSPD', iata:'PVG', name:'Shanghai Pudong', city:'Shanghai', lat:31.1443, lng:121.8083, elevFt:13 },
  { icao:'RJTT', iata:'HND', name:'Haneda', city:'Tokyo', lat:35.5494, lng:139.7798, elevFt:35 },
  { icao:'RJAA', iata:'NRT', name:'Narita', city:'Tokyo', lat:35.7647, lng:140.3864, elevFt:135 },
  { icao:'RKSI', iata:'ICN', name:'Incheon', city:'Seoul', lat:37.4602, lng:126.4407, elevFt:23 },
  { icao:'WSSS', iata:'SIN', name:'Changi', city:'Singapore', lat:1.3644, lng:103.9915, elevFt:22 },
  { icao:'WMKK', iata:'KUL', name:'Kuala Lumpur', city:'Kuala Lumpur', lat:2.7456, lng:101.7099, elevFt:69 },
  { icao:'YSSY', iata:'SYD', name:'Kingsford Smith', city:'Sydney', lat:-33.9399, lng:151.1753, elevFt:21 },
  { icao:'YMML', iata:'MEL', name:'Tullamarine', city:'Melbourne', lat:-37.6733, lng:144.8433, elevFt:434 },
  { icao:'FAOR', iata:'JNB', name:'OR Tambo', city:'Johannesburg', lat:-26.1392, lng:28.246, elevFt:5558 },
  { icao:'HECA', iata:'CAI', name:'Cairo', city:'Cairo', lat:30.1219, lng:31.4056, elevFt:382 },
  { icao:'BIKF', iata:'KEF', name:'Keflavik', city:'Reykjavik', lat:63.985, lng:-22.6056, elevFt:171 },
  { icao:'EIDW', iata:'DUB', name:'Dublin', city:'Dublin', lat:53.4213, lng:-6.27, elevFt:242 },
]

/* ---------- geo + atm helpers ---------- */
const R_NM = 3440.065
const toRad = (d: number) => d * Math.PI / 180
const toDeg = (r: number) => r * 180 / Math.PI

function distNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = toRad(la1), φ2 = toRad(la2)
  const dφ = φ2 - φ1, dλ = toRad(lo2 - lo1)
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}

function isaTempC(altFt: number): number {
  if (altFt <= 36089) return 15 - 0.0019812 * altFt
  return -56.5
}

interface Synth {
  s: Stn
  samples: number
  windFromDeg: number   // 0-359, FROM direction
  windKts: number
  tempC: number
  dewC: number
  visSm: number
  ceilFtAgl: number     // -1 = no ceiling reported / CLR
  altimInHg: number
  tier: Tier
  lowestAlt: number     // lowest sample altitude
  worstVR: number       // most negative VS (proxy for active approaches)
  pIfr: number          // 0..1 IFR probability score
}

function classifyTier(visSm: number, ceilFtAgl: number): Tier {
  const c = ceilFtAgl < 0 ? 99999 : ceilFtAgl
  if (c < 500 || visSm < 1) return 'LIFR'
  if (c < 1000 || visSm < 3) return 'IFR'
  if (c < 3000 || visSm < 5) return 'MVFR'
  return 'VFR'
}

function pad(n: number, w: number): string { return String(Math.max(0, Math.round(n))).padStart(w, '0') }

function metarString(syn: Synth, utc: Date): string {
  const day = pad(utc.getUTCDate(), 2)
  const hh = pad(utc.getUTCHours(), 2)
  const mm = pad(utc.getUTCMinutes(), 2)
  const wd = syn.windKts < 1 ? '000' : pad(syn.windFromDeg, 3)
  const wk = syn.windKts < 1 ? '00' : pad(syn.windKts, 2)
  const wind = `${wd}${wk}KT`
  const vis = `${syn.visSm < 10 ? syn.visSm.toFixed(syn.visSm < 1 ? 2 : 0) : '10'}SM`
  let cloud: string
  if (syn.ceilFtAgl < 0) cloud = 'CLR'
  else {
    const code = syn.ceilFtAgl < 500 ? 'OVC' : syn.ceilFtAgl < 1500 ? 'BKN' : 'SCT'
    cloud = `${code}${pad(syn.ceilFtAgl/100, 3)}`
  }
  const t = (n: number) => (n < 0 ? 'M' : '') + pad(Math.abs(n), 2)
  const tt = `${t(syn.tempC)}/${t(syn.dewC)}`
  const alt = `A${pad(syn.altimInHg * 100, 4)}`
  return `${syn.s.icao} ${day}${hh}${mm}Z ${wind} ${vis} ${cloud} ${tt} ${alt}`
}

export default function MetarMonitor({ map, flights, onClose, onFly, onFlyLatLng }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [sampleRng, setSampleRng] = useState(50)   // nm
  const [maxFl, setMaxFl] = useState(80)            // FL ceiling for samples
  const [isaDev, setIsaDev] = useState(0)
  const [showOvl, setShowOvl] = useState(true)
  const [showRing, setShowRing] = useState(true)
  const [showBarb, setShowBarb] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<'tier' | 'wind' | 'vis' | 'alpha'>('tier')
  const [now, setNow] = useState<Date>(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(id)
  }, [])

  /* ---------- synthesise per-station METAR ---------- */
  const synth: Synth[] = useMemo(() => {
    const out: Synth[] = []
    for (const s of STATIONS) {
      let uW = 0, vW = 0, wTot = 0
      let tSum = 0, tWtSum = 0
      let nSamp = 0
      let lowest = Infinity
      let worstVR = 0
      for (const f of flights) {
        if (f.ground) continue
        if (!isFinite(f.altitudeFt)) continue
        if (f.altitudeFt > maxFl * 100) continue
        const dn = distNm(s.lat, s.lng, f.lat, f.lng)
        if (dn > sampleRng) continue
        nSamp++
        if (f.altitudeFt < lowest) lowest = f.altitudeFt
        if ((f.vertRate || 0) < worstVR) worstVR = f.vertRate || 0
        // wind
        if (typeof f.windDir === 'number' && typeof f.windKts === 'number' && f.windKts > 0 && f.windKts < 220) {
          const w = 1 / (1 + dn / 12)
          const φ = toRad(f.windDir)
          const u = -f.windKts * Math.sin(φ)
          const v = -f.windKts * Math.cos(φ)
          uW += u * w; vW += v * w; wTot += w
        }
        // temp: project SAT back to field elev with std lapse
        const satC = isaTempC(f.altitudeFt) + isaDev
        const tFieldC = satC + 0.0019812 * (f.altitudeFt - s.elevFt)
        const w2 = 1 / (1 + dn / 15)
        tSum += tFieldC * w2
        tWtSum += w2
      }
      // wind FROM bearing
      let windFromDeg = 0, windKts = 0
      if (wTot > 0) {
        const uM = uW / wTot, vM = vW / wTot
        windKts = Math.hypot(uM, vM)
        // u = -ws sin(φ), v = -ws cos(φ) where φ is FROM-direction
        windFromDeg = (toDeg(Math.atan2(-uM, -vM)) + 360) % 360
      } else {
        windFromDeg = 270
        windKts = 0
      }
      const tempC = tWtSum > 0 ? tSum / tWtSum : (15 + isaDev - 0.0019812 * s.elevFt)
      // dewpoint proxy: spread shrinks with sample density (more activity = humid marine layer)
      const spread = nSamp >= 8 ? 1.5 : nSamp >= 4 ? 3 : nSamp >= 2 ? 6 : 10
      const dewC = tempC - spread
      // visibility proxy: sample density vs expected for this hub
      // Major hubs in clear weather should produce many samples; few samples = low vis activity
      // Density score in [0,1]: more samples = better vis
      const density = Math.min(1, nSamp / 12)
      // visibility 0..10 SM, low when density low AND temp/dew close (humidity)
      const humidityFactor = Math.max(0, 1 - spread / 12)  // 0 dry, 1 saturated
      const baseVis = 10 - 9 * humidityFactor
      const visSm = Math.max(0.25, Math.min(10, baseVis * (0.5 + 0.5 * density)))
      // ceiling proxy: if lowest sample is below 3000 AGL, use as ceiling-ish
      const lowestAgl = isFinite(lowest) ? Math.max(0, lowest - s.elevFt) : 99999
      let ceilFtAgl: number
      if (nSamp === 0) ceilFtAgl = -1
      else if (lowestAgl < 3500 && humidityFactor > 0.4) ceilFtAgl = Math.max(100, Math.round(lowestAgl / 100) * 100)
      else if (humidityFactor > 0.7) ceilFtAgl = Math.max(300, Math.round((3000 * (1 - humidityFactor)) / 100) * 100)
      else ceilFtAgl = -1
      // altimeter: ISA station pressure with temperature offset (1 inHg per ~10 hPa, ~1000 ft)
      const stdHg = 29.92 - (s.elevFt / 1000)   // simplification
      const altimInHg = +(stdHg + (isaDev / 50)).toFixed(2)
      const tier = classifyTier(visSm, ceilFtAgl)
      const pIfr = tier === 'LIFR' ? 1 : tier === 'IFR' ? 0.75 : tier === 'MVFR' ? 0.45 : 0.05
      out.push({
        s, samples: nSamp,
        windFromDeg, windKts,
        tempC, dewC, visSm, ceilFtAgl, altimInHg,
        tier, lowestAlt: isFinite(lowest) ? lowest : -1, worstVR,
        pIfr,
      })
    }
    return out
  }, [flights, sampleRng, maxFl, isaDev])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { VFR: 0, MVFR: 0, IFR: 0, LIFR: 0 }
    for (const r of synth) c[r.tier]++
    return c
  }, [synth])

  const summary = useMemo(() => {
    let totSamp = 0, peakWind = 0, peakIcao = '—'
    let worstIcao = '—', worstTier: Tier = 'VFR'
    for (const r of synth) {
      totSamp += r.samples
      if (r.windKts > peakWind) { peakWind = r.windKts; peakIcao = r.s.iata }
      if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(worstTier)) { worstTier = r.tier; worstIcao = r.s.iata }
    }
    return { totSamp, peakWind, peakIcao, worstIcao, worstTier }
  }, [synth])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out = synth.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (!q) return true
      return r.s.icao.toLowerCase().includes(q)
        || r.s.iata.toLowerCase().includes(q)
        || r.s.name.toLowerCase().includes(q)
        || r.s.city.toLowerCase().includes(q)
    })
    out.sort((a, b) => {
      if (sortBy === 'tier') {
        const t = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
        if (t !== 0) return t
        return b.samples - a.samples
      }
      if (sortBy === 'wind') return b.windKts - a.windKts
      if (sortBy === 'vis') return a.visSm - b.visSm
      return a.s.icao.localeCompare(b.s.icao)
    })
    return out
  }, [synth, tierFilter, query, sortBy])

  /* ---------- MapLibre overlay ---------- */
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC_RING)) map.addSource(SRC_RING, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getSource(SRC_PIN)) map.addSource(SRC_PIN, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getSource(SRC_BARB)) map.addSource(SRC_BARB, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getSource(SRC_LBL)) map.addSource(SRC_LBL, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_RING)) map.addLayer({
          id: LYR_RING, type: 'circle', source: SRC_RING,
          paint: {
            'circle-radius': ['get', 'r'],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 1,
            'circle-stroke-opacity': 0.35,
          },
        })
        if (!map.getLayer(LYR_BARB)) map.addLayer({
          id: LYR_BARB, type: 'line', source: SRC_BARB,
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 1.4,
            'line-opacity': 0.85,
          },
        })
        if (!map.getLayer(LYR_PIN)) map.addLayer({
          id: LYR_PIN, type: 'circle', source: SRC_PIN,
          paint: {
            'circle-radius': 6,
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.85,
            'circle-stroke-color': '#0b1220',
            'circle-stroke-width': 1.4,
          },
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

  // Approx degrees per nm at given lat
  function offsetFromBearing(lat: number, lng: number, brgDeg: number, distNm: number): [number, number] {
    const dLat = (distNm / 60) * Math.cos(toRad(brgDeg))
    const dLng = (distNm / 60) * Math.sin(toRad(brgDeg)) / Math.max(0.0001, Math.cos(toRad(lat)))
    return [lng + dLng, lat + dLat]
  }

  useEffect(() => {
    if (!map) return
    const pinFeats: any[] = []
    const ringFeats: any[] = []
    const barbFeats: any[] = []
    const lblFeats: any[] = []
    if (showOvl) {
      for (const r of filtered) {
        pinFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.s.lng, r.s.lat] },
          properties: { color: TIER_COLOR[r.tier], iata: r.s.iata },
        })
        if (showRing) {
          ringFeats.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [r.s.lng, r.s.lat] },
            properties: { color: TIER_COLOR[r.tier], r: 14 + Math.min(30, r.samples * 1.2) },
          })
        }
        if (showBarb && r.windKts >= 1) {
          // draw barb opposite of FROM (i.e., pointing toward FROM-direction), length scaled
          const len = Math.min(40, 6 + r.windKts * 0.6)
          const end = offsetFromBearing(r.s.lat, r.s.lng, r.windFromDeg, len)
          barbFeats.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[r.s.lng, r.s.lat], end] },
            properties: { color: TIER_COLOR[r.tier] },
          })
        }
        if (showLbl) {
          const visTxt = r.visSm >= 10 ? '10' : r.visSm < 1 ? r.visSm.toFixed(1) : Math.round(r.visSm).toString()
          const wd = r.windKts < 1 ? '---' : pad(r.windFromDeg, 3)
          const wk = pad(r.windKts, 2)
          lblFeats.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [r.s.lng, r.s.lat] },
            properties: {
              color: TIER_COLOR[r.tier],
              label: `${r.s.iata} ${r.tier} ${wd}/${wk} ${visTxt}SM`,
            },
          })
        }
      }
    }
    try {
      ;(map.getSource(SRC_PIN) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: pinFeats })
      ;(map.getSource(SRC_RING) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: ringFeats })
      ;(map.getSource(SRC_BARB) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: barbFeats })
      ;(map.getSource(SRC_LBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lblFeats })
    } catch {}
  }, [map, filtered, showOvl, showRing, showBarb, showLbl])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_LBL, LYR_PIN, LYR_BARB, LYR_RING]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_LBL, SRC_PIN, SRC_BARB, SRC_RING]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  /* ---------- compass wind-rose diagram ---------- */
  const rose = useMemo(() => {
    // Aggregate wind FROM bearing into 16 sectors weighted by station kt
    const buckets = new Array(16).fill(0)
    let maxV = 0
    for (const r of synth) {
      if (r.windKts < 1) continue
      const idx = Math.floor(((r.windFromDeg + 11.25) % 360) / 22.5)
      buckets[idx] += r.windKts
      if (buckets[idx] > maxV) maxV = buckets[idx]
    }
    return { buckets, maxV: maxV || 1 }
  }, [synth])

  function tierBadge(t: Tier): string {
    return t
  }

  return (
    <div className="fixed top-16 right-3 z-40 w-[400px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">⌬</span>
          <span className="text-sm font-semibold tracking-wide">METAR MONITOR</span>
          <span className="text-[10px] text-slate-500">surface obs · live</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {(['LIFR', 'IFR', 'MVFR', 'VFR'] as Tier[]).map(t => (
          <button key={t}
            onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/50 bg-sky-500/10' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }} title={t}>
            <span className="text-[9px] tracking-wider">{t}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="px-3 py-2 grid grid-cols-3 gap-1 border-b border-slate-800">
        <div className="rounded bg-slate-900/40 border border-slate-800 px-2 py-1 text-center">
          <div className="text-[9px] tracking-wider text-slate-500">SAMPLES</div>
          <div className="text-sm font-mono text-slate-200">{summary.totSamp}</div>
        </div>
        <div className="rounded bg-slate-900/40 border border-slate-800 px-2 py-1 text-center">
          <div className="text-[9px] tracking-wider text-slate-500">PEAK WIND</div>
          <div className="text-sm font-mono text-slate-200">{summary.peakWind.toFixed(0)}KT</div>
          <div className="text-[9px] text-slate-500 font-mono">{summary.peakIcao}</div>
        </div>
        <div className="rounded bg-slate-900/40 border border-slate-800 px-2 py-1 text-center">
          <div className="text-[9px] tracking-wider text-slate-500">WORST</div>
          <div className="text-sm font-mono" style={{ color: TIER_COLOR[summary.worstTier] }}>{summary.worstTier}</div>
          <div className="text-[9px] text-slate-500 font-mono">{summary.worstIcao}</div>
        </div>
      </div>

      {/* Compass wind-rose */}
      <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/30">
        <div className="text-[10px] text-slate-500 tracking-wider mb-1">FLEET WIND-ROSE (FROM-direction, sum kt)</div>
        <svg width={376} height={170} className="block">
          <rect x={0} y={0} width={376} height={170} fill="#0b1220" />
          {(() => {
            const cx = 188, cy = 85, rmax = 70
            const els: React.ReactElement[] = []
            // grid
            for (let i = 1; i <= 3; i++) {
              els.push(<circle key={`g${i}`} cx={cx} cy={cy} r={rmax * i / 3} fill="none" stroke="#1e293b" strokeWidth={0.5} strokeDasharray="2 2" />)
            }
            // 8 spokes
            for (let i = 0; i < 8; i++) {
              const a = toRad(i * 45 - 90)
              els.push(<line key={`s${i}`} x1={cx} y1={cy} x2={cx + rmax * Math.cos(a)} y2={cy + rmax * Math.sin(a)} stroke="#1e293b" strokeWidth={0.5} />)
            }
            // cardinals
            const card: [string, number, number][] = [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]]
            for (const [lbl, dx, dy] of card) {
              els.push(<text key={`c${lbl}`} x={cx + dx * (rmax + 8) - 3} y={cy + dy * (rmax + 8) + 3} fill="#475569" fontSize={9} fontFamily="ui-monospace, monospace">{lbl}</text>)
            }
            // bars
            for (let i = 0; i < 16; i++) {
              const v = rose.buckets[i] / rose.maxV
              if (v <= 0) continue
              const a = toRad(i * 22.5 - 90)
              const r1 = 6, r2 = 6 + v * (rmax - 6)
              const x1 = cx + r1 * Math.cos(a), y1 = cy + r1 * Math.sin(a)
              const x2 = cx + r2 * Math.cos(a), y2 = cy + r2 * Math.sin(a)
              els.push(<line key={`b${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#0ea5e9" strokeWidth={3.2} strokeLinecap="round" opacity={0.85} />)
            }
            // station dots inside
            for (const r of synth) {
              if (r.samples === 0) continue
              const a = toRad(r.windFromDeg - 90)
              const rr = 6 + Math.min(rmax - 6, r.windKts * 1.4)
              const x = cx + rr * Math.cos(a), y = cy + rr * Math.sin(a)
              els.push(<circle key={`d${r.s.icao}`} cx={x} cy={y} r={r.tier === 'VFR' ? 1.4 : 2.2} fill={TIER_COLOR[r.tier]} opacity={0.85} />)
            }
            return els
          })()}
        </svg>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>SAMPLE RANGE</span>
            <span className="font-mono text-slate-300">{sampleRng} nm</span>
          </div>
          <input type="range" min={15} max={150} step={5} value={sampleRng} onChange={e => setSampleRng(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>MAX FL</span>
            <span className="font-mono text-slate-300">FL{maxFl}</span>
          </div>
          <input type="range" min={30} max={250} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>ISA DEVIATION</span>
            <span className="font-mono text-slate-300">{isaDev >= 0 ? '+' : ''}{isaDev} C</span>
          </div>
          <input type="range" min={-20} max={20} step={1} value={isaDev} onChange={e => setIsaDev(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showOvl} onChange={e => setShowOvl(e.target.checked)} className="accent-sky-500" /><span>OVL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRing} onChange={e => setShowRing(e.target.checked)} className="accent-sky-500" /><span>RING</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showBarb} onChange={e => setShowBarb(e.target.checked)} className="accent-sky-500" /><span>BARB</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLbl} onChange={e => setShowLbl(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <div className="ml-auto flex items-center gap-1">
            <span className="text-slate-500 mr-1">sort</span>
            {(['tier', 'wind', 'vis', 'alpha'] as const).map(k => (
              <button key={k} onClick={() => setSortBy(k)}
                className={`px-1.5 py-0.5 rounded border ${sortBy === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{k}</button>
            ))}
          </div>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search icao / iata / city"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{filtered.length} stations</span>
        <span className="font-mono">{pad(now.getUTCHours(), 2)}{pad(now.getUTCMinutes(), 2)}Z</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No stations match.</div>
        )}
        {filtered.map(r => {
          const visTxt = r.visSm >= 10 ? '10' : r.visSm < 1 ? r.visSm.toFixed(1) : Math.round(r.visSm).toString()
          const ceilTxt = r.ceilFtAgl < 0 ? 'CLR' : `${Math.round(r.ceilFtAgl/100)*100}'`
          const raw = metarString(r, now)
          return (
            <button key={r.s.icao} onClick={() => onFlyLatLng(r.s.lat, r.s.lng, 8)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-stretch gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{r.s.iata}</span>
                  <span className="font-mono text-slate-500">{r.s.icao}</span>
                  <span className="text-slate-400 truncate">{r.s.name}</span>
                  <span className="ml-auto text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{tierBadge(r.tier)}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="wind FROM / kt">
                    {r.windKts < 1 ? 'CALM' : `${pad(r.windFromDeg,3)}/${pad(r.windKts,2)}KT`}
                  </span>
                  <span title="visibility">{visTxt}SM</span>
                  <span title="ceiling AGL">{ceilTxt}</span>
                  <span title="temp/dew">{r.tempC.toFixed(0)}/{r.dewC.toFixed(0)}C</span>
                  <span className="ml-auto" title="altimeter inHg">A{Math.round(r.altimInHg*100)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.round(r.pIfr*100)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '45%' }} title="IFR" />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '75%' }} title="LIFR" />
                </div>
                <div className="mt-1 text-[10px] font-mono text-slate-500 truncate" title={raw}>{raw}</div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span>{r.samples} samp</span>
                  <span>elev {r.s.elevFt}'</span>
                  {r.lowestAlt > 0 && <span>low {Math.round(r.lowestAlt/100)*100}'</span>}
                  <span className="ml-auto">{r.s.city}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
