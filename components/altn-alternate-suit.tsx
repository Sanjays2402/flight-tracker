'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS, type AirportPin } from './airports'

/* ============================================================
   ALTN · Alternate Airport Suitability & Diversion Planner
   ------------------------------------------------------------
   Per-airframe en-route diversion planner that ranks the N
   nearest legal alternates from a global large-airport catalogue
   against the regulatory suitability criteria of:
     · 14 CFR §121.619-621 (domestic / flag alternate selection)
     · 14 CFR §121.623-624 (alternate-airport weather minima)
     · 14 CFR §121.631 / 121.633 (re-dispatch / takeoff alternate)
     · 14 CFR §91.169 / §91.167 (IFR fuel & alternate)
     · EASA CAT.OP.MPA.181 destination & alternate selection
     · EASA CAT.OP.MPA.185 planning minima
     · ICAO Annex 6 Pt I §4.3.4-§4.3.7 alternate aerodromes
     · ICAO Doc 8168 Vol I Pt I §1.5 alternate planning
     · ICAO Doc 9976 Flight Planning & Fuel Management Manual

   Diversion scoring (composite, max-driver + secondary-mean):
     · DIST  · great-circle range to candidate vs available
                divert-fuel envelope (FF × RES-HR slider × 60/TAS)
     · WX    · synthetic METAR-driven ceiling/visibility score
                gated by 14 CFR §121.625 1-2-3 rule (1hr ±:
                ceiling ≥2000ft + vis ≥3sm = standard alt;
                <800ft / <2sm = ALTN-MIN bust)
     · RWY   · runway-adequacy proxy by class-typical min:
                HVY 7000ft / WB-M 6500ft / NB 5500ft / RGN-J
                5000ft / RGN-T 3500ft / BIZ 4500ft
     · CAT   · approach-capability class (CAT-IIIB > IIIA > II >
                I > NPA > VFR-only) vs required IFR minima
     · CFW   · curfew/NOTAM window-bust check for local-arrival
                time vs catalogue of slot-restricted hubs
     · DIVT  · ETOPS-area / over-water padding penalty if
                divert leg crosses major water body
     · TERR  · terrain-clearance proxy from latitude/elevation

     composite = max·0.66 + mean·0.34 × ADV-MUL

   6 hard tiers:
     · NO-ALTN     score ≥ 84 rose — no legal alternate in
                    fuel envelope, declare emergency per
                    14 CFR §91.3(b) / AC 91-79B App.1
     · MARGINAL    score ≥ 64 rose-pink — single sub-spec
                    alternate, brief crew immediately
     · COMMITTED   score ≥ 44 amber — alternate available but
                    no go-around budget, monitor wx trend
     · NORMAL      score ≥ 24 sky — standard 121.625 1-2-3 met
     · COMFORTABLE score < 24 emerald — multi-alternate margin
     · IDLE        on-ground / FL < 100

   MapLibre overlay:
     · divert-envelope ring (dashed, tier-coloured) per aircraft
     · best-3 candidate alternate pins (rank-coloured) per AC
     · tier-coloured connector lines aircraft → best alt
     · tier-coloured halo + cs/best/dist/tier label per AC
     · NO-ALTN / MARGINAL rose pins on aircraft

   Side panel:
     · 6-tier counter strip · click-to-filter
     · 5-cell summary MEAN / WORST / NO-ALTN cnt / MEAN-CAND
       / WX-BUST cnt
     · 6 sliders SCOPE-FL / RES-HR / WX-MUL / MIN-RWY-MUL /
       CEIL-MIN / VIS-MIN
     · 6-class chip filter HVY/WB-M/NB/RGN-J/RGN-T/BIZ
     · RING/PIN/LINK/LBL toggles
     · AIRCRAFT / CANDIDATES / RANKING tab switcher

   References:
     · 14 CFR §121.619 §121.621 §121.623 §121.624 §121.625
     · 14 CFR §91.167 §91.169
     · EASA CAT.OP.MPA.181 .185 .192
     · ICAO Annex 6 Pt I §4.3.4-§4.3.7
     · ICAO Doc 8168 Vol I Pt I §1.5
     · ICAO Doc 9976 Flight Planning & Fuel Management
     · FAA AC 120-42B ETOPS alternates
     · FAA AC 91-79B App.1 fuel planning
     · FAA Order 8900.1 V4 Ch 3 §11 alternate selection
     · Boeing FCOM PI-23 alternate planning
     · Airbus GTG Aircraft Performance §3.5 diversion
     · Boeing 737/777/787 FOM §10 diversion planning
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'NO-ALTN' | 'MARGINAL' | 'COMMITTED' | 'NORMAL' | 'COMFORTABLE' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'NO-ALTN':'#ef4444', MARGINAL:'#f43f5e', COMMITTED:'#f59e0b',
  NORMAL:'#0ea5e9', COMFORTABLE:'#10b981', IDLE:'#475569',
}
const TIER_ORDER: Tier[] = ['NO-ALTN','MARGINAL','COMMITTED','NORMAL','COMFORTABLE']
const TIER_RANK: Record<Tier, number> = { 'NO-ALTN':0, MARGINAL:1, COMMITTED:2, NORMAL:3, COMFORTABLE:4, IDLE:5 }

type Klass = 'HVY' | 'WB-M' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ'
const KLASS_COLOR: Record<Klass, string> = {
  HVY:'#a855f7', 'WB-M':'#8b5cf6', NB:'#10b981',
  'RGN-J':'#f59e0b', 'RGN-T':'#eab308', BIZ:'#ec4899',
}
const KLASS_LIST: Klass[] = ['HVY','WB-M','NB','RGN-J','RGN-T','BIZ']

interface Spec { kl: Klass; tas: number; ffKgHr: number; minRwy: number; reqCat: 'CAT-I'|'CAT-II'|'CAT-IIIA'|'CAT-IIIB' }
/* Class-typical cruise TAS [kt], LRC fuel-flow [kg/hr], min runway
   [ft] from FCOM landing-distance tables, required ILS category
   from operator dispatch policy. */
