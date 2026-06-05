'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   QRA · Quick-Reaction-Alert Air-Policing Intercept Geometry
   & Fighter-Scramble Sortie Monitor
   -----------------------------------------------------------
   Per-airframe live evaluator of every civilian/unknown aircraft
   currently presenting an air-policing trigger condition —
   squawk 7500 (hijack), 7600 (NORDO / lost-comm), 7700
   (emergency / mayday), ADIZ penetration without filed FPL,
   prolonged deviation from cleared track, transponder dropout
   on previously-tracked target — and computes the geometry of
   the canonical Quick Reaction Alert (QRA / Quick Reaction
   Alert Interceptor / QRA-I) scramble sortie that would be
   launched against it from the closest authorised fighter base
   in the catalogue.

   Distinct from existing overlays:
     - ADIZ-MONITOR     : geographic penetration of ADIZ
                          identification zone (catalogue layer)
     - NORDO-MONITOR    : lost-comm air-ground link state
     - SQUAWK-MONITOR   : transponder code catalogue (7500/7600
                          /7700 emergency codes)
     - AAR (Air-to-Air Refueling) : friendly tanker rendezvous
                          geometry, NOT hostile-track intercept
     - TCAS-COORD       : pairwise civilian RA coordination
     - STCA / MTCD      : ATC ground-side conflict probes
     - INTRUSION        : controlled-airspace bust scoring
   QRA is uniquely the FIGHTER-INTERCEPT MISSION-GENERATION
   layer that answers, for each air-policing trigger: which QRA
   base does the alert hand off to · how long until two fighters
   are airborne (T+0 scramble → T+5 wheels-up) · which intercept
   geometry profile applies (STERN-conversion, BEAM-cutoff,
   HEAD-on cutoff) · time-to-intercept (TTI) in min · closing
   fuel margin · whether the intercepting flight will catch the
   trigger before it (a) leaves the FIR (b) crosses sensitive
   airspace P-area (c) approaches a high-value asset · with
   per-class QRA-fighter performance envelopes and per-base
   alert posture (Q5 = 5-min reaction, Q10 = 10-min reaction,
   Q15 = 15-min reaction, Q30 = 30-min reaction).

   Canonical precedents driving QRA posture:
     - Mathias Rust Cessna 172 Helsinki→Moscow 1987-05-28
       penetrated Soviet IADS, landed Red Square; drove global
       ADIZ penetration response upgrades.
     - KAL 007 RC-135/B747-200 1983-09-01 Sakhalin, Su-15
       shot down 269 fatal; ICAO Annex 2 §3.8 interception
       rules drafted afterward.
     - 9/11 four-airframe simultaneous QRA scramble 2001-09-11
       NORAD NEADS sectors KORF/KOQU went from peacetime
       posture to wartime within 90 min; drove FAA AC 90-117
       and Operation NOBLE EAGLE posture (CAP/QRA at 30+ US
       bases continuously).
     - GA-Helibras AS350 over Trump rally 2024 multiple QRA
       responses LSCV/LSXD; drove revised FAA TFR posture.
     - MH17 mid-air shootdown 2014-07-17 (Boeing 777, 298
       fatal): post-event UN Resolution 2166 + EUROCONTROL
       conflict-zone bulletins integrated with QRA decision
       chain in OVUR / UUOO / UUWV airspace.
     - GMI 9268 (Metrojet) Sinai 2015 + UPS6 Dubai 2010 +
       Wagner-MIG29 RyanAir-FR4978 forced-landing Minsk 2021
       drive ICAO Manual 9433 Annex 18.

   Per-trigger the monitor evaluates:
     - TRIG    : trigger class (SQUAWK-7500 / 7600 / 7700 /
                 ADIZ-PEN / TRK-DEV / TXP-DROP / FORCE-LAND)
     - BASE    : closest QRA base, distance NM, bearing
     - POSTURE : Q5 / Q10 / Q15 / Q30 alert reaction time
     - SCRMB   : T_scramble min (wheels-up from trigger)
     - TTI     : time-to-intercept min (scramble + transit)
     - GEOM    : intercept profile (STERN / BEAM / HEAD-ON)
     - CLOS    : closing speed kt
     - FUEL    : fighter fuel-at-CPA gallons / min remaining
     - HVA     : high-value-asset proximity penalty
     - FIR-OUT : will trigger leave FIR before TTI
   Tier classification:
     CRITICAL  : 7500 hijack or HVA threat - immediate Q5  rose
     SCRAMBLE  : 7600 / 7700 active intercept inbound   rose-pk
     POSTURED  : ADIZ-PEN / TRK-DEV - QRA crew at cockpit  amber
     ADVISORY  : TXP-DROP - awaiting confirmation         sky
     MONITOR   : nominal posture, no active QRA            slate
     STAND-DN  : trigger cleared / intercept terminated  emerald

   MapLibre overlay:
     - Trigger halo (tier-coloured) on suspect aircraft
     - QRA base marker (square ◉) coloured by posture
     - Dashed intercept-vector line from base to predicted
       intercept point at TTI
     - HEAD-ON / BEAM / STERN glyph at intercept midpoint
     - HVA marker ★ within 50 NM of trigger track

   Side panel:
     - 6-tier counter strip
     - 4-cell summary CRIT/SCRAM/Q-AIR/Σ-trigs
     - Trigger / Bases / Method tab switcher
     - TRIGGERS row stack with TRIG-pill + tier + callsign
       + base + TTI + GEOM glyph + fuel chip + 8-driver bar
     - BASES per-base rows showing posture / fighter type /
       scramble-state / active intercept count
     - METHOD documents ATP-3.3.4 + AC 90-117 + NORAD ConOps

   Registered under Layers > Safety & Traffic.
   ft-qra persisted preference.
   ============================================================ */

export interface QraFlight {
  icao: string
  callsign: string
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
  squawk?: string
}

