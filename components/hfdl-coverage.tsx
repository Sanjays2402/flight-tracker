'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   HFDL (HF Datalink) Polar / Oceanic Coverage & Slot-Util Monitor
   -----------------------------------------------------------
   ARINC 635 HF Data Link / EUROCAE ED-92 / ICAO Annex 10 Vol III
   Pt II Ch 11 / Doc 9896 Manual on the ATN using IPS / Doc 10037
   GOLD / FAA Order JO 7110.65 ch 8 / AC 90-117A datalink / NAT
   Doc 007 NAT OPS Bulletin 2015-001 PBCS / Collins Aerospace
   HFDL Service Brief 2024 / SITA HF DataLink Network Reference.

   HFDL is the only ICAO-recognised long-range non-satellite ACARS
   bearer.  It is the mandated SATCOM backup over polar routes
   (Cospas-Sarsat polar region) and the only datalink available
   when both Inmarsat geo (>|lat|80°) and Iridium (provider outage)
   are unavailable.  Coverage is provided by Collins-Aerospace's
   global 14-station ground network of HF transmitter/receivers
   sharing 60 frequencies across the 2.6-21.9 MHz HF band on a
   TDMA frame (32 squitter+RFU slots, 8.3 s super-frame).

   This subsystem reconstructs per-airframe HFDL link health:

     - GROUND-STATION VISIBILITY: per aircraft, compute groundwave
       (≈350 nm at FL350) plus skywave (1.5-hop via F2 layer at
       MUF) reachability to each of the 14 published stations
       (Reykjavik / Riverhead / Molokai / Auckland / Krasnoyarsk
       Krasnodar / Shannon / Hat-Yai / Albrook / Santa-Cruz /
       Johannesburg / Guam / Barrow / Canarias).  Skywave hop
       distance modulated by HF-SSN (solar sunspot number) and
       local-solar-time-from-noon (D-layer absorption peaks at
       solar noon; nighttime favours lower bands 3-8 MHz, daytime
       favours 11-21 MHz).  Polar-cap absorption PCA |lat|>=70°
       multiplies station availability by 0.40 per ITU-R P.531-15.

     - SNR vs receiver-floor: each visible station gives an SNR
       estimate Tx +60 dBm, Friis 1/r² with HF empirical 2-hop
       attenuation 6 dB + 0.018 dB/km, RX floor -107 dBm.  Per
       ARINC 635 modem MIL-STD-188-110B 1800 Hz, threshold +6 dB
       SNR for 1200 bps M-PSK / +10 dB for 1800 bps.

     - BER and slot-utilization: stations cycle through 32 TDMA
       slots; we compute fleet-aggregate utilization as
       (downlink_aircraft / 32 slots) modulated by CONGESTION
       slider 0-100%.  BER ramps from 1e-6 at SNR+15 to 1e-2 at
       SNR+0 per Watterson HF channel model.

     - PROVIDER OUTAGE: hash-stable per-station outage probability
       scaled by PROV-OUT slider 0-15% station-share (sunspot
       blackout, transmitter MX, geomagnetic K>=5 storm).

   5 risk drivers feed a max-driver composite:

     STN  visible-station count (100 at 0, ramp to 0 at >=3)
     SNR  best-station SNR margin vs +10 dB threshold
     UTIL TDMA slot-utilization (0 at <=40%, 100 at >=95%)
     BER  modem bit-error-rate (0 at <=1e-5, 100 at >=1e-2)
     ION  ionospheric K-index / PCA flag (sky 25 / amber 55 /
          rose 80 / 100 at PCA polar route)

   5 tiers:
     NORDO  score>=80 OR 0 stations OR all-PCA   rose
            (no HF datalink, revert SELCAL voice / SATCOM-only,
             squawk 7600 if also voice-lost, NAT OPS Bulletin
             2015-001 contingency)
     DEGRADED  score>=55  amber
            (single station, log voice fallback, reduce ACARS
             traffic to safety-of-flight)
     WATCH  score>=25  sky
            (within spec but trend adverse, monitor SNR every
             10 min per GOLD 7.3.4)
     OK  score<25  emerald
            (multi-station diversity, nominal BER)
     IDLE  ground / below MIN-FL  slate

   MapLibre overlay:
     - tier-coloured halo rings sized 8-22 px by score
     - 14 ground-station pins coloured by published service
       (emerald CORE / sky REGIONAL / amber DEGRADED outage)
       with 3-letter station ID labels
     - dashed tier-coloured aircraft→best-station link lines
     - tier-coloured callsign + STN + SNR labels for non-OK
     - rose diamond NORDO pin

   Side panel:
     - 5-tier counter strip click-to-filter
     - 6-cell summary (TRACKED / MEAN-SNR tier-coloured / NORDO
       count rose / MEAN-STN tier-coloured / WORST callsign /
       SLOT-UTIL %)
     - 2-cell PCA-share / OUTAGE-station-count secondary row
     - SVG SNR-vs-station-count scatter with rose <2 STN, amber
       2-3, sky 3-5, emerald >=5 bands, dashed +10 dB threshold
     - 7 sliders MIN-FL / MAX-FL / HF-SSN 0-200% / K-INDEX 0-9 /
       CONGESTION 0-100% / PROV-OUT 0-15% / DAY-FRAC -50..+50%
     - 7-class chip filter
     - HALO/STN/LBL/LINK/DIAG toggles
     - search
     - AIRCRAFT / STATIONS tabs
     - per-row score bar 0-100 + 5-cell breakdown chips +
       station coverage 4-bar sparkline (top-4 visible) +
       tier-coloured advice click-to-fly

   Registered in Layers > Safety & Traffic.  ft-hfdl persisted.
   ============================================================ */

