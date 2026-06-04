'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   DRFTDN · Engine-Out Driftdown & OEI Service-Ceiling Monitor
   ------------------------------------------------------------
   Per-airframe Engine-Out (OEI) Driftdown scorer evaluating
   whether each cruising aircraft retains adequate engine-out
   net-ceiling clearance over its current ground-track terrain
   envelope, computing the canonical driftdown trajectory from
   the current cruise FL down to the One-Engine-Inoperative
   net level-off altitude per Boeing FCOM PI-11 §11.30 / Airbus
   FCOM PRO-NOR-SOP-19 driftdown / 14 CFR §121.191 / EASA
   CAT.POL.A.215 / ICAO Doc 8168 Vol I Pt V.

   ------------------------------------------------------------
   Background — OEI net-ceiling & driftdown:

   On loss of one engine in cruise, a twin loses ≈50% installed
   thrust (a quad: ≈25%); the aircraft can no longer maintain
   the all-engine cruise FL and must descend along the driftdown
   path to its OEI net-ceiling — the level at which one-engine
   thrust equals total drag with a margin (the "net" ceiling
   has 0.1% climb-gradient margin for twins per CS-25.121(c)).

   For ETOPS twins the OEI net-ceiling MUST clear all terrain
   plus 1000 ft (1500 ft per AC 120-42B) along the diversion
   track to an adequate alternate within the approved ETOPS
   maximum diversion time — typically 60/120/180/240 min at
   OEI cruise speed (LRC OEI ≈ 0.78-0.82 M, ≈ 290 KIAS).

   ------------------------------------------------------------
   Per-class catalogue (5 categories):

     · ETOPS-LH  HVY widebody twins (B77W B788 B789 B78X
                 A359 A35K A332 A333 A339) — net-ceil ≈ FL170-200,
                 driftdown ≈ 320 KIAS, fuel-burn OEI ≈ 5500-7800
                 kg/hr, ETOPS-180 typical
     · ETOPS-N   NB twins (B737NG B738 B739 B38M B39M A320 A20N
                 A321 A21N BCS3 B752) — net-ceil ≈ FL150-180,
                 driftdown ≈ 280 KIAS, OEI fuel ≈ 2800-3600 kg/hr,
                 ETOPS-120/180
     · QUAD-LH   4-engine widebody (B748 B744 A388) — loss of
                 one ≈ -25% thrust, net-ceil ≈ FL230-260,
                 driftdown ≈ 300 KIAS, can frequently continue
                 to dest
     · RGN       Regional jets / turboprops (E190 E195 CRJ9
                 AT72 DH8D) — net-ceil ≈ FL120-150
     · BIZ       Business jets (GLEX G650 GLF6 FA8X) — net-ceil
                 ≈ FL230-280 typically

   ------------------------------------------------------------
   Physics — driftdown trajectory:

   Steady-state OEI driftdown is the locus of altitudes at which
   excess specific-power Ps_OEI = (T_OEI − D)·V / W = 0:

     Net-ceiling FL_net where T_OEI(FL,M) = D(FL,M,W)

   With drag polar D = q·S·(CD0 + k·CL²) and lift CL = W/(qS),
   thrust altitude-lapse T(h) ≈ T_SL·σ^0.7 (turbofan, per BADA
   APF model / Mattingly §8), the OEI net-ceiling for a given
   weight W solves:

     T_OEI·σ^0.7 = qS·CD0 + (k/qS)·W²    (at driftdown speed)

   The driftdown path is the ROC-positive envelope between
   current FL and net-ceiling; time-to-net ≈ (FL_cur − FL_net)
   / ROD_avg, with ROD_avg ≈ 600-900 fpm for HVY twins at
   driftdown speed per FCOM PI-11.30 driftdown chart.

   ------------------------------------------------------------
   Terrain proxy:

   Without an embedded DEM grid we use a coarse zonal terrain
   ceiling proxy:

     · NORTH-AMERICA-WEST  lat 30-50, lon -125 to -100  → MEA proxy 16000 ft (Rockies)
     · ANDES              lat -55 to 10, lon -82 to -65  → 22000 ft
     · ALPS               lat 43-48, lon 5-15            → 14000 ft
     · HIMALAYA           lat 27-40, lon 70-105          → 24000 ft
     · GREENLAND-ICELAND  lat 60-72, lon -55 to -15      → 12000 ft
     · TIBET-PAMIR        lat 35-42, lon 70-100          → 22000 ft
     · ETHIOPIA-EAST-AFR  lat 0-15, lon 30-45            → 12000 ft
     · NEW-GUINEA-PAPUA   lat -10 to 0, lon 130-150      → 14000 ft
     · NZ-SOUTHERN-ALPS   lat -46 to -42, lon 167-175    → 12000 ft
     · ROCKIES-CANADA     lat 50-65, lon -130 to -110    → 13000 ft
     · default ocean / lowland                            → 1500 ft

   Net-clearance = FL_net_ft − (terrain_proxy + 1000 ft).

   ------------------------------------------------------------
   Six drivers (max-driver composite, 0-100):

     · NETCEIL  How far the OEI net-ceiling sits ABOVE the
                terrain envelope along the next-2hr track (a
                comfortable +6000 ft clearance scores low; a
                negative clearance means the aircraft cannot
                clear terrain on one engine — flag CRITICAL)
     · WEIGHT   Aircraft gross weight estimated from class
                catalogue +/− phase amplifier (heavy early-leg
                = worse net-ceiling)
     · TERRAIN  Proxy terrain ceiling under the projected
                ground track (0-100, mountain region → high)
     · ETOPS    ETOPS area exposure: distance to nearest
                adequate alternate (0-100, oceanic / polar
                = high)
     · TIME     Time-to-driftdown from cruise FL to net-ceil
                (long descent = more terrain exposure)
     · CONF     Confidence (in cruise, well-known class, etc.)

   Composite = max·0.66 + mean·0.34 × ADV-MUL
   Hard escalators:
     · net-clearance < 0 ft (won't clear terrain)  →  score-min 92
     · net-clearance < 1000 ft AC 120-42B          →  score-min 78
     · twin in ETOPS oceanic + net-ceil < FL180    →  score-min 65

   ------------------------------------------------------------
   Six tiers (descending severity):

     · CRITICAL    ≥ 80   rose       OEI net-ceiling BELOW
                                terrain — aircraft cannot
                                clear obstacles on one engine
                                in current sector; flag dispatch
                                & re-route (AC 120-42B §10.3.7)
     · MARGINAL    ≥ 55   rose-pink  clearance < 1000 ft AC
                                120-42B; would force divert
                                rather than continue
     · TIGHT       ≥ 35   amber      clearance 1000-3000 ft —
                                acceptable but advisable to
                                step-climb sister flight
     · NOMINAL     ≥ 12   sky        clearance 3000-6000 ft
                                standard ETOPS dispatch
     · COMFORTABLE  < 12  emerald    > 6000 ft margin — full
                                redispatch options
     · NOT-CRUISE  slate            climbing / descending /
                                FL < 100, OEI not in scope

   ------------------------------------------------------------
   Side panel:
     · 6-tier counter strip · click-to-filter ALL
     · 5-cell summary  MEAN-clear / WORST-cs / CRITICAL-cnt /
       Σ-NM-at-risk / MEAN-net-FL
     · 5 sliders  MIN-FL / SCAN-NM (track scan distance) /
       MARGIN-FT (compliance margin 1000-3000) /
       WT-MUL (weight calibration) / ADV-MUL
     · 5-class chip filter ETOPS-LH / ETOPS-N / QUAD-LH /
       RGN / BIZ
     · HALO / PIN / TRK (track scan line) / LBL toggles
     · Search by callsign / type / operator / region
     · AIRCRAFT / CLASSES / DRIFTDOWN tab switcher
       · AIRCRAFT: tier-worst-first row stack
       · CLASSES:  per-class mean clearance / worst-tier
       · DRIFTDOWN: full SVG driftdown trajectory for top row

   ------------------------------------------------------------
   References:
     · Boeing 737/747/777/787 FCOM PI-11 §11.30 Driftdown
     · Boeing PEM §3.5 D6-1420 OEI cruise performance
     · Airbus A320/A330/A350 FCOM PRO-NOR-SOP-19 Driftdown
     · Airbus GTG Aircraft Performance §3.7 driftdown
     · 14 CFR §121.191 Airplane operating limitations
     · 14 CFR §25.123 §25.121 OEI climb gradients
     · 14 CFR §121.161 §121.633 ETOPS rules
     · EASA CAT.POL.A.215 Airplane gross-takeoff weight
     · EASA AMC-20-6 ETOPS
     · FAA AC 120-42B ETOPS §10 alternate planning §10.3.7
     · FAA AC 25-7D §31 high-altitude flight test
     · ICAO Annex 6 Pt I §4.2.4.4 net-flight-path
     · ICAO Doc 8168 Vol I Pt V missed-approach
     · EUROCONTROL BADA 3.15 / 4.2 OPF/APF
     · Anderson Aircraft Performance & Design §6.5
     · Roskam Airplane Design Pt VI §3 OEI performance
     · NTSB AAR-92-04 Avianca 052 fuel exhaustion JFK
     · NTSB AAR-08-03 Pinnacle 3701 OEI flameout MO
============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'CRITICAL' | 'MARGINAL' | 'TIGHT' | 'NOMINAL' | 'COMFORTABLE' | 'NOT-CRUISE'
const TIER_COLOR: Record<Tier, string> = {
  CRITICAL:'#ef4444', MARGINAL:'#f43f5e', TIGHT:'#f59e0b',
  NOMINAL:'#0ea5e9', COMFORTABLE:'#10b981', 'NOT-CRUISE':'#475569',
}
const TIER_RANK: Record<Tier, number> = { CRITICAL:0, MARGINAL:1, TIGHT:2, NOMINAL:3, COMFORTABLE:4, 'NOT-CRUISE':5 }

type Klass = 'ETOPS-LH' | 'ETOPS-N' | 'QUAD-LH' | 'RGN' | 'BIZ'
const KLASS_COLOR: Record<Klass, string> = {
  'ETOPS-LH':'#a855f7', 'ETOPS-N':'#10b981',
  'QUAD-LH':'#8b5cf6', RGN:'#f59e0b', BIZ:'#ec4899',
}
const KLASS_LIST: Klass[] = ['ETOPS-LH','ETOPS-N','QUAD-LH','RGN','BIZ']

interface KSpec {
  netCeilFL_clean: number   /* FL at typical mid-leg weight */
  netCeilFL_heavy: number   /* FL at near-MTOW early-leg */
  driftKIAS: number         /* driftdown calibrated airspeed */
  rodAvg: number            /* avg rate-of-descent driftdown fpm */
  oeiFFKgHr: number         /* OEI cruise fuel-flow kg/hr */
  etopsCap: number          /* nominal ETOPS approval minutes */
  engines: number
  label: string
}
const KLASS_SPEC: Record<Klass, KSpec> = {
  'ETOPS-LH': { netCeilFL_clean:185, netCeilFL_heavy:155, driftKIAS:320, rodAvg:750, oeiFFKgHr:6800, etopsCap:180, engines:2, label:'ETOPS HVY twin' },
  'ETOPS-N':  { netCeilFL_clean:170, netCeilFL_heavy:145, driftKIAS:280, rodAvg:680, oeiFFKgHr:3200, etopsCap:180, engines:2, label:'ETOPS NB twin' },
  'QUAD-LH':  { netCeilFL_clean:245, netCeilFL_heavy:215, driftKIAS:300, rodAvg:520, oeiFFKgHr:8200, etopsCap:240, engines:4, label:'Quad-engine widebody' },
  RGN:        { netCeilFL_clean:135, netCeilFL_heavy:115, driftKIAS:250, rodAvg:620, oeiFFKgHr:1450, etopsCap:75,  engines:2, label:'Regional jet/turboprop' },
  BIZ:        { netCeilFL_clean:265, netCeilFL_heavy:235, driftKIAS:260, rodAvg:560, oeiFFKgHr:1100, etopsCap:120, engines:2, label:'Business jet' },
}

function classifyType(t?: string): Klass {
  if (!t) return 'ETOPS-N'
  const T = t.toUpperCase()
  if (/^(B74|A38)/.test(T)) return 'QUAD-LH'
  if (/^(B77|B78|A35|A33[023]|A34)/.test(T)) return 'ETOPS-LH'
  if (/^(B73|B75|A31|A32|BCS|MD8|MD9|B71|B76)/.test(T)) return 'ETOPS-N'
  if (/^(E17|E19|E29|CRJ|RJ8|EM7|AT[47]|DH8|ATR|SF34|J32|J41)/.test(T)) return 'RGN'
  if (/^(GLEX|GLF|GL5|G65|FA[5-9]|FA2|CL6|CL3|C25|C56|C68|E55|E50|BE40)/.test(T)) return 'BIZ'
  return 'ETOPS-N'
}

function clamp(x:number,a:number,b:number){return Math.max(a,Math.min(b,x))}

/* ----- Terrain zone proxy ----- */
interface TerrZone { name: string; min: number; latMin:number; latMax:number; lonMin:number; lonMax:number }
const TERRAIN_ZONES: TerrZone[] = [
  { name:'Himalaya',         min:24000, latMin:27, latMax:40, lonMin:70,  lonMax:105 },
  { name:'Tibet/Pamir',      min:22000, latMin:35, latMax:42, lonMin:70,  lonMax:100 },
  { name:'Andes',            min:22000, latMin:-55,latMax:10, lonMin:-82, lonMax:-65 },
  { name:'NA-Rockies',       min:16000, latMin:30, latMax:50, lonMin:-125,lonMax:-100 },
  { name:'Rockies-Canada',   min:13000, latMin:50, latMax:65, lonMin:-130,lonMax:-110 },
  { name:'Alps',             min:14000, latMin:43, latMax:48, lonMin:5,   lonMax:15 },
  { name:'Greenland-Iceland',min:12000, latMin:60, latMax:72, lonMin:-55, lonMax:-15 },
  { name:'Ethiopia-EastAfr', min:12000, latMin:0,  latMax:15, lonMin:30,  lonMax:45 },
  { name:'New-Guinea',       min:14000, latMin:-10,latMax:0,  lonMin:130, lonMax:150 },
  { name:'NZ-Southern-Alps', min:12000, latMin:-46,latMax:-42,lonMin:167, lonMax:175 },
  { name:'Caucasus',         min:14000, latMin:40, latMax:45, lonMin:40,  lonMax:50 },
  { name:'Iran-Zagros',      min:12000, latMin:30, latMax:38, lonMin:45,  lonMax:60 },
]
function terrainProxy(lat: number, lng: number): { ft: number; name: string } {
  for (const z of TERRAIN_ZONES) {
    if (lat >= z.latMin && lat <= z.latMax && lng >= z.lonMin && lng <= z.lonMax) return { ft: z.min, name: z.name }
  }
  return { ft: 1500, name: 'lowland/ocean' }
}

/* Scan terrain along ground track over N NM */
function scanTerrainAlongTrack(lat: number, lng: number, trk: number, nm: number, steps = 8): { worstFt: number; worstName: string; worstLat:number; worstLng:number } {
  const rad = (trk - 0) * Math.PI / 180  /* bearing from north */
  /* approx: 1° lat ~ 60 NM; 1° lng ~ 60·cos(lat) NM */
  let worstFt = 0, worstName = 'lowland/ocean', worstLat = lat, worstLng = lng
  for (let i = 1; i <= steps; i++) {
    const d = (nm * i) / steps
    const dLat = (d * Math.cos(rad)) / 60
    const dLng = (d * Math.sin(rad)) / (60 * Math.max(0.2, Math.cos(lat * Math.PI / 180)))
    const la = lat + dLat
    const lo = lng + dLng
    const t = terrainProxy(la, lo)
    if (t.ft > worstFt) { worstFt = t.ft; worstName = t.name; worstLat = la; worstLng = lo }
  }
  /* compare against current position too */
  const t0 = terrainProxy(lat, lng)
  if (t0.ft > worstFt) { worstFt = t0.ft; worstName = t0.name; worstLat = lat; worstLng = lng }
  return { worstFt, worstName, worstLat, worstLng }
}

/* Oceanic / sparse-alternate exposure proxy */
function etopsExposure(lat: number, lng: number): number {
  /* central pacific / south indian / polar = high */
  if (Math.abs(lat) > 65) return 90
  /* mid-Pacific */
  if (lat > -10 && lat < 30 && (lng > 160 || lng < -130)) return 80
  /* south Atlantic */
  if (lat > -50 && lat < -10 && lng > -30 && lng < 10) return 65
  /* south Indian */
  if (lat > -50 && lat < -20 && lng > 60 && lng < 110) return 60
  /* NAT busy band — alternates exist but oceanic */
  if (lat > 40 && lat < 60 && lng > -50 && lng < -10) return 40
  /* continental */
  return 8
}

/* Weight phase amplifier: deterministic per icao24 hash */
function weightPhase(icao: string, FL: number): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < icao.length; i++) { h ^= icao.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  const r = (h % 1000) / 1000   /* 0..1 fractional position in leg */
  /* heavier early in leg, lighter late; FL clue: low FL probably climbing-late or descending-early */
  const phase = clamp(0.2 + r * 0.8, 0.2, 1.0)
  /* lighten if very high cruise (likely late-leg step-climb) */
  const flAdj = FL > 380 ? -0.15 : FL > 360 ? -0.05 : 0
  return clamp(phase + flAdj, 0.1, 1.05)
}

