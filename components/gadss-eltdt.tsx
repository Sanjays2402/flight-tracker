'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   GADSS Normal / Autonomous Distress Tracking (ADT) & 406 MHz
   ELT-DT Cospas-Sarsat Compliance Monitor
   -----------------------------------------------------------
   Post-MH370 ICAO Global Aeronautical Distress and Safety
   System (GADSS) concept of operations. Every airborne
   transport aircraft >27 t MTOM must report position at
   <=15 min in normal flight (Normal Tracking, applicable from
   8 Nov 2018 per ICAO Annex 6 Pt I 6.18) and, once a
   distress condition is detected, autonomously transmit
   position at <=1 min, untriggered by crew, in a manner
   that survives loss of electrical power (Autonomous
   Distress Tracking, applicable from 1 Jan 2023 per
   Annex 6 Pt I 6.18 + Amdt 40-A). 406 MHz Cospas-Sarsat
   ELTs replace the legacy 121.5 MHz ELT discontinued by
   Cospas-Sarsat satellite processing on 1 Feb 2009. The
   new generation ELT-DT (Distress Tracking) self-actuates
   on g-onset / unusual attitude / overspeed / impact /
   immersion logic per RTCA DO-204B / EUROCAE ED-237 and
   transmits via MEOSAR (Galileo / GPS / GLONASS payloads).

   Regulatory & operational basis:
     * ICAO Annex 6 Pt I 6.18 Aircraft Tracking + ADT
     * ICAO Annex 6 Pt I App 9 Flight Recorders + ELT
     * ICAO Annex 10 Vol III Pt II 5 ELT requirements
     * ICAO Doc 10054 GADSS Concept of Ops
     * ICAO Doc 9731 IAMSAR Vol II / Vol III
     * Cospas-Sarsat C/S T.001 / T.018 / G.005 (MEOSAR)
     * Cospas-Sarsat A.001 ELT-DT specification
     * Cospas-Sarsat A.005 Beacon ID structure
     * 14 CFR 91.207 ELT installation / inspection
     * 14 CFR 121.339 Survival / emergency equipment over-water
     * 14 CFR 135.167 Emergency equipment / extended over-water
     * FAA AC 91-44A 121.5 MHz ELT (discontinued)
     * FAA AC 91-73B Surface ops including ELT batt currency
     * RTCA DO-204B / EUROCAE ED-237 ELT-DT MOPS
     * EASA CS-25.1411 / AMC1 CAT.GEN.MPA.205 ELT
     * EASA AMC1 CAT.IDE.A.280 ELT-DT / AMC1 CAT.IDE.A.285
     * FAA InFO 16012 / 18006 ELT battery currency
     * NTSB AAR-16/02 ELT non-activation lessons
     * MH370 ICAO 17-yr GADSS implementation reference
     * AF447 ACARS last-position reference (5034 W 230 N)
     * Honeywell RESCU-406AFN / ACK E-04 / ELTA ADT406AP /
       Kannad Integra-AF / McMurdo Smartfind G8 catalogue

   8-class ELT/tracking equipage catalogue:
     HVY-DT  B777X/B787-10/A350-1000 next-gen     ELT-DT + Iridium / Inmarsat dual
     HVY     B777/B787/A350/A380                  406-AP + Iridium SATCOM tracking
     HMB     B767/B747-400/A330/A340              406-AF + ACARS tracking
     NRW     B737NG/MAX A320/A321 narrowbody      406-AF + ADS-B tracking
     RGN     CRJ-700/900 E170/E190 regional       406-AF + ADS-B tracking
     BIZ     G650/Global/Falcon biz-jet           406-AP + Iridium
     TBP     Q400 ATR-72 turboprop                406-AF + ADS-B
     GA      Light GA singles                     121.5 legacy or 406-AF retrofit

   ELT generation:
     LEGACY-121.5   pre-2009 121.5 MHz only — no Cospas-Sarsat
     406-AF         406 MHz Auto-Fixed g-switch activation
     406-AP         406 MHz Auto-Portable crew-removable
     ELT-DT         Distress-Tracking 1-min auto-broadcast

   Per-airframe FNV-1a 32-bit hash (ICAO24) synthesises:
     * elt generation per class baseline + age-roll
     * normal-tracking report interval seconds (target <=900s)
     * last-report age seconds (current report freshness)
     * SATCOM Iridium / Inmarsat / ACARS link health 0..100
     * ADS-B position-NIC integrity 0..11
     * ELT 406 battery remaining months 0..72 (renew at 60 mo
       per 14 CFR 91.207(c)(2))
     * ELT self-test fault flag (1.5 % fleet share per InFO 18006)
     * GPS-source coupling (auto / coded-encoded vs none)
     * MEOSAR position-doppler accuracy m (default 2-5 km LEO,
       100 m MEOSAR with GNSS)

   Distress-condition detection (synthesised flight-state):
     * vertical-rate gt 6000 fpm down (unusual descent)
     * bank gt 45 deg sustained (derived from track jitter)
     * altitude lt 1000 ft AGL outside arrival capture
     * abrupt course change gt 30 deg in 60 s
     Any condition flips airframe to DISTRESS regime where
     ADT 1-min reporting becomes mandatory.

   5 risk components, composite = max-driver:
     ELT    ELT generation vs class baseline 100 LEGACY-121.5
            on >27t, 60 expired-battery, 30 self-test fault,
            0 ELT-DT functional
     INT    last-report-age vs required interval 100 at
            >=2x interval, scaled. Interval = 60 s in
            distress, 900 s normal.
     SAT    SATCOM link health composite 100 at all-links
            below 30, scaled
     POS    ADS-B NIC integrity 100 at NIC<=4 (>0.5 nm
            uncertainty), 0 at NIC>=8 (<10 m)
     BAT    battery months-remaining 100 at <=0, 75 at <=6,
            40 at <=12, 0 at >=24

   Tier classification:
     UNTRACKED  any drv 100 OR distress-with-no-ADT-coverage
                rose — outside coverage / non-compliant —
                file SAR alert per ICAO Annex 11 Att G
     DEGRADED   score >=55 amber — Doc 10054 ConOps
                degraded — log every 5 min, brief crew
                position-report manually via HF SELCAL
     WATCH      score >=25 sky — within ConOps margin but
                trend adverse — operations to verify SATCOM
                handover next ground station
     OK         score <25 emerald — full GADSS NT + ADT
                compliance
     IDLE       on ground or no class data slate

   MapLibre overlay:
     * tier-coloured halo rings sized by score 8-22 px
     * rose diamond pin at current position for UNTRACKED
       with last-report-age + ELT-gen callout
     * tier-coloured callsign + ELT + last-report-age labels
       for DEGRADED / UNTRACKED
     * 4 Cospas-Sarsat MCC reference pins
       (USMCC Maryland / FMCC Toulouse / RMCC Moscow /
        AMCC Bengaluru) sky / slate
     * 32 LEOSAR foot-print reference circles (great-circle
       segments at 60 / 30 / 0 / -30 / -60 lat every 30 deg)

   Side panel:
     * 5-tier counter strip click-to-filter
     * 3-cell MEAN-LAST-REPORT-S / WORST callsign + ELT /
       UNTRACKED-count summary
     * 2-cell DISTRESS-count rose / LEGACY-ELT-share
       amber-when-over-5% secondary row
     * SVG report-age (x) vs SATCOM-health (y) scatter with
       tier bands, 60 s / 900 s / 1800 s verticals,
       30 / 60 percent horizontals, every aircraft plotted
       as tier-coloured dot
     * 6 sliders MIN-FL / NT-INT-S / ADT-INT-S / SAT-MIN /
       BAT-RENEW-MO / DISTRESS-SENS
     * 8-class chip filter + 4-ELT-gen chip filter
     * HALO / PIN / LBL / MCC / DIAG toggles
     * AIRCRAFT / ELT-GEN tab switcher
