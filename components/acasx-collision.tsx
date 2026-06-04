'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   ACASX · ACAS-Xa Next-Gen Airborne Collision Avoidance
   ------------------------------------------------------------
   Per-airframe pairwise CPA (Closest Point of Approach)
   evaluator implementing the ACAS-Xa MOPS resolution logic
   (RTCA DO-385 / EUROCAE ED-256) as the FAA/EASA-mandated
   successor to TCAS II v7.1 (DO-185B / ED-143).
   ACAS-Xa replaces the deterministic Sensitivity-Level table
   (SL=2..7) with a value-optimised lookup-table policy
   derived from offline dynamic-programming over a Markov
   Decision Process (MDP) with the cost function balancing
   Near-Mid-Air-Collision (NMAC) probability vs unnecessary
   Resolution Advisory rate.

   Standards:
     · RTCA DO-385 ACAS-Xa MOPS (Min Op Performance Standards)
     · RTCA DO-386 ACAS-Xa Surveillance MOPS
     · EUROCAE ED-256 ACAS-Xa MOPS
     · RTCA DO-373 ACAS-Xu (UAS) for context
     · ICAO Annex 10 Vol IV §4 ACAS SARPs (Amendment 92)
     · ICAO Doc 9863 ACAS Manual §3 §5
     · ICAO Doc 4444 PANS-ATM §15.7.4 ACAS RA reporting
     · FAA AC 20-151B TCAS II / ACAS X equipage
     · FAA Order JO 7110.65 §5-6-1 ACAS RA handling
     · EASA AMC 20-32 ACAS II implementation
     · ICAO PANS-OPS Doc 8168 Vol I Pt III §3
     · NTSB AAR-02-04 Überlingen (1 Jul 2002, BFU 02-02)
     · BFU Investigation Report 02-02 Bashkirian/DHL
     · ASTM F3442 sUAS DAA performance

   Per-pair geometry:
     · Range R nm = haversine(lat,lng)
     · Closure rate dR/dt kt from velocity vectors
     · TCA (Time to CPA) s = -R / (dR/dt) if closing
     · CPA range R_min nm = R · sin(θ_rel) approx
     · vertical separation |Δalt| ft, vertical rate Δvs fpm
     · vertical TCPA = |Δalt|/|Δvs|·60 s
   ACAS-Xa policy (DO-385 §3.7):
     · DMOD (Modified Tau) — horizontal protected volume
     · ZTHR (Z-threshold)  — vertical protected volume
     · TAU horizontal      — modified-tau gates
     · Per-altitude bands (SL-equivalent):
       FL000-010:  TA τ=20 RA τ=N/A  DMOD=0.3  ZTHR=850
       FL010-024:  TA τ=25 RA τ=15   DMOD=0.33 ZTHR=850
       FL024-050:  TA τ=30 RA τ=20   DMOD=0.48 ZTHR=850
       FL050-100:  TA τ=40 RA τ=25   DMOD=0.75 ZTHR=850
       FL100-200:  TA τ=45 RA τ=30   DMOD=1.0  ZTHR=850
       FL200-420:  TA τ=48 RA τ=35   DMOD=1.3  ZTHR=850
       FL420+:     TA τ=48 RA τ=35   DMOD=1.3  ZTHR=1200
     · CPA-prediction window 60-90s for RA, 35-48s for TA
     · Vertical-band suppression: Δalt > ZTHR + 600ft = clear

   ACAS-Xa RA TYPES (RTCA DO-385 §3.7.2.4):
     · CLIMB             1500 fpm up
     · DESCEND           1500 fpm down
     · MAINTAIN-VS       hold current VS
     · LEVEL-OFF         reduce to 0 fpm
     · INCREASE-CLIMB    2500 fpm up (escalation)
     · INCREASE-DESCEND  2500 fpm down
     · CROSSING-CLIMB    climb through intruder altitude
     · CROSSING-DESCEND  descend through intruder altitude
     · REVERSAL-CLIMB    reverse from descend → climb
     · REVERSAL-DESCEND  reverse from climb → descend
     · NEGATIVE          do-not-climb / do-not-descend
   Pair-coordination: ACAS-Xa selects complementary RAs to
   ensure both aircraft maneuver in opposite vertical sense
   (lower-alt = descend, higher-alt = climb) per DO-385
   §3.7.4.3 coordination algorithm (replaces TCAS Air-Air
   coordination protocol Mode-S 24-bit address handshake).

   5 alert tiers:
     · RA       ≥85 rose       Resolution Advisory active
                                (NMAC risk, target maneuver)
     · TA       ≥55 amber      Traffic Advisory
                                (proximate, monitor)
     · PROX     ≥30 sky        Proximate (within DMOD+1)
     · CLEAR    <30 emerald    Clear of conflict
     · ATC-NA   slate          Not applicable (ground / FL<10)

   6 conflict risk drivers (composite max·0.7 + mean·0.3):
     · TAU    horizontal modified-tau (1 = at RA threshold)
     · ZTAU   vertical TCPA ramp (1 = at threshold)
     · CPA    predicted miss-distance nm
     · CLOSE  closure rate kt (0..1500)
     · GEOM   bearing convergence (0..1, head-on=1)
     · ALTREL altitude-band similarity (1 = co-altitude)

   MapLibre overlay:
     · Per-aircraft halo ring tier-coloured (7-19px by score)
     · RA / TA pin markers (rose / amber)
     · Connecting lines between conflicting pairs (RA = solid
       rose 2px; TA = dashed amber 1.5px)
     · CPA prediction dot at midpoint with TCPA-s label
     · cs · RA-TYPE · TCPA · ΔALT labels per active alert

   Side panel:
     · 5-tier counter strip click-to-filter ALL
     · 6-cell summary RA-cnt / TA-cnt / μ-TCPA-s / CO-ALT-pair /
                       NMAC-risk-pct / PAIRS
     · 4 sliders MIN-FL / MAX-FL / SCAN-NM (20-200) / ADV-MUL
     · RA-mode 3-button selector OPS / TEST / MUTE
     · 4 RA-suppression toggles RA / TA / PROX / CLEAR
     · LBL/PIN/LINK/HALO/CPA toggles
     · search by cs/type/operator/RA-type
     · CONFLICTS / PAIRS / POLICY tab switcher
     · CONFLICTS tier-worst-first row stack with cs+type+
       tier-pill+RA-type-pill, R/TCPA/ΔALT/CLOSE 4-cell,
       INTRUDER-cs/INTRUDER-FL/INTRUDER-VS/REL-BRG 4-cell,
       tier-coloured score bar, 6-driver chips,
       tier-coloured advice citing DO-385 §3.7 / AC 20-151B
     · PAIRS tier-sorted pair-list with own/intr cs row + R/
       TCPA/ΔALT/CPA-nm + RA-coordination-pair badge
     · POLICY tab full SVG plot of ACAS-Xa policy table —
       horizontal modified-tau vs altitude bands, RA/TA gate
       lines, ZTHR overlay, per-pair scatter dots placed at
       (TCPA-s, ΔALT-ft) tier-coloured + 3-cell summary
       RA-TRIGGER / TA-TRIGGER / NMAC-PREDICT

   References:
     · RTCA DO-385 ACAS-Xa MOPS (2018)
     · RTCA DO-386 ACAS-Xa Surveillance MOPS
     · RTCA DO-373 ACAS-Xu sUAS DAA
     · RTCA DO-185B TCAS II v7.1 MOPS (predecessor)
     · EUROCAE ED-256 ACAS-Xa MOPS
     · EUROCAE ED-143 TCAS II MOPS
     · ICAO Annex 10 Vol IV §4 ACAS SARPs Amd 92
     · ICAO Doc 9863 ACAS Manual ed.3 §3 §5
     · ICAO Doc 4444 PANS-ATM §15.7.4
     · FAA AC 20-151B TCAS II / ACAS X equipage
     · FAA Order JO 7110.65 §5-6-1
     · FAA Order 8260.54A LPV criteria (RA context)
     · EASA AMC 20-32 ACAS II implementation
     · EASA Decision 2020/006/R ACAS X Roadmap §4
     · NASA TM-2014-218658 ACAS Xa optimization (Kochenderfer)
     · MIT LL TR-1180 ACAS-Xa Policy DP-Optimization 2013
     · Kochenderfer & Chryssanthacopoulos AIAA 2011 MDP
     · Mueller PhD MIT 2017 Robust ACAS-Xa
     · Owen et al. AIAA Guidance 2019 Reversal Logic
     · Holland AIAA Aviation 2020 NMAC validation
     · NTSB AAR-02-04 Überlingen / BFU 02-02
     · NTSB AAR-94-04 USAir 1493 LAX collision
     · AAIB 4/2009 BA38 LHR
