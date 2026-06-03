'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   SAF Blend & CORSIA / ReFuelEU Compliance Monitor
   -----------------------------------------------------------
   Per-airframe Sustainable Aviation Fuel (SAF) blend ratio,
   lifecycle CO2eq saving (gCO2e/MJ vs Jet-A1 89.0 gCO2e/MJ
   baseline per ICAO CORSIA Default Life Cycle Emissions),
   CORSIA offsetting obligation (ICAO Assembly Res A41-22 Vol I)
   and ReFuelEU Aviation Regulation (EU) 2023/2405 minimum
   blend mandate (2pct 2025 / 6pct 2030 / 20pct 2035 / 70pct
   2050) for every flight whose departure airport falls inside
   the per-region SAF supply catalogue.

   References:
     - ICAO CORSIA SARPs Annex 16 Vol IV
     - ICAO CORSIA Eligible Fuels Doc (Default LCA Values 2022)
     - ICAO Doc 9988 CORSIA Implementation Element
     - ICAO Assembly Res A41-22 Long-Term Aspirational Goal
     - EU Reg 2023/2405 (ReFuelEU Aviation)
     - EU Reg 2018/2001 (RED II) Annex IX Part A/B feedstocks
     - US Inflation Reduction Act §40B / §45Z SAF tax credit
     - ASTM D7566 Annex A1–A7 (HEFA / FT / ATJ / CHJ / SIP / SAK)
     - ASTM D1655 Jet-A1 specification
     - IATA Net Zero CO2 by 2050 Resolution
     - ATAG Waypoint 2050 / Mission Possible Partnership
     - CAEP/12 Long Term Aspirational Goal Feasibility WG
     - FAA SAF Grand Challenge / DOE Sustainable Fuels R&D
     - UK Jet Zero Strategy / SAF Mandate 2025

   Per-airport SAF supply catalogue (28 airports):
     - Pathway:  HEFA / ATJ / FT / CHJ / PtL (e-SAF)
     - Feedstock: UCO / TALLOW / SOY / FT-MSW / WOOD / CORN /
                  SUGARCANE / PtL-WIND / PtL-SOLAR
     - LCA gCO2e/MJ (default per CORSIA Tab. 1):
         HEFA-UCO     13.9   ATJ-SUGARCANE 24.0
         HEFA-TALLOW  22.5   FT-MSW         5.2
         HEFA-SOY     40.4   FT-WOOD       12.2
         ATJ-CORN     65.7   CHJ            ~20
         PtL-WIND      8.0   PtL-SOLAR     15.0
     - Available blend ratio (volumetric pct) 0..50 (ASTM D7566
       max 50pct blend until Annex A1 neat-SAF approval).

   Per-airframe metrics (FNV-1a hash of icao24 + airport):
     - Blend used  (pct) — drawn from supply availability × CFO
       Corporate Fuel Offtake share (slider).
     - Block fuel (kg) ≈ class-typical burn × leg-block-time.
     - Lifecycle CO2e (kg) = blockKg · 35.6 MJ/kg ·
         ((1-b)·89.0 + b·pathwayLCA) / 1000
     - vs all-Jet-A baseline CO2e (kg) = blockKg · 35.6 · 89.0
     - CO2 saved (kg) = baseline – lifecycle.
     - CORSIA offset obligation (tCO2e × $25/t indicative).
     - ReFuelEU compliance margin (pct - 2pct/6pct/20pct mandate
       for the target year set in slider).

   Risk components (max-driver composite 0..100):
     MAND   shortfall vs ReFuelEU mandate
     LCA    pathway lifecycle CO2e vs Jet-A baseline
     OFFSET CORSIA offset $/leg
     BLEND  blend below feasibility floor 0.5pct
     PATH   non-eligible pathway flag

   5 tiers:
     NONCOMP score>=80 OR mandate-breach
     SHORT   score>=55  blend below mandate-buffer
     WATCH   score>=25  adverse trend
     COMPLY  score<25   mandate met, savings positive
     IDLE    on ground / no supply data

   Registered in Layers > Environment.
   ft-saf persisted preference.
   ============================================================ */

export interface SafFlight {
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
  flights: SafFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'NONCOMP' | 'SHORT' | 'WATCH' | 'COMPLY' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  NONCOMP: '#ef4444',
  SHORT:   '#f59e0b',
  WATCH:   '#0ea5e9',
  COMPLY:  '#10b981',
  IDLE:    '#64748b',
}
const TIER_ORDER: Tier[] = ['NONCOMP', 'SHORT', 'WATCH', 'COMPLY', 'IDLE']

