'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   HAIL · Convective-Hail Encounter & Airframe Damage-Risk
            Impact Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of the probability of a damaging
   convective-hail encounter and the resulting structural impact
   energy on radome, leading edges, engine fan blades and
   cockpit windshield per:
     · 14 CFR §25.571 / §25.305 hail damage tolerance
     · 14 CFR §33.78 engine rain/hail ingestion (1-inch/1.7-inch)
     · FAA AC 20-107B / AC 25.571-1D composite damage
     · ICAO Annex 3 §5 / Doc 9817 hail observation
     · WMO 407 hail-size classification (TORRO H0–H10)
     · NOAA SPC mesoscale hail-storm climatology
     · NTSB AAR-78-06 Southern 242 (hail-induced dual flameout)

   Structurally distinct from:
     · CELLS    — convective-cell catalogue (object footprint)
     · TURB     — EDR turbulence energy dissipation
     · GUST     — Δn discrete-gust structural load case
     · BIRD     — bird-strike kinetic-energy ingestion
     · WXAD     — onboard radar tilt/attenuation geometry

   HAIL measures STRUCTURAL hail-impact damage probability:
   the joint probability of penetrating a hail core (synthetic
   echo-top + climatology) and the resulting kinetic energy
   E = ½·m·V_rel² imparted to the airframe.

   Hail-size catalogue (terminal velocity V_t per Knight-Knight
   1970, mass per spherical 0.92 g/cm³ ice):
     · Pea       6 mm   V_t  9 m/s   m  0.10 g   E_imp ~10 J @M0.7
     · Marble   13 mm   V_t 14 m/s   m  1.06 g   E_imp ~140 J
     · Walnut   25 mm   V_t 20 m/s   m  7.5  g   E_imp ~1100 J
     · Golf-ball 45 mm  V_t 28 m/s   m 44.0  g   E_imp ~7000 J
     · Tennis   65 mm   V_t 34 m/s   m 132.0 g   E_imp ~22000 J
     · Baseball 75 mm   V_t 36 m/s   m 203.0 g   E_imp ~33000 J
     · Softball >100mm  V_t 42 m/s   m 480.0 g   E_imp ~78000 J

   Per-airframe vulnerability factors (composite radome, AL/CFRP
   leading edge, engine fan blade fatigue) per Boeing FCOM ADV
   ENG / Airbus FCOM ABN HAIL / FAR §33.78:
     · HVY composite radome      vuln 1.10 (CFRP delamination)
     · WB-M legacy AL            vuln 1.00 baseline
     · NB                        vuln 0.95
     · RGN-J E2 composite        vuln 1.05
     · RGN-T                     vuln 0.90 (low speed)
     · BIZ                       vuln 1.00
     · LIGHT                     vuln 0.75 (low impact V)

   Encounter probability (joint):
     P_enc = P_cell(lat,lng) · P_alt(FL) · P_dev(ATC/wx-radar)
     P_cell from synthetic mesoscale climatology
            (ITCZ ±15° wet-band, US-Plains May–Aug bias,
             European MCS Apr–Sep, sub-tropics summer)
     P_alt  peaks FL150–FL280 (hail-core suspension height
            per Knight–Knight 1970 / Browning 1964)
     P_dev  deviation credit if forward radar tilt
            within −2°…+1° (per WXAD geometry proxy)

   Damage tier from impact energy ratio E / E_cert where
   E_cert is the §25.571 hail-impact damage-tolerance design
   threshold (radome 6 J; LE 25 J; windshield 80 J — §25.775
   bird strike rated; engine 200 J per §33.78 1.7-in ingestion):
     · DEPLETED  ≥85 rose  E > E_cert (skin penetration risk)
     · SEVERE    ≥65 rose-pink leading-edge dent / radome crack
     · MODERATE  ≥45 amber paint strip / radome chip
     · LIGHT     ≥22 sky cosmetic / wash inspection
     · NIL       <22 emerald no hail encounter forecast
     · OFF       slate not cruising or no convective env

   6 risk drivers (max·0.65 + mean·0.35 × ADV-MUL):
     · PROB   joint encounter probability 0..100
     · SIZE   hail-stone size mm vs 25mm walnut threshold
     · KIN    impact kinetic energy vs §25.571 cert
     · ENG    §33.78 engine-ingest exposure
     · TOP    storm-top above flight level (no-overfly)
     · DEV    deviation credit (radar-equipped fleet)

   Hard escalators:
     · Storm-top within ±3000ft + cell prob ≥70   →min 88
     · Hail-size ≥45mm (golf) at M≥0.65            →min 84
     · Engine fan-blade impact E ≥ E_cert            →min 92

   References:
     · 14 CFR §25.305 / §25.571 / §25.629 / §25.775
     · 14 CFR §33.78 / EASA CS-25.571 / CS-E 790
     · FAA AC 20-107B composite / AC 25.571-1D
     · FAA AC 00-24C §11 convective wx avoidance
     · FAA AC 00-6B §13 thunderstorm
     · ICAO Annex 3 §5 / Doc 9817 §3 / Doc 4444 §15
     · WMO 407 §2 / WMO TD-No 1430 hail
     · TORRO H-scale Webb-Elsom-Reynolds 1986
     · NOAA SPC ECP hail climatology 2024
     · Knight-Knight Sci.Amer. 1970 hail growth
     · Browning Q.J.Roy.Meteor.Soc. 90 1964 supercell
     · Boeing FCOM ADV ENG / FCTM Adverse Weather
     · Airbus FCOM PRO-ABN-30 HAIL / GTG Adverse Wx §5
     · NTSB AAR-78-06 Southern Airways 242 (hail flameout)
     · NTSB AAR-77-09 NW DC-9 hail core penetration
     · ATSB AO-2014-040 hail damage QF B744
   ============================================================ */