interface DriftCheck {
  netCeilFt: number
  terrainFt: number
  terrainName: string
  scanLat: number
  scanLng: number
  clearanceFt: number       /* netCeilFt - (terrainFt + margin) */
  driftTimeMin: number      /* time to descend from cur FL to net-ceil */
  driftFuelKg: number       /* OEI fuel burned during drift */
  weightFrac: number        /* phase amplifier 0..1 */
  isOceanic: boolean
  etopsExp: number
}
function checkDriftdown(f: SFlight, scanNm: number, marginFt: number): DriftCheck {
  const kl = classifyType(f.type)
  const sp = KLASS_SPEC[kl]
  const wf = weightPhase(f.icao, f.altitudeFt / 100)
  /* linear interp between heavy & clean net-ceil based on weight phase */
  const netCeilFL = sp.netCeilFL_heavy + (1 - wf) * (sp.netCeilFL_clean - sp.netCeilFL_heavy)
  const netCeilFt = netCeilFL * 100
  const ter = scanTerrainAlongTrack(f.lat, f.lng, f.track, scanNm)
  const clearance = netCeilFt - (ter.worstFt + marginFt)
  const dropFt = Math.max(0, f.altitudeFt - netCeilFt)
  const driftMin = sp.rodAvg > 0 ? dropFt / sp.rodAvg : 0
  const driftFuel = sp.oeiFFKgHr * (driftMin / 60)
  const exp = etopsExposure(f.lat, f.lng)
  const oceanic = exp >= 50
  return {
    netCeilFt, terrainFt: ter.worstFt, terrainName: ter.worstName,
    scanLat: ter.worstLat, scanLng: ter.worstLng,
    clearanceFt: clearance, driftTimeMin: driftMin, driftFuelKg: driftFuel,
    weightFrac: wf, isOceanic: oceanic, etopsExp: exp,
  }
}

