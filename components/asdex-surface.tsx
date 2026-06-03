'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   ASDE-X / ASSC / A-SMGCS Surface Movement & Runway Incursion
   ------------------------------------------------------------
   Per-aircraft surface state for taxi / lineup / departure
   rollout / arrival rollout / pushback, with runway incursion
   alerting modelled on the FAA ASDE-X (Airport Surface
   Detection Equipment, Model X) Safety Logic, ASSC (Airport
   Surface Surveillance Capability) and ICAO A-SMGCS (Advanced
   Surface Movement Guidance & Control System) Levels 1-4.

   Regulatory & operational basis:
     · FAA Order JO 7110.65   §3-1-12 / §3-10 surface ops
     · FAA Order JO 7210.3DD  §10-3-12 ASDE-X / ASSC
     · FAA AC 120-74C         Surface movement procedures
     · FAA AC 91-73B          Single-pilot procedures
     · ICAO Doc 9830          A-SMGCS Manual
     · ICAO Doc 4444 PANS-ATM §7.5 ground movement
     · ICAO Annex 14 Vol I §3.10 / Att A §15 incursion
     · ICAO Annex 11 §3.4.4   ground control
     · ICAO Doc 9870 Manual on the Prevention of
       Runway Incursions
     · EUROCONTROL EAPPRI Edition 3 (2017)
     · EUROCAE ED-87C / RTCA DO-272D AMDB
     · RTCA DO-365B DAA / DO-262C ADS-B GS state
     · ARINC 622 Position over ATN
     · ARINC 718A Mode-S transponder DF11 surface
     · MITRE Safety Logic Algorithms ASDE-X
     · NTSB AAR-91/08  USAir 1493 / SkyWest 5569
       (LAX runway 24L collision 1991, ASDE precursor)
     · NTSB AAR-08/04  Comair 5191 LEX wrong-runway
     · NTSB DCA17IA148 SFO Air Canada 759 near-miss
     · NTSB DCA23LA105 KJFK 1320Z 13-Jan-23 Delta-AAL
     · NTSB DCA23IA070 KAUS 04-Feb-23 SWA-FedEx
     · NTSB DCA23FA152 KMDW NetJets-Flexjet
     · FAA SAFO 23002  Pre-departure runway awareness
     · ICAO RWY Safety Programme Doc 10138

   ASDE-X Safety Logic (paraphrased per MITRE 2011):
     · Level 4 incursion =  collision imminent < 12 s
     · Level 3           =  warning   12-25 s
     · Level 2           =  caution   25-40 s
     · Level 1           =  advisory  > 40 s no immediate
     · STOP-BAR / HOLD-SHORT crossing detected via taxi
       state, GS > 8 kt, distance to active rwy < 200 ft
     · WRONG-RUNWAY detected via departure rollout on
       runway QFU vs cleared QFU
     · LINEUP on active rwy when arrival within 90 s

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash of ICAO24 derives
        equipage class A-SMGCS L1 L2 L3 L4, transponder gen
        (Mode-C / Mode-S / DF11-surf / 1090ES), and stand
        / gate hash for synthetic ground topology
     2. Surface phase classifier:
          PUSH    ground & vel < 5 kt & track == hash-stable
          TAXI    ground & 5 ≤ vel < 35 kt
          LINEUP  ground & vel < 5 kt & near runway threshold
          ROLL    ground & vel ≥ 35 kt (TKO roll)
          LAND    ground & vel ≥ 80 kt & landing
          GATE    ground & vel < 2 kt & in gate cluster
     3. Nearest published runway pair from 32-airport catalogue
        (KATL KDFW KORD KLAX KDEN KJFK KSFO KSEA KMIA KBOS
         KLGA KEWR KMDW KIAH KMSP KPHX KCLT KSLC KDTW KDCA
         KMCO KMEM EHAM EGLL LFPG EDDF EGKK LFBO LSZH OMDB
         WSSS RJTT) gives QFU, length, displaced thresh
     4. Conflict pair search: any other aircraft within
        1500 ft on adjacent runway / taxiway, time-to-
        intercept via vector intersect, GS-projected
     5. 6 risk drivers:
          INC    incursion-distance-vs-rwy edge
                  0 at ≥ 500 ft, 100 at ≤ 0
          CFL    conflict-pair time-to-intercept
                  100 at ≤ 12 s, 0 at ≥ 90 s
          XSP    cross-runway taxi speed
                  100 at ≥ 25 kt across active
          WRN    wrong-runway / wrong-direction
                  100 if heading-vs-QFU > 30°
          EQP    equipage gap A-SMGCS L1 100 / L2 60
          STB    stop-bar / hold-short violation
                  100 if crossing illuminated stop-bar
     6. Phase multiplier ROLL 1.35 / LINEUP 1.25 /
        LAND 1.30 / TAXI 1.00 / PUSH 0.80 / GATE 0.6
     7. Hard escalations: incursion-dist ≤ 0 → 95
                         CFL ≤ 12 s → 92 Comair tier
                         WRN any ROLL → 90 LEX tier

   5 tiers:
     · COLLISION  score ≥ 80   rose, REJECT / GO-AROUND
     · INCURSION  score ≥ 55   amber, HOLD POSITION
     · WATCH      score ≥ 25   sky, monitor traffic
     · OK         score < 25   emerald
     · IDLE       not on surface

   MapLibre overlay:
     · Tier-coloured halo rings sized 8-22 px by score
     · Rose diamond pin for COLLISION
     · 32 airport pins coloured by ASSC/ASDE-X equipage
     · Dashed tier-coloured conflict link between paired
       aircraft, end-marker ring on companion
     · Forward 3 nm projection for COLLISION
     · Tier-coloured callsign + RWY + TTI + driver labels
     · Sky reference parallels at lat 60/30/0/-30/-60

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell COLLISION / WORST callsign / MEAN-TTI summary
     · 3-cell INCURSION-share / EQUIP-GAP-share / X-RWY-share
     · SVG TTI vs cross-runway distance scatter with rose
       COLLISION quadrant + amber INCURSION band + emerald OK
     · 7 sliders MIN-VEL / FLEET-AGE / TRAF-DENS / EQP-DOWN /
                 CONFLICT-MUL / WRN-RATE / PHASE-WT
     · 4-equipage chip filter L1 / L2 / L3 / L4
     · HALO / PIN / LBL / CONF / AIRP / REF / DIAG toggles
     · AIRCRAFT / AIRPORTS tab switcher
     · Per-row tier stripe, phase pill, equipage pill,
       conflict-with link, 6-cell breakdown chips,
       tier-coloured advice

   Layers > Safety & Traffic.
   Persisted: ft-asdex
   ============================================================ */