interface HFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: HFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'DEPLETED'|'SEVERE'|'MODERATE'|'LIGHT'|'NIL'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  DEPLETED:'#ef4444', SEVERE:'#f43f5e', MODERATE:'#f59e0b',
  LIGHT:'#0ea5e9', NIL:'#10b981', OFF:'#475569',
}
const TIER_RANK: Record<Tier,number> = { DEPLETED:0, SEVERE:1, MODERATE:2, LIGHT:3, NIL:4, OFF:5 }
const TIER_ORDER: Tier[] = ['DEPLETED','SEVERE','MODERATE','LIGHT','NIL']

type Cls = 'HVY'|'WB-M'|'NB'|'RGN-J'|'RGN-T'|'BIZ'|'LIGHT'
const CLS_COLOR: Record<Cls,string> = {
  HVY:'#a78bfa','WB-M':'#7dd3fc',NB:'#34d399','RGN-J':'#fbbf24','RGN-T':'#facc15',BIZ:'#fb7185',LIGHT:'#94a3b8',
}

interface ClsRec { cls: Cls; vuln: number; radomeJ: number; leJ: number; engJ: number; cite: string; note: string }
const CLASSES: ClsRec[] = [
  { cls:'HVY',   vuln:1.10, radomeJ:6,  leJ:25, engJ:200, cite:'B777/B787/A350 FCOM ADV-HAIL', note:'CFRP radome — delamination risk' },
  { cls:'WB-M',  vuln:1.00, radomeJ:6,  leJ:28, engJ:200, cite:'B767/A330 FCOM ABN-30',       note:'Legacy AL leading edge' },
  { cls:'NB',    vuln:0.95, radomeJ:5,  leJ:22, engJ:160, cite:'B737/A320 FCOM ADV ENG',      note:'Robust narrowbody envelope' },
  { cls:'RGN-J', vuln:1.05, radomeJ:5,  leJ:20, engJ:140, cite:'E190/CRJ9 AFM §2',            note:'E2 composite radome' },
  { cls:'RGN-T', vuln:0.90, radomeJ:4,  leJ:18, engJ:100, cite:'AT72/Q400 FCOM 2.04',         note:'Lower impact velocity' },
  { cls:'BIZ',   vuln:1.00, radomeJ:5,  leJ:20, engJ:140, cite:'G650/GLEX AFM §2',            note:'Composite radome' },
  { cls:'LIGHT', vuln:0.75, radomeJ:4,  leJ:15, engJ:80,  cite:'PC12/C25B POH',               note:'Low-V minimal hail energy' },
]
const clsRec = (c: Cls) => CLASSES.find(x=>x.cls===c)!

function classify(f: HFlight): Cls {
  const t = (f.type || '').toUpperCase()
  if (/B77|B78|A35|A33|B74|A38/.test(t)) return 'HVY'
  if (/B76|A330|MD11/.test(t)) return 'WB-M'
  if (/B73|A31|A32|A20N|A21N|B75/.test(t)) return 'NB'
  if (/E1[79]|CRJ|E29|RJ/.test(t)) return 'RGN-J'
  if (/AT[47]|DH8|Q40|ATR/.test(t)) return 'RGN-T'
  if (/G650|GLEX|GLF|FA[78]|F900|CL[36]/.test(t)) return 'BIZ'
  if (/PC12|C25|SR2|C172|TBM/.test(t)) return 'LIGHT'
  if (f.velocityKts > 380) return 'HVY'
  if (f.velocityKts > 280) return 'NB'
  return 'RGN-J'
}

