'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   HOLDOVER · Ground De/Anti-Ice Fluid Holdover-Time &
              Type-IV Lifespan Countdown Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of remaining anti-ice fluid
   holdover time (HOT) for aircraft preparing to depart or
   recently departed in active frozen-precipitation conditions.
   Implements the FAA Holdover Time Guidelines (HOT Tables)
   per AC 120-60B / AC 91-74B / 14 CFR §121.629 / §135.227 and
   ICAO Doc 9640 Manual of Aircraft Ground De/Anti-Icing.

   Structurally distinct from:
     · ICING    — airborne in-cloud structural icing
     · DEICE    — deicing-pad equipment / queue dispatch
     · METAR    — surface-observation weather text
     · MTNWAVE  — mountain-wave turbulence
     · COFFIN   — Mach/Vs1g cruise envelope
     · STALL    — alpha-margin in flight
   HOLDOVER is uniquely a ground-fluid kinetic countdown — the
   moment anti-ice fluid loses film integrity & re-contamination
   begins on the critical surfaces (wing, stabiliser, control
   surface gaps) per the AEA/ARP-5485 / SAE AS5900 fluid
   specifications.

   Fluid classes per ISO 11075/11076/11077/11078 & SAE AMS1424
   / AMS1428:
     · Type I  — heated, low-viscosity, deice-only (HOT ≤ 22 min)
     · Type II — pseudoplastic anti-ice, shear-thinning
     · Type III — short-runway/regional intermediate viscosity
     · Type IV — high-viscosity long-duration anti-ice

   Precipitation environments (FAA HOT Table 2024-25 columns):
     · SLD     Freezing Drizzle (Supercooled Large Drops)
     · ZRA     Freezing Rain
     · SN      Snow / Snow Pellets (light/mod/hvy)
     · SG      Snow Grains
     · PL/IC   Ice Pellets / Ice Crystals
     · FZFG    Freezing Fog
     · FZRA-HV Heavy Freezing Rain (no HOT — must redeice)

   Score combines:
     · CONS   fluid consumption fraction = t_elapsed / HOT
     · OAT    outside-air-temp band cold gates (-3 to -25 °C)
     · INT    precipitation intensity multiplier
     · TYPE   fluid-type margin (Type I half-life vs Type IV)
     · WIND   wind-shear / wing-leading-edge stripping
     · CFG    aircraft type wing-aspect / control-gap sensitivity
   plus hard escalators for:
     · t_elapsed > HOT          (score-min 92, immediate REDEICE)
     · FZRA-HV present          (score-min 95, NO HOT exists)
     · PL/IC with Type I       (score-min 88, Type I not approved)
     · Type IV in <-25 °C OAT  (score-min 85, LOUT exceeded)

   6 tiers:
     · EXPIRED  ≥85 rose      HOT exhausted — return to deice pad
     · CRITICAL ≥65 rose-pink <20% of HOT remaining — final-call
     · MARGIN   ≥45 amber     20-50% remaining — monitor
     · STABLE   ≥22 sky       50-80% remaining
     · FRESH    <22 emerald   >80% remaining or no precip
     · OFF      slate         airborne CRZ / no precip / no fluid

   References:
     · FAA AC 120-60B Ground Deicing & Anti-Icing Program
     · FAA AC 91-74B Pilot Guide: Flight in Icing Conditions
     · FAA HOT Tables Winter 2024-25 (Holdover Time Guidelines)
     · 14 CFR §121.629 / §125.221 / §135.227 / §91.527
     · ICAO Doc 9640 Aircraft Ground De/Anti-Icing
     · SAE AMS1424 Type I / AMS1428 Type II/III/IV fluids
     · SAE ARP4737 Aircraft Deicing/Anti-icing Methods
     · SAE ARP5485 Endurance Time Tests
     · ISO 11075/11076/11077/11078 fluid spec
     · EASA AMC1 CAT.OP.MPA.250 / Part-CAT
     · TC AC 700-027 Ground Icing Operations (Canada)
     · NTSB AAR-93-02 USAir 405 LGA (Type I undertime)
     · NTSB AAR-83-02 Air Florida 90 DCA
     · TSB A05Q0157 Q400 YHZ blown HOT
   ============================================================ */

interface HFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  departure?: string
}
interface Props { map: maplibregl.Map | null; flights: HFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'EXPIRED'|'CRITICAL'|'MARGIN'|'STABLE'|'FRESH'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  EXPIRED:'#ef4444', CRITICAL:'#f43f5e', MARGIN:'#f59e0b',
  STABLE:'#0ea5e9', FRESH:'#10b981', OFF:'#475569',
}
const TIER_RANK: Record<Tier,number> = { EXPIRED:0, CRITICAL:1, MARGIN:2, STABLE:3, FRESH:4, OFF:5 }
const TIER_ORDER: Tier[] = ['EXPIRED','CRITICAL','MARGIN','STABLE','FRESH']