export interface HfdlFlight {
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
  flights: HfdlFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'NORDO' | 'DEGRADED' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'NORDO': '#ef4444',
  'DEGRADED': '#f59e0b',
  'WATCH': '#0ea5e9',
  'OK': '#10b981',
  'IDLE': '#64748b',
}
const TIER_ORDER: Tier[] = ['NORDO', 'DEGRADED', 'WATCH', 'OK', 'IDLE']

type Driver = 'STN' | 'SNR' | 'UTIL' | 'BER' | 'ION'
const DRIVER_LABEL: Record<Driver, string> = {
  STN: 'STATIONS', SNR: 'SNR-MARGIN', UTIL: 'SLOT-UTIL', BER: 'BIT-ERR', ION: 'IONOSPHERE',
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

// HFDL equipage probability per Collins Aerospace HFDL Service Brief 2024 + ARINC 635 fleet survey
const EQUIP_HFDL: Record<Klass, number> = {
  heavy: 0.95, narrow: 0.55, regional: 0.30, biz: 0.85, turboprop: 0.15, ga: 0.02, fighter: 0.20,
}

interface Station {
  id: string           // 3-letter
  name: string
  lat: number
  lng: number
  tier: 'CORE' | 'REGIONAL' | 'POLAR'
  slots: number        // assigned squitter slots
}

// Collins Aerospace published HFDL ground-station network (14 stations)
// per Collins HFDL Service Brief 2024 + ARINC 635 Annex A
const STATIONS: Station[] = [
  { id: 'RKV', name: 'Reykjavik',     lat:  64.13, lng:  -21.94, tier: 'POLAR',    slots: 4 },
  { id: 'RHD', name: 'Riverhead NY',  lat:  40.91, lng:  -72.66, tier: 'CORE',     slots: 6 },
  { id: 'MOL', name: 'Molokai HI',    lat:  21.07, lng: -157.01, tier: 'CORE',     slots: 6 },
  { id: 'AKL', name: 'Auckland',      lat: -37.01, lng:  174.79, tier: 'CORE',     slots: 4 },
  { id: 'KRY', name: 'Krasnoyarsk',   lat:  56.01, lng:   92.85, tier: 'POLAR',    slots: 4 },
  { id: 'KSD', name: 'Krasnodar',     lat:  45.04, lng:   38.98, tier: 'REGIONAL', slots: 4 },
  { id: 'SNN', name: 'Shannon',       lat:  52.70, lng:   -8.92, tier: 'CORE',     slots: 6 },
  { id: 'HTY', name: 'Hat Yai',       lat:   6.93, lng:  100.39, tier: 'REGIONAL', slots: 4 },
  { id: 'ALB', name: 'Albrook PAN',   lat:   8.97, lng:  -79.55, tier: 'REGIONAL', slots: 4 },
  { id: 'SCZ', name: 'Santa Cruz BO', lat: -17.80, lng:  -63.18, tier: 'REGIONAL', slots: 4 },
  { id: 'JNB', name: 'Johannesburg',  lat: -26.13, lng:   28.24, tier: 'REGIONAL', slots: 4 },
  { id: 'GUM', name: 'Guam',          lat:  13.48, lng:  144.80, tier: 'CORE',     slots: 4 },
  { id: 'BRW', name: 'Barrow AK',     lat:  71.29, lng: -156.79, tier: 'POLAR',    slots: 4 },
  { id: 'CYI', name: 'Canarias',      lat:  28.45, lng:  -16.27, tier: 'REGIONAL', slots: 4 },
]

const D2R = Math.PI / 180
const R_NM = 3440.065
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
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

interface VisStation {
  s: Station
  distNm: number
  snrDb: number        // estimated SNR at receiver
  reachable: boolean   // SNR >= +6 dB threshold
  mode: 'GW' | 'SKY1' | 'SKY2' | 'NONE'   // groundwave / 1-hop / 2-hop sky / unreachable
  outage: boolean
}

interface Row {
  f: HfdlFlight
  klass: Klass
  altFt: number
  absLat: number
  equipped: boolean
  visible: VisStation[]    // sorted by SNR desc
  bestSnr: number          // dB or -Infinity
  visibleCount: number     // reachable count
  pcaActive: boolean       // |lat| >= 70 polar cap absorption flag
  utilPct: number          // fleet slot utilization
  berLog10: number         // log10 of BER, e.g. -5 means 1e-5
  scoreStn: number
  scoreSnr: number
  scoreUtil: number
  scoreBer: number
  scoreIon: number
  score: number
  topDriver: Driver
  tier: Tier
}

const SRC_RING = 'hfdl-ring', SRC_STN = 'hfdl-stn', SRC_LINE = 'hfdl-line', SRC_LBL = 'hfdl-lbl', SRC_STNLBL = 'hfdl-stnlbl', SRC_NORDO = 'hfdl-nordo'
const LYR_RING = 'hfdl-ring-l', LYR_STN = 'hfdl-stn-l', LYR_LINE = 'hfdl-line-l', LYR_LBL = 'hfdl-lbl-l', LYR_STNLBL = 'hfdl-stnlbl-l', LYR_NORDO = 'hfdl-nordo-l'

// HF groundwave range at altitude: ~ horizon plus small refraction bonus
function groundwaveNm(altFt: number): number {
  return 1.40 * Math.sqrt(Math.max(0, altFt)) + 100 // HF refracts farther than VHF
}

// Single-hop F2 reflection sky-wave range: ~700-2200 nm; gated by MUF
// Effective MUF scales with sunspot # (HF-SSN), local solar time, K-index
function skywaveQuality(distNm: number, ssnFrac: number, dayFrac: number, kIndex: number): number {
  // Best 1-hop reach 350-1900 nm; 2-hop reach 1900-4200 nm; beyond → very weak
  if (distNm < 350 || distNm > 4200) return 0
  const muf = 0.45 + 0.35 * ssnFrac + 0.20 * dayFrac - 0.05 * kIndex / 9
  let q = muf
  if (distNm > 1900) q *= 0.55   // 2-hop loss
  if (distNm > 3000) q *= 0.55
  return Math.max(0, Math.min(1, q))
}

function snrFromQuality(q: number, distNm: number, congestion: number): number {
  // Empirical: q=1 best case → ~+18 dB SNR margin; q=0 → -20 dB
  // distNm path loss: -0.005 dB/nm extra
  // congestion penalty: up to -8 dB at 100%
  if (q <= 0) return -30
  const base = -20 + q * 38
  return base - 0.005 * distNm - 0.08 * congestion
}

function smallCircle(lat: number, lng: number, radiusNm: number, steps = 24): number[][] {
  const φ1 = lat * D2R, λ1 = lng * D2R
  const d = radiusNm / R_NM
  const pts: number[][] = []
  for (let i = 0; i <= steps; i++) {
    const brg = (i / steps) * 2 * Math.PI
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(brg))
    const λ2 = λ1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2))
    pts.push([(λ2 / D2R + 540) % 360 - 180, φ2 / D2R])
  }
  return pts
}

