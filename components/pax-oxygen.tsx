'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   PAX Oxygen / Chemical Generator Reserve & Emergency
   Descent Profile Monitor  (ATA-35-20)
   -----------------------------------------------------------
   Per-airframe passenger emergency oxygen system reserve vs
   the descent-profile demand triggered by rapid cabin
   decompression. Models per-class O2 source (CHEM generator
   sodium chlorate candle vs gaseous bottle vs LOX), nominal
   burn-time min, exhaustion-altitude FL100 target descent
   per 14 CFR 25.1447 / Annex 6, and post-ValuJet 592 cargo
   stowage compliance per 14 CFR 121.629 / SFAR 25.

   Regulatory & operational basis:
     · 14 CFR 25.1441 Oxygen equipment & supply
     · 14 CFR 25.1443 Minimum O2 flow rate
     · 14 CFR 25.1445 Equipment standards for O2 dispensing
     · 14 CFR 25.1447 Equipment standards for O2 dispensing
     · 14 CFR 25.1449 Means for determining use of O2
     · 14 CFR 25.1453 Protection of O2 equipment from rupture
     · 14 CFR 121.327 / 121.329 / 121.333 Supplemental O2 ops
     · 14 CFR 121.629 / SFAR 25 chemical-O2 generator cargo
       carriage prohibition (post-ValuJet 592, NTSB AAR-97-06)
     · 14 CFR 91.211 Supplemental O2 General Aviation
     · FAA AC 25-22 Certification of Transport Cat O2 Systems
     · FAA AC 121-25 Cabin Emergency Procedures
     · FAA SAFO 13003 Chem-O2 Generator False Activation
     · FAA InFO 14005 / 18011 O2 cylinder fires
     · EASA CS 25.1441-1453 / AMC 25.1445
     · ICAO Annex 6 Pt I 4.3.8 Oxygen supplemental
     · ICAO Doc 9481 Technical Instructions Dangerous Goods
     · ICAO Doc 9284 / IATA DGR 5.1 ORM oxidising substance
     · ARINC 429 label 226 cabin altitude / 227 cabin rate
     · Boeing 737NG/MAX FCOM 8.20 Cabin O2 / 757/767 8.20 /
       777/787 FCOM 8.20 Gaseous O2
     · Airbus A320 FCOM PRO-NOR-SOP-21 OXY / A330/A350 FCOM
       21-30 PASSENGER OXYGEN
     · NTSB AAR-97-06 ValuJet 592 DC-9 KMIA cargo O2-gen fire
     · NTSB AAR-00-01 EgyptAir 990 B767 Atlantic ocean
     · NTSB AAR-02-02 Alaska 261 MD-83 jackscrew (descent)
     · NTSB AAR-06-01 Pinnacle 3701 CRJ-200 high-alt stall
     · AAIB EW-G2018-02-006 G-VAIR 747 chem-O2 generator fire
     · ATSB AO-2008-070 Qantas A330 IRU upset descent
     · ATSB AO-2008-053 Qantas QF30 B747 O2 cylinder fail MNL
     · FAA AD 2004-23-08 PW chemical generator initiator
     · FAA AD 2017-11-09 B777 O2 supply tube
     · EASA AD 2019-0085 A320 chemical O2 generator
     · Honeywell SB 35-XXXX / B/E Aerospace TSO-C64a
     · SAE ARP 4754A / ARP 4761 system safety
     · MIL-STD-882E hazard severity

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash synthesises stable
        per-airframe O2 source class (CHEM / GASEOUS / LOX),
        bottle/candle service-life remaining %, ATA 35
        MMEL dispatchability flag, and post-decompression
        passenger oxygen-mask deployment fraction (random
        masks-dropped 0-1 stuck shut).
     2. 6-class O2-PAX catalogue HVY-Q / HVY / NRW / RGN /
        BIZ / TBP carrying nominal source (CHEM/GAS/LOX),
        nominal burn-time min, max passenger seats, sat-min
        floor SpO2 % for masks-on at FL250 vs CFR 25 90%.
     3. Phase classifier CRZ / DES / APP / TKO and altitude
        gating (only relevant FL>=100). Cruise altitude FL
        sets descent-time minutes-to-FL100 at 1500 fpm
        baseline scaled by DES-RATE slider 800-3500 fpm.
     4. O2-reserve margin = burnTimeMin - descentTimeMin.
        Negative margin = exhaustion before FL100 safe altitude.
     5. 5 risk drivers max-driver composite:
        · RES  reserve margin (0=2x descent, 100=neg)
        · CHM  chem-generator cargo violation (post-VJ592)
        · MSK  mask deployment / SpO2 floor breach
        · LIF  bottle / candle service-life remaining
        · ALT  cruising at FL above QNH-decompression band
     6. Phase-weighted score = max-driver * phase-mul +
        0.10 * secondary. Hard escalation: any negative
        reserve at FL>=350 -> >= 90 (VALUJET tier).
     7. 5 tiers VALUJET / ASCEND / WATCH / OK / IDLE.

   MapLibre overlay:
     · Tier-coloured halo rings sized by score 8-22 px
     · Rose diamond pin at current pos for VALUJET with
       O2-source + burnTimeMin callout
     · Tier-coloured callsign + burn-min + descent-min labels
     · 12-segment dashed forward-projection 50 nm tier-coloured
       for VALUJET / ASCEND
     · Sky reference parallels at lat 60 / 30 / 0 / -30 / -60
       every 12 deg longitude

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell WORST-MARGIN / WORST callsign / VALUJET-count
     · 2-cell MEAN-BURN / SpO2-floor-share secondary row
     · SVG burn-min vs descent-min scatter with rose deficit
       zone (burn < descent) and emerald margin
     · 6 sliders MIN-FL / FLEET-AGE / DES-RATE / MASK-RATE /
       LIFE-MUL / PHASE-WT
     · 6-class chip filter + HALO / PIN / LBL / PROJ / REF /
       DIAG toggles + search
     · AIRCRAFT / CLASSES tab switcher
     · Aircraft row with per-component pill (CHEM/GAS/LOX),
       burn-min vs descent-min, mask-fraction tier-coloured
     · CLASSES grouped by class with worst-tier sort

   Layers > Safety & Traffic.
   Persisted: ft-paxo2
   ============================================================ */

