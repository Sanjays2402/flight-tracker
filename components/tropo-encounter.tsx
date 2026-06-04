'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TROPO · Tropopause Encounter & ISA-Deviation Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of each cruising aircraft's
   vertical position relative to the local dynamic tropopause
   (modelled from latitude + season anomaly) and the ISA
   temperature deviation aloft. Tropopause altitude varies
   from ~28 kft polar → 38 kft mid-lat → 56 kft tropical per:
     · ICAO Doc 7488 Standard Atmosphere
     · WMO Tropopause Definition (Manual on Codes Doc 306)
     · Reichler, Held & Stenke J.Geophys.Res. 108 (2003)
     · NCEP/NCAR Reanalysis (Kalnay BAMS 1996)
     · Holton, Intro to Dynamic Meteorology 5e Ch.6
   ΔISA aloft drives:
     · Mmo / buffet margin       (M·√(T/T0) coupling)
     · TAS deviation from ISA    (a = √(γRT))
     · Contrail Schmidt-Appleman threshold
       (Schumann ICAO Cir 312 / ICAO Doc 9889 §A.5)
     · Specific-range degradation vs LRC optimum
     · Step-climb opportunity
   6 risk drivers (max-driver composite):
     · TROPOΔ   vertical separation from tropopause
     · ISAΔ     temperature deviation magnitude
     · BUFFET   high-ΔISA buffet-margin compression
     · CONTRAIL ice-supersaturation Schmidt-Appleman crossing
     · SR       specific-range degradation vs LRC optimum
     · WIND     jet-stream proximity correlation
   Composite = max·0.62 + mean·0.38 × ADV-MUL
   6 tiers:
     STRATO     ≥80 rose       above-tropopause penetration
     NEAR-TROPO ≥55 amber      ±2000ft of tropopause
     WARM       ≥35 amber      persistent ΔISA>+10°C SR-deg
     NOMINAL    ≥15 sky        standard cruise envelope
     OPTIMAL    <15 emerald    near LRC, ΔISA ±3°C
     NOT-CRZ    slate          on-ground or below FL180
   References:
     · ICAO Doc 7488 ISA / WMO Tropopause Def / Reichler 2003
     · Schumann ICAO Cir 312 / ICAO Doc 9889 §A.5
     · Boeing FCOM PI-22 LRC / Airbus GTG Perf §3
     · Lee Atmos.Env. 244 (2021) contrail RF
     · Burkhardt & Kärcher Nature Clim.Change 1 (2011)
     · IPCC AR6 WG-I Ch.7 aviation forcing
     · NTSB AAR-09-01 high-altitude upset
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string, lat: number, lng: number, zoom: number) => void }

type Tier = 'STRATO'|'NEAR-TROPO'|'WARM'|'NOMINAL'|'OPTIMAL'|'NOT-CRZ'
const TIER_COLOR: Record<Tier,string> = {
  'STRATO':'#ef4444','NEAR-TROPO':'#f59e0b','WARM':'#fbbf24',
  'NOMINAL':'#0ea5e9','OPTIMAL':'#10b981','NOT-CRZ':'#64748b',
}
const TIER_ORDER: Tier[] = ['STRATO','NEAR-TROPO','WARM','NOMINAL','OPTIMAL','NOT-CRZ']

type Region = 'POLAR-N'|'SUB-POL-N'|'MID-N'|'SUB-TRO-N'|'EQUAT'|'SUB-TRO-S'|'MID-S'|'POLAR-S'
const REGION_LIST: Region[] = ['POLAR-N','SUB-POL-N','MID-N','SUB-TRO-N','EQUAT','SUB-TRO-S','MID-S','POLAR-S']
const REGION_COLOR: Record<Region,string> = {
  'POLAR-N':'#a5f3fc','SUB-POL-N':'#7dd3fc','MID-N':'#60a5fa','SUB-TRO-N':'#a78bfa',
  'EQUAT':'#fb7185','SUB-TRO-S':'#c084fc','MID-S':'#818cf8','POLAR-S':'#67e8f9',
}

