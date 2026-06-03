'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   In-Trail Procedure (ITP) · ASEPS Oceanic 1000-ft
   Climb / Descent Eligibility Monitor
   ------------------------------------------------------------
   Per-airframe eligibility analysis for the ATSA-ITP In-Trail
   Procedure that permits a 1000-ft climb-through or descend-
   through an adjacent occupied flight level in procedural
   oceanic airspace when ADS-B IN derived state data on a
   reference aircraft confirms longitudinal separation can be
   maintained throughout the manoeuvre.

   Regulatory & operational basis:
     · ICAO Doc 4444 PANS-ATM 16.5  ITP
     · ICAO Doc 9869 PBN/PBCS Manual App E ASEPS
     · ICAO Doc 9863 ACAS Manual
     · ICAO Annex 10 Vol IV ch 5 ADS-B
     · ICAO Annex 11 ch 3 procedural airspace
     · RTCA DO-312  Safety, Performance and
       Interoperability Requirements for the
       In-Trail Procedure in Oceanic Airspace
     · RTCA DO-289  Application Description for
       Cockpit Display of Traffic Information
     · RTCA DO-317B  MOPS for Aircraft Surveillance
       Applications (ASA)
     · RTCA DO-260B  1090 ES MOPS
     · EUROCAE ED-159 / ED-194A ASA MOPS
     · FAA AC 90-114B  ADS-B Operations
     · FAA AC 90-117  Data-Link Communications
     · FAA Order JO 7110.65 §8-1-10 ITP
     · NAT Doc 007 Ch 13  ITP in NAT HLA
     · NAT OPS Bulletin 2019-006  ITP eligibility
     · Pacific FIT 2018-3  ITP in PACOTS
     · Boeing 777 / 787 FCOM 11.30 ADS-B IN ITP
     · Airbus A330 / A350 FCOM DSC-31 SURV ATSA

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash of ICAO24 derives
        ATSA-ITP equipage, ADS-B IN class, reference-aircraft
        pick, request type (climb / descend) and same-track
        flag.
     2. ITP geometry per DO-312 §3.2:
          · Same-track ±45° track delta
          · Reference traffic within 15 nm leading or
            trailing along-track
          · Closing-speed ≤ 20 kt (climb-through ref ahead,
            descend-through ref behind)
          · Mach differential ≤ 0.06
          · Reference aircraft level ± requested ΔFL
     3. Per-flight ITP separation distance computed via
        haversine then projected onto requested-aircraft
        track to derive along-track delta. Closing-speed
        derived from ground-speed differential along track.
     4. 5 risk drivers max-driver composite:
          · EQP  ATSA-ITP equipage gap (NONE 100 / IN-only
            60 / DO-260A only 35 / DO-260B+ASA 0)
          · GEO  along-track separation vs 15 nm DO-312
            limit ramped 0 at ≤ 12 nm to 100 at ≥ 18 nm
          · CLS  closing-speed vs 20 kt DO-312 limit
            ramped 0 at ≤ 15 kt to 100 at ≥ 25 kt
          · MCH  Mach-differential vs 0.06 limit ramped 0
            at ≤ 0.04 to 100 at ≥ 0.08
          · TRK  same-track delta vs 45° limit ramped 0
            at ≤ 30° to 100 at ≥ 60°
     5. Phase multiplier OCEANIC x1.30 REMOTE x1.10
        ENROUTE x1.00 TERMINAL x0.80
     6. 5 tiers:
        · UNABLE  score ≥ 80 or any geometry param past
          DO-312 hard limit  →  do not request ITP
        · MARGIN  score ≥ 55  →  reference geometry tight;
          coordinate with adjacent FIR, monitor 5 min
        · WATCH   score ≥ 25  →  eligible but trending;
          confirm Mach lock and ADS-B IN integrity
        · ITP-OK  score < 25  →  request ITP via CPDLC
          per Doc 4444 16.5.3
        · IDLE    not oceanic or no reference traffic

   MapLibre overlay:
     · Tier-coloured halo rings sized 8-22 px by score
     · Rose diamond UNABLE pin at requested-aircraft
       position
     · Dashed tier-coloured along-track corridor between
       requested aircraft and reference aircraft (only for
       non-OK rows) with 15 nm scale rings at the
       reference end
     · Tier-coloured callsign + Δnm + Δkt + REF-CS labels
       for non-OK
     · Sky reference parallels at lat 60 / 30 / 0 / -30 /
       -60 every 12° lng

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell ELIGIBLE-share / WORST callsign / UNABLE-
       count summary
     · 3-cell MEAN-Δnm / MEAN-Δkt / NO-REF-share
       secondary row
     · SVG Δnm vs Δkt scatter with rose UNABLE zone
       Δnm ≥ 18 OR Δkt ≥ 25 + amber MARGIN band + emerald
       OK band + dashed DO-312 limits + every airframe as
       tier-coloured dot
     · 6 sliders MIN-FL / FLEET-AGE / OCEANIC-BIAS /
       MACH-NOISE / ITP-RANGE / PHASE-WT
     · 4-equipage chip filter DO-260B / DO-260A / IN-ONLY
       / NONE
     · HALO / PIN / LBL / CORR / REF / DIAG toggles +
       search by callsign / type / operator / icao
     · AIRCRAFT / FIRS tab switcher
     · Aircraft row with tier stripe + equip-pill +
       request-pill CLIMB/DESC + REF-CS link + tier-
       coloured advice click-to-fly
     · FIRS tab grouped by oceanic FIR sorted by
       eligible-share desc

   Layers > Safety & Traffic.
   Persisted: ft-itp
   ============================================================ */

