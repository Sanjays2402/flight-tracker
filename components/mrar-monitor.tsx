'use client'

// =============================================================================
// MRAR · Mode-S Meteorological Routine Air Report (BDS 4,4 / 4,5) NWP-Assimilation
// 4-D Atmospheric Sounding Synthesiser & Met-Wake Coverage Monitor
// -----------------------------------------------------------------------------
// Per-airframe live evaluator that scores the meteorological value each
// airborne aircraft is contributing (or COULD be contributing) to numerical
// weather prediction (NWP) data-assimilation streams via the Mode-S downlink
// METEOROLOGICAL registers — BDS 4,4 "Meteorological Routine Air Report"
// (MRAR) and BDS 4,5 "Meteorological Hazard Report" (MHR) — interrogated by
// SSR Mode-S radars and re-broadcast to ECMWF / NOAA NCEP / Met Office / DWD /
// MeteoFrance / JMA / BoM / EnviroCan operational global forecast systems.
//
// Each airframe is treated as a flying RADIOSONDE that, when MRAR/MHR-capable,
// provides:
//   BDS 4,4 register 50-bit payload (DO-181E Tbl 3-58 / ICAO Doc 9871 App A §A.2.4.4):
//     FOM[4]  Figure of Merit (sensor accuracy class 0-15)
//     WS[9]   Wind Speed kt (0-511 kt res 1 kt)
//     WD[9]   Wind Direction deg (0-511 res 180°/256 ≈ 0.703°)
//     SAT[10] Static Air Temperature 0.25 °C resolution signed
//     AvgP[11] Average Static Pressure (1 hPa res 0-2047 hPa)
//     TURB[2] Turbulence class (NIL/LIGHT/MOD/SEVERE) — RTCA DO-181E §2.2.18
//     HUM[6]  Humidity % (5 % res 0-100 %) — present only on BDS 4,5 in some
//             implementations; standardised by EUMETNET AMDAR humidity-OS
//   BDS 4,5 MHR additional payload:
//     ICING[2] / WAKE[2] / MTW[2] / VPP[6] vertical pressure perturbation
//
// MRAR/MHR data feeds:
//   * ECMWF IFS 4D-Var (assimilation cycle 0/6/12/18 UTC)
//   * NOAA NCEP GFS GSI 4D-EnVar
//   * Met Office UM 4D-Var
//   * DWD ICON-EU 3D-Var
//   * EUMETNET E-AMDAR / E-Mode-S programme (≈400 M obs/yr 2024)
//   * NOAA TAMDAR (USA AMDAR-equivalent / Panasonic, separate protocol)
//   * KNMI Mode-S-EHS de-rotation post-processor for non-MRAR jets that
//     reverse-engineer winds from BDS 4,0 + BDS 5,0 + BDS 6,0 register triple
//
// MRAR is DISTINCT from every neighbouring overlay:
//   WAFS / WINDS-ALOFT   — FORECAST grid produced BY assimilation (we are
//                           the data-source side, not the consumer side)
//   TURB-EDR             — onboard turbulence (RTCA DO-381 EDR) reported by
//                           ARINC 620 free-text to AOC, not Mode-S register
//   PIREP                — voice pilot report via FSS, not surveillance
//   PWS                  — onboard X-band Doppler windshear, not transponder
//   EHS / ELS BDS 4,0/5,0/6,0 — selected vertical intent / track / heading,
//                           NOT meteorology (that's BDS 4,4 / 4,5)
//   GADSS / ADS-C        — position report stream, not met sounding
//   GEOMAG / COSMIC      — space-weather, not tropospheric met
//   ICING / HOLDOVER     — airborne / ground icing, not assimilation feed
//   METAR / TAF / TCAM   — surface obs / forecast / cyclone advisory
//
// MRAR is uniquely the 4-D ATMOSPHERIC-SOUNDING DATA-CONTRIBUTION evaluator
// answering for each airframe: (a) does its transponder support BDS 4,4
// extraction, (b) is the FOM figure-of-merit high enough for assimilation,
// (c) is the SAT / Wind sample timely (last update <60s), (d) is the
// vertical column well-resolved (climb/descent provides full troposphere
// profile from departure to TOC and TOD to arrival), (e) is the FIR/region
// covered by a Mode-S MRAR-querying interrogator that routes the register
// to a Met-Wake Coverage post-processor.
//
// 12-class equipment fit catalogue (per AClass) drives BDS 4,4/4,5 support
// per Honeywell / Collins / Thales / Garmin transponder TSO-C112e family
// (DO-181E Ed.4 mandatory MRAR/MHR for AMC 20-24 Mode-S Enhanced compliance).
//
// 14 Mode-S MRAR-querying interrogator regions per EUROCONTROL Mode-S
// Surveillance Implementation Programme (MSSIP) + FAA NextGen Surveillance
// & Weather Radar Capability (SWRC):
//   EUR-NORTH (DFS / NATS / LFV / Avinor / Naviair / EANS / Finavia)
//   EUR-SOUTH (DSNA / ENAV / ENAIRE / DCAC-CY / HCAA / NAV-PORTUGAL)
//   EUR-EAST  (PANSA / LPS-SR / ŘLP / Croatia-CC / Slovenia / Bulgarian-ANSP)
//   EUR-WEST  (skyguide / LVNL / Belgocontrol / NATS / DFS-Karlsruhe)
//   UK-MIL    (DECMC + RAF Mode-S Cluster)
//   NA-EAST   (FAA ZNY/ZBW/ZDC/ZTL/ZJX/ZMA Mode-S Enhanced)
//   NA-WEST   (FAA ZSE/ZOA/ZLA/ZAB/ZDV/ZMP Mode-S Enhanced)
//   NA-CENTRAL (FAA ZAU/ZID/ZKC/ZME/ZFW/ZHU)
//   NA-CANADA (NAV CANADA Selex SIR-S Mode-S Enhanced)
//   ASIA-NE   (JCAB / KAC / Taiwan-CAA / HK-CAD)
//   ASIA-SE   (CAAS / DCA-Thai / CAA-Vietnam / DGCA-Indo)
//   ASIA-IN   (AAI / DGCA-India)
//   OCEANIA   (Airservices-Australia / Airways-NZ Selex)
//   OCEANIC   (no MRAR — fallback to derived-winds via FANS-1A ADS-C)
//
// Compliance score = 6-driver composite (XPDR / FOM / FRESH / VERTCOV /
// REGION / HUM) with 5 tiers REJECTED / DEFECTIVE / DEFICIENT / ACCEPTED /
// EXEMPLARY. Tier coloring same family as other overlays (rose/amber/sky/
// emerald/slate), accent always sky-500 for chrome.
//
// MapLibre overlay: tier-coloured halo + REJECTED pin + vertical-profile
// trail + Mode-S interrogator region pins. Panel: tier counter strip +
// 6-cell summary + sliders + filters + 4-tab AIRCRAFT / SOUNDING / COVERAGE
// / FORMAT showing the actual 50-bit MRAR register payload.
//
// References: ICAO Annex 10 Vol IV Surveillance Radar & Collision Avoidance
// Systems · ICAO Doc 9871 Tech Prov for Mode-S Services & Extended Squitter
// (App A §A.2.4.4 BDS 4,4) · ICAO Doc 9817 Manual on Low-Level Wind Shear
// Ch.7 · ICAO Annex 3 Met §5.5 Aircraft Observations · WMO No.488 Guide on
// the AMDAR Observing System · WMO IOM Report No.121 Mode-S MRAR Status ·
// RTCA DO-181E Ed.4 §2.2.18 BDS Register Catalogue · EUROCAE ED-73E ·
// EUROCONTROL Mode-S MRAR Implementation Guide ed.4 · ECMWF Tech Memo 833
// (Cardinali 2018) Mode-S Wind/Temp Impact on IFS 4D-Var · ECMWF NWP-SAF
// AMDAR/Mode-S Status Report 2023 · KNMI Tech Report TR-313 (de Haan 2011)
// Mode-S EHS Meteorological Observations · NOAA NESDIS TAMDAR ATBD ·
// E-AMDAR Programme MAN ed.5 · EUMETNET Mode-S MET data exchange · FAA
// AC 90-114B ADS-B Operations · DO-260C ADS-B MOPS · ARINC 624 OMS.
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

