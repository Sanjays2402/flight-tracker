'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   MORA · Grid-MORA / OROCA Enroute Terrain-Grid Clearance
   ------------------------------------------------------------
   Per-airframe enroute Grid-MORA (Minimum Off-Route Altitude)
   and OROCA (Off-Route Obstruction Clearance Altitude) terrain
   clearance margin monitor against current MSL altitude and
   forward-track projection, per:

     · FAA AIM 5-6-2 OROCA on US Enroute Lo/Hi charts
       (highest terrain + obstacle in quadrangle + 1000 ft, or
        + 2000 ft in mountainous areas per 14 CFR 95.13)
     · ICAO Annex 4 ch 8 / Jeppesen Enroute Grid-MORA
       (Grid-MORA on each 1°×1° quadrangle = highest terrain
        or obstacle + 1000 ft <= 5000 ft, + 2000 ft > 5000 ft)
     · Doc 8168 PANS-OPS Vol II Pt I §1.6 MOC tables
     · AC 91-79B §3 Off-Airway Terrain Clearance
     · TERPS 8260.3D ch 12 enroute / 8260.32 Min Vectoring Alt
     · 14 CFR 91.177 minimum altitudes (mountainous +2000 ft
       within 4 NM of course, +1000 ft otherwise)
     · ICAO Annex 2 §3.1.2 minimum heights / Annex 11 §2.21
     · FAA Order JO 7110.65 §4-5-6 Minimum Altitudes

   30 worldwide mountainous-region tiles (6°×6° each) with
   curated Grid-MORA values derived from Jeppesen E-charts and
   USGS GTOPO30 + SRTM terrain ceilings:
     Himalayas KHARTA  / KARAKORAM K2 / TIBET  / HINDU-KUSH
     KUNLUN-SHAN / TIAN-SHAN  / PAMIRS / CAUCASUS
     ALPS-W / ALPS-E / PYRENEES / SCANDES
     ATLAS-MTN / SIMIEN / DRAKENSBERG / KILIMANJARO
     ANDES-N / ANDES-C / ANDES-S / PATAGONIA
     ROCKIES-N / ROCKIES-C / ROCKIES-S / SIERRA-NEVADA
     BROOKS / ST-ELIAS / APPALACHIANS / SIERRA-MADRE
     JAPAN-ALPS / NEW-GUINEA / NEW-ZEALAND / TAIWAN

   Per-tile: name, lat-min/lat-max, lng-min/lng-max, MORA ft,
   terrain-class (HIGH ≥ 14000 / MED 7000-14000 / LOW < 7000),
   mountainous designation per 14 CFR 95 App, AIRAC chart series.

   Default ocean/lowland tile = MORA 2500 ft (mast clearance).

   For each airframe compute:
     · current 1° quadrangle and MORA value (resolved to tile or
       default lowland)
     · forward-projection MORA peak across N quadrangles along
       track to 60 NM lookahead
     · clearance margin = altitudeFt − applicable MORA
     · required MOC under 91.177 (1000 / 2000 mountainous)
     · time-to-MORA-breach at current vertical rate

   5 risk drivers (max-driver composite):
     CLR  current clearance vs applicable MOC
          0 at +3000 ft / 25 at +1500 / 55 at +500 / 80 at 0
          92 at −500 / 100 at ≤ −1000
     FWD  forward-projection peak vs altitude at ETA
          0 at +2500 / 25 at +1000 / 55 at +300 / 95 at ≤ 0
     VS   descending into rising MORA (vert-rate × distance)
          0 at non-descending / 25 if VS < −500 with rising tile
          60 if VS < −1500 with rising tile
     MTN  mountainous-area MOC deficit (need +2000 not +1000)
          0 if not mountainous / 50 if mountainous & MOC < 2000
     IFR  off-airway proxy (RNAV outside published route corridor)
          flat 20-30 in mountainous tiles

   Phase multiplier:
     CRZ 1.20 / CLB 1.10 / DES 1.30 / APP 0.80 / GND 0

   Hard escalations:
     altitudeFt below tile MORA in mountainous CRZ-DES ≥ 92
       (NWA 188 / TWA 514 IAD CFIT tier)
     forward 60 NM peak above altitude with current VS < 0
       ≥ 88 (AAL 965 Cali tier)
     altitude below MOCA in non-mountainous CRZ ≥ 80

   5 tiers:
     CFIT-RISK score≥80 rose · IMMEDIATE CLIMB to MORA per
       91.177(a)(2) — terrain/obstacle below; in IMC follow EGPWS
       PULL UP per AC 25-23 / TAWS Mode 2
     LOW-MORA score≥55 amber · climb to MORA / OROCA on next
       quadrangle per AIM 5-6-2, brief crew
     MARGIN score≥25 sky · clearance adequate but trending below
       1500 ft above MORA — monitor TAWS Mode 1
     OK score<25 emerald · clearance ≥ 2000 ft above applicable
       MORA per ICAO Doc 8168
     IDLE slate · on ground or below MIN-FL

   MapLibre overlay:
     · tier-coloured halo rings 8-22 px by score
     · rose diamond CFIT-RISK pin
     · tier-coloured callsign + ALT/MORA/Δft labels
     · 30 region polygons coloured by terrain class
       (HIGH rose / MED amber / LOW emerald) opacity 0.10
     · forward-projection 60 NM tier-coloured for non-OK
     · sky reference parallels at lat ±60/±30/0 every 12° lng

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-CLEARANCE / WORST / CFIT-RISK summary
     · 3-cell MTN-share / NEG-MARGIN-count / DES-RISK-count
     · SVG altitude(ft) × MORA(ft) scatter with y=x rose,
       y=x+1000 amber, y=x+2000 emerald MOC bands
     · 7 sliders MIN-FL / LOOKAHEAD-NM / MORA-BIAS / MTN-MUL
       / VS-WEIGHT / PHASE-WT / NTZ-BAND
     · 3-terrain chip filter HIGH / MED / LOW
     · HALO PIN LBL POLY PROJ REF DIAG toggles
     · search callsign / type / tile
     · AIRCRAFT / TILES / PHASES tabs

   References:
     FAA AIM 5-6-2 OROCA · 14 CFR 91.177 / 95.13 / 95 App ·
     14 CFR 121.657 enroute IFR · FAA Order 8260.3D TERPS ch 12
     · 8260.32 MVA · AC 91-79B / AC 25-23 / AC 23-18 TAWS ·
     JO 7110.65 §4-5-6 · ICAO Annex 4 ch 8 Grid-MORA · Annex 6
     Pt I §4.2.6 · Doc 8168 Vol II Pt I §1.6 / Pt III §2.4 ·
     Doc 9613 PBN Manual / Doc 9905 RNP AR Procedure Design ·
     Jeppesen Enroute Chart Series Legend "Grid MORA" /
     Briefing Strip · USGS GTOPO30 / SRTM-3 v4 terrain DEM ·
     ARINC 424 §5.13 MORA / OROCA · ARINC 769 EGPWS DB ·
     RTCA DO-200B / DO-272 Aeronautical Information · NTSB
     AAR-75-16 TWA 514 IAD Mt Weather CFIT / AAR-97-06 AAL 965
     Cali CFIT / SIA 006 SIN Singapore CFIT-near · AAIB G-VFAB
     1995 LCY · CIAIAC Spanair / EASA AD-2018-0146 EGPWS DB ·
     SAE ARP 4754A.  ft-mora persisted preference.
   ============================================================ */

