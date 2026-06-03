'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   VOLMET (Voice Meteorological Information Broadcast)
   HF/VHF Coverage, Schedule-Slot Currency & FIR-Weather
   Monitoring Subsystem
   -----------------------------------------------------------
   Per-airframe scheduled-broadcast tracker for ICAO Aeronautical
   Voice Meteorological Information service — the worldwide
   network of HF "Main" VOLMETs (NAM EUR MID AFI ASIA PAC SAM
   SAT) and selected VHF terminal-area VOLMETs (London VOLMET
   Main, Stockholm VOLMET, Frankfurt VOLMET, etc.) defined in
   ICAO Annex 3 Ch 11 §11.5 and Doc 7030 Regional SUPPS,
   broadcasting METAR / TAF / SIGMET in 5-minute serial slots
   per Doc 7030 timeshare matrices.

   Regulatory & operational basis:
     · ICAO Annex 3 §11.5 VOLMET service
     · ICAO Annex 10 Vol II §5.2 / Vol III Pt II Ch 2 HF voice
     · ICAO Doc 7030 Regional SUPPS — VOLMET timeshare per FIR
     · ICAO Doc 8896 Manual of Aeronautical Met Practice ch 9
     · ICAO Doc 9377 Met / ATS / Operations Coordination
     · ICAO Doc 4444 PANS-ATM 4.3.5 met info to aircraft
     · ICAO Doc 9377 App 1 VOLMET frequencies & schedules
     · WMO No. 49 Vol II Met Service to Intl Air Navigation
     · WMO No. 306 Manual on Codes (METAR/TAF/SIGMET)
     · FAA Order JO 7110.65 §2-6-1 met advisory
     · FAA AC 91-70B Ch 5 oceanic met
     · NAT Doc 007 Ch 11 NAT VOLMET (Gander/Shanwick/NY)
     · EUR Doc 014 EUR VOLMET (Shannon/London/Stockholm)
     · ITU-R RR App 27 Aeronautical (R) HF bands

   12-station VOLMET catalogue (ID / type / freq / FIRs served):
     · NY-VMET  HF NAT Main      3485/6604/10051/13270 New York
     · GANDER   HF NAT Main      3485/6604/10051/13270 Gander
     · SHANWICK HF NAT Main      3413/5505/8957/13264  EGGX
     · ICELAND  HF NAT Sec       3413/5505/8957/11279  BIRD
     · SHANNON  VHF EUR Term     127.000              EISN
     · LONDON   VHF EUR Term     135.375              EGTT/EGPX
     · STOCK    VHF EUR Term     120.575              ESAA/ESOS
     · FFM-VMT  VHF EUR Term     119.150              EDFF/EDMM
     · KARACHI  HF MID Main      3413/5505/8918/13270 OPKR/OPLR
     · MUMBAI   HF ASIA Main     3413/5505/8918/13312 VABF/VOMF
     · HK-VMET  HF PAC Main      2965/6679/8828/13282 VHHK/RCAA
     · AUCKLD   HF PAC Main      6679/8828/13282      NZZO

   Slot algebra (Doc 7030 5-min timeshare):
     Each station broadcasts during its assigned H+nn..H+(nn+4)
     minute window in the 60-min hour. Per FIR weather is part
     of the spoken cycle — a target FIR is "in-slot" only
     during that 5-min window. Out-of-slot ⇒ wait up to 55 min.

   Per-airframe state (hash-stable per ICAO24):
     · Current FIR via lat/lng band detector (NAT/EUR/MID/etc.)
     · Destination FIR proxy via heading projection ~ 400 nm
     · Required station = best VOLMET serving (current ∪ dest)
       FIRs within HF or VHF reception range
     · Slot phase = ((nowMin + STATION_OFFSET) % 60) in [start,
       start+5) per station; computes "minutes until next slot"
     · VHF reception: 1.23·(√h_ft+√h_ant) +/- 50 nm pad
     · HF reception: groundwave + 2-hop skywave 350-4200 nm
       gated by HF-SSN, K-INDEX, DAY-FRAC sliders
     · Met-cycle age tracked from "last receivable broadcast"
     · Receiver equipage hash-stable: HF+VHF / VHF-only / HF-only
       weighted by aircraft class

   5 risk drivers, max-driver composite:
     · COV  no in-range VOLMET station for current+destination
            FIR pair (100 if 0 / 55 if HF-only on jet airway /
            25 if 1 station marginal / 0 if ≥2)
     · SLT  next slot wait time (0 at <5 min / 25 at <15 /
            55 at <30 / 85 at <45 / 100 at ≥45)
     · AGE  minutes since last receivable cycle (0 at <30 /
            25 at <60 / 55 at <90 / 100 ≥120)
     · EQP  airframe receiver gap (100 if NO-VOLMET-receiver /
            55 if VHF-only outside terminal area /
            35 if HF-only in low-SSN / 0 nominal)
     · MET  destination FIR SIGMET-active flag (90 if SIGMET
            active and slot stale, 50 if active but in-slot)

   Phase multiplier 1.30 OCEANIC / 1.15 REMOTE / 1.00 ENROUTE /
     0.85 TERMINAL.
   Hard escalations:
     · No coverage + oceanic ≥ 88
     · Destination SIGMET + AGE ≥ 90 min ≥ 92
     · NO-VOLMET-receiver + oceanic ≥ 85

   5 tiers WX-LOST / WX-STALE / WX-WATCH / WX-OK / IDLE.

   Output:
     · MapLibre overlay: tier halos, rose pin on WX-LOST,
       12 VOLMET station markers coloured by network
       (NAT-sky EUR-emerald MID-violet ASIA-amber PAC-cyan),
       dashed tier-coloured aircraft→best-station links,
       station out-of-slot rendered slate, in-slot rendered
       network colour with pulsing radius
     · Side panel: 5-tier strip, 6-cell summary, slot timeline
       SVG showing 12-station hour wheel with NOW marker,
       7 sliders, station-network chips, HALO/PIN/LBL/LINK/STN/
       REF/DIAG toggles, AIRCRAFT/STATIONS/SLOTS tab switcher,
       click-to-fly rows with tier-coloured advice.

   Layers > Environment.
   Persisted: ft-volmet
   ============================================================ */

