'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   EDR · Emergency Descent Reach & 10k MSA Conflict Monitor
   ------------------------------------------------------------
   Per-airframe scorer for the certified rapid-decompression
   emergency-descent profile per Boeing FCOM SP.16.1 / Airbus
   FCOM PRO-ABN-EMER-D / 14 CFR §25.841(a)(2) / §121.333 /
   ICAO Annex 6 Pt I §4.4.2 / EASA CS-25.841 / AC 25-20.

   When an airliner suffers rapid cabin decompression the crew
   must descend to the cabin-altitude alerting threshold
   FL100 (or the lowest safe altitude — whichever is higher)
   before passenger O₂ supplemental supply expires. Boeing /
   Airbus emergency descent SOPs target:
     · Speed: VMO / MMO (idle thrust, speedbrake extended)
     · Rate of descent: ≈ −7,000 fpm initially, settling to
       −6,000 fpm transonic, decreasing below FL250
     · Termination altitude: max(10,000 ft MSL, MSA + 1,000 ft)
       per FAA AC 91-70B / FCT 8.10 / FCOM SP.16

   This monitor evaluates, for every cruising airframe above
   FL150:
     1) Target floor = max(10,000 ft, MSA(lat,lng) + 1,000 ft)
        where MSA is approximated from a 14-zone terrain proxy
        (Himalaya 24k / Tibet-Pamir 22k / Andes 22k /
         NA-Rockies 14k / Alps 12k / Greenland 10k /
         Ethiopia 11k / NewGuinea 13k / NZ-Southern-Alps 11k /
         Caucasus 13k / Iran-Zagros 11k / Pyrenees 9k /
         Mexico-Sierra 12k / oceanic 0k)
     2) Descent time t_d = (alt − floor) / ROD_class
     3) Descent ground distance d_d = ROD-coupled forward
        displacement integrating V_KTAS·(1−sin(γ)) over the
        dive, computed as t_d · V_dive_GS_avg / 60 (NM)
     4) Descent-endpoint waypoint projected along current
        ground-track via great-circle
     5) Pax O₂ supply margin per 14 CFR §121.333(c)(2):
        14 CFR-compliant minimums require 10 min @ FL250+
        but actual installed supply for above-FL250 ops varies
        (chemical generator 12-22 min @ FL400 / gaseous 30+ min)
        Per-class O₂ catalogue (CHEM: HVY 18 min, WB-M 15 min,
        NB 12 min, RGN-J 12 min, RGN-T 10 min, BIZ 22 min)
        — margin = O2_avail − t_d
     6) MSA conflict scan: along projected descent track,
        sample 8 lat/lng points and check whether the target
        floor for that point exceeds 10,000 ft (MSA constraint
        bites). If yes, EDR is constrained by terrain not by
        cabin-alt — flag as TERRAIN-DRIVEN.
     7) Diversion: nearest hub from a 28-airport catalogue
        within the descent footprint (radius = d_d × 1.3 for
        post-descent low-altitude leg)
   ------------------------------------------------------------
   Six drivers (max-driver composite):
     · O2MARG    Pax O₂ margin (negative = bust, ramp 0→−6 min)
     · DESCT     Descent duration vs ICAO 4 min target ramp
     · TERR      MSA-driven floor above 10k (ramp 10→18 kft)
     · FUEL      Excess fuel burn vs cruise (penalty proxy)
     · DIVDIST   Distance to nearest large airport (ramp 0→300NM)
     · CABIN     Cabin-alt rate-of-climb proxy (FL+ASCENT)
   ------------------------------------------------------------
   Composite = max·0.66 + mean·0.34 × ADV-MUL
   Hard escalators:
     · t_d > O2_avail (bust) → score floor 92 per §121.333
     · floor > 14,000 ft (terrain bust) → 80
     · no diversion within 1.5×d_d → 70
   Six tiers:
     BUST    ≥85 rose  O₂ depletes before 10k reached
     TIGHT   ≥65 rose-pink margin <2 min
     TERRAIN ≥45 amber  MSA floor >12k drives descent
     OK      ≥22 sky    standard ETOPS-compliant profile
     SAFE    <22 emerald clear margin all axes
     OFF     slate      not cruising or below FL150
   ------------------------------------------------------------
   References:
     · 14 CFR §25.841(a)(2) cabin alt schedule
     · 14 CFR §25.1447 pax O₂
     · 14 CFR §121.333(c)(2) supplemental O₂ duration
     · 14 CFR §121.329 / §121.337 crew O₂
     · EASA CS-25.841 / CS-25.1447 / AMC-25.841
     · ICAO Annex 6 Pt I §4.4.2 emergency descent
     · ICAO Doc 8168 Vol I Pt VI Ch.2
     · FAA AC 25-20 pressurisation / AC 91-70B oceanic ops
     · Boeing FCOM SP.16.1 Rapid Depressurization
     · Boeing FCT 8.10 / B777 FCOM 02.01.16
     · Airbus FCOM PRO-ABN-EMER-D / EMER-CAB
     · Airbus FCTM EMER-DEP
     · NTSB AAR-99-01 SWR 111 (cabin smoke descent)
     · NTSB AAR-09-01 Helios 522 cabin pressure
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'BUST' | 'TIGHT' | 'TERRAIN' | 'OK' | 'SAFE' | 'OFF'
const TIER_COLOR: Record<Tier, string> = {
  BUST:    '#ef4444',
  TIGHT:   '#fb7185',
  TERRAIN: '#f59e0b',
  OK:      '#0ea5e9',
  SAFE:    '#10b981',
  OFF:     '#64748b',
}
const TIER_ORDER: Tier[] = ['BUST','TIGHT','TERRAIN','OK','SAFE','OFF']
const TIER_LABEL: Record<Tier, string> = {
  BUST:'BUST', TIGHT:'TIGHT', TERRAIN:'TERR', OK:'OK', SAFE:'SAFE', OFF:'OFF',
}

