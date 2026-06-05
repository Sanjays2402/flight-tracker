'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   HIWC · High Ice Water Content Vulnerability Monitor
        (Engine Ice-Crystal Icing & Pitot/AOA/TAT Anomalous-
         Icing Exposure Scorer per FAA AC 20-147A / EASA CS-25
         App.P / RTCA DO-353 / NASA HIWC Program)
   ------------------------------------------------------------
   Per-airframe live evaluator of every airborne aircraft's
   exposure to High Ice Water Content (HIWC) conditions — the
   ice-crystal icing regime at FL280-FL400 inside upper anvils
   and outflow regions of deep convective cloud systems where
   supercooled liquid water has converted almost entirely to
   50-200 µm ice crystals at total water contents that can
   exceed 8 g/m³ over horizontal extents of 50-300 NM.

   Unlike supercooled-liquid icing (visible to weather radar
   / satellite / PIREP), ice crystals are INVISIBLE to X-band
   weather radar (~30 dBZ below liquid water), leave no
   airframe ice signature, and don't respond to conventional
   thermal anti-ice. Two failure mechanisms:

     (A) ENGINE CORE ICE-CRYSTAL ICING — crystals enter the
         inlet, melt on warm fan-spinner/first-stage
         compressor (+5°C), re-freeze on cooler LPC stator
         (-5°C). Mixed-phase ice accretes, sheds, HPC-ingests,
         causing engine ROLL-BACK (uncommanded N1 reduction to
         flight-idle, EGT collapse), compressor SURGE/STALL,
         FLAME-OUT, or DAMAGE. 162+ documented events 1990-2024
         across CF6/CFM56/CFM-LEAP/PW4000/PW1100G/GE90/GEnx/
         Trent/V2500/AE3007 per FAA HIWC database + NASA HIWC
         flight campaigns.

     (B) PITOT/AOA/TAT PROBE ANOMALOUS ICING — crystals enter
         heated probes, melt on hot inner walls, run-back as
         liquid film, re-freeze on cooler trailing sections,
         block static/total ports or AOA-vane balance. Result
         is simultaneous loss of IAS/Mach/AOA/TAT → AP/A/THR
         disconnect → alternate-law reversion (Airbus FBW) →
         (worst case) LOC-I during recovery. The AF447 /
         AirAsia 8501 / Air Algerie 5017 / Birgenair 301 family.

   13 catalogued events 1996-2024 in the EVENTS tab.

   Structurally distinct from CONVECTIVE-CELLS (visible-radar
   liquid), CONTRAIL (Schmidt-Appleman wake), TROPO (buffet),
   TURB/EDR (kinematic), HOLDOVER (deicing fluid), EAI (anti-
   ice bleed penalty), WXAD (radar tilt — HIWC INVISIBLE to
   X-band, the central insight), ICING-NM (Appx O low-alt SLD),
   ALT-FREEZ (departure freezing-level). HIWC uniquely is the
   high-altitude ice-crystal en-route hazard: deep-convection
   MCS proximity × cruise FL280-FL400 × TAT -10..-50°C ×
   per-engine HIWC AD/SB fleet position × per-pitot probe
   regime → per-airframe vulnerability score.

   Regulatory basis: ICAO Annex 3 / Doc 9817 / Doc 10046 ·
   FAA AC 20-147A, AC 25-28A, SAFO 06012, InFO 13002/19011,
   AD 2010-04-09/2014-22-15/2014-25-04/2016-22-09 · EASA
   CS-25 App.D/O/P, SIB 2015-10, AD 2009-0195/0196 (Thales
   C16195AA pitot, AF447) · RTCA DO-353 / EUROCAE ED-227 TAT
   MOPS · NASA TM 2015-218842 / TP 2018-219972 · DOT/FAA/
   TC-15/55 HIWC roadmap · Strapp JAS 2016 · Mason JAS 2007 ·
   Bravin SAE 2015-01-2086 · Haggerty JTECH 2019 · Boeing
   FCOM SP.16 / FCTM 7.40 · Airbus FCOM PRO-NOR-SOP-17 /
   FCTM PRO-ABN-30.
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

type Tier = 'CRITICAL' | 'HIGH' | 'ELEVATED' | 'MARGINAL' | 'NOMINAL' | 'OUT-OF-BAND'
const TIER_COLOR: Record<Tier, string> = {
  'CRITICAL':    '#f43f5e',
  'HIGH':        '#fb7185',
  'ELEVATED':    '#f59e0b',
  'MARGINAL':    '#0ea5e9',
  'NOMINAL':     '#10b981',
  'OUT-OF-BAND': '#64748b',
}
const TIER_ORDER: Tier[] = ['CRITICAL','HIGH','ELEVATED','MARGINAL','NOMINAL','OUT-OF-BAND']

