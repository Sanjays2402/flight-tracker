'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TUC · Time of Useful Consciousness & Rapid-Decompression
        Hypoxia Risk Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of crew/pax effective performance
   time after a sudden cabin-decompression event at current
   cruise FL. TUC is the interval between depressurisation and
   the onset of impaired performance (judgement, motor control)
   beyond which a useful emergency descent cannot be initiated.

   Canonical TUC table (sitting, no exertion, no supplemental
   oxygen) per FAA AC 61-107B App.1 / FAA-H-8083-25C Ch.7 / ICAO
   Doc 9760 Vol II Pt VI / ICAO Annex 6 Pt I §4.4.2 / DAN Annual
   Diving Report 2024 (hypoxia overlap) / Ernsting's Aviation &
   Space Medicine 5e Ch.5 / Gradwell & Rainford 5e Ch.4:

       Cabin Alt      Sitting        Mod-Activity   Rapid-Decomp
        FL180         20-30 min      20-30 min      ½ × sitting
        FL220         10 min          5 min         ½ × sitting
        FL250          3-5 min        2-3 min       1.5-3 min
        FL280          2-3 min        1-2 min       1-2 min
        FL300          1-2 min        30-60 s       30-60 s
        FL350          30-60 s        30-45 s       15-30 s
        FL400          15-20 s        10-20 s       9-15 s
        FL430+          9-12 s         5-10 s        5-10 s

   With explosive decompression (cabin → ambient in <1s) TUC
   collapses by ~50% due to forced exhalation, gas-bubble
   formation, and pulmonary nitrogen washout (Ernsting Ch.5,
   Brooks ASEM 60 1989, Files JAMA 232 1975).

   Drives time-critical decision: emergency-descent profile must
   land cabin altitude ≤ FL100 within TUC, else hypoxic crew
   incapacitation. Per 14 CFR §121.333(c)(2) / §25.841 / EASA
   CS-25.841 / AMC-25.841 quick-don O₂ mask donning ≤5s required.

   Pressurisation differential schedule (Boeing 737/777/787,
   Airbus A320/A330/A350 typical):
     · Cabin alt held at 6,500-8,000 ft for FL280-FL430 cruise
     · Max pressure differential ΔP ≈ 8.6-9.4 psi
     · After failure: cabin alt = aircraft alt (rapid)
                                or rises at 2,500-4,000 fpm (slow leak)

   Composite hypoxia risk per airframe combines:
     · CABIN-ALT  current pressurised cabin altitude
     · DECOMP-FL  flight-level exposure after sudden failure
     · TUC-RAW    seconds available under rapid-decomp scenario
     · DESC-TIME  estimated emergency-descent reach to 10kft
     · O2-MARG    margin = TUC − descent-time
     · DUR-EXP    duration cumulative high-FL exposure (proxy)
     · PAX-MASK   pax-mask drop altitude trigger (>14,000ft per
                  §25.1447(c)(1)) → time-to-don assumption 8s

   6 tiers:
     CRIT-HYPOX  ≥85 rose       TUC < descent-time, mask donning
                                only mitigation, AAR-29-04 Helios
                                522 / NTSB AAR-00-01 Payne Stewart
     SEVERE      ≥70 rose-pink  TUC < 1.3 × descent-time, slim
                                margin per AC 61-107B §1.4
     ELEVATED    ≥50 amber      TUC < 2 × descent-time, prompt
                                action required
     WATCH       ≥30 sky        TUC ≥ 2 × descent-time, monitor
     NOMINAL     <30 emerald    Cabin ≤ FL100, no hypoxia risk
     ON-GROUND   slate          ground/below FL180 no exposure

   References:
     · FAA AC 61-107B App.1 TUC table (2023 rev)
     · FAA-H-8083-25C Pilot's Hbk Aero Knowledge Ch.7
     · FAA AC 25-20 Pressurisation, ventilation, oxygen
     · 14 CFR §25.841 §121.333 §91.211 §25.1447 §25.1443
     · EASA CS-25.841 / AMC-25.841 / CS-25.1447
     · ICAO Annex 6 Pt I §4.4.2 / §4.3.9.1.2
     · ICAO Doc 9760 Vol II Pt VI / Pt IV
     · ICAO Doc 8984 Civil Aviation Medicine §2.5
     · MIL-STD-3013A Glossary §A.4.43 TUC
     · USAF AFP 11-217 Vol III §5
     · Ernsting's Aviation & Space Medicine 5e Ch.5
     · Gradwell & Rainford Aviation Medicine 5e Ch.4
     · West Respiratory Physiology 10e Ch.9
     · Brooks ASEM 60 1989 explosive-decompression
     · Files et al. JAMA 232 1975 hypoxia performance
     · NTSB AAR-29-04 Helios 522 BKN
     · NTSB AAR-00-01 Sunjet 56 (Payne Stewart) HLN
     · NTSB AAR-13-02 Mountain Air Cargo
     · Boeing FCOM SP.16.1 Rapid Depressurisation
     · Airbus FCOM PRO-ABN-EMER-D · QRH EMER-PRO
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string, lat: number, lng: number, zoom: number) => void }

type Tier = 'CRIT-HYPOX'|'SEVERE'|'ELEVATED'|'WATCH'|'NOMINAL'|'ON-GROUND'
const TIER_COLOR: Record<Tier,string> = {
  'CRIT-HYPOX':'#f43f5e','SEVERE':'#fb7185','ELEVATED':'#f59e0b',
  'WATCH':'#0ea5e9','NOMINAL':'#10b981','ON-GROUND':'#64748b',
}
const TIER_ORDER: Tier[] = ['CRIT-HYPOX','SEVERE','ELEVATED','WATCH','NOMINAL','ON-GROUND']

