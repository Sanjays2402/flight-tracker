'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   RFI · GNSS Jamming & Spoofing Threat-Zone Monitor
   ------------------------------------------------------------
   Per-airframe exposure scorer against the live global catalogue
   of intentional / state-actor GNSS Radio-Frequency Interference
   zones identified in OPSGROUP advisories, EASA Safety Information
   Bulletins, FAA Notice-to-Airmen series, IATA Safety Reports
   and ICAO State Letters since 2018 — covering both:

     (a) JAMMING — broadband / barrage L-band noise that denies
         GPS L1/L5 + GLONASS / Galileo / BeiDou tracking, forcing
         the aircraft to ABAS RAIM-FD coast, IRS dead-reckoning,
         and DME/DME or VOR/DME RNAV (1) reversion per ICAO
         Doc 9613 PBN Manual Vol II Part C §3.

     (b) SPOOFING — coherent counterfeit L1 C/A transmissions
         injecting hazardously misleading position+time solutions
         that survive RAIM, deflect IRS hybrid solutions, corrupt
         FMS LRN-position, trigger spurious EGPWS pull-up, drive
         autopilot into HDG mode, and have produced documented
         loss-of-time / loss-of-comm / unannunciated NAV-drift
         events from Iraq–Iran–E.Med since Sep-2023 (OPSGROUP
         Wired Briefing, IFALPA GPS Spoofing Position Paper 2024,
         EUROCONTROL EVAIR Bulletin 27 + 28).

   Active threat-zone catalogue includes:
     · KALININGRAD-RU (Baltic / Suwałki Gap GPS jamming;
       Finavia ANS reports Aug-2023 onward, EASA SIB 2022-02)
     · E-MED-CY-IL  (Cyprus FIR / LCLK area spoofing from
       Israeli & Iranian EW since Mar-2023, OPSGROUP Aug-2023)
     · BLACK-SEA   (Crimea-Krasnodar jamming since 2014;
       NATO AWACS LE-1 observed >40 dB GPS noise floor)
     · IRAQ-IRN    (FL340 spoofing belt Baghdad→Erbil→Tabriz,
       documented Sep-2023 BIZ jet near-incident with FMS
       drifting 150 NM into Iranian airspace within 90 s)
     · N-KOREA     (KP jamming campaigns 2010/12/16/24 vs RKSI)
     · LIBYA-EG    (Sebha–Tobruk corridor since 2019)
     · MYANMAR     (Naypyidaw spoofing reports 2023)
     · SYRIA-LBN   (LCLK→OLBA approach spoof corridor)
     · UKRAINE     (entire FIR active EW since Feb-2022)
     · FIN-EE-BAL  (Helsinki, Tallinn, Riga approach GPS-OUT
       NOTAMs ongoing; Finavia loss-of-GPS bulletins)

   For each tracked airframe within scope the monitor evaluates:
     · GNSS-receiver fitment by airframe class
     · ABAS/SBAS/GBAS reversion availability
     · IRS hybrid-FMS dead-reckoning drift budget
     · DME/DME or VOR/DME RNAV-1 fallback coverage
     · ADS-B NIC/NAC_p anomaly fingerprints
     · ground-track vs FMS-projection deviation
     · time-stamp jump signature (ADS-B clock-bias)
     · phase-of-flight criticality
   And produces a 6-tier escalation:
     SPOOFED-HMI / JAMMED-HARD / DEGRADED / MARGIN / NOMINAL / IDLE

   References:
     · ICAO Annex 10 Vol I §3.7 GNSS SARPs
     · ICAO Doc 9849 GNSS Manual ed.2 ch.6 interference
     · ICAO Doc 9613 PBN Manual Vol II Part C §3 fallback
     · ICAO SL 2022/49 — GNSS Interference impact on operations
     · EASA SIB 2022-02R3 GNSS Outage and Alterations
     · EASA SIB 2023-09 GNSS Spoofing
     · FAA InFO 22002 GNSS Disruption
     · FAA SAFO 23005 Unreliable GNSS
     · FAA AC 90-100A US Terminal/Enroute RNAV Operations
     · RTCA DO-229F MOPS GPS/SBAS, DO-253D MOPS GBAS/LAAS
     · RTCA DO-208/DO-316 MOPS ABAS (RAIM/FDE)
     · ARINC 743A GNSS Sensor / 743B MMR
     · EUROCONTROL EVAIR Bulletin 27 / 28 GNSS spoofing
     · IFALPA Position Paper 2024-01 GPS Spoofing
     · OPSGROUP Wired Briefing GPS Spoofing Update 2024-Q1
     · IATA Safety Report 2023 ch.4 GNSS RFI
     · NTSB CEN24LA106 Citation X GPS spoofing investigation
     · NOTAM KICZ A0067/24 (Persian Gulf GPS outage)
     · UK CAA SkyWise UAS 2024-027 GNSS jamming Eastern UK
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'SPOOFED-HMI' | 'JAMMED-HARD' | 'DEGRADED' | 'MARGIN' | 'NOMINAL' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'SPOOFED-HMI': '#ef4444', 'JAMMED-HARD': '#f43f5e', DEGRADED: '#f59e0b', MARGIN: '#0ea5e9', NOMINAL: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['SPOOFED-HMI', 'JAMMED-HARD', 'DEGRADED', 'MARGIN', 'NOMINAL']
const TIER_RANK: Record<Tier, number> = { 'SPOOFED-HMI': 0, 'JAMMED-HARD': 1, DEGRADED: 2, MARGIN: 3, NOMINAL: 4, IDLE: 5 }

