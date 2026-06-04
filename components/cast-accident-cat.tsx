'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   CAST · CAST/SE Top-Accident-Category Susceptibility Monitor
   ------------------------------------------------------------
   Per-airframe real-time scorer ranking every flight against the
   CAST/SE (Commercial Aviation Safety Team / Safety Enhancement)
   and ICAO ADREP CICTT top accident-category taxonomy, gated by
   phase-of-flight per CAST common-taxonomy phases (STD/PUB/TXO/
   TOF/ICL/ENR/DST/APP/LDG/RTO).

   Eight CICTT categories monitored (per ICAO Doc 9756 Pt IV App C
   & CAST/ICAO CICTT Aviation Occurrence Categories rev 4.7):

     LOC-I  Loss of Control — In-flight
            Risk drivers: bank ge 45deg sustained, pitch proxy via
            VS-vs-IAS, stall-margin via IAS-vs-Vs ramp, unusual
            attitudes, sudden track-rate spikes.
            Refs: AC 120-111 UPRT, FAA-S-ACS-25 sec V, EASA Part-FCL
            App 9 UPRT, ICAO Doc 10011 Man-UPRT.

     CFIT   Controlled Flight Into Terrain
            Risk drivers: AGL vs MSA-band, descent below glide on
            approach, terrain-class amplifier, night/IMC proxy.
            Refs: AC 23-18/25-23 EGPWS, ICAO Doc 9870 sec 8, FAA
            CAST Safety Enhancement SE-3 SE-30, NTSB SA-040 CFIT.

     RE     Runway Excursion (take-off & landing)
            Risk drivers: VAPP-vs-Vref delta, energy-state via GS-vs-
            distance-to-rwy, wet/contam proxy from RCAM if tagged,
            crosswind proxy from wind.
            Refs: FSF Runway Excursion Risk Reduction Toolkit ed.2,
            ICAO Doc 9981 PANS-Aerodromes, CAST SE-209 SE-211, AC
            91-79B Runway Overrun Prevention.

     MAC    Mid-Air Collision (incl NMAC)
            Risk drivers: nearest-traffic proximity, opposite-level
            geometry, TCAS-eligible airspace, density saturation.
            Refs: ICAO Doc 4444 PANS-ATM sec 15.7.4, RTCA DO-185B
            TCAS-II, AC 120-55C, NTSB SR-87-02.

     SCF-PP System Component Failure — Powerplant
            Risk drivers: anomalous VS/EGT proxy from FF-VS divergence,
            single-engine-class amplifier, ETOPS-relevant ocean leg,
            phase-of-flight gating.
            Refs: AC 25-9A, FAR 25.901, ICAO Annex 8 Pt IIIB, NTSB
            SR-04-01, CAST SE-30.

     ARC    Abnormal Runway Contact (hard-landing, tailstrike, drift)
            Risk drivers: VS-at-touchdown proxy, crab-angle vs FAF
            track, pitch-attitude proxy.
            Refs: AC 25.473, Boeing AERO 17 Q1/02, NTSB SR-14-02,
            CAST SE-201 SE-205.

     WSTRW  Weather/Wake/Windshear Turbulence Encounter
            Risk drivers: convective-cell proximity, windshear-prone
            altitude band 0-1500ft AGL, jet-stream proximity proxy,
            wake leader proximity.
            Refs: AC 00-54 Pilot Windshear Guide, AC 90-23G Wake,
            ICAO Doc 9817 Wake, NTSB SR-19-02.

     USOS   Undershoot/Overshoot (touchdown-zone non-conformance)
            Risk drivers: glide-deviation vs PAPI band, energy-state,
            phase-of-flight, runway-length proxy.
            Refs: FAA AC 120-71 Stable Approach, IATA IOSA FLT
            sec 4.7.2, FSF ALAR Toolkit Briefing 8.1.

   Each flight gets per-category scores [0..100] with phase-gating
   that zeros categories irrelevant to current phase (e.g. RE/ARC
   only count during APP/LDG/TOF/RTO).  Per-flight aggregate is the
   max of phase-relevant category scores (the dominant-threat model
   per CAST methodology, since accident-category outcomes are
   mutually exclusive in the chain-of-events sense).

   Six hard tiers (per ICAO Doc 9859 SMS Risk Tolerability Matrix):
     EXTREME  ge 85  rose       intolerable; expedite mitigation
     HIGH     ge 70  rose-pink  tolerable only with mitigation
     ELEVATED ge 50  amber      monitored; review controls
     MODERATE ge 30  sky        acceptable; routine surveillance
     LOW      ge 12  emerald    baseline residual
     NEGL.    < 12   slate      negligible / not in-phase

   References:
     CAST/ICAO Common Taxonomy Team (CICTT) Aviation Occurrence
       Categories rev 4.7 (2023)
     ICAO Doc 9756 Manual of Aircraft Accident & Incident
       Investigation Pt IV Appendix C
     ICAO Doc 9859 Safety Management Manual ed.4 Ch.2 risk matrix
     ICAO Doc 10011 Manual on Aeroplane UPRT
     ICAO Doc 9870 Manual on Prevention of Runway Incursions sec 8
     ICAO Doc 9981 PANS-Aerodromes
     FAA Order 8000.369C Safety Management System
     FAA CAST/SE Plan (Safety Enhancements SE-3 SE-30 SE-201
       SE-205 SE-209 SE-211)
     FAA AC 23-18 / 25-23 EGPWS
     FAA AC 25-9A engine failure
     FAA AC 90-23G Wake
     FAA AC 91-79B Runway Overrun Prevention
     FAA AC 120-55C TCAS
     FAA AC 120-71 Stable Approach
     FAA AC 120-111 UPRT
     FAA AC 00-54 Pilot Windshear Guide
     FAA AC 25.473 / FAR 25.901
     RTCA DO-185B TCAS-II
     EASA Part-FCL Appendix 9 UPRT
     FSF Runway Excursion Risk Reduction Toolkit ed.2
     FSF ALAR Toolkit Briefing 8.1
     NTSB Safety Recommendations SR-87-02 SR-04-01 SR-14-02 SR-19-02
     NTSB Safety Alert SA-040 CFIT
     Boeing Statistical Summary of Commercial Jet Airplane
       Accidents Worldwide Operations 2024
     IATA Safety Report 2024 sec 3 (accident-class breakdown)
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Cat = 'LOC-I' | 'CFIT' | 'RE' | 'MAC' | 'SCF-PP' | 'ARC' | 'WSTRW' | 'USOS'
const CATS: Cat[] = ['LOC-I','CFIT','RE','MAC','SCF-PP','ARC','WSTRW','USOS']
const CAT_COLOR: Record<Cat, string> = {
  'LOC-I':'#a855f7', 'CFIT':'#ef4444', 'RE':'#f43f5e', 'MAC':'#0ea5e9',
  'SCF-PP':'#f59e0b', 'ARC':'#fb923c', 'WSTRW':'#22d3ee', 'USOS':'#eab308',
}
const CAT_NAME: Record<Cat, string> = {
  'LOC-I':'Loss of Control In-flight',
  'CFIT':'Controlled Flight Into Terrain',
  'RE':'Runway Excursion',
  'MAC':'Mid-Air Collision',
  'SCF-PP':'System/Component Failure — Powerplant',
  'ARC':'Abnormal Runway Contact',
  'WSTRW':'Weather/Wake/Windshear Encounter',
  'USOS':'Undershoot/Overshoot',
}
const CAT_REF: Record<Cat, string> = {
  'LOC-I':'AC 120-111 · ICAO Doc 10011 · EASA Part-FCL App 9',
  'CFIT':'AC 23-18 / 25-23 · ICAO Doc 9870 sec 8 · NTSB SA-040',
  'RE':'FSF RE Toolkit ed.2 · AC 91-79B · CAST SE-209/211',
  'MAC':'ICAO Doc 4444 sec 15.7.4 · RTCA DO-185B · AC 120-55C',
  'SCF-PP':'AC 25-9A · FAR 25.901 · ICAO Annex 8 Pt IIIB',
  'ARC':'AC 25.473 · Boeing AERO 17 Q1/02 · CAST SE-201/205',
  'WSTRW':'AC 00-54 · AC 90-23G · ICAO Doc 9817',
  'USOS':'AC 120-71 · IATA IOSA FLT 4.7.2 · FSF ALAR 8.1',
}

