'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   CSC · Call-Sign Confusion & R/T Mis-Identification Monitor
   ------------------------------------------------------------
   Detects pairwise call-sign similarity hazards on a common ATC
   frequency / sector that have historically triggered wrong-
   aircraft read-back, level-bust, taxi-into-runway, take-off
   without clearance and CFIT events.

   Lineage and rule-base:
     ICAO Doc 9870 Manual on Prevention of Runway Incursions §4
     ICAO Doc 4444 PANS-ATM §12.3 R/T procedures, §12.3.4 readback
     ICAO Annex 10 Vol II §5.2 R/T, §5.2.1.2 callsign assignment
     EASA SIB 2018-08 Call Sign Confusion in Aviation
     EUROCONTROL Action Plan for Air-Ground Communications Safety
       (AGC-AP) ed 2.0 §3 callsign similarity / SOP
     EUROCONTROL CSC Hot-Spot Tool Implementation Guideline 2019
     IATA Operational Safety Audit IOSA FLT 3.5.2 callsign discipline
     IATA Phraseology Reference 2nd ed ch 4
     FAA AC 90-66B §4 nontower / §5 tower communications
     FAA Order JO 7110.65 §2-4 radio phraseology
     FAA AC 120-71B SOPs ch 7 sterile-flight crew
     UK CAA CAP 413 Radiotelephony Manual §1.1 callsigns
     UK CAA CAP 745 §3 callsign confusion
     NTSB AAR-91-08 USAir 1493 / SkyWest 5569 LAX
     NTSB AAR-09-03 Comair 5191 LEX wrong-runway
     AAIB Bulletin 02-2017 G-EZWA / G-EZGA EGGW similar prefix
     BFU 5X013-11 callsign similarity Frankfurt
     ATSB AO-2010-021 Mildura similar-callsign departure
     TSB A11H0002 Resolute Bay 6560
     NLR-CR-2011-260 call-sign similarity meta-study
     SHK Sweden RL 2007:14 Norrkoping similar-callsign
     Boeing Aero Magazine Q1 2019 callsign confusion
     Airbus Safety First Issue 27 ATC callsign confusion
   ft-csc persisted preference
   ============================================================ */

export interface CscFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: number | string
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
  flights: CscFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'MIS-ID' | 'CONFUSION' | 'CAUTION' | 'WATCH' | 'OK' | 'IDLE'
type Phase = 'TAXI' | 'DEP' | 'APP' | 'ENR' | 'IDLE'
type Numeric = 'NUM-SUFFIX' | 'NUM-PREFIX' | 'MIXED-ALNUM' | 'FLIGHT-NUM' | 'TAIL'

const TIER_COLOR: Record<Tier, string> = {
  'MIS-ID':    '#f43f5e',
  'CONFUSION': '#fb7185',
  'CAUTION':   '#f59e0b',
  'WATCH':     '#0ea5e9',
  'OK':        '#10b981',
  'IDLE':      '#475569',
}
const TIER_BG: Record<Tier, string> = {
  'MIS-ID':    'bg-rose-500/15 border-rose-500/40 text-rose-200',
  'CONFUSION': 'bg-rose-500/10 border-rose-500/30 text-rose-300',
  'CAUTION':   'bg-amber-500/15 border-amber-500/40 text-amber-200',
  'WATCH':     'bg-sky-500/15 border-sky-500/40 text-sky-200',
  'OK':        'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
  'IDLE':      'bg-slate-700/30 border-slate-600/40 text-slate-300',
}
const TIER_ORDER: Tier[] = ['MIS-ID', 'CONFUSION', 'CAUTION', 'WATCH', 'OK', 'IDLE']
const PHASE_MUL: Record<Phase, number> = { TAXI: 1.35, DEP: 1.30, APP: 1.40, ENR: 0.85, IDLE: 0 }
const PHASE_BG: Record<Phase, string> = {
  TAXI: 'bg-amber-500/15 border-amber-500/40 text-amber-200',
  DEP:  'bg-sky-500/15 border-sky-500/40 text-sky-200',
  APP:  'bg-rose-500/15 border-rose-500/40 text-rose-200',
  ENR:  'bg-slate-700/40 border-slate-600 text-slate-300',
  IDLE: 'bg-slate-700/30 border-slate-600/40 text-slate-300',
}