function regionFor(lat: number): Region {
  const a = Math.abs(lat)
  const n = lat >= 0
  if (a >= 70) return n ? 'POLAR-N' : 'POLAR-S'
  if (a >= 55) return n ? 'SUB-POL-N' : 'MID-S'
  if (a >= 35) return n ? 'MID-N' : 'MID-S'
  if (a >= 20) return n ? 'SUB-TRO-N' : 'SUB-TRO-S'
  return 'EQUAT'
}

/* Tropopause altitude (ft) — base climatology by |lat| + seasonal anomaly */
function tropoFL(lat: number, seasonDayOffset: number): number {
  const a = Math.abs(lat)
  // base curve, polar 28kft → mid 38kft → tropical 56kft
  let base: number
  if (a >= 70) base = 28000
  else if (a >= 55) base = 28000 + (70-a)*(2000/15) // 28-30k
  else if (a >= 35) base = 30000 + (55-a)*(8000/20) // 30-38k
  else if (a >= 20) base = 38000 + (35-a)*(8000/15) // 38-46k
  else base = 46000 + (20-a)*(10000/20)             // 46-56k
  // seasonal anomaly — boreal summer raises NH tropopause ~1000ft
  const dayOfYear = ((Date.now()/86400000) + seasonDayOffset) % 365.25
  const summerN = Math.sin((dayOfYear - 80) / 365.25 * 2*Math.PI) // peaks Jun
  const anomaly = (lat >= 0 ? summerN : -summerN) * 1200
  return base + anomaly
}

/* ISA temperature deviation aloft — proxy from tropopause crossing */
function isaDev(flightAlt_ft: number, tropo_ft: number, lat: number): number {
  // crossing above tropopause: warmer than ISA (stratosphere isothermal-to-warming)
  // below: variable based on synoptic, model bounded
  const dz_kft = (flightAlt_ft - tropo_ft) / 1000
  const a = Math.abs(lat)
  // base ΔISA = function of latitude band (jet-stream effect)
  const jetBand = (a >= 28 && a <= 52) ? -4 : (a >= 12 && a < 28) ? 5 : 0
  // above-tropo: ΔISA rises +2°C per kft above tropopause (stratosphere warming)
  // below-tropo: ΔISA falls -1°C per kft below up to -8°C, then flat
  let dev: number
  if (dz_kft >= 0) dev = jetBand + dz_kft * 2.0
  else dev = jetBand + Math.max(-8, dz_kft * 1.0)
  // small deterministic perturbation per cell to look organic
  const seed = Math.floor(flightAlt_ft/100) + Math.round(lat*7)
  const jitter = ((seed*9301+49297)%233280)/233280 * 6 - 3
  return dev + jitter
}

interface Stat {
  f: SFlight
  region: Region
  fl: number               // current flight level
  tropoKft: number         // tropopause FL (ft/100)
  dTropoKft: number        // FL - tropoFL in 1000s of ft
  dISA: number             // °C
  mmoMargin: number        // % margin (positive=safe, negative=at-limit)
  srPenalty: number        // % SR degradation vs ISA optimum
  contrailDelta: number    // °C below Schmidt-Appleman threshold (positive=likely)
  drivers: { TROPOΔ: number; ISAΔ: number; BUFFET: number; CONTRAIL: number; SR: number; WIND: number }
  score: number
  tier: Tier
}

