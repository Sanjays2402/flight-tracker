'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   SELCAL / ARINC 596 Code-Pair Conflict &
   HF Voice-Watch Coverage Monitor
   -----------------------------------------------------------
   Per-airframe Selective Calling (SELCAL) tone-pair assignment
   tracker, code-pair collision detector across the 10,920
   ARINC 596 codes, family-A vs family-B tone-pair planning,
   in-range HF voice-watch ground-station coverage on the
   primary / secondary / tertiary oceanic family frequencies,
   SELCAL-check (pre-departure tone-test) overdue tracking,
   and PBCS Tier-2/3 HF voice fallback compliance per NAT
   OPS Bulletin 2017-002 / Doc 7030 NAT SUPPS §1.5.

   Regulatory & operational basis:
     · ARINC Characteristic 596 — SELCAL System
     · ARINC 714 — Mark 3 SELCAL Decoder
     · ARINC 719 — HF Communications System
     · ICAO Annex 10 Vol II §5.2.2 SELCAL
     · ICAO Annex 10 Vol III Pt II ch 2 HF voice
     · ICAO Doc 4444 PANS-ATM 4.13 / 8.3.4 SELCAL check
     · ICAO Doc 7030 NAT SUPPS §1.5 / EUR SUPPS
     · ICAO Doc 10037 GOLD §6.4 SELCAL check
     · NAT Doc 007 Ch 8 / NAT OPS Bulletin 2017-002
     · NAT OPS Bulletin 2015-001 PBCS HF voice fallback
     · FAA AC 91-70B Ch 5 Oceanic / Order JO 7110.65 §8
     · EUROCAE ED-23C / ED-137 HF voice
     · ITU-R Radio Regs Appendix 27 Aeronautical (R) HF
       Mobile family allocations 2850-22000 kHz
     · UK CAA CAP 452 HF SELCAL allocation
     · ASRI (Aviation Spectrum Resources Inc) SELCAL
       Registration Authority — manages 10,920 codes
     · Stockholm Radio / Shanwick Radio / Gander Radio /
       New York Radio / San Francisco Radio / Honolulu
       Radio / Tahiti Radio / Auckland Radio / Brisbane
       Radio / Bahrain Radio / Mumbai Radio / Kuala
       Lumpur Radio / Cape Town Radio / Sao Paulo Radio
       — ICAO MWARA HF networks
     · NTSB AAR-83/03 KAL007 SELCAL silent
     · AAIB Bull 4/2010 G-VAST SELCAL decoder fail

   SELCAL code structure:
     · 4-character code AB-CD using 16 letters
       A B C D E F G H J K L M P Q R S
     · 12 tones per ARINC 596 Table 1 (312.6 - 1479.1 Hz)
     · Tone pairs must be ordered (A < B and C < D)
     · Total possible = C(16,2) x C(16,2) but with the
       no-same-tone rule yields 10,920 unique codes
     · Family-A tones: A B C D E F G H
     · Family-B tones: J K L M P Q R S
     · Code uniqueness managed by ASRI registry
       (collision = two airframes in same oceanic
       region squawking same code → silent NORDO)

   12-station MWARA HF ground catalogue (lat/lng/freq):
     Shanwick EGGX / Gander CZQX / New York KZWY /
     Reykjavik BIRD / Stockholm ESOS / Bahrain OBBI /
     Mumbai VABF / San Francisco KZAK / Honolulu PHZH /
     Auckland NZZO / Brisbane YBBB / Tahiti NTTT /
     Cape Town FACT / Sao Paulo SBAO

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash of ICAO24
        synthesises stable SELCAL code (4-char from
        16-letter alphabet, ordered pairs), HF radio
        equipage (DUAL-HF / SINGLE-HF / NO-HF), last
        SELCAL-check timestamp (hours-ago), family
        preference (A or B).
     2. Code-pair conflict: bucket airframes by SELCAL
        code in current oceanic region (great-circle
        within 500 nm). >=2 in same bucket → CONFLICT.
     3. Coverage: per-aircraft groundwave reach
        1.23(sqrt(h_ft) + sqrt(h_st)) plus skywave
        2-hop budget 350-4200 nm gated by HF-SSN
        sunspot slider / K-index geomagnetic / day-night
        D-layer absorption. Compute receivable MWARA
        stations on primary family freq.
     4. SELCAL-check overdue: per Doc 10037 §6.4 a
        SELCAL check is required pre-departure or on
        radio change. Hours since last check > CHECK-MAX
        slider → overdue.
     5. 5 risk drivers max-driver composite:
        · CFL  code-pair collision in region (100 if 2+)
        · COV  zero in-range MWARA stations
        · CHK  SELCAL check overdue hours
        · EQP  HF equipage (SINGLE-HF / NO-HF)
        · PBC  PBCS HF voice fallback unavailable
     6. Phase-weighted score = max-driver * phase-mul
        + 0.10 * secondary. Hard escalation: code
        collision in oceanic → ≥85 (KAL007 tier).

   Output:
     · 5 tiers SILENT / DEGRADED / WATCH / SELCAL-OK / IDLE
     · MapLibre overlay: tier halos, KAL007 pin on
       collisions, 14 MWARA station pins coloured by
       network, dashed coverage rings per station,
       dashed great-circle aircraft-to-best-station
       link for non-OK, sky reference parallels
     · Side panel: tier counter, 6-cell summary,
       6 sliders, 3-family chip filter, AIRCRAFT /
       STATIONS / CODES tabs, click-to-fly rows
     · Per-aircraft row: SELCAL code pill, family
       pill, HF-equip pill, station-count, check-age,
       advice link

   Layers > Safety & Traffic.
   Persisted: ft-selcal
   ============================================================ */

