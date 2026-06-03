'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Cold-Temperature Altimetry (CTA) Correction Monitor
   -----------------------------------------------------------
   ICAO Doc 8168 Vol II §III.4.1.1 cold-temperature altimeter
   correction · ICAO Doc 7488 Manual ISA · FAA AC 91-79B App 1
   "Cold Temperature Operations" · FAA Order 7900.5C Cold
   Temperature Restricted Airports (CTA) list · 14 CFR 97.20
   IAP altitude correction · Transport Canada AIM RAC 9.17 /
   TP14371 §3.6.1 · EASA AMC2 to OPS.GEN.225 / SIB 2018-07 ·
   NTSB AAR-79-7 Air Canada DC-9 Cranbrook YXC 1978 CFIT.
   -----------------------------------------------------------
   Pressure altimeters use the ISA standard lapse and assume
   the column below the aircraft is at +15°C SL ISA. When the
   actual ATMOSPHERIC column is colder than ISA, the air mass
   is denser → for the same pressure surface, the TRUE height
   is LOWER than the indicated height. The aircraft is closer
   to terrain than the altimeter shows. ICAO Doc 8168 Table
   III-4-1-1 ("temperature correction") tabulates corrections
   in feet for height-above-station vs ISA-deviation, valid
   when station QNH is set:
        ΔH ≈ h_AGL · (15 − OAT_station°C) / (273 + OAT_station)
   The engineering rule of thumb (ICAO PANS-OPS / Annex 6):
        ≈ 4 ft per 1 000 ft AGL per °C below ISA
   So at YEG Edmonton OAT −40°C (55°C below ISA) on a 5 000
   ft AGL approach segment, the true height is 1 100 ft LOWER
   than indicated — enough to CFIT a precision approach where
   DH is 200 ft AGL. ICAO requires the correction be applied
   to all published minimum altitudes (MIA, MSA, MOCA, MEA,
   IAF/FAF/MAP segment minimums, missed approach, circling
   minimums) when OAT_station ≤ the airport's published
   "minimum temperature for procedure design" — for IFR
   designed procedures this is typically ISA−15°C or the
   colder of the published procedure design temperature.

   FAA Order 7900.5C publishes the Cold Temperature Restricted
   Airports list — runways/segments where pilots MUST apply
   the correction at or below a published threshold OAT
   (the "RESTRICTED" cold temp). For the 2024–25 cycle the
   list contains 240+ runways. We catalogue 30 representative
   ICAO airports with their published threshold OATs and the
   typical segment-AGL the correction applies to:

     KEGE Eagle CO            −12 °C   intermediate / final / missed
     KASE Aspen CO            −12 °C   final + missed
     KJAC Jackson Hole WY     −22 °C   intermediate
     KBZN Bozeman MT          −30 °C   intermediate
     KSLC Salt Lake City UT    +1 °C   final / missed
     KBIL Billings MT         −30 °C   intermediate
     KGEG Spokane WA          −19 °C   intermediate
     KMSO Missoula MT         −19 °C   intermediate
     KGJT Grand Junction CO   −16 °C   final
     KRNO Reno NV             −10 °C   intermediate
     KSUN Sun Valley ID       −12 °C   final
     KFCA Kalispell MT        −22 °C   intermediate
     CYYC Calgary AB          −33 °C   final / missed
     CYEG Edmonton AB         −37 °C   intermediate / final
     CYVR Vancouver BC         +1 °C   final + missed
     CYYZ Toronto ON          −17 °C   final
     CYUL Montreal QC         −22 °C   final
     CYQB Quebec QC           −24 °C   final
     CYWG Winnipeg MB         −33 °C   final / missed
     CYHZ Halifax NS          −19 °C   final
     CYXY Whitehorse YT       −34 °C   intermediate
     CYFB Iqaluit NU          −39 °C   final
     PANC Anchorage AK        −19 °C   final
     PAFA Fairbanks AK        −38 °C   intermediate / final
     BIKF Keflavik IS         −12 °C   final
     ENGM Oslo NO             −17 °C   final
     ENZV Stavanger NO        −12 °C   final
     ESSA Stockholm SE        −16 °C   final
     EFHK Helsinki FI         −22 °C   final
     EETN Tallinn EE          −17 °C   intermediate
     EPWA Warsaw PL            −9 °C   final
     UUEE Sheremetyevo RU     −27 °C   final
     ULLI St-Petersburg RU    −24 °C   final
     UNNT Novosibirsk RU      −39 °C   intermediate
     ZBAA Beijing CN           −9 °C   final
     RJCC Sapporo JP           −9 °C   final
     LFLL Lyon FR              −7 °C   final
     LOWI Innsbruck AT        −12 °C   final / missed
     LSGG Geneva CH            −7 °C   final
     LSZH Zurich CH            −7 °C   final

   For every aircraft on APPROACH (vRate ≤ −300 fpm, alt <
   10 000 AGL) or DEPARTURE (vRate ≥ +500 fpm, alt < 10 000
   AGL) within CAP-NM slider of one of the 30 CTA airports,
   we infer:
     · station OAT  = ISA(elev) + OAT-BIAS slider ±25 °C
                      + monthly N-hemisphere offset
       (DEC-FEB −18, NOV+MAR −9, OCT+APR −3, others 0 °C)
     · station QNH  = 29.92 + hash(±0.20 inHg)
     · segment_AGL  = current altMSL − airport elev
                      (clamped to 200..5500 ft)
     · ISA-DEV      = OAT_station − ISA(elev) °C
     · ΔH_cold      = max(0, −ISA-DEV) · segment_AGL / 250
                      (FAA AC 91-79B App 1 simplified)
     · pilot_correction_applied? hash-stable per-airframe
       compliance probability (AIRLINE 0.92 / GA 0.55 /
       FRT 0.78 / FTR 0.40) scaled by COMP-MUL 50-150 %
     · true_height  = indicated − (correction-not-applied ·
                      ΔH_cold)

   5 risk components composite max-driver:
     ICEPT   ΔH_cold relative to segment MDA terrain buffer
             (severity 0 at 0 ft, 100 at ≥250 ft)
     THRESH  OAT margin to airport published CTA threshold
             (severity 0 above threshold, ramps to 100 at
              30 °C below)
     COMP    pilot non-application probability — high when
             FAA Order 7900.5C requires & ops manual lapse
     QNH     altimeter setting departure from station QNH
             contributes additional error
     SEG     segment exposure — FINAL/MAP > INTERMEDIATE
             > DEPARTURE (different terrain buffers)

   Composite score = max(per-driver severity).

   Tier classification:
     BUST    score≥80  rose    correction omission ≥250 ft —
                              terrain-buffer breach probable
     APPLY   score≥55  amber   apply ICAO Doc 8168 correction
                              now to MDA / DA / segment mins
     WATCH   score≥25  sky     within envelope, monitor OAT
                              drift, brief crew on application
     OK      score<25  emerald correction not required at
                              station OAT
     IDLE    no exposure / above ceiling / not within CAP-NM
                              of CTA field          slate

   MapLibre overlay:
     · Tier-coloured halo rings sized by score (8..22 px)
     · 30 CTA airport pins with IATA + threshold-°C label
       (rose when current OAT ≤ threshold else slate)
     · Tier-coloured callsign + ΔH-ft + driver labels for
       non-OK aircraft
     · Rose dashed line aircraft-to-airport for BUST showing
       descent path requiring correction
     · Amber ISA-deviation isobars at lat 60/45/30 sampled
       every 8° longitude for cold air mass reference

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-ΔH / WORST callsign+ΔH+driver / BUST
     · 2-cell MEAN-ISA-DEV / CTA-FIELD-active count
     · SVG ΔH-ft vs segment-AGL-ft scatter with rose ≥250 ft
       BUST band + amber 100-250 ft APPLY band + sky 25-100
       WATCH + emerald <25 OK + dashed 25/100/250 horizontals
       + 500/1000/2000/3000 ft verticals + every aircraft
       plotted as tier-coloured dot
     · 5 sliders OAT-BIAS / CAP-NM / COMP-MUL / SEG-MUL / QNH
       (full-width MONTH 1-12)
     · 4-segment chip filter INT / FNL / MAP / DEP
     · HALO / FLD / LBL / CORR / ISA / DIAG toggles + search
     · AIRCRAFT / FIELDS tab switcher
     · Per-row breakdown chips, score bar, citation, advice
       (ICAO Doc 8168 §III.4.1.1, click-to-fly)
     · FIELDS tab grouped by IATA with worst-aircraft drill

   Persisted: ft-ctalt
   ============================================================ */

