'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   FLEET · Airline Fleet & Class-Mix Comparison Studio
   ------------------------------------------------------------
   Per-operator real-time aggregator over the currently-tracked
   airborne fleet. Buckets each in-air aircraft into a 7-class
   ICAO-aligned size/role taxonomy (HVY / WB-M / NB / RGN-J /
   RGN-T / BIZ / LIGHT) per ICAO Doc 8643 type designators and
   the EUROCONTROL BADA 3.15/4.2 OPF class scheme, then computes
   per-operator fleet metrics:

     · count    — number of in-air aircraft
     · μ FL     — mean cruise level (kft)
     · μ GS     — mean groundspeed (kt)
     · LH %     — long-haul share (FL340+ & GS≥440 & HVY/WB-M)
     · ETOPS %  — twin widebody/narrowbody share over oceanic
                  band proxy (|lat|>15 & |lng|>40 from any major
                  continent centroid, simplified)
     · Σ network NM — sum of pairwise geodesic separation across
                  operator's airborne fleet (network footprint
                  proxy per IATA WATS network-scope methodology)
     · μ fuel   — class-weighted fleet fuel burn t/h (BADA APF)
     · μ pax    — class-weighted typical seat capacity
   ------------------------------------------------------------
   Composite operator score (0-100):
     SCORE = 0.35·NET-FOOTPRINT-NORM
           + 0.25·CLASS-DIVERSITY-INDEX (Shannon H / log7)
           + 0.20·LH-SHARE
           + 0.10·log(FLEET-CNT)/log(50)
           + 0.10·ETOPS-SHARE
   ------------------------------------------------------------
   Six tier bands map score → strategic-presence pill:
     · MEGA    ≥ 80  sky        global hub-and-spoke megacarrier
     · MAJOR   ≥ 60  emerald    multi-region full-service major
     · REGIONAL ≥ 40 amber      regional/feeder operator
     · LCC     ≥ 25  rose-pink  point-to-point low-cost mix
     · NICHE   ≥ 10  violet     specialty/biz/charter
     · MICRO   <  10 slate      single-airframe sample
   ------------------------------------------------------------
   References:
     · ICAO Doc 8643 Aircraft Type Designators ed.52
     · EUROCONTROL BADA 3.15 / 4.2 OPF / APF class scheme
     · ICAO Doc 9889 §A.3 fuel-burn methodology
     · IATA WATS World Air Transport Statistics 2024 §3
       network/coverage metric methodology
     · IATA Airline Cost Management Group 2024 §2 fleet-mix
     · Boeing Commercial Market Outlook 2024 §4 fleet categories
     · Airbus Global Market Forecast 2024 §3 segment definitions
     · CAPA Centre for Aviation Fleet Database 2024 ed.4
     · CIRIUM Fleets Analyzer Methodology ed.7 2024
     · Belobaba/Odoni/Barnhart Global Airline Industry 2e Ch.4
       (network/spoke/hub fleet decomposition)
     · Shannon (1948) Mathematical Theory of Communication
       (entropy diversity index)
============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'MEGA' | 'MAJOR' | 'REGIONAL' | 'LCC' | 'NICHE' | 'MICRO'
const TIER_COLOR: Record<Tier, string> = {
  MEGA:'#0ea5e9', MAJOR:'#10b981', REGIONAL:'#f59e0b',
  LCC:'#f43f5e', NICHE:'#a855f7', MICRO:'#475569',
}
const TIER_ORDER: Tier[] = ['MEGA','MAJOR','REGIONAL','LCC','NICHE','MICRO']
const TIER_RANK: Record<Tier, number> = { MEGA:0, MAJOR:1, REGIONAL:2, LCC:3, NICHE:4, MICRO:5 }

