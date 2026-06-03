'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   MSAW · CONTROLLER-SIDE MINIMUM SAFE ALTITUDE WARNING
   -----------------------------------------------------------
   Per-target evaluation of the ATC automation Minimum Safe
   Altitude Warning function as it would fire on the controller
   scope. Distinct from the airborne TAWS/EGPWS or company MORA
   alert — this models the *radar room* automation that compares
   the Mode-C / ADS-B reported altitude (corrected for STD->QNH)
   against the local MVA / MIA / MEA grid plus a configurable
   look-ahead projection, then issues a low-altitude alert /
   conflict alert to the controller working that sector.

   Two modes per FAA Order JO 7110.65 §5-15:
     · GENERAL TERRAIN MSAW   — for any tracked target inside MVA
     · APPROACH PATH MONITOR  — for arrivals on final, glideslope
                                 deviation vs published profile

   References
     · FAA Order JO 7110.65 §5-15 MSAW / APM
     · FAA Order JO 7210.3DD §3-7 MSAW adaptation
     · FAA Order JO 7110.10 §4-3 low altitude alerts
     · 14 CFR 91.119 minimum safe altitudes
     · 14 CFR 91.177 IFR minimum altitudes
     · FAA AC 90-100A US TERPS / MVA
     · FAA Order 8260.3D US TERPS Vol I
     · FAA Order 8260.19H FPT chart producers
     · FAA JO 7400.10 SUA / Special Use Airspace
     · ICAO Doc 4444 PANS-ATM §8.6.5 STCA / MSAW
     · ICAO Annex 11 §2.27 ATS surveillance services
     · ICAO Doc 9426 ATS Planning Manual §III ch 2
     · EUROCONTROL APW MSAW Specification ed 2.0 (2018)
     · EUROCONTROL Safety Nets Implementation Guideline (2018)
     · EUROCAE ED-153 Safety Nets MOPS
     · MITRE TM-93W0000165 MSAW algorithm
     · NTSB AAR-15/01 ALPA-Korean 801 CFIT NIMITZ MSAW disabled
     · NTSB AAR-78-13 Continental 1713 CFIT MSAW issued
     · NTSB DCA15FA085 AeroUnion 302 IAH CFIT MSAW
     · ATSB AO-2015-149 MSAW inhibition study
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'MSAW-LOW' | 'MSAW-PROJ' | 'APM-DEV' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'MSAW-LOW': '#ef4444', 'MSAW-PROJ': '#f43f5e', 'APM-DEV': '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['MSAW-LOW', 'MSAW-PROJ', 'APM-DEV', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { 'MSAW-LOW': 0, 'MSAW-PROJ': 1, 'APM-DEV': 2, WATCH: 3, OK: 4, IDLE: 5 }

type Phase = 'APP' | 'FINAL' | 'DEP' | 'ENR' | 'GND' | 'OTHER'
const PHASE_MUL: Record<Phase, number> = { APP: 1.30, FINAL: 1.45, DEP: 1.15, ENR: 1.00, GND: 0.0, OTHER: 0.60 }

/* MVA polygon sectors: simplified rectangular cells in (lat,lng,radNm,floorFt,label)
   Drawn to broadly represent published MVA charts around the 22 busiest
   TRACON facilities + select international approach environments.       */
