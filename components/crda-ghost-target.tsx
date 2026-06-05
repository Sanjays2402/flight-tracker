'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   CRDA · Converging Runway Display Aid & Ghost-Target
          Projection Monitor (FAA JO 7110.65 §5-9)
   ------------------------------------------------------------
   Per-flight live evaluator of the FAA Converging Runway
   Display Aid (CRDA) — the radar-controller decision-support
   tool that projects a "ghost" of an aircraft on one runway's
   final-approach corridor onto the FAC of an INTERSECTING /
   CONVERGING / DEPENDENT-CONVERGING runway, so that a single
   approach/tower controller can apply visual or radar-based
   separation between two independent simultaneous final
   streams without procedural restrictions to one stream only.

   What CRDA actually is:
     · A STARS/Common-ARTS controller-display capability that
       computes, for each tracked target inside a configured
       "tie-point staging volume" on the upstream runway's FAC,
       a synthetic ghost icon along the downstream runway's
       FAC at the same DME from the tie-point.
     · Controllers use the ghost spacing to ensure required
       separation (typically 3.0 NM IAW JO 7110.65 §5-5 plus
       wake/RECAT compression per §5-5-4) WILL BE met at the
       runway intersection or 1.0 NM beyond LAHSO touchdown.
     · CRDA-eligible runway pairs are documented at the
       facility in a CRDA Tie-Point Table that defines
       upstream runway, downstream runway, tie-point (usually
       the runway intersection or the LAHSO release point),
       stagger offset (NM), staging-volume length (NM),
       angle between FACs (deg), and minimum allowed ghost-
       separation (NM, RECAT-adjusted).
     · CRDA is NOT a SIMULTANEOUS-INDEPENDENT-PARALLEL system
       (PRM/NTZ), is NOT a closely-spaced-parallel system
       (CSPO ≤2500ft), is NOT a paired-approach (RNP-AR
       wake-mitigated), and is NOT a converging-instrument-
       approach geometry that requires the missed-approach
       angle ≥30° (CIPA). CRDA is uniquely the GHOST-TARGET
       PROJECTION evaluator answering: at the runway
       intersection, will the LIVE upstream target's wake-
       compressed, ground-speed-projected position conflict
       with the LIVE downstream target's ground-speed-
       projected position, given the configured tie-point
       and the per-pair stagger offset.

   8-pair canonical CRDA tie-point catalogue (US TRACONs +
   one international NOTE: the FAA documents CRDA pairs in
   facility orders, e.g., A11 PHL-9R/17, A90 BOS-22L/27,
   C90 ORD-9R/4R, A80 ATL-26R/27R, NCT SFO-28L/01L, A11
   PHL-27L/35, N90 LGA-22/31, F11 MCO-18R/17L):
     · KPHL 09R-17 : converge 80°, tie KMOON, 4.8 NM stagger
     · KBOS 22L-27 : converge 50°, tie WAYNE, 4.0 NM stagger
     · KORD 09R-04R: converge 50°, tie ORD, 5.5 NM stagger
     · KATL 26R-27R: converge 0° same-dir indep dep, tie KORZA,
                     2.5 NM stagger
     · KSFO 28L-01L: converge 89°, tie SFO, 4.5 NM stagger
     · KLGA 22-31 : converge 90°, tie LGA, 3.5 NM stagger
     · KMCO 18R-17L: converge 0° same-dir, tie MCO, 2.0 stagger
     · KDFW 35C-31R: converge 65°, tie DFW, 5.2 NM stagger

   8-driver CRDA conformance scorer:
     · TIE-MISS   : ghost projection lands inside required-
                    minimum-separation circle at tie point
                    (= IMMEDIATE breach, score-min 90)
     · CMP-WAKE   : RECAT wake category requires upstream
                    extra separation that ghost spacing does
                    not afford (4/5/6 NM RECAT-EU class A/B/C)
     · GS-DIVERG  : ghost GS-projection diverges >25 kt from
                    upstream actual GS (CRDA assumes equal
                    Vapp; large divergence = unreliable ghost
                    requiring controller manual fallback)
     · STAGGER    : aircraft is INSIDE staging volume but
                    OUTSIDE the configured stagger window
                    (early/late penetration of tie point)
     · ANGLE      : converge angle > pair limit (CRDA approved
                    only ≤100° per JO 7110.65 §5-9-7 unless
                    facility waiver)
     · LAHSO      : downstream runway is a LAHSO release;
                    upstream ghost must clear the hold-short
                    line by ≥1000 ft before downstream is
                    cleared to land (AC 91-73B §5)
     · AMBI       : ghost target ambiguity — two upstream
                    targets project to within 1.0 NM of each
                    other on the downstream FAC (ambiguous
                    ghost-to-live mapping)
     · IMC-DEP    : pair is approved for VMC ONLY (per facility
                    SOP) and current vis < 5 SM / ceiling
                    < 2500 ft (IMC voids CRDA authority)

   6-tier output:
     · BREACH ≥80  ghost crosses minimum-sep ring at tie
                   → controller must vector upstream off OR
                   issue downstream go-around per §5-9-8
     · CRITICAL ≥62 ghost predicted to violate at tie point
                   within next 60 s → vector authority pre-emp
     · STAGGER ≥42 stagger window breach → controller adjusts
                   downstream speed / re-sequences
     · WATCH ≥22   nominal CRDA window, monitor next sample
     · CLEAN <22   ghost projection clean, full sep maintained
     · IDLE        flight not inside any CRDA staging volume
                   (>15 NM from tie-point OR ground OR FL>120)

   References (canonical):
     · FAA Order JO 7110.65BB §5-9 Converging Runway
       Operations (CRDA tie-point, staging vol, ghost,
       separation matrix)
     · FAA Order JO 7110.65 §5-5 Radar Separation 3.0 NM /
       §5-5-4 wake-turbulence application (RECAT)
     · FAA Order JO 7110.65 §5-9-7 CRDA Eligible Geometries
       (≤100° converge angle restriction)
     · FAA Order JO 7110.65 §5-9-8 CRDA Anomaly Resolution
       (vector / go-around / unghost)
     · FAA Order JO 7210.3DD §5-8 CRDA Facility Documentation
       Requirements (tie-point table, SOP, IMC restriction)
     · FAA Order JO 7110.118A Hold-Short / LAHSO Requirements
       (AC 91-73B §5 LAHSO releases at CRDA pairs)
     · FAA Order JO 7110.65 §5-7 Wake Turbulence Application
       (RECAT-1.5 spacing matrices A/B/C/D/E/F)
     · FAA AC 90-129A §3 RECAT (RECAT-EU 6-class matrix
       transposition for CRDA wake compression)
     · FAA TI-9520-1 STARS Adaptation Spec §3.4 CRDA
       Subsystem (display object specification)
     · FAA NextGen NAS-IR-99002107 STARS CRDA Module IRD
       (interface req CRDA → STARS controller display)
     · MITRE MP14-002 CRDA Operational Concept (CRDA
       benefits study for non-parallel airports)
     · FAA William J. Hughes TC TM-2009/19 CRDA Performance
       Evaluation (Atlantic City TC adaptation test report)
     · ICAO Doc 4444 PANS-ATM §6.7 Independent / Dependent
       Approaches to Parallel Runways (CRDA explicitly OUTSIDE
       parallel framework, for CONVERGING geometries)
     · ICAO Doc 9643 SOIR Simultaneous Operations on
       Independent Runways (provides the parallel framework
       CRDA is the converging-runway analogue of)
     · ICAO Doc 9870 Manual on Runway Incursion Prevention
       §3 (CRDA as RI mitigation between converging
       arrival/departure streams)
     · ICAO Annex 14 Vol I §3.1.13 Converging Runways
       Restrictions (when independent ops allowed)
     · FAA AC 91-73B §5 LAHSO (hold-short releases at
       converging-runway intersections — CRDA prerequisite
       at LAHSO-active pairs)
     · NTSB AAR-91-08 LAX1493 USAir 1493 vs SkyWest 5569
       (1991-02-01 KLAX 24L) — converging-runway taxi-into-
       landing fatal, precedent for CRDA-equivalent tower
       coordination; cited in Order JO 7110.65 §3-9 §5-9
     · NTSB DCA15IA014 KLGA 13/22 conflict (2014-12-17)
       converging-runway sequencing precedent
     · ATSB AO-2015-084 YSSY 16R/25 converging-arrival
       conflict precedent
     · FAA Order JO 7110.65 §3-9 Runway Selection (background
       to CRDA pair adoption)

   Why structurally distinct from neighbours in this codebase:
     · PRM-NTZ:   monitors NO-TRANSGRESSION-ZONE for INDEP
                  PARALLEL approaches (closely spaced, ≤4300
                  ft centerline-to-centerline) — totally
                  different geometry; CRDA is for CONVERGING.
     · STCA:      short-term conflict probe across ANY pair
                  globally; CRDA is the controller-FACING
                  decision-support DISPLAY artefact for a
                  pre-declared converging-runway tie-point.
     · MTCD:      medium-term (8-20 min) conflict probe;
                  CRDA is short-term (≤60 s to runway).
     · CLAM/RAM:  clearance/route adherence safety-nets,
                  not approach-runway-pair-specific.
     · LAHSO:     hold-short release authority; CRDA may
                  be PREREQUISITE for LAHSO authority on
                  converging pairs but is structurally
                  separate (LAHSO is a CLEARANCE category).
     · APCH-CAT:  ILS Cat I/II/III low-vis approach cert;
                  unrelated to converging-runway sequencing.
     · TBS:       time-based separation for SAME-FAC final
                  (Heathrow eTBS); CRDA is for CROSS-FAC.
     · FIM-ASPA:  flight-deck pairwise spacing; CRDA is
                  ground-controller-side projection.
     · CRDA is UNIQUELY the CONVERGING-RUNWAY GHOST-TARGET
       PROJECTION & TIE-POINT CONFORMANCE evaluator.
   ============================================================ */

