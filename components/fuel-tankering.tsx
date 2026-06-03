'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   Fuel Tankering Advisor
   -----------------------------------------------------------
   IATA Fuel Efficiency Gap Analysis / EUROCONTROL CODA economic
   tankering model. For every airborne aircraft between MIN-FL
   and MAX-FL the advisor infers the active leg (closest aligned
   IATA airport BEHIND ground track within +/-60 deg = origin,
   closest aligned IATA airport AHEAD = destination), looks up
   curated Jet-A spot price (USD/USG) at both fields, and
   computes whether the operator should tanker — uplift extra
   fuel at the cheap field to skip refuelling at the expensive
   one.

   Economics (per IATA Tankering Guidance Material 2019):

     priceDelta  = price_dest - price_origin            [$/USG]
     tankerKg    = min(MTOW - estZFW - tripFuel,
                       max(0, dest_uplift_estimate))    [kg]

     // extra-burn penalty (cost-of-weight COW):
     // carrying extra mass over the leg increases fuel burn.
     // Per FAA Order 7110.65 / Airbus FCOM tankering tables,
     // COW ~= 3-4 percent of the carried mass per 1000 nm
     // for typical jet cruise (induced-drag dominated).
     cowKgPerKgPer1000 = class-typical 0.030..0.045
     burnPenaltyKg = tankerKg * COW * (legNm / 1000)
     burnPenaltyUSG = burnPenaltyKg / JETA_KG_PER_USG

     savingsUSD = tankerKg / JETA_KG_PER_USG * priceDelta
                  - burnPenaltyUSG * price_origin
     marginPctTrip = savingsUSD / tripFuelUSD * 100

   We also surface a CO2 penalty kg from the extra burn at
   3.16 jet-kerosene combustion stoichiometry plus airport
   NOx surcharge sensitivity (curfew-fee proxy at 12 noise-
   sensitive fields).

   Tiers (per operator policy threshold sliders):

     SAVE      savingsUSD >= +SAVE-THR     emerald
     MARGIN    savingsUSD >= +MARG-THR     sky
     NEUTRAL   |savingsUSD| < MARG-THR     slate
     LOSS      savingsUSD <  -MARG-THR     rose

     OUT bucket for aircraft with no inferrable leg or with
     equal-priced origin/destination pair.

   MapLibre overlay:
     - Tier-coloured halo ring sized by |savingsUSD|.
     - Sky/rose dashed price-gradient leg origin->destination
       (dasharray varies with sign: solid SAVE, dashed LOSS).
     - Tier-coloured airport pins with ›IATA $/USG price labels.
     - Callsign + ±$savings-USD + tankerKg labels.

   Side panel:
     - 4-tier counter strip + OUT bucket click-to-filter.
     - 3-cell FLEET-SAVINGS-USD / WORST-callsign+$ / SAVE-COUNT
       summary + 2-cell MEAN-PRICE-DELTA-USG / CO2-PENALTY-T
       secondary row.
     - SVG savings-vs-leg-nm scatter (x = leg nm 0..6000 with
       1500/3000/4500 verticals, y = savings -$2k..+$2k with
       emerald +SAVE-THR / sky +MARG-THR / rose -MARG-THR
       threshold band shading + centerline; every aircraft
       plotted as tier-coloured dot).
     - 5 sliders: MIN-FL / MAX-FL / CAPTURE-NM / COW-MULT
       70-150% / SAVE-THR 100-2000 USD.
     - 7-class chip filter.
     - HALO/LEG/PIN/LBL/DIAG toggles + search.
     - AIRCRAFT/PAIRS tab switcher.
     - AIRCRAFT tab: sorted tier-best-first (SAVE> ... >LOSS),
       then |savings| desc.
     - PAIRS tab: O->D pair grouped, sorted savings-sum desc.

   Registered in Layers > Routes & Flow.
   ft-tank persisted preference.
   ============================================================ */

export interface TankFlight {
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
  flights: TankFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'SAVE' | 'MARGIN' | 'NEUTRAL' | 'LOSS'
const TIER_COLOR: Record<Tier, string> = {
  SAVE: '#10b981',
  MARGIN: '#0ea5e9',
  NEUTRAL: '#64748b',
  LOSS: '#ef4444',
}
const TIER_ORDER: Tier[] = ['SAVE', 'MARGIN', 'NEUTRAL', 'LOSS']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}