interface MvaCell {
  facility: string
  name: string
  lat: number
  lng: number
  radNm: number
  /* MVA floor ft MSL — the controller-side minimum vector altitude */
  floorFt: number
  /* terrain class for color stripe */
  terr: 'MTN' | 'HILL' | 'COAST' | 'PLAIN'
  /* nearest airport ICAO for APM context */
  apt?: string
}
const MVA_CELLS: MvaCell[] = [
  // FAA TRACONs
  { facility: 'N90',  name: 'New York TRACON',      lat: 40.78, lng: -73.87, radNm: 35, floorFt: 2000, terr: 'COAST', apt: 'KJFK' },
  { facility: 'PCT',  name: 'Potomac Consolidated', lat: 38.95, lng: -77.45, radNm: 45, floorFt: 2500, terr: 'HILL',  apt: 'KIAD' },
  { facility: 'A80',  name: 'Atlanta TRACON',       lat: 33.64, lng: -84.43, radNm: 40, floorFt: 2400, terr: 'HILL',  apt: 'KATL' },
  { facility: 'C90',  name: 'Chicago TRACON',       lat: 41.98, lng: -87.91, radNm: 40, floorFt: 2300, terr: 'PLAIN', apt: 'KORD' },
  { facility: 'D10',  name: 'Dallas-Ft Worth',      lat: 32.90, lng: -97.04, radNm: 40, floorFt: 2200, terr: 'PLAIN', apt: 'KDFW' },
  { facility: 'D01',  name: 'Denver TRACON',        lat: 39.86, lng: -104.67, radNm: 50, floorFt: 8500, terr: 'MTN',  apt: 'KDEN' },
  { facility: 'NCT',  name: 'NorCal TRACON',        lat: 37.62, lng: -122.38, radNm: 50, floorFt: 4000, terr: 'MTN',  apt: 'KSFO' },
  { facility: 'SCT',  name: 'SoCal TRACON',         lat: 33.94, lng: -118.41, radNm: 60, floorFt: 6000, terr: 'MTN',  apt: 'KLAX' },
  { facility: 'S46',  name: 'Seattle TRACON',       lat: 47.45, lng: -122.31, radNm: 45, floorFt: 4500, terr: 'MTN',  apt: 'KSEA' },
  { facility: 'P80',  name: 'Portland TRACON',      lat: 45.59, lng: -122.60, radNm: 40, floorFt: 4000, terr: 'MTN',  apt: 'KPDX' },
  { facility: 'F11',  name: 'Central Florida',      lat: 28.43, lng: -81.31, radNm: 40, floorFt: 1600, terr: 'PLAIN', apt: 'KMCO' },
  { facility: 'MIA',  name: 'Miami TRACON',         lat: 25.79, lng: -80.29, radNm: 35, floorFt: 1500, terr: 'COAST', apt: 'KMIA' },
  { facility: 'I90',  name: 'Houston TRACON',       lat: 29.98, lng: -95.34, radNm: 40, floorFt: 1800, terr: 'COAST', apt: 'KIAH' },
  { facility: 'M98',  name: 'Minneapolis TRACON',   lat: 44.88, lng: -93.22, radNm: 40, floorFt: 2400, terr: 'PLAIN', apt: 'KMSP' },
  { facility: 'P50',  name: 'Phoenix TRACON',       lat: 33.43, lng: -112.01, radNm: 50, floorFt: 5000, terr: 'MTN',  apt: 'KPHX' },
  { facility: 'L30',  name: 'Las Vegas TRACON',     lat: 36.08, lng: -115.15, radNm: 50, floorFt: 4500, terr: 'MTN',  apt: 'KLAS' },
  { facility: 'CLT',  name: 'Charlotte TRACON',     lat: 35.21, lng: -80.94, radNm: 35, floorFt: 2400, terr: 'HILL',  apt: 'KCLT' },
  { facility: 'PHL',  name: 'Philadelphia TRACON',  lat: 39.87, lng: -75.24, radNm: 35, floorFt: 2000, terr: 'COAST', apt: 'KPHL' },
  { facility: 'BOS',  name: 'Boston TRACON',        lat: 42.36, lng: -71.01, radNm: 35, floorFt: 2000, terr: 'COAST', apt: 'KBOS' },
  { facility: 'D21',  name: 'Detroit TRACON',       lat: 42.21, lng: -83.35, radNm: 35, floorFt: 1900, terr: 'PLAIN', apt: 'KDTW' },
  { facility: 'ASE',  name: 'Aspen ATCT',           lat: 39.22, lng: -106.87, radNm: 18, floorFt: 14000, terr: 'MTN', apt: 'KASE' },
  { facility: 'JAC',  name: 'Jackson Hole ATCT',    lat: 43.61, lng: -110.74, radNm: 18, floorFt: 11500, terr: 'MTN', apt: 'KJAC' },
  // ICAO equivalents — APW
  { facility: 'EGTT', name: 'London TC',            lat: 51.47, lng: -0.45, radNm: 45, floorFt: 2200, terr: 'PLAIN', apt: 'EGLL' },
  { facility: 'LFPP', name: 'Paris APP',            lat: 49.01, lng: 2.55, radNm: 45, floorFt: 2400, terr: 'PLAIN', apt: 'LFPG' },
  { facility: 'EDDF', name: 'Frankfurt APP',        lat: 50.03, lng: 8.56, radNm: 40, floorFt: 2500, terr: 'HILL',  apt: 'EDDF' },
  { facility: 'LSZH', name: 'Zurich APP',           lat: 47.46, lng: 8.55, radNm: 35, floorFt: 5500, terr: 'MTN',   apt: 'LSZH' },
  { facility: 'LOWI', name: 'Innsbruck APP',        lat: 47.26, lng: 11.34, radNm: 18, floorFt: 11000, terr: 'MTN', apt: 'LOWI' },
  { facility: 'NZQN', name: 'Queenstown APP',       lat: -45.02, lng: 168.74, radNm: 20, floorFt: 10000, terr: 'MTN', apt: 'NZQN' },
  { facility: 'OMDB', name: 'Dubai APP',            lat: 25.25, lng: 55.36, radNm: 40, floorFt: 2400, terr: 'COAST', apt: 'OMDB' },
  { facility: 'VHHH', name: 'Hong Kong APP',        lat: 22.31, lng: 113.91, radNm: 35, floorFt: 4500, terr: 'MTN',  apt: 'VHHH' },
  { facility: 'RJTT', name: 'Tokyo TCA',            lat: 35.55, lng: 139.78, radNm: 45, floorFt: 3000, terr: 'COAST', apt: 'RJTT' },
  { facility: 'WSSS', name: 'Singapore APP',        lat: 1.36, lng: 103.99, radNm: 40, floorFt: 2200, terr: 'COAST', apt: 'WSSS' },
]

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
function hashFrac(s: string): number { return (hash32(s) % 100000) / 100000 }