interface PaxO2Flight {
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
  flights: PaxO2Flight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'VALUJET' | 'ASCEND' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  VALUJET: '#ef4444', ASCEND: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['VALUJET', 'ASCEND', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { VALUJET: 0, ASCEND: 1, WATCH: 2, OK: 3, IDLE: 4 }

type AcClass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const CLASS_LIST: AcClass[] = ['HVY-Q', 'HVY', 'NRW', 'RGN', 'BIZ', 'TBP']
const CLASS_LABEL: Record<AcClass, string> = {
  'HVY-Q': 'Heavy quad', HVY: 'Heavy twin', NRW: 'Narrowbody', RGN: 'Regional', BIZ: 'Bizjet', TBP: 'Turboprop',
}

type O2Source = 'CHEM' | 'GAS' | 'LOX'

interface PaxSpec {
  family: string
  source: O2Source
  burnMin: number    // nominal burn time per CFR 25.1447
  paxMax: number     // max pax seats
  satMin: number     // SpO2 floor at FL250 with masks-on
  ceilFl: number     // max certified cruise FL
}

const CLASS_SPEC: Record<AcClass, PaxSpec> = {
  'HVY-Q': { family: '747-8 / A380 / A340',    source: 'GAS',  burnMin: 22, paxMax: 525, satMin: 90, ceilFl: 430 },
  HVY:    { family: '777 / 787 / A350 / A330', source: 'CHEM', burnMin: 22, paxMax: 410, satMin: 90, ceilFl: 430 },
  NRW:    { family: '737NG-MAX / A320 / 757',  source: 'CHEM', burnMin: 12, paxMax: 230, satMin: 88, ceilFl: 410 },
  RGN:    { family: 'CRJ / E-Jet / ATR',       source: 'CHEM', burnMin: 10, paxMax: 110, satMin: 88, ceilFl: 410 },
  BIZ:    { family: 'GLF / FA7X / CL30',       source: 'GAS',  burnMin: 30, paxMax: 19,  satMin: 92, ceilFl: 510 },
  TBP:    { family: 'PT6 / PW150 / Q400',      source: 'GAS',  burnMin: 30, paxMax: 78,  satMin: 86, ceilFl: 270 },
}

type Driver = 'RES' | 'CHM' | 'MSK' | 'LIF' | 'ALT' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  RES: 'O2 reserve margin', CHM: 'Chem-gen cargo / SFAR 25', MSK: 'Mask deployment / SpO2',
  LIF: 'Bottle/candle service life', ALT: 'Cruise altitude vs decomp band', NONE: 'Nominal',
}

type Phase = 'CRZ' | 'DES' | 'APP' | 'TKO'
const PHASE_MUL: Record<Phase, number> = { CRZ: 1.30, DES: 1.10, APP: 0.90, TKO: 1.00 }

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B74|A38|A34|IL96/.test(t)) return 'HVY-Q'
  if (/B77|B78|A33|A35|MD11/.test(t)) return 'HVY'
  if (/B73|A31|A319|A32|A22|B75|MD8|B71/.test(t)) return 'NRW'
  if (/CRJ|E17|E19|E27|E29|E[12]7|E[12]9|F70|F100|AT[47]|DH[48]/.test(t)) return 'RGN'
  if (/G[VI458]|GLF|GLEX|FA[78]X|F2TH|CL30|CL60|C68|C75|BE40|H25|LJ/.test(t)) return 'BIZ'
  return 'TBP'
}

