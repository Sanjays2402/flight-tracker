'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   ADIZ Penetration & Intercept-Risk Monitor
   -----------------------------------------------------------
   ICAO Annex 15 § 5.1 / FAA JO 7610.4 "Special Operations" /
   14 CFR 99 "Security Control of Air Traffic" / FAA AIM 5-6 /
   NORAD CONR/CANR ADIZ procedures / Japan MOD JADIZ NOTAM /
   Korea AIP ENR 5.2 KADIZ / Taipei FIR Q-Routes / PLA-AF ECS-ADIZ
   declaration 2013-11-23 / UK AIP ENR 2.2 / Russia FIRSec.

   An Air Defense Identification Zone is a buffer of airspace beyond
   sovereign 12-nm airspace where every entering aircraft must:
     1. File a flight plan (IFR or DVFR — Defense VFR)
     2. Maintain a discrete assigned Mode-S/Mode-3A transponder code
     3. Maintain two-way radio with the controlling agency
     4. Position-report inbound at the ADIZ boundary

   Non-compliance triggers QRA (Quick Reaction Alert) interceptors —
   typically F-15/F-16/F-35/Eurofighter/Su-30 — to visually identify
   the contact. Dispatchers MUST avoid accidental incursion of
   foreign ADIZs (cf. KAL 007, Ryanair FR4978, Cathay 853).

   We model a curated 24-ADIZ catalogue as bounding circles
   (centre lat/lng + radius nm). For every airborne aircraft we
   compute, per ADIZ:
     - signed proximity (nm inside = positive, outside = negative)
     - track-into prediction (closing rate to boundary at GS)
     - ETA-to-boundary minutes
   then composite-risk-score the worst single ADIZ exposure with:

     PROX     in-zone or within MARGIN-NM slider 0-100nm
     TRACK    track vector closing the boundary in <ETA-MIN slider
     SQUAWK   transponder code not a normal IFR code (1200, 7600,
              7700, 7500, 0000 — anomalous; or no Mode-S at all)
     FPL      per-airframe hash-stable filed-flight-plan probability
              by operator class (military FTR 0.95 / scheduled HNB-HWB
              0.97 / business BIZ 0.85 / general aviation GA 0.55)
              scaled by FPL-COVER slider
     COMM     two-way comm probability per region (oceanic/remote
              lower); HF/SATCOM fit by class

   Composite = max-driver with dominant labelling. Tiers:
     INCURSION  score ≥ 80  rose   inside boundary non-compliant – QRA likely
     INTERCEPT  score ≥ 55  amber  closing boundary <ETA – call ATC now
     WATCH      score ≥ 25  sky    inside ADIZ-bubble compliant – monitor
     OK         score < 25  emerald nominal
     IDLE       no ADIZ exposure – slate

   MapLibre overlay:
     - Tier-coloured halo rings sized by score 8-22 px
     - 36-segment amber dashed ADIZ boundary circle for each
       active-exposure ADIZ
     - Rose diamond pin at boundary intercept point for INCURSION
     - Tier-coloured callsign + ADIZ-code + ETA labels non-OK
     - 14-segment dashed projection track 80nm tier-coloured for
       INTERCEPT+INCURSION

   Side panel:
     - 5-tier counter strip click-to-filter (no IDLE chip)
     - 3-cell MEAN-PROX / WORST callsign+ADIZ / INCURSION-count
     - 2-cell INTERCEPT-count amber / ADIZ-active-count sky
     - SVG signed-prox-nm vs ETA-min scatter with rose-inside band
       + sky-MARGIN band + dashed boundary at prox=0 + ETA-MIN
       vertical
     - 5 sliders MIN-FL / MARGIN-NM / ETA-MIN / FPL-COVER / SQK-W
     - 8-class chip filter
     - HALO/RING/PIN/LBL/PROJ/DIAG toggles + search
     - AIRCRAFT / ZONES tab switcher

   Registered in Layers > Safety & Traffic. Persisted: ft-adiz
   ============================================================ */