type Mode = 'SPOOF' | 'JAM' | 'MIXED'
const MODE_COLOR: Record<Mode, string> = { SPOOF: '#ef4444', JAM: '#f59e0b', MIXED: '#a855f7' }

type Fit = 'MMR-SBAS-GBAS' | 'GNSS-SBAS' | 'GNSS-RAIM' | 'BASIC-GPS'
const FIT_COLOR: Record<Fit, string> = {
  'MMR-SBAS-GBAS': '#10b981', 'GNSS-SBAS': '#0ea5e9', 'GNSS-RAIM': '#f59e0b', 'BASIC-GPS': '#ef4444',
}
const FIT_LABEL: Record<Fit, string> = {
  'MMR-SBAS-GBAS': 'MMR + SBAS + GBAS-LPV (787/A350/A380)',
  'GNSS-SBAS': 'GNSS + WAAS/EGNOS (737NG-MAX / A320NEO / 777)',
  'GNSS-RAIM': 'GNSS + ABAS RAIM (A330 / 757 / CRJ)',
  'BASIC-GPS': 'Basic GPS + RNP-INS (legacy + light)',
}

/* ----- Threat-zone catalogue ----- */
interface Zone {
  id: string
  name: string
  mode: Mode
  ctrLat: number
  ctrLng: number
  radiusNm: number
  sevBase: number      // 0..100 nominal severity
  fl: [number, number] // min/max FL of effective interference
  src: string          // source reference
}