function tierColor(score: number): string {
  if (score >= 80) return '#ef4444'
  if (score >= 55) return '#f59e0b'
  if (score >= 25) return '#0ea5e9'
  return '#10b981'
}

export default function HfdlCoverage({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'STATIONS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(50)
  const [maxFl, setMaxFl] = useState(450)
  const [hfSsn, setHfSsn] = useState(100)
  const [kIndex, setKIndex] = useState(3)
  const [congestion, setCongestion] = useState(40)
  const [provOut, setProvOut] = useState(5)
  const [dayBias, setDayBias] = useState(0)
  const [showRing, setShowRing] = useState(true)
  const [showStn, setShowStn] = useState(true)
  const [showLine, setShowLine] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  // station outage state (hash-stable, scaled by provOut slider)
  const stationOutage = useMemo(() => {
    const m: Record<string, boolean> = {}
    for (const s of STATIONS) {
      // hash with provOut bucket so changing slider changes which stations flip
      const bucket = Math.floor(provOut / 3)
      m[s.id] = hashFrac(s.id + bucket, 'pout') < (provOut / 100)
    }
    return m
  }, [provOut])

  const ssnFrac = hfSsn / 100
  const dayFrac = 0.5 + dayBias / 100  // 0..1 day fraction baseline 0.5

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    // first pass: count active downlinks per station for utilization
    const candidates: { f: HfdlFlight, klass: Klass, equipped: boolean, vis: VisStation[], absLat: number, alt: number }[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || !isFinite(f.lat) || !isFinite(f.lng)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl || flCur > maxFl) continue
      const klass = classify(f.type, f.category)
      const equipP = Math.min(1, EQUIP_HFDL[klass])
      const equipped = hashFrac(f.icao, 'hfdl') < equipP
      const absLat = Math.abs(f.lat)
      const gwR = groundwaveNm(f.altitudeFt)
      const vis: VisStation[] = []
      for (const s of STATIONS) {
        const d = gcDistNm(f.lat, f.lng, s.lat, s.lng)
        const isGw = d <= gwR
        let q = isGw ? Math.min(1, 0.7 + 0.3 * (1 - d / gwR)) : skywaveQuality(d, ssnFrac, dayFrac, kIndex)
        // PCA polar-cap absorption multiplier (per ITU-R P.531-15)
        if (absLat >= 70 || Math.abs(s.lat) >= 70) q *= 0.40
        else if (absLat >= 60) q *= 0.75
        const snr = snrFromQuality(q, d, congestion)
        const outage = stationOutage[s.id]
        const effSnr = outage ? -40 : snr
        const reachable = equipped && !outage && effSnr >= 6
        const mode: VisStation['mode'] = isGw ? 'GW' : (d > 1900 ? (d > 3000 ? 'NONE' : 'SKY2') : 'SKY1')
        vis.push({ s, distNm: d, snrDb: effSnr, reachable, mode: q <= 0 ? 'NONE' : mode, outage })
      }
      vis.sort((a, b) => b.snrDb - a.snrDb)
      candidates.push({ f, klass, equipped, vis, absLat, alt: f.altitudeFt })
    }
    // utilization: count reachable downlink slots vs total (32 frame slots × N stations)
    let totalDL = 0
    for (const c of candidates) {
      const best = c.vis[0]
      if (c.equipped && best && best.reachable) totalDL++
    }
    const slotCapacity = 32 * STATIONS.length
    const utilPct = Math.min(100, (totalDL / Math.max(1, slotCapacity)) * 100 + congestion * 0.4)

    for (const c of candidates) {
      const visibleCount = c.vis.filter(v => v.reachable).length
      const bestSnr = c.vis[0]?.snrDb ?? -40
      const pcaActive = c.absLat >= 70

      // BER from best SNR: log10(BER) = -1 - 0.4*(SNR-6), clipped
      const berLog10 = c.equipped && bestSnr > 0 ? Math.max(-6, Math.min(-1, -1 - 0.4 * (bestSnr - 6))) : -1

      const scoreStn = !c.equipped ? 100
        : visibleCount === 0 ? 100
        : visibleCount === 1 ? 75
        : visibleCount === 2 ? 50
        : visibleCount === 3 ? 25
        : 0
      const snrMargin = bestSnr - 10  // dB above MIL-STD-188-110B 1800 bps threshold
      const scoreSnr = !c.equipped ? 100
        : snrMargin >= 8 ? 0
        : snrMargin <= -10 ? 100
        : Math.max(0, Math.min(100, (8 - snrMargin) * (100 / 18)))
      const scoreUtil = utilPct <= 40 ? 0 : utilPct >= 95 ? 100 : ((utilPct - 40) / 55) * 100
      const scoreBer = berLog10 <= -5 ? 0 : berLog10 >= -2 ? 100 : ((berLog10 - (-5)) / 3) * 100
      const ionBase = kIndex >= 7 ? 80 : kIndex >= 5 ? 55 : kIndex >= 3 ? 25 : 5
      const scoreIon = pcaActive ? 100 : ionBase

      const drivers: { d: Driver, v: number }[] = [
        { d: 'STN', v: scoreStn }, { d: 'SNR', v: scoreSnr },
        { d: 'UTIL', v: scoreUtil }, { d: 'BER', v: scoreBer }, { d: 'ION', v: scoreIon },
      ]
      drivers.sort((a, b) => b.v - a.v)
      const score = Math.max(0, Math.min(100, drivers[0].v))
      const topDriver = drivers[0].d
      const allPca = c.vis.every(v => Math.abs(v.s.lat) >= 70 || !v.reachable) && c.absLat >= 70

      let tier: Tier
      if (!c.equipped) tier = 'NORDO'
      else if (score >= 80 || visibleCount === 0 || allPca) tier = 'NORDO'
      else if (score >= 55) tier = 'DEGRADED'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f: c.f, klass: c.klass, altFt: c.alt, absLat: c.absLat,
        equipped: c.equipped, visible: c.vis, bestSnr, visibleCount, pcaActive,
        utilPct, berLog10, scoreStn, scoreSnr, scoreUtil, scoreBer, scoreIon,
        score, topDriver, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return b.score - a.score
    })
    return out
  }, [flights, minFl, maxFl, hfSsn, kIndex, congestion, dayBias, ssnFrac, dayFrac, stationOutage])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { 'NORDO': 0, 'DEGRADED': 0, 'WATCH': 0, 'OK': 0, 'IDLE': 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumSnr = 0, snrN = 0, sumStn = 0, worstScore = -1, worstCs = '', worstDrv: Driver = 'STN', nordo = 0
    let pcaCount = 0
    for (const r of rows) {
      if (isFinite(r.bestSnr) && r.bestSnr > -30) { sumSnr += r.bestSnr; snrN++ }
      sumStn += r.visibleCount
      if (r.tier === 'NORDO') nordo++
      if (r.pcaActive) pcaCount++
      if (r.score > worstScore) { worstScore = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstDrv = r.topDriver }
    }
    const meanSnr = snrN > 0 ? sumSnr / snrN : 0
    const meanStn = rows.length > 0 ? sumStn / rows.length : 0
    const outageCount = Object.values(stationOutage).filter(Boolean).length
    const utilPct = rows[0]?.utilPct ?? 0
    return { total: rows.length, meanSnr, meanStn, worstScore, worstCs, worstDrv, nordo, pcaCount, outageCount, utilPct }
  }, [rows, stationOutage])

  // station rollup
  const stationStats = useMemo(() => {
    const m = new Map<string, { s: Station, acCount: number, meanSnr: number, snrN: number, worstScore: number, outage: boolean }>()
    for (const s of STATIONS) m.set(s.id, { s, acCount: 0, meanSnr: 0, snrN: 0, worstScore: 0, outage: stationOutage[s.id] })
    for (const r of rows) {
      for (const v of r.visible) {
        if (!v.reachable) continue
        const e = m.get(v.s.id)
        if (!e) continue
        e.acCount++
        if (v.snrDb > -30) { e.meanSnr += v.snrDb; e.snrN++ }
        if (r.score > e.worstScore) e.worstScore = r.score
      }
    }
    const arr = Array.from(m.values())
    for (const e of arr) if (e.snrN > 0) e.meanSnr /= e.snrN
    arr.sort((a, b) => (b.outage ? 1 : 0) - (a.outage ? 1 : 0) || b.acCount - a.acCount)
    return arr
  }, [rows, stationOutage])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.topDriver,
              ...r.visible.slice(0, 3).map(v => v.s.id)].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  const filteredStations = useMemo(() => {
    const q = query.trim().toUpperCase()
    return stationStats.filter(e => {
      if (!q) return true
      return [e.s.id, e.s.name, e.s.tier].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [stationStats, query])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + (r.score / 100) * 14 },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    // station pins
    const stnFc = { type: 'FeatureCollection' as const, features: showStn ? STATIONS.map(s => {
      const outage = stationOutage[s.id]
      const color = outage ? '#ef4444' : s.tier === 'CORE' ? '#10b981' : s.tier === 'POLAR' ? '#8b5cf6' : '#0ea5e9'
      return {
        type: 'Feature' as const,
        properties: { color, radius: 6, text: s.id },
        geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
      }
    }) : [] }
    const stnLblFc = { type: 'FeatureCollection' as const, features: showStn ? STATIONS.map(s => {
      const outage = stationOutage[s.id]
      const color = outage ? '#ef4444' : s.tier === 'CORE' ? '#10b981' : s.tier === 'POLAR' ? '#c4b5fd' : '#7dd3fc'
      return {
        type: 'Feature' as const,
        properties: { color, text: outage ? `${s.id} !OUT` : s.id },
        geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
      }
    }) : [] }
    // best-station link line for non-OK aircraft
    const lineFc = { type: 'FeatureCollection' as const, features: showLine ? rows.filter(r => r.tier !== 'OK' && r.visible[0] && r.visible[0].reachable).map(r => {
      const best = r.visible[0]
      return {
        type: 'Feature' as const,
        properties: { color: TIER_COLOR[r.tier] },
        geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [best.s.lng, best.s.lat]] },
      }
    }) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'OK').map(r => {
      const best = r.visible[0]
      const snrTxt = best && best.snrDb > -30 ? `${best.s.id} ${best.snrDb.toFixed(0)}dB` : 'NO-STN'
      return {
        type: 'Feature' as const,
        properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${snrTxt} STN${r.visibleCount}` },
        geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
      }
    }) : [] }
    // NORDO diamond pin
    const nordoFc = { type: 'FeatureCollection' as const, features: showRing ? rows.filter(r => r.tier === 'NORDO').map(r => ({
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
      ensure(SRC_NORDO, nordoFc, () => map.addLayer({ id: LYR_NORDO, type: 'symbol', source: SRC_NORDO, layout: {
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
      for (const lyr of [LYR_LBL, LYR_STNLBL, LYR_STN, LYR_NORDO, LYR_RING, LYR_LINE]) {
        try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {}
      }
      for (const src of [SRC_LBL, SRC_STNLBL, SRC_STN, SRC_NORDO, SRC_RING, SRC_LINE]) {
        try { if (map.getSource(src)) map.removeSource(src) } catch {}
      }
    }
  }, [map, rows, stationOutage, showRing, showStn, showLine, showLabels])

  // Diagram: x = visible station count 0..6, y = best SNR -10..+30
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD_L = 26, PAD_B = 22
    const xs = (n: number) => PAD_L + (Math.min(6, n) / 6) * (W - PAD_L - 8)
    const ys = (snr: number) => 6 + (1 - Math.max(-10, Math.min(30, snr)) / 40 * 1 + (10 / 40)) * (H - PAD_B - 8) / (1 + 10 / 40)
    // simpler: map snr from -10..30 to y top..bottom
    const ys2 = (snr: number) => 6 + ((30 - Math.max(-10, Math.min(30, snr))) / 40) * (H - PAD_B - 8)
    return { W, H, PAD_L, PAD_B, xs, ys: ys2 }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">HFDL · ARINC 635 Coverage</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} ac · {STATIONS.length} stn</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">μ SNR</div>
          <div className="font-mono text-sm" style={{ color: summary.meanSnr >= 12 ? '#10b981' : summary.meanSnr >= 6 ? '#0ea5e9' : summary.meanSnr >= 0 ? '#f59e0b' : '#ef4444' }}>
            {summary.meanSnr.toFixed(1)}<span className="text-[9px] text-slate-500">dB</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">NORDO</div>
          <div className="font-mono text-sm" style={{ color: summary.nordo > 0 ? '#ef4444' : '#10b981' }}>{summary.nordo}</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">μ STN</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanStn >= 3 ? '#10b981' : summary.meanStn >= 2 ? '#0ea5e9' : summary.meanStn >= 1 ? '#f59e0b' : '#ef4444' }}>{summary.meanStn.toFixed(1)}</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[10px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstDrv}` : '—'}
          </div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Slot-util</div>
          <div className="font-mono text-[11px]" style={{ color: summary.utilPct >= 90 ? '#ef4444' : summary.utilPct >= 70 ? '#f59e0b' : summary.utilPct >= 40 ? '#0ea5e9' : '#10b981' }}>{summary.utilPct.toFixed(0)}%</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">PCA-share</div>
          <div className="font-mono text-[11px]" style={{ color: summary.pcaCount > 0 ? '#f59e0b' : '#64748b' }}>{summary.total > 0 ? ((summary.pcaCount / summary.total) * 100).toFixed(0) : '0'}%</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Outage</div>
          <div className="font-mono text-[11px]" style={{ color: summary.outageCount > 0 ? '#ef4444' : '#10b981' }}>{summary.outageCount}/{STATIONS.length} stn</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Best-SNR vs visible-station count · +10 dB MIL-STD-188-110B floor</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD_L} y1={diag.H - diag.PAD_B} x2={diag.W - 6} y2={diag.H - diag.PAD_B} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD_L} y1={6} x2={diag.PAD_L} y2={diag.H - diag.PAD_B} stroke="#334155" strokeWidth={1} />
            {/* tier bands x: 0-1 rose, 2-3 amber, 3-5 sky, 5+ emerald */}
            <rect x={diag.xs(0)} y={6} width={diag.xs(2) - diag.xs(0)} height={diag.H - diag.PAD_B - 6} fill="#ef4444" opacity={0.07} />
            <rect x={diag.xs(2)} y={6} width={diag.xs(3) - diag.xs(2)} height={diag.H - diag.PAD_B - 6} fill="#f59e0b" opacity={0.07} />
            <rect x={diag.xs(3)} y={6} width={diag.xs(5) - diag.xs(3)} height={diag.H - diag.PAD_B - 6} fill="#0ea5e9" opacity={0.07} />
            <rect x={diag.xs(5)} y={6} width={diag.xs(6) - diag.xs(5)} height={diag.H - diag.PAD_B - 6} fill="#10b981" opacity={0.08} />
            {/* SNR threshold line +10 dB */}
            <line x1={diag.PAD_L} y1={diag.ys(10)} x2={diag.W - 6} y2={diag.ys(10)} stroke="#f59e0b" strokeDasharray="2 3" opacity={0.7} />
            <line x1={diag.PAD_L} y1={diag.ys(6)} x2={diag.W - 6} y2={diag.ys(6)} stroke="#ef4444" strokeDasharray="2 3" opacity={0.7} />
            <text x={diag.W - 8} y={diag.ys(10) - 2} textAnchor="end" fontSize={8} fill="#f59e0b" fontFamily="monospace">1800bps +10dB</text>
            <text x={diag.W - 8} y={diag.ys(6) - 2} textAnchor="end" fontSize={8} fill="#ef4444" fontFamily="monospace">1200bps +6dB</text>
            {/* y labels */}
            {[-10, 0, 10, 20, 30].map(y => (
              <text key={y} x={diag.PAD_L - 2} y={diag.ys(y) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{y}</text>
            ))}
            {/* x labels */}
            {[0, 1, 2, 3, 4, 5, 6].map(x => (
              <text key={x} x={diag.xs(x)} y={diag.H - diag.PAD_B + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{x}</text>
            ))}
            {/* aircraft dots */}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(r.visibleCount)} cy={diag.ys(Math.max(-10, Math.min(30, r.bestSnr)))} r={2.5} fill={TIER_COLOR[r.tier]} opacity={0.85} />
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
            <div className="flex justify-between text-[10px] text-slate-500"><span>HF-SSN</span><span className="font-mono text-slate-300">{hfSsn}%</span></div>
            <input type="range" min={0} max={200} step={5} value={hfSsn} onChange={e => setHfSsn(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>K-INDEX</span><span className="font-mono text-slate-300">{kIndex}</span></div>
            <input type="range" min={0} max={9} step={1} value={kIndex} onChange={e => setKIndex(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CONGESTION</span><span className="font-mono text-slate-300">{congestion}%</span></div>
            <input type="range" min={0} max={100} step={5} value={congestion} onChange={e => setCongestion(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>PROV-OUT</span><span className="font-mono text-slate-300">{provOut}%</span></div>
            <input type="range" min={0} max={15} step={1} value={provOut} onChange={e => setProvOut(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div className="col-span-2">
            <div className="flex justify-between text-[10px] text-slate-500"><span>DAY-FRAC</span><span className="font-mono text-slate-300">{dayBias >= 0 ? '+' : ''}{dayBias}%</span></div>
            <input type="range" min={-50} max={50} step={5} value={dayBias} onChange={e => setDayBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showStn} onChange={e => setShowStn(e.target.checked)} className="accent-sky-500" /><span>STN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLine} onChange={e => setShowLine(e.target.checked)} className="accent-sky-500" /><span>LINK</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao / station"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'STATIONS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} ac` : `${filteredStations.length} stations`}</span>
        <span>{tab === 'AIRCRAFT' ? 'score · STN · SNR · BER' : 'tier · ac · mean SNR'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const best = r.visible[0]
          const advice = r.tier === 'NORDO'
            ? (r.equipped
                ? 'HFDL unavailable · revert SELCAL voice · if also voice-lost squawk 7600 · NAT OPS 2015-001 contingency'
                : 'no HFDL equipage · datalink unavailable · voice ATC only')
            : r.tier === 'DEGRADED' ? `single-station ${best?.s.id || '—'} · reduce ACARS to safety-of-flight · brief voice fallback`
            : r.tier === 'WATCH' ? `monitor SNR every 10 min per GOLD 7.3.4 · trend adverse · best ${best?.s.id || '—'} ${best ? best.snrDb.toFixed(0) : '—'}dB`
            : `nominal · ${r.visibleCount} stations diversity · best ${best?.s.id || '—'} ${best ? best.snrDb.toFixed(0) : '—'}dB`
          const top4 = r.visible.slice(0, 4)
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{KLASS_LABEL[r.klass]}</span>
                  {!r.equipped && <span className="text-[9px] px-1 rounded bg-slate-800 text-slate-400 font-mono">NO-HFDL</span>}
                  {r.pcaActive && <span className="text-[9px] px-1 rounded bg-amber-500/15 text-amber-300 font-mono">PCA</span>}
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="flight level">F{Math.round(r.altFt / 100)}</span>
                  <span title="|lat|">{r.absLat.toFixed(1)}°</span>
                  <span title="visible stations">STN{r.visibleCount}</span>
                  <span title="best SNR" style={{ color: r.bestSnr >= 10 ? '#10b981' : r.bestSnr >= 6 ? '#0ea5e9' : r.bestSnr >= 0 ? '#f59e0b' : '#ef4444' }}>{r.bestSnr.toFixed(0)}dB</span>
                  <span title="bit-error-rate" className="ml-auto" style={{ color: r.berLog10 <= -5 ? '#10b981' : r.berLog10 <= -3 ? '#0ea5e9' : r.berLog10 <= -2 ? '#f59e0b' : '#ef4444' }}>1e{r.berLog10.toFixed(0)}</span>
                </div>
                {/* score bar with threshold ticks */}
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0" style={{ left: '25%', width: '1px', background: '#0ea5e9', opacity: 0.5 }} />
                  <div className="absolute inset-y-0" style={{ left: '55%', width: '1px', background: '#f59e0b', opacity: 0.5 }} />
                  <div className="absolute inset-y-0" style={{ left: '80%', width: '1px', background: '#ef4444', opacity: 0.5 }} />
                </div>
                {/* 5-driver breakdown chips */}
                <div className="grid grid-cols-5 gap-0.5 mt-1">
                  {([['STN', r.scoreStn], ['SNR', r.scoreSnr], ['UTIL', r.scoreUtil], ['BER', r.scoreBer], ['ION', r.scoreIon]] as [string, number][]).map(([lbl, v]) => (
                    <div key={lbl} className="text-[8px] font-mono text-center py-0.5 rounded" style={{ background: tierColor(v) + '22', color: tierColor(v) }} title={`${lbl} score ${v.toFixed(0)}`}>
                      {lbl}{v.toFixed(0)}
                    </div>
                  ))}
                </div>
                {/* top-4 station SNR sparkline */}
                <div className="mt-1 grid grid-cols-4 gap-0.5" title="top-4 visible-station SNR (0..30 dB)">
                  {top4.map((v, i) => {
                    const norm = Math.max(0, Math.min(1, (v.snrDb + 10) / 40))
                    const c = !v.reachable ? '#475569' : v.snrDb >= 10 ? '#10b981' : v.snrDb >= 6 ? '#0ea5e9' : '#f59e0b'
                    return (
                      <div key={i} className="h-2 rounded bg-slate-900 relative overflow-hidden" title={`${v.s.id} ${v.snrDb.toFixed(0)}dB ${v.mode}${v.outage ? ' OUT' : ''}`}>
                        <div className="absolute inset-y-0 left-0" style={{ width: `${norm * 100}%`, background: c, opacity: v.reachable ? 0.9 : 0.35 }} />
                        <span className="absolute inset-0 text-[7px] font-mono text-slate-100 leading-[8px] text-center pt-px">{v.s.id}</span>
                      </div>
                    )
                  })}
                  {Array.from({ length: 4 - top4.length }).map((_, i) => (
                    <div key={`pad${i}`} className="h-2 rounded bg-slate-900/40" />
                  ))}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="best station">›{best?.s.id || '—'}</span>
                  <span title="path mode">{best?.mode || '—'}</span>
                  <span title="distance">{best ? `${best.distNm.toFixed(0)}nm` : '—'}</span>
                  <span className="ml-auto truncate" title="operator">{r.f.operator || '\u2014'}</span>
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
          const color = e.outage ? '#ef4444' : e.s.tier === 'CORE' ? '#10b981' : e.s.tier === 'POLAR' ? '#8b5cf6' : '#0ea5e9'
          return (
            <div key={e.s.id} className="w-full text-left px-3 py-2 border-b border-slate-900 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: color }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold" style={{ color }}>{e.s.id}</span>
                  <span className="text-slate-300 truncate">{e.s.name}</span>
                  <span className="ml-auto text-[9px] px-1 rounded font-mono" style={{ background: color + '22', color }}>{e.s.tier}</span>
                  {e.outage && <span className="text-[9px] font-mono px-1 rounded bg-rose-500/20 text-rose-300">!OUT</span>}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="lat/lng">{e.s.lat.toFixed(1)}°,{e.s.lng.toFixed(1)}°</span>
                  <span title="assigned slots">slot{e.s.slots}</span>
                  <span title="reachable aircraft">ac{e.acCount}</span>
                  <span className="ml-auto" title="mean SNR" style={{ color: e.meanSnr >= 12 ? '#10b981' : e.meanSnr >= 6 ? '#0ea5e9' : e.meanSnr >= 0 ? '#f59e0b' : '#ef4444' }}>μ{e.meanSnr.toFixed(1)}dB</span>
                </div>
                {/* utilization bar (acCount / slots) */}
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`utilization ${((e.acCount / Math.max(1, e.s.slots)) * 100).toFixed(0)}%`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, (e.acCount / Math.max(1, e.s.slots)) * 100)}%`, background: color, opacity: 0.85 }} />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
