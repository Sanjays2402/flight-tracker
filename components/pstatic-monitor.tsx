'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   P-Static / Precipitation-Static Comms-Degradation Monitor
   -----------------------------------------------------------
   RTCA DO-160G §22 lightning-induced transients & §25 ESD /
   FAA AC 25.1316-1A precipitation static certification /
   DOT/FAA/CT-86/8 Aircraft Precipitation-Static Charging
   final report (Nanevicz / Tanner, SRI 1968) / Boeing AERO
   Magazine Q2-2003 P-Static & comm dropouts / Airbus FCOM
   AOM-1.34 static discharge wicks / SAE ARP 5577 static
   discharger qualification / ICAO Annex 8 Part IIIB §3.2
   bonding & grounding / FAA AC 20-136B HIRF / NASA Tech Rep
   R-1268 triboelectric charging in cirrus.

   Reconstructs per-airframe charge build-up rate and HF/VHF
   comm-link degradation probability. P-static accumulates on
   skin via triboelectric impact of ice crystals, supercooled
   droplets, frozen precipitation, blowing sand. Without
   functioning Static Discharger Assemblies (SDAs / wicks) at
   trailing-edge tips, the airframe potential reaches corona
   threshold (~50-500 kV) and arcs across antenna feedlines,
   producing audible squelch-break, ADF needle wander, GPS
   loss, VHF carrier swamping, and characteristic "St Elmo's
   fire" optical corona on windshield & wingtip.

   Sources of severity (max-driver compositing 0-100):
     CRYSTAL  Ice-crystal triboelectric current density
              I = q · v · n where q≈0.5pC/crystal, v=TAS-m/s,
              n=crystal-density per m³. Hash-stable per-airframe
              cirrus-encounter intensity above FL250 between
              tropopause -56C and crystal-onset -38C scaled by
              CRYS-MUL slider 50-200pct + lat-band weighting
              (ITCZ +0..25deg max, polar +60..90deg secondary).
     SDA-DEG  Static Discharger Assembly degradation: 4-8
              wicks/wingtip + horiz-stab tip + vert-stab tip
              + nose probe per class (HVY 28 / NRW 18 / RGN 14
              / BIZ 10 / TBP 8 / GA 4 / FTR 12). Hash-derived
              on-wing hours 0-12000h vs SAE ARP 5577 replacement
              interval 5000h with broken-wick count 0-3
              (>= 25pct degradation triggers WATCH+).
     BOND     Airframe bonding-strap impedance: FAA AC 20-136B
              <0.025Ω healthy / >0.25Ω HIRF-risk degraded.
              Hash-stable per-airframe bond resistance.
     ANT-ISO  Antenna feedline ESD isolation: dielectric
              breakdown threshold reduced by humidity moisture
              ingress (above FL150 typically dry, below FL120
              with precip = ingress probability ramps).
     PHASE    Operational phase mul: CLIMB through cirrus 1.2 /
              CRUISE 1.0 / DESCENT through wet layer 1.3 /
              APPR rain & snow 1.5 / TAKEOFF 1.4.

   Composite score = max-driver. Plus computed comm-link
   margin in dB-µV/m predicted (VHF baseline 80 dB minus
   corona-noise = 0.6 · score dB).

   Tier classification:
     COMM-LOSS score>=80  rose     squelch break + ADF wander
                                   switch to backup HF/SATCOM
     DEGRADE  score>=55  amber    expect crackle & dropouts
                                   ensure SDA functional pre-flight
     WATCH    score>=25  sky      log occurrence + MX wick check
     OK       score<25   emerald  comms within spec envelope
     IDLE     ground/lo  slate    excluded below MIN-FL

   MapLibre overlay:
     - Tier-coloured halo rings sized by score 8-22 px
     - Amber dashed ITCZ +/-25deg and polar +/-60 corona-prone
       band markers sampled every 8deg lon
     - Rose triangle pin for COMM-LOSS at current pos with
       "SATCOM HF" label
     - Tier-coloured callsign+driver+dB labels for non-OK

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-SCORE / WORST callsign+driver / COMM-LOSS-count
     - 2-cell MEAN-COMM-MARGIN / SDA-DEG-share secondary
     - SVG score-vs-comm-margin scatter with threshold bands
     - 5 sliders MIN-FL / CRYS-MUL / SDA-AGE / BOND-MUL / PHASE-MUL
     - 7-class chip filter
     - HALO/PIN/LBL/ITCZ/DIAG toggles + search
     - AIRCRAFT/DRIVERS tab switcher

   Persisted: ft-pstatic
   ============================================================ */