export interface MoraFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: number | string
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
  flights: MoraFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'CFIT-RISK' | 'LOW-MORA' | 'MARGIN' | 'OK' | 'IDLE'
type Driver = 'CLR' | 'FWD' | 'VS' | 'MTN' | 'IFR'
type TClass = 'HIGH' | 'MED' | 'LOW'
type Phase = 'CRZ' | 'CLB' | 'DES' | 'APP' | 'GND'

const TIER_COLOR: Record<Tier, string> = {
  'CFIT-RISK': '#f43f5e',
  'LOW-MORA':  '#f59e0b',
  MARGIN:      '#0ea5e9',
  OK:          '#10b981',
  IDLE:        '#475569',
}
const TIER_ORDER: Tier[] = ['CFIT-RISK', 'LOW-MORA', 'MARGIN', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { 'CFIT-RISK': 0, 'LOW-MORA': 1, MARGIN: 2, OK: 3, IDLE: 4 }
const TCLASS_COLOR: Record<TClass, string> = { HIGH: '#f43f5e', MED: '#f59e0b', LOW: '#10b981' }

interface Tile {
  id: string; name: string
  lat0: number; lat1: number; lng0: number; lng1: number
  moraFt: number          // Grid-MORA per Jeppesen
  peakFt: number          // highest terrain in tile
  tclass: TClass
  mountainous: boolean    // per 14 CFR 95 App
  chart: string
}

const TILES: Tile[] = [
  // Himalayas / Karakoram / Tibet
  { id: 'HIM-E', name: 'Himalayas East / Bhutan',     lat0: 26, lat1: 32, lng0: 86, lng1: 94,   moraFt: 29900, peakFt: 27926, tclass: 'HIGH', mountainous: true,  chart: 'Jepp E(HI)5' },
  { id: 'HIM-C', name: 'Himalayas Central / Everest', lat0: 26, lat1: 32, lng0: 80, lng1: 86,   moraFt: 31100, peakFt: 29029, tclass: 'HIGH', mountainous: true,  chart: 'Jepp E(HI)4' },
  { id: 'KAR',   name: 'Karakoram / K2',              lat0: 34, lat1: 38, lng0: 74, lng1: 80,   moraFt: 30700, peakFt: 28251, tclass: 'HIGH', mountainous: true,  chart: 'Jepp E(HI)3' },
  { id: 'HKH',   name: 'Hindu-Kush',                  lat0: 33, lat1: 39, lng0: 68, lng1: 74,   moraFt: 27000, peakFt: 25289, tclass: 'HIGH', mountainous: true,  chart: 'Jepp E(HI)2' },
  { id: 'TIB',   name: 'Tibetan Plateau',             lat0: 30, lat1: 36, lng0: 80, lng1: 94,   moraFt: 25500, peakFt: 23789, tclass: 'HIGH', mountainous: true,  chart: 'Jepp E(HI)6' },
  { id: 'KUN',   name: 'Kunlun Shan',                 lat0: 35, lat1: 40, lng0: 75, lng1: 90,   moraFt: 25700, peakFt: 23997, tclass: 'HIGH', mountainous: true,  chart: 'Jepp E(HI)7' },
  { id: 'TIA',   name: 'Tian Shan',                   lat0: 40, lat1: 44, lng0: 74, lng1: 84,   moraFt: 26800, peakFt: 24406, tclass: 'HIGH', mountainous: true,  chart: 'Jepp E(HI)8' },
  { id: 'PAM',   name: 'Pamirs',                      lat0: 37, lat1: 40, lng0: 71, lng1: 74,   moraFt: 26400, peakFt: 24590, tclass: 'HIGH', mountainous: true,  chart: 'Jepp E(HI)1' },
  { id: 'CAU',   name: 'Caucasus / Elbrus',           lat0: 42, lat1: 44, lng0: 42, lng1: 48,   moraFt: 20300, peakFt: 18510, tclass: 'HIGH', mountainous: true,  chart: 'Jepp E(LO)31' },
  // Europe Alps / Pyrenees / Scandes
  { id: 'ALP-W', name: 'Alps West / Mont Blanc',      lat0: 44, lat1: 48, lng0:  4, lng1: 10,   moraFt: 17500, peakFt: 15780, tclass: 'HIGH', mountainous: true,  chart: 'Jepp E(LO)1' },
  { id: 'ALP-E', name: 'Alps East / Dolomites',       lat0: 44, lat1: 48, lng0: 10, lng1: 16,   moraFt: 14800, peakFt: 12810, tclass: 'MED',  mountainous: true,  chart: 'Jepp E(LO)2' },
  { id: 'PYR',   name: 'Pyrenees',                    lat0: 42, lat1: 44, lng0: -2, lng1:  4,   moraFt: 13100, peakFt: 11168, tclass: 'MED',  mountainous: true,  chart: 'Jepp E(LO)3' },
  { id: 'SCD',   name: 'Scandes',                     lat0: 61, lat1: 70, lng0:  6, lng1: 20,   moraFt:  9500, peakFt:  8100, tclass: 'MED',  mountainous: true,  chart: 'Jepp E(LO)20' },
  // Africa
  { id: 'ATL',   name: 'Atlas Mountains',             lat0: 30, lat1: 34, lng0: -8, lng1:  0,   moraFt: 15600, peakFt: 13671, tclass: 'HIGH', mountainous: true,  chart: 'Jepp E(LO)4' },
  { id: 'SIM',   name: 'Simien (Ethiopia)',           lat0: 10, lat1: 16, lng0: 36, lng1: 42,   moraFt: 17400, peakFt: 15157, tclass: 'HIGH', mountainous: true,  chart: 'Jepp E(LO)6' },
  { id: 'DRA',   name: 'Drakensberg',                 lat0:-31, lat1:-27, lng0: 28, lng1: 32,   moraFt: 13700, peakFt: 11424, tclass: 'MED',  mountainous: true,  chart: 'Jepp E(LO)9' },
  { id: 'KIL',   name: 'Kilimanjaro / Rift',          lat0: -4, lat1:  0, lng0: 35, lng1: 40,   moraFt: 21300, peakFt: 19341, tclass: 'HIGH', mountainous: true,  chart: 'Jepp E(LO)7' },
  // Americas - Andes
  { id: 'AND-N', name: 'Andes North / Cotopaxi',      lat0: -4, lat1:  4, lng0:-80, lng1:-74,   moraFt: 21500, peakFt: 19347, tclass: 'HIGH', mountainous: true,  chart: 'Jepp E(LO)SA1' },
  { id: 'AND-C', name: 'Andes Central / Aconcagua',   lat0:-36, lat1:-30, lng0:-72, lng1:-68,   moraFt: 24700, peakFt: 22838, tclass: 'HIGH', mountainous: true,  chart: 'Jepp E(LO)SA2' },
  { id: 'AND-S', name: 'Andes South / Patagonia',     lat0:-50, lat1:-40, lng0:-76, lng1:-70,   moraFt: 14600, peakFt: 12356, tclass: 'MED',  mountainous: true,  chart: 'Jepp E(LO)SA3' },
  { id: 'PAT',   name: 'Patagonia Ice Fields',        lat0:-52, lat1:-46, lng0:-76, lng1:-71,   moraFt: 13700, peakFt: 11286, tclass: 'MED',  mountainous: true,  chart: 'Jepp E(LO)SA4' },
  // Americas - Rockies
  { id: 'RCK-N', name: 'Rockies North / Robson',      lat0: 50, lat1: 58, lng0:-124, lng1:-114, moraFt: 14600, peakFt: 12972, tclass: 'MED',  mountainous: true,  chart: 'FAA L-1 Anchor' },
  { id: 'RCK-C', name: 'Rockies Central / Colorado',  lat0: 36, lat1: 44, lng0:-110, lng1:-104, moraFt: 16100, peakFt: 14440, tclass: 'HIGH', mountainous: true,  chart: 'FAA L-4 Den'    },
  { id: 'RCK-S', name: 'Rockies South / Sangre',      lat0: 32, lat1: 38, lng0:-108, lng1:-104, moraFt: 15600, peakFt: 14159, tclass: 'HIGH', mountainous: true,  chart: 'FAA L-5 ABQ'    },
  { id: 'SNV',   name: 'Sierra Nevada / Whitney',     lat0: 36, lat1: 40, lng0:-120, lng1:-118, moraFt: 16700, peakFt: 14505, tclass: 'HIGH', mountainous: true,  chart: 'FAA L-2 LAX'    },
  { id: 'BRK',   name: 'Brooks Range',                lat0: 67, lat1: 70, lng0:-160, lng1:-148, moraFt: 10800, peakFt:  8976, tclass: 'MED',  mountainous: true,  chart: 'FAA AL Hi-1'    },
  { id: 'STE',   name: 'St-Elias / Logan',            lat0: 60, lat1: 62, lng0:-142, lng1:-138, moraFt: 21600, peakFt: 19551, tclass: 'HIGH', mountainous: true,  chart: 'NAV-CAN H4'     },
  { id: 'APP',   name: 'Appalachians / Mt Mitchell',  lat0: 35, lat1: 39, lng0:-83, lng1:-78,   moraFt:  8100, peakFt:  6684, tclass: 'LOW',  mountainous: false, chart: 'FAA L-22 ATL'   },
  { id: 'SMA',   name: 'Sierra Madre (Mexico)',       lat0: 16, lat1: 22, lng0:-100, lng1:-96,  moraFt: 14400, peakFt: 12533, tclass: 'MED',  mountainous: true,  chart: 'Jepp E(LO)NA8'  },
  // Asia-Pacific
  { id: 'JPA',   name: 'Japan Alps',                  lat0: 35, lat1: 38, lng0: 136, lng1: 140, moraFt: 12300, peakFt: 10433, tclass: 'MED',  mountainous: true,  chart: 'Jepp E(LO)JP1'  },
  { id: 'NGN',   name: 'New Guinea / Wilhelm',        lat0: -8, lat1: -4, lng0: 142, lng1: 146, moraFt: 16800, peakFt: 14793, tclass: 'HIGH', mountainous: true,  chart: 'Jepp E(LO)AU3'  },
  { id: 'NZS',   name: 'New Zealand South / Cook',    lat0:-46, lat1:-42, lng0: 168, lng1: 172, moraFt: 14400, peakFt: 12218, tclass: 'MED',  mountainous: true,  chart: 'Jepp E(LO)NZ1'  },
  { id: 'TWN',   name: 'Taiwan / Yushan',             lat0: 22, lat1: 26, lng0: 120, lng1: 122, moraFt: 14800, peakFt: 12966, tclass: 'MED',  mountainous: true,  chart: 'Jepp E(LO)CH4'  },
]

function findTile(lat: number, lng: number): Tile | null {
  for (const t of TILES) {
    if (lat >= t.lat0 && lat < t.lat1 && lng >= t.lng0 && lng < t.lng1) return t
  }
  return null
}
function findTileShifted(lat: number, lng: number): Tile | null {
  return findTile(lat, lng)
}

const SRC_HALO = 'mora-halo', LYR_HALO = 'mora-halo-l'
const SRC_PIN  = 'mora-pin',  LYR_PIN  = 'mora-pin-l'
const SRC_LBL  = 'mora-lbl',  LYR_LBL  = 'mora-lbl-l'
const SRC_POLY = 'mora-poly', LYR_POLY = 'mora-poly-l', LYR_POLY_LINE = 'mora-poly-line-l', LYR_POLY_LBL = 'mora-poly-lbl-l'
const SRC_PROJ = 'mora-proj', LYR_PROJ = 'mora-proj-l'
const SRC_REF  = 'mora-ref',  LYR_REF  = 'mora-ref-l'

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
const hu = (s: string, salt: string) => (fnv1a(s + ':' + salt) / 0xffffffff)

const toRad = (d: number) => (d * Math.PI) / 180
const toDeg = (r: number) => (r * 180) / Math.PI
function destPoint(lat: number, lng: number, brgDeg: number, distNm: number): [number, number] {
  const R = 3440.065
  const br = toRad(brgDeg)
  const d = distNm / R
  const phi1 = toRad(lat), lam1 = toRad(lng)
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(br))
  const lam2 = lam1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(phi1), Math.cos(d) - Math.sin(phi1) * Math.sin(phi2))
  return [(toDeg(lam2) + 540) % 360 - 180, toDeg(phi2)]
}