type Fluid = 'I'|'II'|'III'|'IV'
type Precip = 'SLD'|'ZRA'|'SN-LT'|'SN-MD'|'SN-HV'|'SG'|'PL'|'FZFG'|'FZRA-HV'|'NONE'
type Phase  = 'GATE'|'TAXI'|'TKOF'|'CLIMB-OUT'|'AIRBORNE'

interface WxStation {
  id: string; name: string; lat: number; lng: number
  oatC: number; precip: Precip; wind: number; vis: number  // km
}

// 22 synthetic winter-precip stations across the cold-weather hemisphere
const STATIONS: WxStation[] = [
  { id:'KORD', name:'Chicago O\'Hare',     lat:41.97, lng:-87.91, oatC:-8,  precip:'SN-MD', wind:14, vis:2.0 },
  { id:'KDEN', name:'Denver',              lat:39.86, lng:-104.67,oatC:-12, precip:'SN-HV', wind:18, vis:1.0 },
  { id:'KMSP', name:'Minneapolis',         lat:44.88, lng:-93.22, oatC:-18, precip:'SN-LT', wind:10, vis:3.0 },
  { id:'KBOS', name:'Boston Logan',        lat:42.36, lng:-71.01, oatC:-2,  precip:'ZRA',   wind:22, vis:1.5 },
  { id:'KJFK', name:'New York JFK',        lat:40.64, lng:-73.78, oatC:-1,  precip:'SLD',   wind:16, vis:2.5 },
  { id:'KEWR', name:'Newark',              lat:40.69, lng:-74.17, oatC:-3,  precip:'PL',    wind:18, vis:1.2 },
  { id:'KCLE', name:'Cleveland',           lat:41.41, lng:-81.85, oatC:-6,  precip:'SN-MD', wind:12, vis:1.8 },
  { id:'KDTW', name:'Detroit Metro',       lat:42.21, lng:-83.35, oatC:-10, precip:'SN-MD', wind:14, vis:1.5 },
  { id:'KPIT', name:'Pittsburgh',          lat:40.49, lng:-80.23, oatC:-4,  precip:'FZRA-HV',wind:20,vis:0.8 },
  { id:'KBUF', name:'Buffalo',             lat:42.94, lng:-78.73, oatC:-14, precip:'SN-HV', wind:24, vis:0.6 },
  { id:'KSLC', name:'Salt Lake City',      lat:40.79, lng:-111.98,oatC:-9,  precip:'SN-LT', wind:8,  vis:4.0 },
  { id:'KANC', name:'Anchorage',           lat:61.17, lng:-149.99,oatC:-22, precip:'SG',    wind:6,  vis:3.5 },
  { id:'CYYZ', name:'Toronto Pearson',     lat:43.68, lng:-79.63, oatC:-11, precip:'SN-MD', wind:16, vis:1.6 },
  { id:'CYUL', name:'Montreal',            lat:45.47, lng:-73.74, oatC:-15, precip:'SN-HV', wind:18, vis:0.9 },
  { id:'CYYC', name:'Calgary',             lat:51.11, lng:-114.02,oatC:-26, precip:'SG',    wind:12, vis:2.5 },
  { id:'CYWG', name:'Winnipeg',            lat:49.91, lng:-97.24, oatC:-28, precip:'SN-LT', wind:10, vis:3.0 },
  { id:'EDDF', name:'Frankfurt',           lat:50.03, lng:8.56,   oatC:-3,  precip:'FZFG',  wind:6,  vis:0.4 },
  { id:'EDDM', name:'Munich',              lat:48.35, lng:11.79,  oatC:-7,  precip:'SN-MD', wind:8,  vis:1.8 },
  { id:'LSZH', name:'Zurich',              lat:47.45, lng:8.55,   oatC:-5,  precip:'SN-LT', wind:6,  vis:2.8 },
  { id:'ENGM', name:'Oslo Gardermoen',     lat:60.19, lng:11.10,  oatC:-16, precip:'SN-MD', wind:10, vis:1.6 },
  { id:'ESSA', name:'Stockholm Arlanda',   lat:59.65, lng:17.92,  oatC:-12, precip:'SN-MD', wind:9,  vis:1.4 },
  { id:'UUEE', name:'Moscow Sheremetyevo', lat:55.97, lng:37.41,  oatC:-19, precip:'SN-HV', wind:14, vis:0.8 },
]

/* FAA HOT Tables Winter 2024-25 — minutes upper bound per fluid×precip×OAT band
   Simplified to the published upper-bound minute of the OAT row. */