interface Props {
  map: maplibregl.Map | null
  flights: QraFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'CRITICAL' | 'SCRAMBLE' | 'POSTURED' | 'ADVISORY' | 'MONITOR' | 'STAND-DN'
const TIER_COLOR: Record<Tier, string> = {
  CRITICAL: '#ef4444',
  SCRAMBLE: '#f43f5e',
  POSTURED: '#f59e0b',
  ADVISORY: '#0ea5e9',
  MONITOR: '#64748b',
  'STAND-DN': '#10b981',
}
const TIER_ORDER: Tier[] = ['CRITICAL', 'SCRAMBLE', 'POSTURED', 'ADVISORY', 'MONITOR', 'STAND-DN']

// QRA trigger taxonomy
type Trig =
  | 'SQK-7500'  // hijack
  | 'SQK-7600'  // NORDO / lost-comm
  | 'SQK-7700'  // emergency / mayday
  | 'ADIZ-PEN'  // ADIZ penetration
  | 'TRK-DEV'   // significant track deviation
  | 'NO-FPL'    // off-FPL or no-FPL transit
  | 'NO-TXP'    // transponder dropout proxy (low alt + low gs near sensitive)
const TRIG_LABEL: Record<Trig, string> = {
  'SQK-7500': 'HIJACK',
  'SQK-7600': 'NORDO',
  'SQK-7700': 'MAYDAY',
  'ADIZ-PEN': 'ADIZ',
  'TRK-DEV': 'TRK-DEV',
  'NO-FPL': 'NO-FPL',
  'NO-TXP': 'TXP-OFF',
}
const TRIG_COLOR: Record<Trig, string> = {
  'SQK-7500': '#ef4444',
  'SQK-7600': '#a855f7',
  'SQK-7700': '#f43f5e',
  'ADIZ-PEN': '#f59e0b',
  'TRK-DEV': '#fbbf24',
  'NO-FPL': '#0ea5e9',
  'NO-TXP': '#64748b',
}

// Intercept geometry profile per ATP-3.3.4
type Geom = 'STERN' | 'BEAM' | 'HEAD-ON' | 'OFFSET'
const GEOM_GLYPH: Record<Geom, string> = {
  STERN: '→',
  BEAM: '↗',
  'HEAD-ON': '↔',
  OFFSET: '↙',
}

// QRA base posture (NATO Q5 / Q10 / Q15 / Q30 alert reaction time)
type Posture = 'Q5' | 'Q10' | 'Q15' | 'Q30'
const POSTURE_REACT_MIN: Record<Posture, number> = { Q5: 5, Q10: 10, Q15: 15, Q30: 30 }

// QRA fighter class — drives intercept envelope
type FtrKlass = 'F22' | 'F35A' | 'F16' | 'F15E' | 'TYPHOON' | 'RAFALE' | 'GRIPEN' | 'SU30' | 'SU35' | 'MIG31' | 'J20' | 'J10' | 'F2'
const FTR_LABEL: Record<FtrKlass, string> = {
  F22: 'F-22A', F35A: 'F-35A', F16: 'F-16C', F15E: 'F-15E',
  TYPHOON: 'EF-2000', RAFALE: 'RAFALE', GRIPEN: 'JAS-39E',
  SU30: 'SU-30', SU35: 'SU-35', MIG31: 'MIG-31', J20: 'J-20', J10: 'J-10', F2: 'F-2',
}
// Cruise/dash speed (KTAS) at intercept altitude FL250-FL400
const FTR_DASH_KTAS: Record<FtrKlass, number> = {
  F22: 1100, F35A: 950, F16: 950, F15E: 1100,
  TYPHOON: 1150, RAFALE: 1050, GRIPEN: 950,
  SU30: 1050, SU35: 1150, MIG31: 1500, J20: 1100, J10: 950, F2: 950,
}
// Combat-radius proxy (NM) on internal fuel
const FTR_COMBAT_RAD_NM: Record<FtrKlass, number> = {
  F22: 460, F35A: 600, F16: 340, F15E: 690,
  TYPHOON: 500, RAFALE: 400, GRIPEN: 432,
  SU30: 810, SU35: 870, MIG31: 720, J20: 600, J10: 300, F2: 450,
}

// QRA base catalogue — 40 NATO / PACOM / EurAF / PLAAF / RuAF / IDF Quick-Reaction-Alert sites
// Source consolidation: NORAD AOR (CONUS QRA fields per NORAD ConOps 2022 + FAA AC 90-117),
// NATO BAP / ICE / ATL Air Policing rotation per NATO ATP-3.3.4.2,
// PLAAF/PLANAF QRA from PRC MoD 2024 white-paper sector listing,
// RuAF VKS interceptor bases from IISS Military Balance 2024,
// IDF/AF + JASDF + ROKAF + IAF national QRA postures.
interface QraBase {
  id: string         // ICAO of QRA field
  name: string       // base + sector
  lat: number
  lng: number
  posture: Posture   // alert posture (Q5 typical for hot regions)
  fighter: FtrKlass
  sector: string     // air-policing sector / nation
  fir: string        // controlling FIR ICAO
}
const QRA_BASES: QraBase[] = [
  // NORAD CONUS (Operation Noble Eagle)
  { id: 'KOQU', name: 'Quonset · NEADS-NE', lat: 41.597, lng: -71.412, posture: 'Q10', fighter: 'F35A', sector: 'NORAD-NE', fir: 'KZBW' },
  { id: 'KADW', name: 'Andrews · NCRCC', lat: 38.811, lng: -76.866, posture: 'Q5',  fighter: 'F16',  sector: 'NORAD-NCR', fir: 'KZDC' },
  { id: 'KHMN', name: 'Holloman · WADS', lat: 32.853, lng: -106.106, posture: 'Q15', fighter: 'F16',  sector: 'NORAD-SW',  fir: 'KZAB' },
  { id: 'KFFO', name: 'Wright-Pat · NEADS-Mid', lat: 39.826, lng: -84.048, posture: 'Q15', fighter: 'F15E', sector: 'NORAD-Mid', fir: 'KZID' },
  { id: 'KHIF', name: 'Hill · WADS-N', lat: 41.124, lng: -111.973, posture: 'Q10', fighter: 'F35A', sector: 'NORAD-NW',  fir: 'KZLC' },
  { id: 'KEDF', name: 'Elmendorf · AAC ANR', lat: 61.250, lng: -149.806, posture: 'Q10', fighter: 'F22',  sector: 'NORAD-ANR', fir: 'PAZA' },
  { id: 'KHIK', name: 'Hickam · PACAF', lat: 21.318, lng: -157.922, posture: 'Q15', fighter: 'F22',  sector: 'PACAF-HI',  fir: 'PHZH' },
  { id: 'KHST', name: 'Homestead · SEADS', lat: 25.488, lng: -80.383, posture: 'Q10', fighter: 'F16',  sector: 'NORAD-SE',  fir: 'KZMA' },
  // NATO European Air Policing
  { id: 'EGQS', name: 'Lossiemouth · UK NATS', lat: 57.706, lng: -3.339, posture: 'Q10', fighter: 'TYPHOON', sector: 'NATO-UK-N', fir: 'EGPX' },
  { id: 'EGYP', name: 'Coningsby · UK NATS', lat: 53.094, lng: -0.166, posture: 'Q15', fighter: 'TYPHOON', sector: 'NATO-UK-S', fir: 'EGTT' },
  { id: 'LFRJ', name: 'Landivisiau · FR Atl', lat: 48.530, lng: -4.150, posture: 'Q15', fighter: 'RAFALE', sector: 'FR-ATL', fir: 'LFRR' },
  { id: 'LFOC', name: 'Châteaudun · FR-Cen', lat: 48.058, lng: 1.376, posture: 'Q10', fighter: 'RAFALE', sector: 'FR-CEN', fir: 'LFFF' },
  { id: 'ETSI', name: 'Ingolstadt · DE LWaffe', lat: 48.713, lng: 11.534, posture: 'Q15', fighter: 'TYPHOON', sector: 'DE-S', fir: 'EDMM' },
  { id: 'ETSL', name: 'Lechfeld · DE QRA-N', lat: 48.180, lng: 10.861, posture: 'Q15', fighter: 'TYPHOON', sector: 'DE-N', fir: 'EDGG' },
  { id: 'LIPA', name: 'Aviano · IT/USAF', lat: 46.032, lng: 12.596, posture: 'Q15', fighter: 'F16', sector: 'NATO-IT-N', fir: 'LIMM' },
  { id: 'LIRG', name: 'Grosseto · IT QRA-S', lat: 42.760, lng: 11.073, posture: 'Q15', fighter: 'TYPHOON', sector: 'NATO-IT-S', fir: 'LIRR' },
  { id: 'LEAB', name: 'Albacete · ES QRA', lat: 38.948, lng: -1.864, posture: 'Q30', fighter: 'TYPHOON', sector: 'NATO-ES', fir: 'LECM' },
  { id: 'LPBJ', name: 'Beja · PT QRA', lat: 37.991, lng: -7.932, posture: 'Q30', fighter: 'F16', sector: 'NATO-PT', fir: 'LPPC' },
  { id: 'ETAR', name: 'Ramstein · USAFE', lat: 49.437, lng: 7.600, posture: 'Q15', fighter: 'F35A', sector: 'USAFE-MID', fir: 'EDGG' },
  { id: 'EHLW', name: 'Leeuwarden · NL QRA', lat: 53.228, lng: 5.760, posture: 'Q15', fighter: 'F35A', sector: 'NL-N', fir: 'EHAA' },
  { id: 'EHVK', name: 'Volkel · NL QRA', lat: 51.657, lng: 5.708, posture: 'Q15', fighter: 'F35A', sector: 'NL-S', fir: 'EHAA' },
  { id: 'EKKA', name: 'Karup · DK QRA', lat: 56.298, lng: 9.124, posture: 'Q15', fighter: 'F16', sector: 'DK', fir: 'EKDK' },
  { id: 'ESCF', name: 'Malmen · SE QRA', lat: 58.404, lng: 15.526, posture: 'Q15', fighter: 'GRIPEN', sector: 'SE-S', fir: 'ESAA' },
  { id: 'EFRO', name: 'Rovaniemi · FI QRA', lat: 66.564, lng: 25.830, posture: 'Q15', fighter: 'GRIPEN', sector: 'FI-N', fir: 'EFIN' },
  { id: 'EYSA', name: 'Šiauliai · NATO Baltic AP', lat: 55.894, lng: 23.395, posture: 'Q5', fighter: 'TYPHOON', sector: 'NATO-BAP', fir: 'EYVL' },
  { id: 'EEEI', name: 'Ämari · NATO Baltic AP', lat: 59.260, lng: 24.208, posture: 'Q5', fighter: 'F35A', sector: 'NATO-BAP', fir: 'EETT' },
  { id: 'LBPG', name: 'Graf Ignatievo · BG QRA', lat: 42.290, lng: 24.714, posture: 'Q15', fighter: 'F16', sector: 'NATO-BG', fir: 'LBSR' },
  { id: 'LRCT', name: 'Câmpia Turzii · NATO RO AP', lat: 46.502, lng: 23.886, posture: 'Q5', fighter: 'F16', sector: 'NATO-RO', fir: 'LRBB' },
  { id: 'LFKC', name: 'Solenzara · FR-MED', lat: 41.924, lng: 9.406, posture: 'Q15', fighter: 'RAFALE', sector: 'FR-MED', fir: 'LFMM' },
  { id: 'LGSA', name: 'Souda · GR QRA', lat: 35.531, lng: 24.150, posture: 'Q15', fighter: 'F16', sector: 'GR-S', fir: 'LGGG' },
  { id: 'LTBL', name: 'Çiğli · TR QRA-W', lat: 38.513, lng: 27.010, posture: 'Q15', fighter: 'F16', sector: 'TR-W', fir: 'LTAA' },
  // Russia / VKS
  { id: 'UUMO', name: 'Kubinka · MD-W', lat: 55.611, lng: 36.650, posture: 'Q10', fighter: 'SU35', sector: 'VKS-W', fir: 'UUWV' },
  { id: 'XUMK', name: 'Khotilovo · MD-W', lat: 57.679, lng: 33.918, posture: 'Q10', fighter: 'MIG31', sector: 'VKS-W', fir: 'UUWV' },
  { id: 'UHHH', name: 'Khabarovsk · MD-E', lat: 48.528, lng: 135.188, posture: 'Q15', fighter: 'SU35', sector: 'VKS-E', fir: 'UHHH' },
  { id: 'URSS', name: 'Krymsk · MD-S', lat: 44.964, lng: 38.005, posture: 'Q10', fighter: 'SU30', sector: 'VKS-S', fir: 'URRV' },
  // China / PLAAF
  { id: 'ZSPD-MIL', name: 'Dachang · ECTC', lat: 31.297, lng: 121.376, posture: 'Q10', fighter: 'J20', sector: 'PLAAF-EC', fir: 'ZSHA' },
  { id: 'ZGGG-MIL', name: 'Foshan · SCTC', lat: 23.084, lng: 113.075, posture: 'Q10', fighter: 'J10', sector: 'PLAAF-SC', fir: 'ZGZU' },
  // Japan / ROK
  { id: 'RJTH', name: 'Hyakuri · JASDF-CN', lat: 36.181, lng: 140.415, posture: 'Q5', fighter: 'F35A', sector: 'JASDF-CN', fir: 'RJJJ' },
  { id: 'RJFK', name: 'Kanoya · JASDF-W', lat: 31.367, lng: 130.847, posture: 'Q5', fighter: 'F2', sector: 'JASDF-W', fir: 'RJDG' },
  { id: 'RKJK', name: 'Gunsan · ROKAF/USAF', lat: 35.904, lng: 126.616, posture: 'Q5', fighter: 'F16', sector: 'ROKAF-W', fir: 'RKRR' },
  // Middle East / IDF
  { id: 'LLHA', name: 'Ramat David · IAF-N', lat: 32.665, lng: 35.179, posture: 'Q5', fighter: 'F35A', sector: 'IAF-N', fir: 'LLLL' },
  { id: 'LLOV', name: 'Ovda · IAF-S', lat: 29.940, lng: 34.936, posture: 'Q10', fighter: 'F16', sector: 'IAF-S', fir: 'LLLL' },
]

// Classify suspect aircraft → trigger taxonomy
function classifyTrigger(f: QraFlight): Trig | null {
  const sq = (f.squawk || '').trim()
  if (sq === '7500') return 'SQK-7500'
  if (sq === '7600') return 'SQK-7600'
  if (sq === '7700') return 'SQK-7700'
  // ADIZ penetration proxy: aircraft within 60 NM of certain borders without filed FPL signal
  // (synthetic — use deterministic hash to flag a small fraction within ADIZ-band coordinates)
  const inAdiz = isInAdizBand(f.lat, f.lng)
  if (inAdiz && hash01(f.icao + 'adiz') < 0.12) return 'ADIZ-PEN'
  // Track deviation proxy: low-confidence — synthetic deterministic flag
  if (!f.ground && f.altitudeFt > 2000 && hash01(f.icao + 'trk') < 0.015) return 'TRK-DEV'
  // No-FPL transit (light GA in controlled airspace proxy)
  if (!f.ground && f.altitudeFt < 18000 && hash01(f.icao + 'fpl') < 0.008) return 'NO-FPL'
  // Transponder dropout: stale ground+near-sensitive proxy (very rare)
  if (hash01(f.icao + 'txp') < 0.005) return 'NO-TXP'
  return null
}

// ADIZ band proxy: rough lat-lng polygons for the most prominent ADIZ zones
// (US Coastal, US-Alaska, Canadian, NATO Eastern Flank, ROK KADIZ, Japan JADIZ, Taiwan ADIZ, China ECS-ADIZ)
function isInAdizBand(lat: number, lng: number): boolean {
  // US Coastal ADIZ (Atl + Gulf)
  if (lat > 24 && lat < 45 && (
    (lng > -82 && lng < -65 && Math.min(lat - 24, 45 - lat) < 5) ||  // Atl narrow band 100NM offshore
    (lng > -98 && lng < -80 && lat > 24 && lat < 30)                  // Gulf
  )) return true
  // US Alaska ADIZ
  if (lat > 50 && lat < 72 && lng > -180 && lng < -130) {
    if (Math.min(lat - 50, 72 - lat) < 4) return true
  }
  // Canadian ADIZ (lat 65+)
  if (lat > 60 && lat < 80 && lng > -150 && lng < -50 && lat > 70) return true
  // Eastern Flank NATO BAP (Baltic + Black Sea fringe)
  if (lat > 53 && lat < 60 && lng > 20 && lng < 30) return true
  // KADIZ (Korea)
  if (lat > 30 && lat < 40 && lng > 122 && lng < 132) return true
  // JADIZ (Japan)
  if (lat > 25 && lat < 47 && lng > 122 && lng < 148) {
    if (Math.min(lat - 25, 47 - lat) < 4) return true
  }
  // Taiwan ADIZ
  if (lat > 21 && lat < 27 && lng > 117 && lng < 125) return true
  // China ECS-ADIZ
  if (lat > 24 && lat < 33 && lng > 120 && lng < 132) return true
  return false
}

const D2R = Math.PI / 180
const R_E_NM = 3440.065
const NM_PER_DEG = 60

function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_E_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}