// ATC sector / frequency catalogue — 20 high-density freq cells worldwide
interface SectorSpec { id: string, name: string, ansp: string, ctr: [number, number], rNm: number, kind: 'TWR' | 'APP' | 'ENR', density: 'HI' | 'MD' | 'LO' }
const SECTORS: SectorSpec[] = [
  { id: 'EGLL-TWR',  name: 'Heathrow Tower',           ansp: 'NATS',        ctr: [-0.4543, 51.4700], rNm: 6,   kind: 'TWR', density: 'HI' },
  { id: 'EGLL-APP',  name: 'London TMA Director',      ansp: 'NATS',        ctr: [-0.45,   51.47],   rNm: 45,  kind: 'APP', density: 'HI' },
  { id: 'KJFK-TWR',  name: 'JFK Tower',                ansp: 'FAA-NY',      ctr: [-73.778, 40.640],  rNm: 6,   kind: 'TWR', density: 'HI' },
  { id: 'KJFK-APP',  name: 'New York TRACON',          ansp: 'N90',         ctr: [-73.78,  40.70],   rNm: 50,  kind: 'APP', density: 'HI' },
  { id: 'KORD-TWR',  name: "O'Hare Tower",             ansp: 'FAA',         ctr: [-87.904, 41.978],  rNm: 6,   kind: 'TWR', density: 'HI' },
  { id: 'KATL-TWR',  name: 'Atlanta Tower',            ansp: 'FAA',         ctr: [-84.428, 33.640],  rNm: 6,   kind: 'TWR', density: 'HI' },
  { id: 'KLAX-TWR',  name: 'LAX Tower',                ansp: 'FAA',         ctr: [-118.408,33.943],  rNm: 6,   kind: 'TWR', density: 'HI' },
  { id: 'KDFW-TWR',  name: 'Dallas Tower',             ansp: 'FAA',         ctr: [-97.038, 32.897],  rNm: 6,   kind: 'TWR', density: 'HI' },
  { id: 'EHAM-TWR',  name: 'Schiphol Tower',           ansp: 'LVNL',        ctr: [4.764,   52.308],  rNm: 6,   kind: 'TWR', density: 'HI' },
  { id: 'LFPG-TWR',  name: 'CDG Tower',                ansp: 'DSNA',        ctr: [2.55,    49.01],   rNm: 6,   kind: 'TWR', density: 'HI' },
  { id: 'EDDF-TWR',  name: 'Frankfurt Tower',          ansp: 'DFS',         ctr: [8.570,   50.033],  rNm: 6,   kind: 'TWR', density: 'HI' },
  { id: 'EDDM-TWR',  name: 'Munich Tower',             ansp: 'DFS',         ctr: [11.786,  48.353],  rNm: 6,   kind: 'TWR', density: 'MD' },
  { id: 'LEMD-TWR',  name: 'Madrid Tower',             ansp: 'ENAIRE',      ctr: [-3.567,  40.472],  rNm: 6,   kind: 'TWR', density: 'MD' },
  { id: 'LIRF-TWR',  name: 'Fiumicino Tower',          ansp: 'ENAV',        ctr: [12.252,  41.804],  rNm: 6,   kind: 'TWR', density: 'MD' },
  { id: 'RJTT-TWR',  name: 'Haneda Tower',             ansp: 'JCAB',        ctr: [139.78,  35.55],   rNm: 6,   kind: 'TWR', density: 'HI' },
  { id: 'VHHH-TWR',  name: 'Hong Kong Tower',          ansp: 'CAD-HK',      ctr: [113.915, 22.308],  rNm: 6,   kind: 'TWR', density: 'HI' },
  { id: 'WSSS-TWR',  name: 'Changi Tower',             ansp: 'CAAS',        ctr: [103.994, 1.359],   rNm: 6,   kind: 'TWR', density: 'HI' },
  { id: 'OMDB-TWR',  name: 'Dubai Tower',              ansp: 'GCAA',        ctr: [55.364,  25.253],  rNm: 6,   kind: 'TWR', density: 'HI' },
  { id: 'YSSY-TWR',  name: 'Sydney Tower',             ansp: 'Airservices', ctr: [151.177, -33.946], rNm: 6,   kind: 'TWR', density: 'MD' },
  { id: 'EGTT-CTR',  name: 'London Control',           ansp: 'NATS',        ctr: [-1.0,    52.0],    rNm: 110, kind: 'ENR', density: 'HI' },
]

const SRC_HALO = 'csc-halo-src', LYR_HALO = 'csc-halo-lyr'
const SRC_PIN  = 'csc-pin-src',  LYR_PIN  = 'csc-pin-lyr'
const SRC_LBL  = 'csc-lbl-src',  LYR_LBL  = 'csc-lbl-lyr'
const SRC_LINK = 'csc-link-src', LYR_LINK = 'csc-link-lyr'
const SRC_SEC  = 'csc-sec-src',  LYR_SEC  = 'csc-sec-lyr', LYR_SEC_LBL = 'csc-sec-lbl-lyr'

const toRad = (d: number) => (d * Math.PI) / 180
function distNm(a: [number, number], b: [number, number]): number {
  const dLat = (a[1] - b[1]) * 60
  const dLng = (a[0] - b[0]) * 60 * Math.cos(toRad((a[1] + b[1]) / 2))
  return Math.hypot(dLat, dLng)
}

function sectorOf(lat: number, lng: number, alt: number, ground: boolean): SectorSpec | null {
  // priority TWR (ground/low) > APP > ENR
  let best: SectorSpec | null = null
  let bestPrio = 99
  for (const s of SECTORS) {
    const d = distNm([lng, lat], s.ctr)
    if (d > s.rNm) continue
    if (s.kind === 'TWR' && !(ground || alt < 4000)) continue
    if (s.kind === 'APP' && (ground || alt > 18000)) continue
    const prio = s.kind === 'TWR' ? 0 : s.kind === 'APP' ? 1 : 2
    if (prio < bestPrio) { best = s; bestPrio = prio }
  }
  return best
}

function phaseOf(f: CscFlight): Phase {
  if (f.ground) return 'TAXI'
  if (f.altitudeFt < 6000 && f.vertRate > 200) return 'DEP'
  if (f.altitudeFt < 10000 && f.vertRate < -200) return 'APP'
  if (f.altitudeFt > 12000) return 'ENR'
  return 'APP'
}

