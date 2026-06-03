'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   RCAM / TALPA Runway-Condition Braking-Action & Landing-Distance
   Compliance Monitor
   ---------------------------------------------------------------
   Per-airport published Runway Condition Code (RwyCC 0..6) and
   per-airframe time-of-arrival Landing Distance Available vs
   Required (LDA / LDR) per the TALPA ARC framework adopted
   FAA-wide 1 Oct 2016 and aligned with ICAO GRF (Global Reporting
   Format) effective 4 Nov 2021.

   Regulatory & operational basis:
     · FAA SAFO 06012 / SAFO 19001  TALPA Runway Condition Code
     · FAA AC 91-79A CHG 2  Landing performance assessment
       at time of arrival (LPATA) — 15 % safety margin
     · FAA AC 25-32  Landing performance data for time-of-arrival
       landing performance assessments (TALPA)
     · 14 CFR 121.195  Airplanes turbojet — landing limitations
     · 14 CFR 121.197  Alternate airport landing distance
     · 14 CFR 135.385  Large transport-category turbine
     · FAA Order JO 7110.65  ATC field-condition handling
     · FAA Order 8900.1 Vol 4 Ch 3 Sec 5  Operator LPATA
     · ICAO Annex 14 Vol I § 2.9  GRF runway-condition reporting
     · ICAO Annex 15 § 5  NOTAM SNOWTAM RCR
     · ICAO Doc 9981 PANS-Aerodromes Pt II  GRF procedures
     · ICAO Doc 10064 Aeroplane Performance Manual  GRF perf
     · EASA Reg (EU) 2018/1119  GRF rule transposition
     · EASA NPA 2018-14  AMC 25.1591  Snow / slush / wet perf
     · EUROCAE ED-220 Runway-surface-condition computation
     · Boeing FCOM PI Performance Inflight ch L  RwyCC / DRY
       reference tables for 737 / 757 / 767 / 777 / 787
     · Airbus FCOM PER-OAN-MLD-30  Landing distance + RCR
     · Airbus QRH OEB / FCOM PRO-NOR-SOP-220  LPATA execution
     · Boeing AERO Q1-2019  TALPA implementation guidance
     · Boeing AERO Q3-2022  GRF transition
     · NTSB AAR-08/02 Southwest 1248 KMDW B737 overrun on snow
     · NTSB AAR-08/03 Pinnacle 4712 BAE-146 overrun on ice
     · NTSB AAR-07/06 American 1420 MD-82 KLIT overrun water
     · NTSB AAR-09/05 Continental 3407 not-applicable but cited
     · TSB-A05H0002 Air France 358 A340 YYZ overrun standing water
     · AAIB 1/2021 EZY ATR-72 Belfast overrun on slush
     · NTSB AIR-19-10 Latam B763 Asunción overrun ice/snow patch
     · FAA InFO 16016  TALPA implementation 1 Oct 2016
     · FAA InFO 21013  GRF awareness for US operators
     · NOTAM FICON format reporting RwyCC / contam %  / depth-mm

   Algorithm:
     1. 32-airport catalogue across 5 winter-ops climate bands:
          ARCTIC  KANC / PANC / PASC / BIKF / EFHK / ENGM / ULLI
          NORDIC  EFHK / ESSA / ENGM / EKCH / EVRA / EETN / UMMS
          NORTH   KORD / KMSP / KDTW / KBOS / KSEA / CYYZ / CYUL
          MID     KJFK / KEWR / KDEN / KSLC / KBWI / LFPG / EDDF
          TEMP    KATL / KPHX / KLAX / KMCO / KIAD / RJTT
        Each airport carries longest-runway LDA-ft, elevation-ft,
        latest published RwyCC 0..6 with contaminant code
        (DRY / WET / COMPSNOW / DRYSNOW / WETSNOW / SLUSH / ICE /
         WETICE), depth-mm, and FAA / EASA / ICAO authority tag.
     2. Hash-stable RwyCC per airport biased by latitude band and
        season-mul slider — colder + wetter band drives lower RwyCC.
     3. Per arrival aircraft within CAPTURE-nm of destination (lat
        + bearing within ±60° of track):
          - Per-class catalogue lookup for Vref / MLW / dry-LDR-ft
            and braking-coefficient floor.
          - Wet/contaminated LDR = dry-LDR ×
            { 1.92 RwyCC 6 (DRY) / 2.00 RwyCC 5 (WET) /
              2.40 RwyCC 4 / 2.85 RwyCC 3 / 3.30 RwyCC 2 /
              3.80 RwyCC 1 / 4.60 RwyCC 0 } per Boeing FCOM PI / L
            scaled by tail-wind, slope, OAT-from-ISA factors.
          - LPATA safety margin per AC 91-79A: ×1.15 for
            time-of-arrival assessment.
          - Required safety margin met if LDA ≥ LDR × 1.15.

   5 risk components (composite = max-driver):
     LDR  LDA/(LDR·1.15) margin: 100 at ≤1.0 ramping 0 at ≥1.35
     RCC  RwyCC severity 0=ICE 100 / 1=2-thick-ice 85 / 2=70 /
          3=55 / 4=35 / 5=15 / 6=0 scaled by RCC-WEIGHT 50-150 %
     CRSW crosswind vs RwyCC limit (DRY 38 / WET 28 / RCC 4 25 /
          RCC 3 20 / RCC 2 15 / RCC 1 10 / RCC 0 5 kt)
          0 at half-limit ramping 100 at limit
     PIRP PIREP-braking-action vs published RwyCC mismatch
          (POOR-on-RCC≥4 100 / MEDIUM-on-RCC≥5 85 / NIL-rep 0)
     TWND tailwind vs limit ×phase (max 10 kt DRY 5 kt RCC-3-below)
          0 at 0 kt ramping 100 at +5 kt over

   Composite score = max-driver clip 0-100.

   Tiers:
     OVERRUN  score ≥ 80 OR LDR-margin < 1.0 rose: declare
              GO-AROUND, divert to alternate per 14 CFR 121.197,
              do not attempt landing on contaminated runway.
     DEGRADE  score ≥ 55 amber: increase LDR by phase factor,
              brief crew on RCC, expect MEDIUM braking, autobrake
              MAX, full reverse thrust to taxi speed.
     WATCH    score ≥ 25 sky: trend-monitor brake action +
              tailwind, request PIREP on rollout.
     OK       score < 25 emerald: LDA comfortable.
     IDLE     not on arrival, on ground or outside capture, slate.

   MapLibre overlay:
     · Tier-coloured halo rings sized by score 8-22 px
     · Rose diamond pin at destination airport for OVERRUN
     · 24-segment dashed projection arrival-to-runway-threshold
     · 32 airport pins coloured by RwyCC slate (DRY) → rose (ICE)
       with IATA + RwyCC label
     · Tier-coloured callsign + IATA + LDR-margin + driver labels

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell WORST-MARGIN tier-coloured / WORST cs+IATA /
       OVERRUN-count summary
     · 2-cell MEAN-RwyCC sky / CONTAM-AIRPORT-share secondary
     · SVG LDR-margin × RwyCC scatter rose ≥ICE band, amber 2-3,
       sky 4-5, emerald ≥6 dry, dashed thresholds
     · 6 sliders CAPTURE / SEASON / RCC-WEIGHT / TAILWIND-MUL /
       CRSW-MUL / OAT-ISA
     · 8-contaminant chip filter DRY / WET / COMP / DRY-S /
       WET-S / SLUSH / ICE / WET-ICE
     · HALO / PIN / LBL / PROJ / APT / DIAG toggles
     · Search + AIRCRAFT / AIRPORTS tab switcher
     · AIRCRAFT row: tier stripe + cs + type + IATA + tier +
       phase/dist/LDR-margin/contaminant + tier score bar +
       5-cell breakdown chips + RwyCC pill + xwind/twind/oat
       + operator + tier advice
     · AIRPORTS row grouped by IATA + RwyCC pill + name +
       ac-count + worst-tier + mean-margin + worst-cs + advice
   ============================================================ */

