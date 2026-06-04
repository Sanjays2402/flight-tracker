'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   CCM · Callsign Confusion Monitor
   ------------------------------------------------------------
   ICAO Doc 9870 Manual on Prevention of Runway Incursions ch.5
   ICAO Doc 4444 PANS-ATM §12.3 callsign confusion (§12.3.4.6)
   ICAO Annex 10 Vol II §5.2.1.7 callsign use on RTF
   EUROCONTROL Action Plan for Air-Ground Communications Safety
     §6 Similar Call-Sign Tool (SCST) 2018-12
   FAA Order JO 7110.65 §2-4-20 aircraft identification
   FAA AC 90-117 §8 datalink callsign uniqueness
   UK CAA CAP 745 §6 callsign hygiene
   NTSB AAR-95-05 American 1572 BDL (callsign-similarity precursor)
   IFALPA Position Paper 18POS09 Callsign-Similarity

   Live pairwise detector for same-airline confusable callsigns.
   For every pair of airborne aircraft sharing an ICAO 3-letter
   airline prefix in the same FIR macro-bucket, score the pair
   across 6 risk drivers (similarity, proximity, FL overlap,
   phase coupling, airport coupling, synthetic shared-frequency
   probability) and produce one of 5 advisory tiers.
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'COLLISION' | 'HIGH' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  COLLISION: '#ef4444', HIGH: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['COLLISION', 'HIGH', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { COLLISION: 0, HIGH: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Kind = 'DIGIT-SWAP' | 'SINGLE-DIGIT' | 'TWO-DIGIT' | 'PHONETIC' | 'PREFIX-COL'
const KIND_COLOR: Record<Kind, string> = {
  'DIGIT-SWAP': '#ef4444', 'SINGLE-DIGIT': '#f59e0b', 'TWO-DIGIT': '#fb923c',
  PHONETIC: '#a855f7', 'PREFIX-COL': '#0ea5e9',
}
const KIND_ORDER: Kind[] = ['DIGIT-SWAP', 'SINGLE-DIGIT', 'TWO-DIGIT', 'PHONETIC', 'PREFIX-COL']

const KNOWN_PREFIXES = new Set([
  'AAL','UAL','DAL','SWA','ASA','JBU','ACA','FFT','NKS','BAW','VIR','AFR','DLH','KLM','EZY','RYR','WZZ',
  'IBE','AZA','SAS','FIN','LOT','UAE','QTR','ETD','THY','ELY','SIA','CPA','ANA','JAL','KAL','CES','CCA',
  'QFA','ANZ','TAM','LAN','ETH','SAA',
])

type Bucket = 'NAS-E'|'NAS-W'|'NAS-AK'|'CAN'|'OCE-NAT'|'OCE-PAC'|'EUR-N'|'EUR-S'|'ASIA-N'|'ASIA-S'|'MEA'|'AFR'|'LAM'
function fir(lat: number, lng: number): Bucket {
  if (lat > 50 && lng < -130) return 'NAS-AK'
  if (lat > 49 && lng > -141 && lng < -52) return 'CAN'
  if (lat >= 24 && lat <= 49 && lng >= -100 && lng <= -66) return 'NAS-E'
  if (lat >= 24 && lat <= 49 && lng > -141 && lng < -100) return 'NAS-W'
  if (lng <= -30 && lng >= -70 && lat >= 30 && lat <= 60) return 'OCE-NAT'
  if (lng <= -130 || lng >= 140) return 'OCE-PAC'
  if (lat >= 50 && lng >= -15 && lng <= 40) return 'EUR-N'
  if (lat >= 30 && lat < 50 && lng >= -15 && lng <= 40) return 'EUR-S'
  if (lat >= 30 && lng > 40 && lng <= 90) return 'MEA'
  if (lat >= 30 && lng > 90) return 'ASIA-N'
  if (lat < 30 && lat >= -10 && lng > 60) return 'ASIA-S'
  if (lat < 30 && lng >= -20 && lng < 60) return 'AFR'
  return 'LAM'
}

const SOUND: Record<string,string> = { '0':'z','1':'w','2':'t','3':'h','4':'f','5':'v','6':'x','7':'s','8':'e','9':'n' }
function phon(s: string){ return s.split('').map(c=>SOUND[c]||c).join('') }

function lev(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length, n = b.length
  if (!m) return n; if (!n) return m
  const d = new Array(n+1)
  for (let j=0;j<=n;j++) d[j]=j
  for (let i=1;i<=m;i++){
    let prev = d[0]; d[0]=i
    for (let j=1;j<=n;j++){
      const t = d[j]
      d[j] = a[i-1]===b[j-1] ? prev : Math.min(prev,d[j],d[j-1])+1
      prev = t
    }
  }
  return d[n]
}

function classify(a: string, b: string): { kind: Kind; sim: number } {
  if (a === b) return { kind: 'PREFIX-COL', sim: 100 }
  const la=a.length, lb=b.length
  // adjacent transposition
  if (la===lb){
    let diffs = 0, swapAt = -1
    for (let i=0;i<la;i++) if (a[i]!==b[i]){ diffs++; if(swapAt<0) swapAt=i }
    if (diffs===2 && swapAt>=0 && a[swapAt]===b[swapAt+1] && a[swapAt+1]===b[swapAt])
      return { kind: 'DIGIT-SWAP', sim: 95 }
    if (diffs===1) return { kind: 'SINGLE-DIGIT', sim: 80 }
    if (diffs===2) return { kind: 'TWO-DIGIT', sim: 65 }
  }
  if (phon(a)===phon(b)) return { kind: 'PHONETIC', sim: 70 }
  const d = lev(a,b)
  const sim = Math.max(0, Math.round(100*(1 - d/Math.max(la,lb))))
  return { kind: 'PREFIX-COL', sim: Math.max(20, Math.min(70, sim)) }
}

function distNm(a: SFlight, b: SFlight){
  const R=3440.065, toR=Math.PI/180
  const dLat=(b.lat-a.lat)*toR, dLng=(b.lng-a.lng)*toR
  const la1=a.lat*toR, la2=b.lat*toR
  const h=Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2
  return 2*R*Math.asin(Math.min(1,Math.sqrt(h)))
}

function phase(f: SFlight){
  const fl = f.altitudeFt/100
  if (f.ground) return 'IDLE'
  if (fl<100 && f.vertRate<-300) return 'TERM'
  if (fl<100 && f.vertRate>300) return 'CLB'
  if (f.vertRate<-200) return 'DES'
  return 'CRZ'
}
const PHASE_MUL: Record<string,number> = { TERM: 1.30, DES: 1.15, CLB: 1.10, CRZ: 1.00, IDLE: 0 }

function hash32(s: string){ let h=2166136261>>>0; for (let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619) } return h>>>0 }

interface Pair {
  a: SFlight; b: SFlight
  prefix: string; bucket: Bucket; kind: Kind; sim: number
  dist: number; deltaFl: number; flOverlap: number
  phaseA: string; phaseB: string; phaseMul: number; aptMul: number
  apt: number; frq: number; prx: number; flo: number; pha: number
  score: number; tier: Tier
  csA: string; csB: string
}

function scorePair(a: SFlight, b: SFlight, scope: number, simMul: number, advMul: number): Pair | null {
  const csA = (a.callsign||'').trim().toUpperCase()
  const csB = (b.callsign||'').trim().toUpperCase()
  if (csA.length<4 || csB.length<4) return null
  const pA = csA.slice(0,3), pB = csB.slice(0,3)
  if (pA !== pB) return null
  if (!/^[A-Z]{3}$/.test(pA)) return null
  const sufA = csA.slice(3), sufB = csB.slice(3)
  if (sufA === sufB) return null
  const bk = fir(a.lat, a.lng)
  if (fir(b.lat,b.lng) !== bk) return null
  const d = distNm(a,b)
  if (d > scope) return null
  const c = classify(sufA, sufB)
  const dFl = Math.abs(a.altitudeFt - b.altitudeFt)
  const flo = dFl<=2000 ? 1 : dFl<=5000 ? 0.7 : 0.35
  const phA = phase(a), phB = phase(b)
  const pm = (PHASE_MUL[phA] + PHASE_MUL[phB]) / 2
  const term = (phA==='TERM' && phB==='TERM' && d<25)
  const aptMul = term ? 1.30 : 1.0
  const sim = c.sim * (simMul/100)
  const prx = (1 - d/scope) * 100
  const flv = flo * 100
  const phav = pm * 70
  const apt = term ? 85 : (phA==='TERM'||phB==='TERM' ? 55 : 30)
  const frq = 45 + (hash32(pA+bk) % 51)
  const distAtt = 1.0 - 0.6*(d/scope)
  let raw = (0.45*sim + 0.22*prx + 0.15*flv + 0.10*phav + 0.05*apt + 0.03*frq) * flo * distAtt * aptMul * (advMul/100)
  // hard escalations
  if (c.kind==='DIGIT-SWAP' && dFl<2000 && d<40) raw = Math.max(raw, 85)
  if (c.kind==='SINGLE-DIGIT' && (phA==='TERM'||phB==='TERM') && d<20) raw = Math.max(raw, 78)
  const score = Math.max(0, Math.min(100, raw))
  const tier: Tier = score>=80 ? 'COLLISION' : score>=55 ? 'HIGH' : score>=30 ? 'WATCH' : 'OK'
  return {
    a, b, prefix: pA, bucket: bk, kind: c.kind, sim: Math.round(sim),
    dist: d, deltaFl: dFl, flOverlap: flo, phaseA: phA, phaseB: phB, phaseMul: pm, aptMul,
    apt, frq, prx, flo: flv, pha: phav,
    score: Math.round(score), tier, csA, csB,
  }
}

function diffMask(a: string, b: string): boolean[] {
  const out: boolean[] = []
  const m = Math.max(a.length, b.length)
  for (let i=0;i<m;i++) out.push(a[i] !== b[i])
  return out
}

export default function CcmCallsignConfusion({ map, flights, onClose, onFly }: Props){
  const [scope, setScope] = useState(80)
  const [simMul, setSimMul] = useState(100)
  const [advMul, setAdvMul] = useState(100)
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(500)
  const [strict, setStrict] = useState(false)
  const [kindFilter, setKindFilter] = useState<Record<Kind,boolean>>({ 'DIGIT-SWAP': true, 'SINGLE-DIGIT': true, 'TWO-DIGIT': true, PHONETIC: true, 'PREFIX-COL': true })
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [tab, setTab] = useState<'PAIRS'|'AIRLINES'|'BUCKETS'>('PAIRS')
  const [search, setSearch] = useState('')

  const pairs = useMemo(() => {
    const out: Pair[] = []
    const fs = flights.filter(f => !f.ground && f.altitudeFt/100 >= minFl && f.altitudeFt/100 <= maxFl && f.callsign)
    for (let i=0;i<fs.length;i++){
      for (let j=i+1;j<fs.length;j++){
        const p = scorePair(fs[i], fs[j], scope, simMul, advMul)
        if (!p) continue
        if (strict && !KNOWN_PREFIXES.has(p.prefix)) continue
        if (!kindFilter[p.kind]) continue
        out.push(p)
      }
    }
    return out.sort((a,b)=> TIER_RANK[a.tier]-TIER_RANK[b.tier] || b.score-a.score)
  }, [flights, scope, simMul, advMul, minFl, maxFl, strict, kindFilter])

  const filteredPairs = useMemo(() => {
    let p = pairs
    if (tierFilter !== 'ALL') p = p.filter(x => x.tier === tierFilter)
    if (search.trim()){
      const q = search.trim().toUpperCase()
      p = p.filter(x => x.csA.includes(q) || x.csB.includes(q) || x.prefix.includes(q) || x.kind.includes(q) || x.bucket.includes(q))
    }
    return p
  }, [pairs, tierFilter, search])

  const counts: Record<Tier, number> = { COLLISION:0, HIGH:0, WATCH:0, OK:0, IDLE:0 }
  for (const p of pairs) counts[p.tier]++
  const meanScore = pairs.length ? Math.round(pairs.reduce((s,p)=>s+p.score,0)/pairs.length) : 0
  const meanSim = pairs.length ? Math.round(pairs.reduce((s,p)=>s+p.sim,0)/pairs.length) : 0
  const meanDist = pairs.length ? Math.round(pairs.reduce((s,p)=>s+p.dist,0)/pairs.length) : 0
  const worst = pairs[0]
  const meanTier: Tier = meanScore>=80?'COLLISION':meanScore>=55?'HIGH':meanScore>=30?'WATCH':meanScore?'OK':'IDLE'

  // Per-airline aggregation
  const airlines = useMemo(() => {
    const m = new Map<string, { prefix:string; count:number; worst:number; worstTier:Tier; meanSim:number; col:number; hi:number; sumSim:number }>()
    for (const p of pairs){
      const r = m.get(p.prefix) || { prefix:p.prefix, count:0, worst:0, worstTier:'OK' as Tier, meanSim:0, col:0, hi:0, sumSim:0 }
      r.count++; r.sumSim += p.sim
      if (p.score > r.worst){ r.worst = p.score; r.worstTier = p.tier }
      if (p.tier==='COLLISION') r.col++
      if (p.tier==='HIGH') r.hi++
      m.set(p.prefix, r)
    }
    return Array.from(m.values()).map(r => ({ ...r, meanSim: Math.round(r.sumSim/r.count) }))
      .sort((a,b)=> TIER_RANK[a.worstTier]-TIER_RANK[b.worstTier] || b.count-a.count)
  }, [pairs])

  const buckets = useMemo(() => {
    const m = new Map<Bucket, { bucket:Bucket; count:number; sumScore:number; col:number; hi:number }>()
    for (const p of pairs){
      const r = m.get(p.bucket) || { bucket:p.bucket, count:0, sumScore:0, col:0, hi:0 }
      r.count++; r.sumScore += p.score
      if (p.tier==='COLLISION') r.col++
      if (p.tier==='HIGH') r.hi++
      m.set(p.bucket, r)
    }
    return Array.from(m.values()).map(r => ({ ...r, mean: Math.round(r.sumScore/r.count) }))
      .sort((a,b)=> b.count-a.count)
  }, [pairs])

  // Map overlay
  useEffect(() => {
    if (!map) return
    const m = map
    const SRC = 'ccm-src', LBL = 'ccm-lbl-src'
    const features: any[] = []
    const labels: any[] = []
    // dedupe per icao -> worst pair
    const perAc = new Map<string, Pair>()
    for (const p of pairs){
      for (const f of [p.a, p.b]){
        const cur = perAc.get(f.icao)
        if (!cur || TIER_RANK[p.tier] < TIER_RANK[cur.tier]) perAc.set(f.icao, p)
      }
    }
    perAc.forEach((p, ic) => {
      const f = p.a.icao === ic ? p.a : p.b
      if (showHalo){
        features.push({ type:'Feature', properties:{ kind:'halo', color: TIER_COLOR[p.tier], r: 8 + Math.round(14 * p.score/100) },
          geometry:{ type:'Point', coordinates:[f.lng, f.lat] } })
      }
      if (showPin && (p.tier==='COLLISION' || p.tier==='HIGH')){
        features.push({ type:'Feature', properties:{ kind:'pin', color: TIER_COLOR[p.tier] },
          geometry:{ type:'Point', coordinates:[f.lng, f.lat] } })
      }
      if (showLbl && p.tier !== 'OK'){
        labels.push({ type:'Feature', properties:{ label: `${f.callsign||f.icao} · ${p.tier}`, color: TIER_COLOR[p.tier] },
          geometry:{ type:'Point', coordinates:[f.lng, f.lat] } })
      }
    })
    if (showLink){
      for (const p of pairs){
        if (p.tier === 'OK') continue
        features.push({ type:'Feature', properties:{ kind:'link', color: TIER_COLOR[p.tier] },
          geometry:{ type:'LineString', coordinates:[[p.a.lng,p.a.lat],[p.b.lng,p.b.lat]] } })
        const midLng = (p.a.lng+p.b.lng)/2, midLat=(p.a.lat+p.b.lat)/2
        features.push({ type:'Feature', properties:{ kind:'mid', color: KIND_COLOR[p.kind] },
          geometry:{ type:'Point', coordinates:[midLng, midLat] } })
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
      { id:'ccm-link', type:'line', filter:['==',['get','kind'],'link'], paint:{ 'line-color':['get','color'], 'line-width':1.5, 'line-dasharray':[2,2], 'line-opacity':0.8 } },
      { id:'ccm-halo', type:'circle', filter:['==',['get','kind'],'halo'], paint:{ 'circle-radius':['get','r'], 'circle-color':['get','color'], 'circle-opacity':0.12, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.5, 'circle-stroke-opacity':0.7 } },
      { id:'ccm-mid', type:'circle', filter:['==',['get','kind'],'mid'], paint:{ 'circle-radius':4, 'circle-color':['get','color'], 'circle-opacity':0.85, 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1 } },
      { id:'ccm-pin', type:'circle', filter:['==',['get','kind'],'pin'], paint:{ 'circle-radius':6, 'circle-color':['get','color'], 'circle-stroke-color':'#fff', 'circle-stroke-width':1.5 } },
    ])
    ensure(LBL, lc, [
      { id:'ccm-lbl', type:'symbol', layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.6], 'text-anchor':'top', 'text-font':['Open Sans Semibold','Arial Unicode MS Bold'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.4 } },
    ])
    return () => {
      try {
        for (const id of ['ccm-link','ccm-halo','ccm-mid','ccm-pin','ccm-lbl']) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC, LBL]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, pairs, showHalo, showPin, showLbl, showLink])

  const tierPill = (t: Tier) => (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide" style={{ background: `${TIER_COLOR[t]}22`, color: TIER_COLOR[t], border:`1px solid ${TIER_COLOR[t]}55` }}>{t}</span>
  )
  const kindPill = (k: Kind) => (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ background:`${KIND_COLOR[k]}22`, color: KIND_COLOR[k], border:`1px solid ${KIND_COLOR[k]}55` }}>{k}</span>
  )

  return (
    <div className="absolute right-3 top-16 bottom-3 w-[420px] z-[60] rounded-2xl border border-slate-800 bg-slate-950/90 backdrop-blur-md text-slate-200 shadow-2xl flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 bg-slate-900/60">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: TIER_COLOR[meanTier] }} />
          <div className="text-sm font-semibold">CCM · Callsign Confusion</div>
          <span className="text-[10px] text-slate-500">Doc 9870 / 4444 §12.3 / SCST</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      {/* Tier strip */}
      <div className="grid grid-cols-5 gap-1 px-2 pt-2">
        {(['COLLISION','HIGH','WATCH','OK'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`px-1.5 py-1 rounded border text-[10px] font-semibold tracking-wide transition ${tierFilter===t?'opacity-100':'opacity-70 hover:opacity-100'}`}
            style={{ borderColor: `${TIER_COLOR[t]}55`, background: tierFilter===t?`${TIER_COLOR[t]}22`:'transparent', color: TIER_COLOR[t] }}>
            <div className="text-[9px] opacity-80">{t}</div>
            <div className="text-sm font-mono">{counts[t]}</div>
          </button>
        ))}
        <button onClick={() => setTierFilter('ALL')} className={`px-1.5 py-1 rounded border text-[10px] tracking-wide ${tierFilter==='ALL'?'bg-sky-500/20 border-sky-500/50 text-sky-300':'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
          <div className="text-[9px]">ALL</div>
          <div className="text-sm font-mono">{pairs.length}</div>
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-1 px-2 pt-2 text-[10px]">
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">MEAN</div>
          <div className="font-mono text-sm" style={{ color: TIER_COLOR[meanTier] }}>{meanScore}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">WORST</div>
          <div className="font-mono text-sm text-slate-200">{worst ? `${worst.csA}/${worst.csB}` : '—'}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">COL</div>
          <div className="font-mono text-sm text-rose-400">{counts.COLLISION}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">MEAN SIM</div>
          <div className="font-mono text-sm text-slate-200">{meanSim}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">MEAN DIST</div>
          <div className="font-mono text-sm text-sky-300">{meanDist} nm</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">SWAPS</div>
          <div className="font-mono text-sm text-rose-400">{pairs.filter(p=>p.kind==='DIGIT-SWAP').length}</div>
        </div>
      </div>

      {/* Scatter */}
      <div className="px-2 pt-2">
        <svg viewBox="0 0 380 110" className="w-full h-[110px] rounded border border-slate-800 bg-slate-900/40">
          <rect x={0} y={0} width={380} height={110} fill="transparent" />
          {/* breach quadrant sim>=70 dist<=25 */}
          <rect x={70/100*340+20} y={10} width={340-70/100*340} height={(scope-25)/scope*90} fill="#ef444422" />
          <rect x={50/100*340+20} y={10} width={340-50/100*340} height={(scope-50)/scope*90} fill="#f59e0b15" />
          <line x1={20} y1={10 + 25/scope*90} x2={360} y2={10 + 25/scope*90} stroke="#ef4444" strokeDasharray="2 2" strokeOpacity={0.4} />
          <line x1={20+70/100*340} y1={10} x2={20+70/100*340} y2={100} stroke="#ef4444" strokeDasharray="2 2" strokeOpacity={0.4} />
          {pairs.map((p,i) => (
            <circle key={i} cx={20 + p.sim/100*340} cy={10 + Math.min(p.dist,scope)/scope*90} r={2.5} fill={TIER_COLOR[p.tier]} opacity={0.85} />
          ))}
          <text x={4} y={14} fill="#64748b" fontSize={8} fontFamily="monospace">nm</text>
          <text x={360} y={108} fill="#64748b" fontSize={8} fontFamily="monospace" textAnchor="end">sim</text>
        </svg>
      </div>

      {/* Sliders */}
      <div className="grid grid-cols-2 gap-1 px-2 pt-2 text-[10px]">
        {([
          ['PROX', scope, setScope, 10, 250, 'nm'],
          ['SIM-MUL', simMul, setSimMul, 50, 200, '%'],
          ['ADV-MUL', advMul, setAdvMul, 50, 200, '%'],
          ['MIN-FL', minFl, setMinFl, 0, 200, ''],
          ['MAX-FL', maxFl, setMaxFl, 100, 500, ''],
        ] as Array<[string, number, (n:number)=>void, number, number, string]>).map(([label, val, set, min, max, unit]) => (
          <label key={label} className="flex flex-col gap-0.5 rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
            <span className="text-slate-500 flex justify-between"><span>{label}</span><span className="font-mono text-slate-200">{val}{unit}</span></span>
            <input type="range" min={min} max={max} value={val} onChange={e=>set(Number(e.target.value))} className="w-full accent-sky-500" />
          </label>
        ))}
        <label className="flex items-center gap-2 rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <input type="checkbox" checked={strict} onChange={e=>setStrict(e.target.checked)} className="accent-sky-500" />
          <span className="text-slate-300">strict ICAO prefix</span>
        </label>
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
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['LINK',showLink,setShowLink]] as Array<[string,boolean,(b:boolean)=>void]>).map(([l,v,s]) => (
          <button key={l} onClick={()=>s(!v)} className={`px-1.5 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-700 text-slate-500'}`}>{l}</button>
        ))}
      </div>

      {/* Search + Tabs */}
      <div className="px-2 pt-2">
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search callsign / airline / kind / bucket"
          className="w-full px-2 py-1 rounded bg-slate-900/60 border border-slate-800 text-[11px] placeholder:text-slate-600 focus:outline-none focus:border-sky-500/60" />
      </div>
      <div className="grid grid-cols-3 gap-1 px-2 pt-2 text-[10px]">
        {(['PAIRS','AIRLINES','BUCKETS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2 py-1 rounded border ${tab===t?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-700 text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-2 pt-2 pb-3 space-y-1">
        {tab==='PAIRS' && filteredPairs.map((p,i) => {
          const dm = diffMask(p.csA, p.csB)
          return (
            <div key={i} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden">
              <div className="h-[2px]" style={{ background: TIER_COLOR[p.tier] }} />
              <div className="px-2 py-1.5 space-y-1">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-sky-300">{p.prefix}</span>
                    {kindPill(p.kind)}
                    <span className="px-1 py-0.5 rounded text-[9px] font-mono text-slate-400 border border-slate-700">{p.bucket}</span>
                  </div>
                  {tierPill(p.tier)}
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {[{cs:p.csA,f:p.a,ph:p.phaseA},{cs:p.csB,f:p.b,ph:p.phaseB}].map((x,k) => (
                    <button key={k} onClick={() => onFly(x.f.icao)} className="text-left rounded border border-slate-800 bg-slate-950/60 px-1.5 py-1 hover:border-sky-500/40">
                      <div className="font-mono text-[12px] text-slate-100">
                        {x.cs.split('').map((c,ci) => (
                          <span key={ci} className={dm[ci] ? 'text-rose-400' : ''}>{c}</span>
                        ))}
                      </div>
                      <div className="text-[9px] text-slate-500 font-mono">{x.f.type||'—'} · FL{Math.round(x.f.altitudeFt/100)} · {x.ph}</div>
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] font-mono">
                  <div className="rounded bg-slate-950/40 border border-slate-800 px-1.5 py-0.5"><span className="text-slate-500">SIM</span> <span className="text-slate-200">{p.sim}</span></div>
                  <div className="rounded bg-slate-950/40 border border-slate-800 px-1.5 py-0.5"><span className="text-slate-500">DST</span> <span className="text-slate-200">{Math.round(p.dist)}nm</span></div>
                  <div className="rounded bg-slate-950/40 border border-slate-800 px-1.5 py-0.5"><span className="text-slate-500">ΔFL</span> <span className="text-slate-200">{Math.round(p.deltaFl/100)}</span></div>
                  <div className="rounded bg-slate-950/40 border border-slate-800 px-1.5 py-0.5"><span className="text-slate-500">OVL</span> <span className="text-slate-200">{Math.round(p.flOverlap*100)}%</span></div>
                </div>
                <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                  <div className="h-full" style={{ width:`${p.score}%`, background: TIER_COLOR[p.tier] }} />
                </div>
                <div className="grid grid-cols-6 gap-0.5 text-[9px] font-mono">
                  {[['SIM',p.sim],['PRX',Math.round(p.prx)],['FLO',Math.round(p.flo)],['PHA',Math.round(p.pha)],['APT',Math.round(p.apt)],['FRQ',Math.round(p.frq)]].map(([l,v]) => (
                    <div key={l as string} className="rounded bg-slate-950/40 border border-slate-800 px-1 py-0.5 text-center" style={{ color: TIER_COLOR[p.tier] }}><span className="text-slate-500">{l}</span> {v}</div>
                  ))}
                </div>
                <div className="text-[9px] text-slate-400 leading-tight">
                  {p.tier==='COLLISION' && 'Request callsign change to one aircraft (Doc 4444 §12.3.4.6).'}
                  {p.tier==='HIGH' && 'Verify every clearance with full callsign + altitude readback (AC 90-117 §8; EUROCONTROL AGC §6).'}
                  {p.tier==='WATCH' && 'Brief crew on strict full-callsign RTF, no abbreviation (CAP 745 §6).'}
                  {p.tier==='OK' && 'Nominal — monitor.'}
                </div>
              </div>
            </div>
          )
        })}
        {tab==='AIRLINES' && airlines.map((a,i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden">
            <div className="h-[2px]" style={{ background: TIER_COLOR[a.worstTier] }} />
            <div className="px-2 py-1.5 flex items-center justify-between gap-2 text-[11px]">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sky-300">{a.prefix}</span>
                <span className={`text-[9px] ${KNOWN_PREFIXES.has(a.prefix)?'text-slate-400':'italic text-slate-500'}`}>{KNOWN_PREFIXES.has(a.prefix)?'ICAO':'inferred'}</span>
              </div>
              <div className="flex items-center gap-2 font-mono text-[10px]">
                <span className="text-slate-400">×{a.count}</span>
                <span className="text-rose-400">COL{a.col}</span>
                <span className="text-amber-400">HI{a.hi}</span>
                <span style={{ color: TIER_COLOR[a.worstTier] }}>{a.worst}</span>
              </div>
            </div>
            <div className="px-2 pb-1.5">
              <div className="h-1 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: `${a.worst}%`, background: TIER_COLOR[a.worstTier] }} />
              </div>
            </div>
          </div>
        ))}
        {tab==='BUCKETS' && buckets.map((b,i) => {
          const tier: Tier = b.mean>=80?'COLLISION':b.mean>=55?'HIGH':b.mean>=30?'WATCH':'OK'
          return (
            <div key={i} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden">
              <div className="h-[2px]" style={{ background: TIER_COLOR[tier] }} />
              <div className="px-2 py-1.5 flex items-center justify-between gap-2 text-[11px]">
                <span className="font-mono text-sky-300">{b.bucket}</span>
                <div className="flex items-center gap-2 font-mono text-[10px]">
                  <span className="text-slate-400">×{b.count}</span>
                  <span className="text-rose-400">COL{b.col}</span>
                  <span className="text-amber-400">HI{b.hi}</span>
                  <span style={{ color: TIER_COLOR[tier] }}>μ{b.mean}</span>
                </div>
              </div>
              <div className="px-2 pb-1.5">
                <div className="h-1 rounded bg-slate-800 overflow-hidden">
                  <div className="h-full" style={{ width: `${b.mean}%`, background: TIER_COLOR[tier] }} />
                </div>
              </div>
            </div>
          )
        })}
        {tab==='PAIRS' && filteredPairs.length===0 && <div className="text-center text-slate-500 text-[11px] py-6">no confusable pairs in scope</div>}
        {tab==='AIRLINES' && airlines.length===0 && <div className="text-center text-slate-500 text-[11px] py-6">no airlines</div>}
        {tab==='BUCKETS' && buckets.length===0 && <div className="text-center text-slate-500 text-[11px] py-6">no buckets</div>}
      </div>
    </div>
  )
}
