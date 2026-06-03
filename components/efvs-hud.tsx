'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   EFVS / HUD Enhanced Flight Vision System Lower-Minima
   & 14 CFR 91.176 Operational Credit Monitor
   -----------------------------------------------------------
   Distinct from autoland/LVO: this subsystem evaluates the
   operational credit that an Enhanced Flight Vision System
   (EFVS) provides to DESCEND BELOW DH on a published instrument
   approach using *sensor-imagery* visual reference (IR / MMW /
   combined) presented on a HUD or equivalent, per:

     · 14 CFR 91.176(a)  EFVS Operations to Touchdown & Rollout
     · 14 CFR 91.176(b)  EFVS Operations to 100 ft Above TDZE
     · 14 CFR 61.66       EFVS Pilot Training & Recent Experience
     · 14 CFR 91.176(c)   EFVS Required Equipment
     · FAA AC 90-106A     EFVS Operations
     · FAA AC 20-167B     Airworthiness Approval of EFVS
     · FAA AC 23-26       EFVS for Part 23
     · FAA AC 25-11C      Electronic Flight Deck Displays
     · FAA Order 8900.1   Vol 4 EFVS authorization
     · ICAO Annex 6 Pt I  Att F EVS / SVS / CVS
     · ICAO Doc 9365      All-Weather Operations Manual ch 8
     · EASA SPA.LVO.100   EFVS approval
     · EASA AMC1 SPA.LVO.100 EFVS-200 / EFVS-A operations
     · RTCA DO-315B       EFVS MOPS (IR/MMW sensor performance)
     · RTCA DO-341        Combined Vision Systems MOPS
     · SAE ARP 5825        HUD design
     · Honeywell SmartView CVS / Rockwell Collins HGS-6000
     · Universal EVS-1500 / Elbit ClearVision HUD II / II+
     · Boeing 787 / 777-300ER HGS / Airbus A350 HUD

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash of ICAO24 stably
        synthesises: EFVS sensor type (NONE / IR / MMW / IR+MMW
        Combined), HUD fit (NONE / SINGLE / DUAL), STC vintage
        (PRE-2004 / 2004-2016 / POST-2016 91.176 amendment),
        sensor age hours, IR detector NETD (mK), MMW antenna
        gain drift, HUD combiner brightness, alignment drift,
        crew currency-cycles vs 6 EFVS approaches / 6 months.
     2. 8-class equipage catalogue: HVY-EFVS / HVY-HUD / NRW-HUD
        / NRW / RGN / BIZ-EFVS / BIZ / TBP / GA — base sensor
        and HUD fit + applicable §91.176(a/b) credit.
     3. Per-airport (32 catalogued destinations) reconstructs
        live RVR (TDZ), ceiling AGL, IR-attenuation (rain/fog
        humidity), MMW-attenuation (wet snow), runway approach
        lighting fit (ALSF-II adds IR credit per AC 90-106A).
     4. Credit-claim resolution:
          §91.176(a) to-touchdown:  requires EFVS-A approval +
            HUD + combined sensors OR IR+MMW.  RVR floor 1000ft
            (≈300m).
          §91.176(b) to 100 AGL:    requires EFVS + HUD.  RVR
            floor publish + 1000ft equivalent (300m typical).
            Natural-visual at 100 AGL still required.
        Aircraft credit-level = min(equipage, certification,
            crew-currency).
     5. 5 risk components (composite = max-driver):
          SENS  sensor health vs MOPS thresholds
                (IR NETD ge 90mK / MMW gain le -8dB / combiner
                 brightness le 600 nits)
          ATTN  atmospheric attenuation (wet-fog kills IR @
                3-5µm band; wet-snow kills MMW @ 94GHz)
          CRED  credit-mismatch: claiming §91.176(a) without
                EFVS-A or §91.176(b) without HUD
          HUD   HUD alignment / brightness / combiner fit
          CURR  pilot recent-experience deficit per 14 CFR 61.66
     6. Tier classification:
          DENIED   score ge 80 OR claiming credit not certified
                   — must fly to published non-EFVS minima
          DEGRADED score ge 55 — restrict to §91.176(b) only,
                   IR-only with no MMW redundancy
          MARGINAL score ge 25 — credit OK but margin tight
          OK       score lt 25 — full credit available
          IDLE     not on approach / no airport in capture

   Overlay: tier-coloured halos sized by score, rose diamond
   pin at airport for DENIED, dashed tier-coloured projection
   for DENIED / DEGRADED, 32 airport pins with ALS-fit hue.
============================================================ */

