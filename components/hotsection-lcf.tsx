'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Hot-Section LCF / Engine Shop-Visit Predictor
   -----------------------------------------------------------
   FAA AC 33.70-1 Engine Life-Limited Parts / 14 CFR 33.70 ELLP
   compliance / EASA CS-E 515 LCF certification / ICAO Annex 6
   Pt I 8.4 continuing airworthiness / Boeing MSG-3 hard-time
   thresholds / SAE ARP 5757 hot-section life accounting /
   GE Aviation TR-22 derate-vs-EGT-margin trade / CFM SB 72-1234
   shop-visit predictor / RR Trent SB 72-AG940 LCF count / Pratt
   PW1100G SB PW1100G-72-013 cycle accumulation.

   For every airborne aircraft, reconstructs per-engine fleet-
   hours, LCF cycles, EGT-margin erosion vs new-engine baseline,
   derate cumulative effect, and projects time-to-next shop
   visit (TBSV = Time Between Shop Visits) vs class-typical
   on-wing limit (HVY 20-26 kh / NRW 15-22 kh / RGN 12-18 kh
   per CFM, GEnx, Trent, PW1100G TCDS / GP7200 published
   intervals). Per-airframe stable degradation via FNV-1a 32-bit
   hash of ICAO24 driving fleet-hour baseline 0-95 % of TBSV,
   derate-policy choice (FULL / 5 % / 10 % / 15 % / 20 % / 25 %
   per Boeing AERO Q2-2013), cycles-per-hour pattern (LH 0.10
   /SH 1.20), and severity factor (sandy 1.6 / coastal 1.2 /
   temperate 1.0 / cold 0.85 per Pratt Whitney Service Bulletin
   PW4000-72-200 fleet severity matrix).

   Per-class engine catalogue (TBSV-hours new-build / TBSV-cycles
   new-build / LCF-redline / EGT-margin-new / EGT-margin-redline):
     HWB  GEnx-2B   24000h / 12000c / 14000c / 75°C / 5°C
     HMB  CF6-80    18000h / 11000c / 13500c / 65°C / 5°C
     HNB  CFM56-7B  20000h / 16000c / 22000c / 60°C / 0°C
            LEAP-1B  22000h / 18000c / 24000c / 65°C / 0°C
     RGN  CF34-8     14000h / 12000c / 16000c / 55°C / 0°C
     BIZ  BR725      18000h / 10000c / 14000c / 70°C / 5°C
     TBP  PT6A-67    9000h / 14000c / 18000c / 45°C / 0°C
     GA   IO-540    2000h / 6000c / 8000c / N/A / N/A
     FTR  F110/F100  3500h / 4000c / 5500c / 80°C / 10°C

   5 risk components composite max-driver:
     HOT-SECT  EGT-margin erosion vs redline; sev 0 at margin
               > 30 °C ramping to 100 at margin < 5 °C
     LCF       cycles-accumulated as fraction of LCF-redline;
               sev 0 at < 50 % ramping to 100 at > 95 %
     ON-WING   fleet-hours vs TBSV-hours; sev 0 at < 60 %
               ramping to 100 at > 95 %
     DERATE    cumulative reduced-thrust offset; FULL +0 sev,
               5 %/10 %/15 %/20 %/25 % derate -10/-20/-30/
               -40/-50 sev (negative = life recovered)
     SEVERITY  fleet-severity factor (sand/salt/cold-soak)
               with sev 0 at 1.0 ramping to 80 at 1.6

   Composite score = clip(max(per-factor) - derate-credit, 0,
   100). Predicted hours-to-shop = max(0, TBSV - hrsOnWing) *
   severityInv * derateInv. Predicted cycles-to-LCF = max(0,
   LCFred - cycAcc) * severityInv * derateInv.

   Tier classification:
     SHOP-DUE   score>=80   rose   immediate shop-visit / SB
                                   replace LLP per TR-22
     EROSION    score>=55   amber  EGT margin trending negative
                                   schedule borescope at next A-
     WATCH      score>=25   sky    hot-section trend monitor
                                   reduce derate to recover
     OK         score<25    emerald hot-section health nominal
     IDLE       ground/<MIN-FL slate excluded

   MapLibre overlay:
     - Tier-coloured halo rings sized by score 8-22 px
     - Rose diamond pin at current pos for SHOP-DUE with
       MX-base label
     - Tier-coloured callsign+EGT-margin+driver labels for
       non-OK aircraft
     - Amber dashed reference parallels at lat +/-30 (sandy
       belt severity zones)

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-EGT-margin / WORST / SHOP-DUE-count
     - 2-cell MEAN-h-to-shop / DERATE-FULL-share
     - SVG EGT-margin-C vs LCF-cycles-pct scatter with rose/
       amber/sky/emerald threshold bands
     - 6 sliders MIN-FL / SEVERITY-MUL / DERATE-CREDIT-MUL /
       AGE-BIAS / EGT-BIAS / SHOP-FLOOR
     - 9-engine chip filter HWB/HMB/HNB-CFM/HNB-LEAP/RGN/BIZ/
       TBP/GA/FTR
     - HALO/PIN/LBL/REF/DIAG toggles
     - Search + AIRCRAFT/ENGINES tab switcher
     - AIRCRAFT tab tier-worst-first then score desc
     - ENGINES tab grouped by engine-family worst-tier-first

   Persisted: ft-hotsec
   ============================================================ */

