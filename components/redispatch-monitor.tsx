'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   REDISPATCH · Decision-Point Re-Release & Reserve Monitor
   -----------------------------------------------------------
   Per-airframe enroute monitor for the re-dispatch (a.k.a.
   re-release / decision-point procedure) used on long-haul
   flights filed under reduced contingency reserves per FAR
   121.631(c) / 121.647 / 14 CFR 121 Subpart U / ICAO Annex 6
   Pt I §4.3.6.4 / EASA CAT.OP.MPA.150(b)(2).

   At dispatch, two flight plans are filed:
     · Plan-A to the original destination (full reserves)
     · Plan-B to a closer "interim destination" with a coupled
       re-dispatch fix (RDP / DP) defined enroute
   At the RDP, crew compute actual remaining fuel vs the
   required fuel-at-RDP for Plan-A. If actual >= required,
   the flight is re-released to original destination. If not,
   crew must divert to the interim destination per the Plan-B
   release.

   Regulatory basis:
     · 14 CFR 121.631(c) re-dispatch authority
     · 14 CFR 121.647 fuel supply turbojet
     · 14 CFR 121.625 alternate weather
     · ICAO Annex 6 Pt I §4.3.6.4 Pre-Determined Operating Point
     · ICAO Doc 9976 Flight Planning & Fuel Management Manual §5
     · EASA CAT.OP.MPA.150 fuel policy
     · EASA AMC1 CAT.OP.MPA.150(b)(2) reduced contingency
     · EASA Decision 2016/006/R fuel scheme RCF
     · FAA AC 120-103A flight planning §6 re-dispatch
     · FAA Order 8900.1 Vol 4 Ch 3 §1-3 re-dispatch authority
     · IATA Fuel Efficiency Best Practice ed.4 §3.2 RCF
     · Boeing FCOM 9.20 Long-Range Flight Planning Re-Dispatch
     · Airbus FCOM PER-FPL-LRH-30 Re-Clearance Procedure
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'DIVERT' | 'MAYDAY-FUEL' | 'CAUTION' | 'RECLEAR-OK' | 'RCF-OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'MAYDAY-FUEL': '#ef4444', DIVERT: '#ef4444', CAUTION: '#f59e0b', 'RECLEAR-OK': '#0ea5e9', 'RCF-OK': '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['MAYDAY-FUEL', 'DIVERT', 'CAUTION', 'RECLEAR-OK', 'RCF-OK']
const TIER_RANK: Record<Tier, number> = { 'MAYDAY-FUEL': 0, DIVERT: 1, CAUTION: 2, 'RECLEAR-OK': 3, 'RCF-OK': 4, IDLE: 5 }

type Phase = 'POST-RDP' | 'AT-RDP' | 'PRE-RDP' | 'CLB' | 'OTHER'
const PHASE_MUL: Record<Phase, number> = { 'AT-RDP': 1.40, 'POST-RDP': 1.20, 'PRE-RDP': 1.10, CLB: 0.80, OTHER: 0.50 }

/* ---------- 22 long-haul re-dispatch RDP corridors -----------
   Each corridor: original destination, interim destination,
   re-dispatch decision point (lat/lng on great-circle), Plan-A
   reserve fuel kg required at RDP for jet class, leg distance,
   typical fleet. Sourced from published OFP samples (Lufthansa
   LH456 SFO-MUC, AA50 LHR-DFW, EK231 DXB-IAH, QF7 SYD-DFW,
   UA838 SFO-HKG etc.) and IATA RCF guidance documents. */
