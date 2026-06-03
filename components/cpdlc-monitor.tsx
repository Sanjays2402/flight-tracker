'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   CPDLC / Datalink Mandate Compliance Monitor
   -----------------------------------------------------------
   ICAO Doc 4444 PANS-ATM / EASA AMC 20-25 / FAA AC 90-117A
   Datalink Service (DLS) mandatory airspaces. Many oceanic
   and remote FIRs *require* FANS-1/A+ or ATN B1/B2 CPDLC and
   ADS-C equipage to enter — failing to be logged on within
   the prescribed time-before-entry triggers "UNABLE RCL"
   reroutes and ATC penalties.

   Curated mandate polygon set (2024-2026):
     - NAT HLA RLatSM (North Atlantic FL350-390 reduced lat)
     - NAT HLA-Wide (FL285-FL420)
     - Shanwick OCA (EGGX) ADS-C/CPDLC mandate
     - Gander OCA (CZQX)
     - New York OCA (KZWY)
     - Reykjavik FIR (BIRD) polar high-lat
     - Santa Maria OCA (LPPO)
     - SAT Africa-South-America corridor (EUR/SAM)
     - Bay of Bengal / Kolkata oceanic (VECF)
     - Mumbai oceanic (VABF)
     - Singapore FIR oceanic sector (WSJC)
     - Auckland oceanic (NZZO) / Tahiti FIR (NTTT)
     - Anchorage Arctic CEP (PAZA)
     - Edmonton FIR northern (CZEG polar)
     - China RVSM FIRs (ZBPE/ZWUQ/ZLHW/ZUUU FL291+)
     - Maastricht UAC LINK 2000+ (EDUU FL285+ EUR DLS)
     - PBCS RLatSM 23nm corridor enforcement
   Each zone carries SYSTEM (FANS / ATN / BOTH), MIN-FL,
   MAX-FL, and a STRICT flag (STRICT means non-equipped =
   rejected at FIR boundary, non-STRICT means reroute below
   RVSM stratum).

   Per aircraft:
     - point-in-polygon test against all zones
     - per-class CPDLC equipage probability (best-modern):
         heavy   0.97  FANS-1/A+ + ATN B1 dual stack
         narrow  0.78  newer A32N/B73x B1, older FANS only
         regional 0.55 partial fleet equipage
         biz     0.92  satellite FANS-1/A standard
         turboprop 0.20 only newer ATR/Q400 batches
         ga      0.05  rare retrofits
         fighter 0.10  military datalink not civil CPDLC
     - logon-state proxy: aircraft "logged on" if class can
       equip AND random-deterministic-by-icao below threshold
     - time-to-zone-entry projection along track (gc bearing)
     - next-position-report-timer (ADS-C contracts 14min nominal,
       reduced 10min PBCS, 5min HLA-RLatSM)
     - communication-failure-window risk (Loss of Comm if no
       contract update + voice HF blackout proxy in polar)
   Classify 4 tiers:
     COMPLIANT  equipped + logged on + inside mandate    emerald
     ARRIVING   approaching mandate within 30 min        sky
     UNLOGGED   equipped but no logon yet inside mandate amber
     NON-EQUIP  unable to meet mandate                   rose

   MapLibre overlay:
     - System-coloured (FANS amber / ATN sky / BOTH violet)
       polygon fills 7pct + dashed outline 60pct
     - Tier-coloured aircraft halo rings (sized by report timer)
     - Sky dashed projection line for ARRIVING aircraft
       aircraft -> nearest zone entry point
     - Tier-coloured callsign + system + report-min labels
       for non-COMPLIANT aircraft

   Side panel mirrors the established Safety & Traffic family
   (counters / summary / SVG diagram / sliders / chips /
   toggles / tabs).

   Registered under Layers > Safety & Traffic.
   ft-cpdlc persisted preference.
   ============================================================ */

export interface CpdFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  vertRate: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: CpdFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'COMPLIANT' | 'ARRIVING' | 'UNLOGGED' | 'NON-EQUIP'
const TIER_COLOR: Record<Tier, string> = {
  COMPLIANT: '#10b981',
  ARRIVING:  '#0ea5e9',
  UNLOGGED:  '#f59e0b',
  'NON-EQUIP': '#ef4444',
}
const TIER_ORDER: Tier[] = ['NON-EQUIP', 'UNLOGGED', 'ARRIVING', 'COMPLIANT']

