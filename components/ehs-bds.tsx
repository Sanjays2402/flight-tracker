'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   EHS / ELS · Mode-S Enhanced & Elementary Surveillance
   BDS Register Decode-Quality & Mandate Compliance Monitor
   -----------------------------------------------------------
   ICAO Annex 10 Vol IV ch 3 / Doc 9871 Technical Provisions for
   Mode-S Services / Eurocontrol Mode-S Specification SUR.ET1.ST05
   / Eurocontrol Surveillance Mode-S Enhanced Surveillance Cmd
   Spec / Commission Implementing Reg (EU) 1207/2011 + amending
   1028/2014 SPI / Reg (EU) 2017/386 ADS-B & Mode-S transponder
   carriage / FAA AC 90-114B / FAA Order JO 7110.65 / RTCA DO-181E
   Mode-S MOPS / DO-260B 1090 ES MOPS / EUROCAE ED-73E / ED-102B /
   ICAO Annex 11 / NAT Doc 008.

   ELS — Elementary Surveillance (mandated EU since Mar 2007):
     BDS 1,0  Data-link capability report
     BDS 1,7  Common-usage GICB capability report
     BDS 2,0  Aircraft identification (FLT-ID / callsign)
     BDS 3,0  ACAS active resolution advisory
     plus 24-bit Mode-S address + SI code subnet + flight-status

   EHS — Enhanced Surveillance (mandated EU IFR > 5,700 kg or
   > 250 KIAS since Mar 2009, ICAO Doc 9871 App A):
     BDS 4,0  Selected vertical intention (MCP/FCU sel-alt /
              baro setting / VNAV target / mode-bits)
     BDS 5,0  Track and turn report (roll / track-angle /
              ground-speed / TAR-rate / TAS)
     BDS 6,0  Heading and speed report (mag-hdg / IAS / Mach /
              VS-baro / VS-INS)

   This subsystem reconstructs per-airframe Mode-S link health:

     - Transponder generation (DO-181E / Ed.4 vs legacy DO-181D
       Ed.3 / DO-181C Ed.2) drives EHS register availability.
     - Per-class equipage probability (HVY 0.98 / NRW 0.92 /
       BIZ 0.85 / RGN 0.60 / TBP 0.20 / GA 0.05 / FTR 0.55).
     - Ground-radar visibility against catalogue of 32 SSR
       Mode-S interrogators (FAA STARS/ARTS-IIIE, NATS Watchman,
       DSNA THALES STAR-NG, DFS ASR-S, ENAV THALES, NAV CANADA
       Selex ATM-S, JCAB / CAAS / Airservices Australia).
     - Selective interrogation rate per Annex 10 4.3.3.3
       (4.5 s rotation, 16 inter-mode interrogations / rotation
       max per RTCA DO-185B), II/SI subnet 1-15 coordination.
     - Per-register decode-fail rate as fn(SNR, congestion,
       multipath, hash-stable equipage gap, TC ambiguity).
     - GICB common-usage capability bitmap deltas vs published
       MOPS Class A0/A1/A2/A3 requirements.
     - Mode-S SPI flag & flight-status field consistency.

   5 risk drivers feed a max-driver composite:

     EQUIP transponder generation / EHS-enabled flag
     ELS   missing ELS register (BDS 1,0 / 2,0 / 1,7)
     EHS   missing EHS register (BDS 4,0 / 5,0 / 6,0) in
           mandated EU airspace > FL245
     COVER ground-station visibility (interrogator count)
     BER   decode-fail % across required registers

   5 tiers:
     INOP        score>=80 OR EHS missing in mandate region
                 rose · "Mode-S EHS non-compliant Reg 1207/2011
                 file MOR · revert to procedural separation if
                 SSR-only · plan transponder MX next A-check"
     DEGRADED    score>=55 OR single-register chronic decode-fail
                 amber · "register stale > 60 s · request RA
                 downlink check / FCOM Vol II Mode-S diagnostic"
     WATCH       score>=25 sky · "monitor decode-fail per
                 Eurocontrol Reg-MS Spec 5.6 next sweep"
     OK          score<25 emerald · "all ELS+EHS registers fresh"
     IDLE        on-ground or outside MIN-FL slate

   MapLibre overlay:
     - tier-coloured halo rings sized 8-22 px by score
     - 32 ground interrogator station pins coloured by service
       (FAA emerald / EUROCONTROL sky / ASIA-PAC violet / OUT rose)
       sized by SSR Mode-S coverage radius (~200 nm primary)
     - dashed tier-coloured aircraft → best-interrogator lines
     - rose diamond INOP pin
     - tier-coloured callsign + ELS-OK + EHS-OK badges for non-OK

   Side panel:
     - 5-tier counter strip click-to-filter
     - 6-cell summary (TRACKED / EHS-EQUIPPED% / INOP / MEAN-BER /
       WORST / MEAN-COVER)
     - SVG decode-fail-% vs SNR scatter with rose >5% / amber
       2-5% / sky 1-2% / emerald <1% bands + dashed 1% & 5%
       Eurocontrol Reg-MS Spec thresholds
     - 7 sliders MIN-FL / MAX-FL / GEN-MIX / CONGEST / SI-COORD /
       INTERR-OUT / EU-MANDATE-FL
     - 7-class chip filter HVY NRW RGN BIZ TBP GA FTR
     - HALO / STN / LINK / LBL / DIAG toggles
     - AIRCRAFT / STATIONS / REGISTERS tabs
     - per-row score bar + 5-driver chips + 8-register grid
       (BDS 1,0 / 1,7 / 2,0 / 3,0 / 4,0 / 5,0 / 6,0 / DF17)
       coloured by freshness + tier-coloured advice click-to-fly

   Registered in Layers > Safety & Traffic.  ft-ehs persisted.
   ============================================================ */

export interface EhsFlight {
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
}