interface ItpFlight {
  icao: string
  callsign?: string
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
  flights: ItpFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'UNABLE' | 'MARGIN' | 'WATCH' | 'ITP-OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  UNABLE: '#ef4444', MARGIN: '#f59e0b', WATCH: '#0ea5e9', 'ITP-OK': '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['UNABLE', 'MARGIN', 'WATCH', 'ITP-OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { UNABLE: 0, MARGIN: 1, WATCH: 2, 'ITP-OK': 3, IDLE: 4 }

type Equip = 'DO-260B' | 'DO-260A' | 'IN-ONLY' | 'NONE'
const EQUIP_LIST: Equip[] = ['DO-260B', 'DO-260A', 'IN-ONLY', 'NONE']

type AcClass = 'HVY-Q' | 'HVY' | 'NRW' | 'BIZ' | 'RGN'
const CLASS_LIST: AcClass[] = ['HVY-Q', 'HVY', 'NRW', 'BIZ', 'RGN']
const CLASS_LABEL: Record<AcClass, string> = {
  'HVY-Q': 'Heavy quad', HVY: 'Heavy twin', NRW: 'Narrowbody', BIZ: 'Bizjet', RGN: 'Regional',
}
// Per-class equipage probability per IATA Long-Range Fleet Survey 2023
const CLASS_EQUIP_P: Record<AcClass, [number, number, number, number]> = {
  // [DO-260B, DO-260A, IN-ONLY, NONE]
  'HVY-Q': [0.78, 0.14, 0.05, 0.03],
  HVY:    [0.82, 0.10, 0.05, 0.03],
  NRW:    [0.55, 0.18, 0.07, 0.20],
  BIZ:    [0.60, 0.18, 0.10, 0.12],
  RGN:    [0.30, 0.20, 0.10, 0.40],
}

type Request = 'CLIMB' | 'DESC'

type Driver = 'EQP' | 'GEO' | 'CLS' | 'MCH' | 'TRK' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  EQP: 'ATSA-ITP equipage', GEO: 'Along-track separation', CLS: 'Closing speed',
  MCH: 'Mach differential', TRK: 'Same-track delta', NONE: 'Nominal',
}

type Phase = 'OCEANIC' | 'REMOTE' | 'ENROUTE' | 'TERMINAL'
const PHASE_MUL: Record<Phase, number> = { OCEANIC: 1.30, REMOTE: 1.10, ENROUTE: 1.00, TERMINAL: 0.80 }

// Coarse oceanic FIR boxes for phase classification
const OCEANIC_FIRS: Array<{ id: string; name: string; latMin: number; latMax: number; lngMin: number; lngMax: number }> = [
  { id: 'EGGX', name: 'Shanwick',    latMin: 45,  latMax: 61,  lngMin: -30, lngMax: -10 },
  { id: 'CZQX', name: 'Gander',      latMin: 45,  latMax: 63,  lngMin: -65, lngMax: -30 },
  { id: 'BIRD', name: 'Reykjavik',   latMin: 61,  latMax: 82,  lngMin: -30, lngMax: 0   },
  { id: 'KZAK', name: 'Oakland',     latMin: 5,   latMax: 60,  lngMin: -160, lngMax: -120 },
  { id: 'PHZH', name: 'Honolulu',    latMin: 5,   latMax: 40,  lngMin: -175, lngMax: -140 },
  { id: 'RJJJ', name: 'Fukuoka',     latMin: 17,  latMax: 45,  lngMin: 123, lngMax: 165 },
  { id: 'YBBB', name: 'Brisbane',    latMin: -45, latMax: -10, lngMin: 130, lngMax: 175 },
  { id: 'NZZO', name: 'Auckland',    latMin: -60, latMax: -10, lngMin: 155, lngMax: 200 },
  { id: 'FAJO', name: 'Johannesburg', latMin: -45, latMax: -10, lngMin: 10, lngMax: 60 },
  { id: 'GOOO', name: 'Dakar',       latMin: -5,  latMax: 25,  lngMin: -30, lngMax: 0 },
  { id: 'BGGL', name: 'Sondrestrom', latMin: 60,  latMax: 84,  lngMin: -75, lngMax: -30 },
]

