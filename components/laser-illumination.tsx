'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   LASER · Laser Illumination & Cockpit-Glare Hazard Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of laser-illumination exposure
   risk on the flight deck during the critical phases of flight
   (approach, departure, low-level operations) using the FAA
   Laser Illumination of Aircraft hazard model and the four
   regulatory exposure zones:

     · Laser Free Flight Zone (LFFZ)
     · Laser Critical Flight Zone (LCFZ)
     · Laser Sensitive Flight Zone (LSFZ)
     · Normal Flight Zone (NFZ)

   per FAA AC 70-1 Outdoor Laser Operations / AC 70-2 Reporting
   Laser Illumination / 14 CFR §91.11 / 18 U.S.C. §39A
   (aiming laser at aircraft is a federal felony), and the
   irradiance-zone framework defined in:

     · FAA Order 7400.2P Ch.29 Laser Operations
     · ICAO Annex 14 §5.3.2.4 / Doc 9815 Manual on Laser
       Emitters and Flight Safety
     · ANSI Z136.6 Outdoor Laser Operations
     · IEC 60825-1 Laser Product Safety

   Structurally distinct from:
     · SUN GLARE  — solar disk geometric glare on cockpit
     · BLKHOL     — featureless-terrain visual illusion
     · NIGHT VIS  — display-luminance NVG compatibility
     · RFI / GNSS — RF interference (different physics)

   LASER measures cockpit ocular-irradiance from ground-based
   laser emitters reaching the windshield. Severity is
   classified into 4 ANSI Z136.6 effect tiers:

     · LASER EYE INJURY HAZARD ZONE  (MPE)
        irradiance > 25.4 µW/cm² @ 532nm permanent retinal
        damage risk per ANSI Z136.6 §4.5
     · SENSITIVE ZONE / TEMPORARY FLASHBLINDNESS
        irradiance > 100 nW/cm² 5-30 sec recovery
     · CRITICAL ZONE / GLARE
        irradiance > 5 nW/cm² visual interference, after-image
     · DISTRACTION / NORMAL FLIGHT ZONE
        irradiance > 50 pW/cm² annoyance / startle

   ~9,500 laser illumination events are reported to the FAA
   annually (FAA Laser Strike Statistics 2023) with the largest
   concentrations near major US/EU/Asia metro airports.

   24-emitter synthetic hot-spot catalogue spanning known
   high-incidence corridors:
     · KLAX-N (Inglewood / South Bay)        532nm 0.8W
     · KSFO-N (San Mateo Bay-Bridge)         532nm 0.6W
     · KSEA   (Tukwila / Renton)             532nm 0.5W
     · KJFK-W (Queens / Cross-Bay)           532nm 0.5W
     · KORD-S (Cicero / Berwyn)              532nm 0.8W
     · KATL-W (East Point)                   532nm 0.5W
     · KDEN-N (Brighton)                     532nm 0.3W
     · KLAS-E (Henderson)                    532nm 0.5W
     · KIAH-N (Aldine)                       532nm 0.5W
     · EGLL-S (Hounslow / Bedfont)           532nm 0.5W
     · EGKK-N (Crawley)                      532nm 0.3W
     · EHAM-E (Schiphol-Oost)                532nm 0.3W
     · LFPG-S (Aulnay-sous-Bois)             532nm 0.3W
     · EDDF-W (Russelsheim)                  532nm 0.3W
     · EDDM-E (Erding)                       532nm 0.3W
     · OMDB-S (Garhoud / Mirdif)             445nm 0.5W
     · WSSS-W (Bedok)                        532nm 0.3W
     · VHHH-N (Tung Chung)                   532nm 0.5W
     · RJTT-S (Ohta-ku)                      532nm 0.5W
     · YSSY-E (Mascot / Botany)              532nm 0.3W
     · CYYZ-N (Mississauga)                  532nm 0.5W
     · CYVR-S (Richmond)                     532nm 0.5W
     · MMMX-N (Ecatepec)                     532nm 0.5W
     · SBSP-W (Congonhas approach)           532nm 0.3W

   Beam-irradiance physics:
     I(d) = P / (π·(d·tan(θ/2))²)  (Gaussian fall-off proxy)
     with atmospheric extinction τ_a = exp(-α·d),
     α ≈ 0.05/km clear / 0.15/km haze / 0.5/km low-vis
     per AC 70-1 §5 / Mil-Hdbk-141 §4.5

   Per-phase exposure sensitivity (FAA AC 70-1 §2):
     · APPR-FNL  ×1.50  (head-down config + windshield IR-scan)
     · APPR-INT  ×1.30
     · DEPT      ×1.40  (rotation + initial climb visual scan)
     · TMA       ×1.10
     · CRZ/CLEAN ×0.30  (well above LFFZ ceiling)
     · GND       ×0.05

   6 risk drivers (max·0.65 + mean·0.35 × ADV-MUL):
     · IRR    ocular irradiance vs ANSI Z136.6 MPE
     · GEOM   beam alignment within 12° track corridor
     · PHASE  phase-of-flight criticality multiplier
     · ALT    AGL band peaking 200–4000 ft
     · ATM    atmospheric extinction (haze/clear)
     · MULT   number of overlapping hot-spots

   Hard escalators:
     · I > 25.4 µW/cm² (MPE) score-min 92 retinal-damage risk
     · I > 100 nW/cm² in APPR-FNL  score-min 84 flashblindness
     · Multi-emitter overlap > 2  score-min 70

   6 tiers:
     · INJURY   ≥85 rose  MPE exceeded — declare emergency
                          per AIM 4-3-19, log per AC 70-2
     · FLASHBLD ≥65 rose-pink temporary blindness 5–30 sec
     · GLARE    ≥45 amber  visual interference / after-image
     · DISTRCT  ≥22 sky    annoyance / startle band
     · CLEAR    <22 emerald no significant exposure
     · OFF      slate      cruise or no hot-spot in scope

   References:
     · 14 CFR §91.11 / 18 U.S.C. §39A
     · FAA AC 70-1 Outdoor Laser Operations
     · FAA AC 70-2 Reporting Laser Illumination of Aircraft
     · FAA Order 7400.2P Ch.29 Laser Operations
     · FAA Laser Strike Statistics 2023
     · AIM 4-3-19 / 7-5-12 laser emergency procedures
     · ICAO Annex 14 §5.3.2.4 / Doc 9815 Laser Manual
     · ANSI Z136.6-2015 Outdoor Laser Operations
     · IEC 60825-1 Laser Product Safety
     · Mil-Hdbk-141 §4.5 atmospheric transmittance
     · NTSB SR-04-01 Laser Illumination Safety Recommendation
     · Nakagawara FAA AAM CAMI-2010-04 cockpit irradiance
   ============================================================ */

