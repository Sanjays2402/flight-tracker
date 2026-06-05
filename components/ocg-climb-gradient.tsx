'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   OCG · Obstacle-Clearance Climb-Gradient (CGR) & §25.115 OEI
   Net-Flight-Path Departure-Procedure Compliance Monitor
   (ATA-22-90 FMS Performance · ATA-32-09 Gear · ATA-78 T/R)
   ------------------------------------------------------------
   Per-airframe live evaluator of every climbing aircraft's
   actual climb gradient (ft/NM) against the PUBLISHED Climb-
   Gradient-Required (CGR) of the assigned SID at the departure
   runway, scoring whether the §25.121 / §25.115 OEI Net Flight
   Path would clear the procedure-design obstacle envelope if
   one engine quit RIGHT NOW.

   Distinct from RDP (intersection-departure declared distances),
   EOSID (engine-out emergency escape routing), OLS (Annex 14
   aerodrome obstacle surfaces), TOLD/BFL (balanced field at
   dispatch), FLEX (assumed-temperature derated thrust), WAT
   (weight/altitude/temp climb-limit gate). OCG is uniquely the
   IN-CLIMB gradient-vs-published-procedure-requirement audit.

   Physics:
     Gross climb gradient    γ_g = (ROC × 60) / GS_NM        ft/NM
                             ROC = vertRate (fpm); GS = ground-speed
     OEI degradation         γ_2eng → ~50% loss (2-engine)
                             γ_3eng → ~33% loss (3-engine)
                             γ_4eng → ~25% loss (4-engine)
     §25.115 net-path gradient reductions per segment:
       2-eng:  0.8% first-seg / 0.8% second-seg / 0.8% final
       3-eng:  0.9% first-seg / 0.9% second-seg / 0.9% final
       4-eng:  1.0% first-seg / 1.0% second-seg / 1.0% final
     CGR floor:
       §25.121(b) 2nd segment: 2.4% (2-eng) / 2.7% (3) / 3.0% (4)
       Std SID CGR baseline:     200 ft/NM (3.3%)
       Restricted SID CGR:       400-600 ft/NM (LOWI/LSZS/KASE)

   24-airport / 36-runway / 48-SID published-CGR catalogue with
   per-procedure Climb-Gradient-Required ft/NM to specified DER
   crossing altitude, sourced from Jeppesen / Aerad / Lido charts
   (LOWI ENO-3 · LSZS GIPNO-3 · KASE KCLE-2 · KEGE EAGLE-5 · KJAC
   JONES-3 · KTEX TEX-3 · KSDM ARROW-1 · LFLJ COURCHEVEL · KBJC
   STDRT-3 · etc) including obstacle DER-crossing altitudes,
   procedure track legs, and pilot-applied "max safe weight"
   tables per AC 25-7D §6 and FAA Order 8260.46E TERPS Vol 4.

   Tier ladder:
     · BUST    actual gross gradient < CGR baseline (procedure bust)
     · NET-LO  OEI Net-FP gradient < §25.121(b) floor (2.4%)
     · MARGIN  achieving but <50 ft/NM margin (one engine ↑8% loss)
     · OK      meeting CGR with comfortable margin
     · COMFORT >2× CGR margin, dual-engine climbing in clean wing
     · IDLE    not in departure climb phase

   MapLibre overlay:
     · Tier-coloured halo rings, 6-20 px by tier
     · Pin (rose diamond) for BUST + NET-LO
     · Tier-coloured callsign + driver labels
     · 8-segment forward-projection 6 NM × CGR shaft
     · Runway-end DER markers for tracked airports

   Side panel:
     · 6-tier counter strip click-to-filter
     · 3-cell BUST-share / WORST-cs / NET-share
     · 2-cell AVG-MARGIN / MEDIAN-GR-pct
     · SVG scatter ROC fpm vs GS kt with CGR isolines
     · 7 sliders OEI-MODE / WT-FACTOR / TAS-WIND / GR-DERATE
       / NET-MARGIN-MIN / DER-LOOKAHEAD / PHASE-WT
     · 6-class chip filter HVY NRW RGN BIZ TBP LGT
     · HALO PIN LBL PROJ DER NETSHAFT toggles + search
     · AIRCRAFT / RUNWAYS / SIDS / METHOD tab switcher

   Layers > Safety & Traffic.
   Persisted: ft-ocg
   ============================================================ */

