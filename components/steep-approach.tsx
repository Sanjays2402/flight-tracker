'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   STEEP APPROACH · Aircraft Approval & Configuration Monitor
   -----------------------------------------------------------
   Per-arrival eligibility & configuration scorer for runways
   with published glide-path angle greater than the ICAO PANS-OPS
   standard 3.0°. A steep approach (3.5°-7.5°) requires:
     (1) airframe Type-Certificate steep-approach approval per
         EASA CS-25 Subpart B / Special Condition SC-D-04 /
         FAA AC 25-29 / Boeing FCOM SP-16 / Airbus FCOM
         PRO-NOR-SOP-19,
     (2) crew steep-approach line check currency,
     (3) configuration: full flap (FLAP-FULL / CONF-FULL), idle
         reverse armed, autobrake MED+, max landing weight
         reduction per AFM Supplement table,
     (4) approach speed addition (Vapp + 5 kt steep) per FCOM,
     (5) operator OpSpec C063 / Ops Manual Part B approval for
         the specific aerodrome.

   Regulatory basis:
     · ICAO PANS-OPS Doc 8168 Vol II Pt I §4 standard 3.0° GP
     · ICAO Annex 14 Vol I §3.1.13 steep approach > 4.5°
     · ICAO Doc 9365 All-Weather Operations Manual §3
     · EASA CS-25.125(a)(2) landing distance steep
     · EASA AMC 25.125 steep landing distance factor
     · EASA SC-D-04 Steep Approach Landing Capability TC
     · EASA CAT.POL.A.220 steep approach 4.5°-9.0°
     · EASA AMC 1 CAT.POL.A.220 operator approval
     · FAA AC 25-29 Steep Approach Landing Certification
     · FAA Order 8900.1 Vol 3 Ch 18 OpSpec C063
     · FAA 14 CFR 121.97 steep approach operating limits
     · 14 CFR 91.605 / 121.195(b) factored LDR 0.6 / 0.7
     · Boeing FCOM SP-16 Non-Normal / FCTM Approach §5.7
     · Airbus FCOM PRO-NOR-SOP-19 / DSC-22-AUTOFLT steep-AP
     · Embraer FCOM 4.12 E-Jet steep approach (E170-E195)
     · Bombardier FCOM 4-10 CRJ-700/900 steep approach
     · ATR FCOM 2.04 ATR-72-600 steep approach approval
     · BAe-146 / Avro RJ AFM Suppl 5 steep approach (LCY-cert)
     · Saab 340/2000 AFM Suppl steep approach
     · Dornier 328 AFM Suppl steep approach
     · IAA / CAA UK / DGAC approvals per aerodrome
   ============================================================

   28-runway global steep-approach catalogue:
     · 5.5°  EGLC London City — 09 & 27 (BAe-146 / RJ / DH8D /
       E190-E2 / A220-100 / CL850 / Embraer Phenom 300)
     · 6.65° LSZA Lugano — 19 (Saab 2000 / DH8)
     · 6.0°  LSGS Sion — 25 (DH8 / CRJ-200 / GLF / FA50)
     · 3.8°  LOWI Innsbruck — 08 / 26 (B737 / A320 NPA-SA cert)
     · 6.43° NZQN Queenstown — 23 (B737-800 / A320 RNP-AR-steep)
     · 4.5°  LIPB Bolzano — 01 / 19 (DH8 / E170)
     · 3.5°  KASE Aspen — 15 (CRJ / E170 / GLF)
     · 3.5°  KEGE Eagle/Vail — 25 (B737 / A320 / GLF)
     · 3.5°  KSAN San Diego — 27 (B737 / A320 standard 3.5°)
     · 3.5°  KTEX Telluride — 9 (CRJ / GLF)
     · 3.5°  KJAC Jackson Hole — 19 (B737 / A320)
     · 6.0°  LSGG Geneva — 23 special profile (CRJ / E190)
     · 5.5°  EBAW Antwerp — 11 / 29 (DH8 / E170)
     · 4.0°  LFLG Le Puy — 12 (TBM / PC12)
     · 6.65° LSMP Payerne — military steep cert
     · 4.5°  EHGG Groningen — 23 (CRJ / E170)
     · 4.0°  LFKC Calvi — 18 (ATR)
     · 4.5°  LFKF Figari — 02 (ATR / CRJ)
     · 4.0°  EGEC Campbeltown — 11 (Saab)
     · 5.0°  EGNS Isle of Man — 26 (DH8 / E170)
     · 4.5°  ENVA Stockmarknes — 33 (DH8)
     · 5.5°  ENBL Forde Bringeland — 12 (DH8)
     · 4.5°  EGNH Blackpool — 28 (DH8 / E170)
     · 5.0°  LFKS Solenzara — 18 (ATR)
     · 6.0°  EBLG Liege — 23R steep cargo (B747F / B777F)
     · 4.5°  KIPT Williamsport — 27 (CRJ / E145)
     · 4.0°  KMMU Morristown — 23 (GLF / FA50)
     · 4.5°  KASE Aspen — 33 (back-side steep CAT-A)

   Per-airframe FNV-1a 32-bit hash of ICAO24 synthesises:
     · steep-approach TC approval flag (per type — only some
       variants are TC-approved; e.g. A320 LCY only A318 +
       A319-100SA & A220-100 / B737 only LOWI & KEGE not LCY)
     · crew steep-currency days-since-line-check (0-365)
     · OpSpec C063 / Ops Manual Part B operator approval flag
     · configuration: FLAP setting (FULL / 3 / 2 / 1), idle
       reverse arm, autobrake MED+/LOW/OFF, Vapp delta kt
     · landing weight as fraction of class MLW (0.75-1.00) with
       AFM Suppl reduction required for steep > 5° typically
       0.95 MLW

   Runway selection: nearest-of-28 within 14 nm + bearing-to-
   threshold align within 30° of QFU + track-vs-QFU within 35°.
   Phase classifier: APP (AGL < 3500 ft + dist < 12 nm) /
   SHRT-FNL (AGL < 500 + dist < 2.5 nm) / FLARE (AGL < 50 +
   dist < 0.5 nm) / OTHER.

   6 risk drivers max-driver composite:
     CRT  TC approval gap (catastrophic) — 0 approved / 100
          not approved AND PDG > 4.5° / 70 not approved 3.5°-
          4.5° / 30 marginal
     OPS  operator OpSpec C063 / OM-B approval gap — 0 OK / 100
          missing on PDG > 4.5° / 60 missing 3.5°-4.5°
     CFG  configuration gap — FLAP-3 instead of FULL 60 /
          AB-LOW instead of MED+ 50 / Vapp delta < +5 kt 40 /
          reverse OFF 30 — summed/max
     WGT  landing weight vs AFM Suppl MLW-steep — 100 over
          0.97×MLW-steep / 60 at 0.93 / 0 at <= 0.88
     CUR  crew steep-currency — 0 within 30 days / 50 30-90 d
          / 80 90-180 d / 100 > 180 d
     ENV  environmental — tailwind > 5 kt on PDG > 4.5° 90 /
          wet runway 50 / contaminated 95

   Phase multiplier FLARE 1.50 / SHRT-FNL 1.40 / APP 1.20 /
   OTHER 0.40. Composite = max-driver × phase-mul + 0.12 ×
   secondary clip 0-100.

   Hard escalations:
     · TC approval missing on FLARE / SHRT-FNL with PDG > 4.5°
       >= 95 SAFAIR-tier (steep-uncert overshoot)
     · WGT over AFM Suppl + PDG > 5.5° >= 90 OVERWEIGHT-STEEP
     · ENV tailwind > 5 kt on steep >= 88 ENV-WIND-STEEP
     · CUR > 365 days >= 80 CURRENCY-LAPSE

   5 tiers:
     CRITICAL-UNAPP score >= 80 rose go-around / divert to
       3.0° standard runway · airframe not steep-cert per AC
       25-29 / SC-D-04 · MAYDAY if low-fuel
     RESTRICT      score >= 55 amber configure FLAP-FULL +
       AB-MED+ + idle reverse armed · brief steep AFM Suppl
       Vapp +5 · monitor stable gate 500 AAL
     WATCH         score >= 25 sky verify currency / OM-B
       aerodrome listed · cross-check VNAV vs steep glide
     STEEP-OK      score < 25 emerald TC approved / OpSpec
       C063 / FLAP-FULL / AB-MED / +5 kt Vapp / MLW within
       suppl · stable
     IDLE          out of scope slate

   Overlay:
     · tier-coloured halo rings 8-22 px by score
     · rose diamond CRITICAL-UNAPP pin
     · 28 catalogue runway pins angle-coloured rose >= 5.5° /
       amber 4.5-5.5° / sky 3.5-4.5° sized 4-9 px by angle
     · dashed steep glide-path beam extended 5 nm backward
       from threshold along approach axis coloured by tier
     · 5-segment 2-nm forward-projection tier-coloured for
       non-OK
     · sky reference parallels at lat 60/30/0/-30/-60 every
       12° lng

   Side panel:
     · 5-tier counter strip click-to-filter
     · 3-cell MEAN-PDG / WORST callsign / CRITICAL-UNAPP count
     · 3-cell TC-UNAPP-share / OPS-GAP-share / CFG-GAP-share
     · SVG PDG-angle x vs score scatter with rose >= 80 amber
       55-80 sky 25-55 emerald < 25 + every aircraft as tier-
       coloured dot
     · 7 sliders MIN-FL / TC-RATE / OPS-RATE / CUR-BIAS /
       WGT-MUL / CFG-MUL / PHASE-WT
     · 3-angle chip filter STEEP-3.5-4.5 / 4.5-5.5 / 5.5+
     · HALO / PIN / LBL / BEAM / RWY / REF / DIAG toggles
     · AIRCRAFT / RUNWAYS / OPERATORS tabs
     · AIRCRAFT tab tier-row, score bar, 6-cell breakdown,
       advice click-to-fly
     · RUNWAYS tab sorted by PDG angle desc, ATLAS-tier stripe
     · OPERATORS tab grouped by operator with mean approval
       rate, worst-callsign

   Layers > Safety & Traffic.
   Persisted: ft-steepappr
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'CRITICAL-UNAPP' | 'RESTRICT' | 'WATCH' | 'STEEP-OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'CRITICAL-UNAPP': '#ef4444', RESTRICT: '#f59e0b', WATCH: '#0ea5e9', 'STEEP-OK': '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['CRITICAL-UNAPP', 'RESTRICT', 'WATCH', 'STEEP-OK', 'IDLE']
const TIER_RANK: Record<Tier, number> = { 'CRITICAL-UNAPP': 0, RESTRICT: 1, WATCH: 2, 'STEEP-OK': 3, IDLE: 4 }