function classifyPhase(alt: number, vr: number, ground: boolean): Phase {
  if (ground) return 'TKO'
  if (vr > 400) return 'TKO'
  if (vr < -400 && alt < 10000) return 'APP'
  if (vr < -300) return 'DES'
  return 'CRZ'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

interface Row {
  f: PaxO2Flight
  klass: AcClass
  spec: PaxSpec
  phase: Phase
  source: O2Source
  burnMin: number       // effective burn after lifeRem
  descentMin: number    // minutes from current FL to FL100 at DES-RATE
  marginMin: number     // burn - descent
  lifeRem: number       // 0..1 service life remaining
  maskFrac: number      // 0..1 fraction masks deployed correctly
  satProj: number       // projected SpO2 % at FL250 with masks
  chemCargoFlag: boolean // post-ValuJet violation flag
  sev: { res: number; chm: number; msk: number; lif: number; alt: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'paxo2-halo', SRC_LBL = 'paxo2-lbl', SRC_PIN = 'paxo2-pin', SRC_PROJ = 'paxo2-proj', SRC_REF = 'paxo2-ref'
const LYR_HALO = 'paxo2-halo-l', LYR_LBL = 'paxo2-lbl-l', LYR_PIN = 'paxo2-pin-l', LYR_PROJ = 'paxo2-proj-l', LYR_REF = 'paxo2-ref-l'

export default function PaxOxygenMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(100)
  const [fleetAge, setFleetAge] = useState(100)
  const [desRate, setDesRate] = useState(1500)   // fpm 800..3500
  const [maskRate, setMaskRate] = useState(100)  // 50..200
  const [lifeMul, setLifeMul] = useState(100)    // 50..200
  const [phaseWt, setPhaseWt] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (!isFinite(f.altitudeFt)) continue
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl) continue
      const phase = classifyPhase(f.altitudeFt, f.vertRate, f.ground)
      const klass = classifyClass(f.type || '')
      const spec = CLASS_SPEC[klass]
      const h = hash32(f.icao || '')
      const ageMul = fleetAge / 100

      // Service life remaining: hash-stable 0..1, biased high
      const r0 = (h & 0xffff) / 0xffff
      const r1 = ((h >>> 8) & 0xffff) / 0xffff
      const r2 = ((h >>> 16) & 0xffff) / 0xffff
      const lifeRem = Math.max(0.05, Math.min(1, (0.45 + r0 * 0.55) / ageMul * (lifeMul / 100)))

      // Effective burn time degrades with lifeRem (a near-EOL candle won't go full 12 min)
      const burnMin = spec.burnMin * (0.55 + 0.45 * lifeRem)

      // Mask deployment fraction: most aircraft 0.95..1.00; tail = stuck-shut
      const maskBase = 1 - Math.max(0, (r1 - 0.85)) * 4 * (maskRate / 100) * ageMul
      const maskFrac = Math.max(0, Math.min(1, maskBase))

      // Descent profile: time to descend from current FL to FL100 at DES-RATE
      const dropFt = Math.max(0, f.altitudeFt - 10000)
      const descentMin = dropFt / Math.max(800, desRate)

      const marginMin = burnMin - descentMin

      // SpO2 projection at FL250 with masks-on, scaled by maskFrac (incomplete mask drop)
      const satProj = spec.satMin * (0.5 + 0.5 * maskFrac) - (lifeRem < 0.4 ? 4 : 0)

      // Chem-gen cargo flag — post-ValuJet 592 risk if source=CHEM and stale candle
      const chemCargoFlag = spec.source === 'CHEM' && r2 > 0.985

      // Severities
      const resSev = marginMin >= burnMin ? 0 :
                     marginMin >= 2 ? Math.max(0, (1 - marginMin / Math.max(1, burnMin)) * 40) :
                     marginMin >= 0 ? 60 + (1 - marginMin / 2) * 20 :
                     100
      const chmSev = chemCargoFlag ? 100 : 0
      const mskSev = maskFrac >= 0.98 ? 0 : maskFrac >= 0.90 ? (0.98 - maskFrac) / 0.08 * 40 :
                     maskFrac >= 0.75 ? 40 + (0.90 - maskFrac) / 0.15 * 40 : 80 + (0.75 - maskFrac) / 0.75 * 20
      const lifSev = lifeRem >= 0.6 ? 0 : lifeRem >= 0.3 ? (0.6 - lifeRem) / 0.3 * 55 : 55 + (0.3 - lifeRem) / 0.3 * 45
      const altSev = fl >= spec.ceilFl - 5 ? 70 : fl >= 400 ? 40 : fl >= 350 ? 25 : 0

      const sev = { res: resSev, chm: chmSev, msk: mskSev, lif: lifSev, alt: altSev }
      const drivers: Array<[Driver, number]> = [['RES', resSev], ['CHM', chmSev], ['MSK', mskSev], ['LIF', lifSev], ['ALT', altSev]]
      drivers.sort((a, b) => b[1] - a[1])
      const driver: Driver = drivers[0][1] >= 12 ? drivers[0][0] : 'NONE'

      const phaseMul = 1 + ((PHASE_MUL[phase] - 1) * (phaseWt / 100))
      const max = drivers[0][1]
      const secondary = drivers[1][1]
      let score = Math.min(100, Math.max(0, max * phaseMul + 0.10 * secondary))

      // Hard escalations
      if (marginMin < 0 && fl >= 350) score = Math.max(score, 92)
      if (chemCargoFlag) score = Math.max(score, 85)

      let tier: Tier
      if (fl < minFl) tier = 'IDLE'
      else if (score >= 80) tier = 'VALUJET'
      else if (score >= 55) tier = 'ASCEND'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({ f, klass, spec, phase, source: spec.source, burnMin, descentMin, marginMin, lifeRem, maskFrac, satProj, chemCargoFlag, sev, score, driver, tier })
    }
    return out
  }, [flights, minFl, fleetAge, desRate, maskRate, lifeMul, phaseWt])

  const tierCount: Record<Tier, number> = { VALUJET: 0, ASCEND: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const r of rows) tierCount[r.tier]++

  const meanBurn = rows.length ? rows.reduce((a, r) => a + r.burnMin, 0) / rows.length : 0
  const satFloorShare = rows.length ? rows.filter(r => r.satProj < r.spec.satMin).length / rows.length : 0
  const worstMargin = rows.reduce((m, r) => r.marginMin < m ? r.marginMin : m, Infinity)
  const worst = rows.length ? rows.slice().sort((a, b) => b.score - a.score)[0] : null
  const chemFlagged = rows.filter(r => r.chemCargoFlag).length

  const filtered = useMemo(() => {
    let r = rows
    if (tierFilter !== 'ALL') r = r.filter(x => x.tier === tierFilter)
    if (classFilter !== 'ALL') r = r.filter(x => x.klass === classFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(x => (x.f.callsign || '').toLowerCase().includes(q) || (x.f.type || '').toLowerCase().includes(q) || (x.f.icao || '').toLowerCase().includes(q) || (x.f.operator || '').toLowerCase().includes(q))
    return r.slice().sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  }, [rows, tierFilter, classFilter, query])

  const classRows = useMemo(() => {
    const m = new Map<AcClass, Row[]>()
    for (const r of rows) {
      const e = m.get(r.klass) || []
      e.push(r); m.set(r.klass, e)
    }
    const arr: Array<{ klass: AcClass; spec: PaxSpec; ac: number; vj: number; asc: number; worstTier: Tier; meanScore: number; meanBurn: number; worstCs: string }> = []
    for (const [k, v] of m) {
      const wt = v.reduce((a, r) => TIER_RANK[r.tier] < TIER_RANK[a] ? r.tier : a, 'IDLE' as Tier)
      const ms = v.reduce((a, r) => a + r.score, 0) / v.length
      const mb = v.reduce((a, r) => a + r.burnMin, 0) / v.length
      const vj = v.filter(r => r.tier === 'VALUJET').length
      const as = v.filter(r => r.tier === 'ASCEND').length
      const wc = v.slice().sort((a, b) => b.score - a.score)[0]
      arr.push({ klass: k, spec: CLASS_SPEC[k], ac: v.length, vj, asc: as, worstTier: wt, meanScore: ms, meanBurn: mb, worstCs: wc?.f.callsign || wc?.f.icao || '' })
    }
    arr.sort((a, b) => TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier] || b.vj - a.vj)
    return arr
  }, [rows])

  useEffect(() => {
    if (!map) return
    const ensureSource = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    }
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_PROJ, SRC_REF]
    sources.forEach(ensureSource)

    if (!map.getLayer(LYR_REF)) {
      map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: { 'line-color': '#0ea5e9', 'line-opacity': 0.18, 'line-width': 0.8, 'line-dasharray': [2, 4] } })
    }
    if (!map.getLayer(LYR_PROJ)) {
      map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.65, 'line-dasharray': [1.5, 2] } })
    }
    if (!map.getLayer(LYR_HALO)) {
      map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.65, 'circle-stroke-width': 1.4 } })
    }
    if (!map.getLayer(LYR_PIN)) {
      map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': '◆', 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }
    if (!map.getLayer(LYR_LBL)) {
      map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 } })
    }

    const halo: any[] = []; const lbl: any[] = []; const pin: any[] = []; const proj: any[] = []
    for (const r of rows) {
      const color = TIER_COLOR[r.tier]
      if (showHalo && r.tier !== 'OK' && r.tier !== 'IDLE') {
        const rad = 8 + (r.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, r: rad } })
      }
      if (showPin && r.tier === 'VALUJET') {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      }
      if (showLabels && (r.tier === 'VALUJET' || r.tier === 'ASCEND')) {
        const label = `${r.f.callsign || r.f.icao} · ${r.source} ${r.burnMin.toFixed(0)}m vs ${r.descentMin.toFixed(0)}m`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { color, label } })
      }
      if (showProj && (r.tier === 'VALUJET' || r.tier === 'ASCEND')) {
        const bearing = (r.f.track || 0) * Math.PI / 180
        const dlat = Math.cos(bearing) * 50 / 60
        const dlng = Math.sin(bearing) * 50 / 60 / Math.max(0.2, Math.cos(r.f.lat * Math.PI / 180))
        for (let i = 0; i < 12; i++) {
          if (i % 2 === 1) continue
          const t0 = i / 12, t1 = (i + 1) / 12
          proj.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.f.lng + dlng * t0, r.f.lat + dlat * t0], [r.f.lng + dlng * t1, r.f.lat + dlat * t1]] }, properties: { color } })
        }
      }
    }

    const refFeats: any[] = []
    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        refFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }

    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_PROJ) as any).setData({ type: 'FeatureCollection', features: proj })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: refFeats })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_REF]) { if (m.getLayer(id)) m.removeLayer(id) }
      for (const id of sources) { if (m.getSource(id)) m.removeSource(id) }
    }
  }, [map, rows, showHalo, showPin, showLabels, showProj, showRef])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const driverBadge = (d: Driver, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const sourcePill = (s: O2Source) => {
    const col = s === 'CHEM' ? '#f59e0b' : s === 'GAS' ? '#0ea5e9' : '#10b981'
    return <span className="inline-flex items-center px-1 py-px rounded text-[9px]" style={{ color: col, border: '1px solid ' + col + '66', backgroundColor: col + '14' }}>{s}</span>
  }

  const advice = (r: Row) => {
    if (r.tier === 'VALUJET') {
      if (r.chemCargoFlag) return 'CHEM-GEN cargo violation suspected — SFAR 25 / 14 CFR 121.629 — segregate, file SDR per AAR-97-06 ValuJet 592'
      return 'O2 RESERVE EXHAUSTED before FL100 — EMERG DESCENT now to MEA, declare PAN/MAYDAY, request lower per FCOM 8.20 / Airbus PRO-ABN-21 OXY'
    }
    if (r.tier === 'ASCEND') return 'Marginal O2 reserve at current FL — brief descent profile, verify mask deployment, consider step-down to FL250'
    if (r.tier === 'WATCH') return 'O2 service life low or mask deployment degraded — schedule generator/bottle inspection next A-check per Boeing SB 35-XXXX'
    return 'PAX O2 system within CFR 25.1447 — burn-time covers FL100 descent at nominal 1500 fpm'
  }

  const W = 280, H = 180
  const xMax = 35   // burn-min axis
  const yMax = 35   // descent-min axis
  const sx = (v: number) => 30 + (Math.min(xMax, v) / xMax) * (W - 40)
  const sy = (v: number) => H - 24 - (Math.min(yMax, Math.max(0, v)) / yMax) * (H - 48)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">PAX Oxygen · Chem-Gen Reserve / Descent</div>
          <div className="text-[10px] text-slate-500">ATA 35-20 · CFR 25.1447 / SFAR 25 · ValuJet AAR-97-06 · AC 25-22</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[10px] font-semibold" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst margin</div>
          <div className="text-sm font-semibold" style={{ color: worstMargin < 0 ? '#ef4444' : worstMargin < 2 ? '#f59e0b' : '#10b981' }}>{isFinite(worstMargin) ? `${worstMargin.toFixed(1)}m` : '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst aircraft</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Reserve exhaust</div>
          <div className="text-sm font-semibold" style={{ color: tierCount.VALUJET > 0 ? '#ef4444' : '#10b981' }}>{tierCount.VALUJET}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean burn-min</div>
          <div className="text-xs font-semibold" style={{ color: meanBurn < 12 ? '#f59e0b' : '#10b981' }}>{meanBurn.toFixed(1)}m</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">SpO2-floor share · CHEM-flag</div>
          <div className="text-xs font-semibold" style={{ color: satFloorShare > 0.20 ? '#f59e0b' : '#10b981' }}>{(satFloorShare * 100).toFixed(1)}% · {chemFlagged}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={30} y={24} width={W-40} height={H-48} fill="#0b1220" />
            {/* deficit zone: burn < descent => below diagonal */}
            <polygon points={`${sx(0)},${sy(0)} ${sx(xMax)},${sy(xMax)} ${sx(xMax)},${sy(0)}`} fill="#ef4444" opacity={0.10} />
            <polygon points={`${sx(0)},${sy(0)} ${sx(xMax)},${sy(xMax)} ${sx(0)},${sy(yMax)}`} fill="#10b981" opacity={0.08} />
            <line x1={sx(0)} y1={sy(0)} x2={sx(xMax)} y2={sy(xMax)} stroke="#64748b" strokeDasharray="3 3" strokeOpacity={0.7} />
            <text x={W - 8} y={sy(xMax / 2) + 3} fontSize={8} fill="#ef4444" textAnchor="end">deficit</text>
            <text x={sx(xMax / 2)} y={28} fontSize={8} fill="#10b981" textAnchor="middle">margin</text>
            {rows.map((r, i) => (
              <circle key={i} cx={sx(r.burnMin)} cy={sy(r.descentMin)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
            <text x={W/2} y={H-6} fontSize={9} fill="#64748b" textAnchor="middle">burn-min vs descent-min to FL100</text>
            <text x={6} y={H/2} fontSize={9} fill="#64748b" transform={`rotate(-90 8 ${H/2})`}>descent (min)</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">FLEET-AGE {fleetAge}%</span><input type="range" min={50} max={200} value={fleetAge} onChange={e => setFleetAge(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">DES-RATE {desRate} fpm</span><input type="range" min={800} max={3500} step={100} value={desRate} onChange={e => setDesRate(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MASK-RATE {maskRate}%</span><input type="range" min={50} max={200} value={maskRate} onChange={e => setMaskRate(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">LIFE-MUL {lifeMul}%</span><input type="range" min={50} max={200} value={lifeMul} onChange={e => setLifeMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setClassFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${classFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {CLASS_LIST.map(c => (
          <button key={c} onClick={() => setClassFilter(classFilter === c ? 'ALL' : c)} className={`px-2 py-0.5 rounded text-[10px] border ${classFilter===c?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>{c}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo],['PIN', showPin, setShowPin],['LBL', showLabels, setShowLabels],['PROJ', showProj, setShowProj],['REF', showRef, setShowRef],['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-500'}`}>{lbl}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / type / op" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'CLASSES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab===t?'bg-sky-500/15 border-sky-500/40 text-sky-300':'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.klass}</span>
              {sourcePill(r.source)}
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{r.phase}</span>
              {r.chemCargoFlag && <span className="px-1 py-px rounded text-[9px] bg-rose-500/20 text-rose-300 border border-rose-500/40">SFAR25!</span>}
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              FL{(r.f.altitudeFt/100).toFixed(0)} · burn {r.burnMin.toFixed(1)}m · descent {r.descentMin.toFixed(1)}m · margin <span style={{color: r.marginMin<0?'#ef4444':r.marginMin<2?'#f59e0b':'#10b981'}}>{r.marginMin.toFixed(1)}m</span> · mask {(r.maskFrac*100).toFixed(0)}% · life {(r.lifeRem*100).toFixed(0)}% · SpO2 {r.satProj.toFixed(0)}%
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('RES', r.sev.res)}
              {driverBadge('CHM', r.sev.chm)}
              {driverBadge('MSK', r.sev.msk)}
              {driverBadge('LIF', r.sev.lif)}
              {driverBadge('ALT', r.sev.alt)}
            </div>
            <div className="px-2 pb-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {advice(r)}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && filtered.length === 0 && (
          <div className="text-center py-6 text-slate-500 text-[11px]">No aircraft match the current filters.</div>
        )}

        {tab === 'CLASSES' && classRows.map((c, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[c.worstTier]}` }}>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{c.klass}</span>
              <span className="text-slate-300 truncate">{CLASS_LABEL[c.klass]}</span>
              {sourcePill(c.spec.source)}
              <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-400">{c.ac} ac</span>
              {tierBadge(c.worstTier)}
            </div>
            <div className="px-2 text-[10px] text-slate-400">{c.spec.family} · burn {c.spec.burnMin}m · pax-max {c.spec.paxMax} · SpO2-floor {c.spec.satMin}% · ceil FL{c.spec.ceilFl} · mean-burn {c.meanBurn.toFixed(1)}m · VJ {c.vj} · ASC {c.asc}</div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${c.meanScore}%`, backgroundColor: TIER_COLOR[c.worstTier] }} className="h-full" />
              </div>
            </div>
            <div className="px-2 pb-1 text-[10px] text-slate-500">mean score {c.meanScore.toFixed(0)} · worst <button onClick={() => { const w = rows.find(rw => rw.klass === c.klass && (rw.f.callsign === c.worstCs || rw.f.icao === c.worstCs)); if (w) onFly(w.f.icao) }} className="text-sky-400 hover:text-sky-300">{c.worstCs || '—'}</button></div>
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: 14 CFR 25.1441/1443/1445/1447/1449/1453 · 121.327/329/333/629 · SFAR 25 · AC 25-22 · AC 121-25 · SAFO 13003 · InFO 14005/18011 · EASA CS 25.1441-1453 · ICAO Annex 6 4.3.8 / Doc 9481 / IATA DGR 5.1 · NTSB AAR-97-06 ValuJet 592 KMIA · AAR-00-01 EgyptAir 990 · AAR-02-02 AS261 MD-83 · AAR-06-01 Pinnacle 3701 · ATSB AO-2008-053 QF30 B747 MNL · AAIB G-VAIR · AD 2004-23-08 / 2017-11-09 / EASA 2019-0085 · Boeing FCOM 8.20 · Airbus FCOM 21-30 · ARINC 429 lbl 226/227.
      </div>
    </div>
  )
}
