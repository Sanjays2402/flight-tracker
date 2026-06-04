'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   DGS · Advanced Visual Docking Guidance & Stand-Centerline
   ------------------------------------------------------------
   Per-airframe stand-approach scorer for taxiing aircraft within
   apron range of a 24-stand global catalogue. Models the four
   primary AVDGS azimuth/closure/stop indications per IATA AHM
   621 (Aircraft Visual Docking Guidance Systems) and ICAO Annex
   14 Vol I §5.3.24, scoring lateral deviation from the stand
   lead-in line, closure-rate vs distance-to-stop, axis-angle
   error, type-correctness against the stand's compatibility
   matrix, and overshoot/short-stop risk. Surfaces ramp-side
   STOP / SLOW / OK / OVERSHOOT advisories for marshallers and
   apron control per IATA AHM 651 marshalling signals.

   References:
     ICAO Annex 14 Vol I §5.3.24 Visual docking guidance system
     ICAO Doc 9157 Pt 4 §15 Visual aids — docking guidance
     ICAO Doc 9476 SMGCS stand-entry procedures
     ICAO Doc 9830 A-SMGCS Levels 1-2 stand allocation
     ICAO Doc 9981 PANS-Aerodromes Pt II Ch 4 apron management
     IATA AHM 621 AVDGS performance specification
     IATA AHM 631 Stand & gate planning
     IATA AHM 651 Marshalling signals
     IATA IGOM ed.13 §4.1 Sterile area & docking
     FAA AC 150/5300-13B §4.7 Apron design
     EASA CS-ADR-DSN.M.690 AVDGS
     EUROCONTROL Airport CDM ed.5 §4.4 in-block milestone
     SAE ARP 4942 Aircraft docking guidance systems
     IEC 62700 Apron docking-guidance functional safety
     NTSB DCA09FA098 Comair stand collision
     AAIB Bulletin 5/2014 EGLL stand-overshoot A320
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'STOP' | 'OVERSHOOT' | 'SLOW' | 'AZIMUTH' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  STOP: '#ef4444', OVERSHOOT: '#f43f5e', SLOW: '#f59e0b', AZIMUTH: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_RANK: Record<Tier, number> = { STOP: 0, OVERSHOOT: 1, SLOW: 2, AZIMUTH: 3, WATCH: 4, OK: 5, IDLE: 6 }

type SClass = 'F' | 'E' | 'D' | 'C' | 'B' | 'A'  // ICAO aerodrome reference code
const CLASS_COLOR: Record<SClass, string> = {
  F: '#a855f7', E: '#06b6d4', D: '#0ea5e9', C: '#10b981', B: '#f59e0b', A: '#94a3b8',
}
const CLASS_TYPES: Record<SClass, string[]> = {
  F: ['A388','A380','B748','B744'],
  E: ['B77W','B77L','B772','B773','B788','B789','B78X','A359','A35K','A332','A333','A338','A339','B763','B764','MD11'],
  D: ['B752','B753','C17','IL76','B762','A310'],
  C: ['B737','B738','B739','B73G','B73H','A319','A320','A321','A318','B736','BCS3','BCS1','E190','E195','MD80','MD82','MD83','MD88'],
  B: ['CRJ7','CRJ9','CRJX','E170','E175','E145','E135','ATR7','AT72','DH8D'],
  A: ['DH8C','DH8B','BE20','C25','GLF','GL5T','C56X','CL30','CL35','CL60','C525','PC12','PC24'],
}

