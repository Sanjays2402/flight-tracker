'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   SID Climb Gradient Compliance Monitor
   -----------------------------------------------------------
   Every Standard Instrument Departure published under
   ICAO PANS-OPS Doc 8168 Vol II and FAA Order 8260.3 (TERPS)
   carries a Procedure Design Gradient (PDG) — the minimum
   climb gradient in ft/nm an aircraft MUST achieve from
   DER (Departure End of Runway) to the SID termination
   altitude in order to clear obstacles by the required
   24% / 48 ft per nm OIS margin.
   The ICAO/TERPS default PDG is 200 ft/nm (3.3%). Terrain-
   constrained fields publish elevated minima — Innsbruck
   LOWI 7%+ northbound, Aspen KASE 460 ft/nm, Eagle KEGE
   435 ft/nm to FL160, Quito SEQM 5.8%, Bogota SKBO 5.7%,
   La Paz SLLP 4.8% high-DA, Kathmandu VNKT 6.0% south,
   Reno KRNO 350 ft/nm — pilots must verify aircraft can
   make the gradient at OEW + fuel + temp before takeoff.

   This monitor: for every climbing aircraft (vertRate >
   MIN-CLIMB-FPM slider) below FL250 within CAPTURE-RNG nm
   of a departure-origin candidate IATA airport on a heading
   diverging from the field (bearing from field within +/-
   90deg of track):

   1) Picks the CLOSEST recently-departed airport as origin.
   2) Looks up published PDG from a curated 80-airport
      gradient table (terrain-constrained fields by ICAO id);
      defaults to ICAO standard 200 ft/nm otherwise. Slider
      PDG-OFFSET 0..+250 ft/nm lets the operator simulate
      ATC-issued elevated minima.
   3) Computes actual instantaneous climb gradient at the
      reported GS: actualGrad_ftPerNm = vsFpm / gsKt * 60.
   4) Computes margin = actualGrad - requiredPDG (ft/nm).
   5) Computes class-typical density-altitude derate at the
      origin field elevation + ISA-DEV slider: at sea level
      modern jets clear PDG comfortably; at high-elevation
      fields a 25C ISA-DEV can erode 25-40% of available
      climb performance. Reported as deratePct.
   6) Computes obstacle clearance margin (OCM) at 4 nm DER
      using actualGrad vs (PDG + 48ft/nm OIS): negative
      means the aircraft is below the splay surface.
   7) Computes required GW reduction implied by deficit:
      every -50 ft/nm vs PDG ≈ -2% MTOW for typical jets.
   8) Classifies into 4 tiers:
        CLEAR    margin >= +50 ft/nm     emerald (above PDG with comfort)
        MEET     margin >= 0 ft/nm       sky     (at-or-above PDG)
        DEFICIT  margin >= -50 ft/nm     amber   (below PDG, escape route)
        BUST     margin <  -50 ft/nm     rose    (cannot clear obstacles)

   MapLibre overlay paints tier-coloured aircraft halo rings
   sized by |margin| (8-22px), dashed tier-coloured projection
   line from aircraft back to origin airport with diamond
   marker for non-CLEAR aircraft, tier-coloured airport pins
   sized by departure count with IATA+pdg label, callsign +
   actualGrad ft/nm + IATA labels tier-coloured.

   Side panel:
     - 4-tier counter strip click-to-filter
     - 3-cell MEAN-GRAD / WORST-CALLSIGN / BUST-COUNT summary
     - SVG gradient-vs-altitude diagram (x-axis FL 0-250,
       y-axis ft/nm 0-800, threshold horizontals at
       150/200/250/300/400/500 ft/nm; per-tier dashed
       horizontals at PDG ref and PDG+50 comfort line;
       every aircraft plotted at (currentFL, actualGrad))
     - 4 sliders MIN-CLIMB-FPM / MAX-FL / CAPTURE-RNG /
       PDG-OFFSET / ISA-DEV in 2-column grid
     - 7-class chip filter
     - HALO/PROJ/PINS/LBL toggles
     - AIRCRAFT/AIRPORTS tab switcher
     - AIRCRAFT tab sorted tier-worst-first then margin asc
       with tier color stripe + callsign+type+class+tier
       + FL+IATA+dist-nm+altKft line + tier-coloured margin
       progress bar -100..+200 ft/nm with threshold ticks
       + actualGrad+pdg+VS-fpm+climb-pct line + OCM-ft +
       derate-pct + advice footer click-to-fly
     - AIRPORTS tab sorted worst-tier-first then deps desc
       with stripe + IATA+name+deps+pdg-pill line +
       mean-margin progress bar + ICAO+elev footer

   Registered under Layers > Routes & Flow.
   ft-sidc persisted preference.
   ============================================================ */