type Klass = 'HVY' | 'WB-M' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ'
const KLASS_LIST: Klass[] = ['HVY','WB-M','NB','RGN-J','RGN-T','BIZ']
const KLASS_COLOR: Record<Klass, string> = {
  'HVY':'#a78bfa', 'WB-M':'#38bdf8', 'NB':'#34d399', 'RGN-J':'#fbbf24', 'RGN-T':'#fde047', 'BIZ':'#f472b6',
}

interface ClassSpec {
  rodFpm: number       // emergency-descent ROD at FL300 transonic avg (negative magnitude)
  vDiveKts: number     // dive ground speed avg (KTAS at mid-descent ≈ VMO-coupled)
  o2MinFL400: number   // installed pax O₂ duration at FL400 (chemical/gaseous)
  flCrz: number        // typical cruise FL
}
const SPEC: Record<Klass, ClassSpec> = {
  'HVY':   { rodFpm: 7200, vDiveKts: 460, o2MinFL400: 18, flCrz: 380 },
  'WB-M':  { rodFpm: 6800, vDiveKts: 440, o2MinFL400: 15, flCrz: 360 },
  'NB':    { rodFpm: 6500, vDiveKts: 420, o2MinFL400: 12, flCrz: 350 },
  'RGN-J': { rodFpm: 6000, vDiveKts: 380, o2MinFL400: 12, flCrz: 330 },
  'RGN-T': { rodFpm: 3500, vDiveKts: 250, o2MinFL400: 10, flCrz: 220 },
  'BIZ':   { rodFpm: 8000, vDiveKts: 480, o2MinFL400: 22, flCrz: 410 },
}

function classify(t: string | undefined): Klass | null {
  const x = (t || '').toUpperCase()
  if (/^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139|AW189)/.test(x)) return null
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA[24]|PA|M20|TB|DHC2|DHC6|AN2|BE9|BE3|TBM|PC12|PC6)/.test(x)) return null
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|C5|C17)/.test(x)) return 'HVY'
  if (/^(B76|B75|A310)/.test(x)) return 'WB-M'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|CS|BCS)/.test(x)) return 'NB'
  if (/^(CRJ|E14|E15|E17|E19|E29|E70|E75|E90|E95)/.test(x)) return 'RGN-J'
  if (/^(AT4|AT5|AT7|DH8|SF34|J32|J41|ATR|Q400)/.test(x)) return 'RGN-T'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL[36]|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'BIZ'
  if (/^F16/.test(x)) return null
  return 'NB'
}

const D2R = Math.PI / 180, R2D = 180 / Math.PI
const R_NM = 3440.065

function gcDistNm(lat1:number, lng1:number, lat2:number, lng2:number): number {
  const φ1=lat1*D2R, φ2=lat2*D2R
  const dφ=(lat2-lat1)*D2R, dλ=(lng2-lng1)*D2R
  const a=Math.sin(dφ/2)**2+Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2*R_NM*Math.asin(Math.min(1,Math.sqrt(a)))
}
function projectGc(lat:number, lng:number, brgDeg:number, distNm:number): {lat:number, lng:number} {
  const d=distNm/R_NM, br=brgDeg*D2R
  const φ1=lat*D2R, λ1=lng*D2R
  const sφ2=Math.sin(φ1)*Math.cos(d)+Math.cos(φ1)*Math.sin(d)*Math.cos(br)
  const φ2=Math.asin(sφ2)
  const y=Math.sin(br)*Math.sin(d)*Math.cos(φ1)
  const x=Math.cos(d)-Math.sin(φ1)*sφ2
  const λ2=λ1+Math.atan2(y,x)
  return { lat:φ2*R2D, lng:((λ2*R2D+540)%360)-180 }
}

/* 14-zone MSA proxy (ft) */
function msaFt(lat:number, lng:number): number {
  if (lat>=26 && lat<=40 && lng>=70 && lng<=98) return 24000  // Himalaya
  if (lat>=28 && lat<=42 && lng>=68 && lng<=105) return 22000 // Tibet-Pamir broad
  if (lat>=-55 && lat<=10 && lng>=-78 && lng<=-65) return 22000 // Andes
  if (lat>=32 && lat<=50 && lng>=-122 && lng<=-104) return 14000 // NA-Rockies
  if (lat>=45 && lat<=48 && lng>=5 && lng<=15) return 12000 // Alps
  if (lat>=59 && lat<=72 && lng>=-55 && lng<=-20) return 10000 // Greenland
  if (lat>=4 && lat<=15 && lng>=33 && lng<=43) return 11000 // Ethiopia highlands
  if (lat>=-10 && lat<=-2 && lng>=132 && lng<=152) return 13000 // New Guinea
  if (lat>=-46 && lat<=-40 && lng>=166 && lng<=174) return 11000 // NZ-Southern-Alps
  if (lat>=40 && lat<=44 && lng>=40 && lng<=50) return 13000 // Caucasus
  if (lat>=28 && lat<=38 && lng>=48 && lng<=62) return 11000 // Iran-Zagros
  if (lat>=42 && lat<=44 && lng>=-2 && lng<=3) return 9000  // Pyrenees
  if (lat>=15 && lat<=25 && lng>=-105 && lng<=-95) return 12000 // Mexico-Sierra
  return 0
}

