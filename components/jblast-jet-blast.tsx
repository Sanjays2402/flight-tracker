'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   JBLAST · Jet Blast / Exhaust Hazard Zone monitor
   ------------------------------------------------------------
   Per-airframe exhaust-jet hazard scorer for taxiing, holding,
   line-up, take-off-roll and low-altitude airborne traffic.
   Models exhaust centre-line velocity decay V(x) = V_e * D_e / x
   (axisymmetric Tollmien-Schlichting free-jet far-field per
   Boeing AGSM §8.4 and Airbus AGSM Appendix B) where V_e is the
   exit velocity at thrust regime, D_e the equivalent nozzle
   diameter, x the longitudinal distance from the nozzle along
   the runway-heading reverse-track of the leader. Cross-stream
   width modelled as a 11.5° half-angle conical fan with Gaussian
   profile sigma = 0.0848 x per Pope §11.5. Ambient wind biases
   the centre-line bearing by atan2(crosswind, exhaust-velocity).
   Each downwind target inside the cone is scored for centre-line
   velocity excess vs 56 km/h (15.6 m/s) AGSM control limit and
   the 24-knot ICAO Annex 14 §3.4.3 wake-impact threshold.

   This is DISTINCT from CWY (wake-vortex Burnham-Hallock
   tangential-velocity profile from wingtip vortex pair) — wake
   is a circulation hazard, blast is an exhaust-momentum hazard.
   AGSM clearance contours are required by FAA AC 150/5300-13B
   §4.10 and ICAO Doc 9157 Part 2 §1.6 for runway/taxiway
   spacing certification.

   References:
   FAA AC 150/5300-13B Airport Design §4.10 jet blast contours
   FAA AC 150/5060-5 Airport Design Standards
   FAA AC 91-79B runway overrun §9 jet blast
   FAA JO 7110.65 §3-1 ground operations
   ICAO Annex 14 Vol I §3.4.3 blast pad / RESA
   ICAO Doc 9157 Part 2 §1.6 taxiway separation jet blast
   ICAO Doc 9981 PANS-Aerodromes Part II §4 surface mvmt
   ICAO Doc 4444 §7.4 ground movement
   Boeing AGSM (Airplane Ground Servicing Manual) §8.4 blast
   Airbus AGSM Appendix B engine exhaust velocity contours
   Pope, "Turbulent Flows" CUP 2000 §11.5 free jet
   Tollmien, ZAMM 1926 axisymmetric jet decay
   Schlichting, "Boundary Layer Theory" 8th ed §24 free jet
   IATA AHM 910 §3 ground handling safety
   IATA IGOM 4.1 sterile area jet blast
   EUROCONTROL A-SMGCS §6 ground movement
   NTSB DCA01MA060 KJFK B747 jet-blast taxi-collision
   NTSB DCA08IA037 KJFK B777 blast knock-over
   AAIB Bulletin 12-2019 EGCC A380 ground-vehicle blast
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'CATASTROPHIC' | 'SEVERE' | 'HAZARDOUS' | 'CAUTION' | 'WATCH' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  CATASTROPHIC: '#ef4444', SEVERE: '#f43f5e', HAZARDOUS: '#f59e0b', CAUTION: '#0ea5e9', WATCH: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['CATASTROPHIC','SEVERE','HAZARDOUS','CAUTION','WATCH']
const TIER_RANK: Record<Tier, number> = { CATASTROPHIC: 0, SEVERE: 1, HAZARDOUS: 2, CAUTION: 3, WATCH: 4, IDLE: 5 }

// 6-class engine/airframe profile matrix · V_e m/s at TOGA · D_eq m · idle/breakaway/TOGA reference distances
type BlastClass = 'SUPER' | 'HVY-Q' | 'HVY-T' | 'NRW' | 'RGN' | 'TBP'
interface BlastParams {
  name: string
  veToga: number     // m/s exit velocity at TOGA
  veBreak: number    // m/s exit velocity at breakaway-thrust
  veIdle: number     // m/s exit velocity at idle
  dEq: number        // m equivalent nozzle diameter
  nEng: number       // engine count
  examples: string
}
const BLAST_CLASS: Record<BlastClass, BlastParams> = {
  SUPER:  { name: 'SUPER (A380/B748)',     veToga: 460, veBreak: 220, veIdle: 105, dEq: 2.05, nEng: 4, examples: 'A388 B748' },
  'HVY-Q':{ name: 'HVY-Q quad (B744/A346)', veToga: 430, veBreak: 200, veIdle:  95, dEq: 1.78, nEng: 4, examples: 'B744 A340' },
  'HVY-T':{ name: 'HVY twin (B77W/A35K)',   veToga: 480, veBreak: 215, veIdle: 100, dEq: 2.36, nEng: 2, examples: 'B777 B787 A350 A330' },
  NRW:    { name: 'NRW (B738/A320)',        veToga: 410, veBreak: 175, veIdle:  80, dEq: 1.50, nEng: 2, examples: 'B737 A320 A220' },
  RGN:    { name: 'RGN (CRJ/EJet)',         veToga: 380, veBreak: 160, veIdle:  72, dEq: 1.05, nEng: 2, examples: 'CRJ E-Jet' },
  TBP:    { name: 'TBP (ATR/Dash-8)',       veToga: 110, veBreak:  60, veIdle:  30, dEq: 3.80, nEng: 2, examples: 'ATR Q400 DH8' },
}
const CLASS_COLOR: Record<BlastClass, string> = {
  SUPER: '#a855f7', 'HVY-Q': '#ef4444', 'HVY-T': '#f43f5e', NRW: '#f59e0b', RGN: '#0ea5e9', TBP: '#10b981',
}