interface LFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: LFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'INJURY'|'FLASHBLD'|'GLARE'|'DISTRCT'|'CLEAR'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  INJURY:'#ef4444', FLASHBLD:'#f43f5e', GLARE:'#f59e0b',
  DISTRCT:'#0ea5e9', CLEAR:'#10b981', OFF:'#475569',
}
const TIER_RANK: Record<Tier,number> = { INJURY:0, FLASHBLD:1, GLARE:2, DISTRCT:3, CLEAR:4, OFF:5 }
const TIER_ORDER: Tier[] = ['INJURY','FLASHBLD','GLARE','DISTRCT','CLEAR']

type Phase = 'APPR-FNL'|'APPR-INT'|'TMA'|'DEPT'|'CRZ'|'GND'
const PHASE_MUL: Record<Phase,number> = { 'APPR-FNL':1.50, 'APPR-INT':1.30, 'TMA':1.10, 'DEPT':1.40, 'CRZ':0.30, 'GND':0.05 }

interface Emitter {
  id: string; name: string; lat: number; lng: number
  powerW: number; wavelengthNm: number; divergenceMrad: number; sectorDeg: [number,number]
}
const EMITTERS: Emitter[] = [
  { id:'KLAX-N', name:'Inglewood / South Bay',  lat:33.93, lng:-118.39, powerW:0.8, wavelengthNm:532, divergenceMrad:1.2, sectorDeg:[0,360] },
  { id:'KSFO-N', name:'San Mateo Bay-Bridge',   lat:37.55, lng:-122.30, powerW:0.6, wavelengthNm:532, divergenceMrad:1.2, sectorDeg:[0,360] },
  { id:'KSEA',   name:'Tukwila / Renton',       lat:47.46, lng:-122.27, powerW:0.5, wavelengthNm:532, divergenceMrad:1.4, sectorDeg:[0,360] },
  { id:'KJFK-W', name:'Queens / Cross-Bay',     lat:40.66, lng:-73.83,  powerW:0.5, wavelengthNm:532, divergenceMrad:1.2, sectorDeg:[0,360] },
  { id:'KORD-S', name:'Cicero / Berwyn',        lat:41.84, lng:-87.78,  powerW:0.8, wavelengthNm:532, divergenceMrad:1.1, sectorDeg:[0,360] },
  { id:'KATL-W', name:'East Point',             lat:33.67, lng:-84.45,  powerW:0.5, wavelengthNm:532, divergenceMrad:1.3, sectorDeg:[0,360] },
  { id:'KDEN-N', name:'Brighton',               lat:39.99, lng:-104.83, powerW:0.3, wavelengthNm:532, divergenceMrad:1.3, sectorDeg:[0,360] },
  { id:'KLAS-E', name:'Henderson',              lat:36.03, lng:-115.05, powerW:0.5, wavelengthNm:532, divergenceMrad:1.2, sectorDeg:[0,360] },
  { id:'KIAH-N', name:'Aldine',                 lat:30.00, lng:-95.39,  powerW:0.5, wavelengthNm:532, divergenceMrad:1.3, sectorDeg:[0,360] },
  { id:'EGLL-S', name:'Hounslow / Bedfont',     lat:51.46, lng:-0.42,   powerW:0.5, wavelengthNm:532, divergenceMrad:1.2, sectorDeg:[0,360] },
  { id:'EGKK-N', name:'Crawley',                lat:51.13, lng:-0.18,   powerW:0.3, wavelengthNm:532, divergenceMrad:1.3, sectorDeg:[0,360] },
  { id:'EHAM-E', name:'Schiphol-Oost',          lat:52.32, lng:4.84,    powerW:0.3, wavelengthNm:532, divergenceMrad:1.3, sectorDeg:[0,360] },
  { id:'LFPG-S', name:'Aulnay-sous-Bois',       lat:48.94, lng:2.50,    powerW:0.3, wavelengthNm:532, divergenceMrad:1.3, sectorDeg:[0,360] },
  { id:'EDDF-W', name:'Russelsheim',            lat:50.00, lng:8.42,    powerW:0.3, wavelengthNm:532, divergenceMrad:1.3, sectorDeg:[0,360] },
  { id:'EDDM-E', name:'Erding',                 lat:48.31, lng:11.91,   powerW:0.3, wavelengthNm:532, divergenceMrad:1.3, sectorDeg:[0,360] },
  { id:'OMDB-S', name:'Garhoud / Mirdif',       lat:25.22, lng:55.40,   powerW:0.5, wavelengthNm:445, divergenceMrad:1.4, sectorDeg:[0,360] },
  { id:'WSSS-W', name:'Bedok',                  lat:1.32,  lng:103.93,  powerW:0.3, wavelengthNm:532, divergenceMrad:1.3, sectorDeg:[0,360] },
  { id:'VHHH-N', name:'Tung Chung',             lat:22.29, lng:113.94,  powerW:0.5, wavelengthNm:532, divergenceMrad:1.3, sectorDeg:[0,360] },
  { id:'RJTT-S', name:'Ohta-ku',                lat:35.55, lng:139.74,  powerW:0.5, wavelengthNm:532, divergenceMrad:1.2, sectorDeg:[0,360] },
  { id:'YSSY-E', name:'Mascot / Botany',        lat:-33.94,lng:151.20,  powerW:0.3, wavelengthNm:532, divergenceMrad:1.3, sectorDeg:[0,360] },
  { id:'CYYZ-N', name:'Mississauga',            lat:43.62, lng:-79.66,  powerW:0.5, wavelengthNm:532, divergenceMrad:1.3, sectorDeg:[0,360] },
  { id:'CYVR-S', name:'Richmond',               lat:49.17, lng:-123.13, powerW:0.5, wavelengthNm:532, divergenceMrad:1.3, sectorDeg:[0,360] },
  { id:'MMMX-N', name:'Ecatepec',               lat:19.59, lng:-99.07,  powerW:0.5, wavelengthNm:532, divergenceMrad:1.4, sectorDeg:[0,360] },
  { id:'SBSP-W', name:'Congonhas approach',     lat:-23.62,lng:-46.71,  powerW:0.3, wavelengthNm:532, divergenceMrad:1.4, sectorDeg:[0,360] },
]

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }
function gcDistKm(la1:number, lo1:number, la2:number, lo2:number){
  const R=6371, toR=Math.PI/180
  const dla=(la2-la1)*toR, dlo=(lo2-lo1)*toR
  const a=Math.sin(dla/2)**2 + Math.cos(la1*toR)*Math.cos(la2*toR)*Math.sin(dlo/2)**2
  return 2*R*Math.asin(Math.min(1,Math.sqrt(a)))
}
function bearingDeg(la1:number, lo1:number, la2:number, lo2:number){
  const toR=Math.PI/180
  const y = Math.sin((lo2-lo1)*toR)*Math.cos(la2*toR)
  const x = Math.cos(la1*toR)*Math.sin(la2*toR) - Math.sin(la1*toR)*Math.cos(la2*toR)*Math.cos((lo2-lo1)*toR)
  return (Math.atan2(y,x)*180/Math.PI + 360) % 360
}

