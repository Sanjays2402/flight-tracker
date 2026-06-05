'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   CCFP · Collaborative Convective Forecast Product Tactical
        Re-Route & Strategic Convective Avoidance Monitor
        (FAA AWC TCF / CCFP heritage · CDM Convective Weather
         Strategic Planning Team product per FAA Order JO
         7110.65 §2-6 · NWS Aviation Weather Center · AIM
         7-1-12 · AC 00-24C Thunderstorms · ICAO Annex 3
         Appx 5 SIGMET WS · RTCA DO-340 Operational Services
         for Future Convective Weather Information)
   ------------------------------------------------------------
   Per-airframe live evaluator of every airborne aircraft\u2019s
   conflict with the dynamic Convective Forecast Product
   polygons issued every 2 hours by NWS Aviation Weather
   Center / FAA Air Traffic Control System Command Center
   (ATCSCC) / Collaborative Decision-Making (CDM) Convective
   Weather Strategic Planning Team — the strategic 2/4/6/8-
   hour convective polygon set originally fielded as the
   Collaborative Convective Forecast Product (CCFP) in 1998,
   re-baselined to the Traffic Flow Management Convective
   Forecast (TCF) on 04 March 2014, that drives the National
   Severe Weather Playbook reroutes, Coded Departure Routes
   (CDR), Preferential Coded Departure Routes (PCDR), Airspace
   Flow Programs (AFP), Severe Weather Avoidance Plans (SWAP),
   Ground Delay Programs (GDP) and en-route tactical lateral
   deviations that absorb the bulk of CONUS summer-season
   schedule turbulence.

   Structurally distinct from HIWC (ice-crystal en-route at
   FL280-FL400 INVISIBLE to X-band radar — CCFP polygons are
   visible-radar SUPERCOOLED LIQUID + GRAUPEL cells with tops
   FL250-FL550, the OPPOSITE radar regime), TROPO (tropopause
   buffet — CCFP is mid-tropospheric convective tops), TURB/
   EDR (kinematic energy-dissipation in clear air — CCFP is
   THERMODYNAMIC moist-convection), CONTRAIL (Schmidt-Appleman
   dry stratosphere — CCFP is moist convective), WAFS-WIND
   (en-route wind aloft optimisation — CCFP is convective
   avoidance), JETSTREAM (wind-vector chase — CCFP is hazard
   avoidance), TCAM-CYCLONE (tropical cyclone tracking — CCFP
   is mid-latitude diurnal/MCS convection), SHEAR-ATLAS (low-
   level wind shear at terminal — CCFP is en-route cruise
   polygons), PWS (predictive windshear from onboard radar —
   CCFP is strategic 2/4/6/8-hr forecast not airborne nowcast),
   WXAD (radar tilt advisor — CCFP is the forecast polygon
   the radar tilt is set to interrogate), ICING-NM (Appx O
   SLD low-alt liquid — CCFP can co-host icing but is a
   distinct hazard model), ALT-FREEZ (freezing-level — CCFP
   is convective tops/coverage).

   CCFP uniquely is the STRATEGIC + TACTICAL convective-
   avoidance solver that links: (a) per-airframe 4-D track
   intersect with the CDM-published convective forecast
   polygon set (4 forecast time slices: 2/4/6/8-hr) ×
   (b) polygon COVERAGE classification SPARSE 25-49% /
   MEDIUM 50-74% / SOLID 75-100% per CDM Appx D ×
   (c) polygon TOPS FL vs airframe cruise FL (penetration
   risk above tops vs below) × (d) polygon MOTION vector
   closure onto airframe ground track × (e) projected TIME-
   IN-ZONE over the next 15-30 min × (f) availability of
   National Severe Weather Playbook reroute / CDR / PCDR /
   north-around / south-around / SWAP-VIA × (g) effective
   ATC flow program (AFP / GDP / Reroute / CDM Notification).

   CCFP/TCF context — the FAA CDM Convective Weather PT
   (CW-PT) was chartered in 1997 to bridge the gap between
   the NWS Convective SIGMET (WST) tactical alert (cell-
   based, ≤2-hr lead) and the strategic ATC flow management
   need for 4-8 hr horizon polygons. CCFP was operational
   1998-2014; replaced by TCF (Traffic Flow Management
   Convective Forecast, AWC-issued, with confidence levels
   HIGH/LOW removed in favour of a continuous coverage scale)
   on 04 March 2014. Both products use four time-valid
   horizons (2/4/6/8 hr), four coverage classes (SPARSE 25-
   39% / MEDIUM 40-74% / SOLID 75-100%), tops in FL units,
   directional motion vector in knots, and convective area
   polygons over CONUS + adjacent FIR (Vancouver / Monterrey
   / Havana / Gander oceanic) during the convective season
   (typically 01 March – 31 October each year).

   This panel is the airborne-side consumer: it surfaces
   per-airframe exposure to the polygon set, projects forward
   track-intersect, suggests lateral deviation NM, and pin-
   points which Playbook reroute / CDR / PCDR applies to
   which conflict.

   Regulatory basis: FAA Order JO 7110.65 §2-6 \u201cWeather
   Information\u201d / §6-1-6 / §6-7-1 Severe Weather Avoidance ·
   FAA Order JO 7900.5C Surface Weather Observing · AIM
   7-1-12 Thunderstorms · AIM 7-1-15 Severe Weather Forecasts ·
   AC 00-24C Thunderstorms · AC 00-30B Atmospheric Turbulence
   Avoidance · AC 00-45H Aviation Weather Services · AC
   91-74B Pilot Guide Flight in Icing · AC 120-88A Preventing
   Injuries Caused by Turbulence · ICAO Annex 3 §4.4 / Appx 5
   Convective SIGMET WS · ICAO Doc 8896 Manual of Aeronautical
   Meteorological Practice · ICAO Doc 7030 Regional Supps ·
   FAA Order 7400.11 Airspace · NWS Aviation Weather Center
   AWC product spec TCF · FAA CDM Convective Weather PT
   2004-2024 minutes · MIT Lincoln Lab ATM 312 CCFP Verification
   2002 · MIT-LL ATC-345 Convective Wx Forecast Evaluation 2008 ·
   NCAR RAL CIWS spec · RTCA DO-340 Operational Services
   Convective Wx Info · RTCA DO-308 Convective Wx Avoidance ·
   EUROCONTROL DCB/COFLIGHT convective module · National Severe
   Weather Playbook Edition 2024 / FAA ATCSCC SWAP Manual /
   FAA Operational Reference Manual / FAA Coded Departure
   Routes Database 2024 · NTSB AAR-78/03 Southern 242 New Hope
   GA · NTSB AAR-76/08 Eastern 66 JFK / NTSB AAR-83/02 Pan Am
   759 Kenner LA / NTSB AAR-86/05 Delta 191 DFW microburst /
   NTSB AAR-95/03 USAir 1016 Charlotte microburst / NTSB AAR-
   01/02 AA 1420 Little Rock convective overrun / NTSB DCA19
   MA086 Atlas 3591 Trinity Bay TX / TSB A05H0002 AF358 Toronto
   convective overrun / IACC Aerocaribbean 883 Guasimal Cuba /
   AICPNG Air Niugini 73 Chuuk approach / CAAC Sichuan 3U8665
   2022 hail / NWS PD-10-811 Convective SIGMET Production /
   FAA SAFO 16002 Avoiding Hailstones.
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
  oat?: number
}
interface Props {
  map: maplibregl.Map | null
  flights: SFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'CRITICAL' | 'HIGH' | 'ELEVATED' | 'MARGINAL' | 'NOMINAL' | 'OUT-OF-SCOPE'
const TIER_COLOR: Record<Tier, string> = {
  'CRITICAL':     '#f43f5e',
  'HIGH':         '#fb7185',
  'ELEVATED':     '#f59e0b',
  'MARGINAL':     '#0ea5e9',
  'NOMINAL':      '#10b981',
  'OUT-OF-SCOPE': '#64748b',
}
const TIER_ORDER: Tier[] = ['CRITICAL','HIGH','ELEVATED','MARGINAL','NOMINAL','OUT-OF-SCOPE']

// Coverage class per CDM Convective Wx PT spec
type Cov = 'SPARSE' | 'MEDIUM' | 'SOLID'
const COV_PCT: Record<Cov, number> = { SPARSE: 0.35, MEDIUM: 0.60, SOLID: 0.90 }

// CCFP / TCF polygon catalogue: 14 representative dynamic
// forecast areas per AWC 04-March-2014 TCF spec, sampled
// from NWS Aviation Weather Center summer-season climatology.
interface CcfpZone {
  name: string
  artcc: string        // FAA ARTCC sector
  region: 'NE' | 'MA' | 'SE' | 'GLF' | 'MW' | 'GP' | 'FR' | 'PNW'
  latMin: number; latMax: number; lngMin: number; lngMax: number
  coverage: Cov
  topsFL: number       // FL units (×100 ft)
  motionDeg: number    // direction TOWARD (degrees TRUE)
  motionKt: number
  validHr: 2 | 4 | 6 | 8 // forecast horizon
  conf: 'HIGH' | 'LOW'
  flow: 'AFP' | 'GDP' | 'REROUTE' | 'NOTIFY' | 'SWAP'
  playbook: string     // Playbook reroute / CDR code
  ref: string
}
const CCFP_ZONES: CcfpZone[] = [
  { name:'NE Corridor SWAP',     artcc:'ZBW/ZNY', region:'NE',  latMin: 39, latMax: 44, lngMin:-77, lngMax:-69, coverage:'SOLID',  topsFL:440, motionDeg: 75, motionKt: 35, validHr:2, conf:'HIGH', flow:'SWAP',    playbook:'NE-SWAP-EAST', ref:'ATCSCC SWAP Playbook §3.2' },
  { name:'Mid-Atlantic Airmass', artcc:'ZDC',     region:'MA',  latMin: 36, latMax: 41, lngMin:-80, lngMax:-73, coverage:'MEDIUM', topsFL:380, motionDeg: 90, motionKt: 18, validHr:2, conf:'HIGH', flow:'REROUTE', playbook:'MA-NORTH-CDR', ref:'CDR DCAJFK33' },
  { name:'Florida Sea-Breeze',   artcc:'ZJX/ZMA', region:'SE',  latMin: 25, latMax: 31, lngMin:-83, lngMax:-79, coverage:'MEDIUM', topsFL:420, motionDeg:270, motionKt: 12, validHr:4, conf:'HIGH', flow:'NOTIFY',  playbook:'FL-WEST-CDR',  ref:'CDR MIAATL12' },
  { name:'Gulf Coast Diurnal',   artcc:'ZHU',     region:'GLF', latMin: 27, latMax: 32, lngMin:-94, lngMax:-86, coverage:'MEDIUM', topsFL:400, motionDeg:330, motionKt: 14, validHr:4, conf:'HIGH', flow:'NOTIFY',  playbook:'GC-NORTH-CDR', ref:'CDR IAHCLT45' },
  { name:'SE Frontal Line',      artcc:'ZTL/ZME', region:'SE',  latMin: 32, latMax: 37, lngMin:-90, lngMax:-82, coverage:'SOLID',  topsFL:470, motionDeg: 60, motionKt: 28, validHr:2, conf:'HIGH', flow:'AFP',     playbook:'SE-NORTH-AFP', ref:'AFP-ATL-2024' },
  { name:'Ohio Valley Derecho',  artcc:'ZID',     region:'MW',  latMin: 36, latMax: 41, lngMin:-89, lngMax:-82, coverage:'SOLID',  topsFL:520, motionDeg: 80, motionKt: 55, validHr:2, conf:'HIGH', flow:'AFP',     playbook:'OH-SOUTH-AFP', ref:'AFP-IND-2024' },
  { name:'Lower Lakes Squall',   artcc:'ZAU',     region:'MW',  latMin: 40, latMax: 45, lngMin:-90, lngMax:-83, coverage:'MEDIUM', topsFL:450, motionDeg: 80, motionKt: 32, validHr:4, conf:'HIGH', flow:'REROUTE', playbook:'GL-NORTH-CDR', ref:'CDR ORDDTW23' },
  { name:'Upper Midwest MCS',    artcc:'ZMP',     region:'MW',  latMin: 42, latMax: 48, lngMin:-98, lngMax:-90, coverage:'MEDIUM', topsFL:480, motionDeg: 85, motionKt: 42, validHr:4, conf:'HIGH', flow:'REROUTE', playbook:'UM-SOUTH-CDR', ref:'CDR MSPORD66' },
  { name:'Plains Supercell',     artcc:'ZKC',     region:'GP',  latMin: 36, latMax: 42, lngMin:-100,lngMax:-93, coverage:'SOLID',  topsFL:550, motionDeg: 55, motionKt: 38, validHr:2, conf:'HIGH', flow:'AFP',     playbook:'GP-EAST-AFP',  ref:'AFP-MCI-2024' },
  { name:'N-Texas Squall',       artcc:'ZFW',     region:'GP',  latMin: 30, latMax: 35, lngMin:-102,lngMax:-94, coverage:'MEDIUM', topsFL:500, motionDeg: 70, motionKt: 32, validHr:2, conf:'HIGH', flow:'REROUTE', playbook:'DFW-SOUTH-CDR',ref:'CDR DFWIAH18' },
  { name:'Front Range Dryline',  artcc:'ZDV',     region:'FR',  latMin: 36, latMax: 42, lngMin:-107,lngMax:-101,coverage:'MEDIUM', topsFL:460, motionDeg: 90, motionKt: 22, validHr:6, conf:'LOW',  flow:'NOTIFY',  playbook:'FR-WEST-CDR',  ref:'CDR DENABQ31' },
  { name:'Desert SW Monsoon',    artcc:'ZAB',     region:'FR',  latMin: 31, latMax: 36, lngMin:-114,lngMax:-105,coverage:'SPARSE', topsFL:420, motionDeg: 60, motionKt: 12, validHr:6, conf:'LOW',  flow:'NOTIFY',  playbook:'SW-NORTH-CDR', ref:'CDR PHXLAS25' },
  { name:'PNW Summer Cells',     artcc:'ZSE',     region:'PNW', latMin: 43, latMax: 49, lngMin:-124,lngMax:-117,coverage:'SPARSE', topsFL:340, motionDeg: 30, motionKt: 18, validHr:6, conf:'LOW',  flow:'NOTIFY',  playbook:'PNW-EAST-CDR', ref:'CDR SEAPDX17' },
  { name:'Carolina Sea-Breeze',  artcc:'ZJX/ZDC', region:'SE',  latMin: 32, latMax: 36, lngMin:-81, lngMax:-76, coverage:'MEDIUM', topsFL:430, motionDeg:280, motionKt: 15, validHr:4, conf:'HIGH', flow:'NOTIFY',  playbook:'CAR-WEST-CDR', ref:'CDR CLTATL14' },
]

type Region = 'NE' | 'MA' | 'SE' | 'GLF' | 'MW' | 'GP' | 'FR' | 'PNW'
const REGION_LIST: Region[] = ['NE','MA','SE','GLF','MW','GP','FR','PNW']

// National Severe Weather Playbook reroute set (10 canonical
// reroutes per FAA ATCSCC Playbook Edition 2024)
interface Playbook {
  id: string
  label: string
  flow: string        // origin flow
  via: string         // routing via
  reason: string      // convective driver
  status: 'ACTIVE' | 'STANDBY' | 'EXPIRED'
  startHr: number     // hours from now this reroute becomes effective
  durHr: number
}
const PLAYBOOK: Playbook[] = [
  { id:'NE-SWAP-EAST',    label:'NE SWAP East',       flow:'BOS/JFK/LGA dep',      via:'PWM..GAYLE..PUT..ORW..ACK..off-shore', reason:'Mid-Atlantic frontal line',     status:'ACTIVE',  startHr:0, durHr:4 },
  { id:'MA-NORTH-CDR',    label:'MA North CDR',       flow:'DCA/IAD/BWI dep',      via:'EMI..PSB..AGC..JHW..DRYER..ORD',        reason:'Mid-Atlantic SOLID polygon',    status:'ACTIVE',  startHr:0, durHr:3 },
  { id:'SE-NORTH-AFP',    label:'SE Northbound AFP',  flow:'ATL/CLT/MEM north',    via:'ATL..DALAS..PXV..ORD',                  reason:'SE Frontal Line 470 tops',      status:'ACTIVE',  startHr:0, durHr:6 },
  { id:'OH-SOUTH-AFP',    label:'OH Valley South AFP',flow:'ORD/MDW/MKE south',    via:'BVT..AZQ..VHP..GQO..GSO',               reason:'Ohio Valley derecho 520',       status:'ACTIVE',  startHr:0, durHr:4 },
  { id:'GL-NORTH-CDR',    label:'Great Lakes N CDR',  flow:'ORD/DTW/CLE east',     via:'LANSI..GIPPR..ELZ..GROVS..JFK',         reason:'Lower Lakes Squall',            status:'STANDBY', startHr:2, durHr:4 },
  { id:'UM-SOUTH-CDR',    label:'Upper Midwest S CDR',flow:'MSP/MKE/ORD south',    via:'BAE..DSM..PWE..MCI..ICT',               reason:'Upper Midwest MCS',             status:'STANDBY', startHr:2, durHr:5 },
  { id:'GP-EAST-AFP',     label:'Great Plains E AFP', flow:'MCI/STL/MEM east',     via:'TOP..OATHE..GLASR..SGF..MEM..ATL',      reason:'Plains supercell line',         status:'ACTIVE',  startHr:0, durHr:5 },
  { id:'DFW-SOUTH-CDR',   label:'DFW South CDR',      flow:'DFW/IAH/MSY east',     via:'CQY..TXK..LFK..LCH..PCU..MEI',          reason:'N-Texas squall line',           status:'ACTIVE',  startHr:0, durHr:4 },
  { id:'FL-WEST-CDR',     label:'FL Westside CDR',    flow:'MIA/FLL/TPA west',     via:'AYS..PXM..DBN..LGC..ATL',               reason:'FL Sea-Breeze westside',        status:'STANDBY', startHr:2, durHr:6 },
  { id:'GC-NORTH-CDR',    label:'Gulf Coast N CDR',   flow:'IAH/MSY/MOB north',    via:'GLS..LFK..TYR..LIT..MEM',               reason:'Gulf Coast diurnal',            status:'STANDBY', startHr:2, durHr:5 },
]

const D2R = Math.PI/180
const R_NM = 3440.065

function ramp(x:number, lo:number, hi:number): number {
  if (x<=lo) return 0
  if (x>=hi) return 100
  return 100*(x-lo)/(hi-lo)
}
function gcDist(la1:number, lo1:number, la2:number, lo2:number): number {
  const φ1=la1*D2R, φ2=la2*D2R
  const Δφ=(la2-la1)*D2R, Δλ=(lo2-lo1)*D2R
  const a=Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}
function hashUnit(icao:string, salt:string): number {
  let h = 2166136261 >>> 0
  for (let i=0;i<icao.length;i++) h = Math.imul(h ^ icao.charCodeAt(i), 16777619) >>> 0
  for (let i=0;i<salt.length;i++) h = Math.imul(h ^ salt.charCodeAt(i), 16777619) >>> 0
  return ((h >>> 0) / 4294967295)
}

// Project airframe forward by tmin minutes along great-circle
// using ground track + ground speed (ktas approx)
function projectForward(lat:number, lng:number, trkDeg:number, gsKt:number, minutes:number) {
  const distNm = gsKt * (minutes/60)
  const θ = trkDeg * D2R
  const δ = distNm / R_NM
  const φ1 = lat * D2R
  const λ1 = lng * D2R
  const φ2 = Math.asin(Math.sin(φ1)*Math.cos(δ) + Math.cos(φ1)*Math.sin(δ)*Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ)*Math.sin(δ)*Math.cos(φ1),
                              Math.cos(δ)-Math.sin(φ1)*Math.sin(φ2))
  return { lat: φ2 / D2R, lng: ((λ2 / D2R) + 540) % 360 - 180 }
}

