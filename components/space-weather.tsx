'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Space Weather Impact Monitor
   -----------------------------------------------------------
   NOAA SWPC G-scale Kp / S-scale SEP / R-scale X-ray combined
   passive watch for every airborne aircraft, modelling three
   operationally consequential space-weather effects per ICAO
   Annex 3 Amendment 78 Space Weather provisions (effective 2019)
   plus FAA AC 120-42B Polar Operations:

     1) HF voice blackout (polar route degradation) — proxy for
        D-region absorption + polar cap absorption (PCA) events,
        scaled by aircraft geomagnetic latitude (CGM lat) and Kp.
        ICAO Doc 10100 polar ops requires HF radio coverage along
        the route; severe HF degradation forces equatorward
        diversion. Drop a tier when |CGM lat| > 60deg and Kp >= 5.

     2) GNSS scintillation (signal phase/amplitude fades) —
        affects RAIM, ADS-B Out NIC, RNAV/RNP integrity. Two
        peak zones per ITU-R P.531: equatorial anomaly +/-20deg
        magnetic (post-sunset hours, ionospheric bubbles) and
        auroral oval (|CGM lat| 60-75deg). Kp scales auroral.
        Severity also depends on S-scale SEP for polar regions
        per ESA Galileo Service Definition Doc.

     3) Cosmic / SEP radiation dose-rate elevation — galactic
        cosmic ray (GCR) background plus solar particle event
        (SPE) enhancement. Per ICRP-132 + CARI-7 reference dose
        rates at FL350 50N = 5.3 uSv/h baseline. SEP events can
        elevate dose rate 10-100x for hours (Bartol GLE catalog).
        Crew dose limits: 6 mSv/yr (EU Council Directive 2013/59
        Article 23) or 1 mSv (general public). Per-flight legal
        limit not specified, but op-spec MAS triggers descent
        below FL280 above 5 uSv/h sustained.

   Kp synthesis: deterministic seeded by current hour-of-year +
   KP-FORCE slider 0=AUTO..9 manual G-scale override. AUTO uses
   a smooth 2*pi*hour/720 modulation centred on KP-BASE slider
   1-7 producing realistic 1-7 Kp swings every ~30 days mimicking
   solar rotation 27-day Carrington period.

   Per aircraft compute:
     - geomag lat (CGM) via IGRF-13 dipole approximation:
         lat_cgm = asin(sin(lat)*cos(11.5deg) -
                        cos(lat)*sin(11.5deg)*cos(lng-289deg))
       (geomag pole 80.65N, 287.32E approx 2024 epoch)
     - HF blackout severity HFsev (0-100):
         base = max(0, Kp - 3) * 12   (D-region)
         polar boost = (|CGM lat| > 60) ? (|CGM lat| - 60) * 2 : 0
         scaled by HF-PEN slider 50-200%
     - GNSS scintillation severity SCsev (0-100):
         auroral = (|CGM lat| in [60,75]) ? max(0, Kp - 4) * 18 : 0
         equatorial = (|CGM lat| < 20 && hourLocal in [18,02]) ? 25 + S * 10 : 0
         polar SEP = (|CGM lat| > 70 && S >= 2) ? S * 22 : 0
         scaled by SCINT-PEN slider 50-200%
     - Cosmic dose rate uSv/h:
         CARI-7 lookup: dose = base(altFt) * latFactor(|CGM lat|) * SEPmult
         base(altFt) = 0.4 * (altFt/10000)^1.4  (sea=0, FL410=8 uSv/h)
         latFactor = 0.4 (eq) -> 1.0 (60deg) -> 1.2 (polar)
         SEPmult = 1 + S * S * 0.8   (S5 -> 1+25*0.8 = 21x)
     - Effective FL bracket: per-route dose * tToDest synthesised
       from class endurance (HVY 12h, NRW 6h, BIZ 7h, RGN 3h,
       TBP 2h, GA 1h, FTR 1.5h) yields trip-dose uSv proxy.

   Tier classification (worst of three effects):
     EXTREME  any of: HFsev>=80 OR SCsev>=80 OR dose>=15uSv/h  rose
     STRONG   any of: HFsev>=50 OR SCsev>=50 OR dose>=8uSv/h   amber
     ELEVATED any of: HFsev>=20 OR SCsev>=20 OR dose>=5uSv/h   sky
     QUIET    all below                                        emerald

   MapLibre overlay:
     - tier-coloured halo rings sized by tier rank 8-22px
     - amber dashed CGM-equator-relative iso-lat polylines at 60 and 75
       drawn as 36-sample great-circles around magnetic pole (visual
       reference for auroral oval boundaries)
     - tier-coloured callsign + Kp + dose labels for non-QUIET aircraft
     - rose diamond pin at predicted descent waypoint for EXTREME dose
       (50nm ahead along ground track) to suggest descent to FL280

   Side panel:
     - 4-tier counter strip click-to-filter
     - 3-cell GLOBAL-Kp tier-coloured / GLOBAL-S-RB / WORST callsign+drv summary
     - 2-cell MEAN-DOSE-uSv-h / POLAR-AC-COUNT secondary row
     - SVG dose-vs-FL scatter with 5/8/15 uSv/h amber/sky/rose threshold
       bands shaded, dashed threshold lines, every aircraft plotted
     - 6 sliders KP-BASE 1-7 / KP-FORCE 0-9 / S-SCALE 0-5 /
       HF-PEN 50-200% / SCINT-PEN 50-200% / MIN-FL 0-400
     - 7-class chip filter HVY/NRW/RGN/BIZ/TBP/GA/FTR
     - HALO/OVAL/PIN/LBL/DIAG toggles + search
     - AIRCRAFT/REGIONS tab switcher
     - AIRCRAFT tab tier-worst-first then dose desc with tier color
       stripe, callsign+type+class-pill+tier-pill, FL/CGM-lat/dose line,
       3-bar HF/SCINT/DOSE severity progress bars, dominant-driver +
       advice (descend FL280 / divert equatorward / monitor GNSS / nominal)
     - REGIONS tab grouped by CGM-lat band (POLAR>75, AURORAL 60-75,
       MID-LAT 20-60, EQUAT<20) sorted tier-worst-first with stripe,
       ac-count, mean-dose progress bar, worst-callsign footer

   Registered: Layers > Environment
   Persisted: ft-spwx
   ============================================================ */