// Per-class fleet-typical (Airbus FCOM tankering table proxies):
//   burnNmKg  = cruise specific consumption kg/nm
//   mtow      = max takeoff weight kg
//   tripFrac  = typical trip-fuel as fraction of MTOW for medium leg
//   cowPer1k  = cost-of-weight, kg-burn per kg-carried per 1000 nm
//   maxUplift = max sensible tanker mass kg (centre-tank capacity proxy)
const SPEC: Record<Klass, { burnNmKg: number; mtow: number; tripFrac: number; cowPer1k: number; maxUplift: number }> = {
  heavy:     { burnNmKg: 8.5, mtow: 380000, tripFrac: 0.18, cowPer1k: 0.036, maxUplift: 28000 },
  narrow:    { burnNmKg: 3.2, mtow:  79000, tripFrac: 0.20, cowPer1k: 0.042, maxUplift: 5400 },
  regional:  { burnNmKg: 2.1, mtow:  41000, tripFrac: 0.18, cowPer1k: 0.045, maxUplift: 2200 },
  biz:       { burnNmKg: 1.9, mtow:  46000, tripFrac: 0.16, cowPer1k: 0.040, maxUplift: 4000 },
  turboprop: { burnNmKg: 1.6, mtow:  21500, tripFrac: 0.14, cowPer1k: 0.050, maxUplift: 1200 },
  ga:        { burnNmKg: 0.4, mtow:   2200, tripFrac: 0.10, cowPer1k: 0.060, maxUplift: 80 },
  fighter:   { burnNmKg: 6.5, mtow:  27000, tripFrac: 0.30, cowPer1k: 0.080, maxUplift: 2000 },
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

// Jet-A density: 0.804 kg/L * 3.785 L/USG = 3.043 kg/USG
const JETA_KG_PER_USG = 3.043
// CO2 emission per kg fuel (jet-kerosene stoichiometry)
const CO2_PER_KG_FUEL = 3.16

// Curated Jet-A spot price USD/USG, July 2026 IATA monitor average
// (IATA Jet Fuel Monitor + Platts FUELS publication regional medians).
// Default fallback price = 3.20.
const PRICE_TABLE: Record<string, number> = {
  // North America (cheap on average)
  ATL: 2.85, DFW: 2.78, ORD: 2.92, LAX: 3.05, JFK: 3.15, EWR: 3.18, BOS: 3.10,
  MIA: 2.96, SEA: 3.02, SFO: 3.20, DEN: 2.88, IAH: 2.74, PHX: 2.94, MSP: 2.95,
  DTW: 2.91, CLT: 2.86, SLC: 2.97, MCO: 2.90, LAS: 2.99, YYZ: 3.32, YVR: 3.40,
  YUL: 3.36, MEX: 3.28, GDL: 3.30, CUN: 3.12,
  // Europe (mid)
  LHR: 3.55, LGW: 3.52, CDG: 3.58, AMS: 3.50, FRA: 3.54, MUC: 3.56, MAD: 3.48,
  BCN: 3.46, FCO: 3.62, MXP: 3.60, ZRH: 3.78, VIE: 3.55, CPH: 3.62, ARN: 3.66,
  OSL: 3.72, HEL: 3.70, DUB: 3.50, IST: 3.05, ATH: 3.62, LIS: 3.48, BRU: 3.52,
  WAW: 3.40, PRG: 3.48,
  // Middle East / North Africa (cheapest tankering sources)
  DXB: 2.55, DOH: 2.48, AUH: 2.52, KWI: 2.40, RUH: 2.35, JED: 2.42, BAH: 2.50,
  MCT: 2.62, CAI: 2.95, AMM: 3.10, BEY: 3.20, TLV: 3.05,
  // Asia-Pacific (mid-high)
  HND: 3.85, NRT: 3.88, KIX: 3.82, ICN: 3.65, GMP: 3.68, PEK: 3.40, PVG: 3.45,
  CAN: 3.42, SZX: 3.50, HKG: 3.72, TPE: 3.55, SIN: 3.32, BKK: 3.20, KUL: 3.05,
  CGK: 3.25, MNL: 3.55, HAN: 3.30, SGN: 3.28, DEL: 3.18, BOM: 3.20, BLR: 3.22,
  HYD: 3.20, MAA: 3.24, CCU: 3.30,
  // Oceania (high — long supply chains)
  SYD: 4.05, MEL: 4.10, BNE: 4.02, PER: 4.20, AKL: 4.25, CHC: 4.32, WLG: 4.30,
  NAN: 4.85,
  // South America (high)
  GRU: 4.15, GIG: 4.18, EZE: 3.92, SCL: 3.85, BOG: 3.62, LIM: 3.78, CCS: 4.50,
  // Africa (very high — landlocked/import-heavy)
  JNB: 3.95, CPT: 4.05, NBO: 4.32, ADD: 4.45, LOS: 4.62, ACC: 4.55, CMN: 3.78,
  CAS: 3.80, ALG: 3.62, RAK: 3.85, DKR: 4.40,
  // Polar / remote
  ANC: 3.45, KEF: 3.55, BGR: 3.30, GOH: 5.20, FAI: 3.85,
  // Russia / CIS
  SVO: 2.95, DME: 2.92, VKO: 2.98, LED: 3.05, OVB: 3.20, KZN: 3.10,
  TAS: 2.85, GYD: 2.78, ALA: 3.10,
}
function priceUsg(iata: string): { v: number; known: boolean } {
  const p = PRICE_TABLE[iata]
  if (p == null) return { v: 3.20, known: false }
  return { v: p, known: true }
}

// Noise/curfew surcharge proxy ($/kg extra burn) — high-fee European fields
const CURFEW_FEES_USD_KG: Record<string, number> = {
  LHR: 0.05, LGW: 0.04, CDG: 0.04, FRA: 0.05, MUC: 0.03,
  ZRH: 0.06, ORY: 0.04, LCY: 0.08, DCA: 0.03, JFK: 0.02, SIN: 0.03,
}

const D2R = Math.PI / 180
const R_NM = 3440.065
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
function gcBearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R, dλ = (lo2 - lo1) * D2R
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return ((Math.atan2(y, x) / D2R) + 360) % 360
}
function headingDelta(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}
function gcInterp(latA: number, lngA: number, latB: number, lngB: number, f: number): [number, number] {
  const φ1 = latA * D2R, φ2 = latB * D2R, λ1 = lngA * D2R, λ2 = lngB * D2R
  const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2))
  if (d < 1e-9) return [latA, lngA]
  const a = Math.sin((1 - f) * d) / Math.sin(d)
  const b = Math.sin(f * d) / Math.sin(d)
  const x = a * Math.cos(φ1) * Math.cos(λ1) + b * Math.cos(φ2) * Math.cos(λ2)
  const y = a * Math.cos(φ1) * Math.sin(λ1) + b * Math.cos(φ2) * Math.sin(λ2)
  const z = a * Math.sin(φ1) + b * Math.sin(φ2)
  return [Math.atan2(z, Math.sqrt(x * x + y * y)) / D2R, Math.atan2(y, x) / D2R]
}