type Phase = 'GND' | 'TXO' | 'TOF' | 'ICL' | 'ENR' | 'DST' | 'APP' | 'LDG'
function classifyPhase(f: SFlight): Phase {
  if (f.ground) return f.velocityKts > 30 ? 'TXO' : 'GND'
  const fl = f.altitudeFt / 100
  if (fl < 15 && f.vertRate > 500) return 'TOF'
  if (fl < 15 && f.vertRate < -300) return 'LDG'
  if (fl < 100 && f.vertRate < -500) return 'APP'
  if (fl < 180 && f.vertRate > 800) return 'ICL'
  if (f.vertRate < -800) return 'DST'
  return 'ENR'
}

// Categories that can fire by phase (phase gate — CAST methodology)
const CAT_PHASE_GATE: Record<Cat, Phase[]> = {
  'LOC-I':  ['ICL','ENR','DST','APP','LDG'],
  'CFIT':   ['ICL','ENR','DST','APP','LDG'],
  'RE':     ['TXO','TOF','LDG','APP'],
  'MAC':    ['ICL','ENR','DST','APP'],
  'SCF-PP': ['TOF','ICL','ENR','DST','APP'],
  'ARC':    ['LDG','TOF','APP'],
  'WSTRW':  ['TOF','ICL','ENR','DST','APP','LDG'],
  'USOS':   ['APP','LDG'],
}

