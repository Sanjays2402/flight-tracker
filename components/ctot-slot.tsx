'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   CTOT / ATFM Slot Compliance Monitor
   -----------------------------------------------------------
   EUROCONTROL ATFCM Users Manual 26.0 / Network Manager (CFMU) /
   ICAO Doc 7030 EUR SUPPS § 4.4 / FAA TFMS Ground Stops &
   Expect Departure Clearance Times (EDCT) / IATA WSG Slot Adherence /
   EASA NPA 2019-08 ATFCM compliance watch for every aircraft within
   200nm of an ATFCM-regulated departure airport (40-airport catalogue
   covering Europe NM area, USA TFMS centres, and key Asia-Pac/ME hubs).

   Per departure synthesises:
     - Estimated Off-Block Time (EOBT) and CTOT (Calculated Take-Off
       Time) via FNV-1a 32-bit hash of ICAO24 over the operating hour.
     - Regulation cause: ATC-CAPACITY (C) / WEATHER (W) / STAFFING (S) /
       AERODROME-CAPACITY (A) / ATC-DISRUPTION (T) / RUNWAY (R) — per
       NM ATFCM regulation reason codes (Annex 2 ATFCM Manual).
     - CTOT window per ATFCM Users Manual § 4.7.1: -5 min / +10 min
       around the CTOT. ATOT (Actual TOT) inferred from current position
       (in-air → just departed; on-ground → projected by taxi queue).
     - Taxi queue from per-airport demand vs runway throughput (LHR 45,
       FRA 50, CDG 48, AMS 46, MUC 38, ZRH 30, MAD 42, FCO 32, JFK 42,
       LGA 35, EWR 38, ATL 60, ORD 56, DEN 50, SFO 28, MIA 32, etc).
     - Cascade risk: missed CTOT triggers slot-substitution (FREE/SIP) and
       downstream slot loss for the next inbound rotation.

   Risk components (per departure):
     WINDOW   — minutes out of -5/+10 CTOT window. Severity ramps
                 0 at margin ≥ 0 min, 100 at +25 min over CTOT or LIFO.
     MISS     — projected ATOT exceeds CTOT+10 within next 15 min;
                 sev = clip((projATOT-(CTOT+10))/12*100, 0, 100).
     QUEUE    — current taxi queue length ahead vs airport runway
                 throughput. sev = clip((queue-6)/12*100, 0, 100).
     CASCADE  — downstream rotation impact (next sector's CTOT chain
                 slip) — synthesised from hash + miss severity * 0.6.
     REG-SEV  — regulation severity at origin per cause code (W weather
                 80, C ATC cap 65, S staffing 60, A aerodrome 55,
                 R runway 50, T disruption 75).

   Composite = max-driver with dominant-driver labelling.

   Tiers:
     MISS    score ≥ 80   rose   slot lost · request SIP slot from CFMU
     TIGHT   score ≥ 55   amber  within window but trending out · expedite taxi
     WATCH   score ≥ 25   sky    on schedule, monitor regulation evolution
     OK      score < 25   emerald slot nominal · early window
     IDLE    no regulation slate  not under ATFCM

   MapLibre overlay:
     - Tier-coloured halo rings sized by score 8-22 px
     - Amber pin at regulated airport with reg code + cause + ac-count
     - Tier-coloured callsign + ΔCTOT(min) + cause labels for non-OK
     - Dashed rose great-circle from missed-slot aircraft back to origin
       airport indicating return-to-pad recovery option

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell summary: MEAN-Δ / WORST / MISS-count
     - 2-cell secondary: TAXI-MEAN / REGULATED-APT-count
     - SVG ΔCTOT-min vs taxi-min scatter with tier bands
     - 5 sliders WINDOW-LATE / TAXI-MUL / DEMAND-MUL / CASCADE-MUL / MIN-DIST
     - Cause chip filter W/C/S/A/R/T
     - HALO / PIN / LBL / RTN / DIAG toggles + search
     - AIRCRAFT / AIRPORTS tab switcher

   Registered in Layers > Routes & Flow. Persisted: ft-ctot
   ============================================================ */

