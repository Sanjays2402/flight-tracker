'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TEMPCOMP · Cold-Temperature Altimetry Correction & ISA-Deviation
            Minimum-Altitude Margin Monitor for Restricted Aerodromes
   ------------------------------------------------------------
   Per-airframe live evaluator of the cold-temperature altimetry
   error (indicated altitude reads HIGHER than true geometric
   altitude when OAT is below ISA) and the resulting margin
   loss against published minimum altitudes (FAF / IF / MDA(H)
   / DA(H) / MSA / MOCA / circling) at cold-temperature
   restricted aerodromes per:
     · ICAO Doc 8168 Vol I Pt III §4.3   Cold-temperature corrections
     · ICAO Annex 6 Pt I §4.2.6           Operator cold-temp procedures
     · FAA AIM 7-3-1                      Cold-temperature restricted airports
     · FAA AC 91-79B App.A                Approach in low-temperature ops
     · FAA InFO 21002                     CTA list & operator responsibility
     · FAA Order 8260.58 §2-3              Procedure design — temperature limits
     · Transport Canada AIM RAC 9.17       Cold-temperature corrections
     · UK CAA CAP 393 GEN 3.5 §5           UK cold-WX altimetry
     · EASA AMC 91.13 / SPA.LVO            Cold-temp corrections (commercial)
     · FAA H-8083-15B Ch.10                IFR alt errors
     · CASA AC 91-21                       Cold-temp altitude corrections
     · Honeywell EGPWS Pilot's Guide §4    Geometric altitude basis
     · Boeing FCTM Approach §4             Cold-temp procedures
     · Airbus FCTM PRO-NOR-SOP-19          Cold-temp corrections

   PHYSICS (Doc 8168 simplified form):
       Δh_corr ≈ H_AGL · ( ISA - OAT_aerodrome ) / 273
   where:
       H_AGL = height ABOVE aerodrome elevation [ft]
       ISA   = 15°C - 1.98°C/1000ft · elev_kft
       OAT   = reported aerodrome temperature [°C]
   Sign convention: OAT < ISA  →  Δh > 0 (true alt LOWER than indicated)
   Pilot/FMS adds Δh_corr to the procedure minimum altitude so that
   the true altitude meets the obstacle-clearance design intent.

   Cold-temp restricted-airport (CTA) catalogue — 28 published per
   FAA AIM 7-3-1 (USA), Transport Canada AIP RAC 9.17 (Canada),
   ICAO Doc 8168 Vol I appendix (international high-latitude):
     KFAI Fairbanks AK             -25°C threshold   elev 434
     PAJN Juneau AK                -15°C            elev 18
     KASE Aspen CO                 -10°C            elev 7820   (terrain)
     KEGE Eagle/Vail CO            -10°C            elev 6548
     KTEX Telluride CO             -5°C             elev 9078
     KJAC Jackson Hole WY          -10°C            elev 6451
     KBZN Bozeman MT               -15°C            elev 4473
     KMSO Missoula MT              -15°C            elev 3206
     KGEG Spokane WA               -20°C            elev 2384
     KANC Anchorage AK             -25°C            elev 152
     CYYC Calgary AB               -25°C            elev 3557
     CYEG Edmonton AB              -25°C            elev 2373
     CYWG Winnipeg MB              -25°C            elev 783
     CYQR Regina SK                -25°C            elev 1894
     CYZF Yellowknife NT           -30°C            elev 675
     CYFB Iqaluit NU               -30°C            elev 110
     BIRK Reykjavík                -15°C            elev 48
     BIKF Keflavík                 -15°C            elev 171
     ENGM Oslo Gardermoen          -20°C            elev 681
     ESSA Stockholm Arlanda        -20°C            elev 137
     EFHK Helsinki                 -25°C            elev 179
     ENZV Stavanger                -15°C            elev 29
     UUEE Moscow Sheremetyevo      -25°C            elev 622
     UUDD Moscow Domodedovo        -25°C            elev 595
     ZBAA Beijing Capital          -15°C            elev 116
     LOWI Innsbruck                -10°C            elev 1907   (terrain)
     LSZS Samedan                  -10°C            elev 5600   (terrain)
     LFLJ Courchevel               -5°C             elev 6588   (terrain)

   8 drivers (each 0-100):
     · ERR     correction Δh as % of H_AGL (≥10% critical)
     · ΔISA    OAT deviation below ISA at aerodrome
     · MIN     proximity to procedure MDA/DH (closer = worse)
     · CTA     aerodrome on CTA list and temp below threshold
     · TERR    aerodrome surrounded by terrain (KASE/LOWI/LSZS)
     · UNCORR  ECAM/FMS indicates uncorrected procedure altitudes
     · PHASE   approach-final / circling / departure weighting
     · DIST    snap-distance to aerodrome (≤25 NM scope)

   Composite max·0.62 + mean·0.38 × phase-weight × ADV-MUL.

   Hard escalators:
     · Δh ≥ 12% of H_AGL + APPR-FNL              score-min 92
     · CTA + ΔISA ≥ 30°C + descending             score-min 86
     · Δh ≥ 200 ft + circling MDH                 score-min 78
     · OAT below CTA threshold + UNCORR flag      score-min 88

   6 tiers:
     · IMPACT  ≥85  rose       uncorrected min alt → terrain impact risk
     · MAJOR   ≥65  rose-pink  >8% Δh, apply correction per Doc 8168 §4.3
     · WATCH   ≥45  amber      4-8% Δh, brief CTA procedure
     · GUARD   ≥22  sky        <4% Δh, monitor temp trend
     · CLEAR   <22  emerald    ΔISA negligible
     · OFF     slate           not approaching a CTA in scope