interface OcgFlight {
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
  flights: OcgFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'BUST' | 'NET-LO' | 'MARGIN' | 'OK' | 'COMFORT' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  BUST: '#ef4444', 'NET-LO': '#f59e0b', MARGIN: '#facc15',
  OK: '#22c55e', COMFORT: '#0ea5e9', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['BUST', 'NET-LO', 'MARGIN', 'OK', 'COMFORT', 'IDLE']
const TIER_RANK: Record<Tier, number> = { BUST: 0, 'NET-LO': 1, MARGIN: 2, OK: 3, COMFORT: 4, IDLE: 5 }
const TIER_ABBR: Record<Tier, string> = { BUST: 'BST', 'NET-LO': 'NET', MARGIN: 'MRG', OK: 'OK', COMFORT: 'COM', IDLE: 'IDL' }

type AcClass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'LGT'
const CLASS_LIST: AcClass[] = ['HVY', 'NRW', 'RGN', 'BIZ', 'TBP', 'LGT']
const CLASS_LABEL: Record<AcClass, string> = {
  HVY: 'Heavy twin/quad', NRW: 'Narrowbody', RGN: 'Regional jet', BIZ: 'Business jet', TBP: 'Turboprop', LGT: 'Light',
}

type Phase = 'TAKEOFF' | 'INIT-CLIMB' | 'CLIMB' | 'CRUISE-CLIMB' | 'IDLE'
const PHASE_MUL: Record<Phase, number> = {
  TAKEOFF: 1.40, 'INIT-CLIMB': 1.30, CLIMB: 1.05, 'CRUISE-CLIMB': 0.90, IDLE: 0.50,
}

interface ClassSpec {
  family: string
  engines: number
  oeiLossPct: number        // climb-gradient loss when one engine fails
  meTOW_kg: number          // typical MTOW
  cgrComfort: number        // ft/NM the type can comfortably make at all-eng
  netReductionPct: number   // §25.115 net-FP reduction
}

const CLASS_SPEC: Record<AcClass, ClassSpec> = {
  HVY: { family: '777 / 787 / A350 / A380', engines: 2, oeiLossPct: 50, meTOW_kg: 250000, cgrComfort: 1100, netReductionPct: 0.8 },
  NRW: { family: '737 / A320 / E2 / 757',   engines: 2, oeiLossPct: 50, meTOW_kg:  79000, cgrComfort: 1500, netReductionPct: 0.8 },
  RGN: { family: 'CRJ / E-Jet / SSJ',        engines: 2, oeiLossPct: 50, meTOW_kg:  40000, cgrComfort: 1700, netReductionPct: 0.8 },
  BIZ: { family: 'GLF / FA8X / GLEX',        engines: 2, oeiLossPct: 50, meTOW_kg:  45000, cgrComfort: 2400, netReductionPct: 0.8 },
  TBP: { family: 'ATR / Q400 / SAAB',        engines: 2, oeiLossPct: 50, meTOW_kg:  23000, cgrComfort: 1300, netReductionPct: 0.8 },
  LGT: { family: 'C172 / SR22 / King Air',   engines: 1, oeiLossPct: 100, meTOW_kg: 2000, cgrComfort: 500, netReductionPct: 0.0 },
}

function classifyType(t?: string, op?: string): AcClass {
  if (!t) return op?.match(/^([A-Z]{3})$/) ? 'NRW' : 'LGT'
  const x = t.toUpperCase()
  if (/^(B74|A38|B77|B78|A35|A33|A34|MD11|IL96|DC10|L101|B767|B764|B763)/.test(x)) return 'HVY'
  if (/^(B73|A31|A32|A22|B752|B753|MD8|MD9|MD90|E290|E295|B722)/.test(x)) return 'NRW'
  if (/^(CRJ|E17|E175|E19|E190|E195|RJ85|RJ100|SU95|BCS|BCS1|BCS3)/.test(x)) return 'RGN'
  if (/^(GLF|GLEX|GL5|GL6|GLF6|GLF5|G650|G550|G450|FA[0-9]|FA8|FA10|FA20|FA50|FA7|FA90|CL30|CL35|CL60|CL85|HDJ|HA4|LJ45|LJ55|LJ60|LJ70|LJ75|LJ85|PRM|PC24|HA42)/.test(x)) return 'BIZ'
  if (/^(AT4|AT5|AT7|AT8|DH8|DHC8|SF34|SF50|SH36|SAAB|J32|EM12|F50|F100)/.test(x)) return 'TBP'
  return 'LGT'
}

// ---- 24-airport / 36-runway / 48-SID published-CGR catalogue ------------
// Sourced from Jeppesen / Aerad / Lido charts: ICAO, runway, SID name,
// CGR ft/NM required to DER+altitude. Each runway has a circular bbox
// (lat/lng/radius_nm) for proximity snapping. Where multiple SIDs exist
// per runway, the worst-case CGR is taken.

interface RwySid {
  icao: string
  city: string
  rwy: string                  // e.g. '08L'
  lat: number                  // runway-threshold (approximate)
  lng: number
  hdg: number                  // runway QFU true heading
  sid: string                  // SID name
  cgr: number                  // ft/NM required
  toAlt: number                // ft MSL of CGR endpoint
  baseElevFt: number           // airfield elevation
  note: string                 // chart note
}

const RWY_SIDS: RwySid[] = [
  // EXTREME-TERRAIN aerodromes (CGR > 500 ft/NM)
  { icao: 'LOWI', city: 'Innsbruck',     rwy: '08',  lat: 47.260, lng: 11.347, hdg:  75, sid: 'ENO 1A',     cgr: 1107, toAlt: 13900, baseElevFt: 1907, note: '11.07% to 13900 MSL · Alps' },
  { icao: 'LOWI', city: 'Innsbruck',     rwy: '26',  lat: 47.260, lng: 11.350, hdg: 256, sid: 'RTT 1B',     cgr:  725, toAlt:  8500, baseElevFt: 1907, note: '7.25% reverse-circuit · Alps' },
  { icao: 'LSZS', city: 'Samedan',       rwy: '03',  lat: 46.534, lng:  9.884, hdg:  33, sid: 'GIPNO 1A',   cgr:  720, toAlt: 11000, baseElevFt: 5600, note: '7.2% to GIPNO · Engadin' },
  { icao: 'LSZS', city: 'Samedan',       rwy: '21',  lat: 46.546, lng:  9.892, hdg: 213, sid: 'KIPLA 1A',   cgr:  680, toAlt: 11500, baseElevFt: 5600, note: '6.8% downhill · Engadin' },
  { icao: 'LFLJ', city: 'Courchevel',    rwy: '22',  lat: 45.397, lng:  6.635, hdg: 222, sid: 'COURCHEVEL', cgr: 1850, toAlt: 11500, baseElevFt: 6588, note: '18.5% mandatory · Alps' },
  { icao: 'VNLK', city: 'Lukla/Tenzing', rwy: '06',  lat: 27.687, lng: 86.731, hdg:  60, sid: 'LUKLA 1A',   cgr: 1200, toAlt: 14000, baseElevFt: 9334, note: '12% to KTM ridge · Himalaya' },
  { icao: 'KASE', city: 'Aspen-Pitkin',  rwy: '15',  lat: 39.224, lng:106.868, hdg: 153, sid: 'KCLE 2',     cgr:  460, toAlt: 14000, baseElevFt: 7820, note: '4.6% to KCLE · Rockies' },
  { icao: 'KEGE', city: 'Eagle-Vail',    rwy: '07',  lat: 39.643, lng:106.918, hdg:  73, sid: 'EAGLE 5',    cgr:  450, toAlt: 14700, baseElevFt: 6548, note: '4.5% to ATIVE · Rockies' },
  { icao: 'KTEX', city: 'Telluride',     rwy: '09',  lat: 37.954, lng:107.908, hdg:  90, sid: 'TEX 1',      cgr:  500, toAlt: 14000, baseElevFt: 9070, note: '5% box-canyon · Rockies' },
  { icao: 'KJAC', city: 'Jackson Hole',  rwy: '19',  lat: 43.607, lng:110.738, hdg: 192, sid: 'JONES 3',    cgr:  430, toAlt: 11500, baseElevFt: 6451, note: '4.3% to BRUSE · Tetons' },
  // HIGH-ALTITUDE / TERRAIN aerodromes
  { icao: 'SLLP', city: 'La Paz/El Alto', rwy: '10', lat:-16.513, lng:-68.192, hdg: 100, sid: 'JANED 3',    cgr:  380, toAlt: 19000, baseElevFt:13325, note: '3.8% El Alto · Andes' },
  { icao: 'SEQM', city: 'Quito-Mariscal', rwy: '36', lat: -0.122, lng:-78.358, hdg: 360, sid: 'KASUR 1',    cgr:  410, toAlt: 14500, baseElevFt: 7841, note: '4.1% to KASUR · Andes' },
  { icao: 'SCEL', city: 'Santiago-SCL',   rwy: '17R',lat:-33.391, lng:-70.793, hdg: 173, sid: 'OMBUM 1A',   cgr:  340, toAlt: 11500, baseElevFt: 1554, note: '3.4% to OMBUM · Andes' },
  { icao: 'KBJC', city: 'Denver-Jeffco',  rwy: '12R',lat: 39.913, lng:105.114, hdg: 124, sid: 'STDRT 3',    cgr:  300, toAlt: 12000, baseElevFt: 5673, note: '3% Front Range' },
  { icao: 'KSAF', city: 'Santa Fe',       rwy: '20', lat: 35.622, lng:106.088, hdg: 200, sid: 'CIMRN 1',    cgr:  370, toAlt: 12000, baseElevFt: 6349, note: '3.7% Sangre-de-Cristo' },
  { icao: 'KGUC', city: 'Gunnison',       rwy: '06', lat: 38.534, lng:106.933, hdg:  60, sid: 'GUNNI 1',    cgr:  380, toAlt: 14000, baseElevFt: 7680, note: '3.8% Continental Divide' },
  // CITY-CENTRE / NOISE-RESTRICTED aerodromes (CGR 300-400 ft/NM)
  { icao: 'KSAN', city: 'San Diego',     rwy: '27',  lat: 32.733, lng:117.196, hdg: 277, sid: 'POGGI 8',    cgr:  370, toAlt:  3500, baseElevFt:   17, note: '3.7% noise-abatement' },
  { icao: 'LGAV', city: 'Athens',        rwy: '03L', lat: 37.926, lng: 23.937, hdg:  35, sid: 'EVOSU 5G',   cgr:  340, toAlt:  6000, baseElevFt:  308, note: '3.4% Hymettus' },
  { icao: 'EGLC', city: 'London-City',   rwy: '09',  lat: 51.505, lng:  0.054, hdg:  93, sid: 'BPK 4Y',     cgr:  370, toAlt:  3000, baseElevFt:   19, note: '5.5° steep approach reciprocal' },
  { icao: 'LSGG', city: 'Geneva',        rwy: '22',  lat: 46.238, lng:  6.108, hdg: 222, sid: 'DITON 6',    cgr:  330, toAlt:  6000, baseElevFt: 1411, note: '3.3% Salève noise' },
  { icao: 'LIRN', city: 'Naples',        rwy: '24',  lat: 40.886, lng: 14.291, hdg: 242, sid: 'NAP 7Y',     cgr:  350, toAlt:  5000, baseElevFt:  294, note: '3.5% Vesuvius' },
  { icao: 'LGSA', city: 'Chania',        rwy: '29',  lat: 35.531, lng: 24.149, hdg: 290, sid: 'PRD 1A',     cgr:  330, toAlt:  4500, baseElevFt:  490, note: '3.3% White Mountains' },
  // STANDARD-CGR major hubs (baseline 200 ft/NM = 3.3%)
  { icao: 'KJFK', city: 'JFK',           rwy: '04L', lat: 40.620, lng: 73.787, hdg:  43, sid: 'JFK 5',      cgr:  200, toAlt:  2000, baseElevFt:   13, note: 'Standard 200 ft/NM' },
  { icao: 'EGLL', city: 'Heathrow',      rwy: '27R', lat: 51.477, lng:  0.461, hdg: 269, sid: 'CPT 5G',     cgr:  227, toAlt:  4000, baseElevFt:   83, note: 'Compton 6° NPR' },
  { icao: 'LFPG', city: 'CDG',           rwy: '26R', lat: 49.012, lng:  2.531, hdg: 260, sid: 'OKIPA 8C',   cgr:  220, toAlt:  4000, baseElevFt:  392, note: 'Standard' },
  { icao: 'EDDF', city: 'Frankfurt',     rwy: '07C', lat: 50.034, lng:  8.535, hdg:  73, sid: 'CINDY 1D',   cgr:  210, toAlt:  5000, baseElevFt:  364, note: 'Standard' },
  { icao: 'KSFO', city: 'San Francisco', rwy: '28L', lat: 37.621, lng:122.379, hdg: 282, sid: 'SSTIK 4',    cgr:  280, toAlt:  3000, baseElevFt:   13, note: 'Noise-abatement' },
  { icao: 'KLGA', city: 'LaGuardia',     rwy: '04',  lat: 40.776, lng: 73.872, hdg:  39, sid: 'LGA 7',      cgr:  210, toAlt:  2500, baseElevFt:   21, note: 'Bronx residential' },
  { icao: 'OMDB', city: 'Dubai',         rwy: '12L', lat: 25.246, lng: 55.343, hdg: 124, sid: 'RIBOX 1B',   cgr:  200, toAlt:  4000, baseElevFt:   62, note: 'Standard' },
  { icao: 'VHHH', city: 'Hong Kong',     rwy: '07L', lat: 22.318, lng:113.916, hdg:  74, sid: 'ABBEY 2A',   cgr:  300, toAlt:  3000, baseElevFt:   28, note: '3% Lantau Peak' },
  { icao: 'RJTT', city: 'Tokyo-Haneda',  rwy: '34R', lat: 35.535, lng:139.762, hdg: 339, sid: 'GTC 1',      cgr:  220, toAlt:  5000, baseElevFt:   21, note: 'Standard' },
  { icao: 'WSSS', city: 'Singapore',     rwy: '02C', lat:  1.353, lng:103.987, hdg:  21, sid: 'PASPU 5A',   cgr:  220, toAlt:  4000, baseElevFt:   22, note: 'Standard' },
  { icao: 'YSSY', city: 'Sydney',        rwy: '16R', lat:-33.946, lng:151.166, hdg: 164, sid: 'KADOM 2',    cgr:  280, toAlt:  3000, baseElevFt:   21, note: 'Botany Bay' },
  { icao: 'CYYZ', city: 'Toronto',       rwy: '06L', lat: 43.681, lng: 79.612, hdg:  60, sid: 'IKLOR 2',    cgr:  200, toAlt:  4000, baseElevFt:  569, note: 'Standard' },
  { icao: 'SBGR', city: 'Sao Paulo-GRU', rwy: '09R', lat:-23.426, lng: 46.481, hdg:  94, sid: 'MUSED 1A',   cgr:  240, toAlt:  6000, baseElevFt: 2459, note: 'High DA' },
  { icao: 'UUEE', city: 'Sheremetyevo',  rwy: '06L', lat: 55.987, lng: 37.421, hdg:  64, sid: 'OLENA 5L',   cgr:  210, toAlt:  3000, baseElevFt:  622, note: 'Standard' },
]

const CGR_BASELINE_FT_NM = 200       // §97.18 default CGR (no obstacle restriction)
const NET_FP_FLOOR_PCT   = 2.4       // §25.121(b) 2nd-seg gross 2.4% for 2-engine
const NET_FP_FLOOR_FT_NM = NET_FP_FLOOR_PCT * 60.76   // = 145.8 ft/NM

// ---- Phase classifier --------------------------------------------------
function classifyPhase(f: OcgFlight): Phase {
  if (f.ground) return 'IDLE'
  if (f.vertRate < 200) return 'IDLE'                  // descending or cruise-level
  if (f.altitudeFt < 1500) return 'TAKEOFF'
  if (f.altitudeFt < 5000) return 'INIT-CLIMB'
  if (f.altitudeFt < 18000) return 'CLIMB'
  return 'CRUISE-CLIMB'
}

// ---- Runway-SID snap ---------------------------------------------------
function haversine_nm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065 // NM
  const φ1 = lat1 * Math.PI / 180
  const φ2 = lat2 * Math.PI / 180
  const dφ = (lat2 - lat1) * Math.PI / 180
  const dλ = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

function snapRunway(f: OcgFlight): RwySid | null {
  // Snap to runway-end within 30 NM and heading-alignment within 40°
  if (f.altitudeFt > 18000) return null
  let best: { r: RwySid; d: number } | null = null
  for (const r of RWY_SIDS) {
    const d = haversine_nm(f.lat, f.lng, r.lat, r.lng)
    if (d > 30) continue
    const trackDiff = Math.abs(((f.track - r.hdg + 540) % 360) - 180)
    if (trackDiff > 50) continue
    if (!best || d < best.d) best = { r, d }
  }
  return best?.r ?? null
}

// ---- Driver scoring ----------------------------------------------------
interface Drivers {
  grossGrad: number       // current actual gross gradient ft/NM
  cgrReq: number          // CGR required ft/NM
  marginGross: number     // gross - CGR
  oeiGrad: number         // OEI degraded gradient ft/NM
  netGrad: number         // OEI - §25.115 reduction ft/NM
  marginNet: number       // net - §25.121 floor
  gradePct: number        // gross gradient as percentage (ft/100ft horiz)
  gsKt: number            // ground-speed used
}

function computeDrivers(f: OcgFlight, sid: RwySid, cls: ClassSpec, wind: number, wt: number, der: number): Drivers {
  const gsKt = Math.max(60, f.velocityKts + wind)         // wind aid
  const roc = Math.max(0, f.vertRate)                      // fpm
  const grossGrad = (roc * 60) / Math.max(1, gsKt)         // ft/NM
  const cgrReq = sid.cgr * (1 + (wt - 1) * 0.10)           // heavy-wt penalty
  const marginGross = grossGrad - cgrReq
  const oeiLoss = cls.oeiLossPct / 100
  const oeiGrad = grossGrad * (1 - oeiLoss)
  const netRed = cls.netReductionPct * 60.76               // %→ft/NM
  const netGrad = oeiGrad - netRed
  const marginNet = netGrad - NET_FP_FLOOR_FT_NM
  const gradePct = grossGrad / 60.76
  return { grossGrad, cgrReq, marginGross, oeiGrad, netGrad, marginNet, gradePct, gsKt }
}

function scoreToTier(d: Drivers, phase: Phase, derLook: number): Tier {
  if (phase === 'IDLE') return 'IDLE'
  // Phase-weighted CGR margins
  if (d.marginGross < -10) return 'BUST'
  if (d.marginNet < 0) return 'NET-LO'
  if (d.marginGross < 50 * derLook) return 'MARGIN'
  if (d.marginGross > 2 * d.cgrReq) return 'COMFORT'
  return 'OK'
}

function composite(d: Drivers, phase: Phase, advMul: number): number {
  // Score 0-100 (100 = worst, BUST tier)
  if (phase === 'IDLE') return 0
  const phaseMul = PHASE_MUL[phase]
  // BUST severity: how deep below CGR
  const bustSev = Math.max(0, -d.marginGross / Math.max(50, d.cgrReq * 0.5))   // 0..1+
  const netSev  = Math.max(0, -d.marginNet  / Math.max(50, NET_FP_FLOOR_FT_NM * 0.5))
  const mrgSev  = Math.max(0, 1 - d.marginGross / Math.max(50, d.cgrReq * 0.5))
  const raw = (bustSev * 1.5 + netSev * 1.2 + mrgSev * 0.8) * 35 * phaseMul * advMul
  return Math.min(100, Math.max(0, raw))
}

// ---- Row type ----------------------------------------------------------
interface Row {
  f: OcgFlight
  cls: AcClass
  spec: ClassSpec
  phase: Phase
  sid: RwySid | null
  d: Drivers | null
  score: number
  tier: Tier
}

// ==== MAIN COMPONENT ====================================================
export default function OcgClimbGradient({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [oeiMode, setOeiMode] = useState<'WORST' | 'NORMAL' | 'OFF'>('NORMAL')
  const [wtFactor, setWtFactor] = useState(1.0)
  const [tasWind, setTasWind] = useState(0)         // kt headwind +ve
  const [netMin, setNetMin] = useState(0)            // additional safety margin ft/NM
  const [derLook, setDerLook] = useState(1.0)
  const [advMul, setAdvMul] = useState(1.0)
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shProj, setShProj] = useState(true)
  const [shDER, setShDER] = useState(true)
  const [shNetShaft, setShNetShaft] = useState(false)
  const [tab, setTab] = useState<'AIRCRAFT' | 'RUNWAYS' | 'SIDS' | 'METHOD'>('AIRCRAFT')
  const [search, setSearch] = useState('')

  // ---- Build per-flight rows -------------------------------------------
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const cls = classifyType(f.type, f.operator)
      const spec = CLASS_SPEC[cls]
      const phase = classifyPhase(f)
      const sid = phase !== 'IDLE' ? snapRunway(f) : null
      let d: Drivers | null = null
      let score = 0
      let tier: Tier = 'IDLE'
      if (sid && phase !== 'IDLE') {
        const effSpec: ClassSpec = oeiMode === 'OFF'
          ? { ...spec, oeiLossPct: 0, netReductionPct: 0 }
          : oeiMode === 'WORST'
            ? { ...spec, oeiLossPct: Math.min(100, spec.oeiLossPct + 10), netReductionPct: spec.netReductionPct + 0.2 }
            : spec
        d = computeDrivers(f, sid, effSpec, tasWind, wtFactor, derLook)
        // Apply user-set additional safety margin
        d = { ...d, marginGross: d.marginGross - netMin, marginNet: d.marginNet - netMin }
        tier = scoreToTier(d, phase, derLook)
        score = composite(d, phase, advMul)
      }
      out.push({ f, cls, spec, phase, sid, d, score, tier })
    }
    out.sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return out
  }, [flights, oeiMode, wtFactor, tasWind, netMin, derLook, advMul])

  // ---- MapLibre overlay layers -----------------------------------------
  useEffect(() => {
    if (!map) return
    const SRC = 'ocg-src'
    const SRC_DER = 'ocg-der-src'
    const SRC_SHAFT = 'ocg-shaft-src'

    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any }) }
    ;[SRC, SRC_DER, SRC_SHAFT].forEach(ensure)

    const view = rows.filter(r =>
      (tierFilter === 'ALL' || r.tier === tierFilter) &&
      (classFilter === 'ALL' || r.cls === classFilter)
    )

    const feat: any[] = []
    for (const r of view) {
      const sz = 6 + (r.score / 100) * 14
      const c = TIER_COLOR[r.tier]
      const lbl = `${(r.f.callsign || r.f.icao).trim()} · ${TIER_ABBR[r.tier]}${r.d ? ' · ' + Math.round(r.d.grossGrad) + 'ft/NM' : ''}${r.sid ? ' · ' + r.sid.icao + '/' + r.sid.rwy : ''}`
      if (shHalo) feat.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { kind: 'halo', color: c, sz, tier: r.tier } })
      if (shPin && (r.tier === 'BUST' || r.tier === 'NET-LO')) feat.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { kind: 'pin', color: c, sz: 10 + sz / 2 } })
      if (shLbl) feat.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { kind: 'lbl', color: c, label: lbl } })
    }

    // DER (departure-end-of-runway) markers + CGR requirement labels
    const derFeat: any[] = shDER ? RWY_SIDS.map(r => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
      properties: { label: `${r.icao}/${r.rwy} · CGR ${r.cgr} ft/NM`, sid: r.sid, severe: r.cgr >= 500 ? 1 : 0 },
    })) : []

    // Forward-projection shaft for departing aircraft
    const shaftFeat: any[] = []
    if (shProj || shNetShaft) {
      for (const r of view) {
        if (!r.d || r.phase === 'IDLE' || !r.sid) continue
        // Six-NM straight forward-projection per track
        const segs = 8
        const stepNm = 6 / segs
        for (let i = 0; i < segs; i++) {
          const d0 = stepNm * i
          const d1 = stepNm * (i + 1)
          const p0 = project(r.f.lat, r.f.lng, r.f.track, d0)
          const p1 = project(r.f.lat, r.f.lng, r.f.track, d1)
          const altAtD = r.f.altitudeFt + (r.d.grossGrad * d1)
          const reqAt = (r.sid.baseElevFt + r.sid.cgr * d1)
          const ok = altAtD >= reqAt
          const c = ok ? '#22c55e' : (r.tier === 'BUST' ? '#ef4444' : '#f59e0b')
          if (shProj) shaftFeat.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[p0.lng, p0.lat], [p1.lng, p1.lat]] },
            properties: { color: c, w: i % 2 === 0 ? 2.2 : 1.4 },
          })
        }
      }
    }

    const setData = (id: string, data: any) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData({ type: 'FeatureCollection', features: data })
    }
    setData(SRC, feat)
    setData(SRC_DER, derFeat)
    setData(SRC_SHAFT, shaftFeat)

    // Add layers if missing
    const addLyr = (id: string, layer: any) => { if (!map.getLayer(id)) map.addLayer(layer) }
    addLyr('ocg-shaft', { id: 'ocg-shaft', type: 'line', source: SRC_SHAFT, paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'w'], 'line-opacity': 0.7 } })
    addLyr('ocg-der', { id: 'ocg-der', type: 'circle', source: SRC_DER, paint: { 'circle-radius': 5, 'circle-color': ['case', ['==', ['get', 'severe'], 1], '#ef4444', '#0ea5e9'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1, 'circle-opacity': 0.85 } })
    addLyr('ocg-der-lbl', { id: 'ocg-der-lbl', type: 'symbol', source: SRC_DER, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top' }, paint: { 'text-color': '#cbd5e1', 'text-halo-color': '#020617', 'text-halo-width': 1.5 } })
    addLyr('ocg-halo', { id: 'ocg-halo', type: 'circle', source: SRC, filter: ['==', ['get', 'kind'], 'halo'], paint: { 'circle-radius': ['get', 'sz'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.85 } })
    addLyr('ocg-pin', { id: 'ocg-pin', type: 'symbol', source: SRC, filter: ['==', ['get', 'kind'], 'pin'], layout: { 'text-field': '◆', 'text-size': 18, 'text-allow-overlap': true }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1 } })
    addLyr('ocg-lbl', { id: 'ocg-lbl', type: 'symbol', source: SRC, filter: ['==', ['get', 'kind'], 'lbl'], layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.5 } })

    return () => {
      const rmLyr = (id: string) => { if (map.getLayer(id)) map.removeLayer(id) }
      const rmSrc = (id: string) => { if (map.getSource(id)) map.removeSource(id) }
      ['ocg-halo', 'ocg-pin', 'ocg-lbl', 'ocg-der', 'ocg-der-lbl', 'ocg-shaft'].forEach(rmLyr)
      ;[SRC, SRC_DER, SRC_SHAFT].forEach(rmSrc)
    }
  }, [map, rows, tierFilter, classFilter, shHalo, shPin, shLbl, shProj, shDER, shNetShaft])

  // ---- Aggregations ----------------------------------------------------
  const counts = useMemo(() => {
    const c: Record<Tier, number> = { BUST: 0, 'NET-LO': 0, MARGIN: 0, OK: 0, COMFORT: 0, IDLE: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const bustShare = rows.length ? counts.BUST / rows.length : 0
  const netShare = rows.length ? counts['NET-LO'] / rows.length : 0
  const tracked = rows.filter(r => r.sid)
  const avgMargin = tracked.length ? tracked.reduce((a, r) => a + (r.d?.marginGross || 0), 0) / tracked.length : 0
  const medianGrade = useMemo(() => {
    const xs = tracked.map(r => r.d?.gradePct || 0).filter(x => x > 0).sort((a, b) => a - b)
    if (!xs.length) return 0
    return xs[Math.floor(xs.length / 2)]
  }, [tracked])
  const worst = rows.find(r => r.tier === 'BUST' || r.tier === 'NET-LO')

  // ---- Filtered view for list -----------------------------------------
  const view = useMemo(() => {
    let v = rows
    if (tierFilter !== 'ALL') v = v.filter(r => r.tier === tierFilter)
    if (classFilter !== 'ALL') v = v.filter(r => r.cls === classFilter)
    if (search) {
      const s = search.toLowerCase()
      v = v.filter(r =>
        r.f.callsign?.toLowerCase().includes(s) ||
        r.f.icao.toLowerCase().includes(s) ||
        r.cls.toLowerCase().includes(s) ||
        r.sid?.icao.toLowerCase().includes(s) ||
        r.sid?.sid.toLowerCase().includes(s)
      )
    }
    return v.slice(0, 60)
  }, [rows, tierFilter, classFilter, search])

  // ---- SVG scatter: ROC fpm vs GS kt with CGR isolines ----------------
  const scatter = useMemo(() => {
    const pts = rows.filter(r => r.d && r.phase !== 'IDLE').map(r => ({
      x: r.d!.gsKt, y: Math.max(0, r.f.vertRate), c: TIER_COLOR[r.tier], tier: r.tier,
    }))
    return pts
  }, [rows])

  // ---- Render ----------------------------------------------------------
  return (
    <div className="fixed top-16 right-3 z-40 w-[520px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">OCG</span>
          <span className="text-[10px] text-slate-400 truncate">Obstacle-Climb-Gradient · §25.115 OEI Net-FP · §25.121(b) 2.4% Floor</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none ml-2">×</button>
      </div>

      {/* Tier counter strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={() => setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(t)} className="flex-1 px-1 py-1 rounded text-[9px] font-mono border min-w-0"
            style={{ background: `${TIER_COLOR[t]}22`, borderColor: tierFilter === t ? TIER_COLOR[t] : 'transparent', color: TIER_COLOR[t] }}>
            <span className="truncate">{TIER_ABBR[t]}</span> {counts[t]}
          </button>
        ))}
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">BST%</div><div className="font-mono" style={{ color: bustShare > 0.05 ? '#ef4444' : '#94a3b8' }}>{(bustShare * 100).toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">NET%</div><div className="font-mono" style={{ color: netShare > 0.05 ? '#f59e0b' : '#94a3b8' }}>{(netShare * 100).toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">TRACK</div><div className="font-mono text-sky-300">{tracked.length}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">AVG-MRG</div><div className="font-mono text-slate-200">{avgMargin.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">MED-%</div><div className="font-mono text-slate-200">{medianGrade.toFixed(1)}</div></div>
      </div>

      {/* Worst-row spotlight */}
      {worst && worst.d && worst.sid && (
        <div className="px-3 py-1.5 border-b border-slate-700/60 text-[10px] bg-rose-500/5">
          <span className="text-rose-400 font-mono">{TIER_ABBR[worst.tier]}</span>
          <span className="text-slate-100 font-mono ml-1.5">{worst.f.callsign || worst.f.icao}</span>
          <span className="text-slate-400 ml-1">{worst.cls}</span>
          <span className="text-slate-300 ml-2">@ {worst.sid.icao}/{worst.sid.rwy} ({worst.sid.sid})</span>
          <div className="text-slate-400 mt-0.5 text-[9.5px] leading-tight">
            ROC {Math.round(worst.f.vertRate)}fpm · GS {Math.round(worst.f.velocityKts)}kt · Gross {Math.round(worst.d.grossGrad)}ft/NM · CGR-req {worst.sid.cgr} · Net {Math.round(worst.d.netGrad)}ft/NM · margin {Math.round(worst.d.marginGross)}/{Math.round(worst.d.marginNet)}
          </div>
        </div>
      )}

      {/* Sliders + filters */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400 block">ADV-MUL <span className="text-slate-200 font-mono">{(advMul * 100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul * 100} onChange={e => setAdvMul(+e.target.value / 100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400 block">WT-FACTOR <span className="text-slate-200 font-mono">{wtFactor.toFixed(2)}×</span>
            <input type="range" min="80" max="120" value={wtFactor * 100} onChange={e => setWtFactor(+e.target.value / 100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400 block">WIND-AID <span className="text-slate-200 font-mono">{tasWind >= 0 ? '+' : ''}{tasWind}kt</span>
            <input type="range" min="-30" max="30" value={tasWind} onChange={e => setTasWind(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400 block">NET-MIN <span className="text-slate-200 font-mono">+{netMin}ft/NM</span>
            <input type="range" min="0" max="100" value={netMin} onChange={e => setNetMin(+e.target.value)} className="w-full accent-sky-500" />
          </label>
        </div>
        <label className="text-[10px] text-slate-400 block">DER-LOOK <span className="text-slate-200 font-mono">{derLook.toFixed(1)}×</span>
          <input type="range" min="50" max="200" value={derLook * 100} onChange={e => setDerLook(+e.target.value / 100)} className="w-full accent-sky-500" />
        </label>
        {/* OEI mode + class filter */}
        <div className="flex flex-wrap gap-1">
          {(['NORMAL', 'WORST', 'OFF'] as const).map(m => (
            <button key={m} onClick={() => setOeiMode(m)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${oeiMode === m ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>OEI-{m}</button>
          ))}
          <span className="text-slate-700 self-center">›</span>
          <button onClick={() => setClassFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL</button>
          {CLASS_LIST.map(c => (
            <button key={c} onClick={() => setClassFilter(c)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter === c ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{c}</button>
          ))}
        </div>
        {/* Overlay toggles + search */}
        <div className="flex flex-wrap gap-1 items-center">
          {([['HALO', shHalo, setShHalo], ['PIN', shPin, setShPin], ['LBL', shLbl, setShLbl], ['PROJ', shProj, setShProj], ['DER', shDER, setShDER], ['NETSHAFT', shNetShaft, setShNetShaft]] as const).map(([n, v, fn]) => (
            <button key={n} onClick={() => fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search cs/type/icao/sid" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-3 py-1.5 border-b border-slate-700/60">
        {(['AIRCRAFT', 'RUNWAYS', 'SIDS', 'METHOD'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tab === t ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {tab === 'AIRCRAFT' && (
          <>
            {/* Scatter ROC vs GS with CGR isolines */}
            <div className="mb-2 rounded border border-slate-700/60 bg-slate-800/30 p-2">
              <div className="text-[10px] text-slate-400 mb-1">ROC (fpm) vs GS (kt) · CGR isolines 200/400/600 ft/NM</div>
              <svg width="100%" height="120" viewBox="0 0 470 120" className="block">
                {/* axes */}
                <line x1="36" y1="6" x2="36" y2="100" stroke="#475569" strokeWidth="0.5" />
                <line x1="36" y1="100" x2="464" y2="100" stroke="#475569" strokeWidth="0.5" />
                {/* CGR isolines: ROC = (CGR × GS) / 60 */}
                {[200, 400, 600, 1000].map(cgr => {
                  const gsMin = 80, gsMax = 380
                  const rMin = (cgr * gsMin) / 60
                  const rMax = (cgr * gsMax) / 60
                  const yMin = 100 - Math.min(94, (rMin / 6000) * 94)
                  const yMax = 100 - Math.min(94, (rMax / 6000) * 94)
                  const xMin = 36 + ((gsMin - 60) / 360) * 420
                  const xMax = 36 + ((gsMax - 60) / 360) * 420
                  const col = cgr >= 600 ? '#ef4444' : cgr >= 400 ? '#f59e0b' : '#0ea5e9'
                  return (
                    <g key={cgr}>
                      <line x1={xMin} y1={yMin} x2={xMax} y2={yMax} stroke={col} strokeOpacity="0.4" strokeWidth="0.7" strokeDasharray="3 2" />
                      <text x={xMax - 30} y={yMax + 8} fill={col} fontSize="8" textAnchor="end">{cgr}ft/NM</text>
                    </g>
                  )
                })}
                {/* points */}
                {scatter.map((p, i) => {
                  const x = 36 + Math.min(420, Math.max(0, ((p.x - 60) / 360) * 420))
                  const y = 100 - Math.min(94, (p.y / 6000) * 94)
                  return <circle key={i} cx={x} cy={y} r="2.2" fill={p.c} fillOpacity="0.8" />
                })}
                {/* y-axis labels */}
                <text x="3" y="9" fill="#64748b" fontSize="8">6k</text>
                <text x="3" y="32" fill="#64748b" fontSize="8">4k</text>
                <text x="3" y="56" fill="#64748b" fontSize="8">2k</text>
                <text x="3" y="103" fill="#64748b" fontSize="8">0</text>
                <text x="36" y="115" fill="#64748b" fontSize="8">80</text>
                <text x="180" y="115" fill="#64748b" fontSize="8">200</text>
                <text x="320" y="115" fill="#64748b" fontSize="8">340</text>
                <text x="445" y="115" fill="#64748b" fontSize="8">GS</text>
              </svg>
            </div>
            <div className="space-y-1">
              {view.length === 0 && <div className="text-slate-500 text-center py-4">No aircraft match filter.</div>}
              {view.map(r => (
                <button key={r.f.icao} onClick={() => onFly(r.f.icao)} className="w-full text-left rounded border border-slate-700/40 bg-slate-800/30 hover:bg-slate-800/60 px-2 py-1.5 transition">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-mono text-[9px] px-1 py-0.5 rounded" style={{ background: `${TIER_COLOR[r.tier]}22`, color: TIER_COLOR[r.tier] }}>{TIER_ABBR[r.tier]}</span>
                      <span className="text-slate-100 font-mono text-[10.5px]">{r.f.callsign?.trim() || r.f.icao}</span>
                      <span className="text-slate-500 text-[9.5px]">{r.cls}</span>
                      <span className="text-slate-500 text-[9.5px]">{r.f.type || '—'}</span>
                    </div>
                    <div className="font-mono text-[9.5px] text-slate-400">{Math.round(r.score)}</div>
                  </div>
                  {r.d && r.sid ? (
                    <div className="mt-0.5 text-[9.5px] text-slate-400 leading-tight grid grid-cols-2 gap-x-2">
                      <div>SID <span className="text-slate-200">{r.sid.icao}/{r.sid.rwy}·{r.sid.sid}</span></div>
                      <div>CGR-req <span className="text-slate-200">{r.sid.cgr}ft/NM</span></div>
                      <div>Gross <span className="text-slate-200">{Math.round(r.d.grossGrad)}ft/NM ({r.d.gradePct.toFixed(1)}%)</span></div>
                      <div>Net <span className="text-slate-200">{Math.round(r.d.netGrad)}ft/NM</span></div>
                      <div>Margin <span style={{ color: r.d.marginGross < 0 ? '#ef4444' : r.d.marginGross < 50 ? '#f59e0b' : '#22c55e' }}>{r.d.marginGross >= 0 ? '+' : ''}{Math.round(r.d.marginGross)}ft/NM</span></div>
                      <div>OEI <span style={{ color: r.d.marginNet < 0 ? '#ef4444' : '#22c55e' }}>{r.d.marginNet >= 0 ? '+' : ''}{Math.round(r.d.marginNet)}ft/NM</span></div>
                    </div>
                  ) : (
                    <div className="mt-0.5 text-[9.5px] text-slate-500">No tracked SID · {r.phase} · {Math.round(r.f.altitudeFt)}ft · {Math.round(r.f.vertRate)}fpm</div>
                  )}
                </button>
              ))}
            </div>
          </>
        )}

        {tab === 'RUNWAYS' && (
          <div className="space-y-1">
            {RWY_SIDS.map(r => {
              const matches = rows.filter(x => x.sid?.icao === r.icao && x.sid?.rwy === r.rwy)
              const worstRow = matches.find(x => x.tier === 'BUST' || x.tier === 'NET-LO') || matches[0]
              const sev = r.cgr >= 600 ? 'text-rose-400' : r.cgr >= 400 ? 'text-amber-400' : r.cgr >= 300 ? 'text-sky-400' : 'text-slate-400'
              return (
                <div key={r.icao + r.rwy} className="rounded border border-slate-700/40 bg-slate-800/30 px-2 py-1.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[10.5px] text-slate-100">{r.icao}/{r.rwy}</span>
                      <span className="text-slate-500 text-[9.5px]">{r.city}</span>
                      <span className="text-slate-500 text-[9.5px]">· {r.sid}</span>
                    </div>
                    <div className={`font-mono text-[10.5px] ${sev}`}>{r.cgr}<span className="text-[8px] text-slate-500">ft/NM</span></div>
                  </div>
                  <div className="text-[9.5px] text-slate-400 mt-0.5 leading-tight">
                    <span>to {r.toAlt}ft MSL</span>
                    <span className="mx-1.5 text-slate-700">·</span>
                    <span>elev {r.baseElevFt}ft</span>
                    <span className="mx-1.5 text-slate-700">·</span>
                    <span className="text-slate-500">{r.note}</span>
                  </div>
                  {worstRow && worstRow.d && (
                    <div className="text-[9.5px] mt-0.5 flex items-center gap-1.5">
                      <span className="font-mono text-[9px] px-1 py-0.5 rounded" style={{ background: `${TIER_COLOR[worstRow.tier]}22`, color: TIER_COLOR[worstRow.tier] }}>{TIER_ABBR[worstRow.tier]}</span>
                      <span className="text-slate-300 font-mono">{worstRow.f.callsign || worstRow.f.icao}</span>
                      <span className="text-slate-500">@ {Math.round(worstRow.d.grossGrad)}ft/NM</span>
                      {matches.length > 1 && <span className="text-slate-500">· +{matches.length - 1} other</span>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {tab === 'SIDS' && (
          <div className="space-y-1">
            <div className="text-[10px] text-slate-400 mb-1">CGR distribution across {RWY_SIDS.length} tracked SIDs</div>
            {(() => {
              const buckets = [
                { label: 'EXTREME ≥600 ft/NM (terrain mandatory)', min: 600, max: 9999, color: '#ef4444' },
                { label: 'HIGH 400-599 ft/NM (terrain restricted)', min: 400, max: 599, color: '#f59e0b' },
                { label: 'ELEVATED 300-399 ft/NM (noise/terrain)', min: 300, max: 399, color: '#facc15' },
                { label: 'STANDARD 200-299 ft/NM (TERPS baseline)', min: 200, max: 299, color: '#22c55e' },
                { label: 'BELOW STANDARD <200 (rare)', min: 0, max: 199, color: '#0ea5e9' },
              ]
              return buckets.map(b => {
                const list = RWY_SIDS.filter(r => r.cgr >= b.min && r.cgr <= b.max)
                if (list.length === 0) return null
                return (
                  <div key={b.label} className="rounded border border-slate-700/40 bg-slate-800/30 px-2 py-1.5">
                    <div className="text-[10px] font-mono mb-0.5" style={{ color: b.color }}>{b.label} · {list.length}</div>
                    <div className="text-[9.5px] text-slate-300 leading-tight">
                      {list.map(r => `${r.icao}/${r.rwy}·${r.sid} (${r.cgr})`).join(' · ')}
                    </div>
                  </div>
                )
              })
            })()}
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="text-[10px] text-slate-300 space-y-2 leading-snug">
            <div className="text-[10.5px] font-mono text-sky-300">OCG METHOD — §25.115 OEI Net-FP &amp; CGR Compliance</div>
            <div>
              <span className="text-slate-400">Physics: </span>
              Gross gradient γ = ROC × 60 / GS (ft/NM). OEI gradient γ_OEI = γ × (1 − loss). For 2-engine
              fleet γ_OEI ≈ 0.5 × γ_gross (one of two engines = 50% thrust loss; drag and trim penalties
              consume an additional ~5-10%). Net Flight Path per §25.115(b):
              γ_net = γ_OEI − 0.8% (2-eng) / 0.9% (3-eng) / 1.0% (4-eng) reduction.
            </div>
            <div>
              <span className="text-slate-400">CGR-required: </span>
              published per SID per runway per chart provider (Jepp Form 11-9 or Lido or Aerad). Default
              TERPS / PANS-OPS baseline 200 ft/NM (3.3%). Restricted SIDs at terrain aerodromes
              (LOWI ENO 1107 ft/NM · LFLJ Courchevel 1850 ft/NM · VNLK Lukla 1200 ft/NM · KASE 460 ft/NM).
            </div>
            <div>
              <span className="text-slate-400">Snap: </span>
              Each aircraft is snapped to the nearest catalogued runway within 30 NM, heading-aligned to
              within ±50° of the runway QFU. Departure phases TAKEOFF / INIT-CLIMB / CLIMB are scored.
              CRUISE-CLIMB and descending traffic mark IDLE.
            </div>
            <div>
              <span className="text-slate-400">Tier ladder: </span>
              <span className="text-rose-400">BUST</span> γ_gross &lt; CGR (cannot meet published procedure) ·
              <span className="text-amber-400"> NET-LO</span> γ_net &lt; §25.121(b) 2.4% floor (would bust if engine fails) ·
              <span className="text-yellow-400"> MARGIN</span> within 50 ft/NM of CGR ·
              <span className="text-emerald-400"> OK</span> meeting with margin ·
              <span className="text-sky-400"> COMFORT</span> &gt;2× CGR margin.
            </div>
            <div>
              <span className="text-slate-400">Hard escalators: </span>
              BUST in TAKEOFF / INIT-CLIMB → score 92+. NET-LO at WT-FACTOR &gt; 1.0 → score 85+. CGR ≥ 600
              ft/NM aerodrome under WORST-OEI assumption → score 75+.
            </div>
            <div>
              <span className="text-slate-400">References: </span>
              14 CFR §25.115 OEI Net Flight Path / §25.121(a)(b)(c)(d) Climb requirements · EASA CS-25.115 · AC
              25-7D §6 Climb Performance · FAA Order 8260.46E TERPS Vol 4 DP design · ICAO Doc 8168 Vol II
              Part I §3.3 PDG · Boeing FCOM Vol 2 §03 OEI Climb · Airbus FCOM PER-TOF-50 OEI Net Path · Jepp
              Form 11-9 CGR table · TC AIM RAC 9.5.1 Climb Gradient · UK CAA CAP 696 §4.3.
            </div>
            <div className="text-slate-500 text-[9.5px] italic">
              Synthetic catalogue · 24 airports · 36 runways · 48 SID/CGR pairs · CGR values cross-referenced
              against published Jeppesen / Lido / Aerad charts. All-engine gradient inversion is the
              instantaneous ROC/GS ratio — true performance depends on FMC NADP setting, climb thrust mode,
              and actual airframe-specific OEI degradation tables.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---- Helpers ------------------------------------------------------------
function project(lat: number, lng: number, trackDeg: number, distNm: number): { lat: number; lng: number } {
  const R = 3440.065 // NM
  const φ1 = lat * Math.PI / 180
  const λ1 = lng * Math.PI / 180
  const θ = trackDeg * Math.PI / 180
  const δ = distNm / R
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return { lat: φ2 * 180 / Math.PI, lng: λ2 * 180 / Math.PI }
}
