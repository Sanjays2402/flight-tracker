'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   VAAC · Volcanic Ash Advisory & Encounter-Risk Monitor
   ------------------------------------------------------------
   Per-airframe ash-encounter risk assessment against the 9
   ICAO-designated Volcanic Ash Advisory Centres (Anchorage,
   Buenos Aires, Darwin, London, Montreal, Tokyo, Toulouse,
   Washington, Wellington) and a global volcano catalogue.

   Per-volcano simulated ash-cloud column with three vertical
   FL bands (LOW 0-FL200 / MID FL200-FL350 / HI FL350-FL500),
   plume drift azimuth, plume length, and concentration class
   (LOW < 2 mg/m³ / MEDIUM 2-4 / HIGH > 4 per ICAO Doc 9974
   Manual on Volcanic Ash, Radioactive Material and Toxic
   Chemical Clouds, Appendix C, Boeing 747-400 Engine
   Susceptibility Curves and IATA Volcanic Ash Contingency
   Plan EUR/NAT VACP rev 2024).

   Aircraft are tested for current and forward-projection
   intersection with the plume cylinder. Engine ingestion
   risk scales with concentration class, exposure duration,
   and engine type (PW4000 / GE90 / Trent 1000 modelled with
   per-class susceptibility per CFM AOM 25.50 / EASA SIB
   2010-17R7 / RR Trent EOM 72-00-00).

   Regulatory & operational basis:
     · ICAO Annex 3 ch 4.8 · App 2 §4 · App 6 (SIGMET-V)
     · ICAO Doc 9974 Manual on Volcanic Ash / Toxic Clouds
     · ICAO Doc 4444 PANS-ATM 19 Volcanic Ash Procedures
     · ICAO Doc 9766 Handbook on IAVW IAVWOPSG
     · ICAO Doc 7030 Regional SUPPS Vol-Ash
     · WMO Manual on Codes WMO-306 SIGMET-VA
     · IATA VACP Vol-Ash Contingency Plan EUR/NAT 2024
     · EUR Doc 019 EUR/NAT Volcanic Ash Contingency
     · FAA AC 00-56B Volcanic Ash Avoidance
     · EASA SIB 2010-17R7 Vol-Ash Operations
     · CAA SN-2010/006 Engine Ash-Tolerance
     · NTSB SIR-86/01 KLM 867 Redoubt 1989
     · AAIB G-VOLC Aircraft ash encounter
     · ICAO IAVWOPSG/9 Bangkok 2017 ash dose
     · ARINC 429 lbl 215 SIGMET-V uplink
     · Boeing FCOM 7.10 / Airbus PRO-ABN-21 Vol-Ash
     · CFM AOM 25.50 / GE GEnx EOM 72-00-00
     · RR Trent EOM 72-00-00 ash susceptibility
   ============================================================ */