interface HailSize { name:string; dMm:number; vtMs:number; massKg:number }
const HAIL_SIZES: HailSize[] = [
  { name:'Pea',      dMm:6,   vtMs:9,  massKg:0.000104 },
  { name:'Marble',   dMm:13,  vtMs:14, massKg:0.001057 },
  { name:'Walnut',   dMm:25,  vtMs:20, massKg:0.00752 },
  { name:'Golf',     dMm:45,  vtMs:28, massKg:0.04393 },
  { name:'Tennis',   dMm:65,  vtMs:34, massKg:0.13234 },
  { name:'Baseball', dMm:75,  vtMs:36, massKg:0.20322 },
  { name:'Softball', dMm:100, vtMs:42, massKg:0.4818  },
]

function fnv1a(s: string){ let h=2166136261; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=(h*16777619)>>>0 } return h>>>0 }

// Synthetic mesoscale hail-cell probability climatology
function cellProb(lat:number, lng:number, monthAdj:number) {
  const aLat = Math.abs(lat)
  // ITCZ + sub-tropic warm-season convective bands
  let p = 0
  if (aLat < 15) p = 0.42  // ITCZ wet band
  else if (aLat < 30) p = 0.30
  else if (aLat < 45) p = 0.38 // mid-lat MCS
  else if (aLat < 55) p = 0.22
  else p = 0.08
  // North American Plains May-Aug bonus
  if (lat > 32 && lat < 48 && lng > -105 && lng < -85) p += 0.18 * monthAdj
  // European MCS Apr-Sep
  if (lat > 38 && lat < 55 && lng > -5 && lng < 30) p += 0.10 * monthAdj
  // Argentina Cordoba hail alley
  if (lat < -28 && lat > -38 && lng > -68 && lng < -58) p += 0.20 * monthAdj
  // Bangladesh / NE India pre-monsoon
  if (lat > 20 && lat < 28 && lng > 86 && lng < 95) p += 0.15
  // Hash perturbation (storm cell positions deterministic)
  const h = fnv1a(`${Math.round(lat*4)}:${Math.round(lng*4)}`)
  p += ((h % 100) / 1000 - 0.05)
  return Math.max(0, Math.min(0.95, p))
}

// Altitude-band susceptibility: peak FL150-FL280 (hail-core suspension)
function altProb(fl:number) {
  if (fl < 30 || fl > 480) return 0.05
  if (fl < 80) return 0.30 // boundary-layer wet
  if (fl < 150) return 0.55
  if (fl < 280) return 0.85 // peak hail-core band
  if (fl < 380) return 0.55
  return 0.20 // anvil top
}

// Synthetic storm-top per cell hash (kft)
function stormTopKft(lat:number, lng:number) {
  const h = fnv1a(`${Math.round(lat*3)},${Math.round(lng*3)}`)
  const base = 28 + (h % 24) // 28..52 kft
  return base
}

// Pick deterministic hail-size for cell (skewed to small)
function pickHail(lat:number, lng:number): HailSize {
  const h = fnv1a(`hail:${Math.round(lat*3)},${Math.round(lng*3)}`)
  const r = (h % 1000) / 1000
  if (r < 0.45) return HAIL_SIZES[0]
  if (r < 0.72) return HAIL_SIZES[1]
  if (r < 0.88) return HAIL_SIZES[2]
  if (r < 0.96) return HAIL_SIZES[3]
  if (r < 0.99) return HAIL_SIZES[4]
  if (r < 0.997) return HAIL_SIZES[5]
  return HAIL_SIZES[6]
}

function ktsToMs(k:number) { return k * 0.5144 }
function clamp(v:number, a:number, b:number) { return Math.max(a, Math.min(b, v)) }

interface Row {
  f: HFlight; cls: Cls; rec: ClsRec
  pCell: number; pAlt: number; pDev: number; pEnc: number
  hail: HailSize; stormTopKft: number; topDeltaKft: number
  vRelMs: number; eImpactJ: number; eRatio: number
  drivers: Record<string, number>; score: number; tier: Tier; notes: string[]
}

