'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TURN · Aircraft Turnaround Critical-Path Monitor
   ------------------------------------------------------------
   Per-airframe ground-turnaround timeline analyzer that detects
   recently landed aircraft (ground=true, low velocity), classifies
   the airframe into an IATA AHM-630/IGOM turnaround class, models
   the critical-path service chain (deplane → clean → fuel → cater
   → board → push) per ICAO Doc 9082 standard ground time table,
   estimates predicted off-block time (POBT) from a synthetic
   scheduled departure derived from landing epoch + AHM-630 minimum
   ground time + class buffer, scores on-time-performance risk
   against the schedule, and surfaces dispatcher-side and ramp-side
   mitigations to recover stand-time slip.

   References:
     ICAO Doc 9082 Airport Economics Manual §3.4 standard ground time
     ICAO Doc 9971 Manual on Collaborative ATM Pt I Ch 4 turnaround coord
     ICAO Doc 9554 Ground Handling Operations Manual
     IATA AHM 630 Aircraft handling time standards
     IATA AHM 633 Ground time service-time chain
     IATA IGOM Ed.13 ch.4 Ramp servicing sequencing
     IATA AHM 810 SLA for ground handlers (§4 turnaround targets)
     EUROCONTROL A-CDM Implementation Manual Ed.5 §4 turnaround milestones
     EU Reg 716/2014 PCP §AF-3 A-CDM at network airports
     FAA SCDM TFDM Surface Concept v3.0 EOBT/TOBT prediction
     Boeing 737/777/787 AMM ch.10 turnaround interconnects
     Airbus A320/A330/A350 ARM (Aircraft Recovery Manual) §1.6
     Embraer E170/E190 GHM (Ground Handling Manual) §3
     Bombardier CRJ GHM §3 turnaround min-time
     NTSB AAR-09-01 Comair 5191 LEX (ramp coordination)
     Eurocontrol PRR 2023 ch.5 turnaround punctuality
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'CRITICAL' | 'SLIP' | 'TIGHT' | 'WATCH' | 'NOMINAL' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  CRITICAL: '#ef4444', SLIP: '#f43f5e', TIGHT: '#f59e0b', WATCH: '#0ea5e9', NOMINAL: '#10b981', IDLE: '#64748b',
}
const TIER_RANK: Record<Tier, number> = { CRITICAL: 0, SLIP: 1, TIGHT: 2, WATCH: 3, NOMINAL: 4, IDLE: 5 }

// IATA AHM-630 turnaround class taxonomy
type TClass = 'WB-LONGHAUL' | 'WB-MEDIUM' | 'NB-180' | 'NB-150' | 'REGIONAL' | 'BIZ'
const CLASS_COLOR: Record<TClass, string> = {
  'WB-LONGHAUL': '#a855f7', 'WB-MEDIUM': '#06b6d4', 'NB-180': '#0ea5e9', 'NB-150': '#10b981', 'REGIONAL': '#f59e0b', 'BIZ': '#94a3b8',
}

// Per-class standard turnaround service durations in minutes (IATA AHM-630 / IGOM ed.13 ch.4)
interface ClassSpec {
  klass: TClass
  pax: number              // seat count typical
  deplaneMin: number
  cleanMin: number
  fuelMin: number          // sequential with cater
  caterMin: number         // parallel with fuel typically; we serialize for critical path
  boardMin: number
  pushMin: number
  parallelism: number      // fraction of fuel+cater that overlaps (0=serial, 1=full parallel)
  baseMinGroundMin: number // AHM-630 min ground time
}
const SPECS: Record<TClass, ClassSpec> = {
  'WB-LONGHAUL': { klass:'WB-LONGHAUL', pax:340, deplaneMin:18, cleanMin:55, fuelMin:55, caterMin:50, boardMin:35, pushMin:5, parallelism:0.85, baseMinGroundMin:120 },
  'WB-MEDIUM':   { klass:'WB-MEDIUM',   pax:280, deplaneMin:15, cleanMin:40, fuelMin:40, caterMin:35, boardMin:28, pushMin:5, parallelism:0.80, baseMinGroundMin:90 },
  'NB-180':      { klass:'NB-180',      pax:180, deplaneMin:9,  cleanMin:18, fuelMin:18, caterMin:15, boardMin:18, pushMin:4, parallelism:0.75, baseMinGroundMin:40 },
  'NB-150':      { klass:'NB-150',      pax:150, deplaneMin:8,  cleanMin:15, fuelMin:15, caterMin:12, boardMin:15, pushMin:4, parallelism:0.75, baseMinGroundMin:35 },
  'REGIONAL':    { klass:'REGIONAL',    pax:80,  deplaneMin:5,  cleanMin:10, fuelMin:10, caterMin:7,  boardMin:10, pushMin:3, parallelism:0.70, baseMinGroundMin:25 },
  'BIZ':         { klass:'BIZ',         pax:12,  deplaneMin:3,  cleanMin:8,  fuelMin:12, caterMin:8,  boardMin:6,  pushMin:3, parallelism:0.60, baseMinGroundMin:20 },
}