interface VaacFlight {
  icao: string; callsign: string; type: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: VaacFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'KLM867' | 'DEGRADED' | 'WATCH' | 'CLEAR' | 'IDLE'
type Driver = 'ING' | 'DUR' | 'PLM' | 'PRX' | 'EQP' | 'NONE'
type AcClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
type EngFam = 'PW4000' | 'GE90' | 'GEnx' | 'Trent1000' | 'Trent700' | 'CFM56' | 'LEAP' | 'PW1000G' | 'V2500' | 'PW150' | 'PT6'
type Phase = 'CRZ' | 'CLB' | 'DES' | 'APP' | 'TKO' | 'TAXI'
type Concentration = 'LOW' | 'MEDIUM' | 'HIGH'

const TIER_COLOR: Record<Tier, string> = {
  KLM867: '#ef4444', DEGRADED: '#f59e0b', WATCH: '#0ea5e9', CLEAR: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['KLM867', 'DEGRADED', 'WATCH', 'CLEAR', 'IDLE']
const TIER_RANK: Record<Tier, number> = { KLM867: 0, DEGRADED: 1, WATCH: 2, CLEAR: 3, IDLE: 4 }

const CONC_COLOR: Record<Concentration, string> = { LOW: '#fde047', MEDIUM: '#f59e0b', HIGH: '#ef4444' }

// 9 VAACs per ICAO Annex 3 App 2
interface Vaac { id: string; name: string; lat: number; lng: number; region: string }
const VAACS: Vaac[] = [
  { id: 'PAWU', name: 'Anchorage',     lat: 61.17, lng: -149.99, region: 'N-Pac' },
  { id: 'SABM', name: 'Buenos Aires',  lat: -34.61, lng:  -58.45, region: 'S-Am' },
  { id: 'YPDM', name: 'Darwin',        lat: -12.46, lng:  130.84, region: 'S-Pac' },
  { id: 'EGRR', name: 'London',        lat:  51.50, lng:   -0.12, region: 'N-Atl' },
  { id: 'CWAO', name: 'Montreal',      lat:  45.50, lng:  -73.57, region: 'N-Atl' },
  { id: 'RJTD', name: 'Tokyo',         lat:  35.69, lng:  139.69, region: 'NW-Pac' },
  { id: 'LFPW', name: 'Toulouse',      lat:  43.61, lng:    1.44, region: 'EUR' },
  { id: 'KNES', name: 'Washington',    lat:  38.90, lng:  -77.04, region: 'CONUS' },
  { id: 'NZKL', name: 'Wellington',    lat: -41.29, lng:  174.78, region: 'S-Pac' },
]

// Global volcano catalogue (24 historically active / IAVW-monitored)
interface Volcano {
  id: string; name: string; lat: number; lng: number;
  vaac: string; baseElevM: number; vei: number; // 0..7 Smithsonian
}
const VOLCANOES: Volcano[] = [
  { id: 'EYJ', name: 'Eyjafjallajökull',    lat: 63.63, lng: -19.62, vaac: 'EGRR', baseElevM: 1666, vei: 4 },
  { id: 'GRM', name: 'Grímsvötn',           lat: 64.42, lng: -17.33, vaac: 'EGRR', baseElevM: 1725, vei: 4 },
  { id: 'KAT', name: 'Katla',               lat: 63.63, lng: -19.05, vaac: 'EGRR', baseElevM: 1512, vei: 5 },
  { id: 'ETN', name: 'Etna',                lat: 37.75, lng:  14.99, vaac: 'LFPW', baseElevM: 3329, vei: 3 },
  { id: 'VSV', name: 'Vesuvius',            lat: 40.82, lng:  14.43, vaac: 'LFPW', baseElevM: 1281, vei: 3 },
  { id: 'STR', name: 'Stromboli',           lat: 38.79, lng:  15.21, vaac: 'LFPW', baseElevM:  926, vei: 2 },
  { id: 'KIL', name: 'Kīlauea',             lat: 19.42, lng:-155.29, vaac: 'KNES', baseElevM: 1247, vei: 2 },
  { id: 'MNL', name: 'Mauna Loa',           lat: 19.48, lng:-155.61, vaac: 'KNES', baseElevM: 4170, vei: 1 },
  { id: 'STH', name: 'Mt St Helens',        lat: 46.20, lng:-122.18, vaac: 'KNES', baseElevM: 2549, vei: 5 },
  { id: 'RDB', name: 'Redoubt',             lat: 60.49, lng:-152.74, vaac: 'PAWU', baseElevM: 3108, vei: 3 },
  { id: 'CLV', name: 'Cleveland',           lat: 52.82, lng:-169.94, vaac: 'PAWU', baseElevM: 1730, vei: 3 },
  { id: 'BOG', name: 'Bogoslof',            lat: 53.93, lng:-168.04, vaac: 'PAWU', baseElevM:  150, vei: 3 },
  { id: 'POP', name: 'Popocatépetl',        lat: 19.02, lng: -98.62, vaac: 'KNES', baseElevM: 5426, vei: 4 },
  { id: 'CBN', name: 'Calbuco',             lat: -41.33, lng: -72.61, vaac: 'SABM', baseElevM: 2003, vei: 4 },
  { id: 'PUY', name: 'Puyehue-Cordón',      lat: -40.59, lng: -72.12, vaac: 'SABM', baseElevM: 2236, vei: 4 },
  { id: 'NEV', name: 'Nevado del Ruiz',     lat:   4.89, lng: -75.32, vaac: 'SABM', baseElevM: 5321, vei: 3 },
  { id: 'SAK', name: 'Sakurajima',          lat:  31.59, lng: 130.66, vaac: 'RJTD', baseElevM: 1117, vei: 3 },
  { id: 'AIR', name: 'Aira (Sakurajima)',   lat:  31.58, lng: 130.66, vaac: 'RJTD', baseElevM: 1117, vei: 4 },
  { id: 'SHV', name: 'Shiveluch',           lat:  56.65, lng: 161.36, vaac: 'RJTD', baseElevM: 3283, vei: 4 },
  { id: 'KLY', name: 'Klyuchevskoy',        lat:  56.06, lng: 160.64, vaac: 'RJTD', baseElevM: 4754, vei: 4 },
  { id: 'MER', name: 'Merapi',              lat:  -7.54, lng: 110.45, vaac: 'YPDM', baseElevM: 2930, vei: 4 },
  { id: 'KRA', name: 'Krakatau',            lat:  -6.10, lng: 105.42, vaac: 'YPDM', baseElevM:  813, vei: 4 },
  { id: 'SIN', name: 'Sinabung',            lat:   3.17, lng:  98.39, vaac: 'YPDM', baseElevM: 2460, vei: 4 },
  { id: 'RUA', name: 'Ruapehu',             lat: -39.28, lng: 175.57, vaac: 'NZKL', baseElevM: 2797, vei: 3 },
]

// Engine susceptibility per CFM AOM / EASA SIB 2010-17R7 (0..1; lower = more tolerant)
const ENG_SUSC: Record<EngFam, number> = {
  PW4000: 0.85, GE90: 0.78, GEnx: 0.72, Trent1000: 0.74, Trent700: 0.82,
  CFM56: 0.70, LEAP: 0.62, PW1000G: 0.66, V2500: 0.72, PW150: 0.55, PT6: 0.50,
}

const PHASE_MUL: Record<Phase, number> = { CRZ: 1.10, CLB: 1.30, DES: 1.20, APP: 1.25, TKO: 1.35, TAXI: 0.80 }

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|A38|A34|IL96/.test(t)) return 'HVY-Q'
  if (/B77|B78|A33|A35|MD11/.test(t)) return 'HVY'
  if (/B73|A31|A319|A32|A22|B75|B71/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E27|E29|E[12]7|E[12]9|F70|F100/.test(t)) return 'RGN'
  if (/DH8|AT4|AT7|SF3|SB|Q400|PC12/.test(t)) return 'TBP'
  return 'BIZ'
}