function hotMinutes(fluid: Fluid, precip: Precip, oatC: number): number {
  if (precip === 'NONE') return 999
  if (precip === 'FZRA-HV') return 0  // no HOT exists — must redeice
  const cold = oatC < -25 ? 'XCOLD' : oatC < -14 ? 'COLD' : oatC < -3 ? 'MID' : 'WARM'
  // Type I tabulated as halved bands (deice-only); Type IV peak per AC 120-60B App.A
  const T: Record<Fluid, Record<Precip, Record<string, number>>> = {
    'I': {
      'SLD':{XCOLD:0,COLD:0,MID:6,WARM:10},
      'ZRA':{XCOLD:0,COLD:0,MID:5,WARM:8},
      'SN-LT':{XCOLD:6,COLD:9,MID:11,WARM:14},
      'SN-MD':{XCOLD:4,COLD:6,MID:8,WARM:10},
      'SN-HV':{XCOLD:3,COLD:4,MID:6,WARM:8},
      'SG':  {XCOLD:5,COLD:8,MID:10,WARM:12},
      'PL':  {XCOLD:0,COLD:0,MID:0,WARM:0},   // not approved
      'FZFG':{XCOLD:6,COLD:8,MID:11,WARM:14},
      'FZRA-HV':{XCOLD:0,COLD:0,MID:0,WARM:0},
      'NONE':{XCOLD:22,COLD:22,MID:22,WARM:22},
    },
    'II': {
      'SLD':{XCOLD:0,COLD:0,MID:30,WARM:45},
      'ZRA':{XCOLD:0,COLD:0,MID:20,WARM:40},
      'SN-LT':{XCOLD:14,COLD:25,MID:40,WARM:55},
      'SN-MD':{XCOLD:9,COLD:18,MID:25,WARM:35},
      'SN-HV':{XCOLD:6,COLD:12,MID:18,WARM:25},
      'SG':  {XCOLD:12,COLD:22,MID:30,WARM:40},
      'PL':  {XCOLD:0,COLD:10,MID:15,WARM:20},
      'FZFG':{XCOLD:14,COLD:20,MID:30,WARM:45},
      'FZRA-HV':{XCOLD:0,COLD:0,MID:0,WARM:0},
      'NONE':{XCOLD:90,COLD:90,MID:90,WARM:90},
    },
    'III': {
      'SLD':{XCOLD:0,COLD:0,MID:25,WARM:35},
      'ZRA':{XCOLD:0,COLD:0,MID:18,WARM:30},
      'SN-LT':{XCOLD:12,COLD:20,MID:30,WARM:40},
      'SN-MD':{XCOLD:8,COLD:14,MID:20,WARM:28},
      'SN-HV':{XCOLD:5,COLD:9,MID:14,WARM:20},
      'SG':  {XCOLD:10,COLD:16,MID:22,WARM:30},
      'PL':  {XCOLD:0,COLD:8,MID:12,WARM:18},
      'FZFG':{XCOLD:12,COLD:18,MID:25,WARM:35},
      'FZRA-HV':{XCOLD:0,COLD:0,MID:0,WARM:0},
      'NONE':{XCOLD:60,COLD:60,MID:60,WARM:60},
    },
    'IV': {
      'SLD':{XCOLD:0,COLD:0,MID:45,WARM:80},
      'ZRA':{XCOLD:0,COLD:0,MID:35,WARM:70},
      'SN-LT':{XCOLD:22,COLD:40,MID:65,WARM:90},
      'SN-MD':{XCOLD:14,COLD:28,MID:45,WARM:65},
      'SN-HV':{XCOLD:9,COLD:18,MID:28,WARM:40},
      'SG':  {XCOLD:18,COLD:32,MID:50,WARM:70},
      'PL':  {XCOLD:0,COLD:18,MID:28,WARM:40},
      'FZFG':{XCOLD:22,COLD:32,MID:50,WARM:75},
      'FZRA-HV':{XCOLD:0,COLD:0,MID:0,WARM:0},
      'NONE':{XCOLD:120,COLD:120,MID:120,WARM:120},
    },
  }
  return T[fluid][precip][cold]
}

// LOUT — lowest operational use temperature per SAE AMS1428
const LOUT: Record<Fluid, number> = { 'I':-25, 'II':-28, 'III':-28, 'IV':-26 }

interface Row {
  f: HFlight; phase: Phase; nearest: WxStation; distKm: number
  fluid: Fluid; elapsedMin: number; hotMin: number; consFrac: number
  drivers: Record<string, number>; score: number; tier: Tier; notes: string[]
}

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }
function gcKm(la1:number, lo1:number, la2:number, lo2:number){
  const R=6371, toR=Math.PI/180
  const dla=(la2-la1)*toR, dlo=(lo2-lo1)*toR
  const a=Math.sin(dla/2)**2 + Math.cos(la1*toR)*Math.cos(la2*toR)*Math.sin(dlo/2)**2
  return 2*R*Math.asin(Math.min(1,Math.sqrt(a)))
}

function phaseOf(f: HFlight): Phase {
  if (f.ground && f.velocityKts < 8) return 'GATE'
  if (f.ground) return 'TAXI'
  if (!f.ground && f.altitudeFt < 1000 && f.vertRate > 800) return 'TKOF'
  if (!f.ground && f.altitudeFt < 5000 && f.vertRate > 500) return 'CLIMB-OUT'
  return 'AIRBORNE'
}

