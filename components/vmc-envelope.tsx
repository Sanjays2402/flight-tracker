'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   VMC · Vmcg / Vmca / Vmcl Asymmetric-Thrust Minimum
         Control Speed Envelope & Rudder-Authority Margin Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of the ASYMMETRIC-THRUST minimum
   control speed envelope and current IAS margin against:
     · Vmcg  ground minimum control speed   (one-engine-inop on roll)
     · Vmca  air minimum control speed      (OEI airborne, 5° bank to live engine)
     · Vmcl  landing minimum control speed  (OEI go-around config)
   per:
     · 14 CFR §25.149 (a)-(h)   FAR-25 Vmc definitions
     · 14 CFR §25.107           V1/Vr/V2 / Vef relationship to Vmcg
     · EASA CS-25.149 / AMC 25.149   mirror text
     · FAA AC 25-7D §5          Flight Test Guide — minimum control
     · AC 61-107B Ch.3          high-altitude OEI controllability
     · FAA-H-8083-3C Ch.13      multiengine OEI flight characteristics
     · ICAO Doc 9760 Vol II Pt IV §4 continuing airworthiness
     · Boeing FCOM Vol 2 §03 Engine-Out Controllability
     · Airbus FCOM PRO-ABN-ENG Engine Failure
     · Embraer AOM §03 OEI Limit Speeds
     · Roskam Airplane Design Vol VII §6.3 Vmc derivation
     · Etkin & Reid Dynamics of Flight 3e §7 lateral-directional
     · Anderson AFD 6e §6.5 single-engine performance
     · McCormick Aerodynamics Aeronautics Flight Mechanics 2e §11
     · NTSB AAR-90-04 USAir 5050 LGA B737 takeoff
     · NTSB AAR-94-04 USAir 1016 CLT DC-9 OEI G/A
     · NTSB AAR-09-03 Empire 8284 SDF Shorts SD3 Vmc roll
     · BEA AF447 lateral-directional control
     · IATA Loss-of-Control In-Flight (LOC-I) 2024 §4

   Physics — Vmca first-principles (Roskam Vol VII Eq.6.3):

       Vmca = √( 2 · N_T · Y_T / (ρ · S · Cy_max · δr_max · ℓ_v) )

     where:
       N_T   = asymmetric thrust yawing moment   [N·m]
             = T_eng · y_eng       (engine moment arm to centerline)
       Y_T   = side-force lever arm to vertical-fin AC  [m]
       ρ     = ISA density at altitude/temp  [kg/m³]
       S     = wing reference area  [m²]
       Cy_max= max side-force coefficient at full rudder deflection
       δr_max= max rudder deflection  [rad]   (typ. 25-30°)
       ℓ_v   = vertical-tail moment arm  [m]

   Density correction: Vmca increases ~1/√σ with altitude,
   bounded above by Vs1g · 1.13 per §25.149(c).
   Ground Vmcg (no banking, no roll allowed) is typically
   Vmca − 5..10 kt due to nose-gear sideforce / no-bank rules
   per §25.149(e).

   Distinct from:
     · STALL      1g stall margin Vs1g (longitudinal alpha)
     · COFFIN     Mach-Vs1g cruise envelope
     · VMO-MMO    structural max-op envelope (high speed)
     · VAPP       Vref/Vapp stable-approach gross speed
     · CG-TRIM    longitudinal CG envelope
     · TEM        total energy state (h + V²/2g)
     · EDR        rapid-descent emergency profile
   VMC is uniquely the LATERAL-DIRECTIONAL controllability floor
   where rudder authority exhausts against asymmetric-thrust yaw —
   below Vmc roll-into-dead-engine departure is imminent regardless
   of pilot input. The historical "Vmc roll" loss-of-control mode.

   9-class envelope catalogue (per-class typical Vmcg/Vmca/Vmcl):
     WB-HVY (B777/B787/A350/A380 4-eng) 119/124/118 kt   y_eng 9.7m
     WB-T2  (B767/A330)              110/115/108 kt   y_eng 7.6m
     NB     (B737/A320 wing-mount)    98/103/96 kt    y_eng 5.8m
     RGN-J  (E190/CRJ9)               92/97/91  kt    y_eng 5.0m
     RGN-T  (AT72/Q400 turboprop)     78/82/76  kt    y_eng 4.4m
     BIZ    (G650/GLEX fuselage-mt)  104/108/102 kt   y_eng 3.2m
     MIL    (C17/C5)                 105/110/103 kt   y_eng 9.0m
     LIGHT  (BE9/PA34/twin pistons)   65/70/65  kt    y_eng 2.2m
     OTHER                            95/100/93 kt    y_eng 5.0m

   8 drivers (each 0-100):
     · MARG    (IAS − Vmc_active) / 20 kt buffer ramp
     · ALT     density-altitude Vmc inflation 1/√σ
     · CG      aft-CG rudder authority degradation
     · BANK    bank-angle vs 5° wings-level reference §25.149(b)
     · RHO     hot-day / hi-DA density penalty
     · CONFIG  flaps/gear-down lowers Vmcl below Vmca
     · OEI     simulated engine-out exposure flag
     · PHASE   roll / liftoff / climb / g-around weighting

   Composite max·0.62 + mean·0.38 × phase-weight × ADV-MUL.

   Hard escalators:
     · IAS < Vmc_active in TKO-LIFT/CLIMB-1ST/GA       score-min 95  loss-of-control imminent
     · IAS < Vmc_active + 5 kt                         score-min 78  Vmc roll watch
     · DA > 8000 ft + WB class                         score-min 60  hot-and-high penalty
     · Bank > 5° away from live-engine + OEI           score-min 88  rudder authority exhausted

   6 tiers:
     · DEPART  ≥85  rose       below Vmc — imminent LOC-I
     · CRIT    ≥65  rose-pink  within 5 kt of Vmc
     · WATCH   ≥45  amber      within 10 kt buffer
     · GUARD   ≥22  sky        20-kt envelope margin
     · CLEAR   <22  emerald    well clear of Vmc
     · OFF     slate           cruise / not in OEI-relevant phase
