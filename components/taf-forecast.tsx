'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TAF Forecast Panel
   ------------------------------------------------------------
   Synthesises a Terminal Aerodrome Forecast (TAF) covering the
   next 24 hours in 6 four-hour FM (FROM) periods for 40 major
   hubs worldwide by extrapolating the current ADS-B-derived
   surface picture (wind / temp / vis / ceiling) along the
   prevailing wind axis using a Lagrangian upwind sampling
   technique:

     1. Current obs: aggregate every airborne aircraft within
        SAMPLE-RNG nm and below MAX-FL ceiling exactly like the
        METAR Monitor (inverse-range-weighted u/v mean wind,
        ISA-lapsed SAT, humidity-spread dewpoint, sample-density
        visibility, lowest-sample ceiling proxy).

     2. Upwind trace: for every forecast offset Δt (4 / 8 / 12 /
        16 / 20 / 24 h) we shift the sampling cell UPWIND by
        windKts * Δt nm along the (windFrom) bearing. That cell
        is then sampled with the same algorithm — the result is
        what the airmass arriving over the field at T+Δt looked
        like UPWIND right now, i.e. a Lagrangian forecast.

     3. Diurnal modulation: temperature is cosine-modulated with
        a 24h period (peak local 14L / trough 04L) of amplitude
        DIURNAL-AMP slider (default 6C), dewpoint tracks half
        that amplitude so spread closes at night → fog risk.

     4. Trend smoothing: 0.7 * upwindSnapshot + 0.3 * currentObs
        prevents pinpoint anomalies (one stray aircraft 200nm
        upwind) from owning the forecast.

   FROM-period FAA category classification (VFR / MVFR / IFR /
   LIFR) reuses the METAR ladder. Tier deterioration vs current
   triggers BECMG / TEMPO annotations:

     BECMG  category-shift sustained 2+ periods   amber
     TEMPO  category-shift single period          yellow
     PROB30 marginal (close to threshold) shift   sky

   Per airport we compute:
     - 24h worst tier (drives the row colour)
     - Time-to-deterioration (first FM period worse than current)
     - Time-to-improvement
     - Composite TAF string in standard format
     - Confidence index from sample-count stability across cells

   Overlay paints tier-coloured airport pin (sized by worst-tier),
   dashed upwind sampling arrow + waypoint dots for every active
   FM offset, and timeline-strip label.

   Side panel:
     - Picker: 4-tier counter strip, 3-cell BECMG-COUNT /
       TEMPO-COUNT / MEAN-CONF summary
     - 6-band SVG timeline diagram (Y = top-12 stations sorted by
       worst tier, X = T+0..T+24 in 4h bins, every cell coloured
       to its forecast tier, hover shows BECMG/TEMPO/PROB ribbon)
     - 4 sliders (SAMPLE-RNG nm / MAX-FL / ISA-DEV C / DIURNAL-AMP)
     - OVL/PIN/UPWIND/LBL toggles, search box
     - Per-airport row with tier color stripe, IATA+ICAO+name+
       worst-tier pill, six 4h forecast pills (tier-coloured), TAF
       string, confidence bar
   ============================================================ */

const SRC_PIN = 'taf-pin-src'
const LYR_PIN = 'taf-pin-lyr'
const SRC_UP = 'taf-up-src'
const LYR_UP = 'taf-up-lyr'
const SRC_DOT = 'taf-dot-src'
const LYR_DOT = 'taf-dot-lyr'
const SRC_LBL = 'taf-lbl-src'
const LYR_LBL = 'taf-lbl-lyr'

export interface TafFlight {
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
  flights: TafFlight[]
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
const TIER_RANK: Record<Tier, number> = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 }
const TIER_ORDER: Tier[] = ['LIFR', 'IFR', 'MVFR', 'VFR']

interface Stn {
  icao: string
  iata: string
  name: string
  city: string
  lat: number
  lng: number
  elevFt: number
  tzOffsetH: number   // local time offset for diurnal modulation
}