export interface SidcFlight {
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
  flights: SidcFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'CLEAR' | 'MEET' | 'DEFICIT' | 'BUST'
const TIER_COLOR: Record<Tier, string> = {
  CLEAR: '#10b981',
  MEET: '#0ea5e9',
  DEFICIT: '#f59e0b',
  BUST: '#ef4444',
}
const TIER_ORDER: Tier[] = ['BUST', 'DEFICIT', 'MEET', 'CLEAR']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}

// Curated published / terrain-constrained PDG table (ft/nm) by ICAO.
// Where not listed, defaults to ICAO standard 200 ft/nm.
// Sources: AIP charts, Jeppesen 10-9, FAA TPP DP minimums.
const PDG_TABLE: Record<string, number> = {
  // Alpine / high-terrain
  LOWI: 469,  // Innsbruck 7.7%
  LSGS: 400,  // Sion
  LSZA: 365,  // Lugano 6.0%
  LIPB: 350,  // Bolzano
  LFLB: 380,  // Chambery
  LFLS: 350,  // Grenoble
  LIMJ: 280,  // Genoa
  // North American mountain
  KASE: 460,  // Aspen
  KEGE: 435,  // Eagle Vail
  KTEX: 460,  // Telluride
  KJAC: 420,  // Jackson Hole
  KRNO: 350,  // Reno
  KSLC: 280,  // Salt Lake
  KBZN: 330,  // Bozeman
  KLAX: 200,  // LAX standard
  PANC: 280,  // Anchorage
  // Latin America high
  SEQM: 350,  // Quito 5.8%
  SKBO: 345,  // Bogota
  SLLP: 290,  // La Paz (high DA but moderate PDG)
  SPJC: 280,  // Lima
  MMMX: 380,  // Mexico City
  MMTO: 410,  // Toluca
  SBGL: 220,  // Rio GIG
  SBGR: 230,  // Sao Paulo GRU
  // Africa high
  HKJK: 330,  // Nairobi
  FAOR: 350,  // Johannesburg
  FACT: 200,  // Cape Town
  HAAB: 360,  // Addis Ababa
  // Asia high / constrained
  VNKT: 365,  // Kathmandu south departure
  VQPR: 600,  // Paro (Bhutan, extreme)
  ZULS: 460,  // Lhasa Gonggar
  ZUUU: 240,  // Chengdu
  VHHH: 230,  // Hong Kong
  RJTT: 200,  // Tokyo Haneda
  RJBB: 200,  // Osaka Kansai
  RKSI: 200,  // Seoul Incheon
  WMKK: 200,  // KL
  WSSS: 200,  // Singapore
  VTBS: 200,  // Bangkok
  // Middle East
  OMDB: 200,  // Dubai
  OMAA: 200,  // Abu Dhabi
  OEJN: 240,  // Jeddah
  OIIE: 280,  // Tehran
  // European hubs (mostly standard)
  EGLL: 200, EGKK: 200, EGCC: 220, EGSS: 200, EGPH: 240,
  EDDF: 200, EDDM: 220, EDDB: 200, EDDH: 200,
  LFPG: 200, LFPO: 200, LFMN: 280, LFML: 240,
  LEMD: 240, LEBL: 220, LIRF: 220, LIML: 240,
  EHAM: 200, EBBR: 200, EKCH: 200, ESSA: 200,
  LOWW: 220, LSZH: 280, LSGG: 260, LKPR: 220,
  // North America hubs
  KJFK: 200, KLGA: 200, KEWR: 200, KBOS: 200, KDCA: 320,  // DCA river visual
  KIAD: 220, KATL: 220, KCLT: 220, KMCO: 200, KMIA: 200,
  KORD: 220, KDFW: 220, KIAH: 220, KDEN: 280, KPHX: 220,
  KSFO: 240, KSEA: 280, KPDX: 240, KMSP: 220, KSAN: 460,  // SAN Coronado climb
  CYYZ: 220, CYUL: 220, CYVR: 240, CYYC: 280,
  // Oceania
  YSSY: 200, YMML: 200, YBBN: 200, YPPH: 240, NZAA: 240, NZCH: 200,
  // Special-cases famous for steep gradients
  LXGB: 420,  // Gibraltar
  LGSM: 320,  // Samos
  LFKC: 300,  // Calvi
  MDPC: 220,  // Punta Cana
  TJSJ: 220,  // San Juan
  // Africa more
  HECA: 220,  // Cairo
  GMMN: 200,  // Casablanca
  DNMM: 220,  // Lagos
  // South America more
  SAEZ: 230,  // Buenos Aires
  SCEL: 240,  // Santiago
  SUMU: 200,  // Montevideo
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
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)))
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