interface Drivers { NETCEIL:number; WEIGHT:number; TERRAIN:number; ETOPS:number; TIME:number; CONF:number }
interface Row { f: SFlight; kl: Klass; sp: KSpec; chk: DriftCheck; drivers: Drivers; score: number; tier: Tier }

function scoreRow(f: SFlight, chk: DriftCheck, kl: Klass, advMul: number): { drivers: Drivers; score: number } {
  /* NETCEIL: clearance ramp. 0 ft = 90, -1000=100, +6000=0 */
  const c = chk.clearanceFt
  const NETCEIL = c < 0 ? clamp(90 + (-c / 1000) * 10, 90, 100)
                : clamp(90 - (c / 6000) * 90, 0, 90)
  /* WEIGHT: heavier = worse */
  const WEIGHT = clamp(chk.weightFrac * 100, 0, 100)
  /* TERRAIN driver */
  const TERRAIN = clamp((chk.terrainFt / 24000) * 100, 0, 100)
  /* ETOPS */
  const ETOPS = chk.etopsExp
  /* TIME — drift duration, more = more terrain exposure */
  const TIME = clamp((chk.driftTimeMin / 25) * 100, 0, 100)
  const CONF = clamp(50 + (f.altitudeFt > 28000 ? 30 : 10) + (kl === 'ETOPS-LH' ? 10 : 0), 20, 95)

  const triad = [NETCEIL, TERRAIN, ETOPS * 0.6]
  const maxD = Math.max(...triad, WEIGHT * 0.4)
  const meanD = (NETCEIL + TERRAIN + ETOPS + WEIGHT + TIME) / 5
  let composite = maxD * 0.66 + meanD * 0.34
  composite *= (advMul / 100)
  /* hard escalators */
  if (chk.clearanceFt < 0) composite = Math.max(composite, 92)
  if (chk.clearanceFt < 1000 && chk.clearanceFt >= 0) composite = Math.max(composite, 78)
  if ((kl === 'ETOPS-LH' || kl === 'ETOPS-N') && chk.isOceanic && chk.netCeilFt < 18000) composite = Math.max(composite, 65)
  return { drivers:{ NETCEIL, WEIGHT, TERRAIN, ETOPS, TIME, CONF }, score: clamp(composite, 0, 100) }
}