type System = 'FANS' | 'ATN' | 'BOTH'
const SYSTEM_COLOR: Record<System, string> = { FANS: '#f59e0b', ATN: '#0ea5e9', BOTH: '#a78bfa' }

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}
const EQUIP_P: Record<Klass, number> = {
  heavy: 0.97, narrow: 0.78, regional: 0.55, biz: 0.92, turboprop: 0.20, ga: 0.05, fighter: 0.10,
}
function classify(t: string | undefined, cat?: string): Klass {
  const s = (t || '').toUpperCase()
  if (cat === 'A5' || /F1|F2|F3|F4|F5|F6|F7|F8/.test(s) || /EUFI|F18|F16|F15|F35|F22|MIG|SU2|SU3|TYP/.test(s)) return 'fighter'
  if (/A38|A35|A34|A33|B74|B77|B78|MD11|IL96|A330|A340|A350|A380|B747|B767|B777|B787/.test(s)) return 'heavy'
  if (/A31|A32|B73|B72|MD8|MD9|A220|BCS|A318|A319|A320|A321|B737/.test(s)) return 'narrow'
  if (/CRJ|E17|E19|E29|E14|E15|AT4|AT7|DH8|ATR/.test(s)) return 'regional'
  if (/GLF|GLEX|G650|G550|G450|CL3|CL6|FA7|FA8|CL60|H25|LJ|C56X|C68A|E55P|E550|E50P/.test(s)) return 'biz'
  if (/PC12|TBM|KOD|C208|PC6|C68|C56/.test(s)) return 'turboprop'
  return 'ga'
}

interface Zone {
  id: string
  name: string
  region: string
  system: System
  strict: boolean
  minFl: number
  maxFl: number
  reportMin: number     // ADS-C nominal report interval
  poly: Array<[number, number]>  // [lng, lat] closed
}

// Curated FIR/OCA datalink-mandate polygons (coarse but realistic).
const ZONES: Zone[] = [
  { id:'EGGX-NAT', name:'Shanwick OCA', region:'North Atlantic', system:'BOTH', strict:true, minFl:285, maxFl:420, reportMin:14,
    poly:[[-30,45],[-10,45],[-10,61],[-30,61],[-30,45]] },
  { id:'CZQX-NAT', name:'Gander OCA', region:'North Atlantic', system:'BOTH', strict:true, minFl:285, maxFl:420, reportMin:14,
    poly:[[-67,45],[-30,45],[-30,61],[-67,61],[-67,45]] },
  { id:'KZWY-NYO', name:'New York OCA', region:'North Atlantic', system:'BOTH', strict:true, minFl:285, maxFl:420, reportMin:14,
    poly:[[-67,29],[-40,29],[-40,45],[-67,45],[-67,29]] },
  { id:'BIRD-RKV', name:'Reykjavik CTA', region:'High Latitude', system:'BOTH', strict:false, minFl:200, maxFl:430, reportMin:14,
    poly:[[-30,61],[-10,61],[-10,75],[-30,75],[-30,61]] },
  { id:'LPPO-SAM', name:'Santa Maria OCA', region:'Mid-Atlantic', system:'FANS', strict:true, minFl:245, maxFl:420, reportMin:14,
    poly:[[-40,27],[-15,27],[-15,45],[-40,45],[-40,27]] },
  { id:'GVSC-SAT', name:'EUR-SAM Corridor', region:'South Atlantic', system:'FANS', strict:true, minFl:245, maxFl:430, reportMin:14,
    poly:[[-40,-30],[-5,-30],[-5,15],[-40,15],[-40,-30]] },
  { id:'NAT-RLAT', name:'NAT HLA RLatSM', region:'North Atlantic', system:'BOTH', strict:true, minFl:350, maxFl:390, reportMin:5,
    poly:[[-50,48],[-15,48],[-15,60],[-50,60],[-50,48]] },
  { id:'VECF-BOB', name:'Kolkata Oceanic', region:'Bay of Bengal', system:'FANS', strict:true, minFl:245, maxFl:430, reportMin:14,
    poly:[[85,2],[100,2],[100,18],[85,18],[85,2]] },
  { id:'VABF-MUM', name:'Mumbai Oceanic', region:'Arabian Sea', system:'FANS', strict:false, minFl:245, maxFl:430, reportMin:14,
    poly:[[55,5],[72,5],[72,20],[55,20],[55,5]] },
  { id:'WSJC-SIN', name:'Singapore Oceanic', region:'South China Sea', system:'FANS', strict:true, minFl:245, maxFl:430, reportMin:14,
    poly:[[100,-5],[115,-5],[115,10],[100,10],[100,-5]] },
  { id:'NZZO-AKL', name:'Auckland Oceanic', region:'South Pacific', system:'FANS', strict:true, minFl:245, maxFl:430, reportMin:14,
    poly:[[155,-50],[210,-50],[210,-5],[155,-5],[155,-50]] },
  { id:'NTTT-TAH', name:'Tahiti FIR', region:'Central Pacific', system:'FANS', strict:false, minFl:245, maxFl:430, reportMin:14,
    poly:[[-160,-20],[-130,-20],[-130,5],[-160,5],[-160,-20]] },
  { id:'PAZA-ANC', name:'Anchorage Arctic', region:'Arctic', system:'BOTH', strict:true, minFl:285, maxFl:430, reportMin:10,
    poly:[[-170,55],[-130,55],[-130,75],[-170,75],[-170,55]] },
  { id:'CZEG-POL', name:'Edmonton Polar', region:'Polar', system:'BOTH', strict:true, minFl:285, maxFl:430, reportMin:10,
    poly:[[-125,60],[-90,60],[-90,80],[-125,80],[-125,60]] },
  { id:'EDUU-L2K', name:'Maastricht LINK2000+', region:'Europe DLS', system:'ATN', strict:true, minFl:285, maxFl:660, reportMin:14,
    poly:[[2,49],[14,49],[14,55],[2,55],[2,49]] },
  { id:'EUR-DLS', name:'EUR DLS Core', region:'Europe DLS', system:'ATN', strict:true, minFl:285, maxFl:660, reportMin:14,
    poly:[[-5,42],[20,42],[20,55],[-5,55],[-5,42]] },
  { id:'ZBPE-CHN', name:'Beijing FIR RVSM', region:'China', system:'FANS', strict:false, minFl:290, maxFl:410, reportMin:14,
    poly:[[110,35],[125,35],[125,45],[110,45],[110,35]] },
  { id:'ZUUU-CHN', name:'Chengdu FIR RVSM', region:'China', system:'FANS', strict:false, minFl:290, maxFl:410, reportMin:14,
    poly:[[100,28],[112,28],[112,35],[100,35],[100,28]] },
]