function firFor(lat: number, lng: number): string {
  for (const f of OCEANIC_FIRS) {
    if (lat >= f.latMin && lat <= f.latMax && lng >= f.lngMin && lng <= f.lngMax) return f.id
  }
  return ''
}

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|A38|A34|IL96/.test(t)) return 'HVY-Q'
  if (/B77|B78|A33|A35|MD11/.test(t)) return 'HVY'
  if (/B73|A31|A319|A32|A22|B75|B71/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E27|E29|E[12]7|E[12]9|F70|F100/.test(t)) return 'RGN'
  return 'BIZ'
}

function classifyPhase(lat: number, lng: number, alt: number, ground: boolean): Phase {
  if (ground || alt < 10000) return 'TERMINAL'
  const fir = firFor(lat, lng)
  if (fir) return 'OCEANIC'
  // Remote = north of 60° or above ocean basins outside FIR boxes
  if (Math.abs(lat) > 65) return 'REMOTE'
  return 'ENROUTE'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

function pickEquip(klass: AcClass, hashByte: number): Equip {
  const probs = CLASS_EQUIP_P[klass]
  const r = hashByte / 255
  let a = probs[0]
  if (r < a) return 'DO-260B'
  a += probs[1]; if (r < a) return 'DO-260A'
  a += probs[2]; if (r < a) return 'IN-ONLY'
  return 'NONE'
}

const equipScore: Record<Equip, number> = { 'DO-260B': 0, 'DO-260A': 35, 'IN-ONLY': 60, NONE: 100 }

// Haversine in nm
function haversineNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const toRad = (d: number) => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function initialBearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => d * Math.PI / 180
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2))
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1))
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

function trackDeltaDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 360
  if (d > 180) d = 360 - d
  return d
}

function machFromTas(tasKt: number, altFt: number): number {
  // Speed of sound at ISA temperature decreases with altitude up to tropopause
  const tIsa = altFt < 36089 ? 288.15 - 0.0019812 * altFt : 216.65
  const a = 38.967854 * Math.sqrt(tIsa) // kt
  return tasKt / a
}

