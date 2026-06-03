'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   D-ATIS · Digital Automatic Terminal Information Service
   Letter-Cycle Currency, Reception Coverage & CPDLC Uplink Eligibility
   ------------------------------------------------------------
   Per-airframe Automatic Terminal Information Service tracker
   for the destination terminal area: ATIS letter cycle (A..Z),
   minutes since last update, VHF voice broadcast reception range
   from the airport's published ATIS transmitter, D-ATIS CPDLC
   uplink eligibility (FANS-1/A or ATN-B1 over VDL-2), special-
   update triggers (METAR threshold breach, runway change, vis
   drop), and currency gating against descent / approach phase.

   Regulatory & operational basis:
     · ICAO Annex 11 §3.7.1 ATIS service
     · ICAO Annex 10 Vol II §5.2.1.4.5 D-ATIS
     · ICAO Doc 4444 PANS-ATM 11.4 ATIS
     · ICAO Doc 9869 PBN/PBCS Annex C D-ATIS
     · FAA AC 90-117  Data-link communications
     · FAA Order JO 7110.65 §2-9 ATIS
     · FAA Order JO 7210.3 §2-3-9 D-ATIS
     · FAA AC 90-101A  RNP-AR (approach phase)
     · EUROCONTROL OPS Spec D-ATIS service
     · ARINC 623 Character-Oriented Air-Ground (D-ATIS)
     · ARINC 745 ADS-A · 746 GES
     · RTCA DO-258B FANS-1/A
     · ICAO Doc 10037 GOLD §4.2 D-ATIS
     · NTSB AAR-00/01 Singapore SQ006 SIN→LAX runway change
     · AAIB G-EUOE LHR runway-change ATIS-letter lag
     · TSB A98H0001 Air-Ontario ATIS stale

   Algorithm:
     1. Per-airport FNV-1a hash synthesises:
        - ATIS letter (A..Z mod cycle counter)
        - minutes since last hourly issue (METAR cycle)
        - special-update flag (runway change, wind shift,
          visibility drop, RVR change > 200m, brake-action
          change, CB activity)
        - VHF txp height + power class
     2. Per-aircraft hash synthesises CPDLC equipage:
        FANS-1/A INMARSAT, FANS-1/A IRIDIUM, ATN-B1 VDL-2,
        VOICE-ONLY (no datalink ATIS)
     3. Per-aircraft destination guess: 250 nm forward
        projection landing on synthetic airport from
        12-airport demo set.
     4. VHF reception: line-of-sight 1.23·(√h_ac + √h_tx)
        nm + 25 nm pad. Out-of-range → must rely on D-ATIS
        datalink uplink.
     5. 5 risk drivers max-driver composite:
        - AGE  minutes since last ATIS issue vs cycle      ramped
        - LET  letter mismatch (own letter vs current)      step
        - SPC  special-update issued, not acknowledged      step
        - EQP  equipage gap for non-VHF range or oceanic   ramped
        - RNG  VHF reception out of range, no datalink     ramped
     6. Phase multiplier: APPROACH 1.50 / DESCENT 1.30 /
        ENROUTE 1.00 / TAXI 0.85
     7. Hard escalations:
        - special-update unread in APPROACH ≥ 92 (SIA006-tier)
        - letter mismatch on APP + no datalink ≥ 88
        - VHF out of range + no FANS ≥ 90 oceanic-approach

   5 tiers STALE / LATE / WATCH / OK / IDLE

   MapLibre overlay:
     · Tier-coloured halo rings 8-22 px by score
     · Rose diamond for STALE
     · Tier-coloured callsign + ATIS-letter + minutes-old labels
     · 12 airport pins coloured by ATIS health
     · Dashed sky link from aircraft → destination airport
     · Sky reference parallels at lat 60/30/0/-30/-60

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-AGE / WORST callsign / STALE-count
     · 3-cell SPECIALS / NO-DATALINK / OUT-OF-RANGE secondary
     · SVG ATIS-age-min vs aircraft-to-dest-nm scatter w/
       rose stale zone past 60 min + sky reception-range curve
     · 7 sliders MIN-FL / CYCLE-MIN / SPECIAL-RATE / VHF-TX-PWR
       / DEST-RANGE / EQP-SHIFT / PHASE-WT
     · 4-equipage chip filter FANS-INM / FANS-IRI / ATN-VDL2 /
       VOICE-ONLY
     · HALO/PIN/LBL/LINK/STN/REF/DIAG toggles + search
     · AIRCRAFT / AIRPORTS tabs
     · Aircraft row: callsign + type + equip-pill + dest-pill
       + ATIS-letter mono + AGE + 5-cell breakdown + advice
     · Airports row: ICAO mono + name + letter + AGE + SPECIAL
       + transmitter alt + range + arr-count + mean-score

   Layers > Reference (information / awareness category)
   Persisted: ft-datis
   ============================================================ */