interface AirFlight {
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
  flights: AirFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'WX-LOST' | 'WX-STALE' | 'WX-WATCH' | 'WX-OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'WX-LOST': '#ef4444', 'WX-STALE': '#f59e0b', 'WX-WATCH': '#0ea5e9', 'WX-OK': '#10b981', IDLE: '#64748b',
}
const TIER_LABEL: Record<Tier, string> = {
  'WX-LOST': 'WX-LOST', 'WX-STALE': 'STALE', 'WX-WATCH': 'WATCH', 'WX-OK': 'OK', IDLE: 'IDLE',
}
const TIER_ORDER: Tier[] = ['WX-LOST', 'WX-STALE', 'WX-WATCH', 'WX-OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { 'WX-LOST': 0, 'WX-STALE': 1, 'WX-WATCH': 2, 'WX-OK': 3, IDLE: 4 }

type Network = 'NAT' | 'EUR' | 'MID' | 'ASIA' | 'PAC'
const NETWORK_COLOR: Record<Network, string> = {
  NAT: '#0ea5e9', EUR: '#10b981', MID: '#a78bfa', ASIA: '#f59e0b', PAC: '#06b6d4',
}

interface Station {
  id: string
  name: string
  network: Network
  band: 'HF' | 'VHF'
  freqs: number[]      // kHz for HF, MHz*1000 for VHF
  lat: number
  lng: number
  slotStart: number    // minute past hour (start of 5-min slot)
  slotLen: number      // length min
  firs: string[]       // covered FIRs
}

const STATIONS: Station[] = [
  { id: 'NY-VMET',  name: 'New York VOLMET',  network: 'NAT', band: 'HF',  freqs: [3485, 6604, 10051, 13270], lat: 40.64, lng: -73.78, slotStart:  0, slotLen: 5, firs: ['KZAK','KZNY','KZWY','CZQX'] },
  { id: 'GANDER',   name: 'Gander VOLMET',     network: 'NAT', band: 'HF',  freqs: [3485, 6604, 10051, 13270], lat: 48.94, lng: -54.57, slotStart: 20, slotLen: 5, firs: ['CZQX','CZQM','BGGL'] },
  { id: 'SHANWICK', name: 'Shanwick VOLMET',   network: 'NAT', band: 'HF',  freqs: [3413, 5505,  8957, 13264], lat: 53.31, lng:  -7.79, slotStart: 25, slotLen: 5, firs: ['EGGX','EISN','EGTT'] },
  { id: 'ICELAND',  name: 'Iceland VOLMET',    network: 'NAT', band: 'HF',  freqs: [3413, 5505,  8957, 11279], lat: 63.99, lng: -22.62, slotStart: 35, slotLen: 5, firs: ['BIRD','ENOR','BGGL'] },
  { id: 'SHANNON',  name: 'Shannon VOLMET',    network: 'EUR', band: 'VHF', freqs: [127000],                   lat: 52.70, lng:  -8.92, slotStart:  0, slotLen: 6, firs: ['EISN','EGTT'] },
  { id: 'LONDON',   name: 'London VOLMET',     network: 'EUR', band: 'VHF', freqs: [135375],                   lat: 51.47, lng:  -0.46, slotStart:  0, slotLen: 6, firs: ['EGTT','EGPX'] },
  { id: 'STOCK',    name: 'Stockholm VOLMET',  network: 'EUR', band: 'VHF', freqs: [120575],                   lat: 59.65, lng:  17.92, slotStart: 15, slotLen: 5, firs: ['ESAA','ESOS','ENOR'] },
  { id: 'FFM-VMT',  name: 'Frankfurt VOLMET',  network: 'EUR', band: 'VHF', freqs: [119150],                   lat: 50.04, lng:   8.57, slotStart: 20, slotLen: 5, firs: ['EDFF','EDMM','EDWW'] },
  { id: 'KARACHI',  name: 'Karachi VOLMET',    network: 'MID', band: 'HF',  freqs: [3413, 5505,  8918, 13270], lat: 24.91, lng:  67.16, slotStart: 30, slotLen: 5, firs: ['OPKR','OPLR','OMAE'] },
  { id: 'MUMBAI',   name: 'Mumbai VOLMET',     network: 'ASIA',band: 'HF',  freqs: [3413, 5505,  8918, 13312], lat: 19.10, lng:  72.87, slotStart: 40, slotLen: 5, firs: ['VABF','VOMF','OPKR'] },
  { id: 'HK-VMET',  name: 'Hong Kong VOLMET',  network: 'PAC', band: 'HF',  freqs: [2965, 6679,  8828, 13282], lat: 22.31, lng: 113.92, slotStart: 50, slotLen: 5, firs: ['VHHK','RCAA','RJJJ'] },
  { id: 'AUCKLD',   name: 'Auckland VOLMET',   network: 'PAC', band: 'HF',  freqs: [6679, 8828, 13282],        lat: -36.84,lng: 174.74, slotStart: 55, slotLen: 5, firs: ['NZZO','YBBB'] },
]

type AcClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA'
type Phase = 'OCEANIC' | 'REMOTE' | 'ENROUTE' | 'TERMINAL'
const PHASE_MUL: Record<Phase, number> = { OCEANIC: 1.30, REMOTE: 1.15, ENROUTE: 1.00, TERMINAL: 0.85 }

type Equip = 'HF+VHF' | 'VHF-ONLY' | 'HF-ONLY' | 'NONE'
type Driver = 'COV' | 'SLT' | 'AGE' | 'EQP' | 'MET' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  COV: 'Coverage', SLT: 'Slot wait', AGE: 'Cycle age', EQP: 'Equipage', MET: 'Dest SIGMET', NONE: 'Nominal',
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|A38|A34|IL96/.test(t)) return 'HVY-Q'
  if (/B77|B78|A33|A35|MD11/.test(t)) return 'HVY'
  if (/B73|A31|A319|A32|A22|B75|MD8|B71/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E27|E29|F70|F100|AT[47]|DH[48]/.test(t)) return 'RGN'
  if (/G[VI458]|GLF|GLEX|FA[78]X|F2TH|CL30|CL60|C68|C75|BE40|H25|LJ/.test(t)) return 'BIZ'
  if (/AT|DH|SF34|J32|EMB1|BE/.test(t)) return 'TBP'
  return 'GA'
}