export interface AdizFlight {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  category?: string
  squawk?: string
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
  flights: AdizFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'WATCH' | 'INTERCEPT' | 'INCURSION' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981',
  WATCH: '#0ea5e9',
  INTERCEPT: '#f59e0b',
  INCURSION: '#fb7185',
  IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['INCURSION', 'INTERCEPT', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { INCURSION: 0, INTERCEPT: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Klass = 'HWB' | 'HMB' | 'HNB' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const KL_NAME: Record<Klass, string> = {
  HWB: 'Heavy wide-body',
  HMB: 'Mid-twin',
  HNB: 'Narrow-body',
  RGN: 'Regional',
  BIZ: 'Business jet',
  TBP: 'Turboprop',
  GA: 'General aviation',
  FTR: 'Military / fighter',
}
const KL_FPL: Record<Klass, number> = { HWB: 0.98, HMB: 0.97, HNB: 0.97, RGN: 0.92, BIZ: 0.85, TBP: 0.70, GA: 0.55, FTR: 0.95 }
const KL_COMM: Record<Klass, number> = { HWB: 0.99, HMB: 0.97, HNB: 0.92, RGN: 0.85, BIZ: 0.95, TBP: 0.70, GA: 0.50, FTR: 0.99 }

function classify(t?: string, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x)) return 'GA'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS|TORN|A10|B1|B2|B52|KC|C17|C130|C5|E3|P8|P3|RC|U2)/.test(x)) return 'FTR'
  if (/^(B77|B78|A33|A34|A35|A38|B74|MD11|IL96)/.test(x)) return 'HWB'
  if (/^(B76|A30|A31[0-9]|IL62|DC10|L101)/.test(x)) return 'HMB'
  if (/^(A31|A32|A19|A20|A21|A22|B73|B72|B71|MD8|MD9|BCS|CS1|CS3)/.test(x)) return 'HNB'
  if (/^(CRJ|E14|E15|E17|E19|E29|E70|E75|AT4|AT5|AT7)/.test(x)) return 'RGN'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'BIZ'
  if (/^(DH8|Q40|SF34|J32|J41|ATR|TBM|PC12|TB|PC6|DHC|AN2|BE9|BE3|BE2)/.test(x)) return 'TBP'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|C20)/.test(x)) return 'GA'
  return 'HNB'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

// Great-circle distance nm
function gcNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function projectPosition(lat: number, lng: number, trackDeg: number, distNm: number) {
  const R = 3440.065
  const δ = distNm / R
  const θ = (trackDeg * Math.PI) / 180
  const φ1 = (lat * Math.PI) / 180
  const λ1 = (lng * Math.PI) / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return { lat: (φ2 * 180) / Math.PI, lng: (((λ2 * 180) / Math.PI + 540) % 360) - 180 }
}