export interface EfvsFlight {
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
  flights: EfvsFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'DENIED' | 'DEGRADED' | 'MARGINAL' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = { DENIED: '#ef4444', DEGRADED: '#f59e0b', MARGINAL: '#0ea5e9', OK: '#10b981', IDLE: '#64748b' }
const TIER_ORDER: Tier[] = ['DENIED', 'DEGRADED', 'MARGINAL', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { DENIED: 0, DEGRADED: 1, MARGINAL: 2, OK: 3, IDLE: 4 }

type Sensor = 'NONE' | 'IR' | 'MMW' | 'COMBO'
type Hud = 'NONE' | 'SINGLE' | 'DUAL'
type Credit = 'NONE' | '176B' | '176A'
const CREDIT_ORDER: Record<Credit, number> = { NONE: 0, '176B': 1, '176A': 2 }

type AcClass = 'HVY-EFVS' | 'HVY-HUD' | 'NRW-HUD' | 'NRW' | 'RGN' | 'BIZ-EFVS' | 'BIZ' | 'TBP' | 'GA'
const CLASS_LIST: AcClass[] = ['HVY-EFVS', 'HVY-HUD', 'NRW-HUD', 'NRW', 'RGN', 'BIZ-EFVS', 'BIZ', 'TBP', 'GA']

interface ClassSpec {
  sensor: Sensor; hud: Hud; baseCredit: Credit
  netdMk: number       // IR detector noise-equivalent temperature difference (mK), lower=better
  combinerNits: number
  refDoc: string
}
const CLASS_SPEC: Record<AcClass, ClassSpec> = {
  'HVY-EFVS':  { sensor: 'COMBO', hud: 'DUAL',   baseCredit: '176A', netdMk: 35, combinerNits: 1500, refDoc: 'B787/A350 HGS-6000 + EVS-3000 · AC 90-106A · STC ST04146NY' },
  'HVY-HUD':   { sensor: 'IR',    hud: 'DUAL',   baseCredit: '176B', netdMk: 55, combinerNits: 1400, refDoc: 'B777-300ER HGS-4000 + EVS-1500 · AC 90-106A' },
  'NRW-HUD':   { sensor: 'IR',    hud: 'SINGLE', baseCredit: '176B', netdMk: 65, combinerNits: 1200, refDoc: 'B737NG/MAX HGS-4000 · A320 HUD · AC 90-106A' },
  'NRW':       { sensor: 'NONE',  hud: 'NONE',   baseCredit: 'NONE', netdMk: 0,  combinerNits: 0,    refDoc: 'A320 / 737 no-HUD baseline · 14 CFR 91.175' },
  'RGN':       { sensor: 'NONE',  hud: 'NONE',   baseCredit: 'NONE', netdMk: 0,  combinerNits: 0,    refDoc: 'CRJ / E-jet baseline · 14 CFR 91.175' },
  'BIZ-EFVS':  { sensor: 'COMBO', hud: 'SINGLE', baseCredit: '176A', netdMk: 40, combinerNits: 1350, refDoc: 'Gulfstream PlaneView EVS-II + HUD · Falcon FalconEye CVS · AC 90-106A' },
  'BIZ':       { sensor: 'IR',    hud: 'SINGLE', baseCredit: '176B', netdMk: 70, combinerNits: 1100, refDoc: 'Bombardier Global Vision HUD · CL350 EVS · AC 90-106A' },
  'TBP':       { sensor: 'NONE',  hud: 'NONE',   baseCredit: 'NONE', netdMk: 0,  combinerNits: 0,    refDoc: 'Q400 / ATR-72 baseline · 14 CFR 91.175' },
  'GA':        { sensor: 'NONE',  hud: 'NONE',   baseCredit: 'NONE', netdMk: 0,  combinerNits: 0,    refDoc: 'POH §4 IFR baseline' },
}

function classifyClass(type: string, icao: string): AcClass {
  const t = (type || '').toUpperCase()
  const h = hash32(icao || '')
  const r = (h >>> 19) % 100
  if (/B78|A35/.test(t)) return r < 70 ? 'HVY-EFVS' : 'HVY-HUD'
  if (/B77|A33|A34|B74/.test(t)) return r < 55 ? 'HVY-HUD' : 'HVY-EFVS'
  if (/B73|A32|A22|A31/.test(t)) return r < 35 ? 'NRW-HUD' : 'NRW'
  if (/CRJ|E17|E19|E29|RJ85|F70|F100|AT[47]/.test(t)) return 'RGN'
  if (/G[VI458]|GLF|GLEX|FA[789]|F2TH/.test(t)) return r < 70 ? 'BIZ-EFVS' : 'BIZ'
  if (/CL[36]|E[35]5|HAWK/.test(t)) return 'BIZ'
  if (/DH8|PC1|TBM|PT6|KING|BE20|C208|C30|DH3/.test(t)) return 'TBP'
  return 'GA'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

type Driver = 'SENS' | 'ATTN' | 'CRED' | 'HUD' | 'CURR' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  SENS: 'Sensor degraded vs DO-315B MOPS',
  ATTN: 'Atmospheric attenuation overwhelms sensor band',
  CRED: 'Claimed credit not certified',
  HUD:  'HUD alignment / brightness fault',
  CURR: 'Crew EFVS currency lapsed',
  NONE: 'Nominal',
}

interface Airport {
  iata: string; icao: string; name: string
  lat: number; lng: number; elevFt: number
  rwyHdg: number
  alsf: 'ALSF-II' | 'HIALS' | 'MALSR' | 'SALS' | 'NONE'  // IR-credit-friendliness
  pubRvrM: number       // published lowest non-EFVS RVR mins (m)
}
const AIRPORTS: Airport[] = [
  { iata:'KASE', icao:'KASE', name:'Aspen-Pitkin',      lat:39.223, lng:-106.869, elevFt:7838, rwyHdg:150, alsf:'SALS',    pubRvrM:1600 },
  { iata:'KEGE', icao:'KEGE', name:'Eagle-Vail',        lat:39.643, lng:-106.918, elevFt:6548, rwyHdg: 70, alsf:'MALSR',   pubRvrM:1200 },
  { iata:'KTEB', icao:'KTEB', name:'Teterboro',         lat:40.850, lng:-74.061,  elevFt:8,    rwyHdg: 60, alsf:'MALSR',   pubRvrM:550  },
  { iata:'KBED', icao:'KBED', name:'Hanscom Field',     lat:42.470, lng:-71.289,  elevFt:133,  rwyHdg:110, alsf:'MALSR',   pubRvrM:550  },
  { iata:'KAPA', icao:'KAPA', name:'Centennial',        lat:39.570, lng:-104.849, elevFt:5885, rwyHdg:170, alsf:'MALSR',   pubRvrM:1000 },
  { iata:'KSAF', icao:'KSAF', name:'Santa Fe',          lat:35.617, lng:-106.089, elevFt:6349, rwyHdg:200, alsf:'MALSR',   pubRvrM:1200 },
  { iata:'KJAC', icao:'KJAC', name:'Jackson Hole',      lat:43.607, lng:-110.738, elevFt:6451, rwyHdg:180, alsf:'MALSR',   pubRvrM:1600 },
  { iata:'KSUN', icao:'KSUN', name:'Sun Valley',        lat:43.504, lng:-114.296, elevFt:5318, rwyHdg:310, alsf:'MALSR',   pubRvrM:1200 },
  // Major hubs with HIALS/ALSF-II
  { iata:'KSFO', icao:'KSFO', name:'San Francisco',     lat:37.619, lng:-122.375, elevFt:13,   rwyHdg:280, alsf:'ALSF-II', pubRvrM:550  },
  { iata:'KSEA', icao:'KSEA', name:'Seattle-Tacoma',    lat:47.450, lng:-122.309, elevFt:433,  rwyHdg:160, alsf:'ALSF-II', pubRvrM:300  },
  { iata:'KORD', icao:'KORD', name:"Chicago O'Hare",    lat:41.978, lng:-87.905,  elevFt:672,  rwyHdg:280, alsf:'ALSF-II', pubRvrM:300  },
  { iata:'KJFK', icao:'KJFK', name:'New York JFK',      lat:40.640, lng:-73.778,  elevFt:13,   rwyHdg:130, alsf:'ALSF-II', pubRvrM:300  },
  { iata:'KEWR', icao:'KEWR', name:'Newark',            lat:40.692, lng:-74.169,  elevFt:18,   rwyHdg: 40, alsf:'ALSF-II', pubRvrM:550  },
  { iata:'KIAH', icao:'KIAH', name:'Houston Bush',      lat:29.984, lng:-95.341,  elevFt:97,   rwyHdg:260, alsf:'ALSF-II', pubRvrM:300  },
  { iata:'KDEN', icao:'KDEN', name:'Denver',            lat:39.862, lng:-104.673, elevFt:5431, rwyHdg:170, alsf:'ALSF-II', pubRvrM:300  },
  { iata:'KATL', icao:'KATL', name:'Atlanta',           lat:33.640, lng:-84.428,  elevFt:1026, rwyHdg: 90, alsf:'ALSF-II', pubRvrM:300  },
  { iata:'KBOS', icao:'KBOS', name:'Boston',            lat:42.363, lng:-71.006,  elevFt:20,   rwyHdg:220, alsf:'HIALS',   pubRvrM:550  },
  { iata:'KDCA', icao:'KDCA', name:'Washington Reagan', lat:38.852, lng:-77.038,  elevFt:15,   rwyHdg:190, alsf:'MALSR',   pubRvrM:550  },
  { iata:'KLGA', icao:'KLGA', name:'New York LaGuardia',lat:40.777, lng:-73.872,  elevFt:21,   rwyHdg:130, alsf:'MALSR',   pubRvrM:550  },
  { iata:'KMSP', icao:'KMSP', name:'Minneapolis',       lat:44.882, lng:-93.222,  elevFt:841,  rwyHdg:300, alsf:'ALSF-II', pubRvrM:300  },
  { iata:'KDTW', icao:'KDTW', name:'Detroit',           lat:42.212, lng:-83.349,  elevFt:645,  rwyHdg:220, alsf:'ALSF-II', pubRvrM:300  },
  { iata:'KSLC', icao:'KSLC', name:'Salt Lake City',    lat:40.788, lng:-111.978, elevFt:4227, rwyHdg:160, alsf:'ALSF-II', pubRvrM:550  },
  { iata:'KMEM', icao:'KMEM', name:'Memphis',           lat:35.043, lng:-89.977,  elevFt:341,  rwyHdg:180, alsf:'ALSF-II', pubRvrM:300  },
  { iata:'KMCO', icao:'KMCO', name:'Orlando',           lat:28.429, lng:-81.309,  elevFt:96,   rwyHdg:180, alsf:'ALSF-II', pubRvrM:550  },
  // International EFVS-equivalent
  { iata:'EGLL', icao:'EGLL', name:'London Heathrow',   lat:51.477, lng:-0.461,   elevFt:83,   rwyHdg:270, alsf:'ALSF-II', pubRvrM:550  },
  { iata:'LFPB', icao:'LFPB', name:'Paris Le Bourget',  lat:48.969, lng: 2.441,   elevFt:218,  rwyHdg: 70, alsf:'MALSR',   pubRvrM:550  },
  { iata:'EDDF', icao:'EDDF', name:'Frankfurt',         lat:50.033, lng: 8.570,   elevFt:364,  rwyHdg: 70, alsf:'ALSF-II', pubRvrM:300  },
  { iata:'CYYZ', icao:'CYYZ', name:'Toronto Pearson',   lat:43.677, lng:-79.631,  elevFt:569,  rwyHdg: 50, alsf:'HIALS',   pubRvrM:550  },
  { iata:'CYUL', icao:'CYUL', name:'Montreal Trudeau',  lat:45.470, lng:-73.741,  elevFt:118,  rwyHdg:240, alsf:'HIALS',   pubRvrM:550  },
  { iata:'PANC', icao:'PANC', name:'Anchorage',         lat:61.174, lng:-149.996, elevFt:152,  rwyHdg:310, alsf:'MALSR',   pubRvrM:1200 },
  { iata:'PAJN', icao:'PAJN', name:'Juneau',            lat:58.355, lng:-134.576, elevFt:18,   rwyHdg: 80, alsf:'SALS',    pubRvrM:1600 },
  { iata:'PHNL', icao:'PHNL', name:'Honolulu',          lat:21.318, lng:-157.922, elevFt:13,   rwyHdg: 80, alsf:'MALSR',   pubRvrM:1200 },
]

interface Row {
  f: EfvsFlight
  klass: AcClass
  spec: ClassSpec
  apt: Airport
  distNm: number
  bearingDeg: number
  sensor: Sensor
  hud: Hud
  netdMk: number          // current detector NETD (mK)
  combinerNits: number    // current combiner brightness
  hudAlignMrad: number    // alignment drift (mrad)
  mmwGainDb: number       // MMW antenna gain delta vs spec (dB)
  currencyApproaches: number  // last 6 mo
  certCredit: Credit      // certified credit
  reqCredit: Credit       // credit needed for current wx
  effCredit: Credit       // min of certified and live equipage
  rvrM: number
  ceilingFt: number
  irAttenDb: number       // dB loss for 3-5µm at current humidity/precip
  mmwAttenDb: number      // dB loss at 94GHz at wet-snow
  sev: { sens: number; attn: number; cred: number; hud: number; curr: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'efvs-halo', SRC_LBL = 'efvs-lbl', SRC_PIN = 'efvs-pin', SRC_APT = 'efvs-apt', SRC_APTLBL = 'efvs-aptlbl', SRC_PROJ = 'efvs-proj'
const LYR_HALO = 'efvs-halo-l', LYR_LBL = 'efvs-lbl-l', LYR_PIN = 'efvs-pin-l', LYR_APT = 'efvs-apt-l', LYR_APTLBL = 'efvs-aptlbl-l', LYR_PROJ = 'efvs-proj-l'

function bearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180
  const Δλ = (lng2 - lng1) * Math.PI / 180
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}
function distNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180
  const dφ = (lat2 - lat1) * Math.PI / 180, dλ = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}

export default function EfvsHud({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [credFilter, setCredFilter] = useState<Credit | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [captureNm, setCaptureNm] = useState(120)
  const [rvrOffset, setRvrOffset] = useState(0)
  const [humidPct, setHumidPct] = useState(70)       // 0-100, drives IR attenuation
  const [snowMul, setSnowMul] = useState(100)        // 0-200%, drives MMW attenuation
  const [currMul, setCurrMul] = useState(100)        // 0-200%, scales currency
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showApt, setShowApt] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  // Per-airport live weather sampled per-minute
  const aptWx = useMemo(() => {
    const bucket = Math.floor(Date.now() / 60000)
    const m = new Map<string, { rvrM: number; ceilingFt: number; irAttenDb: number; mmwAttenDb: number }>()
    for (const a of AIRPORTS) {
      const h = hash32(a.iata + ':' + bucket)
      const r = (h % 1000) / 1000
      let rvr: number
      if (r < 0.30) rvr = 200 + ((h >>> 5) % 800)
      else if (r < 0.75) rvr = 1000 + ((h >>> 7) % 4000)
      else rvr = 5000 + ((h >>> 9) % 1000)
      const ceiling = rvr < 600 ? 50 + ((h >>> 11) % 200)
                    : rvr < 1500 ? 200 + ((h >>> 11) % 500)
                    : 1200 + ((h >>> 11) % 3000)
      // IR attenuation worse in wet fog (humidity↑ + low RVR)
      const wetness = Math.min(1, humidPct / 100)
      const irAtten = (1 - Math.min(1, rvr / 2000)) * 6 * wetness  // 0..6 dB
      // MMW attenuation worse in wet snow (low ceiling + temp proxy via lat scale)
      const snow = ((h >>> 21) % 100) / 100  // 0..1
      const mmwAtten = snow * 4 * (snowMul / 100)  // 0..4 dB
      m.set(a.iata, { rvrM: Math.max(75, rvr + rvrOffset), ceilingFt: ceiling, irAttenDb: irAtten, mmwAttenDb: mmwAtten })
    }
    return m
  }, [rvrOffset, humidPct, snowMul])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      if (f.altitudeFt / 100 < minFl) continue
      if (f.altitudeFt / 100 > 150) continue
      if (f.vertRate > -100) continue
      const klass = classifyClass(f.type || '', f.icao)
      const spec = CLASS_SPEC[klass]
      // Find best airport on projected track
      let bestApt: Airport | null = null, bestDist = Infinity, bestBrg = 0
      for (const a of AIRPORTS) {
        const d = distNm(f.lat, f.lng, a.lat, a.lng)
        if (d > captureNm) continue
        const brg = bearing(f.lat, f.lng, a.lat, a.lng)
        const off = Math.abs(((brg - f.track + 540) % 360) - 180)
        if (off > 70) continue
        if (d < bestDist) { bestDist = d; bestApt = a; bestBrg = brg }
      }
      if (!bestApt) continue
      const wx = aptWx.get(bestApt.iata)!
      const h = hash32(f.icao || '')

      // Sensor + HUD live state
      const sensor = spec.sensor
      const hud = spec.hud
      const sensorAgeFrac = ((h >>> 3) % 1000) / 1000
      const netdMk = spec.netdMk + sensorAgeFrac * 50         // drift +0..50 mK
      const combinerNits = Math.max(0, spec.combinerNits - sensorAgeFrac * 700)
      const hudAlignMrad = ((h >>> 13) % 100) / 100 * (hud === 'NONE' ? 0 : 2.2)
      const mmwGainDb = -((h >>> 17) % 100) / 100 * (sensor === 'COMBO' || sensor === 'MMW' ? 9 : 0)
      const currencyApproaches = Math.max(0, Math.floor((((h >>> 23) % 100) / 100 * 10) * (currMul / 100)))

      const certCredit = spec.baseCredit
      // Required credit based on wx vs published mins
      let reqCredit: Credit = 'NONE'
      if (wx.rvrM < bestApt.pubRvrM * 0.5) reqCredit = '176A'
      else if (wx.rvrM < bestApt.pubRvrM) reqCredit = '176B'

      // Effective credit = min(certCredit, equipage-live-cap)
      let liveCap: Credit = 'NONE'
      if (sensor === 'COMBO' && hud !== 'NONE' && netdMk < 70 && combinerNits > 700 && hudAlignMrad < 1.5 && mmwGainDb > -6) liveCap = '176A'
      else if (sensor !== 'NONE' && hud !== 'NONE' && netdMk < 90 && combinerNits > 500 && hudAlignMrad < 2.0) liveCap = '176B'
      else liveCap = 'NONE'
      const effRank = Math.min(CREDIT_ORDER[certCredit], CREDIT_ORDER[liveCap])
      const effCredit = (Object.keys(CREDIT_ORDER) as Credit[]).find(k => CREDIT_ORDER[k] === effRank) as Credit

      // Severities
      // SENS — sensor health vs MOPS (NETD ge 90 / nits le 500 / mmw gain le -8)
      let sensSev = 0
      if (sensor === 'NONE') sensSev = 0
      else {
        const netdSev = Math.max(0, Math.min(100, (netdMk - 40) / 60 * 100))
        const nitsSev = Math.max(0, Math.min(100, (700 - combinerNits) / 400 * 100))
        const mmwSev = sensor === 'COMBO' || sensor === 'MMW' ? Math.max(0, Math.min(100, (-mmwGainDb - 2) / 8 * 100)) : 0
        sensSev = Math.max(netdSev, nitsSev, mmwSev)
      }
      // ATTN — atmospheric attenuation depends on band
      let attnSev = 0
      if (sensor !== 'NONE') {
        const irImpact = (sensor === 'IR' || sensor === 'COMBO') ? wx.irAttenDb / 6 * 80 : 0
        const mmwImpact = (sensor === 'MMW' || sensor === 'COMBO') ? wx.mmwAttenDb / 4 * 60 : 0
        attnSev = sensor === 'COMBO' ? Math.min(irImpact, mmwImpact) + 20 : Math.max(irImpact, mmwImpact)
        attnSev = Math.min(100, attnSev)
      }
      // CRED — mismatch between required and effective
      const credGap = CREDIT_ORDER[reqCredit] - CREDIT_ORDER[effCredit]
      const credSev = credGap <= 0 ? 0 : credGap === 1 ? 65 : 100
      // HUD — alignment + brightness
      let hudSev = 0
      if (hud === 'NONE' && reqCredit !== 'NONE') hudSev = 80
      else if (hud !== 'NONE') {
        const aSev = Math.max(0, Math.min(100, (hudAlignMrad - 1.0) / 1.5 * 100))
        const bSev = Math.max(0, Math.min(100, (700 - combinerNits) / 400 * 100))
        hudSev = Math.max(aSev, bSev)
      }
      // CURR — pilot currency vs 6 EFVS approaches / 6 mo per 14 CFR 61.66
      let currSev = 0
      if (certCredit !== 'NONE') {
        currSev = currencyApproaches >= 6 ? 0
                : currencyApproaches >= 3 ? 35
                : currencyApproaches >= 1 ? 65 : 90
      }

      const drvList: Array<[Driver, number]> = [
        ['SENS', sensSev], ['ATTN', attnSev], ['CRED', credSev], ['HUD', hudSev], ['CURR', currSev],
      ]
      drvList.sort((a, b) => b[1] - a[1])
      const driver: Driver = drvList[0][1] > 0 ? drvList[0][0] : 'NONE'
      const score = drvList[0][1]

      let tier: Tier
      if (credGap >= 1 && reqCredit === '176A') tier = 'DENIED'
      else if (score >= 80) tier = 'DENIED'
      else if (score >= 55) tier = 'DEGRADED'
      else if (score >= 25) tier = 'MARGINAL'
      else tier = 'OK'

      out.push({
        f, klass, spec, apt: bestApt, distNm: bestDist, bearingDeg: bestBrg,
        sensor, hud, netdMk, combinerNits, hudAlignMrad, mmwGainDb, currencyApproaches,
        certCredit, reqCredit, effCredit,
        rvrM: wx.rvrM, ceilingFt: wx.ceilingFt, irAttenDb: wx.irAttenDb, mmwAttenDb: wx.mmwAttenDb,
        sev: { sens: sensSev, attn: attnSev, cred: credSev, hud: hudSev, curr: currSev },
        score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, captureNm, aptWx])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { DENIED: 0, DEGRADED: 0, MARGINAL: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumNetd = 0, sumAlign = 0, denied = 0, equipped = 0, count = 0, worst = 0, worstCs = ''
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      count++
      sumNetd += r.netdMk
      sumAlign += r.hudAlignMrad
      if (r.tier === 'DENIED') denied++
      if (r.certCredit !== 'NONE') equipped++
      if (r.score > worst) { worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim() }
    }
    return {
      meanNetd: count ? sumNetd / count : 0,
      meanAlign: count ? sumAlign / count : 0,
      denied, worst, worstCs,
      equipShare: count ? equipped / count : 0,
      activeCount: count,
    }
  }, [rows])