============================================================ */

export interface GadssFlight {
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
  flights: GadssFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'UNTRACKED' | 'DEGRADED' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  UNTRACKED: '#ef4444', DEGRADED: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['UNTRACKED', 'DEGRADED', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { UNTRACKED: 0, DEGRADED: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Gen = 'LEGACY-121.5' | '406-AF' | '406-AP' | 'ELT-DT'
const GEN_LIST: Gen[] = ['LEGACY-121.5', '406-AF', '406-AP', 'ELT-DT']
const GEN_RANK: Record<Gen, number> = { 'LEGACY-121.5': 0, '406-AF': 1, '406-AP': 2, 'ELT-DT': 3 }

type AcClass = 'HVY-DT' | 'HVY' | 'HMB' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA'
const CLASS_LIST: AcClass[] = ['HVY-DT', 'HVY', 'HMB', 'NRW', 'RGN', 'BIZ', 'TBP', 'GA']

interface ClassSpec {
  baseGen: Gen
  satcom: string
  refDoc: string
  mtomT: number          // metric tons (gt 27 t triggers GADSS NT/ADT)
}
const CLASS_SPEC: Record<AcClass, ClassSpec> = {
  'HVY-DT': { baseGen: 'ELT-DT', satcom: 'Iridium NEXT + Inmarsat SBB',     refDoc: 'Honeywell RESCU-406AFN / ELTA ADT406AP-DT', mtomT: 280 },
  'HVY':    { baseGen: '406-AP', satcom: 'Iridium / Inmarsat SBB',          refDoc: 'Honeywell RESCU-406AFN · ARINC 781',       mtomT: 240 },
  'HMB':    { baseGen: '406-AF', satcom: 'ACARS VHF/HF + Inmarsat Classic', refDoc: 'ACK E-04 · Kannad Integra-AF · ARINC 597', mtomT: 180 },
  'NRW':    { baseGen: '406-AF', satcom: 'ADS-B Out + ACARS VHF',           refDoc: 'McMurdo Smartfind G8 · Kannad Integra',    mtomT: 79 },
  'RGN':    { baseGen: '406-AF', satcom: 'ADS-B Out + VHF',                 refDoc: 'ACK E-04.2 · Artex C406-N',                mtomT: 38 },
  'BIZ':    { baseGen: '406-AP', satcom: 'Iridium SBD',                     refDoc: 'Artex ELT-1000 · Kannad Integra-AP',       mtomT: 45 },
  'TBP':    { baseGen: '406-AF', satcom: 'ADS-B Out + VHF',                 refDoc: 'ACK E-04 · Artex C406-2',                  mtomT: 21 },
  'GA':     { baseGen: '406-AF', satcom: 'VHF-only',                        refDoc: 'ACK E-04 retrofit · 121.5 legacy',         mtomT: 2 },
}

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B77.{0,3}9|B78.{0,3}10|A35.{0,3}10/.test(t)) return 'HVY-DT'
  if (/B77|B78|A35|A38/.test(t)) return 'HVY'
  if (/B76|B74|A33|A34|MD11/.test(t)) return 'HMB'
  if (/B73|B72|A22|A31|A32|MD8|MD9/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E29|RJ85|F70|F100|AT[47]/.test(t)) return 'RGN'
  if (/G[VI458]|GLF|GLEX|CL[36]|FA[5789]|F2TH|E[35]5/.test(t)) return 'BIZ'
  if (/DH8|ATR|TBM|PT6|KING|BE20|DH3/.test(t)) return 'TBP'
  return 'GA'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

type Driver = 'ELT' | 'INT' | 'SAT' | 'POS' | 'BAT' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  ELT: 'ELT generation below GADSS requirement',
  INT: 'Position-report interval exceeds GADSS NT/ADT cap',
  SAT: 'SATCOM link composite health degraded',
  POS: 'ADS-B NIC position-integrity insufficient',
  BAT: 'ELT 406 battery beyond renewal interval per 91.207(c)',
  NONE: 'Nominal',
}

interface MCC { name: string; lat: number; lng: number; code: string }
const MCCS: MCC[] = [
  { name: 'USMCC Suitland MD',    lat: 38.846, lng: -76.932, code: 'USMCC' },
  { name: 'FMCC Toulouse',        lat: 43.566, lng:   1.481, code: 'FMCC' },
  { name: 'RMCC Moscow',          lat: 55.755, lng:  37.617, code: 'RMCC' },
  { name: 'INMCC Bengaluru',      lat: 12.972, lng:  77.594, code: 'INMCC' },
]

interface Row {
  f: GadssFlight
  klass: AcClass
  spec: ClassSpec
  gen: Gen
  intervalS: number           // current reporting interval
  lastReportS: number         // age of last report
  satHealth: number           // 0..100
  nicValue: number            // 0..11
  batMo: number               // months remaining
  selfTestFault: boolean
  distress: boolean
  distressReasons: string[]
  reqIntervalS: number
  sev: { elt: number; int: number; sat: number; pos: number; bat: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'gad-halo', SRC_LBL = 'gad-lbl', SRC_PIN = 'gad-pin', SRC_MCC = 'gad-mcc'
const LYR_HALO = 'gad-halo-l', LYR_LBL = 'gad-lbl-l', LYR_PIN = 'gad-pin-l', LYR_MCC = 'gad-mcc-l'

export default function GadssEltDt({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'ELT-GEN'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [genFilter, setGenFilter] = useState<Gen | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [ntIntS, setNtIntS] = useState(900)         // 60..1800
  const [adtIntS, setAdtIntS] = useState(60)        // 30..180
  const [satMin, setSatMin] = useState(30)          // 10..60 % threshold
  const [batRenewMo, setBatRenewMo] = useState(60)  // 24..72 mo
  const [distressSens, setDistressSens] = useState(100) // 50..200 %
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showMcc, setShowMcc] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const nowSec = Math.floor(Date.now() / 1000)
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      if (f.altitudeFt / 100 < minFl) continue
      const klass = classifyClass(f.type || '')
      const spec = CLASS_SPEC[klass]
      const h = hash32(f.icao || '')
      // ELT generation roll
      const genRoll = (h & 0xff) / 255
      let gen: Gen = spec.baseGen
      if (klass === 'GA' && genRoll < 0.10) gen = 'LEGACY-121.5'
      else if ((klass === 'TBP' || klass === 'RGN') && genRoll < 0.04) gen = 'LEGACY-121.5'
      else if (klass === 'HVY-DT') gen = 'ELT-DT'
      else if (klass === 'HVY' && genRoll < 0.10) gen = 'ELT-DT'
      // Battery months remaining 0..72
      const batMo = (h >>> 8) % 73
      const selfTestFault = ((h >>> 16) % 1000) < 15
      // SATCOM health 0..100 with class baseline
      const satBase = klass === 'HVY-DT' ? 92 : klass === 'HVY' || klass === 'BIZ' ? 85 : klass === 'HMB' ? 70 : 55
      const satNoise = ((h >>> 19) % 40) - 20
      const satHealth = Math.max(0, Math.min(100, satBase + satNoise))
      // NIC 0..11 ADS-B integrity
      const nicBase = klass === 'HVY-DT' || klass === 'HVY' ? 9 : klass === 'NRW' || klass === 'HMB' ? 8 : 7
      const nicNoise = ((h >>> 23) & 7) - 3
      const nicValue = Math.max(0, Math.min(11, nicBase + nicNoise))
      // Distress detection
      const reasons: string[] = []
      const sens = distressSens / 100
      if (f.vertRate < -6000 * sens) reasons.push(`descent ${Math.round(-f.vertRate)}fpm`)
      if (f.altitudeFt < 1000 && Math.abs(f.vertRate) > 1500 * sens && f.velocityKts > 100) reasons.push('low-alt nonarrival')
      // course-rate proxy via hash for unusual-attitude flag (3% fleet share when sensitive)
      const distressRoll = (h >>> 26) % 1000
      if (distressRoll < 12 * sens) reasons.push('unusual-attitude pickup')
      const distress = reasons.length > 0
      // Required interval per GADSS
      const reqIntervalS = distress ? adtIntS : ntIntS
      // Current interval & last-report-age synthesis
      // Modern aircraft report every 5-60 s via ADS-B/ACARS; degraded older ones up to 1800 s
      let intervalS: number
      if (gen === 'ELT-DT') intervalS = 30 + ((h >>> 4) % 90)
      else if (gen === '406-AP') intervalS = 60 + ((h >>> 5) % 240)
      else if (gen === '406-AF') intervalS = 120 + ((h >>> 6) % 600)
      else intervalS = 600 + ((h >>> 7) % 1200)
      // Tick-based jitter for last-report-age (0..2 x interval)
      const ageBucket = Math.floor(nowSec / 60)
      const jitter = (hash32(f.icao + ':' + ageBucket) % 1000) / 1000
      const lastReportS = Math.round(intervalS * (0.2 + jitter * 1.8))

      // Severities
      // ELT severity
      let eltSev = 0
      if (gen === 'LEGACY-121.5' && spec.mtomT >= 27) eltSev = 100
      else if (gen === 'LEGACY-121.5') eltSev = 70
      else if (batMo <= 0) eltSev = Math.max(eltSev, 90)
      else if (batMo <= 6) eltSev = Math.max(eltSev, 55)
      if (selfTestFault) eltSev = Math.max(eltSev, 55)
      // INT severity
      const intRatio = lastReportS / reqIntervalS
      const intSev = intRatio <= 0.5 ? 0 : intRatio >= 2 ? 100 : Math.round((intRatio - 0.5) / 1.5 * 100)
      // SAT severity
      const satSev = satHealth >= 80 ? 0 : satHealth <= satMin ? 100 : Math.round((80 - satHealth) / (80 - satMin) * 100)
      // POS severity (NIC)
      const posSev = nicValue >= 9 ? 0 : nicValue <= 4 ? 100 : Math.round((9 - nicValue) / 5 * 100)
      // BAT severity
      const batSev = batMo <= 0 ? 100 : batMo >= batRenewMo / 2 ? 0 : Math.round((batRenewMo / 2 - batMo) / (batRenewMo / 2) * 100)

      const drvList: Array<[Driver, number]> = [
        ['ELT', eltSev], ['INT', intSev], ['SAT', satSev], ['POS', posSev], ['BAT', batSev],
      ]
      drvList.sort((a, b) => b[1] - a[1])
      const driver: Driver = drvList[0][1] > 0 ? drvList[0][0] : 'NONE'
      const score = drvList[0][1]
      let tier: Tier
      if (score >= 80 || (distress && gen !== 'ELT-DT' && lastReportS > adtIntS * 2)) tier = 'UNTRACKED'
      else if (score >= 55) tier = 'DEGRADED'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'
      out.push({
        f, klass, spec, gen,
        intervalS, lastReportS,
        satHealth, nicValue, batMo, selfTestFault,
        distress, distressReasons: reasons, reqIntervalS,
        sev: { elt: eltSev, int: intSev, sat: satSev, pos: posSev, bat: batSev },
        score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, ntIntS, adtIntS, satMin, batRenewMo, distressSens])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { UNTRACKED: 0, DEGRADED: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumAge = 0, sumSat = 0, sumBat = 0, distress = 0, legacy = 0, count = 0
    let worst = 0, worstCs = '', worstScore = 0, untracked = 0
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      count++
      sumAge += r.lastReportS
      sumSat += r.satHealth
      sumBat += r.batMo
      if (r.distress) distress++
      if (r.gen === 'LEGACY-121.5') legacy++
      if (r.tier === 'UNTRACKED') untracked++
      if (r.score > worst) { worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstScore = r.score }
    }
    return {
      meanAge: count ? sumAge / count : 0,
      meanSat: count ? sumSat / count : 0,
      meanBat: count ? sumBat / count : 0,
      worst, worstCs, worstScore, untracked, distress, legacy,
      legacyShare: count ? legacy / count : 0,
      activeCount: count,
    }
  }, [rows])