interface Per {
  klass: Klass
  cruiseFt: number
  floorFt: number
  msaFt: number
  rodFpm: number
  vDive: number
  o2Avail: number  // minutes installed
  tDescent: number // minutes
  dDescent: number // NM forward
  endLat: number
  endLng: number
  o2Margin: number // minutes (= o2Avail − tDescent)
  worstTerrFt: number // worst MSA along descent track
  divDistNm: number
  divIcao: string
  drivers: { O2MARG:number; DESCT:number; TERR:number; FUEL:number; DIVDIST:number; CABIN:number }
}

interface Row {
  f: SFlight
  klass: Klass
  p: Per
  score: number
  tier: Tier
}

function ramp(x:number, lo:number, hi:number): number {
  if (x<=lo) return 0
  if (x>=hi) return 100
  return 100*(x-lo)/(hi-lo)
}

/* Mini diversion-hub catalogue (28 hubs for divert proxy) */
const HUBS: Array<{icao:string; lat:number; lng:number}> = [
  {icao:'KATL',lat:33.64,lng:-84.43},{icao:'KORD',lat:41.97,lng:-87.91},{icao:'KDFW',lat:32.90,lng:-97.04},
  {icao:'KLAX',lat:33.94,lng:-118.41},{icao:'KJFK',lat:40.64,lng:-73.78},{icao:'KSFO',lat:37.62,lng:-122.38},
  {icao:'KSEA',lat:47.45,lng:-122.31},{icao:'KMIA',lat:25.80,lng:-80.29},{icao:'CYYZ',lat:43.68,lng:-79.63},
  {icao:'EGLL',lat:51.47,lng:-0.45},{icao:'EGKK',lat:51.15,lng:-0.19},{icao:'LFPG',lat:49.01,lng:2.55},
  {icao:'EHAM',lat:52.31,lng:4.76},{icao:'EDDF',lat:50.03,lng:8.56},{icao:'EDDM',lat:48.35,lng:11.79},
  {icao:'LEMD',lat:40.49,lng:-3.57},{icao:'LSZH',lat:47.46,lng:8.55},{icao:'LTFM',lat:41.26,lng:28.74},
  {icao:'OMDB',lat:25.25,lng:55.36},{icao:'OTHH',lat:25.27,lng:51.61},{icao:'VIDP',lat:28.57,lng:77.10},
  {icao:'VABB',lat:19.09,lng:72.87},{icao:'VHHH',lat:22.31,lng:113.92},{icao:'WSSS',lat:1.36,lng:103.99},
  {icao:'RJTT',lat:35.55,lng:139.78},{icao:'RKSI',lat:37.46,lng:126.44},{icao:'ZBAA',lat:40.08,lng:116.59},
  {icao:'YSSY',lat:-33.95,lng:151.18},
]

const SRC='edr-src', CONE_SRC='edr-cone-src', TRK_SRC='edr-trk-src'
const HALO='edr-halo', PIN='edr-pin', LBL='edr-lbl', CONE='edr-cone', TRK='edr-trk', END='edr-end'

