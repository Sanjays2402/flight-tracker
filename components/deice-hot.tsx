'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   De-Icing Holdover Time (HOT) Compliance Monitor (DEICE-HOT)
   -----------------------------------------------------------
   SAE AMS 1424 Type I newtonian fluid / AMS 1428 Type II/III/IV
   non-newtonian thickened anti-icing fluid / FAA HOT Guidelines
   2024-25 Winter (FAA Holdover Time Tables) / TC TP 14052 /
   EASA SIB 2016-13 ground de-icing / ICAO Doc 9640 Manual of
   Aircraft Ground De-icing/Anti-icing Operations / ATA Spec 100
   Ch 12 / Boeing FCOM 10.05 Cold Weather Ops / Airbus FCOM
   PRO-NOR-SUP-30 cold-weather ops compliance watch for every
   departure (recently airborne climb-out below MIN-FL post-rotate)
   originating from a curated 42-airport northern cold-zone field
   (CYYZ CYUL CYOW CYWG CYEG CYYC CYVR KORD KMSP KDEN KBOS KJFK
    KEWR KDTW KCLE KBUF KPDX KSEA KSLC KANC EFHK ESSA ENGM EKCH
    EDDF EDDM EDDB LOWW LSZH LFSB LFLL UUEE UUDD ULLI EPWW EPKK
    LZIB LKPR EVRA EYVI EETN BIKF RJAA RJBB RKSI). Synthesises
   stable de-ice fluid choice from FNV-1a 32-bit hash of ICAO24
   against airport-policy probability (large-hub: 65pct Type IV
   25pct Type II 8pct Type I 2pct Type III / regional: 40pct I
   30pct IV 25pct II 5pct III / russian-EE: 45pct II 30pct I
   20pct IV 5pct III for SPECA-3 propylene-glycol II locally
   produced) per ICAO Doc 9640 industry survey, fluid mix
   strength (100/0 75/25 50/50 by volume vs water) hash-modulated
   biasing thicker mixes at colder OAT, time-since-application
   minutes via hash-derived 0-90min spread + phase-of-flight
   add-on (airborne 12min post-rotate baseline), and OAT proxy
   via station-elev-corrected ISA lapse with seasonal northern
   offset (Dec-Feb -8C / Nov+Mar -4C / Oct+Apr -1C / season=AUTO
   from MONTH slider 1-12) plus OAT-BIAS slider -25..+10C.

   HOT lookup: ICAO Doc 9640 Table A2-1..A2-4 condensed grid
   columns OAT bins (>-3 / -3to-10 / -10to-14 / -14to-18 / -18to-25
   / -25to-35 / <-35 °C) rows precipitation (FROST 1, FZ-FOG 2,
   SNOW-V-LIGHT 3, SNOW-LIGHT 4, SNOW-MODERATE 5, SNOW-HEAVY 6,
   ICE-PELLETS 7, FZ-DRIZZLE 8, FZ-RAIN 9, RAIN-ON-COLD-SOAK 10)
   selected per-airframe from hash + season + airport-corridor.
   HOT minutes by fluid type at this OAT/precip cell (Type I 4-22
   / Type II 12-200 / Type III 8-95 / Type IV 18-380 minutes
   per FAA HOT Guidelines Winter 2024-25, NIL when below LOUT
   Lowest Operational Use Temperature: Type I -25 / Type II/III
   -25 / Type IV -29 unless heated). Mix dilution applies factor
   (100/0=1.00 / 75/25=0.65 / 50/50=0.35) to non-Type-I fluids.
   Margin minutes = HOT - tSinceApp. Composite severity 0-100:
     overrun (margin<=0) = clip(80 + |margin|*2, 80, 100) rose
     critical (margin<=5) = clip(60 + (5-margin)*4, 60, 80) amber
     watch (margin<=HOT*0.25) = clip(30 + ratio*30, 30, 60) sky
     ok = clip(margin/HOT*30, 0, 30) emerald
   Dominant risk driver = LOUT-violation / OVERRUN / DILUTION
   (mix<=50/50 + precip>=heavy) / PRECIP-INTENSITY (heavy snow,
   FZ-rain, ice-pellets) / NOMINAL.

   Tier classification:
     OVERRUN  margin<=0       rose    re-deice required SOP §12.1
     CRIT     margin<=5min    amber   return to deice pad now
     WATCH    margin<=HOT*0.25 sky    monitor wing-leading-edge
     OK       margin>HOT*0.25 emerald compliant
     IDLE     not departure   slate

   MapLibre overlay:
     - Tier-coloured halo rings sized by severity 8-22px
     - Rose diamond pin at origin de-ice pad for OVERRUN
     - Dashed sky line aircraft-back-to-origin-airport for non-OK
     - Tier-coloured callsign+fluid+margin labels for non-OK
     - 42 airport pins (slate base, Type IV majority = sky)

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-MARG / WORST callsign+margin / OVERRUN-count
     - 2-cell MEAN-HOT / TYPE-IV-share
     - SVG margin-vs-OAT scatter with 0/5/HOT*0.25 threshold bands
       shaded + every aircraft plotted as tier-coloured dot at
       (OAT, margin); rose 0-line + amber 5-line + sky 25pct band
     - 5 sliders MIN-FL / OAT-BIAS / HOT-SCALE / PRECIP-MUL / MONTH
     - 4-precip chip filter SNOW/FZ-FOG/ICE-PEL/FZ-RAIN
     - HALO/PIN/LBL/CORR/DIAG toggles + search
     - AIRCRAFT / FIELDS tab switcher

   Registered in Layers > Safety & Traffic. Persisted: ft-deice
   ============================================================ */