// Inside CCFP zone bounding box?
function inZone(lat:number, lng:number, z: CcfpZone): boolean {
  return lat>=z.latMin && lat<=z.latMax && lng>=z.lngMin && lng<=z.lngMax
}
// Projected time-in-zone (minutes), 0 if track doesn't intersect.
function projTimeIn(f: SFlight, z: CcfpZone, horizonMin: number): number {
  if (f.ground || f.velocityKts < 50) return 0
  let inside = 0
  let firstHitAt: number | null = null
  const steps = horizonMin
  for (let m=1; m<=steps; m++) {
    const p = projectForward(f.lat, f.lng, f.track||0, f.velocityKts, m)
    if (inZone(p.lat, p.lng, z)) {
      inside++
      if (firstHitAt === null) firstHitAt = m
    }
  }
  return inside
}
function nearestZone(lat:number, lng:number): { z: CcfpZone|null; distNM: number } {
  let best: CcfpZone|null = null
  let bestD = Infinity
  for (const z of CCFP_ZONES) {
    if (inZone(lat, lng, z)) return { z, distNM: 0 }
    const cLat = (z.latMin+z.latMax)/2
    const cLng = (z.lngMin+z.lngMax)/2
    const d = gcDist(lat, lng, cLat, cLng)
    if (d < bestD) { bestD = d; best = z }
  }
  return { z: best, distNM: bestD }
}
// Minimum lateral deviation NM needed to clear polygon
// (approximated by distance from airframe to nearest polygon edge)
function reroutNM(f: SFlight, z: CcfpZone): number {
  const halfW = gcDist((z.latMin+z.latMax)/2, z.lngMin, (z.latMin+z.latMax)/2, z.lngMax) / 2
  const halfH = gcDist(z.latMin, (z.lngMin+z.lngMax)/2, z.latMax, (z.lngMin+z.lngMax)/2) / 2
  // crude: rerouteNM = half-width perpendicular to track + 15nm margin
  const tRad = (f.track || 0) * D2R
  const along = Math.abs(Math.sin(tRad))
  const r = (along * halfH + (1-along) * halfW) + 15
  return Math.min(r, 200)
}
// Motion-vector closure on airframe (kt, +ve = closing)
function closureKt(f: SFlight, z: CcfpZone): number {
  // zone motion direction = motionDeg (toward); airframe track = f.track
  // closure component along axis from zone-center to airframe
  const cLat = (z.latMin+z.latMax)/2
  const cLng = (z.lngMin+z.lngMax)/2
  const brgZA = Math.atan2(Math.sin((f.lng-cLng)*D2R)*Math.cos(f.lat*D2R),
    Math.cos(cLat*D2R)*Math.sin(f.lat*D2R) - Math.sin(cLat*D2R)*Math.cos(f.lat*D2R)*Math.cos((f.lng-cLng)*D2R)) * 180/Math.PI
  // angle between zone-motion direction and bearing-zone-to-airframe
  const dA = Math.abs(((z.motionDeg - brgZA + 540) % 360) - 180)
  // closure = motionKt * cos(dA)  (max when motion points toward airframe)
  return z.motionKt * Math.cos(dA * D2R)
}