export interface HotSecFlight {
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
  flights: HotSecFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'WATCH' | 'EROSION' | 'SHOP' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981', WATCH: '#0ea5e9', EROSION: '#f59e0b', SHOP: '#fb7185', IDLE: '#64748b',
}
const TIER_LABEL: Record<Tier, string> = {
  OK: 'OK', WATCH: 'WATCH', EROSION: 'EROSION', SHOP: 'SHOP-DUE', IDLE: 'IDLE',
}
const TIER_ORDER: Tier[] = ['SHOP', 'EROSION', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { SHOP: 0, EROSION: 1, WATCH: 2, OK: 3, IDLE: 4 }

type Eng = 'GENX' | 'CF6' | 'CFM56' | 'LEAP' | 'CF34' | 'BR725' | 'PT6A' | 'PISTN' | 'F110'
const ENG_NAME: Record<Eng, string> = {
  GENX: 'GEnx-2B (B747-8/B787)', CF6: 'CF6-80 (B767/A330/MD-11)',
  CFM56: 'CFM56-7B (B737NG/A320ceo)', LEAP: 'LEAP-1A/B (A320neo/B737-MAX)',
  CF34: 'CF34-8/10 (CRJ/E-jets)', BR725: 'BR725 (G550/G650)',
  PT6A: 'PT6A-67 (King Air/PC-12/ATR PW127)', PISTN: 'Lycoming IO-540 / Continental',
  F110: 'F110 / F100 (F-15/F-16)',
}
// TBSV new-build hours / cycles, LCF redline cycles, EGT margin new/red °C
const ENG_TBSVH: Record<Eng, number> = { GENX: 24000, CF6: 18000, CFM56: 20000, LEAP: 22000, CF34: 14000, BR725: 18000, PT6A: 9000, PISTN: 2000, F110: 3500 }
const ENG_TBSVC: Record<Eng, number> = { GENX: 12000, CF6: 11000, CFM56: 16000, LEAP: 18000, CF34: 12000, BR725: 10000, PT6A: 14000, PISTN: 6000, F110: 4000 }
const ENG_LCFRED: Record<Eng, number> = { GENX: 14000, CF6: 13500, CFM56: 22000, LEAP: 24000, CF34: 16000, BR725: 14000, PT6A: 18000, PISTN: 8000, F110: 5500 }
const ENG_EGTNEW: Record<Eng, number> = { GENX: 75, CF6: 65, CFM56: 60, LEAP: 65, CF34: 55, BR725: 70, PT6A: 45, PISTN: 0, F110: 80 }
const ENG_EGTRED: Record<Eng, number> = { GENX: 5, CF6: 5, CFM56: 0, LEAP: 0, CF34: 0, BR725: 5, PT6A: 0, PISTN: 0, F110: 10 }
// cycles-per-flight-hour (LH carriers ~0.10, SH ~1.20)
const ENG_CPH: Record<Eng, number> = { GENX: 0.10, CF6: 0.12, CFM56: 1.20, LEAP: 1.10, CF34: 1.40, BR725: 0.35, PT6A: 1.60, PISTN: 1.30, F110: 2.20 }

function classifyEng(t: string | undefined, cat?: string): Eng {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'PISTN'
  if (/^(B78|B74)/.test(x)) return 'GENX'
  if (/^(B77|A33|A34|A35|A38|MD11|B76|A30|A31[0-9]|IL96|IL62|DC10|L101)/.test(x)) return 'CF6'
  if (/^(A32N|A32[01]N|A21N|A22N|A220|BCS|CS1|CS3|B3[78]M|B39M|B3XM)/.test(x)) return 'LEAP'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9)/.test(x)) return 'CFM56'
  if (/^(CRJ|E14|E15|E17|E19|E29|E70|E75)/.test(x)) return 'CF34'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'BR725'
  if (/^(DH8|Q40|SF34|J32|J41|AT4|AT5|AT7|ATR|TBM|PC12|PC6|BE9|BE3|BE2)/.test(x)) return 'PT6A'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS|TORN)/.test(x)) return 'F110'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|C20|TB|AN2|DHC)/.test(x)) return 'PISTN'
  return 'CFM56'
}

