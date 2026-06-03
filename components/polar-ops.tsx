'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Cross-Polar / Arctic Operations Monitor
   -----------------------------------------------------------
   FAA Polar Routes AC 120-42B App.G / Transport Canada AC 700-016 /
   ICAO Annex 6 Polar Operations / EASA AMC 20-12 Cross-Polar
   passive compliance watch for every airborne aircraft above
   ARCTIC-MIN slider latitude (default 66 deg).

   Zones (auto by |lat|):
     POLAR     | |lat| >= 78 deg  Polar Area-of-Operations (PAO)
     SUB-POLAR | 73 <= |lat| < 78 grid-nav typically required
     HIGH-LAT  | 66 <= |lat| < 73 arctic / antarctic but pre-PAO
     OUT       | |lat| <  ARCTIC-MIN  excluded

   Risk components (per aircraft):
     FUEL-FREEZE
       Jet-A freeze pt -40C (Jet A-1 -47C). TAT = -56.5 + ISA-DEV
       (FL>360 tropopause clamp) + recovery 0.99*M^2*kelvin. Below
       FL360 use SA temp lapse -1.98C/1000ft from 15+ISA. Fuel-tank
       temp lags ~3C above TAT in long cruise. Margin = freeze_pt -
       fuelTempC. SCALE-FRZ slider 50-150% scales sensitivity.
     HF-REDUNDANCY
       Polar AOO mandates dual long-range comms (HF + SATCOM-Iridium
       NEXT for >82N because GEO INMARSAT coverage degrades). Per-class
       equipage prob (HVY 0.97 / NRW 0.85 / RGN 0.50 / BIZ 0.94 /
       TBP 0.30 / GA 0.05 / FTR 0.20) hashed by ICAO24 for stable
       dual/single/none equipage classification.
     GRID-NAV
       Above 73 lat magnetic compass unreliable (Polar Track
       System Doc 7030 mandates true / grid-track). Score 0-100 from
       |lat|>73 ramp + magnetic decl proxy from dipole offset.
     NEC-DIST
       Nearest Emergency airport from 14 curated polar diverts
       (BGTL Thule / BGSF Sondrestrom / BIRK Reykjavik / CYRB Resolute
       / CYFB Iqaluit / CYZF Yellowknife / ULMM Murmansk / UOOO
       Norilsk / UOHH Khatanga / UEST Tiksi / UHMM Magadan / PANC
       Anchorage / PAFA Fairbanks / PAOM Nome) — distance in nm.
       Score = clip((distNm-200)/600 * 100, 0, 100). NEC-MAX slider
       300-2000nm caps acceptable distance.
     COSMIC-DOSE proxy
       Polar latitudes have 2-3x mid-lat dose. Brief proxy 0.4 *
       (altKft/10)^1.4 * (1 + |lat|/90).

   Composite score 0-100 = max(fuelFreezeSev, hfSev, gridSev, necSev).
     Weights enforce single-driver dominance for the displayed advice.

   Tier classification:
     EMERG    score>=80   rose    divert nearest NEC now
     DEGRADE  score>=55   amber   capability degraded · review
     CAUTION  score>=25   sky     within envelope · monitor
     NOMINAL  score<25    emerald nominal polar ops
     OUT      |lat|<min   slate   not in arctic zone

   MapLibre overlay:
     - Tier-coloured halo rings sized by score 7-22 px
     - Amber dashed parallel polylines at 66 / 73 / 78 lat both
       hemispheres (zone boundaries) sampled 60-pt
     - Tier-coloured circle pin at nearest NEC for non-NOMINAL
     - Tier-coloured callsign + zone + driver labels for non-NOMINAL

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-SCORE / WORST callsign+score / EMERG count
     - 2-cell MEAN-NEC-DIST / DUAL-HF count secondary row
     - SVG score-vs-|lat| scatter with tier-band shading
     - 5 sliders ARCTIC-MIN / FRZ-MARGIN / SCALE-FRZ / NEC-MAX / ISA-DEV
     - 7-class chip filter + HALO/ZONE/PIN/LBL/DIAG toggles + search
     - AIRCRAFT / ZONES tab switcher
     - AIRCRAFT tab: sorted tier-worst-first
     - ZONES tab: grouped by zone

   Registered in Layers > Safety & Traffic. Persisted: ft-polar
   ============================================================ */

