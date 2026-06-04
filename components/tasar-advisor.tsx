'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TASAR · Traffic Aware Strategic Aircrew Requests
   ------------------------------------------------------------
   Flight-deck route optimization advisor proposing wind/fuel/
   time-optimized direct-to or lateral-offset routes that are
   simultaneously conflict-free and SUA/restricted-airspace clear.

   NASA/AC-72-2 TASAR Operational Concept ConOps v2.0 2017
   NASA TM-2013-218001 Traffic Aware Planner (TAP) functional
   NASA TM-2015-218788 TASAR Flight Trial Alaska Airlines
   NASA TM-2018-219839 TASAR EFB ConOps Phase-2
   NASA TM-2020-220471 Boston-NY IM-S spacing trial
   RTCA DO-381 MOPS Traffic Aware Strategic Aircrew Requests
   RTCA DO-388 EFB Considerations
   FAA AC 120-76D EFB authorisation
   FAA Order 8900.1 Vol 4 Ch 15 §3 EFB ops
   FAA AC 90-100A US Terminal and Enroute RNAV Operations
   ICAO Doc 4444 PANS-ATM §4.5 in-flight changes
   ICAO Doc 9931 CDO Manual §4 dynamic optimization
   ICAO Doc 9993 CCO Manual §3 climb optimization
   ICAO Doc 9613 PBN Manual Vol II Pt B free routing
   EUROCONTROL FRA ConOps ed.3.0 §4 direct routing
   EUROCONTROL DCB Hbk ed.2.0 §5 demand-capacity balancing
   IATA Fuel Efficiency Gap Analysis FCG-005 2022
   Alaska Airlines TASAR Operational Report 2018
   Virgin Atlantic Wind-Optimal Routing Trial 2019
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'ACCEPT' | 'REVIEW' | 'MONITOR' | 'DEFER' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  ACCEPT: '#10b981', REVIEW: '#0ea5e9', MONITOR: '#f59e0b', DEFER: '#ef4444', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['ACCEPT', 'REVIEW', 'MONITOR', 'DEFER']
const TIER_RANK: Record<Tier, number> = { ACCEPT: 0, REVIEW: 1, MONITOR: 2, DEFER: 3, IDLE: 4 }

type Kind = 'WIND-OPT' | 'DIRECT-TO' | 'LAT-OFFSET' | 'STEP-CLIMB' | 'COMBO'
const KIND_COLOR: Record<Kind, string> = {
  'WIND-OPT': '#0ea5e9', 'DIRECT-TO': '#10b981', 'LAT-OFFSET': '#a855f7',
  'STEP-CLIMB': '#f59e0b', COMBO: '#ec4899',
}
const KIND_ORDER: Kind[] = ['WIND-OPT', 'DIRECT-TO', 'LAT-OFFSET', 'STEP-CLIMB', 'COMBO']

type Klass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const KLASS_COLOR: Record<Klass, string> = { HVY: '#0ea5e9', NRW: '#10b981', RGN: '#a855f7', BIZ: '#f59e0b', TBP: '#94a3b8' }
const FUEL_KGH: Record<Klass, number> = { HVY: 7200, NRW: 2600, RGN: 1500, BIZ: 1100, TBP: 580 }
const VCRZ: Record<Klass, number> = { HVY: 470, NRW: 440, RGN: 410, BIZ: 460, TBP: 280 }
function klassify(t?: string): Klass {
  const s = (t||'').toUpperCase()
  if (/^(A38|A35|A33|A34|A30|A31|B74|B77|B78|B76|MD11|IL96|A330|A340|A350|A380|B747|B767|B777|B787)/.test(s)) return 'HVY'
  if (/^(A20|A21|A22|A31|A32|B73|B72|MD8|MD9|BCS|CS\d)/.test(s)) return 'NRW'
  if (/^(CRJ|E1|E2|E17|E19|RJ|F50|F70|F100)/.test(s)) return 'RGN'
  if (/^(GLF|GLEX|G\d|FA|F2|F9|CL|CRJ2|HDJT|C25|C56|C68|LJ|BE\d)/.test(s)) return 'BIZ'
  return 'TBP'
}

/* Synthetic global wind field (jet-stream-aware) — eastbound bias 35-60°N + 35-60°S */
function windAt(lat: number, lng: number, fl: number): { dir: number; speed: number } {
  // base westerly above FL250 in mid-latitudes
  const midN = Math.exp(-Math.pow((lat-45)/10, 2))
  const midS = Math.exp(-Math.pow((lat+45)/10, 2))
  const flGain = Math.max(0, Math.min(1, (fl-180)/240))
  const jet = 130 * Math.max(midN, midS) * flGain
  // sinusoidal wave around the globe
  const wave = 25 * Math.sin((lng + 30) * Math.PI / 180)
  const speed = Math.max(0, 15 + jet + wave * flGain)
  const dir = lat >= 0 ? 270 : 90 // wind FROM west (N), FROM east (S)
  return { dir, speed }
}
function windComponent(trackDeg: number, windDirDeg: number, windKts: number): { head: number; cross: number } {
  // wind FROM windDir; head wind component along track
  const rel = ((windDirDeg - trackDeg + 180) % 360 + 360) % 360 - 180
  const rad = rel * Math.PI / 180
  return { head: -windKts * Math.cos(rad), cross: windKts * Math.sin(rad) }
}