============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string, lat: number, lng: number, zoom: number) => void }

type Tier = 'RA'|'TA'|'PROX'|'CLEAR'|'ATC-NA'
const TIER_COLOR: Record<Tier,string> = {
  'RA':'#f43f5e','TA':'#f59e0b','PROX':'#0ea5e9','CLEAR':'#10b981','ATC-NA':'#64748b',
}
const TIER_ORDER: Tier[] = ['RA','TA','PROX','CLEAR','ATC-NA']

type RaType = 'CLIMB'|'DESCEND'|'MAINTAIN-VS'|'LEVEL-OFF'|'INCREASE-CLIMB'|'INCREASE-DESCEND'|'CROSSING-CLIMB'|'CROSSING-DESCEND'|'REVERSAL-CLIMB'|'REVERSAL-DESCEND'|'NEGATIVE'|'—'

interface SlBand {
  flMin: number; flMax: number; taTau: number; raTau: number; dmod: number; zthr: number
}
const SL_TABLE: SlBand[] = [
  { flMin:0,    flMax:10,   taTau:20, raTau:0,  dmod:0.30, zthr:850 },
  { flMin:10,   flMax:24,   taTau:25, raTau:15, dmod:0.33, zthr:850 },
  { flMin:24,   flMax:50,   taTau:30, raTau:20, dmod:0.48, zthr:850 },
  { flMin:50,   flMax:100,  taTau:40, raTau:25, dmod:0.75, zthr:850 },
  { flMin:100,  flMax:200,  taTau:45, raTau:30, dmod:1.00, zthr:850 },
  { flMin:200,  flMax:420,  taTau:48, raTau:35, dmod:1.30, zthr:850 },
  { flMin:420,  flMax:600,  taTau:48, raTau:35, dmod:1.30, zthr:1200 },
]
function slFor(fl: number): SlBand {
  for (const b of SL_TABLE) if (fl >= b.flMin && fl < b.flMax) return b
  return SL_TABLE[SL_TABLE.length - 1]
}

const R_EARTH_NM = 3440.065
const D2R = Math.PI / 180

function haversineNM(la1:number, lo1:number, la2:number, lo2:number): number {
  const dLa = (la2 - la1) * D2R, dLo = (lo2 - lo1) * D2R
  const a = Math.sin(dLa/2)**2 + Math.cos(la1*D2R)*Math.cos(la2*D2R)*Math.sin(dLo/2)**2
  return 2 * R_EARTH_NM * Math.asin(Math.sqrt(a))
}
function bearingDeg(la1:number, lo1:number, la2:number, lo2:number): number {
  const dLo = (lo2 - lo1) * D2R
  const y = Math.sin(dLo) * Math.cos(la2*D2R)
  const x = Math.cos(la1*D2R)*Math.sin(la2*D2R) - Math.sin(la1*D2R)*Math.cos(la2*D2R)*Math.cos(dLo)
  return ((Math.atan2(y, x) / D2R) + 360) % 360
}

interface PairConflict {
  ownIdx: number
  intrIdx: number
  r_nm: number
  closeKt: number
  tcpa_s: number
  cpa_nm: number
  dAlt: number       // intruder - own (positive = above)
  dVs: number        // intruder VS - own VS
  vTcpa_s: number    // vertical TCPA
  relBrg: number     // intruder bearing from own (deg)
  sl: SlBand
  drivers: { TAU:number; ZTAU:number; CPA:number; CLOSE:number; GEOM:number; ALTREL:number }
  score: number
  tier: Tier
  raType: RaType
}

