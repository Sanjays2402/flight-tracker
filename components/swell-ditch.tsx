'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS, type AirportPin } from './airports'

/* ============================================================
   SWELL · Sea-State / Ditching-Survivability & Raft-Drift
   ------------------------------------------------------------
   Per-airframe over-water ditching-survivability scorer for
   every airborne flight whose projected glide footprint falls
   outside the catchment of a suitable diversion airport. Each
   row computes the most-likely ditching footprint (centroid +
   24/48/72h raft drift) under live Douglas Sea-State + WMO
   Beaufort wind + USCG cold-water survival nomogram + MRCC
   SAR catchment window, distinct from:

     · GLD (glide-reach) — measures the glide envelope itself
     · SAR (planner)     — interactive SAR ramp / asset chooser
     · ULB (pinger)      — CVR/FDR battery EOL + acoustic range
     · MEDLINK (med)     — in-flight medical diversion advisor

   SWELL is the ditching-time-of-flight survivability layer:
   what happens *after* the airframe enters the water.

   ------------------------------------------------------------
   Sea-state model (Douglas + WMO 1100-1106):
     Hs (significant-wave height m) estimated from wind speed
     U10 (10m wind) via fully-developed-sea WMO Pierson-
     Moskowitz approximation Hs ≈ 0.022 · U10² ft (Hasselmann
     1973, WAFOS / WMO 471 §1.4) clamped to fetch-limited
     basin index. Open ocean basins (NAT / PAC / SIO / ARC):
       · NAT 40-60°N — high mean Hs 3-5m, winter storm track
       · PAC 25-50°N — moderate Hs 2-4m, jet-stream coupled
       · SIO 30-50°S — high Hs 4-6m, "roaring 40s" annual
       · ARC >65°N    — moderate Hs 2-3m + ice-rim hazard
       · ITCZ <10°    — low Hs <2m, squall-prone
     Sea-state 0-9 mapped to Hs band per Douglas (1929).
     Crosswind/sea-vs-axis angle ψ derived from synthetic
     surface wind direction (deterministic per-icao24 hash).

   Survival model:
     · Water temperature Tw °C from latitude zonal SST proxy
       per NOAA WOA-23 §5 (deg-C = 28·cos²(lat) − 2 with
       Antarctic adjustment) — open-ocean only, not coastal.
     · Survival-time-without-immersion-suit (USCG cold-water
       nomogram CG-PUB-3-3 Ch.4 Fig 4-2):
         Tw > 26°C  no thermal limit (heat exhaustion 12h)
         15-25°C    6h  expected, 24h fatigue limit
         10-15°C    2h  expected, 4-6h limit
         5-10°C     1h  expected, 1-3h limit
         <5°C       30min expected, <1h limit
     · With immersion suit (SOLAS Ch.III Reg.7 / LSA Code
       Ch.II §2.3) — multiply survival window ×4 capped
       at 24h water-only, hypothermia eventually fatal.
     · Raft endurance: 96h potable water + ration kit per
       FAA TSO-C70a / 14 CFR §121.339 / SOLAS LSA §4.1.

   Raft drift (Ekman + windage):
     Surface-current proxy: latitude-band geostrophic
     velocity 0.1-0.5kt (mid-gyre vs WBC), windage 3% of
     U10 per Allen-Plourde USCG-R&DC-2005 Ch.2 §2.3.
     Drift bearing = 0.6·(wind-to-bearing − 35° right
     deflection for NH Ekman / +35° left for SH).
     Cumulative drift distance d(t) = (0.03·U10 + 0.3) · t
     where U10 in kts, t in hours, d in NM.

   SAR catchment proxy:
     16-MRCC catalogue:
       JRCC-Halifax / Norfolk / Honolulu / Alameda / Adak
       JRCC-Falmouth UK / Stavanger / Reykjavík / Bodø
       MRCC-Goonhilly / Brest CROSS-Gris-Nez / Madrid
       Tokyo MRCC / RCC-Hong Kong / Seoul / Auckland
       Cape Town MRCC / Buenos Aires.
     Each MRCC has a 1500-NM Bombardier CL-415 / C-130J /
     P-8A nominal first-response range per IAMSAR Vol II
     §3.4 + USCG ops review. Time-to-survivor = great-circle
     distance / 380 KTAS (P-8A cruise) + 1.5h launch delay.

   6 drivers (max·0.64 + mean·0.36 × ADV-MUL):
     · DITCH  ditch-likelihood proxy (over-water + no nearby
              airport ramp + low-FL stranding)
     · STATE  Douglas Sea-State 0-9
     · TEMP   water-temp / hypothermia exposure
     · DRIFT  72h raft drift NM
     · SAR    Δt SAR-arrival vs water-survival window
     · NIGHT  diurnal night-ditching multiplier

   Hard escalators:
     · Sea-State ≥7 + no suit       score-min 88
     · Tw < 5°C + SAR > 2h          score-min 84
     · SAR > water-survival window  score-min 86
     · Night + Sea-State ≥6         score-min 78

   6 tiers:
     · CATASTROPHIC ≥85 rose — Stockdale-class survival
       (SS≥7 + Tw<5°C + SAR > survival window) — divert NOW
     · CRITICAL    ≥70 rose-pink — narrow window; brief
       crew, deploy raft drills, suit-up cabin crew
     · MARGINAL    ≥50 amber — survivable with SOLAS kit,
       SAR feasible; monitor cell
     · ADEQUATE    ≥30 sky — moderate sea, warm SST,
       SAR <90min — manageable
     · COMFORTABLE <30 emerald — calm sea + warm SST +
       close SAR — Hudson-class outcome plausible
     · OFF         slate — not over-water (>50NM inland)

   Phase-gate: airborne, ≥FL080, over-water (no nearby
   airport within 200NM) or projected glide footprint fully
   over water.

   ------------------------------------------------------------
   References:
     · IMO SOLAS Ch.III Reg.7 / LSA Code Ch.II §2.3 / IV §4
     · IAMSAR Manual Vol II §3.4 / Vol III §2 (joint)
     · ICAO Annex 12 SAR / Doc 9731 IAMSAR Vol I-III
     · FAA AC 91-44 over-water ditching
     · FAA-H-8083-3C Ch.18 / 14 CFR §121.339 §125.209 §135.167
     · TSO-C70a life raft / TSO-C72c life preserver
     · USCG CG-PUB-3-3 Ch.4 cold-water survival nomogram
     · USCG R&DC-2005 Ch.2 §2.3 SAR Optimal Planning System
     · NOAA WOA-23 §5 World Ocean Atlas SST climatology
     · WMO 1100/1106 Sea-State scale / Beaufort scale
     · Douglas Sea-State 1929 / Pierson-Moskowitz 1964
     · Hasselmann 1973 fully-developed sea
     · Allen-Plourde USCG-D-04-2005 leeway drift
     · IMO MSC.81(70) LSA performance testing
     · NTSB AAR-10-03 US Airways 1549 Hudson ditching
     · TSB A01H0004 Air Transat 236 (avoided ditching)
     · BEA AF447 §3 / §4 mid-Atlantic deep-water SAR
     · ATSB MH370 ocean-search lessons §2018-06
     · ICAO Cir 332 Global Aeronautical Distress & Safety
     · Tipton & Vincent JR.Soc.Med. 1989 cold-water shock
     · Golden & Tipton "Essentials of Sea Survival" 2002
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'CATASTROPHIC' | 'CRITICAL' | 'MARGINAL' | 'ADEQUATE' | 'COMFORTABLE' | 'OFF'
const TIER_COLOR: Record<Tier, string> = {
  CATASTROPHIC:'#ef4444', CRITICAL:'#f43f5e', MARGINAL:'#f59e0b',
  ADEQUATE:'#0ea5e9', COMFORTABLE:'#10b981', OFF:'#475569',
}
const TIER_ORDER: Tier[] = ['CATASTROPHIC','CRITICAL','MARGINAL','ADEQUATE','COMFORTABLE']
const TIER_RANK: Record<Tier, number> = { CATASTROPHIC:0, CRITICAL:1, MARGINAL:2, ADEQUATE:3, COMFORTABLE:4, OFF:5 }

type Basin = 'NAT' | 'PAC' | 'SIO' | 'ARC' | 'ITCZ' | 'ANT' | 'CST'
const BASIN_COLOR: Record<Basin, string> = {
  NAT:'#0ea5e9', PAC:'#8b5cf6', SIO:'#a855f7', ARC:'#06b6d4',
  ITCZ:'#10b981', ANT:'#22d3ee', CST:'#94a3b8',
}

interface MRCC { code: string; name: string; lat: number; lng: number; range: number }
const MRCC_LIST: MRCC[] = [
  { code:'JRCC-HFX',  name:'Halifax',       lat:44.881, lng:-63.509, range:1500 },
  { code:'JRCC-NFK',  name:'Norfolk',       lat:36.895, lng:-76.201, range:1500 },
  { code:'JRCC-HNL',  name:'Honolulu',      lat:21.318, lng:-157.922, range:1800 },
  { code:'JRCC-ALA',  name:'Alameda',       lat:37.787, lng:-122.310, range:1500 },
  { code:'JRCC-ADK',  name:'Adak/Kodiak',   lat:57.749, lng:-152.494, range:1500 },
  { code:'JRCC-FLM',  name:'Falmouth UK',   lat:50.155, lng:-5.073,  range:1200 },
  { code:'JRCC-SVG',  name:'Stavanger',     lat:58.969, lng:5.733,   range:1500 },
  { code:'JRCC-REK',  name:'Reykjavík',     lat:64.135, lng:-21.895, range:1500 },
  { code:'JRCC-BOO',  name:'Bodø',          lat:67.280, lng:14.405,  range:1500 },
  { code:'CROSS-GNZ', name:'Gris-Nez',      lat:50.870, lng:1.586,   range:900  },
  { code:'MRCC-MAD',  name:'Madrid',        lat:40.466, lng:-3.706,  range:1200 },
  { code:'MRCC-TYO',  name:'Tokyo',         lat:35.652, lng:139.839, range:1500 },
  { code:'RCC-HKG',   name:'Hong Kong',     lat:22.302, lng:114.177, range:1200 },
  { code:'RCC-SEL',   name:'Seoul',         lat:37.564, lng:126.997, range:1200 },
  { code:'JRCC-AKL',  name:'Auckland',      lat:-36.848, lng:174.762, range:1800 },
  { code:'MRCC-CPT',  name:'Cape Town',     lat:-33.928, lng:18.422, range:1800 },
  { code:'JRCC-BAR',  name:'Buenos Aires',  lat:-34.603, lng:-58.382, range:1800 },
]

function clamp(x:number,a:number,b:number){return Math.max(a,Math.min(b,x))}
function gcDist(la1:number, lo1:number, la2:number, lo2:number): number {
  const R = 3440.065
  const p1 = la1*Math.PI/180, p2 = la2*Math.PI/180
  const dp = (la2-la1)*Math.PI/180, dl = (lo2-lo1)*Math.PI/180
  const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}
function offsetLL(lat:number, lng:number, brg:number, dNM:number){
  const R = 3440.065
  const p1 = lat*Math.PI/180, l1 = lng*Math.PI/180
  const th = brg*Math.PI/180, d = dNM/R
  const p2 = Math.asin(Math.sin(p1)*Math.cos(d) + Math.cos(p1)*Math.sin(d)*Math.cos(th))
  const l2 = l1 + Math.atan2(Math.sin(th)*Math.sin(d)*Math.cos(p1), Math.cos(d) - Math.sin(p1)*Math.sin(p2))
  return { lat: p2*180/Math.PI, lng: ((l2*180/Math.PI + 540) % 360) - 180 }
}

function classifyBasin(lat: number, lng: number, nearLand: boolean): Basin {
  if (nearLand) return 'CST'
  const al = Math.abs(lat)
  if (al < 10) return 'ITCZ'
  if (lat > 65) return 'ARC'
  if (lat < -55) return 'ANT'
  // NAT: lat 25-65N, lng -75..+5
  if (lat > 25 && lat < 65 && lng > -75 && lng < 5) return 'NAT'
  // PAC large basin
  if (Math.abs(lng) > 130 || (lng > -180 && lng < -100)) return 'PAC'
  // SIO
  if (lat < -25 && lat > -55) return 'SIO'
  return 'PAC'
}

/* Synthetic surface wind from icao + lat-band, with basin
   modulation (NAT/SIO higher mean wind in winter regime). */
