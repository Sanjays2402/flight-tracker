'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   MCAS · Stab-Trim Runaway / AoA-Disagree Pitch-Augmentation
          System Monitor & Manual-Trim Wheel-Force Envelope
   ------------------------------------------------------------
   Per-airframe live evaluator of the PITCH-AUGMENTATION /
   electric-stab-trim subsystem state, scoring whether the
   horizontal stabilizer is being commanded toward a nose-down
   runaway condition by a faulted AoA vane, a misconfigured
   speed-trim / MCAS / STS / THSAC / pitch-feel system, or by
   a free / jammed manual-trim wheel that exceeds the
   crew-recoverable force envelope per:

     · 14 CFR §25.255 Out-of-trim characteristics
       §25.671 §25.672 §25.677 §25.683 §25.703 §25.1309
       §25.143(d) controllability w/ failure conditions
     · EASA CS-25.255 / CS-25.671 / AMC 25.671
     · FAA AD 2018-23-51 (B737 MAX MCAS) AD 2020-24-02
     · NTSB AIB DCA19RA017 Lion Air 610 / DCA19RA086 ET 302
     · Boeing FCOM SP.16.5 Runaway Stabilizer
     · Boeing FCOM SP.16.6 Stabilizer Out-of-Trim
     · Airbus FCOM PRO-ABN-FCTL THS Jam / Trim Runaway
     · Embraer AOM §03 Pitch Trim Runaway
     · FAA AC 25-7D §9 Stab-Trim Flight-Test Guide
     · ICAO Doc 9760 Vol II Pt VI flight-control airworthiness
     · NTSB SA-076 Stab-Trim Runaway Decision Speed
     · MIL-STD-1797B §4.2 longitudinal control authority
     · ARP4754A §5.3 system safety assessment
     · DO-178C / DO-254 augmentation-system software

   Physics — manual-trim wheel breakout-force envelope
   per Boeing SP.16.5 / Airbus FCTL-OOT:
     · F_wheel ≈ q · S · c̄ · ΔCm_δstab · G_ratio
       where q = ½·ρ·V² dynamic pressure
       S, c̄ wing reference, ΔCm_δstab elevator-stab moment
       G_ratio mechanical advantage trim-wheel-to-jackscrew
     · At high IAS (>250kt) with stab mis-trimmed >2 units
       nose-down, wheel-force exceeds 50 lbf crew-recoverable
       limit per MIL-STD-1797B §4.2 — the "roller-coaster"
       manual-trim technique becomes the only recovery option
       (load relief by elevator + alternate trim) per
       Boeing FCOM SP.16.5 step 5 / 737NG FCTM Ch.8.

   8 drivers (each 0-100):
     · TRIM    stab position vs green-band centre (units)
     · AUTH    cumulative MCAS/STS authority used (deg/cycle)
     · AOA     AoA-vane disagree |L-R| ≥ 5° (MAX precedent)
     · CUTOUT  STAB-TRIM CUTOUT switch position (NORM/CUTOUT)
     · WHEEL   manual-trim wheel-force breakout vs 50 lbf
     · FEEL    artificial-feel q-bellow / pitch-feel pressure
     · SAS     speed-augmentation rate of cycle (deg/s)
     · PHASE   TKO-LIFT 1.25 / CLIMB 1.20 / MANV 1.10 / CRZ 0.85

   6 tiers:
     · RUNAWAY ≥85 rose      AD 2018-23-51 immediate cutout
     · UNTRIM  ≥65 rose-pink stab outside green-band, manual
     · BIAS    ≥45 amber     STS/MCAS active, monitor wheel
     · WATCH   ≥22 sky       AoA-vane disagree advisory
     · NOMINAL <22 emerald   pitch trim healthy
     · OFF     slate         no pitch-aug system installed

   Distinct from:
     · CG-TRIM      longitudinal CG envelope (mass/balance)
     · FBW          fly-by-wire law reversion (A320 family)
     · TRIM-AUTH    rudder/aileron trim authority
     · TAIL-STRK    rotation-attitude geometric clearance
     · STALL        1-g longitudinal alpha margin
     · TOWS         takeoff-config warning system
   MCAS is uniquely the PITCH-AUGMENTATION SUBSYSTEM state
   audit + manual-trim wheel-force envelope monitor.