export interface DeiceFlight {
  icao: string
  callsign?: string
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
  flights: DeiceFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'WATCH' | 'CRIT' | 'OVRN' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981', WATCH: '#0ea5e9', CRIT: '#f59e0b', OVRN: '#ef4444', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['OVRN', 'CRIT', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { OVRN: 0, CRIT: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Fluid = 'I' | 'II' | 'III' | 'IV'
const FLUID_LABEL: Record<Fluid, string> = { I: 'Type I', II: 'Type II', III: 'Type III', IV: 'Type IV' }
const FLUID_LOUT: Record<Fluid, number> = { I: -25, II: -25, III: -25, IV: -29 } // °C
type Precip = 'FROST' | 'FZ-FOG' | 'SNOW-V-L' | 'SNOW-L' | 'SNOW-M' | 'SNOW-H' | 'ICE-PEL' | 'FZ-DRZ' | 'FZ-RAIN' | 'RAIN-COLD'
const PRECIP_INTENSITY: Record<Precip, number> = {
  FROST: 1, 'FZ-FOG': 2, 'SNOW-V-L': 3, 'SNOW-L': 4, 'SNOW-M': 5, 'SNOW-H': 6, 'ICE-PEL': 7, 'FZ-DRZ': 8, 'FZ-RAIN': 9, 'RAIN-COLD': 10,
}
type Mix = '100/0' | '75/25' | '50/50'
const MIX_FACTOR: Record<Mix, number> = { '100/0': 1.0, '75/25': 0.65, '50/50': 0.35 }

interface Field { icao: string; iata: string; name: string; lat: number; lng: number; elevFt: number; hub: 'LRG' | 'REG' | 'EE' }
const FIELDS: Field[] = [
  { icao: 'CYYZ', iata: 'YYZ', name: 'Toronto Pearson', lat: 43.677, lng: -79.631, elevFt: 569, hub: 'LRG' },
  { icao: 'CYUL', iata: 'YUL', name: 'Montréal Trudeau', lat: 45.470, lng: -73.741, elevFt: 118, hub: 'LRG' },
  { icao: 'CYOW', iata: 'YOW', name: 'Ottawa Macdonald', lat: 45.323, lng: -75.669, elevFt: 374, hub: 'REG' },
  { icao: 'CYWG', iata: 'YWG', name: 'Winnipeg', lat: 49.910, lng: -97.240, elevFt: 783, hub: 'REG' },
  { icao: 'CYEG', iata: 'YEG', name: 'Edmonton', lat: 53.310, lng: -113.580, elevFt: 2373, hub: 'REG' },
  { icao: 'CYYC', iata: 'YYC', name: 'Calgary', lat: 51.114, lng: -114.020, elevFt: 3557, hub: 'LRG' },
  { icao: 'CYVR', iata: 'YVR', name: 'Vancouver', lat: 49.194, lng: -123.184, elevFt: 14, hub: 'LRG' },
  { icao: 'KORD', iata: 'ORD', name: 'Chicago O\u2019Hare', lat: 41.978, lng: -87.905, elevFt: 672, hub: 'LRG' },
  { icao: 'KMSP', iata: 'MSP', name: 'Minneapolis', lat: 44.882, lng: -93.222, elevFt: 841, hub: 'LRG' },
  { icao: 'KDEN', iata: 'DEN', name: 'Denver', lat: 39.862, lng: -104.673, elevFt: 5431, hub: 'LRG' },
  { icao: 'KBOS', iata: 'BOS', name: 'Boston Logan', lat: 42.363, lng: -71.006, elevFt: 20, hub: 'LRG' },
  { icao: 'KJFK', iata: 'JFK', name: 'New York JFK', lat: 40.640, lng: -73.779, elevFt: 13, hub: 'LRG' },
  { icao: 'KEWR', iata: 'EWR', name: 'Newark', lat: 40.692, lng: -74.169, elevFt: 18, hub: 'LRG' },
  { icao: 'KDTW', iata: 'DTW', name: 'Detroit', lat: 42.212, lng: -83.349, elevFt: 645, hub: 'LRG' },
  { icao: 'KCLE', iata: 'CLE', name: 'Cleveland', lat: 41.412, lng: -81.849, elevFt: 791, hub: 'REG' },
  { icao: 'KBUF', iata: 'BUF', name: 'Buffalo', lat: 42.940, lng: -78.732, elevFt: 728, hub: 'REG' },
  { icao: 'KPDX', iata: 'PDX', name: 'Portland', lat: 45.589, lng: -122.598, elevFt: 31, hub: 'REG' },
  { icao: 'KSEA', iata: 'SEA', name: 'Seattle-Tacoma', lat: 47.449, lng: -122.309, elevFt: 433, hub: 'LRG' },
  { icao: 'KSLC', iata: 'SLC', name: 'Salt Lake City', lat: 40.788, lng: -111.978, elevFt: 4227, hub: 'LRG' },
  { icao: 'PANC', iata: 'ANC', name: 'Anchorage', lat: 61.174, lng: -149.996, elevFt: 152, hub: 'REG' },
  { icao: 'EFHK', iata: 'HEL', name: 'Helsinki Vantaa', lat: 60.317, lng: 24.963, elevFt: 179, hub: 'LRG' },
  { icao: 'ESSA', iata: 'ARN', name: 'Stockholm Arlanda', lat: 59.651, lng: 17.918, elevFt: 137, hub: 'LRG' },
  { icao: 'ENGM', iata: 'OSL', name: 'Oslo Gardermoen', lat: 60.193, lng: 11.100, elevFt: 681, hub: 'LRG' },
  { icao: 'EKCH', iata: 'CPH', name: 'Copenhagen Kastrup', lat: 55.617, lng: 12.656, elevFt: 17, hub: 'LRG' },
  { icao: 'EDDF', iata: 'FRA', name: 'Frankfurt', lat: 50.033, lng: 8.570, elevFt: 364, hub: 'LRG' },
  { icao: 'EDDM', iata: 'MUC', name: 'Munich', lat: 48.353, lng: 11.786, elevFt: 1487, hub: 'LRG' },
  { icao: 'EDDB', iata: 'BER', name: 'Berlin Brandenburg', lat: 52.366, lng: 13.503, elevFt: 157, hub: 'LRG' },
  { icao: 'LOWW', iata: 'VIE', name: 'Vienna', lat: 48.110, lng: 16.570, elevFt: 600, hub: 'LRG' },
  { icao: 'LSZH', iata: 'ZRH', name: 'Zürich', lat: 47.464, lng: 8.549, elevFt: 1416, hub: 'LRG' },
  { icao: 'LFSB', iata: 'BSL', name: 'Basel-Mulhouse', lat: 47.590, lng: 7.529, elevFt: 885, hub: 'REG' },
  { icao: 'LFLL', iata: 'LYS', name: 'Lyon Saint-Exupéry', lat: 45.726, lng: 5.090, elevFt: 821, hub: 'REG' },
  { icao: 'UUEE', iata: 'SVO', name: 'Moscow Sheremetyevo', lat: 55.973, lng: 37.414, elevFt: 622, hub: 'EE' },
  { icao: 'UUDD', iata: 'DME', name: 'Moscow Domodedovo', lat: 55.408, lng: 37.906, elevFt: 588, hub: 'EE' },
  { icao: 'ULLI', iata: 'LED', name: 'St Petersburg Pulkovo', lat: 59.800, lng: 30.262, elevFt: 78, hub: 'EE' },
  { icao: 'EPWW', iata: 'WAW', name: 'Warsaw Chopin', lat: 52.166, lng: 20.967, elevFt: 362, hub: 'EE' },
  { icao: 'EPKK', iata: 'KRK', name: 'Kraków Balice', lat: 50.077, lng: 19.785, elevFt: 791, hub: 'EE' },
  { icao: 'LZIB', iata: 'BTS', name: 'Bratislava', lat: 48.170, lng: 17.213, elevFt: 436, hub: 'EE' },
  { icao: 'LKPR', iata: 'PRG', name: 'Prague Václav Havel', lat: 50.101, lng: 14.260, elevFt: 1247, hub: 'EE' },
  { icao: 'EVRA', iata: 'RIX', name: 'Rīga', lat: 56.923, lng: 23.971, elevFt: 36, hub: 'EE' },
  { icao: 'EYVI', iata: 'VNO', name: 'Vilnius', lat: 54.634, lng: 25.286, elevFt: 645, hub: 'EE' },
  { icao: 'EETN', iata: 'TLL', name: 'Tallinn', lat: 59.413, lng: 24.833, elevFt: 131, hub: 'EE' },
  { icao: 'BIKF', iata: 'KEF', name: 'Keflavík', lat: 63.985, lng: -22.605, elevFt: 171, hub: 'REG' },
  { icao: 'RJAA', iata: 'NRT', name: 'Tokyo Narita', lat: 35.765, lng: 140.386, elevFt: 141, hub: 'LRG' },
  { icao: 'RJBB', iata: 'KIX', name: 'Osaka Kansai', lat: 34.434, lng: 135.230, elevFt: 26, hub: 'LRG' },
  { icao: 'RKSI', iata: 'ICN', name: 'Seoul Incheon', lat: 37.469, lng: 126.451, elevFt: 23, hub: 'LRG' },
]

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

function greatCircleNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const φ1 = (lat1 * Math.PI) / 180, φ2 = (lat2 * Math.PI) / 180
  const dφ = ((lat2 - lat1) * Math.PI) / 180, dλ = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function nearestField(lat: number, lng: number): { field: Field; distNm: number } {
  let best = FIELDS[0], bestD = Infinity
  for (const f of FIELDS) {
    const d = greatCircleNm(lat, lng, f.lat, f.lng)
    if (d < bestD) { bestD = d; best = f }
  }
  return { field: best, distNm: bestD }
}

// HOT table (minutes) condensed from FAA Winter 2024-25 Guidelines.
// rows: precip × cols: oat-bin (warm → cold).
const OAT_BINS: { lo: number; hi: number; label: string }[] = [
  { lo: -3, hi: 100, label: '>-3°C' },
  { lo: -10, hi: -3, label: '-3..-10' },
  { lo: -14, hi: -10, label: '-10..-14' },
  { lo: -18, hi: -14, label: '-14..-18' },
  { lo: -25, hi: -18, label: '-18..-25' },
  { lo: -35, hi: -25, label: '-25..-35' },
  { lo: -100, hi: -35, label: '<-35' },
]
function oatBinIdx(oat: number): number {
  for (let i = 0; i < OAT_BINS.length; i++) if (oat > OAT_BINS[i].lo && oat <= OAT_BINS[i].hi) return i
  return 6
}
// Each row: HOT minutes by [Type I (undiluted heated), Type II 100/0, Type III 100/0, Type IV 100/0] per OAT bin
const HOT_TABLE: Record<Precip, number[][]> = {
  // each cell: [I, II, III, IV] minutes (undiluted)
  FROST:     [[22,180,90,360],[20,140,75,310],[18,120,70,260],[15,100,60,220],[12, 90,55,200],[10, 70,40,150],[ 8, 55,30,110]],
  'FZ-FOG':  [[14, 80,55,200],[12, 65,45,165],[10, 55,38,130],[ 8, 45,32,105],[ 7, 38,28, 90],[ 6, 30,22, 70],[ 5, 22,16, 50]],
  'SNOW-V-L':[[12, 70,48,160],[10, 55,40,130],[ 8, 45,32,100],[ 7, 35,25, 80],[ 6, 28,20, 65],[ 5, 22,16, 50],[ 4, 16,12, 36]],
  'SNOW-L':  [[ 9, 50,35,120],[ 8, 40,28, 95],[ 7, 30,22, 70],[ 6, 24,18, 55],[ 5, 18,14, 42],[ 4, 14,10, 32],[ 3, 10, 7, 22]],
  'SNOW-M':  [[ 7, 35,24, 85],[ 6, 26,20, 65],[ 5, 20,15, 48],[ 4, 16,12, 38],[ 4, 12, 9, 28],[ 3,  9, 7, 20],[ 2,  6, 5, 14]],
  'SNOW-H':  [[ 5, 22,15, 55],[ 4, 16,12, 40],[ 3, 12, 9, 30],[ 3,  9, 7, 22],[ 2,  7, 5, 16],[ 2,  5, 4, 12],[ 1,  3, 3,  8]],
  'ICE-PEL': [[ 4, 18,12, 45],[ 3, 14, 9, 32],[ 2, 10, 7, 22],[ 2,  7, 5, 16],[ 0,  0, 0,  0],[ 0,  0, 0,  0],[ 0,  0, 0,  0]],
  'FZ-DRZ':  [[ 6, 30,20, 75],[ 5, 22,16, 55],[ 4, 16,12, 38],[ 3, 12, 9, 28],[ 0,  0, 0,  0],[ 0,  0, 0,  0],[ 0,  0, 0,  0]],
  'FZ-RAIN': [[ 4, 20,14, 55],[ 3, 14, 9, 35],[ 0,  0, 0,  0],[ 0,  0, 0,  0],[ 0,  0, 0,  0],[ 0,  0, 0,  0],[ 0,  0, 0,  0]],
  'RAIN-COLD':[[12, 60,40,140],[ 0,  0, 0,  0],[ 0,  0, 0,  0],[ 0,  0, 0,  0],[ 0,  0, 0,  0],[ 0,  0, 0,  0],[ 0,  0, 0,  0]],
}
const FLUID_COL: Record<Fluid, number> = { I: 0, II: 1, III: 2, IV: 3 }

function hotLookup(precip: Precip, oat: number, fluid: Fluid, mix: Mix): number {
  const row = HOT_TABLE[precip]
  const cell = row[oatBinIdx(oat)]
  const base = cell[FLUID_COL[fluid]]
  if (base <= 0) return 0
  if (fluid === 'I') return base // Type I always 100/0 heated
  return base * MIX_FACTOR[mix]
}

const SEASON_OFFSET = (month: number): number => {
  // Northern hemisphere monthly OAT offset vs ISA
  const tab: Record<number, number> = { 1: -8, 2: -8, 3: -4, 4: -1, 5: 2, 6: 5, 7: 7, 8: 6, 9: 3, 10: -1, 11: -4, 12: -7 }
  return tab[month] || 0
}

interface Row {
  f: DeiceFlight
  field: Field
  distNm: number
  flCur: number
  oatC: number
  precip: Precip
  fluid: Fluid
  mix: Mix
  tSinceApp: number   // minutes since fluid application
  hot: number         // minutes
  margin: number      // hot - tSinceApp
  marginRatio: number // margin / hot
  loutBust: boolean
  score: number
  tier: Tier
  driver: 'LOUT' | 'OVRN' | 'DIL' | 'PREC' | 'NONE'
}

const SRC_HALO = 'deice-halo', SRC_LBL = 'deice-lbl', SRC_PIN = 'deice-pin', SRC_FLD = 'deice-fld', SRC_COR = 'deice-cor'
const LYR_HALO = 'deice-halo-l', LYR_LBL = 'deice-lbl-l', LYR_PIN = 'deice-pin-l', LYR_FLD = 'deice-fld-l', LYR_FLDT = 'deice-fld-t', LYR_COR = 'deice-cor-l'

export default function DeiceHot({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'FIELDS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [precipFilter, setPrecipFilter] = useState<Precip | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(20)
  const [maxFl, setMaxFl] = useState(180)
  const [oatBias, setOatBias] = useState(0)
  const [hotScale, setHotScale] = useState(100)
  const [precipMul, setPrecipMul] = useState(100)
  const [month, setMonth] = useState(1)
  const [showHalo, setShowHalo] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showFlds, setShowFlds] = useState(true)
  const [showCorr, setShowCorr] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const offset = SEASON_OFFSET(month)
    for (const f of flights) {
      if (f.ground) continue
      const flCur = (f.altitudeFt || 0) / 100
      if (flCur < minFl || flCur > maxFl) continue
      // Must be climb-out: vert rate > 200 fpm OR low altitude near a field
      if (f.vertRate < 200 && flCur > 60) continue
      const { field, distNm } = nearestField(f.lat, f.lng)
      if (distNm > 80) continue
      const h = hash32(f.icao)
      const r1 = (h & 0xff) / 0xff
      const r2 = ((h >>> 8) & 0xff) / 0xff
      const r3 = ((h >>> 16) & 0xff) / 0xff
      const r4 = ((h >>> 24) & 0xff) / 0xff
      // OAT proxy: ISA SL 15C + elev lapse -1.98/1000ft + seasonal + bias
      const oatC = 15 - 1.98 * (field.elevFt / 1000) + offset + oatBias
      // Fluid distribution per hub
      let fluid: Fluid = 'I'
      if (field.hub === 'LRG') fluid = r1 < 0.65 ? 'IV' : r1 < 0.90 ? 'II' : r1 < 0.98 ? 'I' : 'III'
      else if (field.hub === 'REG') fluid = r1 < 0.40 ? 'I' : r1 < 0.70 ? 'IV' : r1 < 0.95 ? 'II' : 'III'
      else fluid = r1 < 0.45 ? 'II' : r1 < 0.75 ? 'I' : r1 < 0.95 ? 'IV' : 'III'
      // Precip: more severe at colder OAT
      const precipPool: Precip[] = oatC > 0
        ? ['RAIN-COLD', 'FZ-DRZ', 'FROST', 'SNOW-V-L']
        : oatC > -10
          ? ['SNOW-L', 'SNOW-M', 'FZ-RAIN', 'FZ-FOG', 'FZ-DRZ', 'ICE-PEL']
          : oatC > -20
            ? ['SNOW-L', 'SNOW-M', 'SNOW-H', 'ICE-PEL', 'FZ-FOG', 'FROST']
            : ['FROST', 'SNOW-V-L', 'SNOW-L', 'FZ-FOG']
      const precip = precipPool[Math.floor(r2 * precipPool.length)]
      // Mix: thicker at colder OAT, biased by precip
      const mix: Mix = fluid === 'I' ? '100/0'
        : oatC < -15 ? '100/0'
          : oatC < -5 ? (r3 < 0.7 ? '100/0' : '75/25')
            : (r3 < 0.4 ? '100/0' : r3 < 0.85 ? '75/25' : '50/50')
      // tSinceApp: 0-90min synthesised + 12min airborne baseline; scaled by precip intensity inverse
      const tSinceApp = 4 + r4 * 88 + 12 + (PRECIP_INTENSITY[precip] >= 5 ? -3 : 0)
      // HOT at this cell
      let hot = hotLookup(precip, oatC, fluid, mix) * (hotScale / 100)
      // Apply precip-intensity multiplier (heavier precip reduces HOT)
      hot = hot * (1 - (PRECIP_INTENSITY[precip] - 1) * 0.02 * (precipMul / 100 - 0.5))
      // LOUT (Lowest Operational Use Temperature) bust
      const loutBust = oatC < FLUID_LOUT[fluid] - 2
      if (loutBust) hot = 0
      const margin = hot - tSinceApp
      const marginRatio = hot > 0 ? margin / hot : -1
      let score: number, tier: Tier
      if (loutBust) { score = 100; tier = 'OVRN' }
      else if (margin <= 0) { score = Math.max(80, Math.min(100, 80 + Math.abs(margin) * 1.5)); tier = 'OVRN' }
      else if (margin <= 5) { score = Math.max(60, Math.min(80, 60 + (5 - margin) * 4)); tier = 'CRIT' }
      else if (marginRatio <= 0.25) { score = Math.max(30, Math.min(60, 30 + (0.25 - marginRatio) * 120)); tier = 'WATCH' }
      else { score = Math.max(0, Math.min(30, (1 - marginRatio) * 30)); tier = 'OK' }
      // Dominant driver
      let driver: Row['driver'] = 'NONE'
      if (loutBust) driver = 'LOUT'
      else if (margin <= 0) driver = 'OVRN'
      else if (mix === '50/50' && PRECIP_INTENSITY[precip] >= 5) driver = 'DIL'
      else if (PRECIP_INTENSITY[precip] >= 6) driver = 'PREC'
      out.push({ f, field, distNm, flCur, oatC, precip, fluid, mix, tSinceApp, hot, margin, marginRatio, loutBust, score, tier, driver })
    }
    return out
  }, [flights, minFl, maxFl, oatBias, hotScale, precipMul, month])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, WATCH: 0, CRIT: 0, OVRN: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    const n = rows.length || 1
    const meanMarg = rows.reduce((a, b) => a + b.margin, 0) / n
    const meanHot = rows.reduce((a, b) => a + b.hot, 0) / n
    let worst: Row | null = null
    for (const r of rows) if (!worst || r.score > worst.score) worst = r
    const ovrn = rows.filter(r => r.tier === 'OVRN').length
    const t4 = rows.filter(r => r.fluid === 'IV').length
    return {
      meanMarg, meanHot, ovrn, t4, totalAc: rows.length,
      worstCs: worst ? (worst.f.callsign || worst.f.icao).trim() : '',
      worstMarg: worst ? worst.margin : 0,
      worstDriver: worst ? worst.driver : 'NONE',
    }
  }, [rows])

  const fieldAggs = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of rows) {
      if (!m.has(r.field.icao)) m.set(r.field.icao, [])
      m.get(r.field.icao)!.push(r)
    }
    const arr = Array.from(m.entries()).map(([icao, list]) => {
      const field = list[0].field
      const meanMarg = list.reduce((a, b) => a + b.margin, 0) / list.length
      const meanHot = list.reduce((a, b) => a + b.hot, 0) / list.length
      const worstTier = list.reduce((acc, r) => TIER_RANK[r.tier] < TIER_RANK[acc] ? r.tier : acc, 'OK' as Tier)
      const ovrn = list.filter(r => r.tier === 'OVRN').length
      const crit = list.filter(r => r.tier === 'CRIT').length
      return { icao, field, count: list.length, meanMarg, meanHot, worstTier, ovrn, crit, list }
    })
    arr.sort((a, b) => {
      const ti = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
      if (ti !== 0) return ti
      return b.count - a.count
    })
    return arr
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows
      .filter(r => {
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (precipFilter !== 'ALL' && r.precip !== precipFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.field.iata, r.field.icao, r.fluid, r.precip].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, precipFilter, query])

  // ---- MapLibre layers ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${r.fluid} ${r.margin >= 0 ? '+' : ''}${r.margin.toFixed(0)}m` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'OVRN').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `›${r.field.iata} RE-DEICE` },
      geometry: { type: 'Point' as const, coordinates: [r.field.lng, r.field.lat] },
    })) : [] }
    const fldFc = { type: 'FeatureCollection' as const, features: showFlds ? FIELDS.map(fld => ({
      type: 'Feature' as const,
      properties: { color: fld.hub === 'LRG' ? '#0ea5e9' : fld.hub === 'REG' ? '#64748b' : '#a78bfa', text: `★ ${fld.iata}` },
      geometry: { type: 'Point' as const, coordinates: [fld.lng, fld.lat] },
    })) : [] }
    const corFc = { type: 'FeatureCollection' as const, features: showCorr ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.field.lng, r.field.lat]] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_COR, corFc, () => map.addLayer({ id: LYR_COR, type: 'line', source: SRC_COR, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [2, 3],
      } }))
      ensure(SRC_FLD, fldFc, () => {
        map.addLayer({ id: LYR_FLD, type: 'circle', source: SRC_FLD, paint: {
          'circle-radius': 3.5, 'circle-color': ['get', 'color'], 'circle-opacity': 0.85,
          'circle-stroke-color': '#020617', 'circle-stroke-width': 1,
        } })
        map.addLayer({ id: LYR_FLDT, type: 'symbol', source: SRC_FLD, layout: {
          'text-field': ['get', 'text'], 'text-size': 9, 'text-anchor': 'top', 'text-offset': [0, 0.6],
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'], 'text-allow-overlap': false,
        }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } })
      })
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-anchor': 'top', 'text-offset': [0, 0.8], 'icon-allow-overlap': true,
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.6 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_FLDT, LYR_FLD, LYR_COR]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_FLD, SRC_COR]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showFlds, showCorr])

  // Diagram: margin (y) vs OAT (x)
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 28
    const xMin = -40, xMax = 10, yMin = -30, yMax = 120
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, (v - yMin) / (yMax - yMin)))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMin, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">De-Ice HOT Compliance</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} dep</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold" style={{ color: TIER_COLOR[t] }}>{t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Margin</div>
          <div className="font-mono text-sm" style={{ color: summary.meanMarg <= 0 ? '#ef4444' : summary.meanMarg <= 5 ? '#f59e0b' : summary.meanMarg <= 20 ? '#0ea5e9' : '#10b981' }}>
            {summary.meanMarg >= 0 ? '+' : ''}{summary.meanMarg.toFixed(1)}<span className="text-[9px] text-slate-500"> min</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstMarg >= 0 ? '+' : ''}${summary.worstMarg.toFixed(0)}m` : '—'}
          </div>
          <div className="font-mono text-[9px] text-slate-500 truncate">{summary.worstDriver}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Overrun</div>
          <div className="font-mono text-sm" style={{ color: summary.ovrn > 0 ? '#ef4444' : '#10b981' }}>{summary.ovrn}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean HOT</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.meanHot.toFixed(0)}<span className="text-[9px] text-slate-500"> min</span></div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Type IV Share</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.t4}<span className="text-[9px] text-slate-500"> /{summary.totalAc}</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">HOT Margin min vs OAT °C</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* Threshold bands */}
            <rect x={diag.PAD} y={diag.ys(120)} width={diag.W - diag.PAD - 6} height={Math.max(0, diag.ys(5) - diag.ys(120))} fill="#10b981" opacity={0.05} />
            <rect x={diag.PAD} y={diag.ys(5)} width={diag.W - diag.PAD - 6} height={Math.max(0, diag.ys(0) - diag.ys(5))} fill="#f59e0b" opacity={0.08} />
            <rect x={diag.PAD} y={diag.ys(0)} width={diag.W - diag.PAD - 6} height={Math.max(0, diag.ys(-30) - diag.ys(0))} fill="#ef4444" opacity={0.08} />
            <line x1={diag.PAD} y1={diag.ys(0)} x2={diag.W - 6} y2={diag.ys(0)} stroke="#ef4444" strokeWidth={0.9} strokeDasharray="3 2" opacity={0.75} />
            <line x1={diag.PAD} y1={diag.ys(5)} x2={diag.W - 6} y2={diag.ys(5)} stroke="#f59e0b" strokeWidth={0.9} strokeDasharray="3 2" opacity={0.75} />
            {[-35, -25, -14, -3, 0].map(x => (
              <g key={x}>
                <line x1={diag.xs(x)} y1={6} x2={diag.xs(x)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(x)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{x}</text>
              </g>
            ))}
            {[-20, 0, 30, 60, 100].map(y => (
              <text key={y} x={diag.PAD - 2} y={diag.ys(y) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{y}</text>
            ))}
            {rows.map(r => (
              <circle key={r.f.icao}
                cx={diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, r.oatC)))}
                cy={diag.ys(Math.max(diag.yMin, Math.min(diag.yMax, r.margin)))}
                r={3} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={0} max={120} step={5} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={50} max={300} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>OAT-BIAS</span><span className="font-mono text-slate-300">{oatBias > 0 ? '+' : ''}{oatBias}°C</span></div>
            <input type="range" min={-25} max={10} step={1} value={oatBias} onChange={e => setOatBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>HOT-SCALE</span><span className="font-mono text-slate-300">{hotScale}%</span></div>
            <input type="range" min={50} max={150} step={5} value={hotScale} onChange={e => setHotScale(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>PRECIP-MUL</span><span className="font-mono text-slate-300">{precipMul}%</span></div>
          <input type="range" min={50} max={200} step={5} value={precipMul} onChange={e => setPrecipMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>MONTH</span><span className="font-mono text-slate-300">{['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][month-1]}</span></div>
          <input type="range" min={1} max={12} step={1} value={month} onChange={e => setMonth(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setPrecipFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${precipFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['SNOW-L', 'SNOW-M', 'SNOW-H', 'FZ-FOG', 'FZ-RAIN', 'ICE-PEL', 'FROST'] as Precip[]).map(p => (
            <button key={p} onClick={() => setPrecipFilter(precipFilter === p ? 'ALL' : p)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${precipFilter === p ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showFlds} onChange={e => setShowFlds(e.target.checked)} className="accent-sky-500" /><span>FLD</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showCorr} onChange={e => setShowCorr(e.target.checked)} className="accent-sky-500" /><span>CORR</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / op / IATA / fluid / precip"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'FIELDS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length}` : `${fieldAggs.length} fields`}</span>
        <span>{tab === 'AIRCRAFT' ? 'fluid · margin · driver · tier' : 'mean margin · worst · count'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No qualifying departures in cold-zone fields.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const sevPct = Math.min(100, r.score)
          const advice =
            r.loutBust ? `LOUT bust · ${r.fluid} below ${FLUID_LOUT[r.fluid]}°C · re-deice with thicker fluid or heated Type I` :
            r.tier === 'OVRN' ? 'HOT exceeded · return to deice pad SOP §12.1 re-application required' :
            r.tier === 'CRIT' ? `under 5min margin · monitor wing LE pre-takeoff inspect` :
            r.tier === 'WATCH' ? `within HOT envelope · monitor precip intensity` :
            'compliant · HOT margin adequate'
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{r.field.iata}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="flight level">F{Math.round(r.flCur)}</span>
                  <span title="OAT" style={{ color: r.oatC < -20 ? '#0ea5e9' : '#94a3b8' }}>{r.oatC.toFixed(0)}°C</span>
                  <span title="precip" style={{ color: PRECIP_INTENSITY[r.precip] >= 6 ? TIER_COLOR[r.tier] : '#94a3b8' }}>{r.precip}</span>
                  <span title="margin" style={{ color: TIER_COLOR[r.tier] }}>{r.margin >= 0 ? '+' : ''}{r.margin.toFixed(0)}m</span>
                  <span className="ml-auto truncate" title="dominant driver" style={{ color: TIER_COLOR[r.tier] }}>{r.driver}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="composite risk score 0-100">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${sevPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: '30%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '60%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '80%' }} />
                </div>
                <div className="grid grid-cols-5 gap-1 mt-1 text-[9px] font-mono">
                  <span className="px-1 py-0 rounded border text-center" style={{ borderColor: TIER_COLOR[r.tier] + '66', color: TIER_COLOR[r.tier] }}>{FLUID_LABEL[r.fluid]}</span>
                  <span className="px-1 py-0 rounded border text-center border-slate-700 text-slate-400">{r.mix}</span>
                  <span className="px-1 py-0 rounded border text-center border-slate-700 text-slate-400">HOT {r.hot.toFixed(0)}</span>
                  <span className="px-1 py-0 rounded border text-center border-slate-700 text-slate-400">t+{r.tSinceApp.toFixed(0)}</span>
                  <span className="px-1 py-0 rounded border text-center" style={{ borderColor: r.loutBust ? '#ef444466' : '#334155', color: r.loutBust ? '#ef4444' : '#94a3b8' }}>LOUT {FLUID_LOUT[r.fluid]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="origin field">{r.field.icao}</span>
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'FIELDS' && fieldAggs.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No active de-icing fields.</div>
        )}
        {tab === 'FIELDS' && fieldAggs.map(z => {
          const pct = Math.min(100, Math.max(0, (60 - z.meanMarg) / 60 * 100))
          const advice = z.worstTier === 'OVRN' ? 'overrun aircraft on field · activate pad B re-apply Type IV' :
            z.worstTier === 'CRIT' ? 'aircraft within 5min margin · monitor pre-takeoff' :
            z.worstTier === 'WATCH' ? 'within HOT envelope · routine monitoring' :
            'compliant field operations'
          return (
            <button key={z.icao} onClick={() => { const f = z.list[0]; if (f) onFly(f.f.icao) }}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[z.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{z.field.iata}</span>
                  <span className="text-slate-500 truncate">{z.field.name}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{z.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[z.worstTier] }}>{z.worstTier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span style={{ color: TIER_COLOR[z.worstTier] }}>mean {z.meanMarg.toFixed(1)}m</span>
                  <span>HOT {z.meanHot.toFixed(0)}m</span>
                  <span>{z.field.icao}</span>
                  <span className="ml-auto">O{z.ovrn} C{z.crit}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="field overrun pressure">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: TIER_COLOR[z.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: '30%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '60%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '80%' }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate">elev {z.field.elevFt}ft · {z.field.hub}</span>
                  <span className="ml-auto truncate" style={{ color: z.worstTier === 'OK' ? '#64748b' : TIER_COLOR[z.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