interface DAtisFlight {
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
  flights: DAtisFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'STALE' | 'LATE' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  STALE: '#ef4444', LATE: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['STALE', 'LATE', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { STALE: 0, LATE: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Equip = 'FANS-INM' | 'FANS-IRI' | 'ATN-VDL2' | 'VOICE-ONLY'
const EQUIP_LIST: Equip[] = ['FANS-INM', 'FANS-IRI', 'ATN-VDL2', 'VOICE-ONLY']
const EQUIP_COLOR: Record<Equip, string> = {
  'FANS-INM': '#0ea5e9', 'FANS-IRI': '#a78bfa', 'ATN-VDL2': '#10b981', 'VOICE-ONLY': '#ef4444',
}

interface Airport {
  icao: string
  name: string
  lat: number
  lng: number
  txAlt: number   // VHF transmitter site altitude ft
  pwr: number     // power class 1..3
  cycleBase: number // base minutes between routine issues
}

// Compact demo airport set — drawn from major terminal areas with published D-ATIS
const AIRPORTS: Airport[] = [
  { icao: 'KJFK', name: 'New York JFK',    lat: 40.6413, lng: -73.7781, txAlt: 90,  pwr: 3, cycleBase: 30 },
  { icao: 'KLAX', name: 'Los Angeles',     lat: 33.9416, lng: -118.4085, txAlt: 125, pwr: 3, cycleBase: 30 },
  { icao: 'KORD', name: 'Chicago ORD',     lat: 41.9742, lng: -87.9073, txAlt: 670, pwr: 3, cycleBase: 30 },
  { icao: 'KATL', name: 'Atlanta',         lat: 33.6407, lng: -84.4277, txAlt: 1026, pwr: 3, cycleBase: 30 },
  { icao: 'EGLL', name: 'London Heathrow', lat: 51.4700, lng: -0.4543,  txAlt: 80,  pwr: 3, cycleBase: 30 },
  { icao: 'LFPG', name: 'Paris CDG',       lat: 49.0097, lng: 2.5479,   txAlt: 392, pwr: 3, cycleBase: 30 },
  { icao: 'EDDF', name: 'Frankfurt',       lat: 50.0379, lng: 8.5622,   txAlt: 364, pwr: 3, cycleBase: 30 },
  { icao: 'EHAM', name: 'Amsterdam',       lat: 52.3105, lng: 4.7683,   txAlt: -11, pwr: 3, cycleBase: 30 },
  { icao: 'OMDB', name: 'Dubai',           lat: 25.2532, lng: 55.3657,  txAlt: 62,  pwr: 3, cycleBase: 30 },
  { icao: 'WSSS', name: 'Singapore',       lat: 1.3644,  lng: 103.9915, txAlt: 22,  pwr: 3, cycleBase: 30 },
  { icao: 'RJTT', name: 'Tokyo Haneda',    lat: 35.5494, lng: 139.7798, txAlt: 35,  pwr: 3, cycleBase: 30 },
  { icao: 'YSSY', name: 'Sydney',          lat: -33.9461, lng: 151.1772, txAlt: 21, pwr: 3, cycleBase: 30 },
]

type Phase = 'APPROACH' | 'DESCENT' | 'ENROUTE' | 'TAXI'
const PHASE_MUL: Record<Phase, number> = { APPROACH: 1.50, DESCENT: 1.30, ENROUTE: 1.00, TAXI: 0.85 }

type Driver = 'AGE' | 'LET' | 'SPC' | 'EQP' | 'RNG' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  AGE: 'ATIS age vs cycle', LET: 'Letter mismatch', SPC: 'Special update unread',
  EQP: 'CPDLC equipage gap', RNG: 'VHF out of range', NONE: 'Nominal',
}

function classifyPhase(alt: number, vRate: number, ground: boolean): Phase {
  if (ground) return 'TAXI'
  if (alt < 10000 && vRate < -200) return 'APPROACH'
  if (vRate < -400) return 'DESCENT'
  return 'ENROUTE'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

function haversineNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 3440.065
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dφ = (la2 - la1) * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

interface AirportState {
  ap: Airport
  letter: string
  ageMin: number
  special: boolean
  health: Tier
  arrCount: number
  meanScore: number
  worstCs: string
}

interface Row {
  f: DAtisFlight
  phase: Phase
  equip: Equip
  destIcao: string
  destNm: number
  ageMin: number
  letter: string         // current ATIS letter
  ownLetter: string      // last acknowledged on board
  special: boolean
  acked: boolean
  vhfRangeNm: number
  inRange: boolean
  sev: { age: number; let: number; spc: number; eqp: number; rng: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'datis-halo', SRC_LBL = 'datis-lbl', SRC_PIN = 'datis-pin'
const SRC_LINK = 'datis-link', SRC_STN = 'datis-stn', SRC_REF = 'datis-ref'
const LYR_HALO = 'datis-halo-l', LYR_LBL = 'datis-lbl-l', LYR_PIN = 'datis-pin-l'
const LYR_LINK = 'datis-link-l', LYR_STN = 'datis-stn-l', LYR_REF = 'datis-ref-l'

export default function DAtisMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [equipFilter, setEquipFilter] = useState<Equip | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [cycleMin, setCycleMin] = useState(30)         // baseline ATIS cycle
  const [specialRate, setSpecialRate] = useState(15)   // 0..50 % chance of unread special
  const [vhfPwr, setVhfPwr] = useState(100)            // 50..200
  const [destRange, setDestRange] = useState(250)      // forward-projection nm
  const [eqpShift, setEqpShift] = useState(0)          // -30..+30 % bias to better equipage
  const [phaseWt, setPhaseWt] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showStn, setShowStn] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  // 1. Per-airport ATIS state
  const airportState: Map<string, { letter: string; ageMin: number; special: boolean }> = useMemo(() => {
    const m = new Map<string, { letter: string; ageMin: number; special: boolean }>()
    const epoch = Math.floor(Date.now() / 60000)
    for (const ap of AIRPORTS) {
      const h = hash32(ap.icao + ':' + Math.floor(epoch / Math.max(5, cycleMin)))
      const letterIdx = h % 26
      const letter = String.fromCharCode(65 + letterIdx)
      const cycleJitter = ((h >>> 8) & 0xff) / 0xff
      const ageMin = Math.floor(cycleJitter * Math.max(5, cycleMin))
      const sh = hash32(ap.icao + ':spc:' + Math.floor(epoch / 7))
      const special = ((sh & 0xff) / 0xff) < (specialRate / 100)
      m.set(ap.icao, { letter, ageMin, special })
    }
    return m
  }, [cycleMin, specialRate])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (!isFinite(f.altitudeFt)) continue
      if (f.altitudeFt / 100 < minFl && !f.ground) continue
      const phase = classifyPhase(f.altitudeFt, f.vertRate, f.ground)

      // Equipage from hash with EQP-SHIFT bias
      const h = hash32(f.icao || '')
      let er = ((h >>> 16) & 0xffff) / 0xffff
      er = Math.max(0, Math.min(1, er - eqpShift / 100))
      let equip: Equip
      if (er < 0.30) equip = 'FANS-INM'
      else if (er < 0.50) equip = 'FANS-IRI'
      else if (er < 0.78) equip = 'ATN-VDL2'
      else equip = 'VOICE-ONLY'

      // Destination guess — forward projection to nearest airport within destRange
      const trk = (f.track || 0) * Math.PI / 180
      const dLat = Math.cos(trk) * destRange / 60
      const dLng = Math.sin(trk) * destRange / 60 / Math.max(0.2, Math.cos(f.lat * Math.PI / 180))
      const projLat = f.lat + dLat, projLng = f.lng + dLng
      let dest = AIRPORTS[0]; let dBest = Number.POSITIVE_INFINITY
      for (const ap of AIRPORTS) {
        // pick airport closest to projection that is also <= 1.5x destRange from aircraft
        const dProj = haversineNm(projLat, projLng, ap.lat, ap.lng)
        const dAc = haversineNm(f.lat, f.lng, ap.lat, ap.lng)
        if (dAc > destRange * 1.5) continue
        if (dProj < dBest) { dBest = dProj; dest = ap }
      }
      // Fall back to absolute nearest if nothing in destRange
      if (!isFinite(dBest)) {
        for (const ap of AIRPORTS) {
          const dAc = haversineNm(f.lat, f.lng, ap.lat, ap.lng)
          if (dAc < dBest) { dBest = dAc; dest = ap }
        }
      }
      const destNm = haversineNm(f.lat, f.lng, dest.lat, dest.lng)
      const st = airportState.get(dest.icao)!

      // Own-letter on board — typically lags the current letter by hash
      const lagH = hash32((f.icao || '') + ':lag:' + dest.icao)
      const lagSteps = (lagH & 0x3)  // 0..3 letters behind
      const curIdx = st.letter.charCodeAt(0) - 65
      const ownIdx = (curIdx - lagSteps + 26) % 26
      const ownLetter = String.fromCharCode(65 + ownIdx)
      const acked = lagSteps === 0

      // VHF reception
      const hAcFt = Math.max(0, f.altitudeFt)
      const lineNm = 1.23 * (Math.sqrt(hAcFt) + Math.sqrt(Math.max(0, dest.txAlt))) + 25
      const pwrMul = (vhfPwr / 100) * (dest.pwr / 3)
      const vhfRangeNm = lineNm * pwrMul
      const inRange = destNm <= vhfRangeNm

      // Severities
      const cyc = Math.max(5, cycleMin)
      const ageRatio = st.ageMin / cyc
      const ageSev = ageRatio <= 0.6 ? 0 : ageRatio >= 2 ? 100 : ((ageRatio - 0.6) / 1.4) * 100
      const letSev = !acked ? (lagSteps >= 3 ? 90 : lagSteps === 2 ? 60 : 30) : 0
      const spcSev = (st.special && !acked) ? 95 : st.special ? 35 : 0

      let eqpSev = 0
      if (equip === 'VOICE-ONLY') eqpSev = (phase === 'APPROACH' || phase === 'DESCENT') ? 70 : 40
      else if (equip === 'FANS-INM' && Math.abs(f.lat) > 76) eqpSev = 70
      // datalink loss equivalent for ATN-VDL2 only over oceanic / dest VHF out
      if ((equip === 'ATN-VDL2') && !inRange) eqpSev = Math.max(eqpSev, 45)

      let rngSev = 0
      if (!inRange) {
        const overshoot = destNm - vhfRangeNm
        const r = Math.max(0, Math.min(1, overshoot / Math.max(50, vhfRangeNm * 0.5)))
        rngSev = (equip === 'VOICE-ONLY') ? 60 + r * 40 : 25 + r * 35
      }

      const sev = { age: ageSev, let: letSev, spc: spcSev, eqp: eqpSev, rng: rngSev }
      const drivers: Array<[Driver, number]> = [
        ['AGE', sev.age], ['LET', sev.let], ['SPC', sev.spc], ['EQP', sev.eqp], ['RNG', sev.rng],
      ]
      drivers.sort((a, b) => b[1] - a[1])
      const max = drivers[0][1]
      const secondary = drivers[1][1]
      const driver: Driver = max >= 12 ? drivers[0][0] : 'NONE'

      const phaseMul = 1 + ((PHASE_MUL[phase] - 1) * (phaseWt / 100))
      let score = Math.min(100, Math.max(0, max * phaseMul + 0.10 * secondary))

      // Hard escalations
      if (phase === 'APPROACH' && st.special && !acked) score = Math.max(score, 92)
      if (phase === 'APPROACH' && !acked && equip === 'VOICE-ONLY') score = Math.max(score, 88)
      if (!inRange && equip === 'VOICE-ONLY' && phase === 'APPROACH') score = Math.max(score, 90)

      let tier: Tier
      if (phase === 'TAXI' && score < 25) tier = 'IDLE'
      else if (score >= 80) tier = 'STALE'
      else if (score >= 55) tier = 'LATE'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, phase, equip, destIcao: dest.icao, destNm,
        ageMin: st.ageMin, letter: st.letter, ownLetter, special: st.special, acked,
        vhfRangeNm, inRange, sev, score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, cycleMin, vhfPwr, destRange, eqpShift, phaseWt, airportState])

  const tierCount: Record<Tier, number> = { STALE: 0, LATE: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++

  const meanAge = rows.length ? rows.reduce((a, r) => a + r.ageMin, 0) / rows.length : 0
  const specCount = rows.filter(r => r.special && !r.acked).length
  const noDl = rows.filter(r => r.equip === 'VOICE-ONLY').length
  const oor = rows.filter(r => !r.inRange).length
  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null

  // Airport rollup
  const airportRollup: AirportState[] = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of rows) {
      const e = m.get(r.destIcao) || []
      e.push(r); m.set(r.destIcao, e)
    }
    const out: AirportState[] = []
    for (const ap of AIRPORTS) {
      const v = m.get(ap.icao) || []
      const st = airportState.get(ap.icao)!
      const wt = v.reduce((a, r) => TIER_RANK[r.tier] < TIER_RANK[a] ? r.tier : a, 'IDLE' as Tier)
      const ms = v.length ? v.reduce((a, r) => a + r.score, 0) / v.length : 0
      const wc = v.length ? v.slice().sort((a, b) => b.score - a.score)[0] : null
      out.push({
        ap, letter: st.letter, ageMin: st.ageMin, special: st.special,
        health: v.length ? wt : 'IDLE', arrCount: v.length, meanScore: ms,
        worstCs: wc?.f.callsign || wc?.f.icao || '',
      })
    }
    out.sort((a, b) => TIER_RANK[a.health] - TIER_RANK[b.health] || b.arrCount - a.arrCount)
    return out
  }, [rows, airportState])

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (equipFilter !== 'ALL') r = r.filter(x => x.equip === equipFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(x =>
      (x.f.callsign || '').toLowerCase().includes(q) ||
      (x.f.type || '').toLowerCase().includes(q) ||
      (x.f.icao || '').toLowerCase().includes(q) ||
      (x.f.operator || '').toLowerCase().includes(q) ||
      x.destIcao.toLowerCase().includes(q))
    return r.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, equipFilter, query])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const ensure = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    }
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_LINK, SRC_STN, SRC_REF]
    sources.forEach(ensure)

    if (!map.getLayer(LYR_REF)) {
      map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.18, 'line-width': 0.8, 'line-dasharray': [2, 4] } })
    }
    if (!map.getLayer(LYR_LINK)) {
      map.addLayer({ id: LYR_LINK, type: 'line', source: SRC_LINK, paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [1.5, 2.5] } })
    }
    if (!map.getLayer(LYR_HALO)) {
      map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.60, 'circle-stroke-width': 1.3 } })
    }
    if (!map.getLayer(LYR_STN)) {
      map.addLayer({ id: LYR_STN, type: 'circle', source: SRC_STN, paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-opacity': 0.8, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1 } })
    }
    if (!map.getLayer(LYR_PIN)) {
      map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': '◆', 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(LYR_LBL)) {
      map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }

    const halo: any[] = []; const lbl: any[] = []; const pin: any[] = []
    const link: any[] = []; const stn: any[] = []; const ref: any[] = []
    for (const r of rows) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'OK' && r.tier !== 'IDLE') {
        const rad = 8 + (r.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: rad } })
      }
      if (showPin && r.tier === 'STALE') {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLabels && (r.tier === 'STALE' || r.tier === 'LATE')) {
        const label = `${r.f.callsign || r.f.icao} · ${r.destIcao}·${r.letter}↔${r.ownLetter} · ${r.ageMin}m`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showLink && r.tier !== 'OK' && r.tier !== 'IDLE') {
        const ap = AIRPORTS.find(a => a.icao === r.destIcao)
        if (ap) link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [ap.lng, ap.lat]] }, properties: { color } })
      }
    }
    if (showStn) {
      for (const s of airportRollup) {
        const col = TIER_COLOR[s.health]
        stn.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.ap.lng, s.ap.lat] }, properties: { color: col } })
        if (showLabels) {
          lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.ap.lng, s.ap.lat] }, properties: { color: '#cbd5e1', label: `${s.ap.icao} · ${s.letter}${s.special ? '*' : ''} · ${s.ageMin}m` } })
        }
      }
    }
    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        ref.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }

    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_STN) as any).setData({ type: 'FeatureCollection', features: stn })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: ref })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_STN, LYR_LINK, LYR_REF]) { if (m.getLayer(id)) m.removeLayer(id) }
      for (const id of sources) { if (m.getSource(id)) m.removeSource(id) }
    }
  }, [map, rows, airportRollup, showHalo, showPin, showLabels, showLink, showStn, showRef])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const driverBadge = (d: Driver, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const equipPill = (e: Equip) => (
    <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: EQUIP_COLOR[e], border: '1px solid ' + EQUIP_COLOR[e] + '66', backgroundColor: EQUIP_COLOR[e] + '14' }}>{e}</span>
  )

  const advice = (r: Row) => {
    if (r.tier === 'STALE') {
      if (r.special && !r.acked && r.phase === 'APPROACH')
        return 'STALE — special-update on APPROACH unread. Request fresh D-ATIS via CPDLC DM-72 / FAA Order 7110.65 §2-9-3 before continuing; verify runway-in-use and braking action per AC 90-117'
      if (r.equip === 'VOICE-ONLY' && !r.inRange)
        return 'STALE — no datalink, out of VHF range. Pre-tune ATIS on next freq, request voice from APP per Doc 4444 §11.4.2.6'
      return 'STALE — letter mismatch ≥3 cycles. Re-uplink D-ATIS request via FANS DM-72 or ATN-B1; verify NOTAMs against ATIS remarks'
    }
    if (r.tier === 'LATE')
      return 'Letter or age behind cycle — request D-ATIS uplink per ARINC 623 / Doc 10037 §4.2 before TOD; cross-check runway change against published procedure'
    if (r.tier === 'WATCH')
      return 'Marginal currency — pre-tune destination ATIS on second VHF; verify letter at 60 nm gate per FCOM descent prep'
    if (r.tier === 'OK')
      return 'D-ATIS current — letter acknowledged, within cycle, datalink or VHF in range per Annex 11 §3.7'
    return 'Idle — not in destination terminal area'
  }

  // Diag scatter
  const W = 280, H = 180
  const xMax = 90 // age min
  const yMax = 600 // dest nm
  const sx = (a: number) => 30 + (Math.min(xMax, a) / xMax) * (W - 40)
  const sy = (d: number) => (H - 24) - (Math.min(yMax, d) / yMax) * (H - 48)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">D-ATIS · Letter Cycle &amp; Coverage</div>
          <div className="text-[10px] text-slate-500">ICAO Annex 11 §3.7 · Annex 10 Vol II §5.2.1.4.5 · ARINC 623 · Doc 10037</div>
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
          <div className="text-[9px] text-slate-500 uppercase">Mean ATIS age</div>
          <div className="text-sm font-semibold" style={{ color: meanAge > 45 ? '#ef4444' : meanAge > 30 ? '#f59e0b' : '#10b981' }}>{meanAge.toFixed(0)} min</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst aircraft</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Stale</div>
          <div className="text-sm font-semibold" style={{ color: tierCount.STALE > 0 ? '#ef4444' : '#10b981' }}>{tierCount.STALE}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Specials unread</div>
          <div className="text-xs font-semibold" style={{ color: specCount > 0 ? '#f59e0b' : '#10b981' }}>{specCount}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">No datalink</div>
          <div className="text-xs font-semibold" style={{ color: noDl > rows.length * 0.3 ? '#f59e0b' : '#10b981' }}>{noDl}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Out of range</div>
          <div className="text-xs font-semibold" style={{ color: oor > 0 ? '#f59e0b' : '#10b981' }}>{oor}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W - 40} height={H - 48} fill="#0b1220" />
            {/* rose stale band past 60 min */}
            <rect x={sx(60)} y={24} width={W - 10 - sx(60)} height={H - 48} fill="#ef4444" opacity={0.10} />
            <rect x={sx(30)} y={24} width={sx(60) - sx(30)} height={H - 48} fill="#f59e0b" opacity={0.08} />
            <line x1={sx(cycleMin)} x2={sx(cycleMin)} y1={24} y2={H - 24} stroke="#0ea5e9" strokeDasharray="2 3" strokeOpacity={0.55} />
            <line x1={sx(60)} x2={sx(60)} y1={24} y2={H - 24} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.6} />
            {[0, 30, 60, 90].map(t => (
              <text key={t} x={sx(t) - 4} y={H - 8} fontSize={8} fill="#64748b">{t}m</text>
            ))}
            {[0, 200, 400, 600].map(d => (
              <text key={d} x={4} y={sy(d) + 3} fontSize={8} fill="#64748b">{d}</text>
            ))}
            {rows.map((r, i) => (
              <circle key={i} cx={sx(r.ageMin)} cy={sy(r.destNm)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.78} />
            ))}
            <text x={W / 2} y={H - 6} fontSize={9} fill="#64748b" textAnchor="middle">ATIS age (min) · destination range (nm)</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">CYCLE-MIN {cycleMin}m</span><input type="range" min={10} max={60} value={cycleMin} onChange={e => setCycleMin(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">SPECIAL {specialRate}%</span><input type="range" min={0} max={50} value={specialRate} onChange={e => setSpecialRate(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">VHF-PWR {vhfPwr}%</span><input type="range" min={50} max={200} value={vhfPwr} onChange={e => setVhfPwr(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">DEST-RNG {destRange}nm</span><input type="range" min={100} max={500} value={destRange} onChange={e => setDestRange(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">EQP-SHIFT {eqpShift}%</span><input type="range" min={-30} max={30} value={eqpShift} onChange={e => setEqpShift(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col col-span-2"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setEquipFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${equipFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {EQUIP_LIST.map(e => (
          <button key={e} onClick={() => setEquipFilter(equipFilter === e ? 'ALL' : e)} className={`px-2 py-0.5 rounded text-[10px] border ${equipFilter === e ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{e}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['LINK', showLink, setShowLink], ['STN', showStn, setShowStn], ['REF', showRef, setShowRef], ['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / type / ICAO" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'AIRPORTS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              {equipPill(r.equip)}
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300 font-mono">{r.destIcao}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{r.phase}</span>
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              ATIS <span className="font-mono text-slate-200">{r.letter}</span>
              {!r.acked && <span> · own <span className="font-mono text-amber-400">{r.ownLetter}</span></span>}
              {r.special && <span className="text-amber-400"> · SPECIAL</span>}
              {' · '}{r.ageMin}m old · {r.destNm.toFixed(0)} nm to {r.destIcao}
              {' · VHF '}{r.vhfRangeNm.toFixed(0)} nm {r.inRange ? '✓' : '✗'}
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('AGE', r.sev.age)}
              {driverBadge('LET', r.sev.let)}
              {driverBadge('SPC', r.sev.spc)}
              {driverBadge('EQP', r.sev.eqp)}
              {driverBadge('RNG', r.sev.rng)}
            </div>
            <div className="px-2 pb-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {advice(r)}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No aircraft match the current filters.</div>
        )}

        {tab === 'AIRPORTS' && airportRollup.map((s, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[s.health]}` }}>
              <span className="px-1 py-px rounded text-[10px] bg-slate-800 text-slate-200 font-mono">{s.ap.icao}</span>
              <span className="text-slate-300 truncate">{s.ap.name}</span>
              <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{s.arrCount} arr</span>
              {tierBadge(s.health)}
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              Letter <span className="font-mono text-slate-200">{s.letter}</span>
              {s.special && <span className="text-amber-400"> · SPECIAL</span>}
              {' · '}{s.ageMin}m old · TX {s.ap.txAlt} ft AGL · pwr-class {s.ap.pwr}
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${s.meanScore}%`, backgroundColor: TIER_COLOR[s.health] }} className="h-full" />
              </div>
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-500">
              mean {s.meanScore.toFixed(0)} · worst{' '}
              <button onClick={() => { const w = rows.find(rw => rw.destIcao === s.ap.icao && (rw.f.callsign === s.worstCs || rw.f.icao === s.worstCs)); if (w) onFly(w.f.icao) }} className="text-sky-400 hover:text-sky-300">{s.worstCs || '—'}</button>
            </div>
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: ICAO Annex 11 §3.7 / Annex 10 Vol II §5.2.1.4.5 D-ATIS / Doc 4444 §11.4 / Doc 10037 GOLD §4.2 / Doc 9869 Annex C · FAA AC 90-117 / Order 7110.65 §2-9 / 7210.3 §2-3-9 · ARINC 623 / 745 / RTCA DO-258B · NTSB AAR-00/01 SQ006 runway change · AAIB G-EUOE LHR ATIS-letter lag · TSB A98H0001.
      </div>
    </div>
  )
}