export interface CtotFlight {
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
  flights: CtotFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'WATCH' | 'TIGHT' | 'MISS' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981',
  WATCH: '#0ea5e9',
  TIGHT: '#f59e0b',
  MISS: '#ef4444',
  IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['MISS', 'TIGHT', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { MISS: 0, TIGHT: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Cause = 'W' | 'C' | 'S' | 'A' | 'R' | 'T'
const CAUSE_LABEL: Record<Cause, string> = {
  W: 'WEATHER',
  C: 'ATC-CAPACITY',
  S: 'STAFFING',
  A: 'AERODROME',
  R: 'RUNWAY',
  T: 'ATC-DISRUPTION',
}
const CAUSE_SEV: Record<Cause, number> = {
  W: 80, C: 65, S: 60, A: 55, R: 50, T: 75,
}

interface CfmuApt {
  icao: string
  iata: string
  name: string
  lat: number
  lng: number
  thru: number       // runway hourly throughput (mov/hr) — both directions
  region: 'EUR' | 'USA' | 'APAC' | 'ME'
}
const APTS: CfmuApt[] = [
  // EUR — high CFMU regulation density
  { icao: 'EGLL', iata: 'LHR', name: 'London Heathrow', lat: 51.470, lng: -0.4543, thru: 88, region: 'EUR' },
  { icao: 'LFPG', iata: 'CDG', name: 'Paris CDG', lat: 49.010, lng: 2.5479, thru: 110, region: 'EUR' },
  { icao: 'EDDF', iata: 'FRA', name: 'Frankfurt', lat: 50.033, lng: 8.5706, thru: 96, region: 'EUR' },
  { icao: 'EHAM', iata: 'AMS', name: 'Amsterdam Schiphol', lat: 52.310, lng: 4.7683, thru: 110, region: 'EUR' },
  { icao: 'EDDM', iata: 'MUC', name: 'Munich', lat: 48.354, lng: 11.7861, thru: 90, region: 'EUR' },
  { icao: 'LSZH', iata: 'ZRH', name: 'Zürich', lat: 47.458, lng: 8.5481, thru: 66, region: 'EUR' },
  { icao: 'LEMD', iata: 'MAD', name: 'Madrid Barajas', lat: 40.472, lng: -3.5608, thru: 90, region: 'EUR' },
  { icao: 'LEBL', iata: 'BCN', name: 'Barcelona', lat: 41.297, lng: 2.0833, thru: 78, region: 'EUR' },
  { icao: 'LIRF', iata: 'FCO', name: 'Rome Fiumicino', lat: 41.800, lng: 12.2389, thru: 88, region: 'EUR' },
  { icao: 'LIMC', iata: 'MXP', name: 'Milan Malpensa', lat: 45.630, lng: 8.7228, thru: 70, region: 'EUR' },
  { icao: 'LTFM', iata: 'IST', name: 'Istanbul New', lat: 41.262, lng: 28.7419, thru: 120, region: 'EUR' },
  { icao: 'LOWW', iata: 'VIE', name: 'Vienna', lat: 48.110, lng: 16.5697, thru: 68, region: 'EUR' },
  { icao: 'EDDB', iata: 'BER', name: 'Berlin Brandenburg', lat: 52.367, lng: 13.5033, thru: 60, region: 'EUR' },
  { icao: 'EKCH', iata: 'CPH', name: 'Copenhagen', lat: 55.617, lng: 12.6561, thru: 72, region: 'EUR' },
  { icao: 'EGKK', iata: 'LGW', name: 'London Gatwick', lat: 51.148, lng: -0.1903, thru: 55, region: 'EUR' },
  { icao: 'EGCC', iata: 'MAN', name: 'Manchester', lat: 53.354, lng: -2.2750, thru: 60, region: 'EUR' },
  { icao: 'LFPO', iata: 'ORY', name: 'Paris Orly', lat: 48.726, lng: 2.3653, thru: 70, region: 'EUR' },
  { icao: 'LPPT', iata: 'LIS', name: 'Lisbon', lat: 38.770, lng: -9.1357, thru: 52, region: 'EUR' },
  { icao: 'LGAV', iata: 'ATH', name: 'Athens', lat: 37.937, lng: 23.9444, thru: 48, region: 'EUR' },
  { icao: 'EIDW', iata: 'DUB', name: 'Dublin', lat: 53.421, lng: -6.2700, thru: 55, region: 'EUR' },
  // USA — TFMS / EDCT
  { icao: 'KJFK', iata: 'JFK', name: 'New York JFK', lat: 40.640, lng: -73.7787, thru: 82, region: 'USA' },
  { icao: 'KLGA', iata: 'LGA', name: 'New York LaGuardia', lat: 40.777, lng: -73.8726, thru: 71, region: 'USA' },
  { icao: 'KEWR', iata: 'EWR', name: 'Newark', lat: 40.692, lng: -74.1687, thru: 78, region: 'USA' },
  { icao: 'KBOS', iata: 'BOS', name: 'Boston Logan', lat: 42.363, lng: -71.0096, thru: 70, region: 'USA' },
  { icao: 'KDCA', iata: 'DCA', name: 'Washington National', lat: 38.852, lng: -77.0377, thru: 56, region: 'USA' },
  { icao: 'KIAD', iata: 'IAD', name: 'Washington Dulles', lat: 38.944, lng: -77.4558, thru: 68, region: 'USA' },
  { icao: 'KATL', iata: 'ATL', name: 'Atlanta', lat: 33.640, lng: -84.4277, thru: 120, region: 'USA' },
  { icao: 'KORD', iata: 'ORD', name: 'Chicago O\'Hare', lat: 41.978, lng: -87.9048, thru: 112, region: 'USA' },
  { icao: 'KDFW', iata: 'DFW', name: 'Dallas Fort Worth', lat: 32.897, lng: -97.0380, thru: 110, region: 'USA' },
  { icao: 'KDEN', iata: 'DEN', name: 'Denver', lat: 39.862, lng: -104.6731, thru: 105, region: 'USA' },
  { icao: 'KSFO', iata: 'SFO', name: 'San Francisco', lat: 37.619, lng: -122.3742, thru: 56, region: 'USA' },
  { icao: 'KLAX', iata: 'LAX', name: 'Los Angeles', lat: 33.943, lng: -118.4081, thru: 86, region: 'USA' },
  { icao: 'KSEA', iata: 'SEA', name: 'Seattle Tacoma', lat: 47.450, lng: -122.3088, thru: 80, region: 'USA' },
  { icao: 'KMIA', iata: 'MIA', name: 'Miami', lat: 25.793, lng: -80.2906, thru: 80, region: 'USA' },
  { icao: 'KPHX', iata: 'PHX', name: 'Phoenix Sky Harbor', lat: 33.434, lng: -112.0080, thru: 80, region: 'USA' },
  // ME / APAC
  { icao: 'OMDB', iata: 'DXB', name: 'Dubai', lat: 25.253, lng: 55.3657, thru: 95, region: 'ME' },
  { icao: 'OTHH', iata: 'DOH', name: 'Doha Hamad', lat: 25.273, lng: 51.6080, thru: 80, region: 'ME' },
  { icao: 'VHHH', iata: 'HKG', name: 'Hong Kong', lat: 22.308, lng: 113.9185, thru: 68, region: 'APAC' },
  { icao: 'WSSS', iata: 'SIN', name: 'Singapore Changi', lat: 1.354, lng: 103.9942, thru: 80, region: 'APAC' },
  { icao: 'RJTT', iata: 'HND', name: 'Tokyo Haneda', lat: 35.553, lng: 139.7811, thru: 90, region: 'APAC' },
]

function classify(t: string | undefined): 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR' {
  const x = (t || '').toUpperCase()
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'HVY'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CRJ9|CS|BCS)/.test(x)) return 'NRW'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'RGN'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'BIZ'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS)/.test(x)) return 'FTR'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'TBP'
  return 'NRW'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

function greatCircleNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const dφ = ((lat2 - lat1) * Math.PI) / 180
  const dλ = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function nearestApt(lat: number, lng: number, maxNm: number): { apt: CfmuApt; distNm: number } | null {
  let best: CfmuApt | null = null
  let bestD = Infinity
  for (const a of APTS) {
    const d = greatCircleNm(lat, lng, a.lat, a.lng)
    if (d < bestD) { bestD = d; best = a }
  }
  if (!best || bestD > maxNm) return null
  return { apt: best, distNm: bestD }
}

interface Row {
  f: CtotFlight
  klass: ReturnType<typeof classify>
  apt: CfmuApt
  distNm: number
  flCur: number
  // ctot
  ctotMin: number       // minutes from now (negative = past)
  deltaMin: number      // ATOT vs CTOT in min (signed); positive = late
  cause: Cause
  causeSev: number
  // queue
  queueAhead: number
  taxiMin: number
  queueSev: number
  // window / miss
  windowSev: number
  missSev: number
  cascadeSev: number
  // composite
  score: number
  tier: Tier
  driver: 'WINDOW' | 'MISS' | 'QUEUE' | 'CASCADE' | 'REG' | 'NONE'
  airborne: boolean
}

const SRC_HALO = 'ctot-halo', SRC_PIN = 'ctot-pin', SRC_LBL = 'ctot-lbl', SRC_RTN = 'ctot-rtn'
const LYR_HALO = 'ctot-halo-l', LYR_PIN = 'ctot-pin-l', LYR_LBL = 'ctot-lbl-l', LYR_RTN = 'ctot-rtn-l'