interface SelFlight {
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
  flights: SelFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'SILENT' | 'DEGRADED' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  SILENT: '#ef4444', DEGRADED: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_LABEL: Record<Tier, string> = {
  SILENT: 'SILENT', DEGRADED: 'DEGRADED', WATCH: 'WATCH', OK: 'SELCAL-OK', IDLE: 'IDLE',
}
const TIER_ORDER: Tier[] = ['SILENT', 'DEGRADED', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { SILENT: 0, DEGRADED: 1, WATCH: 2, OK: 3, IDLE: 4 }

type HfEquip = 'DUAL-HF' | 'SINGLE-HF' | 'NO-HF'
type Family = 'A' | 'B' | 'MIX'
type Phase = 'OCEANIC' | 'REMOTE' | 'ENROUTE' | 'TERMINAL'
const PHASE_MUL: Record<Phase, number> = { OCEANIC: 1.35, REMOTE: 1.20, ENROUTE: 1.00, TERMINAL: 0.80 }

// ARINC 596 16-letter alphabet (omits I N O T U V W X Y Z)
const SELCAL_LETTERS = ['A','B','C','D','E','F','G','H','J','K','L','M','P','Q','R','S']
const FAMILY_A_LETTERS = new Set(['A','B','C','D','E','F','G','H'])

type Driver = 'CFL' | 'COV' | 'CHK' | 'EQP' | 'PBC' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  CFL: 'Code-pair collision', COV: 'MWARA coverage', CHK: 'SELCAL check overdue',
  EQP: 'HF equipage', PBC: 'PBCS HF voice fallback', NONE: 'Nominal',
}

interface MwaraStation {
  id: string         // 3-letter callsign
  name: string
  lat: number
  lng: number
  network: 'NAT' | 'NCA' | 'CAR' | 'CWP' | 'SP' | 'SAT' | 'AFI' | 'EUR'
  primaryKhz: number // primary family freq (varies day/night)
}

const STATIONS: MwaraStation[] = [
  { id: 'SHA', name: 'Shanwick Radio',     lat: 53.30, lng:  -9.05, network: 'NAT', primaryKhz: 8864 },
  { id: 'GAN', name: 'Gander Radio',       lat: 48.95, lng: -54.57, network: 'NAT', primaryKhz: 8864 },
  { id: 'NYC', name: 'New York Radio',     lat: 40.78, lng: -73.10, network: 'NAT', primaryKhz: 8864 },
  { id: 'REK', name: 'Reykjavik Radio',    lat: 64.13, lng: -21.94, network: 'NAT', primaryKhz: 8891 },
  { id: 'STO', name: 'Stockholm Radio',    lat: 59.65, lng:  17.92, network: 'EUR', primaryKhz: 5541 },
  { id: 'BAH', name: 'Bahrain Radio',      lat: 26.27, lng:  50.63, network: 'AFI', primaryKhz: 8918 },
  { id: 'BOM', name: 'Mumbai Radio',       lat: 19.09, lng:  72.86, network: 'SAT', primaryKhz: 8879 },
  { id: 'SFO', name: 'San Francisco Radio',lat: 37.62, lng:-122.38, network: 'CWP', primaryKhz: 8843 },
  { id: 'HNL', name: 'Honolulu Radio',     lat: 21.32, lng:-157.92, network: 'CWP', primaryKhz: 8843 },
  { id: 'AKL', name: 'Auckland Radio',     lat:-37.01, lng: 174.79, network: 'SP',  primaryKhz: 8867 },
  { id: 'BNE', name: 'Brisbane Radio',     lat:-27.38, lng: 153.12, network: 'SP',  primaryKhz: 8867 },
  { id: 'PPT', name: 'Tahiti Radio',       lat:-17.55, lng:-149.61, network: 'SP',  primaryKhz: 8867 },
  { id: 'CPT', name: 'Cape Town Radio',    lat:-33.97, lng:  18.60, network: 'AFI', primaryKhz: 8861 },
  { id: 'SAO', name: 'Sao Paulo Radio',    lat:-23.43, lng: -46.48, network: 'SAT', primaryKhz: 8855 },
]

const NETWORK_COLOR: Record<MwaraStation['network'], string> = {
  NAT: '#0ea5e9', NCA: '#3b82f6', CAR: '#8b5cf6', CWP: '#06b6d4',
  SP: '#14b8a6', SAT: '#a78bfa', AFI: '#f59e0b', EUR: '#10b981',
}

function classifyPhase(lat: number, lng: number, alt: number): Phase {
  const absLat = Math.abs(lat)
  const oceanic =
    (absLat > 30 && absLat < 65 && lng > -55 && lng < -10 && lat > 35) ||
    (lat > 20 && lat < 55 && lng > 150) || (lat > 20 && lat < 55 && lng < -130) ||
    (lat < 5 && lat > -25 && lng > -35 && lng < 0) ||
    (lat < -10 && lng > 80 && lng < 130) ||
    (lat < 5 && lat > -40 && lng > 50 && lng < 100)
  const remote = absLat > 70 || (lng > 60 && lng < 120 && lat > 40 && lat < 70)
  if (oceanic && alt > 25000) return 'OCEANIC'
  if (remote && alt > 25000) return 'REMOTE'
  if (alt > 10000) return 'ENROUTE'
  return 'TERMINAL'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

// Pick an ordered pair from 16 letters using a hash bucket
function pickPair(h: number, family: 'A' | 'B' | null): [string, string] {
  let pool = SELCAL_LETTERS
  if (family === 'A') pool = SELCAL_LETTERS.filter(l => FAMILY_A_LETTERS.has(l))
  else if (family === 'B') pool = SELCAL_LETTERS.filter(l => !FAMILY_A_LETTERS.has(l))
  const n = pool.length
  const total = n * (n - 1) / 2
  let idx = h % total
  for (let i = 0; i < n - 1; i++) {
    const room = n - 1 - i
    if (idx < room) return [pool[i], pool[i + 1 + idx]]
    idx -= room
  }
  return [pool[0], pool[1]]
}

function genSelcal(icao: string): { code: string; family: Family } {
  const h1 = hash32(icao + ':p1')
  const h2 = hash32(icao + ':p2')
  const famPick = (h1 >>> 28) & 3
  const fam1: 'A' | 'B' | null = famPick === 0 ? 'A' : famPick === 1 ? 'B' : null
  const fam2: 'A' | 'B' | null = ((h2 >>> 28) & 3) === 0 ? 'A' : ((h2 >>> 28) & 3) === 1 ? 'B' : null
  const [a, b] = pickPair(h1, fam1)
  const [c, d] = pickPair(h2, fam2)
  const fa1 = FAMILY_A_LETTERS.has(a) && FAMILY_A_LETTERS.has(b)
  const fa2 = FAMILY_A_LETTERS.has(c) && FAMILY_A_LETTERS.has(d)
  const fb1 = !FAMILY_A_LETTERS.has(a) && !FAMILY_A_LETTERS.has(b)
  const fb2 = !FAMILY_A_LETTERS.has(c) && !FAMILY_A_LETTERS.has(d)
  const family: Family = (fa1 && fa2) ? 'A' : (fb1 && fb2) ? 'B' : 'MIX'
  return { code: `${a}${b}-${c}${d}`, family }
}

function hfEquip(klass: AcClass, h: number): HfEquip {
  const r = (h & 0xffff) / 0xffff
  if (klass === 'HVY' || klass === 'HVY-Q') return r < 0.92 ? 'DUAL-HF' : 'SINGLE-HF'
  if (klass === 'NRW') return r < 0.55 ? 'DUAL-HF' : r < 0.85 ? 'SINGLE-HF' : 'NO-HF'
  if (klass === 'RGN') return r < 0.20 ? 'SINGLE-HF' : 'NO-HF'
  if (klass === 'BIZ') return r < 0.70 ? 'DUAL-HF' : r < 0.92 ? 'SINGLE-HF' : 'NO-HF'
  return r < 0.15 ? 'SINGLE-HF' : 'NO-HF'
}

type AcClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const CLASS_LIST: AcClass[] = ['HVY-Q', 'HVY', 'NRW', 'RGN', 'BIZ', 'TBP']
function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|A38|A34|IL96/.test(t)) return 'HVY-Q'
  if (/B77|B78|A33|A35|MD11/.test(t)) return 'HVY'
  if (/B73|A31|A319|A32|A22|B75|MD8|B71/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E27|E29|E[12]7|E[12]9|F70|F100|AT[47]|DH[48]/.test(t)) return 'RGN'
  if (/G[VI458]|GLF|GLEX|FA[78]X|F2TH|CL30|CL60|C68|C75|BE40|H25|LJ/.test(t)) return 'BIZ'
  return 'TBP'
}