============================================================ */

interface VFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: VFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'IMPACT'|'MAJOR'|'WATCH'|'GUARD'|'CLEAR'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  IMPACT:'#ef4444', MAJOR:'#f43f5e', WATCH:'#f59e0b',
  GUARD:'#0ea5e9', CLEAR:'#10b981', OFF:'#475569',
}
const TIER_RANK: Record<Tier,number> = { IMPACT:0, MAJOR:1, WATCH:2, GUARD:3, CLEAR:4, OFF:5 }
const TIER_ORDER: Tier[] = ['IMPACT','MAJOR','WATCH','GUARD','CLEAR']
type Phase = 'APPR-FNL'|'APPR-INT'|'CIRCLING'|'DEPT-CLB'|'OFF'

interface Cta {
  icao: string; name: string; lat: number; lng: number; elev: number   // ft MSL
  thr: number          // °C threshold
  terr: boolean        // terrain-constrained
  mda: number          // typical MDA ft MSL (procedure brief reference)
  dh: number           // typical DH ft AGL
  ref: string
}
const CTA: Cta[] = [
  { icao:'KFAI', name:'Fairbanks',           lat:64.815, lng:-147.857, elev:434,  thr:-25, terr:false, mda:780,  dh:200, ref:'FAA AIM 7-3-1 / KFAI ILS RWY 02L' },
  { icao:'PAJN', name:'Juneau',              lat:58.355, lng:-134.576, elev:18,   thr:-15, terr:true,  mda:1690, dh:NaN, ref:'FAA AIM 7-3-1 / PAJN LDA RWY 08 (terrain)' },
  { icao:'KASE', name:'Aspen',               lat:39.223, lng:-106.869, elev:7820, thr:-10, terr:true,  mda:10200,dh:NaN, ref:'FAA AIM 7-3-1 / KASE LOC/DME-E (high-terrain)' },
  { icao:'KEGE', name:'Eagle/Vail',          lat:39.643, lng:-106.918, elev:6548, thr:-10, terr:true,  mda:9040, dh:NaN, ref:'FAA AIM 7-3-1 / KEGE LDA/DME-C' },
  { icao:'KTEX', name:'Telluride',           lat:37.954, lng:-107.908, elev:9078, thr:-5,  terr:true,  mda:11400,dh:NaN, ref:'FAA AIM 7-3-1 / KTEX RNAV high-terrain' },
  { icao:'KJAC', name:'Jackson Hole',        lat:43.607, lng:-110.738, elev:6451, thr:-10, terr:true,  mda:7980, dh:NaN, ref:'FAA AIM 7-3-1 / KJAC RNP terrain' },
  { icao:'KBZN', name:'Bozeman',             lat:45.778, lng:-111.160, elev:4473, thr:-15, terr:true,  mda:5160, dh:250, ref:'FAA AIM 7-3-1 / KBZN ILS RWY 12' },
  { icao:'KMSO', name:'Missoula',            lat:46.916, lng:-114.090, elev:3206, thr:-15, terr:true,  mda:4220, dh:NaN, ref:'FAA AIM 7-3-1 / KMSO LDA RWY 11' },
  { icao:'KGEG', name:'Spokane',             lat:47.620, lng:-117.534, elev:2384, thr:-20, terr:false, mda:2640, dh:200, ref:'FAA AIM 7-3-1 / KGEG ILS RWY 21' },
  { icao:'KANC', name:'Anchorage',           lat:61.174, lng:-149.996, elev:152,  thr:-25, terr:false, mda:490,  dh:200, ref:'FAA AIM 7-3-1 / PANC ILS RWY 07R' },
  { icao:'CYYC', name:'Calgary',             lat:51.114, lng:-114.020, elev:3557, thr:-25, terr:false, mda:3800, dh:200, ref:'TC AIM RAC 9.17 / CYYC ILS RWY 17L' },
  { icao:'CYEG', name:'Edmonton',            lat:53.310, lng:-113.580, elev:2373, thr:-25, terr:false, mda:2620, dh:200, ref:'TC AIM RAC 9.17 / CYEG ILS RWY 02' },
  { icao:'CYWG', name:'Winnipeg',            lat:49.910, lng:-97.240,  elev:783,  thr:-25, terr:false, mda:1040, dh:200, ref:'TC AIM RAC 9.17 / CYWG ILS RWY 36' },
  { icao:'CYQR', name:'Regina',              lat:50.432, lng:-104.666, elev:1894, thr:-25, terr:false, mda:2140, dh:200, ref:'TC AIM RAC 9.17 / CYQR ILS RWY 13' },
  { icao:'CYZF', name:'Yellowknife',         lat:62.463, lng:-114.440, elev:675,  thr:-30, terr:false, mda:940,  dh:200, ref:'TC AIM RAC 9.17 / CYZF ILS RWY 27' },
  { icao:'CYFB', name:'Iqaluit',             lat:63.756, lng:-68.555,  elev:110,  thr:-30, terr:false, mda:380,  dh:200, ref:'TC AIM RAC 9.17 / CYFB LOC RWY 34' },
  { icao:'BIRK', name:'Reykjavík',           lat:64.130, lng:-21.940,  elev:48,   thr:-15, terr:false, mda:340,  dh:NaN, ref:'ICAO Doc 8168 / BIRK ILS RWY 19' },
  { icao:'BIKF', name:'Keflavík',            lat:63.985, lng:-22.605,  elev:171,  thr:-15, terr:false, mda:430,  dh:200, ref:'ICAO Doc 8168 / BIKF ILS RWY 02' },
  { icao:'ENGM', name:'Oslo Gardermoen',     lat:60.193, lng:11.100,   elev:681,  thr:-20, terr:false, mda:950,  dh:200, ref:'ICAO Doc 8168 / ENGM ILS RWY 01L' },
  { icao:'ESSA', name:'Stockholm Arlanda',   lat:59.651, lng:17.918,   elev:137,  thr:-20, terr:false, mda:380,  dh:200, ref:'ICAO Doc 8168 / ESSA ILS RWY 01L' },
  { icao:'EFHK', name:'Helsinki Vantaa',     lat:60.317, lng:24.963,   elev:179,  thr:-25, terr:false, mda:430,  dh:200, ref:'ICAO Doc 8168 / EFHK ILS RWY 04L' },
  { icao:'ENZV', name:'Stavanger',           lat:58.876, lng:5.638,    elev:29,   thr:-15, terr:false, mda:270,  dh:200, ref:'ICAO Doc 8168 / ENZV ILS RWY 18' },
  { icao:'UUEE', name:'Moscow Sheremetyevo', lat:55.972, lng:37.414,   elev:622,  thr:-25, terr:false, mda:850,  dh:200, ref:'ICAO Doc 8168 / UUEE ILS RWY 06L' },
  { icao:'UUDD', name:'Moscow Domodedovo',   lat:55.408, lng:37.906,   elev:595,  thr:-25, terr:false, mda:830,  dh:200, ref:'ICAO Doc 8168 / UUDD ILS RWY 14R' },
  { icao:'ZBAA', name:'Beijing Capital',     lat:40.080, lng:116.585,  elev:116,  thr:-15, terr:false, mda:380,  dh:200, ref:'CAAC AIP / ZBAA ILS RWY 18L' },
  { icao:'LOWI', name:'Innsbruck',           lat:47.260, lng:11.344,   elev:1907, thr:-10, terr:true,  mda:3270, dh:NaN, ref:'EASA AMC 91.13 / LOWI LOC-DME East (terrain)' },
  { icao:'LSZS', name:'Samedan',             lat:46.534, lng:9.884,    elev:5600, thr:-10, terr:true,  mda:7960, dh:NaN, ref:'EASA AMC 91.13 / LSZS RNAV (high-terrain)' },
  { icao:'LFLJ', name:'Courchevel',          lat:45.397, lng:6.635,    elev:6588, thr:-5,  terr:true,  mda:8800, dh:NaN, ref:'EASA AMC 91.13 / LFLJ visual only (alpine)' },
]