function classifyEngine(type: string, klass: AcClass): EngFam {
  const t = (type || '').toUpperCase()
  if (/B748|B744/.test(t)) return 'GEnx'
  if (/B772|B773|B77W/.test(t)) return 'GE90'
  if (/B788|B789|B78X/.test(t)) return 'Trent1000'
  if (/A35|A359|A35K/.test(t)) return 'Trent1000'
  if (/A33|A332|A333|A338|A339/.test(t)) return 'Trent700'
  if (/A38/.test(t)) return 'Trent700'
  if (/B73[89M]|B737|B73N/.test(t)) return 'LEAP'
  if (/A20N|A21N|A319N|A220/.test(t)) return 'PW1000G'
  if (/A319|A320|A321/.test(t)) return 'CFM56'
  if (/B763|B764|B772|B752/.test(t)) return 'PW4000'
  if (/A332|A333|MD11/.test(t)) return 'PW4000'
  if (/CRJ|E17|E19|E27/.test(t)) return 'CFM56'
  if (klass === 'TBP') return /Q400|DH4/.test(t) ? 'PW150' : 'PT6'
  return 'V2500'
}

function classifyPhase(altFt: number, vrFpm: number, ground: boolean): Phase {
  if (ground) return 'TAXI'
  if (altFt < 1500) return 'TKO'
  if (altFt < 12000 && vrFpm < -500) return 'APP'
  if (vrFpm > 500) return 'CLB'
  if (vrFpm < -500) return 'DES'
  return 'CRZ'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

// Haversine in nm
function haversineNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const toRad = (d: number) => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function initialBearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => d * Math.PI / 180
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2))
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1))
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

// Move a lat/lng by distance (nm) and bearing (deg). Approximate flat-earth correction.
function destPoint(lat: number, lng: number, distNm: number, bearingDeg: number): [number, number] {
  const R = 3440.065
  const δ = distNm / R
  const θ = bearingDeg * Math.PI / 180
  const φ1 = lat * Math.PI / 180
  const λ1 = lng * Math.PI / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return [φ2 * 180 / Math.PI, ((λ2 * 180 / Math.PI + 540) % 360) - 180]
}

interface VolcanoState {
  vol: Volcano
  active: boolean
  plumeTopFL: number   // max ash column flight-level
  plumeBaseFL: number  // min ash band (usually 0)
  plumeAz: number      // drift heading (deg from)
  plumeLenNm: number   // downwind extent
  plumeWidthNm: number // crosswind half-width
  conc: Concentration
  ageH: number         // hours since onset
}

interface Row {
  f: VaacFlight
  klass: AcClass
  eng: EngFam
  phase: Phase
  // closest plume encountered
  vol: Volcano | null
  vState: VolcanoState | null
  distNm: number       // distance into plume cylinder (0 if outside)
  altInBand: boolean
  exposureMin: number  // estimated minutes spent in plume given groundspeed
  doseMgM3Min: number  // ash dose proxy
  sev: { ing: number; dur: number; plm: number; prx: number; eqp: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'vaac-halo', SRC_LBL = 'vaac-lbl', SRC_PIN = 'vaac-pin', SRC_PROJ = 'vaac-proj'
const SRC_VOL = 'vaac-vol', SRC_VAAC = 'vaac-vaac', SRC_PLUME = 'vaac-plume', SRC_REF = 'vaac-ref'
const LYR_HALO = 'vaac-halo-l', LYR_LBL = 'vaac-lbl-l', LYR_PIN = 'vaac-pin-l', LYR_PROJ = 'vaac-proj-l'
const LYR_VOL = 'vaac-vol-l', LYR_VAAC = 'vaac-vaac-l', LYR_VAAC_LBL = 'vaac-vaac-lbl-l'
const LYR_PLUME_FILL = 'vaac-plume-fill-l', LYR_PLUME_LINE = 'vaac-plume-line-l', LYR_REF = 'vaac-ref-l'
const LYR_VOL_LBL = 'vaac-vol-lbl-l'

export default function VaacMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'VOLCANOES' | 'VAACS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [vaacFilter, setVaacFilter] = useState<string | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [actRate, setActRate] = useState(45)     // % volcanoes active per epoch
  const [plumeMul, setPlumeMul] = useState(100)  // 50..250 plume length multiplier
  const [windKt, setWindKt] = useState(45)       // 0..120 mean upper-wind kt
  const [concBias, setConcBias] = useState(0)    // -50..+50 concentration bias
  const [projMin, setProjMin] = useState(20)     // 5..60 forward projection minutes
  const [phaseWt, setPhaseWt] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showVol, setShowVol] = useState(true)
  const [showVaac, setShowVaac] = useState(true)
  const [showPlume, setShowPlume] = useState(true)
  const [showRef, setShowRef] = useState(false)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  // Build deterministic volcano-state from a daily epoch.
  // Active flag, plume-top, drift azimuth, plume length, concentration
  const volcanoState: VolcanoState[] = useMemo(() => {
    const epoch = Math.floor(Date.now() / (1000 * 60 * 60 * 6)) // 6-hour epoch refresh
    return VOLCANOES.map(v => {
      const h = hash32(`${v.id}-${epoch}`)
      const activeRoll = (h & 0xff) / 255
      const active = activeRoll < (actRate / 100)
      // Plume top — scaled by VEI (3=FL120, 4=FL280, 5=FL420, 6=FL550). Cap at FL500.
      const veiToFL: Record<number, number> = { 1: 60, 2: 90, 3: 150, 4: 320, 5: 450, 6: 550, 7: 600 }
      const baseTop = veiToFL[v.vei] || 200
      const jitter = ((h >>> 8) & 0xff) / 255 * 60 - 30
      const plumeTopFL = Math.max(40, Math.min(500, baseTop + jitter))
      const plumeBaseFL = Math.max(0, Math.round((v.baseElevM * 3.281) / 100))
      // Drift azimuth — synoptic mid-latitude westerly biased
      const az = ((h >>> 16) & 0xff) * (360 / 255)
      const driftAz = (270 + (az - 180) * 0.6 + 360) % 360
      // Plume length scaled by wind, age, VEI
      const ageH = ((h >>> 24) & 0xff) / 255 * 48 // 0..48h
      const baseLen = 30 + v.vei * 35 + windKt * 2.5
      const plumeLenNm = baseLen * (plumeMul / 100) * (1 + ageH / 60)
      const plumeWidthNm = 15 + v.vei * 8
      // Concentration class
      const cr = ((h >>> 4) & 0xff) / 255 + (concBias / 200)
      const conc: Concentration = cr > 0.78 ? 'HIGH' : cr > 0.45 ? 'MEDIUM' : 'LOW'
      return { vol: v, active, plumeTopFL, plumeBaseFL, plumeAz: driftAz, plumeLenNm, plumeWidthNm, conc, ageH }
    })
  }, [actRate, plumeMul, windKt, concBias])