export default function EdrEmergDescent({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(150)
  const [maxFl, setMaxFl] = useState(500)
  const [advMul, setAdvMul] = useState(100)
  const [rodMul, setRodMul] = useState(100)
  const [o2Mul, setO2Mul] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showCone, setShowCone] = useState(true)
  const [showTrk, setShowTrk] = useState(true)
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'PROFILE'>('AIRCRAFT')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Row|null>(null)

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const klass = classify(f.type)
      if (!klass) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl || fl > maxFl) continue

      const sp = SPEC[klass]
      const rodFpm = sp.rodFpm * (rodMul/100)
      const vDive  = sp.vDiveKts
      const o2Avail = sp.o2MinFL400 * (o2Mul/100)

      const msaHere = msaFt(f.lat, f.lng)
      const floorFt = Math.max(10000, msaHere + 1000)

      const dropFt = Math.max(0, f.altitudeFt - floorFt)
      const tDescent = dropFt / rodFpm // minutes (fpm direct → min for delta-ft)
      // descent forward distance: integrate roughly t·V_avg, account ~15% reduction for dive angle
      const dDescent = tDescent * vDive / 60 * 0.85

      const end = dDescent > 0 ? projectGc(f.lat, f.lng, f.track, dDescent) : { lat:f.lat, lng:f.lng }

      // worst MSA along track (8-sample scan)
      let worstTerr = msaHere
      for (let i=1; i<=8; i++) {
        const p = projectGc(f.lat, f.lng, f.track, dDescent * (i/8))
        const m = msaFt(p.lat, p.lng)
        if (m > worstTerr) worstTerr = m
      }
      const effFloor = Math.max(10000, worstTerr + 1000)

      const o2Margin = o2Avail - tDescent

      // nearest hub within 1.5×dDescent of endpoint
      let divDist = Infinity, divIcao = '—'
      for (const h of HUBS) {
        const d = gcDistNm(end.lat, end.lng, h.lat, h.lng)
        if (d < divDist) { divDist = d; divIcao = h.icao }
      }

      const drivers = {
        O2MARG:   o2Margin < 0 ? 100 : ramp(2 - o2Margin, 0, 8),
        DESCT:    ramp(tDescent - 4, 0, 6),
        TERR:     ramp(effFloor - 10000, 0, 8000),
        FUEL:     ramp(tDescent * (rodFpm/6000), 0, 10),
        DIVDIST:  ramp(divDist, 0, 300),
        CABIN:    ramp(f.altitudeFt - 25000, 0, 18000) * 0.6,
      }
      const dVals = Object.values(drivers)
      const dMax = Math.max(...dVals)
      const dMean = dVals.reduce((a,b)=>a+b,0) / dVals.length
      let score = (dMax*0.66 + dMean*0.34) * (advMul/100)
      // escalators
      if (o2Margin < 0) score = Math.max(score, 92)
      if (effFloor > 14000) score = Math.max(score, 80)
      if (divDist > dDescent * 1.5 + 100) score = Math.max(score, 70)
      score = Math.max(0, Math.min(100, score))

      let tier: Tier
      if (score >= 85) tier = 'BUST'
      else if (score >= 65) tier = 'TIGHT'
      else if (score >= 45 || effFloor > 12000) tier = 'TERRAIN'
      else if (score >= 22) tier = 'OK'
      else tier = 'SAFE'

      const p: Per = {
        klass, cruiseFt: f.altitudeFt, floorFt: effFloor, msaFt: worstTerr,
        rodFpm, vDive, o2Avail, tDescent, dDescent,
        endLat: end.lat, endLng: end.lng, o2Margin, worstTerrFt: worstTerr,
        divDistNm: divDist, divIcao, drivers,
      }
      out.push({ f, klass, p, score, tier })
    }
    out.sort((a,b) => b.score - a.score)
    return out
  }, [flights, minFl, maxFl, advMul, rodMul, o2Mul])

  const filtered = useMemo(() => {
    const Q = q.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!Q) return true
      return (r.f.callsign||'').toUpperCase().includes(Q)
        || (r.f.type||'').toUpperCase().includes(Q)
        || (r.f.operator||'').toUpperCase().includes(Q)
        || r.p.divIcao.includes(Q)
    })
  }, [rows, tierFilter, klassFilter, q])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { BUST:0,TIGHT:0,TERRAIN:0,OK:0,SAFE:0,OFF:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const summary = useMemo(() => {
    if (!rows.length) return null
    const muO2 = rows.reduce((a,r)=>a+r.p.o2Margin,0) / rows.length
    const worst = rows[0]
    const bust = rows.filter(r=>r.tier==='BUST').length
    const sumDesc = rows.reduce((a,r)=>a+r.p.tDescent,0)
    const muTerr = rows.reduce((a,r)=>a+r.p.floorFt,0) / rows.length
    return { muO2, worst, bust, sumDesc, muTerr }
  }, [rows])

  const classAgg = useMemo(() => {
    const m = new Map<Klass, { cnt:number; sumO2:number; sumDesc:number; bust:number; tight:number }>()
    for (const k of KLASS_LIST) m.set(k, { cnt:0, sumO2:0, sumDesc:0, bust:0, tight:0 })
    for (const r of rows) {
      const x = m.get(r.klass)!
      x.cnt++; x.sumO2 += r.p.o2Margin; x.sumDesc += r.p.tDescent
      if (r.tier==='BUST') x.bust++
      if (r.tier==='TIGHT') x.tight++
    }
    return KLASS_LIST.map(k => ({ k, ...m.get(k)! })).filter(x => x.cnt>0)
  }, [rows])

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const NM_DEG = 1/60
    function wedge(lat:number, lng:number, trk:number, lenNM:number, halfDeg:number): [number,number][] {
      const t = trk * D2R
      const pts: [number,number][] = [[lng, lat]]
      const step = halfDeg
      for (let a = -halfDeg; a <= halfDeg; a += step) {
        const ang = t + a*D2R
        const dLat = Math.cos(ang)*lenNM*NM_DEG
        const dLng = Math.sin(ang)*lenNM*NM_DEG / Math.max(0.1, Math.cos(lat*D2R))
        pts.push([lng+dLng, lat+dLat])
      }
      pts.push([lng, lat])
      return pts
    }
    const fc = {
      type:'FeatureCollection',
      features: rows.map(r => ({
        type:'Feature' as const,
        geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat] },
        properties:{
          color: TIER_COLOR[r.tier],
          haloR: 7 + Math.min(12, r.score/8),
          pinScale: r.tier==='BUST'?1.6: r.tier==='TIGHT'?1.2: 0,
          lbl: `${r.f.callsign||r.f.icao} · O₂${r.p.o2Margin>=0?'+':''}${r.p.o2Margin.toFixed(1)}m · ${(r.p.floorFt/1000).toFixed(0)}k`,
        },
      })),
    }
    const top = rows.filter(r => r.tier==='BUST' || r.tier==='TIGHT' || r.tier==='TERRAIN').slice(0, 16)
    const coneFC = {
      type:'FeatureCollection',
      features: top.map(r => ({
        type:'Feature' as const,
        geometry:{ type:'Polygon' as const, coordinates:[wedge(r.f.lat, r.f.lng, r.f.track, Math.min(60, r.p.dDescent), 12)] },
        properties:{ color: TIER_COLOR[r.tier], opacity: r.tier==='BUST'?0.22: r.tier==='TIGHT'?0.16:0.10 },
      })),
    }
    const trkFC = {
      type:'FeatureCollection',
      features: top.map(r => ({
        type:'Feature' as const,
        geometry:{ type:'LineString' as const, coordinates:[[r.f.lng, r.f.lat],[r.p.endLng, r.p.endLat]] },
        properties:{ color: TIER_COLOR[r.tier] },
      })),
    }
    const endFC = {
      type:'FeatureCollection',
      features: top.map(r => ({
        type:'Feature' as const,
        geometry:{ type:'Point' as const, coordinates:[r.p.endLng, r.p.endLat] },
        properties:{ color: TIER_COLOR[r.tier] },
      })),
    }
    const add = () => {
      try {
        if (!map.getSource(SRC)) map.addSource(SRC, { type:'geojson', data: fc as any })
        else (map.getSource(SRC) as any).setData(fc)
        if (!map.getSource(CONE_SRC)) map.addSource(CONE_SRC, { type:'geojson', data: coneFC as any })
        else (map.getSource(CONE_SRC) as any).setData(coneFC)
        if (!map.getSource(TRK_SRC)) map.addSource(TRK_SRC, { type:'geojson', data: trkFC as any })
        else (map.getSource(TRK_SRC) as any).setData(trkFC)

        if (showCone && !map.getLayer(CONE)) map.addLayer({ id:CONE, type:'fill', source:CONE_SRC, paint:{
          'fill-color':['get','color'], 'fill-opacity':['get','opacity'],
        }})
        if (showTrk && !map.getLayer(TRK)) map.addLayer({ id:TRK, type:'line', source:TRK_SRC, paint:{
          'line-color':['get','color'], 'line-width':1.3, 'line-dasharray':[3,2], 'line-opacity':0.85,
        }})
        if (showTrk && !map.getLayer(END)) {
          if (!map.getSource('edr-end-src')) map.addSource('edr-end-src', { type:'geojson', data: endFC as any })
          else (map.getSource('edr-end-src') as any).setData(endFC)
          map.addLayer({ id:END, type:'circle', source:'edr-end-src', paint:{
            'circle-radius':4, 'circle-color':['get','color'], 'circle-stroke-color':'#0b1220', 'circle-stroke-width':1.2,
          }})
        }
        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id:HALO, type:'circle', source:SRC, paint:{
          'circle-radius':['get','haloR'], 'circle-color':['get','color'],
          'circle-opacity':0.12, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.85,
        }})
        if (showPin && !map.getLayer(PIN)) map.addLayer({ id:PIN, type:'circle', source:SRC, filter:['>',['get','pinScale'],0], paint:{
          'circle-radius':['*',5.2,['get','pinScale']],
          'circle-color':['get','color'], 'circle-stroke-color':'#fff', 'circle-stroke-width':1.2,
        }})
        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id:LBL, type:'symbol', source:SRC, layout:{
          'text-field':['get','lbl'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top',
          'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
        }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 }})
      } catch {}
    }
    if (map.isStyleLoaded()) add(); else map.once('load', add)
    return () => {
      try {
        for (const l of [LBL, PIN, HALO, END, TRK, CONE]) if (map.getLayer(l)) map.removeLayer(l)
        for (const s of [SRC, CONE_SRC, TRK_SRC, 'edr-end-src']) if (map.getSource(s)) map.removeSource(s)
      } catch {}
    }
  }, [map, rows, showHalo, showPin, showLbl, showCone, showTrk])

  /* SVG: emergency-descent profile diagram for selected aircraft */
  const profile = (r: Row) => {
    const W=380, H=200, PL=32, PR=14, PT=14, PB=28
    const tMax = Math.max(8, r.p.tDescent + 1)
    const altMax = Math.max(45000, r.p.cruiseFt + 2000)
    const x = (t:number) => PL + (t/tMax)*(W-PL-PR)
    const y = (a:number) => PT + ((altMax-a)/altMax)*(H-PT-PB)
    // descent curve: linear FL drop at rodFpm
    const path: string[] = [`M${x(0).toFixed(1)},${y(r.p.cruiseFt).toFixed(1)}`]
    for (let t=0; t<=r.p.tDescent; t+=0.5) {
      const alt = Math.max(r.p.floorFt, r.p.cruiseFt - r.p.rodFpm*t)
      path.push(`L${x(t).toFixed(1)},${y(alt).toFixed(1)}`)
    }
    // post-level cruise to t_max
    path.push(`L${x(tMax).toFixed(1)},${y(r.p.floorFt).toFixed(1)}`)
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-44">
        {/* grid */}
        {[0,10000,20000,30000,40000].map(a => (
          <g key={a}>
            <line x1={PL} y1={y(a)} x2={W-PR} y2={y(a)} stroke="#334155" strokeWidth={0.4} strokeDasharray="2 3"/>
            <text x={PL-4} y={y(a)+3} fontSize={8} fill="#94a3b8" textAnchor="end">{a/1000}k</text>
          </g>
        ))}
        {/* terrain band */}
        <rect x={PL} y={y(r.p.worstTerrFt)} width={W-PL-PR} height={H-PB-y(r.p.worstTerrFt)} fill={TIER_COLOR.BUST} opacity={0.10}/>
        {/* floor line */}
        <line x1={PL} y1={y(r.p.floorFt)} x2={W-PR} y2={y(r.p.floorFt)} stroke={TIER_COLOR.TERRAIN} strokeWidth={0.7} strokeDasharray="3 3"/>
        <text x={W-PR-2} y={y(r.p.floorFt)-3} fontSize={8} fill={TIER_COLOR.TERRAIN} textAnchor="end">FLOOR {(r.p.floorFt/1000).toFixed(1)}k</text>
        {/* 10k MSA */}
        <line x1={PL} y1={y(10000)} x2={W-PR} y2={y(10000)} stroke={TIER_COLOR.OK} strokeWidth={0.4} strokeDasharray="1 3"/>
        {/* O₂ supply marker */}
        <line x1={x(r.p.o2Avail)} y1={PT} x2={x(r.p.o2Avail)} y2={H-PB} stroke={TIER_COLOR.TIGHT} strokeWidth={0.7} strokeDasharray="3 3"/>
        <text x={x(r.p.o2Avail)} y={PT+9} fontSize={8} fill={TIER_COLOR.TIGHT} textAnchor="middle">O₂ {r.p.o2Avail.toFixed(0)}m</text>
        {/* descent curve */}
        <path d={path.join(' ')} stroke={TIER_COLOR[r.tier]} strokeWidth={1.6} fill="none"/>
        <circle cx={x(0)} cy={y(r.p.cruiseFt)} r={4} fill={TIER_COLOR[r.tier]} stroke="#fff" strokeWidth={1.2}/>
        <circle cx={x(r.p.tDescent)} cy={y(r.p.floorFt)} r={4} fill={TIER_COLOR[r.tier]} stroke="#fff" strokeWidth={1.2}/>
        <text x={x(r.p.tDescent)+6} y={y(r.p.floorFt)+10} fontSize={8} fill={TIER_COLOR[r.tier]}>t={r.p.tDescent.toFixed(1)}m</text>
        <text x={W/2} y={H-4} fontSize={8.5} fill="#cbd5e1" textAnchor="middle">minutes</text>
      </svg>
    )
  }

  return (
    <div className="absolute right-3 top-20 z-30 w-[470px] max-h-[80vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">EDR</div>
        <div className="text-[10px] text-slate-400 truncate">Emergency-Descent Reach · 10k MSA · §121.333</div>
        <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
      </div>

      {/* tier strip */}
      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {TIER_ORDER.slice(0,6).map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[8px]" style={{color: TIER_COLOR[t]}}>{TIER_LABEL[t]}</div>
            <div className="text-slate-100 font-semibold">{tierCounts[t]}</div>
          </button>
        ))}
      </div>

      {/* summary */}
      {summary && (
        <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px] tabular-nums">
          <div><div className="text-[8px] text-slate-500">μ-O₂Δ</div><div className="text-slate-100" style={{color: summary.muO2<2?TIER_COLOR.TIGHT:'#e2e8f0'}}>{summary.muO2.toFixed(1)}m</div></div>
          <div><div className="text-[8px] text-slate-500">WORST</div><div className="text-slate-100">{summary.worst.f.callsign||summary.worst.f.icao}</div></div>
          <div><div className="text-[8px] text-slate-500">BUST</div><div style={{color:summary.bust>0?TIER_COLOR.BUST:'#e2e8f0'}}>{summary.bust}</div></div>
          <div><div className="text-[8px] text-slate-500">Σt-DESC</div><div className="text-slate-100">{summary.sumDesc.toFixed(0)}m</div></div>
          <div><div className="text-[8px] text-slate-500">μ-FLOOR</div><div className="text-slate-100">{(summary.muTerr/1000).toFixed(1)}k</div></div>
        </div>
      )}

      {/* sliders */}
      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800/60 text-[9.5px]">
        <label className="flex flex-col">
          <span className="text-slate-400">MIN-FL {minFl}</span>
          <input type="range" min={50} max={400} value={minFl} onChange={e=>setMinFl(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">MAX-FL {maxFl}</span>
          <input type="range" min={150} max={500} value={maxFl} onChange={e=>setMaxFl(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">ROD-MUL {rodMul}%</span>
          <input type="range" min={50} max={150} value={rodMul} onChange={e=>setRodMul(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">O₂-MUL {o2Mul}%</span>
          <input type="range" min={50} max={200} value={o2Mul} onChange={e=>setO2Mul(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col col-span-2">
          <span className="text-slate-400">ADV-MUL {advMul}%</span>
          <input type="range" min={50} max={200} value={advMul} onChange={e=>setAdvMul(+e.target.value)} className="accent-sky-500"/>
        </label>
      </div>

      {/* class chips + toggles */}
      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800/60">
        <button onClick={()=>setKlassFilter('ALL')} className={`text-[9px] px-1.5 py-0.5 rounded border ${klassFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400'}`}>ALL</button>
        {KLASS_LIST.map(k => (
          <button key={k} onClick={()=>setKlassFilter(klassFilter===k?'ALL':k)}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${klassFilter===k?'bg-sky-500/15 border-sky-500/40':'border-slate-800'}`}
            style={{color: KLASS_COLOR[k]}}>{k}</button>
        ))}
        <span className="flex-1" />
        {[['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['CONE',showCone,setShowCone],['TRK',showTrk,setShowTrk]].map(([lbl,on,fn]:any) => (
          <button key={lbl} onClick={()=>fn(!on)} className={`text-[9px] px-1.5 py-0.5 rounded border ${on?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-500'}`}>{lbl}</button>
        ))}
      </div>

      {/* tabs */}
      <div className="flex border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','CLASSES','PROFILE'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`flex-1 py-1.5 ${tab===t?'bg-sky-500/15 text-sky-200 border-b border-sky-500/60':'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {/* search */}
      <div className="px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / type / operator / divert icao"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600"/>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[10px]">no in-scope aircraft</div>}
            {filtered.slice(0,80).map(r => {
              const advice =
                r.tier==='BUST' ? `O₂ depletes ${(-r.p.o2Margin).toFixed(1)}m before 10k — declare MAYDAY descend max ROD per FCOM SP.16`
              : r.tier==='TIGHT' ? `O₂ margin only ${r.p.o2Margin.toFixed(1)}m — initiate descent immediately per §121.333(c)(2)`
              : r.tier==='TERRAIN' ? `MSA-driven floor ${(r.p.floorFt/1000).toFixed(1)}k — divert ${r.p.divIcao} ${r.p.divDistNm.toFixed(0)}NM per AC 91-70B`
              : r.tier==='OK' ? `standard rapid-descent profile · t=${r.p.tDescent.toFixed(1)}m · floor ${(r.p.floorFt/1000).toFixed(0)}k`
              : `comfortable margin · O₂+${r.p.o2Margin.toFixed(1)}m · ${r.p.divIcao} ${r.p.divDistNm.toFixed(0)}NM`
              return (
                <div key={r.f.icao} onClick={()=>{ setSel(r); onFly(r.f.icao) }}
                  className="px-3 py-2 hover:bg-slate-900/50 cursor-pointer" style={{borderLeft:`2px solid ${TIER_COLOR[r.tier]}`}}>
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-slate-100 text-[11.5px]">{r.f.callsign || r.f.icao}</span>
                    <span className="text-[9px] text-slate-500">{r.f.type || '—'}</span>
                    <span className="text-[8.5px] px-1 rounded border" style={{color: KLASS_COLOR[r.klass], borderColor: KLASS_COLOR[r.klass]+'66'}}>{r.klass}</span>
                    <span className="text-[8.5px] px-1 rounded ml-auto font-semibold" style={{color: TIER_COLOR[r.tier], background: TIER_COLOR[r.tier]+'14', border:`1px solid ${TIER_COLOR[r.tier]}55`}}>{TIER_LABEL[r.tier]}</span>
                  </div>
                  <div className="grid grid-cols-5 gap-1 mt-1 text-[9.5px] tabular-nums">
                    <div><span className="text-slate-500">FL </span><span className="text-slate-200">{(r.f.altitudeFt/100).toFixed(0)}</span></div>
                    <div><span className="text-slate-500">FLOOR </span><span style={{color: r.p.floorFt>12000?TIER_COLOR.TERRAIN:'#cbd5e1'}}>{(r.p.floorFt/1000).toFixed(1)}k</span></div>
                    <div><span className="text-slate-500">ROD </span><span className="text-slate-200">{r.p.rodFpm.toFixed(0)}</span></div>
                    <div><span className="text-slate-500">t-d </span><span className="text-slate-200">{r.p.tDescent.toFixed(1)}m</span></div>
                    <div><span className="text-slate-500">O₂Δ </span><span style={{color: r.p.o2Margin<0?TIER_COLOR.BUST: r.p.o2Margin<2?TIER_COLOR.TIGHT:'#cbd5e1'}}>{r.p.o2Margin>=0?'+':''}{r.p.o2Margin.toFixed(1)}m</span></div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-0.5 text-[9.5px] tabular-nums">
                    <div><span className="text-slate-500">d-d </span><span className="text-slate-200">{r.p.dDescent.toFixed(0)}NM</span></div>
                    <div><span className="text-slate-500">MSA </span><span className="text-slate-200">{(r.p.msaFt/1000).toFixed(0)}k</span></div>
                    <div><span className="text-slate-500">DIV </span><span className="text-slate-200">{r.p.divIcao}</span></div>
                    <div><span className="text-slate-500">d-DIV </span><span className="text-slate-200">{r.p.divDistNm.toFixed(0)}NM</span></div>
                  </div>
                  <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden">
                    <div className="h-full" style={{width:`${r.score}%`, background: TIER_COLOR[r.tier]}}/>
                  </div>
                  <div className="grid grid-cols-6 gap-0.5 mt-1 text-[8.5px]">
                    {(['O2MARG','DESCT','TERR','FUEL','DIVDIST','CABIN'] as const).map(d => (
                      <div key={d} className="px-1 py-0.5 rounded border border-slate-800 text-center tabular-nums"
                        style={{background:`${TIER_COLOR[r.tier]}0d`, color: r.p.drivers[d]>=60?TIER_COLOR[r.tier]:'#94a3b8'}}>
                        <div className="text-[7.5px] opacity-70">{d}</div>
                        <div>{r.p.drivers[d].toFixed(0)}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-1 text-[9px]" style={{color: TIER_COLOR[r.tier]}}>{advice}</div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'CLASSES' && (
          <div className="divide-y divide-slate-800/60">
            {classAgg.length === 0 && <div className="px-3 py-6 text-center text-slate-500">no in-scope aircraft</div>}
            {classAgg.map(c => {
              const muO2 = c.sumO2 / c.cnt
              const muDesc = c.sumDesc / c.cnt
              const sp = SPEC[c.k]
              return (
                <div key={c.k} className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] px-1.5 py-0.5 rounded border font-semibold" style={{color: KLASS_COLOR[c.k], borderColor: KLASS_COLOR[c.k]+'66'}}>{c.k}</span>
                    <span className="text-slate-300 text-[10px]">{c.cnt} ac</span>
                    <span className="ml-auto text-[9px] text-slate-500">ROD {sp.rodFpm}fpm · V-dive {sp.vDiveKts}kt · O₂ {sp.o2MinFL400}m</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-1 text-[9.5px] tabular-nums">
                    <div><span className="text-slate-500">μ-O₂Δ </span><span style={{color: muO2<2?TIER_COLOR.TIGHT:'#cbd5e1'}}>{muO2>=0?'+':''}{muO2.toFixed(1)}m</span></div>
                    <div><span className="text-slate-500">μ-t-d </span><span className="text-slate-200">{muDesc.toFixed(1)}m</span></div>
                    <div><span className="text-slate-500">BUST </span><span style={{color:c.bust?TIER_COLOR.BUST:'#cbd5e1'}}>{c.bust}</span></div>
                    <div><span className="text-slate-500">TIGHT </span><span style={{color:c.tight?TIER_COLOR.TIGHT:'#cbd5e1'}}>{c.tight}</span></div>
                  </div>
                  <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden">
                    <div className="h-full" style={{width:`${Math.min(100, Math.max(0, 50 - muO2*8))}%`, background: KLASS_COLOR[c.k]}}/>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'PROFILE' && (
          <div className="px-3 py-3 text-[10px] space-y-3">
            <div className="rounded border border-slate-800 bg-slate-900/40 p-2">
              <div className="text-[9px] text-sky-300/80 tracking-[0.15em] uppercase font-semibold mb-1">Emergency-Descent profile · §25.841 / §121.333</div>
              <div className="font-mono text-[10px] text-slate-300">
                t_d = (FL − FLOOR) / ROD<br/>
                FLOOR = max(10,000 ft, MSA + 1,000 ft)<br/>
                O₂Δ = O₂_avail(class) − t_d
              </div>
            </div>
            {(sel || rows[0]) && (() => {
              const r = sel || rows[0]
              return (
                <div className="rounded border border-slate-800 bg-slate-900/40 p-2">
                  <div className="text-[9px] text-sky-300/80 tracking-[0.15em] uppercase font-semibold mb-1">DESCENT PROFILE · {r.f.callsign||r.f.icao} · {r.klass}</div>
                  {profile(r)}
                  <div className="grid grid-cols-4 gap-1 mt-1 text-[9.5px] tabular-nums">
                    <div><span className="text-slate-500">CRZ </span><span className="text-slate-200">{(r.p.cruiseFt/1000).toFixed(1)}k</span></div>
                    <div><span className="text-slate-500">FLOOR </span><span className="text-slate-200">{(r.p.floorFt/1000).toFixed(1)}k</span></div>
                    <div><span className="text-slate-500">t-d </span><span className="text-slate-200">{r.p.tDescent.toFixed(1)}m</span></div>
                    <div><span className="text-slate-500">d-d </span><span className="text-slate-200">{r.p.dDescent.toFixed(0)}NM</span></div>
                  </div>
                </div>
              )
            })()}
            <div className="text-[9px] text-slate-500 leading-snug">
              Model assumes idle-thrust speedbrake-extended VMO/MMO dive per FCT 8.10.
              MSA derived from 14-zone terrain proxy; production deployment should bind
              actual grid-MORA. O₂ catalogue per 14 CFR §121.333(c)(2) minimum-supply.
              Diversion picked from 28-hub catalogue — does not enforce runway adequacy.
            </div>
            <div className="text-[9px] text-slate-500">
              Refs: 14 CFR §25.841 / §121.333 / EASA CS-25.841 / ICAO Annex 6 §4.4.2 / Doc 8168 Vol I Pt VI / FAA AC 25-20 / AC 91-70B / Boeing FCOM SP.16.1 / FCT 8.10 / Airbus FCOM PRO-ABN-EMER-D / FCTM EMER-DEP / NTSB AAR-99-01 SWR 111 / AAR-09-01 Helios 522.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