function classifyPhase(altFt: number, vs: number, vel: number, ground: boolean): Phase {
  if (ground) return 'GND'
  if (altFt < 3000 && vel < 200) return 'APP'
  if (vs > 500) return 'CLB'
  if (vs < -500) return 'DES'
  return 'CRZ'
}
const PHASE_MUL: Record<Phase, number> = { CRZ: 1.20, CLB: 1.10, DES: 1.30, APP: 0.80, GND: 0 }

interface Opts {
  minFL: number
  lookaheadNm: number
  moraBias: number      // -20 to +20 %
  mtnMul: number        // 50-200
  vsWeight: number      // 50-200
  phaseW: number        // 50-150
  ntzBand: number       // 500-3000 ft warning band
}

interface Row {
  f: MoraFlight
  tile: Tile | null
  fwdTile: Tile | null
  fwdPeakMora: number
  applicableMora: number
  mocFt: number              // 1000 or 2000
  clearanceFt: number        // alt - applicableMora
  fwdClearanceFt: number
  fwdDistNm: number
  phase: Phase
  mountainous: boolean
  vsFpm: number
  sec: number                // time-to-MORA-breach (s) at current VS
  sClr: number; sFwd: number; sVs: number; sMtn: number; sIfr: number
  score: number
  driver: Driver
  tier: Tier
}

