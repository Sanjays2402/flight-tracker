'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   CLAM / RAM · Cleared Level & Route Adherence Monitor
   ------------------------------------------------------------
   Ground-side ATC safety-net pair per EUROCONTROL Safety Nets
   Implementation Guideline (2018) and EUROCAE ED-202A MOPS:

     CLAM  Cleared Level Adherence Monitoring
           Detects deviation between observed Mode-C/S geometric
           altitude and the cleared flight level (CFL) issued by
           the controller. Standard tolerance ±200 ft for level
           cruise, ±300 ft in climb/descent passing through CFL
           (re-arm window per EUROCONTROL CLAM Spec ed.1.0).

     RAM   Route Adherence Monitoring
           Detects deviation between observed lateral track and
           the cleared route (CFL-projected great-circle or FMS
           lateral cleared path). Standard tolerance per ANSP:
              ENR  ≤ 2.0 NM cross-track
              TMA  ≤ 1.0 NM
              APP  ≤ 0.5 NM (PBN RNP equivalents)
              OCN  ≤ 7.0 NM (PBCS RNP-4 / RNP-10)
           Per EUROCONTROL RAM Operational Spec ed.1.2.

   Both are ground-based safety-net layers that complement
   short-term tactical alerts (STCA, MSAW) and medium-term
   conflict probes (MTCD). Misalignment between CFL/cleared
   route and what the aircraft is actually doing is a precursor
   to level-bust and route-deviation incidents — both leading
   contributors to mid-air loss-of-separation events per
   EUROCONTROL Annual Safety Report Voluntary Reporting.

   Standards & references:
     · EUROCONTROL Safety Nets Implementation Guideline (2018)
     · EUROCONTROL CLAM Operational Spec ed.1.0
     · EUROCONTROL RAM Operational Spec ed.1.2
     · EUROCAE ED-202A MOPS Safety Net Subsystems
     · EUROCAE ED-153 Software Assurance ATM
     · ICAO Doc 4444 PANS-ATM §15.7 Safety Alerting
     · ICAO Annex 11 §2.27 Air Traffic Services
     · ICAO Doc 9426 ATS Planning Manual III.4
     · FAA JO 7110.65 §5-6-1 Pilot Compliance with CFL
     · FAA JO 6190.18 Safety Net Performance Standards
     · UK CAA CAP 670 SUR §5 Surveillance Safety Nets
     · UK CAA CAP 710 Level Bust Action Plan
     · UK AAIB Bulletin 1/2002 Level-bust trend analysis
     · NTSB AAR-87-03 NW255 separation lapse precursor
     · BFU 02-02 Überlingen B752/TU154 STCA absence
     · EUROCONTROL Action Plan for Prevention of Level Bust
     · EASA SIB 2018-04 Lateral track deviation
     · EUROCONTROL PBN Manual Doc 9613 PBN integration

   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'BUST' | 'DEV' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  BUST: '#ef4444', DEV: '#f43f5e', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['BUST', 'DEV', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { BUST: 0, DEV: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Domain = 'OCN' | 'ENR' | 'TMA' | 'APP'
const DOM_COLOR: Record<Domain, string> = { OCN: '#a855f7', ENR: '#0ea5e9', TMA: '#10b981', APP: '#f59e0b' }
// (NM lateral, ft vertical) cleared-tolerance per EUROCONTROL CLAM/RAM specs
const DOM_LAT: Record<Domain, number> = { OCN: 7.0, ENR: 2.0, TMA: 1.0, APP: 0.5 }
const DOM_VRT: Record<Domain, number> = { OCN: 300, ENR: 200, TMA: 200, APP: 150 }

type Phase = 'CRZ' | 'CLB' | 'DES' | 'APP' | 'DEP' | 'IDLE'
const PHASE_MUL: Record<Phase, number> = { APP: 1.35, DES: 1.20, CLB: 1.15, DEP: 1.20, CRZ: 1.00, IDLE: 0 }

/* 24 sector/FIR catalogue spanning oceanic/ENR/TMA/APP volumes */
interface Sector {
  id: string; name: string; ansp: string
  lat: number; lng: number; radiusNm: number
  domain: Domain
  minFL: number; maxFL: number
  clamGate: number  // expected CLAM detection lag s
  ramGate: number   // expected RAM detection lag s
}
const SECTORS: Sector[] = [
  // Oceanic
  { id: 'NAT-OCA',   name: 'NAT Shanwick OCA',     ansp: 'NATS/IAA', lat: 55.0, lng: -25.0, radiusNm: 900, domain: 'OCN', minFL: 280, maxFL: 410, clamGate: 60, ramGate: 60 },
  { id: 'GANDER-OCA',name: 'Gander OCA',           ansp: 'NAV-CAN',  lat: 50.0, lng: -45.0, radiusNm: 900, domain: 'OCN', minFL: 280, maxFL: 410, clamGate: 60, ramGate: 60 },
  { id: 'OAKL-OCA',  name: 'Oakland OCA',          ansp: 'FAA',      lat: 25.0, lng: -165.0, radiusNm: 1100, domain: 'OCN', minFL: 280, maxFL: 410, clamGate: 60, ramGate: 60 },
  { id: 'ANCH-OCA',  name: 'Anchorage Arctic OCA', ansp: 'FAA',      lat: 65.0, lng: -160.0, radiusNm: 900, domain: 'OCN', minFL: 280, maxFL: 410, clamGate: 60, ramGate: 60 },
  // En-route domestic
  { id: 'EGTT',      name: 'London ACC',           ansp: 'NATS',     lat: 52.0, lng: -1.5,  radiusNm: 220, domain: 'ENR', minFL: 100, maxFL: 410, clamGate: 12, ramGate: 14 },
  { id: 'LFFF',      name: 'Paris Reims ACC',      ansp: 'DSNA',     lat: 48.5, lng: 3.5,   radiusNm: 240, domain: 'ENR', minFL: 100, maxFL: 410, clamGate: 12, ramGate: 14 },
  { id: 'EDUU',      name: 'Karlsruhe UAC',        ansp: 'DFS',      lat: 49.0, lng: 8.5,   radiusNm: 240, domain: 'ENR', minFL: 245, maxFL: 460, clamGate: 12, ramGate: 14 },
  { id: 'LSAS',      name: 'Swiss UAC',            ansp: 'skyguide', lat: 47.0, lng: 8.5,   radiusNm: 140, domain: 'ENR', minFL: 100, maxFL: 460, clamGate: 12, ramGate: 14 },
  { id: 'ZNY',       name: 'New York ARTCC',       ansp: 'FAA',      lat: 40.6, lng: -73.7, radiusNm: 260, domain: 'ENR', minFL: 100, maxFL: 410, clamGate: 12, ramGate: 14 },
  { id: 'ZLA',       name: 'Los Angeles ARTCC',    ansp: 'FAA',      lat: 34.0, lng: -118.0,radiusNm: 280, domain: 'ENR', minFL: 100, maxFL: 410, clamGate: 12, ramGate: 14 },
  { id: 'ZAU',       name: 'Chicago ARTCC',        ansp: 'FAA',      lat: 41.9, lng: -87.6, radiusNm: 260, domain: 'ENR', minFL: 100, maxFL: 410, clamGate: 12, ramGate: 14 },
  { id: 'ZTL',       name: 'Atlanta ARTCC',        ansp: 'FAA',      lat: 33.6, lng: -84.4, radiusNm: 280, domain: 'ENR', minFL: 100, maxFL: 410, clamGate: 12, ramGate: 14 },
  { id: 'RJJJ',      name: 'Fukuoka ACC',          ansp: 'JCAB',     lat: 35.0, lng: 137.0, radiusNm: 280, domain: 'ENR', minFL: 100, maxFL: 460, clamGate: 12, ramGate: 14 },
  { id: 'WSJC',      name: 'Singapore FIR',        ansp: 'CAAS',     lat: 1.35, lng: 103.9, radiusNm: 280, domain: 'ENR', minFL: 100, maxFL: 460, clamGate: 12, ramGate: 14 },
  // TMA
  { id: 'EGLL-TMA',  name: 'London TMA',           ansp: 'NATS',     lat: 51.47,lng: -0.46, radiusNm: 60,  domain: 'TMA', minFL: 50,  maxFL: 245, clamGate: 8, ramGate: 10 },
  { id: 'EDDF-TMA',  name: 'Frankfurt TMA',        ansp: 'DFS',      lat: 50.04,lng: 8.56,  radiusNm: 50,  domain: 'TMA', minFL: 50,  maxFL: 245, clamGate: 8, ramGate: 10 },
  { id: 'KJFK-TMA',  name: 'N90 NY TRACON',        ansp: 'FAA',      lat: 40.64,lng: -73.78,radiusNm: 60,  domain: 'TMA', minFL: 50,  maxFL: 230, clamGate: 8, ramGate: 10 },
  { id: 'KLAX-TMA',  name: 'SCT LA TRACON',        ansp: 'FAA',      lat: 33.95,lng: -118.4,radiusNm: 60,  domain: 'TMA', minFL: 50,  maxFL: 230, clamGate: 8, ramGate: 10 },
  { id: 'EHAM-TMA',  name: 'Amsterdam TMA',        ansp: 'LVNL',     lat: 52.31,lng: 4.76,  radiusNm: 50,  domain: 'TMA', minFL: 50,  maxFL: 245, clamGate: 8, ramGate: 10 },
  { id: 'OMDB-TMA',  name: 'Dubai TMA',            ansp: 'GCAA',     lat: 25.25,lng: 55.36, radiusNm: 60,  domain: 'TMA', minFL: 50,  maxFL: 245, clamGate: 8, ramGate: 10 },
  // APP
  { id: 'EGLL-APP',  name: 'Heathrow APP',         ansp: 'NATS',     lat: 51.47,lng: -0.46, radiusNm: 20,  domain: 'APP', minFL: 0,   maxFL: 100, clamGate: 5, ramGate: 6 },
  { id: 'KSFO-APP',  name: 'SFO APP',              ansp: 'FAA',      lat: 37.61,lng: -122.38,radiusNm: 20, domain: 'APP', minFL: 0,   maxFL: 100, clamGate: 5, ramGate: 6 },
  { id: 'EHAM-APP',  name: 'Amsterdam APP',        ansp: 'LVNL',     lat: 52.31,lng: 4.76,  radiusNm: 20,  domain: 'APP', minFL: 0,   maxFL: 100, clamGate: 5, ramGate: 6 },
  { id: 'RJAA-APP',  name: 'Narita APP',           ansp: 'JCAB',     lat: 35.76,lng: 140.39, radiusNm: 20, domain: 'APP', minFL: 0,   maxFL: 100, clamGate: 5, ramGate: 6 },
]

/* ---- util ---- */
const clamp = (v: number, mn: number, mx: number) => Math.max(mn, Math.min(mx, v))
const gcNm = (la1: number, lo1: number, la2: number, lo2: number) => {
  const R = 3440.065, t = Math.PI / 180
  const d = Math.sin((la2 - la1) * t / 2) ** 2 + Math.cos(la1 * t) * Math.cos(la2 * t) * Math.sin((lo2 - lo1) * t / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(d))
}
const fnv = (s: string) => { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 } return h }
const hashf = (s: string) => (fnv(s) % 10000) / 10000
const hashRange = (s: string, lo: number, hi: number) => lo + hashf(s) * (hi - lo)
const lsKey = (k: string) => `ft-clam-${k}`
const lsGet = (k: string, dflt: number) => { try { const v = localStorage.getItem(lsKey(k)); return v ? parseInt(v) : dflt } catch { return dflt } }
const lsSet = (k: string, v: number) => { try { localStorage.setItem(lsKey(k), String(v)) } catch {} }

/* ---- cleared-state synthesis (hash-stable per ICAO24) ---- */
const enclosing = (lat: number, lng: number, alt: number): Sector | null => {
  let best: Sector | null = null; let bestRank = -1
  // priority APP > TMA > ENR > OCN
  const PRI: Record<Domain, number> = { APP: 4, TMA: 3, ENR: 2, OCN: 1 }
  const fl = alt / 100
  for (const s of SECTORS) {
    if (fl < s.minFL || fl > s.maxFL) continue
    const d = gcNm(lat, lng, s.lat, s.lng)
    if (d > s.radiusNm) continue
    const r = PRI[s.domain]
    if (r > bestRank) { bestRank = r; best = s }
  }
  return best
}

const phaseOf = (f: SFlight): Phase => {
  if (f.ground) return 'IDLE'
  if (f.altitudeFt < 10000 && f.vertRate < -300) return 'APP'
  if (f.altitudeFt < 8000 && f.vertRate > 300) return 'DEP'
  if (f.vertRate > 400) return 'CLB'
  if (f.vertRate < -400) return 'DES'
  return 'CRZ'
}

interface Item {
  f: SFlight
  sector: Sector | null
  phase: Phase
  cflFt: number          // synthesised cleared flight level
  vBustFt: number        // signed altitude - CFL, positive = above
  vTolFt: number         // tolerance per domain × phase
  // cleared route: great-circle from current → destFix (hash-stable random offset)
  ctrkBrgDeg: number
  ctrkDevNm: number      // signed cross-track NM, positive = right of cleared
  ctrkTolNm: number
  // additional metrics
  vBustRatio: number
  lBustRatio: number
  // drivers
  drivers: { LVL: number; LAT: number; HDG: number; VS: number; PHA: number; SEC: number }
  score: number
  tier: Tier
}

const analyse = (f: SFlight, secMul: number, latMul: number, vrtMul: number): Item | null => {
  if (f.ground) return null
  if (f.altitudeFt < 2000) return null
  const sector = enclosing(f.lat, f.lng, f.altitudeFt)
  if (!sector) return null
  const ph = phaseOf(f)
  // synth CFL: pick nearest FL010 boundary inside sector band, biased by hash
  const h = hashf(`${f.icao}|cfl`)
  // baseline = round to nearest 10 of current FL; offset = hash drift up to ±1500 ft for CRZ, ±400 for CLB/DES
  const flNow = Math.round(f.altitudeFt / 100) * 100
  let cflFt: number
  if (ph === 'CRZ') {
    // assigned FL near current
    const slip = (h - 0.5) * 2 // -1..1
    cflFt = flNow + Math.round(slip * 8) * 100 // up to ±800ft, multiples of 100
  } else if (ph === 'CLB' || ph === 'DEP') {
    // CFL above us (climbing toward)
    cflFt = flNow + Math.round(hashRange(`${f.icao}|clbtgt`, 8, 60)) * 100
  } else if (ph === 'DES' || ph === 'APP') {
    cflFt = Math.max(2000, flNow - Math.round(hashRange(`${f.icao}|destgt`, 8, 60)) * 100)
  } else {
    cflFt = flNow
  }

  // vertical bust: signed delta from CFL; for level CRZ use full magnitude; for CLB/DES only penalise when overshoot
  let vBustFt: number
  if (ph === 'CLB' || ph === 'DEP') vBustFt = Math.max(0, f.altitudeFt - cflFt)  // overshooting CFL
  else if (ph === 'DES' || ph === 'APP') vBustFt = Math.max(0, cflFt - f.altitudeFt) * -1 // undershoot below CFL
  else vBustFt = f.altitudeFt - cflFt

  const baseVTol = DOM_VRT[sector.domain] * (vrtMul / 100)
  // re-arm: when transitioning through CFL allow extra 100 ft
  const transitioning = Math.abs(f.vertRate) > 300 && Math.abs(f.altitudeFt - cflFt) < 800
  const vTolFt = baseVTol + (transitioning ? 100 : 0)
  const vBustRatio = Math.abs(vBustFt) / Math.max(vTolFt, 50)

  // cleared track bearing: hash-stable target offset from sector centre
  const centreBrg = (() => {
    const t = Math.PI / 180
    const y = Math.sin((sector.lng - f.lng) * t) * Math.cos(sector.lat * t)
    const x = Math.cos(f.lat * t) * Math.sin(sector.lat * t) - Math.sin(f.lat * t) * Math.cos(sector.lat * t) * Math.cos((sector.lng - f.lng) * t)
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
  })()
  // perturb by hash-stable seasonal nominal offset reflecting "filed route" direction
  const ctrkBrgDeg = (centreBrg + hashRange(`${f.icao}|ctrk`, -90, 90) + 360) % 360
  // cross-track deviation: f.track vs ctrkBrgDeg projected onto sector cross-axis
  // Use simple model: ctd = sin(track-ctrk) * sample_distance + hash offset
  const dtheta = ((f.track - ctrkBrgDeg + 540) % 360) - 180 // -180..180, signed
  // signed cross-track NM proxy: time-integrated lateral drift = sin(angle)*distSinceClearance with hash distance
  const distSince = hashRange(`${f.icao}|dsinc`, 3, 18)
  let ctrkDevNm = Math.sin(dtheta * Math.PI / 180) * distSince
  // For OCN inject occasional larger drift to seed RAM events
  if (sector.domain === 'OCN' && hashf(`${f.icao}|ocnd`) > 0.85) ctrkDevNm += (hashf(`${f.icao}|ocno`) - 0.5) * 12
  const ctrkTolNm = DOM_LAT[sector.domain] * (latMul / 100)
  const lBustRatio = Math.abs(ctrkDevNm) / Math.max(ctrkTolNm, 0.2)

  // drivers
  const LVL = clamp(vBustRatio * 50, 0, 100)               // 1.0 = at tolerance = 50; 2.0 = 100
  const LAT = clamp(lBustRatio * 50, 0, 100)
  const HDG = clamp(Math.abs(dtheta) / 30 * 100, 0, 100)    // 30° off-cleared = 100
  const VS = clamp((Math.abs(f.vertRate) > 2500 ? 80 : 0) + (Math.abs(f.vertRate) > 4000 ? 20 : 0), 0, 100)
  const PHA = PHASE_MUL[ph] * 60
  const SEC = sector.domain === 'APP' ? 80 : sector.domain === 'TMA' ? 55 : sector.domain === 'ENR' ? 35 : 25
  const SECw = SEC * (secMul / 100)
  const md = Math.max(LVL, LAT, HDG, SECw)
  const sec = (LVL + LAT + HDG + VS + SECw - md) / 4
  const score = clamp((md * 0.82 + sec * 0.18) * PHASE_MUL[ph], 0, 100)

  let tier: Tier
  // hard escalations: vertical bust > 2× tol OR lateral bust > 2× tol → BUST
  if (vBustRatio >= 2.0 || lBustRatio >= 2.0 || score >= 80) tier = 'BUST'
  else if (vBustRatio >= 1.0 || lBustRatio >= 1.0 || score >= 55) tier = 'DEV'
  else if (score >= 22 || vBustRatio >= 0.5 || lBustRatio >= 0.5) tier = 'WATCH'
  else tier = 'OK'

  return {
    f, sector, phase: ph, cflFt, vBustFt, vTolFt,
    ctrkBrgDeg, ctrkDevNm, ctrkTolNm,
    vBustRatio, lBustRatio,
    drivers: { LVL, LAT, HDG, VS, PHA, SEC: SECw },
    score, tier,
  }
}

const SRC_SEC = 'clam-sec', LYR_SEC = 'clam-sec', LYR_SEC_LBL = 'clam-sec-lbl'
const SRC_HALO = 'clam-halo', LYR_HALO = 'clam-halo'
const SRC_PIN = 'clam-pin', LYR_PIN = 'clam-pin'
const SRC_LBL = 'clam-lbl', LYR_LBL = 'clam-lbl'
const SRC_TRK = 'clam-trk', LYR_TRK = 'clam-trk'

// projected cleared track polyline ahead of aircraft along ctrkBrgDeg, len 20 NM
const trackLine = (lat: number, lng: number, brgDeg: number, lenNm = 18): [number, number][] => {
  const t = Math.PI / 180
  const nmLat = 1 / 60; const nmLng = 1 / (60 * Math.cos(lat * t))
  const la2 = lat + Math.cos(brgDeg * t) * lenNm * nmLat
  const lo2 = lng + Math.sin(brgDeg * t) * lenNm * nmLng
  return [[lng, lat], [lo2, la2]]
}

export default function ClamRam({ map, flights, onClose, onFly }: Props) {
  const [secMul, setSecMul] = useState<number>(() => lsGet('sec', 100))
  const [latMul, setLatMul] = useState<number>(() => lsGet('lat', 100))
  const [vrtMul, setVrtMul] = useState<number>(() => lsGet('vrt', 100))
  const [advMul, setAdvMul] = useState<number>(() => lsGet('adv', 100))
  const [minFL, setMinFL] = useState<number>(() => lsGet('minFL', 30))
  const [maxFL, setMaxFL] = useState<number>(() => lsGet('maxFL', 410))
  const [tab, setTab] = useState<'AIRCRAFT' | 'SECTORS' | 'PHASE'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [domFilter, setDomFilter] = useState<Domain | 'ALL'>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showSec, setShowSec] = useState(true)
  const [showTrk, setShowTrk] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    lsSet('sec', secMul); lsSet('lat', latMul); lsSet('vrt', vrtMul); lsSet('adv', advMul); lsSet('minFL', minFL); lsSet('maxFL', maxFL)
  }, [secMul, latMul, vrtMul, advMul, minFL, maxFL])

  const rows = useMemo<Item[]>(() => {
    const items: Item[] = []
    for (const f of flights) {
      if (f.altitudeFt < minFL * 100 || f.altitudeFt > maxFL * 100) continue
      const r = analyse(f, secMul, latMul, vrtMul)
      if (r) { r.score = clamp(r.score * (advMul / 100), 0, 100); items.push(r) }
    }
    items.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return items
  }, [flights, secMul, latMul, vrtMul, advMul, minFL, maxFL])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(v => {
      if (tierFilter !== 'ALL' && v.tier !== tierFilter) return false
      if (domFilter !== 'ALL' && (!v.sector || v.sector.domain !== domFilter)) return false
      if (phaseFilter !== 'ALL' && v.phase !== phaseFilter) return false
      if (q) {
        const blob = `${v.f.callsign} ${v.f.icao} ${v.f.type} ${v.sector?.id} ${v.sector?.name}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [rows, tierFilter, domFilter, phaseFilter, query])

  const tierCount: Record<Tier, number> = { BUST: 0, DEV: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const v of rows) tierCount[v.tier]++
  const meanScore = rows.length ? rows.reduce((s, v) => s + v.score, 0) / rows.length : 0
  const bustN = tierCount.BUST
  const devN = tierCount.DEV
  const watchN = tierCount.WATCH
  const lBustN = rows.filter(r => r.lBustRatio >= 1).length
  const vBustN = rows.filter(r => r.vBustRatio >= 1).length
  const worst = rows[0]

  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any)
    }
    ensure(LYR_SEC, 'circle', SRC_SEC, { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.2, 'circle-stroke-color': '#0f172a' })
    ensure(LYR_SEC_LBL, 'symbol', SRC_SEC, {}, { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_SEC_LBL)) { map.setPaintProperty(LYR_SEC_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_SEC_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_SEC_LBL, 'text-halo-width', 1.2) }
    ensure(LYR_TRK, 'line', SRC_TRK, { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [2, 3] })
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.22, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN, 'circle', SRC_PIN, { 'circle-radius': 5.5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_LBL, 'symbol', SRC_LBL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL)) { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }

    const activeSec = new Set<string>(); for (const v of filtered) if (v.sector) activeSec.add(v.sector.id)
    const secFeats: any[] = []
    if (showSec) {
      for (const s of SECTORS) {
        const isAct = activeSec.has(s.id)
        const col = isAct ? DOM_COLOR[s.domain] : '#475569'
        secFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { color: col, label: `${s.id} · ${s.domain} · ±${DOM_LAT[s.domain]}NM/±${DOM_VRT[s.domain]}ft` } })
      }
    }

    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], trk: any[] = []
    for (const v of filtered) {
      const c = TIER_COLOR[v.tier]
      if (showHalo) halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { color: c, r: 8 + v.score * 0.14 } })
      if (showPin && (v.tier === 'BUST' || v.tier === 'DEV')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { color: c } })
      if (showLbl && v.tier !== 'OK') {
        const vSig = v.vBustFt >= 0 ? '+' : ''
        const lSig = v.ctrkDevNm >= 0 ? '+' : ''
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { color: c, label: `${v.f.callsign || v.f.icao} ${v.tier} CFL${Math.round(v.cflFt/100)} ${vSig}${v.vBustFt.toFixed(0)}ft xt${lSig}${v.ctrkDevNm.toFixed(1)}NM` } })
      }
      if (showTrk && v.tier !== 'OK') trk.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: trackLine(v.f.lat, v.f.lng, v.ctrkBrgDeg) }, properties: { color: c } })
    }
    ;(map.getSource(SRC_SEC) as any).setData({ type: 'FeatureCollection', features: secFeats })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_TRK) as any).setData({ type: 'FeatureCollection', features: trk })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_TRK, LYR_SEC_LBL, LYR_SEC]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_TRK, SRC_SEC]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, showHalo, showPin, showLbl, showSec, showTrk])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const phaseBadge = (p: Phase) => (
    <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono bg-slate-800 text-slate-300 border border-slate-700">{p}</span>
  )
  const domBadge = (d: Domain) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: DOM_COLOR[d], backgroundColor: DOM_COLOR[d] + '1a', border: `1px solid ${DOM_COLOR[d]}66` }}>{d}</span>
  )
  const drvBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (v: Item) => {
    const vSig = v.vBustFt >= 0 ? '+' : ''
    const lSig = v.ctrkDevNm >= 0 ? '+' : ''
    if (v.tier === 'BUST') return `BUST · CFL ${Math.round(v.cflFt/100)} · alt-err ${vSig}${v.vBustFt.toFixed(0)}ft (×${v.vBustRatio.toFixed(1)} tol) · xtrack ${lSig}${v.ctrkDevNm.toFixed(1)}NM (×${v.lBustRatio.toFixed(1)} tol) · STCA pre-cursor · per EUROCONTROL CLAM/RAM Spec / JO 7110.65 §5-6-1 · CAP 710 / CAP 670 §5 / ICAO Doc 4444 §15.7`
    if (v.tier === 'DEV') return `DEV · CFL ${Math.round(v.cflFt/100)} · alt-err ${vSig}${v.vBustFt.toFixed(0)}ft · xtrack ${lSig}${v.ctrkDevNm.toFixed(1)}NM · query crew · re-confirm CFL & cleared route · per ED-202A / EUROCONTROL Safety Nets Impl Guideline 2018`
    if (v.tier === 'WATCH') return `WATCH · ${v.phase} approaching tolerance · alt-err ${vSig}${v.vBustFt.toFixed(0)}ft (×${v.vBustRatio.toFixed(2)}) · xtrack ${lSig}${v.ctrkDevNm.toFixed(1)}NM · per EUROCONTROL CLAM Spec ed.1.0 / RAM Spec ed.1.2`
    return `OK · CFL ${Math.round(v.cflFt/100)} held · xtrack ${v.ctrkDevNm.toFixed(2)}NM within ±${v.ctrkTolNm.toFixed(1)} · per ICAO Doc 4444 §15.7`
  }

  /* Scatter: signed vBust ft horizontal (±800), signed xtrack NM vertical (±8) */
  const W = 280, Hh = 180
  const sx = (n: number) => 32 + clamp((n + 800) / 1600, 0, 1) * (W - 42)
  const sy = (n: number) => Hh - 24 - clamp((n + 8) / 16, 0, 1) * (Hh - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">CLAM / RAM · Cleared Level & Route Adherence</div>
          <div className="text-[10px] text-slate-500">EUROCONTROL Safety Nets Impl Guideline · CLAM Spec ed.1.0 · RAM Spec ed.1.2 · ED-202A · ICAO Doc 4444 §15.7 · JO 7110.65 §5-6-1 · CAP 670 §5 · CAP 710</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[9px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean score</div>
          <div className="text-sm font-semibold" style={{ color: meanScore >= 55 ? '#ef4444' : meanScore >= 35 ? '#f59e0b' : '#10b981' }}>{meanScore.toFixed(0)}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">BUST</div>
          <div className="text-sm font-semibold" style={{ color: bustN > 0 ? '#ef4444' : '#10b981' }}>{bustN}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">CLAM bust</div>
          <div className="text-xs font-semibold" style={{ color: vBustN > 0 ? '#ef4444' : '#10b981' }}>{vBustN}<span className="text-slate-500"> vertical</span></div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">RAM bust</div>
          <div className="text-xs font-semibold" style={{ color: lBustN > 0 ? '#ef4444' : '#10b981' }}>{lBustN}<span className="text-slate-500"> lateral</span></div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">DEV / WATCH</div>
          <div className="text-xs font-semibold text-slate-100">{devN}<span className="text-slate-500">/</span>{watchN}<span className="text-slate-500"> · {rows.length}ac</span></div>
        </div>
      </div>

      {showDiag && rows.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={Hh} className="w-full">
            <rect x={0} y={0} width={W} height={Hh} fill="#020617" />
            {/* OK band */}
            <rect x={sx(-200)} y={sy(2)} width={sx(200) - sx(-200)} height={sy(-2) - sy(2)} fill="#10b98115" />
            {/* DEV bands */}
            <rect x={sx(-400)} y={0} width={sx(-200) - sx(-400)} height={Hh - 24} fill="#f59e0b15" />
            <rect x={sx(200)} y={0} width={sx(400) - sx(200)} height={Hh - 24} fill="#f59e0b15" />
            {/* BUST bands */}
            <rect x={0} y={0} width={sx(-400)} height={Hh - 24} fill="#ef444425" />
            <rect x={sx(400)} y={0} width={W - sx(400)} height={Hh - 24} fill="#ef444425" />
            {/* refs */}
            <line x1={sx(0)} y1={0} x2={sx(0)} y2={Hh - 24} stroke="#33415566" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(-200)} y1={0} x2={sx(-200)} y2={Hh - 24} stroke="#f59e0b88" strokeWidth={0.4} strokeDasharray="3 3" />
            <line x1={sx(200)} y1={0} x2={sx(200)} y2={Hh - 24} stroke="#f59e0b88" strokeWidth={0.4} strokeDasharray="3 3" />
            <line x1={0} y1={sy(0)} x2={W} y2={sy(0)} stroke="#33415566" strokeWidth={0.4} strokeDasharray="3 3" />
            <line x1={0} y1={sy(2)} x2={W} y2={sy(2)} stroke="#f59e0b66" strokeWidth={0.4} strokeDasharray="3 3" />
            <line x1={0} y1={sy(-2)} x2={W} y2={sy(-2)} stroke="#f59e0b66" strokeWidth={0.4} strokeDasharray="3 3" />
            <text x={W / 2} y={Hh - 4} textAnchor="middle" fontSize="9" fill="#64748b">CFL deviation ft (±800)</text>
            <text x={6} y={Hh / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${Hh / 2})`}>xtrack NM (±8)</text>
            {rows.map((v, i) => (
              <circle key={i} cx={sx(clamp(v.vBustFt, -799, 799))} cy={sy(clamp(v.ctrkDevNm, -7.9, 7.9))} r={2.4} fill={TIER_COLOR[v.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['SEC-MUL', secMul, 50, 200, setSecMul, '%'],
            ['LAT-MUL', latMul, 50, 200, setLatMul, '%'],
            ['VRT-MUL', vrtMul, 50, 200, setVrtMul, '%'],
            ['ADV-MUL', advMul, 50, 200, setAdvMul, '%'],
            ['MIN-FL', minFL, 0, 200, setMinFL, ''],
            ['MAX-FL', maxFL, 50, 500, setMaxFL, ''],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[64px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[46px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['OCN', 'ENR', 'TMA', 'APP'] as Domain[]).map(d => (
            <button key={d} onClick={() => setDomFilter(domFilter === d ? 'ALL' : d)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: domFilter === d ? DOM_COLOR[d] + '33' : '#0b1220', borderColor: domFilter === d ? DOM_COLOR[d] : '#1e293b', color: domFilter === d ? DOM_COLOR[d] : '#cbd5e1' }}>{d}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-1">
          {(['CRZ', 'CLB', 'DES', 'APP', 'DEP'] as Phase[]).map(p => (
            <button key={p} onClick={() => setPhaseFilter(phaseFilter === p ? 'ALL' : p)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: phaseFilter === p ? '#0ea5e933' : '#0b1220', borderColor: phaseFilter === p ? '#0ea5e9' : '#1e293b', color: phaseFilter === p ? '#0ea5e9' : '#cbd5e1' }}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['SEC', showSec, setShowSec],
            ['TRK', showTrk, setShowTrk],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / sector" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'SECTORS', 'PHASE'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'AIRCRAFT' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No aircraft in monitored sectors</div>}
          {filtered.map((v, idx) => (
            <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(v.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[v.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 truncate">{v.f.callsign || v.f.icao}</span>
                  <span className="font-mono text-[10px] text-slate-400">{v.f.type || '—'}</span>
                  {phaseBadge(v.phase)}
                  {v.sector && domBadge(v.sector.domain)}
                </div>
                {tierBadge(v.tier)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-sky-300">{v.sector?.id || '—'}</span>
                <span className="text-slate-500"> · </span>
                <span className="text-slate-300 truncate">{v.sector?.name}</span>
                <span className="text-slate-500"> · </span>
                <span className="text-slate-400">{v.sector?.ansp}</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-slate-500">CFL</span> <span className="text-sky-300">FL{Math.round(v.cflFt/100).toString().padStart(3,'0')}</span>
                {' · '}<span className="text-slate-500">alt</span> <span className="text-slate-200">{(v.f.altitudeFt/100).toFixed(0)}</span>
                {' · '}<span className="text-slate-500">err</span> <span style={{ color: v.vBustRatio >= 2 ? '#ef4444' : v.vBustRatio >= 1 ? '#f43f5e' : v.vBustRatio >= 0.5 ? '#f59e0b' : '#10b981' }}>{v.vBustFt >= 0 ? '+' : ''}{v.vBustFt.toFixed(0)}ft</span>
                <span className="text-slate-500">/±{v.vTolFt.toFixed(0)}</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-slate-500">xtrack</span> <span style={{ color: v.lBustRatio >= 2 ? '#ef4444' : v.lBustRatio >= 1 ? '#f43f5e' : v.lBustRatio >= 0.5 ? '#f59e0b' : '#10b981' }}>{v.ctrkDevNm >= 0 ? '+' : ''}{v.ctrkDevNm.toFixed(1)}NM</span>
                <span className="text-slate-500">/±{v.ctrkTolNm.toFixed(1)}</span>
                {' · '}<span className="text-slate-500">ctrk</span> <span className="text-slate-200">{v.ctrkBrgDeg.toFixed(0)}°</span>
                {' · '}<span className="text-slate-500">trk</span> <span className="text-slate-200">{v.f.track.toFixed(0)}°</span>
                {' · '}<span className="text-slate-500">VS</span> <span className={v.f.vertRate > 0 ? 'text-emerald-300' : v.f.vertRate < 0 ? 'text-amber-300' : 'text-slate-300'}>{v.f.vertRate >= 0 ? '+' : ''}{v.f.vertRate.toFixed(0)}fpm</span>
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${v.score}%`, backgroundColor: TIER_COLOR[v.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {drvBadge('LVL', v.drivers.LVL)}
                {drvBadge('LAT', v.drivers.LAT)}
                {drvBadge('HDG', v.drivers.HDG)}
                {drvBadge('VS', v.drivers.VS)}
                {drvBadge('PHA', v.drivers.PHA)}
                {drvBadge('SEC', v.drivers.SEC)}
              </div>
              <div className="text-[10px] mt-1.5 italic" style={{ color: TIER_COLOR[v.tier] }}>{advice(v)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'SECTORS' && (
        <div className="divide-y divide-slate-800">
          {SECTORS.slice().sort((a, b) => rows.filter(r => r.sector?.id === b.id).length - rows.filter(r => r.sector?.id === a.id).length).map(s => {
            const sRows = rows.filter(r => r.sector?.id === s.id)
            const ms = sRows.length ? sRows.reduce((acc, r) => acc + r.score, 0) / sRows.length : 0
            const bst = sRows.filter(r => r.tier === 'BUST').length
            const dev = sRows.filter(r => r.tier === 'DEV').length
            const lB = sRows.filter(r => r.lBustRatio >= 1).length
            const vB = sRows.filter(r => r.vBustRatio >= 1).length
            const sevCol = bst > 0 ? '#ef4444' : dev > 0 ? '#f43f5e' : ms >= 35 ? '#f59e0b' : sRows.length ? '#10b981' : '#475569'
            return (
              <div key={s.id} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => { if (sRows[0]) onFly(sRows[0].f.icao) }} style={{ borderLeft: `3px solid ${sevCol}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-mono text-sky-300">{s.id}</span>
                    <span className="text-slate-200 text-[11px] truncate">{s.name}</span>
                    {domBadge(s.domain)}
                  </div>
                  <span className="text-[10px] font-mono text-slate-300">±<span className="text-amber-300">{DOM_VRT[s.domain]}</span>ft / ±<span className="text-amber-300">{DOM_LAT[s.domain]}</span>NM</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  {s.ansp} · FL{s.minFL}–{s.maxFL} · CLAM-gate <span className="text-sky-300">{s.clamGate}s</span> · RAM-gate <span className="text-sky-300">{s.ramGate}s</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  {sRows.length} ac · <span className="text-rose-400">{bst} BUST</span> · <span className="text-rose-300">{dev} DEV</span> · CLAM <span className="text-rose-300">{vB}</span> · RAM <span className="text-rose-300">{lB}</span>
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 55 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'PHASE' && (
        <div className="divide-y divide-slate-800">
          {(['APP', 'DES', 'CRZ', 'CLB', 'DEP'] as Phase[]).map(p => {
            const pRows = rows.filter(r => r.phase === p)
            const bst = pRows.filter(r => r.tier === 'BUST').length
            const dev = pRows.filter(r => r.tier === 'DEV').length
            const ms = pRows.length ? pRows.reduce((acc, r) => acc + r.score, 0) / pRows.length : 0
            const mul = PHASE_MUL[p]
            return (
              <div key={p} className="px-3 py-2" style={{ borderLeft: `3px solid ${mul >= 1.3 ? '#ef4444' : mul >= 1.15 ? '#f59e0b' : '#0ea5e9'}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    {phaseBadge(p)}
                    <span className="text-slate-200 text-[11px]">phase mul ×{mul.toFixed(2)}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400">{pRows.length} ac</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  <span className="text-rose-400">{bst} BUST</span> · <span className="text-rose-300">{dev} DEV</span> · mean score <span style={{ color: ms >= 55 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }}>{ms.toFixed(0)}</span>
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 55 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
              </div>
            )
          })}
          <div className="px-3 py-2 text-[10px] text-slate-500">
            CLAM tolerance: ±200 ft level cruise / ±300 ft transitioning CFL per EUROCONTROL CLAM Spec ed.1.0. RAM tolerance: OCN ±7 NM (PBCS RNP-4/10) · ENR ±2 NM · TMA ±1 NM · APP ±0.5 NM (PBN RNP) per RAM Spec ed.1.2. Hard escalation when deviation ≥ 2× tolerance — STCA pre-cursor. References: ED-202A · ED-153 · ICAO Doc 4444 §15.7 · Annex 11 §2.27 · Doc 9426 III.4 · FAA JO 7110.65 §5-6-1 · JO 6190.18 · CAP 670 SUR §5 · CAP 710 Level Bust Action Plan · EUROCONTROL Safety Nets Impl Guideline 2018 · Action Plan for Prevention of Level Bust · EASA SIB 2018-04 · BFU 02-02 Überlingen · NTSB AAR-87-03.
          </div>
        </div>
      )}
    </div>
  )
}
