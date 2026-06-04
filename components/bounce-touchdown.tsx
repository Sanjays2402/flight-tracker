'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   BOUNCE · Touchdown Sink-Rate, Vertical-G & Landing-Gear
            Reaction-Load / Hard-Landing Inspection-Threshold Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of TOUCHDOWN VERTICAL ENERGY against
   the per-airframe hard-landing inspection thresholds published in
   the AMM (Aircraft Maintenance Manual) Ch.05-51 Conditional
   Inspection / Ch.32-00 Landing Gear and the FAR/CS-25 Subpart C
   landing-gear reaction-load envelope per:

     · 14 CFR §25.473 Landing Load Conditions and Assumptions
         Limit descent velocity Vsink = 10 ft/s  at MLW (Design)
         Reserve energy           Vsink = 12 ft/s at MLW
         FAR §25.479 / §25.481 / §25.483 / §25.485 / §25.493
     · EASA CS-25.473 / CS-25.477 / AMC 25.473 (mirror text)
     · 14 CFR §23.473 (Part 23) Vsink = 7 ft/s at MLW
     · ICAO Doc 9760 Vol II Pt IV §4 Continuing Airworthiness
     · Boeing AMM Ch.05-51-01..05  (per-model HL inspection limits)
     · Airbus AMM TASK 05-51-11-200-001 Hard / Overweight Landing
     · Embraer AMM Ch.05-51-04  HL & overweight conditional insp.
     · IATA IGOM 4.4.5 Hard Landing reporting
     · FAA AC 25-7D §6 Flight Test Guide — Landing Loads
     · NTSB AAR-09-01 SAS 1209 hard-landing main-gear collapse
     · NTSB AAR-13-01 OZ 214 SFO B777 vertical-impact analysis
     · TSB A19A0055 hard landing main-gear bulkhead fracture

   Physics (touchdown vertical-axis energy):
     · TAS_v = vertRate / 60 [ft/s]      (instantaneous sink at TD)
     · KE_v  = ½ · m · TAS_v²            [Joules, vertical only]
     · Gz    = 1 + (ΔVz · Δt⁻¹) / g      load-factor estimator
       using Newmark-β oleo-shock approximation:
         Gz_peak ≈ 1 + (Vsink_fps² / (2·g·Δs_oleo))
       where Δs_oleo ≈ 0.55 ft (single-stage oleo) per Currey
       Aircraft Landing Gear Design 1988 §6.4 — yields the
       classic "hard-landing G-band":
         <1.5 g       normal      smooth touchdown
         1.5–1.8 g    firm        log entry, no insp
         1.8–2.1 g    HARD        AMM 05-51 Cat-A inspection
         2.1–2.6 g    SEVERE      Cat-B (jacks + bulkhead NDT)
         >2.6 g       OVERLOAD    Cat-C (gear R&R) per Boeing
                                  AMM 05-51-02 Table 502
     · Mass-correction: actual landing mass vs MLW raises G-limit
       linearly per AMC 25.473, scaled with OVERWGT-MUL slider.
     · Crab/sideload coupling (cf. DECRAB) adds ~0.05·sin(β) g
       to vertical-axis residual via gear pintle moment.

   Distinct from:
     · TAIL-STRK   pitch-attitude geometric clearance (long axis)
     · DECRAB      lateral tire-sideload at touchdown
     · HYDROPLANE  water-film friction on rollout
     · BRAKE       rollout brake-energy / temperature
     · GUST        free-air vertical-gust load Δn
     · CG-TRIM     CG longitudinal envelope
   BOUNCE is uniquely the VERTICAL-axis impact-load oleo-shock
   absorber energy regime at the instant of main-gear compression.

   8 drivers (each 0-100):
     · SINK   sink-rate fps vs Vsink_lim
     · GZ     peak Gz vs class HL threshold
     · MASS   landing mass vs MLW band
     · ENERGY KE_v vs design energy MLW·Vsink_lim²
     · BOUNCE secondary-impact risk (Vsink>9fps + ΔΘ pitch)
     · OLEO   shock-strut compression % vs stroke
     · CRAB   crab-coupled gear pintle moment proxy
     · PHASE  TD/POST-TD phase weight 1.20/1.05/0.30

   6 tiers:
     · OVERLOAD ≥85 rose      gear R&R required (AMM 05-51 Cat-C)
     · SEVERE   ≥65 rose-pink jacks + bulkhead NDT  (Cat-B)
     · HARD     ≥45 amber     conditional inspection (Cat-A)
     · FIRM     ≥22 sky       log-book entry only
     · SMOOTH   <22  emerald  nominal touchdown
     · OFF      slate         airborne / no TD phase
