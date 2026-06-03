'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   PAPI · VGSI · Visual Glide-Slope Indicator Deviation Monitor
   -----------------------------------------------------------
   Per-arrival visual-approach glide-path conformance against
   the published PAPI (Precision Approach Path Indicator), APAPI
   (Abbreviated PAPI), T-VASIS, AT-VASIS, PVASI or A-VASI angle
   and MEHT (Minimum Eye Height over Threshold) on a 32-runway
   global VGSI installation catalogue. The monitor computes the
   pilot-eye glide-slope deviation (fly-up / fly-down) from the
   target PAPI bar, infers the on-bar light pattern the crew is
   seeing (4 white / 3W-1R / 2W-2R on-slope / 1W-3R / 4 red),
   tests wheel-clearance over the threshold against MEHT and
   scores stable-approach gate compliance per AC 120-71B at 1000
   AAL IMC / 500 AAL VMC.

   Regulatory & operational basis:
     · ICAO Annex 14 Vol I §5.3.5 PAPI / 5.3.6 APAPI / 5.3.4
       T-VASIS / Doc 9157 Pt 4 Visual Aids Ch 11
     · FAA AC 150/5345-28G PAPI specification / 150/5340-30J
       siting / Order 6850.2B PAPI maintenance / JO 7110.65 §3-2
     · 14 CFR 91.129(e)(3) visual glide-slope use when operational
     · ICAO PANS-OPS Doc 8168 Vol II Pt I §4 final approach
     · FAA AC 120-71B Standard Operating Procedures - stable
       approach gates (1000 ft IMC / 500 ft VMC AAL)
     · IATA Operations Manual Ch 9 unstable approach
     · Boeing FCTM Approach §5.5 / Airbus FCTM PR-AOP-FNL
       visual aim point
     · TERPS 8260.3D ch 14 visual approach slope
     · NTSB AAR-15-02 UPS 1354 BHM CFIT (low on profile,
       descended below visual glide path)
     · NTSB AAR-14-01 Asiana 214 SFO 28L (auto-throttle low
       energy, four-red PAPI before impact on seawall)
     · NTSB AAR-13-02 UPS 1354 / DCA13MA081 / AAB-08/01 Heron
       Air 4226 TLV (4-red continuation)
     · ATSB AO-2009-072 PK-CKM Garuda 200 YIA seawall low PAPI

   --- 32-runway VGSI installation catalogue ---
   Type / angle / MEHT (ft) per Annex 14 Tbl 5-2:
     PAPI  4-box  3.0° standard  MEHT 30 ft narrow / 50 ft wide body
     APAPI 2-box  3.0° general-aviation airports
     T-VASIS / AT-VASIS  6 wing-bar  3.0° (legacy AU/NZ)
     Steep PAPI: EGLC London City 5.5° · LSZA Lugano 6.65° ·
       LOWI Innsbruck 3.8° · LSGS Sion 6.0° · NZQN 6.43° ·
       LIPB Bolzano 4.5°
     KASE Aspen 3.5° hot-and-high derate · KSAN Lindbergh
       3.5° Point-Loma obstacle · OERK Riyadh 3.2° high-DA

   --- 6-class aircraft eye-wheel & MEHT requirement ---
     HVY-Q  747-8 A380           eye-wheel 16.0 ft  MEHT req 50 ft
     HVY    777 787 A350 A330    eye-wheel 13.5 ft  MEHT req 45 ft
     NRW    737 A320 757         eye-wheel  9.0 ft  MEHT req 30 ft
     RGN    CRJ E-Jet            eye-wheel  6.5 ft  MEHT req 25 ft
     BIZ    GLF FA7X CL30        eye-wheel  6.0 ft  MEHT req 25 ft
     TBP    ATR Q400             eye-wheel  6.5 ft  MEHT req 25 ft

   --- 5 risk drivers (max-driver composite) ---
     VPD  vertical-path-deviation ft vs target glide-path at
          present range from threshold (signed; negative = below)
          0 at |Δ| ≤ ±25 / 25 at ±50 / 55 at ±100 / 80 at ±200 /
          100 at |Δ| ≥ 300 ft
     LIT  PAPI light interpretation severity
          on-slope 0 / 1-bar low or high 35 / 2-bar 70 / 4R 100
     MET  Minimum Eye Height over Threshold breach
          0 at MEHT met / 100 at wheel below threshold elev
     STA  stable-approach gate per AC 120-71B
          0 stable / 50 marginal / 100 unstable at 500 ft AAL
     CWO  visual obstacle clearance on final 0 → 100 ramp

   Phase multiplier
     FLARE     1.50  (impact-window)
     SHRT-FNL  1.40  (< 500 AAL, within MEHT window)
     APP       1.20
     OTHER     0.40

   Hard escalations
     · 4-red PAPI within 500 AAL & MEHT-breach ≥ 92 (Asiana-214 tier)
     · VPD ≤ -200 ft on SHRT-FNL ≥ 88 (UPS-1354 tier)
     · STA = unstable past 500 AAL ≥ 80

   5 tiers
     ASIANA-214    score ≥ 80  rose   GO-AROUND now · low energy
                                       four-red PAPI · re-arm A/T
                                       per FCOM AOM 5.7
     UPS-1354      score ≥ 55  amber  PUSH UP descent below
                                       visual glide path correct to
                                       target PAPI 2R-2W
     WATCH         score ≥ 25  sky    Monitor PAPI bar trend
                                       cross-check VNAV/IM profile
     ON-SLOPE      score < 25  emerald 2R-2W stable per AC 120-71B
     IDLE          out-of-scope slate
   ============================================================
*/

type Tier = 'ASIANA-214' | 'UPS-1354' | 'WATCH' | 'ON-SLOPE' | 'IDLE'
type AcClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
type Phase = 'FLARE' | 'SHRT-FNL' | 'APP' | 'OTHER'
type VgsiType = 'PAPI' | 'APAPI' | 'T-VASIS' | 'PVASI'
type LightPattern = '4W' | '3W1R' | '2W2R' | '1W3R' | '4R'

interface VFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt?: number | null; velocityKts?: number | null
  track?: number | null; vertRate?: number | null; ground?: boolean
}

interface VgsiSpec {
  icao: string; name: string; rwId: string
  thrLat: number; thrLng: number; thrElevFt: number
  qfu: number; angleDeg: number; mehtFt: number
  type: VgsiType; notes: string
}

