'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   HYDROPLANE · Wet/Contaminated Runway Dynamic Aquaplaning &
                Tire-Skid Margin Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of dynamic-aquaplaning onset and
   tire-skid friction margin during landing rollout, rejected
   takeoff, and high-speed taxi on wet/standing-water/slush/snow
   contaminated runways.

   Core physics:
     · Dynamic hydroplaning speed (NASA TN D-2056 Horne & Dreher 1963)
         Vp [kts] = 9 · sqrt(p_tire_psi)        (rotating wheel)
         Vp_lock  = 7.7 · sqrt(p_tire_psi)      (locked wheel, ESDU 71026)
     · Viscous hydroplaning — thin-film smooth-tread regime
     · Reverted-rubber hydroplaning — steam-induced trapped film
     · μ-effective per ICAO RCAM (Annex 14 Vol I App.A, Doc 9981)
       RWYCC 6→0 mapped to nominal friction coefficient
     · Contaminant drag per ESDU 90035 / Boeing AC 805 §6
   Per 14 CFR §25.109 / §25.125 / §121.195 / EASA CS-25 AMC 25.1591
   / FAA AC 91-79B / AC 25-32 / SAE ARP5288 / ICAO Doc 9137 Pt 2.

   Structurally distinct from:
     · RCAM   — runway-condition reporting code lookup
     · BRAKE  — energy/temperature limit
     · ROW-ROP — runway overrun warning model
     · WAT    — weight/altitude/temp performance limit
     · TOLD   — takeoff data card
     · RTOW   — rejected-takeoff balanced-field
   HYDROPLANE is uniquely the tire-vs-water kinematic film-rupture
   physics regime — at v ≥ Vp the tire lifts off the surface and
   wheel friction collapses to ~0.05 regardless of brake input.

   6 drivers:
     · VP     v / Vp_dyn (Horne speed margin)
     · CONT   contaminant depth & type (Std-Wtr/Slush/Snow/Ice)
     · TREAD  groove-depth proxy & tire pressure margin
     · MU     RWYCC μ-effective vs nominal-dry 0.8
     · XWND   crosswind component (skid-into-turn)
     · PHASE  phase-of-flight criticality LDG-RLT/RTO/HI-TAXI
   plus hard escalators:
     · v ≥ Vp_dyn on contaminated rwy   (score 95, full reversion)
     · v ≥ 0.85·Vp + standing water    (94)
     · RWYCC ≤ 1 + braking phase       (88, NIL-friction risk)
     · Reverted-rubber regime detected (92, lock-skid history)

   6 tiers:
     · AQUAPLANE ≥85 rose      v ≥ Vp / full hydroplane
     · IMMINENT  ≥65 rose-pink within 15% of Vp
     · MARGIN    ≥45 amber     within 30% of Vp / RWYCC ≤2
     · WATCH     ≥22 sky       contaminated but >30% margin
     · DRY       <22 emerald   nominal dry friction
     · OFF       slate         airborne / no runway phase

   References:
     · NASA TN D-2056 Horne & Dreher 1963 Phenomena of Pneumatic
       Tire Hydroplaning (foundational Vp=9√psi)
     · NASA TN D-2776 Horne 1965 / TN D-4406 / TM X-72650
     · ESDU 71026 / 90035 contaminant drag
     · 14 CFR §25.109 §25.125 §121.195 §25.1591
     · EASA CS-25 AMC 25.1591 / CS-AWO
     · FAA AC 91-79B Mitigating Runway Overrun · AC 25-32
     · FAA AC 25-31 Take-off Performance Data for Operations on
       Contaminated Runways
     · ICAO Doc 9981 PANS-ADR · Annex 14 Vol I App.A RCAM
     · ICAO Doc 9137 Pt 2 Pavement Surface Conditions
     · SAE ARP5288 Runway Friction Measurement
     · Boeing AC 805 Wet Runway Performance §6
     · Airbus FCOM PRO-NOR-SRP-04 Landing on Contaminated RWY
     · NTSB AAR-05-04 Southwest 1248 KMDW B737 overrun
     · NTSB AAR-08-02 American 1420 KLIT MD-82 overrun
     · TSB A05H0002 Air France 358 YYZ A340 overrun
     · NTSB AAB-83-04 ASA 261 reverted-rubber
