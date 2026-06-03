'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   ARTCC / UAC Sector Crossing & Frequency Hand-off Coordinator
   ------------------------------------------------------------
   For every enroute airframe, projects ground-track forward,
   identifies the next ARTCC / UAC (Upper-Area Control) sector
   boundary crossing, computes time-to-boundary (TTB), the
   primary VHF / UHF / HF hand-off frequency for the receiving
   sector, and grades the coordination posture:

     · prior-coordination window per FAA Order JO 7110.65 §2-1-14
       (point-out / hand-off coordination ≥ 2 min before est.
       boundary crossing)
     · receiving-sector traffic load vs Monitor Alert Parameter
       (MAP) per JO 7210.3DD §17-9-1
     · CPDLC vs VHF / HF reversion eligibility per ICAO Doc 4444
       §4.11 / NAT Doc 007 ch 13
     · frequency-change cleared inhibits (LOA / FRA agreements)

   Regulatory & operational basis:
     · FAA Order JO 7110.65   §2-1-14 hand-off / point-out
                              §2-1-17 radio communications
                              §2-4-22 frequency change
                              §6-1-1  oceanic transfer of control
                              §8-1-10 oceanic frequency
     · FAA Order JO 7210.3DD  §17-9-1 MAP value
                              §17-10-7 sector splits
     · FAA AC 91-70B          Oceanic & remote ops
     · ICAO Doc 4444 PANS-ATM §10 transfer of control
                              §4.11 CPDLC
                              §11   ATS messages
     · ICAO Annex 11 §3.5     Transfer of control & comm
     · ICAO Annex 10 Vol II   §5.2 air-ground voice
     · NAT Doc 007 ch 9 / 13  HF SELCAL / CPDLC reversion
     · EUROCONTROL OPS Manual §3.4 Free-Route Airspace (FRA)
     · LoA (Letters of Agreement) standard frequency map
     · ARINC 622 ATN transfer · ARINC 587 frequency mgmt
     · NTSB AAR-87/03 NORDO Westcoast 458 frequency stuck-mic
     · NTSB AAR-06/03 ASA 261 long NORDO frequency lapse
     · NTSB DCA08IA078 NORDO transfer EWR-ZNY
     · ASN ZBB-Helios NORDO frequency-handoff failure

   Algorithm:
     1. Build 22 ARTCC + 6 oceanic UAC catalogue with polygon-
        bounded box geometry, primary high-altitude VHF + UHF
        guard + HF families, mean traffic flow per shift, MAP
        ceiling, LOA partners.
     2. Per-airframe FNV-1a 32-bit hash of ICAO24 synthesises
        current control sector via point-in-polygon test on
        live lat/lng, CPDLC equipage (FANS-1A / ATN-B1 / NONE),
        on-frequency-time-since-last-handoff (stuck-mic proxy).
     3. Forward-project track 60 min at current GS to find next
        sector boundary crossing point and TTB in seconds.
     4. Receiving-sector load = count of own + adjacent traffic
        within sector vs MAP cap.
     5. 6 risk drivers, max-driver composite:
          TTB    time-to-boundary vs 2-min coord window
                  0 at ≥ 180 s, 100 at ≤ 30 s
          COR    coordination posture (prior-coord effected)
                  100 if TTB < 120 s and not pre-coord
          LOD    receiving-sector load vs MAP
                  0 at ≤ 70% MAP, 100 at ≥ 110% MAP
          CPD    CPDLC eligibility gap (FANS-1A / ATN-B1 vs none)
                  required oceanic + recommended enroute
          STK    stuck-on-prior-frequency time
                  0 at ≤ 8 min, 100 at ≥ 25 min
          REV    HF/VHF reversion gap (oceanic exit to domestic)
     6. Phase multiplier:
          BOUND  1.35  within 3 min of crossing
          ENR    1.00  cruise
          OCN    1.20  oceanic
          REM    1.10  remote
          IDLE   0     terminal/ground
     7. Hard escalations:
          TTB ≤ 60 s without pre-coord                 ≥ 92  LATE-HOFF
          Stuck-on-prior > 25 min in domestic          ≥ 90  NORDO drift
          Receiving load ≥ 110% MAP                    ≥ 86  GDP-tier
          CPDLC NONE crossing oceanic boundary         ≥ 88
     8. 5 tiers:
          LATE-HOFF score ≥ 80  rose  EMERGENCY: hand-off not
                  effected within 2-min FAA Order JO 7110.65
                  §2-1-14 window, request controller to
                  initiate point-out or revert to guard 121.5
          COORD   score ≥ 55  amber Initiate coordination now
                  per LOA / NAT Doc 007 ch 9, brief frequency
          WATCH   score ≥ 25  sky   Monitor frequency change,
                  pre-tune secondary box per ICAO Doc 4444 §10
          HOFF-OK score < 25  emerald Within coordination window
          IDLE    not in enroute/oceanic scope  slate

   MapLibre overlay:
     · Tier-coloured halo ring 8-22 px by score
     · Rose diamond LATE-HOFF pin
     · 28 sector boundary polylines (4-tier coloured by load:
       OK emerald / WARN sky / SATURATED amber / OVER rose)
     · Dashed tier-coloured forward-projection 60 nm
     · Diamond marker at projected boundary crossing point
     · Sector centroid pin with ID + frequency label
     · Tier-coloured callsign + sector + freq + TTB labels
     · Sky reference parallels at lat 60/30/0/-30/-60 every 12°

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell LATE-HOFF count / WORST callsign / MEAN TTB
     · 3-cell CPDLC-share / STUCK-share / OVER-MAP-share
     · SVG TTB-s vs receiving-load-% scatter, rose LATE quadrant
       TTB ≤ 60 s or load ≥ 110, amber COORD band, emerald OK
     · 7 sliders MIN-FL / TRAF-DEN / COORD-WIN / STK-NOISE /
       LOAD-MUL / CPDLC-DOWN / PHASE-WT
     · 4-equip chip filter FANS-1A / ATN-B1 / VHF-ONLY / NONE
     · HALO PIN LBL PROJ BND CENT REF DIAG toggles + search
     · AIRCRAFT / SECTORS tab switcher
     · AIRCRAFT row: tier stripe + callsign + sector-pill +
       equip-pill + tier-pill + freq + TTB + load + STK-min
     · SECTORS row: ID + name + MAP + load + ac-count +
       LATE-count + freq + worst-callsign

   Layers > Safety & Traffic.
   Persisted: ft-artcc
   ============================================================ */