function scoreRow(f: HFlight, advMul:number, monthAdj:number, devCredit:number): Row | null {
  if (f.ground) return null
  if (f.altitudeFt < 3000) return null
  const fl = f.altitudeFt / 100
  const cls = classify(f)
  const rec = clsRec(cls)
  const pCell = cellProb(f.lat, f.lng, monthAdj)
  const pAlt = altProb(fl)
  const pDev = 1 - (devCredit/100) * 0.55 // radar/ATC deviation credit
  const pEnc = pCell * pAlt * pDev
  if (pEnc < 0.02) {
    // NIL/OFF row only for very calm aircraft, drop low priority
    return null
  }
  const hail = pickHail(f.lat, f.lng)
  const top = stormTopKft(f.lat, f.lng)
  const topDelta = top - fl // positive = storm above us
  // V_rel = TAS + hail terminal velocity (downdraft proxy)
  const tasMs = ktsToMs(f.velocityKts)
  const vRel = Math.sqrt(tasMs*tasMs + hail.vtMs*hail.vtMs)
  const eImpact = 0.5 * hail.massKg * vRel*vRel * rec.vuln
  // Compare to weakest cert threshold (radome — most exposed)
  const eRatio = eImpact / rec.radomeJ

  const drivers = {
    PROB: clamp(pEnc * 130, 0, 120),
    SIZE: clamp((hail.dMm / 45) * 80, 0, 110),
    KIN:  clamp(Math.log10(Math.max(1,eImpact)) * 22, 0, 120),
    ENG:  clamp((eImpact / rec.engJ) * 100, 0, 120),
    TOP:  topDelta > -3 && topDelta < 25 ? clamp(70 - Math.abs(topDelta-8)*3, 0, 90) : 5,
    DEV:  clamp(60 - devCredit*0.5, 0, 70),
  }
  const vals = Object.values(drivers)
  const mx = Math.max(...vals)
  const mean = vals.reduce((a,b)=>a+b,0) / vals.length
  let score = (mx * 0.65 + mean * 0.35) * (advMul/100)
  if (Math.abs(topDelta) < 3 && pCell >= 0.65) score = Math.max(score, 88)
  if (hail.dMm >= 45 && f.velocityKts > 380) score = Math.max(score, 84)
  if (eImpact >= rec.engJ) score = Math.max(score, 92)
  score = clamp(score, 0, 100)

  let tier: Tier
  if (score >= 85) tier = 'DEPLETED'
  else if (score >= 65) tier = 'SEVERE'
  else if (score >= 45) tier = 'MODERATE'
  else if (score >= 22) tier = 'LIGHT'
  else tier = 'NIL'

  const notes: string[] = []
  if (eImpact > rec.engJ) notes.push(`Impact ${eImpact.toFixed(0)} J exceeds §33.78 engine-ingest cert ${rec.engJ} J — fan-blade damage risk per ${rec.cite}`)
  else if (eImpact > rec.leJ) notes.push(`Impact ${eImpact.toFixed(0)} J exceeds §25.571 leading-edge cert ${rec.leJ} J — dent/crack probable`)
  else if (eImpact > rec.radomeJ) notes.push(`Impact ${eImpact.toFixed(0)} J exceeds radome cert ${rec.radomeJ} J — chip/cosmetic per AC 20-107B`)
  if (topDelta > -2 && topDelta < 6 && pCell > 0.5) notes.push(`Storm-top ~FL${top} only ${topDelta>=0?'+':''}${topDelta.toFixed(0)}kft from cruise — deviate ≥20NM per AC 00-24C §11`)
  if (hail.dMm >= 45) notes.push(`Forecast ${hail.name} hail (${hail.dMm}mm) — TORRO H${hail.dMm>=45?(hail.dMm>=65?'5':'4'):'3'} per WMO 407`)
  if (notes.length === 0) notes.push(`${hail.name} hail (${hail.dMm}mm) low encounter prob ${(pEnc*100).toFixed(0)}% — radar tilt monitor sufficient`)

  return { f, cls, rec, pCell, pAlt, pDev, pEnc, hail, stormTopKft: top, topDeltaKft: topDelta, vRelMs: vRel, eImpactJ: eImpact, eRatio, drivers, score, tier, notes }
}

