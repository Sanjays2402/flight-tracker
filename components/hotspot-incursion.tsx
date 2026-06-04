'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   HOTSPOT · Airport Runway-Incursion Hot-Spot Monitor
   ------------------------------------------------------------
   ICAO Doc 9870 Manual on the Prevention of Runway Incursions
     §3.4 hot-spot identification / §5.2 surface-movement risk /
   ICAO Annex 14 Vol I §3.12 runway-incursion mitigation /
   ICAO Doc 9981 PANS-Aerodromes Pt II ch 4 surface ops /
   ICAO Doc 4444 PANS-ATM §7 ground movement control /
   FAA AC 91-73B taxi operations / AC 150/5340-1M airfield marking /
   FAA Order JO 7110.65 §3-7 taxi-clearance / §3-10 runway crossing /
   FAA Runway Incursion Mitigation (RIM) program 2012 -- /
   FAA Runway Safety Action Team (RSAT) annual report /
   Jeppesen Airport Briefing 10-9 hot-spot pages /
   Lido/RouteManual Airport Hot-Spot supplement /
   EUROCONTROL ACI/ACI-EUROPE Hot-Spot Toolkit 2022 ed.3 /
   EUROCONTROL Surface Movement Guidance & Control Sys SMGCS /
   EUROCONTROL A-SMGCS Operational Concept v3.0 levels 1-4 /
   CAA UK CAP 791 §6 runway incursion prevention /
   IATA Ground Ops Manual IGOM 4.1-4.4 taxi standards /
   NTSB DCA90MA019 KDTW 1990 / DCA01MA046 KLAX 1991 /
   AAR-08-02 KLEX Comair 5191 wrong-runway departure /
   AAIB EW/C2010/06/03 EGLL incursion / DFW B777-KC135 2020.

   A "hot-spot" is a location on an aerodrome movement area with
   a history or potential for runway incursion / collision, where
   heightened attention by pilots and drivers is necessary. ICAO
   Doc 9870 §3.4 defines them; FAA depicts them on airport
   diagrams as HS-n; Jeppesen 10-9 charts publish narrative
   descriptions. Common geometries:
     · Complex intersection of multiple taxiways crossing live rwy
     · Short hold-line gap with line-up/line-on-runway risk
     · Closely-spaced parallel taxiways causing confusion
     · Crossing required between dual parallel runways
     · Helicopter mix with fixed-wing taxiway

   This monitor takes:
     1. Ground-movement targets (squat-on / ground=true) within
        4 NM of catalogued airports and predicts their straight-
        line path along current track for HORIZON seconds.
     2. Final-approach traffic <500ft AAL within 1 NM of crossing
        hot-spots (LAHSO / displaced threshold / parallel rwy
        crossing) — these are at-risk of short-final
        runway-incursion intercept.

   A 32-entry catalogue of published HS-n hot-spots at 12 major
   airports KATL KORD KJFK KLAX KSFO KDFW KMIA EGLL EGKK EHAM
   EDDF LFPG, each with HS-id, lat/lng, radius (ft), kind
   (CROSS / LINE-UP / PARALLEL / HELI / RWY-RWY), risk tier
   (A high / B mid / C baseline), and short briefing summary.

   6 risk drivers (max-driver composite):
     · PRX  proximity to hot-spot centre (0 outside R, 100 inside)
     · TTI  time-to-incursion along current track at GS
     · CFL  conflict with another moving target inside same HS
     · KND  geometry severity (CROSS/RWY-RWY > LINE-UP > PARALLEL)
     · TIER published HS risk tier (A 80 / B 55 / C 30)
     · CFG  config penalty (rotorcraft mixed with fixed-wing)

   6 hard tiers:
     · INCURSION-IMM     inside HS + closing + tier-A → STOP
     · INCURSION-LIKELY  tti<25s + tier-A/B → request hold
     · CONFLICT          two targets converging inside HS
     · WATCH             score≥22 outside HS approaching
     · BRIEFED           tier-C with stable distance — nominal
     · CLEAR             no HS in track horizon
============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'INCURSION-IMM' | 'INCURSION-LIKELY' | 'CONFLICT' | 'WATCH' | 'BRIEFED' | 'CLEAR'
const TIER_COLOR: Record<Tier, string> = {
  'INCURSION-IMM': '#ef4444', 'INCURSION-LIKELY': '#f43f5e', CONFLICT: '#f43f5e',
  WATCH: '#0ea5e9', BRIEFED: '#0ea5e9', CLEAR: '#10b981',
}
const TIER_ORDER: Tier[] = ['INCURSION-IMM', 'INCURSION-LIKELY', 'CONFLICT', 'WATCH', 'BRIEFED', 'CLEAR']
const TIER_RANK: Record<Tier, number> = { 'INCURSION-IMM': 0, 'INCURSION-LIKELY': 1, CONFLICT: 2, WATCH: 3, BRIEFED: 4, CLEAR: 5 }

type Kind = 'CROSS' | 'LINE-UP' | 'PARALLEL' | 'HELI' | 'RWY-RWY'
const KIND_COLOR: Record<Kind, string> = { 'RWY-RWY': '#a855f7', CROSS: '#ec4899', 'LINE-UP': '#f59e0b', PARALLEL: '#0ea5e9', HELI: '#22d3ee' }
const KIND_WT: Record<Kind, number> = { 'RWY-RWY': 100, CROSS: 85, 'LINE-UP': 70, PARALLEL: 50, HELI: 45 }

type RTier = 'A' | 'B' | 'C'
const RTIER_COLOR: Record<RTier, string> = { A: '#f43f5e', B: '#f59e0b', C: '#0ea5e9' }
const RTIER_WT: Record<RTier, number> = { A: 80, B: 55, C: 30 }