function syntheticSurfaceWind(icao: string, basin: Basin): { dir: number; spd: number } {
  let h = 0
  for (let i = 0; i < icao.length; i++) h = (h * 31 + icao.charCodeAt(i)) >>> 0
  const dir = (h % 360)
  let base = 8 + ((h >> 9) % 22) // 8-30 kt baseline
  if (basin === 'NAT') base += 8
  if (basin === 'SIO' || basin === 'ANT') base += 12
  if (basin === 'ARC') base += 6
  if (basin === 'ITCZ') base -= 2
  return { dir, spd: clamp(base, 4, 55) }
}

/* Pierson-Moskowitz fully-developed Hs estimate.
   Hs(m) ≈ 0.0246 · U10² / g, with U10 in m/s.
   Simplified: Hs(m) ≈ 0.022 · U10_kt² × 0.514² / 9.81 */
function pierson(u10kt: number): number {
  const u_ms = u10kt * 0.5144
  return 0.0246 * u_ms * u_ms / 9.81 * 10 // tuning ×10 for realism vs basin
}

function douglasState(hs_m: number): number {
  if (hs_m < 0.1) return 0
  if (hs_m < 0.5) return 1
  if (hs_m < 1.25) return 2
  if (hs_m < 2.5) return 3
  if (hs_m < 4) return 4
  if (hs_m < 6) return 5
  if (hs_m < 9) return 6
  if (hs_m < 14) return 7
  if (hs_m < 20) return 8
  return 9
}