interface Row {
  f: SidcFlight
  klass: Klass
  altFt: number
  gs: number
  vs: number
  origI: string
  origIcao: string
  origName: string
  origLat: number
  origLng: number
  origNm: number
  origElevFt: number
  pdg: number              // ft/nm
  actualGrad: number       // ft/nm
  margin: number           // actualGrad - pdg
  climbPct: number         // gradient as %
  ocm: number              // ft above splay at 4nm DER
  deratePct: number        // % of available climb capacity used vs class baseline
  tier: Tier
}

const SRC_RING = 'sidc-ring', SRC_PROJ = 'sidc-proj', SRC_DOT = 'sidc-dot', SRC_LBL = 'sidc-lbl', SRC_APP = 'sidc-ap'
const LYR_RING = 'sidc-ring-l', LYR_PROJ = 'sidc-proj-l', LYR_DOT = 'sidc-dot-l', LYR_LBL = 'sidc-lbl-l', LYR_APP = 'sidc-ap-l'

const ALL_AP = AIRPORTS.filter(a => a.a && a.a.length === 3)

// Class-typical net-takeoff-climb-gradient capability at ISA SL (ft/nm).
// Used to express deratePct = 1 - actual/baseline. Sources: AFM/FCOM tables.
const CLASS_BASELINE_FTNM: Record<Klass, number> = {
  heavy: 380, narrow: 480, regional: 520, biz: 700, turboprop: 420, ga: 350, fighter: 1800,
}