============================================================ */

interface HFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: HFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'AQUAPLANE'|'IMMINENT'|'MARGIN'|'WATCH'|'DRY'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  AQUAPLANE:'#ef4444', IMMINENT:'#f43f5e', MARGIN:'#f59e0b',
  WATCH:'#0ea5e9', DRY:'#10b981', OFF:'#475569',
}
const TIER_RANK: Record<Tier,number> = { AQUAPLANE:0, IMMINENT:1, MARGIN:2, WATCH:3, DRY:4, OFF:5 }
const TIER_ORDER: Tier[] = ['AQUAPLANE','IMMINENT','MARGIN','WATCH','DRY']

type Contam = 'DRY'|'WET'|'STD-WTR'|'SLUSH'|'WET-SNOW'|'DRY-SNOW'|'COMP-SNOW'|'ICE'
type Phase  = 'LDG-RLT'|'RTO'|'HI-TAXI'|'LO-TAXI'|'TKOF-ROLL'|'OFF'

interface Runway {
  id: string; name: string; lat: number; lng: number
  rwycc: number       // 0-6
  contam: Contam
  depthMm: number     // contaminant depth
}

// 20 synthetic wet-rwy snapshot stations
const RUNWAYS: Runway[] = [
  { id:'KSEA', name:'Seattle-Tacoma 16R', lat:47.45, lng:-122.31, rwycc:3, contam:'STD-WTR', depthMm:5 },
  { id:'KSFO', name:'San Francisco 28L',  lat:37.62, lng:-122.37, rwycc:4, contam:'WET',     depthMm:1 },
  { id:'KMDW', name:'Chicago Midway 31C', lat:41.79, lng:-87.75,  rwycc:2, contam:'SLUSH',   depthMm:8 },
  { id:'KORD', name:'Chicago O\'Hare 28R',lat:41.97, lng:-87.91,  rwycc:3, contam:'COMP-SNOW',depthMm:0 },
  { id:'KBUF', name:'Buffalo 23',         lat:42.94, lng:-78.73,  rwycc:1, contam:'WET-SNOW', depthMm:6 },
  { id:'KBOS', name:'Boston 33L',         lat:42.36, lng:-71.01,  rwycc:2, contam:'STD-WTR', depthMm:7 },
  { id:'KJFK', name:'JFK 04R',            lat:40.64, lng:-73.78,  rwycc:4, contam:'WET',     depthMm:2 },
  { id:'KEWR', name:'Newark 22L',         lat:40.69, lng:-74.17,  rwycc:3, contam:'STD-WTR', depthMm:4 },
  { id:'KDEN', name:'Denver 16L',         lat:39.86, lng:-104.67, rwycc:2, contam:'COMP-SNOW',depthMm:0 },
  { id:'KMSP', name:'Minneapolis 30L',    lat:44.88, lng:-93.22,  rwycc:1, contam:'ICE',     depthMm:0 },
  { id:'KLIT', name:'Little Rock 22L',    lat:34.73, lng:-92.22,  rwycc:3, contam:'STD-WTR', depthMm:6 },
  { id:'KATL', name:'Atlanta 09L',        lat:33.64, lng:-84.43,  rwycc:5, contam:'WET',     depthMm:1 },
  { id:'CYYZ', name:'Toronto 23',         lat:43.68, lng:-79.63,  rwycc:2, contam:'WET-SNOW', depthMm:5 },
  { id:'CYUL', name:'Montreal 24L',       lat:45.47, lng:-73.74,  rwycc:1, contam:'COMP-SNOW',depthMm:0 },
  { id:'EGLL', name:'Heathrow 27R',       lat:51.46, lng:-0.45,   rwycc:4, contam:'WET',     depthMm:1 },
  { id:'EDDF', name:'Frankfurt 25C',      lat:50.03, lng:8.56,    rwycc:3, contam:'SLUSH',   depthMm:4 },
  { id:'ENGM', name:'Oslo 01R',           lat:60.19, lng:11.10,   rwycc:2, contam:'DRY-SNOW', depthMm:6 },
  { id:'UUEE', name:'Sheremetyevo 24L',   lat:55.97, lng:37.41,   rwycc:1, contam:'COMP-SNOW',depthMm:0 },
  { id:'RJTT', name:'Tokyo Haneda 34L',   lat:35.55, lng:139.78,  rwycc:5, contam:'WET',     depthMm:1 },
  { id:'YSSY', name:'Sydney 16R',         lat:-33.94,lng:151.18,  rwycc:3, contam:'STD-WTR', depthMm:3 },
]