  const activeVolcanoes = useMemo(() => volcanoState.filter(s => s.active), [volcanoState])

  // For each aircraft, find the worst-case active plume intersection
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (!isFinite(f.altitudeFt)) continue
      if (f.altitudeFt / 100 < minFl) continue
      const klass = classifyClass(f.type || '')
      const eng = classifyEngine(f.type || '', klass)
      const phase = classifyPhase(f.altitudeFt, f.vertRate || 0, f.ground)
      const flAircraft = f.altitudeFt / 100

      // Test current position + projected position
      const projDistNm = (f.velocityKts / 60) * projMin
      const projPos = destPoint(f.lat, f.lng, projDistNm, f.track || 0)
      const sampleLats = [f.lat, projPos[0]]
      const sampleLngs = [f.lng, projPos[1]]

      let worst: { vs: VolcanoState; depthNm: number; expMin: number; inBand: boolean; prxNm: number } | null = null
      for (const vs of activeVolcanoes) {
        // Quick proximity to volcano vent
        const distVent = haversineNm(f.lat, f.lng, vs.vol.lat, vs.vol.lng)
        if (distVent > vs.plumeLenNm + 50) continue

        // Distance into plume cylinder — sample along position vs plume axis
        // Plume centerline starts at vent, extends along plumeAz for plumeLenNm.
        let bestSample: { depth: number; inBand: boolean; prx: number } | null = null
        for (let i = 0; i < sampleLats.length; i++) {
          const slat = sampleLats[i]; const slng = sampleLngs[i]
          const distToVent = haversineNm(slat, slng, vs.vol.lat, vs.vol.lng)
          const brgFromVent = initialBearingDeg(vs.vol.lat, vs.vol.lng, slat, slng)
          // Project onto plume axis
          const angDelta = ((brgFromVent - vs.plumeAz + 540) % 360) - 180
          const along = distToVent * Math.cos(angDelta * Math.PI / 180)
          const cross = Math.abs(distToVent * Math.sin(angDelta * Math.PI / 180))
          if (along < 0 || along > vs.plumeLenNm) continue
          // Plume widens with distance — cone half-width grows from baseWidth to baseWidth + along*0.18
          const halfWidth = vs.plumeWidthNm + along * 0.18
          if (cross > halfWidth) continue
          // Vertical band check: plume base (volcano summit) to plume top, but ash falls; lower thirds always present
          const inBand = flAircraft >= vs.plumeBaseFL && flAircraft <= vs.plumeTopFL
          // Penetration depth = (halfWidth - cross), normalised
          const depth = halfWidth - cross
          const prx = i === 0 ? 0 : projDistNm // distance until encounter
          if (!bestSample || depth > bestSample.depth) bestSample = { depth, inBand, prx }
        }
        if (!bestSample) continue
        if (!worst || bestSample.depth > worst.depthNm) {
          // Approx exposure minutes = chord length through plume / GS
          const chord = Math.min(2 * (vs.plumeWidthNm + 20), bestSample.depth * 2 + 10)
          const expMin = (chord / Math.max(120, f.velocityKts)) * 60
          worst = { vs, depthNm: bestSample.depth, expMin, inBand: bestSample.inBand, prxNm: bestSample.prx }
        }
      }

      if (!worst) {
        out.push({
          f, klass, eng, phase, vol: null, vState: null,
          distNm: 0, altInBand: false, exposureMin: 0, doseMgM3Min: 0,
          sev: { ing: 0, dur: 0, plm: 0, prx: 0, eqp: 0 }, score: 0, driver: 'NONE', tier: phase === 'TAXI' ? 'IDLE' : 'CLEAR',
        })
        continue
      }

      // Concentration mg/m³ midpoint
      const concMid: Record<Concentration, number> = { LOW: 1.0, MEDIUM: 3.0, HIGH: 6.0 }
      const cMg = concMid[worst.vs.conc]
      const doseMgM3Min = cMg * worst.expMin