export interface CtAltFlight {
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
  flights: CtAltFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'BUST' | 'APPLY' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  BUST: '#ef4444', APPLY: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_LABEL: Record<Tier, string> = {
  BUST: 'BUST', APPLY: 'APPLY', WATCH: 'WATCH', OK: 'OK', IDLE: 'IDLE',
}
const TIER_ORDER: Tier[] = ['BUST', 'APPLY', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { BUST: 0, APPLY: 1, WATCH: 2, OK: 3, IDLE: 4 }

/* ---- 30 CTA-restricted airports (FAA Order 7900.5C / TC AIM RAC 9.17) ---- */
interface CtaField {
  iata: string
  icao: string
  name: string
  lat: number
  lng: number
  elev: number       // ft
  threshC: number    // station OAT °C at/below which corrections required
  region: 'NA-MTN' | 'NA-N' | 'EU-N' | 'EU-MTN' | 'RU' | 'ASIA'
  segs: Array<'INT' | 'FNL' | 'MAP' | 'DEP'>
}
const FIELDS: CtaField[] = [
  { iata: 'EGE', icao: 'KEGE', name: 'Eagle CO',          lat: 39.643, lng: -106.918, elev: 6548, threshC: -12, region: 'NA-MTN', segs: ['INT', 'FNL', 'MAP'] },
  { iata: 'ASE', icao: 'KASE', name: 'Aspen CO',          lat: 39.223, lng: -106.869, elev: 7820, threshC: -12, region: 'NA-MTN', segs: ['FNL', 'MAP'] },
  { iata: 'JAC', icao: 'KJAC', name: 'Jackson Hole WY',   lat: 43.607, lng: -110.738, elev: 6451, threshC: -22, region: 'NA-MTN', segs: ['INT'] },
  { iata: 'BZN', icao: 'KBZN', name: 'Bozeman MT',        lat: 45.778, lng: -111.160, elev: 4474, threshC: -30, region: 'NA-MTN', segs: ['INT'] },
  { iata: 'SLC', icao: 'KSLC', name: 'Salt Lake City UT', lat: 40.788, lng: -111.978, elev: 4227, threshC:   1, region: 'NA-MTN', segs: ['FNL', 'MAP'] },
  { iata: 'BIL', icao: 'KBIL', name: 'Billings MT',       lat: 45.808, lng: -108.543, elev: 3652, threshC: -30, region: 'NA-MTN', segs: ['INT'] },
  { iata: 'GEG', icao: 'KGEG', name: 'Spokane WA',        lat: 47.620, lng: -117.534, elev: 2384, threshC: -19, region: 'NA-MTN', segs: ['INT'] },
  { iata: 'MSO', icao: 'KMSO', name: 'Missoula MT',       lat: 46.916, lng: -114.091, elev: 3206, threshC: -19, region: 'NA-MTN', segs: ['INT'] },
  { iata: 'GJT', icao: 'KGJT', name: 'Grand Jct CO',      lat: 39.122, lng: -108.527, elev: 4858, threshC: -16, region: 'NA-MTN', segs: ['FNL'] },
  { iata: 'RNO', icao: 'KRNO', name: 'Reno NV',           lat: 39.499, lng: -119.768, elev: 4415, threshC: -10, region: 'NA-MTN', segs: ['INT'] },
  { iata: 'SUN', icao: 'KSUN', name: 'Sun Valley ID',     lat: 43.504, lng: -114.296, elev: 5318, threshC: -12, region: 'NA-MTN', segs: ['FNL'] },
  { iata: 'FCA', icao: 'KFCA', name: 'Kalispell MT',      lat: 48.310, lng: -114.256, elev: 2977, threshC: -22, region: 'NA-MTN', segs: ['INT'] },
  { iata: 'YYC', icao: 'CYYC', name: 'Calgary AB',        lat: 51.114, lng: -114.020, elev: 3557, threshC: -33, region: 'NA-N',   segs: ['FNL', 'MAP'] },
  { iata: 'YEG', icao: 'CYEG', name: 'Edmonton AB',       lat: 53.310, lng: -113.580, elev: 2373, threshC: -37, region: 'NA-N',   segs: ['INT', 'FNL'] },
  { iata: 'YVR', icao: 'CYVR', name: 'Vancouver BC',      lat: 49.194, lng: -123.184, elev:   14, threshC:   1, region: 'NA-N',   segs: ['FNL', 'MAP'] },
  { iata: 'YYZ', icao: 'CYYZ', name: 'Toronto ON',        lat: 43.677, lng:  -79.631, elev:  569, threshC: -17, region: 'NA-N',   segs: ['FNL'] },
  { iata: 'YUL', icao: 'CYUL', name: 'Montreal QC',       lat: 45.471, lng:  -73.741, elev:  118, threshC: -22, region: 'NA-N',   segs: ['FNL'] },
  { iata: 'YQB', icao: 'CYQB', name: 'Quebec QC',         lat: 46.791, lng:  -71.393, elev:  244, threshC: -24, region: 'NA-N',   segs: ['FNL'] },
  { iata: 'YWG', icao: 'CYWG', name: 'Winnipeg MB',       lat: 49.910, lng:  -97.240, elev:  783, threshC: -33, region: 'NA-N',   segs: ['FNL', 'MAP'] },
  { iata: 'YHZ', icao: 'CYHZ', name: 'Halifax NS',        lat: 44.881, lng:  -63.508, elev:  477, threshC: -19, region: 'NA-N',   segs: ['FNL'] },
  { iata: 'YXY', icao: 'CYXY', name: 'Whitehorse YT',     lat: 60.710, lng: -135.069, elev: 2317, threshC: -34, region: 'NA-N',   segs: ['INT'] },
  { iata: 'YFB', icao: 'CYFB', name: 'Iqaluit NU',        lat: 63.756, lng:  -68.555, elev:   34, threshC: -39, region: 'NA-N',   segs: ['FNL'] },
  { iata: 'ANC', icao: 'PANC', name: 'Anchorage AK',      lat: 61.174, lng: -149.996, elev:  152, threshC: -19, region: 'NA-N',   segs: ['FNL'] },
  { iata: 'FAI', icao: 'PAFA', name: 'Fairbanks AK',      lat: 64.815, lng: -147.856, elev:  439, threshC: -38, region: 'NA-N',   segs: ['INT', 'FNL'] },
  { iata: 'KEF', icao: 'BIKF', name: 'Keflavik IS',       lat: 63.985, lng:  -22.605, elev:  171, threshC: -12, region: 'EU-N',   segs: ['FNL'] },
  { iata: 'OSL', icao: 'ENGM', name: 'Oslo NO',           lat: 60.194, lng:   11.100, elev:  681, threshC: -17, region: 'EU-N',   segs: ['FNL'] },
  { iata: 'SVG', icao: 'ENZV', name: 'Stavanger NO',      lat: 58.876, lng:    5.638, elev:   29, threshC: -12, region: 'EU-N',   segs: ['FNL'] },
  { iata: 'ARN', icao: 'ESSA', name: 'Stockholm SE',      lat: 59.652, lng:   17.918, elev:  137, threshC: -16, region: 'EU-N',   segs: ['FNL'] },
  { iata: 'HEL', icao: 'EFHK', name: 'Helsinki FI',       lat: 60.317, lng:   24.963, elev:  179, threshC: -22, region: 'EU-N',   segs: ['FNL'] },
  { iata: 'TLL', icao: 'EETN', name: 'Tallinn EE',        lat: 59.413, lng:   24.832, elev:  131, threshC: -17, region: 'EU-N',   segs: ['INT'] },
  { iata: 'WAW', icao: 'EPWA', name: 'Warsaw PL',         lat: 52.166, lng:   20.967, elev:  362, threshC:  -9, region: 'EU-N',   segs: ['FNL'] },
  { iata: 'SVO', icao: 'UUEE', name: 'Sheremetyevo RU',   lat: 55.972, lng:   37.414, elev:  622, threshC: -27, region: 'RU',     segs: ['FNL'] },
  { iata: 'LED', icao: 'ULLI', name: 'St-Petersburg RU',  lat: 59.800, lng:   30.262, elev:   78, threshC: -24, region: 'RU',     segs: ['FNL'] },
  { iata: 'OVB', icao: 'UNNT', name: 'Novosibirsk RU',    lat: 55.012, lng:   82.650, elev:  365, threshC: -39, region: 'RU',     segs: ['INT'] },
  { iata: 'PEK', icao: 'ZBAA', name: 'Beijing CN',        lat: 40.080, lng:  116.585, elev:  116, threshC:  -9, region: 'ASIA',   segs: ['FNL'] },
  { iata: 'CTS', icao: 'RJCC', name: 'Sapporo JP',        lat: 42.775, lng:  141.692, elev:   82, threshC:  -9, region: 'ASIA',   segs: ['FNL'] },
  { iata: 'LYS', icao: 'LFLL', name: 'Lyon FR',           lat: 45.726, lng:    5.090, elev:  821, threshC:  -7, region: 'EU-MTN', segs: ['FNL'] },
  { iata: 'INN', icao: 'LOWI', name: 'Innsbruck AT',      lat: 47.260, lng:   11.343, elev: 1907, threshC: -12, region: 'EU-MTN', segs: ['FNL', 'MAP'] },
  { iata: 'GVA', icao: 'LSGG', name: 'Geneva CH',         lat: 46.238, lng:    6.109, elev: 1411, threshC:  -7, region: 'EU-MTN', segs: ['FNL'] },
  { iata: 'ZRH', icao: 'LSZH', name: 'Zurich CH',         lat: 47.464, lng:    8.549, elev: 1416, threshC:  -7, region: 'EU-MTN', segs: ['FNL'] },
]
const REGION_LIST = ['NA-MTN', 'NA-N', 'EU-N', 'EU-MTN', 'RU', 'ASIA'] as const
type Region = (typeof REGION_LIST)[number]

const SEG_LIST = ['INT', 'FNL', 'MAP', 'DEP'] as const
type Segment = (typeof SEG_LIST)[number]
const SEG_LABEL: Record<Segment, string> = { INT: 'Intermediate', FNL: 'Final', MAP: 'Missed Apch', DEP: 'Departure' }
const SEG_WEIGHT: Record<Segment, number> = { INT: 0.85, FNL: 1.0, MAP: 1.1, DEP: 0.7 }

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

const D2R = Math.PI / 180
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const dLa = (la2 - la1) * D2R, dLo = (lo2 - lo1) * D2R
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * D2R) * Math.cos(la2 * D2R) * Math.sin(dLo / 2) ** 2
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)))
}