============================================================ */

interface VFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: VFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'DEPART'|'CRIT'|'WATCH'|'GUARD'|'CLEAR'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  DEPART:'#ef4444', CRIT:'#f43f5e', WATCH:'#f59e0b',
  GUARD:'#0ea5e9', CLEAR:'#10b981', OFF:'#475569',
}
const TIER_RANK: Record<Tier,number> = { DEPART:0, CRIT:1, WATCH:2, GUARD:3, CLEAR:4, OFF:5 }
const TIER_ORDER: Tier[] = ['DEPART','CRIT','WATCH','GUARD','CLEAR']

type Phase = 'TKO-ROLL'|'TKO-LIFT'|'CLIMB-1ST'|'CRUISE-OEI'|'APPR'|'GA'|'OFF'

interface AcSpec {
  cls: string
  vmcg: number; vmca: number; vmcl: number   // kt CAS at SL/ISA
  yEng: number                                  // engine y-arm m
  vs1g: number                                  // landing config stall kt
  ref: string
}
function specOf(type?: string): AcSpec {
  const t = (type||'').toUpperCase()
  if (/^(A38|B74|B77|A35|B78|MD11|IL96|B79)/.test(t))
    return { cls:'WB-HVY', vmcg:119, vmca:124, vmcl:118, yEng:9.7, vs1g:135, ref:'B777 FCOM 2.03 / A350 FCOM PRO-ABN-ENG' }
  if (/^(B76|A33|A30|A31|B75|IL76)/.test(t))
    return { cls:'WB-T2',  vmcg:110, vmca:115, vmcl:108, yEng:7.6, vs1g:128, ref:'B767 FCOM 2.03 / A330 FCOM PRO-ABN-ENG' }
  if (/^(A32|A20|A21|A31|B73|B38|B39|B72|MD8|MD9|DC9)/.test(t))
    return { cls:'NB',     vmcg:98,  vmca:103, vmcl:96,  yEng:5.8, vs1g:118, ref:'B737 FCOM 2.03 §3 / A320 FCOM PRO-ABN-ENG' }
  if (/^(E17|E19|E29|CRJ|MRJ|SU9|AR8|F10|F70)/.test(t))
    return { cls:'RGN-J',  vmcg:92,  vmca:97,  vmcl:91,  yEng:5.0, vs1g:108, ref:'EMB AOM §03 / CRJ AFM §5' }
  if (/^(AT[47]|DH[8C]|Q40|SF3|J32|S20|D38)/.test(t))
    return { cls:'RGN-T',  vmcg:78,  vmca:82,  vmcl:76,  yEng:4.4, vs1g:92,  ref:'ATR FCOM 2.04 / Q400 AFM §5' }
  if (/^(GLE|G6|G5|G4|GLF|FA[78]|CL6|CL3|BD7|HD\d|H25)/.test(t))
    return { cls:'BIZ',    vmcg:104, vmca:108, vmcl:102, yEng:3.2, vs1g:108, ref:'GLEX AFM §5 / G650 AFM §5' }
  if (/^(C17|C5|KC1|C13|AN1|IL7|C30|A40)/.test(t))
    return { cls:'MIL',    vmcg:105, vmca:110, vmcl:103, yEng:9.0, vs1g:115, ref:'C-17 SMM §5 / MIL-STD-3013A' }
  if (/^(BE[59]|PA3|PA4|BE2|BE6|BE7|C40|C42|DA4|DV2|G15|G69)/.test(t))
    return { cls:'LIGHT',  vmcg:65,  vmca:70,  vmcl:65,  yEng:2.2, vs1g:70,  ref:'POH §5 / 14 CFR §23.149' }
  return { cls:'OTHER',    vmcg:95,  vmca:100, vmcl:93,  yEng:5.0, vs1g:108, ref:'CS-25.149 default' }
}