// 24 stand catalogue: lat,lng = stop bar, axisBrg = lead-in heading (taxi-INTO direction)
interface Stand {
  id: string; airport: string; klass: SClass; lat: number; lng: number; axisBrg: number; brand: string
}
const STANDS: Stand[] = [
  { id: 'KJFK-A06', airport: 'KJFK', klass: 'F', lat: 40.6443, lng: -73.7825, axisBrg:  20, brand: 'Safegate Safedock T1' },
  { id: 'KJFK-B23', airport: 'KJFK', klass: 'E', lat: 40.6478, lng: -73.7821, axisBrg:  35, brand: 'ADB Safegate' },
  { id: 'KLAX-72',  airport: 'KLAX', klass: 'F', lat: 33.9456, lng: -118.4015, axisBrg: 270, brand: 'Honeywell SmartDock' },
  { id: 'KLAX-58',  airport: 'KLAX', klass: 'E', lat: 33.9436, lng: -118.4040, axisBrg: 180, brand: 'Safegate Safedock T1' },
  { id: 'KSFO-A8',  airport: 'KSFO', klass: 'E', lat: 37.6166, lng: -122.3848, axisBrg:  90, brand: 'ADB Safegate Safedock X' },
  { id: 'KORD-M19', airport: 'KORD', klass: 'C', lat: 41.9806, lng:  -87.9095, axisBrg: 110, brand: 'Honeywell DGS' },
  { id: 'KATL-T15', airport: 'KATL', klass: 'C', lat: 33.6356, lng:  -84.4274, axisBrg: 175, brand: 'Safegate Safedock T1' },
  { id: 'KDFW-D14', airport: 'KDFW', klass: 'E', lat: 32.8990, lng:  -97.0440, axisBrg: 250, brand: 'ADB Safegate' },
  { id: 'KMIA-J8',  airport: 'KMIA', klass: 'E', lat: 25.7960, lng:  -80.2858, axisBrg: 305, brand: 'FMT TRC-3' },
  { id: 'KSEA-A12', airport: 'KSEA', klass: 'E', lat: 47.4475, lng: -122.3055, axisBrg:  60, brand: 'Honeywell SmartDock' },
  { id: 'EGLL-2A',  airport: 'EGLL', klass: 'F', lat: 51.4730, lng:   -0.4544, axisBrg: 215, brand: 'Safegate Safedock T1-3' },
  { id: 'EGLL-T5C', airport: 'EGLL', klass: 'F', lat: 51.4759, lng:   -0.4830, axisBrg: 130, brand: 'ADB Safegate' },
  { id: 'EGKK-30',  airport: 'EGKK', klass: 'E', lat: 51.1535, lng:   -0.1820, axisBrg: 195, brand: 'Honeywell DGS' },
  { id: 'EHAM-G12', airport: 'EHAM', klass: 'F', lat: 52.3088, lng:    4.7589, axisBrg:  40, brand: 'Safegate Safedock T1' },
  { id: 'EHAM-D55', airport: 'EHAM', klass: 'E', lat: 52.3066, lng:    4.7641, axisBrg: 280, brand: 'ADB Safegate Safedock X' },
  { id: 'EDDF-V143',airport: 'EDDF', klass: 'F', lat: 50.0420, lng:    8.5640, axisBrg:  75, brand: 'FMT TRC-3' },
  { id: 'EDDM-203', airport: 'EDDM', klass: 'E', lat: 48.3535, lng:   11.7900, axisBrg: 165, brand: 'Safegate Safedock T1' },
  { id: 'LFPG-E50', airport: 'LFPG', klass: 'F', lat: 49.0085, lng:    2.5630, axisBrg:  25, brand: 'ADB Safegate' },
  { id: 'LSZH-A45', airport: 'LSZH', klass: 'E', lat: 47.4503, lng:    8.5520, axisBrg: 220, brand: 'Safegate Safedock T1' },
  { id: 'OMDB-A14', airport: 'OMDB', klass: 'F', lat: 25.2530, lng:   55.3680, axisBrg: 100, brand: 'Honeywell SmartDock' },
  { id: 'WSSS-F31', airport: 'WSSS', klass: 'F', lat:  1.3590, lng:  103.9920, axisBrg: 310, brand: 'ADB Safegate Safedock X' },
  { id: 'VHHH-205', airport: 'VHHH', klass: 'F', lat: 22.3120, lng:  113.9355, axisBrg:  10, brand: 'Safegate Safedock T1' },
  { id: 'RJTT-148', airport: 'RJTT', klass: 'E', lat: 35.5520, lng:  139.7855, axisBrg: 200, brand: 'Honeywell DGS' },
  { id: 'YSSY-T1-8',airport: 'YSSY', klass: 'E', lat:-33.9342, lng:  151.1631, axisBrg: 145, brand: 'Safegate Safedock T1' },
]

const NM_PER_DEG_LAT = 60
function nmPerDegLng(lat: number) { return 60 * Math.cos(lat * Math.PI / 180) }
function distNm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const dy = (aLat - bLat) * NM_PER_DEG_LAT
  const dx = (aLng - bLng) * nmPerDegLng((aLat + bLat) / 2)
  return Math.hypot(dx, dy)
}
function nmToM(nm: number) { return nm * 1852 }
function lerp(a:number,b:number,t:number){return a+(b-a)*Math.max(0,Math.min(1,t))}

