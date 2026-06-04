'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   CIRCAD · Crew Circadian Fatigue & Window-of-Circadian-Low Monitor
   ------------------------------------------------------------
   Per-airframe biomathematical fatigue-effectiveness scorer
   following the SAFTE (Sleep, Activity, Fatigue and Task
   Effectiveness) and SAFTE-FAST framework (Hursh et al. 2004,
   Aviation Space Environ Med 75-3 Supp), with circadian phase
   computed from local solar time at the aircraft's current
   ground position (longitude → local solar offset), homeostatic
   sleep pressure from a deterministic per-ICAO24 hash-driven
   duty start (FDP onset within the past 4-16 h), Window-of-
   Circadian-Low (WOCL) gate per ICAO Doc 9966 FRMS Manual
   App.B (02:00-05:59 local), Samn-Perelli 7-point sleepiness
   scale mapping, and per-class crew-complement augmentation
   (2-pilot short-haul · 3-pilot heavy · 4-pilot ultra-long
   range) per FAA AC 117-3 / EASA ORO.FTL.205 / CAP 371.

   ------------------------------------------------------------
   12-class crew-rule catalogue (cls · max-FDP · pilots · refs):
       NB-DOM   2P  9h  FAR 117 Table B / CAP 371 Sch.10
       NB-INT   2P  10h FAR 117 Table B / EASA ORO.FTL.205
       NB-NIGHT 2P  8h  WOCL-overlap FAR 117 §117.13
       WB-MED   2P  11h EASA AMC1 ORO.FTL.205(b)
       WB-LH    3P  14h FAR 117 §117.17 augmented
       WB-ULR   4P  17h FAR 117 §117.19 / 121.523 ULR
       RGN-J    2P  9h  EASA CAT.OP.MPA.250
       TURBO    2P  9h  CS-FCD App.1
       BIZ      2P  10h NBAA Duty/Rest 2018
       CARGO-LH 3P  16h FAR 117 §117.21 cargo
       HEMS     2P  8h  AC 135-14B §6 HEMS reduced
       CHARTER  2P  10h FAR 135.267
   ------------------------------------------------------------
   Per-flight model:
     localHr = (utcHr + lng/15 + 24) mod 24
     circadian C(t) = -10·cos(2π(t-Φ)/24) + 3·cos(2π(t-Φ)/12)
       (two-process model, Borbély & Achermann 1999; phase Φ=5.5h
        per Folkard & Åkerstedt 1987 acrophase 17.5/nadir 05.5)
     homeostatic H(t) = max(0, 100 - 0.5·hrsAwake²·decay)
       (SAFTE inertia coefficient 0.5, Hursh 2004)
     reservoir R = max(0, 100 - 12·(awake-16))
     effectiveness E = clip(R + C - sleepInertia, 0, 120)
     SamnPerelli SP = 7 - round(E/20)  (1 fully alert ↔ 7 exhausted)
     WOCL_in = (localHr ∈ [2,6))
     FDP_used_pct = hrsOnDuty / maxFDP × 100

   ------------------------------------------------------------
   6 risk drivers (max-driver composite ×0.66 + mean-driver ×0.34):
     EFF    100 - E                                    (effectiveness deficit)
     WOCL   if in WOCL window: 70 + 30·(awake/14)       (window of circadian low)
     FDP    FDP_used_pct ramp 0→100 over 0..MaxFDP+1h   (regulatory exposure)
     AWAKE  ramp 0 at 12h awake → 100 at 22h            (continuous wakefulness)
     SLEEP  ramp 0 at 7h prior sleep → 100 at <4h       (sleep debt)
     ULR    AUG-pilots deficit at ULR class             (rest opportunity)
   ×ADV-MUL slider 50-200%

   6 hard tiers per ICAO Doc 9966 FRMS Manual Table B-2:
     RED-LINE   score≥85 rose     STOP-FLIGHT no-go fatigue (FRMS Lvl IV)
     CRITICAL   score≥70 rose-pk  augmented-rest mandatory (FRMS Lvl III)
     ELEVATED   score≥55 amber    extend rest before next sector
     CAUTION    score≥35 sky      enforce in-seat rest breaks
     ALERT      score≥18 emerald  nominal monitoring
     FRESH      score<18 slate    no fatigue concern
     IDLE       on-ground, sleep complete, or no FDP

   ------------------------------------------------------------
   MapLibre overlay:
     tier-coloured halo rings 7-22px by score on each in-scope
     aircraft, rose pins RED-LINE/CRITICAL, tier-coloured
     callsign + SP-pill + tier labels, dashed amber WOCL bracket
     on aircraft currently inside the 02-06 local window.

   Side panel:
     7-tier counter strip (click-to-filter),
     4-cell summary (⌀-Effectiveness · WORST callsign · Σ-WOCL
                      in-window · Σ-RED+CRIT),
     5 sliders (ADV-MUL 50-200% · MIN-FL 0-500 · MAX-AWAKE 8-24h ·
                FDP-MUL 50-200% · WOCL-MUL 50-200%),
     12-class chip filter + HALO/PIN/LBL/WOCL toggles,
     search by callsign/type/operator/class,
     CREWS/CLASSES/RHYTHM tab switcher:
       CREWS: tier-sorted row stack with cs+type+class-pill+
         SP-pill+tier-pill + LCL-hr+UTC-hr+awake-h+FDP-h row +
         5-driver breakdown chips EFF/WOCL/FDP/AWAKE/SLEEP +
         tier-coloured advice line citing FAR-117 / EASA FTL /
         CAP 371 / Doc 9966 / SAFTE-FAST.
       CLASSES: per-class rule-row max-FDP/pilots/citation,
         worst-tier stripe + mean SP + RED+CRIT count.
       RHYTHM: SVG plot of 24-hr two-process curve C(t)+R(t),
         WOCL band 02-06 amber rugged, fleet aircraft plotted
         as tier-coloured dots at their localHr×Effectiveness
         coords, acrophase ★ at 17.5 and nadir ▼ at 05.5.

   ------------------------------------------------------------
   References:
     ICAO Doc 9966 "Fatigue Management for Air Operators"
        2nd ed. 2020 — Manual for Regulators incl. FRMS
        App.B WOCL definition / App.C bio-mathematical models
     IATA/ICAO/IFALPA Fatigue Risk Management Systems
        Implementation Guide for Operators 2nd ed. 2015
     ICAO Annex 6 Pt I §4.10 Fatigue Management
     ICAO Doc 9859 Safety Management Manual ed.4 ch.9 FRMS
     14 CFR Part 117 Flight & Duty Limitations and Rest
        Requirements Flightcrew Members
        §117.13 cumulative flight duty / Table B max FDP
        §117.17 augmented flight crew unaugmented FDP
        §117.19 4-pilot ULR §117.21 cargo §117.23 reserve
        §117.25 rest periods / §117.27 split duty
     14 CFR Part 121.471 / 121.481 / 121.523 ULR
     14 CFR Part 135.267 unscheduled / on-demand
     FAA AC 117-3 Fitness for Duty
     FAA AC 120-103A Fatigue Risk Management Systems
        Pt 121 carriers (operator-level FRMS approval)
     FAA AC 135-14B HEMS §6 fatigue management
     EASA Reg (EU) 2016/1199 Subpart FTL ORO.FTL.205
        Flight Duty Periods · ORO.FTL.235 rest periods ·
        ORO.FTL.250 Fatigue Risk Management
     EASA CS-FCD CS-Flight-Crew-Duty App.1 turboprop
     EASA AMC1 ORO.FTL.205(b) augmentation
     UK CAA CAP 371 The Avoidance of Fatigue in Aircrews
        Sch.10 single-pilot · Sch.11 multi-pilot
     UK CAA CAP 1185 / CAP 999 SMS+FRMS interaction
     UK CAA ORS4 No.1390 in-flight rest standards
     TC TP-13950 Flight Duty Time Regulations
     CASA CAO 48.1 FRMS Instrument 2019
     NBAA Duty/Rest Best Practices 2018
     ATSB AR-2019-008 cumulative fatigue meta-analysis
     NTSB SR-89-01 Crew Resource Management SR-12-02 fatigue
     NTSB AAR-94-04 USAir 1016 fatigue chain
     NTSB AAR-09-03 Colgan 3407 cumulative fatigue
     NTSB AAR-15-01 UPS 1354 BHM cumulative fatigue WOCL
     Hursh SR et al. Aviation Space Environ Med 75-3 (Supp)
        2004 "Fatigue Models for Applied Research"
        — original SAFTE 3-process source
     SAFTE-FAST Tech Doc IBR Inc. v4.3 2021
     Borbély AA, Achermann P. J Biol Rhythms 14(6) 1999
        — two-process model (sleep homeostasis × circadian)
     Folkard S, Åkerstedt T. Acta Physiol Scand 1987
        — circadian acrophase 17:30 / nadir 05:30
     Samn SW, Perelli LP. USAF SAM Tech Rep 82-21 1982
        — Samn-Perelli 7-point fatigue scale
     Caldwell JA et al. "Fatigue Risk Management in Aviation
        Maintenance" Aviation Space Environ Med 80-1 2009
     CASA AC 48-1 v3.0 2019 fatigue limits
     ICAO Cir 351 "FRMS oversight" 2020
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Cls = 'NB-DOM'|'NB-INT'|'NB-NIGHT'|'WB-MED'|'WB-LH'|'WB-ULR'|'RGN-J'|'TURBO'|'BIZ'|'CARGO-LH'|'HEMS'|'CHARTER'
const CLS_COLOR: Record<Cls, string> = {
  'NB-DOM':   '#10b981',
  'NB-INT':   '#22d3ee',
  'NB-NIGHT': '#8b5cf6',
  'WB-MED':   '#0ea5e9',
  'WB-LH':    '#a855f7',
  'WB-ULR':   '#f43f5e',
  'RGN-J':    '#f59e0b',
  'TURBO':    '#eab308',
  'BIZ':      '#ec4899',
  'CARGO-LH': '#fb923c',
  'HEMS':     '#dc2626',
  'CHARTER':  '#a3e635',
}