interface Per {
  zone: CcfpZone | null
  zoneDistNM: number
  tieMin: number          // projected time-in-zone (min, 30-min horizon)
  topsDeltaFL: number     // topsFL - cruiseFL (>0 = airframe below tops, danger)
  closure: number         // closure kt
  reroute: number         // estimated lateral deviation NM
  covPct: number          // effective coverage %
  inScope: boolean        // FL150+ and not on-ground
  drivers: { COV:number; TOPS:number; CLOSURE:number; TIE:number; REROUTE:number; FLOW:number; CONF:number }
}
interface Row { f: SFlight; p: Per; score: number; tier: Tier }

const SRC='ccfp-src', ZONE_SRC='ccfp-zone-src', ROUTE_SRC='ccfp-route-src'
const HALO='ccfp-halo', PIN='ccfp-pin', LBL='ccfp-lbl', ZONE='ccfp-zone', ZONE_LBL='ccfp-zone-lbl', ROUTE_LN='ccfp-route-ln', ROUTE_LBL='ccfp-route-lbl'

export default function CcfpMonitor({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [regFilter, setRegFilter] = useState<Region|'ALL'>('ALL')
  const [validHr, setValidHr] = useState<2|4|6|8|'ALL'>('ALL')
  const [advMul, setAdvMul] = useState(100)
  const [covMul, setCovMul] = useState(100)
  const [horizon, setHorizon] = useState(30)        // forward-projection minutes
  const [floorFL, setFloorFL] = useState(150)
  const [topsBufFL, setTopsBufFL] = useState(40)    // FL buffer above tops to treat as clear
  const [confLowMul, setConfLowMul] = useState(60)  // LOW confidence weight %
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showZone, setShowZone] = useState(true)
  const [showRoute, setShowRoute] = useState(true)
  const [showOutOfScope, setShowOutOfScope] = useState(false)
  const [tab, setTab] = useState<'AIRCRAFT'|'EVENTS'|'ZONES'|'ROUTES'|'METHOD'>('AIRCRAFT')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Row|null>(null)

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      const FL = f.altitudeFt / 100
      const inScope = !f.ground && FL >= floorFL

      const { z, distNM } = nearestZone(f.lat, f.lng)
      const tieMin = z ? projTimeIn(f, z, horizon) : 0
      const topsDelta = z ? (z.topsFL - FL) : 0
      const cls = z ? closureKt(f, z) : 0
      const rer = z ? reroutNM(f, z) : 0
      let covPct = z ? COV_PCT[z.coverage] * 100 : 0
      // confidence weighting
      const confW = z?.conf === 'HIGH' ? 1 : (confLowMul/100)
      covPct *= confW
      covPct *= (covMul/100)

      // 7 drivers
      // COV — effective coverage at intersect (sparse/medium/solid)
      const D_COV = inScope && z ? ramp(covPct, 20, 95) * 0.95 : 0
      // TOPS — penalty if airframe is BELOW tops + buffer; rewarded if cruise above tops + buf
      let D_TOPS = 0
      if (inScope && z) {
        if (topsDelta >= -topsBufFL && topsDelta <= 30) D_TOPS = 70 + 25 * Math.max(0, Math.min(1, (topsDelta + topsBufFL) / (topsBufFL + 30)))
        else if (topsDelta > 30 && topsDelta < 80) D_TOPS = 90 + Math.min(10, topsDelta - 30)
        else if (topsDelta >= 80) D_TOPS = 100
        else D_TOPS = ramp(80 + topsDelta, 0, 80) * 0.45 // above tops + buf
      }
      // CLOSURE — zone motion closing on airframe
      const D_CLOSURE = inScope && z ? ramp(cls, 0, 60) * 0.55 : 0
      // TIE — time-in-zone (0..horizon min)
      const D_TIE = inScope && z ? ramp(tieMin, 0, horizon) * 0.95 : 0
      // REROUTE — large deviation needed = high impact
      const D_REROUTE = inScope && z ? ramp(rer, 20, 180) * 0.45 : 0
      // FLOW — active ATC flow program
      let D_FLOW = 0
      if (inScope && z) {
        D_FLOW = z.flow === 'AFP' ? 35 : z.flow === 'SWAP' ? 50 : z.flow === 'REROUTE' ? 25 : z.flow === 'GDP' ? 30 : 12
      }
      // CONF — high confidence = full credit; low = discounted
      const D_CONF = inScope && z ? (z.conf === 'HIGH' ? 18 : 8) : 0

      const drivers = { COV: D_COV, TOPS: D_TOPS, CLOSURE: D_CLOSURE, TIE: D_TIE, REROUTE: D_REROUTE, FLOW: D_FLOW, CONF: D_CONF }
      const vals = Object.values(drivers)
      const maxD = Math.max(...vals)
      const meanD = vals.reduce((a,b)=>a+b,0) / vals.length
      let score = (maxD * 0.62 + meanD * 0.38) * (advMul/100)

      // OUT-OF-SCOPE cap
      if (!inScope) score = Math.min(score, 14)

      // Hard escalators per CCFP/TCF operational doctrine
      // SOLID coverage + airframe BELOW tops + closing → CRITICAL
      if (inScope && z && z.coverage === 'SOLID' && topsDelta >= -topsBufFL && cls >= 25) score = Math.max(score, 86)
      // SOLID + tieMin >= 15 → at least HIGH
      if (inScope && z && z.coverage === 'SOLID' && tieMin >= 15) score = Math.max(score, 78)
      // Derecho-class (motion ≥ 50 kt + tops ≥ FL480) auto-CRITICAL inside
      if (inScope && z && distNM === 0 && z.motionKt >= 50 && z.topsFL >= 480) score = Math.max(score, 90)
      // MEDIUM with tops >> cruise FL + closing → ELEVATED at minimum
      if (inScope && z && z.coverage === 'MEDIUM' && topsDelta >= 30 && cls >= 15) score = Math.max(score, 48)
      // AFP active and inside polygon → at least ELEVATED
      if (inScope && z && z.flow === 'AFP' && distNM === 0) score = Math.max(score, 42)

      if (f.ground) score = 0
      score = Math.min(100, Math.max(0, score))

      let tier: Tier
      if (!inScope) tier = 'OUT-OF-SCOPE'
      else if (score >= 80) tier = 'CRITICAL'
      else if (score >= 60) tier = 'HIGH'
      else if (score >= 40) tier = 'ELEVATED'
      else if (score >= 22) tier = 'MARGINAL'
      else tier = 'NOMINAL'

      const p: Per = {
        zone: z, zoneDistNM: distNM, tieMin, topsDeltaFL: topsDelta,
        closure: cls, reroute: rer, covPct, inScope, drivers,
      }
      out.push({ f, p, score, tier })
    }
    return out.sort((a,b) => b.score - a.score)
  }, [flights, advMul, covMul, horizon, floorFL, topsBufFL, confLowMul])

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return rows.filter(r => {
      if (!showOutOfScope && r.tier === 'OUT-OF-SCOPE') return false
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (regFilter !== 'ALL' && (!r.p.zone || r.p.zone.region !== regFilter)) return false
      if (validHr !== 'ALL' && (!r.p.zone || r.p.zone.validHr !== validHr)) return false
      if (!ql) return true
      const cs = (r.f.callsign||r.f.icao).toLowerCase()
      const ty = (r.f.type||'').toLowerCase()
      const op = (r.f.operator||'').toLowerCase()
      const zn = (r.p.zone?.name || '').toLowerCase()
      const ar = (r.p.zone?.artcc || '').toLowerCase()
      const pb = (r.p.zone?.playbook || '').toLowerCase()
      return cs.includes(ql) || ty.includes(ql) || op.includes(ql) || zn.includes(ql) || ar.includes(ql) || pb.includes(ql)
    })
  }, [rows, tierFilter, regFilter, validHr, q, showOutOfScope])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { 'CRITICAL':0,'HIGH':0,'ELEVATED':0,'MARGINAL':0,'NOMINAL':0,'OUT-OF-SCOPE':0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const summary = useMemo(() => {
    const inS = rows.filter(r => r.p.inScope)
    const elev = rows.filter(r => r.tier==='CRITICAL'||r.tier==='HIGH'||r.tier==='ELEVATED')
    const totalRer = elev.reduce((s,r)=>s+r.p.reroute, 0)
    const totalTie = elev.reduce((s,r)=>s+r.p.tieMin, 0)
    return {
      nCrit: tierCounts.CRITICAL, nHigh: tierCounts.HIGH, nElev: tierCounts.ELEVATED,
      muRer: elev.length ? totalRer/elev.length : 0,
      muTie: elev.length ? totalTie/elev.length : 0,
      nInScope: inS.length,
      nInZone: rows.filter(r => r.p.zone && r.p.zoneDistNM === 0 && r.p.inScope).length,
    }
  }, [rows, tierCounts])

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const apply = () => {
      try {
        const live = filtered.filter(r => r.tier !== 'OUT-OF-SCOPE' && r.tier !== 'NOMINAL')

        const haloFeat = live.map(r => ({
          type:'Feature' as const,
          geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat]},
          properties:{
            color: TIER_COLOR[r.tier], score: r.score, tier: r.tier,
            label: `${r.f.callsign||r.f.icao} CCFP ${r.tier} · ${r.p.zone?.name||'—'} · ${r.p.tieMin}min · Δ${r.p.reroute.toFixed(0)}NM`
          }
        }))

        // CCFP zone footprint as polygons with coverage-shaded fill
        const zoneFeat = CCFP_ZONES
          .filter(z => regFilter==='ALL' || z.region===regFilter)
          .filter(z => validHr==='ALL' || z.validHr===validHr)
          .map(z => {
            const fill = z.coverage==='SOLID' ? '#7f1d1d'
                      : z.coverage==='MEDIUM' ? '#7c2d12'
                      : '#451a03'
            const stroke = z.flow==='AFP' || z.flow==='SWAP' ? '#f43f5e'
                        : z.flow==='REROUTE' ? '#f59e0b'
                        : '#fb923c'
            return {
              type:'Feature' as const,
              geometry:{
                type:'Polygon' as const,
                coordinates:[[
                  [z.lngMin, z.latMin],
                  [z.lngMax, z.latMin],
                  [z.lngMax, z.latMax],
                  [z.lngMin, z.latMax],
                  [z.lngMin, z.latMin],
                ]]
              },
              properties:{
                label: `${z.name} · ${z.coverage} · FL${z.topsFL} · ${z.motionDeg.toFixed(0)}°/${z.motionKt}kt · ${z.validHr}h ${z.conf}`,
                region: z.region,
                fill,
                opacity: z.coverage==='SOLID' ? 0.32 : z.coverage==='MEDIUM' ? 0.22 : 0.14,
                stroke,
                strokeW: z.flow==='AFP' || z.flow==='SWAP' ? 2.2 : z.flow==='REROUTE' ? 1.8 : 1.2,
              }
            }
          })

        // Motion-vector arrow lines (zone center -> motion direction projection)
        const routeFeat = CCFP_ZONES
          .filter(z => regFilter==='ALL' || z.region===regFilter)
          .filter(z => validHr==='ALL' || z.validHr===validHr)
          .map(z => {
            const cLat = (z.latMin+z.latMax)/2
            const cLng = (z.lngMin+z.lngMax)/2
            // project 60min motion
            const p = projectForward(cLat, cLng, z.motionDeg, z.motionKt, 60)
            return {
              type:'Feature' as const,
              geometry:{ type:'LineString' as const, coordinates:[[cLng, cLat],[p.lng, p.lat]] },
              properties:{
                stroke: z.flow==='AFP' || z.flow==='SWAP' ? '#f43f5e' : z.flow==='REROUTE' ? '#f59e0b' : '#fb923c',
                label: `${z.motionDeg.toFixed(0)}°/${z.motionKt}kt · ${z.playbook}`,
              }
            }
          })

        const haloFc:any = { type:'FeatureCollection', features: haloFeat }
        const zoneFc:any = { type:'FeatureCollection', features: zoneFeat }
        const routeFc:any = { type:'FeatureCollection', features: routeFeat }

        for (const [id, fc] of [[SRC, haloFc], [ZONE_SRC, zoneFc], [ROUTE_SRC, routeFc]] as const) {
          const src = map.getSource(id) as any
          if (src) src.setData(fc); else map.addSource(id, { type:'geojson', data: fc })
        }

        if (showZone && !map.getLayer(ZONE)) map.addLayer({ id: ZONE, type:'fill', source: ZONE_SRC,
          paint:{
            'fill-color':['get','fill'],
            'fill-opacity':['get','opacity'],
            'fill-outline-color':['get','stroke'],
          } })
        if (!showZone && map.getLayer(ZONE)) map.removeLayer(ZONE)

        if (showZone && !map.getLayer(ZONE_LBL)) map.addLayer({ id: ZONE_LBL, type:'symbol', source: ZONE_SRC,
          layout:{ 'text-field':['get','label'], 'text-size':9.5, 'symbol-placement':'point', 'text-allow-overlap':false },
          paint:{ 'text-color':'#fb923c', 'text-halo-color':'#020617', 'text-halo-width':1.2 } })
        if (!showZone && map.getLayer(ZONE_LBL)) map.removeLayer(ZONE_LBL)

        if (showRoute && !map.getLayer(ROUTE_LN)) map.addLayer({ id: ROUTE_LN, type:'line', source: ROUTE_SRC,
          paint:{
            'line-color':['get','stroke'],
            'line-width':1.6,
            'line-dasharray':[2, 2],
            'line-opacity':0.85,
          } })
        if (!showRoute && map.getLayer(ROUTE_LN)) map.removeLayer(ROUTE_LN)

        if (showRoute && !map.getLayer(ROUTE_LBL)) map.addLayer({ id: ROUTE_LBL, type:'symbol', source: ROUTE_SRC,
          layout:{ 'text-field':['get','label'], 'text-size':8.5, 'symbol-placement':'line-center', 'text-allow-overlap':false },
          paint:{ 'text-color':'#fb923c', 'text-halo-color':'#020617', 'text-halo-width':1.0 } })
        if (!showRoute && map.getLayer(ROUTE_LBL)) map.removeLayer(ROUTE_LBL)

        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id: HALO, type:'circle', source: SRC,
          paint:{
            'circle-radius':['+',6,['/',['get','score'],7]],
            'circle-color':['get','color'],
            'circle-opacity':0.17,
            'circle-stroke-color':['get','color'],
            'circle-stroke-width':1.2,
            'circle-stroke-opacity':0.85,
          }})
        if (!showHalo && map.getLayer(HALO)) map.removeLayer(HALO)

        if (showPin && !map.getLayer(PIN)) map.addLayer({ id: PIN, type:'circle', source: SRC,
          filter:['in',['get','tier'],['literal',['CRITICAL','HIGH']]],
          paint:{ 'circle-radius':3.8, 'circle-color':'#fff',
            'circle-stroke-color':['get','color'], 'circle-stroke-width':2.2 }})
        if (!showPin && map.getLayer(PIN)) map.removeLayer(PIN)

        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id: LBL, type:'symbol', source: SRC,
          filter:['in',['get','tier'],['literal',['CRITICAL','HIGH']]],
          layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-allow-overlap':false },
          paint:{ 'text-color':['get','color'], 'text-halo-color':'#020617', 'text-halo-width':1.3 }})
        if (!showLbl && map.getLayer(LBL)) map.removeLayer(LBL)
      } catch {}
    }
    if (map.isStyleLoaded()) apply(); else map.once('load', apply)
    return () => {
      try {
        for (const id of [LBL, PIN, HALO, ROUTE_LBL, ROUTE_LN, ZONE_LBL, ZONE]) if (map.getLayer(id)) map.removeLayer(id)
        for (const id of [SRC, ZONE_SRC, ROUTE_SRC]) if (map.getSource(id)) map.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl, showZone, showRoute, regFilter, validHr])

  return (
    <div className="absolute right-3 top-20 z-30 w-[480px] max-h-[82vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">CCFP</div>
        <div className="text-[10px] text-slate-400 truncate">Collab Convective Forecast · Tactical Re-Route Solver · TCF / Playbook / CDR / AFP</div>
        <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
      </div>

      {/* tier strip */}
      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[7.5px]" style={{color: TIER_COLOR[t]}}>{t.replace('OUT-OF-SCOPE','OOS')}</div>
            <div className="text-slate-100 font-semibold tabular-nums">{tierCounts[t]}</div>
          </button>
        ))}
      </div>

      {/* summary */}
      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px] tabular-nums">
        <div><div className="text-[8px] text-slate-500">Σ-CRIT</div><div style={{color:summary.nCrit>0?TIER_COLOR['CRITICAL']:'#e2e8f0'}}>{summary.nCrit}</div></div>
        <div><div className="text-[8px] text-slate-500">Σ-HIGH</div><div style={{color:summary.nHigh>0?TIER_COLOR['HIGH']:'#e2e8f0'}}>{summary.nHigh}</div></div>
        <div><div className="text-[8px] text-slate-500">Σ-ELEV</div><div style={{color:summary.nElev>0?TIER_COLOR['ELEVATED']:'#e2e8f0'}}>{summary.nElev}</div></div>
        <div><div className="text-[8px] text-slate-500">μ-REROUTE</div><div className="text-slate-100">{summary.muRer.toFixed(0)}NM</div></div>
        <div><div className="text-[8px] text-slate-500">μ-TIE</div><div className="text-slate-100">{summary.muTie.toFixed(0)}min</div></div>
        <div><div className="text-[8px] text-slate-500">IN-ZONE</div><div className="text-slate-100">{summary.nInZone}</div></div>
      </div>

      {/* sliders */}
      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800/60 text-[9.5px]">
        <label className="flex flex-col">
          <span className="text-slate-400">ADV-MUL {advMul}%</span>
          <input type="range" min={50} max={200} value={advMul} onChange={e=>setAdvMul(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">COV-MUL {covMul}%</span>
          <input type="range" min={50} max={200} value={covMul} onChange={e=>setCovMul(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">HORIZON {horizon}min</span>
          <input type="range" min={5} max={60} step={5} value={horizon} onChange={e=>setHorizon(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">FL-FLOOR {floorFL}</span>
          <input type="range" min={50} max={300} step={10} value={floorFL} onChange={e=>setFloorFL(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">TOPS-BUF {topsBufFL}FL</span>
          <input type="range" min={0} max={100} step={5} value={topsBufFL} onChange={e=>setTopsBufFL(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">CONF-LOW {confLowMul}%</span>
          <input type="range" min={20} max={100} step={5} value={confLowMul} onChange={e=>setConfLowMul(+e.target.value)} className="accent-sky-500"/>
        </label>
      </div>

      {/* region + valid-hr filter */}
      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60">
        <span className="text-[8.5px] text-slate-500 self-center">ARTCC:</span>
        <button onClick={()=>setRegFilter('ALL')} className={`text-[9px] px-1.5 py-0.5 rounded border ${regFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400'}`}>ALL</button>
        {REGION_LIST.map(r => (
          <button key={r} onClick={()=>setRegFilter(regFilter===r?'ALL':r)}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${regFilter===r?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400'}`}>{r}</button>
        ))}
        <span className="text-[8.5px] text-slate-500 self-center ml-2">VALID:</span>
        <button onClick={()=>setValidHr('ALL')} className={`text-[9px] px-1.5 py-0.5 rounded border ${validHr==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400'}`}>ALL</button>
        {([2,4,6,8] as const).map(h => (
          <button key={h} onClick={()=>setValidHr(validHr===h?'ALL':h)}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${validHr===h?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400'}`}>{h}h</button>
        ))}
      </div>

      {/* toggles */}
      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60">
        <span className="flex-1"/>
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['ZONE',showZone,setShowZone],['ROUTE',showRoute,setShowRoute],['OOS',showOutOfScope,setShowOutOfScope]] as const).map(([lbl,on,fn]:any) => (
          <button key={lbl} onClick={()=>fn(!on)} className={`text-[8.5px] px-1.5 py-0.5 rounded border ${on?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-500'}`}>{lbl}</button>
        ))}
      </div>

      {/* tabs */}
      <div className="flex border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','EVENTS','ZONES','ROUTES','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`flex-1 py-1.5 ${tab===t?'bg-sky-500/15 text-sky-200 border-b border-sky-500/60':'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {/* search */}
      <div className="px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / type / operator / artcc / zone / playbook"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600"/>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.slice(0, 80).map((r, i) => (
              <div key={r.f.icao+i} className={`px-3 py-2 hover:bg-slate-900/40 cursor-pointer ${sel?.f.icao===r.f.icao?'bg-slate-900/60':''}`}
                onClick={() => { setSel(r); onFly(r.f.icao) }}>
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="font-semibold text-slate-100 tabular-nums">{r.f.callsign||r.f.icao}</span>
                  <span className="text-slate-500 text-[9.5px]">{r.f.type||'—'}</span>
                  <span className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-400">{r.p.zone?.artcc||'—'}</span>
                  <span className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800"
                    style={{color: r.p.zone?.coverage==='SOLID'?'#f43f5e':r.p.zone?.coverage==='MEDIUM'?'#f59e0b':r.p.zone?.coverage==='SPARSE'?'#0ea5e9':'#64748b'}}>
                    {r.p.zone?.coverage||'—'}
                  </span>
                  <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded" style={{color: TIER_COLOR[r.tier], background: TIER_COLOR[r.tier]+'18', border:`1px solid ${TIER_COLOR[r.tier]}66`}}>{r.tier}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1.5 text-[9.5px] tabular-nums text-slate-300">
                  <div><span className="text-slate-500">FL </span>{(r.f.altitudeFt/100).toFixed(0)}</div>
                  <div><span className="text-slate-500">TOPS </span>{r.p.zone?'FL'+r.p.zone.topsFL:'—'}</div>
                  <div><span className="text-slate-500">TIE </span>{r.p.tieMin}min</div>
                  <div><span className="text-slate-500">Δ</span>{r.p.reroute.toFixed(0)}NM</div>
                </div>
                <div className="h-1.5 mt-1.5 rounded-full bg-slate-800 overflow-hidden">
                  <div className="h-full" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }}/>
                </div>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {Object.entries(r.p.drivers).map(([k,v]) => (
                    <span key={k} className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-400">
                      {k} <span className="text-slate-200 tabular-nums">{(v as number).toFixed(0)}</span>
                    </span>
                  ))}
                </div>
                <div className="mt-1.5 text-[9.5px] leading-snug" style={{color: TIER_COLOR[r.tier]}}>
                  {r.tier==='CRITICAL' && `CRITICAL · projected ${r.p.tieMin}min in ${r.p.zone?.name||'polygon'} (${r.p.zone?.coverage}) · tops ${r.p.zone?'FL'+r.p.zone.topsFL:'—'} vs cruise FL${(r.f.altitudeFt/100).toFixed(0)} · closure ${r.p.closure.toFixed(0)}kt · deviate ${r.p.reroute.toFixed(0)}NM via ${r.p.zone?.playbook} · ${r.p.zone?.flow} active`}
                  {r.tier==='HIGH' && `HIGH · ${r.p.tieMin}min projected in polygon · request lateral deviation ${r.p.reroute.toFixed(0)}NM cross-track via ${r.p.zone?.playbook} or climb above FL${r.p.zone?.topsFL||'—'}+${topsBufFL}`}
                  {r.tier==='ELEVATED' && `ELEVATED · monitor convective polygon ${r.p.zone?.name} closing ${r.p.closure.toFixed(0)}kt · standby for ${r.p.zone?.flow} routing per ATCSCC Playbook ${r.p.zone?.playbook}`}
                  {r.tier==='MARGINAL' && `MARGINAL · within ${r.p.zoneDistNM.toFixed(0)}NM of ${r.p.zone?.name||'polygon'} · ${r.p.zone?.validHr||'—'}h forecast horizon · no flow program active`}
                  {r.tier==='NOMINAL' && `Nominal · no significant convective conflict on projected track`}
                  {r.tier==='OUT-OF-SCOPE' && `Out-of-scope · FL${(r.f.altitudeFt/100).toFixed(0)} below floor or ground · CCFP applies to cruise FL${floorFL}+`}
                </div>
              </div>
            ))}
            {!filtered.length && <div className="px-3 py-6 text-center text-[10px] text-slate-500">no airframes match filters · {summary.nCrit+summary.nHigh+summary.nElev} elevated / {summary.nInZone} inside polygons of {rows.length} tracked</div>}
          </div>
        )}

        {tab === 'EVENTS' && (
          <div className="divide-y divide-slate-800/60">
            {[
              { id:'DAL191',  date:'1985-08-02', ac:'L-1011-385', reg:'N726DA',  loc:'DFW 17L approach',         fatal:137, region:'GP',  cls:'MICROBURST',ref:'NTSB AAR-86/05',
                narrative:'CB approach microburst from rapidly-developing cell over DFW · 137 fatalities including 1 on ground · drove TDWR/LLWAS-NE deployment + windshear-detection mandate per FAR 121.358. Canonical convective-avoidance breakdown case for CCFP/TCF doctrine.' },
              { id:'PAA759',  date:'1982-07-09', ac:'B727-235',   reg:'N4737',   loc:'MSY takeoff RWY10',        fatal:153, region:'GLF', cls:'MICROBURST',ref:'NTSB AAR-83/02',
                narrative:'CB downburst on Pan Am 759 climbout from MSY · 145 PAX + 8 crew + 8 on ground · drove NWS LLWAS Phase II network and FAA crew-windshear-recovery training programme.' },
              { id:'EAL66',   date:'1975-06-24', ac:'B727-225',   reg:'N8845E',  loc:'JFK 22L approach',         fatal:113, region:'NE',  cls:'MICROBURST',ref:'NTSB AAR-76/08',
                narrative:'Frontal microburst at JFK · first formally-identified convective downburst loss · led to Fujita microburst doctrine, LLWAS prototype at Stapleton, and FAA Convective SIGMET Wx product chartering.' },
              { id:'US1016',  date:'1994-07-02', ac:'DC-9-31',    reg:'N954VJ',  loc:'CLT 18R approach',         fatal:37,  region:'SE',  cls:'MICROBURST',ref:'NTSB AAR-95/03',
                narrative:'CB microburst on USAir 1016 approach CLT · windshear recovery initiated too late · 37 of 57 fatal · catalysed cockpit-windshear-detection retrofit per FAA AD 95-NM-09.' },
              { id:'AAL1420', date:'1999-06-01', ac:'MD-82',      reg:'N215AA',  loc:'LIT 04R landing',          fatal:11,  region:'GP',  cls:'CONV-OVRN', ref:'NTSB AAR-01/02',
                narrative:'Convective-cell landing AA 1420 LIT · approach continued into Level-6 cell · runway overrun · 11 of 145 fatal · cited as canonical convective approach-continuation case for CCFP/AC 00-24C guidance.' },
              { id:'SOU242',  date:'1977-04-04', ac:'DC-9-31',    reg:'N1335U',  loc:'New Hope GA cruise',       fatal:72,  region:'SE',  cls:'HAIL-FLAMEOUT',ref:'NTSB AAR-78/03',
                narrative:'Southern 242 large-hail penetration of Level-5 cell · dual engine flameout · forced landing on GA-92 · 72 fatal including 8 on ground · canonical hail-avoidance lesson cited in SAFO 16002 and AC 00-24C.' },
              { id:'AFR358',  date:'2005-08-02', ac:'A340-313',   reg:'F-GLZQ',  loc:'YYZ 24L landing',          fatal:0,   region:'NE',  cls:'CONV-OVRN', ref:'TSB A05H0002',
                narrative:'Convective-cell approach AF 358 YYZ · severe thunderstorm 1/4nm short · runway overrun + hull-loss fire · all 309 evacuated · drove convective-go-around doctrine in IATA OPS 044 and TC AC 700-040.' },
              { id:'CYM883',  date:'2010-11-04', ac:'ATR-72-212', reg:'CU-T1549',loc:'Guasimal CU cruise',       fatal:68,  region:'SE',  cls:'CONV-PEN',  ref:'IACC CU',
                narrative:'Aerocaribbean 883 penetration of CB line over central Cuba en-route SCU-HAV · LOC-I in IMC · 68 fatal · cited as Caribbean-corridor convective lesson for ICAO NAM/CAR Region.' },
              { id:'PX73',    date:'2018-09-28', ac:'B737-800',   reg:'P2-PXE',  loc:'TKK approach',             fatal:1,   region:'SE',  cls:'CONV-OVRN', ref:'AICPNG',
                narrative:'Air Niugini 73 approach Chuuk Lagoon · convective-rain CB on final · short-of-runway water touchdown · 1 of 47 fatal · cited in PASO Convective Approach Guidance 2020.' },
              { id:'ATI3591', date:'2019-02-23', ac:'B767-375BCF',reg:'N1217A',  loc:'Trinity Bay TX descent',   fatal:3,   region:'GLF', cls:'CONV-AVOID',ref:'NTSB DCA19MA086',
                narrative:'Atlas 3591 convective deflection during descent IAH · spurious GA mode + nose-down pitch upset in convective IMC · 3 fatal · convective avoidance manoeuvring cited as triggering chain · drove SAFO 19010 mode-confusion training.' },
              { id:'CSC3U8665',date:'2022-06-15', ac:'A319-115',   reg:'B-6171',  loc:'CGQ cruise',               fatal:0,   region:'SE',  cls:'HAIL-DMG',  ref:'CAAC',
                narrative:'Sichuan 3U8665 hail penetration of CB · radome shredded + leading-edge dents · diverted Changchun · canonical example of need for CCFP/TCF SOLID-polygon avoidance during summer convective season.' },
              { id:'CON426',  date:'1980-08-07', ac:'DC-10-10',   reg:'N68045',  loc:'TWF FL370',                fatal:0,   region:'FR',  cls:'HAIL-DMG',  ref:'NTSB-LAX80FA251',
                narrative:'Continental 426 cruise hail-impact penetration of supercell over S-ID/N-UT · radome + leading edges + windshield damage · diverted SLC · drove cabin-PA hail-deviation procedures in DAL/UAL/AA FOM.' },
              { id:'UA826',   date:'1997-12-28', ac:'B747-122',   reg:'N4723U',  loc:'N-PAC FL310',              fatal:1,   region:'PNW', cls:'CONV-TURB', ref:'NTSB AAB-00/03',
                narrative:'United 826 severe clear-air turbulence near convective tops over N-Pacific · 1 fatal + 18 serious-injury · cited as benchmark for projecting CCFP polygons beyond CONUS into oceanic FIRs (Oakland / Anchorage).' },
            ].map(pr => (
              <div key={pr.id} className="px-3 py-2">
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-[9px] px-1.5 py-0.5 rounded border font-semibold border-rose-800/60 bg-rose-900/20 text-rose-300">{pr.cls}</span>
                  <span className="text-slate-100 font-semibold">{pr.id}</span>
                  <span className="text-slate-400 text-[9.5px]">{pr.ac}</span>
                  <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-400">{pr.region}</span>
                </div>
                <div className="grid grid-cols-3 gap-1 mt-1 text-[9.5px] tabular-nums text-slate-300">
                  <div><span className="text-slate-500">DATE </span>{pr.date}</div>
                  <div><span className="text-slate-500">REG </span>{pr.reg}</div>
                  <div><span className="text-slate-500">FATAL </span><span className={pr.fatal>0?'text-rose-300':'text-emerald-300'}>{pr.fatal}</span></div>
                </div>
                <div className="text-[9px] text-slate-400 mt-0.5">{pr.loc}</div>
                <div className="text-[9px] text-slate-400 mt-0.5 italic">{pr.ref}</div>
                <div className="text-[9.5px] text-slate-300 mt-1 leading-snug">{pr.narrative}</div>
              </div>
            ))}
            <div className="px-3 py-3 text-[9px] leading-snug text-slate-500 border-t border-slate-800">
              <span className="text-slate-300">Event taxonomy:</span><br/>
              <span className="text-rose-300">MICROBURST</span> — wet/dry downburst on takeoff or approach<br/>
              <span className="text-rose-300">HAIL-FLAMEOUT</span> — large-hail engine ingestion / dual flameout<br/>
              <span className="text-rose-300">HAIL-DMG</span> — radome / leading-edge / windshield hail damage<br/>
              <span className="text-rose-300">CONV-OVRN</span> — approach continuation into convective cell → runway overrun<br/>
              <span className="text-rose-300">CONV-PEN</span> — en-route penetration of CB line / LOC-I<br/>
              <span className="text-rose-300">CONV-AVOID</span> — convective-avoidance manoeuvring contributing to upset<br/>
              <span className="text-rose-300">CONV-TURB</span> — severe clear-air turbulence near convective tops
            </div>
          </div>
        )}

        {tab === 'ZONES' && (
          <div className="divide-y divide-slate-800/60">
            {CCFP_ZONES.filter(z => regFilter==='ALL' || z.region===regFilter).filter(z => validHr==='ALL' || z.validHr===validHr).map(z => {
              const flightsIn = rows.filter(r => r.p.zone?.name === z.name && r.p.zoneDistNM === 0 && r.p.inScope).length
              const flightsNear = rows.filter(r => r.p.zone?.name === z.name && r.p.zoneDistNM > 0 && r.p.zoneDistNM < 250 && r.p.inScope).length
              const elevIn = rows.filter(r => r.p.zone?.name === z.name && (r.tier==='CRITICAL'||r.tier==='HIGH'||r.tier==='ELEVATED')).length
              const covColor = z.coverage==='SOLID'?'#f43f5e':z.coverage==='MEDIUM'?'#f59e0b':'#0ea5e9'
              const flowColor = z.flow==='AFP'?'#f43f5e':z.flow==='SWAP'?'#fb7185':z.flow==='REROUTE'?'#f59e0b':z.flow==='GDP'?'#0ea5e9':'#64748b'
              return (
                <div key={z.name} className="px-3 py-2 hover:bg-slate-900/40">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-[9px] px-1.5 py-0.5 rounded border border-slate-800 font-semibold text-orange-300">{z.artcc}</span>
                    <span className="text-slate-100 font-semibold">{z.name}</span>
                    <span className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800" style={{color: covColor}}>{z.coverage}</span>
                    <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800" style={{color: flowColor}}>{z.flow}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-1 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">TOPS </span>FL{z.topsFL}</div>
                    <div><span className="text-slate-500">MOTION </span>{z.motionDeg.toFixed(0)}°/{z.motionKt}kt</div>
                    <div><span className="text-slate-500">VALID </span>{z.validHr}h {z.conf}</div>
                    <div><span className="text-slate-500">PLAYBOOK </span>{z.playbook}</div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-1 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">IN </span>{flightsIn}</div>
                    <div><span className="text-slate-500">NEAR </span>{flightsNear}</div>
                    <div><span className="text-slate-500">ELEV </span><span style={{color:elevIn>0?'#f59e0b':'#e2e8f0'}}>{elevIn}</span></div>
                    <div className="truncate"><span className="text-slate-500">REF </span>{z.ref}</div>
                  </div>
                  <div className="text-[9px] text-slate-500 mt-0.5">
                    box: {z.latMin}…{z.latMax}° / {z.lngMin}…{z.lngMax}°
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'ROUTES' && (
          <div className="divide-y divide-slate-800/60">
            {PLAYBOOK.map(pb => {
              const usingZone = CCFP_ZONES.find(z => z.playbook === pb.id)
              const flightsUsing = rows.filter(r => r.p.zone?.playbook === pb.id && (r.tier==='CRITICAL'||r.tier==='HIGH'||r.tier==='ELEVATED')).length
              const statusColor = pb.status==='ACTIVE' ? '#f43f5e' : pb.status==='STANDBY' ? '#f59e0b' : '#64748b'
              return (
                <div key={pb.id} className="px-3 py-2">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-[9px] px-1.5 py-0.5 rounded border border-slate-800 font-semibold text-sky-300">{pb.id}</span>
                    <span className="text-slate-100 font-semibold">{pb.label}</span>
                    <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded" style={{color: statusColor, background: statusColor+'18', border:`1px solid ${statusColor}66`}}>{pb.status}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1 mt-1 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">FLOW </span>{pb.flow}</div>
                    <div><span className="text-slate-500">START </span>+{pb.startHr}h</div>
                    <div><span className="text-slate-500">DUR </span>{pb.durHr}h</div>
                  </div>
                  <div className="text-[9px] text-slate-400 mt-0.5 italic font-mono">VIA: {pb.via}</div>
                  <div className="text-[9px] text-slate-400 mt-0.5">REASON: {pb.reason}</div>
                  {usingZone && (
                    <div className="text-[9px] mt-0.5"><span className="text-slate-500">DRIVER: </span><span className="text-amber-300">{usingZone.name}</span> · {flightsUsing} elevated airframes</div>
                  )}
                </div>
              )
            })}
            <div className="px-3 py-3 text-[9px] leading-snug text-slate-500 border-t border-slate-800">
              <span className="text-slate-300">National Severe Weather Playbook</span> · pre-coordinated lateral-deviation routes published by ATCSCC for use during convective SWAP / AFP / GDP events. Each route is a string of waypoint/airway segments and a target arrival fix, with established LOA between affected ARTCC pairs. CDR / PCDR codes are the FAA Coded Departure Routes / Preferential CDR pulled directly from FAA NFDC CDR Database via NASR cycle.
            </div>
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="px-3 py-2 text-[9.5px] leading-snug text-slate-300 space-y-2">
            <div>
              <div className="text-[10px] text-sky-300 font-semibold mb-1">Definition · TCF / CCFP per AWC + CDM CW-PT</div>
              <div>CCFP (1998-2014) / TCF (2014-) is the 2/4/6/8-hour convective forecast polygon product issued every 2 hours by NWS Aviation Weather Center via the FAA CDM Convective Weather PT. Each polygon carries (a) coverage class SPARSE 25-39% / MEDIUM 40-74% / SOLID 75-100% · (b) cloud tops FL · (c) directional motion vector (deg / kt) · (d) forecast-valid horizon 2/4/6/8 hr · (e) confidence HIGH/LOW (CCFP only — TCF dropped). Drives strategic ATC flow programmes (AFP/GDP/Reroute/SWAP) and per-airframe tactical lateral deviations.</div>
            </div>
            <div>
              <div className="text-[10px] text-sky-300 font-semibold mb-1">Scorer · 7 drivers</div>
              <div className="text-[9px]">
                <span className="text-slate-200">composite</span> = (max·0.62 + mean·0.38) × ADV-MUL with OUT-OF-SCOPE cap at 14<br/>
                <span className="text-amber-200">COV</span> coverage % at intersect (CDM 25/40/75 thresholds) × CONF<br/>
                <span className="text-amber-200">TOPS</span> tops-FL vs cruise-FL ± TOPS-BUF buffer<br/>
                <span className="text-amber-200">CLOSURE</span> motion-vector closure component onto airframe (kt)<br/>
                <span className="text-amber-200">TIE</span> projected time-in-zone over HORIZON minutes (5-60 min)<br/>
                <span className="text-amber-200">REROUTE</span> estimated lateral deviation NM to clear<br/>
                <span className="text-amber-200">FLOW</span> ATC flow program in effect (AFP/SWAP/Reroute/GDP)<br/>
                <span className="text-amber-200">CONF</span> forecast confidence HIGH/LOW
              </div>
            </div>
            <div>
              <div className="text-[10px] text-sky-300 font-semibold mb-1">Hard escalators</div>
              <div className="text-[9px]">
                SOLID + closure ≥ 25 kt + airframe BELOW tops → ≥ 86 CRITICAL<br/>
                SOLID + TIE ≥ 15 min → ≥ 78 HIGH<br/>
                Derecho-class inside (motion ≥ 50 kt + tops ≥ FL480) → ≥ 90<br/>
                MEDIUM + tops &gt;&gt; cruise + closing ≥ 15 kt → ≥ 48 ELEVATED<br/>
                AFP active and inside polygon → ≥ 42<br/>
                Out-of-scope (FL &lt; floor or ground) capped at 14
              </div>
            </div>
            <div>
              <div className="text-[10px] text-sky-300 font-semibold mb-1">Forward projection</div>
              <div className="text-[9px]">
                Each airframe is stepped 1-minute increments along great-circle track (heading × ground speed) over the HORIZON window. TIE counts minutes the projected position falls inside any polygon. REROUTE is approximated as half-polygon-width perpendicular to track + 15 NM margin (capped at 200 NM).
              </div>
            </div>
            <div>
              <div className="text-[10px] text-sky-300 font-semibold mb-1">Distinct from</div>
              <div className="text-[9px]">
                HIWC (ice-crystal at FL280-FL400 INVISIBLE to radar — CCFP is visible-radar liquid + graupel) · TROPO (tropopause buffet — CCFP is mid-tropospheric tops) · TURB/EDR (clear-air kinematic — CCFP is moist-convective thermodynamic) · CONTRAIL (Schmidt-Appleman) · WAFS-WIND (en-route wind aloft optimisation) · JETSTREAM (wind-vector chase) · TCAM-CYCLONE (tropical cyclone tracking) · SHEAR-ATLAS (low-level terminal wind shear) · PWS (airborne nowcast radar) · WXAD (radar tilt advisor — CCFP is the forecast polygon the radar is tuned to verify) · ICING-NM (Appx O low-alt SLD) · ALT-FREEZ (freezing-level) · METAR/TAF (point forecasts) · SIGMET-WS (tactical ≤ 2-hr cell alert — CCFP is the strategic 2-8 hr forecast polygon set the SIGMET later confirms). CCFP uniquely is the strategic + tactical convective-avoidance solver linking forecast polygon × per-airframe 4-D track × Playbook reroute / CDR / AFP / SWAP applicability.
              </div>
            </div>
            <div className="text-[9px] text-slate-500 border-t border-slate-800 pt-2 leading-snug">
              <span className="text-slate-300">References:</span> FAA Order JO 7110.65 §2-6 / §6-1-6 / §6-7-1 Severe Weather Avoidance · AIM 7-1-12 Thunderstorms / 7-1-15 Severe Wx Forecasts · AC 00-24C Thunderstorms · AC 00-30B Atmospheric Turbulence Avoidance · AC 00-45H Aviation Weather Services · AC 120-88A Turbulence Injury Prevention · ICAO Annex 3 §4.4 / Appx 5 Convective SIGMET WS · ICAO Doc 8896 Manual of Aeronautical Met Practice · ICAO Doc 7030 Regional Supps · NWS AWC TCF Product Spec 04-Mar-2014 · FAA CDM Convective Wx PT 2004-2024 minutes · MIT-LL ATM 312 CCFP Verification 2002 · MIT-LL ATC-345 Conv Wx Forecast Evaluation 2008 · NCAR RAL CIWS spec · RTCA DO-340 Operational Services Conv Wx · RTCA DO-308 Conv Wx Avoidance · EUROCONTROL DCB/COFLIGHT convective module · National Severe Wx Playbook Ed 2024 · FAA ATCSCC SWAP Manual · FAA CDR Database 2024 · NTSB AAR-78/03 Southern 242 / AAR-76/08 Eastern 66 / AAR-83/02 Pan Am 759 / AAR-86/05 Delta 191 / AAR-95/03 USAir 1016 / AAR-01/02 AA 1420 / DCA19MA086 Atlas 3591 / AAB-00/03 UA 826 · TSB A05H0002 AF358 · IACC Aerocaribbean 883 · AICPNG Air Niugini 73 · CAAC Sichuan 3U8665 · NWS PD-10-811 Convective SIGMET Prod · FAA SAFO 16002 Avoiding Hailstones · FAA SAFO 19010 Mode Confusion · FAR 121.358 LLWAS · NTSB-LAX80FA251 Continental 426.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