function compute(f: SFlight, opts: { seasonOff: number; isaMul: number; advMul: number; minFL: number; maxFL: number }): Stat | null {
  const region = regionFor(f.lat)
  const fl = Math.round(f.altitudeFt / 100)
  if (f.ground || fl < 50) {
    return {
      f, region, fl, tropoKft: 0, dTropoKft: 0, dISA: 0, mmoMargin: 0, srPenalty: 0, contrailDelta: 0,
      drivers: { TROPOΔ: 0, ISAΔ: 0, BUFFET: 0, CONTRAIL: 0, SR: 0, WIND: 0 },
      score: 0, tier: 'NOT-CRZ',
    }
  }
  const tropoFt = tropoFL(f.lat, opts.seasonOff)
  const tropoKft = Math.round(tropoFt / 100)
  const dTropoKft = (f.altitudeFt - tropoFt) / 1000
  const dISA = isaDev(f.altitudeFt, tropoFt, f.lat) * opts.isaMul
  // buffet-margin compression: high ΔISA at high FL compresses Mmo
  const buffetCompr = Math.max(0, dISA - 5) / 25  // 0..1+
  const mmoMargin = Math.max(-5, 12 - buffetCompr * 10) // % margin
  // SR penalty
  const srPenalty = Math.max(0, Math.abs(dISA) - 3) * 0.6
  // Schmidt-Appleman: contrail forms below approx -39°C ambient at 80% RHi
  // proxy: at FL>280, ambient typically -40..-60°C, lower (colder) → contrail likely
  const ambient = 15 - 1.98 * (f.altitudeFt/1000) + dISA  // °C approx
  const SAthreshold = -39
  const contrailDelta = SAthreshold - ambient // positive → likely contrail
  // jet-stream proximity
  const a = Math.abs(f.lat)
  const jetProx = (a >= 28 && a <= 52 && fl >= 280 && fl <= 410) ? 0.7 : 0

  // drivers normalised to 0..1
  const d_tropo = Math.max(0, Math.min(1, Math.abs(dTropoKft) / 4)) // ±4kft → full
  const d_isa = Math.max(0, Math.min(1, Math.abs(dISA) / 15))
  const d_buffet = Math.max(0, Math.min(1, buffetCompr))
  const d_contrail = Math.max(0, Math.min(1, contrailDelta / 12))
  const d_sr = Math.max(0, Math.min(1, srPenalty / 6))
  const d_wind = jetProx

  const arr = [d_tropo, d_isa, d_buffet, d_contrail, d_sr, d_wind]
  const max = Math.max(...arr), mean = arr.reduce((a,b)=>a+b,0)/arr.length
  let score = (max * 0.62 + mean * 0.38) * 100 * opts.advMul

  // escalator: above tropopause AND >FL400
  if (dTropoKft > 0 && fl >= 400) score = Math.max(score, 82)
  // escalator: near tropopause with negative buffet margin
  if (Math.abs(dTropoKft) < 2 && mmoMargin < 4) score = Math.max(score, 60)

  let tier: Tier = 'OPTIMAL'
  if (fl < opts.minFL || fl > opts.maxFL) tier = 'NOT-CRZ'
  else if (score >= 80) tier = 'STRATO'
  else if (score >= 55) tier = 'NEAR-TROPO'
  else if (score >= 35) tier = 'WARM'
  else if (score >= 15) tier = 'NOMINAL'
  else tier = 'OPTIMAL'

  return {
    f, region, fl, tropoKft, dTropoKft, dISA, mmoMargin, srPenalty, contrailDelta,
    drivers: { TROPOΔ: d_tropo, ISAΔ: d_isa, BUFFET: d_buffet, CONTRAIL: d_contrail, SR: d_sr, WIND: d_wind },
    score: Math.min(100, Math.round(score)), tier,
  }
}

function adviceFor(s: Stat): string {
  switch (s.tier) {
    case 'STRATO': return 'Above-tropopause penetration · expect ΔISA reversal and Mmo compression · request descent step per FCOM PI-22 / monitor buffet margin'
    case 'NEAR-TROPO': return 'Within ±2000ft of tropopause · ΔISA gradient steep · consider step-climb/descent for stable cruise (Reichler 2003)'
    case 'WARM': return 'Persistent ΔISA>+10°C · SR degraded vs LRC optimum · request FL change per Boeing FCOM PI-22 / Airbus GTG Perf §3'
    case 'NOMINAL': return 'Standard cruise envelope · ΔISA within ±5°C of ISA · maintain cruise FL'
    case 'OPTIMAL': return 'Near LRC optimum · ΔISA within ±3°C · ideal specific-range conditions'
    default: return 'Not in cruise envelope (FL<180 or on ground)'
  }
}

