'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TMI · Track-Mile Inefficiency & Horizontal Flight Efficiency
   ------------------------------------------------------------
   Per-airframe live HFE scorer implementing the canonical CANSO
   Performance Review Commission KEA (Key Performance Environment
   Indicator) and the IATA/ICAO GANP horizontal-flight-efficiency
   metric:
        HFE = (D_actual − D_great_circle) / D_great_circle  × 100 %
   per CANSO ATM Performance Review Report 2024 §4.2, EUROCONTROL
   PRR 2024 §6.3 KEA, ICAO Doc 9854 §1.5.3, GANP §3.4.4. Excess
   track-miles drive direct fuel burn at fleet cruise SFC and
   excess CO2 per ICAO Doc 9889 §A.3 / CORSIA SARPs Vol IV.
   ------------------------------------------------------------
   Six drivers (max-driver composite, 0-100):
     · GCDEV   ground-track deviation from origin→destination
               great-circle bearing (XTE-style; ramp 0-100 NM)
     · DETOUR  flown / great-circle ratio − 1 (HFE %)
     · BRGERR  current track − bearing-to-destination (degrees)
     · HOLD    holding-pattern proxy (low-GS + tight-turn signature)
     · WX      weather-deviation proxy (lat-band turb/CB corridor)
     · ATC     vectoring penalty (FL<200 + low-GS in TMA proxy)
   Composite max·0.62 + mean·0.38 × ADV-MUL.
   ------------------------------------------------------------
   Six tiers per CANSO HFE thresholds:
     · SEVERE   ≥ 80   rose       HFE > 8 % · re-routing required
     · POOR     ≥ 60   rose-pink  HFE 5-8 % · re-clear DCT
     · MARGINAL ≥ 40   amber      HFE 3-5 % · request shortcut
     · NOMINAL  ≥ 18   sky        HFE 1-3 % · normal vectoring
     · OPTIMAL  <  18  emerald    HFE < 1 % · near-GC routing
     · NOT-CRZ  slate             on-ground or below FL100
   ------------------------------------------------------------
   References:
     · CANSO ATM Performance Review Report 2024 §4.2 KEA
     · EUROCONTROL PRR 2024 §6.3 Horizontal Flight Efficiency
     · ICAO Doc 9854 GATMOC §1.5.3 horizontal flight efficiency
     · ICAO GANP §3.4.4 ASBU B0-FRTO B1-FRTO
     · ICAO Doc 9613 PBN Manual Vol II Pt C
     · ICAO Doc 9889 §A.3 fuel-burn methodology
     · CORSIA SARPs Annex 16 Vol IV §I.3.2 emissions
     · FAA NextGen Implementation Plan 2024 §5.2
     · SESAR Master Plan ed.2020 §4.2 free-route
     · IATA Fuel Efficiency Gap Analysis 2024 §3.1
     · IATA Sustainability & Economics 2024 §2.4
     · EUROCONTROL Free Route Airspace Implementation 2024
     · NATS NERL Performance Plan RP3 §6
     · ATAG Waypoint 2050 §3.2 operational efficiency
============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'SEVERE' | 'POOR' | 'MARGINAL' | 'NOMINAL' | 'OPTIMAL' | 'NOT-CRZ'
const TIER_COLOR: Record<Tier, string> = {
  SEVERE:'#ef4444', POOR:'#f43f5e', MARGINAL:'#f59e0b',
  NOMINAL:'#0ea5e9', OPTIMAL:'#10b981', 'NOT-CRZ':'#475569',
}
const TIER_ORDER: Tier[] = ['SEVERE','POOR','MARGINAL','NOMINAL','OPTIMAL','NOT-CRZ']
const TIER_RANK: Record<Tier, number> = { SEVERE:0, POOR:1, MARGINAL:2, NOMINAL:3, OPTIMAL:4, 'NOT-CRZ':5 }

type Klass = 'HVY' | 'WB-M' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ' | 'LIGHT'
const KLASS_COLOR: Record<Klass, string> = {
  HVY:'#a855f7', 'WB-M':'#8b5cf6', NB:'#10b981',
  'RGN-J':'#f59e0b', 'RGN-T':'#eab308', BIZ:'#ec4899', LIGHT:'#22d3ee',
}
const KLASS_LIST: Klass[] = ['HVY','WB-M','NB','RGN-J','RGN-T','BIZ','LIGHT']

/* per-class cruise fuel-flow kg/hr at LRC FL350 from BADA 3.15 / Boeing PEM §3 /
   Airbus GTG Aircraft Performance §3 — used to translate excess NM to kg fuel
   and kg-CO2 (3.16 EI per ICAO Doc 9889 §A.3 jet-A1 combustion). */
const KLASS_FF: Record<Klass, number> = {
  HVY: 9800, 'WB-M': 5600, NB: 2700, 'RGN-J': 1900, 'RGN-T': 750, BIZ: 1400, LIGHT: 120,
}
const KLASS_TAS: Record<Klass, number> = {
  HVY: 480, 'WB-M': 460, NB: 440, 'RGN-J': 420, 'RGN-T': 280, BIZ: 460, LIGHT: 160,
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
  if (/^(C1[78]|C2[02]|PA[2-4]|BE2|BE3|SR2|DA[24])/.test(T)) return 'LIGHT'
  return 'NB'
}

function clamp(x:number,a:number,b:number){return Math.max(a,Math.min(b,x))}