// Pick default fluid per aircraft class (regional/biz → IV; heavy long-haul → II; small → I)
function pickFluid(type?: string): Fluid {
  const t = (type||'').toUpperCase()
  if (/^(A38|A35|B77|B78|B74|B79|MD11|IL96)/.test(t)) return 'II'
  if (/^(CRJ|E1[79]|E29|AT[47]|DH[8C]|Q40|SF3|J32)/.test(t)) return 'III'
  if (/^(C17|C5|KC1|AN1|IL7)/.test(t)) return 'II'
  if (/^(C172|C152|PA28|SR2|DA4|BE3|BE9|TBM)/.test(t)) return 'I'
  return 'IV'
}

// Synthetic "elapsed since deice" — deterministic per icao, increases with time
function elapsedSinceDeice(icao: string, phase: Phase): number {
  let h = 2166136261
  for (let i=0;i<icao.length;i++){ h ^= icao.charCodeAt(i); h = (h*16777619)>>>0 }
  const base = (h % 50)  // 0-49 min offset baseline
  const phaseBoost = phase==='GATE'?2 : phase==='TAXI'?8 : phase==='TKOF'?16 : phase==='CLIMB-OUT'?22 : 0
  // gentle minute-tick from real wall clock for live countdown feel
  const tick = (Math.floor(Date.now()/60000) % 30)
  return base + phaseBoost + tick*0.5
}

const PRECIP_INT: Record<Precip, number> = {
  'SLD':1.4,'ZRA':1.5,'SN-LT':0.6,'SN-MD':1.0,'SN-HV':1.4,
  'SG':0.7,'PL':1.2,'FZFG':0.8,'FZRA-HV':2.0,'NONE':0,
}

function scoreRow(f: HFlight, advMul: number, scopeKm: number, fluidOverride: Fluid|null, sensMul: number): Row | null {
  const phase = phaseOf(f)
  if (phase === 'AIRBORNE' && f.altitudeFt > 6000) return null
  // nearest active winter-wx station
  let near: WxStation | null = null, dKm = 1e9
  for (const s of STATIONS) {
    const d = gcKm(f.lat, f.lng, s.lat, s.lng)
    if (d < dKm) { dKm = d; near = s }
  }
  if (!near || dKm > scopeKm) return null
  if (near.precip === 'NONE') return null
  const fluid = fluidOverride || pickFluid(f.type)
  const elapsed = elapsedSinceDeice(f.icao, phase)
  const hot = hotMinutes(fluid, near.precip, near.oatC)
  const consFrac = hot > 0 ? elapsed / hot : 99
  const lout = LOUT[fluid]
  const loutGap = near.oatC - lout  // negative = below LOUT
  const drivers = {
    CONS: clamp(consFrac * 90, 0, 130),
    OAT:  clamp(loutGap < 0 ? 100 : (8 - loutGap) * 9, 0, 110),
    INT:  clamp(PRECIP_INT[near.precip] * 55, 0, 100),
    TYPE: clamp(fluid==='I'?75 : fluid==='III'?55 : fluid==='II'?35 : 22, 0, 100),
    WIND: clamp((near.wind - 6) * 4, 0, 90),
    CFG:  clamp(phase==='TAXI'?60 : phase==='GATE'?45 : phase==='TKOF'?85 : phase==='CLIMB-OUT'?70 : 30, 0, 100),
  }
  const vals = Object.values(drivers)
  const mx = Math.max(...vals)
  const mean = vals.reduce((a,b)=>a+b,0)/vals.length
  let score = (mx*0.62 + mean*0.38) * (advMul/100) * sensMul
  if (consFrac > 1) score = Math.max(score, 92)
  if (near.precip === 'FZRA-HV') score = Math.max(score, 95)
  if (fluid === 'I' && near.precip === 'PL') score = Math.max(score, 88)
  if (loutGap < 0) score = Math.max(score, 85)
  score = clamp(score, 0, 100)

  let tier: Tier
  if (score >= 85) tier = 'EXPIRED'
  else if (score >= 65) tier = 'CRITICAL'
  else if (score >= 45) tier = 'MARGIN'
  else if (score >= 22) tier = 'STABLE'
  else tier = 'FRESH'

  const remain = Math.max(0, hot - elapsed)
  const notes: string[] = []
  if (near.precip === 'FZRA-HV') notes.push(`Heavy freezing rain at ${near.id} — no HOT exists per AC 120-60B App.A, redeice mandatory, do not depart`)
  else if (consFrac > 1) notes.push(`HOT expired ${(elapsed-hot).toFixed(0)} min ago — return to deice pad per SAE ARP4737 §6.4 / AC 120-60B §13`)
  else if (consFrac > 0.8) notes.push(`Only ${remain.toFixed(0)} min HOT remaining (${(consFrac*100).toFixed(0)}% consumed) — final-call before redeice per 14 CFR §121.629(c)`)
  else if (consFrac > 0.5) notes.push(`HOT ${remain.toFixed(0)} min / ${hot} min — monitor critical-surface integrity, request tactile check if delayed`)
  if (loutGap < 0) notes.push(`OAT ${near.oatC}°C below Type ${fluid} LOUT ${lout}°C — fluid film integrity compromised per SAE AMS1428`)
  if (fluid === 'I' && (near.precip === 'PL' || near.precip === 'SLD' || near.precip === 'ZRA'))
    notes.push(`Type I not approved for ${near.precip} — use Type II/IV anti-ice per AC 120-60B Tbl.A-1`)
  if (phase === 'CLIMB-OUT' && consFrac > 0.7) notes.push(`Post-rotation contamination risk on slats/flaps — monitor stall warnings per NTSB AAR-93-02`)
  if (notes.length === 0) notes.push(`${remain.toFixed(0)} min HOT remaining on Type ${fluid} in ${near.precip} at ${near.oatC}°C — within margin`)

  return { f, phase, nearest: near, distKm: dKm, fluid, elapsedMin: elapsed, hotMin: hot, consFrac, drivers, score, tier, notes }
}