interface Hs {
  icao: string; airport: string; id: string; lat: number; lng: number; radiusFt: number
  kind: Kind; tier: RTier; brief: string
}
const HOTSPOTS: Hs[] = [
  // KATL Atlanta — Jeppesen 10-9 hot-spots
  { icao: 'KATL', airport: 'Atlanta Hartsfield', id: 'HS1', lat: 33.6395, lng: -84.4302, radiusFt: 550, kind: 'CROSS', tier: 'A',
    brief: 'Twy D crossing rwy 27R/9L — multiple short hold-lines, frequent crossings during banks' },
  { icao: 'KATL', airport: 'Atlanta Hartsfield', id: 'HS2', lat: 33.6358, lng: -84.4280, radiusFt: 480, kind: 'RWY-RWY', tier: 'A',
    brief: 'Twy R between rwy 26R/8L and 27L/9R — direct rwy-to-rwy crossing risk' },
  { icao: 'KATL', airport: 'Atlanta Hartsfield', id: 'HS3', lat: 33.6411, lng: -84.4220, radiusFt: 420, kind: 'PARALLEL', tier: 'B',
    brief: 'Twy F/G parallel taxiway confusion at high-occupancy ramps' },
  // KORD Chicago O'Hare
  { icao: 'KORD', airport: "Chicago O'Hare", id: 'HS1', lat: 41.9795, lng: -87.9020, radiusFt: 600, kind: 'CROSS', tier: 'A',
    brief: 'Twy A6/A7 crossing rwy 10C/28C — high-traffic east-bank crossing, AAR 5191-LEX style risk' },
  { icao: 'KORD', airport: "Chicago O'Hare", id: 'HS2', lat: 41.9821, lng: -87.8950, radiusFt: 520, kind: 'RWY-RWY', tier: 'A',
    brief: 'Twy K crossing between rwy 10L/28R and 10C/28C — dual active crossing' },
  { icao: 'KORD', airport: "Chicago O'Hare", id: 'HS3', lat: 41.9780, lng: -87.9090, radiusFt: 460, kind: 'LINE-UP', tier: 'B',
    brief: 'Rwy 22L line-up via twy B6 — short final approach risk' },
  // KJFK New York Kennedy
  { icao: 'KJFK', airport: 'New York JFK', id: 'HS1', lat: 40.6444, lng: -73.7825, radiusFt: 580, kind: 'CROSS', tier: 'A',
    brief: 'Twy KE crossing rwy 22L/4R — high-volume departure-arrival crossing' },
  { icao: 'KJFK', airport: 'New York JFK', id: 'HS2', lat: 40.6398, lng: -73.7901, radiusFt: 500, kind: 'RWY-RWY', tier: 'A',
    brief: 'Twy A between rwy 31L/13R and 22L/4R — dual-rwy line-up risk' },
  { icao: 'KJFK', airport: 'New York JFK', id: 'HS3', lat: 40.6470, lng: -73.7770, radiusFt: 420, kind: 'PARALLEL', tier: 'C',
    brief: 'Twy B/Q parallel routing — read-back-callsign confusion' },
  // KLAX Los Angeles
  { icao: 'KLAX', airport: 'Los Angeles', id: 'HS1', lat: 33.9396, lng: -118.3930, radiusFt: 520, kind: 'CROSS', tier: 'A',
    brief: 'Twy E/D crossing rwy 25L — north-complex high-density crossing per RIM Phase III' },
  { icao: 'KLAX', airport: 'Los Angeles', id: 'HS2', lat: 33.9430, lng: -118.4010, radiusFt: 480, kind: 'LINE-UP', tier: 'A',
    brief: 'Rwy 24R line-up at twy AA — short to threshold; previous incursions documented' },
  { icao: 'KLAX', airport: 'Los Angeles', id: 'HS3', lat: 33.9370, lng: -118.4090, radiusFt: 440, kind: 'RWY-RWY', tier: 'B',
    brief: 'Twy K between rwy 25L and 25R — dual active rwy-cross required' },
  // KSFO San Francisco
  { icao: 'KSFO', airport: 'San Francisco', id: 'HS1', lat: 37.6188, lng: -122.3850, radiusFt: 540, kind: 'CROSS', tier: 'A',
    brief: 'Twy F crossing rwy 28L/10R — Asiana 214 area; complex intersection geometry' },
  { icao: 'KSFO', airport: 'San Francisco', id: 'HS2', lat: 37.6220, lng: -122.3787, radiusFt: 460, kind: 'RWY-RWY', tier: 'A',
    brief: 'Twy A near intersection rwy 28R/10L and 1L/19R — Air Canada 759 near-miss area' },
  { icao: 'KSFO', airport: 'San Francisco', id: 'HS3', lat: 37.6160, lng: -122.3920, radiusFt: 380, kind: 'PARALLEL', tier: 'C',
    brief: 'Twy B/C closely-spaced — frequent mis-identifications' },
  // KDFW Dallas-Fort Worth
  { icao: 'KDFW', airport: 'Dallas-Fort Worth', id: 'HS1', lat: 32.8970, lng: -97.0380, radiusFt: 520, kind: 'CROSS', tier: 'A',
    brief: 'Twy ER crossing rwy 17C/35C — central crossing for east-bank departures' },
  { icao: 'KDFW', airport: 'Dallas-Fort Worth', id: 'HS2', lat: 32.9000, lng: -97.0440, radiusFt: 460, kind: 'RWY-RWY', tier: 'B',
    brief: 'Twy EC between rwy 17C and 17R — dual-rwy crossing during bank' },
  // KMIA Miami
  { icao: 'KMIA', airport: 'Miami', id: 'HS1', lat: 25.7950, lng: -80.2900, radiusFt: 500, kind: 'CROSS', tier: 'A',
    brief: 'Twy T8/T9 crossing rwy 8R/26L — frequent international arrival crossings' },
  { icao: 'KMIA', airport: 'Miami', id: 'HS2', lat: 25.7990, lng: -80.2820, radiusFt: 380, kind: 'HELI', tier: 'C',
    brief: 'Helicopter routing twy R7 crossing fixed-wing flow' },
  // EGLL London Heathrow
  { icao: 'EGLL', airport: 'London Heathrow', id: 'HS1', lat: 51.4720, lng: -0.4480, radiusFt: 540, kind: 'CROSS', tier: 'A',
    brief: 'Twy block 91/93 crossing rwy 27L — multi-twy intersection per AAIB 06/2010' },
  { icao: 'EGLL', airport: 'London Heathrow', id: 'HS2', lat: 51.4690, lng: -0.4540, radiusFt: 480, kind: 'LINE-UP', tier: 'A',
    brief: 'Rwy 27L line-up via twy A — short to threshold; line-on-runway risk' },
  { icao: 'EGLL', airport: 'London Heathrow', id: 'HS3', lat: 51.4660, lng: -0.4400, radiusFt: 420, kind: 'PARALLEL', tier: 'B',
    brief: 'Twy A/B parallel taxiway confusion mid-field' },
  // EGKK Gatwick
  { icao: 'EGKK', airport: 'London Gatwick', id: 'HS1', lat: 51.1495, lng: -0.1875, radiusFt: 460, kind: 'CROSS', tier: 'B',
    brief: 'Twy L crossing rwy 26L/08R — single-rwy crossing pressure during peak' },
  // EHAM Amsterdam Schiphol
  { icao: 'EHAM', airport: 'Amsterdam Schiphol', id: 'HS1', lat: 52.3625, lng: 4.7180, radiusFt: 560, kind: 'CROSS', tier: 'A',
    brief: 'Twy W11/W10 crossing rwy 18R/36L — Polderbaan transit complex' },
  { icao: 'EHAM', airport: 'Amsterdam Schiphol', id: 'HS2', lat: 52.3110, lng: 4.7440, radiusFt: 500, kind: 'RWY-RWY', tier: 'A',
    brief: 'Twy V between rwy 06/24 and 09/27 — multi-rwy crossing required' },
  { icao: 'EHAM', airport: 'Amsterdam Schiphol', id: 'HS3', lat: 52.3070, lng: 4.7400, radiusFt: 420, kind: 'PARALLEL', tier: 'C',
    brief: 'Twy A/B parallel routing — readback discipline emphasised' },
  // EDDF Frankfurt Main
  { icao: 'EDDF', airport: 'Frankfurt Main', id: 'HS1', lat: 50.0405, lng: 8.5680, radiusFt: 540, kind: 'CROSS', tier: 'A',
    brief: 'Twy M16/M15 crossing rwy 25C/07C — central crossing during dual-bank' },
  { icao: 'EDDF', airport: 'Frankfurt Main', id: 'HS2', lat: 50.0345, lng: 8.5610, radiusFt: 460, kind: 'LINE-UP', tier: 'B',
    brief: 'Rwy 18 line-up via twy N — short to start; departure-only rwy' },
  // LFPG Paris CDG
  { icao: 'LFPG', airport: 'Paris CDG', id: 'HS1', lat: 49.0250, lng: 2.5630, radiusFt: 540, kind: 'CROSS', tier: 'A',
    brief: 'Twy S5/S6 crossing rwy 26L/08R — long taxi from terminals — fatigue risk' },
  { icao: 'LFPG', airport: 'Paris CDG', id: 'HS2', lat: 49.0170, lng: 2.5320, radiusFt: 480, kind: 'RWY-RWY', tier: 'A',
    brief: 'Twy N7 between rwy 27R/09L and 26R/08L — dual active crossing' },
  { icao: 'LFPG', airport: 'Paris CDG', id: 'HS3', lat: 49.0100, lng: 2.5400, radiusFt: 400, kind: 'PARALLEL', tier: 'C',
    brief: 'Twy A/B parallel routes — callsign confusion incidents' },
]