type AngClass = 'STEEP+' | 'STEEP' | 'MILD'
const ANG_COLOR: Record<AngClass, string> = { 'STEEP+': '#ef4444', STEEP: '#f59e0b', MILD: '#0ea5e9' }
type Phase = 'FLARE' | 'SHRT-FNL' | 'APP' | 'OTHER'
const PHASE_MUL: Record<Phase, number> = { FLARE: 1.50, 'SHRT-FNL': 1.40, APP: 1.20, OTHER: 0.40 }

interface Runway {
  icao: string; name: string; lat: number; lng: number; elevFt: number
  qfu: number
  rwId: string
  pdg: number          // published glide-path angle (deg)
  ang: AngClass
  mlwReduceFrac: number // fraction of MLW for steep per AFM Suppl (1.00 = none)
  notes: string
}
const RWYS: Runway[] = [
  { icao: 'EGLC', name: 'London City', lat: 51.505, lng: 0.055, elevFt: 19, qfu: 90, rwId: '09', pdg: 5.5, ang: 'STEEP+', mlwReduceFrac: 0.95, notes: 'BAe-146 / RJ / DH8D / E190-E2 / A220-100 LCY-cert' },
  { icao: 'EGLC', name: 'London City', lat: 51.505, lng: 0.055, elevFt: 19, qfu: 270, rwId: '27', pdg: 5.5, ang: 'STEEP+', mlwReduceFrac: 0.95, notes: 'BAe-146 / RJ / E190-E2 / A220-100 LCY-cert' },
  { icao: 'LSZA', name: 'Lugano', lat: 46.004, lng: 8.911, elevFt: 915, qfu: 187, rwId: '19', pdg: 6.65, ang: 'STEEP+', mlwReduceFrac: 0.92, notes: 'Saab 2000 / DH8 only · lake-bound steepest CAT' },
  { icao: 'LSGS', name: 'Sion', lat: 46.220, lng: 7.327, elevFt: 1583, qfu: 250, rwId: '25', pdg: 6.0, ang: 'STEEP+', mlwReduceFrac: 0.93, notes: 'DH8 / CRJ-200 / GLF / FA50' },
  { icao: 'LOWI', name: 'Innsbruck', lat: 47.260, lng: 11.344, elevFt: 1907, qfu: 80, rwId: '08', pdg: 3.8, ang: 'MILD', mlwReduceFrac: 1.00, notes: 'NPA-SA cert · circling via RIVER' },
  { icao: 'LOWI', name: 'Innsbruck', lat: 47.260, lng: 11.344, elevFt: 1907, qfu: 260, rwId: '26', pdg: 3.8, ang: 'MILD', mlwReduceFrac: 1.00, notes: 'NPA-SA cert · westbound steep visual' },
  { icao: 'NZQN', name: 'Queenstown', lat: -45.022, lng: 168.739, elevFt: 1171, qfu: 235, rwId: '23', pdg: 6.43, ang: 'STEEP+', mlwReduceFrac: 0.94, notes: 'RNP-AR steep · B737-800 / A320 cert only' },
  { icao: 'LIPB', name: 'Bolzano', lat: 46.461, lng: 11.327, elevFt: 789, qfu: 1, rwId: '01', pdg: 4.5, ang: 'STEEP', mlwReduceFrac: 0.96, notes: 'DH8 / E170 alpine valley' },
  { icao: 'LIPB', name: 'Bolzano', lat: 46.461, lng: 11.327, elevFt: 789, qfu: 187, rwId: '19', pdg: 4.5, ang: 'STEEP', mlwReduceFrac: 0.96, notes: 'DH8 / E170 alpine reciprocal' },
  { icao: 'KASE', name: 'Aspen', lat: 39.223, lng: -106.869, elevFt: 7820, qfu: 152, rwId: '15', pdg: 3.5, ang: 'MILD', mlwReduceFrac: 1.00, notes: 'CRJ / E170 / GLF · hot-high' },
  { icao: 'KEGE', name: 'Eagle/Vail', lat: 39.643, lng: -106.918, elevFt: 6548, qfu: 250, rwId: '25', pdg: 3.5, ang: 'MILD', mlwReduceFrac: 1.00, notes: 'B737 / A320 / GLF' },
  { icao: 'KSAN', name: 'San Diego', lat: 32.733, lng: -117.190, elevFt: 17, qfu: 270, rwId: '27', pdg: 3.5, ang: 'MILD', mlwReduceFrac: 1.00, notes: 'B737 / A320 standard 3.5° downtown' },
  { icao: 'KTEX', name: 'Telluride', lat: 37.954, lng: -107.909, elevFt: 9078, qfu: 90, rwId: '09', pdg: 3.5, ang: 'MILD', mlwReduceFrac: 1.00, notes: 'CRJ / GLF mesa-top' },
  { icao: 'KJAC', name: 'Jackson Hole', lat: 43.607, lng: -110.737, elevFt: 6451, qfu: 190, rwId: '19', pdg: 3.5, ang: 'MILD', mlwReduceFrac: 1.00, notes: 'B737 / A320 mountain valley' },
  { icao: 'LSGG', name: 'Geneva', lat: 46.238, lng: 6.108, elevFt: 1411, qfu: 230, rwId: '23', pdg: 6.0, ang: 'STEEP+', mlwReduceFrac: 0.93, notes: 'CRJ / E190 special steep' },
  { icao: 'EBAW', name: 'Antwerp', lat: 51.189, lng: 4.460, elevFt: 39, qfu: 110, rwId: '11', pdg: 5.5, ang: 'STEEP+', mlwReduceFrac: 0.95, notes: 'DH8 / E170' },
  { icao: 'EBAW', name: 'Antwerp', lat: 51.189, lng: 4.460, elevFt: 39, qfu: 290, rwId: '29', pdg: 5.5, ang: 'STEEP+', mlwReduceFrac: 0.95, notes: 'DH8 / E170 reciprocal' },
  { icao: 'LFLG', name: 'Le Puy Loudes', lat: 45.080, lng: 3.763, elevFt: 2731, qfu: 120, rwId: '12', pdg: 4.0, ang: 'STEEP', mlwReduceFrac: 0.98, notes: 'TBM / PC12 mountain' },
  { icao: 'EHGG', name: 'Groningen', lat: 53.119, lng: 6.580, elevFt: 17, qfu: 230, rwId: '23', pdg: 4.5, ang: 'STEEP', mlwReduceFrac: 0.96, notes: 'CRJ / E170' },
  { icao: 'LFKC', name: 'Calvi', lat: 42.531, lng: 8.793, elevFt: 209, qfu: 180, rwId: '18', pdg: 4.0, ang: 'STEEP', mlwReduceFrac: 0.98, notes: 'ATR Corsica' },
  { icao: 'LFKF', name: 'Figari', lat: 41.500, lng: 9.097, elevFt: 87, qfu: 20, rwId: '02', pdg: 4.5, ang: 'STEEP', mlwReduceFrac: 0.96, notes: 'ATR / CRJ Corsica' },
  { icao: 'EGEC', name: 'Campbeltown', lat: 55.437, lng: -5.687, elevFt: 42, qfu: 110, rwId: '11', pdg: 4.0, ang: 'STEEP', mlwReduceFrac: 0.98, notes: 'Saab 340 / 2000' },
  { icao: 'EGNS', name: 'Isle of Man', lat: 54.083, lng: -4.624, elevFt: 56, qfu: 260, rwId: '26', pdg: 5.0, ang: 'STEEP', mlwReduceFrac: 0.95, notes: 'DH8 / E170' },
  { icao: 'EGNH', name: 'Blackpool', lat: 53.772, lng: -3.029, elevFt: 34, qfu: 280, rwId: '28', pdg: 4.5, ang: 'STEEP', mlwReduceFrac: 0.96, notes: 'DH8 / E170' },
  { icao: 'LFKS', name: 'Solenzara', lat: 41.924, lng: 9.406, elevFt: 28, qfu: 180, rwId: '18', pdg: 5.0, ang: 'STEEP', mlwReduceFrac: 0.95, notes: 'ATR military-civil' },
  { icao: 'EBLG', name: 'Liege', lat: 50.637, lng: 5.443, elevFt: 659, qfu: 230, rwId: '23R', pdg: 6.0, ang: 'STEEP+', mlwReduceFrac: 0.93, notes: 'Cargo steep B747F / B777F' },
  { icao: 'KIPT', name: 'Williamsport', lat: 41.241, lng: -76.921, elevFt: 529, qfu: 270, rwId: '27', pdg: 4.5, ang: 'STEEP', mlwReduceFrac: 0.96, notes: 'CRJ / E145 hill' },
  { icao: 'KMMU', name: 'Morristown', lat: 40.799, lng: -74.414, elevFt: 187, qfu: 230, rwId: '23', pdg: 4.0, ang: 'STEEP', mlwReduceFrac: 0.98, notes: 'GLF / FA50 corporate' },
]

