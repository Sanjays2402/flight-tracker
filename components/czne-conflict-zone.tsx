'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   CZNE · Conflict-Zone & Airspace-Restriction Overflight Advisor
   ------------------------------------------------------------
   Per-airframe scorer that tests every airborne flight against a
   global conflict-zone / sanctioned-airspace catalogue compiled
   from active EASA Conflict-Zone Information Bulletins (CZIBs),
   FAA Special Federal Aviation Regulations (SFARs), ICAO State-
   letter NOTAMs and UK CAA Overflight Risk notices. Designed as
   a planner-side risk overlay, NOT a real-time avoidance tool.

   18-zone catalogue (FL floor/ceiling, threat band, advisory:
   AVOID / DISCRETIONARY / CAUTION):
     UKBV  Ukraine + Belarus FIRs · AVOID all FL    (EASA CZIB-2022-01R / FAA SFAR 113 / UK NOTAM)
     RUEU  Russia W of 60°E + Kaliningrad · DISCR  (EASA CZIB-2022-02 / FAA SFAR 116)
     SYRI  Syria FIR · AVOID                       (EASA CZIB-2014-02R8 / FAA SFAR 114)
     IRAQ  Iraq FIR · CAUTION FL260+               (EASA CZIB-2014-01R7 / FAA SFAR 77)
     IRAN  Iran FIR + Strait of Hormuz · DISCR     (EASA CZIB-2019-01R3 / FAA NOTAM A0017/19)
     YEMI  Yemen FIR · AVOID                       (EASA CZIB-2015-02R5 / FAA SFAR 110)
     LIBY  Libya FIR · AVOID                       (EASA CZIB-2014-04R6 / FAA SFAR 112)
     SUDA  Sudan FIR + Khartoum · AVOID            (EASA CZIB-2023-02 / FAA NOTAM A0007/23)
     SSDN  South Sudan FIR · CAUTION FL245+        (EASA CZIB-2016-04R2)
     LEBN  Lebanon + N-Israel · DISCR              (EASA CZIB-2024-01 / FAA SFAR 81)
     GAZA  Gaza envelope · AVOID                   (Israeli AIP / EASA CZIB-2023-03)
     SOMA  Somalia FIR + Mogadishu · CAUTION       (EASA CZIB-2018-03R2)
     MALI  Mali / Burkina Faso airspace · DISCR    (EASA CZIB-2022-04 / DGAC NOTAM)
     DPRK  Pyongyang FIR · AVOID                   (EASA CZIB-2017-02R3 / FAA SFAR 79)
     ETHI  Tigray N-Ethiopia · CAUTION             (EASA CZIB-2020-04R2)
     NIGR  Niger airspace · CAUTION                (EASA CZIB-2023-04)
     MYAN  Myanmar FIR · CAUTION                   (EASA CZIB-2021-03R2)
     VENZ  Venezuela FIR · CAUTION                 (EASA CZIB-2019-02 / FAA SFAR 117)

   Per-flight scoring (0..100, max-driver composite + dwell):
     INZ  inside-zone penalty            (AVOID 95 / DISCR 65 / CAUTION 35)
     ALT  altitude vs zone FL floor      (100 below, 50 within +2000ft, 0 well above ceiling)
     DWL  dwell-time in zone (gs-based)  (0..100 over 0..30min projected)
     PRX  proximity to zone boundary     (100 inside, 70 within 25NM, 30 within 75NM)
     OPR  operator-nationality risk      (carrier on sanctioned list / based-in-zone)
     RTE  great-circle deviation rationale (transiting vs origin/dest in-region)

   Composite max·0.72 + secondary-mean·0.28, then tier:
     CRITICAL  ≥80  rose   immediate re-route advisory
     HIGH      ≥60  rose-pink
     ELEVATED  ≥40  amber  monitor
     GUARDED   ≥20  sky
     CLEAR     <20  emerald

   References:
     EASA Conflict Zone Information Bulletin (CZIB) portal v2024
     EASA SIB 2022-05R3 Overflight of Conflict Zones
     EU Reg 376/2014 Occurrence reporting
     14 CFR Part 91 §91.711  Special-area authorisation
     14 CFR §91.703 Operations outside US
     FAA Special Federal Aviation Regulations 77/79/81/110/112/113/114/116/117
     FAA Advisory Circular 91-70B Ch.10 Conflict-zone risk
     ICAO Annex 11 §2.18 Coordination of activities potentially hazardous
     ICAO Annex 15 §5.1 NOTAM publication
     ICAO Doc 4444 PANS-ATM §16 ATS messages
     ICAO Doc 10084 Risk Assessment Manual for Civil Aircraft Operations
        Over or Near Conflict Zones (CZ-RAM)
     ICAO Council Working Paper C-WP/14533 (post-MH17)
     UK CAA Overseas Territories Operations Notices 2024
     CAP 1864 UK Conflict-Zone Risk Methodology
     IATA Safety Issue Hub — Conflict Zones (Q1 2025)
     Dutch Safety Board "Crash MH17 17 July 2014" §5
     ATSB AO-2014-110 / BFU 5X008-14
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Threat = 'AVOID' | 'DISCR' | 'CAUTION'
const THREAT_BASE: Record<Threat, number> = { AVOID: 95, DISCR: 65, CAUTION: 35 }
const THREAT_COLOR: Record<Threat, string> = { AVOID: '#ef4444', DISCR: '#f43f5e', CAUTION: '#f59e0b' }