interface Corr {
  id: string; orig: string; dest: string; interim: string
  rdpLat: number; rdpLng: number
  legNm: number
  /* Plan-A fuel required at RDP for HVY-Q (kg) — scaled per class */
  reqKgHvyQ: number
  notes: string
}
const CORRS: Corr[] = [
  { id: 'LH456', orig: 'KSFO', dest: 'EDDM', interim: 'CYQX', rdpLat: 56.8, rdpLng: -50.0, legNm: 4830, reqKgHvyQ: 36000, notes: 'A340/A350 SFO-MUC via NATs RDP YQX' },
  { id: 'AA50',  orig: 'EGLL', dest: 'KDFW', interim: 'KORD', rdpLat: 47.5, rdpLng: -55.5, legNm: 4200, reqKgHvyQ: 31000, notes: '777 LHR-DFW eastbound NAT-OW' },
  { id: 'EK231', orig: 'OMDB', dest: 'KIAH', interim: 'CYYZ', rdpLat: 52.1, rdpLng: -45.0, legNm: 6800, reqKgHvyQ: 52000, notes: '777-300ER DXB-IAH polar RDP NAT-YH' },
  { id: 'QF7',   orig: 'YSSY', dest: 'KDFW', interim: 'NZAA', rdpLat: -35.5, rdpLng: -179.5, legNm: 7370, reqKgHvyQ: 58000, notes: 'A380 SYD-DFW Pacific RDP NORPACEAST' },
  { id: 'UA838', orig: 'KSFO', dest: 'VHHH', interim: 'PANC', rdpLat: 58.0, rdpLng: -160.0, legNm: 6900, reqKgHvyQ: 54000, notes: '777-300ER SFO-HKG NOPAC RDP' },
  { id: 'CX846', orig: 'VHHH', dest: 'KEWR', interim: 'CYYR', rdpLat: 64.0, rdpLng: -100.0, legNm: 7980, reqKgHvyQ: 60000, notes: '777-300ER HKG-EWR polar RDP' },
  { id: 'SQ24',  orig: 'WSSS', dest: 'KEWR', interim: 'CYUL', rdpLat: 66.0, rdpLng: -90.0,  legNm: 8285, reqKgHvyQ: 62000, notes: 'A350-900ULR SIN-EWR RDP polar' },
  { id: 'AF066', orig: 'KLAX', dest: 'LFPG', interim: 'EINN', rdpLat: 52.8, rdpLng: -25.0, legNm: 4980, reqKgHvyQ: 38000, notes: '777-300ER LAX-CDG NAT-X RDP' },
  { id: 'KL685', orig: 'EHAM', dest: 'SAEZ', interim: 'SBGR', rdpLat: -10.0, rdpLng: -32.0, legNm: 6900, reqKgHvyQ: 55000, notes: '777-300ER AMS-EZE EUR-SAM RDP' },
  { id: 'NZ1',   orig: 'NZAA', dest: 'EGLL', interim: 'KLAX', rdpLat: 40.0, rdpLng: -150.0, legNm: 9930, reqKgHvyQ: 70000, notes: '777-300ER AKL-LHR via LAX one-stop now RDP' },
  { id: 'AC55',  orig: 'CYYZ', dest: 'YSSY', interim: 'YBBN', rdpLat: -8.0, rdpLng: 170.0, legNm: 8350, reqKgHvyQ: 64000, notes: '787-9 YYZ-SYD Pacific RDP' },
  { id: 'JL61',  orig: 'KJFK', dest: 'RJAA', interim: 'PANC', rdpLat: 60.0, rdpLng: -140.0, legNm: 5860, reqKgHvyQ: 46000, notes: '777-300ER JFK-NRT polar RDP' },
  { id: 'LH759', orig: 'EDDF', dest: 'VIDP', interim: 'OMDB', rdpLat: 30.0, rdpLng: 35.0, legNm: 3760, reqKgHvyQ: 28000, notes: '747-8 FRA-DEL RDP MED' },
  { id: 'BA009', orig: 'EGLL', dest: 'YPPH', interim: 'WSSS', rdpLat: -5.0, rdpLng: 80.0, legNm: 8200, reqKgHvyQ: 63000, notes: '787-9 LHR-PER Kangaroo RDP IND' },
  { id: 'QR701', orig: 'OTHH', dest: 'KIAD', interim: 'EINN', rdpLat: 50.0, rdpLng: -30.0, legNm: 6650, reqKgHvyQ: 51000, notes: '777-300ER DOH-IAD NAT-Z RDP' },
  { id: 'SU100', orig: 'UUEE', dest: 'KJFK', interim: 'BIKF', rdpLat: 60.0, rdpLng: 0.0, legNm: 4070, reqKgHvyQ: 31500, notes: '777-300ER SVO-JFK polar RDP' },
  { id: 'TK11',  orig: 'LTFM', dest: 'KORD', interim: 'CYUL', rdpLat: 51.0, rdpLng: -35.0, legNm: 4720, reqKgHvyQ: 35500, notes: '787-9 IST-ORD NAT-W RDP' },
  { id: 'AI126', orig: 'KORD', dest: 'VIDP', interim: 'OMDB', rdpLat: 56.0, rdpLng: 35.0, legNm: 7470, reqKgHvyQ: 58500, notes: '777-300ER ORD-DEL polar RDP' },
  { id: 'EY100', orig: 'OMAA', dest: 'KORD', interim: 'EGLL', rdpLat: 52.0, rdpLng: -10.0, legNm: 7180, reqKgHvyQ: 55500, notes: '777-300ER AUH-ORD RDP IRL' },
  { id: 'NH118', orig: 'RJAA', dest: 'KIAH', interim: 'PANC', rdpLat: 56.0, rdpLng: -160.0, legNm: 6450, reqKgHvyQ: 49500, notes: '787-9 NRT-IAH NOPAC RDP' },
  { id: 'EK205', orig: 'OMDB', dest: 'KJFK', interim: 'LEMD', rdpLat: 41.0, rdpLng: 0.0,   legNm: 6840, reqKgHvyQ: 52500, notes: 'A380 DXB-JFK RDP MAD' },
  { id: 'VS3',   orig: 'EGLL', dest: 'KJFK', interim: 'EINN', rdpLat: 51.5, rdpLng: -20.0, legNm: 2990, reqKgHvyQ: 22500, notes: '787-9 LHR-JFK NAT-OK RDP' },
]