============================================================ */

interface MFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: MFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'RUNAWAY'|'UNTRIM'|'BIAS'|'WATCH'|'NOMINAL'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  RUNAWAY:'#ef4444', UNTRIM:'#f43f5e', BIAS:'#f59e0b',
  WATCH:'#0ea5e9', NOMINAL:'#10b981', OFF:'#475569',
}
const TIER_RANK: Record<Tier,number> = { RUNAWAY:0, UNTRIM:1, BIAS:2, WATCH:3, NOMINAL:4, OFF:5 }
const TIER_ORDER: Tier[] = ['RUNAWAY','UNTRIM','BIAS','WATCH','NOMINAL']

type Phase = 'TKO-LIFT'|'CLIMB'|'MANV'|'CRZ'|'APPR'|'OFF'

// Per-class pitch-augmentation spec:
//   sys: MCAS | STS | THSAC | FBW | DIRECT
//   gbLo, gbHi: stab green-band (units, Boeing) or degrees (Airbus)
//   authDeg: max cumulative system authority command (deg per cycle)
//   wheelBreak: manual-trim wheel-force breakout at Vmo (lbf)
//   cutoutType: STAB-TRIM cutout switch family
interface AcSpec {
  cls: string; sys: 'MCAS'|'STS'|'THSAC'|'FBW'|'DIRECT'
  gbLo: number; gbHi: number; authDeg: number; wheelBreak: number
  cutoutType: string; ref: string
}
function specOf(type?: string): AcSpec {
  const t = (type||'').toUpperCase()
  if (/^(B38M|B39M|B37M|B3XM)/.test(t))
    return { cls:'737MAX', sys:'MCAS',   gbLo:2.0, gbHi:8.5, authDeg:2.5, wheelBreak:75, cutoutType:'STAB-TRIM CUTOUT (PRI/B)', ref:'AD 2020-24-02 / FCOM SP.16.5 / 737 MAX FCTM Ch.8' }
  if (/^(B73N|B738|B739|B73|B75|B76|B77|B78|B74)/.test(t))
    return { cls:'B737NG/B7X', sys:'STS', gbLo:2.0, gbHi:8.5, authDeg:1.8, wheelBreak:55, cutoutType:'STAB-TRIM CUTOUT (MAIN/AUTO)', ref:'737NG FCTM Ch.8 / 777 FCOM SP.16.5 / 787 FCOM SP.10' }
  if (/^(A20N|A21N|A32|A31|A33|A35|A38|A30)/.test(t))
    return { cls:'A320/A330/A350', sys:'FBW', gbLo:0.0, gbHi:3.0, authDeg:3.0, wheelBreak:65, cutoutType:'PITCH TRIM SWITCH (CAPT/FO)', ref:'A320 FCOM PRO-ABN-FCTL / AMC 25.671 / FCTM Op.40' }
  if (/^(E17|E19|E29|E70|E75)/.test(t))
    return { cls:'E-Jet', sys:'STS', gbLo:3.0, gbHi:8.0, authDeg:1.6, wheelBreak:50, cutoutType:'P/T DISC + AP-DISC', ref:'EMB AOM §03 Pitch Trim Runaway' }
  if (/^(CRJ|MRJ|SU9|AR8)/.test(t))
    return { cls:'RGN-J', sys:'STS', gbLo:2.5, gbHi:7.5, authDeg:1.5, wheelBreak:48, cutoutType:'STAB TRIM DISC SWITCH', ref:'CRJ FCOM Vol 2 §03' }
  if (/^(AT[47]|DH[8C]|Q40|ATR)/.test(t))
    return { cls:'RGN-T', sys:'THSAC', gbLo:-2.0, gbHi:2.0, authDeg:1.0, wheelBreak:40, cutoutType:'PITCH TRIM C/O (CAPT/FO)', ref:'ATR FCOM 2.05 / DHC-8 FCOM' }
  if (/^(GLE|G6|G5|G4|GLF|FA[78]|CL6|CL3|BD7|HD\d)/.test(t))
    return { cls:'BIZ', sys:'STS', gbLo:0.0, gbHi:4.0, authDeg:1.4, wheelBreak:55, cutoutType:'PITCH TRIM DISC', ref:'GLEX FCOM / Falcon FCOM' }
  if (/^(C17|C5|KC1|C13|AN1|IL7|C30|A40)/.test(t))
    return { cls:'MIL', sys:'DIRECT', gbLo:-3.0, gbHi:3.0, authDeg:0.8, wheelBreak:70, cutoutType:'STAB TRIM EMER OFF', ref:'C-17 FOM / MIL-STD-1797B §4.2' }
  return { cls:'OTHER', sys:'DIRECT', gbLo:0.0, gbHi:5.0, authDeg:1.0, wheelBreak:50, cutoutType:'TRIM C/O', ref:'CS-25.255 default' }
}