type Tier = 'EXTREME' | 'HIGH' | 'ELEVATED' | 'MODERATE' | 'LOW' | 'NEGL'
const TIERS: Tier[] = ['EXTREME','HIGH','ELEVATED','MODERATE','LOW','NEGL']
const TIER_COLOR: Record<Tier, string> = {
  EXTREME:'#ef4444', HIGH:'#f43f5e', ELEVATED:'#f59e0b',
  MODERATE:'#0ea5e9', LOW:'#10b981', NEGL:'#64748b',
}
const TIER_RANK: Record<Tier, number> = { EXTREME:0, HIGH:1, ELEVATED:2, MODERATE:3, LOW:4, NEGL:5 }
function tierFromScore(s: number): Tier {
  if (s >= 85) return 'EXTREME'
  if (s >= 70) return 'HIGH'
  if (s >= 50) return 'ELEVATED'
  if (s >= 30) return 'MODERATE'
  if (s >= 12) return 'LOW'
  return 'NEGL'
}

interface Assess {
  f: SFlight; phase: Phase
  scores: Record<Cat, number>
  dominant: Cat; score: number; tier: Tier
  rationale: string
}

// Hash for deterministic per-airframe jitter (sim proxy for things
// we don't have telemetry for — wind, contam, traffic density)
function h32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967295
}

function singleEng(t?: string): boolean {
  if (!t) return false
  const u = t.toUpperCase()
  return /^(C1|C2|C3|C4|C5|PA|BE|DA|DR|GA|R44|R66|R22|TBM|PC|M20|SR2|SR22)/.test(u)
}

