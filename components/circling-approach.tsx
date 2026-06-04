'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   CIRC · Circling-Approach Protected-Area & Minima Conformance
   ------------------------------------------------------------
   Per-airframe scorer for low-altitude traffic manoeuvring in the
   visual circling segment of an instrument approach, evaluating:

     - Lateral conformment within the ICAO PANS-OPS Vol II circling
       protected-area envelope built from straight segments tangent
       to runway-end arcs of category-radius R (Doc 8168 Vol II
       Pt I §7.3 and the updated radii of §7.3.1 added in Amdt 13
       which decoupled airspace from MDA(H) and added Cat E)
     - TERPS 8260.3D §2.7.3 Table 2-7 expansion radii (1.3/1.5/
       1.7/2.3/4.5 NM for A/B/C/D/E) as the alternative US standard
     - MDA(H)/HCH conformance — circling minima floor with 100-300ft
       buffer per Annex 6 Pt I §4.5.5 / FAA AC 120-108
     - Indicated-airspeed gate by ICAO category (Cat-A ≤100 / B ≤135
       / C ≤180 / D ≤205 / E ≤240) per Doc 8168 Vol I Pt I §4.1.2
     - Bank-angle conformance — max 25° in circling per FAA AC 120-71
       and AC 90-66B; sustained > 30° triggers UNSTABLE
     - Visibility floor — Cat-A 1.5km / B 1.6km / C 2.4km / D 3.6km
       per PANS-OPS Vol I Pt IV — supplied as METAR-vis slider proxy
     - Phase gating — ALT < CIRC-ALT and on a published approach
       fix bearing (extracted from approach axis to runway) inside
       scope filter

   Six risk drivers (composite = max·0.78 + secondaryMean·0.22 · ADV-MUL):

     LAT   lateral excursion outside protected-area boundary
           (linear ramp 0 → 100 over the configured BUF slider)
     ALT   MDA(H) bust — descent below MDA before final-runway
           visual; 0 at on-MDA, 100 at -200ft, hard 100 if below
           runway elev + 200ft
     IAS   speed exceedance vs CAT-max — 0 at on-spec, 100 at
           +25kt over (PANS-OPS Vol I §4.1.2)
     BANK  sustained bank — 0 at ≤25°, 100 at ≥40° via VS-rate
           proxy of |track-rate| × IAS/g
     VIS   reported visibility minus CAT-vis minima — 100 if
           below minima
     PHASE phase-criticality — CIRC 100 / VEC-TO 70 / FAF 55 /
           DIVERSION 30

   Hard tier escalators:
     LAT ≥ 100 outside boundary in CIRC phase            score-min 92
     ALT ≥ 100 below MDA(H) and not yet visual           score-min 88
     BANK ≥ 100 sustained over 30° in turn               score-min 80

   Five hard tiers:
     EXCURSION lateral outside boundary at CIRC alt — rose
       BREAK OFF circling and execute missed approach per
       PANS-OPS Vol II Pt I §7.3 + AC 120-108
     UNSTABLE MDA bust OR sustained bank > 30° — rose-pink
       Go-around per AC 120-108 §6 + FOM stabilised criteria
     PROXIMITY within BUF of boundary OR VIS below minima — amber
       monitor track per Doc 8168 Vol I Pt IV
     WATCH inside scope — sky
     CONFORM nominal — emerald

   18-runway global circling catalogue (one per major airport, the
   one most commonly used for circling-only approaches), tagged with
   threshold lat/lng, runway QFU, runway-elevation, ARP elevation,
   published HAA-circle minima (ft AAL), authority, ICAO-cat-max
   permitted (some are Cat-D capped due to OCS), ruleset:
   PANS-OPS vs TERPS.  Catalogue covers:

     KJFK 13L / KLAX 24R / KSFO 19L / KORD 27L / KATL 26L
     KBOS 33L / KSEA 13R / KDEN 16L / KMDW 31C / KSAN 09
     EGLL 27R / EGKK 26L / EHAM 22 / EDDF 25C / LFPG 26R
     LSZH 14 / OMDB 12L / WSSS 02L

   Each runway has its own protected-area radius set selectable
   by CAT (A-E).  The circling area is the union of arcs of radius
   R centred on each runway end, joined by tangent lines (the
   classical "race-track" envelope per PANS-OPS).

   References:
     ICAO Doc 8168 PANS-OPS Vol I Pt I §4.1.2 categorisation
     ICAO Doc 8168 PANS-OPS Vol I Pt IV §1 circling approach
     ICAO Doc 8168 PANS-OPS Vol II Pt I §7.3 protected area
       Amdt 13 Tables I-7-3-1 / I-7-3-2 split (airspace/MDA)
     ICAO Doc 9905 RNP-AR Procedure Design Manual §4.7
     ICAO Annex 6 Pt I §4.5.5 in-flight minima
     ICAO Annex 14 Vol I §3.1 reference codes
     FAA Order 8260.3E TERPS §2.7 Circling Approach Areas
     FAA Order 8260.3E Table 2-7 expansion radii A/B/C/D/E
     FAA AC 120-108 Continuous Descent Final Approach
     FAA AC 120-71 Standard Operating Procedures §4
     FAA AC 90-66B §10 traffic patterns / bank
     FAA AC 91-79B §4 stabilised approach
     FAA Order 8900.1 V4 Ch4 §3 circling restrictions
     14 CFR §91.175(j) commercial circling prohibition night
     EASA AMC1 CAT.OP.MPA.110 commercial circling
     EASA CS-AWO §3 LVO restrictions
     EUROCONTROL EAPPRI ed.3 Approach-Path Monitoring §4
     UK CAA CAP 696 Loading & circling minima
     UK CAA CAP 437 §6 helicopter offshore circling
     ATSB AO-2018-016 Mildura Cat-C circling overrun
     NTSB AAR-13-04 Lex KLEX runway misidentification
     NTSB AAR-19-02 AS3296 circling unstable approach
     AAIB EW/C2017/04/02 EGGD circling MDA bust
     BFU 0X005-13 EDDF Cat-D circling lateral excursion
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  emergency?: string; squawk?: string
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'EXCURSION' | 'UNSTABLE' | 'PROXIMITY' | 'WATCH' | 'CONFORM' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  EXCURSION: '#ef4444', UNSTABLE: '#f43f5e', PROXIMITY: '#f59e0b',
  WATCH: '#0ea5e9', CONFORM: '#10b981', IDLE: '#64748b',
}
const TIER_RANK: Record<Tier, number> = { EXCURSION: 0, UNSTABLE: 1, PROXIMITY: 2, WATCH: 3, CONFORM: 4, IDLE: 5 }