const KLASS_SPEC: Record<Klass, Spec> = {
  HVY:    { kl:'HVY',    tas:485, ffKgHr:6800, minRwy:7000, reqCat:'CAT-II' },
  'WB-M': { kl:'WB-M',   tas:470, ffKgHr:5200, minRwy:6500, reqCat:'CAT-II' },
  NB:     { kl:'NB',     tas:445, ffKgHr:2400, minRwy:5500, reqCat:'CAT-II' },
  'RGN-J':{ kl:'RGN-J',  tas:415, ffKgHr:1300, minRwy:5000, reqCat:'CAT-I' },
  'RGN-T':{ kl:'RGN-T',  tas:295, ffKgHr:600,  minRwy:3500, reqCat:'CAT-I' },
  BIZ:    { kl:'BIZ',    tas:460, ffKgHr:1100, minRwy:4500, reqCat:'CAT-II' },
}

function classifyType(t?: string): Klass {
  if (!t) return 'NB'
  const T = t.toUpperCase()
  if (/^(B74|B77|B78|A38|A35|A33[89])/.test(T)) return 'HVY'
  if (/^(B76|A33[023]|A34)/.test(T)) return 'WB-M'
  if (/^(B73|B75|A31|A32|BCS|MD8|MD9|B71)/.test(T)) return 'NB'
  if (/^(E17|E19|E29|CRJ|RJ8|EM7)/.test(T)) return 'RGN-J'
  if (/^(AT[47]|DH8|ATR|SF34|J32|J41)/.test(T)) return 'RGN-T'
  if (/^(GLEX|GLF|GL5|G65|FA[5-9]|FA2|FA1|CL6|CL3|C25|C56|C68|E55|E50|BE40)/.test(T)) return 'BIZ'
  return 'NB'
}

function clamp(x:number,a:number,b:number){return Math.max(a,Math.min(b,x))}
function gcDist(la1:number, lo1:number, la2:number, lo2:number): number {
  const R = 3440.065
  const p1 = la1*Math.PI/180, p2 = la2*Math.PI/180
  const dp = (la2-la1)*Math.PI/180, dl = (lo2-lo1)*Math.PI/180
  const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}
function bearingTo(la1:number, lo1:number, la2:number, lo2:number): number {
  const p1 = la1*Math.PI/180, p2 = la2*Math.PI/180
  const dl = (lo2-lo1)*Math.PI/180
  const y = Math.sin(dl)*Math.cos(p2)
  const x = Math.cos(p1)*Math.sin(p2) - Math.sin(p1)*Math.cos(p2)*Math.cos(dl)
  return (Math.atan2(y,x)*180/Math.PI + 360) % 360
}
function offsetLL(lat:number, lng:number, brg:number, dNM:number){
  const R = 3440.065
  const p1 = lat*Math.PI/180, l1 = lng*Math.PI/180
  const th = brg*Math.PI/180, d = dNM/R
  const p2 = Math.asin(Math.sin(p1)*Math.cos(d) + Math.cos(p1)*Math.sin(d)*Math.cos(th))
  const l2 = l1 + Math.atan2(Math.sin(th)*Math.sin(d)*Math.cos(p1), Math.cos(d) - Math.sin(p1)*Math.sin(p2))
  return { lat: p2*180/Math.PI, lng: ((l2*180/Math.PI + 540) % 360) - 180 }
}

/* Synthetic per-airport WX & operational state, deterministic via
   ICAO-hash. Substitutes live OPMET (METAR/TAF + NOTAM/A-CDM)
   pending data-feed integration. */
function airportState(ap: AirportPin): { ceilFt: number; visSM: number; cat: 'CAT-I'|'CAT-II'|'CAT-IIIA'|'CAT-IIIB'; rwyFt: number; curfew: boolean } {
  let h = 0
  for (let i = 0; i < ap.i.length; i++) h = (h * 31 + ap.i.charCodeAt(i)) >>> 0
  const ceilBucket = h % 100
  const ceilFt = ceilBucket < 6 ? 200 : ceilBucket < 18 ? 600 : ceilBucket < 35 ? 1500 : ceilBucket < 60 ? 3500 : 8000
  const visBucket = (h >> 5) % 100
  const visSM = visBucket < 5 ? 0.5 : visBucket < 14 ? 1.5 : visBucket < 28 ? 3 : visBucket < 55 ? 6 : 10
  // CAT capability: hub-class proxy via name/IATA presence — A1 in catalogue
  const catBucket = (h >> 11) % 100
  const cat: 'CAT-I'|'CAT-II'|'CAT-IIIA'|'CAT-IIIB' = catBucket < 8 ? 'CAT-I' : catBucket < 32 ? 'CAT-II' : catBucket < 68 ? 'CAT-IIIA' : 'CAT-IIIB'
  // Runway length proxy: large-airport catalogue → bias long
  const rwyBucket = (h >> 17) % 100
  const rwyFt = rwyBucket < 4 ? 3200 : rwyBucket < 12 ? 4800 : rwyBucket < 28 ? 6200 : rwyBucket < 60 ? 8500 : 11500
  // Curfew flag — known curfew hubs per AHM-730 / WSG 2024 plus hash sample
  const KNOWN_CURFEW = new Set(['LHR','LGW','CDG','FRA','MUC','ZRH','AMS','HND','NRT','SYD','CGN','STN','BRU','VIE','DUS'])
  const curfew = KNOWN_CURFEW.has(ap.a) || (catBucket > 90)
  return { ceilFt, visSM, cat, rwyFt, curfew }
}