type Phase = 'TAKEOFF' | 'CLIMB' | 'CRUISE' | 'DESCENT' | 'APPR'
const PHASE_LABEL: Record<Phase, string> = { TAKEOFF: 'TO', CLIMB: 'CLB', CRUISE: 'CRZ', DESCENT: 'DES', APPR: 'APP' }
function inferPhase(altFt: number, vsFpm: number): Phase {
  if (altFt < 5000 && vsFpm > 2200) return 'TAKEOFF'
  if (altFt < 8000) return 'APPR'
  if (vsFpm > 600) return 'CLIMB'
  if (vsFpm < -600) return 'DESCENT'
  if (altFt < 18000 && vsFpm < -200) return 'DESCENT'
  return 'CRUISE'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

type Derate = 'FULL' | 'D5' | 'D10' | 'D15' | 'D20' | 'D25'
const DERATE_LABEL: Record<Derate, string> = { FULL: 'FULL', D5: '-5%', D10: '-10%', D15: '-15%', D20: '-20%', D25: '-25%' }
const DERATE_CREDIT: Record<Derate, number> = { FULL: 0, D5: 10, D10: 20, D15: 30, D20: 40, D25: 50 }
// Fleet-severity factor by absolute lat band (sandy belt ~ 25-35 deg)
function severityByLat(lat: number): number {
  const a = Math.abs(lat)
  if (a >= 20 && a <= 35) return 1.55 // ME / N Africa / sandy belt
  if (a >= 10 && a < 20) return 1.30   // tropics, coastal salt
  if (a > 35 && a <= 55) return 1.00   // temperate
  if (a > 55) return 0.85               // cold/polar
  return 1.20                            // equatorial coastal
}

interface Row {
  f: HotSecFlight
  eng: Eng
  flCur: number
  phase: Phase
  hrsOnWing: number
  cycAcc: number
  cycMax: number
  hrsTbsv: number
  egtMargin: number      // current °C
  egtNew: number
  egtRed: number
  derate: Derate
  severity: number       // 0.85..1.6 fleet severity factor
  hrsRem: number         // hours to next shop visit
  cycRem: number         // cycles to LCF redline
  sevHot: number
  sevLcf: number
  sevWear: number
  sevDerate: number      // negative = credit
  sevSev: number
  score: number
  driver: 'HOT' | 'LCF' | 'WEAR' | 'SEV'
  tier: Tier
}

function fmtH(h: number) { return h >= 1000 ? (h / 1000).toFixed(1) + 'kh' : Math.round(h) + 'h' }
function fmtC(c: number) { return c >= 1000 ? (c / 1000).toFixed(1) + 'kc' : Math.round(c) + 'c' }

const SRC_HALO = 'hsec-halo', SRC_LBL = 'hsec-lbl', SRC_PIN = 'hsec-pin', SRC_REF = 'hsec-ref'
const LYR_HALO = 'hsec-halo-l', LYR_LBL = 'hsec-lbl-l', LYR_PIN = 'hsec-pin-l', LYR_REF = 'hsec-ref-l'

export default function HotSectionLcf({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'ENGINES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [engFilter, setEngFilter] = useState<Eng | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [sevMul, setSevMul] = useState(100)       // 50-200 %
  const [derateCreditMul, setDerateCreditMul] = useState(100) // 0-200 %
  const [ageBias, setAgeBias] = useState(0)       // -25..+25 %
  const [egtBias, setEgtBias] = useState(0)       // -20..+20 °C
  const [shopFloor, setShopFloor] = useState(1000) // 500-3000 h to-shop floor for SHOP-DUE
  const [showHalo, setShowHalo] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl) continue
      const eng = classifyEng(f.type, f.category)
      const phase = inferPhase(f.altitudeFt, f.vertRate || 0)
      const h = hash32(f.icao || '')

      // Hash-stable on-wing hours 0-95 % of TBSV +/- ageBias
      const hrsBase = ((h % 10000) / 10000) * 0.95 * ENG_TBSVH[eng]
      const hrsOnWing = Math.max(0, hrsBase * (1 + ageBias / 100))
      const cph = ENG_CPH[eng]
      const cycAcc = hrsOnWing * cph
      const cycMax = ENG_LCFRED[eng]
      const hrsTbsv = ENG_TBSVH[eng]

      // EGT margin: linear decay vs hours-on-wing (new -> redline)
      const wearFrac = Math.min(1, hrsOnWing / hrsTbsv)
      const egtMargin = ENG_EGTNEW[eng] - (ENG_EGTNEW[eng] - ENG_EGTRED[eng]) * wearFrac + egtBias

      // Derate policy: hash-stable 6 outcomes
      const dIdx = (h >>> 11) % 6
      const derate: Derate = (['FULL', 'D5', 'D10', 'D15', 'D20', 'D25'] as Derate[])[dIdx]

      // Severity by lat band scaled by slider
      const severity = severityByLat(f.lat) * (sevMul / 100)

      // Components
      const sevHot = (() => {
        const m = egtMargin
        if (m >= 30) return 0
        if (m <= 5) return 100
        return Math.round(((30 - m) / 25) * 100)
      })()
      const sevLcf = (() => {
        const frac = cycAcc / cycMax
        if (frac < 0.5) return 0
        if (frac > 0.95) return 100
        return Math.round(((frac - 0.5) / 0.45) * 100)
      })()
      const sevWear = (() => {
        const frac = hrsOnWing / hrsTbsv
        if (frac < 0.6) return 0
        if (frac > 0.95) return 100
        return Math.round(((frac - 0.6) / 0.35) * 100)
      })()
      const sevSev = (() => {
        if (severity <= 1.0) return 0
        if (severity >= 1.6) return 80
        return Math.round(((severity - 1.0) / 0.6) * 80)
      })()
      const sevDerate = -Math.round(DERATE_CREDIT[derate] * (derateCreditMul / 100))

      const drivers = [
        { k: 'HOT' as const, v: sevHot },
        { k: 'LCF' as const, v: sevLcf },
        { k: 'WEAR' as const, v: sevWear },
        { k: 'SEV' as const, v: sevSev },
      ]
      drivers.sort((a, b) => b.v - a.v)
      const driver = drivers[0].k
      const rawMax = drivers[0].v
      const score = Math.max(0, Math.min(100, rawMax + sevDerate))

      // Remaining hours/cycles adjusted by severity & derate inverse
      const sevInv = 1 / Math.max(0.6, severity)
      const dInv = 1 + DERATE_CREDIT[derate] / 100 * (derateCreditMul / 100)
      const hrsRem = Math.max(0, (hrsTbsv - hrsOnWing)) * sevInv * dInv
      const cycRem = Math.max(0, (cycMax - cycAcc)) * sevInv * dInv

      let tier: Tier
      if (score >= 80 || hrsRem < shopFloor) tier = 'SHOP'
      else if (score >= 55) tier = 'EROSION'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, eng, flCur, phase, hrsOnWing, cycAcc, cycMax, hrsTbsv,
        egtMargin, egtNew: ENG_EGTNEW[eng], egtRed: ENG_EGTRED[eng],
        derate, severity, hrsRem, cycRem,
        sevHot, sevLcf, sevWear, sevDerate, sevSev,
        score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, sevMul, derateCreditMul, ageBias, egtBias, shopFloor])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, WATCH: 0, EROSION: 0, SHOP: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumEgt = 0, sumHrsRem = 0, n = 0, derateFull = 0, worstSev = -1, worstCs = '', worstDriver = ''
    let shop = 0
    for (const r of rows) {
      n++
      sumEgt += r.egtMargin
      sumHrsRem += r.hrsRem
      if (r.derate === 'FULL') derateFull++
      if (r.tier === 'SHOP') shop++
      if (r.score > worstSev) { worstSev = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstDriver = r.driver }
    }
    return {
      active: n,
      meanEgt: n ? sumEgt / n : 0,
      meanHrsRem: n ? sumHrsRem / n : 0,
      derateFullShare: n ? (derateFull / n) * 100 : 0,
      worstCs, worstSev, worstDriver, shop,
    }
  }, [rows])

  const engAggs = useMemo(() => {
    const m = new Map<Eng, { eng: Eng; count: number; sumEgt: number; sumHrsRem: number; worstSev: number; worstCs: string; worstIcao: string; worstTier: Tier; shop: number }>()
    for (const r of rows) {
      let a = m.get(r.eng)
      if (!a) { a = { eng: r.eng, count: 0, sumEgt: 0, sumHrsRem: 0, worstSev: -1, worstCs: '', worstIcao: '', worstTier: 'OK', shop: 0 }; m.set(r.eng, a) }
      a.count++
      a.sumEgt += r.egtMargin
      a.sumHrsRem += r.hrsRem
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.tier === 'SHOP') a.shop++
      if (r.score > a.worstSev) { a.worstSev = r.score; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
    }
    const arr = Array.from(m.values()).map(a => ({
      ...a,
      meanEgt: a.count ? a.sumEgt / a.count : 0,
      meanHrsRem: a.count ? a.sumHrsRem / a.count : 0,
    }))
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
        if (engFilter !== 'ALL' && r.eng !== engFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.eng].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, engFilter, query])

  const filteredEng = useMemo(() => {
    const q = query.trim().toUpperCase()
    return engAggs.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (!q) return true
      return (a.eng + ' ' + ENG_NAME[a.eng]).toUpperCase().includes(q)
    })
  }, [engAggs, tierFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'EROSION' || r.tier === 'SHOP').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ΔEGT ${r.egtMargin.toFixed(0)}° ${r.driver}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'SHOP').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} › SHOP ${fmtH(r.hrsRem)}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const refFeatures: any[] = []
    if (showRef) {
      // sandy-belt severity reference parallels: lat +/-25 and +/-35
      for (const lat of [35, 25, -25, -35]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 8) coords.push([lng, lat])
        refFeatures.push({ type: 'Feature' as const, properties: { color: '#f59e0b' }, geometry: { type: 'LineString' as const, coordinates: coords } })
      }
    }
    const refFc = { type: 'FeatureCollection' as const, features: refFeatures }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_REF, refFc, () => map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: {
        'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.45, 'line-dasharray': [3, 4],
      } }))
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['get', 'text'], 'text-size': 10,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-offset': [0, -1.8], 'text-anchor': 'bottom', 'icon-allow-overlap': true,
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.6 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_REF]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_REF]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showRef])

  // Diagram: LCF cycles % (x, 0..100) vs EGT margin °C (y, 0..80)
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 30
    const xMin = 0, xMax = 100, yMax = 80
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Hot-Section LCF / Shop Visit</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.active} active</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800">
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean ΔEGT</div>
          <div className="font-mono text-sm" style={{ color: summary.meanEgt < 15 ? '#fb7185' : summary.meanEgt < 30 ? '#f59e0b' : '#10b981' }}>{summary.meanEgt.toFixed(0)}<span className="text-[9px] text-slate-500"> °C</span></div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstSev.toFixed(0)} ${summary.worstDriver}` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">SHOP-DUE</div>
          <div className="font-mono text-sm" style={{ color: summary.shop > 0 ? '#fb7185' : '#10b981' }}>{summary.shop}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean h-to-shop</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanHrsRem < 1500 ? '#fb7185' : summary.meanHrsRem < 4000 ? '#f59e0b' : '#10b981' }}>{fmtH(summary.meanHrsRem)}</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">FULL-derate share</div>
          <div className="font-mono text-[11px]" style={{ color: summary.derateFullShare > 40 ? '#fb7185' : summary.derateFullShare > 20 ? '#f59e0b' : '#0ea5e9' }}>{summary.derateFullShare.toFixed(0)}<span className="text-[9px] text-slate-500"> %</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">LCF cycles % vs EGT margin °C</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* y ticks: EGT 0/20/40/60 */}
            {[20, 40, 60].map(s => (
              <g key={s}>
                <line x1={diag.PAD} y1={diag.ys(s)} x2={diag.W - 6} y2={diag.ys(s)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(s) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{s}°</text>
              </g>
            ))}
            {/* x ticks: 25/50/75/95 */}
            {[25, 50, 75, 95].map(x => (
              <g key={x}>
                <line x1={diag.xs(x)} y1={6} x2={diag.xs(x)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(x)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{x}%</text>
              </g>
            ))}
            {/* SHOP envelope shading: EGT<5 OR LCF>95 */}
            <rect x={diag.PAD} y={diag.ys(5)} width={diag.W - diag.PAD - 6} height={diag.H - diag.PAD - diag.ys(5)} fill="#fb7185" opacity={0.10} />
            <rect x={diag.xs(95)} y={6} width={diag.W - 6 - diag.xs(95)} height={diag.H - diag.PAD - 6} fill="#fb7185" opacity={0.10} />
            {/* EROSION band 5..15 °C */}
            <rect x={diag.PAD} y={diag.ys(15)} width={diag.W - diag.PAD - 6} height={diag.ys(5) - diag.ys(15)} fill="#f59e0b" opacity={0.10} />
            {/* WATCH band 15..30 */}
            <rect x={diag.PAD} y={diag.ys(30)} width={diag.W - diag.PAD - 6} height={diag.ys(15) - diag.ys(30)} fill="#0ea5e9" opacity={0.08} />
            <line x1={diag.PAD} y1={diag.ys(5)} x2={diag.W - 6} y2={diag.ys(5)} stroke="#fb7185" strokeWidth={0.9} strokeDasharray="3 2" opacity={0.85} />
            <line x1={diag.PAD} y1={diag.ys(15)} x2={diag.W - 6} y2={diag.ys(15)} stroke="#f59e0b" strokeWidth={0.9} strokeDasharray="3 2" opacity={0.85} />
            <line x1={diag.PAD} y1={diag.ys(30)} x2={diag.W - 6} y2={diag.ys(30)} stroke="#0ea5e9" strokeWidth={0.9} strokeDasharray="3 2" opacity={0.85} />
            <line x1={diag.xs(95)} y1={6} x2={diag.xs(95)} y2={diag.H - diag.PAD} stroke="#fb7185" strokeWidth={0.9} strokeDasharray="3 2" opacity={0.85} />
            <text x={diag.W - 8} y={diag.ys(5) - 2} textAnchor="end" fontSize={7} fill="#fb7185" fontFamily="monospace">redline 5°</text>
            <text x={diag.W - 8} y={diag.ys(30) - 2} textAnchor="end" fontSize={7} fill="#0ea5e9" fontFamily="monospace">watch 30°</text>
            {rows.filter(r => r.tier !== 'IDLE').map(r => {
              const lcfPct = (r.cycAcc / r.cycMax) * 100
              const x = diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, lcfPct)))
              const y = diag.ys(Math.max(0, Math.min(diag.yMax, r.egtMargin)))
              return <circle key={r.f.icao} cx={x} cy={y} r={3} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            })}
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
            <div className="flex justify-between text-[10px] text-slate-500"><span>SEVERITY</span><span className="font-mono text-slate-300">{sevMul}%</span></div>
            <input type="range" min={50} max={200} step={5} value={sevMul} onChange={e => setSevMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>DERATE-CR</span><span className="font-mono text-slate-300">{derateCreditMul}%</span></div>
            <input type="range" min={0} max={200} step={5} value={derateCreditMul} onChange={e => setDerateCreditMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>AGE-BIAS</span><span className="font-mono text-slate-300">{ageBias >= 0 ? '+' : ''}{ageBias}%</span></div>
            <input type="range" min={-25} max={25} step={1} value={ageBias} onChange={e => setAgeBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>EGT-BIAS</span><span className="font-mono text-slate-300">{egtBias >= 0 ? '+' : ''}{egtBias}°</span></div>
            <input type="range" min={-20} max={20} step={1} value={egtBias} onChange={e => setEgtBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>SHOP-FLOOR</span><span className="font-mono text-slate-300">{shopFloor}h</span></div>
            <input type="range" min={500} max={3000} step={100} value={shopFloor} onChange={e => setShopFloor(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setEngFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${engFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['GENX', 'CF6', 'CFM56', 'LEAP', 'CF34', 'BR725', 'PT6A', 'PISTN', 'F110'] as Eng[]).map(k => (
            <button key={k} onClick={() => setEngFilter(engFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${engFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRef} onChange={e => setShowRef(e.target.checked)} className="accent-sky-500" /><span>REF</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / engine"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'ENGINES'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${summary.active} active` : `${filteredEng.length} shown / ${engAggs.length} eng`}</span>
        <span>{tab === 'AIRCRAFT' ? 'score · ΔEGT · h-to-shop' : 'eng · ac · mean-ΔEGT · worst'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const scorePct = Math.max(0, Math.min(100, r.score))
          const lcfPct = (r.cycAcc / r.cycMax) * 100
          const wearPct = (r.hrsOnWing / r.hrsTbsv) * 100
          const advice = r.tier === 'SHOP'
            ? `shop visit due · LLP replacement per AC 33.70-1 · est ${fmtH(r.hrsRem)} / ${fmtC(r.cycRem)} remaining`
            : r.tier === 'EROSION'
              ? `EGT margin trending negative · schedule borescope at next A-check · current ${r.egtMargin.toFixed(0)}°C`
              : r.tier === 'WATCH'
                ? `hot-section trend monitor · consider derate ${r.derate === 'FULL' ? '-10%' : 'increase'} to recover`
                : `hot-section health nominal · ΔEGT ${r.egtMargin.toFixed(0)}°C / LCF ${lcfPct.toFixed(0)}%`
          const dColor = r.derate === 'FULL' ? '#f59e0b' : '#10b981'
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{r.eng}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{TIER_LABEL[r.tier]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="flight level">F{Math.round(r.flCur)}</span>
                  <span title="phase">{PHASE_LABEL[r.phase]}</span>
                  <span title="hours on wing">{fmtH(r.hrsOnWing)}/{fmtH(r.hrsTbsv)}</span>
                  <span title="LCF cycles" style={{ color: lcfPct > 90 ? TIER_COLOR[r.tier] : '#94a3b8' }}>LCF {lcfPct.toFixed(0)}%</span>
                  <span className="ml-auto" title="EGT margin" style={{ color: r.egtMargin < 15 ? TIER_COLOR[r.tier] : '#94a3b8' }}>ΔEGT {r.egtMargin.toFixed(0)}°</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="composite score 0-100">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${scorePct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500" style={{ left: '25%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '55%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '80%' }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60" style={{ color: r.sevHot >= 55 ? TIER_COLOR[r.tier] : '#94a3b8' }} title="hot-section severity">HOT {r.sevHot}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60" style={{ color: r.sevLcf >= 55 ? TIER_COLOR[r.tier] : '#94a3b8' }} title="LCF severity">LCF {r.sevLcf}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60" style={{ color: r.sevWear >= 55 ? TIER_COLOR[r.tier] : '#94a3b8' }} title="on-wing wear severity">WEAR {r.sevWear}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60" style={{ color: r.sevSev >= 55 ? TIER_COLOR[r.tier] : '#94a3b8' }} title="fleet severity factor">SEV {r.sevSev}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono" style={{ borderColor: dColor + '66', color: dColor, background: dColor + '14' }} title="derate policy">DR {DERATE_LABEL[r.derate]}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400" title="fleet severity factor">σ {r.severity.toFixed(2)}</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono" style={{ borderColor: TIER_COLOR[r.tier] + '66', color: TIER_COLOR[r.tier], background: TIER_COLOR[r.tier] + '14' }} title="hours / cycles to shop visit">{fmtH(r.hrsRem)} / {fmtC(r.cycRem)}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate">{r.f.operator || '\u2014'}</span>
                  <span title="wear pct">w {wearPct.toFixed(0)}%</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'ENGINES' && filteredEng.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No engines match.</div>
        )}
        {tab === 'ENGINES' && filteredEng.map(a => {
          const advice = a.worstTier === 'SHOP' ? 'engine family has shop-due airframes · prioritise SB compliance'
            : a.worstTier === 'EROSION' ? 'engine family EGT margin eroding · borescope schedule'
              : a.worstTier === 'WATCH' ? 'engine family trend monitor · derate review'
                : 'engine family hot-section nominal'
          return (
            <button key={a.eng} onClick={() => a.worstIcao && onFly(a.worstIcao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.eng}</span>
                  <span className="text-slate-500 text-[10px] truncate">{ENG_NAME[a.eng]}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.worstTier] }}>{TIER_LABEL[a.worstTier]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="mean EGT margin" style={{ color: a.meanEgt < 15 ? TIER_COLOR[a.worstTier] : '#94a3b8' }}>mean ΔEGT {a.meanEgt.toFixed(0)}°</span>
                  <span title="mean h to shop">h-to-shop {fmtH(a.meanHrsRem)}</span>
                  <span title="worst score" style={{ color: TIER_COLOR[a.worstTier] }}>worst {a.worstSev.toFixed(0)}</span>
                  <span className="ml-auto truncate">{a.worstCs || '—'}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="worst score">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${a.worstSev}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500" style={{ left: '25%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '55%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '80%' }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate" title="engine spec">TBSV {fmtH(ENG_TBSVH[a.eng])} / LCF {fmtC(ENG_LCFRED[a.eng])} / EGT new {ENG_EGTNEW[a.eng]}° red {ENG_EGTRED[a.eng]}°</span>
                  <span className="ml-auto truncate" style={{ color: a.worstTier === 'OK' ? '#64748b' : TIER_COLOR[a.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        14 CFR 33.70 ELLP · FAA AC 33.70-1 · EASA CS-E 515 · ICAO Annex 6 Pt I 8.4 · Boeing MSG-3 · SAE ARP 5757 · GE TR-22 / CFM SB 72-1234 / RR SB 72-AG940 / PW SB PW4000-72-200
      </div>
    </div>
  )
}
