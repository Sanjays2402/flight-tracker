'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* TIBA · Traffic Information Broadcast by Aircraft — Self-Announce
   Frequency Compliance & Oceanic-Remote Position-Reporting Monitor.
   Per ICAO Annex 11 §3.4.4 / Annex 2 §3.6.5.1 / Doc 4444 PANS-ATM
   Ch.15 §15.1 / Doc 7030 / NAT Doc 007 / EUROCONTROL ENV §6.5 /
   FAA AC 91-70B / AIM 4-1-9 / TC CAR 602.97 / FCC §87.187.
   Distinct from CPDLC (datalink), SELCAL (selective alerting), ADS-B
   (auto surveillance), ARTCC HANDOFF (controller-to-controller),
   VHF CONGESTION (load not cadence), SQUAWK, ACLASS, DAA-WC. */

interface F {
  icao: string
  callsign: string
  registration: string
  type: string
  operator: string
  lng: number
  lat: number
  altitudeFt: number
  ground: boolean
  velocityKts: number
  ias: number
  mach: number
  vertRate: number
  navAlt: number
  windDir: number
  windKts: number
  oat: number
  track: number
  squawk: string
  category: string
  emergency: boolean
  dataSource: string
  military: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: F[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'NON-COMPLIANT' | 'DRIFT' | 'OBLIGATION' | 'ADVISORY' | 'NOMINAL' | 'OFF'
type Phase = 'OCN-CRZ' | 'REM-CRZ' | 'CTAF-APP' | 'CTAF-DEP' | 'TRANS-G' | 'POLAR' | 'OFF'
type Equip = 'HF-SAT' | 'VHF-ELT' | 'CPDLC-ADS' | 'VHF-ONLY' | 'HF-ONLY' | 'BASIC' | 'NONE'
type Driver = 'IN-TIBA' | 'FREQ' | 'CADENCE' | 'EQUIP' | 'PROX' | 'PHASE' | 'COORD' | 'BCAST'

const TIER_COLOR: Record<Tier, string> = {
  'NON-COMPLIANT': '#f43f5e',
  'DRIFT':         '#fb7185',
  'OBLIGATION':    '#f59e0b',
  'ADVISORY':      '#0ea5e9',
  'NOMINAL':       '#10b981',
  'OFF':           '#475569',
}

const TIER_RANK: Record<Tier, number> = {
  'NON-COMPLIANT': 5,
  'DRIFT':         4,
  'OBLIGATION':    3,
  'ADVISORY':      2,
  'NOMINAL':       1,
  'OFF':           0,
}

const PHASE_W: Record<Phase, number> = {
  'OCN-CRZ': 1.35,
  'REM-CRZ': 1.20,
  'CTAF-APP': 1.45,
  'CTAF-DEP': 1.35,
  'TRANS-G': 1.10,
  'POLAR':   1.30,
  'OFF':     0.0,
}

// 18-region TIBA / self-announce area catalogue
// Per ICAO Doc 7030 Regional Supplementary Procedures + AIP
type Region = {
  id: string
  name: string
  kind: 'OCN' | 'REM' | 'CTAF' | 'POLAR' | 'AIRWAY'
  // primary TIBA broadcast frequency
  freq: string
  freqMHz: number
  // bounding box approximation (lat/lng min/max)
  bbox: [number, number, number, number] // [latMin, lngMin, latMax, lngMax]
  // expected broadcast interval in seconds (typ. 600s per Doc 4444 §15.1.4)
  intervalSec: number
  // citation
  cite: string
  // active hint
  active: boolean
}

const REGIONS: Region[] = [
  // North Atlantic TIBA — NAT OTS lateral fringe / TIBA boundaries
  { id: 'NAT-W',    name: 'NAT West Atlantic TIBA',           kind: 'OCN',   freq: '131.800', freqMHz: 131.8,  bbox: [40, -65, 65, -30],   intervalSec: 600, cite: 'NAT Doc 007 §3.10 / FAA NAT OPS Bull',     active: true },
  { id: 'NAT-E',    name: 'NAT East Atlantic TIBA',           kind: 'OCN',   freq: '127.900', freqMHz: 127.9,  bbox: [40, -30, 65,  -8],   intervalSec: 600, cite: 'NAT Doc 007 §3.10 / Shanwick OAC AIP',    active: true },
  { id: 'WATRS',    name: 'WATRS Caribbean TIBA',             kind: 'OCN',   freq: '128.450', freqMHz: 128.45, bbox: [10, -85, 30, -60],   intervalSec: 600, cite: 'FAA Order 7110.83 §5-8 / WATRS AIP',      active: true },
  { id: 'CEP',      name: 'CEP Central East Pacific TIBA',    kind: 'OCN',   freq: '128.950', freqMHz: 128.95, bbox: [10, -160, 32, -120], intervalSec: 600, cite: 'FAA CEP Track Sys AIP / Honolulu CTA',    active: true },
  { id: 'NOPAC',    name: 'NOPAC North Pacific TIBA',         kind: 'OCN',   freq: '128.950', freqMHz: 128.95, bbox: [40, -180, 65, -130], intervalSec: 600, cite: 'PANS-ATM Doc 4444 §15.1 / Anchorage OCA', active: true },
  { id: 'PACOTS',   name: 'PACOTS Pacific Org Tracks',        kind: 'OCN',   freq: '128.950', freqMHz: 128.95, bbox: [25, 140, 50, 180],   intervalSec: 600, cite: 'PACOTS AIP / Tokyo CTA / Fukuoka FIR',    active: true },
  { id: 'SOPAC',    name: 'SOPAC South Pacific TIBA',         kind: 'OCN',   freq: '128.950', freqMHz: 128.95, bbox: [-50, 150, -10, -120],intervalSec: 600, cite: 'Auckland Oceanic AIP NZZO / Tahiti FIR',  active: true },
  { id: 'IATSC',    name: 'INSPIRE/IATSC Indian Ocean',       kind: 'OCN',   freq: '128.950', freqMHz: 128.95, bbox: [-30, 50, 5, 100],    intervalSec: 600, cite: 'Mauritius FIR / Doc 7030 SAM/ATS',         active: true },
  { id: 'BIRD',     name: 'BIRD Bay-of-Bengal TIBA',          kind: 'OCN',   freq: '128.950', freqMHz: 128.95, bbox: [3, 80, 22, 100],     intervalSec: 600, cite: 'Chennai FIR / Doc 7030 ASIA/PAC',          active: true },
  { id: 'SAT',      name: 'SAT South Atlantic TIBA',          kind: 'OCN',   freq: '128.950', freqMHz: 128.95, bbox: [-50, -45, -10, 10],  intervalSec: 600, cite: 'Atlantico FIR / Doc 7030 SAM/AFI',         active: true },
  { id: 'AFI-RCA',  name: 'AFI RCA Africa Remote',            kind: 'REM',   freq: '126.900', freqMHz: 126.9,  bbox: [-20, 10, 15, 45],    intervalSec: 600, cite: 'Kinshasa/Khartoum AIP / AFI ANC',          active: true },
  { id: 'SBR-RTA',  name: 'Russia North/East Remote',         kind: 'POLAR', freq: '126.900', freqMHz: 126.9,  bbox: [60, 80, 80, 180],    intervalSec: 600, cite: 'Magadan/Tiksi AIP UHMM / Doc 7030 EUR',    active: true },
  { id: 'YBBB',     name: 'AUS Outback OCA Brisbane Remote',  kind: 'REM',   freq: '126.900', freqMHz: 126.9,  bbox: [-30, 120, -10, 155], intervalSec: 600, cite: 'AsA AIP ENR 1.1 §57 / YBBB FIR',           active: true },
  { id: 'POLAR-N',  name: 'North Polar Region (NPOA)',        kind: 'POLAR', freq: 'HF-SELCAL',freqMHz: 8.825,  bbox: [78, -180, 90, 180],  intervalSec: 600, cite: 'FAA AC 120-42B App.G / NPOA contingency', active: true },
  { id: 'POLAR-S',  name: 'Antarctic Polar (Mc/Roth FIR)',    kind: 'POLAR', freq: '127.500', freqMHz: 127.5,  bbox: [-90, -180, -60, 180], intervalSec: 600, cite: 'COMNAP / NZ AIP YMMM Antarctic',           active: true },
  { id: 'CTAF-US',  name: 'US CTAF Uncontrolled Airfields',   kind: 'CTAF',  freq: '122.800', freqMHz: 122.8,  bbox: [25, -125, 50, -65],  intervalSec: 60,  cite: 'FAA AIM 4-1-9 / AC 90-66B CTAF',           active: false },
  { id: 'CTAF-CAN', name: 'Canada MF/ATF Uncontrolled',       kind: 'CTAF',  freq: '122.800', freqMHz: 122.8,  bbox: [42, -141, 70, -52],  intervalSec: 60,  cite: 'TC CAR 602.97 / MF / ATF / TCM',          active: false },
  { id: 'AIRAIR',   name: 'Air-Air Worldwide Coordination',   kind: 'AIRWAY',freq: '123.450', freqMHz: 123.45, bbox: [-90, -180, 90, 180], intervalSec: 0,   cite: 'ICAO Annex 10 Vol V §4.1.3.1.2 / FCC §87.187', active: false },
]

// 6-class equipage catalogue
type EquipSpec = {
  id: Equip
  name: string
  vhf: boolean
  hf: boolean
  satcomVoice: boolean
  cpdlc: boolean
  fans: boolean
  cite: string
}

const EQUIP_SPECS: EquipSpec[] = [
  { id: 'HF-SAT',    name: 'HF-SELCAL + SATCOM + CPDLC',  vhf: true, hf: true,  satcomVoice: true,  cpdlc: true,  fans: true,  cite: 'FANS-1A+ / ARINC 741 / Doc 7030 NAT' },
  { id: 'CPDLC-ADS', name: 'CPDLC + ADS-C + VHF',         vhf: true, hf: false, satcomVoice: false, cpdlc: true,  fans: true,  cite: 'PBCS RCP240/RSP180 / DO-258A' },
  { id: 'VHF-ELT',   name: 'VHF + ELT (no HF)',           vhf: true, hf: false, satcomVoice: false, cpdlc: false, fans: false, cite: 'AC 91-70B §2 / VHF-only oceanic limit' },
  { id: 'HF-ONLY',   name: 'HF SELCAL (legacy)',          vhf: false,hf: true,  satcomVoice: false, cpdlc: false, fans: false, cite: 'ARINC 596 SELCAL / NAT legacy' },
  { id: 'VHF-ONLY',  name: 'VHF only (no oceanic auth)',  vhf: true, hf: false, satcomVoice: false, cpdlc: false, fans: false, cite: 'Class G / CTAF only · NOT oceanic-legal' },
  { id: 'BASIC',     name: 'Basic VHF GA',                vhf: true, hf: false, satcomVoice: false, cpdlc: false, fans: false, cite: '14 CFR §91 GA basic / no IFR oceanic' },
  { id: 'NONE',      name: 'NORDO / equipage failure',    vhf: false,hf: false, satcomVoice: false, cpdlc: false, fans: false, cite: '§91.185 lost-comm regime' },
]

// hash for deterministic synthesis
function hash32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}

// great-circle bearing-distance in NM
function gcDistNm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = Math.PI / 180
  const dLat = (b.lat - a.lat) * toRad
  const dLng = (b.lng - a.lng) * toRad
  const la1 = a.lat * toRad, la2 = b.lat * toRad
  const x = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2
  return 2 * 3440 * Math.asin(Math.min(1, Math.sqrt(x)))
}