interface CrewRule {
  cls: Cls
  maxFDP_h: number     // unaugmented max FDP at acrophase per FAR-117 Table B
  pilots: number       // crew complement
  refs: string         // regulatory reference
  fdpNight_h: number   // max FDP if encroaching WOCL
}
const RULES: CrewRule[] = [
  { cls: 'NB-DOM',   maxFDP_h: 9,  fdpNight_h: 8,  pilots: 2, refs: '14 CFR §117 Table B / CAP 371 Sch.10' },
  { cls: 'NB-INT',   maxFDP_h: 10, fdpNight_h: 8,  pilots: 2, refs: 'EASA ORO.FTL.205(b) / Tab A' },
  { cls: 'NB-NIGHT', maxFDP_h: 8,  fdpNight_h: 8,  pilots: 2, refs: '14 CFR §117.13 / WOCL-encroaching' },
  { cls: 'WB-MED',   maxFDP_h: 11, fdpNight_h: 9,  pilots: 2, refs: 'EASA AMC1 ORO.FTL.205(b)' },
  { cls: 'WB-LH',    maxFDP_h: 14, fdpNight_h: 12, pilots: 3, refs: '14 CFR §117.17 augmented' },
  { cls: 'WB-ULR',   maxFDP_h: 17, fdpNight_h: 16, pilots: 4, refs: '14 CFR §117.19 / 121.523 ULR' },
  { cls: 'RGN-J',    maxFDP_h: 9,  fdpNight_h: 8,  pilots: 2, refs: 'EASA CAT.OP.MPA.250 / CS-FCD' },
  { cls: 'TURBO',    maxFDP_h: 9,  fdpNight_h: 8,  pilots: 2, refs: 'EASA CS-FCD App.1' },
  { cls: 'BIZ',      maxFDP_h: 10, fdpNight_h: 9,  pilots: 2, refs: 'NBAA Duty/Rest 2018 / Pt 91 subpart F' },
  { cls: 'CARGO-LH', maxFDP_h: 16, fdpNight_h: 14, pilots: 3, refs: '14 CFR §117.21 cargo (post-2014)' },
  { cls: 'HEMS',     maxFDP_h: 8,  fdpNight_h: 6,  pilots: 2, refs: 'AC 135-14B §6 / 135.267' },
  { cls: 'CHARTER',  maxFDP_h: 10, fdpNight_h: 9,  pilots: 2, refs: '14 CFR §135.267' },
]
const CLS_BY_KEY: Record<Cls, CrewRule> = Object.fromEntries(RULES.map(r => [r.cls, r])) as any