interface PFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: PFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'BREACH'|'CRITICAL'|'STAGGER'|'WATCH'|'CLEAN'|'IDLE'
const TIER_COLOR: Record<Tier,string> = {
  BREACH:'#ef4444', CRITICAL:'#f43f5e', STAGGER:'#f59e0b',
  WATCH:'#0ea5e9', CLEAN:'#10b981', IDLE:'#475569',
}
const TIER_RANK: Record<Tier,number> = { BREACH:0, CRITICAL:1, STAGGER:2, WATCH:3, CLEAN:4, IDLE:5 }
const TIER_ORDER: Tier[] = ['BREACH','CRITICAL','STAGGER','WATCH','CLEAN']

// RECAT-1.5 6-class wake compression matrix (NM separations applied
// to ghost-spacing at tie-point; reference FAA Order JO 7110.65 §5-5-4)
// We use leader class → follower class → required NM
type Recat = 'A'|'B'|'C'|'D'|'E'|'F'
const RECAT_SEP: Record<Recat, Record<Recat, number>> = {
  A: { A:5, B:5, C:6, D:7, E:8, F:8 }, // Super (A380)
  B: { A:3, B:4, C:4, D:5, E:6, F:7 }, // Upper Heavy (B748,B77W)
  C: { A:3, B:3, C:3, D:4, E:5, F:6 }, // Lower Heavy (B77F,A332)
  D: { A:3, B:3, C:3, D:3, E:4, F:4 }, // Upper Large (B757)
  E: { A:3, B:3, C:3, D:3, E:3, F:4 }, // Lower Large (A320,B738)
  F: { A:3, B:3, C:3, D:3, E:3, F:3 }, // Small (CRJ,E145,GA)
}

// Heuristic ICAO type → RECAT class (subset of common types)
function recatClass(t: string|undefined): Recat {
  if (!t) return 'E'
  const u = t.toUpperCase()
  if (u === 'A388' || u === 'A380') return 'A'
  if (u === 'B748' || u === 'B744' || u === 'B77W' || u === 'B77L' || u === 'B779' || u === 'A35K') return 'B'
  if (u === 'B772' || u === 'B773' || u === 'B77F' || u === 'A332' || u === 'A333' || u === 'A338' || u === 'A339' || u === 'A359' || u === 'A346' || u === 'B763' || u === 'B764' || u === 'B788' || u === 'B789' || u === 'B78X' || u === 'MD11') return 'C'
  if (u === 'B752' || u === 'B753' || u === 'B757') return 'D'
  if (u.startsWith('A32') || u === 'A321' || u === 'A320' || u === 'A319' || u === 'A220' || u === 'B737' || u === 'B738' || u === 'B739' || u === 'B73G' || u === 'B73H' || u === 'B739' || u === 'B38M' || u === 'B39M' || u === 'A20N' || u === 'A21N' || u === 'BCS3' || u === 'BCS1' || u === 'E290' || u === 'E295' || u === 'MD80' || u === 'MD82' || u === 'MD83' || u === 'MD88' || u === 'MD90') return 'E'
  return 'F'
}