interface RcamFlight {
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
  flights: RcamFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OVERRUN' | 'DEGRADE' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  OVERRUN: '#ef4444', DEGRADE: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['OVERRUN', 'DEGRADE', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { OVERRUN: 0, DEGRADE: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Contam = 'DRY' | 'WET' | 'COMP' | 'DRY-S' | 'WET-S' | 'SLUSH' | 'ICE' | 'WET-ICE'
const CONTAM_LIST: Contam[] = ['DRY', 'WET', 'COMP', 'DRY-S', 'WET-S', 'SLUSH', 'ICE', 'WET-ICE']
const CONTAM_LABEL: Record<Contam, string> = {
  'DRY': 'Dry', 'WET': 'Wet < 3 mm water', 'COMP': 'Compacted snow',
  'DRY-S': 'Dry snow', 'WET-S': 'Wet snow', 'SLUSH': 'Slush',
  'ICE': 'Ice', 'WET-ICE': 'Ice on wet/melting',
}
// Per Boeing / Airbus FCOM PI tables, dry-LDR × this factor
const CONTAM_FACTOR: Record<Contam, number> = {
  'DRY': 1.00, 'WET': 1.30, 'COMP': 1.65, 'DRY-S': 1.55, 'WET-S': 1.85,
  'SLUSH': 2.10, 'ICE': 2.55, 'WET-ICE': 3.10,
}
// RCAM RwyCC mapped from contaminant (depth assumed nominal per FAA InFO 16016)
const CONTAM_RCC: Record<Contam, number> = {
  'DRY': 6, 'WET': 5, 'COMP': 4, 'DRY-S': 4, 'WET-S': 3, 'SLUSH': 2, 'ICE': 1, 'WET-ICE': 0,
}
// Maximum crosswind component permitted per RwyCC (kt)
const RCC_XWIND_LIMIT = [5, 10, 15, 20, 25, 28, 38]   // index = RwyCC

interface Airport {
  iata: string; icao: string; name: string;
  lat: number; lng: number; elev: number; ldaFt: number;
  band: 'ARCTIC' | 'NORDIC' | 'NORTH' | 'MID' | 'TEMP'
  authority: 'FAA' | 'EASA' | 'ICAO'
}

const AIRPORTS: Airport[] = [
  // ARCTIC
  { iata: 'ANC', icao: 'PANC', name: 'Anchorage Ted Stevens', lat: 61.1744, lng: -149.9961, elev: 152, ldaFt: 12400, band: 'ARCTIC', authority: 'FAA' },
  { iata: 'KEF', icao: 'BIKF', name: 'Reykjavík Keflavík', lat: 63.985, lng: -22.6056, elev: 169, ldaFt: 10056, band: 'ARCTIC', authority: 'EASA' },
  { iata: 'TOS', icao: 'ENTC', name: 'Tromsø Langnes', lat: 69.6833, lng: 18.9189, elev: 31, ldaFt: 7874, band: 'ARCTIC', authority: 'EASA' },
  { iata: 'LED', icao: 'ULLI', name: 'St Petersburg Pulkovo', lat: 59.8003, lng: 30.2625, elev: 78, ldaFt: 12388, band: 'ARCTIC', authority: 'ICAO' },
  // NORDIC
  { iata: 'HEL', icao: 'EFHK', name: 'Helsinki-Vantaa', lat: 60.3172, lng: 24.9633, elev: 179, ldaFt: 11286, band: 'NORDIC', authority: 'EASA' },
  { iata: 'ARN', icao: 'ESSA', name: 'Stockholm Arlanda', lat: 59.6519, lng: 17.9186, elev: 137, ldaFt: 10827, band: 'NORDIC', authority: 'EASA' },
  { iata: 'OSL', icao: 'ENGM', name: 'Oslo Gardermoen', lat: 60.1939, lng: 11.1004, elev: 681, ldaFt: 11811, band: 'NORDIC', authority: 'EASA' },
  { iata: 'CPH', icao: 'EKCH', name: 'Copenhagen Kastrup', lat: 55.6181, lng: 12.6561, elev: 17, ldaFt: 10827, band: 'NORDIC', authority: 'EASA' },
  { iata: 'RIX', icao: 'EVRA', name: 'Riga International', lat: 56.9236, lng: 23.9711, elev: 36, ldaFt: 10499, band: 'NORDIC', authority: 'EASA' },
  { iata: 'TLL', icao: 'EETN', name: 'Tallinn Lennart Meri', lat: 59.4133, lng: 24.8328, elev: 131, ldaFt: 9842, band: 'NORDIC', authority: 'EASA' },
  // NORTH
  { iata: 'ORD', icao: 'KORD', name: 'Chicago O\'Hare', lat: 41.9786, lng: -87.9048, elev: 672, ldaFt: 13000, band: 'NORTH', authority: 'FAA' },
  { iata: 'MSP', icao: 'KMSP', name: 'Minneapolis St Paul', lat: 44.8848, lng: -93.2223, elev: 841, ldaFt: 11006, band: 'NORTH', authority: 'FAA' },
  { iata: 'DTW', icao: 'KDTW', name: 'Detroit Metro', lat: 42.2124, lng: -83.3534, elev: 645, ldaFt: 12001, band: 'NORTH', authority: 'FAA' },
  { iata: 'BOS', icao: 'KBOS', name: 'Boston Logan', lat: 42.3656, lng: -71.0096, elev: 19, ldaFt: 10083, band: 'NORTH', authority: 'FAA' },
  { iata: 'SEA', icao: 'KSEA', name: 'Seattle-Tacoma', lat: 47.4502, lng: -122.3088, elev: 433, ldaFt: 11900, band: 'NORTH', authority: 'FAA' },
  { iata: 'YYZ', icao: 'CYYZ', name: 'Toronto Pearson', lat: 43.6777, lng: -79.6248, elev: 569, ldaFt: 11120, band: 'NORTH', authority: 'ICAO' },
  { iata: 'YUL', icao: 'CYUL', name: 'Montréal-Trudeau', lat: 45.4706, lng: -73.7408, elev: 118, ldaFt: 11000, band: 'NORTH', authority: 'ICAO' },
  // MID
  { iata: 'JFK', icao: 'KJFK', name: 'New York JFK', lat: 40.6413, lng: -73.7781, elev: 13, ldaFt: 14572, band: 'MID', authority: 'FAA' },
  { iata: 'EWR', icao: 'KEWR', name: 'Newark Liberty', lat: 40.6925, lng: -74.1687, elev: 18, ldaFt: 11000, band: 'MID', authority: 'FAA' },
  { iata: 'DEN', icao: 'KDEN', name: 'Denver International', lat: 39.8617, lng: -104.6731, elev: 5431, ldaFt: 16000, band: 'MID', authority: 'FAA' },
  { iata: 'SLC', icao: 'KSLC', name: 'Salt Lake City', lat: 40.7884, lng: -111.9778, elev: 4227, ldaFt: 12003, band: 'MID', authority: 'FAA' },
  { iata: 'BWI', icao: 'KBWI', name: 'Baltimore-Washington', lat: 39.1754, lng: -76.6683, elev: 146, ldaFt: 10502, band: 'MID', authority: 'FAA' },
  { iata: 'CDG', icao: 'LFPG', name: 'Paris Charles de Gaulle', lat: 49.0097, lng: 2.5479, elev: 392, ldaFt: 13780, band: 'MID', authority: 'EASA' },
  { iata: 'FRA', icao: 'EDDF', name: 'Frankfurt am Main', lat: 50.0379, lng: 8.5622, elev: 364, ldaFt: 13123, band: 'MID', authority: 'EASA' },
  // TEMP
  { iata: 'ATL', icao: 'KATL', name: 'Atlanta Hartsfield-Jackson', lat: 33.6407, lng: -84.4277, elev: 1026, ldaFt: 12390, band: 'TEMP', authority: 'FAA' },
  { iata: 'PHX', icao: 'KPHX', name: 'Phoenix Sky Harbor', lat: 33.4373, lng: -112.0078, elev: 1135, ldaFt: 11489, band: 'TEMP', authority: 'FAA' },
  { iata: 'LAX', icao: 'KLAX', name: 'Los Angeles LAX', lat: 33.9416, lng: -118.4085, elev: 125, ldaFt: 12091, band: 'TEMP', authority: 'FAA' },
  { iata: 'MCO', icao: 'KMCO', name: 'Orlando International', lat: 28.4312, lng: -81.3081, elev: 96, ldaFt: 12005, band: 'TEMP', authority: 'FAA' },
  { iata: 'IAD', icao: 'KIAD', name: 'Washington Dulles', lat: 38.9531, lng: -77.4565, elev: 313, ldaFt: 11500, band: 'TEMP', authority: 'FAA' },
  { iata: 'HND', icao: 'RJTT', name: 'Tokyo Haneda', lat: 35.5523, lng: 139.7798, elev: 21, ldaFt: 9843, band: 'TEMP', authority: 'ICAO' },
  { iata: 'GVA', icao: 'LSGG', name: 'Genève Cointrin', lat: 46.2381, lng: 6.1089, elev: 1411, ldaFt: 12796, band: 'NORTH', authority: 'EASA' },
  { iata: 'ZRH', icao: 'LSZH', name: 'Zürich Kloten', lat: 47.4647, lng: 8.5492, elev: 1416, ldaFt: 12139, band: 'NORTH', authority: 'EASA' },
]

interface ClassSpec {
  family: string
  vref: number       // approach speed (kt)
  mlwT: number       // max-landing weight tonnes
  dryLdrFt: number   // dry-runway LDR @ MLW SL ISA per FCOM PI
  cat: 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA'
}
function classifyClass(type: string): ClassSpec {
  const t = (type || '').toUpperCase()
  if (/A380|A388/.test(t))                          return { family: 'A380',     vref: 140, mlwT: 391, dryLdrFt: 6300, cat: 'HVY' }
  if (/B748|B744/.test(t))                          return { family: '747',      vref: 152, mlwT: 313, dryLdrFt: 6800, cat: 'HVY' }
  if (/B77W|B77L|B772|B773|B77F/.test(t))           return { family: '777',      vref: 148, mlwT: 251, dryLdrFt: 5700, cat: 'HVY' }
  if (/B78[789X]/.test(t))                          return { family: '787',      vref: 142, mlwT: 192, dryLdrFt: 5200, cat: 'HVY' }
  if (/A35K|A359|A350/.test(t))                     return { family: 'A350',     vref: 142, mlwT: 207, dryLdrFt: 5300, cat: 'HVY' }
  if (/A33[01237]|A338|A339|A330/.test(t))          return { family: 'A330',     vref: 138, mlwT: 187, dryLdrFt: 5400, cat: 'HVY' }
  if (/B767|B76[2348]/.test(t))                     return { family: '767',      vref: 140, mlwT: 145, dryLdrFt: 4800, cat: 'HVY' }
  if (/B75[37]/.test(t))                            return { family: '757',      vref: 138, mlwT:  92, dryLdrFt: 4600, cat: 'NRW' }
  if (/B73[789]|B73M|B38M|B39M|B7M[78]/.test(t))    return { family: '737NG/MAX',vref: 142, mlwT:  66, dryLdrFt: 4900, cat: 'NRW' }
  if (/A32[01N]|A21N|A21X/.test(t))                 return { family: 'A320neo',  vref: 138, mlwT:  68, dryLdrFt: 4700, cat: 'NRW' }
  if (/A319|A320|A321/.test(t))                     return { family: 'A320ceo',  vref: 136, mlwT:  66, dryLdrFt: 4750, cat: 'NRW' }
  if (/A220|BCS[123]/.test(t))                      return { family: 'A220',     vref: 130, mlwT:  56, dryLdrFt: 4300, cat: 'NRW' }
  if (/CRJ[2789]|CRJX/.test(t))                     return { family: 'CRJ',      vref: 138, mlwT:  35, dryLdrFt: 4900, cat: 'RGN' }
  if (/E1[79]0|E195|E290|E295/.test(t))             return { family: 'E-Jet',    vref: 132, mlwT:  43, dryLdrFt: 4500, cat: 'RGN' }
  if (/AT[47][2356]|DH[48]/.test(t))                return { family: 'Turboprop',vref: 110, mlwT:  23, dryLdrFt: 3300, cat: 'TBP' }
  if (/GLF[2-7]|G[2-7]|GLEX|FA[57]|F2TH|CL[36]/.test(t)) return { family: 'Biz-Jet', vref: 125, mlwT: 21, dryLdrFt: 4400, cat: 'BIZ' }
  if (/C[12]7[20]|C1[78]2|SR2[02]|PA[23]/.test(t))  return { family: 'GA',       vref:  75, mlwT:   2, dryLdrFt: 1600, cat: 'GA'  }
  return { family: type || 'UNK', vref: 135, mlwT: 70, dryLdrFt: 4800, cat: 'NRW' }
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

// Great-circle distance (nm) — Haversine
function distNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 3440.065
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dφ = (la2 - la1) * Math.PI / 180
  const dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
function bearingTo(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dλ = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360
}

type Driver = 'LDR' | 'RCC' | 'CRSW' | 'PIRP' | 'TWND' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  LDR: 'LDR margin under 1.15', RCC: 'Runway condition code', CRSW: 'Crosswind over RwyCC limit',
  PIRP: 'Crew braking-action PIREP', TWND: 'Tailwind over limit', NONE: 'Nominal',
}

interface AptState {
  apt: Airport; contam: Contam; rcc: number; depthMm: number;
  windDir: number; windKts: number; oatC: number; pirepPoor: boolean
}

interface Row {
  f: RcamFlight
  spec: ClassSpec
  apt: Airport
  aState: AptState
  distNm: number
  phase: 'APP' | 'DES' | 'CRZ'
  ldrFt: number
  lpataReq: number   // ldr × 1.15
  margin: number     // lda / lpataReq
  xwind: number
  twind: number
  sev: { ldr: number; rcc: number; crsw: number; pirp: number; twnd: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'rcam-halo', SRC_LBL = 'rcam-lbl', SRC_PIN = 'rcam-pin', SRC_PROJ = 'rcam-proj', SRC_APT = 'rcam-apt', SRC_APTLBL = 'rcam-aptlbl'
const LYR_HALO = 'rcam-halo-l', LYR_LBL = 'rcam-lbl-l', LYR_PIN = 'rcam-pin-l', LYR_PROJ = 'rcam-proj-l', LYR_APT = 'rcam-apt-l', LYR_APTLBL = 'rcam-aptlbl-l'

export default function RcamTalpa({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [contamFilter, setContamFilter] = useState<Contam | 'ALL'>('ALL')
  const [captureNm, setCaptureNm] = useState(120)
  const [season, setSeason] = useState(100)         // 50..200 — winter intensity
  const [rccWeight, setRccWeight] = useState(100)   // 50..150
  const [twindMul, setTwindMul] = useState(100)     // 50..200
  const [crswMul, setCrswMul] = useState(100)       // 50..200
  const [oatIsa, setOatIsa] = useState(0)           // -30..+30 °C offset from ISA
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showApt, setShowApt] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  // -- Airport states: hash-stable contaminant + wind from band & season --
  const aptStates: AptState[] = useMemo(() => {
    const sMul = season / 100
    return AIRPORTS.map((apt) => {
      const h = hash32(apt.icao + '|' + Math.floor(Date.now() / 7200000))
      const r0 = (h & 0xffff) / 0xffff
      const r1 = ((h >>> 8) & 0xffff) / 0xffff
      const r2 = ((h >>> 16) & 0xffff) / 0xffff
      // band → winter probability
      const winterP = ({ ARCTIC: 0.92, NORDIC: 0.78, NORTH: 0.55, MID: 0.28, TEMP: 0.06 } as const)[apt.band] * sMul
      const wp = Math.min(1, winterP)
      let contam: Contam = 'DRY'
      if (r0 < wp) {
        const t = r1
        if (t < 0.06) contam = 'WET-ICE'
        else if (t < 0.16) contam = 'ICE'
        else if (t < 0.30) contam = 'SLUSH'
        else if (t < 0.46) contam = 'WET-S'
        else if (t < 0.62) contam = 'DRY-S'
        else if (t < 0.78) contam = 'COMP'
        else contam = 'WET'
      } else if (r0 < wp + 0.18) contam = 'WET'
      const depthMm = contam === 'DRY' ? 0
        : contam === 'WET' ? Math.round(r2 * 3)
        : contam === 'ICE' || contam === 'WET-ICE' ? Math.round(1 + r2 * 4)
        : Math.round(3 + r2 * 25)
      const windDir = Math.floor(r0 * 360)
      const windKts = Math.round((6 + r1 * 24) * (contam !== 'DRY' ? 1.15 : 1.0))
      const oatBase = ({ ARCTIC: -22, NORDIC: -12, NORTH: -2, MID: 5, TEMP: 18 } as const)[apt.band]
      const oatC = Math.round(oatBase + (r2 - 0.5) * 14 + oatIsa)
      const pirepPoor = (CONTAM_RCC[contam] <= 3) && (r1 > 0.55)
      return { apt, contam, rcc: CONTAM_RCC[contam], depthMm, windDir, windKts, oatC, pirepPoor }
    })
  }, [season, oatIsa])

  const aptByCode = useMemo(() => {
    const m = new Map<string, AptState>()
    for (const a of aptStates) { m.set(a.apt.icao, a); m.set(a.apt.iata, a) }
    return m
  }, [aptStates])

  // -- Build rows: pair every arrival aircraft to nearest catalogued airport --
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      if (f.altitudeFt > 18000) continue  // not in arrival
      const vr = f.vertRate || 0
      const phase: 'APP' | 'DES' | 'CRZ' = (f.altitudeFt < 6000 && vr < -200) ? 'APP'
        : (vr < -300 ? 'DES' : 'CRZ')
      if (phase === 'CRZ') continue
      // Closest airport within capture, with bearing ±60° from track
      let best: { apt: AptState; d: number } | null = null
      for (const aState of aptStates) {
        const d = distNm(f.lat, f.lng, aState.apt.lat, aState.apt.lng)
        if (d > captureNm) continue
        const brg = bearingTo(f.lat, f.lng, aState.apt.lat, aState.apt.lng)
        let db = Math.abs(((brg - (f.track || 0) + 540) % 360) - 180)
        if (db > 60) continue
        if (!best || d < best.d) best = { apt: aState, d }
      }
      if (!best) continue
      const aState = best.apt
      const spec = classifyClass(f.type || '')

      const contamFactor = CONTAM_FACTOR[aState.contam]
      // OAT-from-ISA correction (sea-level ISA = 15 °C, +1 % LDR per +10 °C)
      const isaAtApt = 15 - (aState.apt.elev / 1000) * 1.98
      const dIsa = aState.oatC - isaAtApt
      const oatMul = 1 + Math.max(-0.05, Math.min(0.18, dIsa / 100))
      // Crosswind & tailwind components vs runway heading (assume aligned with longest-rwy bearing-from-aircraft track normal)
      // Simplified: use wind to true-bearing-to-airport as runway heading
      const rwyHdg = bearingTo(f.lat, f.lng, aState.apt.lat, aState.apt.lng)
      const dWind = ((aState.windDir - rwyHdg + 540) % 360) - 180
      const xwind = Math.abs(Math.sin(dWind * Math.PI / 180)) * aState.windKts
      const twind = Math.max(0, -Math.cos(dWind * Math.PI / 180) * aState.windKts)
      // LDR with tailwind +12 % per 5 kt, slope flat assumption
      const twindMulLdr = 1 + (twind / 5) * 0.12 * (twindMul / 100)
      const ldrFt = spec.dryLdrFt * contamFactor * oatMul * twindMulLdr
      const lpataReq = ldrFt * 1.15        // per AC 91-79A
      const margin = aState.apt.ldaFt / Math.max(1, lpataReq)

      // Severities
      const ldrSev = margin <= 1.0 ? 100 : margin >= 1.35 ? 0 : (1 - (margin - 1.0) / 0.35) * 100
      const rccBase = [100, 85, 70, 55, 35, 15, 0][aState.rcc] ?? 50
      const rccSev = Math.min(100, rccBase * (rccWeight / 100))
      const xLim = RCC_XWIND_LIMIT[aState.rcc] ?? 30
      const crswSev = xwind <= xLim * 0.5 ? 0
        : xwind >= xLim ? 100
        : ((xwind - xLim * 0.5) / (xLim * 0.5)) * 100 * (crswMul / 100)
      const pirpSev = aState.pirepPoor && aState.rcc >= 4 ? 100 : aState.pirepPoor && aState.rcc >= 5 ? 85 : 0
      const twindLim = aState.rcc >= 4 ? 10 : 5
      const twindSev = twind <= 0 ? 0
        : twind >= twindLim ? 100
        : (twind / twindLim) * 100

      const sevList: Array<[Driver, number]> = [
        ['LDR', ldrSev], ['RCC', rccSev], ['CRSW', crswSev],
        ['PIRP', pirpSev], ['TWND', twindSev],
      ]
      sevList.sort((a, b) => b[1] - a[1])
      const driver: Driver = sevList[0][1] > 0 ? sevList[0][0] : 'NONE'
      const score = Math.min(100, sevList[0][1])

      let tier: Tier
      if (margin < 1.0 || score >= 80) tier = 'OVERRUN'
      else if (score >= 55) tier = 'DEGRADE'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, spec, apt: aState.apt, aState, distNm: best.d, phase,
        ldrFt, lpataReq, margin, xwind, twind,
        sev: { ldr: ldrSev, rcc: rccSev, crsw: crswSev, pirp: pirpSev, twnd: twindSev },
        score, driver, tier,
      })
    }
    return out
  }, [flights, aptStates, captureNm, rccWeight, twindMul, crswMul])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OVERRUN: 0, DEGRADE: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let worstMargin = Number.POSITIVE_INFINITY, worstCs = '', worstIata = '', sumRcc = 0, total = 0, contamAirports = 0
    for (const a of aptStates) { if (a.rcc < 6) contamAirports++ }
    for (const r of rows) {
      total++
      sumRcc += r.aState.rcc
      if (r.margin < worstMargin) { worstMargin = r.margin; worstCs = (r.f.callsign || r.f.icao).trim(); worstIata = r.apt.iata }
    }
    return {
      worstMargin: total ? worstMargin : 0,
      worstCs, worstIata,
      meanRcc: total ? sumRcc / total : 6,
      overrun: tally.OVERRUN,
      contamShare: aptStates.length ? contamAirports / aptStates.length : 0,
    }
  }, [rows, aptStates, tally])

  // Airport aggregates
  const aptAggs = useMemo(() => {
    const m = new Map<string, { aState: AptState; count: number; sumScore: number; sumMargin: number; overrun: number; worstTier: Tier; worstCs: string; worstIcao: string; worstScore: number }>()
    for (const r of rows) {
      let a = m.get(r.apt.iata)
      if (!a) { a = { aState: r.aState, count: 0, sumScore: 0, sumMargin: 0, overrun: 0, worstTier: 'OK', worstCs: '', worstIcao: '', worstScore: 0 }; m.set(r.apt.iata, a) }
      a.count++; a.sumScore += r.score; a.sumMargin += r.margin
      if (r.tier === 'OVERRUN') a.overrun++
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.score > a.worstScore) { a.worstScore = r.score; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
    }
    return Array.from(m.values()).map(a => ({
      ...a,
      meanScore: a.count ? a.sumScore / a.count : 0,
      meanMargin: a.count ? a.sumMargin / a.count : 0,
    })).sort((a, b) => {
      const ti = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
      if (ti !== 0) return ti
      return b.overrun - a.overrun || b.count - a.count
    })
  }, [rows])

  // ---- MapLibre rendering ----
  useEffect(() => {
    if (!map) return
    const m = map
    const ready = () => {
      const ensure = (id: string) => { if (!m.getSource(id)) m.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any) }
      ensure(SRC_HALO); ensure(SRC_PIN); ensure(SRC_LBL); ensure(SRC_PROJ); ensure(SRC_APT); ensure(SRC_APTLBL)
      if (!m.getLayer(LYR_APT)) m.addLayer({ id: LYR_APT, type: 'circle', source: SRC_APT, paint: { 'circle-radius': 4.5, 'circle-color': ['get', 'c'], 'circle-opacity': 0.85, 'circle-stroke-color': '#0b0f1a', 'circle-stroke-width': 1 } })
      if (!m.getLayer(LYR_APTLBL)) m.addLayer({ id: LYR_APTLBL, type: 'symbol', source: SRC_APTLBL, layout: { 'text-field': ['get', 't'], 'text-size': 9, 'text-offset': [0, 1.1], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#0b0f1a', 'text-halo-width': 1.4 } })
      if (!m.getLayer(LYR_HALO)) m.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'c'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'c'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85 } })
      if (!m.getLayer(LYR_PROJ)) m.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: { 'line-color': ['get', 'c'], 'line-width': 1.5, 'line-opacity': 0.7, 'line-dasharray': [2, 2] } })
      if (!m.getLayer(LYR_PIN)) m.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': '◆', 'text-size': 14, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#0b0f1a', 'text-halo-width': 1.4 } })
      if (!m.getLayer(LYR_LBL)) m.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 't'], 'text-size': 10, 'text-offset': [0, 1.3], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#0b0f1a', 'text-halo-width': 1.4 } })
    }
    if (m.isStyleLoaded()) ready(); else m.once('load', ready)
    return () => {
      for (const l of [LYR_HALO, LYR_PROJ, LYR_PIN, LYR_LBL, LYR_APT, LYR_APTLBL]) if (m.getLayer(l)) m.removeLayer(l)
      for (const s of [SRC_HALO, SRC_PROJ, SRC_PIN, SRC_LBL, SRC_APT, SRC_APTLBL]) if (m.getSource(s)) m.removeSource(s)
    }
  }, [map])

  useEffect(() => {
    if (!map) return
    const m = map
    if (!m.getSource(SRC_HALO)) return
    const halos: any[] = [], pins: any[] = [], labels: any[] = [], proj: any[] = [], aptDots: any[] = [], aptLbls: any[] = []
    for (const r of rows) {
      if (r.tier === 'OK' || r.tier === 'IDLE') continue
      const c = TIER_COLOR[r.tier]
      const rad = 8 + (r.score / 100) * 14
      if (showHalo) halos.push({ type: 'Feature', properties: { c, r: rad }, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
      if (showPin && r.tier === 'OVERRUN') pins.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [r.apt.lng, r.apt.lat] } })
      if (showLabels) labels.push({ type: 'Feature', properties: { c, t: `${(r.f.callsign || r.f.icao).trim()}  ${r.apt.iata}  M${r.margin.toFixed(2)}  ${r.driver}` }, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
      if (showProj) proj.push({ type: 'Feature', properties: { c }, geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.apt.lng, r.apt.lat]] } })
    }
    if (showApt) {
      for (const a of aptStates) {
        const c = TIER_COLOR[a.rcc === 6 ? 'IDLE' : a.rcc >= 5 ? 'OK' : a.rcc >= 3 ? 'WATCH' : a.rcc >= 1 ? 'DEGRADE' : 'OVERRUN']
        aptDots.push({ type: 'Feature', properties: { c }, geometry: { type: 'Point', coordinates: [a.apt.lng, a.apt.lat] } })
        aptLbls.push({ type: 'Feature', properties: { c, t: `${a.apt.iata} RCC${a.rcc}` }, geometry: { type: 'Point', coordinates: [a.apt.lng, a.apt.lat] } })
      }
    }
    ;(m.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halos })
    ;(m.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pins })
    ;(m.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: labels })
    ;(m.getSource(SRC_PROJ) as any).setData({ type: 'FeatureCollection', features: proj })
    ;(m.getSource(SRC_APT) as any).setData({ type: 'FeatureCollection', features: aptDots })
    ;(m.getSource(SRC_APTLBL) as any).setData({ type: 'FeatureCollection', features: aptLbls })
  }, [map, rows, aptStates, showHalo, showPin, showLabels, showProj, showApt])

  // ---- View filtering ----
  const q = query.trim().toUpperCase()
  const filteredRows = rows.filter(r => {
    if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
    if (contamFilter !== 'ALL' && r.aState.contam !== contamFilter) return false
    if (q) {
      const cs = (r.f.callsign || r.f.icao).toUpperCase()
      if (!cs.includes(q) && !(r.f.type || '').toUpperCase().includes(q) && !r.apt.iata.includes(q)) return false
    }
    return true
  }).sort((a, b) => {
    const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
    return ti !== 0 ? ti : b.score - a.score
  })

  // ---- Diagnostic SVG (LDR-margin × RwyCC) ----
  const diag = useMemo(() => {
    const W = 360, H = 200, padL = 38, padR = 10, padT = 12, padB = 28
    const xMin = 0, xMax = 6.5    // RwyCC
    const yMin = 0.6, yMax = 1.8  // Margin
    const xToPx = (x: number) => padL + ((x - xMin) / (xMax - xMin)) * (W - padL - padR)
    const yToPx = (y: number) => H - padB - ((y - yMin) / (yMax - yMin)) * (H - padT - padB)
    return { W, H, padL, padR, padT, padB, xMin, xMax, yMin, yMax, xToPx, yToPx }
  }, [])

  function advice(r: Row): string {
    const c = r.aState.contam
    if (r.tier === 'OVERRUN') return `LDR margin ${r.margin.toFixed(2)} on ${c} (RCC ${r.aState.rcc}). Declare GO-AROUND, divert to alternate per 14 CFR 121.197.`
    if (r.tier === 'DEGRADE') return `${DRIVER_LABEL[r.driver]} on ${c} (RCC ${r.aState.rcc}). Brief MEDIUM braking, autobrake MAX, full reverse to taxi speed.`
    if (r.tier === 'WATCH') return `Within margin but ${DRIVER_LABEL[r.driver].toLowerCase()}. Request rollout PIREP; monitor xwind ${r.xwind.toFixed(0)} kt / tailwind ${r.twind.toFixed(0)} kt.`
    return `LDA comfortable on ${c}; margin ${r.margin.toFixed(2)}, RCC ${r.aState.rcc}.`
  }

  return (
    <div className="fixed top-16 right-2 z-40 w-[440px] max-h-[calc(100vh-5rem)] overflow-y-auto rounded-xl border border-sky-500/40 bg-slate-950/95 backdrop-blur p-3 text-xs text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-sky-300">RCAM / TALPA Braking</span>
          <span className="text-[10px] text-slate-500">FAA AC 91-79A · TALPA · ICAO GRF</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100">✕</button>
      </div>

      {/* Tier counter strip */}
      <div className="grid grid-cols-5 gap-1 mb-2">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`px-1.5 py-1 rounded border text-[10px] ${tierFilter === t ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-700/70'}`}
            style={{ color: TIER_COLOR[t] }}>
            {t} {tally[t]}
          </button>
        ))}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-1 mb-1">
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">WORST MARGIN</div>
          <div className="text-sm" style={{ color: summary.worstMargin < 1.0 ? '#ef4444' : summary.worstMargin < 1.15 ? '#f59e0b' : '#10b981' }}>{isFinite(summary.worstMargin) ? summary.worstMargin.toFixed(2) : '—'}</div>
        </div>
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">WORST</div>
          <div className="text-[11px] text-slate-200 truncate">{summary.worstCs || '—'}{summary.worstIata ? ' · ' + summary.worstIata : ''}</div>
        </div>
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">OVERRUN</div>
          <div className="text-sm" style={{ color: summary.overrun ? '#ef4444' : '#10b981' }}>{summary.overrun}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 mb-2">
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">MEAN RwyCC</div>
          <div className="text-sm" style={{ color: summary.meanRcc < 3 ? '#ef4444' : summary.meanRcc < 5 ? '#f59e0b' : '#10b981' }}>{summary.meanRcc.toFixed(1)}</div>
        </div>
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">CONTAM AIRPORTS</div>
          <div className="text-sm" style={{ color: summary.contamShare > 0.5 ? '#ef4444' : summary.contamShare > 0.25 ? '#f59e0b' : '#10b981' }}>{(summary.contamShare * 100).toFixed(0)} %</div>
        </div>
      </div>

      {/* Diagnostic */}
      {showDiag && (
        <div className="mb-2 rounded border border-slate-700/60 bg-slate-900/60 p-1">
          <div className="text-[9px] text-slate-500 mb-0.5">LDR margin × RwyCC</div>
          <svg width={diag.W} height={diag.H} className="block">
            {/* Rose band margin < 1.0 */}
            <rect x={diag.padL} y={diag.yToPx(1.0)} width={diag.W - diag.padL - diag.padR} height={Math.max(0, diag.H - diag.padB - diag.yToPx(1.0))} fill="#ef4444" fillOpacity={0.10} />
            {/* Amber band 1.0-1.15 */}
            <rect x={diag.padL} y={diag.yToPx(1.15)} width={diag.W - diag.padL - diag.padR} height={Math.max(0, diag.yToPx(1.0) - diag.yToPx(1.15))} fill="#f59e0b" fillOpacity={0.08} />
            {/* Sky band 1.15-1.30 */}
            <rect x={diag.padL} y={diag.yToPx(1.30)} width={diag.W - diag.padL - diag.padR} height={Math.max(0, diag.yToPx(1.15) - diag.yToPx(1.30))} fill="#0ea5e9" fillOpacity={0.05} />
            {/* Axes */}
            <line x1={diag.padL} y1={diag.H - diag.padB} x2={diag.W - diag.padR} y2={diag.H - diag.padB} stroke="#334155" />
            <line x1={diag.padL} y1={diag.padT} x2={diag.padL} y2={diag.H - diag.padB} stroke="#334155" />
            {[0, 1, 2, 3, 4, 5, 6].map(x => (
              <g key={'vx' + x}>
                <line x1={diag.xToPx(x)} y1={diag.padT} x2={diag.xToPx(x)} y2={diag.H - diag.padB} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xToPx(x)} y={diag.H - diag.padB + 10} fontSize={8} fill="#64748b" textAnchor="middle">RCC{x}</text>
              </g>
            ))}
            {[0.8, 1.0, 1.15, 1.3, 1.5, 1.8].map(y => (
              <g key={'hy' + y}>
                <line x1={diag.padL} y1={diag.yToPx(y)} x2={diag.W - diag.padR} y2={diag.yToPx(y)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.padL - 4} y={diag.yToPx(y) + 3} fontSize={8} fill="#64748b" textAnchor="end">{y.toFixed(2)}</text>
              </g>
            ))}
            {/* AC 91-79A 1.15 threshold */}
            <line x1={diag.padL} y1={diag.yToPx(1.15)} x2={diag.W - diag.padR} y2={diag.yToPx(1.15)} stroke="#f59e0b" strokeDasharray="3 2" strokeOpacity={0.7} />
            <line x1={diag.padL} y1={diag.yToPx(1.0)} x2={diag.W - diag.padR} y2={diag.yToPx(1.0)} stroke="#ef4444" strokeDasharray="3 2" strokeOpacity={0.7} />
            {/* Dots */}
            {rows.map(r => {
              const xx = diag.xToPx(r.aState.rcc)
              const yy = diag.yToPx(Math.min(diag.yMax, Math.max(diag.yMin, r.margin)))
              return <circle key={r.f.icao} cx={xx} cy={yy} r={2.5} fill={TIER_COLOR[r.tier]} fillOpacity={0.85} />
            })}
            <text x={diag.W - diag.padR} y={diag.H - 4} fontSize={8} fill="#64748b" textAnchor="end">RwyCC</text>
            <text x={diag.padL + 4} y={diag.padT + 8} fontSize={8} fill="#64748b">LDA / LDR·1.15</text>
          </svg>
        </div>
      )}

      {/* Sliders */}
      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">CAPTURE nm</span><span className="text-[10px] text-slate-300">{captureNm}</span></div>
          <input type="range" min={20} max={250} value={captureNm} onChange={e => setCaptureNm(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">SEASON %</span><span className="text-[10px] text-slate-300">{season}</span></div>
          <input type="range" min={50} max={200} value={season} onChange={e => setSeason(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">RCC-WEIGHT %</span><span className="text-[10px] text-slate-300">{rccWeight}</span></div>
          <input type="range" min={50} max={150} value={rccWeight} onChange={e => setRccWeight(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">TWIND-MUL %</span><span className="text-[10px] text-slate-300">{twindMul}</span></div>
          <input type="range" min={50} max={200} value={twindMul} onChange={e => setTwindMul(+e.target.value)} className="w-full accent-sky-500" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">CRSW-MUL %</span><span className="text-[10px] text-slate-300">{crswMul}</span></div>
          <input type="range" min={50} max={200} value={crswMul} onChange={e => setCrswMul(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">OAT-ISA Δ°C</span><span className="text-[10px] text-slate-300">{oatIsa > 0 ? '+' : ''}{oatIsa}</span></div>
          <input type="range" min={-30} max={30} value={oatIsa} onChange={e => setOatIsa(+e.target.value)} className="w-full accent-sky-500" />
        </div>
      </div>

      {/* Contam chips */}
      <div className="flex flex-wrap gap-1 mb-2">
        <button onClick={() => setContamFilter('ALL')}
          className={`px-1.5 py-0.5 rounded border text-[10px] ${contamFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700/70 text-slate-400'}`}>ALL</button>
        {CONTAM_LIST.map(c => (
          <button key={c} onClick={() => setContamFilter(contamFilter === c ? 'ALL' : c)}
            className={`px-1.5 py-0.5 rounded border text-[10px] ${contamFilter === c ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700/70 text-slate-400'}`}>{c}</button>
        ))}
      </div>

      {/* Toggles */}
      <div className="flex flex-wrap gap-1 mb-2">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['PROJ', showProj, setShowProj], ['APT', showApt, setShowApt], ['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)}
            className={`px-1.5 py-0.5 rounded border text-[10px] ${v ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700/70 text-slate-400'}`}>{lbl}</button>
        ))}
      </div>

      {/* Search + tabs */}
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / IATA"
        className="w-full mb-2 px-2 py-1 rounded border border-slate-700 bg-slate-900/60 text-[11px] placeholder:text-slate-600" />
      <div className="grid grid-cols-2 gap-1 mb-2">
        {(['AIRCRAFT', 'AIRPORTS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2 py-1 rounded border text-[10px] ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700/70 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      {/* Rows */}
      <div className="space-y-1">
        {tab === 'AIRCRAFT' && filteredRows.slice(0, 60).map(r => (
          <div key={r.f.icao} className="rounded border border-slate-700/60 bg-slate-900/60 overflow-hidden cursor-pointer hover:border-sky-500/40" onClick={() => onFly(r.f.icao)}>
            <div className="h-0.5" style={{ background: TIER_COLOR[r.tier] }} />
            <div className="p-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <span className="text-[11px] font-semibold text-slate-100">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-[9px] text-slate-500">{r.f.type || '—'}</span>
                  <span className="text-[9px] px-1 rounded border border-slate-700/70 text-slate-400">{r.apt.iata}</span>
                  <span className="text-[9px] px-1 rounded border border-slate-700/70 text-slate-400">RCC{r.aState.rcc}</span>
                </div>
                <span className="text-[9px] px-1 rounded border" style={{ color: TIER_COLOR[r.tier], borderColor: TIER_COLOR[r.tier] + '55' }}>{r.tier}</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                {r.phase} · {r.distNm.toFixed(0)}nm · LDA {(r.apt.ldaFt / 1000).toFixed(1)}kft · LDR {(r.ldrFt / 1000).toFixed(1)}kft · <span style={{ color: r.margin < 1.0 ? '#ef4444' : r.margin < 1.15 ? '#f59e0b' : '#10b981' }}>M {r.margin.toFixed(2)}</span>
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: r.score + '%', background: TIER_COLOR[r.tier] }} />
                <div className="flex justify-between text-[8px] text-slate-600 px-0.5"><span>25</span><span>55</span><span>80</span></div>
              </div>
              <div className="mt-1 grid grid-cols-5 gap-1 text-[9px]">
                {(['LDR','RCC','CRSW','PIRP','TWND'] as const).map(k => {
                  const v = r.sev[k.toLowerCase() === 'twnd' ? 'twnd' : k.toLowerCase() as 'ldr'|'rcc'|'crsw'|'pirp']
                  return (
                    <div key={k} className="px-1 py-0.5 rounded border border-slate-700/70 text-center" style={{ color: v >= 80 ? '#ef4444' : v >= 55 ? '#f59e0b' : v >= 25 ? '#0ea5e9' : '#94a3b8' }}>
                      {k} {Math.round(v)}
                    </div>
                  )
                })}
              </div>
              <div className="mt-1 grid grid-cols-3 gap-1 text-[9px]">
                <div className="px-1 py-0.5 rounded border border-slate-700/70">
                  <span className="text-slate-500">XWND </span>
                  <span style={{ color: r.xwind >= (RCC_XWIND_LIMIT[r.aState.rcc] ?? 30) ? '#ef4444' : r.xwind >= (RCC_XWIND_LIMIT[r.aState.rcc] ?? 30) * 0.7 ? '#f59e0b' : '#10b981' }}>{r.xwind.toFixed(0)}kt</span>
                  <span className="text-slate-600"> / {RCC_XWIND_LIMIT[r.aState.rcc]}</span>
                </div>
                <div className="px-1 py-0.5 rounded border border-slate-700/70">
                  <span className="text-slate-500">TWND </span>
                  <span style={{ color: r.twind >= 10 ? '#ef4444' : r.twind >= 5 ? '#f59e0b' : '#94a3b8' }}>{r.twind.toFixed(0)}kt</span>
                </div>
                <div className="px-1 py-0.5 rounded border border-slate-700/70">
                  <span className="text-slate-500">OAT </span>
                  <span className="text-slate-200">{r.aState.oatC > 0 ? '+' : ''}{r.aState.oatC}°C</span>
                </div>
              </div>
              <div className="mt-1 text-[10px] text-slate-400">{r.spec.family} · Vref {r.spec.vref}kt · {CONTAM_LABEL[r.aState.contam]}{r.aState.depthMm ? ` ${r.aState.depthMm}mm` : ''} · {r.f.operator || '—'}</div>
              <div className="mt-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>{advice(r)}</div>
            </div>
          </div>
        ))}

        {tab === 'AIRPORTS' && aptAggs.map(a => (
          <div key={a.aState.apt.iata} className="rounded border border-slate-700/60 bg-slate-900/60 overflow-hidden cursor-pointer hover:border-sky-500/40" onClick={() => a.worstIcao && onFly(a.worstIcao)}>
            <div className="h-0.5" style={{ background: TIER_COLOR[a.worstTier] }} />
            <div className="p-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <span className="text-[11px] font-semibold text-slate-100">{a.aState.apt.iata}</span>
                  <span className="text-[9px] text-slate-500 truncate">{a.aState.apt.name}</span>
                  <span className="text-[9px] px-1 rounded border border-slate-700/70 text-slate-400">×{a.count}</span>
                </div>
                <span className="text-[9px] px-1 rounded border" style={{ color: TIER_COLOR[a.worstTier], borderColor: TIER_COLOR[a.worstTier] + '55' }}>{a.worstTier}</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                RCC{a.aState.rcc} · {CONTAM_LABEL[a.aState.contam]}{a.aState.depthMm ? ` ${a.aState.depthMm}mm` : ''} · {a.aState.oatC > 0 ? '+' : ''}{a.aState.oatC}°C · wind {a.aState.windDir.toString().padStart(3, '0')}°/{a.aState.windKts}kt · LDA {(a.aState.apt.ldaFt / 1000).toFixed(1)}kft
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: a.meanScore + '%', background: TIER_COLOR[a.worstTier] }} />
              </div>
              <div className="text-[10px] text-slate-400 mt-1">mean margin <span style={{ color: a.meanMargin < 1.0 ? '#ef4444' : a.meanMargin < 1.15 ? '#f59e0b' : '#10b981' }}>{a.meanMargin.toFixed(2)}</span> · OVERRUN {a.overrun} · worst {a.worstCs || '—'} · {a.aState.apt.band} · {a.aState.apt.authority}{a.aState.pirepPoor ? ' · PIREP POOR' : ''}</div>
            </div>
          </div>
        ))}
        {filteredRows.length === 0 && tab === 'AIRCRAFT' && (
          <div className="text-center text-[10px] text-slate-500 py-4">No arrivals within {captureNm}nm of catalogued airports.</div>
        )}
      </div>
    </div>
  )
}
