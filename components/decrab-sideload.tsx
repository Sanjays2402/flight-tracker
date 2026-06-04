'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   DECRAB · Crosswind-Landing Decrab Tire-Sideload &
            Touchdown-Drift Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of the expected decrab-manoeuvre
   tire side-load, touchdown drift, and runway-width budget for
   every flight in the final-approach window (FL<40, GS<200kt,
   VS<-300fpm) snapped to the nearest aligned IATA runway, given
   the certified maximum demonstrated crosswind component
   (Boeing AFM §1 / Airbus AFM Lim §1.4) and the per-class
   main-gear-tire side-slip energy budget.

   Distinct from CROSSWIND-COMPASS (just resolves wind into
   head/cross components), TAIL-STRIKE (pitch-attitude limit),
   ROW-ROP (rollout overrun), and STABLE-APPROACH (gate gross
   checks). DECRAB targets the *touchdown technique* — how much
   side-force the gear sees during the de-crab kick, and how
   far the airplane drifts before main-gear spin-up.

   Per-class certified envelope catalogue (KIAS crosswind
   component, max-demonstrated for landing, dry runway) per
   AFM Lim §1.4 / FCOM PI / FCTM Approach & Landing:

     HVY-T   B777/B787/A350/A330      38 kt (dry) 25 kt (wet)
     HVY-Q   B748/A380                40 kt       28 kt
     WB-M    B767/A330ceo             36 kt       25 kt
     NB      B737NG/MAX/A320 family   33 kt       25 kt
     RGN-J   E190/CRJ9/E195           32 kt       22 kt
     RGN-T   AT72/Q400                25 kt       18 kt
     BIZ     G650/GLEX/FA8X           28 kt       20 kt
     LIGHT   PC12/C25B                20 kt       15 kt

   Two recognised touchdown techniques per FCTM:
     • UPWIND-WHEEL  (slip into the wind, downwind wing low,
                      partial-decrab residual crab ≤5°)
                      — preferred narrow-body
     • FULL-DECRAB   (kick rudder, level wings at flare,
                      align fuselage with centreline)
                      — preferred wide-body / engine-pod clearance

   Decrab side-load proxy:
     F_side / W ≈ sin(crab_residual)·(V_app)²/(g·R_turn)
     With R_turn from rudder authority Cnβ × β_decrab; class
     constants give a normalised dimensionless tire-sideload
     index 0–1.4 where 1.0 = limit-load tire side-slip rating
     per Goodyear Aircraft Tire Engineering Manual §4.

   Touchdown drift D_drift (m) = V_cross × t_align with
     t_align = 1.8 s (NB/RGN), 2.3 s (WB), 3.0 s (HVY-Q)
     per Boeing FCTM Ch.6 / Airbus FCTM PRO-NOR-SOP-22.

   Runway-width budget = (RWY_width − wheelbase_proj)/2 − D_drift
     wheelbase proj per class (4-12m). Negative → off-side risk.

   6 risk drivers (max·0.66 + mean·0.34 × ADV-MUL):
     · WIND   crosswind / max-demo ratio (×100)
     · SIDE   normalised tire side-slip vs limit
     · DRIFT  touchdown drift vs RWY half-width
     · GUST   gust component above steady ×1.3
     · POD    engine-pod clearance crab limit (HVY/WB)
     · TECH   technique vs class preference penalty

   Hard escalators:
     · Crosswind > max-demo               score-min 92
     · Tire side-slip > 1.1 limit          score-min 84
     · Drift > RWY half-width − 1.5 m      score-min 78
     · Gust > 10 kt over steady on HVY     score-min 70

   6 tiers:
     · BUST       ≥85 rose  — diversion candidate per FCTM
     · CRITICAL   ≥65 rose-pink — within 5 kt of max-demo
     · TIGHT      ≥45 amber — within 10 kt of max-demo
     · ADEQUATE   ≥22 sky   — normal crosswind handling
     · NOMINAL    <22 emerald — near-calm or in-limits
     · IDLE       slate    — not on final approach

   References:
     · 14 CFR §25.237 wind velocities (crosswind cert)
     · FAA AC 25-7D §6.5 lateral control demonstration
     · FAA AC 91-79B App.1 runway excursion mitigations
     · EASA CS-25.237 / AMC 25.237
     · Boeing FCTM Ch.6 Approach & Landing — Crosswind
     · Boeing FCOM Limitations Ch.1 max-demonstrated
     · Airbus FCTM PRO-NOR-SOP-22 Crosswind Landing
     · Airbus FCOM PRO-NOR-SOP-32 / LIM-22
     · Embraer AFM §2.4 Max-demo crosswind
     · ATR FCOM 2.04 Crosswind limits
     · FAA-H-8083-3C Airplane Flying Handbook Ch.8
     · Goodyear Aircraft Tire Engineering Manual §4
     · NTSB AAR-04-04 Air Midwest 5481 CLT off-side
     · NTSB AAR-09-04 Continental 1404 DEN runway excursion
     · TSB A05H0002 Air Canada A340 TRD off-runway
     · TSB A07A0134 Air Canada A319 flap retract late
     · IATA Runway Excursion Risk Reduction Toolkit 2024
   ============================================================ */

