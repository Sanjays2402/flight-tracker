'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Lithium-Battery Cargo Thermal Runaway Monitor
   -----------------------------------------------------------
   IATA DGR 65th Ed Section II / ICAO Doc 9284 Technical
   Instructions for the Safe Transport of Dangerous Goods by
   Air / FAA SFAR No.26 lithium-cell shipment restriction /
   EASA Part-SPA.DG / 14 CFR 175.10 Halon-1301 cargo-fire
   suppression compliance watch.

   Synthesises a Pack Acceptance Document (PAD) for every
   airborne aircraft from class-equipage probability plus
   per-airframe FNV-1a hash determining:
     - Class-C (active suppression, sealed) vs Class-E (active
       suppression, crew access) cargo compartment fit
     - Halon-1301 5%-by-volume initial knockdown bottle present
     - Continuous-discharge bottle ratio sized to certified
       diversion time (CDT) per AC 25-9A
     - Onboard fire-containment cover (FCC) DO-364 stowed
     - Per-pack state-of-charge (SoC) banked from hash
     - Per-pack quantity (kg Li equivalent) — bigger fleet
       categories carry more belly cargo

   Risk factors (max-driver compositing 0-100):
     RUNAWAY-PROB  Per-cell stochastic ignition chance from
                   Li-content kg × SoC-correction (Mikolajczak
                   2011: P_runaway ~ kg^0.6 × (SoC/100)^1.8)
                   scaled by KG-MULT slider 50-200%.
     SUPP-GAP      Halon-1301 effectiveness vs diversion-time
                   gap: bottle-min vs DIV-TIME slider 30-330min
                   (FAA AC 25-9A two-engine ETOPS 180-min std).
                   Severity = max(0, (divMin - bottleMin) /
                   divMin * 100) × SUPP-MULT.
     CLASS-FIT     Class-C fully sealed (sev 0). Class-E
                   crew-accessible only acceptable for cargo
                   compartment <1000ft^3 (FAR 25.857). Bigger
                   payloads on Class-E = sev 60+.
     CONTAINMENT   FCC stowed = sev 0. Without FCC, large Li
                   shipments = sev scaled by kg above 5kg.
     ETOPS-MARGIN  Active diversion exposure: if nearest
                   suitable airport > class single-engine
                   range × DIV-TIME, +20 per 30min over.

   Composite score = max(per-factor sev).
   Dominant driver = highest-scoring factor.

   Tier classification:
     CRIT   score>=80  rose    immediate descent / divert
     HIGH   score>=55  amber   precautionary descent
     WATCH  score>=25  sky     monitor temps / position
     OK     score<25   emerald nominal cargo state
     IDLE   ground/no-cargo  slate

   MapLibre overlay:
     - Tier-coloured halo rings sized by composite 8-22 px
     - Dashed amber line to nearest 14 CFR 121.97 alternate
       airport for HIGH+CRIT (capped 800nm)
     - Rose diamond marker at alternate for CRIT
     - Tier-coloured callsign + driver + pack-kg labels for
       non-OK aircraft

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-SCORE / WORST callsign+driver / CRIT count
     - 2-cell HALON-BOTTLE-min mean / CLASS-C share secondary
     - SVG composite-vs-Li-kg scatter with tier-band shading
     - 5 sliders KG-MULT / SUPP-MULT / DIV-TIME / SOC-BIAS /
       MIN-FL in 2-col grid + ETOPS-MARGIN flag toggle
     - 7-class chip filter + HALO/DIV/PIN/LBL/DIAG toggles
     - AIRCRAFT / DRIVERS tab switcher
     - AIRCRAFT tab: sorted tier-worst-first then score desc
     - DRIVERS tab: grouped by dominant driver

   Registered in Layers > Safety & Traffic. Persisted: ft-libat
   ============================================================ */