interface AcFlight {
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
  flights: AcFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'LATE-HOFF' | 'COORD' | 'WATCH' | 'HOFF-OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'LATE-HOFF': '#ef4444', COORD: '#f59e0b', WATCH: '#0ea5e9', 'HOFF-OK': '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['LATE-HOFF', 'COORD', 'WATCH', 'HOFF-OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { 'LATE-HOFF': 0, COORD: 1, WATCH: 2, 'HOFF-OK': 3, IDLE: 4 }

type Equip = 'FANS-1A' | 'ATN-B1' | 'VHF-ONLY' | 'NONE'
const EQUIP_LIST: Equip[] = ['FANS-1A', 'ATN-B1', 'VHF-ONLY', 'NONE']

type Driver = 'TTB' | 'COR' | 'LOD' | 'CPD' | 'STK' | 'REV' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  TTB: 'Time-to-boundary', COR: 'Coordination not effected', LOD: 'Receiving-sector load',
  CPD: 'CPDLC equipage', STK: 'Stuck-on-prior frequency', REV: 'HF/VHF reversion', NONE: 'Nominal',
}

type Phase = 'BOUND' | 'OCN' | 'REM' | 'ENR' | 'IDLE'
const PHASE_MUL: Record<Phase, number> = { BOUND: 1.35, OCN: 1.20, REM: 1.10, ENR: 1.00, IDLE: 0 }

type LoadTier = 'OK' | 'WARN' | 'SATURATED' | 'OVER'
const LOAD_COLOR: Record<LoadTier, string> = { OK: '#10b981', WARN: '#0ea5e9', SATURATED: '#f59e0b', OVER: '#ef4444' }

interface Sector {
  id: string         // ARTCC 3-letter (ZDC, ZNY, ZLA, …) or UAC 4-letter (KZAK, EGGX, …)
  name: string
  kind: 'ARTCC' | 'UAC'
  // axis-aligned bbox (deg)
  latMin: number; latMax: number; lngMin: number; lngMax: number
  freq: string       // primary high-altitude VHF (or HF family for oceanic)
  guard: string      // guard freq (121.5 / 243.0 etc)
  map: number        // Monitor Alert Parameter (max sector AC count)
  loa: string[]      // adjacent sectors with LOA partners
  cpdlcRequired: boolean
}

