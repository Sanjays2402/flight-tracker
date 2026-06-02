'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   Approach Minimums Compliance Monitor
   -----------------------------------------------------------
   For every airborne aircraft inside the inbound capture cone
   of any major airport (closing < CAPTURE-NM nm with negative
   ground-track-to-field closure rate), infers the lowest legal
   approach category the airframe could fly at the destination
   given:
     - class-tunable aircraft capability ladder
         (heavy/narrow CAT IIIb autoland equipped; regional/biz
          CAT II HUD; TBP CAT I; GA NPA only; fighter CAT I)
     - synthesised live ceiling AGL + RVR (m) from local
       low-altitude ADS-B humidity/density proxy combined with
       FAA flight-category ceiling/vis ladder
   then compares against the ICAO Annex 14 / FAA OpSpec C059
   decision-height + RVR matrix:
       CAT I    DH 200ft  RVR 550m  vis 1/2SM
       CAT II   DH 100ft  RVR 300m
       CAT IIIa DH  50ft  RVR 200m
       CAT IIIb DH  50ft  RVR  75m
       NPA      MDH 400ft vis 1SM
   per-aircraft achievable category = min(weather-allowed,
   aircraft-capability). Classifies into 4 tiers
     LEGAL  achievable matches/exceeds plan rwy CAT     emerald
     TIGHT  achievable within +1 step of weather edge   sky
     CAUTN  achievable forces downgrade (CAT III→II/I)  amber
     NO-GO  ceiling/RVR below airframe's lowest cat     rose
   Per airport rollup tracks inbound count + worst tier +
   driving CAT, sorted worst-first then traffic desc.

   MapLibre overlay:
     - Tier-coloured 12px airport pin at picked/closing fields
       with IATA + CAT + tier label
     - Tier-coloured aircraft halo ring sized by margin (8-20px)
     - Dashed tier-coloured projection line aircraft → field
       with diamond TDZ marker
     - Per-aircraft callsign + CAT-achievable + dist-nm label
   Side panel:
     - 4-tier counter strip click-to-filter
     - 3-cell INBOUND / WORST-IATA / MEAN-CEIL summary
     - SVG ceiling vs RVR scatter diagram with CAT I/II/IIIa/IIIb
       threshold quadrant overlays + per-aircraft tier-coloured
       dots at (RVR-m, ceil-ft) coord
     - SAMPLE-RNG / CAPTURE-NM / RVR-OFFSET / CEIL-OFFSET sliders
     - AIRCRAFT tab + AIRPORTS tab + class chip row
     - search by callsign / type / operator / IATA / city

   Registered under Layers > Routes & Flow category.
   ft-apmin persisted preference.
   ft-apmin-ap persisted airport-picker focus.
   ============================================================ */

export interface ApMinFlight {
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
  flights: ApMinFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'LEGAL' | 'TIGHT' | 'CAUTN' | 'NO-GO'
const TIER_COLOR: Record<Tier, string> = {
  LEGAL: '#10b981',
  TIGHT: '#0ea5e9',
  CAUTN: '#f59e0b',
  'NO-GO': '#ef4444',
}
const TIER_ORDER: Tier[] = ['NO-GO', 'CAUTN', 'TIGHT', 'LEGAL']

type Cat = 'NPA' | 'CAT I' | 'CAT II' | 'CAT IIIa' | 'CAT IIIb'
const CAT_ORDER: Cat[] = ['NPA', 'CAT I', 'CAT II', 'CAT IIIa', 'CAT IIIb']
const CAT_SHORT: Record<Cat, string> = { 'NPA': 'NPA', 'CAT I': 'I', 'CAT II': 'II', 'CAT IIIa': 'IIIa', 'CAT IIIb': 'IIIb' }
// DH ft, required RVR m
const CAT_MIN: Record<Cat, { dh: number, rvr: number }> = {
  'NPA':      { dh: 400, rvr: 1600 },
  'CAT I':    { dh: 200, rvr: 550 },
  'CAT II':   { dh: 100, rvr: 300 },
  'CAT IIIa': { dh: 50,  rvr: 200 },
  'CAT IIIb': { dh: 50,  rvr: 75 },
}

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}
// Best certified capability per class (default fleet baseline)
const KLASS_BEST: Record<Klass, Cat> = {
  heavy:     'CAT IIIb',
  narrow:    'CAT IIIa',
  regional:  'CAT II',
  biz:       'CAT II',
  turboprop: 'CAT I',
  ga:        'NPA',
  fighter:   'CAT I',
}

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'ga'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CRJ9|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS)/.test(x)) return 'fighter'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'ga'
  if (/^(B19|B20|B30|B35|B40|B45|B55|B58|B95|B96|B99|EMB|E11|PA31|PA42|PC9|KODI)/.test(x)) return 'turboprop'
  return 'narrow'
}