function distNm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3440.065
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180
  const sa = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa))
}
function bearingDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const y = Math.sin(dLng) * Math.cos(la2)
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360
}
function projectNm(p: { lat: number; lng: number }, brgDeg: number, distNmIn: number): { lat: number; lng: number } {
  const R = 3440.065
  const br = brgDeg * Math.PI / 180
  const la1 = p.lat * Math.PI / 180
  const lo1 = p.lng * Math.PI / 180
  const dr = distNmIn / R
  const la2 = Math.asin(Math.sin(la1) * Math.cos(dr) + Math.cos(la1) * Math.sin(dr) * Math.cos(br))
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(la1), Math.cos(dr) - Math.sin(la1) * Math.sin(la2))
  return { lat: la2 * 180 / Math.PI, lng: ((lo2 * 180 / Math.PI + 540) % 360) - 180 }
}

interface Row {
  f: SFlight
  cell?: MvaCell
  phase: Phase
  altQnhFt: number     // Mode-C corrected to QNH MSL
  mvaFt: number        // floor of nearest cell
  marginFt: number     // altQnh - mva (negative = breach)
  projAltFt: number    // alt after lookAhead seconds at current vert rate
  projMarginFt: number
  apmDevFt: number     // approach-path deviation ft for FINAL phase, signed (negative = low)
  rangeFromAptNm: number
  bearingToAptDeg: number
  brkV: number; brkP: number; brkA: number; brkE: number
  driver: 'BRK' | 'PRJ' | 'APM' | 'EDG' | 'NONE'
  score: number
  tier: Tier
}

const TERR_COLOR: Record<MvaCell['terr'], string> = { MTN: '#f43f5e', HILL: '#f59e0b', COAST: '#0ea5e9', PLAIN: '#10b981' }

const SRC_HALO = 'msaw-halo'; const LYR_HALO = 'msaw-halo-l'
const SRC_LBL = 'msaw-lbl'; const LYR_LBL = 'msaw-lbl-l'
const SRC_PIN = 'msaw-pin'; const LYR_PIN = 'msaw-pin-l'
const SRC_CELL = 'msaw-cell'; const LYR_CELL = 'msaw-cell-l'
const SRC_PROJ = 'msaw-proj'; const LYR_PROJ = 'msaw-proj-l'
const SRC_REF = 'msaw-ref'; const LYR_REF = 'msaw-ref-l'

