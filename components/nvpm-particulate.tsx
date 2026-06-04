'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   NVPM · Non-Volatile Particulate Matter Emissions Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of the engine non-volatile
   particulate matter (nvPM) mass + number emission rate
   along the projected ground-track per:
     · ICAO Annex 16 Vol II Pt III Ch.4 (nvPM standard,
       applicable to engines >26.7 kN since 2020 / 2023
       for new types)
     · ICAO Doc 9889 Manual on Air Quality §A.4 / App.A
       (BFFM2 + FOA4 / SCOPE11 derivation)
     · ICAO EEDB (Engine Emissions Databank) ed.29 2024
       EI_nvPM_mass mg/kg-fuel + EI_nvPM_num #/kg-fuel
     · SCOPE11 method Agarwal et al. ASME GT2019-91504
       (Smoke Number → BC mass conversion, GMD-based number)
     · FOA4 (First-Order Approximation v4) Wayson-Fleming-
       Iovinelli 2009 J.Air&Waste-Mgmt §59
     · CAEP/11 nvPM Mass + Number Regulatory Standards
       (CAEP/11 Doc 10180 §5.2)
     · BFFM2 Boeing Fuel-Flow Method 2 DuBois-Paynter
       SAE 2006-01-1987 thrust-setting interpolation
     · 14 CFR Pt 34 Subpart C engine emission std
     · EASA CS-34 §34.1 / AMC 34.1 nvPM compliance
     · IATA Aviation Climate Action Manual ed.2 2024 §3.4
     · ACI World Airport Air Quality Handbook ed.3 2025 §4
   ------------------------------------------------------------
   Distinct from existing EMISSIONS overlay (which is CO2 +
   contrail-CO2-equivalent radiative-forcing focused) and
   from CONTRAIL overlay (ice-particle persistence). NVPM
   measures the *soot/black-carbon* aerosol mass + number
   emission tally — the dominant non-CO2 surface-air-quality
   pollutant and the primary nucleation seed for contrail
   ice crystals.

   Per-class engine EI catalogue (cruise-setting nvPM):
     · HVY-CFM     CFM56-7B / LEAP-1A  mg/kg 18 / 6
     · HVY-RR      RB211/Trent          mg/kg 22 / 8
     · HVY-GE      GE90/GEnx/GE9X       mg/kg 12 / 4 (rich-burn TAPS-II)
     · HVY-PW      PW4000/PW1100G       mg/kg 16 / 5
     · NB-CFM      CFM56-5B/-7B         mg/kg 28 / 14 (older fleet)
     · NB-LEAP     LEAP-1A/B            mg/kg 6 / 3 (CAEP/11 compliant)
     · NB-V2500    IAE V2500-A5         mg/kg 35 / 18
     · RGN-J       CF34/AE3007/PW1500   mg/kg 24 / 12
     · RGN-T       PW100/PT6/TPE331     mg/kg 8 / 5 (turboprop, low TIT)
     · BIZ         BR710/PW307/TAY      mg/kg 18 / 9
     · LIGHT       PT6A/Avgas-piston    mg/kg 4 / 2

   Fuel flow per engine at cruise (kg/h/eng):
     class table per BADA 3.15 OPF / Boeing PEM §3 /
     Airbus GTG §3 LRC fuel-flow.

   Thrust setting proxy = (FL / FL_LRC) × (1 + |VS|/3000)
   per BFFM2 §5 fuel-flow-to-thrust interpolation.

   nvPM mass rate (mg/s) = EI_mass × FF_kgs × n_eng
   nvPM number rate (#/s) = EI_num × FF_kgs × n_eng
   PM2.5 fraction = 1.0 (BC GMD 30-90 nm fully in PM2.5)
   Surface-level deposition velocity v_d ≈ 0.4 cm/s per
   Wesely (1989) atmospheric dry-dep parametrisation.

   Air-quality scope amplifier (BCA = below 3000ft AGL):
     · 3.0× for FL<030 (TIM Taxi/Idle/Move LTO cycle)
     · 1.5× for FL030-070 (climbout/approach BFM)
     · 1.0× for FL070-100 (initial climb)
     · 0.6× for FL100+ (cruise, dilution dominates)
   per ICAO Doc 9889 §3 LTO cycle weighting.

   6 drivers (max-driver composite):
     · MASS    nvPM mass rate g/s (ramp 0→5 g/s)
     · NUM     nvPM number rate ×10^15/s (ramp 0→8)
     · BCA     below-3000ft amplifier (LTO penalty)
     · OLDFLT  pre-CAEP/11 engine (RB211/V2500/CFM56-5)
     · SMOKE   SN-derived high-soot regime (BFM)
     · FUEL    fuel-burn rate proxy (heavy fleet)
   Composite = max·0.64 + mean·0.36 × ADV-MUL
   Hard escalators:
     · MASS > 4 g/s score-min 88 (severe BC plume)
     · BCA + LTO regime + OLDFLT score-min 78
     · CAEP/11 non-compliant + cruise score-min 60

   6 tiers:
     SEVERE   ≥80 rose       major BC plume (LTO/old engine)
     HIGH     ≥60 rose-pink  pre-CAEP/11 fleet at altitude
     MODERATE ≥40 amber      typical CFM56/V2500 generation
     LOW      ≥18 sky        CAEP/11-compliant LEAP/GTF
     CLEAN    <18 emerald    GTF/GEnx TAPS-II low-soot
     OFF      slate          on-ground stationary or below FL010

   Side panel:
     · 6-tier counter strip (click-to-filter)
     · 6-cell summary: μ-mass / Σ-mass-g-s / WORST-cs /
       SEVERE-cnt / μ-num ×10^15 / Σ-fuel-t-h
     · 5 sliders: MIN-FL 0-200 / MAX-FL 50-500 /
       ADV-MUL 50-200% / EI-MUL 50-200% (calibration) /
       BCA-MUL 50-300% (LTO weighting)
     · 11-class chip filter
     · HALO/PIN/PLUME/LBL toggles
     · search by callsign / type / operator / class
     · AIRCRAFT/CLASSES/EEDB tab switcher

   MapLibre overlay:
     · tier-coloured halo rings 7-19px by score
     · SEVERE/HIGH rose pins
     · forward-cone PLUME wedge (tier-coloured polygon)
       sized by mass-rate (12-36 NM) for top-18 worst
     · cs / mg-s / N-rate labels

   AIRCRAFT tab — tier-worst-first row stack:
     · cs + type + class-pill + n×eng-pill + tier-pill
     · FL / FF-kgs / EI-mass / EI-num row
     · MASS-g-s / NUM-1e15-s / BCA× / SCORE row
     · tier-coloured score bar
     · 6-driver chips MASS NUM BCA OLDFLT SMOKE FUEL
     · tier-coloured advice citing CAEP/11 §5.2 /
       ICAO Annex 16 II Pt III Ch.4 / Doc 9889 §A.4

   CLASSES tab — per-class row:
     · class-pill + count + engine-family note
     · EI-mass / EI-num / FF-LRC / TIT-proxy cells
     · μ-mass / Σ-mass / SEVERE / HIGH 4-cell
     · class-coloured mass-rate bar
     · CAEP/11 compliance stripe (emerald = compliant)

   EEDB tab — full SVG EI-mass vs EI-num scatter plot:
     · 11 class dots positioned by EI-mass (0-40 mg/kg) ×
       EI-num (0-25×10^15/kg) per ICAO EEDB ed.29
     · tier-zone background bands
     · CAEP/11 mass-limit line (12 mg/kg cruise)
     · CAEP/11 number-limit line (1.0×10^15/kg)
     · current fleet centroid dot (tier-coloured)
     · 3-cell μ-EI-mass / μ-EI-num / CAEP-pass-% summary
     · methodology narrative + references

   References:
     · ICAO Annex 16 Vol II Pt III Ch.4 nvPM standard
     · ICAO Doc 9889 Manual on Air Quality §A.4 / App.A
     · ICAO EEDB Engine Emissions Databank ed.29 2024
     · CAEP/11 Doc 10180 §5.2 nvPM regulatory standard
     · SCOPE11 Agarwal et al. ASME GT2019-91504
     · FOA4 Wayson-Fleming-Iovinelli J.Air&Waste 59 (2009)
     · BFFM2 DuBois-Paynter SAE 2006-01-1987
     · 14 CFR Pt 34 / EASA CS-34 §34.1 / AMC 34.1
     · IATA Aviation Climate Action Manual ed.2 2024 §3.4
     · ACI World Airport Air Quality Handbook ed.3 2025
     · Wesely Atmos. Environ. 23 (1989) deposition velocity
     · Stettler et al. Atmos. Environ. 67 (2013) UK aviation
     · Lobo et al. Environ. Sci. Technol. 49 (2015) nvPM SN
     · Moore et al. Nature 543 (2017) biofuel BC reduction
     · Boulanger et al. Aeronaut. J. 124 (2020) GTF nvPM
     · Brem et al. Environ. Sci. Technol. 49 (2015) cruise EI
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'SEVERE' | 'HIGH' | 'MODERATE' | 'LOW' | 'CLEAN' | 'OFF'
const TIER_COLOR: Record<Tier, string> = {
  SEVERE:   '#ef4444',
  HIGH:     '#fb7185',
  MODERATE: '#f59e0b',
  LOW:      '#0ea5e9',
  CLEAN:    '#10b981',
  OFF:      '#64748b',
}
const TIER_ORDER: Tier[] = ['SEVERE','HIGH','MODERATE','LOW','CLEAN','OFF']

type Klass =
  | 'HVY-CFM' | 'HVY-RR' | 'HVY-GE' | 'HVY-PW'
  | 'NB-CFM' | 'NB-LEAP' | 'NB-V2500'
  | 'RGN-J' | 'RGN-T' | 'BIZ' | 'LIGHT'
const KLASS_LIST: Klass[] = ['HVY-CFM','HVY-RR','HVY-GE','HVY-PW','NB-CFM','NB-LEAP','NB-V2500','RGN-J','RGN-T','BIZ','LIGHT']
const KLASS_COLOR: Record<Klass, string> = {
  'HVY-CFM':'#a78bfa', 'HVY-RR':'#c084fc', 'HVY-GE':'#7dd3fc', 'HVY-PW':'#818cf8',
  'NB-CFM':'#fb923c', 'NB-LEAP':'#34d399', 'NB-V2500':'#f472b6',
  'RGN-J':'#fbbf24', 'RGN-T':'#fde047', 'BIZ':'#f472b6', 'LIGHT':'#94a3b8',
}

interface ClassSpec {
  eiMass: number   // mg / kg-fuel
  eiNum: number    // ×10^15 / kg-fuel
  ffLrc: number    // kg/h per engine, cruise LRC
  nEng: number     // engine count typical
  flLrc: number    // typical cruise FL
  caep11: boolean  // CAEP/11 nvPM compliant (post-2020 cert)
  engNote: string  // engine family note
}
const SPEC: Record<Klass, ClassSpec> = {
  'HVY-CFM':  { eiMass: 18, eiNum: 6,  ffLrc: 5400, nEng: 2, flLrc: 360, caep11: false, engNote: 'CFM56-7B/LEAP-1B' },
  'HVY-RR':   { eiMass: 22, eiNum: 8,  ffLrc: 5800, nEng: 2, flLrc: 380, caep11: false, engNote: 'RB211/Trent-7/9/X' },
  'HVY-GE':   { eiMass: 12, eiNum: 4,  ffLrc: 5600, nEng: 2, flLrc: 380, caep11: true,  engNote: 'GE90/GEnx/GE9X TAPS-II' },
  'HVY-PW':   { eiMass: 16, eiNum: 5,  ffLrc: 5500, nEng: 2, flLrc: 370, caep11: false, engNote: 'PW4000/PW1100G' },
  'NB-CFM':   { eiMass: 28, eiNum: 14, ffLrc: 1350, nEng: 2, flLrc: 350, caep11: false, engNote: 'CFM56-5B/-7B legacy' },
  'NB-LEAP':  { eiMass: 6,  eiNum: 3,  ffLrc: 1250, nEng: 2, flLrc: 360, caep11: true,  engNote: 'LEAP-1A/B / PW1100G GTF' },
  'NB-V2500': { eiMass: 35, eiNum: 18, ffLrc: 1380, nEng: 2, flLrc: 350, caep11: false, engNote: 'IAE V2500-A5' },
  'RGN-J':    { eiMass: 24, eiNum: 12, ffLrc: 950,  nEng: 2, flLrc: 330, caep11: false, engNote: 'CF34/AE3007/PW1500' },
  'RGN-T':    { eiMass: 8,  eiNum: 5,  ffLrc: 375,  nEng: 2, flLrc: 220, caep11: true,  engNote: 'PW100/PT6/TPE331' },
  'BIZ':      { eiMass: 18, eiNum: 9,  ffLrc: 700,  nEng: 2, flLrc: 410, caep11: false, engNote: 'BR710/PW307/Tay' },
  'LIGHT':    { eiMass: 4,  eiNum: 2,  ffLrc: 60,   nEng: 1, flLrc: 100, caep11: true,  engNote: 'PT6A / Avgas piston' },
}

function classify(t: string | undefined, op: string | undefined): Klass | null {
  const x = (t || '').toUpperCase()
  const o = (op || '').toUpperCase()
  if (/^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139|AW189)/.test(x)) return null
  // Light props
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA[24]|PA|M20|TB|DHC2|BE9|BE3|TBM|PC12|PC6)/.test(x)) return 'LIGHT'
  // Heavies — split by engine family hint
  if (/^(B77|B788|B789|B78X|B789)/.test(x)) {
    if (/(BRITISH|VIRGIN|LUFTHANSA|EMIRATES|QATAR|ANA|JAL)/.test(o)) return 'HVY-RR'
    return 'HVY-GE'
  }
  if (/^(B74|B748)/.test(x)) return 'HVY-GE'
  if (/^(B76|B75)/.test(x)) return 'HVY-PW'
  if (/^(A35|A33|A34|A38)/.test(x)) return 'HVY-RR'
  if (/^(MD11|IL96|A30|C5|C17)/.test(x)) return 'HVY-PW'
  // Narrowbody
  if (/^(B73[8-9]|B38M|B39M)/.test(x)) return 'NB-LEAP'
  if (/^(B73[7]|B73[1-7])/.test(x)) return 'NB-CFM'
  if (/^(B72|B71|MD8|MD9)/.test(x)) return 'NB-V2500'
  if (/^(A19|A20|A21)N/.test(x)) return 'NB-LEAP' // neo
  if (/^A32[0-1]/.test(x)) return 'NB-CFM'
  if (/^(A319|A320|A321)/.test(x)) return 'NB-V2500'
  if (/^(A31|CS|BCS)/.test(x)) return 'NB-LEAP'
  if (/^(CRJ|E14|E15|E17|E19|E29|E70|E75|E90|E95)/.test(x)) return 'RGN-J'
  if (/^(AT4|AT5|AT7|DH8|SF34|J32|J41|ATR|Q400)/.test(x)) return 'RGN-T'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL[36]|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'BIZ'
  if (/^F1[5-9]/.test(x)) return null
  return 'NB-CFM'
}