type Cat = 'A' | 'B' | 'C' | 'D' | 'E'
const CAT_COLOR: Record<Cat, string> = { A: '#10b981', B: '#06b6d4', C: '#0ea5e9', D: '#f59e0b', E: '#a855f7' }
// Vat reference IAS (kt) ranges per Doc 8168 Vol I §4.1.2 — cap = max circling IAS
const CAT_MAX_IAS: Record<Cat, number> = { A: 100, B: 135, C: 180, D: 205, E: 240 }
const CAT_MIN_VIS_KM: Record<Cat, number> = { A: 1.5, B: 1.6, C: 2.4, D: 3.6, E: 6.5 }

type Ruleset = 'PANS-OPS' | 'TERPS'
// PANS-OPS protected-area radius (NM) per category at MSL elevation < 1000ft
// from PANS-OPS Vol II Pt I Table I-7-3-1 (post Amdt 13)
const PANSOPS_R_NM: Record<Cat, number> = { A: 1.68, B: 2.66, C: 4.20, D: 5.28, E: 6.94 }
// TERPS 8260.3E Table 2-7 expansion radii (NM) for circling approach areas
const TERPS_R_NM: Record<Cat, number> = { A: 1.3, B: 1.7, C: 2.7, D: 3.6, E: 4.5 }

interface Runway {
  icao: string; rwy: string; latThr: number; lngThr: number; latEnd: number; lngEnd: number
  elevFt: number; haaFt: number; mdaFt: number; ruleset: Ruleset; catMax: Cat
  authority: string; name: string
}

// 18-runway global circling catalogue (threshold and rollout/end coordinates approximated to ±15m)
const RWYS: Runway[] = [
  { icao:'KJFK', rwy:'13L', latThr:40.6622, lngThr:-73.7919, latEnd:40.6266, lngEnd:-73.7551, elevFt:13,  haaFt:720, mdaFt:740,  ruleset:'TERPS',    catMax:'D', authority:'FAA N90',     name:'John F. Kennedy Intl' },
  { icao:'KLAX', rwy:'24R', latThr:33.9483, lngThr:-118.3905,latEnd:33.9388, lngEnd:-118.4377,elevFt:126, haaFt:600, mdaFt:740,  ruleset:'TERPS',    catMax:'D', authority:'FAA SCT',     name:'Los Angeles Intl' },
  { icao:'KSFO', rwy:'19L', latThr:37.6325, lngThr:-122.3568,latEnd:37.6210, lngEnd:-122.3650,elevFt:13,  haaFt:660, mdaFt:680,  ruleset:'TERPS',    catMax:'D', authority:'FAA NCT',     name:'San Francisco Intl' },
  { icao:'KORD', rwy:'27L', latThr:41.9842, lngThr:-87.8939, latEnd:41.9858, lngEnd:-87.9279, elevFt:672, haaFt:560, mdaFt:1240, ruleset:'TERPS',    catMax:'D', authority:'FAA C90',     name:"O'Hare Intl" },
  { icao:'KATL', rwy:'26L', latThr:33.6477, lngThr:-84.3873, latEnd:33.6432, lngEnd:-84.4234, elevFt:1026,haaFt:680, mdaFt:1720, ruleset:'TERPS',    catMax:'D', authority:'FAA A80',     name:'Hartsfield-Jackson Atlanta' },
  { icao:'KBOS', rwy:'33L', latThr:42.3517, lngThr:-71.0093, latEnd:42.3727, lngEnd:-71.0179, elevFt:20,  haaFt:580, mdaFt:600,  ruleset:'TERPS',    catMax:'D', authority:'FAA A90',     name:'Boston Logan Intl' },
  { icao:'KSEA', rwy:'13R', latThr:47.4565, lngThr:-122.3134,latEnd:47.4326, lngEnd:-122.3043,elevFt:432, haaFt:600, mdaFt:1040, ruleset:'TERPS',    catMax:'D', authority:'FAA S46',     name:'Seattle-Tacoma Intl' },
  { icao:'KDEN', rwy:'16L', latThr:39.8867, lngThr:-104.6669,latEnd:39.8407, lngEnd:-104.6669,elevFt:5345,haaFt:680, mdaFt:6040, ruleset:'TERPS',    catMax:'D', authority:'FAA D01',     name:'Denver Intl' },
  { icao:'KMDW', rwy:'31C', latThr:41.7791, lngThr:-87.7406, latEnd:41.7905, lngEnd:-87.7572, elevFt:620, haaFt:540, mdaFt:1180, ruleset:'TERPS',    catMax:'C', authority:'FAA C90',     name:'Chicago Midway Intl' },
  { icao:'KSAN', rwy:'09',  latThr:32.7321, lngThr:-117.2098,latEnd:32.7338, lngEnd:-117.1859,elevFt:17,  haaFt:480, mdaFt:500,  ruleset:'TERPS',    catMax:'D', authority:'FAA SCT',     name:'San Diego Intl' },
  { icao:'EGLL', rwy:'27R', latThr:51.4779, lngThr:-0.4332, latEnd:51.4775, lngEnd:-0.4856, elevFt:78,  haaFt:600, mdaFt:680,  ruleset:'PANS-OPS', catMax:'D', authority:'NATS LON',    name:'London Heathrow' },
  { icao:'EGKK', rwy:'26L', latThr:51.1567, lngThr:-0.1611, latEnd:51.1518, lngEnd:-0.2089, elevFt:202, haaFt:600, mdaFt:800,  ruleset:'PANS-OPS', catMax:'D', authority:'NATS LON',    name:'London Gatwick' },
  { icao:'EHAM', rwy:'22',  latThr:52.3216, lngThr:4.7794,  latEnd:52.3025, lngEnd:4.7950,  elevFt:-11, haaFt:680, mdaFt:670,  ruleset:'PANS-OPS', catMax:'D', authority:'LVNL',        name:'Amsterdam Schiphol' },
  { icao:'EDDF', rwy:'25C', latThr:50.0410, lngThr:8.5870,  latEnd:50.0379, lngEnd:8.5305,  elevFt:364, haaFt:660, mdaFt:1020, ruleset:'PANS-OPS', catMax:'D', authority:'DFS',         name:'Frankfurt Main' },
  { icao:'LFPG', rwy:'26R', latThr:49.0249, lngThr:2.6314,  latEnd:49.0224, lngEnd:2.5611,  elevFt:392, haaFt:680, mdaFt:1080, ruleset:'PANS-OPS', catMax:'D', authority:'DSNA',        name:'Paris Charles de Gaulle' },
  { icao:'LSZH', rwy:'14',  latThr:47.4719, lngThr:8.5364,  latEnd:47.4408, lngEnd:8.5694,  elevFt:1391,haaFt:720, mdaFt:2120, ruleset:'PANS-OPS', catMax:'C', authority:'Skyguide',    name:'Zürich Kloten' },
  { icao:'OMDB', rwy:'12L', latThr:25.2614, lngThr:55.3539, latEnd:25.2360, lngEnd:55.3947, elevFt:62,  haaFt:660, mdaFt:720,  ruleset:'PANS-OPS', catMax:'D', authority:'GCAA',        name:'Dubai Intl' },
  { icao:'WSSS', rwy:'02L', latThr:1.3393,  lngThr:103.9886,latEnd:1.3711,  lngEnd:103.9962,elevFt:22,  haaFt:600, mdaFt:620,  ruleset:'PANS-OPS', catMax:'D', authority:'CAAS',        name:'Singapore Changi' },
]