export default function CtotSlot({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [causeFilter, setCauseFilter] = useState<Cause | 'ALL'>('ALL')
  const [windowLate, setWindowLate] = useState(10)   // +N min late = miss
  const [taxiMul, setTaxiMul] = useState(100)
  const [demandMul, setDemandMul] = useState(100)
  const [cascadeMul, setCascadeMul] = useState(100)
  const [minDist, setMinDist] = useState(200)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showRtn, setShowRtn] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    // demand per airport built from how many candidate aircraft are near it
    const demand = new Map<string, number>()
    for (const f of flights) {
      const flCur = (f.altitudeFt || 0) / 100
      if (!f.ground && flCur > 200) continue   // only ground or just-departed below FL200
      const near = nearestApt(f.lat, f.lng, minDist)
      if (!near) continue
      demand.set(near.apt.icao, (demand.get(near.apt.icao) || 0) + 1)
    }
    for (const f of flights) {
      const flCur = (f.altitudeFt || 0) / 100
      if (!f.ground && flCur > 200) continue
      const near = nearestApt(f.lat, f.lng, minDist)
      if (!near) continue
      const { apt, distNm } = near
      const klass = classify(f.type)
      const h = hash32(f.icao)
      // CTOT relative to now: hash-derived -25..+45 min
      const ctotMin = ((h & 0xff) / 0xff) * 70 - 25
      // Cause from hash bits (weighted by region typical reg mix)
      const causeRoll = ((h >>> 8) & 0xff) / 0xff
      let cause: Cause
      if (apt.region === 'EUR') {
        if (causeRoll < 0.30) cause = 'C'
        else if (causeRoll < 0.55) cause = 'W'
        else if (causeRoll < 0.75) cause = 'S'
        else if (causeRoll < 0.90) cause = 'A'
        else cause = 'T'
      } else if (apt.region === 'USA') {
        if (causeRoll < 0.45) cause = 'W'        // TFMS heavy on weather
        else if (causeRoll < 0.65) cause = 'A'
        else if (causeRoll < 0.85) cause = 'R'
        else cause = 'C'
      } else {
        if (causeRoll < 0.35) cause = 'C'
        else if (causeRoll < 0.60) cause = 'W'
        else if (causeRoll < 0.85) cause = 'R'
        else cause = 'A'
      }
      const regSevBase = CAUSE_SEV[cause]
      // Severity scaled by relative load
      const aptDemand = demand.get(apt.icao) || 1
      const loadRatio = (aptDemand * (demandMul / 100)) / Math.max(1, apt.thru / 4)  // demand per 15min vs throughput
      const causeSev = Math.min(100, regSevBase * Math.min(1.4, Math.max(0.4, loadRatio)))

      // Taxi queue & taxi minutes
      const queueAhead = Math.max(0, Math.round(aptDemand * (demandMul / 100) * 0.7 + (((h >>> 16) & 0x0f) - 4)))
      const taxiBase = klass === 'HVY' ? 14 : klass === 'NRW' ? 11 : klass === 'RGN' ? 9 : klass === 'BIZ' ? 8 : 6
      const taxiMin = (taxiBase + queueAhead * 0.6) * (taxiMul / 100)
      const queueSev = Math.max(0, Math.min(100, (queueAhead - 6) / 12 * 100))

      // Determine ATOT vs CTOT
      // Airborne (just departed) → ATOT ≈ now - timeAirborne(unknown) → take ATOT = 0 (just now) for in-air
      // Ground → projected ATOT ≈ now + taxiMin
      const airborne = !f.ground
      const projAtotMin = airborne ? 0 : taxiMin    // minutes from now
      const deltaMin = projAtotMin - ctotMin        // positive = late vs CTOT

      // WINDOW: in -5..+windowLate window?
      let windowSev = 0
      if (deltaMin > 0) {
        windowSev = Math.min(100, (deltaMin / Math.max(1, windowLate)) * 60)
        if (deltaMin > windowLate) windowSev = Math.min(100, 60 + (deltaMin - windowLate) / 15 * 60)
      } else if (deltaMin < -5) {
        // early-out-of-window unusual but flagged sky-level
        windowSev = Math.min(40, (-deltaMin - 5) / 10 * 40)
      }

      // MISS projection — only meaningful for ground aircraft
      const missSev = !airborne
        ? Math.max(0, Math.min(100, (deltaMin - windowLate) / 12 * 100))
        : (deltaMin > windowLate ? Math.min(100, (deltaMin - windowLate) / 8 * 100) : 0)

      // CASCADE — downstream impact
      const cascadeSev = Math.min(100, missSev * 0.6 + (((h >>> 24) & 0x1f) - 8) * (cascadeMul / 100))

      const drivers: Array<{ k: Row['driver']; v: number }> = [
        { k: 'WINDOW', v: windowSev },
        { k: 'MISS', v: missSev },
        { k: 'QUEUE', v: queueSev },
        { k: 'CASCADE', v: Math.max(0, cascadeSev) },
        { k: 'REG', v: causeSev },
      ]
      drivers.sort((a, b) => b.v - a.v)
      const score = drivers[0].v
      const driver: Row['driver'] = score < 1 ? 'NONE' : drivers[0].k
      const tier: Tier = score >= 80 ? 'MISS' : score >= 55 ? 'TIGHT' : score >= 25 ? 'WATCH' : score < 1 ? 'IDLE' : 'OK'

      out.push({
        f, klass, apt, distNm, flCur,
        ctotMin, deltaMin, cause, causeSev,
        queueAhead, taxiMin, queueSev,
        windowSev, missSev, cascadeSev: Math.max(0, cascadeSev),
        score, tier, driver, airborne,
      })
    }
    return out
  }, [flights, minDist, windowLate, taxiMul, demandMul, cascadeMul])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, WATCH: 0, TIGHT: 0, MISS: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    const n = rows.length || 1
    const meanDelta = rows.reduce((a, b) => a + b.deltaMin, 0) / n
    const meanTaxi = rows.reduce((a, b) => a + b.taxiMin, 0) / n
    let worst: Row | null = null
    for (const r of rows) if (!worst || r.score > worst.score) worst = r
    const miss = rows.filter(r => r.tier === 'MISS').length
    const aptSet = new Set(rows.map(r => r.apt.icao))
    return {
      meanDelta, meanTaxi, miss, totalAc: rows.length,
      worstCs: worst ? (worst.f.callsign || worst.f.icao).trim() : '',
      worstScore: worst ? worst.score : 0,
      worstDriver: worst ? worst.driver : 'NONE',
      regulatedApts: aptSet.size,
    }
  }, [rows])

  const aptAggs = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of rows) {
      if (!m.has(r.apt.icao)) m.set(r.apt.icao, [])
      m.get(r.apt.icao)!.push(r)
    }
    const arr = Array.from(m.entries()).map(([icao, list]) => {
      const apt = list[0].apt
      const meanScore = list.reduce((a, b) => a + b.score, 0) / list.length
      const meanDelta = list.reduce((a, b) => a + b.deltaMin, 0) / list.length
      const worstTier = list.reduce((acc, r) => TIER_RANK[r.tier] < TIER_RANK[acc] ? r.tier : acc, 'OK' as Tier)
      const miss = list.filter(r => r.tier === 'MISS').length
      const tight = list.filter(r => r.tier === 'TIGHT').length
      const causeCounts = new Map<Cause, number>()
      for (const r of list) causeCounts.set(r.cause, (causeCounts.get(r.cause) || 0) + 1)
      let topCause: Cause = 'C'
      let topN = 0
      for (const [c, n] of causeCounts) if (n > topN) { topCause = c; topN = n }
      return { apt, list, meanScore, meanDelta, worstTier, miss, tight, topCause, topN }
    })
    arr.sort((a, b) => {
      const ti = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
      if (ti !== 0) return ti
      return b.list.length - a.list.length
    })
    return arr
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows
      .filter(r => {
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (causeFilter !== 'ALL' && r.cause !== causeFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.apt.icao, r.apt.iata, r.cause].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, causeFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + Math.min(14, r.score / 7) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? aptAggs.map(a => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[a.worstTier], text: `${a.apt.iata} ${a.topCause} ${a.list.length}ac` },
      geometry: { type: 'Point' as const, coordinates: [a.apt.lng, a.apt.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'OK' && r.tier !== 'IDLE').map(r => {
      const sign = r.deltaMin >= 0 ? '+' : ''
      return {
        type: 'Feature' as const,
        properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${sign}${r.deltaMin.toFixed(0)}m ${r.cause}` },
        geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      }
    }) : [] }
    const rtnFc = { type: 'FeatureCollection' as const, features: showRtn ? rows.filter(r => r.tier === 'MISS' && r.airborne).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.apt.lng, r.apt.lat]] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_RTN, rtnFc, () => map.addLayer({ id: LYR_RTN, type: 'line', source: SRC_RTN, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.4,
        'line-opacity': 0.7,
        'line-dasharray': [3, 3],
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
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_RTN]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_RTN]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, aptAggs, showHalo, showPin, showLabels, showRtn])

  // ---- Diagram: ΔCTOT min (x, -10..+30) vs taxi min (y, 0..40) ----
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 28
    const xMin = -10, xMax = 30, yMax = 40
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMax }
  }, [])

  const causeOf = (sev: number): Tier => sev >= 80 ? 'MISS' : sev >= 55 ? 'TIGHT' : sev >= 25 ? 'WATCH' : 'OK'

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">CTOT / ATFM Slot</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} dep · {summary.regulatedApts} apt</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Δ</div>
          <div className="font-mono text-sm" style={{ color: summary.meanDelta > windowLate ? '#ef4444' : summary.meanDelta > 0 ? '#f59e0b' : '#10b981' }}>
            {summary.meanDelta >= 0 ? '+' : ''}{summary.meanDelta.toFixed(1)}<span className="text-[9px] text-slate-500"> min</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstScore.toFixed(0)}` : '—'}
          </div>
          <div className="font-mono text-[9px] text-slate-500 truncate">{summary.worstDriver}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Miss</div>
          <div className="font-mono text-sm" style={{ color: summary.miss > 0 ? '#ef4444' : '#10b981' }}>{summary.miss}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Taxi</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanTaxi > 20 ? '#f59e0b' : '#0ea5e9' }}>
            {summary.meanTaxi.toFixed(1)}<span className="text-[9px] text-slate-500"> min</span>
          </div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Reg Apts</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.regulatedApts}<span className="text-[9px] text-slate-500"> /{APTS.length}</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">ΔCTOT min vs taxi min</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* CTOT window bands */}
            <rect x={diag.xs(-5)} y={6} width={Math.max(0, diag.xs(windowLate) - diag.xs(-5))} height={diag.H - diag.PAD - 6} fill="#10b981" opacity={0.07} />
            <rect x={diag.xs(windowLate)} y={6} width={Math.max(0, diag.W - 6 - diag.xs(windowLate))} height={diag.H - diag.PAD - 6} fill="#ef4444" opacity={0.07} />
            {[-5, 0, windowLate].map(x => (
              <g key={x}>
                <line x1={diag.xs(x)} y1={6} x2={diag.xs(x)} y2={diag.H - diag.PAD} stroke={x === windowLate ? '#ef4444' : x === -5 ? '#0ea5e9' : '#64748b'} strokeWidth={0.9} strokeDasharray="3 2" opacity={0.75} />
                <text x={diag.xs(x)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{x >= 0 ? '+' : ''}{x}</text>
              </g>
            ))}
            {[10, 20, 30, 40].map(y => (
              <text key={y} x={diag.PAD - 2} y={diag.ys(y) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{y}</text>
            ))}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, r.deltaMin)))} cy={diag.ys(Math.min(diag.yMax, r.taxiMin))} r={3} fill={TIER_COLOR[r.tier]} opacity={0.9} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>WIN-LATE</span><span className="font-mono text-slate-300">+{windowLate}min</span></div>
            <input type="range" min={5} max={20} step={1} value={windowLate} onChange={e => setWindowLate(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>TAXI-MUL</span><span className="font-mono text-slate-300">{taxiMul}%</span></div>
            <input type="range" min={50} max={200} step={5} value={taxiMul} onChange={e => setTaxiMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>DEMAND-MUL</span><span className="font-mono text-slate-300">{demandMul}%</span></div>
            <input type="range" min={50} max={200} step={5} value={demandMul} onChange={e => setDemandMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CASCADE-MUL</span><span className="font-mono text-slate-300">{cascadeMul}%</span></div>
            <input type="range" min={50} max={200} step={5} value={cascadeMul} onChange={e => setCascadeMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-DIST</span><span className="font-mono text-slate-300">{minDist}nm</span></div>
          <input type="range" min={50} max={400} step={10} value={minDist} onChange={e => setMinDist(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setCauseFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${causeFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['W', 'C', 'S', 'A', 'R', 'T'] as Cause[]).map(c => (
            <button key={c} onClick={() => setCauseFilter(causeFilter === c ? 'ALL' : c)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${causeFilter === c ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{c}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>APT</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRtn} onChange={e => setShowRtn(e.target.checked)} className="accent-sky-500" /><span>RTN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / IATA"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'AIRPORTS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} dep` : `${aptAggs.length} regulated`}</span>
        <span>{tab === 'AIRCRAFT' ? 'Δ · cause · driver · score' : 'top-cause · ac · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No departures under ATFM regulation in view.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const sevPct = Math.min(100, r.score)
          const sign = r.deltaMin >= 0 ? '+' : ''
          const advice =
            r.tier === 'MISS' && r.driver === 'MISS' ? 'slot lost · request SIP slot from NM · file SLA via CFMU' :
            r.tier === 'MISS' && r.driver === 'WINDOW' ? `outside -5/+${windowLate} CTOT window · slot expired` :
            r.tier === 'MISS' && r.driver === 'QUEUE' ? `taxi queue ${r.queueAhead} ahead · request engine-start hold at gate` :
            r.tier === 'MISS' && r.driver === 'CASCADE' ? 'downstream rotation slip likely · alert ops dispatch' :
            r.tier === 'MISS' ? `${CAUSE_LABEL[r.cause]} regulation severe · expect long delay` :
            r.tier === 'TIGHT' && r.driver === 'WINDOW' ? `+${r.deltaMin.toFixed(0)}min late · expedite taxi to make CTOT window` :
            r.tier === 'TIGHT' && r.driver === 'QUEUE' ? `${r.queueAhead}-deep queue · consider intersection departure` :
            r.tier === 'TIGHT' ? `${CAUSE_LABEL[r.cause]} reg active · monitor for slot revision` :
            r.tier === 'WATCH' ? `${CAUSE_LABEL[r.cause]} reg · within window` :
            r.tier === 'OK' ? `nominal · CTOT ${r.ctotMin >= 0 ? 'in ' + r.ctotMin.toFixed(0) + 'm' : 'passed ' + (-r.ctotMin).toFixed(0) + 'm ago'}` :
            'no ATFM regulation'
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{r.klass}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="airport IATA">{r.apt.iata}</span>
                  <span title="dist to apt">{r.distNm.toFixed(0)}nm</span>
                  <span title="delta CTOT" style={{ color: TIER_COLOR[r.tier] }}>{sign}{r.deltaMin.toFixed(0)}m</span>
                  <span title="cause" style={{ color: TIER_COLOR[r.causeSev >= 80 ? 'MISS' : r.causeSev >= 55 ? 'TIGHT' : r.causeSev >= 25 ? 'WATCH' : 'OK'] }}>{r.cause}</span>
                  <span className="ml-auto truncate" title="dominant driver" style={{ color: TIER_COLOR[r.tier] }}>{r.driver}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="composite slot risk score 0-100">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${sevPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: '25%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '55%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '80%' }} />
                </div>
                <div className="grid grid-cols-5 gap-1 mt-1 text-[9px] font-mono">
                  {([
                    ['WIN', r.windowSev],
                    ['MIS', r.missSev],
                    ['QUE', r.queueSev],
                    ['CSC', r.cascadeSev],
                    ['REG', r.causeSev],
                  ] as const).map(([k, v]) => {
                    const t = causeOf(v)
                    return (
                      <span key={k} className="px-1 py-0 rounded border text-center"
                        style={{ borderColor: TIER_COLOR[t] + '66', color: TIER_COLOR[t] }}>{k} {v.toFixed(0)}</span>
                    )
                  })}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="airborne flag">{r.airborne ? 'AIR' : 'GND'}</span>
                  <span title="taxi minutes" style={{ color: r.taxiMin > 20 ? '#f59e0b' : '#64748b' }}>taxi {r.taxiMin.toFixed(0)}m</span>
                  <span title="queue ahead">Q{r.queueAhead}</span>
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' || r.tier === 'IDLE' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'AIRPORTS' && aptAggs.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No regulated airports active.</div>
        )}
        {tab === 'AIRPORTS' && aptAggs.map(a => {
          const pct = Math.min(100, a.meanScore)
          const advice =
            a.worstTier === 'MISS' ? `${a.miss} slot-loss · brief crews on SIP procedure` :
            a.worstTier === 'TIGHT' ? `${a.tight} tight-window departures · expedite pushback` :
            a.worstTier === 'WATCH' ? `${CAUSE_LABEL[a.topCause]} reg active · monitor` :
            'nominal slot adherence'
          return (
            <button key={a.apt.icao} onClick={() => { const f = a.list[0]; if (f) onFly(f.f.icao) }}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.apt.iata}</span>
                  <span className="text-slate-500 truncate">{a.apt.name}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.list.length}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span style={{ color: TIER_COLOR[a.worstTier] }}>mean {a.meanScore.toFixed(1)}</span>
                  <span>Δ {a.meanDelta >= 0 ? '+' : ''}{a.meanDelta.toFixed(1)}m</span>
                  <span title="top cause" className="text-sky-300">{a.topCause} ({a.topN})</span>
                  <span className="ml-auto">M{a.miss} T{a.tight}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="airport mean score">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: '25%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '55%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '80%' }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="region">{a.apt.region}</span>
                  <span title="rwy throughput mov/hr">thru {a.apt.thru}/hr</span>
                  <span className="ml-auto truncate" style={{ color: a.worstTier === 'OK' || a.worstTier === 'IDLE' ? '#64748b' : TIER_COLOR[a.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