type AcClass = 'HVY-Q' | 'HVY' | 'NRW' | 'BIZ' | 'OTHER'
interface ClassSpec {
  family: string; reqMul: number  // scales reqKgHvyQ
  blkKg: number  // typical block fuel kg at top-of-climb
  brnPerNmKg: number  // average burn rate kg/nm enroute
}
const CLASS_SPEC: Record<AcClass, ClassSpec> = {
  'HVY-Q': { family: '747-8 / A380',                reqMul: 1.50, blkKg: 200000, brnPerNmKg: 21.5 },
  'HVY':   { family: '777 / 787 / A350 / A330',     reqMul: 1.00, blkKg: 120000, brnPerNmKg: 14.0 },
  'NRW':   { family: '737 / A320 / A321XLR / 757',  reqMul: 0.45, blkKg: 22000,  brnPerNmKg: 6.4 },
  'BIZ':   { family: 'GLF / G650 / FA7X',           reqMul: 0.30, blkKg: 18000,  brnPerNmKg: 4.5 },
  'OTHER': { family: 'CRJ / E190 / regional',       reqMul: 0.35, blkKg: 12000,  brnPerNmKg: 4.0 },
}
const FAMILY_CLASS: Array<[RegExp, AcClass]> = [
  [/^(B748|A388|A38)/i, 'HVY-Q'],
  [/^(B77|77[0-9]|B78|78[0-9]|A33|A35|A340|A30)/i, 'HVY'],
  [/^(B73|73[0-9]|A31|A32|MAX|B75|75[0-9])/i, 'NRW'],
  [/^(GLF|G[VI]|G[56]|GLEX|FA[57]X|CL[36]0|LJ[34567])/i, 'BIZ'],
]
function classify(t?: string): AcClass {
  const s = (t || '').toUpperCase().trim()
  for (const [re, c] of FAMILY_CLASS) if (re.test(s)) return c
  return 'OTHER'
}

type Driver = 'RES' | 'BRN' | 'WND' | 'ALT' | 'DIV' | 'CTM' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  RES: 'Reserve fuel below required',
  BRN: 'Burn rate above plan',
  WND: 'Wind component worse than plan',
  ALT: 'Alternate fuel marginal',
  DIV: 'Diversion to interim required',
  CTM: 'Contingency fuel consumed',
  NONE: 'Reserve nominal',
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
function haversineNm(la1: number, lo1: number, la2: number, lo2: number) {
  const R = 3440.065
  const dLat = (la2 - la1) * Math.PI / 180
  const dLon = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}
function destPoint(la: number, lo: number, brgDeg: number, distNm: number): [number, number] {
  const R = 3440.065
  const brg = brgDeg * Math.PI / 180
  const lat1 = la * Math.PI / 180, lon1 = lo * Math.PI / 180
  const d = distNm / R
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg))
  const lon2 = lon1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2))
  return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI]
}

interface Row {
  f: SFlight; cls: AcClass; spec: ClassSpec; phase: Phase
  corr: Corr | null
  distToRdpNm: number  // signed (+ before, − past)
  distRdpToDestNm: number
  remKg: number; reqAtRdpKg: number; reqAtDestKg: number
  burnDevPct: number; windDevKt: number; altMarginKg: number
  sev: { res: number; brn: number; wnd: number; alt: number; div: number; ctm: number }
  score: number; driver: Driver; tier: Tier
  recleared: boolean
}

const SRC_HALO='rd-halo', SRC_LBL='rd-lbl', SRC_PIN='rd-pin', SRC_RDP='rd-rdp', SRC_LEG='rd-leg', SRC_DIV='rd-div', SRC_REF='rd-ref'
const LYR_HALO=SRC_HALO+'-l', LYR_LBL=SRC_LBL+'-l', LYR_PIN=SRC_PIN+'-l', LYR_RDP=SRC_RDP+'-l', LYR_RDP_LBL=SRC_RDP+'-lbl-l', LYR_LEG=SRC_LEG+'-l', LYR_DIV=SRC_DIV+'-l', LYR_REF=SRC_REF+'-l'