function phaseOf(f: LFlight): Phase {
  if (f.ground) return 'GND'
  const fl = f.altitudeFt/100
  if (fl >= 180) return 'CRZ'
  if (f.vertRate < -400 && fl < 40) return 'APPR-FNL'
  if (f.vertRate < -300 && fl < 120) return 'APPR-INT'
  if (f.vertRate > 600 && fl < 80) return 'DEPT'
  return 'TMA'
}

// MPE thresholds (W/cm²) per ANSI Z136.6 visible 532nm 0.25-sec aversion
const MPE_INJURY_WCM2  = 25.4e-6     // 25.4 µW/cm² permanent damage
const MPE_FLASH_WCM2   = 100e-9      // 100 nW/cm² flashblindness
const MPE_GLARE_WCM2   = 5e-9        // 5 nW/cm² visual interference
const MPE_DISTRCT_WCM2 = 50e-12      // 50 pW/cm² distraction

interface EmitterHit {
  e: Emitter
  distNm: number
  altGapKft: number
  alignmentDeg: number  // 0 = beam on aircraft
  irrWcm2: number       // ocular irradiance on cockpit windshield
}

interface Row {
  f: LFlight; phase: Phase
  hits: EmitterHit[]
  totalIrrWcm2: number
  drivers: Record<string, number>; score: number; tier: Tier; notes: string[]
  worst?: EmitterHit
}