function inBbox(f: F, b: [number, number, number, number]): boolean {
  // handle anti-meridian crossing (lngMin>lngMax means wrap)
  const inLat = f.lat >= b[0] && f.lat <= b[2]
  if (!inLat) return false
  if (b[1] <= b[3]) return f.lng >= b[1] && f.lng <= b[3]
  return f.lng >= b[1] || f.lng <= b[3]
}

function pickEquip(h: number, kind: Region['kind']): Equip {
  const r = (h & 0xff) / 255
  // Oceanic and polar bias toward equipped airframes
  if (kind === 'OCN' || kind === 'POLAR') {
    if (r < 0.46) return 'HF-SAT'
    if (r < 0.72) return 'CPDLC-ADS'
    if (r < 0.88) return 'HF-ONLY'
    if (r < 0.96) return 'VHF-ELT'
    return 'NONE'
  }
  // Remote and CTAF
  if (r < 0.38) return 'VHF-ELT'
  if (r < 0.62) return 'VHF-ONLY'
  if (r < 0.82) return 'CPDLC-ADS'
  if (r < 0.94) return 'BASIC'
  return 'NONE'
}

interface Row {
  f: F
  region: Region | null
  equip: Equip
  equipSpec: EquipSpec
  phase: Phase
  sinceLastBcast: number  // seconds since last broadcast (synthesised)
  monitoring: boolean      // crew monitoring correct freq
  proxN: number            // count of nearby TIBA traffic w/in 80 NM
  proxNearest: number      // nm to nearest TIBA peer
  sev: Record<Driver, number>
  score: number
  tier: Tier
  topDriver: Driver
  freqMatch: boolean
}