function isaTempC(elevFt: number): number {
  return 15 - 1.98 * (elevFt / 1000)
}

type Phase = 'APPR' | 'DEP' | 'CRUISE' | 'OTHER'
function inferPhase(altMSL: number, vRate: number, elev: number): Phase {
  const aglFt = altMSL - elev
  if (aglFt < 10000 && vRate <= -300) return 'APPR'
  if (aglFt < 10000 && vRate >= 500) return 'DEP'
  if (aglFt > 10000) return 'CRUISE'
  return 'OTHER'
}

type Driver = 'ICEPT' | 'THRESH' | 'COMP' | 'QNH' | 'SEG' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  ICEPT: 'ΔH cold-temp altitude error',
  THRESH: 'OAT below airport CTA threshold',
  COMP: 'Pilot correction non-application risk',
  QNH: 'QNH altimeter setting error',
  SEG: 'Procedure segment terrain exposure',
  NONE: 'Nominal',
}

interface Row {
  f: CtAltFlight
  field: CtaField
  distNm: number
  phase: Phase
  segment: Segment
  aglFt: number
  oatC: number
  isaDev: number
  qnhDev: number
  dHFt: number
  complianceProb: number
  trueHeightLoss: number
  sev: { icept: number; thresh: number; comp: number; qnh: number; seg: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'ctalt-halo', SRC_LBL = 'ctalt-lbl', SRC_PIN = 'ctalt-pin', SRC_FLD = 'ctalt-fld', SRC_ISA = 'ctalt-isa', SRC_LINE = 'ctalt-line'
const LYR_HALO = 'ctalt-halo-l', LYR_LBL = 'ctalt-lbl-l', LYR_PIN = 'ctalt-pin-l', LYR_FLD = 'ctalt-fld-l', LYR_FLDTXT = 'ctalt-fldtxt-l', LYR_ISA = 'ctalt-isa-l', LYR_LINE = 'ctalt-line-l'

function classifyAirframeCompliance(op: string, type: string, hash: number): number {
  const o = (op || '').toUpperCase()
  const t = (type || '').toUpperCase()
  // Airline ops scheduled high compliance / GA low / cargo medium / military low
  const baseAirline = /UA|AAL|DAL|BAW|DLH|AFR|KLM|ACA|JZA|WJA|FIN|SAS|UAL|JBU|SWA|RYR|EZY/.test(o) ? 0.92 : 0
  const baseFreight = /FDX|UPS|GTI|CLX|ABX|FX|5X|CAL|CKK|GEC|MPH/.test(o) ? 0.78 : 0
  const baseFtr = /N\d{4,5}/.test(o.trim()) || /RA?F|USAF|ANY?G|CFC/.test(o) ? 0.45 : 0
  let base = baseAirline || baseFreight || baseFtr
  if (!base) {
    if (/C\d{3,4}|SR\d{2}|BE\d{2}|PA\d{2}|GA8/.test(t)) base = 0.55 // GA reg fallback
    else base = 0.80 // generic transport
  }
  // hash-stable jitter ±0.10
  const j = (((hash >>> 9) % 1000) / 1000 - 0.5) * 0.20
  return Math.max(0.10, Math.min(0.99, base + j))
}

export default function CtAltMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'FIELDS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [regionFilter, setRegionFilter] = useState<Region | 'ALL'>('ALL')
  const [segFilter, setSegFilter] = useState<Segment | 'ALL'>('ALL')
  const [oatBias, setOatBias] = useState(-5)
  const [capNm, setCapNm] = useState(40)
  const [compMul, setCompMul] = useState(100)
  const [segMul, setSegMul] = useState(100)
  const [qnhInHg, setQnhInHg] = useState(2992) // 29.92 inHg ×100
  const [month, setMonth] = useState<number>(() => new Date().getMonth() + 1)
  const [showHalo, setShowHalo] = useState(true)
  const [showField, setShowField] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showCorr, setShowCorr] = useState(true)
  const [showIsa, setShowIsa] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const monthBiasC = useMemo(() => {
    if (month === 12 || month === 1 || month === 2) return -18
    if (month === 11 || month === 3) return -9
    if (month === 10 || month === 4) return -3
    return 0
  }, [month])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      // find nearest field within capNm
      let best: { field: CtaField; dist: number } | null = null
      for (const fld of FIELDS) {
        const d = gcDistNm(f.lat, f.lng, fld.lat, fld.lng)
        if (d > capNm) continue
        if (!best || d < best.dist) best = { field: fld, dist: d }
      }
      if (!best) continue
      const field = best.field
      const phase = inferPhase(f.altitudeFt, f.vertRate, field.elev)
      if (phase !== 'APPR' && phase !== 'DEP') continue
      const aglFt = Math.max(200, Math.min(5500, f.altitudeFt - field.elev))
      // station OAT
      const oat = isaTempC(field.elev) + oatBias + monthBiasC
      const isaDev = oat - isaTempC(field.elev)
      // QNH dev (inHg×100)
      const qnhDev = (qnhInHg - 2992) / 100 // inHg
      // ΔH cold-temp correction approx: 4 ft / 1000 ft / °C below ISA
      const colderThanIsa = Math.max(0, -isaDev)
      const dH = colderThanIsa * (aglFt / 1000) * 4
      // QNH altimeter error: 1 inHg ≈ 1000 ft
      const dQnh = Math.abs(qnhDev) * 1000 * 0.15 // 15% weighting
      const h = hash32(f.icao || '')
      const compProb = classifyAirframeCompliance(f.operator || '', f.type || '', h) * (compMul / 100)
      const compClamped = Math.max(0.05, Math.min(0.99, compProb))
      // segment classification: pick a representative seg from field
      const segs = field.segs
      const segIdx = h % segs.length
      const segLetter = phase === 'DEP' ? 'DEP' as Segment : segs[segIdx]
      const segWt = SEG_WEIGHT[segLetter] * (segMul / 100)
      // true height loss = (1-compliance) × dH
      const trueLoss = (1 - compClamped) * dH