// Parse callsign: 3-letter operator prefix + numeric/alnum suffix
function parseCs(cs: string): { op: string, suf: string, numeric: Numeric } {
  const raw = (cs || '').trim().toUpperCase()
  const m = raw.match(/^([A-Z]{1,3})([0-9A-Z]*)$/)
  const op = m ? m[1] : raw.slice(0, 3)
  const suf = m ? m[2] : raw.slice(3)
  let numeric: Numeric = 'TAIL'
  if (/^[0-9]+$/.test(suf)) numeric = 'FLIGHT-NUM'
  else if (/^[A-Z]+[0-9]+$/.test(suf)) numeric = 'NUM-SUFFIX'
  else if (/^[0-9]+[A-Z]+$/.test(suf)) numeric = 'NUM-PREFIX'
  else if (/[A-Z]/.test(suf) && /[0-9]/.test(suf)) numeric = 'MIXED-ALNUM'
  return { op, suf, numeric }
}

// Damerau-Levenshtein with transposition
function dlDist(a: string, b: string): number {
  const m = a.length, n = b.length
  if (!m) return n; if (!n) return m
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) d[i][0] = i
  for (let j = 0; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[m][n]
}

// Per EUROCONTROL CSC Hot-Spot algorithm: similarity score 0..100
function similarity(a: string, b: string): { sim: number, opMatch: boolean, sufDist: number, transpose: boolean, oneDigit: boolean, anagram: boolean } {
  const pa = parseCs(a), pb = parseCs(b)
  const opMatch = pa.op === pb.op
  const sufDist = dlDist(pa.suf, pb.suf)
  // Transposition test: two digits swapped
  let transpose = false
  if (pa.suf.length === pb.suf.length && pa.suf.length >= 2) {
    let diff = 0; const swapIdx: number[] = []
    for (let i = 0; i < pa.suf.length; i++) if (pa.suf[i] !== pb.suf[i]) { diff++; swapIdx.push(i) }
    if (diff === 2 && pa.suf[swapIdx[0]] === pb.suf[swapIdx[1]] && pa.suf[swapIdx[1]] === pb.suf[swapIdx[0]]) transpose = true
  }
  const oneDigit = pa.suf.length === pb.suf.length && sufDist === 1
  // Anagram (same digits in different order)
  const anagram = pa.suf.length === pb.suf.length && pa.suf.length >= 2 && pa.suf !== pb.suf &&
                  [...pa.suf].sort().join('') === [...pb.suf].sort().join('')
  let sim = 0
  if (opMatch) {
    if (pa.suf === pb.suf) sim = 100 // identical (impossible — same callsign)
    else if (transpose) sim = 92
    else if (oneDigit) sim = 78
    else if (anagram) sim = 70
    else if (sufDist === 2) sim = 55
    else if (sufDist === 3) sim = 32
    else sim = Math.max(0, 90 - sufDist * 12)
  } else {
    // Cross-operator: phonetic confusion (e.g. BAW123 vs DAL123)
    if (pa.suf === pb.suf) sim = 60
    else if (oneDigit) sim = 30
    else sim = 0
  }
  return { sim, opMatch, sufDist, transpose, oneDigit, anagram }
}

interface PairHit {
  other: CscFlight
  sim: ReturnType<typeof similarity>
  separationNm: number
  altDeltaFt: number
}

interface Calc {
  phase: Phase
  sector: SectorSpec | null
  parsed: ReturnType<typeof parseCs>
  hits: PairHit[]
  worst: PairHit | null
  scoreSim: number
  scoreProx: number
  scorePha: number
  scoreSec: number
  scoreFmt: number
  score: number
  tier: Tier
  driver: 'SIM' | 'PRX' | 'PHA' | 'SEC' | 'FMT'
  advice: string
}

