'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TCAM · Tropical Cyclone Avoidance & Eye-Wall Standoff Monitor
   ------------------------------------------------------------
   Per-airframe proximity & avoidance scorer for active tropical
   cyclones (TC) in the 7 RSMC basins, scoring each aircraft on:
     · STD  standoff distance vs storm radius (R64/R50/R34)
     · CAT  Saffir-Simpson / JMA / IMD category severity
     · CNV  track-to-eye convergence (bearing vs course)
     · TOP  cruise FL vs convective-top forecast tropopause penetration
     · FRC  forecast-position drift uncertainty (cone-of-error)
     · TRK  recommended detour distance per FCTM 5.50 (20 NM downwind
            of eye wall, 50 NM upwind of intense convection)

   Wind-radii definition (per WMO Manual on TC Forecasting v1194 §4.6):
     R64 NM = 64 kt wind radius (hurricane-force / typhoon-force)
     R50 NM = 50 kt wind radius (storm-force)
     R34 NM = 34 kt wind radius (tropical-storm-force / gale-force)
     Per FAA AC 00-24C / Boeing FCTM 5.50 — aircraft MUST remain
     clear of R64 by 20 NM minimum and SHOULD avoid R50 entirely
     in cruise. Penetration of R64 = mandatory diversion event.

   Category ladder Saffir-Simpson (Atlantic / Eastern Pacific):
     TD  ≤ 33 kt  / TS 34-63 / C1 64-82 / C2 83-95 / C3 96-112
     C4 113-136 / C5 ≥ 137  per NHC SSHWS 2012
   JMA (Western Pacific Typhoon):
     TS 34-47 / STS 48-63 / TY 64-84 / STY 85-104 / VSTY ≥ 105
   IMD (North Indian) cyclonic-storm / VSCS / ESCS / SuCS
   BOM (Australian) CAT1-5
   Reunion (SW Indian) MTC / ITC / VITC

   Hazards: 80kt+ horizontal turbulence in eye-wall, 8000fpm updrafts,
   icing > FL150, hail to FL550 in C4+, satellite mis-correlation
   inside eye, GNSS multi-path in eye-wall scatterers.

   References:
     · ICAO Annex 3 App 1 §1 SIGMET TC criteria
     · ICAO Annex 3 App 5 TCAC Tropical Cyclone Advisory format
     · ICAO Doc 9817 World Area Forecast System Manual §3.7
     · ICAO Doc 9874 Manual of Hazardous Weather
     · WMO Manual on Tropical Cyclones WMO-No. 1194 §4.6 wind radii
     · WMO TC Programme TCP-31 Operational Plan
     · NOAA NHC SSHWS 2012 Saffir-Simpson revised
     · JMA RSMC Tokyo Typhoon Center Operational Manual §3
     · IMD RSMC New Delhi Cyclone Warning Guidelines 2021
     · BOM Tropical Cyclone Operational Procedures 2022
     · Meteo-France RSMC La Reunion TC Bulletin format
     · FAA AC 00-24C Thunderstorms §11 Tropical Cyclones
     · FAA AC 00-45H Aviation Weather Services §5 TCA
     · FAA AC 91-79A App Performance in Adverse Weather
     · FAA Order 7110.65 §2-6-4 SIGMET dissemination
     · Boeing FCTM 5.50 Adverse Weather / TC avoidance §5.51
     · Airbus Getting to Grips with Adverse Weather §6 TC
     · IATA Adverse Weather Operations FCG-005 §4
     · NTSB AAR-86-03 Pan Am 759 KMSY microburst-TC related
     · NTSB AAB-94-02 USAir 1016 KCLT downburst
     · AAIB Bulletin 6/2017 G-EUOG inadvertent TC over-flight
     · NHC Tropical Cyclone Report Hurricane Hugo 1989 § DC-10 ovfly
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'EYE-WALL' | 'R64-PEN' | 'R50-PEN' | 'R34-PEN' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'EYE-WALL': '#ef4444', 'R64-PEN': '#f43f5e', 'R50-PEN': '#fb7185',
  'R34-PEN': '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['EYE-WALL', 'R64-PEN', 'R50-PEN', 'R34-PEN', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { 'EYE-WALL': 0, 'R64-PEN': 1, 'R50-PEN': 2, 'R34-PEN': 3, WATCH: 4, OK: 5, IDLE: 6 }

type Basin = 'NATL' | 'EPAC' | 'CPAC' | 'WPAC' | 'NIO' | 'SIO' | 'SPAC'
const BASIN_COLOR: Record<Basin, string> = {
  NATL: '#0ea5e9', EPAC: '#22d3ee', CPAC: '#06b6d4', WPAC: '#a855f7',
  NIO: '#f59e0b', SIO: '#10b981', SPAC: '#8b5cf6',
}
const BASIN_RSMC: Record<Basin, string> = {
  NATL: 'NHC Miami', EPAC: 'NHC Miami', CPAC: 'CPHC Honolulu',
  WPAC: 'RSMC Tokyo · JMA', NIO: 'RSMC New Delhi · IMD',
  SIO: 'RSMC La Reunion · MFR', SPAC: 'RSMC Nadi · FMS',
}