interface F {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  vertRate: number
  track: number
  ground?: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: F[]
  onClose: () => void
  onFly: (icao: string) => void
}

// =============================================================================
// Tiers, colours, classes
// =============================================================================
type Tier = 'REJECTED' | 'DEFECTIVE' | 'DEFICIENT' | 'ACCEPTED' | 'EXEMPLARY' | 'IDLE'
const TIER_ORDER: Tier[] = ['REJECTED','DEFECTIVE','DEFICIENT','ACCEPTED','EXEMPLARY','IDLE']
const TIER_RANK: Record<Tier, number> = { REJECTED:0, DEFECTIVE:1, DEFICIENT:2, ACCEPTED:3, EXEMPLARY:4, IDLE:5 }
const TIER_COLOR: Record<Tier, string> = {
  REJECTED:  '#f43f5e',  // rose-500
  DEFECTIVE: '#f59e0b',  // amber-500
  DEFICIENT: '#eab308',  // yellow-500
  ACCEPTED:  '#0ea5e9',  // sky-500
  EXEMPLARY: '#10b981',  // emerald-500
  IDLE:      '#64748b',  // slate-500
}

type AClass = 'HVY-Q'|'HVY-T'|'WB-M'|'NB-LR'|'NB'|'RGN-J'|'RGN-T'|'BIZ'|'LIGHT'|'OTHER'

// Per-class equipage spec — transponder generation + MRAR/MHR support per
// DO-181E Ed.4 + AMC 20-24 + 14 CFR §91.225
interface ClassSpec {
  label: string
  // Transponder family — 'TPA-100B' Honeywell, 'TDR-94D' Collins, etc.
  xpdr: string
  // BDS register support
  hasBDS44: boolean   // MRAR meteorological routine air report
  hasBDS45: boolean   // MHR meteorological hazard report
  hasHumidity: boolean // EUMETNET humidity-OS hygrometer sensor fit
  // Sensor figure-of-merit (FOM) cap per DO-181E §2.2.18.2.5
  fomMax: number       // 0-15 typically 8-15 for transports
  // Service ceiling
  serviceFL: number
  // Cruise Mach
  cruzMach: number
  // Vertical climb/descent rate typical fpm
  vsTypical: number
}

const CLASS: Record<AClass, ClassSpec> = {
  'HVY-Q':  { label:'A380/B748 super-heavy quad',    xpdr:'TPA-100B',  hasBDS44:true,  hasBDS45:true,  hasHumidity:true,  fomMax:14, serviceFL:430, cruzMach:0.85, vsTypical:2200 },
  'HVY-T':  { label:'B77W/B789/A35K/A330 heavy twin', xpdr:'TPA-100B',  hasBDS44:true,  hasBDS45:true,  hasHumidity:true,  fomMax:14, serviceFL:430, cruzMach:0.84, vsTypical:2400 },
  'WB-M':   { label:'B767/A310 widebody medium',     xpdr:'TPA-100A',  hasBDS44:true,  hasBDS45:false, hasHumidity:false, fomMax:12, serviceFL:430, cruzMach:0.80, vsTypical:2300 },
  'NB-LR':  { label:'B757/A321XLR narrowbody LR',    xpdr:'TPA-100B',  hasBDS44:true,  hasBDS45:true,  hasHumidity:false, fomMax:13, serviceFL:410, cruzMach:0.80, vsTypical:2500 },
  'NB':     { label:'B737/A320 narrowbody',          xpdr:'TPA-100A',  hasBDS44:true,  hasBDS45:false, hasHumidity:false, fomMax:11, serviceFL:410, cruzMach:0.78, vsTypical:2400 },
  'RGN-J':  { label:'E190/CRJ9 regional jet',        xpdr:'TDR-94D',   hasBDS44:true,  hasBDS45:false, hasHumidity:false, fomMax:10, serviceFL:410, cruzMach:0.78, vsTypical:2200 },
  'RGN-T':  { label:'AT72/Q400 regional turboprop',  xpdr:'TDR-94D',   hasBDS44:false, hasBDS45:false, hasHumidity:false, fomMax:8,  serviceFL:250, cruzMach:0.50, vsTypical:1500 },
  'BIZ':    { label:'G650/GLEX/FA8X bizjet',         xpdr:'TDR-94D',   hasBDS44:true,  hasBDS45:false, hasHumidity:false, fomMax:11, serviceFL:510, cruzMach:0.85, vsTypical:3500 },
  'LIGHT':  { label:'GA piston / light turboprop',   xpdr:'GTX-345',   hasBDS44:false, hasBDS45:false, hasHumidity:false, fomMax:6,  serviceFL:250, cruzMach:0.30, vsTypical:700 },
  'OTHER':  { label:'unclassified',                  xpdr:'unknown',   hasBDS44:false, hasBDS45:false, hasHumidity:false, fomMax:5,  serviceFL:350, cruzMach:0.70, vsTypical:1800 },
}

// Map ICAO type designator → class
const HVY_Q = new Set(['A388','B748','B744','B741','B742','B743','A340','A342','A343','A345','A346'])
const HVY_T = new Set(['B77W','B77L','B772','B773','B789','B788','B78X','A359','A35K','A338','A339','A332','A333','A337','B763','B764','B762'])
const WBM   = new Set(['B767','A300','A306','A310','MD11','DC10','L101'])
const NBLR  = new Set(['B752','B753','B757','A321','A21N'])
const NB    = new Set(['B737','B738','B739','B73G','B73H','B73N','B38M','B39M','B3XM','A319','A320','A321','A19N','A20N','A220','BCS1','BCS3','E290','E295'])
const RGNJ  = new Set(['E170','E175','E190','E195','CRJ2','CRJ7','CRJ9','CRJX','SU95','E145'])
const RGNT  = new Set(['AT72','AT76','AT75','AT45','AT43','DH8A','DH8B','DH8C','DH8D','SF34','SF50','J328','SB20','S340','BE20','PC12'])
const BIZ   = new Set(['G650','G700','GL5T','GLEX','GLF6','GLF5','GLF4','FA8X','FA7X','FA50','FA9X','C25A','C25B','C25C','C56X','C68A','C750','C700','LJ60','E55P','E50P','CL30','CL35','CL60','BD70','GA6C','GA5C','HDJT'])
const LIGHT = new Set(['C172','C152','C182','C206','PA28','PA32','PA34','SR20','SR22','DA40','DA42','BE36','BE33','M20P','M20T','C72R'])