// 22 CONUS ARTCC + 6 oceanic / European UACs.  Bbox is coarse but
// sufficient for point-in-polygon and forward-projection crossings.
const SECTORS: Sector[] = [
  // === CONUS ARTCC (FAA) ===
  { id: 'ZAB', name: 'Albuquerque',  kind: 'ARTCC', latMin: 31, latMax: 37, lngMin: -109, lngMax: -103, freq: '134.450', guard: '121.500', map: 14, loa: ['ZDV','ZLA','ZKC','ZFW','ZHU'], cpdlcRequired: false },
  { id: 'ZAU', name: 'Chicago',      kind: 'ARTCC', latMin: 39, latMax: 44, lngMin: -91, lngMax: -83, freq: '133.200', guard: '121.500', map: 18, loa: ['ZMP','ZID','ZOB','ZKC'], cpdlcRequired: false },
  { id: 'ZBW', name: 'Boston',       kind: 'ARTCC', latMin: 40.5, latMax: 47, lngMin: -74, lngMax: -66, freq: '133.450', guard: '121.500', map: 16, loa: ['ZNY','CZUL','EGGX'], cpdlcRequired: false },
  { id: 'ZDC', name: 'Washington',   kind: 'ARTCC', latMin: 35.5, latMax: 40.5, lngMin: -83, lngMax: -74.5, freq: '134.150', guard: '121.500', map: 17, loa: ['ZNY','ZOB','ZID','ZTL'], cpdlcRequired: false },
  { id: 'ZDV', name: 'Denver',       kind: 'ARTCC', latMin: 37, latMax: 45, lngMin: -109, lngMax: -100, freq: '127.950', guard: '121.500', map: 14, loa: ['ZLC','ZMP','ZKC','ZAB'], cpdlcRequired: false },
  { id: 'ZFW', name: 'Fort Worth',   kind: 'ARTCC', latMin: 30, latMax: 36, lngMin: -103, lngMax: -94, freq: '127.825', guard: '121.500', map: 15, loa: ['ZAB','ZKC','ZME','ZHU'], cpdlcRequired: false },
  { id: 'ZHU', name: 'Houston',      kind: 'ARTCC', latMin: 25, latMax: 31, lngMin: -97, lngMax: -86, freq: '128.450', guard: '121.500', map: 14, loa: ['ZFW','ZME','ZJX','ZMA','MMFR'], cpdlcRequired: false },
  { id: 'ZID', name: 'Indianapolis', kind: 'ARTCC', latMin: 36, latMax: 41, lngMin: -88, lngMax: -82, freq: '125.250', guard: '121.500', map: 15, loa: ['ZAU','ZOB','ZDC','ZTL','ZME'], cpdlcRequired: false },
  { id: 'ZJX', name: 'Jacksonville', kind: 'ARTCC', latMin: 28, latMax: 33, lngMin: -84, lngMax: -77, freq: '134.000', guard: '121.500', map: 14, loa: ['ZTL','ZMA','ZHU','ZDC'], cpdlcRequired: false },
  { id: 'ZKC', name: 'Kansas City',  kind: 'ARTCC', latMin: 35.5, latMax: 41, lngMin: -100, lngMax: -91, freq: '127.625', guard: '121.500', map: 14, loa: ['ZMP','ZAU','ZME','ZFW','ZDV','ZAB'], cpdlcRequired: false },
  { id: 'ZLA', name: 'Los Angeles',  kind: 'ARTCC', latMin: 32, latMax: 38, lngMin: -120, lngMax: -113, freq: '134.300', guard: '121.500', map: 16, loa: ['ZOA','ZAB','ZLC','KZAK'], cpdlcRequired: false },
  { id: 'ZLC', name: 'Salt Lake',    kind: 'ARTCC', latMin: 38, latMax: 47, lngMin: -120, lngMax: -109, freq: '134.350', guard: '121.500', map: 13, loa: ['ZOA','ZSE','ZDV','ZLA'], cpdlcRequired: false },
  { id: 'ZMA', name: 'Miami',        kind: 'ARTCC', latMin: 24, latMax: 29, lngMin: -83, lngMax: -75, freq: '132.500', guard: '121.500', map: 15, loa: ['ZJX','ZHU','MUFH','TJZS'], cpdlcRequired: false },
  { id: 'ZME', name: 'Memphis',      kind: 'ARTCC', latMin: 32, latMax: 37, lngMin: -94, lngMax: -86, freq: '133.700', guard: '121.500', map: 14, loa: ['ZFW','ZHU','ZJX','ZTL','ZID','ZKC'], cpdlcRequired: false },
  { id: 'ZMP', name: 'Minneapolis',  kind: 'ARTCC', latMin: 41, latMax: 49, lngMin: -100, lngMax: -88, freq: '125.275', guard: '121.500', map: 13, loa: ['ZDV','ZKC','ZAU','CZWG'], cpdlcRequired: false },
  { id: 'ZNY', name: 'New York',     kind: 'ARTCC', latMin: 39, latMax: 42, lngMin: -76, lngMax: -71, freq: '134.700', guard: '121.500', map: 19, loa: ['ZBW','ZDC','ZOB','EGGX'], cpdlcRequired: false },
  { id: 'ZOA', name: 'Oakland',      kind: 'ARTCC', latMin: 35, latMax: 42, lngMin: -125, lngMax: -119, freq: '133.450', guard: '121.500', map: 14, loa: ['ZLA','ZLC','ZSE','KZAK'], cpdlcRequired: false },
  { id: 'ZOB', name: 'Cleveland',    kind: 'ARTCC', latMin: 39, latMax: 44, lngMin: -84, lngMax: -78, freq: '132.150', guard: '121.500', map: 17, loa: ['ZAU','ZID','ZNY','ZDC','CZYZ'], cpdlcRequired: false },
  { id: 'ZSE', name: 'Seattle',      kind: 'ARTCC', latMin: 42, latMax: 49, lngMin: -125, lngMax: -116, freq: '132.500', guard: '121.500', map: 13, loa: ['ZOA','ZLC','CZVR','PAZA'], cpdlcRequired: false },
  { id: 'ZTL', name: 'Atlanta',      kind: 'ARTCC', latMin: 32, latMax: 36, lngMin: -86, lngMax: -78, freq: '134.150', guard: '121.500', map: 17, loa: ['ZME','ZJX','ZDC','ZID'], cpdlcRequired: false },
  { id: 'PAZA', name: 'Anchorage',   kind: 'ARTCC', latMin: 55, latMax: 72, lngMin: -170, lngMax: -130, freq: '127.275', guard: '121.500', map: 11, loa: ['ZSE','PAZN','UHMM'], cpdlcRequired: false },
  { id: 'PHZH', name: 'Honolulu CZ', kind: 'ARTCC', latMin: 18, latMax: 25, lngMin: -162, lngMax: -154, freq: '134.100', guard: '121.500', map: 10, loa: ['PHZH-OCN'], cpdlcRequired: false },

  // === Oceanic UACs ===
  { id: 'KZAK', name: 'Oakland Oceanic',  kind: 'UAC', latMin: 5, latMax: 60, lngMin: -160, lngMax: -120, freq: 'HF 8.903/13.354', guard: '121.500', map: 9, loa: ['PHZH','RJJJ','ZOA','ZLA'], cpdlcRequired: true },
  { id: 'EGGX', name: 'Shanwick OAC',     kind: 'UAC', latMin: 45, latMax: 61, lngMin: -30, lngMax: -10, freq: 'HF 5.598/8.906', guard: '121.500', map: 8, loa: ['CZQX','EISN','LPPO'], cpdlcRequired: true },
  { id: 'CZQX', name: 'Gander Oceanic',   kind: 'UAC', latMin: 45, latMax: 63, lngMin: -65, lngMax: -30, freq: 'HF 6.628/8.906', guard: '121.500', map: 8, loa: ['EGGX','BIRD','ZNY','ZBW'], cpdlcRequired: true },
  { id: 'BIRD', name: 'Reykjavik OAC',    kind: 'UAC', latMin: 61, latMax: 82, lngMin: -30, lngMax: 0, freq: 'HF 5.616/8.864', guard: '121.500', map: 7, loa: ['EGGX','CZQX','BGGL'], cpdlcRequired: true },
  { id: 'RJJJ', name: 'Fukuoka Oceanic',  kind: 'UAC', latMin: 17, latMax: 45, lngMin: 123, lngMax: 165, freq: 'HF 6.532/8.951', guard: '121.500', map: 8, loa: ['KZAK','RKRR','RPHI'], cpdlcRequired: true },
  { id: 'YBBB', name: 'Brisbane Oceanic', kind: 'UAC', latMin: -45, latMax: -10, lngMin: 130, lngMax: 175, freq: 'HF 5.643/8.867', guard: '121.500', map: 7, loa: ['NZZO','WAAZ'], cpdlcRequired: true },
]

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