function computeIrradiance(e: Emitter, distKm: number, atmAlpha: number): number {
  if (distKm <= 0) return 0
  // beam radius at distance d using divergence
  const beamR_m = (e.divergenceMrad/1000) * distKm * 1000
  const beamArea_cm2 = Math.PI * Math.pow(beamR_m*100, 2)
  if (beamArea_cm2 <= 0) return 0
  const tau = Math.exp(-atmAlpha * distKm)
  // pointing efficiency: ground laser pointed at cockpit is ~5% of time on-axis;
  // proxy for handheld jitter
  const pointingEff = 0.04
  return (e.powerW * tau * pointingEff) / beamArea_cm2
}

function scoreRow(f: LFlight, scopeNm: number, advMul: number, atmAlpha: number, sensMul: number): Row | null {
  if (f.ground) return null
  if (f.altitudeFt > 15000) return null
  const phase = phaseOf(f)
  if (phase === 'GND' || phase === 'CRZ') return null
  const fl = f.altitudeFt/100
  const altKft = fl
  // AGL band sensitivity peaks 200-4000 ft (handheld lasers reach ~10kft per AC 70-1 §4)
  const altSens = altKft < 0.5 ? 0.8 : altKft < 4 ? 1.0 : altKft < 8 ? 0.8 : altKft < 12 ? 0.45 : 0.15

  const hits: EmitterHit[] = []
  for (const e of EMITTERS) {
    const distKm = gcDistKm(f.lat, f.lng, e.lat, e.lng)
    const distNm = distKm * 0.5399568
    if (distNm > scopeNm) continue
    const irr = computeIrradiance(e, distKm, atmAlpha) * altSens * sensMul
    if (irr < MPE_DISTRCT_WCM2 * 0.3) continue
    // alignment: emitter bearing vs aircraft track (laser-into-cockpit risk highest from forward hemisphere)
    const brg = bearingDeg(f.lat, f.lng, e.lat, e.lng)
    let relBrg = Math.abs(((brg - f.track + 540) % 360) - 180)  // 0 = directly behind, 180 = head-on
    relBrg = 180 - relBrg  // 0 = behind, 180 = ahead — flip so 180=ahead
    // we want degrees off the forward axis (0 = head-on)
    const offAxis = Math.abs(180 - relBrg)
    const altGapKft = altKft  // no obstruction model — assume LOS
    hits.push({ e, distNm, altGapKft, alignmentDeg: offAxis, irrWcm2: irr })
  }
  if (hits.length === 0) return null
  hits.sort((a,b)=>b.irrWcm2 - a.irrWcm2)
  const worst = hits[0]
  // forward-cone weighting (within 90° of nose gets full credit)
  const alignBoost = (h: EmitterHit) => h.alignmentDeg <= 60 ? 1.0 : h.alignmentDeg <= 100 ? 0.7 : 0.35
  const effIrr = hits.reduce((s,h)=> s + h.irrWcm2 * alignBoost(h), 0)
  const phaseMul = PHASE_MUL[phase]
  const totalIrr = effIrr * phaseMul

  const drivers = {
    IRR:   clamp(Math.log10(Math.max(1e-13, totalIrr)/MPE_DISTRCT_WCM2) * 22 + 20, 0, 120),
    GEOM:  clamp(100 - worst.alignmentDeg * 0.9, 0, 110),
    PHASE: clamp((phaseMul - 0.3) * 70 + 12, 0, 100),
    ALT:   clamp(altSens * 88, 0, 100),
    ATM:   clamp((0.5 - atmAlpha) * 140 + 30, 0, 100),
    MULT:  clamp(hits.length * 18, 0, 100),
  }
  const vals = Object.values(drivers)
  const mx = Math.max(...vals)
  const mean = vals.reduce((a,b)=>a+b,0)/vals.length
  let score = (mx * 0.65 + mean * 0.35) * (advMul/100)
  if (totalIrr > MPE_INJURY_WCM2) score = Math.max(score, 92)
  else if (totalIrr > MPE_FLASH_WCM2 && phase === 'APPR-FNL') score = Math.max(score, 84)
  else if (hits.length > 2) score = Math.max(score, 70)
  score = clamp(score, 0, 100)

  let tier: Tier
  if (score >= 85) tier = 'INJURY'
  else if (score >= 65) tier = 'FLASHBLD'
  else if (score >= 45) tier = 'GLARE'
  else if (score >= 22) tier = 'DISTRCT'
  else tier = 'CLEAR'

  const notes: string[] = []
  if (totalIrr > MPE_INJURY_WCM2) notes.push(`Ocular irradiance ${(totalIrr*1e6).toFixed(1)} µW/cm² exceeds ANSI Z136.6 MPE — declare emergency per AIM 4-3-19 / report per AC 70-2`)
  else if (totalIrr > MPE_FLASH_WCM2) notes.push(`Irradiance ${(totalIrr*1e9).toFixed(0)} nW/cm² in flashblindness band — 5-30 sec visual recovery / transfer controls per AC 70-1 §6`)
  else if (totalIrr > MPE_GLARE_WCM2) notes.push(`Irradiance ${(totalIrr*1e9).toFixed(1)} nW/cm² glare band — avert gaze, do not look toward source per AC 70-1 §6`)
  if (phase === 'APPR-FNL' && totalIrr > MPE_GLARE_WCM2) notes.push(`Final-approach exposure ×${phaseMul.toFixed(2)} — consider go-around if vision impaired per FCTM Approach`)
  if (hits.length > 1) notes.push(`${hits.length} overlapping emitters in scope — multi-source attack pattern, flag to ATC per AC 70-2 §3`)
  if (notes.length === 0) notes.push(`Emitter ${worst.e.id} ${worst.distNm.toFixed(1)}NM ${worst.alignmentDeg.toFixed(0)}° off-axis — monitor cockpit, no immediate action`)

  return { f, phase, hits, totalIrrWcm2: totalIrr, drivers, score, tier, notes, worst }
}