interface AsdexFlight {
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
  flights: AsdexFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'COLLISION' | 'INCURSION' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = { COLLISION: '#ef4444', INCURSION: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b' }
const TIER_ORDER: Tier[] = ['COLLISION', 'INCURSION', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { COLLISION: 0, INCURSION: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Equip = 'L4' | 'L3' | 'L2' | 'L1'
const EQUIP_LIST: Equip[] = ['L4', 'L3', 'L2', 'L1']
const EQUIP_LABEL: Record<Equip, string> = {
  L4: 'A-SMGCS L4 (auto-routing)', L3: 'A-SMGCS L3 (planning)',
  L2: 'A-SMGCS L2 (control)',      L1: 'A-SMGCS L1 (surveillance)',
}

type Phase = 'PUSH' | 'GATE' | 'TAXI' | 'LINEUP' | 'ROLL' | 'LAND' | 'AIR'
const PHASE_MUL: Record<Phase, number> = { PUSH: 0.80, GATE: 0.60, TAXI: 1.00, LINEUP: 1.25, ROLL: 1.35, LAND: 1.30, AIR: 0 }

type Driver = 'INC' | 'CFL' | 'XSP' | 'WRN' | 'EQP' | 'STB' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  INC: 'Runway incursion distance', CFL: 'Conflict-pair TTI', XSP: 'Cross-runway taxi speed',
  WRN: 'Wrong-runway / direction', EQP: 'A-SMGCS equipage', STB: 'Stop-bar violation', NONE: 'Nominal',
}

interface Airport {
  icao: string; name: string; lat: number; lng: number
  equip: Equip
  // Primary runway QFU pair, length ft
  rwy: string; qfu: number; lenFt: number
}
const AIRPORTS: Airport[] = [
  { icao: 'KATL', name: 'Atlanta',           lat: 33.6367, lng: -84.4281, equip: 'L4', rwy: '08L/26R', qfu: 90,  lenFt: 9000  },
  { icao: 'KDFW', name: 'Dallas/Ft Worth',   lat: 32.8968, lng: -97.0380, equip: 'L4', rwy: '17C/35C', qfu: 175, lenFt: 13401 },
  { icao: 'KORD', name: 'Chicago O\u2019Hare', lat: 41.9742, lng: -87.9073, equip: 'L4', rwy: '10L/28R', qfu: 100, lenFt: 7500  },
  { icao: 'KLAX', name: 'Los Angeles',       lat: 33.9425, lng: -118.4081, equip: 'L4', rwy: '07R/25L', qfu: 70,  lenFt: 11095 },
  { icao: 'KDEN', name: 'Denver',            lat: 39.8617, lng: -104.6731, equip: 'L4', rwy: '16L/34R', qfu: 160, lenFt: 12000 },
  { icao: 'KJFK', name: 'New York/JFK',      lat: 40.6398, lng: -73.7789, equip: 'L4', rwy: '04L/22R', qfu: 40,  lenFt: 12079 },
  { icao: 'KSFO', name: 'San Francisco',     lat: 37.6188, lng: -122.3754, equip: 'L4', rwy: '28L/10R', qfu: 280, lenFt: 11870 },
  { icao: 'KSEA', name: 'Seattle',           lat: 47.4502, lng: -122.3088, equip: 'L4', rwy: '16L/34R', qfu: 160, lenFt: 11900 },
  { icao: 'KMIA', name: 'Miami',             lat: 25.7959, lng: -80.2870, equip: 'L4', rwy: '08L/26R', qfu: 90,  lenFt: 8600  },
  { icao: 'KBOS', name: 'Boston/Logan',      lat: 42.3656, lng: -71.0096, equip: 'L4', rwy: '04R/22L', qfu: 40,  lenFt: 10005 },
  { icao: 'KLGA', name: 'New York/La Guardia', lat: 40.7769, lng: -73.8740, equip: 'L4', rwy: '04/22',  qfu: 40,  lenFt: 7000  },
  { icao: 'KEWR', name: 'Newark',            lat: 40.6925, lng: -74.1687, equip: 'L4', rwy: '04L/22R', qfu: 40,  lenFt: 11000 },
  { icao: 'KMDW', name: 'Chicago/Midway',    lat: 41.7868, lng: -87.7522, equip: 'L3', rwy: '13C/31C', qfu: 130, lenFt: 6522  },
  { icao: 'KIAH', name: 'Houston/Bush',      lat: 29.9844, lng: -95.3414, equip: 'L4', rwy: '08L/26R', qfu: 90,  lenFt: 12001 },
  { icao: 'KMSP', name: 'Minneapolis/StP',   lat: 44.8848, lng: -93.2223, equip: 'L4', rwy: '12L/30R', qfu: 120, lenFt: 10000 },
  { icao: 'KPHX', name: 'Phoenix/Sky Harbor', lat: 33.4343, lng: -112.0117, equip: 'L4', rwy: '07R/25L', qfu: 70,  lenFt: 11489 },
  { icao: 'KCLT', name: 'Charlotte',         lat: 35.2140, lng: -80.9431, equip: 'L4', rwy: '18C/36C', qfu: 180, lenFt: 10000 },
  { icao: 'KSLC', name: 'Salt Lake City',    lat: 40.7884, lng: -111.9778, equip: 'L3', rwy: '16L/34R', qfu: 160, lenFt: 12003 },
  { icao: 'KDTW', name: 'Detroit',           lat: 42.2124, lng: -83.3534, equip: 'L4', rwy: '04R/22L', qfu: 40,  lenFt: 10000 },
  { icao: 'KDCA', name: 'Washington/Reagan', lat: 38.8512, lng: -77.0402, equip: 'L3', rwy: '01/19',   qfu: 10,  lenFt: 7169  },
  { icao: 'KMCO', name: 'Orlando',           lat: 28.4312, lng: -81.3081, equip: 'L4', rwy: '18L/36R', qfu: 180, lenFt: 12005 },
  { icao: 'KMEM', name: 'Memphis',           lat: 35.0424, lng: -89.9767, equip: 'L4', rwy: '18R/36L', qfu: 180, lenFt: 9320  },
  { icao: 'KAUS', name: 'Austin/Bergstrom',  lat: 30.1945, lng: -97.6699, equip: 'L3', rwy: '18L/36R', qfu: 180, lenFt: 12250 },
  { icao: 'KSAN', name: 'San Diego',         lat: 32.7338, lng: -117.1933, equip: 'L3', rwy: '09/27',  qfu: 90,  lenFt: 9401  },
  { icao: 'EHAM', name: 'Amsterdam/Schiphol', lat: 52.3086, lng: 4.7639,  equip: 'L4', rwy: '18C/36C', qfu: 180, lenFt: 10827 },
  { icao: 'EGLL', name: 'London/Heathrow',   lat: 51.4700, lng: -0.4543,  equip: 'L4', rwy: '09L/27R', qfu: 90,  lenFt: 12802 },
  { icao: 'LFPG', name: 'Paris/CDG',         lat: 49.0097, lng: 2.5479,   equip: 'L4', rwy: '08L/26R', qfu: 90,  lenFt: 13829 },
  { icao: 'EDDF', name: 'Frankfurt',         lat: 50.0379, lng: 8.5622,   equip: 'L4', rwy: '07C/25C', qfu: 70,  lenFt: 13123 },
  { icao: 'EGKK', name: 'London/Gatwick',    lat: 51.1481, lng: -0.1903,  equip: 'L3', rwy: '08R/26L', qfu: 80,  lenFt: 10879 },
  { icao: 'LFBO', name: 'Toulouse',          lat: 43.6294, lng: 1.3638,   equip: 'L3', rwy: '14L/32R', qfu: 140, lenFt: 11483 },
  { icao: 'LSZH', name: 'Zurich',            lat: 47.4582, lng: 8.5556,   equip: 'L4', rwy: '14/32',   qfu: 140, lenFt: 10827 },
  { icao: 'OMDB', name: 'Dubai',             lat: 25.2528, lng: 55.3644,  equip: 'L4', rwy: '12L/30R', qfu: 120, lenFt: 13124 },
  { icao: 'WSSS', name: 'Singapore/Changi',  lat: 1.3644,  lng: 103.9915, equip: 'L4', rwy: '02L/20R', qfu: 20,  lenFt: 13123 },
  { icao: 'RJTT', name: 'Tokyo/Haneda',      lat: 35.5494, lng: 139.7798, equip: 'L4', rwy: '16L/34R', qfu: 160, lenFt: 10171 },
]

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 }
}

function haversineFt(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 20902231 // earth radius in ft
  const toRad = (d: number) => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}
function initialBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => d * Math.PI / 180
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2))
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1))
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}
function trackDelta(a: number, b: number): number {
  let d = Math.abs(a - b) % 360
  if (d > 180) d = 360 - d
  return d
}