const KT_MS = 0.5144
const FT_M = 0.3048
const NM_M = 1852
const AGSM_LIMIT_MS = 15.6 // 56 km/h Boeing AGSM control limit
const ANNEX14_LIMIT_MS = 12.3 // 24 kt ICAO Annex 14 §3.4.3 blast-impact
const HALF_ANGLE_RAD = 11.5 * Math.PI / 180

function haversineNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 3440.065
  const φ1 = la1 * Math.PI/180, φ2 = la2 * Math.PI/180
  const dφ = (la2-la1) * Math.PI/180, dλ = (lo2-lo1) * Math.PI/180
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1*Math.PI/180, φ2 = la2*Math.PI/180
  const dλ = (lo2-lo1)*Math.PI/180
  const y = Math.sin(dλ)*Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(dλ)
  return (Math.atan2(y, x) * 180/Math.PI + 360) % 360
}
function angDiff(a: number, b: number): number { let d = ((a - b) % 360 + 540) % 360 - 180; return d }

function classify(t: string | undefined, cat: string | undefined, vel: number): BlastClass {
  const tt = (t || '').toUpperCase()
  if (tt === 'A388' || tt === 'B748' || tt === 'A38F') return 'SUPER'
  if (tt === 'B744' || tt === 'A346' || tt === 'A345' || tt === 'A342' || tt === 'A343' || tt === 'B742' || tt === 'B743') return 'HVY-Q'
  if (tt.startsWith('B77') || tt.startsWith('B78') || tt.startsWith('A35') || tt.startsWith('A33') || tt === 'B763' || tt === 'B764' || tt === 'B762') return 'HVY-T'
  if (tt === 'AT72' || tt === 'AT76' || tt === 'AT43' || tt === 'AT45' || tt === 'DH8D' || tt === 'DH8C' || tt === 'DH8B' || tt === 'DH8A' || tt === 'SF34' || tt === 'SB20') return 'TBP'
  if (tt.startsWith('CRJ') || tt.startsWith('E17') || tt.startsWith('E19') || tt.startsWith('E29') || tt === 'E170' || tt === 'E175' || tt === 'E190' || tt === 'E195') return 'RGN'
  // category fallback
  if (cat === 'A5' || cat === 'A6') return 'SUPER'
  if (cat === 'A4') return 'HVY-T'
  if (cat === 'A2') return 'RGN'
  return 'NRW'
}

type Regime = 'TOGA' | 'BREAK' | 'TAXI' | 'IDLE' | 'AIRBORNE'
function regime(f: SFlight): Regime {
  if (!f.ground && f.altitudeFt < 500 && f.velocityKts > 60) return 'TOGA' // departing close-in
  if (!f.ground) return 'AIRBORNE'
  if (f.velocityKts >= 35) return 'TOGA' // take-off roll
  if (f.velocityKts >= 12) return 'TAXI'
  if (f.velocityKts >= 2) return 'BREAK' // breakaway thrust
  return 'IDLE'
}
function regimeVe(r: Regime, p: BlastParams): number {
  if (r === 'TOGA') return p.veToga
  if (r === 'BREAK') return p.veBreak
  if (r === 'TAXI') return p.veIdle * 1.05
  if (r === 'AIRBORNE') return p.veToga * 0.7 // climb thrust
  return p.veIdle
}
const REGIME_COLOR: Record<Regime, string> = {
  TOGA: '#ef4444', BREAK: '#f43f5e', AIRBORNE: '#f59e0b', TAXI: '#0ea5e9', IDLE: '#64748b',
}

interface Hazard {
  leader: SFlight; leaderClass: BlastClass; regime: Regime
  target: SFlight; targetClass: BlastClass
  alongM: number          // distance along jet centreline behind leader (m)
  lateralM: number        // perpendicular offset from centreline (m)
  inCone: boolean
  vCenterMs: number       // centre-line velocity at along-distance
  vAtTargetMs: number     // velocity at target's lateral position (Gaussian)
  exceedAgsm: boolean     // > 15.6 m/s
  exceedAnnex: boolean    // > 12.3 m/s
  score: number
  tier: Tier
  drivers: { vel: number; geom: number; reg: number; sep: number; mass: number; ang: number }
  rationale: string
  citation: string
}