interface Row {
  f: VFlight; phase: Phase; cls: string; spec: AcSpec
  da: number          // density altitude ft
  sigma: number       // density ratio
  vmcActive: number   // active Vmc for this phase (kt)
  vmcLabel: 'Vmcg'|'Vmca'|'Vmcl'
  marginKt: number
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
  oei: boolean
  cgPct: number       // 0 fwd .. 1 aft
  bankDeg: number
}

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }

// ISA density ratio σ vs pressure altitude ft
function sigma(altFt: number): number {
  // troposphere only; clamp top
  const h = clamp(altFt, 0, 50000)
  const T0 = 288.15; const lapse = 0.0019812 // K/ft
  const T = T0 - lapse * h
  return Math.pow(T/T0, 4.256)
}

function phaseOf(f: VFlight): Phase {
  if (f.ground) {
    if (f.velocityKts > 70) return 'TKO-ROLL'
    return 'OFF'
  }
  if (f.altitudeFt < 500 && f.vertRate > 200) return 'TKO-LIFT'
  if (f.altitudeFt < 2500 && f.vertRate > 300) return 'CLIMB-1ST'
  if (f.altitudeFt < 3000 && f.vertRate > 100 && f.velocityKts < 180) return 'GA'
  if (f.altitudeFt > 18000) return 'CRUISE-OEI'   // only relevant if OEI flagged
  if (f.altitudeFt < 5000 && f.vertRate < 0) return 'APPR'
  return 'OFF'
}

// deterministic synthetic OEI exposure + CG + bank
function syntheticState(icao: string) {
  let h = 0; for (let i=0;i<icao.length;i++) h = ((h*131) + icao.charCodeAt(i)) >>> 0
  const r = (h % 1000) / 1000
  // ~3% of fleet flagged OEI for envelope demo
  const oei = r < 0.03
  const cgPct = ((h>>3) % 100) / 100    // 0..1
  const bankRaw = ((h>>5) % 120) / 10   // 0..12 deg
  const bankDeg = oei ? Math.max(2, bankRaw) : Math.min(3, bankRaw)
  return { oei, cgPct, bankDeg }
}