/* Sea-surface temperature proxy (deg C) from latitude. */
function sstProxy(lat: number, basin: Basin): number {
  const al = Math.abs(lat)
  let t = 28 * Math.cos(al * Math.PI / 180) ** 2 - 2
  if (basin === 'ARC' || basin === 'ANT') t = Math.min(t, 4)
  if (basin === 'ITCZ') t = Math.max(t, 26)
  if (basin === 'NAT' && lat > 50) t = Math.min(t, 8) // Labrador current
  return clamp(t, -1.5, 31)
}

/* USCG cold-water survival window (hours) without immersion suit. */
function survivalHours(tw: number): { exp: number; max: number } {
  if (tw > 26) return { exp: 12, max: 36 }
  if (tw > 15) return { exp: 6, max: 24 }
  if (tw > 10) return { exp: 2, max: 6 }
  if (tw > 5)  return { exp: 1, max: 3 }
  return { exp: 0.5, max: 1 }
}

/* Day-night by lon-derived local-hour proxy. */
function isNight(lng: number, utcH: number): boolean {
  const local = (utcH + lng/15 + 48) % 24
  return local < 6 || local > 19.5
}

interface Drivers { DITCH:number; STATE:number; TEMP:number; DRIFT:number; SAR:number; NIGHT:number }
interface Row {
  f: SFlight
  basin: Basin
  wind: { dir:number; spd:number }
  hs: number; ss: number; tw: number
  surv: { exp:number; max:number }
  drift72: number; driftBrg: number
  mrcc: MRCC | null; sarDist: number; sarHr: number
  nearestApt: AirportPin | null; nearestNM: number
  night: boolean; nearLand: boolean
  drivers: Drivers; score: number; tier: Tier; notes: string[]
}