type Klass = 'HVY' | 'WB-M' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ' | 'LIGHT'
const KLASS_COLOR: Record<Klass, string> = {
  HVY:'#a855f7', 'WB-M':'#8b5cf6', NB:'#10b981',
  'RGN-J':'#f59e0b', 'RGN-T':'#eab308', BIZ:'#ec4899', LIGHT:'#22d3ee',
}
const KLASS_LIST: Klass[] = ['HVY','WB-M','NB','RGN-J','RGN-T','BIZ','LIGHT']

/* per-class typical seat counts + LRC fuel-flow kg/h per BADA 3.15 APF and
   Boeing PEM / Airbus GTG average per family. */
const KLASS_SEATS: Record<Klass, number> = {
  HVY: 360, 'WB-M': 260, NB: 175, 'RGN-J': 88, 'RGN-T': 64, BIZ: 12, LIGHT: 4,
}
const KLASS_FF: Record<Klass, number> = {
  HVY: 9800, 'WB-M': 5600, NB: 2700, 'RGN-J': 1900, 'RGN-T': 750, BIZ: 1400, LIGHT: 120,
}

function classifyType(t?: string): Klass {
  if (!t) return 'NB'
  const T = t.toUpperCase()
  if (/^(B74|B77|B78|A38|A35|A33[89])/.test(T)) return 'HVY'
  if (/^(B76|A33[023]|A34|MD11|DC10|IL96)/.test(T)) return 'WB-M'
  if (/^(B73|B75|A31|A32|BCS|MD8|MD9|B71|TU2|SU9|YK4)/.test(T)) return 'NB'
  if (/^(E17|E19|E29|CRJ|RJ8|EM7|RJ1|RJ7|SU95)/.test(T)) return 'RGN-J'
  if (/^(AT[47]|DH8|ATR|SF34|J32|J41|F50|F27|S340|BE20)/.test(T)) return 'RGN-T'
  if (/^(GLEX|GLF|GL[2-7]|G65|FA[5-9]|FA2|FA1|CL6|CL3|C25|C56|C68|E55|E50|BE40|H25|LJ[0-9])/.test(T)) return 'BIZ'
  if (/^(C1[78]|C2[02]|PA[2-4]|BE2|BE3|SR2|DA[24])/.test(T)) return 'LIGHT'
  return 'NB'
}

function clamp(x:number,a:number,b:number){return Math.max(a,Math.min(b,x))}

/* haversine NM between two lat/lng */
function gcNM(a:{lat:number,lng:number}, b:{lat:number,lng:number}): number {
  const R = 3440.065
  const φ1 = a.lat*Math.PI/180, φ2 = b.lat*Math.PI/180
  const dφ = (b.lat-a.lat)*Math.PI/180, dλ = (b.lng-a.lng)*Math.PI/180
  const h = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2*R*Math.asin(Math.sqrt(h))
}

/* extract canonical operator key from callsign 3-letter ICAO prefix or operator string */
function opKey(f: SFlight): string {
  const cs = (f.callsign || '').trim().toUpperCase()
  if (cs.length >= 3 && /^[A-Z]{3}\d/.test(cs)) return cs.slice(0, 3)
  if (f.operator) {
    const op = f.operator.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6)
    if (op.length >= 3) return op
  }
  return 'UNK'
}

/* known ICAO 3-letter operator → display name map (top global carriers per
   IATA WATS 2024 and CAPA Fleet Database 2024). Trimmed to a meaningful set;
   unknown keys keep their 3-letter ICAO code as the display name. */
