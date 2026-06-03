'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   SATCOM / HF Voice Coverage Monitor
   -----------------------------------------------------------
   ICAO Annex 10 Vol III / ARINC 741 SATCOM AES / ITU-R F.339-8
   Air-ground voice link-budget watch for every airborne aircraft.

   Per aircraft computes 4 parallel link availabilities:

     1) VHF AM line-of-sight to the nearest IATA airport (proxy
        for ATC VHF tower). Optical horizon for an antenna pair
        at heights h_ac (ft) and h_grd (50 ft mast):
            range_nm ≈ 1.23·√h_ac + 1.23·√h_grd
        (FAA AIM 4-2-1 horizon formula). Aircraft is VHF-COVERED
        if great-circle distance to nearest airport ≤ range_nm
        scaled by VHF-MARGIN slider 60-150 pct (frequency-fade
        + terrain shadowing fudge factor).

     2) Inmarsat Classic Aero / SwiftBroadband geostationary
        SATCOM (I-3 / I-4 / I-5 GX) — 4 GEO sats parked at
        +/-15deg roll-off from sub-satellite point. Coverage gap
        above |lat| 80deg (Inmarsat Aero polar hole per ICAO
        Doc 9925 Vol IV) — aircraft above latitude limit loses
        the link. Quality scales with |lat| as cos((|lat|/80)*pi/2)
        producing 1.0 at equator down to 0.0 at 80deg. Equipped
        probability per class from EASA SATCOM Survey 2023
        (HVY 0.97 / NRW 0.55 / RGN 0.30 / BIZ 0.94 / TBP 0.10 /
        GA 0.02 / FTR 0.20 satcom-via-tactical), deterministic
        FNV-1a hash of ICAO24 picks stable per-airframe equipped
        vs not, biased by EQUIP-BIAS slider 50-150 pct.

     3) Iridium L-band global LEO constellation (66 sats) —
        full pole-to-pole coverage including polar regions where
        Inmarsat fails. Quality 1.0 everywhere. Equipped
        probability per class (HVY 0.85 / NRW 0.45 / RGN 0.40 /
        BIZ 0.90 / TBP 0.55 / GA 0.30 newer GA portable units /
        FTR 0.65) per CMC Aviation Iridium Aero Brief 2024.

     4) HF SSB SELCAL upper / lower 3-22 MHz fallback per
        ICAO Annex 10 Vol III chapter 2. Solar SSN (sunspot
        number) drives MUF (max usable frequency) and absorption.
        Effective HF availability = base 0.70 modulated by
        cos(local-solar-time-from-noon) (better daylight DAY
        bands 8/11/13 MHz; worse during sunrise/sunset deep
        fades and at high lat where polar cap absorption PCA
        cuts in). HF-SSN slider 0-200 percent simulates solar
        cycle peak vs trough. PCA penalty |lat|>=70 deg gets
        availability × 0.4 (absorption per ITU-R Rec P.531-15).

   Primary voice link chosen as the highest-availability of the
   four with VHF preferred when both VHF and SAT are available
   for latency. PRIMARY tag = VHF / SAT-I / SAT-IR / HF / NONE.

   Redundancy count = how many of the four are AVAILABLE (>=0.5
   quality). Classifies into 5 tiers:

     REDUNDANT redundancy >= 3 emerald (multiple backups)
     PRIMARY-VHF VHF available emerald
     SATCOM-ONLY VHF gone, satcom up sky
     HF-ONLY only HF up amber (degraded comms - SELCAL polling)
     DARK no link rose (NORDO advisory - lost-comms procedure)

   MapLibre overlay:
     - Tier-coloured halo ring sized by 22 - 4*redundancy
       (worse coverage = bigger halo for ops focus).
     - Emerald dashed VHF line-of-sight circle for aircraft
       altitude (24-segment poly) showing horizon footprint.
     - Sky dashed line aircraft -> nearest covering airport for
       SATCOM-ONLY / HF-ONLY / DARK aircraft.
     - Tier-coloured callsign+PRIMARY-tag labels for non
       REDUNDANT aircraft.

   Side panel:
     - 5-tier counter strip click-to-filter (+ ALL).
     - 3-cell MEAN-REDUNDANCY tier-coloured / WORST callsign+
       primary / DARK-COUNT rose-if-any summary.
     - 2-cell SATCOM-ONLY count / HF-ONLY count secondary row.
     - SVG redundancy-vs-|lat| scatter (x=|lat| 0-90 with
       polar-circle 66.5 amber and inmarsat-edge 80 rose
       verticals, y=0..4 redundancy with tier band shading,
       every aircraft plotted as tier-coloured dot).
     - 5 sliders MIN-FL 0-400 / MAX-FL 50-450 / VHF-MARGIN
       60-150pct / EQUIP-BIAS 50-150pct / HF-SSN 0-200pct.
     - 7-class chip filter.
     - HALO/HRZ/LBL/DIAG toggles.
     - Search.
     - AIRCRAFT/LINKS tab switcher.
     - AIRCRAFT tab sorted tier-worst-first then redundancy asc.
     - LINKS tab grouped by PRIMARY link.

   Registered in Layers > Safety & Traffic category.
   ft-satcom persisted preference.
   ============================================================ */