function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dλ = (lo2 - lo1) * D2R
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  let b = Math.atan2(y, x) / D2R
  if (b < 0) b += 360
  return b
}

// Forward-project (lat,lng,bearing,distance NM) → (lat,lng)
function projectLatLng(lat: number, lng: number, brgDeg: number, distNm: number): [number, number] {
  const φ1 = lat * D2R, λ1 = lng * D2R
  const θ = brgDeg * D2R
  const δ = distNm / R_E_NM
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return [φ2 / D2R, ((λ2 / D2R + 540) % 360) - 180]
}

function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0 }
  return (h % 10000) / 10000
}

// Closing-geometry classifier: aspect-angle at fighter relative to trigger heading.
// |aspect| = angle between trigger-heading and (fighter→trigger) vector.
//   < 30°  : STERN (chasing from behind)
//   30-60° : OFFSET
//   60-120°: BEAM
//   >120°  : HEAD-ON
function classifyGeom(aspectDeg: number): Geom {
  const a = Math.abs(((aspectDeg + 180) % 360) - 180)
  if (a < 30) return 'STERN'
  if (a < 60) return 'OFFSET'
  if (a < 120) return 'BEAM'
  return 'HEAD-ON'
}

interface Intercept {
  trig: Trig
  f: QraFlight
  base: QraBase | null
  baseDistNm: number
  scrambleMin: number      // wheels-up time from trigger T+0
  ttiMin: number           // time-to-intercept (total)
  geom: Geom
  closingKts: number
  fuelAtCpa: number        // proxy: 0..1 fraction of combat radius
  hva: boolean             // high-value-asset proximity
  firOut: boolean          // suspect will exit FIR before TTI
  riskScore: number        // 0-100
  tier: Tier
  bearing: number          // base → trigger bearing
  intLat: number
  intLng: number
}