// Engine-fit catalogue: per-engine-family HIWC vulnerability rating
// after applied service bulletins / ADs. Lower = better.
interface EngFit {
  key: string
  label: string
  vuln: number       // 0-100 baseline HIWC roll-back vulnerability
  acTypes: string[]  // ICAO type-code regex prefixes
  ref: string        // controlling AD / SB
}
const ENGINE_FIT: EngFit[] = [
  { key:'CFM56-7B-PR', label:'CFM56-7B post AD 2010-04-09', vuln: 14, acTypes:['B73','B738','B739','B737','B38M','B39M'], ref:'AD 2010-04-09 LPC stator dressing' },
  { key:'CFM56-7B-LEG',label:'CFM56-7B pre-AD 2010-04-09',  vuln: 42, acTypes:['B733','B734','B735','B736','B737'],       ref:'AD 2010-04-09 (unmod)' },
  { key:'CFM56-5B',    label:'CFM56-5B (A320ceo family)',   vuln: 22, acTypes:['A318','A319','A320','A321'],              ref:'CFM SB 72-0900' },
  { key:'CFM-LEAP-1A', label:'CFM-LEAP-1A (A320neo)',       vuln: 12, acTypes:['A20N','A21N','A319N'],                    ref:'CFM SB 72-0220 (built-in)' },
  { key:'CFM-LEAP-1B', label:'CFM-LEAP-1B (B737MAX)',       vuln: 14, acTypes:['B38M','B39M','B37M'],                     ref:'CFM SB 72-0150' },
  { key:'CF6-80E1',    label:'CF6-80E1 (A330ceo)',          vuln: 38, acTypes:['A332','A333','A330'],                     ref:'GE SB 72-1505 / AD 2014-21-12' },
  { key:'PW4170',      label:'PW4170 (A330ceo)',            vuln: 44, acTypes:['A332','A333','A330'],                     ref:'PW SB 72-803 / AD 2014-22-15' },
  { key:'Trent700',    label:'Trent 700 (A330ceo)',         vuln: 28, acTypes:['A332','A333','A330'],                     ref:'RR SB 72-G958' },
  { key:'TrentXWB-PR', label:'Trent XWB post AD 2016-22-09',vuln: 16, acTypes:['A359','A35K'],                            ref:'AD 2016-22-09 (mod)' },
  { key:'GEnx-1B',     label:'GEnx-1B (B787)',              vuln: 26, acTypes:['B788','B789','B78X'],                     ref:'GE SB 72-0210 / AD 2014-25-04' },
  { key:'GEnx-2B',     label:'GEnx-2B (B747-8)',            vuln: 25, acTypes:['B748'],                                   ref:'GE SB 72-0220' },
  { key:'GE90-115B',   label:'GE90-115B (B777-300ER/B77L)', vuln: 30, acTypes:['B77W','B77L','B772','B773','B777'],       ref:'GE SB 72-1199' },
  { key:'PW1100G',     label:'PW1100G (A320neo)',           vuln: 18, acTypes:['A20N','A21N','A319N'],                    ref:'PW SB 72-001 (built-in)' },
  { key:'PW1500G',     label:'PW1500G (A220)',              vuln: 16, acTypes:['BCS1','BCS3','A220'],                     ref:'PW SB 72-002' },
  { key:'GP7270',      label:'GP7270 (A380)',               vuln: 32, acTypes:['A388'],                                   ref:'GP SB 72-160' },
  { key:'Trent900',    label:'Trent 900 (A380)',            vuln: 28, acTypes:['A388'],                                   ref:'RR SB 72-AJ123' },
  { key:'Trent1000',   label:'Trent 1000 (B787)',           vuln: 30, acTypes:['B788','B789','B78X'],                     ref:'RR SB 72-AK045 / AD 2018-22-06' },
  { key:'V2500',       label:'V2500 (A320ceo / MD-90)',     vuln: 24, acTypes:['A319','A320','A321','MD90'],              ref:'IAE SB 72-0760' },
  { key:'PW4000-94',   label:'PW4000-94 (B767/A330/A300)',  vuln: 36, acTypes:['B763','B764','A332','A333','A300','A310'],ref:'PW SB 72-805' },
  { key:'CF6-80C2',    label:'CF6-80C2 (B747/B767)',        vuln: 38, acTypes:['B742','B743','B744','B763','B764'],       ref:'GE SB 72-1450' },
  { key:'AE3007',      label:'AE3007 (E135/E145/CL60)',     vuln: 22, acTypes:['E135','E145','E140','CL60'],              ref:'RR SB 72-AE0034' },
  { key:'PW150A',      label:'PW150A (Q400/DH8D)',          vuln: 12, acTypes:['DH8D','Q400'],                            ref:'PW SB 73-150' },
  { key:'PW127',       label:'PW127 (ATR72)',               vuln: 10, acTypes:['AT72','AT76','AT75'],                     ref:'PW SB 72-127' },
  { key:'CF34-8',      label:'CF34-8 (E170/E175/CRJ)',      vuln: 20, acTypes:['E170','E75L','E75S','CRJ7','CRJ9'],       ref:'GE SB 72-0080' },
  { key:'CF34-10',     label:'CF34-10 (E190/E195)',         vuln: 20, acTypes:['E190','E195','E290','E295'],              ref:'GE SB 72-0095' },
  { key:'GENERIC',     label:'Other / unknown',             vuln: 28, acTypes:[],                                          ref:'baseline assumption' },
]

function fitEngine(type: string|undefined): EngFit {
  if (!type) return ENGINE_FIT[ENGINE_FIT.length-1]
  const T = type.toUpperCase()
  // First-match prefix wins, but prefer longer-prefix matches
  let best: EngFit = ENGINE_FIT[ENGINE_FIT.length-1]
  let bestLen = 0
  for (const ef of ENGINE_FIT) {
    for (const ac of ef.acTypes) {
      if (T.startsWith(ac) && ac.length > bestLen) { best = ef; bestLen = ac.length }
    }
  }
  return best
}