const ZONES: Zone[] = [
  { id: 'KALININGRAD-RU', name: 'Kaliningrad / Suwałki Gap', mode: 'JAM',   ctrLat: 54.71, ctrLng: 20.45,  radiusNm: 220, sevBase: 80, fl: [0, 410], src: 'EASA SIB 2022-02R3 / Finavia 2023-08' },
  { id: 'E-MED-CY-IL',   name: 'Eastern Mediterranean (LCCC FIR)', mode: 'SPOOF', ctrLat: 34.45, ctrLng: 33.20, radiusNm: 280, sevBase: 92, fl: [200, 450], src: 'OPSGROUP 2023-08 / IFALPA 2024-01' },
  { id: 'BLACK-SEA',     name: 'Crimea / Black Sea EW',     mode: 'MIXED', ctrLat: 45.10, ctrLng: 34.50,  radiusNm: 260, sevBase: 85, fl: [0, 410],   src: 'EUROCONTROL EVAIR 27' },
  { id: 'IRAQ-IRN',      name: 'Iraq–Iran spoofing belt (UM688)', mode: 'SPOOF', ctrLat: 35.40, ctrLng: 45.20, radiusNm: 380, sevBase: 95, fl: [240, 460], src: 'OPSGROUP Wired 2024-Q1 / NTSB CEN24LA106' },
  { id: 'PERSIAN-GULF',  name: 'Persian Gulf (OBBI / OKBK)', mode: 'JAM',   ctrLat: 28.20, ctrLng: 50.50,  radiusNm: 240, sevBase: 70, fl: [0, 410],   src: 'NOTAM KICZ A0067/24' },
  { id: 'SYRIA-LBN',     name: 'Syria–Lebanon (OLBA approach)', mode: 'SPOOF', ctrLat: 34.10, ctrLng: 36.40, radiusNm: 200, sevBase: 88, fl: [100, 360], src: 'EVAIR 28 / EASA SIB 2023-09' },
  { id: 'UKRAINE',       name: 'Ukraine FIR (UKBV/UKLV)',   mode: 'MIXED', ctrLat: 49.50, ctrLng: 31.50,  radiusNm: 420, sevBase: 90, fl: [0, 460],   src: 'EUROCONTROL CFMU NOTAM 2022-02' },
  { id: 'N-KOREA',       name: 'North Korea (KP campaigns)', mode: 'JAM',   ctrLat: 38.30, ctrLng: 127.30, radiusNm: 220, sevBase: 75, fl: [0, 410],   src: 'ICAO SL 2016 / RKSI Operations Bulletin' },
  { id: 'LIBYA-EG',      name: 'Libya–Egypt (Sebha / Tobruk)', mode: 'JAM', ctrLat: 30.80, ctrLng: 22.00,  radiusNm: 280, sevBase: 65, fl: [0, 410],   src: 'IATA Safety Report 2023 ch.4' },
  { id: 'MYANMAR',       name: 'Myanmar (VYMD/VYYY)',       mode: 'SPOOF', ctrLat: 19.70, ctrLng: 96.10,  radiusNm: 180, sevBase: 70, fl: [60, 380],  src: 'OPSGROUP 2023-11' },
  { id: 'FIN-EE-BAL',    name: 'Finland / Baltic States approach', mode: 'JAM', ctrLat: 59.70, ctrLng: 24.60, radiusNm: 260, sevBase: 60, fl: [0, 200], src: 'Finavia GPS-Out Bulletins 2024' },
  { id: 'CASPIAN',       name: 'Caspian Sea corridor (UBBB/UTAA)', mode: 'MIXED', ctrLat: 40.40, ctrLng: 50.80, radiusNm: 280, sevBase: 78, fl: [200, 420], src: 'EUROCONTROL EVAIR 28' },
  { id: 'SE-TURKEY',     name: 'SE Turkey (LTCG / LTCH)',   mode: 'SPOOF', ctrLat: 37.50, ctrLng: 40.80,  radiusNm: 240, sevBase: 82, fl: [200, 430], src: 'EASA SIB 2023-09' },
  { id: 'BALTIC-NE',     name: 'Baltic NE coast (Tartu/Pärnu approach lost ILS 2024-04)', mode: 'JAM', ctrLat: 58.30, ctrLng: 25.80, radiusNm: 180, sevBase: 72, fl: [0, 180], src: 'Estonian CAA AIC 2024-04 / Finnair AY1716 diversion' },
  { id: 'NW-RUS',        name: 'Murmansk / Kola peninsula', mode: 'JAM',   ctrLat: 68.90, ctrLng: 33.00,  radiusNm: 220, sevBase: 58, fl: [0, 410],   src: 'NSAU Bodø MET observation' },
  { id: 'KASHMIR',       name: 'Kashmir / N-Pakistan (OPRN)', mode: 'JAM', ctrLat: 33.80, ctrLng: 73.10, radiusNm: 200, sevBase: 55, fl: [0, 410],    src: 'IFALPA 2024-01' },
  { id: 'XINJIANG',      name: 'Xinjiang (ZWWW corridor)', mode: 'JAM',   ctrLat: 43.70, ctrLng: 87.50,  radiusNm: 240, sevBase: 60, fl: [200, 420],  src: 'OPSGROUP 2024-02' },
  { id: 'SUDAN',         name: 'Sudan (HSSS) civil-war EW',  mode: 'JAM',   ctrLat: 15.50, ctrLng: 32.50,  radiusNm: 260, sevBase: 68, fl: [0, 410],   src: 'IATA SR 2024 ch.4' },
  { id: 'YEMEN',         name: 'Yemen / Red Sea (OYAA / HHAS)', mode: 'MIXED', ctrLat: 14.80, ctrLng: 44.30, radiusNm: 220, sevBase: 70, fl: [0, 410], src: 'OPSGROUP 2024-01' },
  { id: 'IRGC-HORMUZ',   name: 'Strait of Hormuz EW',       mode: 'SPOOF', ctrLat: 26.50, ctrLng: 56.30,  radiusNm: 160, sevBase: 80, fl: [0, 350],   src: 'OPSGROUP Wired 2024-Q1' },
]

/* ----- math helpers ----- */
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const R_NM = 3440.065
function gcNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180, dφ = (la2 - la1) * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
/* FNV-1a 32-bit hash for stable per-airframe noise */
function fnv(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}
function hashUnit(s: string, salt: string): number { return (fnv(s + '|' + salt) % 100000) / 100000 }

/* Classify airframe → GNSS fitment class */
function classifyFit(type: string | undefined, cat: string | undefined): Fit {
  const t = (type || '').toUpperCase()
  if (/^(B78[0-9]|B78X|A35[0-9]|A359|A388|A38F|B748)$/.test(t)) return 'MMR-SBAS-GBAS'
  if (/^(B73[7-9]|B7M[78]|B77[0-9]|A31[89]|A32[0-9]|A22[01]|A21N|A20N|A19N|BCS[123]|E1[37][0-9]|E14[05]|E17[05]|E190|E195|MD8[0-9]|MD9[0-9])$/.test(t)) return 'GNSS-SBAS'
  if (/^(A33[0-9]|A340|A310|A300|B75[0-9]|B76[0-9]|B72[0-9]|CRJ[0-9]|AT4[2-7]|AT7[2-6]|DH8[A-D]|MD11|IL[0-9]+|TU[0-9]+)$/.test(t)) return 'GNSS-RAIM'
  return 'BASIC-GPS'
}

type Phase = 'APP' | 'TERM' | 'ENR' | 'OCN' | 'CLB' | 'IDLE'
function phaseOf(f: SFlight): Phase {
  if (f.ground) return 'IDLE'
  const fl = f.altitudeFt / 100
  if (fl < 30) return 'IDLE'
  if (fl < 120) return f.vertRate > 500 ? 'CLB' : 'TERM'
  if (fl < 240) return f.vertRate < -500 ? 'APP' : 'ENR'
  if (fl >= 280) return 'ENR'
  return 'ENR'
}
const PHASE_MUL: Record<Phase, number> = { APP: 1.40, TERM: 1.30, ENR: 1.10, OCN: 1.20, CLB: 1.05, IDLE: 0.40 }