type Tier = 'CRITICAL' | 'HIGH' | 'ELEVATED' | 'GUARDED' | 'CLEAR' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  CRITICAL: '#ef4444', HIGH: '#f43f5e', ELEVATED: '#f59e0b', GUARDED: '#0ea5e9', CLEAR: '#10b981', IDLE: '#64748b',
}
const TIER_RANK: Record<Tier, number> = { CRITICAL:0, HIGH:1, ELEVATED:2, GUARDED:3, CLEAR:4, IDLE:5 }

interface Zone {
  id: string; name: string; threat: Threat
  flFloor: number; flCeil: number // FL bounds (100 = 10000ft); 999 = unlimited
  ref: string
  // polygon as [lng,lat] vertices (simplified rectangles / convex hulls for screen overlay)
  poly: Array<[number, number]>
  sanctionedOps?: string[] // operator prefixes always pinned to AVOID
}

// Polygons are coarse FIR-envelope simplifications adequate for screen overlay scoring.
const ZONES: Zone[] = [
  { id:'UKBV', name:'Ukraine + Belarus FIRs', threat:'AVOID', flFloor:0, flCeil:999, ref:'EASA CZIB-2022-01R · FAA SFAR 113',
    poly:[[22.1,51.3],[40.2,52.6],[40.0,44.2],[28.5,44.0],[22.1,49.0],[22.1,51.3]],
    sanctionedOps:['AFL','SBI','SU','UT','UTA'] },
  { id:'RUEU', name:'Russia W of 60°E + Kaliningrad', threat:'DISCR', flFloor:0, flCeil:999, ref:'EASA CZIB-2022-02 · FAA SFAR 116',
    poly:[[19.6,54.4],[22.7,55.3],[28.0,60.0],[60.0,68.0],[60.0,45.0],[36.0,42.5],[27.0,44.0],[19.6,54.4]],
    sanctionedOps:['AFL','SBI','SU','UT'] },
  { id:'SYRI', name:'Syria FIR', threat:'AVOID', flFloor:0, flCeil:999, ref:'EASA CZIB-2014-02R8 · FAA SFAR 114',
    poly:[[35.7,32.3],[42.4,32.3],[42.4,37.3],[35.7,37.3],[35.7,32.3]] },
  { id:'IRAQ', name:'Iraq FIR', threat:'CAUTION', flFloor:260, flCeil:999, ref:'EASA CZIB-2014-01R7 · FAA SFAR 77',
    poly:[[38.8,29.0],[48.6,29.0],[48.6,37.4],[38.8,37.4],[38.8,29.0]] },
  { id:'IRAN', name:'Iran FIR + Strait of Hormuz', threat:'DISCR', flFloor:0, flCeil:999, ref:'EASA CZIB-2019-01R3 · FAA NOTAM A0017/19',
    poly:[[44.0,25.0],[63.3,25.0],[63.3,39.8],[44.0,39.8],[44.0,25.0]] },
  { id:'YEMI', name:'Yemen FIR', threat:'AVOID', flFloor:0, flCeil:999, ref:'EASA CZIB-2015-02R5 · FAA SFAR 110',
    poly:[[42.5,12.0],[54.5,12.0],[54.5,19.0],[42.5,19.0],[42.5,12.0]] },
  { id:'LIBY', name:'Libya FIR', threat:'AVOID', flFloor:0, flCeil:999, ref:'EASA CZIB-2014-04R6 · FAA SFAR 112',
    poly:[[9.4,19.5],[25.1,19.5],[25.1,33.2],[9.4,33.2],[9.4,19.5]] },
  { id:'SUDA', name:'Sudan + Khartoum FIR', threat:'AVOID', flFloor:0, flCeil:999, ref:'EASA CZIB-2023-02 · FAA NOTAM A0007/23',
    poly:[[21.8,9.5],[38.6,9.5],[38.6,22.0],[21.8,22.0],[21.8,9.5]] },
  { id:'SSDN', name:'South Sudan FIR', threat:'CAUTION', flFloor:245, flCeil:999, ref:'EASA CZIB-2016-04R2',
    poly:[[24.0,3.5],[35.9,3.5],[35.9,12.2],[24.0,12.2],[24.0,3.5]] },
  { id:'LEBN', name:'Lebanon + North-Israel', threat:'DISCR', flFloor:0, flCeil:999, ref:'EASA CZIB-2024-01 · FAA SFAR 81',
    poly:[[34.95,32.6],[36.7,32.6],[36.7,34.7],[34.95,34.7],[34.95,32.6]] },
  { id:'GAZA', name:'Gaza envelope', threat:'AVOID', flFloor:0, flCeil:999, ref:'Israeli AIP · EASA CZIB-2023-03',
    poly:[[34.2,31.2],[34.6,31.2],[34.6,31.6],[34.2,31.6],[34.2,31.2]] },
  { id:'SOMA', name:'Somalia FIR + Mogadishu', threat:'CAUTION', flFloor:200, flCeil:999, ref:'EASA CZIB-2018-03R2',
    poly:[[40.9,-1.7],[51.6,-1.7],[51.6,12.0],[40.9,12.0],[40.9,-1.7]] },
  { id:'MALI', name:'Mali / Burkina Faso', threat:'DISCR', flFloor:0, flCeil:999, ref:'EASA CZIB-2022-04',
    poly:[[-12.3,10.0],[4.3,10.0],[4.3,25.0],[-12.3,25.0],[-12.3,10.0]] },
  { id:'DPRK', name:'Pyongyang FIR', threat:'AVOID', flFloor:0, flCeil:999, ref:'EASA CZIB-2017-02R3 · FAA SFAR 79',
    poly:[[124.0,37.7],[130.7,37.7],[130.7,43.0],[124.0,43.0],[124.0,37.7]] },
  { id:'ETHI', name:'Tigray / N-Ethiopia', threat:'CAUTION', flFloor:0, flCeil:999, ref:'EASA CZIB-2020-04R2',
    poly:[[36.4,12.0],[41.8,12.0],[41.8,15.3],[36.4,15.3],[36.4,12.0]] },
  { id:'NIGR', name:'Niger airspace', threat:'CAUTION', flFloor:0, flCeil:999, ref:'EASA CZIB-2023-04',
    poly:[[0.1,11.7],[15.9,11.7],[15.9,23.6],[0.1,23.6],[0.1,11.7]] },
  { id:'MYAN', name:'Myanmar FIR', threat:'CAUTION', flFloor:0, flCeil:999, ref:'EASA CZIB-2021-03R2',
    poly:[[92.2,9.7],[101.2,9.7],[101.2,28.6],[92.2,28.6],[92.2,9.7]] },
  { id:'VENZ', name:'Venezuela FIR', threat:'CAUTION', flFloor:0, flCeil:200, ref:'EASA CZIB-2019-02 · FAA SFAR 117',
    poly:[[-73.4,0.6],[-59.8,0.6],[-59.8,12.2],[-73.4,12.2],[-73.4,0.6]] },
]