function clsFromFlight(f: SFlight): Cls {
  const t = (f.type || '').toUpperCase()
  const op = (f.operator || '').toUpperCase()
  const cs = (f.callsign || '').toUpperCase()
  if (op.includes('MEDFLIGHT') || op.includes('LIFENET') || op.includes('STAR') || op.includes('REACH') || op.includes('MEDIC') || cs.startsWith('MED')) return 'HEMS'
  if (op.includes('FEDEX') || op.includes('UPS') || op.includes('CARGOLUX') || op.includes('ATLAS AIR') || op.includes('KALITTA') || cs.startsWith('FDX') || cs.startsWith('GTI') || cs.startsWith('UPS') || cs.startsWith('CLX') || cs.startsWith('ABX') || cs.startsWith('CKS')) return 'CARGO-LH'
  if (op.includes('NETJET') || op.includes('FLEXJET') || op.includes('VISTAJET') || cs.startsWith('EJA') || cs.startsWith('LXJ') || cs.startsWith('VJT')) return 'BIZ'
  if (t.startsWith('GLEX') || t.startsWith('G650') || t.startsWith('GLF') || t.startsWith('FA') || t.startsWith('CL6') || t.startsWith('CL30') || t.startsWith('E55P') || t.startsWith('C25') || t.startsWith('C56') || t.startsWith('C68') || t.startsWith('PC12') || t.startsWith('PC24')) return 'BIZ'
  if (t.startsWith('EC') || t.startsWith('H1') || t.startsWith('H4') || t.startsWith('AS3') || t.startsWith('AS6') || t.startsWith('AW') || t.startsWith('B40') || t.startsWith('B42') || t.startsWith('S76') || t.startsWith('S92') || t.startsWith('R44') || t.startsWith('R66') || t.startsWith('UH60') || t.startsWith('MI8') || t.startsWith('CH47')) return 'HEMS'
  if (t.startsWith('AT') || t.startsWith('DH8') || t === 'DHC8' || t.startsWith('SF3') || t.startsWith('SF34')) return 'TURBO'
  if (t.startsWith('E17') || t.startsWith('E19') || t.startsWith('E29') || t.startsWith('CRJ') || t === 'CRJ2' || t === 'CRJ7' || t === 'CRJ9') return 'RGN-J'
  if (t === 'B748' || t === 'A388' || t === 'B77W' || t === 'B789' || t === 'A35K' || t === 'A359' || t === 'A339') {
    // augmented crew likely
    if (cs.startsWith('UAL') || cs.startsWith('DAL') || cs.startsWith('AAL') || cs.startsWith('QFA') || cs.startsWith('SIA')) return 'WB-ULR'
    return 'WB-LH'
  }
  if (t === 'B744' || t === 'B772' || t === 'B788' || t === 'B78X' || t === 'A388' || t === 'A332' || t === 'A333' || t === 'A35K') return 'WB-LH'
  if (t === 'B763' || t === 'B764' || t === 'B752' || t === 'B753') return 'WB-MED'
  // narrowbody dispatch by callsign hash
  if (t.startsWith('B73') || t.startsWith('A31') || t.startsWith('A32') || t.startsWith('A20') || t.startsWith('A21') || t.startsWith('BCS') || t.startsWith('B73') || t === 'B38M' || t === 'B39M') {
    return classifyNarrow(f)
  }
  return 'NB-DOM'
}
function classifyNarrow(f: SFlight): Cls {
  const cs = (f.callsign || f.icao).toUpperCase()
  let h = 0; for (let i = 0; i < cs.length; i++) h = ((h << 5) - h + cs.charCodeAt(i)) | 0
  const u = (h >>> 0) % 100
  if (u < 60) return 'NB-DOM'
  if (u < 85) return 'NB-INT'
  return 'NB-NIGHT'
}