interface Row {
  f: TankFlight
  klass: Klass
  altFt: number
  oI: string; oIcao: string; oName: string; oLat: number; oLng: number; oNm: number; oPrice: number; oKnown: boolean
  dI: string; dIcao: string; dName: string; dLat: number; dLng: number; dNm: number; dPrice: number; dKnown: boolean
  legNm: number
  remainNm: number
  tripFuelKg: number
  tankerKg: number
  priceDelta: number
  burnPenaltyKg: number
  savingsUSD: number
  marginPctTrip: number
  co2PenaltyKg: number
  curfeeUSD: number
  tier: Tier
}

const SRC_RING = 'tank-ring', SRC_LEG = 'tank-leg', SRC_AP = 'tank-ap', SRC_LBL = 'tank-lbl'
const LYR_RING = 'tank-ring-l', LYR_LEG = 'tank-leg-l', LYR_AP = 'tank-ap-l', LYR_LBL = 'tank-lbl-l'

const ALL_AP = AIRPORTS.filter(a => a.a && a.a.length === 3)

export default function FuelTankering({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'PAIRS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL' | 'OUT'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(80)
  const [maxFl, setMaxFl] = useState(450)
  const [captureNm, setCaptureNm] = useState(1200)
  const [cowMult, setCowMult] = useState(100)        // 70-150
  const [saveThr, setSaveThr] = useState(500)        // 100-2000 USD
  const [showRing, setShowRing] = useState(true)
  const [showLeg, setShowLeg] = useState(true)
  const [showPins, setShowPins] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const { rows, outCount } = useMemo(() => {
    const out: Row[] = []
    let outC = 0
    const margThr = Math.max(50, Math.floor(saveThr / 5))
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || !isFinite(f.lat) || !isFinite(f.lng)) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl || fl > maxFl) continue
      const klass = classify(f.type, f.category)
      const trk = f.track || 0
      const trkBack = (trk + 180) % 360
      type Cand = { i: string; icao: string; name: string; lat: number; lng: number; d: number }
      let origin: Cand | null = null
      let dest: Cand | null = null
      for (const ap of ALL_AP) {
        const d = gcDistNm(f.lat, f.lng, ap.lat, ap.lon)
        if (d > captureNm || d < 8) continue
        const br = gcBearingDeg(f.lat, f.lng, ap.lat, ap.lon)
        const dFwd = headingDelta(br, trk)
        const dBack = headingDelta(br, trkBack)
        if (dBack <= 60) {
          if (!origin || d < origin.d) origin = { i: ap.a, icao: ap.i, name: ap.m || ap.n || ap.a, lat: ap.lat, lng: ap.lon, d }
        }
        if (dFwd <= 60) {
          if (!dest || d < dest.d) dest = { i: ap.a, icao: ap.i, name: ap.m || ap.n || ap.a, lat: ap.lat, lng: ap.lon, d }
        }
      }
      if (!origin || !dest || origin.i === dest.i) { outC++; continue }

      const oP = priceUsg(origin.i)
      const dP = priceUsg(dest.i)
      const priceDelta = dP.v - oP.v

      const legNm = gcDistNm(origin.lat, origin.lng, dest.lat, dest.lng)
      const remainNm = dest.d
      const spec = SPEC[klass]
      const tripFuelKg = legNm * spec.burnNmKg
      // Tankerable = how much extra fuel can be loaded over normal uplift,
      // capped by class maxUplift and policy MTOW headroom proxy (10% MTOW)
      const tankerKg = Math.max(0, Math.min(spec.maxUplift, spec.mtow * 0.10))
      const cow = spec.cowPer1k * (cowMult / 100)
      const burnPenaltyKg = tankerKg * cow * (legNm / 1000)
      const burnPenaltyUsg = burnPenaltyKg / JETA_KG_PER_USG
      const grossSavingsUsg = tankerKg / JETA_KG_PER_USG * priceDelta
      const burnCostUSD = burnPenaltyUsg * oP.v
      const curfeeUSD = burnPenaltyKg * (CURFEW_FEES_USD_KG[origin.i] || 0)
      const savingsUSD = grossSavingsUsg - burnCostUSD - curfeeUSD
      const tripFuelUSD = (tripFuelKg / JETA_KG_PER_USG) * oP.v
      const marginPctTrip = tripFuelUSD > 0 ? (savingsUSD / tripFuelUSD) * 100 : 0
      const co2PenaltyKg = burnPenaltyKg * CO2_PER_KG_FUEL

      let tier: Tier
      if (savingsUSD >= saveThr) tier = 'SAVE'
      else if (savingsUSD >= margThr) tier = 'MARGIN'
      else if (savingsUSD > -margThr) tier = 'NEUTRAL'
      else tier = 'LOSS'

      out.push({
        f, klass, altFt: f.altitudeFt,
        oI: origin.i, oIcao: origin.icao, oName: origin.name, oLat: origin.lat, oLng: origin.lng, oNm: origin.d, oPrice: oP.v, oKnown: oP.known,
        dI: dest.i, dIcao: dest.icao, dName: dest.name, dLat: dest.lat, dLng: dest.lng, dNm: dest.d, dPrice: dP.v, dKnown: dP.known,
        legNm, remainNm, tripFuelKg, tankerKg, priceDelta, burnPenaltyKg, savingsUSD, marginPctTrip, co2PenaltyKg, curfeeUSD, tier,
      })
    }
    return { rows: out, outCount: outC }
  }, [flights, minFl, maxFl, captureNm, cowMult, saveThr])

  // Counters
  const counts: Record<Tier, number> = { SAVE: 0, MARGIN: 0, NEUTRAL: 0, LOSS: 0 }
  let fleetSavings = 0
  let worst: Row | null = null
  let meanDelta = 0
  let co2Sum = 0
  for (const r of rows) {
    counts[r.tier]++
    fleetSavings += r.savingsUSD
    if (!worst || r.savingsUSD > worst.savingsUSD) worst = r
    meanDelta += r.priceDelta
    co2Sum += r.co2PenaltyKg
  }
  if (rows.length) meanDelta /= rows.length

  // Filter & sort
  const filtered = rows
    .filter(r => tierFilter === 'ALL' || tierFilter === 'OUT' || r.tier === tierFilter)
    .filter(r => klassFilter === 'ALL' || r.klass === klassFilter)
    .filter(r => {
      if (!query.trim()) return true
      const q = query.toLowerCase()
      return (r.f.callsign || '').toLowerCase().includes(q)
        || (r.f.type || '').toLowerCase().includes(q)
        || (r.f.operator || '').toLowerCase().includes(q)
        || (r.f.icao || '').toLowerCase().includes(q)
        || r.oI.toLowerCase().includes(q) || r.dI.toLowerCase().includes(q)
    })

  const ranked = tierFilter === 'OUT' ? [] : [...filtered].sort((a, b) => {
    const oa = TIER_ORDER.indexOf(a.tier), ob = TIER_ORDER.indexOf(b.tier)
    if (oa !== ob) return oa - ob
    return b.savingsUSD - a.savingsUSD
  })

  // Pairs aggregation
  type Pair = { key: string; oI: string; dI: string; oPrice: number; dPrice: number; oLat: number; oLng: number; dLat: number; dLng: number; n: number; savings: number; tier: Tier }
  const pairs: Pair[] = useMemo(() => {
    const m = new Map<string, Pair>()
    for (const r of filtered) {
      const k = `${r.oI}>${r.dI}`
      const ex = m.get(k)
      if (ex) { ex.n++; ex.savings += r.savingsUSD }
      else m.set(k, { key: k, oI: r.oI, dI: r.dI, oPrice: r.oPrice, dPrice: r.dPrice, oLat: r.oLat, oLng: r.oLng, dLat: r.dLat, dLng: r.dLng, n: 1, savings: r.savingsUSD, tier: r.tier })
    }
    const arr = [...m.values()]
    arr.forEach(p => {
      const margThr = Math.max(50, Math.floor(saveThr / 5))
      const avg = p.savings / p.n
      if (avg >= saveThr) p.tier = 'SAVE'
      else if (avg >= margThr) p.tier = 'MARGIN'
      else if (avg > -margThr) p.tier = 'NEUTRAL'
      else p.tier = 'LOSS'
    })
    return arr.sort((a, b) => b.savings - a.savings)
  }, [filtered, saveThr])

  // ============================================================
  // Map overlay
  // ============================================================
  useEffect(() => {
    if (!map) return
    const m = map as any
    if (!m.isStyleLoaded()) {
      const onLoad = () => render()
      map.once('idle', onLoad)
      return () => { try { map.off('idle', onLoad) } catch { } }
    }
    render()
    function render() {
      const rings: any[] = [], legs: any[] = [], pins: any[] = [], lbls: any[] = []
      const apSeen = new Set<string>()
      for (const r of rows) {
        if (tierFilter !== 'ALL' && tierFilter !== 'OUT' && r.tier !== tierFilter) continue
        if (klassFilter !== 'ALL' && r.klass !== klassFilter) continue
        const c = TIER_COLOR[r.tier]
        const radius = Math.max(8, Math.min(22, 6 + Math.abs(r.savingsUSD) / 200))
        if (showRing) rings.push({ type: 'Feature', properties: { color: c, radius }, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
        if (showLeg) {
          const dash = r.tier === 'SAVE' ? 0 : r.tier === 'MARGIN' ? 1 : r.tier === 'NEUTRAL' ? 2 : 3
          const coords: number[][] = []
          for (let i = 0; i <= 24; i++) {
            const [la, lo] = gcInterp(r.oLat, r.oLng, r.dLat, r.dLng, i / 24)
            coords.push([lo, la])
          }
          legs.push({ type: 'Feature', properties: { color: c, dash }, geometry: { type: 'LineString', coordinates: coords } })
        }
        if (showPins) {
          if (!apSeen.has(r.oI)) {
            apSeen.add(r.oI)
            pins.push({ type: 'Feature', properties: { color: '#10b981', label: `›${r.oI} $${r.oPrice.toFixed(2)}` }, geometry: { type: 'Point', coordinates: [r.oLng, r.oLat] } })
          }
          if (!apSeen.has(r.dI)) {
            apSeen.add(r.dI)
            pins.push({ type: 'Feature', properties: { color: '#ef4444', label: `›${r.dI} $${r.dPrice.toFixed(2)}` }, geometry: { type: 'Point', coordinates: [r.dLng, r.dLat] } })
          }
        }
        if (showLabels && r.tier !== 'NEUTRAL') {
          const sign = r.savingsUSD >= 0 ? '+' : '-'
          lbls.push({
            type: 'Feature',
            properties: { color: c, label: `${r.f.callsign || r.f.icao} ${sign}$${Math.abs(Math.round(r.savingsUSD))}` },
            geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          })
        }
      }
      ensureSrc(SRC_RING, rings); ensureSrc(SRC_LEG, legs); ensureSrc(SRC_AP, pins); ensureSrc(SRC_LBL, lbls)
      ensureLayer(LYR_RING, {
        id: LYR_RING, type: 'circle', source: SRC_RING,
        paint: {
          'circle-radius': ['get', 'radius'],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.18,
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': 1.5,
          'circle-stroke-opacity': 0.85,
        },
      })
      ensureLayer(LYR_LEG, {
        id: LYR_LEG, type: 'line', source: SRC_LEG,
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.4,
          'line-opacity': 0.7,
          'line-dasharray': [
            'match', ['get', 'dash'],
            0, ['literal', [1]],
            1, ['literal', [3, 2]],
            2, ['literal', [2, 3]],
            ['literal', [1, 4]],
          ] as any,
        },
      })
      ensureLayer(LYR_AP, {
        id: LYR_AP, type: 'circle', source: SRC_AP,
        paint: {
          'circle-radius': 4,
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 1.5,
        },
      })
      ensureLayer(LYR_LBL + '-ap', {
        id: LYR_LBL + '-ap', type: 'symbol', source: SRC_AP,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 10,
          'text-offset': [0, 1.1],
          'text-anchor': 'top',
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0f172a', 'text-halo-width': 1.4 },
      })
      ensureLayer(LYR_LBL, {
        id: LYR_LBL, type: 'symbol', source: SRC_LBL,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 11,
          'text-offset': [0, -1.6],
          'text-anchor': 'bottom',
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0f172a', 'text-halo-width': 1.4 },
      })

      function ensureSrc(id: string, features: any[]) {
        const src = m.getSource(id)
        if (src) (src as any).setData({ type: 'FeatureCollection', features })
        else m.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features } })
      }
      function ensureLayer(id: string, spec: any) {
        if (!m.getLayer(id)) m.addLayer(spec)
      }
    }
    return () => {
      try {
        ;[LYR_LBL, LYR_LBL + '-ap', LYR_AP, LYR_LEG, LYR_RING].forEach(l => { if (m.getLayer(l)) m.removeLayer(l) })
        ;[SRC_LBL, SRC_AP, SRC_LEG, SRC_RING].forEach(s => { if (m.getSource(s)) m.removeSource(s) })
      } catch { }
    }
  }, [map, rows, tierFilter, klassFilter, showRing, showLeg, showPins, showLabels])

  // ============================================================
  // SVG savings-vs-leg scatter
  // ============================================================
  const W = 376, H = 168, PADL = 36, PADR = 10, PADT = 12, PADB = 22
  const PW = W - PADL - PADR, PH = H - PADT - PADB
  const MAX_NM = 6000
  const MAX_USD = 2000
  const xOf = (nm: number) => PADL + Math.max(0, Math.min(1, nm / MAX_NM)) * PW
  const yOf = (usd: number) => PADT + PH / 2 - (Math.max(-MAX_USD, Math.min(MAX_USD, usd)) / MAX_USD) * (PH / 2)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[88vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Routes &amp; Flow</div>
          <div className="text-sm font-semibold text-slate-100">Fuel Tankering Advisor</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      <div className="overflow-y-auto">
        {/* Tier counter */}
        <div className="px-3 pt-3 grid grid-cols-5 gap-1.5">
          {(['ALL', ...TIER_ORDER, 'OUT'] as const).map(t => {
            const isAll = t === 'ALL'
            const isOut = t === 'OUT'
            const n = isAll ? rows.length : isOut ? outCount : counts[t as Tier]
            const active = tierFilter === t
            const col = isAll ? '#94a3b8' : isOut ? '#64748b' : TIER_COLOR[t as Tier]
            return (
              <button key={t} onClick={() => setTierFilter(t as any)}
                className={`px-1.5 py-1.5 rounded-lg text-[10px] font-bold tracking-wider border ${active ? 'bg-sky-500/15 border-sky-500/40' : 'bg-slate-900/50 border-slate-800 hover:border-slate-700'}`}
                style={{ color: col }}>
                <div className="text-[9px] opacity-70">{isAll ? 'ALL' : t}</div>
                <div className="text-sm">{n}</div>
              </button>
            )
          })}
        </div>

        {/* Summary */}
        <div className="px-3 pt-2 grid grid-cols-3 gap-1.5">
          <Cell label="FLEET $" value={`${fleetSavings >= 0 ? '+' : '-'}$${Math.abs(Math.round(fleetSavings))}`} color={fleetSavings >= 0 ? '#10b981' : '#ef4444'} />
          <Cell label="BEST" value={worst ? `${worst.f.callsign || worst.f.icao}` : '—'} sub={worst ? `+$${Math.round(worst.savingsUSD)}` : ''} color={worst && worst.savingsUSD >= 0 ? '#10b981' : '#64748b'} />
          <Cell label="SAVE OPS" value={String(counts.SAVE)} color={counts.SAVE ? '#10b981' : '#64748b'} />
        </div>
        <div className="px-3 pt-1.5 grid grid-cols-2 gap-1.5">
          <Cell label="MEAN Δ$/USG" value={`${meanDelta >= 0 ? '+' : ''}${meanDelta.toFixed(2)}`} color={Math.abs(meanDelta) > 0.3 ? '#0ea5e9' : '#64748b'} />
          <Cell label="CO₂ PENALTY" value={`${(co2Sum / 1000).toFixed(2)} t`} color={co2Sum > 5000 ? '#f59e0b' : '#64748b'} />
        </div>

        {/* SVG scatter */}
        {showDiag && (
          <div className="px-3 pt-2">
            <svg width={W} height={H} className="bg-slate-900/40 rounded-lg border border-slate-800">
              {/* threshold bands */}
              <rect x={PADL} y={yOf(MAX_USD)} width={PW} height={yOf(saveThr) - yOf(MAX_USD)} fill="#10b981" opacity={0.07} />
              <rect x={PADL} y={yOf(saveThr)} width={PW} height={yOf(Math.max(50, saveThr / 5)) - yOf(saveThr)} fill="#0ea5e9" opacity={0.07} />
              <rect x={PADL} y={yOf(-Math.max(50, saveThr / 5))} width={PW} height={yOf(-MAX_USD) - yOf(-Math.max(50, saveThr / 5))} fill="#ef4444" opacity={0.07} />
              {/* centerline */}
              <line x1={PADL} x2={W - PADR} y1={yOf(0)} y2={yOf(0)} stroke="#475569" strokeWidth={1} />
              {/* threshold lines */}
              <line x1={PADL} x2={W - PADR} y1={yOf(saveThr)} y2={yOf(saveThr)} stroke="#10b981" strokeWidth={0.8} strokeDasharray="3,3" />
              <line x1={PADL} x2={W - PADR} y1={yOf(-saveThr)} y2={yOf(-saveThr)} stroke="#ef4444" strokeWidth={0.8} strokeDasharray="3,3" />
              {/* x verticals */}
              {[1500, 3000, 4500].map(nm => (
                <g key={nm}>
                  <line x1={xOf(nm)} x2={xOf(nm)} y1={PADT} y2={H - PADB} stroke="#1e293b" strokeWidth={1} />
                  <text x={xOf(nm)} y={H - 6} fill="#475569" fontSize={8} textAnchor="middle">{nm}nm</text>
                </g>
              ))}
              {/* y labels */}
              {[saveThr, -saveThr].map((v, i) => (
                <text key={i} x={W - PADR - 2} y={yOf(v) - 2} textAnchor="end" fontSize={8} fill={v >= 0 ? '#10b981' : '#ef4444'}>${v}</text>
              ))}
              <text x={PADL + 2} y={PADT + 8} fontSize={8} fill="#64748b">SAVINGS USD</text>
              {/* dots */}
              {rows.map((r, i) => (
                <circle key={r.f.icao + i} cx={xOf(r.legNm)} cy={yOf(r.savingsUSD)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85} />
              ))}
            </svg>
          </div>
        )}

        {/* Sliders */}
        <div className="px-3 pt-2 grid grid-cols-2 gap-2">
          <Slider label={`MIN-FL ${minFl}`} v={minFl} min={0} max={400} setV={setMinFl} />
          <Slider label={`MAX-FL ${maxFl}`} v={maxFl} min={50} max={450} setV={setMaxFl} />
          <Slider label={`CAPTURE ${captureNm}nm`} v={captureNm} min={300} max={3000} step={50} setV={setCaptureNm} />
          <Slider label={`COW ${cowMult}%`} v={cowMult} min={70} max={150} setV={setCowMult} />
          <div className="col-span-2">
            <Slider label={`SAVE-THR $${saveThr}`} v={saveThr} min={100} max={2000} step={50} setV={setSaveThr} />
          </div>
        </div>

        {/* Class chips */}
        <div className="px-3 pt-2 flex flex-wrap gap-1">
          {(['ALL', ...Object.keys(KLASS_LABEL)] as const).map(k => {
            const active = klassFilter === (k as any)
            return (
              <button key={k} onClick={() => setKlassFilter(k as any)}
                className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider border ${active ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>
                {k === 'ALL' ? 'ALL' : KLASS_LABEL[k as Klass]}
              </button>
            )
          })}
        </div>

        {/* Layer toggles */}
        <div className="px-3 pt-2 flex flex-wrap gap-1.5">
          {[
            ['HALO', showRing, setShowRing],
            ['LEG', showLeg, setShowLeg],
            ['PIN', showPins, setShowPins],
            ['LBL', showLabels, setShowLabels],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lbl, on, setOn]: any) => (
            <button key={lbl} onClick={() => setOn(!on)}
              className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider border ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>
              {lbl}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="px-3 pt-2">
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / IATA…"
            className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50" />
        </div>

        {/* Tabs */}
        <div className="px-3 pt-2 flex gap-1">
          {(['AIRCRAFT', 'PAIRS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1 rounded-md text-[10px] font-bold tracking-wider border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>
              {t}
            </button>
          ))}
        </div>

        {/* List */}
        <div className="px-2 pt-2 pb-3 space-y-1">
          {tab === 'AIRCRAFT' && ranked.length === 0 && (
            <div className="text-[11px] text-slate-500 px-2 py-4 text-center">No aircraft match the current filters. Origin/destination inference needs an aligned IATA airport within {captureNm} nm of the track.</div>
          )}

          {tab === 'AIRCRAFT' && ranked.map(r => {
            const c = TIER_COLOR[r.tier]
            const fl = Math.round(r.altFt / 100)
            const advice = r.tier === 'SAVE' ? 'tanker max uplift'
              : r.tier === 'MARGIN' ? 'tanker reasonable'
              : r.tier === 'NEUTRAL' ? 'normal uplift'
              : 'do not tanker'
            return (
              <button key={r.f.icao + r.oI + r.dI} onClick={() => onFly(r.f.icao)}
                className="w-full text-left bg-slate-900/50 hover:bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-lg p-2">
                <div className="flex items-center gap-1.5" style={{ borderLeft: `3px solid ${c}`, paddingLeft: 6 }}>
                  <span className="text-[11px] font-mono font-bold text-slate-100">{r.f.callsign || r.f.icao}</span>
                  <span className="text-[9px] text-slate-500">{r.f.type || '—'}</span>
                  <span className="text-[8px] px-1 rounded bg-slate-800 text-slate-400 font-bold tracking-wider">{KLASS_LABEL[r.klass]}</span>
                  <span className="ml-auto text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded" style={{ background: c + '22', color: c }}>{r.tier}</span>
                </div>
                <div className="flex justify-between text-[10px] mt-1 text-slate-400 font-mono">
                  <span>FL{fl}</span>
                  <span>{r.oI}→{r.dI}</span>
                  <span>{Math.round(r.legNm)}nm</span>
                  <span style={{ color: c }}>{r.savingsUSD >= 0 ? '+' : '-'}${Math.abs(Math.round(r.savingsUSD))}</span>
                </div>
                {/* savings bar */}
                <div className="relative h-1.5 mt-1 bg-slate-800 rounded overflow-hidden">
                  <div className="absolute top-0 bottom-0" style={{ left: '50%', width: 1, background: '#475569' }} />
                  <div className="absolute top-0 bottom-0" style={{
                    left: r.savingsUSD >= 0 ? '50%' : `${50 + Math.max(-50, r.savingsUSD / MAX_USD * 50)}%`,
                    width: `${Math.min(50, Math.abs(r.savingsUSD) / MAX_USD * 50)}%`,
                    background: c,
                    opacity: 0.8,
                  }} />
                </div>
                <div className="flex justify-between text-[9px] mt-1 text-slate-500 font-mono">
                  <span>${r.oPrice.toFixed(2)}/USG {r.oKnown ? '' : '~'}</span>
                  <span style={{ color: r.priceDelta >= 0.2 ? '#10b981' : r.priceDelta <= -0.2 ? '#ef4444' : '#64748b' }}>Δ{r.priceDelta >= 0 ? '+' : ''}{r.priceDelta.toFixed(2)}</span>
                  <span>${r.dPrice.toFixed(2)}/USG {r.dKnown ? '' : '~'}</span>
                </div>
                <div className="flex justify-between text-[9px] mt-0.5 text-slate-500 font-mono">
                  <span>uplift {Math.round(r.tankerKg / 100) / 10}t</span>
                  <span>burn-pen {Math.round(r.burnPenaltyKg)}kg</span>
                  <span>trip {Math.round(r.tripFuelKg / 100) / 10}t</span>
                  <span>{r.marginPctTrip >= 0 ? '+' : ''}{r.marginPctTrip.toFixed(1)}%</span>
                </div>
                {r.curfeeUSD > 0 && (
                  <div className="text-[9px] text-amber-400 font-mono mt-0.5">noise-fee penalty -${Math.round(r.curfeeUSD)}</div>
                )}
                <div className="text-[9px] mt-1 font-mono" style={{ color: c }}>{advice}</div>
                <div className="text-[9px] text-slate-600 mt-0.5">{r.oIcao} {r.oName} → {r.dIcao} {r.dName}</div>
              </button>
            )
          })}

          {tab === 'PAIRS' && pairs.length === 0 && (
            <div className="text-[11px] text-slate-500 px-2 py-4 text-center">No O→D pairs in the current filter set.</div>
          )}

          {tab === 'PAIRS' && pairs.map(p => {
            const c = TIER_COLOR[p.tier]
            const delta = p.dPrice - p.oPrice
            return (
              <button key={p.key} onClick={() => {
                const [la, lo] = gcInterp(p.oLat, p.oLng, p.dLat, p.dLng, 0.5)
                const fAt = filtered.find(r => r.oI === p.oI && r.dI === p.dI)
                if (fAt) onFly(fAt.f.icao)
                else if (map) map.flyTo({ center: [lo, la], zoom: 4 })
              }}
                className="w-full text-left bg-slate-900/50 hover:bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-lg p-2">
                <div className="flex items-center gap-1.5" style={{ borderLeft: `3px solid ${c}`, paddingLeft: 6 }}>
                  <span className="text-[11px] font-mono font-bold text-slate-100">{p.oI}→{p.dI}</span>
                  <span className="text-[9px] text-slate-500">{p.n} ac</span>
                  <span className="ml-auto text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded" style={{ background: c + '22', color: c }}>{p.tier}</span>
                </div>
                <div className="flex justify-between text-[10px] mt-1 text-slate-400 font-mono">
                  <span>${p.oPrice.toFixed(2)}</span>
                  <span style={{ color: delta >= 0.2 ? '#10b981' : delta <= -0.2 ? '#ef4444' : '#64748b' }}>Δ{delta >= 0 ? '+' : ''}{delta.toFixed(2)}</span>
                  <span>${p.dPrice.toFixed(2)}</span>
                </div>
                <div className="relative h-1.5 mt-1 bg-slate-800 rounded overflow-hidden">
                  <div className="absolute top-0 bottom-0" style={{ left: 0, width: `${Math.min(100, Math.abs(p.savings) / (saveThr * 4) * 100)}%`, background: c, opacity: 0.8 }} />
                </div>
                <div className="flex justify-between text-[9px] mt-0.5 text-slate-500 font-mono">
                  <span>avg {p.savings / p.n >= 0 ? '+' : '-'}${Math.abs(Math.round(p.savings / p.n))}/ac</span>
                  <span>{p.savings >= 0 ? '+' : '-'}${Math.abs(Math.round(p.savings))} total</span>
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Cell({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-lg px-2 py-1.5">
      <div className="text-[8px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className="text-sm font-bold font-mono" style={{ color }}>{value}</div>
      {sub && <div className="text-[9px] font-mono" style={{ color }}>{sub}</div>}
    </div>
  )
}

function Slider({ label, v, min, max, step, setV }: { label: string; v: number; min: number; max: number; step?: number; setV: (n: number) => void }) {
  return (
    <label className="text-[10px] text-slate-400 block">
      <div className="font-mono tracking-wider">{label}</div>
      <input type="range" min={min} max={max} step={step || 1} value={v} onChange={e => setV(Number(e.target.value))}
        className="w-full accent-sky-500" />
    </label>
  )
}