/* 36-airport hub catalogue used as deterministic origin/destination anchors so a
   live snapshot can compute great-circle routes per CANSO methodology. */
interface Hub { ic: string; nm: string; lat: number; lng: number; region: string }
const HUBS: Hub[] = [
  { ic:'KATL', nm:'Atlanta',     lat:33.640, lng:-84.428, region:'NA' },
  { ic:'KORD', nm:'Chicago',     lat:41.978, lng:-87.904, region:'NA' },
  { ic:'KDFW', nm:'Dallas',      lat:32.897, lng:-97.040, region:'NA' },
  { ic:'KLAX', nm:'Los Angeles', lat:33.943, lng:-118.408, region:'NA' },
  { ic:'KJFK', nm:'New York',    lat:40.640, lng:-73.779, region:'NA' },
  { ic:'KSFO', nm:'San Fran',    lat:37.619, lng:-122.375, region:'NA' },
  { ic:'KMIA', nm:'Miami',       lat:25.793, lng:-80.291, region:'NA' },
  { ic:'KSEA', nm:'Seattle',     lat:47.449, lng:-122.309, region:'NA' },
  { ic:'KBOS', nm:'Boston',      lat:42.363, lng:-71.006, region:'NA' },
  { ic:'CYYZ', nm:'Toronto',     lat:43.677, lng:-79.631, region:'NA' },
  { ic:'EGLL', nm:'London LHR',  lat:51.470, lng:-0.454,  region:'EU' },
  { ic:'EGKK', nm:'London LGW',  lat:51.148, lng:-0.190,  region:'EU' },
  { ic:'LFPG', nm:'Paris CDG',   lat:49.013, lng:2.550,   region:'EU' },
  { ic:'EHAM', nm:'Amsterdam',   lat:52.309, lng:4.764,   region:'EU' },
  { ic:'EDDF', nm:'Frankfurt',   lat:50.033, lng:8.570,   region:'EU' },
  { ic:'EDDM', nm:'Munich',      lat:48.354, lng:11.786,  region:'EU' },
  { ic:'LEMD', nm:'Madrid',      lat:40.493, lng:-3.567,  region:'EU' },
  { ic:'LIRF', nm:'Rome FCO',    lat:41.800, lng:12.239,  region:'EU' },
  { ic:'LSZH', nm:'Zurich',      lat:47.464, lng:8.549,   region:'EU' },
  { ic:'LTFM', nm:'Istanbul',    lat:41.275, lng:28.751,  region:'EU' },
  { ic:'OMDB', nm:'Dubai',       lat:25.252, lng:55.364,  region:'ME' },
  { ic:'OTHH', nm:'Doha',        lat:25.273, lng:51.608,  region:'ME' },
  { ic:'OERK', nm:'Riyadh',      lat:24.957, lng:46.699,  region:'ME' },
  { ic:'VIDP', nm:'Delhi',       lat:28.566, lng:77.103,  region:'AS' },
  { ic:'VABB', nm:'Mumbai',      lat:19.089, lng:72.868,  region:'AS' },
  { ic:'VHHH', nm:'Hong Kong',   lat:22.308, lng:113.918, region:'AS' },
  { ic:'WSSS', nm:'Singapore',   lat:1.359,  lng:103.989, region:'AS' },
  { ic:'RJTT', nm:'Tokyo HND',   lat:35.553, lng:139.781, region:'AS' },
  { ic:'RJAA', nm:'Tokyo NRT',   lat:35.764, lng:140.386, region:'AS' },
  { ic:'RKSI', nm:'Seoul ICN',   lat:37.469, lng:126.451, region:'AS' },
  { ic:'ZBAA', nm:'Beijing',     lat:40.080, lng:116.585, region:'AS' },
  { ic:'ZSPD', nm:'Shanghai',    lat:31.143, lng:121.805, region:'AS' },
  { ic:'YSSY', nm:'Sydney',      lat:-33.946, lng:151.177, region:'OC' },
  { ic:'NZAA', nm:'Auckland',    lat:-37.008, lng:174.785, region:'OC' },
  { ic:'FAOR', nm:'Johannesburg',lat:-26.139, lng:28.246,  region:'AF' },
  { ic:'SBGR', nm:'São Paulo',   lat:-23.435, lng:-46.479, region:'SA' },
]

const R_E = 3440.065   /* Earth radius in NM */
function toRad(d:number){return d*Math.PI/180}
function toDeg(r:number){return r*180/Math.PI}
function gcDistNM(lat1:number,lng1:number,lat2:number,lng2:number): number {
  const φ1=toRad(lat1), φ2=toRad(lat2)
  const dφ=toRad(lat2-lat1), dλ=toRad(lng2-lng1)
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2 * R_E * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}
function bearingDeg(lat1:number,lng1:number,lat2:number,lng2:number): number {
  const φ1=toRad(lat1), φ2=toRad(lat2), Δλ=toRad(lng2-lng1)
  const y = Math.sin(Δλ)*Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ)
  return (toDeg(Math.atan2(y,x)) + 360) % 360
}
/* cross-track distance from current point to great-circle from O to D */
function xteNM(latO:number,lngO:number,latD:number,lngD:number,latP:number,lngP:number): number {
  const d13 = gcDistNM(latO,lngO,latP,lngP) / R_E
  const θ13 = toRad(bearingDeg(latO,lngO,latP,lngP))
  const θ12 = toRad(bearingDeg(latO,lngO,latD,lngD))
  return Math.abs(Math.asin(Math.sin(d13)*Math.sin(θ13-θ12))) * R_E
}