export interface PStaticFlight {
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
  flights: PStaticFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'LOSS' | 'DEGR' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  LOSS: '#f43f5e',
  DEGR: '#f59e0b',
  WATCH: '#0ea5e9',
  OK: '#10b981',
  IDLE: '#475569',
}
const TIER_ORDER: Tier[] = ['LOSS', 'DEGR', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { LOSS: 0, DEGR: 1, WATCH: 2, OK: 3, IDLE: 4 }
const TIER_ADVICE: Record<Tier, string> = {
  LOSS: 'expect VHF squelch-break & ADF wander — switch to SATCOM / HF backup, descend below FL250',
  DEGR: 'cabin crew brief St Elmo corona possible — verify SDA wicks on next walk-around',
  WATCH: 'log occurrence on QAR — MX inspect trailing-edge wicks at turn',
  OK: 'comm-link within DO-160G envelope — wicks bleeding charge nominally',
  IDLE: 'on ground or below P-static envelope floor',
}

type Cls = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const CLS_NAME: Record<Cls, string> = {
  HVY: 'Heavy widebody',
  NRW: 'Narrowbody',
  RGN: 'Regional jet',
  BIZ: 'Business jet',
  TBP: 'Turboprop',
  GA: 'General aviation',
  FTR: 'Military / fighter',
}
const CLS_ORDER: Cls[] = ['HVY', 'NRW', 'RGN', 'BIZ', 'TBP', 'GA', 'FTR']
// Static Discharger Assembly count per class (SAE ARP 5577)
const SDA_COUNT: Record<Cls, number> = { HVY: 28, NRW: 18, RGN: 14, BIZ: 10, TBP: 8, GA: 4, FTR: 12 }

function classify(t: string | undefined): Cls {
  const x = (t || '').toUpperCase()
  if (/^(A38|B74|B77|B78|A33|A34|A35|MD11|IL96|DC10|L101)/.test(x)) return 'HVY'
  if (/^(B73|B75|B76|B72|A22|A31|A32|A19|A20|A21|BCS|CS|MD8|MD9)/.test(x)) return 'NRW'
  if (/^(CRJ|EMB|E14|E15|E17|E19|E29|AT4|AT5|AT7|DH8|Q40|SF34|J32|J41|ATR)/.test(x)) return 'RGN'
  if (/^(GLF|GLEX|G[0-9]|CL[0-9]|C25|C56|C68|C75|E50|E55|F2T|F7X|F8X|F900|HDJ|LJ|PC24|BE40)/.test(x)) return 'BIZ'
  if (/^(AT|DH8|SAAB|TBM|PC12|BE9|BE3|BE2|KING|C90|C20)/.test(x)) return 'TBP'
  if (/^(F1[58]|F22|F35|EF20|MIRA|RAFA|GRIP|SU2|SU3|MIG|TORN|F4|F[0-9])/.test(x)) return 'FTR'
  return 'GA'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
function hashUnit(s: string, salt: string): number { return (hash32(s + ':' + salt) >>> 8) / 0xffffff }

type Phase = 'TAKEOFF' | 'CLIMB' | 'CRUISE' | 'DESCENT' | 'APPR'
function inferPhase(altFt: number, vsFpm: number, gs: number): Phase {
  if (altFt < 1500 && gs > 60) return 'TAKEOFF'
  if (altFt < 8000 && vsFpm < -200 && gs < 250) return 'APPR'
  if (vsFpm > 600) return 'CLIMB'
  if (vsFpm < -400) return 'DESCENT'
  return 'CRUISE'
}
const PHASE_MUL: Record<Phase, number> = { TAKEOFF: 1.4, CLIMB: 1.2, CRUISE: 1.0, DESCENT: 1.3, APPR: 1.5 }

interface Row {
  f: PStaticFlight
  cls: Cls
  phase: Phase
  altKft: number
  oat: number
  crystalDens: number    // crystals/m³ proxy
  crystalSev: number
  sdaOnWingH: number
  sdaBroken: number      // 0-3
  sdaSev: number
  bondMΩ: number         // milli-ohms
  bondSev: number
  antIsoSev: number
  phaseSev: number
  driver: string
  score: number
  commMargin: number     // dB-µV/m predicted, 80 baseline minus corona noise
  inItcz: boolean
  inPolar: boolean
  driverLong: string
  tier: Tier
}

const DRIVER_LONG: Record<string, string> = {
  CRYSTAL: 'Ice-crystal triboelectric charging',
  SDA: 'Static Discharger Assembly degraded',
  BOND: 'Airframe bonding strap impedance',
  ANTISO: 'Antenna feedline ESD isolation',
  PHASE: 'Operational-phase exposure',
}

export default function PStaticMonitor({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState(80)
  const [crysMul, setCrysMul] = useState(100)    // 50-200
  const [sdaAge, setSdaAge] = useState(100)      // 50-200
  const [bondMul, setBondMul] = useState(100)    // 50-200
  const [phaseMul, setPhaseMul] = useState(100)  // 50-200
  const [tierFilter, setTierFilter] = useState<Set<Tier>>(new Set())
  const [clsFilter, setClsFilter] = useState<Set<Cls>>(new Set())
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showItcz, setShowItcz] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT' | 'DRIVERS'>('AIRCRAFT')

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const cScale = crysMul / 100, sScale = sdaAge / 100, bScale = bondMul / 100, pScale = phaseMul / 100
    for (const f of flights) {
      const altKft = f.altitudeFt / 1000
      const cls = classify(f.type)
      const phase = inferPhase(f.altitudeFt, f.vertRate, f.velocityKts)
      const oat = altKft < 36 ? 15 - 1.98 * altKft : -56.5
      const inItcz = Math.abs(f.lat) <= 25
      const inPolar = Math.abs(f.lat) >= 60

      // CRYSTAL: cirrus zone above FL250, ice-crystal regime -38C..-56C
      const crystalZone = altKft >= 25 && oat <= -38
      const baseDens = crystalZone ? (5e4 + hashUnit(f.icao, 'crys') * 5e5) : (altKft >= 15 ? hashUnit(f.icao, 'crys') * 2e4 : 0)
      const latBoost = inItcz ? 1.6 : inPolar ? 1.25 : 1.0
      const crystalDens = baseDens * latBoost * cScale
      // I = q·v·n approx → severity ramp; saturate at ~1µA/m²
      const tasMs = f.velocityKts * 0.5144
      const current_pA_per_m2 = 0.5 * tasMs * crystalDens * 1e-12 * 1e12 // pC * m/s * (1/m³) → pA/m²
      const crystalSev = Math.max(0, Math.min(100, current_pA_per_m2 / 8))

      // SDA: hashed on-wing hrs vs ARP5577 5000h life, broken wick count 0..3
      const sdaOnWingH = hashUnit(f.icao, 'sda') * 12000 * sScale
      const sdaBroken = Math.floor(hashUnit(f.icao, 'wick') * 4)
      const lifeFrac = sdaOnWingH / 5000
      const brokenFrac = sdaBroken / Math.max(4, SDA_COUNT[cls] / 4)
      const sdaSev = Math.max(0, Math.min(100, (Math.max(0, lifeFrac - 0.6) * 80) + brokenFrac * 80))

      // BOND: per-airframe stable mΩ, FAA AC 20-136B <25mΩ healthy
      const bondMΩ = (10 + hashUnit(f.icao, 'bond') * 350) * bScale
      const bondSev = Math.max(0, Math.min(100, (bondMΩ - 25) / 2.5))

      // ANT-ISO: humidity ingress below FL120 with precip proxy
      const wetLayer = altKft < 12 && hashUnit(f.icao, 'wet') < 0.4
      const antIsoSev = wetLayer ? 30 + hashUnit(f.icao, 'iso') * 35 : 0

      // PHASE
      const phaseSev = PHASE_MUL[phase] * 30 * pScale

      const parts: { name: string; sev: number }[] = [
        { name: 'CRYSTAL', sev: crystalSev },
        { name: 'SDA', sev: sdaSev },
        { name: 'BOND', sev: bondSev },
        { name: 'ANTISO', sev: antIsoSev },
        { name: 'PHASE', sev: phaseSev },
      ]
      parts.sort((a, b) => b.sev - a.sev)
      const score = parts[0].sev
      const driver = parts[0].name
      const driverLong = DRIVER_LONG[driver] || driver
      const commMargin = Math.max(0, 80 - score * 0.6)

      let tier: Tier
      if (f.ground || altKft * 10 < minFL) tier = 'IDLE'
      else if (score >= 80) tier = 'LOSS'
      else if (score >= 55) tier = 'DEGR'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, cls, phase, altKft, oat, crystalDens, crystalSev, sdaOnWingH, sdaBroken, sdaSev,
        bondMΩ, bondSev, antIsoSev, phaseSev, driver, driverLong, score, commMargin,
        inItcz, inPolar, tier,
      })
    }
    return out
  }, [flights, minFL, crysMul, sdaAge, bondMul, phaseMul])

  const stats = useMemo(() => {
    const counts: Record<Tier, number> = { LOSS: 0, DEGR: 0, WATCH: 0, OK: 0, IDLE: 0 }
    let sumScore = 0, n = 0, sumMargin = 0, sdaDegN = 0, totN = 0
    let worst: Row | null = null
    for (const r of rows) {
      counts[r.tier]++
      if (r.tier === 'IDLE') continue
      sumScore += r.score; sumMargin += r.commMargin; n++
      totN++
      if (r.sdaSev >= 40) sdaDegN++
      if (!worst || r.score > worst.score) worst = r
    }
    return {
      counts,
      meanScore: n ? sumScore / n : 0,
      meanMargin: n ? sumMargin / n : 0,
      sdaShare: totN ? sdaDegN / totN : 0,
      sdaDegN,
      worst,
    }
  }, [rows])

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter.size && !tierFilter.has(r.tier)) return false
      if (clsFilter.size && !clsFilter.has(r.cls)) return false
      if (q) {
        const blob = `${r.f.callsign || ''} ${r.f.type || ''} ${r.f.operator || ''}`.toUpperCase()
        if (!blob.includes(q)) return false
      }
      return true
    }).sort((a, b) => {
      const r = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (r) return r
      return b.score - a.score
    })
  }, [rows, tierFilter, clsFilter, search])

  const drivers = useMemo(() => {
    const grp: Record<string, { name: string; rows: Row[] }> = {}
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      const k = r.driver
      if (!grp[k]) grp[k] = { name: DRIVER_LONG[k] || k, rows: [] }
      grp[k].rows.push(r)
    }
    return Object.entries(grp).map(([k, v]) => {
      let worst: Tier = 'OK', ws = 0, wc = '', sum = 0
      for (const r of v.rows) {
        if (TIER_RANK[r.tier] < TIER_RANK[worst]) worst = r.tier
        if (r.score > ws) { ws = r.score; wc = r.f.callsign || r.f.icao }
        sum += r.score
      }
      return { key: k, name: v.name, rows: v.rows, worstTier: worst, meanScore: sum / v.rows.length, worstScore: ws, worstCall: wc }
    }).sort((a, b) => {
      const r = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
      if (r) return r
      return b.rows.length - a.rows.length
    })
  }, [rows])

  // ---------- MapLibre overlay ----------
  useEffect(() => {
    if (!map) return
    const haloId = 'pstatic-halo', haloSrc = 'pstatic-halo-src'
    const pinId = 'pstatic-pin', pinSrc = 'pstatic-pin-src'
    const lblId = 'pstatic-lbl', lblSrc = 'pstatic-lbl-src'
    const bandId = 'pstatic-band', bandSrc = 'pstatic-band-src'

    const haloFeats: GeoJSON.Feature[] = []
    const pinFeats: GeoJSON.Feature[] = []
    const lblFeats: GeoJSON.Feature[] = []
    const bandFeats: GeoJSON.Feature[] = []

    const visTiers = tierFilter.size ? tierFilter : new Set<Tier>(['LOSS', 'DEGR', 'WATCH', 'OK'])

    if (showHalo) {
      for (const r of rows) {
        if (r.tier === 'IDLE' || r.tier === 'OK') continue
        if (!visTiers.has(r.tier)) continue
        if (clsFilter.size && !clsFilter.has(r.cls)) continue
        const sev = Math.max(8, Math.min(22, 8 + r.score * 0.18))
        haloFeats.push({ type: 'Feature', properties: { color: TIER_COLOR[r.tier], rr: sev }, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
      }
    }
    if (showPin) {
      for (const r of rows) {
        if (r.tier !== 'LOSS') continue
        if (!visTiers.has(r.tier)) continue
        pinFeats.push({ type: 'Feature', properties: { color: TIER_COLOR.LOSS, label: `SATCOM HF ${r.commMargin.toFixed(0)}dB` }, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
      }
    }
    if (showLbl) {
      for (const r of rows) {
        if (r.tier === 'IDLE' || r.tier === 'OK') continue
        if (!visTiers.has(r.tier)) continue
        if (clsFilter.size && !clsFilter.has(r.cls)) continue
        const txt = `${r.f.callsign || r.f.icao} ${r.driver} ${r.commMargin.toFixed(0)}dB`
        lblFeats.push({ type: 'Feature', properties: { text: txt, color: TIER_COLOR[r.tier] }, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
      }
    }
    if (showItcz) {
      // dashed ITCZ band markers at +/-25 every 8deg lon, polar band +/-60 secondary
      for (let lon = -180; lon <= 180; lon += 8) {
        for (const lat of [25, -25]) {
          bandFeats.push({ type: 'Feature', properties: { color: '#f59e0b', label: lon % 40 === 0 ? `ITCZ ${lat}°` : '' }, geometry: { type: 'Point', coordinates: [lon, lat] } })
        }
      }
      for (let lon = -180; lon <= 180; lon += 12) {
        for (const lat of [60, -60]) {
          bandFeats.push({ type: 'Feature', properties: { color: '#0ea5e9', label: lon % 60 === 0 ? `POLAR ${lat}°` : '' }, geometry: { type: 'Point', coordinates: [lon, lat] } })
        }
      }
    }

    const ensureSrc = (id: string, feats: GeoJSON.Feature[]) => {
      const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: feats }
      const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined
      if (src) src.setData(fc as never); else map.addSource(id, { type: 'geojson', data: fc as never })
    }
    ensureSrc(haloSrc, haloFeats)
    ensureSrc(pinSrc, pinFeats)
    ensureSrc(lblSrc, lblFeats)
    ensureSrc(bandSrc, bandFeats)

    if (!map.getLayer(haloId)) {
      map.addLayer({ id: haloId, type: 'circle', source: haloSrc, paint: { 'circle-radius': ['get', 'rr'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.85 } })
    }
    if (!map.getLayer(bandId)) {
      map.addLayer({ id: bandId, type: 'symbol', source: bandSrc, layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, 0], 'text-anchor': 'center' }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.0, 'text-opacity': 0.55 } })
      // also a circle to mark band points
      map.addLayer({ id: bandId + '-dot', type: 'circle', source: bandSrc, paint: { 'circle-radius': 1.4, 'circle-color': ['get', 'color'], 'circle-opacity': 0.45 } })
    }
    if (!map.getLayer(pinId)) {
      map.addLayer({ id: pinId, type: 'symbol', source: pinSrc, layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, -1.6], 'text-anchor': 'bottom' }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.4 } })
    }
    if (!map.getLayer(lblId)) {
      map.addLayer({ id: lblId, type: 'symbol', source: lblSrc, layout: { 'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } })
    }

    return () => {
      for (const id of [haloId, bandId + '-dot', bandId, pinId, lblId]) if (map.getLayer(id)) map.removeLayer(id)
      for (const id of [haloSrc, bandSrc, pinSrc, lblSrc]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, showHalo, showPin, showLbl, showItcz, tierFilter, clsFilter])

  // ---------- SVG diag (score vs comm-margin) ----------
  const diagW = 360, diagH = 160
  const diag = useMemo(() => {
    const scoreMax = 100, mMax = 80
    const sx = (s: number) => 30 + (s / scoreMax) * (diagW - 40)
    const sy = (m: number) => (diagH - 24) - (m / mMax) * (diagH - 34)
    const dots = rows.filter(r => r.tier !== 'IDLE').map(r => ({ x: sx(r.score), y: sy(r.commMargin), c: TIER_COLOR[r.tier] }))
    return { dots, sx, sy, scoreMax, mMax }
  }, [rows])

  return (
    <div className="absolute inset-y-0 right-0 z-40 w-[min(96vw,460px)] bg-slate-950/95 backdrop-blur-xl border-l border-slate-800 shadow-2xl flex flex-col">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">RTCA DO-160G · FAA AC 25.1316-1A · SAE ARP 5577</div>
          <div className="text-sm font-semibold text-slate-100">P-Static / Comm-Link Degradation</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* Tier strip */}
      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-5 gap-1.5">
        {TIER_ORDER.map(t => {
          const on = tierFilter.has(t)
          return (
            <button key={t} onClick={() => setTierFilter(s => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n })}
              className={`px-2 py-1 rounded-lg text-[10px] font-semibold tracking-wider border transition ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/60 border-slate-800 text-slate-300 hover:border-slate-700'}`}>
              <span className="block leading-tight" style={{ color: TIER_COLOR[t] }}>{stats.counts[t]}</span>
              <span className="block text-[9px] text-slate-400">{t}</span>
            </button>
          )
        })}
      </div>

      {/* Summary cells */}
      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-3 gap-2 text-xs">
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">Mean Score</div>
          <div className="font-semibold" style={{ color: stats.meanScore >= 55 ? TIER_COLOR.DEGR : stats.meanScore >= 25 ? TIER_COLOR.WATCH : TIER_COLOR.OK }}>{stats.meanScore.toFixed(1)}</div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">Worst</div>
          <div className="text-slate-100 font-semibold truncate">{stats.worst ? `${stats.worst.f.callsign || stats.worst.f.icao} ${stats.worst.score.toFixed(0)} ${stats.worst.driver}` : '—'}</div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">COMM-LOSS</div>
          <div className="font-semibold" style={{ color: stats.counts.LOSS ? TIER_COLOR.LOSS : TIER_COLOR.OK }}>{stats.counts.LOSS}</div>
        </div>
      </div>
      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-2 gap-2 text-xs">
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">Mean VHF margin dB</div>
          <div className="font-semibold" style={{ color: stats.meanMargin < 30 ? TIER_COLOR.LOSS : stats.meanMargin < 50 ? TIER_COLOR.DEGR : TIER_COLOR.OK }}>{stats.meanMargin.toFixed(0)}</div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">SDA-DEG</div>
          <div className="text-sky-300 font-semibold">{stats.sdaDegN} <span className="text-slate-500">· {(stats.sdaShare * 100).toFixed(0)}%</span></div>
        </div>
      </div>

      {/* Diag SVG */}
      {showDiag && (
        <div className="px-4 py-2 border-b border-slate-900">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Score vs VHF comm-margin (dB-µV/m)</div>
          <svg width={diagW} height={diagH} className="block">
            <rect x={30} y={4} width={diagW - 34} height={diagH - 28} fill="#020617" stroke="#1e293b" />
            {/* threshold bands (margin shrinks as score rises) */}
            <rect x={30} y={4} width={diagW - 34} height={diag.sy(50) - 4} fill="rgba(16,185,129,0.10)" />
            <rect x={30} y={diag.sy(50)} width={diagW - 34} height={diag.sy(30) - diag.sy(50)} fill="rgba(14,165,233,0.10)" />
            <rect x={30} y={diag.sy(30)} width={diagW - 34} height={diag.sy(15) - diag.sy(30)} fill="rgba(245,158,11,0.10)" />
            <rect x={30} y={diag.sy(15)} width={diagW - 34} height={diagH - 24 - diag.sy(15)} fill="rgba(244,63,94,0.10)" />
            <line x1={30} x2={diagW - 4} y1={diag.sy(15)} y2={diag.sy(15)} stroke="#f43f5e" strokeWidth={1} strokeDasharray="3 3" />
            <line x1={30} x2={diagW - 4} y1={diag.sy(30)} y2={diag.sy(30)} stroke="#f59e0b" strokeWidth={0.8} strokeDasharray="2 3" />
            <line x1={30} x2={diagW - 4} y1={diag.sy(50)} y2={diag.sy(50)} stroke="#0ea5e9" strokeWidth={0.8} strokeDasharray="2 3" />
            <line y1={4} y2={diagH - 24} x1={diag.sx(25)} x2={diag.sx(25)} stroke="#0ea5e9" strokeWidth={0.8} strokeDasharray="2 3" />
            <line y1={4} y2={diagH - 24} x1={diag.sx(55)} x2={diag.sx(55)} stroke="#f59e0b" strokeWidth={0.8} strokeDasharray="2 3" />
            <line y1={4} y2={diagH - 24} x1={diag.sx(80)} x2={diag.sx(80)} stroke="#f43f5e" strokeWidth={1} strokeDasharray="3 3" />
            {diag.dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={2.5} fill={d.c} fillOpacity={0.85} />)}
            {[20, 40, 60].map(c => <text key={c} x={2} y={diag.sy(c) + 3} fontSize={9} fill="#475569">{c}</text>)}
            {[25, 50, 75].map(s => <text key={s} y={diagH - 12} x={diag.sx(s) - 6} fontSize={9} fill="#475569">{s}</text>)}
            <text x={30} y={diagH - 2} fontSize={9} fill="#64748b">score</text>
            <text x={1} y={12} fontSize={9} fill="#64748b">dB</text>
          </svg>
        </div>
      )}

      {/* Sliders */}
      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
        {([
          ['MIN-FL', minFL, 0, 400, setMinFL, 10],
          ['CRYS-MUL %', crysMul, 50, 200, setCrysMul, 5],
          ['SDA-AGE %', sdaAge, 50, 200, setSdaAge, 5],
          ['BOND-MUL %', bondMul, 50, 200, setBondMul, 5],
          ['PHASE-MUL %', phaseMul, 50, 200, setPhaseMul, 5],
        ] as const).map(([l, v, mn, mx, set, st]) => (
          <label key={l as string} className="block">
            <div className="flex justify-between"><span className="text-slate-500">{l}</span><span className="text-slate-300">{v}</span></div>
            <input type="range" min={mn as number} max={mx as number} step={st as number} value={v as number} onChange={e => (set as (n: number) => void)(parseFloat(e.target.value))} className="w-full accent-sky-500" />
          </label>
        ))}
      </div>

      {/* Class chips */}
      <div className="px-4 py-2 border-b border-slate-900 flex gap-1 flex-wrap">
        {CLS_ORDER.map(c => {
          const on = clsFilter.has(c)
          return <button key={c} onClick={() => setClsFilter(s => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n })}
            title={CLS_NAME[c]}
            className={`px-2 py-0.5 rounded text-[10px] font-mono border ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:border-slate-700'}`}>{c}</button>
        })}
      </div>

      {/* Toggles + search */}
      <div className="px-4 py-2 border-b border-slate-900 flex flex-wrap gap-1.5 items-center text-[10px]">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLbl, setShowLbl], ['ITCZ', showItcz, setShowItcz], ['DIAG', showDiag, setShowDiag]] as const).map(([l, v, s]) => (
          <button key={l} onClick={() => (s as (b: boolean) => void)(!v)}
            className={`px-2 py-0.5 rounded border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'bg-slate-900/60 border-slate-800 text-slate-400'}`}>{l}</button>
        ))}
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search" className="ml-auto bg-slate-900/60 border border-slate-800 rounded px-1.5 py-0.5 text-[10px] text-slate-200 w-24 placeholder:text-slate-600" />
      </div>
      <div className="px-4 pt-2 grid grid-cols-2 gap-1">
        {(['AIRCRAFT', 'DRIVERS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`text-[10px] tracking-widest py-1 rounded ${tab === t ? 'bg-sky-500/15 text-sky-100 border border-sky-500/40' : 'bg-slate-900/40 text-slate-400 border border-slate-800'}`}>{t}</button>
        ))}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.map(r => (
          <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
            className="w-full text-left bg-slate-900/40 border border-slate-800 hover:border-slate-700 rounded-lg p-2 flex gap-2">
            <div className="w-1 rounded-full shrink-0" style={{ background: TIER_COLOR[r.tier] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="font-mono text-slate-100 truncate">{r.f.callsign || r.f.icao}</span>
                <span className="text-slate-500">{r.f.type || '—'}</span>
                <span className="ml-auto px-1.5 py-0.5 rounded text-[9px] font-mono border border-slate-800 text-slate-300">{r.cls}</span>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono" style={{ background: TIER_COLOR[r.tier] + '22', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                FL{Math.round(r.altKft * 10)} · {r.phase} · OAT <span style={{ color: r.oat <= -38 ? TIER_COLOR.WATCH : 'inherit' }}>{r.oat.toFixed(0)}°C</span> · {r.driver} · <span style={{ color: r.commMargin < 15 ? TIER_COLOR.LOSS : r.commMargin < 30 ? TIER_COLOR.DEGR : TIER_COLOR.OK }}>{r.commMargin.toFixed(0)}dB</span>
              </div>
              <div className="mt-1 h-1.5 bg-slate-800 rounded relative overflow-hidden">
                <div className="absolute inset-y-0 left-0 rounded" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier] }} />
                <div className="absolute inset-y-0 w-px bg-sky-500/60" style={{ left: '25%' }} />
                <div className="absolute inset-y-0 w-px bg-amber-500/60" style={{ left: '55%' }} />
                <div className="absolute inset-y-0 w-px bg-rose-500/60" style={{ left: '80%' }} />
              </div>
              <div className="flex gap-1 mt-1 flex-wrap text-[9px]">
                <span className="px-1.5 py-0.5 rounded font-mono" style={{ background: TIER_COLOR[r.crystalSev >= 55 ? 'DEGR' : r.crystalSev >= 25 ? 'WATCH' : 'OK'] + '22', color: TIER_COLOR[r.crystalSev >= 55 ? 'DEGR' : r.crystalSev >= 25 ? 'WATCH' : 'OK'] }}>CRY {r.crystalSev.toFixed(0)}</span>
                <span className="px-1.5 py-0.5 rounded font-mono" style={{ background: TIER_COLOR[r.sdaSev >= 55 ? 'DEGR' : r.sdaSev >= 25 ? 'WATCH' : 'OK'] + '22', color: TIER_COLOR[r.sdaSev >= 55 ? 'DEGR' : r.sdaSev >= 25 ? 'WATCH' : 'OK'] }}>SDA {r.sdaSev.toFixed(0)}</span>
                <span className="px-1.5 py-0.5 rounded font-mono" style={{ background: TIER_COLOR[r.bondSev >= 55 ? 'DEGR' : r.bondSev >= 25 ? 'WATCH' : 'OK'] + '22', color: TIER_COLOR[r.bondSev >= 55 ? 'DEGR' : r.bondSev >= 25 ? 'WATCH' : 'OK'] }}>BND {r.bondSev.toFixed(0)}</span>
                {r.antIsoSev > 0 && <span className="px-1.5 py-0.5 rounded font-mono bg-amber-500/15 border border-amber-500/30 text-amber-200">ISO {r.antIsoSev.toFixed(0)}</span>}
                <span className="px-1.5 py-0.5 rounded font-mono bg-slate-900 border border-slate-800 text-slate-300">PHS {r.phaseSev.toFixed(0)}</span>
                {r.inItcz && <span className="px-1.5 py-0.5 rounded font-mono bg-amber-500/15 border border-amber-500/30 text-amber-200">ITCZ</span>}
                {r.inPolar && <span className="px-1.5 py-0.5 rounded font-mono bg-sky-500/15 border border-sky-500/30 text-sky-200">POLAR</span>}
              </div>
              <div className="text-[10px] text-slate-500 mt-1">SDA {SDA_COUNT[r.cls] - r.sdaBroken}/{SDA_COUNT[r.cls]} · on-wing {r.sdaOnWingH.toFixed(0)}h · bond {r.bondMΩ.toFixed(0)}mΩ · {r.f.operator || ''}</div>
              <div className="text-[10px] mt-1" style={{ color: TIER_COLOR[r.tier] }}>{TIER_ADVICE[r.tier]}</div>
            </div>
          </button>
        ))}
        {tab === 'DRIVERS' && drivers.map(d => (
          <button key={d.key} onClick={() => {
            const r = d.rows.find(x => (x.f.callsign || x.f.icao) === d.worstCall) || d.rows[0]
            if (r) onFly(r.f.icao)
          }} className="w-full text-left bg-slate-900/40 border border-slate-800 hover:border-slate-700 rounded-lg p-2 flex gap-2">
            <div className="w-1 rounded-full shrink-0" style={{ background: TIER_COLOR[d.worstTier] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-900 border border-slate-800 text-slate-200">{d.key}</span>
                <span className="text-slate-300 truncate">{d.name}</span>
                <span className="ml-auto text-slate-400 text-[10px]">{d.rows.length} ac</span>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono" style={{ background: TIER_COLOR[d.worstTier] + '22', color: TIER_COLOR[d.worstTier] }}>{d.worstTier}</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">mean {d.meanScore.toFixed(1)} · worst {d.worstScore.toFixed(0)} · {d.worstCall}</div>
              <div className="mt-1 h-1.5 bg-slate-800 rounded relative overflow-hidden">
                <div className="absolute inset-y-0 left-0 rounded" style={{ width: `${Math.min(100, d.meanScore)}%`, background: TIER_COLOR[d.worstTier] }} />
                <div className="absolute inset-y-0 w-px bg-sky-500/60" style={{ left: '25%' }} />
                <div className="absolute inset-y-0 w-px bg-amber-500/60" style={{ left: '55%' }} />
                <div className="absolute inset-y-0 w-px bg-rose-500/60" style={{ left: '80%' }} />
              </div>
            </div>
          </button>
        ))}
        {((tab === 'AIRCRAFT' && !filtered.length) || (tab === 'DRIVERS' && !drivers.length)) && (
          <div className="text-center text-[11px] text-slate-500 py-6">No aircraft above trigger floor.</div>
        )}
      </div>
    </div>
  )
}