interface Props {
  map: maplibregl.Map | null
  flights: EhsFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'INOP' | 'DEGRADED' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  INOP: '#ef4444', DEGRADED: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['INOP', 'DEGRADED', 'WATCH', 'OK', 'IDLE']

type Driver = 'EQUIP' | 'ELS' | 'EHS' | 'COVER' | 'BER'
const DRIVER_LABEL: Record<Driver, string> = {
  EQUIP: 'XPDR-GEN', ELS: 'ELS-REG', EHS: 'EHS-REG', COVER: 'SSR-COVER', BER: 'DECODE-BER',
}

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}
function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'ga'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CRJ9|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS)/.test(x)) return 'fighter'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'turboprop'
  return 'narrow'
}

// EHS-capable equipage probability per class (Eurocontrol Mode-S Fleet Compliance Survey 2023)
const EQUIP_EHS: Record<Klass, number> = {
  heavy: 0.98, narrow: 0.92, regional: 0.60, biz: 0.85, turboprop: 0.20, ga: 0.05, fighter: 0.55,
}
// ELS is mandated almost universally above 5700kg / 250kts (EU 2009)
const EQUIP_ELS: Record<Klass, number> = {
  heavy: 0.99, narrow: 0.98, regional: 0.90, biz: 0.95, turboprop: 0.65, ga: 0.30, fighter: 0.80,
}

interface Station {
  id: string
  name: string
  lat: number
  lng: number
  network: 'FAA' | 'EUROCONTROL' | 'ASIA-PAC' | 'OCEANIC'
  vendor: string
  radiusNm: number    // primary Mode-S interrogation radius
  ii: number          // II code 1-15
}

// 32-station SSR Mode-S interrogator catalogue
const STATIONS: Station[] = [
  // FAA STARS / ARTS-IIIE
  { id: 'ZNY', name: 'New York ARTCC',    lat: 40.78, lng: -73.87, network: 'FAA',         vendor: 'Raytheon STARS',  radiusNm: 220, ii: 1 },
  { id: 'ZBW', name: 'Boston ARTCC',      lat: 42.49, lng: -71.29, network: 'FAA',         vendor: 'Raytheon STARS',  radiusNm: 200, ii: 2 },
  { id: 'ZTL', name: 'Atlanta ARTCC',     lat: 33.62, lng: -84.40, network: 'FAA',         vendor: 'Raytheon STARS',  radiusNm: 220, ii: 3 },
  { id: 'ZID', name: 'Indianapolis ARTCC',lat: 39.71, lng: -86.27, network: 'FAA',         vendor: 'Raytheon STARS',  radiusNm: 200, ii: 4 },
  { id: 'ZAU', name: 'Chicago ARTCC',     lat: 41.78, lng: -87.92, network: 'FAA',         vendor: 'Raytheon STARS',  radiusNm: 220, ii: 5 },
  { id: 'ZLA', name: 'Los Angeles ARTCC', lat: 33.94, lng: -118.40, network: 'FAA',        vendor: 'Raytheon STARS',  radiusNm: 220, ii: 6 },
  { id: 'ZOA', name: 'Oakland ARTCC',     lat: 37.62, lng: -122.38, network: 'FAA',        vendor: 'Raytheon STARS',  radiusNm: 200, ii: 7 },
  { id: 'ZDV', name: 'Denver ARTCC',      lat: 39.86, lng: -104.67, network: 'FAA',        vendor: 'Raytheon STARS',  radiusNm: 200, ii: 8 },
  { id: 'ZFW', name: 'Fort Worth ARTCC',  lat: 32.90, lng: -97.04, network: 'FAA',         vendor: 'Raytheon STARS',  radiusNm: 220, ii: 9 },
  { id: 'ZMA', name: 'Miami ARTCC',       lat: 25.79, lng: -80.29, network: 'FAA',         vendor: 'Raytheon STARS',  radiusNm: 220, ii: 10 },
  { id: 'ZSE', name: 'Seattle ARTCC',     lat: 47.45, lng: -122.31, network: 'FAA',        vendor: 'Raytheon STARS',  radiusNm: 200, ii: 11 },
  // EUROCONTROL
  { id: 'EGGW', name: 'NATS Heathrow',    lat: 51.47, lng: -0.45,  network: 'EUROCONTROL', vendor: 'NATS Watchman',   radiusNm: 200, ii: 1 },
  { id: 'LFPG', name: 'DSNA Paris CDG',   lat: 49.01, lng:  2.55,  network: 'EUROCONTROL', vendor: 'THALES STAR-NG',  radiusNm: 200, ii: 2 },
  { id: 'EDDF', name: 'DFS Frankfurt',    lat: 50.04, lng:  8.56,  network: 'EUROCONTROL', vendor: 'DFS ASR-S',       radiusNm: 200, ii: 3 },
  { id: 'EHAM', name: 'LVNL Amsterdam',   lat: 52.31, lng:  4.76,  network: 'EUROCONTROL', vendor: 'THALES RSM-NG',   radiusNm: 200, ii: 4 },
  { id: 'LEMD', name: 'ENAIRE Madrid',    lat: 40.47, lng: -3.56,  network: 'EUROCONTROL', vendor: 'INDRA IRS-20MP',  radiusNm: 200, ii: 5 },
  { id: 'LIRF', name: 'ENAV Rome',        lat: 41.80, lng: 12.25,  network: 'EUROCONTROL', vendor: 'THALES STAR-NG',  radiusNm: 200, ii: 6 },
  { id: 'LSZH', name: 'skyguide Zurich',  lat: 47.46, lng:  8.55,  network: 'EUROCONTROL', vendor: 'THALES RSM-970S', radiusNm: 200, ii: 7 },
  { id: 'EKCH', name: 'NAVIAIR Copen',    lat: 55.62, lng: 12.65,  network: 'EUROCONTROL', vendor: 'THALES RSM-NG',   radiusNm: 200, ii: 8 },
  { id: 'EFHK', name: 'Fintraffic Helsinki', lat: 60.32, lng: 24.96, network: 'EUROCONTROL', vendor: 'INDRA IRS-20MP',radiusNm: 200, ii: 9 },
  { id: 'LTBA', name: 'DHMI Istanbul',    lat: 41.27, lng: 28.74,  network: 'EUROCONTROL', vendor: 'THALES STAR-NG',  radiusNm: 200, ii: 10 },
  { id: 'EPWA', name: 'PANSA Warsaw',     lat: 52.16, lng: 20.97,  network: 'EUROCONTROL', vendor: 'THALES RSM-970S', radiusNm: 200, ii: 11 },
  // ASIA-PAC
  { id: 'RJTT', name: 'JCAB Tokyo HND',   lat: 35.55, lng: 139.78, network: 'ASIA-PAC',    vendor: 'TOSHIBA ARSR-4',  radiusNm: 220, ii: 1 },
  { id: 'RKSI', name: 'KAC Incheon',      lat: 37.46, lng: 126.44, network: 'ASIA-PAC',    vendor: 'THALES STAR-NG',  radiusNm: 200, ii: 2 },
  { id: 'WSSS', name: 'CAAS Singapore',   lat: 1.36,  lng: 103.99, network: 'ASIA-PAC',    vendor: 'INDRA IRS-20MP',  radiusNm: 200, ii: 3 },
  { id: 'ZBAA', name: 'CAAC Beijing PEK', lat: 40.08, lng: 116.58, network: 'ASIA-PAC',    vendor: 'NUCTECH SSR',     radiusNm: 200, ii: 4 },
  { id: 'YSSY', name: 'Airservices Syd',  lat: -33.94, lng: 151.18,network: 'ASIA-PAC',    vendor: 'THALES RSM-NG',   radiusNm: 200, ii: 5 },
  { id: 'VHHH', name: 'CAD Hong Kong',    lat: 22.31, lng: 113.92, network: 'ASIA-PAC',    vendor: 'RAYTHEON STARS',  radiusNm: 200, ii: 6 },
  { id: 'VABB', name: 'AAI Mumbai',       lat: 19.09, lng: 72.86,  network: 'ASIA-PAC',    vendor: 'BEL SSR-Mk-1',    radiusNm: 200, ii: 7 },
  { id: 'OMDB', name: 'GCAA Dubai',       lat: 25.25, lng: 55.36,  network: 'ASIA-PAC',    vendor: 'THALES STAR-NG',  radiusNm: 200, ii: 8 },
  // OCEANIC / CONTINENTAL CAN
  { id: 'CYYZ', name: 'NAV CANADA Tor',   lat: 43.68, lng: -79.63, network: 'OCEANIC',     vendor: 'SELEX ATM-S',     radiusNm: 200, ii: 1 },
  { id: 'CYVR', name: 'NAV CANADA Van',   lat: 49.19, lng: -123.18,network: 'OCEANIC',     vendor: 'SELEX ATM-S',     radiusNm: 200, ii: 2 },
]