export interface PolarFlight {
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
  flights: PolarFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'NOMINAL' | 'CAUTION' | 'DEGRADE' | 'EMERG' | 'OUT'
const TIER_COLOR: Record<Tier, string> = {
  NOMINAL: '#10b981',
  CAUTION: '#0ea5e9',
  DEGRADE: '#f59e0b',
  EMERG: '#ef4444',
  OUT: '#64748b',
}
const TIER_ORDER: Tier[] = ['EMERG', 'DEGRADE', 'CAUTION', 'NOMINAL', 'OUT']
const TIER_RANK: Record<Tier, number> = { EMERG: 0, DEGRADE: 1, CAUTION: 2, NOMINAL: 3, OUT: 4 }

type Zone = 'POLAR' | 'SUB-POLAR' | 'HIGH-LAT' | 'OUT'
const ZONE_LABEL: Record<Zone, string> = { POLAR: 'PAO ≥78°', 'SUB-POLAR': 'SUB-POLAR 73-78°', 'HIGH-LAT': 'HIGH-LAT 66-73°', OUT: 'OUT' }

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}
const HF_EQUIP_PROB: Record<Klass, number> = {
  heavy: 0.97, narrow: 0.85, regional: 0.50, biz: 0.94, turboprop: 0.30, ga: 0.05, fighter: 0.20,
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

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h >>> 0
}

interface Nec { icao: string; iata: string; name: string; lat: number; lng: number }
const NEC: Nec[] = [
  { icao: 'BGTL', iata: 'THU', name: 'Thule', lat: 76.531, lng: -68.703 },
  { icao: 'BGSF', iata: 'SFJ', name: 'Sondrestrom', lat: 67.017, lng: -50.689 },
  { icao: 'BIRK', iata: 'RKV', name: 'Reykjavik', lat: 64.13, lng: -21.94 },
  { icao: 'BIKF', iata: 'KEF', name: 'Keflavik', lat: 63.985, lng: -22.605 },
  { icao: 'CYRB', iata: 'YRB', name: 'Resolute Bay', lat: 74.717, lng: -94.969 },
  { icao: 'CYFB', iata: 'YFB', name: 'Iqaluit', lat: 63.756, lng: -68.556 },
  { icao: 'CYZF', iata: 'YZF', name: 'Yellowknife', lat: 62.463, lng: -114.44 },
  { icao: 'ULMM', iata: 'MMK', name: 'Murmansk', lat: 68.781, lng: 32.751 },
  { icao: 'UOOO', iata: 'NSK', name: 'Norilsk', lat: 69.311, lng: 87.332 },
  { icao: 'UOHH', iata: 'HTG', name: 'Khatanga', lat: 71.978, lng: 102.491 },
  { icao: 'UEST', iata: 'IKS', name: 'Tiksi', lat: 71.698, lng: 128.903 },
  { icao: 'UHMM', iata: 'GDX', name: 'Magadan', lat: 59.911, lng: 150.72 },
  { icao: 'PANC', iata: 'ANC', name: 'Anchorage', lat: 61.174, lng: -149.996 },
  { icao: 'PAFA', iata: 'FAI', name: 'Fairbanks', lat: 64.815, lng: -147.857 },
  { icao: 'PAOM', iata: 'OME', name: 'Nome', lat: 64.512, lng: -165.445 },
  { icao: 'ENBO', iata: 'BOO', name: 'Bodø', lat: 67.269, lng: 14.365 },
  { icao: 'ENTC', iata: 'TOS', name: 'Tromsø', lat: 69.683, lng: 18.918 },
  { icao: 'ENSB', iata: 'LYR', name: 'Svalbard', lat: 78.246, lng: 15.466 },
  { icao: 'NZIR', iata: 'IRA', name: 'McMurdo (Williams)', lat: -77.867, lng: 167.057 },
]

function greatCircleNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const dφ = ((lat2 - lat1) * Math.PI) / 180
  const dλ = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function nearestNec(lat: number, lng: number): { nec: Nec; distNm: number } {
  let best = NEC[0]
  let bestD = Infinity
  for (const n of NEC) {
    const d = greatCircleNm(lat, lng, n.lat, n.lng)
    if (d < bestD) { bestD = d; best = n }
  }
  return { nec: best, distNm: bestD }
}

interface Row {
  f: PolarFlight
  klass: Klass
  flCur: number
  absLat: number
  zone: Zone
  // fuel freeze
  saTempC: number
  fuelTempC: number
  freezeMarginC: number
  freezeSev: number
  // hf
  hfDual: boolean
  hfSingle: boolean
  hfSev: number
  // grid
  gridReq: boolean
  gridSev: number
  // nec
  nec: Nec
  necNm: number
  necSev: number
  // composite
  score: number
  tier: Tier
  driver: 'FREEZE' | 'HF' | 'GRID' | 'NEC' | 'NONE'
  // cosmic dose proxy
  doseRate: number
}

const SRC_HALO = 'polar-halo', SRC_LBL = 'polar-lbl', SRC_PIN = 'polar-pin', SRC_ZONE = 'polar-zone'
const LYR_HALO = 'polar-halo-l', LYR_LBL = 'polar-lbl-l', LYR_PIN = 'polar-pin-l', LYR_ZONE = 'polar-zone-l'