type Cat = 'TD' | 'TS' | 'C1' | 'C2' | 'C3' | 'C4' | 'C5'
const CAT_COLOR: Record<Cat, string> = {
  TD: '#10b981', TS: '#0ea5e9', C1: '#22d3ee', C2: '#f59e0b',
  C3: '#fb923c', C4: '#f43f5e', C5: '#ef4444',
}

interface Cyclone {
  id: string; name: string; basin: Basin
  lat: number; lng: number
  cat: Cat; vmaxKt: number; mslpHpa: number
  /** Eye radius NM (typically 5-30) */
  eyeNm: number
  /** Wind-radii NM (R64 / R50 / R34) — average quadrant */
  r64Nm: number; r50Nm: number; r34Nm: number
  /** Forecast motion */
  bearingDeg: number; speedKt: number
  /** Convective-top FL — TC overshooting tops can exceed FL550 in C4+ */
  topFl: number
  /** Forecast cone-of-error half-angle deg */
  coneDeg: number
}

/* ---- Synthetic but climatologically representative TC catalogue ----
   12 active storms across all 7 basins, mid-season distribution.
   In production this would feed from NHC / JMA / IMD ATCF / BUFR feeds. */
const CYC: Cyclone[] = [
  // North Atlantic — peak Aug-Oct
  { id: 'AL14', name: 'KIRK',    basin: 'NATL', lat: 19.4, lng: -52.8, cat: 'C3', vmaxKt: 105, mslpHpa: 962, eyeNm: 14, r64Nm:  35, r50Nm:  85, r34Nm: 180, bearingDeg: 290, speedKt: 11, topFl: 540, coneDeg: 12 },
  { id: 'AL15', name: 'LESLIE',  basin: 'NATL', lat: 26.1, lng: -68.4, cat: 'C1', vmaxKt:  72, mslpHpa: 988, eyeNm: 22, r64Nm:  18, r50Nm:  55, r34Nm: 140, bearingDeg:  35, speedKt:  9, topFl: 480, coneDeg: 14 },
  // Eastern Pacific
  { id: 'EP12', name: 'JOHN',    basin: 'EPAC', lat: 16.8, lng:-105.3, cat: 'C4', vmaxKt: 125, mslpHpa: 944, eyeNm: 11, r64Nm:  45, r50Nm:  95, r34Nm: 195, bearingDeg: 305, speedKt:  8, topFl: 560, coneDeg: 10 },
  // Central Pacific
  { id: 'CP02', name: 'HONE',    basin: 'CPAC', lat: 18.2, lng:-156.1, cat: 'C2', vmaxKt:  88, mslpHpa: 975, eyeNm: 18, r64Nm:  28, r50Nm:  70, r34Nm: 160, bearingDeg: 275, speedKt: 12, topFl: 510, coneDeg: 13 },
  // Western Pacific — peak Jul-Oct
  { id: 'WP11', name: 'YAGI',    basin: 'WPAC', lat: 19.7, lng: 125.4, cat: 'C5', vmaxKt: 142, mslpHpa: 916, eyeNm:  9, r64Nm:  52, r50Nm: 110, r34Nm: 235, bearingDeg: 290, speedKt: 13, topFl: 580, coneDeg:  9 },
  { id: 'WP12', name: 'BEBINCA', basin: 'WPAC', lat: 28.3, lng: 138.7, cat: 'C2', vmaxKt:  82, mslpHpa: 978, eyeNm: 20, r64Nm:  25, r50Nm:  65, r34Nm: 155, bearingDeg: 320, speedKt: 15, topFl: 500, coneDeg: 14 },
  { id: 'WP13', name: 'PULASAN', basin: 'WPAC', lat: 23.1, lng: 132.8, cat: 'TS', vmaxKt:  48, mslpHpa: 996, eyeNm: 30, r64Nm:   0, r50Nm:  30, r34Nm: 110, bearingDeg: 285, speedKt: 10, topFl: 440, coneDeg: 18 },
  // North Indian — Oct-Nov peak
  { id: 'BB04', name: 'DANA',    basin: 'NIO',  lat: 17.2, lng:  87.6, cat: 'C2', vmaxKt:  85, mslpHpa: 976, eyeNm: 18, r64Nm:  26, r50Nm:  68, r34Nm: 160, bearingDeg: 320, speedKt:  9, topFl: 505, coneDeg: 13 },
  { id: 'AB02', name: 'ASNA',    basin: 'NIO',  lat: 21.4, lng:  64.8, cat: 'TS', vmaxKt:  52, mslpHpa: 992, eyeNm: 28, r64Nm:   0, r50Nm:  35, r34Nm: 120, bearingDeg: 270, speedKt:  8, topFl: 455, coneDeg: 16 },
  // South Indian — Jan-Mar peak
  { id: 'SI06', name: 'CHIDO',   basin: 'SIO',  lat:-13.8, lng:  52.4, cat: 'C4', vmaxKt: 118, mslpHpa: 948, eyeNm: 12, r64Nm:  40, r50Nm:  90, r34Nm: 190, bearingDeg: 265, speedKt: 14, topFl: 555, coneDeg: 11 },
  // South Pacific
  { id: 'SP03', name: 'RAE',     basin: 'SPAC', lat:-17.1, lng: 178.8, cat: 'C3', vmaxKt:  98, mslpHpa: 968, eyeNm: 16, r64Nm:  32, r50Nm:  78, r34Nm: 170, bearingDeg: 210, speedKt: 11, topFl: 525, coneDeg: 12 },
  { id: 'SP04', name: 'TAM',     basin: 'SPAC', lat:-22.4, lng:-168.2, cat: 'C1', vmaxKt:  68, mslpHpa: 985, eyeNm: 22, r64Nm:  20, r50Nm:  58, r34Nm: 145, bearingDeg: 180, speedKt:  9, topFl: 470, coneDeg: 15 },
]