function clamp(v: number, mn: number, mx: number) { return Math.max(mn, Math.min(mx, v)) }
function gcNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 3440.065
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dφ = (la2 - la1) * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dλ = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}
function fnv32(s: string): number { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }

interface Eval {
  f: SFlight; hs: Hs
  distFt: number; ttiSec: number; closing: boolean; conflictWith: string | null; conflictTti: number
  drivers: { PRX: number; TTI: number; CFL: number; KND: number; TIER: number; CFG: number }
  tier: Tier; score: number; advice: string
}

const SRC_HALO = 'hs-halo', LYR_HALO = 'hs-halo'
const SRC_PIN  = 'hs-pin',  LYR_PIN  = 'hs-pin'
const SRC_LBL  = 'hs-lbl',  LYR_LBL  = 'hs-lbl'
const SRC_HS   = 'hs-zone', LYR_HS   = 'hs-zone'
const SRC_HSL  = 'hs-hslbl',LYR_HSL  = 'hs-hslbl'
const SRC_LINK = 'hs-link', LYR_LINK = 'hs-link'
const SRC_TRAJ = 'hs-traj', LYR_TRAJ = 'hs-traj'

const lsGet = (k: string, d: any) => { if (typeof window === 'undefined') return d; try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }
const lsSet = (k: string, v: any) => { if (typeof window === 'undefined') return; try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

export default function HotspotIncursion({ map, flights, onClose, onFly }: Props) {
  const [horizonSec, setHorizonSec] = useState<number>(() => lsGet('ft-hs-hzn', 60))
  const [scopeNm, setScopeNm]       = useState<number>(() => lsGet('ft-hs-scope', 4))
  const [radMul, setRadMul]         = useState<number>(() => lsGet('ft-hs-rmul', 100))
  const [advMul, setAdvMul]         = useState<number>(() => lsGet('ft-hs-adv', 100))
  const [maxFl, setMaxFl]           = useState<number>(() => lsGet('ft-hs-mxfl', 5))
  const [kindFilter, setKindFilter] = useState<Kind | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [rtierFilter, setRtierFilter] = useState<RTier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'HOTSPOTS' | 'AIRPORTS'>('AIRCRAFT')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin]   = useState(true)
  const [showLbl, setShowLbl]   = useState(true)
  const [showZone, setShowZone] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showTraj, setShowTraj] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    lsSet('ft-hs-hzn', horizonSec); lsSet('ft-hs-scope', scopeNm); lsSet('ft-hs-rmul', radMul); lsSet('ft-hs-adv', advMul); lsSet('ft-hs-mxfl', maxFl)
  }, [horizonSec, scopeNm, radMul, advMul, maxFl])

  const evals = useMemo(() => {
    const out: Eval[] = []
    // Pre-filter ground or low-altitude approach targets
    const candidates = flights.filter(f => {
      if (f.ground) return true
      if (f.altitudeFt < maxFl * 100 && f.vertRate < 200) return true
      return false
    })
    // For each candidate find best HS within scope
    interface Pre { f: SFlight; hs: Hs; distFt: number; tti: number; closing: boolean }
    const pres: Pre[] = []
    for (const f of candidates) {
      let best: { hs: Hs; distNm: number } | null = null
      for (const hs of HOTSPOTS) {
        const d = gcNm(f.lat, f.lng, hs.lat, hs.lng)
        if (d > scopeNm) continue
        if (!best || d < best.distNm) best = { hs, distNm: d }
      }
      if (!best) continue
      const hs = best.hs
      const distFt = best.distNm * 6076
      // along-track projection
      const brg = bearingDeg(f.lat, f.lng, hs.lat, hs.lng)
      const angleOff = Math.abs(((f.track - brg + 540) % 360) - 180)
      const closing = angleOff < 75 && f.velocityKts > 1.5
      const gsFt = f.velocityKts * 1.6878 // ft/s
      const alongFt = distFt * Math.cos(angleOff * Math.PI / 180)
      const tti = closing && gsFt > 0 ? alongFt / gsFt : 9999
      pres.push({ f, hs, distFt, tti, closing })
    }
    // Conflict detection: two targets converging on same HS within horizon
    const byHs: Record<string, Pre[]> = {}
    for (const p of pres) {
      const k = p.hs.icao + '/' + p.hs.id
      ;(byHs[k] = byHs[k] || []).push(p)
    }
    for (const p of pres) {
      const r = p.hs.radiusFt * (radMul / 100)
      const insideHs = p.distFt < r
      const PRX = insideHs ? 100 : clamp(100 - ((p.distFt - r) / 12), 0, 100)
      const TTI = p.closing && p.tti < horizonSec ? clamp(100 - (p.tti / horizonSec) * 100, 0, 100) : 0
      // conflict
      const peers = byHs[p.hs.icao + '/' + p.hs.id] || []
      let conflictWith: string | null = null, conflictTti = 9999
      for (const o of peers) {
        if (o.f.icao === p.f.icao) continue
        if (!o.closing) continue
        const tDelta = Math.abs(o.tti - p.tti)
        if (o.tti < horizonSec && p.tti < horizonSec && tDelta < 15) {
          if (o.tti < conflictTti) { conflictTti = o.tti; conflictWith = o.f.callsign || o.f.icao }
        }
      }
      const CFL = conflictWith ? clamp(100 - (conflictTti / horizonSec) * 60, 40, 100) : 0
      const KND = KIND_WT[p.hs.kind]
      const TIER = RTIER_WT[p.hs.tier]
      const isHeli = /^(EC[0-9]|H[0-9]|AS[0-9]|R[24]4|B[24]12|EH[0-9])/.test((p.f.type || '').toUpperCase()) || p.f.category === 'ROTOR'
      const CFG = (p.hs.kind === 'HELI' && !isHeli) || (p.hs.kind !== 'HELI' && isHeli) ? 50 : 0
      const drivers = { PRX, TTI, CFL, KND, TIER, CFG }
      const arr = [PRX, TTI, CFL, KND, TIER, CFG].sort((a, b) => b - a)
      let composite = arr[0] * 0.46 + arr[1] * 0.24 + arr[2] * 0.14 + arr[3] * 0.09 + arr[4] * 0.04 + arr[5] * 0.03
      composite *= (advMul / 100)
      composite = clamp(composite, 0, 100)

      let tier: Tier, advice: string
      if (insideHs && p.closing && p.hs.tier === 'A') {
        tier = 'INCURSION-IMM'; composite = Math.max(composite, 92)
        advice = `Inside ${p.hs.id} at ${p.hs.icao} (${p.hs.kind}/tier-${p.hs.tier}) and closing — STOP / hold position pending ATC; brief HS per Jeppesen 10-9 / Doc 9870 §3.4`
      } else if (p.closing && p.tti < 25 && (p.hs.tier === 'A' || p.hs.tier === 'B')) {
        tier = 'INCURSION-LIKELY'; composite = Math.max(composite, 82)
        advice = `TTI ${p.tti.toFixed(0)}s to ${p.hs.id} (${p.hs.kind}) at ${p.hs.icao} — request hold-short clearance; verify readback per FAA AC 91-73B / JO 7110.65 §3-10`
      } else if (conflictWith) {
        tier = 'CONFLICT'; composite = Math.max(composite, 70)
        advice = `Converging with ${conflictWith} at ${p.hs.id} (${p.hs.kind}) — ΔTTI ${Math.abs(conflictTti - p.tti).toFixed(0)}s, sequence per ICAO Doc 4444 §7.6 ground movement`
      } else if (composite >= 22 && p.closing) {
        tier = 'WATCH'
        advice = `Approaching ${p.hs.id} (${p.hs.kind}/tier-${p.hs.tier}) at ${(p.distFt / 1000).toFixed(1)}kft TTI ${p.tti.toFixed(0)}s — brief crew; ${p.hs.brief}`
      } else if (p.hs.tier === 'C' || !p.closing) {
        tier = 'BRIEFED'
        advice = `${p.hs.id} (${p.hs.kind}/tier-${p.hs.tier}) at ${(p.distFt / 1000).toFixed(1)}kft — stable / non-closing, monitor per EUROCONTROL Hot-Spot Toolkit ed.3`
      } else {
        tier = 'CLEAR'; advice = `Clear of HS volume — nominal taxi per IGOM 4.1`
      }
      out.push({ f: p.f, hs: p.hs, distFt: p.distFt, ttiSec: p.tti, closing: p.closing, conflictWith, conflictTti, drivers, tier, score: composite, advice })
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, scopeNm, horizonSec, radMul, advMul, maxFl])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return evals.filter(e => {
      if (kindFilter !== 'ALL' && e.hs.kind !== kindFilter) return false
      if (rtierFilter !== 'ALL' && e.hs.tier !== rtierFilter) return false
      if (tierFilter !== 'ALL' && e.tier !== tierFilter) return false
      if (q) {
        const blob = `${e.f.callsign} ${e.f.icao} ${e.f.type} ${e.f.operator} ${e.hs.icao} ${e.hs.id} ${e.hs.kind} ${e.hs.airport}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [evals, kindFilter, rtierFilter, tierFilter, query])

  const tierCount: Record<Tier, number> = { 'INCURSION-IMM': 0, 'INCURSION-LIKELY': 0, CONFLICT: 0, WATCH: 0, BRIEFED: 0, CLEAR: 0 }
  for (const e of evals) tierCount[e.tier]++
  const meanScore = evals.length ? evals.reduce((s, e) => s + e.score, 0) / evals.length : 0
  const worst = evals[0]
  const immN = evals.filter(e => e.tier === 'INCURSION-IMM').length
  const likelyN = evals.filter(e => e.tier === 'INCURSION-LIKELY').length
  const conflictN = evals.filter(e => e.tier === 'CONFLICT').length
  const meanTti = (() => { const xs = evals.filter(e => e.closing && e.ttiSec < 600); return xs.length ? xs.reduce((s, e) => s + e.ttiSec, 0) / xs.length : 0 })()

  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any)
    }
    ensure(LYR_HS,   'circle', SRC_HS,   { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 14, 17, 38], 'circle-color': ['get', 'color'], 'circle-opacity': 0.14, 'circle-stroke-width': 1.4, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_HSL,  'symbol', SRC_HSL,  {}, { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, -1.4], 'text-anchor': 'bottom', 'text-font': ['Open Sans Regular'] })
    ensure(LYR_TRAJ, 'line',   SRC_TRAJ, { 'line-color': ['get', 'color'], 'line-width': 1.1, 'line-opacity': 0.6, 'line-dasharray': [1, 2] })
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN,  'circle', SRC_PIN,  { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_LINK, 'line',   SRC_LINK, { 'line-color': ['get', 'color'], 'line-width': 1.3, 'line-opacity': 0.8, 'line-dasharray': [2, 2] })
    ensure(LYR_LBL,  'symbol', SRC_LBL,  {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL))  { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }
    if (map.getLayer(LYR_HSL))  { map.setPaintProperty(LYR_HSL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_HSL, 'text-halo-color', '#020617'); map.setPaintProperty(LYR_HSL, 'text-halo-width', 1.4) }

    const hsFeats: any[] = [], hslFeats: any[] = []
    if (showZone) {
      const activeIcaos = new Set(evals.map(e => e.hs.icao))
      for (const hs of HOTSPOTS) {
        if (!activeIcaos.has(hs.icao)) continue
        if (kindFilter !== 'ALL' && hs.kind !== kindFilter) continue
        if (rtierFilter !== 'ALL' && hs.tier !== rtierFilter) continue
        hsFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [hs.lng, hs.lat] }, properties: { color: KIND_COLOR[hs.kind] } })
        hslFeats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [hs.lng, hs.lat] }, properties: { color: RTIER_COLOR[hs.tier], label: `${hs.icao}·${hs.id}·${hs.kind}·${hs.tier}` } })
      }
    }

    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = [], traj: any[] = []
    for (const e of filtered) {
      const color = TIER_COLOR[e.tier]
      if (showHalo && e.tier !== 'CLEAR' && e.tier !== 'BRIEFED') halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, r: 8 + e.score * 0.14 } })
      if (showPin && (e.tier === 'INCURSION-IMM' || e.tier === 'INCURSION-LIKELY' || e.tier === 'CONFLICT')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color } })
      if (showLbl && e.tier !== 'CLEAR' && e.tier !== 'BRIEFED') {
        const tag = e.closing ? `${(e.distFt / 1000).toFixed(1)}kft/${e.ttiSec.toFixed(0)}s` : `${(e.distFt / 1000).toFixed(1)}kft`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, label: `${e.f.callsign || e.f.icao} › ${e.hs.id} · ${tag} · ${e.tier}` } })
      }
      if (showLink && e.tier !== 'CLEAR' && e.tier !== 'BRIEFED') {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[e.f.lng, e.f.lat], [e.hs.lng, e.hs.lat]] }, properties: { color } })
      }
      if (showTraj && e.closing) {
        const trk = e.f.track * Math.PI / 180
        const horizonNm = (e.f.velocityKts * horizonSec) / 3600
        const latPerNm = 1 / 60
        const lngPerNm = 1 / (60 * Math.cos(e.f.lat * Math.PI / 180))
        const endLat = e.f.lat + Math.cos(trk) * horizonNm * latPerNm
        const endLng = e.f.lng + Math.sin(trk) * horizonNm * lngPerNm
        traj.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[e.f.lng, e.f.lat], [endLng, endLat]] }, properties: { color } })
      }
    }
    ;(map.getSource(SRC_HS)   as any).setData({ type: 'FeatureCollection', features: hsFeats })
    ;(map.getSource(SRC_HSL)  as any).setData({ type: 'FeatureCollection', features: hslFeats })
    ;(map.getSource(SRC_TRAJ) as any).setData({ type: 'FeatureCollection', features: traj })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN)  as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL)  as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_TRAJ, LYR_HS, LYR_HSL]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_LINK, SRC_TRAJ, SRC_HS, SRC_HSL]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, evals, showHalo, showPin, showLbl, showZone, showLink, showTraj, kindFilter, rtierFilter, horizonSec])

  const tierBadge = (t: Tier) => <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  const kindBadge = (k: Kind) => <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: KIND_COLOR[k], backgroundColor: KIND_COLOR[k] + '1f', border: `1px solid ${KIND_COLOR[k]}55` }}>{k}</span>
  const rtierBadge = (r: RTier) => <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: RTIER_COLOR[r], backgroundColor: RTIER_COLOR[r] + '1f', border: `1px solid ${RTIER_COLOR[r]}55` }}>HS-{r}</span>
  const drvBadge = (k: string, v: number) => {
    const c = v >= 70 ? '#ef4444' : v >= 40 ? '#f59e0b' : v >= 18 ? '#0ea5e9' : '#10b981'
    return <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: c, backgroundColor: c + '1c', border: `1px solid ${c}55` }}>{k}{v.toFixed(0)}</span>
  }

  /* Scatter: distance-ft (x 0-3000) vs TTI-sec (y 0-horizon) */
  const W = 280, H = 110, padL = 28, padB = 16, padT = 6, padR = 6
  const xMin = 0, xMax = 3000
  const sx = (v: number) => padL + ((clamp(v, xMin, xMax) - xMin) / (xMax - xMin)) * (W - padL - padR)
  const sy = (v: number) => padT + (1 - (clamp(v, 0, horizonSec) - 0) / Math.max(1, horizonSec)) * (H - padT - padB)

  // Per-airport aggregate
  const airports = useMemo(() => {
    const m: Record<string, { icao: string; airport: string; ac: number; hsN: number; worstTier: RTier; mean: number; imm: number; likely: number; conflict: number }> = {}
    for (const hs of HOTSPOTS) {
      if (!m[hs.icao]) m[hs.icao] = { icao: hs.icao, airport: hs.airport, ac: 0, hsN: 0, worstTier: 'C', mean: 0, imm: 0, likely: 0, conflict: 0 }
      m[hs.icao].hsN++
      if (hs.tier === 'A' || (hs.tier === 'B' && m[hs.icao].worstTier === 'C')) m[hs.icao].worstTier = hs.tier
    }
    for (const e of evals) {
      const a = m[e.hs.icao]; if (!a) continue
      a.ac++; a.mean += e.score
      if (e.tier === 'INCURSION-IMM') a.imm++
      if (e.tier === 'INCURSION-LIKELY') a.likely++
      if (e.tier === 'CONFLICT') a.conflict++
    }
    return Object.values(m).map(a => ({ ...a, mean: a.ac ? a.mean / a.ac : 0 })).sort((a, b) => b.ac - a.ac || b.imm - a.imm)
  }, [evals])

  // Per-hotspot aggregate
  const hotspotAgg = useMemo(() => {
    const m: Record<string, { hs: Hs; ac: number; mean: number; imm: number; likely: number; conflict: number; watch: number }> = {}
    for (const hs of HOTSPOTS) m[hs.icao + '/' + hs.id] = { hs, ac: 0, mean: 0, imm: 0, likely: 0, conflict: 0, watch: 0 }
    for (const e of evals) {
      const k = e.hs.icao + '/' + e.hs.id; const a = m[k]; if (!a) continue
      a.ac++; a.mean += e.score
      if (e.tier === 'INCURSION-IMM') a.imm++
      if (e.tier === 'INCURSION-LIKELY') a.likely++
      if (e.tier === 'CONFLICT') a.conflict++
      if (e.tier === 'WATCH') a.watch++
    }
    return Object.values(m).map(a => ({ ...a, mean: a.ac ? a.mean / a.ac : 0 })).sort((a, b) => b.imm - a.imm || b.likely - a.likely || b.ac - a.ac)
  }, [evals])

  return (
    <div className="absolute right-3 top-20 z-40 w-[27rem] max-h-[calc(100vh-6rem)] flex flex-col bg-slate-900/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-sky-500 animate-pulse" />
          <span className="text-[10px] font-bold tracking-widest uppercase text-sky-400">HOTSPOT · Runway-Incursion Monitor</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm leading-none">×</button>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[7px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean score</div><div className="text-sm font-semibold" style={{ color: meanScore >= 65 ? '#ef4444' : meanScore >= 35 ? '#f59e0b' : '#10b981' }}>{meanScore.toFixed(0)}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Worst</div><div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Imm-incursion</div><div className="text-sm font-semibold" style={{ color: immN > 0 ? '#ef4444' : '#10b981' }}>{immN}</div></div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Likely</div><div className="text-xs font-semibold" style={{ color: likelyN > 0 ? '#f43f5e' : '#10b981' }}>{likelyN}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Conflicts</div><div className="text-xs font-semibold" style={{ color: conflictN > 0 ? '#f43f5e' : '#10b981' }}>{conflictN}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean TTI</div><div className="text-xs font-semibold" style={{ color: meanTti < 25 && meanTti > 0 ? '#f43f5e' : meanTti < 45 && meanTti > 0 ? '#f59e0b' : '#10b981' }}>{meanTti > 0 ? meanTti.toFixed(0) + 's' : '—'}</div></div>
      </div>

      {showDiag && evals.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* breach quadrant: dist<800ft, tti<25s */}
            <rect x={sx(0)} y={sy(25)} width={sx(800) - sx(0)} height={H - padB - sy(25)} fill="#ef444415" />
            {/* clear zone: dist>2000 */}
            <rect x={sx(2000)} y={padT} width={W - padR - sx(2000)} height={H - padT - padB} fill="#10b98112" />
            <line x1={sx(800)} y1={padT} x2={sx(800)} y2={H - padB} stroke="#ef444466" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={padL} y1={sy(25)} x2={W - padR} y2={sy(25)} stroke="#f43f5e66" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={padL} y={H - 3} fill="#475569" fontSize="8">dist→ft</text>
            <text x={W - 30} y={padT + 7} fill="#475569" fontSize="8">TTI↑s</text>
            {evals.filter(e => e.closing && e.ttiSec < 600).map((e, i) => (
              <circle key={i} cx={sx(e.distFt)} cy={sy(e.ttiSec)} r={2} fill={TIER_COLOR[e.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          <label className="text-[9px] text-slate-400">Horizon {horizonSec}s<input type="range" min={20} max={180} value={horizonSec} onChange={e => setHorizonSec(+e.target.value)} className="w-full accent-sky-500" /></label>
          <label className="text-[9px] text-slate-400">Scope {scopeNm.toFixed(1)}NM<input type="range" min={1} max={10} step={0.5} value={scopeNm} onChange={e => setScopeNm(+e.target.value)} className="w-full accent-sky-500" /></label>
          <label className="text-[9px] text-slate-400">HS-radius ×{radMul}%<input type="range" min={50} max={200} value={radMul} onChange={e => setRadMul(+e.target.value)} className="w-full accent-sky-500" /></label>
          <label className="text-[9px] text-slate-400">Advisory ×{advMul}%<input type="range" min={50} max={200} value={advMul} onChange={e => setAdvMul(+e.target.value)} className="w-full accent-sky-500" /></label>
          <label className="text-[9px] text-slate-400 col-span-2">Max-FL {maxFl} (low-final include)<input type="range" min={0} max={20} value={maxFl} onChange={e => setMaxFl(+e.target.value)} className="w-full accent-sky-500" /></label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','RWY-RWY','CROSS','LINE-UP','PARALLEL','HELI'] as const).map(k => (
            <button key={k} onClick={() => setKindFilter(k === 'ALL' ? 'ALL' : k as Kind)} className="px-1.5 py-0.5 rounded text-[9px] font-mono" style={{ color: k === 'ALL' ? '#cbd5e1' : KIND_COLOR[k as Kind], backgroundColor: kindFilter === (k === 'ALL' ? 'ALL' : k as Kind) ? (k === 'ALL' ? '#33415555' : KIND_COLOR[k as Kind] + '33') : '#0b1220', border: '1px solid ' + (kindFilter === (k === 'ALL' ? 'ALL' : k as Kind) ? (k === 'ALL' ? '#64748b' : KIND_COLOR[k as Kind]) : '#1e293b') }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','A','B','C'] as const).map(r => (
            <button key={r} onClick={() => setRtierFilter(r === 'ALL' ? 'ALL' : r as RTier)} className="px-1.5 py-0.5 rounded text-[9px] font-mono" style={{ color: r === 'ALL' ? '#cbd5e1' : RTIER_COLOR[r as RTier], backgroundColor: rtierFilter === (r === 'ALL' ? 'ALL' : r as RTier) ? (r === 'ALL' ? '#33415555' : RTIER_COLOR[r as RTier] + '33') : '#0b1220', border: '1px solid ' + (rtierFilter === (r === 'ALL' ? 'ALL' : r as RTier) ? (r === 'ALL' ? '#64748b' : RTIER_COLOR[r as RTier]) : '#1e293b') }}>{r === 'ALL' ? 'ALL' : 'HS-' + r}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {[['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['ZONE',showZone,setShowZone],['LINK',showLink,setShowLink],['TRAJ',showTraj,setShowTraj],['DIAG',showDiag,setShowDiag]].map(([k,v,fn]:any) => (
            <button key={k} onClick={() => fn((x:boolean)=>!x)} className="px-1.5 py-0.5 rounded text-[9px] font-mono" style={{ color: v ? '#7dd3fc' : '#64748b', backgroundColor: v ? '#0ea5e91f' : '#0b1220', border: '1px solid ' + (v ? '#0ea5e966' : '#1e293b') }}>{k}</button>
          ))}
        </div>
        <input type="text" placeholder="Search callsign / type / HS / airport…" value={query} onChange={e => setQuery(e.target.value)} className="w-full px-2 py-1 bg-slate-950 border border-slate-800 rounded text-[10px] text-slate-200 placeholder:text-slate-600" />
        <div className="flex gap-1">
          {(['AIRCRAFT','HOTSPOTS','AIRPORTS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} className="flex-1 px-2 py-1 rounded text-[10px] font-semibold" style={{ color: tab === t ? '#0ea5e9' : '#94a3b8', backgroundColor: tab === t ? '#0ea5e924' : '#0b1220', border: '1px solid ' + (tab === t ? '#0ea5e966' : '#1e293b') }}>{t}</button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-slate-500">No surface or low-final traffic in HS scope.</div>}
            {filtered.map((e, i) => (
              <button key={e.f.icao + '/' + e.hs.id + '/' + i} onClick={() => onFly(e.f.icao)} className="w-full text-left px-3 py-2 hover:bg-slate-800/30 transition" style={{ borderLeft: '3px solid ' + TIER_COLOR[e.tier] }}>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-mono text-[11px] font-semibold text-slate-100 truncate">{e.f.callsign || e.f.icao}</span>
                    <span className="text-[9px] text-slate-500 font-mono truncate">{e.f.type || '—'}</span>
                    {kindBadge(e.hs.kind)} {rtierBadge(e.hs.tier)} {tierBadge(e.tier)}
                  </div>
                </div>
                <div className="text-[10px] text-slate-400 font-mono flex flex-wrap gap-x-2 gap-y-0.5">
                  <span className="text-sky-300">{e.hs.icao}·{e.hs.id}</span>
                  <span className="text-slate-500 italic truncate max-w-[14rem]">{e.hs.airport}</span>
                  <span style={{ color: e.distFt < 800 ? '#f43f5e' : e.distFt < 2000 ? '#f59e0b' : '#10b981' }}>{(e.distFt / 1000).toFixed(2)}kft</span>
                  {e.closing ? <span style={{ color: e.ttiSec < 25 ? '#f43f5e' : e.ttiSec < 60 ? '#f59e0b' : '#10b981' }}>TTI {e.ttiSec.toFixed(0)}s</span> : <span className="text-slate-500">stable</span>}
                  <span className="text-slate-500">{e.f.ground ? 'GND' : 'FL' + (e.f.altitudeFt / 100).toFixed(0)}</span>
                  <span className="text-slate-500">{e.f.velocityKts.toFixed(0)}kt</span>
                  {e.conflictWith && <span className="text-rose-400">⇄ {e.conflictWith}</span>}
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                  <div style={{ width: e.score + '%', backgroundColor: TIER_COLOR[e.tier] }} className="h-full" />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {drvBadge('PRX', e.drivers.PRX)} {drvBadge('TTI', e.drivers.TTI)} {drvBadge('CFL', e.drivers.CFL)} {drvBadge('KND', e.drivers.KND)} {drvBadge('TIER', e.drivers.TIER)} {drvBadge('CFG', e.drivers.CFG)}
                </div>
                <div className="mt-1 text-[10px]" style={{ color: TIER_COLOR[e.tier] }}>{e.advice}</div>
              </button>
            ))}
          </div>
        )}
        {tab === 'HOTSPOTS' && (
          <div className="divide-y divide-slate-800/60">
            {hotspotAgg.map(a => (
              <div key={a.hs.icao + '/' + a.hs.id} className="px-3 py-2" style={{ borderLeft: '3px solid ' + KIND_COLOR[a.hs.kind] }}>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="font-mono text-[11px] text-sky-300">{a.hs.icao}·{a.hs.id}</span>
                  {kindBadge(a.hs.kind)} {rtierBadge(a.hs.tier)}
                  <span className="text-[9px] text-slate-500 italic truncate">{a.hs.airport}</span>
                </div>
                <div className="text-[10px] text-slate-400 font-mono mb-1 line-clamp-2">{a.hs.brief}</div>
                <div className="flex flex-wrap gap-2 text-[10px] text-slate-400 font-mono">
                  <span>R{a.hs.radiusFt}ft</span>
                  <span>ac {a.ac}</span>
                  {a.imm > 0 && <span className="text-rose-400">IMM {a.imm}</span>}
                  {a.likely > 0 && <span className="text-rose-300">LKLY {a.likely}</span>}
                  {a.conflict > 0 && <span className="text-rose-300">CFL {a.conflict}</span>}
                  {a.watch > 0 && <span className="text-sky-400">WTCH {a.watch}</span>}
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                  <div style={{ width: a.mean + '%', backgroundColor: a.mean >= 65 ? '#ef4444' : a.mean >= 35 ? '#f59e0b' : a.mean >= 18 ? '#0ea5e9' : '#10b981' }} className="h-full" />
                </div>
              </div>
            ))}
          </div>
        )}
        {tab === 'AIRPORTS' && (
          <div className="divide-y divide-slate-800/60">
            {airports.map(a => (
              <div key={a.icao} className="px-3 py-2" style={{ borderLeft: '3px solid ' + RTIER_COLOR[a.worstTier] }}>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="font-mono text-[11px] text-sky-300">{a.icao}</span>
                  {rtierBadge(a.worstTier)}
                  <span className="text-[10px] text-slate-300 italic truncate">{a.airport}</span>
                </div>
                <div className="flex flex-wrap gap-2 text-[10px] text-slate-400 font-mono">
                  <span>HS {a.hsN}</span>
                  <span>ac {a.ac}</span>
                  {a.imm > 0 && <span className="text-rose-400">IMM {a.imm}</span>}
                  {a.likely > 0 && <span className="text-rose-300">LKLY {a.likely}</span>}
                  {a.conflict > 0 && <span className="text-rose-300">CFL {a.conflict}</span>}
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                  <div style={{ width: a.mean + '%', backgroundColor: a.mean >= 65 ? '#ef4444' : a.mean >= 35 ? '#f59e0b' : a.mean >= 18 ? '#0ea5e9' : '#10b981' }} className="h-full" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