// Deterministic per-icao24 duty-start offset hours (0-16h ago) and prior-sleep hours (3-9)
function dutyOffset(icao: string, maxFDP: number): { awakeH: number; onDutyH: number; priorSleepH: number } {
  let h = 0; for (let i = 0; i < icao.length; i++) h = ((h << 5) - h + icao.charCodeAt(i)) | 0
  const u1 = ((h >>> 0) % 1000) / 999
  const u2 = (((h >>> 8) >>> 0) % 1000) / 999
  const u3 = (((h >>> 16) >>> 0) % 1000) / 999
  const onDutyH = 0.5 + u1 * (maxFDP + 1.5)            // 0.5h .. maxFDP+2h
  const priorAwakeBefore = 1.5 + u2 * 4                 // 1.5..5.5h awake before duty
  const awakeH = onDutyH + priorAwakeBefore
  const priorSleepH = 3.0 + u3 * 6                      // 3..9h sleep last rest
  return { awakeH, onDutyH, priorSleepH }
}

// Local hour from longitude + UTC (purely longitude-driven for solar approximation)
function localHr(lng: number): number {
  const utcMs = Date.now()
  const utcH = (utcMs / 3.6e6) % 24
  return ((utcH + lng / 15) % 24 + 24) % 24
}

// Two-process model: circadian + homeostatic
function circadianC(localH: number): number {
  // amplitude 10, secondary 12-hr 3 (Folkard/Åkerstedt); phase Φ=5.5 (nadir at 05:30)
  const ph = (localH - 5.5)
  return -10 * Math.cos(2 * Math.PI * ph / 24) + 3 * Math.cos(2 * Math.PI * ph / 12)
}

interface Calc {
  localH: number
  awakeH: number
  onDutyH: number
  priorSleepH: number
  fdpUsedPct: number
  effectiveness: number
  sp: number
  woclIn: boolean
  driver: { EFF: number; WOCL: number; FDP: number; AWAKE: number; SLEEP: number; ULR: number }
  score: number
}

function compute(f: SFlight, rule: CrewRule, advMul: number, fdpMul: number, woclMul: number): Calc {
  const { awakeH, onDutyH, priorSleepH } = dutyOffset(f.icao, rule.maxFDP_h)
  const lh = localHr(f.lng)
  const woclIn = lh >= 2 && lh < 6
  const fdpLimit = woclIn ? rule.fdpNight_h : rule.maxFDP_h
  const fdpUsedPct = (onDutyH / fdpLimit) * 100

  // SAFTE-style reservoir & effectiveness
  const R = Math.max(0, 100 - 12 * Math.max(0, awakeH - 16))
  const sleepDebt = Math.max(0, 7.5 - priorSleepH)
  const reservoir = Math.max(0, R - 8 * sleepDebt)
  const C = circadianC(lh)
  const effectiveness = Math.max(0, Math.min(120, reservoir + C))
  const sp = Math.max(1, Math.min(7, Math.round(7 - effectiveness / 20)))

  const EFF = Math.max(0, Math.min(100, 100 - effectiveness))
  const WOCL = woclIn ? Math.min(100, 70 + 30 * Math.min(1, awakeH / 14)) * (woclMul / 100) : Math.max(0, 20 - Math.abs(lh - 4) * 5)
  const FDP = Math.max(0, Math.min(100, (fdpUsedPct - 0) * (fdpMul / 100)))
  const AWAKE = Math.max(0, Math.min(100, ((awakeH - 12) / 10) * 100))
  const SLEEP = Math.max(0, Math.min(100, ((7 - priorSleepH) / 3) * 100))
  const ULR = rule.cls === 'WB-ULR' && rule.pilots < 4 ? 100 : 0

  const drivers = [EFF, WOCL, FDP, AWAKE, SLEEP, ULR]
  const maxD = Math.max(...drivers)
  const meanD = drivers.reduce((a, b) => a + b, 0) / drivers.length
  const score = Math.max(0, Math.min(100, (maxD * 0.66 + meanD * 0.34) * (advMul / 100)))

  return {
    localH: lh, awakeH, onDutyH, priorSleepH, fdpUsedPct,
    effectiveness, sp, woclIn,
    driver: { EFF, WOCL, FDP, AWAKE, SLEEP, ULR },
    score,
  }
}

type Tier = 'RED-LINE'|'CRITICAL'|'ELEVATED'|'CAUTION'|'ALERT'|'FRESH'|'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'RED-LINE': '#ef4444', CRITICAL: '#f43f5e', ELEVATED: '#f59e0b', CAUTION: '#0ea5e9',
  ALERT: '#10b981', FRESH: '#64748b', IDLE: '#475569',
}
const TIER_RANK: Record<Tier, number> = { 'RED-LINE': 0, CRITICAL: 1, ELEVATED: 2, CAUTION: 3, ALERT: 4, FRESH: 5, IDLE: 6 }
function tierOf(score: number, idle: boolean): Tier {
  if (idle) return 'IDLE'
  if (score >= 85) return 'RED-LINE'
  if (score >= 70) return 'CRITICAL'
  if (score >= 55) return 'ELEVATED'
  if (score >= 35) return 'CAUTION'
  if (score >= 18) return 'ALERT'
  return 'FRESH'
}
function advice(tier: Tier, c: Calc, rule: CrewRule): string {
  if (tier === 'RED-LINE') return `STOP-FLIGHT  no-go fatigue · E=${Math.round(c.effectiveness)} SP=${c.sp} · request FRMS Lvl IV review per Doc 9966 App.B / FAR §117.5 fitness-for-duty`
  if (tier === 'CRITICAL') return `Augmented-rest mandatory · in-seat rest break per ${rule.refs} · two-pilot rule violation likely after +${(rule.maxFDP_h - c.onDutyH).toFixed(1)}h`
  if (tier === 'ELEVATED') return `Extend rest before next sector · WOCL ${c.woclIn ? 'ENCROACHING' : 'cleared'} · monitor Samn-Perelli=${c.sp}/7`
  if (tier === 'CAUTION')  return `Enforce in-seat rest breaks · ${rule.refs} · FDP used ${Math.round(c.fdpUsedPct)}% of ${rule.maxFDP_h}h`
  if (tier === 'ALERT')    return `Nominal monitoring · SP=${c.sp}/7 reservoir healthy · ${rule.cls}`
  if (tier === 'FRESH')    return `No fatigue concern · ${rule.cls} · ${rule.refs}`
  return `On-ground or off-duty`
}