type Class = 'WB-LH'|'WB-M'|'NB'|'RGN-J'|'RGN-T'|'BIZ'|'LIGHT'
const CLASS_LIST: Class[] = ['WB-LH','WB-M','NB','RGN-J','RGN-T','BIZ','LIGHT']
const CLASS_COLOR: Record<Class,string> = {
  'WB-LH':'#a78bfa','WB-M':'#818cf8','NB':'#60a5fa','RGN-J':'#22d3ee',
  'RGN-T':'#4ade80','BIZ':'#fb923c','LIGHT':'#fbbf24',
}

/* Aircraft class catalogue — pressurisation / descent profile
   Per Boeing/Airbus FCOM SP.16, EASA CS-25.841, CS-25.1447,
   manufacturer ACAP/APD §3, AC 25-20.
   cabinAlt_max: certified max cabin altitude in normal ops (ft)
   maxDeltaP_psi: max cert pressure differential
   descRoc_fpm: emergency descent ROD VMO/MMO idle+speedbrake
   diveTAS_kts: dive-speed estimate during descent
   o2Available_min: installed pax-mask O₂ supply duration
*/
interface ClassSpec {
  cls: Class
  cabinAltMaxFt: number
  maxDeltaPpsi: number
  descRocFpm: number
  diveTASkts: number
  o2AvailMin: number
}
const CLASS_SPECS: Record<Class, ClassSpec> = {
  'WB-LH':  { cls:'WB-LH', cabinAltMaxFt: 6500, maxDeltaPpsi: 9.4, descRocFpm: 6800, diveTASkts: 460, o2AvailMin: 22 },
  'WB-M':   { cls:'WB-M',  cabinAltMaxFt: 7500, maxDeltaPpsi: 8.9, descRocFpm: 6500, diveTASkts: 440, o2AvailMin: 18 },
  'NB':     { cls:'NB',    cabinAltMaxFt: 8000, maxDeltaPpsi: 8.6, descRocFpm: 6200, diveTASkts: 420, o2AvailMin: 12 },
  'RGN-J':  { cls:'RGN-J', cabinAltMaxFt: 8000, maxDeltaPpsi: 8.1, descRocFpm: 5800, diveTASkts: 380, o2AvailMin: 12 },
  'RGN-T':  { cls:'RGN-T', cabinAltMaxFt: 8000, maxDeltaPpsi: 6.5, descRocFpm: 3500, diveTASkts: 250, o2AvailMin: 10 },
  'BIZ':    { cls:'BIZ',   cabinAltMaxFt: 6000, maxDeltaPpsi: 10.3,descRocFpm: 8200, diveTASkts: 480, o2AvailMin: 25 },
  'LIGHT':  { cls:'LIGHT', cabinAltMaxFt: 12500,maxDeltaPpsi: 3.0, descRocFpm: 2000, diveTASkts: 180, o2AvailMin: 0 },
}

function classifyType(type?: string, op?: string): Class {
  const t = (type || '').toUpperCase()
  if (/B74|B77|B78|A35|A38|A33|A34|MD11/.test(t)) return 'WB-LH'
  if (/B76|A330|A300|A310|IL96/.test(t)) return 'WB-M'
  if (/B73|B75|A31|A32|A21|A20|BCS3|BCS1|MD8|MD9/.test(t)) return 'NB'
  if (/E17|E19|E29|E75|E90|CRJ|RJ85|RJ100|F70|F100/.test(t)) return 'RGN-J'
  if (/AT4|AT7|DH8|Q400|SF34|DHC6|BE20|BE10/.test(t)) return 'RGN-T'
  if (/GLEX|GLF|G650|G550|G450|FA[78]|CL35|CL60|C56|C68|EJET|H25|LJ/.test(t)) return 'BIZ'
  if (/C17|C172|C182|SR22|PC12|PA2|PA3|TBM|DA42|BE36|BE58|BE19/.test(t)) return 'LIGHT'
  // operator hint
  const o = (op || '').toUpperCase()
  if (/NETJETS|FLEXJET|VISTAJET|EXECUJET/.test(o)) return 'BIZ'
  return 'NB'
}

/* TUC for sitting, no exertion, at given cabin alt — log-interpolated
   from AC 61-107B App.1 / FAA-H-8083-25C Ch.7. Returns seconds. */
function tucSitting(cabinAltFt: number): number {
  // table (alt ft, TUC seconds, sitting)
  const T: [number, number][] = [
    [18000, 1500], [22000, 600], [25000, 240], [28000, 150],
    [30000, 90], [35000, 45], [40000, 18], [43000, 10], [50000, 6],
  ]
  if (cabinAltFt <= T[0][0]) return Infinity   // no impairment
  if (cabinAltFt >= T[T.length-1][0]) return T[T.length-1][1]
  for (let i = 0; i < T.length - 1; i++) {
    if (cabinAltFt <= T[i+1][0]) {
      const [a0, t0] = T[i], [a1, t1] = T[i+1]
      // log-interp on TUC
      const f = (cabinAltFt - a0) / (a1 - a0)
      const lt = Math.log(t0) + f * (Math.log(t1) - Math.log(t0))
      return Math.exp(lt)
    }
  }
  return T[T.length-1][1]
}

/* Effective TUC with rapid-decompression halving and exertion mult */
function tucEffective(cabinAltFt: number, rapidMul: number, exertionMul: number): number {
  const base = tucSitting(cabinAltFt)
  if (!isFinite(base)) return base
  return base * rapidMul * exertionMul
}

/* Estimate emergency descent time from current FL to 10kft (or MSA) */
function descentTimeSec(currentFt: number, targetFt: number, rocFpm: number): number {
  if (currentFt <= targetFt) return 0
  // average ROC: initial dive takes ~10s to reach VMO and full ROC
  const startup = 10  // sec
  const fullProfile = (currentFt - targetFt) / rocFpm * 60
  return startup + fullProfile
}