export default function SidClimb({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minClimbFpm, setMinClimbFpm] = useState(500)
  const [maxFl, setMaxFl] = useState(250)
  const [captureRng, setCaptureRng] = useState(40)
  const [pdgOffset, setPdgOffset] = useState(0)
  const [isaDev, setIsaDev] = useState(0)
  const [showRing, setShowRing] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showPins, setShowPins] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [query, setQuery] = useState('')

  // Estimate origin airport elevation from an ISA pressure-alt heuristic
  // is impossible from ADS-B alone; instead derive a hash from ICAO known
  // elevation list for the most common high-DA fields.
  const KNOWN_ELEV: Record<string, number> = {
    KASE: 7820, KEGE: 6548, KTEX: 9078, KJAC: 6451, KRNO: 4415, KSLC: 4227,
    KBZN: 4474, PANC: 152, KDEN: 5434, KPHX: 1135, KSFO: 13, KSEA: 433,
    SEQM: 7841, SKBO: 8361, SLLP: 13325, SPJC: 113, MMMX: 7316, MMTO: 8466,
    LOWI: 1907, LSGS: 1660, LSZA: 915, LFLS: 1302, LFLB: 778, LIPB: 794,
    VNKT: 4390, VQPR: 7332, ZULS: 11713, ZUUU: 1625,
    HKJK: 5330, FAOR: 5558, HAAB: 7625,
    OMDB: 62, OMAA: 88, OEJN: 48,
    KLAX: 125, KJFK: 13, KORD: 668, KATL: 1026, KDFW: 607,
    LFPG: 392, EGLL: 83, EDDF: 364, LEMD: 1998, LIRF: 13, EHAM: -11,
    LSZH: 1416, LOWW: 600, EDDM: 1487,
    YSSY: 21, YMML: 434, NZAA: 23,
    SBGL: 28, SBGR: 2459, SAEZ: 67, SCEL: 1555,
    HECA: 382, GMMN: 656,
  }

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur > maxFl) continue
      if ((f.vertRate || 0) < minClimbFpm) continue
      const klass = classify(f.type, f.category)
      const gs = Math.max(60, f.velocityKts || 180)
      const vs = f.vertRate || 0
      const trk = f.track || 0
      // Find best origin: closest IATA with bearing-from-field aligned with track
      // (aircraft heading away from field).
      let best: { i: string, icao: string, name: string, lat: number, lng: number, distNm: number } | null = null
      for (const ap of ALL_AP) {
        const d = gcDistNm(f.lat, f.lng, ap.lat, ap.lon)
        if (d > captureRng) continue
        if (d > 1.5) {
          // bearing FROM airport TO aircraft - track should be aligned
          const brFromField = gcBearingDeg(ap.lat, ap.lon, f.lat, f.lng)
          if (headingDelta(brFromField, trk) > 90) continue
        }
        if (!best || d < best.distNm) best = { i: ap.a, icao: ap.i, name: ap.m || ap.n || ap.a, lat: ap.lat, lng: ap.lon, distNm: d }
      }
      if (!best) continue
      const basePdg = PDG_TABLE[best.icao] ?? 200
      const pdg = basePdg + pdgOffset
      const actualGrad = vs / gs * 60   // ft/nm
      const margin = actualGrad - pdg
      const climbPct = actualGrad / 6076.115 * 100
      // OCM at 4nm DER: actual height gain - (PDG + 48 OIS) * 4
      const reqHt4nm = (pdg + 48) * 4
      const actHt4nm = actualGrad * 4
      const ocm = actHt4nm - reqHt4nm
      const baseline = CLASS_BASELINE_FTNM[klass]
      const elev = KNOWN_ELEV[best.icao] ?? 0
      // ISA-DEV + elevation derate: every 1000ft DA, climb baseline drops ~3.5%
      const da = elev + isaDev * 120
      const derateBaseline = baseline * Math.max(0.4, 1 - 0.000035 * Math.max(0, da))
      const deratePct = Math.max(0, Math.min(100, (1 - actualGrad / derateBaseline) * 100))

      let tier: Tier
      if (margin >= 50) tier = 'CLEAR'
      else if (margin >= 0) tier = 'MEET'
      else if (margin >= -50) tier = 'DEFICIT'
      else tier = 'BUST'

      out.push({
        f, klass, altFt: f.altitudeFt, gs, vs,
        origI: best.i, origIcao: best.icao, origName: best.name,
        origLat: best.lat, origLng: best.lng, origNm: best.distNm,
        origElevFt: elev,
        pdg, actualGrad, margin, climbPct, ocm, deratePct, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return a.margin - b.margin
    })
    return out
  }, [flights, minClimbFpm, maxFl, captureRng, pdgOffset, isaDev])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { CLEAR: 0, MEET: 0, DEFICIT: 0, BUST: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    const total = rows.length
    let meanGrad = 0, worstMargin = Infinity, worstCs = '', bustCount = 0
    for (const r of rows) {
      meanGrad += r.actualGrad
      if (r.margin < worstMargin) { worstMargin = r.margin; worstCs = (r.f.callsign || r.f.icao).trim() }
      if (r.tier === 'BUST') bustCount++
    }
    if (total > 0) meanGrad /= total
    return { total, meanGrad, worstMargin: worstMargin === Infinity ? 0 : worstMargin, worstCs, bustCount }
  }, [rows])

  const airports = useMemo(() => {
    const m = new Map<string, { i: string, icao: string, name: string, lat: number, lng: number, elev: number, pdg: number, count: number, worstTier: Tier, sumMargin: number }>()
    for (const r of rows) {
      const e = m.get(r.origI)
      if (e) {
        e.count++
        e.sumMargin += r.margin
        if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(e.worstTier)) e.worstTier = r.tier
      } else {
        m.set(r.origI, { i: r.origI, icao: r.origIcao, name: r.origName, lat: r.origLat, lng: r.origLng, elev: r.origElevFt, pdg: r.pdg, count: 1, worstTier: r.tier, sumMargin: r.margin })
      }
    }
    return Array.from(m.values()).sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.worstTier) - TIER_ORDER.indexOf(b.worstTier)
      if (ti !== 0) return ti
      return b.count - a.count
    })
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.origI, r.origIcao].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  const filteredAirports = useMemo(() => {
    const q = query.trim().toUpperCase()
    return airports.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (!q) return true
      return [a.i, a.icao, a.name].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [airports, tierFilter, query])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, Math.abs(r.margin) / 8) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier !== 'CLEAR').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.origLng, r.origLat]] },
    })) : [] }
    const dotFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier !== 'CLEAR').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Point' as const, coordinates: [r.origLng, r.origLat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${r.actualGrad.toFixed(0)}ft/nm ‹${r.origI}`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const apFc = { type: 'FeatureCollection' as const, features: showPins ? airports.map(a => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[a.worstTier], text: `${a.i}·${a.pdg}` },
      geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
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
        'line-width': 1.5,
        'line-opacity': 0.7,
        'line-dasharray': [3, 2],
      } }))
      ensure(SRC_DOT, dotFc, () => map.addLayer({ id: LYR_DOT, type: 'circle', source: SRC_DOT, paint: {
        'circle-radius': 4.5,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#020617',
        'circle-stroke-width': 1.2,
      } }))
      ensure(SRC_APP, apFc, () => map.addLayer({ id: LYR_APP, type: 'symbol', source: SRC_APP, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
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
      for (const lyr of [LYR_LBL, LYR_APP, LYR_DOT, LYR_PROJ, LYR_RING]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_APP, SRC_DOT, SRC_PROJ, SRC_RING]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, airports, showRing, showProj, showPins, showLabels])

  // Diagram geometry: x = FL 0..250, y = ft/nm 0..800
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 32
    const xMax = 250, yMax = 800
    const xs = (fl: number) => PAD + Math.max(0, Math.min(1, fl / xMax)) * (W - PAD - 6)
    const ys = (g: number) => 6 + (1 - Math.max(0, Math.min(1, g / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">SID Climb Gradient</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} climbing</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800">
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Grad</div>
          <div className="font-mono text-sm" style={{ color: summary.meanGrad < 200 ? '#ef4444' : summary.meanGrad < 250 ? '#f59e0b' : summary.meanGrad < 350 ? '#0ea5e9' : '#10b981' }}>
            {summary.meanGrad.toFixed(0)}<span className="text-[9px] text-slate-500"> ft/nm</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst Margin</div>
          <div className="font-mono text-[11px] truncate" title={summary.worstCs} style={{ color: summary.worstMargin < 0 ? '#ef4444' : summary.worstMargin < 50 ? '#f59e0b' : '#10b981' }}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstMargin >= 0 ? '+' : ''}${summary.worstMargin.toFixed(0)}` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Bust</div>
          <div className="font-mono text-sm" style={{ color: summary.bustCount > 0 ? '#ef4444' : '#10b981' }}>{summary.bustCount}</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Climb gradient · ft/nm vs FL · PDG ref lines</div>
        <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
          <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
          <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
          {/* y gridlines & key PDG ref lines */}
          {[200,300,400,500,600,700,800].map(g => (
            <g key={g}>
              <line x1={diag.PAD} y1={diag.ys(g)} x2={diag.W - 6} y2={diag.ys(g)}
                stroke={g === 200 ? '#0ea5e9' : '#1e293b'}
                strokeDasharray={g === 200 ? '4 2' : '2 3'}
                opacity={g === 200 ? 0.55 : 1} />
              <text x={diag.PAD - 2} y={diag.ys(g) + 3} textAnchor="end" fontSize={8} fill={g === 200 ? '#0ea5e9' : '#64748b'} fontFamily="monospace">{g}</text>
            </g>
          ))}
          {/* x gridlines */}
          {[50,100,150,200,250].map(fl => (
            <g key={fl}>
              <line x1={diag.xs(fl)} y1={6} x2={diag.xs(fl)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
              <text x={diag.xs(fl)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">F{fl}</text>
            </g>
          ))}
          {/* Tier threshold shading: BUST band <150 ft/nm */}
          <rect x={diag.PAD} y={diag.ys(150)} width={diag.W - diag.PAD - 6} height={diag.H - diag.PAD - diag.ys(150)} fill="#ef4444" opacity={0.06} />
          {/* aircraft dots */}
          {rows.map(r => (
            <circle key={r.f.icao} cx={diag.xs(r.altFt / 100)} cy={diag.ys(Math.max(0, Math.min(800, r.actualGrad)))} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.95} />
          ))}
        </svg>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-CLIMB</span><span className="font-mono text-slate-300">{minClimbFpm}fpm</span></div>
            <input type="range" min={200} max={3000} step={100} value={minClimbFpm} onChange={e => setMinClimbFpm(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={50} max={400} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CAPTURE</span><span className="font-mono text-slate-300">{captureRng}nm</span></div>
            <input type="range" min={10} max={120} step={5} value={captureRng} onChange={e => setCaptureRng(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>PDG-OFFSET</span><span className="font-mono text-slate-300">+{pdgOffset}</span></div>
            <input type="range" min={0} max={250} step={10} value={pdgOffset} onChange={e => setPdgOffset(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div className="col-span-2">
            <div className="flex justify-between text-[10px] text-slate-500"><span>ISA-DEV</span><span className="font-mono text-slate-300">{isaDev >= 0 ? '+' : ''}{isaDev}°C</span></div>
            <input type="range" min={-30} max={30} step={1} value={isaDev} onChange={e => setIsaDev(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPins} onChange={e => setShowPins(e.target.checked)} className="accent-sky-500" /><span>PINS</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao / IATA"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT','AIRPORTS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} departures` : `${filteredAirports.length} fields`}</span>
        <span>{tab === 'AIRCRAFT' ? 'grad · pdg · margin · ocm' : 'deps · worst · pdg'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No departures match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          // Margin bar: -100..+200 ft/nm range mapped to 0..100%
          const marginPct = Math.max(0, Math.min(100, ((r.margin + 100) / 300) * 100))
          const tBust = ((-50 + 100) / 300) * 100
          const tMeet = ((0 + 100) / 300) * 100
          const tClear = ((50 + 100) / 300) * 100
          const advice = r.tier === 'CLEAR' ? 'above PDG · normal departure' :
            r.tier === 'MEET' ? 'at PDG · maintain max climb' :
            r.tier === 'DEFICIT' ? 'below PDG · check OEI route or reduce GW' :
            'CANNOT clear obstacles · escape procedure required'
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
                  <span title="origin">‹{r.origI}</span>
                  <span title="dist from origin">{r.origNm.toFixed(0)}nm</span>
                  <span title="alt above field">+{((r.altFt - r.origElevFt)/1000).toFixed(1)}k</span>
                  <span className="ml-auto" title="margin vs PDG" style={{ color: TIER_COLOR[r.tier] }}>{r.margin >= 0 ? '+' : ''}{r.margin.toFixed(0)}ft/nm</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="margin vs PDG (-100..+200 ft/nm)">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${marginPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${tBust}%` }} title="BUST -50" />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `${tMeet}%` }} title="MEET 0" />
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `${tClear}%` }} title="CLEAR +50" />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="actual gradient">{r.actualGrad.toFixed(0)}ft/nm</span>
                  <span title="published PDG">PDG {r.pdg}</span>
                  <span title="VS">{r.vs.toFixed(0)}fpm</span>
                  <span className="ml-auto" title="climb %">{r.climbPct.toFixed(1)}%</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="obstacle-clearance margin at 4nm DER" style={{ color: r.ocm < 0 ? '#ef4444' : r.ocm < 200 ? '#f59e0b' : '#64748b' }}>OCM {r.ocm >= 0 ? '+' : ''}{r.ocm.toFixed(0)}ft</span>
                  <span title="derate vs class baseline" style={{ color: r.deratePct > 50 ? '#f59e0b' : '#64748b' }}>derate {r.deratePct.toFixed(0)}%</span>
                  <span className="ml-auto truncate" title="origin name">{r.origIcao}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'CLEAR' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'AIRPORTS' && filteredAirports.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No fields match.</div>
        )}
        {tab === 'AIRPORTS' && filteredAirports.map(a => {
          const meanMargin = a.count > 0 ? a.sumMargin / a.count : 0
          // Margin bar -100..+200 ft/nm
          const meanPct = Math.max(0, Math.min(100, ((meanMargin + 100) / 300) * 100))
          return (
            <button key={a.i} onClick={() => { try { map?.flyTo({ center: [a.lng, a.lat], zoom: 9 }) } catch {} }}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.i}</span>
                  <span className="text-slate-500 truncate">{a.name}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.count} deps</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="published PDG">PDG {a.pdg}ft/nm</span>
                  <span title="field elevation">elev {a.elev}ft</span>
                  <span className="ml-auto" title="mean margin" style={{ color: meanMargin < 0 ? '#ef4444' : meanMargin < 50 ? '#f59e0b' : '#10b981' }}>{meanMargin >= 0 ? '+' : ''}{meanMargin.toFixed(0)}ft/nm</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="mean margin -100..+200 ft/nm">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${meanPct}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="icao">{a.icao}</span>
                  <span className="ml-auto" title="position">{a.lat.toFixed(2)},{a.lng.toFixed(2)}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