const D2R = Math.PI / 180
const R_NM = 3440.065
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const f1 = la1 * D2R, f2 = la2 * D2R
  const df = (la2 - la1) * D2R, dl = (lo2 - lo1) * D2R
  const a = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
function hashFrac(s: string, salt: string): number {
  return (hash32(s + salt) % 10000) / 10000
}

// 8 tracked BDS registers
type BdsKey = 'BDS10' | 'BDS17' | 'BDS20' | 'BDS30' | 'BDS40' | 'BDS50' | 'BDS60' | 'DF17'
const BDS_LABEL: Record<BdsKey, string> = {
  BDS10: '1,0', BDS17: '1,7', BDS20: '2,0', BDS30: '3,0',
  BDS40: '4,0', BDS50: '5,0', BDS60: '6,0', DF17: 'DF17',
}
const BDS_KIND: Record<BdsKey, 'ELS' | 'EHS' | 'ES'> = {
  BDS10: 'ELS', BDS17: 'ELS', BDS20: 'ELS', BDS30: 'ELS',
  BDS40: 'EHS', BDS50: 'EHS', BDS60: 'EHS', DF17: 'ES',
}

interface Row {
  f: EhsFlight
  klass: Klass
  altFt: number
  fl: number
  inEuMandate: boolean
  xpdrGen: 'DO181E' | 'DO181D' | 'DO181C'  // ed.4 / ed.3 / ed.2
  elsCapable: boolean
  ehsCapable: boolean
  bdsAgeSec: Record<BdsKey, number>   // age in seconds since last successful decode
  bdsOk: Record<BdsKey, boolean>      // currently fresh (<60s)
  visibleStations: { s: Station, distNm: number, snrDb: number }[]
  visibleCount: number
  bestStation: Station | null
  bestSnrDb: number
  decodeBerPct: number
  scoreEquip: number
  scoreEls: number
  scoreEhs: number
  scoreCover: number
  scoreBer: number
  score: number
  topDriver: Driver
  tier: Tier
}

const SRC_RING = 'ehs-ring', SRC_STN = 'ehs-stn', SRC_LINE = 'ehs-line', SRC_LBL = 'ehs-lbl', SRC_STNLBL = 'ehs-stnlbl', SRC_PIN = 'ehs-pin'
const LYR_RING = 'ehs-ring-l', LYR_STN = 'ehs-stn-l', LYR_LINE = 'ehs-line-l', LYR_LBL = 'ehs-lbl-l', LYR_STNLBL = 'ehs-stnlbl-l', LYR_PIN = 'ehs-pin-l'

// Mode-S radio horizon (1090 MHz line-of-sight ~ 1.23 * sqrt(h_ac_ft) + horizon_st)
function radarHorizonNm(altFt: number, stHft: number = 100): number {
  return 1.23 * (Math.sqrt(Math.max(0, altFt)) + Math.sqrt(stHft))
}
// Friis path SNR estimate at 1090 MHz, Tx +51 dBm xpdr, 8 dBi rx, -100 dBm floor
function snr1090(distNm: number): number {
  if (distNm <= 0) return 60
  // free space loss (dB) at 1090 MHz over distNm (nm -> km)
  const dKm = distNm * 1.852
  const fspl = 32.45 + 20 * Math.log10(1090) + 20 * Math.log10(Math.max(0.001, dKm))
  const rxDbm = 51 + 8 - fspl  // tx+ant - fspl
  return rxDbm - (-100)        // margin above floor
}

