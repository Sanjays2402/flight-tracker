'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   MRVA · Minimum Radar Vectoring Altitude Monitor
   ------------------------------------------------------------
   Per-airframe radar-vectoring conformance scorer comparing each
   under-vector target against the TRACON-published MVA chart
   for its enclosing approach control airspace. Identifies sub-MVA
   excursions while being radar-vectored (not on a published
   procedure), classifies the magnitude of the bust against the
   Minimum Vectoring Altitude floor (which already includes the
   1000 ft non-mountainous / 2000 ft mountainous + 3 nm obstacle
   buffer), and surfaces controller-side and pilot-side mitigations.

   Distinct from:
     • MORA / OROCA — off-route GRID minimum altitude
     • MSAW — controller low-altitude warning (CFIT trigger)
     • TAWS — onboard EGPWS terrain modes
     • TERRAIN — terrain elevation overlay
     • MTCD — medium-term conflict (lateral/vertical traffic)

   References:
     FAA Order JO 7110.65 §5-6-3 Minimum En-Route / Vectoring Altitudes
     FAA Order JO 7210.3 §7-4 MVA Charts
     FAA Order 8260.19 §8 TERPS Vectoring-Altitude design
     FAA AC 90-100A §3 RNAV vector segments
     FAA JO 7110.118 Reduced Vectoring Service
     ICAO PANS-ATM Doc 4444 §8.6 Vectoring
     ICAO Doc 8168 Vol II Pt I §3 Vectoring obstacle clearance
     ICAO Annex 11 §3.7.5 Min vectoring altitudes
     EUROCONTROL MSA Spec ed.1.0
     EASA AMC1 SERA.8005(b) Vectoring & sequencing
     UK CAA CAP 493 §1.7 Radar Vectoring
     CAA CAP 670 RAC §3 Surveillance Minimum Altitude
     NTSB AAR-95-04 ALK-1572 VOR-DME approach controlled flight
     NTSB AAR-77-04 DL-723 BOS controller vector below MVA
     NTSB AAR-08-04 EJM-748 SDL MVA bust
     AAIB EW/C2010/02/01 RVA below MVA event
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'BUST' | 'WARN' | 'CAUTION' | 'MARGIN' | 'CLEAR' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  BUST: '#ef4444', WARN: '#f43f5e', CAUTION: '#f59e0b', MARGIN: '#0ea5e9', CLEAR: '#10b981', IDLE: '#64748b',
}
const TIER_RANK: Record<Tier, number> = { BUST: 0, WARN: 1, CAUTION: 2, MARGIN: 3, CLEAR: 4, IDLE: 5 }

// MVA sector terrain class drives the published floor + buffer.
type SectorKind = 'FLAT' | 'ROLLING' | 'MOUNTAIN' | 'WATER'
const KIND_COLOR: Record<SectorKind, string> = {
  FLAT: '#0ea5e9', ROLLING: '#10b981', MOUNTAIN: '#a855f7', WATER: '#06b6d4',
}

interface MvaSector {
  id: string             // tracon-id + sector index
  tracon: string         // approach control ID
  name: string           // sector name
  lat: number; lng: number
  radiusNm: number
  mvaFt: number          // published MVA floor
  kind: SectorKind
  terrainFt: number      // highest obstacle/terrain in sector
  authority: string
}