type Pathway = 'HEFA-UCO' | 'HEFA-TALLOW' | 'HEFA-SOY' | 'FT-MSW' | 'FT-WOOD' | 'ATJ-SUGAR' | 'ATJ-CORN' | 'CHJ' | 'PtL-WIND' | 'PtL-SOLAR'
const PATH_LCA: Record<Pathway, number> = {
  'HEFA-UCO':    13.9, 'HEFA-TALLOW': 22.5, 'HEFA-SOY': 40.4,
  'FT-MSW':       5.2, 'FT-WOOD':     12.2,
  'ATJ-SUGAR':   24.0, 'ATJ-CORN':    65.7,
  'CHJ':         20.0,
  'PtL-WIND':     8.0, 'PtL-SOLAR':   15.0,
}
const PATH_COLOR: Record<Pathway, string> = {
  'HEFA-UCO': '#10b981', 'HEFA-TALLOW': '#34d399', 'HEFA-SOY': '#f59e0b',
  'FT-MSW': '#22d3ee', 'FT-WOOD': '#0ea5e9',
  'ATJ-SUGAR': '#a3e635', 'ATJ-CORN': '#ef4444',
  'CHJ': '#7dd3fc',
  'PtL-WIND': '#c084fc', 'PtL-SOLAR': '#facc15',
}
const JETA_LCA = 89.0       // gCO2e/MJ default
const JETA_MJ_KG = 43.2     // Jet-A1 LHV MJ/kg
const SAF_MJ_KG = 43.6      // SAF approximate LHV MJ/kg

type Klass = 'heavy-lr' | 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga'
interface ClassSpec { burnKgHr: number; mtow: number; nm: number }
const SPEC: Record<Klass, ClassSpec> = {
  'heavy-lr': { burnKgHr: 7200, mtow: 380000, nm: 6500 },
  'heavy':    { burnKgHr: 5800, mtow: 230000, nm: 3500 },
  'narrow':   { burnKgHr: 2500, mtow:  79000, nm: 2200 },
  'regional': { burnKgHr: 1300, mtow:  41000, nm:  900 },
  'biz':      { burnKgHr:  900, mtow:  35000, nm: 2800 },
  'turboprop':{ burnKgHr:  600, mtow:  21500, nm:  600 },
  'ga':       { burnKgHr:   45, mtow:   2200, nm:  400 },
}
function classify(t: string | undefined): Klass {
  const x = (t || '').toUpperCase()
  if (/^(A38|B74|B77W|B77L|B77F|B78|A35|A33|A34|B76)/.test(x)) return 'heavy-lr'
  if (/^(B77|MD11|IL96|A30|A31|B75)/.test(x)) return 'heavy'
  if (/^(A19|A20|A21|A22|B73|B72|B71|MD8|MD9|E19|E29|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|DH8|AT4|AT5|AT7|SF34)/.test(x)) {
    if (/^(AT|DH|SF)/.test(x)) return 'turboprop'
    return 'regional'
  }
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(ATR|TBM|PC12|PC6|BE9|BE3|C72|C82|P28|SR2|DA4|DA62|PA|M20|TB|DHC2|DHC6)/.test(x)) return 'turboprop'
  if (/^(C1|C2|C7|R44|R66)/.test(x)) return 'ga'
  return 'narrow'
}