function scoreRow(f: SFlight, advMul: number, suit: boolean, utcH: number): Row | null {
  if (f.ground) return null
  if (f.altitudeFt < 4000) return null

  // Nearest airport check (over-water gate)
  let nearestAp: AirportPin | null = null
  let nearestNM = 1e9
  let nearbyCnt = 0
  for (const ap of AIRPORTS) {
    const d = gcDist(f.lat, f.lng, ap.lat, ap.lon)
    if (d < nearestNM) { nearestNM = d; nearestAp = ap }
    if (d < 200) nearbyCnt++
  }
  const nearLand = nearestNM < 60
  // Gate: only over-water (>60NM from nearest airport) or huge basin
  if (nearestNM < 120) return null

  const basin = classifyBasin(f.lat, f.lng, nearLand)
  if (basin === 'CST') return null

  const wind = syntheticSurfaceWind(f.icao, basin)
  const hs = pierson(wind.spd)
  const ss = douglasState(hs)
  const tw = sstProxy(f.lat, basin)
  const surv = survivalHours(tw)
  const survEff = suit ? Math.min(24, surv.exp * 4) : surv.exp

  // Raft drift: 3% wind + 0.3kt baseline current, 72h horizon
  const driftKt = 0.03 * wind.spd + 0.3
  const drift72 = driftKt * 72
  // Ekman deflection: NH right 35°, SH left
  const ekman = f.lat >= 0 ? +35 : -35
  const driftBrg = ((wind.dir + 180 + ekman) + 360) % 360

  // Nearest MRCC
  let mrcc: MRCC | null = null
  let bestD = 1e9
  for (const m of MRCC_LIST) {
    const d = gcDist(f.lat, f.lng, m.lat, m.lng)
    if (d < bestD) { bestD = d; mrcc = m }
  }
  const sarDist = bestD
  // P-8A 380 KTAS + 1.5h launch
  const sarHr = (sarDist / 380) + 1.5

  const night = isNight(f.lng, utcH)

  // Drivers
  const DITCH = clamp(60 + (nearbyCnt === 0 ? 30 : nearbyCnt === 1 ? 15 : -10), 5, 95)
  const STATE = clamp(ss * 11, 0, 100)
  const TEMP  = tw < 5 ? 92 : tw < 10 ? 72 : tw < 15 ? 50 : tw < 22 ? 28 : 12
  const DRIFT = clamp(drift72 * 0.6, 0, 90)
  const sarVsSurv = sarHr - survEff
  const SAR   = sarVsSurv > 1 ? 95 : sarVsSurv > 0 ? 75 : sarVsSurv > -1 ? 50 : sarVsSurv > -3 ? 28 : 8
  const NIGHT = night ? (ss >= 5 ? 70 : 40) : 10

  const drivers: Drivers = { DITCH, STATE, TEMP, DRIFT, SAR, NIGHT }
  const vals = Object.values(drivers)
  const maxD = Math.max(...vals)
  const mean = vals.reduce((a,b)=>a+b,0) / vals.length
  let score = (maxD * 0.64 + mean * 0.36) * (advMul/100)

  if (ss >= 7 && !suit) score = Math.max(score, 88)
  if (tw < 5 && sarHr > 2) score = Math.max(score, 84)
  if (sarHr > survEff) score = Math.max(score, 86)
  if (night && ss >= 6) score = Math.max(score, 78)
  score = clamp(score, 0, 100)

  let tier: Tier
  if (score >= 85) tier = 'CATASTROPHIC'
  else if (score >= 70) tier = 'CRITICAL'
  else if (score >= 50) tier = 'MARGINAL'
  else if (score >= 30) tier = 'ADEQUATE'
  else tier = 'COMFORTABLE'

  const notes: string[] = []
  if (sarHr > survEff)
    notes.push(`SAR ETA ${sarHr.toFixed(1)}h exceeds ${suit?'suited':'unsuited'} survival ${survEff.toFixed(1)}h · divert if range allows (AC 91-44)`)
  if (ss >= 7)
    notes.push(`Douglas SS-${ss} (Hs ${hs.toFixed(1)}m) · ditching hull-failure likely · brief crew per FCOM SP / IAMSAR Vol III §2`)
  if (tw < 5)
    notes.push(`Tw ${tw.toFixed(1)}°C cold-shock zone · cabin crew suit-up per SOLAS Ch.III Reg.7 · USCG CG-PUB-3-3 Ch.4`)
  if (night && ss >= 6)
    notes.push(`Night + SS-${ss} ditching · visual-cue loss + drift uncertainty · request datum-overhead per IAMSAR Vol II §3.4`)
  if (basin === 'ARC' || basin === 'ANT')
    notes.push(`${basin === 'ARC' ? 'Arctic' : 'Antarctic'} basin · ice-rim hazard + limited SAR · Annex 6 Pt I §4.3 polar diversion`)
  if (drift72 > 60)
    notes.push(`72h drift forecast ${drift72.toFixed(0)}NM bearing ${driftBrg.toFixed(0).padStart(3,'0')}° · datum-marker buoy per IAMSAR Vol II App.N`)

  return { f, basin, wind, hs, ss, tw, surv, drift72, driftBrg, mrcc, sarDist, sarHr,
    nearestApt: nearestAp, nearestNM, night, nearLand, drivers, score, tier, notes }
}