/* ---- Math helpers ---- */
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const ramp  = (v: number, a: number, b: number) => clamp((v - a) / (b - a), 0, 1) * 100
const D2R = Math.PI / 180, R2D = 180 / Math.PI

function nm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3440.065
  const dLat = (b.lat - a.lat) * D2R
  const dLng = (b.lng - a.lng) * D2R
  const lat1 = a.lat * D2R, lat2 = b.lat * D2R
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}
function bearingTo(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const φ1 = a.lat * D2R, φ2 = b.lat * D2R
  const dλ = (b.lng - a.lng) * D2R
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * R2D + 360) % 360
}
function angDiff(a: number, b: number): number {
  let d = ((a - b + 540) % 360) - 180
  return Math.abs(d)
}
function destPoint(p: { lat: number; lng: number }, brgDeg: number, distNm: number): { lat: number; lng: number } {
  const R = 3440.065
  const δ = distNm / R
  const θ = brgDeg * D2R
  const φ1 = p.lat * D2R, λ1 = p.lng * D2R
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return { lat: φ2 * R2D, lng: ((λ2 * R2D + 540) % 360) - 180 }
}

type Phase = 'CRZ' | 'DES' | 'CLB' | 'TERM' | 'IDLE'
function phase(f: SFlight): Phase {
  if (f.ground) return 'IDLE'
  if (f.altitudeFt < 6000) return 'TERM'
  if (f.vertRate > 500 && f.altitudeFt < 28000) return 'CLB'
  if (f.vertRate < -500 && f.altitudeFt < 28000) return 'DES'
  return 'CRZ'
}

/* ---- Per-aircraft TC eval ---- */
interface Drv { STD: number; CAT: number; CNV: number; TOP: number; FRC: number; TRK: number }
interface Ev {
  f: SFlight; cyc: Cyclone; phase: Phase
  distNm: number; bearingToEye: number; convergeDeg: number
  band: 'EYE' | 'R64' | 'R50' | 'R34' | 'OUT'
  recDetourNm: number; standoffMargin: number
  fl: number; topMarginFl: number
  forecast3hNm: number  // forecast 3h displacement
  score: number; tier: Tier; advice: string
  drv: Drv
}

function bandFor(distNm: number, c: Cyclone): Ev['band'] {
  if (distNm < c.eyeNm) return 'EYE'
  if (c.r64Nm > 0 && distNm < c.r64Nm) return 'R64'
  if (distNm < c.r50Nm) return 'R50'
  if (distNm < c.r34Nm) return 'R34'
  return 'OUT'
}

function catSeverity(c: Cat): number {
  return { TD: 10, TS: 25, C1: 45, C2: 60, C3: 75, C4: 88, C5: 100 }[c]
}