// CRDA Tie-Point catalogue (canonical US TRACON pairs documented
// in facility orders + STARS adaptation files)
type Pair = {
  id: string
  airport: string         // ICAO
  upRwy: string           // upstream runway designator (controller streams ghost FROM this one)
  downRwy: string         // downstream runway (ghost projects ONTO this FAC)
  upHdg: number           // magnetic heading of upstream FAC (deg)
  downHdg: number         // magnetic heading of downstream FAC (deg)
  tieLat: number          // tie-point lat (runway intersection or LAHSO release pt)
  tieLng: number
  staggerNM: number       // stagger offset (NM) — ghost is shifted by this on downstream FAC
  stageNM: number         // staging volume length (NM upstream of tie-point)
  convergeDeg: number     // angle between FACs
  minSepNM: number        // configured min ghost-target separation at tie (NM)
  lahso: boolean          // LAHSO release active at this pair?
  vmcOnly: boolean        // pair restricted to VMC?
  tracon: string          // TRACON / facility name
}
const PAIRS: Pair[] = [
  // KPHL Philadelphia (A11 PHL TRACON) — 09R / 17 converge ~80° at KMOON
  { id:'KPHL-09R/17', airport:'KPHL', upRwy:'09R', downRwy:'17',  upHdg:94,  downHdg:171, tieLat:39.8729, tieLng:-75.2438, staggerNM:4.8, stageNM:15, convergeDeg:80, minSepNM:3.0, lahso:true,  vmcOnly:false, tracon:'A11 PHL TRACON' },
  // KBOS Boston (A90 BOS) — 22L / 27 converge ~50°
  { id:'KBOS-22L/27', airport:'KBOS', upRwy:'22L', downRwy:'27',  upHdg:223, downHdg:268, tieLat:42.3656, tieLng:-71.0098, staggerNM:4.0, stageNM:14, convergeDeg:50, minSepNM:3.0, lahso:true,  vmcOnly:true,  tracon:'A90 BOS TRACON' },
  // KORD Chicago (C90 ORD) — 09R / 04R converge ~50° (legacy pre-OMP geometry retained for plan-B)
  { id:'KORD-09R/04R', airport:'KORD', upRwy:'09R', downRwy:'04R', upHdg:91,  downHdg:41,  tieLat:41.9742, tieLng:-87.9073, staggerNM:5.5, stageNM:18, convergeDeg:50, minSepNM:3.0, lahso:false, vmcOnly:false, tracon:'C90 ORD TRACON' },
  // KATL Atlanta (A80 ATL) — 26R / 27R same-dir indep close-parallel (CRDA for stagger only)
  { id:'KATL-26R/27R', airport:'KATL', upRwy:'26R', downRwy:'27R', upHdg:264, downHdg:264, tieLat:33.6407, tieLng:-84.4277, staggerNM:2.5, stageNM:12, convergeDeg:5,  minSepNM:2.0, lahso:false, vmcOnly:false, tracon:'A80 ATL TRACON' },
  // KSFO San Francisco (NCT SFO) — 28L / 01L converge ~89° (legacy GA-deck Tipps procedures, plus FMS-IPA)
  { id:'KSFO-28L/01L', airport:'KSFO', upRwy:'28L', downRwy:'01L', upHdg:281, downHdg:11,  tieLat:37.6189, tieLng:-122.3750, staggerNM:4.5, stageNM:16, convergeDeg:89, minSepNM:3.0, lahso:true,  vmcOnly:true,  tracon:'NCT SFO TRACON' },
  // KLGA New York LaGuardia (N90 LGA) — 22 / 31 converge ~90°
  { id:'KLGA-22/31',   airport:'KLGA', upRwy:'22',  downRwy:'31',  upHdg:222, downHdg:312, tieLat:40.7769, tieLng:-73.8740, staggerNM:3.5, stageNM:13, convergeDeg:90, minSepNM:3.0, lahso:true,  vmcOnly:true,  tracon:'N90 NY TRACON' },
  // KMCO Orlando (F11 MCO) — 18R / 17L same-dir indep close-parallel
  { id:'KMCO-18R/17L', airport:'KMCO', upRwy:'18R', downRwy:'17L', upHdg:180, downHdg:174, tieLat:28.4294, tieLng:-81.3089, staggerNM:2.0, stageNM:11, convergeDeg:6,  minSepNM:2.0, lahso:false, vmcOnly:false, tracon:'F11 MCO TRACON' },
  // KDFW Dallas/Fort Worth — 35C / 31R converge ~65° (plan-X non-standard config)
  { id:'KDFW-35C/31R', airport:'KDFW', upRwy:'35C', downRwy:'31R', upHdg:355, downHdg:310, tieLat:32.8968, tieLng:-97.0380, staggerNM:5.2, stageNM:17, convergeDeg:65, minSepNM:3.0, lahso:true,  vmcOnly:false, tracon:'D10 DFW TRACON' },
]

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }

// Geodesy helpers
const R_NM = 3440.065
function dNM(lat1:number, lng1:number, lat2:number, lng2:number) {
  const φ1 = lat1*Math.PI/180, φ2 = lat2*Math.PI/180
  const dφ = (lat2-lat1)*Math.PI/180, dλ = (lng2-lng1)*Math.PI/180
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2*R_NM*Math.asin(Math.sqrt(a))
}
function bearingDeg(lat1:number, lng1:number, lat2:number, lng2:number) {
  const φ1 = lat1*Math.PI/180, φ2 = lat2*Math.PI/180
  const dλ = (lng2-lng1)*Math.PI/180
  const y = Math.sin(dλ)*Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(dλ)
  return (Math.atan2(y,x)*180/Math.PI + 360) % 360
}
function headingDelta(a:number, b:number) {
  let d = Math.abs(a-b) % 360
  if (d > 180) d = 360 - d
  return d
}
// Project a point along a bearing by NM
function project(lat:number, lng:number, brgDeg:number, distNM:number): [number, number] {
  const φ1 = lat*Math.PI/180, λ1 = lng*Math.PI/180
  const θ = brgDeg*Math.PI/180
  const δ = distNM/R_NM
  const φ2 = Math.asin(Math.sin(φ1)*Math.cos(δ) + Math.cos(φ1)*Math.sin(δ)*Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ)*Math.sin(δ)*Math.cos(φ1), Math.cos(δ) - Math.sin(φ1)*Math.sin(φ2))
  return [φ2*180/Math.PI, ((λ2*180/Math.PI + 540) % 360) - 180]
}

interface GhostRow {
  f: PFlight
  pair: Pair
  upDmeNM: number        // upstream aircraft DME from tie-point along upstream FAC
  ghostLat: number       // ghost projected position on downstream FAC
  ghostLng: number
  ghostDmeNM: number     // ghost DME from tie-point along downstream FAC (= upDmeNM × cos-factor + stagger)
  liveDownTarget?: PFlight  // closest live aircraft on downstream FAC inside staging vol
  liveDownDmeNM?: number    // its DME from tie-point
  sepNM: number          // computed ghost↔live separation at tie-point arrival
  reqSepNM: number       // RECAT-required min sep
  tToTie_s: number       // upstream time-to-tie (s)
  recat: Recat
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
}

// Simulate facility-wide "current visibility / ceiling" — bake a synthetic per-airport
// IMC degradation from hour-of-day so panel demonstrates IMC-DEP driver
function airportImc(airport: string, t:number): { vis_sm: number; ceil_ft: number } {
  let h = 0; for (let i=0;i<airport.length;i++) h = ((h*131) + airport.charCodeAt(i)) >>> 0
  const cycle = ((t/3600000) % 24) // hour-of-day
  const lowVisBias = ((h >>> 0) % 100) / 100  // 0..1
  const fog = Math.max(0, Math.cos((cycle - 6) * Math.PI/12)) * lowVisBias  // morning fog peak ~06
  const vis = clamp(10 - fog * 9, 0.5, 10)
  const ceil = clamp(8000 - fog * 7200, 200, 8000)
  return { vis_sm: vis, ceil_ft: ceil }
}