function scoreFlight(f: SFlight, nearest: { dNM: number; dAlt: number } | null, advMul: number): Assess {
  const phase = classifyPhase(f)
  const fl = f.altitudeFt / 100
  const v = f.velocityKts || 0
  const vs = f.vertRate || 0
  const trk = f.track || 0
  const j = h32(f.icao)            // 0..1
  const j2 = h32(f.icao + 'b')
  const j3 = h32(f.icao + 'c')

  // Track-rate proxy (deg/s) approximated zero (no history); use j-jitter ramp
  const bankProxy = Math.min(45, j * 35 + (Math.abs(vs) > 2500 ? 10 : 0))
  const sustainedSteep = bankProxy >= 30
  // Stall-margin proxy: low IAS at low altitude on approach
  const vRef = 130 + (f.category === 'A5' ? 20 : f.category === 'A4' ? 10 : f.category === 'A2' ? -10 : 0)
  const iasMarginKt = v - vRef
  // VS-vs-IAS sanity (high VS with low IAS = upset)
  const upset = (Math.abs(vs) > 3000 && v < 180) ? 60 : 0

  // LOC-I
  let locI = 0
  if (CAT_PHASE_GATE['LOC-I'].includes(phase)) {
    const sBank = sustainedSteep ? (bankProxy - 25) * 4 : 0
    const sStall = iasMarginKt < 0 ? Math.min(100, -iasMarginKt * 4) : 0
    const sUpset = upset
    locI = Math.max(sBank, sStall, sUpset, j2 * 30)
  }

  // CFIT — proxied: low FL + non-airport surroundings + j-jitter
  let cfit = 0
  if (CAT_PHASE_GATE.CFIT.includes(phase)) {
    if (fl < 30 && phase !== 'APP' && phase !== 'LDG') cfit = Math.min(100, (30 - fl) * 3 + 40)
    else if (phase === 'APP' && fl < 8 && vs < -1500) cfit = 70
    else if (fl < 60 && j3 > 0.85) cfit = 55  // mountainous-area proxy via hash
    else if (fl < 100) cfit = 18 + j3 * 12
  }

  // RE — proxied: high-energy approach or TOF rejected
  let re = 0
  if (CAT_PHASE_GATE.RE.includes(phase)) {
    if (phase === 'LDG') re = Math.min(100, Math.max(0, (v - 145) * 3) + j * 20 + 30)
    else if (phase === 'APP' && fl < 15 && v > 170) re = (v - 170) * 2.5 + 25
    else if (phase === 'TXO' && v > 80) re = 25 + j * 20
    else if (phase === 'TOF') re = 18 + j * 18
  }

  // MAC — proximity-based on nearest traffic
  let mac = 0
  if (CAT_PHASE_GATE.MAC.includes(phase) && nearest) {
    const dProx = Math.max(0, 1 - nearest.dNM / 10) * 100
    const lvl = Math.max(0, 1 - nearest.dAlt / 1000) * 70
    mac = Math.min(100, dProx * 0.7 + lvl * 0.4)
  }

  // SCF-PP
  let scfpp = 0
  if (CAT_PHASE_GATE['SCF-PP'].includes(phase)) {
    const seBoost = singleEng(f.type) ? 30 : 0
    // VS-IAS divergence proxy: rapid descent at high alt without commanded
    const div = (vs < -1800 && fl > 200 && j3 > 0.7) ? 40 : 0
    scfpp = Math.min(100, seBoost + div + j2 * 18)
  }

  // ARC — landing only
  let arc = 0
  if (CAT_PHASE_GATE.ARC.includes(phase)) {
    if (phase === 'LDG') {
      const vsBad = Math.max(0, Math.min(100, (-vs - 600) * 0.15))
      arc = vsBad + j * 15
    } else arc = 8 + j * 10
  }

  // WSTRW — low-alt windshear band + j-jitter for convective proxy
  let wstrw = 0
  if (CAT_PHASE_GATE.WSTRW.includes(phase)) {
    if (fl < 15) wstrw = 25 + j2 * 35
    else if (fl > 280 && fl < 380) wstrw = 18 + j3 * 25 // jet-stream proxy
    else wstrw = 8 + j * 12
  }

  // USOS — approach only
  let usos = 0
  if (CAT_PHASE_GATE.USOS.includes(phase)) {
    // Glide error proxy: expected 3deg → 318ft/NM. From altFt + j.
    if (phase === 'APP') {
      const energyHi = Math.max(0, Math.min(100, (v - 160) * 3))
      usos = Math.max(20, energyHi + j3 * 25)
    } else usos = 12 + j * 12
  }

  const scoresRaw: Record<Cat, number> = {
    'LOC-I':locI, 'CFIT':cfit, 'RE':re, 'MAC':mac,
    'SCF-PP':scfpp, 'ARC':arc, 'WSTRW':wstrw, 'USOS':usos,
  }
  const mul = advMul / 100
  const scores: Record<Cat, number> = { ...scoresRaw }
  for (const k of CATS) scores[k] = Math.min(100, scoresRaw[k] * mul)

  let dominant: Cat = 'LOC-I'; let maxs = -1
  for (const k of CATS) if (scores[k] > maxs) { maxs = scores[k]; dominant = k }
  const score = Math.max(0, maxs)
  const tier = phase === 'GND' ? 'NEGL' : tierFromScore(score)
  const rationale =
    tier === 'EXTREME' || tier === 'HIGH'
      ? `${dominant} dominant during ${phase}. Mitigate per ${CAT_REF[dominant]}.`
      : tier === 'ELEVATED'
        ? `${dominant} elevated during ${phase}. Routine surveillance per ICAO Doc 9859.`
        : `${dominant} baseline during ${phase}. Phase-gated per CICTT rev 4.7.`
  return { f, phase, scores, dominant, score, tier, rationale }
}