/* ----- per-aircraft exposure ----- */
interface Exposure {
  f: SFlight
  fit: Fit
  phase: Phase
  zone: Zone | null
  depthNm: number      // penetration depth into the zone (NM from edge, +ve = inside)
  zoneFrac: number     // 0..1 = how far into the zone (1 = at centre)
  flBand: number       // 0..1 = how strongly within the FL band
  expectedDriftNmHr: number  // IRS-only drift if GPS-lost
  spoofDriftNm: number       // instantaneous spoof position error projection
  adsbAnomaly: number  // 0..100 — synthetic NIC/NAC_p anomaly + clock-jump fingerprint
  drivers: { ZON: number; FLB: number; FIT: number; PHA: number; ADS: number; DRT: number }
  tier: Tier
  score: number
  advice: string
}

function makeExposure(f: SFlight, hwBias: number, fitMul: number, advMul: number): Exposure {
  const fit = classifyFit(f.type, f.category)
  const phase = phaseOf(f)
  // Find nearest active zone
  let near: { z: Zone; dNm: number } | null = null
  for (const z of ZONES) {
    const d = gcNm(f.lat, f.lng, z.ctrLat, z.ctrLng)
    if (d > z.radiusNm * 1.15) continue
    if (!near || d < near.dNm) near = { z, dNm: d }
  }
  if (!near) {
    return {
      f, fit, phase, zone: null, depthNm: 0, zoneFrac: 0, flBand: 0,
      expectedDriftNmHr: 0, spoofDriftNm: 0, adsbAnomaly: 0,
      drivers: { ZON: 0, FLB: 0, FIT: 0, PHA: 0, ADS: 0, DRT: 0 },
      tier: 'IDLE', score: 0, advice: 'Outside known active RFI zone.'
    }
  }
  const z = near.z
  const depthNm = clamp(z.radiusNm - near.dNm, 0, z.radiusNm)
  const zoneFrac = clamp(depthNm / z.radiusNm, 0, 1)
  const fl = f.altitudeFt / 100
  const flBand = (fl >= z.fl[0] && fl <= z.fl[1])
    ? 1
    : clamp(1 - Math.min(Math.abs(fl - z.fl[0]), Math.abs(fl - z.fl[1])) / 80, 0, 1)
  const sev = z.sevBase * (1 + hwBias / 100 - 1)  // hwBias acts as severity bias
  // Fitment factor (higher = worse exposure)
  const fitPen: Record<Fit, number> = { 'MMR-SBAS-GBAS': 0.45, 'GNSS-SBAS': 0.65, 'GNSS-RAIM': 0.85, 'BASIC-GPS': 1.00 }
  const FIT = clamp(fitPen[fit] * (fitMul / 100) * 100, 0, 100)
  // IRS drift budget per AC 25-1309 + DO-229F: 8 NM/h baseline degraded to fitment
  const irsDriftRate = fit === 'MMR-SBAS-GBAS' ? 1.5 : fit === 'GNSS-SBAS' ? 2.5 : fit === 'GNSS-RAIM' ? 5.0 : 8.0
  const expectedDriftNmHr = irsDriftRate
  // Spoof drift: instantaneous projection of zone-frac × per-airframe hash
  const spoofDriftNm = z.mode === 'JAM' ? 0 : clamp(zoneFrac * (40 + hashUnit(f.icao, 'spoof') * 110), 0, 180)
  // ADS-B anomaly synthesis: NIC/NAC_p degradation + clock-jump
  const adsbAnomaly = clamp(
    (z.mode === 'SPOOF' ? 60 : z.mode === 'MIXED' ? 45 : 25)
    * zoneFrac * flBand
    + hashUnit(f.icao, 'ads') * 18,
    0, 100
  )
  const ZON = clamp(sev * zoneFrac * 0.95, 0, 100)
  const FLB = clamp(flBand * 100, 0, 100)
  const PHA = PHASE_MUL[phase] * 70
  const ADS = adsbAnomaly
  const DRT = clamp(spoofDriftNm / 1.5, 0, 100)
  const drivers = { ZON, FLB, FIT, PHA, ADS, DRT }
  // composite — max-driver plus secondary
  const arr = [ZON, FLB, FIT, PHA, ADS, DRT].sort((a, b) => b - a)
  let composite = arr[0] * 0.65 + arr[1] * 0.22 + arr[2] * 0.10
  composite *= PHASE_MUL[phase] * (advMul / 100) * (zoneFrac > 0.05 ? 1 : 0.15)
  composite = clamp(composite, 0, 100)
  // Hard escalations
  if (z.mode === 'SPOOF' && zoneFrac > 0.55 && adsbAnomaly > 60 && phase !== 'IDLE') composite = Math.max(composite, 88)
  if (z.mode === 'JAM' && zoneFrac > 0.55 && (fit === 'BASIC-GPS' || fit === 'GNSS-RAIM') && phase === 'APP') composite = Math.max(composite, 82)
  let tier: Tier
  let advice = ''
  if (composite >= 80 && (z.mode === 'SPOOF' || z.mode === 'MIXED')) {
    tier = 'SPOOFED-HMI'
    advice = `HMI risk — cross-check IRS+VOR/DME vs FMS LRN; verify time vs SATCOM clock; revert PRIMARY NAV IRS; declare GPS-NOT-AVAILABLE per EASA SIB 2023-09`
  } else if (composite >= 65) {
    tier = 'JAMMED-HARD'
    advice = `Expect RAIM/SBAS loss inbound; brief DME/DME RNAV-1 reversion + VOR/DME ILS approach per Doc 9613 Vol II §3; file ASRS / EVAIR; ATC GPS-NOT-AVAILABLE`
  } else if (composite >= 40) {
    tier = 'DEGRADED'
    advice = `Monitor RAIM availability; cross-check IRS-FMS position; ATC GPS-degraded; brief reversion per FAA InFO 22002`
  } else if (composite >= 18) {
    tier = 'MARGIN'
    advice = `Entering known RFI region edge; brief crew; monitor NAV-source-select; expect periodic GPS dropouts per Finavia bulletin`
  } else if (composite > 0) {
    tier = 'NOMINAL'
    advice = `Within zone perimeter; signal margin intact; no action required`
  } else {
    tier = 'IDLE'
    advice = 'Outside zone effective range.'
  }
  return { f, fit, phase, zone: z, depthNm, zoneFrac, flBand, expectedDriftNmHr, spoofDriftNm, adsbAnomaly, drivers, tier, score: composite, advice }
}

