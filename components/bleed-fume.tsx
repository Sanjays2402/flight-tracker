'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Bleed-Air Fume Event Risk Monitor (BLEED)
   -----------------------------------------------------------
   FAA SAFO 18003 Cabin Air Quality / EASA Cabin Air Quality
   Research CAQ 2017-09 / ICAO Doc 10086 Manual on Civil Aviation
   Medicine §17 cabin contaminants / RAeS Aerospace Toxic Fume
   Events position paper 2013 / ASHRAE Std 161-2018 air quality
   in commercial aircraft / Boeing FCOM 2.36 Air Conditioning /
   Airbus FCOM DSC-21 Air Bleed System / FAA AC 25-9A smoke
   penetration tests / NTSB Safety Recommendation A-14-094 oil
   seal contamination.

   Estimates per-airframe probability of a bleed-air contamination
   event (oil seal leakage, hydraulic mist, deicing fluid ingress)
   producing organophosphate aerosol (TCP, TBP) reaching cabin
   air supply. Most modern airliners route engine bleed through
   pre-coolers + ozone converters into PACK mix manifolds; failed
   labyrinth seals in IDG/N2 spool bearings emit pyrolysed Mobil
   Jet II / Eastman 2197 vapour that pilots describe as
   "wet-dog / dirty-sock" odour (FAA SAFO 18003 Table 1).

   Sources of risk (max-driver compositing 0-100):
     SEAL-AGE     Engine high-pressure compressor seal wear-cycles
                  per FNV-1a 32-bit hash of ICAO24 producing stable
                  per-airframe cycle count 0-32000 cyc vs replacement
                  interval 18000 (PW), 20000 (CFM), 22000 (Trent),
                  24000 (GE9X) scaled by SEAL-WEAR slider 50-200pct.
     ARCHITECTURE B787 / A350 use no-bleed (electric ECS) baseline 0;
                  B737NG / A320ceo single-bleed-source HIGH baseline
                  35; B777 / A330 dual-bleed pre-cooler 25; older
                  L-1011 / DC-10 trijet APU-cross-feed designs 40.
     CLIMB-DEMAND Bleed extraction peaks during high-N1 climb
                  reducing seal margin: severity = phase-mul *
                  (CLIMB 1.2 / TAKEOFF 1.4 / CRUISE 0.6 / DESCENT
                  0.4 / APPR 0.7) * 40.
     APU-CROSS    APU bleed used as supplemental on ground or
                  single-engine taxi (per FAA SAFO 18003): older
                  APUs leak via aging air-oil separator. Hash-stable
                  APU-on probability by class HVY 0.25 / NRW 0.45
                  / RGN 0.30 / BIZ 0.15 / TBP 0.10 / GA 0 / FTR 0.
     RECIRC-DEG   Cabin recirc HEPA element replacement interval
                  3500fh per Boeing AMM 21-26; hashed wear-hrs 0-7000
                  yields filter loading severity ramp.
     ICING-INGEST Anti-ice valve open + below FL150 ingests pre-melted
                  glycol-water from leading edges producing brief
                  PACK fluid odor. ICAO Annex 6 anti-ice + altKft<15
                  + |OAT|<5C trigger.

   Composite score = max(per-source sev). Dominant driver named.
   Plus computed per-aircraft predicted-pyrolysate-conc µg/m³ from
   linear superposition: 0.04 µg/m³ baseline + score * 0.18 µg/m³
   reaching ASHRAE Std 161 8h-TWA 1.0 µg/m³ TCP limit when score≥80.

   Tier classification:
     FUME-EVT score>=80  rose    smoke/fume checklist QRH ENG-7
                                 expect O2 mask donning + divert
     ELEVATED score>=55  amber   bleed-pack isolation drill prep
     WATCH    score>=25  sky     monitor cabin reports + log odour
     OK       score<25   emerald nominal air quality envelope
     IDLE     ground+lo  slate   excluded below MIN-FL & not APU-on

   MapLibre overlay:
     - Tier-coloured halo rings sized by score 8-22 px
     - Rose triangle pin 30nm-ahead at projected divert waypoint
       for FUME-EVT (suggest emergency descent / divert)
     - Tier-coloured callsign+driver+µg/m³ labels for non-OK
     - Dashed amber recirc-aged corridor pin per aircraft if
       RECIRC-DEG ≥ 50

   Side panel:
     - 5-tier counter strip click-to-filter
     - 3-cell MEAN-SCORE / WORST callsign+driver / FUME-EVT count
     - 2-cell MEAN-µg/m³ / APU-ON share secondary row
     - SVG score-vs-conc scatter sky/amber/rose threshold bands
     - 5 sliders MIN-FL / SEAL-WEAR / RECIRC-MUL / APU-MUL / ICE-MUL
     - 7-class chip filter HVY/NRW/RGN/BIZ/TBP/GA/FTR
     - HALO/PIN/LBL/CORR/DIAG toggles + search
     - AIRCRAFT/DRIVERS tab switcher
     - AIRCRAFT sorted tier-worst-first then score desc
     - DRIVERS grouped by dominant source

   Persisted: ft-bleed
   ============================================================ */