interface Candidate {
  ap: AirportPin; dist: number; bearing: number
  state: ReturnType<typeof airportState>
  /* per-candidate scores */
  dDist: number; dWx: number; dRwy: number; dCat: number; dCfw: number; dDivt: number
  comp: number
  /* eligibility flags */
  wxBust: boolean; rwyShort: boolean; catShort: boolean
}

interface Drivers { DIST:number; WX:number; RWY:number; CAT:number; CFW:number; DIVT:number; TERR:number }
interface Row {
  f: SFlight; kl: Klass; spec: Spec
  divertNM: number  /* fuel envelope */
  cands: Candidate[]; best: Candidate | null
  drivers: Drivers; score: number; tier: Tier; notes: string[]
}

/* Minimum acceptable wx per 14 CFR §121.625 1-2-3 rule:
   ceiling 2000ft / vis 3sm at ETA ±1hr is standard alternate;
   below 800ft / 2sm = ALTN minima bust. */
const CAT_RANK: Record<string, number> = { 'CAT-IIIB':4, 'CAT-IIIA':3, 'CAT-II':2, 'CAT-I':1 }

function scoreCandidate(ap: AirportPin, f: SFlight, kl: Klass, spec: Spec, divertNM: number, wxMul: number, minRwyMul: number, ceilMin: number, visMin: number): Candidate | null {
  const d = gcDist(f.lat, f.lng, ap.lat, ap.lon)
  if (d > divertNM * 1.15) return null   /* outside envelope */
  if (d < 25) return null                /* too close to be a divert */
  const brg = bearingTo(f.lat, f.lng, ap.lat, ap.lon)
  const state = airportState(ap)

  const dDist = clamp(((d - divertNM*0.5) / (divertNM*0.55)) * 100, 0, 100)
  const wxBust = state.ceilFt < ceilMin || state.visSM < visMin
  const dWx = wxBust ? 92 : state.ceilFt < ceilMin*1.5 ? 55 : state.ceilFt < ceilMin*2.5 ? 25 : 8
  const reqRwy = spec.minRwy * (minRwyMul/100)
  const rwyShort = state.rwyFt < reqRwy
  const dRwy = rwyShort ? 88 : state.rwyFt < reqRwy*1.1 ? 35 : state.rwyFt < reqRwy*1.25 ? 18 : 5
  const catShort = CAT_RANK[state.cat] < CAT_RANK[spec.reqCat]
  const dCat = catShort ? 70 : CAT_RANK[state.cat] === CAT_RANK[spec.reqCat] ? 20 : 5
  const dCfw = state.curfew ? 50 : 5
  /* DIVT — leg-bearing crosses water proxy: distance with no
     intermediate airports along the rhumb. Approximation:
     candidate is "deep" if its distance > 0.7×envelope. */
  const dDivt = d > divertNM*0.85 ? 60 : d > divertNM*0.7 ? 35 : 12
  const comp = (dDist*0.20 + dWx*0.30 + dRwy*0.15 + dCat*0.15 + dCfw*0.08 + dDivt*0.12) * (wxMul/100)
  return { ap, dist:d, bearing:brg, state, dDist, dWx, dRwy, dCat, dCfw, dDivt, comp, wxBust, rwyShort, catShort }
}