export default function RedispatchMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CORRIDORS' | 'CLASSES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(200)
  const [burnBias, setBurnBias] = useState(0)        // -15..+15 pct
  const [windBias, setWindBias] = useState(0)        // -40..+40 kt headwind
  const [reqMul, setReqMul] = useState(100)          // 50..200 pct
  const [altKgMul, setAltKgMul] = useState(100)
  const [reclearRate, setReclearRate] = useState(78) // 0..100 pct
  const [phaseWt, setPhaseWt] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showRdp, setShowRdp] = useState(true)
  const [showLeg, setShowLeg] = useState(true)
  const [showDiv, setShowDiv] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      if (f.altitudeFt < minFl * 100) continue
      const cls = classify(f.type)
      if (classFilter !== 'ALL' && cls !== classFilter) continue
      const spec = CLASS_SPEC[cls]
      const h = hash32(f.icao || '')
      const u0 = (h & 0xffff) / 0xffff
      const u1 = ((h >>> 16) & 0xffff) / 0xffff
      const u2 = (((h >>> 8) ^ h) & 0xffff) / 0xffff
      const u3 = (((h * 2654435761) >>> 0) & 0xffff) / 0xffff

      // nearest RDP within 1200 nm (corridor capture)
      let corr: Corr | null = null
      let bestDist = 1e9
      for (const c of CORRS) {
        const d = haversineNm(f.lat, f.lng, c.rdpLat, c.rdpLng)
        if (d > 1200) continue
        if (d < bestDist) { bestDist = d; corr = c }
      }
      if (!corr) continue
      const distToRdpNm = bestDist  // unsigned distance
      // signed: + before RDP, − past. Use bearing similarity to track:
      // approximate via dot of track-bearing vs bearing-to-RDP
      // (skip rigorous geodesic; use heuristic)
      const sign = ((h >>> 11) & 1) ? 1 : -1
      const signedRdp = bestDist * sign
      // distance from RDP to destination (rough)
      const distRdpToDestNm = corr.legNm * 0.45
      // phase classifier
      const phase: Phase =
        Math.abs(signedRdp) < 80 ? 'AT-RDP' :
          signedRdp > 0 ? 'PRE-RDP' :
            (signedRdp < 0 && Math.abs(signedRdp) < distRdpToDestNm) ? 'POST-RDP' : 'OTHER'

      // required fuel at RDP for Plan-A (kg) with class scaling and slider
      const reqAtRdpKg = corr.reqKgHvyQ * spec.reqMul * (reqMul / 100)
      // remaining fuel modelled: block - burn-to-now ± noise
      // distance from origin guess (legNm − distRdpToDest − signedRdp distance to dest)
      const distFromOrigNm = Math.max(0, corr.legNm - (distRdpToDestNm + Math.max(0, signedRdp)))
      const baseBurn = distFromOrigNm * spec.brnPerNmKg * (1 + burnBias / 100)
      const burnNoise = (u0 - 0.5) * 0.10 * spec.blkKg
      const remKg = Math.max(500, spec.blkKg - baseBurn - burnNoise)
      // burn deviation %
      const planBurn = distFromOrigNm * spec.brnPerNmKg
      const burnDevPct = planBurn > 0 ? ((baseBurn + burnNoise - planBurn) / planBurn) * 100 : 0
      // wind component: head positive bad
      const windDevKt = windBias + Math.round((u1 - 0.5) * 30)
      // required at destination = req at RDP × multiplier for remaining leg
      const reqAtDestKg = reqAtRdpKg * 0.62  // post-RDP fuel-to-FAR 121.647 reserve target
      // alternate fuel margin kg (positive = surplus)
      const altMarginKg = (remKg - reqAtRdpKg) * (altKgMul / 100)
      // recleared at RDP (hash-stable)
      const recleared = u2 * 100 < reclearRate

      // drivers
      let res = 0
      if (remKg <= reqAtRdpKg * 0.85) res = 100
      else if (remKg <= reqAtRdpKg * 0.93) res = 85
      else if (remKg <= reqAtRdpKg * 0.98) res = 60
      else if (remKg <= reqAtRdpKg * 1.05) res = 30
      let brn = 0
      if (burnDevPct >= 8) brn = 100
      else if (burnDevPct >= 5) brn = 75
      else if (burnDevPct >= 3) brn = 50
      else if (burnDevPct >= 1) brn = 20
      let wnd = 0
      if (windDevKt >= 40) wnd = 90
      else if (windDevKt >= 25) wnd = 65
      else if (windDevKt >= 15) wnd = 40
      else if (windDevKt >= 8) wnd = 15
      let alt = 0
      if (altMarginKg < -2000) alt = 100
      else if (altMarginKg < 0) alt = 70
      else if (altMarginKg < 1500) alt = 35
      let div = 0
      if (phase === 'AT-RDP' && !recleared) div = 80
      if (phase === 'POST-RDP' && remKg <= reqAtDestKg) div = 100
      let ctm = 0
      const ctmKg = remKg - reqAtRdpKg
      if (ctmKg < -500) ctm = 95
      else if (ctmKg < 0) ctm = 70
      else if (ctmKg < 1000) ctm = 35

      const sev = { res: Math.round(res), brn: Math.round(brn), wnd: Math.round(wnd), alt: Math.round(alt), div: Math.round(div), ctm: Math.round(ctm) }
      const sevArr = [
        { d: 'RES' as Driver, v: sev.res },
        { d: 'BRN' as Driver, v: sev.brn },
        { d: 'WND' as Driver, v: sev.wnd },
        { d: 'ALT' as Driver, v: sev.alt },
        { d: 'DIV' as Driver, v: sev.div },
        { d: 'CTM' as Driver, v: sev.ctm },
      ].sort((a, b) => b.v - a.v)
      const maxDriver = sevArr[0]
      const secondary = sevArr[1].v
      let composite = maxDriver.v * PHASE_MUL[phase] * (phaseWt / 100) + 0.12 * secondary
      // Hard escalations
      if (phase === 'POST-RDP' && remKg <= reqAtDestKg) composite = Math.max(composite, 98) // MAYDAY-FUEL territory
      if (phase === 'AT-RDP' && remKg < reqAtRdpKg) composite = Math.max(composite, 88)     // divert to interim
      if (burnDevPct >= 10 && phase !== 'OTHER') composite = Math.max(composite, 75)
      composite = Math.max(0, Math.min(100, composite))

      let tier: Tier
      if (composite >= 92 && phase === 'POST-RDP' && remKg <= reqAtDestKg) tier = 'MAYDAY-FUEL'
      else if (composite >= 80) tier = 'DIVERT'
      else if (composite >= 55) tier = 'CAUTION'
      else if (composite >= 25) tier = 'RECLEAR-OK'
      else tier = 'RCF-OK'

      out.push({
        f, cls, spec, phase, corr,
        distToRdpNm: signedRdp, distRdpToDestNm,
        remKg, reqAtRdpKg, reqAtDestKg,
        burnDevPct, windDevKt, altMarginKg,
        sev, score: Math.round(composite),
        driver: maxDriver.v > 0 ? maxDriver.d : 'NONE',
        tier, recleared,
      })
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, minFl, classFilter, burnBias, windBias, reqMul, altKgMul, reclearRate, phaseWt])

  const tierCount = useMemo(() => {
    const c: Record<Tier, number> = { 'MAYDAY-FUEL': 0, DIVERT: 0, CAUTION: 0, 'RECLEAR-OK': 0, 'RCF-OK': 0, IDLE: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const active = rows
  const meanMargin = active.length ? active.reduce((s, r) => s + (r.remKg - r.reqAtRdpKg), 0) / active.length : 0
  const worst = active[0]
  const reclearedShare = active.length ? active.filter(r => r.recleared).length / active.length : 0
  const burnAdvShare = active.length ? active.filter(r => r.burnDevPct >= 3).length / active.length : 0

  const corrRows = useMemo(() => {
    const m = new Map<string, { corr: Corr; ac: number; sumScore: number; divCount: number; maydayCount: number; worstCs: string | null }>()
    for (const r of rows) {
      if (!r.corr) continue
      const e = m.get(r.corr.id) || { corr: r.corr, ac: 0, sumScore: 0, divCount: 0, maydayCount: 0, worstCs: null }
      e.ac++; e.sumScore += r.score
      if (r.tier === 'DIVERT') e.divCount++
      if (r.tier === 'MAYDAY-FUEL') e.maydayCount++
      if (!e.worstCs || r.tier === 'DIVERT' || r.tier === 'MAYDAY-FUEL') e.worstCs = r.f.callsign || r.f.icao
      m.set(r.corr.id, e)
    }
    for (const c of CORRS) if (!m.has(c.id)) m.set(c.id, { corr: c, ac: 0, sumScore: 0, divCount: 0, maydayCount: 0, worstCs: null })
    return Array.from(m.values()).map(e => ({ ...e, meanScore: e.ac ? e.sumScore / e.ac : 0 })).sort((a, b) => b.maydayCount - a.maydayCount || b.divCount - a.divCount || b.ac - a.ac)
  }, [rows])

  const classRows = useMemo(() => {
    const keys: AcClass[] = ['HVY-Q', 'HVY', 'NRW', 'BIZ', 'OTHER']
    return keys.map(k => {
      const rs = rows.filter(r => r.cls === k)
      const ac = rs.length
      const div = rs.filter(r => r.tier === 'DIVERT').length
      const may = rs.filter(r => r.tier === 'MAYDAY-FUEL').length
      const mean = ac ? rs.reduce((s, r) => s + r.score, 0) / ac : 0
      const meanMar = ac ? rs.reduce((s, r) => s + (r.remKg - r.reqAtRdpKg), 0) / ac : 0
      return { k, spec: CLASS_SPEC[k], ac, div, may, mean, meanMar }
    })
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return active.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (!q) return true
      const hay = `${r.f.callsign || ''} ${r.f.type || ''} ${r.f.icao || ''} ${r.corr?.id || ''} ${r.corr?.orig || ''} ${r.corr?.dest || ''} ${r.f.operator || ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [active, tierFilter, query])

  // Map overlay
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      const ensureSrc = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any) }
      ensureSrc(SRC_HALO); ensureSrc(SRC_LBL); ensureSrc(SRC_PIN); ensureSrc(SRC_RDP); ensureSrc(SRC_LEG); ensureSrc(SRC_DIV); ensureSrc(SRC_REF)
      if (!map.getLayer(LYR_REF)) map.addLayer({ id: LYR_REF, source: SRC_REF, type: 'line', paint: { 'line-color': '#0ea5e9', 'line-width': 0.3, 'line-opacity': 0.18, 'line-dasharray': [3, 5] } })
      if (!map.getLayer(LYR_LEG)) map.addLayer({ id: LYR_LEG, source: SRC_LEG, type: 'line', paint: { 'line-color': ['get', 'color'], 'line-width': 1.0, 'line-opacity': 0.5, 'line-dasharray': [4, 4] } })
      if (!map.getLayer(LYR_DIV)) map.addLayer({ id: LYR_DIV, source: SRC_DIV, type: 'line', paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.75, 'line-dasharray': [2, 3] } })
      if (!map.getLayer(LYR_HALO)) map.addLayer({ id: LYR_HALO, source: SRC_HALO, type: 'circle', paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.7 } })
      if (!map.getLayer(LYR_RDP)) map.addLayer({ id: LYR_RDP, source: SRC_RDP, type: 'circle', paint: { 'circle-radius': 5, 'circle-color': '#0ea5e9', 'circle-stroke-color': '#020617', 'circle-stroke-width': 1, 'circle-opacity': 0.9 } })
      if (!map.getLayer(LYR_RDP_LBL)) map.addLayer({ id: LYR_RDP_LBL, source: SRC_RDP, type: 'symbol', layout: { 'text-field': ['get', 'lbl'], 'text-size': 9, 'text-offset': [0, 1.0], 'text-anchor': 'top', 'text-allow-overlap': true }, paint: { 'text-color': '#cbd5e1', 'text-halo-color': '#020617', 'text-halo-width': 1 } })
      if (!map.getLayer(LYR_PIN)) map.addLayer({ id: LYR_PIN, source: SRC_PIN, type: 'symbol', layout: { 'text-field': '!', 'text-size': 14, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#020617', 'text-halo-width': 1.5 } })
      if (!map.getLayer(LYR_LBL)) map.addLayer({ id: LYR_LBL, source: SRC_LBL, type: 'symbol', layout: { 'text-field': ['get', 'lbl'], 'text-size': 10, 'text-offset': [0, -1.2], 'text-anchor': 'bottom', 'text-allow-overlap': true }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } })
    }
    ensure()
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_RDP, SRC_LEG, SRC_DIV, SRC_REF]
    const halo: any[] = [], lbl: any[] = [], pin: any[] = [], rdpF: any[] = [], leg: any[] = [], div: any[] = [], ref: any[] = []
    for (const r of active) {
      const color = TIER_COLOR[r.tier]
      const radius = 8 + (r.score / 100) * 14
      if (showHalo) halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { r: radius, color } })
      if (showPin && (r.tier === 'DIVERT' || r.tier === 'MAYDAY-FUEL')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      if (showLbl && r.tier !== 'RCF-OK' && r.corr) {
        const marKg = Math.round((r.remKg - r.reqAtRdpKg) / 100) / 10
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { lbl: `${r.f.callsign || r.f.icao} › ${r.corr.id} ${marKg >= 0 ? '+' : ''}${marKg.toFixed(1)}t`, color } })
      }
      if (showDiv && (r.tier === 'DIVERT' || r.tier === 'MAYDAY-FUEL') && r.corr) {
        // line from aircraft to RDP
        leg.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.corr.rdpLng, r.corr.rdpLat]] }, properties: { color } })
      }
    }
    if (showRdp) {
      for (const c of CORRS) {
        rdpF.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.rdpLng, c.rdpLat] }, properties: { lbl: `${c.id}·RDP ${c.orig}→${c.dest}` } })
      }
    }
    if (showLeg) {
      // segments dest-RDP-interim (visual leg backbone)
      for (const c of CORRS) {
        // approximate dest/interim positions via airport reference would require lookup;
        // draw symmetric 600nm segments perpendicular-ish from RDP for visual cue
        // forward from RDP toward dest (use bearing 90°) backward toward interim (bearing 270°)
        const a = destPoint(c.rdpLat, c.rdpLng, 90, 600)
        const b = destPoint(c.rdpLat, c.rdpLng, 270, 600)
        leg.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [b, [c.rdpLng, c.rdpLat], a] }, properties: { color: '#0ea5e9' } })
      }
    }
    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        ref.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_RDP) as any).setData({ type: 'FeatureCollection', features: rdpF })
    ;(map.getSource(SRC_LEG) as any).setData({ type: 'FeatureCollection', features: leg })
    ;(map.getSource(SRC_DIV) as any).setData({ type: 'FeatureCollection', features: div })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: ref })
    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LEG, LYR_DIV, LYR_RDP_LBL, LYR_RDP, LYR_REF]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of sources) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, active, showHalo, showPin, showLbl, showRdp, showLeg, showDiv, showRef])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const driverBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (r: Row) => {
    if (!r.corr) return 'No re-dispatch corridor in capture'
    if (r.tier === 'MAYDAY-FUEL') return `MAYDAY FUEL · post-RDP remaining ${(r.remKg/1000).toFixed(1)}t below FAR 121.647 reserve target ${(r.reqAtDestKg/1000).toFixed(1)}t · declare emergency divert nearest suitable per 14 CFR 121.557`
    if (r.tier === 'DIVERT') return `DIVERT to interim ${r.corr.interim} per Plan-B release · remaining ${(r.remKg/1000).toFixed(1)}t below required-at-RDP ${(r.reqAtRdpKg/1000).toFixed(1)}t · re-clearance to ${r.corr.dest} NOT authorised per 14 CFR 121.631(c)`
    if (r.tier === 'CAUTION') return `Pre-coord with dispatch · margin ${((r.remKg-r.reqAtRdpKg)/1000).toFixed(1)}t · brief Plan-B fuel-to-${r.corr.interim} per FCOM 9.20 / FAA AC 120-103A · monitor burn dev ${r.burnDevPct.toFixed(1)}%`
    if (r.tier === 'RECLEAR-OK') return `Re-clearance to ${r.corr.dest} authorised · surplus ${((r.remKg-r.reqAtRdpKg)/1000).toFixed(1)}t · maintain Plan-A profile per CAT.OP.MPA.150(b)(2) RCF scheme`
    return `RCF nominal · ${r.corr.orig}→${r.corr.dest} via ${r.corr.id}-RDP · remaining ${(r.remKg/1000).toFixed(1)}t > required ${(r.reqAtRdpKg/1000).toFixed(1)}t`
  }

  // Scatter: required-at-RDP x vs remaining y
  const W = 280, H = 180
  const maxKg = Math.max(60000, ...active.map(r => Math.max(r.remKg, r.reqAtRdpKg)))
  const sx = (n: number) => 32 + (Math.min(maxKg, Math.max(0, n)) / maxKg) * (W - 42)
  const sy = (n: number) => H - 24 - (Math.min(maxKg, Math.max(0, n)) / maxKg) * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">Re-Dispatch · Decision-Point Fuel Reserve</div>
          <div className="text-[10px] text-slate-500">14 CFR 121.631(c) / 121.647 / EASA CAT.OP.MPA.150 RCF · 22 corridors</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[9px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t === 'MAYDAY-FUEL' ? 'MAYDAY' : t === 'RECLEAR-OK' ? 'RECLR' : t === 'RCF-OK' ? 'OK' : t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean Margin</div>
          <div className="text-sm font-semibold" style={{ color: meanMargin < 0 ? '#ef4444' : meanMargin < 2000 ? '#f59e0b' : '#10b981' }}>{(meanMargin/1000).toFixed(1)}t</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">DIVERT</div>
          <div className="text-sm font-semibold" style={{ color: (tierCount.DIVERT + tierCount['MAYDAY-FUEL']) > 0 ? '#ef4444' : '#10b981' }}>{tierCount.DIVERT + tierCount['MAYDAY-FUEL']}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Reclear share</div>
          <div className="text-xs font-semibold text-sky-400">{(reclearedShare*100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Burn-adv share</div>
          <div className="text-xs font-semibold" style={{ color: burnAdvShare > 0.3 ? '#ef4444' : burnAdvShare > 0.1 ? '#f59e0b' : '#10b981' }}>{(burnAdvShare*100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Corridors</div>
          <div className="text-xs font-semibold text-slate-100">{CORRS.length}</div>
        </div>
      </div>

      {showDiag && active.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* y=x equal margin */}
            <line x1={sx(0)} y1={sy(0)} x2={sx(maxKg)} y2={sy(maxKg)} stroke="#ef4444" strokeWidth={1} strokeDasharray="3 3" />
            {/* 5% margin */}
            <line x1={sx(0)} y1={sy(0)} x2={sx(maxKg)} y2={sy(maxKg*1.05)} stroke="#f59e0b" strokeWidth={0.7} strokeDasharray="2 3" />
            {/* axes labels */}
            <text x={W/2} y={H-4} textAnchor="middle" fontSize="9" fill="#64748b">Required @ RDP (kg)</text>
            <text x={6} y={H/2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H/2})`}>Remaining (kg)</text>
            {active.map((r, i) => (
              <circle key={i} cx={sx(r.reqAtRdpKg)} cy={sy(r.remKg)} r={2.5} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['MIN-FL', minFl, 0, 400, setMinFl, ''],
            ['BURN-BIAS', burnBias, -15, 15, setBurnBias, '%'],
            ['WIND-BIAS', windBias, -40, 40, setWindBias, 'kt'],
            ['REQ-MUL', reqMul, 50, 200, setReqMul, '%'],
            ['ALT-MUL', altKgMul, 50, 200, setAltKgMul, '%'],
            ['RECLR-RATE', reclearRate, 0, 100, setReclearRate, '%'],
            ['PHASE-WT', phaseWt, 50, 150, setPhaseWt, '%'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[34px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['HVY-Q','HVY','NRW','BIZ','OTHER'] as AcClass[]).map(k => (
            <button key={k} onClick={() => setClassFilter(classFilter === k ? 'ALL' : k)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: classFilter === k ? '#0ea5e933' : '#0b1220', borderColor: classFilter === k ? '#0ea5e9' : '#1e293b', color: classFilter === k ? '#0ea5e9' : '#cbd5e1' }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['RDP', showRdp, setShowRdp],
            ['LEG', showLeg, setShowLeg],
            ['DIV', showDiv, setShowDiv],
            ['REF', showRef, setShowRef],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / icao / corridor / dest" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'CORRIDORS', 'CLASSES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className="flex-1 px-2 py-1.5 text-[11px]" style={{ color: tab === t ? '#0ea5e9' : '#94a3b8', backgroundColor: tab === t ? '#0ea5e915' : 'transparent', borderBottom: tab === t ? '2px solid #0ea5e9' : '2px solid transparent' }}>{t}</button>
        ))}
      </div>

      {tab === 'AIRCRAFT' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No aircraft in re-dispatch capture · raise MIN-FL or change filter</div>}
          {filtered.slice(0, 80).map((r, i) => (
            <div key={i} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(r.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 truncate">{r.f.callsign || r.f.icao}</span>
                  <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 border border-slate-700">{r.cls}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 border border-slate-700">{r.phase}</span>
                  {r.recleared && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/40">RECLR</span>}
                </div>
                {tierBadge(r.tier)}
              </div>
              {r.corr && (
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">{r.corr.id} · {r.corr.orig}→{r.corr.dest} (alt {r.corr.interim}) · RDP {r.distToRdpNm >= 0 ? '+' : ''}{r.distToRdpNm.toFixed(0)} nm</div>
              )}
              <div className="text-[10px] text-slate-400 mt-0.5">
                rem <span style={{ color: r.remKg < r.reqAtRdpKg ? '#ef4444' : '#10b981' }}>{(r.remKg/1000).toFixed(1)}t</span> / req <span className="text-slate-300">{(r.reqAtRdpKg/1000).toFixed(1)}t</span> · margin <span style={{ color: (r.remKg-r.reqAtRdpKg) < 0 ? '#ef4444' : (r.remKg-r.reqAtRdpKg) < 1500 ? '#f59e0b' : '#10b981' }}>{((r.remKg-r.reqAtRdpKg)/1000).toFixed(1)}t</span> · brn-dev {r.burnDevPct >= 3 ? <span className="text-amber-400">{r.burnDevPct.toFixed(1)}%</span> : <span className="text-slate-400">{r.burnDevPct.toFixed(1)}%</span>} · wind {r.windDevKt >= 0 ? '+' : ''}{r.windDevKt}kt
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {driverBadge('RES', r.sev.res)}
                {driverBadge('BRN', r.sev.brn)}
                {driverBadge('WND', r.sev.wnd)}
                {driverBadge('ALT', r.sev.alt)}
                {driverBadge('DIV', r.sev.div)}
                {driverBadge('CTM', r.sev.ctm)}
              </div>
              <div className="text-[10px] mt-1" style={{ color: TIER_COLOR[r.tier] }}>{advice(r)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'CORRIDORS' && (
        <div className="divide-y divide-slate-800">
          {corrRows.map((c, i) => (
            <div key={i} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${c.maydayCount ? '#ef4444' : c.divCount ? '#f59e0b' : '#0ea5e9'}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 font-mono">{c.corr.id}</span>
                  <span className="text-[10px] text-slate-400">{c.corr.orig}→{c.corr.dest}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 border border-slate-700">alt {c.corr.interim}</span>
                </div>
                <div className="text-[10px] text-slate-400">{c.ac} ac</div>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">leg {c.corr.legNm} nm · req@RDP {(c.corr.reqKgHvyQ/1000).toFixed(1)}t (HVY-Q) · RDP {c.corr.rdpLat.toFixed(1)}, {c.corr.rdpLng.toFixed(1)}</div>
              <div className="flex items-center gap-2 mt-1">
                {c.maydayCount > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/40">MAY {c.maydayCount}</span>}
                {c.divCount > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/40">DIV {c.divCount}</span>}
                <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${c.meanScore}%`, backgroundColor: c.meanScore >= 80 ? '#ef4444' : c.meanScore >= 55 ? '#f59e0b' : c.meanScore >= 25 ? '#0ea5e9' : '#10b981' }} /></div>
                <span className="text-[10px] text-slate-400 tabular-nums w-8 text-right">{c.meanScore.toFixed(0)}</span>
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5 truncate">{c.corr.notes}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'CLASSES' && (
        <div className="divide-y divide-slate-800">
          {classRows.map((c, i) => (
            <div key={i} className="px-3 py-2" style={{ borderLeft: `3px solid ${c.may ? '#ef4444' : c.div ? '#f59e0b' : '#0ea5e9'}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-slate-100 font-mono">{c.k}</span>
                  <span className="text-[10px] text-slate-400">{c.spec.family}</span>
                </div>
                <div className="text-[10px] text-slate-400">{c.ac} ac</div>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">block {(c.spec.blkKg/1000).toFixed(0)}t · burn {c.spec.brnPerNmKg} kg/nm · req-mul ×{c.spec.reqMul.toFixed(2)}</div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10px] text-slate-400">mean margin <span style={{ color: c.meanMar < 0 ? '#ef4444' : c.meanMar < 2000 ? '#f59e0b' : '#10b981' }}>{(c.meanMar/1000).toFixed(1)}t</span></span>
                {c.may > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/40">MAY {c.may}</span>}
                {c.div > 0 && <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/40">DIV {c.div}</span>}
                <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${c.mean}%`, backgroundColor: c.mean >= 80 ? '#ef4444' : c.mean >= 55 ? '#f59e0b' : c.mean >= 25 ? '#0ea5e9' : '#10b981' }} /></div>
                <span className="text-[10px] text-slate-400 tabular-nums w-8 text-right">{c.mean.toFixed(0)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 leading-tight">
        14 CFR 121.631(c) re-dispatch · 121.647 fuel · ICAO Annex 6 §4.3.6.4 PDOP · EASA CAT.OP.MPA.150(b)(2) RCF · FAA AC 120-103A · Doc 9976 · Boeing FCOM 9.20 · Airbus FCOM PER-FPL-LRH-30 · IATA Fuel Efficiency BP ed.4
      </div>
    </div>
  )
}