export default function VmcEnvelope({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [oeiRate, setOeiRate] = useState(1.0)   // OEI exposure multiplier
  const [cgMul, setCgMul]   = useState(1.0)
  const [hotDay, setHotDay] = useState(15)      // OAT delta-ISA °C
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'ENVELOPE'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shVec, setShVec] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const ph = phaseOf(f)
      if (ph === 'OFF') continue
      const sp = specOf(f.type)
      const st = syntheticState(f.icao)
      const oei = st.oei && Math.random() < 1   // already deterministic
      const _oei = st.oei && (oeiRate > 0.5 || ph !== 'CRUISE-OEI')

      // density altitude: pressure-alt + ~120 ft per °C above ISA
      const da = f.altitudeFt + hotDay * 120
      const sig = sigma(da)
      const sigInv = 1 / Math.sqrt(Math.max(0.4, sig))

      // active Vmc by phase
      let vmcBase = sp.vmca; let lbl: 'Vmcg'|'Vmca'|'Vmcl' = 'Vmca'
      if (ph === 'TKO-ROLL') { vmcBase = sp.vmcg; lbl = 'Vmcg' }
      else if (ph === 'GA' || ph === 'APPR') { vmcBase = sp.vmcl; lbl = 'Vmcl' }

      // altitude correction (in air only) — Vmcg is a ground constant
      const altK = (ph === 'TKO-ROLL') ? 1.0 : sigInv
      // CG aft = rudder-arm reduced ~+2 kt per 10% aft
      const cgK = 1 + (st.cgPct - 0.5) * 0.04 * cgMul
      // cap at 1.13·Vs1g per §25.149(c)
      let vmcActive = clamp(vmcBase * altK * cgK, sp.vmcg * 0.9, sp.vs1g * 1.13)

      const ias = Math.max(0, f.velocityKts)
      const marginKt = ias - vmcActive

      // DRIVERS
      // MARG: 0 when margin>20kt, 100 when margin<=0
      const dMARG = clamp((1 - marginKt/20) * 100, 0, 100)
      // ALT inflation contribution (only airborne)
      const dALT  = ph === 'TKO-ROLL' ? 0 : clamp((sigInv - 1) * 200, 0, 100)
      // CG aft
      const dCG   = clamp((st.cgPct - 0.4) * 200, 0, 100)
      // BANK away from live-engine (>5° per §25.149(b))
      const dBANK = clamp((st.bankDeg - 5) * 18, 0, 100)
      // RHO hot-day
      const dRHO  = clamp((hotDay - 15) * 5, 0, 100)
      // CONFIG: Vmcl typically below Vmca → at GA we score CONFIG higher
      const dCONFIG = (ph === 'GA' || ph === 'APPR') ? 55 : 18
      const dOEI = _oei ? 90 : 18
      const phaseW: Record<Phase, number> = {
        'TKO-ROLL':1.05, 'TKO-LIFT':1.20, 'CLIMB-1ST':1.10,
        'CRUISE-OEI':0.70, 'APPR':0.85, 'GA':1.15, 'OFF':0
      }
      const dPHASE = phaseW[ph] * 50

      const drivers = { MARG:dMARG, ALT:dALT, CG:dCG, BANK:dBANK, RHO:dRHO, CONFIG:dCONFIG, OEI:dOEI, PHASE:dPHASE }
      const arr = Object.values(drivers)
      const mx = Math.max(...arr), mn = arr.reduce((a,b)=>a+b,0)/arr.length
      let score = (mx * 0.62 + mn * 0.38) * phaseW[ph] * advMul

      const notes: string[] = []
      if (marginKt < 0 && (ph === 'TKO-LIFT' || ph === 'CLIMB-1ST' || ph === 'GA')) {
        score = Math.max(score, 95)
        notes.push(`IAS ${ias.toFixed(0)} kt < ${lbl} ${vmcActive.toFixed(0)} — Vmc roll imminent · §25.149(b) / FCOM ENG-OUT`)
      } else if (marginKt < 5) {
        score = Math.max(score, 78); notes.push(`Margin ${marginKt.toFixed(0)} kt < 5 — Vmc-watch · AC 25-7D §5`)
      }
      if (da > 8000 && (sp.cls === 'WB-HVY' || sp.cls === 'WB-T2')) {
        score = Math.max(score, 60); notes.push(`DA ${da.toFixed(0)} ft hot/high — Vmc inflated ${((sigInv-1)*100).toFixed(0)}%`)
      }
      if (st.bankDeg > 5 && _oei) {
        score = Math.max(score, 88); notes.push(`Bank ${st.bankDeg.toFixed(1)}° away from live — §25.149(b) 5° max into-live only`)
      }
      score = clamp(score, 0, 100)

      let tier: Tier = 'OFF'
      if (score >= 85) tier = 'DEPART'
      else if (score >= 65) tier = 'CRIT'
      else if (score >= 45) tier = 'WATCH'
      else if (score >= 22) tier = 'GUARD'
      else tier = 'CLEAR'

      out.push({ f, phase: ph, cls: sp.cls, spec: sp, da, sigma: sig, vmcActive, vmcLabel: lbl, marginKt, drivers, score, tier, notes, oei: _oei, cgPct: st.cgPct, bankDeg: st.bankDeg })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, oeiRate, cgMul, hotDay])

  // === MapLibre overlay ===
  useEffect(() => {
    if (!map) return
    const SRC = 'vmc-src'
    const SRC_VEC = 'vmc-vec-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    const writeAll = () => {
      ensureSrc(SRC); ensureSrc(SRC_VEC)
      const view = rows.filter(r => (tierFilter==='ALL'||r.tier===tierFilter) && (phaseFilter==='ALL'||r.phase===phaseFilter))
      const acFeats: any[] = []
      const vecFeats: any[] = []
      for (const r of view) {
        acFeats.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
          properties:{
            tier:r.tier, color:TIER_COLOR[r.tier], score:r.score,
            sz: 7 + (r.score/100)*12,
            label: `${r.f.callsign||r.f.icao} · ${r.cls} · ${r.vmcLabel} ${r.vmcActive.toFixed(0)} · Δ${r.marginKt>=0?'+':''}${r.marginKt.toFixed(0)}kt`
          }
        })
        // forward yaw-departure vector: length proportional to deficit (kt below Vmc)
        const deficit = Math.max(0, -r.marginKt)
        const km = clamp(deficit * 0.4, 0.5, 8)
        const brg = ((r.f.track||0) + (r.oei ? 25 : 0)) * Math.PI/180   // OEI drifts toward dead engine
        const dlat = (km/111.32) * Math.cos(brg)
        const dlng = (km/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(brg)
        vecFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat],[r.f.lng+dlng, r.f.lat+dlat]] }, properties:{ color: TIER_COLOR[r.tier] } })
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_VEC) as any).setData({ type:'FeatureCollection', features: shVec ? vecFeats : [] })
    }
    ensureSrc(SRC); ensureSrc(SRC_VEC)
    if (!map.getLayer('vmc-halo'))
      map.addLayer({ id:'vmc-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('vmc-pin'))
      map.addLayer({ id:'vmc-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('vmc-lbl'))
      map.addLayer({ id:'vmc-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('vmc-vec'))
      map.addLayer({ id:'vmc-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-dasharray':[2,2], 'line-opacity':0.75 } })
    writeAll()
    return () => {
      for (const id of ['vmc-lbl','vmc-pin','vmc-halo','vmc-vec']) if (map.getLayer(id)) map.removeLayer(id)
      for (const id of [SRC, SRC_VEC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, phaseFilter, shHalo, shPin, shLbl, shVec])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.f.operator||'').toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { DEPART:0, CRIT:0, WATCH:0, GUARD:0, CLEAR:0, OFF:0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const muMarg = rows.length ? (rows.reduce((a,b)=>a+b.marginKt,0)/rows.length) : 0
  const worst = rows[0]
  const oeiCnt = rows.filter(r => r.oei).length

  // per-class aggregation
  const classMap = new Map<string, { spec: AcSpec; count: number; muMarg: number; dep: number; crit: number; wat: number }>()
  for (const r of rows) {
    const e = classMap.get(r.cls) || { spec: r.spec, count: 0, muMarg: 0, dep: 0, crit: 0, wat: 0 }
    e.count++; e.muMarg += r.marginKt
    if (r.tier === 'DEPART') e.dep++
    if (r.tier === 'CRIT') e.crit++
    if (r.tier === 'WATCH') e.wat++
    classMap.set(r.cls, e)
  }
  const classRows = Array.from(classMap.entries()).map(([cls, e]) => ({ cls, spec: e.spec, count: e.count, muMarg: e.muMarg/e.count, dep: e.dep, crit: e.crit, wat: e.wat }))
    .sort((a,b) => (b.dep + b.crit) - (a.dep + a.crit) || a.muMarg - b.muMarg)

  // ENVELOPE plot: Vmca vs density-altitude curve per picked spec
  const pickedSpec = worst ? worst.spec : specOf('A320')

  return (
    <div className="fixed top-16 right-3 z-40 w-[460px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">VMC</span>
          <span className="text-[10px] text-slate-400">Vmcg/Vmca/Vmcl asymmetric-thrust envelope · §25.149</span>
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
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-MARG</div><div className="text-slate-100 font-mono">{muMarg>=0?'+':''}{muMarg.toFixed(0)}kt</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">OEI</div><div className="font-mono" style={{color:TIER_COLOR.CRIT}}>{oeiCnt}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||worst?.f.icao||'—'}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">DEP+</div><div className="font-mono" style={{color:TIER_COLOR.DEPART}}>{counts.DEPART + counts.CRIT}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">OEI-EXP <span className="text-slate-200 font-mono">{(oeiRate*100).toFixed(0)}%</span>
            <input type="range" min="0" max="200" value={oeiRate*100} onChange={e=>setOeiRate(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">CG-AFT <span className="text-slate-200 font-mono">{(cgMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={cgMul*100} onChange={e=>setCgMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">ΔISA <span className="text-slate-200 font-mono">{hotDay>=0?'+':''}{hotDay}°C</span>
            <input type="range" min="-20" max="45" value={hotDay} onChange={e=>setHotDay(+e.target.value)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','TKO-ROLL','TKO-LIFT','CLIMB-1ST','APPR','GA','CRUISE-OEI'] as const).map(p => (
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
        {(['AIRCRAFT','CLASSES','ENVELOPE'] as const).map(t => (
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
              {r.oei && <span className="px-1 rounded font-mono text-[9px]" style={{ background:'#ef444433', color:'#ef4444' }}>OEI</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>IAS <span className="text-slate-100 font-mono">{r.f.velocityKts.toFixed(0)}kt</span></div>
              <div>{r.vmcLabel} <span className="text-slate-100 font-mono">{r.vmcActive.toFixed(0)}kt</span></div>
              <div>Δ <span className="font-mono" style={{color: r.marginKt<0?TIER_COLOR.DEPART : r.marginKt<5?TIER_COLOR.CRIT : TIER_COLOR.CLEAR}}>{r.marginKt>=0?'+':''}{r.marginKt.toFixed(0)}kt</span></div>
              <div>DA <span className="text-slate-100 font-mono">{(r.da/1000).toFixed(1)}k</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>Vmcg <span className="text-slate-100 font-mono">{r.spec.vmcg}</span></div>
              <div>Vmca <span className="text-slate-100 font-mono">{r.spec.vmca}</span></div>
              <div>Vmcl <span className="text-slate-100 font-mono">{r.spec.vmcl}</span></div>
              <div>y-eng <span className="text-slate-100 font-mono">{r.spec.yEng.toFixed(1)}m</span></div>
            </div>
            <div className="grid grid-cols-3 gap-1 text-[10px] text-slate-400">
              <div>σ <span className="text-slate-100 font-mono">{r.sigma.toFixed(3)}</span></div>
              <div>CG <span className="text-slate-100 font-mono">{(r.cgPct*100).toFixed(0)}%aft</span></div>
              <div>BANK <span className="text-slate-100 font-mono">{r.bankDeg.toFixed(1)}°</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='CLEAR' && <div className="mt-1 text-[9px] text-slate-500">monitor IAS &gt; {r.vmcLabel}+10 · max 5° bank into live engine · {r.spec.ref}</div>}
          </div>
        ))}

        {tab==='CLASSES' && (
          <div className="space-y-1">
            {classRows.map(c => (
              <div key={c.cls} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{c.cls}</span>
                  <span className="text-slate-400">Vmca {c.spec.vmca}kt · y-eng {c.spec.yEng.toFixed(1)}m</span>
                  <span className="ml-auto font-mono text-slate-100">{c.count}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>Vmcg <span className="text-slate-100 font-mono">{c.spec.vmcg}</span></div>
                  <div>Vmca <span className="text-slate-100 font-mono">{c.spec.vmca}</span></div>
                  <div>Vmcl <span className="text-slate-100 font-mono">{c.spec.vmcl}</span></div>
                  <div>Vs1g <span className="text-slate-100 font-mono">{c.spec.vs1g}</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>μ-Δ <span className="font-mono" style={{color: c.muMarg<5 ? TIER_COLOR.CRIT : TIER_COLOR.CLEAR}}>{c.muMarg>=0?'+':''}{c.muMarg.toFixed(0)}</span></div>
                  <div>DEP <span className="font-mono" style={{color:TIER_COLOR.DEPART}}>{c.dep}</span></div>
                  <div>CRIT <span className="font-mono" style={{color:TIER_COLOR.CRIT}}>{c.crit}</span></div>
                  <div>WAT <span className="font-mono" style={{color:TIER_COLOR.WATCH}}>{c.wat}</span></div>
                </div>
                <div className="text-[9px] text-slate-500 italic mt-0.5">{c.spec.ref}</div>
              </div>
            ))}
            {classRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no airframes in OEI-relevant phase</div>}
          </div>
        )}

        {tab==='ENVELOPE' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">Vmca(h) ≈ Vmca₀ / √σ(h) , bounded by 1.13·Vs1g</div>
              <div className="text-slate-400">First-principles from Roskam Vol VII §6.3: Vmca₀ = √(2·N_T·Y_T / (ρ₀·S·Cy_max·δr_max·ℓ_v)). Asymmetric yawing moment N_T = T·y_eng must be balanced by rudder side-force at full δr; as ρ falls with altitude required IAS grows as 1/√σ. 14 CFR §25.149(c) caps certified Vmca at 1.13·Vs1g to avoid stall-coupling. Vmcg (§25.149(e)) is a ground constant: no roll, no bank, nose-gear sideforce included. Vmcl (§25.149(f)/(g)) is landing-config OEI with go-around thrust.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">Vmca [kt] vs DA [kft] · picked class {pickedSpec.cls}</div>
              <svg viewBox="0 0 400 200" className="w-full">
                <line x1="40" y1="180" x2="390" y2="180" stroke="#334155" />
                <line x1="40" y1="20" x2="40" y2="180" stroke="#334155" />
                {[0,5,10,15,20,25,30].map(p => (
                  <g key={p}><line x1={40 + p/30*350} y1="178" x2={40 + p/30*350} y2="182" stroke="#475569"/>
                    <text x={40 + p/30*350} y={192} fill="#94a3b8" fontSize="9" textAnchor="middle">{p}</text></g>
                ))}
                {[60,80,100,120,140,160].map(v => (
                  <g key={v}><line x1="38" y1={180 - (v-60)/100*160} x2="42" y2={180 - (v-60)/100*160} stroke="#475569"/>
                    <text x={34} y={183 - (v-60)/100*160} fill="#94a3b8" fontSize="9" textAnchor="end">{v}</text></g>
                ))}
                <text x="215" y="198" fill="#94a3b8" fontSize="9" textAnchor="middle">Density Altitude kft</text>
                <text x="14" y="100" fill="#94a3b8" fontSize="9" textAnchor="middle" transform="rotate(-90 14 100)">Vmc kt CAS</text>

                {/* Vs1g·1.13 cap line */}
                <line x1="40" y1={180-(pickedSpec.vs1g*1.13-60)/100*160} x2="390" y2={180-(pickedSpec.vs1g*1.13-60)/100*160} stroke="#ef4444" strokeWidth="1" strokeDasharray="4 3" opacity="0.7"/>
                <text x="385" y={180-(pickedSpec.vs1g*1.13-60)/100*160 - 2} fill="#ef4444" fontSize="8" textAnchor="end">1.13·Vs1g cap §25.149(c)</text>

                {/* Vmca curve 1/√σ */}
                <path d={Array.from({length:60},(_,i)=>{
                  const da = i*(30/59); const sig = sigma(da*1000)
                  const v = Math.min(pickedSpec.vs1g*1.13, pickedSpec.vmca / Math.sqrt(sig))
                  const x = 40 + da/30*350; const y = 180 - clamp((v-60)/100*160, 0, 160)
                  return `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`
                }).join(' ')} stroke="#0ea5e9" fill="none" strokeWidth="1.8" />
                <text x="380" y="34" fill="#0ea5e9" fontSize="9" textAnchor="end">Vmca(h) {pickedSpec.cls}</text>

                {/* Vmcg constant */}
                <line x1="40" y1={180-(pickedSpec.vmcg-60)/100*160} x2="390" y2={180-(pickedSpec.vmcg-60)/100*160} stroke="#10b981" strokeWidth="1.2" strokeDasharray="2 2" opacity="0.8"/>
                <text x="380" y={180-(pickedSpec.vmcg-60)/100*160 - 2} fill="#10b981" fontSize="8" textAnchor="end">Vmcg ground const</text>

                {/* Vmcl line */}
                <line x1="40" y1={180-(pickedSpec.vmcl-60)/100*160} x2="390" y2={180-(pickedSpec.vmcl-60)/100*160} stroke="#f59e0b" strokeWidth="1" strokeDasharray="3 4" opacity="0.7"/>
                <text x="380" y={180-(pickedSpec.vmcl-60)/100*160 - 2} fill="#f59e0b" fontSize="8" textAnchor="end">Vmcl ldg config</text>

                {/* fleet dots: (DA, IAS) tier-coloured */}
                {rows.slice(0,40).map((r,i) => {
                  const x = 40 + clamp(r.da/1000/30*350, 0, 350)
                  const y = 180 - clamp((r.f.velocityKts-60)/100*160, 0, 160)
                  return <circle key={i} cx={x} cy={y} r="2.4" fill={TIER_COLOR[r.tier]} opacity={0.85} />
                })}
              </svg>
              <div className="grid grid-cols-3 gap-1 mt-1 text-[10px]">
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLEET</div><div className="text-slate-100 font-mono">{rows.length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-Δ</div><div className="text-slate-100 font-mono">{muMarg>=0?'+':''}{muMarg.toFixed(0)}kt</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">PICK</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||'—'}</div></div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · 14 CFR §25.149 §25.107 §25.121 §25.143 / EASA CS-25.149 / AMC 25.149 · FAA AC 25-7D §5 · AC 61-107B Ch.3 · FAA-H-8083-3C Ch.13 · ICAO Doc 9760 Vol II Pt IV §4 · Boeing FCOM Vol 2 §03 Engine-Out Controllability · Airbus FCOM PRO-ABN-ENG · Embraer AOM §03 OEI Limit Speeds · Roskam Airplane Design Vol VII §6.3 · Etkin & Reid Dynamics of Flight 3e §7 · Anderson AFD 6e §6.5 · McCormick AAFM 2e §11 · NTSB AAR-90-04 USAir 5050 LGA · AAR-94-04 USAir 1016 CLT · AAR-09-03 Empire 8284 SDF · BEA AF447 · IATA LOC-I 2024 §4 · 14 CFR §23.149 Part 23 light-twin.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