const NM_PER_DEG_LAT = 60
function nmPerDegLng(lat: number) { return 60 * Math.cos(lat * Math.PI / 180) }
function distNm(aLat:number,aLng:number,bLat:number,bLng:number){const dy=(aLat-bLat)*NM_PER_DEG_LAT;const dx=(aLng-bLng)*nmPerDegLng((aLat+bLat)/2);return Math.hypot(dx,dy)}
function bearingDeg(aLat:number,aLng:number,bLat:number,bLng:number){const dy=(bLat-aLat)*NM_PER_DEG_LAT;const dx=(bLng-aLng)*nmPerDegLng((aLat+bLat)/2);let b=Math.atan2(dx,dy)*180/Math.PI;if(b<0)b+=360;return b}
function offsetNm(lat:number,lng:number,brgDeg:number,distNmV:number){const br=brgDeg*Math.PI/180;const dlat=Math.cos(br)*distNmV/NM_PER_DEG_LAT;const dlng=Math.sin(br)*distNmV/nmPerDegLng(lat);return [lat+dlat, lng+dlng] as [number,number]}

// Map ADS-B category → ICAO circling cat (rough)
function catFromAdsb(cat?: string): Cat {
  switch (cat) {
    case 'A1': return 'A'
    case 'A2': return 'B'
    case 'A3': return 'C'
    case 'A4': case 'A5': return 'D'
    case 'A6': case 'A7': return 'E'
    default: return 'C'
  }
}

// Distance from point to circling protected-area envelope (the union of two arcs of radius R at
// runway threshold and runway end joined by tangent lines). For a planar approximation we use:
//   dist-inside  = min over both rwy points of (R - dist-to-rwy-point)   negative if outside
//   dist-to-axis = perpendicular distance from runway axis line, only relevant inside the segment
// The envelope distance returned is: positive = inside (penetration depth from boundary inward),
// negative = outside (excursion distance).
function envelopeMargin(lat:number,lng:number, rwy:Runway, R_nm:number): { signed:number; inside:boolean; toCenterNm:number } {
  const d1 = distNm(lat,lng, rwy.latThr, rwy.lngThr)
  const d2 = distNm(lat,lng, rwy.latEnd, rwy.lngEnd)
  // along-axis projection
  const axisLen = distNm(rwy.latThr, rwy.lngThr, rwy.latEnd, rwy.lngEnd)
  const brg = bearingDeg(rwy.latThr, rwy.lngThr, rwy.latEnd, rwy.lngEnd)
  // local ENU
  const dy = (lat - rwy.latThr) * NM_PER_DEG_LAT
  const dx = (lng - rwy.lngThr) * nmPerDegLng((lat + rwy.latThr) / 2)
  const ux = Math.sin(brg*Math.PI/180), uy = Math.cos(brg*Math.PI/180)
  const along = dx*ux + dy*uy
  const cross = Math.abs(dx*uy - dy*ux) // perpendicular distance to axis
  let inside = false, signed = 0
  if (along < 0) {
    // before threshold: only arc1 applies
    signed = R_nm - d1
    inside = signed >= 0
  } else if (along > axisLen) {
    signed = R_nm - d2
    inside = signed >= 0
  } else {
    // along the runway corridor: inside if cross < R
    signed = R_nm - cross
    inside = signed >= 0
  }
  // pick closest reference for return
  const toCenter = Math.min(d1, d2)
  return { signed, inside, toCenterNm: toCenter }
}