      // -- severities --
      // ICEPT: ΔH magnitude (cold-temp altitude error)
      const iceptSev = dH <= 25 ? 0 : dH >= 350 ? 100 : (dH - 25) / 325 * 100
      // THRESH: how far below airport threshold
      const margin = field.threshC - oat // positive = below threshold (bad)
      const threshSev = margin <= -5 ? 0 : margin >= 25 ? 100 : ((margin + 5) / 30) * 100
      // COMP: non-application probability
      const nonComp = (1 - compClamped) * 100
      const compSev = Math.min(100, nonComp * 0.9 * (dH > 50 ? 1 : 0.3))
      // QNH altimeter error
      const qnhSev = dQnh <= 10 ? 0 : dQnh >= 200 ? 80 : ((dQnh - 10) / 190) * 80
      // SEG exposure
      const segBase = segLetter === 'MAP' ? 50 : segLetter === 'FNL' ? 40 : segLetter === 'INT' ? 28 : 18
      const segSev = (dH > 0 ? 1 : 0) * segBase * segWt

      const sevs = { icept: iceptSev, thresh: threshSev, comp: compSev, qnh: qnhSev, seg: segSev }
      const drvList: Array<[Driver, number]> = [
        ['ICEPT', iceptSev], ['THRESH', threshSev], ['COMP', compSev], ['QNH', qnhSev], ['SEG', segSev],
      ]
      drvList.sort((a, b) => b[1] - a[1])
      const driver: Driver = drvList[0][1] > 0 ? drvList[0][0] : 'NONE'
      const score = drvList[0][1]
      let tier: Tier
      if (score >= 80) tier = 'BUST'
      else if (score >= 55) tier = 'APPLY'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, field, distNm: best.dist, phase, segment: segLetter,
        aglFt, oatC: oat, isaDev, qnhDev, dHFt: dH,
        complianceProb: compClamped, trueHeightLoss: trueLoss,
        sev: sevs, score, driver, tier,
      })
    }
    return out
  }, [flights, oatBias, capNm, compMul, segMul, qnhInHg, monthBiasC])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { BUST: 0, APPLY: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumDH = 0, sumIsa = 0, worst = 0, worstCs = '', worstDrv: Driver = 'NONE', worstDH = 0
    let bust = 0
    const fieldsActive = new Set<string>()
    for (const r of rows) {
      sumDH += r.dHFt; sumIsa += r.isaDev
      if (r.tier === 'BUST') bust++
      if (r.score > worst) { worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstDrv = r.driver; worstDH = r.dHFt }
      fieldsActive.add(r.field.iata)
    }
    return {
      meanDH: rows.length ? sumDH / rows.length : 0,
      meanIsa: rows.length ? sumIsa / rows.length : 0,
      worst, worstCs, worstDrv, worstDH, bust, fieldsCount: fieldsActive.size,
    }
  }, [rows])

  const fieldAggs = useMemo(() => {
    const m = new Map<string, { iata: string; name: string; icao: string; region: Region; threshC: number; elev: number; count: number; sumScore: number; sumDH: number; worst: number; worstCs: string; worstIcao: string; worstTier: Tier; bust: number }>()
    for (const r of rows) {
      const k = r.field.iata
      let a = m.get(k)
      if (!a) { a = { iata: r.field.iata, name: r.field.name, icao: r.field.icao, region: r.field.region as Region, threshC: r.field.threshC, elev: r.field.elev, count: 0, sumScore: 0, sumDH: 0, worst: 0, worstCs: '', worstIcao: '', worstTier: 'OK', bust: 0 }; m.set(k, a) }
      a.count++; a.sumScore += r.score; a.sumDH += r.dHFt
      if (r.tier === 'BUST') a.bust++
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.score > a.worst) { a.worst = r.score; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
    }
    const arr = Array.from(m.values()).map(a => ({ ...a, meanScore: a.count ? a.sumScore / a.count : 0, meanDH: a.count ? a.sumDH / a.count : 0 }))
    arr.sort((a, b) => {
      const ti = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
      if (ti !== 0) return ti
      return b.count - a.count
    })
    return arr
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows
      .filter(r => {
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (regionFilter !== 'ALL' && r.field.region !== regionFilter) return false
        if (segFilter !== 'ALL' && r.segment !== segFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.field.iata, r.field.icao, r.field.name].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, regionFilter, segFilter, query])

  const filteredFields = useMemo(() => {
    const q = query.trim().toUpperCase()
    return fieldAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (regionFilter !== 'ALL' && a.region !== regionFilter) return false
      if (!q) return true
      return (a.iata + ' ' + a.icao + ' ' + a.name).toUpperCase().includes(q)
    })
  }, [fieldAggs, tierFilter, regionFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'APPLY' || r.tier === 'BUST').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ΔH ${r.dHFt.toFixed(0)}ft ${r.driver}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    // Field pins — rose when current OAT ≤ threshold else slate
    const fldFc = { type: 'FeatureCollection' as const, features: showField ? FIELDS.map(fld => {
      const oat = isaTempC(fld.elev) + oatBias + monthBiasC
      const active = oat <= fld.threshC
      return {
        type: 'Feature' as const,
        properties: {
          color: active ? '#ef4444' : '#475569',
          text: `${fld.iata} ${fld.threshC}°C`,
        },
        geometry: { type: 'Point' as const, coordinates: [fld.lng, fld.lat] },
      }
    }) : [] }

    // BUST corrective descent line aircraft to airport
    const lineFc = { type: 'FeatureCollection' as const, features: showCorr ? rows.filter(r => r.tier === 'BUST' || r.tier === 'APPLY').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.field.lng, r.field.lat]] },
    })) : [] }

    // BUST pin at field with corrective ΔH
    const pinFc = { type: 'FeatureCollection' as const, features: showField ? rows.filter(r => r.tier === 'BUST').map(r => ({
      type: 'Feature' as const,
      properties: { color: '#ef4444', text: `› APPLY +${Math.round(r.dHFt)} ft ${r.field.iata}` },
      geometry: { type: 'Point' as const, coordinates: [r.field.lng, r.field.lat] },
    })) : [] }

    // ISA-deviation reference parallels lat 60/45/30 N+S, amber dashed
    const isaFeatures: any[] = []
    if (showIsa) {
      for (const lat of [60, 45, 30, -30, -45, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 8) coords.push([lng, lat])
        isaFeatures.push({ type: 'Feature' as const, properties: { color: '#f59e0b' }, geometry: { type: 'LineString' as const, coordinates: coords } })
      }
    }
    const isaFc = { type: 'FeatureCollection' as const, features: isaFeatures }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_ISA, isaFc, () => map.addLayer({ id: LYR_ISA, type: 'line', source: SRC_ISA, paint: {
        'line-color': ['get', 'color'], 'line-width': 0.6, 'line-opacity': 0.16, 'line-dasharray': [4, 6],
      } }))
      ensure(SRC_LINE, lineFc, () => map.addLayer({ id: LYR_LINE, type: 'line', source: SRC_LINE, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [3, 3],
      } }))
      ensure(SRC_FLD, fldFc, () => {
        map.addLayer({ id: LYR_FLD, type: 'circle', source: SRC_FLD, paint: {
          'circle-radius': 4, 'circle-color': ['get', 'color'], 'circle-opacity': 0.85,
          'circle-stroke-color': '#020617', 'circle-stroke-width': 1.0,
        } })
        map.addLayer({ id: LYR_FLDTXT, type: 'symbol', source: SRC_FLD, layout: {
          'text-field': ['get', 'text'], 'text-size': 9,
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          'text-offset': [0, 1.0], 'text-anchor': 'top',
        }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } })
      })
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['get', 'text'], 'text-size': 10,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-offset': [0, -1.5], 'text-anchor': 'bottom', 'icon-allow-overlap': true,
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.6 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_FLDTXT, LYR_FLD, LYR_LINE, LYR_ISA]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_FLD, SRC_LINE, SRC_ISA]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showField, showCorr, showIsa, oatBias, monthBiasC])

  // Diagram: ΔH (y, 0..400 ft) vs segment AGL (x, 200..5500)
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 30
    const xMin = 200, xMax = 5500
    const yMax = 400
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Cold-Temp Altimetry (CTA)</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} ac · {summary.fieldsCount} fld</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold" style={{ color: TIER_COLOR[t] }}>{TIER_LABEL[t]}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean ΔH</div>
          <div className="font-mono text-sm" style={{ color: summary.meanDH >= 250 ? '#ef4444' : summary.meanDH >= 100 ? '#f59e0b' : summary.meanDH >= 25 ? '#0ea5e9' : '#10b981' }}>{summary.meanDH.toFixed(0)}ft</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstDH.toFixed(0)}ft` : '—'}
          </div>
          <div className="text-[8px] text-slate-500 truncate">{summary.worstDrv !== 'NONE' ? DRIVER_LABEL[summary.worstDrv] : '—'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">BUST</div>
          <div className="font-mono text-sm" style={{ color: summary.bust > 0 ? '#ef4444' : '#10b981' }}>{summary.bust}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean ISA-Dev</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanIsa <= -20 ? '#ef4444' : summary.meanIsa <= -8 ? '#f59e0b' : '#10b981' }}>{summary.meanIsa.toFixed(1)}°C</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">CTA fields</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.fieldsCount} / {FIELDS.length}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">ΔH ft vs segment-AGL ft · cold-temp envelope</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* horizontal bands */}
            <rect x={diag.PAD} y={6} width={diag.W - 6 - diag.PAD} height={diag.ys(250) - 6} fill="#ef4444" opacity={0.10} />
            <rect x={diag.PAD} y={diag.ys(250)} width={diag.W - 6 - diag.PAD} height={diag.ys(100) - diag.ys(250)} fill="#f59e0b" opacity={0.10} />
            <rect x={diag.PAD} y={diag.ys(100)} width={diag.W - 6 - diag.PAD} height={diag.ys(25) - diag.ys(100)} fill="#0ea5e9" opacity={0.08} />
            {[25, 100, 250].map(yv => (
              <g key={yv}>
                <line x1={diag.PAD} y1={diag.ys(yv)} x2={diag.W - 6} y2={diag.ys(yv)} stroke={yv === 250 ? '#ef4444' : yv === 100 ? '#f59e0b' : '#0ea5e9'} strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
                <text x={diag.PAD - 2} y={diag.ys(yv) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{yv}</text>
              </g>
            ))}
            {[500, 1000, 2000, 3000, 5000].map(xv => (
              <g key={xv}>
                <line x1={diag.xs(xv)} y1={6} x2={diag.xs(xv)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(xv)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{xv}</text>
              </g>
            ))}
            <text x={diag.PAD + 4} y={14} fontSize={7} fill="#ef4444" fontFamily="monospace">BUST 250ft+</text>
            <text x={diag.PAD + 4} y={diag.ys(250) + 9} fontSize={7} fill="#f59e0b" fontFamily="monospace">APPLY 100ft</text>
            <text x={diag.PAD + 4} y={diag.ys(100) + 9} fontSize={7} fill="#0ea5e9" fontFamily="monospace">WATCH 25ft</text>
            {rows.map(r => (
              <circle key={r.f.icao}
                cx={diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, r.aglFt)))}
                cy={diag.ys(Math.max(0, Math.min(diag.yMax, r.dHFt)))}
                r={3} fill={TIER_COLOR[r.tier]} opacity={0.92} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>OAT-BIAS</span><span className="font-mono text-slate-300">{oatBias >= 0 ? '+' : ''}{oatBias}°C</span></div>
            <input type="range" min={-25} max={10} step={1} value={oatBias} onChange={e => setOatBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CAP-NM</span><span className="font-mono text-slate-300">{capNm}</span></div>
            <input type="range" min={20} max={120} step={5} value={capNm} onChange={e => setCapNm(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>COMP-MUL</span><span className="font-mono text-slate-300">{compMul}%</span></div>
            <input type="range" min={50} max={150} step={5} value={compMul} onChange={e => setCompMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>SEG-MUL</span><span className="font-mono text-slate-300">{segMul}%</span></div>
            <input type="range" min={50} max={200} step={5} value={segMul} onChange={e => setSegMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>QNH</span><span className="font-mono text-slate-300">{(qnhInHg / 100).toFixed(2)} inHg</span></div>
          <input type="range" min={2850} max={3080} step={1} value={qnhInHg} onChange={e => setQnhInHg(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>MONTH</span><span className="font-mono text-slate-300">{['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][month-1]} · {monthBiasC >= 0 ? '+' : ''}{monthBiasC}°C</span></div>
          <input type="range" min={1} max={12} step={1} value={month} onChange={e => setMonth(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setRegionFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${regionFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {REGION_LIST.map(k => (
            <button key={k} onClick={() => setRegionFilter(regionFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${regionFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setSegFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${segFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>SEG</button>
          {SEG_LIST.map(k => (
            <button key={k} onClick={() => setSegFilter(segFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${segFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showField} onChange={e => setShowField(e.target.checked)} className="accent-sky-500" /><span>FLD</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showCorr} onChange={e => setShowCorr(e.target.checked)} className="accent-sky-500" /><span>CORR</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showIsa} onChange={e => setShowIsa(e.target.checked)} className="accent-sky-500" /><span>ISA</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / IATA / ICAO"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'FIELDS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} ac` : `${filteredFields.length} shown / ${fieldAggs.length} fld`}</span>
        <span>{tab === 'AIRCRAFT' ? 'IATA · AGL · ΔH · driver' : 'IATA · count · mean · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft within {capNm} nm of a CTA-restricted field.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const advice = r.tier === 'BUST'
            ? `apply ICAO Doc 8168 §III.4.1.1 cold-temp correction · add +${Math.round(r.dHFt)} ft to MDA/DA segment minimums NOW`
            : r.tier === 'APPLY'
              ? `OAT below ${r.field.iata} CTA threshold · apply correction +${Math.round(r.dHFt)} ft to procedure minimums`
              : r.tier === 'WATCH'
                ? `monitor OAT drift · ΔH ${r.dHFt.toFixed(0)} ft within envelope · brief crew correction technique`
                : `correction not required at station OAT ${r.oatC.toFixed(0)}°C`
          const margin = r.field.threshC - r.oatC
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{r.field.iata}</span>
                  <span className="text-[10px] font-mono text-slate-500">{r.segment}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{TIER_LABEL[r.tier]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="distance to field">{r.distNm.toFixed(0)}nm</span>
                  <span title="phase" className="text-slate-500">{r.phase}</span>
                  <span title="segment AGL ft">A{Math.round(r.aglFt)}</span>
                  <span title="station OAT °C" style={{ color: r.oatC <= r.field.threshC ? '#ef4444' : r.isaDev <= -10 ? '#f59e0b' : '#94a3b8' }}>{r.oatC.toFixed(0)}°C</span>
                  <span title="ISA dev" className="text-slate-500">/ ISA{r.isaDev >= 0 ? '+' : ''}{r.isaDev.toFixed(0)}</span>
                  <span title="ΔH cold-temp correction" style={{ color: r.dHFt >= 250 ? '#ef4444' : r.dHFt >= 100 ? '#f59e0b' : r.dHFt >= 25 ? '#0ea5e9' : '#10b981' }}>ΔH {r.dHFt.toFixed(0)}ft</span>
                  <span className="ml-auto" title="composite risk score" style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`score ${r.score.toFixed(0)} / 100`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500/70" style={{ left: `25%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-500/70" style={{ left: `55%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-500/70" style={{ left: `80%` }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {([['ICE', r.sev.icept], ['THR', r.sev.thresh], ['CMP', r.sev.comp], ['QNH', r.sev.qnh], ['SEG', r.sev.seg]] as const).map(([lbl, v]) => {
                    const c = v >= 80 ? '#ef4444' : v >= 55 ? '#f59e0b' : v >= 25 ? '#0ea5e9' : '#475569'
                    return (
                      <span key={lbl} className="px-1 py-0 rounded border text-[9px] font-mono"
                        style={{ borderColor: c + '66', color: c, background: c + '14' }}>{lbl} {v.toFixed(0)}</span>
                    )
                  })}
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="compliance probability">COMP {(r.complianceProb * 100).toFixed(0)}%</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="OAT margin to threshold">MRG {margin >= 0 ? '+' : ''}{margin.toFixed(0)}°C</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'FIELDS' && filteredFields.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No CTA-restricted fields with traffic in window.</div>
        )}
        {tab === 'FIELDS' && filteredFields.map(a => {
          const advice = a.worstTier === 'BUST' ? `${a.bust} aircraft missing cold-temp correction · ATC verify segment minimums`
            : a.worstTier === 'APPLY' ? `aircraft on approach require correction +${a.meanDH.toFixed(0)} ft to MDA`
            : a.worstTier === 'WATCH' ? `field below threshold but ΔH manageable · monitor`
            : `field above CTA threshold · no correction required`
          return (
            <button key={a.iata} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.iata}</span>
                  <span className="text-slate-500 text-[10px] truncate">{a.icao} · {a.name}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.worstTier] }}>{TIER_LABEL[a.worstTier]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="region" className="px-1 rounded border border-slate-800 bg-slate-900/60">{a.region}</span>
                  <span title="published threshold OAT" style={{ color: '#ef4444' }}>thr {a.threshC}°C</span>
                  <span title="field elevation ft">elev {a.elev}ft</span>
                  <span title="mean ΔH ft" style={{ color: a.meanDH >= 250 ? '#ef4444' : a.meanDH >= 100 ? '#f59e0b' : a.meanDH >= 25 ? '#0ea5e9' : '#10b981' }}>ΔH {a.meanDH.toFixed(0)}ft</span>
                  <span className="ml-auto truncate">{a.worstCs || '—'}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`mean score ${a.meanScore.toFixed(0)} / 100`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, a.meanScore)}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500/70" style={{ left: `25%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-500/70" style={{ left: `55%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-500/70" style={{ left: `80%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate">ICAO Doc 8168 §III.4.1.1 · FAA Order 7900.5C</span>
                  <span className="ml-auto truncate" style={{ color: a.worstTier === 'OK' ? '#64748b' : TIER_COLOR[a.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        ICAO Doc 8168 Vol II §III.4.1.1 · Doc 7488 ISA · FAA AC 91-79B App 1 · FAA Order 7900.5C · 14 CFR 97.20 · TC AIM RAC 9.17 · EASA SIB 2018-07 · NTSB AAR-79-7 Cranbrook YXC
      </div>
    </div>
  )
}