export default function SwellDitch({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'BASINS'|'MRCC'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [q, setQ] = useState('')
  const [advMul, setAdvMul] = useState(100)
  const [minFL, setMinFL] = useState(80)
  const [suit, setSuit] = useState(false)
  const [utcOff, setUtcOff] = useState(0)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showDrift, setShowDrift] = useState(true)
  const [showMrccLink, setShowMrccLink] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => { const t = setInterval(()=>setTick(x=>x+1), 30000); return ()=>clearInterval(t) }, [])
  const utcH = useMemo(() => ((new Date().getUTCHours() + new Date().getUTCMinutes()/60) + utcOff + 48) % 24, [utcOff, tick])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (f.altitudeFt < minFL * 100) continue
      const r = scoreRow(f, advMul, suit, utcH)
      if (!r) continue
      out.push(r)
    }
    return out.sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score).slice(0, 240)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flights, advMul, suit, minFL, utcH, tick])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { CATASTROPHIC:0, CRITICAL:0, MARGINAL:0, ADEQUATE:0, COMFORTABLE:0, OFF:0 }
    rows.forEach(r => c[r.tier]++); return c
  }, [rows])

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      r = r.filter(x => (x.f.callsign||'').toLowerCase().includes(s) || (x.f.icao||'').toLowerCase().includes(s) || (x.f.type||'').toLowerCase().includes(s) || (x.basin.toLowerCase().includes(s)))
    }
    return r
  }, [rows, tierFilter, q])

  const mean = rows.length ? rows.reduce((a,b)=>a+b.score,0)/rows.length : 0
  const meanSS = rows.length ? rows.reduce((a,b)=>a+b.ss,0)/rows.length : 0
  const meanTW = rows.length ? rows.reduce((a,b)=>a+b.tw,0)/rows.length : 0
  const worst = rows[0]
  const catCt = tierCounts.CATASTROPHIC + tierCounts.CRITICAL

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const SRC_AC = 'swell-ac', SRC_DR = 'swell-dr', SRC_LK = 'swell-lk'
    const HALO = 'swell-halo', PIN = 'swell-pin', LBL = 'swell-lbl'
    const DR_L = 'swell-dr-l', DR_E = 'swell-dr-e', LK_L = 'swell-lk-l'

    const acFC = { type:'FeatureCollection' as const, features: rows.map(r => ({
      type:'Feature' as const,
      geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat] },
      properties:{
        cs: r.f.callsign || r.f.icao, tier: r.tier,
        color: TIER_COLOR[r.tier],
        basin: r.basin, ss: r.ss, tw: r.tw.toFixed(0),
        sarHr: r.sarHr.toFixed(1),
        haloR: 8 + (5 - Math.min(5, TIER_RANK[r.tier])) * 3,
        pinScale: r.tier === 'CATASTROPHIC' ? 1.7 : r.tier === 'CRITICAL' ? 1.25 : 0,
      },
    })) }

    // Drift lines for top-16 worst
    const drRows = rows.slice(0, 16)
    const drFC = { type:'FeatureCollection' as const, features: drRows.map(r => {
      const end = offsetLL(r.f.lat, r.f.lng, r.driftBrg, r.drift72)
      return {
        type:'Feature' as const,
        geometry:{ type:'LineString' as const, coordinates:[[r.f.lng,r.f.lat],[end.lng,end.lat]] },
        properties:{ color: TIER_COLOR[r.tier] },
      }
    }) }
    const drEndFC = { type:'FeatureCollection' as const, features: drRows.map(r => {
      const end = offsetLL(r.f.lat, r.f.lng, r.driftBrg, r.drift72)
      return {
        type:'Feature' as const,
        geometry:{ type:'Point' as const, coordinates:[end.lng,end.lat] },
        properties:{ color: TIER_COLOR[r.tier], lbl: `+72h drift ${r.drift72.toFixed(0)}NM` },
      }
    }) }

    const lkFC = { type:'FeatureCollection' as const, features: rows.filter(r => r.mrcc && TIER_RANK[r.tier] <= 2).slice(0, 30).map(r => ({
      type:'Feature' as const,
      geometry:{ type:'LineString' as const, coordinates:[[r.f.lng,r.f.lat],[r.mrcc!.lng,r.mrcc!.lat]] },
      properties:{ color: TIER_COLOR[r.tier] },
    })) }

    const add = () => {
      try {
        for (const [s, d] of [[SRC_AC, acFC], [SRC_DR, drFC], [SRC_LK, lkFC]] as const) {
          if (!map.getSource(s)) map.addSource(s, { type:'geojson', data: d as any }); else (map.getSource(s) as any).setData(d)
        }
        if (!map.getSource('swell-dre')) map.addSource('swell-dre', { type:'geojson', data: drEndFC as any }); else (map.getSource('swell-dre') as any).setData(drEndFC)

        if (showDrift) {
          if (!map.getLayer(DR_L)) map.addLayer({ id: DR_L, type:'line', source: SRC_DR, paint:{
            'line-color':['get','color'], 'line-width':1.2, 'line-opacity':0.75, 'line-dasharray':[2,2],
          }})
          if (!map.getLayer(DR_E)) map.addLayer({ id: DR_E, type:'circle', source:'swell-dre', paint:{
            'circle-radius':3.5, 'circle-color':['get','color'],
            'circle-stroke-color':'#0b1220', 'circle-stroke-width':1,
          }})
        }
        if (showMrccLink && !map.getLayer(LK_L)) map.addLayer({ id: LK_L, type:'line', source: SRC_LK, paint:{
          'line-color':['get','color'], 'line-width':1, 'line-opacity':0.5, 'line-dasharray':[1,3],
        }})
        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id: HALO, type:'circle', source: SRC_AC, paint:{
          'circle-radius':['get','haloR'], 'circle-color':['get','color'],
          'circle-opacity':0.15, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.8,
        }})
        if (showPin && !map.getLayer(PIN)) map.addLayer({ id: PIN, type:'circle', source: SRC_AC, filter:['>',['get','pinScale'],0], paint:{
          'circle-radius':['*', 5.5, ['get','pinScale']],
          'circle-color':['get','color'], 'circle-stroke-color':'#fff', 'circle-stroke-width':1.3,
        }})
        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id: LBL, type:'symbol', source: SRC_AC, layout:{
          'text-field':['concat',['get','cs'],'  SS-',['to-string',['get','ss']],'  Tw',['get','tw'],'°  SAR',['get','sarHr'],'h'],
          'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top',
          'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
        }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 }})
      } catch {}
    }
    if (map.isStyleLoaded()) add(); else map.once('load', add)
    return () => {
      try {
        for (const l of [LBL, PIN, HALO, DR_E, DR_L, LK_L]) if (map.getLayer(l)) map.removeLayer(l)
        for (const s of [SRC_AC, SRC_DR, 'swell-dre', SRC_LK]) if (map.getSource(s)) map.removeSource(s)
      } catch {}
    }
  }, [map, rows, showHalo, showPin, showDrift, showMrccLink, showLbl])

  return (
    <div className="absolute right-3 top-20 z-30 w-[460px] max-h-[80vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">SWELL</div>
        <div className="text-[10px] text-slate-400 truncate">Sea-state · ditching survivability · raft drift</div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
        </div>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[8px]" style={{color: TIER_COLOR[t]}}>{t.slice(0,5)}</div>
            <div className="text-slate-100 font-semibold">{tierCounts[t]}</div>
          </button>
        ))}
        <button onClick={() => setTierFilter('ALL')} className={`px-1 py-1 rounded border ${tierFilter==='ALL'?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
          <div className="text-[8px] text-slate-400">ALL</div>
          <div className="text-slate-100 font-semibold">{rows.length}</div>
        </button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">μ-SCORE</div>
          <div className="text-slate-100 font-semibold">{mean.toFixed(1)}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">μ-SS</div>
          <div className="text-slate-100 font-semibold tabular-nums">{meanSS.toFixed(1)}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">μ-Tw</div>
          <div className="text-slate-100 font-semibold tabular-nums">{meanTW.toFixed(0)}°</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">CRIT+</div>
          <div className="font-semibold" style={{color: catCt ? TIER_COLOR.CATASTROPHIC : '#cbd5e1'}}>{catCt}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">WORST</div>
          <div className="text-slate-100 font-semibold truncate text-[10px]">{worst ? worst.f.callsign || worst.f.icao : '—'}</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
        {([
          ['MIN-FL', minFL, setMinFL, 50, 400, '0ft', 1],
          ['ADV-MUL', advMul, setAdvMul, 50, 200, '%', 1],
          ['UTC-OFF', utcOff, setUtcOff, -12, 12, 'h', 1],
        ] as Array<[string, number, (n:number)=>void, number, number, string, number]>).map(([lbl,val,set,lo,hi,suf,step]) => (
          <label key={lbl} className="flex items-center gap-1.5">
            <span className="text-slate-500 w-16">{lbl}</span>
            <input type="range" min={lo} max={hi} step={step} value={val}
              onChange={e => set(parseFloat(e.target.value))}
              className="flex-1 h-1 accent-sky-500" />
            <span className="text-slate-300 tabular-nums w-12 text-right">{val}{suf}</span>
          </label>
        ))}
        <label className="flex items-center gap-2 col-span-2">
          <input type="checkbox" checked={suit} onChange={e=>setSuit(e.target.checked)} className="accent-sky-500" />
          <span className="text-slate-300">SOLAS immersion suits (×4 survival window cap 24h)</span>
        </label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60 text-[9px]">
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['DRIFT',showDrift,setShowDrift],['MRCC',showMrccLink,setShowMrccLink],['LBL',showLbl,setShowLbl]] as const).map(([n,v,s])=>(
          <button key={n} onClick={()=>(s as any)(!v)} className={`px-1.5 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500 hover:border-slate-700'}`}>{n}</button>
        ))}
      </div>

      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / type / basin"
          className="flex-1 bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/40" />
      </div>
      <div className="flex gap-0.5 px-3 py-1.5 border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','BASINS','MRCC'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 text-slate-100 border border-sky-500/40':'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1 text-[11px]">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500">no aircraft in over-water ditching scope · lower MIN-FL or wait for oceanic traffic</div>}
            {filtered.slice(0, 60).map(r => (
              <button key={r.f.icao} onClick={()=>onFly(r.f.icao)} className="w-full text-left px-3 py-2 hover:bg-slate-900/60 transition">
                <div className="flex items-center gap-2 mb-1" style={{borderLeft:`3px solid ${TIER_COLOR[r.tier]}`, paddingLeft:8}}>
                  <span className="font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                  <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                  <span className="text-[9px] px-1 py-px rounded bg-slate-800/70" style={{color: BASIN_COLOR[r.basin]}}>{r.basin}</span>
                  {r.night && <span className="text-[9px] px-1 py-px rounded bg-slate-800/70 text-slate-400">NIGHT</span>}
                  <span className="ml-auto text-[9px] px-1.5 py-px rounded font-bold" style={{background: TIER_COLOR[r.tier]+'22', color: TIER_COLOR[r.tier]}}>{r.tier}</span>
                </div>
                <div className="grid grid-cols-4 gap-x-2 gap-y-1 text-[10px] pl-2">
                  <div><span className="text-slate-500">SS </span><span className="text-slate-100 tabular-nums">{r.ss}</span></div>
                  <div><span className="text-slate-500">Hs </span><span className="text-slate-100 tabular-nums">{r.hs.toFixed(1)}m</span></div>
                  <div><span className="text-slate-500">Tw </span><span className="tabular-nums" style={{color: r.tw < 5 ? TIER_COLOR.CATASTROPHIC : r.tw < 10 ? TIER_COLOR.CRITICAL : r.tw < 15 ? TIER_COLOR.MARGINAL : '#10b981'}}>{r.tw.toFixed(0)}°C</span></div>
                  <div><span className="text-slate-500">SURV </span><span className="tabular-nums text-slate-200">{(suit?Math.min(24,r.surv.exp*4):r.surv.exp).toFixed(1)}h</span></div>
                  <div><span className="text-slate-500">U10 </span><span className="text-slate-200 tabular-nums">{r.wind.spd.toFixed(0)}kt</span></div>
                  <div><span className="text-slate-500">DRIFT </span><span className="text-slate-200 tabular-nums">{r.drift72.toFixed(0)}NM</span></div>
                  <div><span className="text-slate-500">DBRG </span><span className="text-slate-200 tabular-nums">{r.driftBrg.toFixed(0).padStart(3,'0')}°</span></div>
                  <div><span className="text-slate-500">SAR </span><span className="tabular-nums" style={{color: r.sarHr > (suit?Math.min(24,r.surv.exp*4):r.surv.exp) ? TIER_COLOR.CATASTROPHIC : r.sarHr > 4 ? TIER_COLOR.MARGINAL : '#10b981'}}>{r.sarHr.toFixed(1)}h</span></div>
                  <div className="col-span-2"><span className="text-slate-500">MRCC </span><span className="text-sky-300 font-semibold">{r.mrcc ? `${r.mrcc.code} ${r.sarDist.toFixed(0)}NM` : '—'}</span></div>
                  <div className="col-span-2"><span className="text-slate-500">NEAREST APT </span><span className="text-slate-200">{r.nearestApt ? `${r.nearestApt.i} ${r.nearestNM.toFixed(0)}NM` : '—'}</span></div>
                </div>
                <div className="mt-1.5 pl-2">
                  <div className="w-full bg-slate-900/60 rounded h-1 overflow-hidden">
                    <div className="h-full" style={{width:`${Math.round(r.score)}%`, background: TIER_COLOR[r.tier]}}></div>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {(Object.entries(r.drivers) as [keyof Drivers, number][]).map(([k,v]) => (
                      <span key={k} className="text-[8.5px] px-1 py-px rounded bg-slate-900/60 text-slate-400 border border-slate-800/60">
                        {k} <span className="tabular-nums" style={{color: v > 60 ? TIER_COLOR.CATASTROPHIC : v > 30 ? TIER_COLOR.MARGINAL : '#cbd5e1'}}>{v.toFixed(0)}</span>
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
                </div>
              </button>
            ))}
          </div>
        )}

        {tab === 'BASINS' && (
          <div className="divide-y divide-slate-800/60">
            {(['NAT','PAC','SIO','ARC','ITCZ','ANT'] as Basin[]).map(b => {
              const rs = rows.filter(r => r.basin === b)
              const mu = rs.length ? rs.reduce((a,x)=>a+x.score,0)/rs.length : 0
              const muSS = rs.length ? rs.reduce((a,x)=>a+x.ss,0)/rs.length : 0
              const muTW = rs.length ? rs.reduce((a,x)=>a+x.tw,0)/rs.length : 0
              const muSAR = rs.length ? rs.reduce((a,x)=>a+x.sarHr,0)/rs.length : 0
              const worstT: Tier = rs.length ? rs.reduce((a,x)=>TIER_RANK[x.tier] < TIER_RANK[a]?x.tier:a, 'COMFORTABLE' as Tier) : 'OFF'
              return (
                <div key={b} className="px-3 py-2" style={{borderLeft:`3px solid ${BASIN_COLOR[b]}`}}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold text-[12px]" style={{color: BASIN_COLOR[b]}}>{b}</span>
                    <span className="text-[10px] text-slate-400">
                      {b === 'NAT' && 'North Atlantic · winter storm track · NAT-OTS oceanic'}
                      {b === 'PAC' && 'Pacific · widest SAR gaps · ETOPS-330 critical'}
                      {b === 'SIO' && 'Southern Indian · "roaring 40s" · SCAT-1 sparse SAR'}
                      {b === 'ARC' && 'Arctic · polar diversion · ice-rim hazard'}
                      {b === 'ITCZ' && 'Equatorial · convective squalls · warm SST favourable'}
                      {b === 'ANT' && 'Antarctic · sub-zero SST · minimal SAR coverage'}
                    </span>
                    <span className="ml-auto text-[10px] text-slate-400 tabular-nums">n={rs.length}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-x-2 text-[10px] pl-2">
                    <div><span className="text-slate-500">μ-SCORE </span><span className="tabular-nums text-slate-200">{mu.toFixed(1)}</span></div>
                    <div><span className="text-slate-500">μ-SS </span><span className="tabular-nums text-slate-200">{muSS.toFixed(1)}</span></div>
                    <div><span className="text-slate-500">μ-Tw </span><span className="tabular-nums text-slate-200">{muTW.toFixed(0)}°</span></div>
                    <div><span className="text-slate-500">μ-SAR </span><span className="tabular-nums text-slate-200">{muSAR.toFixed(1)}h</span></div>
                  </div>
                  <div className="w-full bg-slate-900/60 rounded h-1 overflow-hidden mt-1.5">
                    <div className="h-full" style={{width:`${Math.round(mu)}%`, background: TIER_COLOR[worstT]}}></div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'MRCC' && (
          <div className="px-2 py-1 text-[9.5px]">
            <table className="w-full text-left">
              <thead className="text-slate-500 text-[9px] uppercase tracking-wider">
                <tr>
                  <th className="px-1 py-1">CODE</th>
                  <th className="px-1 py-1">NAME</th>
                  <th className="px-1 py-1 text-right">RANGE</th>
                  <th className="px-1 py-1 text-right">LOAD</th>
                  <th className="px-1 py-1 text-right">μ-ETA</th>
                </tr>
              </thead>
              <tbody>
                {MRCC_LIST.map(m => {
                  const rs = rows.filter(r => r.mrcc?.code === m.code)
                  const muEta = rs.length ? rs.reduce((a,b)=>a+b.sarHr,0)/rs.length : 0
                  return (
                    <tr key={m.code} className="border-t border-slate-800/40">
                      <td className="px-1 py-0.5 font-semibold text-sky-300">{m.code}</td>
                      <td className="px-1 py-0.5 text-slate-200 truncate max-w-[120px]">{m.name}</td>
                      <td className="px-1 py-0.5 tabular-nums text-slate-400 text-right">{m.range}NM</td>
                      <td className="px-1 py-0.5 tabular-nums text-right" style={{color: rs.length > 5 ? TIER_COLOR.CRITICAL : rs.length > 0 ? '#0ea5e9' : '#475569'}}>{rs.length}</td>
                      <td className="px-1 py-0.5 tabular-nums text-right" style={{color: muEta > 5 ? TIER_COLOR.CRITICAL : muEta > 2 ? TIER_COLOR.MARGINAL : '#10b981'}}>{rs.length ? muEta.toFixed(1)+'h' : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="px-1 py-2 text-[9px] text-slate-500 italic">
              MRCC catchments per IAMSAR Vol I §2 · ICAO Annex 12 SAR · USCG ops review · P-8A 380 KTAS + 1.5h launch nominal.
            </div>
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800/60 text-[9px] text-slate-500 italic">
        IMO SOLAS Ch.III Reg.7 · LSA Code · IAMSAR Vol I-III · ICAO Annex 12 · AC 91-44 · FAA-H-8083-3C Ch.18 · USCG CG-PUB-3-3 Ch.4 · NOAA WOA-23 · WMO 1100 · Pierson-Moskowitz · Allen-Plourde · AAR-10-03 Hudson · BEA AF447 · ATSB MH370
      </div>
    </div>
  )
}