export interface SatcomFlight {
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
  flights: SatcomFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'REDUNDANT' | 'PRIMARY-VHF' | 'SATCOM-ONLY' | 'HF-ONLY' | 'DARK'
const TIER_COLOR: Record<Tier, string> = {
  'REDUNDANT': '#10b981',
  'PRIMARY-VHF': '#10b981',
  'SATCOM-ONLY': '#0ea5e9',
  'HF-ONLY': '#f59e0b',
  'DARK': '#ef4444',
}
const TIER_ORDER: Tier[] = ['DARK', 'HF-ONLY', 'SATCOM-ONLY', 'PRIMARY-VHF', 'REDUNDANT']

type Primary = 'VHF' | 'SAT-I' | 'SAT-IR' | 'HF' | 'NONE'
const PRIMARY_COLOR: Record<Primary, string> = {
  'VHF': '#10b981',
  'SAT-I': '#8b5cf6',
  'SAT-IR': '#0ea5e9',
  'HF': '#f59e0b',
  'NONE': '#ef4444',
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

const D2R = Math.PI / 180
const R_NM = 3440.065
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
// FNV-1a 32-bit hash for deterministic per-airframe equipage
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
function hashFrac(s: string, salt: string): number {
  return (hash32(s + salt) % 10000) / 10000
}

const EQUIP_INMARSAT: Record<Klass, number> = {
  heavy: 0.97, narrow: 0.55, regional: 0.30, biz: 0.94, turboprop: 0.10, ga: 0.02, fighter: 0.20,
}
const EQUIP_IRIDIUM: Record<Klass, number> = {
  heavy: 0.85, narrow: 0.45, regional: 0.40, biz: 0.90, turboprop: 0.55, ga: 0.30, fighter: 0.65,
}
const EQUIP_HF: Record<Klass, number> = {
  heavy: 0.99, narrow: 0.75, regional: 0.55, biz: 0.96, turboprop: 0.40, ga: 0.10, fighter: 0.95,
}

interface Row {
  f: SatcomFlight
  klass: Klass
  altFt: number
  absLat: number
  vhfRangeNm: number       // optical horizon nm
  nearAirIata: string
  nearAirIcao: string
  nearAirLat: number
  nearAirLng: number
  nearAirDistNm: number
  vhfAvail: number         // 0..1 (cov margin)
  satIAvail: number        // Inmarsat
  satIRAvail: number       // Iridium
  hfAvail: number          // HF SSB
  primary: Primary
  redundancy: number       // count of links >= 0.5
  tier: Tier
}

const SRC_RING = 'satcom-ring', SRC_HRZ = 'satcom-hrz', SRC_LINE = 'satcom-line', SRC_LBL = 'satcom-lbl'
const LYR_RING = 'satcom-ring-l', LYR_HRZ = 'satcom-hrz-l', LYR_LINE = 'satcom-line-l', LYR_LBL = 'satcom-lbl-l'

const ALL_AP = AIRPORTS.filter(a => a.a && a.a.length === 3)

function vhfHorizonNm(altFt: number): number {
  // FAA AIM 4-2-1: range_nm ≈ 1.23 √h_ac + 1.23 √h_grd ; ground mast 50 ft
  return 1.23 * Math.sqrt(Math.max(0, altFt)) + 1.23 * Math.sqrt(50)
}

// Generate small circle polygon (24 pts) around aircraft at given radius nm
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

export default function SatcomCoverage({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'LINKS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(50)
  const [maxFl, setMaxFl] = useState(450)
  const [vhfMargin, setVhfMargin] = useState(100)
  const [equipBias, setEquipBias] = useState(100)
  const [hfSsn, setHfSsn] = useState(100)
  const [showRing, setShowRing] = useState(true)
  const [showHrz, setShowHrz] = useState(true)
  const [showLine, setShowLine] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || !isFinite(f.lat) || !isFinite(f.lng)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl || flCur > maxFl) continue
      const klass = classify(f.type, f.category)
      const absLat = Math.abs(f.lat)

      // ---- VHF: line of sight to nearest airport (with margin)
      const vhfRangeNm = vhfHorizonNm(f.altitudeFt) * (vhfMargin / 100)
      let nearestD = Infinity, nearestI = '', nearestIcao = '', nearestLat = 0, nearestLng = 0
      for (const ap of ALL_AP) {
        const d = gcDistNm(f.lat, f.lng, ap.lat, ap.lon)
        if (d < nearestD) { nearestD = d; nearestI = ap.a; nearestIcao = ap.i; nearestLat = ap.lat; nearestLng = ap.lon }
      }
      // VHF available iff dist <= range; quality = clamp(1 - d/range, 0, 1)
      const vhfAvail = nearestD <= vhfRangeNm ? Math.max(0.6, 1 - nearestD / vhfRangeNm) : 0

      // ---- Inmarsat (geo): hard polar hole at 80deg
      const inmEquipP = Math.min(1, EQUIP_INMARSAT[klass] * (equipBias / 100))
      const inmEquipped = hashFrac(f.icao, 'inm') < inmEquipP
      let satIAvail = 0
      if (inmEquipped && absLat < 80) {
        // smooth roll-off: cos((absLat/80)*pi/2)
        satIAvail = Math.max(0.5, Math.cos((absLat / 80) * (Math.PI / 2)))
      }

      // ---- Iridium (LEO): global polar coverage
      const irEquipP = Math.min(1, EQUIP_IRIDIUM[klass] * (equipBias / 100))
      const irEquipped = hashFrac(f.icao, 'ir') < irEquipP
      const satIRAvail = irEquipped ? 0.92 : 0

      // ---- HF SSB
      const hfEquipP = Math.min(1, EQUIP_HF[klass] * (equipBias / 100))
      const hfEquipped = hashFrac(f.icao, 'hf') < hfEquipP
      let hfAvail = 0
      if (hfEquipped) {
        // local solar time proxy via lng/15 ; assume 12 UT global wall (simulator simplification)
        const lst = ((12 + f.lng / 15) % 24 + 24) % 24
        const noonDelta = Math.abs(lst - 12) // 0 at noon, 12 at midnight
        const diurnal = 0.55 + 0.45 * Math.cos((noonDelta / 12) * Math.PI) // 1.0 noon -> 0.55 midnight
        const ssn = hfSsn / 100 // solar activity multiplier
        let base = 0.55 + 0.35 * Math.min(1.5, ssn) * diurnal
        // PCA polar cap absorption
        if (absLat >= 70) base *= 0.4
        else if (absLat >= 60) base *= 0.75
        hfAvail = Math.max(0, Math.min(1, base))
      }

      // ---- Primary link selection (prefer VHF for latency, else best satellite, else HF)
      const isAvail = (v: number) => v >= 0.5
      let primary: Primary = 'NONE'
      if (isAvail(vhfAvail)) primary = 'VHF'
      else {
        // pick best satellite
        const bestSat = Math.max(satIAvail, satIRAvail)
        if (bestSat >= 0.5) primary = satIAvail >= satIRAvail ? 'SAT-I' : 'SAT-IR'
        else if (isAvail(hfAvail)) primary = 'HF'
      }

      const redundancy = [vhfAvail, satIAvail, satIRAvail, hfAvail].filter(v => v >= 0.5).length

      // ---- Tier
      let tier: Tier
      if (primary === 'NONE') tier = 'DARK'
      else if (redundancy >= 3) tier = 'REDUNDANT'
      else if (primary === 'VHF') tier = 'PRIMARY-VHF'
      else if (primary === 'SAT-I' || primary === 'SAT-IR') tier = 'SATCOM-ONLY'
      else tier = 'HF-ONLY'

      out.push({
        f, klass, altFt: f.altitudeFt, absLat,
        vhfRangeNm, nearAirIata: nearestI, nearAirIcao: nearestIcao,
        nearAirLat: nearestLat, nearAirLng: nearestLng, nearAirDistNm: nearestD,
        vhfAvail, satIAvail, satIRAvail, hfAvail,
        primary, redundancy, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return a.redundancy - b.redundancy
    })
    return out
  }, [flights, minFl, maxFl, vhfMargin, equipBias, hfSsn])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { 'REDUNDANT': 0, 'PRIMARY-VHF': 0, 'SATCOM-ONLY': 0, 'HF-ONLY': 0, 'DARK': 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    const total = rows.length
    let sumRed = 0, worstRed = 5, worstCs = '', worstPrim: Primary = 'NONE', darkCount = 0, satOnly = 0, hfOnly = 0
    for (const r of rows) {
      sumRed += r.redundancy
      if (r.tier === 'DARK') darkCount++
      if (r.tier === 'SATCOM-ONLY') satOnly++
      if (r.tier === 'HF-ONLY') hfOnly++
      if (r.redundancy < worstRed) { worstRed = r.redundancy; worstCs = (r.f.callsign || r.f.icao).trim(); worstPrim = r.primary }
    }
    const meanRed = total > 0 ? sumRed / total : 0
    return { total, meanRed, worstRed, worstCs, worstPrim, darkCount, satOnly, hfOnly }
  }, [rows])

  // Link grouping by PRIMARY link
  const linkGroups = useMemo(() => {
    const m = new Map<Primary, { p: Primary, count: number, meanRed: number, worstTier: Tier, samples: string[] }>()
    for (const r of rows) {
      const e = m.get(r.primary)
      if (e) {
        e.count++; e.meanRed += r.redundancy
        if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(e.worstTier)) e.worstTier = r.tier
        if (e.samples.length < 4) e.samples.push((r.f.callsign || r.f.icao).trim())
      } else {
        m.set(r.primary, { p: r.primary, count: 1, meanRed: r.redundancy, worstTier: r.tier, samples: [(r.f.callsign || r.f.icao).trim()] })
      }
    }
    const arr = Array.from(m.values())
    for (const e of arr) e.meanRed /= e.count
    arr.sort((a, b) => b.count - a.count)
    return arr
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.nearAirIata, r.nearAirIcao, r.primary].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  const filteredLinks = useMemo(() => {
    const q = query.trim().toUpperCase()
    return linkGroups.filter(l => {
      if (!q) return true
      return l.p.toUpperCase().includes(q)
    })
  }, [linkGroups, query])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + (4 - r.redundancy) * 3.5 },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    // VHF horizon circles for non-REDUNDANT (otherwise screen gets messy)
    const hrzFeatures: any[] = []
    if (showHrz) {
      for (const r of rows) {
        if (r.tier === 'REDUNDANT') continue
        if (r.vhfRangeNm < 30 || r.vhfRangeNm > 350) continue
        const poly = smallCircle(r.f.lat, r.f.lng, r.vhfRangeNm, 24)
        hrzFeatures.push({ type: 'Feature', properties: { color: r.vhfAvail >= 0.5 ? '#10b981' : '#64748b' }, geometry: { type: 'LineString', coordinates: poly } })
      }
    }
    const hrzFc = { type: 'FeatureCollection' as const, features: hrzFeatures }
    // line to nearest airport for SATCOM/HF/DARK only
    const lineFc = { type: 'FeatureCollection' as const, features: showLine ? rows.filter(r => r.tier === 'SATCOM-ONLY' || r.tier === 'HF-ONLY' || r.tier === 'DARK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.nearAirLng, r.nearAirLat]] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'REDUNDANT' && r.tier !== 'PRIMARY-VHF').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${r.primary} R${r.redundancy}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_HRZ, hrzFc, () => map.addLayer({ id: LYR_HRZ, type: 'line', source: SRC_HRZ, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.0, 'line-opacity': 0.4, 'line-dasharray': [2, 3],
      } }))
      ensure(SRC_LINE, lineFc, () => map.addLayer({ id: LYR_LINE, type: 'line', source: SRC_LINE, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.75, 'line-dasharray': [4, 2],
      } }))
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'circle', source: SRC_RING, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.6, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_RING, LYR_LINE, LYR_HRZ]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_RING, SRC_LINE, SRC_HRZ]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showRing, showHrz, showLine, showLabels])

  // Diagram: x = |lat| 0..90, y = redundancy 0..4
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD_L = 26, PAD_B = 22
    const xs = (lat: number) => PAD_L + (lat / 90) * (W - PAD_L - 8)
    const ys = (red: number) => 6 + (1 - red / 4) * (H - PAD_B - 8)
    return { W, H, PAD_L, PAD_B, xs, ys }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">SATCOM / HF Coverage</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} ac</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.slice().reverse().map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold" style={{ color: TIER_COLOR[t] }}>{t === 'PRIMARY-VHF' ? 'VHF' : t === 'SATCOM-ONLY' ? 'SAT' : t === 'HF-ONLY' ? 'HF' : t === 'REDUNDANT' ? 'RED' : 'DARK'}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Red</div>
          <div className="font-mono text-sm" style={{ color: summary.meanRed >= 2.5 ? '#10b981' : summary.meanRed >= 1.5 ? '#0ea5e9' : summary.meanRed >= 1 ? '#f59e0b' : '#ef4444' }}>
            {summary.meanRed.toFixed(2)}<span className="text-[9px] text-slate-500"> /4</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstPrim}` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Dark</div>
          <div className="font-mono text-sm" style={{ color: summary.darkCount > 0 ? '#ef4444' : '#10b981' }}>{summary.darkCount}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">SATCOM-only</div>
          <div className="font-mono text-[11px]" style={{ color: summary.satOnly > 0 ? '#0ea5e9' : '#64748b' }}>{summary.satOnly}</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">HF-only</div>
          <div className="font-mono text-[11px]" style={{ color: summary.hfOnly > 0 ? '#f59e0b' : '#64748b' }}>{summary.hfOnly}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Redundancy vs |lat| · polar hole at 80°</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD_L} y1={diag.H - diag.PAD_B} x2={diag.W - 6} y2={diag.H - diag.PAD_B} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD_L} y1={6} x2={diag.PAD_L} y2={diag.H - diag.PAD_B} stroke="#334155" strokeWidth={1} />
            {/* tier bands on Y */}
            {[
              { hi: 4, lo: 3, c: '#10b981', op: 0.10 },
              { hi: 3, lo: 2, c: '#10b981', op: 0.06 },
              { hi: 2, lo: 1, c: '#0ea5e9', op: 0.07 },
              { hi: 1, lo: 0, c: '#ef4444', op: 0.08 },
            ].map((b, i) => (
              <rect key={i} x={diag.PAD_L} y={diag.ys(b.hi)} width={diag.W - diag.PAD_L - 6} height={diag.ys(b.lo) - diag.ys(b.hi)} fill={b.c} opacity={b.op} />
            ))}
            {/* x verticals: polar circle 66.5, inmarsat edge 80 */}
            <line x1={diag.xs(66.5)} y1={6} x2={diag.xs(66.5)} y2={diag.H - diag.PAD_B} stroke="#f59e0b" strokeDasharray="2 3" opacity={0.6} />
            <line x1={diag.xs(80)} y1={6} x2={diag.xs(80)} y2={diag.H - diag.PAD_B} stroke="#ef4444" strokeDasharray="2 3" opacity={0.6} />
            <text x={diag.xs(66.5)} y={14} textAnchor="middle" fontSize={8} fill="#f59e0b" fontFamily="monospace">PC 66.5°</text>
            <text x={diag.xs(80)} y={14} textAnchor="middle" fontSize={8} fill="#ef4444" fontFamily="monospace">INM 80°</text>
            {/* y labels */}
            {[0, 1, 2, 3, 4].map(y => (
              <text key={y} x={diag.PAD_L - 2} y={diag.ys(y) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{y}</text>
            ))}
            {/* x labels */}
            {[0, 30, 60, 90].map(x => (
              <text key={x} x={diag.xs(x)} y={diag.H - diag.PAD_B + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{x}°</text>
            ))}
            {/* aircraft dots */}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(Math.min(90, r.absLat))} cy={diag.ys(r.redundancy)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.9} />
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
            <div className="flex justify-between text-[10px] text-slate-500"><span>VHF-MARGIN</span><span className="font-mono text-slate-300">{vhfMargin}%</span></div>
            <input type="range" min={60} max={150} step={5} value={vhfMargin} onChange={e => setVhfMargin(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>EQUIP-BIAS</span><span className="font-mono text-slate-300">{equipBias}%</span></div>
            <input type="range" min={50} max={150} step={5} value={equipBias} onChange={e => setEquipBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div className="col-span-2">
            <div className="flex justify-between text-[10px] text-slate-500"><span>HF-SSN</span><span className="font-mono text-slate-300">{hfSsn}%</span></div>
            <input type="range" min={0} max={200} step={5} value={hfSsn} onChange={e => setHfSsn(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHrz} onChange={e => setShowHrz(e.target.checked)} className="accent-sky-500" /><span>HRZ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLine} onChange={e => setShowLine(e.target.checked)} className="accent-sky-500" /><span>LINK</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao / IATA / primary"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'LINKS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} ac` : `${filteredLinks.length} primary links`}</span>
        <span>{tab === 'AIRCRAFT' ? 'primary · redundancy · VHF / SAT-I / SAT-IR / HF' : 'count · worst · mean'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const advice = r.tier === 'DARK' ? 'lost comms · squawk 7600 · follow ICAO Doc 4444 NORDO procedure' :
            r.tier === 'HF-ONLY' ? 'HF SELCAL only · long latency · advise ATC HF primary' :
            r.tier === 'SATCOM-ONLY' ? `satcom primary via ${r.primary} · request VHF frequency next sector` :
            r.tier === 'PRIMARY-VHF' ? 'VHF primary · monitor next sector' :
            'multi-link redundant · normal ops'
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{KLASS_LABEL[r.klass]}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="flight level">F{Math.round(r.altFt / 100)}</span>
                  <span title="|lat|">{r.absLat.toFixed(1)}°</span>
                  <span title="primary link" style={{ color: PRIMARY_COLOR[r.primary] }}>★{r.primary}</span>
                  <span title="redundancy / 4" className="ml-auto" style={{ color: TIER_COLOR[r.tier] }}>R{r.redundancy}/4</span>
                </div>
                {/* 4-bar link availability sparkline */}
                <div className="mt-1 grid grid-cols-4 gap-0.5" title="VHF / SAT-I / SAT-IR / HF availability">
                  {[
                    { v: r.vhfAvail, c: '#10b981', l: 'VHF' },
                    { v: r.satIAvail, c: '#8b5cf6', l: 'INM' },
                    { v: r.satIRAvail, c: '#0ea5e9', l: 'IRD' },
                    { v: r.hfAvail, c: '#f59e0b', l: 'HF' },
                  ].map((b, i) => (
                    <div key={i} className="h-1.5 rounded bg-slate-900 relative overflow-hidden">
                      <div className="absolute inset-y-0 left-0" style={{ width: `${b.v * 100}%`, background: b.c, opacity: b.v >= 0.5 ? 0.85 : 0.35 }} />
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="vhf horizon">HRZ{r.vhfRangeNm.toFixed(0)}nm</span>
                  <span title="nearest airport">›{r.nearAirIata}</span>
                  <span title="distance to nearest">{r.nearAirDistNm.toFixed(0)}nm</span>
                  <span className="ml-auto truncate" title="operator">{r.f.operator || '\u2014'}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="VHF availability">V{(r.vhfAvail * 100).toFixed(0)}</span>
                  <span title="Inmarsat availability">I{(r.satIAvail * 100).toFixed(0)}</span>
                  <span title="Iridium availability">Ir{(r.satIRAvail * 100).toFixed(0)}</span>
                  <span title="HF availability">H{(r.hfAvail * 100).toFixed(0)}</span>
                  <span className="ml-auto" title="nearest ICAO">{r.nearAirIcao}</span>
                </div>
                <div className="text-[10px] font-mono mt-0.5 truncate" title="advice" style={{ color: r.tier === 'REDUNDANT' || r.tier === 'PRIMARY-VHF' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</div>
              </div>
            </button>
          )
        })}
        {tab === 'LINKS' && filteredLinks.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No links match.</div>
        )}
        {tab === 'LINKS' && filteredLinks.map(l => (
          <div key={l.p} className="w-full text-left px-3 py-2 border-b border-slate-900 flex items-center gap-2">
            <span className="w-1 self-stretch rounded" style={{ background: PRIMARY_COLOR[l.p] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono font-semibold" style={{ color: PRIMARY_COLOR[l.p] }}>★{l.p}</span>
                <span className="ml-auto text-[10px] font-mono text-slate-400">{l.count} ac</span>
                <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[l.worstTier] }}>{l.worstTier}</span>
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="mean redundancy / 4">
                <div className="absolute inset-y-0 left-0" style={{ width: `${(l.meanRed / 4) * 100}%`, background: PRIMARY_COLOR[l.p], opacity: 0.85 }} />
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                <span title="mean redundancy">μR{l.meanRed.toFixed(2)}/4</span>
                <span title="fleet share">{((l.count / Math.max(1, rows.length)) * 100).toFixed(0)}%</span>
                <span className="ml-auto truncate" title="sample callsigns">{l.samples.join(' · ')}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