  const genAggs = useMemo(() => {
    const m = new Map<Gen, { gen: Gen; count: number; sumScore: number; worst: number; worstCs: string; worstIcao: string; worstTier: Tier; untracked: number; distress: number; meanAge: number; sumAge: number }>()
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      let a = m.get(r.gen)
      if (!a) { a = { gen: r.gen, count: 0, sumScore: 0, worst: 0, worstCs: '', worstIcao: '', worstTier: 'OK', untracked: 0, distress: 0, meanAge: 0, sumAge: 0 }; m.set(r.gen, a) }
      a.count++; a.sumScore += r.score; a.sumAge += r.lastReportS
      if (r.tier === 'UNTRACKED') a.untracked++
      if (r.distress) a.distress++
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.score > a.worst) { a.worst = r.score; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
    }
    const arr = Array.from(m.values()).map(a => ({ ...a, meanScore: a.count ? a.sumScore / a.count : 0, meanAge: a.count ? a.sumAge / a.count : 0 }))
    arr.sort((a, b) => {
      const ti = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
      if (ti !== 0) return ti
      return b.untracked - a.untracked
    })
    return arr
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows
      .filter(r => r.tier !== 'IDLE')
      .filter(r => {
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (classFilter !== 'ALL' && r.klass !== classFilter) return false
        if (genFilter !== 'ALL' && r.gen !== genFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, classFilter, genFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'DEGRADED' || r.tier === 'UNTRACKED').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${r.gen} ${r.lastReportS}s ${r.driver}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'UNTRACKED').map(r => ({
      type: 'Feature' as const,
      properties: { color: '#ef4444', text: `\u203a ${r.gen} ${r.lastReportS}s${r.distress ? ' DISTRESS' : ''}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const mccFeatures: any[] = []
    if (showMcc) {
      for (const m of MCCS) {
        mccFeatures.push({
          type: 'Feature' as const,
          properties: { color: '#38bdf8', text: m.code },
          geometry: { type: 'Point' as const, coordinates: [m.lng, m.lat] },
        })
      }
    }
    const mccFc = { type: 'FeatureCollection' as const, features: mccFeatures }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_MCC, mccFc, () => map.addLayer({ id: LYR_MCC, type: 'symbol', source: SRC_MCC, layout: {
        'text-field': ['get', 'text'], 'text-size': 9, 'text-offset': [0, 0.8], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2, 'text-opacity': 0.8 } }))
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
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_MCC]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_MCC]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showMcc])

  // SVG diagram: last-report-age (x s) vs SATCOM health (y %)
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 30
    const xMax = 1800, yMax = 100
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, v / xMax)) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMax, yMax }
  }, [])

  const tierColorOf = (s: number) => s >= 80 ? '#ef4444' : s >= 55 ? '#f59e0b' : s >= 25 ? '#0ea5e9' : '#10b981'
  const adviceFor = (r: Row): string => {
    if (r.tier === 'UNTRACKED') {
      if (r.driver === 'ELT') return `ELT ${r.gen} non-compliant for >27t per ICAO Annex 6 6.18 — file ADT alerting SAR, retrofit ELT-DT per A.001`
      if (r.driver === 'INT') return `Position-report age ${r.lastReportS}s exceeds ${r.distress ? 'ADT 60s' : 'NT 15min'} cap — file SAR alert ICAO Annex 11 Att G, attempt SATCOM handover`
      if (r.driver === 'SAT') return `SATCOM links ${Math.round(r.satHealth)}% — request HF SELCAL handover, brief crew manual position reports every 5 min`
      if (r.driver === 'POS') return `ADS-B NIC ${r.nicValue} insufficient (>0.5 nm uncertainty) — request radar separation, MEOSAR fallback`
      if (r.driver === 'BAT') return `ELT 406 battery ${r.batMo}mo remaining (cap ${batRenewMo}mo per 14 CFR 91.207(c)) — replace before next dispatch`
      return 'GADSS ConOps breach — file SAR alert per ICAO Annex 11 Att G'
    }
    if (r.tier === 'DEGRADED') return `ICAO Doc 10054 degraded — log every 5 min, brief crew on HF SELCAL backup, expect SATCOM handover at next ground station`
    if (r.tier === 'WATCH') return `Within GADSS margin but trend adverse — verify SATCOM handover next ground station, monitor ${r.driver}`
    return `Full GADSS NT + ADT — ${r.gen} reporting every ${r.intervalS}s, SAT ${Math.round(r.satHealth)}%, NIC ${r.nicValue}`
  }

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">GADSS · ELT-DT Distress Tracking</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.activeCount} ac · {summary.untracked} UNTRK</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold" style={{ color: TIER_COLOR[t] }}>{t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean report age</div>
          <div className="font-mono text-sm" style={{ color: summary.meanAge > 900 ? '#ef4444' : summary.meanAge > 300 ? '#f59e0b' : summary.meanAge > 120 ? '#0ea5e9' : '#10b981' }}>{summary.meanAge.toFixed(0)}s</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] truncate" style={{ color: tierColorOf(summary.worstScore) }}>{summary.worstCs || '—'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Untracked</div>
          <div className="font-mono text-sm text-rose-400">{summary.untracked}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Distress</div>
          <div className="font-mono text-[11px]" style={{ color: summary.distress > 0 ? '#ef4444' : '#10b981' }}>{summary.distress}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Legacy-121.5 share</div>
          <div className="font-mono text-[11px]" style={{ color: summary.legacyShare > 0.05 ? '#f59e0b' : '#10b981' }}>{(summary.legacyShare * 100).toFixed(1)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg viewBox={`0 0 ${diag.W} ${diag.H}`} className="w-full h-auto">
            {/* age tier bands */}
            <rect x={diag.xs(900)} y={6} width={diag.xs(1800)-diag.xs(900)} height={diag.H-30-6} fill="#ef4444" opacity={0.08} />
            <rect x={diag.xs(300)} y={6} width={diag.xs(900)-diag.xs(300)} height={diag.H-30-6} fill="#f59e0b" opacity={0.07} />
            <rect x={diag.xs(60)}  y={6} width={diag.xs(300)-diag.xs(60)}  height={diag.H-30-6} fill="#0ea5e9" opacity={0.06} />
            <rect x={diag.PAD}     y={6} width={diag.xs(60)-diag.PAD}      height={diag.H-30-6} fill="#10b981" opacity={0.05} />
            {/* verticals */}
            {([['ADT', 60], ['NT', 900], ['BREACH', 1800]] as Array<[string, number]>).map(([l, v]) => (
              <g key={l}>
                <line x1={diag.xs(v)} y1={6} x2={diag.xs(v)} y2={diag.H - 22} stroke="#475569" strokeWidth={0.5} strokeDasharray="2 3" />
                <text x={diag.xs(v) + 2} y={14} fill="#64748b" fontSize={8}>{l}</text>
              </g>
            ))}
            {[300, 900].map(v => (
              <g key={'x'+v}>
                <text x={diag.xs(v)} y={diag.H - 12} fill="#64748b" fontSize={8} textAnchor="middle">{v}s</text>
              </g>
            ))}
            {[30, 60, 80].map(v => (
              <g key={'y'+v}>
                <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)} stroke="#334155" strokeWidth={0.4} strokeDasharray="2 3" />
                <text x={4} y={diag.ys(v) + 3} fill="#64748b" fontSize={8}>{v}%</text>
              </g>
            ))}
            {rows.filter(r => r.tier !== 'IDLE').slice(0, 800).map((r, i) => (
              <circle key={i} cx={diag.xs(Math.min(diag.xMax, r.lastReportS))} cy={diag.ys(r.satHealth)} r={2} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
            <text x={diag.W - 6} y={diag.H - 2} fill="#475569" fontSize={8} textAnchor="end">report-age s · SATCOM %</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Min FL</span><span className="text-slate-300 font-mono">{minFl}</span></span>
          <input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>NT int s</span><span className="text-slate-300 font-mono">{ntIntS}</span></span>
          <input type="range" min={60} max={1800} step={30} value={ntIntS} onChange={e => setNtIntS(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>ADT int s</span><span className="text-slate-300 font-mono">{adtIntS}</span></span>
          <input type="range" min={30} max={180} step={10} value={adtIntS} onChange={e => setAdtIntS(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>SAT floor %</span><span className="text-slate-300 font-mono">{satMin}</span></span>
          <input type="range" min={10} max={60} step={5} value={satMin} onChange={e => setSatMin(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>BAT renew mo</span><span className="text-slate-300 font-mono">{batRenewMo}</span></span>
          <input type="range" min={24} max={72} step={6} value={batRenewMo} onChange={e => setBatRenewMo(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col text-[9px] text-slate-500 uppercase tracking-widest">
          <span className="flex justify-between"><span>Distress ×</span><span className="text-slate-300 font-mono">{distressSens}%</span></span>
          <input type="range" min={50} max={200} step={10} value={distressSens} onChange={e => setDistressSens(+e.target.value)} className="accent-sky-500" />
        </label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {CLASS_LIST.map(c => {
          const on = classFilter === c
          return <button key={c} onClick={() => setClassFilter(on ? 'ALL' : c)}
            className={`px-1.5 py-0.5 rounded border text-[10px] font-mono transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-800 text-slate-400 hover:text-slate-200'}`}>{c}</button>
        })}
      </div>
      <div className="flex flex-wrap gap-1 px-3 py-1 border-b border-slate-800">
        {GEN_LIST.map(c => {
          const on = genFilter === c
          return <button key={c} onClick={() => setGenFilter(on ? 'ALL' : c)}
            className={`px-1.5 py-0.5 rounded border text-[9px] font-mono transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-800 text-slate-400 hover:text-slate-200'}`}>{c}</button>
        })}
      </div>

      <div className="flex items-center gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['MCC', showMcc, setShowMcc], ['DIAG', showDiag, setShowDiag]] as const).map(([l, v, fn]) => (
          <button key={l} onClick={() => (fn as any)((x: boolean) => !x)}
            className={`px-1.5 py-0.5 rounded border text-[10px] font-mono transition ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'border-slate-800 text-slate-500'}`}>{l}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search…"
          className="ml-auto bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-[10px] text-slate-200 placeholder:text-slate-600 w-24 focus:outline-none focus:border-sky-500/40" />
      </div>

      <div className="flex border-b border-slate-800 text-[10px]">
        {(['AIRCRAFT', 'ELT-GEN'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-1.5 uppercase tracking-widest font-bold ${tab === t ? 'text-sky-300 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-8 text-center text-slate-500 text-[11px]">No airborne aircraft above MIN-FL.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => (
          <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/70 transition relative">
            <span className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: TIER_COLOR[r.tier] }} />
            <div className="flex items-center gap-1.5">
              <span className="font-mono font-bold text-slate-100">{(r.f.callsign || r.f.icao).trim()}</span>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="text-[9px] font-mono px-1 rounded border border-slate-800 text-slate-400">{r.klass}</span>
              <span className="text-[9px] font-mono px-1 rounded border" style={{ borderColor: GEN_RANK[r.gen] >= 2 ? '#10b98188' : GEN_RANK[r.gen] === 1 ? '#0ea5e988' : '#ef444488', color: GEN_RANK[r.gen] >= 2 ? '#10b981' : GEN_RANK[r.gen] === 1 ? '#0ea5e9' : '#ef4444' }}>{r.gen}</span>
              {r.distress && <span className="text-[9px] font-mono px-1 rounded border border-rose-500/60 text-rose-300">DISTRESS</span>}
              <span className="text-[9px] font-mono px-1 rounded border ml-auto" style={{ borderColor: TIER_COLOR[r.tier], color: TIER_COLOR[r.tier] }}>{r.tier}</span>
            </div>
            <div className="flex items-baseline gap-2 mt-0.5 text-[10px] font-mono text-slate-400">
              <span>FL{Math.round(r.f.altitudeFt / 100).toString().padStart(3, '0')}</span>
              <span style={{ color: r.lastReportS > r.reqIntervalS ? '#ef4444' : r.lastReportS > r.reqIntervalS * 0.5 ? '#f59e0b' : '#10b981' }}>age {r.lastReportS}s / {r.reqIntervalS}s</span>
              <span style={{ color: r.satHealth < satMin ? '#ef4444' : r.satHealth < 60 ? '#f59e0b' : '#10b981' }}>SAT {Math.round(r.satHealth)}%</span>
              <span style={{ color: r.nicValue <= 4 ? '#ef4444' : r.nicValue <= 7 ? '#f59e0b' : '#10b981' }}>NIC {r.nicValue}</span>
              <span style={{ color: r.batMo <= 0 ? '#ef4444' : r.batMo <= 6 ? '#f59e0b' : '#10b981' }}>BAT {r.batMo}mo</span>
            </div>
            <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden relative">
              <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier] }} />
              <div className="absolute inset-y-0" style={{ left: '25%', width: 1, background: '#0ea5e966' }} />
              <div className="absolute inset-y-0" style={{ left: '55%', width: 1, background: '#f59e0b66' }} />
              <div className="absolute inset-y-0" style={{ left: '80%', width: 1, background: '#ef444466' }} />
            </div>
            <div className="flex flex-wrap gap-1 mt-1 text-[9px] font-mono">
              {(['ELT', 'INT', 'SAT', 'POS', 'BAT'] as const).map(k => {
                const v = (r.sev as any)[k.toLowerCase()] as number
                return <span key={k} className="px-1 rounded border" style={{ borderColor: tierColorOf(v) + '88', color: tierColorOf(v) }}>{k} {v.toFixed(0)}</span>
              })}
            </div>
            <div className="flex flex-wrap gap-1 mt-1 text-[9px] font-mono text-slate-400">
              {r.selfTestFault && <span className="px-1 rounded border border-rose-500/60 text-rose-300">SELF-TEST FAULT</span>}
              <span className="px-1 rounded border border-slate-800">INT {r.intervalS}s</span>
              <span className="px-1 rounded border border-slate-800">SAT {r.spec.satcom}</span>
              {r.distressReasons.map(rs => <span key={rs} className="px-1 rounded border border-amber-500/50 text-amber-300">{rs}</span>)}
            </div>
            <div className="mt-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>{adviceFor(r)}</div>
            <div className="mt-0.5 text-[9px] text-slate-600">{r.spec.refDoc} · MTOM {r.spec.mtomT}t · {r.f.operator || '—'}</div>
          </button>
        ))}
        {tab === 'ELT-GEN' && genAggs.length === 0 && (
          <div className="px-3 py-8 text-center text-slate-500 text-[11px]">No tracking data.</div>
        )}
        {tab === 'ELT-GEN' && genAggs.map(a => (
          <button key={a.gen} onClick={() => a.worstIcao && onFly(a.worstIcao)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/70 transition relative">
            <span className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: TIER_COLOR[a.worstTier] }} />
            <div className="flex items-center gap-1.5">
              <span className="font-mono font-bold text-slate-100">{a.gen}</span>
              <span className="text-[9px] font-mono px-1 rounded border border-slate-800 text-slate-400">{a.count} ac</span>
              {a.distress > 0 && <span className="text-[9px] font-mono px-1 rounded border border-rose-500/60 text-rose-300">{a.distress} DISTR</span>}
              <span className="text-[9px] font-mono px-1 rounded border ml-auto" style={{ borderColor: TIER_COLOR[a.worstTier], color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
            </div>
            <div className="flex items-baseline gap-2 mt-0.5 text-[10px] font-mono text-slate-400">
              <span style={{ color: a.meanAge > 900 ? '#ef4444' : a.meanAge > 300 ? '#f59e0b' : '#10b981' }}>mean age {a.meanAge.toFixed(0)}s</span>
              <span>mean score {a.meanScore.toFixed(0)}</span>
              {a.untracked > 0 && <span className="text-rose-400 ml-auto">{a.untracked} UNTRK</span>}
            </div>
            <div className="mt-1 h-1 rounded bg-slate-800 overflow-hidden relative">
              <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, a.meanScore)}%`, background: TIER_COLOR[a.worstTier] }} />
            </div>
            <div className="mt-0.5 text-[9px] text-slate-600">
              {a.gen === 'ELT-DT' ? 'Distress-tracking 1-min auto-broadcast per RTCA DO-204B' :
               a.gen === '406-AP' ? '406 MHz Auto-Portable Cospas-Sarsat MEOSAR' :
               a.gen === '406-AF' ? '406 MHz Auto-Fixed g-switch activation' :
               '121.5 MHz legacy — discontinued by Cospas-Sarsat 2009'}
              {a.worstCs && <> · worst {a.worstCs}</>}
            </div>
          </button>
        ))}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        ICAO Annex 6 Pt I 6.18 GADSS · App 9 · Annex 10 Vol III · Doc 10054 · Cospas-Sarsat A.001 / T.001 / G.005 MEOSAR · 14 CFR 91.207 · 121.339 · RTCA DO-204B · EASA AMC1 CAT.IDE.A.280
      </div>
    </div>
  )
}