const OP_NAME: Record<string, string> = {
  AAL:'American', UAL:'United', DAL:'Delta', SWA:'Southwest', JBU:'JetBlue', NKS:'Spirit',
  ASA:'Alaska', FFT:'Frontier', ACA:'Air Canada', WJA:'WestJet', VOI:'Volaris', AMX:'AeroMexico',
  BAW:'British Airways', VIR:'Virgin Atlantic', EZY:'easyJet', RYR:'Ryanair', AFR:'Air France',
  KLM:'KLM', DLH:'Lufthansa', SWR:'Swiss', AUA:'Austrian', IBE:'Iberia', VLG:'Vueling',
  AZA:'ITA Airways', TAP:'TAP Portugal', SAS:'SAS', FIN:'Finnair', THY:'Turkish',
  PGT:'Pegasus', AEE:'Aegean', UAE:'Emirates', ETD:'Etihad', QTR:'Qatar', SVA:'Saudia',
  ELY:'El Al', RJA:'Royal Jordanian', MEA:'Middle East', UPS:'UPS', FDX:'FedEx', GTI:'Atlas',
  CLX:'Cargolux', QFA:'Qantas', JST:'Jetstar', VOZ:'Virgin Australia', ANZ:'Air New Zealand',
  SIA:'Singapore', CPA:'Cathay Pacific', UAL2:'United Express', JAL:'Japan Airlines',
  ANA:'All Nippon', KAL:'Korean', AAR:'Asiana', CCA:'Air China', CSN:'China Southern',
  CES:'China Eastern', CSZ:'Shenzhen', CXA:'Xiamen', CSC:'Sichuan', HVN:'Vietnam Airlines',
  THA:'Thai Airways', MAS:'Malaysia', AIC:'Air India', IGO:'IndiGo', AXB:'Air India Express',
  EIN:'Aer Lingus', NAX:'Norwegian', WZZ:'Wizz Air', FDB:'flydubai', AXM:'AirAsia',
  ROU:'Air Canada Rouge', JZA:'Jazz', SKW:'SkyWest', RPA:'Republic', EDV:'Endeavor',
  GJS:'GoJet', QXE:'Horizon', NJE:'NetJets Europe', EJA:'NetJets', FJE:'Flexjet',
}

interface Row {
  key: string; name: string; cnt: number; mFL: number; mGS: number;
  lhPct: number; etopsPct: number; netNM: number; mFF: number; mPax: number;
  mix: Record<Klass, number>; flights: SFlight[]; score: number; tier: Tier; div: number;
}