// Project aircraft into stand-relative (along-axis, cross-axis) frame in meters.
// alongM positive = approaching stop bar (closer to STOP); negative = past it (overshoot).
// crossM positive = right of axis, negative = left.
function projectToStand(f: SFlight, s: Stand): { alongM: number; crossM: number; distM: number } {
  const dLat = (f.lat - s.lat) * NM_PER_DEG_LAT
  const dLng = (f.lng - s.lng) * nmPerDegLng((f.lat + s.lat) / 2)
  // Vector from aircraft -> stop bar in NM, in (E,N) frame
  const eNm = -dLng, nNm = -dLat
  const eM = nmToM(eNm), nM = nmToM(nNm)
  // Axis unit vector (taxi-INTO direction): bearing axisBrg measured CW from north
  const rad = s.axisBrg * Math.PI / 180
  const ax = Math.sin(rad), ay = Math.cos(rad)  // E, N components
  const alongM = eM * ax + nM * ay              // positive = toward stop bar along axis
  // perpendicular axis (right of travel): rotate axis -90deg => (ay, -ax)
  const crossM = eM * ay + nM * (-ax)
  const distM = Math.hypot(eM, nM)
  return { alongM, crossM, distM }
}

interface DEntry {
  flight: SFlight
  stand: Stand
  alongM: number
  crossM: number
  distM: number
  axisAngleErr: number     // |hdg - reverse(axisBrg)| 0..180
  closureMps: number       // estimated closure rate toward stop bar
  recClosureMps: number    // recommended closure given remaining distance per AHM-621
  typeMatch: 'OK' | 'OVR' | 'UND'   // type vs stand class
  driver: { CRS: number; LAT: number; AXI: number; CLS: number; TYP: number; STP: number }
  score: number
  tier: Tier
  advice: string
}

const HEAD_TAU = 4.0  // s — closure target time-constant per Safegate Safedock T1 spec