interface RowR {
  f: SFlight; rwy: Runway; cat: Cat; aglFt: number
  R_nm: number; env: { signed:number; inside:boolean; toCenterNm:number }
  drivers: { LAT:number; ALT:number; IAS:number; BANK:number; VIS:number; PHASE:number }
  score: number; tier: Tier; advice: string
  bankDeg: number; iasOver: number; mdaDelta: number; phase: 'CIRC'|'VEC-TO'|'FAF'|'DIVERSION'
}

function approxBankDeg(velKt:number, prevTrack:number|undefined, curTrack:number, dtSec:number): number {
  if (prevTrack === undefined || dtSec <= 0) return 0
  let dT = curTrack - prevTrack
  if (dT > 180) dT -= 360; if (dT < -180) dT += 360
  const turnRateDegPerS = Math.abs(dT) / dtSec
  // bank = atan(omega·V/g)  with omega in rad/s and V in m/s
  const omega = turnRateDegPerS * Math.PI / 180
  const V = velKt * 0.5144
  const g = 9.81
  return Math.atan(omega * V / g) * 180 / Math.PI
}

const trackHist = new Map<string, { t:number; tr:number }>()

const SCOPE_DEFAULT = 30
const CIRC_ALT_DEFAULT = 2500
const BUF_DEFAULT = 0.8