export interface SwxFlight {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  category?: number | string
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
  flights: SwxFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'EXTREME' | 'STRONG' | 'ELEVATED' | 'QUIET'
const TIER_COLOR: Record<Tier, string> = {
  EXTREME: '#f43f5e',
  STRONG: '#f59e0b',
  ELEVATED: '#0ea5e9',
  QUIET: '#10b981',
}
const TIER_ORDER: Tier[] = ['EXTREME', 'STRONG', 'ELEVATED', 'QUIET']
const TIER_RANK: Record<Tier, number> = { EXTREME: 0, STRONG: 1, ELEVATED: 2, QUIET: 3 }

type Klass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const KLASS_LABEL: Record<Klass, string> = {
  HVY: 'Heavy', NRW: 'Narrow', RGN: 'Regional', BIZ: 'Biz-jet', TBP: 'Turboprop', GA: 'GA', FTR: 'Fighter',
}
const KLASS_ENDURANCE: Record<Klass, number> = {
  HVY: 12, NRW: 6, BIZ: 7, RGN: 3, TBP: 2, GA: 1, FTR: 1.5,
}
function classifyAc(category?: number | string, type?: string): Klass {
  const t = (type || '').toUpperCase()
  if (/F-?(16|18|22|35)|EUFI|RAFL|MIG|SU-?\d|F15|F14/.test(t)) return 'FTR'
  if (/B74|B77|B78|A35|A38|A34|A33|MD11|IL76|A380|B748/.test(t)) return 'HVY'
  if (/B73|A32|A31|A20N|A21N|B38M|B39M|MD8|MD9|A220/.test(t)) return 'NRW'
  if (/E17|E19|E29|CRJ|ATR|DH8|E145|RJ85|B190|SF34/.test(t)) return /ATR|DH8|B190|SF34/.test(t) ? 'TBP' : 'RGN'
  if (/GLF|GLEX|FA[0-9]|C56|C68|C25|C75|LJ|H25|GL5|GL6/.test(t)) return 'BIZ'
  const cat = typeof category === 'string' ? parseInt(category, 10) : category
  if (cat === 1) return 'TBP'
  if (cat === 2 || cat === 3) return 'NRW'
  if (cat === 4 || cat === 5 || cat === 6) return 'HVY'
  if (cat === 7) return 'BIZ'
  return 'GA'
}

const SRC_HALO = 'swx-halo-src', LYR_HALO = 'swx-halo-lyr'
const SRC_OVAL = 'swx-oval-src', LYR_OVAL = 'swx-oval-lyr'
const SRC_PIN  = 'swx-pin-src',  LYR_PIN  = 'swx-pin-lyr'
const SRC_LBL  = 'swx-lbl-src',  LYR_LBL  = 'swx-lbl-lyr'

// IGRF-13 dipole approximation for geomagnetic latitude.
// Geomagnetic north pole 2024 epoch: ~80.65N 287.32E
const MAG_POLE_LAT = 80.65
const MAG_POLE_LNG = -72.68  // = 287.32 - 360
const TILT = (90 - MAG_POLE_LAT) * Math.PI / 180  // 9.35deg
function cgmLat(lat: number, lng: number): number {
  const phi = lat * Math.PI / 180
  const dLng = (lng - MAG_POLE_LNG) * Math.PI / 180
  const x = Math.sin(phi) * Math.cos(TILT) + Math.cos(phi) * Math.sin(TILT) * Math.cos(dLng)
  return Math.asin(Math.max(-1, Math.min(1, x))) * 180 / Math.PI
}

function projAhead(lat: number, lng: number, trackDeg: number, distNm: number): [number, number] {
  const R = 3440.065
  const d = distNm / R
  const t = trackDeg * Math.PI / 180
  const p1 = lat * Math.PI / 180, l1 = lng * Math.PI / 180
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t))
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2))
  return [(l2 * 180 / Math.PI + 540) % 360 - 180, p2 * 180 / Math.PI]
}