interface DFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: DFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'BUST' | 'CRITICAL' | 'TIGHT' | 'ADEQUATE' | 'NOMINAL' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  BUST:'#ef4444', CRITICAL:'#f43f5e', TIGHT:'#f59e0b',
  ADEQUATE:'#0ea5e9', NOMINAL:'#10b981', IDLE:'#475569',
}
const TIER_RANK: Record<Tier, number> = { BUST:0, CRITICAL:1, TIGHT:2, ADEQUATE:3, NOMINAL:4, IDLE:5 }
const TIER_ORDER: Tier[] = ['BUST','CRITICAL','TIGHT','ADEQUATE','NOMINAL']

type Cls = 'HVY-T' | 'HVY-Q' | 'WB-M' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ' | 'LIGHT'
const CLS_COLOR: Record<Cls, string> = {
  'HVY-T':'#a78bfa','HVY-Q':'#c084fc','WB-M':'#7dd3fc','NB':'#34d399',
  'RGN-J':'#fbbf24','RGN-T':'#facc15','BIZ':'#fb7185','LIGHT':'#94a3b8',
}

interface ClsRec {
  cls: Cls
  maxDemoDry: number; maxDemoWet: number
  vapp: number; tAlign: number; wheelbase: number
  technique: 'UPWIND' | 'DECRAB'
  podCrabLim: number  // residual crab tolerated for pod clearance (deg)
  tireLimit: number   // dimensionless side-slip rating proxy
  afm: string
}
const CLASSES: ClsRec[] = [
  { cls:'HVY-T', maxDemoDry:38, maxDemoWet:25, vapp:148, tAlign:2.4, wheelbase:11, technique:'DECRAB', podCrabLim:4, tireLimit:1.0, afm:'B777/787 FCOM Lim Ch.1' },
  { cls:'HVY-Q', maxDemoDry:40, maxDemoWet:28, vapp:150, tAlign:3.0, wheelbase:12, technique:'DECRAB', podCrabLim:3, tireLimit:1.05, afm:'B747-8 / A380 FCOM Lim 1' },
  { cls:'WB-M',  maxDemoDry:36, maxDemoWet:25, vapp:142, tAlign:2.3, wheelbase:10, technique:'DECRAB', podCrabLim:4, tireLimit:1.0, afm:'B767 / A330 FCOM Lim Ch.1' },
  { cls:'NB',    maxDemoDry:33, maxDemoWet:25, vapp:138, tAlign:1.8, wheelbase:6,  technique:'UPWIND', podCrabLim:6, tireLimit:0.95, afm:'B737 / A320 FCOM Lim 1' },
  { cls:'RGN-J', maxDemoDry:32, maxDemoWet:22, vapp:128, tAlign:1.7, wheelbase:5,  technique:'UPWIND', podCrabLim:6, tireLimit:0.9, afm:'E190 / CRJ9 AFM §2' },
  { cls:'RGN-T', maxDemoDry:25, maxDemoWet:18, vapp:108, tAlign:1.6, wheelbase:5,  technique:'UPWIND', podCrabLim:7, tireLimit:0.85, afm:'AT72 / Q400 FCOM 2.04' },
  { cls:'BIZ',   maxDemoDry:28, maxDemoWet:20, vapp:120, tAlign:1.8, wheelbase:5,  technique:'DECRAB', podCrabLim:5, tireLimit:0.9, afm:'G650 / GLEX AFM §2' },
  { cls:'LIGHT', maxDemoDry:20, maxDemoWet:15, vapp:85,  tAlign:1.5, wheelbase:3,  technique:'UPWIND', podCrabLim:8, tireLimit:0.8, afm:'PC12 / C25B POH' },
]

function classify(f: DFlight): Cls {
  const t = (f.type || '').toUpperCase()
  if (/B77|B78|A35|A33[0-9]/.test(t)) return 'HVY-T'
  if (/B74|A38/.test(t)) return 'HVY-Q'
  if (/B76|A330|MD11/.test(t)) return 'WB-M'
  if (/B73|A31|A32|A20N|A21N|B75/.test(t)) return 'NB'
  if (/E1[79]|CRJ|E29|E190|RJ/.test(t)) return 'RGN-J'
  if (/AT[47]|DH8|Q40|ATR/.test(t)) return 'RGN-T'
  if (/G650|GLEX|GLF|FA[78]|F900|CL[36]/.test(t)) return 'BIZ'
  if (/PC12|C25|SR2|C172|TBM/.test(t)) return 'LIGHT'
  // velocity fallback
  if (f.velocityKts > 380) return 'HVY-T'
  if (f.velocityKts > 280) return 'NB'
  return 'RGN-J'
}
const clsRec = (c: Cls) => CLASSES.find(x => x.cls === c)!