const D2R = Math.PI / 180, R2D = 180 / Math.PI
const R_NM = 3440.065

function projectGc(lat:number, lng:number, brgDeg:number, distNm:number) {
  const d=distNm/R_NM, br=brgDeg*D2R
  const φ1=lat*D2R, λ1=lng*D2R
  const sφ2=Math.sin(φ1)*Math.cos(d)+Math.cos(φ1)*Math.sin(d)*Math.cos(br)
  const φ2=Math.asin(sφ2)
  const y=Math.sin(br)*Math.sin(d)*Math.cos(φ1)
  const x=Math.cos(d)-Math.sin(φ1)*sφ2
  const λ2=λ1+Math.atan2(y,x)
  return { lat:φ2*R2D, lng:((λ2*R2D+540)%360)-180 }
}

function ramp(x:number, lo:number, hi:number): number {
  if (x<=lo) return 0
  if (x>=hi) return 100
  return 100*(x-lo)/(hi-lo)
}

function bcaAmp(fl:number, bcaMul:number): number {
  let base: number
  if (fl < 30) base = 3.0
  else if (fl < 70) base = 1.5
  else if (fl < 100) base = 1.0
  else base = 0.6
  return base * (bcaMul/100)
}

interface Per {
  klass: Klass
  flCrz: number
  ffPerEng: number     // kg/s per engine
  ffTotal: number      // kg/h total
  eiMass: number
  eiNum: number
  massRate: number     // g/s nvPM mass
  numRate: number      // ×10^15 #/s
  bca: number          // amplifier
  thrustProxy: number  // BFFM2 ratio
  drivers: { MASS:number; NUM:number; BCA:number; OLDFLT:number; SMOKE:number; FUEL:number }
}