function classify(f: F): AClass {
  const t = (f.type || '').toUpperCase()
  if (HVY_Q.has(t)) return 'HVY-Q'
  if (HVY_T.has(t)) return 'HVY-T'
  if (WBM.has(t))   return 'WB-M'
  if (NBLR.has(t))  return 'NB-LR'
  if (NB.has(t))    return 'NB'
  if (RGNJ.has(t))  return 'RGN-J'
  if (RGNT.has(t))  return 'RGN-T'
  if (BIZ.has(t))   return 'BIZ'
  if (LIGHT.has(t)) return 'LIGHT'
  // Heuristic by category
  const cat = (f.category || '').toUpperCase()
  if (cat.includes('HEAVY') || cat === 'A5' || cat === 'A6') return 'HVY-T'
  if (cat === 'A4') return 'NB'
  if (cat === 'A3') return 'RGN-J'
  if (cat === 'A2') return 'BIZ'
  if (cat === 'A1') return 'LIGHT'
  return 'OTHER'
}

// =============================================================================
// Geometry helpers
// =============================================================================
const R_NM = 3440.065
function haversineNM(a1: number, o1: number, a2: number, o2: number): number {
  const r1 = a1 * Math.PI / 180, r2 = a2 * Math.PI / 180
  const dr = (a2 - a1) * Math.PI / 180, dl = (o2 - o1) * Math.PI / 180
  const h = Math.sin(dr/2)**2 + Math.cos(r1) * Math.cos(r2) * Math.sin(dl/2)**2
  return 2 * R_NM * Math.asin(Math.sqrt(h))
}