// Auroral oval ring at constant CGM latitude — sample around the magnetic pole.
function ovalRing(targetCgm: number, samples = 60): [number, number][] {
  const pts: [number, number][] = []
  const phiPole = MAG_POLE_LAT * Math.PI / 180
  const lamPole = MAG_POLE_LNG * Math.PI / 180
  // Co-latitude from magnetic pole = 90 - targetCgm
  const c = (90 - targetCgm) * Math.PI / 180
  for (let i = 0; i <= samples; i++) {
    const az = (i / samples) * 2 * Math.PI
    const phi = Math.asin(Math.sin(phiPole) * Math.cos(c) + Math.cos(phiPole) * Math.sin(c) * Math.cos(az))
    const lam = lamPole + Math.atan2(Math.sin(az) * Math.sin(c) * Math.cos(phiPole), Math.cos(c) - Math.sin(phiPole) * Math.sin(phi))
    pts.push([(lam * 180 / Math.PI + 540) % 360 - 180, phi * 180 / Math.PI])
  }
  return pts
}

function fmtFL(ft: number): string {
  if (ft >= 18000) return `FL${String(Math.round(ft / 100)).padStart(3, '0')}`
  return `${(ft / 1000).toFixed(0)}k`
}

// CARI-7-style dose rate uSv/h at altitude + CGM lat, modulated by SEP S-scale.
function doseRate(altFt: number, absCgm: number, S: number): number {
  const base = 0.4 * Math.pow(Math.max(0, altFt) / 10000, 1.4)
  const lf = absCgm < 20 ? 0.4 + (absCgm / 20) * 0.3
    : absCgm < 60 ? 0.7 + ((absCgm - 20) / 40) * 0.3
    : absCgm < 75 ? 1.0 + ((absCgm - 60) / 15) * 0.15
    : 1.2
  const sepMult = 1 + S * S * 0.8
  return base * lf * sepMult
}