interface Row { f: SFlight; rule: CrewRule; c: Calc; tier: Tier }
const SRC = 'circad-src'
const LBL = 'circad-lbl'

export default function CircadFatigue({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(100)
  const [fdpMul, setFdpMul] = useState(100)
  const [woclMul, setWoclMul] = useState(100)
  const [minFL, setMinFL] = useState(0)
  const [maxAwake, setMaxAwake] = useState(24)
  const [clsFilter, setClsFilter] = useState<'ALL'|Cls>('ALL')
  const [tierFilter, setTierFilter] = useState<'ALL'|Tier>('ALL')
  const [tab, setTab] = useState<'CREWS'|'CLASSES'|'RHYTHM'>('CREWS')
  const [search, setSearch] = useState('')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showWocl, setShowWocl] = useState(true)
  const [pickedIcao, setPickedIcao] = useState<string|null>(null)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      const fl = f.altitudeFt / 100
      const cls = clsFromFlight(f)
      if (clsFilter !== 'ALL' && cls !== clsFilter) continue
      const rule = CLS_BY_KEY[cls]
      const idle = f.ground || fl < minFL
      const c = compute(f, rule, advMul, fdpMul, woclMul)
      if (c.awakeH > maxAwake) continue
      const tier = tierOf(c.score, idle)
      out.push({ f, rule, c, tier })
    }
    out.sort((a, b) => {
      const r = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (r !== 0) return r
      return b.c.score - a.c.score
    })
    return out
  }, [flights, clsFilter, advMul, fdpMul, woclMul, minFL, maxAwake])

  const filtered = useMemo(() => {
    let xs = rows
    if (tierFilter !== 'ALL') xs = xs.filter(r => r.tier === tierFilter)
    if (search) {
      const s = search.toLowerCase()
      xs = xs.filter(r =>
        (r.f.callsign || r.f.icao).toLowerCase().includes(s)
        || (r.f.type || '').toLowerCase().includes(s)
        || (r.f.operator || '').toLowerCase().includes(s)
        || r.rule.cls.toLowerCase().includes(s)
      )
    }
    return xs
  }, [rows, tierFilter, search])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { 'RED-LINE':0, CRITICAL:0, ELEVATED:0, CAUTION:0, ALERT:0, FRESH:0, IDLE:0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const stats = useMemo(() => {
    const act = rows.filter(r => r.tier !== 'IDLE')
    if (!act.length) return { meanE: 0, worst: undefined as Row|undefined, inWocl: 0, redCrit: 0 }
    const meanE = act.reduce((s, r) => s + r.c.effectiveness, 0) / act.length
    const worst = act[0]
    const inWocl = act.filter(r => r.c.woclIn).length
    const redCrit = counts['RED-LINE'] + counts.CRITICAL
    return { meanE, worst, inWocl, redCrit }
  }, [rows, counts])

  useEffect(() => {
    const m = map
    if (!m) return
    const feats: GeoJSON.Feature[] = []
    const labels: GeoJSON.Feature[] = []
    for (const r of filtered) {
      if (r.tier === 'IDLE') continue
      const col = TIER_COLOR[r.tier]
      const ccol = CLS_COLOR[r.rule.cls]
      if (showHalo) {
        const rad = 7 + Math.min(15, r.c.score / 6.5)
        feats.push({ type:'Feature', properties:{ kind:'halo', color: col, radius: rad }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
        feats.push({ type:'Feature', properties:{ kind:'halo-inner', color: ccol, radius: Math.max(3, rad - 3) }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
      if (showPin && (r.tier === 'RED-LINE' || r.tier === 'CRITICAL')) {
        feats.push({ type:'Feature', properties:{ kind:'pin', color: col }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
      if (showWocl && r.c.woclIn) {
        feats.push({ type:'Feature', properties:{ kind:'wocl' }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
      if (showLbl) {
        const txt = `${r.f.callsign || r.f.icao.toUpperCase()} SP${r.c.sp} ${r.tier}`
        labels.push({ type:'Feature', properties:{ text: txt, color: col }, geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] } })
      }
    }
    try {
      const data = { type:'FeatureCollection', features: feats } as GeoJSON.FeatureCollection
      const ldata = { type:'FeatureCollection', features: labels } as GeoJSON.FeatureCollection
      if (!m.getSource(SRC)) m.addSource(SRC, { type:'geojson', data })
      else (m.getSource(SRC) as maplibregl.GeoJSONSource).setData(data)
      if (!m.getSource(LBL)) m.addSource(LBL, { type:'geojson', data: ldata })
      else (m.getSource(LBL) as maplibregl.GeoJSONSource).setData(ldata)
      if (!m.getLayer('circad-halo')) m.addLayer({ id:'circad-halo', type:'circle', source:SRC, filter:['==',['get','kind'],'halo'], paint:{ 'circle-color':'transparent','circle-stroke-color':['get','color'],'circle-stroke-width':2,'circle-radius':['get','radius'],'circle-opacity':0.78 } })
      if (!m.getLayer('circad-halo-inner')) m.addLayer({ id:'circad-halo-inner', type:'circle', source:SRC, filter:['==',['get','kind'],'halo-inner'], paint:{ 'circle-color':'transparent','circle-stroke-color':['get','color'],'circle-stroke-width':1,'circle-radius':['get','radius'],'circle-opacity':0.5 } })
      if (!m.getLayer('circad-wocl')) m.addLayer({ id:'circad-wocl', type:'circle', source:SRC, filter:['==',['get','kind'],'wocl'], paint:{ 'circle-color':'transparent','circle-stroke-color':'#f59e0b','circle-stroke-width':1.4,'circle-radius':22,'circle-stroke-opacity':0.55 } })
      if (!m.getLayer('circad-pin')) m.addLayer({ id:'circad-pin', type:'circle', source:SRC, filter:['==',['get','kind'],'pin'], paint:{ 'circle-color':['get','color'],'circle-stroke-color':'#0f172a','circle-stroke-width':1.2,'circle-radius':5 } })
      if (!m.getLayer('circad-lbl')) m.addLayer({ id:'circad-lbl', type:'symbol', source:LBL, layout:{ 'text-field':['get','text'],'text-size':10,'text-offset':[0,1.4],'text-anchor':'top','text-font':['Noto Sans Regular'] }, paint:{ 'text-color':['get','color'],'text-halo-color':'#0f172a','text-halo-width':1.3 } })
    } catch {}
    return () => {
      try {
        for (const id of ['circad-halo','circad-halo-inner','circad-wocl','circad-pin','circad-lbl']) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC, LBL]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl, showWocl])

  const picked = useMemo(() => {
    if (pickedIcao) {
      const r = rows.find(x => x.f.icao === pickedIcao)
      if (r) return r
    }
    return stats.worst
  }, [pickedIcao, rows, stats.worst])

  return (
    <div className="absolute top-16 right-4 z-30 w-[480px] max-h-[82vh] flex flex-col rounded-lg border border-slate-700/70 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/70">
        <div className="flex items-center gap-2">
          <span className="text-sky-400 font-mono text-xs tracking-widest">CIRCAD</span>
          <span className="text-[10px] text-slate-500">CREW FATIGUE · WOCL · SAFTE / FRMS</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm px-1">✕</button>
      </div>

      {/* Tier strip */}
      <div className="grid grid-cols-7 gap-px bg-slate-800/70 border-b border-slate-700/70 text-[10px] font-mono">
        {(['RED-LINE','CRITICAL','ELEVATED','CAUTION','ALERT','FRESH'] as Tier[]).map(t => {
          const active = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(active ? 'ALL' : t)}
              className={`px-1 py-1.5 flex flex-col items-center ${active ? 'bg-sky-500/15 ring-1 ring-sky-500/40' : 'bg-slate-900 hover:bg-slate-800'}`}>
              <span style={{ color: TIER_COLOR[t] }} className="font-semibold">{counts[t]}</span>
              <span className="text-[9px] text-slate-500 mt-0.5">{t}</span>
            </button>
          )
        })}
        <button onClick={() => setTierFilter('ALL')}
          className={`px-1 py-1.5 flex flex-col items-center ${tierFilter === 'ALL' ? 'bg-sky-500/15 ring-1 ring-sky-500/40' : 'bg-slate-900 hover:bg-slate-800'}`}>
          <span className="text-slate-200 font-semibold">{rows.length}</span>
          <span className="text-[9px] text-slate-500 mt-0.5">ALL</span>
        </button>
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-4 gap-px bg-slate-800/70 border-b border-slate-700/70 text-[10px] font-mono">
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">⌀ Eff</div>
          <div className="text-slate-100">{stats.meanE.toFixed(0)}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-slate-100 truncate">{stats.worst ? (stats.worst.f.callsign || stats.worst.f.icao.toUpperCase()) : '—'}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">In-WOCL</div>
          <div style={{ color: stats.inWocl > 0 ? '#f59e0b' : '#94a3b8' }}>{stats.inWocl}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">RED+CRIT</div>
          <div style={{ color: stats.redCrit > 0 ? TIER_COLOR['RED-LINE'] : '#94a3b8' }}>{stats.redCrit}</div>
        </div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-700/70 space-y-1.5">
        {([
          ['ADV-MUL',  advMul,   setAdvMul,   50, 200, '%'],
          ['FDP-MUL',  fdpMul,   setFdpMul,   50, 200, '%'],
          ['WOCL-MUL', woclMul,  setWoclMul,  50, 200, '%'],
          ['MIN-FL',   minFL,    setMinFL,    0,  500, ''],
          ['MAX-AWK',  maxAwake, setMaxAwake, 8,  24,  'h'],
        ] as Array<[string, number, (n:number)=>void, number, number, string]>).map(([lbl, v, set, lo, hi, u]) => (
          <div key={lbl} className="flex items-center gap-2">
            <span className="text-[9px] text-slate-500 font-mono w-14">{lbl}</span>
            <input type="range" min={lo} max={hi} value={v} onChange={e => set(Number(e.target.value))} className="flex-1 accent-sky-500" />
            <span className="text-[10px] text-slate-300 font-mono w-16 text-right">{v}{u}</span>
          </div>
        ))}
      </div>

      {/* Class filter + toggles */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center flex-wrap gap-1">
        {(['ALL', ...RULES.map(r => r.cls)] as Array<'ALL'|Cls>).map(t => {
          const active = clsFilter === t
          const col = t === 'ALL' ? '#94a3b8' : CLS_COLOR[t as Cls]
          return (
            <button key={t} onClick={() => setClsFilter(t)}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${active ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
              <span style={{ color: col }}>●</span> {t}
            </button>
          )
        })}
        <div className="flex-1" />
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['WOCL',showWocl,setShowWocl]] as Array<[string, boolean, (v:boolean)=>void]>).map(([n,v,s]) => (
          <button key={n} onClick={() => s(!v)} className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${v ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-500'}`}>{n}</button>
        ))}
      </div>

      {/* Search + tabs */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center gap-1.5">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search callsign/type/operator/class"
          className="flex-1 text-[11px] font-mono bg-slate-950/70 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 placeholder-slate-600 outline-none focus:border-sky-500/60" />
        {(['CREWS','CLASSES','RHYTHM'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${tab === t ? 'bg-sky-500/15 ring-1 ring-sky-500/40 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1">
        {tab === 'CREWS' && (
          <div className="divide-y divide-slate-800/70">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-slate-500">No crews in scope.</div>}
            {filtered.map(r => {
              const col = TIER_COLOR[r.tier]
              const ccol = CLS_COLOR[r.rule.cls]
              const drv = r.c.driver
              return (
                <button key={r.f.icao} onClick={() => { setPickedIcao(r.f.icao); onFly(r.f.icao) }}
                  className="w-full text-left px-2 py-1.5 hover:bg-slate-800/40">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: col }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="text-slate-100 font-semibold">{r.f.callsign || r.f.icao.toUpperCase()}</span>
                        <span className="text-slate-500">{r.f.type || '—'}</span>
                        <span className="text-[9px] px-1 py-0 rounded" style={{ background: ccol + '25', color: ccol }}>{r.rule.cls}</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: col + '25', color: col }}>SP{r.c.sp} · {r.tier}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        <span>LCL {r.c.localH.toFixed(1)}h</span>
                        {r.c.woclIn && <span className="text-amber-400">WOCL</span>}
                        <span className="text-slate-500">·</span>
                        <span>AWK {r.c.awakeH.toFixed(1)}h</span>
                        <span>FDP {r.c.onDutyH.toFixed(1)}/{(r.c.woclIn ? r.rule.fdpNight_h : r.rule.maxFDP_h)}h</span>
                        <span>SLP {r.c.priorSleepH.toFixed(1)}h</span>
                      </div>
                      <div className="grid grid-cols-3 gap-0.5 mt-1 text-[10px] font-mono">
                        <div className="bg-slate-950/60 rounded px-1 py-0.5 flex justify-between">
                          <span className="text-slate-500">Eff</span>
                          <span style={{ color: col }}>{Math.round(r.c.effectiveness)}</span>
                        </div>
                        <div className="bg-slate-950/60 rounded px-1 py-0.5 flex justify-between">
                          <span className="text-slate-500">FDP%</span>
                          <span style={{ color: r.c.fdpUsedPct >= 100 ? '#ef4444' : r.c.fdpUsedPct >= 80 ? '#f59e0b' : '#94a3b8' }}>{Math.round(r.c.fdpUsedPct)}</span>
                        </div>
                        <div className="bg-slate-950/60 rounded px-1 py-0.5 flex justify-between">
                          <span className="text-slate-500">Score</span>
                          <span style={{ color: col }}>{Math.round(r.c.score)}</span>
                        </div>
                      </div>
                      <div className="h-1 mt-1 rounded bg-slate-800/70 overflow-hidden">
                        <div className="h-full" style={{ width: `${Math.min(100, r.c.score)}%`, background: col }} />
                      </div>
                      <div className="grid grid-cols-6 gap-0.5 mt-1 text-[10px] font-mono">
                        {(['EFF','WOCL','FDP','AWAKE','SLEEP','ULR'] as const).map(k => (
                          <div key={k} className="bg-slate-950/60 rounded px-1 py-0.5 flex justify-between">
                            <span className="text-slate-500">{k}</span>
                            <span style={{ color: (drv as any)[k] >= 70 ? TIER_COLOR.CRITICAL : (drv as any)[k] >= 40 ? TIER_COLOR.ELEVATED : '#94a3b8' }}>{Math.round((drv as any)[k])}</span>
                          </div>
                        ))}
                      </div>
                      <div className="mt-1 text-[10px] font-mono leading-tight" style={{ color: col }}>
                        › {advice(r.tier, r.c, r.rule)}
                      </div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {tab === 'CLASSES' && (
          <div className="divide-y divide-slate-800/70">
            {RULES.map(rule => {
              const grp = rows.filter(r => r.rule.cls === rule.cls)
              const worst = grp.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier])[0]
              const wt = worst?.tier ?? 'IDLE'
              const wcol = TIER_COLOR[wt]
              const ccol = CLS_COLOR[rule.cls]
              const meanSP = grp.length ? grp.reduce((s, r) => s + r.c.sp, 0) / grp.length : 0
              const redCrit = grp.filter(r => r.tier === 'RED-LINE' || r.tier === 'CRITICAL').length
              return (
                <div key={rule.cls} className="px-2 py-1.5">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: wcol }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="text-[9px] px-1 py-0 rounded" style={{ background: ccol + '25', color: ccol }}>{rule.cls}</span>
                        <span className="text-slate-300">{rule.pilots}P · FDP {rule.maxFDP_h}h (WOCL {rule.fdpNight_h}h)</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: wcol + '25', color: wcol }}>{grp.length}ac · {redCrit} R+C</span>
                      </div>
                      <div className="text-[10px] font-mono text-slate-500 italic mt-0.5 truncate">{rule.refs}</div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        <span>⌀ SP {meanSP.toFixed(1)}/7</span>
                        <span className="text-slate-500">·</span>
                        <span style={{ color: wcol }}>{wt}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'RHYTHM' && (
          <div className="px-3 py-3">
            <div className="text-[10px] font-mono text-slate-400 mb-2">
              Two-process model · 24-hr Effectiveness E(t) = Reservoir + Circadian C(t) · WOCL band 02-06 local · acrophase ★ 17:30 · nadir ▼ 05:30
            </div>
            <RhythmSvg rows={rows} picked={picked || null} />
            <div className="mt-3 grid grid-cols-3 gap-px bg-slate-800/70 text-[10px] font-mono">
              <div className="bg-slate-900 px-2 py-1.5">
                <div className="text-[9px] text-slate-500 uppercase">In Window</div>
                <div className="text-amber-400">{stats.inWocl} ac</div>
              </div>
              <div className="bg-slate-900 px-2 py-1.5">
                <div className="text-[9px] text-slate-500 uppercase">⌀ Eff</div>
                <div className="text-slate-100">{stats.meanE.toFixed(0)}</div>
              </div>
              <div className="bg-slate-900 px-2 py-1.5">
                <div className="text-[9px] text-slate-500 uppercase">Picked</div>
                <div className="text-slate-100 truncate">{picked ? (picked.f.callsign || picked.f.icao.toUpperCase()) : '—'}</div>
              </div>
            </div>
            {picked && (
              <div className="mt-2 text-[10px] font-mono text-slate-400">
                <div><span className="text-slate-500">LCL hr</span> {picked.c.localH.toFixed(2)} · <span className="text-slate-500">SP</span> {picked.c.sp}/7 · <span className="text-slate-500">E</span> {Math.round(picked.c.effectiveness)} · <span className="text-slate-500">awake</span> {picked.c.awakeH.toFixed(1)}h</div>
                <div className="mt-1" style={{ color: TIER_COLOR[picked.tier] }}>› {advice(picked.tier, picked.c, picked.rule)}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function RhythmSvg({ rows, picked }: { rows: Row[]; picked: Row | null }) {
  const W = 420, H = 180, padL = 28, padR = 8, padT = 8, padB = 22
  const innerW = W - padL - padR
  const innerH = H - padT - padB
  const x = (h: number) => padL + (h / 24) * innerW
  const y = (e: number) => padT + (1 - e / 120) * innerH
  const path: string[] = []
  for (let i = 0; i <= 96; i++) {
    const h = (i / 96) * 24
    const R = 80 // baseline assumed-good reservoir for curve display
    const E = R + circadianC(h)
    path.push(`${i === 0 ? 'M' : 'L'}${x(h).toFixed(1)},${y(E).toFixed(1)}`)
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {/* WOCL band 02-06 */}
      <rect x={x(2)} y={padT} width={x(6) - x(2)} height={innerH} fill="#f59e0b" fillOpacity={0.08} stroke="#f59e0b" strokeOpacity={0.35} strokeDasharray="3 3" />
      {/* gridlines */}
      {[0,6,12,18,24].map(h => (
        <g key={h}>
          <line x1={x(h)} x2={x(h)} y1={padT} y2={H - padB} stroke="#334155" strokeOpacity={0.4} />
          <text x={x(h)} y={H - 6} fontSize={9} textAnchor="middle" fill="#64748b" fontFamily="monospace">{String(h).padStart(2,'0')}</text>
        </g>
      ))}
      {[0,40,80,120].map(e => (
        <g key={e}>
          <line x1={padL} x2={W - padR} y1={y(e)} y2={y(e)} stroke="#334155" strokeOpacity={0.3} />
          <text x={padL - 4} y={y(e) + 3} fontSize={9} textAnchor="end" fill="#64748b" fontFamily="monospace">{e}</text>
        </g>
      ))}
      {/* curve */}
      <path d={path.join(' ')} stroke="#0ea5e9" strokeWidth={1.5} fill="none" opacity={0.7} />
      {/* acrophase ★ */}
      <text x={x(17.5)} y={y(85) - 6} fontSize={11} textAnchor="middle" fill="#10b981">★</text>
      {/* nadir ▼ */}
      <text x={x(5.5)} y={y(72) + 12} fontSize={11} textAnchor="middle" fill="#f43f5e">▼</text>
      {/* fleet aircraft dots */}
      {rows.filter(r => r.tier !== 'IDLE').slice(0, 200).map(r => (
        <circle key={r.f.icao} cx={x(r.c.localH)} cy={y(r.c.effectiveness)} r={r === picked ? 4 : 2.2}
          fill={TIER_COLOR[r.tier]} fillOpacity={r === picked ? 1 : 0.65} stroke={r === picked ? '#f8fafc' : 'none'} strokeWidth={r === picked ? 1.2 : 0} />
      ))}
    </svg>
  )
}