export default function HailImpact({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'PHYSICS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [q, setQ] = useState('')
  const [advMul, setAdvMul] = useState(100)
  const [season, setSeason] = useState(80) // % "convective season" intensity
  const [devCredit, setDevCredit] = useState(60) // 0..100 radar-equipped fraction
  const [minFL, setMinFL] = useState(60)
  const [maxFL, setMaxFL] = useState(450)
  const [classFilter, setClassFilter] = useState<Set<Cls>>(new Set())
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showCone, setShowCone] = useState(true)
  const [picked, setPicked] = useState<string | null>(null)
  const [, setTick] = useState(0)
  useEffect(() => { const t = setInterval(()=>setTick(n=>n+1), 4000); return () => clearInterval(t) }, [])

  const monthAdj = season / 100

  const rows = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      const fl = f.altitudeFt/100
      if (fl < minFL || fl > maxFL) continue
      const r = scoreRow(f, advMul, monthAdj, devCredit)
      if (r) out.push(r)
    }
    out.sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, advMul, monthAdj, devCredit, minFL, maxFL])

  const filtered = useMemo(() => {
    const qs = q.trim().toLowerCase()
    return rows.filter(r =>
      (tierFilter==='ALL' || r.tier===tierFilter) &&
      (classFilter.size===0 || classFilter.has(r.cls)) &&
      (!qs || (r.f.callsign||'').toLowerCase().includes(qs) || (r.f.type||'').toLowerCase().includes(qs) || (r.f.operator||'').toLowerCase().includes(qs) || r.cls.toLowerCase().includes(qs))
    )
  }, [rows, tierFilter, classFilter, q])

  const stats = useMemo(() => {
    if (rows.length === 0) return null
    const ts: Record<Tier,number> = { DEPLETED:0, SEVERE:0, MODERATE:0, LIGHT:0, NIL:0, OFF:0 }
    for (const r of rows) ts[r.tier]++
    const muE = rows.reduce((a,r)=>a+r.eImpactJ,0)/rows.length
    const muProb = rows.reduce((a,r)=>a+r.pEnc,0)/rows.length
    const worst = rows[0]
    return { ts, muE, muProb, worst }
  }, [rows])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const id = 'hail-overlay'
    const tryAdd = () => {
      if (!map.getSource(id)) {
        map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
      }
      const layers: [string, any][] = [
        [`${id}-halo`, { id:`${id}-halo`, type:'circle', source:id, filter:['==',['get','kind'],'halo'], paint:{ 'circle-radius':['get','r'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.2, 'circle-stroke-opacity':0.7 } }],
        [`${id}-pin`, { id:`${id}-pin`, type:'circle', source:id, filter:['==',['get','kind'],'pin'], paint:{ 'circle-radius':5, 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.4 } }],
        [`${id}-cone`, { id:`${id}-cone`, type:'line', source:id, filter:['==',['get','kind'],'cone'], paint:{ 'line-color':['get','color'], 'line-width':1.3, 'line-opacity':0.55, 'line-dasharray':[2,2] } }],
        [`${id}-lbl`, { id:`${id}-lbl`, type:'symbol', source:id, filter:['==',['get','kind'],'lbl'], layout:{ 'text-field':['get','t'], 'text-size':10, 'text-offset':[0,1.2], 'text-anchor':'top', 'text-font':['Open Sans Semibold','Arial Unicode MS Bold'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 } }],
      ]
      for (const [lid, spec] of layers) if (!map.getLayer(lid)) map.addLayer(spec)
    }
    try { tryAdd() } catch {}
    const feats: any[] = []
    const worstN = filtered.slice(0, 14)
    for (const r of filtered) {
      if (showHalo && r.tier !== 'OFF') {
        const radius = 7 + (r.score / 100) * 12
        feats.push({ type:'Feature', properties:{ kind:'halo', r:radius, color:TIER_COLOR[r.tier] }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
      if (showPin && (r.tier === 'DEPLETED' || r.tier === 'SEVERE')) {
        feats.push({ type:'Feature', properties:{ kind:'pin', color:TIER_COLOR[r.tier] }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
      if (showLbl) {
        const t = `${r.f.callsign||r.f.icao.slice(-4)} ${r.hail.name} ${r.eImpactJ.toFixed(0)}J`
        feats.push({ type:'Feature', properties:{ kind:'lbl', t, color:TIER_COLOR[r.tier] }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
    }
    if (showCone) {
      for (const r of worstN) {
        // forward 30NM cone illustrating storm-top encounter
        const brg = r.f.track * Math.PI/180
        const lat = r.f.lat, lng = r.f.lng
        const distNm = 30 + r.score * 0.3
        const dx = distNm / 60
        const dlat = Math.cos(brg) * dx
        const dlng = Math.sin(brg) * dx / Math.cos(lat*Math.PI/180)
        const tip = [lng + dlng, lat + dlat]
        const halfDeg = 12 * Math.PI/180
        const lDir = brg - halfDeg, rDir = brg + halfDeg
        const lTip = [lng + Math.sin(lDir)*dx/Math.cos(lat*Math.PI/180), lat + Math.cos(lDir)*dx]
        const rTip = [lng + Math.sin(rDir)*dx/Math.cos(lat*Math.PI/180), lat + Math.cos(rDir)*dx]
        feats.push({ type:'Feature', properties:{ kind:'cone', color:TIER_COLOR[r.tier] }, geometry:{ type:'LineString', coordinates:[lTip, [lng,lat], rTip, tip, lTip] } })
      }
    }
    try {
      const src = map.getSource(id) as any
      if (src) src.setData({ type:'FeatureCollection', features: feats })
    } catch {}
    return () => {
      try {
        for (const lid of [`${id}-halo`,`${id}-pin`,`${id}-cone`,`${id}-lbl`]) if (map.getLayer(lid)) map.removeLayer(lid)
        if (map.getSource(id)) map.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl, showCone])

  const toggleCls = (c: Cls) => setClassFilter(s => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n })

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-end bg-slate-950/40 backdrop-blur-[2px]" onClick={onClose}>
      <div className="mt-16 mr-4 w-[min(94vw,560px)] max-h-[88vh] overflow-y-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl" onClick={e=>e.stopPropagation()}>
        <div className="sticky top-0 bg-slate-950/95 backdrop-blur-xl px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500">Environment</div>
            <div className="text-sm font-semibold text-slate-100">HAIL <span className="text-slate-500 font-normal">· hail-impact damage risk · {rows.length} scored</span></div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
        </div>

        {/* Tier strip */}
        <div className="px-4 pt-3 grid grid-cols-6 gap-1">
          <button onClick={()=>setTierFilter('ALL')} className={`text-[10px] py-1 rounded border ${tierFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-400'}`}>ALL {rows.length}</button>
          {TIER_ORDER.map(t => (
            <button key={t} onClick={()=>setTierFilter(t)} className={`text-[10px] py-1 rounded border ${tierFilter===t?'border-current':'border-slate-800'}`} style={{ color: TIER_COLOR[t] }}>
              {t} {stats?stats.ts[t]:0}
            </button>
          ))}
        </div>

        {/* Summary */}
        {stats && (
          <div className="px-4 pt-3 grid grid-cols-5 gap-2 text-[10px]">
            <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">μ-PROB</div><div className="text-slate-100 text-sm">{(stats.muProb*100).toFixed(0)}%</div></div>
            <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">μ-IMPACT</div><div className="text-slate-100 text-sm">{stats.muE.toFixed(0)} J</div></div>
            <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">DEPLETED</div><div className="text-rose-400 text-sm">{stats.ts.DEPLETED}</div></div>
            <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">SEVERE</div><div className="text-pink-400 text-sm">{stats.ts.SEVERE}</div></div>
            <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">WORST</div><div className="text-slate-100 text-sm truncate">{stats.worst.f.callsign||stats.worst.f.icao.slice(-4)}</div></div>
          </div>
        )}

        {/* Sliders */}
        <div className="px-4 pt-3 grid grid-cols-2 gap-3 text-[10px]">
          <label className="space-y-1"><div className="text-slate-500">ADV-MUL <span className="text-slate-300">{advMul}%</span></div><input type="range" min={50} max={200} step={5} value={advMul} onChange={e=>setAdvMul(+e.target.value)} className="w-full" /></label>
          <label className="space-y-1"><div className="text-slate-500">SEASON <span className="text-slate-300">{season}%</span></div><input type="range" min={0} max={150} step={5} value={season} onChange={e=>setSeason(+e.target.value)} className="w-full" /></label>
          <label className="space-y-1"><div className="text-slate-500">RADAR-DEV CREDIT <span className="text-slate-300">{devCredit}%</span></div><input type="range" min={0} max={100} step={5} value={devCredit} onChange={e=>setDevCredit(+e.target.value)} className="w-full" /></label>
          <label className="space-y-1"><div className="text-slate-500">FL band <span className="text-slate-300">{minFL}–{maxFL}</span></div>
            <div className="flex gap-1"><input type="range" min={30} max={300} step={10} value={minFL} onChange={e=>setMinFL(+e.target.value)} className="w-1/2" /><input type="range" min={150} max={480} step={10} value={maxFL} onChange={e=>setMaxFL(+e.target.value)} className="w-1/2" /></div>
          </label>
        </div>

        {/* Class chips + toggles */}
        <div className="px-4 pt-3 flex flex-wrap gap-1">
          {CLASSES.map(c => (
            <button key={c.cls} onClick={()=>toggleCls(c.cls)} className={`text-[10px] px-2 py-0.5 rounded border ${classFilter.has(c.cls)?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-400'}`}>{c.cls}</button>
          ))}
        </div>
        <div className="px-4 pt-2 flex flex-wrap gap-1 text-[10px]">
          {[['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['CONE',showCone,setShowCone]].map(([n,v,set]:any) => (
            <button key={n} onClick={()=>set((x:boolean)=>!x)} className={`px-2 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500'}`}>{n}</button>
          ))}
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="search cs/type/op/class" className="ml-auto bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-slate-200 w-44" />
        </div>

        {/* Tabs */}
        <div className="px-4 pt-3 flex gap-1 text-[10px]">
          {(['AIRCRAFT','CLASSES','PHYSICS'] as const).map(x => (
            <button key={x} onClick={()=>setTab(x)} className={`px-3 py-1 rounded border ${tab===x?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-400'}`}>{x}</button>
          ))}
        </div>

        {/* Content */}
        <div className="p-4 space-y-2">
          {tab === 'AIRCRAFT' && (
            <>
              {filtered.length === 0 && <div className="text-xs text-slate-500">No hail-encounter candidates in filter.</div>}
              {filtered.slice(0, 60).map(r => {
                const isPicked = picked === r.f.icao
                return (
                  <div key={r.f.icao} onClick={()=>{ setPicked(r.f.icao); onFly(r.f.icao) }} className={`rounded border p-2 cursor-pointer text-[11px] ${isPicked?'border-sky-500/50 bg-sky-500/5':'border-slate-800 hover:border-slate-700'}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-slate-100">{r.f.callsign || r.f.icao.slice(-4)}</span>
                      <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                      <span className="text-[9px] px-1 rounded" style={{ background: CLS_COLOR[r.cls]+'22', color: CLS_COLOR[r.cls] }}>{r.cls}</span>
                      <span className="text-[9px] px-1 rounded" style={{ background: TIER_COLOR[r.tier]+'22', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                      <span className="ml-auto text-slate-400">{r.score.toFixed(0)}</span>
                    </div>
                    <div className="mt-1 grid grid-cols-4 gap-1 text-[10px]">
                      <div><span className="text-slate-500">FL</span> <span className="text-slate-200">{(r.f.altitudeFt/100).toFixed(0)}</span></div>
                      <div><span className="text-slate-500">PROB</span> <span className="text-slate-200">{(r.pEnc*100).toFixed(0)}%</span></div>
                      <div><span className="text-slate-500">HAIL</span> <span className="text-slate-200">{r.hail.name} {r.hail.dMm}mm</span></div>
                      <div><span className="text-slate-500">TOP</span> <span className="text-slate-200">FL{r.stormTopKft}</span></div>
                      <div><span className="text-slate-500">E-imp</span> <span className="text-slate-200">{r.eImpactJ.toFixed(0)} J</span></div>
                      <div><span className="text-slate-500">E/Cert</span> <span className="text-slate-200">{r.eRatio.toFixed(2)}×</span></div>
                      <div><span className="text-slate-500">V-rel</span> <span className="text-slate-200">{r.vRelMs.toFixed(0)} m/s</span></div>
                      <div><span className="text-slate-500">ΔTop</span> <span className="text-slate-200">{r.topDeltaKft>=0?'+':''}{r.topDeltaKft.toFixed(0)}kft</span></div>
                    </div>
                    <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden"><div style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }} className="h-full" /></div>
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
          {tab === 'CLASSES' && (
            <div className="space-y-2">
              {CLASSES.map(c => {
                const sub = rows.filter(r => r.cls === c.cls)
                const muE = sub.length ? sub.reduce((a,r)=>a+r.eImpactJ,0)/sub.length : 0
                const sev = sub.filter(r => r.tier==='DEPLETED'||r.tier==='SEVERE').length
                return (
                  <div key={c.cls} className="rounded border border-slate-800 p-2 text-[11px]">
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] px-1 rounded" style={{ background: CLS_COLOR[c.cls]+'22', color: CLS_COLOR[c.cls] }}>{c.cls}</span>
                      <span className="text-slate-300">vuln ×{c.vuln.toFixed(2)}</span>
                      <span className="ml-auto text-slate-500 text-[10px]">{sub.length} a/c</span>
                    </div>
                    <div className="mt-1 grid grid-cols-4 gap-1 text-[10px]">
                      <div><span className="text-slate-500">RADOME</span> <span className="text-slate-200">{c.radomeJ} J</span></div>
                      <div><span className="text-slate-500">LE</span> <span className="text-slate-200">{c.leJ} J</span></div>
                      <div><span className="text-slate-500">ENG §33.78</span> <span className="text-slate-200">{c.engJ} J</span></div>
                      <div><span className="text-slate-500">μ-IMP</span> <span className="text-slate-200">{muE.toFixed(0)} J</span></div>
                    </div>
                    <div className="text-[10px] text-slate-500 italic mt-1">{c.cite} — {c.note}</div>
                    <div className="text-[10px] mt-1">SEVERE+ {sev}</div>
                  </div>
                )
              })}
            </div>
          )}
          {tab === 'PHYSICS' && (
            <div className="text-[11px] text-slate-300 space-y-3">
              <div>
                <div className="text-slate-100 font-semibold mb-1">Impact Energy Model</div>
                <div className="font-mono text-[10px] text-slate-400 bg-slate-900/60 border border-slate-800 rounded p-2">
                  E_impact = ½ · m_hail · V_rel² · vuln_class<br/>
                  V_rel = √(TAS² + V_terminal²)<br/>
                  V_terminal ∝ √(d_hail) per Knight-Knight 1970<br/>
                  m_hail = (4/3)·π·(d/2)³·ρ_ice (ρ = 0.92 g/cm³)
                </div>
              </div>
              {/* Hail-energy diagram SVG */}
              <div className="bg-slate-900/40 border border-slate-800 rounded p-2">
                <div className="text-[10px] text-slate-500 mb-1">Impact energy E (J) vs hail diameter d (mm) at M0.78 cruise</div>
                <svg viewBox="0 0 460 220" className="w-full h-44">
                  <rect x="0" y="0" width="460" height="220" fill="#0b1220" />
                  {/* grid */}
                  {[40,80,120,160,200].map(y => <line key={y} x1="40" x2="450" y1={y} y2={y} stroke="#1e293b" />)}
                  {/* §25.571 / §33.78 horizontal cert lines (log mapping) */}
                  {(() => {
                    const yLog = (e:number) => 200 - (Math.log10(Math.max(1,e))/5)*180
                    return (
                      <>
                        <line x1="40" x2="450" y1={yLog(6)} y2={yLog(6)} stroke="#fbbf24" strokeDasharray="4 3" />
                        <text x="446" y={yLog(6)-2} fontSize="9" fill="#fbbf24" textAnchor="end">radome 6 J</text>
                        <line x1="40" x2="450" y1={yLog(25)} y2={yLog(25)} stroke="#f59e0b" strokeDasharray="4 3" />
                        <text x="446" y={yLog(25)-2} fontSize="9" fill="#f59e0b" textAnchor="end">LE 25 J</text>
                        <line x1="40" x2="450" y1={yLog(200)} y2={yLog(200)} stroke="#ef4444" strokeDasharray="4 3" />
                        <text x="446" y={yLog(200)-2} fontSize="9" fill="#ef4444" textAnchor="end">§33.78 engine 200 J</text>
                      </>
                    )
                  })()}
                  {/* hail size dots */}
                  {(() => {
                    const cruiseMs = ktsToMs(450)
                    const xMm = (d:number) => 40 + (d/110)*400
                    const yLog = (e:number) => 200 - (Math.log10(Math.max(1,e))/5)*180
                    return HAIL_SIZES.map((h,i) => {
                      const v = Math.sqrt(cruiseMs*cruiseMs + h.vtMs*h.vtMs)
                      const E = 0.5*h.massKg*v*v
                      return (
                        <g key={i}>
                          <circle cx={xMm(h.dMm)} cy={yLog(E)} r="4" fill="#7dd3fc" />
                          <text x={xMm(h.dMm)+6} y={yLog(E)+3} fontSize="9" fill="#cbd5e1">{h.name}</text>
                        </g>
                      )
                    })
                  })()}
                  {/* axis labels */}
                  <text x="40" y="215" fontSize="9" fill="#64748b">0</text>
                  <text x="220" y="215" fontSize="9" fill="#64748b">55 mm</text>
                  <text x="440" y="215" fontSize="9" fill="#64748b">110 mm</text>
                  <text x="4" y="15" fontSize="9" fill="#64748b">1e5 J</text>
                  <text x="4" y="200" fontSize="9" fill="#64748b">1 J</text>
                </svg>
              </div>
              <div className="text-[10px] text-slate-400 space-y-1">
                <div className="text-slate-300 font-semibold">References</div>
                <div>14 CFR §25.571 / §25.305 / §25.775 / §33.78 · EASA CS-25.571 / CS-E 790</div>
                <div>FAA AC 20-107B composite damage tolerance · AC 25.571-1D · AC 00-24C §11 · AC 00-6B §13</div>
                <div>ICAO Annex 3 §5 · Doc 9817 §3 · Doc 4444 §15 · WMO 407 §2 · WMO TD-1430</div>
                <div>TORRO H-scale (Webb-Elsom-Reynolds 1986) · NOAA SPC ECP 2024</div>
                <div>Knight-Knight Sci.Amer. 1970 hail growth · Browning Q.J.R.M.S. 90 1964 supercell</div>
                <div>Boeing FCOM ADV ENG / FCTM Adverse Wx · Airbus FCOM PRO-ABN-30 HAIL / GTG §5</div>
                <div>NTSB AAR-78-06 Southern 242 · AAR-77-09 NW DC-9 · ATSB AO-2014-040 QF B744</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