const VGSI_CATALOGUE: VgsiSpec[] = [
  { icao: 'KSFO', name: 'San Francisco', rwId: '28L', thrLat: 37.613, thrLng: -122.357, thrElevFt: 13, qfu: 281, angleDeg: 3.0, mehtFt: 65, type: 'PAPI', notes: 'Asiana 214 site · 4-box PAPI seawall' },
  { icao: 'KSFO', name: 'San Francisco', rwId: '28R', thrLat: 37.626, thrLng: -122.391, thrElevFt: 13, qfu: 281, angleDeg: 3.0, mehtFt: 67, type: 'PAPI', notes: '4-box' },
  { icao: 'KBHM', name: 'Birmingham AL', rwId: '18', thrLat: 33.572, thrLng: -86.752, thrElevFt: 644, qfu: 180, angleDeg: 3.2, mehtFt: 56, type: 'PAPI', notes: 'UPS 1354 site · CFIT short of rwy' },
  { icao: 'EGLC', name: 'London City', rwId: '09', thrLat: 51.502, thrLng: 0.040, thrElevFt: 19, qfu: 90, angleDeg: 5.5, mehtFt: 50, type: 'PAPI', notes: 'Steep PAPI 5.5° special-aircraft cert' },
  { icao: 'EGLC', name: 'London City', rwId: '27', thrLat: 51.505, thrLng: 0.072, thrElevFt: 19, qfu: 270, angleDeg: 5.5, mehtFt: 50, type: 'PAPI', notes: 'Steep PAPI 5.5°' },
  { icao: 'LSZA', name: 'Lugano', rwId: '19', thrLat: 46.011, thrLng: 8.909, thrElevFt: 915, qfu: 187, angleDeg: 6.65, mehtFt: 38, type: 'PAPI', notes: 'Steepest scheduled PAPI 6.65° Alpine' },
  { icao: 'LOWI', name: 'Innsbruck', rwId: '08', thrLat: 47.259, thrLng: 11.329, thrElevFt: 1907, qfu: 80, angleDeg: 3.8, mehtFt: 60, type: 'PAPI', notes: 'Inn valley curved visual' },
  { icao: 'LSGS', name: 'Sion', rwId: '25', thrLat: 46.220, thrLng: 7.343, thrElevFt: 1583, qfu: 250, angleDeg: 6.0, mehtFt: 40, type: 'PAPI', notes: 'Rhone valley steep PAPI' },
  { icao: 'NZQN', name: 'Queenstown', rwId: '23', thrLat: -45.013, thrLng: 168.751, thrElevFt: 1171, qfu: 234, angleDeg: 6.43, mehtFt: 38, type: 'PAPI', notes: 'Steep PAPI 6.43° Lake Wakatipu' },
  { icao: 'LIPB', name: 'Bolzano', rwId: '01', thrLat: 46.457, thrLng: 11.324, thrElevFt: 789, qfu: 1, angleDeg: 4.5, mehtFt: 45, type: 'PAPI', notes: 'Alpine valley 4.5°' },
  { icao: 'KASE', name: 'Aspen', rwId: '15', thrLat: 39.231, thrLng: -106.864, thrElevFt: 7820, qfu: 154, angleDeg: 3.5, mehtFt: 51, type: 'PAPI', notes: 'Hot-high 3.5°' },
  { icao: 'KEGE', name: 'Eagle CO', rwId: '25', thrLat: 39.643, thrLng: -106.916, thrElevFt: 6548, qfu: 252, angleDeg: 3.5, mehtFt: 55, type: 'PAPI', notes: 'Mountain 3.5°' },
  { icao: 'KSAN', name: 'San Diego', rwId: '27', thrLat: 32.732, thrLng: -117.196, thrElevFt: 17, qfu: 273, angleDeg: 3.5, mehtFt: 49, type: 'PAPI', notes: 'Point Loma obstacle 3.5°' },
  { icao: 'KTEX', name: 'Telluride', rwId: '9', thrLat: 37.954, thrLng: -107.910, thrElevFt: 9078, qfu: 90, angleDeg: 3.0, mehtFt: 50, type: 'PAPI', notes: 'Highest elev PAPI in US' },
  { icao: 'KJAC', name: 'Jackson Hole', rwId: '19', thrLat: 43.605, thrLng: -110.738, thrElevFt: 6447, qfu: 191, angleDeg: 3.0, mehtFt: 53, type: 'PAPI', notes: 'Mountain' },
  { icao: 'KLGA', name: 'New York LGA', rwId: '4', thrLat: 40.773, thrLng: -73.879, thrElevFt: 12, qfu: 31, angleDeg: 3.5, mehtFt: 56, type: 'PAPI', notes: 'Water-bounded 3.5°' },
  { icao: 'KLGA', name: 'New York LGA', rwId: '13', thrLat: 40.788, thrLng: -73.886, thrElevFt: 21, qfu: 130, angleDeg: 3.1, mehtFt: 58, type: 'PAPI', notes: 'Expressway visual 3.1°' },
  { icao: 'KDCA', name: 'Washington DCA', rwId: '19', thrLat: 38.864, thrLng: -77.043, thrElevFt: 14, qfu: 188, angleDeg: 3.0, mehtFt: 53, type: 'PAPI', notes: 'River visual' },
  { icao: 'OMDB', name: 'Dubai', rwId: '12R', thrLat: 25.252, thrLng: 55.341, thrElevFt: 62, qfu: 122, angleDeg: 3.0, mehtFt: 75, type: 'PAPI', notes: 'EK521 site · long-flare go-around' },
  { icao: 'VHHH', name: 'Hong Kong', rwId: '07R', thrLat: 22.298, thrLng: 113.910, thrElevFt: 28, qfu: 72, angleDeg: 3.0, mehtFt: 75, type: 'PAPI', notes: 'Wide-body 4-box' },
  { icao: 'RJTT', name: 'Tokyo Haneda', rwId: '34L', thrLat: 35.547, thrLng: 139.768, thrElevFt: 21, qfu: 340, angleDeg: 3.0, mehtFt: 60, type: 'PAPI', notes: 'Bay PAPI' },
  { icao: 'WSSS', name: 'Singapore', rwId: '20C', thrLat: 1.366, thrLng: 103.994, thrElevFt: 22, qfu: 200, angleDeg: 3.0, mehtFt: 75, type: 'PAPI', notes: '4-box wide' },
  { icao: 'EGLL', name: 'London Heathrow', rwId: '27L', thrLat: 51.477, thrLng: -0.434, thrElevFt: 79, qfu: 270, angleDeg: 3.0, mehtFt: 75, type: 'PAPI', notes: '4-box wide-body' },
  { icao: 'LFPG', name: 'Paris CDG', rwId: '27R', thrLat: 49.005, thrLng: 2.611, thrElevFt: 392, qfu: 268, angleDeg: 3.0, mehtFt: 70, type: 'PAPI', notes: '4-box' },
  { icao: 'EDDF', name: 'Frankfurt', rwId: '25C', thrLat: 50.041, thrLng: 8.585, thrElevFt: 364, qfu: 250, angleDeg: 3.0, mehtFt: 65, type: 'PAPI', notes: '4-box' },
  { icao: 'CYYZ', name: 'Toronto Pearson', rwId: '24L', thrLat: 43.703, thrLng: -79.621, thrElevFt: 569, qfu: 235, angleDeg: 3.0, mehtFt: 65, type: 'PAPI', notes: '4-box' },
  { icao: 'KMDW', name: 'Chicago Midway', rwId: '31C', thrLat: 41.788, thrLng: -87.745, thrElevFt: 619, qfu: 314, angleDeg: 3.0, mehtFt: 53, type: 'PAPI', notes: 'Short displaced thr' },
  { icao: 'KSNA', name: 'John Wayne SNA', rwId: '20R', thrLat: 33.681, thrLng: -117.853, thrElevFt: 56, qfu: 200, angleDeg: 3.0, mehtFt: 51, type: 'PAPI', notes: 'Noise-abate steep avail' },
  { icao: 'KEYW', name: 'Key West', rwId: '9', thrLat: 24.555, thrLng: -81.766, thrElevFt: 3, qfu: 88, angleDeg: 3.0, mehtFt: 40, type: 'APAPI', notes: 'APAPI 2-box GA' },
  { icao: 'PHTO', name: 'Hilo HI', rwId: '26', thrLat: 19.722, thrLng: -155.041, thrElevFt: 38, qfu: 261, angleDeg: 3.0, mehtFt: 51, type: 'PAPI', notes: 'Trade-wind visual' },
  { icao: 'YSSY', name: 'Sydney Kingsford', rwId: '34L', thrLat: -33.954, thrLng: 151.176, thrElevFt: 22, qfu: 343, angleDeg: 3.0, mehtFt: 65, type: 'T-VASIS', notes: 'Legacy T-VASIS' },
  { icao: 'NZAA', name: 'Auckland', rwId: '23L', thrLat: -36.998, thrLng: 174.793, thrElevFt: 23, qfu: 230, angleDeg: 3.0, mehtFt: 65, type: 'T-VASIS', notes: 'Legacy T-VASIS' },
]