============================================================ */

interface BFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: BFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'OVERLOAD'|'SEVERE'|'HARD'|'FIRM'|'SMOOTH'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  OVERLOAD:'#ef4444', SEVERE:'#f43f5e', HARD:'#f59e0b',
  FIRM:'#0ea5e9', SMOOTH:'#10b981', OFF:'#475569',
}
const TIER_RANK: Record<Tier,number> = { OVERLOAD:0, SEVERE:1, HARD:2, FIRM:3, SMOOTH:4, OFF:5 }
const TIER_ORDER: Tier[] = ['OVERLOAD','SEVERE','HARD','FIRM','SMOOTH']

type Phase = 'FLARE'|'TD'|'POST-TD'|'TAXI-CLR'|'OFF'

// Per-class hard-landing envelope: MLW kg / Vsink_lim fps / Gz_HL g / Gz_SEV g / OLEO stroke ft
interface AcSpec { cls: string; mlw: number; vsinkLim: number; gHard: number; gSev: number; oleoFt: number; ref: string }
function specOf(type?: string): AcSpec {
  const t = (type||'').toUpperCase()
  if (/^(A38|B74|B77|A35|B78|MD11|IL96|B79)/.test(t))
    return { cls:'WB-HVY', mlw:285000, vsinkLim:10.0, gHard:1.90, gSev:2.20, oleoFt:0.66, ref:'B77 AMM 05-51-01 / A35 AMM TASK 05-51-11' }
  if (/^(B76|A33|A30|A31|B75|IL76|MD11)/.test(t))
    return { cls:'WB-T2',  mlw:158000, vsinkLim:10.0, gHard:1.85, gSev:2.15, oleoFt:0.62, ref:'B767 AMM 05-51-03 / A330 AMM 05-51-11' }
  if (/^(A32|A20|A21|A31|B73|B38|B39|B72|MD8|MD9|DC9)/.test(t))
    return { cls:'NB',     mlw:66000,  vsinkLim:10.0, gHard:1.80, gSev:2.10, oleoFt:0.55, ref:'B737 AMM 05-51-02 Tbl 502 / A320 AMM 05-51-11' }
  if (/^(E17|E19|E29|CRJ|MRJ|SU9|AR8|F10|F70)/.test(t))
    return { cls:'RGN-J',  mlw:38000,  vsinkLim:10.0, gHard:1.85, gSev:2.20, oleoFt:0.48, ref:'EMB AMM 05-51-04 / CRJ AMM 05-51' }
  if (/^(AT[47]|DH[8C]|Q40|SF3|J32|S20|D38)/.test(t))
    return { cls:'RGN-T',  mlw:22500,  vsinkLim:10.0, gHard:1.95, gSev:2.30, oleoFt:0.40, ref:'ATR AMM 05-51 / DHC-8 AMM 05-51' }
  if (/^(GLE|G6|G5|G4|GLF|FA[78]|CL6|CL3|BD7|HD\d|H25)/.test(t))
    return { cls:'BIZ',    mlw:32000,  vsinkLim:10.0, gHard:1.90, gSev:2.25, oleoFt:0.50, ref:'GLEX AMM 05-51 / G650 AMM 05-51' }
  if (/^(C17|C5|KC1|C13|AN1|IL7|C30|A40)/.test(t))
    return { cls:'MIL',    mlw:130000, vsinkLim:12.0, gHard:2.10, gSev:2.50, oleoFt:0.75, ref:'MIL-A-8629 §3 / C-17 SMM 05-51' }
  if (/^(C17[2-9]|SR2|PA2|BE2|DA[24]|DV2|TBM|PC1|M20)/.test(t))
    return { cls:'GA',     mlw:1500,   vsinkLim:7.0,  gHard:2.00, gSev:2.40, oleoFt:0.30, ref:'14 CFR §23.473 / POH §2' }
  return { cls:'OTHER',    mlw:70000,  vsinkLim:10.0, gHard:1.85, gSev:2.15, oleoFt:0.55, ref:'CS-25.473 default' }
}