function evaluate(flights: SFlight[], scopeNm: number, advMul: number, stdMul: number, cnvMul: number, topMul: number, minFl: number): Ev[] {
  const out: Ev[] = []
  for (const f of flights) {
    if (f.ground) continue
    const fl = Math.round(f.altitudeFt / 100)
    if (fl < minFl) continue
    let bestC: Cyclone | undefined
    let bestD = scopeNm
    for (const c of CYC) {
      const d = nm({ lat: f.lat, lng: f.lng }, { lat: c.lat, lng: c.lng })
      if (d < bestD) { bestD = d; bestC = c }
    }
    if (!bestC) continue
    const ph = phase(f)
    const brg = bearingTo({ lat: f.lat, lng: f.lng }, { lat: bestC.lat, lng: bestC.lng })
    const conv = 180 - angDiff(f.track, brg)  // 180 = head-on into TC, 0 = flying away
    const band = bandFor(bestD, bestC)
    // FCTM 5.50 recommended detour = max( R64+20, R50, eye+60 )
    const recDetour = Math.max((bestC.r64Nm > 0 ? bestC.r64Nm + 20 : 0), bestC.r50Nm, bestC.eyeNm + 60)
    const standoff = bestD - recDetour  // negative = inside detour zone
    const topMarginFl = bestC.topFl - fl  // negative = above convective top (cleared)
    const f3 = bestC.speedKt * 3  // 3h forecast displacement NM

    const drv: Drv = {
      STD: ramp(-standoff, 0, recDetour) * (stdMul / 100),
      CAT: catSeverity(bestC.cat),
      CNV: ramp(conv, 60, 180) * (cnvMul / 100),
      TOP: topMarginFl > 0 ? ramp(topMarginFl, 0, 100) * (topMul / 100) : 0,
      FRC: ramp(bestC.coneDeg * f3 / 50, 0, 60),
      TRK: ramp(-standoff + (conv > 120 ? 30 : 0), 0, recDetour),
    }
    const phMul = ph === 'CRZ' ? 1.10 : ph === 'DES' ? 1.05 : ph === 'CLB' ? 1.00 : ph === 'TERM' ? 0.90 : 0
    const arr = [drv.STD, drv.CAT, drv.CNV, drv.TOP, drv.FRC, drv.TRK]
    const max = Math.max(...arr)
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length
    let score = clamp((max * 0.78 + mean * 0.22) * phMul * (advMul / 100), 0, 100)

    // Hard escalations
    if (band === 'EYE') score = Math.max(score, 100)
    if (band === 'R64' && (bestC.cat === 'C4' || bestC.cat === 'C5')) score = Math.max(score, 95)
    if (band === 'R64') score = Math.max(score, 88)
    if (band === 'R50' && topMarginFl > 0) score = Math.max(score, 72)

    let tier: Tier = 'OK'
    let advice = `Clear of ${bestC.name} R34 ${bestC.r34Nm}NM cluster · maintain ${recDetour}NM standoff per Boeing FCTM 5.50 / Airbus GTG Adverse Weather §6`
    if (band === 'EYE') {
      tier = 'EYE-WALL'
      advice = `EYE-WALL PENETRATION ${bestC.name} · expect 80+kt turbulence / 8000fpm vert · DIVERT NOW per FAA AC 00-24C §11 / FCTM 5.51`
    } else if (band === 'R64') {
      tier = 'R64-PEN'
      advice = `R64 ${bestC.cat} ${bestC.name} hurricane-force core penetration · request immediate vector around storm · WMO 1194 §4.6 / SIGMET per Annex 3 App 1`
    } else if (band === 'R50') {
      tier = 'R50-PEN'
      advice = `R50 storm-force band ${bestC.name} · ride is unacceptable cruise · request offset >${(bestC.r64Nm + 20).toFixed(0)}NM per FCTM 5.50`
    } else if (band === 'R34') {
      tier = 'R34-PEN'
      advice = `R34 ${bestC.name} TS-force band · cabin secure · expect mod-to-sev turbulence · AC 00-24C §11 / FCG-005 §4`
    } else if (score >= 22) {
      tier = 'WATCH'
      advice = `WATCH ${bestC.name} (${bestC.cat} ${bestC.vmaxKt}kt) outside R34 but forecast cone covers track · monitor TCAC per ICAO Annex 3 App 5`
    }

    out.push({
      f, cyc: bestC, phase: ph,
      distNm: bestD, bearingToEye: brg, convergeDeg: conv, band,
      recDetourNm: recDetour, standoffMargin: standoff,
      fl, topMarginFl, forecast3hNm: f3,
      score, tier, advice, drv,
    })
  }
  out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  return out
}

/* ---- Component ---- */
const SRC_HALO='tcam-halo', SRC_PIN='tcam-pin', SRC_LBL='tcam-lbl', SRC_LINK='tcam-link'
const SRC_EYE='tcam-eye', SRC_R64='tcam-r64', SRC_R50='tcam-r50', SRC_R34='tcam-r34'
const SRC_FCST='tcam-fcst', SRC_ELBL='tcam-elbl'
const LYR_HALO='tcam-halo-l', LYR_PIN='tcam-pin-l', LYR_LBL='tcam-lbl-l', LYR_LINK='tcam-link-l'
const LYR_EYE='tcam-eye-l', LYR_R64='tcam-r64-l', LYR_R50='tcam-r50-l', LYR_R34='tcam-r34-l'
const LYR_FCST='tcam-fcst-l', LYR_ELBL='tcam-elbl-l'

function circlePoly(c: { lat: number; lng: number }, radiusNm: number, steps = 64): number[][] {
  const pts: number[][] = []
  for (let i = 0; i <= steps; i++) {
    const b = (360 * i) / steps
    const p = destPoint(c, b, radiusNm)
    pts.push([p.lng, p.lat])
  }
  return pts
}

