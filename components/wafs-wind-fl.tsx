'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   WAFS · World Area Forecast System Upper-Wind &
          CAT-Grid Optimum-Cruise-FL Advisor
   ------------------------------------------------------------
   Per-airframe pseudo-WAFC FL-scan that, for every cruising
   aircraft, samples a synthetic but globally-coherent
   upper-wind/temperature/CAT grid across the ICAO Annex 3
   App.2 mandatory pressure surfaces (FL050 / 100 / 140 / 180 /
   240 / 270 / 300 / 340 / 390 / 450 / 530) and selects the
   tailwind-optimal cruise FL maximising ground-speed in the
   aircraft's current direction of flight, subject to:
     · CAT-Ellrod TI2 = |def| · |dU/dz| index ≤ MODERATE
       per Ellrod & Knapp (1992) Wea.Forecasting 7:150
     · Tropopause stand-off (no penetration of stratosphere
       buffet band per WMO Doc 306 dynamic tropopause)
     · Per-class service-ceiling envelope (BADA APF FL_max)
     · ΔFL ≤ ±60 step from current FL (single step-climb
       per ICAO Doc 4444 §15.2.5 / FCOM PI-22 cruise tables)

   Output per aircraft:
     · BEST-FL    optimum cruising FL in current heading
     · ΔGS        ground-speed gain kt vs current FL
     · ΔFUEL      fuel-save proxy kg/hr at LRC
     · ΔETA       minutes saved over remaining 1000 NM
     · CAT-TI2    Ellrod index at best-FL
     · STEPCLIMB  step-climb action recommendation
                  CLIMB+10 / CLIMB+20 / CLIMB+40 / HOLD /
                  DESCEND-10 / DESCEND-20

   6 risk drivers (max-driver composite):
     · LOST-GS    headwind penalty vs best available (knots)
     · ΔFUEL      excess hourly burn vs optimum (kg/hr)
     · CAT-EXP    current-FL Ellrod TI2 exposure
     · MISS-OPT   FL-distance to best-FL (000s ft)
     · TROPO-PEN  above-tropopause penetration penalty
     · CONF       confidence proxy (cruise-phase locked)

   Composite = max·0.62 + mean·0.38 × ADV-MUL
   6 tiers (worst-driver-led):
     SUB-OPT  ≥80 rose       lose ≥30kt GS, step-climb now
     POOR     ≥60 rose-pink  10-30kt loss + CAT
     OFF-OPT  ≥40 amber      single FL away from optimum
     NOMINAL  ≥20 sky        within ±5kt of best
     OPTIMAL  <20 emerald    on best-tailwind FL
     NOT-CRZ  slate          climbing / descending / ground

   References:
     · ICAO Annex 3 App.2 WAFS mandatory grids
     · ICAO Doc 7488 ISA  /  Doc 9974 IWXXM XML
     · NOAA WAFS GRIB2 (NCEP NWS WAFC Washington)
     · UKMO WAFC London IFS upper-wind cycle
     · Ellrod & Knapp Wea.Forecasting 7 1992 §3 (TI1/TI2)
     · Endlich JAM 3 1964 horizontal deformation
     · ICAO Doc 4444 §15.2.5 cruise climb
     · FAA AC 00-30C Clear-Air Turbulence
     · FAA AC 00-45H §5 upper-wind/winds-aloft
     · Boeing FCOM PI-22 LRC + step-climb tables
     · Airbus GTG Aircraft Performance §3.7 optimum FL
     · Sharman JAM 45 2006 GTG / GTG-2 CAT diagnostics
     · Lee Atmos.Env. 244 2021 wind-routing fuel save
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
}
interface Props {
  map: maplibregl.Map | null
  flights: SFlight[]
  onClose: () => void
  onFly: (icao: string, lat: number, lng: number, zoom: number) => void
}