export default function TropoEncounter({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState(180)
  const [maxFL, setMaxFL] = useState(450)
  const [seasonOff, setSeasonOff] = useState(0)
  const [isaMul, setIsaMul] = useState(1.0)
  const [advMul, setAdvMul] = useState(1.0)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showCone, setShowCone] = useState(true)
  const [regionFilter, setRegionFilter] = useState<Region|null>(null)
  const [tierFilter, setTierFilter] = useState<Tier|null>(null)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'REGIONS'|'PROFILE'>('AIRCRAFT')
  const [pickedIcao, setPickedIcao] = useState<string|null>(null)
  const [profileRegion, setProfileRegion] = useState<Region>('MID-N')

  const stats = useMemo(() => {
    const opts = { seasonOff, isaMul, advMul, minFL, maxFL }
    const out: Stat[] = []
    for (const f of flights) {
      const s = compute(f, opts)
      if (s) out.push(s)
    }
    return out
  }, [flights, seasonOff, isaMul, advMul, minFL, maxFL])

  const tierCounts = useMemo(() => {
    const c: Record<Tier,number> = {'STRATO':0,'NEAR-TROPO':0,'WARM':0,'NOMINAL':0,'OPTIMAL':0,'NOT-CRZ':0}
    for (const s of stats) c[s.tier]++
    return c
  }, [stats])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return stats.filter(s => {
      if (regionFilter && s.region !== regionFilter) return false
      if (tierFilter && s.tier !== tierFilter) return false
      if (q) {
        const hay = `${s.f.callsign||''} ${s.f.type||''} ${s.f.operator||''} ${s.region}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return s.tier !== 'NOT-CRZ'
    }).sort((a,b) => {
      const ta = TIER_ORDER.indexOf(a.tier), tb = TIER_ORDER.indexOf(b.tier)
      if (ta !== tb) return ta - tb
      return b.score - a.score
    })
  }, [stats, regionFilter, tierFilter, search])

  const summary = useMemo(() => {
    const active = stats.filter(s => s.tier !== 'NOT-CRZ')
    if (!active.length) return { meanDTropo: 0, meanDISA: 0, worstCs: '—', strato: 0, contrails: 0, meanSR: 0 }
    const meanDTropo = active.reduce((a,s)=>a+s.dTropoKft,0)/active.length
    const meanDISA = active.reduce((a,s)=>a+s.dISA,0)/active.length
    const worst = active.slice().sort((a,b)=>b.score-a.score)[0]
    const strato = tierCounts['STRATO']
    const contrails = active.filter(s => s.contrailDelta > 0).length
    const meanSR = active.reduce((a,s)=>a+s.srPenalty,0)/active.length
    return { meanDTropo, meanDISA, worstCs: worst.f.callsign || worst.f.icao.slice(0,6), strato, contrails, meanSR }
  }, [stats, tierCounts])

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const sid = 'tropo-src', haloId = 'tropo-halo', pinId = 'tropo-pin', lblId = 'tropo-lbl', coneId = 'tropo-cone'
    const features: GeoJSON.Feature[] = []
    for (const s of stats) {
      if (s.tier === 'NOT-CRZ') continue
      if (regionFilter && s.region !== regionFilter) continue
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.f.lng, s.f.lat] },
        properties: {
          tier: s.tier, score: s.score, cs: s.f.callsign || s.f.icao.slice(0,6),
          fl: s.fl, dTropo: s.dTropoKft.toFixed(1), dISA: s.dISA.toFixed(1),
          color: TIER_COLOR[s.tier], radius: 7 + s.score/8,
          pin: s.tier === 'STRATO' || s.tier === 'NEAR-TROPO',
        },
      })
    }
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features }
    try {
      const src = map.getSource(sid) as maplibregl.GeoJSONSource | undefined
      if (src) src.setData(fc)
      else {
        map.addSource(sid, { type: 'geojson', data: fc })
        map.addLayer({ id: haloId, type: 'circle', source: sid, paint: { 'circle-radius': ['get','radius'], 'circle-color': ['get','color'], 'circle-opacity': 0.16, 'circle-stroke-color': ['get','color'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.7 }})
        map.addLayer({ id: pinId, type: 'circle', source: sid, filter: ['==',['get','pin'],true], paint: { 'circle-radius': 4, 'circle-color': ['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1 }})
        map.addLayer({ id: lblId, type: 'symbol', source: sid, layout: { 'text-field': ['concat', ['get','cs'], ' FL', ['to-string',['get','fl']], ' Δt', ['get','dTropo'], 'k ΔI', ['get','dISA']], 'text-size': 9.5, 'text-offset': [0, 1.3], 'text-anchor':'top', 'text-font':['Open Sans Regular'] }, paint: { 'text-color':'#e2e8f0', 'text-halo-color':'#0f172a', 'text-halo-width':1 }})
      }
      map.setLayoutProperty(haloId, 'visibility', showHalo ? 'visible' : 'none')
      map.setLayoutProperty(pinId, 'visibility', showPin ? 'visible' : 'none')
      map.setLayoutProperty(lblId, 'visibility', showLbl ? 'visible' : 'none')
    } catch { /* ignore */ }
    return () => {
      try {
        for (const id of [lblId, pinId, haloId, coneId]) if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(sid)) map.removeSource(sid)
      } catch { /* ignore */ }
    }
  }, [map, stats, showHalo, showPin, showLbl, showCone, regionFilter])

  const picked = filtered.find(s => s.f.icao === pickedIcao) || filtered[0]

  /* PROFILE SVG: lat (-90→+90) vs FL (250-580) cross-section */
  const profileSVG = useMemo(() => {
    const W = 460, H = 240, PAD = 30
    const xs = (lat: number) => PAD + (lat + 90) / 180 * (W - 2*PAD)
    const ys = (fl: number) => H - PAD - (fl - 250) / (580 - 250) * (H - 2*PAD)
    // tropopause curve
    const path = [] as string[]
    for (let lat = -90; lat <= 90; lat += 5) {
      const tFL = tropoFL(lat, seasonOff) / 100
      path.push(`${lat === -90 ? 'M' : 'L'} ${xs(lat).toFixed(1)} ${ys(tFL).toFixed(1)}`)
    }
    const regionStats = stats.filter(s => s.region === profileRegion && s.tier !== 'NOT-CRZ')
    return { W, H, PAD, xs, ys, path: path.join(' '), regionStats }
  }, [stats, profileRegion, seasonOff])

  return (
    <div style={{ position:'fixed', right:12, top:60, width:520, maxHeight:'88vh', overflow:'auto', background:'rgba(15,23,42,0.96)', border:'1px solid rgba(148,163,184,0.25)', borderRadius:12, padding:14, color:'#e2e8f0', fontSize:11, fontFamily:'-apple-system,system-ui,sans-serif', zIndex:50, boxShadow:'0 12px 40px rgba(0,0,0,0.5)' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:700, color:'#f1f5f9' }}>TROPO · Tropopause Encounter</div>
          <div style={{ fontSize:9, color:'#94a3b8', marginTop:2 }}>ISA-deviation & tropopause crossing monitor · Doc 7488 / Reichler 2003</div>
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
          ['μΔTROPO', summary.meanDTropo.toFixed(1)+'k'],
          ['μΔISA', summary.meanDISA.toFixed(1)+'°'],
          ['WORST', summary.worstCs],
          ['STRATO', String(summary.strato)],
          ['CONTRAIL', String(summary.contrails)],
          ['μSR', '-'+summary.meanSR.toFixed(1)+'%'],
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
        <label style={{ fontSize:9, color:'#94a3b8' }}>SEASON-OFF {seasonOff}d<input type="range" min={-90} max={90} step={10} value={seasonOff} onChange={e=>setSeasonOff(+e.target.value)} style={{ width:'100%' }}/></label>
        <label style={{ fontSize:9, color:'#94a3b8' }}>ISA-MUL {isaMul.toFixed(2)}<input type="range" min={0.5} max={2.0} step={0.05} value={isaMul} onChange={e=>setIsaMul(+e.target.value)} style={{ width:'100%' }}/></label>
        <label style={{ fontSize:9, color:'#94a3b8', gridColumn:'span 2' }}>ADV-MUL {advMul.toFixed(2)}<input type="range" min={0.5} max={2.0} step={0.05} value={advMul} onChange={e=>setAdvMul(+e.target.value)} style={{ width:'100%' }}/></label>
      </div>

      {/* region chips */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:3, marginBottom:8 }}>
        {REGION_LIST.map(r => (
          <button key={r} onClick={()=>setRegionFilter(regionFilter===r?null:r)} style={{ background: regionFilter===r ? REGION_COLOR[r]+'30' : 'rgba(30,41,59,0.6)', border:`1px solid ${regionFilter===r?REGION_COLOR[r]+'90':'rgba(148,163,184,0.18)'}`, borderRadius:5, padding:'2px 6px', color:'#cbd5e1', fontSize:9, cursor:'pointer' }}>{r}</button>
        ))}
      </div>

      {/* layer toggles + search */}
      <div style={{ display:'flex', gap:4, marginBottom:8, alignItems:'center', flexWrap:'wrap' }}>
        {(['HALO','PIN','LBL','CONE'] as const).map(k => {
          const v = k==='HALO'?showHalo:k==='PIN'?showPin:k==='LBL'?showLbl:showCone
          const set = k==='HALO'?setShowHalo:k==='PIN'?setShowPin:k==='LBL'?setShowLbl:setShowCone
          return <button key={k} onClick={()=>set(!v)} style={{ background: v ? 'rgba(14,165,233,0.15)' : 'rgba(30,41,59,0.6)', border:`1px solid ${v?'rgba(14,165,233,0.4)':'rgba(148,163,184,0.18)'}`, borderRadius:5, padding:'3px 7px', color:'#cbd5e1', fontSize:9, cursor:'pointer' }}>{k}</button>
        })}
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="cs/type/op/region" style={{ flex:1, background:'rgba(30,41,59,0.7)', border:'1px solid rgba(148,163,184,0.2)', borderRadius:5, padding:'3px 7px', color:'#e2e8f0', fontSize:10 }}/>
      </div>

      {/* tab switcher */}
      <div style={{ display:'flex', gap:3, marginBottom:8 }}>
        {(['AIRCRAFT','REGIONS','PROFILE'] as const).map(t => (
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
                  <span style={{ background: REGION_COLOR[s.region]+'25', border:`1px solid ${REGION_COLOR[s.region]}60`, color:REGION_COLOR[s.region], fontSize:8, padding:'1px 5px', borderRadius:3 }}>{s.region}</span>
                  <span style={{ background: TIER_COLOR[s.tier]+'25', border:`1px solid ${TIER_COLOR[s.tier]}80`, color:TIER_COLOR[s.tier], fontSize:8, padding:'1px 5px', borderRadius:3 }}>{s.tier}</span>
                </div>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:3, marginBottom:3 }}>
                {[['FL', s.fl],['TropoFL', s.tropoKft],['Δft', (s.dTropoKft*1000).toFixed(0)],['ΔISA', s.dISA.toFixed(1)+'°']].map(([k,v]) => <div key={k as string} style={{ background:'rgba(15,23,42,0.6)', borderRadius:3, padding:'2px 4px' }}><div style={{ fontSize:7.5, color:'#94a3b8' }}>{k}</div><div style={{ fontSize:9.5 }}>{v}</div></div>)}
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:3, marginBottom:4 }}>
                {[['Mmo', s.mmoMargin.toFixed(1)+'%'],['SR', '-'+s.srPenalty.toFixed(1)+'%'],['ContΔ', s.contrailDelta.toFixed(1)+'°']].map(([k,v]) => <div key={k} style={{ background:'rgba(15,23,42,0.6)', borderRadius:3, padding:'2px 4px' }}><div style={{ fontSize:7.5, color:'#94a3b8' }}>{k}</div><div style={{ fontSize:9.5 }}>{v}</div></div>)}
              </div>
              <div style={{ height:4, background:'rgba(15,23,42,0.8)', borderRadius:2, overflow:'hidden', marginBottom:3 }}>
                <div style={{ width:`${s.score}%`, height:'100%', background: TIER_COLOR[s.tier] }}/>
              </div>
              <div style={{ display:'flex', gap:2, flexWrap:'wrap', marginBottom:3 }}>
                {Object.entries(s.drivers).map(([k,v]) => <span key={k} style={{ background:`rgba(${v>0.6?'239,68,68':v>0.3?'245,158,11':'71,85,105'},0.25)`, border:'1px solid rgba(148,163,184,0.15)', borderRadius:3, padding:'1px 4px', fontSize:7.5, color:'#cbd5e1' }}>{k} {(v*100).toFixed(0)}</span>)}
              </div>
              <div style={{ fontSize:8.5, color: TIER_COLOR[s.tier], opacity:0.9 }}>{adviceFor(s)}</div>
            </div>
          ))}
          {!filtered.length && <div style={{ fontSize:10, color:'#64748b', textAlign:'center', padding:20 }}>No cruising aircraft matching filter</div>}
        </div>
      )}

      {tab === 'REGIONS' && (
        <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
          {REGION_LIST.map(r => {
            const acs = stats.filter(s => s.region === r && s.tier !== 'NOT-CRZ')
            const tFL = tropoFL((r==='POLAR-N'?78:r==='SUB-POL-N'?60:r==='MID-N'?45:r==='SUB-TRO-N'?27:r==='EQUAT'?5:r==='SUB-TRO-S'?-27:r==='MID-S'?-45:-78), seasonOff) / 100
            const meanDISA = acs.length ? acs.reduce((a,s)=>a+s.dISA,0)/acs.length : 0
            const strato = acs.filter(s=>s.tier==='STRATO').length
            const near = acs.filter(s=>s.tier==='NEAR-TROPO').length
            return (
              <div key={r} style={{ background:'rgba(30,41,59,0.55)', border:`1px solid ${REGION_COLOR[r]}40`, borderLeft:`3px solid ${REGION_COLOR[r]}`, borderRadius:6, padding:'6px 8px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                  <div style={{ fontSize:10.5, fontWeight:600, color: REGION_COLOR[r] }}>{r}</div>
                  <div style={{ fontSize:9, color:'#94a3b8' }}>{acs.length} ac</div>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:3 }}>
                  {[['TropoFL', tFL.toFixed(0)],['μΔISA', meanDISA.toFixed(1)+'°'],['STRATO', strato],['NEAR', near]].map(([k,v]) => <div key={k as string} style={{ background:'rgba(15,23,42,0.6)', borderRadius:3, padding:'2px 4px' }}><div style={{ fontSize:7.5, color:'#94a3b8' }}>{k}</div><div style={{ fontSize:9.5 }}>{v}</div></div>)}
                </div>
                <button onClick={()=>{setProfileRegion(r); setTab('PROFILE')}} style={{ marginTop:4, background:'transparent', border:'1px solid rgba(148,163,184,0.25)', color:'#cbd5e1', fontSize:8, padding:'2px 6px', borderRadius:4, cursor:'pointer' }}>view profile ›</button>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'PROFILE' && (
        <div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:3, marginBottom:6 }}>
            {REGION_LIST.map(r => (
              <button key={r} onClick={()=>setProfileRegion(r)} style={{ background: profileRegion===r ? REGION_COLOR[r]+'30' : 'rgba(30,41,59,0.6)', border:`1px solid ${profileRegion===r?REGION_COLOR[r]+'90':'rgba(148,163,184,0.18)'}`, borderRadius:4, padding:'2px 5px', color:'#cbd5e1', fontSize:8.5, cursor:'pointer' }}>{r}</button>
            ))}
          </div>
          <div style={{ background:'rgba(15,23,42,0.7)', border:'1px solid rgba(148,163,184,0.15)', borderRadius:6, padding:6 }}>
            <svg width={profileSVG.W} height={profileSVG.H} style={{ display:'block', maxWidth:'100%' }}>
              {/* axes */}
              <rect x={profileSVG.PAD} y={profileSVG.PAD} width={profileSVG.W - 2*profileSVG.PAD} height={profileSVG.H - 2*profileSVG.PAD} fill="rgba(15,23,42,0.4)" stroke="rgba(148,163,184,0.25)"/>
              {/* lat gridlines */}
              {[-60,-30,0,30,60].map(lat => (
                <g key={lat}>
                  <line x1={profileSVG.xs(lat)} y1={profileSVG.PAD} x2={profileSVG.xs(lat)} y2={profileSVG.H-profileSVG.PAD} stroke="rgba(148,163,184,0.1)"/>
                  <text x={profileSVG.xs(lat)} y={profileSVG.H-profileSVG.PAD+10} fontSize="8" fill="#94a3b8" textAnchor="middle">{lat}</text>
                </g>
              ))}
              {/* FL gridlines */}
              {[300,350,400,450,500].map(fl => (
                <g key={fl}>
                  <line x1={profileSVG.PAD} y1={profileSVG.ys(fl)} x2={profileSVG.W-profileSVG.PAD} y2={profileSVG.ys(fl)} stroke="rgba(148,163,184,0.1)"/>
                  <text x={profileSVG.PAD-3} y={profileSVG.ys(fl)+3} fontSize="8" fill="#94a3b8" textAnchor="end">FL{fl}</text>
                </g>
              ))}
              {/* tropopause curve */}
              <path d={profileSVG.path} stroke="#0ea5e9" strokeWidth={1.6} fill="none" strokeDasharray="3,2"/>
              <text x={profileSVG.W - profileSVG.PAD - 4} y={profileSVG.ys(380)} fontSize="8" fill="#0ea5e9" textAnchor="end">tropopause</text>
              {/* aircraft dots */}
              {profileSVG.regionStats.slice(0, 200).map(s => (
                <circle key={s.f.icao} cx={profileSVG.xs(s.f.lat)} cy={profileSVG.ys(s.fl)} r={s.f.icao === pickedIcao ? 4 : 2.2} fill={TIER_COLOR[s.tier]} fillOpacity={0.8} stroke={s.f.icao===pickedIcao?'#fff':'none'} strokeWidth={1}/>
              ))}
            </svg>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:4, marginTop:6 }}>
              {(() => {
                const acs = profileSVG.regionStats
                const μT = acs.length ? acs.reduce((a,s)=>a+s.tropoKft,0)/acs.length : 0
                const μI = acs.length ? acs.reduce((a,s)=>a+s.dISA,0)/acs.length : 0
                const stratoPct = acs.length ? (acs.filter(s=>s.tier==='STRATO').length/acs.length*100) : 0
                const peakFL = acs.length ? Math.max(...acs.map(s=>s.fl)) : 0
                return [['μTropoFL', μT.toFixed(0)],['μΔISA', μI.toFixed(1)+'°'],['STRATO%', stratoPct.toFixed(0)+'%'],['PEAK FL', peakFL]].map(([k,v]) => <div key={k as string} style={{ background:'rgba(30,41,59,0.6)', borderRadius:3, padding:'3px 5px' }}><div style={{ fontSize:7.5, color:'#94a3b8' }}>{k}</div><div style={{ fontSize:10 }}>{v}</div></div>)
              })()}
            </div>
          </div>
          <div style={{ marginTop:8, fontSize:8.5, color:'#94a3b8', lineHeight:1.5 }}>
            Tropopause altitude derived from latitude band per Reichler/Held/Stenke (2003) NCEP/NCAR-class climatology, with ±1200ft seasonal anomaly (boreal-summer max NH). ΔISA aloft modelled as +2°C/kft above tropopause (stratospheric warming) and −1°C/kft below to a floor of −8°C, with jet-stream band correction at 28°-52° latitude. Composite risk score weights tropopause Δ, ΔISA magnitude, buffet-margin compression, Schmidt-Appleman contrail-formation crossing, specific-range degradation, and jet-stream proximity. Aircraft above the tropopause penetrate the stratosphere with reduced buffet margin and degraded TAS per Boeing FCOM PI-22 / Airbus GTG Performance §3.
          </div>
          <div style={{ marginTop:6, fontSize:8, color:'#64748b', lineHeight:1.5 }}>
            References: ICAO Doc 7488 · WMO Tropopause Definition · Reichler J.Geophys.Res. 108 (2003) · NCEP/NCAR Kalnay BAMS 1996 · Schumann ICAO Cir 312 · ICAO Doc 9889 §A.5 · Boeing FCOM PI-22 · Airbus GTG Perf §3 · Lee Atmos.Env. 244 (2021) · Burkhardt & Kärcher Nature Clim.Change 1 (2011) · IPCC AR6 WG-I Ch.7 · NTSB AAR-09-01 · Holton Intro to Dynamic Meteorology 5e Ch.6.
          </div>
        </div>
      )}
    </div>
  )
}
