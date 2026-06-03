'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   NGS / OBIGGS Fuel-Tank Inerting Ullage O₂ Compliance Monitor
   -----------------------------------------------------------
   Per-airframe Nitrogen Generation System (NGS) / On-Board
   Inert Gas Generation System (OBIGGS) ullage-oxygen tracking
   for centre-wing-tank and wing-tank flammability-reduction
   compliance per the post-TWA800 SFAR 88 rule-set.

   Regulatory & operational basis:
     · 14 CFR 25.981  Fuel tank ignition prevention
     · 14 CFR 25.981(b) Flammability Exposure Evaluation
     · 14 CFR 26.33  Holders of TC — fuel-tank flammability
     · 14 CFR 26.37  Holders of TC — ignition-mitigation means
     · 14 CFR 25 App N Fleet-Average Flammability Exposure ≤ 3 %
     · 14 CFR 121 Subpart M  Continued airworthiness FRM
     · 14 CFR 121.1117  Flammability Reduction Means
     · SFAR 88 (FAA Special Federal Aviation Regulation 88)
     · FAA AC 25.981-2C  Fuel-tank ignition-source prevention
     · FAA AC 25.981-3   Auto-ignition / hot-surface ignition
     · FAA AC 25-19A     CMRs for FRM components
     · EASA CS-25.981 / AMC 25.981 (mirror of FAR 25.981)
     · EASA Special Condition F-44 NGS / IGGS
     · ICAO Annex 8 IIIB Airworthiness
     · ARP 5378 NGS-OBIGGS design standard
     · ARP 5907 Air-separation-module (ASM) hollow-fibre
     · NTSB AAR-00/03 TWA800 centre-wing-tank explosion
     · NTSB AAR-90/06 Philippine Airlines 143 CWT explosion
     · NTSB AAR-02/04 Thai Airways 114 ramp CWT explosion
     · NTSB SR-06/02 Aging-aircraft fuel-tank wiring
     · Boeing 747 AERO Q3-2008 NGS in-service experience
     · Boeing 737NG/MAX FCOM 12.30 Center-tank inerting
     · Boeing 777/787 FCOM 12.30 NGS dual-flow
     · Airbus A320neo FCOM PRO-NOR-SOP-28 IGGS
     · Airbus A350 FCOM 28-30 OBIGGS centre + wing-tanks
     · MMEL Boeing 737-NG 47-01 NGS dispatch deferral
     · MMEL Airbus A320 28-30 IGGS dispatch
     · Boeing SB 737-47-1191 NGS controller upgrade
     · Boeing SB 747-47A2902 ASM service-life
     · Honeywell 7150A0001 ASM hollow-fibre membrane
     · Parker / Cobham NGS / OBIGGS controller catalogue

   Algorithm:
     1. Per-airframe FNV-1a 32-bit hash of ICAO24 synthesises
        ASM service-hours, BPRV (bleed pressure-regulating
        valve) trim, NEA-flow set-point (HFM / LFM dual mode),
        ozone-converter dP, condition of dual-flow valves,
        CWT/wing-tank ullage volume.
     2. 6-class catalogue of FRM-required airframes:
          HVY-NGS-D   747-8 / 777-300ER / A380   dual NGS+OBIGGS
          HVY-NGS     787 / A350 / A330 / 777-200 single NGS
          NRW-NGS     737-NG / 737-MAX / A320neo / 757 CWT NGS
          NRW-FRM     A319/320/321 ceo  inerting retrofit
          RGN-FRM     CRJ-900 / E-jet E2 CWT FRM-compliant
          NON         RGN turboprop / GA / BIZ  not required
     3. NEA (Nitrogen Enriched Air) production:
          - HFM (high-flow mode) on descent/climb: 12 % O₂
          - LFM (low-flow mode) at cruise: 5 % O₂
          - Ullage O₂ target ≤ 12 % FAA App N flammability
          - Wing-tanks target ≤ 9 % EASA Special Condition
     4. ASM efficiency degrades with service-hours:
          eff = 1 − age_hr / 24000 (Honeywell MTBF)
          BPRV trim drift adds ±15 % NEA-flow noise
     5. Cruise-flammability exposure-fraction = time-spent
        with ullage-O₂ > 12 % over the per-flight envelope.

   5 risk components (composite = max-driver):
     O2U  ullage O₂ vs 12 % FAR limit
          100 at ≥ 16 %, 0 at ≤ 8 %, linear in between
     ASM  ASM service-life & permeability
          100 at ≥ 24000 hr, 0 at ≤ 8000 hr
     NEA  NEA-flow vs HFM/LFM set-point
          100 at ≤ 60 % set-point, 0 at ≥ 95 %
     BPRV bleed-air pressure regulating valve trim
          100 at ≥ ±20 psi drift, 0 at ≤ ±3 psi
     FLAM cruise flammability exposure fraction
          100 at ≥ 6 % (App N target), 0 at ≤ 1.5 %

   Composite score = max-driver + 0.10*secondary, clip 0-100.

   Tiers:
     INHIBIT  score ≥ 80 OR ullage-O₂ ≥ 16 % OR FLAM > App-N
              rose: NGS inoperative — exit cruise, AVOID centre-
              tank scavenge, descend below FL250 per QRH NGS FAIL,
              file MEL deferral category C (10 days max)
     DEGRADED score ≥ 55 amber: ECM trend exceedance, NEA short
              of set-point, log ullage O₂ every 15 min, MX at
              next A-check per AC 25-19A
     WATCH    score ≥ 25 sky: within FRM envelope but trend
              adverse, log every 60 min, monitor BPRV trim
     OK       score < 25 emerald: ullage inert, App-N margin
              comfortable
     IDLE     below MIN-FL slider / on ground: slate

   MapLibre overlay:
     · Tier-coloured halo rings sized by score 8-22 px
     · Rose diamond pin at current pos for INHIBIT with
       ullage-O₂ % + FLAM % callout
     · Tier-coloured callsign + class + driver labels for non-OK
     · 12-segment dashed forward-projection 50 nm tier-coloured
       for INHIBIT (ASM-degraded plumes downwind)
     · Sky reference parallels at lat 50/0/-50 every 14° lng

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-ULLAGE-O2 / WORST cs+driver / INHIBIT count
     · 2-cell MEAN-ASM-AGE-hr / FRM-NONCOMP-share secondary
     · SVG ullage-O₂ × ASM-age scatter with rose ≥ 16 %, amber
       12-16, sky 9-12, emerald < 9 — every airframe a dot
     · 6 sliders MIN-FL / FLEET-AGE / NEA-MUL / BPRV-DRIFT /
       FLAM-TGT / ASM-LIFE
     · 6-class chip filter + HALO/PIN/LBL/PROJ/REF/DIAG toggles
     · search + AIRCRAFT / CLASSES tab switcher
     · Aircraft row: tier stripe + callsign + type + class + tier
       + FL + ASM-age + ullage-O₂ + NEA-pct + BPRV-drift + FLAM
     · Classes tab grouped by FRM-class, mean ullage / count

   Layers > Safety & Traffic.
   Persisted: ft-ngs
   ============================================================ */