export interface BleedFlight {
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
  flights: BleedFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'FUME' | 'ELEV' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  FUME: '#f43f5e',
  ELEV: '#f59e0b',
  WATCH: '#0ea5e9',
  OK: '#10b981',
  IDLE: '#475569',
}
const TIER_ORDER: Tier[] = ['FUME', 'ELEV', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { FUME: 0, ELEV: 1, WATCH: 2, OK: 3, IDLE: 4 }
const TIER_ADVICE: Record<Tier, string> = {
  FUME: 'execute QRH SMOKE/FUMES — don O2, isolate suspect PACK, divert',
  ELEV: 'pre-brief PACK isolation drill, monitor cabin O2 reports',
  WATCH: 'log odour reports + flag MX for IDG seal inspection',
  OK: 'bleed air within ASHRAE 161 envelope',
  IDLE: 'on ground or below trigger floor',
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

// Architecture baseline (no-bleed B787/A350 = 0, modern dual = 25, single-bleed = 35, trijet legacy = 40)
const ARCH_BASE: Record<string, number> = {}
function archBase(t: string | undefined): number {
  const x = (t || '').toUpperCase()
  if (/^(B78|A35)/.test(x)) return 0          // no-bleed electric ECS
  if (/^(B77|A33|A34|B74)/.test(x)) return 25 // dual-bleed pre-cooler
  if (/^(L101|DC10|MD11|IL96)/.test(x)) return 40 // trijet legacy
  if (/^(B73|A32|A22|A19|A20|A21|BCS|CS|EMB|E1|E2|CRJ|MD8|MD9)/.test(x)) return 35
  if (/^(GLF|GLEX|G[0-9]|CL|F[0-9]|F2T|F7X|F8X|LJ|HDJ|PC|BE|TBM)/.test(x)) return 22
  return 28
}

function classify(t: string | undefined, cat?: string): Cls {
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
const PHASE_MUL: Record<Phase, number> = { TAKEOFF: 1.4, CLIMB: 1.2, CRUISE: 0.6, DESCENT: 0.4, APPR: 0.7 }

const APU_PROB: Record<Cls, number> = { HVY: 0.25, NRW: 0.45, RGN: 0.30, BIZ: 0.15, TBP: 0.10, GA: 0, FTR: 0 }

interface Row {
  f: BleedFlight
  cls: Cls
  phase: Phase
  altKft: number
  arch: number
  sealCyc: number
  sealMax: number
  sealSev: number
  archSev: number
  climbSev: number
  apuOn: boolean
  apuSev: number
  recircHrs: number
  recircSev: number
  oat: number
  iceSev: number
  driver: string
  score: number
  conc: number
  tier: Tier
}

export default function BleedFume({ map, flights, onClose, onFly }: Props) {
  const [minFL, setMinFL] = useState(30)
  const [sealWear, setSealWear] = useState(100)   // 50-200
  const [recircMul, setRecircMul] = useState(100) // 50-200
  const [apuMul, setApuMul] = useState(100)       // 50-200
  const [iceMul, setIceMul] = useState(100)       // 50-200
  const [tierFilter, setTierFilter] = useState<Set<Tier>>(new Set())
  const [clsFilter, setClsFilter] = useState<Set<Cls>>(new Set())
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showCorr, setShowCorr] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT' | 'DRIVERS'>('AIRCRAFT')

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const sealScale = sealWear / 100, recScale = recircMul / 100, apuScale = apuMul / 100, iceScale = iceMul / 100
    for (const f of flights) {
      const altKft = f.altitudeFt / 1000
      const cls = classify(f.type, f.category)
      const phase = inferPhase(f.altitudeFt, f.vertRate, f.velocityKts)
      const arch = archBase(f.type)
      // OAT via ISA lapse
      const oat = altKft < 36 ? 15 - 1.98 * altKft : -56.5
      // hash-driven stables
      const sealCyc = hashUnit(f.icao, 'seal') * 32000 * sealScale
      const sealMax = arch === 0 ? 99999 : (/(B78|A35)/.test((f.type || '').toUpperCase()) ? 30000 : /^(A33|A34)/.test((f.type || '').toUpperCase()) ? 22000 : 20000)
      const sealSev = arch === 0 ? 0 : Math.max(0, Math.min(100, ((sealCyc - sealMax * 0.6) / (sealMax * 0.4)) * 100))
      const archSev = arch
      const climbSev = arch === 0 ? 0 : PHASE_MUL[phase] * 40
      const apuOn = !f.ground && hashUnit(f.icao, 'apu') < APU_PROB[cls] * apuScale && (phase === 'TAKEOFF' || phase === 'CRUISE')
      const apuSev = apuOn ? 35 + hashUnit(f.icao, 'apuage') * 30 : 0
      const recircHrs = hashUnit(f.icao, 'rec') * 7000 * recScale
      const recircSev = Math.max(0, Math.min(100, ((recircHrs - 3500) / 3500) * 80))
      const iceOn = altKft < 15 && Math.abs(oat) < 5 && hashUnit(f.icao, 'ice') < 0.35
      const iceSev = iceOn ? 30 * iceScale : 0

      // dominant
      const parts: { name: string; sev: number }[] = [
        { name: 'SEAL', sev: sealSev },
        { name: 'ARCH', sev: archSev },
        { name: 'CLIMB', sev: climbSev },
        { name: 'APU', sev: apuSev },
        { name: 'RECIRC', sev: recircSev },
        { name: 'ICE', sev: iceSev },
      ]
      parts.sort((a, b) => b.sev - a.sev)
      const score = parts[0].sev
      const driver = parts[0].name
      const conc = 0.04 + score * 0.018  // µg/m³ predicted TCP
      // tier
      let tier: Tier
      if (f.ground || (altKft * 10 < minFL && !apuOn)) tier = 'IDLE'
      else if (score >= 80) tier = 'FUME'
      else if (score >= 55) tier = 'ELEV'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'
      out.push({ f, cls, phase, altKft, arch, sealCyc, sealMax, sealSev, archSev, climbSev, apuOn, apuSev, recircHrs, recircSev, oat, iceSev, driver, score, conc, tier })
    }
    return out
  }, [flights, minFL, sealWear, recircMul, apuMul, iceMul])

  const stats = useMemo(() => {
    const counts: Record<Tier, number> = { FUME: 0, ELEV: 0, WATCH: 0, OK: 0, IDLE: 0 }
    let sumScore = 0, n = 0, sumConc = 0, apuN = 0, apuTot = 0
    let worst: Row | null = null
    for (const r of rows) {
      counts[r.tier]++
      if (r.tier === 'IDLE') continue
      sumScore += r.score; sumConc += r.conc; n++
      apuTot++
      if (r.apuOn) apuN++
      if (!worst || r.score > worst.score) worst = r
    }
    return {
      counts,
      meanScore: n ? sumScore / n : 0,
      meanConc: n ? sumConc / n : 0,
      apuShare: apuTot ? apuN / apuTot : 0,
      apuCount: apuN,
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
    const grp: Record<string, { name: string; rows: Row[]; worstTier: Tier; meanScore: number; worstScore: number; worstCall: string }> = {}
    const names: Record<string, string> = {
      SEAL: 'Engine HP-compressor seal wear',
      ARCH: 'Bleed-air architecture baseline',
      CLIMB: 'High-N1 climb extraction',
      APU: 'APU air-oil separator aging',
      RECIRC: 'Cabin recirc HEPA loading',
      ICE: 'Anti-ice glycol ingestion',
    }
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      const k = r.driver
      if (!grp[k]) grp[k] = { name: names[k] || k, rows: [], worstTier: 'OK', meanScore: 0, worstScore: 0, worstCall: '' }
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
    const haloId = 'bleed-halo', haloSrc = 'bleed-halo-src'
    const pinId = 'bleed-pin', pinSrc = 'bleed-pin-src'
    const lblId = 'bleed-lbl', lblSrc = 'bleed-lbl-src'
    const corrId = 'bleed-corr', corrSrc = 'bleed-corr-src'

    const haloFeats: GeoJSON.Feature[] = []
    const pinFeats: GeoJSON.Feature[] = []
    const lblFeats: GeoJSON.Feature[] = []
    const corrFeats: GeoJSON.Feature[] = []

    const visTiers = tierFilter.size ? tierFilter : new Set<Tier>(['FUME', 'ELEV', 'WATCH', 'OK'])

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
        if (r.tier !== 'FUME') continue
        if (!visTiers.has(r.tier)) continue
        // project 30nm ahead along track
        const brg = (r.f.track || 0) * Math.PI / 180
        const d = 30 / 60 * Math.PI / 180  // 30nm in radians
        const φ1 = r.f.lat * Math.PI / 180, λ1 = r.f.lng * Math.PI / 180
        const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(brg))
        const λ2 = λ1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2))
        pinFeats.push({ type: 'Feature', properties: { color: TIER_COLOR.FUME, label: `DIVERT ${(r.conc).toFixed(2)}µg/m³` }, geometry: { type: 'Point', coordinates: [λ2 * 180 / Math.PI, φ2 * 180 / Math.PI] } })
      }
    }
    if (showLbl) {
      for (const r of rows) {
        if (r.tier === 'IDLE' || r.tier === 'OK') continue
        if (!visTiers.has(r.tier)) continue
        if (clsFilter.size && !clsFilter.has(r.cls)) continue
        const txt = `${r.f.callsign || r.f.icao} ${r.driver} ${r.conc.toFixed(2)}µg/m³`
        lblFeats.push({ type: 'Feature', properties: { text: txt, color: TIER_COLOR[r.tier] }, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
      }
    }
    if (showCorr) {
      for (const r of rows) {
        if (r.tier === 'IDLE') continue
        if (r.recircSev < 50) continue
        if (!visTiers.has(r.tier)) continue
        corrFeats.push({ type: 'Feature', properties: { color: '#f59e0b', label: `REC ${r.recircHrs.toFixed(0)}fh` }, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
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
    ensureSrc(corrSrc, corrFeats)

    if (!map.getLayer(haloId)) {
      map.addLayer({ id: haloId, type: 'circle', source: haloSrc, paint: { 'circle-radius': ['get', 'rr'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.85 } })
    }
    if (!map.getLayer(corrId)) {
      map.addLayer({ id: corrId, type: 'symbol', source: corrSrc, layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, 2.4], 'text-anchor': 'top' }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(pinId)) {
      map.addLayer({ id: pinId, type: 'symbol', source: pinSrc, layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, -1.4], 'text-anchor': 'bottom' }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.4 } })
    }
    if (!map.getLayer(lblId)) {
      map.addLayer({ id: lblId, type: 'symbol', source: lblSrc, layout: { 'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } })
    }

    return () => {
      for (const id of [haloId, corrId, pinId, lblId]) if (map.getLayer(id)) map.removeLayer(id)
      for (const id of [haloSrc, corrSrc, pinSrc, lblSrc]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, showHalo, showPin, showLbl, showCorr, tierFilter, clsFilter])

  // ---------- SVG diag (score vs conc) ----------
  const diagW = 360, diagH = 160
  const diag = useMemo(() => {
    const scoreMax = 100, concMax = 2.0
    const sx = (s: number) => 30 + (s / scoreMax) * (diagW - 40)
    const sy = (c: number) => (diagH - 24) - (c / concMax) * (diagH - 34)
    const dots = rows.filter(r => r.tier !== 'IDLE').map(r => ({ x: sx(r.score), y: sy(r.conc), c: TIER_COLOR[r.tier] }))
    return { dots, sx, sy, scoreMax, concMax }
  }, [rows])

  return (
    <div className="absolute inset-y-0 right-0 z-40 w-[min(96vw,460px)] bg-slate-950/95 backdrop-blur-xl border-l border-slate-800 shadow-2xl flex flex-col">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">FAA SAFO 18003 · ASHRAE 161 · RAeS</div>
          <div className="text-sm font-semibold text-slate-100">Bleed-Air Fume Event Risk</div>
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
          <div className="font-semibold" style={{ color: stats.meanScore >= 55 ? TIER_COLOR.ELEV : stats.meanScore >= 25 ? TIER_COLOR.WATCH : TIER_COLOR.OK }}>{stats.meanScore.toFixed(1)}</div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">Worst</div>
          <div className="text-slate-100 font-semibold truncate">{stats.worst ? `${stats.worst.f.callsign || stats.worst.f.icao} ${stats.worst.score.toFixed(0)} ${stats.worst.driver}` : '—'}</div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">FUME-EVT</div>
          <div className="font-semibold" style={{ color: stats.counts.FUME ? TIER_COLOR.FUME : TIER_COLOR.OK }}>{stats.counts.FUME}</div>
        </div>
      </div>
      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-2 gap-2 text-xs">
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">Mean TCP µg/m³</div>
          <div className="font-semibold" style={{ color: stats.meanConc >= 1.0 ? TIER_COLOR.FUME : stats.meanConc >= 0.5 ? TIER_COLOR.ELEV : TIER_COLOR.OK }}>{stats.meanConc.toFixed(2)}</div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-2 py-1.5">
          <div className="text-[9px] uppercase text-slate-500">APU-ON</div>
          <div className="text-sky-300 font-semibold">{stats.apuCount} <span className="text-slate-500">· {(stats.apuShare * 100).toFixed(0)}%</span></div>
        </div>
      </div>

      {/* Diag SVG */}
      {showDiag && (
        <div className="px-4 py-2 border-b border-slate-900">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Score vs Predicted TCP (µg/m³)</div>
          <svg width={diagW} height={diagH} className="block">
            <rect x={30} y={4} width={diagW - 34} height={diagH - 28} fill="#020617" stroke="#1e293b" />
            {/* threshold bands */}
            <rect x={30} y={diag.sy(2.0)} width={diagW - 34} height={diag.sy(1.0) - diag.sy(2.0)} fill="rgba(244,63,94,0.10)" />
            <rect x={30} y={diag.sy(1.0)} width={diagW - 34} height={diag.sy(0.5) - diag.sy(1.0)} fill="rgba(245,158,11,0.10)" />
            <rect x={30} y={diag.sy(0.5)} width={diagW - 34} height={diag.sy(0.0) - diag.sy(0.5)} fill="rgba(14,165,233,0.10)" />
            <line x1={30} x2={diagW - 4} y1={diag.sy(1.0)} y2={diag.sy(1.0)} stroke="#f43f5e" strokeWidth={1} strokeDasharray="3 3" />
            <line x1={30} x2={diagW - 4} y1={diag.sy(0.5)} y2={diag.sy(0.5)} stroke="#f59e0b" strokeWidth={0.8} strokeDasharray="2 3" />
            <line y1={4} y2={diagH - 24} x1={diag.sx(25)} x2={diag.sx(25)} stroke="#0ea5e9" strokeWidth={0.8} strokeDasharray="2 3" />
            <line y1={4} y2={diagH - 24} x1={diag.sx(55)} x2={diag.sx(55)} stroke="#f59e0b" strokeWidth={0.8} strokeDasharray="2 3" />
            <line y1={4} y2={diagH - 24} x1={diag.sx(80)} x2={diag.sx(80)} stroke="#f43f5e" strokeWidth={1} strokeDasharray="3 3" />
            {diag.dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={2.5} fill={d.c} fillOpacity={0.85} />)}
            {[0.5, 1.0, 1.5].map(c => <text key={c} x={2} y={diag.sy(c) + 3} fontSize={9} fill="#475569">{c}</text>)}
            {[25, 50, 75].map(s => <text key={s} y={diagH - 12} x={diag.sx(s) - 6} fontSize={9} fill="#475569">{s}</text>)}
            <text x={30} y={diagH - 2} fontSize={9} fill="#64748b">score</text>
            <text x={1} y={12} fontSize={9} fill="#64748b">µg/m³</text>
          </svg>
        </div>
      )}

      {/* Sliders */}
      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
        {([
          ['MIN-FL', minFL, 0, 400, setMinFL, 10],
          ['SEAL-WEAR %', sealWear, 50, 200, setSealWear, 5],
          ['RECIRC %', recircMul, 50, 200, setRecircMul, 5],
          ['APU-PROB %', apuMul, 50, 200, setApuMul, 5],
          ['ICE-MUL %', iceMul, 50, 200, setIceMul, 5],
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
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLbl, setShowLbl], ['CORR', showCorr, setShowCorr], ['DIAG', showDiag, setShowDiag]] as const).map(([l, v, s]) => (
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
                FL{Math.round(r.altKft * 10)} · {r.phase} · {r.driver} · <span style={{ color: r.conc >= 1.0 ? TIER_COLOR.FUME : r.conc >= 0.5 ? TIER_COLOR.ELEV : TIER_COLOR.OK }}>{r.conc.toFixed(2)}µg/m³</span>
              </div>
              <div className="mt-1 h-1.5 bg-slate-800 rounded relative overflow-hidden">
                <div className="absolute inset-y-0 left-0 rounded" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier] }} />
                <div className="absolute inset-y-0 w-px bg-sky-500/60" style={{ left: '25%' }} />
                <div className="absolute inset-y-0 w-px bg-amber-500/60" style={{ left: '55%' }} />
                <div className="absolute inset-y-0 w-px bg-rose-500/60" style={{ left: '80%' }} />
              </div>
              <div className="flex gap-1 mt-1 flex-wrap text-[9px]">
                <span className="px-1.5 py-0.5 rounded font-mono" style={{ background: TIER_COLOR[r.sealSev >= 55 ? 'ELEV' : r.sealSev >= 25 ? 'WATCH' : 'OK'] + '22', color: TIER_COLOR[r.sealSev >= 55 ? 'ELEV' : r.sealSev >= 25 ? 'WATCH' : 'OK'] }}>SEAL {r.sealSev.toFixed(0)}</span>
                <span className="px-1.5 py-0.5 rounded font-mono" style={{ background: TIER_COLOR[r.archSev >= 35 ? 'WATCH' : 'OK'] + '22', color: TIER_COLOR[r.archSev >= 35 ? 'WATCH' : 'OK'] }}>ARCH {r.archSev.toFixed(0)}</span>
                <span className="px-1.5 py-0.5 rounded font-mono bg-slate-900 border border-slate-800 text-slate-300">CLB {r.climbSev.toFixed(0)}</span>
                {r.apuOn && <span className="px-1.5 py-0.5 rounded font-mono bg-amber-500/15 border border-amber-500/30 text-amber-200">APU {r.apuSev.toFixed(0)}</span>}
                <span className="px-1.5 py-0.5 rounded font-mono" style={{ background: TIER_COLOR[r.recircSev >= 55 ? 'ELEV' : r.recircSev >= 25 ? 'WATCH' : 'OK'] + '22', color: TIER_COLOR[r.recircSev >= 55 ? 'ELEV' : r.recircSev >= 25 ? 'WATCH' : 'OK'] }}>REC {r.recircSev.toFixed(0)}</span>
                {r.iceSev > 0 && <span className="px-1.5 py-0.5 rounded font-mono bg-sky-500/15 border border-sky-500/30 text-sky-200">ICE {r.iceSev.toFixed(0)}</span>}
              </div>
              <div className="text-[10px] text-slate-500 mt-1">cyc {r.sealCyc.toFixed(0)}/{r.sealMax} · rec {r.recircHrs.toFixed(0)}fh · OAT {r.oat.toFixed(0)}°C · {r.f.operator || ''}</div>
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