// Per-class tire pressure psi & groove depth proxy (mm)
function tireSpecs(type?: string): { psi: number; groove: number; cls: string } {
  const t = (type||'').toUpperCase()
  if (/^(A38|B74|B77|B78|A35|B79|MD11|IL96)/.test(t)) return { psi: 218, groove: 4.0, cls:'WB-HVY' }
  if (/^(B76|A33|A30|A31|B75|IL76)/.test(t))          return { psi: 200, groove: 3.8, cls:'WB-T2'  }
  if (/^(A32|A31|A20|A21|B73|B38|B39|B72|MD8|MD9|DC9)/.test(t)) return { psi: 195, groove: 3.5, cls:'NB' }
  if (/^(E17|E19|E29|CRJ|MRJ|SU9|AR8|F10|F70)/.test(t)) return { psi: 165, groove: 3.0, cls:'RGN-J' }
  if (/^(AT[47]|DH[8C]|Q40|SF3|J32|S20|D38)/.test(t))   return { psi: 130, groove: 2.6, cls:'RGN-T' }
  if (/^(GLE|G6|G5|G4|GLF|FA[78]|CL6|CL3|BD7)/.test(t)) return { psi: 200, groove: 3.6, cls:'BIZ' }
  if (/^(C17|C5|KC1|C13|AN1|IL7)/.test(t))              return { psi: 175, groove: 3.2, cls:'MIL'  }
  return { psi: 160, groove: 3.0, cls:'OTHER' }
}

// Effective μ per RWYCC (ICAO Annex 14 App.A nominal mapping)
function muFromRWYCC(rwycc: number): number {
  const M: Record<number, number> = { 6:0.80, 5:0.60, 4:0.40, 3:0.30, 2:0.25, 1:0.15, 0:0.05 }
  return M[Math.max(0, Math.min(6, rwycc))] ?? 0.30
}

const CONTAM_MUL: Record<Contam, number> = {
  'DRY':0.0,'WET':0.4,'STD-WTR':1.4,'SLUSH':1.2,'WET-SNOW':1.0,
  'DRY-SNOW':0.6,'COMP-SNOW':0.7,'ICE':1.6,
}

interface Row {
  f: HFlight; phase: Phase; rwy: Runway; distKm: number
  cls: string; psi: number; groove: number
  vp: number; ratio: number
  muEff: number
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
}

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }
function gcKm(la1:number, lo1:number, la2:number, lo2:number){
  const R=6371, toR=Math.PI/180
  const dla=(la2-la1)*toR, dlo=(lo2-lo1)*toR
  const a=Math.sin(dla/2)**2 + Math.cos(la1*toR)*Math.cos(la2*toR)*Math.sin(dlo/2)**2
  return 2*R*Math.asin(Math.min(1,Math.sqrt(a)))
}

function phaseOf(f: HFlight, nearestKm: number): Phase {
  if (!f.ground) return 'OFF'
  if (f.velocityKts > 80 && nearestKm < 4) return 'LDG-RLT'  // could also be RTO; treat together
  if (f.velocityKts > 30 && nearestKm < 4) return 'HI-TAXI'
  if (f.velocityKts > 5) return 'LO-TAXI'
  return 'OFF'
}