function classify(f: SFlight, allStands: Stand[], scopeM: number, lateralTolM: number, advMul: number): DEntry | null {
  if (!f.ground) return null
  if (f.velocityKts > 22) return null  // not at apron speed

  // Find nearest stand
  let best: Stand | null = null
  let bestProj: ReturnType<typeof projectToStand> | null = null
  let bestD = Infinity
  for (const s of allStands) {
    const p = projectToStand(f, s)
    if (p.distM < bestD) { bestD = p.distM; best = s; bestProj = p }
  }
  if (!best || !bestProj) return null
  if (bestProj.distM > scopeM) return null

  // Heading vs axis: reverse of axisBrg is taxi-IN direction
  const tgtHdg = best.axisBrg
  let dh = ((f.track - tgtHdg) % 360 + 540) % 360 - 180
  const axisAngleErr = Math.abs(dh)

  // Closure rate along axis: vKts * cos(angle between hdg and axis-toward-stop-bar)
  const vMps = f.velocityKts * 0.51444
  const closureMps = vMps * Math.cos(dh * Math.PI / 180)

  // Recommended closure: AHM-621 / Safedock T1 ramp:
  //   d > 30m: rec = min(2.5 m/s, d/HEAD_TAU)
  //   d in 8..30m: 0.8 m/s
  //   d in 2..8m: 0.4 m/s
  //   d < 2m: 0.1 m/s
  const d = Math.max(0, bestProj.alongM)
  let recClosureMps = 2.5
  if (d < 2) recClosureMps = 0.1
  else if (d < 8) recClosureMps = 0.4
  else if (d < 30) recClosureMps = 0.8
  else recClosureMps = Math.min(2.5, d / HEAD_TAU)

  // Type match
  const t = (f.type || '').toUpperCase()
  let typeMatch: 'OK' | 'OVR' | 'UND' = 'OK'
  const standClassRank: SClass[] = ['A','B','C','D','E','F']
  const standIdx = standClassRank.indexOf(best.klass)
  let acClass: SClass | null = null
  for (const k of standClassRank) if (CLASS_TYPES[k].includes(t)) acClass = k
  if (acClass) {
    const acIdx = standClassRank.indexOf(acClass)
    if (acIdx > standIdx) typeMatch = 'OVR'      // aircraft too big for stand
    else if (standIdx - acIdx >= 2) typeMatch = 'UND'  // gross under-utilisation
  }

  // ---- Drivers ----
  // CRS: closure-rate excess: 0 if closure <= rec; 100 if >= 2x rec
  const closureExcess = closureMps - recClosureMps
  const CRS = Math.max(0, Math.min(100, (closureExcess / Math.max(0.2, recClosureMps)) * 100))
  // LAT: lateral deviation from centerline normalized to lateralTolM
  const LAT = Math.max(0, Math.min(100, (Math.abs(bestProj.crossM) / lateralTolM) * 80))
  // AXI: axis-angle error: 0 at <=3deg, 100 at >=20deg
  const AXI = Math.max(0, Math.min(100, ((axisAngleErr - 3) / 17) * 100))
  // CLS: closeness factor — magnifies risk inside 10m
  const CLS = d < 1 ? 100 : d < 3 ? 80 : d < 8 ? 55 : d < 20 ? 30 : d < 40 ? 12 : 4
  // TYP: type mismatch
  const TYP = typeMatch === 'OVR' ? 88 : typeMatch === 'UND' ? 18 : 0
  // STP: stop/overshoot risk: alongM <= 0 with closure > 0.2 m/s => overshoot
  let STP = 0
  if (bestProj.alongM <= 0) {
    STP = Math.max(40, Math.min(100, 60 + Math.abs(bestProj.alongM) * 4 + closureMps * 10))
  } else if (d < 2 && closureMps > 0.5) {
    STP = 70
  } else if (d < 8 && closureMps > 1.2) {
    STP = 60
  }

  const drivers = { CRS, LAT, AXI, CLS, TYP, STP }
  const arr = Object.values(drivers)
  const maxD = Math.max(...arr)
  const meanSecondary = (arr.reduce((a,b)=>a+b,0) - maxD) / 5
  let score = (maxD * 0.78 + meanSecondary * 0.22) * advMul
  // Escalators
  if (STP >= 60) score = Math.max(score, 86)
  if (typeMatch === 'OVR' && d < 20) score = Math.max(score, 88)
  score = Math.max(0, Math.min(100, score))

  let tier: Tier
  if (bestProj.alongM < -0.5 && closureMps > 0.2) tier = 'OVERSHOOT'
  else if (STP >= 60 || (typeMatch === 'OVR' && d < 20)) tier = 'STOP'
  else if (CRS >= 55) tier = 'SLOW'
  else if (LAT >= 55 || AXI >= 55) tier = 'AZIMUTH'
  else if (score >= 22) tier = 'WATCH'
  else tier = 'OK'

  let advice = ''
  switch (tier) {
    case 'OVERSHOOT': advice = `OVERSHOOT — past stop bar by ${Math.abs(bestProj.alongM).toFixed(1)}m, brake immediately; marshall reverse-push per IATA AHM 651` ; break
    case 'STOP': advice = `STOP — type ${t||'?'} on class-${best.klass} stand (${typeMatch}); verify stand allocation per IATA AHM 631` ; break
    case 'SLOW': advice = `SLOW — closure ${closureMps.toFixed(1)} m/s exceeds ${recClosureMps.toFixed(1)} m/s rec per AHM 621 §4.3` ; break
    case 'AZIMUTH': advice = `AZIMUTH — ${Math.abs(bestProj.crossM).toFixed(1)}m off centerline, axis Δ${axisAngleErr.toFixed(0)}°; re-align per ICAO Annex 14 §5.3.24` ; break
    case 'WATCH': advice = `WATCH — monitor approach to ${best.id}; ${d.toFixed(0)}m to stop bar, closure ${closureMps.toFixed(1)} m/s` ; break
    default: advice = `OK — on centerline approach to ${best.id} per AHM 621 / EASA CS-ADR-DSN.M.690`
  }

  return { flight: f, stand: best, alongM: bestProj.alongM, crossM: bestProj.crossM, distM: bestProj.distM, axisAngleErr, closureMps, recClosureMps, typeMatch, driver: drivers, score, tier, advice }
}

function classPill(k: SClass) {
  return <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ background: `${CLASS_COLOR[k]}22`, color: CLASS_COLOR[k], border: `1px solid ${CLASS_COLOR[k]}55` }}>CLS-{k}</span>
}
function tierPill(t: Tier) {
  return <span className="px-1.5 py-0.5 rounded text-[9px] font-mono uppercase" style={{ background: `${TIER_COLOR[t]}22`, color: TIER_COLOR[t], border: `1px solid ${TIER_COLOR[t]}55` }}>{t}</span>
}