// 28-airport SAF supply catalogue
interface AptSaf { iata: string; lat: number; lng: number; pathways: Pathway[]; availPct: number; region: string }
const APT_SAF: AptSaf[] = [
  // Europe (ReFuelEU mandate jurisdiction)
  { iata:'LHR', lat:51.47, lng:-0.46, pathways:['HEFA-UCO','PtL-WIND'], availPct:35, region:'EU-UK' },
  { iata:'CDG', lat:49.01, lng:2.55,  pathways:['HEFA-UCO','HEFA-TALLOW','PtL-WIND'], availPct:30, region:'EU-FR' },
  { iata:'AMS', lat:52.31, lng:4.76,  pathways:['HEFA-UCO','FT-MSW','PtL-WIND'], availPct:40, region:'EU-NL' },
  { iata:'FRA', lat:50.04, lng:8.56,  pathways:['HEFA-UCO','PtL-WIND','FT-WOOD'], availPct:32, region:'EU-DE' },
  { iata:'MUC', lat:48.35, lng:11.79, pathways:['HEFA-UCO','PtL-SOLAR'], availPct:25, region:'EU-DE' },
  { iata:'MAD', lat:40.49, lng:-3.57, pathways:['HEFA-UCO','PtL-SOLAR'], availPct:22, region:'EU-ES' },
  { iata:'BCN', lat:41.30, lng:2.08,  pathways:['HEFA-UCO'], availPct:18, region:'EU-ES' },
  { iata:'ZRH', lat:47.46, lng:8.55,  pathways:['HEFA-UCO','PtL-WIND'], availPct:28, region:'CH' },
  { iata:'CPH', lat:55.62, lng:12.65, pathways:['HEFA-UCO','FT-WOOD','PtL-WIND'], availPct:42, region:'EU-DK' },
  { iata:'ARN', lat:59.65, lng:17.92, pathways:['FT-WOOD','HEFA-TALLOW','PtL-WIND'], availPct:50, region:'EU-SE' },
  { iata:'OSL', lat:60.19, lng:11.10, pathways:['HEFA-UCO','PtL-WIND'], availPct:50, region:'NO' },
  { iata:'HEL', lat:60.32, lng:24.96, pathways:['HEFA-UCO','FT-MSW','HEFA-TALLOW'], availPct:45, region:'EU-FI' },
  { iata:'IST', lat:41.26, lng:28.74, pathways:['HEFA-UCO'], availPct:8,  region:'TR' },
  { iata:'FCO', lat:41.80, lng:12.25, pathways:['HEFA-UCO'], availPct:15, region:'EU-IT' },
  // North America (CORSIA + IRA §45Z)
  { iata:'ORD', lat:41.98, lng:-87.91,pathways:['HEFA-UCO','ATJ-CORN','FT-MSW'], availPct:18, region:'US-IL' },
  { iata:'LAX', lat:33.94, lng:-118.41,pathways:['HEFA-UCO','HEFA-TALLOW','HEFA-SOY'], availPct:25, region:'US-CA' },
  { iata:'SFO', lat:37.62, lng:-122.37,pathways:['HEFA-UCO','HEFA-TALLOW','PtL-SOLAR'], availPct:30, region:'US-CA' },
  { iata:'JFK', lat:40.64, lng:-73.78, pathways:['HEFA-UCO','FT-MSW'], availPct:15, region:'US-NY' },
  { iata:'EWR', lat:40.69, lng:-74.17, pathways:['HEFA-UCO','FT-MSW'], availPct:14, region:'US-NJ' },
  { iata:'SEA', lat:47.45, lng:-122.31,pathways:['HEFA-UCO','FT-WOOD'], availPct:20, region:'US-WA' },
  { iata:'DEN', lat:39.86, lng:-104.67,pathways:['ATJ-CORN','HEFA-SOY'], availPct:10, region:'US-CO' },
  { iata:'DFW', lat:32.90, lng:-97.04, pathways:['HEFA-SOY','ATJ-CORN'], availPct: 8, region:'US-TX' },
  { iata:'ATL', lat:33.64, lng:-84.43, pathways:['HEFA-SOY'], availPct: 6, region:'US-GA' },
  { iata:'YYZ', lat:43.68, lng:-79.63, pathways:['HEFA-UCO','HEFA-TALLOW'], availPct:12, region:'CA-ON' },
  { iata:'YVR', lat:49.19, lng:-123.18,pathways:['HEFA-UCO','FT-WOOD'], availPct:18, region:'CA-BC' },
  // Asia-Pacific
  { iata:'SIN', lat:1.36,  lng:103.99, pathways:['HEFA-UCO','HEFA-TALLOW'], availPct:35, region:'SG' },
  { iata:'HND', lat:35.55, lng:139.78, pathways:['HEFA-UCO','ATJ-SUGAR'], availPct:14, region:'JP' },
  { iata:'NRT', lat:35.76, lng:140.39, pathways:['HEFA-UCO','ATJ-SUGAR'], availPct:12, region:'JP' },
]

function hash32(s: string): number {
  let h = 0x811c9dc5 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}
function haversineNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 3440.065
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dφ = (la2 - la1) * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dλ = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

interface Row {
  f: SafFlight
  klass: Klass
  spec: ClassSpec
  origIata: string
  origLat: number
  origLng: number
  region: string
  pathway: Pathway
  blendPct: number          // actual blend pct
  blockKg: number           // estimated block fuel
  lcaG: number              // gCO2e/MJ effective
  co2Lifecycle: number      // kg
  co2Baseline: number       // kg
  co2Saved: number          // kg
  offsetUsd: number         // $/leg @ 25/t
  mandatePct: number        // ReFuelEU target for selected year
  margin: number            // blendPct - mandate
  score: number
  driver: string
  tier: Tier
}

const SRC_HALO = 'saf-halo', SRC_LBL = 'saf-lbl', SRC_APT = 'saf-apt', SRC_LEG = 'saf-leg'
const LYR_HALO = 'saf-halo-l', LYR_LBL = 'saf-lbl-l', LYR_APT = 'saf-apt-l', LYR_APT_LBL = 'saf-apt-lbl-l', LYR_LEG = 'saf-leg-l'

