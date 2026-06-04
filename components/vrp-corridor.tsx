'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   VRP · Visual Reporting Points & VFR Corridor Conformance
   ------------------------------------------------------------
   Per-airframe scorer evaluating VFR traffic against a 36-point
   global catalogue of published Visual Reporting Points and the
   corridor / SFRA / TMZ / RMZ they thread through. Classifies
   each VFR target's conformance to the published routing, the
   distance to its nearest VRP, corridor-axis cross-track error,
   altitude band compliance vs published min/max, transponder
   code conformance per ICAO Annex 10 Vol IV (7000/1200/2000),
   and risk of controlled airspace incursion at corridor
   boundaries.

   Distinct from:
     • SUA / TFR — special-use airspace static blocks
     • ADIZ — air-defense identification zone monitor
     • MORA — grid minimum terrain clearance
     • CLAM/RAM — Mode-C / route adherence en-route

   References:
     ICAO Annex 11 §2.10 VFR cruising levels
     ICAO Annex 11 §3.3.2 VFR flights in CTR / TMA
     ICAO Annex 2 §4 VFR rules of the air
     ICAO Annex 10 Vol IV §3 Mode-A code assignment
     ICAO Doc 4444 PANS-ATM §16 ATS provided to VFR
     ICAO Doc 8168 Vol I Pt II §2 VFR procedures
     ICAO Doc 7030 Regional Supplementary Procedures
     FAA AIM 3-5-6 Special Flight Rules Areas
     FAA Order JO 7110.65 §7-5 VFR aircraft
     FAA Order JO 7400.2 §13-2 SFRA published
     FAA 14 CFR §91.225 ADS-B Out / §91.215 Transponder
     FAA SFAR-50-2 GCN / SFAR-71 Hudson NY / SFAR-77 DC SFRA
     EASA SERA.5005 / SERA.5010 VFR cruising
     EASA SERA.6005 RMZ / TMZ requirements
     UK CAA CAP 413 §4 VFR R/T / CAP 493 §5 VFR services
     UK MIL AIP ENR 6 VRP catalogue
     DFS AIP GEN 3.3 / ENR 6 VRP Germany
     DSNA AIP ENR 6 France
     Australia AIP ENR 1.10 VFR ops
     CAAC AIP ENR 1.2 VFR China
     NTSB AAR-09-04 Hudson midair (NYC SFRA)
     AAIB EW/G2018/06/14 LHR VRP incursion CAS
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  squawk?: string | number
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'INCURSION' | 'DEVIATION' | 'OFF-AXIS' | 'WATCH' | 'CONFORM' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  INCURSION: '#ef4444', DEVIATION: '#f43f5e', 'OFF-AXIS': '#f59e0b', WATCH: '#0ea5e9', CONFORM: '#10b981', IDLE: '#64748b',
}
const TIER_RANK: Record<Tier, number> = { INCURSION:0, DEVIATION:1, 'OFF-AXIS':2, WATCH:3, CONFORM:4, IDLE:5 }

type CorridorKind = 'SFRA' | 'CTR' | 'TMZ' | 'RMZ' | 'CORRIDOR'
const KIND_COLOR: Record<CorridorKind, string> = {
  SFRA: '#a855f7', CTR: '#0ea5e9', TMZ: '#f59e0b', RMZ: '#06b6d4', CORRIDOR: '#10b981',
}

interface Vrp {
  id: string         // ICAO VRP code (regional)
  name: string       // common name
  lat: number; lng: number
  corridor: string   // corridor id this VRP threads
  kind: CorridorKind
  minFt: number      // published floor (msl)
  maxFt: number      // published ceiling (msl)
  squawk: string     // published transponder code
  authority: string
}