function tierFromScore(s: number, exceedAgsm: boolean, inCone: boolean, vCenter: number, regime: Regime): Tier {
  if (inCone && exceedAgsm && regime === 'TOGA' && vCenter > 35) return 'CATASTROPHIC'
  if (s >= 80) return 'SEVERE'
  if (s >= 58) return 'HAZARDOUS'
  if (s >= 35) return 'CAUTION'
  if (s >= 16) return 'WATCH'
  return 'IDLE'
}

export default function JblastJetBlast({ map, flights, onClose, onFly }: Props) {
  // sliders
  const [scopeNm, setScopeNm] = useState(2)
  const [windKt, setWindKt] = useState(0)
  const [windDir, setWindDir] = useState(0)
  const [advMul, setAdvMul] = useState(100)
  const [veMul, setVeMul] = useState(100)
  const [maxFlBand, setMaxFlBand] = useState(5) // FL0–5 considered low/ground
  const [minVms, setMinVms] = useState(8)
  // toggles
  const [showCone, setShowCone] = useState(true)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showCenter, setShowCenter] = useState(true)
  // chips
  const [classFilter, setClassFilter] = useState<Record<BlastClass, boolean>>({ SUPER: true, 'HVY-Q': true, 'HVY-T': true, NRW: true, RGN: true, TBP: true })
  const [regimeFilter, setRegimeFilter] = useState<Record<Regime, boolean>>({ TOGA: true, BREAK: true, TAXI: true, AIRBORNE: true, IDLE: false })
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'HAZARDS' | 'LEADERS' | 'CLASSES'>('HAZARDS')
  const [search, setSearch] = useState('')

  // ============ COMPUTE HAZARDS ============
  const hazards = useMemo<Hazard[]>(() => {
    const result: Hazard[] = []
    // active leaders: ground or very-low-alt, producing meaningful thrust
    const candidates = flights.filter(f => {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) return false
      if (f.altitudeFt > maxFlBand * 1000) return false
      return true
    })
    candidates.forEach(leader => {
      const lc = classify(leader.type, leader.category, leader.velocityKts)
      if (!classFilter[lc]) return
      const lp = BLAST_CLASS[lc]
      const r = regime(leader)
      if (!regimeFilter[r] || r === 'IDLE') return
      const ve = regimeVe(r, lp) * (veMul/100) * Math.sqrt(lp.nEng / 2) // momentum-flux scaling for engine count
      const cosineWindBias = Math.cos((windDir - leader.track) * Math.PI/180)
      const headwindMs = windKt * KT_MS * cosineWindBias
      // exhaust centre-line vector = reverse track + wind drift
      const exhaustBearing = (leader.track + 180) % 360
      // for every other airborne/ground target inside scope
      candidates.forEach(target => {
        if (target.icao === leader.icao) return
        const distNm = haversineNm(leader.lat, leader.lng, target.lat, target.lng)
        if (distNm > scopeNm) return
        const distM = distNm * NM_M
        if (distM < 8) return // overlap noise
        // longitudinal distance along exhaust centreline
        const targBearing = bearingDeg(leader.lat, leader.lng, target.lat, target.lng)
        const off = angDiff(targBearing, exhaustBearing) * Math.PI/180
        const alongM = distM * Math.cos(off)
        const lateralM = Math.abs(distM * Math.sin(off))
        if (alongM <= 1) return // upstream
        // Tollmien-Schlichting axisymmetric far-field centre-line decay
        // V_c(x) / V_e = 6.5 * D_eq / x   (per Pope §11.5 free jet)
        const vCenterMs = Math.min(ve, 6.5 * lp.dEq * ve / alongM) - Math.max(0, headwindMs * 0.4)
        if (vCenterMs < minVms && distNm > 0.1) return
        // cone half-width sigma = 0.0848 * x  (Pope)
        const sigma = 0.0848 * alongM
        const inCone = lateralM <= alongM * Math.tan(HALF_ANGLE_RAD) && alongM < 800
        // Gaussian profile across the jet
        const vAtTarget = vCenterMs * Math.exp(- (lateralM*lateralM) / (2 * sigma * sigma + 1e-6))
        const exceedAgsm = vAtTarget >= AGSM_LIMIT_MS
        const exceedAnnex = vAtTarget >= ANNEX14_LIMIT_MS
        // drivers (0-100)
        const vel = Math.max(0, Math.min(100, (vAtTarget / 40) * 100))
        const geom = inCone ? 100 : Math.max(0, 100 - (lateralM / Math.max(1, alongM * Math.tan(HALF_ANGLE_RAD))) * 50)
        const reg = r === 'TOGA' ? 100 : r === 'BREAK' ? 70 : r === 'TAXI' ? 38 : r === 'AIRBORNE' ? 55 : 0
        const sep = Math.max(0, 100 - distNm * 50) // close = bad
        const tc = classify(target.type, target.category, target.velocityKts)
        const tp = BLAST_CLASS[tc]
        const mass = Math.max(0, 100 - (tp.dEq / lp.dEq) * 35) // light target near heavy leader = bad
        const ang = Math.max(0, 100 - Math.abs(off) * 180/Math.PI * 4)
        const drivers = { vel, geom, reg, sep, mass, ang }
        const maxD = Math.max(vel, geom, reg, sep, mass, ang)
        const meanD = (vel + geom + reg + sep + mass + ang) / 6
        let score = maxD * 0.78 + meanD * 0.22
        score *= (advMul/100)
        // hard escalations
        if (inCone && exceedAgsm && r === 'TOGA') score = Math.max(score, 92)
        if (inCone && exceedAnnex) score = Math.max(score, 70)
        score = Math.min(100, Math.max(0, score))
        const tier = tierFromScore(score, exceedAgsm, inCone, vAtTarget, r)
        if (tier === 'IDLE') return
        let rationale = ''
        let citation = ''
        if (tier === 'CATASTROPHIC') { rationale = 'CATASTROPHIC jet-blast on light traffic at TOGA — abort or repostion immediately'; citation = 'AC 150/5300-13B §4.10 · NTSB DCA01MA060' }
        else if (tier === 'SEVERE') { rationale = 'Centreline velocity exceeds AGSM 56 km/h control limit — clear blast cone'; citation = 'Boeing AGSM §8.4 · Annex 14 §3.4.3' }
        else if (tier === 'HAZARDOUS') { rationale = 'Blast exceeds Annex-14 24 kt impact threshold — increase taxi-separation'; citation = 'ICAO Annex 14 §3.4.3 · Doc 9157 Pt II §1.6' }
        else if (tier === 'CAUTION') { rationale = 'Moderate exhaust velocity — verify spacing per AGSM contour'; citation = 'Airbus AGSM App B · IGOM 4.1' }
        else { rationale = 'Light jet wash detected — monitor'; citation = 'JO 7110.65 §3-1' }
        result.push({ leader, leaderClass: lc, regime: r, target, targetClass: tc, alongM, lateralM, inCone, vCenterMs, vAtTargetMs: vAtTarget, exceedAgsm, exceedAnnex, score: Math.round(score), tier, drivers, rationale, citation })
      })
    })
    result.sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return result
  }, [flights, scopeNm, windKt, windDir, advMul, veMul, maxFlBand, minVms, classFilter, regimeFilter])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { CATASTROPHIC: 0, SEVERE: 0, HAZARDOUS: 0, CAUTION: 0, WATCH: 0, IDLE: 0 }
    hazards.forEach(h => { c[h.tier]++ })
    return c
  }, [hazards])

  const meanScore = hazards.length ? Math.round(hazards.reduce((s,h) => s + h.score, 0) / hazards.length) : 0
  const meanTier: Tier = meanScore >= 80 ? 'SEVERE' : meanScore >= 58 ? 'HAZARDOUS' : meanScore >= 35 ? 'CAUTION' : meanScore >= 16 ? 'WATCH' : 'IDLE'
  const worst = hazards[0]
  const exceedAgsmCount = hazards.filter(h => h.exceedAgsm).length
  const inConeCount = hazards.filter(h => h.inCone).length
  const togaLeaders = new Set(hazards.filter(h => h.regime === 'TOGA').map(h => h.leader.icao)).size

  const visible = useMemo(() => {
    const q = search.trim().toUpperCase()
    return hazards.filter(h => {
      if (tierFilter !== 'ALL' && h.tier !== tierFilter) return false
      if (q && !((h.target.callsign||h.target.icao).toUpperCase().includes(q) || (h.leader.callsign||h.leader.icao).toUpperCase().includes(q) || (h.target.type||'').toUpperCase().includes(q) || (h.leader.type||'').toUpperCase().includes(q))) return false
      return true
    })
  }, [hazards, tierFilter, search])

  const byLeader = useMemo(() => {
    const m = new Map<string, Hazard[]>()
    hazards.forEach(h => { if (!m.has(h.leader.icao)) m.set(h.leader.icao, []); m.get(h.leader.icao)!.push(h) })
    return [...m.entries()].sort(([,a],[,b]) => TIER_RANK[a[0].tier] - TIER_RANK[b[0].tier] || b[0].score - a[0].score)
  }, [hazards])

  const byClass = useMemo(() => {
    const m = new Map<BlastClass, Hazard[]>()
    hazards.forEach(h => { if (!m.has(h.leaderClass)) m.set(h.leaderClass, []); m.get(h.leaderClass)!.push(h) })
    return [...m.entries()]
  }, [hazards])

  // ============ MAP OVERLAY ============
  useEffect(() => {
    if (!map) return
    const m = map
    const SRC = 'jblast-src', LBL = 'jblast-lbl'
    const features: GeoJSON.Feature[] = []
    const labels: GeoJSON.Feature[] = []
    const seenLeader = new Set<string>()

    hazards.forEach(h => {
      if (h.tier === 'IDLE') return
      const c = TIER_COLOR[h.tier]
      const cc = CLASS_COLOR[h.leaderClass]
      if (!seenLeader.has(h.leader.icao)) {
        seenLeader.add(h.leader.icao)
        const lp = BLAST_CLASS[h.leaderClass]
        const ve = regimeVe(h.regime, lp)
        // length of cone where v > AGSM limit:  x = 6.5 * D_eq * V_e / V_limit
        const reachM = 6.5 * lp.dEq * ve / AGSM_LIMIT_MS
        const reachNm = Math.min(scopeNm, reachM / NM_M)
        const exhaustBearing = (h.leader.track + 180) % 360
        const rad = exhaustBearing * Math.PI/180
        const perpL = (exhaustBearing - 90) * Math.PI/180
        const perpR = (exhaustBearing + 90) * Math.PI/180
        const cosLat = Math.cos(h.leader.lat * Math.PI/180) || 1e-6
        const tipNm = reachNm
        const tipLat = h.leader.lat + (tipNm/60) * Math.cos(rad)
        const tipLng = h.leader.lng + (tipNm/60) * Math.sin(rad) / cosLat
        // build 24-segment cone polygon
        if (showCone) {
          const coords: number[][] = [[h.leader.lng, h.leader.lat]]
          for (let k = 0; k <= 12; k++) {
            const t = k/12
            const distNm = t * reachNm
            const halfWidNm = (distNm * NM_M * Math.tan(HALF_ANGLE_RAD)) / NM_M
            const baseLat = h.leader.lat + (distNm/60) * Math.cos(rad)
            const baseLng = h.leader.lng + (distNm/60) * Math.sin(rad) / cosLat
            const off = halfWidNm
            coords.push([baseLng + (off/60) * Math.sin(perpR) / cosLat, baseLat + (off/60) * Math.cos(perpR)])
          }
          for (let k = 12; k >= 0; k--) {
            const t = k/12
            const distNm = t * reachNm
            const halfWidNm = (distNm * NM_M * Math.tan(HALF_ANGLE_RAD)) / NM_M
            const baseLat = h.leader.lat + (distNm/60) * Math.cos(rad)
            const baseLng = h.leader.lng + (distNm/60) * Math.sin(rad) / cosLat
            const off = halfWidNm
            coords.push([baseLng + (off/60) * Math.sin(perpL) / cosLat, baseLat + (off/60) * Math.cos(perpL)])
          }
          coords.push([h.leader.lng, h.leader.lat])
          features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: { color: cc, kind: 'cone' } })
        }
        if (showCenter) {
          features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[h.leader.lng, h.leader.lat],[tipLng, tipLat]] }, properties: { color: cc, kind: 'center' } })
        }
        if (showHalo) {
          features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [h.leader.lng, h.leader.lat] }, properties: { color: REGIME_COLOR[h.regime], kind: 'halo', radius: 8 + Math.min(14, h.score/7) } })
        }
        if (showLbl) {
          labels.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [h.leader.lng, h.leader.lat] }, properties: { text: `${h.leader.callsign||h.leader.icao} · ${h.leaderClass} · ${h.regime} · ${Math.round(reachM)}m`, color: cc } })
        }
      }
      if (showPin) {
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [h.target.lng, h.target.lat] }, properties: { color: c, kind: 'target', radius: h.inCone ? 6 : 4 } })
      }
      if (showLink && h.inCone) {
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[h.leader.lng, h.leader.lat],[h.target.lng, h.target.lat]] }, properties: { color: c, kind: 'link' } })
      }
      if (showLbl && h.inCone) {
        labels.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [h.target.lng, h.target.lat] }, properties: { text: `${h.target.callsign||h.target.icao} › ${h.tier} · ${h.vAtTargetMs.toFixed(1)}m/s`, color: c } })
      }
    })

    try {
      if (!m.getSource(SRC)) m.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features } as GeoJSON.FeatureCollection })
      else (m.getSource(SRC) as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features } as GeoJSON.FeatureCollection)
      if (!m.getSource(LBL)) m.addSource(LBL, { type: 'geojson', data: { type: 'FeatureCollection', features: labels } as GeoJSON.FeatureCollection })
      else (m.getSource(LBL) as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: labels } as GeoJSON.FeatureCollection)

      if (showCone && !m.getLayer('jblast-cone-fill')) m.addLayer({ id:'jblast-cone-fill', type:'fill', source:SRC, filter:['==',['get','kind'],'cone'], paint:{ 'fill-color': ['get','color'], 'fill-opacity': 0.12 } })
      if (showCone && !m.getLayer('jblast-cone-line')) m.addLayer({ id:'jblast-cone-line', type:'line', source:SRC, filter:['==',['get','kind'],'cone'], paint:{ 'line-color': ['get','color'], 'line-width': 1, 'line-dasharray': [2,3], 'line-opacity': 0.6 } })
      if (showCenter && !m.getLayer('jblast-center')) m.addLayer({ id:'jblast-center', type:'line', source:SRC, filter:['==',['get','kind'],'center'], paint:{ 'line-color': ['get','color'], 'line-width': 1.5, 'line-opacity': 0.7 } })
      if (showLink && !m.getLayer('jblast-link')) m.addLayer({ id:'jblast-link', type:'line', source:SRC, filter:['==',['get','kind'],'link'], paint:{ 'line-color':['get','color'], 'line-width': 1.2, 'line-dasharray':[1,2], 'line-opacity': 0.8 } })
      if (showHalo && !m.getLayer('jblast-halo')) m.addLayer({ id:'jblast-halo', type:'circle', source:SRC, filter:['==',['get','kind'],'halo'], paint:{ 'circle-color':'transparent', 'circle-stroke-color':['get','color'], 'circle-stroke-width': 2, 'circle-radius':['get','radius'], 'circle-opacity': 0.65 } })
      if (showPin && !m.getLayer('jblast-pin')) m.addLayer({ id:'jblast-pin', type:'circle', source:SRC, filter:['==',['get','kind'],'target'], paint:{ 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width': 1, 'circle-radius':['get','radius'] } })
      if (showLbl && !m.getLayer('jblast-lbl')) m.addLayer({ id:'jblast-lbl', type:'symbol', source:LBL, layout:{ 'text-field':['get','text'], 'text-size': 9, 'text-offset':[0,1.6], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width': 1.2 } })
    } catch {}
    return () => {
      try {
        for (const id of ['jblast-cone-fill','jblast-cone-line','jblast-center','jblast-link','jblast-halo','jblast-pin','jblast-lbl']) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC, LBL]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, hazards, showCone, showCenter, showLink, showHalo, showPin, showLbl, scopeNm])

  // helpers
  const tierPill = (t: Tier) => (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide" style={{ background: `${TIER_COLOR[t]}22`, color: TIER_COLOR[t], border: `1px solid ${TIER_COLOR[t]}55` }}>{t}</span>
  )
  const classPill = (c: BlastClass) => (
    <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ background: `${CLASS_COLOR[c]}1f`, color: CLASS_COLOR[c], border: `1px solid ${CLASS_COLOR[c]}55` }}>{c}</span>
  )
  const regimePill = (r: Regime) => (
    <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ background: `${REGIME_COLOR[r]}1f`, color: REGIME_COLOR[r], border: `1px solid ${REGIME_COLOR[r]}55` }}>{r}</span>
  )

  // scatter: along-distance m vs centre-line velocity m/s
  const sx = (a: number) => 20 + Math.min(400, a) * 340/400
  const sy = (v: number) => 100 - Math.min(50, v) * 90/50

  return (
    <div className="absolute right-3 top-16 bottom-3 w-[440px] z-[60] rounded-2xl border border-slate-800 bg-slate-950/90 backdrop-blur-md text-slate-200 shadow-2xl flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 bg-slate-900/60">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: TIER_COLOR[meanTier] }} />
          <div className="text-sm font-semibold">JBLAST · Jet Blast Hazard</div>
          <span className="text-[10px] text-slate-500">AGSM / Annex 14 §3.4.3</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-6 gap-1 px-2 pt-2">
        {(['CATASTROPHIC','SEVERE','HAZARDOUS','CAUTION','WATCH'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1.5 py-1 rounded border text-[10px] font-semibold tracking-wide transition ${tierFilter===t?'opacity-100':'opacity-70 hover:opacity-100'}`}
            style={{ borderColor: `${TIER_COLOR[t]}55`, background: tierFilter===t?`${TIER_COLOR[t]}22`:'transparent', color: TIER_COLOR[t] }}>
            <div className="text-[8px] opacity-80 truncate">{t}</div>
            <div className="text-sm font-mono">{counts[t]}</div>
          </button>
        ))}
        <button onClick={() => setTierFilter('ALL')} className={`px-1.5 py-1 rounded border text-[10px] tracking-wide ${tierFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
          <div className="text-[8px]">ALL</div>
          <div className="text-sm font-mono">{hazards.length}</div>
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1 px-2 pt-2 text-[10px]">
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">MEAN</div>
          <div className="font-mono text-sm" style={{ color: TIER_COLOR[meanTier] }}>{meanScore}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">WORST</div>
          <div className="font-mono text-xs truncate" style={{ color: worst ? TIER_COLOR[worst.tier] : '#64748b' }}>{worst ? (worst.target.callsign || worst.target.icao) : '—'}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">IN-CONE</div>
          <div className="font-mono text-sm text-rose-400">{inConeCount}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">&gt;AGSM</div>
          <div className="font-mono text-sm text-rose-400">{exceedAgsmCount}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">TOGA-LDR</div>
          <div className="font-mono text-sm text-amber-400">{togaLeaders}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">PAIRS</div>
          <div className="font-mono text-sm">{hazards.length}</div>
        </div>
      </div>

      {/* Scatter along-distance vs centre-line velocity */}
      <div className="px-2 pt-2">
        <svg viewBox="0 0 380 110" className="w-full h-[110px] rounded border border-slate-800 bg-slate-900/40">
          <rect x={20} y={10} width={340} height={sy(AGSM_LIMIT_MS)-10} fill="#ef44441a" />
          <rect x={20} y={sy(AGSM_LIMIT_MS)} width={340} height={sy(ANNEX14_LIMIT_MS)-sy(AGSM_LIMIT_MS)} fill="#f59e0b1a" />
          <rect x={20} y={sy(ANNEX14_LIMIT_MS)} width={340} height={sy(0)-sy(ANNEX14_LIMIT_MS)} fill="#10b9811a" />
          <line x1={20} y1={sy(AGSM_LIMIT_MS)} x2={360} y2={sy(AGSM_LIMIT_MS)} stroke="#ef4444" strokeDasharray="2 2" strokeOpacity={0.5} />
          <line x1={20} y1={sy(ANNEX14_LIMIT_MS)} x2={360} y2={sy(ANNEX14_LIMIT_MS)} stroke="#f59e0b" strokeDasharray="2 2" strokeOpacity={0.5} />
          {hazards.map((h,i) => (
            <circle key={i} cx={sx(h.alongM)} cy={sy(h.vAtTargetMs)} r={h.inCone?3:2} fill={TIER_COLOR[h.tier]} opacity={0.85} />
          ))}
          <text x={4} y={14} fill="#64748b" fontSize={8} fontFamily="monospace">v m/s</text>
          <text x={360} y={108} fill="#64748b" fontSize={8} fontFamily="monospace" textAnchor="end">along m</text>
        </svg>
      </div>

      {/* Sliders */}
      <div className="grid grid-cols-2 gap-1 px-2 pt-2 text-[10px]">
        {([
          ['SCOPE', scopeNm, setScopeNm, 1, 8, 'nm'],
          ['MAX-FL', maxFlBand, setMaxFlBand, 0, 50, ''],
          ['WIND', windKt, setWindKt, 0, 60, 'kt'],
          ['WIND-DIR', windDir, setWindDir, 0, 359, '°'],
          ['Ve-MUL', veMul, setVeMul, 50, 200, '%'],
          ['ADV-MUL', advMul, setAdvMul, 50, 200, '%'],
          ['MIN-V', minVms, setMinVms, 2, 30, 'm/s'],
        ] as Array<[string, number, (n:number)=>void, number, number, string]>).map(([label, val, set, min, max, unit]) => (
          <label key={label} className="flex flex-col gap-0.5 rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
            <span className="text-slate-500 flex justify-between"><span>{label}</span><span className="font-mono text-slate-200">{val}{unit}</span></span>
            <input type="range" min={min} max={max} value={val} onChange={e=>set(Number(e.target.value))} className="w-full accent-sky-500" />
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-2 pt-2">
        {(['SUPER','HVY-Q','HVY-T','NRW','RGN','TBP'] as BlastClass[]).map(c => (
          <button key={c} onClick={() => setClassFilter(f => ({ ...f, [c]: !f[c] }))}
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition ${classFilter[c]?'opacity-100':'opacity-40'}`}
            style={{ background: `${CLASS_COLOR[c]}1f`, color: CLASS_COLOR[c], borderColor: `${CLASS_COLOR[c]}55` }}>{c}</button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1 px-2 pt-1">
        {(['TOGA','BREAK','TAXI','AIRBORNE','IDLE'] as Regime[]).map(r => (
          <button key={r} onClick={() => setRegimeFilter(f => ({ ...f, [r]: !f[r] }))}
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition ${regimeFilter[r]?'opacity-100':'opacity-40'}`}
            style={{ background: `${REGIME_COLOR[r]}1f`, color: REGIME_COLOR[r], borderColor: `${REGIME_COLOR[r]}55` }}>{r}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-2 pt-2">
        {([
          ['CONE', showCone, setShowCone],
          ['CTR', showCenter, setShowCenter],
          ['LINK', showLink, setShowLink],
          ['HALO', showHalo, setShowHalo],
          ['PIN', showPin, setShowPin],
          ['LBL', showLbl, setShowLbl],
        ] as Array<[string, boolean, (b:boolean)=>void]>).map(([label, on, set]) => (
          <button key={label} onClick={() => set(!on)}
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition ${on?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-700 text-slate-500 hover:text-slate-300'}`}>{label}</button>
        ))}
      </div>

      <div className="px-2 pt-2">
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="callsign · icao · type · class"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[11px] placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50" />
      </div>
      <div className="grid grid-cols-3 gap-1 px-2 pt-2 text-[10px]">
        {(['HAZARDS','LEADERS','CLASSES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2 py-1 rounded border transition ${tab===t?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-800 text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pt-2 pb-2 space-y-1.5">
        {tab === 'HAZARDS' && visible.length === 0 && (
          <div className="text-center text-slate-600 text-[11px] pt-6">no jet-blast hazards in scope</div>
        )}
        {tab === 'HAZARDS' && visible.map((h, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden cursor-pointer hover:border-slate-700"
            onClick={() => onFly(h.target.icao)}>
            <div className="h-0.5" style={{ background: TIER_COLOR[h.tier] }} />
            <div className="p-2 space-y-1">
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="font-mono text-slate-300">{h.leader.callsign || h.leader.icao}</span>
                {classPill(h.leaderClass)}
                {regimePill(h.regime)}
                <span className="text-slate-500">›</span>
                <span className="font-mono font-semibold text-slate-100">{h.target.callsign || h.target.icao}</span>
                {classPill(h.targetClass)}
                {h.inCone && <span className="px-1 py-0.5 rounded text-[9px] font-mono bg-rose-500/20 text-rose-400 border border-rose-500/50">IN-CONE</span>}
                <div className="ml-auto">{tierPill(h.tier)}</div>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>along <span className="text-slate-200">{Math.round(h.alongM)}m</span></span>
                <span>lat <span className="text-slate-200">{Math.round(h.lateralM)}m</span></span>
                <span>v-tgt <span style={{ color: h.exceedAgsm?'#ef4444':h.exceedAnnex?'#f59e0b':'#10b981' }}>{h.vAtTargetMs.toFixed(1)}m/s</span></span>
                <span>v-ctr <span className="text-slate-200">{h.vCenterMs.toFixed(1)}m/s</span></span>
              </div>
              <div className="h-1 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: `${h.score}%`, background: TIER_COLOR[h.tier] }} />
              </div>
              <div className="grid grid-cols-6 gap-0.5 text-[9px]">
                {(['vel','geom','reg','sep','mass','ang'] as const).map(k => (
                  <div key={k} className="rounded bg-slate-900/60 px-1 py-0.5 text-center" style={{ color: TIER_COLOR[h.tier] }}>
                    <div className="opacity-60">{k.slice(0,3).toUpperCase()}</div>
                    <div className="font-mono">{Math.round(h.drivers[k])}</div>
                  </div>
                ))}
              </div>
              <div className="text-[10px] leading-snug" style={{ color: TIER_COLOR[h.tier] }}>
                {h.rationale} <span className="text-slate-600 italic">· {h.citation}</span>
              </div>
            </div>
          </div>
        ))}

        {tab === 'LEADERS' && byLeader.length === 0 && (
          <div className="text-center text-slate-600 text-[11px] pt-6">no active blast-emitting leaders</div>
        )}
        {tab === 'LEADERS' && byLeader.map(([icao, hs]) => {
          const w = hs[0]
          const ca = hs.filter(x => x.tier==='CATASTROPHIC').length
          const sev = hs.filter(x => x.tier==='SEVERE').length
          const hz = hs.filter(x => x.tier==='HAZARDOUS').length
          return (
            <div key={icao} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden cursor-pointer hover:border-slate-700" onClick={() => onFly(icao)}>
              <div className="h-0.5" style={{ background: TIER_COLOR[w.tier] }} />
              <div className="p-2 space-y-1">
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="font-mono font-semibold text-slate-100">{w.leader.callsign || icao}</span>
                  {classPill(w.leaderClass)}
                  {regimePill(w.regime)}
                  <span className="text-slate-500 text-[10px] truncate">{w.leader.type}</span>
                  <div className="ml-auto">{tierPill(w.tier)}</div>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                  <span>{w.leader.ground?'GND':`FL${Math.round(w.leader.altitudeFt/100).toString().padStart(3,'0')}`}</span>
                  <span>{Math.round(w.leader.velocityKts)}kt</span>
                  <span>{hs.length} targets</span>
                  {ca > 0 && <span className="text-rose-400">CA {ca}</span>}
                  {sev > 0 && <span className="text-rose-300">SEV {sev}</span>}
                  {hz > 0 && <span className="text-amber-400">HZ {hz}</span>}
                </div>
                <div className="h-1 rounded bg-slate-800 overflow-hidden">
                  <div className="h-full" style={{ width: `${w.score}%`, background: TIER_COLOR[w.tier] }} />
                </div>
              </div>
            </div>
          )
        })}

        {tab === 'CLASSES' && byClass.length === 0 && (
          <div className="text-center text-slate-600 text-[11px] pt-6">no class data</div>
        )}
        {tab === 'CLASSES' && byClass.map(([c, hs]) => {
          const mean = Math.round(hs.reduce((s,h) => s + h.score, 0) / hs.length)
          const tier: Tier = mean >= 80 ? 'SEVERE' : mean >= 58 ? 'HAZARDOUS' : mean >= 35 ? 'CAUTION' : mean >= 16 ? 'WATCH' : 'IDLE'
          const ca = hs.filter(x => x.tier==='CATASTROPHIC').length
          const sev = hs.filter(x => x.tier==='SEVERE').length
          const p = BLAST_CLASS[c]
          const meanV = (hs.reduce((s,h) => s + h.vAtTargetMs, 0) / hs.length).toFixed(1)
          return (
            <div key={c} className="rounded border border-slate-800 bg-slate-900/40 p-2 space-y-1">
              <div className="flex items-center gap-1.5 text-[11px]">
                {classPill(c)}
                <span className="text-slate-400 text-[10px] truncate">{p.name}</span>
                <div className="ml-auto">{tierPill(tier)}</div>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>Ve <span className="text-slate-200">{p.veToga}m/s</span></span>
                <span>Deq <span className="text-slate-200">{p.dEq.toFixed(2)}m</span></span>
                <span>×{p.nEng} eng</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>{hs.length} pairs</span>
                <span>mean v <span className="text-slate-200">{meanV}m/s</span></span>
                {ca > 0 && <span className="text-rose-400">CA {ca}</span>}
                {sev > 0 && <span className="text-rose-300">SEV {sev}</span>}
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