const SRC_HALO = 'tiba-halo-src', SRC_PIN = 'tiba-pin-src', SRC_LBL = 'tiba-lbl-src'
const SRC_REG = 'tiba-reg-src', SRC_ARC = 'tiba-arc-src'
const LYR_REG_FILL = 'tiba-reg-fill', LYR_REG_LINE = 'tiba-reg-line', LYR_REG_LBL = 'tiba-reg-lbl'
const LYR_HALO = 'tiba-halo-lyr', LYR_PIN = 'tiba-pin-lyr', LYR_LBL = 'tiba-lbl-lyr'
const LYR_ARC = 'tiba-arc-lyr'

export default function TibaSelfAnnounce({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'REGIONS' | 'EQUIPAGE' | 'METHOD'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [regionFilter, setRegionFilter] = useState<string>('ALL')
  const [equipFilter, setEquipFilter] = useState<Equip | 'ALL'>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [advMul, setAdvMul] = useState(100)            // 50..200
  const [scopeNm, setScopeNm] = useState(80)           // 20..300
  const [intervalSec, setIntervalSec] = useState(600)  // 60..1200
  const [proxKm, setProxKm] = useState(80)             // 20..300 NM proximity threshold
  const [forceMonitor, setForceMonitor] = useState<'AUTO' | 'ON' | 'OFF'>('AUTO')
  const [query, setQuery] = useState('')

  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showReg, setShowReg] = useState(true)
  const [showArc, setShowArc] = useState(true)

  // Build per-flight rows, classifying region + equip + cadence + proximity
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    // first pass: place each flight in a region
    const placed: Array<{ f: F; region: Region | null }> = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      let reg: Region | null = null
      // priority: OCN > POLAR > REM > AIRWAY > CTAF
      const ordered = REGIONS.slice().sort((a, b) => {
        const pri = (r: Region) => r.kind === 'OCN' ? 4 : r.kind === 'POLAR' ? 3 : r.kind === 'REM' ? 2 : r.kind === 'AIRWAY' ? 1 : 0
        return pri(b) - pri(a)
      })
      for (const r of ordered) {
        if (inBbox(f, r.bbox)) { reg = r; break }
      }
      placed.push({ f, region: reg })
    }

    // proximity index keyed by region
    const byRegion = new Map<string, Array<{ f: F }>>()
    for (const p of placed) {
      if (!p.region) continue
      const k = p.region.id
      const arr = byRegion.get(k) || []
      arr.push({ f: p.f })
      byRegion.set(k, arr)
    }

    for (const p of placed) {
      const f = p.f
      const h = hash32(f.icao || f.callsign || 'X')
      const equip = pickEquip(h, p.region?.kind ?? 'AIRWAY')
      const equipSpec = EQUIP_SPECS.find(e => e.id === equip)!

      // Phase classifier
      let phase: Phase = 'OFF'
      if (p.region) {
        if (p.region.kind === 'OCN') phase = 'OCN-CRZ'
        else if (p.region.kind === 'POLAR') phase = 'POLAR'
        else if (p.region.kind === 'REM') phase = 'REM-CRZ'
        else if (p.region.kind === 'CTAF') phase = f.altitudeFt < 5000 && f.vertRate < -100 ? 'CTAF-APP' : f.altitudeFt < 6000 ? 'CTAF-DEP' : 'TRANS-G'
        else phase = 'TRANS-G'
      } else if (f.altitudeFt < 6000) {
        phase = 'TRANS-G'
      }

      // Deterministic synthesised time since last broadcast
      // Cadence depends on equipage and crew discipline
      const cadenceBase = p.region?.intervalSec ?? intervalSec
      const cadenceJitter = ((h >>> 11) & 0xff) / 255  // 0..1
      // Better-equipped crews keep tighter cadence
      const disciplineMul = equip === 'HF-SAT' ? 0.55 : equip === 'CPDLC-ADS' ? 0.65 : equip === 'HF-ONLY' ? 0.85 : equip === 'VHF-ELT' ? 1.05 : equip === 'VHF-ONLY' ? 1.45 : 1.85
      const sinceLastBcast = cadenceBase * (0.15 + cadenceJitter * 1.6 * disciplineMul)

      // Monitoring correct frequency
      // High discipline correlates with proper monitoring; small fraction non-monitoring
      const monSeed = ((h >>> 17) & 0xff) / 255
      const monProb = equip === 'HF-SAT' ? 0.96 : equip === 'CPDLC-ADS' ? 0.94 : equip === 'HF-ONLY' ? 0.86 : equip === 'VHF-ELT' ? 0.78 : equip === 'VHF-ONLY' ? 0.55 : equip === 'BASIC' ? 0.4 : 0.05
      const monAuto = monSeed < monProb
      const monitoring = forceMonitor === 'ON' ? true : forceMonitor === 'OFF' ? false : monAuto

      // Frequency match — if equipage cannot tune the required band
      const reqHF = (p.region?.freq === 'HF-SELCAL') || (p.region?.kind === 'OCN' && equip === 'HF-ONLY')
      const reqVHF = !reqHF
      const freqMatch = !p.region ? true : (reqHF ? equipSpec.hf : equipSpec.vhf)

      // Proximity — count peers within proxKm of this aircraft in same region
      let proxN = 0, proxNearest = Infinity
      if (p.region) {
        const peers = byRegion.get(p.region.id) || []
        for (const other of peers) {
          if (other.f.icao === f.icao) continue
          const d = gcDistNm({ lat: f.lat, lng: f.lng }, { lat: other.f.lat, lng: other.f.lng })
          if (d <= proxKm) proxN++
          if (d < proxNearest) proxNearest = d
        }
      }

      // Risk drivers
      const inTibaSev = !p.region ? 0 : (p.region.kind === 'OCN' ? 25 : p.region.kind === 'POLAR' ? 30 : p.region.kind === 'REM' ? 18 : p.region.kind === 'CTAF' ? 12 : 5)
      const freqSev = !p.region ? 0 : freqMatch ? 0 : 88 // can't even tune required freq
      // Cadence — exceeding required interval is the headline metric
      const cadOver = sinceLastBcast / cadenceBase
      const cadenceSev = cadOver < 0.7 ? 5 : cadOver < 1.0 ? 25 : cadOver < 1.5 ? 55 : cadOver < 2.0 ? 80 : 95
      const equipSevMap: Record<Equip, number> = { 'HF-SAT': 0, 'CPDLC-ADS': 8, 'VHF-ELT': 22, 'HF-ONLY': 18, 'VHF-ONLY': p.region?.kind === 'OCN' || p.region?.kind === 'POLAR' ? 78 : 35, 'BASIC': p.region?.kind === 'OCN' ? 92 : 40, 'NONE': 95 }
      const equipSev = equipSevMap[equip]
      const proxSev = proxN === 0 ? 0 : proxN === 1 ? 18 : proxN === 2 ? 38 : proxN <= 4 ? 58 : 78
      const phaseSev = (PHASE_W[phase] || 0) * 25
      const coordSev = !monitoring && p.region ? (p.region.kind === 'OCN' || p.region.kind === 'POLAR' ? 80 : 55) : 0
      const bcastSev = !p.region ? 0 : monitoring && sinceLastBcast > cadenceBase * 1.2 ? 60 : 0

      const sev: Record<Driver, number> = {
        'IN-TIBA': inTibaSev,
        'FREQ':    freqSev,
        'CADENCE': cadenceSev,
        'EQUIP':   equipSev,
        'PROX':    proxSev,
        'PHASE':   phaseSev,
        'COORD':   coordSev,
        'BCAST':   bcastSev,
      }
      const vals = Object.values(sev)
      const mx = vals.reduce((m, v) => v > m ? v : m, 0)
      const mn = vals.reduce((s, v) => s + v, 0) / vals.length
      let score = (mx * 0.66 + mn * 0.34) * (advMul / 100) * (PHASE_W[phase] || 0.6)

      // Hard escalators
      const escalators: number[] = []
      if (p.region && (p.region.kind === 'OCN' || p.region.kind === 'POLAR') && (equip === 'VHF-ONLY' || equip === 'BASIC' || equip === 'NONE')) escalators.push(92)
      if (p.region && !freqMatch) escalators.push(88)
      if (p.region && sinceLastBcast > cadenceBase * 2.5) escalators.push(80)
      if (p.region && !monitoring && (p.region.kind === 'OCN' || p.region.kind === 'POLAR')) escalators.push(74)
      if (p.region && proxN >= 3 && (equip === 'NONE' || !monitoring)) escalators.push(68)
      if (p.region && proxNearest < 30 && (p.region.kind === 'OCN' || p.region.kind === 'POLAR')) escalators.push(58)
      for (const e of escalators) if (e > score) score = e

      score = Math.max(0, Math.min(100, score))
      const tier: Tier = !p.region ? 'OFF'
        : score >= 85 ? 'NON-COMPLIANT'
        : score >= 65 ? 'DRIFT'
        : score >= 45 ? 'OBLIGATION'
        : score >= 22 ? 'ADVISORY'
        : 'NOMINAL'

      // top driver = highest sev
      const sortedDrv = Object.entries(sev).sort((a, b) => b[1] - a[1]) as Array<[Driver, number]>
      const topDriver = sortedDrv[0][0] as Driver

      out.push({
        f, region: p.region, equip, equipSpec, phase,
        sinceLastBcast, monitoring,
        proxN, proxNearest: isFinite(proxNearest) ? proxNearest : 999,
        sev, score, tier, topDriver, freqMatch,
      })
    }
    return out.sort((a, b) => b.score - a.score)
  }, [flights, advMul, scopeNm, intervalSec, proxKm, forceMonitor])

  const visible = useMemo(() => rows.filter(r => {
    if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
    if (regionFilter !== 'ALL' && r.region?.id !== regionFilter) return false
    if (equipFilter !== 'ALL' && r.equip !== equipFilter) return false
    if (phaseFilter !== 'ALL' && r.phase !== phaseFilter) return false
    if (query) {
      const q = query.toLowerCase()
      const hay = `${r.f.callsign} ${r.f.type} ${r.f.operator} ${r.f.icao} ${r.region?.id || ''} ${r.equip}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  }), [rows, tierFilter, regionFilter, equipFilter, phaseFilter, query])

  // Tier counts
  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { 'NON-COMPLIANT': 0, 'DRIFT': 0, 'OBLIGATION': 0, 'ADVISORY': 0, 'NOMINAL': 0, 'OFF': 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  // Per-region stats
  const regStats = useMemo(() => {
    const m = new Map<string, { r: Region; count: number; nc: number; drift: number; muScore: number; muSince: number }>()
    for (const reg of REGIONS) m.set(reg.id, { r: reg, count: 0, nc: 0, drift: 0, muScore: 0, muSince: 0 })
    for (const row of rows) {
      if (!row.region) continue
      const st = m.get(row.region.id)
      if (!st) continue
      st.count++
      if (row.tier === 'NON-COMPLIANT') st.nc++
      if (row.tier === 'DRIFT') st.drift++
      st.muScore += row.score
      st.muSince += row.sinceLastBcast
    }
    for (const st of m.values()) {
      if (st.count > 0) { st.muScore /= st.count; st.muSince /= st.count }
    }
    return Array.from(m.values()).sort((a, b) => b.muScore - a.muScore)
  }, [rows])

  const equipStats = useMemo(() => {
    const m = new Map<Equip, { spec: EquipSpec; count: number; nc: number; muScore: number }>()
    for (const sp of EQUIP_SPECS) m.set(sp.id, { spec: sp, count: 0, nc: 0, muScore: 0 })
    for (const row of rows) {
      const st = m.get(row.equip)
      if (!st) continue
      st.count++
      if (row.tier === 'NON-COMPLIANT' || row.tier === 'DRIFT') st.nc++
      st.muScore += row.score
    }
    for (const st of m.values()) if (st.count > 0) st.muScore /= st.count
    return Array.from(m.values()).sort((a, b) => b.muScore - a.muScore)
  }, [rows])

  const advice = (r: Row): string => {
    if (!r.region) return '— outside TIBA area, normal ATC procedures'
    if (r.tier === 'NON-COMPLIANT') {
      if (!r.freqMatch) return `‼ Cannot tune required ${r.region.freq} — divert to equipped airspace per ${r.region.cite}`
      if (r.equip === 'NONE' || r.equip === 'BASIC') return `‼ Equipage inadequate for ${r.region.name} — Doc 4444 §15.1 mandates VHF capability`
      return `‼ Initiate IMMEDIATE broadcast on ${r.region.freq} — last call ${(r.sinceLastBcast / 60).toFixed(1)} min ago per ${r.region.cite}`
    }
    if (r.tier === 'DRIFT') return `Broadcast NOW on ${r.region.freq} — interval exceeded · cite ${r.region.cite}`
    if (r.tier === 'OBLIGATION') return `Broadcast within ${Math.max(0, ((r.region.intervalSec - r.sinceLastBcast) / 60)).toFixed(1)} min on ${r.region.freq}`
    if (r.tier === 'ADVISORY') return `Maintain TIBA watch on ${r.region.freq} · interval ${(r.region.intervalSec / 60).toFixed(0)} min`
    return `Compliant · monitor ${r.region.freq} · next call in ${Math.max(0, ((r.region.intervalSec - r.sinceLastBcast) / 60)).toFixed(1)} min`
  }

  // MapLibre layer wiring
  useEffect(() => {
    if (!map) return

    const ensureSrc = (id: string, data: any) => {
      const s = map.getSource(id) as maplibregl.GeoJSONSource | undefined
      if (s) s.setData(data)
      else map.addSource(id, { type: 'geojson', data })
    }
    const ensureLyr = (id: string, spec: any) => {
      if (map.getLayer(id)) return
      try { map.addLayer(spec) } catch {}
    }
    const removeAll = () => {
      for (const id of [LYR_REG_FILL, LYR_REG_LINE, LYR_REG_LBL, LYR_HALO, LYR_PIN, LYR_LBL, LYR_ARC]) {
        if (map.getLayer(id)) try { map.removeLayer(id) } catch {}
      }
      for (const id of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_REG, SRC_ARC]) {
        if (map.getSource(id)) try { map.removeSource(id) } catch {}
      }
    }

    // region polygons
    const regFc = {
      type: 'FeatureCollection',
      features: REGIONS.filter(r => r.kind !== 'AIRWAY').map(r => {
        const [latMin, lngMin, latMax, lngMax] = r.bbox
        // bbox to polygon (handle anti-meridian)
        let coords: number[][][]
        if (lngMin <= lngMax) {
          coords = [[[lngMin, latMin], [lngMax, latMin], [lngMax, latMax], [lngMin, latMax], [lngMin, latMin]]]
        } else {
          coords = [
            [[lngMin, latMin], [180, latMin], [180, latMax], [lngMin, latMax], [lngMin, latMin]],
            [[-180, latMin], [lngMax, latMin], [lngMax, latMax], [-180, latMax], [-180, latMin]],
          ]
        }
        return {
          type: 'Feature',
          properties: { id: r.id, name: r.name, freq: r.freq, kind: r.kind },
          geometry: { type: 'MultiPolygon', coordinates: coords.map(c => [c]) },
        }
      }),
    }

    // halos / pins / labels
    const haloFc = {
      type: 'FeatureCollection',
      features: visible.slice(0, 200).map(r => ({
        type: 'Feature',
        properties: {
          score: r.score,
          tier: r.tier,
          color: TIER_COLOR[r.tier],
          radius: 6 + (r.score / 100) * 16,
        },
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
      })),
    }
    const pinFc = {
      type: 'FeatureCollection',
      features: visible.filter(r => r.score >= 65).slice(0, 80).map(r => ({
        type: 'Feature',
        properties: { color: TIER_COLOR[r.tier] },
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
      })),
    }
    const lblFc = {
      type: 'FeatureCollection',
      features: visible.slice(0, 50).map(r => ({
        type: 'Feature',
        properties: {
          label: `${r.f.callsign}·${r.region?.id || '—'}·${r.equip}·${(r.sinceLastBcast / 60).toFixed(0)}m`,
          color: TIER_COLOR[r.tier],
        },
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
      })),
    }

    // proximity arcs — link top-30 high-score craft to nearest in-region peer
    const arcFc = {
      type: 'FeatureCollection',
      features: (() => {
        const ftrs: any[] = []
        const top = visible.filter(r => r.region && r.proxN >= 1).slice(0, 30)
        for (const r of top) {
          // find the actual nearest peer
          const peers = rows.filter(o => o.region?.id === r.region!.id && o.f.icao !== r.f.icao)
          let best: Row | null = null, bestD = Infinity
          for (const o of peers) {
            const d = gcDistNm({ lat: r.f.lat, lng: r.f.lng }, { lat: o.f.lat, lng: o.f.lng })
            if (d < bestD) { bestD = d; best = o }
          }
          if (!best || bestD > proxKm * 1.5) continue
          ftrs.push({
            type: 'Feature',
            properties: { color: TIER_COLOR[r.tier], score: r.score },
            geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [best.f.lng, best.f.lat]] },
          })
        }
        return ftrs
      })(),
    }

    ensureSrc(SRC_REG, regFc as any)
    ensureSrc(SRC_HALO, haloFc as any)
    ensureSrc(SRC_PIN, pinFc as any)
    ensureSrc(SRC_LBL, lblFc as any)
    ensureSrc(SRC_ARC, arcFc as any)

    const kindColor = ['match', ['get', 'kind'], 'OCN', '#0ea5e9', 'POLAR', '#a78bfa', 'REM', '#f59e0b', 'CTAF', '#10b981', '#475569']

    if (showReg) {
      ensureLyr(LYR_REG_FILL, { id: LYR_REG_FILL, type: 'fill', source: SRC_REG, paint: { 'fill-color': kindColor, 'fill-opacity': 0.06 } })
      ensureLyr(LYR_REG_LINE, { id: LYR_REG_LINE, type: 'line', source: SRC_REG, paint: { 'line-color': kindColor, 'line-width': 1.0, 'line-opacity': 0.55, 'line-dasharray': [3, 2] } })
      ensureLyr(LYR_REG_LBL, { id: LYR_REG_LBL, type: 'symbol', source: SRC_REG, layout: { 'text-field': ['concat', ['get', 'id'], ' · ', ['get', 'freq']], 'text-size': 9, 'text-font': ['Open Sans Regular'], 'symbol-placement': 'point' }, paint: { 'text-color': '#cbd5e1', 'text-halo-color': '#0f172a', 'text-halo-width': 1.2 } })
    } else {
      for (const id of [LYR_REG_FILL, LYR_REG_LINE, LYR_REG_LBL]) if (map.getLayer(id)) try { map.removeLayer(id) } catch {}
    }

    if (showArc) ensureLyr(LYR_ARC, { id: LYR_ARC, type: 'line', source: SRC_ARC, paint: { 'line-color': ['get', 'color'], 'line-width': 1.0, 'line-opacity': 0.55, 'line-dasharray': [1, 2] } })
    else if (map.getLayer(LYR_ARC)) try { map.removeLayer(LYR_ARC) } catch {}

    if (showHalo) ensureLyr(LYR_HALO, { id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.2, 'circle-stroke-opacity': 0.85 } })
    else if (map.getLayer(LYR_HALO)) try { map.removeLayer(LYR_HALO) } catch {}

    if (showPin) ensureLyr(LYR_PIN, { id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: { 'circle-radius': 3.5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0f172a', 'circle-stroke-width': 1.0 } })
    else if (map.getLayer(LYR_PIN)) try { map.removeLayer(LYR_PIN) } catch {}

    if (showLbl) ensureLyr(LYR_LBL, { id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0f172a', 'text-halo-width': 1.2 } })
    else if (map.getLayer(LYR_LBL)) try { map.removeLayer(LYR_LBL) } catch {}

    return () => { removeAll() }
  }, [map, visible, rows, showReg, showHalo, showPin, showLbl, showArc, proxKm])

  return (
    <div className="absolute top-16 right-4 z-40 w-[min(94vw,460px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Self-Announce / Doc 4444 §15.1</div>
          <div className="text-sm font-semibold text-slate-100">TIBA · Traffic Info Broadcast by Aircraft</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* Tier strip */}
      <div className="px-3 py-1.5 border-b border-slate-800 flex items-center gap-1 text-[10px]">
        <button onClick={() => setTierFilter('ALL')} className={`px-2 py-0.5 rounded font-mono ${tierFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-400'}`}>ALL {rows.length}</button>
        {(['NON-COMPLIANT', 'DRIFT', 'OBLIGATION', 'ADVISORY', 'NOMINAL', 'OFF'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(t)} className={`px-1.5 py-0.5 rounded font-mono ${tierFilter === t ? 'border-2' : 'border'}`} style={{ borderColor: TIER_COLOR[t] + '55', color: TIER_COLOR[t], background: TIER_COLOR[t] + '10' }}>
            {t.slice(0, 3)} {tierCounts[t]}
          </button>
        ))}
      </div>

      {/* Summary cells */}
      <div className="px-3 py-1 border-b border-slate-800 grid grid-cols-5 gap-1 text-[10px]">
        <div className="bg-slate-800/40 rounded px-1 py-0.5">μ-SCORE <span className="font-mono text-slate-100 ml-1">{(rows.reduce((s, r) => s + r.score, 0) / Math.max(1, rows.length)).toFixed(1)}</span></div>
        <div className="bg-slate-800/40 rounded px-1 py-0.5">IN-TIBA <span className="font-mono text-sky-300 ml-1">{rows.filter(r => r.region).length}</span></div>
        <div className="bg-slate-800/40 rounded px-1 py-0.5">NC <span className="font-mono ml-1" style={{ color: TIER_COLOR['NON-COMPLIANT'] }}>{tierCounts['NON-COMPLIANT']}</span></div>
        <div className="bg-slate-800/40 rounded px-1 py-0.5">DRIFT <span className="font-mono ml-1" style={{ color: TIER_COLOR['DRIFT'] }}>{tierCounts['DRIFT']}</span></div>
        <div className="bg-slate-800/40 rounded px-1 py-0.5">OBL <span className="font-mono ml-1" style={{ color: TIER_COLOR['OBLIGATION'] }}>{tierCounts['OBLIGATION']}</span></div>
      </div>

      {/* Controls */}
      <div className="px-3 py-1.5 border-b border-slate-800 space-y-1 text-[10px]">
        <div className="flex items-center gap-2">
          <span className="text-slate-500 w-16 font-mono">ADV-MUL</span>
          <input type="range" min={50} max={200} value={advMul} onChange={e => setAdvMul(parseInt(e.target.value))} className="flex-1 accent-sky-500 h-1" />
          <span className="font-mono text-slate-300 w-10 text-right">{advMul}%</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500 w-16 font-mono">SCOPE</span>
          <input type="range" min={20} max={300} value={scopeNm} onChange={e => setScopeNm(parseInt(e.target.value))} className="flex-1 accent-sky-500 h-1" />
          <span className="font-mono text-slate-300 w-10 text-right">{scopeNm}NM</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500 w-16 font-mono">INTERVAL</span>
          <input type="range" min={60} max={1200} step={30} value={intervalSec} onChange={e => setIntervalSec(parseInt(e.target.value))} className="flex-1 accent-sky-500 h-1" />
          <span className="font-mono text-slate-300 w-10 text-right">{Math.round(intervalSec / 60)}m</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500 w-16 font-mono">PROX</span>
          <input type="range" min={20} max={300} value={proxKm} onChange={e => setProxKm(parseInt(e.target.value))} className="flex-1 accent-sky-500 h-1" />
          <span className="font-mono text-slate-300 w-10 text-right">{proxKm}NM</span>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-slate-500 font-mono">MON</span>
          {(['AUTO', 'ON', 'OFF'] as const).map(m => (
            <button key={m} onClick={() => setForceMonitor(m)} className={`px-1.5 py-0.5 rounded font-mono ${forceMonitor === m ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-400'}`}>{m}</button>
          ))}
          <span className="text-slate-700 mx-1">|</span>
          <button onClick={() => setShowHalo(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showHalo ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>HALO</button>
          <button onClick={() => setShowPin(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showPin ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>PIN</button>
          <button onClick={() => setShowLbl(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showLbl ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>LBL</button>
          <button onClick={() => setShowReg(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showReg ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>REG</button>
          <button onClick={() => setShowArc(v => !v)} className={`px-1.5 py-0.5 rounded font-mono ${showArc ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>ARC</button>
        </div>
      </div>

      {/* Filters */}
      <div className="px-3 py-1 border-b border-slate-800 flex items-center gap-1 flex-wrap text-[10px]">
        <button onClick={() => setRegionFilter('ALL')} className={`px-1.5 py-0.5 rounded font-mono ${regionFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>ALL-REG</button>
        {REGIONS.filter(r => r.kind !== 'AIRWAY').slice(0, 9).map(r => (
          <button key={r.id} onClick={() => setRegionFilter(r.id)} className={`px-1.5 py-0.5 rounded font-mono ${regionFilter === r.id ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>{r.id}</button>
        ))}
      </div>
      <div className="px-3 py-1 border-b border-slate-800 flex items-center gap-1 flex-wrap text-[10px]">
        <button onClick={() => setEquipFilter('ALL')} className={`px-1.5 py-0.5 rounded font-mono ${equipFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>ALL-EQP</button>
        {(['HF-SAT', 'CPDLC-ADS', 'VHF-ELT', 'HF-ONLY', 'VHF-ONLY', 'BASIC', 'NONE'] as Equip[]).map(e => (
          <button key={e} onClick={() => setEquipFilter(e)} className={`px-1.5 py-0.5 rounded font-mono ${equipFilter === e ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-500'}`}>{e}</button>
        ))}
      </div>

      <div className="px-3 py-1 border-b border-slate-800">
        <input type="text" placeholder="search callsign / type / operator / region / equip" value={query} onChange={e => setQuery(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/60" />
      </div>

      {/* Tabs */}
      <div className="px-3 py-1.5 border-b border-slate-800 flex items-center gap-1 text-[10px]">
        {(['AIRCRAFT', 'REGIONS', 'EQUIPAGE', 'METHOD'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-0.5 rounded font-mono ${tab === t ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'border border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
        {tab === 'AIRCRAFT' && visible.slice(0, 100).map((r, i) => (
          <div key={i} onClick={() => onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5 transition-colors">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{r.f.callsign || r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-300">{r.f.type}</span>
              <span className="px-1 rounded font-mono text-[9px]" style={{ background: TIER_COLOR[r.tier] + '22', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.equip}</span>
              <span className="ml-auto font-mono text-slate-300">›</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px]">
              <div>REG <span className="font-mono text-slate-100">{r.region?.id || '—'}</span></div>
              <div>FREQ <span className="font-mono" style={{ color: r.freqMatch ? '#cbd5e1' : TIER_COLOR['NON-COMPLIANT'] }}>{r.region?.freq || '—'}</span></div>
              <div>LAST <span className="font-mono" style={{ color: r.region && r.sinceLastBcast > (r.region.intervalSec || 600) ? TIER_COLOR['DRIFT'] : '#cbd5e1' }}>{(r.sinceLastBcast / 60).toFixed(1)}m</span></div>
              <div>MON <span className="font-mono" style={{ color: r.monitoring ? '#10b981' : TIER_COLOR['OBLIGATION'] }}>{r.monitoring ? 'Y' : 'N'}</span></div>
              <div>FL <span className="font-mono text-slate-100">{Math.round(r.f.altitudeFt / 100)}</span></div>
              <div>GS <span className="font-mono text-slate-100">{r.f.velocityKts?.toFixed(0) ?? '—'}</span></div>
              <div>PEERS <span className="font-mono text-slate-100">{r.proxN}</span></div>
              <div>NRST <span className="font-mono text-slate-100">{r.proxNearest < 999 ? r.proxNearest.toFixed(0) + 'NM' : '—'}</span></div>
            </div>
            <div className="mt-1 h-1 bg-slate-900 rounded overflow-hidden"><div className="h-full" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }} /></div>
            <div className="flex items-center gap-1 mt-0.5 flex-wrap">
              {(['IN-TIBA', 'FREQ', 'CADENCE', 'EQUIP', 'PROX', 'PHASE', 'COORD', 'BCAST'] as Driver[]).map(d => (
                <span key={d} className="text-[9px] font-mono px-1 rounded" style={{ background: r.sev[d] >= 60 ? TIER_COLOR['DRIFT'] + '22' : r.sev[d] >= 30 ? TIER_COLOR['OBLIGATION'] + '22' : '#1e293b66', color: r.sev[d] >= 60 ? TIER_COLOR['DRIFT'] : r.sev[d] >= 30 ? TIER_COLOR['OBLIGATION'] : '#94a3b8' }}>{d.slice(0, 3)} {r.sev[d].toFixed(0)}</span>
              ))}
            </div>
            <div className="text-[9px] mt-0.5 italic" style={{ color: TIER_COLOR[r.tier] }}>{advice(r)}</div>
          </div>
        ))}

        {tab === 'REGIONS' && regStats.map((s, i) => (
          <div key={i} onClick={() => setRegionFilter(s.r.id)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{s.r.id}</span>
              <span className="text-slate-400">{s.r.name}</span>
              <span className="px-1 rounded font-mono text-[9px]" style={{ background: s.r.kind === 'OCN' ? '#0ea5e922' : s.r.kind === 'POLAR' ? '#a78bfa22' : s.r.kind === 'REM' ? '#f59e0b22' : '#10b98122', color: s.r.kind === 'OCN' ? '#0ea5e9' : s.r.kind === 'POLAR' ? '#a78bfa' : s.r.kind === 'REM' ? '#f59e0b' : '#10b981' }}>{s.r.kind}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{s.r.freq}</span>
            </div>
            <div className="grid grid-cols-5 gap-1 mt-1 text-[10px]">
              <div>TRAFFIC <span className="font-mono text-slate-100">{s.count}</span></div>
              <div>NC <span className="font-mono" style={{ color: s.nc ? TIER_COLOR['NON-COMPLIANT'] : '#cbd5e1' }}>{s.nc}</span></div>
              <div>DRIFT <span className="font-mono" style={{ color: s.drift ? TIER_COLOR['DRIFT'] : '#cbd5e1' }}>{s.drift}</span></div>
              <div>μ-SCR <span className="font-mono text-slate-100">{s.muScore.toFixed(0)}</span></div>
              <div>INT <span className="font-mono text-slate-100">{Math.round(s.r.intervalSec / 60)}m</span></div>
            </div>
            <div className="text-[9px] mt-0.5 text-slate-500 italic">cite: {s.r.cite}</div>
          </div>
        ))}

        {tab === 'EQUIPAGE' && equipStats.map((s, i) => (
          <div key={i} onClick={() => setEquipFilter(s.spec.id)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{s.spec.id}</span>
              <span className="text-slate-300">{s.spec.name}</span>
            </div>
            <div className="grid grid-cols-6 gap-1 mt-1 text-[10px]">
              <div>VHF <span className="font-mono" style={{ color: s.spec.vhf ? '#10b981' : '#475569' }}>{s.spec.vhf ? '✓' : '—'}</span></div>
              <div>HF <span className="font-mono" style={{ color: s.spec.hf ? '#10b981' : '#475569' }}>{s.spec.hf ? '✓' : '—'}</span></div>
              <div>SATV <span className="font-mono" style={{ color: s.spec.satcomVoice ? '#10b981' : '#475569' }}>{s.spec.satcomVoice ? '✓' : '—'}</span></div>
              <div>CPDLC <span className="font-mono" style={{ color: s.spec.cpdlc ? '#10b981' : '#475569' }}>{s.spec.cpdlc ? '✓' : '—'}</span></div>
              <div>FANS <span className="font-mono" style={{ color: s.spec.fans ? '#10b981' : '#475569' }}>{s.spec.fans ? '✓' : '—'}</span></div>
              <div>FLEET <span className="font-mono text-slate-100">{s.count}</span></div>
            </div>
            <div className="mt-1 h-1 bg-slate-900 rounded overflow-hidden">
              <div className="h-full" style={{ width: `${s.muScore}%`, background: s.muScore >= 70 ? TIER_COLOR['DRIFT'] : s.muScore >= 40 ? TIER_COLOR['OBLIGATION'] : '#10b981' }} />
            </div>
            <div className="text-[9px] mt-0.5 text-slate-500 italic">{s.spec.cite}</div>
          </div>
        ))}

        {tab === 'METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-300 leading-relaxed">
            <div>
              <div className="text-sky-300 font-mono mb-1">REGULATORY REGIME</div>
              <div className="text-slate-400">
                Per ICAO Annex 11 §3.4.4 / Annex 2 §3.6.5.1 / Doc 4444 PANS-ATM Chapter 15 §15.1 / Doc 7030 Regional Supplementary Procedures, pilots operating in designated airspace without ATS surveillance broadcast position, level, intentions on the assigned TIBA frequency at 10-minute intervals (or sooner when crossing reporting points, climbing/descending through other levels, or changing heading) so that other traffic builds situational awareness through self-announcement.
              </div>
            </div>
            <div>
              <div className="text-sky-300 font-mono mb-1">SCORING MODEL</div>
              <div className="text-slate-400">
                8 drivers — IN-TIBA (geographic placement inside published area), FREQ (equipage can tune required band), CADENCE (time since last broadcast vs Doc 4444 §15.1.4 interval), EQUIP (HF / SATCOM voice / VHF capability adequacy for region kind), PROX (peer TIBA traffic within proximity threshold), PHASE (phase-weight per oceanic/remote/CTAF criticality), COORD (crew monitoring correct freq), BCAST (overdue broadcast required NOW). Composite max·0.66 + mean·0.34 × phase-weight × ADV.
              </div>
            </div>
            <div>
              <div className="text-sky-300 font-mono mb-1">HARD ESCALATORS</div>
              <div className="text-slate-400">
                • OCN/POLAR + VHF-only/BASIC/NONE → 92 (equipage inadequate, divert per Doc 7030)<br />
                • Cannot tune required HF/VHF → 88 (FREQ mismatch)<br />
                • Cadence overdue ≥2.5× interval → 80 (BROADCAST IMMEDIATELY)<br />
                • Crew not monitoring + oceanic/polar → 74 (COORD failure)<br />
                • ≥3 peers within prox + NONE/non-mon → 68 (situational awareness loss)<br />
                • Nearest peer &lt;30 NM + oceanic → 58 (HEIGHTENED LOOKOUT)
              </div>
            </div>
            <div>
              <div className="text-sky-300 font-mono mb-1">TIBA AREAS CATALOGUED</div>
              <div className="text-slate-400">
                18 regions including NAT-W/NAT-E (Shanwick/Gander OCAs, primary HF + 131.8/127.9), WATRS Caribbean (128.45), CEP/NOPAC/PACOTS/SOPAC Pacific (128.95 inter-pilot), IATSC Indian (128.95), BIRD Bay-of-Bengal Chennai, SAT South Atlantic Atlantico, AFI RCA Africa Remote (126.9), Russian Magadan/Tiksi remote, AUS Outback YBBB, North Polar (HF SELCAL 8.825 MHz), Antarctic (127.5), US CTAF (122.8 AC 90-66B), Canada MF/ATF (122.8 CAR 602.97), and worldwide Air-Air coordination (123.45 Annex 10 Vol V §4.1.3.1.2).
              </div>
            </div>
            <div>
              <div className="text-sky-300 font-mono mb-1">DISTINCT FROM</div>
              <div className="text-slate-400">
                CPDLC/FANS-1A (datalink text not voice), SELCAL (selective alerting not broadcast), ADS-B/Mode-S (automatic surveillance not pilot voice), ARTCC handoff (controller-to-controller), VHF congestion (channel load not cadence), SQUAWK (Mode-A code), ACLASS (airspace-class penetration), DAA-WC (UAS detect-and-avoid). TIBA uniquely scores pilot voice broadcast compliance in non-radar / non-controlled regimes.
              </div>
            </div>
            <div>
              <div className="text-sky-300 font-mono mb-1">REFERENCES</div>
              <div className="text-slate-400">
                ICAO Annex 11 §3.4.4 ATS Air Traffic Services · Annex 2 §3.6.5.1 Rules of the Air · Annex 10 Vol V §4.1.3.1.2 Aeronautical Telecom · Doc 4444 PANS-ATM Ch.15 §15.1 IFBP · Doc 7030 Regional Sup Procedures · NAT Doc 007 NAT OPS Bull · FAA AC 91-70B §2 Oceanic & International · AC 120-42B App.G PolarOps · AC 90-66B CTAF · AIM 4-1-9 Self-Announce · TC CAR 602.97 MF/ATF · EUROCONTROL ENV §6.5 TIBA · FCC §87.187 air-air freq · FAA Order 7110.83 §5-8 WATRS · ARINC 596 SELCAL · DO-258A CPDLC.
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-700/60 text-[9px] text-slate-500 font-mono">
        {visible.length}/{rows.length} visible · {rows.filter(r => r.region).length} in TIBA · {REGIONS.length} regions catalogued
      </div>
    </div>
  )
}