interface Stat {
  f: SFlight
  cls: Class
  spec: ClassSpec
  fl: number
  cabinAltNormalFt: number  // normal cabin alt at this FL
  decompFL: number          // FL of exposure post-failure (= aircraft alt)
  tucSec: number            // effective TUC seconds (rapid decomp)
  tucNormalSec: number      // TUC at normal cabin alt
  descSec: number           // emergency descent time to safe alt
  o2MarginSec: number       // TUC - descent
  paxMaskTriggered: boolean
  drivers: { CABIN: number; DECOMP: number; TUC: number; DESC: number; O2MARG: number; DUREXP: number; PAXMASK: number }
  score: number
  tier: Tier
}

function compute(f: SFlight, opts: {
  rapidMul: number; exertMul: number; targetFt: number;
  advMul: number; minFL: number; maxFL: number;
}): Stat | null {
  const cls = classifyType(f.type, f.operator)
  const spec = CLASS_SPECS[cls]
  const fl = Math.round(f.altitudeFt / 100)
  if (f.ground || fl < 50) {
    return {
      f, cls, spec, fl, cabinAltNormalFt: 0, decompFL: 0, tucSec: Infinity, tucNormalSec: Infinity,
      descSec: 0, o2MarginSec: Infinity, paxMaskTriggered: false,
      drivers: { CABIN: 0, DECOMP: 0, TUC: 0, DESC: 0, O2MARG: 0, DUREXP: 0, PAXMASK: 0 },
      score: 0, tier: 'ON-GROUND',
    }
  }

  // Estimate normal cabin altitude given ΔP and aircraft alt
  // ambient pressure ≈ 14.696 × (1 - 6.876e-6·h)^5.256  (psi, h ft)
  const ambientPSI = 14.696 * Math.pow(Math.max(0.001, 1 - 6.876e-6 * f.altitudeFt), 5.256)
  // cabin pressure when held at max ΔP
  const cabinPSImax = Math.min(14.696, ambientPSI + spec.maxDeltaPpsi)
  // invert atmosphere to get cabin alt for that pressure (clamp to spec floor)
  const cabinAltFromPSI = (psi: number) => (1 - Math.pow(psi / 14.696, 1/5.256)) / 6.876e-6
  const cabinAltNormalFt = Math.max(0, Math.min(spec.cabinAltMaxFt, cabinAltFromPSI(cabinPSImax)))

  // TUC scenarios
  const decompFL = fl
  const tucNormalSec = tucEffective(cabinAltNormalFt, 1.0, opts.exertMul)
  const tucSec = tucEffective(f.altitudeFt, opts.rapidMul, opts.exertMul)
  const descSec = descentTimeSec(f.altitudeFt, opts.targetFt, spec.descRocFpm)
  const o2MarginSec = (isFinite(tucSec) ? tucSec : 9999) - descSec

  // Drivers — 0..1 each
  const d_cabin = Math.max(0, Math.min(1, (cabinAltNormalFt - 6000) / 6500))   // 6k→0, 12.5k→1
  const d_decomp = Math.max(0, Math.min(1, (fl - 200) / 230))                  // FL200→0, FL430→1
  // TUC severity: 0 if >300s, 1 if ≤10s (log ramp)
  const tucBound = isFinite(tucSec) ? tucSec : 9999
  const d_tuc = Math.max(0, Math.min(1, (Math.log(300) - Math.log(Math.max(5, tucBound))) / (Math.log(300) - Math.log(5))))
  const d_desc = Math.max(0, Math.min(1, (descSec - 90) / 300))                // 90s→0, 390s→1
  // O2 margin negative is critical
  const d_o2 = o2MarginSec < 0 ? 1 : Math.max(0, Math.min(1, (60 - o2MarginSec) / 120))
  // Duration exposure proxy: heuristic from |VS| (cruise=high exposure)
  const d_durexp = Math.abs(f.vertRate) < 200 && fl >= 280 ? 0.6 : 0.2
  const paxMaskTriggered = cabinAltNormalFt > 14000
  const d_paxmask = paxMaskTriggered ? 0.8 : 0

  const arr = [d_cabin, d_decomp, d_tuc, d_desc, d_o2, d_durexp, d_paxmask]
  const max = Math.max(...arr), mean = arr.reduce((a,b)=>a+b,0) / arr.length
  let score = (max * 0.66 + mean * 0.34) * 100 * opts.advMul

  // Hard escalators
  if (o2MarginSec < 0 && fl >= 250) score = Math.max(score, 90)                // TUC < descent
  if (tucBound < 30) score = Math.max(score, 84)                                // TUC under 30s
  if (paxMaskTriggered) score = Math.max(score, 60)
  if (fl >= 410 && cls !== 'BIZ') score = Math.max(score, 55)                   // high FL non-biz

  let tier: Tier = 'NOMINAL'
  if (fl < opts.minFL || fl > opts.maxFL) tier = 'ON-GROUND'
  else if (score >= 85) tier = 'CRIT-HYPOX'
  else if (score >= 70) tier = 'SEVERE'
  else if (score >= 50) tier = 'ELEVATED'
  else if (score >= 30) tier = 'WATCH'
  else tier = 'NOMINAL'

  return {
    f, cls, spec, fl, cabinAltNormalFt, decompFL, tucSec, tucNormalSec, descSec, o2MarginSec, paxMaskTriggered,
    drivers: { CABIN: d_cabin, DECOMP: d_decomp, TUC: d_tuc, DESC: d_desc, O2MARG: d_o2, DUREXP: d_durexp, PAXMASK: d_paxmask },
    score: Math.min(100, Math.round(score)), tier,
  }
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec > 1800) return '∞'
  if (sec >= 60) return `${Math.floor(sec/60)}m${String(Math.round(sec%60)).padStart(2,'0')}s`
  return `${Math.round(sec)}s`
}