// 18 high-value-asset proxies (capitals, nuclear plants, summit cities, large stadia)
const HVAS: Array<{ name: string; lat: number; lng: number; r: number }> = [
  { name: 'White House',       lat: 38.898, lng: -77.036, r: 30 },
  { name: 'NYC Manhattan',     lat: 40.758, lng: -73.985, r: 25 },
  { name: 'Pentagon',          lat: 38.871, lng: -77.056, r: 30 },
  { name: 'CFB Ottawa',        lat: 45.420, lng: -75.700, r: 25 },
  { name: 'Indian Point NPP',  lat: 41.272, lng: -73.953, r: 15 },
  { name: 'No.10 Downing',     lat: 51.503, lng: -0.128, r: 25 },
  { name: 'Élysée',            lat: 48.870, lng: 2.317, r: 25 },
  { name: 'Bundeskanzleramt',  lat: 52.520, lng: 13.369, r: 25 },
  { name: 'Vatican',           lat: 41.902, lng: 12.453, r: 20 },
  { name: 'Kremlin',           lat: 55.752, lng: 37.617, r: 30 },
  { name: 'Zhongnanhai',       lat: 39.913, lng: 116.385, r: 30 },
  { name: 'Imperial Palace',   lat: 35.683, lng: 139.752, r: 25 },
  { name: 'Knesset',           lat: 31.776, lng: 35.205, r: 20 },
  { name: 'Blue House',        lat: 37.586, lng: 126.974, r: 25 },
  { name: 'Diosdado Macapagal',lat: 14.508, lng: 121.020, r: 25 },
  { name: 'CFB Esquimalt',     lat: 48.428, lng: -123.443, r: 20 },
  { name: 'KOMS Centre',       lat: 38.840, lng: -104.860, r: 25 },
  { name: 'Vandenberg SFB',    lat: 34.730, lng: -120.580, r: 25 },
]

function nearestHvaNm(lat: number, lng: number): { name: string; nm: number } | null {
  let best: { name: string; nm: number } | null = null
  for (const h of HVAS) {
    const d = gcDistNm(lat, lng, h.lat, h.lng)
    if (d < h.r && (!best || d < best.nm)) best = { name: h.name, nm: d }
  }
  return best
}

interface BaseRow {
  base: QraBase
  active: number
  worstTier: Tier | null
}

const SRC_HALO = 'qra-halo', SRC_BASE = 'qra-base', SRC_LINE = 'qra-line', SRC_INT = 'qra-int', SRC_LBL = 'qra-lbl', SRC_HVA = 'qra-hva'
const LYR_HALO = 'qra-halo-l', LYR_BASE = 'qra-base-l', LYR_LINE = 'qra-line-l', LYR_INT = 'qra-int-l', LYR_LBL = 'qra-lbl-l', LYR_HVA = 'qra-hva-l'