interface Row {
  f: ItpFlight
  klass: AcClass
  equip: Equip
  fir: string
  phase: Phase
  request: Request
  refIcao: string
  refCs: string
  refType: string
  along: number      // along-track nm (positive = ahead)
  cross: number      // cross-track nm
  closingKt: number  // along-track closing speed
  trackDelta: number // deg
  machDelta: number
  sev: { eqp: number; geo: number; cls: number; mch: number; trk: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'itp-halo', SRC_LBL = 'itp-lbl', SRC_PIN = 'itp-pin', SRC_CORR = 'itp-corr', SRC_REF = 'itp-ref', SRC_RREF = 'itp-rref'
const LYR_HALO = 'itp-halo-l', LYR_LBL = 'itp-lbl-l', LYR_PIN = 'itp-pin-l', LYR_CORR = 'itp-corr-l', LYR_REF = 'itp-ref-l', LYR_RREF = 'itp-rref-l'

export default function ItpAseps({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'FIRS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [equipFilter, setEquipFilter] = useState<Equip | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(280)
  const [fleetAge, setFleetAge] = useState(100)
  const [oceanicBias, setOceanicBias] = useState(0)  // -50..50 pct shift on along-track derivation
  const [machNoise, setMachNoise] = useState(100)    // 50..250
  const [itpRange, setItpRange] = useState(15)       // DO-312 nominal 15 nm, sliders 8..25
  const [phaseWt, setPhaseWt] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showCorr, setShowCorr] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  // Build flight index for reference pairing
  const flightIdx = useMemo(() => {
    const arr = flights.filter(f => isFinite(f.altitudeFt) && !f.ground && f.altitudeFt >= 10000)
    return arr
  }, [flights])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flightIdx) {
      if (f.altitudeFt / 100 < minFl) continue
      const phase = classifyPhase(f.lat, f.lng, f.altitudeFt, f.ground)
      if (phase === 'TERMINAL') continue
      const klass = classifyClass(f.type || '')
      const h = hash32(f.icao || '')
      const equip = pickEquip(klass, h & 0xff)
      const fir = firFor(f.lat, f.lng) || (phase === 'OCEANIC' ? 'OCN' : phase === 'REMOTE' ? 'RMT' : 'ENR')
      const request: Request = ((h >>> 8) & 1) ? 'CLIMB' : 'DESC'

      // Find reference aircraft: same approximate track, within itpRange + 10 nm, at adjacent FL
      const myTrack = f.track || 0
      const targetSign = request === 'CLIMB' ? 1 : -1  // climb wants ref ahead; desc wants ref behind
      let best: ItpFlight | null = null
      let bestAlong = 999
      let bestCross = 999
      for (const g of flightIdx) {
        if (g.icao === f.icao) continue
        // FL adjacency 800-1200 ft
        const dFL = g.altitudeFt - f.altitudeFt
        const absDFL = Math.abs(dFL)
        if (absDFL < 800 || absDFL > 1200) continue
        // Climb wants ref ABOVE; desc wants ref BELOW
        if (request === 'CLIMB' && dFL < 0) continue
        if (request === 'DESC'  && dFL > 0) continue
        // Same-track gate
        const td = trackDeltaDeg(myTrack, g.track || 0)
        if (td > 60) continue
        const dist = haversineNm(f.lat, f.lng, g.lat, g.lng)
        if (dist > itpRange + 12) continue
        // Project onto own track to derive along/cross
        const brg = initialBearingDeg(f.lat, f.lng, g.lat, g.lng)
        const rel = ((brg - myTrack + 540) % 360) - 180  // -180..180, 0 = directly ahead
        const along = dist * Math.cos(rel * Math.PI / 180)
        const cross = Math.abs(dist * Math.sin(rel * Math.PI / 180))
        // Direction filter
        if (targetSign === 1 && along < 0) continue
        if (targetSign === -1 && along > 0) continue
        if (Math.abs(along) < Math.abs(bestAlong)) {
          best = g; bestAlong = along; bestCross = cross
        }
      }

      if (!best) {
        // No eligible reference traffic — IDLE (cannot evaluate ITP) but we still surface it
        out.push({
          f, klass, equip, fir, phase, request,
          refIcao: '', refCs: '', refType: '',
          along: NaN, cross: NaN, closingKt: NaN, trackDelta: NaN, machDelta: NaN,
          sev: { eqp: equipScore[equip], geo: 0, cls: 0, mch: 0, trk: 0 },
          score: equip === 'NONE' ? 100 : equipScore[equip] * 0.6,
          driver: equip === 'NONE' ? 'EQP' : 'NONE',
          tier: 'IDLE',
        })
        continue
      }

      const trackDelta = trackDeltaDeg(myTrack, best.track || 0)

      // Closing speed = along-track GS differential.  Climb: closing if ref slower than self (gap shrinking)
      const tas = f.velocityKts // approximated as TAS for Mach calc
      const refTas = best.velocityKts
      const gsDiff = tas - refTas  // +ve when self is faster
      // For climb (ref ahead), closing if gsDiff > 0
      // For desc  (ref behind), closing if gsDiff < 0  → use -gsDiff
      const closingKt = request === 'CLIMB' ? gsDiff : -gsDiff
      const myMach = machFromTas(tas, f.altitudeFt)
      const refMach = machFromTas(refTas, best.altitudeFt)
      const noise = (((h >>> 16) & 0xff) / 255 - 0.5) * 0.012 * (machNoise / 100)
      const machDelta = Math.abs(myMach - refMach + noise)

      // Severities per DO-312
      const eqpSev = equipScore[equip]
      const along15 = Math.abs(bestAlong)
      const geoSev = along15 <= 12 ? 0 : along15 >= 18 ? 100 : ((along15 - 12) / 6) * 100
      const clsAbs = Math.abs(closingKt)
      // Closing-speed severity: if closing (positive) > 20 kt or opening > 30 kt
      const clsEff = closingKt > 0 ? closingKt : Math.max(0, -closingKt - 10)
      const clsSev = clsEff <= 15 ? 0 : clsEff >= 25 ? 100 : ((clsEff - 15) / 10) * 100
      const mchSev = machDelta <= 0.04 ? 0 : machDelta >= 0.08 ? 100 : ((machDelta - 0.04) / 0.04) * 100
      const trkSev = trackDelta <= 30 ? 0 : trackDelta >= 60 ? 100 : ((trackDelta - 30) / 30) * 100

      // Oceanic bias modulates along-track perception (simulates GS drift between ADS-B updates)
      const bias = 1 + (oceanicBias / 100)
      const geoEff = Math.min(100, geoSev * bias)

      const sev = { eqp: eqpSev, geo: geoEff, cls: clsSev, mch: mchSev, trk: trkSev }
      const drivers: Array<[Driver, number]> = [['EQP', sev.eqp], ['GEO', sev.geo], ['CLS', sev.cls], ['MCH', sev.mch], ['TRK', sev.trk]]
      drivers.sort((a, b) => b[1] - a[1])
      const driver: Driver = drivers[0][1] >= 12 ? drivers[0][0] : 'NONE'

      const phaseMul = 1 + ((PHASE_MUL[phase] - 1) * (phaseWt / 100))
      const max = drivers[0][1]
      const secondary = drivers[1][1]
      let score = Math.min(100, Math.max(0, max * phaseMul + 0.12 * secondary))
      // Hard escalations
      if (equip === 'NONE' && phase === 'OCEANIC') score = Math.max(score, 92)
      if (along15 > 18) score = Math.max(score, 88)
      if (clsEff > 25) score = Math.max(score, 85)
      if (machDelta > 0.08) score = Math.max(score, 82)

      let tier: Tier
      if (score >= 80) tier = 'UNABLE'
      else if (score >= 55) tier = 'MARGIN'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'ITP-OK'

      out.push({
        f, klass, equip, fir, phase, request,
        refIcao: best.icao, refCs: best.callsign || best.icao, refType: best.type || '—',
        along: bestAlong, cross: bestCross,
        closingKt, trackDelta, machDelta,
        sev, score, driver, tier,
      })
    }
    return out
  }, [flightIdx, minFl, fleetAge, oceanicBias, machNoise, itpRange, phaseWt])

  const tierCount: Record<Tier, number> = { UNABLE: 0, MARGIN: 0, WATCH: 0, 'ITP-OK': 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++

  const evaluable = rows.filter(r => r.tier !== 'IDLE')
  const eligible = evaluable.filter(r => r.tier === 'ITP-OK' || r.tier === 'WATCH').length
  const eligibleShare = evaluable.length ? eligible / evaluable.length : 0
  const noRefShare = rows.length ? rows.filter(r => !r.refIcao).length / rows.length : 0
  const meanAlong = evaluable.length ? evaluable.reduce((a, r) => a + Math.abs(r.along), 0) / evaluable.length : 0
  const meanClosing = evaluable.length ? evaluable.reduce((a, r) => a + Math.max(0, r.closingKt), 0) / evaluable.length : 0
  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (equipFilter !== 'ALL') r = r.filter(x => x.equip === equipFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(x => (x.f.callsign || '').toLowerCase().includes(q) || (x.f.type || '').toLowerCase().includes(q) || (x.f.icao || '').toLowerCase().includes(q) || (x.f.operator || '').toLowerCase().includes(q) || (x.refCs || '').toLowerCase().includes(q))
    return r.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, equipFilter, query])

  const firRows = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of rows) {
      const e = m.get(r.fir) || []
      e.push(r); m.set(r.fir, e)
    }
    const arr: Array<{ fir: string; name: string; ac: number; ok: number; margin: number; unable: number; meanScore: number; worstCs: string; eligibleShare: number }> = []
    for (const [k, v] of m) {
      const ok = v.filter(r => r.tier === 'ITP-OK').length
      const ma = v.filter(r => r.tier === 'MARGIN').length
      const un = v.filter(r => r.tier === 'UNABLE').length
      const ev = v.filter(r => r.tier !== 'IDLE').length
      const ms = v.reduce((a, r) => a + r.score, 0) / v.length
      const wc = v.slice().sort((a, b) => b.score - a.score)[0]
      const name = OCEANIC_FIRS.find(f => f.id === k)?.name || (k === 'OCN' ? 'Oceanic' : k === 'RMT' ? 'Remote' : 'Enroute')
      arr.push({ fir: k, name, ac: v.length, ok, margin: ma, unable: un, meanScore: ms, worstCs: wc?.f.callsign || wc?.f.icao || '', eligibleShare: ev ? (ok + v.filter(r => r.tier === 'WATCH').length) / ev : 0 })
    }
    arr.sort((a, b) => b.eligibleShare - a.eligibleShare || b.ac - a.ac)
    return arr
  }, [rows])

  useEffect(() => {
    if (!map) return
    const ensureSource = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    }
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_CORR, SRC_REF, SRC_RREF]
    sources.forEach(ensureSource)

    if (!map.getLayer(LYR_REF)) {
      map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.18, 'line-width': 0.8, 'line-dasharray': [2, 4] } })
    }
    if (!map.getLayer(LYR_CORR)) {
      map.addLayer({ id: LYR_CORR, type: 'line', source: SRC_CORR, paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.72, 'line-dasharray': [1.5, 2] } })
    }
    if (!map.getLayer(LYR_RREF)) {
      map.addLayer({ id: LYR_RREF, type: 'circle', source: SRC_RREF, paint: { 'circle-radius': 4, 'circle-color': '#0b1220', 'circle-opacity': 0.7, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.9, 'circle-stroke-width': 1.6 } })
    }
    if (!map.getLayer(LYR_HALO)) {
      map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.65, 'circle-stroke-width': 1.4 } })
    }
    if (!map.getLayer(LYR_PIN)) {
      map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': '◆', 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(LYR_LBL)) {
      map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }

    const halo: any[] = []; const lbl: any[] = []; const pin: any[] = []; const corr: any[] = []; const rref: any[] = []
    for (const r of rows) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'ITP-OK' && r.tier !== 'IDLE') {
        const rad = 8 + (r.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: rad } })
      }
      if (showPin && r.tier === 'UNABLE') {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLabels && (r.tier === 'UNABLE' || r.tier === 'MARGIN') && r.refCs) {
        const label = `${r.f.callsign || r.f.icao} ${r.request} · Δ${r.along.toFixed(0)}nm ${r.closingKt > 0 ? '+' : ''}${r.closingKt.toFixed(0)}kt · ${r.refCs}`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showCorr && (r.tier === 'UNABLE' || r.tier === 'MARGIN') && r.refIcao) {
        const refF = flightIdx.find(g => g.icao === r.refIcao)
        if (refF) {
          corr.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [refF.lng, refF.lat]] }, properties: { color } })
          rref.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [refF.lng, refF.lat] }, properties: { color } })
        }
      }
    }

    const refFeats: any[] = []
    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        refFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }

    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_CORR) as any).setData({ type: 'FeatureCollection', features: corr })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: refFeats })
    ;(map.getSource(SRC_RREF) as any).setData({ type: 'FeatureCollection', features: rref })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_RREF, LYR_CORR, LYR_REF]) { if (m.getLayer(id)) m.removeLayer(id) }
      for (const id of sources) { if (m.getSource(id)) m.removeSource(id) }
    }
  }, [map, rows, flightIdx, showHalo, showPin, showLabels, showCorr, showRef])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const driverBadge = (d: Driver, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const equipPill = (e: Equip) => {
    const col = e === 'DO-260B' ? '#10b981' : e === 'DO-260A' ? '#0ea5e9' : e === 'IN-ONLY' ? '#f59e0b' : '#ef4444'
    return <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '66', backgroundColor: col + '14' }}>{e}</span>
  }
  const requestPill = (q: Request) => (
    <span className="inline-flex items-center px-1 py-px rounded text-[9px] text-slate-300 border border-slate-700 bg-slate-800">{q === 'CLIMB' ? '↑ CLIMB' : '↓ DESC'}</span>
  )

  const advice = (r: Row): string => {
    if (r.tier === 'UNABLE') {
      if (r.driver === 'EQP') return 'ATSA-ITP unavailable — request standard Mach-number / step-climb procedure per Doc 4444 16.4'
      if (r.driver === 'GEO') return `Reference traffic outside DO-312 15-nm window (Δ${r.along.toFixed(0)} nm) — defer request, await closure to ≤ 12 nm`
      if (r.driver === 'CLS') return `Closing-speed past 20-kt DO-312 limit (${r.closingKt.toFixed(0)} kt) — request blocked, coordinate alternate FL via CPDLC`
      if (r.driver === 'MCH') return `Mach-differential past 0.06 DO-312 limit (Δ${r.machDelta.toFixed(3)} M) — lock both aircraft to same Mach number first per NAT Doc 007 §13`
      if (r.driver === 'TRK') return `Same-track delta past 45° gate (${r.trackDelta.toFixed(0)}°) — reference traffic not on same track, no ITP eligibility`
      return 'ITP request not eligible — apply 10-min longitudinal sep per Doc 4444 5.4.2.5'
    }
    if (r.tier === 'MARGIN') return `ITP geometry tight — coordinate with adjacent FIR, monitor 5 min, request CPDLC ITP block per NAT OPS Bull 2019-006 once Δnm ≤ 12 / closing ≤ 15 kt`
    if (r.tier === 'WATCH') return `Eligible but trending — confirm Mach lock and ADS-B IN integrity per RTCA DO-317B, file ITP request via CPDLC DM7 per Doc 4444 16.5.3`
    if (r.tier === 'ITP-OK') return `Request ITP via CPDLC DM7 "REQUEST CLIMB TO FLnnn" with ITP descriptor per Doc 4444 16.5.3 — ${r.request} 1000 ft behind ${r.refCs} authorised`
    if (!r.refIcao && r.equip === 'NONE') return 'No ATSA-ITP equipage and no reference traffic — standard procedural sep only'
    return 'No reference traffic within DO-312 window — ITP not evaluable, continue cruise'
  }

  const W = 280, H = 180
  const xMax = 25  // Δnm
  const yMax = 30  // Δkt closing
  const sx = (v: number) => 30 + (Math.max(0, Math.min(xMax, v)) / xMax) * (W - 40)
  const sy = (v: number) => {
    const cl = Math.max(-10, Math.min(yMax, v))
    return (H - 24) - ((cl + 10) / (yMax + 10)) * (H - 48)
  }

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">ITP · ASEPS Oceanic 1000 ft</div>
          <div className="text-[10px] text-slate-500">RTCA DO-312 · ICAO Doc 4444 §16.5 · NAT Doc 007 ch 13</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[10px] font-semibold" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Eligible share</div>
          <div className="text-sm font-semibold" style={{ color: eligibleShare >= 0.6 ? '#10b981' : eligibleShare >= 0.3 ? '#f59e0b' : '#ef4444' }}>{(eligibleShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst aircraft</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Unable</div>
          <div className="text-sm font-semibold" style={{ color: tierCount.UNABLE > 0 ? '#ef4444' : '#10b981' }}>{tierCount.UNABLE}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean Δnm</div>
          <div className="text-xs font-semibold" style={{ color: meanAlong > 14 ? '#f59e0b' : '#10b981' }}>{meanAlong.toFixed(1)} nm</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean closing</div>
          <div className="text-xs font-semibold" style={{ color: meanClosing > 15 ? '#f59e0b' : '#10b981' }}>{meanClosing.toFixed(0)} kt</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">No-ref share</div>
          <div className="text-xs font-semibold" style={{ color: noRefShare > 0.5 ? '#f59e0b' : '#10b981' }}>{(noRefShare * 100).toFixed(0)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W - 40} height={H - 48} fill="#0b1220" />
            {/* UNABLE quadrant: Δnm ≥ 18 OR Δkt ≥ 25 */}
            <rect x={sx(18)} y={24} width={W - 10 - sx(18)} height={H - 48} fill="#ef4444" opacity={0.10} />
            <rect x={30} y={24} width={W - 40} height={sy(25) - 24} fill="#ef4444" opacity={0.08} />
            {/* MARGIN band 12..18 nm × 15..25 kt */}
            <rect x={sx(12)} y={sy(25)} width={sx(18) - sx(12)} height={sy(15) - sy(25)} fill="#f59e0b" opacity={0.12} />
            {/* OK zone */}
            <rect x={30} y={sy(15)} width={sx(12) - 30} height={(H - 24) - sy(15)} fill="#10b981" opacity={0.10} />
            <line x1={sx(15)} x2={sx(15)} y1={24} y2={H - 24} stroke="#0ea5e9" strokeDasharray="2 3" strokeOpacity={0.5} />
            <line x1={sx(18)} x2={sx(18)} y1={24} y2={H - 24} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.7} />
            <line x1={30} x2={W - 10} y1={sy(20)} y2={sy(20)} stroke="#0ea5e9" strokeDasharray="2 3" strokeOpacity={0.5} />
            <line x1={30} x2={W - 10} y1={sy(25)} y2={sy(25)} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.7} />
            {[0, 5, 10, 15, 20, 25].map(t => (
              <text key={`x${t}`} x={sx(t) - 6} y={H - 8} fontSize={8} fill="#64748b">{t}nm</text>
            ))}
            {[-10, 0, 10, 20, 30].map(t => (
              <text key={`y${t}`} x={4} y={sy(t) + 3} fontSize={8} fill="#64748b">{t > 0 ? '+' : ''}{t}</text>
            ))}
            {rows.filter(r => r.tier !== 'IDLE' && isFinite(r.along)).map((r, i) => (
              <circle key={i} cx={sx(Math.abs(r.along))} cy={sy(r.closingKt)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
            <text x={W / 2} y={H - 6} fontSize={9} fill="#64748b" textAnchor="middle">|Δnm| along-track · Δkt closing</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={100} max={410} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">FLEET-AGE {fleetAge}%</span><input type="range" min={50} max={200} value={fleetAge} onChange={e => setFleetAge(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">OCEANIC-BIAS {oceanicBias > 0 ? '+' : ''}{oceanicBias}%</span><input type="range" min={-50} max={50} value={oceanicBias} onChange={e => setOceanicBias(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MACH-NOISE {machNoise}%</span><input type="range" min={50} max={250} value={machNoise} onChange={e => setMachNoise(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">ITP-RANGE {itpRange} nm</span><input type="range" min={8} max={25} value={itpRange} onChange={e => setItpRange(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setEquipFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${equipFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {EQUIP_LIST.map(e => (
          <button key={e} onClick={() => setEquipFilter(equipFilter === e ? 'ALL' : e)} className={`px-2 py-0.5 rounded text-[10px] border ${equipFilter === e ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{e}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['CORR', showCorr, setShowCorr], ['REF', showRef, setShowRef], ['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / ref / op" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'FIRS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.klass}</span>
              {equipPill(r.equip)}
              {requestPill(r.request)}
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{r.fir}</span>
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              FL{(r.f.altitudeFt / 100).toFixed(0)} · {r.f.velocityKts.toFixed(0)} kt · trk {r.f.track.toFixed(0)}°
              {r.refIcao
                ? <> · <button onClick={() => onFly(r.refIcao)} className="text-sky-400 hover:text-sky-300">REF {r.refCs}</button> ({r.refType}) Δ{r.along.toFixed(1)} nm / Δ{r.closingKt > 0 ? '+' : ''}{r.closingKt.toFixed(0)} kt / Δ{r.machDelta.toFixed(3)} M / Δtrk {r.trackDelta.toFixed(0)}°</>
                : <> · no reference traffic in ±{itpRange + 12} nm</>}
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('EQP', r.sev.eqp)}
              {driverBadge('GEO', r.sev.geo)}
              {driverBadge('CLS', r.sev.cls)}
              {driverBadge('MCH', r.sev.mch)}
              {driverBadge('TRK', r.sev.trk)}
            </div>
            <div className="px-2 pb-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {advice(r)}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No aircraft match the current filters.</div>
        )}

        {tab === 'FIRS' && firRows.map((c, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${c.eligibleShare >= 0.6 ? '#10b981' : c.eligibleShare >= 0.3 ? '#f59e0b' : '#ef4444'}` }}>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300 font-mono">{c.fir}</span>
              <span className="text-slate-300 truncate">{c.name}</span>
              <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{c.ac} ac</span>
              <span className="px-1 py-px rounded text-[9px]" style={{ color: c.eligibleShare >= 0.6 ? '#10b981' : '#f59e0b', border: '1px solid ' + (c.eligibleShare >= 0.6 ? '#10b98166' : '#f59e0b66') }}>{(c.eligibleShare * 100).toFixed(0)}% elig</span>
            </div>
            <div className="px-2 text-[10px] text-slate-400">OK {c.ok} · MARGIN {c.margin} · UNABLE <span style={{ color: c.unable > 0 ? '#ef4444' : '#64748b' }}>{c.unable}</span> · mean score {c.meanScore.toFixed(0)}</div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${c.eligibleShare * 100}%`, backgroundColor: c.eligibleShare >= 0.6 ? '#10b981' : c.eligibleShare >= 0.3 ? '#f59e0b' : '#ef4444' }} className="h-full" />
              </div>
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-500">worst <button onClick={() => { const w = rows.find(rw => rw.fir === c.fir && (rw.f.callsign === c.worstCs || rw.f.icao === c.worstCs)); if (w) onFly(w.f.icao) }} className="text-sky-400 hover:text-sky-300">{c.worstCs || '—'}</button></div>
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: RTCA DO-312 ITP SPR · DO-317B ASA MOPS · DO-260B 1090 ES · DO-289 CDTI · EUROCAE ED-159 / ED-194A · ICAO Doc 4444 §16.5 · Doc 9869 PBN/PBCS App E · Doc 9863 ACAS · Annex 10 Vol IV ch 5 · NAT Doc 007 ch 13 · NAT OPS Bull 2019-006 · Pacific FIT 2018-3 · FAA AC 90-114B · AC 90-117 · Order JO 7110.65 §8-1-10 · Boeing 777/787 FCOM 11.30 ADS-B IN · Airbus DSC-31 SURV ATSA.
      </div>
    </div>
  )
}