  const aptAggs = useMemo(() => {
    const m = new Map<string, { apt: Airport; count: number; sumScore: number; worst: number; worstCs: string; worstIcao: string; worstTier: Tier; denied: number }>()
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      let a = m.get(r.apt.iata)
      if (!a) { a = { apt: r.apt, count: 0, sumScore: 0, worst: 0, worstCs: '', worstIcao: '', worstTier: 'OK', denied: 0 }; m.set(r.apt.iata, a) }
      a.count++; a.sumScore += r.score
      if (r.tier === 'DENIED') a.denied++
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.score > a.worst) { a.worst = r.score; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
    }
    const arr = Array.from(m.values()).map(a => ({ ...a, meanScore: a.count ? a.sumScore / a.count : 0 }))
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
      .filter(r => r.tier !== 'IDLE')
      .filter(r => {
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (classFilter !== 'ALL' && r.klass !== classFilter) return false
        if (credFilter !== 'ALL' && r.effCredit !== credFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.apt.iata].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, classFilter, credFilter, query])

  const filteredAirports = useMemo(() => {
    const q = query.trim().toUpperCase()
    return aptAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (!q) return true
      return (a.apt.iata + ' ' + a.apt.name).toUpperCase().includes(q)
    })
  }, [aptAggs, tierFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'DEGRADED' || r.tier === 'DENIED').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${r.apt.iata} ${r.effCredit}\u203a${r.reqCredit} ${r.driver}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'DENIED').map(r => ({
      type: 'Feature' as const,
      properties: { color: '#ef4444', text: `\u203a ${r.apt.iata} need ${r.reqCredit} have ${r.effCredit} RVR ${Math.round(r.rvrM)}m` },
      geometry: { type: 'Point' as const, coordinates: [r.apt.lng, r.apt.lat] },
    })) : [] }
    const projFeatures: any[] = []
    if (showProj) {
      for (const r of rows) {
        if (r.tier !== 'DENIED' && r.tier !== 'DEGRADED') continue
        const coords: [number, number][] = []
        const segs = 14
        for (let i = 0; i <= segs; i++) {
          const t = i / segs
          coords.push([r.f.lng + (r.apt.lng - r.f.lng) * t, r.f.lat + (r.apt.lat - r.f.lat) * t])
        }
        projFeatures.push({ type: 'Feature' as const, properties: { color: TIER_COLOR[r.tier] }, geometry: { type: 'LineString' as const, coordinates: coords } })
      }
    }
    const projFc = { type: 'FeatureCollection' as const, features: projFeatures }
    const aptFeatures: any[] = []
    const aptLblFeatures: any[] = []
    if (showApt) {
      const inUse = new Set(rows.filter(r => r.tier !== 'IDLE').map(r => r.apt.iata))
      for (const a of AIRPORTS) {
        const baseColor = a.alsf === 'ALSF-II' ? '#10b981' : a.alsf === 'HIALS' ? '#0ea5e9' : a.alsf === 'MALSR' ? '#f59e0b' : '#64748b'
        const color = inUse.has(a.iata) ? '#38bdf8' : baseColor
        aptFeatures.push({ type: 'Feature' as const, properties: { color, opacity: inUse.has(a.iata) ? 0.85 : 0.35 }, geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] } })
        const wx = aptWx.get(a.iata)
        aptLblFeatures.push({ type: 'Feature' as const, properties: { color, text: `${a.iata} ${a.alsf} ${wx ? Math.round(wx.rvrM) + 'm' : ''}` }, geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] } })
      }
    }
    const aptFc = { type: 'FeatureCollection' as const, features: aptFeatures }
    const aptLblFc = { type: 'FeatureCollection' as const, features: aptLblFeatures }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_APT, aptFc, () => map.addLayer({ id: LYR_APT, type: 'circle', source: SRC_APT, paint: { 'circle-radius': 3, 'circle-color': ['get', 'color'], 'circle-opacity': ['get','opacity'], 'circle-stroke-color': ['get','color'], 'circle-stroke-width': 0.8, 'circle-stroke-opacity': 0.7 } }))
      ensure(SRC_APTLBL, aptLblFc, () => map.addLayer({ id: LYR_APTLBL, type: 'symbol', source: SRC_APTLBL, layout: { 'text-field': ['get', 'text'], 'text-size': 9, 'text-offset': [0, 0.8], 'text-anchor': 'top', 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'] }, paint: { 'text-color': ['get','color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2, 'text-opacity': 0.85 } }))
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [3, 3] } }))
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.14, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85 } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': ['get', 'text'], 'text-size': 10, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'], 'text-offset': [0, -1.5], 'text-anchor': 'bottom', 'icon-allow-overlap': true }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.6 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'] }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_APTLBL, LYR_APT]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_PROJ, SRC_APTLBL, SRC_APT]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, aptWx, showHalo, showLabels, showPin, showProj, showApt])

  // SVG diagram: IR-atten (x dB) vs NETD (y mK) with MOPS bands
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 30
    const xMax = 6, yMax = 120
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, v / xMax)) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMax, yMax }
  }, [])

  const tierColorOf = (s: number) => s >= 80 ? '#ef4444' : s >= 55 ? '#f59e0b' : s >= 25 ? '#0ea5e9' : '#10b981'
  const adviceFor = (r: Row): string => {
    if (r.tier === 'DENIED') {
      if (r.driver === 'CRED') return `Claim ${r.reqCredit} but only ${r.effCredit} certified at ${r.apt.iata} — fly published non-EFVS mins or divert per 14 CFR 91.176(a)(3)`
      if (r.driver === 'SENS') return `Sensor degraded (NETD ${r.netdMk.toFixed(0)}mK / nits ${Math.round(r.combinerNits)}) below DO-315B MOPS — no EFVS credit, file CAT-I or divert`
      if (r.driver === 'ATTN') return `${r.sensor === 'COMBO' ? 'Combined' : r.sensor} sensor band blanked by wet ${r.irAttenDb > r.mmwAttenDb ? 'fog (IR ' + r.irAttenDb.toFixed(1) + 'dB)' : 'snow (MMW ' + r.mmwAttenDb.toFixed(1) + 'dB)'} — credit denied per AC 90-106A §6`
      if (r.driver === 'HUD')  return `HUD align ${r.hudAlignMrad.toFixed(1)}mrad / ${Math.round(r.combinerNits)} nits below SAE ARP 5825 — fly raw-data approach, no EFVS credit`
      if (r.driver === 'CURR') return `Crew EFVS currency ${r.currencyApproaches}/6 below 14 CFR 61.66 — credit administratively denied, fly published mins`
      return 'EFVS credit denied — fly published non-EFVS minima per 14 CFR 91.175'
    }
    if (r.tier === 'DEGRADED') return `Restrict to ${r.effCredit} only — brief crew natural-visual acquisition at 100 AGL per 14 CFR 91.176(b)`
    if (r.tier === 'MARGINAL') return `${r.effCredit} credit margin tight (${r.driver}) — brief go-around criteria if sensor image degrades below DH`
    return `Full ${r.effCredit || '—'} EFVS credit available — sensor + HUD nominal, currency ${r.currencyApproaches}/6, RVR ${Math.round(r.rvrM)}m`
  }

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">EFVS / HUD · §91.176 Credit</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.activeCount} ac · {summary.denied} DENIED</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean NETD</div>
          <div className="font-mono text-sm" style={{ color: summary.meanNetd > 80 ? '#ef4444' : summary.meanNetd > 60 ? '#f59e0b' : summary.meanNetd > 0 ? '#0ea5e9' : '#10b981' }}>{summary.meanNetd.toFixed(0)}mK</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] truncate" style={{ color: tierColorOf(summary.worst) }}>{summary.worstCs || '—'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Denied</div>
          <div className="font-mono text-sm text-rose-400">{summary.denied}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">EFVS-equipped</div>
          <div className="font-mono text-[11px]" style={{ color: summary.equipShare < 0.3 ? '#ef4444' : summary.equipShare < 0.6 ? '#f59e0b' : '#10b981' }}>{(summary.equipShare * 100).toFixed(0)}%</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean HUD align</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanAlign > 1.5 ? '#ef4444' : summary.meanAlign > 1.0 ? '#f59e0b' : '#10b981' }}>{summary.meanAlign.toFixed(2)}mrad</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg viewBox={`0 0 ${diag.W} ${diag.H}`} className="w-full h-auto">
            <rect x={diag.PAD} y={6} width={diag.W - diag.PAD - 6} height={diag.ys(90) - 6} fill="#ef4444" opacity={0.07} />
            <rect x={diag.PAD} y={diag.ys(90)} width={diag.W - diag.PAD - 6} height={diag.ys(60) - diag.ys(90)} fill="#f59e0b" opacity={0.07} />
            <rect x={diag.PAD} y={diag.ys(60)} width={diag.W - diag.PAD - 6} height={diag.ys(40) - diag.ys(60)} fill="#0ea5e9" opacity={0.06} />
            <rect x={diag.PAD} y={diag.ys(40)} width={diag.W - diag.PAD - 6} height={diag.H - 30 - diag.ys(40)} fill="#10b981" opacity={0.05} />
            {[40, 60, 90].map(v => (
              <g key={'y'+v}>
                <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)} stroke="#475569" strokeWidth={0.4} strokeDasharray="2 3" />
                <text x={4} y={diag.ys(v) + 3} fill="#64748b" fontSize={8}>{v}mK</text>
              </g>
            ))}
            {[1, 2, 3, 4, 5].map(v => (
              <g key={'x'+v}>
                <line x1={diag.xs(v)} y1={6} x2={diag.xs(v)} y2={diag.H - 22} stroke="#334155" strokeWidth={0.4} strokeDasharray="2 3" />
                <text x={diag.xs(v)} y={diag.H - 12} fill="#64748b" fontSize={8} textAnchor="middle">{v}dB</text>
              </g>
            ))}
            {rows.filter(r => r.tier !== 'IDLE' && r.sensor !== 'NONE').slice(0, 800).map((r, i) => (
              <circle key={i} cx={diag.xs(r.irAttenDb)} cy={diag.ys(r.netdMk)} r={2} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
            <text x={diag.W - 6} y={diag.H - 2} fill="#475569" fontSize={8} textAnchor="end">IR atten dB · NETD mK</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Min FL</span><span className="text-slate-300 font-mono">{minFl}</span></span>
          <input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Capture nm</span><span className="text-slate-300 font-mono">{captureNm}</span></span>
          <input type="range" min={20} max={250} step={10} value={captureNm} onChange={e => setCaptureNm(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>RVR bias</span><span className="text-slate-300 font-mono">{rvrOffset>=0?'+':''}{rvrOffset}m</span></span>
          <input type="range" min={-2000} max={2000} step={100} value={rvrOffset} onChange={e => setRvrOffset(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Humidity</span><span className="text-slate-300 font-mono">{humidPct}%</span></span>
          <input type="range" min={0} max={100} step={5} value={humidPct} onChange={e => setHumidPct(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>MMW snow ×</span><span className="text-slate-300 font-mono">{snowMul}%</span></span>
          <input type="range" min={0} max={200} step={5} value={snowMul} onChange={e => setSnowMul(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Currency ×</span><span className="text-slate-300 font-mono">{currMul}%</span></span>
          <input type="range" min={20} max={200} step={5} value={currMul} onChange={e => setCurrMul(+e.target.value)} className="accent-sky-500" />
        </label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {CLASS_LIST.map(c => {
          const on = classFilter === c
          return <button key={c} onClick={() => setClassFilter(on ? 'ALL' : c)}
            className={`px-1.5 py-0.5 rounded border text-[10px] font-mono transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-800 text-slate-400 hover:text-slate-200'}`}>{c}</button>
        })}
      </div>
      <div className="flex flex-wrap gap-1 px-3 py-1 border-b border-slate-800">
        {(['NONE', '176B', '176A'] as Credit[]).map(c => {
          const on = credFilter === c
          return <button key={c} onClick={() => setCredFilter(on ? 'ALL' : c)}
            className={`px-1.5 py-0.5 rounded border text-[9px] font-mono transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-800 text-slate-400 hover:text-slate-200'}`}>{c}</button>
        })}
      </div>

      <div className="flex items-center gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['PROJ', showProj, setShowProj], ['APT', showApt, setShowApt], ['DIAG', showDiag, setShowDiag]] as const).map(([l, v, fn]) => (
          <button key={l} onClick={() => (fn as any)((x: boolean) => !x)}
            className={`px-1.5 py-0.5 rounded border text-[10px] font-mono transition ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-800 text-slate-500'}`}>{l}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search…"
          className="ml-auto bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-[10px] text-slate-200 placeholder:text-slate-600 w-24 focus:outline-none focus:border-sky-500/40" />
      </div>

      <div className="flex border-b border-slate-800 text-[10px]">
        {(['AIRCRAFT', 'AIRPORTS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-1.5 uppercase tracking-widest font-bold ${tab === t ? 'text-sky-300 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-8 text-center text-slate-500 text-[11px]">No aircraft on approach.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => (
          <button key={r.f.icao + r.apt.iata} onClick={() => onFly(r.f.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/70 transition relative">
            <span className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: TIER_COLOR[r.tier] }} />
            <div className="flex items-center gap-1.5">
              <span className="font-mono font-bold text-slate-100">{(r.f.callsign || r.f.icao).trim()}</span>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="text-[9px] font-mono px-1 rounded border border-slate-800 text-slate-400">{r.klass}</span>
              <span className="text-[9px] font-mono px-1 rounded border border-sky-500/40 text-sky-200">{r.apt.iata}</span>
              <span className="text-[9px] font-mono px-1 rounded border ml-auto" style={{ borderColor: TIER_COLOR[r.tier], color: TIER_COLOR[r.tier] }}>{r.tier}</span>
            </div>
            <div className="flex items-baseline gap-2 mt-0.5 text-[10px] font-mono text-slate-400">
              <span style={{ color: CREDIT_ORDER[r.effCredit] < CREDIT_ORDER[r.reqCredit] ? '#ef4444' : '#10b981' }}>{r.effCredit || 'NONE'}</span>
              <span className="text-slate-600">need {r.reqCredit}</span>
              <span style={{ color: r.netdMk > 80 ? '#ef4444' : r.netdMk > 60 ? '#f59e0b' : r.sensor === 'NONE' ? '#64748b' : '#10b981' }}>NETD {r.netdMk.toFixed(0)}</span>
              <span style={{ color: r.combinerNits < 600 ? '#ef4444' : r.combinerNits < 900 ? '#f59e0b' : r.hud === 'NONE' ? '#64748b' : '#10b981' }}>{Math.round(r.combinerNits)}nit</span>
              <span style={{ color: r.currencyApproaches < 3 ? '#ef4444' : r.currencyApproaches < 6 ? '#f59e0b' : '#10b981' }}>C{r.currencyApproaches}/6</span>
            </div>
            <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden relative">
              <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier] }} />
              <div className="absolute inset-y-0" style={{ left: '25%', width: 1, background: '#0ea5e966' }} />
              <div className="absolute inset-y-0" style={{ left: '55%', width: 1, background: '#f59e0b66' }} />
              <div className="absolute inset-y-0" style={{ left: '80%', width: 1, background: '#ef444466' }} />
            </div>
            <div className="flex flex-wrap gap-1 mt-1 text-[9px] font-mono">
              {(['SENS', 'ATTN', 'CRED', 'HUD', 'CURR'] as const).map(k => {
                const v = (r.sev as any)[k.toLowerCase()] as number
                return <span key={k} className="px-1 rounded border" style={{ borderColor: tierColorOf(v) + '88', color: tierColorOf(v) }}>{k} {v.toFixed(0)}</span>
              })}
            </div>
            <div className="flex flex-wrap gap-1 mt-1 text-[9px] font-mono text-slate-400">
              <span className="px-1 rounded border" style={{ borderColor: r.sensor === 'COMBO' ? '#10b98188' : r.sensor === 'NONE' ? '#64748b88' : '#0ea5e988', color: r.sensor === 'COMBO' ? '#10b981' : r.sensor === 'NONE' ? '#64748b' : '#0ea5e9' }}>SEN {r.sensor}</span>
              <span className="px-1 rounded border" style={{ borderColor: r.hud === 'DUAL' ? '#10b98188' : r.hud === 'NONE' ? '#64748b88' : '#0ea5e988', color: r.hud === 'DUAL' ? '#10b981' : r.hud === 'NONE' ? '#64748b' : '#0ea5e9' }}>HUD {r.hud}</span>
              <span className="px-1 rounded border border-slate-800">DIST {r.distNm.toFixed(0)}nm</span>
              <span className="px-1 rounded border border-slate-800">RVR {Math.round(r.rvrM)}m</span>
              <span className="px-1 rounded border border-slate-800">{r.apt.alsf}</span>
              <span className="px-1 rounded border" style={{ borderColor: r.irAttenDb > 3 ? '#f59e0b88' : '#33415588', color: r.irAttenDb > 3 ? '#f59e0b' : '#94a3b8' }}>IR-att {r.irAttenDb.toFixed(1)}dB</span>
            </div>
            <div className="mt-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>{adviceFor(r)}</div>
            <div className="mt-0.5 text-[9px] text-slate-600">{r.spec.refDoc} · {r.f.operator || '—'}</div>
          </button>
        ))}
        {tab === 'AIRPORTS' && filteredAirports.length === 0 && (
          <div className="px-3 py-8 text-center text-slate-500 text-[11px]">No airports with inbound EFVS traffic.</div>
        )}
        {tab === 'AIRPORTS' && filteredAirports.map(a => {
          const wx = aptWx.get(a.apt.iata)!
          return (
            <button key={a.apt.iata} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/70 transition relative">
              <span className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex items-center gap-1.5">
                <span className="font-mono font-bold text-slate-100">{a.apt.iata}</span>
                <span className="text-slate-500 text-[10px] truncate">{a.apt.name}</span>
                <span className="text-[9px] font-mono px-1 rounded border border-slate-800 text-slate-300">{a.apt.alsf}</span>
                <span className="text-[9px] font-mono px-1 rounded border ml-auto" style={{ borderColor: TIER_COLOR[a.worstTier], color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
              </div>
              <div className="flex items-baseline gap-2 mt-0.5 text-[10px] font-mono text-slate-400">
                <span style={{ color: wx.rvrM < 300 ? '#ef4444' : wx.rvrM < 600 ? '#f59e0b' : wx.rvrM < 1600 ? '#0ea5e9' : '#10b981' }}>RVR {Math.round(wx.rvrM)}m</span>
                <span style={{ color: wx.ceilingFt < 100 ? '#ef4444' : wx.ceilingFt < 500 ? '#f59e0b' : '#10b981' }}>CIG {wx.ceilingFt}ft</span>
                <span style={{ color: wx.irAttenDb > 4 ? '#ef4444' : wx.irAttenDb > 2 ? '#f59e0b' : '#10b981' }}>IR {wx.irAttenDb.toFixed(1)}dB</span>
                <span className="ml-auto">{a.count} ac{a.denied > 0 && <span className="text-rose-400"> · {a.denied} DENIED</span>}</span>
              </div>
              <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden relative">
                <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, a.meanScore)}%`, background: TIER_COLOR[a.worstTier] }} />
              </div>
              <div className="mt-0.5 text-[9px] text-slate-600">{a.apt.alsf} · pub-mins {a.apt.pubRvrM}m · RW{a.apt.rwyHdg.toString().padStart(3,'0')} · elev {a.apt.elevFt}ft · worst {a.worstCs}</div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        14 CFR 91.176(a/b) · 14 CFR 61.66 · FAA AC 90-106A · AC 20-167B · RTCA DO-315B · DO-341 · SAE ARP 5825 · EASA AMC1 SPA.LVO.100 · ICAO Doc 9365 ch 8
      </div>
    </div>
  )
}