interface ClassSpec { cls: AcClass; eyeWheel: number; mehtReqFt: number; vrefKt: number; family: string }
const CLASSES: Record<AcClass, ClassSpec> = {
  'HVY-Q': { cls: 'HVY-Q', eyeWheel: 16.0, mehtReqFt: 50, vrefKt: 152, family: '747-8 / A380' },
  'HVY':   { cls: 'HVY',   eyeWheel: 13.5, mehtReqFt: 45, vrefKt: 145, family: '777 / 787 / A350 / A330' },
  'NRW':   { cls: 'NRW',   eyeWheel:  9.0, mehtReqFt: 30, vrefKt: 138, family: '737 / A320 / 757' },
  'RGN':   { cls: 'RGN',   eyeWheel:  6.5, mehtReqFt: 25, vrefKt: 132, family: 'CRJ / E-Jet' },
  'BIZ':   { cls: 'BIZ',   eyeWheel:  6.0, mehtReqFt: 25, vrefKt: 118, family: 'GLF / FA7X / CL30' },
  'TBP':   { cls: 'TBP',   eyeWheel:  6.5, mehtReqFt: 25, vrefKt: 110, family: 'ATR / Q400' },
}

const FAMILY: Array<[RegExp, AcClass]> = [
  [/^(A38|A340|74[0-9]|74F|74M)/i, 'HVY-Q'],
  [/^(B77|B78|77[0-9]|78[0-9]|A33|A35|A30|A31)/i, 'HVY'],
  [/^(B73|B75|73[0-9]|75[0-9]|A31[89]|A32[0-9]|MAX)/i, 'NRW'],
  [/^(CRJ|E1[79][0-9]|E2[27][05]|ERJ)/i, 'RGN'],
  [/^(GLF|G[VI]|GLEX|G6[05]0|FA[57]X|CL[36]0|LJ[34567])/i, 'BIZ'],
  [/^(ATR|AT4|AT7|DH[CC]|DH8|Q40|SF34|J32)/i, 'TBP'],
]
function classify(t?: string): AcClass {
  const x = (t || '').toUpperCase().trim()
  for (const [re, c] of FAMILY) if (re.test(x)) return c
  return 'NRW'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
function hashFloat(s: string, salt: string) {
  return (hash32(s + ':' + salt) % 10000) / 10000
}
function haversineNm(la1: number, lo1: number, la2: number, lo2: number) {
  const R = 3440.065
  const dLat = (la2 - la1) * Math.PI / 180
  const dLon = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number) {
  const p1 = la1 * Math.PI / 180, p2 = la2 * Math.PI / 180
  const dLon = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dLon) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon)
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360
}
function destPoint(la: number, lo: number, brg: number, distNm: number): [number, number] {
  const R = 3440.065
  const b = brg * Math.PI / 180
  const lat1 = la * Math.PI / 180, lon1 = lo * Math.PI / 180
  const d = distNm / R
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b))
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2))
  return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI]
}
function angDiff(a: number, b: number) { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d }

function classifyPhase(altAgl: number, distNm: number, vel: number): Phase {
  if (altAgl < 50 && distNm < 0.5) return 'FLARE'
  if (altAgl < 500 && distNm < 2.5) return 'SHRT-FNL'
  if (altAgl < 3500 && distNm < 12) return 'APP'
  return 'OTHER'
}

function lightPatternFor(deviationDeg: number): LightPattern {
  // On 3° standard PAPI: total ~0.9° spread, each light transitions ~0.16°.
  // Below path = more red; above = more white.
  if (deviationDeg >= 0.45) return '4W'
  if (deviationDeg >= 0.15) return '3W1R'
  if (deviationDeg >= -0.15) return '2W2R'
  if (deviationDeg >= -0.45) return '1W3R'
  return '4R'
}

const PATTERN_COLOR: Record<LightPattern, string> = {
  '4W': '#0ea5e9', '3W1R': '#f59e0b', '2W2R': '#10b981', '1W3R': '#f59e0b', '4R': '#f43f5e',
}
const PATTERN_SCORE: Record<LightPattern, number> = { '4W': 35, '3W1R': 35, '2W2R': 0, '1W3R': 35, '4R': 100 }