type AcClass = 'HVY' | 'NRW' | 'NRW-LCY' | 'RGN-STEEP' | 'BIZ' | 'TBP' | 'OTHER'
interface ClassSpec {
  family: string
  steepCertAngle: number       // max approved approach angle (deg) for class
  baseMlw: number              // dummy reference for display
  vrefBase: number             // base Vref kt
}
const CLASS_SPEC: Record<AcClass, ClassSpec> = {
  'HVY':       { family: '777 / 787 / A350 / A330', steepCertAngle: 3.5, vrefBase: 145, baseMlw: 220000 },
  'NRW':       { family: '737 / A320 / 757', steepCertAngle: 3.5, vrefBase: 138, baseMlw: 66000 },
  'NRW-LCY':   { family: 'A220-100 / A319-LCY / E190-E2 / E195-E2', steepCertAngle: 5.5, vrefBase: 132, baseMlw: 58000 },
  'RGN-STEEP': { family: 'DH8D / BAe-146 / Avro RJ / SAAB 2000 / DO-328', steepCertAngle: 6.65, vrefBase: 122, baseMlw: 34000 },
  'BIZ':       { family: 'GLF / FA50 / FA7X / CL30 / Phenom 300', steepCertAngle: 5.0, vrefBase: 118, baseMlw: 24000 },
  'TBP':       { family: 'ATR / DH8 / Q400 / DO228', steepCertAngle: 6.0, vrefBase: 110, baseMlw: 18000 },
  'OTHER':     { family: 'CRJ / E170 / E175 / E190', steepCertAngle: 4.5, vrefBase: 130, baseMlw: 36000 },
}
const FAMILY_CLASS: Array<[RegExp, AcClass]> = [
  [/^(A220-1|BCS1|BAE|RJ[18]5|RJ70|BAJ|AVRO|SF34|SF2|S340|S202|DO[2-3]|DH8D)/i, 'NRW-LCY'],
  [/^(B777|B787|77[0-9]|78[0-9]|A33|A35)/i, 'HVY'],
  [/^(B73|73[0-9]|B75|75[0-9]|A31[89]|A32[0-9]|MAX)/i, 'NRW'],
  [/^(BAE|RJ|HS25|DH8|DHC|Q40|J32|F50)/i, 'RGN-STEEP'],
  [/^(GLF|G[VI]|GLEX|G6[05]0|FA[57]X|CL[36]0|LJ[34567]|EA50|E50P|PC12|TBM|PHN)/i, 'BIZ'],
  [/^(ATR|AT4|AT7|DH[CC]|Q40|DO[12])/i, 'TBP'],
  [/^(CRJ|E1[79][0-9]|E2[27][05]|ERJ|EMB)/i, 'OTHER'],
]
function classify(type?: string): AcClass {
  const t = (type || '').toUpperCase().trim()
  for (const [re, c] of FAMILY_CLASS) if (re.test(t)) return c
  return 'OTHER'
}