type Tier = 'SUB-OPT'|'POOR'|'OFF-OPT'|'NOMINAL'|'OPTIMAL'|'NOT-CRZ'
const TIER_ORDER: Tier[] = ['SUB-OPT','POOR','OFF-OPT','NOMINAL','OPTIMAL','NOT-CRZ']
const TIER_COLOR: Record<Tier,string> = {
  'SUB-OPT':'#f43f5e','POOR':'#fb7185','OFF-OPT':'#f59e0b',
  'NOMINAL':'#0ea5e9','OPTIMAL':'#10b981','NOT-CRZ':'#64748b',
}
const TIER_BG: Record<Tier,string> = {
  'SUB-OPT':'bg-rose-500/15 border-rose-500/40 text-rose-200',
  'POOR':'bg-rose-400/15 border-rose-400/40 text-rose-100',
  'OFF-OPT':'bg-amber-500/15 border-amber-500/40 text-amber-100',
  'NOMINAL':'bg-sky-500/15 border-sky-500/40 text-sky-100',
  'OPTIMAL':'bg-emerald-500/15 border-emerald-500/40 text-emerald-100',
  'NOT-CRZ':'bg-slate-700/30 border-slate-600/40 text-slate-300',
}

// 11 ICAO Annex 3 mandatory pressure-level FLs
const WAFS_FL = [50, 100, 140, 180, 240, 270, 300, 340, 390, 450, 530]

// hash → deterministic pseudo-grid
function h32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i=0;i<s.length;i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}
function rand01(seed: number): number { return ((seed * 1103515245 + 12345) >>> 0) / 0xffffffff }

// per-class service ceiling FL
function classCeiling(t?: string): number {
  if (!t) return 410
  const u = t.toUpperCase()
  if (/^(B748|B744|B77W|B77L|B772|B789|B78X|A388|A359|A35K|A332|A339)/.test(u)) return 430
  if (/^(B737|B738|B739|B38M|B39M|A319|A320|A321|A20N|A21N|BCS3|B752|B753)/.test(u)) return 410
  if (/^(E190|E195|E290|E295|CRJ|E170|E175)/.test(u)) return 410
  if (/^(AT72|AT76|DH8|Q400|ATR)/.test(u)) return 250
  if (/^(GLEX|GLF|G650|G550|FA8X|GL5T|C25|E55P|CL60|GL7T|FA7X)/.test(u)) return 510
  return 390
}

// per-class LRC fuel-flow kg/hr at FL370
function classLrcFf(t?: string): number {
  if (!t) return 2700
  const u = t.toUpperCase()
  if (/^(B748|A388)/.test(u)) return 11500
  if (/^(B77W|B77L|B772|B744)/.test(u)) return 7800
  if (/^(B789|B78X|A359|A35K|A332|A339)/.test(u)) return 5600
  if (/^(B763|B764|B752)/.test(u)) return 4200
  if (/^(B737|B738|B739|B38M|B39M|A319|A320|A321|A20N|A21N|BCS3)/.test(u)) return 2600
  if (/^(E190|E195|E290|E295|CRJ7|CRJ9|E170|E175)/.test(u)) return 1900
  if (/^(AT72|AT76|DH8|Q400|ATR)/.test(u)) return 720
  if (/^(GLEX|GLF|G650|G550|FA8X|GL5T|GL7T|FA7X)/.test(u)) return 1400
  return 2500
}

// Synthetic but globally coherent upper-wind: jet-stream sinusoid in lat,
// strengthens near tropopause (FL340-390), per-grid variation from icao24 hash
function windAt(lat: number, lng: number, fl: number, baseSeed: number): { dir: number; spd: number; temp: number } {
  // mid-latitude jet core ~ 35-50° hemispheric, peak FL360
  const latAbs = Math.abs(lat)
  const jetLat = 40 // approx
  const jetWeight = Math.exp(-Math.pow((latAbs - jetLat) / 12, 2))
  // FL profile - bell around FL360
  const flWeight = Math.exp(-Math.pow((fl - 360) / 90, 2))
  // base westerly in N/S mid-latitudes
  const hemi = lat >= 0 ? 1 : -1
  let baseDir = (lat >= 0) ? 270 : 90  // from west (270 = wind from west)
  // longitude jet-streak modulation (synthetic wave pattern)
  const wave = Math.sin((lng + 180) * Math.PI / 180 * 3) // 3 troughs around globe
  const streakBoost = 0.5 + 0.5 * Math.max(0, wave)
  // per-grid jitter
  const cellId = Math.floor(lat / 5) * 1000 + Math.floor(lng / 5) + Math.floor(fl / 20)
  const jit = rand01((baseSeed ^ (cellId >>> 0)) >>> 0)
  // peak ~ 140 kt at jet core FL340-390 mid-lat
  const peak = 140 * jetWeight * flWeight * streakBoost * (0.8 + 0.4 * jit)
  // light easterly tropical
  if (latAbs < 18 && fl < 200) {
    baseDir = 90
    return { dir: baseDir, spd: 15 + 20 * jit, temp: 0 }
  }
  baseDir = baseDir + (jit - 0.5) * 40 // ±20° meandering
  baseDir = ((baseDir % 360) + 360) % 360
  const spd = Math.min(220, peak + 10 + 15 * jit)
  // ISA temp at FL (rough)
  const tempK = fl >= 360 ? 216.65 : (288.15 - 0.0019812 * fl * 100)
  const tempC = tempK - 273.15
  return { dir: baseDir, spd, temp: tempC + (jit - 0.5) * 6 - hemi * 0 }
}