const D2R = Math.PI / 180
const R_NM = 3440.065
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
function pointInPoly(lng: number, lat: number, poly: Array<[number, number]>): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-9) + xi)
    if (intersect) inside = !inside
  }
  return inside
}
function centroid(poly: Array<[number, number]>): [number, number] {
  let sx = 0, sy = 0, n = poly.length - 1
  for (let i = 0; i < n; i++) { sx += poly[i][0]; sy += poly[i][1] }
  return [sx / n, sy / n]
}
function destPoint(lat: number, lng: number, brgDeg: number, dNm: number): [number, number] {
  const φ1 = lat * D2R, λ1 = lng * D2R, θ = brgDeg * D2R
  const δ = dNm / R_NM
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return [φ2 / D2R, ((λ2 / D2R) + 540) % 360 - 180]
}
function bearingTo(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R, Δλ = (lo2 - lo1) * D2R
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return ((Math.atan2(y, x) / D2R) + 360) % 360
}
// Deterministic 0..1 from icao
function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0 }
  return (h % 10000) / 10000
}

interface Row {
  f: CpdFlight
  klass: Klass
  altFt: number
  fl: number
  insideZone: Zone | null
  nearestZone: { z: Zone; dNm: number; brg: number; entryLat: number; entryLng: number } | null
  equipP: number
  equipped: boolean
  loggedOn: boolean
  reportTimerMin: number   // simulated count-up since last ADS-C report
  tier: Tier
}

const SRC_POLY = 'cpdlc-poly', SRC_RING = 'cpdlc-ring', SRC_PROJ = 'cpdlc-proj', SRC_LBL = 'cpdlc-lbl'
const LYR_POLY_FILL = 'cpdlc-poly-fill', LYR_POLY_LINE = 'cpdlc-poly-line'
const LYR_RING = 'cpdlc-ring-l', LYR_PROJ = 'cpdlc-proj-l', LYR_LBL = 'cpdlc-lbl-l'