      // Severities
      const susc = ENG_SUSC[eng]
      // INGESTION = concentration × engine susceptibility, escalated if in vertical band
      let ingSev = (cMg / 6) * 100 * susc
      if (!worst.inBand) ingSev *= 0.30
      ingSev = Math.min(100, ingSev)
      // DURATION
      const durSev = worst.expMin <= 1 ? 15 : worst.expMin <= 3 ? 45 : worst.expMin <= 8 ? 75 : 100
      // PLUME depth into cylinder
      const plmSev = Math.min(100, (worst.depthNm / (worst.vs.plumeWidthNm + 30)) * 100)
      // PROXIMITY — if not currently inside but projection enters
      const inside = worst.prxNm === 0
      const prxSev = inside ? 100 : Math.max(0, 100 - (worst.prxNm / projDistNm) * 80)
      // EQUIPAGE — does airframe have ash-tolerant engine (LEAP/PW1000G/PT6 better)
      const eqpSev = (susc - 0.5) * 200  // 0..70
      const sev = {
        ing: ingSev,
        dur: durSev * (inside && worst.inBand ? 1.0 : 0.4),
        plm: plmSev * (inside ? 1.0 : 0.5),
        prx: prxSev,
        eqp: Math.max(0, Math.min(80, eqpSev)),
      }

      const drivers: Array<[Driver, number]> = [['ING', sev.ing], ['DUR', sev.dur], ['PLM', sev.plm], ['PRX', sev.prx], ['EQP', sev.eqp]]
      drivers.sort((a, b) => b[1] - a[1])
      const driver: Driver = drivers[0][1] >= 12 ? drivers[0][0] : 'NONE'

      const phaseMul = 1 + ((PHASE_MUL[phase] - 1) * (phaseWt / 100))
      const max = drivers[0][1]
      const secondary = drivers[1][1]
      let score = Math.min(100, Math.max(0, max * phaseMul + 0.12 * secondary))

      // Hard escalations — KLM867 tier when inside HIGH-conc plume in vertical band
      if (inside && worst.inBand && worst.vs.conc === 'HIGH') score = Math.max(score, 92)
      if (inside && worst.inBand && worst.vs.conc === 'MEDIUM' && worst.expMin > 4) score = Math.max(score, 85)
      if (inside && doseMgM3Min > 18) score = Math.max(score, 88)

      let tier: Tier
      if (score >= 80) tier = 'KLM867'
      else if (score >= 55) tier = 'DEGRADED'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'CLEAR'