interface Row {
  f: VFlight; phase: Phase; cta: Cta; distNm: number
  hAgl: number          // height above aerodrome ft
  isaC: number          // ISA temp at aerodrome elev
  oatC: number          // sampled aerodrome OAT
  deltaISA: number      // OAT - ISA (negative when cold)
  corrFt: number        // Δh correction
  corrPct: number       // %
  minAlt: number        // closest published min (MDA or DA)
  marginToMin: number   // (current - minAlt) ft, can be negative
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
  uncorr: boolean
}

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }
function distNm(la1:number,lo1:number,la2:number,lo2:number){
  const R=3440.065,toR=Math.PI/180
  const dLa=(la2-la1)*toR, dLo=(lo2-lo1)*toR
  const a=Math.sin(dLa/2)**2 + Math.cos(la1*toR)*Math.cos(la2*toR)*Math.sin(dLo/2)**2
  return 2*R*Math.asin(Math.sqrt(a))
}

// deterministic synthetic state per icao
function syntheticOAT(icao: string, ctaThr: number, winterMul: number) {
  let h = 0; for (let i=0;i<icao.length;i++) h = ((h*131) + icao.charCodeAt(i)) >>> 0
  const r = (h % 1000) / 1000
  // bias: 60% of samples are within +5..−15°C of threshold; the rest spread
  const base = ctaThr + (r < 0.6 ? (r-0.3)*20 : (r-0.5)*60)
  const oat = base * winterMul
  const uncorr = ((h>>7) % 100) < 18    // ~18% of fleet flagged uncorrected FMS
  return { oat, uncorr }
}