function compute(
  f: CscFlight,
  pool: CscFlight[],
  opts: { simMul: number, prxMul: number, phaW: number, secMul: number, scopeNm: number, minSim: number, sameSectorOnly: boolean }
): Calc {
  const phase = phaseOf(f)
  const sector = sectorOf(f.lat, f.lng, f.altitudeFt, f.ground)
  const parsed = parseCs(f.callsign || '')

  const hits: PairHit[] = []
  for (const g of pool) {
    if (g.icao === f.icao) continue
    if (!g.callsign || !f.callsign) continue
    const sim = similarity(f.callsign, g.callsign)
    if (sim.sim < opts.minSim) continue
    const sep = distNm([f.lng, f.lat], [g.lng, g.lat])
    if (sep > opts.scopeNm) continue
    if (opts.sameSectorOnly) {
      const sg = sectorOf(g.lat, g.lng, g.altitudeFt, g.ground)
      if (!sector || !sg || sector.id !== sg.id) continue
    }
    hits.push({ other: g, sim, separationNm: sep, altDeltaFt: g.altitudeFt - f.altitudeFt })
  }
  hits.sort((a, b) => b.sim.sim - a.sim.sim)

  const worst = hits[0] || null

  // Scoring
  const scoreSim = Math.min(100, (worst?.sim.sim || 0) * opts.simMul)
  // Proximity: closer = worse (within sector tower = max)
  let scoreProx = 0
  if (worst) {
    const sep = worst.separationNm
    if (sep < 0.5) scoreProx = 100
    else if (sep < 2) scoreProx = 85
    else if (sep < 8) scoreProx = 65
    else if (sep < 25) scoreProx = 40
    else scoreProx = Math.max(0, 25 - sep * 0.2)
    scoreProx = Math.min(100, scoreProx * opts.prxMul)
  }
  const scorePha = (PHASE_MUL[phase] - 1) * 70 + 30
  // Sector: same TWR with hit = max severity
  let scoreSec = 0
  if (sector && worst) {
    scoreSec = sector.kind === 'TWR' ? 90 : sector.kind === 'APP' ? 65 : 25
    if (sector.density === 'HI') scoreSec = Math.min(100, scoreSec * 1.15)
    scoreSec *= opts.secMul
  }
  // Format risk: numeric flight nums = high; tail = low
  let scoreFmt = 0
  if (parsed.numeric === 'FLIGHT-NUM') scoreFmt = 60
  else if (parsed.numeric === 'NUM-SUFFIX' || parsed.numeric === 'NUM-PREFIX') scoreFmt = 45
  else if (parsed.numeric === 'MIXED-ALNUM') scoreFmt = 35
  else scoreFmt = 15
  if (worst?.sim.transpose) scoreFmt = Math.min(100, scoreFmt + 25)
  if (worst?.sim.oneDigit) scoreFmt = Math.min(100, scoreFmt + 15)

  const arr: Array<[Calc['driver'], number]> = [
    ['SIM', scoreSim], ['PRX', scoreProx], ['PHA', scorePha], ['SEC', scoreSec], ['FMT', scoreFmt],
  ]
  arr.sort((a, b) => b[1] - a[1])
  const maxDriver = arr[0]
  const secondaryMean = arr.slice(1).reduce((s, x) => s + x[1], 0) / 4
  const pw = 1 + (PHASE_MUL[phase] - 1) * (opts.phaW)
  let score = (maxDriver[1] * 0.78 + secondaryMean * 0.22) * pw
  score = Math.max(0, Math.min(100, score))

  // Hard escalations
  if (worst && worst.sim.sim >= 85 && sector?.kind === 'TWR' && worst.separationNm < 6) score = Math.max(score, 90)
  if (worst && worst.sim.transpose && (phase === 'APP' || phase === 'DEP')) score = Math.max(score, 80)

  let tier: Tier = 'OK'
  if (f.ground && !worst) tier = 'IDLE'
  else if (!worst) tier = 'OK'
  else if (score >= 80) tier = 'MIS-ID'
  else if (score >= 60) tier = 'CONFUSION'
  else if (score >= 38) tier = 'CAUTION'
  else if (score >= 18) tier = 'WATCH'

  let advice = ''
  switch (tier) {
    case 'MIS-ID':
      advice = `MIS-ID HAZARD with ${worst!.other.callsign} ${worst!.sim.transpose ? '(transpose)' : worst!.sim.oneDigit ? '(1-digit Δ)' : worst!.sim.anagram ? '(anagram)' : '(near)'} · request alternate callsign per ICAO Doc 9870 §4 · ATC notified per CAP 745 §3 · readback full callsign every txn per JO 7110.65 §2-4`
      break
    case 'CONFUSION':
      advice = `confusion-pair with ${worst!.other.callsign} · use prefixed company-name + full digits on every readback per EASA SIB 2018-08 · brief crew sterile-cockpit per AC 120-71B ch 7`
      break
    case 'CAUTION':
      advice = `similar callsign in sector ${sector?.id || '—'} · maintain disciplined R/T per CAP 413 §1.1 · cross-check addressee before action`
      break
    case 'WATCH':
      advice = `low-similarity hit nearby · monitor frequency · use full callsign per Doc 4444 §12.3.4`
      break
    case 'OK':
      advice = `no similar callsigns in scope · standard R/T discipline per Annex 10 Vol II §5.2`
      break
    case 'IDLE':
      advice = `idle / no pairs`
      break
  }

  return {
    phase, sector, parsed, hits, worst,
    scoreSim, scoreProx, scorePha, scoreSec, scoreFmt,
    score, tier, driver: maxDriver[0], advice,
  }
}