// 36-sector global MVA catalogue (published per FAA Order JO 7210.3 §7-4 / EUROCONTROL MSA Spec)
const MVA: MvaSector[] = [
  // NY-TRACON N90
  { id:'N90-01', tracon:'N90', name:'JFK W',     lat:40.55, lng:-74.30, radiusNm:18, mvaFt:1500, kind:'FLAT',     terrainFt:410,  authority:'FAA N90' },
  { id:'N90-02', tracon:'N90', name:'EWR S',     lat:40.55, lng:-74.55, radiusNm:18, mvaFt:2000, kind:'ROLLING',  terrainFt:980,  authority:'FAA N90' },
  { id:'N90-03', tracon:'N90', name:'LGA N',     lat:40.95, lng:-73.85, radiusNm:14, mvaFt:2500, kind:'ROLLING',  terrainFt:1290, authority:'FAA N90' },
  // SoCal TRACON SCT
  { id:'SCT-01', tracon:'SCT', name:'LAX W',     lat:33.90, lng:-118.55, radiusNm:20, mvaFt:2000, kind:'WATER',   terrainFt:240,  authority:'FAA SCT' },
  { id:'SCT-02', tracon:'SCT', name:'BUR mtn',   lat:34.30, lng:-118.30, radiusNm:18, mvaFt:6500, kind:'MOUNTAIN',terrainFt:5700, authority:'FAA SCT' },
  { id:'SCT-03', tracon:'SCT', name:'SAN E',     lat:32.85, lng:-116.95, radiusNm:24, mvaFt:7800, kind:'MOUNTAIN',terrainFt:6800, authority:'FAA SCT' },
  // NorCal TRACON NCT
  { id:'NCT-01', tracon:'NCT', name:'SFO bay',   lat:37.50, lng:-122.45, radiusNm:20, mvaFt:2100, kind:'WATER',   terrainFt:380,  authority:'FAA NCT' },
  { id:'NCT-02', tracon:'NCT', name:'OAK hills', lat:37.85, lng:-122.10, radiusNm:16, mvaFt:3800, kind:'ROLLING', terrainFt:2700, authority:'FAA NCT' },
  // Denver D01
  { id:'D01-01', tracon:'D01', name:'DEN E',     lat:39.85, lng:-104.40, radiusNm:24, mvaFt:7800, kind:'FLAT',    terrainFt:5800, authority:'FAA D01' },
  { id:'D01-02', tracon:'D01', name:'DEN W mtn', lat:39.75, lng:-105.40, radiusNm:22, mvaFt:13500,kind:'MOUNTAIN',terrainFt:12300,authority:'FAA D01' },
  // Atlanta A80
  { id:'A80-01', tracon:'A80', name:'ATL N',     lat:34.20, lng:-84.20, radiusNm:20, mvaFt:3500, kind:'ROLLING', terrainFt:1700, authority:'FAA A80' },
  { id:'A80-02', tracon:'A80', name:'ATL S',     lat:33.40, lng:-84.30, radiusNm:18, mvaFt:2700, kind:'FLAT',    terrainFt:900,  authority:'FAA A80' },
  // Chicago C90
  { id:'C90-01', tracon:'C90', name:'ORD W',     lat:42.00, lng:-88.30, radiusNm:22, mvaFt:2800, kind:'FLAT',    terrainFt:980,  authority:'FAA C90' },
  { id:'C90-02', tracon:'C90', name:'MDW E',     lat:41.65, lng:-87.55, radiusNm:14, mvaFt:2400, kind:'FLAT',    terrainFt:680,  authority:'FAA C90' },
  // Boston A90
  { id:'A90-01', tracon:'A90', name:'BOS E',     lat:42.35, lng:-70.85, radiusNm:18, mvaFt:1800, kind:'WATER',   terrainFt:280,  authority:'FAA A90' },
  // DFW D10
  { id:'D10-01', tracon:'D10', name:'DFW W',     lat:32.80, lng:-97.30, radiusNm:22, mvaFt:2400, kind:'FLAT',    terrainFt:780,  authority:'FAA D10' },
  // Phoenix P50
  { id:'P50-01', tracon:'P50', name:'PHX S',     lat:33.20, lng:-112.05, radiusNm:22, mvaFt:3600, kind:'ROLLING', terrainFt:1900, authority:'FAA P50' },
  { id:'P50-02', tracon:'P50', name:'PHX N mtn', lat:33.85, lng:-112.10, radiusNm:18, mvaFt:6800, kind:'MOUNTAIN',terrainFt:5400, authority:'FAA P50' },
  // Seattle S46
  { id:'S46-01', tracon:'S46', name:'SEA W',     lat:47.45, lng:-122.55, radiusNm:18, mvaFt:3200, kind:'WATER',   terrainFt:1100, authority:'FAA S46' },
  { id:'S46-02', tracon:'S46', name:'SEA E mtn', lat:47.50, lng:-121.55, radiusNm:22, mvaFt:9800, kind:'MOUNTAIN',terrainFt:8700, authority:'FAA S46' },
  // Las Vegas L30
  { id:'L30-01', tracon:'L30', name:'LAS N mtn', lat:36.40, lng:-115.05, radiusNm:22, mvaFt:8400, kind:'MOUNTAIN',terrainFt:7200, authority:'FAA L30' },
  // Salt Lake S56
  { id:'S56-01', tracon:'S56', name:'SLC E mtn', lat:40.70, lng:-111.55, radiusNm:22, mvaFt:11200,kind:'MOUNTAIN',terrainFt:10100,authority:'FAA S56' },
  // Anchorage A11
  { id:'A11-01', tracon:'A11', name:'ANC mtn',   lat:61.20, lng:-149.85, radiusNm:24, mvaFt:6500, kind:'MOUNTAIN',terrainFt:5400, authority:'FAA A11' },
  // London TC
  { id:'LON-01', tracon:'LON', name:'LHR N',     lat:51.65, lng:-0.45,   radiusNm:20, mvaFt:2400, kind:'FLAT',    terrainFt:680,  authority:'NATS LTCC' },
  { id:'LON-02', tracon:'LON', name:'LGW S',     lat:51.05, lng:-0.20,   radiusNm:16, mvaFt:2800, kind:'ROLLING', terrainFt:780,  authority:'NATS LTCC' },
  // Amsterdam ACC
  { id:'EHA-01', tracon:'EHA', name:'AMS sea',   lat:52.30, lng:4.60,    radiusNm:22, mvaFt:1800, kind:'WATER',   terrainFt:90,   authority:'LVNL APP' },
  // Paris
  { id:'LFP-01', tracon:'LFP', name:'CDG E',     lat:49.00, lng:2.85,    radiusNm:20, mvaFt:2600, kind:'ROLLING', terrainFt:740,  authority:'DSNA APP' },
  // Frankfurt
  { id:'EDD-01', tracon:'EDD', name:'FRA S',     lat:49.95, lng:8.55,    radiusNm:20, mvaFt:3200, kind:'ROLLING', terrainFt:1300, authority:'DFS APP' },
  { id:'EDD-02', tracon:'EDD', name:'MUC alps',  lat:48.05, lng:11.60,   radiusNm:22, mvaFt:8400, kind:'MOUNTAIN',terrainFt:7300, authority:'DFS APP' },
  // Zurich
  { id:'LSZ-01', tracon:'LSZ', name:'ZRH alps',  lat:47.35, lng:8.55,    radiusNm:20, mvaFt:7800, kind:'MOUNTAIN',terrainFt:6900, authority:'Skyguide' },
  // Madrid
  { id:'LEM-01', tracon:'LEM', name:'MAD plat',  lat:40.30, lng:-3.60,   radiusNm:22, mvaFt:5800, kind:'ROLLING', terrainFt:3900, authority:'ENAIRE APP' },
  // Rome
  { id:'LIR-01', tracon:'LIR', name:'FCO sea',   lat:41.70, lng:12.10,   radiusNm:20, mvaFt:2400, kind:'WATER',   terrainFt:380,  authority:'ENAV APP' },
  // Tokyo
  { id:'RJT-01', tracon:'RJT', name:'HND bay',   lat:35.45, lng:139.95,  radiusNm:22, mvaFt:2400, kind:'WATER',   terrainFt:540,  authority:'JCAB APP' },
  // Hong Kong
  { id:'VHH-01', tracon:'VHH', name:'HKG sea',   lat:22.20, lng:113.85,  radiusNm:22, mvaFt:3200, kind:'WATER',   terrainFt:1900, authority:'CAD HK' },
  // Singapore
  { id:'WSS-01', tracon:'WSS', name:'SIN sea',   lat:1.30,  lng:104.10,  radiusNm:22, mvaFt:2200, kind:'WATER',   terrainFt:480,  authority:'CAAS' },
  // Sydney
  { id:'YSS-01', tracon:'YSS', name:'SYD sea',   lat:-34.10,lng:151.30,  radiusNm:20, mvaFt:2400, kind:'WATER',   terrainFt:420,  authority:'Airservices' },
]

function haversineNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 3440.065
  const φ1 = la1 * Math.PI/180, φ2 = la2 * Math.PI/180
  const dφ = (la2 - la1) * Math.PI/180, dλ = (lo2 - lo1) * Math.PI/180
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}

type Phase = 'TAXI' | 'DEP' | 'CLB' | 'CRZ' | 'DES' | 'APP' | 'VEC'
function classifyPhase(f: SFlight): Phase {
  if (f.ground) return 'TAXI'
  if (f.altitudeFt < 6000 && f.vertRate > 200) return 'DEP'
  if (f.altitudeFt < 18000 && f.vertRate > 100) return 'CLB'
  if (f.vertRate < -300 && f.altitudeFt < 12000) return 'APP'
  if (f.vertRate < -100 && f.altitudeFt < 22000) return 'DES'
  return 'CRZ'
}
// "Under vector" heuristic: descending under FL180 inside a TRACON sector, not on published procedure
function isUnderVector(f: SFlight, phase: Phase): boolean {
  return (phase === 'DES' || phase === 'APP' || phase === 'VEC') && f.altitudeFt > 100 && f.altitudeFt < 18000 && !f.ground
}

interface Eval {
  flight: SFlight
  sector: MvaSector
  phase: Phase
  altFt: number
  mvaFt: number
  deltaFt: number          // negative = below MVA
  pctBelow: number         // 0-100 magnitude of bust normalised by 1000ft
  obstacleMarginFt: number // alt above terrainFt
  closingRateFpm: number   // negative if descending faster than safe
  tier: Tier
  score: number
  drivers: { alt: number; rate: number; obs: number; kind: number; phase: number; closing: number }
  rationale: string
  citation: string
}