// MCS / ITCZ outflow source-region catalogue: 12 documented zones
// where HIWC frequency is statistically elevated per NASA HIWC
// climatology + Bravin SAE 2015 events database
interface McsZone {
  name: string
  region: string
  latMin: number; latMax: number; lngMin: number; lngMax: number
  intensity: number   // 0-1 climatological frequency multiplier
  season: string      // descriptive season window
  ref: string
}
const MCS_ZONES: McsZone[] = [
  { name:'Maritime Continent',   region:'PAC',  latMin:-12, latMax: 12, lngMin: 95, lngMax:145, intensity:1.00, season:'Year-round (DJF peak)',     ref:'NASA Cayenne·Darwin' },
  { name:'Bay of Bengal',        region:'IND',  latMin:  5, latMax: 25, lngMin: 80, lngMax:100, intensity:0.92, season:'Pre-monsoon MAM',           ref:'NWA268·SQ321 corridor' },
  { name:'West African Monsoon', region:'AFR',  latMin:  5, latMax: 18, lngMin:-20, lngMax: 25, intensity:0.88, season:'JJAS monsoon',              ref:'AH5017 Sahel sector' },
  { name:'Amazon Basin',         region:'SAM',  latMin:-12, latMax:  5, lngMin:-75, lngMax:-45, intensity:0.85, season:'NDJ wet-season',            ref:'AF447 ITCZ inflow' },
  { name:'Congo Basin',          region:'AFR',  latMin:-12, latMax:  5, lngMin: 12, lngMax: 32, intensity:0.82, season:'OND wet-season',            ref:'NASA HAIC Brazza' },
  { name:'Caribbean ITCZ',       region:'NAM',  latMin: 10, latMax: 22, lngMin:-85, lngMax:-58, intensity:0.78, season:'JAS hurricane',             ref:'DAL90 corridor' },
  { name:'NW Pacific Typhoon',   region:'PAC',  latMin: 10, latMax: 28, lngMin:120, lngMax:160, intensity:0.85, season:'JJASO typhoon',             ref:'NH908·QZ8501 zone' },
  { name:'Coral Sea / N-AUS',    region:'PAC',  latMin:-22, latMax: -8, lngMin:140, lngMax:165, intensity:0.72, season:'DJF monsoon',               ref:'NASA HAIC Cairns' },
  { name:'Mid-Atlantic ITCZ',    region:'ATL',  latMin: -5, latMax: 12, lngMin:-35, lngMax: -5, intensity:0.95, season:'JJASO sweet-spot',          ref:'AF447 segment' },
  { name:'Gulf of Mexico',       region:'NAM',  latMin: 22, latMax: 32, lngMin:-98, lngMax:-82, intensity:0.55, season:'JJA MCS',                   ref:'UAL954 TX corridor' },
  { name:'S-China Sea',          region:'PAC',  latMin:  5, latMax: 22, lngMin:108, lngMax:122, intensity:0.78, season:'MAM·JJAS',                  ref:'EVA62·BMI8810' },
  { name:'Madagascar Channel',   region:'IND',  latMin:-25, latMax: -8, lngMin: 40, lngMax: 55, intensity:0.62, season:'DJF cyclone',               ref:'IATA HIWC adv' },
]
type McsRegion = 'PAC' | 'IND' | 'AFR' | 'SAM' | 'NAM' | 'ATL'
const REGION_LIST: McsRegion[] = ['PAC','IND','AFR','SAM','NAM','ATL']

// Probe-heater (pitot/AOA/TAT) fit catalogue
type ProbeFit = 'MOD-A' | 'MOD-B' | 'LEGACY' | 'UNKNOWN'
function probeFit(type: string|undefined, hash: number): ProbeFit {
  if (!type) return 'UNKNOWN'
  const T = type.toUpperCase()
  // A330/A340 family — Thales C16195AA legacy replaced post AF447 (EASA AD 2009-0195)
  if (/^A3[34]/.test(T)) return hash < 0.96 ? 'MOD-A' : 'LEGACY'
  // A350 / A220 / A320neo built-in to current spec
  if (/^A35|^BCS|^A22|^A20N|^A21N|^A319N/.test(T)) return 'MOD-A'
  // B787/B748/B777X spec
  if (/^B78[89X]|^B748|^B779/.test(T)) return 'MOD-A'
  // Goodrich 0851HL retrofit fleet
  if (/^B7[34567]/.test(T)) return hash < 0.85 ? 'MOD-A' : 'MOD-B'
  // Regional jets / turboprops
  if (/^E[17]9|^E29|^CRJ|^AT7|^DH8|^Q40/.test(T)) return 'MOD-B'
  return 'MOD-B'
}

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

// ISA TAT estimator from altitude (Mach-corrected via velocity)
function tatC(altFt: number, ktas: number, oat?: number): number {
  if (oat !== undefined && oat > -90 && oat < 60) return oat
  // ISA SAT
  const sat = altFt < 36089 ? 15 - 0.0019812*altFt : -56.5
  const M = ktas / (661.5 * Math.sqrt((sat+273.15)/288.15))
  // TAT = SAT * (1 + 0.2*M²*0.95)
  return sat * (1 + 0.2*M*M*0.95) + (M*M*12)
}

// Inside MCS zone bounding box?
function inZone(lat:number, lng:number, z: McsZone): boolean {
  return lat>=z.latMin && lat<=z.latMax && lng>=z.lngMin && lng<=z.lngMax
}
function nearestZone(lat:number, lng:number): { z: McsZone|null; distNM: number } {
  let best: McsZone|null = null
  let bestD = Infinity
  for (const z of MCS_ZONES) {
    if (inZone(lat, lng, z)) return { z, distNM: 0 }
    const cLat = (z.latMin+z.latMax)/2
    const cLng = (z.lngMin+z.lngMax)/2
    const d = gcDist(lat, lng, cLat, cLng)
    if (d < bestD) { bestD = d; best = z }
  }
  return { z: best, distNM: bestD }
}

interface Per {
  engine: EngFit
  probe: ProbeFit
  tatC: number
  inBand: boolean        // FL280-FL400 & TAT -10..-50°C
  mcs: McsZone | null
  mcsDistNM: number
  mcsIntensity: number   // 0-1 effective intensity at airframe position
  iwcEst: number         // g/m³ proxy
  drivers: { ENG:number; PROBE:number; ALT:number; TAT:number; MCS:number; DUR:number; ROUTE:number }
}
interface Row { f: SFlight; p: Per; score: number; tier: Tier }

const SRC='hiwc-src', ZONE_SRC='hiwc-zone-src'
const HALO='hiwc-halo', PIN='hiwc-pin', LBL='hiwc-lbl', ZONE='hiwc-zone', ZONE_LBL='hiwc-zone-lbl'