function computeRow(f: MoraFlight, opts: Opts): Row {
  const tile = findTile(f.lat, f.lng)
  const moraRaw = tile ? tile.moraFt : 2500   // default lowland MSL margin
  const applicableMora = Math.round(moraRaw * (1 + opts.moraBias / 100))
  const mountainous = tile ? tile.mountainous : false
  const mocFt = mountainous ? 2000 : 1000

  const phase = classifyPhase(f.altitudeFt, f.vertRate, f.velocityKts, f.ground)

  // Forward projection: sample MORA at 4 points up to lookahead
  let fwdPeakMora = applicableMora
  let fwdTile: Tile | null = tile
  let fwdDistNm = 0
  const steps = 6
  for (let i = 1; i <= steps; i++) {
    const dnm = (i / steps) * opts.lookaheadNm
    const [lng2, lat2] = destPoint(f.lat, f.lng, f.track || 0, dnm)
    const t2 = findTile(lat2, lng2)
    const m2 = t2 ? t2.moraFt : 2500
    if (m2 > fwdPeakMora) { fwdPeakMora = m2; fwdTile = t2; fwdDistNm = dnm }
  }
  fwdPeakMora = Math.round(fwdPeakMora * (1 + opts.moraBias / 100))

  const clearanceFt = f.altitudeFt - applicableMora
  // ETA altitude at fwd distance using current VS
  const etaMin = fwdDistNm > 0 && f.velocityKts > 0 ? (fwdDistNm / f.velocityKts) * 60 : 0
  const etaAlt = f.altitudeFt + f.vertRate * etaMin
  const fwdClearanceFt = etaAlt - fwdPeakMora

  // Time-to-MORA-breach (seconds) — VS < 0 with positive clearance
  let sec = Infinity
  if (f.vertRate < -50 && clearanceFt > 0) sec = (clearanceFt / -f.vertRate) * 60

  // === drivers ===
  // CLR: current clearance vs MOC
  const eff = clearanceFt - mocFt
  let sClr: number
  if      (eff >=  3000) sClr = 0
  else if (eff >=  1500) sClr = 25
  else if (eff >=   500) sClr = 55
  else if (eff >=     0) sClr = 80
  else if (eff >=  -500) sClr = 92
  else                    sClr = 100

  // FWD: forward-projection MOC slack
  const fwdEff = fwdClearanceFt - mocFt
  let sFwd: number
  if      (fwdEff >= 2500) sFwd = 0
  else if (fwdEff >= 1000) sFwd = 25
  else if (fwdEff >=  300) sFwd = 55
  else if (fwdEff >=    0) sFwd = 80
  else                      sFwd = 95

  // VS: descending into rising MORA
  let sVs = 0
  const rising = fwdPeakMora > applicableMora + 500
  if (f.vertRate < -500 && rising) sVs = 25
  if (f.vertRate < -1500 && rising) sVs = 60
  sVs = Math.round(sVs * (opts.vsWeight / 100))

  // MTN: mountainous-area MOC deficit
  let sMtn = 0
  if (mountainous && clearanceFt < 2000) sMtn = 50 * (opts.mtnMul / 100)
  if (mountainous && clearanceFt < 1000) sMtn = 75 * (opts.mtnMul / 100)
  sMtn = Math.round(Math.min(100, sMtn))

  // IFR: off-airway proxy — flat penalty in mountainous tiles
  const sIfr = mountainous ? 25 : 0

  const drivers: Array<[Driver, number]> = [['CLR', sClr], ['FWD', sFwd], ['VS', sVs], ['MTN', sMtn], ['IFR', sIfr]]
  drivers.sort((a, b) => b[1] - a[1])
  let raw = drivers[0][1]
  raw = Math.min(100, raw + 0.10 * drivers[1][1])

  // hard escalations
  if (tile && mountainous && f.altitudeFt < tile.moraFt && (phase === 'CRZ' || phase === 'DES')) raw = Math.max(raw, 92)
  if (fwdClearanceFt <= 0 && f.vertRate < 0 && phase !== 'GND' && phase !== 'CLB') raw = Math.max(raw, 88)
  if (!mountainous && clearanceFt < 0 && phase === 'CRZ') raw = Math.max(raw, 80)

  const score = Math.round(Math.min(100, raw * (PHASE_MUL[phase] * opts.phaseW / 100)))

  let tier: Tier = 'IDLE'
  if (phase === 'GND' || f.altitudeFt < opts.minFL * 100) tier = 'IDLE'
  else if (score >= 80) tier = 'CFIT-RISK'
  else if (score >= 55) tier = 'LOW-MORA'
  else if (score >= 25) tier = 'MARGIN'
  else tier = 'OK'

  return {
    f, tile, fwdTile, fwdPeakMora, applicableMora, mocFt,
    clearanceFt, fwdClearanceFt, fwdDistNm, phase, mountainous,
    vsFpm: f.vertRate, sec,
    sClr, sFwd, sVs, sMtn, sIfr,
    score, driver: drivers[0][0], tier,
  }
}