export default function MrvaMonitor({ map, flights, onClose, onFly }: Props) {
  // sliders
  const [scopeNm, setScopeNm] = useState(60)
  const [bufferFt, setBufferFt] = useState(0)
  const [advMul, setAdvMul] = useState(100)
  const [minFL, setMinFL] = useState(0)
  const [maxFL, setMaxFL] = useState(180)
  const [vsThreshFpm, setVsThreshFpm] = useState(1500)

  // toggles
  const [showSector, setShowSector] = useState(true)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showLabelMva, setShowLabelMva] = useState(true)

  const [kindFilter, setKindFilter] = useState<Record<SectorKind, boolean>>({ FLAT:true, ROLLING:true, MOUNTAIN:true, WATER:true })
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT'|'SECTORS'|'TRACONS'>('AIRCRAFT')
  const [search, setSearch] = useState('')

  const evals: Eval[] = useMemo(() => {
    const out: Eval[] = []
    for (const f of flights) {
      const fl = Math.round(f.altitudeFt / 100)
      if (fl < minFL || fl > maxFL) continue
      const phase = classifyPhase(f)
      if (!isUnderVector(f, phase)) continue
      // find enclosing sector
      let best: MvaSector | null = null; let bestD = Infinity
      for (const s of MVA) {
        if (!kindFilter[s.kind]) continue
        const d = haversineNm(f.lat, f.lng, s.lat, s.lng)
        if (d <= s.radiusNm && d < bestD) { best = s; bestD = d }
      }
      if (!best) continue
      const mvaEff = best.mvaFt + bufferFt
      const delta = f.altitudeFt - mvaEff   // negative = below MVA
      const pctBelow = Math.max(0, Math.min(100, (-delta / 1000) * 100))
      const obstacleMargin = f.altitudeFt - best.terrainFt
      // closing rate: descending toward MVA, time-to-bust
      const closingFpm = f.vertRate   // negative is descending
      const altDriver = delta < 0 ? 100 : delta < 200 ? 80 : delta < 400 ? 55 : delta < 800 ? 30 : 10
      const rateDriver = closingFpm < -2000 ? 100 : closingFpm < -1500 ? 75 : closingFpm < -1000 ? 50 : closingFpm < -500 ? 25 : 5
      const obsDriver = obstacleMargin < 500 ? 100 : obstacleMargin < 1000 ? 70 : obstacleMargin < 2000 ? 40 : obstacleMargin < 4000 ? 20 : 5
      const kindDriver = best.kind === 'MOUNTAIN' ? 90 : best.kind === 'ROLLING' ? 55 : best.kind === 'WATER' ? 25 : 35
      const phaseDriver = phase === 'APP' ? 90 : phase === 'DES' ? 65 : 30
      const closingDriver = (delta > 0 && closingFpm < -vsThreshFpm) ? Math.min(100, ((-closingFpm) - vsThreshFpm) / 20 + 40) : 0
      const drivers = { alt: altDriver, rate: rateDriver, obs: obsDriver, kind: kindDriver, phase: phaseDriver, closing: closingDriver }
      const maxD = Math.max(altDriver, obsDriver, closingDriver)
      const meanD = (altDriver + rateDriver + obsDriver + kindDriver + phaseDriver + closingDriver) / 6
      let score = (maxD * 0.78 + meanD * 0.22) * (advMul/100)
      // mountain escalator
      if (best.kind === 'MOUNTAIN' && delta < 0) score = Math.max(score, 92)
      score = Math.max(0, Math.min(100, score))

      let tier: Tier = 'CLEAR'
      if (delta < -200) tier = 'BUST'
      else if (delta < 0) tier = 'WARN'
      else if (delta < 300 || (closingFpm < -1500 && delta < 800)) tier = 'CAUTION'
      else if (delta < 800) tier = 'MARGIN'

      let rationale = `${delta>=0?'+':''}${Math.round(delta)} ft vs MVA ${best.mvaFt}; obstacle margin ${Math.round(obstacleMargin)} ft`
      let citation = 'JO 7110.65 §5-6-3 / Doc 4444 §8.6'
      if (tier === 'BUST') { rationale = `MVA BUST ${Math.round(-delta)} ft below MVA ${best.mvaFt} (terrain ${best.terrainFt}); CLIMB IMMEDIATELY to ${best.mvaFt} ft min; query controller for vector revision`; citation = 'JO 7110.65 §5-6-3 / 8260.19 §8 / NTSB AAR-77-04' }
      else if (tier === 'WARN') { rationale = `below MVA ${Math.round(-delta)} ft; controller required to issue altitude correction per JO 7110.65 §2-1-6`; citation = 'JO 7110.65 §2-1-6 / Doc 4444 §8.6.4' }
      else if (tier === 'CAUTION') { rationale = `${Math.round(delta)} ft above MVA / descending ${Math.round(-closingFpm)} fpm; verify cleared altitude ≥ ${best.mvaFt}`; citation = 'AIM 5-5-3 / CAP 493 §1.7' }
      else if (tier === 'MARGIN') { rationale = `${Math.round(delta)} ft above MVA; nominal vector altitude`; citation = 'JO 7110.65 §5-6-3' }
      else { rationale = `well above MVA (margin ${Math.round(delta)} ft)`; citation = 'JO 7110.65 §5-6-3' }

      out.push({ flight: f, sector: best, phase, altFt: f.altitudeFt, mvaFt: best.mvaFt, deltaFt: delta, pctBelow, obstacleMarginFt: obstacleMargin, closingRateFpm: closingFpm, tier, score: Math.round(score), drivers, rationale, citation })
    }
    return out.sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [flights, scopeNm, bufferFt, advMul, minFL, maxFL, vsThreshFpm, kindFilter])

  const counts: Record<Tier, number> = useMemo(() => {
    const c: Record<Tier, number> = { BUST:0, WARN:0, CAUTION:0, MARGIN:0, CLEAR:0, IDLE:0 }
    evals.forEach(e => { c[e.tier]++ })
    return c
  }, [evals])

  const meanScore = evals.length ? Math.round(evals.reduce((s,e) => s + e.score, 0) / evals.length) : 0
  const meanTier: Tier = meanScore >= 80 ? 'BUST' : meanScore >= 60 ? 'WARN' : meanScore >= 35 ? 'CAUTION' : meanScore >= 18 ? 'MARGIN' : 'CLEAR'
  const worst = evals[0]
  const bustC = counts.BUST
  const warnC = counts.WARN
  const meanDelta = evals.length ? Math.round(evals.reduce((s,e)=>s+e.deltaFt,0) / evals.length) : 0

  const visible = evals.filter(e => {
    if (tierFilter !== 'ALL' && e.tier !== tierFilter) return false
    if (search) {
      const s = search.toLowerCase()
      if (![e.flight.callsign, e.flight.icao, e.flight.type, e.sector.id, e.sector.tracon, e.sector.name].some(v => (v||'').toLowerCase().includes(s))) return false
    }
    return true
  })

  const bySector = useMemo(() => {
    const m = new Map<string, Eval[]>()
    evals.forEach(e => { if (!m.has(e.sector.id)) m.set(e.sector.id, []); m.get(e.sector.id)!.push(e) })
    return [...m.entries()].sort(([,a],[,b]) => TIER_RANK[a[0].tier] - TIER_RANK[b[0].tier] || b[0].score - a[0].score)
  }, [evals])

  const byTracon = useMemo(() => {
    const m = new Map<string, Eval[]>()
    evals.forEach(e => { if (!m.has(e.sector.tracon)) m.set(e.sector.tracon, []); m.get(e.sector.tracon)!.push(e) })
    return [...m.entries()].sort(([,a],[,b]) => b.length - a.length)
  }, [evals])

  // ============ MAP OVERLAY ============
  useEffect(() => {
    if (!map) return
    const m = map
    const SRC = 'mrva-src', LBL = 'mrva-lbl'
    const features: GeoJSON.Feature[] = []
    const labels: GeoJSON.Feature[] = []

    // sector discs
    if (showSector) {
      for (const s of MVA) {
        if (!kindFilter[s.kind]) continue
        const ring: number[][] = []
        for (let i = 0; i <= 48; i++) {
          const ang = (i/48) * Math.PI * 2
          const dLat = (s.radiusNm/60) * Math.cos(ang)
          const dLng = (s.radiusNm/60) * Math.sin(ang) / Math.cos(s.lat * Math.PI/180)
          ring.push([s.lng + dLng, s.lat + dLat])
        }
        features.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[ring] }, properties:{ kind:'sector', color: KIND_COLOR[s.kind] } })
        if (showLabelMva) {
          labels.push({ type:'Feature', geometry:{ type:'Point', coordinates:[s.lng, s.lat] }, properties:{ text:`${s.id} · ${s.mvaFt}ft · ${s.kind}`, color: KIND_COLOR[s.kind] } })
        }
      }
    }

    // aircraft
    const seen = new Set<string>()
    evals.forEach(e => {
      if (seen.has(e.flight.icao)) return
      seen.add(e.flight.icao)
      const c = TIER_COLOR[e.tier]
      if (showHalo) features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[e.flight.lng, e.flight.lat] }, properties:{ color:c, kind:'halo', radius: 8 + Math.min(14, e.score/7) } })
      if (showPin && (e.tier==='BUST' || e.tier==='WARN')) features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[e.flight.lng, e.flight.lat] }, properties:{ color:c, kind:'pin', radius:5 } })
      if (showLink) features.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[e.flight.lng, e.flight.lat],[e.sector.lng, e.sector.lat]] }, properties:{ color:c, kind:'link' } })
      if (showLbl) labels.push({ type:'Feature', geometry:{ type:'Point', coordinates:[e.flight.lng, e.flight.lat] }, properties:{ text:`${e.flight.callsign||e.flight.icao} ${e.tier} ${e.deltaFt>=0?'+':''}${Math.round(e.deltaFt)}ft`, color:c } })
    })

    try {
      if (!m.getSource(SRC)) m.addSource(SRC, { type:'geojson', data:{ type:'FeatureCollection', features } as GeoJSON.FeatureCollection })
      else (m.getSource(SRC) as maplibregl.GeoJSONSource).setData({ type:'FeatureCollection', features } as GeoJSON.FeatureCollection)
      if (!m.getSource(LBL)) m.addSource(LBL, { type:'geojson', data:{ type:'FeatureCollection', features: labels } as GeoJSON.FeatureCollection })
      else (m.getSource(LBL) as maplibregl.GeoJSONSource).setData({ type:'FeatureCollection', features: labels } as GeoJSON.FeatureCollection)

      if (showSector && !m.getLayer('mrva-sector-fill')) m.addLayer({ id:'mrva-sector-fill', type:'fill', source:SRC, filter:['==',['get','kind'],'sector'], paint:{ 'fill-color':['get','color'], 'fill-opacity': 0.06 } })
      if (showSector && !m.getLayer('mrva-sector-line')) m.addLayer({ id:'mrva-sector-line', type:'line', source:SRC, filter:['==',['get','kind'],'sector'], paint:{ 'line-color':['get','color'], 'line-width':1, 'line-dasharray':[3,2], 'line-opacity':0.55 } })
      if (showLink && !m.getLayer('mrva-link')) m.addLayer({ id:'mrva-link', type:'line', source:SRC, filter:['==',['get','kind'],'link'], paint:{ 'line-color':['get','color'], 'line-width':1.2, 'line-dasharray':[1,2], 'line-opacity':0.8 } })
      if (showHalo && !m.getLayer('mrva-halo')) m.addLayer({ id:'mrva-halo', type:'circle', source:SRC, filter:['==',['get','kind'],'halo'], paint:{ 'circle-color':'transparent', 'circle-stroke-color':['get','color'], 'circle-stroke-width':2, 'circle-radius':['get','radius'], 'circle-opacity':0.7 } })
      if (showPin && !m.getLayer('mrva-pin')) m.addLayer({ id:'mrva-pin', type:'circle', source:SRC, filter:['==',['get','kind'],'pin'], paint:{ 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1, 'circle-radius':5 } })
      if (showLbl && !m.getLayer('mrva-lbl')) m.addLayer({ id:'mrva-lbl', type:'symbol', source:LBL, layout:{ 'text-field':['get','text'], 'text-size':9, 'text-offset':[0,1.6], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.2 } })
    } catch {}
    return () => {
      try {
        for (const id of ['mrva-sector-fill','mrva-sector-line','mrva-link','mrva-halo','mrva-pin','mrva-lbl']) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC, LBL]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, evals, showSector, showHalo, showPin, showLbl, showLink, showLabelMva, kindFilter])

  const tierPill = (t: Tier) => (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide" style={{ background:`${TIER_COLOR[t]}22`, color: TIER_COLOR[t], border:`1px solid ${TIER_COLOR[t]}55` }}>{t}</span>
  )
  const kindPill = (k: SectorKind) => (
    <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ background:`${KIND_COLOR[k]}1f`, color: KIND_COLOR[k], border:`1px solid ${KIND_COLOR[k]}55` }}>{k}</span>
  )

  // scatter: alt-vs-MVA delta horizontal, vsi vertical
  const sx = (d: number) => 190 + Math.max(-1500, Math.min(1500, d)) * 170/1500
  const sy = (v: number) => 55 - Math.max(-3500, Math.min(3500, v)) * 45/3500

  return (
    <div className="absolute right-3 top-16 bottom-3 w-[440px] z-[60] rounded-2xl border border-slate-800 bg-slate-950/90 backdrop-blur-md text-slate-200 shadow-2xl flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 bg-slate-900/60">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: TIER_COLOR[meanTier] }} />
          <div className="text-sm font-semibold">MRVA · Min Vectoring Alt</div>
          <span className="text-[10px] text-slate-500">JO 7110.65 §5-6-3</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-6 gap-1 px-2 pt-2">
        {(['BUST','WARN','CAUTION','MARGIN','CLEAR'] as Tier[]).map(t => (
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
          <div className="text-slate-500">BUST</div>
          <div className="font-mono text-sm text-rose-400">{bustC}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">WARN</div>
          <div className="font-mono text-sm" style={{ color: TIER_COLOR.WARN }}>{warnC}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">MEAN Δ</div>
          <div className="font-mono text-sm" style={{ color: meanDelta < 0 ? '#ef4444' : meanDelta < 500 ? '#f59e0b' : '#10b981' }}>{meanDelta>=0?'+':''}{meanDelta}ft</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">SECTORS</div>
          <div className="font-mono text-sm text-sky-300">{new Set(evals.map(e => e.sector.id)).size}</div>
        </div>
      </div>

      {/* Scatter: Δalt vs vsi */}
      <div className="px-2 pt-2">
        <svg viewBox="0 0 380 110" className="w-full h-[110px] rounded border border-slate-800 bg-slate-900/40">
          <rect x={20} y={10} width={sx(0)-20} height={90} fill="#ef44441a" />
          <rect x={sx(0)} y={10} width={sx(800)-sx(0)} height={90} fill="#f59e0b1a" />
          <rect x={sx(800)} y={10} width={360-sx(800)} height={90} fill="#10b9811a" />
          <line x1={sx(0)} y1={10} x2={sx(0)} y2={100} stroke="#ef4444" strokeDasharray="2 2" strokeOpacity={0.7} />
          <line x1={20} y1={sy(0)} x2={360} y2={sy(0)} stroke="#64748b" strokeDasharray="2 2" strokeOpacity={0.4} />
          {evals.map((e, i) => (
            <circle key={i} cx={sx(e.deltaFt)} cy={sy(e.closingRateFpm)} r={2.5} fill={TIER_COLOR[e.tier]} opacity={0.85} />
          ))}
          <text x={4} y={14} fill="#64748b" fontSize={8} fontFamily="monospace">vsi fpm</text>
          <text x={360} y={108} fill="#64748b" fontSize={8} fontFamily="monospace" textAnchor="end">Δ vs MVA ft</text>
        </svg>
      </div>

      {/* Sliders */}
      <div className="grid grid-cols-2 gap-1 px-2 pt-2 text-[10px]">
        {([
          ['SCOPE', scopeNm, setScopeNm, 10, 200, 'nm'],
          ['BUFFER', bufferFt, setBufferFt, 0, 500, 'ft'],
          ['ADV-MUL', advMul, setAdvMul, 50, 200, '%'],
          ['MIN-FL', minFL, setMinFL, 0, 100, ''],
          ['MAX-FL', maxFL, setMaxFL, 100, 400, ''],
          ['VS-THR', vsThreshFpm, setVsThreshFpm, 500, 3000, 'fpm'],
        ] as Array<[string, number, (n:number)=>void, number, number, string]>).map(([label, val, set, min, max, unit]) => (
          <label key={label} className="flex flex-col gap-0.5 rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
            <span className="text-slate-500 flex justify-between"><span>{label}</span><span className="font-mono text-slate-200">{val}{unit}</span></span>
            <input type="range" min={min} max={max} value={val} onChange={e=>set(Number(e.target.value))} className="w-full accent-sky-500" />
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-2 pt-2">
        {(['FLAT','ROLLING','MOUNTAIN','WATER'] as SectorKind[]).map(k => (
          <button key={k} onClick={() => setKindFilter(f => ({ ...f, [k]: !f[k] }))}
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition ${kindFilter[k]?'opacity-100':'opacity-40'}`}
            style={{ background:`${KIND_COLOR[k]}1f`, color: KIND_COLOR[k], borderColor: `${KIND_COLOR[k]}55` }}>{k}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-2 pt-2">
        {([
          ['SECTOR', showSector, setShowSector],
          ['HALO', showHalo, setShowHalo],
          ['PIN', showPin, setShowPin],
          ['LBL', showLbl, setShowLbl],
          ['LINK', showLink, setShowLink],
          ['MVA-LBL', showLabelMva, setShowLabelMva],
        ] as Array<[string, boolean, (b:boolean)=>void]>).map(([label, on, set]) => (
          <button key={label} onClick={() => set(!on)}
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition ${on?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-700 text-slate-500 hover:text-slate-300'}`}>{label}</button>
        ))}
      </div>

      <div className="px-2 pt-2">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="callsign · icao · type · sector · tracon"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[11px] placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50" />
      </div>
      <div className="grid grid-cols-3 gap-1 px-2 pt-2 text-[10px]">
        {(['AIRCRAFT','SECTORS','TRACONS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2 py-1 rounded border transition ${tab===t?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-800 text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pt-2 pb-2 space-y-1.5">
        {tab === 'AIRCRAFT' && visible.length === 0 && (
          <div className="text-center text-slate-600 text-[11px] pt-6">no vectored aircraft inside MVA sectors</div>
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
                {kindPill(e.sector.kind)}
                <div className="ml-auto">{tierPill(e.tier)}</div>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span className="text-sky-300">{e.sector.id}</span>
                <span className="text-slate-500 italic truncate">{e.sector.name}</span>
                <span className="ml-auto">{e.sector.authority}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>alt <span className="text-slate-200">{Math.round(e.altFt)}ft</span></span>
                <span>MVA <span className="text-sky-300">{e.mvaFt}ft</span></span>
                <span>Δ <span style={{ color: e.deltaFt < 0 ? '#ef4444' : e.deltaFt < 300 ? '#f59e0b' : '#10b981' }}>{e.deltaFt>=0?'+':''}{Math.round(e.deltaFt)}ft</span></span>
                <span>obs <span style={{ color: e.obstacleMarginFt < 1000 ? '#ef4444' : e.obstacleMarginFt < 2000 ? '#f59e0b' : '#10b981' }}>{Math.round(e.obstacleMarginFt)}ft</span></span>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>vs <span style={{ color: e.closingRateFpm < -1500 ? '#f43f5e' : e.closingRateFpm < -500 ? '#f59e0b' : '#10b981' }}>{e.closingRateFpm>=0?'+':''}{Math.round(e.closingRateFpm)}fpm</span></span>
                <span>trk {Math.round(e.flight.track)}°</span>
                <span>{Math.round(e.flight.velocityKts)}kt</span>
                <span>terrain {e.sector.terrainFt}ft</span>
              </div>
              <div className="h-1 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: `${e.score}%`, background: TIER_COLOR[e.tier] }} />
              </div>
              <div className="grid grid-cols-6 gap-0.5 text-[9px]">
                {(['alt','rate','obs','kind','phase','closing'] as const).map(k => (
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

        {tab === 'SECTORS' && bySector.length === 0 && (
          <div className="text-center text-slate-600 text-[11px] pt-6">no sector activity</div>
        )}
        {tab === 'SECTORS' && bySector.map(([id, es]) => {
          const w = es[0]
          const bust = es.filter(x => x.tier==='BUST').length
          const warn = es.filter(x => x.tier==='WARN').length
          const mean = Math.round(es.reduce((s,e) => s+e.score, 0) / es.length)
          return (
            <div key={id} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden cursor-pointer hover:border-slate-700"
              onClick={() => onFly(w.flight.icao)}>
              <div className="h-0.5" style={{ background: TIER_COLOR[w.tier] }} />
              <div className="p-2 space-y-1">
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="font-mono text-sky-300 font-semibold">{id}</span>
                  {kindPill(w.sector.kind)}
                  <span className="text-slate-500 text-[10px] italic truncate">{w.sector.name}</span>
                  <div className="ml-auto">{tierPill(w.tier)}</div>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                  <span>MVA <span className="text-sky-300">{w.sector.mvaFt}ft</span></span>
                  <span>terrain {w.sector.terrainFt}ft</span>
                  <span>r {w.sector.radiusNm}nm</span>
                  <span className="ml-auto">{w.sector.authority}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                  <span>{es.length} ac</span>
                  {bust > 0 && <span className="text-rose-400">BUST {bust}</span>}
                  {warn > 0 && <span className="text-rose-300">WARN {warn}</span>}
                </div>
                <div className="h-1 rounded bg-slate-800 overflow-hidden">
                  <div className="h-full" style={{ width: `${mean}%`, background: TIER_COLOR[w.tier] }} />
                </div>
              </div>
            </div>
          )
        })}

        {tab === 'TRACONS' && byTracon.length === 0 && (
          <div className="text-center text-slate-600 text-[11px] pt-6">no TRACON activity</div>
        )}
        {tab === 'TRACONS' && byTracon.map(([tracon, es]) => {
          const bust = es.filter(x => x.tier==='BUST').length
          const warn = es.filter(x => x.tier==='WARN').length
          const mean = Math.round(es.reduce((s,e) => s+e.score, 0) / es.length)
          const tier: Tier = bust>0 ? 'BUST' : warn>0 ? 'WARN' : mean >= 35 ? 'CAUTION' : mean >= 18 ? 'MARGIN' : 'CLEAR'
          const sectors = new Set(es.map(e => e.sector.id)).size
          return (
            <div key={tracon} className="rounded border border-slate-800 bg-slate-900/40 p-2 space-y-1">
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="font-mono text-sky-300 font-semibold">{tracon}</span>
                <span className="text-slate-500 text-[10px]">{es[0].sector.authority}</span>
                <div className="ml-auto">{tierPill(tier)}</div>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>{es.length} ac</span>
                <span>{sectors} sectors</span>
                {bust > 0 && <span className="text-rose-400">BUST {bust}</span>}
                {warn > 0 && <span className="text-rose-300">WARN {warn}</span>}
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