function classifyPhase(lat: number, lng: number, alt: number): Phase {
  const absLat = Math.abs(lat)
  const oceanic =
    (absLat > 30 && absLat < 65 && lng > -55 && lng < -10) ||
    ((lat > 20 && lat < 55) && (lng > 150 || lng < -130)) ||
    (lat < -10 && lng > 80 && lng < 130) ||
    (lat < 5 && lat > -40 && lng > 50 && lng < 100)
  const remote = absLat > 70
  if (oceanic && alt > 18000) return 'OCEANIC'
  if (remote && alt > 18000) return 'REMOTE'
  if (alt > 11000) return 'ENROUTE'
  return 'TERMINAL'
}

function inferFir(lat: number, lng: number): string {
  if (lat > 35 && lat < 65 && lng > -55 && lng < -10) return lng < -30 ? 'CZQX' : 'EGGX'
  if (lat > 50 && lat < 65 && lng > -10 && lng < 30) return lng < 10 ? 'EGTT' : 'EDFF'
  if (lat > 55 && lat < 70 && lng > 5 && lng < 30) return 'ESOS'
  if (lat > 25 && lat < 55 && lng > 130 && lng < 180) return 'RJJJ'
  if ((lat > 20 && lat < 55) && (lng > 160 || lng < -130)) return 'KZAK'
  if (lat < -10 && lat > -45 && lng > 110 && lng < 165) return 'YBBB'
  if (lat < -10 && lat > -50 && lng > 165) return 'NZZO'
  if (lat > 60) return 'BGGL'
  if (lat > 25 && lat < 50 && lng > -125 && lng < -65) return 'KZNY'
  if (lat > 12 && lat < 42 && lng > 30 && lng < 75) return 'OMAE'
  if (lat > 12 && lat < 30 && lng > 55 && lng < 75) return 'OPKR'
  if (lat > 5 && lat < 30 && lng > 65 && lng < 90) return 'VABF'
  if (lat > 20 && lat < 30 && lng > 105 && lng < 125) return 'VHHK'
  if (lat > 35 && lat < 55 && lng > -5 && lng < 8) return 'EISN'
  return 'ZZZZ'
}

function projectFir(lat: number, lng: number, track: number, distNm: number): string {
  const rLat = lat * Math.PI / 180
  const dLat = (distNm / 60) * Math.cos(track * Math.PI / 180)
  const dLng = (distNm / 60) * Math.sin(track * Math.PI / 180) / Math.max(0.2, Math.cos(rLat))
  return inferFir(lat + dLat, lng + dLng)
}