interface Adiz { code: string; name: string; nation: string; lat: number; lng: number; radNm: number; agency: string }
const ADIZ_LIST: Adiz[] = [
  { code: 'USE', name: 'East Coast ADIZ',     nation: 'USA', lat: 38.0,  lng: -75.0,  radNm: 220, agency: 'NORAD CONR' },
  { code: 'USW', name: 'West Coast ADIZ',     nation: 'USA', lat: 37.0,  lng: -123.0, radNm: 200, agency: 'NORAD CONR' },
  { code: 'USG', name: 'Gulf of Mexico ADIZ', nation: 'USA', lat: 27.5,  lng: -90.0,  radNm: 260, agency: 'NORAD CONR' },
  { code: 'AKA', name: 'Alaska ADIZ',         nation: 'USA', lat: 60.0,  lng: -160.0, radNm: 380, agency: 'NORAD ANR' },
  { code: 'HWA', name: 'Hawaii ADIZ',         nation: 'USA', lat: 21.0,  lng: -158.0, radNm: 250, agency: 'PACAF / NORAD' },
  { code: 'CAN', name: 'Canada CADIZ',        nation: 'CAN', lat: 65.0,  lng: -100.0, radNm: 600, agency: 'NORAD CANR' },
  { code: 'MEX', name: 'Mexico ADIZ',         nation: 'MEX', lat: 23.0,  lng: -103.0, radNm: 280, agency: 'SEDENA' },
  { code: 'UKD', name: 'UK ADIZ',             nation: 'GBR', lat: 56.0,  lng: -3.0,   radNm: 280, agency: 'RAF QRA' },
  { code: 'NOR', name: 'Norwegian ADIZ',      nation: 'NOR', lat: 65.0,  lng: 14.0,   radNm: 320, agency: 'RNoAF' },
  { code: 'ISL', name: 'Iceland NEZ',         nation: 'ISL', lat: 64.5,  lng: -19.0,  radNm: 240, agency: 'NATO ICE' },
  { code: 'DNK', name: 'Denmark/Baltic ADIZ', nation: 'DNK', lat: 56.0,  lng: 11.5,   radNm: 200, agency: 'RDAF QRA' },
  { code: 'SWE', name: 'Sweden ADIZ',         nation: 'SWE', lat: 60.5,  lng: 16.0,   radNm: 260, agency: 'SwAF QRA' },
  { code: 'FIN', name: 'Finland border',      nation: 'FIN', lat: 64.0,  lng: 27.0,   radNm: 240, agency: 'FinAF QRA' },
  { code: 'POL', name: 'Poland east ADIZ',    nation: 'POL', lat: 52.5,  lng: 22.0,   radNm: 180, agency: 'PolAF QRA' },
  { code: 'RUW', name: 'Russia western FIRSec', nation: 'RUS', lat: 56.0, lng: 35.0,  radNm: 420, agency: 'VKS' },
  { code: 'RUE', name: 'Russia far-east FIRSec', nation: 'RUS', lat: 60.0, lng: 145.0, radNm: 420, agency: 'VKS' },
  { code: 'IND', name: 'India ADIZ',          nation: 'IND', lat: 22.0,  lng: 79.0,   radNm: 320, agency: 'IAF Air Cmd' },
  { code: 'PAK', name: 'Pakistan ADIZ',       nation: 'PAK', lat: 30.0,  lng: 70.0,   radNm: 220, agency: 'PAF QRA' },
  { code: 'JPN', name: 'JADIZ',               nation: 'JPN', lat: 36.0,  lng: 138.0,  radNm: 380, agency: 'JASDF QRA' },
  { code: 'KOR', name: 'KADIZ',               nation: 'KOR', lat: 36.5,  lng: 128.0,  radNm: 260, agency: 'ROKAF QRA' },
  { code: 'CHN', name: 'ECS-ADIZ',            nation: 'CHN', lat: 30.0,  lng: 124.0,  radNm: 280, agency: 'PLAAF ECTC' },
  { code: 'TWN', name: 'Taipei ADIZ',         nation: 'TWN', lat: 24.0,  lng: 121.0,  radNm: 180, agency: 'ROCAF QRA' },
  { code: 'PHL', name: 'Philippine ADIZ',     nation: 'PHL', lat: 13.0,  lng: 122.0,  radNm: 220, agency: 'PAF QRA' },
  { code: 'AUS', name: 'Australian ADIZ',     nation: 'AUS', lat: -25.0, lng: 134.0,  radNm: 420, agency: 'RAAF QRA' },
]

function isNormalIfrSquawk(sq?: string): { normal: boolean; flag?: string } {
  if (!sq) return { normal: false, flag: 'NO-XPDR' }
  const s = sq.trim()
  if (!/^\d{4}$/.test(s)) return { normal: false, flag: 'INVAL' }
  if (s === '7500') return { normal: false, flag: 'HIJACK' }
  if (s === '7600') return { normal: false, flag: 'NORDO' }
  if (s === '7700') return { normal: false, flag: 'EMER' }
  if (s === '1200' || s === '7000') return { normal: false, flag: 'VFR' }
  if (s === '0000') return { normal: false, flag: 'ANOM' }
  return { normal: true }
}