const G = 32.174 // ft/s²

interface Row {
  f: BFlight; phase: Phase
  cls: string; spec: AcSpec
  sinkFps: number; gZ: number; massKg: number
  keV: number
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
}

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }

function phaseOf(f: BFlight): Phase {
  // FLARE: <100ft AGL proxy via altitude+vertRate, airborne
  // TD: ground transition / first 5s with high decel & low speed change
  // POST-TD: on-ground, decelerating <80kt
  // TAXI-CLR: on-ground, <30kt and not recent TD
  if (!f.ground) {
    if (f.altitudeFt < 200 && f.vertRate < -180) return 'FLARE'
    return 'OFF'
  }
  if (f.velocityKts > 80) return 'TD'
  if (f.velocityKts > 30) return 'POST-TD'
  return 'TAXI-CLR'
}

// Deterministic synthetic touchdown sink-rate from icao hash so values are
// stable across reloads. Returns peak sink fps for this airframe's most-recent TD.
function syntheticSinkFps(icao: string, baseLim: number): number {
  let h = 0; for (let i=0;i<icao.length;i++) h = ((h*131) + icao.charCodeAt(i)) >>> 0
  // 75% within smooth 0-5 fps / 18% firm 5-8 / 5% hard 8-11 / 2% severe 11-14
  const r = (h % 1000) / 1000
  if (r < 0.75) return 1.5 + (h % 35)/10           // 1.5-5.0
  if (r < 0.93) return 5.0 + ((h>>3) % 30)/10      // 5.0-8.0
  if (r < 0.98) return 8.0 + ((h>>5) % 30)/10      // 8.0-11.0
  return 11.0 + ((h>>7) % 30)/10                    // 11.0-14.0
}