// 36-point global VRP catalogue (published per AIP ENR 6 / FAA Chart Supplements / EUROCONTROL VFR-Guide)
const VRP: Vrp[] = [
  // NY Hudson River SFRA (SFAR-71 / FAA NY-NJ-PA Heli Route Chart)
  { id:'V-GWB', name:'GW Bridge',       lat:40.852, lng:-73.952, corridor:'NY-HUDSON', kind:'SFRA', minFt:0,    maxFt:1300, squawk:'1200', authority:'FAA NYC SFRA' },
  { id:'V-INT', name:'Intrepid Pier',   lat:40.765, lng:-74.000, corridor:'NY-HUDSON', kind:'SFRA', minFt:0,    maxFt:1300, squawk:'1200', authority:'FAA NYC SFRA' },
  { id:'V-SOL', name:'Statue of Liberty',lat:40.690, lng:-74.045, corridor:'NY-HUDSON', kind:'SFRA', minFt:0,    maxFt:1300, squawk:'1200', authority:'FAA NYC SFRA' },
  { id:'V-VZB', name:'Verrazano Br',    lat:40.605, lng:-74.045, corridor:'NY-HUDSON', kind:'SFRA', minFt:0,    maxFt:1300, squawk:'1200', authority:'FAA NYC SFRA' },
  // DC SFRA (SFAR-77)
  { id:'V-DC-N', name:'DC SFRA N',      lat:39.150, lng:-77.350, corridor:'DC-SFRA',   kind:'SFRA', minFt:0,    maxFt:18000,squawk:'asgn', authority:'FAA Potomac TRACON' },
  { id:'V-DC-S', name:'DC SFRA S',      lat:38.500, lng:-77.350, corridor:'DC-SFRA',   kind:'SFRA', minFt:0,    maxFt:18000,squawk:'asgn', authority:'FAA Potomac TRACON' },
  // Grand Canyon SFAR-50-2
  { id:'V-GCN1',name:'Dragon corridor', lat:36.150, lng:-112.110,corridor:'GCN-SFRA',  kind:'SFRA', minFt:7800, maxFt:14499,squawk:'1255', authority:'FAA GCN SFRA' },
  { id:'V-GCN2',name:'Zuni Pt',         lat:35.940, lng:-111.870,corridor:'GCN-SFRA',  kind:'SFRA', minFt:7800, maxFt:14499,squawk:'1255', authority:'FAA GCN SFRA' },
  // LAX special flight rules (FAR §93.95)
  { id:'V-LAX-S',name:'Mini-route SE',  lat:33.945, lng:-118.405,corridor:'LAX-SFR',   kind:'SFRA', minFt:3500, maxFt:5500, squawk:'1201', authority:'FAA SCT' },
  // Hollywood Park / SoCal helicopter
  { id:'V-HOL', name:'Hollywood sign',  lat:34.135, lng:-118.320,corridor:'LA-HELI',   kind:'CORRIDOR',minFt:1500,maxFt:2500,squawk:'1200',authority:'FAA SCT' },
  // London — LHR VRPs (UK AIP ENR 6)
  { id:'V-LHR-N',name:'Bovingdon',      lat:51.730, lng:-0.555,  corridor:'LON-VFR',   kind:'CTR',  minFt:1500, maxFt:2500, squawk:'7010', authority:'NATS LTCC' },
  { id:'V-LHR-S',name:'Box Hill',       lat:51.250, lng:-0.310,  corridor:'LON-VFR',   kind:'CTR',  minFt:1500, maxFt:2500, squawk:'7010', authority:'NATS LTCC' },
  { id:'V-LCY', name:'O2 Dome',         lat:51.503, lng:0.003,   corridor:'LCY-VFR',   kind:'CTR',  minFt:1000, maxFt:1500, squawk:'7010', authority:'NATS' },
  // EGKK Gatwick VRPs
  { id:'V-LGW', name:'Mayfield',        lat:51.020, lng:0.250,   corridor:'LGW-VFR',   kind:'CTR',  minFt:1500, maxFt:2500, squawk:'7011', authority:'NATS LGW APP' },
  // Paris Versailles / La Défense VFR (DSNA)
  { id:'V-PAR-W',name:'La Défense',     lat:48.892, lng:2.235,   corridor:'PAR-VFR',   kind:'CTR',  minFt:1000, maxFt:2000, squawk:'7000', authority:'DSNA Paris' },
  { id:'V-PAR-S',name:'Vélizy',         lat:48.780, lng:2.190,   corridor:'PAR-VFR',   kind:'CTR',  minFt:1000, maxFt:2000, squawk:'7000', authority:'DSNA Paris' },
  // Amsterdam Schiphol VFR
  { id:'V-EHAM-A',name:'Amsterdam-RAI', lat:52.339, lng:4.890,   corridor:'AMS-VFR',   kind:'CTR',  minFt:1000, maxFt:1500, squawk:'7000', authority:'LVNL' },
  // Frankfurt VFR
  { id:'V-EDDF-N',name:'Bad Vilbel',    lat:50.181, lng:8.736,   corridor:'FRA-VFR',   kind:'TMZ',  minFt:1500, maxFt:3500, squawk:'7000', authority:'DFS FRA APP' },
  // Munich Alps corridor
  { id:'V-EDDM-A',name:'Tegernsee',     lat:47.715, lng:11.755,  corridor:'MUC-ALP',   kind:'TMZ',  minFt:5500, maxFt:9500, squawk:'7000', authority:'DFS MUC' },
  // Zurich VFR Kloten
  { id:'V-LSZH-N',name:'Klingnau',      lat:47.585, lng:8.245,   corridor:'ZRH-VFR',   kind:'CTR',  minFt:2500, maxFt:4500, squawk:'7000', authority:'Skyguide' },
  // Madrid VFR
  { id:'V-LEMD', name:'San Sebastián',  lat:40.475, lng:-3.600,  corridor:'MAD-VFR',   kind:'CTR',  minFt:2500, maxFt:4500, squawk:'7000', authority:'ENAIRE' },
  // Rome VFR
  { id:'V-LIRF', name:'Lago Bracciano', lat:42.105, lng:12.230,  corridor:'ROM-VFR',   kind:'CTR',  minFt:1500, maxFt:3500, squawk:'7000', authority:'ENAV' },
  // Sydney harbour bridge
  { id:'V-SYD',  name:'Harbour Bridge', lat:-33.852,lng:151.211, corridor:'SYD-HARB',  kind:'CTR',  minFt:500,  maxFt:1500, squawk:'1200', authority:'Airservices' },
  // Brisbane corridor
  { id:'V-BNE',  name:'Mt Coot-tha',    lat:-27.475,lng:152.952, corridor:'BNE-VFR',   kind:'CTR',  minFt:500,  maxFt:1500, squawk:'1200', authority:'Airservices' },
  // Tokyo Haneda heli VFR
  { id:'V-RJTT', name:'Tokyo Tower',    lat:35.659, lng:139.745, corridor:'TYO-HELI',  kind:'CORRIDOR',minFt:1000,maxFt:2000,squawk:'1200',authority:'JCAB' },
  // HKG harbour
  { id:'V-VHHH', name:'IFC tower',      lat:22.285, lng:114.158, corridor:'HKG-VFR',   kind:'CTR',  minFt:1000, maxFt:2000, squawk:'1200', authority:'CAD HK' },
  // Singapore restricted
  { id:'V-WSSS', name:'Marina Bay',     lat:1.282,  lng:103.860, corridor:'SIN-VFR',   kind:'CTR',  minFt:500,  maxFt:1500, squawk:'7000', authority:'CAAS' },
  // Vancouver harbour VFR (TC)
  { id:'V-CYVR', name:'Lions Gate',     lat:49.315, lng:-123.140,corridor:'YVR-VFR',   kind:'CTR',  minFt:1000, maxFt:2500, squawk:'1200', authority:'NAV CANADA' },
  // Toronto Island
  { id:'V-CYYZ', name:'Toronto Island', lat:43.628, lng:-79.394, corridor:'YYZ-VFR',   kind:'CTR',  minFt:1100, maxFt:2500, squawk:'1200', authority:'NAV CANADA' },
  // Boston Cape Cod canal corridor
  { id:'V-CAPE', name:'Cape Cod Canal', lat:41.770, lng:-70.520, corridor:'BOS-VFR',   kind:'CORRIDOR',minFt:500, maxFt:2500, squawk:'1200', authority:'FAA A90' },
  // Chicago lakefront
  { id:'V-CHI',  name:'Navy Pier',      lat:41.892, lng:-87.605, corridor:'CHI-LAKE',  kind:'CORRIDOR',minFt:500, maxFt:3000, squawk:'1200', authority:'FAA C90' },
  // SF Bay Class B transition
  { id:'V-SFO',  name:'San Mateo Br',   lat:37.595, lng:-122.245,corridor:'SF-BAY',    kind:'CORRIDOR',minFt:1500,maxFt:3500, squawk:'1200', authority:'FAA NCT' },
  // Honolulu shoreline
  { id:'V-HNL',  name:'Diamond Head',   lat:21.262, lng:-157.805,corridor:'HNL-VFR',   kind:'CTR',  minFt:500,  maxFt:1500, squawk:'1200', authority:'FAA HCF' },
  // Cape Town Robben Is
  { id:'V-FACT', name:'Robben Island',  lat:-33.806,lng:18.366,  corridor:'CPT-VFR',   kind:'CTR',  minFt:1000, maxFt:2500, squawk:'2000', authority:'ATNS' },
  // Dubai Palm
  { id:'V-OMDB', name:'Palm Jumeirah',  lat:25.115, lng:55.135,  corridor:'DXB-VFR',   kind:'CTR',  minFt:500,  maxFt:1500, squawk:'2000', authority:'DCA' },
  // Auckland Sky Tower
  { id:'V-NZAA', name:'Sky Tower',      lat:-36.848,lng:174.762, corridor:'AKL-VFR',   kind:'CTR',  minFt:500,  maxFt:1500, squawk:'1200', authority:'Airways NZ' },
]

function haversineNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 3440.065
  const φ1 = la1 * Math.PI/180, φ2 = la2 * Math.PI/180
  const dφ = (la2 - la1) * Math.PI/180, dλ = (lo2 - lo1) * Math.PI/180
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// great-circle bearing
function bearing(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1*Math.PI/180, φ2 = la2*Math.PI/180, Δλ = (lo2-lo1)*Math.PI/180
  const y = Math.sin(Δλ)*Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ)
  return ((Math.atan2(y,x)*180/Math.PI)+360)%360
}

type Phase = 'TAXI' | 'LOW-VFR' | 'TRANS' | 'CRUISE' | 'PATTERN'
function classifyPhase(f: SFlight): Phase {
  if (f.ground) return 'TAXI'
  if (f.altitudeFt < 3000) return 'PATTERN'
  if (f.altitudeFt < 6500) return 'LOW-VFR'
  if (f.altitudeFt < 12500) return 'TRANS'
  return 'CRUISE'
}

// VFR heuristic: low alt, low speed, transponder code 1200 / 7000 / 1201 / common VFR codes
function isVfr(f: SFlight): boolean {
  if (f.ground) return false
  if (f.altitudeFt > 17500) return false
  if (f.velocityKts > 250) return false
  const sq = String(f.squawk ?? '').trim()
  if (sq === '1200' || sq === '7000' || sq === '1201' || sq === '1202' || sq === '1255' || sq === '2000' || sq === '7010' || sq === '7011') return true
  // Light/slow non-coded inferred VFR
  if (f.altitudeFt < 6000 && f.velocityKts < 180) return true
  return false
}

interface Eval {
  flight: SFlight
  vrp: Vrp
  phase: Phase
  distNm: number
  bearingDeg: number
  altFt: number
  axisErrNm: number          // cross-track to corridor axis
  altOverFt: number          // above maxFt (positive bad)
  altUnderFt: number         // below minFt (positive bad)
  squawkOk: boolean
  tier: Tier
  score: number
  drivers: { dist: number; alt: number; axis: number; xpdr: number; kind: number; phase: number }
  rationale: string
  citation: string
}