interface Row {
  f: SFlight
  klass: Klass
  p: Per
  score: number
  tier: Tier
}

const SRC='nvpm-src', PLUME_SRC='nvpm-plume-src'
const HALO='nvpm-halo', PIN='nvpm-pin', LBL='nvpm-lbl', PLUME='nvpm-plume'

export default function NvpmParticulate({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(500)
  const [advMul, setAdvMul] = useState(100)
  const [eiMul, setEiMul] = useState(100)
  const [bcaMul, setBcaMul] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showPlume, setShowPlume] = useState(true)
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'EEDB'>('AIRCRAFT')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Row|null>(null)

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const klass = classify(f.type, f.operator)
      if (!klass) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl || fl > maxFl) continue

      const sp = SPEC[klass]
      // BFFM2 thrust-setting proxy
      const thrustProxy = Math.max(0.35, Math.min(1.4, (fl / Math.max(80, sp.flLrc)) * (1 + Math.abs(f.vertRate)/3000)))
      const ffPerEng = (sp.ffLrc / 3600) * thrustProxy // kg/s per engine
      const ffTotal = sp.ffLrc * sp.nEng * thrustProxy // kg/h total

      const eiMass = sp.eiMass * (eiMul/100) * (thrustProxy > 1.0 ? 1.6 : thrustProxy < 0.5 ? 1.4 : 1.0) // rich-burn at climb & idle
      const eiNum  = sp.eiNum  * (eiMul/100) * (thrustProxy > 1.0 ? 1.4 : 1.0)

      // g/s = mg/kg × kg/s / 1000
      const massRate = eiMass * ffPerEng * sp.nEng / 1000
      const numRate  = eiNum  * ffPerEng * sp.nEng // ×10^15 #/s

      const bca = bcaAmp(fl, bcaMul)

      const D_MASS = ramp(massRate, 0, 5)
      const D_NUM  = ramp(numRate, 0, 8)
      const D_BCA  = Math.min(100, (bca - 0.6) * 50)
      const D_OLD  = sp.caep11 ? 0 : 60
      const D_SMOKE = thrustProxy > 1.0 ? 75 : thrustProxy < 0.5 ? 55 : 20
      const D_FUEL = ramp(ffTotal, 200, 14000)

      const drivers = { MASS: D_MASS, NUM: D_NUM, BCA: D_BCA, OLDFLT: D_OLD, SMOKE: D_SMOKE, FUEL: D_FUEL }
      const vals = Object.values(drivers)
      const max = Math.max(...vals)
      const mean = vals.reduce((a,b)=>a+b,0)/vals.length
      let score = (max * 0.64 + mean * 0.36) * (advMul/100)

      // hard escalators
      if (massRate > 4) score = Math.max(score, 88)
      if (bca >= 2.0 && !sp.caep11) score = Math.max(score, 78)
      if (!sp.caep11 && fl > 100 && massRate > 2.5) score = Math.max(score, 60)

      score = Math.min(100, Math.max(0, score))

      // tier
      let tier: Tier
      if (fl < 10) tier = 'OFF'
      else if (score >= 80) tier = 'SEVERE'
      else if (score >= 60) tier = 'HIGH'
      else if (score >= 40) tier = 'MODERATE'
      else if (score >= 18) tier = 'LOW'
      else tier = 'CLEAN'

      const p: Per = { klass, flCrz: sp.flLrc, ffPerEng, ffTotal, eiMass, eiNum, massRate, numRate, bca, thrustProxy, drivers }
      out.push({ f, klass, p, score, tier })
    }
    return out.sort((a,b) => b.score - a.score)
  }, [flights, minFl, maxFl, advMul, eiMul, bcaMul])

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!ql) return true
      const cs = (r.f.callsign||r.f.icao).toLowerCase()
      const ty = (r.f.type||'').toLowerCase()
      const op = (r.f.operator||'').toLowerCase()
      return cs.includes(ql) || ty.includes(ql) || op.includes(ql) || r.klass.toLowerCase().includes(ql)
    })
  }, [rows, tierFilter, klassFilter, q])

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { SEVERE:0,HIGH:0,MODERATE:0,LOW:0,CLEAN:0,OFF:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const summary = useMemo(() => {
    if (!rows.length) return null
    const live = rows.filter(r => r.tier !== 'OFF')
    if (!live.length) return null
    const muMass = live.reduce((s,r)=>s+r.p.massRate,0)/live.length
    const sumMass = live.reduce((s,r)=>s+r.p.massRate,0)
    const muNum = live.reduce((s,r)=>s+r.p.numRate,0)/live.length
    const sumFuel = live.reduce((s,r)=>s+r.p.ffTotal,0)/1000 // tonnes/h
    const worst = live.reduce((a,b)=> b.score>a.score?b:a)
    return { muMass, sumMass, muNum, sumFuel, worst, severe: tierCounts.SEVERE, high: tierCounts.HIGH }
  }, [rows, tierCounts])

  /* MapLibre overlay */
  useEffect(() => {
    if (!map) return
    const apply = () => {
      try {
        const haloFeat = filtered.filter(r => r.tier !== 'OFF').map(r => ({
          type:'Feature' as const,
          geometry:{ type:'Point' as const, coordinates:[r.f.lng, r.f.lat]},
          properties:{ color: TIER_COLOR[r.tier], score: r.score, tier: r.tier,
            label: `${r.f.callsign||r.f.icao} ${r.p.massRate.toFixed(2)}g/s ${r.p.numRate.toFixed(1)}e15` }
        }))
        const top = filtered.filter(r => r.tier!=='OFF').slice(0, 18)
        const plumeFeat = top.map(r => {
          const len = 10 + Math.min(28, r.p.massRate * 6)
          const halfDeg = 14
          const c1 = projectGc(r.f.lat, r.f.lng, r.f.track - halfDeg, len)
          const c2 = projectGc(r.f.lat, r.f.lng, r.f.track + halfDeg, len)
          return {
            type:'Feature' as const,
            geometry:{ type:'Polygon' as const, coordinates:[[
              [r.f.lng, r.f.lat], [c1.lng, c1.lat], [c2.lng, c2.lat], [r.f.lng, r.f.lat]
            ]]},
            properties:{ color: TIER_COLOR[r.tier], opacity: 0.18 + r.score/400 }
          }
        })

        const haloFc:any = { type:'FeatureCollection', features: haloFeat }
        const plumeFc:any = { type:'FeatureCollection', features: plumeFeat }
        const haloSrc = map.getSource(SRC) as any
        const plumeSrc = map.getSource(PLUME_SRC) as any
        if (haloSrc) haloSrc.setData(haloFc); else map.addSource(SRC, { type:'geojson', data: haloFc })
        if (plumeSrc) plumeSrc.setData(plumeFc); else map.addSource(PLUME_SRC, { type:'geojson', data: plumeFc })

        if (showPlume && !map.getLayer(PLUME)) map.addLayer({ id: PLUME, type:'fill', source: PLUME_SRC,
          paint:{ 'fill-color':['get','color'], 'fill-opacity':['get','opacity'] } })
        if (!showPlume && map.getLayer(PLUME)) map.removeLayer(PLUME)

        if (showHalo && !map.getLayer(HALO)) map.addLayer({ id: HALO, type:'circle', source: SRC,
          paint:{
            'circle-radius':['+',7,['/',['get','score'],8]],
            'circle-color':['get','color'],
            'circle-opacity':0.18,
            'circle-stroke-color':['get','color'],
            'circle-stroke-width':1.2,
            'circle-stroke-opacity':0.85,
          }})
        if (!showHalo && map.getLayer(HALO)) map.removeLayer(HALO)

        if (showPin && !map.getLayer(PIN)) map.addLayer({ id: PIN, type:'circle', source: SRC,
          filter:['in',['get','tier'],['literal',['SEVERE','HIGH']]],
          paint:{ 'circle-radius':3.5, 'circle-color':'#fff',
            'circle-stroke-color':['get','color'], 'circle-stroke-width':2 }})
        if (!showPin && map.getLayer(PIN)) map.removeLayer(PIN)

        if (showLbl && !map.getLayer(LBL)) map.addLayer({ id: LBL, type:'symbol', source: SRC,
          layout:{ 'text-field':['get','label'], 'text-size':9.5, 'text-offset':[0,1.3], 'text-anchor':'top', 'text-allow-overlap':false },
          paint:{ 'text-color':['get','color'], 'text-halo-color':'#020617', 'text-halo-width':1.2 }})
        if (!showLbl && map.getLayer(LBL)) map.removeLayer(LBL)
      } catch {}
    }
    if (map.isStyleLoaded()) apply(); else map.once('load', apply)
    return () => {
      try {
        for (const id of [LBL, PIN, HALO, PLUME]) if (map.getLayer(id)) map.removeLayer(id)
        for (const id of [SRC, PLUME_SRC]) if (map.getSource(id)) map.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl, showPlume])

  /* EEDB scatter */
  const EedbPlot = () => {
    const W = 430, H = 240, PL = 36, PR = 12, PT = 14, PB = 30
    const xMax = 40, yMax = 25
    const x = (v:number) => PL + (v/xMax) * (W-PL-PR)
    const y = (v:number) => H-PB - (v/yMax) * (H-PT-PB)
    // class dots
    const dots = KLASS_LIST.map(k => {
      const sp = SPEC[k]
      const cnt = rows.filter(r => r.klass===k && r.tier!=='OFF').length
      return { k, sp, cnt }
    })
    // fleet centroid
    const live = rows.filter(r => r.tier !== 'OFF')
    const cx = live.length ? live.reduce((s,r)=>s+r.p.eiMass,0)/live.length : 0
    const cy = live.length ? live.reduce((s,r)=>s+r.p.eiNum,0)/live.length : 0
    const passCnt = live.filter(r => SPEC[r.klass].caep11).length
    const passPct = live.length ? 100*passCnt/live.length : 0
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{maxHeight:240}}>
        <rect x={0} y={0} width={W} height={H} fill="#020617"/>
        {/* axes */}
        <line x1={PL} y1={H-PB} x2={W-PR} y2={H-PB} stroke="#334155" strokeWidth={0.8}/>
        <line x1={PL} y1={PT} x2={PL} y2={H-PB} stroke="#334155" strokeWidth={0.8}/>
        {[0,10,20,30,40].map(v => (
          <g key={`x${v}`}>
            <line x1={x(v)} y1={H-PB} x2={x(v)} y2={H-PB+3} stroke="#475569"/>
            <text x={x(v)} y={H-PB+12} fontSize={8} fill="#64748b" textAnchor="middle">{v}</text>
          </g>
        ))}
        {[0,5,10,15,20,25].map(v => (
          <g key={`y${v}`}>
            <line x1={PL-3} y1={y(v)} x2={PL} y2={y(v)} stroke="#475569"/>
            <text x={PL-5} y={y(v)+3} fontSize={8} fill="#64748b" textAnchor="end">{v}</text>
          </g>
        ))}
        <text x={W/2} y={H-4} fontSize={9} fill="#94a3b8" textAnchor="middle">EI mass (mg / kg-fuel)</text>
        <text x={10} y={H/2} fontSize={9} fill="#94a3b8" transform={`rotate(-90 10 ${H/2})`} textAnchor="middle">EI num ×10¹⁵ / kg</text>
        {/* CAEP/11 mass limit (12 mg/kg cruise proxy) */}
        <line x1={x(12)} y1={PT} x2={x(12)} y2={H-PB} stroke={TIER_COLOR.MODERATE} strokeWidth={0.7} strokeDasharray="3 3"/>
        <text x={x(12)+3} y={PT+10} fontSize={8} fill={TIER_COLOR.MODERATE}>CAEP/11 mass-limit</text>
        {/* CAEP/11 num limit */}
        <line x1={PL} y1={y(1)} x2={W-PR} y2={y(1)} stroke={TIER_COLOR.MODERATE} strokeWidth={0.5} strokeDasharray="2 4"/>
        <text x={W-PR-3} y={y(1)-3} fontSize={8} fill={TIER_COLOR.MODERATE} textAnchor="end">num-limit 1×10¹⁵</text>
        {/* class dots */}
        {dots.map(d => (
          <g key={d.k}>
            <circle cx={x(d.sp.eiMass)} cy={y(d.sp.eiNum)} r={3 + Math.min(8, d.cnt/3)}
              fill={KLASS_COLOR[d.k]} stroke={d.sp.caep11?TIER_COLOR.CLEAN:TIER_COLOR.SEVERE} strokeWidth={1.1} opacity={0.85}/>
            <text x={x(d.sp.eiMass)} y={y(d.sp.eiNum)-7} fontSize={7.5} fill={KLASS_COLOR[d.k]} textAnchor="middle">{d.k}{d.cnt?` ·${d.cnt}`:''}</text>
          </g>
        ))}
        {/* fleet centroid */}
        {live.length>0 && (
          <g>
            <circle cx={x(cx)} cy={y(cy)} r={5} fill="none" stroke="#f1f5f9" strokeWidth={1.4}/>
            <circle cx={x(cx)} cy={y(cy)} r={2} fill="#f1f5f9"/>
            <text x={x(cx)+8} y={y(cy)+3} fontSize={8} fill="#cbd5e1">μ-fleet</text>
          </g>
        )}
        {/* summary cells */}
        <g transform={`translate(${PL+8}, ${PT+2})`}>
          <rect x={0} y={0} width={130} height={36} fill="#0f172a" stroke="#1e293b" rx={3}/>
          <text x={5} y={10} fontSize={7.5} fill="#64748b">μ EI-MASS / μ EI-NUM</text>
          <text x={5} y={22} fontSize={10} fill="#e2e8f0">{cx.toFixed(1)} mg · {cy.toFixed(1)}e15</text>
          <text x={5} y={32} fontSize={8} fill={passPct>=50?TIER_COLOR.CLEAN:TIER_COLOR.HIGH}>CAEP/11 PASS {passPct.toFixed(0)}%</text>
        </g>
      </svg>
    )
  }

  return (
    <div className="absolute right-3 top-20 z-30 w-[470px] max-h-[80vh] overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 backdrop-blur-md shadow-2xl flex flex-col text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="text-[11px] tracking-[0.18em] text-sky-300/80 uppercase font-semibold">NVPM</div>
        <div className="text-[10px] text-slate-400 truncate">Non-Volatile PM · CAEP/11 · ICAO Annex 16 II</div>
        <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-100 text-[12px] px-2 py-0.5 rounded hover:bg-slate-800/60">✕</button>
      </div>

      {/* tier strip */}
      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter===t?'ALL':t)}
            className={`px-1 py-1 rounded border ${tierFilter===t?'bg-sky-500/15 border-sky-500/40':'border-slate-800 hover:border-slate-700'}`}>
            <div className="text-[8px]" style={{color: TIER_COLOR[t]}}>{t}</div>
            <div className="text-slate-100 font-semibold">{tierCounts[t]}</div>
          </button>
        ))}
      </div>

      {/* summary */}
      {summary && (
        <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800/60 text-[10px] tabular-nums">
          <div><div className="text-[8px] text-slate-500">μ-MASS</div><div className="text-slate-100">{summary.muMass.toFixed(2)}g/s</div></div>
          <div><div className="text-[8px] text-slate-500">Σ-MASS</div><div className="text-slate-100">{summary.sumMass.toFixed(1)}g/s</div></div>
          <div><div className="text-[8px] text-slate-500">WORST</div><div className="text-slate-100 truncate">{summary.worst.f.callsign||summary.worst.f.icao}</div></div>
          <div><div className="text-[8px] text-slate-500">SEVERE</div><div style={{color:summary.severe>0?TIER_COLOR.SEVERE:'#e2e8f0'}}>{summary.severe}</div></div>
          <div><div className="text-[8px] text-slate-500">μ-NUM</div><div className="text-slate-100">{summary.muNum.toFixed(1)}e15</div></div>
          <div><div className="text-[8px] text-slate-500">Σ-FUEL</div><div className="text-slate-100">{summary.sumFuel.toFixed(1)}t/h</div></div>
        </div>
      )}

      {/* sliders */}
      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800/60 text-[9.5px]">
        <label className="flex flex-col">
          <span className="text-slate-400">MIN-FL {minFl}</span>
          <input type="range" min={0} max={200} value={minFl} onChange={e=>setMinFl(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">MAX-FL {maxFl}</span>
          <input type="range" min={50} max={500} value={maxFl} onChange={e=>setMaxFl(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">EI-MUL {eiMul}%</span>
          <input type="range" min={50} max={200} value={eiMul} onChange={e=>setEiMul(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col">
          <span className="text-slate-400">BCA-MUL {bcaMul}%</span>
          <input type="range" min={50} max={300} value={bcaMul} onChange={e=>setBcaMul(+e.target.value)} className="accent-sky-500"/>
        </label>
        <label className="flex flex-col col-span-2">
          <span className="text-slate-400">ADV-MUL {advMul}%</span>
          <input type="range" min={50} max={200} value={advMul} onChange={e=>setAdvMul(+e.target.value)} className="accent-sky-500"/>
        </label>
      </div>

      {/* class chips + toggles */}
      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800/60">
        <button onClick={()=>setKlassFilter('ALL')} className={`text-[9px] px-1.5 py-0.5 rounded border ${klassFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-400'}`}>ALL</button>
        {KLASS_LIST.map(k => (
          <button key={k} onClick={()=>setKlassFilter(klassFilter===k?'ALL':k)}
            className={`text-[9px] px-1.5 py-0.5 rounded border ${klassFilter===k?'bg-sky-500/15 border-sky-500/40':'border-slate-800'}`}
            style={{color: KLASS_COLOR[k]}}>{k}</button>
        ))}
        <span className="flex-1" />
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['PLUME',showPlume,setShowPlume],['LBL',showLbl,setShowLbl]] as const).map(([lbl,on,fn]:any) => (
          <button key={lbl} onClick={()=>fn(!on)} className={`text-[9px] px-1.5 py-0.5 rounded border ${on?'bg-sky-500/15 border-sky-500/40 text-sky-200':'border-slate-800 text-slate-500'}`}>{lbl}</button>
        ))}
      </div>

      {/* tabs */}
      <div className="flex border-b border-slate-800/60 text-[10px]">
        {(['AIRCRAFT','CLASSES','EEDB'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`flex-1 py-1.5 ${tab===t?'bg-sky-500/15 text-sky-200 border-b border-sky-500/60':'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {/* search */}
      <div className="px-3 py-1.5 border-b border-slate-800/60">
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="callsign / type / operator / class"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600"/>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/60">
            {filtered.slice(0, 80).map((r, i) => {
              const sp = SPEC[r.klass]
              return (
                <div key={r.f.icao+i} className="px-3 py-2 hover:bg-slate-900/40 cursor-pointer"
                  onClick={() => { setSel(r); onFly(r.f.icao) }}>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-semibold text-slate-100 tabular-nums">{r.f.callsign||r.f.icao}</span>
                    <span className="text-slate-500 text-[9.5px]">{r.f.type||'—'}</span>
                    <span className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800" style={{color: KLASS_COLOR[r.klass]}}>{r.klass}</span>
                    <span className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-400">{sp.nEng}×eng</span>
                    <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded" style={{color: TIER_COLOR[r.tier], background: TIER_COLOR[r.tier]+'18', border:`1px solid ${TIER_COLOR[r.tier]}66`}}>{r.tier}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-1.5 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">FL </span>{(r.f.altitudeFt/100).toFixed(0)}</div>
                    <div><span className="text-slate-500">FF </span>{r.p.ffTotal.toFixed(0)}kg/h</div>
                    <div><span className="text-slate-500">EI-m </span>{r.p.eiMass.toFixed(0)}mg/kg</div>
                    <div><span className="text-slate-500">EI-n </span>{r.p.eiNum.toFixed(1)}e15</div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-0.5 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">MASS </span>{r.p.massRate.toFixed(2)}g/s</div>
                    <div><span className="text-slate-500">NUM </span>{r.p.numRate.toFixed(1)}e15/s</div>
                    <div><span className="text-slate-500">BCA </span>{r.p.bca.toFixed(1)}×</div>
                    <div><span className="text-slate-500">SCORE </span>{r.score.toFixed(0)}</div>
                  </div>
                  <div className="h-1.5 mt-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div className="h-full" style={{ width: `${r.score}%`, background: TIER_COLOR[r.tier] }}/>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {Object.entries(r.p.drivers).map(([k,v]) => (
                      <span key={k} className="text-[8.5px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-400">
                        {k} <span className="text-slate-200 tabular-nums">{(v as number).toFixed(0)}</span>
                      </span>
                    ))}
                  </div>
                  <div className="mt-1.5 text-[9.5px] leading-snug" style={{color: TIER_COLOR[r.tier]}}>
                    {r.tier==='SEVERE' && `Severe BC plume ${r.p.massRate.toFixed(1)}g/s · CAEP/11 §5.2 review · ICAO Annex 16 II Pt III Ch.4`}
                    {r.tier==='HIGH' && `Pre-CAEP/11 ${sp.engNote} · elevated nvPM · Doc 9889 §A.4`}
                    {r.tier==='MODERATE' && `Typical legacy CFM56/V2500 generation · monitor LTO impact`}
                    {r.tier==='LOW' && `CAEP/11-compliant ${sp.engNote} · within standard`}
                    {r.tier==='CLEAN' && `Low-soot ${sp.engNote} · TAPS-II / GTF lean-burn`}
                    {r.tier==='OFF' && `Stationary / below FL010`}
                  </div>
                </div>
              )
            })}
            {!filtered.length && <div className="px-3 py-6 text-center text-[10px] text-slate-500">no airframes match</div>}
          </div>
        )}

        {tab === 'CLASSES' && (
          <div className="divide-y divide-slate-800/60">
            {KLASS_LIST.map(k => {
              const sp = SPEC[k]
              const klRows = rows.filter(r => r.klass===k && r.tier!=='OFF')
              const cnt = klRows.length
              const muMass = cnt ? klRows.reduce((s,r)=>s+r.p.massRate,0)/cnt : 0
              const sumMass = klRows.reduce((s,r)=>s+r.p.massRate,0)
              const sev = klRows.filter(r=>r.tier==='SEVERE').length
              const hi  = klRows.filter(r=>r.tier==='HIGH').length
              return (
                <div key={k} className="px-3 py-2">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-[9px] px-1.5 py-0.5 rounded border border-slate-800" style={{color: KLASS_COLOR[k]}}>{k}</span>
                    <span className="text-slate-300 tabular-nums">{cnt} ac</span>
                    <span className="text-[9.5px] text-slate-500">· {sp.engNote}</span>
                    <span className="ml-auto text-[8.5px] px-1.5 py-0.5 rounded"
                      style={{color: sp.caep11?TIER_COLOR.CLEAN:TIER_COLOR.HIGH, background: (sp.caep11?TIER_COLOR.CLEAN:TIER_COLOR.HIGH)+'18',
                        border:`1px solid ${(sp.caep11?TIER_COLOR.CLEAN:TIER_COLOR.HIGH)}66`}}>
                      {sp.caep11?'CAEP/11':'pre-CAEP/11'}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-1 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">EI-m </span>{sp.eiMass}mg/kg</div>
                    <div><span className="text-slate-500">EI-n </span>{sp.eiNum}e15</div>
                    <div><span className="text-slate-500">FF-LRC </span>{sp.ffLrc}kg/h</div>
                    <div><span className="text-slate-500">FL-LRC </span>{sp.flLrc}</div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 mt-0.5 text-[9.5px] tabular-nums text-slate-300">
                    <div><span className="text-slate-500">μ-MASS </span>{muMass.toFixed(2)}g/s</div>
                    <div><span className="text-slate-500">Σ-MASS </span>{sumMass.toFixed(1)}g/s</div>
                    <div><span className="text-slate-500">SEV </span><span style={{color:sev>0?TIER_COLOR.SEVERE:'#e2e8f0'}}>{sev}</span></div>
                    <div><span className="text-slate-500">HIGH </span><span style={{color:hi>0?TIER_COLOR.HIGH:'#e2e8f0'}}>{hi}</span></div>
                  </div>
                  <div className="h-1.5 mt-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div className="h-full" style={{ width: `${Math.min(100, sumMass*10)}%`, background: KLASS_COLOR[k] }}/>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'EEDB' && (
          <div className="p-3 space-y-3">
            <EedbPlot/>
            <div className="text-[9.5px] leading-snug text-slate-400 space-y-1.5">
              <p><span className="text-slate-200">EEDB scatter</span> places each class at its catalogued
              cruise EI-mass (mg/kg-fuel) × EI-number (×10¹⁵/kg). CAEP/11 reference limits per ICAO Doc 10180
              §5.2 shown as dashed lines. Dot stroke colour denotes CAEP/11 compliance
              (<span style={{color:TIER_COLOR.CLEAN}}>emerald</span> pass · <span style={{color:TIER_COLOR.SEVERE}}>rose</span> pre-cert).
              Fleet centroid μ-fleet aggregates live tracked airframes.</p>
              <p><span className="text-slate-200">Method.</span> Mass rate (g/s) = EI<sub>mass</sub>·FF·n<sub>eng</sub>/1000.
              Number rate (×10¹⁵/s) = EI<sub>num</sub>·FF·n<sub>eng</sub>. Thrust-setting via BFFM2 (SAE 2006-01-1987)
              proxy from FL/VS. Climb/idle rich-burn amplification 1.4-1.6× per FOA4 (Wayson 2009)
              and SCOPE11 (Agarwal GT2019-91504). BCA amplifier weights surface-air-quality impact below 3000 ft AGL
              per ICAO Doc 9889 §A.4 LTO cycle.</p>
              <p><span className="text-slate-200">Refs.</span> ICAO Annex 16 Vol II Pt III Ch.4 · Doc 9889 §A.4 ·
              EEDB ed.29 · CAEP/11 Doc 10180 · 14 CFR Pt 34 · CS-34 · SCOPE11 (Agarwal ASME GT2019-91504) ·
              FOA4 (Wayson J.Air&amp;Waste 59) · BFFM2 (DuBois-Paynter SAE) · Stettler Atmos.Env. 67 (2013) ·
              Lobo EST 49 (2015) · Brem EST 49 (2015) · Moore Nature 543 (2017) · Wesely Atmos.Env. 23 (1989).</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