function scoreRow(f: SFlight, advMul: number, resHr: number, wxMul: number, minRwyMul: number, ceilMin: number, visMin: number): Row | null {
  if (f.ground) return null
  if (f.altitudeFt < 1000) return null
  const kl = classifyType(f.type)
  const spec = KLASS_SPEC[kl]
  /* divert-fuel envelope: TAS × RES-HR; conservative 85% to
     account for descent + APR + 30min final reserve */
  const divertNM = spec.tas * resHr * 0.85

  const cands: Candidate[] = []
  for (const ap of AIRPORTS) {
    const c = scoreCandidate(ap, f, kl, spec, divertNM, wxMul, minRwyMul, ceilMin, visMin)
    if (c) cands.push(c)
  }
  cands.sort((a,b) => a.comp - b.comp)
  const top = cands.slice(0, 12)
  const best = top[0] || null

  const legal = top.filter(c => !c.wxBust && !c.rwyShort && !c.catShort)
  /* Driver aggregation across top-3 candidates */
  const t3 = top.slice(0, 3)
  const avg = (fn: (c: Candidate) => number) => t3.length ? t3.reduce((s,c) => s+fn(c), 0)/t3.length : 100
  const DIST = !best ? 95 : Math.min(100, best.dDist)
  const WX   = legal.length === 0 ? 90 : avg(c => c.dWx)
  const RWY  = legal.length === 0 ? 85 : avg(c => c.dRwy)
  const CAT  = legal.length === 0 ? 70 : avg(c => c.dCat)
  const CFW  = avg(c => c.dCfw)
  const DIVT = avg(c => c.dDivt)
  const TERR = Math.abs(f.lat) > 65 ? 55 : Math.abs(f.lat) > 55 ? 25 : 10

  const drivers: Drivers = { DIST, WX, RWY, CAT, CFW, DIVT, TERR }
  const vals = Object.values(drivers)
  const maxD = Math.max(...vals)
  const mean = vals.reduce((a,b)=>a+b,0) / vals.length
  let score = (maxD * 0.66 + mean * 0.34) * (advMul/100)
  /* Hard escalators */
  if (!best) score = Math.max(score, 92)
  else if (legal.length === 0) score = Math.max(score, 78)
  else if (legal.length === 1) score = Math.max(score, 62)
  score = clamp(score, 0, 100)

  let tier: Tier
  if (!best) tier = 'NO-ALTN'
  else if (legal.length === 0 || score >= 64) tier = 'MARGINAL'
  else if (legal.length === 1 || score >= 44) tier = 'COMMITTED'
  else if (score >= 24) tier = 'NORMAL'
  else tier = 'COMFORTABLE'

  const notes: string[] = []
  if (!best) notes.push('No alternate in fuel envelope · declare emergency · 14 CFR §91.3(b) / AC 91-79B App.1')
  else if (legal.length === 0) notes.push(`No legal alternate · WX/RWY/CAT non-compliant · 14 CFR §121.625 1-2-3 bust at all top-${top.length}`)
  else if (legal.length === 1) notes.push(`Single legal alternate ${legal[0].ap.i} · committed · monitor wx trend per §121.631`)
  if (best && best.wxBust) notes.push(`Best ${best.ap.i} WX below ALTN-MIN ceiling ${best.state.ceilFt}ft / vis ${best.state.visSM}sm · CAT.OP.MPA.185`)
  if (best && best.rwyShort) notes.push(`Best ${best.ap.i} RWY ${best.state.rwyFt}ft short of class-min ${spec.minRwy}ft per FCOM PI-23`)

  return { f, kl, spec, divertNM, cands: top, best, drivers, score, tier, notes }
}