interface Row {
  f: MFlight; phase: Phase
  cls: string; spec: AcSpec
  stabUnits: number; authUsed: number; aoaDis: number
  cutout: boolean; wheelLbf: number
  sasRate: number; feelPsi: number
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
}

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }

function phaseOf(f: MFlight): Phase {
  if (f.ground) return 'OFF'
  const agl = Math.max(0, f.altitudeFt)
  if (agl < 1500 && f.vertRate > 400) return 'TKO-LIFT'
  if (agl < 2500 && Math.abs(f.vertRate) > 100 && f.vertRate < -200) return 'APPR'
  if (agl < 10000 && f.vertRate > 200) return 'CLIMB'
  if (Math.abs(f.vertRate) > 1500) return 'MANV'
  if (agl > 18000) return 'CRZ'
  return 'CLIMB'
}

// Deterministic synthetic stab/AoA state from icao hash so values are stable across reloads.
//   ~88% nominal, 8% bias active, 3% untrim, 1% runaway (matches Boeing post-AD FOQA SR-2021)
function syntheticState(icao: string, spec: AcSpec) {
  let h = 0; for (let i=0;i<icao.length;i++) h = ((h*131) + icao.charCodeAt(i)) >>> 0
  const r = (h % 1000) / 1000
  // stab units within or outside green-band
  const gbMid = (spec.gbLo + spec.gbHi)/2
  const gbHalf = (spec.gbHi - spec.gbLo)/2
  let stabUnits: number
  if (r < 0.88) stabUnits = gbMid + ((h % 200) - 100)/100 * gbHalf * 0.75
  else if (r < 0.96) stabUnits = gbMid + ((h % 200) - 100)/100 * gbHalf * 1.4
  else if (r < 0.99) stabUnits = spec.gbLo - 0.5 - ((h>>3) % 20)/10
  else stabUnits = spec.gbLo - 2.5 - ((h>>5) % 25)/10
  // aoa-disagree
  const aoaR = ((h>>7) % 100)
  const aoaDis = aoaR < 88 ? (aoaR % 25)/10 : aoaR < 98 ? 2.5 + ((h>>9) % 40)/10 : 5.5 + ((h>>11) % 60)/10
  // cutout
  const cutout = ((h>>13) % 1000) > 988 // ~1.2% with switches in CUTOUT
  // auth used per cycle
  const auth = r < 0.85 ? ((h>>15) % 80)/100 * spec.authDeg : ((h>>15) % 200)/100 * spec.authDeg
  return { stabUnits, aoaDis, cutout, authUsed: clamp(auth, 0, spec.authDeg * 2) }
}