export interface LiBatFlight {
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
  flights: LiBatFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'WATCH' | 'HIGH' | 'CRIT' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981',
  WATCH: '#0ea5e9',
  HIGH: '#f59e0b',
  CRIT: '#ef4444',
  IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['CRIT', 'HIGH', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { CRIT: 0, HIGH: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Driver = 'RUNAWAY' | 'SUPP-GAP' | 'CLASS' | 'CONTAIN' | 'ETOPS' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  RUNAWAY: 'Runaway probability',
  'SUPP-GAP': 'Halon vs diversion gap',
  CLASS: 'Compartment class',
  CONTAIN: 'Containment gap',
  ETOPS: 'ETOPS alternate margin',
  NONE: 'Nominal',
}

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}
// Typical belly Li-equivalent kg per flight (mean)
const LI_KG_BASE: Record<Klass, number> = {
  heavy: 18, narrow: 6, regional: 2.5, biz: 1, turboprop: 1.2, ga: 0.3, fighter: 0,
}
// P(Class-C sealed compartment)
const CLASS_C_PROB: Record<Klass, number> = {
  heavy: 0.95, narrow: 0.78, regional: 0.40, biz: 0.85, turboprop: 0.20, ga: 0.0, fighter: 0.0,
}
// Halon-1301 bottle continuous-discharge minutes (Class-C cert)
const HALON_MIN: Record<Klass, number> = {
  heavy: 195, narrow: 195, regional: 75, biz: 120, turboprop: 60, ga: 0, fighter: 0,
}
// Single-engine cruise speed kt for diversion arithmetic
const VS_KT: Record<Klass, number> = {
  heavy: 380, narrow: 360, regional: 280, biz: 350, turboprop: 210, ga: 110, fighter: 280,
}

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'ga'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CRJ9|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS)/.test(x)) return 'fighter'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'turboprop'
  return 'narrow'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h >>> 0
}