export default function TcamCyclone({ map, flights, onClose, onFly }: Props) {
  const [scope, setScope] = useState(400)
  const [advMul, setAdvMul] = useState(100)
  const [stdMul, setStdMul] = useState(100)
  const [cnvMul, setCnvMul] = useState(100)
  const [topMul, setTopMul] = useState(100)
  const [minFl, setMinFl]   = useState(50)
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [basinFilter, setBasinFilter] = useState<Basin | 'ALL'>('ALL')
  const [catFilter, setCatFilter] = useState<Cat | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'STORMS' | 'BASINS'>('AIRCRAFT')
  const [query, setQuery] = useState('')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin]   = useState(true)
  const [showLbl, setShowLbl]   = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showRings, setShowRings] = useState(true)
  const [showFcst, setShowFcst] = useState(true)
  const [showDiag, setShowDiag] = useState(true)

  const evals = useMemo(() => evaluate(flights, scope, advMul, stdMul, cnvMul, topMul, minFl),
    [flights, scope, advMul, stdMul, cnvMul, topMul, minFl])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return evals.filter(e => {
      if (basinFilter !== 'ALL' && e.cyc.basin !== basinFilter) return false
      if (catFilter !== 'ALL' && e.cyc.cat !== catFilter) return false
      if (tierFilter !== 'ALL' && e.tier !== tierFilter) return false
      if (q) {
        const blob = `${e.f.callsign} ${e.f.icao} ${e.f.type} ${e.f.operator} ${e.cyc.id} ${e.cyc.name} ${e.cyc.basin}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [evals, basinFilter, catFilter, tierFilter, query])

  const tierCount: Record<Tier, number> = { 'EYE-WALL': 0, 'R64-PEN': 0, 'R50-PEN': 0, 'R34-PEN': 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const e of evals) tierCount[e.tier]++
  const meanScore = evals.length ? evals.reduce((s, e) => s + e.score, 0) / evals.length : 0
  const worst = evals[0]
  const r64pen = evals.filter(e => e.band === 'EYE' || e.band === 'R64').length
  const r50pen = evals.filter(e => e.band === 'R50').length
  const maxCat = CYC.reduce((m, c) => Math.max(m, catSeverity(c.cat)), 0)

  /* Map layers */
  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any)
    }
    ensure(LYR_R34, 'fill', SRC_R34, { 'fill-color': ['get', 'color'], 'fill-opacity': 0.06 })
    ensure(LYR_R50, 'fill', SRC_R50, { 'fill-color': ['get', 'color'], 'fill-opacity': 0.10 })
    ensure(LYR_R64, 'fill', SRC_R64, { 'fill-color': ['get', 'color'], 'fill-opacity': 0.18 })
    ensure(LYR_EYE, 'fill', SRC_EYE, { 'fill-color': ['get', 'color'], 'fill-opacity': 0.45, 'fill-outline-color': '#fff' })
    ensure(LYR_FCST, 'line', SRC_FCST, { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.7, 'line-dasharray': [3, 2] })
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN, 'circle', SRC_PIN, { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_LINK, 'line', SRC_LINK, { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.85, 'line-dasharray': [2, 2] })
    ensure(LYR_LBL, 'symbol', SRC_LBL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    ensure(LYR_ELBL, 'symbol', SRC_ELBL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, -1.2], 'text-anchor': 'bottom', 'text-font': ['Open Sans Bold'] })
    if (map.getLayer(LYR_LBL))  { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }
    if (map.getLayer(LYR_ELBL)) { map.setPaintProperty(LYR_ELBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_ELBL, 'text-halo-color', '#020617'); map.setPaintProperty(LYR_ELBL, 'text-halo-width', 1.6) }

    const eye: any[] = [], r64: any[] = [], r50: any[] = [], r34: any[] = []
    const fcst: any[] = [], elbl: any[] = []
    if (showRings) {
      for (const c of CYC) {
        if (basinFilter !== 'ALL' && c.basin !== basinFilter) continue
        if (catFilter !== 'ALL' && c.cat !== catFilter) continue
        const col = CAT_COLOR[c.cat]
        if (c.r34Nm > 0) r34.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [circlePoly(c, c.r34Nm)] }, properties: { color: '#f59e0b' } })
        if (c.r50Nm > 0) r50.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [circlePoly(c, c.r50Nm)] }, properties: { color: '#fb7185' } })
        if (c.r64Nm > 0) r64.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [circlePoly(c, c.r64Nm)] }, properties: { color: '#f43f5e' } })
        eye.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [circlePoly(c, c.eyeNm)] }, properties: { color: col } })
        elbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { color: col, label: `${c.name} ${c.cat}·${c.vmaxKt}kt` } })
        if (showFcst) {
          // 24h forecast track segment
          const p24 = destPoint(c, c.bearingDeg, c.speedKt * 24)
          fcst.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[c.lng, c.lat], [p24.lng, p24.lat]] }, properties: { color: col } })
        }
      }
    }
    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = []
    for (const e of filtered) {
      const color = TIER_COLOR[e.tier]
      if (showHalo && e.tier !== 'IDLE' && e.tier !== 'OK') halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, r: 8 + e.score * 0.14 } })
      if (showPin && (e.tier === 'EYE-WALL' || e.tier === 'R64-PEN' || e.tier === 'R50-PEN')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color } })
      if (showLbl && e.tier !== 'OK' && e.tier !== 'IDLE') {
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, label: `${e.f.callsign || e.f.icao} › ${e.cyc.name} ${e.distNm.toFixed(0)}NM · ${e.tier}` } })
      }
      if (showLink && e.tier !== 'OK' && e.tier !== 'IDLE') {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[e.f.lng, e.f.lat], [e.cyc.lng, e.cyc.lat]] }, properties: { color } })
      }
    }
    ;(map.getSource(SRC_EYE)  as any).setData({ type: 'FeatureCollection', features: eye })
    ;(map.getSource(SRC_R64)  as any).setData({ type: 'FeatureCollection', features: r64 })
    ;(map.getSource(SRC_R50)  as any).setData({ type: 'FeatureCollection', features: r50 })
    ;(map.getSource(SRC_R34)  as any).setData({ type: 'FeatureCollection', features: r34 })
    ;(map.getSource(SRC_FCST) as any).setData({ type: 'FeatureCollection', features: fcst })
    ;(map.getSource(SRC_ELBL) as any).setData({ type: 'FeatureCollection', features: elbl })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN)  as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL)  as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_EYE, LYR_R64, LYR_R50, LYR_R34, LYR_FCST, LYR_ELBL]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_LINK, SRC_EYE, SRC_R64, SRC_R50, SRC_R34, SRC_FCST, SRC_ELBL]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, evals, showHalo, showPin, showLbl, showLink, showRings, showFcst, basinFilter, catFilter])

  const tierBadge = (t: Tier) => <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  const catBadge = (c: Cat) => <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: CAT_COLOR[c], backgroundColor: CAT_COLOR[c] + '1f', border: `1px solid ${CAT_COLOR[c]}55` }}>{c}</span>
  const basinBadge = (b: Basin) => <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: BASIN_COLOR[b], backgroundColor: BASIN_COLOR[b] + '1f', border: `1px solid ${BASIN_COLOR[b]}55` }}>{b}</span>
  const drvBadge = (k: string, v: number) => {
    const c = v >= 70 ? '#ef4444' : v >= 40 ? '#f59e0b' : v >= 18 ? '#0ea5e9' : '#10b981'
    return <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: c, backgroundColor: c + '1c', border: `1px solid ${c}55` }}>{k}{v.toFixed(0)}</span>
  }
  const tcol = (v: number, breaks: [number, string][]) => { for (const [t, c] of breaks) if (v >= t) return c; return '#10b981' }

  /* Scatter: distance NM (x) vs convergence deg (y) */
  const W = 280, H = 110, padL = 26, padB = 16, padT = 6, padR = 6
  const xMin = 0, xMax = scope
  const yMin = 0, yMax = 180
  const sx = (v: number) => padL + ((v - xMin) / (xMax - xMin)) * (W - padL - padR)
  const sy = (v: number) => padT + ((yMax - v) / (yMax - yMin)) * (H - padT - padB)

  return (
    <div className="absolute right-3 top-20 z-40 w-[26rem] max-h-[calc(100vh-6rem)] flex flex-col bg-slate-900/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-sky-500 animate-pulse" />
          <span className="text-[10px] font-bold tracking-widest uppercase text-sky-400">TCAM · Tropical Cyclone Avoidance</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm leading-none">×</button>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[8px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean score</div><div className="text-sm font-semibold" style={{ color: tcol(meanScore, [[65,'#ef4444'],[35,'#f59e0b'],[18,'#0ea5e9']]) }}>{meanScore.toFixed(0)}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Worst</div><div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">R64+EYE</div><div className="text-sm font-semibold" style={{ color: r64pen > 0 ? '#ef4444' : '#10b981' }}>{r64pen}</div></div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">R50-pen</div><div className="text-xs font-semibold text-rose-400">{r50pen}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Storms</div><div className="text-xs font-semibold text-sky-400">{CYC.length}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Max cat</div><div className="text-xs font-semibold" style={{ color: maxCat >= 88 ? '#ef4444' : maxCat >= 60 ? '#f59e0b' : '#0ea5e9' }}>{CYC.reduce((a, b) => catSeverity(a.cat) >= catSeverity(b.cat) ? a : b).cat}</div></div>
      </div>

      {showDiag && evals.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* breach quadrant: dist<100 conv>120 */}
            <rect x={sx(0)} y={sy(180)} width={sx(100) - sx(0)} height={sy(120) - sy(180)} fill="#ef444418" />
            {/* OK band: dist>200 */}
            <rect x={sx(200)} y={padT} width={W - padR - sx(200)} height={H - padB - padT} fill="#10b98112" />
            <line x1={sx(100)} y1={padT} x2={sx(100)} y2={H - padB} stroke="#ef444466" strokeDasharray="3 3" strokeWidth={0.5} />
            <line x1={sx(200)} y1={padT} x2={sx(200)} y2={H - padB} stroke="#10b98166" strokeDasharray="3 3" strokeWidth={0.5} />
            <line x1={padL} y1={sy(120)} x2={W - padR} y2={sy(120)} stroke="#f59e0b66" strokeDasharray="3 3" strokeWidth={0.5} />
            <text x={W / 2} y={H - 3} textAnchor="middle" fontSize="9" fill="#64748b">distance to eye NM</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>convergence °</text>
            {evals.map((e, i) => (
              <circle key={i} cx={sx(clamp(e.distNm, xMin, xMax))} cy={sy(clamp(e.convergeDeg, yMin, yMax))} r={2.4} fill={TIER_COLOR[e.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['SCOPE', scope, 100, 800, setScope, 'nm'],
            ['ADV-MUL', advMul, 50, 200, setAdvMul, '%'],
            ['STD-MUL', stdMul, 50, 200, setStdMul, '%'],
            ['CNV-MUL', cnvMul, 50, 200, setCnvMul, '%'],
            ['TOP-MUL', topMul, 50, 200, setTopMul, '%'],
            ['MIN-FL', minFl, 0, 350, setMinFl, ''],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[78px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[42px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['NATL', 'EPAC', 'CPAC', 'WPAC', 'NIO', 'SIO', 'SPAC'] as Basin[]).map(b => (
            <button key={b} onClick={() => setBasinFilter(basinFilter === b ? 'ALL' : b)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: basinFilter === b ? BASIN_COLOR[b] + '33' : '#0b1220', borderColor: basinFilter === b ? BASIN_COLOR[b] : '#1e293b', color: basinFilter === b ? BASIN_COLOR[b] : '#cbd5e1' }}>{b}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['TD', 'TS', 'C1', 'C2', 'C3', 'C4', 'C5'] as Cat[]).map(c => (
            <button key={c} onClick={() => setCatFilter(catFilter === c ? 'ALL' : c)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: catFilter === c ? CAT_COLOR[c] + '33' : '#0b1220', borderColor: catFilter === c ? CAT_COLOR[c] : '#1e293b', color: catFilter === c ? CAT_COLOR[c] : '#cbd5e1' }}>{c}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['LINK', showLink, setShowLink],
            ['RING', showRings, setShowRings],
            ['FCST', showFcst, setShowFcst],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, v, setter]: any) => (
            <button key={lab} onClick={() => setter(!v)} className="px-1.5 py-0.5 rounded text-[9px] font-mono border" style={{ backgroundColor: v ? '#0ea5e933' : '#0b1220', borderColor: v ? '#0ea5e9' : '#1e293b', color: v ? '#7dd3fc' : '#64748b' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / type / storm" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'STORMS', 'BASINS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No aircraft within {scope}NM of an active tropical cyclone.</div>}
            {filtered.map((e, idx) => {
              const stCol = e.standoffMargin < 0 ? '#ef4444' : e.standoffMargin < 50 ? '#f59e0b' : e.standoffMargin < 150 ? '#0ea5e9' : '#10b981'
              const dCol  = e.distNm < e.cyc.r64Nm ? '#ef4444' : e.distNm < e.cyc.r50Nm ? '#fb7185' : e.distNm < e.cyc.r34Nm ? '#f59e0b' : '#10b981'
              return (
                <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(e.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[e.tier]}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-slate-200 text-[11px] font-semibold truncate">{e.f.callsign || e.f.icao}</span>
                      <span className="text-slate-500 text-[10px] font-mono">{e.f.type || '—'}</span>
                      <span className="px-1 py-0.5 rounded text-[9px] font-mono text-slate-400 bg-slate-800/60 border border-slate-700">{e.phase}</span>
                    </div>
                    {tierBadge(e.tier)}
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] mt-0.5 flex-wrap">
                    <span className="text-slate-500">›</span>
                    <span className="text-sky-400 font-mono">{e.cyc.id}</span>
                    <span className="text-slate-100 font-semibold">{e.cyc.name}</span>
                    {catBadge(e.cyc.cat)}
                    {basinBadge(e.cyc.basin)}
                    <span className="text-slate-500 font-mono">{e.cyc.vmaxKt}kt · {e.cyc.mslpHpa}hPa</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px] mt-1 font-mono">
                    <div><span className="text-slate-500">dist </span><span style={{ color: dCol }}>{e.distNm.toFixed(0)}NM</span></div>
                    <div><span className="text-slate-500">brg </span><span className="text-slate-200">{e.bearingToEye.toFixed(0)}°</span></div>
                    <div><span className="text-slate-500">conv </span><span style={{ color: e.convergeDeg > 120 ? '#ef4444' : e.convergeDeg > 60 ? '#f59e0b' : '#10b981' }}>{e.convergeDeg.toFixed(0)}°</span></div>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px] mt-0.5 font-mono">
                    <div><span className="text-slate-500">band </span><span style={{ color: e.band === 'EYE' ? '#ef4444' : e.band === 'R64' ? '#f43f5e' : e.band === 'R50' ? '#fb7185' : e.band === 'R34' ? '#f59e0b' : '#10b981' }}>{e.band}</span></div>
                    <div><span className="text-slate-500">rec </span><span className="text-slate-300">≥{e.recDetourNm.toFixed(0)}NM</span></div>
                    <div><span className="text-slate-500">margin </span><span style={{ color: stCol }}>{e.standoffMargin >= 0 ? '+' : ''}{e.standoffMargin.toFixed(0)}NM</span></div>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px] mt-0.5 font-mono">
                    <div><span className="text-slate-500">FL </span><span className="text-slate-200">{e.fl.toString().padStart(3, '0')}</span></div>
                    <div><span className="text-slate-500">top </span><span style={{ color: e.topMarginFl > 50 ? '#ef4444' : e.topMarginFl > 0 ? '#f59e0b' : '#10b981' }}>FL{e.cyc.topFl}</span></div>
                    <div><span className="text-slate-500">3h </span><span className="text-slate-300">{e.forecast3hNm.toFixed(0)}NM @ {e.cyc.bearingDeg.toFixed(0)}°</span></div>
                  </div>
                  <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                    <div className="h-full" style={{ width: `${e.score}%`, backgroundColor: TIER_COLOR[e.tier] }} />
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {drvBadge('STD', e.drv.STD)}{drvBadge('CAT', e.drv.CAT)}{drvBadge('CNV', e.drv.CNV)}
                    {drvBadge('TOP', e.drv.TOP)}{drvBadge('FRC', e.drv.FRC)}{drvBadge('TRK', e.drv.TRK)}
                  </div>
                  <div className="mt-1 text-[10px] leading-tight" style={{ color: TIER_COLOR[e.tier] }}>{e.advice}</div>
                </div>
              )
            })}
          </div>
        )}
        {tab === 'STORMS' && (
          <div className="divide-y divide-slate-800">
            {CYC
              .filter(c => basinFilter === 'ALL' || c.basin === basinFilter)
              .filter(c => catFilter === 'ALL' || c.cat === catFilter)
              .sort((a, b) => catSeverity(b.cat) - catSeverity(a.cat))
              .map(c => {
                const inE = evals.filter(e => e.cyc.id === c.id)
                const mean = inE.length ? inE.reduce((s, e) => s + e.score, 0) / inE.length : 0
                const r64 = inE.filter(e => e.band === 'EYE' || e.band === 'R64').length
                return (
                  <div key={c.id} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => inE[0] && onFly(inE[0].f.icao)} style={{ borderLeft: `3px solid ${CAT_COLOR[c.cat]}` }}>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sky-400 font-mono text-[11px]">{c.id}</span>
                      <span className="text-slate-100 text-[11px] font-bold">{c.name}</span>
                      {catBadge(c.cat)}
                      {basinBadge(c.basin)}
                      <span className="text-slate-500 text-[9px] italic">{BASIN_RSMC[c.basin]}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-1 text-[10px] mt-1 font-mono">
                      <div><span className="text-slate-500">vmax </span><span style={{ color: CAT_COLOR[c.cat] }}>{c.vmaxKt}kt</span></div>
                      <div><span className="text-slate-500">mslp </span><span className="text-slate-200">{c.mslpHpa}hPa</span></div>
                      <div><span className="text-slate-500">eye </span><span className="text-slate-200">{c.eyeNm}NM</span></div>
                    </div>
                    <div className="grid grid-cols-3 gap-1 text-[10px] mt-0.5 font-mono">
                      <div><span className="text-slate-500">R64 </span><span className="text-rose-400">{c.r64Nm || '—'}NM</span></div>
                      <div><span className="text-slate-500">R50 </span><span className="text-rose-300">{c.r50Nm}NM</span></div>
                      <div><span className="text-slate-500">R34 </span><span className="text-amber-400">{c.r34Nm}NM</span></div>
                    </div>
                    <div className="grid grid-cols-3 gap-1 text-[10px] mt-0.5 font-mono">
                      <div><span className="text-slate-500">mov </span><span className="text-slate-200">{c.bearingDeg.toFixed(0)}° @ {c.speedKt}kt</span></div>
                      <div><span className="text-slate-500">top </span><span className="text-slate-200">FL{c.topFl}</span></div>
                      <div><span className="text-slate-500">cone </span><span className="text-amber-400">±{c.coneDeg}°</span></div>
                    </div>
                    <div className="grid grid-cols-3 gap-1 text-[10px] mt-0.5 font-mono">
                      <div><span className="text-slate-500">a/c </span><span className="text-slate-200">{inE.length}</span></div>
                      <div><span className="text-slate-500">R64+ </span><span className="text-rose-400">{r64}</span></div>
                      <div><span className="text-slate-500">pos </span><span className="text-slate-300">{c.lat.toFixed(1)},{c.lng.toFixed(1)}</span></div>
                    </div>
                    {inE.length > 0 && (
                      <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                        <div className="h-full" style={{ width: `${mean}%`, backgroundColor: tcol(mean, [[65,'#ef4444'],[35,'#f59e0b'],[18,'#0ea5e9']]) }} />
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
        )}
        {tab === 'BASINS' && (
          <div className="divide-y divide-slate-800">
            {(['NATL','EPAC','CPAC','WPAC','NIO','SIO','SPAC'] as Basin[]).map(b => {
              const storms = CYC.filter(c => c.basin === b)
              const inE = evals.filter(e => e.cyc.basin === b)
              const mean = inE.length ? inE.reduce((s, e) => s + e.score, 0) / inE.length : 0
              const r64 = inE.filter(e => e.band === 'EYE' || e.band === 'R64').length
              const maxC = storms.reduce<Cat | null>((m, c) => (m === null || catSeverity(c.cat) > catSeverity(m) ? c.cat : m), null)
              return (
                <div key={b} className="px-3 py-2" style={{ borderLeft: `3px solid ${BASIN_COLOR[b]}` }}>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {basinBadge(b)}
                    <span className="text-slate-300 text-[10px] italic">{BASIN_RSMC[b]}</span>
                    {maxC && catBadge(maxC)}
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px] mt-1 font-mono">
                    <div><span className="text-slate-500">storms </span><span className="text-slate-200">{storms.length}</span></div>
                    <div><span className="text-slate-500">a/c </span><span className="text-slate-200">{inE.length}</span></div>
                    <div><span className="text-slate-500">R64+ </span><span className="text-rose-400">{r64}</span></div>
                  </div>
                  {inE.length > 0 && (
                    <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                      <div className="h-full" style={{ width: `${mean}%`, backgroundColor: tcol(mean, [[65,'#ef4444'],[35,'#f59e0b'],[18,'#0ea5e9']]) }} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