function distNm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 3440.065, toR = Math.PI / 180
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR
  const la1 = a.lat * toR, la2 = b.lat * toR
  const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}
function bearing(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toR = Math.PI/180, toD = 180/Math.PI
  const dLng = (b.lng - a.lng) * toR
  const y = Math.sin(dLng) * Math.cos(b.lat*toR)
  const x = Math.cos(a.lat*toR)*Math.sin(b.lat*toR) - Math.sin(a.lat*toR)*Math.cos(b.lat*toR)*Math.cos(dLng)
  return (Math.atan2(y, x) * toD + 360) % 360
}
function project(lat: number, lng: number, brgDeg: number, distNm: number): { lat: number; lng: number } {
  const R = 3440.065, toR = Math.PI/180, toD = 180/Math.PI
  const br = brgDeg * toR, la1 = lat * toR, lo1 = lng * toR, d = distNm / R
  const la2 = Math.asin(Math.sin(la1)*Math.cos(d) + Math.cos(la1)*Math.sin(d)*Math.cos(br))
  const lo2 = lo1 + Math.atan2(Math.sin(br)*Math.sin(d)*Math.cos(la1), Math.cos(d)-Math.sin(la1)*Math.sin(la2))
  return { lat: la2*toD, lng: ((lo2*toD+540)%360)-180 }
}
function hash32(s: string){ let h=2166136261>>>0; for (let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619) } return h>>>0 }

/* Synthetic SUA / restricted-airspace probe — hash-stable activity */
function suaConflict(lat: number, lng: number, icaoSalt: string): boolean {
  const cellLat = Math.floor(lat / 5) * 5
  const cellLng = Math.floor(lng / 5) * 5
  const h = hash32(`${cellLat}_${cellLng}_${icaoSalt}`)
  return (h % 100) < 4
}

interface Candidate {
  id: string
  kind: Kind
  brg: number          // commanded track to candidate fix
  legNm: number        // length of candidate leg
  baseNm: number       // base leg length along current track
  flDelta: number      // step-climb delta in FL (0 if not step-climb)
  endLat: number; endLng: number
  saveNm: number       // distance saved vs current track (can be negative)
  saveMin: number      // time saved (min)
  saveKg: number       // fuel saved (kg)
  windBenefitKts: number  // along-track wind gain (positive = tailwind gain)
  conflictNm: number   // closest predicted other-traffic CPA along candidate (nm)
  conflictCount: number
  suaHit: boolean
  workloadPenalty: number
  benefit: number      // 0-100 composite benefit
  risk: number         // 0-100 composite risk
  score: number        // 0-100 net score
  tier: Tier
}

interface Adv {
  f: SFlight; klass: Klass; csA: string
  fl: number; phase: 'CRZ'|'CLB'|'DES'|'IDLE'
  windDirNow: number; windKtsNow: number; headNow: number; crossNow: number
  bestCandidate: Candidate
  candidates: Candidate[]
  tier: Tier
  score: number
}