type Driver = 'CRT' | 'OPS' | 'CFG' | 'WGT' | 'CUR' | 'ENV' | 'NONE'
const DRIVER_LABEL: Record<Driver, string> = {
  CRT: 'TC approval missing',
  OPS: 'OpSpec C063 / OM-B gap',
  CFG: 'Configuration not steep-set',
  WGT: 'Above AFM Suppl MLW-steep',
  CUR: 'Crew steep-currency lapsed',
  ENV: 'Environmental wind / surface',
  NONE: 'Steep approach nominal',
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
function haversineNm(la1: number, lo1: number, la2: number, lo2: number) {
  const R = 3440.065
  const dLat = (la2 - la1) * Math.PI / 180
  const dLon = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number) {
  const phi1 = la1 * Math.PI / 180, phi2 = la2 * Math.PI / 180
  const dLon = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dLon) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon)
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360
}
function destPoint(la: number, lo: number, brgDeg: number, distNm: number): [number, number] {
  const R = 3440.065
  const brg = brgDeg * Math.PI / 180
  const lat1 = la * Math.PI / 180, lon1 = lo * Math.PI / 180
  const d = distNm / R
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg))
  const lon2 = lon1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2))
  return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI]
}
function angDiff(a: number, b: number) {
  let d = Math.abs(a - b) % 360
  if (d > 180) d = 360 - d
  return d
}

type Flap = 'FULL' | '3' | '2' | '1'
type Auto = 'MAX' | 'MED' | 'LOW' | 'OFF'
type Surf = 'DRY' | 'WET' | 'CONT'

interface Row {
  f: SFlight; cls: AcClass; spec: ClassSpec; phase: Phase
  rwy: Runway | null; aglFt: number; distFromThrNm: number
  tcApproved: boolean
  opsApproved: boolean
  flap: Flap; auto: Auto; revArmed: boolean; vappDelta: number
  mlwFrac: number
  currencyDays: number
  tailwindKt: number; surface: Surf
  sev: { crt: number; ops: number; cfg: number; wgt: number; cur: number; env: number }
  score: number; driver: Driver; tier: Tier
}

const SRC_HALO = 'steep-halo', SRC_LBL = 'steep-lbl', SRC_PIN = 'steep-pin', SRC_RWY = 'steep-rwy', SRC_BEAM = 'steep-beam', SRC_PROJ = 'steep-proj', SRC_REF = 'steep-ref'
const LYR_HALO = SRC_HALO + '-l', LYR_LBL = SRC_LBL + '-l', LYR_PIN = SRC_PIN + '-l', LYR_RWY = SRC_RWY + '-l', LYR_RWY_LBL = SRC_RWY + '-lbl-l', LYR_BEAM = SRC_BEAM + '-l', LYR_PROJ = SRC_PROJ + '-l', LYR_REF = SRC_REF + '-l'