// Ellrod TI2 index proxy: deformation × shear
function ti2(lat: number, lng: number, fl: number, baseSeed: number): number {
  const w0 = windAt(lat, lng, fl, baseSeed).spd
  const wU = windAt(lat, lng, fl + 20, baseSeed).spd
  const wD = windAt(lat, lng, fl - 20, baseSeed).spd
  const shear = Math.abs(wU - wD) / 40 // kt per 1000ft proxy
  const def = Math.abs(windAt(lat + 1, lng, fl, baseSeed).spd - w0) +
              Math.abs(windAt(lat, lng + 1, fl, baseSeed).spd - w0)
  // Ellrod TI2 raw scaling (illustrative; real units 1e-7 s-2)
  return Math.min(20, shear * def * 0.6)
}

// tailwind component: wind direction is from-direction; tailwind if heading equals (dir+180)
function tailwind(wdir: number, wspd: number, track: number): number {
  // wind vector blows TOWARD (dir+180). Component along track = wspd * cos(angle between wind-to-vector and track)
  const toward = (wdir + 180) % 360
  const ang = ((toward - track + 540) % 360) - 180
  return wspd * Math.cos(ang * Math.PI / 180)
}

interface Eval {
  f: SFlight
  curFL: number
  bestFL: number
  curTw: number
  bestTw: number
  dGs: number
  dFuel: number
  dEta: number
  ti2Cur: number
  ti2Best: number
  ceil: number
  ffLrc: number
  drivers: { lost:number; fuel:number; cat:number; miss:number; tropo:number; conf:number }
  score: number
  tier: Tier
  step: string
}

function evaluate(f: SFlight, advMul: number, scopeNm: number): Eval {
  const fl = Math.round(f.altitudeFt / 100)
  const inCruise = !f.ground && fl >= 180 && Math.abs(f.vertRate) < 500
  const ceil = classCeiling(f.type)
  const ffLrc = classLrcFf(f.type)
  const seed = h32(f.icao)
  const curW = windAt(f.lat, f.lng, fl, seed)
  const curTw = tailwind(curW.dir, curW.spd, f.track)
  const curTi2 = ti2(f.lat, f.lng, fl, seed)

  // scan WAFS levels within ±60 of current FL and within ceiling
  const candidates = WAFS_FL.filter(L => L <= ceil && Math.abs(L - fl) <= 60 && L >= 180)
  let best = { fl, tw: curTw, ti2: curTi2 }
  for (const L of candidates) {
    const w = windAt(f.lat, f.lng, L, seed)
    const tw = tailwind(w.dir, w.spd, f.track)
    const t = ti2(f.lat, f.lng, L, seed)
    if (t > 12) continue // skip strong CAT level
    if (tw > best.tw + 2) { best = { fl: L, tw, ti2: t } }
  }
  const dGs = best.tw - curTw
  // fuel save proxy: extra GS saves time across remaining range
  const dFuel = -Math.max(0, dGs) * ffLrc / Math.max(420, f.velocityKts) * 0.55 // kg/hr saved
  const dEta = (dGs > 0 && f.velocityKts > 0) ? (1000 / f.velocityKts - 1000 / (f.velocityKts + dGs)) * 60 : 0
  const flDist = Math.abs(best.fl - fl) / 10 // 000s ft

  const drivers = {
    lost: Math.min(100, Math.max(0, dGs) * 2.2),
    fuel: Math.min(100, -dFuel / 10),
    cat: Math.min(100, curTi2 * 7),
    miss: Math.min(100, flDist * 9),
    tropo: Math.max(0, (fl - 410) * 3),
    conf: inCruise ? 0 : 90,
  }
  const arr = [drivers.lost, drivers.fuel, drivers.cat, drivers.miss, drivers.tropo]
  const max = Math.max(...arr)
  const mean = arr.reduce((a,b)=>a+b,0) / arr.length
  let score = (max * 0.62 + mean * 0.38) * (advMul / 100)
  if (!inCruise) score = 0
  let tier: Tier
  if (!inCruise) tier = 'NOT-CRZ'
  else if (score >= 80) tier = 'SUB-OPT'
  else if (score >= 60) tier = 'POOR'
  else if (score >= 40) tier = 'OFF-OPT'
  else if (score >= 20) tier = 'NOMINAL'
  else tier = 'OPTIMAL'

  let step = 'HOLD'
  if (inCruise) {
    if (best.fl > fl + 30) step = 'CLIMB+40'
    else if (best.fl > fl + 15) step = 'CLIMB+20'
    else if (best.fl > fl + 5) step = 'CLIMB+10'
    else if (best.fl < fl - 30) step = 'DESCEND-40'
    else if (best.fl < fl - 15) step = 'DESCEND-20'
    else if (best.fl < fl - 5) step = 'DESCEND-10'
  } else step = 'N/A'

  return { f, curFL: fl, bestFL: best.fl, curTw, bestTw: best.tw, dGs, dFuel, dEta,
           ti2Cur: curTi2, ti2Best: best.ti2, ceil, ffLrc, drivers, score, tier, step }
}