export default function CpdlcMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'ZONES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(200)
  const [maxFl, setMaxFl] = useState(450)
  const [arrivalNm, setArrivalNm] = useState(180)   // capture distance for "arriving"
  const [equipBias, setEquipBias] = useState(100)    // % multiplier on logon threshold
  const [reportLoad, setReportLoad] = useState(100)  // % multiplier on simulated report-timer
  const [showPoly, setShowPoly] = useState(true)
  const [showRing, setShowRing] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const air = flights.filter(f => !f.ground && isFinite(f.altitudeFt) && isFinite(f.lat) && isFinite(f.lng))
    const equipBiasMult = equipBias / 100
    const reportMult = reportLoad / 100
    for (const f of air) {
      const fl = f.altitudeFt / 100
      if (fl < minFl || fl > maxFl) continue
      const klass = classify(f.type, f.category)
      const equipP = EQUIP_P[klass]
      const seed = hash01(f.icao)
      // equipped if seed below equipP
      const equipped = seed < equipP
      // logged-on: only equipped, with 85% logon rate biased
      const loggedSeed = hash01(f.icao + 'L')
      const loggedOn = equipped && loggedSeed < (0.85 * equipBiasMult)
      // find inside zone (first match by altitude)
      let insideZone: Zone | null = null
      for (const z of ZONES) {
        if (fl < z.minFl || fl > z.maxFl) continue
        if (pointInPoly(f.lng, f.lat, z.poly)) { insideZone = z; break }
      }
      // nearest zone the aircraft is heading toward (project up to arrivalNm)
      let nearestZone: Row['nearestZone'] = null
      if (!insideZone) {
        // sample forward along track every 30nm up to arrivalNm
        for (let d = 30; d <= arrivalNm; d += 30) {
          const [plat, plng] = destPoint(f.lat, f.lng, f.track || 0, d)
          for (const z of ZONES) {
            if (fl < z.minFl || fl > z.maxFl) continue
            if (pointInPoly(plng, plat, z.poly)) {
              const brg = bearingTo(f.lat, f.lng, plat, plng)
              nearestZone = { z, dNm: d, brg, entryLat: plat, entryLng: plng }
              break
            }
          }
          if (nearestZone) break
        }
      }
      // Report-timer proxy: hash + reportMult, scaled to zone's nominal report interval (or 14 default)
      const baseRep = (insideZone ? insideZone.reportMin : 14)
      const reportTimerMin = Math.max(0, Math.min(baseRep * 2.5, (hash01(f.icao + 'R') * baseRep * 1.6) * reportMult))
      // classify tier
      let tier: Tier
      if (insideZone) {
        if (!equipped) tier = 'NON-EQUIP'
        else if (!loggedOn) tier = 'UNLOGGED'
        else tier = 'COMPLIANT'
      } else if (nearestZone) {
        if (!equipped) tier = 'NON-EQUIP'
        else tier = 'ARRIVING'
      } else {
        continue // not in or near any zone -> skip
      }
      out.push({ f, klass, altFt: f.altitudeFt, fl, insideZone, nearestZone, equipP, equipped, loggedOn, reportTimerMin, tier })
    }
    return out
  }, [flights, minFl, maxFl, arrivalNm, equipBias, reportLoad])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (q) {
        const z = r.insideZone || r.nearestZone?.z
        const hay = `${r.f.callsign || ''} ${r.f.type || ''} ${r.f.operator || ''} ${r.f.icao} ${z?.id || ''} ${z?.name || ''}`.toUpperCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [rows, tierFilter, klassFilter, query])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { COMPLIANT: 0, ARRIVING: 0, UNLOGGED: 0, 'NON-EQUIP': 0 }
    rows.forEach(r => c[r.tier]++)
    return c
  }, [rows])
  const insideCount = useMemo(() => rows.filter(r => r.insideZone).length, [rows])
  const strictBust = useMemo(() => rows.filter(r => r.insideZone?.strict && r.tier !== 'COMPLIANT').length, [rows])
  const meanTimer = useMemo(() => rows.length ? rows.reduce((s, r) => s + r.reportTimerMin, 0) / rows.length : 0, [rows])
  const worst = useMemo(() => {
    const bad = rows.filter(r => r.tier === 'NON-EQUIP' || r.tier === 'UNLOGGED')
    if (!bad.length) return null
    return [...bad].sort((a, b) => b.reportTimerMin - a.reportTimerMin)[0]
  }, [rows])

  const ranked = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const ai = TIER_ORDER.indexOf(a.tier), bi = TIER_ORDER.indexOf(b.tier)
      if (ai !== bi) return ai - bi
      return b.reportTimerMin - a.reportTimerMin
    })
  }, [filtered])

  const zoneGroups = useMemo(() => {
    const map = new Map<string, { z: Zone; list: Row[] }>()
    filtered.forEach(r => {
      const z = r.insideZone || r.nearestZone?.z
      if (!z) return
      if (!map.has(z.id)) map.set(z.id, { z, list: [] })
      map.get(z.id)!.list.push(r)
    })
    return Array.from(map.values())
      .map(g => {
        const inside = g.list.filter(r => r.insideZone?.id === g.z.id).length
        const worstTier: Tier = g.list.some(r => r.tier === 'NON-EQUIP') ? 'NON-EQUIP'
          : g.list.some(r => r.tier === 'UNLOGGED') ? 'UNLOGGED'
          : g.list.some(r => r.tier === 'ARRIVING') ? 'ARRIVING' : 'COMPLIANT'
        return { ...g, inside, worstTier }
      })
      .sort((a, b) => b.list.length - a.list.length)
  }, [filtered])

  // ============================================================
  // MapLibre overlay
  // ============================================================
  useEffect(() => {
    const m = map
    if (!m) return
    if (!m.isStyleLoaded?.()) {
      const onload = () => { try { render() } catch { } }
      m.once('load', onload)
      return () => { try { m.off('load', onload) } catch { } }
    }
    render()
    function render() {
      const polyFeats: any[] = []
      if (showPoly) {
        for (const z of ZONES) {
          polyFeats.push({
            type: 'Feature',
            properties: { color: SYSTEM_COLOR[z.system], id: z.id, name: z.name },
            geometry: { type: 'Polygon', coordinates: [z.poly] },
          })
        }
      }
      const rings: any[] = [], proj: any[] = [], lbls: any[] = []
      for (const r of ranked) {
        const c = TIER_COLOR[r.tier]
        const radius = Math.max(7, Math.min(22, 6 + r.reportTimerMin * 0.9))
        if (showRing) rings.push({ type: 'Feature', properties: { color: c, radius }, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
        if (showProj && r.nearestZone && r.tier === 'ARRIVING') {
          proj.push({ type: 'Feature', properties: { color: c }, geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.nearestZone.entryLng, r.nearestZone.entryLat]] } })
        }
        if (showLbl && r.tier !== 'COMPLIANT') {
          const z = r.insideZone || r.nearestZone?.z
          lbls.push({
            type: 'Feature',
            properties: { color: c, label: `${r.f.callsign || r.f.icao}  ${z?.system || ''}  ${Math.round(r.reportTimerMin)}m` },
            geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          })
        }
      }
      ensureSrc(SRC_POLY, polyFeats)
      ensureSrc(SRC_RING, rings)
      ensureSrc(SRC_PROJ, proj)
      ensureSrc(SRC_LBL, lbls)
      ensureLayer(LYR_POLY_FILL, {
        id: LYR_POLY_FILL, type: 'fill', source: SRC_POLY,
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.07 },
      })
      ensureLayer(LYR_POLY_LINE, {
        id: LYR_POLY_LINE, type: 'line', source: SRC_POLY,
        paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.6, 'line-dasharray': [4, 3] as any },
      })
      ensureLayer(LYR_RING, {
        id: LYR_RING, type: 'circle', source: SRC_RING,
        paint: {
          'circle-radius': ['get', 'radius'],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.14,
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': 1.4,
          'circle-stroke-opacity': 0.85,
        },
      })
      ensureLayer(LYR_PROJ, {
        id: LYR_PROJ, type: 'line', source: SRC_PROJ,
        paint: { 'line-color': ['get', 'color'], 'line-width': 1.3, 'line-opacity': 0.7, 'line-dasharray': [3, 3] as any },
      })
      ensureLayer(LYR_LBL, {
        id: LYR_LBL, type: 'symbol', source: SRC_LBL,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 11,
          'text-offset': [0, -1.6],
          'text-anchor': 'bottom',
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0f172a', 'text-halo-width': 1.4 },
      })
      function ensureSrc(id: string, features: any[]) {
        const src = m!.getSource(id)
        if (src) (src as any).setData({ type: 'FeatureCollection', features })
        else m!.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features } })
      }
      function ensureLayer(id: string, spec: any) {
        if (!m!.getLayer(id)) m!.addLayer(spec)
      }
    }
    return () => {
      try {
        ;[LYR_LBL, LYR_PROJ, LYR_RING, LYR_POLY_LINE, LYR_POLY_FILL].forEach(l => { if (m.getLayer(l)) m.removeLayer(l) })
        ;[SRC_LBL, SRC_PROJ, SRC_RING, SRC_POLY].forEach(s => { if (m.getSource(s)) m.removeSource(s) })
      } catch { }
    }
  }, [map, ranked, showPoly, showRing, showProj, showLbl])

  // ============================================================
  // SVG report-timer vs FL scatter
  // ============================================================
  const W = 376, H = 168, PADL = 30, PADR = 10, PADT = 12, PADB = 22
  const PW = W - PADL - PADR, PH = H - PADT - PADB
  const xOf = (fl: number) => PADL + Math.max(0, Math.min(1, fl / 450)) * PW
  // y axis: 0..30 minutes
  const yMax = 30
  const yOf = (m: number) => PADT + (1 - Math.max(0, Math.min(yMax, m)) / yMax) * PH

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[88vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Safety &amp; Traffic</div>
          <div className="text-sm font-semibold text-slate-100">CPDLC / Datalink Mandate</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      <div className="overflow-y-auto">
        {/* Tier counter */}
        <div className="px-3 pt-3 grid grid-cols-5 gap-1.5">
          {(['ALL', ...TIER_ORDER] as const).map(t => {
            const isAll = t === 'ALL'
            const n = isAll ? rows.length : counts[t as Tier]
            const active = tierFilter === t
            const col = isAll ? '#94a3b8' : TIER_COLOR[t as Tier]
            return (
              <button key={t} onClick={() => setTierFilter(t as any)}
                className={`px-1.5 py-1.5 rounded-lg text-[10px] font-bold tracking-wider border ${active ? 'bg-sky-500/15 border-sky-500/40' : 'bg-slate-900/50 border-slate-800 hover:border-slate-700'}`}
                style={{ color: col }}>
                <div className="text-[9px] opacity-70">{isAll ? 'ALL' : t}</div>
                <div className="text-sm">{n}</div>
              </button>
            )
          })}
        </div>

        {/* Summary */}
        <div className="px-3 pt-2 grid grid-cols-3 gap-1.5">
          <Cell label="MEAN RPT" value={`${Math.round(meanTimer)}m`} color={meanTimer > 14 ? '#f59e0b' : '#0ea5e9'} />
          <Cell label="WORST" value={worst ? `${worst.f.callsign || worst.f.icao}` : '—'} sub={worst ? `${Math.round(worst.reportTimerMin)}m` : ''} color={worst ? TIER_COLOR[worst.tier] : '#64748b'} />
          <Cell label="STRICT BUST" value={String(strictBust)} color={strictBust ? '#ef4444' : '#10b981'} />
        </div>
        <div className="px-3 pt-1.5 grid grid-cols-2 gap-1.5">
          <Cell label="INSIDE MANDATE" value={String(insideCount)} color={insideCount ? '#0ea5e9' : '#64748b'} />
          <Cell label="ZONES" value={`${zoneGroups.length}/${ZONES.length}`} color="#94a3b8" />
        </div>

        {/* SVG scatter */}
        {showDiag && (
          <div className="px-3 pt-2">
            <svg width={W} height={H} className="bg-slate-900/40 rounded-lg border border-slate-800">
              {/* threshold bands (5 / 10 / 14 / 20 min) */}
              <rect x={PADL} y={yOf(yMax)} width={PW} height={yOf(20) - yOf(yMax)} fill="#ef4444" opacity={0.08} />
              <rect x={PADL} y={yOf(20)} width={PW} height={yOf(14) - yOf(20)} fill="#f59e0b" opacity={0.07} />
              <rect x={PADL} y={yOf(14)} width={PW} height={yOf(5) - yOf(14)} fill="#0ea5e9" opacity={0.06} />
              <rect x={PADL} y={yOf(5)} width={PW} height={yOf(0) - yOf(5)} fill="#10b981" opacity={0.06} />
              {[5, 10, 14, 20].map(s => (
                <line key={s} x1={PADL} x2={W - PADR} y1={yOf(s)} y2={yOf(s)} stroke={s === 20 ? '#ef4444' : s === 14 ? '#f59e0b' : '#0ea5e9'} strokeWidth={0.8} strokeDasharray="3,3" />
              ))}
              {[100, 200, 300, 400].map(fl => (
                <g key={fl}>
                  <line x1={xOf(fl)} x2={xOf(fl)} y1={PADT} y2={H - PADB} stroke="#1e293b" strokeWidth={1} />
                  <text x={xOf(fl)} y={H - 6} fill="#475569" fontSize={8} textAnchor="middle">F{fl}</text>
                </g>
              ))}
              {[5, 14, 20].map(s => (
                <text key={s} x={W - PADR - 2} y={yOf(s) - 2} textAnchor="end" fontSize={8} fill={s === 20 ? '#ef4444' : s === 14 ? '#f59e0b' : '#0ea5e9'}>{s}m</text>
              ))}
              <text x={PADL + 2} y={PADT + 8} fontSize={8} fill="#64748b">ADS-C report timer (min)</text>
              {rows.map((r, i) => (
                <circle key={r.f.icao + i} cx={xOf(r.fl)} cy={yOf(r.reportTimerMin)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85} />
              ))}
            </svg>
          </div>
        )}

        {/* Sliders */}
        <div className="px-3 pt-2 grid grid-cols-2 gap-2">
          <Slider label={`MIN-FL ${minFl}`} v={minFl} min={0} max={400} setV={setMinFl} />
          <Slider label={`MAX-FL ${maxFl}`} v={maxFl} min={50} max={450} setV={setMaxFl} />
          <Slider label={`ARRIVE ${arrivalNm}nm`} v={arrivalNm} min={60} max={600} setV={setArrivalNm} />
          <Slider label={`EQUIP-BIAS ${equipBias}%`} v={equipBias} min={50} max={150} setV={setEquipBias} />
          <div className="col-span-2">
            <Slider label={`REPORT-LOAD ${reportLoad}%`} v={reportLoad} min={50} max={150} setV={setReportLoad} />
          </div>
        </div>

        {/* Class chips */}
        <div className="px-3 pt-2 flex flex-wrap gap-1">
          {(['ALL', ...Object.keys(KLASS_LABEL)] as const).map(k => {
            const active = klassFilter === (k as any)
            return (
              <button key={k} onClick={() => setKlassFilter(k as any)}
                className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider border ${active ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>
                {k === 'ALL' ? 'ALL' : KLASS_LABEL[k as Klass]}
              </button>
            )
          })}
        </div>

        {/* Layer toggles */}
        <div className="px-3 pt-2 flex flex-wrap gap-1.5">
          {[
            ['ZONE', showPoly, setShowPoly],
            ['HALO', showRing, setShowRing],
            ['PROJ', showProj, setShowProj],
            ['LBL', showLbl, setShowLbl],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lbl, on, setOn]: any) => (
            <button key={lbl} onClick={() => setOn(!on)}
              className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider border ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>
              {lbl}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="px-3 pt-2">
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / FIR / zone…"
            className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50" />
        </div>

        {/* Tabs */}
        <div className="px-3 pt-2 flex gap-1">
          {(['AIRCRAFT', 'ZONES'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1 rounded-md text-[10px] font-bold tracking-wider border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>
              {t}
            </button>
          ))}
        </div>

        {/* List */}
        <div className="px-2 pt-2 pb-3 space-y-1">
          {tab === 'AIRCRAFT' && ranked.length === 0 && (
            <div className="text-[11px] text-slate-500 px-2 py-4 text-center">No aircraft inside or approaching a CPDLC mandate.</div>
          )}

          {tab === 'AIRCRAFT' && ranked.map(r => {
            const c = TIER_COLOR[r.tier]
            const z = r.insideZone || r.nearestZone?.z
            const fl = Math.round(r.fl)
            const advice = r.tier === 'NON-EQUIP' ? 'unable CPDLC — reroute or descend below mandate'
              : r.tier === 'UNLOGGED' ? 'log on FANS / ATN before entry — advise ATC'
              : r.tier === 'ARRIVING' ? 'establish CPDLC logon before zone entry'
              : 'compliant — maintain ADS-C contract'
            const sysColor = z ? SYSTEM_COLOR[z.system] : '#64748b'
            const repPct = r.insideZone ? Math.min(100, (r.reportTimerMin / r.insideZone.reportMin) * 100) : 0
            return (
              <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
                className="w-full text-left bg-slate-900/50 hover:bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-lg p-2">
                <div className="flex items-center gap-1.5" style={{ borderLeft: `3px solid ${c}`, paddingLeft: 6 }}>
                  <span className="text-[11px] font-mono font-bold text-slate-100">{r.f.callsign || r.f.icao}</span>
                  <span className="text-[9px] text-slate-500">{r.f.type || '—'}</span>
                  <span className="text-[8px] px-1 rounded bg-slate-800 text-slate-400 font-bold tracking-wider">{KLASS_LABEL[r.klass]}</span>
                  <span className="ml-auto text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded" style={{ background: c + '22', color: c }}>{r.tier}</span>
                </div>
                <div className="flex justify-between text-[10px] mt-1 text-slate-400 font-mono">
                  <span>FL{fl}</span>
                  <span style={{ color: sysColor }}>{z?.system || '—'}</span>
                  <span>{r.insideZone ? 'INSIDE' : r.nearestZone ? `${Math.round(r.nearestZone.dNm)}nm` : '—'}</span>
                  <span style={{ color: c }}>{Math.round(r.reportTimerMin)}m</span>
                </div>
                {/* Report timer bar */}
                <div className="relative h-1.5 mt-1 bg-slate-800 rounded overflow-hidden">
                  <div className="absolute top-0 bottom-0" style={{ left: 0, width: `${Math.min(100, (r.reportTimerMin / 30) * 100)}%`, background: c, opacity: 0.85 }} />
                  {[5, 14, 20].map(s => (
                    <div key={s} className="absolute top-0 bottom-0" style={{ left: `${(s / 30) * 100}%`, width: 1, background: s === 20 ? '#ef4444' : s === 14 ? '#f59e0b' : '#0ea5e9', opacity: 0.7 }} />
                  ))}
                </div>
                {/* Status flags */}
                <div className="mt-1.5 grid grid-cols-3 gap-0.5 text-[9px] font-mono">
                  <Flag label="EQUIP" on={r.equipped} good={r.equipped} />
                  <Flag label="LOGON" on={r.loggedOn} good={r.loggedOn} />
                  <Flag label={z?.strict ? 'STRICT' : 'ADVISE'} on={true} good={!z?.strict} />
                </div>
                <div className="flex justify-between text-[9px] mt-1 text-slate-500 font-mono">
                  <span>p-equip {Math.round(r.equipP * 100)}%</span>
                  <span>{z?.name || ''}</span>
                  <span>{r.f.operator || ''}</span>
                </div>
                <div className="text-[9px] mt-1 font-mono" style={{ color: c }}>{advice}</div>
              </button>
            )
          })}

          {tab === 'ZONES' && zoneGroups.length === 0 && (
            <div className="text-[11px] text-slate-500 px-2 py-4 text-center">No zones currently active in filter.</div>
          )}

          {tab === 'ZONES' && zoneGroups.map(g => {
            const c = TIER_COLOR[g.worstTier]
            const sysColor = SYSTEM_COLOR[g.z.system]
            const ct = centroid(g.z.poly)
            return (
              <button key={g.z.id} onClick={() => { if (g.list[0]) onFly(g.list[0].f.icao) }}
                className="w-full text-left bg-slate-900/50 hover:bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-lg p-2">
                <div className="flex items-center gap-1.5" style={{ borderLeft: `3px solid ${c}`, paddingLeft: 6 }}>
                  <span className="text-[11px] font-mono font-bold text-slate-100">{g.z.id}</span>
                  <span className="text-[9px] text-slate-500 truncate">{g.z.name}</span>
                  <span className="ml-auto text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded" style={{ background: sysColor + '22', color: sysColor }}>{g.z.system}</span>
                  <span className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded" style={{ background: c + '22', color: c }}>{g.worstTier}</span>
                </div>
                <div className="flex justify-between text-[10px] mt-1 text-slate-400 font-mono">
                  <span>{g.list.length} ac</span>
                  <span>inside {g.inside}</span>
                  <span>F{g.z.minFl}-F{g.z.maxFl}</span>
                  <span>rpt {g.z.reportMin}m</span>
                </div>
                <div className="relative h-1.5 mt-1 bg-slate-800 rounded overflow-hidden">
                  <div className="absolute top-0 bottom-0" style={{ left: 0, width: `${Math.min(100, g.list.length * 10)}%`, background: c, opacity: 0.8 }} />
                </div>
                <div className="text-[9px] mt-1 text-slate-500 font-mono">
                  {g.z.region} · {g.z.strict ? 'STRICT mandate' : 'advisory'} · {ct[1].toFixed(1)}°,{ct[0].toFixed(1)}°
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Cell({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-lg px-2 py-1.5">
      <div className="text-[8px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className="text-sm font-bold font-mono" style={{ color }}>{value}</div>
      {sub && <div className="text-[9px] font-mono" style={{ color }}>{sub}</div>}
    </div>
  )
}

function Slider({ label, v, min, max, step, setV }: { label: string; v: number; min: number; max: number; step?: number; setV: (n: number) => void }) {
  return (
    <label className="text-[10px] text-slate-400 block">
      <div className="font-mono tracking-wider">{label}</div>
      <input type="range" min={min} max={max} step={step || 1} value={v} onChange={e => setV(Number(e.target.value))}
        className="w-full accent-sky-500" />
    </label>
  )
}

function Flag({ label, on, good }: { label: string; on: boolean; good: boolean }) {
  const col = good ? '#10b981' : '#ef4444'
  return (
    <div className="flex items-center justify-center gap-0.5 px-1 py-0.5 rounded bg-slate-800/60 border" style={{ borderColor: col + '55' }}>
      <span style={{ color: col }}>{on ? '●' : '○'}</span>
      <span className="text-slate-400">{label}</span>
    </div>
  )
}