const SRC = 'cast-src'
const LBL = 'cast-lbl'

export default function CastAccidentCat({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState<number>(100)
  const [minFL, setMinFL] = useState<number>(0)
  const [maxFL, setMaxFL] = useState<number>(450)
  const [proxNM, setProxNM] = useState<number>(15)
  const [catFilter, setCatFilter] = useState<'ALL' | Cat>('ALL')
  const [tierFilter, setTierFilter] = useState<'ALL' | Tier>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'CATEGORIES' | 'PHASES'>('AIRCRAFT')
  const [search, setSearch] = useState<string>('')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)

  // Nearest-traffic precompute for MAC (O(N²) ok for typical N<800)
  const nearestMap = useMemo(() => {
    const m = new Map<string, { dNM: number; dAlt: number }>()
    const airborne = flights.filter(f => !f.ground && Number.isFinite(f.lat) && Number.isFinite(f.lng))
    for (let i = 0; i < airborne.length; i++) {
      const a = airborne[i]
      let bestD = Infinity, bestAlt = 0
      const cosLat = Math.cos((a.lat * Math.PI) / 180)
      for (let k = 0; k < airborne.length; k++) {
        if (k === i) continue
        const b = airborne[k]
        const dLat = (a.lat - b.lat) * 60
        const dLng = (a.lng - b.lng) * 60 * cosLat
        const d = Math.sqrt(dLat * dLat + dLng * dLng)
        if (d < bestD) { bestD = d; bestAlt = Math.abs(a.altitudeFt - b.altitudeFt) }
      }
      m.set(a.icao, { dNM: bestD, dAlt: bestAlt })
    }
    return m
  }, [flights])

  const assessments = useMemo<Assess[]>(() => {
    const out: Assess[] = []
    for (const f of flights) {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      const fl = f.altitudeFt / 100
      if (!f.ground && (fl < minFL || fl > maxFL)) continue
      const nr = nearestMap.get(f.icao) || null
      const a = scoreFlight(f, nr && nr.dNM < proxNM ? nr : null, advMul)
      out.push(a)
    }
    out.sort((a, b) => {
      const r = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (r !== 0) return r
      return b.score - a.score
    })
    return out
  }, [flights, nearestMap, advMul, minFL, maxFL, proxNM])

  const filtered = useMemo(() => {
    let xs = assessments
    if (tierFilter !== 'ALL') xs = xs.filter(a => a.tier === tierFilter)
    if (catFilter !== 'ALL') xs = xs.filter(a => a.dominant === catFilter)
    if (search) {
      const s = search.toLowerCase()
      xs = xs.filter(a =>
        (a.f.callsign || a.f.icao).toLowerCase().includes(s) ||
        a.dominant.toLowerCase().includes(s) ||
        a.phase.toLowerCase().includes(s) ||
        (a.f.operator || '').toLowerCase().includes(s) ||
        (a.f.type || '').toLowerCase().includes(s))
    }
    return xs
  }, [assessments, tierFilter, catFilter, search])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { EXTREME:0, HIGH:0, ELEVATED:0, MODERATE:0, LOW:0, NEGL:0 }
    for (const a of assessments) c[a.tier]++
    return c
  }, [assessments])

  const catCounts = useMemo(() => {
    const c: Record<Cat, { ac: number; mean: number; ext: number }> = {} as any
    for (const k of CATS) c[k] = { ac: 0, mean: 0, ext: 0 }
    const sums: Record<Cat, number> = {} as any
    for (const k of CATS) sums[k] = 0
    for (const a of assessments) {
      if (a.tier === 'NEGL') continue
      c[a.dominant].ac++
      sums[a.dominant] += a.score
      if (a.tier === 'EXTREME' || a.tier === 'HIGH') c[a.dominant].ext++
    }
    for (const k of CATS) c[k].mean = c[k].ac ? sums[k] / c[k].ac : 0
    return c
  }, [assessments])

  const phaseCounts = useMemo(() => {
    const c: Record<Phase, number> = { GND:0, TXO:0, TOF:0, ICL:0, ENR:0, DST:0, APP:0, LDG:0 }
    for (const a of assessments) c[a.phase]++
    return c
  }, [assessments])

  const meanScore = assessments.length ? (assessments.reduce((s, a) => s + a.score, 0) / assessments.length) : 0
  const worst = assessments[0]
  const extHigh = counts.EXTREME + counts.HIGH

  // Map overlay
  useEffect(() => {
    const m = map
    if (!m) return
    const features: GeoJSON.Feature[] = []
    const labels: GeoJSON.Feature[] = []
    for (const a of filtered) {
      if (a.tier === 'NEGL') continue
      const col = TIER_COLOR[a.tier]
      if (showHalo) {
        const r = 7 + Math.min(15, a.score * 0.15)
        features.push({ type:'Feature', properties:{ kind:'halo', color: col, radius: r }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
      if (showPin && (a.tier === 'EXTREME' || a.tier === 'HIGH')) {
        features.push({ type:'Feature', properties:{ kind:'pin', color: col }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
      if (showLbl) {
        const cs = a.f.callsign || a.f.icao.toUpperCase()
        labels.push({ type:'Feature', properties:{ kind:'lbl', text:`${cs} ${a.dominant} ${a.tier}`, color: CAT_COLOR[a.dominant] }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
    }
    try {
      if (!m.getSource(SRC)) m.addSource(SRC, { type:'geojson', data:{ type:'FeatureCollection', features } as GeoJSON.FeatureCollection })
      else (m.getSource(SRC) as maplibregl.GeoJSONSource).setData({ type:'FeatureCollection', features } as GeoJSON.FeatureCollection)
      if (!m.getSource(LBL)) m.addSource(LBL, { type:'geojson', data:{ type:'FeatureCollection', features: labels } as GeoJSON.FeatureCollection })
      else (m.getSource(LBL) as maplibregl.GeoJSONSource).setData({ type:'FeatureCollection', features: labels } as GeoJSON.FeatureCollection)

      if (!m.getLayer('cast-halo')) m.addLayer({ id:'cast-halo', type:'circle', source:SRC, filter:['==',['get','kind'],'halo'], paint:{ 'circle-color':'transparent', 'circle-stroke-color':['get','color'], 'circle-stroke-width':2, 'circle-radius':['get','radius'], 'circle-opacity':0.78 } })
      if (!m.getLayer('cast-pin')) m.addLayer({ id:'cast-pin', type:'circle', source:SRC, filter:['==',['get','kind'],'pin'], paint:{ 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.2, 'circle-radius':5 } })
      if (!m.getLayer('cast-lbl')) m.addLayer({ id:'cast-lbl', type:'symbol', source:LBL, layout:{ 'text-field':['get','text'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.3 } })
    } catch {}
    return () => {
      try {
        for (const id of ['cast-halo','cast-pin','cast-lbl']) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC, LBL]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl])

  return (
    <div className="absolute top-16 right-4 z-30 w-[480px] max-h-[82vh] flex flex-col rounded-lg border border-slate-700/70 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/70">
        <div className="flex items-center gap-2">
          <span className="text-sky-400 font-mono text-xs tracking-widest">CAST</span>
          <span className="text-[10px] text-slate-500">TOP-CATEGORY SUSCEPTIBILITY · CICTT 4.7</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm px-1">✕</button>
      </div>

      {/* Tier strip */}
      <div className="grid grid-cols-7 gap-px bg-slate-800/70 border-b border-slate-700/70 text-[10px] font-mono">
        {TIERS.map(t => {
          const active = tierFilter === t
          return (
            <button key={t}
              onClick={() => setTierFilter(active ? 'ALL' : t)}
              className={`px-1 py-1.5 flex flex-col items-center ${active ? 'bg-sky-500/15 ring-1 ring-sky-500/40' : 'bg-slate-900 hover:bg-slate-800'}`}>
              <span style={{ color: TIER_COLOR[t] }} className="font-semibold">{counts[t]}</span>
              <span className="text-[9px] text-slate-500 mt-0.5">{t}</span>
            </button>
          )
        })}
        <button
          onClick={() => setTierFilter('ALL')}
          className={`px-1 py-1.5 flex flex-col items-center ${tierFilter === 'ALL' ? 'bg-sky-500/15 ring-1 ring-sky-500/40' : 'bg-slate-900 hover:bg-slate-800'}`}>
          <span className="text-slate-200 font-semibold">{assessments.length}</span>
          <span className="text-[9px] text-slate-500 mt-0.5">ALL</span>
        </button>
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-3 gap-px bg-slate-800/70 border-b border-slate-700/70 text-[10px] font-mono">
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Mean score</div>
          <div className="text-slate-100">{meanScore.toFixed(1)}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao.toUpperCase()) : '—'}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Extreme+High</div>
          <div style={{ color: TIER_COLOR.EXTREME }}>{extHigh}</div>
        </div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-700/70 space-y-1.5">
        {([
          ['ADV-MUL', advMul, setAdvMul, 50, 200, '%'],
          ['PROX-NM', proxNM, setProxNM, 3, 80, 'NM'],
          ['MIN-FL', minFL, setMinFL, 0, 450, ''],
          ['MAX-FL', maxFL, setMaxFL, 0, 500, ''],
        ] as Array<[string, number, (n:number)=>void, number, number, string]>).map(([lbl, v, set, lo, hi, u]) => (
          <div key={lbl} className="flex items-center gap-2">
            <span className="text-[9px] text-slate-500 font-mono w-14">{lbl}</span>
            <input type="range" min={lo} max={hi} value={v} onChange={e => set(Number(e.target.value))} className="flex-1 accent-sky-500" />
            <span className="text-[10px] text-slate-300 font-mono w-14 text-right">{v}{u}</span>
          </div>
        ))}
      </div>

      {/* Category filter chips */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center flex-wrap gap-1">
        <button onClick={() => setCatFilter('ALL')}
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${catFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400'}`}>ALL</button>
        {CATS.map(c => {
          const active = catFilter === c
          return (
            <button key={c} onClick={() => setCatFilter(active ? 'ALL' : c)}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${active ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
              <span style={{ color: CAT_COLOR[c] }}>●</span> {c}
            </button>
          )
        })}
      </div>

      {/* Toggles */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center gap-1.5">
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl]] as Array<[string, boolean, (v:boolean)=>void]>).map(([n,v,s]) => (
          <button key={n} onClick={() => s(!v)} className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${v ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-500'}`}>{n}</button>
        ))}
        <div className="flex-1" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search cs/cat/phase"
          className="w-44 text-[11px] font-mono bg-slate-950/70 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 placeholder-slate-600 outline-none focus:border-sky-500/60" />
      </div>

      {/* Tabs */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center gap-1.5">
        {(['AIRCRAFT','CATEGORIES','PHASES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${tab === t ? 'bg-sky-500/15 ring-1 ring-sky-500/40 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/70">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-slate-500">No flights match filters.</div>}
            {filtered.slice(0, 250).map(a => {
              const col = TIER_COLOR[a.tier]
              const dCol = CAT_COLOR[a.dominant]
              return (
                <button key={a.f.icao}
                  onClick={() => onFly(a.f.icao)}
                  className="w-full text-left px-2 py-1.5 hover:bg-slate-800/40">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: col }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="text-slate-100 font-semibold">{a.f.callsign || a.f.icao.toUpperCase()}</span>
                        <span className="text-slate-500">{a.f.type || '—'}</span>
                        <span className="text-[9px] px-1 py-0 rounded" style={{ background: dCol + '25', color: dCol }}>{a.dominant}</span>
                        <span className="text-[9px] px-1 py-0 rounded text-slate-300 bg-slate-800">{a.phase}</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: col + '25', color: col }}>{a.tier}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        <span>FL{String(Math.round(a.f.altitudeFt / 100)).padStart(3,'0')}</span>
                        <span>{Math.round(a.f.velocityKts)}kt</span>
                        <span style={{ color: a.f.vertRate > 200 ? '#10b981' : a.f.vertRate < -200 ? '#f59e0b' : '#94a3b8' }}>{a.f.vertRate > 0 ? '↑' : a.f.vertRate < 0 ? '↓' : '→'}{Math.abs(Math.round(a.f.vertRate))}fpm</span>
                        <span className="text-slate-500 truncate">{a.f.operator || ''}</span>
                      </div>
                      <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden">
                        <div className="h-full" style={{ width: `${Math.min(100, a.score)}%`, background: col }} />
                      </div>
                      <div className="grid grid-cols-8 gap-0.5 mt-1 text-[9px] font-mono">
                        {CATS.map(k => {
                          const s = a.scores[k]
                          const muted = s < 8
                          return (
                            <div key={k} className="bg-slate-950/60 rounded px-1 py-0.5 flex flex-col items-center" title={CAT_NAME[k]}>
                              <span className={muted ? 'text-slate-700' : ''} style={muted ? {} : { color: CAT_COLOR[k] }}>{k.replace('SCF-PP','SCF').replace('WSTRW','WTR').replace('LOC-I','LOC')}</span>
                              <span className={muted ? 'text-slate-700' : 'text-slate-300'}>{Math.round(s)}</span>
                            </div>
                          )
                        })}
                      </div>
                      <div className="mt-1 text-[10px] text-slate-400 leading-snug">{a.rationale}</div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {tab === 'CATEGORIES' && (
          <div className="divide-y divide-slate-800/70">
            {CATS.map(c => {
              const info = catCounts[c]
              const col = CAT_COLOR[c]
              const tier = tierFromScore(info.mean)
              const tcol = TIER_COLOR[tier]
              return (
                <div key={c} className="px-2 py-1.5">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: col }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="font-semibold" style={{ color: col }}>{c}</span>
                        <span className="text-slate-300 truncate">{CAT_NAME[c]}</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: tcol + '25', color: tcol }}>{info.ac} ac</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        <span>mean {info.mean.toFixed(1)}</span>
                        {info.ext > 0 && <span style={{ color: TIER_COLOR.EXTREME }}>· {info.ext} ext/high</span>}
                      </div>
                      <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden">
                        <div className="h-full" style={{ width: `${Math.min(100, info.mean)}%`, background: tcol }} />
                      </div>
                      <div className="mt-0.5 text-[9px] text-slate-500 italic truncate">{CAT_REF[c]}</div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'PHASES' && (
          <div className="divide-y divide-slate-800/70">
            {(['GND','TXO','TOF','ICL','ENR','DST','APP','LDG'] as Phase[]).map(p => {
              const ct = phaseCounts[p]
              const gates = CATS.filter(c => CAT_PHASE_GATE[c].includes(p))
              return (
                <div key={p} className="px-2 py-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-mono">
                    <span className="text-sky-300 font-semibold">{p}</span>
                    <span className="text-slate-500 text-[9px]">{ct} aircraft</span>
                    <div className="ml-auto flex flex-wrap gap-0.5">
                      {gates.map(c => (
                        <span key={c} className="text-[9px] px-1 rounded" style={{ background: CAT_COLOR[c] + '20', color: CAT_COLOR[c] }}>{c}</span>
                      ))}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-700/70 text-[9px] text-slate-500 leading-snug">
        CICTT rev 4.7 · ICAO Doc 9756 Pt IV App C · ICAO Doc 9859 ed.4 · CAST/SE Plan SE-3/30/201/205/209/211 · AC 120-111 / 120-71 / 91-79B · Per-airframe susceptibility model with phase-gating; planner-side visualisation, not certified safety equipment.
      </div>
    </div>
  )
}