export default function SpaceWeatherMonitor({ map, flights, onClose, onFly }: Props) {
  const [kpBase, setKpBase] = useState(3)
  const [kpForce, setKpForce] = useState(0)   // 0=AUTO, 1-9 manual G-scale
  const [sScale, setSScale] = useState(0)     // 0-5 NOAA S-scale SEP
  const [hfPen, setHfPen] = useState(100)     // %
  const [scintPen, setScintPen] = useState(100) // %
  const [minFL, setMinFL] = useState(0)
  const [showHalo, setShowHalo] = useState(true)
  const [showOval, setShowOval] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [klassFilter, setKlassFilter] = useState<Set<Klass>>(new Set(['HVY','NRW','RGN','BIZ','TBP','GA','FTR']))
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'REGIONS'>('AIRCRAFT')
  const [query, setQuery] = useState('')

  // Effective Kp: AUTO modulates around kpBase with a smooth ~30d cycle.
  const Kp = useMemo(() => {
    if (kpForce > 0) return Math.min(9, kpForce)
    const hour = Math.floor(Date.now() / 3_600_000)
    const cyc = Math.sin(2 * Math.PI * (hour % 720) / 720)
    return Math.max(0, Math.min(9, kpBase + cyc * 2.2))
  }, [kpBase, kpForce])

  type Row = {
    f: SwxFlight
    klass: Klass
    cgm: number
    absCgm: number
    hfSev: number
    scSev: number
    dose: number
    tripDose: number
    driver: 'HF' | 'GNSS' | 'DOSE' | 'NONE'
    tier: Tier
  }

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const hourLocal = new Date().getUTCHours()  // simplified — equatorial dusk window
    for (const f of flights) {
      if (f.ground) continue
      const fl = Math.round(f.altitudeFt / 100)
      if (fl < minFL) continue
      if (!Number.isFinite(f.altitudeFt) || !Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      const klass = classifyAc(f.category, f.type)
      const cgm = cgmLat(f.lat, f.lng)
      const absCgm = Math.abs(cgm)

      // HF blackout
      let hf = Math.max(0, Kp - 3) * 12
      if (absCgm > 60) hf += (absCgm - 60) * 2
      hf *= (hfPen / 100)
      hf = Math.min(100, hf)

      // GNSS scintillation
      let sc = 0
      if (absCgm >= 60 && absCgm <= 78) sc += Math.max(0, Kp - 4) * 18
      // local lng-based dusk window proxy: aircraft local hour ~ UTC + lng/15
      const localH = ((hourLocal + f.lng / 15) % 24 + 24) % 24
      if (absCgm < 20 && (localH >= 18 || localH < 2)) sc += 25 + sScale * 10
      if (absCgm > 70 && sScale >= 2) sc += sScale * 22
      sc *= (scintPen / 100)
      sc = Math.min(100, sc)

      // Dose rate
      const dose = doseRate(f.altitudeFt, absCgm, sScale)
      // Trip-dose proxy: endurance hours * dose
      const tripDose = dose * KLASS_ENDURANCE[klass]

      let tier: Tier = 'QUIET'
      if (hf >= 80 || sc >= 80 || dose >= 15) tier = 'EXTREME'
      else if (hf >= 50 || sc >= 50 || dose >= 8) tier = 'STRONG'
      else if (hf >= 20 || sc >= 20 || dose >= 5) tier = 'ELEVATED'

      // dominant driver (highest normalised severity)
      const hN = hf / 80, sN = sc / 80, dN = dose / 15
      let driver: Row['driver'] = 'NONE'
      if (tier !== 'QUIET') {
        const m = Math.max(hN, sN, dN)
        driver = m === hN ? 'HF' : m === sN ? 'GNSS' : 'DOSE'
      }

      out.push({ f, klass, cgm, absCgm, hfSev: hf, scSev: sc, dose, tripDose, driver, tier })
    }
    return out
  }, [flights, Kp, sScale, hfPen, scintPen, minFL])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { EXTREME: 0, STRONG: 0, ELEVATED: 0, QUIET: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const summary = useMemo(() => {
    const meanDose = rows.length ? rows.reduce((a, r) => a + r.dose, 0) / rows.length : 0
    const polarCount = rows.filter(r => r.absCgm > 60).length
    const worst = [...rows].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.dose - a.dose)[0]
    return { meanDose, polarCount, worst }
  }, [rows])

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows
      .filter(r => klassFilter.has(r.klass))
      .filter(r => tierFilter === 'ALL' || r.tier === tierFilter)
      .filter(r => !q || r.f.callsign?.toLowerCase().includes(q) || r.f.type?.toLowerCase().includes(q)
        || r.f.operator?.toLowerCase().includes(q) || r.f.icao.toLowerCase().includes(q))
      .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.dose - a.dose)
  }, [rows, klassFilter, tierFilter, query])

  type Region = 'POLAR' | 'AURORAL' | 'MID-LAT' | 'EQUAT'
  const regionOf = (absCgm: number): Region =>
    absCgm > 75 ? 'POLAR' : absCgm > 60 ? 'AURORAL' : absCgm > 20 ? 'MID-LAT' : 'EQUAT'

  const regionGroups = useMemo(() => {
    const m = new Map<Region, { region: Region; rows: Row[]; worst: Tier }>()
    for (const r of rows) {
      const reg = regionOf(r.absCgm)
      const ex = m.get(reg)
      if (!ex) m.set(reg, { region: reg, rows: [r], worst: r.tier })
      else { ex.rows.push(r); if (TIER_RANK[r.tier] < TIER_RANK[ex.worst]) ex.worst = r.tier }
    }
    const order: Region[] = ['POLAR', 'AURORAL', 'EQUAT', 'MID-LAT']
    return order.filter(o => m.has(o)).map(o => m.get(o)!)
      .filter(g => tierFilter === 'ALL' || g.worst === tierFilter || g.rows.some(r => r.tier === tierFilter))
      .sort((a, b) => TIER_RANK[a.worst] - TIER_RANK[b.worst] || b.rows.length - a.rows.length)
  }, [rows, tierFilter])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC_OVAL)) map.addSource(SRC_OVAL, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_OVAL)) map.addLayer({
          id: LYR_OVAL, type: 'line', source: SRC_OVAL,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.1, 'line-opacity': 0.55, 'line-dasharray': [3, 3] },
        })
        if (!map.getSource(SRC_HALO)) map.addSource(SRC_HALO, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_HALO)) map.addLayer({
          id: LYR_HALO, type: 'circle', source: SRC_HALO,
          paint: { 'circle-radius': ['get', 'r'], 'circle-color': 'transparent',
            'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-opacity': 0.85 },
        })
        if (!map.getSource(SRC_PIN)) map.addSource(SRC_PIN, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_PIN)) map.addLayer({
          id: LYR_PIN, type: 'circle', source: SRC_PIN,
          paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0f172a', 'circle-stroke-width': 1.2, 'circle-opacity': 0.9 },
        })
        if (!map.getSource(SRC_LBL)) map.addSource(SRC_LBL, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_LBL)) map.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC_LBL,
          layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, -1.4], 'text-anchor': 'bottom', 'text-allow-overlap': true },
          paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.2 },
        })
      } catch {}
    }
    ensure()

    const ovalF: any[] = []
    if (showOval) {
      for (const c of [60, 75]) {
        for (const sign of [1, -1]) {
          ovalF.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: ovalRing(sign * c) },
            properties: { color: c === 75 ? '#f59e0b' : '#94a3b8' },
          })
        }
      }
    }

    const haloF: any[] = [], pinF: any[] = [], lblF: any[] = []
    for (const r of rows) {
      if (r.tier === 'QUIET') continue
      const color = TIER_COLOR[r.tier]
      if (showHalo) {
        const sev = Math.max(r.hfSev / 80, r.scSev / 80, r.dose / 15)
        haloF.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: { color, r: Math.max(8, Math.min(22, 8 + sev * 14)) },
        })
      }
      if (showPin && r.tier === 'EXTREME' && r.driver === 'DOSE') {
        const [eLng, eLat] = projAhead(r.f.lat, r.f.lng, r.f.track, 50)
        pinF.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [eLng, eLat] },
          properties: { color: TIER_COLOR.EXTREME },
        })
      }
      if (showLbl) {
        lblF.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: { color, label: `${r.f.callsign?.trim() || r.f.icao} Kp${Kp.toFixed(0)} ${r.dose.toFixed(1)}µSv/h` },
        })
      }
    }
    try {
      ;(map.getSource(SRC_OVAL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: ovalF })
      ;(map.getSource(SRC_HALO) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: haloF })
      ;(map.getSource(SRC_PIN) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: pinF })
      ;(map.getSource(SRC_LBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lblF })
    } catch {}
  }, [map, rows, Kp, showHalo, showOval, showPin, showLbl])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_OVAL]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_OVAL]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  // ---- dose-vs-FL diagram ----
  const diag = useMemo(() => {
    const W = 380, H = 170, padL = 30, padR = 8, padT = 8, padB = 18
    const xMax = 450, yMax = 18
    const x = (v: number) => padL + (Math.min(xMax, Math.max(0, v)) / xMax) * (W - padL - padR)
    const y = (v: number) => H - padB - (Math.min(yMax, Math.max(0, v)) / yMax) * (H - padT - padB)
    return { W, H, padL, padR, padT, padB, xMax, yMax, x, y }
  }, [])

  const toggleKlass = (k: Klass) => setKlassFilter(prev => {
    const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n
  })

  // NOAA G-scale label from Kp
  const gScale = Kp >= 9 ? 'G5' : Kp >= 8 ? 'G4' : Kp >= 7 ? 'G3' : Kp >= 6 ? 'G2' : Kp >= 5 ? 'G1' : 'G0'
  const gColor = Kp >= 8 ? TIER_COLOR.EXTREME : Kp >= 6 ? TIER_COLOR.STRONG : Kp >= 5 ? TIER_COLOR.ELEVATED : TIER_COLOR.QUIET

  return (
    <div className="fixed top-16 right-3 z-40 w-[420px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">&#9733;</span>
          <span className="text-sm font-semibold tracking-wide">SPACE WEATHER IMPACT</span>
          <span className="text-[10px] text-slate-500">NOAA SWPC / ICAO Annex 3</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">&times;</button>
      </div>

      {/* tier strip */}
      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t}
            onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/40 bg-sky-500/15' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }} title={t}>
            <span className="text-[9px] tracking-wider">{t}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      {/* summary 3-cell */}
      <div className="px-3 py-2 grid grid-cols-3 gap-1 border-b border-slate-800">
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">GLOBAL Kp</span>
          <span className="text-sm font-mono" style={{ color: gColor }}>{Kp.toFixed(1)} {gScale}</span>
        </div>
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">SEP S-SCALE</span>
          <span className="text-sm font-mono" style={{ color: sScale >= 3 ? TIER_COLOR.EXTREME : sScale >= 2 ? TIER_COLOR.STRONG : sScale >= 1 ? TIER_COLOR.ELEVATED : '#cbd5e1' }}>S{sScale}</span>
        </div>
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">WORST</span>
          <span className="text-[11px] font-mono truncate" style={{ color: summary.worst ? TIER_COLOR[summary.worst.tier] : '#cbd5e1' }}>
            {summary.worst && summary.worst.tier !== 'QUIET' ? `${summary.worst.f.callsign?.trim() || summary.worst.f.icao} ${summary.worst.driver}` : '\u2014'}
          </span>
        </div>
      </div>

      {/* secondary 2-cell */}
      <div className="px-3 py-2 grid grid-cols-2 gap-1 border-b border-slate-800">
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">MEAN DOSE</span>
          <span className="text-sm font-mono" style={{ color: summary.meanDose >= 8 ? TIER_COLOR.STRONG : summary.meanDose >= 5 ? TIER_COLOR.ELEVATED : '#cbd5e1' }}>{summary.meanDose.toFixed(2)}µSv/h</span>
        </div>
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">POLAR-AC &gt;CGM60</span>
          <span className="text-sm font-mono" style={{ color: summary.polarCount > 0 && Kp >= 5 ? TIER_COLOR.STRONG : '#cbd5e1' }}>{summary.polarCount}</span>
        </div>
      </div>

      {/* dose-vs-FL diagram */}
      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider mb-1">
            <span>DOSE-RATE vs FL  (CARI-7 + SEP)</span>
            <span>x: FL   y: µSv/h</span>
          </div>
          <svg viewBox={`0 0 ${diag.W} ${diag.H}`} className="w-full bg-slate-900/50 rounded">
            {/* threshold bands */}
            <rect x={diag.padL} y={diag.y(15)} width={diag.W - diag.padL - diag.padR} height={diag.y(8) - diag.y(15)} fill="#f43f5e" opacity={0.08} />
            <rect x={diag.padL} y={diag.y(8)} width={diag.W - diag.padL - diag.padR} height={diag.y(5) - diag.y(8)} fill="#f59e0b" opacity={0.08} />
            <rect x={diag.padL} y={diag.y(5)} width={diag.W - diag.padL - diag.padR} height={diag.y(0) - diag.y(5)} fill="#0ea5e9" opacity={0.06} />
            {/* axes */}
            {[0, 100, 200, 300, 400].map(v => (
              <g key={`vx${v}`}>
                <line x1={diag.x(v)} x2={diag.x(v)} y1={diag.padT} y2={diag.H - diag.padB} stroke="#1e293b" strokeWidth={0.4} />
                <text x={diag.x(v)} y={diag.H - 4} fill="#475569" fontSize="7" textAnchor="middle">{v}</text>
              </g>
            ))}
            {[0, 5, 8, 15].map(v => (
              <g key={`vy${v}`}>
                <line x1={diag.padL} x2={diag.W - diag.padR} y1={diag.y(v)} y2={diag.y(v)}
                  stroke={v === 15 ? '#f43f5e' : v === 8 ? '#f59e0b' : v === 5 ? '#0ea5e9' : '#1e293b'}
                  strokeWidth={0.6} strokeDasharray={v === 0 ? '0' : '3 2'} opacity={v === 0 ? 1 : 0.7} />
                <text x={diag.padL - 3} y={diag.y(v) + 3} fill={v === 15 ? '#f43f5e' : v === 8 ? '#f59e0b' : v === 5 ? '#0ea5e9' : '#475569'} fontSize="7" textAnchor="end">{v}</text>
              </g>
            ))}
            {/* aircraft dots */}
            {rows.map((r, i) => (
              <circle key={i} cx={diag.x(r.f.altitudeFt / 100)} cy={diag.y(r.dose)} r={1.8}
                fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
              <span>KP-BASE</span><span className="font-mono text-slate-300">{kpBase}</span>
            </div>
            <input type="range" min={1} max={7} step={1} value={kpBase} onChange={e => setKpBase(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
              <span>KP-FORCE</span><span className="font-mono text-slate-300">{kpForce === 0 ? 'AUTO' : kpForce}</span>
            </div>
            <input type="range" min={0} max={9} step={1} value={kpForce} onChange={e => setKpForce(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
              <span>S-SCALE SEP</span><span className="font-mono text-slate-300">S{sScale}</span>
            </div>
            <input type="range" min={0} max={5} step={1} value={sScale} onChange={e => setSScale(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
              <span>MIN-FL</span><span className="font-mono text-slate-300">FL{String(minFL).padStart(3, '0')}</span>
            </div>
            <input type="range" min={0} max={400} step={10} value={minFL} onChange={e => setMinFL(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
              <span>HF-PEN</span><span className="font-mono text-slate-300">{hfPen}%</span>
            </div>
            <input type="range" min={50} max={200} step={10} value={hfPen} onChange={e => setHfPen(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
              <span>SCINT-PEN</span><span className="font-mono text-slate-300">{scintPen}%</span>
            </div>
            <input type="range" min={50} max={200} step={10} value={scintPen} onChange={e => setScintPen(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {(Object.keys(KLASS_LABEL) as Klass[]).map(k => (
            <button key={k} onClick={() => toggleKlass(k)}
              className={`text-[9px] tracking-wider px-1.5 py-0.5 rounded border ${klassFilter.has(k) ? 'border-sky-500/40 bg-sky-500/15 text-slate-100' : 'border-slate-800 bg-slate-900/40 text-slate-500'}`}>
              {k}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showOval} onChange={e => setShowOval(e.target.checked)} className="accent-sky-500" /><span>OVAL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLbl} onChange={e => setShowLbl(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/40 outline-none" />
        <div className="flex items-center gap-1">
          {(['AIRCRAFT', 'REGIONS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 text-[10px] tracking-wider px-2 py-1 rounded border ${tab === t ? 'border-sky-500/40 bg-sky-500/15 text-slate-100' : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:text-slate-200'}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <>
            {filteredRows.length === 0 && <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>}
            {filteredRows.map((r, i) => {
              const advice = r.tier === 'EXTREME'
                ? (r.driver === 'DOSE' ? 'descend below FL280 \u2014 dose rate exceeds op-spec MAS'
                  : r.driver === 'HF' ? 'divert equatorward \u2014 HF blackout, polar comms lost'
                  : 'expect GNSS unavailability \u2014 revert to IRS-only nav')
                : r.tier === 'STRONG'
                ? (r.driver === 'DOSE' ? 'consider FL descent, monitor crew dose'
                  : r.driver === 'HF' ? 'HF degraded, request SATCOM relay'
                  : 'monitor RAIM, expect ADS-B NIC drops')
                : r.tier === 'ELEVATED' ? 'monitor space-weather bulletins'
                : 'nominal space-weather environment'
              return (
                <button key={`${r.f.icao}-${i}`} onClick={() => onFly(r.f.icao)}
                  className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
                  <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-mono font-semibold truncate text-slate-100">{r.f.callsign?.trim() || r.f.icao}</span>
                      <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                      <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded border border-slate-700 text-slate-300">{r.klass}</span>
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border" style={{ color: TIER_COLOR[r.tier], borderColor: TIER_COLOR[r.tier] + '66' }}>{r.tier}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                      <span>{fmtFL(r.f.altitudeFt)}</span>
                      <span>CGM {r.cgm >= 0 ? '+' : ''}{r.cgm.toFixed(0)}\u00b0</span>
                      <span className="ml-auto" style={{ color: r.dose >= 15 ? TIER_COLOR.EXTREME : r.dose >= 8 ? TIER_COLOR.STRONG : r.dose >= 5 ? TIER_COLOR.ELEVATED : '#94a3b8' }}>{r.dose.toFixed(2)}µSv/h</span>
                    </div>
                    {/* HF bar */}
                    <div className="flex items-center gap-2 text-[10px] mt-0.5">
                      <span className="font-mono text-slate-500 w-10">HF</span>
                      <div className="flex-1 h-1.5 bg-slate-900 rounded overflow-hidden relative">
                        <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.hfSev)}%`, background: r.hfSev >= 80 ? TIER_COLOR.EXTREME : r.hfSev >= 50 ? TIER_COLOR.STRONG : r.hfSev >= 20 ? TIER_COLOR.ELEVATED : '#475569' }} />
                      </div>
                      <span className="font-mono text-slate-500 w-8 text-right">{r.hfSev.toFixed(0)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px]">
                      <span className="font-mono text-slate-500 w-10">SCINT</span>
                      <div className="flex-1 h-1.5 bg-slate-900 rounded overflow-hidden relative">
                        <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.scSev)}%`, background: r.scSev >= 80 ? TIER_COLOR.EXTREME : r.scSev >= 50 ? TIER_COLOR.STRONG : r.scSev >= 20 ? TIER_COLOR.ELEVATED : '#475569' }} />
                      </div>
                      <span className="font-mono text-slate-500 w-8 text-right">{r.scSev.toFixed(0)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px]">
                      <span className="font-mono text-slate-500 w-10">DOSE</span>
                      <div className="flex-1 h-1.5 bg-slate-900 rounded overflow-hidden relative">
                        <div className="absolute inset-y-0" style={{ left: `${(5 / 18) * 100}%`, width: 1, background: '#0ea5e9', opacity: 0.7 }} />
                        <div className="absolute inset-y-0" style={{ left: `${(8 / 18) * 100}%`, width: 1, background: '#f59e0b', opacity: 0.7 }} />
                        <div className="absolute inset-y-0" style={{ left: `${(15 / 18) * 100}%`, width: 1, background: '#f43f5e', opacity: 0.7 }} />
                        <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, (r.dose / 18) * 100)}%`, background: r.dose >= 15 ? TIER_COLOR.EXTREME : r.dose >= 8 ? TIER_COLOR.STRONG : r.dose >= 5 ? TIER_COLOR.ELEVATED : '#475569', opacity: 0.75 }} />
                      </div>
                      <span className="font-mono text-slate-500 w-8 text-right">{r.dose.toFixed(1)}</span>
                    </div>
                    <div className="text-[10px] text-slate-600 truncate mt-0.5">
                      driver <span style={{ color: r.tier !== 'QUIET' ? TIER_COLOR[r.tier] : '#64748b' }}>{r.driver}</span>
                      &middot; trip-dose {r.tripDose.toFixed(1)}µSv
                      &middot; {regionOf(r.absCgm)}
                      &middot; {r.f.operator || '\u2014'}
                    </div>
                    <div className="text-[10px] mt-0.5" style={{ color: TIER_COLOR[r.tier] }}>{advice}</div>
                  </div>
                </button>
              )
            })}
          </>
        )}
        {tab === 'REGIONS' && (
          <>
            {regionGroups.length === 0 && <div className="px-3 py-6 text-center text-xs text-slate-500">No region groups.</div>}
            {regionGroups.map(g => {
              const meanDose = g.rows.reduce((a, r) => a + r.dose, 0) / g.rows.length
              const worstRow = [...g.rows].sort((a, b) => b.dose - a.dose)[0]
              return (
                <button key={g.region} onClick={() => worstRow && onFly(worstRow.f.icao)}
                  className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
                  <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[g.worst] }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-mono font-semibold text-sky-300">{g.region}</span>
                      <span className="text-slate-500">{g.rows.length} ac</span>
                      <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded border" style={{ color: TIER_COLOR[g.worst], borderColor: TIER_COLOR[g.worst] + '66' }}>{g.worst}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                      <span>mean dose</span>
                      <span style={{ color: meanDose >= 8 ? TIER_COLOR.STRONG : meanDose >= 5 ? TIER_COLOR.ELEVATED : '#94a3b8' }}>{meanDose.toFixed(2)}µSv/h</span>
                      <span className="ml-auto">worst {worstRow ? worstRow.f.callsign?.trim() || worstRow.f.icao : '\u2014'}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] mt-0.5">
                      <div className="flex-1 h-1.5 bg-slate-900 rounded overflow-hidden relative">
                        <div className="absolute inset-y-0" style={{ left: `${(5 / 18) * 100}%`, width: 1, background: '#0ea5e9', opacity: 0.7 }} />
                        <div className="absolute inset-y-0" style={{ left: `${(8 / 18) * 100}%`, width: 1, background: '#f59e0b', opacity: 0.7 }} />
                        <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, (meanDose / 18) * 100)}%`, background: TIER_COLOR[g.worst] }} />
                      </div>
                      <span className="font-mono text-slate-500">{((meanDose / 18) * 100).toFixed(0)}%</span>
                    </div>
                    <div className="text-[10px] text-slate-600 truncate mt-0.5">
                      EXT {g.rows.filter(r => r.tier === 'EXTREME').length}
                      &middot; STR {g.rows.filter(r => r.tier === 'STRONG').length}
                      &middot; ELV {g.rows.filter(r => r.tier === 'ELEVATED').length}
                    </div>
                  </div>
                </button>
              )
            })}
          </>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 tracking-wider flex justify-between">
        <span>Kp {Kp.toFixed(1)} {gScale} &middot; S{sScale} &middot; auroral oval CGM 60/75</span>
        <span>{rows.length} AC</span>
      </div>
    </div>
  )
}