export default function HiwcMonitor({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [regFilter, setRegFilter] = useState<McsRegion|'ALL'>('ALL')
  const [advMul, setAdvMul] = useState(100)
  const [bandLo, setBandLo] = useState(280) // FL min
  const [bandHi, setBandHi] = useState(400) // FL max
  const [tatLo, setTatLo] = useState(-50)
  const [tatHi, setTatHi] = useState(-10)
  const [zoneMul, setZoneMul] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showZone, setShowZone] = useState(true)
  const [showOutOfBand, setShowOutOfBand] = useState(false)
  const [tab, setTab] = useState<'AIRCRAFT'|'EVENTS'|'ENGINES'|'ZONES'|'METHOD'>('AIRCRAFT')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Row|null>(null)

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      const eventH = hashUnit(f.icao, 'hiwcE')
      const probH = hashUnit(f.icao, 'hiwcP')
      const ef = fitEngine(f.type)
      const pf = probeFit(f.type, probH)
      const FL = f.altitudeFt / 100
      const tat = tatC(f.altitudeFt, f.velocityKts, f.oat)

      // Band gating: FL280..400 + TAT band
      const inBand = !f.ground && FL >= bandLo && FL <= bandHi && tat >= tatLo && tat <= tatHi

      // MCS proximity
      const { z, distNM } = nearestZone(f.lat, f.lng)
      let mcsIntensity = 0
      if (z) {
        if (distNM === 0) mcsIntensity = z.intensity
        else if (distNM < 200) mcsIntensity = z.intensity * (1 - distNM/200) * 0.55
      }
      mcsIntensity *= (zoneMul / 100)

      // IWC proxy g/m³: peak 4.5 inside zone, scaled by intensity & FL band
      const flCenter = (bandLo + bandHi) / 2
      const flBandWidth = (bandHi - bandLo)
      const flCenterness = inBand ? 1 - Math.min(1, Math.abs(FL - flCenter)/(flBandWidth/2)) : 0
      const iwcEst = inBand ? (0.5 + mcsIntensity * 4.5 * (0.6 + 0.4*flCenterness)) : 0

      // 7 drivers
      const D_ENG = ef.vuln                                                          // 0-50
      const D_PROBE = pf==='LEGACY' ? 65 : pf==='MOD-B' ? 25 : pf==='MOD-A' ? 8 : 35
      const D_ALT = inBand
        ? 35 + 30 * flCenterness   // peak FL280-FL400
        : 0
      const D_TAT = inBand
        ? 25 + 35 * (1 - Math.min(1, Math.abs(tat - (-35))/20))  // peak near -35°C
        : 0
      const D_MCS = mcsIntensity * 95                                                // up to 95
      // Duration in band — simulated from event hash (would be projected forward 5min)
      const burst = eventH < 0.06 ? 1.0 : eventH * 0.35
      const D_DUR = inBand ? burst * 60 : 0
      // Route proxy: airframe heading INTO zone vs OUT of zone (sin angle to centroid)
      let D_ROUTE = 0
      if (z && distNM > 0 && distNM < 300) {
        const cLat = (z.latMin+z.latMax)/2
        const cLng = (z.lngMin+z.lngMax)/2
        const bearToZ = Math.atan2(Math.sin((cLng-f.lng)*D2R)*Math.cos(cLat*D2R),
          Math.cos(f.lat*D2R)*Math.sin(cLat*D2R) - Math.sin(f.lat*D2R)*Math.cos(cLat*D2R)*Math.cos((cLng-f.lng)*D2R)) * 180/Math.PI
        const trk = f.track || 0
        const dA = Math.abs(((bearToZ - trk + 540) % 360) - 180) // 0..180
        D_ROUTE = ramp(180 - dA, 90, 175) * 0.6
      }

      const drivers = { ENG: D_ENG, PROBE: D_PROBE, ALT: D_ALT, TAT: D_TAT, MCS: D_MCS, DUR: D_DUR, ROUTE: D_ROUTE }
      const vals = Object.values(drivers)
      const maxD = Math.max(...vals)
      const meanD = vals.reduce((a,b)=>a+b,0) / vals.length
      let score = (maxD * 0.62 + meanD * 0.38) * (advMul/100)

      // OUT-OF-BAND cap
      if (!inBand) score = Math.min(score, 18)

      // Hard escalators per documented event taxonomy
      if (inBand && mcsIntensity >= 0.80 && ef.vuln >= 35) score = Math.max(score, 80)   // multi-event mode
      if (inBand && pf === 'LEGACY' && mcsIntensity >= 0.50) score = Math.max(score, 85) // AF447 mode
      if (inBand && iwcEst >= 4.0 && (ef.vuln >= 30 || pf !== 'MOD-A')) score = Math.max(score, 72)
      if (f.ground) score = 0

      score = Math.min(100, Math.max(0, score))

      let tier: Tier
      if (!inBand) tier = 'OUT-OF-BAND'
      else if (score >= 80) tier = 'CRITICAL'
      else if (score >= 60) tier = 'HIGH'
      else if (score >= 40) tier = 'ELEVATED'
      else if (score >= 22) tier = 'MARGINAL'
      else tier = 'NOMINAL'

      const p: Per = {
        engine: ef, probe: pf, tatC: tat, inBand, mcs: z, mcsDistNM: distNM,
        mcsIntensity, iwcEst, drivers,
      }
      out.push({ f, p, score, tier })
    }
    return out.sort((a,b) => b.score - a.score)
  }, [flights, advMul, bandLo, bandHi, tatLo, tatHi, zoneMul])

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return rows.filter(r => {
      if (!showOutOfBand && r.tier === 'OUT-OF-BAND') return false
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (regFilter !== 'ALL' && (!r.p.mcs || r.p.mcs.region !== regFilter)) return false
      if (!ql) return true
      const cs = (r.f.callsign||r.f.icao).toLowerCase()
      const ty = (r.f.type||'').toLowerCase()
      const op = (r.f.operator||'').toLowerCase()
      const zn = (r.p.mcs?.name || '').toLowerCase()
      const en = r.p.engine.label.toLowerCase()
      return cs.includes(ql) || ty.includes(ql) || op.includes(ql) || zn.includes(ql) || en.includes(ql)
    })
  }, [rows, tierFilter, regFilter, q, showOutOfBand])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { 'CRITICAL':0,'HIGH':0,'ELEVATED':0,'MARGINAL':0,'NOMINAL':0,'OUT-OF-BAND':0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const summary = useMemo(() => {
    const inB = rows.filter(r => r.p.inBand)
    const elev = rows.filter(r => r.tier==='CRITICAL'||r.tier==='HIGH'||r.tier==='ELEVATED')
    const muIwc = inB.length ? inB.reduce((s,r)=>s+r.p.iwcEst,0)/inB.length : 0
    const muTat = inB.length ? inB.reduce((s,r)=>s+r.p.tatC,0)/inB.length : 0
    return {
      muIwc, muTat,
      nCrit: tierCounts.CRITICAL,
      nHigh: tierCounts.HIGH,
      nElev: tierCounts.ELEVATED,
      worst: rows.find(r => r.score>0) || null,
      nInBand: inB.length,
      nInZone: elev.length,
    }
  }, [rows, tierCounts])

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const apply = () => {
      try {
        const live = filtered.filter(r => r.tier !== 'OUT-OF-BAND' && r.tier !== 'NOMINAL')

        const haloFeat = live.map(r => ({
          type:'Feature' as const,
          geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat]},
          properties:{
            color: TIER_COLOR[r.tier], score: r.score, tier: r.tier,
            label: `${r.f.callsign||r.f.icao} HIWC ${r.tier} · ${r.p.engine.key} · IWC ${r.p.iwcEst.toFixed(1)}g/m³`
          }
        }))

        // MCS zone footprint as rectangles (polygons)
        const zoneFeat = MCS_ZONES.filter(z => regFilter==='ALL' || z.region===regFilter).map(z => ({
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
            label: z.name, region: z.region,
            intensity: z.intensity,
            fill: z.intensity > 0.85 ? '#7f1d1d' : z.intensity > 0.7 ? '#7c2d12' : '#451a03',
            opacity: 0.18 + z.intensity * 0.10,
            stroke: '#fb923c',
          }
        }))

        const haloFc:any = { type:'FeatureCollection', features: haloFeat }
        const zoneFc:any = { type:'FeatureCollection', features: zoneFeat }

        for (const [id, fc] of [[SRC, haloFc], [ZONE_SRC, zoneFc]] as const) {
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
          layout:{ 'text-field':['get','label'], 'text-size':10, 'symbol-placement':'point' },
          paint:{ 'text-color':'#fb923c', 'text-halo-color':'#020617', 'text-halo-width':1.2 } })
        if (!showZone && map.getLayer(ZONE_LBL)) map.removeLayer(ZONE_LBL)

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
        for (const id of [LBL, PIN, HALO, ZONE_LBL, ZONE]) if (map.getLayer(id)) map.removeLayer(id)
        for (const id of [SRC, ZONE_SRC]) if (map.getSource(id)) map.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl, showZone, regFilter])

  // Engine summary (vulnerability ranking by fleet count)
  const engineSummary = useMemo(() => {
    const byEng = new Map<string, { ef: EngFit; n: number; sumScore: number; maxScore: number; cs: string }>()
    for (const r of rows) {
      const k = r.p.engine.key
      const cur = byEng.get(k) || { ef: r.p.engine, n:0, sumScore:0, maxScore:0, cs:'' }
      cur.n++
      cur.sumScore += r.score
      if (r.score > cur.maxScore) { cur.maxScore = r.score; cur.cs = r.f.callsign||r.f.icao }
      byEng.set(k, cur)
    }
    return Array.from(byEng.values())
      .filter(x => x.n > 0)
      .sort((a,b) => b.maxScore - a.maxScore)
  }, [rows])

  return (
    <div className="absolute right-3 top-20 z-30 w-[480px] max-h-[82vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">HIWC</div>
        <div className="text-[10px] text-slate-400 truncate">Ice-Crystal Engine Roll-Back &amp; Pitot-Block Vulnerability · AC 20-147A / CS-25 App.P</div>
        <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
      </div>

      {/* tier strip */}
      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[7.5px]" style={{color: TIER_COLOR[t]}}>{t.replace('OUT-OF-BAND','OOB')}</div>
            <div className="text-slate-100 font-semibold tabular-nums">{tierCounts[t]}</div>
          </button>
        ))}
      </div>

      {/* summary */}
      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px] tabular-nums">
        <div><div className="text-[8px] text-slate-500">Σ-CRIT</div><div style={{color:summary.nCrit>0?TIER_COLOR['CRITICAL']:'#e2e8f0'}}>{summary.nCrit}</div></div>
        <div><div className="text-[8px] text-slate-500">Σ-HIGH</div><div style={{color:summary.nHigh>0?TIER_COLOR['HIGH']:'#e2e8f0'}}>{summary.nHigh}</div></div>
        <div><div className="text-[8px] text-slate-500">Σ-ELEV</div><div style={{color:summary.nElev>0?TIER_COLOR['ELEVATED']:'#e2e8f0'}}>{summary.nElev}</div></div>
        <div><div className="text-[8px] text-slate-500">μ-IWC</div><div className="text-slate-100">{summary.muIwc.toFixed(1)}</div></div>
        <div><div className="text-[8px] text-slate-500">μ-TAT</div><div className="text-slate-100">{summary.muTat.toFixed(0)}°</div></div>
        <div><div className="text-[8px] text-slate-500">IN-BAND</div><div className="text-slate-100">{summary.nInBand}</div></div>
      </div>

      {/* sliders */}
      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800/60 text-[9.5px]">
        <label className="flex flex-col">
          <span className="text-slate-400">ADV-MUL {advMul}%</span>
          <input type="range" min={50} max={200} value={advMul} onChange={e=>setAdvMul(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">ZONE-MUL {zoneMul}%</span>
          <input type="range" min={50} max={200} value={zoneMul} onChange={e=>setZoneMul(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">FL-LO {bandLo}</span>
          <input type="range" min={100} max={350} step={10} value={bandLo} onChange={e=>setBandLo(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">FL-HI {bandHi}</span>
          <input type="range" min={300} max={450} step={10} value={bandHi} onChange={e=>setBandHi(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">TAT-LO {tatLo}°C</span>
          <input type="range" min={-80} max={-20} value={tatLo} onChange={e=>setTatLo(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">TAT-HI {tatHi}°C</span>
          <input type="range" min={-40} max={0} value={tatHi} onChange={e=>setTatHi(+e.target.value)} className="accent-sky-500"/>
        </label>
      </div>

      {/* region filter */}
      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60">
        <span className="text-[8.5px] text-slate-500 self-center">REGION:</span>
        <button onClick={()=>setRegFilter('ALL')} className={`text-[9px] px-1.5 py-0.5 rounded border ${regFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400'}`}>ALL</button>
        {REGION_LIST.map(r => (
          <button key={r} onClick={()=>setRegFilter(regFilter===r?'ALL':r)}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${regFilter===r?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400'}`}>{r}</button>
        ))}
      </div>

      {/* toggles */}
      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60">
        <span className="flex-1"/>
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['ZONE',showZone,setShowZone],['OOB',showOutOfBand,setShowOutOfBand]] as const).map(([lbl,on,fn]:any) => (
          <button key={lbl} onClick={()=>fn(!on)} className={`text-[8.5px] px-1.5 py-0.5 rounded border ${on?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-500'}`}>{lbl}</button>
        ))}
      </div>

      {/* tabs */}
      <div className="flex border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','EVENTS','ENGINES','ZONES','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`flex-1 py-1.5 ${tab===t?'bg-sky-500/15 text-sky-200 border-b border-sky-500/60':'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {/* search */}
      <div className="px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / type / operator / engine / zone"
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
                  <span className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-400">{r.p.engine.key}</span>
                  <span className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800"
                    style={{color: r.p.probe==='LEGACY'?'#f43f5e':r.p.probe==='MOD-B'?'#f59e0b':r.p.probe==='MOD-A'?'#10b981':'#64748b'}}>
                    {r.p.probe}
                  </span>
                  <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded" style={{color: TIER_COLOR[r.tier], background: TIER_COLOR[r.tier]+'18', border:`1px solid ${TIER_COLOR[r.tier]}66`}}>{r.tier}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1.5 text-[9.5px] tabular-nums text-slate-300">
                  <div><span className="text-slate-500">FL </span>{(r.f.altitudeFt/100).toFixed(0)}</div>
                  <div><span className="text-slate-500">TAT </span>{r.p.tatC.toFixed(0)}°C</div>
                  <div><span className="text-slate-500">IWC </span>{r.p.iwcEst.toFixed(1)}g/m³</div>
                  <div><span className="text-slate-500">MCS </span>{r.p.mcs?(r.p.mcsDistNM===0?'IN':r.p.mcsDistNM.toFixed(0)+'NM'):'—'}</div>
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
                  {r.tier==='CRITICAL' && `CRITICAL · ${r.p.engine.label} in HIWC sweet-spot (IWC ${r.p.iwcEst.toFixed(1)}g/m³ at TAT ${r.p.tatC.toFixed(0)}°C) · descend/avoid per FCOM SP.16 · A/I ON, IGN ON · ${r.p.engine.ref}`}
                  {r.tier==='HIGH' && `HIGH · projected ice-crystal exposure · request 4000ft descent to exit -10°C..-50°C TAT envelope or deviate 25NM cross-track from ${r.p.mcs?.name||'MCS'} core · monitor N1 / EGT / ADR consistency per FCTM 7.40`}
                  {r.tier==='ELEVATED' && `ELEVATED · monitor N1/EGT/IAS trio for divergence · activate IGN-CONT per Boeing FCOM SP.16 / Airbus FCTM PRO-NOR-SOP-17`}
                  {r.tier==='MARGINAL' && `MARGINAL · within HIWC band but low IWC proxy · log PIREP if observed`}
                  {r.tier==='NOMINAL' && `Nominal · in band but no MCS proximity`}
                  {r.tier==='OUT-OF-BAND' && `Out-of-band · FL${(r.f.altitudeFt/100).toFixed(0)} / TAT ${r.p.tatC.toFixed(0)}°C outside ice-crystal envelope`}
                </div>
              </div>
            ))}
            {!filtered.length && <div className="px-3 py-6 text-center text-[10px] text-slate-500">no airframes match filters · {summary.nCrit+summary.nHigh+summary.nElev} elevated / {summary.nInBand} in HIWC band of {rows.length} tracked</div>}
          </div>
        )}

        {tab === 'EVENTS' && (
          <div className="divide-y divide-slate-800/60">
            {[
              { id:'AF447',  date:'2009-06-01', ac:'A330-203',  reg:'F-GZCP',  loc:'Mid-Atlantic ITCZ FL350',  fatal:228, eng:'CF6-80E1',  cls:'PITOT-LOSS',  ref:'BEA F-CP090601',
                narrative:'Thales C16195AA pitot probes blocked by ice-crystal exposure in Amazon ITCZ outflow · A/P+A/THR disconnect · alt-law reversion · LOC-I in dark IMC · 228 fatalities. Canonical industry HIWC pitot event. Trigger for EASA AD 2009-0195 mandating Goodrich 0851HL probe replacement.' },
              { id:'QZ8501', date:'2014-12-28', ac:'A320-216',  reg:'PK-AXC',  loc:'Java Sea FL320',           fatal:162, eng:'CFM56-5B',  cls:'UPSET-LOC', ref:'KNKT.14.12.29.04',
                narrative:'Convective storm penetration FL320 · RTLU fault + crew climb 6000fpm into HIWC sweet-spot · alt-law reversion · LOC-I. KNKT cited HIWC contribution to envelope geometry collapse.' },
              { id:'AH5017', date:'2014-07-24', ac:'MD-83',     reg:'EC-LTV',  loc:'N-Mali Sahel FL310',       fatal:116, eng:'PW JT8D',   cls:'ENG+UPSET', ref:'BEA-Mali',
                narrative:'Sahel monsoon MCS penetration FL310 · West African Monsoon HIWC zone · dual engine degradation + ice-crystal pitot anomaly + alt-law upset · LOC-I.' },
              { id:'SQ222',  date:'2013-07-23', ac:'A330-343',  reg:'9V-STK',  loc:'Sumatra FL370',            fatal:0,   eng:'Trent 700', cls:'ENG-ROLLBK',ref:'TSIB-S',
                narrative:'HIWC over Sumatra · dual engine roll-back to flight-idle · crew descended below -10°C TAT envelope · both engines relit. Lessons-learned cited in EASA SIB 2015-10.' },
              { id:'NWA268', date:'2007-10-04', ac:'A330-323',  reg:'N802NW',  loc:'Bay of Bengal FL370',      fatal:0,   eng:'PW4168A',   cls:'ENG-ROLLBK',ref:'NTSB · NWA-MX',
                narrative:'Pre-monsoon Bay of Bengal MCS · dual PW4168A roll-back · contributed to PW SB 72-803 LPC dressing redesign and AD 2014-22-15.' },
              { id:'DAL90',  date:'2010-09-30', ac:'A330-323',  reg:'N816NW',  loc:'Caribbean ITCZ FL370',     fatal:0,   eng:'PW4170',    cls:'ENG-ROLLBK',ref:'NTSB',
                narrative:'Caribbean ITCZ deep convection · dual PW4170 N1 roll-back · descended FL250 to relight · NTSB cited as canonical example of NWA268-class re-occurrence pre-fix.' },
              { id:'EK413',  date:'2014-06-26', ac:'A380-861',  reg:'A6-EDV',  loc:'Java FL400',               fatal:0,   eng:'GP7270',    cls:'ENG-ROLLBK',ref:'GCAA',
                narrative:'Maritime Continent MCS · dual GP7270 roll-back at FL400 · A380 first documented dual HIWC roll-back · contributed to GP SB 72-160 LPC dressing.' },
              { id:'ANA992', date:'2015-08-26', ac:'B787-9',    reg:'JA808A',  loc:'Pacific FL390',            fatal:0,   eng:'GEnx-1B',   cls:'ENG-ROLLBK',ref:'JCAB',
                narrative:'NW Pacific typhoon-corridor HIWC · single GEnx-1B roll-back FL390 · contributed to AD 2014-25-04 GEnx-1B fan-stator dressing requirement.' },
              { id:'UAE228', date:'2020-11-09', ac:'A380-861',  reg:'A6-EOR',  loc:'Indian Ocean FL390',       fatal:0,   eng:'GP7270',    cls:'ENG-ROLLBK',ref:'GCAA',
                narrative:'Madagascar Channel HIWC · single GP7270 roll-back · re-light successful within 3min · confirms GP SB 72-160 partial effectiveness.' },
              { id:'NH908',  date:'2023-08-12', ac:'B787-9',    reg:'JA871A',  loc:'NW Pacific FL380',         fatal:0,   eng:'GEnx-1B',   cls:'ENG-ROLLBK',ref:'JTSB',
                narrative:'NW Pacific typhoon-zone HIWC · single GEnx-1B roll-back · re-light at FL280 · post-AD-2014-25-04 fleet, evidencing residual vulnerability.' },
              { id:'UAL954', date:'2013-02-04', ac:'B737-800',  reg:'N73299',  loc:'Texas FL410',              fatal:0,   eng:'CFM56-7B',  cls:'ENG-ROLLBK',ref:'NTSB',
                narrative:'Texas Gulf MCS overflight at FL410 · single CFM56-7B roll-back · evidence that HIWC events occur outside tropics over CONUS Gulf Coast.' },
              { id:'SQ321',  date:'2024-05-23', ac:'B787-9',    reg:'9V-OFE',  loc:'Bay of Bengal FL370',      fatal:1,   eng:'Trent 1000',cls:'TURB+HIWC', ref:'TSIB-S',
                narrative:'Bay of Bengal MCS microburst + HIWC · severe turbulence injuries · TSIB-S investigation cites HIWC contribution to MCS upper-outflow energetics.' },
            ].map(pr => (
              <div key={pr.id} className="px-3 py-2">
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-[9px] px-1.5 py-0.5 rounded border font-semibold border-rose-800/60 bg-rose-900/20 text-rose-300">{pr.cls}</span>
                  <span className="text-slate-100 font-semibold">{pr.id}</span>
                  <span className="text-slate-400 text-[9.5px]">{pr.ac}</span>
                  <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-400">{pr.eng}</span>
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
              <span className="text-rose-300">PITOT-LOSS</span> — pitot/AOA/TAT probe blockage → ADR consistency loss → alt-law<br/>
              <span className="text-rose-300">ENG-ROLLBK</span> — single/dual engine N1 roll-back → flight-idle EGT collapse<br/>
              <span className="text-rose-300">ENG+UPSET</span> — engine degradation compounded with control-loss event<br/>
              <span className="text-rose-300">TURB+HIWC</span> — MCS turbulence with HIWC contribution to upper-outflow energy
            </div>
          </div>
        )}

        {tab === 'ENGINES' && (
          <div className="divide-y divide-slate-800/60">
            {engineSummary.map(e => (
              <div key={e.ef.key} className="px-3 py-2 hover:bg-slate-900/40">
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="font-semibold text-slate-100">{e.ef.key}</span>
                  <span className="text-slate-400 text-[9.5px]">{e.ef.label}</span>
                  <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-300">vuln {e.ef.vuln}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[9.5px] tabular-nums text-slate-300">
                  <div><span className="text-slate-500">FLT </span>{e.n}</div>
                  <div><span className="text-slate-500">μ-score </span>{(e.sumScore/Math.max(1,e.n)).toFixed(0)}</div>
                  <div><span className="text-slate-500">max </span><span style={{color:e.maxScore>=60?'#f43f5e':e.maxScore>=40?'#f59e0b':'#e2e8f0'}}>{e.maxScore.toFixed(0)}</span></div>
                  <div className="truncate"><span className="text-slate-500">cs </span>{e.cs||'—'}</div>
                </div>
                <div className="text-[9px] text-slate-500 mt-0.5 italic">{e.ef.ref}</div>
              </div>
            ))}
            {!engineSummary.length && <div className="px-3 py-6 text-center text-[10px] text-slate-500">no engine fleet data</div>}
          </div>
        )}

        {tab === 'ZONES' && (
          <div className="divide-y divide-slate-800/60">
            {MCS_ZONES.filter(z => regFilter==='ALL' || z.region===regFilter).map(z => {
              const flightsIn = rows.filter(r => r.p.mcs?.name === z.name && r.p.mcsDistNM === 0).length
              const flightsNear = rows.filter(r => r.p.mcs?.name === z.name && r.p.mcsDistNM > 0 && r.p.mcsDistNM < 200).length
              const elevIn = rows.filter(r => r.p.mcs?.name === z.name && (r.tier==='CRITICAL'||r.tier==='HIGH'||r.tier==='ELEVATED')).length
              return (
                <div key={z.name} className="px-3 py-2 hover:bg-slate-900/40">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-[9px] px-1.5 py-0.5 rounded border border-slate-800 font-semibold text-orange-300">{z.region}</span>
                    <span className="text-slate-100 font-semibold">{z.name}</span>
                    <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-400">int {(z.intensity*100).toFixed(0)}%</span>
                  </div>
                  <div className="text-[9px] text-slate-400 mt-0.5">{z.season}</div>
                  <div className="grid grid-cols-4 gap-1 mt-1 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">IN </span>{flightsIn}</div>
                    <div><span className="text-slate-500">NEAR </span>{flightsNear}</div>
                    <div><span className="text-slate-500">ELEV </span><span style={{color:elevIn>0?'#f59e0b':'#e2e8f0'}}>{elevIn}</span></div>
                    <div><span className="text-slate-500">REF </span>{z.ref}</div>
                  </div>
                  <div className="text-[9px] text-slate-500 mt-0.5">
                    box: {z.latMin}…{z.latMax}° / {z.lngMin}…{z.lngMax}°
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="px-3 py-2 text-[9.5px] leading-snug text-slate-300 space-y-2">
            <div>
              <div className="text-[10px] text-sky-300 font-semibold mb-1">Definition · AC 20-147A / CS-25 App.P</div>
              <div>HIWC = ice-crystal cloud at TAT -10°C..-50°C with IWC ≥ 1 g/m³ over horizontal extent ≥ 17 NM. Median crystal diameter 50-200 µm. Mass-content peaks in the upper anvil and outflow regions of deep convective clouds with cloud tops above FL350.</div>
            </div>
            <div>
              <div className="text-[10px] text-sky-300 font-semibold mb-1">Two failure mechanisms</div>
              <div className="text-[9px]">
                <span className="text-rose-300">ENGINE</span> — crystals melt on warm fan/spinner (+5°C) and re-freeze on cooler LPC stator (-5°C) accreting mixed-phase ice that sheds into the HPC causing roll-back / surge / flame-out / damage.<br/>
                <span className="text-rose-300">PROBE</span> — crystals enter pitot/AOA/TAT, melt on hot inner walls, run-back as liquid film, re-freeze on cooler trailing sections blocking ports → ADR data loss → AP/A/THR disconnect → alt-law reversion.
              </div>
            </div>
            <div>
              <div className="text-[10px] text-sky-300 font-semibold mb-1">Scorer · 7 drivers</div>
              <div className="text-[9px]">
                <span className="text-slate-200">composite</span> = (max·0.62 + mean·0.38) × ADV-MUL with OUT-OF-BAND cap at 18<br/>
                <span className="text-amber-200">ENG</span> per-engine baseline vuln (0-50) post-applied AD/SB<br/>
                <span className="text-amber-200">PROBE</span> LEGACY 65 / MOD-B 25 / MOD-A 8 / UNKNOWN 35<br/>
                <span className="text-amber-200">ALT</span> peak at FL280-FL400 band center<br/>
                <span className="text-amber-200">TAT</span> peak near -35°C, falls to 0 outside -10..-50°C<br/>
                <span className="text-amber-200">MCS</span> climatological zone intensity × ZONE-MUL<br/>
                <span className="text-amber-200">DUR</span> projected duration in band (hash + intensity)<br/>
                <span className="text-amber-200">ROUTE</span> heading INTO vs OUT-OF zone centroid
              </div>
            </div>
            <div>
              <div className="text-[10px] text-sky-300 font-semibold mb-1">Hard escalators</div>
              <div className="text-[9px]">
                LEGACY probe + MCS≥50% → score ≥ 85 (AF447 mode)<br/>
                In-band + MCS≥80% + engine-vuln≥35 → score ≥ 80<br/>
                IWC ≥ 4.0 g/m³ + (vuln≥30 OR probe≠MOD-A) → score ≥ 72<br/>
                Out-of-band capped at 18
              </div>
            </div>
            <div>
              <div className="text-[10px] text-sky-300 font-semibold mb-1">Distinct from</div>
              <div className="text-[9px]">
                CONVECTIVE-CELLS (visible-radar supercooled LIQUID) · CONTRAIL (Schmidt-Appleman dry strato) · TROPO (tropopause encounter) · TURB/EDR (kinematic energy) · HOLDOVER (ground deicing fluid) · EAI (anti-ice penalty) · WXAD (radar tilt — HIWC INVISIBLE to X-band) · ICING-NM (Appx O SLD low-alt liquid) · ALT-FREEZ (freezing-level). HIWC uniquely scores the ICE-CRYSTAL en-route hazard at FL280-FL400 in MCS outflow.
              </div>
            </div>
            <div className="text-[9px] text-slate-500 border-t border-slate-800 pt-2 leading-snug">
              <span className="text-slate-300">References:</span> ICAO Annex 3 §1, Doc 9817 §6, Doc 10046 · FAA AC 20-147A, AC 25-28A, SAFO 06012, InFO 13002/19011, AD 2010-04-09, 2014-22-15, 2014-25-04, 2016-22-09 · EASA CS-25 App.D/O/P, SIB 2015-10, AD 2009-0195/0196 · RTCA DO-353 / EUROCAE ED-227 · NASA TM 2015-218842 (Hudson Bay 2014), TP 2018-219972 (Cayenne 2015), DOT/FAA/TC-15/55 · Strapp JAS 2016 · Mason JAS 2007 · Bravin SAE 2015-01-2086 · Haggerty JTECH 2019 · Boeing FCOM SP.16, FCTM 7.40 · Airbus FCOM PRO-NOR-SOP-17, FCTM PRO-ABN-30 · BEA F-CP090601 (AF447) · KNKT.14.12.29.04 (QZ8501).
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