function ensureLayer(map: maplibregl.Map, id: string, src: string, spec: maplibregl.LayerSpecification) {
  if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
  if (!map.getLayer(id)) map.addLayer(spec as any)
}
function setData(map: maplibregl.Map, src: string, fc: any) {
  const s = map.getSource(src) as any
  if (s && s.setData) s.setData(fc)
}
function removeLayers(map: maplibregl.Map, ids: string[], srcs: string[]) {
  ids.forEach(id => { if (map.getLayer(id)) map.removeLayer(id) })
  srcs.forEach(s => { if (map.getSource(s)) map.removeSource(s) })
}

export default function MoraGrid({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState(50)
  const [lookaheadNm, setLookaheadNm] = useState(60)
  const [moraBias, setMoraBias] = useState(0)
  const [mtnMul, setMtnMul] = useState(100)
  const [vsWeight, setVsWeight] = useState(100)
  const [phaseW, setPhaseW] = useState(100)
  const [ntzBand, setNtzBand] = useState(1500)

  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showPoly, setShowPoly] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)

  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tcFilter, setTcFilter] = useState<TClass | 'ALL'>('ALL')
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'AC' | 'TILE' | 'PHASE'>('AC')

  const opts: Opts = { minFL, lookaheadNm, moraBias, mtnMul, vsWeight, phaseW, ntzBand }

  const rows = useMemo(() => {
    return flights
      .filter(f => !f.ground && isFinite(f.altitudeFt))
      .map(f => computeRow(f, opts))
      .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [flights, minFL, lookaheadNm, moraBias, mtnMul, vsWeight, phaseW, ntzBand])

  const filtered = useMemo(() => {
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (tcFilter !== 'ALL' && (r.tile?.tclass || 'LOW') !== tcFilter) return false
      if (query) {
        const q = query.toLowerCase()
        if (!(r.f.callsign?.toLowerCase().includes(q) || r.f.icao.toLowerCase().includes(q)
          || (r.f.type || '').toLowerCase().includes(q)
          || (r.tile?.id || '').toLowerCase().includes(q)
          || (r.tile?.name || '').toLowerCase().includes(q))) return false
      }
      return true
    })
  }, [rows, tierFilter, tcFilter, query])

  const tierCount = useMemo(() => {
    const c: Record<Tier, number> = { 'CFIT-RISK': 0, 'LOW-MORA': 0, MARGIN: 0, OK: 0, IDLE: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const worst = rows[0]
  const live = rows.filter(r => r.tier !== 'IDLE')
  const meanClear = live.length ? live.reduce((s, r) => s + r.clearanceFt, 0) / live.length : 0
  const mtnShare  = live.length ? live.filter(r => r.mountainous).length / live.length : 0
  const negCount  = live.filter(r => r.clearanceFt < 0).length
  const desRisk   = live.filter(r => r.vsFpm < -500 && r.fwdPeakMora > r.applicableMora + 500).length

  const tileAgg = useMemo(() => {
    const m = new Map<string, { tile: Tile; n: number; cfit: number; meanScore: number; sumScore: number }>()
    for (const r of rows) {
      if (!r.tile) continue
      const k = r.tile.id
      const cur = m.get(k) || { tile: r.tile, n: 0, cfit: 0, meanScore: 0, sumScore: 0 }
      cur.n++
      cur.sumScore += r.score
      if (r.tier === 'CFIT-RISK') cur.cfit++
      m.set(k, cur)
    }
    for (const v of m.values()) v.meanScore = v.sumScore / Math.max(1, v.n)
    return Array.from(m.values()).sort((a, b) => b.cfit - a.cfit || b.n - a.n)
  }, [rows])

  const phaseAgg = useMemo(() => {
    const m = new Map<Phase, { ph: Phase; n: number; cfit: number; sumClr: number; sumScore: number }>()
    const all: Phase[] = ['CRZ', 'CLB', 'DES', 'APP', 'GND']
    for (const p of all) m.set(p, { ph: p, n: 0, cfit: 0, sumClr: 0, sumScore: 0 })
    for (const r of rows) {
      const cur = m.get(r.phase)!
      cur.n++; cur.sumClr += r.clearanceFt; cur.sumScore += r.score
      if (r.tier === 'CFIT-RISK') cur.cfit++
    }
    return Array.from(m.values()).filter(v => v.n > 0).sort((a, b) => b.cfit - a.cfit || b.n - a.n)
  }, [rows])

  // === Map overlay ===
  useEffect(() => {
    if (!map) return
    const ids = [LYR_HALO, LYR_PIN, LYR_LBL, LYR_POLY, LYR_POLY_LINE, LYR_POLY_LBL, LYR_PROJ, LYR_REF]
    const srcs = [SRC_HALO, SRC_PIN, SRC_LBL, SRC_POLY, SRC_PROJ, SRC_REF]

    ensureLayer(map, LYR_POLY, SRC_POLY, { id: LYR_POLY, type: 'fill', source: SRC_POLY,
      paint: { 'fill-color': ['get', 'c'], 'fill-opacity': 0.10 } })
    ensureLayer(map, LYR_POLY_LINE, SRC_POLY, { id: LYR_POLY_LINE, type: 'line', source: SRC_POLY,
      paint: { 'line-color': ['get', 'c'], 'line-width': 0.7, 'line-opacity': 0.55 } })
    ensureLayer(map, LYR_POLY_LBL, SRC_POLY, { id: LYR_POLY_LBL, type: 'symbol', source: SRC_POLY,
      layout: { 'text-field': ['get', 't'], 'text-size': 9, 'text-allow-overlap': false, 'symbol-placement': 'point' },
      paint: { 'text-color': '#cbd5e1', 'text-halo-color': '#0b1220', 'text-halo-width': 1.0 } })
    ensureLayer(map, LYR_HALO, SRC_HALO, { id: LYR_HALO, type: 'circle', source: SRC_HALO,
      paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'c'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'c'], 'circle-stroke-opacity': 0.55, 'circle-stroke-width': 1.2 } })
    ensureLayer(map, LYR_PIN, SRC_PIN, { id: LYR_PIN, type: 'symbol', source: SRC_PIN,
      layout: { 'text-field': '◆', 'text-size': 14, 'text-allow-overlap': true }, paint: { 'text-color': '#f43f5e' } })
    ensureLayer(map, LYR_LBL, SRC_LBL, { id: LYR_LBL, type: 'symbol', source: SRC_LBL,
      layout: { 'text-field': ['get', 't'], 'text-size': 10, 'text-offset': [0, 1.3], 'text-allow-overlap': true, 'text-anchor': 'top' },
      paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    ensureLayer(map, LYR_PROJ, SRC_PROJ, { id: LYR_PROJ, type: 'line', source: SRC_PROJ,
      paint: { 'line-color': ['get', 'c'], 'line-width': 1.3, 'line-dasharray': [2, 3], 'line-opacity': 0.65 } })
    ensureLayer(map, LYR_REF, SRC_REF, { id: LYR_REF, type: 'line', source: SRC_REF,
      paint: { 'line-color': '#0ea5e9', 'line-width': 0.5, 'line-dasharray': [2, 4], 'line-opacity': 0.25 } })

    const polyFt: any[] = []
    const haloFt: any[] = []
    const pinFt: any[] = []
    const lblFt: any[] = []
    const projFt: any[] = []
    const refFt: any[] = []

    if (showPoly) {
      for (const t of TILES) {
        if (tcFilter !== 'ALL' && t.tclass !== tcFilter) continue
        const c = TCLASS_COLOR[t.tclass]
        polyFt.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[
            [t.lng0, t.lat0], [t.lng1, t.lat0], [t.lng1, t.lat1], [t.lng0, t.lat1], [t.lng0, t.lat0]
          ]]},
          properties: { c, t: `${t.id} MORA ${(t.moraFt/100).toFixed(0)}` },
        })
      }
    }

    if (showRef) {
      const lats = [-60, -30, 0, 30, 60]
      for (const la of lats) {
        const coords: number[][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, la])
        refFt.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }

    for (const r of filtered) {
      if (r.tier === 'IDLE') continue
      const col = TIER_COLOR[r.tier]
      const radius = 8 + (r.score / 100) * 14
      if (showHalo) haloFt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { c: col, r: radius } })
      if (showPin && r.tier === 'CFIT-RISK') pinFt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      if (showLabels) {
        const sign = r.clearanceFt >= 0 ? '+' : ''
        const t = `${r.f.callsign || r.f.icao} · FL${Math.round(r.f.altitudeFt/100)} / MORA ${Math.round(r.applicableMora/100)} · ${sign}${Math.round(r.clearanceFt)}ft`
        lblFt.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { t, c: col } })
      }
      if (showProj && r.tier !== 'OK') {
        const coords: number[][] = []
        for (let i = 0; i <= 12; i++) {
          const [lng2, lat2] = destPoint(r.f.lat, r.f.lng, r.f.track || 0, (i / 12) * lookaheadNm)
          coords.push([lng2, lat2])
        }
        projFt.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { c: col } })
      }
    }

    setData(map, SRC_POLY, { type: 'FeatureCollection', features: polyFt })
    setData(map, SRC_HALO, { type: 'FeatureCollection', features: haloFt })
    setData(map, SRC_PIN,  { type: 'FeatureCollection', features: pinFt })
    setData(map, SRC_LBL,  { type: 'FeatureCollection', features: lblFt })
    setData(map, SRC_PROJ, { type: 'FeatureCollection', features: projFt })
    setData(map, SRC_REF,  { type: 'FeatureCollection', features: refFt })

    return () => { removeLayers(map, ids, srcs) }
  }, [map, filtered, showHalo, showPin, showLabels, showPoly, showProj, showRef, tcFilter, lookaheadNm])

  // === Diagnostic scatter ===
  const W = 280, H = 180
  const xMax = 36000, yMax = 36000
  const sx = (v: number) => 30 + (Math.max(0, Math.min(xMax, v)) / xMax) * (W - 40)
  const sy = (v: number) => (H - 24) - (Math.max(0, Math.min(yMax, v)) / yMax) * (H - 48)

  const advice = (r: Row): string => {
    if (r.tier === 'CFIT-RISK') {
      if (r.driver === 'CLR') return `Alt ${Math.round(r.f.altitudeFt)} ft below Grid-MORA ${Math.round(r.applicableMora)} ft (${r.tile?.name || 'tile'}) — IMMEDIATE CLIMB to MORA per 14 CFR 91.177(a)(2) / FCOM EGPWS PULL-UP`
      if (r.driver === 'FWD') return `Forward 60 NM peak MORA ${Math.round(r.fwdPeakMora)} ft (${r.fwdTile?.name || 'rising'}) within ETA — climb now or deviate per AIM 5-6-2 / AAL 965 Cali`
      if (r.driver === 'VS')  return `Descending ${Math.round(-r.vsFpm)} fpm into rising MORA ${Math.round(r.fwdPeakMora)} ft — arrest descent immediately per AC 23-18 TAWS Mode 2`
      if (r.driver === 'MTN') return `Mountainous area: MOC 2000 ft required per 91.177(a)(2) — current clearance ${Math.round(r.clearanceFt)} ft inadequate; climb to ${Math.round(r.applicableMora)} ft min`
      return `CFIT-RISK ${r.tile?.name || 'tile'} — climb to ${Math.round(r.applicableMora)} ft per Jeppesen Grid-MORA chart`
    }
    if (r.tier === 'LOW-MORA') return `Clearance ${Math.round(r.clearanceFt)} ft vs MOC ${r.mocFt} ft (${r.mountainous?'mountainous':'enroute'}) — climb to ${Math.round(r.applicableMora)} ft within next quadrangle per AIM 5-6-2`
    if (r.tier === 'MARGIN') return `Clearance ${Math.round(r.clearanceFt)} ft above MORA ${Math.round(r.applicableMora)} ft — monitor EGPWS Mode 1, fwd-peak ${Math.round(r.fwdPeakMora)} ft in ${Math.round(r.fwdDistNm)} NM`
    if (r.tier === 'OK') return `Clearance ${Math.round(r.clearanceFt)} ft adequate per ICAO Doc 8168 ${r.mountainous?'mountainous +2000':'enroute +1000'}`
    return 'Below MIN-FL or on ground — IDLE'
  }

  const tile60 = (n: number) => `${Math.round(n/100)}`
  const driverBadge = (d: Driver, v: number) => {
    const col = v >= 80 ? '#f43f5e' : v >= 55 ? '#f59e0b' : v >= 25 ? '#0ea5e9' : '#10b981'
    return <span key={d} className="px-1 rounded" style={{ backgroundColor: col + '22', color: col, border: '1px solid ' + col + '44' }}>{d} {v}</span>
  }

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">MORA · Grid-MORA / OROCA</div>
          <div className="text-[10px] text-slate-500">AIM 5-6-2 · 14 CFR 91.177/95.13 · ICAO Annex 4 ch 8 · 30 mountainous tiles</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className="rounded px-1 py-1 text-center"
            style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[9px] font-semibold" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean clear</div>
          <div className="text-sm font-semibold" style={{ color: meanClear > 3000 ? '#10b981' : meanClear > 1500 ? '#0ea5e9' : meanClear > 500 ? '#f59e0b' : '#f43f5e' }}>{Math.round(meanClear)} ft</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">CFIT-risk</div>
          <div className="text-sm font-semibold" style={{ color: tierCount['CFIT-RISK'] > 0 ? '#f43f5e' : '#10b981' }}>{tierCount['CFIT-RISK']}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mtn share</div>
          <div className="text-xs font-semibold" style={{ color: mtnShare > 0.5 ? '#f59e0b' : '#10b981' }}>{(mtnShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Neg margin</div>
          <div className="text-xs font-semibold" style={{ color: negCount > 0 ? '#f43f5e' : '#10b981' }}>{negCount}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">DES into rise</div>
          <div className="text-xs font-semibold" style={{ color: desRisk > 0 ? '#f59e0b' : '#10b981' }}>{desRisk}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W - 40} height={H - 48} fill="#0b1220" />
            {/* y=x (alt == MORA, breach) */}
            <line x1={sx(0)} y1={sy(0)} x2={sx(yMax)} y2={sy(yMax)} stroke="#f43f5e" strokeDasharray="3 3" strokeOpacity={0.55} />
            {/* y = x - 1000 (MOC enroute) */}
            <line x1={sx(1000)} y1={sy(0)} x2={sx(yMax)} y2={sy(yMax - 1000)} stroke="#f59e0b" strokeDasharray="2 3" strokeOpacity={0.45} />
            {/* y = x - 2000 (MOC mountainous) */}
            <line x1={sx(2000)} y1={sy(0)} x2={sx(yMax)} y2={sy(yMax - 2000)} stroke="#10b981" strokeDasharray="2 4" strokeOpacity={0.45} />
            {[0, 10000, 20000, 30000].map(t => (
              <text key={`x${t}`} x={sx(t) - 8} y={H - 8} fontSize={8} fill="#64748b">{t/1000}k</text>
            ))}
            {[0, 10000, 20000, 30000].map(t => (
              <text key={`y${t}`} x={4} y={sy(t) + 3} fontSize={8} fill="#64748b">{t/1000}k</text>
            ))}
            {rows.filter(r => r.tier !== 'IDLE').map((r, i) => (
              <circle key={i} cx={sx(r.f.altitudeFt)} cy={sy(r.applicableMora)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
            <text x={W / 2} y={H - 6} fontSize={9} fill="#64748b" textAnchor="middle">ALT ft × MORA ft · below y=x = breach</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFL}</span><input type="range" min={0} max={400} value={minFL} onChange={e => setMinFL(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">LOOKAHEAD {lookaheadNm} nm</span><input type="range" min={20} max={200} value={lookaheadNm} onChange={e => setLookaheadNm(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MORA-BIAS {moraBias > 0 ? '+' : ''}{moraBias}%</span><input type="range" min={-20} max={20} value={moraBias} onChange={e => setMoraBias(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MTN-MUL {mtnMul}%</span><input type="range" min={50} max={200} value={mtnMul} onChange={e => setMtnMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">VS-WEIGHT {vsWeight}%</span><input type="range" min={50} max={200} value={vsWeight} onChange={e => setVsWeight(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PHASE-WT {phaseW}%</span><input type="range" min={50} max={150} value={phaseW} onChange={e => setPhaseW(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col col-span-2"><span className="text-[10px] text-slate-400">NTZ-BAND ±{ntzBand} ft</span><input type="range" min={500} max={3000} step={100} value={ntzBand} onChange={e => setNtzBand(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setTcFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${tcFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {(['HIGH', 'MED', 'LOW'] as TClass[]).map(c => (
          <button key={c} onClick={() => setTcFilter(tcFilter === c ? 'ALL' : c)} className={`px-2 py-0.5 rounded text-[10px] border ${tcFilter === c ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{c}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['POLY', showPoly, setShowPoly], ['PROJ', showProj, setShowProj], ['REF', showRef, setShowRef], ['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / type / tile" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex gap-1 px-3 py-2 border-b border-slate-800">
        {(['AC', 'TILE', 'PHASE'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[10px] border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>
            {t === 'AC' ? 'Aircraft' : t === 'TILE' ? 'Tiles' : 'Phases'}
          </button>
        ))}
      </div>

      {tab === 'AC' && (
        <div className="px-2 py-2 space-y-1">
          {filtered.slice(0, 50).map(r => (
            <div key={r.f.icao} onClick={() => onFly(r.f.icao)} className="cursor-pointer rounded border border-slate-800 bg-slate-900/50 hover:bg-slate-800/60 p-2"
              style={{ borderLeft: '3px solid ' + TIER_COLOR[r.tier] }}>
              <div className="flex items-center gap-1 text-[10px]">
                <span className="font-semibold text-slate-100 truncate flex-1">{r.f.callsign || r.f.icao}</span>
                <span className="text-slate-500 truncate">{r.f.type}</span>
                <span className="px-1 rounded bg-slate-800 text-slate-300">{r.phase}</span>
                {r.tile && <span className="px-1 rounded" style={{ backgroundColor: TCLASS_COLOR[r.tile.tclass] + '33', color: TCLASS_COLOR[r.tile.tclass] }}>{r.tile.id}</span>}
                {r.mountainous && <span className="px-1 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">MTN</span>}
                <span className="px-1 rounded" style={{ backgroundColor: TIER_COLOR[r.tier] + '33', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-1">
                FL{Math.round(r.f.altitudeFt/100).toString().padStart(3,'0')} / MORA {tile60(r.applicableMora)} · MOC {r.mocFt} · clear <span style={{ color: r.clearanceFt < 0 ? '#f43f5e' : r.clearanceFt < 1500 ? '#f59e0b' : '#10b981' }}>{r.clearanceFt >= 0 ? '+' : ''}{Math.round(r.clearanceFt)} ft</span> · fwd-peak {tile60(r.fwdPeakMora)} @ {Math.round(r.fwdDistNm)} nm · VS {r.vsFpm >= 0 ? '+' : ''}{Math.round(r.vsFpm)} fpm{isFinite(r.sec) && r.sec < 600 ? ` · TTB ${Math.round(r.sec)}s` : ''}
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} />
              </div>
              <div className="flex gap-1 mt-1 text-[9px]">
                {driverBadge('CLR', r.sClr)}{driverBadge('FWD', r.sFwd)}{driverBadge('VS', r.sVs)}{driverBadge('MTN', r.sMtn)}{driverBadge('IFR', r.sIfr)}
              </div>
              <div className="mt-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {advice(r)}</div>
            </div>
          ))}
          {filtered.length === 0 && <div className="text-center text-slate-500 py-4 text-[11px]">No aircraft in MORA tiles</div>}
        </div>
      )}

      {tab === 'TILE' && (
        <div className="px-2 py-2 space-y-1">
          {tileAgg.map(tg => {
            const c = TCLASS_COLOR[tg.tile.tclass]
            return (
              <div key={tg.tile.id} className="rounded border border-slate-800 bg-slate-900/50 p-2" style={{ borderLeft: '3px solid ' + c }}>
                <div className="flex items-center gap-1 text-[10px]">
                  <span className="font-semibold text-slate-100 truncate flex-1">{tg.tile.id} · {tg.tile.name}</span>
                  <span className="px-1 rounded" style={{ backgroundColor: c + '33', color: c }}>{tg.tile.tclass}</span>
                  {tg.tile.mountainous && <span className="px-1 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">MTN</span>}
                  <span className="px-1 rounded bg-slate-800 text-slate-300">{tg.n} AC</span>
                  {tg.cfit > 0 && <span className="px-1 rounded" style={{ backgroundColor: '#f43f5e33', color: '#fda4af' }}>CFIT {tg.cfit}</span>}
                </div>
                <div className="text-[10px] text-slate-400 mt-1">MORA <span className="text-slate-200 font-semibold">{Math.round(tg.tile.moraFt)} ft</span> · peak {Math.round(tg.tile.peakFt)} ft · mean-score {Math.round(tg.meanScore)}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">{tg.tile.chart} · {tg.tile.lat0}°–{tg.tile.lat1}° N/S × {tg.tile.lng0}°–{tg.tile.lng1}° E/W</div>
                <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden">
                  <div className="h-full" style={{ width: `${Math.min(100, tg.meanScore)}%`, backgroundColor: tg.meanScore >= 80 ? '#f43f5e' : tg.meanScore >= 55 ? '#f59e0b' : tg.meanScore >= 25 ? '#0ea5e9' : '#10b981' }} />
                </div>
              </div>
            )
          })}
          {tileAgg.length === 0 && <div className="text-center text-slate-500 py-4 text-[11px]">No aircraft in catalogued tiles</div>}
        </div>
      )}

      {tab === 'PHASE' && (
        <div className="px-2 py-2 space-y-1">
          {phaseAgg.map(pg => {
            const meanScore = pg.n ? pg.sumScore / pg.n : 0
            const meanClr = pg.n ? pg.sumClr / pg.n : 0
            const tier: Tier = pg.cfit > 0 ? 'CFIT-RISK' : meanScore >= 55 ? 'LOW-MORA' : meanScore >= 25 ? 'MARGIN' : 'OK'
            return (
              <div key={pg.ph} className="rounded border border-slate-800 bg-slate-900/50 p-2" style={{ borderLeft: '3px solid ' + TIER_COLOR[tier] }}>
                <div className="flex items-center gap-1 text-[10px]">
                  <span className="font-semibold text-slate-100 truncate flex-1">{pg.ph}</span>
                  <span className="px-1 rounded bg-slate-800 text-slate-300">{pg.n} AC</span>
                  {pg.cfit > 0 && <span className="px-1 rounded" style={{ backgroundColor: '#f43f5e33', color: '#fda4af' }}>CFIT {pg.cfit}</span>}
                  <span className="px-1 rounded" style={{ backgroundColor: TIER_COLOR[tier] + '33', color: TIER_COLOR[tier] }}>{tier}</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-1">phase-mul {PHASE_MUL[pg.ph].toFixed(2)} · mean clear <span style={{ color: meanClr > 1500 ? '#10b981' : meanClr > 0 ? '#f59e0b' : '#f43f5e' }}>{Math.round(meanClr)} ft</span> · mean-score {Math.round(meanScore)}</div>
                <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden">
                  <div className="h-full" style={{ width: `${Math.min(100, meanScore)}%`, backgroundColor: TIER_COLOR[tier] }} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: AIM 5-6-2 OROCA · 14 CFR 91.177 / 95.13 / 95 App · 121.657 · TERPS 8260.3D ch 12 · 8260.32 MVA · AC 91-79B · AC 25-23 · AC 23-18 TAWS · JO 7110.65 §4-5-6 · ICAO Annex 4 ch 8 Grid-MORA · Annex 6 Pt I §4.2.6 · Doc 8168 Vol II Pt I §1.6 / Pt III §2.4 · Doc 9613 PBN · Doc 9905 RNP AR · Jeppesen Enroute Grid-MORA legend · USGS GTOPO30 / SRTM-3 v4 · ARINC 424 §5.13 / ARINC 769 EGPWS · RTCA DO-200B / DO-272 · NTSB AAR-75-16 TWA 514 IAD Mt-Weather · AAR-97-06 AAL 965 Cali · EASA AD-2018-0146 EGPWS DB.
      </div>
    </div>
  )
}