// Deterministic per-icao hash for synthetic MRAR fields
function hash(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function hashFloat(s: string, salt: string, lo: number, hi: number): number {
  const v = (hash(s + salt) % 10000) / 10000
  return lo + v * (hi - lo)
}

// =============================================================================
// Mode-S MRAR interrogator regions (14 zones)
// =============================================================================
interface Region {
  id: string
  label: string
  // Polygon-equivalent rectangular bbox [latS, latN, lngW, lngE]
  bbox: [number, number, number, number]
  // Interrogator-network maturity 0-100 (drives MRAR query frequency)
  mrarMaturity: number
  // Centre for region-pin display
  cx: number
  cy: number
}

const REGIONS: Region[] = [
  { id:'EUR-NORTH',  label:'DFS/NATS/LFV/Avinor Mode-S MRAR',     bbox:[50, 72,  -10, 32], mrarMaturity:95, cx: 60, cy: 12 },
  { id:'EUR-SOUTH',  label:'DSNA/ENAV/ENAIRE Mode-S MRAR',         bbox:[35, 50,  -10, 30], mrarMaturity:90, cx: 42, cy: 8 },
  { id:'EUR-EAST',   label:'PANSA/LPS-SR/ŘLP Mode-S MRAR',         bbox:[42, 56,   12, 32], mrarMaturity:75, cx: 50, cy: 22 },
  { id:'EUR-WEST',   label:'skyguide/LVNL/NATS Mode-S MRAR',       bbox:[48, 55,   -5, 12], mrarMaturity:95, cx: 51, cy: 4 },
  { id:'UK-MIL',     label:'DECMC + RAF Mode-S MRAR',              bbox:[50, 60,  -10,  3], mrarMaturity:80, cx: 55, cy: -3 },
  { id:'NA-EAST',    label:'FAA ZNY/ZBW/ZDC/ZTL Mode-S Enh',       bbox:[25, 50,  -85,-65], mrarMaturity:65, cx: 38, cy:-75 },
  { id:'NA-WEST',    label:'FAA ZSE/ZOA/ZLA Mode-S Enh',           bbox:[30, 50, -125,-110], mrarMaturity:55, cx: 40, cy:-117 },
  { id:'NA-CENTRAL', label:'FAA ZAU/ZID/ZKC Mode-S Enh',           bbox:[28, 48,  -110,-85], mrarMaturity:55, cx: 38, cy:-98 },
  { id:'NA-CANADA',  label:'NAV CANADA Selex SIR-S MRAR',          bbox:[42, 70,  -140,-50], mrarMaturity:50, cx: 55, cy:-95 },
  { id:'ASIA-NE',    label:'JCAB/KAC/Taiwan-CAA Mode-S MRAR',      bbox:[25, 46,  120, 146], mrarMaturity:60, cx: 35, cy:133 },
  { id:'ASIA-SE',    label:'CAAS/DCA-Thai/CAAV Mode-S MRAR',       bbox:[ -8, 22,  95, 130], mrarMaturity:45, cx: 8, cy:108 },
  { id:'ASIA-IN',    label:'AAI/DGCA-India Mode-S MRAR',           bbox:[  8, 32,  68, 92],  mrarMaturity:35, cx: 22, cy: 80 },
  { id:'OCEANIA',    label:'Airservices/Airways-NZ Selex MRAR',    bbox:[-44,-10, 113, 178], mrarMaturity:55, cx:-25, cy:140 },
  { id:'OCEANIC',    label:'No MRAR · fallback FANS-1A ADS-C',     bbox:[-90, 90, -180,180], mrarMaturity: 0, cx:  0, cy:-30 },
]

function regionFor(lat: number, lng: number): Region {
  for (const r of REGIONS.slice(0, REGIONS.length - 1)) {
    const [s, n, w, e] = r.bbox
    if (lat >= s && lat <= n && lng >= w && lng <= e) return r
  }
  return REGIONS[REGIONS.length - 1] // OCEANIC fallback
}

// =============================================================================
// ISA atmosphere helpers (for ΔT vs ISA scoring)
// =============================================================================
const ISA_T0 = 15.0  // °C MSL
const ISA_LR = -1.98 // °C / 1000 ft up to tropopause
const FL_TROPO = 360 // Standard ISA tropopause ≈ FL360
const ISA_TT = -56.5 // °C at tropopause

function isaSAT(fl: number): number {
  if (fl <= FL_TROPO) return ISA_T0 + ISA_LR * (fl / 10)
  return ISA_TT
}

function isaPressure(fl: number): number {
  // hPa per ICAO Doc 7488 std atmosphere
  if (fl <= 360) {
    const T = isaSAT(fl) + 273.15
    return 1013.25 * Math.pow(T / 288.15, 5.2561)
  }
  // Isothermal above tropopause
  const p_tropo = 1013.25 * Math.pow(216.65 / 288.15, 5.2561)
  const dh_ft = (fl - 360) * 100
  return p_tropo * Math.exp(-9.80665 * dh_ft * 0.3048 / (287.05 * 216.65))
}

// =============================================================================
// Synthetic BDS 4,4 / 4,5 register payload
// =============================================================================
interface MRARPayload {
  // BDS 4,4 fields
  fom: number          // 0-15
  ws: number           // kt 0-511
  wd: number           // deg 0-359
  sat: number          // °C signed
  avgP: number         // hPa
  turb: 'NIL'|'LIGHT'|'MOD'|'SEVERE'
  // BDS 4,5 fields (when MHR supported)
  hum: number          // % RH (0-100)
  icing: 'NIL'|'TRACE'|'LIGHT'|'MOD'
  wake: 'NIL'|'LIGHT'|'MOD'
  mtw: 'NIL'|'LIGHT'|'MOD'
  vpp: number          // ±31 hPa
  // Meta
  ageS: number         // seconds since last MRAR interrogation
  registers: ('BDS-44' | 'BDS-45')[]
}

function synthPayload(f: F, cls: AClass, spec: ClassSpec, region: Region): MRARPayload {
  const fl = Math.max(50, Math.round(f.altitudeFt / 100))
  const isaT = isaSAT(fl)
  const isaP = isaPressure(fl)
  // ΔT vs ISA — deterministic per-icao perturbation -8..+12 °C
  const dT = hashFloat(f.icao, 'dT', -8, 12)
  const sat = isaT + dT
  // Pressure perturbation ±5 hPa
  const dP = hashFloat(f.icao, 'dP', -5, 5)
  const avgP = isaP + dP
  // Wind: synthetic jet-stream proxy with FL-dependent intensity
  const wsBase = fl < 200 ? 25 : fl < 300 ? 65 : fl < 380 ? 110 : 90
  const ws = Math.round(wsBase + hashFloat(f.icao, 'ws', -30, 40))
  // Wind direction: latitude-driven (mid-lat westerlies)
  const wdBase = Math.abs(f.lat) > 30 && Math.abs(f.lat) < 65 ? 270 : f.lat > 65 ? 90 : 90
  const wd = (wdBase + Math.round(hashFloat(f.icao, 'wd', -60, 60)) + 360) % 360
  // Humidity (only if hasHumidity)
  const hum = spec.hasHumidity ? Math.round(hashFloat(f.icao, 'hum', 5, 95)) : 0
  // Turbulence — hash-based with 70% NIL / 18% LIGHT / 9% MOD / 3% SEVERE
  const tH = hash(f.icao + 'turb') % 100
  const turb: MRARPayload['turb'] = tH < 70 ? 'NIL' : tH < 88 ? 'LIGHT' : tH < 97 ? 'MOD' : 'SEVERE'
  // FOM — capped by class but reduced if sensor degraded
  let fom = spec.fomMax
  if (hash(f.icao + 'fom') % 100 < 12) fom = Math.max(0, fom - 4 - (hash(f.icao+'f') % 4))
  // Age — driven by region maturity (lower maturity → older MRAR queries)
  const ageBase = region.mrarMaturity > 80 ? 8 : region.mrarMaturity > 50 ? 30 : region.mrarMaturity > 0 ? 90 : 999
  const ageS = Math.round(ageBase + hashFloat(f.icao, 'age', -ageBase/3, ageBase/2))
  // Icing — only at FL080-FL250 in cloud band
  const iH = hash(f.icao + 'ice') % 100
  let icing: MRARPayload['icing'] = 'NIL'
  if (fl >= 80 && fl <= 250 && iH > 75) icing = iH > 95 ? 'MOD' : iH > 88 ? 'LIGHT' : 'TRACE'
  // Wake & MTW
  const wH = hash(f.icao + 'wake') % 100
  const wake: MRARPayload['wake'] = wH > 92 ? 'MOD' : wH > 82 ? 'LIGHT' : 'NIL'
  const mH = hash(f.icao + 'mtw') % 100
  const mtw: MRARPayload['mtw'] = mH > 94 ? 'MOD' : mH > 85 ? 'LIGHT' : 'NIL'
  // Vertical pressure perturbation
  const vpp = Math.round(hashFloat(f.icao, 'vpp', -8, 8))
  // Registers supported
  const registers: ('BDS-44'|'BDS-45')[] = []
  if (spec.hasBDS44) registers.push('BDS-44')
  if (spec.hasBDS45) registers.push('BDS-45')
  return { fom, ws, wd, sat, avgP, turb, hum, icing, wake, mtw, vpp, ageS, registers }
}

// =============================================================================
// Validation errors taxonomy
// =============================================================================
type ErrCode =
  | 'E1-XPDR'    // transponder doesn't support MRAR/BDS-44
  | 'E2-FOM'     // FOM below assimilation threshold
  | 'E3-FRESH'   // observation stale
  | 'E4-VCOV'    // vertical column under-resolved (level cruise no profile)
  | 'E5-REGION'  // outside MRAR-querying interrogator region
  | 'E6-HUM'     // missing humidity payload
  | 'E7-WIND'    // implausible wind (out of band)
  | 'E8-SAT'     // SAT deviates >15K from ISA — sensor suspect
  | 'E9-PRES'    // pressure inconsistent with FL
  | 'E10-NOMHR'  // MHR-only fields requested but BDS-45 not supported

interface ValErr {
  code: ErrCode
  field: string
  severity: 'REJ' | 'MAN' | 'WAR'
  text: string
  weight: number
}

function validate(p: MRARPayload, cls: AClass, spec: ClassSpec, region: Region, fl: number, vsFpm: number): ValErr[] {
  const errs: ValErr[] = []

  // E1 XPDR support BDS-44 baseline
  if (!spec.hasBDS44) {
    errs.push({ code:'E1-XPDR', field:'BDS-44', severity:'REJ', text:`Transponder ${spec.xpdr} does not support BDS 4,4 MRAR extraction (DO-181E §2.2.18.2)`, weight: 24 })
  }

  // E2 FOM below assimilation threshold (ECMWF requires ≥6 for 4D-Var)
  if (spec.hasBDS44 && p.fom < 6) {
    errs.push({ code:'E2-FOM', field:'FOM', severity:'REJ', text:`Figure-of-Merit ${p.fom} below ECMWF 4D-Var assimilation threshold 6 (NWP-SAF Tech Memo 833)`, weight: 18 })
  } else if (spec.hasBDS44 && p.fom < 8) {
    errs.push({ code:'E2-FOM', field:'FOM', severity:'MAN', text:`FOM ${p.fom} below NCEP GFS GSI threshold 8 — wind sample down-weighted`, weight: 10 })
  }

  // E3 Freshness
  if (p.ageS > 180) {
    errs.push({ code:'E3-FRESH', field:'TS', severity:'REJ', text:`Sample age ${p.ageS}s exceeds 3-min assimilation freshness gate (ECMWF IFS cycle 0/6/12/18 UTC)`, weight: 16 })
  } else if (p.ageS > 60) {
    errs.push({ code:'E3-FRESH', field:'TS', severity:'MAN', text:`Sample age ${p.ageS}s exceeds 60s WMO AMDAR humidity-OS freshness target`, weight: 8 })
  }

  // E4 Vertical coverage (level cruise → no profile contribution)
  if (Math.abs(vsFpm) < 200 && fl > 250) {
    errs.push({ code:'E4-VCOV', field:'VS', severity:'WAR', text:`Level cruise at FL${fl.toString().padStart(3,'0')} VS=${vsFpm}fpm → single point only · no troposphere profile contribution`, weight: 5 })
  }

  // E5 Region — outside any MRAR-querying interrogator
  if (region.id === 'OCEANIC') {
    errs.push({ code:'E5-REGION', field:'REG', severity:'REJ', text:`Aircraft in OCEANIC region · no Mode-S interrogator coverage · fallback FANS-1A ADS-C met report only`, weight: 14 })
  } else if (region.mrarMaturity < 50) {
    errs.push({ code:'E5-REGION', field:'REG', severity:'MAN', text:`Region ${region.id} maturity ${region.mrarMaturity}% · MRAR query rate below WMO IOM-121 target`, weight: 8 })
  }

  // E6 Humidity
  if (!spec.hasHumidity && fl >= 100 && fl <= 400) {
    errs.push({ code:'E6-HUM', field:'HUM', severity:'WAR', text:`No hygrometer fit · class ${cls} not in EUMETNET humidity-OS programme (UCN/SwissAir/Lufthansa fleet only)`, weight: 5 })
  }

  // E7 Implausible wind
  if (p.ws > 250) {
    errs.push({ code:'E7-WIND', field:'WS', severity:'MAN', text:`Wind speed ${p.ws}kt exceeds jet-stream upper-bound 250kt · sensor suspect or AMDAR encoding error`, weight: 8 })
  } else if (fl > 250 && p.ws < 5) {
    errs.push({ code:'E7-WIND', field:'WS', severity:'WAR', text:`Wind speed ${p.ws}kt at FL${fl.toString().padStart(3,'0')} unusually calm for upper troposphere`, weight: 4 })
  }

  // E8 SAT
  const isaT = isaSAT(fl)
  const dT = Math.abs(p.sat - isaT)
  if (dT > 25) {
    errs.push({ code:'E8-SAT', field:'SAT', severity:'MAN', text:`SAT ${p.sat.toFixed(1)}°C deviates ${dT.toFixed(1)}K from ISA ${isaT.toFixed(1)}°C — TAT-probe icing suspect`, weight: 9 })
  } else if (dT > 15) {
    errs.push({ code:'E8-SAT', field:'SAT', severity:'WAR', text:`SAT ${p.sat.toFixed(1)}°C deviates ${dT.toFixed(1)}K from ISA — synoptic anomaly worth assimilating`, weight: 3 })
  }

  // E9 Pressure
  const isaP = isaPressure(fl)
  const dP = Math.abs(p.avgP - isaP)
  if (dP > 30) {
    errs.push({ code:'E9-PRES', field:'P', severity:'MAN', text:`Avg-Pressure ${p.avgP.toFixed(0)}hPa deviates ${dP.toFixed(0)}hPa from ISA ${isaP.toFixed(0)}hPa at FL${fl}`, weight: 7 })
  }

  // E10 No MHR but hazard slot non-null
  if (!spec.hasBDS45 && (p.icing !== 'NIL' || p.wake !== 'NIL' || p.mtw !== 'NIL')) {
    errs.push({ code:'E10-NOMHR', field:'BDS-45', severity:'WAR', text:`Transponder does not support BDS 4,5 MHR · icing/wake/MTW slots not transmittable`, weight: 5 })
  }

  return errs
}

interface Row {
  f: F
  cls: AClass
  spec: ClassSpec
  region: Region
  payload: MRARPayload
  errors: ValErr[]
  driverScores: { XPDR:number; FOM:number; FRESH:number; VERTCOV:number; REGION:number; HUM:number }
  score: number
  tier: Tier
  fl: number
  vsFpm: number
  isaDT: number
  isaDP: number
}

function score(errs: ValErr[], spec: ClassSpec, region: Region, payload: MRARPayload, vsFpm: number, fl: number): { driverScores: Row['driverScores']; score: number; tier: Tier } {
  const d = { XPDR:0, FOM:0, FRESH:0, VERTCOV:0, REGION:0, HUM:0 }
  for (const e of errs) {
    const w = e.weight
    if (e.code === 'E1-XPDR' || e.code === 'E10-NOMHR') d.XPDR = Math.max(d.XPDR, w * 3)
    if (e.code === 'E2-FOM' || e.code === 'E7-WIND' || e.code === 'E8-SAT' || e.code === 'E9-PRES') d.FOM = Math.max(d.FOM, w * 3)
    if (e.code === 'E3-FRESH') d.FRESH = Math.max(d.FRESH, w * 3)
    if (e.code === 'E4-VCOV') d.VERTCOV = Math.max(d.VERTCOV, w * 3)
    if (e.code === 'E5-REGION') d.REGION = Math.max(d.REGION, w * 3)
    if (e.code === 'E6-HUM') d.HUM = Math.max(d.HUM, w * 3)
  }
  for (const k of Object.keys(d) as Array<keyof typeof d>) d[k] = Math.min(100, d[k])
  const vals = Object.values(d)
  const mx = Math.max(...vals)
  const mn = vals.reduce((a,c)=>a+c,0) / vals.length
  const sc = Math.min(100, Math.max(0, mx*0.66 + mn*0.34))
  let tier: Tier = 'EXEMPLARY'
  if (sc >= 80) tier = 'REJECTED'
  else if (sc >= 60) tier = 'DEFECTIVE'
  else if (sc >= 35) tier = 'DEFICIENT'
  else if (sc >= 15) tier = 'ACCEPTED'
  return { driverScores: d, score: sc, tier }
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================
export default function MrarMonitor({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [scopeFL, setScopeFL] = useState<number>(50)
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AClass | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'SOUNDING'|'COVERAGE'|'FORMAT'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shReg, setShReg] = useState(true)
  const [picked, setPicked] = useState<string | null>(null)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const fl = Math.max(0, Math.round(f.altitudeFt / 100))
      if (fl < scopeFL) continue
      const cls = classify(f)
      const spec = CLASS[cls]
      const region = regionFor(f.lat, f.lng)
      const payload = synthPayload(f, cls, spec, region)
      const vsFpm = Math.round(f.vertRate * 60)
      const errs = validate(payload, cls, spec, region, fl, vsFpm)
      const { driverScores, score: rawScore, tier } = score(errs, spec, region, payload, vsFpm, fl)
      const sc = Math.min(100, rawScore * advMul)
      let adjTier: Tier = 'EXEMPLARY'
      if (sc >= 80) adjTier = 'REJECTED'
      else if (sc >= 60) adjTier = 'DEFECTIVE'
      else if (sc >= 35) adjTier = 'DEFICIENT'
      else if (sc >= 15) adjTier = 'ACCEPTED'
      const isaDT = payload.sat - isaSAT(fl)
      const isaDP = payload.avgP - isaPressure(fl)
      out.push({ f, cls, spec, region, payload, errors: errs, driverScores, score: sc, tier: adjTier, fl, vsFpm, isaDT, isaDP })
    }
    out.sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return out
  }, [flights, advMul, scopeFL])

  // ---------------- MapLibre overlay ---------------- //
  useEffect(() => {
    if (!map) return
    const SRC = 'mrar-src'
    const SRC_REG = 'mrar-region-src'
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any }) }
    ;[SRC, SRC_REG].forEach(ensure)

    const writeAll = () => {
      const view = rows.filter(r =>
        (tierFilter === 'ALL' || r.tier === tierFilter) &&
        (classFilter === 'ALL' || r.cls === classFilter)
      )
      const ac: any[] = []
      for (const r of view) {
        ac.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
          properties:{
            tier: r.tier,
            color: TIER_COLOR[r.tier],
            score: r.score,
            sz: 7 + (r.score/100) * 14,
            label: `${(r.f.callsign||r.f.icao).trim()} · ${r.tier} · F${r.fl.toString().padStart(3,'0')} · ${r.payload.ws}kt@${r.payload.wd.toString().padStart(3,'0')}° · ${r.payload.sat.toFixed(0)}°C · ${r.region.id}`,
          },
        })
      }
      const regFeatures = shReg ? REGIONS.slice(0, REGIONS.length - 1).map(r => ({
        type:'Feature',
        geometry:{ type:'Point', coordinates:[r.cy, r.cx] },
        properties:{
          label: `${r.id} · ${r.mrarMaturity}%`,
          color: r.mrarMaturity > 80 ? '#10b981' : r.mrarMaturity > 50 ? '#0ea5e9' : r.mrarMaturity > 30 ? '#eab308' : '#f59e0b',
        },
      })) : []
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: (shHalo||shPin||shLbl) ? ac : [] })
      ;(map.getSource(SRC_REG) as any).setData({ type:'FeatureCollection', features: regFeatures })
    }

    if (!map.getLayer('mrar-reg-pin'))
      map.addLayer({ id:'mrar-reg-pin', type:'circle', source:SRC_REG, paint:{ 'circle-radius':6, 'circle-color':['get','color'], 'circle-opacity':0.5, 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('mrar-reg-lbl'))
      map.addLayer({ id:'mrar-reg-lbl', type:'symbol', source:SRC_REG, layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,-1.2], 'text-anchor':'bottom', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#cbd5e1', 'text-halo-color':'#0b0f17', 'text-halo-width':1.0 } })
    if (!map.getLayer('mrar-halo'))
      map.addLayer({ id:'mrar-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('mrar-pin'))
      map.addLayer({ id:'mrar-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 55], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('mrar-lbl'))
      map.addLayer({ id:'mrar-lbl', type:'symbol', source:SRC, filter:['>=', ['get','score'], 45], layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.5], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.3 } })

    writeAll()
    return () => {
      for (const id of ['mrar-lbl','mrar-pin','mrar-halo','mrar-reg-lbl','mrar-reg-pin']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_REG]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, classFilter, shHalo, shPin, shLbl, shReg])

  // ---------------- Aggregations ---------------- //
  const visible = rows.filter(r =>
    (tierFilter === 'ALL' || r.tier === tierFilter) &&
    (classFilter === 'ALL' || r.cls === classFilter) &&
    (!search || ((r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || r.region.id.toLowerCase().includes(search.toLowerCase())))
  )
  const counts: Record<Tier, number> = { REJECTED:0, DEFECTIVE:0, DEFICIENT:0, ACCEPTED:0, EXEMPLARY:0, IDLE:0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? rows.reduce((a, c) => a + c.score, 0) / rows.length : 0
  const muFom = rows.length ? rows.reduce((a, c) => a + c.payload.fom, 0) / rows.length : 0
  const rejCount = counts.REJECTED
  const sumBDS44 = rows.filter(r => r.spec.hasBDS44).length
  const sumBDS45 = rows.filter(r => r.spec.hasBDS45).length
  const sumOcean = rows.filter(r => r.region.id === 'OCEANIC').length
  const worst = rows[0]
  const pickedRow = picked ? rows.find(r => r.f.icao === picked) : null
  // Region tallies
  const regionCount: Record<string, { total:number; mrar:number; ageMu:number; fomMu:number }> = {}
  for (const r of rows) {
    const k = r.region.id
    if (!regionCount[k]) regionCount[k] = { total:0, mrar:0, ageMu:0, fomMu:0 }
    regionCount[k].total++
    if (r.spec.hasBDS44) regionCount[k].mrar++
    regionCount[k].ageMu += r.payload.ageS
    regionCount[k].fomMu += r.payload.fom
  }

  return (
    <div className="fixed top-16 right-3 z-40 w-[480px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">MRAR</span>
          <span className="text-[10px] text-slate-400">Mode-S BDS 4,4 / 4,5 · 4-D Met-Sounding · ICAO Doc 9871 · ECMWF NWP-SAF</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* Tier counter strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.slice(0,5).map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className="flex-1 px-1.5 py-1 rounded text-[10px] font-mono border"
            style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:'transparent', color: TIER_COLOR[t] }}>{t.slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCR</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-FOM</div><div className="text-slate-100 font-mono">{muFom.toFixed(1)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">REJ</div><div className="font-mono" style={{color: rejCount?TIER_COLOR.REJECTED:'#94a3b8'}}>{rejCount}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">BDS44</div><div className="text-slate-100 font-mono">{sumBDS44}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">BDS45</div><div className="text-slate-100 font-mono">{sumBDS45}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">OCN</div><div className="text-slate-100 font-mono">{sumOcean}</div></div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">MIN-FL <span className="text-slate-200 font-mono">F{scopeFL.toString().padStart(3,'0')}</span>
            <input type="range" min="0" max="450" step="10" value={scopeFL} onChange={e=>setScopeFL(+e.target.value)} className="w-full accent-sky-500" />
          </label>
        </div>
        {/* Class filter */}
        <div className="flex flex-wrap gap-1">
          <button onClick={()=>setClassFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL-CLS</button>
          {(['HVY-Q','HVY-T','WB-M','NB-LR','NB','RGN-J','RGN-T','BIZ','LIGHT'] as AClass[]).map(c => (
            <button key={c} onClick={()=>setClassFilter(c)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter===c?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{c}</button>
          ))}
        </div>
        {/* Overlay toggles + search */}
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['REG',shReg,setShReg]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/region" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 px-3 py-1.5 border-b border-slate-700/60">
        {(['AIRCRAFT','SOUNDING','COVERAGE','FORMAT'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {tab === 'AIRCRAFT' && (
          <>
            {visible.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-6">No aircraft within MRAR scope · raise MIN-FL or relax filters</div>
            )}
            {visible.slice(0, 60).map(r => (
              <div key={r.f.icao} className="border rounded-lg p-2 bg-slate-800/40" style={{ borderColor: TIER_COLOR[r.tier] + '60' }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: TIER_COLOR[r.tier] + '22', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                    <button onClick={()=>{ setPicked(r.f.icao); onFly(r.f.icao) }} className="text-slate-100 font-mono text-[11px] hover:text-sky-300">{(r.f.callsign||r.f.icao).trim()}</button>
                    <span className="text-slate-400 text-[10px]">{(r.f.type||'?').toUpperCase()}·{r.cls}</span>
                  </div>
                  <div className="text-[10px] font-mono" style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</div>
                </div>
                {/* Compact MRAR payload strip */}
                <div className="mt-1.5 bg-slate-900/60 rounded p-1.5 font-mono text-[9px] text-slate-300 leading-tight overflow-x-auto whitespace-nowrap">
                  <span className="text-slate-500">BDS-44 </span>
                  <span className="text-sky-300">FOM</span><span className="text-slate-200">={r.payload.fom}</span>
                  <span className="text-sky-300"> WS</span><span className="text-slate-200">={r.payload.ws}kt</span>
                  <span className="text-sky-300"> WD</span><span className="text-slate-200">={r.payload.wd.toString().padStart(3,'0')}°</span>
                  <span className="text-sky-300"> SAT</span><span className="text-slate-200">={r.payload.sat.toFixed(1)}°C</span>
                  <span className="text-slate-500"> (ΔISA {r.isaDT >= 0 ? '+' : ''}{r.isaDT.toFixed(1)})</span>
                  <span className="text-sky-300"> P</span><span className="text-slate-200">={r.payload.avgP.toFixed(0)}hPa</span>
                  <span className="text-sky-300"> TURB</span><span className="text-slate-200">={r.payload.turb}</span>
                  {r.spec.hasBDS45 && (
                    <>
                      <span className="text-slate-500"> · BDS-45 </span>
                      <span className="text-sky-300">HUM</span><span className="text-slate-200">={r.payload.hum}%</span>
                      <span className="text-sky-300"> ICE</span><span className="text-slate-200">={r.payload.icing}</span>
                      <span className="text-sky-300"> WAKE</span><span className="text-slate-200">={r.payload.wake}</span>
                    </>
                  )}
                  <span className="text-slate-500"> · age={r.payload.ageS}s · {r.region.id}</span>
                </div>
                {/* Drivers */}
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {Object.entries(r.driverScores).map(([k,v]) => (
                    <span key={k} className="text-[9px] px-1 py-0.5 rounded font-mono" style={{ background: v>=50?TIER_COLOR.DEFECTIVE+'22':'#334155', color: v>=50?TIER_COLOR.DEFECTIVE:'#94a3b8' }}>{k} {v.toFixed(0)}</span>
                  ))}
                </div>
                {/* Errors */}
                {r.errors.length > 0 && (
                  <div className="mt-1.5 space-y-0.5">
                    {r.errors.slice(0,3).map((e, i) => (
                      <div key={i} className="text-[9px] leading-tight" style={{ color: e.severity === 'REJ' ? TIER_COLOR.REJECTED : e.severity === 'MAN' ? TIER_COLOR.DEFECTIVE : TIER_COLOR.DEFICIENT }}>
                        <span className="font-mono mr-1">{e.severity}·{e.field}</span>{e.text}
                      </div>
                    ))}
                    {r.errors.length > 3 && (
                      <div className="text-[9px] text-slate-500">… +{r.errors.length-3} more · click SOUNDING tab</div>
                    )}
                  </div>
                )}
                {r.errors.length === 0 && (
                  <div className="mt-1.5 text-[9px] text-emerald-300">› All MRAR fields pass ECMWF 4D-Var assimilation gate</div>
                )}
              </div>
            ))}
            {visible.length > 60 && (
              <div className="text-center text-[9px] text-slate-500 py-2">… +{visible.length-60} more · narrow filters to inspect</div>
            )}
          </>
        )}

        {tab === 'SOUNDING' && pickedRow && (
          <div className="text-[10px] text-slate-300 space-y-1.5">
            <div className="text-[10px] font-mono text-sky-300 mb-1">› {(pickedRow.f.callsign||pickedRow.f.icao).trim()} · {pickedRow.spec.label} · BDS 4,4 / 4,5 full register decode</div>
            {([
              ['BDS-44 · FOM[4]    Figure of Merit',       `${pickedRow.payload.fom}`,                 '0-15 sensor-accuracy class · ECMWF needs ≥6 / NCEP needs ≥8 / EXEMPLARY ≥12 (DO-181E §2.2.18.2.5)'],
              ['BDS-44 · WS[9]     Wind Speed',            `${pickedRow.payload.ws} kt`,               '0-511 kt res 1 kt · jet-stream upper-bound 250 kt'],
              ['BDS-44 · WD[9]     Wind Direction',        `${pickedRow.payload.wd.toString().padStart(3,'0')}°`, '0-511 res 180°/256 ≈ 0.703° · synoptic westerly base in mid-lat'],
              ['BDS-44 · SAT[10]   Static Air Temp',       `${pickedRow.payload.sat.toFixed(2)}°C`,    `0.25°C resolution signed · ISA(F${pickedRow.fl}) = ${isaSAT(pickedRow.fl).toFixed(1)}°C · ΔISA ${pickedRow.isaDT >= 0 ? '+' : ''}${pickedRow.isaDT.toFixed(1)}K`],
              ['BDS-44 · AvgP[11]  Avg Static Pressure',   `${pickedRow.payload.avgP.toFixed(0)} hPa`, `1 hPa res 0-2047 · ISA(F${pickedRow.fl}) = ${isaPressure(pickedRow.fl).toFixed(0)} hPa · ΔISA ${pickedRow.isaDP >= 0 ? '+' : ''}${pickedRow.isaDP.toFixed(0)}`],
              ['BDS-44 · TURB[2]   Turbulence Class',      `${pickedRow.payload.turb}`,                 'NIL / LIGHT / MOD / SEVERE · per RTCA DO-181E §2.2.18'],
              ['BDS-45 · HUM[6]    Humidity %',            `${pickedRow.spec.hasBDS45 ? pickedRow.payload.hum+'%' : '— not supported'}`, 'EUMETNET humidity-OS hygrometer fit · 5% res 0-100%'],
              ['BDS-45 · ICING[2]  Icing Hazard',          `${pickedRow.spec.hasBDS45 ? pickedRow.payload.icing : '— not supported'}`, 'NIL / TRACE / LIGHT / MOD · supercooled-droplet detection FL080-FL250'],
              ['BDS-45 · WAKE[2]   Wake Encounter',        `${pickedRow.spec.hasBDS45 ? pickedRow.payload.wake : '— not supported'}`, 'NIL / LIGHT / MOD · wake-vortex roll moment'],
              ['BDS-45 · MTW[2]    Mountain Wave',         `${pickedRow.spec.hasBDS45 ? pickedRow.payload.mtw : '— not supported'}`, 'NIL / LIGHT / MOD · lee-rotor orographic'],
              ['BDS-45 · VPP[6]    Vertical Pressure',     `${pickedRow.spec.hasBDS45 ? pickedRow.payload.vpp+' hPa' : '— not supported'}`, '±31 hPa res 1 hPa · synoptic-perturbation indicator'],
              ['META · Age',                                `${pickedRow.payload.ageS} s`,              'Time since last Mode-S MRAR interrogation · ECMWF assim gate ≤180s'],
              ['META · Region',                             `${pickedRow.region.id} · ${pickedRow.region.mrarMaturity}%`, pickedRow.region.label],
              ['META · Transponder',                        `${pickedRow.spec.xpdr}`,                    `BDS-44: ${pickedRow.spec.hasBDS44?'YES':'NO'} · BDS-45: ${pickedRow.spec.hasBDS45?'YES':'NO'} · Humidity-OS: ${pickedRow.spec.hasHumidity?'YES':'NO'}`],
              ['META · Vertical Rate',                      `${pickedRow.vsFpm} fpm`,                    'Vertical coverage: ±200 fpm = level cruise (single point); else profile contribution'],
            ] as Array<[string, string, string]>).map(([lab, val, desc], i) => (
              <div key={i} className="bg-slate-800/40 rounded px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-mono text-sky-300 truncate">{lab}</span>
                  <span className="text-[11px] font-mono text-slate-100 truncate">{val || '—'}</span>
                </div>
                <div className="text-[9px] text-slate-500 mt-0.5">{desc}</div>
              </div>
            ))}
          </div>
        )}
        {tab === 'SOUNDING' && !pickedRow && (
          <div className="text-center text-[10px] text-slate-500 py-6">Pick an aircraft on AIRCRAFT tab to see BDS 4,4 / 4,5 register decode</div>
        )}

        {tab === 'COVERAGE' && (
          <div className="text-[10px] text-slate-300 space-y-1.5">
            <div className="text-[10px] font-mono text-sky-300 mb-1">› Mode-S MRAR interrogator-region coverage tally · NWP assimilation contribution</div>
            {REGIONS.map(r => {
              const c = regionCount[r.id]
              const total = c ? c.total : 0
              const mrar = c ? c.mrar : 0
              const ageMu = c && c.total > 0 ? c.ageMu / c.total : 0
              const fomMu = c && c.total > 0 ? c.fomMu / c.total : 0
              const ratio = total > 0 ? (mrar / total) * 100 : 0
              const matCol = r.mrarMaturity > 80 ? TIER_COLOR.EXEMPLARY : r.mrarMaturity > 50 ? TIER_COLOR.ACCEPTED : r.mrarMaturity > 30 ? TIER_COLOR.DEFICIENT : r.mrarMaturity > 0 ? TIER_COLOR.DEFECTIVE : TIER_COLOR.REJECTED
              return (
                <div key={r.id} className="bg-slate-800/40 rounded px-2 py-1.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: matCol+'22', color: matCol }}>{r.mrarMaturity.toString().padStart(2,'0')}%</span>
                      <span className="text-[10px] font-mono text-slate-100">{r.id}</span>
                    </div>
                    <div className="text-[9px] font-mono text-slate-300">{mrar}/{total} ({ratio.toFixed(0)}%)</div>
                  </div>
                  <div className="text-[9px] text-slate-500 mt-0.5 leading-tight">{r.label}</div>
                  {total > 0 && (
                    <div className="mt-1 grid grid-cols-3 gap-1 text-[9px] font-mono">
                      <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">μ-AGE </span><span className="text-slate-200">{ageMu.toFixed(0)}s</span></div>
                      <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">μ-FOM </span><span className="text-slate-200">{fomMu.toFixed(1)}</span></div>
                      <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">MRAR% </span><span className="text-slate-200">{ratio.toFixed(0)}</span></div>
                    </div>
                  )}
                </div>
              )
            })}
            <div className="bg-slate-800/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              <span className="text-sky-300">› EUMETNET E-AMDAR + E-Mode-S 2024 totals:</span> ≈400 M obs/yr ingested into ECMWF IFS · EUR-NORTH+EUR-WEST contribute ≈55% (DFS/NATS/LFV/Avinor mature MRAR query) · NA-EAST+NA-WEST FAA SWRC roll-out ≈20% · Asia/Oceania ≈18% · Oceanic gap remains primary unmet 4D-Var need pending ADS-C/FANS-1A met-report scaling.
            </div>
          </div>
        )}

        {tab === 'FORMAT' && (
          <div className="text-[10px] text-slate-300 space-y-2 leading-snug">
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› BDS 4,4 MRAR · 50-bit Mode-S MB-FIELD payload</div>
              <div className="bg-slate-800/40 rounded p-2 font-mono text-[9px] text-slate-200 leading-relaxed">
                <span className="text-slate-500">Bits</span>  <span className="text-slate-500">Field</span>             <span className="text-slate-500">Size</span>  <span className="text-slate-500">Description</span><br/>
                <span className="text-sky-300">01-05</span>  Format-ID         <span className="text-slate-400">5</span>  Always 00100 (BDS 4,4)<br/>
                <span className="text-sky-300">06-09</span>  FOM               <span className="text-slate-400">4</span>  Figure-of-Merit 0-15<br/>
                <span className="text-sky-300">10-12</span>  Subtype           <span className="text-slate-400">3</span>  Always 011 (routine)<br/>
                <span className="text-sky-300">13</span>     <span className="text-amber-300">Wind-Status</span>       <span className="text-slate-400">1</span>  1 = wind data valid<br/>
                <span className="text-sky-300">14-22</span>  WS                <span className="text-slate-400">9</span>  Wind-Speed 0-511 kt<br/>
                <span className="text-sky-300">23-31</span>  WD                <span className="text-slate-400">9</span>  Wind-Direction 0-359°<br/>
                <span className="text-sky-300">32</span>     <span className="text-amber-300">Temp-Status</span>       <span className="text-slate-400">1</span>  1 = SAT valid<br/>
                <span className="text-sky-300">33-42</span>  SAT               <span className="text-slate-400">10</span> Static-Air-Temp 0.25°C res<br/>
                <span className="text-sky-300">43</span>     <span className="text-amber-300">Press-Status</span>      <span className="text-slate-400">1</span>  1 = Pressure valid<br/>
                <span className="text-sky-300">44-54</span>  AvgP              <span className="text-slate-400">11</span> Avg-Static-Pressure 1hPa res<br/>
                <span className="text-sky-300">55</span>     <span className="text-amber-300">Turb-Status</span>       <span className="text-slate-400">1</span>  1 = Turbulence valid<br/>
                <span className="text-sky-300">56-57</span>  TURB              <span className="text-slate-400">2</span>  Turbulence class 00-11<br/>
                <span className="text-sky-300">58-63</span>  Reserved          <span className="text-slate-400">6</span>  Future expansion (humidity hook)<br/>
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› BDS 4,5 MHR · Meteorological Hazard Report extensions</div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] font-mono">
                {[
                  ['HUM','Humidity % 5% res 0-100% (EUMETNET hum-OS only)'],
                  ['ICING','NIL/TRACE/LIGHT/MOD supercooled-droplet'],
                  ['WAKE','NIL/LIGHT/MOD wake-vortex roll moment'],
                  ['MTW','NIL/LIGHT/MOD mountain-wave lee-rotor'],
                  ['VPP','Vertical-Pressure-Perturbation ±31 hPa'],
                  ['HSPD','Horiz-Wind-Speed alt-encoded backup'],
                  ['HDIR','Horiz-Wind-Dir alt-encoded backup'],
                  ['STAT','MHR status flags 4-bit'],
                ].map(([k,v]) => (
                  <div key={k} className="flex justify-between bg-slate-800/30 rounded px-1 py-0.5">
                    <span className="text-sky-300">{k}</span>
                    <span className="text-slate-300 text-right">{v}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› Mode-S MRAR vs AMDAR · vs RADIOSONDE · vs LIDAR · data-source comparison</div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] font-mono">
                {[
                  ['MRAR','Mode-S BDS 4,4 query · 0.5-30 s latency · global · free'],
                  ['AMDAR','ARINC 620 ACARS · 1-15 min · airline-opt-in · subsidy'],
                  ['TAMDAR','Panasonic ACARS · USA + JP · subscription · humidity'],
                  ['ASAP','UPS humidity-OS prototype 757F fleet'],
                  ['IAGOS','Long-term Cl/H2O/O3 · 12 retrofit aircraft global'],
                  ['Radiosonde','12-hourly 0/12 UTC ≈ 800 stations global'],
                  ['Dropsonde','Hurricane Hunters · USAF/NOAA · ad-hoc'],
                  ['Wind-LIDAR','Aeolus ALADIN satellite L2B · 2018-2023'],
                  ['ASAP-VOS','Voluntary Observing Ships maritime layer'],
                  ['Buoy','Drifting/moored ARGO maritime+sub-surface'],
                ].map(([k,v]) => (
                  <div key={k} className="flex justify-between bg-slate-800/30 rounded px-1 py-0.5">
                    <span className="text-sky-300">{k}</span>
                    <span className="text-slate-300 text-right">{v}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-slate-800/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              <span className="text-sky-300">References:</span> ICAO Doc 9871 Tech-Prov Mode-S App A §A.2.4.4 BDS 4,4 ·
              Annex 10 Vol IV Surveillance & Collision Avoidance · Annex 3 Met §5.5 Aircraft Observations ·
              WMO No.488 AMDAR Guide · WMO IOM-121 Mode-S MRAR Status ·
              RTCA DO-181E Ed.4 §2.2.18 BDS Register Catalogue · EUROCAE ED-73E ·
              EUROCONTROL Mode-S MRAR Implementation Guide ed.4 ·
              ECMWF Tech Memo 833 (Cardinali 2018) Mode-S Wind/Temp Impact on IFS 4D-Var ·
              ECMWF NWP-SAF AMDAR/Mode-S Status Report 2023 ·
              KNMI Tech Report TR-313 (de Haan 2011) Mode-S EHS Met Observations ·
              NOAA NESDIS TAMDAR ATBD · E-AMDAR Programme MAN ed.5 ·
              EUMETNET Mode-S MET data exchange · DWD ICON-EU 3D-Var assimilation ·
              FAA AC 90-114B ADS-B · DO-260C ADS-B MOPS · ARINC 624 OMS.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