export default function PolarOps({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'ZONES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [arcticMin, setArcticMin] = useState(66)
  const [frzMargin, setFrzMargin] = useState(3)   // °C buffer above freeze
  const [scaleFrz, setScaleFrz] = useState(100)
  const [necMax, setNecMax] = useState(800)        // nm cap acceptable
  const [isaDev, setIsaDev] = useState(0)
  const [showHalo, setShowHalo] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showZones, setShowZones] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const FREEZE_PT = -47  // Jet A-1 (conservative for international fleet)
    for (const f of flights) {
      if (f.ground) continue
      const absLat = Math.abs(f.lat)
      const flCur = (f.altitudeFt || 0) / 100
      const altKft = flCur / 10
      let zone: Zone = 'OUT'
      if (absLat >= 78) zone = 'POLAR'
      else if (absLat >= 73) zone = 'SUB-POLAR'
      else if (absLat >= arcticMin) zone = 'HIGH-LAT'
      else continue
      const klass = classify(f.type, f.category)
      // ISA temperature: -1.98C per 1000ft from 15C SL, clamp at -56.5 from FL360+
      const saTempC = altKft >= 36 ? (-56.5 + isaDev) : (15 - 1.98 * altKft + isaDev)
      // Fuel-tank temp ~ TAT + 3C lag (long cruise)
      const fuelTempC = saTempC + 3
      const freezeMarginC = fuelTempC - FREEZE_PT
      // Severity: 0 when margin >= frzMargin+10, 100 when margin <= -2
      const frzRange = frzMargin + 12
      const freezeSev = Math.max(0, Math.min(100, ((frzMargin + 10) - freezeMarginC) / frzRange * 100)) * (scaleFrz / 100)

      // HF / SATCOM equipage from class probability + hash
      const h = hash32(f.icao)
      const r1 = ((h & 0xffff) / 0xffff)
      const r2 = (((h >>> 16) & 0xffff) / 0xffff)
      const pHf = HF_EQUIP_PROB[klass]
      const hfPrimary = r1 < pHf
      const satcomBackup = r2 < pHf * 0.9   // close to HF for jets, drops with class
      const hfDual = hfPrimary && satcomBackup
      const hfSingle = hfPrimary !== satcomBackup
      // Severity scales by zone — PAO mandates dual
      const hfBase = zone === 'POLAR' ? 100 : zone === 'SUB-POLAR' ? 70 : 40
      const hfSev = hfDual ? 0 : (hfSingle ? hfBase * 0.45 : hfBase)

      // Grid nav need: above 73° lat truly mandatory
      const gridReq = absLat >= 73
      const gridSev = gridReq ? Math.min(100, (absLat - 73) * 12 + 25) : Math.max(0, (absLat - 66) * 4)

      // Nearest emergency airport
      const { nec, distNm } = nearestNec(f.lat, f.lng)
      const necSev = Math.max(0, Math.min(100, (distNm - 200) / Math.max(50, necMax - 200) * 100))

      // Cosmic dose proxy uSv/h
      const doseRate = 0.4 * Math.pow(Math.max(0, altKft / 10), 1.4) * (1 + absLat / 90)

      const drivers: Array<{ k: Row['driver']; v: number }> = [
        { k: 'FREEZE', v: freezeSev },
        { k: 'HF', v: hfSev },
        { k: 'GRID', v: gridSev },
        { k: 'NEC', v: necSev },
      ]
      drivers.sort((a, b) => b.v - a.v)
      const score = drivers[0].v
      const driver: Row['driver'] = score < 1 ? 'NONE' : drivers[0].k
      const tier: Tier = score >= 80 ? 'EMERG' : score >= 55 ? 'DEGRADE' : score >= 25 ? 'CAUTION' : 'NOMINAL'

      out.push({
        f, klass, flCur, absLat, zone,
        saTempC, fuelTempC, freezeMarginC, freezeSev,
        hfDual, hfSingle, hfSev,
        gridReq, gridSev,
        nec, necNm: distNm, necSev,
        score, tier, driver, doseRate,
      })
    }
    return out
  }, [flights, arcticMin, frzMargin, scaleFrz, necMax, isaDev])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { NOMINAL: 0, CAUTION: 0, DEGRADE: 0, EMERG: 0, OUT: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    const n = rows.length || 1
    const meanScore = rows.reduce((a, b) => a + b.score, 0) / n
    const meanNec = rows.reduce((a, b) => a + b.necNm, 0) / n
    let worst: Row | null = null
    for (const r of rows) if (!worst || r.score > worst.score) worst = r
    const emerg = rows.filter(r => r.tier === 'EMERG').length
    const dualHf = rows.filter(r => r.hfDual).length
    return {
      meanScore, meanNec, emerg, dualHf, totalAc: rows.length,
      worstCs: worst ? (worst.f.callsign || worst.f.icao).trim() : '',
      worstScore: worst ? worst.score : 0,
      worstDriver: worst ? worst.driver : 'NONE',
    }
  }, [rows])

  const zoneAggs = useMemo(() => {
    const map = new Map<Zone, Row[]>()
    for (const r of rows) {
      if (!map.has(r.zone)) map.set(r.zone, [])
      map.get(r.zone)!.push(r)
    }
    const arr = Array.from(map.entries()).map(([zone, list]) => {
      const meanScore = list.reduce((a, b) => a + b.score, 0) / list.length
      const worstTier = list.reduce((acc, r) => TIER_RANK[r.tier] < TIER_RANK[acc] ? r.tier : acc, 'NOMINAL' as Tier)
      const meanNec = list.reduce((a, b) => a + b.necNm, 0) / list.length
      const meanDose = list.reduce((a, b) => a + b.doseRate, 0) / list.length
      const emerg = list.filter(r => r.tier === 'EMERG').length
      const degr = list.filter(r => r.tier === 'DEGRADE').length
      return { zone, count: list.length, meanScore, worstTier, meanNec, meanDose, emerg, degr, list }
    })
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
        if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.nec.icao, r.nec.iata, r.zone].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, klassFilter, query])

  // ---- MapLibre layers ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'NOMINAL' && r.tier !== 'OUT').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${r.zone} ${r.driver}`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier !== 'NOMINAL').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `›${r.nec.iata} ${Math.round(r.necNm)}nm` },
      geometry: { type: 'Point' as const, coordinates: [r.nec.lng, r.nec.lat] },
    })) : [] }
    // Zone boundary lines: parallels at 66/73/78 N and S
    const zoneFc = { type: 'FeatureCollection' as const, features: showZones ? [66, 73, 78, -66, -73, -78].map(lat => {
      const coords: [number, number][] = []
      for (let lng = -180; lng <= 180; lng += 6) coords.push([lng, lat])
      const c = Math.abs(lat) === 78 ? '#ef4444' : Math.abs(lat) === 73 ? '#f59e0b' : '#0ea5e9'
      return {
        type: 'Feature' as const,
        properties: { color: c },
        geometry: { type: 'LineString' as const, coordinates: coords },
      }
    }) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_ZONE, zoneFc, () => map.addLayer({ id: LYR_ZONE, type: 'line', source: SRC_ZONE, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.3,
        'line-opacity': 0.7,
        'line-dasharray': [3, 3],
      } }))
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.4,
        'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-anchor': 'top',
        'text-offset': [0, 0.8],
        'icon-allow-overlap': true,
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.6,
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-offset': [0, 1.6],
        'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.2,
      } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_ZONE]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_ZONE]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showZones])

  // Diagram: score (y, 0-100) vs |lat| (x, 60-90)
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 28
    const xMin = 60, xMax = 90, yMax = 100
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * (W - PAD - 6)
    const ys = (s: number) => 6 + (1 - Math.max(0, Math.min(1, s / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Cross-Polar Ops</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} ac arctic</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Score</div>
          <div className="font-mono text-sm" style={{ color: summary.meanScore >= 55 ? '#f59e0b' : summary.meanScore >= 25 ? '#0ea5e9' : '#10b981' }}>
            {summary.meanScore.toFixed(1)}<span className="text-[9px] text-slate-500"> /100</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstScore.toFixed(0)}` : '—'}
          </div>
          <div className="font-mono text-[9px] text-slate-500 truncate">{summary.worstDriver}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Emerg</div>
          <div className="font-mono text-sm" style={{ color: summary.emerg > 0 ? '#ef4444' : '#10b981' }}>{summary.emerg}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean NEC Dist</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanNec > necMax ? '#f59e0b' : '#0ea5e9' }}>
            {summary.meanNec.toFixed(0)}<span className="text-[9px] text-slate-500"> nm</span>
          </div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Dual HF/SATCOM</div>
          <div className="font-mono text-[11px] text-sky-300">{summary.dualHf}<span className="text-[9px] text-slate-500"> /{summary.totalAc}</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Risk Score 0-100 vs |lat| deg</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[25, 55, 80].map(t => (
              <line key={t} x1={diag.PAD} y1={diag.ys(t)} x2={diag.W - 6} y2={diag.ys(t)} stroke={t === 25 ? '#0ea5e9' : t === 55 ? '#f59e0b' : '#ef4444'} strokeWidth={0.9} strokeDasharray="3 2" opacity={0.75} />
            ))}
            {[
              { lo: 0, hi: 25, c: '#10b981' },
              { lo: 25, hi: 55, c: '#0ea5e9' },
              { lo: 55, hi: 80, c: '#f59e0b' },
              { lo: 80, hi: 100, c: '#ef4444' },
            ].map((b, i) => (
              <rect key={i} x={diag.PAD} y={diag.ys(b.hi)} width={diag.W - diag.PAD - 6} height={Math.max(0, diag.ys(b.lo) - diag.ys(b.hi))} fill={b.c} opacity={0.06} />
            ))}
            {[66, 73, 78].map(x => (
              <g key={x}>
                <line x1={diag.xs(x)} y1={6} x2={diag.xs(x)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(x)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{x}°</text>
              </g>
            ))}
            {[25, 50, 75, 100].map(s => (
              <text key={s} x={diag.PAD - 2} y={diag.ys(s) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{s}</text>
            ))}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(Math.min(diag.xMax, r.absLat))} cy={diag.ys(Math.min(diag.yMax, r.score))} r={3} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>ARCTIC-MIN</span><span className="font-mono text-slate-300">{arcticMin}°</span></div>
            <input type="range" min={50} max={75} step={1} value={arcticMin} onChange={e => setArcticMin(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>FRZ-MARGIN</span><span className="font-mono text-slate-300">{frzMargin}°C</span></div>
            <input type="range" min={0} max={15} step={1} value={frzMargin} onChange={e => setFrzMargin(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>SCALE-FRZ</span><span className="font-mono text-slate-300">{scaleFrz}%</span></div>
            <input type="range" min={50} max={150} step={5} value={scaleFrz} onChange={e => setScaleFrz(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>NEC-MAX</span><span className="font-mono text-slate-300">{necMax}nm</span></div>
            <input type="range" min={300} max={2000} step={50} value={necMax} onChange={e => setNecMax(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>ISA-DEV</span><span className="font-mono text-slate-300">{isaDev > 0 ? '+' : ''}{isaDev}°C</span></div>
          <input type="range" min={-30} max={30} step={1} value={isaDev} onChange={e => setIsaDev(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showZones} onChange={e => setShowZones(e.target.checked)} className="accent-sky-500" /><span>ZONE</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>NEC</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / NEC"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'ZONES'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} ac` : `${zoneAggs.length} zones`}</span>
        <span>{tab === 'AIRCRAFT' ? 'score · driver · NEC · tier' : 'mean · worst · count'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No arctic aircraft.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const sevPct = Math.min(100, r.score)
          const advice =
            r.driver === 'FREEZE' && r.tier === 'EMERG' ? 'fuel approaching freeze · descend or use anti-ice fuel additive now' :
            r.driver === 'FREEZE' && r.tier === 'DEGRADE' ? 'fuel-temp degrading · descend FL or increase Mach for higher TAT' :
            r.driver === 'HF' && r.tier !== 'NOMINAL' ? 'long-range comm short · request SATCOM phone patch or reroute equatorward' :
            r.driver === 'GRID' && r.tier !== 'NOMINAL' ? 'magnetic compass unreliable · verify grid/true-track FMS mode' :
            r.driver === 'NEC' && r.tier === 'EMERG' ? 'no NEC within range · review fuel/oxygen reserves' :
            r.driver === 'NEC' ? `nearest NEC ${r.nec.iata} ${Math.round(r.necNm)}nm · acceptable` :
            'within polar ops envelope'
          const hfStatus = r.hfDual ? 'DUAL' : r.hfSingle ? 'SINGLE' : 'NONE'
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
                  <span title="flight level">F{Math.round(r.flCur)}</span>
                  <span title="zone" style={{ color: TIER_COLOR[r.tier] }}>{r.zone}</span>
                  <span title="abs lat">{r.absLat.toFixed(1)}°{r.f.lat >= 0 ? 'N' : 'S'}</span>
                  <span title="fuel temp" style={{ color: r.freezeMarginC < frzMargin ? TIER_COLOR[r.tier] : '#94a3b8' }}>{r.fuelTempC.toFixed(0)}°C</span>
                  <span className="ml-auto truncate" title="dominant driver" style={{ color: TIER_COLOR[r.tier] }}>{r.driver}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="composite risk score 0-100">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${sevPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: '25%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '55%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '80%' }} />
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[9px] font-mono">
                  <span className="px-1 py-0 rounded border text-center" style={{ borderColor: TIER_COLOR[r.freezeSev >= 80 ? 'EMERG' : r.freezeSev >= 55 ? 'DEGRADE' : r.freezeSev >= 25 ? 'CAUTION' : 'NOMINAL'] + '66', color: TIER_COLOR[r.freezeSev >= 80 ? 'EMERG' : r.freezeSev >= 55 ? 'DEGRADE' : r.freezeSev >= 25 ? 'CAUTION' : 'NOMINAL'] }}>FRZ {r.freezeSev.toFixed(0)}</span>
                  <span className="px-1 py-0 rounded border text-center" style={{ borderColor: TIER_COLOR[r.hfSev >= 80 ? 'EMERG' : r.hfSev >= 55 ? 'DEGRADE' : r.hfSev >= 25 ? 'CAUTION' : 'NOMINAL'] + '66', color: TIER_COLOR[r.hfSev >= 80 ? 'EMERG' : r.hfSev >= 55 ? 'DEGRADE' : r.hfSev >= 25 ? 'CAUTION' : 'NOMINAL'] }}>HF {hfStatus}</span>
                  <span className="px-1 py-0 rounded border text-center" style={{ borderColor: TIER_COLOR[r.gridSev >= 80 ? 'EMERG' : r.gridSev >= 55 ? 'DEGRADE' : r.gridSev >= 25 ? 'CAUTION' : 'NOMINAL'] + '66', color: TIER_COLOR[r.gridSev >= 80 ? 'EMERG' : r.gridSev >= 55 ? 'DEGRADE' : r.gridSev >= 25 ? 'CAUTION' : 'NOMINAL'] }}>GRD {r.gridReq ? 'REQ' : 'opt'}</span>
                  <span className="px-1 py-0 rounded border text-center" style={{ borderColor: TIER_COLOR[r.necSev >= 80 ? 'EMERG' : r.necSev >= 55 ? 'DEGRADE' : r.necSev >= 25 ? 'CAUTION' : 'NOMINAL'] + '66', color: TIER_COLOR[r.necSev >= 80 ? 'EMERG' : r.necSev >= 55 ? 'DEGRADE' : r.necSev >= 25 ? 'CAUTION' : 'NOMINAL'] }}>{r.nec.iata} {Math.round(r.necNm)}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="cosmic dose proxy">{r.doseRate.toFixed(1)}uSv/h</span>
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'NOMINAL' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'ZONES' && zoneAggs.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No active polar zones.</div>
        )}
        {tab === 'ZONES' && zoneAggs.map(z => {
          const pct = Math.min(100, z.meanScore)
          const advice = z.worstTier === 'EMERG' ? 'emergency-tier aircraft in zone · monitor diversions' :
            z.worstTier === 'DEGRADE' ? 'degraded capability detected · review' :
            z.worstTier === 'CAUTION' ? 'within envelope · routine monitoring' :
            'nominal polar ops'
          return (
            <button key={z.zone} onClick={() => { const f = z.list[0]; if (f) onFly(f.f.icao) }}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[z.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{ZONE_LABEL[z.zone]}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{z.count}ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[z.worstTier] }}>{z.worstTier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span style={{ color: TIER_COLOR[z.worstTier] }}>mean {z.meanScore.toFixed(1)}</span>
                  <span>NEC {z.meanNec.toFixed(0)}nm</span>
                  <span>{z.meanDose.toFixed(1)}uSv/h</span>
                  <span className="ml-auto">E{z.emerg} D{z.degr}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="zone mean score">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: TIER_COLOR[z.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: '25%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '55%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '80%' }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate">polar zone</span>
                  <span className="ml-auto truncate" style={{ color: z.worstTier === 'NOMINAL' ? '#64748b' : TIER_COLOR[z.worstTier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