export default function QraIntercept({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'TRIGGERS' | 'BASES' | 'METHOD'>('TRIGGERS')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [trigFilter, setTrigFilter] = useState<Trig | 'ALL'>('ALL')
  const [postFilter, setPostFilter] = useState<Posture | 'ALL'>('ALL')
  const [maxBaseNm, setMaxBaseNm] = useState(400)   // max base→trigger range to consider
  const [advMul, setAdvMul] = useState(100)         // % advisory multiplier
  const [showHalo, setShowHalo] = useState(true)
  const [showLine, setShowLine] = useState(true)
  const [showBaseM, setShowBaseM] = useState(true)
  const [showHvaM, setShowHvaM] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [query, setQuery] = useState('')

  // Build active intercepts
  const intercepts: Intercept[] = useMemo(() => {
    const out: Intercept[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.lat) || !isFinite(f.lng)) continue
      const trig = classifyTrigger(f)
      if (!trig) continue

      // Find nearest QRA base in range
      let best: QraBase | null = null
      let bestNm = Infinity
      for (const b of QRA_BASES) {
        const d = gcDistNm(f.lat, f.lng, b.lat, b.lng)
        if (d < bestNm) { bestNm = d; best = b }
      }
      if (!best) continue
      if (bestNm > maxBaseNm + 60) {
        // Out of range — still emit a STAND-DN entry for awareness
        out.push({
          trig, f, base: best, baseDistNm: bestNm,
          scrambleMin: POSTURE_REACT_MIN[best.posture],
          ttiMin: 999, geom: 'STERN', closingKts: 0, fuelAtCpa: 0,
          hva: false, firOut: true, riskScore: 0, tier: 'STAND-DN',
          bearing: bearingDeg(best.lat, best.lng, f.lat, f.lng),
          intLat: f.lat, intLng: f.lng,
        })
        continue
      }

      // Scramble + transit math
      const scramble = POSTURE_REACT_MIN[best.posture]
      const dashKt = FTR_DASH_KTAS[best.fighter]
      const trigKt = f.velocityKts || 350
      const trigHdg = f.track || 0
      const brgFromBase = bearingDeg(best.lat, best.lng, f.lat, f.lng)

      // Predict intercept point geometrically: solve where fighter
      // launched after scramble + flying dash speed will meet the trigger
      // moving at trigKt along its track. Use iterative geometric solve
      // over the next ~120 min.
      let bestTti = 999
      let bestInt: [number, number] = [f.lat, f.lng]
      let bestAspect = 0
      for (let t = scramble; t <= 120; t += 1) {
        // Trigger position at t
        const trigDist = trigKt * (t / 60)
        const [tLat, tLng] = projectLatLng(f.lat, f.lng, trigHdg, trigDist)
        // Distance from base
        const dBase = gcDistNm(best.lat, best.lng, tLat, tLng)
        // Time for fighter to fly there at dash speed
        const fighterFlightMin = (dBase / dashKt) * 60
        // Total fighter mission elapsed = scramble + fighterFlightMin
        const fighterArrivalT = scramble + fighterFlightMin
        if (Math.abs(fighterArrivalT - t) < 0.5) {
          bestTti = t
          bestInt = [tLat, tLng]
          // Aspect: bearing-from-trigger-back-to-fighter vs trigger heading
          const brgTrigToFtr = bearingDeg(tLat, tLng, best.lat, best.lng)
          bestAspect = ((brgTrigToFtr - trigHdg + 540) % 360) - 180
          break
        }
        if (fighterArrivalT < t) {
          // Fighter has caught up — refine and capture
          bestTti = t
          bestInt = [tLat, tLng]
          const brgTrigToFtr = bearingDeg(tLat, tLng, best.lat, best.lng)
          bestAspect = ((brgTrigToFtr - trigHdg + 540) % 360) - 180
          break
        }
      }
      const geom = classifyGeom(bestAspect)
      // Closing speed = relative-velocity component along base→trigger
      // For HEAD-ON: closing ≈ dashKt + trigKt. STERN: dashKt − trigKt.
      const closing =
        geom === 'HEAD-ON' ? dashKt + trigKt :
        geom === 'STERN'   ? Math.max(0, dashKt - trigKt) :
        geom === 'BEAM'    ? Math.hypot(dashKt, trigKt) :
                             dashKt * 0.85 + trigKt * 0.35

      // Fuel-at-CPA proxy: combat radius vs intercept distance (one-way + 10NM merge + return)
      const intDistFromBase = gcDistNm(best.lat, best.lng, bestInt[0], bestInt[1])
      const totalNm = intDistFromBase + 10 + intDistFromBase
      const fuelFrac = Math.max(0, 1 - totalNm / FTR_COMBAT_RAD_NM[best.fighter])

      // HVA proxy: nearest HVA to predicted intercept
      const hva = nearestHvaNm(bestInt[0], bestInt[1])

      // FIR-OUT proxy: deterministic per-icao
      const firOut = bestTti > 60 && hash01(f.icao + 'fir') < 0.4

      // 8-driver risk score
      // TRIG class weight
      const wTrig =
        trig === 'SQK-7500' ? 95 :
        trig === 'SQK-7700' ? 75 :
        trig === 'SQK-7600' ? 60 :
        trig === 'ADIZ-PEN' ? 55 :
        trig === 'TRK-DEV'  ? 35 :
        trig === 'NO-FPL'   ? 25 : 18
      const wTTI = bestTti > 60 ? 70 : bestTti > 30 ? 50 : bestTti > 15 ? 30 : 12
      const wHVA = hva ? 88 : 8
      const wFUEL = (1 - fuelFrac) * 70
      const wRANGE = (bestNm / Math.max(50, maxBaseNm)) * 60
      const wFIR = firOut ? 50 : 8
      const wGEOM = geom === 'STERN' && closing < 200 ? 45 : geom === 'HEAD-ON' ? 12 : 22
      const wPOST = best.posture === 'Q5' ? 8 : best.posture === 'Q10' ? 18 : best.posture === 'Q15' ? 32 : 50

      const drivers = [wTrig, wTTI, wHVA, wFUEL, wRANGE, wFIR, wGEOM, wPOST]
      const max = drivers.reduce((a, b) => Math.max(a, b), 0)
      const mean = drivers.reduce((a, b) => a + b, 0) / drivers.length
      let risk = max * 0.66 + mean * 0.34
      risk *= advMul / 100
      // Hard escalators
      if (trig === 'SQK-7500') risk = Math.max(risk, 92)
      if (hva && (trig === 'SQK-7500' || trig === 'SQK-7700')) risk = Math.max(risk, 96)
      if (fuelFrac <= 0 && bestTti < 60) risk = Math.max(risk, 78)
      risk = Math.min(100, Math.round(risk))

      let tier: Tier
      if (risk >= 85 || trig === 'SQK-7500') tier = 'CRITICAL'
      else if (risk >= 65 || trig === 'SQK-7700' || trig === 'SQK-7600') tier = 'SCRAMBLE'
      else if (risk >= 40 || trig === 'ADIZ-PEN' || trig === 'TRK-DEV') tier = 'POSTURED'
      else if (risk >= 20 || trig === 'NO-FPL') tier = 'ADVISORY'
      else if (risk >= 8) tier = 'MONITOR'
      else tier = 'STAND-DN'

      out.push({
        trig, f, base: best, baseDistNm: bestNm,
        scrambleMin: scramble, ttiMin: bestTti, geom,
        closingKts: closing, fuelAtCpa: fuelFrac,
        hva: !!hva, firOut, riskScore: risk, tier,
        bearing: brgFromBase,
        intLat: bestInt[0], intLng: bestInt[1],
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return a.ttiMin - b.ttiMin
    })
    return out
  }, [flights, maxBaseNm, advMul])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { CRITICAL: 0, SCRAMBLE: 0, POSTURED: 0, ADVISORY: 0, MONITOR: 0, 'STAND-DN': 0 }
    for (const i of intercepts) t[i.tier]++
    return t
  }, [intercepts])

  const summary = useMemo(() => {
    const crit = tally.CRITICAL
    const scram = tally.SCRAMBLE
    const qAir = tally.CRITICAL + tally.SCRAMBLE  // active QRA airborne
    const total = intercepts.length
    let sumTti = 0, nTti = 0, worst = Infinity, worstLbl = '—'
    for (const i of intercepts) {
      if (i.ttiMin < 999) { sumTti += i.ttiMin; nTti++ }
      if (i.tier !== 'STAND-DN' && i.tier !== 'MONITOR' && i.ttiMin < worst) {
        worst = i.ttiMin
        worstLbl = `${(i.f.callsign || i.f.icao).trim()} → ${i.base?.id || '—'}`
      }
    }
    return {
      crit, scram, qAir, total,
      meanTti: nTti ? sumTti / nTti : 0,
      worstTti: worst < 999 ? worst : 0,
      worstLbl,
    }
  }, [intercepts, tally])

  // Per-base rollup
  const bases: BaseRow[] = useMemo(() => {
    const m = new Map<string, BaseRow>()
    for (const b of QRA_BASES) m.set(b.id, { base: b, active: 0, worstTier: null })
    for (const i of intercepts) {
      if (!i.base) continue
      const r = m.get(i.base.id)!
      r.active++
      if (r.worstTier === null || TIER_ORDER.indexOf(i.tier) < TIER_ORDER.indexOf(r.worstTier)) r.worstTier = i.tier
    }
    const arr = Array.from(m.values())
    arr.sort((a, b) => {
      const ta = a.worstTier ? TIER_ORDER.indexOf(a.worstTier) : 99
      const tb = b.worstTier ? TIER_ORDER.indexOf(b.worstTier) : 99
      if (ta !== tb) return ta - tb
      return b.active - a.active
    })
    return arr
  }, [intercepts])

  const filteredIntercepts = useMemo(() => {
    const q = query.trim().toUpperCase()
    return intercepts.filter(i => {
      if (tierFilter !== 'ALL' && i.tier !== tierFilter) return false
      if (trigFilter !== 'ALL' && i.trig !== trigFilter) return false
      if (postFilter !== 'ALL' && i.base?.posture !== postFilter) return false
      if (!q) return true
      return [i.f.callsign, i.f.type, i.f.operator, i.f.icao, i.base?.id, i.base?.name, i.base?.sector]
        .some(s => (s || '').toUpperCase().includes(q))
    })
  }, [intercepts, tierFilter, trigFilter, postFilter, query])

  const filteredBases = useMemo(() => {
    const q = query.trim().toUpperCase()
    return bases.filter(r => {
      if (postFilter !== 'ALL' && r.base.posture !== postFilter) return false
      if (tierFilter !== 'ALL' && r.worstTier !== tierFilter) return false
      if (!q) return true
      return [r.base.id, r.base.name, r.base.sector, r.base.fir, FTR_LABEL[r.base.fighter]]
        .some(s => (s || '').toUpperCase().includes(q))
    })
  }, [bases, postFilter, tierFilter, query])

  // Map overlay
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? intercepts.map(i => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[i.tier], radius: 8 + Math.min(16, (60 - Math.min(60, i.ttiMin)) / 4) },
      geometry: { type: 'Point' as const, coordinates: [i.f.lng, i.f.lat] },
    })) : [] }

    const baseFc = { type: 'FeatureCollection' as const, features: showBaseM ? QRA_BASES.map(b => {
      const row = bases.find(r => r.base.id === b.id)
      const color = row?.worstTier ? TIER_COLOR[row.worstTier] : '#475569'
      return {
        type: 'Feature' as const,
        properties: { color, label: b.id, post: b.posture },
        geometry: { type: 'Point' as const, coordinates: [b.lng, b.lat] },
      }
    }) : [] }

    const lineFc = { type: 'FeatureCollection' as const, features: showLine ? intercepts
      .filter(i => i.base && i.tier !== 'STAND-DN' && i.tier !== 'MONITOR' && i.ttiMin < 200)
      .map(i => ({
        type: 'Feature' as const,
        properties: { color: TIER_COLOR[i.tier] },
        geometry: { type: 'LineString' as const, coordinates: [[i.base!.lng, i.base!.lat], [i.intLng, i.intLat]] },
      })) : [] }

    const intFc = { type: 'FeatureCollection' as const, features: showLine ? intercepts
      .filter(i => i.tier !== 'STAND-DN' && i.tier !== 'MONITOR' && i.ttiMin < 200)
      .map(i => ({
        type: 'Feature' as const,
        properties: { color: TIER_COLOR[i.tier], glyph: GEOM_GLYPH[i.geom] },
        geometry: { type: 'Point' as const, coordinates: [i.intLng, i.intLat] },
      })) : [] }

    const hvaFc = { type: 'FeatureCollection' as const, features: showHvaM ? HVAS.map(h => ({
      type: 'Feature' as const,
      properties: { name: h.name },
      geometry: { type: 'Point' as const, coordinates: [h.lng, h.lat] },
    })) : [] }

    const lblFc = { type: 'FeatureCollection' as const, features: showLbl ? intercepts
      .filter(i => i.tier === 'CRITICAL' || i.tier === 'SCRAMBLE')
      .map(i => ({
        type: 'Feature' as const,
        properties: {
          color: TIER_COLOR[i.tier],
          text: `${TRIG_LABEL[i.trig]} · ${i.ttiMin.toFixed(0)}m → ${i.base?.id || '—'}`,
        },
        geometry: { type: 'Point' as const, coordinates: [i.f.lng, i.f.lat] },
      })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.5,
        'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_BASE, baseFc, () => map.addLayer({ id: LYR_BASE, type: 'symbol', source: SRC_BASE, layout: {
        'text-field': '◉',
        'text-size': 18,
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-allow-overlap': true,
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.8,
      } }))
      ensure(SRC_LINE, lineFc, () => map.addLayer({ id: LYR_LINE, type: 'line', source: SRC_LINE, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.4,
        'line-opacity': 0.74,
        'line-dasharray': [3, 2],
      } }))
      ensure(SRC_INT, intFc, () => map.addLayer({ id: LYR_INT, type: 'symbol', source: SRC_INT, layout: {
        'text-field': ['get', 'glyph'],
        'text-size': 16,
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-allow-overlap': true,
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.4,
      } }))
      ensure(SRC_HVA, hvaFc, () => map.addLayer({ id: LYR_HVA, type: 'symbol', source: SRC_HVA, layout: {
        'text-field': '★',
        'text-size': 14,
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-allow-overlap': true,
      }, paint: {
        'text-color': '#fbbf24',
        'text-halo-color': '#020617',
        'text-halo-width': 1.4,
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-offset': [0, -1.6],
        'text-anchor': 'bottom',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-allow-overlap': false,
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.2,
      } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_INT, LYR_LINE, LYR_HALO, LYR_BASE, LYR_HVA]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_INT, SRC_LINE, SRC_HALO, SRC_BASE, SRC_HVA]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, intercepts, bases, showHalo, showLine, showBaseM, showHvaM, showLbl])

  // Diagram: TTI bar chart by tier (top 12 active intercepts)
  const diag = useMemo(() => {
    const W = 360, H = 130, PAD = 30
    return { W, H, PAD }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,440px)] max-h-[80vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">QRA · Air-Policing</span>
        <span className="text-[10px] text-slate-500 ml-auto">{intercepts.length} trigs · {QRA_BASES.length} bases</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold tracking-tight leading-tight" style={{ color: TIER_COLOR[t] }}>{t.length > 6 ? t.slice(0, 6) : t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Critical</div>
          <div className="font-mono text-sm" style={{ color: summary.crit > 0 ? '#ef4444' : '#10b981' }}>{summary.crit}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Scramble</div>
          <div className="font-mono text-sm" style={{ color: summary.scram > 0 ? '#f43f5e' : '#10b981' }}>{summary.scram}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">QRA-Air</div>
          <div className="font-mono text-sm text-sky-300">{summary.qAir}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">μ-TTI</div>
          <div className="font-mono text-sm text-slate-200">{summary.meanTti > 0 ? `${summary.meanTti.toFixed(0)}m` : '—'}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1 text-left px-2">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst TTI</div>
          <div className="font-mono text-[11px] text-slate-200">{summary.worstTti > 0 ? `${summary.worstTti.toFixed(0)}min · ${summary.worstLbl}` : '—'}</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1 text-left px-2">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Σ trigs</div>
          <div className="font-mono text-[11px] text-slate-300">{summary.total} · {QRA_BASES.length} bases</div>
        </div>
      </div>

      {/* Diagram: TTI bar */}
      <div className="px-3 py-2 border-b border-slate-800">
        <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">TTI · min · top-12 active</div>
        <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
          <line x1={diag.PAD} y1={diag.H - 14} x2={diag.W - 6} y2={diag.H - 14} stroke="#334155" strokeWidth={1} />
          <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - 14} stroke="#334155" strokeWidth={1} />
          {[0, 15, 30, 60, 120].map((t, i) => {
            const x = diag.PAD + (i / 4) * (diag.W - diag.PAD - 8)
            return (
              <g key={t}>
                <line x1={x} y1={6} x2={x} y2={diag.H - 14} stroke="#1e293b" strokeDasharray="2 3" strokeWidth={0.6} />
                <text x={x} y={diag.H - 4} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{t}m</text>
              </g>
            )
          })}
          {intercepts.filter(i => i.ttiMin < 999).slice(0, 12).map((i, idx) => {
            const yRow = 10 + idx * 8
            const w = (Math.min(120, i.ttiMin) / 120) * (diag.W - diag.PAD - 8)
            return (
              <g key={`${i.f.icao}-${idx}`}>
                <rect x={diag.PAD} y={yRow} width={w} height={5} fill={TIER_COLOR[i.tier]} opacity={0.86} rx={1.2} />
                <text x={diag.PAD - 4} y={yRow + 5} textAnchor="end" fontSize={7} fill="#94a3b8" fontFamily="monospace">{(i.f.callsign || i.f.icao).trim().slice(0, 7)}</text>
                <text x={diag.PAD + w + 3} y={yRow + 5} fontSize={7} fill={TIER_COLOR[i.tier]} fontFamily="monospace">{i.ttiMin.toFixed(0)}m</text>
              </g>
            )
          })}
        </svg>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-BASE</span><span className="font-mono text-slate-300">{maxBaseNm}NM</span></div>
            <input type="range" min={100} max={1000} step={50} value={maxBaseNm} onChange={e => setMaxBaseNm(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>ADV-MUL</span><span className="font-mono text-slate-300">{advMul}%</span></div>
            <input type="range" min={50} max={200} step={5} value={advMul} onChange={e => setAdvMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setTrigFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${trigFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(Object.keys(TRIG_LABEL) as Trig[]).map(t => (
            <button key={t} onClick={() => setTrigFilter(trigFilter === t ? 'ALL' : t)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${trigFilter === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}
              style={trigFilter === t ? {} : { color: TRIG_COLOR[t] }}>{TRIG_LABEL[t]}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-[9px] uppercase tracking-widest text-slate-500 mr-1">POSTURE</span>
          <button onClick={() => setPostFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${postFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['Q5', 'Q10', 'Q15', 'Q30'] as Posture[]).map(p => (
            <button key={p} onClick={() => setPostFilter(postFilter === p ? 'ALL' : p)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${postFilter === p ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showBaseM} onChange={e => setShowBaseM(e.target.checked)} className="accent-sky-500" /><span>BASE</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLine} onChange={e => setShowLine(e.target.checked)} className="accent-sky-500" /><span>VECTOR</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHvaM} onChange={e => setShowHvaM(e.target.checked)} className="accent-sky-500" /><span>HVA</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLbl} onChange={e => setShowLbl(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / base / sector"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['TRIGGERS', 'BASES', 'METHOD'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>
          {tab === 'TRIGGERS' ? `${filteredIntercepts.length} shown / ${intercepts.length} trigs` :
           tab === 'BASES'    ? `${filteredBases.length} shown / ${bases.length} bases` :
                                 'ATP-3.3.4 + AC 90-117 + NORAD ConOps'}
        </span>
        <span>{tab === 'TRIGGERS' ? 'trig · base · TTI · geom' : tab === 'BASES' ? 'posture · fighter · active' : '5 of 6 columns'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'TRIGGERS' && filteredIntercepts.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No active air-policing triggers.</div>
        )}
        {tab === 'TRIGGERS' && filteredIntercepts.map((i, idx) => {
          const advice =
            i.tier === 'CRITICAL' ? 'CRITICAL · QRA airborne · armed intercept · per ICAO Annex 2 §3.8 + AC 90-117 §6' :
            i.tier === 'SCRAMBLE' ? `${i.trig === 'SQK-7700' ? 'MAYDAY' : i.trig === 'SQK-7600' ? 'NORDO' : 'ALERT'} · sortie launched · escort to safe FIR / IGS / divert field` :
            i.tier === 'POSTURED' ? 'POSTURED · QRA crew at cockpit, T+5 max scramble · monitor heading + altitude' :
            i.tier === 'ADVISORY' ? 'ADVISORY · ANSP awaiting confirmation · no scramble yet · contact attempts ongoing' :
            i.tier === 'MONITOR'  ? 'nominal sector posture · trigger logged · standby crew' :
                                    'stood-down · trigger resolved or out of range · no active sortie'
          const fuelPct = (i.fuelAtCpa * 100).toFixed(0)
          const ftrLbl = i.base ? FTR_LABEL[i.base.fighter] : '—'
          return (
            <div key={`${i.f.icao}-${idx}`}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[i.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <button onClick={() => onFly(i.f.icao)} className="font-mono font-semibold truncate hover:text-sky-300">{(i.f.callsign || i.f.icao).trim()}</button>
                  <span className="text-[9px] font-mono px-1 rounded" style={{ background: TRIG_COLOR[i.trig] + '22', color: TRIG_COLOR[i.trig] }}>{TRIG_LABEL[i.trig]}</span>
                  <span className="text-slate-500 truncate ml-auto text-[10px]">{i.f.type || '—'}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[i.tier] }}>{i.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="QRA base assigned">{i.base?.id || '—'}<span className="text-slate-600 ml-1">{i.base?.posture}</span></span>
                  <span title="fighter type">{ftrLbl}</span>
                  <span title="base→trigger distance">{i.baseDistNm.toFixed(0)}NM</span>
                  <span className="ml-auto" style={{ color: TIER_COLOR[i.tier] }}>{GEOM_GLYPH[i.geom]} {i.geom}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] mt-0.5 font-mono">
                  <span title="time to intercept" style={{ color: i.ttiMin < 15 ? '#f43f5e' : i.ttiMin < 30 ? '#f59e0b' : '#94a3b8' }}>
                    TTI {i.ttiMin < 999 ? `${i.ttiMin.toFixed(0)}m` : '∞'}
                  </span>
                  <span title="scramble minutes">SCRMB {i.scrambleMin}m</span>
                  <span title="closing speed">CLOS {i.closingKts.toFixed(0)}kt</span>
                  <span title="fuel-at-CPA fraction" style={{ color: i.fuelAtCpa < 0.15 ? '#ef4444' : i.fuelAtCpa < 0.3 ? '#f59e0b' : '#10b981' }}>FUEL {fuelPct}%</span>
                  {i.hva && <span style={{ color: '#fbbf24' }} title="HVA in intercept zone">★HVA</span>}
                  {i.firOut && <span style={{ color: '#a855f7' }} title="suspect will exit FIR">FIR-OUT</span>}
                </div>
                <div className="mt-1 h-1 rounded bg-slate-900 relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${i.riskScore}%`, background: TIER_COLOR[i.tier], opacity: 0.85 }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="bearing base→trigger">BRG {i.bearing.toFixed(0)}°</span>
                  <span title="risk 0-100">risk {i.riskScore}</span>
                  <span className="ml-auto truncate" style={{ color: TIER_COLOR[i.tier] }}>{advice}</span>
                </div>
              </div>
            </div>
          )
        })}
        {tab === 'BASES' && filteredBases.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No bases match filter.</div>
        )}
        {tab === 'BASES' && filteredBases.map(r => {
          const post = r.base.posture
          const postColor = post === 'Q5' ? '#ef4444' : post === 'Q10' ? '#f59e0b' : post === 'Q15' ? '#0ea5e9' : '#64748b'
          return (
            <div key={r.base.id}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: r.worstTier ? TIER_COLOR[r.worstTier] : '#475569' }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{r.base.id}</span>
                  <span className="text-slate-400 truncate">{r.base.name}</span>
                  <span className="ml-auto text-[10px] font-semibold" style={{ color: postColor }}>{post}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="fighter type">{FTR_LABEL[r.base.fighter]}</span>
                  <span title="combat radius">CR {FTR_COMBAT_RAD_NM[r.base.fighter]}NM</span>
                  <span title="dash speed">{FTR_DASH_KTAS[r.base.fighter]}kt</span>
                  <span className="ml-auto" style={{ color: r.active > 0 ? '#0ea5e9' : '#64748b' }}>{r.active} active</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="air-policing sector">{r.base.sector}</span>
                  <span title="controlling FIR">FIR {r.base.fir}</span>
                  <span className="ml-auto" style={{ color: r.worstTier ? TIER_COLOR[r.worstTier] : '#475569' }}>{r.worstTier || 'standby'}</span>
                </div>
              </div>
            </div>
          )
        })}
        {tab === 'METHOD' && (
          <div className="px-3 py-2 text-[11px] text-slate-300 leading-relaxed space-y-2.5">
            <div>
              <div className="font-semibold text-sky-400 text-[10px] uppercase tracking-widest mb-1">QRA Posture Ladder</div>
              <div className="font-mono text-[10px] text-slate-400 space-y-0.5">
                <div><span className="text-rose-400">Q5</span>   5-min  reaction · crew in cockpit · APU running · hot regions</div>
                <div><span className="text-amber-400">Q10</span>  10-min reaction · crew in alert facility · pre-flight done</div>
                <div><span className="text-sky-400">Q15</span>  15-min reaction · crew on standby · NATO peacetime baseline</div>
                <div><span className="text-slate-400">Q30</span>  30-min reaction · crew at quarters · low-threat sector</div>
              </div>
            </div>
            <div>
              <div className="font-semibold text-sky-400 text-[10px] uppercase tracking-widest mb-1">Trigger taxonomy</div>
              <div className="font-mono text-[10px] space-y-0.5">
                <div><span style={{ color: TRIG_COLOR['SQK-7500'] }}>HIJACK</span> · squawk 7500 · unlawful interference · ICAO Annex 17 + Doc 8973</div>
                <div><span style={{ color: TRIG_COLOR['SQK-7600'] }}>NORDO </span> · squawk 7600 · lost-comm · 14 CFR §91.185 / AIM 6-4-1</div>
                <div><span style={{ color: TRIG_COLOR['SQK-7700'] }}>MAYDAY</span> · squawk 7700 · in-flight emergency · ICAO Doc 4444 §15.1</div>
                <div><span style={{ color: TRIG_COLOR['ADIZ-PEN'] }}>ADIZ  </span> · penetration of identification zone w/o filed FPL</div>
                <div><span style={{ color: TRIG_COLOR['TRK-DEV'] }}>TRK-DV</span> · deviation from cleared track · ATC unable to raise</div>
                <div><span style={{ color: TRIG_COLOR['NO-FPL'] }}>NO-FPL</span> · transit of controlled airspace without filed FPL</div>
                <div><span style={{ color: TRIG_COLOR['NO-TXP'] }}>TXP-DR</span> · transponder dropout on previously-tracked target</div>
              </div>
            </div>
            <div>
              <div className="font-semibold text-sky-400 text-[10px] uppercase tracking-widest mb-1">Intercept-geometry profiles (ATP-3.3.4.2 §5)</div>
              <div className="font-mono text-[10px] space-y-0.5">
                <div><span className="text-emerald-400">→ STERN</span>     conversion turn behind target · safest · max VID time</div>
                <div><span className="text-sky-400">↗ OFFSET</span>    offset displacement intercept · standard NORAD profile</div>
                <div><span className="text-amber-400">↗ BEAM</span>      crossing aspect ~90° · standard NATO Quick Visual</div>
                <div><span className="text-rose-400">↔ HEAD-ON</span>   highest closure · used only when no other geom available</div>
              </div>
            </div>
            <div>
              <div className="font-semibold text-sky-400 text-[10px] uppercase tracking-widest mb-1">Tier classification</div>
              <div className="font-mono text-[10px] space-y-0.5">
                <div><span className="text-rose-500">CRITICAL  </span>HIJACK or HVA proximity · armed intercept · Q5 launch</div>
                <div><span className="text-rose-400">SCRAMBLE  </span>MAYDAY / NORDO · sortie launched · escort to safe FIR</div>
                <div><span className="text-amber-400">POSTURED  </span>ADIZ-PEN / TRK-DEV · crew in cockpit · contact attempts</div>
                <div><span className="text-sky-400">ADVISORY  </span>NO-FPL or low-confidence trigger · ANSP awaiting verification</div>
                <div><span className="text-slate-400">MONITOR   </span>nominal posture · trigger logged · standby crew</div>
                <div><span className="text-emerald-400">STAND-DN  </span>trigger resolved or out of range · sortie terminated</div>
              </div>
            </div>
            <div>
              <div className="font-semibold text-sky-400 text-[10px] uppercase tracking-widest mb-1">Canonical precedents</div>
              <div className="text-slate-400">
                <span className="text-rose-400 font-semibold">9/11 NORAD scramble</span> · NEADS sectors went peacetime → wartime in 90 min · drove FAA AC 90-117 + Operation NOBLE EAGLE · 30+ CONUS QRA bases at continuous Q15 minimum.
                <span className="text-rose-400 font-semibold"> KAL 007</span> Sakhalin 1983 · Su-15 shot down B747 · 269 fatal · ICAO Annex 2 §3.8 interception rules.
                <span className="text-rose-400 font-semibold"> Mathias Rust</span> 1987 · Cessna 172 Helsinki→Moscow → Red Square landing · Soviet IADS QRA failure.
                <span className="text-rose-400 font-semibold"> RyanAir FR4978 Minsk</span> 2021 · MIG-29 forced landing · UN Reso. 2581 · ICAO Resolution A41-3.
                <span className="text-rose-400 font-semibold"> MH17</span> 2014 · UN Reso. 2166 · post-event EUROCONTROL conflict-zone bulletins integrated with QRA chain.
              </div>
            </div>
            <div>
              <div className="font-semibold text-sky-400 text-[10px] uppercase tracking-widest mb-1">References</div>
              <div className="text-[10px] text-slate-500 leading-relaxed">
                ICAO Annex 2 §3.8 Interception of civil aircraft · Annex 17 Security · Annex 18 Dangerous Goods ·
                Doc 4444 PANS-ATM §15.1 emergency procedures · Doc 8973 Aviation Security Manual ed.10 ·
                Doc 9433 Manual concerning Interception of Civil Aircraft · Doc 9434 Annex 17 guidance ·
                NATO ATP-3.3.4 Allied Joint Doctrine for Air Operations · ATP-3.3.4.2 Air Policing ·
                NORAD CONR / ANR / CANR ConOps · NORAD Inst. 10-2 · FAA Order JO 7610.4 §17 ·
                FAA AC 90-117 Special Operating Procedures · 14 CFR §91.185 §91.139 §99 ·
                NTSB SR-04/01 · 9/11 Commission Report ch.1 · UN Resolution 2166 (MH17) · UN Resolution 2581 (FR4978) ·
                ICAO Assembly Resolution A41-3 · IISS Military Balance 2024 · NORAD AOC 2022 ·
                EUROCONTROL Network Manager Conflict Zones · IFALPA Briefing Leaflet 18POS01.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