// Great-circle distance in nm
function gcDist(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065 // nm
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// HF reach estimate: groundwave (~250 nm) + 2-hop skywave gated by SSN / K-index / day-frac
function hfReach(altFt: number, ssn: number, kIdx: number, dayFrac: number, depleteMul: number): { gw: number; sw: number } {
  const gw = 1.23 * (Math.sqrt(Math.max(0, altFt)) + Math.sqrt(50)) // station 50 ft AGL
  // Skywave: 350-4200 nm window, SSN 0..200% boosts skywave hop count, K-index degrades, day frac >0 = day (D-layer absorption)
  const ssnBoost = 0.4 + 0.012 * ssn      // 0..200%
  const kPenalty = Math.max(0, 1 - kIdx * 0.10)
  const dayPenalty = dayFrac > 0 ? (1 - dayFrac * 0.40) : 1
  const swBase = 3200
  const sw = Math.max(0, swBase * ssnBoost * kPenalty * dayPenalty * depleteMul)
  return { gw: gw + 100, sw }
}

interface Row {
  f: SelFlight
  klass: AcClass
  phase: Phase
  isOceanic: boolean
  selcal: string
  family: Family
  equip: HfEquip
  checkAgeHr: number
  rxStations: MwaraStation[]
  bestStation: MwaraStation | null
  collisionCount: number
  sev: { cfl: number; cov: number; chk: number; eqp: number; pbc: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'sel-halo', SRC_LBL = 'sel-lbl', SRC_PIN = 'sel-pin', SRC_LINK = 'sel-link', SRC_REF = 'sel-ref', SRC_STN = 'sel-stn', SRC_STNL = 'sel-stnl'
const LYR_HALO = 'sel-halo-l', LYR_LBL = 'sel-lbl-l', LYR_PIN = 'sel-pin-l', LYR_LINK = 'sel-link-l', LYR_REF = 'sel-ref-l', LYR_STN = 'sel-stn-l', LYR_STNL = 'sel-stnl-l'

export default function SelcalMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'STATIONS' | 'CODES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [familyFilter, setFamilyFilter] = useState<Family | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(180)
  const [hfSsn, setHfSsn] = useState(100)        // sunspot 0..200%
  const [kIdx, setKIdx] = useState(2)            // 0..9 geomagnetic
  const [dayFrac, setDayFrac] = useState(0)      // -50..+50 pct day shift
  const [checkMax, setCheckMax] = useState(18)   // hours since SELCAL check
  const [collisionRadius, setCollisionRadius] = useState(500) // nm
  const [phaseWt, setPhaseWt] = useState(100)
  const [providerDeplete, setProviderDeplete] = useState(0) // 0-30% station outage
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showStations, setShowStations] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  // Per-station outage hash-stable
  const stationOutage = useMemo(() => {
    const out = new Set<string>()
    if (providerDeplete <= 0) return out
    for (const s of STATIONS) {
      const h = hash32(s.id) / 0xffffffff
      if (h * 100 < providerDeplete) out.add(s.id)
    }
    return out
  }, [providerDeplete])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    // Pass 1: compute per-flight base state including SELCAL code
    const partial: Array<Omit<Row, 'collisionCount' | 'sev' | 'score' | 'driver' | 'tier'>> = []
    for (const f of flights) {
      if (!isFinite(f.altitudeFt)) continue
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl) continue
      const phase = classifyPhase(f.lat, f.lng, f.altitudeFt)
      const klass = classifyClass(f.type || '')
      const h = hash32(f.icao || '')
      const sel = genSelcal(f.icao || '')
      const equip = hfEquip(klass, h)
      const checkAgeHr = ((h >>> 8) & 0xff) / 255 * 36 // 0..36 hours since last check
      const reach = hfReach(f.altitudeFt, hfSsn, kIdx, dayFrac / 100, 1 - providerDeplete / 200)
      const rxStations: MwaraStation[] = []
      for (const s of STATIONS) {
        if (stationOutage.has(s.id)) continue
        const d = gcDist(f.lat, f.lng, s.lat, s.lng)
        if (d <= reach.gw || (d >= 350 && d <= reach.sw)) rxStations.push(s)
      }
      let bestStation: MwaraStation | null = null
      let bestD = Infinity
      for (const s of rxStations) {
        const d = gcDist(f.lat, f.lng, s.lat, s.lng)
        if (d < bestD) { bestD = d; bestStation = s }
      }
      partial.push({
        f, klass, phase, isOceanic: phase === 'OCEANIC' || phase === 'REMOTE',
        selcal: sel.code, family: sel.family, equip, checkAgeHr,
        rxStations, bestStation,
      })
    }

    // Pass 2: code-pair collision detection — cluster by oceanic-region proximity
    const collisionMap = new Map<string, number>() // key = icao
    for (let i = 0; i < partial.length; i++) {
      const a = partial[i]
      if (!a.isOceanic) continue
      let count = 0
      for (let j = 0; j < partial.length; j++) {
        if (i === j) continue
        const b = partial[j]
        if (b.selcal !== a.selcal) continue
        const d = gcDist(a.f.lat, a.f.lng, b.f.lat, b.f.lng)
        if (d <= collisionRadius) count++
      }
      collisionMap.set(a.f.icao, count)
    }

    // Pass 3: severities + tier
    for (const p of partial) {
      const collisionCount = collisionMap.get(p.f.icao) || 0
      const cfl = p.isOceanic && collisionCount > 0 ? Math.min(100, 70 + collisionCount * 15) : 0
      const cov = p.rxStations.length === 0 ? 95 :
                  p.rxStations.length === 1 ? 55 :
                  p.rxStations.length === 2 ? 25 : 0
      const chk = p.checkAgeHr > checkMax * 2 ? 90 :
                  p.checkAgeHr > checkMax ? 55 :
                  p.checkAgeHr > checkMax * 0.75 ? 25 : 0
      const eqp = p.equip === 'NO-HF' ? (p.isOceanic ? 100 : 30) :
                  p.equip === 'SINGLE-HF' ? (p.isOceanic ? 45 : 10) : 0
      // PBCS HF voice fallback unavailable: oceanic + (no station OR no HF)
      const pbc = (p.phase === 'OCEANIC' && (p.rxStations.length === 0 || p.equip === 'NO-HF')) ? 92 : 0
      const sev = { cfl, cov, chk, eqp, pbc }
      const drivers: Array<[Driver, number]> = [['CFL', cfl], ['COV', cov], ['CHK', chk], ['EQP', eqp], ['PBC', pbc]]
      drivers.sort((a, b) => b[1] - a[1])
      const driver: Driver = drivers[0][1] >= 15 ? drivers[0][0] : 'NONE'
      const phaseMul = 1 + ((PHASE_MUL[p.phase] - 1) * (phaseWt / 100))
      const max = drivers[0][1]
      const secondary = drivers[1][1]
      let score = Math.min(100, Math.max(0, max * phaseMul + 0.10 * secondary))
      if (p.isOceanic && collisionCount > 0) score = Math.max(score, 85)
      if (p.phase === 'OCEANIC' && p.equip === 'NO-HF') score = Math.max(score, 90)

      let tier: Tier
      if (p.f.altitudeFt / 100 < minFl) tier = 'IDLE'
      else if (score >= 80) tier = 'SILENT'
      else if (score >= 55) tier = 'DEGRADED'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({ ...p, collisionCount, sev, score, driver, tier })
    }
    return out
  }, [flights, minFl, hfSsn, kIdx, dayFrac, checkMax, collisionRadius, phaseWt, stationOutage, providerDeplete])

  const tierCount: Record<Tier, number> = { SILENT: 0, DEGRADED: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++

  const collisionTotal = rows.reduce((a, r) => a + (r.collisionCount > 0 ? 1 : 0), 0)
  const oceanicShare = rows.length ? rows.filter(r => r.isOceanic).length / rows.length : 0
  const meanRx = rows.length ? rows.reduce((a, r) => a + r.rxStations.length, 0) / rows.length : 0
  const overdueCount = rows.filter(r => r.checkAgeHr > checkMax).length
  const noHfShare = rows.length ? rows.filter(r => r.equip === 'NO-HF').length / rows.length : 0
  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (familyFilter !== 'ALL') r = r.filter(x => x.family === familyFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(x => (x.f.callsign || '').toLowerCase().includes(q) || (x.f.type || '').toLowerCase().includes(q) || (x.f.icao || '').toLowerCase().includes(q) || (x.f.operator || '').toLowerCase().includes(q) || x.selcal.toLowerCase().includes(q))
    return r.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, familyFilter, query])

  const stationRows = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of rows) {
      for (const s of r.rxStations) {
        const e = m.get(s.id) || []; e.push(r); m.set(s.id, e)
      }
    }
    return STATIONS.map(s => {
      const list = m.get(s.id) || []
      const silent = list.filter(r => r.tier === 'SILENT').length
      const meanScore = list.length ? list.reduce((a, r) => a + r.score, 0) / list.length : 0
      const worstTier = list.length ? list.reduce((a, r) => TIER_RANK[r.tier] < TIER_RANK[a] ? r.tier : a, 'IDLE' as Tier) : 'IDLE' as Tier
      return { s, ac: list.length, silent, meanScore, worstTier, outage: stationOutage.has(s.id) }
    }).sort((a, b) => (a.outage === b.outage ? b.ac - a.ac : a.outage ? -1 : 1))
  }, [rows, stationOutage])

  const codeRows = useMemo(() => {
    // Group by SELCAL code, highlight collisions
    const m = new Map<string, Row[]>()
    for (const r of rows) { const e = m.get(r.selcal) || []; e.push(r); m.set(r.selcal, e) }
    const arr: Array<{ code: string; family: Family; ac: number; oceanic: number; collision: boolean; worstTier: Tier; cs: string[] }> = []
    for (const [code, list] of m) {
      const oceanic = list.filter(r => r.isOceanic).length
      const collision = oceanic >= 2 || list.some(r => r.collisionCount > 0)
      const wt = list.reduce((a, r) => TIER_RANK[r.tier] < TIER_RANK[a] ? r.tier : a, 'IDLE' as Tier)
      arr.push({ code, family: list[0].family, ac: list.length, oceanic, collision, worstTier: wt, cs: list.map(r => r.f.callsign || r.f.icao).slice(0, 6) })
    }
    arr.sort((a, b) => (Number(b.collision) - Number(a.collision)) || b.ac - a.ac)
    return arr
  }, [rows])

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
      map.addLayer({ id: LYR_STN, type: 'circle', source: SRC_STN, paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-opacity': 0.85, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.2 } })
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
      if (showHalo && r.tier !== 'OK' && r.tier !== 'IDLE') {
        const rad = 8 + (r.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: rad } })
      }
      if (showPin && r.tier === 'SILENT') {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLabels && (r.tier === 'SILENT' || r.tier === 'DEGRADED')) {
        const label = `${r.f.callsign || r.f.icao} · ${r.selcal} · ${r.bestStation?.id || 'NO-STN'} · RX${r.rxStations.length}`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showLink && r.bestStation && r.tier !== 'OK' && r.tier !== 'IDLE') {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.bestStation.lng, r.bestStation.lat]] }, properties: { color } })
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
        const outage = stationOutage.has(s.id)
        const col = outage ? '#ef4444' : NETWORK_COLOR[s.network]
        stnFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { color: col } })
        stnLbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { color: col, label: `${s.id}${outage ? ' OUT' : ''} · ${s.primaryKhz}kHz` } })
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
  }, [map, rows, showHalo, showPin, showLabels, showLink, showRef, showStations, stationOutage])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{TIER_LABEL[t]}</span>
  )
  const driverBadge = (d: Driver, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const famPill = (f: Family) => {
    const col = f === 'A' ? '#0ea5e9' : f === 'B' ? '#a78bfa' : '#f59e0b'
    return <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '66', backgroundColor: col + '14' }}>FAM-{f}</span>
  }
  const equipPill = (e: HfEquip) => {
    const col = e === 'NO-HF' ? '#ef4444' : e === 'SINGLE-HF' ? '#f59e0b' : '#10b981'
    return <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '66', backgroundColor: col + '14' }}>{e}</span>
  }

  const advice = (r: Row) => {
    if (r.tier === 'SILENT') {
      if (r.collisionCount > 0) return `SELCAL code collision in oceanic region (${r.collisionCount + 1} airframes on ${r.selcal} within ${collisionRadius}nm) — request new code from ASRI registry / fall back to position-report HF voice per NAT Doc 007 §8.5`
      if (r.equip === 'NO-HF') return 'NO-HF equipage in oceanic phase — PBCS Tier-2/3 voice fallback unavailable per NAT OPS 2017-002 · revert SATVOICE or divert to non-oceanic routing'
      if (r.rxStations.length === 0) return 'Zero MWARA stations in HF reach — try secondary family freq, request frequency change per Doc 4444 §8.3.4'
      return 'SELCAL/HF voice watch lost — squawk 7600 if also CPDLC-lost, file deviation per NAT OPS Bulletin 2020-002'
    }
    if (r.tier === 'DEGRADED') return 'Single-station HF watch or SELCAL check overdue beyond 18h — pre-tune secondary freq, request SELCAL check on next contact per Doc 10037 GOLD §6.4'
    if (r.tier === 'WATCH') return 'SELCAL/HF nominal but trend adverse — log link quality, monitor K-index per NAT Doc 007 ch 8'
    return `SELCAL ${r.selcal} active · ${r.rxStations.length} MWARA stations in reach · check within ${checkMax}h per ARINC 596`
  }

  const W = 280, H = 180
  const xMax = 6
  const yMax = 36
  const sx = (v: number) => 30 + (Math.min(xMax, Math.max(0, v)) / xMax) * (W - 40)
  const sy = (v: number) => H - 24 - (Math.min(yMax, Math.max(0, v)) / yMax) * (H - 48)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">SELCAL · ARINC 596 / HF Voice-Watch</div>
          <div className="text-[10px] text-slate-500">10,920 codes · 14 MWARA stations · Doc 7030 NAT SUPPS · NAT OPS 2017-002</div>
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
          <div className="text-[9px] text-slate-500 uppercase">Mean RX stations</div>
          <div className="text-sm font-semibold" style={{ color: meanRx < 1 ? '#ef4444' : meanRx < 2 ? '#f59e0b' : '#10b981' }}>{meanRx.toFixed(1)}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst aircraft</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Collisions</div>
          <div className="text-sm font-semibold" style={{ color: collisionTotal > 0 ? '#ef4444' : '#10b981' }}>{collisionTotal}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Oceanic share</div>
          <div className="text-xs font-semibold" style={{ color: oceanicShare > 0.30 ? '#f59e0b' : '#10b981' }}>{(oceanicShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Check overdue</div>
          <div className="text-xs font-semibold" style={{ color: overdueCount > 0 ? '#f59e0b' : '#10b981' }}>{overdueCount}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">NO-HF share</div>
          <div className="text-xs font-semibold" style={{ color: noHfShare > 0.40 ? '#ef4444' : noHfShare > 0.20 ? '#f59e0b' : '#10b981' }}>{(noHfShare * 100).toFixed(0)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W-40} height={H-48} fill="#0b1220" />
            {/* RX-station bands */}
            <rect x={sx(0)} y={24} width={sx(1) - sx(0)} height={H - 48} fill="#ef4444" opacity={0.10} />
            <rect x={sx(1)} y={24} width={sx(2) - sx(1)} height={H - 48} fill="#f59e0b" opacity={0.08} />
            <rect x={sx(2)} y={24} width={sx(3) - sx(2)} height={H - 48} fill="#0ea5e9" opacity={0.06} />
            {/* check-max threshold horizontal */}
            <line x1={sx(0)} y1={sy(checkMax)} x2={sx(xMax)} y2={sy(checkMax)} stroke="#f59e0b" strokeDasharray="3 3" strokeOpacity={0.55} />
            <text x={W - 8} y={sy(checkMax) - 3} fontSize={8} fill="#f59e0b" textAnchor="end">CHK {checkMax}h</text>
            <line x1={sx(3)} y1={24} x2={sx(3)} y2={H - 24} stroke="#10b981" strokeDasharray="3 3" strokeOpacity={0.50} />
            <text x={sx(3) + 4} y={36} fontSize={8} fill="#10b981">RX≥3 OK</text>
            {rows.map((r, i) => (
              <circle key={i} cx={sx(r.rxStations.length)} cy={sy(r.checkAgeHr)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
            <text x={W/2} y={H-6} fontSize={9} fill="#64748b" textAnchor="middle">RX-stations vs SELCAL-check age (h)</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">HF-SSN {hfSsn}%</span><input type="range" min={0} max={200} value={hfSsn} onChange={e => setHfSsn(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">K-INDEX {kIdx}</span><input type="range" min={0} max={9} value={kIdx} onChange={e => setKIdx(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">DAY-FRAC {dayFrac > 0 ? '+' : ''}{dayFrac}%</span><input type="range" min={-50} max={50} value={dayFrac} onChange={e => setDayFrac(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">CHK-MAX {checkMax}h</span><input type="range" min={4} max={36} value={checkMax} onChange={e => setCheckMax(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">COL-RAD {collisionRadius}nm</span><input type="range" min={100} max={1500} step={50} value={collisionRadius} onChange={e => setCollisionRadius(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PROV-OUT {providerDeplete}%</span><input type="range" min={0} max={30} value={providerDeplete} onChange={e => setProviderDeplete(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setFamilyFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${familyFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {(['A','B','MIX'] as Family[]).map(f => (
          <button key={f} onClick={() => setFamilyFilter(familyFilter === f ? 'ALL' : f)} className={`px-2 py-0.5 rounded text-[10px] border ${familyFilter===f?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>FAM-{f}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo],['PIN', showPin, setShowPin],['LBL', showLabels, setShowLabels],['LINK', showLink, setShowLink],['STN', showStations, setShowStations],['REF', showRef, setShowRef],['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / code / type" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'STATIONS', 'CODES'] as const).map(t => (
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
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-100 font-mono">{r.selcal}</span>
              {famPill(r.family)}
              {equipPill(r.equip)}
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{r.phase}</span>
              {r.collisionCount > 0 && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/40">COL×{r.collisionCount+1}</span>}
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              FL{(r.f.altitudeFt/100).toFixed(0)} · RX <span style={{color: r.rxStations.length===0?'#ef4444':r.rxStations.length<3?'#f59e0b':'#10b981'}}>{r.rxStations.length}</span> stations {r.rxStations.slice(0,4).map(s => s.id).join('/') || '—'} · best <span className="text-slate-200">{r.bestStation?.id || '—'}</span>{r.bestStation && ` ${r.bestStation.primaryKhz}kHz`} · CHK <span style={{color: r.checkAgeHr>checkMax*2?'#ef4444':r.checkAgeHr>checkMax?'#f59e0b':r.checkAgeHr>checkMax*0.75?'#0ea5e9':'#10b981'}}>{r.checkAgeHr.toFixed(1)}h</span>
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('CFL', r.sev.cfl)}
              {driverBadge('COV', r.sev.cov)}
              {driverBadge('CHK', r.sev.chk)}
              {driverBadge('EQP', r.sev.eqp)}
              {driverBadge('PBC', r.sev.pbc)}
            </div>
            <div className="px-2 pb-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {advice(r)}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No aircraft match the current filters.</div>
        )}

        {tab === 'STATIONS' && stationRows.map((s, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${s.outage ? '#ef4444' : NETWORK_COLOR[s.s.network]}` }}>
              <span className="font-semibold text-slate-100 font-mono">{s.s.id}</span>
              <span className="text-slate-300 truncate">{s.s.name}</span>
              <span className="px-1 py-px rounded text-[9px]" style={{ color: NETWORK_COLOR[s.s.network], border: '1px solid ' + NETWORK_COLOR[s.s.network] + '66', backgroundColor: NETWORK_COLOR[s.s.network] + '14' }}>{s.s.network}</span>
              {s.outage && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/40">OUTAGE</span>}
              <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{s.ac} ac</span>
              {tierBadge(s.worstTier)}
            </div>
            <div className="px-2 text-[10px] text-slate-400">{s.s.lat.toFixed(2)}°, {s.s.lng.toFixed(2)}° · primary {s.s.primaryKhz} kHz · {s.silent} SILENT · mean score {s.meanScore.toFixed(0)}</div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${Math.min(100, s.ac * 3)}%`, backgroundColor: NETWORK_COLOR[s.s.network] }} className="h-full" />
              </div>
            </div>
          </div>
        ))}

        {tab === 'CODES' && codeRows.slice(0, 60).map((c, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${c.collision ? '#ef4444' : TIER_COLOR[c.worstTier]}` }}>
              <span className="font-mono font-semibold text-slate-100">{c.code}</span>
              {famPill(c.family)}
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{c.ac} ac</span>
              {c.oceanic > 0 && <span className="px-1 py-px rounded text-[9px] bg-sky-500/15 text-sky-300 border border-sky-500/40">OCN {c.oceanic}</span>}
              {c.collision && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/40">CONFLICT</span>}
              <div className="ml-auto">{tierBadge(c.worstTier)}</div>
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-500 truncate">{c.cs.join(' · ')}</div>
          </div>
        ))}
        {tab === 'CODES' && codeRows.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No SELCAL codes tracked.</div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: ARINC 596 SELCAL · ARINC 714 Mark-3 Decoder · ARINC 719 HF Comms · ICAO Annex 10 Vol II §5.2.2 · Vol III Pt II ch 2 HF · Doc 4444 PANS-ATM 4.13/8.3.4 · Doc 7030 NAT SUPPS §1.5 · Doc 10037 GOLD §6.4 · NAT Doc 007 Ch 8 · NAT OPS Bulletin 2015-001/2017-002/2020-002 · FAA AC 91-70B Ch 5 · Order JO 7110.65 §8 · EUROCAE ED-23C / ED-137 · ITU-R RR App 27 · ASRI Code Registry (10,920 codes, 16-letter A-S alphabet, family-A A-H, family-B J-S). MWARA networks NAT/CAR/CWP/SP/SAT/AFI/EUR with primary day/night freq per ICAO MWARA tables.
      </div>
    </div>
  )
}