function gcDist(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180
  const Δφ = (lat2 - lat1) * Math.PI / 180, Δλ = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function vhfReach(altFt: number): number {
  return 1.23 * (Math.sqrt(Math.max(0, altFt)) + Math.sqrt(50)) + 30
}

function hfReach(altFt: number, ssn: number, kIdx: number, dayFrac: number): { gw: number; sw: number } {
  const gw = 1.23 * (Math.sqrt(Math.max(0, altFt)) + Math.sqrt(50)) + 90
  const ssnMul = 0.55 + 0.012 * ssn       // 0..200%
  const kAtten = Math.max(0.35, 1 - kIdx * 0.10)
  const dayAtten = 1 - 0.30 * Math.abs(dayFrac) // dayFrac -0.5..+0.5
  const sw = 4200 * ssnMul * kAtten * dayAtten
  return { gw, sw: Math.max(350, sw) }
}

function classEquip(klass: AcClass, h: number): Equip {
  const r = ((h >>> 17) & 0xff) / 255
  if (klass === 'HVY-Q' || klass === 'HVY') return r < 0.92 ? 'HF+VHF' : 'VHF-ONLY'
  if (klass === 'NRW') return r < 0.45 ? 'HF+VHF' : r < 0.92 ? 'VHF-ONLY' : 'HF-ONLY'
  if (klass === 'RGN') return r < 0.08 ? 'HF+VHF' : r < 0.92 ? 'VHF-ONLY' : 'NONE'
  if (klass === 'BIZ') return r < 0.65 ? 'HF+VHF' : r < 0.95 ? 'VHF-ONLY' : 'HF-ONLY'
  if (klass === 'TBP') return r < 0.06 ? 'HF+VHF' : r < 0.78 ? 'VHF-ONLY' : 'NONE'
  return r < 0.04 ? 'HF+VHF' : r < 0.68 ? 'VHF-ONLY' : 'NONE'
}

interface Receivable {
  s: Station
  dNm: number
  inSlot: boolean
  minToSlot: number   // minutes until next slot opens (0 if in)
  band: 'HF' | 'VHF'
}

interface Row {
  f: AirFlight
  klass: AcClass
  phase: Phase
  equip: Equip
  curFir: string
  destFir: string
  rx: Receivable[]
  best: Receivable | null
  cycleAgeMin: number
  destSigmet: boolean
  sev: { cov: number; slt: number; age: number; eqp: number; met: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'vmet-halo', SRC_LBL = 'vmet-lbl', SRC_PIN = 'vmet-pin', SRC_LINK = 'vmet-link', SRC_REF = 'vmet-ref', SRC_STN = 'vmet-stn', SRC_STNL = 'vmet-stnl'
const LYR_HALO = 'vmet-halo-l', LYR_LBL = 'vmet-lbl-l', LYR_PIN = 'vmet-pin-l', LYR_LINK = 'vmet-link-l', LYR_REF = 'vmet-ref-l', LYR_STN = 'vmet-stn-l', LYR_STNL = 'vmet-stnl-l'

function nowMinutes(offsetMin: number): number {
  const t = new Date(Date.now() + offsetMin * 60000)
  return t.getUTCMinutes() + t.getUTCSeconds() / 60
}

function slotEval(s: Station, nowM: number): { inSlot: boolean; minToSlot: number } {
  const start = s.slotStart, end = s.slotStart + s.slotLen
  const m = nowM % 60
  if (m >= start && m < end) return { inSlot: true, minToSlot: 0 }
  const delta = m < start ? start - m : 60 - m + start
  return { inSlot: false, minToSlot: delta }
}

export default function VolmetMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'STATIONS' | 'SLOTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [netFilter, setNetFilter] = useState<Network | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(100)
  const [hfSsn, setHfSsn] = useState(100)
  const [kIdx, setKIdx] = useState(2)
  const [dayFrac, setDayFrac] = useState(0)
  const [sigShare, setSigShare] = useState(18)      // % FIRs with active SIGMET
  const [phaseWt, setPhaseWt] = useState(100)
  const [timeShift, setTimeShift] = useState(0)     // minutes of clock shift for simulation
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showStations, setShowStations] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const nowM = useMemo(() => nowMinutes(timeShift), [timeShift])

  // Pre-compute station slot state
  const stationSlot = useMemo(() => {
    const m = new Map<string, { inSlot: boolean; minToSlot: number }>()
    for (const s of STATIONS) m.set(s.id, slotEval(s, nowM))
    return m
  }, [nowM])

  // SIGMET-active FIRs hash-stable
  const sigmetFirs = useMemo(() => {
    const set = new Set<string>()
    if (sigShare <= 0) return set
    const allFirs = new Set<string>()
    for (const s of STATIONS) for (const f of s.firs) allFirs.add(f)
    for (const f of allFirs) {
      const h = hash32('sig:' + f + ':' + Math.floor(Date.now() / 1800000)) / 0xffffffff
      if (h * 100 < sigShare) set.add(f)
    }
    return set
  }, [sigShare])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (!isFinite(f.altitudeFt)) continue
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl) continue
      const h = hash32(f.icao || '')
      const klass = classifyClass(f.type || '')
      const phase = classifyPhase(f.lat, f.lng, f.altitudeFt)
      const equip = classEquip(klass, h)
      const curFir = inferFir(f.lat, f.lng)
      const destFir = projectFir(f.lat, f.lng, f.track, 400)
      const vhfRng = vhfReach(f.altitudeFt)
      const hfR = hfReach(f.altitudeFt, hfSsn, kIdx, dayFrac / 100)
      const interest = new Set<string>([curFir, destFir])
      const rx: Receivable[] = []
      for (const s of STATIONS) {
        const covers = s.firs.some(fr => interest.has(fr))
        if (!covers) continue
        const d = gcDist(f.lat, f.lng, s.lat, s.lng)
        let reachable = false
        if (s.band === 'VHF') {
          if (equip === 'HF+VHF' || equip === 'VHF-ONLY') reachable = d <= vhfRng
        } else {
          if (equip === 'HF+VHF' || equip === 'HF-ONLY') reachable = d <= hfR.gw || (d >= 350 && d <= hfR.sw)
        }
        if (!reachable) continue
        const sl = stationSlot.get(s.id)!
        rx.push({ s, dNm: d, inSlot: sl.inSlot, minToSlot: sl.minToSlot, band: s.band })
      }
      let best: Receivable | null = null
      // Best: in-slot first, then nearest-next-slot, then nearest
      for (const r of rx) {
        if (!best) { best = r; continue }
        if (r.inSlot && !best.inSlot) { best = r; continue }
        if (r.inSlot === best.inSlot) {
          if (r.minToSlot < best.minToSlot) { best = r; continue }
          if (r.minToSlot === best.minToSlot && r.dNm < best.dNm) { best = r }
        }
      }

      // Cycle age = minutes since the most recently passed slot among receivable stations
      let cycleAgeMin = 120
      for (const r of rx) {
        // last slot start was (nowM - ((nowM - slotStart) mod 60))
        const m = nowM % 60
        let delta = m - r.s.slotStart
        if (delta < 0) delta += 60
        if (delta >= r.s.slotLen) delta = delta  // age since slot END is (delta - slotLen) if past
        const age = delta < r.s.slotLen ? 0 : (delta - r.s.slotLen)
        if (age < cycleAgeMin) cycleAgeMin = age
      }
      if (rx.length === 0) cycleAgeMin = 999

      const destSigmet = sigmetFirs.has(destFir) || sigmetFirs.has(curFir)

      // severities
      const cov = rx.length === 0 ? 100 :
                  (rx.length === 1 && phase === 'OCEANIC') ? 55 :
                  (rx.length === 1) ? 25 : 0
      const wait = best ? (best.inSlot ? 0 : best.minToSlot) : 60
      const slt = wait <= 0 ? 0 : wait < 5 ? 5 : wait < 15 ? 25 : wait < 30 ? 55 : wait < 45 ? 85 : 100
      const age = cycleAgeMin >= 120 ? 100 : cycleAgeMin > 90 ? 75 : cycleAgeMin > 60 ? 55 : cycleAgeMin > 30 ? 25 : 0
      const eqp = equip === 'NONE' ? 100 :
                  (equip === 'VHF-ONLY' && (phase === 'OCEANIC' || phase === 'REMOTE')) ? 65 :
                  (equip === 'HF-ONLY' && hfSsn < 60) ? 35 : 0
      const met = destSigmet ? (cycleAgeMin > 60 ? 90 : 50) : 0

      const sev = { cov, slt, age, eqp, met }
      const drivers: Array<[Driver, number]> = [['COV', cov], ['SLT', slt], ['AGE', age], ['EQP', eqp], ['MET', met]]
      drivers.sort((a, b) => b[1] - a[1])
      const driver: Driver = drivers[0][1] >= 15 ? drivers[0][0] : 'NONE'
      const phaseMul = 1 + ((PHASE_MUL[phase] - 1) * (phaseWt / 100))
      const max = drivers[0][1]
      const secondary = drivers[1][1]
      let score = Math.min(100, Math.max(0, max * phaseMul + 0.10 * secondary))
      if (cov >= 100 && phase === 'OCEANIC') score = Math.max(score, 88)
      if (destSigmet && cycleAgeMin >= 90) score = Math.max(score, 92)
      if (equip === 'NONE' && phase === 'OCEANIC') score = Math.max(score, 85)

      let tier: Tier
      if (fl < minFl) tier = 'IDLE'
      else if (score >= 80) tier = 'WX-LOST'
      else if (score >= 55) tier = 'WX-STALE'
      else if (score >= 25) tier = 'WX-WATCH'
      else tier = 'WX-OK'

      out.push({ f, klass, phase, equip, curFir, destFir, rx, best, cycleAgeMin: Math.min(cycleAgeMin, 999), destSigmet, sev, score, driver, tier })
    }
    return out
  }, [flights, minFl, hfSsn, kIdx, dayFrac, phaseWt, stationSlot, sigmetFirs])

  const tierCount: Record<Tier, number> = { 'WX-LOST': 0, 'WX-STALE': 0, 'WX-WATCH': 0, 'WX-OK': 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++
  const meanAge = rows.length ? rows.reduce((a, r) => a + Math.min(r.cycleAgeMin, 120), 0) / rows.length : 0
  const lostCount = tierCount['WX-LOST']
  const oceanicShare = rows.length ? rows.filter(r => r.phase === 'OCEANIC').length / rows.length : 0
  const noRxCount = rows.filter(r => r.rx.length === 0).length
  const sigDestShare = rows.length ? rows.filter(r => r.destSigmet).length / rows.length : 0
  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (netFilter !== 'ALL') r = r.filter(x => x.best?.s.network === netFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(x => (x.f.callsign || '').toLowerCase().includes(q) || (x.f.type || '').toLowerCase().includes(q) || (x.f.icao || '').toLowerCase().includes(q) || x.curFir.toLowerCase().includes(q) || x.destFir.toLowerCase().includes(q))
    return r.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, netFilter, query])

  const stationRows = useMemo(() => {
    const map = new Map<string, Row[]>()
    for (const r of rows) for (const x of r.rx) { const e = map.get(x.s.id) || []; e.push(r); map.set(x.s.id, e) }
    return STATIONS.map(s => {
      const list = map.get(s.id) || []
      const lost = list.filter(r => r.tier === 'WX-LOST').length
      const meanScore = list.length ? list.reduce((a, r) => a + r.score, 0) / list.length : 0
      const sl = stationSlot.get(s.id)!
      return { s, ac: list.length, lost, meanScore, inSlot: sl.inSlot, minToSlot: sl.minToSlot }
    }).sort((a, b) => (Number(b.inSlot) - Number(a.inSlot)) || b.ac - a.ac)
  }, [rows, stationSlot])

  useEffect(() => {
    if (!map) return
    const ensureSource = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    }
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_LINK, SRC_REF, SRC_STN, SRC_STNL]
    sources.forEach(ensureSource)

    if (!map.getLayer(LYR_REF)) {
      map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.14, 'line-width': 0.8, 'line-dasharray': [2, 4] } })
    }
    if (!map.getLayer(LYR_LINK)) {
      map.addLayer({ id: LYR_LINK, type: 'line', source: SRC_LINK, paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [1.5, 2] } })
    }
    if (!map.getLayer(LYR_HALO)) {
      map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.65, 'circle-stroke-width': 1.4 } })
    }
    if (!map.getLayer(LYR_PIN)) {
      map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': '◆', 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(LYR_STN)) {
      map.addLayer({ id: LYR_STN, type: 'circle', source: SRC_STN, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.85, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.2 } })
    }
    if (!map.getLayer(LYR_STNL)) {
      map.addLayer({ id: LYR_STNL, type: 'symbol', source: SRC_STNL, layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, 1.3], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(LYR_LBL)) {
      map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }

    const halo: any[] = []; const lbl: any[] = []; const pin: any[] = []; const link: any[] = []
    for (const r of rows) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'WX-OK' && r.tier !== 'IDLE') {
        const rad = 8 + (r.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: rad } })
      }
      if (showPin && r.tier === 'WX-LOST') {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLabels && (r.tier === 'WX-LOST' || r.tier === 'WX-STALE')) {
        const label = `${r.f.callsign || r.f.icao} · ${r.curFir}→${r.destFir} · ${r.best?.s.id || 'NO-STN'} ${r.best?.inSlot ? 'IN' : r.best ? `+${r.best.minToSlot.toFixed(0)}m` : ''}`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showLink && r.best && r.tier !== 'WX-OK' && r.tier !== 'IDLE') {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.best.s.lng, r.best.s.lat]] }, properties: { color } })
      }
    }

    const refFeats: any[] = []
    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        refFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }

    const stnFeats: any[] = []; const stnLbl: any[] = []
    if (showStations) {
      for (const s of STATIONS) {
        const sl = stationSlot.get(s.id)!
        const col = sl.inSlot ? NETWORK_COLOR[s.network] : '#64748b'
        const rad = sl.inSlot ? 6.5 : 4
        stnFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { color: col, r: rad } })
        const freq = s.band === 'VHF' ? `${(s.freqs[0]/1000).toFixed(3)}` : `${s.freqs[s.freqs.length-1]}kHz`
        stnLbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { color: col, label: `${s.id}${sl.inSlot ? ' ▶' : ` +${sl.minToSlot.toFixed(0)}m`} · ${freq}` } })
      }
    }

    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: refFeats })
    ;(map.getSource(SRC_STN) as any).setData({ type: 'FeatureCollection', features: stnFeats })
    ;(map.getSource(SRC_STNL) as any).setData({ type: 'FeatureCollection', features: stnLbl })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_REF, LYR_STN, LYR_STNL]) { if (m.getLayer(id)) m.removeLayer(id) }
      for (const id of sources) { if (m.getSource(id)) m.removeSource(id) }
    }
  }, [map, rows, showHalo, showPin, showLabels, showLink, showRef, showStations, stationSlot])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{TIER_LABEL[t]}</span>
  )
  const driverBadge = (d: Driver, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const equipPill = (e: Equip) => {
    const col = e === 'NONE' ? '#ef4444' : e === 'HF+VHF' ? '#10b981' : e === 'VHF-ONLY' ? '#0ea5e9' : '#f59e0b'
    return <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '66', backgroundColor: col + '14' }}>{e}</span>
  }
  const netPill = (n: Network) => {
    const col = NETWORK_COLOR[n]
    return <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '66', backgroundColor: col + '14' }}>{n}</span>
  }

  const advice = (r: Row) => {
    if (r.tier === 'WX-LOST') {
      if (r.rx.length === 0) return `No VOLMET station receivable for FIR ${r.curFir}→${r.destFir} — request ATC met advisory per Doc 4444 §4.3.5, alternate METAR via SATCOM ACARS or HF SELCAL data-link`
      if (r.destSigmet) return `Destination FIR ${r.destFir} has active SIGMET and last VOLMET cycle ${r.cycleAgeMin.toFixed(0)}min stale — request priority met update per ICAO Annex 3 §11.5, reassess fuel & alternate`
      if (r.equip === 'NONE') return 'No VOLMET receiver capability in oceanic phase — coordinate continuous ATC weather relay per NAT Doc 007 Ch 11'
      return `Met-cycle stale ${r.cycleAgeMin.toFixed(0)}min — request VOLMET frequency change or SATVOICE met service`
    }
    if (r.tier === 'WX-STALE') return `Single-station VOLMET coverage or slot wait ${r.best?.minToSlot.toFixed(0)}min — pre-tune ${r.best?.s.id} ${r.best?.s.freqs[0] ?? ''} per Doc 7030 timeshare, brief crew on next slot`
    if (r.tier === 'WX-WATCH') return `VOLMET nominal but trend adverse — log cycle freshness, monitor SIGMET for ${r.destFir} per WMO No. 49 Vol II`
    return `${r.rx.length} VOLMET station(s) in reach · best ${r.best?.s.id} ${r.best?.inSlot ? 'IN-SLOT' : `next +${r.best?.minToSlot.toFixed(0)}m`} · ${r.cycleAgeMin.toFixed(0)}min since cycle per Annex 3 §11.5`
  }

  // SVG slot wheel
  const W = 280, H = 180
  const cx = W / 2, cy = H / 2 + 4, R = Math.min(W, H) / 2 - 18

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">VOLMET · HF/VHF Met Broadcast</div>
          <div className="text-[10px] text-slate-500">12 stations · ICAO Annex 3 §11.5 · Doc 7030 5-min timeshare · NAT Doc 007 Ch 11</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[10px] font-semibold" style={{ color: TIER_COLOR[t] }}>{TIER_LABEL[t]}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean cycle age</div>
          <div className="text-sm font-semibold" style={{ color: meanAge > 60 ? '#ef4444' : meanAge > 30 ? '#f59e0b' : '#10b981' }}>{meanAge.toFixed(0)}m</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst aircraft</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">WX-LOST</div>
          <div className="text-sm font-semibold" style={{ color: lostCount > 0 ? '#ef4444' : '#10b981' }}>{lostCount}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Oceanic share</div>
          <div className="text-xs font-semibold" style={{ color: oceanicShare > 0.30 ? '#f59e0b' : '#10b981' }}>{(oceanicShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">No RX</div>
          <div className="text-xs font-semibold" style={{ color: noRxCount > 0 ? '#ef4444' : '#10b981' }}>{noRxCount}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Dest SIGMET</div>
          <div className="text-xs font-semibold" style={{ color: sigDestShare > 0.20 ? '#f59e0b' : '#0ea5e9' }}>{(sigDestShare * 100).toFixed(0)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            {/* 60-min wheel */}
            <circle cx={cx} cy={cy} r={R} fill="none" stroke="#1e293b" strokeWidth={1} />
            {[0, 15, 30, 45].map(m => {
              const a = (m / 60) * 2 * Math.PI - Math.PI / 2
              const x1 = cx + Math.cos(a) * (R - 4), y1 = cy + Math.sin(a) * (R - 4)
              const x2 = cx + Math.cos(a) * (R + 2), y2 = cy + Math.sin(a) * (R + 2)
              return <g key={m}><line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#64748b" strokeWidth={1} /><text x={cx + Math.cos(a) * (R + 12)} y={cy + Math.sin(a) * (R + 12) + 3} fontSize={8} fill="#64748b" textAnchor="middle">{m === 0 ? 'H' : `+${m}`}</text></g>
            })}
            {/* station arcs */}
            {STATIONS.map((s, i) => {
              const a0 = (s.slotStart / 60) * 2 * Math.PI - Math.PI / 2
              const a1 = ((s.slotStart + s.slotLen) / 60) * 2 * Math.PI - Math.PI / 2
              const rr = R - 6 - (i % 6) * 3
              const x0 = cx + Math.cos(a0) * rr, y0 = cy + Math.sin(a0) * rr
              const x1 = cx + Math.cos(a1) * rr, y1 = cy + Math.sin(a1) * rr
              return <path key={s.id} d={`M ${x0} ${y0} A ${rr} ${rr} 0 0 1 ${x1} ${y1}`} stroke={NETWORK_COLOR[s.network]} strokeWidth={2.5} fill="none" opacity={stationSlot.get(s.id)!.inSlot ? 0.95 : 0.40} />
            })}
            {/* NOW pointer */}
            {(() => {
              const a = (nowM / 60) * 2 * Math.PI - Math.PI / 2
              const x = cx + Math.cos(a) * (R - 2), y = cy + Math.sin(a) * (R - 2)
              return <g><line x1={cx} y1={cy} x2={x} y2={y} stroke="#0ea5e9" strokeWidth={1.4} /><circle cx={cx} cy={cy} r={2} fill="#0ea5e9" /><text x={x + 4} y={y - 2} fontSize={8} fill="#0ea5e9">NOW {nowM.toFixed(0)}'</text></g>
            })()}
            <text x={cx} y={H - 4} fontSize={9} fill="#64748b" textAnchor="middle">VOLMET 60-min slot wheel · in-slot bright · out-of-slot dim</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">HF-SSN {hfSsn}%</span><input type="range" min={0} max={200} value={hfSsn} onChange={e => setHfSsn(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">K-INDEX {kIdx}</span><input type="range" min={0} max={9} value={kIdx} onChange={e => setKIdx(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">DAY-FRAC {dayFrac > 0 ? '+' : ''}{dayFrac}%</span><input type="range" min={-50} max={50} value={dayFrac} onChange={e => setDayFrac(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">SIG-SHARE {sigShare}%</span><input type="range" min={0} max={60} value={sigShare} onChange={e => setSigShare(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">CLOCK {timeShift > 0 ? '+' : ''}{timeShift}m</span><input type="range" min={-30} max={30} value={timeShift} onChange={e => setTimeShift(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col col-span-2"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setNetFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${netFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {(['NAT','EUR','MID','ASIA','PAC'] as Network[]).map(n => (
          <button key={n} onClick={() => setNetFilter(netFilter === n ? 'ALL' : n)} className={`px-2 py-0.5 rounded text-[10px] border ${netFilter===n?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`} style={netFilter===n?{}:{ color: NETWORK_COLOR[n] }}>{n}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo],['PIN', showPin, setShowPin],['LBL', showLabels, setShowLabels],['LINK', showLink, setShowLink],['STN', showStations, setShowStations],['REF', showRef, setShowRef],['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / FIR / type" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'STATIONS', 'SLOTS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab===t?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.klass}</span>
              {equipPill(r.equip)}
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{r.phase}</span>
              <span className="ml-auto">{tierBadge(r.tier)}</span>
            </div>
            <div className="px-2 pb-1 flex flex-wrap items-center gap-1.5 text-[10px]">
              <span className="text-slate-500">FL{(r.f.altitudeFt / 100).toFixed(0)}</span>
              <span className="font-mono text-slate-300">{r.curFir} → {r.destFir}</span>
              {r.destSigmet && <span className="px-1 py-px rounded text-[9px]" style={{ color: '#f59e0b', backgroundColor: '#f59e0b22', border: '1px solid #f59e0b66' }}>SIGMET</span>}
              <span className="text-slate-500">RX {r.rx.length}</span>
              <span className="text-slate-500">AGE {r.cycleAgeMin.toFixed(0)}m</span>
              {r.best && (
                <span className="text-slate-300">{r.best.s.id} {r.best.inSlot ? <span style={{ color: '#10b981' }}>▶IN-SLOT</span> : <span style={{ color: '#f59e0b' }}>+{r.best.minToSlot.toFixed(0)}m</span>} · {r.best.band === 'VHF' ? `${(r.best.s.freqs[0]/1000).toFixed(3)}` : `${r.best.s.freqs[r.best.s.freqs.length-1]}kHz`}</span>
              )}
            </div>
            <div className="px-2 pb-1">
              <div className="relative h-1.5 rounded bg-slate-800 overflow-hidden">
                <div className="absolute inset-y-0 left-0" style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} />
              </div>
            </div>
            <div className="px-2 pb-1 flex flex-wrap gap-1">
              {(['COV','SLT','AGE','EQP','MET'] as Driver[]).map(d => driverBadge(d, (r.sev as any)[d.toLowerCase()] ?? 0))}
            </div>
            <div className="px-2 pb-2 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>{advice(r)}</div>
          </div>
        ))}
        {tab === 'STATIONS' && stationRows.map(({ s, ac, lost, meanScore, inSlot, minToSlot }) => (
          <div key={s.id} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${NETWORK_COLOR[s.network]}` }}>
              <span className="font-mono font-semibold text-slate-100">{s.id}</span>
              <span className="text-slate-400 text-[10px]">{s.name}</span>
              {netPill(s.network)}
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{s.band}</span>
              {inSlot ? <span className="px-1 py-px rounded text-[9px]" style={{ color: '#10b981', backgroundColor: '#10b98122', border: '1px solid #10b98166' }}>IN-SLOT</span>
                       : <span className="px-1 py-px rounded text-[9px]" style={{ color: '#f59e0b', backgroundColor: '#f59e0b22', border: '1px solid #f59e0b66' }}>+{minToSlot.toFixed(0)}m</span>}
              <span className="ml-auto text-slate-500 text-[10px]">{ac} ac · {lost} lost</span>
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-500 font-mono">
              {s.band === 'VHF' ? s.freqs.map(f => (f/1000).toFixed(3)).join(' / ') + ' MHz' : s.freqs.join(' / ') + ' kHz'} · slot H+{s.slotStart}..H+{s.slotStart + s.slotLen} · FIR {s.firs.join(' ')}
            </div>
            <div className="px-2 pb-1">
              <div className="relative h-1.5 rounded bg-slate-800 overflow-hidden">
                <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, meanScore)}%`, backgroundColor: meanScore >= 80 ? '#ef4444' : meanScore >= 55 ? '#f59e0b' : meanScore >= 25 ? '#0ea5e9' : '#10b981' }} />
              </div>
            </div>
          </div>
        ))}
        {tab === 'SLOTS' && (
          <div className="space-y-1">
            {STATIONS.slice().sort((a, b) => a.slotStart - b.slotStart).map(s => {
              const sl = stationSlot.get(s.id)!
              return (
                <div key={s.id} className="rounded border border-slate-800 bg-slate-950/60 p-2">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono font-semibold text-slate-100 w-20">{s.id}</span>
                    {netPill(s.network)}
                    <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{s.band}</span>
                    <span className="text-slate-500 text-[10px]">H+{s.slotStart}..+{s.slotStart + s.slotLen}</span>
                    <span className="ml-auto">{sl.inSlot ? <span className="text-emerald-400">▶ IN-SLOT</span> : <span className="text-amber-400">next in {sl.minToSlot.toFixed(0)}m</span>}</span>
                  </div>
                  <div className="relative h-2 mt-1 rounded bg-slate-900 overflow-hidden">
                    {/* 60-min strip */}
                    <div className="absolute inset-y-0" style={{ left: `${(s.slotStart / 60) * 100}%`, width: `${(s.slotLen / 60) * 100}%`, backgroundColor: NETWORK_COLOR[s.network], opacity: sl.inSlot ? 0.95 : 0.45 }} />
                    {/* NOW marker */}
                    <div className="absolute inset-y-0" style={{ left: `${(nowM / 60) * 100}%`, width: 1.5, backgroundColor: '#0ea5e9' }} />
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1 font-mono">FIR {s.firs.join(' ')} · {s.band === 'VHF' ? s.freqs.map(f => (f/1000).toFixed(3)).join('/') + ' MHz' : s.freqs.join('/') + ' kHz'}</div>
                </div>
              )
            })}
          </div>
        )}
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="text-center text-slate-500 py-4">No aircraft match current filters</div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-500 leading-relaxed">
        VOLMET timeshare per ICAO Doc 7030 SUPPS. Slot start/length are nominal 5-min serials. Cycle age = minutes since most-recent receivable slot END. Frequencies HF kHz / VHF MHz per ICAO Doc 9377 App 1. Refs Annex 3 §11.5 / Annex 10 Vol II §5.2 / Vol III Pt II Ch 2 / Doc 4444 §4.3.5 / Doc 8896 ch 9 / WMO No. 49 Vol II / NAT Doc 007 Ch 11 / EUR Doc 014.
      </div>
    </div>
  )
}