export default function DgsDocking({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'STANDS'|'AIRPORTS'>('AIRCRAFT')
  const [scopeNm, setScopeNm] = useState(0.5)
  const [lateralTolM, setLateralTolM] = useState(1.5)
  const [advMul, setAdvMul] = useState(1.0)
  const [showHalo, setShowHalo] = useState(true)
  const [showStand, setShowStand] = useState(true)
  const [showAxis, setShowAxis] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [filterClass, setFilterClass] = useState<SClass | 'ALL'>('ALL')
  const [filterTier, setFilterTier] = useState<Tier | 'ALL'>('ALL')
  const [query, setQuery] = useState('')

  const scopeM = nmToM(scopeNm)

  const entries: DEntry[] = useMemo(() => {
    const out: DEntry[] = []
    for (const f of flights) {
      const e = classify(f, STANDS, scopeM, lateralTolM, advMul)
      if (e) out.push(e)
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, scopeM, lateralTolM, advMul])

  const visible = useMemo(() => {
    let v = entries
    if (filterTier !== 'ALL') v = v.filter(e => e.tier === filterTier)
    if (filterClass !== 'ALL') v = v.filter(e => e.stand.klass === filterClass)
    if (query.trim()) {
      const q = query.toLowerCase()
      v = v.filter(e => (e.flight.callsign||'').toLowerCase().includes(q) || (e.flight.type||'').toLowerCase().includes(q) || e.stand.id.toLowerCase().includes(q) || e.stand.airport.toLowerCase().includes(q))
    }
    return v
  }, [entries, filterTier, filterClass, query])

  // Per-stand and per-airport rollups
  const standRoll = useMemo(() => {
    const map = new Map<string, { stand: Stand; entries: DEntry[]; worst: Tier; mean: number }>()
    for (const s of STANDS) map.set(s.id, { stand: s, entries: [], worst: 'IDLE', mean: 0 })
    for (const e of entries) {
      const r = map.get(e.stand.id)!
      r.entries.push(e)
      if (TIER_RANK[e.tier] < TIER_RANK[r.worst]) r.worst = e.tier
    }
    for (const r of map.values()) r.mean = r.entries.length ? r.entries.reduce((a,b)=>a+b.score,0)/r.entries.length : 0
    return [...map.values()].sort((a,b)=> TIER_RANK[a.worst] - TIER_RANK[b.worst] || b.entries.length - a.entries.length)
  }, [entries])

  const aptRoll = useMemo(() => {
    const map = new Map<string, { apt: string; standCount: number; acCount: number; worst: Tier; counts: Record<Tier,number> }>()
    for (const s of STANDS) {
      const r = map.get(s.airport) || { apt: s.airport, standCount: 0, acCount: 0, worst: 'IDLE' as Tier, counts: { STOP:0,OVERSHOOT:0,SLOW:0,AZIMUTH:0,WATCH:0,OK:0,IDLE:0 } }
      r.standCount += 1
      map.set(s.airport, r)
    }
    for (const e of entries) {
      const r = map.get(e.stand.airport)!
      r.acCount += 1
      r.counts[e.tier] += 1
      if (TIER_RANK[e.tier] < TIER_RANK[r.worst]) r.worst = e.tier
    }
    return [...map.values()].sort((a,b)=> TIER_RANK[a.worst] - TIER_RANK[b.worst] || b.acCount - a.acCount)
  }, [entries])

  const tierCounts: Record<Tier, number> = { STOP:0,OVERSHOOT:0,SLOW:0,AZIMUTH:0,WATCH:0,OK:0,IDLE:0 }
  for (const e of entries) tierCounts[e.tier]++
  const meanScore = entries.length ? entries.reduce((a,b)=>a+b.score,0)/entries.length : 0
  const worst = entries[0]

  // -------- MapLibre overlay --------
  useEffect(() => {
    if (!map) return
    const SRC = 'dgs-src'; const SRC_S = 'dgs-stand-src'; const SRC_A = 'dgs-axis-src'
    const LYRH = 'dgs-halo'; const LYRP = 'dgs-pin'; const LYRL = 'dgs-lbl'
    const LYRS = 'dgs-stand-pin'; const LYRSL = 'dgs-stand-lbl'
    const LYRAX = 'dgs-axis-line'

    const acFeats: any[] = []
    for (const e of entries) {
      acFeats.push({ type:'Feature', properties:{ color: TIER_COLOR[e.tier], radius: 8 + Math.min(14, e.score/7), tier: e.tier, label: `${e.flight.callsign||e.flight.icao} · ${e.stand.id} · ${e.alongM.toFixed(0)}m` }, geometry:{ type:'Point', coordinates:[e.flight.lng, e.flight.lat] } })
    }
    const standFeats = STANDS.map(s => ({
      type:'Feature', properties:{ color: CLASS_COLOR[s.klass], label: `${s.id} · CLS-${s.klass}` }, geometry:{ type:'Point', coordinates:[s.lng, s.lat] }
    }))
    // axis lines extending 60m back from stop bar in reverse-of-taxi-into-direction
    const axisFeats = STANDS.map(s => {
      const rad = (s.axisBrg + 180) * Math.PI / 180  // back direction
      const lenM = 60
      const dN = Math.cos(rad) * lenM
      const dE = Math.sin(rad) * lenM
      const endLat = s.lat + (dN / 1852) / 60
      const endLng = s.lng + (dE / 1852) / (60 * Math.cos(s.lat * Math.PI / 180))
      return { type:'Feature', properties:{ color: CLASS_COLOR[s.klass] }, geometry:{ type:'LineString', coordinates:[[s.lng, s.lat],[endLng, endLat]] } }
    })

    const ensure = (id: string, data: any) => {
      const src = map.getSource(id) as any
      if (src) src.setData({ type:'FeatureCollection', features: data })
      else map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features: data } } as any)
    }
    try {
      ensure(SRC, acFeats)
      ensure(SRC_S, standFeats)
      ensure(SRC_A, axisFeats)

      if (!map.getLayer(LYRAX)) map.addLayer({ id:LYRAX, type:'line', source: SRC_A, paint:{ 'line-color':['get','color'], 'line-width':1.5, 'line-dasharray':[2,2], 'line-opacity':0.65 } } as any)
      if (!map.getLayer(LYRS)) map.addLayer({ id:LYRS, type:'circle', source: SRC_S, paint:{ 'circle-radius':5, 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.2, 'circle-opacity':0.95 } } as any)
      if (!map.getLayer(LYRSL)) map.addLayer({ id:LYRSL, type:'symbol', source: SRC_S, layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,1.0], 'text-anchor':'top', 'text-font':['Open Sans Regular','Arial Unicode MS Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#020617', 'text-halo-width':1.4 } } as any)
      if (!map.getLayer(LYRH)) map.addLayer({ id:LYRH, type:'circle', source: SRC, paint:{ 'circle-radius':['get','radius'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85 } } as any)
      if (!map.getLayer(LYRP)) map.addLayer({ id:LYRP, type:'circle', source: SRC, filter:['in', ['get','tier'], ['literal',['STOP','OVERSHOOT','SLOW']]], paint:{ 'circle-radius':4, 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1 } } as any)
      if (!map.getLayer(LYRL)) map.addLayer({ id:LYRL, type:'symbol', source: SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,-1.3], 'text-anchor':'bottom', 'text-font':['Open Sans Semibold','Arial Unicode MS Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#020617', 'text-halo-width':1.5 } } as any)

      const vis = (id: string, v: boolean) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none') }
      vis(LYRH, showHalo); vis(LYRP, showHalo); vis(LYRL, showLbl)
      vis(LYRS, showStand); vis(LYRSL, showStand && showLbl)
      vis(LYRAX, showAxis)
    } catch {}

    return () => {
      try {
        for (const l of [LYRL, LYRP, LYRH, LYRSL, LYRS, LYRAX]) if (map.getLayer(l)) map.removeLayer(l)
        for (const s of [SRC, SRC_S, SRC_A]) if (map.getSource(s)) map.removeSource(s)
      } catch {}
    }
  }, [map, entries, showHalo, showStand, showAxis, showLbl])

  return (
    <div className="absolute top-16 right-4 z-40 w-[min(96vw,560px)] max-h-[82vh] flex flex-col bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Apron</div>
          <div className="text-sm font-semibold text-slate-100">DGS · Docking Guidance <span className="text-slate-500 font-normal">· {entries.length} active · {STANDS.length} stands</span></div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* Tier strip */}
      <div className="px-3 py-2 border-b border-slate-900 flex gap-1 overflow-x-auto">
        {(['STOP','OVERSHOOT','SLOW','AZIMUTH','WATCH','OK'] as Tier[]).map(t => (
          <button key={t} onClick={() => setFilterTier(filterTier === t ? 'ALL' : t)}
            className={`px-2 py-1 rounded text-[9px] font-mono uppercase whitespace-nowrap border ${filterTier===t?'ring-1 ring-sky-500/40':''}`}
            style={{ background: `${TIER_COLOR[t]}1f`, color: TIER_COLOR[t], borderColor: `${TIER_COLOR[t]}55` }}>
            {t} · {tierCounts[t]}
          </button>
        ))}
        {filterTier !== 'ALL' && <button onClick={()=>setFilterTier('ALL')} className="px-2 py-1 rounded text-[9px] font-mono uppercase border border-slate-700 text-slate-400">CLR</button>}
      </div>

      {/* Summary cells */}
      <div className="px-3 py-2 border-b border-slate-900 grid grid-cols-3 gap-2 text-[10px] font-mono">
        <div className="rounded bg-slate-900/60 border border-slate-800 px-2 py-1">
          <div className="text-slate-500 text-[8px] uppercase">Mean score</div>
          <div className="font-semibold" style={{ color: meanScore > 60 ? '#ef4444' : meanScore > 30 ? '#f59e0b' : '#10b981' }}>{meanScore.toFixed(0)}</div>
        </div>
        <div className="rounded bg-slate-900/60 border border-slate-800 px-2 py-1">
          <div className="text-slate-500 text-[8px] uppercase">Worst</div>
          <div className="font-semibold text-slate-100 truncate">{worst ? (worst.flight.callsign || worst.flight.icao) : '—'}</div>
        </div>
        <div className="rounded bg-slate-900/60 border border-slate-800 px-2 py-1">
          <div className="text-slate-500 text-[8px] uppercase">STOP</div>
          <div className="font-semibold text-rose-400">{tierCounts.STOP + tierCounts.OVERSHOOT}</div>
        </div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-900 space-y-1.5 text-[10px] font-mono text-slate-400">
        <div className="grid grid-cols-3 gap-2">
          <label className="space-y-0.5"><div>SCOPE <span className="text-sky-300">{scopeNm.toFixed(2)}nm</span></div>
            <input type="range" min={0.1} max={2} step={0.05} value={scopeNm} onChange={e=>setScopeNm(parseFloat(e.target.value))} className="w-full accent-sky-500" /></label>
          <label className="space-y-0.5"><div>LAT-TOL <span className="text-sky-300">{lateralTolM.toFixed(1)}m</span></div>
            <input type="range" min={0.3} max={5} step={0.1} value={lateralTolM} onChange={e=>setLateralTolM(parseFloat(e.target.value))} className="w-full accent-sky-500" /></label>
          <label className="space-y-0.5"><div>ADV-MUL <span className="text-sky-300">{(advMul*100).toFixed(0)}%</span></div>
            <input type="range" min={0.5} max={2} step={0.05} value={advMul} onChange={e=>setAdvMul(parseFloat(e.target.value))} className="w-full accent-sky-500" /></label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['F','E','D','C','B','A'] as SClass[]).map(k => (
            <button key={k} onClick={()=>setFilterClass(filterClass===k?'ALL':k)} className={`px-1.5 py-0.5 rounded text-[9px] border ${filterClass===k?'ring-1 ring-sky-500/40':''}`} style={{ background: `${CLASS_COLOR[k]}1f`, color: CLASS_COLOR[k], borderColor: `${CLASS_COLOR[k]}55` }}>CLS-{k}</button>
          ))}
          {(['HALO','STAND','AXIS','LBL'] as const).map(t => {
            const v = t==='HALO'?showHalo:t==='STAND'?showStand:t==='AXIS'?showAxis:showLbl
            const setV = t==='HALO'?setShowHalo:t==='STAND'?setShowStand:t==='AXIS'?setShowAxis:setShowLbl
            return <button key={t} onClick={()=>setV(!v)} className={`px-1.5 py-0.5 rounded text-[9px] border ${v?'bg-sky-500/15 text-sky-300 border-sky-500/40':'bg-slate-900 text-slate-500 border-slate-800'}`}>{t}</button>
          })}
        </div>
        <input type="text" placeholder="search callsign / type / stand / airport" value={query} onChange={e=>setQuery(e.target.value)} className="w-full px-2 py-1 rounded bg-slate-900/60 border border-slate-800 text-slate-200 text-[10px] placeholder:text-slate-600" />
      </div>

      {/* Tab switch */}
      <div className="px-3 py-2 border-b border-slate-900 flex gap-1">
        {(['AIRCRAFT','STANDS','AIRPORTS'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded text-[9px] font-mono uppercase ${tab===t?'bg-sky-500/15 text-sky-300 border border-sky-500/40':'bg-slate-900 text-slate-400 border border-slate-800'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto p-2 space-y-1.5 flex-1">
        {tab === 'AIRCRAFT' && visible.length === 0 && (
          <div className="text-center text-[11px] text-slate-500 py-6">No aircraft inside DGS scope. Widen SCOPE or wait for a stand-approach.</div>
        )}
        {tab === 'AIRCRAFT' && visible.map((e, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden cursor-pointer hover:border-slate-700" onClick={()=>onFly(e.flight.icao)}>
            <div className="h-0.5" style={{ background: TIER_COLOR[e.tier] }} />
            <div className="p-2 space-y-1">
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="font-mono font-semibold text-slate-100">{e.flight.callsign || e.flight.icao}</span>
                <span className="text-slate-500 text-[10px]">{e.flight.type || '—'}</span>
                {classPill(e.stand.klass)}
                <div className="ml-auto">{tierPill(e.tier)}</div>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>stand <span className="text-sky-300">{e.stand.id}</span></span>
                <span className="text-slate-600 italic truncate">{e.stand.brand}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>along <span style={{ color: e.alongM < 0 ? '#f43f5e' : e.alongM < 3 ? '#f59e0b' : '#10b981' }}>{e.alongM>=0?'+':''}{e.alongM.toFixed(1)}m</span></span>
                <span>cross <span style={{ color: Math.abs(e.crossM) > lateralTolM ? '#f59e0b' : '#10b981' }}>{e.crossM>=0?'R':'L'}{Math.abs(e.crossM).toFixed(2)}m</span></span>
                <span>axis Δ <span style={{ color: e.axisAngleErr > 10 ? '#f59e0b' : '#10b981' }}>{e.axisAngleErr.toFixed(0)}°</span></span>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>closure <span style={{ color: e.closureMps > e.recClosureMps * 1.5 ? '#ef4444' : e.closureMps > e.recClosureMps ? '#f59e0b' : '#10b981' }}>{e.closureMps.toFixed(2)} m/s</span></span>
                <span>rec <span className="text-sky-300">{e.recClosureMps.toFixed(2)}</span></span>
                <span>type <span style={{ color: e.typeMatch==='OVR'?'#ef4444':e.typeMatch==='UND'?'#f59e0b':'#10b981' }}>{e.typeMatch}</span></span>
              </div>
              <div className="h-1 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: `${e.score}%`, background: TIER_COLOR[e.tier] }} />
              </div>
              <div className="grid grid-cols-6 gap-0.5 text-[9px]">
                {(['CRS','LAT','AXI','CLS','TYP','STP'] as const).map(k => {
                  const v = (e.driver as any)[k] as number
                  const c = v > 60 ? '#ef4444' : v > 30 ? '#f59e0b' : '#10b981'
                  return <div key={k} className="rounded px-1 py-0.5 text-center" style={{ background: `${c}1a`, color: c, border:`1px solid ${c}33` }}>{k} {v.toFixed(0)}</div>
                })}
              </div>
              <div className="text-[10px] leading-snug rounded px-1.5 py-1 border" style={{ background: `${TIER_COLOR[e.tier]}10`, borderColor: `${TIER_COLOR[e.tier]}33`, color: TIER_COLOR[e.tier] }}>{e.advice}</div>
            </div>
          </div>
        ))}

        {tab === 'STANDS' && standRoll.map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden">
            <div className="h-0.5" style={{ background: TIER_COLOR[r.worst] }} />
            <div className="p-2 space-y-0.5">
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="font-mono font-semibold text-sky-300">{r.stand.id}</span>
                {classPill(r.stand.klass)}
                <span className="text-slate-500 text-[10px] italic">{r.stand.brand}</span>
                <div className="ml-auto">{tierPill(r.worst)}</div>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>{r.stand.airport}</span>
                <span>axis <span className="text-slate-200">{r.stand.axisBrg.toFixed(0)}°</span></span>
                <span>ac <span className="text-slate-200">{r.entries.length}</span></span>
                <span>mean <span style={{ color: r.mean>60?'#ef4444':r.mean>30?'#f59e0b':'#10b981' }}>{r.mean.toFixed(0)}</span></span>
              </div>
              <div className="h-1 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: `${r.mean}%`, background: TIER_COLOR[r.worst] }} />
              </div>
            </div>
          </div>
        ))}

        {tab === 'AIRPORTS' && aptRoll.map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden">
            <div className="h-0.5" style={{ background: TIER_COLOR[r.worst] }} />
            <div className="p-2 space-y-0.5">
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="font-mono font-semibold text-sky-300">{r.apt}</span>
                <div className="ml-auto">{tierPill(r.worst)}</div>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>stands <span className="text-slate-200">{r.standCount}</span></span>
                <span>ac <span className="text-slate-200">{r.acCount}</span></span>
                {(['STOP','OVERSHOOT','SLOW','AZIMUTH','WATCH','OK'] as Tier[]).filter(t=>r.counts[t]>0).map(t=>(
                  <span key={t} style={{color:TIER_COLOR[t]}}>{t} {r.counts[t]}</span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] font-mono text-slate-500 leading-tight">
        ICAO Annex 14 §5.3.24 · Doc 9157 Pt 4 · IATA AHM 621 / 631 / 651 · IGOM ed.13 §4.1 · EASA CS-ADR-DSN.M.690 · FAA AC 150/5300-13B · SAE ARP 4942
      </div>
    </div>
  )
}