function tierColor(score: number): string {
  if (score >= 80) return '#ef4444'
  if (score >= 55) return '#f59e0b'
  if (score >= 25) return '#0ea5e9'
  return '#10b981'
}

// Is aircraft inside the EU Mode-S EHS mandate footprint?
// Approximate ECAC: lon -25..40, lat 30..72
function inEuMandate(lat: number, lng: number): boolean {
  return lng >= -25 && lng <= 40 && lat >= 30 && lat <= 72
}

export default function EhsBds({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'STATIONS' | 'REGISTERS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(500)
  const [genMix, setGenMix] = useState(100)       // % DO-181E fleet share modulator
  const [congest, setCongest] = useState(40)
  const [siCoord, setSiCoord] = useState(80)      // SI code coordination %
  const [interrOut, setInterrOut] = useState(3)   // % stations down
  const [mandateFl, setMandateFl] = useState(245) // EU mandate above this FL
  const [showRing, setShowRing] = useState(true)
  const [showStn, setShowStn] = useState(true)
  const [showLine, setShowLine] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  // Station outage state hash-stable per slider bucket
  const stationOutage = useMemo(() => {
    const m: Record<string, boolean> = {}
    const bucket = Math.floor(interrOut / 2)
    for (const s of STATIONS) {
      m[s.id] = hashFrac(s.id + bucket, 'iout') < (interrOut / 100)
    }
    return m
  }, [interrOut])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || !isFinite(f.lat) || !isFinite(f.lng)) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl || fl > maxFl) continue
      const klass = classify(f.type, f.category)

      // Transponder generation (DO-181 edition) hash-stable, biased by genMix slider
      const genRoll = hashFrac(f.icao, 'xpdrgen')
      const eShare = 0.30 + 0.55 * (genMix / 100)   // DO-181E share
      const dShare = 0.20 + 0.10 * (1 - genMix / 100) // DO-181D share
      const xpdrGen: Row['xpdrGen'] =
        genRoll < eShare ? 'DO181E'
        : genRoll < eShare + dShare ? 'DO181D'
        : 'DO181C'

      // Equipage rolls
      const elsRoll = hashFrac(f.icao, 'els')
      const ehsRoll = hashFrac(f.icao, 'ehs')
      const elsCapable = elsRoll < EQUIP_ELS[klass]
      // EHS requires Ed.4 OR Ed.3 with EHS option; Ed.2 cannot do EHS
      const ehsCapable = xpdrGen !== 'DO181C' && ehsRoll < EQUIP_EHS[klass]

      // Visible interrogators
      const horizon = radarHorizonNm(f.altitudeFt)
      const vis: { s: Station, distNm: number, snrDb: number }[] = []
      for (const s of STATIONS) {
        if (stationOutage[s.id]) continue
        const d = gcDistNm(f.lat, f.lng, s.lat, s.lng)
        if (d > Math.min(horizon, s.radiusNm)) continue
        const snr = snr1090(d) - (congest * 0.08) - (1 - siCoord / 100) * 6
        vis.push({ s, distNm: d, snrDb: snr })
      }
      vis.sort((a, b) => b.snrDb - a.snrDb)
      const visibleCount = vis.length
      const bestStation = vis[0]?.s || null
      const bestSnrDb = vis[0]?.snrDb ?? -30

      // Per-register decode-fail rate: function of SNR, congestion, equipage
      const baseBer = visibleCount === 0 ? 100
        : bestSnrDb >= 20 ? 0.3
        : bestSnrDb >= 10 ? 1.2
        : bestSnrDb >= 5  ? 3.5
        : bestSnrDb >= 0  ? 8.0
        : 20.0
      const congestPenalty = congest * 0.04
      const decodeBerPct = Math.max(0, Math.min(100, baseBer + congestPenalty))

      // Per-register freshness: derive an age in seconds based on:
      //  - whether register is supported (uncapable → "STALE" age 999)
      //  - poll rotation 4.5 s baseline
      //  - per-register fail probability scaled by ber
      const ages: Record<BdsKey, number> = {} as any
      const oks: Record<BdsKey, boolean> = {} as any
      const allBds: BdsKey[] = ['BDS10', 'BDS17', 'BDS20', 'BDS30', 'BDS40', 'BDS50', 'BDS60', 'DF17']
      for (const k of allBds) {
        const kind = BDS_KIND[k]
        const supported =
          (kind === 'ELS' && elsCapable) ||
          (kind === 'EHS' && ehsCapable) ||
          (kind === 'ES'  && (xpdrGen !== 'DO181C') && hashFrac(f.icao, 'es') < 0.92)
        if (!supported) { ages[k] = 999; oks[k] = false; continue }
        if (visibleCount === 0) { ages[k] = 999; oks[k] = false; continue }
        // pseudo-poll age: rotation 4.5 s × (1 + ber%/10) × per-reg hash variation
        const variance = 0.5 + hashFrac(f.icao + k, 'age') * 1.5
        const age = 4.5 * variance * (1 + decodeBerPct / 10)
        ages[k] = age
        oks[k] = age < 60
      }

      // Equip score: xpdr generation gap
      const scoreEquip = xpdrGen === 'DO181E' ? 0 : xpdrGen === 'DO181D' ? 20 : 60
      // ELS score: count of missing ELS registers (1,0 / 1,7 / 2,0)
      const elsMissing = (!oks.BDS10 ? 1 : 0) + (!oks.BDS17 ? 1 : 0) + (!oks.BDS20 ? 1 : 0)
      const scoreEls = !elsCapable ? 100 : (elsMissing >= 3 ? 90 : elsMissing * 30)
      // EHS score: missing in mandate region is catastrophic
      const inMandate = inEuMandate(f.lat, f.lng) && fl >= mandateFl
      const ehsMissing = (!oks.BDS40 ? 1 : 0) + (!oks.BDS50 ? 1 : 0) + (!oks.BDS60 ? 1 : 0)
      const scoreEhs = inMandate
        ? (!ehsCapable ? 100 : ehsMissing >= 3 ? 95 : ehsMissing * 35)
        : (!ehsCapable ? 30 : ehsMissing * 15)
      // Cover score: visible interrogator count
      const scoreCover = visibleCount === 0 ? 100
        : visibleCount === 1 ? 60
        : visibleCount === 2 ? 30
        : visibleCount === 3 ? 12
        : 0
      // BER score
      const scoreBer = decodeBerPct >= 10 ? 100
        : decodeBerPct >= 5 ? 75
        : decodeBerPct >= 2 ? 45
        : decodeBerPct >= 1 ? 20
        : 0

      const drivers: { d: Driver, v: number }[] = [
        { d: 'EQUIP', v: scoreEquip }, { d: 'ELS', v: scoreEls },
        { d: 'EHS', v: scoreEhs }, { d: 'COVER', v: scoreCover }, { d: 'BER', v: scoreBer },
      ]
      drivers.sort((a, b) => b.v - a.v)
      const score = Math.max(0, Math.min(100, drivers[0].v))
      const topDriver = drivers[0].d

      let tier: Tier
      if (inMandate && (!ehsCapable || ehsMissing >= 2)) tier = 'INOP'
      else if (score >= 80) tier = 'INOP'
      else if (score >= 55) tier = 'DEGRADED'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, klass, altFt: f.altitudeFt, fl, inEuMandate: inMandate,
        xpdrGen, elsCapable, ehsCapable,
        bdsAgeSec: ages, bdsOk: oks,
        visibleStations: vis.slice(0, 6),
        visibleCount, bestStation, bestSnrDb, decodeBerPct,
        scoreEquip, scoreEls, scoreEhs, scoreCover, scoreBer,
        score, topDriver, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return b.score - a.score
    })
    return out
  }, [flights, minFl, maxFl, genMix, congest, siCoord, mandateFl, stationOutage])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { INOP: 0, DEGRADED: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let inop = 0, ehsEquipped = 0, sumBer = 0, sumCover = 0, worstScore = -1, worstCs = '', worstDrv: Driver = 'EQUIP'
    let mandateAc = 0, mandateInop = 0
    for (const r of rows) {
      if (r.tier === 'INOP') inop++
      if (r.ehsCapable) ehsEquipped++
      sumBer += r.decodeBerPct
      sumCover += r.visibleCount
      if (r.inEuMandate) {
        mandateAc++
        if (r.tier === 'INOP' || r.tier === 'DEGRADED') mandateInop++
      }
      if (r.score > worstScore) { worstScore = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstDrv = r.topDriver }
    }
    return {
      total: rows.length, inop, ehsPct: rows.length ? (ehsEquipped / rows.length) * 100 : 0,
      meanBer: rows.length ? sumBer / rows.length : 0,
      meanCover: rows.length ? sumCover / rows.length : 0,
      worstCs, worstDrv, mandateAc, mandateInop,
      outageCount: Object.values(stationOutage).filter(Boolean).length,
    }
  }, [rows, stationOutage])

  // station rollup
  const stationStats = useMemo(() => {
    type SE = { s: Station, acCount: number, meanSnr: number, snrN: number, worstScore: number, outage: boolean }
    const m = new Map<string, SE>()
    for (const s of STATIONS) m.set(s.id, { s, acCount: 0, meanSnr: 0, snrN: 0, worstScore: 0, outage: stationOutage[s.id] })
    for (const r of rows) {
      for (const v of r.visibleStations) {
        const e = m.get(v.s.id); if (!e) continue
        e.acCount++
        e.meanSnr += v.snrDb; e.snrN++
        if (r.score > e.worstScore) e.worstScore = r.score
      }
    }
    const arr = Array.from(m.values())
    for (const e of arr) if (e.snrN > 0) e.meanSnr /= e.snrN
    arr.sort((a, b) => (b.outage ? 1 : 0) - (a.outage ? 1 : 0) || b.acCount - a.acCount)
    return arr
  }, [rows, stationOutage])

  // registers rollup
  const registerStats = useMemo(() => {
    const allBds: BdsKey[] = ['BDS10', 'BDS17', 'BDS20', 'BDS30', 'BDS40', 'BDS50', 'BDS60', 'DF17']
    return allBds.map(k => {
      let ok = 0, stale = 0, total = 0, sumAge = 0
      for (const r of rows) {
        total++
        if (r.bdsOk[k]) ok++
        else stale++
        if (isFinite(r.bdsAgeSec[k])) sumAge += Math.min(120, r.bdsAgeSec[k])
      }
      return { key: k, label: BDS_LABEL[k], kind: BDS_KIND[k], ok, stale, total, meanAge: total ? sumAge / total : 0 }
    })
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.topDriver, r.xpdrGen,
        ...r.visibleStations.slice(0, 3).map(v => v.s.id)].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  const filteredStations = useMemo(() => {
    const q = query.trim().toUpperCase()
    return stationStats.filter(e => !q || [e.s.id, e.s.name, e.s.network, e.s.vendor].some(s => (s || '').toUpperCase().includes(q)))
  }, [stationStats, query])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + (r.score / 100) * 14 },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const stnFc = { type: 'FeatureCollection' as const, features: showStn ? STATIONS.map(s => {
      const out = stationOutage[s.id]
      const color = out ? '#ef4444'
        : s.network === 'FAA' ? '#10b981'
        : s.network === 'EUROCONTROL' ? '#0ea5e9'
        : s.network === 'ASIA-PAC' ? '#8b5cf6'
        : '#f59e0b'
      return {
        type: 'Feature' as const,
        properties: { color, radius: 5 },
        geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
      }
    }) : [] }
    const stnLblFc = { type: 'FeatureCollection' as const, features: showStn ? STATIONS.map(s => {
      const out = stationOutage[s.id]
      const color = out ? '#fda4af' : '#cbd5e1'
      return {
        type: 'Feature' as const,
        properties: { color, text: out ? `${s.id} !OUT` : s.id },
        geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
      }
    }) : [] }
    const lineFc = { type: 'FeatureCollection' as const, features: showLine ? rows.filter(r => r.tier !== 'OK' && r.bestStation).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.bestStation!.lng, r.bestStation!.lat]] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'OK').map(r => {
      const ehsTxt = r.ehsCapable ? `EHS${r.scoreEhs.toFixed(0)}` : 'NO-EHS'
      const elsTxt = r.elsCapable ? `ELS${r.scoreEls.toFixed(0)}` : 'NO-ELS'
      return {
        type: 'Feature' as const,
        properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${elsTxt}/${ehsTxt}` },
        geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      }
    }) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showRing ? rows.filter(r => r.tier === 'INOP').map(r => ({
      type: 'Feature' as const,
      properties: { color: '#ef4444' },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_LINE, lineFc, () => map.addLayer({ id: LYR_LINE, type: 'line', source: SRC_LINE, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.1, 'line-opacity': 0.55, 'line-dasharray': [3, 3],
      } }))
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'circle', source: SRC_RING, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.6, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': '◆', 'text-size': 14, 'text-allow-overlap': true,
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.5 } }))
      ensure(SRC_STN, stnFc, () => map.addLayer({ id: LYR_STN, type: 'circle', source: SRC_STN, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.85,
        'circle-stroke-color': '#020617', 'circle-stroke-width': 1.2,
      } }))
      ensure(SRC_STNLBL, stnLblFc, () => map.addLayer({ id: LYR_STNLBL, type: 'symbol', source: SRC_STNLBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 9, 'text-offset': [0, 1.3], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_STNLBL, LYR_STN, LYR_PIN, LYR_RING, LYR_LINE]) {
        try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {}
      }
      for (const src of [SRC_LBL, SRC_STNLBL, SRC_STN, SRC_PIN, SRC_RING, SRC_LINE]) {
        try { if (map.getSource(src)) map.removeSource(src) } catch {}
      }
    }
  }, [map, rows, stationOutage, showRing, showStn, showLine, showLabels])

  // Diagram: x = best-SNR -10..+40 dB, y = decode-BER% 0..15
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD_L = 26, PAD_B = 22
    const xs = (snr: number) => PAD_L + (Math.max(-10, Math.min(40, snr)) + 10) / 50 * (W - PAD_L - 8)
    const ys = (b: number) => 6 + (Math.max(0, Math.min(15, b)) / 15) * (H - PAD_B - 8)
    return { W, H, PAD_L, PAD_B, xs, ys }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">EHS / ELS · Mode-S BDS</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} ac · {STATIONS.length} ssr</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Tracked</div>
          <div className="font-mono text-sm text-slate-100">{summary.total}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">EHS-equip</div>
          <div className="font-mono text-sm" style={{ color: summary.ehsPct >= 90 ? '#10b981' : summary.ehsPct >= 75 ? '#0ea5e9' : summary.ehsPct >= 50 ? '#f59e0b' : '#ef4444' }}>{summary.ehsPct.toFixed(0)}%</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">INOP</div>
          <div className="font-mono text-sm" style={{ color: summary.inop > 0 ? '#ef4444' : '#10b981' }}>{summary.inop}</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">μ BER</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanBer <= 1 ? '#10b981' : summary.meanBer <= 2 ? '#0ea5e9' : summary.meanBer <= 5 ? '#f59e0b' : '#ef4444' }}>{summary.meanBer.toFixed(1)}%</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">μ Cover</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanCover >= 3 ? '#10b981' : summary.meanCover >= 2 ? '#0ea5e9' : summary.meanCover >= 1 ? '#f59e0b' : '#ef4444' }}>{summary.meanCover.toFixed(1)}</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[10px] text-slate-200 truncate" title={summary.worstCs}>{summary.worstCs ? `${summary.worstCs} ${summary.worstDrv}` : '—'}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">EU-mandate</div>
          <div className="font-mono text-[11px]" style={{ color: summary.mandateInop > 0 ? '#ef4444' : '#10b981' }}>{summary.mandateInop}/{summary.mandateAc} non-comp</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">SSR Outage</div>
          <div className="font-mono text-[11px]" style={{ color: summary.outageCount > 0 ? '#ef4444' : '#10b981' }}>{summary.outageCount}/{STATIONS.length}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Decode-BER % vs best-SNR dB · Reg-MS Spec 1% / 5% thresholds</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD_L} y1={diag.H - diag.PAD_B} x2={diag.W - 6} y2={diag.H - diag.PAD_B} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD_L} y1={6} x2={diag.PAD_L} y2={diag.H - diag.PAD_B} stroke="#334155" strokeWidth={1} />
            {/* tier bands: BER >5% rose, 2-5 amber, 1-2 sky, <1 emerald */}
            <rect x={diag.PAD_L} y={diag.ys(5)} width={diag.W - diag.PAD_L - 6} height={diag.ys(15) - diag.ys(5)} fill="#ef4444" opacity={0.07} />
            <rect x={diag.PAD_L} y={diag.ys(2)} width={diag.W - diag.PAD_L - 6} height={diag.ys(5) - diag.ys(2)} fill="#f59e0b" opacity={0.07} />
            <rect x={diag.PAD_L} y={diag.ys(1)} width={diag.W - diag.PAD_L - 6} height={diag.ys(2) - diag.ys(1)} fill="#0ea5e9" opacity={0.07} />
            <rect x={diag.PAD_L} y={6} width={diag.W - diag.PAD_L - 6} height={diag.ys(1) - 6} fill="#10b981" opacity={0.07} />
            {/* threshold dashed lines */}
            <line x1={diag.PAD_L} y1={diag.ys(1)} x2={diag.W - 6} y2={diag.ys(1)} stroke="#0ea5e9" strokeDasharray="2 3" opacity={0.7} />
            <line x1={diag.PAD_L} y1={diag.ys(5)} x2={diag.W - 6} y2={diag.ys(5)} stroke="#ef4444" strokeDasharray="2 3" opacity={0.7} />
            <text x={diag.W - 8} y={diag.ys(1) - 2} textAnchor="end" fontSize={8} fill="#0ea5e9" fontFamily="monospace">1% spec</text>
            <text x={diag.W - 8} y={diag.ys(5) - 2} textAnchor="end" fontSize={8} fill="#ef4444" fontFamily="monospace">5% deficient</text>
            {/* y labels */}
            {[0, 2, 5, 10, 15].map(y => (
              <text key={y} x={diag.PAD_L - 2} y={diag.ys(y) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{y}</text>
            ))}
            {/* x labels */}
            {[-10, 0, 10, 20, 30, 40].map(x => (
              <text key={x} x={diag.xs(x)} y={diag.H - diag.PAD_B + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{x}</text>
            ))}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(r.bestSnrDb)} cy={diag.ys(r.decodeBerPct)} r={2.5} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={50} max={500} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>XPDR-GEN</span><span className="font-mono text-slate-300">{genMix}%</span></div>
            <input type="range" min={0} max={150} step={5} value={genMix} onChange={e => setGenMix(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CONGEST</span><span className="font-mono text-slate-300">{congest}%</span></div>
            <input type="range" min={0} max={100} step={5} value={congest} onChange={e => setCongest(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>SI-COORD</span><span className="font-mono text-slate-300">{siCoord}%</span></div>
            <input type="range" min={20} max={100} step={5} value={siCoord} onChange={e => setSiCoord(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>SSR-OUT</span><span className="font-mono text-slate-300">{interrOut}%</span></div>
            <input type="range" min={0} max={20} step={1} value={interrOut} onChange={e => setInterrOut(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div className="col-span-2">
            <div className="flex justify-between text-[10px] text-slate-500"><span>EU-MANDATE-FL</span><span className="font-mono text-slate-300">FL{mandateFl}</span></div>
            <input type="range" min={100} max={410} step={5} value={mandateFl} onChange={e => setMandateFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klassFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['heavy', 'narrow', 'regional', 'biz', 'turboprop', 'ga', 'fighter'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klassFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{KLASS_LABEL[k]}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRing} onChange={e => setShowRing(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showStn} onChange={e => setShowStn(e.target.checked)} className="accent-sky-500" /><span>SSR</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLine} onChange={e => setShowLine(e.target.checked)} className="accent-sky-500" /><span>LINK</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao / station / vendor"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'STATIONS', 'REGISTERS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length}` : tab === 'STATIONS' ? `${filteredStations.length} SSR` : `${registerStats.length} registers`}</span>
        <span>{tab === 'AIRCRAFT' ? 'score · driver · BDS freshness' : tab === 'STATIONS' ? 'network · ac · μSNR' : 'kind · ok/stale · μage'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const advice = r.tier === 'INOP'
            ? (r.inEuMandate
                ? 'Mode-S EHS non-comp Reg (EU) 1207/2011 · file MOR · revert procedural sep · MX next A-check'
                : 'transponder INOP · file MEL deferral · ATC procedural separation only')
            : r.tier === 'DEGRADED' ? `register stale > 60 s · request RA downlink check · ${DRIVER_LABEL[r.topDriver]} dominant`
            : r.tier === 'WATCH' ? `monitor decode-fail per Eurocontrol Reg-MS Spec 5.6 next sweep · ${DRIVER_LABEL[r.topDriver]}`
            : `all ELS+EHS registers fresh · best ${r.bestStation?.id || '—'} ${r.bestSnrDb.toFixed(0)}dB`
          const allBds: BdsKey[] = ['BDS10', 'BDS17', 'BDS20', 'BDS30', 'BDS40', 'BDS50', 'BDS60', 'DF17']
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{KLASS_LABEL[r.klass]}</span>
                  <span className="text-[9px] px-1 rounded font-mono" style={{ background: r.xpdrGen === 'DO181E' ? '#10b98122' : r.xpdrGen === 'DO181D' ? '#0ea5e922' : '#ef444422', color: r.xpdrGen === 'DO181E' ? '#10b981' : r.xpdrGen === 'DO181D' ? '#0ea5e9' : '#ef4444' }}>{r.xpdrGen.replace('DO181', 'Ed.').replace('Ed.E', 'Ed.4').replace('Ed.D', 'Ed.3').replace('Ed.C', 'Ed.2')}</span>
                  {!r.ehsCapable && <span className="text-[9px] px-1 rounded bg-slate-800 text-slate-400 font-mono">NO-EHS</span>}
                  {r.inEuMandate && <span className="text-[9px] px-1 rounded bg-sky-500/15 text-sky-300 font-mono">EU-MD</span>}
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="flight level">F{Math.round(r.fl)}</span>
                  <span title="visible SSR">SSR{r.visibleCount}</span>
                  <span title="best SNR" style={{ color: r.bestSnrDb >= 20 ? '#10b981' : r.bestSnrDb >= 10 ? '#0ea5e9' : r.bestSnrDb >= 0 ? '#f59e0b' : '#ef4444' }}>{r.bestSnrDb.toFixed(0)}dB</span>
                  <span title="decode-BER" style={{ color: r.decodeBerPct <= 1 ? '#10b981' : r.decodeBerPct <= 2 ? '#0ea5e9' : r.decodeBerPct <= 5 ? '#f59e0b' : '#ef4444' }}>{r.decodeBerPct.toFixed(1)}%BER</span>
                  <span className="ml-auto" title="best">{r.bestStation?.id || '—'}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0" style={{ left: '25%', width: '1px', background: '#0ea5e9', opacity: 0.5 }} />
                  <div className="absolute inset-y-0" style={{ left: '55%', width: '1px', background: '#f59e0b', opacity: 0.5 }} />
                  <div className="absolute inset-y-0" style={{ left: '80%', width: '1px', background: '#ef4444', opacity: 0.5 }} />
                </div>
                <div className="grid grid-cols-5 gap-0.5 mt-1">
                  {([['EQUIP', r.scoreEquip], ['ELS', r.scoreEls], ['EHS', r.scoreEhs], ['COVER', r.scoreCover], ['BER', r.scoreBer]] as [string, number][]).map(([lbl, v]) => (
                    <div key={lbl} className="text-[8px] font-mono text-center py-0.5 rounded" style={{ background: tierColor(v) + '22', color: tierColor(v) }} title={`${lbl} score ${v.toFixed(0)}`}>
                      {lbl}{v.toFixed(0)}
                    </div>
                  ))}
                </div>
                {/* 8-register freshness grid */}
                <div className="mt-1 grid grid-cols-8 gap-0.5" title="BDS register freshness · green <60s · slate stale">
                  {allBds.map(k => {
                    const age = r.bdsAgeSec[k]
                    const ok = r.bdsOk[k]
                    const kind = BDS_KIND[k]
                    const c = !ok ? '#475569'
                      : age < 10 ? '#10b981'
                      : age < 30 ? '#0ea5e9'
                      : '#f59e0b'
                    return (
                      <div key={k} className="h-3 rounded relative overflow-hidden flex items-center justify-center"
                        style={{ background: c + '33', border: `1px solid ${c}66` }}
                        title={`BDS ${BDS_LABEL[k]} (${kind}) · ${ok ? `age ${age.toFixed(1)}s` : 'STALE'}`}>
                        <span className="text-[7px] font-mono leading-none" style={{ color: c }}>{BDS_LABEL[k]}</span>
                      </div>
                    )
                  })}
                </div>
                <div className="text-[10px] font-mono mt-0.5 truncate" title="advice" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</div>
              </div>
            </button>
          )
        })}

        {tab === 'STATIONS' && filteredStations.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No stations match.</div>
        )}
        {tab === 'STATIONS' && filteredStations.map(e => {
          const color = e.outage ? '#ef4444'
            : e.s.network === 'FAA' ? '#10b981'
            : e.s.network === 'EUROCONTROL' ? '#0ea5e9'
            : e.s.network === 'ASIA-PAC' ? '#8b5cf6'
            : '#f59e0b'
          return (
            <div key={e.s.id} className="w-full text-left px-3 py-2 border-b border-slate-900 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: color }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold" style={{ color }}>{e.s.id}</span>
                  <span className="text-slate-300 truncate">{e.s.name}</span>
                  <span className="ml-auto text-[9px] px-1 rounded font-mono" style={{ background: color + '22', color }}>{e.s.network}</span>
                  {e.outage && <span className="text-[9px] font-mono px-1 rounded bg-rose-500/20 text-rose-300">!OUT</span>}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="vendor" className="truncate max-w-[40%]">{e.s.vendor}</span>
                  <span title="II code">II-{e.s.ii}</span>
                  <span title="radius">{e.s.radiusNm}nm</span>
                  <span title="reachable aircraft">ac{e.acCount}</span>
                  <span className="ml-auto" style={{ color: e.meanSnr >= 20 ? '#10b981' : e.meanSnr >= 10 ? '#0ea5e9' : e.meanSnr >= 0 ? '#f59e0b' : '#ef4444' }}>μ{e.meanSnr.toFixed(0)}dB</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="aircraft load (relative)">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, e.acCount * 8)}%`, background: color, opacity: 0.85 }} />
                </div>
              </div>
            </div>
          )
        })}

        {tab === 'REGISTERS' && registerStats.map(rs => {
          const compliancePct = rs.total ? (rs.ok / rs.total) * 100 : 0
          const c = compliancePct >= 90 ? '#10b981' : compliancePct >= 75 ? '#0ea5e9' : compliancePct >= 50 ? '#f59e0b' : '#ef4444'
          const kindColor = rs.kind === 'ELS' ? '#0ea5e9' : rs.kind === 'EHS' ? '#8b5cf6' : '#10b981'
          return (
            <div key={rs.key} className="w-full text-left px-3 py-2 border-b border-slate-900 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: c }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold text-slate-100">BDS {rs.label}</span>
                  <span className="text-[9px] px-1 rounded font-mono" style={{ background: kindColor + '22', color: kindColor }}>{rs.kind}</span>
                  <span className="ml-auto font-mono text-[10px] text-slate-400">{rs.ok}/{rs.total} ok</span>
                  <span className="font-mono text-[10px]" style={{ color: c }}>{compliancePct.toFixed(0)}%</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${compliancePct}%`, background: c, opacity: 0.85 }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="mean age across fleet">μage {rs.meanAge.toFixed(1)}s</span>
                  <span title="stale count" style={{ color: rs.stale > 0 ? '#f59e0b' : '#10b981' }}>stale {rs.stale}</span>
                  <span className="ml-auto text-slate-600 truncate">
                    {rs.key === 'BDS10' && 'Data-link capability'}
                    {rs.key === 'BDS17' && 'GICB capability'}
                    {rs.key === 'BDS20' && 'Aircraft ID / FLT-ID'}
                    {rs.key === 'BDS30' && 'ACAS RA report'}
                    {rs.key === 'BDS40' && 'Selected vertical intent'}
                    {rs.key === 'BDS50' && 'Track & turn report'}
                    {rs.key === 'BDS60' && 'Heading & speed report'}
                    {rs.key === 'DF17' && '1090 ES extended squitter'}
                  </span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