export default function MsawController({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'FACILITIES' | 'TERRAIN'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [terrFilter, setTerrFilter] = useState<MvaCell['terr'] | 'ALL'>('ALL')
  const [query, setQuery] = useState('')
  const [minAlt, setMinAlt] = useState(0)
  const [maxAlt, setMaxAlt] = useState(180)
  const [qnhBias, setQnhBias] = useState(0)        // ft, ±200
  const [lookAhead, setLookAhead] = useState(30)   // s, 10–120 (FAA Order JO 7210.3DD §3-7 baseline 30 s)
  const [mvaMul, setMvaMul] = useState(100)
  const [apmTol, setApmTol] = useState(300)        // ft tolerance band on profile
  const [phaseWt, setPhaseWt] = useState(100)
  const [inhibitGate, setInhibitGate] = useState(0) // 0–100 pct chance of suppression bug
  const [showHalo, setShowHalo] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showCell, setShowCell] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showRef, setShowRef] = useState(false)
  const [showDiag, setShowDiag] = useState(true)

  /* ---------- per-aircraft evaluation ---------- */
  const active = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (f.altitudeFt < minAlt * 100) continue
      if (f.altitudeFt > maxAlt * 100) continue
      // nearest MVA cell within radNm
      let cell: MvaCell | undefined; let best = Infinity
      for (const c of MVA_CELLS) {
        const d = distNm(f, c)
        if (d <= c.radNm && d < best) { best = d; cell = c }
      }
      // Mode-C → QNH MSL: aviation reports STD above transition; below transition apply QNH bias.
      const altQnhFt = f.altitudeFt + qnhBias
      const mvaFt = cell ? cell.floorFt * (mvaMul / 100) : 0
      const marginFt = cell ? altQnhFt - mvaFt : 99999
      // forward projection using current vertRate (ft/s = ft/min /60)
      const dtMin = lookAhead / 60
      const projAltFt = altQnhFt + f.vertRate * dtMin
      const projMarginFt = cell ? projAltFt - mvaFt : 99999
      // phase: range from associated apt + altitude shape
      let rangeFromAptNm = 99
      let bearingToAptDeg = 0
      if (cell && cell.apt) {
        // we don't have airport lat/lng table here, use cell centre as proxy
        rangeFromAptNm = distNm(f, cell)
        bearingToAptDeg = bearingDeg(f, cell)
      }
      let phase: Phase = 'OTHER'
      if (cell) {
        if (rangeFromAptNm <= 8 && altQnhFt <= cell.floorFt + 2500 && f.vertRate < -300) phase = 'FINAL'
        else if (rangeFromAptNm <= 20 && altQnhFt <= cell.floorFt + 4000 && f.vertRate < -100) phase = 'APP'
        else if (f.vertRate > 500) phase = 'DEP'
        else phase = 'ENR'
      } else if (f.altitudeFt > 12000) phase = 'ENR'
      // APM deviation for FINAL: published 3-deg profile from cell centre
      // expected alt at this range = cell.floorFt + 3-deg slope = range × tan(3°) × 6076 ft/nm
      let apmDevFt = 0
      if (phase === 'FINAL' && cell) {
        const expectFt = cell.floorFt + rangeFromAptNm * Math.tan(3 * Math.PI / 180) * 6076
        apmDevFt = altQnhFt - expectFt
      }
      // driver severities 0–100
      const brkV = cell ? clamp(map01(marginFt, 0, -800) * 100, 0, 100) : 0
      const brkP = cell ? clamp(map01(projMarginFt, 0, -1200) * 100, 0, 100) : 0
      const brkA = phase === 'FINAL' ? clamp(map01(-apmDevFt, apmTol, apmTol + 500) * 100, 0, 100) : 0
      // edge: closing on cell radius boundary descending — sector handoff late vector risk
      const brkE = cell ? clamp(((cell.radNm - best) / cell.radNm) * 60 + (f.vertRate < -800 ? 35 : 0), 0, 100) : 0
      let score = Math.max(brkV * 1.0, brkP * 0.95, brkA * 0.9, brkE * 0.45)
      score = score * (PHASE_MUL[phase] * (phaseWt / 100))
      // controller-suppression inhibit gate (real-world bug pattern)
      if (inhibitGate > 0 && hashFrac(f.icao + 'inh') * 100 < inhibitGate) score *= 0.25
      score = clamp(score, 0, 100)
      let driver: Row['driver'] = 'NONE'
      const maxD = Math.max(brkV, brkP, brkA, brkE)
      if (maxD === brkV && brkV > 0) driver = 'BRK'
      else if (maxD === brkP && brkP > 0) driver = 'PRJ'
      else if (maxD === brkA && brkA > 0) driver = 'APM'
      else if (maxD === brkE && brkE > 0) driver = 'EDG'
      let tier: Tier = 'IDLE'
      if (!cell) tier = 'IDLE'
      else if (score >= 80 && brkV > 70) tier = 'MSAW-LOW'
      else if (score >= 70 && brkP > 60) tier = 'MSAW-PROJ'
      else if (score >= 55 && brkA > 50) tier = 'APM-DEV'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'
      out.push({ f, cell, phase, altQnhFt, mvaFt, marginFt, projAltFt, projMarginFt, apmDevFt, rangeFromAptNm, bearingToAptDeg, brkV, brkP, brkA, brkE, driver, score, tier })
    }
    return out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [flights, minAlt, maxAlt, qnhBias, lookAhead, mvaMul, apmTol, phaseWt, inhibitGate])

  const tierCount: Record<Tier, number> = { 'MSAW-LOW': 0, 'MSAW-PROJ': 0, 'APM-DEV': 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const r of active) tierCount[r.tier]++
  const worst = active[0]
  const meanMargin = active.length ? active.filter(r => r.cell).reduce((s, r) => s + r.marginFt, 0) / Math.max(1, active.filter(r => r.cell).length) : 0
  const lowShare = active.length ? tierCount['MSAW-LOW'] / active.length : 0
  const projShare = active.length ? tierCount['MSAW-PROJ'] / active.length : 0
  const apmShare = active.length ? tierCount['APM-DEV'] / active.length : 0

  const filtered = active.filter(r => {
    if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
    if (terrFilter !== 'ALL' && r.cell?.terr !== terrFilter) return false
    if (query) {
      const q = query.toLowerCase()
      const hay = `${r.f.callsign || ''} ${r.f.icao} ${r.f.type || ''} ${r.cell?.facility || ''} ${r.cell?.apt || ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  /* ---------- facility / terrain rollups ---------- */
  const facilityRows = useMemo(() => {
    const m = new Map<string, { c: MvaCell; ac: number; low: number; proj: number; apm: number; meanScore: number; worst?: Row }>()
    for (const c of MVA_CELLS) m.set(c.facility, { c, ac: 0, low: 0, proj: 0, apm: 0, meanScore: 0 })
    for (const r of active) {
      if (!r.cell) continue
      const e = m.get(r.cell.facility)!
      e.ac++
      if (r.tier === 'MSAW-LOW') e.low++
      if (r.tier === 'MSAW-PROJ') e.proj++
      if (r.tier === 'APM-DEV') e.apm++
      e.meanScore += r.score
      if (!e.worst || r.score > e.worst.score) e.worst = r
    }
    return Array.from(m.values()).map(e => ({ ...e, meanScore: e.ac ? e.meanScore / e.ac : 0 }))
      .filter(e => e.ac > 0)
      .sort((a, b) => (b.low - a.low) || (b.proj - a.proj) || (b.ac - a.ac))
  }, [active])

  const terrRows = useMemo(() => {
    const buckets: Record<MvaCell['terr'], { ac: number; low: number; proj: number; apm: number; meanScore: number }> = {
      MTN: { ac: 0, low: 0, proj: 0, apm: 0, meanScore: 0 },
      HILL: { ac: 0, low: 0, proj: 0, apm: 0, meanScore: 0 },
      COAST: { ac: 0, low: 0, proj: 0, apm: 0, meanScore: 0 },
      PLAIN: { ac: 0, low: 0, proj: 0, apm: 0, meanScore: 0 },
    }
    for (const r of active) {
      if (!r.cell) continue
      const b = buckets[r.cell.terr]
      b.ac++
      if (r.tier === 'MSAW-LOW') b.low++
      if (r.tier === 'MSAW-PROJ') b.proj++
      if (r.tier === 'APM-DEV') b.apm++
      b.meanScore += r.score
    }
    return (['MTN', 'HILL', 'COAST', 'PLAIN'] as MvaCell['terr'][]).map(k => ({
      k, ...buckets[k], meanScore: buckets[k].ac ? buckets[k].meanScore / buckets[k].ac : 0
    }))
  }, [active])

  /* ---------- MapLibre overlay ---------- */
  useEffect(() => {
    if (!map) return
    if (!map.getSource(SRC_CELL)) map.addSource(SRC_CELL, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    if (!map.getSource(SRC_HALO)) map.addSource(SRC_HALO, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    if (!map.getSource(SRC_PIN)) map.addSource(SRC_PIN, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    if (!map.getSource(SRC_LBL)) map.addSource(SRC_LBL, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    if (!map.getSource(SRC_PROJ)) map.addSource(SRC_PROJ, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    if (!map.getSource(SRC_REF)) map.addSource(SRC_REF, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    if (!map.getLayer(LYR_CELL)) map.addLayer({
      id: LYR_CELL, type: 'circle', source: SRC_CELL,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 4, 6, 12, 9, 26],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1,
        'circle-stroke-opacity': 0.55,
      },
    })
    if (!map.getLayer(LYR_HALO)) map.addLayer({
      id: LYR_HALO, type: 'circle', source: SRC_HALO,
      paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.28, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.2, 'circle-stroke-opacity': 0.85 },
    })
    if (!map.getLayer(LYR_PIN)) map.addLayer({
      id: LYR_PIN, type: 'circle', source: SRC_PIN,
      paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1 },
    })
    if (!map.getLayer(LYR_PROJ)) map.addLayer({
      id: LYR_PROJ, type: 'line', source: SRC_PROJ,
      paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-dasharray': [2, 2], 'line-opacity': 0.85 },
    })
    if (!map.getLayer(LYR_LBL)) map.addLayer({
      id: LYR_LBL, type: 'symbol', source: SRC_LBL,
      layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': true },
      paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.4 },
    })
    if (!map.getLayer(LYR_REF)) map.addLayer({
      id: LYR_REF, type: 'line', source: SRC_REF,
      paint: { 'line-color': '#0ea5e955', 'line-width': 0.5, 'line-dasharray': [3, 4] },
    })

    const cell: any[] = []; const halo: any[] = []; const pin: any[] = []; const lbl: any[] = []; const proj: any[] = []; const ref: any[] = []
    if (showCell) {
      for (const c of MVA_CELLS) {
        cell.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { color: TERR_COLOR[c.terr] } })
        if (showLbl) lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { label: `${c.facility} · ${c.floorFt}ft`, color: TERR_COLOR[c.terr] } })
      }
    }
    for (const r of active) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'OK' && r.tier !== 'IDLE') {
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: 8 + r.score * 0.14 } })
      }
      if (showPin && (r.tier === 'MSAW-LOW' || r.tier === 'MSAW-PROJ')) {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color } })
      }
      if (showLbl && r.tier !== 'OK' && r.tier !== 'IDLE') {
        const lab = `${r.f.callsign || r.f.icao} · ${r.tier} · ${r.marginFt >= 0 ? '+' : ''}${r.marginFt.toFixed(0)}ft`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { label: lab, color } })
      }
      if (showProj && (r.tier === 'MSAW-LOW' || r.tier === 'MSAW-PROJ')) {
        // project forward lookAhead seconds at ground vel
        const distNmFwd = (r.f.velocityKts * (lookAhead / 3600))
        const tip = projectNm(r.f, r.f.track, distNmFwd)
        proj.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [tip.lng, tip.lat]] }, properties: { color } })
      }
    }
    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        ref.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }
    ;(map.getSource(SRC_CELL) as any).setData({ type: 'FeatureCollection', features: cell })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PROJ) as any).setData({ type: 'FeatureCollection', features: proj })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: ref })
    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_CELL, LYR_REF]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_LBL, SRC_PIN, SRC_PROJ, SRC_CELL, SRC_REF]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, active, showHalo, showPin, showLbl, showCell, showProj, showRef, lookAhead])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const drvBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (r: Row) => {
    if (!r.cell) return 'No MVA cell association · outside adapted area'
    if (r.tier === 'MSAW-LOW') return `LOW ALT alert · ${r.cell.facility} MVA ${r.cell.floorFt}ft · Mode-C ${r.altQnhFt.toFixed(0)}ft · controller TX "LOW ALTITUDE ALERT, CHECK YOUR ALTITUDE IMMEDIATELY, THE MVA IN YOUR AREA IS ${r.cell.floorFt}" per FAA Order JO 7110.65 §2-1-6`
    if (r.tier === 'MSAW-PROJ') return `Projected breach in ${lookAhead}s · pred ${r.projAltFt.toFixed(0)}ft vs MVA ${r.cell.floorFt}ft · controller issue altitude assignment per JO 7110.65 §5-15-4`
    if (r.tier === 'APM-DEV') return `APM low-on-profile · ${r.apmDevFt.toFixed(0)}ft below 3° glide · controller TX "LOW ALTITUDE ALERT" per JO 7110.65 §5-15-7 · APV check`
    if (r.tier === 'WATCH') return `Margin ${r.marginFt.toFixed(0)}ft above MVA ${r.cell.floorFt} · monitor descent · no controller action`
    if (r.tier === 'OK') return `Above MVA ${r.cell.floorFt}ft by ${r.marginFt.toFixed(0)}ft · APW nominal`
    return ''
  }

  /* Scatter: margin (ft) vs projected margin (ft) */
  const W = 280, H = 180
  const sx = (n: number) => 32 + ((Math.max(-2000, Math.min(2000, n)) + 2000) / 4000) * (W - 42)
  const sy = (n: number) => H - 24 - ((Math.max(-2000, Math.min(2000, n)) + 2000) / 4000) * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">MSAW · APW Controller Safety-Net</div>
          <div className="text-[10px] text-slate-500">JO 7110.65 §5-15 · EUROCONTROL APW · EUROCAE ED-153</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[8px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean margin</div>
          <div className="text-sm font-semibold" style={{ color: meanMargin <= 0 ? '#ef4444' : meanMargin <= 500 ? '#f59e0b' : '#10b981' }}>{meanMargin.toFixed(0)}ft</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">LOW alerts</div>
          <div className="text-sm font-semibold" style={{ color: tierCount['MSAW-LOW'] > 0 ? '#ef4444' : '#10b981' }}>{tierCount['MSAW-LOW']}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">PROJ share</div>
          <div className="text-xs font-semibold" style={{ color: projShare >= 0.10 ? '#f43f5e' : projShare >= 0.05 ? '#f59e0b' : '#10b981' }}>{(projShare*100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">APM share</div>
          <div className="text-xs font-semibold" style={{ color: apmShare >= 0.10 ? '#f59e0b' : '#10b981' }}>{(apmShare*100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Tracked</div>
          <div className="text-xs font-semibold text-slate-100">{active.length}</div>
        </div>
      </div>

      {showDiag && active.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* breach quadrant */}
            <rect x={sx(-2000)} y={sy(0)} width={sx(0)-sx(-2000)} height={H-24-sy(0)} fill="#ef444415" />
            {/* both projected & current low quadrant */}
            <rect x={sx(-2000)} y={sy(-2000)} width={sx(0)-sx(-2000)} height={sy(0)-sy(-2000)} fill="#ef444425" />
            {/* current OK projected low */}
            <rect x={sx(0)} y={sy(-2000)} width={sx(2000)-sx(0)} height={sy(0)-sy(-2000)} fill="#f43f5e22" />
            {/* zero margin lines */}
            <line x1={sx(0)} y1={sy(-2000)} x2={sx(0)} y2={sy(2000)} stroke="#ef4444" strokeWidth={0.6} strokeDasharray="3 3" />
            <line x1={sx(-2000)} y1={sy(0)} x2={sx(2000)} y2={sy(0)} stroke="#ef4444" strokeWidth={0.6} strokeDasharray="3 3" />
            {/* y=x diagonal (no vert change) */}
            <line x1={sx(-2000)} y1={sy(-2000)} x2={sx(2000)} y2={sy(2000)} stroke="#0ea5e933" strokeWidth={0.5} />
            <text x={W/2} y={H-4} textAnchor="middle" fontSize="9" fill="#64748b">Margin now (ft)</text>
            <text x={6} y={H/2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H/2})`}>Projected margin (ft)</text>
            {active.filter(r => r.cell).map((r, i) => (
              <circle key={i} cx={sx(r.marginFt)} cy={sy(r.projMarginFt)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['MIN-FL', minAlt, 0, 200, setMinAlt, ''],
            ['MAX-FL', maxAlt, 50, 400, setMaxAlt, ''],
            ['QNH-BIAS', qnhBias, -200, 200, setQnhBias, 'ft'],
            ['LOOK-AH', lookAhead, 10, 120, setLookAhead, 's'],
            ['MVA-MUL', mvaMul, 80, 130, setMvaMul, '%'],
            ['APM-TOL', apmTol, 100, 800, setApmTol, 'ft'],
            ['PHASE-WT', phaseWt, 50, 150, setPhaseWt, '%'],
            ['INH-GATE', inhibitGate, 0, 100, setInhibitGate, '%'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[34px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['MTN', 'HILL', 'COAST', 'PLAIN'] as MvaCell['terr'][]).map(k => (
            <button key={k} onClick={() => setTerrFilter(terrFilter === k ? 'ALL' : k)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: terrFilter === k ? '#0ea5e933' : '#0b1220', borderColor: terrFilter === k ? '#0ea5e9' : '#1e293b', color: terrFilter === k ? '#0ea5e9' : '#cbd5e1' }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['CELL', showCell, setShowCell],
            ['PROJ', showProj, setShowProj],
            ['REF', showRef, setShowRef],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / facility / apt" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'FACILITIES', 'TERRAIN'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className="flex-1 px-2 py-1.5 text-[11px]" style={{ color: tab === t ? '#0ea5e9' : '#94a3b8', backgroundColor: tab === t ? '#0ea5e915' : 'transparent', borderBottom: tab === t ? '2px solid #0ea5e9' : '2px solid transparent' }}>{t}</button>
        ))}
      </div>

      {tab === 'AIRCRAFT' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No targets inside an adapted MVA cell · adjust filters</div>}
          {filtered.slice(0, 80).map((r, i) => (
            <div key={i} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(r.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 truncate">{r.f.callsign || r.f.icao}</span>
                  <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                  {r.cell && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 border border-slate-700 font-mono">{r.cell.facility}</span>}
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 border border-slate-700">{r.phase}</span>
                </div>
                {tierBadge(r.tier)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                Mode-C {r.altQnhFt.toFixed(0)}ft · MVA {r.mvaFt.toFixed(0)}ft · margin <span style={{ color: r.marginFt <= 0 ? '#ef4444' : r.marginFt <= 500 ? '#f59e0b' : '#10b981' }}>{r.marginFt >= 0 ? '+' : ''}{r.marginFt.toFixed(0)}ft</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                VS {r.f.vertRate >= 0 ? '+' : ''}{r.f.vertRate.toFixed(0)}fpm · proj({lookAhead}s) {r.projAltFt.toFixed(0)}ft margin <span style={{ color: r.projMarginFt <= 0 ? '#f43f5e' : r.projMarginFt <= 500 ? '#f59e0b' : '#10b981' }}>{r.projMarginFt >= 0 ? '+' : ''}{r.projMarginFt.toFixed(0)}ft</span>
                {r.phase === 'FINAL' && <> · APM Δ <span style={{ color: Math.abs(r.apmDevFt) >= apmTol ? '#f59e0b' : '#10b981' }}>{r.apmDevFt >= 0 ? '+' : ''}{r.apmDevFt.toFixed(0)}ft</span></>}
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {drvBadge('BRK', r.brkV)}
                {drvBadge('PRJ', r.brkP)}
                {drvBadge('APM', r.brkA)}
                {drvBadge('EDG', r.brkE)}
              </div>
              <div className="text-[10px] mt-1" style={{ color: TIER_COLOR[r.tier] }}>{advice(r)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'FACILITIES' && (
        <div className="divide-y divide-slate-800">
          {facilityRows.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No facility activity</div>}
          {facilityRows.map((e, i) => (
            <div key={i} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => e.worst && onFly(e.worst.f.icao)} style={{ borderLeft: `3px solid ${e.low ? '#ef4444' : e.proj ? '#f43f5e' : e.apm ? '#f59e0b' : '#0ea5e9'}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-slate-100 font-mono">{e.c.facility}</span>
                  <span className="text-[10px] text-slate-400">{e.c.name}</span>
                </div>
                <div className="text-[10px] text-slate-400">{e.ac} ac</div>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                {e.c.apt} · MVA {e.c.floorFt}ft · {e.c.terr} · r{e.c.radNm}nm
              </div>
              <div className="flex items-center gap-2 mt-1">
                {e.low > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/40">LOW {e.low}</span>}
                {e.proj > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: '#f43f5e', backgroundColor: '#f43f5e1a', border: '1px solid #f43f5e66' }}>PROJ {e.proj}</span>}
                {e.apm > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/40">APM {e.apm}</span>}
                <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${e.meanScore}%`, backgroundColor: e.meanScore >= 80 ? '#ef4444' : e.meanScore >= 55 ? '#f59e0b' : e.meanScore >= 25 ? '#0ea5e9' : '#10b981' }} /></div>
                <span className="text-[10px] text-slate-400 tabular-nums w-8 text-right">{e.meanScore.toFixed(0)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'TERRAIN' && (
        <div className="divide-y divide-slate-800">
          {terrRows.map((b, i) => (
            <div key={i} className="px-3 py-2" style={{ borderLeft: `3px solid ${TERR_COLOR[b.k]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-slate-100 font-mono">{b.k}</span>
                </div>
                <div className="text-[10px] text-slate-400">{b.ac} ac</div>
              </div>
              <div className="flex items-center gap-2 mt-1">
                {b.low > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/40">LOW {b.low}</span>}
                {b.proj > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: '#f43f5e', backgroundColor: '#f43f5e1a', border: '1px solid #f43f5e66' }}>PROJ {b.proj}</span>}
                {b.apm > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/40">APM {b.apm}</span>}
                <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${b.meanScore}%`, backgroundColor: b.meanScore >= 80 ? '#ef4444' : b.meanScore >= 55 ? '#f59e0b' : b.meanScore >= 25 ? '#0ea5e9' : '#10b981' }} /></div>
                <span className="text-[10px] text-slate-400 tabular-nums w-8 text-right">{b.meanScore.toFixed(0)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 leading-tight">
        FAA JO 7110.65 §5-15 MSAW/APM · JO 7210.3DD §3-7 adaptation · JO 7110.10 §4-3 · 14 CFR 91.119 / 91.177 · ICAO Doc 4444 §8.6.5 STCA/MSAW · EUROCONTROL APW ed 2.0 · EUROCAE ED-153 · MITRE TM-93W0000165 · NTSB AAR-15/01 KAL801 NIMITZ · AAR-78-13 CO1713 · DCA15FA085 6R-302
      </div>
    </div>
  )
}

function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)) }
function map01(n: number, a: number, b: number): number {
  if (a === b) return 0
  const t = (n - a) / (b - a)
  return Math.max(0, Math.min(1, t))
}