// 14 CFR 121.97 / EASA CAT.OP.MPA.181 suitable alternates (top hubs/freighter divert)
interface Alt { icao: string; iata: string; name: string; lat: number; lng: number }
const ALTS: Alt[] = [
  { icao: 'KMEM', iata: 'MEM', name: 'Memphis', lat: 35.04, lng: -89.98 },
  { icao: 'KSDF', iata: 'SDF', name: 'Louisville', lat: 38.17, lng: -85.74 },
  { icao: 'KANC', iata: 'ANC', name: 'Anchorage', lat: 61.17, lng: -149.99 },
  { icao: 'KJFK', iata: 'JFK', name: 'New York JFK', lat: 40.64, lng: -73.78 },
  { icao: 'KLAX', iata: 'LAX', name: 'Los Angeles', lat: 33.94, lng: -118.41 },
  { icao: 'KORD', iata: 'ORD', name: 'Chicago O\u2019Hare', lat: 41.98, lng: -87.91 },
  { icao: 'KDFW', iata: 'DFW', name: 'Dallas/Ft Worth', lat: 32.90, lng: -97.04 },
  { icao: 'KMIA', iata: 'MIA', name: 'Miami', lat: 25.79, lng: -80.29 },
  { icao: 'KSEA', iata: 'SEA', name: 'Seattle', lat: 47.45, lng: -122.31 },
  { icao: 'KHNL', iata: 'HNL', name: 'Honolulu', lat: 21.32, lng: -157.92 },
  { icao: 'PHNL', iata: 'HNL', name: 'Honolulu', lat: 21.32, lng: -157.92 },
  { icao: 'CYYZ', iata: 'YYZ', name: 'Toronto', lat: 43.68, lng: -79.63 },
  { icao: 'CYVR', iata: 'YVR', name: 'Vancouver', lat: 49.19, lng: -123.18 },
  { icao: 'EGLL', iata: 'LHR', name: 'London Heathrow', lat: 51.47, lng: -0.46 },
  { icao: 'EGCC', iata: 'MAN', name: 'Manchester', lat: 53.35, lng: -2.27 },
  { icao: 'BIKF', iata: 'KEF', name: 'Keflavik', lat: 63.985, lng: -22.605 },
  { icao: 'EINN', iata: 'SNN', name: 'Shannon', lat: 52.70, lng: -8.92 },
  { icao: 'LFPG', iata: 'CDG', name: 'Paris CDG', lat: 49.01, lng: 2.55 },
  { icao: 'EDDF', iata: 'FRA', name: 'Frankfurt', lat: 50.03, lng: 8.56 },
  { icao: 'EHAM', iata: 'AMS', name: 'Amsterdam', lat: 52.31, lng: 4.76 },
  { icao: 'EDDP', iata: 'LEJ', name: 'Leipzig', lat: 51.43, lng: 12.24 },
  { icao: 'LSZH', iata: 'ZRH', name: 'Zurich', lat: 47.46, lng: 8.55 },
  { icao: 'LEMD', iata: 'MAD', name: 'Madrid', lat: 40.49, lng: -3.57 },
  { icao: 'LIRF', iata: 'FCO', name: 'Rome FCO', lat: 41.80, lng: 12.25 },
  { icao: 'LTBA', iata: 'IST', name: 'Istanbul (old)', lat: 40.98, lng: 28.81 },
  { icao: 'LTFM', iata: 'IST', name: 'Istanbul', lat: 41.26, lng: 28.74 },
  { icao: 'OMDB', iata: 'DXB', name: 'Dubai', lat: 25.25, lng: 55.36 },
  { icao: 'OTHH', iata: 'DOH', name: 'Doha', lat: 25.27, lng: 51.61 },
  { icao: 'OEJN', iata: 'JED', name: 'Jeddah', lat: 21.68, lng: 39.15 },
  { icao: 'HAAB', iata: 'ADD', name: 'Addis Ababa', lat: 8.98, lng: 38.80 },
  { icao: 'FAOR', iata: 'JNB', name: 'Johannesburg', lat: -26.13, lng: 28.24 },
  { icao: 'VIDP', iata: 'DEL', name: 'Delhi', lat: 28.55, lng: 77.10 },
  { icao: 'VABB', iata: 'BOM', name: 'Mumbai', lat: 19.09, lng: 72.87 },
  { icao: 'VHHH', iata: 'HKG', name: 'Hong Kong', lat: 22.31, lng: 113.92 },
  { icao: 'ZSPD', iata: 'PVG', name: 'Shanghai PVG', lat: 31.14, lng: 121.81 },
  { icao: 'ZBAA', iata: 'PEK', name: 'Beijing', lat: 40.08, lng: 116.59 },
  { icao: 'RJAA', iata: 'NRT', name: 'Tokyo Narita', lat: 35.77, lng: 140.39 },
  { icao: 'RKSI', iata: 'ICN', name: 'Seoul Incheon', lat: 37.46, lng: 126.44 },
  { icao: 'WSSS', iata: 'SIN', name: 'Singapore', lat: 1.36, lng: 103.99 },
  { icao: 'YSSY', iata: 'SYD', name: 'Sydney', lat: -33.94, lng: 151.18 },
  { icao: 'YBBN', iata: 'BNE', name: 'Brisbane', lat: -27.38, lng: 153.12 },
  { icao: 'YPPH', iata: 'PER', name: 'Perth', lat: -31.94, lng: 115.97 },
  { icao: 'NZAA', iata: 'AKL', name: 'Auckland', lat: -37.01, lng: 174.79 },
  { icao: 'SBGR', iata: 'GRU', name: 'Sao Paulo', lat: -23.43, lng: -46.47 },
  { icao: 'SAEZ', iata: 'EZE', name: 'Buenos Aires', lat: -34.82, lng: -58.54 },
  { icao: 'SKBO', iata: 'BOG', name: 'Bogota', lat: 4.70, lng: -74.14 },
  { icao: 'MMMX', iata: 'MEX', name: 'Mexico City', lat: 19.44, lng: -99.07 },
  { icao: 'PANC', iata: 'ANC', name: 'Anchorage', lat: 61.17, lng: -149.99 },
  { icao: 'PHTO', iata: 'ITO', name: 'Hilo', lat: 19.72, lng: -155.05 },
]

function greatCircleNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const dφ = ((lat2 - lat1) * Math.PI) / 180
  const dλ = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function nearestAlt(lat: number, lng: number): { alt: Alt; distNm: number } {
  let best = ALTS[0]
  let bestD = Infinity
  for (const a of ALTS) {
    const d = greatCircleNm(lat, lng, a.lat, a.lng)
    if (d < bestD) { bestD = d; best = a }
  }
  return { alt: best, distNm: bestD }
}

interface Row {
  f: LiBatFlight
  klass: Klass
  flCur: number
  // pack state
  liKg: number
  socPct: number
  // compartment / suppression
  classC: boolean
  halonMin: number
  fccStowed: boolean
  // alternate
  alt: Alt
  altNm: number
  divMinReq: number
  // factor severities
  runawaySev: number
  suppSev: number
  classSev: number
  containSev: number
  etopsSev: number
  // composite
  score: number
  tier: Tier
  driver: Driver
}

const SRC_HALO = 'libat-halo', SRC_LBL = 'libat-lbl', SRC_PIN = 'libat-pin', SRC_LINE = 'libat-line'
const LYR_HALO = 'libat-halo-l', LYR_LBL = 'libat-lbl-l', LYR_PIN = 'libat-pin-l', LYR_LINE = 'libat-line-l'