const TIER_COLOR: Record<Tier, string> = {
  'ASIANA-214': '#f43f5e', 'UPS-1354': '#f59e0b', 'WATCH': '#0ea5e9', 'ON-SLOPE': '#10b981', 'IDLE': '#475569',
}
const TIER_BG: Record<Tier, string> = {
  'ASIANA-214': 'bg-rose-500/15 border-rose-500/40 text-rose-200',
  'UPS-1354':   'bg-amber-500/15 border-amber-500/40 text-amber-200',
  'WATCH':      'bg-sky-500/15 border-sky-500/40 text-sky-200',
  'ON-SLOPE':   'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
  'IDLE':       'bg-slate-800/40 border-slate-700/60 text-slate-400',
}
const PHASE_PILL: Record<Phase, string> = {
  'FLARE':    'bg-rose-500/15 border-rose-500/40 text-rose-200',
  'SHRT-FNL': 'bg-amber-500/15 border-amber-500/40 text-amber-200',
  'APP':      'bg-sky-500/15 border-sky-500/40 text-sky-200',
  'OTHER':    'bg-slate-800/40 border-slate-700/60 text-slate-500',
}
const VGSI_PILL: Record<VgsiType, string> = {
  'PAPI':    'bg-sky-500/15 border-sky-500/40 text-sky-200',
  'APAPI':   'bg-sky-500/15 border-sky-500/40 text-sky-200',
  'T-VASIS': 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
  'PVASI':   'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
}

interface Row {
  f: VFlight; cls: AcClass; spec: ClassSpec; phase: Phase
  rwy: VgsiSpec | null
  aglFt: number; distNm: number; alignDeg: number
  targetAltFt: number; deviationFt: number; deviationDeg: number
  pattern: LightPattern; mehtMargin: number; stable: boolean
  scoreVpd: number; scoreLit: number; scoreMet: number; scoreSta: number; scoreCwo: number
  score: number; tier: Tier; advice: string
}