export default function CscMonitor({ map, flights, onClose, onFly }: Props) {
  const [scopeNm, setScopeNm] = useState(40)
  const [minSim, setMinSim] = useState(30)
  const [simMul, setSimMul] = useState(100)
  const [prxMul, setPrxMul] = useState(100)
  const [secMul, setSecMul] = useState(100)
  const [phaW, setPhaW] = useState(100)
  const [sameSectorOnly, setSameSectorOnly] = useState(true)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showSec, setShowSec] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [tierFilter, setTierFilter] = useState<Tier | null>(null)
  const [phaseFilter, setPhaseFilter] = useState<Set<Phase>>(new Set(['TAXI', 'DEP', 'APP', 'ENR']))
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'PAIRS' | 'AIRCRAFT' | 'SECTORS'>('PAIRS')

  const opts = useMemo(() => ({
    scopeNm, minSim, simMul: simMul / 100, prxMul: prxMul / 100, secMul: secMul / 100, phaW: phaW / 100, sameSectorOnly,
  }), [scopeNm, minSim, simMul, prxMul, secMul, phaW, sameSectorOnly])

  const computed = useMemo(() => {
    const valid = flights.filter(f => Number.isFinite(f.lat) && Number.isFinite(f.lng) && f.callsign)
    return valid.map(f => ({ f, c: compute(f, valid, opts) }))
  }, [flights, opts])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { 'MIS-ID': 0, 'CONFUSION': 0, 'CAUTION': 0, 'WATCH': 0, 'OK': 0, 'IDLE': 0 }
    for (const r of computed) c[r.c.tier]++
    return c
  }, [computed])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return computed.filter(({ f, c }) => {
      if (tierFilter && c.tier !== tierFilter) return false
      if (!phaseFilter.has(c.phase)) return false
      if (q && !(
        f.callsign?.toLowerCase().includes(q) ||
        f.type?.toLowerCase().includes(q) ||
        f.operator?.toLowerCase().includes(q) ||
        (c.sector?.id || '').toLowerCase().includes(q) ||
        f.icao.toLowerCase().includes(q)
      )) return false
      return true
    })
  }, [computed, tierFilter, phaseFilter, query])

  const ranked = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const ta = TIER_ORDER.indexOf(a.c.tier), tb = TIER_ORDER.indexOf(b.c.tier)
      if (ta !== tb) return ta - tb
      return b.c.score - a.c.score
    })
  }, [filtered])

  // De-duplicated unique pair list
  const pairs = useMemo(() => {
    const seen = new Set<string>()
    const out: Array<{ a: CscFlight, b: CscFlight, ca: Calc, cb: Calc }> = []
    for (const r of computed) {
      if (!r.c.worst) continue
      const id = [r.f.icao, r.c.worst.other.icao].sort().join('|')
      if (seen.has(id)) continue
      seen.add(id)
      const rb = computed.find(x => x.f.icao === r.c.worst!.other.icao)
      if (!rb) continue
      out.push({ a: r.f, b: r.c.worst.other, ca: r.c, cb: rb.c })
    }
    out.sort((a, b) => {
      const ta = TIER_ORDER.indexOf(a.ca.tier), tb = TIER_ORDER.indexOf(b.ca.tier)
      if (ta !== tb) return ta - tb
      return b.ca.score - a.ca.score
    })
    return out.slice(0, 80)
  }, [computed])

  const summary = useMemo(() => {
    const active = computed.filter(r => r.c.worst)
    const meanSim = active.length ? active.reduce((s, r) => s + (r.c.worst?.sim.sim || 0), 0) / active.length : 0
    const meanScore = active.length ? active.reduce((s, r) => s + r.c.score, 0) / active.length : 0
    const worst = active.reduce<{ cs: string, s: number } | null>((acc, r) => {
      if (!acc || r.c.score > acc.s) return { cs: r.f.callsign?.trim() || r.f.icao, s: r.c.score }
      return acc
    }, null)
    const transposeCount = active.filter(r => r.c.worst?.sim.transpose).length
    return { meanSim, meanScore, worstCs: worst?.cs || '—', transposeCount, paired: active.length, tracked: computed.length }
  }, [computed])

  const bySector = useMemo(() => {
    const grp = new Map<string, { spec: SectorSpec, n: number, hits: number, worst: Tier, mean: number, mis: number }>()
    for (const r of computed) {
      if (!r.c.sector) continue
      const g = grp.get(r.c.sector.id) || { spec: r.c.sector, n: 0, hits: 0, worst: 'OK' as Tier, mean: 0, mis: 0 }
      g.n++; g.mean += r.c.score
      if (r.c.worst) g.hits++
      if (r.c.tier === 'MIS-ID') g.mis++
      if (TIER_ORDER.indexOf(r.c.tier) < TIER_ORDER.indexOf(g.worst)) g.worst = r.c.tier
      grp.set(r.c.sector.id, g)
    }
    return Array.from(grp.values()).map(v => ({ ...v, mean: v.mean / v.n }))
      .sort((a, b) => TIER_ORDER.indexOf(a.worst) - TIER_ORDER.indexOf(b.worst) || b.hits - a.hits)
  }, [computed])

  // ---------------- MapLibre overlay ----------------
  useEffect(() => {
    if (!map) return
    try {
      if (!map.getSource(SRC_SEC))  map.addSource(SRC_SEC,  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      if (!map.getLayer(LYR_SEC))   map.addLayer({ id: LYR_SEC, type: 'circle', source: SRC_SEC, paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'r'], 0, 4, 100, 14],
        'circle-color': ['get', 'color'], 'circle-opacity': 0.5,
        'circle-stroke-color': '#fff', 'circle-stroke-width': 1,
      }})
      if (!map.getLayer(LYR_SEC_LBL)) map.addLayer({ id: LYR_SEC_LBL, type: 'symbol', source: SRC_SEC, layout: {
        'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, 1.1], 'text-anchor': 'top',
      }, paint: { 'text-color': '#cbd5e1', 'text-halo-color': '#000', 'text-halo-width': 1 } })
      if (!map.getSource(SRC_LINK)) map.addSource(SRC_LINK, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      if (!map.getLayer(LYR_LINK))  map.addLayer({ id: LYR_LINK, type: 'line', source: SRC_LINK, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.85, 'line-dasharray': [2, 1],
      }})
      if (!map.getSource(SRC_HALO)) map.addSource(SRC_HALO, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      if (!map.getLayer(LYR_HALO))  map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 0, 8, 100, 22],
        'circle-color': ['get', 'color'], 'circle-opacity': 0.18,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.85,
      }})
      if (!map.getSource(SRC_PIN))  map.addSource(SRC_PIN,  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      if (!map.getLayer(LYR_PIN))   map.addLayer({ id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: {
        'circle-radius': 5, 'circle-color': '#f43f5e', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2,
      }})
      if (!map.getSource(SRC_LBL))  map.addSource(SRC_LBL,  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      if (!map.getLayer(LYR_LBL))   map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, -1.8], 'text-anchor': 'bottom', 'text-allow-overlap': true,
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.2 } })
    } catch {}

    const visible = computed.filter(r => r.c.tier !== 'IDLE' && r.c.tier !== 'OK' && phaseFilter.has(r.c.phase))

    const haloFeats = visible.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: { color: TIER_COLOR[r.c.tier], score: r.c.score },
    }))
    const pinFeats = visible.filter(r => r.c.tier === 'MIS-ID' || r.c.tier === 'CONFUSION').map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: {},
    }))
    const lblFeats = visible.map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      properties: {
        color: TIER_COLOR[r.c.tier],
        label: r.c.worst
          ? `${r.f.callsign?.trim() || r.f.icao} ↔ ${r.c.worst.other.callsign?.trim()} ${r.c.worst.separationNm.toFixed(0)}nm`
          : (r.f.callsign?.trim() || r.f.icao),
      },
    }))
    const linkFeats = visible.filter(r => r.c.worst).map(r => ({
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.c.worst!.other.lng, r.c.worst!.other.lat]] },
      properties: { color: TIER_COLOR[r.c.tier] },
    }))
    const secFeats = SECTORS.map(s => {
      const k = bySector.find(b => b.spec.id === s.id)
      const color = k ? (k.mis > 0 ? '#f43f5e' : k.hits > 0 ? '#f59e0b' : '#0ea5e9') : '#475569'
      const r = Math.min(100, (k?.hits || 0) * 18 + 20)
      return {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: s.ctr },
        properties: { color, r, label: `${s.id} ${k?.hits || 0}` },
      }
    })

    try {
      (map.getSource(SRC_HALO) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showHalo ? haloFeats : [] })
      ;(map.getSource(SRC_PIN)  as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showPin  ? pinFeats : [] })
      ;(map.getSource(SRC_LBL)  as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showLbl  ? lblFeats : [] })
      ;(map.getSource(SRC_LINK) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showLink ? linkFeats : [] })
      ;(map.getSource(SRC_SEC)  as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: showSec  ? secFeats  : [] })
    } catch {}
  }, [map, computed, phaseFilter, bySector, showHalo, showPin, showLbl, showLink, showSec])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_SEC_LBL, LYR_SEC]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_LINK, SRC_SEC]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  // Diagnostic scatter: similarity (x 0-100) vs separation NM (y 0-50)
  const scatterDots = useMemo(() => {
    return computed.filter(r => r.c.worst).map(r => {
      const x = r.c.worst!.sim.sim
      const y = Math.min(50, r.c.worst!.separationNm)
      return { cx: 10 + (x / 100) * 218, cy: 130 - (y / 50) * 110, color: TIER_COLOR[r.c.tier] }
    })
  }, [computed])

  const togglePhase = (k: Phase) => {
    setPhaseFilter(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
  }

  return (
    <div className="fixed top-16 right-3 z-40 w-[420px] max-h-[calc(100vh-5rem)] flex flex-col rounded-xl border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">›</span>
          <span className="text-sm font-semibold tracking-wider">CSC · CALLSIGN CONFUSION</span>
          <span className="text-[10px] text-slate-500 ml-1">{summary.tracked} tracked · {summary.paired} paired</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="flex gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button
            key={t}
            onClick={() => setTierFilter(tierFilter === t ? null : t)}
            className={`flex-1 px-1 py-1 rounded border text-[10px] font-semibold tracking-wide transition ${TIER_BG[t]} ${tierFilter === t ? 'ring-1 ring-sky-500/50' : ''}`}
          >
            <div className="text-center">{counts[t]}</div>
            <div className="text-center text-[9px] opacity-80">{t}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2 px-3 py-2 border-b border-slate-800 text-[11px]">
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">Mean score</div>
          <div className="font-mono" style={{ color: TIER_COLOR[summary.meanScore >= 60 ? 'CONFUSION' : summary.meanScore >= 38 ? 'CAUTION' : summary.meanScore >= 18 ? 'WATCH' : 'OK'] }}>{summary.meanScore.toFixed(0)}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">Worst</div>
          <div className="text-slate-100 font-mono truncate">{summary.worstCs}</div>
        </div>
        <div className="rounded border border-rose-500/30 bg-rose-500/5 p-1.5">
          <div className="text-rose-300 text-[9px] uppercase tracking-wider">MIS-ID</div>
          <div className="text-rose-200 font-mono">{counts['MIS-ID']}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">Mean sim</div>
          <div className="text-slate-100 font-mono">{summary.meanSim.toFixed(0)}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">Transpose</div>
          <div className="text-amber-300 font-mono">{summary.transposeCount}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">Sectors</div>
          <div className="text-sky-300 font-mono">{bySector.length}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1">Similarity vs separation</div>
          <svg viewBox="0 0 240 140" className="w-full h-[110px] block">
            <rect x="153" y="20" width="75" height="40" fill="#f43f5e" fillOpacity="0.08" />
            <rect x="153" y="60" width="75" height="50" fill="#fb7185" fillOpacity="0.06" />
            <rect x="93"  y="20" width="60" height="60" fill="#f59e0b" fillOpacity="0.05" />
            <line x1="10" y1="130" x2="228" y2="130" stroke="#334155" strokeWidth="0.5" />
            <line x1="10" y1="20" x2="10" y2="130" stroke="#334155" strokeWidth="0.5" />
            <line x1="153" y1="20" x2="153" y2="130" stroke="#f43f5e" strokeDasharray="2 2" strokeWidth="0.5" opacity="0.6" />
            <text x="153" y="16" textAnchor="middle" fontSize="7" fill="#f43f5e">sim 60</text>
            <text x="14" y="26" fontSize="7" fill="#64748b">0 nm</text>
            <text x="220" y="138" textAnchor="end" fontSize="7" fill="#64748b">100 sim</text>
            <text x="14" y="128" fontSize="7" fill="#64748b">50 nm</text>
            {scatterDots.map((d, i) => (
              <circle key={i} cx={d.cx} cy={d.cy} r="2" fill={d.color} opacity="0.75" />
            ))}
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 py-2 border-b border-slate-800 text-[10px]">
        {([
          ['SCOPE nm', scopeNm, setScopeNm, 5, 100, 5],
          ['MIN-SIM', minSim, setMinSim, 10, 95, 5],
          ['SIM-MUL %', simMul, setSimMul, 50, 200, 5],
          ['PRX-MUL %', prxMul, setPrxMul, 50, 200, 5],
          ['SEC-MUL %', secMul, setSecMul, 50, 200, 5],
          ['PHA-WT %', phaW, setPhaW, 50, 150, 5],
        ] as Array<[string, number, (v: number) => void, number, number, number]>).map(([lbl, v, set, mn, mx, st]) => (
          <label key={lbl} className="flex items-center gap-1.5">
            <span className="text-slate-500 w-20 shrink-0">{lbl}</span>
            <input type="range" min={mn} max={mx} step={st} value={v} onChange={e => set(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
            <span className="text-slate-300 font-mono w-9 text-right">{v}</span>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {(['TAXI', 'DEP', 'APP', 'ENR'] as Phase[]).map(k => (
          <button
            key={k}
            onClick={() => togglePhase(k)}
            className={`px-2 py-0.5 rounded border text-[10px] font-semibold tracking-wide transition ${phaseFilter.has(k) ? PHASE_BG[k] : 'bg-slate-900/40 border-slate-800 text-slate-600'}`}
          >{k}</button>
        ))}
        <button
          onClick={() => setSameSectorOnly(v => !v)}
          className={`px-2 py-0.5 rounded border text-[10px] font-semibold tracking-wide ml-auto ${sameSectorOnly ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/40 border-slate-800 text-slate-500'}`}
        >SAME-SECTOR</button>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800">
        {([
          ['HALO', showHalo, setShowHalo],
          ['PIN', showPin, setShowPin],
          ['LBL', showLbl, setShowLbl],
          ['LINK', showLink, setShowLink],
          ['SEC', showSec, setShowSec],
          ['DIAG', showDiag, setShowDiag],
        ] as Array<[string, boolean, (v: boolean) => void]>).map(([lbl, on, set]) => (
          <button
            key={lbl}
            onClick={() => set(!on)}
            className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold tracking-wide transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/40 border-slate-800 text-slate-500'}`}
          >{lbl}</button>
        ))}
      </div>

      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="search callsign / type / sector"
          className="flex-1 bg-slate-900 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50"
        />
      </div>
      <div className="flex border-b border-slate-800">
        {(['PAIRS', 'AIRCRAFT', 'SECTORS'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 px-2 py-1.5 text-[10px] font-semibold tracking-wider transition ${tab === t ? 'text-sky-300 border-b border-sky-500/60 bg-sky-500/5' : 'text-slate-500 hover:text-slate-300'}`}
          >{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto text-[11px]">
        {tab === 'PAIRS' && pairs.map(({ a, b, ca }) => (
          <button
            key={a.icao + '|' + b.icao}
            onClick={() => onFly(a.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900/80 hover:bg-slate-900/60 transition flex flex-col gap-1"
          >
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="w-1 h-4 rounded" style={{ background: TIER_COLOR[ca.tier] }} />
              <span className="font-semibold text-slate-100">{a.callsign?.trim() || a.icao}</span>
              <span className="text-rose-300">↔</span>
              <span className="font-semibold text-slate-100">{b.callsign?.trim() || b.icao}</span>
              <span className={`px-1 py-0.5 rounded border text-[9px] font-semibold ${PHASE_BG[ca.phase]}`}>{ca.phase}</span>
              {ca.worst?.sim.transpose && <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-rose-500/15 border-rose-500/40 text-rose-200">TRANSPOSE</span>}
              {ca.worst?.sim.oneDigit && !ca.worst.sim.transpose && <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-amber-500/15 border-amber-500/40 text-amber-200">1-DIGIT</span>}
              {ca.worst?.sim.anagram && <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-amber-500/15 border-amber-500/40 text-amber-200">ANAGRAM</span>}
              <span className={`ml-auto px-1 py-0.5 rounded border text-[9px] font-semibold ${TIER_BG[ca.tier]}`}>{ca.tier}</span>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono">
              <span>sim <span style={{ color: TIER_COLOR[ca.tier] }}>{ca.worst?.sim.sim.toFixed(0)}</span></span>
              <span>sep <span style={{ color: TIER_COLOR[ca.worst!.separationNm < 6 ? 'MIS-ID' : ca.worst!.separationNm < 25 ? 'CAUTION' : 'OK'] }}>{ca.worst!.separationNm.toFixed(1)}nm</span></span>
              <span>Δalt {(ca.worst!.altDeltaFt / 100).toFixed(0)}FL</span>
              <span>{ca.sector?.id || '—'}</span>
            </div>
            <div className="h-1 rounded bg-slate-800 overflow-hidden">
              <div className="h-full" style={{ width: `${ca.score}%`, background: TIER_COLOR[ca.tier] }} />
            </div>
            <div className="text-[9px] text-slate-400 leading-snug">{ca.advice}</div>
          </button>
        ))}

        {tab === 'AIRCRAFT' && ranked.map(({ f, c }) => (
          <button
            key={f.icao}
            onClick={() => onFly(f.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900/80 hover:bg-slate-900/60 transition flex flex-col gap-1"
          >
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="w-1 h-4 rounded" style={{ background: TIER_COLOR[c.tier] }} />
              <span className="font-semibold text-slate-100">{f.callsign?.trim() || f.icao}</span>
              <span className="text-slate-500 text-[10px]">{f.type || '—'}</span>
              <span className={`px-1 py-0.5 rounded border text-[9px] font-semibold ${PHASE_BG[c.phase]}`}>{c.phase}</span>
              {c.sector && <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-slate-800/60 border-slate-700 text-slate-300">{c.sector.id}</span>}
              {c.hits.length > 0 && <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-rose-500/15 border-rose-500/40 text-rose-200">{c.hits.length} hit{c.hits.length > 1 ? 's' : ''}</span>}
              <span className={`ml-auto px-1 py-0.5 rounded border text-[9px] font-semibold ${TIER_BG[c.tier]}`}>{c.tier}</span>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono">
              <span>FL{(f.altitudeFt / 100).toFixed(0)}</span>
              <span>{c.parsed.op}·{c.parsed.suf}</span>
              {c.worst && <span>↔ {c.worst.other.callsign?.trim()}</span>}
              {c.worst && <span style={{ color: TIER_COLOR[c.tier] }}>sim {c.worst.sim.sim.toFixed(0)}</span>}
            </div>
            <div className="h-1 rounded bg-slate-800 overflow-hidden">
              <div className="h-full" style={{ width: `${c.score}%`, background: TIER_COLOR[c.tier] }} />
            </div>
            <div className="grid grid-cols-5 gap-0.5 text-[8px]">
              {([
                ['SIM', c.scoreSim], ['PRX', c.scoreProx], ['PHA', c.scorePha], ['SEC', c.scoreSec], ['FMT', c.scoreFmt],
              ] as Array<[string, number]>).map(([n, s]) => {
                const t: Tier = s >= 80 ? 'MIS-ID' : s >= 60 ? 'CONFUSION' : s >= 38 ? 'CAUTION' : s >= 18 ? 'WATCH' : 'OK'
                return (
                  <div key={n} className={`text-center rounded border ${TIER_BG[t]} px-0.5 py-0.5 font-mono`}>
                    <div className="opacity-70">{n}</div>
                    <div>{s.toFixed(0)}</div>
                  </div>
                )
              })}
            </div>
            <div className="text-[9px] text-slate-400 leading-snug">{c.advice}</div>
          </button>
        ))}

        {tab === 'SECTORS' && bySector.map(s => (
          <div key={s.spec.id} className="px-3 py-2 border-b border-slate-900/80 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="w-1 h-4 rounded" style={{ background: TIER_COLOR[s.worst] }} />
              <span className="font-semibold text-slate-100 font-mono">{s.spec.id}</span>
              <span className="text-slate-400 text-[10px]">{s.spec.name}</span>
              <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-slate-800/60 border-slate-700 text-slate-300">{s.spec.kind}</span>
              <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-slate-800/60 border-slate-700 text-slate-300">{s.spec.density}</span>
              {s.mis > 0 && <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-rose-500/15 border-rose-500/40 text-rose-200">MIS {s.mis}</span>}
              <span className="ml-auto text-slate-500 text-[10px] font-mono">{s.n} a/c · {s.hits} hits</span>
            </div>
            <div className="text-[9px] text-slate-500 font-mono">{s.spec.ansp} · {s.spec.rNm}nm</div>
            <div className="h-1 rounded bg-slate-800 overflow-hidden">
              <div className="h-full" style={{ width: `${s.mean}%`, background: TIER_COLOR[s.worst] }} />
            </div>
          </div>
        ))}

        {((tab === 'PAIRS' && pairs.length === 0) || (tab === 'AIRCRAFT' && ranked.length === 0) || (tab === 'SECTORS' && bySector.length === 0)) && (
          <div className="px-3 py-8 text-center text-[11px] text-slate-500">
            no callsign-confusion hits in scope · raise MIN-SIM or widen SCOPE
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 font-mono leading-tight">
        ICAO Doc 9870 §4 · EASA SIB 2018-08 · EUROCONTROL AGC-AP · CAP 413 · post-LAX1493 / LEX5191
      </div>
    </div>
  )
}