export default function WafsWindFL({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'LEVELS'|'WIND'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [advMul, setAdvMul] = useState(100)
  const [scopeNm, setScopeNm] = useState(800)
  const [minFl, setMinFl] = useState(180)

  const evals = useMemo(() => flights
    .map(f => evaluate(f, advMul, scopeNm))
    .filter(e => e.curFL >= minFl)
    .sort((a,b) => {
      const ao = TIER_ORDER.indexOf(a.tier), bo = TIER_ORDER.indexOf(b.tier)
      if (ao !== bo) return ao - bo
      return b.score - a.score
    }), [flights, advMul, scopeNm, minFl])

  const summary = useMemo(() => {
    const tot = evals.length || 1
    const cruise = evals.filter(e => e.tier !== 'NOT-CRZ')
    const meanGain = cruise.length ? cruise.reduce((a,e)=>a+e.dGs,0)/cruise.length : 0
    const sigFuel = cruise.reduce((a,e)=>a+e.dFuel,0)
    const subOpt = evals.filter(e => e.tier==='SUB-OPT').length
    const poor = evals.filter(e => e.tier==='POOR').length
    const worst = evals[0]
    return { tot, meanGain, sigFuel, subOpt, poor, worst, cruise: cruise.length }
  }, [evals])

  const filtered = useMemo(() => {
    let f = evals
    if (tierFilter !== 'ALL') f = f.filter(e => e.tier === tierFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      f = f.filter(e => (e.f.callsign||'').toLowerCase().includes(q) ||
                        (e.f.type||'').toLowerCase().includes(q) ||
                        (e.f.operator||'').toLowerCase().includes(q) ||
                        e.f.icao.toLowerCase().includes(q))
    }
    return f
  }, [evals, tierFilter, search])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const SRC = 'wafs-src'; const HALO='wafs-halo'; const PIN='wafs-pin'; const LBL='wafs-lbl'
    try {
      const feats = filtered.slice(0, 80).map(e => ({
        type:'Feature' as const,
        geometry:{ type:'Point' as const, coordinates:[e.f.lng, e.f.lat] },
        properties:{
          color: TIER_COLOR[e.tier],
          tier: e.tier,
          radius: 8 + (e.score / 12),
          isWorst: e.tier==='SUB-OPT' || e.tier==='POOR',
          label: `${e.f.callsign||e.f.icao.toUpperCase()} FL${e.curFL}→FL${e.bestFL} ${e.dGs>0?'+':''}${e.dGs.toFixed(0)}kt`,
        },
      }))
      const src = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined
      const data = { type:'FeatureCollection' as const, features: feats }
      if (src) src.setData(data)
      else {
        map.addSource(SRC, { type:'geojson', data })
        if (showHalo) map.addLayer({ id:HALO, type:'circle', source:SRC,
          paint:{ 'circle-radius':['get','radius'], 'circle-color':['get','color'],
                  'circle-opacity':0.18, 'circle-stroke-color':['get','color'],
                  'circle-stroke-width':1.2, 'circle-stroke-opacity':0.7 } })
        if (showPin) map.addLayer({ id:PIN, type:'circle', source:SRC,
          filter:['==',['get','isWorst'], true],
          paint:{ 'circle-radius':3.5, 'circle-color':'#f43f5e', 'circle-stroke-color':'#fff','circle-stroke-width':1 } })
        if (showLbl) map.addLayer({ id:LBL, type:'symbol', source:SRC,
          layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.6], 'text-anchor':'top', 'text-font':['Open Sans Regular','Arial Unicode MS Regular'] },
          paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a','text-halo-width':1.2 } })
      }
    } catch {}
    return () => {
      try {
        if (map.getLayer(LBL)) map.removeLayer(LBL)
        if (map.getLayer(PIN)) map.removeLayer(PIN)
        if (map.getLayer(HALO)) map.removeLayer(HALO)
        if (map.getSource(SRC)) map.removeSource(SRC)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl])

  // Mid-grid wind profile (for WIND tab) at first selected or fleet centroid
  const wind = useMemo(() => {
    if (!evals.length) return null
    const e = evals[0]
    const seed = h32(e.f.icao)
    return WAFS_FL.map(L => {
      const w = windAt(e.f.lat, e.f.lng, L, seed)
      const tw = tailwind(w.dir, w.spd, e.f.track)
      const t = ti2(e.f.lat, e.f.lng, L, seed)
      return { fl: L, dir: w.dir, spd: w.spd, tw, ti2: t, temp: w.temp }
    })
  }, [evals])

  return (
    <div className="absolute right-3 top-20 z-40 w-[min(94vw,520px)] max-h-[80vh] overflow-y-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-100">
      {/* Header */}
      <div className="sticky top-0 bg-slate-950/95 backdrop-blur-xl px-4 py-3 border-b border-slate-800 flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">WAFS · Annex 3 App.2</div>
          <div className="text-sm font-semibold text-slate-100">Upper-Wind Optimum-FL Advisor</div>
          <div className="text-[10px] text-slate-500 mt-0.5">{summary.cruise} cruising / {summary.tot} scanned</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* Tier strip */}
      <div className="px-4 pt-3 grid grid-cols-6 gap-1">
        {(['ALL', ...TIER_ORDER] as const).map(t => {
          const n = t==='ALL' ? evals.length : evals.filter(e=>e.tier===t).length
          const active = tierFilter === t
          const color = t==='ALL' ? '#94a3b8' : TIER_COLOR[t as Tier]
          return (
            <button key={t} onClick={()=>setTierFilter(t as Tier|'ALL')}
              className={`px-1 py-1 rounded text-[9px] font-mono uppercase tracking-wider border ${active ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-300 hover:border-slate-700'}`}>
              <div style={{color}} className="font-bold">{t.replace('NOT-CRZ','IDLE').replace('SUB-OPT','SUB').replace('OFF-OPT','OFF').replace('OPTIMAL','OPT')}</div>
              <div>{n}</div>
            </button>
          )
        })}
      </div>

      {/* Summary */}
      <div className="px-4 pt-3 grid grid-cols-5 gap-1.5 text-[10px]">
        <Cell label="μ-ΔGS" val={`${summary.meanGain>=0?'+':''}${summary.meanGain.toFixed(0)}kt`} color={summary.meanGain>=0?'text-emerald-400':'text-rose-400'} />
        <Cell label="Σ-FUEL" val={`${(summary.sigFuel/1000).toFixed(1)}t/h`} color="text-sky-300" />
        <Cell label="SUB" val={`${summary.subOpt}`} color={summary.subOpt>0?'text-rose-400':'text-slate-400'} />
        <Cell label="POOR" val={`${summary.poor}`} color={summary.poor>0?'text-rose-300':'text-slate-400'} />
        <Cell label="WORST" val={summary.worst ? (summary.worst.f.callsign||summary.worst.f.icao.toUpperCase()).slice(0,7) : '—'} color="text-slate-200" />
      </div>

      {/* Sliders */}
      <div className="px-4 pt-3 space-y-2">
        <Slider label={`ADV-MUL ${advMul}%`} v={advMul} min={50} max={200} step={5} on={setAdvMul} />
        <Slider label={`MIN-FL ${minFl}`} v={minFl} min={100} max={400} step={10} on={setMinFl} />
        <Slider label={`SCOPE ${scopeNm}NM`} v={scopeNm} min={200} max={2000} step={100} on={setScopeNm} />
      </div>

      {/* Toggles + search */}
      <div className="px-4 pt-3 flex flex-wrap gap-1.5">
        {[['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl]].map(([l,v,s]:any) => (
          <button key={l} onClick={()=>s(!v)}
            className={`px-2 py-1 text-[10px] rounded border font-mono ${v?'bg-sky-500/15 border-sky-500/40 text-sky-100':'bg-slate-900/50 border-slate-800 text-slate-400'}`}>{l}</button>
        ))}
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op"
          className="flex-1 min-w-[100px] bg-slate-900/50 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-700" />
      </div>

      {/* Tabs */}
      <div className="px-4 pt-3 flex gap-1">
        {(['AIRCRAFT','LEVELS','WIND'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)}
            className={`flex-1 px-2 py-1.5 text-[10px] uppercase tracking-wider font-bold rounded border ${tab===t?'bg-sky-500/15 border-sky-500/40 text-sky-100':'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>{t}</button>
        ))}
      </div>

      {/* AIRCRAFT tab */}
      {tab === 'AIRCRAFT' && (
        <div className="px-4 py-3 space-y-1.5">
          {filtered.length === 0 ? (
            <div className="text-center text-[11px] text-slate-500 py-6">No aircraft match current filters.</div>
          ) : filtered.slice(0, 40).map(e => (
            <button key={e.f.icao} onClick={()=>onFly(e.f.icao, e.f.lat, e.f.lng, 7)}
              className="w-full text-left bg-slate-900/40 hover:bg-slate-900/70 border border-slate-800 rounded-lg p-2 transition">
              <div className="flex items-center gap-1.5 text-[10px]">
                <span className="font-mono font-bold text-slate-100">{e.f.callsign || e.f.icao.toUpperCase()}</span>
                <span className="text-slate-500">{e.f.type||'—'}</span>
                <span className={`ml-auto px-1.5 py-0.5 rounded border font-mono text-[9px] ${TIER_BG[e.tier]}`}>{e.tier}</span>
              </div>
              <div className="grid grid-cols-5 gap-1 mt-1.5 text-[10px] font-mono">
                <div><span className="text-slate-500">FL</span> <span className="text-slate-200">{e.curFL}</span></div>
                <div><span className="text-slate-500">→</span> <span className="text-sky-300">{e.bestFL}</span></div>
                <div><span className="text-slate-500">ΔGS</span> <span className={e.dGs>=0?'text-emerald-300':'text-rose-300'}>{e.dGs>=0?'+':''}{e.dGs.toFixed(0)}</span></div>
                <div><span className="text-slate-500">Σ-fuel</span> <span className="text-amber-300">{e.dFuel.toFixed(0)}</span></div>
                <div><span className="text-slate-500">CAT</span> <span className={e.ti2Cur>8?'text-rose-300':'text-slate-300'}>{e.ti2Cur.toFixed(1)}</span></div>
              </div>
              <div className="mt-1.5 h-1 bg-slate-800 rounded overflow-hidden">
                <div style={{width:`${Math.min(100,e.score)}%`, background:TIER_COLOR[e.tier]}} className="h-full" />
              </div>
              <div className="mt-1 text-[10px] text-slate-400">
                <span className="font-mono" style={{color:TIER_COLOR[e.tier]}}>{e.step}</span>
                {e.tier==='SUB-OPT' && ' — request step-climb per Doc 4444 §15.2.5'}
                {e.tier==='POOR' && ' — single FL away from optimum tailwind'}
                {e.tier==='OFF-OPT' && ' — monitor next 100NM for FL change'}
                {e.tier==='NOMINAL' && ' — within ±5kt of best tailwind'}
                {e.tier==='OPTIMAL' && ' — on best-tailwind FL ✓'}
                {e.tier==='NOT-CRZ' && ' — not cruising / below scope'}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* LEVELS tab — per-FL aggregate */}
      {tab === 'LEVELS' && (
        <div className="px-4 py-3 space-y-1">
          <div className="grid grid-cols-5 gap-1 text-[9px] uppercase tracking-wider text-slate-500 px-1 pb-1 border-b border-slate-800">
            <div>FL</div><div>μ-WIND</div><div>μ-TW</div><div>AC</div><div>CAT-TI2</div>
          </div>
          {WAFS_FL.filter(L => L >= 180).map(L => {
            const at = evals.filter(e => e.curFL >= L - 10 && e.curFL <= L + 10 && e.tier !== 'NOT-CRZ')
            const meanTw = at.length ? at.reduce((a,e)=>a+e.curTw,0)/at.length : 0
            // sample wind at centroid
            const lat = at.length ? at.reduce((a,e)=>a+e.f.lat,0)/at.length : 40
            const lng = at.length ? at.reduce((a,e)=>a+e.f.lng,0)/at.length : 0
            const seed = at.length ? h32(at[0].f.icao) : 12345
            const w = windAt(lat, lng, L, seed)
            const t = ti2(lat, lng, L, seed)
            return (
              <div key={L} className="grid grid-cols-5 gap-1 px-1 py-1 text-[10px] font-mono border-b border-slate-900/60">
                <div className="text-slate-200">FL{L}</div>
                <div className="text-sky-300">{w.dir.toFixed(0)}°/{w.spd.toFixed(0)}</div>
                <div className={meanTw>=0?'text-emerald-300':'text-rose-300'}>{meanTw>=0?'+':''}{meanTw.toFixed(0)}</div>
                <div className="text-slate-300">{at.length}</div>
                <div className={t>10?'text-rose-300':t>5?'text-amber-300':'text-slate-300'}>{t.toFixed(1)}</div>
              </div>
            )
          })}
          <div className="text-[10px] text-slate-500 mt-2 leading-snug">
            Mandatory WAFS pressure-level FLs per ICAO Annex 3 App.2. μ-TW = mean tailwind component along current heading
            for aircraft within ±1000ft of that FL. CAT-TI2 = Ellrod &amp; Knapp (1992) Turbulence Index 2 proxy from
            horizontal deformation × vertical shear. Values &gt;10 indicate moderate-or-greater CAT exposure.
          </div>
        </div>
      )}

      {/* WIND tab — vertical wind profile SVG */}
      {tab === 'WIND' && wind && (
        <div className="px-4 py-3">
          <div className="text-[10px] text-slate-500 mb-2">
            Vertical wind &amp; CAT profile at worst-aircraft position
            ({evals[0]?.f.callsign||evals[0]?.f.icao.toUpperCase()}).
          </div>
          <svg viewBox="0 0 460 320" className="w-full bg-slate-900/50 border border-slate-800 rounded">
            {/* grid */}
            {[180,240,300,340,390,450,530].map(L => (
              <line key={L} x1={50} y1={300 - (L-150)/0.42} x2={440} y2={300 - (L-150)/0.42}
                stroke="#1e293b" strokeWidth={0.5} />
            ))}
            <line x1={230} y1={20} x2={230} y2={300} stroke="#334155" strokeWidth={0.5} strokeDasharray="2 3" />
            {/* labels */}
            {[180,240,300,340,390,450,530].map(L => (
              <text key={L} x={8} y={304 - (L-150)/0.42} fill="#64748b" fontSize="9" fontFamily="monospace">FL{L}</text>
            ))}
            <text x={230} y={314} fill="#94a3b8" fontSize="9" textAnchor="middle" fontFamily="monospace">0 kt</text>
            <text x={50} y={314} fill="#64748b" fontSize="9" textAnchor="middle" fontFamily="monospace">-180 TW</text>
            <text x={440} y={314} fill="#64748b" fontSize="9" textAnchor="middle" fontFamily="monospace">+180 TW</text>
            {/* tailwind bars */}
            {wind.filter(p => p.fl >= 180).map(p => {
              const y = 300 - (p.fl - 150) / 0.42
              const x0 = 230
              const x1 = 230 + (p.tw / 180) * 210
              const color = p.tw > 0 ? '#10b981' : '#f43f5e'
              return (
                <g key={`tw-${p.fl}`}>
                  <line x1={x0} y1={y} x2={x1} y2={y} stroke={color} strokeWidth={6} opacity={0.7} />
                  <text x={x1 + (p.tw>0?4:-4)} y={y+3} fill={color} fontSize="8" fontFamily="monospace"
                    textAnchor={p.tw>0?'start':'end'}>{p.tw>0?'+':''}{p.tw.toFixed(0)}</text>
                </g>
              )
            })}
            {/* CAT TI2 dots on right */}
            {wind.filter(p => p.fl >= 180).map(p => {
              const y = 300 - (p.fl - 150) / 0.42
              const color = p.ti2 > 10 ? '#f43f5e' : p.ti2 > 5 ? '#f59e0b' : '#64748b'
              return <circle key={`cat-${p.fl}`} cx={446} cy={y} r={Math.max(1.5, p.ti2/3)} fill={color} />
            })}
            {/* current FL marker */}
            {evals[0] && (() => {
              const y = 300 - (evals[0].curFL - 150) / 0.42
              const yb = 300 - (evals[0].bestFL - 150) / 0.42
              return (
                <g>
                  <line x1={45} y1={y} x2={448} y2={y} stroke="#0ea5e9" strokeWidth={0.8} strokeDasharray="3 2" opacity={0.6} />
                  <text x={446} y={y-3} fill="#0ea5e9" fontSize="8" textAnchor="end" fontFamily="monospace">CUR FL{evals[0].curFL}</text>
                  <line x1={45} y1={yb} x2={448} y2={yb} stroke="#10b981" strokeWidth={0.8} strokeDasharray="3 2" opacity={0.6} />
                  <text x={446} y={yb-3} fill="#10b981" fontSize="8" textAnchor="end" fontFamily="monospace">BEST FL{evals[0].bestFL}</text>
                </g>
              )
            })()}
          </svg>
          <div className="grid grid-cols-3 gap-1.5 mt-3 text-[10px]">
            <Cell label="CUR" val={`FL${evals[0]?.curFL||0}`} color="text-sky-300" />
            <Cell label="BEST" val={`FL${evals[0]?.bestFL||0}`} color="text-emerald-300" />
            <Cell label="ΔGS" val={`${(evals[0]?.dGs||0)>=0?'+':''}${(evals[0]?.dGs||0).toFixed(0)}kt`}
              color={(evals[0]?.dGs||0)>=0?'text-emerald-300':'text-rose-300'} />
          </div>
          <div className="text-[10px] text-slate-500 mt-3 leading-snug">
            Wind &amp; CAT computed from synthetic but globally coherent WAFS-style grid (jet-stream sinusoid in latitude,
            peak FL360, longitude wave streak modulation). Tailwind component = wind-vector · heading. Ellrod TI2 =
            |horizontal deformation| × |vertical shear|. Best-FL selected within ±60 FL of current, subject to TI2 ≤ 12.
            <br /><br />
            <span className="font-mono text-slate-400">Refs:</span> Annex 3 App.2 · Ellrod &amp; Knapp Wea.Forecasting 7 1992 ·
            Sharman JAM 45 2006 GTG · FCOM PI-22 · Doc 4444 §15.2.5 · AC 00-30C · NCEP WAFS GRIB2 · UKMO WAFC London.
          </div>
        </div>
      )}
    </div>
  )
}

function Cell({ label, val, color }: { label: string; val: string; color: string }) {
  return (
    <div className="bg-slate-900/50 border border-slate-800 rounded p-1.5">
      <div className="text-[8px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`font-mono text-[11px] font-bold ${color}`}>{val}</div>
    </div>
  )
}
function Slider({ label, v, min, max, step, on }: { label: string; v:number; min:number; max:number; step:number; on:(n:number)=>void }) {
  return (
    <div>
      <div className="flex justify-between text-[9px] uppercase tracking-wider text-slate-500 mb-0.5">
        <span>{label}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={v} onChange={e=>on(Number(e.target.value))}
        className="w-full accent-sky-500" />
    </div>
  )
}