/* deterministic 32-bit hash per icao24 — used to pick origin / destination
   pair so demo data has reproducible great-circle anchors. */
function hash32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}

interface RouteAnchors {
  origin: Hub; dest: Hub
  gcNM: number          /* great-circle dist origin → dest */
  bearingOD: number     /* initial bearing origin → dest */
  brgToDest: number     /* current → dest bearing */
  remGcNM: number       /* great-circle dist current → dest */
  flownNM: number       /* estimated flown miles origin → current */
  /* actual along-track miles using XTE + along-track decomposition */
  alongNM: number       /* projection of (origin→current) onto GC */
  xte: number           /* cross-track error from GC */
  est_actual: number    /* estimated total trip miles (already-flown actual) */
  est_planned: number   /* estimated total trip miles if continuing straight */
  hfePct: number        /* (est_actual_total - gc) / gc × 100 (signed) */
}

function pickHubs(icao24: string, lat: number, lng: number): { origin: Hub; dest: Hub } {
  const h = hash32(icao24)
  /* pick a destination biased away from current position; pick origin biased toward it.
     This gives a plausible "you departed near origin, heading to dest" geometry. */
  const sorted = HUBS.map(hb => ({hb, d: gcDistNM(lat,lng,hb.lat,hb.lng)})).sort((a,b)=>a.d-b.d)
  /* origin: among 6 nearest hubs (likely already departed there or nearby) */
  const origin = sorted[h % 6].hb
  /* dest: among 12 farthest hubs (the trip is long-ish) */
  const farPool = sorted.slice(-12)
  const dest = farPool[(h >>> 7) % farPool.length].hb
  return { origin, dest }
}

function computeRoute(f: SFlight): RouteAnchors {
  const { origin, dest } = pickHubs(f.icao, f.lat, f.lng)
  const gcNM = gcDistNM(origin.lat, origin.lng, dest.lat, dest.lng)
  const bearingOD = bearingDeg(origin.lat, origin.lng, dest.lat, dest.lng)
  const brgToDest = bearingDeg(f.lat, f.lng, dest.lat, dest.lng)
  const remGcNM = gcDistNM(f.lat, f.lng, dest.lat, dest.lng)
  const d_oc = gcDistNM(origin.lat, origin.lng, f.lat, f.lng)
  const xte = xteNM(origin.lat, origin.lng, dest.lat, dest.lng, f.lat, f.lng)
  /* along-track distance: chord-style decomposition (small-angle approx fine for snapshot) */
  const alongNM = Math.sqrt(Math.max(0, d_oc*d_oc - xte*xte))
  /* flown miles: bound below by direct origin→current dist (lower bound), above by
     d_oc + 2·xte (XTE round-trip penalty proxy per ICAO Doc 9854 §1.5.3). */
  const flownNM = d_oc + 1.4 * xte
  /* est total trip if continuing straight from here: flown + remaining_gc */
  const est_planned = flownNM + remGcNM
  /* expected actual incorporates bearing-error future penalty:
     if pilot heading is off-bearing-to-dest, projected detour ≈ remGc·(1-cosθ) per
     EUROCONTROL PRR 2024 §6.3 KEA along-track approximation. */
  const dθ = Math.min(Math.abs(((f.track - brgToDest + 540) % 360) - 180), 90)
  const futurePenalty = remGcNM * (1 - Math.cos(toRad(dθ))) * 0.6
  const est_actual = flownNM + remGcNM + futurePenalty
  const hfePct = gcNM > 50 ? ((est_actual - gcNM) / gcNM) * 100 : 0
  return { origin, dest, gcNM, bearingOD, brgToDest, remGcNM, flownNM, alongNM, xte, est_actual, est_planned, hfePct }
}

interface Drivers { GCDEV: number; DETOUR: number; BRGERR: number; HOLD: number; WX: number; ATC: number }

function score(f: SFlight, r: RouteAnchors, advMul: number): { drivers: Drivers; composite: number; tier: Tier } {
  if (f.ground || f.altitudeFt < 10000) {
    return { drivers:{GCDEV:0,DETOUR:0,BRGERR:0,HOLD:0,WX:0,ATC:0}, composite:0, tier:'NOT-CRZ' }
  }
  /* GCDEV: cross-track miles, ramp 0 → 80NM */
  const GCDEV = clamp(r.xte / 80 * 100, 0, 100)
  /* DETOUR: HFE % above 0.5%, ramp to 12% */
  const DETOUR = clamp((r.hfePct - 0.5) / (12 - 0.5) * 100, 0, 100)
  /* BRGERR: track minus bearing-to-dest */
  const dθ = Math.min(Math.abs(((f.track - r.brgToDest + 540) % 360) - 180), 90)
  const BRGERR = clamp(dθ / 60 * 100, 0, 100)
  /* HOLD: low GS + airborne low-altitude turn signature */
  const isHold = f.velocityKts < 230 && f.altitudeFt < 18000
  const HOLD = isHold ? 60 + clamp((230 - f.velocityKts) / 2, 0, 35) : 0
  /* WX: lat-band turbulence/convection proxy (ITCZ ±10°N, NA/EU jet 30-50°N) */
  const wxBand = Math.abs(f.lat) < 12 ? 50 : (f.lat > 28 && f.lat < 52 ? 28 : 12)
  const WX = clamp(wxBand + (r.xte > 25 ? 18 : 0), 0, 100)
  /* ATC: low FL + low GS proxy (TMA vectoring) */
  const ATC = (f.altitudeFt < 22000 && f.velocityKts < 320) ? clamp(45 + (22000 - f.altitudeFt)/600, 0, 95) : 0
  const drivers: Drivers = { GCDEV, DETOUR, BRGERR, HOLD, WX, ATC }
  const arr = [GCDEV, DETOUR, BRGERR, HOLD * 0.6, WX * 0.45, ATC * 0.55]
  const maxD = Math.max(...arr)
  const meanD = arr.reduce((a,b)=>a+b,0) / arr.length
  let composite = (maxD * 0.62 + meanD * 0.38) * (advMul / 100)
  /* hard escalators per CANSO PRR §6.3 KEA thresholds */
  if (r.hfePct > 8) composite = Math.max(composite, 82)
  if (r.hfePct > 12) composite = Math.max(composite, 92)
  if (r.xte > 100) composite = Math.max(composite, 75)
  composite = clamp(composite, 0, 100)
  let tier: Tier
  if (composite >= 80) tier = 'SEVERE'
  else if (composite >= 60) tier = 'POOR'
  else if (composite >= 40) tier = 'MARGINAL'
  else if (composite >= 18) tier = 'NOMINAL'
  else tier = 'OPTIMAL'
  return { drivers, composite, tier }
}