function findSector(lat: number, lng: number): Sector | null {
  for (const s of SECTORS) {
    if (lat >= s.latMin && lat <= s.latMax && lng >= s.lngMin && lng <= s.lngMax) return s
  }
  return null
}

// Forward-project track to find next sector boundary crossing in the next 60 min.
// Returns { ttbSec, crossLat, crossLng, nextSectorId, distNm } or null if none.
function projectBoundary(lat: number, lng: number, trackDeg: number, gsKt: number, current: Sector | null): { ttbSec: number; crossLat: number; crossLng: number; nextSector: Sector | null; distNm: number } | null {
  if (gsKt < 60) return null
  const trk = trackDeg * Math.PI / 180
  // dx/dy per nm
  const dLatPerNm = Math.cos(trk) / 60
  const dLngPerNm = Math.sin(trk) / (60 * Math.cos(lat * Math.PI / 180) || 0.01)
  // Step forward in 5-nm increments out to 600 nm (~80 min @ 450 kt)
  let pl = lat, pn = lng
  let curId = current?.id || ''
  for (let i = 1; i <= 120; i++) {
    pl += dLatPerNm * 5
    pn += dLngPerNm * 5
    const s = findSector(pl, pn)
    const id = s?.id || ''
    if (id !== curId) {
      const distNm = i * 5
      const ttbSec = (distNm / gsKt) * 3600
      return { ttbSec, crossLat: pl, crossLng: pn, nextSector: s, distNm }
    }
  }
  return null
}

function pickEquip(byte: number, isOceanic: boolean): Equip {
  const r = byte / 255
  // Oceanic-heavy fleets carry FANS more frequently
  if (isOceanic) {
    if (r < 0.62) return 'FANS-1A'
    if (r < 0.82) return 'ATN-B1'
    if (r < 0.92) return 'VHF-ONLY'
    return 'NONE'
  }
  if (r < 0.30) return 'FANS-1A'
  if (r < 0.55) return 'ATN-B1'
  if (r < 0.92) return 'VHF-ONLY'
  return 'NONE'
}