export default function CirclingApproach({ map, flights, onClose, onFly }: Props) {
  const [scopeNm, setScopeNm]     = useState(SCOPE_DEFAULT)
  const [circAlt, setCircAlt]     = useState(CIRC_ALT_DEFAULT)
  const [bufNm, setBufNm]         = useState(BUF_DEFAULT)
  const [advMul, setAdvMul]       = useState(100)
  const [visKm, setVisKm]         = useState(8)
  const [ruleset, setRuleset]     = useState<Ruleset>('PANS-OPS')
  const [tab, setTab]             = useState<'AC' | 'RWY' | 'CAT'>('AC')
  const [search, setSearch]       = useState('')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [catFilter, setCatFilter] = useState<Cat | 'ALL'>('ALL')
  const [tHalo, setTHalo]   = useState(true)
  const [tArea, setTArea]   = useState(true)
  const [tRwy,  setTRwy]    = useState(true)
  const [tLink, setTLink]   = useState(true)
  const [tLbl,  setTLbl]    = useState(true)
  const [tAxis, setTAxis]   = useState(true)

  const rows: RowR[] = useMemo(() => {
    const list: RowR[] = []
    const now = Date.now()
    for (const f of flights) {
      if (f.ground) continue
      if (f.altitudeFt > circAlt) continue
      // pick nearest runway
      let best: Runway | null = null; let bestD = Infinity
      for (const r of RWYS) {
        const d = distNm(f.lat, f.lng, r.latThr, r.lngThr)
        if (d < bestD) { bestD = d; best = r }
      }
      if (!best || bestD > scopeNm) continue
      const cat = catFromAdsb(f.category)
      if (catFilter !== 'ALL' && catFilter !== cat) continue
      const R_set = ruleset === 'PANS-OPS' ? PANSOPS_R_NM : TERPS_R_NM
      const R_nm = R_set[cat]
      const env = envelopeMargin(f.lat, f.lng, best, R_nm)
      const aglFt = f.altitudeFt - best.elevFt

      // phase classification
      const haOver = aglFt - best.haaFt
      const distToThr = distNm(f.lat, f.lng, best.latThr, best.lngThr)
      const phase: RowR['phase'] =
        aglFt < 200 ? 'FAF' :
        aglFt < best.haaFt + 200 ? 'CIRC' :
        distToThr < 10 && aglFt < 4000 ? 'VEC-TO' : 'DIVERSION'

      // bank from track history
      const prev = trackHist.get(f.icao)
      const dt = prev ? (now - prev.t) / 1000 : 0
      const bankDeg = prev && dt > 0 && dt < 30 ? approxBankDeg(f.velocityKts || 140, prev.tr, f.track, dt) : 0
      trackHist.set(f.icao, { t: now, tr: f.track })

      // drivers
      const LAT = env.signed >= bufNm ? 0
                : env.signed >= 0   ? (bufNm - env.signed) / bufNm * 55
                : Math.min(100, 55 + (-env.signed) / bufNm * 45)
      const mdaDelta = aglFt - best.haaFt
      const ALT = mdaDelta >= 0 ? 0 : Math.min(100, (-mdaDelta) / 2)
      const catMax = CAT_MAX_IAS[cat]
      const iasOver = (f.velocityKts || 0) - catMax
      const IAS = iasOver <= 0 ? 0 : Math.min(100, (iasOver / 25) * 100)
      const BANK = bankDeg <= 25 ? 0 : Math.min(100, ((bankDeg - 25) / 15) * 100)
      const minVis = CAT_MIN_VIS_KM[cat]
      const VIS = visKm >= minVis ? 0 : Math.min(100, ((minVis - visKm) / minVis) * 100)
      const PHASE = phase === 'CIRC' ? 100 : phase === 'VEC-TO' ? 70 : phase === 'FAF' ? 55 : 30

      const drv = { LAT, ALT, IAS, BANK, VIS, PHASE }
      const vals = Object.values(drv)
      const mx = Math.max(...vals)
      const mn = vals.reduce((a,b)=>a+b,0) / vals.length
      let score = (mx * 0.78 + mn * 0.22) * (advMul / 100)
      if (LAT >= 100 && phase === 'CIRC') score = Math.max(score, 92)
      if (ALT >= 100 && phase !== 'FAF')  score = Math.max(score, 88)
      if (BANK >= 100)                    score = Math.max(score, 80)
      score = Math.min(100, Math.max(0, score))

      let tier: Tier
      if (LAT >= 100 && phase === 'CIRC') tier = 'EXCURSION'
      else if (ALT >= 100 && phase !== 'FAF') tier = 'UNSTABLE'
      else if (BANK >= 100 && phase === 'CIRC') tier = 'UNSTABLE'
      else if (LAT >= 55 || VIS >= 70) tier = 'PROXIMITY'
      else if (score >= 18) tier = 'WATCH'
      else tier = 'CONFORM'

      const advice =
        tier === 'EXCURSION' ? `Outside protected area — break off circling, missed approach per PANS-OPS Vol II §7.3 / AC 120-108`
      : tier === 'UNSTABLE'  ? (ALT >= 100 ? `MDA bust ${(-mdaDelta).toFixed(0)}ft below — Go-around per AC 120-108 §6 / 14 CFR §91.175(j)` : `Bank ${bankDeg.toFixed(0)}° > 25° — Stabilise per AC 91-79B §4`)
      : tier === 'PROXIMITY' ? (VIS >= 70 ? `VIS ${visKm.toFixed(1)}km < Cat-${cat} min ${minVis}km — Monitor per Doc 8168 Vol I Pt IV` : `Within ${bufNm.toFixed(1)}NM of envelope boundary — tighten track per AC 120-71`)
      : tier === 'WATCH'     ? `In scope — monitor circling envelope (R=${R_nm.toFixed(2)}NM ${ruleset})`
      :                        `Nominal — conformant ${ruleset} Cat-${cat} envelope`

      list.push({ f, rwy: best, cat, aglFt, R_nm, env, drivers: drv, score, tier, advice, bankDeg, iasOver, mdaDelta, phase })
    }
    let f = list
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      f = f.filter(r => (r.f.callsign||'').toLowerCase().includes(q) || (r.f.icao||'').toLowerCase().includes(q) || r.rwy.icao.toLowerCase().includes(q) || r.rwy.rwy.toLowerCase().includes(q))
    }
    if (tierFilter !== 'ALL') f = f.filter(r => r.tier === tierFilter)
    f.sort((a,b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return f
  }, [flights, scopeNm, circAlt, bufNm, advMul, visKm, ruleset, search, tierFilter, catFilter])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { EXCURSION:0, UNSTABLE:0, PROXIMITY:0, WATCH:0, CONFORM:0, IDLE:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  // build circling protected area polygon for a runway (race-track envelope)
  function envelopePolygon(rwy: Runway, R_nm: number): number[][] {
    const brg = bearingDeg(rwy.latThr, rwy.lngThr, rwy.latEnd, rwy.lngEnd)
    const segs = 24
    const ring: number[][] = []
    // arc around end point from brg-90 to brg+90 (right side, going to +90)
    for (let i = 0; i <= segs; i++) {
      const a = brg - 90 + (180 * i / segs)
      const [la, lo] = offsetNm(rwy.latEnd, rwy.lngEnd, a, R_nm)
      ring.push([lo, la])
    }
    // arc around threshold from brg+90 to brg+270
    for (let i = 0; i <= segs; i++) {
      const a = brg + 90 + (180 * i / segs)
      const [la, lo] = offsetNm(rwy.latThr, rwy.lngThr, a, R_nm)
      ring.push([lo, la])
    }
    ring.push(ring[0])
    return ring
  }

  useEffect(() => {
    if (!map) return
    const SRC = 'circ-src'
    const features: any[] = []
    const R_set = ruleset === 'PANS-OPS' ? PANSOPS_R_NM : TERPS_R_NM

    if (tRwy) {
      for (const r of RWYS) {
        features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.lngThr, r.latThr] }, properties:{ kind:'rwy', label:`${r.icao} ${r.rwy}`, color: CAT_COLOR[r.catMax] } })
      }
    }
    if (tAxis) {
      for (const r of RWYS) {
        features.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[r.lngThr,r.latThr],[r.lngEnd,r.latEnd]] }, properties:{ kind:'axis', color: CAT_COLOR[r.catMax] } })
      }
    }
    if (tArea) {
      // only draw envelope for runways with in-scope traffic to avoid clutter
      const usedIcaos = new Set(rows.map(r => r.rwy.icao + '|' + r.rwy.rwy + '|' + r.cat))
      // Always draw a Cat-C reference envelope at airports with no traffic
      const drawn = new Set<string>()
      for (const r of rows) {
        const key = r.rwy.icao + '|' + r.rwy.rwy + '|' + r.cat
        if (drawn.has(key)) continue
        drawn.add(key)
        const poly = envelopePolygon(r.rwy, r.R_nm)
        features.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[poly] }, properties:{ kind:'envelope', color: CAT_COLOR[r.cat], label:`${r.rwy.icao} Cat-${r.cat} R=${r.R_nm.toFixed(2)}NM` } })
      }
      // ambient cat-C reference at unused runways
      for (const r of RWYS) {
        const k = r.icao + '|' + r.rwy + '|C'
        if (Array.from(usedIcaos).some(u => u.startsWith(r.icao + '|' + r.rwy + '|'))) continue
        const poly = envelopePolygon(r, R_set['C'])
        features.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[poly] }, properties:{ kind:'envelope-ref', color: '#475569', label:`${r.icao} ref` } })
      }
    }

    for (const r of rows) {
      const col = TIER_COLOR[r.tier]
      if (tHalo) {
        features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ kind:'halo', color:col, size: 8 + (r.score/100)*14 } })
      }
      if (r.tier === 'EXCURSION' || r.tier === 'UNSTABLE') {
        features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ kind:'pin', color:col } })
      }
      if (tLink) {
        features.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat],[r.rwy.lngThr, r.rwy.latThr]] }, properties:{ kind:'link', color:col } })
      }
      if (tLbl) {
        features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{ kind:'lbl', color:col, label:`${r.f.callsign||r.f.icao} ${r.rwy.icao}/${r.rwy.rwy} Cat-${r.cat} ${r.tier}` } })
      }
    }
    const data = { type:'FeatureCollection', features }
    const m = map as any
    const set = () => {
      const src = m.getSource(SRC) as any
      if (src) src.setData(data)
      else m.addSource(SRC, { type:'geojson', data })
      const layers: [string, any][] = [
        ['circ-env-ref',{ type:'fill', filter:['==',['get','kind'],'envelope-ref'], paint:{ 'fill-color':['get','color'], 'fill-opacity':0.04 } }],
        ['circ-env-ref-l',{ type:'line', filter:['==',['get','kind'],'envelope-ref'], paint:{ 'line-color':['get','color'], 'line-width':0.8, 'line-dasharray':[1,2], 'line-opacity':0.4 } }],
        ['circ-env',    { type:'fill', filter:['==',['get','kind'],'envelope'], paint:{ 'fill-color':['get','color'], 'fill-opacity':0.07 } }],
        ['circ-env-l',  { type:'line', filter:['==',['get','kind'],'envelope'], paint:{ 'line-color':['get','color'], 'line-width':1.2, 'line-dasharray':[3,2], 'line-opacity':0.7 } }],
        ['circ-axis',   { type:'line', filter:['==',['get','kind'],'axis'], paint:{ 'line-color':['get','color'], 'line-width':2.0, 'line-opacity':0.8 } }],
        ['circ-link',   { type:'line', filter:['==',['get','kind'],'link'], paint:{ 'line-color':['get','color'], 'line-width':1.0, 'line-dasharray':[1,2], 'line-opacity':0.6 } }],
        ['circ-halo',   { type:'circle', filter:['==',['get','kind'],'halo'], paint:{ 'circle-radius':['get','size'], 'circle-color':['get','color'], 'circle-opacity':0.15, 'circle-stroke-width':1.2, 'circle-stroke-color':['get','color'], 'circle-stroke-opacity':0.7 } }],
        ['circ-rwy',    { type:'circle', filter:['==',['get','kind'],'rwy'], paint:{ 'circle-radius':5, 'circle-color':['get','color'], 'circle-opacity':0.5, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4 } }],
        ['circ-pin',    { type:'circle', filter:['==',['get','kind'],'pin'], paint:{ 'circle-radius':6, 'circle-color':['get','color'], 'circle-opacity':0.85, 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.2 } }],
        ['circ-lbl',    { type:'symbol', filter:['==',['get','kind'],'lbl'], layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Open Sans Regular','Arial Unicode MS Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.2 } }],
        ['circ-rwy-lbl',{ type:'symbol', filter:['==',['get','kind'],'rwy'], layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,1.2], 'text-anchor':'top', 'text-font':['Open Sans Regular','Arial Unicode MS Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.1 } }],
      ]
      for (const [id, spec] of layers) {
        if (!m.getLayer(id)) m.addLayer({ id, source: SRC, ...spec })
      }
    }
    if (!m.loaded()) m.once('load', set); else set()
    return () => {
      const m2 = map as any
      for (const id of ['circ-rwy-lbl','circ-lbl','circ-pin','circ-rwy','circ-halo','circ-link','circ-axis','circ-env-l','circ-env','circ-env-ref-l','circ-env-ref']) {
        if (m2.getLayer(id)) m2.removeLayer(id)
      }
      if (m2.getSource(SRC)) m2.removeSource(SRC)
    }
  }, [map, rows, tHalo, tArea, tRwy, tLink, tLbl, tAxis, ruleset])

  const tiers: Tier[] = ['EXCURSION','UNSTABLE','PROXIMITY','WATCH','CONFORM']
  const mean = rows.length ? rows.reduce((a,r)=>a+r.score,0) / rows.length : 0
  const worst = rows[0]
  const excursions = counts.EXCURSION
  const unstable  = counts.UNSTABLE

  return (
    <div className="absolute top-[68px] right-3 z-30 w-[390px] max-h-[calc(100vh-88px)] overflow-hidden flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-200 text-[11px] shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div>
          <div className="text-slate-100 font-medium tracking-wide">CIRC · circling protected area & minima</div>
          <div className="text-[9px] text-slate-500 uppercase tracking-widest">PANS-OPS Vol II §7.3 · TERPS 8260.3E §2.7 · AC 120-108</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 px-1">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-2 pt-2">
        {tiers.map(t => (
          <button key={t} onClick={()=>setTierFilter(tierFilter===t?'ALL':t)} className={`rounded border px-1 py-1 text-center ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800'}`}>
            <div className="text-[8px] uppercase tracking-widest" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-[12px] tabular-nums" style={{ color: TIER_COLOR[t] }}>{counts[t]}</div>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-1 px-2 pt-1">
        <div className="rounded border border-slate-800 px-2 py-1"><div className="text-[8px] uppercase tracking-widest text-slate-500">mean</div><div className="text-[12px] tabular-nums" style={{color: mean>50?TIER_COLOR.UNSTABLE:mean>25?TIER_COLOR.PROXIMITY:TIER_COLOR.CONFORM}}>{mean.toFixed(0)}</div></div>
        <div className="rounded border border-slate-800 px-2 py-1"><div className="text-[8px] uppercase tracking-widest text-slate-500">worst</div><div className="text-[10px] truncate" style={{color: worst?TIER_COLOR[worst.tier]:'#64748b'}}>{worst?worst.f.callsign||worst.f.icao:'—'}</div></div>
        <div className="rounded border border-slate-800 px-2 py-1"><div className="text-[8px] uppercase tracking-widest text-slate-500">excursion</div><div className="text-[12px] tabular-nums" style={{color: TIER_COLOR.EXCURSION}}>{excursions}</div></div>
        <div className="rounded border border-slate-800 px-2 py-1"><div className="text-[8px] uppercase tracking-widest text-slate-500">unstable</div><div className="text-[12px] tabular-nums" style={{color: TIER_COLOR.UNSTABLE}}>{unstable}</div></div>
      </div>

      <div className="px-2 pt-2 space-y-1">
        <Slider label="SCOPE" val={scopeNm} min={5} max={80} onChange={setScopeNm} unit="NM" />
        <Slider label="CIRC-ALT" val={circAlt} min={1000} max={6000} step={100} onChange={setCircAlt} unit="ft" />
        <Slider label="BUF" val={Math.round(bufNm*10)} min={2} max={30} onChange={v=>setBufNm(v/10)} unit="·0.1NM" />
        <Slider label="VIS" val={Math.round(visKm*10)} min={5} max={150} onChange={v=>setVisKm(v/10)} unit="·0.1km" />
        <Slider label="ADV-MUL" val={advMul} min={50} max={200} onChange={setAdvMul} unit="%" />
      </div>

      <div className="px-2 pt-2 flex flex-wrap items-center gap-1">
        <div className="text-[8px] uppercase tracking-widest text-slate-500 mr-1">ruleset</div>
        {(['PANS-OPS','TERPS'] as const).map(r => (
          <button key={r} onClick={()=>setRuleset(r)} className={`text-[8px] px-1.5 py-0.5 rounded border ${ruleset===r?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500'}`}>{r}</button>
        ))}
        <div className="w-2" />
        <div className="text-[8px] uppercase tracking-widest text-slate-500 mr-1">cat</div>
        {(['ALL','A','B','C','D','E'] as const).map(c=>(
          <button key={c} onClick={()=>setCatFilter(c as any)} className={`text-[8px] px-1.5 py-0.5 rounded border ${catFilter===c?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500'}`}>{c}</button>
        ))}
      </div>
      <div className="px-2 pt-1 flex gap-1">
        {([['HALO',tHalo,setTHalo],['AREA',tArea,setTArea],['RWY',tRwy,setTRwy],['LINK',tLink,setTLink],['LBL',tLbl,setTLbl],['AXIS',tAxis,setTAxis]] as const).map(([l,v,sf])=>(
          <button key={l} onClick={()=>sf(!v)} className={`text-[8px] px-2 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500'}`}>{l}</button>
        ))}
      </div>

      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search callsign / runway / airport" className="mx-2 mt-2 px-2 py-1 bg-slate-900 border border-slate-800 rounded text-[10px] text-slate-200 placeholder-slate-600" />

      <div className="flex gap-1 px-2 pt-2 pb-1 border-b border-slate-800">
        {(['AC','RWY','CAT'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`text-[9px] px-2 py-1 rounded uppercase tracking-widest ${tab===t?'bg-sky-500/15 text-slate-100 border border-sky-500/40':'text-slate-500 border border-transparent'}`}>{t==='AC'?'Aircraft':t==='RWY'?'Runways':'Categories'}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 pt-1 space-y-1">
        {tab === 'AC' && rows.slice(0, 60).map(r => (
          <div key={r.f.icao} onClick={()=>onFly(r.f.icao)} className="rounded border border-slate-800 px-2 py-1.5 hover:bg-slate-900 cursor-pointer" style={{ borderLeft:`3px solid ${TIER_COLOR[r.tier]}` }}>
            <div className="flex items-center justify-between gap-1">
              <div className="flex items-center gap-1 min-w-0">
                <span className="font-medium text-slate-100 truncate">{r.f.callsign || r.f.icao}</span>
                <span className="text-[8px] text-slate-500">{r.f.type || ''}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[8px] px-1 py-0.5 rounded border" style={{ color: CAT_COLOR[r.cat], borderColor: CAT_COLOR[r.cat]+'66' }}>Cat-{r.cat}</span>
                <span className="text-[8px] px-1 py-0.5 rounded border" style={{ color: TIER_COLOR[r.tier], borderColor: TIER_COLOR[r.tier]+'66' }}>{r.tier}</span>
              </div>
            </div>
            <div className="text-[9px] text-slate-400 mt-0.5 flex items-center gap-2">
              <span className="text-sky-400">{r.rwy.icao}/{r.rwy.rwy}</span>
              <span className="text-slate-500">{r.phase}</span>
              <span className="text-slate-500">R</span>
              <span className="tabular-nums text-slate-300">{r.R_nm.toFixed(2)}NM</span>
              <span className="text-slate-500">margin</span>
              <span className="tabular-nums" style={{ color: r.env.signed>=r.R_nm*0.3?TIER_COLOR.CONFORM:r.env.signed>=0?TIER_COLOR.PROXIMITY:TIER_COLOR.EXCURSION }}>{r.env.signed.toFixed(2)}NM</span>
            </div>
            <div className="text-[9px] text-slate-400 mt-0.5 flex items-center gap-2">
              <span className="text-slate-500">AGL</span>
              <span className="tabular-nums text-slate-300">{r.aglFt.toFixed(0)}ft</span>
              <span className="text-slate-500">HAA</span>
              <span className="tabular-nums text-slate-300">{r.rwy.haaFt}ft</span>
              <span className="text-slate-500">Δ</span>
              <span className="tabular-nums" style={{ color: r.mdaDelta>=0?TIER_COLOR.CONFORM:TIER_COLOR.UNSTABLE }}>{r.mdaDelta>=0?'+':''}{r.mdaDelta.toFixed(0)}</span>
              <span className="text-slate-500">IAS</span>
              <span className="tabular-nums" style={{ color: r.iasOver<=0?TIER_COLOR.CONFORM:TIER_COLOR.UNSTABLE }}>{(r.f.velocityKts||0).toFixed(0)}/{CAT_MAX_IAS[r.cat]}</span>
              <span className="text-slate-500">bank</span>
              <span className="tabular-nums" style={{ color: r.bankDeg<=25?TIER_COLOR.CONFORM:r.bankDeg<=30?TIER_COLOR.PROXIMITY:TIER_COLOR.UNSTABLE }}>{r.bankDeg.toFixed(0)}°</span>
            </div>
            <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier] }} /></div>
            <div className="grid grid-cols-6 gap-1 mt-1">
              {(['LAT','ALT','IAS','BANK','VIS','PHASE'] as const).map(k=>(
                <div key={k} className="text-center">
                  <div className="text-[7px] text-slate-500 uppercase">{k}</div>
                  <div className="text-[8px] tabular-nums" style={{ color: r.drivers[k]>=80?TIER_COLOR.UNSTABLE:r.drivers[k]>=50?TIER_COLOR.PROXIMITY:'#94a3b8' }}>{r.drivers[k].toFixed(0)}</div>
                </div>
              ))}
            </div>
            <div className="text-[9px] mt-1 italic" style={{ color: TIER_COLOR[r.tier] }}>{r.advice}</div>
          </div>
        ))}

        {tab === 'RWY' && RWYS.map(r => {
          const inUse = rows.filter(x => x.rwy.icao === r.icao && x.rwy.rwy === r.rwy)
          const tierWorst = inUse.length ? [...inUse].sort((x,y)=>TIER_RANK[x.tier]-TIER_RANK[y.tier])[0].tier : 'IDLE'
          return (
            <div key={r.icao + r.rwy} className="rounded border border-slate-800 px-2 py-1.5" style={{ borderLeft:`3px solid ${TIER_COLOR[tierWorst]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sky-400 font-medium">{r.icao}/{r.rwy}</span>
                  <span className="text-[8px] px-1 py-0.5 rounded border" style={{ color: CAT_COLOR[r.catMax], borderColor: CAT_COLOR[r.catMax]+'66' }}>≤Cat-{r.catMax}</span>
                  <span className="text-[8px] text-slate-500">{r.ruleset}</span>
                </div>
                <span className="text-[8px] text-slate-500 tabular-nums">{r.elevFt}ft</span>
              </div>
              <div className="text-[9px] text-slate-400 italic mt-0.5 truncate">{r.name}</div>
              <div className="text-[9px] text-slate-400 mt-0.5 flex items-center gap-2">
                <span className="text-slate-500">HAA</span><span className="text-slate-300 tabular-nums">{r.haaFt}ft</span>
                <span className="text-slate-500">MDA</span><span className="text-slate-300 tabular-nums">{r.mdaFt}ft</span>
                <span className="text-slate-500">in-scope</span><span className="text-slate-200 tabular-nums">{inUse.length}</span>
              </div>
              <div className="text-[8px] text-slate-500 mt-0.5">{r.authority}</div>
            </div>
          )
        })}

        {tab === 'CAT' && (['A','B','C','D','E'] as Cat[]).map(c => {
          const inUse = rows.filter(x => x.cat === c)
          const meanS = inUse.length ? inUse.reduce((a,r)=>a+r.score,0)/inUse.length : 0
          return (
            <div key={c} className="rounded border border-slate-800 px-2 py-1.5" style={{ borderLeft:`3px solid ${CAT_COLOR[c]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-[8px] px-1 py-0.5 rounded border" style={{ color: CAT_COLOR[c], borderColor: CAT_COLOR[c]+'66' }}>Cat-{c}</span>
                  <span className="text-[9px] text-slate-400 italic">Vat≤{CAT_MAX_IAS[c]}kt · vis≥{CAT_MIN_VIS_KM[c]}km</span>
                </div>
                <span className="text-[8px] text-slate-500 tabular-nums">{inUse.length} AC</span>
              </div>
              <div className="text-[9px] text-slate-400 mt-0.5 flex items-center gap-2">
                <span className="text-slate-500">PANS-OPS R</span><span className="text-slate-300 tabular-nums">{PANSOPS_R_NM[c].toFixed(2)}NM</span>
                <span className="text-slate-500">TERPS R</span><span className="text-slate-300 tabular-nums">{TERPS_R_NM[c].toFixed(2)}NM</span>
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width:`${meanS}%`, background:CAT_COLOR[c] }} /></div>
            </div>
          )
        })}

        {rows.length === 0 && tab==='AC' && <div className="text-slate-500 text-[10px] text-center py-4">no low-altitude traffic in scope</div>}
      </div>
    </div>
  )
}

function Slider({ label, val, min, max, onChange, unit, step }: { label:string; val:number; min:number; max:number; onChange:(v:number)=>void; unit:string; step?:number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[8px] uppercase tracking-widest">
        <span className="text-slate-500">{label}</span>
        <span className="text-slate-300 tabular-nums">{val}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step||1} value={val} onChange={e=>onChange(Number(e.target.value))} className="w-full h-1 accent-sky-500" />
    </div>
  )
}