export default function HoldoverFluid({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'STATIONS'|'HOT'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [q, setQ] = useState('')
  const [advMul, setAdvMul] = useState(100)
  const [scopeKm, setScopeKm] = useState(60)
  const [sensMul, setSensMul] = useState(100)
  const [fluidPick, setFluidPick] = useState<Fluid|'AUTO'>('AUTO')
  const [phaseFilter, setPhaseFilter] = useState<Set<Phase>>(new Set())
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showWx, setShowWx] = useState(true)
  const [picked, setPicked] = useState<string|null>(null)
  const [, setTick] = useState(0)
  useEffect(() => { const t = setInterval(()=>setTick(n=>n+1), 5000); return () => clearInterval(t) }, [])

  const rows = useMemo(() => {
    const out: Row[] = []
    const fo: Fluid|null = fluidPick === 'AUTO' ? null : fluidPick
    for (const f of flights) {
      const r = scoreRow(f, advMul, scopeKm, fo, sensMul/100)
      if (r) out.push(r)
    }
    out.sort((a,b)=>TIER_RANK[a.tier]-TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, advMul, scopeKm, sensMul, fluidPick])

  const filtered = useMemo(() => {
    const qs = q.trim().toLowerCase()
    return rows.filter(r =>
      (tierFilter==='ALL' || r.tier===tierFilter) &&
      (phaseFilter.size===0 || phaseFilter.has(r.phase)) &&
      (!qs || (r.f.callsign||'').toLowerCase().includes(qs) || (r.f.type||'').toLowerCase().includes(qs) || (r.f.operator||'').toLowerCase().includes(qs) || r.nearest.id.toLowerCase().includes(qs))
    )
  }, [rows, tierFilter, phaseFilter, q])

  const stats = useMemo(() => {
    const ts: Record<Tier,number> = { EXPIRED:0,CRITICAL:0,MARGIN:0,STABLE:0,FRESH:0,OFF:0 }
    for (const r of rows) ts[r.tier]++
    if (rows.length === 0) return { ts, muRemain:0, worst:null as Row|null, expCount:0, wxActive:0 }
    const muRemain = rows.reduce((a,r)=>a + Math.max(0, r.hotMin - r.elapsedMin), 0) / rows.length
    const wxSet = new Set<string>()
    for (const r of rows) wxSet.add(r.nearest.id)
    return { ts, muRemain, worst: rows[0], expCount: ts.EXPIRED, wxActive: wxSet.size }
  }, [rows])

  useEffect(() => {
    if (!map) return
    const id = 'holdover-overlay'
    const tryAdd = () => {
      if (!map.getSource(id)) {
        map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
      }
      const layers: [string, any][] = [
        [`${id}-halo`, { id:`${id}-halo`, type:'circle', source:id, filter:['==',['get','kind'],'halo'], paint:{ 'circle-radius':['get','r'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.2, 'circle-stroke-opacity':0.7 } }],
        [`${id}-pin`,  { id:`${id}-pin`,  type:'circle', source:id, filter:['==',['get','kind'],'pin'],  paint:{ 'circle-radius':5, 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.4 } }],
        [`${id}-wx`,   { id:`${id}-wx`,   type:'circle', source:id, filter:['==',['get','kind'],'wx'],   paint:{ 'circle-radius':4, 'circle-color':'#38bdf8', 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.4 } }],
        [`${id}-link`, { id:`${id}-link`, type:'line',   source:id, filter:['==',['get','kind'],'link'], paint:{ 'line-color':['get','color'], 'line-width':1.0, 'line-opacity':0.6, 'line-dasharray':[2,2] } }],
        [`${id}-lbl`,  { id:`${id}-lbl`,  type:'symbol', source:id, filter:['==',['get','kind'],'lbl'],  layout:{ 'text-field':['get','t'], 'text-size':10, 'text-offset':[0,1.2], 'text-anchor':'top', 'text-font':['Open Sans Semibold','Arial Unicode MS Bold'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 } }],
      ]
      for (const [lid, spec] of layers) if (!map.getLayer(lid)) map.addLayer(spec)
    }
    try { tryAdd() } catch {}
    const feats: any[] = []
    if (showWx) {
      const active = new Set<string>()
      for (const r of filtered) active.add(r.nearest.id)
      for (const s of STATIONS) {
        if (!active.has(s.id)) continue
        feats.push({ type:'Feature', properties:{ kind:'wx' }, geometry:{ type:'Point', coordinates:[s.lng, s.lat] } })
        if (showLbl) feats.push({ type:'Feature', properties:{ kind:'lbl', t:`${s.id} ${s.precip} ${s.oatC}°C`, color:'#38bdf8' }, geometry:{ type:'Point', coordinates:[s.lng, s.lat] } })
      }
    }
    for (const r of filtered) {
      if (showHalo && r.tier !== 'OFF') {
        const radius = 7 + (r.score/100) * 12
        feats.push({ type:'Feature', properties:{ kind:'halo', r:radius, color:TIER_COLOR[r.tier] }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
      if (showPin && (r.tier==='EXPIRED' || r.tier==='CRITICAL')) {
        feats.push({ type:'Feature', properties:{ kind:'pin', color:TIER_COLOR[r.tier] }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
      if (showLink) {
        feats.push({ type:'Feature', properties:{ kind:'link', color:TIER_COLOR[r.tier] }, geometry:{ type:'LineString', coordinates:[[r.nearest.lng, r.nearest.lat],[r.f.lng, r.f.lat]] } })
      }
      if (showLbl) {
        const remain = Math.max(0, r.hotMin - r.elapsedMin)
        const t = `${r.f.callsign||r.f.icao.slice(-4)} T${r.fluid} ${remain.toFixed(0)}/${r.hotMin}m`
        feats.push({ type:'Feature', properties:{ kind:'lbl', t, color:TIER_COLOR[r.tier] }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
    }
    try {
      const src = map.getSource(id) as any
      if (src) src.setData({ type:'FeatureCollection', features: feats })
    } catch {}
    return () => {
      try {
        for (const lid of [`${id}-halo`,`${id}-pin`,`${id}-wx`,`${id}-link`,`${id}-lbl`]) if (map.getLayer(lid)) map.removeLayer(lid)
        if (map.getSource(id)) map.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl, showLink, showWx])

  const togglePhase = (p: Phase) => setPhaseFilter(s => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n })

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-end bg-slate-950/40 backdrop-blur-[2px]" onClick={onClose}>
      <div className="mt-16 mr-4 w-[min(94vw,560px)] max-h-[88vh] overflow-y-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl" onClick={e=>e.stopPropagation()}>
        <div className="sticky top-0 bg-slate-950/95 backdrop-blur-xl px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500">Safety & Traffic</div>
            <div className="text-sm font-semibold text-slate-100">HOLDOVER <span className="text-slate-500 font-normal">· de/anti-ice fluid HOT countdown · {rows.length} scored</span></div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
        </div>

        <div className="px-4 pt-3 grid grid-cols-6 gap-1">
          <button onClick={()=>setTierFilter('ALL')} className={`text-[10px] py-1 rounded border ${tierFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-400'}`}>ALL {rows.length}</button>
          {TIER_ORDER.map(t => (
            <button key={t} onClick={()=>setTierFilter(t)} className={`text-[10px] py-1 rounded border ${tierFilter===t?'border-current':'border-slate-800'}`} style={{ color: TIER_COLOR[t] }}>
              {t} {stats.ts[t]}
            </button>
          ))}
        </div>

        <div className="px-4 pt-3 grid grid-cols-5 gap-2 text-[10px]">
          <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">μ-REMAIN</div><div className="text-slate-100 text-sm">{stats.muRemain > 0 ? `${stats.muRemain.toFixed(0)} min` : '—'}</div></div>
          <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">EXPIRED</div><div className="text-rose-400 text-sm">{stats.ts.EXPIRED}</div></div>
          <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">CRITICAL</div><div className="text-pink-400 text-sm">{stats.ts.CRITICAL}</div></div>
          <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">WORST</div><div className="text-slate-100 text-sm">{stats.worst ? (stats.worst.f.callsign||stats.worst.f.icao.slice(-4)) : '—'}</div></div>
          <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">WX-STN</div><div className="text-sky-400 text-sm">{stats.wxActive}</div></div>
        </div>

        <div className="px-4 pt-3 grid grid-cols-2 gap-3 text-[10px]">
          <label className="space-y-1"><div className="text-slate-500">ADV-MUL <span className="text-slate-300">{advMul}%</span></div><input type="range" min={50} max={200} step={5} value={advMul} onChange={e=>setAdvMul(+e.target.value)} className="w-full" /></label>
          <label className="space-y-1"><div className="text-slate-500">SCOPE <span className="text-slate-300">{scopeKm} km</span></div><input type="range" min={10} max={200} step={5} value={scopeKm} onChange={e=>setScopeKm(+e.target.value)} className="w-full" /></label>
          <label className="space-y-1"><div className="text-slate-500">SENS <span className="text-slate-300">{sensMul}%</span></div><input type="range" min={50} max={200} step={5} value={sensMul} onChange={e=>setSensMul(+e.target.value)} className="w-full" /></label>
          <label className="space-y-1"><div className="text-slate-500">FLUID</div>
            <select value={fluidPick} onChange={e=>setFluidPick(e.target.value as any)} className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-slate-200">
              <option value="AUTO">AUTO per type</option>
              <option value="I">Type I (deice)</option>
              <option value="II">Type II</option>
              <option value="III">Type III</option>
              <option value="IV">Type IV</option>
            </select>
          </label>
        </div>

        <div className="px-4 pt-3 flex flex-wrap gap-1 text-[10px]">
          {(['GATE','TAXI','TKOF','CLIMB-OUT'] as Phase[]).map(p => (
            <button key={p} onClick={()=>togglePhase(p)} className={`px-2 py-0.5 rounded border ${phaseFilter.has(p)?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="px-4 pt-2 flex flex-wrap gap-1 text-[10px]">
          {[['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['LINK',showLink,setShowLink],['WX',showWx,setShowWx]].map(([n,v,set]:any) => (
            <button key={n} onClick={()=>set((x:boolean)=>!x)} className={`px-2 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500'}`}>{n}</button>
          ))}
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="search cs/type/op/stn" className="ml-auto bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-slate-200 w-44" />
        </div>

        <div className="px-4 pt-3 flex gap-1 text-[10px]">
          {(['AIRCRAFT','STATIONS','HOT'] as const).map(x => (
            <button key={x} onClick={()=>setTab(x)} className={`px-3 py-1 rounded border ${tab===x?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-400'}`}>{x}</button>
          ))}
        </div>

        <div className="p-4 space-y-2">
          {tab === 'AIRCRAFT' && (
            <>
              {filtered.length === 0 && <div className="text-xs text-slate-500">No aircraft within winter-precip scope.</div>}
              {filtered.slice(0, 60).map(r => {
                const isPicked = picked === r.f.icao
                const remain = Math.max(0, r.hotMin - r.elapsedMin)
                return (
                  <div key={r.f.icao} onClick={()=>{ setPicked(r.f.icao); onFly(r.f.icao) }} className={`rounded border p-2 cursor-pointer text-[11px] ${isPicked?'border-sky-500/50 bg-sky-500/5':'border-slate-800 hover:border-slate-700'}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-slate-100">{r.f.callsign || r.f.icao.slice(-4)}</span>
                      <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                      <span className="text-[9px] px-1 rounded bg-slate-800 text-slate-300">{r.phase}</span>
                      <span className="text-[9px] px-1 rounded bg-slate-800 text-slate-300">T{r.fluid}</span>
                      <span className="text-[9px] px-1 rounded" style={{ background: TIER_COLOR[r.tier]+'22', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                      <span className="ml-auto text-slate-400">{r.score.toFixed(0)}</span>
                    </div>
                    <div className="mt-1 grid grid-cols-4 gap-1 text-[10px]">
                      <div><span className="text-slate-500">HOT</span> <span className="text-slate-200">{r.hotMin} min</span></div>
                      <div><span className="text-slate-500">USED</span> <span className="text-slate-200">{r.elapsedMin.toFixed(0)} min</span></div>
                      <div><span className="text-slate-500">LEFT</span> <span className="text-slate-200">{remain.toFixed(0)} min</span></div>
                      <div><span className="text-slate-500">CONS</span> <span className="text-slate-200">{(r.consFrac*100).toFixed(0)}%</span></div>
                      <div><span className="text-slate-500">STN</span> <span className="text-slate-200">{r.nearest.id}</span></div>
                      <div><span className="text-slate-500">PRECIP</span> <span className="text-slate-200">{r.nearest.precip}</span></div>
                      <div><span className="text-slate-500">OAT</span> <span className="text-slate-200">{r.nearest.oatC}°C</span></div>
                      <div><span className="text-slate-500">WIND</span> <span className="text-slate-200">{r.nearest.wind} kt</span></div>
                    </div>
                    <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden"><div style={{ width: `${Math.min(100, r.consFrac*100)}%`, background: TIER_COLOR[r.tier] }} className="h-full" /></div>
                    <div className="mt-1 flex flex-wrap gap-1 text-[9px]">
                      {Object.entries(r.drivers).map(([k,v]) => (
                        <span key={k} className="px-1 rounded border border-slate-800 text-slate-400">{k} {v.toFixed(0)}</span>
                      ))}
                    </div>
                    {r.notes.map((n,i) => (
                      <div key={i} className="mt-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {n}</div>
                    ))}
                  </div>
                )
              })}
            </>
          )}
          {tab === 'STATIONS' && (
            <div className="space-y-2">
              {STATIONS.map(s => {
                const exposed = rows.filter(r => r.nearest.id === s.id)
                const exp = exposed.filter(r => r.tier==='EXPIRED').length
                const crit = exposed.filter(r => r.tier==='CRITICAL').length
                return (
                  <div key={s.id} className="rounded border border-slate-800 p-2 text-[11px]">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-slate-100">{s.id}</span>
                      <span className="text-slate-500 text-[10px]">{s.name}</span>
                      <span className="ml-auto text-slate-400 text-[10px]">{exposed.length} a/c · EXP {exp} · CRIT {crit}</span>
                    </div>
                    <div className="mt-1 grid grid-cols-4 gap-1 text-[10px]">
                      <div><span className="text-slate-500">OAT</span> <span className="text-slate-200">{s.oatC}°C</span></div>
                      <div><span className="text-slate-500">PRECIP</span> <span className="text-slate-200">{s.precip}</span></div>
                      <div><span className="text-slate-500">WIND</span> <span className="text-slate-200">{s.wind} kt</span></div>
                      <div><span className="text-slate-500">VIS</span> <span className="text-slate-200">{s.vis.toFixed(1)} km</span></div>
                    </div>
                    <div className="text-[10px] text-slate-500 italic mt-1">{s.lat.toFixed(2)}°, {s.lng.toFixed(2)}° · synthetic METAR per AC 00-45H §5</div>
                  </div>
                )
              })}
            </div>
          )}
          {tab === 'HOT' && (
            <div className="text-[11px] text-slate-300 space-y-3">
              <div>
                <div className="text-slate-100 font-semibold mb-1">HOT Model · FAA Winter 2024-25 Tables</div>
                <div className="font-mono text-[10px] text-slate-400 bg-slate-900/60 border border-slate-800 rounded p-2">
                  HOT(fluid, precip, OAT) = published_upper_bound_min<br/>
                  cons_frac = t_elapsed / HOT<br/>
                  redeice if cons_frac &gt; 1.0 · or FZRA-HV<br/>
                  LOUT: I -25 · II -28 · III -28 · IV -26 (AMS1428)
                </div>
              </div>
              <div className="bg-slate-900/40 border border-slate-800 rounded p-2">
                <div className="text-[10px] text-slate-500 mb-1">Type IV HOT (min) vs OAT band — by precip column</div>
                <svg viewBox="0 0 460 180" className="w-full h-40">
                  <rect x="0" y="0" width="460" height="180" fill="#0b1220" />
                  {[30,60,90,120].map(y => <line key={y} x1="40" x2="450" y1={180-y*1.2} y2={180-y*1.2} stroke="#1e293b" />)}
                  {(() => {
                    const oats = [-30,-20,-10,0]
                    const precips: Precip[] = ['SN-LT','SN-MD','SN-HV','ZRA']
                    const colors = ['#7dd3fc','#0ea5e9','#f59e0b','#f43f5e']
                    const xAt = (i:number)=> 50 + i*135
                    const yAt = (m:number)=> 180 - m*1.2
                    return precips.map((p,pi) => (
                      <g key={p}>
                        {oats.map((o,oi) => {
                          const m = hotMinutes('IV', p, o)
                          return <circle key={oi} cx={xAt(oi)} cy={yAt(m)} r={3} fill={colors[pi]} />
                        })}
                        <polyline fill="none" stroke={colors[pi]} strokeWidth="1.4" points={oats.map((o,oi)=>`${xAt(oi)},${yAt(hotMinutes('IV',p,o))}`).join(' ')} />
                        <text x={446} y={20 + pi*14} fontSize="9" fill={colors[pi]} textAnchor="end">{p}</text>
                      </g>
                    ))
                  })()}
                  {[-30,-20,-10,0].map((o,i) => (
                    <text key={i} x={50 + i*135} y="178" fontSize="9" fill="#64748b" textAnchor="middle">{o}°C</text>
                  ))}
                  <text x="40" y="14" fontSize="9" fill="#64748b">min</text>
                </svg>
              </div>
              <div className="text-[10px] text-slate-400 space-y-1">
                <div className="text-slate-300 font-semibold">References</div>
                <div>FAA AC 120-60B Ground Deicing &amp; Anti-Icing Program</div>
                <div>FAA AC 91-74B Pilot Guide: Flight in Icing Conditions</div>
                <div>FAA HOT Tables Winter 2024-25 (Holdover Time Guidelines)</div>
                <div>14 CFR §121.629 · §125.221 · §135.227 · §91.527</div>
                <div>ICAO Doc 9640 Aircraft Ground De/Anti-Icing · Annex 6</div>
                <div>SAE AMS1424 Type I · AMS1428 Type II/III/IV</div>
                <div>SAE ARP4737 Methods · ARP5485 Endurance Time Tests</div>
                <div>ISO 11075/11076/11077/11078 fluid specifications</div>
                <div>EASA AMC1 CAT.OP.MPA.250 · TC AC 700-027 (Canada)</div>
                <div>NTSB AAR-93-02 USAir 405 LGA · AAR-83-02 Air Florida 90 DCA · TSB A05Q0157</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