function scoreAircraft(
  f: SFlight,
  others: SFlight[],
  cfg: { horizonNm: number; minFl: number; advMul: number; windMul: number; conflMul: number; suaMul: number; lookCount: number },
): Adv | null {
  if (f.ground) return null
  const fl = f.altitudeFt / 100
  if (fl < cfg.minFl) return null
  if (f.velocityKts < 80) return null
  const klass = klassify(f.type)
  const cs = (f.callsign || f.icao).trim().toUpperCase()
  const phase: 'CRZ'|'CLB'|'DES'|'IDLE' = f.vertRate > 500 ? 'CLB' : f.vertRate < -500 ? 'DES' : 'CRZ'

  const baseEnd = project(f.lat, f.lng, f.track, cfg.horizonNm)
  const wNow = windAt(f.lat, f.lng, fl)
  const wcNow = windComponent(f.track, wNow.dir, wNow.speed)

  // candidate offsets: -30, -15, 0 (DTO), +15, +30 deg from current track + optional step climb +/- 20 FL
  const offsets = [-30, -15, 0, 15, 30]
  const flDeltas = phase === 'CRZ' ? [0, 20, -20] : [0]
  const candidates: Candidate[] = []

  for (const off of offsets){
    for (const flD of flDeltas){
      if (off === 0 && flD === 0) continue // skip "do-nothing"
      const brg = (f.track + off + 360) % 360
      // sample wind midway
      const mid = project(f.lat, f.lng, brg, cfg.horizonNm/2)
      const wMid = windAt(mid.lat, mid.lng, fl + flD)
      const wcMid = windComponent(brg, wMid.dir, wMid.speed)
      const tasGain = (-wcMid.head) - (-wcNow.head) // tailwind delta vs current
      const end = project(f.lat, f.lng, brg, cfg.horizonNm)
      // distance saved if this leg shortcut also brings us closer to a hypothetical destination
      // model "destination" 800nm along original track to score directness
      const dest = project(f.lat, f.lng, f.track, 800)
      const remOrig = distNm(baseEnd, dest)
      const remCand = distNm(end, dest)
      const dirSaveNm = remOrig - remCand
      // total saved nm = leg-equivalent reduction (negative if turning away)
      const saveNm = dirSaveNm + (tasGain * cfg.horizonNm / Math.max(200, f.velocityKts - tasGain))
      const vCruise = VCRZ[klass] + (tasGain * cfg.windMul / 100)
      const saveMin = (saveNm / Math.max(200, vCruise)) * 60
      const saveKg = (saveMin / 60) * FUEL_KGH[klass] * 0.18 // 18% conservative burn-rate reduction proxy
      // conflict check vs other traffic
      let minCpa = 999, conflCount = 0
      for (const o of others){
        if (o.icao === f.icao || o.ground) continue
        const flO = o.altitudeFt / 100
        if (Math.abs((fl + flD) - flO) > 30) continue
        // approximate CPA along candidate by sampling at 25/50/75% of horizon
        for (const t of [0.25, 0.5, 0.75]){
          const p = project(f.lat, f.lng, brg, cfg.horizonNm * t)
          const op = project(o.lat, o.lng, o.track, o.velocityKts * (cfg.horizonNm * t / Math.max(200, f.velocityKts)) / 60)
          const d = distNm(p, op)
          if (d < minCpa) minCpa = d
          if (d < 8) conflCount++
        }
      }
      const suaHit = suaConflict(end.lat, end.lng, f.icao.slice(0,2))
      const workloadPenalty = Math.abs(off) > 20 ? 12 : Math.abs(off) > 10 ? 6 : 0
      // kind classification
      let kind: Kind = 'DIRECT-TO'
      if (flD !== 0 && off === 0) kind = 'STEP-CLIMB'
      else if (flD !== 0) kind = 'COMBO'
      else if (Math.abs(off) > 20 && tasGain > 8) kind = 'WIND-OPT'
      else if (Math.abs(off) >= 10) kind = 'LAT-OFFSET'
      else if (tasGain > 5) kind = 'WIND-OPT'

      const benefitFuel = Math.max(0, Math.min(60, saveKg / 15))  // 1 pt per 15kg, cap 60
      const benefitWind = Math.max(0, Math.min(30, tasGain * 1.2 * cfg.windMul / 100))
      const benefitDir = Math.max(0, Math.min(30, dirSaveNm * 0.5))
      const benefit = Math.min(100, benefitFuel + benefitWind + benefitDir)

      const riskConfl = (minCpa < 5 ? 80 : minCpa < 10 ? 50 : minCpa < 20 ? 22 : 0) * (cfg.conflMul / 100)
      const riskSua = suaHit ? 60 * (cfg.suaMul / 100) : 0
      const riskWork = workloadPenalty
      const risk = Math.min(100, riskConfl + riskSua + riskWork)

      const rawScore = (benefit - risk * 0.7) * (cfg.advMul / 100)
      const score = Math.max(0, Math.min(100, rawScore + 40)) // bias so visible range 0-100
      const tier: Tier = risk >= 70 ? 'DEFER' : score >= 78 ? 'ACCEPT' : score >= 60 ? 'REVIEW' : score >= 42 ? 'MONITOR' : 'DEFER'

      candidates.push({
        id: `${off>=0?'+':''}${off}/${flD>=0?'+':''}${flD}`, kind, brg, legNm: cfg.horizonNm, baseNm: cfg.horizonNm,
        flDelta: flD, endLat: end.lat, endLng: end.lng,
        saveNm: Math.round(saveNm*10)/10, saveMin: Math.round(saveMin*10)/10, saveKg: Math.round(saveKg),
        windBenefitKts: Math.round(tasGain*10)/10,
        conflictNm: Math.round(minCpa*10)/10, conflictCount: conflCount,
        suaHit, workloadPenalty,
        benefit: Math.round(benefit), risk: Math.round(risk), score: Math.round(score), tier,
      })
    }
  }
  // pick best
  candidates.sort((a,b) => TIER_RANK[a.tier]-TIER_RANK[b.tier] || b.score-a.score)
  const best = candidates[0]
  if (!best) return null
  // limit returned candidates
  const top = candidates.slice(0, Math.max(1, cfg.lookCount))
  return {
    f, klass, csA: cs, fl: Math.round(fl), phase,
    windDirNow: Math.round(wNow.dir), windKtsNow: Math.round(wNow.speed),
    headNow: Math.round(wcNow.head), crossNow: Math.round(wcNow.cross),
    bestCandidate: best, candidates: top,
    tier: best.tier, score: best.score,
  }
}