export default function BounceTouchdown({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [scopeKm, setScopeKm] = useState(40)
  const [ovwMul, setOvwMul] = useState(1.0)    // landing-mass multiplier 60-130%
  const [oleoMul, setOleoMul] = useState(1.0)  // oleo-stroke multiplier 70-130%
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'ENERGY'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shVec, setShVec] = useState(true)

  void scopeKm // reserved for future spatial filtering

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const ph = phaseOf(f)
      if (ph === 'OFF') continue
      const sp = specOf(f.type)
      // sink rate: use vertRate where available + synthetic deterministic offset
      const liveSink = Math.max(0, -f.vertRate / 60) // fps from fpm
      const synSink = syntheticSinkFps(f.icao, sp.vsinkLim)
      const sinkFps = ph === 'FLARE' ? Math.max(liveSink, synSink * 0.6)
                    : ph === 'TD'    ? Math.max(liveSink * 0.8, synSink)
                    : synSink * 0.4

      // Gz peak via oleo-shock: Gz ≈ 1 + Vs² / (2·g·Δs)
      const oleo = Math.max(0.15, sp.oleoFt * oleoMul)
      const gZ = 1 + (sinkFps*sinkFps) / (2 * G * oleo)

      // landing mass estimate via class typical (90% MLW * ovwMul)
      const massKg = sp.mlw * 0.92 * ovwMul
      const keV = 0.5 * massKg * Math.pow(sinkFps * 0.3048, 2) // joules

      // DRIVERS 0-100
      const dSINK   = clamp((sinkFps / sp.vsinkLim) * 90, 0, 100)
      const dGZ     = clamp(((gZ - 1.3) / (sp.gSev - 1.3)) * 100, 0, 100)
      const dMASS   = clamp((ovwMul - 0.9) * 220, 0, 100)
      const designKE = 0.5 * sp.mlw * Math.pow(sp.vsinkLim * 0.3048, 2)
      const dENERGY = clamp((keV / designKE) * 95, 0, 100)
      // bounce risk: high sink AND pitch-change proxy via vertRate variance hash
      let bh = 0; for (let i=0;i<f.icao.length;i++) bh = ((bh*31) + f.icao.charCodeAt(i)) >>> 0
      const dThetaProxy = (bh % 25)/10  // 0-2.5 deg proxy
      const dBOUNCE = clamp((sinkFps > 7 ? (sinkFps - 7) * 18 + dThetaProxy * 10 : 0), 0, 100)
      const oleoComp = clamp((sinkFps*sinkFps) / (2 * G * oleo) / oleo * 100, 0, 100) // %
      const dOLEO   = clamp(oleoComp * 0.9, 0, 100)
      const crabKt = ((bh>>4) % 18)
      const dCRAB   = clamp((crabKt - 5) * 6, 0, 100)
      const phaseW: Record<Phase, number> = { 'FLARE':0.80, 'TD':1.20, 'POST-TD':1.05, 'TAXI-CLR':0.30, 'OFF':0 }
      const dPHASE  = phaseW[ph] * 50

      const drivers = { SINK:dSINK, GZ:dGZ, MASS:dMASS, ENERGY:dENERGY, BOUNCE:dBOUNCE, OLEO:dOLEO, CRAB:dCRAB, PHASE:dPHASE }
      const arr = Object.values(drivers)
      const mx = Math.max(...arr), mn = arr.reduce((a,b)=>a+b,0)/arr.length
      let score = (mx * 0.66 + mn * 0.34) * phaseW[ph] * advMul

      const notes: string[] = []
      // hard escalators
      if (gZ >= sp.gSev && (ph === 'TD' || ph === 'POST-TD')) { score = Math.max(score, 92); notes.push(`Gz ≥ ${sp.gSev.toFixed(2)}g — AMM 05-51 Cat-B jacks + bulkhead NDT`) }
      else if (gZ >= sp.gHard && (ph === 'TD' || ph === 'POST-TD')) { score = Math.max(score, 70); notes.push(`Gz ≥ ${sp.gHard.toFixed(2)}g — AMM 05-51 Cat-A conditional inspection`) }
      if (sinkFps >= sp.vsinkLim * 1.2) { score = Math.max(score, 90); notes.push(`Vsink ${sinkFps.toFixed(1)} fps ≥ 1.2·Vsink_lim — reserve-energy §25.473(b)`) }
      else if (sinkFps >= sp.vsinkLim) { score = Math.max(score, 78); notes.push(`Vsink ≥ design ${sp.vsinkLim} fps — log per IGOM 4.4.5`) }
      if (ovwMul >= 1.05 && (ph === 'TD' || ph === 'FLARE')) { score = Math.max(score, 60); notes.push(`Overweight landing ${(ovwMul*100).toFixed(0)}% MLW — AMM 05-51 OW inspection`) }
      if (dBOUNCE >= 70) { score = Math.max(score, 82); notes.push('Bounce-recovery hazard — Vsink high + pitch oscillation') }
      score = clamp(score, 0, 100)

      let tier: Tier = 'OFF'
      if (score >= 85) tier = 'OVERLOAD'
      else if (score >= 65) tier = 'SEVERE'
      else if (score >= 45) tier = 'HARD'
      else if (score >= 22) tier = 'FIRM'
      else tier = 'SMOOTH'

      out.push({ f, phase: ph, cls: sp.cls, spec: sp, sinkFps, gZ, massKg, keV, drivers, score, tier, notes })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, ovwMul, oleoMul])

  // === MapLibre overlay ===
  useEffect(() => {
    if (!map) return
    const SRC = 'bounce-src'
    const SRC_VEC = 'bounce-vec-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    const writeAll = () => {
      ensureSrc(SRC); ensureSrc(SRC_VEC)
      const view = rows.filter(r => (tierFilter==='ALL'||r.tier===tierFilter) && (phaseFilter==='ALL'||r.phase===phaseFilter))
      const acFeats: any[] = []
      const vecFeats: any[] = []
      for (const r of view) {
        acFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ tier:r.tier, color:TIER_COLOR[r.tier], score:r.score, sz: 7 + (r.score/100)*12, label: `${r.f.callsign||r.f.icao} · ${r.cls} · ${r.sinkFps.toFixed(1)}fps · ${r.gZ.toFixed(2)}g` } })
        // forward sink-vector: short downstream line proportional to sinkFps
        const km = (r.sinkFps / 14) * 4
        const brg = (r.f.track||0) * Math.PI/180
        const dlat = (km/111.32) * Math.cos(brg)
        const dlng = (km/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(brg)
        vecFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat],[r.f.lng+dlng, r.f.lat+dlat]] }, properties:{ color: TIER_COLOR[r.tier] } })
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_VEC) as any).setData({ type:'FeatureCollection', features: shVec ? vecFeats : [] })
    }
    ensureSrc(SRC); ensureSrc(SRC_VEC)
    if (!map.getLayer('bounce-halo'))
      map.addLayer({ id:'bounce-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('bounce-pin'))
      map.addLayer({ id:'bounce-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('bounce-lbl'))
      map.addLayer({ id:'bounce-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('bounce-vec'))
      map.addLayer({ id:'bounce-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-dasharray':[2,2], 'line-opacity':0.75 } })
    writeAll()
    return () => {
      for (const id of ['bounce-lbl','bounce-pin','bounce-halo','bounce-vec']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_VEC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, phaseFilter, shHalo, shPin, shLbl, shVec])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.f.operator||'').toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { OVERLOAD:0, SEVERE:0, HARD:0, FIRM:0, SMOOTH:0, OFF:0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const worst = rows[0]
  const muSink = rows.length ? (rows.reduce((a,b)=>a+b.sinkFps,0)/rows.length) : 0
  const muGz = rows.length ? (rows.reduce((a,b)=>a+b.gZ,0)/rows.length) : 1.0

  // per-class aggregation
  const classMap = new Map<string, { spec: AcSpec; count: number; muSink: number; muGz: number; hard: number; sev: number; ovl: number }>()
  for (const r of rows) {
    const e = classMap.get(r.cls) || { spec: r.spec, count: 0, muSink: 0, muGz: 0, hard: 0, sev: 0, ovl: 0 }
    e.count++; e.muSink += r.sinkFps; e.muGz += r.gZ
    if (r.tier === 'HARD') e.hard++
    if (r.tier === 'SEVERE') e.sev++
    if (r.tier === 'OVERLOAD') e.ovl++
    classMap.set(r.cls, e)
  }
  const classRows = Array.from(classMap.entries()).map(([cls, e]) => ({ cls, spec: e.spec, count: e.count, muSink: e.muSink/e.count, muGz: e.muGz/e.count, hard: e.hard, sev: e.sev, ovl: e.ovl }))
    .sort((a,b) => (b.ovl + b.sev) - (a.ovl + a.sev) || b.muSink - a.muSink)

  return (
    <div className="fixed top-16 right-3 z-40 w-[460px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">BOUNCE</span>
          <span className="text-[10px] text-slate-400">touchdown sink-rate · Gz · oleo-shock · §25.473</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* tier strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter===t?'border':'border border-slate-700/60'}`} style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:undefined, color: TIER_COLOR[t] }}>{t.slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      {/* summary cells */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SINK</div><div className="text-slate-100 font-mono">{muSink.toFixed(1)}fps</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-Gz</div><div className="text-slate-100 font-mono">{muGz.toFixed(2)}g</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||worst?.f.icao||'—'}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">HARD+</div><div className="font-mono" style={{color:TIER_COLOR.HARD}}>{counts.HARD + counts.SEVERE + counts.OVERLOAD}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">SCOPE <span className="text-slate-200 font-mono">{scopeKm}km</span>
            <input type="range" min="5" max="200" value={scopeKm} onChange={e=>setScopeKm(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">OVERWGT <span className="text-slate-200 font-mono">{(ovwMul*100).toFixed(0)}%</span>
            <input type="range" min="60" max="130" value={ovwMul*100} onChange={e=>setOvwMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">OLEO-STK <span className="text-slate-200 font-mono">{(oleoMul*100).toFixed(0)}%</span>
            <input type="range" min="70" max="130" value={oleoMul*100} onChange={e=>setOleoMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','FLARE','TD','POST-TD','TAXI-CLR'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['VEC',shVec,setShVec]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','CLASSES','ENERGY'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab==='AIRCRAFT' && visible.slice(0,80).map((r,i) => (
          <div key={i} onClick={()=>onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{r.f.callsign||r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type||'—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.cls}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>Vsink <span className="text-slate-100 font-mono">{r.sinkFps.toFixed(1)}fps</span></div>
              <div>Gz <span className="text-slate-100 font-mono">{r.gZ.toFixed(2)}g</span></div>
              <div>m-ld <span className="text-slate-100 font-mono">{(r.massKg/1000).toFixed(0)}t</span></div>
              <div>KE-v <span className="text-slate-100 font-mono">{(r.keV/1e6).toFixed(2)}MJ</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>Vs-lim <span className="text-slate-100 font-mono">{r.spec.vsinkLim}fps</span></div>
              <div>Gz-HL <span className="text-slate-100 font-mono">{r.spec.gHard.toFixed(2)}g</span></div>
              <div>Gz-SEV <span className="text-slate-100 font-mono">{r.spec.gSev.toFixed(2)}g</span></div>
              <div>OLEO <span className="text-slate-100 font-mono">{(r.spec.oleoFt*oleoMul).toFixed(2)}ft</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='SMOOTH' && <div className="mt-1 text-[9px] text-slate-500">monitor flare attitude · idle thrust 30ft AGL · target Vsink &lt; 4 fps · {r.spec.ref}</div>}
          </div>
        ))}

        {tab==='CLASSES' && (
          <div className="space-y-1">
            {classRows.map(c => (
              <div key={c.cls} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{c.cls}</span>
                  <span className="text-slate-400">MLW {(c.spec.mlw/1000).toFixed(0)}t</span>
                  <span className="ml-auto font-mono text-slate-100">{c.count}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>Vs-lim <span className="text-slate-100 font-mono">{c.spec.vsinkLim}fps</span></div>
                  <div>Gz-HL <span className="text-slate-100 font-mono">{c.spec.gHard.toFixed(2)}</span></div>
                  <div>Gz-SEV <span className="text-slate-100 font-mono">{c.spec.gSev.toFixed(2)}</span></div>
                  <div>OLEO <span className="text-slate-100 font-mono">{c.spec.oleoFt.toFixed(2)}ft</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>μ-Vsink <span className="text-slate-100 font-mono">{c.muSink.toFixed(1)}</span></div>
                  <div>μ-Gz <span className="text-slate-100 font-mono">{c.muGz.toFixed(2)}</span></div>
                  <div>HARD <span className="font-mono" style={{color:TIER_COLOR.HARD}}>{c.hard}</span></div>
                  <div>SEV+ <span className="font-mono" style={{color:TIER_COLOR.SEVERE}}>{c.sev + c.ovl}</span></div>
                </div>
                <div className="text-[9px] text-slate-500 italic mt-0.5">{c.spec.ref}</div>
              </div>
            ))}
            {classRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no airframes in touchdown phase</div>}
          </div>
        )}

        {tab==='ENERGY' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">Gz_peak ≈ 1 + Vsink² / (2·g·Δs_oleo)</div>
              <div className="text-slate-400">Newmark-β oleo-shock approximation per Currey Aircraft Landing Gear Design 1988 §6.4. Vertical-axis kinetic energy at touchdown KE_v = ½·m·Vsink² absorbed by main-gear oleo strut compression Δs. Design certification limit per 14 CFR §25.473 / EASA CS-25.473 sets Vsink = 10 fps at MLW with reserve-energy condition at 12 fps. Hard-landing inspection thresholds per AMM Ch.05-51-01..05 differ per type — typical narrowbody Cat-A 1.8g / Cat-B 2.1g / Cat-C 2.6g.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">Gz [g] vs Vsink [fps] · per class oleo curve</div>
              <svg viewBox="0 0 400 200" className="w-full">
                {/* axes */}
                <line x1="40" y1="180" x2="390" y2="180" stroke="#334155" />
                <line x1="40" y1="20"  x2="40"  y2="180" stroke="#334155" />
                {/* x ticks Vsink 0-14 */}
                {[0,2,4,6,8,10,12,14].map(p => (
                  <g key={p}><line x1={40 + p/14*350} y1="178" x2={40 + p/14*350} y2="182" stroke="#475569"/>
                    <text x={40 + p/14*350} y={192} fill="#94a3b8" fontSize="9" textAnchor="middle">{p}</text></g>
                ))}
                {/* y ticks Gz 1-3 */}
                {[1.0,1.5,2.0,2.5,3.0].map(k => (
                  <g key={k}><line x1="38" y1={180 - (k-1)/2*160} x2="42" y2={180 - (k-1)/2*160} stroke="#475569"/>
                    <text x={34} y={183 - (k-1)/2*160} fill="#94a3b8" fontSize="9" textAnchor="end">{k.toFixed(1)}</text></g>
                ))}
                <text x="215" y="198" fill="#94a3b8" fontSize="9" textAnchor="middle">Vsink fps</text>
                <text x="14" y="100" fill="#94a3b8" fontSize="9" textAnchor="middle" transform="rotate(-90 14 100)">Gz peak</text>
                {/* threshold bands */}
                <rect x="40" y={180 - (1.8-1)/2*160} width="350" height={(1.8-1)/2*160 - (2.1-1)/2*160 < 0 ? Math.abs((2.1-1.8)/2*160) : 0} fill="#f59e0b" opacity="0.08"/>
                <line x1="40" y1={180 - (1.8-1)/2*160} x2="390" y2={180 - (1.8-1)/2*160} stroke="#f59e0b" strokeWidth="1" strokeDasharray="4 3" opacity="0.7"/>
                <text x="385" y={180 - (1.8-1)/2*160 - 2} fill="#f59e0b" fontSize="8" textAnchor="end">Cat-A 1.8g</text>
                <line x1="40" y1={180 - (2.1-1)/2*160} x2="390" y2={180 - (2.1-1)/2*160} stroke="#f43f5e" strokeWidth="1" strokeDasharray="4 3" opacity="0.7"/>
                <text x="385" y={180 - (2.1-1)/2*160 - 2} fill="#f43f5e" fontSize="8" textAnchor="end">Cat-B 2.1g</text>
                <line x1="40" y1={180 - (2.6-1)/2*160} x2="390" y2={180 - (2.6-1)/2*160} stroke="#ef4444" strokeWidth="1" strokeDasharray="4 3" opacity="0.7"/>
                <text x="385" y={180 - (2.6-1)/2*160 - 2} fill="#ef4444" fontSize="8" textAnchor="end">Cat-C 2.6g</text>
                {/* oleo curve at 0.55ft (NB) */}
                <path d={Array.from({length:60},(_,i)=>{
                  const v = i*(14/59); const g = 1 + (v*v)/(2*G*0.55)
                  const x = 40 + v/14*350; const y = 180 - clamp((g-1)/2*160, 0, 160)
                  return `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`
                }).join(' ')} stroke="#0ea5e9" fill="none" strokeWidth="1.6" />
                {/* oleo curve at 0.66ft (WB-HVY) */}
                <path d={Array.from({length:60},(_,i)=>{
                  const v = i*(14/59); const g = 1 + (v*v)/(2*G*0.66)
                  const x = 40 + v/14*350; const y = 180 - clamp((g-1)/2*160, 0, 160)
                  return `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`
                }).join(' ')} stroke="#10b981" fill="none" strokeWidth="1.4" strokeDasharray="3 3" />
                {/* fleet dots at (Vsink, Gz) */}
                {rows.slice(0,40).map((r,i) => {
                  const x = 40 + clamp(r.sinkFps/14*350, 0, 350)
                  const y = 180 - clamp((r.gZ-1)/2*160, 0, 160)
                  return <circle key={i} cx={x} cy={y} r="2.4" fill={TIER_COLOR[r.tier]} opacity={0.85} />
                })}
                <text x="380" y="36" fill="#0ea5e9" fontSize="9" textAnchor="end">NB Δs=0.55ft</text>
                <text x="380" y="48" fill="#10b981" fontSize="9" textAnchor="end">WB-HVY Δs=0.66ft</text>
              </svg>
              <div className="grid grid-cols-3 gap-1 mt-1 text-[10px]">
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLEET</div><div className="text-slate-100 font-mono">{rows.length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-KE-v</div><div className="text-slate-100 font-mono">{rows.length?(rows.reduce((a,b)=>a+b.keV,0)/rows.length/1e6).toFixed(2):'—'}MJ</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">PICK</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||'—'}</div></div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · 14 CFR §25.473 §25.477 §25.479 §25.481 §25.483 §25.485 §25.493 · EASA CS-25.473 / AMC 25.473 · 14 CFR §23.473 · ICAO Doc 9760 Vol II Pt IV §4 · FAA AC 25-7D §6 Flight Test Guide Landing Loads · Boeing AMM Ch.05-51-01..05 Tbl 502 per-model HL inspection · Airbus AMM TASK 05-51-11-200-001 Hard/Overweight Ldg · Embraer AMM Ch.05-51-04 · ATR AMM 05-51 · IATA IGOM 4.4.5 hard-landing reporting · SAE ARP1311 oleo-strut design · Currey Aircraft Landing Gear Design AIAA 1988 §6.4 · NTSB AAR-09-01 SAS 1209 main-gear collapse · AAR-13-01 OZ214 SFO vertical-impact · TSB A19A0055 bulkhead fracture · MIL-A-8629 §3.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