export default function VrpCorridor({ map, flights, onClose, onFly }: Props) {
  // sliders
  const [scopeNm, setScopeNm] = useState(35)
  const [axisTolNm, setAxisTolNm] = useState(2)
  const [altBufFt, setAltBufFt] = useState(200)
  const [advMul, setAdvMul] = useState(100)
  const [vfrMaxKt, setVfrMaxKt] = useState(250)
  const [maxFL, setMaxFL] = useState(180)

  // toggles
  const [showVrpPts, setShowVrpPts] = useState(true)
  const [showCorridor, setShowCorridor] = useState(true)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showLink, setShowLink] = useState(true)

  const [kindFilter, setKindFilter] = useState<Record<CorridorKind, boolean>>({ SFRA:true, CTR:true, TMZ:true, RMZ:true, CORRIDOR:true })
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT'|'VRPS'|'CORRIDORS'>('AIRCRAFT')
  const [search, setSearch] = useState('')

  // corridor axes derived: chain VRPs sharing same corridor id by lat order
  const corridorAxes = useMemo(() => {
    const m = new Map<string, Vrp[]>()
    VRP.forEach(v => { if (!m.has(v.corridor)) m.set(v.corridor, []); m.get(v.corridor)!.push(v) })
    return [...m.entries()].map(([id, pts]) => ({ id, kind: pts[0].kind, pts: pts.slice().sort((a,b) => a.lat - b.lat) }))
  }, [])

  // distance from point to a polyline (axis) in nm — min of per-segment perpendicular drop
  function distToAxis(la: number, lo: number, pts: Vrp[]): number {
    if (pts.length === 0) return Infinity
    if (pts.length === 1) return haversineNm(la, lo, pts[0].lat, pts[0].lng)
    let best = Infinity
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i+1]
      // approximate using perpendicular to segment in flat-earth nm
      const ax = (a.lng) * 60 * Math.cos((la)*Math.PI/180), ay = a.lat * 60
      const bx = (b.lng) * 60 * Math.cos((la)*Math.PI/180), by = b.lat * 60
      const px = (lo) * 60 * Math.cos((la)*Math.PI/180), py = la * 60
      const dx = bx-ax, dy = by-ay
      const t = Math.max(0, Math.min(1, ((px-ax)*dx + (py-ay)*dy) / (dx*dx + dy*dy)))
      const cx = ax + t*dx, cy = ay + t*dy
      const d = Math.hypot(px-cx, py-cy)
      if (d < best) best = d
    }
    return best
  }

  const evals: Eval[] = useMemo(() => {
    const out: Eval[] = []
    for (const f of flights) {
      const fl = Math.round(f.altitudeFt / 100)
      if (fl > maxFL) continue
      if (f.velocityKts > vfrMaxKt) continue
      if (!isVfr(f)) continue
      const phase = classifyPhase(f)
      // find nearest VRP
      let best: Vrp | null = null; let bestD = Infinity
      for (const v of VRP) {
        if (!kindFilter[v.kind]) continue
        const d = haversineNm(f.lat, f.lng, v.lat, v.lng)
        if (d < bestD) { best = v; bestD = d }
      }
      if (!best) continue
      if (bestD > scopeNm) continue
      const corridor = corridorAxes.find(c => c.id === best!.corridor)!
      const axisErr = distToAxis(f.lat, f.lng, corridor.pts)
      const brg = bearing(best.lat, best.lng, f.lat, f.lng)
      const altOver = Math.max(0, f.altitudeFt - (best.maxFt + altBufFt))
      const altUnder = Math.max(0, (best.minFt - altBufFt) - f.altitudeFt)
      const sq = String(f.squawk ?? '').trim()
      const sqOk = best.squawk === 'asgn' ? !!sq && sq !== '0000' && sq !== '1200' : (sq === best.squawk || sq === '' )
      const distDriver = bestD > 10 ? 80 : bestD > 5 ? 50 : bestD > 2 ? 25 : 8
      const axisDriver = axisErr > axisTolNm*3 ? 100 : axisErr > axisTolNm*2 ? 75 : axisErr > axisTolNm ? 45 : 10
      const altDriver = altOver > 1500 ? 100 : altOver > 500 ? 75 : altOver > 0 ? 45 : altUnder > 500 ? 60 : altUnder > 0 ? 30 : 5
      const xpdrDriver = !sqOk ? 70 : 5
      const kindDriver = best.kind === 'SFRA' ? 95 : best.kind === 'CTR' ? 70 : best.kind === 'TMZ' ? 55 : best.kind === 'RMZ' ? 45 : 30
      const phaseDriver = phase === 'PATTERN' ? 65 : phase === 'LOW-VFR' ? 55 : phase === 'TRANS' ? 40 : 30
      const drivers = { dist: distDriver, alt: altDriver, axis: axisDriver, xpdr: xpdrDriver, kind: kindDriver, phase: phaseDriver }
      const maxD = Math.max(axisDriver, altDriver, xpdrDriver)
      const meanD = (distDriver + axisDriver + altDriver + xpdrDriver + kindDriver + phaseDriver) / 6
      let score = (maxD * 0.78 + meanD * 0.22) * (advMul/100)
      // SFRA escalator
      if (best.kind === 'SFRA' && (axisErr > axisTolNm || altOver > 0 || altUnder > 0)) score = Math.max(score, 88)
      score = Math.max(0, Math.min(100, score))

      let tier: Tier = 'CONFORM'
      if ((best.kind === 'SFRA' && (axisErr > axisTolNm*1.5 || altOver > 200 || altUnder > 200))) tier = 'INCURSION'
      else if (axisErr > axisTolNm*2 || altOver > 500 || altUnder > 500) tier = 'DEVIATION'
      else if (axisErr > axisTolNm || !sqOk) tier = 'OFF-AXIS'
      else if (bestD > 3 || altOver > 0 || altUnder > 0) tier = 'WATCH'

      let rationale = `${bestD.toFixed(1)}nm from ${best.id}, axis ±${axisErr.toFixed(1)}nm, ${Math.round(f.altitudeFt)}ft within ${best.minFt}-${best.maxFt}ft`
      let citation = 'ICAO Annex 11 §3.3.2 / Doc 4444 §16'
      if (tier === 'INCURSION') { rationale = `SFRA INCURSION at ${best.id} (${best.corridor}); axis err ${axisErr.toFixed(1)}nm, Δalt ${altOver>0?'+':'-'}${Math.round(altOver||altUnder)}ft — request immediate clearance, contact ${best.authority}`; citation = 'FAA SFAR-71 / SFAR-77 / 14 CFR §91.225 / AIM 3-5-6' }
      else if (tier === 'DEVIATION') { rationale = `corridor deviation: axis ${axisErr.toFixed(1)}nm vs tol ${axisTolNm}nm, alt over ${Math.round(altOver)}ft / under ${Math.round(altUnder)}ft — re-track ${best.id}, squawk ${best.squawk}`; citation = 'EASA SERA.5005 / SERA.6005' }
      else if (tier === 'OFF-AXIS') { rationale = `off-axis ${axisErr.toFixed(1)}nm or non-conformant squawk (have ${sq||'—'}, expect ${best.squawk}) — verify routing`; citation = 'ICAO Annex 10 Vol IV §3 / AIM 4-1-20' }
      else if (tier === 'WATCH') { rationale = `nominal but ${bestD.toFixed(1)}nm from VRP; monitor altitude band ${best.minFt}-${best.maxFt}ft`; citation = 'Doc 8168 Vol I Pt II §2' }
      else { rationale = `conformant to ${best.corridor} corridor via ${best.id}`; citation = 'AIM 3-5-6' }

      out.push({ flight: f, vrp: best, phase, distNm: bestD, bearingDeg: brg, altFt: f.altitudeFt, axisErrNm: axisErr, altOverFt: altOver, altUnderFt: altUnder, squawkOk: sqOk, tier, score: Math.round(score), drivers, rationale, citation })
    }
    return out.sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [flights, scopeNm, axisTolNm, altBufFt, advMul, vfrMaxKt, maxFL, kindFilter, corridorAxes])

  const counts: Record<Tier, number> = useMemo(() => {
    const c: Record<Tier, number> = { INCURSION:0, DEVIATION:0, 'OFF-AXIS':0, WATCH:0, CONFORM:0, IDLE:0 }
    evals.forEach(e => { c[e.tier]++ })
    return c
  }, [evals])

  const meanScore = evals.length ? Math.round(evals.reduce((s,e) => s+e.score, 0) / evals.length) : 0
  const meanTier: Tier = meanScore >= 80 ? 'INCURSION' : meanScore >= 60 ? 'DEVIATION' : meanScore >= 35 ? 'OFF-AXIS' : meanScore >= 18 ? 'WATCH' : 'CONFORM'
  const worst = evals[0]
  const incC = counts.INCURSION
  const devC = counts.DEVIATION
  const meanAxis = evals.length ? (evals.reduce((s,e)=>s+e.axisErrNm,0) / evals.length).toFixed(2) : '0.00'

  const visible = evals.filter(e => {
    if (tierFilter !== 'ALL' && e.tier !== tierFilter) return false
    if (search) {
      const s = search.toLowerCase()
      if (![e.flight.callsign, e.flight.icao, e.flight.type, e.vrp.id, e.vrp.name, e.vrp.corridor].some(v => (v||'').toLowerCase().includes(s))) return false
    }
    return true
  })

  const byVrp = useMemo(() => {
    const m = new Map<string, Eval[]>()
    evals.forEach(e => { if (!m.has(e.vrp.id)) m.set(e.vrp.id, []); m.get(e.vrp.id)!.push(e) })
    return [...m.entries()].sort(([,a],[,b]) => TIER_RANK[a[0].tier]-TIER_RANK[b[0].tier] || b[0].score-a[0].score)
  }, [evals])

  const byCorridor = useMemo(() => {
    const m = new Map<string, Eval[]>()
    evals.forEach(e => { if (!m.has(e.vrp.corridor)) m.set(e.vrp.corridor, []); m.get(e.vrp.corridor)!.push(e) })
    return [...m.entries()].sort(([,a],[,b]) => b.length - a.length)
  }, [evals])

  // ============ MAP OVERLAY ============
  useEffect(() => {
    if (!map) return
    const m = map
    const SRC = 'vrp-src', LBL = 'vrp-lbl'
    const features: GeoJSON.Feature[] = []
    const labels: GeoJSON.Feature[] = []

    // corridor axes as dashed polylines
    if (showCorridor) {
      for (const c of corridorAxes) {
        if (!kindFilter[c.kind]) continue
        if (c.pts.length < 2) continue
        const coords = c.pts.map(p => [p.lng, p.lat] as [number, number])
        features.push({ type:'Feature', geometry:{ type:'LineString', coordinates: coords }, properties:{ kind:'corridor', color: KIND_COLOR[c.kind] } })
        const mid = c.pts[Math.floor(c.pts.length/2)]
        labels.push({ type:'Feature', geometry:{ type:'Point', coordinates:[mid.lng, mid.lat] }, properties:{ text:`${c.id} · ${c.kind}`, color: KIND_COLOR[c.kind] } })
      }
    }
    // VRP pins
    if (showVrpPts) {
      for (const v of VRP) {
        if (!kindFilter[v.kind]) continue
        features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[v.lng, v.lat] }, properties:{ kind:'vrp', color: KIND_COLOR[v.kind], radius:4 } })
        labels.push({ type:'Feature', geometry:{ type:'Point', coordinates:[v.lng, v.lat] }, properties:{ text:`${v.id} · ${v.minFt}-${v.maxFt}ft`, color: KIND_COLOR[v.kind] } })
      }
    }

    const seen = new Set<string>()
    evals.forEach(e => {
      if (seen.has(e.flight.icao)) return
      seen.add(e.flight.icao)
      const c = TIER_COLOR[e.tier]
      if (showHalo) features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[e.flight.lng, e.flight.lat] }, properties:{ color:c, kind:'halo', radius: 8 + Math.min(14, e.score/7) } })
      if (showPin && (e.tier==='INCURSION' || e.tier==='DEVIATION')) features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[e.flight.lng, e.flight.lat] }, properties:{ color:c, kind:'pin', radius:5 } })
      if (showLink) features.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[e.flight.lng, e.flight.lat],[e.vrp.lng, e.vrp.lat]] }, properties:{ color:c, kind:'link' } })
      if (showLbl) labels.push({ type:'Feature', geometry:{ type:'Point', coordinates:[e.flight.lng, e.flight.lat] }, properties:{ text:`${e.flight.callsign||e.flight.icao} ${e.tier} ±${e.axisErrNm.toFixed(1)}nm`, color:c } })
    })

    try {
      if (!m.getSource(SRC)) m.addSource(SRC, { type:'geojson', data:{ type:'FeatureCollection', features } as GeoJSON.FeatureCollection })
      else (m.getSource(SRC) as maplibregl.GeoJSONSource).setData({ type:'FeatureCollection', features } as GeoJSON.FeatureCollection)
      if (!m.getSource(LBL)) m.addSource(LBL, { type:'geojson', data:{ type:'FeatureCollection', features: labels } as GeoJSON.FeatureCollection })
      else (m.getSource(LBL) as maplibregl.GeoJSONSource).setData({ type:'FeatureCollection', features: labels } as GeoJSON.FeatureCollection)

      if (showCorridor && !m.getLayer('vrp-corridor')) m.addLayer({ id:'vrp-corridor', type:'line', source:SRC, filter:['==',['get','kind'],'corridor'], paint:{ 'line-color':['get','color'], 'line-width':1.6, 'line-dasharray':[3,2], 'line-opacity':0.65 } })
      if (showVrpPts && !m.getLayer('vrp-pt')) m.addLayer({ id:'vrp-pt', type:'circle', source:SRC, filter:['==',['get','kind'],'vrp'], paint:{ 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1, 'circle-radius':['get','radius'], 'circle-opacity':0.85 } })
      if (showLink && !m.getLayer('vrp-link')) m.addLayer({ id:'vrp-link', type:'line', source:SRC, filter:['==',['get','kind'],'link'], paint:{ 'line-color':['get','color'], 'line-width':1.1, 'line-dasharray':[1,2], 'line-opacity':0.8 } })
      if (showHalo && !m.getLayer('vrp-halo')) m.addLayer({ id:'vrp-halo', type:'circle', source:SRC, filter:['==',['get','kind'],'halo'], paint:{ 'circle-color':'transparent', 'circle-stroke-color':['get','color'], 'circle-stroke-width':2, 'circle-radius':['get','radius'], 'circle-opacity':0.7 } })
      if (showPin && !m.getLayer('vrp-pin')) m.addLayer({ id:'vrp-pin', type:'circle', source:SRC, filter:['==',['get','kind'],'pin'], paint:{ 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1, 'circle-radius':5 } })
      if (showLbl && !m.getLayer('vrp-lbl')) m.addLayer({ id:'vrp-lbl', type:'symbol', source:LBL, layout:{ 'text-field':['get','text'], 'text-size':9, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.2 } })
    } catch {}
    return () => {
      try {
        for (const id of ['vrp-corridor','vrp-pt','vrp-link','vrp-halo','vrp-pin','vrp-lbl']) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC, LBL]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, evals, corridorAxes, showVrpPts, showCorridor, showHalo, showPin, showLbl, showLink, kindFilter])

  const tierPill = (t: Tier) => (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide" style={{ background:`${TIER_COLOR[t]}22`, color: TIER_COLOR[t], border:`1px solid ${TIER_COLOR[t]}55` }}>{t}</span>
  )
  const kindPill = (k: CorridorKind) => (
    <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ background:`${KIND_COLOR[k]}1f`, color: KIND_COLOR[k], border:`1px solid ${KIND_COLOR[k]}55` }}>{k}</span>
  )

  // Scatter: axis err nm horizontal vs alt error ft vertical
  const sx = (d: number) => 30 + Math.max(0, Math.min(8, d)) * 340/8
  const sy = (v: number) => 55 - Math.max(-2000, Math.min(2000, v)) * 42/2000

  return (
    <div className="absolute right-3 top-16 bottom-3 w-[440px] z-[60] rounded-2xl border border-slate-800 bg-slate-950/90 backdrop-blur-md text-slate-200 shadow-2xl flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 bg-slate-900/60">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: TIER_COLOR[meanTier] }} />
          <div className="text-sm font-semibold">VRP · VFR Corridor Conformance</div>
          <span className="text-[10px] text-slate-500">Annex 11 §3.3.2</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-6 gap-1 px-2 pt-2">
        {(['INCURSION','DEVIATION','OFF-AXIS','WATCH','CONFORM'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`px-1.5 py-1 rounded border text-[10px] font-semibold tracking-wide transition ${tierFilter===t?'opacity-100':'opacity-70 hover:opacity-100'}`}
            style={{ borderColor: `${TIER_COLOR[t]}55`, background: tierFilter===t?`${TIER_COLOR[t]}22`:'transparent', color: TIER_COLOR[t] }}>
            <div className="text-[8px] opacity-80 truncate">{t}</div>
            <div className="text-sm font-mono">{counts[t]}</div>
          </button>
        ))}
        <button onClick={() => setTierFilter('ALL')} className={`px-1.5 py-1 rounded border text-[10px] tracking-wide ${tierFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
          <div className="text-[8px]">ALL</div>
          <div className="text-sm font-mono">{evals.length}</div>
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1 px-2 pt-2 text-[10px]">
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">MEAN</div>
          <div className="font-mono text-sm" style={{ color: TIER_COLOR[meanTier] }}>{meanScore}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">WORST</div>
          <div className="font-mono text-xs truncate" style={{ color: worst ? TIER_COLOR[worst.tier] : '#64748b' }}>{worst ? (worst.flight.callsign || worst.flight.icao) : '—'}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">INCURSION</div>
          <div className="font-mono text-sm text-rose-400">{incC}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">DEVIATION</div>
          <div className="font-mono text-sm" style={{ color: TIER_COLOR.DEVIATION }}>{devC}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">MEAN AXIS</div>
          <div className="font-mono text-sm text-sky-300">{meanAxis}nm</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">VRPs HOT</div>
          <div className="font-mono text-sm text-sky-300">{new Set(evals.map(e => e.vrp.id)).size}</div>
        </div>
      </div>

      {/* Scatter: axis err vs alt over/under */}
      <div className="px-2 pt-2">
        <svg viewBox="0 0 380 110" className="w-full h-[110px] rounded border border-slate-800 bg-slate-900/40">
          <rect x={sx(axisTolNm*2)} y={10} width={sx(8)-sx(axisTolNm*2)} height={90} fill="#ef44441a" />
          <rect x={sx(axisTolNm)} y={10} width={sx(axisTolNm*2)-sx(axisTolNm)} height={90} fill="#f59e0b1a" />
          <rect x={30} y={10} width={sx(axisTolNm)-30} height={90} fill="#10b9811a" />
          <line x1={sx(axisTolNm)} y1={10} x2={sx(axisTolNm)} y2={100} stroke="#f59e0b" strokeDasharray="2 2" strokeOpacity={0.6} />
          <line x1={sx(axisTolNm*2)} y1={10} x2={sx(axisTolNm*2)} y2={100} stroke="#ef4444" strokeDasharray="2 2" strokeOpacity={0.6} />
          <line x1={30} y1={sy(0)} x2={370} y2={sy(0)} stroke="#64748b" strokeDasharray="2 2" strokeOpacity={0.4} />
          {evals.map((e, i) => (
            <circle key={i} cx={sx(e.axisErrNm)} cy={sy(e.altOverFt > 0 ? e.altOverFt : -e.altUnderFt)} r={2.5} fill={TIER_COLOR[e.tier]} opacity={0.85} />
          ))}
          <text x={4} y={14} fill="#64748b" fontSize={8} fontFamily="monospace">Δalt ft</text>
          <text x={370} y={108} fill="#64748b" fontSize={8} fontFamily="monospace" textAnchor="end">axis err nm</text>
        </svg>
      </div>

      {/* Sliders */}
      <div className="grid grid-cols-2 gap-1 px-2 pt-2 text-[10px]">
        {([
          ['SCOPE', scopeNm, setScopeNm, 5, 100, 'nm'],
          ['AXIS-TOL', axisTolNm, setAxisTolNm, 1, 8, 'nm'],
          ['ALT-BUF', altBufFt, setAltBufFt, 0, 500, 'ft'],
          ['ADV-MUL', advMul, setAdvMul, 50, 200, '%'],
          ['VFR-MAX', vfrMaxKt, setVfrMaxKt, 120, 350, 'kt'],
          ['MAX-FL', maxFL, setMaxFL, 50, 250, ''],
        ] as Array<[string, number, (n:number)=>void, number, number, string]>).map(([label, val, set, min, max, unit]) => (
          <label key={label} className="flex flex-col gap-0.5 rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
            <span className="text-slate-500 flex justify-between"><span>{label}</span><span className="font-mono text-slate-200">{val}{unit}</span></span>
            <input type="range" min={min} max={max} value={val} onChange={e=>set(Number(e.target.value))} className="w-full accent-sky-500" />
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-2 pt-2">
        {(['SFRA','CTR','TMZ','RMZ','CORRIDOR'] as CorridorKind[]).map(k => (
          <button key={k} onClick={() => setKindFilter(f => ({ ...f, [k]: !f[k] }))}
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition ${kindFilter[k]?'opacity-100':'opacity-40'}`}
            style={{ background:`${KIND_COLOR[k]}1f`, color: KIND_COLOR[k], borderColor: `${KIND_COLOR[k]}55` }}>{k}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-2 pt-2">
        {([
          ['VRP', showVrpPts, setShowVrpPts],
          ['CORR', showCorridor, setShowCorridor],
          ['HALO', showHalo, setShowHalo],
          ['PIN', showPin, setShowPin],
          ['LBL', showLbl, setShowLbl],
          ['LINK', showLink, setShowLink],
        ] as Array<[string, boolean, (b:boolean)=>void]>).map(([label, on, set]) => (
          <button key={label} onClick={() => set(!on)}
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition ${on?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-700 text-slate-500 hover:text-slate-300'}`}>{label}</button>
        ))}
      </div>

      <div className="px-2 pt-2">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="callsign · icao · type · VRP · corridor"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[11px] placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50" />
      </div>
      <div className="grid grid-cols-3 gap-1 px-2 pt-2 text-[10px]">
        {(['AIRCRAFT','VRPS','CORRIDORS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2 py-1 rounded border transition ${tab===t?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-800 text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pt-2 pb-2 space-y-1.5">
        {tab === 'AIRCRAFT' && visible.length === 0 && (
          <div className="text-center text-slate-600 text-[11px] pt-6">no VFR traffic in scope of catalogued VRPs</div>
        )}
        {tab === 'AIRCRAFT' && visible.map((e, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden cursor-pointer hover:border-slate-700"
            onClick={() => onFly(e.flight.icao)}>
            <div className="h-0.5" style={{ background: TIER_COLOR[e.tier] }} />
            <div className="p-2 space-y-1">
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="font-mono font-semibold text-slate-100">{e.flight.callsign || e.flight.icao}</span>
                <span className="text-slate-500 text-[10px]">{e.flight.type || '—'}</span>
                <span className="px-1 py-0.5 rounded text-[9px] font-mono bg-slate-800 text-slate-400">{e.phase}</span>
                {kindPill(e.vrp.kind)}
                <div className="ml-auto">{tierPill(e.tier)}</div>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span className="text-sky-300">{e.vrp.id}</span>
                <span className="text-slate-500 italic truncate">{e.vrp.name}</span>
                <span className="ml-auto">{e.vrp.authority}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>dist <span className="text-slate-200">{e.distNm.toFixed(1)}nm</span></span>
                <span>brg <span className="text-slate-200">{Math.round(e.bearingDeg)}°</span></span>
                <span>axis <span style={{ color: e.axisErrNm > axisTolNm*2 ? '#ef4444' : e.axisErrNm > axisTolNm ? '#f59e0b' : '#10b981' }}>±{e.axisErrNm.toFixed(1)}nm</span></span>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>alt <span className="text-slate-200">{Math.round(e.altFt)}ft</span></span>
                <span>band <span className="text-sky-300">{e.vrp.minFt}-{e.vrp.maxFt}ft</span></span>
                {e.altOverFt > 0 && <span className="text-rose-400">+{Math.round(e.altOverFt)}ft over</span>}
                {e.altUnderFt > 0 && <span className="text-rose-400">-{Math.round(e.altUnderFt)}ft under</span>}
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>sqk <span style={{ color: e.squawkOk ? '#10b981' : '#f59e0b' }}>{String(e.flight.squawk ?? '—')}</span></span>
                <span>req <span className="text-sky-300">{e.vrp.squawk}</span></span>
                <span>{Math.round(e.flight.velocityKts)}kt</span>
                <span>trk {Math.round(e.flight.track)}°</span>
              </div>
              <div className="h-1 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: `${e.score}%`, background: TIER_COLOR[e.tier] }} />
              </div>
              <div className="grid grid-cols-6 gap-0.5 text-[9px]">
                {(['dist','axis','alt','xpdr','kind','phase'] as const).map(k => (
                  <div key={k} className="rounded bg-slate-900/60 px-1 py-0.5 text-center" style={{ color: TIER_COLOR[e.tier] }}>
                    <div className="opacity-60">{k.slice(0,3).toUpperCase()}</div>
                    <div className="font-mono">{Math.round(e.drivers[k])}</div>
                  </div>
                ))}
              </div>
              <div className="text-[10px] leading-snug" style={{ color: TIER_COLOR[e.tier] }}>
                {e.rationale} <span className="text-slate-600 italic">· {e.citation}</span>
              </div>
            </div>
          </div>
        ))}

        {tab === 'VRPS' && byVrp.length === 0 && (
          <div className="text-center text-slate-600 text-[11px] pt-6">no VRP activity</div>
        )}
        {tab === 'VRPS' && byVrp.map(([id, es]) => {
          const w = es[0]
          const inc = es.filter(x => x.tier==='INCURSION').length
          const dev = es.filter(x => x.tier==='DEVIATION').length
          const mean = Math.round(es.reduce((s,e) => s+e.score, 0) / es.length)
          return (
            <div key={id} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden cursor-pointer hover:border-slate-700"
              onClick={() => onFly(w.flight.icao)}>
              <div className="h-0.5" style={{ background: TIER_COLOR[w.tier] }} />
              <div className="p-2 space-y-1">
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="font-mono text-sky-300 font-semibold">{id}</span>
                  {kindPill(w.vrp.kind)}
                  <span className="text-slate-500 text-[10px] italic truncate">{w.vrp.name}</span>
                  <div className="ml-auto">{tierPill(w.tier)}</div>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                  <span>{w.vrp.corridor}</span>
                  <span>{w.vrp.minFt}-{w.vrp.maxFt}ft</span>
                  <span>sqk {w.vrp.squawk}</span>
                  <span className="ml-auto">{w.vrp.authority}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                  <span>{es.length} ac</span>
                  {inc > 0 && <span className="text-rose-400">INC {inc}</span>}
                  {dev > 0 && <span className="text-rose-300">DEV {dev}</span>}
                </div>
                <div className="h-1 rounded bg-slate-800 overflow-hidden">
                  <div className="h-full" style={{ width: `${mean}%`, background: TIER_COLOR[w.tier] }} />
                </div>
              </div>
            </div>
          )
        })}

        {tab === 'CORRIDORS' && byCorridor.length === 0 && (
          <div className="text-center text-slate-600 text-[11px] pt-6">no corridor activity</div>
        )}
        {tab === 'CORRIDORS' && byCorridor.map(([corridor, es]) => {
          const inc = es.filter(x => x.tier==='INCURSION').length
          const dev = es.filter(x => x.tier==='DEVIATION').length
          const mean = Math.round(es.reduce((s,e) => s+e.score, 0) / es.length)
          const tier: Tier = inc>0 ? 'INCURSION' : dev>0 ? 'DEVIATION' : mean >= 35 ? 'OFF-AXIS' : mean >= 18 ? 'WATCH' : 'CONFORM'
          const vrps = new Set(es.map(e => e.vrp.id)).size
          return (
            <div key={corridor} className="rounded border border-slate-800 bg-slate-900/40 p-2 space-y-1">
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="font-mono text-sky-300 font-semibold">{corridor}</span>
                {kindPill(es[0].vrp.kind)}
                <span className="text-slate-500 text-[10px]">{es[0].vrp.authority}</span>
                <div className="ml-auto">{tierPill(tier)}</div>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>{es.length} ac</span>
                <span>{vrps} VRPs</span>
                {inc > 0 && <span className="text-rose-400">INC {inc}</span>}
                {dev > 0 && <span className="text-rose-300">DEV {dev}</span>}
              </div>
              <div className="h-1 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: `${mean}%`, background: TIER_COLOR[tier] }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