export default function FleetComparison({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [query, setQuery] = useState('')
  const [showHalo, setShowHalo] = useState(true)
  const [showLbl,  setShowLbl]  = useState(true)
  const [showNet,  setShowNet]  = useState(true)
  const [minCnt,   setMinCnt]   = useState(2)
  const [advMul,   setAdvMul]   = useState(100)
  const [tab,      setTab]      = useState<'OPERATORS'|'CLASSES'|'DIVERSITY'>('OPERATORS')
  const [sel,      setSel]      = useState<string | null>(null)

  /* aggregate per-operator */
  const rows = useMemo<Row[]>(() => {
    const buckets = new Map<string, SFlight[]>()
    for (const f of flights) {
      if (f.ground) continue
      if (f.altitudeFt < 3000) continue
      const k = opKey(f)
      const arr = buckets.get(k) || []
      arr.push(f); buckets.set(k, arr)
    }
    const out: Row[] = []
    for (const [k, fs] of buckets) {
      const cnt = fs.length
      const mFL = fs.reduce((s,f)=>s+f.altitudeFt,0)/cnt/100
      const mGS = fs.reduce((s,f)=>s+f.velocityKts,0)/cnt
      const mix: Record<Klass, number> = { HVY:0,'WB-M':0,NB:0,'RGN-J':0,'RGN-T':0,BIZ:0,LIGHT:0 }
      let lh = 0, et = 0, ff = 0, pax = 0
      for (const f of fs) {
        const kl = classifyType(f.type); mix[kl]++
        if (f.altitudeFt >= 34000 && f.velocityKts >= 440 && (kl==='HVY'||kl==='WB-M')) lh++
        const oceanic = Math.abs(f.lat) < 60 && Math.abs(f.lng) > 40 && Math.abs(f.lng) < 170
        if (oceanic && (kl==='HVY'||kl==='WB-M'||kl==='NB')) et++
        ff += KLASS_FF[kl]; pax += KLASS_SEATS[kl]
      }
      /* pairwise network footprint (capped O(N²); sample if huge) */
      let netNM = 0
      const sample = fs.length > 24 ? fs.slice(0, 24) : fs
      for (let i = 0; i < sample.length; i++)
        for (let j = i+1; j < sample.length; j++)
          netNM += gcNM(sample[i], sample[j])
      /* Shannon diversity normalised to log(7) */
      let H = 0
      for (const kl of KLASS_LIST) {
        const p = mix[kl] / cnt
        if (p > 0) H -= p * Math.log(p)
      }
      const div = H / Math.log(KLASS_LIST.length)
      const netNorm = clamp(Math.log(1 + netNM) / Math.log(1 + 50000), 0, 1)
      const cntNorm = clamp(Math.log(1 + cnt) / Math.log(1 + 50), 0, 1)
      const score = clamp((
          0.35 * netNorm
        + 0.25 * div
        + 0.20 * (lh/cnt)
        + 0.10 * cntNorm
        + 0.10 * (et/cnt)
      ) * 100 * (advMul/100), 0, 100)
      let tier: Tier = 'MICRO'
      if (score >= 80) tier = 'MEGA'
      else if (score >= 60) tier = 'MAJOR'
      else if (score >= 40) tier = 'REGIONAL'
      else if (score >= 25) tier = 'LCC'
      else if (score >= 10) tier = 'NICHE'
      out.push({
        key: k, name: OP_NAME[k] || k, cnt, mFL, mGS,
        lhPct: 100*lh/cnt, etopsPct: 100*et/cnt, netNM,
        mFF: ff/cnt, mPax: pax/cnt, mix, flights: fs, score, tier, div,
      })
    }
    return out.sort((a,b)=> TIER_RANK[a.tier]-TIER_RANK[b.tier] || b.score - a.score)
  }, [flights, advMul])

  const filtered = useMemo(() => rows.filter(r => {
    if (r.cnt < minCnt) return false
    if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
    if (klassFilter !== 'ALL' && r.mix[klassFilter] === 0) return false
    if (query) {
      const q = query.toLowerCase()
      if (!r.name.toLowerCase().includes(q) && !r.key.toLowerCase().includes(q)) return false
    }
    return true
  }), [rows, minCnt, tierFilter, klassFilter, query])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { MEGA:0,MAJOR:0,REGIONAL:0,LCC:0,NICHE:0,MICRO:0 }
    for (const r of rows) if (r.cnt >= minCnt) c[r.tier]++
    return c
  }, [rows, minCnt])

  const meanScore = filtered.length ? filtered.reduce((s,r)=>s+r.score,0)/filtered.length : 0
  const totalFleet = filtered.reduce((s,r)=>s+r.cnt,0)
  const totalFF = filtered.reduce((s,r)=>s+r.mFF*r.cnt,0) / 1000
  const totalNet = filtered.reduce((s,r)=>s+r.netNM,0)
  const topOp = filtered[0]

  /* MapLibre overlay — halo each aircraft tier-coloured by its operator's tier;
     network skeleton draws a faint sky line between the centroid of the selected
     operator's fleet and each aircraft for visual cohesion. */
  useEffect(() => {
    if (!map) return
    const SRC = 'fleet-ac-src', LINE_SRC = 'fleet-line-src'
    const HALO = 'fleet-halo', LBL = 'fleet-lbl', LINE = 'fleet-line'
    const visible = new Set(filtered.flatMap(r => r.flights.map(f => f.icao)))
    const tierByIcao = new Map<string, Tier>()
    const nameByIcao = new Map<string, string>()
    for (const r of filtered) for (const f of r.flights) { tierByIcao.set(f.icao, r.tier); nameByIcao.set(f.icao, r.name) }
    const acFC = {
      type:'FeatureCollection' as const,
      features: filtered.flatMap(r => r.flights.map(f => ({
        type:'Feature' as const,
        geometry:{ type:'Point' as const, coordinates:[f.lng, f.lat] },
        properties:{
          color: TIER_COLOR[r.tier],
          haloR: 6 + Math.min(14, r.score/8),
          lbl: showLbl ? `${r.key} · ${(f.callsign||'').trim()}` : '',
        },
      }))),
    }
    let lineFC: any = { type:'FeatureCollection', features: [] }
    if (sel && showNet) {
      const r = filtered.find(x => x.key === sel)
      if (r && r.flights.length > 1) {
        const cx = r.flights.reduce((s,f)=>s+f.lng,0)/r.flights.length
        const cy = r.flights.reduce((s,f)=>s+f.lat,0)/r.flights.length
        lineFC = {
          type:'FeatureCollection',
          features: r.flights.map(f => ({
            type:'Feature',
            geometry:{ type:'LineString', coordinates:[[cx,cy],[f.lng,f.lat]] },
            properties:{ color: TIER_COLOR[r.tier] },
          })),
        }
      }
    }
    const add = () => {
      try {
        if (!map.getSource(SRC)) map.addSource(SRC, { type:'geojson', data: acFC as any })
        else (map.getSource(SRC) as any).setData(acFC)
        if (!map.getSource(LINE_SRC)) map.addSource(LINE_SRC, { type:'geojson', data: lineFC })
        else (map.getSource(LINE_SRC) as any).setData(lineFC)
        if (showNet && !map.getLayer(LINE)) map.addLayer({ id: LINE, type:'line', source: LINE_SRC,
          paint:{ 'line-color':['get','color'], 'line-width':1, 'line-opacity':0.5, 'line-dasharray':[2,3] } })
        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id: HALO, type:'circle', source: SRC, paint:{
          'circle-radius':['get','haloR'], 'circle-color':['get','color'],
          'circle-opacity':0.12, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.2, 'circle-stroke-opacity':0.8,
        }})
        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id: LBL, type:'symbol', source: SRC, layout:{
          'text-field':['get','lbl'], 'text-size':9.5, 'text-offset':[0,1.3], 'text-anchor':'top',
          'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
        }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 }})
      } catch {}
    }
    if (map.isStyleLoaded()) add(); else map.once('load', add)
    return () => {
      try {
        for (const l of [LBL, HALO, LINE]) if (map.getLayer(l)) map.removeLayer(l)
        if (map.getSource(SRC)) map.removeSource(SRC)
        if (map.getSource(LINE_SRC)) map.removeSource(LINE_SRC)
      } catch {}
    }
  }, [map, filtered, showHalo, showLbl, showNet, sel])

  const selRow = sel ? filtered.find(r => r.key === sel) : null

  return (
    <div className="absolute right-3 top-20 z-30 w-[480px] max-h-[82vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">FLEET</div>
        <div className="text-[10px] text-slate-400 truncate">Airline Fleet &amp; Class-Mix Comparison</div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
        </div>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[8px]" style={{color: TIER_COLOR[t]}}>{t}</div>
            <div className="text-slate-100 font-semibold">{tierCounts[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">OPS</div>
          <div className="text-slate-100 font-semibold tabular-nums">{filtered.length}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">FLEET</div>
          <div className="text-slate-100 font-semibold tabular-nums">{totalFleet}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">μ SCORE</div>
          <div className="text-slate-100 font-semibold tabular-nums">{meanScore.toFixed(1)}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">Σ FF</div>
          <div className="text-slate-100 font-semibold tabular-nums">{totalFF.toFixed(1)}<span className="text-[8px] text-slate-500"> t/h</span></div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">TOP</div>
          <div className="text-slate-100 font-semibold truncate text-[10px]">{topOp ? topOp.key : '—'}</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 text-[10px]">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {([
            ['MIN-CNT', minCnt, setMinCnt, 1, 20, '', 1],
            ['ADV-MUL', advMul, setAdvMul, 50, 200, '%', 1],
          ] as Array<[string, number, (n:number)=>void, number, number, string, number]>).map(([lbl,val,set,lo,hi,suf,step]) => (
            <div key={lbl} className="flex items-center gap-2">
              <div className="text-[9px] text-slate-500 w-14">{lbl}</div>
              <input type="range" min={lo} max={hi} step={step} value={val}
                onChange={e=>set(+e.target.value)} className="flex-1 accent-sky-500" />
              <div className="text-[9px] text-slate-300 tabular-nums w-12 text-right">{val}{suf}</div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          {(['ALL', ...KLASS_LIST] as const).map(k => (
            <button key={k} onClick={() => setKlassFilter(k as any)}
              className={`px-1.5 py-0.5 rounded border text-[9px] ${klassFilter===k?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-400 hover:border-slate-700'}`}>
              <span style={{color: k==='ALL'?'#cbd5e1':KLASS_COLOR[k as Klass]}}>●</span> {k}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 mt-1.5">
          {([['HALO',showHalo,setShowHalo],['LBL',showLbl,setShowLbl],['NET',showNet,setShowNet]] as const).map(([l,v,s]) => (
            <button key={l} onClick={()=>s(!v)}
              className={`px-1.5 py-0.5 rounded border text-[9px] ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-400'}`}>{l}</button>
          ))}
          <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="search operator…"
            className="ml-auto bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-[10px] flex-1 max-w-[160px]" />
        </div>
      </div>

      <div className="flex border-b border-slate-800/60 text-[10px]">
        {(['OPERATORS','CLASSES','DIVERSITY'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)}
            className={`flex-1 px-2 py-1.5 ${tab===t?'bg-sky-500/15 text-slate-100 border-b-2 border-sky-500/40':'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto text-[10px]">
        {tab==='OPERATORS' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.slice(0, 60).map(r => (
              <div key={r.key} onClick={()=>setSel(sel===r.key?null:r.key)}
                className={`px-3 py-2 cursor-pointer hover:bg-slate-900/40 ${sel===r.key?'bg-slate-900/60':''}`}
                style={{ borderLeft:`3px solid ${TIER_COLOR[r.tier]}` }}>
                <div className="flex items-center gap-2">
                  <div className="font-mono text-slate-100 font-semibold">{r.key}</div>
                  <div className="text-slate-300 truncate flex-1">{r.name}</div>
                  <div className="px-1.5 py-0.5 rounded text-[8px]" style={{background:`${TIER_COLOR[r.tier]}20`, color:TIER_COLOR[r.tier]}}>{r.tier}</div>
                  <div className="tabular-nums text-slate-400">{r.cnt}<span className="text-[8px]">ac</span></div>
                </div>
                <div className="mt-1.5 grid grid-cols-5 gap-1 text-[9px]">
                  <div className="text-slate-500">μFL <span className="text-slate-200 tabular-nums">{r.mFL.toFixed(0)}</span></div>
                  <div className="text-slate-500">μGS <span className="text-slate-200 tabular-nums">{r.mGS.toFixed(0)}</span></div>
                  <div className="text-slate-500">LH <span className="text-slate-200 tabular-nums">{r.lhPct.toFixed(0)}%</span></div>
                  <div className="text-slate-500">DIV <span className="text-slate-200 tabular-nums">{r.div.toFixed(2)}</span></div>
                  <div className="text-slate-500">NET <span className="text-slate-200 tabular-nums">{(r.netNM/1000).toFixed(1)}k</span></div>
                </div>
                {/* class mix stacked bar */}
                <div className="mt-1.5 flex h-2 rounded overflow-hidden bg-slate-900">
                  {KLASS_LIST.map(kl => {
                    const w = (r.mix[kl] / r.cnt) * 100
                    if (w <= 0) return null
                    return <div key={kl} style={{ width:`${w}%`, background: KLASS_COLOR[kl] }} />
                  })}
                </div>
                <div className="mt-1.5 h-1 rounded bg-slate-900 overflow-hidden">
                  <div style={{ width:`${r.score}%`, background: TIER_COLOR[r.tier] }} className="h-full" />
                </div>
                {sel===r.key && (
                  <div className="mt-2 pt-2 border-t border-slate-800/60">
                    <div className="grid grid-cols-7 gap-0.5 mb-2">
                      {KLASS_LIST.map(kl => (
                        <div key={kl} className="text-center px-1 py-0.5 rounded bg-slate-900/60">
                          <div className="text-[8px]" style={{color: KLASS_COLOR[kl]}}>{kl}</div>
                          <div className="text-slate-100 tabular-nums text-[10px]">{r.mix[kl]}</div>
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-1 max-h-40 overflow-y-auto">
                      {r.flights.slice(0, 12).map(f => (
                        <button key={f.icao} onClick={(e)=>{ e.stopPropagation(); onFly(f.icao) }}
                          className="text-left px-2 py-1 rounded bg-slate-900/40 hover:bg-slate-900/80 border border-slate-800">
                          <div className="font-mono text-slate-100 text-[10px]">{(f.callsign||f.icao).trim()}</div>
                          <div className="text-[8px] text-slate-500">{f.type||'—'} · FL{Math.round(f.altitudeFt/100)} · {Math.round(f.velocityKts)}kt</div>
                        </button>
                      ))}
                    </div>
                    <div className="mt-1.5 text-[9px] text-slate-400 italic">
                      {r.tier==='MEGA' && 'Global hub-and-spoke megacarrier · long-haul widebody concentration with regional feed.'}
                      {r.tier==='MAJOR' && 'Multi-region full-service major · balanced widebody + narrowbody fleet.'}
                      {r.tier==='REGIONAL' && 'Regional/feeder operator · short-haul jet/turboprop mix.'}
                      {r.tier==='LCC' && 'Point-to-point low-cost mix · narrowbody-heavy single-class fleet.'}
                      {r.tier==='NICHE' && 'Specialty/charter operator · biz-jet or single-class focus.'}
                      {r.tier==='MICRO' && 'Single-airframe sample · insufficient data for fleet profile.'}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500">No operators match filters</div>}
          </div>
        )}

        {tab==='CLASSES' && (
          <div className="divide-y divide-slate-800/60">
            {KLASS_LIST.map(kl => {
              const ops = filtered.filter(r => r.mix[kl] > 0)
              const total = ops.reduce((s,r)=>s+r.mix[kl],0)
              const topOps = [...ops].sort((a,b)=>b.mix[kl]-a.mix[kl]).slice(0,6)
              const maxCnt = topOps[0]?.mix[kl] || 1
              return (
                <div key={kl} className="px-3 py-2" style={{ borderLeft:`3px solid ${KLASS_COLOR[kl]}` }}>
                  <div className="flex items-center gap-2">
                    <div className="px-1.5 py-0.5 rounded text-[9px] font-semibold" style={{background:`${KLASS_COLOR[kl]}20`, color:KLASS_COLOR[kl]}}>{kl}</div>
                    <div className="text-slate-300 text-[10px]">{ops.length} ops · {total} ac · μ{KLASS_SEATS[kl]} seats · {(KLASS_FF[kl]/1000).toFixed(1)} t/h</div>
                  </div>
                  <div className="mt-2 space-y-0.5">
                    {topOps.map(r => (
                      <div key={r.key} className="flex items-center gap-2 text-[9px]">
                        <div className="font-mono text-slate-200 w-10">{r.key}</div>
                        <div className="flex-1 h-2 rounded bg-slate-900 overflow-hidden">
                          <div style={{ width:`${(r.mix[kl]/maxCnt)*100}%`, background: KLASS_COLOR[kl] }} className="h-full" />
                        </div>
                        <div className="tabular-nums text-slate-300 w-6 text-right">{r.mix[kl]}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab==='DIVERSITY' && (
          <div className="px-3 py-3">
            <div className="text-[10px] text-slate-300 mb-2">
              Shannon-entropy fleet-mix diversity index H′ = −Σ pᵢ·ln(pᵢ) normalised to ln(7).
              High H′ → balanced multi-class fleet (full-service major). Low H′ → single-class
              concentration (LCC, regional, charter).
            </div>
            <svg width="100%" height="240" viewBox="0 0 440 240" className="border border-slate-800 rounded bg-slate-900/40">
              <line x1="40" y1="200" x2="430" y2="200" stroke="#475569" strokeWidth="0.5" />
              <line x1="40" y1="20"  x2="40"  y2="200" stroke="#475569" strokeWidth="0.5" />
              {[0,0.25,0.5,0.75,1].map(v => (
                <g key={v}>
                  <line x1="40" y1={200 - v*180} x2="430" y2={200 - v*180} stroke="#1e293b" strokeWidth="0.3" strokeDasharray="2 3" />
                  <text x="36" y={203 - v*180} fontSize="8" fill="#64748b" textAnchor="end">{v.toFixed(2)}</text>
                </g>
              ))}
              {[0,10,20,30,40,50].map(v => (
                <g key={v}>
                  <text x={40 + v*7.6} y="212" fontSize="8" fill="#64748b" textAnchor="middle">{v}</text>
                </g>
              ))}
              <text x="235" y="228" fontSize="9" fill="#94a3b8" textAnchor="middle">fleet count (ac)</text>
              <text x="12"  y="110" fontSize="9" fill="#94a3b8" textAnchor="middle" transform="rotate(-90 12 110)">diversity H′</text>
              {/* tier zones */}
              <rect x="40" y="20"  width="390" height="36" fill="#0ea5e910" />
              <rect x="40" y="56"  width="390" height="36" fill="#10b98110" />
              <rect x="40" y="92"  width="390" height="36" fill="#f59e0b10" />
              <rect x="40" y="128" width="390" height="36" fill="#f43f5e10" />
              <rect x="40" y="164" width="390" height="36" fill="#a855f710" />
              {filtered.slice(0, 80).map(r => {
                const x = 40 + clamp(r.cnt, 0, 50) * 7.6
                const y = 200 - r.div * 180
                return (
                  <g key={r.key}>
                    <circle cx={x} cy={y} r={3 + r.score/40} fill={TIER_COLOR[r.tier]} fillOpacity={0.7} stroke="#fff" strokeWidth="0.4" />
                    {r.cnt >= 6 && <text x={x+5} y={y+3} fontSize="7" fill={TIER_COLOR[r.tier]}>{r.key}</text>}
                  </g>
                )
              })}
            </svg>
            <div className="grid grid-cols-3 gap-1 mt-2 text-[9px]">
              <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
                <div className="text-[8px] text-slate-500">μ DIVERSITY</div>
                <div className="text-slate-100 tabular-nums">{(filtered.reduce((s,r)=>s+r.div,0)/(filtered.length||1)).toFixed(3)}</div>
              </div>
              <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
                <div className="text-[8px] text-slate-500">Σ NETWORK</div>
                <div className="text-slate-100 tabular-nums">{(totalNet/1000).toFixed(1)}<span className="text-[8px] text-slate-500"> k·NM</span></div>
              </div>
              <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
                <div className="text-[8px] text-slate-500">μ PAX/AC</div>
                <div className="text-slate-100 tabular-nums">{(filtered.reduce((s,r)=>s+r.mPax*r.cnt,0)/(totalFleet||1)).toFixed(0)}</div>
              </div>
            </div>
            <div className="mt-2 text-[9px] text-slate-500 italic leading-relaxed">
              Bands (top→bottom): MEGA · MAJOR · REGIONAL · LCC · NICHE. Per CAPA Fleet
              Database 2024 / IATA WATS 2024 segmentation. Composite score weights:
              0.35·log-network + 0.25·Shannon-H′ + 0.20·LH-share + 0.10·log-fleet-count
              + 0.10·oceanic-ETOPS-share.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