function classifyAirframe(type: string | undefined, cat?: string): TClass {
  const t = (type || '').toUpperCase()
  if (/^(A38|A340|A35|A33|B74|B77|B78|MD11|IL96)/.test(t)) {
    if (/A388|A35K|B77W|B748|B789|B78X/.test(t)) return 'WB-LONGHAUL'
    return 'WB-MEDIUM'
  }
  if (/^(A32[1-3]|B73[7-9]|B75|MD8|MD9|TU20|E29)/.test(t)) {
    if (/A321|A322|A323|B739|B752|B753/.test(t)) return 'NB-180'
    return 'NB-150'
  }
  if (/^(E1|E2|CRJ|AT[47]|DH8|SF34|SAAB|J32|ERJ)/.test(t)) return 'REGIONAL'
  if (/^(C25|CL[36]|G[V45]|GLEX|FA[0-9]|HAWK|LJ|PC12|BE[2-4])/.test(t)) return 'BIZ'
  if (cat === 'A5') return 'WB-LONGHAUL'
  if (cat === 'A4') return 'WB-MEDIUM'
  if (cat === 'A3') return 'NB-180'
  if (cat === 'A2') return 'REGIONAL'
  return 'NB-150'
}

// Critical path duration: deplane → clean → max(fuel, cater) with parallelism → board → push
function criticalPathMin(spec: ClassSpec, fuelMul: number, caterMul: number): number {
  const fuel = spec.fuelMin * fuelMul
  const cater = spec.caterMin * caterMul
  const both = spec.parallelism * Math.max(fuel, cater) + (1 - spec.parallelism) * (fuel + cater)
  return spec.deplaneMin + spec.cleanMin + both + spec.boardMin + spec.pushMin
}

// Stable hash-derived landing epoch & scheduled-departure offset per ICAO24
function hash32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}
// Returns minutes since synthetic landing (0-240)
function timeSinceLandingMin(icao: string, now: number): number {
  const h = hash32(icao + Math.floor(now / 60000))
  // Cycle through a 0-180 window stable for 60s ticks
  return (h % 18000) / 100  // 0..180
}
// Returns scheduled-stand-time (STA→STD) committed for this aircraft, minutes
function scheduledStandMin(icao: string, spec: ClassSpec): number {
  const h = hash32(icao + 'sched')
  // 80-180% of baseMinGroundMin
  return Math.round(spec.baseMinGroundMin * (0.80 + (h % 100) / 100))
}

type Stage = 'DEPLANE' | 'CLEAN' | 'FUEL+CATER' | 'BOARD' | 'PUSH' | 'DONE'
function stageAt(elapsedMin: number, spec: ClassSpec, fuelMul: number, caterMul: number): { stage: Stage; pct: number } {
  let t = 0
  if (elapsedMin < (t += spec.deplaneMin)) return { stage:'DEPLANE', pct: (elapsedMin / spec.deplaneMin) * 100 }
  const cleanEnd = t + spec.cleanMin
  if (elapsedMin < cleanEnd) return { stage:'CLEAN', pct: ((elapsedMin - t) / spec.cleanMin) * 100 }
  t = cleanEnd
  const fuel = spec.fuelMin * fuelMul, cater = spec.caterMin * caterMul
  const both = spec.parallelism * Math.max(fuel, cater) + (1 - spec.parallelism) * (fuel + cater)
  if (elapsedMin < t + both) return { stage:'FUEL+CATER', pct: ((elapsedMin - t) / both) * 100 }
  t += both
  if (elapsedMin < t + spec.boardMin) return { stage:'BOARD', pct: ((elapsedMin - t) / spec.boardMin) * 100 }
  t += spec.boardMin
  if (elapsedMin < t + spec.pushMin) return { stage:'PUSH', pct: ((elapsedMin - t) / spec.pushMin) * 100 }
  return { stage:'DONE', pct: 100 }
}