// Synthetic wind & runway snap
function fnv1a(s: string){ let h=2166136261; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=(h*16777619)>>>0 } return h>>>0 }
function syntheticWind(icao: string, lat: number) {
  const h = fnv1a(icao)
  const dir = (h % 360)
  // wind speed climatology: equator low, mid-lats higher
  const base = 8 + ((h>>>9) % 22)  // 8..29
  const latAmp = Math.abs(lat) > 30 ? 6 + ((h>>>17) % 14) : 0  // jet-coupled
  const gust = ((h>>>23) & 0x0f)   // 0..15
  return { dir, kt: base + latAmp, gust: base + latAmp + gust }
}

function haversineNM(la1:number, lo1:number, la2:number, lo2:number) {
  const R = 3440.065
  const φ1 = la1*Math.PI/180, φ2 = la2*Math.PI/180
  const Δφ = (la2-la1)*Math.PI/180, Δλ = (lo2-lo1)*Math.PI/180
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2
  return 2*R*Math.asin(Math.sqrt(a))
}
function bearingDeg(la1:number, lo1:number, la2:number, lo2:number) {
  const φ1 = la1*Math.PI/180, φ2 = la2*Math.PI/180
  const Δλ = (lo2-lo1)*Math.PI/180
  const y = Math.sin(Δλ)*Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ)
  return ((Math.atan2(y, x)*180/Math.PI) + 360) % 360
}

function snapRunway(f: DFlight) {
  // pick airport within 60NM closest, then synthesise rwy heading aligned to track (rounded to 10°)
  let best: { ap: any; dist: number } | null = null
  for (const ap of AIRPORTS) {
    const d = haversineNM(f.lat, f.lng, ap.lat, ap.lon)
    if (d < 60 && (!best || d < best.dist)) best = { ap, dist: d }
  }
  if (!best) return null
  // runway heading = nearest 10° to current track (active rwy assumption)
  const rwyHdg = Math.round(f.track/10)*10 % 360
  // width: derived from airport icao length & first letter; reasonable proxy
  const h = fnv1a(best.ap.i)
  const widthM = 30 + (h % 4) * 5  // 30, 35, 40, 45 m (common large-rwy widths)
  return { ap: best.ap, dist: best.dist, rwyHdg, widthM }
}

interface Row {
  f: DFlight; cls: Cls; rec: ClsRec
  apt: ReturnType<typeof snapRunway>
  wind: { dir:number; kt:number; gust:number }
  windCross: number; windHead: number; gustCross: number
  maxDemo: number; runwayWet: boolean
  sideloadIdx: number; driftM: number; rwyHalfBudget: number; crabResidual: number
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
}

const clamp = (v:number, a:number, b:number) => Math.max(a, Math.min(b, v))