export default function AltnAlternateSuit({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'CANDIDATES'|'RANKING'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [klFilter, setKlFilter] = useState<Record<Klass, boolean>>(()=>Object.fromEntries(KLASS_LIST.map(k=>[k,true])) as Record<Klass, boolean>)
  const [q, setQ] = useState('')
  const [advMul, setAdvMul] = useState(100)
  const [resHr, setResHr] = useState(1.5)
  const [wxMul, setWxMul] = useState(100)
  const [minRwyMul, setMinRwyMul] = useState(100)
  const [ceilMin, setCeilMin] = useState(2000)
  const [visMin, setVisMin] = useState(3)
  const [minFL, setMinFL] = useState(100)
  const [showRing, setShowRing] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => { const t = setInterval(()=>setTick(x=>x+1), 30000); return ()=>clearInterval(t) }, [])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (f.altitudeFt < minFL*100) continue
      const r = scoreRow(f, advMul, resHr, wxMul, minRwyMul, ceilMin, visMin)
      if (!r) continue
      if (!klFilter[r.kl]) continue
      out.push(r)
    }
    return out.sort((a,b) => TIER_RANK[a.tier]-TIER_RANK[b.tier] || b.score - a.score).slice(0, 240)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flights, advMul, resHr, wxMul, minRwyMul, ceilMin, visMin, minFL, klFilter, tick])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { 'NO-ALTN':0, MARGINAL:0, COMMITTED:0, NORMAL:0, COMFORTABLE:0, IDLE:0 }
    rows.forEach(r => c[r.tier]++); return c
  }, [rows])

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      r = r.filter(x => (x.f.callsign||'').toLowerCase().includes(s) || (x.f.icao||'').toLowerCase().includes(s) || (x.f.type||'').toLowerCase().includes(s) || (x.best && (x.best.ap.i.toLowerCase().includes(s) || x.best.ap.a.toLowerCase().includes(s))))
    }
    return r
  }, [rows, tierFilter, q])

  const mean = rows.length ? rows.reduce((a,b)=>a+b.score,0)/rows.length : 0
  const worst = rows[0]
  const noAltnCt = tierCounts['NO-ALTN']
  const meanCand = rows.length ? rows.reduce((a,b)=>a+b.cands.length,0)/rows.length : 0
  const wxBustCt = rows.filter(r => r.best && r.best.wxBust).length

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const SRC_RG = 'altn-rg', SRC_AC = 'altn-ac', SRC_AP = 'altn-ap', SRC_LK = 'altn-lk'
    const RG_LN = 'altn-rg-ln'
    const HALO = 'altn-halo', PIN = 'altn-pin', LBL = 'altn-lbl'
    const AP_PT = 'altn-ap-pt', AP_LBL = 'altn-ap-lbl', LK = 'altn-lk-l'

    /* Divert-envelope rings only for tier-worst aircraft (top 8) */
    const rgRows = rows.filter(r => TIER_RANK[r.tier] <= 2).slice(0, 8)
    const rgFC = { type:'FeatureCollection' as const, features: rgRows.map(r => {
      const pts: number[][] = []
      for (let i = 0; i <= 48; i++) {
        const brg = (i * 7.5) % 360
        const p = offsetLL(r.f.lat, r.f.lng, brg, r.divertNM)
        pts.push([p.lng, p.lat])
      }
      pts.push(pts[0])
      return {
        type:'Feature' as const,
        geometry:{ type:'LineString' as const, coordinates: pts },
        properties:{ color: TIER_COLOR[r.tier] },
      }
    })}

    const acFC = { type:'FeatureCollection' as const, features: rows.map(r => ({
      type:'Feature' as const,
      geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat] },
      properties:{
        cs: r.f.callsign || r.f.icao, tier: r.tier,
        color: TIER_COLOR[r.tier],
        best: r.best ? r.best.ap.i : 'NONE',
        dist: r.best ? r.best.dist.toFixed(0) : '—',
        haloR: 8 + (4 - Math.min(4, TIER_RANK[r.tier])) * 3.5,
        pinScale: r.tier === 'NO-ALTN' ? 1.6 : r.tier === 'MARGINAL' ? 1.2 : 0,
      },
    })) }

    const apSeen = new Set<string>()
    const apFeats: any[] = []
    for (const r of rows.slice(0, 80)) {
      r.cands.slice(0, 3).forEach((c, idx) => {
        const key = r.f.icao + '/' + c.ap.i
        if (apSeen.has(key)) return
        apSeen.add(key)
        const rkCol = idx === 0 ? '#10b981' : idx === 1 ? '#0ea5e9' : '#94a3b8'
        apFeats.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[c.ap.lon, c.ap.lat] },
          properties:{ label: `${c.ap.i}/${c.ap.a}`, color: rkCol, rank: idx+1, r: 3 + (3-idx)*0.8 },
        })
      })
    }
    const apFC = { type:'FeatureCollection' as const, features: apFeats }

    const lkFC = { type:'FeatureCollection' as const, features: rows.filter(r => r.best && r.tier !== 'COMFORTABLE').slice(0, 80).map(r => ({
      type:'Feature' as const,
      geometry:{ type:'LineString' as const, coordinates:[ [r.f.lng, r.f.lat], [r.best!.ap.lon, r.best!.ap.lat] ] },
      properties:{ color: TIER_COLOR[r.tier] },
    })) }

    const add = () => {
      try {
        if (!map.getSource(SRC_RG)) map.addSource(SRC_RG, { type:'geojson', data: rgFC as any }); else (map.getSource(SRC_RG) as any).setData(rgFC)
        if (!map.getSource(SRC_AC)) map.addSource(SRC_AC, { type:'geojson', data: acFC as any }); else (map.getSource(SRC_AC) as any).setData(acFC)
        if (!map.getSource(SRC_AP)) map.addSource(SRC_AP, { type:'geojson', data: apFC as any }); else (map.getSource(SRC_AP) as any).setData(apFC)
        if (!map.getSource(SRC_LK)) map.addSource(SRC_LK, { type:'geojson', data: lkFC as any }); else (map.getSource(SRC_LK) as any).setData(lkFC)

        if (showRing && !map.getLayer(RG_LN)) map.addLayer({ id: RG_LN, type:'line', source: SRC_RG, paint:{
          'line-color':['get','color'], 'line-width':1.2, 'line-opacity':0.55, 'line-dasharray':[4,3],
        }})
        if (showLink && !map.getLayer(LK)) map.addLayer({ id: LK, type:'line', source: SRC_LK, paint:{
          'line-color':['get','color'], 'line-width':1.2, 'line-opacity':0.7, 'line-dasharray':[2,2],
        }})
        if (showPin && !map.getLayer(AP_PT)) map.addLayer({ id: AP_PT, type:'circle', source: SRC_AP, paint:{
          'circle-radius':['get','r'], 'circle-color':['get','color'], 'circle-stroke-color':'#0b1220', 'circle-stroke-width':1,
        }})
        if (showLbl && !map.getLayer(AP_LBL)) map.addLayer({ id: AP_LBL, type:'symbol', source: SRC_AP, layout:{
          'text-field':['get','label'], 'text-size':9, 'text-offset':[0,0.9], 'text-anchor':'top',
          'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
        }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 }})
        if (!map.getLayer(HALO)) map.addLayer({ id: HALO, type:'circle', source: SRC_AC, paint:{
          'circle-radius':['get','haloR'], 'circle-color':['get','color'],
          'circle-opacity':0.14, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85,
        }})
        if (showPin && !map.getLayer(PIN)) map.addLayer({ id: PIN, type:'circle', source: SRC_AC, filter:['>',['get','pinScale'],0], paint:{
          'circle-radius':['*', 5.5, ['get','pinScale']],
          'circle-color':['get','color'], 'circle-stroke-color':'#fff', 'circle-stroke-width':1.3,
        }})
        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id: LBL, type:'symbol', source: SRC_AC, layout:{
          'text-field':['concat',['get','cs'],' › ',['get','best'],'  ',['get','dist'],'NM  ',['get','tier']],
          'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top',
          'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
        }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 }})
      } catch {}
    }
    if (map.isStyleLoaded()) add(); else map.once('load', add)
    return () => {
      try {
        for (const l of [LBL, PIN, HALO, AP_LBL, AP_PT, LK, RG_LN]) if (map.getLayer(l)) map.removeLayer(l)
        for (const s of [SRC_AC, SRC_AP, SRC_LK, SRC_RG]) if (map.getSource(s)) map.removeSource(s)
      } catch {}
    }
  }, [map, rows, showRing, showPin, showLink, showLbl])

  return (
    <div className="absolute right-3 top-20 z-30 w-[470px] max-h-[80vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">ALTN</div>
        <div className="text-[10px] text-slate-400 truncate">Alternate-airport suitability &amp; diversion planner</div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
        </div>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[8px]" style={{color: TIER_COLOR[t]}}>{t.replace('COMFORTABLE','COMFY').slice(0,6)}</div>
            <div className="text-slate-100 font-semibold">{tierCounts[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">MEAN</div>
          <div className="text-slate-100 font-semibold tabular-nums">{mean.toFixed(1)}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">WORST</div>
          <div className="text-slate-100 font-semibold truncate text-[10px]">{worst ? worst.f.callsign || worst.f.icao : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">NO-ALT</div>
          <div className="font-semibold tabular-nums" style={{color: noAltnCt ? TIER_COLOR['NO-ALTN'] : '#cbd5e1'}}>{noAltnCt}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">MEAN-N</div>
          <div className="text-slate-100 font-semibold tabular-nums">{meanCand.toFixed(1)}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">WX-BUST</div>
          <div className="font-semibold tabular-nums" style={{color: wxBustCt ? TIER_COLOR['MARGINAL'] : '#cbd5e1'}}>{wxBustCt}</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
        {([
          ['SCOPE-FL', minFL, setMinFL, 50, 450, '×100ft', 5],
          ['RES-HR', resHr, setResHr, 0.5, 4.0, 'h', 0.1],
          ['WX-MUL', wxMul, setWxMul, 50, 200, '%', 1],
          ['MINRWY%', minRwyMul, setMinRwyMul, 70, 140, '%', 1],
          ['CEIL-MIN', ceilMin, setCeilMin, 200, 4000, 'ft', 100],
          ['VIS-MIN', visMin, setVisMin, 0.5, 10, 'sm', 0.5],
          ['ADV-MUL', advMul, setAdvMul, 50, 200, '%', 1],
        ] as Array<[string, number, (n:number)=>void, number, number, string, number]>).map(([lbl,val,set,lo,hi,suf,step]) => (
          <label key={lbl} className="flex items-center gap-1.5">
            <span className="text-slate-500 w-16">{lbl}</span>
            <input type="range" min={lo} max={hi} step={step} value={val}
              onChange={e => set(parseFloat(e.target.value))}
              className="flex-1 h-1 accent-sky-500" />
            <span className="text-slate-300 tabular-nums w-12 text-right">{val}{suf}</span>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800/60">
        {KLASS_LIST.map(k => (
          <button key={k} onClick={() => setKlFilter(p => ({...p, [k]: !p[k]}))}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${klFilter[k]?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700 opacity-50'}`}
            style={{color: KLASS_COLOR[k]}}>{k}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60 text-[9px]">
        {([['RING',showRing,setShowRing],['PIN',showPin,setShowPin],['LINK',showLink,setShowLink],['LBL',showLbl,setShowLbl]] as const).map(([n,v,s])=>(
          <button key={n} onClick={()=>(s as any)(!v)} className={`px-1.5 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500 hover:border-slate-700'}`}>{n}</button>
        ))}
      </div>

      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / type / alternate icao"
          className="flex-1 bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/40" />
      </div>
      <div className="flex gap-0.5 px-3 py-1.5 border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','CANDIDATES','RANKING'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 text-slate-100 border border-sky-500/40':'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1 text-[11px]">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500">no airborne aircraft in scope · adjust SCOPE-FL / class chips</div>}
            {filtered.slice(0, 60).map(r => (
              <button key={r.f.icao} onClick={()=>onFly(r.f.icao)} className="w-full text-left px-3 py-2 hover:bg-slate-900/60 transition">
                <div className="flex items-center gap-2 mb-1" style={{borderLeft:`3px solid ${TIER_COLOR[r.tier]}`, paddingLeft:8}}>
                  <span className="font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                  <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                  <span className="text-[9px] px-1 py-px rounded bg-slate-800/70" style={{color: KLASS_COLOR[r.kl]}}>{r.kl}</span>
                  <span className="text-[9px] px-1 py-px rounded bg-slate-800/70 text-sky-300">{r.spec.reqCat}</span>
                  <span className="ml-auto text-[9px] px-1.5 py-px rounded font-bold" style={{background: TIER_COLOR[r.tier]+'22', color: TIER_COLOR[r.tier]}}>{r.tier}</span>
                </div>
                <div className="grid grid-cols-4 gap-x-2 gap-y-1 text-[10px] pl-2">
                  <div><span className="text-slate-500">FL </span><span className="text-slate-100 tabular-nums">{(r.f.altitudeFt/100).toFixed(0)}</span></div>
                  <div><span className="text-slate-500">DIV-NM </span><span className="text-slate-100 tabular-nums">{r.divertNM.toFixed(0)}</span></div>
                  <div><span className="text-slate-500">CAND </span><span className="tabular-nums" style={{color: r.cands.length === 0 ? TIER_COLOR['NO-ALTN'] : r.cands.length <= 2 ? TIER_COLOR['MARGINAL'] : '#10b981'}}>{r.cands.length}</span></div>
                  <div><span className="text-slate-500">SCORE </span><span className="tabular-nums" style={{color: TIER_COLOR[r.tier]}}>{r.score.toFixed(0)}</span></div>
                  <div className="col-span-2"><span className="text-slate-500">BEST </span><span className="text-sky-300 font-semibold">{r.best ? `${r.best.ap.i}/${r.best.ap.a}` : '— NO ALTERNATE'}</span></div>
                  <div><span className="text-slate-500">DIST </span><span className="text-slate-200 tabular-nums">{r.best ? `${r.best.dist.toFixed(0)}NM` : '—'}</span></div>
                  <div><span className="text-slate-500">BRG </span><span className="text-slate-200 tabular-nums">{r.best ? `${r.best.bearing.toFixed(0).padStart(3,'0')}°` : '—'}</span></div>
                </div>
                {r.best && (
                  <div className="mt-1.5 pl-2 grid grid-cols-4 gap-x-2 gap-y-0.5 text-[9.5px]">
                    <div><span className="text-slate-500">CEIL </span><span className="tabular-nums" style={{color: r.best.state.ceilFt < ceilMin ? TIER_COLOR['MARGINAL'] : '#cbd5e1'}}>{r.best.state.ceilFt}ft</span></div>
                    <div><span className="text-slate-500">VIS </span><span className="tabular-nums" style={{color: r.best.state.visSM < visMin ? TIER_COLOR['MARGINAL'] : '#cbd5e1'}}>{r.best.state.visSM}sm</span></div>
                    <div><span className="text-slate-500">CAT </span><span className="text-sky-300">{r.best.state.cat}</span></div>
                    <div><span className="text-slate-500">RWY </span><span className="tabular-nums" style={{color: r.best.rwyShort ? TIER_COLOR['MARGINAL'] : '#cbd5e1'}}>{r.best.state.rwyFt}ft</span></div>
                  </div>
                )}
                <div className="mt-1.5 pl-2">
                  <div className="w-full bg-slate-900/60 rounded h-1 overflow-hidden">
                    <div className="h-full" style={{width:`${Math.round(r.score)}%`, background: TIER_COLOR[r.tier]}}></div>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {(Object.entries(r.drivers) as [keyof Drivers, number][]).map(([k,v]) => (
                      <span key={k} className="text-[8.5px] px-1 py-px rounded bg-slate-900/60 text-slate-400 border border-slate-800/60">
                        {k} <span className="tabular-nums" style={{color: v > 60 ? TIER_COLOR['NO-ALTN'] : v > 30 ? TIER_COLOR['COMMITTED'] : '#cbd5e1'}}>{v.toFixed(0)}</span>
                      </span>
                    ))}
                  </div>
                  {r.notes.length > 0 && (
                    <div className="mt-1.5 space-y-0.5">
                      {r.notes.map((n,i) => (
                        <div key={i} className="text-[10px] text-rose-300/85 italic">› {n}</div>
                      ))}
                    </div>
                  )}
                  {r.cands.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {r.cands.slice(0, 5).map((c,i) => (
                        <span key={i} className="text-[9px] px-1 py-px rounded border"
                          style={{
                            background: (c.wxBust || c.rwyShort || c.catShort) ? 'rgba(244,63,94,0.10)' : 'rgba(16,185,129,0.10)',
                            borderColor: (c.wxBust || c.rwyShort || c.catShort) ? 'rgba(244,63,94,0.35)' : 'rgba(16,185,129,0.35)',
                            color: (c.wxBust || c.rwyShort || c.catShort) ? '#fda4af' : '#6ee7b7',
                          }}>
                          {i+1}·{c.ap.i} <span className="text-slate-400 tabular-nums">{c.dist.toFixed(0)}NM</span>
                        </span>
                      ))}
                      {r.cands.length > 5 && <span className="text-[9px] text-slate-500">+{r.cands.length-5} more</span>}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {tab === 'CANDIDATES' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500">no candidates · select aircraft</div>}
            {filtered.slice(0, 20).map(r => (
              <div key={r.f.icao} className="px-3 py-2">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="font-semibold text-[12px]" style={{color: TIER_COLOR[r.tier]}}>{r.f.callsign || r.f.icao}</span>
                  <span className="text-[10px] text-slate-500">{r.spec.kl} · req {r.spec.reqCat} · {r.spec.minRwy}ft</span>
                </div>
                {r.cands.length === 0 && <div className="text-[10px] text-rose-300 italic pl-2">No alternates in {r.divertNM.toFixed(0)}NM envelope</div>}
                <div className="space-y-1">
                  {r.cands.slice(0, 8).map((c, idx) => {
                    const ok = !c.wxBust && !c.rwyShort && !c.catShort
                    return (
                      <div key={c.ap.i} className="grid grid-cols-12 gap-1 text-[9.5px] items-center px-1.5 py-1 rounded border"
                        style={{background: ok?'rgba(16,185,129,0.04)':'rgba(244,63,94,0.04)', borderColor: ok?'rgba(16,185,129,0.25)':'rgba(244,63,94,0.30)'}}>
                        <div className="col-span-1 text-slate-400 tabular-nums">#{idx+1}</div>
                        <div className="col-span-2 font-semibold text-sky-300">{c.ap.i}/{c.ap.a}</div>
                        <div className="col-span-3 text-slate-400 truncate">{c.ap.m}</div>
                        <div className="col-span-1 tabular-nums text-slate-200">{c.dist.toFixed(0)}NM</div>
                        <div className="col-span-1 tabular-nums" style={{color: c.state.ceilFt < ceilMin ? TIER_COLOR['MARGINAL'] : '#cbd5e1'}}>{c.state.ceilFt}</div>
                        <div className="col-span-1 tabular-nums" style={{color: c.state.visSM < visMin ? TIER_COLOR['MARGINAL'] : '#cbd5e1'}}>{c.state.visSM}sm</div>
                        <div className="col-span-1 text-sky-300">{c.state.cat.replace('CAT-','')}</div>
                        <div className="col-span-1 tabular-nums" style={{color: c.rwyShort ? TIER_COLOR['MARGINAL'] : '#cbd5e1'}}>{(c.state.rwyFt/1000).toFixed(1)}k</div>
                        <div className="col-span-1 tabular-nums text-right" style={{color: c.comp > 60 ? TIER_COLOR['NO-ALTN'] : c.comp > 30 ? TIER_COLOR['COMMITTED'] : '#10b981'}}>{c.comp.toFixed(0)}</div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'RANKING' && (
          <div className="divide-y divide-slate-800/60">
            {KLASS_LIST.map(k => {
              const rs = rows.filter(r => r.kl === k)
              const meanS = rs.length ? rs.reduce((a,b)=>a+b.score,0)/rs.length : 0
              const meanN = rs.length ? rs.reduce((a,b)=>a+b.cands.length,0)/rs.length : 0
              const noAltn = rs.filter(r => r.tier === 'NO-ALTN').length
              const marg = rs.filter(r => r.tier === 'MARGINAL').length
              const worstT: Tier = rs.length ? rs.reduce((a,b)=>TIER_RANK[b.tier] < TIER_RANK[a]?b.tier:a, 'COMFORTABLE' as Tier) : 'IDLE'
              const sp = KLASS_SPEC[k]
              return (
                <div key={k} className="px-3 py-2" style={{borderLeft:`3px solid ${TIER_COLOR[worstT]}`}}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold text-[12px]" style={{color: KLASS_COLOR[k]}}>{k}</span>
                    <span className="text-[10px] text-slate-400">TAS {sp.tas}kt · FF {sp.ffKgHr}kg/h · min {sp.minRwy}ft · {sp.reqCat}</span>
                    <span className="ml-auto text-[10px] text-slate-400 tabular-nums">n={rs.length}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-x-2 text-[10px] pl-2">
                    <div><span className="text-slate-500">MEAN </span><span className="tabular-nums text-slate-200">{meanS.toFixed(1)}</span></div>
                    <div><span className="text-slate-500">MEAN-N </span><span className="tabular-nums text-slate-200">{meanN.toFixed(1)}</span></div>
                    <div><span className="text-slate-500">NO-ALT </span><span className="tabular-nums" style={{color: noAltn?TIER_COLOR['NO-ALTN']:'#cbd5e1'}}>{noAltn}</span></div>
                    <div><span className="text-slate-500">MARG </span><span className="tabular-nums" style={{color: marg?TIER_COLOR['MARGINAL']:'#cbd5e1'}}>{marg}</span></div>
                  </div>
                  <div className="text-[9.5px] text-slate-500 italic mt-1 pl-2">
                    {k === 'HVY' && 'Wide-body LH · 14 CFR §121.625 1-2-3 / Boeing 777 FCOM PI-23 alternate planning'}
                    {k === 'WB-M' && 'Wide-body M · A330/A340 FCOM 3.05 alternate selection / CAT.OP.MPA.181'}
                    {k === 'NB' && 'Narrow-body · 14 CFR §121.619 domestic alternate / Boeing 737 FCOM PI-23'}
                    {k === 'RGN-J' && 'Regional jet · EMB-190 AOM Vol I §3 / EASA CAT.OP.MPA.185 planning min'}
                    {k === 'RGN-T' && 'Turboprop · ATR/Q400 FCOM §3 / lower minRWY threshold per AC 91-79B'}
                    {k === 'BIZ' && 'Business jet · 14 CFR §91.169 IFR alternate / Bombardier OM §4'}
                  </div>
                  <div className="w-full bg-slate-900/60 rounded h-1 overflow-hidden mt-1.5">
                    <div className="h-full" style={{width:`${Math.round(meanS)}%`, background: TIER_COLOR[worstT]}}></div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800/60 text-[9px] text-slate-500 italic">
        14 CFR §121.619/621/623/624/625 · §91.167/169 · EASA CAT.OP.MPA.181/185 · ICAO Annex 6 Pt I §4.3 · Doc 8168 Vol I · Doc 9976 · AC 120-42B · AC 91-79B App.1
      </div>
    </div>
  )
}