// Great-circle distance in nm
function gcNm(a: number, b: number, c: number, d: number): number {
  const R = 3440.065
  const φ1 = a * Math.PI / 180, φ2 = c * Math.PI / 180
  const dφ = (c - a) * Math.PI / 180
  const dλ = (d - b) * Math.PI / 180
  const x = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}
function bearing(a: number, b: number, c: number, d: number): number {
  const φ1 = a * Math.PI / 180, φ2 = c * Math.PI / 180
  const dλ = (d - b) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

interface Wx {
  ceilFt: number
  rvrM: number
  /** allowed CAT by weather alone */
  wxCat: Cat
}

// Weather-allowed category from ceiling/RVR
function wxAllowedCat(ceilFt: number, rvrM: number): Cat {
  // Highest CAT (lowest minima) whose DH ≤ ceil AND RVR-req ≤ actual
  let best: Cat = 'NPA'
  if (ceilFt >= 400 && rvrM >= 1600) best = 'NPA'
  else return 'NPA' // below NPA — not usable; treat as NPA placeholder but flag NO-GO
  for (const c of ['CAT I', 'CAT II', 'CAT IIIa', 'CAT IIIb'] as Cat[]) {
    const m = CAT_MIN[c]
    if (ceilFt >= m.dh && rvrM >= m.rvr) best = c
  }
  return best
}
function wxBelowNpa(ceilFt: number, rvrM: number): boolean {
  return ceilFt < 400 || rvrM < 1600
}

// Inverse-distance weighted local humidity proxy from low-alt traffic count
// (more traffic flying low = denser/clearer; very sparse = often weather avoidance)
// Combined with ISA-deviation slider drives ceiling+vis synthesis.
function synthWx(
  apLat: number, apLng: number,
  flights: ApMinFlight[], sampleRng: number,
  ceilOffset: number, rvrOffset: number,
  isaDevC: number,
): Wx {
  let n = 0, lowestLowAlt = 99999
  for (const f of flights) {
    if (f.ground) continue
    const d = gcNm(apLat, apLng, f.lat, f.lng)
    if (d > sampleRng) continue
    n++
    const flCur = f.altitudeFt / 100
    if (flCur < 60 && f.altitudeFt < lowestLowAlt) lowestLowAlt = f.altitudeFt
  }
  // Base humidity factor: low sample count = humid/foggy proxy (1.0), high = dry (0.2)
  const density = Math.min(1, n / 40)
  const hum = 1 - density * 0.8 // 0.2 dry .. 1.0 humid
  // Ceiling AGL: when humid → low ceiling tied to lowest observed traffic; dry → unlimited (BKN/OVC>5000)
  let ceil: number
  if (hum > 0.6 && lowestLowAlt < 5000) {
    ceil = Math.max(0, Math.min(5000, lowestLowAlt - 300 + (1 - hum) * 1500))
  } else {
    ceil = 3000 + (1 - hum) * 5500
  }
  ceil = Math.max(0, ceil + ceilOffset - isaDevC * 8)
  // RVR (m): humid → low vis; dry → 6000m+
  let rvr = (1 - hum) * 5500 + 200 + density * 1200
  rvr = Math.max(0, rvr + rvrOffset - isaDevC * 60)
  const wxCat = wxBelowNpa(ceil, rvr) ? 'NPA' : wxAllowedCat(ceil, rvr)
  return { ceilFt: ceil, rvrM: rvr, wxCat }
}

interface ApRow {
  icao: string
  iata: string
  name: string
  city: string
  lat: number
  lng: number
  wx: Wx
  inbound: number
  worstTier: Tier
  drivingCat: Cat
}
interface Row {
  f: ApMinFlight
  klass: Klass
  altFt: number
  trk: number
  gs: number
  distNm: number
  brgToFld: number
  closingKt: number
  apIcao: string
  apIata: string
  apCity: string
  apLat: number
  apLng: number
  wx: Wx
  acCap: Cat
  achievable: Cat
  margin: number   // signed steps wx vs ac-best (positive = wx better)
  tier: Tier
}

const SRC_RING = 'apmin-ring', SRC_PROJ = 'apmin-proj', SRC_TDZ = 'apmin-tdz', SRC_AP = 'apmin-ap', SRC_LBL = 'apmin-lbl', SRC_APLBL = 'apmin-aplbl'
const LYR_RING = 'apmin-ring-l', LYR_PROJ = 'apmin-proj-l', LYR_TDZ = 'apmin-tdz-l', LYR_AP = 'apmin-ap-l', LYR_LBL = 'apmin-lbl-l', LYR_APLBL = 'apmin-aplbl-l'

const lsGet = <T,>(k: string, dv: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : dv } catch { return dv } }
const lsSet = (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

export default function ApproachMinimums({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')
  const [sampleRng, setSampleRng] = useState<number>(() => lsGet('ft-apmin-srng', 80))
  const [captureNm, setCaptureNm] = useState<number>(() => lsGet('ft-apmin-cap', 40))
  const [ceilOff, setCeilOff] = useState<number>(() => lsGet('ft-apmin-coff', 0))
  const [rvrOff, setRvrOff] = useState<number>(() => lsGet('ft-apmin-roff', 0))
  const [isaDev, setIsaDev] = useState<number>(() => lsGet('ft-apmin-isa', 0))
  const [showRing, setShowRing] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showAp, setShowAp] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => { lsSet('ft-apmin-srng', sampleRng) }, [sampleRng])
  useEffect(() => { lsSet('ft-apmin-cap', captureNm) }, [captureNm])
  useEffect(() => { lsSet('ft-apmin-coff', ceilOff) }, [ceilOff])
  useEffect(() => { lsSet('ft-apmin-roff', rvrOff) }, [rvrOff])
  useEffect(() => { lsSet('ft-apmin-isa', isaDev) }, [isaDev])

  // Subset of airports: large hubs (filter by 'a' nonempty IATA)
  const hubAirports = useMemo(() => AIRPORTS.filter(a => !!a.a), [])

  // For each airborne aircraft below FL250, find nearest closing hub within capture
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const apWx = new Map<string, Wx>()
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || f.altitudeFt > 25000) continue
      if (f.vertRate > 200) continue // climbing not approaching
      const gs = Math.max(0, f.velocityKts || 0)
      const trk = f.track || 0
      // Nearest hub
      let bestAp = null as null | typeof hubAirports[0]
      let bestD = captureNm + 1
      for (const a of hubAirports) {
        const d = gcNm(f.lat, f.lng, a.lat, a.lon)
        if (d > captureNm) continue
        // Must be closing — track within +/-70deg of bearing-to-field
        const brg = bearing(f.lat, f.lng, a.lat, a.lon)
        let dh = ((brg - trk + 540) % 360) - 180
        if (Math.abs(dh) > 70) continue
        if (d < bestD) { bestD = d; bestAp = a }
      }
      if (!bestAp) continue
      const apKey = bestAp.i
      let wx = apWx.get(apKey)
      if (!wx) {
        wx = synthWx(bestAp.lat, bestAp.lon, flights, sampleRng, ceilOff, rvrOff, isaDev)
        apWx.set(apKey, wx)
      }
      const klass = classify(f.type, f.category)
      const acCap = KLASS_BEST[klass]
      // achievable = min(wx, acCap) by CAT_ORDER index
      const wxIdx = CAT_ORDER.indexOf(wx.wxCat)
      const acIdx = CAT_ORDER.indexOf(acCap)
      const achievIdx = Math.min(wxIdx, acIdx)
      const achievable = CAT_ORDER[achievIdx]
      const belowNpa = wxBelowNpa(wx.ceilFt, wx.rvrM)
      // margin: positive = weather permits more than ac needs; negative = wx forces downgrade
      const margin = wxIdx - acIdx
      let tier: Tier
      if (belowNpa) tier = 'NO-GO'
      else if (margin < 0) {
        // wx forces downgrade
        if (acIdx - wxIdx >= 2) tier = 'NO-GO'
        else tier = 'CAUTN'
      } else if (margin === 0) tier = 'TIGHT'
      else tier = 'LEGAL'
      // closure speed = GS * cos(heading-brg delta) (approx)
      const brgToFld = bearing(f.lat, f.lng, bestAp.lat, bestAp.lon)
      const dh = ((brgToFld - trk + 540) % 360) - 180
      const closingKt = gs * Math.cos(dh * Math.PI / 180)
      out.push({
        f, klass, altFt: f.altitudeFt, trk, gs,
        distNm: bestD, brgToFld, closingKt,
        apIcao: bestAp.i, apIata: bestAp.a, apCity: bestAp.m,
        apLat: bestAp.lat, apLng: bestAp.lon,
        wx, acCap, achievable, margin, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return a.distNm - b.distNm
    })
    return out
  }, [flights, hubAirports, captureNm, sampleRng, ceilOff, rvrOff, isaDev])

  // Airport rollup from rows
  const apRows: ApRow[] = useMemo(() => {
    const m = new Map<string, ApRow>()
    for (const r of rows) {
      let ar = m.get(r.apIcao)
      if (!ar) {
        ar = {
          icao: r.apIcao, iata: r.apIata,
          name: hubAirports.find(a => a.i === r.apIcao)?.n || '',
          city: r.apCity, lat: r.apLat, lng: r.apLng,
          wx: r.wx, inbound: 0, worstTier: 'LEGAL',
          drivingCat: r.wx.wxCat,
        }
        m.set(r.apIcao, ar)
      }
      ar.inbound++
      if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(ar.worstTier)) ar.worstTier = r.tier
    }
    const arr = Array.from(m.values())
    arr.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.worstTier) - TIER_ORDER.indexOf(b.worstTier)
      if (ti !== 0) return ti
      return b.inbound - a.inbound
    })
    return arr
  }, [rows, hubAirports])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { LEGAL: 0, TIGHT: 0, CAUTN: 0, 'NO-GO': 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    const total = rows.length
    let meanCeil = 0, n = 0, worstIata = '—', worstTierIdx = 99
    for (const ap of apRows) {
      meanCeil += ap.wx.ceilFt; n++
      const ti = TIER_ORDER.indexOf(ap.worstTier)
      if (ti < worstTierIdx) { worstTierIdx = ti; worstIata = ap.iata }
    }
    if (n > 0) meanCeil /= n
    return { total, meanCeil, worstIata }
  }, [rows, apRows])

  const filteredRows = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.apIata, r.apCity].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  const filteredAps = useMemo(() => {
    const q = query.trim().toUpperCase()
    return apRows.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (!q) return true
      return [a.iata, a.icao, a.city, a.name].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [apRows, tierFilter, query])

  // Map overlay
  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + Math.min(12, Math.max(0, 4 - r.margin) * 3) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFc = { type: 'FeatureCollection' as const, features: showProj ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.apLng, r.apLat]] },
    })) : [] }
    const tdzFc = { type: 'FeatureCollection' as const, features: showProj ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Point' as const, coordinates: [r.apLng, r.apLat] },
    })) : [] }
    const apFc = { type: 'FeatureCollection' as const, features: showAp ? apRows.map(a => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[a.worstTier] },
      geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] },
    })) : [] }
    const apLblFc = { type: 'FeatureCollection' as const, features: (showAp && showLabels) ? apRows.map(a => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[a.worstTier], text: `${a.iata} ${CAT_SHORT[a.wx.wxCat]} (${a.inbound})` },
      geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${CAT_SHORT[r.achievable]} ${r.distNm.toFixed(0)}nm`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_AP, apFc, () => map.addLayer({ id: LYR_AP, type: 'circle', source: SRC_AP, paint: {
        'circle-radius': 6,
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.85,
        'circle-stroke-color': '#020617',
        'circle-stroke-width': 1.6,
      } }))
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'circle', source: SRC_RING, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.6,
        'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.4,
        'line-opacity': 0.55,
        'line-dasharray': [3, 2],
      } }))
      ensure(SRC_TDZ, tdzFc, () => map.addLayer({ id: LYR_TDZ, type: 'circle', source: SRC_TDZ, paint: {
        'circle-radius': 4,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#020617',
        'circle-stroke-width': 1.2,
      } }))
      ensure(SRC_APLBL, apLblFc, () => map.addLayer({ id: LYR_APLBL, type: 'symbol', source: SRC_APLBL, layout: {
        'text-field': ['get', 'text'],
        'text-size': 11,
        'text-offset': [0, -1.4],
        'text-anchor': 'bottom',
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.4,
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
      for (const lyr of [LYR_LBL, LYR_APLBL, LYR_TDZ, LYR_PROJ, LYR_RING, LYR_AP]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_APLBL, SRC_TDZ, SRC_PROJ, SRC_RING, SRC_AP]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, apRows, showRing, showProj, showLabels, showAp])

  // SVG diagram: x = RVR (m), y = ceiling (ft)
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 26
    const xMaxR = 2500
    const yMaxC = 1200
    const xs = (m: number) => PAD + (Math.min(xMaxR, m) / xMaxR) * (W - PAD - 6)
    const ys = (ft: number) => H - PAD - (Math.min(yMaxC, ft) / yMaxC) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMaxR, yMaxC }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[80vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Approach Mins</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} inbound · {apRows.length} fields</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[10px] font-bold" style={{ color: TIER_COLOR[t] }}>{t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Inbound</div>
          <div className="font-mono text-sm text-slate-200">{summary.total}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst IATA</div>
          <div className="font-mono text-sm text-slate-200">{summary.worstIata}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Ceil</div>
          <div className="font-mono text-sm" style={{ color: summary.meanCeil < 200 ? '#ef4444' : summary.meanCeil < 500 ? '#f59e0b' : '#10b981' }}>
            {summary.meanCeil >= 1000 ? `${(summary.meanCeil / 1000).toFixed(1)}k` : summary.meanCeil.toFixed(0)}<span className="text-[9px] text-slate-500"> ft</span>
          </div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Ceiling × RVR · CAT ladder</div>
        <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
          {/* axes */}
          <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
          <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
          {/* CAT threshold lines */}
          {(['CAT IIIb','CAT IIIa','CAT II','CAT I','NPA'] as Cat[]).map((c, i) => {
            const m = CAT_MIN[c]
            const colors = ['#10b981', '#22d3ee', '#0ea5e9', '#f59e0b', '#94a3b8']
            const col = colors[i]
            return (
              <g key={c}>
                <line x1={diag.xs(m.rvr)} y1={diag.ys(m.dh)} x2={diag.W - 6} y2={diag.ys(m.dh)} stroke={col} strokeWidth={0.8} strokeDasharray="3 3" opacity={0.55} />
                <line x1={diag.xs(m.rvr)} y1={diag.ys(m.dh)} x2={diag.xs(m.rvr)} y2={diag.H - diag.PAD} stroke={col} strokeWidth={0.8} strokeDasharray="3 3" opacity={0.55} />
                <text x={diag.xs(m.rvr) + 3} y={diag.ys(m.dh) + 8} fontSize={8} fill={col} fontFamily="monospace">{CAT_SHORT[c]}</text>
              </g>
            )
          })}
          {/* y-axis labels */}
          {[100, 200, 400, 800, 1200].map(v => (
            <text key={v} x={diag.PAD - 3} y={diag.ys(v) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{v}ft</text>
          ))}
          {/* x-axis labels */}
          {[75, 200, 300, 550, 1600, 2500].map(v => (
            <text key={v} x={diag.xs(v)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{v}m</text>
          ))}
          {/* per-airport wx dots */}
          {apRows.map(a => (
            <g key={a.icao}>
              <circle cx={diag.xs(a.wx.rvrM)} cy={diag.ys(a.wx.ceilFt)} r={3.4} fill={TIER_COLOR[a.worstTier]} opacity={0.9} />
              <text x={diag.xs(a.wx.rvrM) + 4} y={diag.ys(a.wx.ceilFt) - 4} fontSize={7} fill="#94a3b8" fontFamily="monospace">{a.iata}</text>
            </g>
          ))}
        </svg>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>SAMPLE-RNG</span><span className="font-mono text-slate-300">{sampleRng}nm</span></div>
            <input type="range" min={20} max={200} step={10} value={sampleRng} onChange={e => setSampleRng(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CAPTURE</span><span className="font-mono text-slate-300">{captureNm}nm</span></div>
            <input type="range" min={10} max={120} step={5} value={captureNm} onChange={e => setCaptureNm(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CEIL-OFFSET</span><span className="font-mono text-slate-300">{ceilOff >= 0 ? '+' : ''}{ceilOff}ft</span></div>
            <input type="range" min={-1000} max={1500} step={50} value={ceilOff} onChange={e => setCeilOff(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>RVR-OFFSET</span><span className="font-mono text-slate-300">{rvrOff >= 0 ? '+' : ''}{rvrOff}m</span></div>
            <input type="range" min={-1500} max={2000} step={50} value={rvrOff} onChange={e => setRvrOff(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div className="col-span-2">
            <div className="flex justify-between text-[10px] text-slate-500"><span>ISA-DEV</span><span className="font-mono text-slate-300">{isaDev >= 0 ? '+' : ''}{isaDev}°C</span></div>
            <input type="range" min={-20} max={20} step={1} value={isaDev} onChange={e => setIsaDev(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showAp} onChange={e => setShowAp(e.target.checked)} className="accent-sky-500" /><span>AP</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / IATA / city"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 border-b border-slate-800 flex items-center gap-1 text-[10px]">
        {(['AIRCRAFT', 'AIRPORTS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2 py-0.5 rounded border font-mono ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
        ))}
        <span className="ml-auto text-slate-500">{tab === 'AIRCRAFT' ? filteredRows.length : filteredAps.length} shown</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredRows.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No inbound aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredRows.map(r => {
          const eta = r.closingKt > 5 ? r.distNm / r.closingKt * 60 : 99
          const ceilPct = Math.max(0, Math.min(100, (r.wx.ceilFt / 1200) * 100))
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
                  <span title="destination">{r.apIata}</span>
                  <span title="distance to field">{r.distNm.toFixed(0)}nm</span>
                  <span title="altitude">{(r.altFt / 1000).toFixed(1)}k</span>
                  <span title="ground speed">{r.gs.toFixed(0)}kt</span>
                  <span className="ml-auto" title="ETA min">ETA {eta < 99 ? eta.toFixed(0) + 'm' : '—'}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="ceiling 0-1200ft">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${ceilPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${(50 / 1200) * 100}%` }} title="CAT III DH" />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${(100 / 1200) * 100}%` }} title="CAT II DH" />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `${(200 / 1200) * 100}%` }} title="CAT I DH" />
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `${(400 / 1200) * 100}%` }} title="NPA MDH" />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="weather ceiling AGL">CEIL {r.wx.ceilFt < 1000 ? r.wx.ceilFt.toFixed(0) + 'ft' : (r.wx.ceilFt / 1000).toFixed(1) + 'k'}</span>
                  <span title="weather RVR">RVR {r.wx.rvrM.toFixed(0)}m</span>
                  <span className="ml-auto" title="weather-allowed CAT" style={{ color: TIER_COLOR[r.tier] }}>WX {CAT_SHORT[r.wx.wxCat]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="aircraft best capability">A/C {CAT_SHORT[r.acCap]}</span>
                  <span title="achievable CAT given wx ∩ capability" style={{ color: TIER_COLOR[r.tier] }}>USE {CAT_SHORT[r.achievable]}</span>
                  <span className="ml-auto truncate">{r.f.operator || r.apCity || '\u2014'}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'AIRPORTS' && filteredAps.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No airports with inbound traffic.</div>
        )}
        {tab === 'AIRPORTS' && filteredAps.map(a => {
          const ceilPct = Math.max(0, Math.min(100, (a.wx.ceilFt / 1200) * 100))
          return (
            <button key={a.icao} onClick={() => { if (map) { try { map.flyTo({ center: [a.lng, a.lat], zoom: Math.max(map.getZoom(), 9), duration: 700 }) } catch {} } }}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.iata}</span>
                  <span className="text-slate-500 truncate">{a.city}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.inbound} inb</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${ceilPct}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${(50 / 1200) * 100}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${(100 / 1200) * 100}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `${(200 / 1200) * 100}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `${(400 / 1200) * 100}%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="ceiling AGL">CEIL {a.wx.ceilFt < 1000 ? a.wx.ceilFt.toFixed(0) + 'ft' : (a.wx.ceilFt / 1000).toFixed(1) + 'k'}</span>
                  <span title="RVR">RVR {a.wx.rvrM.toFixed(0)}m</span>
                  <span className="ml-auto" title="weather-allowed CAT" style={{ color: TIER_COLOR[a.worstTier] }}>{CAT_SHORT[a.wx.wxCat]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span>{a.icao}</span>
                  <span className="truncate">{a.name || '\u2014'}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