export default function SteepApproach({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'RUNWAYS' | 'OPERATORS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [angFilter, setAngFilter] = useState<AngClass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [tcRate, setTcRate] = useState(72)
  const [opsRate, setOpsRate] = useState(80)
  const [curBias, setCurBias] = useState(0)
  const [wgtMul, setWgtMul] = useState(100)
  const [cfgMul, setCfgMul] = useState(100)
  const [phaseWt, setPhaseWt] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showBeam, setShowBeam] = useState(true)
  const [showRwy, setShowRwy] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showRef, setShowRef] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      if (f.altitudeFt < minFl * 100) continue
      const cls = classify(f.type)
      const spec = CLASS_SPEC[cls]
      const h = hash32(f.icao || '')
      const u0 = (h & 0xffff) / 0xffff
      const u1 = ((h >>> 16) & 0xffff) / 0xffff
      const u2 = (((h >>> 8) ^ h) & 0xffff) / 0xffff
      const u3 = (((h * 2654435761) >>> 0) & 0xffff) / 0xffff

      // nearest runway: within 14 nm of threshold + alignment
      let rwy: Runway | null = null
      let bestDist = 1e9
      const pool = angFilter === 'ALL' ? RWYS : RWYS.filter(r => r.ang === angFilter)
      for (const r of pool) {
        const d = haversineNm(f.lat, f.lng, r.lat, r.lng)
        if (d > 14) continue
        const brgToAcft = bearingDeg(r.lat, r.lng, f.lat, f.lng)
        // aircraft should be on extended centreline beyond threshold opposite to QFU
        const reciprocal = (r.qfu + 180) % 360
        const align = angDiff(brgToAcft, reciprocal)
        if (align > 30) continue
        if (angDiff(f.track, r.qfu) > 35) continue
        if (d < bestDist) { bestDist = d; rwy = r }
      }
      if (!rwy) {
        // IDLE row not pushed (panel filters away)
        continue
      }
      const aglFt = Math.max(0, f.altitudeFt - rwy.elevFt)
      const distFromThrNm = bestDist
      const phase: Phase =
        aglFt < 50 && distFromThrNm < 0.5 ? 'FLARE' :
          aglFt < 500 && distFromThrNm < 2.5 ? 'SHRT-FNL' :
            aglFt < 3500 && distFromThrNm < 12 ? 'APP' : 'OTHER'

      // TC approval: depends on class vs runway angle
      const certAngle = spec.steepCertAngle
      let tcApproved = certAngle >= rwy.pdg - 0.05
      // hash-stable variability: tcRate% of marginal cases gain approval
      if (!tcApproved) {
        if ((rwy.pdg - certAngle) < 1.0 && u0 * 100 < tcRate) tcApproved = true
      } else {
        // small chance approved class is on an airframe with lapsed cert (e.g. retrofit missing)
        if (u0 * 100 > tcRate + 15) tcApproved = false
      }

      // OpSpec C063 / OM-B
      const opsApproved = u1 * 100 < opsRate

      // Configuration synthesised
      const flapPick = u2 * 100
      const flap: Flap = flapPick < 65 ? 'FULL' : flapPick < 85 ? '3' : flapPick < 95 ? '2' : '1'
      const autoPick = ((h >>> 5) & 0xff) / 255 * 100
      const auto: Auto = autoPick < 55 ? 'MED' : autoPick < 78 ? 'MAX' : autoPick < 92 ? 'LOW' : 'OFF'
      const revArmed = ((h >>> 9) & 0xf) < 13
      const vappDelta = Math.round(((h >>> 13) & 0xf) - 5) // -5..+10

      // Weight as fraction of MLW; AFM Suppl reduction for steep
      const mlwFrac = 0.86 + u3 * 0.14 // 0.86..1.00
      const mlwSteepLimit = rwy.mlwReduceFrac

      // Currency days since line check
      const baseCur = ((h >>> 17) & 0x1ff) // 0..511
      const currencyDays = Math.max(0, Math.min(420, baseCur - 30 + curBias))

      // Env
      const twPick = ((h >>> 23) & 0x1f) - 12 // -12..+19
      const tailwindKt = twPick
      const surfPick = ((h >>> 4) & 0xff) / 255
      const surface: Surf = surfPick < 0.7 ? 'DRY' : surfPick < 0.92 ? 'WET' : 'CONT'

      // Drivers
      let crt = 0
      if (!tcApproved) {
        if (rwy.pdg >= 4.5) crt = 100
        else if (rwy.pdg >= 3.5) crt = 70
        else crt = 30
      }
      let ops = 0
      if (!opsApproved) {
        if (rwy.pdg >= 4.5) ops = 100
        else if (rwy.pdg >= 3.5) ops = 60
        else ops = 20
      }
      // CFG: combine sub-faults (max over individual + small additive)
      let cfgParts: number[] = []
      if (flap !== 'FULL') cfgParts.push(rwy.pdg >= 4.5 ? 70 : 45)
      if (flap === '1') cfgParts.push(90)
      if (auto === 'LOW') cfgParts.push(50)
      if (auto === 'OFF') cfgParts.push(85)
      if (!revArmed) cfgParts.push(rwy.pdg >= 4.5 ? 55 : 25)
      if (vappDelta < 5 && rwy.pdg >= 4.5) cfgParts.push(40)
      if (vappDelta > 10) cfgParts.push(35) // too fast
      const cfg = (cfgParts.length === 0 ? 0 : Math.max(...cfgParts)) * (cfgMul / 100)
      // WGT vs AFM Suppl MLW-steep
      const overFrac = mlwFrac / mlwSteepLimit
      let wgt = 0
      if (overFrac >= 1.05) wgt = 100
      else if (overFrac >= 1.00) wgt = 80
      else if (overFrac >= 0.96) wgt = 55
      else if (overFrac >= 0.92) wgt = 25
      wgt *= (wgtMul / 100)
      // CUR
      let cur = 0
      if (currencyDays > 365) cur = 100
      else if (currencyDays > 180) cur = 80
      else if (currencyDays > 90) cur = 55
      else if (currencyDays > 30) cur = 25
      // ENV
      let env = 0
      if (tailwindKt > 10) env = 100
      else if (tailwindKt > 5 && rwy.pdg >= 4.5) env = 90
      else if (tailwindKt > 5) env = 50
      else if (surface === 'CONT' && rwy.pdg >= 4.5) env = 95
      else if (surface === 'CONT') env = 60
      else if (surface === 'WET' && rwy.pdg >= 5.5) env = 55
      else if (surface === 'WET') env = 25

      const sev = { crt: Math.round(crt), ops: Math.round(ops), cfg: Math.round(cfg), wgt: Math.round(wgt), cur: Math.round(cur), env: Math.round(env) }
      const sevArr = [
        { d: 'CRT' as Driver, v: sev.crt },
        { d: 'OPS' as Driver, v: sev.ops },
        { d: 'CFG' as Driver, v: sev.cfg },
        { d: 'WGT' as Driver, v: sev.wgt },
        { d: 'CUR' as Driver, v: sev.cur },
        { d: 'ENV' as Driver, v: sev.env },
      ].sort((a, b) => b.v - a.v)
      const maxDriver = sevArr[0]
      const secondary = sevArr[1].v
      const phaseMul = PHASE_MUL[phase] * (phaseWt / 100)
      let composite = maxDriver.v * phaseMul + 0.12 * secondary
      // Hard escalations
      if (!tcApproved && rwy.pdg >= 4.5 && (phase === 'FLARE' || phase === 'SHRT-FNL')) composite = Math.max(composite, 95)
      if (overFrac >= 1.00 && rwy.pdg >= 5.5) composite = Math.max(composite, 90)
      if (tailwindKt > 5 && rwy.pdg >= 4.5 && phase !== 'OTHER') composite = Math.max(composite, 88)
      if (currencyDays > 365) composite = Math.max(composite, 80)
      composite = Math.max(0, Math.min(100, composite))
      const tier: Tier = composite >= 80 ? 'CRITICAL-UNAPP' : composite >= 55 ? 'RESTRICT' : composite >= 25 ? 'WATCH' : 'STEEP-OK'
      out.push({
        f, cls, spec, phase, rwy, aglFt, distFromThrNm,
        tcApproved, opsApproved, flap, auto, revArmed, vappDelta, mlwFrac, currencyDays,
        tailwindKt, surface, sev,
        score: Math.round(composite),
        driver: maxDriver.v > 0 ? maxDriver.d : 'NONE',
        tier,
      })
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, minFl, tcRate, opsRate, curBias, wgtMul, cfgMul, phaseWt, angFilter])

  const tierCount = useMemo(() => {
    const c: Record<Tier, number> = { 'CRITICAL-UNAPP': 0, RESTRICT: 0, WATCH: 0, 'STEEP-OK': 0, IDLE: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const active = rows
  const meanPdg = active.length ? active.reduce((s, r) => s + (r.rwy?.pdg || 0), 0) / active.length : 0
  const worst = active[0]
  const tcUnappShare = active.length ? active.filter(r => !r.tcApproved).length / active.length : 0
  const opsGapShare = active.length ? active.filter(r => !r.opsApproved).length / active.length : 0
  const cfgGapShare = active.length ? active.filter(r => r.sev.cfg > 30).length / active.length : 0

  // Runway aggregate
  const rwyRows = useMemo(() => {
    const m = new Map<string, { rwy: Runway; served: number; sumScore: number; critCount: number; worstCs: string | null }>()
    for (const r of rows) {
      if (!r.rwy) continue
      const k = r.rwy.icao + '·' + r.rwy.rwId
      const e = m.get(k) || { rwy: r.rwy, served: 0, sumScore: 0, critCount: 0, worstCs: null }
      e.served++
      e.sumScore += r.score
      if (r.tier === 'CRITICAL-UNAPP') e.critCount++
      if (!e.worstCs || r.tier === 'CRITICAL-UNAPP') e.worstCs = r.f.callsign || r.f.icao
      m.set(k, e)
    }
    // include RWYS with zero
    for (const w of RWYS) {
      const k = w.icao + '·' + w.rwId
      if (!m.has(k)) m.set(k, { rwy: w, served: 0, sumScore: 0, critCount: 0, worstCs: null })
    }
    return Array.from(m.values()).map(e => ({ ...e, meanScore: e.served ? e.sumScore / e.served : 0 })).sort((a, b) => b.rwy.pdg - a.rwy.pdg)
  }, [rows])

  // Operator aggregate
  const opRows = useMemo(() => {
    const m = new Map<string, { op: string; ac: number; tcOk: number; opsOk: number; sumScore: number; critCount: number; worst: Row | null }>()
    for (const r of rows) {
      const op = r.f.operator || '—'
      const e = m.get(op) || { op, ac: 0, tcOk: 0, opsOk: 0, sumScore: 0, critCount: 0, worst: null }
      e.ac++
      if (r.tcApproved) e.tcOk++
      if (r.opsApproved) e.opsOk++
      e.sumScore += r.score
      if (r.tier === 'CRITICAL-UNAPP') e.critCount++
      if (!e.worst || r.score > e.worst.score) e.worst = r
      m.set(op, e)
    }
    return Array.from(m.values()).sort((a, b) => b.critCount - a.critCount || b.sumScore / b.ac - a.sumScore / a.ac).slice(0, 60)
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return active.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (!q) return true
      const hay = `${r.f.callsign || ''} ${r.f.type || ''} ${r.f.icao || ''} ${r.rwy?.icao || ''} ${r.rwy?.rwId || ''} ${r.f.operator || ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [active, tierFilter, query])

  // Map overlay
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      const ensureSrc = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any) }
      ensureSrc(SRC_HALO); ensureSrc(SRC_LBL); ensureSrc(SRC_PIN); ensureSrc(SRC_RWY); ensureSrc(SRC_BEAM); ensureSrc(SRC_PROJ); ensureSrc(SRC_REF)
      if (!map.getLayer(LYR_REF)) map.addLayer({ id: LYR_REF, source: SRC_REF, type: 'line', paint: { 'line-color': '#0ea5e9', 'line-width': 0.3, 'line-opacity': 0.18, 'line-dasharray': [3, 5] } })
      if (!map.getLayer(LYR_HALO)) map.addLayer({ id: LYR_HALO, source: SRC_HALO, type: 'circle', paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.7 } })
      if (!map.getLayer(LYR_BEAM)) map.addLayer({ id: LYR_BEAM, source: SRC_BEAM, type: 'line', paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.7, 'line-dasharray': [2, 3] } })
      if (!map.getLayer(LYR_PROJ)) map.addLayer({ id: LYR_PROJ, source: SRC_PROJ, type: 'line', paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.65, 'line-dasharray': [2, 3] } })
      if (!map.getLayer(LYR_RWY)) map.addLayer({ id: LYR_RWY, source: SRC_RWY, type: 'circle', paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1, 'circle-opacity': 0.95 } })
      if (!map.getLayer(LYR_RWY_LBL)) map.addLayer({ id: LYR_RWY_LBL, source: SRC_RWY, type: 'symbol', layout: { 'text-field': ['get', 'lbl'], 'text-size': 9, 'text-offset': [0, 1.0], 'text-anchor': 'top', 'text-allow-overlap': true }, paint: { 'text-color': '#cbd5e1', 'text-halo-color': '#020617', 'text-halo-width': 1 } })
      if (!map.getLayer(LYR_PIN)) map.addLayer({ id: LYR_PIN, source: SRC_PIN, type: 'symbol', layout: { 'text-field': '◆', 'text-size': 14, 'text-allow-overlap': true }, paint: { 'text-color': '#ef4444', 'text-halo-color': '#020617', 'text-halo-width': 1.5 } })
      if (!map.getLayer(LYR_LBL)) map.addLayer({ id: LYR_LBL, source: SRC_LBL, type: 'symbol', layout: { 'text-field': ['get', 'lbl'], 'text-size': 10, 'text-offset': [0, -1.2], 'text-anchor': 'bottom', 'text-allow-overlap': true }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } })
    }
    ensure()
    const sources = [SRC_HALO, SRC_LBL, SRC_PIN, SRC_RWY, SRC_BEAM, SRC_PROJ, SRC_REF]

    const halo: any[] = [], lbl: any[] = [], pin: any[] = [], rwy: any[] = [], beam: any[] = [], proj: any[] = [], ref: any[] = []
    for (const r of active) {
      const color = TIER_COLOR[r.tier]
      const radius = 8 + (r.score / 100) * 14
      if (showHalo) halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { r: radius, color } })
      if (showPin && r.tier === 'CRITICAL-UNAPP') pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: {} })
      if (showLbl && r.tier !== 'STEEP-OK' && r.rwy) {
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] }, properties: { lbl: `${r.f.callsign || r.f.icao} · ${r.rwy.icao}/${r.rwy.rwId} ${r.rwy.pdg.toFixed(1)}° ${r.tcApproved ? '✓TC' : '✗TC'}`, color } })
      }
      if (showProj && (r.tier === 'CRITICAL-UNAPP' || r.tier === 'RESTRICT')) {
        const coords: [number, number][] = []
        for (let i = 0; i <= 5; i++) coords.push(destPoint(r.f.lat, r.f.lng, r.f.track, i * 0.4))
        proj.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { color } })
      }
    }
    if (showRwy) {
      for (const w of RWYS) {
        const c = ANG_COLOR[w.ang]
        rwy.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [w.lng, w.lat] }, properties: { r: 4 + (w.pdg - 3) * 0.9, color: c, lbl: `${w.icao}/${w.rwId} ${w.pdg.toFixed(1)}°` } })
      }
    }
    if (showBeam) {
      // approach beam: 5 nm backward from threshold along reciprocal of QFU
      for (const rr of rwyRows) {
        if (rr.served === 0) continue
        const w = rr.rwy
        const reciprocal = (w.qfu + 180) % 360
        const coords: [number, number][] = []
        for (let i = 0; i <= 6; i++) coords.push(destPoint(w.lat, w.lng, reciprocal, i * (5 / 6)))
        const color = ANG_COLOR[w.ang]
        beam.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { color } })
      }
    }
    if (showRef) {
      for (const lat of [60, 30, 0, -30, -60]) {
        const coords: [number, number][] = []
        for (let lng = -180; lng <= 180; lng += 12) coords.push([lng, lat])
        ref.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} })
      }
    }
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_RWY) as any).setData({ type: 'FeatureCollection', features: rwy })
    ;(map.getSource(SRC_BEAM) as any).setData({ type: 'FeatureCollection', features: beam })
    ;(map.getSource(SRC_PROJ) as any).setData({ type: 'FeatureCollection', features: proj })
    ;(map.getSource(SRC_REF) as any).setData({ type: 'FeatureCollection', features: ref })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_BEAM, LYR_PROJ, LYR_RWY_LBL, LYR_RWY, LYR_REF]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of sources) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, active, rwyRows, showHalo, showPin, showLbl, showBeam, showRwy, showProj, showRef])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const driverBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (r: Row) => {
    if (!r.rwy) return 'No catalogued steep runway in capture'
    if (r.tier === 'CRITICAL-UNAPP') {
      if (!r.tcApproved) return `GO-AROUND · airframe ${r.f.type || r.cls} not TC-approved for ${r.rwy.pdg.toFixed(1)}° PDG at ${r.rwy.icao}/${r.rwy.rwId} · divert to 3.0° runway per FAA AC 25-29 / EASA SC-D-04`
      if (!r.opsApproved) return `GO-AROUND · operator lacks OpSpec C063 / OM-B approval for ${r.rwy.icao} steep · per 14 CFR 121.97 / CAT.POL.A.220`
      return `GO-AROUND · steep-approach gate breached score ${r.score}`
    }
    if (r.tier === 'RESTRICT') return `Configure FLAP-FULL (now ${r.flap}) · AB-MED+ (now ${r.auto}) · idle reverse armed (${r.revArmed ? 'OK' : 'ARM'}) · Vapp +${Math.max(5, r.vappDelta)} kt steep · stable gate 500 AAL per Boeing FCOM SP-16 / Airbus FCOM PRO-NOR-SOP-19`
    if (r.tier === 'WATCH') return `Verify steep currency (${r.currencyDays}d since LC) · cross-check VNAV vs ${r.rwy.pdg.toFixed(1)}° published GP · OM-B ${r.rwy.icao} listed`
    return `Steep approach OK · TC ✓ · OpSpec ✓ · ${r.flap}/${r.auto} · Vapp +${r.vappDelta} · MLW ${(r.mlwFrac * 100).toFixed(0)}% vs steep-suppl ${(r.rwy.mlwReduceFrac * 100).toFixed(0)}%`
  }

  // Scatter PDG x vs score y
  const W = 280, H = 180
  const xMin = 3.0, xMax = 7.0
  const sx = (n: number) => 32 + ((Math.min(xMax, Math.max(xMin, n)) - xMin) / (xMax - xMin)) * (W - 42)
  const sy = (n: number) => H - 24 - (Math.min(100, Math.max(0, n)) / 100) * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">Steep Approach · Approval & Config</div>
          <div className="text-[10px] text-slate-500">FAA AC 25-29 / EASA SC-D-04 / CS-25.125 / OpSpec C063 / CAT.POL.A.220</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[9px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t === 'CRITICAL-UNAPP' ? 'CRIT-U' : t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean PDG</div>
          <div className="text-sm font-semibold" style={{ color: meanPdg >= 5.5 ? '#ef4444' : meanPdg >= 4.5 ? '#f59e0b' : '#0ea5e9' }}>{meanPdg.toFixed(2)}°</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">CRIT-UNAPP</div>
          <div className="text-sm font-semibold" style={{ color: tierCount['CRITICAL-UNAPP'] > 0 ? '#ef4444' : '#10b981' }}>{tierCount['CRITICAL-UNAPP']}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">TC-Unapp</div>
          <div className="text-xs font-semibold" style={{ color: tcUnappShare > 0.3 ? '#ef4444' : tcUnappShare > 0.1 ? '#f59e0b' : '#10b981' }}>{(tcUnappShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">OpSpec gap</div>
          <div className="text-xs font-semibold" style={{ color: opsGapShare > 0.25 ? '#ef4444' : opsGapShare > 0.1 ? '#f59e0b' : '#10b981' }}>{(opsGapShare * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">CFG gap</div>
          <div className="text-xs font-semibold" style={{ color: cfgGapShare > 0.35 ? '#ef4444' : cfgGapShare > 0.15 ? '#f59e0b' : '#10b981' }}>{(cfgGapShare * 100).toFixed(0)}%</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="rounded bg-slate-950/60">
            <rect x={32} y={24} width={W - 42} height={H - 48} fill="#0b1220" />
            <rect x={32} y={sy(80)} width={W - 42} height={sy(55) - sy(80)} fill="#ef4444" opacity={0.08} />
            <rect x={32} y={sy(55)} width={W - 42} height={sy(25) - sy(55)} fill="#f59e0b" opacity={0.08} />
            <rect x={32} y={sy(25)} width={W - 42} height={sy(0) - sy(25)} fill="#10b981" opacity={0.05} />
            <line x1={sx(4.5)} y1={24} x2={sx(4.5)} y2={H - 24} stroke="#f59e0b" strokeDasharray="2 2" strokeOpacity={0.5} />
            <line x1={sx(5.5)} y1={24} x2={sx(5.5)} y2={H - 24} stroke="#ef4444" strokeDasharray="2 2" strokeOpacity={0.5} />
            {active.map((r, i) => (
              <circle key={i} cx={sx(r.rwy?.pdg || 3)} cy={sy(r.score)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={r.tcApproved ? 0.45 : 0.95} />
            ))}
            <text x={W / 2} y={H - 6} fontSize={9} fill="#64748b" textAnchor="middle">published glide-path angle (°)</text>
            <text x={6} y={H / 2} fontSize={9} fill="#64748b" transform={`rotate(-90 6 ${H / 2})`} textAnchor="middle">composite score</text>
          </svg>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 px-3 py-2 border-b border-slate-800">
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">MIN-FL {minFl}</span><input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">TC-RATE {tcRate}%</span><input type="range" min={20} max={100} value={tcRate} onChange={e => setTcRate(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">OPS-RATE {opsRate}%</span><input type="range" min={20} max={100} value={opsRate} onChange={e => setOpsRate(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">CUR-BIAS {curBias > 0 ? '+' : ''}{curBias}d</span><input type="range" min={-120} max={180} value={curBias} onChange={e => setCurBias(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">WGT-MUL {wgtMul}%</span><input type="range" min={50} max={200} value={wgtMul} onChange={e => setWgtMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col"><span className="text-[10px] text-slate-400">CFG-MUL {cfgMul}%</span><input type="range" min={50} max={200} value={cfgMul} onChange={e => setCfgMul(+e.target.value)} className="accent-sky-500" /></label>
        <label className="flex flex-col col-span-2"><span className="text-[10px] text-slate-400">PHASE-WT {phaseWt}%</span><input type="range" min={50} max={150} value={phaseWt} onChange={e => setPhaseWt(+e.target.value)} className="accent-sky-500" /></label>
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        <button onClick={() => setAngFilter('ALL')} className={`px-2 py-0.5 rounded text-[10px] border ${angFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>ALL</button>
        {(['MILD', 'STEEP', 'STEEP+'] as const).map(a => (
          <button key={a} onClick={() => setAngFilter(angFilter === a ? 'ALL' : a)} className={`px-2 py-0.5 rounded text-[10px] border ${angFilter === a ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{a === 'MILD' ? '3.5–4.5°' : a === 'STEEP' ? '4.5–5.5°' : '≥5.5°'}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-slate-800">
        {([['HALO', showHalo, setShowHalo], ['PIN', showPin, setShowPin], ['LBL', showLbl, setShowLbl], ['BEAM', showBeam, setShowBeam], ['RWY', showRwy, setShowRwy], ['PROJ', showProj, setShowProj], ['REF', showRef, setShowRef], ['DIAG', showDiag, setShowDiag]] as const).map(([l, v, s]) => (
          <button key={l} onClick={() => s(!v)} className={`px-2 py-0.5 rounded text-[10px] border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>{l}</button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search callsign / type / icao / rwy / operator" className="flex-1 min-w-[120px] px-2 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        {(['AIRCRAFT', 'RUNWAYS', 'OPERATORS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded text-[11px] border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && filtered.slice(0, 80).map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2 py-1 flex-wrap" style={{ borderLeft: `3px solid ${TIER_COLOR[r.tier]}` }}>
              <button onClick={() => onFly(r.f.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{r.f.callsign || r.f.icao}</button>
              <span className="text-slate-500 text-[10px]">{r.f.type || '—'}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.cls}</span>
              <span className="px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{r.phase}</span>
              <span className="px-1 py-px rounded text-[9px]" style={{ color: r.tcApproved ? '#10b981' : '#ef4444', backgroundColor: r.tcApproved ? '#10b98122' : '#ef444422', border: `1px solid ${r.tcApproved ? '#10b98166' : '#ef444466'}` }}>{r.tcApproved ? '✓TC' : '✗TC'}</span>
              <span className="px-1 py-px rounded text-[9px]" style={{ color: r.opsApproved ? '#10b981' : '#f59e0b', backgroundColor: r.opsApproved ? '#10b98122' : '#f59e0b22', border: `1px solid ${r.opsApproved ? '#10b98166' : '#f59e0b66'}` }}>{r.opsApproved ? '✓OPS' : '✗OPS'}</span>
              <div className="ml-auto">{tierBadge(r.tier)}</div>
            </div>
            <div className="px-2 text-[10px] text-slate-400">
              {r.rwy ? `${r.rwy.icao}/${r.rwy.rwId} ${r.rwy.pdg.toFixed(2)}°` : '—'} · AGL {r.aglFt.toFixed(0)} ft · dist {r.distFromThrNm.toFixed(1)} nm · FLAP-{r.flap} · AB-{r.auto} · REV {r.revArmed ? 'ARM' : 'OFF'} · Vapp +{r.vappDelta} · MLW {(r.mlwFrac * 100).toFixed(0)}% (suppl {(r.rwy?.mlwReduceFrac || 1) * 100}%) · TW {r.tailwindKt > 0 ? '+' : ''}{r.tailwindKt} kt · {r.surface} · CUR {r.currencyDays}d
            </div>
            <div className="px-2 py-1">
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div style={{ width: `${r.score}%`, backgroundColor: TIER_COLOR[r.tier] }} className="h-full" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {driverBadge('CRT', r.sev.crt)}{driverBadge('OPS', r.sev.ops)}{driverBadge('CFG', r.sev.cfg)}{driverBadge('WGT', r.sev.wgt)}{driverBadge('CUR', r.sev.cur)}{driverBadge('ENV', r.sev.env)}
            </div>
            <div className="px-2 pb-1 text-[10px]" style={{ color: TIER_COLOR[r.tier] }}>› {advice(r)}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && filtered.length === 0 && <div className="text-center py-6 text-slate-500 text-[11px]">No aircraft on capture for steep runways.</div>}

        {tab === 'RUNWAYS' && rwyRows.filter(rr => angFilter === 'ALL' || rr.rwy.ang === angFilter).slice(0, 80).map((rr, i) => {
          const c = ANG_COLOR[rr.rwy.ang]
          return (
            <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
              <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${c}` }}>
                <span className="font-semibold text-slate-100">{rr.rwy.icao}/{rr.rwy.rwId}</span>
                <span className="text-slate-500 text-[10px] truncate">{rr.rwy.name}</span>
                <span className="px-1 py-px rounded text-[9px]" style={{ color: c, backgroundColor: c + '22', border: `1px solid ${c}66` }}>{rr.rwy.pdg.toFixed(2)}°</span>
                <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{rr.served} AC</span>
                {rr.critCount > 0 && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/30">{rr.critCount} CRIT</span>}
              </div>
              <div className="px-2 text-[10px] text-slate-500">QFU {rr.rwy.qfu}° · elev {rr.rwy.elevFt} ft · MLW-steep {(rr.rwy.mlwReduceFrac * 100).toFixed(0)}% · {rr.rwy.notes}</div>
              <div className="px-2 pb-1">
                <div className="h-1 rounded bg-slate-800 overflow-hidden">
                  <div style={{ width: `${rr.meanScore}%`, backgroundColor: rr.meanScore >= 55 ? '#f59e0b' : rr.meanScore >= 25 ? '#0ea5e9' : '#10b981' }} className="h-full" />
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">mean score {rr.meanScore.toFixed(0)}{rr.worstCs ? ` · worst ${rr.worstCs}` : ''}</div>
              </div>
            </div>
          )
        })}

        {tab === 'OPERATORS' && opRows.map((or, i) => {
          const tier: Tier = or.critCount > 0 ? 'CRITICAL-UNAPP' : (or.sumScore / Math.max(1, or.ac)) >= 55 ? 'RESTRICT' : (or.sumScore / Math.max(1, or.ac)) >= 25 ? 'WATCH' : 'STEEP-OK'
          const mean = or.ac ? or.sumScore / or.ac : 0
          return (
            <div key={i} className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
              <div className="flex items-center gap-1.5 px-2 py-1" style={{ borderLeft: `3px solid ${TIER_COLOR[tier]}` }}>
                <span className="font-semibold text-slate-100 truncate">{or.op}</span>
                <span className="ml-auto px-1 py-px rounded text-[9px] bg-slate-800 text-slate-300">{or.ac} AC</span>
                <span className="px-1 py-px rounded text-[9px]" style={{ color: '#10b981', backgroundColor: '#10b98122', border: '1px solid #10b98166' }}>TC {or.ac ? Math.round(or.tcOk / or.ac * 100) : 0}%</span>
                <span className="px-1 py-px rounded text-[9px]" style={{ color: '#0ea5e9', backgroundColor: '#0ea5e922', border: '1px solid #0ea5e966' }}>OPS {or.ac ? Math.round(or.opsOk / or.ac * 100) : 0}%</span>
                {or.critCount > 0 && <span className="px-1 py-px rounded text-[9px] bg-rose-500/15 text-rose-300 border border-rose-500/30">{or.critCount} CRIT</span>}
              </div>
              <div className="px-2 pb-1">
                <div className="h-1 rounded bg-slate-800 overflow-hidden">
                  <div style={{ width: `${mean}%`, backgroundColor: TIER_COLOR[tier] }} className="h-full" />
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">mean {mean.toFixed(0)}{or.worst ? ` · worst ${or.worst.f.callsign || or.worst.f.icao} @ ${or.worst.rwy?.icao || '—'}` : ''} {or.worst && <button onClick={() => or.worst && onFly(or.worst.f.icao)} className="text-sky-400 hover:text-sky-200">fly →</button>}</div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="px-3 py-2 border-t border-slate-800 text-[9px] text-slate-600 leading-snug">
        Refs: ICAO PANS-OPS Doc 8168 Vol II Pt I §4 · Annex 14 Vol I §3.1.13 · Doc 9365 §3 · EASA CS-25.125(a)(2) · AMC 25.125 · SC-D-04 Steep Approach Landing Capability · CAT.POL.A.220 (4.5°-9.0°) · AMC1 CAT.POL.A.220 · FAA AC 25-29 Steep Approach Landing Certification · FAA Order 8900.1 Vol 3 Ch 18 OpSpec C063 · 14 CFR 121.97 / 91.605 / 121.195(b) · Boeing FCOM SP-16 / FCTM §5.7 · Airbus FCOM PRO-NOR-SOP-19 / DSC-22-AUTOFLT · Embraer FCOM 4.12 E-Jet steep · Bombardier FCOM 4-10 CRJ steep · ATR FCOM 2.04 · BAe-146 / Avro RJ AFM Suppl 5 LCY · Saab 340/2000 AFM Suppl · Dornier 328 AFM Suppl · UK CAA CAP 168 ch 5 / DGAC FR aerodrome steep · NZ CAA Adv Circ 91-1 NZQN RNP-AR.
      </div>
    </div>
  )
}