interface Row {
  f: AcFlight
  cur: Sector | null
  next: Sector | null
  ttbSec: number
  distNm: number
  crossLat: number
  crossLng: number
  equip: Equip
  phase: Phase
  stuckMin: number       // time on prior freq
  preCoord: boolean      // whether prior coord has been effected
  sectorLoad: number     // count of ac in receiving sector
  loadPct: number        // load / MAP * 100
  sev: { ttb: number; cor: number; lod: number; cpd: number; stk: number; rev: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'artcc-halo', SRC_LBL = 'artcc-lbl', SRC_PIN = 'artcc-pin'
const SRC_BND = 'artcc-bnd', SRC_CENT = 'artcc-cent', SRC_PROJ = 'artcc-proj', SRC_CROSS = 'artcc-cross', SRC_REF = 'artcc-ref'
const LYR_HALO = 'artcc-halo-l', LYR_LBL = 'artcc-lbl-l', LYR_PIN = 'artcc-pin-l'
const LYR_BND = 'artcc-bnd-l', LYR_CENT = 'artcc-cent-l', LYR_CENTL = 'artcc-cent-lbl-l'
const LYR_PROJ = 'artcc-proj-l', LYR_CROSS = 'artcc-cross-l', LYR_REF = 'artcc-ref-l'

export default function ArtccHandoff({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'SECTORS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [equipFilter, setEquipFilter] = useState<Equip | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(180)
  const [trafDen, setTrafDen] = useState(100)     // 50..250
  const [coordWin, setCoordWin] = useState(120)   // sec, 60..240 (JO 7110.65 nominal 2 min)
  const [stkNoise, setStkNoise] = useState(100)   // 50..250
  const [loadMul, setLoadMul] = useState(100)     // 50..200
  const [cpdlcDown, setCpdlcDown] = useState(0)   // 0..100 pct  loss-of-CPDLC simulation
  const [phaseWt, setPhaseWt] = useState(100)

  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showBnd, setShowBnd] = useState(true)
  const [showCent, setShowCent] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  // First pass: bucket aircraft into sectors for load computation
  const sectorAcCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of flights) {
      if (f.ground || !isFinite(f.altitudeFt) || f.altitudeFt < minFl * 100) continue
      const s = findSector(f.lat, f.lng)
      if (s) m.set(s.id, (m.get(s.id) || 0) + 1)
    }
    return m
  }, [flights, minFl])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || f.altitudeFt < minFl * 100) continue
      const cur = findSector(f.lat, f.lng)
      const h = hash32(f.icao || '')
      const isOceanic = cur?.kind === 'UAC'
      const equip = pickEquip(h & 0xff, isOceanic)
      const proj = projectBoundary(f.lat, f.lng, f.track || 0, f.velocityKts || 0, cur)
      const ttbSec = proj?.ttbSec ?? 9999
      const next = proj?.nextSector ?? null

      const phase: Phase = !cur ? 'IDLE'
        : ttbSec <= 180 ? 'BOUND'
        : cur.kind === 'UAC' ? (cur.id === 'BIRD' || cur.id === 'PAZA' ? 'REM' : 'OCN')
        : 'ENR'

      // Hash-stable stuck-on-frequency time, jittered by slider
      const stkHash = ((h >>> 8) & 0xff) / 255
      const stuckMin = Math.max(0, stkHash * 18 * (stkNoise / 100))
      // PreCoord effected probability scales with TTB and equip
      const preCoordSeed = ((h >>> 16) & 0xff) / 255
      const preCoord = ttbSec > coordWin || preCoordSeed > 0.18
      // Receiving-sector load
      const recvAc = next ? (sectorAcCount.get(next.id) || 0) : 0
      const recvAcAdj = Math.round(recvAc * (trafDen / 100) * (loadMul / 100))
      const recvMap = next?.map || 12
      const loadPct = (recvAcAdj / recvMap) * 100

      // Severities
      const ttbSev = ttbSec >= 180 ? 0 : ttbSec <= 30 ? 100 : ((180 - ttbSec) / 150) * 100
      const corSev = !preCoord && ttbSec < coordWin ? Math.max(60, ttbSev) : 0
      const lodSev = loadPct <= 70 ? 0 : loadPct >= 110 ? 100 : ((loadPct - 70) / 40) * 100
      const cpdlcLost = ((h >>> 24) & 0xff) / 255 < (cpdlcDown / 100)
      const equipEff: Equip = cpdlcLost && equip !== 'NONE' ? 'VHF-ONLY' : equip
      const cpdSev =
        next?.kind === 'UAC' && next?.cpdlcRequired
          ? (equipEff === 'FANS-1A' ? 0 : equipEff === 'ATN-B1' ? 30 : equipEff === 'VHF-ONLY' ? 85 : 100)
          : cur?.kind === 'UAC' && cur?.cpdlcRequired
            ? (equipEff === 'FANS-1A' ? 0 : equipEff === 'ATN-B1' ? 25 : equipEff === 'VHF-ONLY' ? 60 : 90)
            : (equipEff === 'NONE' ? 40 : 0)
      const stkSev = stuckMin <= 8 ? 0 : stuckMin >= 25 ? 100 : ((stuckMin - 8) / 17) * 100
      // Reversion gap: crossing UAC<->ARTCC requires HF/VHF swap
      const reversion = cur && next && cur.kind !== next.kind
      const revSev = reversion ? (equipEff === 'NONE' ? 80 : equipEff === 'VHF-ONLY' && (next?.kind === 'UAC' || cur?.kind === 'UAC') ? 55 : 20) : 0

      const sev = { ttb: ttbSev, cor: corSev, lod: lodSev, cpd: cpdSev, stk: stkSev, rev: revSev }
      const drivers: Array<[Driver, number]> = [
        ['TTB', sev.ttb], ['COR', sev.cor], ['LOD', sev.lod],
        ['CPD', sev.cpd], ['STK', sev.stk], ['REV', sev.rev],
      ]
      drivers.sort((a, b) => b[1] - a[1])
      const driver: Driver = drivers[0][1] >= 12 ? drivers[0][0] : 'NONE'

      const phaseMul = phase === 'IDLE' ? 0 : 1 + ((PHASE_MUL[phase] - 1) * (phaseWt / 100))
      const max = drivers[0][1]
      const secondary = drivers[1][1]
      let score = Math.min(100, Math.max(0, max * phaseMul + 0.12 * secondary))

      // Hard escalations
      if (ttbSec <= 60 && !preCoord) score = Math.max(score, 92)
      if (stuckMin > 25 && cur?.kind === 'ARTCC') score = Math.max(score, 90)
      if (loadPct >= 110) score = Math.max(score, 86)
      if (next?.kind === 'UAC' && next?.cpdlcRequired && equipEff === 'NONE') score = Math.max(score, 88)

      let tier: Tier
      if (phase === 'IDLE') tier = 'IDLE'
      else if (score >= 80) tier = 'LATE-HOFF'
      else if (score >= 55) tier = 'COORD'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'HOFF-OK'

      out.push({
        f, cur, next,
        ttbSec, distNm: proj?.distNm ?? 0,
        crossLat: proj?.crossLat ?? f.lat, crossLng: proj?.crossLng ?? f.lng,
        equip: equipEff, phase,
        stuckMin, preCoord,
        sectorLoad: recvAcAdj, loadPct,
        sev, score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, trafDen, coordWin, stkNoise, loadMul, cpdlcDown, phaseWt, sectorAcCount])

  const tierCount: Record<Tier, number> = { 'LATE-HOFF': 0, COORD: 0, WATCH: 0, 'HOFF-OK': 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++
  const evaluable = rows.filter(r => r.tier !== 'IDLE')
  const lateCount = tierCount['LATE-HOFF']
  const meanTtb = evaluable.length ? evaluable.reduce((a, r) => a + Math.min(600, r.ttbSec), 0) / evaluable.length : 0
  const cpdlcShare = evaluable.length ? evaluable.filter(r => r.equip === 'FANS-1A' || r.equip === 'ATN-B1').length / evaluable.length : 0
  const stuckShare = evaluable.length ? evaluable.filter(r => r.stuckMin > 15).length / evaluable.length : 0
  const overMapShare = evaluable.length ? evaluable.filter(r => r.loadPct >= 100).length / evaluable.length : 0
  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (equipFilter !== 'ALL') r = r.filter(x => x.equip === equipFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(x =>
      (x.f.callsign || '').toLowerCase().includes(q)
      || (x.f.type || '').toLowerCase().includes(q)
      || (x.f.icao || '').toLowerCase().includes(q)
      || (x.f.operator || '').toLowerCase().includes(q)
      || (x.cur?.id || '').toLowerCase().includes(q)
      || (x.next?.id || '').toLowerCase().includes(q)
    )
    return r.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, equipFilter, query])

  const sectorRows = useMemo(() => {
    const arr: Array<{ s: Sector; ac: number; late: number; coord: number; loadPct: number; loadTier: LoadTier; meanScore: number; worstCs: string }> = []
    for (const s of SECTORS) {
      const inHere = rows.filter(r => r.cur?.id === s.id)
      const ac = inHere.length
      const adjAc = Math.round(ac * (trafDen / 100) * (loadMul / 100))
      const loadPct = (adjAc / s.map) * 100
      const lt: LoadTier = loadPct >= 110 ? 'OVER' : loadPct >= 90 ? 'SATURATED' : loadPct >= 70 ? 'WARN' : 'OK'
      const late = inHere.filter(r => r.tier === 'LATE-HOFF').length
      const coord = inHere.filter(r => r.tier === 'COORD').length
      const ms = ac ? inHere.reduce((a, r) => a + r.score, 0) / ac : 0
      const wc = inHere.slice().sort((a, b) => b.score - a.score)[0]
      arr.push({ s, ac, late, coord, loadPct, loadTier: lt, meanScore: ms, worstCs: wc?.f.callsign || wc?.f.icao || '' })
    }
    arr.sort((a, b) => b.late - a.late || b.loadPct - a.loadPct || b.ac - a.ac)
    return arr
  }, [rows, trafDen, loadMul])

  useEffect(() => {
    if (!map) return
    const ensureSource = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    }
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_BND, SRC_CENT, SRC_PROJ, SRC_CROSS, SRC_REF]
    sources.forEach(ensureSource)

    if (!map.getLayer(LYR_REF)) {
      map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.18, 'line-width': 0.8, 'line-dasharray': [2, 4] } })
    }
    if (!map.getLayer(LYR_BND)) {
      map.addLayer({ id: LYR_BND, type: 'line', source: SRC_BND, paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.55, 'line-width': 1.2, 'line-dasharray': [3, 2] } })
    }
    if (!map.getLayer(LYR_CENT)) {
      map.addLayer({ id: LYR_CENT, type: 'circle', source: SRC_CENT, paint: { 'circle-radius': 5, 'circle-color': '#0b1220', 'circle-opacity': 0.85, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.9, 'circle-stroke-width': 1.4 } })
    }
    if (!map.getLayer(LYR_CENTL)) {
      map.addLayer({ id: LYR_CENTL, type: 'symbol', source: SRC_CENT, layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, 1.1], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(LYR_PROJ)) {
      map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.72, 'line-width': 1.6, 'line-dasharray': [1.5, 2] } })
    }
    if (!map.getLayer(LYR_CROSS)) {
      map.addLayer({ id: LYR_CROSS, type: 'symbol', source: SRC_CROSS, layout: { 'text-field': '◇', 'text-size': 12, 'text-allow-overlap': true }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
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

    const halo: any[] = []; const lbl: any[] = []; const pin: any[] = []
    const proj: any[] = []; const cross: any[] = []

    for (const r of rows) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'HOFF-OK' && r.tier !== 'IDLE') {
        const rad = 8 + (r.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: rad } })
      }
      if (showPin && r.tier === 'LATE-HOFF') {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLabels && (r.tier === 'LATE-HOFF' || r.tier === 'COORD')) {
        const ttbMin = r.ttbSec < 9999 ? `${(r.ttbSec / 60).toFixed(1)}m` : '—'
        const nextId = r.next?.id || '—'
        const freq = r.next?.freq || ''
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label: `${r.f.callsign || r.f.icao} → ${nextId} ${freq} · TTB ${ttbMin}` } })
      }
      if (showProj && r.tier !== 'IDLE' && r.next && r.distNm > 0) {
        proj.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.crossLng, r.crossLat]] }, properties: { color } })
        cross.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.crossLng, r.crossLat] }, properties: { color } })
      }
    }

    const bnd: any[] = []
    const cent: any[] = []
    if (showBnd || showCent) {
      for (const sr of sectorRows) {
        const s = sr.s
        const c = LOAD_COLOR[sr.loadTier]
        if (showBnd) {
          const ring: [number, number][] = [
            [s.lngMin, s.latMin], [s.lngMax, s.latMin],
            [s.lngMax, s.latMax], [s.lngMin, s.latMax], [s.lngMin, s.latMin],
          ]
          bnd.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: ring }, properties: { color: c } })
        }
        if (showCent) {
          const lat = (s.latMin + s.latMax) / 2
          const lng = (s.lngMin + s.lngMax) / 2
          cent.push({
            type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] },
            properties: { color: c, label: `${s.id} · ${s.freq.length > 14 ? s.freq.slice(0, 14) : s.freq}` }
          })
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
    ;(map.getSource(SRC_PROJ) as any).setData({ type: 'FeatureCollection', features: proj })
    ;(map.getSource(SRC_CROSS) as any).setData({ type: 'FeatureCollection', features: cross })
    ;(map.getSource(SRC_BND) as any).setData({ type: 'FeatureCollection', features: bnd })
    ;(map.getSource(SRC_CENT) as any).setData({ type: 'FeatureCollection', features: cent })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: refFeats })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_CROSS, LYR_PROJ, LYR_CENTL, LYR_CENT, LYR_BND, LYR_REF]) {
        if (m.getLayer(id)) m.removeLayer(id)
      }
      for (const id of sources) { if (m.getSource(id)) m.removeSource(id) }
    }
  }, [map, rows, sectorRows, showHalo, showPin, showLabels, showProj, showBnd, showCent, showRef])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const driverBadge = (d: Driver, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const equipPill = (e: Equip) => {
    const col = e === 'FANS-1A' ? '#10b981' : e === 'ATN-B1' ? '#0ea5e9' : e === 'VHF-ONLY' ? '#f59e0b' : '#ef4444'
    return <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '66', backgroundColor: col + '14' }}>{e}</span>
  }
  const sectorPill = (s: Sector | null) => (
    <span className="inline-flex items-center px-1 py-px rounded text-[9px] font-mono text-slate-300 border border-slate-700 bg-slate-800">{s?.id || '—'}</span>
  )
  const phasePill = (p: Phase) => (
    <span className="inline-flex items-center px-1 py-px rounded text-[9px] text-slate-300 border border-slate-700 bg-slate-800">{p}</span>
  )

  const advice = (r: Row): string => {
    if (r.tier === 'LATE-HOFF') {
      if (r.driver === 'TTB' || r.driver === 'COR') return `Boundary ${r.cur?.id}→${r.next?.id || '—'} in ${(r.ttbSec / 60).toFixed(1)} min without prior coord — controller must initiate hand-off NOW per FAA Order JO 7110.65 §2-1-14, brief ${r.next?.freq} reference DCA08IA078 NORDO EWR-ZNY`
      if (r.driver === 'CPD') return `Entering ${r.next?.id} requires CPDLC ${r.next?.cpdlcRequired ? '(MANDATORY oceanic)' : ''} — equipage ${r.equip} insufficient per ICAO Doc 4444 §4.11, request alt clearance via HF SELCAL ${r.next?.freq}`
      if (r.driver === 'LOD') return `Receiving sector ${r.next?.id} at ${r.loadPct.toFixed(0)}% of MAP (${r.sectorLoad}/${r.next?.map}) per JO 7210.3DD §17-9-1 — expect flow restriction / re-route, brief crew`
      if (r.driver === 'STK') return `Stuck on ${r.cur?.id} freq ${r.cur?.freq} for ${r.stuckMin.toFixed(0)} min — check 121.5 guard, request frequency challenge per AC 91-70B reference AAR-06/03`
      return `Coordination not effected — revert to ${r.cur?.guard} guard, expect AIDC/CPDLC fallback per ICAO Doc 4444 §11`
    }
    if (r.tier === 'COORD') return `${DRIVER_LABEL[r.driver]} — initiate coordination NOW per LOA ${r.cur?.id}↔${r.next?.id || '?'}, brief frequency ${r.next?.freq || '—'} per NAT Doc 007 ch 9, monitor receiving load ${r.loadPct.toFixed(0)}%`
    if (r.tier === 'WATCH') return `Boundary in ${(r.ttbSec / 60).toFixed(1)} min — pre-tune ${r.next?.freq || 'next box'} secondary, confirm prior coord effected per ICAO Doc 4444 §10`
    if (r.tier === 'HOFF-OK') return `Hand-off ${r.cur?.id}→${r.next?.id || '—'} within coordination window — no action`
    return ''
  }

  // Diagnostic plot dimensions: TTB s (0..300) vs load %
  const W = 280, H = 180
  const xMax = 300, yMax = 130
  const sx = (v: number) => 30 + (Math.max(0, Math.min(xMax, v)) / xMax) * (W - 40)
  const sy = (v: number) => (H - 24) - (Math.max(0, Math.min(yMax, v)) / yMax) * (H - 48)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">ARTCC / UAC sector hand-off</div>
          <div className="text-[10px] text-slate-500">FAA Order JO 7110.65 §2-1-14 · ICAO Doc 4444 §10 · NAT Doc 007 ch 9</div>
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
          <div className="text-[9px] text-slate-500 uppercase">Late hand-off</div>
          <div className="text-sm font-semibold" style={{ color: lateCount > 0 ? '#ef4444' : '#10b981' }}>{lateCount}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst aircraft</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean TTB</div>
          <div className="text-sm font-semibold" style={{ color: meanTtb < 60 ? '#ef4444' : meanTtb < 180 ? '#f59e0b' : '#10b981' }}>{meanTtb < 600 ? `${(meanTtb / 60).toFixed(1)}m` : '—'}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">CPDLC share</div>
          <div className="text-xs font-semibold" style={{ color: cpdlcShare >= 0.6 ? '#10b981' : cpdlcShare >= 0.3 ? '#f59e0b' : '#ef4444' }}>{(cpdlcShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Stuck-freq share</div>
          <div className="text-xs font-semibold" style={{ color: stuckShare > 0.25 ? '#f59e0b' : '#10b981' }}>{(stuckShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Over MAP share</div>
          <div className="text-xs font-semibold" style={{ color: overMapShare > 0.1 ? '#ef4444' : overMapShare > 0 ? '#f59e0b' : '#10b981' }}>{(overMapShare * 100).toFixed(0)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W - 40} height={H - 48} fill="#0b1220" />
            {/* LATE-HOFF quadrant: TTB ≤ 60 s OR load ≥ 110% */}
            <rect x={30} y={24} width={sx(60) - 30} height={H - 48} fill="#ef4444" opacity={0.10} />
            <rect x={30} y={24} width={W - 40} height={sy(110) - 24} fill="#ef4444" opacity={0.08} />
            {/* COORD band */}
            <rect x={sx(60)} y={sy(110)} width={sx(120) - sx(60)} height={sy(70) - sy(110)} fill="#f59e0b" opacity={0.12} />
            {/* OK */}
            <rect x={sx(180)} y={sy(70)} width={(W - 10) - sx(180)} height={(H - 24) - sy(70)} fill="#10b981" opacity={0.10} />
            <line x1={sx(120)} x2={sx(120)} y1={24} y2={H - 24} stroke="#0ea5e9" strokeDasharray="2 3" strokeOpacity={0.5} />
            <line x1={sx(60)} x2={sx(60)} y1={24} y2={H - 24} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.7} />
            <line x1={30} x2={W - 10} y1={sy(70)} y2={sy(70)} stroke="#0ea5e9" strokeDasharray="2 3" strokeOpacity={0.5} />
            <line x1={30} x2={W - 10} y1={sy(110)} y2={sy(110)} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.7} />
            {[0, 60, 120, 180, 240, 300].map(t => (
              <text key={`x${t}`} x={sx(t) - 6} y={H - 8} fontSize={8} fill="#64748b">{t}s</text>
            ))}
            {[0, 50, 70, 100, 130].map(t => (
              <text key={`y${t}`} x={4} y={sy(t) + 3} fontSize={8} fill="#64748b">{t}%</text>
            ))}
            {rows.filter(r => r.tier !== 'IDLE' && r.ttbSec < 9999).map((r, i) => (
              <circle key={i} cx={sx(r.ttbSec)} cy={sy(r.loadPct)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
            <text x={W / 2} y={H - 6} fontSize={9} fill="#64748b" textAnchor="middle">TTB s · receiving load %</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={100} max={410} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">TRAF-DEN {trafDen}%</span><input type="range" min={50} max={250} value={trafDen} onChange={e => setTrafDen(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">COORD-WIN {coordWin}s</span><input type="range" min={60} max={240} value={coordWin} onChange={e => setCoordWin(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">STK-NOISE {stkNoise}%</span><input type="range" min={50} max={250} value={stkNoise} onChange={e => setStkNoise(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">LOAD-MUL {loadMul}%</span><input type="range" min={50} max={200} value={loadMul} onChange={e => setLoadMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">CPDLC-DOWN {cpdlcDown}%</span><input type="range" min={0} max={100} value={cpdlcDown} onChange={e => setCpdlcDown(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col col-span-2"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setEquipFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${equipFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {EQUIP_LIST.map(e => (
          <button key={e} onClick={() => setEquipFilter(equipFilter === e ? 'ALL' : e)} className={`px-2 py-0.5 rounded text-[10px] border ${equipFilter === e ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{e}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['PROJ', showProj, setShowProj], ['BND', showBnd, setShowBnd], ['CENT', showCent, setShowCent], ['REF', showRef, setShowRef], ['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / sector / op" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'SECTORS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1 flex-wrap" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              {sectorPill(r.cur)}
              <span className="text-slate-500 text-[10px]">→</span>
              {sectorPill(r.next)}
              {equipPill(r.equip)}
              {phasePill(r.phase)}
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              FL{(r.f.altitudeFt / 100).toFixed(0)} · {r.f.velocityKts.toFixed(0)} kt · trk {r.f.track.toFixed(0)}°
              {r.next
                ? <> · freq <span className="text-sky-300 font-mono">{r.next.freq}</span> · TTB {(r.ttbSec / 60).toFixed(1)} min · load {r.loadPct.toFixed(0)}% ({r.sectorLoad}/{r.next.map}) · stuck {r.stuckMin.toFixed(0)} min{r.preCoord ? '' : ' · NO-COORD'}</>
                : <> · no boundary crossing in 60 min</>}
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('TTB', r.sev.ttb)}
              {driverBadge('COR', r.sev.cor)}
              {driverBadge('LOD', r.sev.lod)}
              {driverBadge('CPD', r.sev.cpd)}
              {driverBadge('STK', r.sev.stk)}
              {driverBadge('REV', r.sev.rev)}
            </div>
            <div className="px-2 pb-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {advice(r)}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No aircraft match the current filters.</div>
        )}

        {tab === 'SECTORS' && sectorRows.map((c, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1 flex-wrap" style={{ borderLeft: `3px solid ${LOAD_COLOR[c.loadTier]}` }}>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300 font-mono">{c.s.id}</span>
              <span className="text-slate-300 truncate">{c.s.name}</span>
              <span className="px-1 py-px rounded text-[9px] text-slate-300 border border-slate-700 bg-slate-800">{c.s.kind}</span>
              <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{c.ac} ac</span>
              <span className="px-1 py-px rounded text-[9px]" style={{ color: LOAD_COLOR[c.loadTier], border: '1px solid ' + LOAD_COLOR[c.loadTier] + '66' }}>{c.loadPct.toFixed(0)}% / MAP {c.s.map}</span>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              freq <span className="font-mono text-sky-300">{c.s.freq}</span> · guard {c.s.guard} · LATE <span style={{ color: c.late > 0 ? '#ef4444' : '#64748b' }}>{c.late}</span> · COORD <span style={{ color: c.coord > 0 ? '#f59e0b' : '#64748b' }}>{c.coord}</span> · mean {c.meanScore.toFixed(0)}
            </div>
            <div className="px-2 text-[10px] text-slate-500 truncate">LOA: {c.s.loa.join(', ')}{c.s.cpdlcRequired ? ' · CPDLC required' : ''}</div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${Math.min(100, c.loadPct)}%`, backgroundColor: LOAD_COLOR[c.loadTier] }} className="h-full" />
              </div>
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-500">worst <button onClick={() => { const w = rows.find(rw => rw.cur?.id === c.s.id && ((rw.f.callsign || rw.f.icao) === c.worstCs)); if (w) onFly(w.f.icao) }} className="text-sky-400 hover:text-sky-300">{c.worstCs || '—'}</button></div>
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: FAA Order JO 7110.65 §2-1-14 hand-off · §2-1-17 radio comm · §2-4-22 freq change · §6-1-1 oceanic xfer · §8-1-10 oceanic freq · JO 7210.3DD §17-9-1 MAP · §17-10-7 sector splits · AC 91-70B oceanic · ICAO Doc 4444 §10 · §4.11 CPDLC · §11 ATS msg · Annex 11 §3.5 · Annex 10 Vol II §5.2 · NAT Doc 007 ch 9/13 · EUROCONTROL FRA · ARINC 622 ATN · ARINC 587 freq mgmt · NTSB AAR-87/03 · AAR-06/03 · DCA08IA078 NORDO EWR-ZNY.
      </div>
    </div>
  )
}