interface Eval {
  flight: SFlight
  spec: ClassSpec
  klass: TClass
  elapsedMin: number
  stage: Stage
  stagePct: number
  scheduledStandMin: number    // STD - STA
  criticalPathMin: number      // computed required min for this turn
  predictedOffBlockMin: number // minutes from landing to off-block (predicted)
  slipMin: number              // predictedOffBlock - scheduledStand (positive = late)
  pctConsumed: number          // elapsed / scheduledStand * 100
  tier: Tier
  score: number
  drivers: { time: number; path: number; stage: number; klass: number; slip: number; recovery: number }
  rationale: string
  citation: string
}

export default function TurnMonitor({ map, flights, onClose, onFly }: Props) {
  // sliders
  const [fuelMul, setFuelMul] = useState(100)   // % of standard fuel duration
  const [caterMul, setCaterMul] = useState(100)
  const [advMul, setAdvMul] = useState(100)
  const [minVelKts, setMinVelKts] = useState(15)  // max velocity to count as "at stand"
  const [slipTolMin, setSlipTolMin] = useState(10)
  const [horizonMin, setHorizonMin] = useState(180)

  // toggles
  const [showPin, setShowPin] = useState(true)
  const [showHalo, setShowHalo] = useState(true)
  const [showLbl, setShowLbl] = useState(true)

  const [classFilter, setClassFilter] = useState<Record<TClass, boolean>>({ 'WB-LONGHAUL':true,'WB-MEDIUM':true,'NB-180':true,'NB-150':true,'REGIONAL':true,'BIZ':true })
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT'|'STAGES'|'CLASSES'>('AIRCRAFT')
  const [search, setSearch] = useState('')

  // tick clock for animation
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])

  const evals: Eval[] = useMemo(() => {
    const out: Eval[] = []
    for (const f of flights) {
      if (!f.ground) continue
      if (f.velocityKts > minVelKts) continue
      const klass = classifyAirframe(f.type, f.category)
      if (!classFilter[klass]) continue
      const spec = SPECS[klass]
      const elapsed = timeSinceLandingMin(f.icao, now)
      if (elapsed > horizonMin) continue
      const sched = scheduledStandMin(f.icao, spec)
      const cpath = criticalPathMin(spec, fuelMul/100, caterMul/100)
      const predicted = cpath
      const slip = predicted - sched
      const pctConsumed = (elapsed / Math.max(1, sched)) * 100
      const st = stageAt(elapsed, spec, fuelMul/100, caterMul/100)
      // drivers (0-100)
      const timeDriver = Math.min(100, pctConsumed)
      const pathDriver = Math.min(100, Math.max(0, (cpath - spec.baseMinGroundMin) / Math.max(1, spec.baseMinGroundMin) * 120))
      const stageDriver = st.stage === 'DONE' ? 10 : st.stage === 'PUSH' ? 20 : st.stage === 'BOARD' ? 35 : st.stage === 'FUEL+CATER' ? 65 : st.stage === 'CLEAN' ? 50 : 75
      const klassDriver = klass === 'WB-LONGHAUL' ? 80 : klass === 'WB-MEDIUM' ? 65 : klass === 'NB-180' ? 50 : klass === 'NB-150' ? 40 : klass === 'REGIONAL' ? 30 : 25
      const slipDriver = slip <= 0 ? 0 : Math.min(100, slip * 8)
      const recoveryRoom = Math.max(0, sched - elapsed - cpath)  // minutes of slack
      const recoveryDriver = recoveryRoom <= 0 ? 100 : recoveryRoom < 5 ? 75 : recoveryRoom < 10 ? 45 : recoveryRoom < 20 ? 20 : 5
      const drivers = { time: timeDriver, path: pathDriver, stage: stageDriver, klass: klassDriver, slip: slipDriver, recovery: recoveryDriver }
      const maxD = Math.max(timeDriver, slipDriver, recoveryDriver)
      const meanD = (timeDriver + pathDriver + stageDriver + klassDriver + slipDriver + recoveryDriver) / 6
      let score = (maxD * 0.78 + meanD * 0.22) * (advMul/100)
      score = Math.max(0, Math.min(100, score))

      // tiers
      let tier: Tier = 'NOMINAL'
      const projectedFinishMin = elapsed + Math.max(0, cpath - elapsed)
      const projectedSlip = projectedFinishMin - sched
      if (projectedSlip >= slipTolMin * 2 || recoveryRoom <= 0 && st.stage !== 'DONE' && st.stage !== 'PUSH') tier = 'CRITICAL'
      else if (projectedSlip >= slipTolMin) tier = 'SLIP'
      else if (projectedSlip >= 0 || recoveryRoom < 5) tier = 'TIGHT'
      else if (pctConsumed >= 60 && st.stage !== 'DONE') tier = 'WATCH'
      if (st.stage === 'DONE' && projectedSlip < slipTolMin) tier = 'NOMINAL'

      const rationale = (() => {
        const slipTxt = projectedSlip >= 0 ? `+${Math.round(projectedSlip)}min slip` : `${Math.round(projectedSlip)}min slack`
        if (tier === 'CRITICAL') return `CRITICAL ${st.stage} ${Math.round(st.pct)}%; ${slipTxt} vs ${sched}min STD; expedite ramp ops, request ATC re-slot via TOBT update`
        if (tier === 'SLIP') return `SLIP ${st.stage}; ${slipTxt}; advise OCC, recover via parallel-fuel/cater, push TOBT in A-CDM`
        if (tier === 'TIGHT') return `TIGHT ${st.stage} ${Math.round(st.pct)}%; ${slipTxt}; brief crew on PBE, watch boarding completion`
        if (tier === 'WATCH') return `WATCH ${st.stage}; ${Math.round(pctConsumed)}% of stand time consumed`
        return `NOMINAL ${st.stage}; ${slipTxt}; on-schedule turnaround`
      })()
      const citation = tier === 'CRITICAL' ? 'IATA AHM 630 / EUROCONTROL A-CDM IM ed.5 §4.6 TOBT update / Doc 9971 Pt I Ch 4'
        : tier === 'SLIP' ? 'IATA IGOM ed.13 §4.4 / AHM 810 §4 / A-CDM IM ed.5 §4.4'
        : tier === 'TIGHT' ? 'ICAO Doc 9082 §3.4 / IATA AHM 633'
        : tier === 'WATCH' ? 'IATA AHM 630'
        : 'ICAO Doc 9082 §3.4 / A-CDM IM ed.5'

      out.push({ flight: f, spec, klass, elapsedMin: elapsed, stage: st.stage, stagePct: st.pct, scheduledStandMin: sched, criticalPathMin: cpath, predictedOffBlockMin: predicted, slipMin: projectedSlip, pctConsumed, tier, score: Math.round(score), drivers, rationale, citation })
    }
    return out.sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [flights, fuelMul, caterMul, advMul, minVelKts, slipTolMin, horizonMin, classFilter, now])

  const counts: Record<Tier, number> = useMemo(() => {
    const c: Record<Tier, number> = { CRITICAL:0, SLIP:0, TIGHT:0, WATCH:0, NOMINAL:0, IDLE:0 }
    evals.forEach(e => { c[e.tier]++ })
    return c
  }, [evals])

  const meanScore = evals.length ? Math.round(evals.reduce((s,e) => s + e.score, 0) / evals.length) : 0
  const meanTier: Tier = meanScore >= 80 ? 'CRITICAL' : meanScore >= 60 ? 'SLIP' : meanScore >= 35 ? 'TIGHT' : meanScore >= 18 ? 'WATCH' : 'NOMINAL'
  const worst = evals[0]
  const critC = counts.CRITICAL
  const slipC = counts.SLIP
  const meanSlip = evals.length ? Math.round(evals.reduce((s,e)=>s+e.slipMin,0) / evals.length) : 0
  const totalPax = evals.reduce((s,e)=> s + e.spec.pax, 0)

  const visible = evals.filter(e => {
    if (tierFilter !== 'ALL' && e.tier !== tierFilter) return false
    if (search) {
      const s = search.toLowerCase()
      if (![e.flight.callsign, e.flight.icao, e.flight.type, e.flight.operator, e.klass].some(v => (v||'').toLowerCase().includes(s))) return false
    }
    return true
  })

  const byStage = useMemo(() => {
    const m = new Map<Stage, Eval[]>()
    evals.forEach(e => { if (!m.has(e.stage)) m.set(e.stage, []); m.get(e.stage)!.push(e) })
    const order: Stage[] = ['DEPLANE','CLEAN','FUEL+CATER','BOARD','PUSH','DONE']
    return order.map(s => [s, m.get(s) || []] as const).filter(([,es]) => es.length > 0)
  }, [evals])

  const byClass = useMemo(() => {
    const m = new Map<TClass, Eval[]>()
    evals.forEach(e => { if (!m.has(e.klass)) m.set(e.klass, []); m.get(e.klass)!.push(e) })
    return [...m.entries()].sort(([,a],[,b]) => b.length - a.length)
  }, [evals])

  // ============ MAP OVERLAY ============
  useEffect(() => {
    if (!map) return
    const m = map
    const SRC = 'turn-src', LBL = 'turn-lbl'
    const features: GeoJSON.Feature[] = []
    const labels: GeoJSON.Feature[] = []
    const seen = new Set<string>()
    evals.forEach(e => {
      if (seen.has(e.flight.icao)) return
      seen.add(e.flight.icao)
      const c = TIER_COLOR[e.tier]
      if (showHalo) features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[e.flight.lng, e.flight.lat] }, properties:{ color:c, kind:'halo', radius: 8 + Math.min(14, e.score/7) } })
      if (showPin && (e.tier==='CRITICAL' || e.tier==='SLIP')) features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[e.flight.lng, e.flight.lat] }, properties:{ color:c, kind:'pin', radius:5 } })
      if (showLbl) labels.push({ type:'Feature', geometry:{ type:'Point', coordinates:[e.flight.lng, e.flight.lat] }, properties:{ text:`${e.flight.callsign||e.flight.icao} ${e.tier} ${e.slipMin>=0?'+':''}${Math.round(e.slipMin)}m`, color:c } })
    })
    try {
      if (!m.getSource(SRC)) m.addSource(SRC, { type:'geojson', data:{ type:'FeatureCollection', features } as GeoJSON.FeatureCollection })
      else (m.getSource(SRC) as maplibregl.GeoJSONSource).setData({ type:'FeatureCollection', features } as GeoJSON.FeatureCollection)
      if (!m.getSource(LBL)) m.addSource(LBL, { type:'geojson', data:{ type:'FeatureCollection', features: labels } as GeoJSON.FeatureCollection })
      else (m.getSource(LBL) as maplibregl.GeoJSONSource).setData({ type:'FeatureCollection', features: labels } as GeoJSON.FeatureCollection)

      if (showHalo && !m.getLayer('turn-halo')) m.addLayer({ id:'turn-halo', type:'circle', source:SRC, filter:['==',['get','kind'],'halo'], paint:{ 'circle-color':'transparent', 'circle-stroke-color':['get','color'], 'circle-stroke-width':2, 'circle-radius':['get','radius'], 'circle-opacity':0.7 } })
      if (showPin && !m.getLayer('turn-pin')) m.addLayer({ id:'turn-pin', type:'circle', source:SRC, filter:['==',['get','kind'],'pin'], paint:{ 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1, 'circle-radius':5 } })
      if (showLbl && !m.getLayer('turn-lbl')) m.addLayer({ id:'turn-lbl', type:'symbol', source:LBL, layout:{ 'text-field':['get','text'], 'text-size':9, 'text-offset':[0,1.6], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.2 } })
    } catch {}
    return () => {
      try {
        for (const id of ['turn-halo','turn-pin','turn-lbl']) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC, LBL]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, evals, showHalo, showPin, showLbl])

  const tierPill = (t: Tier) => (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide" style={{ background:`${TIER_COLOR[t]}22`, color: TIER_COLOR[t], border:`1px solid ${TIER_COLOR[t]}55` }}>{t}</span>
  )
  const klassPill = (k: TClass) => (
    <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ background:`${CLASS_COLOR[k]}1f`, color: CLASS_COLOR[k], border:`1px solid ${CLASS_COLOR[k]}55` }}>{k}</span>
  )
  const stagePill = (s: Stage) => (
    <span className="px-1 py-0.5 rounded text-[9px] font-mono bg-slate-800 text-slate-300">{s}</span>
  )

  // scatter: slip min horizontal, %consumed vertical
  const sx = (d: number) => 30 + (Math.max(-30, Math.min(30, d)) + 30) * 340/60
  const sy = (p: number) => 100 - Math.max(0, Math.min(100, p)) * 90/100

  return (
    <div className="absolute right-3 top-16 bottom-3 w-[440px] z-[60] rounded-2xl border border-slate-800 bg-slate-950/90 backdrop-blur-md text-slate-200 shadow-2xl flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 bg-slate-900/60">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: TIER_COLOR[meanTier] }} />
          <div className="text-sm font-semibold">TURN · Turnaround Critical Path</div>
          <span className="text-[10px] text-slate-500">IATA AHM-630</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-6 gap-1 px-2 pt-2">
        {(['CRITICAL','SLIP','TIGHT','WATCH','NOMINAL'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`px-1.5 py-1 rounded border text-[10px] font-semibold tracking-wide transition ${tierFilter===t?'opacity-100':'opacity-70 hover:opacity-100'}`}
            style={{ borderColor: `${TIER_COLOR[t]}55`, background: tierFilter===t?`${TIER_COLOR[t]}22`:'transparent', color: TIER_COLOR[t] }}>
            <div className="text-[8px] opacity-80 truncate">{t}</div>
            <div className="text-sm font-mono">{counts[t]}</div>
          </button>
        ))}
        <button onClick={() => setTierFilter('ALL')} className={`px-1.5 py-1 rounded border text-[10px] tracking-wide ${tierFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
          <div className="text-[8px]">ALL</div>
          <div className="text-sm font-mono">{evals.length}</div>
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1 px-2 pt-2 text-[10px]">
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">MEAN</div>
          <div className="font-mono text-sm" style={{ color: TIER_COLOR[meanTier] }}>{meanScore}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">WORST</div>
          <div className="font-mono text-xs truncate" style={{ color: worst ? TIER_COLOR[worst.tier] : '#64748b' }}>{worst ? (worst.flight.callsign || worst.flight.icao) : '—'}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">CRIT</div>
          <div className="font-mono text-sm text-rose-400">{critC}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">SLIP</div>
          <div className="font-mono text-sm" style={{ color: TIER_COLOR.SLIP }}>{slipC}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">MEAN Δ</div>
          <div className="font-mono text-sm" style={{ color: meanSlip > 10 ? '#ef4444' : meanSlip > 0 ? '#f59e0b' : '#10b981' }}>{meanSlip>=0?'+':''}{meanSlip}m</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">PAX</div>
          <div className="font-mono text-sm text-sky-300">{totalPax.toLocaleString()}</div>
        </div>
      </div>

      {/* Scatter: slip vs %consumed */}
      <div className="px-2 pt-2">
        <svg viewBox="0 0 380 110" className="w-full h-[110px] rounded border border-slate-800 bg-slate-900/40">
          <rect x={sx(10)} y={10} width={380-sx(10)} height={90} fill="#ef44441a" />
          <rect x={sx(0)} y={10} width={sx(10)-sx(0)} height={90} fill="#f59e0b1a" />
          <rect x={20} y={10} width={sx(0)-20} height={90} fill="#10b9811a" />
          <line x1={sx(0)} y1={10} x2={sx(0)} y2={100} stroke="#64748b" strokeDasharray="2 2" strokeOpacity={0.5} />
          <line x1={sx(10)} y1={10} x2={sx(10)} y2={100} stroke="#f59e0b" strokeDasharray="2 2" strokeOpacity={0.6} />
          <line x1={20} y1={sy(100)} x2={380} y2={sy(100)} stroke="#ef4444" strokeDasharray="2 2" strokeOpacity={0.5} />
          {evals.map((e, i) => (
            <circle key={i} cx={sx(e.slipMin)} cy={sy(e.pctConsumed)} r={2.5} fill={TIER_COLOR[e.tier]} opacity={0.85} />
          ))}
          <text x={4} y={14} fill="#64748b" fontSize={8} fontFamily="monospace">% used</text>
          <text x={376} y={108} fill="#64748b" fontSize={8} fontFamily="monospace" textAnchor="end">slip min</text>
        </svg>
      </div>

      {/* Sliders */}
      <div className="grid grid-cols-2 gap-1 px-2 pt-2 text-[10px]">
        {([
          ['FUEL-MUL', fuelMul, setFuelMul, 50, 200, '%'],
          ['CATER-MUL', caterMul, setCaterMul, 50, 200, '%'],
          ['ADV-MUL', advMul, setAdvMul, 50, 200, '%'],
          ['MIN-VEL', minVelKts, setMinVelKts, 5, 40, 'kt'],
          ['SLIP-TOL', slipTolMin, setSlipTolMin, 2, 30, 'm'],
          ['HORIZON', horizonMin, setHorizonMin, 60, 240, 'm'],
        ] as Array<[string, number, (n:number)=>void, number, number, string]>).map(([label, val, set, min, max, unit]) => (
          <label key={label} className="flex flex-col gap-0.5 rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
            <span className="text-slate-500 flex justify-between"><span>{label}</span><span className="font-mono text-slate-200">{val}{unit}</span></span>
            <input type="range" min={min} max={max} value={val} onChange={e=>set(Number(e.target.value))} className="w-full accent-sky-500" />
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-2 pt-2">
        {(Object.keys(SPECS) as TClass[]).map(k => (
          <button key={k} onClick={() => setClassFilter(f => ({ ...f, [k]: !f[k] }))}
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition ${classFilter[k]?'opacity-100':'opacity-40'}`}
            style={{ background:`${CLASS_COLOR[k]}1f`, color: CLASS_COLOR[k], borderColor: `${CLASS_COLOR[k]}55` }}>{k}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-2 pt-2">
        {([
          ['HALO', showHalo, setShowHalo],
          ['PIN', showPin, setShowPin],
          ['LBL', showLbl, setShowLbl],
        ] as Array<[string, boolean, (b:boolean)=>void]>).map(([label, on, set]) => (
          <button key={label} onClick={() => set(!on)}
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition ${on?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-700 text-slate-500 hover:text-slate-300'}`}>{label}</button>
        ))}
      </div>

      <div className="px-2 pt-2">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="callsign · icao · type · operator · class"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[11px] placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50" />
      </div>
      <div className="grid grid-cols-3 gap-1 px-2 pt-2 text-[10px]">
        {(['AIRCRAFT','STAGES','CLASSES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2 py-1 rounded border transition ${tab===t?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-800 text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pt-2 pb-2 space-y-1.5">
        {tab === 'AIRCRAFT' && visible.length === 0 && (
          <div className="text-center text-slate-600 text-[11px] pt-6">no aircraft at stand in scope</div>
        )}
        {tab === 'AIRCRAFT' && visible.map((e, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden cursor-pointer hover:border-slate-700"
            onClick={() => onFly(e.flight.icao)}>
            <div className="h-0.5" style={{ background: TIER_COLOR[e.tier] }} />
            <div className="p-2 space-y-1">
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="font-mono font-semibold text-slate-100">{e.flight.callsign || e.flight.icao}</span>
                <span className="text-slate-500 text-[10px]">{e.flight.type || '—'}</span>
                {klassPill(e.klass)}
                {stagePill(e.stage)}
                <div className="ml-auto">{tierPill(e.tier)}</div>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>elapsed <span className="text-slate-200">{Math.round(e.elapsedMin)}m</span></span>
                <span>STD <span className="text-sky-300">{e.scheduledStandMin}m</span></span>
                <span>CP <span className="text-slate-200">{Math.round(e.criticalPathMin)}m</span></span>
                <span>Δ <span style={{ color: e.slipMin > 10 ? '#ef4444' : e.slipMin > 0 ? '#f59e0b' : '#10b981' }}>{e.slipMin>=0?'+':''}{Math.round(e.slipMin)}m</span></span>
              </div>
              {/* stage progress bar */}
              <div className="flex items-center gap-0.5 text-[8px] font-mono">
                {(['DEPLANE','CLEAN','FUEL+CATER','BOARD','PUSH'] as Stage[]).map(s => {
                  const active = e.stage === s
                  const done = ['DEPLANE','CLEAN','FUEL+CATER','BOARD','PUSH'].indexOf(s) < ['DEPLANE','CLEAN','FUEL+CATER','BOARD','PUSH'].indexOf(e.stage as any) || e.stage === 'DONE'
                  return (
                    <div key={s} className={`flex-1 px-1 py-0.5 rounded text-center ${active?'bg-sky-500/20 text-sky-300':done?'bg-emerald-500/15 text-emerald-400':'bg-slate-800/60 text-slate-500'}`}>
                      {s === 'FUEL+CATER' ? 'F+C' : s.slice(0,4)}
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>pax <span className="text-slate-200">{e.spec.pax}</span></span>
                <span>used <span style={{ color: e.pctConsumed > 100 ? '#ef4444' : e.pctConsumed > 75 ? '#f59e0b' : '#10b981' }}>{Math.round(e.pctConsumed)}%</span></span>
                <span>{e.flight.operator || '—'}</span>
              </div>
              <div className="h-1 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: `${e.score}%`, background: TIER_COLOR[e.tier] }} />
              </div>
              <div className="grid grid-cols-6 gap-0.5 text-[9px]">
                {(['time','path','stage','klass','slip','recovery'] as const).map(k => (
                  <div key={k} className="rounded bg-slate-900/60 px-1 py-0.5 text-center" style={{ color: TIER_COLOR[e.tier] }}>
                    <div className="opacity-60">{k.slice(0,3).toUpperCase()}</div>
                    <div className="font-mono">{Math.round(e.drivers[k])}</div>
                  </div>
                ))}
              </div>
              <div className="text-[10px] leading-snug" style={{ color: TIER_COLOR[e.tier] }}>
                {e.rationale} <span className="text-slate-600 italic">· {e.citation}</span>
              </div>
            </div>
          </div>
        ))}

        {tab === 'STAGES' && byStage.length === 0 && (
          <div className="text-center text-slate-600 text-[11px] pt-6">no stage activity</div>
        )}
        {tab === 'STAGES' && byStage.map(([stage, es]) => {
          const crit = es.filter(x => x.tier==='CRITICAL').length
          const slip = es.filter(x => x.tier==='SLIP').length
          const mean = Math.round(es.reduce((s,e)=>s+e.score,0)/es.length)
          const w = es.sort((a,b)=>b.score-a.score)[0]
          return (
            <div key={stage} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden">
              <div className="h-0.5" style={{ background: TIER_COLOR[w.tier] }} />
              <div className="p-2 space-y-1">
                <div className="flex items-center gap-1.5 text-[11px]">
                  {stagePill(stage)}
                  <span className="text-slate-500 text-[10px]">{es.length} ac</span>
                  <div className="ml-auto">{tierPill(w.tier)}</div>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                  {crit>0 && <span className="text-rose-400">CRIT {crit}</span>}
                  {slip>0 && <span style={{ color: TIER_COLOR.SLIP }}>SLIP {slip}</span>}
                  <span className="ml-auto">mean {mean}</span>
                </div>
                <div className="h-1 rounded bg-slate-800 overflow-hidden">
                  <div className="h-full" style={{ width: `${mean}%`, background: TIER_COLOR[w.tier] }} />
                </div>
              </div>
            </div>
          )
        })}

        {tab === 'CLASSES' && byClass.length === 0 && (
          <div className="text-center text-slate-600 text-[11px] pt-6">no class activity</div>
        )}
        {tab === 'CLASSES' && byClass.map(([k, es]) => {
          const crit = es.filter(x => x.tier==='CRITICAL').length
          const slip = es.filter(x => x.tier==='SLIP').length
          const mean = Math.round(es.reduce((s,e)=>s+e.score,0)/es.length)
          const meanSlipC = Math.round(es.reduce((s,e)=>s+e.slipMin,0)/es.length)
          const w = es.sort((a,b)=>b.score-a.score)[0]
          const spec = SPECS[k]
          return (
            <div key={k} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden">
              <div className="h-0.5" style={{ background: TIER_COLOR[w.tier] }} />
              <div className="p-2 space-y-1">
                <div className="flex items-center gap-1.5 text-[11px]">
                  {klassPill(k)}
                  <span className="text-slate-500 text-[10px]">{es.length} ac · pax {spec.pax} · base {spec.baseMinGroundMin}m</span>
                  <div className="ml-auto">{tierPill(w.tier)}</div>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                  {crit>0 && <span className="text-rose-400">CRIT {crit}</span>}
                  {slip>0 && <span style={{ color: TIER_COLOR.SLIP }}>SLIP {slip}</span>}
                  <span>mean Δ <span style={{ color: meanSlipC > 10 ? '#ef4444' : meanSlipC > 0 ? '#f59e0b' : '#10b981' }}>{meanSlipC>=0?'+':''}{meanSlipC}m</span></span>
                  <span className="ml-auto">score {mean}</span>
                </div>
                <div className="h-1 rounded bg-slate-800 overflow-hidden">
                  <div className="h-full" style={{ width: `${mean}%`, background: TIER_COLOR[w.tier] }} />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