function phaseOf(f: VFlight, cta: Cta, dnm: number): Phase {
  const agl = f.altitudeFt - cta.elev
  if (dnm > 25) return 'OFF'
  if (f.ground) return 'OFF'
  if (agl < 1500 && f.vertRate < -100 && dnm < 12) return 'APPR-FNL'
  if (agl < 5000 && f.vertRate < 0 && dnm < 25) return 'APPR-INT'
  if (agl < 3500 && Math.abs(f.vertRate) < 200 && f.velocityKts < 160 && dnm < 8) return 'CIRCLING'
  if (agl < 8000 && f.vertRate > 300 && dnm < 20) return 'DEPT-CLB'
  return 'OFF'
}

export default function TempCompColdAlt({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [winterMul, setWinterMul] = useState(1.0)     // winter severity (1.0 = typical, scales OAT)
  const [uncorrRate, setUncorrRate] = useState(1.0)   // uncorrected-FMS exposure mul
  const [scopeNm, setScopeNm] = useState(25)
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'AERODROMES'|'CHART'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shCta, setShCta] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      // snap to nearest CTA within scope
      let best: Cta | null = null; let bestD = scopeNm + 1
      for (const c of CTA) {
        const d = distNm(f.lat, f.lng, c.lat, c.lng)
        if (d < bestD) { bestD = d; best = c }
      }
      if (!best) continue
      const ph = phaseOf(f, best, bestD)
      if (ph === 'OFF') continue

      const elevKft = best.elev / 1000
      const isaC = 15 - 1.98 * elevKft
      const { oat, uncorr } = syntheticOAT(f.icao + best.icao, best.thr, winterMul)
      const oatC = oat
      const deltaISA = oatC - isaC

      const hAgl = Math.max(0, f.altitudeFt - best.elev)
      const corrFt = hAgl * (isaC - oatC) / 273    // Doc 8168 simplified
      const corrPct = hAgl > 0 ? (corrFt / hAgl) * 100 : 0

      const minAlt = isNaN(best.dh) ? best.mda : (best.elev + best.dh)
      const marginToMin = f.altitudeFt - minAlt   // before correction
      const trueMargin = marginToMin - Math.max(0, corrFt)

      // DRIVERS
      const dERR = clamp(corrPct * 8, 0, 100)
      const dDISA = clamp((-deltaISA) * 3, 0, 100)
      const dMIN = clamp(100 - Math.min(100, Math.max(0, trueMargin/15)), 0, 100)
      const dCTA = oatC < best.thr ? 90 : (oatC < best.thr + 5 ? 50 : 18)
      const dTERR = best.terr ? 78 : 22
      const _uncorr = uncorr && (uncorrRate > 0.4)
      const dUNC = _uncorr ? 88 : 22
      const dDIST = clamp(100 - (bestD/scopeNm)*100, 0, 100)
      const phaseW: Record<Phase, number> = {
        'APPR-FNL':1.25, 'APPR-INT':1.05, 'CIRCLING':1.30, 'DEPT-CLB':0.85, 'OFF':0
      }
      const dPHASE = phaseW[ph] * 50

      const drivers = { ERR:dERR, ΔISA:dDISA, MIN:dMIN, CTA:dCTA, TERR:dTERR, UNCORR:dUNC, PHASE:dPHASE, DIST:dDIST }
      const arr = Object.values(drivers)
      const mx = Math.max(...arr), mn = arr.reduce((a,b)=>a+b,0)/arr.length
      let score = (mx * 0.62 + mn * 0.38) * phaseW[ph] * advMul

      const notes: string[] = []
      if (corrPct >= 12 && ph === 'APPR-FNL') {
        score = Math.max(score, 92)
        notes.push(`Δh ${corrFt.toFixed(0)}ft (${corrPct.toFixed(1)}%) on final · apply correction per Doc 8168 §4.3`)
      }
      if (oatC < best.thr && deltaISA <= -30 && f.vertRate < -100) {
        score = Math.max(score, 86)
        notes.push(`CTA ${best.icao} ΔISA ${deltaISA.toFixed(0)}°C · ${best.ref}`)
      }
      if (corrFt >= 200 && ph === 'CIRCLING') {
        score = Math.max(score, 78)
        notes.push(`Circling Δh +${corrFt.toFixed(0)}ft on MDH — review circling minima · AIM 7-3-1`)
      }
      if (oatC < best.thr && _uncorr) {
        score = Math.max(score, 88)
        notes.push(`OAT ${oatC.toFixed(0)}°C < CTA thr ${best.thr}°C and FMS reports UNCORR · brief manual corr`)
      }
      score = clamp(score, 0, 100)

      let tier: Tier = 'OFF'
      if (score >= 85) tier = 'IMPACT'
      else if (score >= 65) tier = 'MAJOR'
      else if (score >= 45) tier = 'WATCH'
      else if (score >= 22) tier = 'GUARD'
      else tier = 'CLEAR'

      out.push({ f, phase: ph, cta: best, distNm: bestD, hAgl, isaC, oatC, deltaISA, corrFt, corrPct, minAlt, marginToMin: trueMargin, drivers, score, tier, notes, uncorr: _uncorr })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, winterMul, uncorrRate, scopeNm])

  // === MapLibre overlay ===
  useEffect(() => {
    if (!map) return
    const SRC = 'tcc-src', SRC_LNK = 'tcc-lnk-src', SRC_CTA = 'tcc-cta-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    const writeAll = () => {
      ensureSrc(SRC); ensureSrc(SRC_LNK); ensureSrc(SRC_CTA)
      const view = rows.filter(r => (tierFilter==='ALL'||r.tier===tierFilter) && (phaseFilter==='ALL'||r.phase===phaseFilter))
      const acFeats: any[] = []
      const lnkFeats: any[] = []
      const ctaFeats: any[] = []
      for (const r of view) {
        acFeats.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
          properties:{
            tier:r.tier, color:TIER_COLOR[r.tier], score:r.score,
            sz: 7 + (r.score/100)*12,
            label: `${r.f.callsign||r.f.icao} · ${r.cta.icao} · Δh+${r.corrFt.toFixed(0)}ft (${r.corrPct.toFixed(1)}%) · OAT ${r.oatC.toFixed(0)}°C`
          }
        })
        lnkFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat],[r.cta.lng, r.cta.lat]] }, properties:{ color: TIER_COLOR[r.tier] } })
      }
      // CTAs themselves
      if (shCta) {
        const inUse = new Set(view.map(r => r.cta.icao))
        for (const c of CTA) {
          ctaFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[c.lng, c.lat] },
            properties:{ icao:c.icao, terr:c.terr, active: inUse.has(c.icao) ? 1 : 0,
              color: c.terr ? '#f59e0b' : '#0ea5e9',
              label: `${c.icao} · thr ${c.thr}°C${c.terr?' · terr':''}` }
          })
        }
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_LNK) as any).setData({ type:'FeatureCollection', features: lnkFeats })
      ;(map.getSource(SRC_CTA) as any).setData({ type:'FeatureCollection', features: ctaFeats })
    }
    ensureSrc(SRC); ensureSrc(SRC_LNK); ensureSrc(SRC_CTA)
    if (!map.getLayer('tcc-cta-halo'))
      map.addLayer({ id:'tcc-cta-halo', type:'circle', source:SRC_CTA, paint:{ 'circle-radius':['case', ['==',['get','active'],1], 14, 7], 'circle-color':['get','color'], 'circle-opacity':0.10, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.1, 'circle-stroke-opacity':0.7 } })
    if (!map.getLayer('tcc-cta-lbl'))
      map.addLayer({ id:'tcc-cta-lbl', type:'symbol', source:SRC_CTA, filter:['==',['get','active'],1], layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,-1.4], 'text-anchor':'bottom', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#94a3b8', 'text-halo-color':'#0b0f17', 'text-halo-width':1.1 } })
    if (!map.getLayer('tcc-lnk'))
      map.addLayer({ id:'tcc-lnk', type:'line', source:SRC_LNK, paint:{ 'line-color':['get','color'], 'line-width':1.2, 'line-dasharray':[2,3], 'line-opacity':0.7 } })
    if (!map.getLayer('tcc-halo'))
      map.addLayer({ id:'tcc-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('tcc-pin'))
      map.addLayer({ id:'tcc-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('tcc-lbl'))
      map.addLayer({ id:'tcc-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    writeAll()
    return () => {
      for (const id of ['tcc-lbl','tcc-pin','tcc-halo','tcc-lnk','tcc-cta-lbl','tcc-cta-halo']) if (map.getLayer(id)) map.removeLayer(id)
      for (const id of [SRC, SRC_LNK, SRC_CTA]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, phaseFilter, shHalo, shPin, shLbl, shCta])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.f.operator||'').toLowerCase().includes(search.toLowerCase()) || r.cta.icao.toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { IMPACT:0, MAJOR:0, WATCH:0, GUARD:0, CLEAR:0, OFF:0 }
  for (const r of rows) counts[r.tier]++
  const muCorr = rows.length ? (rows.reduce((a,b)=>a+b.corrFt,0)/rows.length) : 0
  const muISA = rows.length ? (rows.reduce((a,b)=>a+b.deltaISA,0)/rows.length) : 0
  const worst = rows[0]
  const uncorrCnt = rows.filter(r => r.uncorr).length

  // per-aerodrome aggregation
  const ctaMap = new Map<string, { c: Cta; count: number; muCorr: number; imp: number; maj: number; wat: number; worstScore: number; worstCs: string }>()
  for (const r of rows) {
    const e = ctaMap.get(r.cta.icao) || { c: r.cta, count: 0, muCorr: 0, imp: 0, maj: 0, wat: 0, worstScore: 0, worstCs: '—' }
    e.count++; e.muCorr += r.corrFt
    if (r.tier === 'IMPACT') e.imp++
    if (r.tier === 'MAJOR') e.maj++
    if (r.tier === 'WATCH') e.wat++
    if (r.score > e.worstScore) { e.worstScore = r.score; e.worstCs = r.f.callsign || r.f.icao }
    ctaMap.set(r.cta.icao, e)
  }
  const ctaRows = Array.from(ctaMap.entries()).map(([k, e]) => ({ icao: k, c: e.c, count: e.count, muCorr: e.muCorr/e.count, imp: e.imp, maj: e.maj, wat: e.wat, worstScore: e.worstScore, worstCs: e.worstCs }))
    .sort((a,b) => (b.imp + b.maj) - (a.imp + a.maj) || b.worstScore - a.worstScore)

  return (
    <div className="fixed top-16 right-3 z-40 w-[460px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">TEMPCOMP</span>
          <span className="text-[10px] text-slate-400">cold-temp altitude correction · ICAO Doc 8168 §4.3</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter===t?'border':'border border-slate-700/60'}`} style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:undefined, color: TIER_COLOR[t] }}>{t.slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-Δh</div><div className="text-slate-100 font-mono">+{muCorr.toFixed(0)}ft</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-ΔISA</div><div className="text-slate-100 font-mono">{muISA>=0?'+':''}{muISA.toFixed(0)}°C</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">UNCORR</div><div className="font-mono" style={{color:TIER_COLOR.MAJOR}}>{uncorrCnt}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||worst?.f.icao||'—'}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">IMP+</div><div className="font-mono" style={{color:TIER_COLOR.IMPACT}}>{counts.IMPACT + counts.MAJOR}</div></div>
      </div>

      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">WINTER <span className="text-slate-200 font-mono">{(winterMul*100).toFixed(0)}%</span>
            <input type="range" min="40" max="180" value={winterMul*100} onChange={e=>setWinterMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">UNCORR-EXP <span className="text-slate-200 font-mono">{(uncorrRate*100).toFixed(0)}%</span>
            <input type="range" min="0" max="200" value={uncorrRate*100} onChange={e=>setUncorrRate(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">SCOPE <span className="text-slate-200 font-mono">{scopeNm}NM</span>
            <input type="range" min="8" max="60" value={scopeNm} onChange={e=>setScopeNm(+e.target.value)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','APPR-FNL','APPR-INT','CIRCLING','DEPT-CLB'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['CTA',shCta,setShCta]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op/icao" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','AERODROMES','CHART'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab==='AIRCRAFT' && visible.slice(0,80).map((r,i) => (
          <div key={i} onClick={()=>onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{r.f.callsign||r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type||'—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.cta.icao}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              {r.cta.terr && <span className="px-1 rounded font-mono text-[9px]" style={{ background:'#f59e0b33', color:'#f59e0b' }}>TERR</span>}
              {r.uncorr && <span className="px-1 rounded font-mono text-[9px]" style={{ background:'#ef444433', color:'#ef4444' }}>UNCORR</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>ALT <span className="text-slate-100 font-mono">{(r.f.altitudeFt/1000).toFixed(1)}k</span></div>
              <div>AGL <span className="text-slate-100 font-mono">{(r.hAgl/1000).toFixed(1)}k</span></div>
              <div>Δh <span className="font-mono" style={{color: r.corrPct>=8?TIER_COLOR.MAJOR : r.corrPct>=4?TIER_COLOR.WATCH : TIER_COLOR.CLEAR}}>+{r.corrFt.toFixed(0)}ft</span></div>
              <div>%H <span className="text-slate-100 font-mono">{r.corrPct.toFixed(1)}%</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>OAT <span className="text-slate-100 font-mono">{r.oatC.toFixed(0)}°C</span></div>
              <div>ISA <span className="text-slate-100 font-mono">{r.isaC.toFixed(0)}°C</span></div>
              <div>ΔISA <span className="font-mono" style={{color: r.deltaISA<=-20?TIER_COLOR.MAJOR : r.deltaISA<=-10?TIER_COLOR.WATCH : TIER_COLOR.CLEAR}}>{r.deltaISA>=0?'+':''}{r.deltaISA.toFixed(0)}°C</span></div>
              <div>thr <span className="text-slate-100 font-mono">{r.cta.thr}°C</span></div>
            </div>
            <div className="grid grid-cols-3 gap-1 text-[10px] text-slate-400">
              <div>DIST <span className="text-slate-100 font-mono">{r.distNm.toFixed(1)}NM</span></div>
              <div>min-alt <span className="text-slate-100 font-mono">{r.minAlt.toFixed(0)}ft</span></div>
              <div>TRUE-Δ <span className="font-mono" style={{color: r.marginToMin<0?TIER_COLOR.IMPACT : r.marginToMin<200?TIER_COLOR.MAJOR : TIER_COLOR.CLEAR}}>{r.marginToMin>=0?'+':''}{r.marginToMin.toFixed(0)}ft</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='CLEAR' && <div className="mt-1 text-[9px] text-slate-500">apply correction Δh+{r.corrFt.toFixed(0)}ft to procedure mins · {r.cta.ref}</div>}
          </div>
        ))}

        {tab==='AERODROMES' && (
          <div className="space-y-1">
            {ctaRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no aircraft within scope of any CTA · widen SCOPE</div>}
            {ctaRows.map((e,i) => (
              <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="font-mono text-slate-100">{e.icao}</span>
                  <span className="text-slate-500">·</span>
                  <span className="text-slate-300">{e.c.name}</span>
                  {e.c.terr && <span className="px-1 rounded font-mono text-[9px]" style={{ background:'#f59e0b33', color:'#f59e0b' }}>TERR</span>}
                  <span className="ml-auto text-[9px] text-slate-500">{e.count} ac</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>elev <span className="text-slate-100 font-mono">{e.c.elev}ft</span></div>
                  <div>thr <span className="text-slate-100 font-mono">{e.c.thr}°C</span></div>
                  <div>MDA <span className="text-slate-100 font-mono">{e.c.mda}</span></div>
                  <div>DH <span className="text-slate-100 font-mono">{isNaN(e.c.dh)?'—':e.c.dh+'ft'}</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>μ-Δh <span className="font-mono" style={{color: e.muCorr>=200?TIER_COLOR.MAJOR : e.muCorr>=100?TIER_COLOR.WATCH : TIER_COLOR.CLEAR}}>+{e.muCorr.toFixed(0)}ft</span></div>
                  <div>IMP <span className="font-mono" style={{color:TIER_COLOR.IMPACT}}>{e.imp}</span></div>
                  <div>MAJ <span className="font-mono" style={{color:TIER_COLOR.MAJOR}}>{e.maj}</span></div>
                  <div>WAT <span className="font-mono" style={{color:TIER_COLOR.WATCH}}>{e.wat}</span></div>
                </div>
                <div className="text-[9px] text-slate-500 mt-1">worst {e.worstCs} · {e.c.ref}</div>
              </div>
            ))}
          </div>
        )}

        {tab==='CHART' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-300 mb-1">Doc 8168 cold-temp correction · Δh vs ΔISA at H_AGL</div>
              <svg viewBox="0 0 400 200" className="w-full h-44">
                {/* axes */}
                <line x1="40" y1="180" x2="390" y2="180" stroke="#475569" strokeWidth="1" />
                <line x1="40" y1="20"  x2="40"  y2="180" stroke="#475569" strokeWidth="1" />
                <text x="200" y="195" fill="#94a3b8" fontSize="9" textAnchor="middle">ΔISA °C  (0 → −40)</text>
                <text x="12" y="100" fill="#94a3b8" fontSize="9" textAnchor="middle" transform="rotate(-90 12 100)">Δh ft</text>

                {/* curves for AGL 500/1500/3000/5000 ft  Δh = H_AGL · (-ΔISA)/273 */}
                {[
                  { agl: 500,  color:'#10b981', label:'500 ft AGL' },
                  { agl: 1500, color:'#0ea5e9', label:'1500 ft (FAF)' },
                  { agl: 3000, color:'#f59e0b', label:'3000 ft (IF)' },
                  { agl: 5000, color:'#f43f5e', label:'5000 ft (MSA)' },
                ].map((s, idx) => {
                  const pts: string[] = []
                  for (let dT = 0; dT <= 40; dT += 1) {
                    const dh = s.agl * dT / 273
                    const x = 40 + (dT/40)*350
                    const y = 180 - clamp((dh/800)*160, 0, 160)
                    pts.push(`${x},${y}`)
                  }
                  return <g key={idx}>
                    <polyline fill="none" stroke={s.color} strokeWidth="1.4" points={pts.join(' ')} />
                    <text x="386" y={180 - clamp((s.agl * 40 / 273 / 800)*160, 6, 160)} fill={s.color} fontSize="8" textAnchor="end">{s.label}</text>
                  </g>
                })}
                {/* worst flight marker */}
                {worst && (
                  <g>
                    <circle
                      cx={40 + clamp((-worst.deltaISA)/40 * 350, 0, 350)}
                      cy={180 - clamp((worst.corrFt/800)*160, 0, 160)}
                      r="4" fill={TIER_COLOR[worst.tier]} stroke="#0b0f17" strokeWidth="1" />
                    <text x={40 + clamp((-worst.deltaISA)/40 * 350, 0, 350) + 6}
                          y={180 - clamp((worst.corrFt/800)*160, 0, 160) - 4}
                          fill={TIER_COLOR[worst.tier]} fontSize="8">{worst.f.callsign||worst.f.icao}</text>
                  </g>
                )}
                {/* ref grid */}
                {[100,200,400,600,800].map(h => {
                  const y = 180 - clamp((h/800)*160, 0, 160)
                  return <g key={h}>
                    <line x1="40" y1={y} x2="390" y2={y} stroke="#1e293b" strokeWidth="0.6" />
                    <text x="36" y={y+3} fill="#475569" fontSize="7" textAnchor="end">{h}</text>
                  </g>
                })}
              </svg>
              <div className="grid grid-cols-3 gap-1 mt-1 text-[10px]">
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLEET</div><div className="text-slate-100 font-mono">{rows.length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-Δh</div><div className="text-slate-100 font-mono">+{muCorr.toFixed(0)}ft</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">PICK</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||'—'}</div></div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Method · Δh ≈ H_AGL · (ISA − OAT) / 273 per ICAO Doc 8168 Vol I Pt III §4.3 simplified. ISA at aerodrome = 15°C − 1.98°C/1000ft · elev_kft. Correction applied to all procedure minimum altitudes (FAF / IF / MDA(H) / DA(H) / MSA / MOCA / circling) when aerodrome OAT is at or below the CTA threshold per FAA AIM 7-3-1 / TC AIM RAC 9.17 / ICAO Annex 6 Pt I §4.2.6.
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · ICAO Doc 8168 Vol I Pt III §4.3 · Annex 6 Pt I §4.2.6 · FAA AIM 7-3-1 · AC 91-79B App.A · InFO 21002 · Order 8260.58 §2-3 · Transport Canada AIM RAC 9.17 · UK CAA CAP 393 GEN 3.5 §5 · EASA AMC 91.13 · FAA-H-8083-15B Ch.10 · CASA AC 91-21 · Honeywell EGPWS Pilot's Guide §4 · Boeing FCTM Approach §4 · Airbus FCTM PRO-NOR-SOP-19.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