function lsGet<T>(k: string, d: T): T { if (typeof window === 'undefined') return d; try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }
function lsSet(k: string, v: any) { if (typeof window === 'undefined') return; try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

export default function PapiVgsiMonitor({
  map, flights, onClose, onFly,
}: { map: maplibregl.Map | null; flights: VFlight[]; onClose: () => void; onFly: (icao: string) => void }) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'RUNWAYS' | 'INSTALLATIONS'>('AIRCRAFT')
  const [query, setQuery] = useState('')
  const [minFL, setMinFL] = useState<number>(() => lsGet('ft-papi-minfl', 0))
  const [angleBias, setAngleBias] = useState<number>(() => lsGet('ft-papi-anglebias', 0))
  const [vsNoise, setVsNoise] = useState<number>(() => lsGet('ft-papi-vsnoise', 100))
  const [mehtMul, setMehtMul] = useState<number>(() => lsGet('ft-papi-mehtmul', 100))
  const [staMul, setStaMul] = useState<number>(() => lsGet('ft-papi-stamul', 100))
  const [cwoMul, setCwoMul] = useState<number>(() => lsGet('ft-papi-cwomul', 100))
  const [phaseW, setPhaseW] = useState<number>(() => lsGet('ft-papi-phasew', 100))
  const [tierFilter, setTierFilter] = useState<Set<Tier>>(new Set())
  const [vgsiFilter, setVgsiFilter] = useState<Set<VgsiType>>(new Set())
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showBeam, setShowBeam] = useState(true)
  const [showRwy, setShowRwy] = useState(true)
  const [showRef, setShowRef] = useState(false)
  const [showDiag, setShowDiag] = useState(true)

  useEffect(() => { lsSet('ft-papi-minfl', minFL) }, [minFL])
  useEffect(() => { lsSet('ft-papi-anglebias', angleBias) }, [angleBias])
  useEffect(() => { lsSet('ft-papi-vsnoise', vsNoise) }, [vsNoise])
  useEffect(() => { lsSet('ft-papi-mehtmul', mehtMul) }, [mehtMul])
  useEffect(() => { lsSet('ft-papi-stamul', staMul) }, [staMul])
  useEffect(() => { lsSet('ft-papi-cwomul', cwoMul) }, [cwoMul])
  useEffect(() => { lsSet('ft-papi-phasew', phaseW) }, [phaseW])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const cls = classify(f.type)
      const spec = CLASSES[cls]
      const alt = f.altitudeFt ?? 0
      if (alt > 12000) continue
      // pick best aligned VGSI runway within 16 nm + track within 35° of QFU + within 30° of reciprocal-to-airport bearing
      let bestRwy: VgsiSpec | null = null
      let bestScore = -Infinity
      let bestDist = 0
      let bestAlign = 0
      for (const r of VGSI_CATALOGUE) {
        const d = haversineNm(f.lat, f.lng, r.thrLat, r.thrLng)
        if (d > 16) continue
        const brgToThr = bearingDeg(f.lat, f.lng, r.thrLat, r.thrLng)
        const finalApproachBrg = r.qfu // landing direction; approach goes toward QFU
        const align = angDiff(brgToThr, finalApproachBrg)
        if (align > 30) continue
        const trk = f.track ?? finalApproachBrg
        const trkDelta = angDiff(trk, finalApproachBrg)
        if (trkDelta > 35) continue
        // pick smallest distance with good alignment
        const s = -d - align * 0.1 - trkDelta * 0.05
        if (s > bestScore) { bestScore = s; bestRwy = r; bestDist = d; bestAlign = align }
      }
      if (!bestRwy) continue
      const aglFt = Math.max(0, alt - bestRwy.thrElevFt)
      const phase = classifyPhase(aglFt, bestDist, f.velocityKts ?? 0)
      if (phase === 'OTHER') continue
      const angle = Math.max(2.0, bestRwy.angleDeg + angleBias * 0.01)
      // target altitude on glide path at this slant range from threshold
      const slantFt = bestDist * 6076.115
      const targetAglFt = slantFt * Math.tan(angle * Math.PI / 180) + bestRwy.mehtFt
      const targetAltFt = targetAglFt + bestRwy.thrElevFt
      // hash-stable bias on actual position
      const hVs = (hashFloat(f.icao, 'vs') - 0.5) * 2 // -1..+1
      const noiseFt = hVs * 80 * (vsNoise / 100) * (phase === 'APP' ? 1.2 : 0.5)
      const actualAglFt = aglFt + noiseFt
      const deviationFt = actualAglFt - targetAglFt // +above / -below
      // deviation as deg from threshold POV
      const deviationDeg = Math.atan2(deviationFt, slantFt) * 180 / Math.PI
      const pattern = lightPatternFor(deviationDeg)
      // MEHT check at threshold crossing: project current path to threshold
      // wheel height over threshold = mehtFt + (current AGL relative to glide path at threshold zero range, extrapolated)
      const wheelAtThr = Math.max(-50, bestRwy.mehtFt + deviationFt * Math.max(0.2, 1 - bestDist / 3))
      const mehtMargin = wheelAtThr - spec.mehtReqFt
      // stability: speed within Vref±10, VS within ±200 of glide-path VS, deviation <100ft (AC 120-71B simplified)
      const vs = f.vertRate ?? 0
      const targetVs = -angle * (f.velocityKts ?? spec.vrefKt) * 101.3 / 60 // fpm
      const stableSpeed = Math.abs((f.velocityKts ?? spec.vrefKt) - spec.vrefKt) < 12
      const stableVs = Math.abs(vs - targetVs) < 250
      const stableDev = Math.abs(deviationFt) < 100
      const stable = stableSpeed && stableVs && stableDev
      // drivers
      const absDev = Math.abs(deviationFt)
      const scoreVpd = absDev <= 25 ? 0 : absDev <= 50 ? 25 : absDev <= 100 ? 55 : absDev <= 200 ? 80 : Math.min(100, 80 + (absDev - 200) / 5)
      const scoreLit = PATTERN_SCORE[pattern] + (pattern === '4R' && phase !== 'APP' ? 0 : 0)
      const scoreMet = mehtMargin >= 0 ? 0 : Math.min(100, -mehtMargin * 2) * (mehtMul / 100)
      const scoreSta = (stable ? 0 : (phase === 'SHRT-FNL' || phase === 'FLARE' ? 100 : 50)) * (staMul / 100)
      // visual obstacle: steep angle (>4°) with low energy or below path penalty
      const scoreCwo = (angle > 4 && deviationFt < -50 ? 70 : 0) * (cwoMul / 100)
      const drivers = [scoreVpd, scoreLit, scoreMet, scoreSta, scoreCwo]
      const maxDrv = Math.max(...drivers)
      const sec = drivers.reduce((a, b) => a + b, 0) - maxDrv
      const phaseMul = (phase === 'FLARE' ? 1.50 : phase === 'SHRT-FNL' ? 1.40 : phase === 'APP' ? 1.20 : 0.4) * (phaseW / 100)
      let score = Math.min(100, Math.max(0, maxDrv * phaseMul + 0.10 * sec / 5))
      // hard escalations
      if (pattern === '4R' && aglFt < 500 && mehtMargin < 0) score = Math.max(score, 92)
      if (deviationFt < -200 && phase === 'SHRT-FNL') score = Math.max(score, 88)
      if (!stable && aglFt < 500) score = Math.max(score, 80)
      let tier: Tier
      if (score >= 80) tier = 'ASIANA-214'
      else if (score >= 55) tier = 'UPS-1354'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'ON-SLOPE'
      const advice =
        tier === 'ASIANA-214' ? `GO-AROUND · ${pattern} PAPI on RWY ${bestRwy.rwId} · wheels ${mehtMargin.toFixed(0)} ft of MEHT ${spec.mehtReqFt} ft cert per FCOM AOM 5.7 / AAR-14-01` :
        tier === 'UPS-1354' ? `Push up · ${deviationFt < 0 ? 'below' : 'above'} ${angle.toFixed(1)}° path by ${Math.abs(deviationFt).toFixed(0)} ft · correct to 2R-2W per AC 120-71B / AAR-15-02` :
        tier === 'WATCH' ? `Monitor PAPI bar trend · cross-check VNAV ${angle.toFixed(1)}° path · ${stable ? 'stable' : 'consolidating'}` :
        `2R-2W on ${angle.toFixed(1)}° PAPI · MEHT ${mehtMargin.toFixed(0)} ft margin · stable per AC 120-71B`
      out.push({
        f, cls, spec, phase, rwy: bestRwy, aglFt, distNm: bestDist, alignDeg: bestAlign,
        targetAltFt, deviationFt, deviationDeg, pattern, mehtMargin, stable,
        scoreVpd, scoreLit, scoreMet, scoreSta, scoreCwo, score, tier, advice,
      })
    }
    // FL filter
    return out.filter(r => (r.f.altitudeFt ?? 0) >= minFL * 100)
  }, [flights, minFL, angleBias, vsNoise, mehtMul, staMul, cwoMul, phaseW])

  const ranked = useMemo(() => {
    const q = query.trim().toLowerCase()
    let r = rows
    if (q) r = r.filter(x => (x.f.callsign || '').toLowerCase().includes(q) || (x.f.type || '').toLowerCase().includes(q) || (x.f.icao).toLowerCase().includes(q) || (x.rwy?.icao || '').toLowerCase().includes(q))
    if (tierFilter.size) r = r.filter(x => tierFilter.has(x.tier))
    if (vgsiFilter.size) r = r.filter(x => x.rwy && vgsiFilter.has(x.rwy.type))
    const order: Tier[] = ['ASIANA-214', 'UPS-1354', 'WATCH', 'ON-SLOPE']
    return [...r].sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier) || b.score - a.score)
  }, [rows, query, tierFilter, vgsiFilter])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { 'ASIANA-214': 0, 'UPS-1354': 0, 'WATCH': 0, 'ON-SLOPE': 0, 'IDLE': 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const summary = useMemo(() => {
    const n = rows.length || 1
    const meanDev = rows.reduce((a, r) => a + Math.abs(r.deviationFt), 0) / n
    const worst = [...rows].sort((a, b) => b.score - a.score)[0]
    const asianaCt = rows.filter(r => r.tier === 'ASIANA-214').length
    const fourRedShare = rows.filter(r => r.pattern === '4R').length / n
    const unstableShare = rows.filter(r => !r.stable).length / n
    const mehtBreach = rows.filter(r => r.mehtMargin < 0).length
    return { meanDev, worst, asianaCt, fourRedShare, unstableShare, mehtBreach }
  }, [rows])

  const byRwy = useMemo(() => {
    const m = new Map<string, { spec: VgsiSpec; rows: Row[] }>()
    for (const r of rows) if (r.rwy) {
      const k = `${r.rwy.icao}/${r.rwy.rwId}`
      if (!m.has(k)) m.set(k, { spec: r.rwy, rows: [] })
      m.get(k)!.rows.push(r)
    }
    return [...m.entries()].map(([k, v]) => {
      const worstTier: Tier = v.rows.reduce((acc, r) => {
        const o: Tier[] = ['ASIANA-214', 'UPS-1354', 'WATCH', 'ON-SLOPE']
        return o.indexOf(r.tier) < o.indexOf(acc) ? r.tier : acc
      }, 'ON-SLOPE' as Tier)
      const meanScore = v.rows.reduce((a, r) => a + r.score, 0) / v.rows.length
      const meanDev = v.rows.reduce((a, r) => a + Math.abs(r.deviationFt), 0) / v.rows.length
      return { k, spec: v.spec, n: v.rows.length, worstTier, meanScore, meanDev }
    }).sort((a, b) => b.meanScore - a.meanScore)
  }, [rows])

  // map overlay
  useEffect(() => {
    if (!map) return
    const ids = ['papi-halo', 'papi-pin', 'papi-lbl', 'papi-beam', 'papi-rwy', 'papi-rwy-lbl', 'papi-ref']
    const featHalo: any[] = []
    const featPin: any[] = []
    const featLbl: any[] = []
    const featBeam: any[] = []
    const featRwy: any[] = []
    const featRwyLbl: any[] = []
    for (const r of rows) {
      const col = TIER_COLOR[r.tier]
      const sz = 8 + (r.score / 100) * 14
      if (showHalo) featHalo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { c: col, s: sz } })
      if (showPin && r.tier === 'ASIANA-214') featPin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      if (showLbl && r.tier !== 'ON-SLOPE') {
        featLbl.push({
          type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: { t: `${(r.f.callsign || r.f.icao).trim()} · ${r.pattern} · ${r.deviationFt >= 0 ? '+' : ''}${r.deviationFt.toFixed(0)}ft`, c: col },
        })
      }
      if (showBeam && r.rwy) {
        // beam projection: extended centreline from threshold backward 5 nm, coloured by current pattern
        const back = bearingDeg(r.rwy.thrLat, r.rwy.thrLng, r.f.lat, r.f.lng)
        const seg: [number, number][] = []
        for (let i = 0; i <= 12; i++) {
          const d = (i / 12) * 5
          seg.push(destPoint(r.rwy.thrLat, r.rwy.thrLng, back, d))
        }
        featBeam.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: seg },
          properties: { c: PATTERN_COLOR[r.pattern] },
        })
      }
    }
    if (showRwy) {
      for (const s of VGSI_CATALOGUE) {
        featRwy.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.thrLng, s.thrLat] },
          properties: { c: s.angleDeg >= 5 ? '#f59e0b' : s.angleDeg >= 3.3 ? '#0ea5e9' : '#10b981', sz: 4 + Math.min(5, s.angleDeg - 2.5) },
        })
        featRwyLbl.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.thrLng, s.thrLat] },
          properties: { t: `${s.icao}/${s.rwId} ${s.angleDeg.toFixed(1)}°` },
        })
      }
    }
    const refFeat: any[] = []
    if (showRef) {
      for (const lat of [-60, -30, 0, 30, 60]) {
        for (let lng = -180; lng < 180; lng += 12) {
          refFeat.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} })
        }
      }
    }
    const sources: Record<string, any> = {
      'papi-halo': { type: 'geojson', data: { type: 'FeatureCollection', features: featHalo } },
      'papi-pin':  { type: 'geojson', data: { type: 'FeatureCollection', features: featPin } },
      'papi-lbl':  { type: 'geojson', data: { type: 'FeatureCollection', features: featLbl } },
      'papi-beam': { type: 'geojson', data: { type: 'FeatureCollection', features: featBeam } },
      'papi-rwy':  { type: 'geojson', data: { type: 'FeatureCollection', features: featRwy } },
      'papi-rwy-lbl': { type: 'geojson', data: { type: 'FeatureCollection', features: featRwyLbl } },
      'papi-ref':  { type: 'geojson', data: { type: 'FeatureCollection', features: refFeat } },
    }
    for (const [id, src] of Object.entries(sources)) {
      const existing = map.getSource(id) as any
      if (existing) existing.setData(src.data)
      else map.addSource(id, src)
    }
    const layers: any[] = [
      { id: 'papi-halo', type: 'circle', source: 'papi-halo', paint: { 'circle-radius': ['get', 's'], 'circle-color': ['get', 'c'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'c'], 'circle-stroke-opacity': 0.55, 'circle-stroke-width': 1 } },
      { id: 'papi-beam', type: 'line', source: 'papi-beam', paint: { 'line-color': ['get', 'c'], 'line-width': 1.4, 'line-opacity': 0.7, 'line-dasharray': [2, 2] } },
      { id: 'papi-rwy', type: 'circle', source: 'papi-rwy', paint: { 'circle-radius': ['get', 'sz'], 'circle-color': ['get', 'c'], 'circle-opacity': 0.55, 'circle-stroke-color': '#0f172a', 'circle-stroke-width': 0.6 } },
      { id: 'papi-rwy-lbl', type: 'symbol', source: 'papi-rwy-lbl', layout: { 'text-field': ['get', 't'], 'text-size': 8, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-allow-overlap': false }, paint: { 'text-color': '#cbd5e1', 'text-halo-color': '#020617', 'text-halo-width': 1 } },
      { id: 'papi-pin', type: 'symbol', source: 'papi-pin', layout: { 'text-field': '◆', 'text-size': 12, 'text-allow-overlap': true }, paint: { 'text-color': '#f43f5e', 'text-halo-color': '#020617', 'text-halo-width': 1 } },
      { id: 'papi-lbl', type: 'symbol', source: 'papi-lbl', layout: { 'text-field': ['get', 't'], 'text-size': 9, 'text-offset': [0, -1.6], 'text-anchor': 'bottom', 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } },
      { id: 'papi-ref', type: 'circle', source: 'papi-ref', paint: { 'circle-radius': 1, 'circle-color': '#0ea5e9', 'circle-opacity': 0.25 } },
    ]
    for (const l of layers) { if (!map.getLayer(l.id)) try { map.addLayer(l) } catch {} }
    return () => {
      for (const id of [...layers.map(l => l.id)]) { if (map.getLayer(id)) try { map.removeLayer(id) } catch {} }
      for (const id of ids) { if (map.getSource(id)) try { map.removeSource(id) } catch {} }
    }
  }, [map, rows, showHalo, showPin, showLbl, showBeam, showRwy, showRef])

  const toggleTier = (t: Tier) => setTierFilter(s => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n })
  const toggleVgsi = (v: VgsiType) => setVgsiFilter(s => { const n = new Set(s); n.has(v) ? n.delete(v) : n.add(v); return n })

  // scatter dots: deviation ft vs distance nm
  const scatterDots = useMemo(() => rows.map(r => {
    // deviation x-axis: -300..+300 ft → 10..228
    const x = 10 + Math.max(0, Math.min(218, ((r.deviationFt + 300) / 600) * 218))
    // distance y-axis: 0..10 nm → 130..20
    const y = 130 - Math.max(0, Math.min(110, (r.distNm / 10) * 110))
    return { cx: x, cy: y, color: TIER_COLOR[r.tier] }
  }), [rows])

  return (
    <div className="fixed top-16 right-3 z-30 w-[420px] max-h-[calc(100vh-5rem)] flex flex-col bg-slate-950/95 border border-slate-800 rounded-lg shadow-2xl backdrop-blur text-slate-100">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex flex-col">
          <div className="text-[11px] font-semibold tracking-wider text-slate-100">PAPI · VGSI</div>
          <div className="text-[9px] text-slate-500 uppercase tracking-wider">visual glide-slope deviation · MEHT</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm px-2">✕</button>
      </div>

      {/* tier counters */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800 text-[10px]">
        {(['ASIANA-214', 'UPS-1354', 'WATCH', 'ON-SLOPE', 'IDLE'] as Tier[]).map(t => (
          <button
            key={t}
            onClick={() => toggleTier(t)}
            className={`flex flex-col items-center rounded border px-1 py-1 transition ${tierFilter.has(t) ? TIER_BG[t] : 'border-slate-800 bg-slate-900/40 text-slate-500'}`}
          >
            <span className="text-[8px] uppercase tracking-wider">{t}</span>
            <span className="font-mono text-[11px]">{tierCounts[t]}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-[10px]">
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">Mean |Δ|</div>
          <div className={`font-mono ${summary.meanDev > 100 ? 'text-amber-300' : 'text-slate-200'}`}>{summary.meanDev.toFixed(0)}ft</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">Worst</div>
          <div className="font-mono text-slate-200 truncate">{summary.worst?.f.callsign?.trim() || summary.worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">Asiana-tier</div>
          <div className="font-mono text-rose-300">{summary.asianaCt}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">4-Red share</div>
          <div className="font-mono text-rose-300">{(summary.fourRedShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">Unstable</div>
          <div className="font-mono text-amber-300">{(summary.unstableShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 p-1.5">
          <div className="text-slate-500 text-[9px] uppercase tracking-wider">MEHT brch</div>
          <div className="font-mono text-rose-300">{summary.mehtBreach}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1">deviation ft (×) vs distance nm (y)</div>
          <svg viewBox="0 0 240 140" className="w-full h-[110px] block">
            {/* on-slope emerald band ±25 ft */}
            <rect x={10 + (275 / 600) * 218} y={20} width={(50 / 600) * 218} height={110} fill="#10b981" fillOpacity="0.10" />
            {/* watch sky bands ±25..±100 */}
            <rect x={10 + (200 / 600) * 218} y={20} width={(75 / 600) * 218} height={110} fill="#0ea5e9" fillOpacity="0.06" />
            <rect x={10 + (325 / 600) * 218} y={20} width={(75 / 600) * 218} height={110} fill="#0ea5e9" fillOpacity="0.06" />
            {/* rose breach */}
            <rect x={10} y={20} width={(100 / 600) * 218} height={110} fill="#f43f5e" fillOpacity="0.06" />
            <rect x={10 + (500 / 600) * 218} y={20} width={(100 / 600) * 218} height={110} fill="#f43f5e" fillOpacity="0.06" />
            {/* axes */}
            <line x1="10" y1="130" x2="228" y2="130" stroke="#334155" strokeWidth="0.5" />
            <line x1={10 + 109} y1="20" x2={10 + 109} y2="130" stroke="#334155" strokeWidth="0.4" strokeDasharray="2 2" />
            <text x="12" y="28" fontSize="7" fill="#f43f5e">below path</text>
            <text x="228" y="28" textAnchor="end" fontSize="7" fill="#f43f5e">above path</text>
            <text x={10 + 113} y="138" fontSize="7" fill="#10b981">target</text>
            <text x="14" y="138" fontSize="7" fill="#64748b">-300ft</text>
            <text x="222" y="138" textAnchor="end" fontSize="7" fill="#64748b">+300ft</text>
            {scatterDots.map((d, i) => (
              <circle key={i} cx={d.cx} cy={d.cy} r="2" fill={d.color} opacity="0.75" />
            ))}
          </svg>
        </div>
      )}

      {/* sliders */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 py-2 border-b border-slate-800 text-[10px]">
        {([
          ['MIN-FL', minFL, setMinFL, 0, 400, 10],
          ['ANG-BIAS pct', angleBias, setAngleBias, -30, 30, 1],
          ['VS-NOISE %', vsNoise, setVsNoise, 0, 250, 5],
          ['MEHT-MUL %', mehtMul, setMehtMul, 50, 200, 5],
          ['STA-MUL %', staMul, setStaMul, 50, 200, 5],
          ['CWO-MUL %', cwoMul, setCwoMul, 50, 200, 5],
          ['PHASE-WT %', phaseW, setPhaseW, 50, 150, 5],
        ] as Array<[string, number, (v: number) => void, number, number, number]>).map(([lbl, v, set, mn, mx, st]) => (
          <label key={lbl} className="flex items-center gap-1.5">
            <span className="text-slate-500 w-20 shrink-0">{lbl}</span>
            <input type="range" min={mn} max={mx} step={st} value={v} onChange={e => set(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
            <span className="text-slate-300 font-mono w-9 text-right">{v}</span>
          </label>
        ))}
      </div>

      {/* vgsi-type chip filter */}
      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {(['PAPI', 'APAPI', 'T-VASIS', 'PVASI'] as VgsiType[]).map(k => (
          <button key={k} onClick={() => toggleVgsi(k)} className={`px-2 py-0.5 rounded border text-[10px] font-semibold tracking-wide transition ${vgsiFilter.has(k) ? VGSI_PILL[k] : 'bg-slate-900/40 border-slate-800 text-slate-600'}`}>{k}</button>
        ))}
      </div>

      {/* overlay toggles */}
      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-slate-800">
        {([
          ['HALO', showHalo, setShowHalo],
          ['PIN', showPin, setShowPin],
          ['LBL', showLbl, setShowLbl],
          ['BEAM', showBeam, setShowBeam],
          ['RWY', showRwy, setShowRwy],
          ['REF', showRef, setShowRef],
          ['DIAG', showDiag, setShowDiag],
        ] as Array<[string, boolean, (v: boolean) => void]>).map(([lbl, on, set]) => (
          <button key={lbl} onClick={() => set(!on)} className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold tracking-wide transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/40 border-slate-800 text-slate-500'}`}>{lbl}</button>
        ))}
      </div>

      <div className="px-3 py-2 border-b border-slate-800">
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / icao / rwy" className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50" />
      </div>
      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'RUNWAYS', 'INSTALLATIONS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold tracking-wider transition ${tab === t ? 'text-sky-300 border-b border-sky-500/60 bg-sky-500/5' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto text-[11px]">
        {tab === 'AIRCRAFT' && ranked.map(r => (
          <button key={r.f.icao} onClick={() => onFly(r.f.icao)} className="w-full text-left px-3 py-2 border-b border-slate-900/80 hover:bg-slate-900/60 transition flex flex-col gap-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="w-1 h-4 rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <span className="font-semibold text-slate-100">{r.f.callsign?.trim() || r.f.icao}</span>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-slate-800/60 border-slate-700 text-slate-300">{r.cls}</span>
              <span className={`px-1 py-0.5 rounded border text-[9px] font-semibold ${PHASE_PILL[r.phase]}`}>{r.phase}</span>
              <span className="px-1 py-0.5 rounded border text-[9px] font-semibold" style={{ color: PATTERN_COLOR[r.pattern], borderColor: PATTERN_COLOR[r.pattern] + '60', background: PATTERN_COLOR[r.pattern] + '15' }}>{r.pattern}</span>
              {!r.stable && <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-amber-500/15 border-amber-500/40 text-amber-200">UNST</span>}
              <span className={`ml-auto px-1 py-0.5 rounded border text-[9px] font-semibold ${TIER_BG[r.tier]}`}>{r.tier}</span>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono flex-wrap">
              <span className="text-sky-300">{r.rwy ? `${r.rwy.icao}/${r.rwy.rwId}` : '—'}</span>
              <span>{r.rwy?.angleDeg.toFixed(1)}°</span>
              <span>{(r.f.altitudeFt ?? 0).toFixed(0)}ft</span>
              <span>AGL {r.aglFt.toFixed(0)}</span>
              <span>{r.distNm.toFixed(1)}nm</span>
              <span className={r.deviationFt < -100 ? 'text-rose-300' : Math.abs(r.deviationFt) > 50 ? 'text-amber-300' : 'text-emerald-300'}>
                Δ{r.deviationFt >= 0 ? '+' : ''}{r.deviationFt.toFixed(0)}ft
              </span>
              <span className={r.mehtMargin < 0 ? 'text-rose-300' : 'text-slate-400'}>MEHT {r.mehtMargin >= 0 ? '+' : ''}{r.mehtMargin.toFixed(0)}ft</span>
            </div>
            <div className="h-1 rounded bg-slate-800 overflow-hidden">
              <div className="h-full" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }} />
            </div>
            <div className="grid grid-cols-5 gap-0.5 text-[8px]">
              {([
                ['VPD', r.scoreVpd], ['LIT', r.scoreLit], ['MET', r.scoreMet], ['STA', r.scoreSta], ['CWO', r.scoreCwo],
              ] as Array<[string, number]>).map(([n, s]) => {
                const t: Tier = s >= 80 ? 'ASIANA-214' : s >= 55 ? 'UPS-1354' : s >= 25 ? 'WATCH' : 'ON-SLOPE'
                return (
                  <div key={n} className={`text-center rounded border ${TIER_BG[t]} px-0.5 py-0.5 font-mono`}>
                    <div className="opacity-70">{n}</div>
                    <div>{s.toFixed(0)}</div>
                  </div>
                )
              })}
            </div>
            {/* mini PAPI bar visualisation */}
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-slate-500 w-10">PAPI</span>
              <div className="flex gap-0.5">
                {(() => {
                  const map4: Record<LightPattern, string[]> = {
                    '4W': ['#0ea5e9', '#0ea5e9', '#0ea5e9', '#0ea5e9'],
                    '3W1R': ['#0ea5e9', '#0ea5e9', '#0ea5e9', '#f43f5e'],
                    '2W2R': ['#0ea5e9', '#0ea5e9', '#f43f5e', '#f43f5e'],
                    '1W3R': ['#0ea5e9', '#f43f5e', '#f43f5e', '#f43f5e'],
                    '4R': ['#f43f5e', '#f43f5e', '#f43f5e', '#f43f5e'],
                  }
                  return map4[r.pattern].map((c, i) => (
                    <span key={i} className="w-3 h-2 rounded-sm" style={{ background: c, boxShadow: `0 0 4px ${c}` }} />
                  ))
                })()}
              </div>
              <span className="text-[9px] text-slate-500 ml-1">{r.rwy?.type}</span>
            </div>
            <div className="text-[9px] text-slate-400 leading-snug">{r.advice}</div>
          </button>
        ))}

        {tab === 'RUNWAYS' && byRwy.map(r => (
          <div key={r.k} className="px-3 py-2 border-b border-slate-900/80 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="w-1 h-4 rounded" style={{ background: TIER_COLOR[r.worstTier] }} />
              <span className="font-semibold text-slate-100 font-mono">{r.spec.icao}/{r.spec.rwId}</span>
              <span className="text-slate-500 text-[10px]">{r.spec.name}</span>
              <span className={`px-1 py-0.5 rounded border text-[9px] font-semibold ${VGSI_PILL[r.spec.type]}`}>{r.spec.type}</span>
              <span className="px-1 py-0.5 rounded border text-[9px] font-semibold bg-slate-800/60 border-slate-700 text-slate-300">{r.spec.angleDeg.toFixed(1)}°</span>
              <span className="ml-auto text-slate-500 text-[10px] font-mono">{r.n} a/c</span>
            </div>
            <div className="text-[9px] text-slate-500 font-mono">MEHT {r.spec.mehtFt}ft · QFU {r.spec.qfu.toString().padStart(3, '0')} · mean |Δ| {r.meanDev.toFixed(0)}ft</div>
            <div className="h-1 rounded bg-slate-800 overflow-hidden">
              <div className="h-full" style={{ width: `${r.meanScore}%`, background: TIER_COLOR[r.worstTier] }} />
            </div>
            <div className="text-[9px] text-slate-400 leading-snug">{r.spec.notes}</div>
          </div>
        ))}

        {tab === 'INSTALLATIONS' && (() => {
          const grouped = new Map<VgsiType, VgsiSpec[]>()
          for (const s of VGSI_CATALOGUE) {
            if (!grouped.has(s.type)) grouped.set(s.type, [])
            grouped.get(s.type)!.push(s)
          }
          return [...grouped.entries()].map(([k, list]) => (
            <div key={k} className="px-3 py-2 border-b border-slate-900/80">
              <div className="flex items-center gap-1.5 mb-1">
                <span className={`px-1 py-0.5 rounded border text-[9px] font-semibold ${VGSI_PILL[k]}`}>{k}</span>
                <span className="text-[10px] text-slate-400">{list.length} installations</span>
              </div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] font-mono text-slate-400">
                {list.map(s => (
                  <div key={s.icao + s.rwId} className="flex gap-1 items-center">
                    <span className="text-slate-300">{s.icao}/{s.rwId}</span>
                    <span className="text-sky-300">{s.angleDeg.toFixed(1)}°</span>
                    <span className="text-slate-500">MEHT {s.mehtFt}</span>
                  </div>
                ))}
              </div>
            </div>
          ))
        })()}

        {((tab === 'AIRCRAFT' && ranked.length === 0) || (tab === 'RUNWAYS' && byRwy.length === 0)) && (
          <div className="px-3 py-8 text-center text-[11px] text-slate-500">
            no arrivals in PAPI scope · widen MIN-FL or wait for inbound traffic on final
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 font-mono leading-tight">
        Annex 14 §5.3.5 PAPI · AC 150/5345-28G · AC 120-71B stable · post-AAR-14-01 Asiana 214 · post-AAR-15-02 UPS 1354
      </div>
    </div>
  )
}