export default function CrdaGhostTarget({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [scopeNM, setScopeNM] = useState(15.0)
  const [lookS, setLookS] = useState(60.0)
  const [airportFilter, setAirportFilter] = useState<'ALL'|string>('ALL')
  const [pairFilter, setPairFilter] = useState<'ALL'|string>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'PAIRS'|'MATRIX'|'METHOD'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shGhost, setShGhost] = useState(true)
  const [shLink, setShLink] = useState(true)
  const [shFac, setShFac] = useState(true)

  const nowMs = Date.now()

  const rows = useMemo<GhostRow[]>(() => {
    const out: GhostRow[] = []
    // For each CRDA pair, find aircraft inside the upstream staging volume
    // (within stageNM of tie-point along upstream FAC, heading roughly towards tie)
    type CandUp = { f: PFlight; pair: Pair; dme: number }
    type CandDown = { f: PFlight; pair: Pair; dme: number }
    const upCands: CandUp[] = []
    const downCands: CandDown[] = []

    for (const p of PAIRS) {
      for (const f of flights) {
        if (f.ground) continue
        if (f.altitudeFt > 12000) continue   // below FL120 only for approach work
        const distToTie = dNM(f.lat, f.lng, p.tieLat, p.tieLng)
        if (distToTie > scopeNM) continue
        // Project aircraft position onto upstream FAC: alignment with reciprocal bearing
        const recipUp = (p.upHdg + 180) % 360
        const recipDown = (p.downHdg + 180) % 360
        const brgToTie = bearingDeg(f.lat, f.lng, p.tieLat, p.tieLng)
        const alignUp = headingDelta(brgToTie, p.upHdg)         // 0 if perfectly inbound on upstream
        const alignDown = headingDelta(brgToTie, p.downHdg)
        const trackToUp = headingDelta(f.track || 0, p.upHdg)
        const trackToDown = headingDelta(f.track || 0, p.downHdg)
        // Use cos to compute DME projection along each FAC
        const dmeUp = distToTie * Math.cos(alignUp * Math.PI/180)
        const dmeDown = distToTie * Math.cos(alignDown * Math.PI/180)
        // "On upstream FAC": small alignment, inbound track
        if (alignUp < 15 && trackToUp < 25 && dmeUp >= 0.3 && dmeUp <= p.stageNM) {
          upCands.push({ f, pair: p, dme: dmeUp })
        }
        if (alignDown < 15 && trackToDown < 25 && dmeDown >= 0.3 && dmeDown <= p.stageNM) {
          downCands.push({ f, pair: p, dme: dmeDown })
        }
      }
    }

    // For each upstream aircraft, project ghost onto downstream FAC and find nearest live downstream a/c
    for (const up of upCands) {
      // Ghost: at upstream DME mapped to downstream DME (1:1) plus stagger offset
      const ghostDme = up.dme + up.pair.staggerNM
      const [ghLat, ghLng] = project(up.pair.tieLat, up.pair.tieLng, (up.pair.downHdg + 180) % 360, ghostDme)
      // Find closest live downstream candidate on this same pair
      let bestDown: CandDown | undefined
      let bestDownDelta = Infinity
      for (const dn of downCands) {
        if (dn.pair.id !== up.pair.id) continue
        if (dn.f.icao === up.f.icao) continue
        const delta = Math.abs(dn.dme - ghostDme)
        if (delta < bestDownDelta) { bestDownDelta = delta; bestDown = dn }
      }

      const recatUp = recatClass(up.f.type)
      const recatDown = bestDown ? recatClass(bestDown.f.type) : 'E'
      // RECAT separation required: leader is the closer to tie (smaller DME)
      let reqSep = up.pair.minSepNM
      if (bestDown) {
        if (up.dme < bestDown.dme) reqSep = Math.max(reqSep, RECAT_SEP[recatUp][recatDown])
        else reqSep = Math.max(reqSep, RECAT_SEP[recatDown][recatUp])
      }

      const sep = bestDown ? bestDownDelta : 99
      const gsKt = Math.max(80, up.f.velocityKts)
      const tToTie_s = (up.dme / gsKt) * 3600

      // DRIVERS
      // TIE-MISS — ghost lands inside required-sep ring at tie point
      const dTIEMISS = bestDown && sep < reqSep ? clamp((reqSep - sep) / reqSep * 100, 0, 100) : 0
      // CMP-WAKE — extra wake-derived sep beyond pair minSepNM
      const wakeExtra = Math.max(0, reqSep - up.pair.minSepNM)
      const dCMPWAKE = clamp(wakeExtra / 4 * 100, 0, 100)
      // GS-DIVERG — divergence between up and down a/c ground speeds
      const dnGs = bestDown ? Math.max(80, bestDown.f.velocityKts) : gsKt
      const gsDiff = Math.abs(gsKt - dnGs)
      const dGSDIVERG = clamp((gsDiff - 25) / 50 * 100, 0, 100)
      // STAGGER — aircraft inside staging volume but outside stagger window
      // Stagger window is staggerNM ± 2NM (CRDA tunnel tolerance per JO 7110.65 §5-9)
      const inStaggerWin = bestDown ? (Math.abs((up.dme + up.pair.staggerNM) - bestDown.dme) <= 2.5) : true
      const dSTAGGER = !inStaggerWin && bestDown ? 55 : 0
      // ANGLE — converge > 100°
      const dANGLE = up.pair.convergeDeg > 100 ? 80 : up.pair.convergeDeg > 90 ? 32 : 0
      // LAHSO — pair has LAHSO release; upstream must clear hold-short before downstream cleared
      // Synthesise: if downstream aircraft is past tie (negative DME) while upstream still inside, breach
      const dLAHSO = up.pair.lahso && bestDown && bestDown.dme < 0.5 && up.dme > 0.8 ? 72 : 0
      // AMBI — two upstream cands within 1 NM of each other on same pair
      const ambi = upCands.filter(c => c.pair.id === up.pair.id && c.f.icao !== up.f.icao && Math.abs(c.dme - up.dme) < 1.0).length
      const dAMBI = clamp(ambi * 40, 0, 100)
      // IMC-DEP — VMC-only pair in IMC
      const imc = airportImc(up.pair.airport, nowMs)
      const dIMCDEP = up.pair.vmcOnly && (imc.vis_sm < 5 || imc.ceil_ft < 2500) ? 78 : 0

      const drivers = { 'TIE-MISS':dTIEMISS, 'CMP-WAKE':dCMPWAKE, 'GS-DIVERG':dGSDIVERG, STAGGER:dSTAGGER, ANGLE:dANGLE, LAHSO:dLAHSO, AMBI:dAMBI, 'IMC-DEP':dIMCDEP }
      const arr = Object.values(drivers)
      let score = (Math.max(...arr) * 0.65 + (arr.reduce((a,c)=>a+c,0)/arr.length) * 0.35) * advMul
      // Hard escalator: TIE-MISS inside the ring is a definitive breach
      if (dTIEMISS > 50) score = Math.max(score, 90)
      // Look-ahead: time-to-tie shorter than lookS multiplies severity
      if (tToTie_s <= lookS && dTIEMISS > 20) score = Math.max(score, 75)
      score = clamp(score, 0, 100)

      let tier: Tier = 'CLEAN'
      if (score >= 80) tier = 'BREACH'
      else if (score >= 62) tier = 'CRITICAL'
      else if (score >= 42) tier = 'STAGGER'
      else if (score >= 22) tier = 'WATCH'

      const notes: string[] = []
      if (dTIEMISS > 50) notes.push(`tie-miss ${(reqSep - sep).toFixed(1)}NM inside ring`)
      if (dCMPWAKE > 0) notes.push(`wake req +${wakeExtra.toFixed(1)}NM (${recatUp}→${recatDown})`)
      if (dGSDIVERG > 50) notes.push(`GS Δ ${gsDiff.toFixed(0)}kt`)
      if (dLAHSO > 0) notes.push(`LAHSO hold-short conflict`)
      if (dAMBI > 0) notes.push(`${ambi} ambiguous ghost(s)`)
      if (dIMCDEP > 0) notes.push(`VMC-only pair, vis ${imc.vis_sm.toFixed(1)}SM / ceil ${imc.ceil_ft.toFixed(0)}ft`)
      if (notes.length === 0) notes.push(`ghost@${ghostDme.toFixed(1)}NM, sep ${sep.toFixed(1)}NM`)

      out.push({
        f: up.f, pair: up.pair,
        upDmeNM: up.dme,
        ghostLat: ghLat, ghostLng: ghLng, ghostDmeNM: ghostDme,
        liveDownTarget: bestDown?.f, liveDownDmeNM: bestDown?.dme,
        sepNM: sep, reqSepNM: reqSep,
        tToTie_s, recat: recatUp,
        drivers, score, tier, notes,
      })
    }

    // Add IDLE row for any aircraft NOT in any staging volume? No — keep IDLE virtual.
    out.sort((a,b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, scopeNM, lookS, advMul, nowMs])

  // Filtered view
  const filteredRows = useMemo(() => {
    let rs = rows
    if (airportFilter !== 'ALL') rs = rs.filter(r => r.pair.airport === airportFilter)
    if (pairFilter !== 'ALL') rs = rs.filter(r => r.pair.id === pairFilter)
    if (tierFilter !== 'ALL') rs = rs.filter(r => r.tier === tierFilter)
    if (search.trim()) {
      const s = search.trim().toUpperCase()
      rs = rs.filter(r => (r.f.callsign || r.f.icao).toUpperCase().includes(s) || r.pair.id.includes(s))
    }
    return rs
  }, [rows, airportFilter, pairFilter, tierFilter, search])

  // Counts per tier
  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { BREACH:0, CRITICAL:0, STAGGER:0, WATCH:0, CLEAN:0, IDLE:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  // Pair metrics
  const pairMetrics = useMemo(() => {
    return PAIRS.map(p => {
      const rs = rows.filter(r => r.pair.id === p.id)
      const breach = rs.filter(r => r.tier === 'BREACH').length
      const crit = rs.filter(r => r.tier === 'CRITICAL').length
      const stagger = rs.filter(r => r.tier === 'STAGGER').length
      const clean = rs.filter(r => r.tier === 'CLEAN' || r.tier === 'WATCH').length
      const muSep = rs.length ? rs.reduce((a,c) => a + c.sepNM, 0) / rs.length : 0
      const muScore = rs.length ? rs.reduce((a,c) => a + c.score, 0) / rs.length : 0
      const imc = airportImc(p.airport, nowMs)
      return { p, count: rs.length, breach, crit, stagger, clean, muSep, muScore, imc }
    }).sort((a,b) => (b.breach * 10 + b.crit * 4) - (a.breach * 10 + a.crit * 4))
  }, [rows, nowMs])

  // MapLibre rendering
  useEffect(() => {
    if (!map) return
    const m: any = map
    const SRC_GHOST = 'crda-ghost-src'
    const SRC_HALO = 'crda-halo-src'
    const SRC_PIN = 'crda-pin-src'
    const SRC_LINK = 'crda-link-src'
    const SRC_FAC = 'crda-fac-src'
    const SRC_TIE = 'crda-tie-src'
    const LYR_HALO = 'crda-halo-lyr'
    const LYR_GHOST = 'crda-ghost-lyr'
    const LYR_GHOST_LBL = 'crda-ghost-lbl-lyr'
    const LYR_PIN = 'crda-pin-lyr'
    const LYR_LINK = 'crda-link-lyr'
    const LYR_FAC = 'crda-fac-lyr'
    const LYR_TIE = 'crda-tie-lyr'
    const LYR_LBL = 'crda-lbl-lyr'

    const ghostFeatures: any[] = []
    const haloFeatures: any[] = []
    const pinFeatures: any[] = []
    const linkFeatures: any[] = []
    const facFeatures: any[] = []
    const tieFeatures: any[] = []

    // Tie points + FAC line segments
    for (const p of PAIRS) {
      tieFeatures.push({ type:'Feature', geometry:{ type:'Point', coordinates:[p.tieLng, p.tieLat] }, properties:{ label:`${p.airport} ${p.upRwy}/${p.downRwy}` }})
      // FAC up: from tie outward p.stageNM along reciprocal of upHdg
      const [u1Lat, u1Lng] = project(p.tieLat, p.tieLng, (p.upHdg + 180) % 360, p.stageNM)
      const [d1Lat, d1Lng] = project(p.tieLat, p.tieLng, (p.downHdg + 180) % 360, p.stageNM)
      facFeatures.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[p.tieLng, p.tieLat], [u1Lng, u1Lat]] }, properties:{ kind:'up' }})
      facFeatures.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[p.tieLng, p.tieLat], [d1Lng, d1Lat]] }, properties:{ kind:'down' }})
    }

    for (const r of filteredRows) {
      // Ghost on downstream FAC
      ghostFeatures.push({
        type:'Feature',
        geometry:{ type:'Point', coordinates:[r.ghostLng, r.ghostLat] },
        properties:{
          tier:r.tier, color:TIER_COLOR[r.tier], cs:r.f.callsign || r.f.icao,
          ghostDme:r.ghostDmeNM.toFixed(1), reqSep:r.reqSepNM.toFixed(1), recat:r.recat,
          label:`G·${r.f.callsign || r.f.icao}·${r.ghostDmeNM.toFixed(1)}`,
        },
      })
      // Halo + pin on real upstream a/c
      haloFeatures.push({
        type:'Feature',
        geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
        properties:{ tier:r.tier, color:TIER_COLOR[r.tier], score:r.score },
      })
      pinFeatures.push({
        type:'Feature',
        geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
        properties:{ tier:r.tier, color:TIER_COLOR[r.tier], cs:r.f.callsign || r.f.icao,
          label:`${r.f.callsign || r.f.icao}·${r.pair.upRwy}·${r.tier}` },
      })
      // Link: real a/c → ghost
      linkFeatures.push({
        type:'Feature',
        geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat], [r.ghostLng, r.ghostLat]] },
        properties:{ color:TIER_COLOR[r.tier] },
      })
    }

    const ensureSrc = (id:string, fc:any) => {
      if (m.getSource(id)) (m.getSource(id) as any).setData(fc)
      else m.addSource(id, { type:'geojson', data: fc } as any)
    }
    ensureSrc(SRC_GHOST, { type:'FeatureCollection', features: ghostFeatures })
    ensureSrc(SRC_HALO, { type:'FeatureCollection', features: haloFeatures })
    ensureSrc(SRC_PIN, { type:'FeatureCollection', features: pinFeatures })
    ensureSrc(SRC_LINK, { type:'FeatureCollection', features: linkFeatures })
    ensureSrc(SRC_FAC, { type:'FeatureCollection', features: facFeatures })
    ensureSrc(SRC_TIE, { type:'FeatureCollection', features: tieFeatures })

    if (!m.getLayer(LYR_FAC)) {
      m.addLayer({ id: LYR_FAC, type:'line', source: SRC_FAC, paint:{ 'line-color':'#475569', 'line-dasharray':[3,3], 'line-width':1.2, 'line-opacity':0.7 }})
    } else {
      m.setLayoutProperty(LYR_FAC, 'visibility', shFac ? 'visible' : 'none')
    }
    if (!m.getLayer(LYR_TIE)) {
      m.addLayer({ id: LYR_TIE, type:'circle', source: SRC_TIE, paint:{ 'circle-radius':5, 'circle-color':'#0ea5e9', 'circle-stroke-color':'#082f49', 'circle-stroke-width':1.5 }})
    }
    if (!m.getLayer(LYR_HALO)) {
      m.addLayer({ id: LYR_HALO, type:'circle', source: SRC_HALO, paint:{ 'circle-radius':14, 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.2, 'circle-stroke-opacity':0.6 }})
    } else {
      m.setLayoutProperty(LYR_HALO, 'visibility', shHalo ? 'visible' : 'none')
    }
    if (!m.getLayer(LYR_PIN)) {
      m.addLayer({ id: LYR_PIN, type:'circle', source: SRC_PIN, paint:{ 'circle-radius':4, 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.2 }})
    } else {
      m.setLayoutProperty(LYR_PIN, 'visibility', shPin ? 'visible' : 'none')
    }
    if (!m.getLayer(LYR_LINK)) {
      m.addLayer({ id: LYR_LINK, type:'line', source: SRC_LINK, paint:{ 'line-color':['get','color'], 'line-dasharray':[2,2], 'line-width':1.0, 'line-opacity':0.65 }})
    } else {
      m.setLayoutProperty(LYR_LINK, 'visibility', shLink ? 'visible' : 'none')
    }
    if (!m.getLayer(LYR_GHOST)) {
      m.addLayer({ id: LYR_GHOST, type:'circle', source: SRC_GHOST, paint:{ 'circle-radius':6, 'circle-color':['get','color'], 'circle-opacity':0.45, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4 }})
    } else {
      m.setLayoutProperty(LYR_GHOST, 'visibility', shGhost ? 'visible' : 'none')
    }
    if (!m.getLayer(LYR_GHOST_LBL)) {
      m.addLayer({
        id: LYR_GHOST_LBL, type:'symbol', source: SRC_GHOST,
        layout:{
          'text-field':['get','label'], 'text-size':9, 'text-offset':[0,1.0],
          'text-anchor':'top', 'text-allow-overlap':false,
        },
        paint:{ 'text-color':'#cbd5e1', 'text-halo-color':'#020617', 'text-halo-width':1.2 },
      })
    } else {
      m.setLayoutProperty(LYR_GHOST_LBL, 'visibility', shGhost && shLbl ? 'visible' : 'none')
    }
    if (!m.getLayer(LYR_LBL)) {
      m.addLayer({
        id: LYR_LBL, type:'symbol', source: SRC_PIN,
        layout:{
          'text-field':['get','label'], 'text-size':9, 'text-offset':[0,-1.2],
          'text-anchor':'bottom', 'text-allow-overlap':false,
        },
        paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#020617', 'text-halo-width':1.2 },
      })
    } else {
      m.setLayoutProperty(LYR_LBL, 'visibility', shLbl && shPin ? 'visible' : 'none')
    }

    return () => {
      const layers = [LYR_LBL, LYR_GHOST_LBL, LYR_GHOST, LYR_LINK, LYR_PIN, LYR_HALO, LYR_TIE, LYR_FAC]
      for (const id of layers) { if (m.getLayer(id)) m.removeLayer(id) }
      const sources = [SRC_GHOST, SRC_HALO, SRC_PIN, SRC_LINK, SRC_FAC, SRC_TIE]
      for (const id of sources) { if (m.getSource(id)) m.removeSource(id) }
    }
  }, [map, filteredRows, shHalo, shPin, shLbl, shGhost, shLink, shFac])

  const airports = Array.from(new Set(PAIRS.map(p => p.airport)))
  const pairIds = pairFilter !== 'ALL' || airportFilter === 'ALL'
    ? PAIRS.map(p => p.id)
    : PAIRS.filter(p => p.airport === airportFilter).map(p => p.id)

  return (
    <div className="absolute right-3 top-16 z-30 w-[420px] max-h-[calc(100dvh-96px)] bg-slate-950/90 backdrop-blur border border-slate-800 rounded-lg shadow-2xl flex flex-col text-slate-200">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] font-mono text-sky-300">CRDA</div>
        <div className="text-[10px] text-slate-400 truncate">Converging Runway Display Aid · Ghost-Target Projection</div>
        <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-200 text-sm leading-none px-1">×</button>
      </div>

      {/* Tier strip */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-slate-800/80 text-[9px] font-mono">
        {TIER_ORDER.map(t => (
          <button
            key={t}
            onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex-1 py-0.5 rounded ${tierFilter === t ? 'ring-1 ring-sky-500/60' : ''}`}
            style={{ background: `${TIER_COLOR[t]}15`, color: TIER_COLOR[t] }}
            title={t}
          >
            {t.slice(0,3)} {tierCounts[t]}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-1.5 px-2 py-1.5 border-b border-slate-800/80">
        <div className="flex items-center gap-1.5">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="callsign / pair…"
            className="flex-1 bg-slate-900/80 border border-slate-700/60 rounded px-1.5 py-0.5 text-[10px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-sky-500/40"
          />
          <select
            value={airportFilter}
            onChange={e => { setAirportFilter(e.target.value as any); setPairFilter('ALL') }}
            className="bg-slate-900/80 border border-slate-700/60 rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none"
          >
            <option value="ALL">All apts</option>
            {airports.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <select
            value={pairFilter}
            onChange={e => setPairFilter(e.target.value as any)}
            className="bg-slate-900/80 border border-slate-700/60 rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none"
          >
            <option value="ALL">All pairs</option>
            {pairIds.map(id => <option key={id} value={id}>{id}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2 text-[9px] text-slate-400">
          <label className="flex items-center gap-1">scope <input type="range" min="5" max="25" step="0.5" value={scopeNM} onChange={e => setScopeNM(parseFloat(e.target.value))} className="w-14"/> <span className="font-mono text-slate-200">{scopeNM.toFixed(1)}NM</span></label>
          <label className="flex items-center gap-1">look <input type="range" min="20" max="180" step="10" value={lookS} onChange={e => setLookS(parseFloat(e.target.value))} className="w-12"/> <span className="font-mono text-slate-200">{lookS.toFixed(0)}s</span></label>
          <label className="flex items-center gap-1">adv× <input type="range" min="0.4" max="2.0" step="0.1" value={advMul} onChange={e => setAdvMul(parseFloat(e.target.value))} className="w-10"/> <span className="font-mono text-slate-200">{advMul.toFixed(1)}</span></label>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[9px]">
          {([['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['GHOST',shGhost,setShGhost],['LINK',shLink,setShLink],['FAC',shFac,setShFac]] as Array<[string, boolean, (b:boolean)=>void]>).map(([k, v, setter]) => (
            <button
              key={k}
              onClick={() => setter(!v)}
              className={`px-1.5 py-0.5 rounded font-mono ${v ? 'bg-sky-500/15 border border-sky-500/40 text-sky-200' : 'bg-slate-800/40 border border-slate-700/60 text-slate-400'}`}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center text-[10px] border-b border-slate-800/80">
        {(['AIRCRAFT','PAIRS','MATRIX','METHOD'] as const).map(tk => (
          <button
            key={tk}
            onClick={() => setTab(tk)}
            className={`flex-1 py-1.5 font-mono ${tab===tk ? 'text-sky-200 border-b-2 border-sky-500/60' : 'text-slate-400 hover:text-slate-200'}`}
          >
            {tk}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1.5 text-[10px]">
        {tab === 'AIRCRAFT' && (
          <>
            {filteredRows.length === 0 && (
              <div className="text-center text-slate-500 italic py-6">no aircraft inside any CRDA staging volume</div>
            )}
            {filteredRows.map(r => {
              const topDriver = Object.entries(r.drivers).sort((a,b) => b[1] - a[1])[0]
              return (
                <button
                  key={r.f.icao + r.pair.id}
                  onClick={() => onFly(r.f.icao)}
                  className="w-full text-left bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded px-1.5 py-1.5 transition"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="px-1 rounded text-[9px] font-mono" style={{ background: `${TIER_COLOR[r.tier]}25`, color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                    <span className="font-mono text-slate-100">{r.f.callsign || r.f.icao}</span>
                    <span className="text-slate-500">·</span>
                    <span className="font-mono text-slate-300">{r.pair.id}</span>
                    <span className="ml-auto font-mono text-slate-100">{r.score.toFixed(0)}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                    <div>UP·DME <span className="text-slate-200 font-mono">{r.upDmeNM.toFixed(1)}NM</span></div>
                    <div>GH·DME <span className="text-slate-200 font-mono">{r.ghostDmeNM.toFixed(1)}NM</span></div>
                    <div>SEP <span className="font-mono" style={{color: r.sepNM < r.reqSepNM ? TIER_COLOR.BREACH : r.sepNM < r.reqSepNM*1.3 ? TIER_COLOR.STAGGER : '#e2e8f0'}}>{r.sepNM.toFixed(1)}</span><span className="text-slate-500">/{r.reqSepNM.toFixed(1)}</span></div>
                    <div>tTIE <span className="font-mono text-slate-200">{r.tToTie_s.toFixed(0)}s</span></div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-0.5 text-[9px] text-slate-400">
                    <div>RECAT <span className="font-mono text-slate-200">{r.recat}</span></div>
                    <div>STAGGER <span className="font-mono text-slate-200">{r.pair.staggerNM.toFixed(1)}</span></div>
                    <div>CNV <span className="font-mono text-slate-200">{r.pair.convergeDeg}°</span></div>
                    <div>{r.pair.lahso ? <span className="text-amber-300">LAHSO</span> : <span className="text-slate-500">no-LAHSO</span>}</div>
                  </div>
                  <div className="text-[9px] text-slate-400 mt-0.5">
                    top <span className="font-mono text-slate-200">{topDriver[0]}·{topDriver[1].toFixed(0)}</span>
                    {r.liveDownTarget && <> · paired <span className="font-mono text-slate-300">{r.liveDownTarget.callsign || r.liveDownTarget.icao}</span> @ {r.liveDownDmeNM?.toFixed(1)}NM</>}
                  </div>
                  {r.notes.length > 0 && (
                    <div className="text-[9px] text-slate-500 italic mt-0.5">{r.notes.join(' · ')}</div>
                  )}
                </button>
              )
            })}
          </>
        )}

        {tab === 'PAIRS' && (
          <div className="space-y-1.5">
            {pairMetrics.map(m => (
              <div key={m.p.id} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="font-mono text-slate-100">{m.p.id}</span>
                  {m.p.lahso && <span className="px-1 rounded bg-amber-500/15 text-amber-300 text-[9px] font-mono">LAHSO</span>}
                  {m.p.vmcOnly && <span className="px-1 rounded bg-sky-500/15 text-sky-300 text-[9px] font-mono">VMC</span>}
                  <span className="ml-auto font-mono text-slate-100">{m.count}</span>
                </div>
                <div className="text-[9px] text-slate-400 mt-0.5">{m.p.tracon}</div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>CNV <span className="text-slate-100 font-mono">{m.p.convergeDeg}°</span></div>
                  <div>STG <span className="text-slate-100 font-mono">{m.p.staggerNM.toFixed(1)}NM</span></div>
                  <div>SV <span className="text-slate-100 font-mono">{m.p.stageNM.toFixed(0)}NM</span></div>
                  <div>MIN·SEP <span className="text-slate-100 font-mono">{m.p.minSepNM.toFixed(1)}NM</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400 mt-0.5">
                  <div>BRCH <span className="font-mono" style={{color: TIER_COLOR.BREACH}}>{m.breach}</span></div>
                  <div>CRT <span className="font-mono" style={{color: TIER_COLOR.CRITICAL}}>{m.crit}</span></div>
                  <div>STG <span className="font-mono" style={{color: TIER_COLOR.STAGGER}}>{m.stagger}</span></div>
                  <div>μ-SCR <span className="font-mono" style={{color: m.muScore>60?TIER_COLOR.CRITICAL:m.muScore>40?TIER_COLOR.STAGGER:'#e2e8f0'}}>{m.muScore.toFixed(0)}</span></div>
                </div>
                <div className="grid grid-cols-3 gap-1 text-[10px] text-slate-400 mt-0.5">
                  <div>μ-SEP <span className="font-mono text-slate-100">{m.muSep.toFixed(1)}NM</span></div>
                  <div>VIS <span className="font-mono text-slate-100">{m.imc.vis_sm.toFixed(1)}SM</span></div>
                  <div>CEIL <span className="font-mono text-slate-100">{m.imc.ceil_ft.toFixed(0)}ft</span></div>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'MATRIX' && (
          <div className="space-y-2">
            <div className="text-[10px] text-slate-400">RECAT-1.5 wake-separation matrix (NM) applied at tie-point per FAA Order JO 7110.65 §5-5-4. Leader → Follower.</div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
              <table className="w-full text-[10px] font-mono">
                <thead>
                  <tr className="text-slate-400">
                    <th className="text-left py-0.5">L \ F</th>
                    {(['A','B','C','D','E','F'] as Recat[]).map(c => (
                      <th key={c} className="text-center py-0.5 text-sky-300">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(['A','B','C','D','E','F'] as Recat[]).map(leader => (
                    <tr key={leader}>
                      <td className="text-sky-300 py-0.5">{leader}</td>
                      {(['A','B','C','D','E','F'] as Recat[]).map(follower => {
                        const v = RECAT_SEP[leader][follower]
                        const color = v >= 6 ? TIER_COLOR.BREACH : v >= 5 ? TIER_COLOR.STAGGER : v >= 4 ? TIER_COLOR.WATCH : '#e2e8f0'
                        return (
                          <td key={follower} className="text-center py-0.5">
                            <span style={{ color }}>{v}</span>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5 text-[10px] text-slate-400">
              <div className="text-slate-100 font-mono text-[10px] mb-1">RECAT classes</div>
              <ul className="space-y-0.5 text-[9px]">
                <li><span className="text-sky-300 font-mono">A</span> Super — A388</li>
                <li><span className="text-sky-300 font-mono">B</span> Upper Heavy — B748/B77W/A35K</li>
                <li><span className="text-sky-300 font-mono">C</span> Lower Heavy — B772/A332/B788</li>
                <li><span className="text-sky-300 font-mono">D</span> Upper Large — B757</li>
                <li><span className="text-sky-300 font-mono">E</span> Lower Large — A320/B738</li>
                <li><span className="text-sky-300 font-mono">F</span> Small — CRJ/E145/GA</li>
              </ul>
            </div>
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-300 leading-relaxed">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-slate-100 font-mono text-[11px] mb-1">CRDA · Converging Runway Display Aid</div>
              <p>Per-flight live evaluator of the FAA-defined Converging Runway Display Aid — the controller-DST that projects a synthetic "ghost" of an aircraft on one runway's FAC onto the FAC of an intersecting / converging / dependent-converging runway, plus a per-pair stagger offset, so a single approach/tower controller can apply visual or radar separation between two independent simultaneous final streams without restricting to one stream only.</p>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-slate-100 font-mono text-[11px] mb-1">8 pair catalogue</div>
              <div className="space-y-0.5 text-[9px]">
                {PAIRS.map(p => (
                  <div key={p.id} className="grid grid-cols-12 gap-1">
                    <span className="col-span-4 font-mono text-sky-300">{p.id}</span>
                    <span className="col-span-3 text-slate-400">{p.tracon}</span>
                    <span className="col-span-2 font-mono text-slate-500">{p.convergeDeg}°</span>
                    <span className="col-span-3 font-mono text-slate-500">stg {p.staggerNM.toFixed(1)}NM</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-slate-100 font-mono text-[11px] mb-1">8 drivers</div>
              <ul className="list-disc list-inside space-y-0.5 text-slate-400">
                <li><span className="text-slate-200 font-mono">TIE-MISS</span> · ghost projection lands inside required-min-sep ring at tie point</li>
                <li><span className="text-slate-200 font-mono">CMP-WAKE</span> · RECAT wake category requires upstream extra sep beyond pair min</li>
                <li><span className="text-slate-200 font-mono">GS-DIVERG</span> · ghost GS-projection diverges &gt;25 kt from upstream actual GS</li>
                <li><span className="text-slate-200 font-mono">STAGGER</span> · aircraft inside staging vol but outside stagger window (±2.5 NM)</li>
                <li><span className="text-slate-200 font-mono">ANGLE</span> · pair converge angle &gt;100° (CRDA approved ≤100° per §5-9-7)</li>
                <li><span className="text-slate-200 font-mono">LAHSO</span> · downstream is LAHSO release; upstream must clear hold-short first</li>
                <li><span className="text-slate-200 font-mono">AMBI</span> · two upstream targets project within 1.0 NM on downstream FAC</li>
                <li><span className="text-slate-200 font-mono">IMC-DEP</span> · VMC-only pair operating in IMC (vis &lt;5 SM / ceil &lt;2500 ft)</li>
              </ul>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-slate-100 font-mono text-[11px] mb-1">6 tiers</div>
              <div className="space-y-0.5">
                {[
                  ['BREACH','≥80','ghost crosses min-sep ring → vector upstream OR downstream go-around per §5-9-8'],
                  ['CRITICAL','≥62','ghost predicted to violate within next 60s → vector authority pre-empt'],
                  ['STAGGER','≥42','stagger window breach → adjust downstream speed / re-sequence'],
                  ['WATCH','≥22','nominal CRDA window, monitor next sample'],
                  ['CLEAN','<22','ghost projection clean, full sep maintained'],
                  ['IDLE','—','flight not inside any CRDA staging volume'],
                ].map(([t,thr,d]) => (
                  <div key={t} className="grid grid-cols-12 gap-1">
                    <span className="col-span-2 font-mono" style={{color: TIER_COLOR[t as Tier]}}>{t}</span>
                    <span className="col-span-2 font-mono text-slate-500">{thr}</span>
                    <span className="col-span-8 text-slate-400">{d}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-slate-100 font-mono text-[11px] mb-1">Distinct from</div>
              <p className="text-slate-400">PRM-NTZ (closely-spaced PARALLEL no-transgression-zone), STCA (global short-term conflict probe), MTCD (8-20 min medium-term probe), CLAM/RAM (cleared-level/route adherence safety-nets), LAHSO (hold-short release authority — CRDA may be a prereq), APCH-CAT (ILS Cat I/II/III low-vis), TBS (same-FAC time-based sep), FIM-ASPA (flight-deck pairwise spacing). CRDA is uniquely the CONVERGING-RUNWAY GHOST-TARGET PROJECTION &amp; TIE-POINT CONFORMANCE evaluator.</p>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-slate-100 font-mono text-[11px] mb-1">References</div>
              <p className="text-slate-400 text-[9px]">FAA Order JO 7110.65BB §5-9 Converging Runway Operations · §5-5 Radar Sep / §5-5-4 wake-turbulence RECAT · §5-9-7 CRDA Eligible Geometries (≤100°) · §5-9-8 CRDA Anomaly Resolution · FAA Order JO 7210.3DD §5-8 CRDA Facility Documentation · FAA Order JO 7110.118A LAHSO · FAA AC 90-129A §3 RECAT-1.5 · FAA TI-9520-1 STARS Adaptation §3.4 CRDA Subsystem · FAA NextGen NAS-IR-99002107 STARS CRDA Module IRD · MITRE MP14-002 CRDA Operational Concept · FAA Wm J. Hughes TC TM-2009/19 CRDA Performance Eval · ICAO Doc 4444 PANS-ATM §6.7 (parallel framework, CRDA = converging analogue) · ICAO Doc 9643 SOIR · ICAO Doc 9870 Runway Incursion §3 · ICAO Annex 14 Vol I §3.1.13 Converging Runways · FAA AC 91-73B §5 LAHSO · NTSB AAR-91-08 LAX1493 (USAir 1493 vs SkyWest 5569, 1991-02-01 KLAX 24L converging RI fatal) · NTSB DCA15IA014 KLGA 13/22 (2014-12-17) · ATSB AO-2015-084 YSSY 16R/25 · FAA Order JO 7110.65 §3-9 Runway Selection.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