export default function SafCorsia({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS' | 'PATHWAYS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [pathFilter, setPathFilter] = useState<Pathway | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [capture, setCapture] = useState(120)
  const [targetYear, setTargetYear] = useState(2030)         // 2025/2030/2035/2050
  const [cfoShare, setCfoShare] = useState(75)               // 0..100 % of available supply
  const [carbonUsd, setCarbonUsd] = useState(25)             // $/tCO2e
  const [bufferPct, setBufferPct] = useState(1)              // mandate buffer above
  const [showHalo, setShowHalo] = useState(true)
  const [showLeg, setShowLeg] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showApt, setShowApt] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const mandate = useMemo(() => {
    // ReFuelEU stepped mandate
    if (targetYear < 2025) return 0
    if (targetYear < 2030) return 2
    if (targetYear < 2032) return 6
    if (targetYear < 2035) return 6
    if (targetYear < 2040) return 20
    if (targetYear < 2045) return 32
    if (targetYear < 2050) return 38
    return 70
  }, [targetYear])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (!isFinite(fl) || fl < minFl) continue

      // Find nearest catalogued origin airport (departing aircraft within capture, behind track)
      let best: AptSaf | null = null
      let bestD = Infinity
      for (const a of APT_SAF) {
        const d = haversineNm(f.lat, f.lng, a.lat, a.lng)
        if (d > capture) continue
        // origin is BEHIND the aircraft (bearing roughly opposite track)
        const br = bearingDeg(f.lat, f.lng, a.lat, a.lng)
        const opp = (f.track + 180 + 360) % 360
        const ddeg = Math.abs(((br - opp + 540) % 360) - 180)
        if (ddeg > 75) continue
        if (d < bestD) { bestD = d; best = a }
      }
      if (!best) continue

      const klass = classify(f.type)
      const spec = SPEC[klass]
      const h = hash32(f.icao || '')

      // Pathway: hash pick from available
      const pathway = best.pathways[h % best.pathways.length]
      const lca = PATH_LCA[pathway]

      // Blend pct = min(supply availability * CFO share, ASTM 50 cap), with per-airframe variance
      const variance = ((h >>> 7) % 30) / 100   // 0..0.30
      const rawBlend = best.availPct * (cfoShare / 100) * (0.7 + variance)
      const blendPct = Math.max(0, Math.min(50, rawBlend))

      // Block fuel estimate (block-time 2..6 hr)
      const blockHr = 2 + ((h >>> 13) % 40) / 10
      const blockKg = spec.burnKgHr * blockHr

      // Lifecycle gCO2e/MJ
      const b = blendPct / 100
      const lcaG = (1 - b) * JETA_LCA + b * lca
      const co2Lifecycle = blockKg * JETA_MJ_KG * lcaG / 1000   // kg
      const co2Baseline = blockKg * JETA_MJ_KG * JETA_LCA / 1000
      const co2Saved = co2Baseline - co2Lifecycle

      const offsetUsd = co2Lifecycle / 1000 * carbonUsd

      const mandatePct = mandate
      const margin = blendPct - mandatePct

      // Risk components
      const sMand = mandatePct <= 0 ? 0 : Math.max(0, Math.min(100, ((mandatePct + bufferPct) - blendPct) / Math.max(1, mandatePct + bufferPct) * 100))
      const sLca = Math.max(0, Math.min(100, (lcaG / JETA_LCA) * 100 - 20))
      const sOff = Math.max(0, Math.min(100, offsetUsd / 1500 * 100))
      const sBld = blendPct < 0.5 ? 100 : Math.max(0, 20 - blendPct * 2)
      const sPath = lca > 70 ? 100 : 0   // non-eligible high-LCA pathway

      const drivers: [string, number][] = [
        ['MAND', sMand], ['LCA', sLca], ['OFFSET', sOff], ['BLEND', sBld], ['PATH', sPath]
      ]
      drivers.sort((a, b) => b[1] - a[1])
      const score = Math.min(100, drivers[0][1])
      const driver = drivers[0][0]

      let tier: Tier
      if (best.availPct <= 0) tier = 'IDLE'
      else if (score >= 80 || (mandatePct > 0 && blendPct < mandatePct)) tier = 'NONCOMP'
      else if (score >= 55) tier = 'SHORT'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'COMPLY'

      out.push({
        f, klass, spec,
        origIata: best.iata, origLat: best.lat, origLng: best.lng, region: best.region,
        pathway, blendPct, blockKg, lcaG, co2Lifecycle, co2Baseline, co2Saved, offsetUsd,
        mandatePct, margin, score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, capture, cfoShare, carbonUsd, mandate, bufferPct])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (pathFilter !== 'ALL' && r.pathway !== pathFilter) return false
      if (q && !(r.f.callsign?.toUpperCase().includes(q) || r.origIata.includes(q) || (r.f.type || '').toUpperCase().includes(q) || r.pathway.includes(q))) return false
      return true
    })
  }, [rows, tierFilter, pathFilter, query])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { NONCOMP: 0, SHORT: 0, WATCH: 0, COMPLY: 0, IDLE: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const fleetSaved = useMemo(() => rows.reduce((s, r) => s + r.co2Saved, 0), [rows])
  const fleetOffset = useMemo(() => rows.reduce((s, r) => s + r.offsetUsd, 0), [rows])
  const meanBlend = useMemo(() => rows.length ? rows.reduce((s, r) => s + r.blendPct, 0) / rows.length : 0, [rows])
  const meanLca = useMemo(() => rows.length ? rows.reduce((s, r) => s + r.lcaG, 0) / rows.length : 0, [rows])

  // MapLibre rendering
  useEffect(() => {
    if (!map) return
    const m = map
    const ensure = () => {
      const haloGj: any = { type: 'FeatureCollection', features: [] }
      const lblGj: any = { type: 'FeatureCollection', features: [] }
      const aptGj: any = { type: 'FeatureCollection', features: [] }
      const legGj: any = { type: 'FeatureCollection', features: [] }
      const seenApt = new Set<string>()

      for (const r of filtered) {
        const c = TIER_COLOR[r.tier]
        if (showHalo) {
          haloGj.features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { c, mag: 6 + r.score * 0.18 } })
        }
        if (showLeg) {
          legGj.features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[r.origLng, r.origLat], [r.f.lng, r.f.lat]] },
            properties: { c },
          })
        }
        if (showLabels && r.tier !== 'COMPLY' && r.tier !== 'IDLE') {
          lblGj.features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
            properties: {
              t: `${r.f.callsign || r.f.icao}  ${r.pathway}  ${r.blendPct.toFixed(1)}%  Δ${r.margin >= 0 ? '+' : ''}${r.margin.toFixed(1)}`,
              c,
            },
          })
        }
      }
      if (showApt) {
        for (const a of APT_SAF) {
          if (seenApt.has(a.iata)) continue
          seenApt.add(a.iata)
          const dominant = a.pathways[0]
          aptGj.features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [a.lng, a.lat] },
            properties: {
              t: `›${a.iata} ${a.availPct}%`,
              c: PATH_COLOR[dominant],
              r: 4 + Math.min(8, a.availPct / 6),
            },
          })
        }
      }

      const upsertSrc = (id: string, gj: any) => {
        const src = m.getSource(id) as any
        if (src) src.setData(gj)
        else m.addSource(id, { type: 'geojson', data: gj })
      }
      upsertSrc(SRC_HALO, haloGj)
      upsertSrc(SRC_LEG, legGj)
      upsertSrc(SRC_LBL, lblGj)
      upsertSrc(SRC_APT, aptGj)

      if (!m.getLayer(LYR_LEG)) m.addLayer({ id: LYR_LEG, type: 'line', source: SRC_LEG, paint: { 'line-color': ['get', 'c'], 'line-width': 1.4, 'line-opacity': 0.45, 'line-dasharray': [3, 3] } })
      if (!m.getLayer(LYR_HALO)) m.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'mag'], 'circle-color': ['get', 'c'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'c'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.7 } })
      if (!m.getLayer(LYR_APT)) m.addLayer({ id: LYR_APT, type: 'circle', source: SRC_APT, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'c'], 'circle-opacity': 0.45, 'circle-stroke-color': ['get', 'c'], 'circle-stroke-width': 1 } })
      if (!m.getLayer(LYR_APT_LBL)) m.addLayer({ id: LYR_APT_LBL, type: 'symbol', source: SRC_APT, layout: { 'text-field': ['get', 't'], 'text-size': 10, 'text-offset': [0, -1.3], 'text-anchor': 'bottom', 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#a3e635', 'text-halo-color': '#020617', 'text-halo-width': 1.2 } })
      if (!m.getLayer(LYR_LBL)) m.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 't'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } })
    }
    if (m.isStyleLoaded()) ensure()
    else m.once('load', ensure)

    return () => {
      try {
        for (const lyr of [LYR_LBL, LYR_APT_LBL, LYR_APT, LYR_HALO, LYR_LEG]) if (m.getLayer(lyr)) m.removeLayer(lyr)
        for (const src of [SRC_APT, SRC_LBL, SRC_HALO, SRC_LEG]) if (m.getSource(src)) m.removeSource(src)
      } catch {}
    }
  }, [map, filtered, showHalo, showLeg, showLabels, showApt])

  const sorted = useMemo(() => {
    const ord: Record<Tier, number> = { NONCOMP: 0, SHORT: 1, WATCH: 2, COMPLY: 3, IDLE: 4 }
    return [...filtered].sort((a, b) => {
      const d = ord[a.tier] - ord[b.tier]
      if (d) return d
      return b.score - a.score
    })
  }, [filtered])

  // Airport aggregate
  const aptAgg = useMemo(() => {
    const m = new Map<string, { iata: string; region: string; pathways: Pathway[]; availPct: number; n: number; meanBlend: number; saved: number; nonCount: number }>()
    for (const a of APT_SAF) m.set(a.iata, { iata: a.iata, region: a.region, pathways: a.pathways, availPct: a.availPct, n: 0, meanBlend: 0, saved: 0, nonCount: 0 })
    for (const r of rows) {
      const e = m.get(r.origIata); if (!e) continue
      e.n++; e.meanBlend += r.blendPct; e.saved += r.co2Saved
      if (r.tier === 'NONCOMP') e.nonCount++
    }
    return Array.from(m.values()).map(e => ({ ...e, meanBlend: e.n ? e.meanBlend / e.n : 0 })).sort((a, b) => b.availPct - a.availPct)
  }, [rows])

  // Pathway aggregate
  const pathAgg = useMemo(() => {
    const m = new Map<Pathway, { p: Pathway; n: number; meanBlend: number; saved: number; meanLca: number }>()
    for (const r of rows) {
      const e = m.get(r.pathway) || { p: r.pathway, n: 0, meanBlend: 0, saved: 0, meanLca: 0 }
      e.n++; e.meanBlend += r.blendPct; e.saved += r.co2Saved; e.meanLca += r.lcaG
      m.set(r.pathway, e)
    }
    return Array.from(m.values()).map(e => ({ ...e, meanBlend: e.n ? e.meanBlend / e.n : 0, meanLca: e.n ? e.meanLca / e.n : 0 })).sort((a, b) => b.n - a.n)
  }, [rows])

  return (
    <div className="absolute top-14 right-2 z-30 w-[420px] max-h-[88vh] overflow-y-auto bg-slate-900/95 backdrop-blur-md border border-slate-700/60 rounded-lg shadow-2xl text-slate-200 text-[12px]">
      <div className="sticky top-0 bg-slate-900/95 backdrop-blur border-b border-slate-700/60 px-3 py-2 flex items-center justify-between">
        <div>
          <div className="text-slate-100 font-semibold tracking-wide">SAF · CORSIA · ReFuelEU</div>
          <div className="text-[10px] text-slate-500 leading-tight">Blend pct · LCA gCO2e/MJ · mandate {mandate}% @ {targetYear}</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-xl leading-none px-1">×</button>
      </div>

      {/* Summary cells */}
      <div className="px-3 py-2 grid grid-cols-3 gap-1.5 border-b border-slate-800">
        <div className="bg-slate-800/60 rounded px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">Tracked</div>
          <div className="text-slate-100 text-base font-semibold leading-tight">{rows.length}</div>
        </div>
        <div className="bg-slate-800/60 rounded px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">Mean blend</div>
          <div className="leading-tight" style={{ color: meanBlend < mandate ? '#f59e0b' : '#10b981' }}><span className="text-base font-semibold">{meanBlend.toFixed(1)}</span><span className="text-[10px] text-slate-500"> %</span></div>
        </div>
        <div className="bg-slate-800/60 rounded px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">Non-comp</div>
          <div className="text-rose-400 text-base font-semibold leading-tight">{counts.NONCOMP}</div>
        </div>
        <div className="bg-slate-800/60 rounded px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">CO₂ saved</div>
          <div className="text-emerald-400 text-base font-semibold leading-tight">{(fleetSaved / 1000).toFixed(1)}<span className="text-[10px] text-slate-500"> t</span></div>
        </div>
        <div className="bg-slate-800/60 rounded px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">Mean LCA</div>
          <div className="text-slate-100 text-base font-semibold leading-tight">{meanLca.toFixed(1)}<span className="text-[10px] text-slate-500"> g/MJ</span></div>
        </div>
        <div className="bg-slate-800/60 rounded px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">Offset</div>
          <div className="text-slate-100 text-base font-semibold leading-tight">${(fleetOffset / 1000).toFixed(1)}<span className="text-[10px] text-slate-500"> k</span></div>
        </div>
      </div>

      {/* Tier chips */}
      <div className="px-3 py-2 flex flex-wrap gap-1 border-b border-slate-800">
        {(['ALL', ...TIER_ORDER] as const).map(t => {
          const active = tierFilter === t
          const col = t === 'ALL' ? '#94a3b8' : TIER_COLOR[t as Tier]
          const n = t === 'ALL' ? rows.length : counts[t as Tier]
          return (
            <button key={t} onClick={() => setTierFilter(t as any)} className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: active ? col + '26' : '#1e293b80', color: active ? col : '#94a3b8', border: `1px solid ${active ? col + '66' : '#33415555'}` }}>{t} {n}</button>
          )
        })}
      </div>

      {/* Pathway chips */}
      <div className="px-3 py-2 flex flex-wrap gap-1 border-b border-slate-800">
        <span className="text-[10px] text-slate-500 mr-1 self-center">PATH</span>
        <button onClick={() => setPathFilter('ALL')} className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: pathFilter === 'ALL' ? '#94a3b826' : '#1e293b80', color: pathFilter === 'ALL' ? '#94a3b8' : '#94a3b8', border: `1px solid ${pathFilter === 'ALL' ? '#94a3b866' : '#33415555'}` }}>ALL</button>
        {(Object.keys(PATH_LCA) as Pathway[]).map(p => {
          const active = pathFilter === p
          const col = PATH_COLOR[p]
          return (
            <button key={p} onClick={() => setPathFilter(p)} className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: active ? col + '26' : '#1e293b80', color: active ? col : '#94a3b8', border: `1px solid ${active ? col + '66' : '#33415555'}` }}>{p}</button>
          )
        })}
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 grid grid-cols-2 gap-2 border-b border-slate-800 text-[10px]">
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">MIN FL {minFl}</span>
          <input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">CAPTURE {capture} nm</span>
          <input type="range" min={20} max={400} value={capture} onChange={e => setCapture(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">YEAR {targetYear} · {mandate}%</span>
          <input type="range" min={2024} max={2050} step={1} value={targetYear} onChange={e => setTargetYear(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">CFO {cfoShare}%</span>
          <input type="range" min={0} max={100} value={cfoShare} onChange={e => setCfoShare(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">CARBON ${carbonUsd}/t</span>
          <input type="range" min={5} max={200} value={carbonUsd} onChange={e => setCarbonUsd(+e.target.value)} className="accent-sky-500" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">BUFFER +{bufferPct}%</span>
          <input type="range" min={0} max={10} step={0.5} value={bufferPct} onChange={e => setBufferPct(+e.target.value)} className="accent-sky-500" />
        </label>
      </div>

      {/* Overlay toggles + search */}
      <div className="px-3 py-2 flex flex-wrap items-center gap-1.5 border-b border-slate-800 text-[10px]">
        {[
          ['HALO', showHalo, setShowHalo],
          ['LEG', showLeg, setShowLeg],
          ['LBL', showLabels, setShowLabels],
          ['APT', showApt, setShowApt],
          ['DIAG', showDiag, setShowDiag],
        ].map(([l, v, s]: any) => (
          <button key={l} onClick={() => s(!v)} className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: v ? 'rgba(14,165,233,0.15)' : '#1e293b80', color: v ? '#7dd3fc' : '#94a3b8', border: `1px solid ${v ? 'rgba(14,165,233,0.4)' : '#33415555'}` }}>{l}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search" className="flex-1 min-w-[80px] bg-slate-800/60 border border-slate-700/50 rounded px-1.5 py-0.5 text-[10px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50" />
      </div>

      {/* Diagnostic SVG: Blend pct vs LCA */}
      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[10px] text-slate-500 mb-1">Blend % vs LCA gCO2e/MJ · mandate {mandate}% · Jet-A1 baseline {JETA_LCA}</div>
          <svg viewBox="0 0 320 120" className="w-full">
            {/* mandate vertical */}
            <rect x={0} y={0} width={mandate / 50 * 320} height={120} fill="#ef4444" fillOpacity="0.08" />
            <line x1={mandate / 50 * 320} y1={0} x2={mandate / 50 * 320} y2={120} stroke="#ef4444" strokeWidth="0.8" strokeDasharray="3 3" />
            {/* Jet-A baseline horizontal */}
            <line x1={0} y1={120 - JETA_LCA / 100 * 120} x2={320} y2={120 - JETA_LCA / 100 * 120} stroke="#64748b" strokeWidth="0.5" strokeDasharray="2 2" />
            {[10, 20, 30, 40].map(v => (
              <line key={v} x1={v / 50 * 320} y1={0} x2={v / 50 * 320} y2={120} stroke="#1e293b" strokeWidth="0.5" />
            ))}
            {[20, 40, 60, 80].map(v => (
              <line key={v} x1={0} y1={120 - v / 100 * 120} x2={320} y2={120 - v / 100 * 120} stroke="#1e293b" strokeWidth="0.5" />
            ))}
            {rows.map((r, i) => {
              const x = Math.max(0, Math.min(320, r.blendPct / 50 * 320))
              const y = Math.max(0, Math.min(120, 120 - r.lcaG / 100 * 120))
              return <circle key={i} cx={x} cy={y} r={2.2} fill={TIER_COLOR[r.tier]} fillOpacity="0.85" />
            })}
            {[0, 25, 50].map(v => (
              <text key={v} x={v / 50 * 320 + 2} y={118} fill="#475569" fontSize="8">{v}%</text>
            ))}
            <text x={2} y={10} fill="#475569" fontSize="8">100</text>
            <text x={2} y={118} fill="#475569" fontSize="8">0 g/MJ</text>
          </svg>
        </div>
      )}

      {/* Tabs */}
      <div className="px-3 py-1.5 flex gap-1 border-b border-slate-800 text-[10px]">
        {(['AIRCRAFT', 'AIRPORTS', 'PATHWAYS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className="px-2 py-0.5 rounded font-medium" style={{ background: tab === t ? 'rgba(14,165,233,0.15)' : 'transparent', color: tab === t ? '#7dd3fc' : '#94a3b8', border: `1px solid ${tab === t ? 'rgba(14,165,233,0.4)' : 'transparent'}` }}>{t}</button>
        ))}
      </div>

      {/* List */}
      <div className="px-2 py-1.5">
        {tab === 'AIRCRAFT' && (
          <>
            {sorted.length === 0 && <div className="text-slate-500 text-center py-4 text-[11px]">No flights in capture window.</div>}
            {sorted.slice(0, 100).map((r, i) => (
              <button key={i} onClick={() => onFly(r.f.icao)} className="w-full text-left px-2 py-1.5 mb-1 rounded bg-slate-800/40 hover:bg-slate-800/70 transition">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: TIER_COLOR[r.tier] }} />
                  <span className="text-slate-100 font-mono text-[11px] w-[68px] truncate">{r.f.callsign || r.f.icao}</span>
                  <span className="text-slate-500 text-[10px] w-[36px] truncate">{r.f.type || '—'}</span>
                  <span className="px-1 rounded text-[9px]" style={{ background: PATH_COLOR[r.pathway] + '26', color: PATH_COLOR[r.pathway], border: `1px solid ${PATH_COLOR[r.pathway]}55` }}>{r.pathway}</span>
                  <span className="ml-auto text-[10px] tabular-nums" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-400">
                  <span>›{r.origIata}</span>
                  <span className="tabular-nums">blend <span style={{ color: r.blendPct < r.mandatePct ? '#f59e0b' : '#10b981' }}>{r.blendPct.toFixed(1)}%</span></span>
                  <span className="tabular-nums">Δ <span style={{ color: r.margin < 0 ? '#ef4444' : '#10b981' }}>{r.margin >= 0 ? '+' : ''}{r.margin.toFixed(1)}</span></span>
                  <span className="tabular-nums">LCA {r.lcaG.toFixed(0)}</span>
                  <span className="ml-auto tabular-nums text-emerald-400">−{(r.co2Saved / 1000).toFixed(2)}t</span>
                </div>
                <div className="flex items-center gap-1 mt-1">
                  <div className="flex-1 h-1 rounded bg-slate-800 overflow-hidden">
                    <div className="h-full" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }} />
                  </div>
                  <span className="text-[9px] text-slate-500 w-[44px] text-right">{r.driver} {r.score.toFixed(0)}</span>
                  <span className="text-[9px] text-slate-500 tabular-nums">${r.offsetUsd.toFixed(0)}</span>
                </div>
              </button>
            ))}
          </>
        )}
        {tab === 'AIRPORTS' && (
          <>
            {aptAgg.map((a, i) => (
              <div key={i} className="px-2 py-1.5 mb-1 rounded bg-slate-800/40">
                <div className="flex items-center gap-2">
                  <span className="text-slate-100 font-mono text-[11px] w-[44px]">{a.iata}</span>
                  <span className="text-slate-500 text-[10px] w-[52px] truncate">{a.region}</span>
                  <span className="text-slate-300 text-[10px] tabular-nums">{a.availPct}%</span>
                  <span className="text-slate-500 text-[10px] tabular-nums">· n {a.n}</span>
                  <span className="ml-auto text-[10px] tabular-nums" style={{ color: a.meanBlend < mandate ? '#f59e0b' : '#10b981' }}>μ {a.meanBlend.toFixed(1)}%</span>
                  {a.nonCount > 0 && <span className="text-rose-400 text-[10px] tabular-nums">!{a.nonCount}</span>}
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {a.pathways.map(p => (
                    <span key={p} className="px-1 rounded text-[9px]" style={{ background: PATH_COLOR[p] + '20', color: PATH_COLOR[p], border: `1px solid ${PATH_COLOR[p]}44` }}>{p} · {PATH_LCA[p]}</span>
                  ))}
                </div>
                {a.saved > 0 && <div className="mt-1 text-[10px] text-emerald-400 tabular-nums">CO₂ saved {(a.saved / 1000).toFixed(2)} t</div>}
              </div>
            ))}
          </>
        )}
        {tab === 'PATHWAYS' && (
          <>
            {(Object.keys(PATH_LCA) as Pathway[]).map((p, i) => {
              const agg = pathAgg.find(x => x.p === p)
              const n = agg?.n || 0
              const meanB = agg?.meanBlend || 0
              const saved = agg?.saved || 0
              const lca = PATH_LCA[p]
              const cut = ((JETA_LCA - lca) / JETA_LCA) * 100
              return (
                <div key={i} className="px-2 py-1.5 mb-1 rounded bg-slate-800/40">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: PATH_COLOR[p] }} />
                    <span className="text-slate-100 font-mono text-[11px] w-[100px]">{p}</span>
                    <span className="text-slate-300 text-[10px] tabular-nums">LCA {lca.toFixed(1)}</span>
                    <span className="text-emerald-400 text-[10px] tabular-nums">−{cut.toFixed(0)}%</span>
                    <span className="ml-auto text-slate-400 text-[10px] tabular-nums">n {n}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-500">
                    <div className="flex-1 h-1 rounded bg-slate-800 overflow-hidden">
                      <div className="h-full" style={{ width: `${Math.min(100, lca / JETA_LCA * 100)}%`, background: PATH_COLOR[p] }} />
                    </div>
                    <span className="tabular-nums">μ blend {meanB.toFixed(1)}%</span>
                    <span className="tabular-nums text-emerald-400">{(saved / 1000).toFixed(2)} t</span>
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 tracking-wide leading-snug">
        CORSIA Annex 16 Vol IV · ReFuelEU Reg 2023/2405 · ASTM D7566 · 89.0 gCO2e/MJ Jet-A1 baseline
      </div>
    </div>
  )
}