const STATIONS: Stn[] = [
  { icao:'KATL', iata:'ATL', name:'Hartsfield-Jackson', city:'Atlanta', lat:33.6407, lng:-84.4277, elevFt:1026, tzOffsetH:-5 },
  { icao:'KORD', iata:'ORD', name:"O'Hare", city:'Chicago', lat:41.9786, lng:-87.9048, elevFt:672, tzOffsetH:-6 },
  { icao:'KDFW', iata:'DFW', name:'Dallas/Fort Worth', city:'Dallas', lat:32.8998, lng:-97.0403, elevFt:607, tzOffsetH:-6 },
  { icao:'KDEN', iata:'DEN', name:'Denver', city:'Denver', lat:39.8617, lng:-104.6731, elevFt:5431, tzOffsetH:-7 },
  { icao:'KLAX', iata:'LAX', name:'Los Angeles', city:'Los Angeles', lat:33.9416, lng:-118.4085, elevFt:128, tzOffsetH:-8 },
  { icao:'KJFK', iata:'JFK', name:'John F Kennedy', city:'New York', lat:40.6413, lng:-73.7781, elevFt:13, tzOffsetH:-5 },
  { icao:'KSFO', iata:'SFO', name:'San Francisco', city:'San Francisco', lat:37.6213, lng:-122.379, elevFt:13, tzOffsetH:-8 },
  { icao:'KSEA', iata:'SEA', name:'Seattle-Tacoma', city:'Seattle', lat:47.4502, lng:-122.3088, elevFt:432, tzOffsetH:-8 },
  { icao:'KLAS', iata:'LAS', name:'Harry Reid', city:'Las Vegas', lat:36.084, lng:-115.1537, elevFt:2181, tzOffsetH:-8 },
  { icao:'KMIA', iata:'MIA', name:'Miami', city:'Miami', lat:25.7959, lng:-80.287, elevFt:8, tzOffsetH:-5 },
  { icao:'KEWR', iata:'EWR', name:'Newark', city:'Newark', lat:40.6895, lng:-74.1745, elevFt:18, tzOffsetH:-5 },
  { icao:'KBOS', iata:'BOS', name:'Logan', city:'Boston', lat:42.3656, lng:-71.0096, elevFt:20, tzOffsetH:-5 },
  { icao:'KPHX', iata:'PHX', name:'Sky Harbor', city:'Phoenix', lat:33.4373, lng:-112.0078, elevFt:1135, tzOffsetH:-7 },
  { icao:'KIAH', iata:'IAH', name:'George Bush', city:'Houston', lat:29.9902, lng:-95.3368, elevFt:97, tzOffsetH:-6 },
  { icao:'KMSP', iata:'MSP', name:'Minneapolis-St Paul', city:'Minneapolis', lat:44.8848, lng:-93.2223, elevFt:841, tzOffsetH:-6 },
  { icao:'KIAD', iata:'IAD', name:'Dulles', city:'Washington', lat:38.9531, lng:-77.4565, elevFt:312, tzOffsetH:-5 },
  { icao:'KSAN', iata:'SAN', name:'San Diego', city:'San Diego', lat:32.7338, lng:-117.1933, elevFt:17, tzOffsetH:-8 },
  { icao:'CYYZ', iata:'YYZ', name:'Toronto Pearson', city:'Toronto', lat:43.6777, lng:-79.6248, elevFt:569, tzOffsetH:-5 },
  { icao:'CYVR', iata:'YVR', name:'Vancouver', city:'Vancouver', lat:49.1939, lng:-123.1844, elevFt:14, tzOffsetH:-8 },
  { icao:'MMMX', iata:'MEX', name:'Mexico City', city:'Mexico City', lat:19.4361, lng:-99.0719, elevFt:7316, tzOffsetH:-6 },
  { icao:'SBGR', iata:'GRU', name:'Guarulhos', city:'São Paulo', lat:-23.4356, lng:-46.4731, elevFt:2459, tzOffsetH:-3 },
  { icao:'SAEZ', iata:'EZE', name:'Ezeiza', city:'Buenos Aires', lat:-34.8222, lng:-58.5358, elevFt:67, tzOffsetH:-3 },
  { icao:'EGLL', iata:'LHR', name:'Heathrow', city:'London', lat:51.47, lng:-0.4543, elevFt:83, tzOffsetH:0 },
  { icao:'EGKK', iata:'LGW', name:'Gatwick', city:'London', lat:51.1537, lng:-0.1821, elevFt:202, tzOffsetH:0 },
  { icao:'EHAM', iata:'AMS', name:'Schiphol', city:'Amsterdam', lat:52.3105, lng:4.7683, elevFt:-11, tzOffsetH:1 },
  { icao:'LFPG', iata:'CDG', name:'Charles de Gaulle', city:'Paris', lat:49.0097, lng:2.5479, elevFt:392, tzOffsetH:1 },
  { icao:'EDDF', iata:'FRA', name:'Frankfurt', city:'Frankfurt', lat:50.0379, lng:8.5622, elevFt:364, tzOffsetH:1 },
  { icao:'EDDM', iata:'MUC', name:'Munich', city:'Munich', lat:48.3537, lng:11.775, elevFt:1487, tzOffsetH:1 },
  { icao:'LSZH', iata:'ZRH', name:'Zurich', city:'Zurich', lat:47.4647, lng:8.5492, elevFt:1416, tzOffsetH:1 },
  { icao:'LEMD', iata:'MAD', name:'Barajas', city:'Madrid', lat:40.4936, lng:-3.5668, elevFt:1998, tzOffsetH:1 },
  { icao:'LIRF', iata:'FCO', name:'Fiumicino', city:'Rome', lat:41.8003, lng:12.2389, elevFt:13, tzOffsetH:1 },
  { icao:'LOWW', iata:'VIE', name:'Vienna', city:'Vienna', lat:48.1103, lng:16.5697, elevFt:600, tzOffsetH:1 },
  { icao:'EKCH', iata:'CPH', name:'Kastrup', city:'Copenhagen', lat:55.6181, lng:12.6561, elevFt:17, tzOffsetH:1 },
  { icao:'OMDB', iata:'DXB', name:'Dubai', city:'Dubai', lat:25.2532, lng:55.3657, elevFt:62, tzOffsetH:4 },
  { icao:'VABB', iata:'BOM', name:'Chhatrapati Shivaji', city:'Mumbai', lat:19.0887, lng:72.8679, elevFt:39, tzOffsetH:5.5 },
  { icao:'VHHH', iata:'HKG', name:'Hong Kong', city:'Hong Kong', lat:22.308, lng:113.9185, elevFt:28, tzOffsetH:8 },
  { icao:'RJTT', iata:'HND', name:'Haneda', city:'Tokyo', lat:35.5494, lng:139.7798, elevFt:35, tzOffsetH:9 },
  { icao:'RKSI', iata:'ICN', name:'Incheon', city:'Seoul', lat:37.4602, lng:126.4407, elevFt:23, tzOffsetH:9 },
  { icao:'WSSS', iata:'SIN', name:'Changi', city:'Singapore', lat:1.3644, lng:103.9915, elevFt:22, tzOffsetH:8 },
  { icao:'YSSY', iata:'SYD', name:'Kingsford Smith', city:'Sydney', lat:-33.9399, lng:151.1753, elevFt:21, tzOffsetH:10 },
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

function offsetLL(lat: number, lng: number, brgDeg: number, distNmIn: number): [number, number] {
  const dLat = (distNmIn / 60) * Math.cos(toRad(brgDeg))
  const dLng = (distNmIn / 60) * Math.sin(toRad(brgDeg)) / Math.max(0.0001, Math.cos(toRad(lat)))
  return [lat + dLat, lng + dLng]
}

function isaTempC(altFt: number): number {
  if (altFt <= 36089) return 15 - 0.0019812 * altFt
  return -56.5
}

interface CellSample {
  samples: number
  windFromDeg: number
  windKts: number
  tempC: number
  dewC: number
  visSm: number
  ceilFtAgl: number
  humidity: number
}

function sampleCell(
  flights: TafFlight[],
  centerLat: number,
  centerLng: number,
  fieldElev: number,
  sampleRng: number,
  maxFl: number,
  isaDev: number,
): CellSample {
  let uW = 0, vW = 0, wTot = 0
  let tSum = 0, tWtSum = 0
  let nSamp = 0
  let lowest = Infinity
  for (const f of flights) {
    if (f.ground) continue
    if (!isFinite(f.altitudeFt)) continue
    if (f.altitudeFt > maxFl * 100) continue
    const dn = distNm(centerLat, centerLng, f.lat, f.lng)
    if (dn > sampleRng) continue
    nSamp++
    if (f.altitudeFt < lowest) lowest = f.altitudeFt
    if (typeof f.windDir === 'number' && typeof f.windKts === 'number' && f.windKts > 0 && f.windKts < 220) {
      const w = 1 / (1 + dn / 12)
      const φ = toRad(f.windDir)
      const u = -f.windKts * Math.sin(φ)
      const v = -f.windKts * Math.cos(φ)
      uW += u * w; vW += v * w; wTot += w
    }
    const satC = isaTempC(f.altitudeFt) + isaDev
    const tFieldC = satC + 0.0019812 * (f.altitudeFt - fieldElev)
    const w2 = 1 / (1 + dn / 15)
    tSum += tFieldC * w2
    tWtSum += w2
  }
  let windFromDeg = 270, windKts = 0
  if (wTot > 0) {
    const uM = uW / wTot, vM = vW / wTot
    windKts = Math.hypot(uM, vM)
    windFromDeg = (toDeg(Math.atan2(-uM, -vM)) + 360) % 360
  }
  const tempC = tWtSum > 0 ? tSum / tWtSum : (15 + isaDev - 0.0019812 * fieldElev)
  const spread = nSamp >= 8 ? 1.5 : nSamp >= 4 ? 3 : nSamp >= 2 ? 6 : 10
  const dewC = tempC - spread
  const density = Math.min(1, nSamp / 12)
  const humidity = Math.max(0, 1 - spread / 12)
  const baseVis = 10 - 9 * humidity
  const visSm = Math.max(0.25, Math.min(10, baseVis * (0.5 + 0.5 * density)))
  const lowestAgl = isFinite(lowest) ? Math.max(0, lowest - fieldElev) : 99999
  let ceilFtAgl: number
  if (nSamp === 0) ceilFtAgl = -1
  else if (lowestAgl < 3500 && humidity > 0.4) ceilFtAgl = Math.max(100, Math.round(lowestAgl / 100) * 100)
  else if (humidity > 0.7) ceilFtAgl = Math.max(300, Math.round((3000 * (1 - humidity)) / 100) * 100)
  else ceilFtAgl = -1
  return { samples: nSamp, windFromDeg, windKts, tempC, dewC, visSm, ceilFtAgl, humidity }
}

function classifyTier(visSm: number, ceilFtAgl: number): Tier {
  const c = ceilFtAgl < 0 ? 99999 : ceilFtAgl
  if (c < 500 || visSm < 1) return 'LIFR'
  if (c < 1000 || visSm < 3) return 'IFR'
  if (c < 3000 || visSm < 5) return 'MVFR'
  return 'VFR'
}

function pad(n: number, w: number): string { return String(Math.max(0, Math.round(n))).padStart(w, '0') }

interface FmPeriod {
  offsetH: number
  cell: CellSample
  blended: CellSample
  tier: Tier
  annotation: '' | 'BECMG' | 'TEMPO' | 'PROB30'
}

interface Synth {
  s: Stn
  current: CellSample
  currentTier: Tier
  fms: FmPeriod[]
  worstTier: Tier
  becmgCount: number
  tempoCount: number
  detIdx: number    // first deterioration period index (-1 none)
  impIdx: number
  conf: number      // 0-1 confidence from sample stability
  tafString: string
}

const OFFSETS = [4, 8, 12, 16, 20, 24]

function diurnalDelta(localHour: number, amp: number): number {
  // peak 14L, trough 04L. Use cosine with period 24, max at h=14.
  const θ = (2 * Math.PI * (localHour - 14)) / 24
  return amp * Math.cos(θ)
}

function tafPeriodString(off: number, fm: FmPeriod): string {
  const wd = fm.cell.windKts < 1 ? '00000' : `${pad(fm.cell.windFromDeg, 3)}${pad(fm.cell.windKts, 2)}KT`
  const vis = fm.cell.visSm >= 10 ? '10' : fm.cell.visSm < 1 ? fm.cell.visSm.toFixed(2) : Math.round(fm.cell.visSm).toString()
  let cloud: string
  if (fm.cell.ceilFtAgl < 0) cloud = 'SKC'
  else {
    const code = fm.cell.ceilFtAgl < 500 ? 'OVC' : fm.cell.ceilFtAgl < 1500 ? 'BKN' : 'SCT'
    cloud = `${code}${pad(fm.cell.ceilFtAgl/100, 3)}`
  }
  const hh = pad(off, 2)
  const prefix = fm.annotation || `FM${hh}00`
  return `${prefix} ${wd} ${vis}SM ${cloud}`
}

function buildTafString(s: Stn, synth: Synth, utc: Date): string {
  const day = pad(utc.getUTCDate(), 2)
  const hh = pad(utc.getUTCHours(), 2)
  const validFrom = `${day}${hh}`
  const endDay = pad(((utc.getUTCDate()) + (utc.getUTCHours() >= 0 ? 1 : 0)), 2)
  const validTo = `${endDay}${hh}`
  const head = `TAF ${s.icao} ${validFrom}00Z ${validFrom}/${validTo}`
  const cur = synth.current
  const curWd = cur.windKts < 1 ? '00000' : `${pad(cur.windFromDeg, 3)}${pad(cur.windKts, 2)}KT`
  const curVis = cur.visSm >= 10 ? '10' : cur.visSm < 1 ? cur.visSm.toFixed(2) : Math.round(cur.visSm).toString()
  const curCloud = cur.ceilFtAgl < 0 ? 'SKC' : `${cur.ceilFtAgl < 500 ? 'OVC' : cur.ceilFtAgl < 1500 ? 'BKN' : 'SCT'}${pad(cur.ceilFtAgl/100, 3)}`
  const initial = `${curWd} ${curVis}SM ${curCloud}`
  const lines: string[] = [`${head} ${initial}`]
  for (let i = 0; i < synth.fms.length; i++) {
    const fm = synth.fms[i]
    if (i > 0 && fm.tier === synth.fms[i-1].tier && !fm.annotation) continue
    lines.push(tafPeriodString(OFFSETS[i], fm))
  }
  return lines.join(' ')
}

export default function TafForecast({ map, flights, onClose, onFlyLatLng }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [sampleRng, setSampleRng] = useState(60)
  const [maxFl, setMaxFl] = useState(90)
  const [isaDev, setIsaDev] = useState(0)
  const [diurnalAmp, setDiurnalAmp] = useState(6)
  const [showOvl, setShowOvl] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showUp, setShowUp] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<'tier' | 'det' | 'conf' | 'alpha'>('tier')
  const [now, setNow] = useState<Date>(() => new Date())
  const [hoverCell, setHoverCell] = useState<{ icao: string; idx: number } | null>(null)

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(id)
  }, [])

  const synth: Synth[] = useMemo(() => {
    const out: Synth[] = []
    const utcH = now.getUTCHours() + now.getUTCMinutes() / 60
    for (const s of STATIONS) {
      const current = sampleCell(flights, s.lat, s.lng, s.elevFt, sampleRng, maxFl, isaDev)
      const currentTier = classifyTier(current.visSm, current.ceilFtAgl)

      const fms: FmPeriod[] = []
      let prevTier: Tier = currentTier
      let stableShift: Tier | null = null
      let stableShiftCount = 0
      const sampleHistory: number[] = [current.samples]
      for (let i = 0; i < OFFSETS.length; i++) {
        const off = OFFSETS[i]
        // Upwind shift: along windFromDeg by windKts*off nm
        const driftNm = Math.min(900, Math.max(20, current.windKts * off))
        const [ulat, ulng] = offsetLL(s.lat, s.lng, current.windFromDeg, driftNm)
        const upwind = sampleCell(flights, ulat, ulng, s.elevFt, sampleRng, maxFl, isaDev)
        // Blend 0.7 upwind + 0.3 current (or 1.0 current if upwind empty)
        const wU = upwind.samples > 0 ? 0.7 : 0
        const wC = 1 - wU
        const blended: CellSample = {
          samples: upwind.samples,
          windFromDeg: wU > 0
            ? (() => {
                const fU = toRad(upwind.windFromDeg), fC = toRad(current.windFromDeg)
                const uU = -upwind.windKts * Math.sin(fU), vU = -upwind.windKts * Math.cos(fU)
                const uC = -current.windKts * Math.sin(fC), vC = -current.windKts * Math.cos(fC)
                const um = wU*uU + wC*uC, vm = wU*vU + wC*vC
                return (toDeg(Math.atan2(-um, -vm)) + 360) % 360
              })()
            : current.windFromDeg,
          windKts: wU * upwind.windKts + wC * current.windKts,
          tempC: wU * upwind.tempC + wC * current.tempC,
          dewC: wU * upwind.dewC + wC * current.dewC,
          visSm: wU * upwind.visSm + wC * current.visSm,
          ceilFtAgl: upwind.ceilFtAgl < 0 && current.ceilFtAgl < 0 ? -1
            : (wU * Math.max(0, upwind.ceilFtAgl) + wC * Math.max(0, current.ceilFtAgl)),
          humidity: wU * upwind.humidity + wC * current.humidity,
        }
        // Diurnal modulation
        const localH = ((utcH + s.tzOffsetH + off) % 24 + 24) % 24
        const dT = diurnalDelta(localH, diurnalAmp)
        const dT0 = diurnalDelta(((utcH + s.tzOffsetH) % 24 + 24) % 24, diurnalAmp)
        const baseShift = dT - dT0
        blended.tempC += baseShift
        blended.dewC += baseShift * 0.5
        // Recompute humidity from new spread; rise of dewpoint relative to temp closes spread at night
        const newSpread = Math.max(0.5, blended.tempC - blended.dewC)
        blended.humidity = Math.max(0, Math.min(1, 1 - newSpread / 12))
        // Night fog risk: if local hour 02-08 AND humidity > 0.6 AND current ceiling exists or marginal vis
        const isNight = localH >= 2 && localH <= 8
        if (isNight && blended.humidity > 0.62) {
          blended.visSm = Math.min(blended.visSm, 4 - blended.humidity * 3)
          blended.visSm = Math.max(0.25, blended.visSm)
          if (blended.ceilFtAgl < 0 || blended.ceilFtAgl > 1500) blended.ceilFtAgl = Math.max(200, 1200 - blended.humidity * 1200)
        }
        const tier = classifyTier(blended.visSm, blended.ceilFtAgl)
        let annotation: FmPeriod['annotation'] = ''
        const rankShift = TIER_RANK[tier] - TIER_RANK[prevTier]
        if (rankShift !== 0) {
          if (stableShift === tier) {
            stableShiftCount++
            if (stableShiftCount >= 1) annotation = 'BECMG'
          } else {
            stableShift = tier
            stableShiftCount = 0
            annotation = 'TEMPO'
          }
        } else {
          // marginal proximity to threshold
          const c = blended.ceilFtAgl < 0 ? 99999 : blended.ceilFtAgl
          const nearMvfr = c > 3000 && c < 3400
          const nearIfr = c > 1000 && c < 1200
          const nearLifr = c > 500 && c < 600
          if (nearMvfr || nearIfr || nearLifr) annotation = 'PROB30'
        }
        fms.push({ offsetH: off, cell: blended, blended, tier, annotation })
        prevTier = tier
        sampleHistory.push(blended.samples)
      }

      let worstTier: Tier = currentTier
      let detIdx = -1, impIdx = -1
      let becmgCount = 0, tempoCount = 0
      for (let i = 0; i < fms.length; i++) {
        if (TIER_RANK[fms[i].tier] > TIER_RANK[worstTier]) worstTier = fms[i].tier
        if (detIdx < 0 && TIER_RANK[fms[i].tier] > TIER_RANK[currentTier]) detIdx = i
        if (impIdx < 0 && TIER_RANK[fms[i].tier] < TIER_RANK[currentTier]) impIdx = i
        if (fms[i].annotation === 'BECMG') becmgCount++
        if (fms[i].annotation === 'TEMPO') tempoCount++
      }
      // Confidence from sample stability
      const meanS = sampleHistory.reduce((a, b) => a + b, 0) / sampleHistory.length
      const varS = sampleHistory.reduce((a, b) => a + (b - meanS) ** 2, 0) / sampleHistory.length
      const cv = meanS > 0 ? Math.sqrt(varS) / meanS : 1.5
      const conf = Math.max(0, Math.min(1, 1 - cv * 0.6)) * Math.min(1, meanS / 4)

      const syn: Synth = {
        s, current, currentTier, fms,
        worstTier, becmgCount, tempoCount, detIdx, impIdx, conf,
        tafString: '',
      }
      syn.tafString = buildTafString(s, syn, now)
      out.push(syn)
    }
    return out
  }, [flights, sampleRng, maxFl, isaDev, diurnalAmp, now])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { VFR: 0, MVFR: 0, IFR: 0, LIFR: 0 }
    for (const r of synth) c[r.worstTier]++
    return c
  }, [synth])

  const summary = useMemo(() => {
    let bec = 0, tem = 0, confSum = 0, n = 0
    for (const r of synth) {
      bec += r.becmgCount
      tem += r.tempoCount
      if (r.current.samples > 0) { confSum += r.conf; n++ }
    }
    return { bec, tem, meanConf: n ? confSum / n : 0, sampledN: n }
  }, [synth])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out = synth.filter(r => {
      if (tierFilter !== 'ALL' && r.worstTier !== tierFilter) return false
      if (!q) return true
      return r.s.icao.toLowerCase().includes(q)
        || r.s.iata.toLowerCase().includes(q)
        || r.s.name.toLowerCase().includes(q)
        || r.s.city.toLowerCase().includes(q)
    })
    out.sort((a, b) => {
      if (sortBy === 'tier') {
        const t = TIER_ORDER.indexOf(a.worstTier) - TIER_ORDER.indexOf(b.worstTier)
        if (t !== 0) return t
        return b.becmgCount + b.tempoCount - (a.becmgCount + a.tempoCount)
      }
      if (sortBy === 'det') {
        const ad = a.detIdx < 0 ? 99 : a.detIdx
        const bd = b.detIdx < 0 ? 99 : b.detIdx
        return ad - bd
      }
      if (sortBy === 'conf') return b.conf - a.conf
      return a.s.icao.localeCompare(b.s.icao)
    })
    return out
  }, [synth, tierFilter, query, sortBy])

  /* ---------- MapLibre overlay ---------- */
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC_UP)) map.addSource(SRC_UP, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getSource(SRC_DOT)) map.addSource(SRC_DOT, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getSource(SRC_PIN)) map.addSource(SRC_PIN, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getSource(SRC_LBL)) map.addSource(SRC_LBL, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_UP)) map.addLayer({
          id: LYR_UP, type: 'line', source: SRC_UP,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [2, 2] },
        })
        if (!map.getLayer(LYR_DOT)) map.addLayer({
          id: LYR_DOT, type: 'circle', source: SRC_DOT,
          paint: { 'circle-radius': 3.2, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1, 'circle-opacity': 0.85 },
        })
        if (!map.getLayer(LYR_PIN)) map.addLayer({
          id: LYR_PIN, type: 'circle', source: SRC_PIN,
          paint: {
            'circle-radius': ['get', 'r'],
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

  useEffect(() => {
    if (!map) return
    const pinFeats: any[] = []
    const upFeats: any[] = []
    const dotFeats: any[] = []
    const lblFeats: any[] = []
    if (showOvl) {
      for (const r of filtered) {
        const col = TIER_COLOR[r.worstTier]
        if (showPin) {
          const rad = 5 + TIER_RANK[r.worstTier] * 2
          pinFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.s.lng, r.s.lat] }, properties: { color: col, r: rad } })
        }
        if (showUp && r.current.windKts > 1) {
          // draw segmented upwind path with dot at each FM offset
          let prevLat = r.s.lat, prevLng = r.s.lng
          for (let i = 0; i < r.fms.length; i++) {
            const off = r.fms[i].offsetH
            const driftNm = Math.min(900, Math.max(20, r.current.windKts * off))
            const [ulat, ulng] = offsetLL(r.s.lat, r.s.lng, r.current.windFromDeg, driftNm)
            upFeats.push({
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: [[prevLng, prevLat], [ulng, ulat]] },
              properties: { color: TIER_COLOR[r.fms[i].tier] },
            })
            dotFeats.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [ulng, ulat] },
              properties: { color: TIER_COLOR[r.fms[i].tier] },
            })
            prevLat = ulat; prevLng = ulng
          }
        }
        if (showLbl) {
          const det = r.detIdx >= 0 ? `→${TIER_COLOR[r.fms[r.detIdx].tier] ? r.fms[r.detIdx].tier : ''} T+${OFFSETS[r.detIdx]}h` : ''
          lblFeats.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [r.s.lng, r.s.lat] },
            properties: { color: col, label: `${r.s.iata} ${r.currentTier}${det ? ' ' + det : ''}` },
          })
        }
      }
    }
    try {
      ;(map.getSource(SRC_PIN) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: pinFeats })
      ;(map.getSource(SRC_UP) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: upFeats })
      ;(map.getSource(SRC_DOT) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: dotFeats })
      ;(map.getSource(SRC_LBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lblFeats })
    } catch {}
  }, [map, filtered, showOvl, showPin, showUp, showLbl])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_LBL, LYR_PIN, LYR_DOT, LYR_UP]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_LBL, SRC_PIN, SRC_DOT, SRC_UP]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  /* ---------- timeline diagram ---------- */
  const topTwelve = useMemo(() => {
    return [...synth]
      .sort((a, b) => {
        const t = TIER_ORDER.indexOf(a.worstTier) - TIER_ORDER.indexOf(b.worstTier)
        if (t !== 0) return t
        return (b.becmgCount + b.tempoCount) - (a.becmgCount + a.tempoCount)
      })
      .slice(0, 12)
  }, [synth])

  function tierBadge(t: Tier): string { return t }

  return (
    <div className="fixed top-16 right-3 z-40 w-[420px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">›</span>
          <span className="text-sm font-semibold tracking-wide">TAF FORECAST</span>
          <span className="text-[10px] text-slate-500">24h lagrangian · 4h FM</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {(['LIFR', 'IFR', 'MVFR', 'VFR'] as Tier[]).map(t => (
          <button key={t}
            onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/50 bg-sky-500/10' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }} title={`worst-24h = ${t}`}>
            <span className="text-[9px] tracking-wider">{t}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="px-3 py-2 grid grid-cols-3 gap-1 border-b border-slate-800">
        <div className="rounded bg-slate-900/40 border border-slate-800 px-2 py-1 text-center">
          <div className="text-[9px] tracking-wider text-slate-500">BECMG</div>
          <div className="text-sm font-mono text-amber-300">{summary.bec}</div>
        </div>
        <div className="rounded bg-slate-900/40 border border-slate-800 px-2 py-1 text-center">
          <div className="text-[9px] tracking-wider text-slate-500">TEMPO</div>
          <div className="text-sm font-mono text-yellow-300">{summary.tem}</div>
        </div>
        <div className="rounded bg-slate-900/40 border border-slate-800 px-2 py-1 text-center">
          <div className="text-[9px] tracking-wider text-slate-500">MEAN CONF</div>
          <div className="text-sm font-mono text-slate-200">{(summary.meanConf*100).toFixed(0)}%</div>
          <div className="text-[9px] text-slate-500">{summary.sampledN} obs</div>
        </div>
      </div>

      {/* Timeline diagram */}
      <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/30">
        <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider mb-1">
          <span>FORECAST TIMELINE · top 12 worst-tier hubs</span>
          <span className="font-mono text-slate-400">{pad(now.getUTCHours(),2)}{pad(now.getUTCMinutes(),2)}Z</span>
        </div>
        <svg width={396} height={222} className="block">
          <rect x={0} y={0} width={396} height={222} fill="#0b1220" />
          {(() => {
            const els: React.ReactElement[] = []
            const x0 = 44, x1 = 388
            const y0 = 14, y1 = 210
            const cols = 7  // current + 6 FM
            const rows = Math.max(1, topTwelve.length)
            const cellW = (x1 - x0) / cols
            const cellH = Math.min(16, (y1 - y0) / rows)
            // header
            const heads = ['NOW', 'T+4', 'T+8', 'T+12', 'T+16', 'T+20', 'T+24']
            for (let c = 0; c < cols; c++) {
              els.push(<text key={`h${c}`} x={x0 + c*cellW + cellW/2} y={y0 - 2} fill="#475569" fontSize={8} textAnchor="middle" fontFamily="ui-monospace, monospace">{heads[c]}</text>)
            }
            for (let r = 0; r < topTwelve.length; r++) {
              const row = topTwelve[r]
              const y = y0 + 4 + r * cellH
              els.push(<text key={`l${r}`} x={x0 - 4} y={y + cellH - 4} fill="#94a3b8" fontSize={9} textAnchor="end" fontFamily="ui-monospace, monospace">{row.s.iata}</text>)
              const tiers: Tier[] = [row.currentTier, ...row.fms.map(f => f.tier)]
              const anns: string[] = ['', ...row.fms.map(f => f.annotation)]
              for (let c = 0; c < cols; c++) {
                const t = tiers[c]
                const ann = anns[c]
                const x = x0 + c*cellW + 1
                const w = cellW - 2
                const h = cellH - 2
                els.push(<rect key={`c${r}-${c}`} x={x} y={y} width={w} height={h} fill={TIER_COLOR[t]} opacity={0.42}
                  onMouseEnter={() => setHoverCell({ icao: row.s.icao, idx: c - 1 })}
                  onMouseLeave={() => setHoverCell(null)} />)
                if (c > 0 && ann) {
                  const ac = ann === 'BECMG' ? '#fbbf24' : ann === 'TEMPO' ? '#facc15' : '#0ea5e9'
                  els.push(<rect key={`a${r}-${c}`} x={x} y={y} width={w} height={2} fill={ac} />)
                }
                if (t !== tiers[Math.max(0, c-1)]) {
                  els.push(<line key={`d${r}-${c}`} x1={x} y1={y} x2={x} y2={y + h} stroke="#0b1220" strokeWidth={1.2} />)
                }
              }
            }
            // legend
            const lx = x0
            const ly = y1 + 0
            let cursor = lx
            const leg: [Tier, string][] = [['VFR','VFR'],['MVFR','MVFR'],['IFR','IFR'],['LIFR','LIFR']]
            for (const [t, lbl] of leg) {
              els.push(<rect key={`lg-${t}`} x={cursor} y={ly} width={9} height={9} fill={TIER_COLOR[t]} opacity={0.42} />)
              els.push(<text key={`lt-${t}`} x={cursor + 12} y={ly + 8} fill={TIER_COLOR[t]} fontSize={9} fontFamily="ui-monospace, monospace">{lbl}</text>)
              cursor += 52
            }
            return els
          })()}
        </svg>
        {hoverCell && (() => {
          const row = topTwelve.find(r => r.s.icao === hoverCell.icao)
          if (!row) return null
          const fm = hoverCell.idx >= 0 ? row.fms[hoverCell.idx] : null
          const t = fm ? fm.tier : row.currentTier
          const off = hoverCell.idx >= 0 ? OFFSETS[hoverCell.idx] : 0
          const cell = fm ? fm.cell : row.current
          return (
            <div className="mt-1 text-[10px] font-mono text-slate-400">
              <span className="text-slate-200">{row.s.iata}</span>{' '}T+{off}h{' '}
              <span style={{ color: TIER_COLOR[t] }}>{t}</span>
              {fm?.annotation && <span className="text-amber-300"> · {fm.annotation}</span>}
              {' · '}{cell.windKts < 1 ? 'CALM' : `${pad(cell.windFromDeg,3)}/${pad(cell.windKts,2)}KT`}
              {' · '}{cell.visSm >= 10 ? '10' : cell.visSm.toFixed(1)}SM
              {' · '}{cell.ceilFtAgl < 0 ? 'SKC' : `${Math.round(cell.ceilFtAgl/100)*100}'`}
            </div>
          )
        })()}
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>SAMPLE RANGE</span>
            <span className="font-mono text-slate-300">{sampleRng} nm</span>
          </div>
          <input type="range" min={20} max={150} step={5} value={sampleRng} onChange={e => setSampleRng(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>DIURNAL AMP</span>
            <span className="font-mono text-slate-300">±{diurnalAmp} C</span>
          </div>
          <input type="range" min={0} max={14} step={1} value={diurnalAmp} onChange={e => setDiurnalAmp(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showOvl} onChange={e => setShowOvl(e.target.checked)} className="accent-sky-500" /><span>OVL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showUp} onChange={e => setShowUp(e.target.checked)} className="accent-sky-500" /><span>UPWIND</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLbl} onChange={e => setShowLbl(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <div className="ml-auto flex items-center gap-1">
            <span className="text-slate-500 mr-1">sort</span>
            {(['tier', 'det', 'conf', 'alpha'] as const).map(k => (
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
          return (
            <button key={r.s.icao} onClick={() => onFlyLatLng(r.s.lat, r.s.lng, 8)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-stretch gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{r.s.iata}</span>
                  <span className="font-mono text-slate-500">{r.s.icao}</span>
                  <span className="text-slate-400 truncate">{r.s.name}</span>
                  <span className="ml-auto text-[10px] font-semibold" style={{ color: TIER_COLOR[r.worstTier] }}>{tierBadge(r.worstTier)}</span>
                </div>
                <div className="flex items-stretch gap-0.5 mt-1">
                  <div className="flex-1 flex items-center justify-center text-[9px] font-mono text-slate-200 rounded-l px-1 py-0.5"
                    style={{ background: TIER_COLOR[r.currentTier] + '55' }} title={`NOW ${r.currentTier}`}>NOW</div>
                  {r.fms.map((fm, i) => (
                    <div key={i} className="flex-1 flex flex-col items-center justify-center text-[9px] font-mono px-1 py-0.5 last:rounded-r"
                      style={{ background: TIER_COLOR[fm.tier] + '55', color: TIER_COLOR[fm.tier] }}
                      title={`T+${OFFSETS[i]}h ${fm.tier}${fm.annotation ? ' ' + fm.annotation : ''}`}>
                      <span className="text-slate-200">+{OFFSETS[i]}</span>
                      {fm.annotation && <span className="text-[8px] -mt-0.5">{fm.annotation === 'PROB30' ? 'P30' : fm.annotation === 'BECMG' ? 'BCM' : 'TMP'}</span>}
                    </div>
                  ))}
                </div>
                <div className="mt-1 text-[10px] text-slate-400 font-mono flex items-center gap-2">
                  {r.detIdx >= 0
                    ? <span>↓ <span className="text-amber-300">deterioration</span> T+{OFFSETS[r.detIdx]}h → <span style={{ color: TIER_COLOR[r.fms[r.detIdx].tier] }}>{r.fms[r.detIdx].tier}</span></span>
                    : <span className="text-emerald-300">stable / improving</span>}
                  {r.impIdx >= 0 && <span className="text-emerald-300">↑ T+{OFFSETS[r.impIdx]}h</span>}
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`confidence ${(r.conf*100).toFixed(0)}%`}>
                  <div className="absolute inset-y-0 left-0 bg-sky-500/70" style={{ width: `${Math.round(r.conf*100)}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400/60" style={{ left: '40%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400/60" style={{ left: '70%' }} />
                </div>
                <div className="mt-1 text-[10px] font-mono text-slate-500 break-all leading-snug" title={r.tafString}>{r.tafString}</div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span>{r.current.samples} obs</span>
                  <span>BCM {r.becmgCount}</span>
                  <span>TMP {r.tempoCount}</span>
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