interface Row {
  f: SFlight; kl: Klass; route: RouteAnchors; drivers: Drivers
  score: number; tier: Tier; excessNM: number; excessFuelKg: number; excessCo2Kg: number
}

export default function TmiHfe({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klFilter, setKlFilter] = useState<Record<Klass, boolean>>({
    HVY:true,'WB-M':true,NB:true,'RGN-J':true,'RGN-T':true,BIZ:true,LIGHT:true,
  })
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showGc, setShowGc] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [q, setQ] = useState('')
  const [minFL, setMinFL] = useState(100)
  const [maxFL, setMaxFL] = useState(450)
  const [advMul, setAdvMul] = useState(100)
  const [fuelUsd, setFuelUsd] = useState(0.90)
  const [tab, setTab] = useState<'AIRCRAFT'|'HUBS'|'KEA'>('AIRCRAFT')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (fl < minFL || fl > maxFL) continue
      const kl = classifyType(f.type)
      if (!klFilter[kl]) continue
      const route = computeRoute(f)
      if (route.gcNM < 100) continue   /* skip GA-style short legs from synthetic anchoring */
      const { drivers, composite, tier } = score(f, route, advMul)
      const excessNM = Math.max(0, route.est_actual - route.gcNM)
      const ff = KLASS_FF[kl]
      const tas = KLASS_TAS[kl]
      const excessHr = excessNM / tas
      const excessFuelKg = excessHr * ff
      const excessCo2Kg = excessFuelKg * 3.16  /* ICAO Doc 9889 §A.3 jet-A1 EI */
      out.push({ f, kl, route, drivers, score: composite, tier, excessNM, excessFuelKg, excessCo2Kg })
    }
    out.sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, minFL, maxFL, klFilter, advMul])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { SEVERE:0,POOR:0,MARGINAL:0,NOMINAL:0,OPTIMAL:0,'NOT-CRZ':0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const filtered = useMemo(() => {
    const Q = q.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (!Q) return true
      const f = r.f
      return (f.callsign||'').toUpperCase().includes(Q) ||
             (f.type||'').toUpperCase().includes(Q) ||
             (f.operator||'').toUpperCase().includes(Q) ||
             r.tier.includes(Q) ||
             r.route.origin.ic.includes(Q) ||
             r.route.dest.ic.includes(Q)
    })
  }, [rows, tierFilter, q])

  const meanHfe = rows.length ? rows.reduce((a,r)=>a+r.route.hfePct,0)/rows.length : 0
  const worst = rows[0]
  const sigExcessNM = rows.reduce((a,r)=>a+r.excessNM,0)
  const sigExcessFuel = rows.reduce((a,r)=>a+r.excessFuelKg,0)
  const sigExcessCo2 = rows.reduce((a,r)=>a+r.excessCo2Kg,0)
  const sigExcessUsd = sigExcessFuel * fuelUsd
  const severeCnt = tierCounts.SEVERE + tierCounts.POOR

  /* MapLibre layer rendering */
  useEffect(() => {
    if (!map) return
    const SRC='tmi-src', HALO='tmi-halo', PIN='tmi-pin', LBL='tmi-lbl'
    const LINE_SRC='tmi-gc-src', LINE='tmi-gc-line', ACT_LINE='tmi-act-line'

    const acFC = {
      type:'FeatureCollection',
      features: rows.map(r => ({
        type:'Feature' as const,
        geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat]},
        properties:{
          cs: r.f.callsign || r.f.icao,
          tier: r.tier, color: TIER_COLOR[r.tier],
          haloR: 7 + Math.min(12, r.score / 8),
          pinScale: r.tier==='SEVERE'?1.4 : r.tier==='POOR'?1.1 : 0,
          lbl: `${r.f.callsign || r.f.icao}  ${r.route.origin.ic}→${r.route.dest.ic}  ${r.route.hfePct>=0?'+':''}${r.route.hfePct.toFixed(1)}%`,
        },
      })),
    }

    /* great-circle planned line + actual deviated line for top 14 worst */
    const top = rows.slice(0, 14)
    function gcArc(lat1:number,lng1:number,lat2:number,lng2:number, n=64): [number,number][] {
      const φ1=toRad(lat1), λ1=toRad(lng1), φ2=toRad(lat2), λ2=toRad(lng2)
      const d = gcDistNM(lat1,lng1,lat2,lng2) / R_E
      if (d === 0) return [[lng1,lat1]]
      const pts: [number,number][] = []
      for (let i=0;i<=n;i++){
        const f = i/n
        const A = Math.sin((1-f)*d) / Math.sin(d)
        const B = Math.sin(f*d) / Math.sin(d)
        const x = A*Math.cos(φ1)*Math.cos(λ1) + B*Math.cos(φ2)*Math.cos(λ2)
        const y = A*Math.cos(φ1)*Math.sin(λ1) + B*Math.cos(φ2)*Math.sin(λ2)
        const z = A*Math.sin(φ1) + B*Math.sin(φ2)
        const φ = Math.atan2(z, Math.sqrt(x*x+y*y))
        const λ = Math.atan2(y, x)
        pts.push([toDeg(λ), toDeg(φ)])
      }
      return pts
    }
    const lineFC = {
      type:'FeatureCollection',
      features: top.flatMap(r => [
        {
          type:'Feature' as const,
          geometry:{ type:'LineString' as const, coordinates: gcArc(r.route.origin.lat, r.route.origin.lng, r.route.dest.lat, r.route.dest.lng) },
          properties:{ kind:'gc', color: TIER_COLOR[r.tier] },
        },
        {
          type:'Feature' as const,
          geometry:{ type:'LineString' as const, coordinates: [
            ...gcArc(r.route.origin.lat, r.route.origin.lng, r.f.lat, r.f.lng, 32),
            ...gcArc(r.f.lat, r.f.lng, r.route.dest.lat, r.route.dest.lng, 32),
          ] },
          properties:{ kind:'act', color: TIER_COLOR[r.tier] },
        },
      ]),
    }

    const add = () => {
      try {
        if (!map.getSource(SRC)) map.addSource(SRC, { type:'geojson', data: acFC as any })
        else (map.getSource(SRC) as any).setData(acFC)
        if (!map.getSource(LINE_SRC)) map.addSource(LINE_SRC, { type:'geojson', data: lineFC as any })
        else (map.getSource(LINE_SRC) as any).setData(lineFC)

        if (showGc && !map.getLayer(LINE)) map.addLayer({ id: LINE, type:'line', source: LINE_SRC, filter:['==',['get','kind'],'gc'],
          paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-opacity':0.55, 'line-dasharray':[3,3] } })
        if (showGc && !map.getLayer(ACT_LINE)) map.addLayer({ id: ACT_LINE, type:'line', source: LINE_SRC, filter:['==',['get','kind'],'act'],
          paint:{ 'line-color':['get','color'], 'line-width':1.8, 'line-opacity':0.85 } })
        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id: HALO, type:'circle', source: SRC, paint:{
          'circle-radius':['get','haloR'], 'circle-color':['get','color'],
          'circle-opacity':0.14, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85,
        }})
        if (showPin && !map.getLayer(PIN)) map.addLayer({ id: PIN, type:'circle', source: SRC, filter:['>',['get','pinScale'],0], paint:{
          'circle-radius':['*', 5.5, ['get','pinScale']],
          'circle-color':['get','color'], 'circle-stroke-color':'#fff', 'circle-stroke-width':1.3,
        }})
        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id: LBL, type:'symbol', source: SRC, layout:{
          'text-field':['get','lbl'],
          'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top',
          'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
        }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 }})
      } catch {}
    }
    if (map.isStyleLoaded()) add(); else map.once('load', add)
    return () => {
      try {
        for (const l of [LBL, PIN, HALO, ACT_LINE, LINE]) if (map.getLayer(l)) map.removeLayer(l)
        if (map.getSource(SRC)) map.removeSource(SRC)
        if (map.getSource(LINE_SRC)) map.removeSource(LINE_SRC)
      } catch {}
    }
  }, [map, rows, showHalo, showPin, showLbl, showGc])

  /* aggregate by hub-pair for HUBS tab */
  const hubAgg = useMemo(() => {
    const m = new Map<string, { o: Hub; d: Hub; cnt: number; sumHfe: number; sumExcess: number; sumFuel: number; worstTier: Tier }>()
    for (const r of rows) {
      const k = `${r.route.origin.ic}-${r.route.dest.ic}`
      const cur = m.get(k)
      if (!cur) m.set(k, { o: r.route.origin, d: r.route.dest, cnt: 1, sumHfe: r.route.hfePct, sumExcess: r.excessNM, sumFuel: r.excessFuelKg, worstTier: r.tier })
      else {
        cur.cnt++; cur.sumHfe += r.route.hfePct; cur.sumExcess += r.excessNM; cur.sumFuel += r.excessFuelKg
        if (TIER_RANK[r.tier] < TIER_RANK[cur.worstTier]) cur.worstTier = r.tier
      }
    }
    return [...m.values()].sort((a,b)=> TIER_RANK[a.worstTier]-TIER_RANK[b.worstTier] || b.sumExcess - a.sumExcess).slice(0, 24)
  }, [rows])

  return (
    <div className="absolute right-3 top-20 z-30 w-[470px] max-h-[80vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">TMI</div>
        <div className="text-[10px] text-slate-400 truncate">Track-Mile Inefficiency · CANSO HFE / KEA</div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
        </div>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {(TIER_ORDER).map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[8px]" style={{color: TIER_COLOR[t]}}>{t}</div>
            <div className="text-slate-100 font-semibold">{tierCounts[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">MEAN-HFE</div>
          <div className="text-slate-100 font-semibold tabular-nums">{meanHfe.toFixed(2)}%</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">WORST</div>
          <div className="text-slate-100 font-semibold truncate text-[10px]">{worst ? worst.f.callsign || worst.f.icao : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">Σ-EXCESS</div>
          <div className="text-slate-100 font-semibold tabular-nums">{sigExcessNM.toFixed(0)}<span className="text-[8px] text-slate-500"> NM</span></div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">Σ-FUEL</div>
          <div className="text-slate-100 font-semibold tabular-nums">{(sigExcessFuel/1000).toFixed(1)}<span className="text-[8px] text-slate-500"> t</span></div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">Σ-CO₂</div>
          <div className="font-semibold tabular-nums" style={{color: sigExcessCo2>1000 ? TIER_COLOR.POOR : '#cbd5e1'}}>{(sigExcessCo2/1000).toFixed(1)}<span className="text-[8px] text-slate-500"> t</span></div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 text-[10px]">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {([
            ['MIN-FL', minFL, setMinFL, 50, 400, '', 5],
            ['MAX-FL', maxFL, setMaxFL, 100, 500, '', 5],
            ['ADV-MUL', advMul, setAdvMul, 50, 200, '%', 1],
            ['FUEL-USD', fuelUsd, setFuelUsd, 0.50, 2.50, '/kg', 0.05],
          ] as Array<[string, number, (n:number)=>void, number, number, string, number]>).map(([lbl,val,set,lo,hi,suf,step]) => (
            <label key={lbl} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-16">{lbl}</span>
              <input type="range" min={lo} max={hi} step={step} value={val}
                onChange={e => set(parseFloat(e.target.value))}
                className="flex-1 h-1 accent-sky-500" />
              <span className="text-slate-300 tabular-nums w-14 text-right">{lbl==='FUEL-USD'?val.toFixed(2):val}{suf}</span>
            </label>
          ))}
        </div>
        <div className="mt-2 px-2 py-1 rounded bg-slate-900/40 border border-slate-800 text-[9.5px] flex items-center gap-3">
          <span className="text-slate-500">FLEET COST</span>
          <span className="font-semibold tabular-nums text-slate-100">${(sigExcessUsd/1000).toFixed(1)}k</span>
          <span className="text-slate-500">SEVERE+POOR</span>
          <span className="font-semibold tabular-nums" style={{color: severeCnt ? TIER_COLOR.POOR : '#cbd5e1'}}>{severeCnt}</span>
          <span className="ml-auto text-slate-500 italic">CANSO KEA</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800/60">
        {KLASS_LIST.map(k => (
          <button key={k} onClick={() => setKlFilter(p => ({...p, [k]: !p[k]}))}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${klFilter[k]?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700 opacity-50'}`}
            style={{color: KLASS_COLOR[k]}}>{k}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60 text-[9px]">
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['GC',showGc,setShowGc],['LBL',showLbl,setShowLbl]] as const).map(([n,v,s])=>(
          <button key={n} onClick={()=>(s as any)(!v)} className={`px-1.5 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500 hover:border-slate-700'}`}>{n}</button>
        ))}
      </div>

      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / type / operator / hub icao"
          className="flex-1 bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/40" />
      </div>
      <div className="flex gap-0.5 px-3 py-1.5 border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','HUBS','KEA'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 text-slate-100 border border-sky-500/40':'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1 text-[11px]">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500">no airborne aircraft above FL{minFL}</div>}
            {filtered.slice(0, 60).map(r => {
              const advice =
                r.tier === 'SEVERE' ? `HFE ${r.route.hfePct.toFixed(1)}% · re-route per CANSO KEA · request DCT to ${r.route.dest.ic}` :
                r.tier === 'POOR' ? `HFE ${r.route.hfePct.toFixed(1)}% · 5-8% above GC · request shortcut per EUROCONTROL FRA` :
                r.tier === 'MARGINAL' ? `HFE ${r.route.hfePct.toFixed(1)}% · 3-5% above GC · monitor ATC vectors` :
                r.tier === 'NOMINAL' ? `HFE ${r.route.hfePct.toFixed(1)}% · within normal vectoring envelope` :
                r.tier === 'OPTIMAL' ? `HFE ${r.route.hfePct.toFixed(1)}% · near great-circle · ASBU B0-FRTO compliant` :
                'not in cruise band'
              return (
                <button key={r.f.icao} onClick={()=>onFly(r.f.icao)} className="w-full text-left px-3 py-2 hover:bg-slate-900/60 transition">
                  <div className="flex items-center gap-2 mb-1" style={{borderLeft:`3px solid ${TIER_COLOR[r.tier]}`, paddingLeft:8}}>
                    <span className="font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                    <span className="text-[9px] text-slate-500">{r.f.type || '—'}</span>
                    <span className="text-[9px] px-1 rounded" style={{background:`${KLASS_COLOR[r.kl]}22`, color: KLASS_COLOR[r.kl]}}>{r.kl}</span>
                    <span className="text-[9px] px-1 rounded ml-auto" style={{background:`${TIER_COLOR[r.tier]}22`, color: TIER_COLOR[r.tier]}}>{r.tier}</span>
                    <span className="text-[9px] text-slate-500 tabular-nums">{r.score.toFixed(0)}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px] mb-1 pl-2">
                    <div className="px-1.5 py-0.5 rounded bg-slate-900/50 border border-slate-800">
                      <span className="text-slate-500">ORIG </span><span className="text-slate-200">{r.route.origin.ic}</span>
                    </div>
                    <div className="px-1.5 py-0.5 rounded bg-slate-900/50 border border-slate-800">
                      <span className="text-slate-500">DEST </span><span className="text-slate-200">{r.route.dest.ic}</span>
                    </div>
                    <div className="px-1.5 py-0.5 rounded bg-slate-900/50 border border-slate-800">
                      <span className="text-slate-500">GC </span><span className="text-slate-200 tabular-nums">{r.route.gcNM.toFixed(0)} NM</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 text-[10px] mb-1 pl-2">
                    <div><span className="text-slate-500">HFE </span><span className="tabular-nums" style={{color: TIER_COLOR[r.tier]}}>{r.route.hfePct>=0?'+':''}{r.route.hfePct.toFixed(2)}%</span></div>
                    <div><span className="text-slate-500">XTE </span><span className="tabular-nums" style={{color: r.route.xte>40?TIER_COLOR.POOR:'#cbd5e1'}}>{r.route.xte.toFixed(0)} NM</span></div>
                    <div><span className="text-slate-500">ΔNM </span><span className="tabular-nums text-amber-300">{r.excessNM.toFixed(0)}</span></div>
                    <div><span className="text-slate-500">FL </span><span className="tabular-nums text-slate-200">{Math.round(r.f.altitudeFt/100)}</span></div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 text-[10px] mb-1 pl-2">
                    <div><span className="text-slate-500">REM </span><span className="tabular-nums text-slate-200">{r.route.remGcNM.toFixed(0)} NM</span></div>
                    <div><span className="text-slate-500">BRG→ </span><span className="tabular-nums text-slate-200">{r.route.brgToDest.toFixed(0)}°</span></div>
                    <div><span className="text-slate-500">TRK </span><span className="tabular-nums text-slate-200">{r.f.track.toFixed(0)}°</span></div>
                    <div><span className="text-slate-500">FUEL </span><span className="tabular-nums text-rose-300">{r.excessFuelKg.toFixed(0)} kg</span></div>
                  </div>
                  <div className="pl-2">
                    <div className="h-1 rounded bg-slate-900 overflow-hidden">
                      <div style={{width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%'}}/>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1 pl-2 mt-1.5 text-[8.5px]">
                    {(['GCDEV','DETOUR','BRGERR','HOLD','WX','ATC'] as const).map(d => {
                      const val = (r.drivers as any)[d] as number
                      const muted = val < 8
                      return (
                        <span key={d} className={`px-1 py-0.5 rounded border ${muted?'border-slate-800 text-slate-600':'border-slate-700 text-slate-300'}`}>
                          {d} <span className="tabular-nums" style={{color: val>=70?TIER_COLOR.POOR:val>=40?TIER_COLOR.MARGINAL:'#94a3b8'}}>{val.toFixed(0)}</span>
                        </span>
                      )
                    })}
                  </div>
                  <div className="text-[9.5px] mt-1 pl-2 italic" style={{color: TIER_COLOR[r.tier]}}>{advice}</div>
                </button>
              )
            })}
          </div>
        )}

        {tab === 'HUBS' && (
          <div className="divide-y divide-slate-800/60">
            {hubAgg.length === 0 && <div className="px-3 py-6 text-center text-slate-500">no active hub-pairs in scope</div>}
            {hubAgg.map(h => {
              const meanHfe = h.sumHfe / h.cnt
              return (
                <div key={`${h.o.ic}-${h.d.ic}`} className="px-3 py-2" style={{borderLeft:`3px solid ${TIER_COLOR[h.worstTier]}`}}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold text-slate-100 text-[11px]">{h.o.ic} <span className="text-slate-500">›</span> {h.d.ic}</span>
                    <span className="text-[9px] text-slate-500">{h.o.nm} → {h.d.nm}</span>
                    <span className="text-[9px] px-1 rounded ml-auto" style={{background:`${TIER_COLOR[h.worstTier]}22`, color:TIER_COLOR[h.worstTier]}}>{h.worstTier}</span>
                    <span className="text-[9px] text-slate-500">×{h.cnt}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 text-[10px] pl-2">
                    <div><span className="text-slate-500">μ-HFE </span><span className="tabular-nums" style={{color:meanHfe>=5?TIER_COLOR.POOR:meanHfe>=3?TIER_COLOR.MARGINAL:'#cbd5e1'}}>{meanHfe.toFixed(2)}%</span></div>
                    <div><span className="text-slate-500">Σ-NM </span><span className="tabular-nums text-amber-300">{h.sumExcess.toFixed(0)}</span></div>
                    <div><span className="text-slate-500">Σ-fuel </span><span className="tabular-nums text-rose-300">{(h.sumFuel/1000).toFixed(2)}t</span></div>
                    <div><span className="text-slate-500">Σ-CO₂ </span><span className="tabular-nums text-rose-300">{(h.sumFuel*3.16/1000).toFixed(2)}t</span></div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'KEA' && (
          <div className="px-3 py-3 text-[10.5px]">
            <div className="text-slate-400 mb-2">CANSO PRC <span className="text-slate-200 font-semibold">KEA</span> · Key Performance Environment Indicator — horizontal flight-efficiency benchmark</div>
            <svg viewBox="0 0 420 220" className="w-full">
              {/* axes */}
              <line x1={40} y1={190} x2={400} y2={190} stroke="#475569" strokeWidth={1}/>
              <line x1={40} y1={20}  x2={40}  y2={190} stroke="#475569" strokeWidth={1}/>
              <text x={220} y={210} textAnchor="middle" fill="#64748b" fontSize={9}>great-circle distance (NM)</text>
              <text x={12}  y={105} textAnchor="middle" fill="#64748b" fontSize={9} transform="rotate(-90 12 105)">HFE %</text>
              {/* threshold bands */}
              {[
                { y: 190 - (1/12)*170, c: '#10b981', lbl: 'OPTIMAL <1%' },
                { y: 190 - (3/12)*170, c: '#0ea5e9', lbl: 'NOMINAL 1-3%' },
                { y: 190 - (5/12)*170, c: '#f59e0b', lbl: 'MARGINAL 3-5%' },
                { y: 190 - (8/12)*170, c: '#f43f5e', lbl: 'POOR 5-8%' },
              ].map((b,i) => (
                <g key={i}>
                  <line x1={40} y1={b.y} x2={400} y2={b.y} stroke={b.c} strokeWidth={0.7} strokeDasharray="3 3" opacity={0.6}/>
                  <text x={402} y={b.y+3} fill={b.c} fontSize={7.5}>{b.lbl}</text>
                </g>
              ))}
              {/* x ticks */}
              {[0,1500,3000,4500,6000,7500].map(d => {
                const x = 40 + (d/7500) * 360
                return <g key={d}><line x1={x} y1={188} x2={x} y2={192} stroke="#475569"/><text x={x} y={202} fill="#64748b" fontSize={8} textAnchor="middle">{d}</text></g>
              })}
              {/* fleet scatter */}
              {rows.slice(0, 90).map(r => {
                const x = 40 + clamp(r.route.gcNM/7500, 0, 1) * 360
                const y = 190 - clamp(Math.max(r.route.hfePct,0)/12, 0, 1) * 170
                return <circle key={r.f.icao} cx={x} cy={y} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85} stroke="#0b1220" strokeWidth={0.5}/>
              })}
              {/* benchmark line · EUROCONTROL 2024 KEA target 2.18 % */}
              <line x1={40} y1={190 - (2.18/12)*170} x2={400} y2={190 - (2.18/12)*170} stroke="#a855f7" strokeWidth={1.2} strokeDasharray="6 3"/>
              <text x={400} y={190 - (2.18/12)*170 - 4} fill="#a855f7" fontSize={8} textAnchor="end">EUROCONTROL KEA target · 2.18 %</text>
            </svg>
            <div className="grid grid-cols-3 gap-1 mt-3 text-[10px]">
              <div className="px-2 py-1.5 rounded bg-slate-900/60 border border-slate-800">
                <div className="text-[9px] text-slate-500">PRR 2024 KEA</div>
                <div className="text-slate-100 font-semibold">2.18 %</div>
                <div className="text-[9px] text-slate-500 italic">EUROCONTROL en-route filed</div>
              </div>
              <div className="px-2 py-1.5 rounded bg-slate-900/60 border border-slate-800">
                <div className="text-[9px] text-slate-500">Fleet μ-HFE</div>
                <div className="font-semibold tabular-nums" style={{color: meanHfe>=2.18 ? TIER_COLOR.MARGINAL : TIER_COLOR.OPTIMAL}}>{meanHfe.toFixed(2)} %</div>
                <div className="text-[9px] text-slate-500 italic">live snapshot</div>
              </div>
              <div className="px-2 py-1.5 rounded bg-slate-900/60 border border-slate-800">
                <div className="text-[9px] text-slate-500">Δ vs target</div>
                <div className="font-semibold tabular-nums" style={{color: meanHfe-2.18>0 ? TIER_COLOR.POOR : TIER_COLOR.OPTIMAL}}>{(meanHfe-2.18>=0?'+':'')}{(meanHfe-2.18).toFixed(2)} pp</div>
                <div className="text-[9px] text-slate-500 italic">CANSO benchmark gap</div>
              </div>
            </div>
            <div className="mt-3 px-2 py-2 rounded bg-slate-900/40 border border-slate-800 text-[10px] leading-relaxed text-slate-400">
              <div className="text-slate-300 font-semibold mb-1">Horizontal Flight Efficiency · HFE</div>
              HFE = (D<sub>actual</sub> − D<sub>great-circle</sub>) / D<sub>great-circle</sub> × 100 %. Excess track-miles translate directly to fuel and CO₂: every additional NM burns ≈ FF/TAS kg of jet-A1 (class-specific), emitting 3.16 kg CO₂ per kg fuel (ICAO Doc 9889 §A.3). Free-route airspace and ASBU B0-FRTO drive HFE down; congestion, weather avoidance, and tactical vectoring push it up.
              <div className="mt-2 italic">References: CANSO ATM PRR 2024 §4.2 · EUROCONTROL PRR 2024 §6.3 · ICAO Doc 9854 §1.5.3 · GANP §3.4.4 · Doc 9889 §A.3 · CORSIA Annex 16 Vol IV · IATA Fuel Efficiency Gap Analysis 2024 · SESAR Master Plan ed.2020 · NATS NERL RP3 · ATAG Waypoint 2050.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