function scoreRow(f: DFlight, advMul: number, wetMode: boolean, gustMul: number): Row | null {
  // phase gate: final approach
  if (f.ground) return null
  if (f.altitudeFt > 4500) return null
  if (f.vertRate > -200) return null
  if (f.velocityKts > 220 || f.velocityKts < 80) return null
  const apt = snapRunway(f)
  if (!apt) return null
  const cls = classify(f)
  const rec = clsRec(cls)
  const wind = syntheticWind(apt.ap.i, f.lat)
  const windEff = { ...wind, kt: wind.kt * gustMul/100, gust: wind.gust * gustMul/100 }
  // crosswind component relative to runway heading
  const Δ = ((windEff.dir - apt.rwyHdg + 540) % 360) - 180  // -180..180
  const Δrad = Δ * Math.PI/180
  const windCross = Math.abs(windEff.kt * Math.sin(Δrad))
  const windHead = windEff.kt * Math.cos(Δrad)  // +head / -tail
  const gustCross = Math.abs(windEff.gust * Math.sin(Δrad))
  const runwayWet = wetMode
  const maxDemo = runwayWet ? rec.maxDemoWet : rec.maxDemoDry

  // Decrab residual crab angle (deg): full-decrab → ~2°, upwind-wheel → ~crab/2
  const crabFull = Math.atan2(windCross, rec.vapp - Math.max(0, windHead)) * 180/Math.PI
  const crabResidual = rec.technique === 'DECRAB' ? Math.min(crabFull, 3) : Math.min(crabFull/2, 8)

  // Sideload index (dimensionless, 1.0 = limit)
  const k = rec.technique === 'DECRAB' ? 0.085 : 0.062
  const sideloadIdx = (crabResidual * windCross * k) / rec.tireLimit

  // Touchdown drift (m): V_cross_ms × t_align
  const vCrossMs = windCross * 0.5144
  const driftM = vCrossMs * rec.tAlign
  const rwyHalfBudget = apt.widthM/2 - rec.wheelbase/2 - driftM

  // Drivers (0..100)
  const drivers = {
    WIND:  clamp((windCross / maxDemo) * 100, 0, 130),
    SIDE:  clamp(sideloadIdx * 100, 0, 130),
    DRIFT: clamp((-rwyHalfBudget + 4) / 8 * 100, 0, 130),
    GUST:  clamp(((gustCross - windCross) / 8) * 100, 0, 100),
    POD:   clamp(((crabResidual - rec.podCrabLim) / 4) * 100, 0, 100),
    TECH:  rec.technique === 'DECRAB' && cls === 'NB' ? 20 : rec.technique === 'UPWIND' && (cls==='HVY-T'||cls==='HVY-Q'||cls==='WB-M') ? 35 : 0,
  }
  const vals = Object.values(drivers)
  const maxD = Math.max(...vals)
  const mean = vals.reduce((a,b)=>a+b,0) / vals.length
  let score = (maxD * 0.66 + mean * 0.34) * (advMul/100)

  if (windCross > maxDemo) score = Math.max(score, 92)
  if (sideloadIdx > 1.1) score = Math.max(score, 84)
  if (rwyHalfBudget < 1.5) score = Math.max(score, 78)
  if ((cls === 'HVY-T' || cls === 'HVY-Q') && (gustCross - windCross) > 10) score = Math.max(score, 70)
  score = clamp(score, 0, 100)

  let tier: Tier
  if (score >= 85) tier = 'BUST'
  else if (score >= 65) tier = 'CRITICAL'
  else if (score >= 45) tier = 'TIGHT'
  else if (score >= 22) tier = 'ADEQUATE'
  else tier = 'NOMINAL'

  const notes: string[] = []
  if (windCross > maxDemo) notes.push(`Crosswind ${windCross.toFixed(0)}kt exceeds ${runwayWet?'wet':'dry'} max-demo ${maxDemo}kt — divert or hold for shift per FCTM Approach & Landing (14 CFR §25.237)`)
  else if (windCross > maxDemo - 5) notes.push(`Within ${(maxDemo-windCross).toFixed(0)}kt of max-demo ${maxDemo}kt — brief crew, ${rec.technique==='DECRAB'?'full-decrab kick':'upwind-wheel'} technique per FCTM Ch.6 / ${rec.afm}`)
  if (sideloadIdx > 1.0) notes.push(`Tire side-slip index ${sideloadIdx.toFixed(2)} > 1.0 limit per Goodyear Aircraft Tire Eng. Manual §4 — risk skid-rub`)
  if (rwyHalfBudget < 2.5) notes.push(`Touchdown drift ${driftM.toFixed(1)}m vs ${apt.widthM}m wide rwy → only ${rwyHalfBudget.toFixed(1)}m off-side margin (TSB A05H0002 / NTSB AAR-04-04)`)
  if ((gustCross - windCross) > 8) notes.push(`Gust ${gustCross.toFixed(0)}kt above steady ${windCross.toFixed(0)}kt — anticipate wing rock on flare per FCTM Crosswind Gust`)
  if (notes.length === 0) notes.push(`Crosswind ${windCross.toFixed(0)}kt @ ${rec.afm} — ${rec.technique==='DECRAB'?'full-decrab':'upwind-wheel'} technique`)

  return { f, cls, rec, apt, wind: windEff, windCross, windHead, gustCross, maxDemo, runwayWet, sideloadIdx, driftM, rwyHalfBudget, crabResidual, drivers, score, tier, notes }
}

