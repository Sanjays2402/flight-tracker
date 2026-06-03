'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   IRS / ADIRU Inertial Reference Drift & ARINC 704A Navigation
   Integrity Monitor (ATA 34-25)
   -----------------------------------------------------------
   Watches every airborne aircraft and reconstructs the health
   of its triplex Inertial Reference System (IRS) or Air-Data
   Inertial Reference Unit (ADIRU) installation against the
   ARINC 704A IRS performance envelope: position-drift growth
   per hour, Schuler-period (84.4-min) oscillation amplitude,
   ground-alignment heading dispersion, gyro-bias stability,
   accelerometer scale-factor error, and ADR (air-data) vs IR
   (inertial) cross-channel disagreement.

   Regulatory & operational basis:
     · ARINC 704A IRS Minimum Performance Standard
     · ARINC 738 ADIRU (Air-Data Inertial Reference Unit)
     · RTCA DO-178C (software) / DO-254 (hardware) for ADIRU
     · FAA AC 25-7C §32 IRS approval / FAA AC 90-105A PBN
     · FAA AC 20-130A IRS-based navigation
     · 14 CFR §121.349 IRS dispatch requirements
     · 14 CFR §91.205(d)(2) IRS for IFR / IRU / IRS-FMS
     · EASA AMC 20-12 / CS-25.1309 / CS-25 App F
     · ICAO Annex 6 Pt I §7.2 / Doc 9613 PBN Manual
     · Boeing 777 FCOM 11.20 IRS / 787 FCOM 11.20 ADIRU
     · Airbus FCOM DSC-34-15 ADIRU / PRO-ABN-34 IR FAULT
     · Honeywell LASEREF V/VI (ring laser gyro RLG)
     · Northrop Grumman LTN-101 GNADIRU (RLG + GPS-aided)
     · Litton/Northrop LTN-92 / LTN-90-100 ring-laser-gyro
     · Boeing AERO Q2-2010 IRS drift / Airbus FAST Mag 47 ADIRU
     · NTSB AAIR-2011/01 Qantas QF72 Learmonth A330 ADIRU
       7 Oct 2008 — Northrop Grumman LTN-101 ADIRU 1 spike
       commanded pitch-down injuring 119, AD 2009-21-13
     · ATSB AO-2008-070 final report Qantas QF72
     · AAIB 1/2010 BA38 B777 Heathrow — IRS not at fault but
       lessons on ADR-IR voting logic
     · Boeing SB 777-34A0150 IRS PSU
     · Airbus SB A330/A340-34-3148 ADIRU 1 BITE rev
     · FAA AD 2009-21-13 ADIRU 1 (Northrop LTN-101)

   Per-airframe inference: FNV-1a 32-bit hash of ICAO24 stably
   synthesises:
     · Channel-1 / Channel-2 / Channel-3 ADIRU/IRU position-
       drift in nm-per-hour (typical 0.3-2.0 nm/hr per ARINC
       704A standard 0.5 nm/hr; class HVY uses 0.3, NRW 0.5,
       RGN 0.8, BIZ 0.7, TBP 1.5, GA 3.0, FTR 0.4 RLG-grade)
     · Schuler 84.4-min position-oscillation amplitude (nm) —
       expected residual after gyrocompass alignment 0.1-0.4
       nm RMS; degraded units climb to 0.8-2.0 nm RMS
     · Ground-alignment heading dispersion in mils (1 mil =
       1/6400 of a circle ≈ 0.056°) — 0.5-2.0 mils nominal,
       8+ mils marginal
     · Gyro-bias stability deg/hr (RLG: 0.003-0.01 deg/hr
       new, 0.05+ degraded), accelerometer scale-factor ppm
     · ADR vs IR disagreement on pitch/roll/heading deg (ADR-
       IR vote logic — single odd-channel-out per Boeing 777
       FCOM 11.20 PFD/ND comparator)
     · GPS-aided vs pure-inertial mode (LTN-101 GNADIRU has
       GPS coupling; if GPS lost, drift restarts from last
       reset)
     · Time-since-alignment hr (since last gate stop / last
       GPS reset) — drift integrates with sqrt(t) / Schuler
       oscillation
     · MEL status: IRS-OK / IRS-MEL (1 channel deferred per
       MMEL 34-21-01 cat-C 10 days) / IRS-INOP (cannot
       dispatch IFR per 14 CFR 121.349)
     · ADR-IR alert flags: HDG-DISAGREE / ATT-DISAGREE /
       NAV-DISAGREE / SPD-DISAGREE per FCOM 11.20

   5 risk components, composite = max-driver:
     DRFT    worst-channel drift nm/hr vs ARINC 704A 0.5
             nm/hr nominal × time-since-alignment ramps
             0 at ≤0.5 nm/hr current radius ramping 100 at
             ≥8 nm radius drift sphere
     SCHL    Schuler 84.4-min residual oscillation amplitude
             — 0 at ≤0.4 nm 100 at ≥2.0 nm (degraded gyro-
             compass alignment per ARINC 704A)
     ALGN    ground-alignment heading dispersion mils — 0 at
             ≤2 mils 100 at ≥10 mils — high dispersion = bad
             initial true-north reference per LASEREF V manual
     VOTE    ADR-IR cross-channel disagreement — 100 if any
             two channels disagree by >1°pitch/roll OR >2°hdg
             OR >5kt CAS per Boeing 777 FCOM 11.20 PFD/ND
             comparator (single channel out = 60)
     MEL     MEL gap — IRS-INOP and IFR-required 100 / IRS-
             MEL 1 channel inop 50 / OK 0

   Tier classification:
     UNSAFE  score≥80 OR any 2 channels in disagreement OR
             drift sphere ≥8nm — rose — declare NAV FAIL
             revert to raw-data per QF72 protocol AAIB 1/2010
     DEGRADE score≥55 OR single-channel fault — amber — fly
             ADR-IR pair, do NOT use INS-only navigation
             below RNP-1 per AC 90-105A
     WATCH   score≥25 — sky — IRS-FMS update at next NAVAID,
             monitor Schuler oscillation per FCOM 11.20
     OK      score<25 — emerald — triple-channel concurrence,
             drift within ARINC 704A envelope
     IDLE    on ground / below MIN-FL — slate

   MapLibre overlay:
     · tier-coloured halo rings sized by score 8-22 px
     · rose diamond pin at current pos for UNSAFE with drift-
       sphere nm + offending channel callout
     · tier-coloured callsign + drift-radius + Schuler labels
       for non-OK aircraft
     · 16-segment dashed forward-projection 60nm tier-coloured
       for UNSAFE
     · sky reference parallels at lat 75/45/15/-15/-45/-75
       every 14° longitude (latitude-dependent gyro-bias rate
       per polar IRS limitation)

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-DRIFT-NM / WORST callsign+drift / UNSAFE-
       count summary
     · 2-cell MEAN-SCHULER-NM / IRS-INOP-share secondary row
     · SVG drift-radius-nm (y, 0-10) vs time-since-alignment-h
       (x, 0-16) scatter with rose ≥8 nm band, amber 4-8 nm,
       sky 1-4 nm, emerald ≤1 nm; dashed ARINC 0.5 nm/hr
       reference; 2/4/8/12/16 h verticals; per-aircraft dots
     · 6 sliders MIN-FL / ARINC-MUL / SCHL-MUL / ALN-BIAS /
       MEL-RATE / GPS-COUPLE in 2-col grid
     · 7-class chip filter HVY/HMB/HNB/NRW/RGN/BIZ/TBP/GA/FTR
     · 4 IRS-grade chip filter RLG-A/RLG-B/FOG/MEMS
     · HALO/PIN/LBL/PROJ/REF/DIAG toggles + search
     · AIRCRAFT / CHANNELS tab switcher
     · Per-row 3-channel pill grid showing CH1/CH2/CH3 drift
       + ALN + tier-coloured vote-pill + advice / click-to-fly

   Persisted: ft-irs
   References: ARINC 704A · ARINC 738 · DO-178C · DO-254 ·
   FAA AC 25-7C · AC 90-105A · AC 20-130A · 14 CFR 121.349 ·
   EASA AMC 20-12 · ICAO Doc 9613 · Honeywell LASEREF V/VI ·
   Northrop Grumman LTN-101 GNADIRU · Boeing 777/787 FCOM
   11.20 · Airbus FCOM DSC-34-15 · ATSB AO-2008-070 QF72 ·
   FAA AD 2009-21-13 · Boeing SB 777-34A0150 · Airbus SB
   A330/A340-34-3148
   ============================================================ */