interface NgsFlight {
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
  flights: NgsFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'INHIBIT' | 'DEGRADED' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  INHIBIT: '#ef4444', DEGRADED: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['INHIBIT', 'DEGRADED', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { INHIBIT: 0, DEGRADED: 1, WATCH: 2, OK: 3, IDLE: 4 }

type FrmClass = 'HVY-NGS-D' | 'HVY-NGS' | 'NRW-NGS' | 'NRW-FRM' | 'RGN-FRM' | 'NON'
const CLASS_LIST: FrmClass[] = ['HVY-NGS-D', 'HVY-NGS', 'NRW-NGS', 'NRW-FRM', 'RGN-FRM', 'NON']
const CLASS_LABEL: Record<FrmClass, string> = {
  'HVY-NGS-D': 'Heavy dual-NGS (747-8 / 777-300ER / A380)',
  'HVY-NGS': 'Heavy single NGS (787 / A350 / A330 / 777-200)',
  'NRW-NGS': 'Narrowbody CWT NGS (737NG/MAX / A320neo / 757)',
  'NRW-FRM': 'Narrowbody FRM retrofit (A319/320/321 ceo)',
  'RGN-FRM': 'Regional CWT FRM (CRJ-900 / E2 jets)',
  'NON': 'Not FRM-required (RGN turboprop / BIZ / GA)',
}

interface FrmSpec {
  family: string
  asmCount: number    // # ASMs onboard
  asmLifeHr: number   // mean ASM life (hr) — Honeywell MTBF
  ullageTgt: number   // % O2 cruise target (App N <=12)
  ullageAlrt: number  // % O2 alert threshold
  ullageRed: number   // % O2 red-line (inhibit)
  cwtVolL: number     // centre-wing-tank ullage (L) for FLAM weighting
  flamTgt: number     // App N target (%)  fleet-avg 3 %, this hull
  bleedPsi: number    // nominal bleed-air supply psi
}

const CLASS_FRM: Record<FrmClass, FrmSpec> = {
  'HVY-NGS-D': { family: 'NGS+OBIGGS dual',  asmCount: 4, asmLifeHr: 24000, ullageTgt: 9,  ullageAlrt: 12, ullageRed: 16, cwtVolL: 65000, flamTgt: 2.0, bleedPsi: 45 },
  'HVY-NGS':   { family: 'NGS single',       asmCount: 2, asmLifeHr: 22000, ullageTgt: 10, ullageAlrt: 12, ullageRed: 16, cwtVolL: 42000, flamTgt: 2.5, bleedPsi: 42 },
  'NRW-NGS':   { family: 'CWT NGS',          asmCount: 1, asmLifeHr: 20000, ullageTgt: 11, ullageAlrt: 12, ullageRed: 16, cwtVolL: 18000, flamTgt: 3.0, bleedPsi: 38 },
  'NRW-FRM':   { family: 'CWT FRM retrofit', asmCount: 1, asmLifeHr: 16000, ullageTgt: 11, ullageAlrt: 12, ullageRed: 17, cwtVolL: 16000, flamTgt: 3.5, bleedPsi: 35 },
  'RGN-FRM':   { family: 'CWT FRM',          asmCount: 1, asmLifeHr: 14000, ullageTgt: 11, ullageAlrt: 13, ullageRed: 17, cwtVolL: 9000,  flamTgt: 4.5, bleedPsi: 32 },
  'NON':       { family: 'No FRM (exempt)',  asmCount: 0, asmLifeHr: 0,     ullageTgt: 21, ullageAlrt: 21, ullageRed: 21, cwtVolL: 0,     flamTgt: 7.0, bleedPsi: 0  },
}

type Driver = 'O2U' | 'ASM' | 'NEA' | 'BPRV' | 'FLAM' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  O2U: 'Ullage O₂ over App-N',
  ASM: 'ASM service-life',
  NEA: 'NEA flow short',
  BPRV: 'Bleed-PRV trim drift',
  FLAM: 'Flammability exposure',
  NONE: 'Nominal',
}

function classifyClass(type: string, _cat?: string): FrmClass {
  const t = (type || '').toUpperCase()
  // Heavy dual
  if (/B748|B77W|B773|A380|A388/.test(t)) return 'HVY-NGS-D'
  // Heavy single
  if (/B787|B788|B789|B78X|A350|A35K|A359|A330|A33[01237]|A338|A339|B772|B77L|B77F/.test(t)) return 'HVY-NGS'
  // Narrowbody NGS (post-SFAR88 builds)
  if (/B73[78]|B739|B73M|B38M|B39M|B7M[78]|B752|B753|A20N|A21N|A21X/.test(t)) return 'NRW-NGS'
  // Narrowbody FRM-retrofit
  if (/A319|A320|A321|B73[34567]/.test(t)) return 'NRW-FRM'
  // Regional with CWT FRM
  if (/CRJ9|CRJX|E190|E195|E290|E295|E170|E175/.test(t)) return 'RGN-FRM'
  return 'NON'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

interface Row {
  f: NgsFlight
  klass: FrmClass
  spec: FrmSpec
  asmAgeHr: number
  asmEff: number
  bprvDrift: number    // psi
  neaPct: number       // % of set-point delivered
  ullage: number       // % O2
  flam: number         // % exposure fraction
  hfm: boolean         // high-flow mode?
  sev: { o2u: number; asm: number; nea: number; bprv: number; flam: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'ngs-halo', SRC_LBL = 'ngs-lbl', SRC_PIN = 'ngs-pin', SRC_PROJ = 'ngs-proj', SRC_REF = 'ngs-ref'
const LYR_HALO = 'ngs-halo-l', LYR_LBL = 'ngs-lbl-l', LYR_PIN = 'ngs-pin-l', LYR_PROJ = 'ngs-proj-l', LYR_REF = 'ngs-ref-l'

export default function NgsInerting({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<FrmClass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(30)
  const [fleetAge, setFleetAge] = useState(100)    // 50..200
  const [neaMul, setNeaMul] = useState(100)        // 50..150
  const [bprvDriftMul, setBprvDriftMul] = useState(100) // 50..200
  const [flamTgtMul, setFlamTgtMul] = useState(100) // 50..200
  const [asmLifeMul, setAsmLifeMul] = useState(100) // 50..200
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
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      if (f.altitudeFt / 100 < minFl) continue
      const klass = classifyClass(f.type || '', f.category)
      const spec = CLASS_FRM[klass]
      const h = hash32(f.icao || '')
      const ageMul = fleetAge / 100

      // Non-FRM aircraft are not monitored (no ullage system) → IDLE-equivalent
      if (klass === 'NON') {
        out.push({
          f, klass, spec,
          asmAgeHr: 0, asmEff: 0, bprvDrift: 0,
          neaPct: 0, ullage: 21, flam: spec.flamTgt,
          hfm: false,
          sev: { o2u: 0, asm: 0, nea: 0, bprv: 0, flam: 0 },
          score: 0, driver: 'NONE', tier: 'IDLE',
        })
        continue
      }

      const r0 = ((h >>> 0) & 0xffff) / 0xffff
      const r1 = ((h >>> 8) & 0xffff) / 0xffff
      const r2 = ((h >>> 16) & 0xffff) / 0xffff
      const r3 = (((h * 0x85ebca6b) >>> 0) & 0xffff) / 0xffff
      const r4 = (((h * 0xc2b2ae35) >>> 8) & 0xffff) / 0xffff
      const r5 = (((h * 0x27d4eb2f) >>> 16) & 0xffff) / 0xffff

      // ASM service hours: 1000..lifeLim * ageMul
      const asmLife = spec.asmLifeHr * (asmLifeMul / 100)
      const asmAgeHr = (1000 + r0 * (asmLife * 1.25)) * ageMul
      const asmEff = Math.max(0.10, 1 - asmAgeHr / Math.max(1, asmLife))

      // BPRV drift: ±0..25 psi, age-skewed
      const bprvDrift = (r1 * 25 - 5) * (bprvDriftMul / 100) * (0.7 + ageMul * 0.5)

      // Phase: HFM on descent/climb (|vr| > 800), LFM cruise
      const hfm = Math.abs(f.vertRate || 0) > 800
      const setPoint = hfm ? 88 : 95  // pct
      const neaPct = Math.max(40, setPoint * asmEff * (1 - Math.min(0.30, Math.abs(bprvDrift) / 50)) * (neaMul / 100) + (r2 - 0.5) * 8)

      // Ullage O2: hfm gives ~12 % O2 floor, lfm ~5 % when neaPct=100. Degrades linearly with neaPct shortfall.
      const ullageFloor = hfm ? 11 : 5
      const ullageDeg = (100 - Math.min(100, neaPct)) / 100 * 14  // up to +14% O2
      const ullage = Math.max(2, Math.min(21, ullageFloor + ullageDeg + (r3 - 0.5) * 2))

      // Flammability exposure (% of cruise window) — proxy: ullage above 12%, weighted by CWT volume
      const flamRaw = Math.max(0, (ullage - spec.ullageAlrt) / (21 - spec.ullageAlrt)) * 12 + (r4 * 0.8) * (ageMul)
      const flam = Math.min(15, flamRaw * (spec.cwtVolL > 0 ? 1 : 0))

      const flamLimit = spec.flamTgt * (flamTgtMul / 100)

      // Severities
      const o2uSev = ullage >= spec.ullageRed
        ? 100
        : ullage <= spec.ullageTgt - 2
          ? 0
          : ((ullage - (spec.ullageTgt - 2)) / Math.max(0.01, spec.ullageRed - (spec.ullageTgt - 2))) * 100
      const asmSev = asmAgeHr >= asmLife
        ? 100
        : asmAgeHr <= asmLife / 3
          ? 0
          : ((asmAgeHr - asmLife / 3) / (asmLife * 2 / 3)) * 100
      const neaSev = neaPct <= setPoint * 0.6
        ? 100
        : neaPct >= setPoint * 0.95
          ? 0
          : (1 - (neaPct - setPoint * 0.6) / (setPoint * 0.35)) * 100
      const bprvAbs = Math.abs(bprvDrift)
      const bprvSev = bprvAbs >= 20
        ? 100
        : bprvAbs <= 3
          ? 0
          : ((bprvAbs - 3) / 17) * 100
      const flamSev = flam >= 6
        ? 100
        : flam <= flamLimit * 0.6
          ? 0
          : ((flam - flamLimit * 0.6) / Math.max(0.01, 6 - flamLimit * 0.6)) * 100 + (r5 * 5)

      const sevList: Array<[Driver, number]> = [
        ['O2U', o2uSev], ['ASM', asmSev], ['NEA', neaSev], ['BPRV', bprvSev], ['FLAM', flamSev],
      ]
      sevList.sort((a, b) => b[1] - a[1])
      const driver: Driver = sevList[0][1] > 0 ? sevList[0][0] : 'NONE'
      const score = Math.min(100, sevList[0][1] + sevList[1][1] * 0.10)

      let tier: Tier
      if (ullage >= spec.ullageRed || flam > flamLimit * 2 || score >= 80) tier = 'INHIBIT'
      else if (score >= 55) tier = 'DEGRADED'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, klass, spec, asmAgeHr, asmEff, bprvDrift, neaPct, ullage, flam, hfm,
        sev: { o2u: o2uSev, asm: asmSev, nea: neaSev, bprv: bprvSev, flam: flamSev },
        score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, fleetAge, neaMul, bprvDriftMul, flamTgtMul, asmLifeMul])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { INHIBIT: 0, DEGRADED: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumU = 0, sumUn = 0, sumAge = 0, sumAgeN = 0, nonComp = 0, totalFrm = 0
    let worst = 0, worstCs = '', worstDrv: Driver = 'NONE'
    for (const r of rows) {
      if (r.klass === 'NON') continue
      totalFrm++
      sumU += r.ullage; sumUn++
      sumAge += r.asmAgeHr; sumAgeN++
      if (r.flam > r.spec.flamTgt * (flamTgtMul / 100)) nonComp++
      if (r.score > worst) { worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstDrv = r.driver }
    }
    return {
      meanUllage: sumUn ? sumU / sumUn : 0,
      meanAsmAge: sumAgeN ? sumAge / sumAgeN : 0,
      inhibit: tally.INHIBIT, worst, worstCs, worstDrv,
      nonCompShare: totalFrm ? nonComp / totalFrm : 0,
    }
  }, [rows, tally, flamTgtMul])

  const classAggs = useMemo(() => {
    const m = new Map<FrmClass, { klass: FrmClass; count: number; sumScore: number; sumUllage: number; sumAsmAge: number; inhibit: number; worst: number; worstCs: string; worstIcao: string; worstTier: Tier }>()
    for (const r of rows) {
      let a = m.get(r.klass)
      if (!a) { a = { klass: r.klass, count: 0, sumScore: 0, sumUllage: 0, sumAsmAge: 0, inhibit: 0, worst: 0, worstCs: '', worstIcao: '', worstTier: 'OK' }; m.set(r.klass, a) }
      a.count++; a.sumScore += r.score; a.sumUllage += r.ullage; a.sumAsmAge += r.asmAgeHr
      if (r.tier === 'INHIBIT') a.inhibit++
      if (TIER_RANK[r.tier] < TIER_RANK[a.worstTier]) a.worstTier = r.tier
      if (r.score > a.worst) { a.worst = r.score; a.worstCs = (r.f.callsign || r.f.icao).trim(); a.worstIcao = r.f.icao }
    }
    return Array.from(m.values()).map(a => ({
      ...a,
      meanScore: a.count ? a.sumScore / a.count : 0,
      meanUllage: a.count ? a.sumUllage / a.count : 0,
      meanAsmAge: a.count ? a.sumAsmAge / a.count : 0,
    })).sort((a, b) => {
      const ti = TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]
      if (ti !== 0) return ti
      return b.inhibit - a.inhibit || b.count - a.count
    })
  }, [rows])

  // ---- MapLibre rendering ----
  useEffect(() => {
    if (!map) return
    const m = map
    const ready = () => {
      const ensure = (id: string) => {
        if (!m.getSource(id)) m.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      }
      ensure(SRC_HALO); ensure(SRC_PIN); ensure(SRC_LBL); ensure(SRC_PROJ); ensure(SRC_REF)
      if (!m.getLayer(LYR_HALO)) m.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'c'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'c'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85 } })
      if (!m.getLayer(LYR_PROJ)) m.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: { 'line-color': ['get', 'c'], 'line-width': 1.5, 'line-opacity': 0.7, 'line-dasharray': [2, 2] } })
      if (!m.getLayer(LYR_REF)) m.addLayer({ id: LYR_REF, type: 'circle', source: SRC_REF, paint: { 'circle-radius': 1.6, 'circle-color': '#0ea5e9', 'circle-opacity': 0.35 } })
      if (!m.getLayer(LYR_PIN)) m.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: { 'text-field': '◆', 'text-size': 14, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#0b0f1a', 'text-halo-width': 1.4 } })
      if (!m.getLayer(LYR_LBL)) m.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 't'], 'text-size': 10, 'text-offset': [0, 1.3], 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#0b0f1a', 'text-halo-width': 1.4 } })
    }
    if (m.isStyleLoaded()) ready(); else m.once('load', ready)
    return () => {
      for (const l of [LYR_HALO, LYR_PROJ, LYR_REF, LYR_PIN, LYR_LBL]) if (m.getLayer(l)) m.removeLayer(l)
      for (const s of [SRC_HALO, SRC_PROJ, SRC_REF, SRC_PIN, SRC_LBL]) if (m.getSource(s)) m.removeSource(s)
    }
  }, [map])

  useEffect(() => {
    if (!map) return
    const m = map
    if (!m.getSource(SRC_HALO)) return

    const halos: any[] = [], pins: any[] = [], labels: any[] = [], proj: any[] = [], refs: any[] = []
    for (const r of rows) {
      if (r.tier === 'OK' || r.tier === 'IDLE') continue
      const c = TIER_COLOR[r.tier]
      const rad = 8 + (r.score / 100) * 14
      if (showHalo) halos.push({ type: 'Feature', properties: { c, r: rad }, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
      if (showPin && r.tier === 'INHIBIT') pins.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
      if (showLabels) {
        labels.push({ type: 'Feature', properties: { c, t: `${(r.f.callsign || r.f.icao).trim()}  ${r.klass}  O₂${r.ullage.toFixed(1)}%  ${r.driver}` }, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
      }
      if (showProj && r.tier === 'INHIBIT') {
        const trk = (r.f.track || 0) * Math.PI / 180
        const nm = 50
        const dLat = Math.cos(trk) * (nm / 60)
        const dLng = Math.sin(trk) * (nm / 60) / Math.max(0.2, Math.cos(r.f.lat * Math.PI / 180))
        proj.push({ type: 'Feature', properties: { c }, geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.f.lng + dLng, r.f.lat + dLat]] } })
      }
    }
    if (showRef) {
      for (const lat of [50, 0, -50]) for (let lng = -180; lng < 180; lng += 14) {
        refs.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lng, lat] } })
      }
    }
    ;(m.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halos })
    ;(m.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pins })
    ;(m.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: labels })
    ;(m.getSource(SRC_PROJ) as any).setData({ type: 'FeatureCollection', features: proj })
    ;(m.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: refs })
  }, [map, rows, showHalo, showPin, showLabels, showProj, showRef])

  // ---- View filtering ----
  const q = query.trim().toUpperCase()
  const filteredRows = rows.filter(r => {
    if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
    if (classFilter !== 'ALL' && r.klass !== classFilter) return false
    if (q) {
      const cs = (r.f.callsign || r.f.icao).toUpperCase()
      if (!cs.includes(q) && !(r.f.type || '').toUpperCase().includes(q)) return false
    }
    return true
  }).sort((a, b) => {
    const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
    return ti !== 0 ? ti : b.score - a.score
  })

  // ---- Diagnostic SVG (Ullage-O2 × ASM-age) ----
  const diag = useMemo(() => {
    const W = 360, H = 200, padL = 38, padR = 10, padT = 12, padB = 28
    const xMax = 25000  // ASM hr
    const yMax = 20     // % O2
    const xToPx = (x: number) => padL + Math.min(1, x / xMax) * (W - padL - padR)
    const yToPx = (y: number) => H - padB - Math.min(1, y / yMax) * (H - padT - padB)
    return { W, H, padL, padR, padT, padB, xMax, yMax, xToPx, yToPx }
  }, [])

  function advice(r: Row): string {
    if (r.klass === 'NON') return 'Aircraft is not FRM-required (no NGS / IGGS installed).'
    if (r.tier === 'INHIBIT') return `NGS inoperative — ullage O₂ ${r.ullage.toFixed(1)} % at red-line. Exit cruise, descend below FL250, AVOID centre-tank scavenge per QRH NGS FAIL. File MEL CAT-C deferral (10 d).`
    if (r.tier === 'DEGRADED') return `ECM trend exceedance (${DRIVER_LABEL[r.driver].toLowerCase()}). Log ullage O₂ every 15 min, schedule ASM / BPRV check at next A-check per AC 25-19A.`
    if (r.tier === 'WATCH') return `Within FRM envelope but trend adverse (${DRIVER_LABEL[r.driver].toLowerCase()}). Log every 60 min, monitor BPRV trim.`
    return 'Ullage inert; App-N flammability-exposure margin comfortable.'
  }

  return (
    <div className="fixed top-16 right-2 z-40 w-[440px] max-h-[calc(100vh-5rem)] overflow-y-auto rounded-xl border border-sky-500/40 bg-slate-950/95 backdrop-blur p-3 text-xs text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-sky-300">NGS / OBIGGS Ullage O₂</span>
          <span className="text-[10px] text-slate-500">SFAR 88 · 14 CFR 25.981 · App N</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100">✕</button>
      </div>

      {/* Tier counter strip */}
      <div className="grid grid-cols-5 gap-1 mb-2">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`px-1.5 py-1 rounded border text-[10px] ${tierFilter === t ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-700/70'}`}
            style={{ color: TIER_COLOR[t] }}>
            {t} {tally[t]}
          </button>
        ))}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-1 mb-1">
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">MEAN O₂</div>
          <div className="text-sm" style={{ color: summary.meanUllage >= 12 ? '#ef4444' : summary.meanUllage >= 10 ? '#f59e0b' : '#10b981' }}>{summary.meanUllage.toFixed(1)} %</div>
        </div>
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">WORST</div>
          <div className="text-[11px] text-slate-200 truncate">{summary.worstCs || '—'}{summary.worstDrv !== 'NONE' ? ' · ' + summary.worstDrv : ''}</div>
        </div>
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">INHIBIT</div>
          <div className="text-sm" style={{ color: summary.inhibit ? '#ef4444' : '#10b981' }}>{summary.inhibit}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 mb-2">
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">MEAN ASM AGE</div>
          <div className="text-sm text-sky-300">{(summary.meanAsmAge / 1000).toFixed(1)} kh</div>
        </div>
        <div className="px-2 py-1 rounded border border-slate-700/60 bg-slate-900/60">
          <div className="text-[9px] text-slate-500">FRM-NONCOMP</div>
          <div className="text-sm" style={{ color: summary.nonCompShare > 0.20 ? '#f59e0b' : '#10b981' }}>{(summary.nonCompShare * 100).toFixed(0)} %</div>
        </div>
      </div>

      {/* Diagnostic */}
      {showDiag && (
        <div className="mb-2 rounded border border-slate-700/60 bg-slate-900/60 p-1">
          <div className="text-[9px] text-slate-500 mb-0.5">Ullage O₂ × ASM service hours</div>
          <svg width={diag.W} height={diag.H} className="block">
            {/* Rose band ullage >=16% */}
            <rect x={diag.padL} y={diag.padT} width={diag.W - diag.padL - diag.padR} height={diag.yToPx(16) - diag.padT} fill="#ef4444" fillOpacity={0.10} />
            {/* Amber band 12-16% */}
            <rect x={diag.padL} y={diag.yToPx(16)} width={diag.W - diag.padL - diag.padR} height={diag.yToPx(12) - diag.yToPx(16)} fill="#f59e0b" fillOpacity={0.08} />
            {/* Sky band 9-12% */}
            <rect x={diag.padL} y={diag.yToPx(12)} width={diag.W - diag.padL - diag.padR} height={diag.yToPx(9) - diag.yToPx(12)} fill="#0ea5e9" fillOpacity={0.05} />
            {/* Axes */}
            <line x1={diag.padL} y1={diag.H - diag.padB} x2={diag.W - diag.padR} y2={diag.H - diag.padB} stroke="#334155" />
            <line x1={diag.padL} y1={diag.padT} x2={diag.padL} y2={diag.H - diag.padB} stroke="#334155" />
            {[5000, 10000, 15000, 20000].map(x => (
              <g key={'vx' + x}>
                <line x1={diag.xToPx(x)} y1={diag.padT} x2={diag.xToPx(x)} y2={diag.H - diag.padB} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xToPx(x)} y={diag.H - diag.padB + 10} fontSize={8} fill="#64748b" textAnchor="middle">{x / 1000}k</text>
              </g>
            ))}
            {[5, 9, 12, 16, 21].map(y => (
              <g key={'hy' + y}>
                <line x1={diag.padL} y1={diag.yToPx(y)} x2={diag.W - diag.padR} y2={diag.yToPx(y)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.padL - 4} y={diag.yToPx(y) + 3} fontSize={8} fill="#64748b" textAnchor="end">{y}%</text>
              </g>
            ))}
            {/* App-N 12% horizontal */}
            <line x1={diag.padL} y1={diag.yToPx(12)} x2={diag.W - diag.padR} y2={diag.yToPx(12)} stroke="#f59e0b" strokeDasharray="3 2" strokeOpacity={0.6} />
            {/* Aircraft dots */}
            {rows.filter(r => r.klass !== 'NON').map(r => {
              const xx = diag.xToPx(Math.min(diag.xMax, r.asmAgeHr))
              const yy = diag.yToPx(Math.min(diag.yMax, r.ullage))
              return <circle key={r.f.icao} cx={xx} cy={yy} r={2} fill={TIER_COLOR[r.tier]} fillOpacity={0.85} />
            })}
            <text x={diag.W - diag.padR} y={diag.H - 4} fontSize={8} fill="#64748b" textAnchor="end">ASM hr</text>
            <text x={diag.padL + 4} y={diag.padT + 8} fontSize={8} fill="#64748b">O₂ %</text>
          </svg>
        </div>
      )}

      {/* Sliders */}
      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">MIN-FL</span><span className="text-[10px] text-slate-300">{minFl}</span></div>
          <input type="range" min={0} max={400} value={minFl} onChange={e => setMinFl(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">FLEET-AGE %</span><span className="text-[10px] text-slate-300">{fleetAge}</span></div>
          <input type="range" min={50} max={200} value={fleetAge} onChange={e => setFleetAge(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">NEA-MUL %</span><span className="text-[10px] text-slate-300">{neaMul}</span></div>
          <input type="range" min={50} max={150} value={neaMul} onChange={e => setNeaMul(+e.target.value)} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex justify-between"><span className="text-[10px] text-slate-500">BPRV-DRIFT %</span><span className="text-[10px] text-slate-300">{bprvDriftMul}</span></div>
          <input type="range" min={50} max={200} value={bprvDriftMul} onChange={e => setBprvDriftMul(+e.target.value)} className="w-full accent-sky-500" />
        </div>
      </div>
      <div className="mb-2">
        <div className="flex justify-between"><span className="text-[10px] text-slate-500">FLAM-TGT %</span><span className="text-[10px] text-slate-300">{flamTgtMul}</span></div>
        <input type="range" min={50} max={200} value={flamTgtMul} onChange={e => setFlamTgtMul(+e.target.value)} className="w-full accent-sky-500" />
      </div>
      <div className="mb-2">
        <div className="flex justify-between"><span className="text-[10px] text-slate-500">ASM-LIFE %</span><span className="text-[10px] text-slate-300">{asmLifeMul}</span></div>
        <input type="range" min={50} max={200} value={asmLifeMul} onChange={e => setAsmLifeMul(+e.target.value)} className="w-full accent-sky-500" />
      </div>

      {/* Class chips */}
      <div className="flex flex-wrap gap-1 mb-2">
        <button onClick={() => setClassFilter('ALL')}
          className={`px-1.5 py-0.5 rounded border text-[10px] ${classFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700/70 text-slate-400'}`}>ALL</button>
        {CLASS_LIST.map(k => (
          <button key={k} onClick={() => setClassFilter(classFilter === k ? 'ALL' : k)}
            className={`px-1.5 py-0.5 rounded border text-[10px] ${classFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700/70 text-slate-400'}`}>{k}</button>
        ))}
      </div>

      {/* Toggles */}
      <div className="flex flex-wrap gap-1 mb-2">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLabels, setShowLabels], ['PROJ', showProj, setShowProj], ['REF', showRef, setShowRef], ['DIAG', showDiag, setShowDiag]] as const).map(([lbl, v, set]) => (
          <button key={lbl} onClick={() => set(!v)}
            className={`px-1.5 py-0.5 rounded border text-[10px] ${v ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700/70 text-slate-400'}`}>{lbl}</button>
        ))}
      </div>

      {/* Search + tabs */}
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type"
        className="w-full mb-2 px-2 py-1 rounded border border-slate-700 bg-slate-900/60 text-[11px] placeholder:text-slate-600" />
      <div className="grid grid-cols-2 gap-1 mb-2">
        {(['AIRCRAFT', 'CLASSES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2 py-1 rounded border text-[10px] ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700/70 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      {/* Rows */}
      <div className="space-y-1">
        {tab === 'AIRCRAFT' && filteredRows.slice(0, 60).map(r => (
          <div key={r.f.icao} className="rounded border border-slate-700/60 bg-slate-900/60 overflow-hidden cursor-pointer hover:border-sky-500/40" onClick={() => onFly(r.f.icao)}>
            <div className="h-0.5" style={{ background: TIER_COLOR[r.tier] }} />
            <div className="p-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <span className="text-[11px] font-semibold text-slate-100">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-[9px] text-slate-500">{r.f.type || '—'}</span>
                  <span className="text-[9px] px-1 rounded border border-slate-700/70 text-slate-400">{r.klass}</span>
                  {r.hfm && <span className="text-[9px] px-1 rounded border border-sky-500/40 text-sky-300">HFM</span>}
                </div>
                <span className="text-[9px] px-1 rounded border" style={{ color: TIER_COLOR[r.tier], borderColor: TIER_COLOR[r.tier] + '55' }}>{r.tier}</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                FL{Math.round(r.f.altitudeFt / 100)} · {r.spec.family} · {r.spec.asmCount}× ASM · tgt ≤{r.spec.ullageTgt}%
              </div>
              {r.klass !== 'NON' && (
                <>
                  <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                    <div className="h-full" style={{ width: r.score + '%', background: TIER_COLOR[r.tier] }} />
                  </div>
                  <div className="mt-1 grid grid-cols-3 gap-1 text-[9px]">
                    <div className="px-1 py-0.5 rounded border border-slate-700/70">
                      <span className="text-slate-500">O₂ </span>
                      <span style={{ color: r.ullage >= r.spec.ullageRed ? '#ef4444' : r.ullage >= r.spec.ullageAlrt ? '#f59e0b' : '#10b981' }}>{r.ullage.toFixed(1)}%</span>
                    </div>
                    <div className="px-1 py-0.5 rounded border border-slate-700/70">
                      <span className="text-slate-500">ASM </span>
                      <span style={{ color: r.asmAgeHr >= r.spec.asmLifeHr ? '#ef4444' : r.asmAgeHr >= r.spec.asmLifeHr * 0.66 ? '#f59e0b' : '#94a3b8' }}>{(r.asmAgeHr / 1000).toFixed(1)}kh</span>
                    </div>
                    <div className="px-1 py-0.5 rounded border border-slate-700/70">
                      <span className="text-slate-500">NEA </span>
                      <span style={{ color: r.neaPct <= 60 ? '#ef4444' : r.neaPct <= 80 ? '#f59e0b' : '#10b981' }}>{r.neaPct.toFixed(0)}%</span>
                    </div>
                    <div className="px-1 py-0.5 rounded border border-slate-700/70">
                      <span className="text-slate-500">BPRV </span>
                      <span style={{ color: Math.abs(r.bprvDrift) >= 15 ? '#ef4444' : Math.abs(r.bprvDrift) >= 8 ? '#f59e0b' : '#94a3b8' }}>{r.bprvDrift >= 0 ? '+' : ''}{r.bprvDrift.toFixed(1)}psi</span>
                    </div>
                    <div className="px-1 py-0.5 rounded border border-slate-700/70">
                      <span className="text-slate-500">FLAM </span>
                      <span style={{ color: r.flam >= r.spec.flamTgt * (flamTgtMul / 100) * 2 ? '#ef4444' : r.flam >= r.spec.flamTgt * (flamTgtMul / 100) ? '#f59e0b' : '#10b981' }}>{r.flam.toFixed(1)}%</span>
                    </div>
                    <div className="px-1 py-0.5 rounded border border-slate-700/70 text-slate-400">
                      App-N ≤{(r.spec.flamTgt * (flamTgtMul / 100)).toFixed(1)}%
                    </div>
                  </div>
                </>
              )}
              <div className="mt-1 text-[10px] text-slate-400">{r.f.operator || '—'}</div>
              <div className="mt-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>{advice(r)}</div>
            </div>
          </div>
        ))}

        {tab === 'CLASSES' && classAggs.map(a => (
          <div key={a.klass} className="rounded border border-slate-700/60 bg-slate-900/60 overflow-hidden cursor-pointer hover:border-sky-500/40" onClick={() => a.worstIcao && onFly(a.worstIcao)}>
            <div className="h-0.5" style={{ background: TIER_COLOR[a.worstTier] }} />
            <div className="p-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <span className="text-[9px] px-1 rounded border border-slate-700/70 text-slate-300">{a.klass}</span>
                  <span className="text-[9px] text-slate-500">×{a.count} ac</span>
                </div>
                <span className="text-[9px] px-1 rounded border" style={{ color: TIER_COLOR[a.worstTier], borderColor: TIER_COLOR[a.worstTier] + '55' }}>{a.worstTier}</span>
              </div>
              <div className="text-[10px] text-slate-300 mt-0.5">{CLASS_LABEL[a.klass]}</div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                mean O₂ {a.meanUllage.toFixed(1)}% · mean ASM {(a.meanAsmAge / 1000).toFixed(1)}kh · INHIBIT {a.inhibit}
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: a.meanScore + '%', background: TIER_COLOR[a.worstTier] }} />
              </div>
              <div className="text-[10px] text-slate-400 mt-1">{CLASS_FRM[a.klass].family} · {CLASS_FRM[a.klass].asmCount}× ASM · life {CLASS_FRM[a.klass].asmLifeHr / 1000}kh · worst {a.worstCs || '—'}</div>
            </div>
          </div>
        ))}
        {filteredRows.length === 0 && tab === 'AIRCRAFT' && (
          <div className="text-center text-[10px] text-slate-500 py-4">No aircraft above FL{minFl}.</div>
        )}
      </div>
    </div>
  )
}