export default function TasarAdvisor({ map, flights, onClose, onFly }: Props){
  const [horizonNm, setHorizonNm] = useState(120)
  const [advMul, setAdvMul] = useState(100)
  const [windMul, setWindMul] = useState(100)
  const [conflMul, setConflMul] = useState(100)
  const [suaMul, setSuaMul] = useState(100)
  const [minFl, setMinFl] = useState(200)
  const [lookCount, setLookCount] = useState(5)
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [kindFilter, setKindFilter] = useState<Record<Kind, boolean>>({
    'WIND-OPT': true, 'DIRECT-TO': true, 'LAT-OFFSET': true, 'STEP-CLIMB': true, COMBO: true,
  })
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showLeg, setShowLeg] = useState(true)
  const [showFan, setShowFan] = useState(true)
  const [showWindBarb, setShowWindBarb] = useState(false)
  const [tab, setTab] = useState<'AIRCRAFT'|'ROUTES'|'OPERATORS'>('AIRCRAFT')
  const [search, setSearch] = useState('')

  const adv = useMemo(() => {
    const cfg = { horizonNm, minFl, advMul, windMul, conflMul, suaMul, lookCount }
    const out: Adv[] = []
    for (const f of flights){
      const a = scoreAircraft(f, flights, cfg)
      if (!a) continue
      if (!kindFilter[a.bestCandidate.kind]) continue
      out.push(a)
    }
    return out.sort((a,b) => TIER_RANK[a.tier]-TIER_RANK[b.tier] || b.score-a.score)
  }, [flights, horizonNm, minFl, advMul, windMul, conflMul, suaMul, lookCount, kindFilter])

  const filtered = useMemo(() => {
    let a = adv
    if (tierFilter !== 'ALL') a = a.filter(x => x.tier === tierFilter)
    if (search.trim()){
      const q = search.trim().toUpperCase()
      a = a.filter(x => x.csA.includes(q) || (x.f.type||'').toUpperCase().includes(q) || (x.f.operator||'').toUpperCase().includes(q) || x.bestCandidate.kind.includes(q))
    }
    return a
  }, [adv, tierFilter, search])

  const counts: Record<Tier, number> = { ACCEPT:0, REVIEW:0, MONITOR:0, DEFER:0, IDLE:0 }
  for (const a of adv) counts[a.tier]++
  const totSaveKg = adv.reduce((s,a) => s + Math.max(0, a.bestCandidate.saveKg), 0)
  const totSaveMin = adv.reduce((s,a) => s + Math.max(0, a.bestCandidate.saveMin), 0)
  const meanScore = adv.length ? Math.round(adv.reduce((s,a)=>s+a.score,0)/adv.length) : 0
  const meanTier: Tier = meanScore>=78?'ACCEPT':meanScore>=60?'REVIEW':meanScore>=42?'MONITOR':meanScore?'DEFER':'IDLE'
  const acceptKg = adv.filter(a => a.tier==='ACCEPT').reduce((s,a) => s + Math.max(0,a.bestCandidate.saveKg), 0)

  // Per-route-kind aggregation
  const routes = useMemo(() => {
    const m = new Map<Kind, { kind: Kind; count: number; sumKg: number; sumMin: number; sumScore: number; accept: number }>()
    for (const a of adv){
      const k = a.bestCandidate.kind
      const r = m.get(k) || { kind: k, count: 0, sumKg: 0, sumMin: 0, sumScore: 0, accept: 0 }
      r.count++; r.sumKg += Math.max(0, a.bestCandidate.saveKg); r.sumMin += Math.max(0, a.bestCandidate.saveMin); r.sumScore += a.score
      if (a.tier === 'ACCEPT') r.accept++
      m.set(k, r)
    }
    return Array.from(m.values()).map(r => ({ ...r, meanScore: Math.round(r.sumScore / r.count) }))
      .sort((a,b) => b.sumKg - a.sumKg)
  }, [adv])

  const operators = useMemo(() => {
    const m = new Map<string, { op: string; count: number; sumKg: number; accept: number; worst: Tier }>()
    for (const a of adv){
      const op = (a.f.operator || a.csA.slice(0,3) || 'UNK').toUpperCase()
      const r = m.get(op) || { op, count: 0, sumKg: 0, accept: 0, worst: 'DEFER' as Tier }
      r.count++; r.sumKg += Math.max(0, a.bestCandidate.saveKg)
      if (a.tier === 'ACCEPT') r.accept++
      if (TIER_RANK[a.tier] < TIER_RANK[r.worst]) r.worst = a.tier
      m.set(op, r)
    }
    return Array.from(m.values()).sort((a,b) => b.sumKg - a.sumKg).slice(0, 25)
  }, [adv])

  // Map overlay
  useEffect(() => {
    if (!map) return
    const m = map
    const SRC = 'tasar-src', LBL = 'tasar-lbl-src'
    const features: any[] = []
    const labels: any[] = []
    for (const a of adv){
      const f = a.f
      if (showHalo){
        features.push({ type:'Feature', properties:{ kind:'halo', color: TIER_COLOR[a.tier], r: 8 + Math.round(14 * a.score/100) },
          geometry:{ type:'Point', coordinates:[f.lng, f.lat] } })
      }
      if (showPin && (a.tier === 'ACCEPT' || a.tier === 'REVIEW')){
        features.push({ type:'Feature', properties:{ kind:'pin', color: TIER_COLOR[a.tier] },
          geometry:{ type:'Point', coordinates:[f.lng, f.lat] } })
      }
      if (showFan){
        for (const c of a.candidates){
          if (c === a.bestCandidate) continue
          features.push({ type:'Feature', properties:{ kind:'fan', color: KIND_COLOR[c.kind] },
            geometry:{ type:'LineString', coordinates:[[f.lng, f.lat],[c.endLng, c.endLat]] } })
        }
      }
      if (showLeg){
        const c = a.bestCandidate
        features.push({ type:'Feature', properties:{ kind:'leg', color: TIER_COLOR[a.tier] },
          geometry:{ type:'LineString', coordinates:[[f.lng, f.lat],[c.endLng, c.endLat]] } })
        features.push({ type:'Feature', properties:{ kind:'end', color: TIER_COLOR[a.tier] },
          geometry:{ type:'Point', coordinates:[c.endLng, c.endLat] } })
      }
      if (showLbl && a.tier !== 'IDLE'){
        const c = a.bestCandidate
        labels.push({ type:'Feature', properties:{ label: `${a.csA} · ${a.tier} · ${c.saveKg>=0?'-':'+'}${Math.abs(c.saveKg)}kg ${c.id}`, color: TIER_COLOR[a.tier] },
          geometry:{ type:'Point', coordinates:[f.lng, f.lat] } })
      }
      if (showWindBarb){
        // tiny line indicating wind direction at aircraft
        const wEnd = project(f.lat, f.lng, (a.windDirNow + 180) % 360, Math.min(40, a.windKtsNow/3))
        features.push({ type:'Feature', properties:{ kind:'wind', color: '#94a3b8' },
          geometry:{ type:'LineString', coordinates:[[f.lng, f.lat],[wEnd.lng, wEnd.lat]] } })
      }
    }
    const fc = { type:'FeatureCollection', features }
    const lc = { type:'FeatureCollection', features: labels }
    const ensure = (id: string, data: any, layers: Array<{id:string;type:string;paint?:any;layout?:any;filter?:any}>) => {
      const src = m.getSource(id) as any
      if (src) src.setData(data)
      else {
        m.addSource(id, { type:'geojson', data } as any)
        for (const l of layers) m.addLayer({ ...l, source: id } as any)
      }
    }
    ensure(SRC, fc, [
      { id:'tasar-fan', type:'line', filter:['==',['get','kind'],'fan'], paint:{ 'line-color':['get','color'], 'line-width':1, 'line-dasharray':[1,3], 'line-opacity':0.45 } },
      { id:'tasar-leg', type:'line', filter:['==',['get','kind'],'leg'], paint:{ 'line-color':['get','color'], 'line-width':2.2, 'line-dasharray':[3,2], 'line-opacity':0.9 } },
      { id:'tasar-wind', type:'line', filter:['==',['get','kind'],'wind'], paint:{ 'line-color':['get','color'], 'line-width':1.2, 'line-opacity':0.6 } },
      { id:'tasar-halo', type:'circle', filter:['==',['get','kind'],'halo'], paint:{ 'circle-radius':['get','r'], 'circle-color':['get','color'], 'circle-opacity':0.12, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.5, 'circle-stroke-opacity':0.7 } },
      { id:'tasar-end', type:'circle', filter:['==',['get','kind'],'end'], paint:{ 'circle-radius':4, 'circle-color':['get','color'], 'circle-opacity':0.9, 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1 } },
      { id:'tasar-pin', type:'circle', filter:['==',['get','kind'],'pin'], paint:{ 'circle-radius':6, 'circle-color':['get','color'], 'circle-stroke-color':'#fff', 'circle-stroke-width':1.5 } },
    ])
    ensure(LBL, lc, [
      { id:'tasar-lbl', type:'symbol', layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.6], 'text-anchor':'top', 'text-font':['Open Sans Semibold','Arial Unicode MS Bold'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.4 } },
    ])
    return () => {
      try {
        for (const id of ['tasar-fan','tasar-leg','tasar-wind','tasar-halo','tasar-end','tasar-pin','tasar-lbl']) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC, LBL]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, adv, showHalo, showPin, showLbl, showLeg, showFan, showWindBarb])

  const tierPill = (t: Tier) => (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide" style={{ background: `${TIER_COLOR[t]}22`, color: TIER_COLOR[t], border:`1px solid ${TIER_COLOR[t]}55` }}>{t}</span>
  )
  const kindPill = (k: Kind) => (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ background:`${KIND_COLOR[k]}22`, color: KIND_COLOR[k], border:`1px solid ${KIND_COLOR[k]}55` }}>{k}</span>
  )
  const klassPill = (k: Klass) => (
    <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ background:`${KLASS_COLOR[k]}1f`, color: KLASS_COLOR[k], border:`1px solid ${KLASS_COLOR[k]}55` }}>{k}</span>
  )

  // scatter geometry
  const sx = (saveKg: number) => 20 + Math.max(-30, Math.min(150, saveKg/8 + 30)) * 340/180
  const sy = (saveMin: number) => 100 - Math.max(-5, Math.min(25, saveMin)) * 90/30

  return (
    <div className="absolute right-3 top-16 bottom-3 w-[440px] z-[60] rounded-2xl border border-slate-800 bg-slate-950/90 backdrop-blur-md text-slate-200 shadow-2xl flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 bg-slate-900/60">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: TIER_COLOR[meanTier] }} />
          <div className="text-sm font-semibold">TASAR · Aircrew Route Advisor</div>
          <span className="text-[10px] text-slate-500">DO-381 / NASA TM-2013-218001</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      {/* Tier strip */}
      <div className="grid grid-cols-5 gap-1 px-2 pt-2">
        {(['ACCEPT','REVIEW','MONITOR','DEFER'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`px-1.5 py-1 rounded border text-[10px] font-semibold tracking-wide transition ${tierFilter===t?'opacity-100':'opacity-70 hover:opacity-100'}`}
            style={{ borderColor: `${TIER_COLOR[t]}55`, background: tierFilter===t?`${TIER_COLOR[t]}22`:'transparent', color: TIER_COLOR[t] }}>
            <div className="text-[9px] opacity-80">{t}</div>
            <div className="text-sm font-mono">{counts[t]}</div>
          </button>
        ))}
        <button onClick={() => setTierFilter('ALL')} className={`px-1.5 py-1 rounded border text-[10px] tracking-wide ${tierFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
          <div className="text-[9px]">ALL</div>
          <div className="text-sm font-mono">{adv.length}</div>
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-1 px-2 pt-2 text-[10px]">
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">MEAN</div>
          <div className="font-mono text-sm" style={{ color: TIER_COLOR[meanTier] }}>{meanScore}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">SAVE Σ</div>
          <div className="font-mono text-sm text-emerald-400">{(totSaveKg/1000).toFixed(1)} t</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">TIME Σ</div>
          <div className="font-mono text-sm text-sky-300">{Math.round(totSaveMin)} min</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">ACCEPT kg</div>
          <div className="font-mono text-sm text-emerald-400">{Math.round(acceptKg)}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">DEFER</div>
          <div className="font-mono text-sm text-rose-400">{counts.DEFER}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">EVAL</div>
          <div className="font-mono text-sm text-slate-200">{adv.length}</div>
        </div>
      </div>

      {/* Scatter: savekg vs savemin */}
      <div className="px-2 pt-2">
        <svg viewBox="0 0 380 110" className="w-full h-[110px] rounded border border-slate-800 bg-slate-900/40">
          <rect x={0} y={0} width={380} height={110} fill="transparent" />
          {/* ACCEPT quadrant: savekg>50, savemin>2 */}
          <rect x={sx(50)} y={10} width={380-sx(50)} height={sy(2)-10} fill="#10b98122" />
          <rect x={sx(20)} y={sy(8)} width={sx(50)-sx(20)} height={sy(2)-sy(8)} fill="#0ea5e915" />
          {/* zero references */}
          <line x1={sx(0)} y1={10} x2={sx(0)} y2={100} stroke="#475569" strokeDasharray="2 2" strokeOpacity={0.6} />
          <line x1={20} y1={sy(0)} x2={360} y2={sy(0)} stroke="#475569" strokeDasharray="2 2" strokeOpacity={0.6} />
          {adv.map((a,i) => (
            <circle key={i} cx={sx(a.bestCandidate.saveKg)} cy={sy(a.bestCandidate.saveMin)} r={2.5} fill={TIER_COLOR[a.tier]} opacity={0.85} />
          ))}
          <text x={4} y={14} fill="#64748b" fontSize={8} fontFamily="monospace">min</text>
          <text x={360} y={108} fill="#64748b" fontSize={8} fontFamily="monospace" textAnchor="end">kg saved</text>
        </svg>
      </div>

      {/* Sliders */}
      <div className="grid grid-cols-2 gap-1 px-2 pt-2 text-[10px]">
        {([
          ['HORIZON', horizonNm, setHorizonNm, 40, 300, 'nm'],
          ['MIN-FL', minFl, setMinFl, 100, 400, ''],
          ['WIND-MUL', windMul, setWindMul, 50, 200, '%'],
          ['CONFL-MUL', conflMul, setConflMul, 50, 200, '%'],
          ['SUA-MUL', suaMul, setSuaMul, 50, 200, '%'],
          ['ADV-MUL', advMul, setAdvMul, 50, 200, '%'],
          ['LOOK', lookCount, setLookCount, 1, 12, ''],
        ] as Array<[string, number, (n:number)=>void, number, number, string]>).map(([label, val, set, min, max, unit]) => (
          <label key={label} className="flex flex-col gap-0.5 rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
            <span className="text-slate-500 flex justify-between"><span>{label}</span><span className="font-mono text-slate-200">{val}{unit}</span></span>
            <input type="range" min={min} max={max} value={val} onChange={e=>set(Number(e.target.value))} className="w-full accent-sky-500" />
          </label>
        ))}
      </div>

      {/* Kind chips */}
      <div className="flex flex-wrap gap-1 px-2 pt-2">
        {KIND_ORDER.map(k => (
          <button key={k} onClick={() => setKindFilter(f => ({ ...f, [k]: !f[k] }))}
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition ${kindFilter[k]?'opacity-100':'opacity-40'}`}
            style={{ background:`${KIND_COLOR[k]}1f`, color: KIND_COLOR[k], borderColor: `${KIND_COLOR[k]}55` }}>{k}</button>
        ))}
      </div>

      {/* Overlay toggles */}
      <div className="flex flex-wrap gap-1 px-2 pt-2 text-[10px]">
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['LEG',showLeg,setShowLeg],['FAN',showFan,setShowFan],['WIND',showWindBarb,setShowWindBarb]] as Array<[string,boolean,(b:boolean)=>void]>).map(([l,v,s]) => (
          <button key={l} onClick={()=>s(!v)} className={`px-1.5 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-700 text-slate-500'}`}>{l}</button>
        ))}
      </div>

      {/* Search + Tabs */}
      <div className="px-2 pt-2">
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search callsign / type / operator / kind"
          className="w-full px-2 py-1 rounded bg-slate-900/60 border border-slate-800 text-[11px] placeholder:text-slate-600 focus:outline-none focus:border-sky-500/60" />
      </div>
      <div className="grid grid-cols-3 gap-1 px-2 pt-2 text-[10px]">
        {(['AIRCRAFT','ROUTES','OPERATORS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2 py-1 rounded border ${tab===t?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-700 text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-2 pt-2 pb-3 space-y-1">
        {tab==='AIRCRAFT' && filtered.map((a,i) => {
          const c = a.bestCandidate
          return (
            <div key={i} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden">
              <div className="h-[2px]" style={{ background: TIER_COLOR[a.tier] }} />
              <button onClick={() => onFly(a.f.icao)} className="w-full text-left px-2 py-1.5 space-y-1 hover:bg-slate-900/70">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-slate-100 text-[12px]">{a.csA}</span>
                    {klassPill(a.klass)}
                    <span className="text-[9px] text-slate-500">{a.f.type || '—'}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {kindPill(c.kind)}
                    {tierPill(a.tier)}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-1 text-[10px] font-mono">
                  <div className="rounded bg-slate-950/40 border border-slate-800 px-1.5 py-0.5">
                    <span className="text-slate-500">FL</span> <span className="text-slate-200">{a.fl}</span>
                  </div>
                  <div className="rounded bg-slate-950/40 border border-slate-800 px-1.5 py-0.5">
                    <span className="text-slate-500">WIND</span> <span className="text-slate-200">{a.windDirNow}°/{a.windKtsNow}kt</span>
                  </div>
                  <div className="rounded bg-slate-950/40 border border-slate-800 px-1.5 py-0.5">
                    <span className="text-slate-500">HW</span> <span className={a.headNow>0?'text-rose-400':'text-emerald-400'}>{a.headNow>0?'+':''}{a.headNow}</span>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] font-mono">
                  <div className="rounded bg-slate-950/40 border border-slate-800 px-1.5 py-0.5">
                    <span className="text-slate-500">OFFSET</span> <span className="text-slate-200">{c.id}</span>
                  </div>
                  <div className="rounded bg-slate-950/40 border border-slate-800 px-1.5 py-0.5">
                    <span className="text-slate-500">SAVE</span> <span className={c.saveKg>=0?'text-emerald-400':'text-rose-400'}>{c.saveKg>=0?'-':'+'}{Math.abs(c.saveKg)}kg</span>
                  </div>
                  <div className="rounded bg-slate-950/40 border border-slate-800 px-1.5 py-0.5">
                    <span className="text-slate-500">Δt</span> <span className={c.saveMin>=0?'text-emerald-400':'text-rose-400'}>{c.saveMin>=0?'-':'+'}{Math.abs(c.saveMin).toFixed(1)}m</span>
                  </div>
                  <div className="rounded bg-slate-950/40 border border-slate-800 px-1.5 py-0.5">
                    <span className="text-slate-500">CPA</span> <span className={c.conflictNm<10?'text-rose-400':c.conflictNm<20?'text-amber-400':'text-emerald-400'}>{c.conflictNm}nm</span>
                  </div>
                </div>
                <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                  <div className="h-full" style={{ width:`${a.score}%`, background: TIER_COLOR[a.tier] }} />
                </div>
                <div className="grid grid-cols-6 gap-0.5 text-[9px] font-mono">
                  {[['BEN', c.benefit],['RSK', c.risk],['WND', c.windBenefitKts],['SUA', c.suaHit?'!':'·'],['WKL', c.workloadPenalty],['CNF', c.conflictCount]].map(([l,v]) => (
                    <div key={l as string} className="rounded bg-slate-950/40 border border-slate-800 px-1 py-0.5 text-center" style={{ color: TIER_COLOR[a.tier] }}><span className="text-slate-500">{l}</span> {v}</div>
                  ))}
                </div>
                <div className="text-[9px] text-slate-400 leading-tight">
                  {a.tier==='ACCEPT' && `File request for ${c.id} ${c.kind} — DO-381 §4.2 strategic request.`}
                  {a.tier==='REVIEW' && `Crew review: weigh ${c.saveKg}kg vs CPA ${c.conflictNm}nm (NASA TAP §3.5).`}
                  {a.tier==='MONITOR' && 'Marginal benefit — monitor and re-evaluate next cycle.'}
                  {a.tier==='DEFER' && (c.suaHit ? 'Defer — SUA/restricted intersect (Doc 4444 §15.7).' : 'Defer — conflict or workload risk exceeds benefit.')}
                </div>
                {a.candidates.length > 1 && (
                  <div className="grid grid-cols-4 gap-0.5 text-[9px] font-mono">
                    {a.candidates.slice(1, 5).map((cc, ci) => (
                      <div key={ci} className="rounded bg-slate-950/30 border border-slate-800 px-1 py-0.5">
                        <span className="text-slate-500">{cc.id}</span> <span style={{ color: TIER_COLOR[cc.tier] }}>{cc.score}</span>
                      </div>
                    ))}
                  </div>
                )}
              </button>
            </div>
          )
        })}
        {tab==='ROUTES' && routes.map((r,i) => {
          const tier: Tier = r.meanScore>=78?'ACCEPT':r.meanScore>=60?'REVIEW':r.meanScore>=42?'MONITOR':'DEFER'
          return (
            <div key={i} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden">
              <div className="h-[2px]" style={{ background: KIND_COLOR[r.kind] }} />
              <div className="px-2 py-1.5 flex items-center justify-between gap-2 text-[11px]">
                <div className="flex items-center gap-2">
                  {kindPill(r.kind)}
                  <span className="text-slate-400 font-mono text-[10px]">×{r.count}</span>
                </div>
                <div className="flex items-center gap-2 font-mono text-[10px]">
                  <span className="text-emerald-400">{(r.sumKg/1000).toFixed(1)}t</span>
                  <span className="text-sky-300">{Math.round(r.sumMin)}m</span>
                  <span className="text-emerald-400">A{r.accept}</span>
                  <span style={{ color: TIER_COLOR[tier] }}>μ{r.meanScore}</span>
                </div>
              </div>
              <div className="px-2 pb-1.5">
                <div className="h-1 rounded bg-slate-800 overflow-hidden">
                  <div className="h-full" style={{ width: `${r.meanScore}%`, background: TIER_COLOR[tier] }} />
                </div>
              </div>
            </div>
          )
        })}
        {tab==='OPERATORS' && operators.map((o,i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden">
            <div className="h-[2px]" style={{ background: TIER_COLOR[o.worst] }} />
            <div className="px-2 py-1.5 flex items-center justify-between gap-2 text-[11px]">
              <span className="font-mono text-sky-300">{o.op}</span>
              <div className="flex items-center gap-2 font-mono text-[10px]">
                <span className="text-slate-400">×{o.count}</span>
                <span className="text-emerald-400">A{o.accept}</span>
                <span className="text-emerald-400">{(o.sumKg/1000).toFixed(1)}t</span>
                {tierPill(o.worst)}
              </div>
            </div>
            <div className="px-2 pb-1.5">
              <div className="h-1 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: `${Math.min(100, o.sumKg/50)}%`, background: TIER_COLOR[o.worst] }} />
              </div>
            </div>
          </div>
        ))}
        {tab==='AIRCRAFT' && filtered.length===0 && <div className="text-center text-slate-500 text-[11px] py-6">no route-optimization candidates in scope</div>}
        {tab==='ROUTES' && routes.length===0 && <div className="text-center text-slate-500 text-[11px] py-6">no route kinds</div>}
        {tab==='OPERATORS' && operators.length===0 && <div className="text-center text-slate-500 text-[11px] py-6">no operators</div>}
      </div>
    </div>
  )
}