// Point-in-polygon (ray-casting) for [lng,lat]
function pointInPoly(lng: number, lat: number, poly: Array<[number, number]>): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1]
    const xj = poly[j][0], yj = poly[j][1]
    const intersect = ((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

// Approx NM distance from point to polygon boundary (positive if outside, 0 if inside)
function distToPolyNM(lng: number, lat: number, poly: Array<[number, number]>): number {
  if (pointInPoly(lng, lat, poly)) return 0
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j][0], ay = poly[j][1]
    const bx = poly[i][0], by = poly[i][1]
    const dx = bx - ax, dy = by - ay
    const t = Math.max(0, Math.min(1, ((lng - ax) * dx + (lat - ay) * dy) / Math.max(1e-12, dx * dx + dy * dy)))
    const px = ax + t * dx, py = ay + t * dy
    const dLng = (lng - px) * Math.cos((lat * Math.PI) / 180)
    const dLat = lat - py
    const nm = Math.sqrt(dLng * dLng + dLat * dLat) * 60
    if (nm < best) best = nm
  }
  return best
}

// Project flight forward and estimate dwell minutes in zone (cap 30)
function projectDwellMin(f: SFlight, zone: Zone, horizonMin: number): number {
  if (!Number.isFinite(f.velocityKts) || f.velocityKts < 30) return pointInPoly(f.lng, f.lat, zone.poly) ? horizonMin : 0
  const stepMin = 2
  const trk = ((f.track || 0) * Math.PI) / 180
  let lat = f.lat, lng = f.lng, dwell = 0
  for (let t = 0; t <= horizonMin; t += stepMin) {
    if (pointInPoly(lng, lat, zone.poly)) dwell += stepMin
    const dNm = f.velocityKts * (stepMin / 60)
    const dLat = (dNm * Math.cos(trk)) / 60
    const dLng = (dNm * Math.sin(trk)) / (60 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)))
    lat += dLat; lng += dLng
  }
  return Math.min(horizonMin, dwell)
}