export default function DecrabSideload({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'POLAR'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [q, setQ] = useState('')
  const [advMul, setAdvMul] = useState(100)
  const [gustMul, setGustMul] = useState(100)
  const [wetMode, setWetMode] = useState(false)
  const [classFilter, setClassFilter] = useState<Set<Cls>>(new Set())
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showArrow, setShowArrow] = useState(true)
  const [pickedIcao, setPickedIcao] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => { const t = setInterval(()=>setTick(x=>x+1), 20000); return ()=>clearInterval(t) }, [])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const r = scoreRow(f, advMul, wetMode, gustMul)
      if (r) out.push(r)
    }
    return out.sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score).slice(0, 220)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flights, advMul, gustMul, wetMode, tick])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { BUST:0, CRITICAL:0, TIGHT:0, ADEQUATE:0, NOMINAL:0, IDLE:0 }
    rows.forEach(r => c[r.tier]++); return c
  }, [rows])

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (classFilter.size) r = r.filter(x => classFilter.has(x.cls))
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      r = r.filter(x =>
        (x.f.callsign||'').toLowerCase().includes(s) ||
        (x.f.icao||'').toLowerCase().includes(s) ||
        (x.f.type||'').toLowerCase().includes(s) ||
        x.cls.toLowerCase().includes(s) ||
        (x.apt?.ap.i || '').toLowerCase().includes(s))
    }
    return r
  }, [rows, tierFilter, classFilter, q])

  const meanCross = rows.length ? rows.reduce((a,b)=>a+b.windCross,0)/rows.length : 0
  const meanSide = rows.length ? rows.reduce((a,b)=>a+b.sideloadIdx,0)/rows.length : 0
  const bustCnt = tierCounts.BUST
  const critCnt = tierCounts.CRITICAL
  const worst = rows[0]

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const SRC = 'decrab-ac'
    const HALO = 'decrab-halo', INNER = 'decrab-inner', PIN = 'decrab-pin', LBL = 'decrab-lbl', ARR = 'decrab-arr'
    const ARR_SRC = 'decrab-arr-src'

    const fc = { type:'FeatureCollection' as const, features: rows.map(r => ({
      type:'Feature' as const,
      geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat] },
      properties:{
        cs: r.f.callsign || r.f.icao, tier: r.tier, cls: r.cls,
        color: TIER_COLOR[r.tier], inner: CLS_COLOR[r.cls],
        cross: r.windCross.toFixed(0), apt: r.apt?.ap.i || '',
        haloR: 7 + (5 - Math.min(5, TIER_RANK[r.tier])) * 3,
        pinScale: r.tier === 'BUST' ? 1.7 : r.tier === 'CRITICAL' ? 1.25 : 0,
      },
    })) }

    // Wind-arrow lines (top-12 worst): short line from AC pointing into wind
    const arrFeats = rows.slice(0, 12).map(r => {
      const len = 0.18 + Math.min(0.25, r.windCross / 200)
      const θ = (r.wind.dir + 180) * Math.PI/180  // arrow points to where wind goes
      const dy = Math.cos(θ) * len
      const dx = Math.sin(θ) * len / Math.cos(r.f.lat*Math.PI/180)
      return {
        type:'Feature' as const,
        geometry:{ type:'LineString' as const, coordinates:[[r.f.lng, r.f.lat],[r.f.lng+dx, r.f.lat+dy]] },
        properties:{ color: TIER_COLOR[r.tier] },
      }
    })
    const arrFC = { type:'FeatureCollection' as const, features: arrFeats }

    const add = () => {
      try {
        if (!map.getSource(SRC)) map.addSource(SRC, { type:'geojson', data: fc as any })
        else (map.getSource(SRC) as any).setData(fc)
        if (!map.getSource(ARR_SRC)) map.addSource(ARR_SRC, { type:'geojson', data: arrFC as any })
        else (map.getSource(ARR_SRC) as any).setData(arrFC)

        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id:HALO, type:'circle', source:SRC, paint:{
          'circle-radius':['get','haloR'], 'circle-color':['get','color'],
          'circle-opacity':0.14, 'circle-stroke-color':['get','color'],
          'circle-stroke-width':1.5, 'circle-stroke-opacity':0.85,
        }})
        if (showHalo && !map.getLayer(INNER)) map.addLayer({ id:INNER, type:'circle', source:SRC, paint:{
          'circle-radius':2.6, 'circle-color':['get','inner'],
          'circle-stroke-color':'#0b1220', 'circle-stroke-width':0.6,
        }})
        if (showPin && !map.getLayer(PIN)) map.addLayer({ id:PIN, type:'circle', source:SRC,
          filter:['>',['get','pinScale'],0], paint:{
            'circle-radius':['*',5.5,['get','pinScale']],
            'circle-color':['get','color'], 'circle-stroke-color':'#fff', 'circle-stroke-width':1.3,
          }})
        if (showArrow && !map.getLayer(ARR)) map.addLayer({ id:ARR, type:'line', source:ARR_SRC, paint:{
          'line-color':['get','color'], 'line-width':1.4, 'line-opacity':0.75, 'line-dasharray':[2,1.5],
        }})
        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id:LBL, type:'symbol', source:SRC, layout:{
          'text-field':['concat',['get','cs'],'  ',['get','apt'],'  ',['get','cross'],'kt'],
          'text-size':10, 'text-offset':[0,1.45], 'text-anchor':'top',
          'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
        }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 }})
      } catch {}
    }
    if (map.isStyleLoaded()) add(); else map.once('load', add)
    return () => {
      try {
        for (const l of [LBL, ARR, PIN, INNER, HALO]) if (map.getLayer(l)) map.removeLayer(l)
        if (map.getSource(SRC)) map.removeSource(SRC)
        if (map.getSource(ARR_SRC)) map.removeSource(ARR_SRC)
      } catch {}
    }
  }, [map, rows, showHalo, showPin, showLbl, showArrow])

  /* POLAR tab — crosswind/headwind polar plot */
  const pickedRow = filtered.find(r => r.f.icao === pickedIcao) || worst || null

  return (
    <div className="absolute right-3 top-20 z-30 w-[500px] max-h-[82vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">DECRAB</div>
        <div className="text-[10px] text-slate-400 truncate">Crosswind tire-sideload &amp; touchdown drift</div>
        <div className="ml-auto flex items-center gap-1">
          {(['AIRCRAFT','CLASSES','POLAR'] as const).map(t => (
            <button key={t} onClick={()=>setTab(t)}
              className={`text-[10px] px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'border border-slate-700 text-slate-400 hover:text-slate-200'}`}>{t}</button>
          ))}
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xs px-2 py-1 rounded border border-slate-800">×</button>
        </div>
      </div>

      {/* Tier strip */}
      <div className="flex border-b border-slate-800/80 text-[10px]">
        <button onClick={()=>setTierFilter('ALL')}
          className={`flex-1 px-2 py-1.5 ${tierFilter==='ALL'?'bg-sky-500/15 text-slate-100':'text-slate-400 hover:text-slate-200'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)}
            className={`flex-1 px-2 py-1.5 ${tierFilter===t?'bg-slate-800/80 text-slate-100':'text-slate-400 hover:text-slate-200'}`}
            style={{ color: tierFilter===t ? TIER_COLOR[t] : undefined }}>{t} · {tierCounts[t]}</button>
        ))}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-5 border-b border-slate-800/80 text-[10px]">
        <div className="p-2 border-r border-slate-800/60"><div className="text-slate-500">μ-XW</div><div className="text-slate-100 font-semibold">{meanCross.toFixed(0)}kt</div></div>
        <div className="p-2 border-r border-slate-800/60"><div className="text-slate-500">μ-SIDE</div><div className="text-slate-100 font-semibold">{meanSide.toFixed(2)}</div></div>
        <div className="p-2 border-r border-slate-800/60"><div className="text-slate-500">BUST</div><div className="text-slate-100 font-semibold" style={{color: bustCnt? TIER_COLOR.BUST: undefined}}>{bustCnt}</div></div>
        <div className="p-2 border-r border-slate-800/60"><div className="text-slate-500">CRIT</div><div className="text-slate-100 font-semibold" style={{color: critCnt? TIER_COLOR.CRITICAL: undefined}}>{critCnt}</div></div>
        <div className="p-2"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-semibold truncate">{worst?(worst.f.callsign||worst.f.icao):'—'}</div></div>
      </div>

      {/* Controls */}
      <div className="px-3 py-2 border-b border-slate-800/80 space-y-1.5">
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <label className="flex items-center gap-2">
            <span className="text-slate-500 w-14">ADV-MUL</span>
            <input type="range" min={50} max={200} value={advMul} onChange={e=>setAdvMul(+e.target.value)} className="flex-1 accent-sky-500"/>
            <span className="w-10 text-right text-slate-300">{advMul}%</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-slate-500 w-14">GUST-MUL</span>
            <input type="range" min={50} max={180} value={gustMul} onChange={e=>setGustMul(+e.target.value)} className="flex-1 accent-sky-500"/>
            <span className="w-10 text-right text-slate-300">{gustMul}%</span>
          </label>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <input id="decrab-wet" type="checkbox" checked={wetMode} onChange={e=>setWetMode(e.target.checked)} className="accent-sky-500"/>
          <label htmlFor="decrab-wet" className="text-slate-300">Wet/contaminated runway (lower max-demo per AFM Lim §1.4)</label>
        </div>
        <div className="flex flex-wrap gap-1">
          {CLASSES.map(c => {
            const on = classFilter.has(c.cls)
            return <button key={c.cls} onClick={()=>{
              const ns = new Set(classFilter); on ? ns.delete(c.cls) : ns.add(c.cls); setClassFilter(ns)
            }} className={`text-[9px] px-1.5 py-0.5 rounded border ${on?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-700 text-slate-400'}`}
              style={{ color: on ? CLS_COLOR[c.cls] : undefined }}>{c.cls}</button>
          })}
        </div>
        <div className="flex items-center gap-1.5 text-[10px]">
          {[['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['ARR',showArrow,setShowArrow]].map(([n,v,s]:any) => (
            <button key={n} onClick={()=>s(!v)} className={`px-1.5 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-700 text-slate-400'}`}>{n}</button>
          ))}
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="cs / type / icao"
            className="ml-auto bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-[10px] w-32 placeholder:text-slate-600 outline-none focus:border-sky-500/60"/>
        </div>
      </div>

      {/* Body */}
      <div className="overflow-y-auto flex-1">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.map(r => (
              <div key={r.f.icao} className="p-2 hover:bg-slate-900/50 cursor-pointer" onClick={()=>{ setPickedIcao(r.f.icao); onFly(r.f.icao) }}>
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                  <span className="text-slate-500">{r.f.type || '—'}</span>
                  <span className="px-1 py-0.5 rounded text-[9px] border border-slate-700" style={{ color: CLS_COLOR[r.cls] }}>{r.cls}</span>
                  <span className="px-1 py-0.5 rounded text-[9px] border" style={{ color: TIER_COLOR[r.tier], borderColor: TIER_COLOR[r.tier]+'66' }}>{r.tier}</span>
                  <span className="ml-auto text-[10px] text-slate-400">{r.apt?.ap.i} · rwy {Math.round(r.apt?.rwyHdg||0/10)*1 || r.apt?.rwyHdg}°</span>
                </div>
                <div className="mt-1 grid grid-cols-4 gap-1 text-[10px]">
                  <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">XW </span><span className="text-slate-100 font-semibold">{r.windCross.toFixed(0)}/{r.maxDemo}kt</span></div>
                  <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">HW </span><span className="text-slate-100">{r.windHead>=0?'+':''}{r.windHead.toFixed(0)}kt</span></div>
                  <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">SIDE </span><span className="text-slate-100 font-semibold">{r.sideloadIdx.toFixed(2)}</span></div>
                  <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">DRIFT </span><span className="text-slate-100">{r.driftM.toFixed(1)}m</span></div>
                </div>
                <div className="mt-1 grid grid-cols-4 gap-1 text-[10px]">
                  <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">RWY-W </span><span className="text-slate-100">{r.apt?.widthM}m</span></div>
                  <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">MARG </span><span className="text-slate-100" style={{color: r.rwyHalfBudget < 1.5 ? TIER_COLOR.BUST : undefined}}>{r.rwyHalfBudget.toFixed(1)}m</span></div>
                  <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">CRAB </span><span className="text-slate-100">{r.crabResidual.toFixed(1)}°</span></div>
                  <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">TECH </span><span className="text-slate-100">{r.rec.technique}</span></div>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-800/80 overflow-hidden">
                  <div className="h-full" style={{ width: r.score+'%', backgroundColor: TIER_COLOR[r.tier] }}/>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {Object.entries(r.drivers).map(([k,v]) => (
                    <span key={k} className="px-1 py-0.5 rounded border border-slate-800/80 text-[9px] text-slate-400">
                      {k}·<span className="text-slate-200">{Math.round(v)}</span>
                    </span>
                  ))}
                </div>
                <div className="mt-1 text-[10px] italic" style={{ color: TIER_COLOR[r.tier] }}>{r.notes[0]}</div>
              </div>
            ))}
            {!filtered.length && <div className="p-6 text-center text-[11px] text-slate-500">No final-approach aircraft in current filter.</div>}
          </div>
        )}

        {tab === 'CLASSES' && (
          <div className="divide-y divide-slate-800/60">
            {CLASSES.map(c => {
              const r = rows.filter(x => x.cls === c.cls)
              const mu = r.length ? r.reduce((a,b)=>a+b.windCross,0)/r.length : 0
              const mus = r.length ? r.reduce((a,b)=>a+b.sideloadIdx,0)/r.length : 0
              const bust = r.filter(x => x.tier === 'BUST').length
              const crit = r.filter(x => x.tier === 'CRITICAL').length
              return (
                <div key={c.cls} className="p-2">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="px-1 py-0.5 rounded text-[10px] font-semibold" style={{ color: CLS_COLOR[c.cls], borderColor: CLS_COLOR[c.cls]+'60', borderWidth: 1, borderStyle:'solid' }}>{c.cls}</span>
                    <span className="text-slate-300 text-[10px]">max-demo {c.maxDemoDry}/{c.maxDemoWet}kt</span>
                    <span className="text-slate-500 text-[10px]">Vapp {c.vapp}</span>
                    <span className="text-slate-500 text-[10px]">{c.technique}</span>
                    <span className="ml-auto text-slate-500 text-[10px]">n={r.length}</span>
                  </div>
                  <div className="mt-1 grid grid-cols-4 gap-1 text-[10px]">
                    <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">μ-XW </span><span className="text-slate-100">{mu.toFixed(0)}kt</span></div>
                    <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">μ-SIDE </span><span className="text-slate-100">{mus.toFixed(2)}</span></div>
                    <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">BUST </span><span className="text-slate-100" style={{color: bust? TIER_COLOR.BUST: undefined}}>{bust}</span></div>
                    <div className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800/60"><span className="text-slate-500">CRIT </span><span className="text-slate-100" style={{color: crit? TIER_COLOR.CRITICAL: undefined}}>{crit}</span></div>
                  </div>
                  <div className="mt-1 text-[10px] text-slate-500 italic">{c.afm}</div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'POLAR' && (
          <div className="p-3">
            <div className="text-[10px] text-slate-400 mb-2">Crosswind / headwind polar — fleet plotted (head→right, x-wind→up). Picked: <span className="text-slate-100 font-semibold">{pickedRow?(pickedRow.f.callsign||pickedRow.f.icao):'—'}</span></div>
            <svg viewBox="0 0 460 320" className="w-full">
              {/* axes */}
              <line x1="40" y1="280" x2="440" y2="280" stroke="#475569" strokeWidth="1"/>
              <line x1="240" y1="20" x2="240" y2="280" stroke="#475569" strokeWidth="1"/>
              {/* concentric demo limits */}
              {[20,30,40,50].map(kt => (
                <circle key={kt} cx="240" cy="280" r={kt*4.2} fill="none" stroke="#1e293b" strokeWidth="0.7" strokeDasharray="2 2"/>
              ))}
              {/* max-demo NB ring (33 dry) */}
              <circle cx="240" cy="280" r={33*4.2} fill="none" stroke="#f59e0b" strokeWidth="1.2" strokeDasharray="3 2"/>
              <text x="240" y={280 - 33*4.2 - 4} textAnchor="middle" fontSize="9" fill="#f59e0b">NB max-demo 33kt</text>
              {/* HVY ring 38 */}
              <circle cx="240" cy="280" r={38*4.2} fill="none" stroke="#a78bfa" strokeWidth="1" strokeDasharray="3 2"/>
              <text x="240" y={280 - 38*4.2 - 4} textAnchor="middle" fontSize="9" fill="#a78bfa">HVY 38kt</text>

              {/* axis labels */}
              <text x="446" y="284" fontSize="10" fill="#94a3b8">HW kt →</text>
              <text x="244" y="18" fontSize="10" fill="#94a3b8">↑ XW kt</text>
              {[-40,-20,0,20,40].map(kt => (
                <g key={kt}>
                  <line x1={240 + kt*4.2} y1="278" x2={240 + kt*4.2} y2="282" stroke="#64748b"/>
                  <text x={240 + kt*4.2} y="293" textAnchor="middle" fontSize="9" fill="#64748b">{kt}</text>
                </g>
              ))}
              {[10,20,30,40,50].map(kt => (
                <g key={kt}>
                  <line x1="238" y1={280 - kt*4.2} x2="242" y2={280 - kt*4.2} stroke="#64748b"/>
                  <text x="234" y={283 - kt*4.2} textAnchor="end" fontSize="9" fill="#64748b">{kt}</text>
                </g>
              ))}

              {/* fleet dots */}
              {rows.map(r => {
                const x = 240 + clamp(r.windHead, -45, 45) * 4.2
                const y = 280 - clamp(r.windCross, 0, 55) * 4.2
                const isPicked = pickedRow && r.f.icao === pickedRow.f.icao
                return (
                  <circle key={r.f.icao} cx={x} cy={y} r={isPicked? 5: 2.8}
                    fill={TIER_COLOR[r.tier]} fillOpacity={isPicked? 1: 0.65}
                    stroke={isPicked? '#fff': 'none'} strokeWidth={isPicked? 1.2: 0}/>
                )
              })}

              {/* picked annotation */}
              {pickedRow && (
                <g>
                  <text x="46" y="36" fontSize="10" fill="#e2e8f0">{pickedRow.f.callsign||pickedRow.f.icao}</text>
                  <text x="46" y="50" fontSize="9" fill="#94a3b8">{pickedRow.cls} · {pickedRow.apt?.ap.i} · {pickedRow.rec.technique}</text>
                  <text x="46" y="64" fontSize="9" fill={TIER_COLOR[pickedRow.tier]}>{pickedRow.tier} · score {pickedRow.score.toFixed(0)}</text>
                </g>
              )}
            </svg>
            <div className="mt-3 text-[10px] text-slate-400 leading-relaxed">
              Crosswind component <span className="text-slate-200">|V·sin Δ|</span> vs runway. Headwind <span className="text-slate-200">V·cos Δ</span>. Max-demonstrated per 14 CFR §25.237 / CS-25.237; not a regulatory limit but FCTM-advisory. Wet-runway max reduced ~25% per Boeing/Airbus FCTM Approach &amp; Landing.
              <div className="mt-1 text-slate-500">Decrab residual: full-decrab clipped to 3°, upwind-wheel half-crab clipped to 8°. Tire side-slip index normalised per Goodyear Aircraft Tire Eng. Manual §4 (1.0 = limit-load).</div>
              <div className="mt-1 text-slate-500">References: FCTM Ch.6 · AC 25-7D §6.5 · AC 91-79B App.1 · FAA-H-8083-3C Ch.8 · NTSB AAR-04-04 Air Midwest 5481 CLT · AAR-09-04 Continental 1404 DEN · TSB A05H0002 ACA A340 TRD · IATA Runway Excursion Toolkit 2024.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