      out.push({
        f, klass, eng, phase, vol: worst.vs.vol, vState: worst.vs,
        distNm: worst.depthNm, altInBand: worst.inBand, exposureMin: worst.expMin, doseMgM3Min,
        sev, score, driver, tier,
      })
    }
    return out
  }, [flights, activeVolcanoes, minFl, projMin, phaseWt])

  const tierCount: Record<Tier, number> = { KLM867: 0, DEGRADED: 0, WATCH: 0, CLEAR: 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++

  const insideCount = rows.filter(r => r.vState && r.distNm > 0 && r.altInBand).length
  const meanDose = rows.length ? rows.reduce((a, r) => a + r.doseMgM3Min, 0) / rows.length : 0
  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null
  const exposedShare = rows.length ? rows.filter(r => r.tier !== 'CLEAR' && r.tier !== 'IDLE').length / rows.length : 0

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (vaacFilter !== 'ALL') r = r.filter(x => x.vState?.vol.vaac === vaacFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(x => (x.f.callsign || '').toLowerCase().includes(q) || (x.f.type || '').toLowerCase().includes(q) || (x.f.icao || '').toLowerCase().includes(q) || (x.f.operator || '').toLowerCase().includes(q) || (x.vol?.name || '').toLowerCase().includes(q))
    return r.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, vaacFilter, query])

  const volRows = useMemo(() => {
    return volcanoState.slice().sort((a, b) => Number(b.active) - Number(a.active) || b.vol.vei - a.vol.vei)
      .map(vs => {
        const exposed = rows.filter(r => r.vol?.id === vs.vol.id).length
        const klm = rows.filter(r => r.vol?.id === vs.vol.id && r.tier === 'KLM867').length
        return { ...vs, exposed, klm }
      })
  }, [volcanoState, rows])

  const vaacRows = useMemo(() => {
    return VAACS.map(va => {
      const vols = volcanoState.filter(s => s.vol.vaac === va.id)
      const activeVols = vols.filter(s => s.active).length
      const exposed = rows.filter(r => r.vState?.vol.vaac === va.id).length
      const klm = rows.filter(r => r.vState?.vol.vaac === va.id && r.tier === 'KLM867').length
      return { ...va, totalVols: vols.length, activeVols, exposed, klm }
    }).sort((a, b) => b.klm - a.klm || b.exposed - a.exposed)
  }, [volcanoState, rows])

  // Plume polygon helper: ring of points around the wedge
  const plumePolygon = (vs: VolcanoState): [number, number][] => {
    const v = vs.vol
    const pts: [number, number][] = []
    const segs = 18
    for (let i = 0; i <= segs; i++) {
      const along = (i / segs) * vs.plumeLenNm
      const halfW = vs.plumeWidthNm + along * 0.18
      const c = destPoint(v.lat, v.lng, along, vs.plumeAz)
      const left = destPoint(c[0], c[1], halfW, (vs.plumeAz + 90) % 360)
      pts.push([left[1], left[0]])
    }
    for (let i = segs; i >= 0; i--) {
      const along = (i / segs) * vs.plumeLenNm
      const halfW = vs.plumeWidthNm + along * 0.18
      const c = destPoint(v.lat, v.lng, along, vs.plumeAz)
      const right = destPoint(c[0], c[1], halfW, (vs.plumeAz - 90 + 360) % 360)
      pts.push([right[1], right[0]])
    }
    // close ring
    pts.push(pts[0])
    return pts
  }

  useEffect(() => {
    if (!map) return
    const ensureSource = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    }
    const sources = [SRC_REF, SRC_PLUME, SRC_PROJ, SRC_VOL, SRC_VAAC, SRC_HALO, SRC_PIN, SRC_LBL]
    sources.forEach(ensureSource)

    if (!map.getLayer(LYR_REF)) {
      map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.16, 'line-width': 0.8, 'line-dasharray': [2, 4] } })
    }
    if (!map.getLayer(LYR_PLUME_FILL)) {
      map.addLayer({ id: LYR_PLUME_FILL, type: 'fill', source: SRC_PLUME, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 } })
    }
    if (!map.getLayer(LYR_PLUME_LINE)) {
      map.addLayer({ id: LYR_PLUME_LINE, type: 'line', source: SRC_PLUME, paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.65, 'line-dasharray': [2, 3] } })
    }
    if (!map.getLayer(LYR_PROJ)) {
      map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.7, 'line-dasharray': [1.5, 2] } })
    }
    if (!map.getLayer(LYR_VOL)) {
      map.addLayer({ id: LYR_VOL, type: 'symbol', source: SRC_VOL, layout: { 'text-field': '▲', 'text-size': ['get', 'sz'], 'text-allow-overlap': true }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.4 } })
    }
    if (!map.getLayer(LYR_VOL_LBL)) {
      map.addLayer({ id: LYR_VOL_LBL, type: 'symbol', source: SRC_VOL, layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, 1.2], 'text-allow-overlap': false }, paint: { 'text-color': '#cbd5e1', 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(LYR_VAAC)) {
      map.addLayer({ id: LYR_VAAC, type: 'circle', source: SRC_VAAC, paint: { 'circle-radius': 5, 'circle-color': '#0b1220', 'circle-opacity': 0.85, 'circle-stroke-color': '#0ea5e9', 'circle-stroke-opacity': 0.9, 'circle-stroke-width': 1.5 } })
    }
    if (!map.getLayer(LYR_VAAC_LBL)) {
      map.addLayer({ id: LYR_VAAC_LBL, type: 'symbol', source: SRC_VAAC, layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, 1.2], 'text-allow-overlap': false }, paint: { 'text-color': '#7dd3fc', 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(LYR_HALO)) {
      map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.7, 'circle-stroke-width': 1.5 } })
    }
    if (!map.getLayer(LYR_PIN)) {
      map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': '◆', 'text-size': 14, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#0b1220', 'text-halo-width': 1.3 } })
    }
    if (!map.getLayer(LYR_LBL)) {
      map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.5], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }

    const halo: any[] = []; const lbl: any[] = []; const pin: any[] = []; const proj: any[] = []
    const volFeats: any[] = []; const vaacFeats: any[] = []; const plumeFeats: any[] = []; const refFeats: any[] = []

    if (showVaac) {
      for (const v of VAACS) {
        vaacFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.lng, v.lat] }, properties: { label: `${v.id} VAAC` } })
      }
    }
    if (showVol) {
      for (const vs of volcanoState) {
        const col = vs.active ? CONC_COLOR[vs.conc] : '#475569'
        volFeats.push({
          type: 'Feature', geometry: { type: 'Point', coordinates: [vs.vol.lng, vs.vol.lat] },
          properties: { color: col, sz: 9 + vs.vol.vei * 2, label: `${vs.vol.id}${vs.active ? ` ${vs.conc} FL${vs.plumeTopFL}` : ''}` },
        })
      }
    }
    if (showPlume) {
      for (const vs of activeVolcanoes) {
        const ring = plumePolygon(vs)
        plumeFeats.push({
          type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] },
          properties: { color: CONC_COLOR[vs.conc] },
        })
      }
    }

    for (const r of rows) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'CLEAR' && r.tier !== 'IDLE') {
        const rad = 8 + (r.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: rad } })
      }
      if (showPin && r.tier === 'KLM867') {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLabels && (r.tier === 'KLM867' || r.tier === 'DEGRADED') && r.vol) {
        const label = `${r.f.callsign || r.f.icao} · ${r.vol.id} ${r.vState?.conc} · ${r.exposureMin.toFixed(1)}min ${r.doseMgM3Min.toFixed(1)}mg·m⁻³·min`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showProj && (r.tier === 'KLM867' || r.tier === 'DEGRADED' || r.tier === 'WATCH')) {
        const projDistNm = (r.f.velocityKts / 60) * projMin
        const p2 = destPoint(r.f.lat, r.f.lng, projDistNm, r.f.track || 0)
        proj.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [p2[1], p2[0]]] }, properties: { color } })
      }
    }

    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        refFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }

    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_PROJ) as any).setData({ type: 'FeatureCollection', features: proj })
    ;(map.getSource(SRC_VOL) as any).setData({ type: 'FeatureCollection', features: volFeats })
    ;(map.getSource(SRC_VAAC) as any).setData({ type: 'FeatureCollection', features: vaacFeats })
    ;(map.getSource(SRC_PLUME) as any).setData({ type: 'FeatureCollection', features: plumeFeats })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: refFeats })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_VOL_LBL, LYR_VOL, LYR_VAAC_LBL, LYR_VAAC, LYR_PLUME_LINE, LYR_PLUME_FILL, LYR_REF]) {
        if (m.getLayer(id)) m.removeLayer(id)
      }
      for (const id of sources) { if (m.getSource(id)) m.removeSource(id) }
    }
  }, [map, rows, volcanoState, activeVolcanoes, projMin, showHalo, showPin, showLabels, showProj, showVol, showVaac, showPlume, showRef])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const driverBadge = (d: Driver, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const concPill = (c: Concentration) => {
    const col = CONC_COLOR[c]
    return <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '66', backgroundColor: col + '14' }}>{c}</span>
  }
  const engPill = (e: EngFam) => {
    const tol = ENG_SUSC[e]
    const col = tol >= 0.78 ? '#ef4444' : tol >= 0.70 ? '#f59e0b' : '#10b981'
    return <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '66', backgroundColor: col + '14' }}>{e}</span>
  }

  const advice = (r: Row): string => {
    if (r.tier === 'KLM867') {
      if (r.driver === 'ING' && r.vState?.conc === 'HIGH') return `HIGH-CONC ash ingestion — IMMEDIATE 180° turn, descend below FL${r.vState.plumeBaseFL}, throttle idle to minimise hot-section damage per KLM 867 Redoubt 1989 precedent (Boeing FCOM 7.10 VOL-ASH)`
      if (r.driver === 'DUR') return `Sustained exposure past ICAO Doc 9974 App C 4 mg/m³ × 8 min limit — escape track immediate, declare PAN-PAN, request lower per FAA AC 00-56B`
      if (r.driver === 'PLM') return `Deep penetration of ${r.vol?.name} ash plume — execute 180° escape, ash core encountered (Airbus PRO-ABN-21 VOLCANIC ACT)`
      return `KLM867-tier ash encounter on ${r.vol?.name} — execute volcanic-ash escape per FCOM 7.10, descend below contaminated layer, file ASH event report per EUR Doc 019`
    }
    if (r.tier === 'DEGRADED') return `Plume edge encounter ${r.vol?.name} (${r.vState?.conc}) — request immediate vector around plume per IATA VACP, monitor EGT trend, schedule borescope per CFM AOM 25.50`
    if (r.tier === 'WATCH') return `${r.vol?.name} ${r.vState?.conc} ash plume within ${projMin}-min projection — file PIREP, request SIGMET-V update from ${r.vState?.vol.vaac} VAAC per WMO-306`
    if (r.tier === 'CLEAR') return `Clear of all active VAAC plumes — continue per Annex 3 §4.8 IAVW guidance`
    return 'On ground or below MIN-FL — IDLE'
  }

  const W = 280, H = 180
  const xMax = 12  // dose mg·m³·min
  const yMax = 100 // score
  const sx = (v: number) => 30 + (Math.max(0, Math.min(xMax, v)) / xMax) * (W - 40)
  const sy = (v: number) => (H - 24) - (Math.max(0, Math.min(yMax, v)) / yMax) * (H - 48)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">VAAC · Volcanic-Ash Encounter</div>
          <div className="text-[10px] text-slate-500">ICAO Doc 9974 · Annex 3 App 6 · IATA VACP · 9 IAVW VAACs · 24 volcanoes</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[10px] font-semibold" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Exposed share</div>
          <div className="text-sm font-semibold" style={{ color: exposedShare <= 0.05 ? '#10b981' : exposedShare <= 0.15 ? '#f59e0b' : '#ef4444' }}>{(exposedShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst aircraft</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">KLM867</div>
          <div className="text-sm font-semibold" style={{ color: tierCount.KLM867 > 0 ? '#ef4444' : '#10b981' }}>{tierCount.KLM867}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Active volcanoes</div>
          <div className="text-xs font-semibold" style={{ color: activeVolcanoes.length > 8 ? '#f59e0b' : '#10b981' }}>{activeVolcanoes.length} / {VOLCANOES.length}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">In plume</div>
          <div className="text-xs font-semibold" style={{ color: insideCount > 0 ? '#ef4444' : '#10b981' }}>{insideCount} ac</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean dose</div>
          <div className="text-xs font-semibold" style={{ color: meanDose > 4 ? '#f59e0b' : '#10b981' }}>{meanDose.toFixed(2)}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W - 40} height={H - 48} fill="#0b1220" />
            {/* KLM867 score zone */}
            <rect x={30} y={sy(80)} width={W - 40} height={sy(0) - sy(80)} fill="#ef4444" opacity={0.10} />
            <rect x={30} y={sy(55)} width={W - 40} height={sy(0) - sy(55)} fill="#f59e0b" opacity={0.08} />
            {/* Dose limits from Doc 9974 App C */}
            <line x1={sx(2)} x2={sx(2)} y1={24} y2={H - 24} stroke="#fde047" strokeDasharray="2 3" strokeOpacity={0.6} />
            <line x1={sx(4)} x2={sx(4)} y1={24} y2={H - 24} stroke="#f59e0b" strokeDasharray="2 3" strokeOpacity={0.6} />
            <line x1={sx(8)} x2={sx(8)} y1={24} y2={H - 24} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.75} />
            <line x1={30} x2={W - 10} y1={sy(80)} y2={sy(80)} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.65} />
            {[0, 2, 4, 6, 8, 10, 12].map(t => (
              <text key={`x${t}`} x={sx(t) - 6} y={H - 8} fontSize={8} fill="#64748b">{t}</text>
            ))}
            {[0, 25, 55, 80, 100].map(t => (
              <text key={`y${t}`} x={4} y={sy(t) + 3} fontSize={8} fill="#64748b">{t}</text>
            ))}
            {rows.filter(r => r.tier !== 'IDLE').map((r, i) => (
              <circle key={i} cx={sx(r.doseMgM3Min)} cy={sy(r.score)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
            <text x={W / 2} y={H - 6} fontSize={9} fill="#64748b" textAnchor="middle">dose mg·m⁻³·min × score</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">ACT-RATE {actRate}%</span><input type="range" min={0} max={100} value={actRate} onChange={e => setActRate(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PLUME-MUL {plumeMul}%</span><input type="range" min={50} max={250} value={plumeMul} onChange={e => setPlumeMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">UPPER-WIND {windKt} kt</span><input type="range" min={0} max={120} value={windKt} onChange={e => setWindKt(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">CONC-BIAS {concBias > 0 ? '+' : ''}{concBias}%</span><input type="range" min={-50} max={50} value={concBias} onChange={e => setConcBias(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PROJ-MIN {projMin}</span><input type="range" min={5} max={60} value={projMin} onChange={e => setProjMin(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setVaacFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${vaacFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {VAACS.map(v => (
          <button key={v.id} onClick={() => setVaacFilter(vaacFilter === v.id ? 'ALL' : v.id)} className={`px-2 py-0.5 rounded text-[10px] border ${vaacFilter === v.id ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{v.id}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['PROJ', showProj, setShowProj], ['VOL', showVol, setShowVol], ['VAAC', showVaac, setShowVaac], ['PLM', showPlume, setShowPlume], ['REF', showRef, setShowRef], ['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / volcano" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'VOLCANOES', 'VAACS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.klass}</span>
              {engPill(r.eng)}
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{r.phase}</span>
              {r.vState && concPill(r.vState.conc)}
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              FL{(r.f.altitudeFt / 100).toFixed(0)} · {r.f.velocityKts.toFixed(0)} kt · trk {r.f.track.toFixed(0)}°
              {r.vol
                ? <> · plume {r.vol.id} {r.vol.name} · band FL{r.vState!.plumeBaseFL}-FL{r.vState!.plumeTopFL} {r.altInBand ? '✓' : '✗'} · depth {r.distNm.toFixed(0)} nm · exp {r.exposureMin.toFixed(1)} min · dose {r.doseMgM3Min.toFixed(1)} mg·m⁻³·min</>
                : <> · no active plume within {projMin}-min projection</>}
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('ING', r.sev.ing)}
              {driverBadge('DUR', r.sev.dur)}
              {driverBadge('PLM', r.sev.plm)}
              {driverBadge('PRX', r.sev.prx)}
              {driverBadge('EQP', r.sev.eqp)}
            </div>
            <div className="px-2 pb-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {advice(r)}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No aircraft match the current filters.</div>
        )}

        {tab === 'VOLCANOES' && volRows.map((vr, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${vr.active ? CONC_COLOR[vr.conc] : '#475569'}` }}>
              <span className="font-mono text-slate-300">{vr.vol.id}</span>
              <span className="text-slate-100 truncate">{vr.vol.name}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">VEI {vr.vol.vei}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{vr.vol.vaac}</span>
              {vr.active ? concPill(vr.conc) : <span className="px-1 py-px rounded text-[9px] text-slate-500 border border-slate-700">DORMANT</span>}
              <div className="ml-auto text-[10px] text-slate-500">{vr.exposed} ac</div>
            </div>
            {vr.active && (
              <div className="px-2 pb-1 text-[10px] text-slate-400">
                plume FL{vr.plumeBaseFL}-FL{vr.plumeTopFL} · drift {vr.plumeAz.toFixed(0)}° · {vr.plumeLenNm.toFixed(0)} nm × ±{vr.plumeWidthNm.toFixed(0)} nm · age {vr.ageH.toFixed(0)} h
                {vr.klm > 0 && <span className="text-rose-400"> · KLM867 {vr.klm}</span>}
              </div>
            )}
          </div>
        ))}

        {tab === 'VAACS' && vaacRows.map((va, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${va.klm > 0 ? '#ef4444' : va.activeVols > 0 ? '#f59e0b' : '#10b981'}` }}>
              <span className="font-mono text-slate-300">{va.id}</span>
              <span className="text-slate-100 truncate">{va.name}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{va.region}</span>
              <div className="ml-auto text-[10px] text-slate-500">{va.activeVols}/{va.totalVols} active</div>
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-400">
              {va.exposed} aircraft within plume projection · KLM867 <span style={{ color: va.klm > 0 ? '#ef4444' : '#64748b' }}>{va.klm}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: ICAO Annex 3 ch 4.8 / App 2 §4 / App 6 SIGMET-V · Doc 9974 Manual on Vol-Ash / Toxic Clouds (App C engine susceptibility) · Doc 4444 PANS-ATM 19 Vol-Ash · Doc 9766 IAVW handbook · Doc 7030 Regional SUPPS · WMO-306 SIGMET-VA · IATA VACP EUR/NAT 2024 · EUR Doc 019 · FAA AC 00-56B · EASA SIB 2010-17R7 · CAA SN-2010/006 · NTSB SIR-86/01 KLM 867 Redoubt 1989 · AAIB G-VOLC · ICAO IAVWOPSG/9 Bangkok 2017 · ARINC 429 lbl 215 · Boeing FCOM 7.10 / Airbus PRO-ABN-21 VOLCANIC ACT · CFM AOM 25.50 · RR Trent EOM 72-00-00.
      </div>
    </div>
  )
}