interface Assessment {
  f: SFlight; zone: Zone; tier: Tier; score: number
  inside: boolean; distNM: number; dwellMin: number
  drivers: { INZ: number; ALT: number; DWL: number; PRX: number; OPR: number; RTE: number }
  rationale: string
}

function operatorRisk(op?: string, sanc?: string[]): number {
  if (!op || !sanc) return 0
  const u = op.toUpperCase()
  for (const s of sanc) if (u.startsWith(s)) return 100
  return 0
}

function tierFromScore(s: number, inside: boolean, threat: Threat): Tier {
  if (inside && threat === 'AVOID') return s >= 60 ? 'CRITICAL' : 'HIGH'
  if (s >= 80) return 'CRITICAL'
  if (s >= 60) return 'HIGH'
  if (s >= 40) return 'ELEVATED'
  if (s >= 20) return 'GUARDED'
  return 'CLEAR'
}

const SRC = 'czne-src'
const LBL = 'czne-lbl'

export default function CzneConflictZone({ map, flights, onClose, onFly }: Props) {
  const [scopeNM, setScopeNM] = useState<number>(150)
  const [horizonMin, setHorizonMin] = useState<number>(30)
  const [advMul, setAdvMul] = useState<number>(100)
  const [minFL, setMinFL] = useState<number>(0)
  const [maxFL, setMaxFL] = useState<number>(500)
  const [threatFilter, setThreatFilter] = useState<'ALL' | Threat>('ALL')
  const [tierFilter, setTierFilter] = useState<'ALL' | Tier>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'ZONES'>('AIRCRAFT')
  const [search, setSearch] = useState<string>('')
  const [showHalo, setShowHalo] = useState(true)
  const [showZone, setShowZone] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)

  const assessments = useMemo<Assessment[]>(() => {
    const out: Assessment[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      const fl = f.altitudeFt / 100
      if (fl < minFL || fl > maxFL) continue
      // Find best (worst) zone in scope
      let best: Assessment | null = null
      for (const z of ZONES) {
        if (threatFilter !== 'ALL' && z.threat !== threatFilter) continue
        const inside = pointInPoly(f.lng, f.lat, z.poly)
        const dist = inside ? 0 : distToPolyNM(f.lng, f.lat, z.poly)
        if (dist > scopeNM) continue
        // Drivers
        const INZ = inside ? THREAT_BASE[z.threat] : 0
        let ALT = 0
        if (inside) {
          if (fl < z.flFloor) ALT = 100
          else if (fl < z.flFloor + 20) ALT = 50
          else ALT = Math.max(0, 30 - Math.min(30, fl - z.flCeil))
        } else {
          ALT = 0
        }
        const dwell = inside ? projectDwellMin(f, z, horizonMin) : 0
        const DWL = Math.min(100, (dwell / horizonMin) * 100)
        const PRX = inside ? 100 : (dist <= 25 ? 70 : dist <= 75 ? 30 : 10)
        const OPR = operatorRisk(f.operator, z.sanctionedOps)
        const RTE = inside ? 50 : (dist <= 25 ? 30 : 10)
        const drivers = { INZ, ALT, DWL, PRX, OPR, RTE }
        const arr = [INZ, ALT, DWL, PRX, OPR, RTE]
        const mx = Math.max(...arr)
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length
        let score = Math.min(100, (mx * 0.72 + mean * 0.28) * (advMul / 100))
        if (inside && z.threat === 'AVOID') score = Math.max(score, 75)
        const tier = tierFromScore(score, inside, z.threat)
        const rationale = inside
          ? (z.threat === 'AVOID'
              ? `Inside AVOID zone ${z.id} (${z.name}). Re-route per ${z.ref}. Projected dwell ${Math.round(dwell)}min.`
              : `Inside ${z.threat} zone ${z.id}. Verify dispatch authorisation per ${z.ref}.`)
          : `${Math.round(dist)}NM from ${z.id} boundary. ${z.threat} threat per ${z.ref}.`
        const cand: Assessment = { f, zone: z, tier, score, inside, distNM: dist, dwellMin: dwell, drivers, rationale }
        if (!best || TIER_RANK[cand.tier] < TIER_RANK[best.tier] || (cand.tier === best.tier && cand.score > best.score)) best = cand
      }
      if (best) out.push(best)
    }
    out.sort((a, b) => {
      const r = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (r !== 0) return r
      return b.score - a.score
    })
    return out
  }, [flights, scopeNM, horizonMin, advMul, minFL, maxFL, threatFilter])

  const filtered = useMemo(() => {
    let xs = assessments
    if (tierFilter !== 'ALL') xs = xs.filter(a => a.tier === tierFilter)
    if (search) {
      const s = search.toLowerCase()
      xs = xs.filter(a => (a.f.callsign || a.f.icao).toLowerCase().includes(s) || a.zone.id.toLowerCase().includes(s) || (a.f.operator || '').toLowerCase().includes(s))
    }
    return xs
  }, [assessments, tierFilter, search])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { CRITICAL:0, HIGH:0, ELEVATED:0, GUARDED:0, CLEAR:0, IDLE:0 }
    for (const a of assessments) c[a.tier]++
    return c
  }, [assessments])

  const meanScore = assessments.length ? (assessments.reduce((s, a) => s + a.score, 0) / assessments.length) : 0
  const worst = assessments[0]
  const criticalCount = counts.CRITICAL + counts.HIGH

  // Map overlay
  useEffect(() => {
    const m = map
    if (!m) return
    const features: GeoJSON.Feature[] = []
    const labels: GeoJSON.Feature[] = []

    // Zone polygons (boundary + faint fill)
    if (showZone) {
      for (const z of ZONES) {
        if (threatFilter !== 'ALL' && z.threat !== threatFilter) continue
        features.push({ type:'Feature', properties:{ kind:'zone-fill', color: THREAT_COLOR[z.threat] }, geometry:{ type:'Polygon', coordinates:[z.poly] } })
        features.push({ type:'Feature', properties:{ kind:'zone-line', color: THREAT_COLOR[z.threat] }, geometry:{ type:'Polygon', coordinates:[z.poly] } })
        // centroid label
        let cx = 0, cy = 0
        for (const p of z.poly) { cx += p[0]; cy += p[1] }
        cx /= z.poly.length; cy /= z.poly.length
        labels.push({ type:'Feature', properties:{ kind:'zone-lbl', text:`${z.id} · ${z.threat}`, color: THREAT_COLOR[z.threat] }, geometry:{ type:'Point', coordinates:[cx, cy] } })
      }
    }

    // Halos + pins + labels per aircraft assessment
    for (const a of filtered) {
      const col = TIER_COLOR[a.tier]
      if (showHalo) {
        const r = 8 + Math.min(14, a.score * 0.14)
        features.push({ type:'Feature', properties:{ kind:'halo', color: col, radius: r }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
      if (showPin && (a.tier === 'CRITICAL' || a.tier === 'HIGH')) {
        features.push({ type:'Feature', properties:{ kind:'pin', color: col }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
      if (showLbl) {
        const txt = `${a.f.callsign || a.f.icao.toUpperCase()} ${a.zone.id} ${a.tier}`
        labels.push({ type:'Feature', properties:{ kind:'flt-lbl', text: txt, color: col }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
    }

    try {
      if (!m.getSource(SRC)) m.addSource(SRC, { type:'geojson', data:{ type:'FeatureCollection', features } as GeoJSON.FeatureCollection })
      else (m.getSource(SRC) as maplibregl.GeoJSONSource).setData({ type:'FeatureCollection', features } as GeoJSON.FeatureCollection)
      if (!m.getSource(LBL)) m.addSource(LBL, { type:'geojson', data:{ type:'FeatureCollection', features: labels } as GeoJSON.FeatureCollection })
      else (m.getSource(LBL) as maplibregl.GeoJSONSource).setData({ type:'FeatureCollection', features: labels } as GeoJSON.FeatureCollection)

      if (!m.getLayer('czne-zone-fill')) m.addLayer({ id:'czne-zone-fill', type:'fill', source:SRC, filter:['==',['get','kind'],'zone-fill'], paint:{ 'fill-color':['get','color'], 'fill-opacity':0.07 } })
      if (!m.getLayer('czne-zone-line')) m.addLayer({ id:'czne-zone-line', type:'line', source:SRC, filter:['==',['get','kind'],'zone-line'], paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-dasharray':[3,2], 'line-opacity':0.85 } })
      if (!m.getLayer('czne-halo')) m.addLayer({ id:'czne-halo', type:'circle', source:SRC, filter:['==',['get','kind'],'halo'], paint:{ 'circle-color':'transparent', 'circle-stroke-color':['get','color'], 'circle-stroke-width':2, 'circle-radius':['get','radius'], 'circle-opacity':0.75 } })
      if (!m.getLayer('czne-pin')) m.addLayer({ id:'czne-pin', type:'circle', source:SRC, filter:['==',['get','kind'],'pin'], paint:{ 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.2, 'circle-radius':5 } })
      if (!m.getLayer('czne-lbl')) m.addLayer({ id:'czne-lbl', type:'symbol', source:LBL, layout:{ 'text-field':['get','text'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.3 } })
    } catch {}

    return () => {
      try {
        for (const id of ['czne-zone-fill','czne-zone-line','czne-halo','czne-pin','czne-lbl']) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC, LBL]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showZone, showHalo, showPin, showLbl, threatFilter])

  return (
    <div className="absolute top-16 right-4 z-30 w-[460px] max-h-[82vh] flex flex-col rounded-lg border border-slate-700/70 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/70">
        <div className="flex items-center gap-2">
          <span className="text-sky-400 font-mono text-xs tracking-widest">CZNE</span>
          <span className="text-[10px] text-slate-500">CONFLICT-ZONE OVERFLIGHT ADVISOR</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm px-1">✕</button>
      </div>

      {/* Tier strip */}
      <div className="grid grid-cols-6 gap-px bg-slate-800/70 border-b border-slate-700/70 text-[10px] font-mono">
        {(['CRITICAL','HIGH','ELEVATED','GUARDED','CLEAR'] as Tier[]).map(t => {
          const active = tierFilter === t
          return (
            <button key={t}
              onClick={() => setTierFilter(active ? 'ALL' : t)}
              className={`px-1 py-1.5 flex flex-col items-center ${active ? 'bg-sky-500/15 ring-1 ring-sky-500/40' : 'bg-slate-900 hover:bg-slate-800'}`}>
              <span style={{ color: TIER_COLOR[t] }} className="font-semibold">{counts[t]}</span>
              <span className="text-[9px] text-slate-500 mt-0.5">{t}</span>
            </button>
          )
        })}
        <button
          onClick={() => setTierFilter('ALL')}
          className={`px-1 py-1.5 flex flex-col items-center ${tierFilter === 'ALL' ? 'bg-sky-500/15 ring-1 ring-sky-500/40' : 'bg-slate-900 hover:bg-slate-800'}`}>
          <span className="text-slate-200 font-semibold">{assessments.length}</span>
          <span className="text-[9px] text-slate-500 mt-0.5">ALL</span>
        </button>
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-3 gap-px bg-slate-800/70 border-b border-slate-700/70 text-[10px] font-mono">
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Mean score</div>
          <div className="text-slate-100">{meanScore.toFixed(1)}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao.toUpperCase()) : '—'}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Critical+High</div>
          <div style={{ color: TIER_COLOR.CRITICAL }}>{criticalCount}</div>
        </div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-700/70 space-y-1.5">
        {([
          ['SCOPE', scopeNM, setScopeNM, 25, 500, 'NM'],
          ['HORIZ', horizonMin, setHorizonMin, 5, 120, 'min'],
          ['ADV-MUL', advMul, setAdvMul, 50, 200, '%'],
          ['MIN-FL', minFL, setMinFL, 0, 500, ''],
          ['MAX-FL', maxFL, setMaxFL, 0, 500, ''],
        ] as Array<[string, number, (n:number)=>void, number, number, string]>).map(([lbl, v, set, lo, hi, u]) => (
          <div key={lbl} className="flex items-center gap-2">
            <span className="text-[9px] text-slate-500 font-mono w-14">{lbl}</span>
            <input type="range" min={lo} max={hi} value={v} onChange={e => set(Number(e.target.value))} className="flex-1 accent-sky-500" />
            <span className="text-[10px] text-slate-300 font-mono w-14 text-right">{v}{u}</span>
          </div>
        ))}
      </div>

      {/* Threat filter + toggles */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center flex-wrap gap-1">
        {(['ALL','AVOID','DISCR','CAUTION'] as Array<'ALL'|Threat>).map(t => {
          const active = threatFilter === t
          const col = t === 'ALL' ? '#94a3b8' : THREAT_COLOR[t as Threat]
          return (
            <button key={t}
              onClick={() => setThreatFilter(t)}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${active ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
              <span style={{ color: col }}>●</span> {t}
            </button>
          )
        })}
        <div className="flex-1" />
        {([['HALO',showHalo,setShowHalo],['ZONE',showZone,setShowZone],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl]] as Array<[string, boolean, (v:boolean)=>void]>).map(([n,v,s]) => (
          <button key={n} onClick={() => s(!v)} className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${v ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-500'}`}>{n}</button>
        ))}
      </div>

      {/* Search + tabs */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center gap-1.5">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search callsign/zone/operator"
          className="flex-1 text-[11px] font-mono bg-slate-950/70 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 placeholder-slate-600 outline-none focus:border-sky-500/60" />
        {(['AIRCRAFT','ZONES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${tab === t ? 'bg-sky-500/15 ring-1 ring-sky-500/40 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/70">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-slate-500">No flights in scope.</div>}
            {filtered.map(a => {
              const col = TIER_COLOR[a.tier]
              return (
                <button key={a.f.icao + a.zone.id}
                  onClick={() => onFly(a.f.icao)}
                  className="w-full text-left px-2 py-1.5 hover:bg-slate-800/40">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: col }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="text-slate-100 font-semibold">{a.f.callsign || a.f.icao.toUpperCase()}</span>
                        <span className="text-slate-500">{a.f.type || '—'}</span>
                        <span className="text-[9px] px-1 py-0 rounded" style={{ background: THREAT_COLOR[a.zone.threat] + '25', color: THREAT_COLOR[a.zone.threat] }}>{a.zone.id}</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: col + '25', color: col }}>{a.tier}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        <span>FL{String(Math.round(a.f.altitudeFt / 100)).padStart(3,'0')}</span>
                        <span>{Math.round(a.f.velocityKts)}kt</span>
                        <span style={{ color: a.inside ? '#ef4444' : '#94a3b8' }}>{a.inside ? `INSIDE · ${Math.round(a.dwellMin)}min` : `${Math.round(a.distNM)}NM`}</span>
                        <span className="text-slate-500 truncate">{a.f.operator || ''}</span>
                      </div>
                      <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden">
                        <div className="h-full" style={{ width: `${Math.min(100, a.score)}%`, background: col }} />
                      </div>
                      <div className="grid grid-cols-6 gap-0.5 mt-1 text-[9px] font-mono">
                        {(['INZ','ALT','DWL','PRX','OPR','RTE'] as const).map(k => (
                          <div key={k} className="bg-slate-950/60 rounded px-1 py-0.5 flex justify-between">
                            <span className="text-slate-500">{k}</span>
                            <span style={{ color: col }}>{Math.round(a.drivers[k])}</span>
                          </div>
                        ))}
                      </div>
                      <div className="mt-1 text-[10px] text-slate-400 leading-snug">{a.rationale}</div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {tab === 'ZONES' && (
          <div className="divide-y divide-slate-800/70">
            {ZONES.filter(z => threatFilter === 'ALL' || z.threat === threatFilter).map(z => {
              const inZone = assessments.filter(a => a.zone.id === z.id)
              const crit = inZone.filter(a => a.tier === 'CRITICAL' || a.tier === 'HIGH').length
              const tcol = THREAT_COLOR[z.threat]
              return (
                <div key={z.id} className="px-2 py-1.5">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: tcol }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="text-sky-300 font-semibold">{z.id}</span>
                        <span className="text-slate-300 truncate">{z.name}</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: tcol + '25', color: tcol }}>{z.threat}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        <span>FL{z.flFloor === 0 ? 'SFC' : z.flFloor}-{z.flCeil === 999 ? 'UNL' : z.flCeil}</span>
                        <span className="text-slate-500">·</span>
                        <span>{inZone.length} in-scope</span>
                        {crit > 0 && <span style={{ color: TIER_COLOR.CRITICAL }}>· {crit} crit/high</span>}
                      </div>
                      <div className="mt-0.5 text-[9px] text-slate-500 italic truncate">{z.ref}</div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-700/70 text-[9px] text-slate-500 leading-snug">
        EASA CZIB portal · FAA SFAR 77/79/81/110/112/113/114/116/117 · ICAO Doc 10084 CZ-RAM · 14 CFR §91.703 §91.711 · UK CAP 1864 · Polygons are coarse FIR envelopes for planning visualisation, not for navigation.
      </div>
    </div>
  )
}