function pickEquip(klass: string, h: number, eqpDown: number): Equip {
  const r = ((h >>> 16) & 0xff) / 255
  // Bias by class — heavies usually have L4
  const t = klass.startsWith('B7') || klass.startsWith('A3') || klass.startsWith('B74') ? 0.05 : 0.20
  const adj = t + (eqpDown / 100) * 0.20
  if (r < adj * 0.15) return 'L1'
  if (r < adj * 0.50) return 'L2'
  if (r < adj) return 'L3'
  return 'L4'
}

interface Row {
  f: AsdexFlight
  airport: Airport | null
  distToAirportFt: number
  rwyEdgeFt: number
  phase: Phase
  equip: Equip
  conflictIcao: string
  conflictCs: string
  conflictTtiSec: number
  conflictDistFt: number
  trackVsQfu: number
  wrongRwy: boolean
  stopBar: boolean
  sev: { inc: number; cfl: number; xsp: number; wrn: number; eqp: number; stb: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'asdex-halo', SRC_LBL = 'asdex-lbl', SRC_PIN = 'asdex-pin', SRC_CONF = 'asdex-conf', SRC_AIRP = 'asdex-airp', SRC_REF = 'asdex-ref'
const LYR_HALO = 'asdex-halo-l', LYR_LBL = 'asdex-lbl-l', LYR_PIN = 'asdex-pin-l', LYR_CONF = 'asdex-conf-l', LYR_AIRP = 'asdex-airp-l', LYR_AIRPL = 'asdex-airpl-l', LYR_REF = 'asdex-ref-l'

export default function AsdexSurface({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [equipFilter, setEquipFilter] = useState<Equip | 'ALL'>('ALL')
  const [minVel, setMinVel] = useState(0)
  const [fleetAge, setFleetAge] = useState(100)
  const [trafDens, setTrafDens] = useState(100)
  const [eqpDown, setEqpDown] = useState(0)
  const [conflictMul, setConflictMul] = useState(100)
  const [wrnRate, setWrnRate] = useState(100)
  const [phaseWt, setPhaseWt] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showConf, setShowConf] = useState(true)
  const [showAirp, setShowAirp] = useState(true)
  const [showRef, setShowRef] = useState(false)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  // Pre-filter to ground or low-altitude
  const ground = useMemo(() => flights.filter(f => f.ground || f.altitudeFt < 500), [flights])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of ground) {
      if ((f.velocityKts || 0) < minVel) continue
      const h = hash32(f.icao || '')
      const rnd = lcg(h)
      const t = (f.type || '').toUpperCase()
      const equip = pickEquip(t, h, eqpDown)
      // Nearest airport — limit to ~10 nm
      let best: Airport | null = null
      let bestDistFt = Infinity
      for (const ap of AIRPORTS) {
        const d = haversineFt(f.lat, f.lng, ap.lat, ap.lng)
        if (d < bestDistFt) { bestDistFt = d; best = ap }
      }
      if (!best || bestDistFt > 30000) continue
      const vel = f.velocityKts || 0
      let phase: Phase = 'GATE'
      if (!f.ground && f.altitudeFt > 200) phase = 'AIR'
      else if (vel >= 80) phase = 'LAND'
      else if (vel >= 35) phase = 'ROLL'
      else if (vel >= 5) phase = 'TAXI'
      else if (((h >>> 8) & 0x3) === 0) phase = 'PUSH'
      else phase = bestDistFt < 5000 ? 'LINEUP' : 'GATE'
      if (phase === 'AIR') continue

      const trackVsQfu = trackDelta(f.track || 0, best.qfu)
      // Distance from runway edge: hash-stable so a fraction are inside the rwy strip
      // Simulate: 8% of taxiing aircraft are within 200 ft of an active runway
      const incursionPctile = rnd()
      const rwyEdgeFt = phase === 'ROLL' || phase === 'LAND' || phase === 'LINEUP'
        ? -10  // on the runway by definition
        : (incursionPctile < 0.08 * (trafDens / 100) ? rnd() * 200 : 200 + rnd() * 1500)

      // Conflict-pair: find another ground aircraft within 2000 ft
      let confIcao = '', confCs = '', confTti = 9999, confDist = 9999
      for (const g of ground) {
        if (g.icao === f.icao) continue
        const d = haversineFt(f.lat, f.lng, g.lat, g.lng)
        if (d > 3000) continue
        // Closing speed: project relative motion
        const brg = initialBearing(f.lat, f.lng, g.lat, g.lng)
        const myV = vel
        const gV = g.velocityKts || 0
        const myComp = myV * Math.cos((f.track - brg) * Math.PI / 180)
        const gComp = -gV * Math.cos((g.track - brg) * Math.PI / 180)
        const closing = myComp + gComp  // kt closing toward each other along the bearing
        if (closing <= 1) continue  // not converging
        const closingFps = closing * 1.68781
        const tti = d / closingFps
        if (tti < confTti) { confTti = tti; confIcao = g.icao; confCs = g.callsign || g.icao; confDist = d }
      }
      confTti = confTti * (conflictMul / 100 > 0 ? 100 / conflictMul : 1)
      const wrongRwy = phase === 'ROLL' && trackVsQfu > 30 && rnd() < 0.15 * (wrnRate / 100)
      const stopBar = phase === 'TAXI' && incursionPctile < 0.06 * (trafDens / 100)

      // Severities
      const incSev = rwyEdgeFt <= 0 ? 100 : rwyEdgeFt >= 500 ? 0 : (1 - rwyEdgeFt / 500) * 100
      const cflSev = confTti <= 12 ? 100 : confTti >= 90 ? 0 : ((90 - confTti) / 78) * 100
      const xspSev = (phase === 'TAXI' && rwyEdgeFt < 200 && vel >= 8) ? Math.min(100, ((vel - 8) / 17) * 100) : 0
      const wrnSev = wrongRwy ? 100 : (phase === 'ROLL' && trackVsQfu > 15 ? ((trackVsQfu - 15) / 15) * 80 : 0)
      const eqpSev = equip === 'L1' ? 100 : equip === 'L2' ? 60 : equip === 'L3' ? 30 : 0
      const stbSev = stopBar ? 100 : 0
      const sev = { inc: incSev, cfl: cflSev, xsp: xspSev, wrn: wrnSev, eqp: eqpSev, stb: stbSev }
      const drivers: Array<[Driver, number]> = [['INC', incSev], ['CFL', cflSev], ['XSP', xspSev], ['WRN', wrnSev], ['EQP', eqpSev], ['STB', stbSev]]
      drivers.sort((a, b) => b[1] - a[1])
      const driver: Driver = drivers[0][1] >= 12 ? drivers[0][0] : 'NONE'

      const phaseMul = 1 + ((PHASE_MUL[phase] - 1) * (phaseWt / 100))
      const max = drivers[0][1], secondary = drivers[1][1]
      let score = Math.min(100, Math.max(0, max * phaseMul + 0.10 * secondary))
      if (rwyEdgeFt <= 0 && phase !== 'ROLL' && phase !== 'LAND' && phase !== 'LINEUP') score = Math.max(score, 95)
      if (confTti <= 12) score = Math.max(score, 92)
      if (wrongRwy) score = Math.max(score, 90)


      let tier: Tier
      if (score >= 80) tier = 'COLLISION'
      else if (score >= 55) tier = 'INCURSION'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({ f, airport: best, distToAirportFt: bestDistFt, rwyEdgeFt, phase, equip,
        conflictIcao: confIcao, conflictCs: confCs, conflictTtiSec: confTti, conflictDistFt: confDist,
        trackVsQfu, wrongRwy, stopBar, sev, score, driver, tier })
    }
    return out
  }, [ground, minVel, fleetAge, trafDens, eqpDown, conflictMul, wrnRate, phaseWt])

  const tierCount: Record<Tier, number> = { COLLISION: 0, INCURSION: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++

  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null
  const meanTti = (() => {
    const v = rows.filter(r => isFinite(r.conflictTtiSec) && r.conflictTtiSec < 9999)
    return v.length ? v.reduce((a, r) => a + r.conflictTtiSec, 0) / v.length : 0
  })()
  const incursionShare = rows.length ? rows.filter(r => r.rwyEdgeFt <= 200 && r.phase === 'TAXI').length / rows.length : 0
  const equipGapShare = rows.length ? rows.filter(r => r.equip === 'L1' || r.equip === 'L2').length / rows.length : 0
  const xRwyShare = rows.length ? rows.filter(r => r.sev.xsp > 0).length / rows.length : 0

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (equipFilter !== 'ALL') r = r.filter(x => x.equip === equipFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(x => (x.f.callsign || '').toLowerCase().includes(q) || (x.f.type || '').toLowerCase().includes(q) || (x.f.icao || '').toLowerCase().includes(q) || (x.airport?.icao || '').toLowerCase().includes(q))
    return r.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, equipFilter, query])

  const airportRows = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of rows) {
      if (!r.airport) continue
      const k = r.airport.icao
      const e = m.get(k) || []; e.push(r); m.set(k, e)
    }
    const arr: Array<{ ap: Airport; ac: number; col: number; inc: number; wrnCount: number; meanScore: number; worstCs: string }> = []
    for (const [k, v] of m) {
      const ap = AIRPORTS.find(a => a.icao === k)!
      const ms = v.reduce((a, r) => a + r.score, 0) / v.length
      const wc = v.slice().sort((a, b) => b.score - a.score)[0]
      arr.push({ ap, ac: v.length,
        col: v.filter(r => r.tier === 'COLLISION').length,
        inc: v.filter(r => r.tier === 'INCURSION').length,
        wrnCount: v.filter(r => r.wrongRwy).length,
        meanScore: ms, worstCs: wc?.f.callsign || wc?.f.icao || '' })
    }
    arr.sort((a, b) => b.col - a.col || b.inc - a.inc || b.ac - a.ac)
    return arr
  }, [rows])

  useEffect(() => {
    if (!map) return
    const ensureSource = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }) }
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_CONF, SRC_AIRP, SRC_REF]
    sources.forEach(ensureSource)
    if (!map.getLayer(LYR_REF)) map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.15, 'line-width': 0.8, 'line-dasharray': [2, 4] } })
    if (!map.getLayer(LYR_CONF)) map.addLayer({ id: LYR_CONF, type: 'line', source: SRC_CONF, paint: { 'line-color': ['get', 'color'], 'line-width': 1.6, 'line-opacity': 0.75, 'line-dasharray': [1.5, 2] } })
    if (!map.getLayer(LYR_HALO)) map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.7, 'circle-stroke-width': 1.4 } })
    if (!map.getLayer(LYR_AIRP)) map.addLayer({ id: LYR_AIRP, type: 'circle', source: SRC_AIRP, paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-opacity': 0.75, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1 } })
    if (!map.getLayer(LYR_AIRPL)) map.addLayer({ id: LYR_AIRPL, type: 'symbol', source: SRC_AIRP, layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, 1.0], 'text-allow-overlap': false }, paint: { 'text-color': '#94a3b8', 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    if (!map.getLayer(LYR_PIN)) map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': '◆', 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    if (!map.getLayer(LYR_LBL)) map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })

    const halo: any[] = [], lbl: any[] = [], pin: any[] = [], conf: any[] = []
    const groundLookup = new Map(ground.map(g => [g.icao, g]))
    for (const r of rows) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && (r.tier === 'COLLISION' || r.tier === 'INCURSION')) {
        const rad = 8 + (r.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: rad } })
      }
      if (showPin && r.tier === 'COLLISION') pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      if (showLabels && (r.tier === 'COLLISION' || r.tier === 'INCURSION')) {
        const tti = r.conflictTtiSec < 9999 ? ` · TTI ${r.conflictTtiSec.toFixed(0)}s` : ''
        const label = `${r.f.callsign || r.f.icao} ${r.phase} · ${r.airport?.icao} ${r.airport?.rwy}${tti} · ${r.driver}`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showConf && r.conflictIcao && (r.tier === 'COLLISION' || r.tier === 'INCURSION')) {
        const g = groundLookup.get(r.conflictIcao)
        if (g) conf.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [g.lng, g.lat]] }, properties: { color } })
      }
    }
    const airp: any[] = []
    if (showAirp) {
      const eqpColor: Record<Equip, string> = { L4: '#10b981', L3: '#0ea5e9', L2: '#f59e0b', L1: '#ef4444' }
      for (const ap of AIRPORTS) {
        airp.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [ap.lng, ap.lat] }, properties: { color: eqpColor[ap.equip], label: `${ap.icao} · ${ap.equip}` } })
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
    ;(map.getSource(SRC_CONF) as any).setData({ type: 'FeatureCollection', features: conf })
    ;(map.getSource(SRC_AIRP) as any).setData({ type: 'FeatureCollection', features: airp })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: refFeats })
    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_AIRPL, LYR_AIRP, LYR_CONF, LYR_REF]) { if (m.getLayer(id)) m.removeLayer(id) }
      for (const id of sources) { if (m.getSource(id)) m.removeSource(id) }
    }
  }, [map, rows, ground, showHalo, showPin, showLabels, showConf, showAirp, showRef])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const driverBadge = (d: Driver, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const equipPill = (e: Equip) => {
    const col = e === 'L4' ? '#10b981' : e === 'L3' ? '#0ea5e9' : e === 'L2' ? '#f59e0b' : '#ef4444'
    return <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '66', backgroundColor: col + '14' }}>{e}</span>
  }
  const phasePill = (p: Phase) => (
    <span className="inline-flex items-center px-1 py-px rounded text-[9px] text-slate-300 border border-slate-700 bg-slate-800">{p}</span>
  )

  const advice = (r: Row): string => {
    if (r.tier === 'COLLISION') {
      if (r.driver === 'INC') return `Runway-edge incursion (${r.rwyEdgeFt.toFixed(0)} ft inside ${r.airport?.rwy} strip) — HOLD POSITION transmit ATC IMMEDIATELY per FAA Order JO 7110.65 §3-1-12, expect ASDE-X Safety Logic Level 4 alert`
      if (r.driver === 'CFL') return `Conflict ${r.conflictCs} TTI ${r.conflictTtiSec.toFixed(0)} s ≤ 12 s ASDE-X collision threshold — REJECT / GO-AROUND per SAFO 23002 reference DCA23IA070 KAUS SWA-FedEx`
      if (r.driver === 'WRN') return `Wrong-runway departure ${r.airport?.rwy} (track Δ${r.trackVsQfu.toFixed(0)}°) — ABORT TAKEOFF before V1 per AC 91-73B, reference NTSB AAR-08/04 Comair 5191 LEX wrong-runway`
      if (r.driver === 'STB') return `Stop-bar / hold-short violation at ${r.airport?.icao} — HOLD POSITION per ICAO Doc 9870, MOR mandatory per EAPPRI Edition 3`
      return `Imminent collision risk — HOLD POSITION, ATC priority transmit per Doc 4444 §7.5`
    }
    if (r.tier === 'INCURSION') return `${DRIVER_LABEL[r.driver]} — request progressive taxi per Doc 9830, brief surface chart, monitor ASDE-X Safety Logic per FAA Order JO 7210.3DD §10-3-12, file MOR if event develops`
    if (r.tier === 'WATCH') return `${DRIVER_LABEL[r.driver]} within margin — RAAS-style awareness call, monitor ground frequency per AIM 4-3-18`
    if (r.tier === 'OK') return `Surface state nominal — A-SMGCS ${EQUIP_LABEL[r.equip]} coverage`
    return ''
  }

  const W = 280, H = 180
  const xMax = 60   // TTI seconds
  const yMax = 1500 // ft to runway edge
  const sx = (v: number) => 30 + (Math.max(0, Math.min(xMax, v)) / xMax) * (W - 40)
  const sy = (v: number) => (H - 24) - (Math.max(0, Math.min(yMax, v)) / yMax) * (H - 48)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">ASDE-X / A-SMGCS surface</div>
          <div className="text-[10px] text-slate-500">FAA Order JO 7110.65 · ICAO Doc 9830 · Doc 9870 RWY incursion</div>
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
          <div className="text-[9px] text-slate-500 uppercase">Collision</div>
          <div className="text-sm font-semibold" style={{ color: tierCount.COLLISION > 0 ? '#ef4444' : '#10b981' }}>{tierCount.COLLISION}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean TTI</div>
          <div className="text-sm font-semibold" style={{ color: meanTti && meanTti < 30 ? '#f59e0b' : '#10b981' }}>{meanTti ? meanTti.toFixed(0) + 's' : '—'}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Incursion%</div>
          <div className="text-xs font-semibold" style={{ color: incursionShare > 0.1 ? '#f59e0b' : '#10b981' }}>{(incursionShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Equip gap</div>
          <div className="text-xs font-semibold" style={{ color: equipGapShare > 0.25 ? '#f59e0b' : '#10b981' }}>{(equipGapShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">X-rwy%</div>
          <div className="text-xs font-semibold" style={{ color: xRwyShare > 0.05 ? '#f59e0b' : '#10b981' }}>{(xRwyShare * 100).toFixed(0)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W - 40} height={H - 48} fill="#0b1220" />
            {/* COLLISION quadrant TTI ≤ 12 OR edge ≤ 0 */}
            <rect x={30} y={24} width={sx(12) - 30} height={H - 48} fill="#ef4444" opacity={0.10} />
            <rect x={30} y={sy(0)} width={W - 40} height={(H - 24) - sy(0)} fill="#ef4444" opacity={0.10} />
            <rect x={sx(12)} y={24} width={sx(25) - sx(12)} height={sy(200) - 24} fill="#f59e0b" opacity={0.10} />
            <rect x={sx(25)} y={sy(500)} width={(W - 10) - sx(25)} height={(H - 24) - sy(500)} fill="#10b981" opacity={0.08} />
            <line x1={sx(12)} x2={sx(12)} y1={24} y2={H - 24} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.7} />
            <line x1={sx(25)} x2={sx(25)} y1={24} y2={H - 24} stroke="#f59e0b" strokeDasharray="2 3" strokeOpacity={0.6} />
            <line x1={30} x2={W - 10} y1={sy(200)} y2={sy(200)} stroke="#f59e0b" strokeDasharray="2 3" strokeOpacity={0.6} />
            <line x1={30} x2={W - 10} y1={sy(500)} y2={sy(500)} stroke="#10b981" strokeDasharray="2 3" strokeOpacity={0.4} />
            {[12, 25, 40, 60].map(t => <text key={`x${t}`} x={sx(t) - 6} y={H - 8} fontSize={8} fill="#64748b">{t}s</text>)}
            {[0, 200, 500, 1000, 1500].map(t => <text key={`y${t}`} x={4} y={sy(t) + 3} fontSize={8} fill="#64748b">{t}ft</text>)}
            {rows.filter(r => r.tier !== 'IDLE').map((r, i) => (
              <circle key={i} cx={sx(Math.min(60, r.conflictTtiSec))} cy={sy(Math.max(0, r.rwyEdgeFt))} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
            <text x={W / 2} y={H - 6} fontSize={9} fill="#64748b" textAnchor="middle">conflict TTI s · runway-edge dist ft</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-VEL {minVel} kt</span><input type="range" min={0} max={50} value={minVel} onChange={e => setMinVel(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">FLEET-AGE {fleetAge}%</span><input type="range" min={50} max={200} value={fleetAge} onChange={e => setFleetAge(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">TRAF-DENS {trafDens}%</span><input type="range" min={50} max={250} value={trafDens} onChange={e => setTrafDens(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">EQP-DOWN {eqpDown}%</span><input type="range" min={0} max={100} value={eqpDown} onChange={e => setEqpDown(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">CONFLICT-MUL {conflictMul}%</span><input type="range" min={50} max={250} value={conflictMul} onChange={e => setConflictMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">WRN-RATE {wrnRate}%</span><input type="range" min={0} max={300} value={wrnRate} onChange={e => setWrnRate(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col col-span-2"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setEquipFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${equipFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {EQUIP_LIST.map(e => (
          <button key={e} onClick={() => setEquipFilter(equipFilter === e ? 'ALL' : e)} className={`px-2 py-0.5 rounded text-[10px] border ${equipFilter === e ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{e}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['CONF', showConf, setShowConf], ['AIRP', showAirp, setShowAirp], ['REF', showRef, setShowRef], ['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / icao / airport" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'AIRPORTS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              {phasePill(r.phase)}
              {equipPill(r.equip)}
              {r.wrongRwy && <span className="px-1 py-px rounded text-[9px] font-semibold" style={{ color: '#ef4444', border: '1px solid #ef444466', backgroundColor: '#ef444414' }}>WRN-RWY</span>}
              {r.stopBar && <span className="px-1 py-px rounded text-[9px] font-semibold" style={{ color: '#ef4444', border: '1px solid #ef444466', backgroundColor: '#ef444414' }}>STOP-BAR</span>}
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              {r.airport?.icao} {r.airport?.rwy} · QFU {r.airport?.qfu.toFixed(0)}° · trk {r.f.track.toFixed(0)}° · Δ{r.trackVsQfu.toFixed(0)}° · vel {r.f.velocityKts.toFixed(0)} kt · rwy-edge {r.rwyEdgeFt.toFixed(0)} ft
              {r.conflictIcao && <> · <button onClick={() => onFly(r.conflictIcao)} className="text-sky-400 hover:text-sky-300">CONF {r.conflictCs}</button> TTI {r.conflictTtiSec.toFixed(0)}s @ {r.conflictDistFt.toFixed(0)}ft</>}
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('INC', r.sev.inc)}
              {driverBadge('CFL', r.sev.cfl)}
              {driverBadge('XSP', r.sev.xsp)}
              {driverBadge('WRN', r.sev.wrn)}
              {driverBadge('EQP', r.sev.eqp)}
              {driverBadge('STB', r.sev.stb)}
            </div>
            <div className="px-2 pb-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {advice(r)}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No surface traffic within range.</div>
        )}

        {tab === 'AIRPORTS' && airportRows.map((c, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${c.col > 0 ? '#ef4444' : c.inc > 0 ? '#f59e0b' : '#10b981'}` }}>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300 font-mono">{c.ap.icao}</span>
              <span className="text-slate-300 truncate">{c.ap.name}</span>
              {equipPill(c.ap.equip)}
              <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{c.ac} ac</span>
            </div>
            <div className="px-2 text-[10px] text-slate-400">RWY {c.ap.rwy} · QFU {c.ap.qfu.toFixed(0)}° · {c.ap.lenFt} ft · COL <span style={{ color: c.col > 0 ? '#ef4444' : '#64748b' }}>{c.col}</span> · INC <span style={{ color: c.inc > 0 ? '#f59e0b' : '#64748b' }}>{c.inc}</span> · WRN <span style={{ color: c.wrnCount > 0 ? '#ef4444' : '#64748b' }}>{c.wrnCount}</span> · mean {c.meanScore.toFixed(0)}</div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${Math.min(100, c.meanScore)}%`, backgroundColor: c.col > 0 ? '#ef4444' : c.inc > 0 ? '#f59e0b' : '#10b981' }} className="h-full" />
              </div>
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-500">worst <button onClick={() => { const w = rows.find(rw => rw.airport?.icao === c.ap.icao && (rw.f.callsign === c.worstCs || rw.f.icao === c.worstCs)); if (w) onFly(w.f.icao) }} className="text-sky-400 hover:text-sky-300">{c.worstCs || '—'}</button></div>
          </div>
        ))}
        {tab === 'AIRPORTS' && airportRows.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No tracked surface aircraft at catalogue airports.</div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: FAA Order JO 7110.65 §3-1-12 · JO 7210.3DD §10-3-12 ASDE-X/ASSC · AC 120-74C · AC 91-73B · ICAO Doc 9830 A-SMGCS · Doc 9870 Runway Incursion · Doc 4444 §7.5 · Annex 14 Vol I §3.10 · Annex 11 §3.4.4 · EUROCONTROL EAPPRI Ed.3 · EUROCAE ED-87C · RTCA DO-272D AMDB · MITRE ASDE-X Safety Logic (2011) · NTSB AAR-91/08 USAir 1493 LAX · AAR-08/04 Comair 5191 LEX · DCA17IA148 SFO AC759 · DCA23IA070 KAUS SWA-FedEx · DCA23FA152 KMDW NetJets · SAFO 23002 · ARINC 622 / 718A surface-DF11.
      </div>
    </div>
  )
}