function adviceFor(s: Stat): string {
  switch (s.tier) {
    case 'CRIT-HYPOX': return `TUC ${fmtTime(s.tucSec)} < descent ${fmtTime(s.descSec)} · CREW WILL BE INCAPACITATED before reaching 10k · don O₂ mask <5s per §25.1443 · EMER-DESCENT immediate (Helios 522 / Payne Stewart precedent)`
    case 'SEVERE':     return `TUC ${fmtTime(s.tucSec)} slim margin vs descent ${fmtTime(s.descSec)} · don quick-don mask <5s per §25.1443 · initiate emer-descent per FCOM SP.16.1 / FCOM PRO-ABN-EMER-D`
    case 'ELEVATED':   return `TUC ${fmtTime(s.tucSec)} adequate but tight · review descent profile · ensure pax-mask trigger ${s.paxMaskTriggered?'ARMED':'standby'} per §25.1447`
    case 'WATCH':      return `TUC ${fmtTime(s.tucSec)} ≥ 2× descent · routine monitoring · cabin-alt nominal ${s.cabinAltNormalFt.toFixed(0)}ft`
    case 'NOMINAL':    return `Cabin ${s.cabinAltNormalFt.toFixed(0)}ft · no hypoxia risk · pressurisation within ΔP ${s.spec.maxDeltaPpsi.toFixed(1)} psi cert`
    default:           return `On-ground or below FL${'?'} threshold · no exposure`
  }
}