interface Row {
  f: AdizFlight
  klass: Klass
  flCur: number
  worst: Adiz | null
  proxNm: number           // signed: positive = inside boundary by N nm; negative = outside
  closingKts: number       // closing rate to boundary, kts (positive = closing)
  etaMin: number | null
  sqkFlag?: string
  sqkOk: boolean
  fplProb: number          // 0..1
  commProb: number         // 0..1
  driver: 'PROX' | 'TRACK' | 'SQUAWK' | 'FPL' | 'COMM' | 'NONE'
  severity: number
  tier: Tier
  // diag aux
  proxSev: number
  trackSev: number
  sqkSev: number
  fplSev: number
  commSev: number
}

function fmtSigned(v: number, suf = '') { return (v >= 0 ? '+' : '') + Math.round(v) + suf }

const SRC_HALO = 'adiz-halo', SRC_LBL = 'adiz-lbl', SRC_PIN = 'adiz-pin', SRC_PROJ = 'adiz-proj', SRC_RING = 'adiz-ring'
const LYR_HALO = 'adiz-halo-l', LYR_LBL = 'adiz-lbl-l', LYR_PIN = 'adiz-pin-l', LYR_PROJ = 'adiz-proj-l', LYR_RING = 'adiz-ring-l'

export default function AdizMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'ZONES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klFilter, setKlFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(50)
  const [marginNm, setMarginNm] = useState(40)        // 0..100
  const [etaMinSlider, setEtaMinSlider] = useState(15) // 2..40 min
  const [fplCover, setFplCover] = useState(100)        // 50..150 %
  const [sqkWeight, setSqkWeight] = useState(100)      // 50..150 %
  const [showHalo, setShowHalo] = useState(true)
  const [showRing, setShowRing] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl) continue
      const klass = classify(f.type, f.category)
      const h = hash32(f.icao || '')

      // Find the ADIZ with greatest exposure: smallest (centerDist - radNm) = most inside (or least outside)
      let worst: Adiz | null = null
      let bestProx = -Infinity
      for (const z of ADIZ_LIST) {
        const d = gcNm(f.lat, f.lng, z.lat, z.lng)
        const prox = z.radNm - d // positive = inside by N nm; negative = outside
        if (prox > bestProx) { bestProx = prox; worst = z }
      }

      // Only consider aircraft within MARGIN of a boundary (inside or close outside)
      if (!worst || bestProx < -marginNm) {
        out.push({ f, klass, flCur, worst: null, proxNm: bestProx, closingKts: 0, etaMin: null,
                   sqkOk: true, fplProb: 1, commProb: 1, driver: 'NONE', severity: 0, tier: 'IDLE',
                   proxSev: 0, trackSev: 0, sqkSev: 0, fplSev: 0, commSev: 0 })
        continue
      }

      // Closing rate to boundary: project 1 minute ahead, recompute prox, derivative
      const gs = f.velocityKts || 0
      const p1 = projectPosition(f.lat, f.lng, f.track || 0, gs / 60)
      const d1 = gcNm(p1.lat, p1.lng, worst.lat, worst.lng)
      const prox1 = worst.radNm - d1
      const dProxPerMin = prox1 - bestProx // nm/min, positive = penetrating deeper
      const closingKts = dProxPerMin * 60

      // ETA to the boundary itself: from outside crossing-in OR inside crossing-out
      let etaMin: number | null = null
      if (bestProx < 0 && dProxPerMin > 0.05) etaMin = -bestProx / dProxPerMin // crossing in
      else if (bestProx > 0 && dProxPerMin < -0.05) etaMin = bestProx / -dProxPerMin // crossing out

      // Squawk check
      const sq = isNormalIfrSquawk(f.squawk)
      const sqkOk = sq.normal
      const sqkBase = sqkOk ? 0 : (sq.flag === 'HIJACK' || sq.flag === 'EMER' ? 100 : sq.flag === 'NORDO' ? 85 : sq.flag === 'VFR' || sq.flag === 'NO-XPDR' ? 60 : 70)
      const sqkSev = Math.min(100, sqkBase * (sqkWeight / 100))

      // FPL probability — hash-stable per airframe with class base
      const fplBase = KL_FPL[klass]
      const fplNoise = ((h % 1000) / 1000) * 0.20 - 0.10
      const fplProb = Math.max(0, Math.min(1, fplBase + fplNoise * (fplCover / 100)))
      const fplSev = (1 - fplProb) * 100

      // Comm probability
      const commBase = KL_COMM[klass]
      const commProb = Math.max(0, Math.min(1, commBase + (((h >>> 11) % 1000) / 1000) * 0.10 - 0.05))
      const commSev = (1 - commProb) * 100

      // Proximity severity: 0 outside MARGIN; ramps from 50 at boundary to 100 at +30 nm inside
      let proxSev = 0
      if (bestProx >= 0) proxSev = Math.min(100, 50 + bestProx * 1.7)
      else proxSev = Math.max(0, 50 + bestProx * 1.5) // close outside boundary

      // Track severity: closing to boundary in <ETA-MIN window
      let trackSev = 0
      if (etaMin !== null && bestProx < 0 && etaMin < etaMinSlider) {
        trackSev = (1 - etaMin / etaMinSlider) * 90
      } else if (bestProx >= 0 && closingKts > 0) {
        trackSev = Math.min(80, 30 + closingKts / 15)
      }

      // Composite (max-driver)
      type Driver = 'PROX' | 'TRACK' | 'SQUAWK' | 'FPL' | 'COMM'
      const drivers: [Driver, number][] = [
        ['PROX', proxSev], ['TRACK', trackSev], ['SQUAWK', sqkSev], ['FPL', fplSev], ['COMM', commSev],
      ]
      drivers.sort((a, b) => b[1] - a[1])
      const driver = drivers[0][0]
      const severity = Math.max(0, Math.min(100, drivers[0][1]))

      // Tier — only INCURSION if inside AND any of the compliance gates fail
      let tier: Tier
      if (bestProx >= 0 && (!sqkOk || fplProb < 0.5)) tier = 'INCURSION'
      else if (severity >= 80) tier = 'INCURSION'
      else if (severity >= 55) tier = 'INTERCEPT'
      else if (severity >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({ f, klass, flCur, worst, proxNm: bestProx, closingKts, etaMin,
                 sqkFlag: sq.flag, sqkOk, fplProb, commProb, driver, severity, tier,
                 proxSev, trackSev, sqkSev, fplSev, commSev })
    }
    return out
  }, [flights, minFl, marginNm, etaMinSlider, fplCover, sqkWeight])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, WATCH: 0, INTERCEPT: 0, INCURSION: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumProx = 0, n = 0
    let worstSev = -1, worstCs = '', worstAdiz = ''
    let incursion = 0, intercept = 0
    const activeZones = new Set<string>()
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      n++
      sumProx += r.proxNm
      if (r.tier === 'INCURSION') incursion++
      if (r.tier === 'INTERCEPT') intercept++
      if (r.worst) activeZones.add(r.worst.code)
      if (r.severity > worstSev) { worstSev = r.severity; worstCs = (r.f.callsign || r.f.icao).trim(); worstAdiz = r.worst?.code || '' }
    }
    return { meanProx: n ? sumProx / n : 0, worstCs, worstAdiz, incursion, intercept, active: n, activeZones: activeZones.size }
  }, [rows])

  const zoneAggs = useMemo(() => {
    const m = new Map<string, { z: Adiz; count: number; sumProx: number; worstSev: number; worstCs: string; worstIcao: string; worstTier: Tier; incursion: number }>()
    for (const r of rows) {
      if (!r.worst || r.tier === 'IDLE') continue
      let a = m.get(r.worst.code)
      if (!a) { a = { z: r.worst, count: 0, sumProx: 0, worstSev: -1, worstCs: '', worstIcao: '', worstTier: 'OK', incursion: 0 }; m.set(r.worst.code, a) }
      a.count++
      a.sumProx += r.proxNm
      if (r.tier === 'INCURSION') a.incursion++
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.severity > a.worstSev) { a.worstSev = r.severity; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
    }
    const arr = Array.from(m.values()).map(a => ({ ...a, meanProx: a.count ? a.sumProx / a.count : 0 }))
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
        if (r.tier === 'IDLE' && tierFilter === 'ALL') return false
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (klFilter !== 'ALL' && r.klass !== klFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.klass, r.worst?.code, r.worst?.nation].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.severity - a.severity
      })
  }, [rows, tierFilter, klFilter, query])

  const filteredZones = useMemo(() => {
    const q = query.trim().toUpperCase()
    return zoneAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (!q) return true
      return (a.z.code + ' ' + a.z.name + ' ' + a.z.nation + ' ' + a.z.agency).toUpperCase().includes(q)
    })
  }, [zoneAggs, tierFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const activeZoneSet = new Set<string>()
    for (const r of rows) if (r.tier !== 'IDLE' && r.tier !== 'OK' && r.worst) activeZoneSet.add(r.worst.code)

    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.severity / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'INTERCEPT' || r.tier === 'INCURSION').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} › ${r.worst?.code || '—'}${r.etaMin !== null && r.etaMin < 60 ? ` ETA ${r.etaMin.toFixed(0)}m` : ''}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'INCURSION' && r.worst).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${r.worst!.code} INCURSION ${r.worst!.agency}` },
      geometry: { type: 'Point' as const, coordinates: [r.worst!.lng, r.worst!.lat] },
    })) : [] }

    const ringFeatures: any[] = []
    if (showRing) {
      for (const z of ADIZ_LIST) {
        if (!activeZoneSet.has(z.code)) continue
        const coords: [number, number][] = []
        for (let i = 0; i <= 36; i++) {
          const p = projectPosition(z.lat, z.lng, (i * 360) / 36, z.radNm)
          coords.push([p.lng, p.lat])
        }
        ringFeatures.push({ type: 'Feature' as const, properties: { color: '#f59e0b', code: z.code }, geometry: { type: 'LineString' as const, coordinates: coords } })
      }
    }
    const ringFc = { type: 'FeatureCollection' as const, features: ringFeatures }

    const projFeatures: any[] = []
    if (showProj) {
      for (const r of rows) {
        if (r.tier !== 'INTERCEPT' && r.tier !== 'INCURSION') continue
        const coords: [number, number][] = []
        for (let i = 0; i <= 14; i++) {
          const p = projectPosition(r.f.lat, r.f.lng, r.f.track || 0, (80 * i) / 14)
          coords.push([p.lng, p.lat])
        }
        projFeatures.push({ type: 'Feature' as const, properties: { color: TIER_COLOR[r.tier] }, geometry: { type: 'LineString' as const, coordinates: coords } })
      }
    }
    const projFc = { type: 'FeatureCollection' as const, features: projFeatures }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'line', source: SRC_RING, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [3, 3],
      } }))
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.75, 'line-dasharray': [2, 3],
      } }))
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['get', 'text'], 'text-size': 10,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-offset': [0, -1.6], 'text-anchor': 'bottom', 'icon-allow-overlap': true,
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.6 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_RING]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_PROJ, SRC_RING]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showProj, showRing])

  // Diagram: signed prox-nm (x, -100..+100) vs ETA-min (y, 0..40)
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 30
    const xMin = -100, xMax = 100, yMax = 40
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">ADIZ Penetration Monitor</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.active} exposed · {summary.activeZones} zone</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800">
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean prox</div>
          <div className="font-mono text-sm" style={{ color: summary.meanProx > 0 ? '#fb7185' : summary.meanProx > -20 ? '#f59e0b' : '#10b981' }}>{fmtSigned(summary.meanProx)}<span className="text-[9px] text-slate-500"> nm</span></div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={`${summary.worstCs} ${summary.worstAdiz}`}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstAdiz}` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Incursion</div>
          <div className="font-mono text-sm" style={{ color: summary.incursion > 0 ? '#fb7185' : '#10b981' }}>{summary.incursion}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Intercept</div>
          <div className="font-mono text-[11px]" style={{ color: summary.intercept > 0 ? '#f59e0b' : '#10b981' }}>{summary.intercept}</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Zones active</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.activeZones}<span className="text-[9px] text-slate-500"> / {ADIZ_LIST.length}</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Prox(nm) signed vs ETA-min to boundary</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* INSIDE band (x>0) shaded rose */}
            <rect x={diag.xs(0)} y={6} width={diag.W - 6 - diag.xs(0)} height={diag.H - diag.PAD - 6} fill="#fb7185" opacity={0.08} />
            {/* MARGIN band (-MARGIN..0) shaded sky */}
            <rect x={diag.xs(-marginNm)} y={6} width={diag.xs(0) - diag.xs(-marginNm)} height={diag.H - diag.PAD - 6} fill="#0ea5e9" opacity={0.08} />
            {/* Boundary vertical */}
            <line x1={diag.xs(0)} y1={6} x2={diag.xs(0)} y2={diag.H - diag.PAD} stroke="#fb7185" strokeWidth={1} strokeDasharray="3 2" />
            <text x={diag.xs(0) + 3} y={14} fontSize={8} fill="#fb7185" fontFamily="monospace">BNDRY</text>
            {/* ETA-MIN horizontal */}
            <line x1={diag.PAD} y1={diag.ys(etaMinSlider)} x2={diag.W - 6} y2={diag.ys(etaMinSlider)} stroke="#f59e0b" strokeWidth={0.9} strokeDasharray="3 2" />
            <text x={diag.W - 8} y={diag.ys(etaMinSlider) - 2} textAnchor="end" fontSize={7} fill="#f59e0b" fontFamily="monospace">ETA {etaMinSlider}m</text>
            {/* x ticks */}
            {[-80, -40, 0, 40, 80].map(x => (
              <g key={x}>
                <line x1={diag.xs(x)} y1={6} x2={diag.xs(x)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(x)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{x}</text>
              </g>
            ))}
            {/* y ticks */}
            {[10, 20, 30].map(y => (
              <g key={y}>
                <line x1={diag.PAD} y1={diag.ys(y)} x2={diag.W - 6} y2={diag.ys(y)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(y) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{y}m</text>
              </g>
            ))}
            {rows.filter(r => r.tier !== 'IDLE').map(r => {
              const x = diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, r.proxNm)))
              const yVal = r.etaMin !== null ? Math.min(diag.yMax, r.etaMin) : diag.yMax
              const y = diag.ys(yVal)
              return <circle key={r.f.icao} cx={x} cy={y} r={3} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            })}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MARGIN</span><span className="font-mono text-slate-300">{marginNm}nm</span></div>
            <input type="range" min={0} max={100} step={5} value={marginNm} onChange={e => setMarginNm(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>ETA-MIN</span><span className="font-mono text-slate-300">{etaMinSlider}m</span></div>
            <input type="range" min={2} max={40} step={1} value={etaMinSlider} onChange={e => setEtaMinSlider(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>FPL-COVER</span><span className="font-mono text-slate-300">{fplCover}%</span></div>
            <input type="range" min={50} max={150} step={5} value={fplCover} onChange={e => setFplCover(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div className="col-span-2">
            <div className="flex justify-between text-[10px] text-slate-500"><span>SQK-WEIGHT</span><span className="font-mono text-slate-300">{sqkWeight}%</span></div>
            <input type="range" min={50} max={150} step={5} value={sqkWeight} onChange={e => setSqkWeight(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['HWB', 'HMB', 'HNB', 'RGN', 'BIZ', 'TBP', 'GA', 'FTR'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlFilter(klFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRing} onChange={e => setShowRing(e.target.checked)} className="accent-sky-500" /><span>RING</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / zone / nation"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'ZONES'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${summary.active} active` : `${filteredZones.length} shown / ${zoneAggs.length} zones`}</span>
        <span>{tab === 'AIRCRAFT' ? 'prox-nm · ETA · driver · tier' : 'zone · ac · mean-prox · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft within ADIZ exposure.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const sevPct = Math.max(0, Math.min(100, r.severity))
          const advice = r.tier === 'INCURSION'
            ? `inside ${r.worst?.code} · ${r.sqkOk ? '' : 'non-IFR squawk · '}${r.worst?.agency} QRA risk`
            : r.tier === 'INTERCEPT'
              ? `closing ${r.worst?.code} ETA ${r.etaMin !== null ? r.etaMin.toFixed(0) : '—'}m · contact ${r.worst?.agency} now`
              : r.tier === 'WATCH'
                ? `within ${r.worst?.code} buffer · compliant · monitor`
                : `outside ADIZ envelope · nominal`
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
                  <span title="flight level">F{Math.round(r.flCur)}</span>
                  <span title="ADIZ code">{r.worst?.code || '—'}</span>
                  <span title="signed proximity to boundary (nm), positive inside" style={{ color: r.proxNm >= 0 ? TIER_COLOR[r.tier] : '#94a3b8' }}>{fmtSigned(r.proxNm)} nm</span>
                  <span title="ETA to boundary">{r.etaMin !== null && r.etaMin < 99 ? `${r.etaMin.toFixed(0)}m` : '—'}</span>
                  <span className="ml-auto" title="dominant risk driver" style={{ color: TIER_COLOR[r.tier] }}>{r.driver}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`composite ADIZ risk score`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${sevPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `25%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `55%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `80%` }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60" style={{ color: r.proxSev > 50 ? TIER_COLOR[r.tier] : '#94a3b8' }} title="proximity severity">PRX {r.proxSev.toFixed(0)}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60" style={{ color: r.trackSev > 50 ? TIER_COLOR[r.tier] : '#94a3b8' }} title="track-closing severity">TRK {r.trackSev.toFixed(0)}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono"
                    style={{ borderColor: r.sqkOk ? '#33415566' : '#fb718566', color: r.sqkOk ? '#94a3b8' : '#fb7185', background: r.sqkOk ? '#0f172a' : '#fb718514' }}
                    title="transponder code">SQ {r.f.squawk || '----'}{r.sqkFlag ? ' ' + r.sqkFlag : ''}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60" style={{ color: r.fplProb < 0.7 ? '#f59e0b' : '#94a3b8' }} title="flight-plan probability">FPL {(r.fplProb * 100).toFixed(0)}%</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60" style={{ color: r.commProb < 0.7 ? '#f59e0b' : '#94a3b8' }} title="two-way comm probability">CMM {(r.commProb * 100).toFixed(0)}%</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="closing rate to boundary">{fmtSigned(r.closingKts)} kt</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'ZONES' && filteredZones.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No ADIZ has active exposure.</div>
        )}
        {tab === 'ZONES' && filteredZones.map(a => {
          const sevPct = Math.max(0, Math.min(100, a.worstSev))
          const advice = a.worstTier === 'INCURSION' ? `${a.incursion} non-compliant inside · ${a.z.agency} QRA likely`
            : a.worstTier === 'INTERCEPT' ? `closing penetrations · brief crews on ${a.z.code} reporting`
              : a.worstTier === 'WATCH' ? `compliant transits inside ${a.z.code}`
                : `${a.z.code} envelope nominal`
          return (
            <button key={a.z.code} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.z.code}</span>
                  <span className="text-slate-500 text-[10px] truncate">{a.z.name}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="nation">{a.z.nation}</span>
                  <span title="mean signed prox" style={{ color: a.meanProx >= 0 ? TIER_COLOR[a.worstTier] : '#94a3b8' }}>mean {fmtSigned(a.meanProx)}nm</span>
                  <span title="incursion count" style={{ color: a.incursion > 0 ? '#fb7185' : '#94a3b8' }}>INC {a.incursion}</span>
                  <span className="ml-auto truncate">{a.worstCs || '—'}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`zone-worst score`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${sevPct}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `25%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `55%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `80%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate" title="controlling agency · radius">{a.z.agency} · r {a.z.radNm}nm</span>
                  <span className="ml-auto truncate" style={{ color: a.worstTier === 'OK' ? '#64748b' : TIER_COLOR[a.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        ICAO Annex 15 · FAA JO 7610.4 · 14 CFR 99 · FAA AIM 5-6 · NORAD CONR/CANR/ANR · MOD JADIZ · MND KADIZ · PLAAF ECTC
      </div>
    </div>
  )
}