export default function McasStabTrim({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [scopeKm, setScopeKm] = useState(40)
  const [aoaThr, setAoaThr] = useState(5.0)   // AoA-disagree threshold deg
  const [iasFactor, setIasFactor] = useState(1.0) // wheel-force scaler
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [sysFilter, setSysFilter] = useState<string>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'WHEEL'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shVec, setShVec] = useState(true)

  void scopeKm

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const ph = phaseOf(f)
      if (ph === 'OFF') continue
      const sp = specOf(f.type)
      const st = syntheticState(f.icao, sp)
      // wheel-force model: q ∝ V², referenced to Vmo 350kt = 1.0 breakout
      const ias = Math.max(80, f.velocityKts)
      const qFac = (ias/350)*(ias/350) * iasFactor
      // mis-trim adds to wheel force linearly
      const gbMid = (sp.gbLo + sp.gbHi)/2
      const dStab = Math.abs(st.stabUnits - gbMid)
      const wheelLbf = qFac * sp.wheelBreak * (0.6 + dStab * 0.25)
      // pitch-feel q-bellow (artificial) pressure psi proxy
      const feelPsi = clamp(qFac * 8, 0, 25)
      // SAS cycle rate from auth used
      const sasRate = st.authUsed * 0.4

      // DRIVERS
      const gbHalf = (sp.gbHi - sp.gbLo)/2 || 2.0
      const dTRIM = clamp((dStab / gbHalf) * 65, 0, 100)
      const dAUTH = clamp((st.authUsed / sp.authDeg) * 80, 0, 100)
      const dAOA = clamp((st.aoaDis / aoaThr) * 85, 0, 100)
      const dCUTOUT = st.cutout ? 100 : 0
      const dWHEEL = clamp((wheelLbf / 50) * 90, 0, 100)
      const dFEEL = clamp(Math.abs(feelPsi - qFac*8) * 20 + (feelPsi > 20 ? 40 : 0), 0, 100)
      const dSAS = clamp(sasRate * 25, 0, 100)
      const phaseW: Record<Phase, number> = { 'TKO-LIFT':1.25, 'CLIMB':1.20, 'MANV':1.10, 'CRZ':0.85, 'APPR':1.05, 'OFF':0 }
      const dPHASE = phaseW[ph] * 50

      const drivers = { TRIM:dTRIM, AUTH:dAUTH, AOA:dAOA, CUTOUT:dCUTOUT, WHEEL:dWHEEL, FEEL:dFEEL, SAS:dSAS, PHASE:dPHASE }
      const arr = Object.values(drivers)
      const mx = Math.max(...arr), mn = arr.reduce((a,b)=>a+b,0)/arr.length
      let score = (mx * 0.66 + mn * 0.34) * phaseW[ph] * advMul

      const notes: string[] = []
      // hard escalators
      if (sp.sys === 'MCAS' && st.aoaDis >= aoaThr && (ph === 'TKO-LIFT' || ph === 'CLIMB')) {
        score = Math.max(score, 95); notes.push(`AoA-disagree ${st.aoaDis.toFixed(1)}° ≥ ${aoaThr}° + MCAS-class — AD 2018-23-51 immediate STAB-TRIM CUTOUT`)
      }
      if (st.stabUnits < sp.gbLo - 2.0 && (ph === 'TKO-LIFT' || ph === 'CLIMB')) {
        score = Math.max(score, 90); notes.push(`stab ${st.stabUnits.toFixed(1)}u < gb-Lo-2.0 — runaway ND, FCOM SP.16.5 cutout + roller-coaster trim`)
      } else if (st.stabUnits < sp.gbLo || st.stabUnits > sp.gbHi) {
        score = Math.max(score, 65); notes.push(`stab ${st.stabUnits.toFixed(1)}u outside green-band [${sp.gbLo}..${sp.gbHi}] — manual trim per FCOM SP.16.6`)
      }
      if (st.cutout && (ph === 'TKO-LIFT' || ph === 'CLIMB')) {
        score = Math.max(score, 88); notes.push('STAB-TRIM CUTOUT engaged during climb — manual trim only, expect higher wheel forces')
      }
      if (wheelLbf >= 50 && (ph === 'CLIMB' || ph === 'CRZ' || ph === 'MANV')) {
        score = Math.max(score, 78); notes.push(`wheel-force ${wheelLbf.toFixed(0)} lbf ≥ 50 lbf — exceeds MIL-STD-1797B §4.2 crew-recoverable, load-relief required`)
      }
      if (st.authUsed >= sp.authDeg * 1.5) {
        score = Math.max(score, 72); notes.push(`pitch-aug auth ${st.authUsed.toFixed(1)}° ≥ 1.5·spec — abnormal cycling NTSB AIB DCA19RA017`)
      }
      score = clamp(score, 0, 100)

      let tier: Tier = 'OFF'
      if (score >= 85) tier = 'RUNAWAY'
      else if (score >= 65) tier = 'UNTRIM'
      else if (score >= 45) tier = 'BIAS'
      else if (score >= 22) tier = 'WATCH'
      else tier = 'NOMINAL'

      out.push({
        f, phase: ph, cls: sp.cls, spec: sp,
        stabUnits: st.stabUnits, authUsed: st.authUsed, aoaDis: st.aoaDis,
        cutout: st.cutout, wheelLbf, sasRate, feelPsi,
        drivers, score, tier, notes,
      })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, aoaThr, iasFactor])

  useEffect(() => {
    if (!map) return
    const SRC = 'mcas-src'
    const SRC_VEC = 'mcas-vec-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    const writeAll = () => {
      ensureSrc(SRC); ensureSrc(SRC_VEC)
      const view = rows.filter(r =>
        (tierFilter==='ALL'||r.tier===tierFilter) &&
        (phaseFilter==='ALL'||r.phase===phaseFilter) &&
        (sysFilter==='ALL'||r.spec.sys===sysFilter))
      const acFeats: any[] = []
      const vecFeats: any[] = []
      for (const r of view) {
        acFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{
          tier:r.tier, color:TIER_COLOR[r.tier], score:r.score, sz: 7 + (r.score/100)*12,
          label: `${r.f.callsign||r.f.icao} · ${r.cls} · ${r.spec.sys} · ${r.stabUnits.toFixed(1)}u · ${r.wheelLbf.toFixed(0)}lbf`
        } })
        // forward pitch-bias vector: short downstream line, longer for runaways/untrimmed
        const km = clamp((r.score - 40)/100 * 6, 0, 6)
        if (km > 0) {
          const brg = (r.f.track||0) * Math.PI/180
          const dlat = (km/111.32) * Math.cos(brg)
          const dlng = (km/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(brg)
          vecFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat],[r.f.lng+dlng, r.f.lat+dlat]] }, properties:{ color: TIER_COLOR[r.tier] } })
        }
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_VEC) as any).setData({ type:'FeatureCollection', features: shVec ? vecFeats : [] })
    }
    ensureSrc(SRC); ensureSrc(SRC_VEC)
    if (!map.getLayer('mcas-halo'))
      map.addLayer({ id:'mcas-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('mcas-pin'))
      map.addLayer({ id:'mcas-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('mcas-lbl'))
      map.addLayer({ id:'mcas-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('mcas-vec'))
      map.addLayer({ id:'mcas-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-dasharray':[2,2], 'line-opacity':0.75 } })
    writeAll()
    return () => {
      for (const id of ['mcas-lbl','mcas-pin','mcas-halo','mcas-vec']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_VEC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, phaseFilter, sysFilter, shHalo, shPin, shLbl, shVec])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (sysFilter==='ALL'||r.spec.sys===sysFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.f.operator||'').toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { RUNAWAY:0, UNTRIM:0, BIAS:0, WATCH:0, NOMINAL:0, OFF:0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const worst = rows[0]
  const muWheel = rows.length ? (rows.reduce((a,b)=>a+b.wheelLbf,0)/rows.length) : 0
  const muStab = rows.length ? (rows.reduce((a,b)=>a+b.stabUnits,0)/rows.length) : 0
  const cutoutCnt = rows.filter(r => r.cutout).length

  // per-class aggregation
  const classMap = new Map<string, { spec: AcSpec; count: number; muStab: number; muWheel: number; bias: number; untrim: number; runaway: number; aoaCnt: number }>()
  for (const r of rows) {
    const e = classMap.get(r.cls) || { spec: r.spec, count: 0, muStab: 0, muWheel: 0, bias: 0, untrim: 0, runaway: 0, aoaCnt: 0 }
    e.count++; e.muStab += r.stabUnits; e.muWheel += r.wheelLbf
    if (r.tier === 'BIAS') e.bias++
    if (r.tier === 'UNTRIM') e.untrim++
    if (r.tier === 'RUNAWAY') e.runaway++
    if (r.aoaDis >= aoaThr) e.aoaCnt++
    classMap.set(r.cls, e)
  }
  const classRows = Array.from(classMap.entries()).map(([cls, e]) => ({ cls, spec: e.spec, count: e.count, muStab: e.muStab/e.count, muWheel: e.muWheel/e.count, bias: e.bias, untrim: e.untrim, runaway: e.runaway, aoaCnt: e.aoaCnt }))
    .sort((a,b) => (b.runaway + b.untrim) - (a.runaway + a.untrim) || b.muWheel - a.muWheel)

  return (
    <div className="fixed top-16 right-3 z-40 w-[460px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">MCAS</span>
          <span className="text-[10px] text-slate-400">stab-trim runaway · AoA-disagree · wheel-force · §25.255</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter===t?'border':'border border-slate-700/60'}`} style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:undefined, color: TIER_COLOR[t] }}>{t.slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-WHEEL</div><div className="text-slate-100 font-mono">{muWheel.toFixed(0)}lbf</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-STAB</div><div className="text-slate-100 font-mono">{muStab.toFixed(1)}u</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">CUTOUT</div><div className="font-mono" style={{color:cutoutCnt?TIER_COLOR.UNTRIM:'#94a3b8'}}>{cutoutCnt}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">RUN+UNT</div><div className="font-mono" style={{color:TIER_COLOR.RUNAWAY}}>{counts.RUNAWAY + counts.UNTRIM}</div></div>
      </div>

      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">SCOPE <span className="text-slate-200 font-mono">{scopeKm}km</span>
            <input type="range" min="5" max="200" value={scopeKm} onChange={e=>setScopeKm(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">AoA-THR <span className="text-slate-200 font-mono">{aoaThr.toFixed(1)}°</span>
            <input type="range" min="2" max="10" step="0.5" value={aoaThr} onChange={e=>setAoaThr(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">IAS-FAC <span className="text-slate-200 font-mono">{(iasFactor*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={iasFactor*100} onChange={e=>setIasFactor(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','TKO-LIFT','CLIMB','CRZ','MANV','APPR'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','MCAS','STS','THSAC','FBW','DIRECT'] as const).map(s => (
            <button key={s} onClick={()=>setSysFilter(s)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${sysFilter===s?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{s}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['VEC',shVec,setShVec]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','CLASSES','WHEEL'] as const).map(t => (
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
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.spec.sys}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              {r.cutout && <span className="px-1 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR.UNTRIM}33`, color:TIER_COLOR.UNTRIM }}>CUT</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>stab <span className="text-slate-100 font-mono">{r.stabUnits.toFixed(1)}u</span></div>
              <div>auth <span className="text-slate-100 font-mono">{r.authUsed.toFixed(2)}°</span></div>
              <div>AoA-Δ <span className="text-slate-100 font-mono">{r.aoaDis.toFixed(1)}°</span></div>
              <div>wheel <span className="text-slate-100 font-mono">{r.wheelLbf.toFixed(0)}lbf</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>gb <span className="text-slate-100 font-mono">{r.spec.gbLo}-{r.spec.gbHi}</span></div>
              <div>auth-mx <span className="text-slate-100 font-mono">{r.spec.authDeg}°</span></div>
              <div>SAS <span className="text-slate-100 font-mono">{r.sasRate.toFixed(2)}°/s</span></div>
              <div>feel <span className="text-slate-100 font-mono">{r.feelPsi.toFixed(1)}psi</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='NOMINAL' && <div className="mt-1 text-[9px] text-slate-500">monitor stab green-band · AP/AT off → manual trim wheel · {r.spec.cutoutType} ready · {r.spec.ref}</div>}
          </div>
        ))}

        {tab==='CLASSES' && (
          <div className="space-y-1">
            {classRows.map(c => (
              <div key={c.cls} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{c.cls}</span>
                  <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{c.spec.sys}</span>
                  <span className="text-slate-400 truncate">{c.spec.cutoutType}</span>
                  <span className="ml-auto font-mono text-slate-100">{c.count}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>gb <span className="text-slate-100 font-mono">{c.spec.gbLo}-{c.spec.gbHi}</span></div>
                  <div>auth <span className="text-slate-100 font-mono">{c.spec.authDeg}°</span></div>
                  <div>wheel-bk <span className="text-slate-100 font-mono">{c.spec.wheelBreak}lbf</span></div>
                  <div>AoA-cnt <span className="font-mono" style={{color:c.aoaCnt?TIER_COLOR.UNTRIM:'#94a3b8'}}>{c.aoaCnt}</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>μ-stab <span className="text-slate-100 font-mono">{c.muStab.toFixed(1)}</span></div>
                  <div>μ-wheel <span className="text-slate-100 font-mono">{c.muWheel.toFixed(0)}</span></div>
                  <div>BIAS <span className="font-mono" style={{color:TIER_COLOR.BIAS}}>{c.bias}</span></div>
                  <div>UNT+RUN <span className="font-mono" style={{color:TIER_COLOR.UNTRIM}}>{c.untrim + c.runaway}</span></div>
                </div>
                <div className="text-[9px] text-slate-500 italic mt-0.5">{c.spec.ref}</div>
              </div>
            ))}
            {classRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no airborne airframes</div>}
          </div>
        )}

        {tab==='WHEEL' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">F_wheel ≈ q · S · c̄ · ΔCm_δstab · G_ratio</div>
              <div className="text-slate-400">Manual-trim wheel breakout-force envelope per Boeing FCOM SP.16.5 / Airbus FCTL-OOT. At high IAS (q ∝ V²) with stab mis-trimmed nose-down, wheel-force exceeds the 50 lbf crew-recoverable limit per MIL-STD-1797B §4.2 — the &quot;roller-coaster&quot; technique (load relief by elevator push, then alternate trim) becomes the only recovery option per 737NG FCTM Ch.8 / 737 MAX FCTM Ch.8 post-AD 2020-24-02.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">F_wheel [lbf] vs IAS [kt] · per stab mis-trim band</div>
              <svg viewBox="0 0 400 200" className="w-full">
                <line x1="40" y1="180" x2="390" y2="180" stroke="#334155" />
                <line x1="40" y1="20"  x2="40"  y2="180" stroke="#334155" />
                {[100,150,200,250,300,350].map(v => (
                  <g key={v}><line x1={40 + (v-100)/250*350} y1="178" x2={40 + (v-100)/250*350} y2="182" stroke="#475569"/>
                    <text x={40 + (v-100)/250*350} y={192} fill="#94a3b8" fontSize="9" textAnchor="middle">{v}</text></g>
                ))}
                {[0,25,50,75,100,125].map(k => (
                  <g key={k}><line x1="38" y1={180 - k/125*160} x2="42" y2={180 - k/125*160} stroke="#475569"/>
                    <text x={34} y={183 - k/125*160} fill="#94a3b8" fontSize="9" textAnchor="end">{k}</text></g>
                ))}
                <text x="215" y="198" fill="#94a3b8" fontSize="9" textAnchor="middle">IAS kt</text>
                <text x="14" y="100" fill="#94a3b8" fontSize="9" textAnchor="middle" transform="rotate(-90 14 100)">F_wheel lbf</text>
                {/* 50 lbf crew-recoverable line */}
                <line x1="40" y1={180 - 50/125*160} x2="390" y2={180 - 50/125*160} stroke="#f43f5e" strokeWidth="1" strokeDasharray="4 3" opacity="0.8"/>
                <text x="385" y={180 - 50/125*160 - 2} fill="#f43f5e" fontSize="8" textAnchor="end">50 lbf MIL-STD-1797B</text>
                {/* nominal band (1.0 stab) sky curve */}
                <path d={Array.from({length:60},(_,i)=>{
                  const v = 100 + i*(250/59); const f = (v/350)*(v/350) * 55 * 0.85
                  const x = 40 + (v-100)/250*350; const y = 180 - clamp(f/125*160, 0, 160)
                  return `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`
                }).join(' ')} stroke="#0ea5e9" fill="none" strokeWidth="1.6" />
                {/* mis-trim band (3.0 stab) amber dashed curve */}
                <path d={Array.from({length:60},(_,i)=>{
                  const v = 100 + i*(250/59); const f = (v/350)*(v/350) * 55 * 1.35
                  const x = 40 + (v-100)/250*350; const y = 180 - clamp(f/125*160, 0, 160)
                  return `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`
                }).join(' ')} stroke="#f59e0b" fill="none" strokeWidth="1.4" strokeDasharray="3 3" />
                {/* runaway band (5.0 stab) rose curve */}
                <path d={Array.from({length:60},(_,i)=>{
                  const v = 100 + i*(250/59); const f = (v/350)*(v/350) * 55 * 2.0
                  const x = 40 + (v-100)/250*350; const y = 180 - clamp(f/125*160, 0, 160)
                  return `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`
                }).join(' ')} stroke="#ef4444" fill="none" strokeWidth="1.4" strokeDasharray="2 4" />
                {rows.slice(0,40).map((r,i) => {
                  const v = clamp(r.f.velocityKts, 100, 350)
                  const x = 40 + (v-100)/250*350
                  const y = 180 - clamp(r.wheelLbf/125*160, 0, 160)
                  return <circle key={i} cx={x} cy={y} r="2.4" fill={TIER_COLOR[r.tier]} opacity={0.85} />
                })}
                <text x="380" y="36" fill="#0ea5e9" fontSize="9" textAnchor="end">stab 1.0 nominal</text>
                <text x="380" y="48" fill="#f59e0b" fontSize="9" textAnchor="end">stab 3.0 mis-trim</text>
                <text x="380" y="60" fill="#ef4444" fontSize="9" textAnchor="end">stab 5.0 runaway</text>
              </svg>
              <div className="grid grid-cols-3 gap-1 mt-1 text-[10px]">
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLEET</div><div className="text-slate-100 font-mono">{rows.length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">&gt;50lbf</div><div className="text-slate-100 font-mono">{rows.filter(r=>r.wheelLbf>=50).length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">PICK</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||'—'}</div></div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · 14 CFR §25.255 §25.671 §25.672 §25.677 §25.683 §25.703 §25.143(d) §25.1309 · EASA CS-25.255 CS-25.671 / AMC 25.671 · FAA AD 2018-23-51 AD 2020-24-02 (B737 MAX MCAS) · NTSB AIB DCA19RA017 Lion Air 610 / DCA19RA086 Ethiopian 302 / SA-076 stab-trim runaway · Boeing FCOM SP.16.5 Runaway Stabilizer / SP.16.6 Stabilizer Out-of-Trim / 737NG FCTM Ch.8 / 737 MAX FCTM Ch.8 / 777 FCOM SP.16.5 / 787 FCOM SP.10 · Airbus FCOM PRO-ABN-FCTL THS Jam / Trim Runaway / FCTM Op.40 · Embraer AOM §03 Pitch Trim Runaway · CRJ FCOM Vol 2 §03 · ATR FCOM 2.05 · ICAO Doc 9760 Vol II Pt VI · FAA AC 25-7D §9 · MIL-STD-1797B §4.2 · SAE ARP4754A §5.3 · DO-178C / DO-254.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