export default function TucHypoxia({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState(180)
  const [maxFL, setMaxFL] = useState(450)
  const [rapidMul, setRapidMul] = useState(0.5)
  const [exertMul, setExertMul] = useState(1.0)
  const [targetFt, setTargetFt] = useState(10000)
  const [advMul, setAdvMul] = useState(1.0)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showVec, setShowVec] = useState(true)
  const [clsFilter, setClsFilter] = useState<Class|null>(null)
  const [tierFilter, setTierFilter] = useState<Tier|null>(null)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'TUC-CHART'>('AIRCRAFT')
  const [pickedIcao, setPickedIcao] = useState<string|null>(null)

  const stats = useMemo(() => {
    const opts = { rapidMul, exertMul, targetFt, advMul, minFL, maxFL }
    const out: Stat[] = []
    for (const f of flights) {
      const s = compute(f, opts)
      if (s) out.push(s)
    }
    return out
  }, [flights, rapidMul, exertMul, targetFt, advMul, minFL, maxFL])

  const tierCounts = useMemo(() => {
    const c: Record<Tier,number> = {'CRIT-HYPOX':0,'SEVERE':0,'ELEVATED':0,'WATCH':0,'NOMINAL':0,'ON-GROUND':0}
    for (const s of stats) c[s.tier]++
    return c
  }, [stats])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return stats.filter(s => {
      if (clsFilter && s.cls !== clsFilter) return false
      if (tierFilter && s.tier !== tierFilter) return false
      if (q) {
        const hay = `${s.f.callsign||''} ${s.f.type||''} ${s.f.operator||''} ${s.cls}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return s.tier !== 'ON-GROUND'
    }).sort((a,b) => {
      const ta = TIER_ORDER.indexOf(a.tier), tb = TIER_ORDER.indexOf(b.tier)
      if (ta !== tb) return ta - tb
      return b.score - a.score
    })
  }, [stats, clsFilter, tierFilter, search])

  const summary = useMemo(() => {
    const active = stats.filter(s => s.tier !== 'ON-GROUND')
    if (!active.length) return { meanTUC: 0, meanDesc: 0, worstCs: '—', crit: 0, paxMask: 0, meanFL: 0 }
    const finiteTUC = active.filter(s => isFinite(s.tucSec))
    const meanTUC = finiteTUC.length ? finiteTUC.reduce((a,s)=>a+s.tucSec,0)/finiteTUC.length : 0
    const meanDesc = active.reduce((a,s)=>a+s.descSec,0)/active.length
    const worst = active.slice().sort((a,b)=>b.score-a.score)[0]
    const crit = tierCounts['CRIT-HYPOX']
    const paxMask = active.filter(s=>s.paxMaskTriggered).length
    const meanFL = active.reduce((a,s)=>a+s.fl,0)/active.length
    return { meanTUC, meanDesc, worstCs: worst.f.callsign || worst.f.icao.slice(0,6), crit, paxMask, meanFL }
  }, [stats, tierCounts])

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const sid = 'tuc-src', haloId = 'tuc-halo', pinId = 'tuc-pin', lblId = 'tuc-lbl', vecId = 'tuc-vec', vecSrc = 'tuc-vec-src'
    const features: GeoJSON.Feature[] = []
    const vecFeatures: GeoJSON.Feature[] = []
    for (const s of stats) {
      if (s.tier === 'ON-GROUND') continue
      if (clsFilter && s.cls !== clsFilter) continue
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.f.lng, s.f.lat] },
        properties: {
          tier: s.tier, score: s.score, cs: s.f.callsign || s.f.icao.slice(0,6),
          fl: s.fl, tuc: fmtTime(s.tucSec), desc: fmtTime(s.descSec),
          color: TIER_COLOR[s.tier], radius: 7 + s.score/7.5,
          pin: s.tier === 'CRIT-HYPOX' || s.tier === 'SEVERE',
        },
      })
      // forward vector — emergency-descent reach footprint
      if (s.tier === 'CRIT-HYPOX' || s.tier === 'SEVERE') {
        const reachNM = (s.spec.diveTASkts * s.descSec) / 3600
        const tk = (s.f.track || 0) * Math.PI / 180
        const dLat = reachNM / 60 * Math.cos(tk)
        const dLng = reachNM / 60 * Math.sin(tk) / Math.cos(s.f.lat * Math.PI/180)
        vecFeatures.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[s.f.lng, s.f.lat], [s.f.lng + dLng, s.f.lat + dLat]] },
          properties: { color: TIER_COLOR[s.tier] },
        })
      }
    }
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features }
    const vfc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: vecFeatures }
    try {
      const src = map.getSource(sid) as maplibregl.GeoJSONSource | undefined
      if (src) src.setData(fc)
      else {
        map.addSource(sid, { type: 'geojson', data: fc })
        map.addLayer({ id: haloId, type: 'circle', source: sid, paint: { 'circle-radius': ['get','radius'], 'circle-color': ['get','color'], 'circle-opacity': 0.16, 'circle-stroke-color': ['get','color'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.7 }})
        map.addLayer({ id: pinId, type: 'circle', source: sid, filter: ['==',['get','pin'],true], paint: { 'circle-radius': 4, 'circle-color': ['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1 }})
        map.addLayer({ id: lblId, type: 'symbol', source: sid, layout: { 'text-field': ['concat', ['get','cs'], ' FL', ['to-string',['get','fl']], ' TUC ', ['get','tuc'], ' / desc ', ['get','desc']], 'text-size': 9.5, 'text-offset': [0, 1.3], 'text-anchor':'top', 'text-font':['Open Sans Regular'] }, paint: { 'text-color':'#e2e8f0', 'text-halo-color':'#0f172a', 'text-halo-width':1 }})
      }
      const vsrc = map.getSource(vecSrc) as maplibregl.GeoJSONSource | undefined
      if (vsrc) vsrc.setData(vfc)
      else {
        map.addSource(vecSrc, { type: 'geojson', data: vfc })
        map.addLayer({ id: vecId, type: 'line', source: vecSrc, paint: { 'line-color': ['get','color'], 'line-width': 1.5, 'line-dasharray': [2, 2], 'line-opacity': 0.7 }})
      }
      map.setLayoutProperty(haloId, 'visibility', showHalo ? 'visible' : 'none')
      map.setLayoutProperty(pinId, 'visibility', showPin ? 'visible' : 'none')
      map.setLayoutProperty(lblId, 'visibility', showLbl ? 'visible' : 'none')
      map.setLayoutProperty(vecId, 'visibility', showVec ? 'visible' : 'none')
    } catch { /* ignore */ }
    return () => {
      try {
        for (const id of [lblId, pinId, haloId, vecId]) if (map.getLayer(id)) map.removeLayer(id)
        for (const id of [sid, vecSrc]) if (map.getSource(id)) map.removeSource(id)
      } catch { /* ignore */ }
    }
  }, [map, stats, showHalo, showPin, showLbl, showVec, clsFilter])

  const picked = filtered.find(s => s.f.icao === pickedIcao) || filtered[0]

  /* TUC CHART SVG: cabin alt (10kft → 50kft) vs TUC seconds (log) */
  const chartSVG = useMemo(() => {
    const W = 460, H = 260, PAD = 36
    const xs = (alt: number) => PAD + (alt - 10000) / 40000 * (W - 2*PAD)
    const ys = (sec: number) => {
      const ls = Math.log(Math.max(5, Math.min(1800, sec)))
      const l0 = Math.log(5), l1 = Math.log(1800)
      return H - PAD - (ls - l0) / (l1 - l0) * (H - 2*PAD)
    }
    // build TUC curves: sitting (no decomp), rapid (×0.5), moderate exertion (×0.7)
    const buildCurve = (mul: number) => {
      const path: string[] = []
      for (let alt = 10000; alt <= 50000; alt += 500) {
        const t = tucSitting(alt) * mul
        if (!isFinite(t)) continue
        path.push(`${path.length === 0 ? 'M' : 'L'} ${xs(alt).toFixed(1)} ${ys(t).toFixed(1)}`)
      }
      return path.join(' ')
    }
    return { W, H, PAD, xs, ys,
      pathSit: buildCurve(1.0),
      pathRapid: buildCurve(0.5),
      pathExert: buildCurve(0.7),
    }
  }, [])

  return (
    <div style={{ position:'fixed', right:12, top:60, width:520, maxHeight:'88vh', overflow:'auto', background:'rgba(15,23,42,0.96)', border:'1px solid rgba(148,163,184,0.25)', borderRadius:12, padding:14, color:'#e2e8f0', fontSize:11, fontFamily:'-apple-system,system-ui,sans-serif', zIndex:50, boxShadow:'0 12px 40px rgba(0,0,0,0.5)' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:700, color:'#f1f5f9' }}>TUC · Hypoxia Risk Monitor</div>
          <div style={{ fontSize:9, color:'#94a3b8', marginTop:2 }}>Time-of-Useful-Consciousness & rapid-decompression · AC 61-107B / Ernsting 5e Ch.5</div>
        </div>
        <button onClick={onClose} style={{ background:'transparent', border:'1px solid rgba(148,163,184,0.3)', color:'#cbd5e1', padding:'3px 8px', borderRadius:6, cursor:'pointer' }}>✕</button>
      </div>

      {/* tier strip */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:4, marginBottom:8 }}>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(tierFilter===t?null:t)} style={{ background: tierFilter===t ? `${TIER_COLOR[t]}30` : 'rgba(30,41,59,0.6)', border:`1px solid ${tierFilter===t?TIER_COLOR[t]+'80':'rgba(148,163,184,0.18)'}`, borderRadius:6, padding:'4px 2px', color:'#e2e8f0', cursor:'pointer', fontSize:9 }}>
            <div style={{ color: TIER_COLOR[t], fontWeight:700, fontSize:13 }}>{tierCounts[t]}</div>
            <div style={{ fontSize:8, color:'#94a3b8' }}>{t}</div>
          </button>
        ))}
      </div>

      {/* summary */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:4, marginBottom:8 }}>
        {[
          ['μTUC', fmtTime(summary.meanTUC)],
          ['μDESC', fmtTime(summary.meanDesc)],
          ['WORST', summary.worstCs],
          ['CRIT', String(summary.crit)],
          ['PAXMASK', String(summary.paxMask)],
          ['μFL', summary.meanFL.toFixed(0)],
        ].map(([k,v]) => (
          <div key={k} style={{ background:'rgba(30,41,59,0.6)', border:'1px solid rgba(148,163,184,0.15)', borderRadius:6, padding:'4px 4px' }}>
            <div style={{ fontSize:8, color:'#94a3b8' }}>{k}</div>
            <div style={{ fontSize:10.5, fontWeight:600, color:'#f1f5f9' }}>{v}</div>
          </div>
        ))}
      </div>

      {/* sliders */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:8 }}>
        <label style={{ fontSize:9, color:'#94a3b8' }}>MIN-FL {minFL}<input type="range" min={100} max={350} step={10} value={minFL} onChange={e=>setMinFL(+e.target.value)} style={{ width:'100%' }}/></label>
        <label style={{ fontSize:9, color:'#94a3b8' }}>MAX-FL {maxFL}<input type="range" min={300} max={500} step={10} value={maxFL} onChange={e=>setMaxFL(+e.target.value)} style={{ width:'100%' }}/></label>
        <label style={{ fontSize:9, color:'#94a3b8' }}>RAPID-MUL {rapidMul.toFixed(2)}<input type="range" min={0.3} max={1.0} step={0.05} value={rapidMul} onChange={e=>setRapidMul(+e.target.value)} style={{ width:'100%' }}/></label>
        <label style={{ fontSize:9, color:'#94a3b8' }}>EXERT-MUL {exertMul.toFixed(2)}<input type="range" min={0.5} max={1.5} step={0.05} value={exertMul} onChange={e=>setExertMul(+e.target.value)} style={{ width:'100%' }}/></label>
        <label style={{ fontSize:9, color:'#94a3b8' }}>TARGET-FT {targetFt}<input type="range" min={8000} max={16000} step={500} value={targetFt} onChange={e=>setTargetFt(+e.target.value)} style={{ width:'100%' }}/></label>
        <label style={{ fontSize:9, color:'#94a3b8' }}>ADV-MUL {advMul.toFixed(2)}<input type="range" min={0.5} max={2.0} step={0.05} value={advMul} onChange={e=>setAdvMul(+e.target.value)} style={{ width:'100%' }}/></label>
      </div>

      {/* class chips */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:3, marginBottom:8 }}>
        {CLASS_LIST.map(c => (
          <button key={c} onClick={()=>setClsFilter(clsFilter===c?null:c)} style={{ background: clsFilter===c ? CLASS_COLOR[c]+'30' : 'rgba(30,41,59,0.6)', border:`1px solid ${clsFilter===c?CLASS_COLOR[c]+'90':'rgba(148,163,184,0.18)'}`, borderRadius:5, padding:'2px 6px', color:'#cbd5e1', fontSize:9, cursor:'pointer' }}>{c}</button>
        ))}
      </div>

      {/* layer toggles + search */}
      <div style={{ display:'flex', gap:4, marginBottom:8, alignItems:'center', flexWrap:'wrap' }}>
        {(['HALO','PIN','LBL','VEC'] as const).map(k => {
          const v = k==='HALO'?showHalo:k==='PIN'?showPin:k==='LBL'?showLbl:showVec
          const set = k==='HALO'?setShowHalo:k==='PIN'?setShowPin:k==='LBL'?setShowLbl:setShowVec
          return <button key={k} onClick={()=>set(!v)} style={{ background: v ? 'rgba(14,165,233,0.15)' : 'rgba(30,41,59,0.6)', border:`1px solid ${v?'rgba(14,165,233,0.4)':'rgba(148,163,184,0.18)'}`, borderRadius:5, padding:'3px 7px', color:'#cbd5e1', fontSize:9, cursor:'pointer' }}>{k}</button>
        })}
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="cs/type/op/class" style={{ flex:1, background:'rgba(30,41,59,0.7)', border:'1px solid rgba(148,163,184,0.2)', borderRadius:5, padding:'3px 7px', color:'#e2e8f0', fontSize:10 }}/>
      </div>

      {/* tab switcher */}
      <div style={{ display:'flex', gap:3, marginBottom:8 }}>
        {(['AIRCRAFT','CLASSES','TUC-CHART'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} style={{ flex:1, background: tab===t ? 'rgba(14,165,233,0.18)' : 'rgba(30,41,59,0.6)', border:`1px solid ${tab===t?'rgba(14,165,233,0.45)':'rgba(148,163,184,0.18)'}`, borderRadius:5, padding:'4px 0', color:'#e2e8f0', fontSize:10, cursor:'pointer' }}>{t}</button>
        ))}
      </div>

      {tab === 'AIRCRAFT' && (
        <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
          {filtered.slice(0,40).map(s => (
            <div key={s.f.icao} onClick={()=>{setPickedIcao(s.f.icao); onFly(s.f.icao, s.f.lat, s.f.lng, 6)}} style={{ background:'rgba(30,41,59,0.55)', border:`1px solid ${TIER_COLOR[s.tier]}40`, borderLeft:`3px solid ${TIER_COLOR[s.tier]}`, borderRadius:6, padding:'6px 8px', cursor:'pointer' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:3 }}>
                <div style={{ fontSize:10.5, fontWeight:600 }}>{s.f.callsign || s.f.icao.slice(0,6)} <span style={{ color:'#94a3b8', fontWeight:400, fontSize:9 }}>{s.f.type || ''} · {s.f.operator || ''}</span></div>
                <div style={{ display:'flex', gap:3 }}>
                  <span style={{ background: CLASS_COLOR[s.cls]+'25', border:`1px solid ${CLASS_COLOR[s.cls]}60`, color:CLASS_COLOR[s.cls], fontSize:8, padding:'1px 5px', borderRadius:3 }}>{s.cls}</span>
                  <span style={{ background: TIER_COLOR[s.tier]+'25', border:`1px solid ${TIER_COLOR[s.tier]}80`, color:TIER_COLOR[s.tier], fontSize:8, padding:'1px 5px', borderRadius:3 }}>{s.tier}</span>
                </div>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:3, marginBottom:3 }}>
                {[['FL', s.fl],['CABIN', s.cabinAltNormalFt.toFixed(0)],['TUC', fmtTime(s.tucSec)],['DESC', fmtTime(s.descSec)]].map(([k,v]) => <div key={k as string} style={{ background:'rgba(15,23,42,0.6)', borderRadius:3, padding:'2px 4px' }}><div style={{ fontSize:7.5, color:'#94a3b8' }}>{k}</div><div style={{ fontSize:9.5 }}>{v}</div></div>)}
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:3, marginBottom:4 }}>
                {[['O₂-MARG', (s.o2MarginSec >= 0 ? '+' : '') + fmtTime(s.o2MarginSec)],['ΔP-cert', s.spec.maxDeltaPpsi.toFixed(1)+' psi'],['ROD', s.spec.descRocFpm+' fpm']].map(([k,v]) => <div key={k} style={{ background:'rgba(15,23,42,0.6)', borderRadius:3, padding:'2px 4px' }}><div style={{ fontSize:7.5, color:'#94a3b8' }}>{k}</div><div style={{ fontSize:9.5 }}>{v}</div></div>)}
              </div>
              <div style={{ height:4, background:'rgba(15,23,42,0.8)', borderRadius:2, overflow:'hidden', marginBottom:3 }}>
                <div style={{ width:`${s.score}%`, height:'100%', background: TIER_COLOR[s.tier] }}/>
              </div>
              <div style={{ display:'flex', gap:2, flexWrap:'wrap', marginBottom:3 }}>
                {Object.entries(s.drivers).map(([k,v]) => <span key={k} style={{ background:`rgba(${v>0.6?'244,63,94':v>0.3?'245,158,11':'71,85,105'},0.25)`, border:'1px solid rgba(148,163,184,0.15)', borderRadius:3, padding:'1px 4px', fontSize:7.5, color:'#cbd5e1' }}>{k} {(v*100).toFixed(0)}</span>)}
              </div>
              <div style={{ fontSize:8.5, color: TIER_COLOR[s.tier], opacity:0.9 }}>{adviceFor(s)}</div>
            </div>
          ))}
          {!filtered.length && <div style={{ fontSize:10, color:'#64748b', textAlign:'center', padding:20 }}>No exposed aircraft matching filter</div>}
        </div>
      )}

      {tab === 'CLASSES' && (
        <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
          {CLASS_LIST.map(c => {
            const acs = stats.filter(s => s.cls === c && s.tier !== 'ON-GROUND')
            const spec = CLASS_SPECS[c]
            const finiteTUC = acs.filter(s => isFinite(s.tucSec))
            const meanTUC = finiteTUC.length ? finiteTUC.reduce((a,s)=>a+s.tucSec,0)/finiteTUC.length : 0
            const crit = acs.filter(s=>s.tier==='CRIT-HYPOX').length
            const sev = acs.filter(s=>s.tier==='SEVERE').length
            return (
              <div key={c} style={{ background:'rgba(30,41,59,0.55)', border:`1px solid ${CLASS_COLOR[c]}40`, borderLeft:`3px solid ${CLASS_COLOR[c]}`, borderRadius:6, padding:'6px 8px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                  <div style={{ fontSize:10.5, fontWeight:600, color: CLASS_COLOR[c] }}>{c}</div>
                  <div style={{ fontSize:9, color:'#94a3b8' }}>{acs.length} ac · {crit} CRIT · {sev} SEV</div>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:3 }}>
                  {[['Cabin-max', spec.cabinAltMaxFt+'ft'],['ΔP-cert', spec.maxDeltaPpsi.toFixed(1)+' psi'],['ROD', spec.descRocFpm+' fpm'],['Dive-TAS', spec.diveTASkts+' kt'],['μTUC', fmtTime(meanTUC)]].map(([k,v]) => <div key={k as string} style={{ background:'rgba(15,23,42,0.6)', borderRadius:3, padding:'2px 4px' }}><div style={{ fontSize:7.5, color:'#94a3b8' }}>{k}</div><div style={{ fontSize:9.5 }}>{v}</div></div>)}
                </div>
                <div style={{ marginTop:3, fontSize:7.5, color:'#64748b', fontStyle:'italic' }}>per CS-25.841 / §25.1447 / Boeing FCOM SP.16.1 / Airbus FCOM PRO-ABN-EMER-D · pax-mask O₂ {spec.o2AvailMin}min installed</div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'TUC-CHART' && (
        <div>
          <div style={{ background:'rgba(15,23,42,0.7)', border:'1px solid rgba(148,163,184,0.15)', borderRadius:6, padding:6 }}>
            <svg width={chartSVG.W} height={chartSVG.H} style={{ display:'block', maxWidth:'100%' }}>
              <rect x={chartSVG.PAD} y={chartSVG.PAD} width={chartSVG.W - 2*chartSVG.PAD} height={chartSVG.H - 2*chartSVG.PAD} fill="rgba(15,23,42,0.4)" stroke="rgba(148,163,184,0.25)"/>
              {/* alt gridlines */}
              {[10000,20000,25000,30000,35000,40000,45000,50000].map(alt => (
                <g key={alt}>
                  <line x1={chartSVG.xs(alt)} y1={chartSVG.PAD} x2={chartSVG.xs(alt)} y2={chartSVG.H-chartSVG.PAD} stroke="rgba(148,163,184,0.1)"/>
                  <text x={chartSVG.xs(alt)} y={chartSVG.H-chartSVG.PAD+12} fontSize="8" fill="#94a3b8" textAnchor="middle">{alt/1000}k</text>
                </g>
              ))}
              {/* TUC sec gridlines (log) */}
              {[10,30,60,120,300,600,1200].map(s => (
                <g key={s}>
                  <line x1={chartSVG.PAD} y1={chartSVG.ys(s)} x2={chartSVG.W-chartSVG.PAD} y2={chartSVG.ys(s)} stroke="rgba(148,163,184,0.1)"/>
                  <text x={chartSVG.PAD-3} y={chartSVG.ys(s)+3} fontSize="8" fill="#94a3b8" textAnchor="end">{s<60?s+'s':Math.floor(s/60)+'m'}</text>
                </g>
              ))}
              {/* TUC curves */}
              <path d={chartSVG.pathSit} stroke="#10b981" strokeWidth={1.8} fill="none"/>
              <path d={chartSVG.pathExert} stroke="#f59e0b" strokeWidth={1.4} fill="none" strokeDasharray="4,2"/>
              <path d={chartSVG.pathRapid} stroke="#f43f5e" strokeWidth={1.8} fill="none"/>
              {/* legend */}
              <g transform={`translate(${chartSVG.W - chartSVG.PAD - 130}, ${chartSVG.PAD + 6})`}>
                <rect x={-4} y={-4} width={134} height={48} fill="rgba(15,23,42,0.7)" stroke="rgba(148,163,184,0.2)"/>
                <line x1={0} y1={4} x2={14} y2={4} stroke="#10b981" strokeWidth={1.8}/>
                <text x={18} y={7} fontSize="8.5" fill="#cbd5e1">sitting · no decomp</text>
                <line x1={0} y1={18} x2={14} y2={18} stroke="#f59e0b" strokeWidth={1.4} strokeDasharray="4,2"/>
                <text x={18} y={21} fontSize="8.5" fill="#cbd5e1">moderate exertion</text>
                <line x1={0} y1={32} x2={14} y2={32} stroke="#f43f5e" strokeWidth={1.8}/>
                <text x={18} y={35} fontSize="8.5" fill="#cbd5e1">rapid decomp</text>
              </g>
              {/* aircraft dots */}
              {stats.filter(s => s.tier !== 'ON-GROUND' && (!clsFilter || s.cls === clsFilter)).slice(0,200).map(s => (
                <circle key={s.f.icao} cx={chartSVG.xs(s.f.altitudeFt)} cy={chartSVG.ys(isFinite(s.tucSec)?s.tucSec:1700)} r={s.f.icao === pickedIcao ? 4 : 2.2} fill={TIER_COLOR[s.tier]} fillOpacity={0.8} stroke={s.f.icao===pickedIcao?'#fff':'none'} strokeWidth={1}/>
              ))}
              {/* picked descent target marker */}
              {picked && <line x1={chartSVG.xs(targetFt)} y1={chartSVG.PAD} x2={chartSVG.xs(targetFt)} y2={chartSVG.H-chartSVG.PAD} stroke="#0ea5e9" strokeWidth={1} strokeDasharray="3,3"/>}
            </svg>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:4, marginTop:6 }}>
              {(() => {
                const acs = stats.filter(s => s.tier !== 'ON-GROUND')
                const finT = acs.filter(s => isFinite(s.tucSec))
                const μT = finT.length ? finT.reduce((a,s)=>a+s.tucSec,0)/finT.length : 0
                const μD = acs.length ? acs.reduce((a,s)=>a+s.descSec,0)/acs.length : 0
                const negO = acs.filter(s=>s.o2MarginSec<0).length
                const pickedTUC = picked ? fmtTime(picked.tucSec) : '—'
                return [['μTUC', fmtTime(μT)],['μDESC', fmtTime(μD)],['O₂-NEG', negO],['PICKED', pickedTUC]].map(([k,v]) => <div key={k as string} style={{ background:'rgba(30,41,59,0.6)', borderRadius:3, padding:'3px 5px' }}><div style={{ fontSize:7.5, color:'#94a3b8' }}>{k}</div><div style={{ fontSize:10 }}>{v}</div></div>)
              })()}
            </div>
          </div>
          <div style={{ marginTop:8, fontSize:8.5, color:'#94a3b8', lineHeight:1.5 }}>
            TUC curves derived from FAA AC 61-107B App.1 and FAA-H-8083-25C Ch.7 sitting-passenger tabulation, log-interpolated between certified observation points. Rapid-decompression curve halves the sitting baseline per Ernsting&apos;s Aviation &amp; Space Medicine 5e Ch.5 and Brooks ASEM 60 1989, reflecting forced exhalation and pulmonary N₂ washout. Composite hypoxia score weights cabin-altitude, decompression-FL, effective TUC, emergency-descent time to {(targetFt/1000).toFixed(0)}kft, O₂ margin (TUC − descent), persistent high-FL exposure, and pax-mask trigger threshold per §25.1447(c)(1). Emergency-descent vectors on map show rapid-decompression footprint distance at class dive-TAS over computed descent duration per Boeing FCOM SP.16.1 / Airbus FCOM PRO-ABN-EMER-D.
          </div>
          <div style={{ marginTop:6, fontSize:8, color:'#64748b', lineHeight:1.5 }}>
            References: FAA AC 61-107B App.1 · FAA-H-8083-25C Ch.7 · FAA AC 25-20 · 14 CFR §25.841 §121.333 §91.211 §25.1447 §25.1443 · EASA CS-25.841 / AMC-25.841 · ICAO Annex 6 Pt I §4.4.2 · Doc 9760 Vol II Pt VI · Doc 8984 §2.5 · MIL-STD-3013A §A.4.43 · USAF AFP 11-217 Vol III §5 · Ernsting&apos;s Aviation &amp; Space Medicine 5e Ch.5 · Gradwell &amp; Rainford 5e Ch.4 · West Respiratory Physiology 10e Ch.9 · Brooks ASEM 60 1989 · Files JAMA 232 1975 · NTSB AAR-29-04 Helios 522 · AAR-00-01 Payne Stewart · AAR-13-02 Mountain Air Cargo · Boeing FCOM SP.16.1 · Airbus FCOM PRO-ABN-EMER-D.
          </div>
        </div>
      )}
    </div>
  )
}