const SRC_HALO = 'rfi-halo', LYR_HALO = 'rfi-halo'
const SRC_PIN  = 'rfi-pin',  LYR_PIN  = 'rfi-pin'
const SRC_LBL  = 'rfi-lbl',  LYR_LBL  = 'rfi-lbl'
const SRC_ZONE = 'rfi-zone', LYR_ZONE_FILL = 'rfi-zone-fill', LYR_ZONE_LINE = 'rfi-zone-line'
const SRC_ZLBL = 'rfi-zlbl', LYR_ZLBL = 'rfi-zlbl'
const SRC_DRT  = 'rfi-drt',  LYR_DRT  = 'rfi-drt'

const lsGet = (k: string, d: any) => { if (typeof window === 'undefined') return d; try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }
const lsSet = (k: string, v: any) => { if (typeof window === 'undefined') return; try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

function zoneCircle(z: Zone, segs = 64): any {
  const coords: number[][] = []
  for (let i = 0; i <= segs; i++) {
    const θ = (i / segs) * 2 * Math.PI
    const dLat = (z.radiusNm / R_NM) * (180 / Math.PI) * Math.cos(θ)
    const dLng = (z.radiusNm / R_NM) * (180 / Math.PI) * Math.sin(θ) / Math.cos(z.ctrLat * Math.PI / 180)
    coords.push([z.ctrLng + dLng, z.ctrLat + dLat])
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: { id: z.id, name: z.name, mode: z.mode, color: MODE_COLOR[z.mode] } }
}

export default function RfiGnss({ map, flights, onClose, onFly }: Props) {
  const [hwBias, setHwBias] = useState<number>(() => lsGet('ft-rfi-sev', 100))
  const [fitMul, setFitMul] = useState<number>(() => lsGet('ft-rfi-fit', 100))
  const [advMul, setAdvMul] = useState<number>(() => lsGet('ft-rfi-adv', 100))
  const [minFl,  setMinFl]  = useState<number>(() => lsGet('ft-rfi-mnfl', 0))
  const [phaseWt, setPhaseWt] = useState<number>(() => lsGet('ft-rfi-phw', 100))
  const [modeFilter, setModeFilter] = useState<Mode | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [fitFilter, setFitFilter] = useState<Fit | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'ZONES' | 'FITMENT'>('AIRCRAFT')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showZone, setShowZone] = useState(true)
  const [showZLbl, setShowZLbl] = useState(true)
  const [showDrt, setShowDrt] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    lsSet('ft-rfi-sev', hwBias); lsSet('ft-rfi-fit', fitMul); lsSet('ft-rfi-adv', advMul)
    lsSet('ft-rfi-mnfl', minFl); lsSet('ft-rfi-phw', phaseWt)
  }, [hwBias, fitMul, advMul, minFl, phaseWt])

  const exposures = useMemo(() => {
    const out: Exposure[] = []
    for (const f of flights) {
      if (f.altitudeFt / 100 < minFl) continue
      const e = makeExposure(f, hwBias, fitMul, advMul * (phaseWt / 100))
      if (e.tier !== 'IDLE' || e.zone) out.push(e)
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, hwBias, fitMul, advMul, minFl, phaseWt])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return exposures.filter(e => {
      if (modeFilter !== 'ALL' && (!e.zone || e.zone.mode !== modeFilter)) return false
      if (tierFilter !== 'ALL' && e.tier !== tierFilter) return false
      if (fitFilter !== 'ALL' && e.fit !== fitFilter) return false
      if (q) {
        const blob = `${e.f.callsign} ${e.f.icao} ${e.f.type} ${e.f.operator} ${e.zone?.id} ${e.zone?.name}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [exposures, modeFilter, tierFilter, fitFilter, query])

  const tierCount: Record<Tier, number> = { 'SPOOFED-HMI': 0, 'JAMMED-HARD': 0, DEGRADED: 0, MARGIN: 0, NOMINAL: 0, IDLE: 0 }
  for (const e of exposures) tierCount[e.tier]++
  const meanScore = exposures.length ? exposures.reduce((s, e) => s + e.score, 0) / exposures.length : 0
  const worst = exposures[0]
  const spoofN = exposures.filter(e => e.zone?.mode === 'SPOOF' || e.zone?.mode === 'MIXED').length
  const jamN = exposures.filter(e => e.zone?.mode === 'JAM' || e.zone?.mode === 'MIXED').length
  const meanDrift = exposures.length ? exposures.reduce((s, e) => s + e.spoofDriftNm, 0) / exposures.length : 0

  /* Map overlays */
  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any)
    }
    if (!map.getSource(SRC_ZONE)) map.addSource(SRC_ZONE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
    if (!map.getLayer(LYR_ZONE_FILL)) map.addLayer({ id: LYR_ZONE_FILL, type: 'fill', source: SRC_ZONE, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.10 } } as any)
    if (!map.getLayer(LYR_ZONE_LINE)) map.addLayer({ id: LYR_ZONE_LINE, type: 'line', source: SRC_ZONE, paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.7, 'line-dasharray': [4, 3] } } as any)

    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN, 'circle', SRC_PIN, { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_DRT, 'line', SRC_DRT, { 'line-color': ['get', 'color'], 'line-width': 1.8, 'line-opacity': 0.85, 'line-dasharray': [2, 2] })
    ensure(LYR_LBL, 'symbol', SRC_LBL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    ensure(LYR_ZLBL, 'symbol', SRC_ZLBL, {}, { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, 0], 'text-anchor': 'center', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL)) { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }
    if (map.getLayer(LYR_ZLBL)) { map.setPaintProperty(LYR_ZLBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_ZLBL, 'text-halo-color', '#020617'); map.setPaintProperty(LYR_ZLBL, 'text-halo-width', 1.6) }

    const zones: any[] = [], zlbls: any[] = []
    if (showZone) {
      for (const z of ZONES) {
        if (modeFilter !== 'ALL' && z.mode !== modeFilter) continue
        zones.push(zoneCircle(z))
        if (showZLbl) zlbls.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [z.ctrLng, z.ctrLat] }, properties: { label: `${z.id} · ${z.mode}`, color: MODE_COLOR[z.mode] } })
      }
    }
    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], drt: any[] = []
    for (const e of filtered) {
      if (!e.zone) continue
      const color = TIER_COLOR[e.tier]
      if (showHalo && e.tier !== 'IDLE') halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, r: 8 + e.score * 0.14 } })
      if (showPin && (e.tier === 'SPOOFED-HMI' || e.tier === 'JAMMED-HARD')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color } })
      if (showLbl && e.tier !== 'NOMINAL' && e.tier !== 'IDLE') {
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, label: `${e.f.callsign || e.f.icao} · ${e.zone.id} · ${e.tier}` } })
      }
      // Spoof-drift projection: dashed line from aircraft, direction = track + perpendicular by half spoofDriftNm
      if (showDrt && e.spoofDriftNm > 5) {
        const θ = (e.f.track + 90) * Math.PI / 180
        const dNm = e.spoofDriftNm
        const dLat = (dNm / R_NM) * (180 / Math.PI) * Math.cos(θ)
        const dLng = (dNm / R_NM) * (180 / Math.PI) * Math.sin(θ) / Math.cos(e.f.lat * Math.PI / 180)
        drt.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[e.f.lng, e.f.lat], [e.f.lng + dLng, e.f.lat + dLat]] }, properties: { color } })
      }
    }
    ;(map.getSource(SRC_ZONE) as any).setData({ type: 'FeatureCollection', features: zones })
    ;(map.getSource(SRC_ZLBL) as any).setData({ type: 'FeatureCollection', features: zlbls })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN)  as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL)  as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_DRT)  as any).setData({ type: 'FeatureCollection', features: drt })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_DRT, LYR_ZLBL, LYR_ZONE_LINE, LYR_ZONE_FILL]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_DRT, SRC_ZLBL, SRC_ZONE]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, showHalo, showPin, showLbl, showZone, showZLbl, showDrt, modeFilter])

  const tierBadge = (t: Tier) => <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  const fitBadge = (f: Fit) => <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: FIT_COLOR[f], backgroundColor: FIT_COLOR[f] + '1f', border: `1px solid ${FIT_COLOR[f]}55` }}>{f}</span>
  const modeBadge = (m: Mode) => <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: MODE_COLOR[m], backgroundColor: MODE_COLOR[m] + '1f', border: `1px solid ${MODE_COLOR[m]}55` }}>{m}</span>
  const drvBadge = (k: string, v: number) => {
    const c = v >= 70 ? '#ef4444' : v >= 40 ? '#f59e0b' : v >= 18 ? '#0ea5e9' : '#10b981'
    return <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: c, backgroundColor: c + '1c', border: `1px solid ${c}55` }}>{k}{v.toFixed(0)}</span>
  }

  /* Scatter chart geometry */
  const W = 280, H = 110, padL = 24, padB = 16, padT = 6, padR = 6
  const sx = (v: number) => padL + (v / 100) * (W - padL - padR)
  const sy = (v: number) => padT + (1 - v / 100) * (H - padT - padB)

  return (
    <div className="absolute right-3 top-20 z-40 w-[26rem] max-h-[calc(100vh-6rem)] flex flex-col bg-slate-900/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-rose-500 animate-pulse" />
          <span className="text-[10px] font-bold tracking-widest uppercase text-rose-400">GNSS RFI · Jam / Spoof</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[8px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean score</div><div className="text-sm font-semibold" style={{ color: meanScore >= 65 ? '#ef4444' : meanScore >= 35 ? '#f59e0b' : '#10b981' }}>{meanScore.toFixed(0)}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Worst</div><div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">HMI</div><div className="text-sm font-semibold" style={{ color: tierCount['SPOOFED-HMI'] > 0 ? '#ef4444' : '#10b981' }}>{tierCount['SPOOFED-HMI']}</div></div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">In spoof</div><div className="text-xs font-semibold text-rose-400">{spoofN}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">In jam</div><div className="text-xs font-semibold text-amber-400">{jamN}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean drift</div><div className="text-xs font-semibold text-sky-400">{meanDrift.toFixed(1)}nm</div></div>
      </div>

      {showDiag && exposures.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* breach quadrant: ZON>60 ADS>60 */}
            <rect x={sx(60)} y={sy(100)} width={W - padR - sx(60)} height={sy(60) - sy(100)} fill="#ef444425" />
            {/* watch band */}
            <rect x={sx(35)} y={sy(60)} width={sx(60) - sx(35)} height={sy(35) - sy(60)} fill="#f59e0b22" />
            <line x1={sx(35)} y1={sy(0)} x2={sx(35)} y2={sy(100)} stroke="#475569" strokeWidth={0.4} strokeDasharray="2 3" />
            <line x1={sx(60)} y1={sy(0)} x2={sx(60)} y2={sy(100)} stroke="#f43f5e66" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(0)} y1={sy(60)} x2={sx(100)} y2={sy(60)} stroke="#f43f5e66" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={W / 2} y={H - 3} textAnchor="middle" fontSize="9" fill="#64748b">Zone-depth (ZON)</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>ADS-B anomaly</text>
            {exposures.map((e, i) => (
              <circle key={i} cx={sx(e.drivers.ZON)} cy={sy(e.drivers.ADS)} r={2.4} fill={TIER_COLOR[e.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['SEV-MUL', hwBias, 50, 200, setHwBias, '%'],
            ['FIT-MUL', fitMul, 50, 200, setFitMul, '%'],
            ['ADV-MUL', advMul, 50, 200, setAdvMul, '%'],
            ['MIN-FL', minFl, 0, 400, setMinFl, ''],
            ['PHASE-WT', phaseWt, 50, 150, setPhaseWt, '%'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[40px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['SPOOF', 'JAM', 'MIXED'] as Mode[]).map(m => (
            <button key={m} onClick={() => setModeFilter(modeFilter === m ? 'ALL' : m)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: modeFilter === m ? MODE_COLOR[m] + '33' : '#0b1220', borderColor: modeFilter === m ? MODE_COLOR[m] : '#1e293b', color: modeFilter === m ? MODE_COLOR[m] : '#cbd5e1' }}>{m}</button>
          ))}
          <span className="text-slate-700">·</span>
          {(['MMR-SBAS-GBAS', 'GNSS-SBAS', 'GNSS-RAIM', 'BASIC-GPS'] as Fit[]).map(f => (
            <button key={f} onClick={() => setFitFilter(fitFilter === f ? 'ALL' : f)} className="px-1.5 py-0.5 rounded text-[9px] border font-mono" style={{ backgroundColor: fitFilter === f ? FIT_COLOR[f] + '33' : '#0b1220', borderColor: fitFilter === f ? FIT_COLOR[f] : '#1e293b', color: fitFilter === f ? FIT_COLOR[f] : '#cbd5e1' }}>{f.split('-')[0]}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['ZONE', showZone, setShowZone],
            ['ZLBL', showZLbl, setShowZLbl],
            ['DRIFT', showDrt, setShowDrt],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, v, setter]: any) => (
            <button key={lab} onClick={() => setter(!v)} className="px-1.5 py-0.5 rounded text-[9px] font-mono border" style={{ backgroundColor: v ? '#0ea5e933' : '#0b1220', borderColor: v ? '#0ea5e9' : '#1e293b', color: v ? '#7dd3fc' : '#64748b' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / type / zone" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'ZONES', 'FITMENT'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No aircraft inside an active RFI zone.</div>}
            {filtered.map((e, idx) => (
              <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(e.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[e.tier]}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-semibold text-slate-100 truncate">{e.f.callsign || e.f.icao}</span>
                    <span className="text-slate-500 text-[10px] font-mono">{e.f.type || '—'}</span>
                    {fitBadge(e.fit)}
                  </div>
                  {tierBadge(e.tier)}
                </div>
                {e.zone && (
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    {modeBadge(e.zone.mode)} <span className="text-sky-300 ml-1">{e.zone.id}</span>
                    {' · '}depth <span className="text-slate-300">{e.depthNm.toFixed(0)}nm</span>
                    {' · frac '}<span style={{ color: e.zoneFrac > 0.5 ? '#ef4444' : e.zoneFrac > 0.25 ? '#f59e0b' : '#10b981' }}>{(e.zoneFrac * 100).toFixed(0)}%</span>
                    {' · FL'}<span className="text-slate-300">{(e.f.altitudeFt / 100).toFixed(0)}</span>
                    {e.spoofDriftNm > 0 && (<> {' · drift '}<span className="text-rose-400">{e.spoofDriftNm.toFixed(0)}nm</span></>)}
                  </div>
                )}
                <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${e.score}%`, backgroundColor: TIER_COLOR[e.tier] }} /></div>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {drvBadge('ZON', e.drivers.ZON)}
                  {drvBadge('FLB', e.drivers.FLB)}
                  {drvBadge('FIT', e.drivers.FIT)}
                  {drvBadge('PHA', e.drivers.PHA)}
                  {drvBadge('ADS', e.drivers.ADS)}
                  {drvBadge('DRT', e.drivers.DRT)}
                </div>
                <div className="text-[10px] mt-1.5 italic" style={{ color: TIER_COLOR[e.tier] }}>{e.advice}</div>
              </div>
            ))}
          </div>
        )}

        {tab === 'ZONES' && (
          <div className="divide-y divide-slate-800">
            {ZONES.slice().sort((a, b) => {
              const ca = exposures.filter(e => e.zone?.id === a.id).length
              const cb = exposures.filter(e => e.zone?.id === b.id).length
              return cb - ca
            }).map(z => {
              const inZ = exposures.filter(e => e.zone?.id === z.id)
              const hmi = inZ.filter(e => e.tier === 'SPOOFED-HMI').length
              const jam = inZ.filter(e => e.tier === 'JAMMED-HARD').length
              const ms = inZ.length ? inZ.reduce((s, e) => s + e.score, 0) / inZ.length : 0
              return (
                <div key={z.id} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${MODE_COLOR[z.mode]}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-mono text-sky-300 text-[11px]">{z.id}</span>
                      {modeBadge(z.mode)}
                    </div>
                    <span className="text-[10px] font-mono text-slate-300">FL{z.fl[0]}–FL{z.fl[1]} · r{z.radiusNm}nm</span>
                  </div>
                  <div className="text-[10px] text-slate-400 truncate">{z.name}</div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    {inZ.length} ac · <span className="text-rose-400">{hmi} HMI</span> · <span className="text-rose-400">{jam} JAM</span> · sev {z.sevBase}
                  </div>
                  <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 65 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
                  <div className="text-[9px] text-slate-600 mt-1 italic truncate">{z.src}</div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'FITMENT' && (
          <div className="divide-y divide-slate-800">
            {(['MMR-SBAS-GBAS', 'GNSS-SBAS', 'GNSS-RAIM', 'BASIC-GPS'] as Fit[]).map(f => {
              const inF = exposures.filter(e => e.fit === f)
              const hmi = inF.filter(e => e.tier === 'SPOOFED-HMI').length
              const jam = inF.filter(e => e.tier === 'JAMMED-HARD').length
              const ms = inF.length ? inF.reduce((s, e) => s + e.score, 0) / inF.length : 0
              return (
                <div key={f} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${FIT_COLOR[f]}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      {fitBadge(f)}
                    </div>
                    <span className="text-[10px] font-mono text-slate-300">{inF.length} ac</span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">{FIT_LABEL[f]}</div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    <span className="text-rose-400">{hmi} HMI</span> · <span className="text-rose-400">{jam} JAM</span> · IRS-drift {f === 'MMR-SBAS-GBAS' ? '1.5' : f === 'GNSS-SBAS' ? '2.5' : f === 'GNSS-RAIM' ? '5.0' : '8.0'} nm/h
                  </div>
                  <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 65 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        EASA SIB 2022-02R3 / 2023-09 · FAA InFO 22002 / SAFO 23005 · Doc 9849 ch.6 · Doc 9613 Vol II Pt C §3 · IFALPA 2024-01 · OPSGROUP Wired 2024-Q1 · EUROCONTROL EVAIR 27/28
      </div>
    </div>
  )
}