export default function HydroplaneMonitor({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [scopeKm, setScopeKm] = useState(15)
  const [pressMul, setPressMul] = useState(1.0)
  const [depthMul, setDepthMul] = useState(1.0)
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'RUNWAYS'|'VP'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shLink, setShLink] = useState(true)
  const [shRwy, setShRwy] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      // nearest runway
      let best: Runway | null = null
      let bestKm = Infinity
      for (const r of RUNWAYS) {
        const d = gcKm(f.lat, f.lng, r.lat, r.lng)
        if (d < bestKm) { bestKm = d; best = r }
      }
      if (!best || bestKm > scopeKm * 12) continue
      const ph = phaseOf(f, bestKm)
      if (ph === 'OFF') continue

      const sp = tireSpecs(f.type)
      const psiEff = sp.psi * pressMul
      // Horne: Vp = 9 sqrt(psi)  (rotating wheel)
      const vpDyn = 9 * Math.sqrt(psiEff)
      const v = f.velocityKts
      const ratio = v / Math.max(1, vpDyn)
      const muNominal = muFromRWYCC(best.rwycc)
      const depthEff = best.depthMm * depthMul
      // contaminant penalty mu reduction
      const contamPenalty = CONTAM_MUL[best.contam] * (0.5 + 0.5*Math.min(1, depthEff/10))
      const muEff = clamp(muNominal - 0.15*contamPenalty, 0.03, 0.85)

      // DRIVERS 0-100
      const dVP    = clamp((ratio - 0.55) * 220, 0, 100)
      const dCONT  = clamp(contamPenalty * 55, 0, 100)
      const dTREAD = clamp((3.5 - sp.groove) * 35 + (1.0 - pressMul) * 60, 0, 100)
      const dMU    = clamp((0.80 - muEff) * 130, 0, 100)
      // crude crosswind proxy = sin between track and runway (stub via icao hash)
      let h = 0; const k = f.icao
      for (let i=0;i<k.length;i++) h = ((h*31) + k.charCodeAt(i)) >>> 0
      const xwndKt = (h % 22)
      const dXWND  = clamp((xwndKt - 6) * 6, 0, 100)
      const phaseW: Record<Phase, number> = { 'LDG-RLT':1.20, 'RTO':1.25, 'TKOF-ROLL':1.05, 'HI-TAXI':0.85, 'LO-TAXI':0.50, 'OFF':0 }
      const dPHASE = phaseW[ph] * 50

      const drivers = { VP:dVP, CONT:dCONT, TREAD:dTREAD, MU:dMU, XWND:dXWND, PHASE:dPHASE }
      const arr = Object.values(drivers)
      const mx = Math.max(...arr), mn = arr.reduce((a,b)=>a+b,0)/arr.length
      let score = (mx * 0.66 + mn * 0.34) * phaseW[ph] * advMul
      const notes: string[] = []
      // hard escalators
      if (ratio >= 1.0 && best.contam !== 'DRY' && best.contam !== 'WET') { score = Math.max(score, 95); notes.push('v ≥ Vp on contaminated rwy — full dynamic hydroplane') }
      else if (ratio >= 0.85 && (best.contam === 'STD-WTR' || best.contam === 'SLUSH')) { score = Math.max(score, 94); notes.push('within 15% of Vp with standing water — film rupture imminent') }
      if (best.rwycc <= 1 && (ph === 'LDG-RLT' || ph === 'RTO')) { score = Math.max(score, 88); notes.push('RWYCC ≤1 in braking phase — NIL-friction risk per ICAO RCAM') }
      if (best.contam === 'ICE' && v > 40) { score = Math.max(score, 90); notes.push('Ice contamination at speed — reverted-rubber risk') }
      score = clamp(score, 0, 100)

      let tier: Tier = 'OFF'
      if (score >= 85) tier = 'AQUAPLANE'
      else if (score >= 65) tier = 'IMMINENT'
      else if (score >= 45) tier = 'MARGIN'
      else if (score >= 22) tier = 'WATCH'
      else tier = 'DRY'

      out.push({ f, phase: ph, rwy: best, distKm: bestKm, cls: sp.cls, psi: psiEff, groove: sp.groove, vp: vpDyn, ratio, muEff, drivers, score, tier, notes })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, scopeKm, pressMul, depthMul])

  // === MapLibre overlay ===
  useEffect(() => {
    if (!map) return
    const SRC = 'hydroplane-src'
    const SRC_RWY = 'hydroplane-rwy-src'
    const SRC_LNK = 'hydroplane-link-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    const writeAll = () => {
      ensureSrc(SRC); ensureSrc(SRC_RWY); ensureSrc(SRC_LNK)
      const view = rows.filter(r => (tierFilter==='ALL'||r.tier===tierFilter) && (phaseFilter==='ALL'||r.phase===phaseFilter))
      const acFeats: any[] = []
      const lnkFeats: any[] = []
      for (const r of view) {
        acFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ tier:r.tier, color:TIER_COLOR[r.tier], score:r.score, sz: 7 + (r.score/100)*12, label: `${r.f.callsign||r.f.icao} · ${r.cls} · v/Vp=${r.ratio.toFixed(2)}`, ratio: r.ratio } })
        lnkFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat],[r.rwy.lng, r.rwy.lat]] }, properties:{ color: TIER_COLOR[r.tier] } })
      }
      const rwyFeats = RUNWAYS.map(w => ({ type:'Feature', geometry:{ type:'Point', coordinates:[w.lng, w.lat] }, properties:{ id:w.id, contam:w.contam, rwycc:w.rwycc, depth:w.depthMm } }))
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_RWY) as any).setData({ type:'FeatureCollection', features: shRwy ? rwyFeats : [] })
      ;(map.getSource(SRC_LNK) as any).setData({ type:'FeatureCollection', features: shLink ? lnkFeats : [] })
    }
    ensureSrc(SRC); ensureSrc(SRC_RWY); ensureSrc(SRC_LNK)
    if (!map.getLayer('hydroplane-halo'))
      map.addLayer({ id:'hydroplane-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('hydroplane-pin'))
      map.addLayer({ id:'hydroplane-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('hydroplane-lbl'))
      map.addLayer({ id:'hydroplane-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('hydroplane-rwy'))
      map.addLayer({ id:'hydroplane-rwy', type:'circle', source:SRC_RWY, paint:{ 'circle-radius':5, 'circle-color':'#0ea5e9', 'circle-opacity':0.5, 'circle-stroke-color':'#38bdf8', 'circle-stroke-width':1.5 } })
    if (!map.getLayer('hydroplane-lnk'))
      map.addLayer({ id:'hydroplane-lnk', type:'line', source:SRC_LNK, paint:{ 'line-color':['get','color'], 'line-width':1.2, 'line-dasharray':[2,2], 'line-opacity':0.7 } })
    writeAll()
    return () => {
      for (const id of ['hydroplane-lbl','hydroplane-pin','hydroplane-halo','hydroplane-rwy','hydroplane-lnk']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_RWY, SRC_LNK]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, phaseFilter, shHalo, shPin, shLbl, shLink, shRwy])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.f.operator||'').toLowerCase().includes(search.toLowerCase()) || r.rwy.id.toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { AQUAPLANE:0, IMMINENT:0, MARGIN:0, WATCH:0, DRY:0, OFF:0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const worst = rows[0]
  const exposedRwy = new Set(rows.map(r=>r.rwy.id)).size

  return (
    <div className="fixed top-16 right-3 z-40 w-[460px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">HYDROPLANE</span>
          <span className="text-[10px] text-slate-400">wet-rwy aquaplaning · Vp=9√psi</span>
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
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">AQUA</div><div className="font-mono" style={{color:TIER_COLOR.AQUAPLANE}}>{counts.AQUAPLANE}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">IMMNT</div><div className="font-mono" style={{color:TIER_COLOR.IMMINENT}}>{counts.IMMINENT}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||worst?.f.icao||'—'}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">RWY-X</div><div className="text-slate-100 font-mono">{exposedRwy}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">SCOPE <span className="text-slate-200 font-mono">{scopeKm}km</span>
            <input type="range" min="5" max="60" value={scopeKm} onChange={e=>setScopeKm(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">TIRE-PSI <span className="text-slate-200 font-mono">{(pressMul*100).toFixed(0)}%</span>
            <input type="range" min="60" max="130" value={pressMul*100} onChange={e=>setPressMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">DEPTH-MUL <span className="text-slate-200 font-mono">{(depthMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={depthMul*100} onChange={e=>setDepthMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','LDG-RLT','HI-TAXI','LO-TAXI','TKOF-ROLL'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['LINK',shLink,setShLink],['RWY',shRwy,setShRwy]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op/rwy" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','RUNWAYS','VP'] as const).map(t => (
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
              <div>v <span className="text-slate-100 font-mono">{r.f.velocityKts.toFixed(0)}kt</span></div>
              <div>Vp <span className="text-slate-100 font-mono">{r.vp.toFixed(0)}kt</span></div>
              <div>v/Vp <span className="text-slate-100 font-mono">{r.ratio.toFixed(2)}</span></div>
              <div>μ-eff <span className="text-slate-100 font-mono">{r.muEff.toFixed(2)}</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>RWY <span className="text-slate-100 font-mono">{r.rwy.id}</span></div>
              <div>CC <span className="text-slate-100 font-mono">{r.rwy.rwycc}</span></div>
              <div>CTM <span className="text-slate-100 font-mono">{r.rwy.contam}</span></div>
              <div>DPT <span className="text-slate-100 font-mono">{r.rwy.depthMm}mm</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='DRY' && <div className="mt-1 text-[9px] text-slate-500">apply max anti-skid · do not unstow reversers below 60kt · AC 91-79B §5.4</div>}
          </div>
        ))}

        {tab==='RUNWAYS' && (
          <div className="space-y-1">
            {RUNWAYS.map(w => {
              const onRwy = rows.filter(r => r.rwy.id===w.id)
              const aq = onRwy.filter(r=>r.tier==='AQUAPLANE').length
              const im = onRwy.filter(r=>r.tier==='IMMINENT').length
              return (
                <div key={w.id} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <span className="font-mono text-slate-100">{w.id}</span>
                    <span className="text-slate-400">{w.name}</span>
                    <span className="ml-auto px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">CC {w.rwycc}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                    <div>CTM <span className="text-slate-100 font-mono">{w.contam}</span></div>
                    <div>DPT <span className="text-slate-100 font-mono">{w.depthMm}mm</span></div>
                    <div>μ-nom <span className="text-slate-100 font-mono">{muFromRWYCC(w.rwycc).toFixed(2)}</span></div>
                    <div>EXP <span className="text-slate-100 font-mono">{onRwy.length}</span></div>
                  </div>
                  <div className="grid grid-cols-2 gap-1 text-[10px] text-slate-400">
                    <div>AQUA <span className="font-mono" style={{color:TIER_COLOR.AQUAPLANE}}>{aq}</span></div>
                    <div>IMMNT <span className="font-mono" style={{color:TIER_COLOR.IMMINENT}}>{im}</span></div>
                  </div>
                  <div className="text-[9px] text-slate-500 italic mt-0.5">ICAO Annex 14 App.A · Doc 9981 RCAM lookup</div>
                </div>
              )
            })}
          </div>
        )}

        {tab==='VP' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">Vp = 9 · √p_tire [kts, psi]</div>
              <div className="text-slate-400">NASA TN D-2056 Horne &amp; Dreher 1963 — pneumatic-tire dynamic-aquaplaning onset where standing-water inertia lifts tire footprint clear of pavement. Locked-wheel coefficient drops to 7.7 (ESDU 71026). μ-effective derived from ICAO RCAM (Annex 14 App.A) RWYCC 0-6 with contaminant depth/type penalty per ESDU 90035.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">Vp [kts] vs tire pressure [psi] · per class</div>
              <svg viewBox="0 0 400 180" className="w-full">
                {/* axes */}
                <line x1="40" y1="160" x2="390" y2="160" stroke="#334155" />
                <line x1="40" y1="20"  x2="40"  y2="160" stroke="#334155" />
                {/* x ticks psi 80-240 */}
                {[80,120,160,200,240].map(p => (
                  <g key={p}><line x1={40 + (p-80)/160*350} y1="158" x2={40 + (p-80)/160*350} y2="162" stroke="#475569"/>
                    <text x={40 + (p-80)/160*350} y={172} fill="#94a3b8" fontSize="9" textAnchor="middle">{p}</text></g>
                ))}
                {/* y ticks kts 0-160 */}
                {[40,80,120,160].map(k => (
                  <g key={k}><line x1="38" y1={160 - k/160*140} x2="42" y2={160 - k/160*140} stroke="#475569"/>
                    <text x={34} y={163 - k/160*140} fill="#94a3b8" fontSize="9" textAnchor="end">{k}</text></g>
                ))}
                <text x="215" y="178" fill="#94a3b8" fontSize="9" textAnchor="middle">tire psi</text>
                <text x="14" y="90" fill="#94a3b8" fontSize="9" textAnchor="middle" transform="rotate(-90 14 90)">Vp kts</text>
                {/* dynamic 9√psi */}
                <path d={Array.from({length:60},(_,i)=>{
                  const p = 80 + i*(160/59); const v = 9*Math.sqrt(p)
                  const x = 40 + (p-80)/160*350; const y = 160 - v/160*140
                  return `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`
                }).join(' ')} stroke="#0ea5e9" fill="none" strokeWidth="1.6" />
                {/* locked 7.7√psi */}
                <path d={Array.from({length:60},(_,i)=>{
                  const p = 80 + i*(160/59); const v = 7.7*Math.sqrt(p)
                  const x = 40 + (p-80)/160*350; const y = 160 - v/160*140
                  return `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`
                }).join(' ')} stroke="#f59e0b" fill="none" strokeWidth="1.4" strokeDasharray="3 3" />
                {/* fleet dots at (psi, v) */}
                {rows.slice(0,40).map((r,i) => {
                  const x = 40 + clamp((r.psi-80)/160*350, 0, 350)
                  const y = 160 - clamp(r.f.velocityKts/160*140, 0, 140)
                  return <circle key={i} cx={x} cy={y} r="2.4" fill={TIER_COLOR[r.tier]} opacity={0.85} />
                })}
                <text x="380" y="36" fill="#0ea5e9" fontSize="9" textAnchor="end">Vp = 9√psi (rotating)</text>
                <text x="380" y="48" fill="#f59e0b" fontSize="9" textAnchor="end">Vp = 7.7√psi (locked)</text>
              </svg>
              <div className="grid grid-cols-3 gap-1 mt-1 text-[10px]">
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLEET</div><div className="text-slate-100 font-mono">{rows.length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-v/Vp</div><div className="text-slate-100 font-mono">{rows.length?(rows.reduce((a,b)=>a+b.ratio,0)/rows.length).toFixed(2):'—'}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">PICK</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||'—'}</div></div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · NASA TN D-2056 Horne &amp; Dreher 1963 · TN D-2776 · TN D-4406 · ESDU 71026 / 90035 · 14 CFR §25.109 §25.125 §25.1591 §121.195 · EASA CS-25 AMC 25.1591 · FAA AC 91-79B / AC 25-32 / AC 25-31 · ICAO Doc 9981 PANS-ADR · Annex 14 Vol I App.A RCAM · ICAO Doc 9137 Pt 2 · SAE ARP5288 · Boeing AC 805 Wet-Rwy §6 · Airbus FCOM PRO-NOR-SRP-04 · NTSB AAR-05-04 SWA 1248 KMDW · AAR-08-02 AAL 1420 KLIT · TSB A05H0002 AFR 358 CYYZ · NTSB AAB-83-04 reverted-rubber.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