export default function LiBattery({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'DRIVERS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [kgMult, setKgMult] = useState(100)
  const [suppMult, setSuppMult] = useState(100)
  const [divTime, setDivTime] = useState(180)     // min ETOPS-180 std
  const [socBias, setSocBias] = useState(60)      // mean SoC at acceptance
  const [minFl, setMinFl] = useState(20)
  const [etopsCheck, setEtopsCheck] = useState(true)
  const [showHalo, setShowHalo] = useState(true)
  const [showLine, setShowLine] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const flCur = (f.altitudeFt || 0) / 100
      if (flCur < minFl) continue
      const klass = classify(f.type, f.category)
      const h = hash32(f.icao)
      const r1 = ((h & 0xffff) / 0xffff)
      const r2 = (((h >>> 16) & 0xffff) / 0xffff)
      const r3 = (((h * 2654435761) >>> 0) & 0xffff) / 0xffff
      const r4 = (((h * 40503) >>> 0) & 0xffff) / 0xffff

      // Pack quantity log-normal-ish around class base
      const liKg = Math.max(0, LI_KG_BASE[klass] * (0.4 + 1.4 * r1)) * (kgMult / 100)
      // SoC ± 30% around bias slider
      const socPct = Math.max(5, Math.min(100, socBias + (r2 - 0.5) * 60))
      // Compartment class
      const classC = r3 < CLASS_C_PROB[klass]
      // Halon bottle minutes — Class-C has full bottle, Class-E partial
      const halonMin = classC ? HALON_MIN[klass] : Math.round(HALON_MIN[klass] * 0.35)
      // Fire containment cover stowed (FAA InFO 16016) — higher in heavy/biz
      const fccProb = klass === 'heavy' ? 0.85 : klass === 'biz' ? 0.7 : klass === 'narrow' ? 0.55 : 0.25
      const fccStowed = r4 < fccProb

      // RUNAWAY-PROB: Mikolajczak fit, log-scaled to 0-100
      // base prob per pack ~ kg^0.6 * (SoC/100)^1.8
      const baseP = Math.pow(Math.max(0.01, liKg), 0.6) * Math.pow(socPct / 100, 1.8)
      const runawaySev = Math.min(100, baseP * 14)

      // SUPP-GAP: Halon bottle vs diversion time
      const suppGap = Math.max(0, divTime - halonMin)
      const suppSev = Math.min(100, suppGap / Math.max(30, divTime) * 100) * (suppMult / 100)

      // CLASS-FIT: Class-E with >5kg Li = bad
      const classSev = classC ? 0 : Math.min(100, Math.max(0, (liKg - 3) * 9))

      // CONTAINMENT: no FCC + >5kg = bad
      const containSev = fccStowed ? 0 : Math.min(100, Math.max(0, (liKg - 4) * 8))

      // ETOPS-MARGIN: distance to nearest alternate vs single-engine reach
      const { alt, distNm } = nearestAlt(f.lat, f.lng)
      const divMinReq = (distNm / VS_KT[klass]) * 60
      const etopsSev = etopsCheck
        ? Math.min(100, Math.max(0, (divMinReq - divTime) / 30 * 20))
        : 0

      const drivers: Array<{ k: Driver; v: number }> = [
        { k: 'RUNAWAY', v: runawaySev },
        { k: 'SUPP-GAP', v: suppSev },
        { k: 'CLASS', v: classSev },
        { k: 'CONTAIN', v: containSev },
        { k: 'ETOPS', v: etopsSev },
      ]
      drivers.sort((a, b) => b.v - a.v)
      const score = drivers[0].v
      const driver: Driver = score < 1 ? 'NONE' : drivers[0].k
      const tier: Tier = liKg < 0.05 ? 'IDLE' :
        score >= 80 ? 'CRIT' :
        score >= 55 ? 'HIGH' :
        score >= 25 ? 'WATCH' : 'OK'

      out.push({
        f, klass, flCur,
        liKg, socPct,
        classC, halonMin, fccStowed,
        alt, altNm: distNm, divMinReq,
        runawaySev, suppSev, classSev, containSev, etopsSev,
        score, tier, driver,
      })
    }
    return out
  }, [flights, kgMult, suppMult, divTime, socBias, minFl, etopsCheck])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, WATCH: 0, HIGH: 0, CRIT: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    const n = Math.max(1, rows.length)
    const meanScore = rows.reduce((a, b) => a + b.score, 0) / n
    const meanHalon = rows.reduce((a, b) => a + b.halonMin, 0) / n
    const classCcount = rows.filter(r => r.classC).length
    let worst: Row | null = null
    for (const r of rows) if (!worst || r.score > worst.score) worst = r
    const crit = rows.filter(r => r.tier === 'CRIT').length
    return {
      meanScore, meanHalon, crit, classCcount, totalAc: rows.length,
      worstCs: worst ? (worst.f.callsign || worst.f.icao).trim() : '',
      worstScore: worst ? worst.score : 0,
      worstDriver: worst ? worst.driver : ('NONE' as Driver),
    }
  }, [rows])

  const driverAggs = useMemo(() => {
    const map = new Map<Driver, Row[]>()
    for (const r of rows) {
      if (r.driver === 'NONE') continue
      if (!map.has(r.driver)) map.set(r.driver, [])
      map.get(r.driver)!.push(r)
    }
    const arr = Array.from(map.entries()).map(([driver, list]) => {
      const meanScore = list.reduce((a, b) => a + b.score, 0) / list.length
      const worstTier = list.reduce((acc, r) => TIER_RANK[r.tier] < TIER_RANK[acc] ? r.tier : acc, 'OK' as Tier)
      const crit = list.filter(r => r.tier === 'CRIT').length
      const high = list.filter(r => r.tier === 'HIGH').length
      let worstRow = list[0]
      for (const r of list) if (r.score > worstRow.score) worstRow = r
      return { driver, count: list.length, meanScore, worstTier, crit, high, list, worstRow }
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
        if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.alt.iata, r.alt.icao].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, klassFilter, query])

  // ---- MapLibre layers ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + Math.min(14, r.score / 7) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'OK' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${r.driver} ${r.liKg.toFixed(1)}kg`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const divRows = rows.filter(r => (r.tier === 'HIGH' || r.tier === 'CRIT') && r.altNm < 1200)
    const lineFc = { type: 'FeatureCollection' as const, features: showLine ? divRows.map(r => {
      // sample great circle 16 segments for nice arc
      const pts: [number, number][] = []
      const lat1 = r.f.lat * Math.PI / 180, lng1 = r.f.lng * Math.PI / 180
      const lat2 = r.alt.lat * Math.PI / 180, lng2 = r.alt.lng * Math.PI / 180
      const d = 2 * Math.asin(Math.sqrt(Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lng2 - lng1) / 2) ** 2))
      for (let i = 0; i <= 16; i++) {
        const t = i / 16
        if (d < 1e-6) { pts.push([r.f.lng, r.f.lat]); continue }
        const A = Math.sin((1 - t) * d) / Math.sin(d)
        const B = Math.sin(t * d) / Math.sin(d)
        const x = A * Math.cos(lat1) * Math.cos(lng1) + B * Math.cos(lat2) * Math.cos(lng2)
        const y = A * Math.cos(lat1) * Math.sin(lng1) + B * Math.cos(lat2) * Math.sin(lng2)
        const z = A * Math.sin(lat1) + B * Math.sin(lat2)
        const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) * 180 / Math.PI
        const lng = Math.atan2(y, x) * 180 / Math.PI
        pts.push([lng, lat])
      }
      return {
        type: 'Feature' as const,
        properties: { color: TIER_COLOR[r.tier] },
        geometry: { type: 'LineString' as const, coordinates: pts },
      }
    }) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'CRIT' && r.altNm < 1200).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `›${r.alt.iata} ${Math.round(r.altNm)}nm` },
      geometry: { type: 'Point' as const, coordinates: [r.alt.lng, r.alt.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_LINE, lineFc, () => map.addLayer({ id: LYR_LINE, type: 'line', source: SRC_LINE, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.4,
        'line-opacity': 0.75,
        'line-dasharray': [2, 3],
      } }))
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.4,
        'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-anchor': 'top',
        'text-offset': [0, 0.8],
        'icon-allow-overlap': true,
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.6,
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-offset': [0, 1.6],
        'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.2,
      } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINE]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_LINE]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showLine])

  // Diagram: composite score (y, 0-100) vs Li-kg (x, log-ish 0-40kg)
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 28
    const xMin = 0, xMax = 40, yMax = 100
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * (W - PAD - 6)
    const ys = (s: number) => 6 + (1 - Math.max(0, Math.min(1, s / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Li-Battery Cargo</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} ac airborne</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Score</div>
          <div className="font-mono text-sm" style={{ color: summary.meanScore >= 55 ? '#f59e0b' : summary.meanScore >= 25 ? '#0ea5e9' : '#10b981' }}>
            {summary.meanScore.toFixed(1)}<span className="text-[9px] text-slate-500"> /100</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstScore.toFixed(0)}` : '\u2014'}
          </div>
          <div className="font-mono text-[9px] text-slate-500 truncate">{summary.worstDriver}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Crit</div>
          <div className="font-mono text-sm" style={{ color: summary.crit > 0 ? '#ef4444' : '#10b981' }}>{summary.crit}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Halon Min</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanHalon < divTime ? '#f59e0b' : '#10b981' }}>
            {summary.meanHalon.toFixed(0)}<span className="text-[9px] text-slate-500"> /{divTime}</span>
          </div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Class-C Share</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.classCcount}<span className="text-[9px] text-slate-500"> /{summary.totalAc}</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Composite 0-100 vs Li-kg pack mass</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[
              { lo: 0, hi: 25, c: '#10b981' },
              { lo: 25, hi: 55, c: '#0ea5e9' },
              { lo: 55, hi: 80, c: '#f59e0b' },
              { lo: 80, hi: 100, c: '#ef4444' },
            ].map((b, i) => (
              <rect key={i} x={diag.PAD} y={diag.ys(b.hi)} width={diag.W - diag.PAD - 6} height={Math.max(0, diag.ys(b.lo) - diag.ys(b.hi))} fill={b.c} opacity={0.06} />
            ))}
            {[25, 55, 80].map(t => (
              <line key={t} x1={diag.PAD} y1={diag.ys(t)} x2={diag.W - 6} y2={diag.ys(t)} stroke={t === 25 ? '#0ea5e9' : t === 55 ? '#f59e0b' : '#ef4444'} strokeWidth={0.9} strokeDasharray="3 2" opacity={0.75} />
            ))}
            {[5, 10, 20, 30].map(x => (
              <g key={x}>
                <line x1={diag.xs(x)} y1={6} x2={diag.xs(x)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(x)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{x}kg</text>
              </g>
            ))}
            {[25, 50, 75, 100].map(s => (
              <text key={s} x={diag.PAD - 2} y={diag.ys(s) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{s}</text>
            ))}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(Math.min(diag.xMax, r.liKg))} cy={diag.ys(Math.min(diag.yMax, r.score))} r={3} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>KG-MULT</span><span className="font-mono text-slate-300">{kgMult}%</span></div>
            <input type="range" min={50} max={200} step={5} value={kgMult} onChange={e => setKgMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>SUPP-MULT</span><span className="font-mono text-slate-300">{suppMult}%</span></div>
            <input type="range" min={50} max={200} step={5} value={suppMult} onChange={e => setSuppMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>DIV-TIME</span><span className="font-mono text-slate-300">{divTime}m</span></div>
            <input type="range" min={30} max={330} step={15} value={divTime} onChange={e => setDivTime(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>SOC-BIAS</span><span className="font-mono text-slate-300">{socBias}%</span></div>
            <input type="range" min={20} max={95} step={5} value={socBias} onChange={e => setSocBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">F{minFl}</span></div>
          <input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klassFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['heavy', 'narrow', 'regional', 'biz', 'turboprop', 'ga', 'fighter'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klassFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{KLASS_LABEL[k]}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLine} onChange={e => setShowLine(e.target.checked)} className="accent-sky-500" /><span>DIV</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={etopsCheck} onChange={e => setEtopsCheck(e.target.checked)} className="accent-sky-500" /><span>ETOPS</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / alt"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'DRIVERS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} ac` : `${driverAggs.length} drivers active`}</span>
        <span>{tab === 'AIRCRAFT' ? 'score · driver · alt · tier' : 'mean · worst · count'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No airborne aircraft above MIN-FL.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const sevPct = Math.min(100, r.score)
          const advice =
            r.tier === 'CRIT' && r.driver === 'RUNAWAY' ? 'high runaway probability · descend FL250 cool cargo bay request divert' :
            r.tier === 'CRIT' && r.driver === 'SUPP-GAP' ? `Halon bottle ${r.halonMin}m < div ${divTime}m · turn back to ${r.alt.iata}` :
            r.tier === 'CRIT' && r.driver === 'CLASS' ? 'Class-E pack overload · violates IATA DGR Section II · ground at next port' :
            r.tier === 'CRIT' && r.driver === 'CONTAIN' ? 'no FCC stowed · request fire-containment cover or jettison capability' :
            r.tier === 'CRIT' && r.driver === 'ETOPS' ? `no alternate within ${divTime}m · enroute beyond Halon coverage` :
            r.tier === 'HIGH' && r.driver === 'RUNAWAY' ? 'runaway risk elevated · monitor BTU smoke detector loop A+B' :
            r.tier === 'HIGH' && r.driver === 'SUPP-GAP' ? `bottle margin tight · plan early descent to ${r.alt.iata}` :
            r.tier === 'HIGH' && r.driver === 'CLASS' ? 'Class-E payload review · consider downgauge' :
            r.tier === 'HIGH' && r.driver === 'CONTAIN' ? 'containment marginal · brief crew on FCC location' :
            r.tier === 'HIGH' && r.driver === 'ETOPS' ? `alternate ${r.alt.iata} ${Math.round(r.altNm)}nm · review diversion plan` :
            r.tier === 'WATCH' ? 'within DGR envelope · monitor cargo bay temps' :
            r.tier === 'IDLE' ? 'no significant Li shipment' :
            'nominal cargo state'
          const classCText = r.classC ? 'C' : 'E'
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{KLASS_LABEL[r.klass]}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="flight level">F{Math.round(r.flCur)}</span>
                  <span title="Li kg" style={{ color: r.liKg >= 10 ? TIER_COLOR['HIGH'] : '#94a3b8' }}>{r.liKg.toFixed(1)}kg</span>
                  <span title="SoC">{r.socPct.toFixed(0)}%SoC</span>
                  <span title="Halon bottle minutes" style={{ color: r.halonMin < divTime ? TIER_COLOR['HIGH'] : '#94a3b8' }}>H{r.halonMin}m</span>
                  <span className="ml-auto truncate" title="dominant driver" style={{ color: TIER_COLOR[r.tier] }}>{r.driver}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="composite risk 0-100">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${sevPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: '25%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '55%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '80%' }} />
                </div>
                <div className="grid grid-cols-5 gap-1 mt-1 text-[9px] font-mono">
                  {([
                    { lbl: 'RUN', v: r.runawaySev },
                    { lbl: 'SUP', v: r.suppSev },
                    { lbl: `CL${classCText}`, v: r.classSev },
                    { lbl: r.fccStowed ? 'FCC' : 'fcc', v: r.containSev },
                    { lbl: 'ETP', v: r.etopsSev },
                  ] as const).map((b, i) => {
                    const tt: Tier = b.v >= 80 ? 'CRIT' : b.v >= 55 ? 'HIGH' : b.v >= 25 ? 'WATCH' : 'OK'
                    return (
                      <span key={i} className="px-1 py-0 rounded border text-center" style={{ borderColor: TIER_COLOR[tt] + '66', color: TIER_COLOR[tt] }}>{b.lbl} {b.v.toFixed(0)}</span>
                    )
                  })}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="nearest alternate">›{r.alt.iata} {Math.round(r.altNm)}nm</span>
                  <span title="div min required" style={{ color: r.divMinReq > divTime ? TIER_COLOR['HIGH'] : '#64748b' }}>{r.divMinReq.toFixed(0)}m</span>
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' || r.tier === 'IDLE' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'DRIVERS' && driverAggs.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No active risk drivers.</div>
        )}
        {tab === 'DRIVERS' && driverAggs.map(z => {
          const pct = Math.min(100, z.meanScore)
          const advice = z.worstTier === 'CRIT' ? 'CRIT aircraft in driver group · initiate descent + divert' :
            z.worstTier === 'HIGH' ? 'HIGH aircraft present · brief crews / review plan' :
            z.worstTier === 'WATCH' ? 'within envelope · routine monitoring' :
            'nominal cargo state'
          return (
            <button key={z.driver} onClick={() => onFly(z.worstRow.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[z.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{z.driver}</span>
                  <span className="text-slate-500 truncate">{DRIVER_LABEL[z.driver]}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{z.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[z.worstTier] }}>{z.worstTier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span style={{ color: TIER_COLOR[z.worstTier] }}>mean {z.meanScore.toFixed(1)}</span>
                  <span>worst {(z.worstRow.f.callsign || z.worstRow.f.icao).trim()} {z.worstRow.score.toFixed(0)}</span>
                  <span className="ml-auto">C{z.crit} H{z.high}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="driver mean score">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: TIER_COLOR[z.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: '25%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '55%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '80%' }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate">DGR Section II / Doc 9284</span>
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