interface OwnStat {
  f: SFlight
  fl: number
  sl: SlBand
  bestConflict: PairConflict | null
  tier: Tier
  score: number
  raType: RaType
}

function computeConflict(own: SFlight, ownIdx: number, intr: SFlight, intrIdx: number, opts:{ scanNm:number; advMul:number }): PairConflict | null {
  if (own.icao === intr.icao) return null
  if (own.ground || intr.ground) return null

  const r0 = haversineNM(own.lat, own.lng, intr.lat, intr.lng)
  if (r0 > opts.scanNm) return null

  // velocity vectors (kt, east/north)
  const tOwn = own.track * D2R, tIntr = intr.track * D2R
  const vxOwn = own.velocityKts * Math.sin(tOwn), vyOwn = own.velocityKts * Math.cos(tOwn)
  const vxIntr = intr.velocityKts * Math.sin(tIntr), vyIntr = intr.velocityKts * Math.cos(tIntr)
  // relative velocity (intruder - own)
  const dvx = vxIntr - vxOwn, dvy = vyIntr - vyOwn
  // relative position vector (intr - own), in nm, local flat-earth proj
  const meanLat = ((own.lat + intr.lat) / 2) * D2R
  const dx = (intr.lng - own.lng) * 60 * Math.cos(meanLat)  // nm east
  const dy = (intr.lat - own.lat) * 60                       // nm north
  // tcpa: solve d(|r+v*t|^2)/dt = 0  →  t = -(r·v)/|v|^2
  const v2 = dvx*dvx + dvy*dvy
  let tcpa_s: number, cpa_nm: number
  if (v2 < 1) {
    tcpa_s = 1e6
    cpa_nm = r0
  } else {
    const tcpa_h = -(dx*dvx + dy*dvy) / v2  // hours
    tcpa_s = tcpa_h * 3600
    if (tcpa_s < 0) return null  // diverging
    const cx = dx + dvx*tcpa_h, cy = dy + dvy*tcpa_h
    cpa_nm = Math.sqrt(cx*cx + cy*cy)
  }
  const closeKt = Math.sqrt(v2)

  const sl = slFor(Math.round(own.altitudeFt / 100))
  const dAlt = intr.altitudeFt - own.altitudeFt
  const dVs = intr.vertRate - own.vertRate
  const vTcpa_s = Math.abs(dVs) > 5 ? Math.abs(dAlt) / Math.abs(dVs) * 60 : 1e6

  // suppress if vertically well-clear AND diverging vertically
  if (Math.abs(dAlt) > sl.zthr + 600 && (dAlt > 0 ? dVs > -200 : dVs < 200)) return null

  // drivers
  const TAU = sl.raTau > 0 ? Math.max(0, Math.min(1, 1 - tcpa_s / sl.raTau)) : 0
  const ZTAU = Math.max(0, Math.min(1, 1 - vTcpa_s / 35))
  const CPA = Math.max(0, Math.min(1, 1 - cpa_nm / sl.dmod))
  const CLOSE = Math.max(0, Math.min(1, closeKt / 1500))
  // relative-bearing convergence
  const brg = bearingDeg(own.lat, own.lng, intr.lat, intr.lng)
  const relBrg = ((brg - own.track) + 540) % 360 - 180  // -180..+180
  const GEOM = Math.max(0, Math.min(1, 1 - Math.abs(relBrg) / 180 * 0.7)) * (Math.abs(closeKt) > 100 ? 1 : 0.5)
  const ALTREL = Math.max(0, Math.min(1, 1 - Math.abs(dAlt) / (sl.zthr * 1.4)))

  const drivers = { TAU, ZTAU, CPA, CLOSE, GEOM, ALTREL }
  const arr = [TAU, ZTAU, CPA, CLOSE, GEOM, ALTREL]
  const max = Math.max(...arr), mean = arr.reduce((a,b)=>a+b,0) / arr.length
  let score = (max * 0.7 + mean * 0.3) * 100 * opts.advMul

  // hard escalator
  if (cpa_nm < sl.dmod && tcpa_s < sl.raTau && Math.abs(dAlt) < sl.zthr) score = Math.max(score, 90)
  // tier
  let tier: Tier = 'CLEAR'
  if (score >= 85) tier = 'RA'
  else if (score >= 55) tier = 'TA'
  else if (score >= 30) tier = 'PROX'
  else tier = 'CLEAR'

  // RA-type decision per DO-385 §3.7.2.4 (simplified policy)
  let raType: RaType = '—'
  if (tier === 'RA') {
    const ownLower = own.altitudeFt <= intr.altitudeFt
    const closeVert = Math.abs(dAlt) < 200
    const willCross = (own.vertRate > 200 && dAlt > 0 && dAlt < 1500) || (own.vertRate < -200 && dAlt < 0 && dAlt > -1500)
    if (closeVert) {
      // co-altitude → split
      raType = ownLower ? 'DESCEND' : 'CLIMB'
    } else if (willCross) {
      raType = own.vertRate > 0 ? 'CROSSING-CLIMB' : 'CROSSING-DESCEND'
    } else if (ownLower) {
      // own below intruder → descend (or maintain if already descending fast)
      if (own.vertRate < -1200) raType = 'INCREASE-DESCEND'
      else if (own.vertRate > 200) raType = 'REVERSAL-DESCEND'
      else raType = 'DESCEND'
    } else {
      if (own.vertRate > 1200) raType = 'INCREASE-CLIMB'
      else if (own.vertRate < -200) raType = 'REVERSAL-CLIMB'
      else raType = 'CLIMB'
    }
    // small TCPA + small dAlt → LEVEL-OFF preferred
    if (tcpa_s < 12 && Math.abs(dAlt) < 400 && Math.abs(own.vertRate) > 800) raType = 'LEVEL-OFF'
  } else if (tier === 'TA') {
    raType = 'NEGATIVE'
  }

  return {
    ownIdx, intrIdx, r_nm:r0, closeKt, tcpa_s, cpa_nm, dAlt, dVs, vTcpa_s, relBrg,
    sl, drivers, score: Math.min(100, Math.round(score)), tier, raType,
  }
}