function classifyTier(score: number, f: SFlight): Tier {
  if (f.altitudeFt < 10000) return 'NOT-CRUISE'
  if (Math.abs(f.vertRate || 0) > 1200) return 'NOT-CRUISE'
  if (score >= 80) return 'CRITICAL'
  if (score >= 55) return 'MARGINAL'
  if (score >= 35) return 'TIGHT'
  if (score >= 12) return 'NOMINAL'
  return 'COMFORTABLE'
}

export default function DrftdnDriftdown({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState(100)
  const [scanNm, setScanNm] = useState(220)
  const [marginFt, setMarginFt] = useState(1000)
  const [wtMul, setWtMul] = useState(100)
  const [advMul, setAdvMul] = useState(100)
  const [klFilter, setKlFilter] = useState<Record<Klass, boolean>>({ 'ETOPS-LH':true, 'ETOPS-N':true, 'QUAD-LH':true, RGN:true, BIZ:true })
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showTrk, setShowTrk] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'DRIFTDOWN'>('AIRCRAFT')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const FL = f.altitudeFt / 100
      if (FL < minFL) continue
      const kl = classifyType(f.type)
      const sp = KLASS_SPEC[kl]
      let chk = checkDriftdown(f, scanNm, marginFt)
      /* WT-MUL calibration */
      if (wtMul !== 100) {
        const m = wtMul / 100
        const adjFL = sp.netCeilFL_heavy + ((1 - chk.weightFrac * m) * (sp.netCeilFL_clean - sp.netCeilFL_heavy))
        chk = { ...chk, netCeilFt: adjFL * 100,
          clearanceFt: adjFL * 100 - (chk.terrainFt + marginFt) }
      }
      const { drivers, score } = scoreRow(f, chk, kl, advMul)
      const tier = classifyTier(score, f)
      out.push({ f, kl, sp, chk, drivers, score, tier })
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, minFL, scanNm, marginFt, wtMul, advMul])

  const filtered = useMemo(() => rows.filter(r => {
    if (!klFilter[r.kl]) return false
    if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
    if (q) {
      const t = q.toLowerCase()
      const hay = `${r.f.callsign||''} ${r.f.icao} ${r.f.type||''} ${r.f.operator||''} ${r.kl} ${r.tier} ${r.chk.terrainName}`.toLowerCase()
      if (!hay.includes(t)) return false
    }
    return true
  }), [rows, klFilter, tierFilter, q])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { CRITICAL:0, MARGINAL:0, TIGHT:0, NOMINAL:0, COMFORTABLE:0, 'NOT-CRUISE':0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const meanClear = rows.length ? rows.reduce((a,b)=>a+b.chk.clearanceFt,0)/rows.length : 0
  const critCnt = tierCounts.CRITICAL
  const worst = rows[0]
  const sigNm = rows.filter(r => r.tier === 'CRITICAL' || r.tier === 'MARGINAL').reduce((a,b)=>a+(b.f.velocityKts*0.4),0)
  const meanNetFL = rows.length ? rows.reduce((a,b)=>a+b.chk.netCeilFt/100,0)/rows.length : 0

  /* ----- MapLibre overlay ----- */
  useEffect(() => {
    if (!map) return
    const SRC = 'drftdn-ac-src'
    const TRK = 'drftdn-trk-src'
    const HALO = 'drftdn-halo'
    const PIN = 'drftdn-pin'
    const LBL = 'drftdn-lbl'
    const TRKL = 'drftdn-trk-line'

    const acFC = { type:'FeatureCollection' as const, features: rows.map(r => ({
      type:'Feature' as const,
      geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat] },
      properties:{
        cs: r.f.callsign || r.f.icao,
        net: `net FL${Math.round(r.chk.netCeilFt/100)}`,
        clear: `${r.chk.clearanceFt>=0?'+':''}${(r.chk.clearanceFt/1000).toFixed(1)}k`,
        terr: r.chk.terrainName,
        tier: r.tier,
        color: TIER_COLOR[r.tier],
        haloR: r.tier === 'CRITICAL' ? 19 : r.tier === 'MARGINAL' ? 16 : r.tier === 'TIGHT' ? 12 : r.tier === 'NOMINAL' ? 8 : r.tier === 'COMFORTABLE' ? 7 : 5,
        pinScale: (r.tier === 'CRITICAL' || r.tier === 'MARGINAL') ? 1 : 0,
      },
    })) }
    /* Track scan lines for top-12 worst */
    const trkFC = { type:'FeatureCollection' as const, features: rows.filter(r=>r.tier==='CRITICAL'||r.tier==='MARGINAL'||r.tier==='TIGHT').slice(0,12).map(r => ({
      type:'Feature' as const,
      geometry:{ type:'LineString' as const, coordinates:[[r.f.lng, r.f.lat], [r.chk.scanLng, r.chk.scanLat]] },
      properties:{ color: TIER_COLOR[r.tier] },
    })) }

    const add = () => {
      try {
        if (!map.getSource(SRC)) map.addSource(SRC, { type:'geojson', data: acFC as any })
        else (map.getSource(SRC) as any).setData(acFC)
        if (!map.getSource(TRK)) map.addSource(TRK, { type:'geojson', data: trkFC as any })
        else (map.getSource(TRK) as any).setData(trkFC)

        if (showTrk && !map.getLayer(TRKL)) map.addLayer({ id: TRKL, type:'line', source: TRK, paint:{
          'line-color':['get','color'], 'line-width':1.5, 'line-opacity':0.7, 'line-dasharray':[2,2],
        }})
        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id: HALO, type:'circle', source: SRC, paint:{
          'circle-radius':['get','haloR'], 'circle-color':['get','color'],
          'circle-opacity':0.14, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85,
        }})
        if (showPin && !map.getLayer(PIN)) map.addLayer({ id: PIN, type:'circle', source: SRC, filter:['>',['get','pinScale'],0], paint:{
          'circle-radius':['*', 5.5, ['get','pinScale']],
          'circle-color':['get','color'], 'circle-stroke-color':'#fff', 'circle-stroke-width':1.3,
        }})
        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id: LBL, type:'symbol', source: SRC, layout:{
          'text-field':['concat',['get','cs'],'  ',['get','net'],'  ',['get','clear']],
          'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top',
          'text-font':['Open Sans Semibold','Arial Unicode MS Bold'],
        }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0b1220', 'text-halo-width':1.2 }})
      } catch {}
    }
    if (map.isStyleLoaded()) add(); else map.once('load', add)
    return () => {
      try {
        for (const l of [LBL, PIN, HALO, TRKL]) if (map.getLayer(l)) map.removeLayer(l)
        for (const s of [SRC, TRK]) if (map.getSource(s)) map.removeSource(s)
      } catch {}
    }
  }, [map, rows, showHalo, showPin, showLbl, showTrk])

  /* Classes aggregation */
  const klRows = useMemo(() => {
    const agg: Record<Klass, { count:number; meanClear:number; meanNetFL:number; crit:number; marg:number; worstCs:string; worstScore:number }> = {
      'ETOPS-LH':{count:0,meanClear:0,meanNetFL:0,crit:0,marg:0,worstCs:'',worstScore:0},
      'ETOPS-N':{count:0,meanClear:0,meanNetFL:0,crit:0,marg:0,worstCs:'',worstScore:0},
      'QUAD-LH':{count:0,meanClear:0,meanNetFL:0,crit:0,marg:0,worstCs:'',worstScore:0},
      RGN:{count:0,meanClear:0,meanNetFL:0,crit:0,marg:0,worstCs:'',worstScore:0},
      BIZ:{count:0,meanClear:0,meanNetFL:0,crit:0,marg:0,worstCs:'',worstScore:0},
    }
    for (const r of rows) {
      const a = agg[r.kl]; a.count++; a.meanClear += r.chk.clearanceFt; a.meanNetFL += r.chk.netCeilFt/100
      if (r.tier === 'CRITICAL') a.crit++
      if (r.tier === 'MARGINAL') a.marg++
      if (r.score > a.worstScore) { a.worstScore = r.score; a.worstCs = r.f.callsign || r.f.icao }
    }
    for (const k of KLASS_LIST) { if (agg[k].count) { agg[k].meanClear /= agg[k].count; agg[k].meanNetFL /= agg[k].count } }
    return agg
  }, [rows])

  const topRow = filtered[0]

  return (
    <div className="absolute right-3 top-20 z-30 w-[480px] max-h-[80vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">DRFTDN</div>
        <div className="text-[10px] text-slate-400 truncate">OEI driftdown · net-ceiling vs terrain · ETOPS</div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
        </div>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {(['CRITICAL','MARGINAL','TIGHT','NOMINAL','COMFORTABLE','NOT-CRUISE'] as Tier[]).map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[8px]" style={{color: TIER_COLOR[t]}}>{t==='NOT-CRUISE'?'N-CRZ':t==='COMFORTABLE'?'COMF':t}</div>
            <div className="text-slate-100 font-semibold">{tierCounts[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">MEAN-CLR</div>
          <div className="text-slate-100 font-semibold tabular-nums">{(meanClear/1000).toFixed(1)}k</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">CRITICAL</div>
          <div className="font-semibold tabular-nums" style={{color: critCnt ? TIER_COLOR.CRITICAL : '#cbd5e1'}}>{critCnt}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">WORST</div>
          <div className="text-slate-100 font-semibold truncate text-[10px]">{worst ? worst.f.callsign || worst.f.icao : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">Σ-NM-RISK</div>
          <div className="text-slate-100 font-semibold tabular-nums">{sigNm.toFixed(0)}</div>
        </div>
        <div className="px-2 py-1 rounded bg-slate-900/60 border border-slate-800">
          <div className="text-[9px] text-slate-500">MEAN-NET</div>
          <div className="text-slate-100 font-semibold tabular-nums">FL{meanNetFL.toFixed(0)}</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800/60 text-[10px]">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {([
            ['MIN-FL', minFL, setMinFL, 50, 350, '', 10],
            ['SCAN-NM', scanNm, setScanNm, 60, 600, '', 20],
            ['MARGIN', marginFt, setMarginFt, 500, 3000, 'ft', 100],
            ['WT-MUL', wtMul, setWtMul, 60, 130, '%', 1],
            ['ADV-MUL', advMul, setAdvMul, 50, 200, '%', 1],
          ] as Array<[string, number, (n:number)=>void, number, number, string, number]>).map(([lbl,val,set,lo,hi,suf,step]) => (
            <label key={lbl} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-16">{lbl}</span>
              <input type="range" min={lo} max={hi} step={step} value={val}
                onChange={e => set(parseFloat(e.target.value))}
                className="flex-1 h-1 accent-sky-500" />
              <span className="text-slate-300 tabular-nums w-12 text-right">{val}{suf}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800/60">
        {KLASS_LIST.map(k => (
          <button key={k} onClick={() => setKlFilter(p => ({...p, [k]: !p[k]}))}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${klFilter[k]?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700 opacity-50'}`}
            style={{color: KLASS_COLOR[k]}}>{k}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800/60 text-[9px]">
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['TRK',showTrk,setShowTrk],['LBL',showLbl,setShowLbl]] as const).map(([n,v,s])=>(
          <button key={n} onClick={()=>(s as any)(!v)} className={`px-1.5 py-0.5 rounded border ${v?'bg-sky-500/15 border-sky-500/40 text-slate-100':'border-slate-800 text-slate-500 hover:border-slate-700'}`}>{n}</button>
        ))}
      </div>

      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / type / operator / region"
          className="flex-1 bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/40" />
      </div>
      <div className="flex gap-0.5 px-3 py-1.5 border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','CLASSES','DRIFTDOWN'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 text-slate-100 border border-sky-500/40':'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1 text-[11px]">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500">no airborne aircraft in driftdown scope</div>}
            {filtered.slice(0, 60).map(r => {
              const advice =
                r.tier === 'CRITICAL' ? `OEI net-ceil BELOW terrain (${r.chk.terrainName}) — cannot clear obstacles on one engine; re-route or step-down before exposure (AC 120-42B §10.3.7)` :
                r.tier === 'MARGINAL' ? `clearance <1000ft AC 120-42B floor over ${r.chk.terrainName} — divert preferable to continue OEI` :
                r.tier === 'TIGHT' ? `clearance ${(r.chk.clearanceFt/1000).toFixed(1)}k ft over ${r.chk.terrainName} — acceptable, advise step-climb if available (FCOM PI-11.30)` :
                r.tier === 'NOMINAL' ? `clearance ${(r.chk.clearanceFt/1000).toFixed(1)}k ft over ${r.chk.terrainName} — standard ETOPS dispatch` :
                r.tier === 'NOT-CRUISE' ? `climbing/descending or below FL100 — driftdown not in scope` :
                `+${(r.chk.clearanceFt/1000).toFixed(1)}k ft margin over ${r.chk.terrainName} — full redispatch options`
              return (
                <button key={r.f.icao} onClick={()=>onFly(r.f.icao)} className="w-full text-left px-3 py-2 hover:bg-slate-900/60 transition">
                  <div className="flex items-center gap-2 mb-1" style={{borderLeft:`3px solid ${TIER_COLOR[r.tier]}`, paddingLeft:8}}>
                    <span className="font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                    <span className="text-[9px] text-slate-500">{r.f.type || '—'}</span>
                    <span className="text-[9px] px-1 rounded" style={{background:`${KLASS_COLOR[r.kl]}22`, color: KLASS_COLOR[r.kl]}}>{r.kl}</span>
                    <span className="text-[9px] text-slate-500">{r.sp.engines}×eng</span>
                    <span className="text-[9px] px-1 rounded ml-auto" style={{background:`${TIER_COLOR[r.tier]}22`, color: TIER_COLOR[r.tier]}}>{r.tier}</span>
                    <span className="text-[9px] text-slate-500 tabular-nums">{r.score.toFixed(0)}</span>
                  </div>
                  <div className="grid grid-cols-5 gap-1 text-[10px] mb-1 pl-2">
                    <div><span className="text-slate-500">FL </span><span className="text-slate-200 tabular-nums">{Math.round(r.f.altitudeFt/100)}</span></div>
                    <div><span className="text-slate-500">→net </span><span className="tabular-nums text-sky-300">FL{Math.round(r.chk.netCeilFt/100)}</span></div>
                    <div><span className="text-slate-500">terr </span><span className="tabular-nums" style={{color: r.chk.terrainFt>=14000?TIER_COLOR.MARGINAL:'#cbd5e1'}}>{(r.chk.terrainFt/1000).toFixed(0)}k</span></div>
                    <div><span className="text-slate-500">clr </span><span className="tabular-nums" style={{color: r.chk.clearanceFt<0?TIER_COLOR.CRITICAL:r.chk.clearanceFt<1000?TIER_COLOR.MARGINAL:r.chk.clearanceFt<3000?TIER_COLOR.TIGHT:'#10b981'}}>{r.chk.clearanceFt>=0?'+':''}{(r.chk.clearanceFt/1000).toFixed(1)}k</span></div>
                    <div><span className="text-slate-500">Δt </span><span className="text-slate-200 tabular-nums">{r.chk.driftTimeMin.toFixed(0)}m</span></div>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[9.5px] mb-1 pl-2">
                    <div className="px-1.5 py-0.5 rounded border border-slate-800 bg-slate-900/40"><span className="text-slate-500">REGION </span><span className="text-slate-300 truncate">{r.chk.terrainName}</span></div>
                    <div className="px-1.5 py-0.5 rounded border border-slate-800 bg-slate-900/40"><span className="text-slate-500">DD-FUEL </span><span className="text-slate-300 tabular-nums">{r.chk.driftFuelKg.toFixed(0)}kg</span></div>
                    <div className="px-1.5 py-0.5 rounded border border-slate-800 bg-slate-900/40"><span className="text-slate-500">ETOPS </span><span className="tabular-nums" style={{color: r.chk.isOceanic?TIER_COLOR.TIGHT:'#94a3b8'}}>{r.chk.etopsExp.toFixed(0)}</span></div>
                  </div>
                  <div className="pl-2">
                    <div className="h-1 rounded bg-slate-900 overflow-hidden">
                      <div style={{width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%'}}/>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1 pl-2 mt-1.5 text-[8.5px]">
                    {(['NETCEIL','TERRAIN','ETOPS','WEIGHT','TIME'] as const).map(d => {
                      const val = (r.drivers as any)[d] as number
                      return (
                        <span key={d} className="px-1 py-0.5 rounded border border-slate-700 text-slate-300">
                          {d} <span className="tabular-nums" style={{color: val>=70?TIER_COLOR.MARGINAL:val>=40?TIER_COLOR.TIGHT:'#94a3b8'}}>{val.toFixed(0)}</span>
                        </span>
                      )
                    })}
                  </div>
                  <div className="text-[9.5px] mt-1 pl-2 italic" style={{color: TIER_COLOR[r.tier]}}>{advice}</div>
                </button>
              )
            })}
          </div>
        )}

        {tab === 'CLASSES' && (
          <div className="divide-y divide-slate-800/60">
            {KLASS_LIST.map(k => {
              const a = klRows[k]
              const sp = KLASS_SPEC[k]
              if (!a.count) return (
                <div key={k} className="px-3 py-2 opacity-40">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] px-1 rounded" style={{background:`${KLASS_COLOR[k]}22`, color: KLASS_COLOR[k]}}>{k}</span>
                    <span className="text-[10px] text-slate-500">{sp.label}</span>
                    <span className="ml-auto text-[10px] text-slate-600">no aircraft</span>
                  </div>
                </div>
              )
              return (
                <div key={k} className="px-3 py-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] px-1 rounded" style={{background:`${KLASS_COLOR[k]}22`, color: KLASS_COLOR[k]}}>{k}</span>
                    <span className="text-[10px] text-slate-400">{sp.label}</span>
                    <span className="text-[10px] text-slate-500 ml-auto tabular-nums">{a.count} a/c</span>
                  </div>
                  <div className="grid grid-cols-5 gap-1 text-[9.5px] mb-1">
                    <div><span className="text-slate-500">net-clean </span><span className="text-slate-200 tabular-nums">FL{sp.netCeilFL_clean}</span></div>
                    <div><span className="text-slate-500">net-heavy </span><span className="text-slate-200 tabular-nums">FL{sp.netCeilFL_heavy}</span></div>
                    <div><span className="text-slate-500">drift-IAS </span><span className="text-slate-200 tabular-nums">{sp.driftKIAS}kt</span></div>
                    <div><span className="text-slate-500">ROD </span><span className="text-slate-200 tabular-nums">{sp.rodAvg}fpm</span></div>
                    <div><span className="text-slate-500">ETOPS </span><span className="text-slate-200 tabular-nums">{sp.etopsCap}min</span></div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 text-[9.5px] mb-1">
                    <div className="px-1.5 py-0.5 rounded border border-slate-800 bg-slate-900/40"><span className="text-slate-500">MEAN-CLR </span><span className="tabular-nums" style={{color: a.meanClear<0?TIER_COLOR.CRITICAL:a.meanClear<1000?TIER_COLOR.MARGINAL:'#cbd5e1'}}>{(a.meanClear/1000).toFixed(1)}k</span></div>
                    <div className="px-1.5 py-0.5 rounded border border-slate-800 bg-slate-900/40"><span className="text-slate-500">MEAN-NET </span><span className="tabular-nums text-slate-300">FL{a.meanNetFL.toFixed(0)}</span></div>
                    <div className="px-1.5 py-0.5 rounded border border-slate-800 bg-slate-900/40"><span className="text-slate-500">CRIT </span><span className="tabular-nums" style={{color: a.crit?TIER_COLOR.CRITICAL:'#cbd5e1'}}>{a.crit}</span></div>
                    <div className="px-1.5 py-0.5 rounded border border-slate-800 bg-slate-900/40"><span className="text-slate-500">MARG </span><span className="tabular-nums" style={{color: a.marg?TIER_COLOR.MARGINAL:'#cbd5e1'}}>{a.marg}</span></div>
                  </div>
                  <div className="h-1 rounded bg-slate-900 overflow-hidden">
                    <div style={{width:`${Math.min(100, Math.max(0, a.worstScore))}%`, background:KLASS_COLOR[k], height:'100%'}}/>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'DRIFTDOWN' && (
          <div className="px-3 py-3">
            {!topRow && <div className="text-[10px] text-slate-500">no aircraft selected — pick one in the AIRCRAFT tab</div>}
            {topRow && (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm font-semibold text-slate-100">{topRow.f.callsign || topRow.f.icao}</span>
                  <span className="text-[10px] text-slate-500">{topRow.f.type}</span>
                  <span className="text-[10px] px-1 rounded" style={{background:`${KLASS_COLOR[topRow.kl]}22`, color: KLASS_COLOR[topRow.kl]}}>{topRow.kl}</span>
                  <span className="text-[10px] px-1 rounded ml-auto" style={{background:`${TIER_COLOR[topRow.tier]}22`, color: TIER_COLOR[topRow.tier]}}>{topRow.tier}</span>
                </div>
                <div className="text-[10px] text-slate-400 mb-2">Driftdown profile · time-vs-altitude · OEI from cruise FL{Math.round(topRow.f.altitudeFt/100)} → net-ceil FL{Math.round(topRow.chk.netCeilFt/100)} · terrain {topRow.chk.terrainName} {(topRow.chk.terrainFt/1000).toFixed(0)}k ft</div>
                {(() => {
                  const W = 440, H = 240, padL = 36, padR = 12, padT = 12, padB = 28
                  const flTop = Math.max(topRow.f.altitudeFt/100, 410) + 10
                  const flBot = 0
                  const t0 = 0
                  const tMax = Math.max(30, topRow.chk.driftTimeMin + 5)
                  const xT = (t: number) => padL + (t / tMax) * (W - padL - padR)
                  const yA = (fl: number) => padT + (1 - (fl - flBot) / (flTop - flBot)) * (H - padT - padB)
                  /* driftdown locus: linear ROD avg, then level at net-ceil */
                  const startY = yA(topRow.f.altitudeFt/100)
                  const netY = yA(topRow.chk.netCeilFt/100)
                  const dropX = xT(topRow.chk.driftTimeMin)
                  const endX = xT(tMax)
                  const terrY = yA(topRow.chk.terrainFt/100)
                  const marginY = yA((topRow.chk.terrainFt + marginFt)/100)
                  return (
                    <svg viewBox={`0 0 ${W} ${H}`} className="w-full bg-slate-950 rounded border border-slate-800">
                      {/* grid */}
                      {[0,50,100,150,200,250,300,350,400].map(fl => (
                        <g key={fl}>
                          <line x1={padL} y1={yA(fl)} x2={W-padR} y2={yA(fl)} stroke="#1e293b" strokeWidth={0.5}/>
                          <text x={padL-4} y={yA(fl)+3} textAnchor="end" fill="#64748b" fontSize={8}>FL{fl}</text>
                        </g>
                      ))}
                      {[0,5,10,15,20,25,30].map(t => (
                        <g key={t}>
                          <line x1={xT(t)} y1={padT} x2={xT(t)} y2={H-padB} stroke="#1e293b" strokeWidth={0.5}/>
                          <text x={xT(t)} y={H-padB+12} textAnchor="middle" fill="#64748b" fontSize={8}>{t}m</text>
                        </g>
                      ))}
                      {/* terrain band */}
                      <rect x={padL} y={terrY} width={W-padL-padR} height={Math.max(1, H-padB-terrY)} fill="rgba(244,63,94,0.10)" />
                      <line x1={padL} y1={terrY} x2={W-padR} y2={terrY} stroke="#f43f5e" strokeWidth={1} strokeDasharray="2 2"/>
                      <text x={W-padR-4} y={terrY-3} textAnchor="end" fill="#f43f5e" fontSize={8}>TERRAIN {(topRow.chk.terrainFt/1000).toFixed(0)}k ({topRow.chk.terrainName})</text>
                      {/* margin floor */}
                      <line x1={padL} y1={marginY} x2={W-padR} y2={marginY} stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 2"/>
                      <text x={W-padR-4} y={marginY-3} textAnchor="end" fill="#f59e0b" fontSize={8}>+{marginFt}ft margin floor (AC 120-42B)</text>
                      {/* net-ceil line */}
                      <line x1={padL} y1={netY} x2={W-padR} y2={netY} stroke="#0ea5e9" strokeWidth={1.2}/>
                      <text x={padL+4} y={netY-3} fill="#0ea5e9" fontSize={9}>OEI net-ceil FL{Math.round(topRow.chk.netCeilFt/100)}</text>
                      {/* driftdown path */}
                      <path d={`M ${xT(t0)} ${startY} L ${dropX} ${netY} L ${endX} ${netY}`}
                        fill="none" stroke={TIER_COLOR[topRow.tier]} strokeWidth={2.5}/>
                      <circle cx={xT(t0)} cy={startY} r={4} fill={TIER_COLOR[topRow.tier]} stroke="#0b1220" strokeWidth={1.2}/>
                      <text x={xT(t0)+6} y={startY-4} fill="#cbd5e1" fontSize={9}>cur FL{Math.round(topRow.f.altitudeFt/100)} · OEI event</text>
                      <circle cx={dropX} cy={netY} r={3.5} fill="#0ea5e9" stroke="#0b1220" strokeWidth={1.2}/>
                      <text x={dropX+6} y={netY+12} fill="#0ea5e9" fontSize={9}>level-off · t={topRow.chk.driftTimeMin.toFixed(0)}min · {topRow.chk.driftFuelKg.toFixed(0)}kg burned</text>
                      {/* axis label */}
                      <text x={(padL+W-padR)/2} y={H-4} textAnchor="middle" fill="#475569" fontSize={9}>time (minutes after OEI event)</text>
                    </svg>
                  )
                })()}
                <div className="grid grid-cols-4 gap-1 mt-3 text-[10px]">
                  <div className="px-2 py-1.5 rounded bg-slate-900/60 border border-slate-800">
                    <div className="text-[9px] text-slate-500">DRIFT-IAS</div>
                    <div className="text-slate-200 font-semibold tabular-nums">{topRow.sp.driftKIAS} kt</div>
                  </div>
                  <div className="px-2 py-1.5 rounded bg-slate-900/60 border border-slate-800">
                    <div className="text-[9px] text-slate-500">ROD-AVG</div>
                    <div className="text-slate-200 font-semibold tabular-nums">{topRow.sp.rodAvg} fpm</div>
                  </div>
                  <div className="px-2 py-1.5 rounded bg-slate-900/60 border border-slate-800">
                    <div className="text-[9px] text-slate-500">OEI-FF</div>
                    <div className="text-slate-200 font-semibold tabular-nums">{topRow.sp.oeiFFKgHr} kg/h</div>
                  </div>
                  <div className="px-2 py-1.5 rounded bg-slate-900/60 border border-slate-800">
                    <div className="text-[9px] text-slate-500">ENGINES</div>
                    <div className="text-slate-200 font-semibold tabular-nums">{topRow.sp.engines}</div>
                  </div>
                </div>
                <div className="mt-3 px-2 py-2 rounded bg-slate-900/40 border border-slate-800 text-[10px] leading-relaxed text-slate-400">
                  <div className="text-slate-300 font-semibold mb-1">Driftdown physics</div>
                  At OEI event, remaining thrust no longer matches all-engine cruise drag at the current FL. The aircraft slows, then descends at driftdown KIAS until reaching the level where T_OEI·σ^0.7 = qS·CD0 + (k/qS)·W² (Anderson §6.5). The net-ceiling adds a 0.1% gross-climb-gradient margin per CS-25.121(c). Terrain plus 1000 ft is the AC 120-42B compliance floor.
                  <div className="mt-2 italic">References: Boeing FCOM PI-11.30 · Airbus FCOM PRO-NOR-SOP-19 · 14 CFR §121.191 §25.121(c) · AC 120-42B §10.3.7 · EASA AMC-20-6 · ICAO Annex 6 Pt I §4.2.4.4 · BADA 3.15/4.2 OPF/APF.</div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