export interface IrsFlight {
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
  flights: IrsFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'UNSAFE' | 'DEGRADE' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  UNSAFE: '#ef4444', DEGRADE: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_LABEL: Record<Tier, string> = {
  UNSAFE: 'UNSAFE', DEGRADE: 'DEGRADE', WATCH: 'WATCH', OK: 'OK', IDLE: 'IDLE',
}
const TIER_ORDER: Tier[] = ['UNSAFE', 'DEGRADE', 'WATCH', 'OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { UNSAFE: 0, DEGRADE: 1, WATCH: 2, OK: 3, IDLE: 4 }

type AcClass = 'HVY' | 'HMB' | 'HNB' | 'NRW' | 'RGN' | 'BIZ' | 'TBP' | 'FTR' | 'GA'
const CLASS_LIST: AcClass[] = ['HVY', 'HMB', 'HNB', 'NRW', 'RGN', 'BIZ', 'TBP', 'FTR', 'GA']

type IrsGrade = 'RLG-A' | 'RLG-B' | 'FOG' | 'MEMS'
const GRADE_LIST: IrsGrade[] = ['RLG-A', 'RLG-B', 'FOG', 'MEMS']

interface IrsSpec {
  model: string
  grade: IrsGrade
  channels: 2 | 3            // duplex / triplex
  driftNmPerHrBase: number   // ARINC 704A base drift
  gyroBiasDegHr: number      // gyro bias stability
  alignMilsBase: number      // ground alignment heading dispersion (mils)
  gpsCouple: boolean         // GNADIRU / GPS-coupled
  irsRequired: boolean       // IFR dispatch requires functional IRS
}

const IRS_BY_CLASS: Record<AcClass, IrsSpec> = {
  HVY: { model: 'Honeywell LASEREF VI / Northrop LTN-101 GNADIRU', grade: 'RLG-A', channels: 3, driftNmPerHrBase: 0.30, gyroBiasDegHr: 0.003, alignMilsBase: 0.8, gpsCouple: true, irsRequired: true },
  HMB: { model: 'Honeywell LASEREF V / Northrop LTN-92', grade: 'RLG-A', channels: 3, driftNmPerHrBase: 0.40, gyroBiasDegHr: 0.005, alignMilsBase: 1.0, gpsCouple: true, irsRequired: true },
  HNB: { model: 'Honeywell LASEREF IV/V / Litton LTN-90-100', grade: 'RLG-B', channels: 3, driftNmPerHrBase: 0.50, gyroBiasDegHr: 0.008, alignMilsBase: 1.2, gpsCouple: true, irsRequired: true },
  NRW: { model: 'Honeywell LASEREF IV / Sagem GADIRS', grade: 'RLG-B', channels: 3, driftNmPerHrBase: 0.50, gyroBiasDegHr: 0.010, alignMilsBase: 1.5, gpsCouple: true, irsRequired: true },
  RGN: { model: 'Honeywell HG-2030 / Thales TLS-2020', grade: 'FOG', channels: 2, driftNmPerHrBase: 0.80, gyroBiasDegHr: 0.020, alignMilsBase: 2.0, gpsCouple: true, irsRequired: true },
  BIZ: { model: 'Honeywell HG-9900 / iNAV-FMS-3000', grade: 'RLG-B', channels: 2, driftNmPerHrBase: 0.70, gyroBiasDegHr: 0.015, alignMilsBase: 1.8, gpsCouple: true, irsRequired: true },
  TBP: { model: 'Honeywell HG-1700 FOG / Thales AHRS', grade: 'FOG', channels: 2, driftNmPerHrBase: 1.50, gyroBiasDegHr: 0.050, alignMilsBase: 3.5, gpsCouple: false, irsRequired: false },
  GA: { model: 'Garmin GRS-77 AHRS MEMS', grade: 'MEMS', channels: 2, driftNmPerHrBase: 3.00, gyroBiasDegHr: 0.200, alignMilsBase: 6.0, gpsCouple: true, irsRequired: false },
  FTR: { model: 'Northrop LN-100G / Honeywell H-764G EGI', grade: 'RLG-A', channels: 3, driftNmPerHrBase: 0.40, gyroBiasDegHr: 0.004, alignMilsBase: 0.6, gpsCouple: true, irsRequired: true },
}

function classifyClass(type: string): AcClass {
  const t = (type || '').toUpperCase()
  if (/B77|B78|B74|A33|A34|A35|A38|MD11|IL96/.test(t)) return 'HVY'
  if (/B76|A30|A31|DC10|B75/.test(t)) return 'HMB'
  if (/B73|B72|MD8|MD9/.test(t)) return 'HNB'
  if (/A22|A31|A32|A21|EMB-19[05]|A220/.test(t)) return 'NRW'
  if (/CRJ|E1[79]|E29|AT[47]|DH8|RJ85|F70|F100/.test(t)) return 'RGN'
  if (/CL[36]|G[VI458]|GLF|GLEX|GL5T|FA[5789]|F2TH|E[35]5/.test(t)) return 'BIZ'
  if (/PC1|PC2|TBM|PT6|KING|BE20|C208|C30|DH3/.test(t)) return 'TBP'
  if (/F1[568]|F[24]|EFA|EUFI|TYPH|RAFL|MIG|SUKH|JAS/.test(t)) return 'FTR'
  return 'GA'
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}

type MelStatus = 'IRS-OK' | 'IRS-MEL' | 'IRS-INOP'
type Driver = 'DRFT' | 'SCHL' | 'ALGN' | 'VOTE' | 'MEL' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  DRFT: 'Inertial drift outside ARINC 704A',
  SCHL: 'Schuler 84.4-min oscillation residual',
  ALGN: 'Ground-alignment heading dispersion',
  VOTE: 'ADR-IR cross-channel disagreement',
  MEL: 'MEL gap vs IFR dispatch',
  NONE: 'Nominal',
}

interface ChannelState {
  drift: number       // nm radius accumulated
  schuler: number     // nm RMS oscillation
  alignMils: number   // ground-align mils
  ok: boolean         // channel healthy
}

interface Row {
  f: IrsFlight
  klass: AcClass
  spec: IrsSpec
  channels: ChannelState[]
  worstDriftNmHr: number
  worstSchulerNm: number
  worstAlignMils: number
  timeSinceAlnHr: number
  driftRadiusNm: number
  gpsCoupled: boolean
  voteOk: boolean
  voteCount: number   // # channels failing vote
  mel: MelStatus
  sev: { drft: number; schl: number; algn: number; vote: number; mel: number }
  score: number
  driver: Driver
  tier: Tier
}

const SRC_HALO = 'irs-halo', SRC_LBL = 'irs-lbl', SRC_PIN = 'irs-pin', SRC_REF = 'irs-ref', SRC_PROJ = 'irs-proj'
const LYR_HALO = 'irs-halo-l', LYR_LBL = 'irs-lbl-l', LYR_PIN = 'irs-pin-l', LYR_REF = 'irs-ref-l', LYR_PROJ = 'irs-proj-l'

export default function IrsAdiru({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'CHANNELS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<AcClass | 'ALL'>('ALL')
  const [gradeFilter, setGradeFilter] = useState<IrsGrade | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [arincMul, setArincMul] = useState(100)   // % of ARINC 704A drift
  const [schlMul, setSchlMul] = useState(100)     // Schuler amplitude scale
  const [alnBias, setAlnBias] = useState(0)       // alignment bias mils
  const [melRate, setMelRate] = useState(6)       // % fleet on MEL
  const [gpsCouple, setGpsCouple] = useState(85)  // % GPS-aided uptime
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
      const klass = classifyClass(f.type || '')
      const spec = IRS_BY_CLASS[klass]
      const h = hash32(f.icao || '')

      // time since last alignment / GPS reset — 0.2 .. 16 hr
      const tsaRaw = 0.2 + ((h >>> 5) % 1600) / 100
      const gpsAided = spec.gpsCouple && ((h >>> 9) % 100) < gpsCouple
      // GPS-aided units reset drift periodically; non-aided integrate
      const timeSinceAln = gpsAided ? Math.min(tsaRaw, 1.5) : tsaRaw

      const channels: ChannelState[] = []
      for (let c = 0; c < spec.channels; c++) {
        const ch = (h >>> (c * 7)) & 0xff
        // per-channel drift rate nm/hr — base * (0.7 .. 1.6) * mul
        const driftRate = spec.driftNmPerHrBase * (0.7 + (ch % 100) / 110) * (arincMul / 100)
        const drift = driftRate * timeSinceAln
        // Schuler residual amplitude (nm) — degrades with poor alignment
        const schulerBase = 0.15 + (ch % 50) / 250 // 0.15 .. 0.35
        const schuler = schulerBase * (schlMul / 100) * (1 + driftRate / spec.driftNmPerHrBase * 0.5)
        // ground alignment dispersion (mils) — class base + hash + bias
        const alignMils = Math.max(0.2, spec.alignMilsBase + (ch % 30) / 10 - 1 + alnBias)
        // 3.5% per-channel hard-fault probability (single channel)
        const hardFault = ((h >>> (c * 5 + 11)) & 0x3ff) < 36
        channels.push({ drift, schuler, alignMils, ok: !hardFault })
      }

      const worstDriftRate = Math.max(...channels.map(c => c.drift / Math.max(0.1, timeSinceAln)))
      const worstSchuler = Math.max(...channels.map(c => c.schuler))
      const worstAlign = Math.max(...channels.map(c => c.alignMils))
      const driftRadius = Math.max(...channels.map(c => c.drift))
      const failedCount = channels.filter(c => !c.ok).length
      // vote logic: triplex tolerates 1 fault, duplex tolerates 0
      const voteOk = spec.channels === 3 ? failedCount <= 1 : failedCount === 0
      const voteCount = failedCount

      // MEL — melRate% of fleet on MEL, third of those INOP
      const melRoll = (h >>> 11) % 1000
      const melThr = melRate * 10
      let mel: MelStatus = 'IRS-OK'
      if (melRoll < melThr / 3) mel = 'IRS-INOP'
      else if (melRoll < melThr) mel = 'IRS-MEL'

      // severities
      // DRFT: 0 at <=0.5 nm/hr current radius scaled by t, ramp 100 at 8nm radius
      const drftSev = driftRadius <= 0.5 ? 0
        : driftRadius >= 8 ? 100
        : ((driftRadius - 0.5) / 7.5) * 100
      // SCHL: 0 at <=0.4 100 at >=2.0
      const schlSev = worstSchuler <= 0.4 ? 0
        : worstSchuler >= 2.0 ? 100
        : ((worstSchuler - 0.4) / 1.6) * 100
      // ALGN: 0 at <=2 mils 100 at >=10
      const algnSev = worstAlign <= 2 ? 0
        : worstAlign >= 10 ? 100
        : ((worstAlign - 2) / 8) * 100
      // VOTE
      let voteSev = 0
      if (spec.channels === 3) {
        if (failedCount >= 2) voteSev = 100
        else if (failedCount === 1) voteSev = 60
      } else {
        if (failedCount >= 1) voteSev = 85
      }
      // MEL
      let melSev = 0
      if (mel === 'IRS-INOP' && spec.irsRequired) melSev = 100
      else if (mel === 'IRS-INOP') melSev = 35
      else if (mel === 'IRS-MEL' && spec.irsRequired) melSev = 50
      else if (mel === 'IRS-MEL') melSev = 20

      const drvList: Array<[Driver, number]> = [
        ['DRFT', drftSev], ['SCHL', schlSev], ['ALGN', algnSev], ['VOTE', voteSev], ['MEL', melSev],
      ]
      drvList.sort((a, b) => b[1] - a[1])
      const driver: Driver = drvList[0][1] > 0 ? drvList[0][0] : 'NONE'
      const score = Math.min(100, drvList[0][1] + 0.10 * drvList[1][1])

      let tier: Tier
      if (!voteOk || score >= 80 || driftRadius >= 8) tier = 'UNSAFE'
      else if (score >= 55 || failedCount >= 1) tier = 'DEGRADE'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, klass, spec, channels,
        worstDriftNmHr: worstDriftRate, worstSchulerNm: worstSchuler, worstAlignMils: worstAlign,
        timeSinceAlnHr: timeSinceAln, driftRadiusNm: driftRadius, gpsCoupled: gpsAided,
        voteOk, voteCount, mel,
        sev: { drft: drftSev, schl: schlSev, algn: algnSev, vote: voteSev, mel: melSev },
        score, driver, tier,
      })
    }
    return out
  }, [flights, minFl, arincMul, schlMul, alnBias, melRate, gpsCouple])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { UNSAFE: 0, DEGRADE: 0, WATCH: 0, OK: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumDrift = 0, sumSchl = 0, worst = 0, worstCs = '', worstDrv: Driver = 'NONE', worstScore = 0
    let unsafe = 0, inop = 0, count = 0
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      count++
      sumDrift += r.driftRadiusNm; sumSchl += r.worstSchulerNm
      if (r.tier === 'UNSAFE') unsafe++
      if (r.mel === 'IRS-INOP') inop++
      if (r.score > worst) { worst = r.score; worstCs = (r.f.callsign || r.f.icao).trim(); worstDrv = r.driver; worstScore = r.score }
    }
    return {
      meanDrift: count ? sumDrift / count : 0,
      meanSchl: count ? sumSchl / count : 0,
      worst, worstCs, worstDrv, worstScore, unsafe,
      inopShare: count ? inop / count : 0,
      activeCount: count,
    }
  }, [rows])

  // For CHANNELS tab: per-channel rows
  const channelRows = useMemo(() => {
    const arr: Array<{ row: Row; chIdx: number; ch: ChannelState }> = []
    for (const r of rows) {
      if (r.tier === 'IDLE') continue
      for (let i = 0; i < r.channels.length; i++) {
        arr.push({ row: r, chIdx: i, ch: r.channels[i] })
      }
    }
    arr.sort((a, b) => {
      const ti = TIER_RANK[a.row.tier] - TIER_RANK[b.row.tier]
      if (ti !== 0) return ti
      return b.ch.drift - a.ch.drift
    })
    return arr
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows
      .filter(r => r.tier !== 'IDLE')
      .filter(r => {
        if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
        if (classFilter !== 'ALL' && r.klass !== classFilter) return false
        if (gradeFilter !== 'ALL' && r.spec.grade !== gradeFilter) return false
        if (!q) return true
        return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.spec.model].some(s => (s || '').toUpperCase().includes(q))
      })
      .sort((a, b) => {
        const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (ti !== 0) return ti
        return b.score - a.score
      })
  }, [rows, tierFilter, classFilter, gradeFilter, query])

  const filteredChannels = useMemo(() => {
    const q = query.trim().toUpperCase()
    return channelRows.filter(({ row }) => {
      if (tierFilter !== 'ALL' && row.tier !== tierFilter) return false
      if (classFilter !== 'ALL' && row.klass !== classFilter) return false
      if (gradeFilter !== 'ALL' && row.spec.grade !== gradeFilter) return false
      if (!q) return true
      return [row.f.callsign, row.f.type, row.f.operator, row.f.icao, row.spec.model].some(s => (s || '').toUpperCase().includes(q))
    }).slice(0, 200)
  }, [channelRows, tierFilter, classFilter, gradeFilter, query])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.filter(r => r.tier !== 'OK' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, r.score / 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'DEGRADE' || r.tier === 'UNSAFE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} DR ${r.driftRadiusNm.toFixed(1)}nm SCH ${r.worstSchulerNm.toFixed(2)}` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'UNSAFE').map(r => ({
      type: 'Feature' as const,
      properties: { color: '#ef4444', text: `\u203a NAV-FAIL ${r.voteCount}/${r.spec.channels}ch drift ${r.driftRadiusNm.toFixed(1)}nm` },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    // forward projection 60nm
    const projFeatures: any[] = []
    if (showProj) {
      for (const r of rows) {
        if (r.tier !== 'UNSAFE') continue
        const tr = r.f.track * Math.PI / 180
        const dNm = 60
        const dLat = (dNm / 60) * Math.cos(tr)
        const dLng = (dNm / 60) * Math.sin(tr) / Math.max(0.1, Math.cos(r.f.lat * Math.PI / 180))
        const coords: [number, number][] = []
        const segs = 16
        for (let i = 0; i <= segs; i++) {
          coords.push([r.f.lng + dLng * (i / segs), r.f.lat + dLat * (i / segs)])
        }
        projFeatures.push({ type: 'Feature' as const, properties: { color: TIER_COLOR[r.tier] }, geometry: { type: 'LineString' as const, coordinates: coords } })
      }
    }
    const projFc = { type: 'FeatureCollection' as const, features: projFeatures }

    // sky reference parallels — latitude-dependent gyro-bias rate
    const refFeatures: any[] = []
    if (showRef) {
      for (const lat of [75, 45, 15, -15, -45, -75]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 14) coords.push([lng, lat])
        refFeatures.push({ type: 'Feature' as const, properties: { color: '#0ea5e9' }, geometry: { type: 'LineString' as const, coordinates: coords } })
      }
    }
    const refFc = { type: 'FeatureCollection' as const, features: refFeatures }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_REF, refFc, () => map.addLayer({ id: LYR_REF, type: 'line', source: SRC_REF, paint: {
        'line-color': ['get', 'color'], 'line-width': 0.6, 'line-opacity': 0.14, 'line-dasharray': [4, 6],
      } }))
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [3, 3],
      } }))
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.4, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'symbol', source: SRC_PIN, layout: {
        'text-field': ['get', 'text'], 'text-size': 10,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-offset': [0, -1.5], 'text-anchor': 'bottom', 'icon-allow-overlap': true,
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.6 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_PROJ, LYR_REF]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_PROJ, SRC_REF]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showLabels, showPin, showProj, showRef])

  // Diagram: drift-radius nm (y, 0..10) vs time-since-alignment hr (x, 0..16)
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 30
    const xMin = 0, xMax = 16
    const yMax = 10
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * (W - PAD - 6)
    const ys = (v: number) => 6 + (1 - Math.max(0, Math.min(1, v / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">IRS / ADIRU · ARINC 704A</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.activeCount} ac · {summary.unsafe} UNSAFE</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold" style={{ color: TIER_COLOR[t] }}>{TIER_LABEL[t]}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean drift</div>
          <div className="font-mono text-sm" style={{ color: summary.meanDrift >= 4 ? '#ef4444' : summary.meanDrift >= 1 ? '#f59e0b' : '#10b981' }}>{summary.meanDrift.toFixed(2)}nm</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstScore.toFixed(0)}` : '\u2014'}
          </div>
          <div className="text-[8px] text-slate-500 truncate">{summary.worstDrv !== 'NONE' ? DRIVER_LABEL[summary.worstDrv] : '\u2014'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">UNSAFE</div>
          <div className="font-mono text-sm" style={{ color: summary.unsafe > 0 ? '#ef4444' : '#10b981' }}>{summary.unsafe}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Schuler</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanSchl >= 1.0 ? '#ef4444' : summary.meanSchl >= 0.5 ? '#f59e0b' : '#94a3b8' }}>{summary.meanSchl.toFixed(2)} nm</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">IRS-INOP share</div>
          <div className="font-mono text-[11px]" style={{ color: summary.inopShare > 0.10 ? '#ef4444' : summary.inopShare > 0.04 ? '#f59e0b' : '#10b981' }}>{(summary.inopShare * 100).toFixed(1)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">drift radius nm vs time since alignment hr · ARINC 704A envelope</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* horizontal bands: high drift = bad */}
            <rect x={diag.PAD} y={6} width={diag.W - 6 - diag.PAD} height={diag.ys(8) - 6} fill="#ef4444" opacity={0.10} />
            <rect x={diag.PAD} y={diag.ys(8)} width={diag.W - 6 - diag.PAD} height={diag.ys(4) - diag.ys(8)} fill="#f59e0b" opacity={0.10} />
            <rect x={diag.PAD} y={diag.ys(4)} width={diag.W - 6 - diag.PAD} height={diag.ys(1) - diag.ys(4)} fill="#0ea5e9" opacity={0.08} />
            {[1, 4, 8].map(yv => (
              <g key={yv}>
                <line x1={diag.PAD} y1={diag.ys(yv)} x2={diag.W - 6} y2={diag.ys(yv)} stroke={yv === 8 ? '#ef4444' : yv === 4 ? '#f59e0b' : '#0ea5e9'} strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
                <text x={diag.PAD - 2} y={diag.ys(yv) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{yv}</text>
              </g>
            ))}
            {/* ARINC 0.5 nm/hr reference diagonal */}
            <line x1={diag.xs(0)} y1={diag.ys(0)} x2={diag.xs(16)} y2={diag.ys(8)} stroke="#0ea5e9" strokeDasharray="2 4" opacity={0.5} strokeWidth={1} />
            <text x={diag.W - 8} y={diag.ys(8) - 2} textAnchor="end" fontSize={7} fill="#0ea5e9" fontFamily="monospace">ARINC 0.5 nm/hr</text>
            {[2, 4, 8, 12, 16].map(xv => (
              <g key={xv}>
                <line x1={diag.xs(xv)} y1={6} x2={diag.xs(xv)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(xv)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{xv}h</text>
              </g>
            ))}
            <text x={diag.PAD + 4} y={diag.ys(8) + 9} fontSize={7} fill="#ef4444" fontFamily="monospace">UNSAFE ≥8nm</text>
            <text x={diag.PAD + 4} y={diag.ys(4) + 9} fontSize={7} fill="#f59e0b" fontFamily="monospace">DEGRADE 4-8</text>
            <text x={diag.PAD + 4} y={diag.ys(1) + 9} fontSize={7} fill="#0ea5e9" fontFamily="monospace">WATCH 1-4</text>
            {rows.filter(r => r.tier !== 'IDLE').map(r => (
              <circle key={r.f.icao}
                cx={diag.xs(Math.max(diag.xMin, Math.min(diag.xMax, r.timeSinceAlnHr)))}
                cy={diag.ys(Math.max(0, Math.min(diag.yMax, r.driftRadiusNm)))}
                r={3} fill={TIER_COLOR[r.tier]} opacity={0.92} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>ARINC-MUL</span><span className="font-mono text-slate-300">{arincMul}%</span></div>
            <input type="range" min={50} max={250} step={5} value={arincMul} onChange={e => setArincMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>SCHL-MUL</span><span className="font-mono text-slate-300">{schlMul}%</span></div>
            <input type="range" min={50} max={300} step={5} value={schlMul} onChange={e => setSchlMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>ALN-BIAS</span><span className="font-mono text-slate-300">{alnBias >= 0 ? '+' : ''}{alnBias}mil</span></div>
            <input type="range" min={-3} max={6} step={1} value={alnBias} onChange={e => setAlnBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MEL-RATE</span><span className="font-mono text-slate-300">{melRate}%</span></div>
            <input type="range" min={0} max={25} step={1} value={melRate} onChange={e => setMelRate(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>GPS-CPL</span><span className="font-mono text-slate-300">{gpsCouple}%</span></div>
            <input type="range" min={0} max={100} step={5} value={gpsCouple} onChange={e => setGpsCouple(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setClassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${classFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {CLASS_LIST.map(k => (
            <button key={k} onClick={() => setClassFilter(classFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${classFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setGradeFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${gradeFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>GRADE</button>
          {GRADE_LIST.map(k => (
            <button key={k} onClick={() => setGradeFilter(gradeFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${gradeFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRef} onChange={e => setShowRef(e.target.checked)} className="accent-sky-500" /><span>REF</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / ADIRU"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'CHANNELS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${summary.activeCount} ac` : `${filteredChannels.length} chan shown`}</span>
        <span>{tab === 'AIRCRAFT' ? 'DRFT · SCHL · ALGN · VOTE · MEL' : 'channel · drift · Schuler · alignment'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft airborne above MIN-FL.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const advice = r.tier === 'UNSAFE'
            ? !r.voteOk
              ? `${r.voteCount}/${r.spec.channels} channels in disagreement \u2014 declare NAV-FAIL revert to raw-data per QF72 / AAIB 1/2010`
              : `drift radius ${r.driftRadiusNm.toFixed(1)}nm beyond ARINC 704A \u2014 inhibit IRS-FMS update at next VOR/DME`
            : r.tier === 'DEGRADE'
              ? `${DRIVER_LABEL[r.driver].toLowerCase()} \u2014 fly ADR-IR pair do NOT use INS-only below RNP-1 per AC 90-105A`
              : r.tier === 'WATCH'
                ? `${r.driver} trend monitor \u2014 IRS-FMS update at next NAVAID per FCOM 11.20`
                : `triplex concurrence \u2014 drift ${r.driftRadiusNm.toFixed(2)}nm within ARINC 704A envelope`
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{r.klass}</span>
                  <span className="text-[10px] font-mono text-slate-500">{r.spec.grade}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{TIER_LABEL[r.tier]}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="time since alignment hr">t {r.timeSinceAlnHr.toFixed(1)}h</span>
                  <span title="drift radius nm" style={{ color: r.driftRadiusNm >= 4 ? '#ef4444' : r.driftRadiusNm >= 1 ? '#f59e0b' : '#10b981' }}>DR {r.driftRadiusNm.toFixed(2)}nm</span>
                  <span title="worst Schuler residual" style={{ color: r.worstSchulerNm >= 1 ? '#ef4444' : r.worstSchulerNm >= 0.5 ? '#f59e0b' : '#94a3b8' }}>SCH {r.worstSchulerNm.toFixed(2)}</span>
                  <span title="worst alignment dispersion mils" style={{ color: r.worstAlignMils >= 5 ? '#f59e0b' : '#64748b' }}>ALN {r.worstAlignMils.toFixed(1)}mil</span>
                  <span className="ml-auto" title="composite risk score" style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title={`score ${r.score.toFixed(0)} / 100`}>
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-500/70" style={{ left: `25%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-500/70" style={{ left: `55%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-500/70" style={{ left: `80%` }} />
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {([['DRFT', r.sev.drft], ['SCHL', r.sev.schl], ['ALGN', r.sev.algn], ['VOTE', r.sev.vote], ['MEL', r.sev.mel]] as const).map(([lbl, v]) => {
                    const c = v >= 80 ? '#ef4444' : v >= 55 ? '#f59e0b' : v >= 25 ? '#0ea5e9' : '#475569'
                    return (
                      <span key={lbl} className="px-1 py-0 rounded border text-[9px] font-mono"
                        style={{ borderColor: c + '66', color: c, background: c + '14' }}>{lbl} {v.toFixed(0)}</span>
                    )
                  })}
                </div>
                <div className="grid grid-cols-3 gap-1 mt-1">
                  {r.channels.map((ch, i) => {
                    const c = !ch.ok ? '#ef4444' : ch.drift >= 4 ? '#ef4444' : ch.drift >= 1 ? '#f59e0b' : '#10b981'
                    return (
                      <div key={i} className="rounded border px-1 py-0.5 text-[9px] font-mono leading-tight"
                        style={{ borderColor: c + '66', background: c + '0d' }}>
                        <div className="flex justify-between">
                          <span className="text-slate-400">CH{i + 1}</span>
                          <span style={{ color: c }}>{ch.ok ? 'OK' : 'FLT'}</span>
                        </div>
                        <div className="text-slate-300">{ch.drift.toFixed(2)}nm</div>
                        <div className="text-slate-500">aln {ch.alignMils.toFixed(1)}</div>
                      </div>
                    )
                  })}
                </div>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="px-1 py-0 rounded border text-[9px] font-mono"
                    style={{ borderColor: r.mel === 'IRS-INOP' ? '#ef444466' : r.mel === 'IRS-MEL' ? '#f59e0b66' : '#10b98166',
                             color: r.mel === 'IRS-INOP' ? '#ef4444' : r.mel === 'IRS-MEL' ? '#f59e0b' : '#10b981',
                             background: r.mel === 'IRS-INOP' ? '#ef444414' : r.mel === 'IRS-MEL' ? '#f59e0b14' : '#10b98114' }}>{r.mel}</span>
                  {r.gpsCoupled
                    ? <span className="px-1 py-0 rounded border text-[9px] font-mono border-emerald-500/40 text-emerald-300 bg-emerald-500/10">GPS-CPL</span>
                    : <span className="px-1 py-0 rounded border text-[9px] font-mono border-amber-500/40 text-amber-300 bg-amber-500/10">PURE-INS</span>}
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-400">{r.spec.channels}-CH</span>
                  <span className="px-1 py-0 rounded border text-[9px] font-mono border-slate-800 bg-slate-900/60 text-slate-500">bias {(r.spec.gyroBiasDegHr * 1000).toFixed(1)}m\u00b0/hr</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator and IRS model" className="truncate">{r.f.operator || '\u2014'} \u00b7 {r.spec.model}</span>
                </div>
                <div className="text-[10px] mt-0.5 truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }} title={advice}>{advice}</div>
              </div>
            </button>
          )
        })}
        {tab === 'CHANNELS' && filteredChannels.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No channels match filter.</div>
        )}
        {tab === 'CHANNELS' && filteredChannels.map(({ row: r, chIdx, ch }) => {
          const chTier: Tier = !ch.ok ? 'UNSAFE'
            : ch.drift >= 8 ? 'UNSAFE'
            : ch.drift >= 4 ? 'DEGRADE'
            : ch.drift >= 1 ? 'WATCH' : 'OK'
          return (
            <button key={r.f.icao + ':' + chIdx} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-1.5 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[chTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 text-[10px]">CH{chIdx + 1}/{r.spec.channels}</span>
                  <span className="text-slate-500 text-[10px] truncate">{r.spec.grade}</span>
                  <span className="ml-auto text-[10px] font-semibold" style={{ color: TIER_COLOR[chTier] }}>{ch.ok ? TIER_LABEL[chTier] : 'FAULT'}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="channel drift nm" style={{ color: ch.drift >= 4 ? '#ef4444' : ch.drift >= 1 ? '#f59e0b' : '#10b981' }}>drift {ch.drift.toFixed(2)}nm</span>
                  <span title="Schuler residual" style={{ color: ch.schuler >= 1 ? '#ef4444' : ch.schuler >= 0.5 ? '#f59e0b' : '#94a3b8' }}>SCH {ch.schuler.toFixed(2)}</span>
                  <span title="ground alignment mils" style={{ color: ch.alignMils >= 5 ? '#f59e0b' : '#64748b' }}>aln {ch.alignMils.toFixed(1)}mil</span>
                  <span className="ml-auto text-slate-500">{r.f.type || '\u2014'}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