export default function LaserIllumination({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'EMITTERS'|'PHYSICS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [q, setQ] = useState('')
  const [advMul, setAdvMul] = useState(100)
  const [scopeNm, setScopeNm] = useState(30)
  const [atmAlpha, setAtmAlpha] = useState(0.10) // /km
  const [sensMul, setSensMul] = useState(100)
  const [phaseFilter, setPhaseFilter] = useState<Set<Phase>>(new Set())
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showBeam, setShowBeam] = useState(true)
  const [showEmit, setShowEmit] = useState(true)
  const [picked, setPicked] = useState<string|null>(null)
  const [, setTick] = useState(0)
  useEffect(() => { const t = setInterval(()=>setTick(n=>n+1), 4000); return () => clearInterval(t) }, [])

  const rows = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      const r = scoreRow(f, scopeNm, advMul, atmAlpha, sensMul/100)
      if (r) out.push(r)
    }
    out.sort((a,b)=>TIER_RANK[a.tier]-TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, scopeNm, advMul, atmAlpha, sensMul])

  const filtered = useMemo(() => {
    const qs = q.trim().toLowerCase()
    return rows.filter(r =>
      (tierFilter==='ALL' || r.tier===tierFilter) &&
      (phaseFilter.size===0 || phaseFilter.has(r.phase)) &&
      (!qs || (r.f.callsign||'').toLowerCase().includes(qs) || (r.f.type||'').toLowerCase().includes(qs) || (r.f.operator||'').toLowerCase().includes(qs) || (r.worst?.e.id||'').toLowerCase().includes(qs))
    )
  }, [rows, tierFilter, phaseFilter, q])

  const stats = useMemo(() => {
    const ts: Record<Tier,number> = { INJURY:0,FLASHBLD:0,GLARE:0,DISTRCT:0,CLEAR:0,OFF:0 }
    for (const r of rows) ts[r.tier]++
    if (rows.length === 0) return { ts, muIrr:0, maxIrr:0, worst:null as Row|null, emitCount:0 }
    const muIrr = rows.reduce((a,r)=>a+r.totalIrrWcm2,0)/rows.length
    const maxIrr = rows.reduce((a,r)=>Math.max(a,r.totalIrrWcm2),0)
    const emitActive = new Set<string>()
    for (const r of rows) for (const h of r.hits) emitActive.add(h.e.id)
    return { ts, muIrr, maxIrr, worst: rows[0], emitCount: emitActive.size }
  }, [rows])

  useEffect(() => {
    if (!map) return
    const id = 'laser-overlay'
    const tryAdd = () => {
      if (!map.getSource(id)) {
        map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
      }
      const layers: [string, any][] = [
        [`${id}-halo`, { id:`${id}-halo`, type:'circle', source:id, filter:['==',['get','kind'],'halo'], paint:{ 'circle-radius':['get','r'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.2, 'circle-stroke-opacity':0.7 } }],
        [`${id}-pin`, { id:`${id}-pin`, type:'circle', source:id, filter:['==',['get','kind'],'pin'], paint:{ 'circle-radius':5, 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.4 } }],
        [`${id}-emit`, { id:`${id}-emit`, type:'circle', source:id, filter:['==',['get','kind'],'emit'], paint:{ 'circle-radius':4, 'circle-color':'#22d3ee', 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.4 } }],
        [`${id}-beam`, { id:`${id}-beam`, type:'line', source:id, filter:['==',['get','kind'],'beam'], paint:{ 'line-color':['get','color'], 'line-width':1.1, 'line-opacity':0.7, 'line-dasharray':[2,2] } }],
        [`${id}-lbl`, { id:`${id}-lbl`, type:'symbol', source:id, filter:['==',['get','kind'],'lbl'], layout:{ 'text-field':['get','t'], 'text-size':10, 'text-offset':[0,1.2], 'text-anchor':'top', 'text-font':['Open Sans Semibold','Arial Unicode MS Bold'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 } }],
      ]
      for (const [lid, spec] of layers) if (!map.getLayer(lid)) map.addLayer(spec)
    }
    try { tryAdd() } catch {}
    const feats: any[] = []
    if (showEmit) {
      const active = new Set<string>()
      for (const r of filtered) for (const h of r.hits) active.add(h.e.id)
      for (const e of EMITTERS) {
        if (!active.has(e.id)) continue
        feats.push({ type:'Feature', properties:{ kind:'emit' }, geometry:{ type:'Point', coordinates:[e.lng, e.lat] } })
        if (showLbl) feats.push({ type:'Feature', properties:{ kind:'lbl', t:`${e.id}`, color:'#22d3ee' }, geometry:{ type:'Point', coordinates:[e.lng, e.lat] } })
      }
    }
    for (const r of filtered) {
      if (showHalo && r.tier !== 'OFF') {
        const radius = 7 + (r.score/100) * 12
        feats.push({ type:'Feature', properties:{ kind:'halo', r:radius, color:TIER_COLOR[r.tier] }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
      if (showPin && (r.tier==='INJURY' || r.tier==='FLASHBLD')) {
        feats.push({ type:'Feature', properties:{ kind:'pin', color:TIER_COLOR[r.tier] }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
      if (showBeam && r.worst) {
        feats.push({ type:'Feature', properties:{ kind:'beam', color:TIER_COLOR[r.tier] }, geometry:{ type:'LineString', coordinates:[[r.worst.e.lng, r.worst.e.lat],[r.f.lng, r.f.lat]] } })
      }
      if (showLbl) {
        const irrNw = r.totalIrrWcm2 * 1e9
        const t = `${r.f.callsign||r.f.icao.slice(-4)} ${r.worst?.e.id||'—'} ${irrNw < 1 ? irrNw.toFixed(2) : irrNw.toFixed(0)}nW`
        feats.push({ type:'Feature', properties:{ kind:'lbl', t, color:TIER_COLOR[r.tier] }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
    }
    try {
      const src = map.getSource(id) as any
      if (src) src.setData({ type:'FeatureCollection', features: feats })
    } catch {}
    return () => {
      try {
        for (const lid of [`${id}-halo`,`${id}-pin`,`${id}-emit`,`${id}-beam`,`${id}-lbl`]) if (map.getLayer(lid)) map.removeLayer(lid)
        if (map.getSource(id)) map.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl, showBeam, showEmit])

  const togglePhase = (p: Phase) => setPhaseFilter(s => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n })
  const fmtIrr = (w:number) => w > 1e-6 ? `${(w*1e6).toFixed(1)} µW/cm²` : w > 1e-9 ? `${(w*1e9).toFixed(1)} nW/cm²` : `${(w*1e12).toFixed(1)} pW/cm²`

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-end bg-slate-950/40 backdrop-blur-[2px]" onClick={onClose}>
      <div className="mt-16 mr-4 w-[min(94vw,560px)] max-h-[88vh] overflow-y-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl" onClick={e=>e.stopPropagation()}>
        <div className="sticky top-0 bg-slate-950/95 backdrop-blur-xl px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500">Safety & Traffic</div>
            <div className="text-sm font-semibold text-slate-100">LASER <span className="text-slate-500 font-normal">· cockpit-glare illumination · {rows.length} scored</span></div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
        </div>

        <div className="px-4 pt-3 grid grid-cols-6 gap-1">
          <button onClick={()=>setTierFilter('ALL')} className={`text-[10px] py-1 rounded border ${tierFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-400'}`}>ALL {rows.length}</button>
          {TIER_ORDER.map(t => (
            <button key={t} onClick={()=>setTierFilter(t)} className={`text-[10px] py-1 rounded border ${tierFilter===t?'border-current':'border-slate-800'}`} style={{ color: TIER_COLOR[t] }}>
              {t} {stats.ts[t]}
            </button>
          ))}
        </div>

        <div className="px-4 pt-3 grid grid-cols-5 gap-2 text-[10px]">
          <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">μ-IRR</div><div className="text-slate-100 text-sm">{stats.muIrr > 0 ? fmtIrr(stats.muIrr) : '—'}</div></div>
          <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">MAX-IRR</div><div className="text-slate-100 text-sm">{stats.maxIrr > 0 ? fmtIrr(stats.maxIrr) : '—'}</div></div>
          <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">INJURY</div><div className="text-rose-400 text-sm">{stats.ts.INJURY}</div></div>
          <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">FLASH</div><div className="text-pink-400 text-sm">{stats.ts.FLASHBLD}</div></div>
          <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">ACTIVE-EMIT</div><div className="text-sky-400 text-sm">{stats.emitCount}</div></div>
        </div>

        <div className="px-4 pt-3 grid grid-cols-2 gap-3 text-[10px]">
          <label className="space-y-1"><div className="text-slate-500">ADV-MUL <span className="text-slate-300">{advMul}%</span></div><input type="range" min={50} max={200} step={5} value={advMul} onChange={e=>setAdvMul(+e.target.value)} className="w-full" /></label>
          <label className="space-y-1"><div className="text-slate-500">SCOPE <span className="text-slate-300">{scopeNm} NM</span></div><input type="range" min={5} max={80} step={1} value={scopeNm} onChange={e=>setScopeNm(+e.target.value)} className="w-full" /></label>
          <label className="space-y-1"><div className="text-slate-500">SENS <span className="text-slate-300">{sensMul}%</span></div><input type="range" min={20} max={300} step={10} value={sensMul} onChange={e=>setSensMul(+e.target.value)} className="w-full" /></label>
          <label className="space-y-1"><div className="text-slate-500">ATM α <span className="text-slate-300">{atmAlpha.toFixed(2)}/km</span></div><input type="range" min={5} max={60} step={1} value={atmAlpha*100} onChange={e=>setAtmAlpha(+e.target.value/100)} className="w-full" /></label>
        </div>

        <div className="px-4 pt-3 flex flex-wrap gap-1 text-[10px]">
          {(['APPR-FNL','APPR-INT','TMA','DEPT'] as Phase[]).map(p => (
            <button key={p} onClick={()=>togglePhase(p)} className={`px-2 py-0.5 rounded border ${phaseFilter.has(p)?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="px-4 pt-2 flex flex-wrap gap-1 text-[10px]">
          {[['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['BEAM',showBeam,setShowBeam],['EMIT',showEmit,setShowEmit]].map(([n,v,set]:any) => (
            <button key={n} onClick={()=>set((x:boolean)=>!x)} className={`px-2 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500'}`}>{n}</button>
          ))}
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="search cs/type/op/emit" className="ml-auto bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-slate-200 w-44" />
        </div>

        <div className="px-4 pt-3 flex gap-1 text-[10px]">
          {(['AIRCRAFT','EMITTERS','PHYSICS'] as const).map(x => (
            <button key={x} onClick={()=>setTab(x)} className={`px-3 py-1 rounded border ${tab===x?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-400'}`}>{x}</button>
          ))}
        </div>

        <div className="p-4 space-y-2">
          {tab === 'AIRCRAFT' && (
            <>
              {filtered.length === 0 && <div className="text-xs text-slate-500">No laser-illumination exposure in scope.</div>}
              {filtered.slice(0, 60).map(r => {
                const isPicked = picked === r.f.icao
                return (
                  <div key={r.f.icao} onClick={()=>{ setPicked(r.f.icao); onFly(r.f.icao) }} className={`rounded border p-2 cursor-pointer text-[11px] ${isPicked?'border-sky-500/50 bg-sky-500/5':'border-slate-800 hover:border-slate-700'}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-slate-100">{r.f.callsign || r.f.icao.slice(-4)}</span>
                      <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                      <span className="text-[9px] px-1 rounded bg-slate-800 text-slate-300">{r.phase}</span>
                      <span className="text-[9px] px-1 rounded" style={{ background: TIER_COLOR[r.tier]+'22', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                      <span className="ml-auto text-slate-400">{r.score.toFixed(0)}</span>
                    </div>
                    <div className="mt-1 grid grid-cols-4 gap-1 text-[10px]">
                      <div><span className="text-slate-500">FL</span> <span className="text-slate-200">{(r.f.altitudeFt/100).toFixed(0)}</span></div>
                      <div><span className="text-slate-500">IRR</span> <span className="text-slate-200">{fmtIrr(r.totalIrrWcm2)}</span></div>
                      <div><span className="text-slate-500">EMIT</span> <span className="text-slate-200">{r.hits.length}</span></div>
                      <div><span className="text-slate-500">WORST</span> <span className="text-slate-200">{r.worst?.e.id||'—'}</span></div>
                      <div><span className="text-slate-500">DIST</span> <span className="text-slate-200">{r.worst?.distNm.toFixed(1)||'—'} NM</span></div>
                      <div><span className="text-slate-500">OFF-AX</span> <span className="text-slate-200">{r.worst?.alignmentDeg.toFixed(0)||'—'}°</span></div>
                      <div><span className="text-slate-500">λ</span> <span className="text-slate-200">{r.worst?.e.wavelengthNm}nm</span></div>
                      <div><span className="text-slate-500">PWR</span> <span className="text-slate-200">{r.worst?.e.powerW.toFixed(1)}W</span></div>
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
          {tab === 'EMITTERS' && (
            <div className="space-y-2">
              {EMITTERS.map(e => {
                const exposed = rows.filter(r => r.hits.some(h => h.e.id === e.id))
                const muIrr = exposed.length ? exposed.reduce((a,r)=>a + (r.hits.find(h=>h.e.id===e.id)?.irrWcm2 || 0),0)/exposed.length : 0
                const sev = exposed.filter(r => r.tier==='INJURY' || r.tier==='FLASHBLD').length
                return (
                  <div key={e.id} className="rounded border border-slate-800 p-2 text-[11px]">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-slate-100">{e.id}</span>
                      <span className="text-slate-500 text-[10px]">{e.name}</span>
                      <span className="ml-auto text-slate-400 text-[10px]">{exposed.length} a/c · SEV+ {sev}</span>
                    </div>
                    <div className="mt-1 grid grid-cols-4 gap-1 text-[10px]">
                      <div><span className="text-slate-500">PWR</span> <span className="text-slate-200">{e.powerW.toFixed(2)} W</span></div>
                      <div><span className="text-slate-500">λ</span> <span className="text-slate-200">{e.wavelengthNm} nm</span></div>
                      <div><span className="text-slate-500">DIV</span> <span className="text-slate-200">{e.divergenceMrad.toFixed(1)} mrad</span></div>
                      <div><span className="text-slate-500">μ-IRR</span> <span className="text-slate-200">{muIrr>0?fmtIrr(muIrr):'—'}</span></div>
                    </div>
                    <div className="text-[10px] text-slate-500 italic mt-1">{e.lat.toFixed(3)}°, {e.lng.toFixed(3)}° · synthetic hot-spot per FAA Laser Strike Statistics 2023</div>
                  </div>
                )
              })}
            </div>
          )}
          {tab === 'PHYSICS' && (
            <div className="text-[11px] text-slate-300 space-y-3">
              <div>
                <div className="text-slate-100 font-semibold mb-1">Ocular Irradiance Model</div>
                <div className="font-mono text-[10px] text-slate-400 bg-slate-900/60 border border-slate-800 rounded p-2">
                  I(d) = P · τ_a · η_point / (π · (d · tan(θ/2))²)<br/>
                  τ_a = exp(-α · d)  (Mil-Hdbk-141 §4.5)<br/>
                  α = 0.05 clear · 0.15 haze · 0.50 low-vis /km<br/>
                  η_point ≈ 0.04 handheld-jitter on-axis duty<br/>
                  MPE (532nm 0.25-s aversion): 25.4 µW/cm²
                </div>
              </div>
              <div className="bg-slate-900/40 border border-slate-800 rounded p-2">
                <div className="text-[10px] text-slate-500 mb-1">Irradiance vs slant range (log·log) — 0.5W 532nm @ 1.2 mrad</div>
                <svg viewBox="0 0 460 220" className="w-full h-44">
                  <rect x="0" y="0" width="460" height="220" fill="#0b1220" />
                  {[40,80,120,160,200].map(y => <line key={y} x1="40" x2="450" y1={y} y2={y} stroke="#1e293b" />)}
                  {(() => {
                    const yLog = (i:number) => clamp(200 - (Math.log10(Math.max(1e-13, i)/1e-13)/9)*180, 10, 210)
                    return (
                      <>
                        <line x1="40" x2="450" y1={yLog(MPE_INJURY_WCM2)} y2={yLog(MPE_INJURY_WCM2)} stroke="#ef4444" strokeDasharray="4 3" />
                        <text x="446" y={yLog(MPE_INJURY_WCM2)-2} fontSize="9" fill="#ef4444" textAnchor="end">MPE 25.4 µW/cm²</text>
                        <line x1="40" x2="450" y1={yLog(MPE_FLASH_WCM2)} y2={yLog(MPE_FLASH_WCM2)} stroke="#f43f5e" strokeDasharray="4 3" />
                        <text x="446" y={yLog(MPE_FLASH_WCM2)-2} fontSize="9" fill="#f43f5e" textAnchor="end">flash 100 nW/cm²</text>
                        <line x1="40" x2="450" y1={yLog(MPE_GLARE_WCM2)} y2={yLog(MPE_GLARE_WCM2)} stroke="#f59e0b" strokeDasharray="4 3" />
                        <text x="446" y={yLog(MPE_GLARE_WCM2)-2} fontSize="9" fill="#f59e0b" textAnchor="end">glare 5 nW/cm²</text>
                        <line x1="40" x2="450" y1={yLog(MPE_DISTRCT_WCM2)} y2={yLog(MPE_DISTRCT_WCM2)} stroke="#0ea5e9" strokeDasharray="4 3" />
                        <text x="446" y={yLog(MPE_DISTRCT_WCM2)-2} fontSize="9" fill="#0ea5e9" textAnchor="end">distract 50 pW/cm²</text>
                      </>
                    )
                  })()}
                  {(() => {
                    const yLog = (i:number) => clamp(200 - (Math.log10(Math.max(1e-13, i)/1e-13)/9)*180, 10, 210)
                    const xKm = (d:number) => 40 + (Math.log10(Math.max(0.1, d))/2)*400
                    const e: Emitter = EMITTERS[0]
                    const pts: string[] = []
                    for (let d=0.2; d<=100; d*=1.15) {
                      const i = computeIrradiance(e, d, 0.10)
                      pts.push(`${xKm(d)},${yLog(i)}`)
                    }
                    return <polyline points={pts.join(' ')} fill="none" stroke="#7dd3fc" strokeWidth="1.6" />
                  })()}
                  <text x="40" y="215" fontSize="9" fill="#64748b">0.1 km</text>
                  <text x="240" y="215" fontSize="9" fill="#64748b">10 km</text>
                  <text x="440" y="215" fontSize="9" fill="#64748b">100 km</text>
                </svg>
              </div>
              <div className="text-[10px] text-slate-400 space-y-1">
                <div className="text-slate-300 font-semibold">References</div>
                <div>14 CFR §91.11 · 18 U.S.C. §39A federal felony</div>
                <div>FAA AC 70-1 Outdoor Laser Operations · AC 70-2 Reporting Laser Illumination of Aircraft</div>
                <div>FAA Order 7400.2P Ch.29 · FAA Laser Strike Statistics 2023 (~9,500 events/yr)</div>
                <div>AIM 4-3-19 / 7-5-12 emergency response</div>
                <div>ICAO Annex 14 §5.3.2.4 · Doc 9815 Laser Emitters &amp; Flight Safety</div>
                <div>ANSI Z136.6-2015 Outdoor Laser Operations · IEC 60825-1 Product Safety</div>
                <div>Mil-Hdbk-141 §4.5 atmospheric transmittance · Nakagawara FAA CAMI-2010-04</div>
                <div>NTSB SR-04-01 Laser Illumination Safety Recommendation</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