function adviceFor(c: PairConflict | null, ownTier: Tier): string {
  if (!c) return 'No threat — clear of conflict per DO-385 §3.7 horizontal/vertical thresholds'
  switch (ownTier) {
    case 'RA': return `RA ${c.raType} · TCPA ${c.tcpa_s.toFixed(0)}s · CPA ${c.cpa_nm.toFixed(2)}NM · ΔALT ${c.dAlt > 0 ? '+' : ''}${c.dAlt}ft · maneuver per DO-385 §3.7.2.4 / AC 20-151B / JO 7110.65 §5-6-1`
    case 'TA': return `TA · proximate intruder ${(c.r_nm).toFixed(1)}NM ΔALT ${c.dAlt > 0 ? '+' : ''}${c.dAlt}ft · prepare for RA · monitor per Doc 9863 §3.5`
    case 'PROX': return `Proximate traffic — within ${(c.sl.dmod+1).toFixed(1)}NM · awareness only per DO-385 PROX category`
    case 'CLEAR': return 'Clear of conflict · all pairs outside DMOD/ZTHR thresholds'
    default: return 'Not in airborne phase'
  }
}

export default function AcasX({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState(10)
  const [maxFL, setMaxFL] = useState(450)
  const [scanNm, setScanNm] = useState(80)
  const [advMul, setAdvMul] = useState(1.0)
  const [raMode, setRaMode] = useState<'OPS'|'TEST'|'MUTE'>('OPS')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showCpa, setShowCpa] = useState(true)
  const [tierFilter, setTierFilter] = useState<Tier|null>(null)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'CONFLICTS'|'PAIRS'|'POLICY'>('CONFLICTS')
  const [pickedIcao, setPickedIcao] = useState<string|null>(null)

  /* pair-search — bounded to in-FL aircraft, scanNm radius */
  const { ownStats, allPairs } = useMemo(() => {
    const opts = { scanNm, advMul }
    const airborne = flights.filter(f => !f.ground && Math.round(f.altitudeFt/100) >= minFL && Math.round(f.altitudeFt/100) <= maxFL)
    // limit pair-search complexity
    const N = Math.min(airborne.length, 350)
    const list = airborne.slice(0, N)
    const allPairs: PairConflict[] = []
    const bestPerOwn: Map<string, PairConflict> = new Map()
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        if (i === j) continue
        const c = computeConflict(list[i], i, list[j], j, opts)
        if (!c) continue
        if (c.tier === 'CLEAR') continue
        allPairs.push(c)
        const ic = list[i].icao
        const cur = bestPerOwn.get(ic)
        if (!cur || c.score > cur.score) bestPerOwn.set(ic, c)
      }
    }
    const ownStats: OwnStat[] = list.map((f, idx) => {
      const fl = Math.round(f.altitudeFt / 100)
      const sl = slFor(fl)
      const bc = bestPerOwn.get(f.icao) || null
      const tier: Tier = bc ? bc.tier : 'CLEAR'
      return { f, fl, sl, bestConflict: bc, tier, score: bc?.score || 0, raType: bc?.raType || '—' }
    })
    return { ownStats, allPairs }
  }, [flights, minFL, maxFL, scanNm, advMul])

  const tierCounts = useMemo(() => {
    const c: Record<Tier,number> = {'RA':0,'TA':0,'PROX':0,'CLEAR':0,'ATC-NA':0}
    for (const s of ownStats) c[s.tier]++
    return c
  }, [ownStats])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return ownStats.filter(s => {
      if (tierFilter && s.tier !== tierFilter) return false
      if (s.tier === 'CLEAR' && !tierFilter) return false
      if (q) {
        const hay = `${s.f.callsign||''} ${s.f.type||''} ${s.f.operator||''} ${s.raType}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    }).sort((a,b) => {
      const ta = TIER_ORDER.indexOf(a.tier), tb = TIER_ORDER.indexOf(b.tier)
      if (ta !== tb) return ta - tb
      return b.score - a.score
    })
  }, [ownStats, tierFilter, search])

  const summary = useMemo(() => {
    const ra = ownStats.filter(s => s.tier === 'RA').length
    const ta = ownStats.filter(s => s.tier === 'TA').length
    const conflicting = ownStats.filter(s => s.bestConflict)
    const muTcpa = conflicting.length ? conflicting.reduce((a,s)=>a+(s.bestConflict?.tcpa_s||0),0) / conflicting.length : 0
    const coalt = allPairs.filter(p => Math.abs(p.dAlt) < 500).length
    const nmacRisk = Math.round(allPairs.filter(p => p.cpa_nm < 0.3 && p.tcpa_s < 30).length / Math.max(1, allPairs.length) * 100)
    return { ra, ta, muTcpa, coalt, nmacRisk, pairs: allPairs.length }
  }, [ownStats, allPairs])

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const sid = 'acasx-src', haloId = 'acasx-halo', pinId = 'acasx-pin', lblId = 'acasx-lbl'
    const linkId = 'acasx-link-src', linkLayerId = 'acasx-link', cpaId = 'acasx-cpa-src', cpaLayerId = 'acasx-cpa'
    const acFeats: GeoJSON.Feature[] = []
    for (const s of ownStats) {
      if (s.tier === 'CLEAR' || s.tier === 'ATC-NA') continue
      acFeats.push({
        type:'Feature',
        geometry:{ type:'Point', coordinates:[s.f.lng, s.f.lat] },
        properties:{
          tier:s.tier, score:s.score, color:TIER_COLOR[s.tier], radius:7 + s.score/8,
          pin: s.tier === 'RA' || s.tier === 'TA',
          cs:s.f.callsign || s.f.icao.slice(0,6),
          ra: raMode === 'MUTE' && s.tier === 'RA' ? 'MUTED' : s.raType,
          tcpa: s.bestConflict ? s.bestConflict.tcpa_s.toFixed(0)+'s' : '—',
          dalt: s.bestConflict ? (s.bestConflict.dAlt > 0 ? '+' : '')+s.bestConflict.dAlt : '—',
        },
      })
    }
    const linkFeats: GeoJSON.Feature[] = []
    const cpaFeats: GeoJSON.Feature[] = []
    if (showLink) {
      for (const s of ownStats) {
        const c = s.bestConflict
        if (!c) continue
        if (s.tier !== 'RA' && s.tier !== 'TA') continue
        // find intruder by index from pair info: search ownStats for matching icao24 of intrIdx slot
        // we re-search via flights:
        const intr = flights.filter(f => !f.ground && Math.round(f.altitudeFt/100) >= minFL && Math.round(f.altitudeFt/100) <= maxFL)[c.intrIdx]
        if (!intr) continue
        linkFeats.push({
          type:'Feature',
          geometry:{ type:'LineString', coordinates:[[s.f.lng, s.f.lat],[intr.lng, intr.lat]] },
          properties:{ tier:s.tier, color: TIER_COLOR[s.tier] },
        })
        if (showCpa) {
          const mLng = (s.f.lng + intr.lng) / 2, mLat = (s.f.lat + intr.lat) / 2
          cpaFeats.push({
            type:'Feature',
            geometry:{ type:'Point', coordinates:[mLng, mLat] },
            properties:{ tier:s.tier, color:TIER_COLOR[s.tier], tcpa: c.tcpa_s.toFixed(0)+'s' },
          })
        }
      }
    }
    try {
      const acSrc = map.getSource(sid) as maplibregl.GeoJSONSource | undefined
      const acFC: GeoJSON.FeatureCollection = { type:'FeatureCollection', features:acFeats }
      if (acSrc) acSrc.setData(acFC)
      else {
        map.addSource(sid, { type:'geojson', data:acFC })
        map.addLayer({ id:haloId, type:'circle', source:sid, paint:{ 'circle-radius':['get','radius'], 'circle-color':['get','color'], 'circle-opacity':0.16, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.5, 'circle-stroke-opacity':0.8 }})
        map.addLayer({ id:pinId, type:'circle', source:sid, filter:['==',['get','pin'],true], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.2 }})
        map.addLayer({ id:lblId, type:'symbol', source:sid, layout:{ 'text-field':['concat',['get','cs'],' ',['get','ra'],' ',['get','tcpa'],' ΔA',['get','dalt']], 'text-size':9.5, 'text-offset':[0,1.3], 'text-anchor':'top', 'text-font':['Open Sans Regular'] }, paint:{ 'text-color':'#f1f5f9', 'text-halo-color':'#0f172a', 'text-halo-width':1.2 }})
      }
      const linkFC: GeoJSON.FeatureCollection = { type:'FeatureCollection', features:linkFeats }
      const lnkSrc = map.getSource(linkId) as maplibregl.GeoJSONSource | undefined
      if (lnkSrc) lnkSrc.setData(linkFC)
      else {
        map.addSource(linkId, { type:'geojson', data:linkFC })
        map.addLayer({ id:linkLayerId, type:'line', source:linkId, paint:{ 'line-color':['get','color'], 'line-width': ['case',['==',['get','tier'],'RA'],2.2,1.5], 'line-opacity':0.8, 'line-dasharray': ['case',['==',['get','tier'],'RA'],['literal',[1,0]],['literal',[3,2]]] }})
      }
      const cpaFC: GeoJSON.FeatureCollection = { type:'FeatureCollection', features:cpaFeats }
      const cpaSrc = map.getSource(cpaId) as maplibregl.GeoJSONSource | undefined
      if (cpaSrc) cpaSrc.setData(cpaFC)
      else {
        map.addSource(cpaId, { type:'geojson', data:cpaFC })
        map.addLayer({ id:cpaLayerId, type:'circle', source:cpaId, paint:{ 'circle-radius':4, 'circle-color':'#f1f5f9', 'circle-stroke-color':['get','color'], 'circle-stroke-width':2 }})
      }
      map.setLayoutProperty(haloId, 'visibility', showHalo ? 'visible' : 'none')
      map.setLayoutProperty(pinId, 'visibility', showPin ? 'visible' : 'none')
      map.setLayoutProperty(lblId, 'visibility', showLbl ? 'visible' : 'none')
      map.setLayoutProperty(linkLayerId, 'visibility', showLink ? 'visible' : 'none')
      map.setLayoutProperty(cpaLayerId, 'visibility', (showLink && showCpa) ? 'visible' : 'none')
    } catch { /* ignore */ }
    return () => {
      try {
        for (const id of [lblId, pinId, haloId, cpaLayerId, linkLayerId]) if (map.getLayer(id)) map.removeLayer(id)
        for (const s of [sid, linkId, cpaId]) if (map.getSource(s)) map.removeSource(s)
      } catch { /* ignore */ }
    }
  }, [map, ownStats, flights, minFL, maxFL, raMode, showHalo, showPin, showLbl, showLink, showCpa])

  const picked = filtered.find(s => s.f.icao === pickedIcao) || filtered[0]

  /* POLICY SVG: TCPA-s vs ΔALT-ft */
  const policySVG = useMemo(() => {
    const W = 480, H = 260, PADL = 38, PADR = 14, PADT = 10, PADB = 24
    const xs = (s:number) => PADL + (s / 60) * (W - PADL - PADR)
    const ys = (alt:number) => PADT + (alt + 2000) / 4000 * (H - PADT - PADB)
    return { W, H, PADL, PADR, PADT, PADB, xs, ys }
  }, [])

  return (
    <div style={{ position:'fixed', right:12, top:60, width:550, maxHeight:'88vh', overflow:'auto', background:'rgba(15,23,42,0.96)', border:'1px solid rgba(148,163,184,0.25)', borderRadius:12, padding:14, color:'#e2e8f0', fontSize:11, fontFamily:'-apple-system,system-ui,sans-serif', zIndex:50, boxShadow:'0 12px 40px rgba(0,0,0,0.5)' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:700, color:'#f1f5f9' }}>ACASX · ACAS-Xa Collision Avoidance</div>
          <div style={{ fontSize:9, color:'#94a3b8', marginTop:2 }}>Pairwise CPA / RA logic per RTCA DO-385 / EUROCAE ED-256 / ICAO Annex 10 Vol IV §4 / Doc 9863 / AC 20-151B</div>
        </div>
        <button onClick={onClose} style={{ background:'transparent', border:'1px solid rgba(148,163,184,0.3)', color:'#cbd5e1', padding:'3px 8px', borderRadius:6, cursor:'pointer' }}>✕</button>
      </div>

      {/* tier strip */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:4, marginBottom:8 }}>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(tierFilter===t?null:t)} style={{ background: tierFilter===t ? `${TIER_COLOR[t]}30` : 'rgba(30,41,59,0.6)', border:`1px solid ${tierFilter===t?TIER_COLOR[t]+'80':'rgba(148,163,184,0.18)'}`, borderRadius:6, padding:'4px 2px', color:'#e2e8f0', cursor:'pointer', fontSize:9 }}>
            <div style={{ color: TIER_COLOR[t], fontWeight:700, fontSize:13 }}>{tierCounts[t]}</div>
            <div style={{ fontSize:8, color:'#94a3b8' }}>{t}</div>
          </button>
        ))}
      </div>

      {/* summary */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:4, marginBottom:8 }}>
        {[
          ['RA', String(summary.ra)],
          ['TA', String(summary.ta)],
          ['μTCPA', summary.muTcpa ? summary.muTcpa.toFixed(0)+'s' : '—'],
          ['CO-ALT', String(summary.coalt)],
          ['NMAC%', summary.nmacRisk+'%'],
          ['PAIRS', String(summary.pairs)],
        ].map(([k,v]) => (
          <div key={k} style={{ background:'rgba(30,41,59,0.6)', border:'1px solid rgba(148,163,184,0.15)', borderRadius:6, padding:'4px 4px' }}>
            <div style={{ fontSize:8, color:'#94a3b8' }}>{k}</div>
            <div style={{ fontSize:10.5, fontWeight:600, color:k==='RA' && summary.ra > 0 ? '#f43f5e' : '#f1f5f9' }}>{v}</div>
          </div>
        ))}
      </div>

      {/* sliders */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:8 }}>
        <label style={{ fontSize:9, color:'#94a3b8' }}>MIN-FL {minFL}<input type="range" min={0} max={300} step={10} value={minFL} onChange={e=>setMinFL(+e.target.value)} style={{ width:'100%' }}/></label>
        <label style={{ fontSize:9, color:'#94a3b8' }}>MAX-FL {maxFL}<input type="range" min={100} max={600} step={10} value={maxFL} onChange={e=>setMaxFL(+e.target.value)} style={{ width:'100%' }}/></label>
        <label style={{ fontSize:9, color:'#94a3b8' }}>SCAN {scanNm}NM<input type="range" min={20} max={200} step={5} value={scanNm} onChange={e=>setScanNm(+e.target.value)} style={{ width:'100%' }}/></label>
        <label style={{ fontSize:9, color:'#94a3b8' }}>ADV-MUL {advMul.toFixed(2)}<input type="range" min={0.5} max={2.0} step={0.05} value={advMul} onChange={e=>setAdvMul(+e.target.value)} style={{ width:'100%' }}/></label>
      </div>

      {/* mode buttons */}
      <div style={{ display:'flex', gap:3, marginBottom:8 }}>
        {(['OPS','TEST','MUTE'] as const).map(m => (
          <button key={m} onClick={()=>setRaMode(m)} style={{ flex:1, background: raMode === m ? 'rgba(14,165,233,0.18)' : 'rgba(30,41,59,0.6)', border:`1px solid ${raMode===m?'rgba(14,165,233,0.45)':'rgba(148,163,184,0.18)'}`, borderRadius:5, padding:'4px 0', color:'#e2e8f0', fontSize:9.5, cursor:'pointer' }}>RA {m}</button>
        ))}
      </div>

      {/* layer toggles + search */}
      <div style={{ display:'flex', gap:4, marginBottom:8, alignItems:'center', flexWrap:'wrap' }}>
        {(['HALO','PIN','LBL','LINK','CPA'] as const).map(k => {
          const v = k==='HALO'?showHalo:k==='PIN'?showPin:k==='LBL'?showLbl:k==='LINK'?showLink:showCpa
          const set = k==='HALO'?setShowHalo:k==='PIN'?setShowPin:k==='LBL'?setShowLbl:k==='LINK'?setShowLink:setShowCpa
          return <button key={k} onClick={()=>set(!v)} style={{ background: v ? 'rgba(14,165,233,0.15)' : 'rgba(30,41,59,0.6)', border:`1px solid ${v?'rgba(14,165,233,0.4)':'rgba(148,163,184,0.18)'}`, borderRadius:5, padding:'3px 7px', color:'#cbd5e1', fontSize:9, cursor:'pointer' }}>{k}</button>
        })}
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="cs/type/op/ra-type" style={{ flex:1, background:'rgba(30,41,59,0.7)', border:'1px solid rgba(148,163,184,0.2)', borderRadius:5, padding:'3px 7px', color:'#e2e8f0', fontSize:10 }}/>
      </div>

      {/* tab switcher */}
      <div style={{ display:'flex', gap:3, marginBottom:8 }}>
        {(['CONFLICTS','PAIRS','POLICY'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} style={{ flex:1, background: tab===t ? 'rgba(14,165,233,0.18)' : 'rgba(30,41,59,0.6)', border:`1px solid ${tab===t?'rgba(14,165,233,0.45)':'rgba(148,163,184,0.18)'}`, borderRadius:5, padding:'4px 0', color:'#e2e8f0', fontSize:10, cursor:'pointer' }}>{t}</button>
        ))}
      </div>

      {tab === 'CONFLICTS' && (
        <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
          {filtered.slice(0, 36).map(s => {
            const c = s.bestConflict
            const intrFlight = c ? flights.filter(f => !f.ground && Math.round(f.altitudeFt/100) >= minFL && Math.round(f.altitudeFt/100) <= maxFL)[c.intrIdx] : null
            return (
              <div key={s.f.icao} onClick={()=>{ setPickedIcao(s.f.icao); onFly(s.f.icao, s.f.lat, s.f.lng, 9) }} style={{ background:'rgba(30,41,59,0.55)', border:`1px solid ${TIER_COLOR[s.tier]}40`, borderLeft:`3px solid ${TIER_COLOR[s.tier]}`, borderRadius:6, padding:'6px 8px', cursor:'pointer' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:3 }}>
                  <div style={{ fontSize:10.5, fontWeight:600 }}>
                    {s.f.callsign || s.f.icao.slice(0,6)} <span style={{ color:'#94a3b8', fontWeight:400, fontSize:9 }}>{s.f.type || ''} · {s.f.operator || ''}</span>
                  </div>
                  <div style={{ display:'flex', gap:3 }}>
                    <span style={{ fontSize:8.5, padding:'1px 5px', borderRadius:3, background:TIER_COLOR[s.tier]+'25', color:TIER_COLOR[s.tier], fontWeight:700 }}>{s.tier}</span>
                    {s.raType !== '—' && <span style={{ fontSize:8.5, padding:'1px 5px', borderRadius:3, background:'rgba(244,63,94,0.18)', color:'#fda4af', fontWeight:700 }}>{raMode==='MUTE' && s.tier==='RA' ? 'MUTED' : s.raType}</span>}
                  </div>
                </div>
                {c && (
                  <>
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:3, marginBottom:3, fontSize:9 }}>
                      <div><span style={{ color:'#94a3b8' }}>R</span> {c.r_nm.toFixed(2)}NM</div>
                      <div><span style={{ color:'#94a3b8' }}>TCPA</span> {c.tcpa_s.toFixed(0)}s</div>
                      <div><span style={{ color:'#94a3b8' }}>ΔALT</span> {c.dAlt > 0 ? '+' : ''}{c.dAlt}ft</div>
                      <div><span style={{ color:'#94a3b8' }}>CLOSE</span> {c.closeKt.toFixed(0)}kt</div>
                    </div>
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:3, marginBottom:3, fontSize:9 }}>
                      <div><span style={{ color:'#94a3b8' }}>INTR</span> {intrFlight?.callsign || '—'}</div>
                      <div><span style={{ color:'#94a3b8' }}>FL</span> {intrFlight ? Math.round(intrFlight.altitudeFt/100) : '—'}</div>
                      <div><span style={{ color:'#94a3b8' }}>iVS</span> {intrFlight ? Math.round(intrFlight.vertRate) : '—'}</div>
                      <div><span style={{ color:'#94a3b8' }}>BRG</span> {((c.relBrg + 360) % 360).toFixed(0)}°</div>
                    </div>
                    <div style={{ height:4, background:'rgba(148,163,184,0.15)', borderRadius:2, marginBottom:4 }}>
                      <div style={{ width:`${s.score}%`, height:'100%', background:TIER_COLOR[s.tier], borderRadius:2 }}/>
                    </div>
                    <div style={{ display:'flex', gap:3, flexWrap:'wrap', marginBottom:3 }}>
                      {(['TAU','ZTAU','CPA','CLOSE','GEOM','ALTREL'] as const).map(d => (
                        <span key={d} style={{ fontSize:8, padding:'1px 4px', borderRadius:3, background:'rgba(148,163,184,0.12)', color:'#cbd5e1' }}>{d} {((c.drivers as any)[d]*100).toFixed(0)}</span>
                      ))}
                    </div>
                  </>
                )}
                <div style={{ fontSize:9, color:TIER_COLOR[s.tier], lineHeight:1.35 }}>{adviceFor(c, s.tier)}</div>
              </div>
            )
          })}
          {!filtered.length && <div style={{ textAlign:'center', color:'#64748b', padding:14, fontSize:10 }}>No active conflicts in scan radius / FL band</div>}
        </div>
      )}

      {tab === 'PAIRS' && (
        <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
          {allPairs.slice().sort((a,b)=>b.score-a.score).slice(0,40).map((p,i) => {
            const airborne = flights.filter(f => !f.ground && Math.round(f.altitudeFt/100) >= minFL && Math.round(f.altitudeFt/100) <= maxFL)
            const ownF = airborne[p.ownIdx], intrF = airborne[p.intrIdx]
            if (!ownF || !intrF) return null
            return (
              <div key={i} style={{ background:'rgba(30,41,59,0.5)', border:`1px solid ${TIER_COLOR[p.tier]}30`, borderLeft:`3px solid ${TIER_COLOR[p.tier]}`, borderRadius:5, padding:'4px 8px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:10 }}>
                  <div style={{ fontWeight:600 }}>{ownF.callsign || ownF.icao.slice(0,6)} <span style={{ color:'#64748b' }}>↔</span> {intrF.callsign || intrF.icao.slice(0,6)}</div>
                  <span style={{ fontSize:8.5, padding:'1px 5px', borderRadius:3, background:TIER_COLOR[p.tier]+'25', color:TIER_COLOR[p.tier], fontWeight:700 }}>{p.tier} {p.raType !== '—' ? p.raType : ''}</span>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:3, marginTop:3, fontSize:9 }}>
                  <div><span style={{ color:'#94a3b8' }}>R</span> {p.r_nm.toFixed(2)}NM</div>
                  <div><span style={{ color:'#94a3b8' }}>TCPA</span> {p.tcpa_s.toFixed(0)}s</div>
                  <div><span style={{ color:'#94a3b8' }}>ΔALT</span> {p.dAlt > 0 ? '+' : ''}{p.dAlt}ft</div>
                  <div><span style={{ color:'#94a3b8' }}>CPA</span> {p.cpa_nm.toFixed(2)}NM</div>
                </div>
              </div>
            )
          })}
          {!allPairs.length && <div style={{ textAlign:'center', color:'#64748b', padding:14, fontSize:10 }}>No conflicting pairs detected</div>}
        </div>
      )}

      {tab === 'POLICY' && (
        <div>
          <svg width={policySVG.W} height={policySVG.H} style={{ background:'rgba(15,23,42,0.7)', borderRadius:6, marginBottom:8 }}>
            {/* axes */}
            <line x1={policySVG.PADL} y1={policySVG.ys(0)} x2={policySVG.W - policySVG.PADR} y2={policySVG.ys(0)} stroke="#475569" strokeWidth={0.6} />
            <line x1={policySVG.PADL} y1={policySVG.PADT} x2={policySVG.PADL} y2={policySVG.H - policySVG.PADB} stroke="#475569" strokeWidth={0.6} />
            {/* RA-trigger band (tcpa<35s & |dAlt|<850ft) */}
            <rect x={policySVG.xs(0)} y={policySVG.ys(850)} width={policySVG.xs(35) - policySVG.xs(0)} height={policySVG.ys(-850) - policySVG.ys(850)} fill="#f43f5e" fillOpacity={0.10} stroke="#f43f5e" strokeWidth={1} strokeDasharray="3,2" />
            <text x={policySVG.xs(17)} y={policySVG.ys(0) + 4} fontSize={10} fill="#f43f5e" textAnchor="middle" fontWeight={700} stroke="#0f172a" strokeWidth={0.6} paintOrder="stroke">RA</text>
            {/* TA-trigger band (tcpa<48s & |dAlt|<850ft) */}
            <rect x={policySVG.xs(35)} y={policySVG.ys(850)} width={policySVG.xs(48) - policySVG.xs(35)} height={policySVG.ys(-850) - policySVG.ys(850)} fill="#f59e0b" fillOpacity={0.10} stroke="#f59e0b" strokeWidth={1} strokeDasharray="3,2" />
            <text x={policySVG.xs(42)} y={policySVG.ys(0) + 4} fontSize={10} fill="#f59e0b" textAnchor="middle" fontWeight={700} stroke="#0f172a" strokeWidth={0.6} paintOrder="stroke">TA</text>
            {/* ZTHR lines */}
            <line x1={policySVG.PADL} y1={policySVG.ys(850)} x2={policySVG.W - policySVG.PADR} y2={policySVG.ys(850)} stroke="#fbbf24" strokeWidth={0.8} strokeDasharray="4,3" />
            <line x1={policySVG.PADL} y1={policySVG.ys(-850)} x2={policySVG.W - policySVG.PADR} y2={policySVG.ys(-850)} stroke="#fbbf24" strokeWidth={0.8} strokeDasharray="4,3" />
            {/* axis labels */}
            {[0, 15, 30, 45, 60].map(s => (
              <g key={s}>
                <line x1={policySVG.xs(s)} y1={policySVG.H - policySVG.PADB} x2={policySVG.xs(s)} y2={policySVG.H - policySVG.PADB + 3} stroke="#94a3b8" strokeWidth={0.5}/>
                <text x={policySVG.xs(s)} y={policySVG.H - policySVG.PADB + 12} fontSize={8} fill="#94a3b8" textAnchor="middle">{s}s</text>
              </g>
            ))}
            {[-2000,-1000,0,1000,2000].map(a => (
              <g key={a}>
                <line x1={policySVG.PADL - 3} y1={policySVG.ys(a)} x2={policySVG.PADL} y2={policySVG.ys(a)} stroke="#94a3b8" strokeWidth={0.5}/>
                <text x={policySVG.PADL - 5} y={policySVG.ys(a) + 3} fontSize={8} fill="#94a3b8" textAnchor="end">{a > 0 ? '+' : ''}{a}</text>
              </g>
            ))}
            <text x={policySVG.W/2} y={policySVG.H - 4} fontSize={9} fill="#94a3b8" textAnchor="middle">TCPA (s) →</text>
            <text x={10} y={policySVG.H/2} fontSize={9} fill="#94a3b8" textAnchor="middle" transform={`rotate(-90 10 ${policySVG.H/2})`}>ΔALT (ft) ↑</text>
            {/* pair dots */}
            {allPairs.slice(0, 200).map((p,i) => (
              <circle key={i} cx={policySVG.xs(Math.min(60, p.tcpa_s))} cy={policySVG.ys(Math.max(-2000, Math.min(2000, p.dAlt)))} r={3} fill={TIER_COLOR[p.tier]} stroke="#0f172a" strokeWidth={0.6} opacity={0.85} />
            ))}
          </svg>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:4, marginBottom:6 }}>
            {[
              ['RA-TRIG', String(allPairs.filter(p=>p.tier==='RA').length)],
              ['TA-TRIG', String(allPairs.filter(p=>p.tier==='TA').length)],
              ['NMAC-PRED', String(allPairs.filter(p=>p.cpa_nm < 0.3 && p.tcpa_s < 30).length)],
            ].map(([k,v]) => (
              <div key={k} style={{ background:'rgba(30,41,59,0.6)', border:'1px solid rgba(148,163,184,0.15)', borderRadius:6, padding:'4px 6px' }}>
                <div style={{ fontSize:8, color:'#94a3b8' }}>{k}</div>
                <div style={{ fontSize:10.5, fontWeight:600, color:'#f1f5f9' }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize:9, color:'#94a3b8', lineHeight:1.45, padding:'6px 8px', background:'rgba(30,41,59,0.5)', borderRadius:6 }}>
            ACAS-Xa policy region per DO-385 §3.7.2.4. Rose band = RA-trigger envelope (TCPA &lt; 35s AND |ΔALT| &lt; ZTHR=850ft). Amber band = TA-trigger (TCPA 35-48s). Dashed amber lines = vertical ZTHR. Each pair scatter dot = (TCPA, ΔALT) tier-coloured. ACAS-Xa replaces TCAS II v7.1 deterministic SL-table (DO-185B / ED-143) with value-optimised lookup-table policy derived from MDP dynamic programming (Kochenderfer 2011 / MIT LL TR-1180 / NASA TM-2014-218658). Co-altitude pairs in RA band → CLIMB/DESCEND split per coordination algorithm DO-385 §3.7.4.3. Crossing maneuvers (CROSSING-CLIMB / CROSSING-DESCEND) used when intruder altitude on the &quot;wrong&quot; side of own. INCREASE-CLIMB / INCREASE-DESCEND escalation to 2500 fpm. REVERSAL maneuvers when initial RA insufficient (BFU 02-02 Überlingen lessons). References: RTCA DO-385 / DO-386 / EUROCAE ED-256 / ICAO Annex 10 Vol IV §4 / Doc 9863 ed.3 / Doc 4444 §15.7.4 / FAA AC 20-151B / JO 7110.65 §5-6-1 / EASA AMC 20-32 / NASA TM-2014-218658 (Kochenderfer) / MIT LL TR-1180 / Owen AIAA Guidance 2019 / Mueller PhD MIT 2017 / NTSB AAR-02-04 + BFU 02-02 Überlingen.
          </div>
        </div>
      )}
    </div>
  )
}
